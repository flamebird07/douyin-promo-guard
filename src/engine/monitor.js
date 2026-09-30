'use strict';

/**
 * 监控调度引擎 v2。
 *
 * 本轮落实的用户规则与 Codex 复核修复：
 * - 时间窗口：只在每天 08:00（Asia/Shanghai）后执行，每 30 分钟巡查；
 *   启动后在允许时段先查一次，随后按间隔；08:00 前等待到 08:00；
 *   上次巡查+间隔跨日 → 等待次日 08:00（lib/time.js）。
 *   手动"立即轮询"可以随时读取与记录（演练），但真实关闭同样受窗口限制，
 *   不得绕过（窗口内在真实模式下手动轮询与定时轮询等效）。
 * - 停止语义（修复 #6）：stop() 使所有在途轮询周期的令牌 aborted=true：
 *   周期内不再发起新的关闭请求；已发出的请求由 close-flow 继续回读确认并记录。
 *   停止/重启通过"代数（generation）"防止出现多个调度循环。
 * - 去重含实际业务日期（修复 #4）：批次记录按 店铺+上海日历日 维护；
 *   历史记录不会永久跳过当前仍投放中的广告——是否操作永远以最新读取的
 *   广告状态为准（active 才进目标），未知结果的广告以重新读取核实。
 * - 三源身份核验（修复 #3）：费用来源、订单来源、广告清单逐页、广告控制页
 *   verifyIdentity 分别与配置店铺 ID（及账户 ID，如配置）精确比对，任一不一致零关闭。
 * - 状态持久化 v2：data/state.json 原子写（tmp+rename）、损坏自动隔离恢复；
 *   批次结果按日期留存（保留最近 7 天），重启后汇总与界面可恢复。
 *
 * 演练模式（默认）：读取、核验、评估、枚举目标，只记录不执行任何关闭。
 */

const fs = require('fs');
const path = require('path');
const { loadShopCookieMeta } = require('../login/session');
const { createPromoReaderNotConnected, createMockPromoReader } = require('../adapters/promo-reader');
const { createAdControllerNotConnected, createMockAdController } = require('../adapters/ad-controller');
const { WholeShopCloseCoordinator } = require('./close-coordinator');
const { ChengfangRunner, defaultChengfangOpener } = require('./chengfang-runner');
const { readQianchuanBalanceInPage, balanceCentsFromPageResult } = require('../adapters/chengfang-reader');
const { resolvePollingConfig } = require('../lib/bounded-poll');
const { resolveChengfangRealAllowed, resolveChengfangEnableAllowed } = require('./chengfang-gate');
const { perOrderDisplayText } = require('./rules');
const { decideAdSwitchAction, DECISION } = require('./ad-switch-decision');
const { AdSwitchOrchestrator, createSwitchSerialGate } = require('./ad-switch-orchestrator');
const { mapAdStateFromAdList, mapAdStateFromSwitchRows, normalizeAdState } = require('./ad-switch-state');
const { discoverShopsFromCookies } = require('./shop-discovery');
const guard = require('./guard');
const { NotConnectedError } = require('../lib/errors');
const { shanghaiDate, shanghaiClockText, shanghaiWall, shanghaiMs, isAfterDailyStart, msUntilDailyStart, msUntilHour, nextIntervalDelayMs } = require('../lib/time');
const { centsToYuan } = require('../lib/money');
const log = require('../lib/log');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STATE_VERSION = 2;

class Monitor {
  /**
   * @param cfgResult loadConfig() 返回值
   * @param adapters  测试注入 { reader, controller }
   * @param opts      { dataDir, nowFn, delayFn } 测试隔离用
   */
  constructor(cfgResult, adapters, opts = {}) {
    this.cfgResult = cfgResult;
    this.config = cfgResult.config;
    this.pending = cfgResult.pending;
    this.dataDir = opts.dataDir || DEFAULT_DATA_DIR;
    this.stateFile = path.join(this.dataDir, 'state.json');
    this.auditFile = path.join(this.dataDir, 'audit.jsonl');
    this.nowFn = opts.nowFn || (() => Date.now());
    this.delayFn = opts.delayFn || ((ms) => this._chunkedDelay(ms));
    this._injectedDelayFn = opts.delayFn || null; // 测试可控时钟：开启调度循环复用同一时钟门

    this.adapters = adapters || null;
    this._injectedReader = (adapters && adapters.reader) || null;
    this._injectedController = (adapters && adapters.controller) || null;
    this._coordinators = new Map(); // shopId -> WholeShopCloseCoordinator（跨周期保留在途请求登记）
    this._chengfangRunners = new Map(); // shopId -> ChengfangRunner（乘方主链路）
    this._chengfangOpener = opts.chengfangOpener || null; // 测试注入：本地 DOM fixture 会话开启器
    // 决策层 + 串行门外层（2026-09-22）：每日 07:00 开启 / 低于阈值开启 / 高于阈值暂停统一入口
    this._readAdState = opts.readAdState || null; // 测试注入：本轮回读 currentAdState
    this._switchOrchestrator = opts.switchOrchestrator || null; // 测试注入
    this._switchGate = opts.switchGate || null;

    this.running = false;
    this._gen = 0;               // 代数：stop/start 快速切换时防止多循环（暂停巡查）
    this._loopPromise = null;
    this._cycleRunning = false;
    this._activeTokens = new Set();

    // ── 独立每日开启调度器（2026-09-15 上线）────────────────────────
    // 生命周期与"启动值守"（超额暂停巡查）完全分离：
    //   - enableRunning/_enableGen 只属于每日开启循环，不随 watch start/stop 变化；
    //   - 停止令牌按动作区分（kind:'pause' | 'enable'），停止值守绝不取消每日开启；
    //   - 恢复语义：服务重启后按配置自动恢复（除非用户独立停用，持久化于状态文件）。
    this.enableRunning = false;
    this._enableGen = 0;
    this._enableLoopPromise = null;
    this._enableSchedule = {
      phase: 'idle',            // idle | waiting_window | enable_window | stopped
      nextRunAt: null,          // 下一次开启窗口起点（上海时间，ISO）
      lastRunAt: null,
      lastMissedReason: null,   // 最近一次错过窗口的原因（按日期去重记录）
      lastMissedDate: null,
      stoppedByUser: false,     // 用户独立停用（持久化；重启不自动恢复）
      stoppedAt: null,
    };

    this.startedAt = null;
    this.lastCycleAt = null;
    this.schedule = { phase: 'idle', lastRunAt: null, nextRunAt: null, waitingFor08: false, lastWindowBlockReason: null };

    // 每日自动开启相位的持久化状态（2026-09-15 修复，交接第 3 项）：
    // 结构 { [shopId]: { [date]: { status:'in_progress'|'success'|'failed'|'unknown', at, phase, reason, detail } } }
    // 原因：原先仅内存 _lastEnableDate 且在执行前赋值 → 新进程会重复开启、失败/演练也占用日期。
    this.enablePhase = {};   // shopId -> date -> record

    this.triggers = [];          // 命中记录（演练=将关闭；真实=已触发执行）
    this.actions = [];           // 真实执行批次结果
    this.recentErrors = [];

    // 过程事件流（2026-09-15 修复第 1 项，第二轮）：
    // runner/executor 的审计回调（_audit）此前**只写文件**，retry/paused/回读等
    // 真实过程事件不会进入 getEventStream，值守日志因此看不到重试与回读。
    // 现在 _audit 同时把事件写入这里（带明确 evtType），与 triggers/actions/
    // recentErrors/judgements 一起进入统一事件流。
    this.processEvents = [];

    // 事件序号（2026-09-15 修复第 1 项）：单调递增、永不回退，供外部增量消费。
    // 消费方以 evtSeq 为游标，不再依赖有界数组长度。
    this._evtSeq = 0;
    // 事件总数与该序号区间的实际缺失数（2026-09-15 修复第 3 项，第二轮）：
    // 旧实现只保留最近 50 条裁剪区段 → 报告"最近缺口数"而非真实缺口总数
    // （写 1000 条、留 300 条，真缺 700 条却只报 50）。改为：
    //   - _evtTrimmedTotal：累计被裁剪的事件总数（单调，永不自减）
    //   - _evtDropped 仅作为"未合并的尾部区段"滚动记录，合并时累加进 total
    this._evtDropped = [];
    this._evtTrimmedTotal = 0;
    // 已被消费到的序号（由消费方通过 getEventStream(since) 上报；
    // 用于在消费方游标落后于裁剪点时才计入缺口，避免把"已消费"误报为缺口）
    this._evtConsumedSeq = 0;

    // 巡查周期序号（2026-09-15 修复第 3 项）：每个完整周期 +1，用于"每周期必记一条判断"。
    this.cycleNo = 0;
    this.lastJudgementCycleNo = 0;
    // 判断日志去重：同一轮 + 同一店只记一次（跨店同轮各记一条）
    this._judgementCycleNo = 0;
    this._judgementShops = new Set();
    // 每周期判断记录（2026-09-15 修复第 3 项）：**每个完整周期一条**，
    // 不以"数据是否变化"为记录条件（旧实现靠 changed 判定 → 连续相同数据会漏判断日志）。
    this.judgements = [];

    const loaded = this._loadState();
    this.batches = loaded.batches || {}; // shopId -> date -> { runs:[], totals:{} }
    // 最近一次会话 Cookie 回写结果（仅元信息：条数/域名/冲突；绝不保存任何 Cookie 值）。
    // 不持久化：重启后清空，避免把上一进程的凭据状态当作本次会话的事实。
    this.lastCookieWriteback = null;
    this.enablePhase = loaded.enablePhase || {};
    // 广告开/关状态标记（2026-09-21，每日 07:00 开启前置门依据）：
    // 仅由**回读确认**的批次更新（暂停确认→off；开启确认→on），持久化跨重启。
    // 未知/失败批次不更新（不臆断）；无记录 → 前置门不拦（照常执行开启，fail-closed）。
    this.adBelief = loaded.adBelief || {};
    // 独立停用标记持久化（重启后不得"复活"用户明确停用的每日开启任务）
    if (loaded.enableScheduler && typeof loaded.enableScheduler === 'object') {
      this._enableSchedule.stoppedByUser = loaded.enableScheduler.stoppedByUser === true;
      this._enableSchedule.stoppedAt = loaded.enableScheduler.stoppedAt || null;
    }
    // 串行门持久化：未结束动作恢复为 unknown 阻塞（不把未知写成成功，禁止补点）
    this._switchGate = this._switchGate
      || createSwitchSerialGate({ state: loaded.switchSlots || { slots: [] } });
    this._switchOrchestrator = this._switchOrchestrator
      || new AdSwitchOrchestrator({ gate: this._switchGate, audit: (e) => this._audit(e) });
    // 运行期发现待重试标记（第 13 阶段补验证）：内存已建店但落盘未成功时置真——进程内
    // 下一次发现调用必须重试落盘，不得因"内存已知该店"而永久跳过（无需重启即可恢复）。
    this._shopsPersistPending = false;
    // Cookie 自动发现店铺（2026-09-25 阶段 5，用户已确认）：目录为入口，新增 Cookie
    // 自动建店；已软删除店绝不复活。发现失败只记日志，绝不阻塞装配。
    try { this._discoverShopsFromCookies(); } catch (e) {
      try { log.warn(`Cookie 店铺发现异常（不阻塞装配）: ${e.message}`); } catch (_) {}
    }
    // 重启回读：上次进程遗留的 in_progress 视为 unknown（进程已中断，结果未确认），
    // 交由 _runEnablePhase 先回读实际状态再决定，绝不盲目重发。
    this._reconcileEnablePhaseOnBoot();
    this._saveState();
  }

  /**
   * 启动时回读处理开启相位持久化状态：
   * - in_progress → unknown（程序崩溃/重启，原请求结果未知，需先回读）
   * - unknown 保持 unknown（等待下次开启窗口内回读判定）
   * 返回受影响条目（供日志/审计说明），不在此处发起任何业务请求。
   */
  _reconcileEnablePhaseOnBoot() {
    const recovered = [];
    for (const shopId of Object.keys(this.enablePhase || {})) {
      const byDate = this.enablePhase[shopId] || {};
      for (const date of Object.keys(byDate)) {
        const rec = byDate[date];
        if (rec && rec.status === 'in_progress') {
          rec.status = 'unknown';
          rec.reason = `进程中断（原状态 in_progress 于 ${rec.at}），结果未知，重启后先回读再决定`;
          rec.reconciledAt = new Date(this.nowFn()).toISOString();
          recovered.push({ shopId, date, phase: rec.phase || null });
        }
      }
    }
    if (recovered.length > 0) {
      this._memPush(this.recentErrors, { scope: 'enable-phase', error: `重启回读：${recovered.length} 条开启相位记录由 in_progress 转为 unknown（先回读，不盲重发）`, recovered }, undefined, 'error');
      try { log.warn(`重启回读开启相位：${recovered.length} 条 in_progress → unknown`); } catch (_) {}
    }
    return recovered;
  }

  /** 读取某店铺某上海日期的开启相位状态记录（无则 null）。 */
  getEnablePhaseRecord(shopId, date) {
    const byDate = (this.enablePhase || {})[shopId];
    if (!byDate) return null;
    return byDate[date] || null;
  }

  /** 写入开启相位状态（in_progress/success/failed/unknown）+ 原子落盘。 */
  _setEnablePhase(shopId, date, status, extra = {}) {
    if (!this.enablePhase[shopId]) this.enablePhase[shopId] = {};
    const prev = this.enablePhase[shopId][date] || {};
    this.enablePhase[shopId][date] = {
      ...prev,
      status,
      at: new Date(this.nowFn()).toISOString(),
      ...extra,
    };
    // 保留 30 天，避免无限增长
    const dates = Object.keys(this.enablePhase[shopId]).sort();
    while (dates.length > 30) delete this.enablePhase[shopId][dates.shift()];
    this._saveState();
    return this.enablePhase[shopId][date];
  }

  /**
   * 今日是否仍需执行开启相位。
   * 仅当状态为 success 时视为"今日已完成"（失败/unknown 允许在窗口内按规则再处理，
   * 但 unknown 必须先回读确认，见 _runEnablePhase）。
   */
  _enablePhaseDone(shopId, date) {
    const rec = this.getEnablePhaseRecord(shopId, date);
    return !!(rec && rec.status === 'success');
  }

  // ── 持久化（原子写 + 损坏隔离）────────────────────────────────────
  _loadState() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
      if (parsed && typeof parsed === 'object') return parsed;
      throw new Error('状态文件结构非法');
    } catch (e) {
      if (fs.existsSync(this.stateFile)) {
        // 损坏/写入中断：隔离保留现场，从空状态恢复（批次汇总丢失属预期，审计流水仍完整）
        try {
          const backup = `${this.stateFile}.corrupt-${Date.now()}`;
          fs.renameSync(this.stateFile, backup);
          log.warn(`状态文件损坏已隔离: ${backup}（${e.message}）`);
          this._memPush(this.recentErrors, { scope: 'state', error: `状态文件损坏已隔离重建: ${e.message}` }, undefined, 'error');
        } catch (_) { /* 隔离失败则忽略，按空状态继续 */ }
      }
      return { version: STATE_VERSION, batches: {}, enablePhase: {} };
    }
  }

  /**
   * 持久化安全状态（批次/相位/串行门）。**真实返回成功/失败**，不静默吞掉。
   * @returns {{ok:boolean, reason?:string}}
   */
  _saveState() {
    try {
      this._ensureDataDir();
      const tmp = `${this.stateFile}.tmp`;
      const payload = JSON.stringify({
        version: STATE_VERSION,
        batches: this.batches,
        enablePhase: this.enablePhase || {},
        adBelief: this.adBelief || {},
        enableScheduler: {
          stoppedByUser: this._enableSchedule.stoppedByUser === true,
          stoppedAt: this._enableSchedule.stoppedAt || null,
        },
        switchSlots: (this._switchOrchestrator && this._switchOrchestrator.exportState)
          ? this._switchOrchestrator.exportState()
          : (this._switchGate && this._switchGate.exportState ? this._switchGate.exportState() : { slots: [] }),
        savedAt: new Date(this.nowFn()).toISOString(),
      }, null, 2);
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, this.stateFile);
      return { ok: true };
    } catch (e) {
      const reason = `状态持久化失败: ${e.message}`;
      log.warn(reason);
      // 不删除/覆盖已有有效 state.json
      return { ok: false, reason };
    }
  }

  /** 新动作发出前：必须成功写入 actionId/动作/未结束状态；失败则不发底层开关。 */
  _persistBeforeDispatch(shopId, action, actionId) {
    const r = this._saveState();
    if (r.ok === true) {
      return { ok: true };
    }
    const reason = `persistence_blocked: 动作前持久化失败（${r.reason || '未知'}），未发出开关`;
    this._memPush(this.recentErrors, { scope: `shop:${shopId}`, error: reason, action, actionId: actionId || null }, undefined, 'error');
    this._audit({ kind: 'persistence', shopId, action, actionId: actionId || null, ok: false, reason });
    return { ok: false, reason, outcome: 'persistence_blocked' };
  }

  _pruneBatches() {
    const keep = 7;
    for (const shopId of Object.keys(this.batches)) {
      const dates = Object.keys(this.batches[shopId]).sort();
      while (dates.length > keep) {
        const drop = dates.shift();
        delete this.batches[shopId][drop];
      }
    }
  }

  _ensureDataDir() {
    if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });
  }

  /**
   * 审计写入（2026-09-15 修复第 1 项，第二轮）。
   *
   * 旧行为：`_audit` **只**追加审计文件。runner/executor 的所有过程审计
   * （retry/paused/view/identity/abort/done/step…）都指向这里，因此这些真实
   * 过程事件从未进入 `getEventStream` → 值守日志看不到重试与回读。
   *
   * 修复：同一条记录**同时**写入进程内 `processEvents` 事件流（带显式
   * `evtType: 'process'` 与原始 `event` 名），consumer 可据此区分：
   *   - retry        → 重试
   *   - paused/plan  → 暂停与回读
   *   - readback/view→ 回读核验
   *   - enable*      → 开启相位
   * **不重复**：文件与事件流是同一份记录的两个出口；事件流本身有界，
   * 消费方以 evtSeq 去重。
   */
  _audit(entry) {
    try {
      this._ensureDataDir();
      fs.appendFileSync(this.auditFile, JSON.stringify({ ts: new Date(this.nowFn()).toISOString(), ...log.sanitize(entry) }) + '\n');
    } catch (_) { /* 审计落盘失败不阻塞 */ }
    // 过程事件接入事件流（与审计文件同源，不编造、不丢字段）
    try {
      this._memPush(this.processEvents, { evtType: 'process', ...entry }, 500, 'process');
    } catch (_) { /* 事件流写入失败不影响业务 */ }
  }

  /**
   * 有界数组写入 + **单调递增稳定序号**（2026-09-15 修复第 1 项）。
   *
   * 旧行为：消费方以 `arr.length` 作为增量游标。数组上限 300，一旦写满就会
   * 从头部裁剪，长度停止增长 → 消费方永远看不到新事件（永久漏日志）；
   * 或者裁剪后长度回退 → 重复消费。
   *
   * 修复：每条事件附加单调递增的 `evtSeq`（进程内全局唯一、永不回退）与显式
   * `evtType`（事件种类，供消费方按类型分派，不再靠字段形状猜测）。
   *
   * 缺口计数（第二轮修复第 3 项）：被裁剪的事件总数累加进 `_evtTrimmedTotal`
   * （单调），`_evtDropped` 只保留"尚未与消费游标合并"的尾部区段；两者合并后
   * 才能得出**真实缺口**（写 1000 条留 300 条 → 真缺 700 条）。
   *
   * @param {Array} arr   有界数组（triggers/actions/recentErrors/judgements/processEvents）
   * @param {object} entry 事件体
   * @param {number} [limit] 数组上限
   * @param {string} [evtType] 显式事件种类（供消费方无歧义分派）
   */
  _memPush(arr, entry, limit, evtType = null) {
    const cap = limit || 300;
    this._evtSeq = (this._evtSeq || 0) + 1;
    const ts = new Date(this.nowFn()).toISOString();
    const type = evtType || (entry && entry.evtType) || null;
    const rec = { evtSeq: this._evtSeq, ts, ...log.sanitize(entry) };
    if (type && rec.evtType === undefined) rec.evtType = type;
    arr.push(rec);
    if (arr.length > cap) {
      const removed = arr.splice(0, arr.length - cap);
      // 记录被裁剪的序号区段（供消费方在游标落后时报告明确缺口，而非静默漏日志）
      const firstSeq = removed[0] && removed[0].evtSeq;
      const lastSeq = removed[removed.length - 1] && removed[removed.length - 1].evtSeq;
      if (typeof firstSeq === 'number' && typeof lastSeq === 'number') {
        this._evtDropped.push({ firstSeq, lastSeq, count: removed.length, at: ts });
        this._mergeDroppedRanges();
      }
    }
    return this._evtSeq;
  }

  /**
   * 合并裁剪区段（2026-09-15 修复第 3 项，第二轮）。
   *
   * 旧的 `_evtDropped.length > 50 → splice` 会直接丢弃更早的区段计数，
   * 导致"写 1000 条、留 300 条"只报最近 50 条缺口。改为：
   *   - 相邻/重叠区段合并（保持区间数不膨胀）
   *   - 被挤出上限的**最旧**区段，其 count 累加进 `_evtTrimmedTotal`（不丢失）
   * 这样 total + 未合并区段 = 真实裁剪总数。
   */
  _mergeDroppedRanges() {
    const ranges = this._evtDropped;
    if (ranges.length < 2) return;
    ranges.sort((a, b) => a.firstSeq - b.firstSeq);
    const merged = [ranges[0]];
    for (let i = 1; i < ranges.length; i += 1) {
      const last = merged[merged.length - 1];
      const cur = ranges[i];
      // 序号连续或重叠 → 合并为一段（count 相加，区间取并）
      if (cur.firstSeq <= last.lastSeq + 1) {
        last.lastSeq = Math.max(last.lastSeq, cur.lastSeq);
        last.count += cur.count;
        last.at = cur.at || last.at;
      } else {
        merged.push(cur);
      }
    }
    // 上限 50：超出的**最旧**区段计数累加进 _evtTrimmedTotal，绝不静默丢弃
    while (merged.length > 50) {
      const dropped = merged.shift();
      this._evtTrimmedTotal = (this._evtTrimmedTotal || 0) + (dropped.count || 0);
    }
    this._evtDropped = merged;
  }

  /**
   * 事件流快照（供外部增量消费）。
   *
   * - `events`：当前仍保留在内存中的事件（按 evtSeq 升序，跨全部事件数组合并），
   *   每条带显式 `evtType`（judgement/trigger/batch/process/error）。
   * - `seq`：当前最大 evtSeq（进程内单调，永不回退）
   * - `dropped` / `droppedCount`：**真实**日志缺口（见 _mergeDroppedRanges）
   *
   * 缺口语义（2026-09-15 修复第 3 项，第二轮）：
   *   `droppedCount` = 该消费者**从未收到过**的事件总数 =
   *     历史合并进 `_evtTrimmedTotal` 的裁剪数
   *   + 当前仍记录、且消费者游标**尚未越过其末端**的区段计数。
   *   一个区段只有在消费者游标已推进到 `lastSeq` 之后（`since > lastSeq`）时
   *   才算"已跨越"，不再计入——但它已经**被报告过**，因此不会因后续 `since`
   *   增大而消失（用 `_evtAckSeq` 记录每个区段的报告/跨越状态）。
   *   这样"写 1000 留 300"在任何读取顺序下都报 700，且不重复计数。
   *
   * 消费方应保存上次的 `seq`，下次以 `since=seq` 拉取；即使期间发生裁剪，
   * 也能通过 `droppedCount` 如实告知缺口总数，而不是永久漏日志或静默错位。
   */
  getEventStream(since = 0) {
    const all = [];
    for (const arr of [this.triggers, this.actions, this.recentErrors, this.judgements, this.processEvents]) {
      for (const e of arr) if (e && typeof e.evtSeq === 'number') all.push(e);
    }
    all.sort((a, b) => a.evtSeq - b.evtSeq);
    // 消费游标推进（单调）
    if (typeof since === 'number' && since > (this._evtConsumedSeq || 0)) {
      this._evtConsumedSeq = since;
    }
    const cur = this._evtConsumedSeq || 0;
    // 区段计数：仅当消费游标尚未越过其末端时计入（未被消费者跨越 = 消费者确实没收到）
    // `_evtAckSeq` 记录每个区段的首报游标，确保"报告后不因游标前进而消失"
    if (!this._evtAckSeq) this._evtAckSeq = new WeakMap();
    const pending = (this._evtDropped || []).filter((d) => {
      if (!this._evtAckSeq.has(d)) this._evtAckSeq.set(d, cur); // 首次见到 → 记录当时游标
      const reportedAt = this._evtAckSeq.get(d);
      // 消费者跨越该区段（cur > lastSeq）**且**该区段已在其后报告过 → 视为已交付
      // 否则仍计入（从未收到的真实缺口）
      return !(cur > d.lastSeq && reportedAt >= d.lastSeq);
    });
    const dropped = pending.map((d) => ({ ...d }));
    const droppedCount = (this._evtTrimmedTotal || 0) + pending.reduce((n, d) => n + (d.count || 0), 0);
    return {
      seq: this._evtSeq || 0,
      cycleNo: this.cycleNo || 0,
      events: all.filter((e) => e.evtSeq > since),
      dropped,
      droppedCount,
      // 诊断字段：便于排障核对（裁剪总数 / 已合并进 total 的部分）
      trimmedTotal: this._evtTrimmedTotal || 0,
      consumedSeq: this._evtConsumedSeq || 0,
    };
  }

  // ── 模式 ─────────────────────────────────────────────────────────
  get realMode() { return this.config.execution.realMode === true; }
  get modeLabel() { return this.realMode ? '真实执行' : '演练模式（只记录不关闭）'; }

  /**
   * 可执行门槛（2026-09-15 修复第 2 项，第二轮）。
   *
   * 展示层（bill-manager 值守页）必须复用**与执行器完全一致**的许可判断，
   * 否则会出现"界面说会执行、执行器实际拒绝（dryRun）"的不一致。
   * 这里直接调用 chengfang-gate 的 resolveChengfang*Allowed（含 dryRun 检查），
   * 不另写一套近似逻辑。
   *
   * 典型：三个许可开关全为 true、但 execution.dryRun === true 时，
   * pauseAllowed/enableAllowed 均为 false（演练模式下 dryRun 优先拒绝真实动作）。
   *
   * @returns {{ok:boolean, allowed:boolean, reason:string|null, config:object}}
   *   config 为构造门槛所用的配置快照（供展示层显示真实模式来源）
   */
  gatePreview() {
    const cfg = this.config || {};
    const real = resolveChengfangRealAllowed(cfg);
    const enable = resolveChengfangEnableAllowed(cfg);
    return {
      ok: real.ok && enable.ok,
      pauseAllowed: real.ok,
      pauseReason: real.ok ? null : real.reason,
      enableAllowed: enable.ok,
      enableReason: enable.ok ? null : enable.reason,
      dryRun: cfg.execution && cfg.execution.dryRun === true,
      configuredRealMode: cfg.execution && cfg.execution.realMode === true,
      pauseEnabled: !!(cfg.monitor && cfg.monitor.chengfang && cfg.monitor.chengfang.pauseEnabled === true),
      enableEnabled: !!(cfg.monitor && cfg.monitor.chengfang && cfg.monitor.chengfang.enableEnabled === true),
    };
  }

  // ── 启动/停止 ────────────────────────────────────────────────────

  /**
   * 运行时调整 wholeShopCostPerOrder 阈值（2026-09-21 页面控制入口）。
   * - 校验：整数分 1–1000000（0.01–10000 元/单）；
   * - 内存立即生效（后续巡查/操作前复核用同一份 this.config.rules）；
   * - 落盘回 cfgResult.sourcePath 指向的 config.json（保留 _说明 键）；
   *   落盘失败不回滚内存值，但如实返回 persisted:false。
   */
  setRuleThreshold(thresholdCents) {
    const n = Math.floor(Number(thresholdCents));
    if (!Number.isFinite(n) || n < 1 || n > 1000000) {
      return { ok: false, reason: '阈值无效：需为 0.01–10000 元/单（整数分 1–1000000）' };
    }
    const rules = this.config.rules || [];
    const rule = rules.find((r) => r.type === 'wholeShopCostPerOrder' && r.enabled !== false);
    if (!rule) return { ok: false, reason: '配置缺少启用的 wholeShopCostPerOrder 规则，无法调整' };
    const old = rule.thresholdCents;
    if (old === n) return { ok: true, thresholdCents: n, unchanged: true };
    rule.thresholdCents = n;
    let persisted = false;
    const cfgPath = (this.cfgResult && this.cfgResult.sourcePath) || null;
    if (cfgPath && typeof cfgPath === 'string' && cfgPath.endsWith('.json')) {
      try {
        const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
        const target = (raw.rules || []).find((r) => r.type === 'wholeShopCostPerOrder');
        if (target) {
          target.thresholdCents = n;
          fs.writeFileSync(cfgPath, JSON.stringify(raw, null, 2) + '\n');
          persisted = true;
        }
      } catch (e) {
        this._memPush(this.recentErrors, { scope: 'rule', error: `阈值落盘失败（内存已生效）：${e.message}` }, undefined, 'error');
      }
    }
    this._audit({ kind: 'rule', change: 'threshold', from: old, to: n, persisted });
    try { log.info(`阈值调整：${old} 分 → ${n} 分${persisted ? '（已落盘）' : '（仅内存，未落盘）'}`); } catch (_) { /* 日志失败不影响 */ }
    return { ok: true, thresholdCents: n, from: old, persisted };
  }

  /**
   * 立即执行一次完整巡查并按当前时间重排下次检查（2026-09-21 阈值确认联动）。
   *
   * 与 pollOnce(trigger='manual') 的区别：手动轮询走独立路径，_intervalLoop 挂起的
   * delay 定时不受影响——下一次定时检查仍在旧节奏上。本方法在 pollOnce 成功后
   * **取消当前挂起的等待并以"本次巡查完成时刻"为新基准**重排：下次检查 = 完成 + 30 分钟
   * （跨日仍按 enableHour/dailyStartHour 规则，由 nextIntervalDelayMs 统一处理）。
   *
   * 实现方式：发出 _rescheduleRequest 令牌后，_intervalLoop 当前挂起的 delayFn 以**缩短的
   * 剩余时长**提前返回（delayFn 包装层监听令牌；生产 delayFn 为 setTimeout 链，直接缩短
   * 无法取消，故采用"挂起前登记 deadline、令牌到达时 recompute"的方式不可行——
   * 简化：巡查完成后把 nextRunAt 立即改写为完成+interval，并请求中断当前 delay：
   * _intervalLoop 每次从 delayFn 返回后都会按 this.schedule.nextRunAt 重新校准（见
   * _resyncAfterInterrupt），因此这里直接触发一次带触发标 pollOnce + 改写 nextRunAt 即可，
   * 挂起的旧 delay 到期时循环发现 triggerPending 会跳过那次空转。
   */
  async pollNowAndReschedule(trigger = 'threshold-change') {
    let r = await this.pollOnce(trigger);
    // 2026-09-21：已有周期进行中（如首轮巡查刚被阈值确认触发）→ 等它结束后再执行
    // 联动巡查，绝不静默跳过（用户点"确定"就是要求立刻按新阈值跑一轮）。
    // 有界等待：最长等一个间隔周期，防止异常长周期把 HTTP 请求吊死。
    if (!r.ok && /已有轮询周期进行中/.test(r.reason || '')) {
      const sch = this.config.schedule;
      const deadline = this.nowFn() + Math.max(2 * 60 * 1000, (sch.intervalMinutes || 30) * 60 * 1000);
      while (!r.ok && this.nowFn() < deadline && this.running) {
        await new Promise((res) => setTimeout(res, 1000));
        r = await this.pollOnce(trigger);
      }
    }
    if (!r.ok) return r;
    // 以本次巡查**完成时刻**为新基准重排：下次 = 完成 + intervalMinutes
    const lastRun = this.nowFn();
    this.lastCycleAt = new Date(lastRun).toISOString();
    const sch = this.config.schedule;
    const enableHour = this._enableHour();
    const nd = nextIntervalDelayMs(this.nowFn(), lastRun, sch.intervalMinutes, sch.dailyStartHour, this._enableWindowConfigured() ? enableHour : undefined);
    this.schedule.lastRunAt = new Date(lastRun).toISOString();
    this.schedule.nextRunAt = new Date(nd.nextRunAt).toISOString();
    this.schedule.waitingFor08 = nd.crossDay;
    this.schedule.phase = nd.crossDay ? 'waiting_window' : this.schedule.phase === 'running' ? 'running' : this.schedule.phase;
    // 通知挂起的旧 delay：被本次重排取代。_intervalLoop 在 delay 返回后检查
    // this._scheduleEpoch，不一致则丢弃本轮旧节奏、立即进入循环头重新计算。
    this._scheduleEpoch = (this._scheduleEpoch || 0) + 1;
    return { ...r, nextRunAt: this.schedule.nextRunAt, rescheduled: true };
  }

  start() {
    if (this.pending.length > 0) {
      return { ok: false, reason: `存在待配置/非法配置项，不允许启动监控: ${this.pending.join('；')}` };
    }
    const activeShopCount = this._activeShops().length;
    if (this.running) return { ok: true, alreadyRunning: true, activeShopCount };
    this._gen += 1;
    this.running = true;
    this.startedAt = new Date(this.nowFn()).toISOString();
    const gen = this._gen;
    this._audit({ kind: 'monitor', event: 'start', mode: this.modeLabel, activeShopCount });
    this._loopPromise = this._intervalLoop(gen);
    log.info(`监控已启动（${this.modeLabel}，活动店铺 ${activeShopCount} 家，每日 ${this.config.schedule.dailyStartHour}:00 后，每 ${this.config.schedule.intervalMinutes} 分钟）`);
    return { ok: true, activeShopCount };
  }

  stop() {
    this._gen += 1;          // 使旧循环退出、旧 delay 中断（仅暂停巡查循环）
    this.running = false;
    // 停止在途**暂停巡查**周期：周期内不再发起新的关闭请求（已发出的继续回读确认）。
    // 按动作区分令牌：每日开启（kind:'enable'）不受"停止值守"影响——它是独立任务。
    for (const t of this._activeTokens) if (t.kind !== 'enable') t.aborted = true;
    this.schedule.phase = 'stopped';
    this.schedule.nextRunAt = null;
    log.info('监控已停止（暂停巡查停止，已发出的关闭请求将继续回读确认；每日开启任务不受影响）');
    this._audit({ kind: 'monitor', event: 'stop', scope: 'pause-patrol', enableSchedulerStillRunning: this.enableRunning });
    return { ok: true };
  }

  // ── 独立每日开启调度器（与"启动值守"完全分离）────────────────────
  /** 配置是否允许调度器运行，且用户未独立停用。 */
  enableSchedulerShouldRun() {
    const cf = (this.config.monitor && this.config.monitor.chengfang) || {};
    return cf.enableSchedulerEnabled === true && this._enableSchedule.stoppedByUser !== true;
  }

  /**
   * 启动独立每日开启调度器（服务启动时自动调用；页面可独立停用/恢复）。
   * 不启动暂停巡查、不依赖 this.running；与 _intervalLoop 共享执行器/事件流/持久化。
   */
  startEnableScheduler(opts = {}) {
    if (this.pending.length > 0) {
      return { ok: false, reason: `存在待配置/非法配置项，不允许启动每日开启任务: ${this.pending.join('；')}` };
    }
    const cf = (this.config.monitor && this.config.monitor.chengfang) || {};
    if (cf.enableSchedulerEnabled !== true) {
      return { ok: false, reason: 'monitor.chengfang.enableSchedulerEnabled 未开启（每日自动开启任务未启用）' };
    }
    if (this._enableSchedule.stoppedByUser === true) {
      return { ok: false, reason: '每日开启任务已被用户独立停用（恢复后才可启动）' };
    }
    if (this.enableRunning) return { ok: true, alreadyRunning: true };
    this._enableGen += 1;
    this.enableRunning = true;
    this._enableSchedule.stoppedAt = null;
    this._enableSchedule.phase = 'waiting_window';
    const gen = this._enableGen;
    const nextMs = this._nextEnableWindowStartMs(this.nowFn());
    this._enableSchedule.nextRunAt = new Date(nextMs).toISOString();
    const nextClock = shanghaiClockText(nextMs);
    this._audit({ kind: 'enable-scheduler', event: 'registered', nextRunAt: this._enableSchedule.nextRunAt, reason: opts.reason || null });
    log.info(`独立每日开启任务已登记（每日 ${String(this._enableHour()).padStart(2, '0')}:00 自动开启全部乘方；下次 ${nextClock}；与"启动值守"相互独立）`);
    this._enableLoopPromise = this._enableLoop(gen);
    return { ok: true, nextRunAt: this._enableSchedule.nextRunAt };
  }

  /**
   * 停止独立每日开启调度器。只中止 kind:'enable' 的令牌（绝不波及暂停巡查）。
   * byUser=true 时持久化停用标记（重启不自动恢复）。
   */
  stopEnableScheduler({ byUser = false, reason = null } = {}) {
    this._enableGen += 1;
    const wasRunning = this.enableRunning;
    this.enableRunning = false;
    for (const t of this._activeTokens) if (t.kind === 'enable') t.aborted = true;
    this._enableSchedule.phase = 'stopped';
    this._enableSchedule.nextRunAt = null;
    if (byUser) {
      this._enableSchedule.stoppedByUser = true;
      this._enableSchedule.stoppedAt = new Date(this.nowFn()).toISOString();
      this._saveState();
    }
    log.info(`独立每日开启任务已停止${byUser ? '（用户独立停用，服务重启后不会自动恢复）' : ''}${wasRunning ? '' : '（此前未在运行）'}；暂停巡查不受影响。`);
    this._audit({ kind: 'enable-scheduler', event: 'stopped', byUser, wasRunning, reason });
    return { ok: true, wasRunning };
  }

  /** 用户恢复每日开启：清除独立停用标记并重新登记（配置未启用则拒绝）。 */
  resumeEnableScheduler(opts = {}) {
    const cf = (this.config.monitor && this.config.monitor.chengfang) || {};
    if (cf.enableSchedulerEnabled !== true) {
      return { ok: false, reason: 'monitor.chengfang.enableSchedulerEnabled 未开启（每日自动开启任务未启用）' };
    }
    this._enableSchedule.stoppedByUser = false;
    this._enableSchedule.stoppedAt = null;
    this._saveState();
    return this.startEnableScheduler({ ...opts, reason: opts.reason || '用户恢复每日开启' });
  }

  /** 下一次开启窗口起点（上海 enableHour 整点）的绝对毫秒时间。 */
  _nextEnableWindowStartMs(nowMs) {
    const w = shanghaiWall(nowMs);
    const eh = this._enableHour();
    const hm = `${String(eh).padStart(2, '0')}:00`;
    let target = shanghaiMs(w.date, hm);
    if (target <= nowMs) {
      // 今日窗口起点已过 → 明日同一时刻（上海 +24h，用日期串推，避免时区歧义）
      const [y, m, d] = w.date.split('-').map(Number);
      const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
      const tDate = `${tomorrow.getUTCFullYear()}-${String(tomorrow.getUTCMonth() + 1).padStart(2, '0')}-${String(tomorrow.getUTCDate()).padStart(2, '0')}`;
      target = shanghaiMs(tDate, hm);
    }
    return target;
  }

  /**
   * 错过窗口记录（按上海日期去重）：窗口已过且当日无任何开启相位记录 →
   * 如实记录"错过原因"，不擅自补开（08:00 后绝不开广告）。
   */
  _noteMissedEnableWindowIfNeeded(date) {
    if (this._enableSchedule.lastMissedDate === date) return;
    const anyRecord = this._activeShops().some((s) => this.getEnablePhaseRecord(s.id, date));
    if (anyRecord) return; // 今日已执行过（success/failed/unknown 均有记录），非"错过"
    this._enableSchedule.lastMissedDate = date;
    const eh = String(this._enableHour()).padStart(2, '0');
    const reason = `${date} 开启窗口（上海 ${eh}:00 起至当日结束）已全部过去且当日未执行开启：不擅自补开广告，等待明日窗口`;;
    this._enableSchedule.lastMissedReason = `${date} ${reason}`;
    this._audit({ kind: 'enable-scheduler', event: 'window_missed', date, reason });
    log.warn(`每日开启：${reason}`);
  }

  /** 开启调度循环专用可中断延时（只随 _enableGen/enableRunning 中断，不随值守启停）。 */
  async _chunkedEnableDelay(ms, gen) {
    // 2026-09-16 修复生产首次开启漂移（07:15 而非 07:00）：
    // 旧实现 `waited += chunk` 累计名义等待——分片间实际延迟（setTimeout 抖动、GC、系统休眠）
    // 会让名义累计 < 实际经过 → 总等待偏短或偏长，且无法覆盖休眠后恢复。
    // 修复：以**实际墙钟**重算剩余等待。每次分片后取 nowFn() 与目标时刻比较，
    // 已到点即返回；未到则按剩余重算。休眠唤醒后 nowFn 跳跃，剩余可能为 0 → 立即返回。
    const targetMs = this.nowFn() + ms;
    while (true) {
      if (gen !== undefined && gen !== this._enableGen) return;
      if (!this.enableRunning) return;
      const remaining = targetMs - this.nowFn();
      if (remaining <= 0) return;
      await new Promise((r) => setTimeout(r, Math.min(250, remaining)));
    }
  }

  _enableDelay(ms, gen) {
    // 测试注入 delayFn 时直接复用（可控时钟）；生产走开启专属分片延时
    if (this._injectedDelayFn) return this._injectedDelayFn(ms);
    return this._chunkedEnableDelay(ms, gen);
  }

  /**
   * 独立每日开启循环：等待每日 enableHour 起的当日窗口 → 执行开启相位
   * （复用 _runEnablePhase：按店铺+日期持久化、成功不重复、unknown 先回读）。
   * 2026-09-29 第 10 阶段：窗口改为 [enableHour, 当日结束]（去除 dailyStartHour 上界，
   * 支持 enableHour 晚于 dailyStartHour 的配置）。防倒补：仅当登记的 nextRunAt 已到
   * （当日到点被观察到）才执行——服务在配置时刻之后启动时 nextRunAt=明日，不擅自补发。
   * 执行后：全部 success → 登记次日 enableHour；仍有未完成 → 5 分钟后有界重试（跨日自然停）。
   * 与暂停巡查循环（_intervalLoop）并存：共享 _cycleRunning 互斥与执行器，
   * 但生命周期独立——"停止值守"不影响本循环。
   */
  async _enableLoop(gen) {
    const sch = this.config.schedule;
    const RETRY_MS = 5 * 60 * 1000;
    while (gen === this._enableGen && this.enableRunning) {
      const now = this.nowFn();
      const w = shanghaiWall(now);
      const nrMs = Date.parse(this._enableSchedule.nextRunAt || '');
      const arrived = Number.isFinite(nrMs) && now >= nrMs;
      if (w.hour >= this._enableHour() && arrived) {
        const today = w.date;
        const shopsToRun = this._activeShops().filter(
          (s) => !this._enablePhaseDone(s.id, today),
        );
        if (shopsToRun.length > 0) {
          this._enableSchedule.phase = 'enable_window';
          if (this._cycleRunning) {
            // 与暂停/其他周期互斥：绝不并发执行，稍后重试（仍在窗口内会继续处理）
            await this._enableDelay(5000, gen);
            continue;
          }
          try {
            await this._runEnablePhase(gen, today);
            this._enableSchedule.lastRunAt = new Date(this.nowFn()).toISOString();
          } catch (e) {
            this._memPush(this.recentErrors, { scope: 'enable-scheduler', error: `每日开启任务异常：${e.message}` }, undefined, 'error');
          }
        } else {
          // 今日全部店铺已 success → 等次日 enableHour（不重复开启）
          this._enableSchedule.phase = 'enable_window';
        }
        const afterMs = this.nowFn();
        const afterWall = shanghaiWall(afterMs);
        if (afterWall.date !== w.date) continue; // 执行中跨日：回环重判（窗口外逻辑登记明日）
        const still = this._activeShops().some((s) => !this._enablePhaseDone(s.id, today));
        if (still) {
          // 有未完成店：有界重试（RETRY_MS 后再试；跨日由回环窗口判定自然停止）
          const retryAt = afterMs + RETRY_MS;
          this._enableSchedule.nextRunAt = new Date(retryAt).toISOString();
          await this._enableDelay(RETRY_MS, gen);
          continue;
        }
        const targetMs = this._nextEnableWindowStartMs(afterMs);
        this._enableSchedule.phase = 'waiting_window';
        this._enableSchedule.nextRunAt = new Date(targetMs).toISOString();
        await this._enableDelay(Math.max(0, targetMs - afterMs), gen);
        continue;
      }
      // ── 窗口外 / 未到点 ──
      if (w.hour < this._enableHour()) {
        // 当日窗口已全部过去（跨日后的凌晨段）：如昨日无任何开启相位记录，如实记"错过"（不补开）
        const y = new Date(Date.UTC(Number(w.date.slice(0, 4)), Number(w.date.slice(5, 7)) - 1, Number(w.date.slice(8, 10)) - 1));
        const yDate = `${y.getUTCFullYear()}-${String(y.getUTCMonth() + 1).padStart(2, '0')}-${String(y.getUTCDate()).padStart(2, '0')}`;
        this._noteMissedEnableWindowIfNeeded(yDate);
      }
      // 已登记的下次运行仍在未来（如未完成重试点 +5min、或已登记的次日窗口点）时不得覆盖：
      // 提前唤醒/时钟回拨会让回环时刻早于 nextRunAt（arrived=false），若按窗口起点重算会把
      // 当日重试点覆盖为次日 → 当日重试丢失（2026-09-29 第 10 阶段补验证修复，复现见
      // repro-retry-loss.js）。仅当登记缺失/已过期时才按窗口起点重新登记。
      const nrFutureMs = Date.parse(this._enableSchedule.nextRunAt || '');
      const hasFutureRun = Number.isFinite(nrFutureMs) && nrFutureMs > now;
      const targetMs = hasFutureRun ? nrFutureMs : this._nextEnableWindowStartMs(now);
      this._enableSchedule.phase = 'waiting_window';
      this._enableSchedule.nextRunAt = new Date(targetMs).toISOString();
      await this._enableDelay(Math.max(0, targetMs - now), gen);
    }
  }

  /** 默认可中断延时：分片睡眠，代数变化或停止时提前返回。以实际墙钟重算剩余等待。 */
  async _chunkedDelay(ms, gen) {
    // 2026-09-16 修复：同 _chunkedEnableDelay，以实际时间重算剩余（防漂移/休眠后恢复）。
    const targetMs = this.nowFn() + ms;
    while (true) {
      if (gen !== undefined && gen !== this._gen) return;
      if (!this.running) return;
      const remaining = targetMs - this.nowFn();
      if (remaining <= 0) return;
      await new Promise((r) => setTimeout(r, Math.min(250, remaining)));
    }
  }

  /**
   * 每日相位调度：
   * - 开启窗口 [enableHour, dailyStartHour)：每天一次自动开启（跨日重置，持久化见 this.enablePhase）；
   *   执行后等待到 dailyStartHour 进入暂停巡查。
   * - 00:00–enableHour：等待开启窗口起点（未配置开启窗口则等待 dailyStartHour）。
   * - dailyStartHour 后：暂停巡查（原有逻辑），跨日等待目标改为 enableHour（若配置了开启窗口），
   *   使次日 07:00 的自动开启相位能被唤醒，而不是直接跳到 08:00。
   * 停止/重启通过代数防止多循环；所有等待用 delayFn（可注入时钟门）。
   *
   * 2026-09-15 修复：
   *  - 第 3 项：每日"是否已开启"改为按 店铺+上海日期 持久化（this.enablePhase），
   *    成功才计入当日完成；失败/unknown 可在窗口内按规则重处理，重启不重复开启。
   *  - 第 4 项：相位执行后用**执行后当前时间**重算到 dailyStartHour 的等待
   *    （原先用相位前 now，慢执行/跨 08:00 会导致首轮暂停巡查延后）。
   */
  async _intervalLoop(gen) {
    const sch = this.config.schedule;
    const enableHour = this._enableHour();
    const enableWindow = this._enableWindowConfigured();
    while (gen === this._gen && this.running) {
      const now = this.nowFn();
      const w = shanghaiWall(now);

      // ── 开启窗口：[enableHour, dailyStartHour)，每天一次（按店铺+日期持久化）──
      // 独立每日开启调度器运行中（enableRunning）→ 窗口由专属循环处理，
      // 值守循环在本窗口内只等待到 dailyStartHour（避免双循环重复开启）。
      if (enableWindow && w.hour >= enableHour && w.hour < sch.dailyStartHour && !this.enableRunning) {
        const today = w.date;
        // 仅当所有活动店铺当日均为 success 时才算"已完成"（已删除店铺不参与）
        const shopsToRun = this._activeShops().filter(
          (s) => !this._enablePhaseDone(s.id, today)
        );
        if (shopsToRun.length > 0) {
          this.schedule.phase = 'enable_window';
          this.schedule.waitingFor08 = false;
          try {
            await this._runEnablePhase(gen, today, { scope: 'pause' });
          } catch (e) {
            this._memPush(this.recentErrors, { scope: 'cycle', error: `乘方自动开启相位失败：${e.message}` }, undefined, 'error');
          }
        }
        // 第 4 项：相位执行完毕，用**执行后的当前时间**重算，而不是相位前的 now。
        // 依据执行后的绝对时间决定：
        //   - 仍在同一上海日且未到 dailyStartHour 且 waitMs>0 → 等到 dailyStartHour 再进入暂停巡查
        //   - 已跨过 dailyStartHour（慢执行）→ 不等待，直接进入暂停巡查（避免首轮巡查延后）
        //   - 执行期间跨到次日（罕见，慢执行跨零/虚拟时钟快进）→ 回环重算，由下一轮窗口判定
        const afterMs = this.nowFn();
        const afterWall = shanghaiWall(afterMs);
        const waitMs = msUntilDailyStart(afterMs, sch.dailyStartHour);
        if (afterWall.date !== w.date) {
          // 跨日（含虚拟时钟快进）：不做固定等待，回环让下一轮按次日相位重新判定
          this.schedule.lastWindowBlockReason = `开启相位执行至 ${shanghaiClockText(afterMs)}，已跨日，重新判定下次相位`;
          continue;
        }
        if (afterWall.hour < sch.dailyStartHour && waitMs > 0) {
          const target = afterMs + waitMs;
          this.schedule.nextRunAt = new Date(target).toISOString();
          this.schedule.phase = 'waiting_window';
          this.schedule.waitingFor08 = true;
          this.schedule.lastWindowBlockReason = `等待每日 ${sch.dailyStartHour}:00（Asia/Shanghai）进入暂停巡查（相位执行至 ${shanghaiClockText(afterMs)}）`;
          await this.delayFn(waitMs, gen);
          continue;
        }
        // 已到/已过 dailyStartHour → 不等待，直接进入暂停巡查
        this.schedule.lastWindowBlockReason = `开启相位执行至 ${shanghaiClockText(afterMs)}，已到 ${sch.dailyStartHour}:00，直接进入暂停巡查`;
        continue;
      }

      if (!isAfterDailyStart(now, sch.dailyStartHour)) {
        // 每日 00:00–enableHour：等待开启窗口起点（或 dailyStartHour，若未配置开启窗口）
        const targetHour = enableWindow ? enableHour : sch.dailyStartHour;
        const waitMs = msUntilHour(now, targetHour);
        const target = now + waitMs;
        this.schedule.phase = 'waiting_window';
        this.schedule.waitingFor08 = true;
        this.schedule.nextRunAt = new Date(target).toISOString();
        this.schedule.lastWindowBlockReason = `等待每日 ${targetHour}:00（Asia/Shanghai）${enableWindow ? '进入自动开启窗口' : '后执行'}`;
        await this.delayFn(waitMs, gen);
        continue;
      }
      this.schedule.phase = 'running';
      this.schedule.waitingFor08 = false;
      // 停止后立即启动时，旧周期可能仍在完成在途读取。等待其退出再跑新周期，
      // 不能把互斥跳过当作已完成巡查并直接推迟半小时（否则后续店铺会漏读）。
      if (this._cycleRunning) {
        this.schedule.nextRunAt = null;
        await new Promise((resolve) => setTimeout(resolve, 250));
        continue;
      }
      try {
        await this.pollOnce('interval');
      } catch (e) {
        this._memPush(this.recentErrors, { scope: 'cycle', error: e.message }, undefined, 'error');
      }
      if (gen !== this._gen || !this.running) return;
      const lastRun = this.nowFn();
      this.schedule.lastRunAt = new Date(lastRun).toISOString();
      const epochBefore = this._scheduleEpoch || 0;
      const nd = nextIntervalDelayMs(this.nowFn(), lastRun, sch.intervalMinutes, sch.dailyStartHour, enableWindow ? enableHour : undefined);
      this.schedule.nextRunAt = new Date(nd.nextRunAt).toISOString();
      this.schedule.waitingFor08 = nd.crossDay; // 跨日 → 等待次日 enableHour（或 startHour）
      if (nd.crossDay) this.schedule.phase = 'waiting_window';
      await this.delayFn(nd.delayMs, gen);
      // 2026-09-21：挂起等待期间发生了阈值联动重排（pollNowAndReschedule 已自行执行过
      // 一次完整巡查并改写 nextRunAt）→ 旧节奏作废：补等"当前时刻 → 新 nextRunAt"的
      // 剩余时长后回循环头（绝不立即再执行一次多余巡查）。真实场景剩余 >0；
      // 时钟快进已越过新 nextRunAt 时剩余 0 → 直接回头按到期处理（与定时巡查等价）。
      if ((this._scheduleEpoch || 0) !== epochBefore) {
        const targetMs = Date.parse(this.schedule.nextRunAt || '');
        const remainMs = Number.isFinite(targetMs) ? Math.max(0, targetMs - this.nowFn()) : 0;
        if (remainMs > 0) {
          this.schedule.lastWindowBlockReason = `阈值联动重排生效：旧等待作废，改等新调度 ${this.schedule.nextRunAt}`;
          await this.delayFn(remainMs, gen);
        }
        continue;
      }
    }
  }

  /** 立即轮询一次（与定时轮询互斥；真实关闭受时间窗口限制）。 */
  async pollOnce(trigger = 'manual') {
    if (this.pending.length > 0) {
      return { ok: false, reason: `存在待配置/非法配置项，不允许轮询: ${this.pending.join('；')}` };
    }
    if (this._cycleRunning) {
      return { ok: false, reason: '已有轮询周期进行中，本次已跳过（防并发）' };
    }
    const token = { aborted: false, kind: 'pause' };
    this._activeTokens.add(token);
    this._cycleRunning = true;
    // 巡查周期序号（2026-09-15 修复第 3 项）：一次 pollOnce = 一个完整周期，序号明确递增。
    this.cycleNo += 1;
    const cycleNo = this.cycleNo;
    this._currentCycle = { cycleNo, trigger, startedAt: this.nowFn() };
    try {
      // 同轮跨店最多 2 家有界并行（2026-09-28 客户目标：第二家不无谓等待第一家整套采集/开启/回读）。
      // 同一家店的读取/决策/动作/回读仍串行（每店只占一个槽，由串行门保证开关不并发）。
      // 结果仍按配置顺序归集；停止后不再启动队列中的店；单店失败不影响另一店。
      // 不使用 Promise.race 假装取消在途页面读取——已启动的 _pollShop 自然结束。
      const shops = this._activeShops();
      const results = new Array(shops.length);
      const PARALLEL_LIMIT = 2;
      let nextIndex = 0;

      const runOne = async (shopCfg, idx) => {
        // 启动前复核：停止/软删除店不得进入处理
        if (token.aborted) {
          results[idx] = { shopId: shopCfg.id, status: 'skipped', reason: '监控已停止，本轮不再启动该店处理' };
          return;
        }
        if (!this._isShopActive(shopCfg.id)) {
          results[idx] = { shopId: shopCfg.id, status: 'skipped', reason: '店铺已删除，跳过值守/轮询' };
          return;
        }
        try {
          results[idx] = { shopId: shopCfg.id, ...(await this._pollShop(shopCfg, token, trigger)) };
        } catch (e) {
          // 单店失败如实记录，绝不取消另一店
          results[idx] = {
            shopId: shopCfg.id,
            status: 'stopped',
            reason: e.reason || e.message || '店铺处理异常',
            code: e.code || null,
          };
        }
      };

      const worker = async () => {
        while (true) {
          const idx = nextIndex;
          nextIndex += 1;
          if (idx >= shops.length) return;
          await runOne(shops[idx], idx);
        }
      };

      const workers = [];
      const n = Math.min(PARALLEL_LIMIT, shops.length);
      for (let i = 0; i < n; i += 1) workers.push(worker());
      await Promise.all(workers);

      // 防御：极端情况下若有空槽，按配置顺序补齐 skipped（不伪造成功）
      for (let i = 0; i < results.length; i += 1) {
        if (results[i] === undefined) {
          results[i] = { shopId: shops[i].id, status: 'skipped', reason: '本轮未处理（并行收口遗漏，如实记录）' };
        }
      }

      this.lastCycleAt = new Date(this.nowFn()).toISOString();
      return { ok: true, trigger, cycleNo, results };
    } finally {
      this._activeTokens.delete(token);
      this._cycleRunning = false;
      this._currentCycle = null;
    }
  }

  // ── 适配器/协调器 ────────────────────────────────────────────────
  _makeReader() {
    if (this.config.monitor.mockDataSource === true) {
      const md = this.config.monitor.mockData || {};
      return createMockPromoReader(
        { cost: md.cost, orders: md.orders, adPages: (md.ads && md.ads.pages) || [], adsMeta: md.ads, identity: md.identity },
        { now: this.nowFn }
      );
    }
    const useQc = this.config.monitor.costDataSource === 'qianchuan' || this.config.monitor.adListDataSource === 'qianchuan';
    const useCompass = this.config.monitor.orderDataSource === 'compass';
    if (!useQc && !useCompass) return createPromoReaderNotConnected();
    const { createCompositeReader } = require('../adapters/promo-reader');
    let costReader = null;
    let adReader = null;
    let orderReader = null;
    if (this.config.monitor.costDataSource === 'qianchuan' || this.config.monitor.adListDataSource === 'qianchuan') {
      const qc = require('../adapters/qianchuan-reader');
      const qcOpts = {
        loginCfg: this.config.login,
        nowFn: this.nowFn,
        maxAdPages: this.config.execution.maxAdPages,
        snapshotMaxAgeMinutes: this.config.monitor.snapshotMaxAgeMinutes,
      };
      if (this.config.monitor.costDataSource === 'qianchuan') {
        costReader = qc.createQianchuanCostReader(qcOpts);
      }
      if (this.config.monitor.adListDataSource === 'qianchuan') {
        adReader = qc.createQianchuanAdListReader({
          ...qcOpts,
          adTypes: (this.config.monitor.qianchuan && this.config.monitor.qianchuan.adTypes) || ['uni_promotion', 'standard'],
        });
      }
    }
    if (useCompass) {
      const { createCompassOrderReader } = require('../adapters/compass-order-reader');
      orderReader = createCompassOrderReader({ loginCfg: this.config.login, nowFn: this.nowFn });
    }
    return createCompositeReader({ costReader, orderReader, adReader });
  }

  _makeController(shopCfg) {
    if (this.config.monitor.mockDataSource === true) {
      const md = this.config.monitor.mockData || {};
      return createMockAdController({
        identity: md.identity || { id: shopCfg.id, name: shopCfg.name },
        ads: ((md.ads && md.ads.pages) || []).flat().map((a) => ({ adId: a.adId, name: a.name, status: a.status || '投放中' })),
      });
    }
    if (this.config.monitor.adListDataSource === 'qianchuan') {
      const { createQianchuanAdController } = require('../adapters/qianchuan-reader');
      return createQianchuanAdController({ loginCfg: this.config.login, nowFn: this.nowFn });
    }
    return createAdControllerNotConnected();
  }

  _getCoordinator(shopCfg) {
    let c = this._coordinators.get(shopCfg.id);
    if (!c) {
      c = new WholeShopCloseCoordinator({
        reader: this._injectedReader || this._makeReader(),
        controller: this._injectedController || this._makeController(shopCfg),
        config: this.config,
        now: this.nowFn,
        audit: (e) => this._audit(e),
      });
      this._coordinators.set(shopCfg.id, c);
    }
    return c;
  }

  /** 乘方主链路 runner（复用协调器的 readAndEvaluate 费用/订单核验链）。 */
  _getChengfangRunner(shopCfg) {
    let r = this._chengfangRunners.get(shopCfg.id);
    if (!r) {
      r = new ChengfangRunner({
        coordinator: this._getCoordinator(shopCfg),
        config: this.config,
        now: this.nowFn,
        audit: (e) => this._audit(e),
      });
      this._chengfangRunners.set(shopCfg.id, r);
    }
    return r;
  }

  /** 生产路径判定：配置了乘方范围（monitor.chengfang.scope）→ 只走乘方主链路。 */
  _chengfangScopeConfigured() {
    const cf = this.config.monitor && this.config.monitor.chengfang;
    return !!(cf && Array.isArray(cf.scope) && cf.scope.length > 0);
  }

  /** 每日自动开启时段起点（Asia/Shanghai 整点；配置缺省 7）。 */
  _enableHour() {
    const cf = this.config.monitor && this.config.monitor.chengfang;
    const v = cf && cf.enableHour;
    return (v !== undefined && v !== null && Number.isInteger(v) && v >= 0 && v <= 23) ? v : 7;
  }

  /** 是否启用每日自动开启相位（与暂停共用乘方范围配置；开启窗口 [enableHour, dailyStartHour)）。 */
  _enableWindowConfigured() {
    return this._chengfangScopeConfigured();
  }

  /** 历史全店关闭路径仅在测试显式开启（生产配置不设置，杜绝误入其他产品覆盖流程）。 */
  _legacyWholeShopAllowed() {
    return !!(this.config.monitor && this.config.monitor.legacyWholeShopCloseEnabled === true);
  }

  /**
   * 记录一条"每周期判断"（2026-09-15 修复第 3 项）。
   *
   * 旧行为：控制台/日志只在 `data.costCents`/`orders` **发生变化**时才输出判断文案，
   * 导致连续两轮（或多轮）数据相同时**没有判断记录**，无法证明"每 30 分钟确实巡查了"。
   *
   * 修复：每个完整周期都产生一条 judgement（带 cycleNo、业务日期、费用/订单/每单、
   * 整数分判定过程、结论），进入事件流供 3443 增量消费。**与数据是否变化无关。**
   */
  _emitJudgement(shopCfg, { data, over, status, reason, decision = null, currentAdState = null }) {
    const cycleNo = (this._currentCycle && this._currentCycle.cycleNo) || this.cycleNo;
    const costCents = data && data.cost ? data.cost.valueCents : null;
    const orders = data && data.orders ? data.orders.valueCount : null;
    const rule = (this.config.rules || []).find((r) => r.type === 'wholeShopCostPerOrder' && r.enabled !== false);
    const thresholdCents = this._thresholdCents(shopCfg);
    const rec = {
      cycleNo,
      trigger: this._currentCycle ? this._currentCycle.trigger : null,
      shopId: shopCfg.id,
      businessDate: data && data.cost ? data.cost.businessDate : null,
      costCents,
      orders,
      thresholdCents,
      expectedCents: (typeof orders === 'number' && typeof thresholdCents === 'number') ? orders * thresholdCents : null,
      over: over === true,
      overKnown: over !== null && over !== undefined,
      status,
      reason: reason || null,
      // 决策层标签（metric/decision 分离；currentAdState 只来自本轮回读）
      currentAdState: currentAdState || null,
      metric: (decision && decision.metric) || null,
      decision: (decision && decision.decision) || null,
      zeroClick: decision ? decision.zeroClick !== false : undefined,
      perOrderText: (data && data.cost && data.orders && typeof costCents === 'number' && orders > 0)
        ? perOrderDisplayText(costCents, orders) : null,
      at: new Date(this.nowFn()).toISOString(),
    };
    // 同一轮、同一店只记一次（防止同店重入重复）；同一轮不同店各记一条
    // （2026-09-28 补修：旧逻辑按全局 cycleNo 去重，两店并行时先完成的一店占记录，另一店丢失）
    if (this._judgementCycleNo !== cycleNo) {
      this._judgementCycleNo = cycleNo;
      this._judgementShops = new Set();
      this.lastJudgementCycleNo = cycleNo;
    }
    const shopKey = shopCfg && shopCfg.id != null ? String(shopCfg.id) : '';
    if (!this._judgementShops.has(shopKey)) {
      this._memPush(this.judgements, { kind: 'judgement', ...rec }, undefined, 'judgement');
      this._judgementShops.add(shopKey);
    }
    return rec;
  }

  /**
   * 启用的 wholeShopCostPerOrder 阈值（整数分）；缺失返回 null（决策层会 data_blocked）。
   * 多店铺：优先取店铺级 thresholdCents 覆盖，否则回落全局规则。
   */
  _thresholdCents(shopCfg = null) {
    if (shopCfg && Number.isSafeInteger(shopCfg.thresholdCents) && shopCfg.thresholdCents > 0) {
      return shopCfg.thresholdCents;
    }
    const rule = (this.config.rules || []).find((r) => r.type === 'wholeShopCostPerOrder' && r.enabled !== false);
    return rule ? rule.thresholdCents : null;
  }

  // ── 多店铺管理（2026-09-22）──────────────────────────────────────
  /** 未删除且未禁用的店铺清单（调度/手动操作的唯一活动范围）。 */
  _activeShops() {
    return (this.config.shops || []).filter((s) => s && s.deleted !== true && s.enabled !== false);
  }

  /** 店铺是否仍在活动列表（删除后调度器与手动接口都必须再次检查）。 */
  _isShopActive(shopId) {
    return this._activeShops().some((s) => s.id === shopId);
  }

  /** 按 id 找配置店铺（含已删除，供历史/编辑查找）。 */
  _findShop(shopId) {
    return (this.config.shops || []).find((s) => s && s.id === shopId) || null;
  }

  /**
   * 运行期店铺发现请求（2026-09-29 第 13 阶段）：供集成层（watch-drill 的 /state 拉取）
   * 周期性调用——服务运行期间新增的有效抖店 Cookie 在一次拉取周期内进入 config.shops
   * 与展示列表，无需重启或启动值守。带节流（默认 2s）：高频拉取不会放大目录扫描。
   * 安全边界：复用 _discoverShopsFromCookies（只追加/软删除不复活/不动既有条目；
   * 无任何页面回读或广告动作）；发现失败仅记录（绝不阻塞状态拉取）。
   * 返回语义（第 13 阶段补验证）：`ok` 与 `persisted` 一致反映"本次内存中的店铺已确认落盘"；
   * 落盘失败时 ok=false、persisted=false、pending=true 并附 reason——**不得返回持久化成功**。
   * @returns {{ok:boolean, throttled?:boolean, added?:string[], persisted?:boolean, pending?:boolean, reason?:string|null}} 摘要（供测试与日志）
   */
  requestShopDiscovery() {
    const now = this.nowFn();
    const minInterval = 2000;
    if (this._lastShopDiscoveryAt && now - this._lastShopDiscoveryAt < minInterval) {
      return { ok: true, throttled: true };
    }
    this._lastShopDiscoveryAt = now;
    try {
      const r = this._discoverShopsFromCookies();
      const persisted = r.persisted === true;
      return {
        ok: persisted,
        throttled: false,
        added: r.added,
        persisted,
        pending: r.pending === true,
        reason: persisted ? null : (r.reason || null),
      };
    } catch (e) {
      try { log.warn(`运行期 Cookie 店铺发现异常（不影响状态拉取）: ${e.message}`); } catch (_) {}
      return { ok: false, reason: e.message };
    }
  }

  /**
   * Cookie 自动发现店铺（2026-09-25 阶段 5，用户已确认方案）：
   * login.cookieSourceDir（+项目 cookies/ 目录）里的 Cookie 文件即店铺入口——
   * 新 Cookie 自动建店（autoDiscovered=true，追加在末尾）；既有条目（含
   * deleted=true 软删除店）原样保留，**绝不因重复扫描复活**；阈值/删除状态
   * 按店铺保存在 config.json（既有 updateShop/deleteShop 原子写语义不变）。
   * 发现到新店时尝试原子持久化：持久化失败仅记录（内存已生效），
   * 下次构造重试；发现流程任何异常不得阻塞装配。
   */
  _discoverShopsFromCookies() {
    const loginCfg = (this.config && this.config.login) || {};
    const r = discoverShopsFromCookies({
      loginCfg,
      shops: this.config.shops || [],
    });
    if (r.skipped.length > 0) {
      this._audit({ kind: 'shop-discovery', skipped: r.skipped });
    }
    const hasNew = r.added.length > 0;
    const retryPending = this._shopsPersistPending === true;
    if (hasNew) this.config.shops = r.shops;
    // 无新增且无待重试 → 内存与磁盘无差异，无需写盘
    if (!hasNew && !retryPending) {
      return { ...r, persisted: true, pending: false, retried: false };
    }
    const persist = this._persistShopsToConfig();
    this._audit({
      kind: 'shop-discovery',
      added: r.added,
      scannedDirs: r.scannedDirs,
      persisted: persist.ok === true,
      reason: persist.ok === true ? null : persist.reason,
    });
    if (persist.ok === true) {
      this._shopsPersistPending = false;
      try {
        log.info(hasNew
          ? `Cookie 自动发现 ${r.added.length} 家新店铺并已写入配置: ${r.added.join('、')}`
          : 'Cookie 自动发现：待落盘店铺已重试写入配置成功（无需重启）');
      } catch (_) {}
      return { ...r, persisted: true, pending: false, retried: !hasNew };
    }
    // 落盘失败：内存已生效（保持既有可见性），标记待重试；返回语义必须如实反映"未持久化成功"
    this._shopsPersistPending = true;
    this._memPush(this.recentErrors, {
      scope: 'shop-config',
      error: `Cookie 自动发现：${hasNew ? `${r.added.length} 家新店铺（${r.added.join('、')}）` : '待落盘店铺重试'}，配置落盘失败（内存已生效，进程内下次发现重试）: ${persist.reason}`,
    }, undefined, 'error');
    return { ...r, persisted: false, pending: true, retried: !hasNew, reason: persist.reason };
  }

  /**
   * 把 shops **原子写**回 config.json（tmp+rename；保留 _说明 等其他键；绝不写 Cookie/令牌/密钥）。
   * 写入失败返回 ok:false（调用方必须回滚内存并报告失败，不得先报成功）。
   * @returns {{ok:boolean, persisted:boolean, reason?:string}}
   */
  _persistShopsToConfig() {
    const cfgPath = (this.cfgResult && this.cfgResult.sourcePath) || null;
    if (!cfgPath || typeof cfgPath !== 'string' || !cfgPath.endsWith('.json')) {
      return { ok: false, persisted: false, reason: '无配置文件路径，无法持久化店铺变更' };
    }
    const tmp = `${cfgPath}.tmp-${process.pid}`;
    try {
      const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
      // 只投影安全展示字段，避免把运行时/敏感字段写回配置
      raw.shops = (this.config.shops || []).map((s) => {
        const out = {};
        for (const k of Object.keys(s)) {
          if (k === 'cookie' || k === 'token' || k === 'secret' || k === 'password' || k === 'apiKey') continue;
          out[k] = s[k];
        }
        return out;
      });
      fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
      fs.renameSync(tmp, cfgPath);
      return { ok: true, persisted: true };
    } catch (e) {
      try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* 清理失败忽略 */ }
      const reason = `店铺配置落盘失败: ${e.message}`;
      this._memPush(this.recentErrors, { scope: 'shop-config', error: reason }, undefined, 'error');
      return { ok: false, persisted: false, reason };
    }
  }

  /**
   * 店铺账户身份状态（2026-09-25 阶段 6，用户已确认方案）。
   * - 已配置 accountId（非空/非 TODO）→ 非 pending：账户映射由 guard 既有链路核验；
   * - 自动发现店用各自的 Cookie 会话进入广告账户；没有预填 accountId 不阻止操作。
   *   若显式配置了 accountId，既有数据源和广告页核验仍会精确比对它。
   * - 既有手工配置店缺 accountId → 保持现行语义（不回退既有行为）。
   * 缺少店铺配置仍阻止操作。
   */
  _shopIdentityState(shopCfg) {
    if (!shopCfg) return { pending: true, reason: '缺少店铺配置：禁止真实广告动作' };
    const raw = shopCfg.accountId;
    const acc = raw === undefined || raw === null ? '' : String(raw).trim();
    if (acc !== '' && !acc.toUpperCase().startsWith('TODO')) {
      return { pending: false, reason: null, configured: true };
    }
    return { pending: false, reason: null, configured: acc !== '' && !acc.toUpperCase().startsWith('TODO'), cookieSession: shopCfg.autoDiscovered === true };
  }

  /**
   * 立即更新单店数据（**只读**：只读取费用/订单/广告状态，绝不触发开关）。
   * 删除后店铺拒绝；未知/身份失败/分页不完整返回 blocked，零动作。
   */
  /**
   * 余额（2026-09-27，账户级只读展示字段）落到 lastData：
   * 本轮读取失败/缺失 → null（界面显示"未知"），不沿用旧值伪装成本轮新读数；
   * 绝不进入费用/订单/阈值/开关判定与通知判断。
   */
  _applyBalanceToLastData(rt, stateRead) {
    const bal = stateRead && stateRead.balance ? stateRead.balance : null;
    if (!rt.lastData) rt.lastData = {};
    rt.lastData.balanceCents = bal && bal.balanceCents != null ? bal.balanceCents : null;
    rt.lastData.balanceAt = bal && bal.balanceAt ? bal.balanceAt : null;
  }

  async refreshShopData(shopId) {
    const shopCfg = this._findShop(shopId);
    if (!shopCfg) return { ok: false, reason: '店铺不存在' };
    if (!this._isShopActive(shopId)) {
      return { ok: false, reason: '店铺已删除或停用，不再值守/更新', deleted: shopCfg.deleted === true };
    }
    if (this.pending.length > 0) {
      return { ok: false, reason: `存在待配置/非法配置项，不允许更新: ${this.pending.join('；')}` };
    }
    const rt = this._runtime(shopId);
    try {
      const coord = this._getCoordinator(shopCfg);
      let data;
      try {
        data = await coord.readAndEvaluate(shopCfg);
      } catch (e) {
        if (e instanceof NotConnectedError) {
          rt.lastError = '推广数据读取尚未接入';
          return { ok: false, reason: rt.lastError, zeroClick: true };
        }
        throw e;
      }
      rt.lastError = null;
      rt.lastData = this._summarizeData(data);
      rt.lastDataAt = new Date(this.nowFn()).toISOString();
      // 只读回读广告状态（on/off/mixed/unknown）；失败 → unknown + blocked 说明
      const stateRead = await this._readCurrentAdState(shopCfg);
      this._applyBalanceToLastData(rt, stateRead);
      // 只读观测更新状态；失败/unknown 也不得保留旧动作确认时间去配对新状态
      this._applyObservedAdState(shopCfg.id, stateRead.state || 'unknown', stateRead.error
        ? `只读回读失败：${stateRead.error.reason || 'unknown'}`
        : '只读清单/页面回读');
      if (stateRead.error) {
        rt.lastData.blockedReason = stateRead.error.reason;
        return {
          ok: true,
          readOnly: true,
          shopId,
          data: rt.lastData,
          adState: rt.lastAdState,
          blocked: stateRead.error.blocked || 'ad_state_read',
          reason: stateRead.error.reason,
          zeroClick: true,
        };
      }
      if (data.ok === false) {
        rt.lastData.blockedReason = data.reason;
        return {
          ok: true,
          readOnly: true,
          shopId,
          data: rt.lastData,
          adState: rt.lastAdState,
          blocked: data.blocked || 'data',
          reason: data.reason,
          zeroClick: true,
        };
      }
      this._audit({ kind: 'shop-refresh', shopId, readOnly: true, zeroClick: true, adState: rt.lastAdState });
      return {
        ok: true,
        readOnly: true,
        shopId,
        data: rt.lastData,
        adState: rt.lastAdState,
        zeroClick: true,
      };
    } catch (e) {
      const reason = e.reason || e.message;
      rt.lastError = reason;
      this._memPush(this.recentErrors, { scope: `shop:${shopId}`, error: reason }, undefined, 'error');
      this._audit({ kind: 'shop-refresh', shopId, ok: false, reason, zeroClick: true });
      return { ok: false, reason, zeroClick: true };
    }
  }

  /**
   * 修改店铺**展示名称**与阈值。
   * - 展示名写入 `displayName`，**绝不修改**身份字段 `name`/`id`/`compassShopName`/`accountId`/`cookieFile`；
   * - 先持久化（原子写），成功后才报告 ok:true；写入失败回滚内存并返回失败。
   * 不暴露/不修改 Cookie、令牌、密钥。
   */
  updateShop(shopId, { displayName, name, thresholdCents } = {}) {
    const shop = this._findShop(shopId);
    if (!shop) return { ok: false, reason: '店铺不存在' };
    if (shop.deleted === true) return { ok: false, reason: '店铺已删除，无法修改' };
    const patch = {};
    const rawDisplay = displayName !== undefined && displayName !== null ? displayName : name;
    if (rawDisplay !== undefined && rawDisplay !== null) {
      const n = String(rawDisplay).trim();
      if (!n || n.length > 100) {
        return { ok: false, reason: '展示名称无效：1–100 个字符' };
      }
      if (/cookie|token|secret|password|passwd|pwd|api[_-]?key|sessionid/i.test(n)) {
        return { ok: false, reason: '展示名称不得包含敏感字样' };
      }
      patch.displayName = n;
    }
    if (thresholdCents !== undefined && thresholdCents !== null) {
      const t = Math.floor(Number(thresholdCents));
      if (!Number.isFinite(t) || t < 1 || t > 1000000) {
        return { ok: false, reason: '阈值无效：需为 0.01–10000 元/单（整数分 1–1000000）' };
      }
      patch.thresholdCents = t;
    }
    if (Object.keys(patch).length === 0) {
      return { ok: false, reason: '未提供可修改字段（展示名称/阈值）' };
    }
    // 整店浅快照：写入失败精确回滚（含字段是否存在）
    const snapshotBefore = { ...shop };
    const from = {
      displayName: shop.displayName !== undefined ? shop.displayName : (shop.name || shop.id),
      thresholdCents: shop.thresholdCents ?? this._thresholdCents(shop),
    };
    // 只写允许修改的字段；身份字段由 Object.keys(shop) 原样保留
    Object.assign(shop, patch);
    const persist = this._persistShopsToConfig();
    if (!persist.ok) {
      // 精确回滚
      for (const k of Object.keys(shop)) {
        if (!(k in snapshotBefore)) delete shop[k];
      }
      Object.assign(shop, snapshotBefore);
      this._audit({ kind: 'shop-update', shopId, ok: false, reason: persist.reason, persisted: false, rolledBack: true });
      return { ok: false, reason: persist.reason, rolledBack: true, persisted: false };
    }
    this._audit({
      kind: 'shop-update',
      shopId,
      change: patch,
      from,
      to: { displayName: shop.displayName || shop.name, thresholdCents: shop.thresholdCents ?? this._thresholdCents(shop) },
      identityUnchanged: true,
      persisted: true,
    });
    this._saveState();
    return {
      ok: true,
      shopId,
      displayName: shop.displayName || shop.name,
      thresholdCents: shop.thresholdCents ?? this._thresholdCents(shop),
      from,
      identityUnchanged: true,
      persisted: true,
    };
  }

  /**
   * 删除店铺：软删除（deleted=true），停止值守/轮询/自动开启/自动暂停/手动操作。
   * - 先持久化，成功后才报告 ok:true；失败回滚内存并返回失败。
   * - **不中止其他店铺的在途任务**；被删除店在每次可能发出新广告动作前复核活动状态；
   *   已发出的动作仍完成有界回读。
   * **保留**历史状态（batches/enablePhase/adBelief）与 Cookie 文件，不删本地凭据。
   */
  deleteShop(shopId) {
    const shop = this._findShop(shopId);
    if (!shop) return { ok: false, reason: '店铺不存在' };
    if (shop.deleted === true) return { ok: true, alreadyDeleted: true, shopId, keepHistory: true, keepCookies: true };
    const snapshotBefore = {
      deleted: shop.deleted,
      enabled: shop.enabled,
      deletedAt: shop.deletedAt,
    };
    shop.deleted = true;
    shop.enabled = false;
    shop.deletedAt = new Date(this.nowFn()).toISOString();
    const persist = this._persistShopsToConfig();
    if (!persist.ok) {
      Object.assign(shop, snapshotBefore);
      this._audit({ kind: 'shop-delete', shopId, ok: false, reason: persist.reason, persisted: false, rolledBack: true });
      return { ok: false, reason: persist.reason, rolledBack: true, persisted: false };
    }
    // 绝不 abort 其他店的在途令牌；只在后续动作入口复核 _isShopActive
    this._audit({
      kind: 'shop-delete',
      shopId,
      note: '软删除：停止值守/轮询/自动启停/手动操作；保留历史状态与 Cookie 文件；不中止其他店在途任务',
      persisted: true,
    });
    this._memPush(this.recentErrors, {
      scope: `shop:${shopId}`,
      error: '店铺已删除：停止值守/轮询/自动开启/自动暂停/手动操作（历史与 Cookie 已保留）',
    }, undefined, 'error');
    this._saveState();
    return {
      ok: true,
      shopId,
      deleted: true,
      persisted: true,
      keepHistory: true,
      keepCookies: true,
    };
  }

  /**
   * 本轮回读 currentAdState（on/off/mixed/unknown）。
   * - 测试可注入 opts.readAdState；
   * - 清单身份/完整性失败 → 返回 error（调用方必须 blocked，不得包成 ok）；
   * - 空清单仅在 listComplete+范围有效时为 off（无目标）；否则 unknown。
   * @returns {Promise<{state:string, error?:{status:string,reason:string,blocked?:string}}>}
   */
  async _readCurrentAdState(shopCfg) {
    if (this._readAdState) {
      try {
        const r = await this._readAdState(shopCfg);
        // 注入契约扩展（2026-09-25 阶段 6）：可返回 {state, identity}（携带页面身份锚点）；
        // 2026-09-27 余额扩展：可返回 {state, identity, balance}（账户级只读展示字段）；
        // 字符串返回值保持既有语义（无 identity/balance）。
        if (r && typeof r === 'object' && !Array.isArray(r)) {
          return { state: normalizeAdState(r.state), identity: r.identity || null, balance: r.balance || null };
        }
        return { state: normalizeAdState(r), balance: null };
      } catch (e) {
        return {
          state: 'unknown',
          error: { status: 'blocked', reason: e.reason || e.message, blocked: 'ad_state_read' },
        };
      }
    }
    if (this._chengfangScopeConfigured()) {
      // 有界外壳（2026-09-29 08:00 事件）：整次回读带总截止时间，超时终止本次会话并返回可定位的 blocked unknown
      const cf = await this._readChengfangAdStateBounded(shopCfg);
      if (cf && typeof cf === 'object' && cf.balance === undefined) cf.balance = null;
      return cf;
    }
    try {
      const coord = this._getCoordinator(shopCfg);
      const inventory = await coord.listAllAds(shopCfg);
      const ads = inventory.ads || [];
      const confirmedEmpty = inventory.listComplete === true
        && ads.length === 0
        && !(inventory.coverageGaps && inventory.coverageGaps.length > 0);
      return {
        state: mapAdStateFromAdList(ads, { confirmedEmpty }),
        inventory,
        balance: null,
      };
    } catch (e) {
      // 身份/分页/完整性失败：blocked，不得映射成 ok/unknown 零点击
      return {
        state: 'unknown',
        error: {
          status: 'blocked',
          reason: e.reason || e.message,
          blocked: /身份/.test(String(e.reason || e.message)) ? 'identity' : 'inventory',
        },
      };
    }
  }

  /** 有界时长配置读取：config.monitor.chengfang[key]，非正整数回退 def。 */
  _adStateMsOption(key, def) {
    const raw = this.config && this.config.monitor && this.config.monitor.chengfang && this.config.monitor.chengfang[key];
    return (Number.isInteger(raw) && raw > 0) ? raw : def;
  }

  /**
   * 有界关闭会话（严格语义，2026-09-29 补验证修正）：只有 browser.close() **成功 resolve**
   * 才算 closed；拒绝或 waitMs 内未完成都返回 closed:false（error 带拒绝原因），调用方必须保持阻断。
   */
  async _closeSessionBounded(session, waitMs) {
    const browser = session && (session.browser || (session.page && session.page.browser && session.page.browser()));
    if (!browser || typeof browser.close !== 'function') return { closed: true, error: null, promise: null };
    let settledOk = false;
    let settledErr = null;
    const p = Promise.resolve()
      .then(() => browser.close())
      .then(() => { settledOk = true; }, (e) => { settledErr = e || new Error('browser.close rejected'); });
    await Promise.race([p, new Promise((r) => setTimeout(r, waitMs))]);
    return { closed: settledOk && !settledErr, error: settledErr, promise: p };
  }

  /** settle 记录器：resolve/reject 都算 settle；settledP 永不 reject（可安全 await/竞争）。 */
  _settleRecord(promise) {
    let settled = false;
    const settledP = Promise.resolve().then(() => promise).then(() => { settled = true; }, () => { settled = true; });
    return { settledP, isSettled: () => settled };
  }

  /**
   * 带登记的有界会话关闭（2026-09-29 二次补验证修正）：关闭一发起就**同步**登记为 pending
   * （closed:null）进 closes 列表，完成后再更新为 true/false——放行判定在任何时刻都能看到
   * 「在途关闭」，不会因「关闭结果未返回、列表尚为空」而误判全部已关闭并放行下一轮。
   */
  _closeSessionTracked(session, waitMs, closes, label) {
    const entry = { label, closed: null, error: null, promise: null };
    closes.push(entry);
    const p = this._closeSessionBounded(session, waitMs).then((r) => {
      entry.closed = r.closed;
      entry.error = r.error;
      return r;
    });
    entry.promise = p;
    return p;
  }

  /**
   * 阻断推进（2026-09-29 补验证修正；二次补验证加强）：真实等待旧 work settle（上界
   * settleBoundMs 防绝对僵死；未 settle 一律不放行），随后逐个核对已登记的会话关闭——
   * 在途（closed:null）先等其出结果，仍未成功的补做一次（重试幂等，严格成功才算收口）。
   * 动态遍历以覆盖等待期间新登记的条目。
   */
  async _advanceReadGate(gate, settleBoundMs, closeWaitMs) {
    const settled = await Promise.race([gate.workRec.settledP.then(() => true), new Promise((r) => setTimeout(r, settleBoundMs)).then(() => false)]);
    if (!settled) return { done: false, why: 'work 未 settle' };
    for (let i = 0; i < gate.closes.length; i++) {
      const c = gate.closes[i];
      if (c.closed === true) continue;
      if (c.promise && c.closed === null) {
        await Promise.race([c.promise, new Promise((r) => setTimeout(r, closeWaitMs))]);
        if (c.closed === true) continue;
      }
      const r = await this._closeSessionBounded(gate.sessionRef(), closeWaitMs);
      c.closed = r.closed;
      c.error = r.error;
      if (!r.closed) return { done: false, why: `会话关闭失败${r.error ? ': ' + String((r.error && r.error.message) || r.error).slice(0, 120) : ''}` };
    }
    const bad = gate.closes.filter((c) => c.closed !== true);
    if (bad.length > 0) return { done: false, why: `仍有未完成收口：${bad.map((c) => c.label).join('、')}` };
    return { done: true, why: null };
  }

  /**
   * unknown 槽位核验释放（2026-09-29 第 6 阶段，2026-09-29 13:02 潮流服饰 pause 槽位先例）。
   * 释放证据的**全部**必要条件（缺一即保持阻断、零点击）：
   *   1) 该店当前存在 unknown 阻塞槽位（hasUnknownBlock + peek 精确到该店、该 actionId）；
   *   2) 回读为**本轮新鲜结果**：优先复用调用方刚完成的 stateRead0；否则现场做一次
   *      _readCurrentAdState（乘方链路已带 v3 总截止时间，超时/失败 → error → 不释放）；
   *   3) 回读**完整且有身份背书**：无 error、rows 为全量分页背书的数组、identity.ok===true
   *      （乘方链路 verifyIdentity+guard 通过后才返回 identity；不采信无 rows 的注入/摘要结果）；
   *   4) 回读状态**严格等于旧动作目标态**（pause→off 且全部行 switchChecked===false 或确认空清单；
   *      enable→on 且全部行 ===true）；mixed/unknown/部分行不达标一律不释放；
   *   5) 释放走现有唯一入口 resolveUnknownWithReadback（内部再做 shopId+actionId 精确匹配）
   *      并带同步持久化门禁（_saveState 失败 → 槽位回滚 unknown，保持阻断）。
   * 不采信：历史 adBelief、费用/订单观测、单页结果、旧时间戳。全量 off 只核验「当前目标态
   * 已达成」，**不声明历史点击的因果**（note 中明示）。
   * @returns {Promise<{resolved:boolean, reason?:string, actionId?:string}|null>} null=无 unknown 槽位（无动作）
   */
  async _tryResolveUnknownSlotWithFreshRead(shopCfg, stateRead0 = null) {
    const orch = this._switchOrchestrator;
    if (!orch || typeof orch.hasUnknownBlock !== 'function' || typeof orch.peek !== 'function'
      || typeof orch.resolveUnknownWithReadback !== 'function') return null;
    if (!orch.hasUnknownBlock(shopCfg.id)) return null;
    const slot = orch.peek(shopCfg.id);
    if (!slot || !slot.actionId || slot.unknown !== true || slot.settled === true) return null;
    const expectState = slot.action === 'pause' ? 'off' : (slot.action === 'enable' ? 'on' : null);
    if (!expectState) {
      this._audit({ kind: 'ad-switch', step: 'resolve-unknown-attempt', shopId: shopCfg.id, actionId: slot.actionId, ok: false, reason: `旧动作类型无法核验（${slot.action}）：保持阻断` });
      return { resolved: false, reason: `旧动作类型无法核验（${slot.action}）：保持阻断`, actionId: slot.actionId };
    }
    const read = stateRead0 || await this._readCurrentAdState(shopCfg);
    const r = read || {};
    let noReleaseReason = null;
    if (r.error) noReleaseReason = `回读失败/超时（${r.error.blocked || 'error'}）：${String(r.error.reason || '').slice(0, 120)}`;
    else if (r.state !== expectState) noReleaseReason = `本轮回读=${r.state}，旧 ${slot.action} 目标=${expectState}：目标态未确认`;
    else if (!Array.isArray(r.rows)) noReleaseReason = '回读缺少全量清单背书（rows 缺失）：不得以摘要/单页释放';
    else if (!r.identity || r.identity.ok !== true) noReleaseReason = '回读缺少身份核验证据（identity.ok 非 true）';
    else {
      const allTarget = r.rows.every((x) => x && x.switchChecked === (expectState === 'off' ? false : true));
      if (!allTarget) {
        const bad = r.rows.filter((x) => !x || x.switchChecked !== (expectState === 'off' ? false : true)).length;
        noReleaseReason = `清单存在 ${bad} 行非目标态：不得释放`;
      }
    }
    if (noReleaseReason) {
      this._audit({ kind: 'ad-switch', step: 'resolve-unknown-attempt', shopId: shopCfg.id, actionId: slot.actionId, ok: false, reason: noReleaseReason });
      return { resolved: false, reason: noReleaseReason, actionId: slot.actionId };
    }
    const note = `unknown 槽位核验释放：本轮回读 ${r.state}（${r.rows.length} 行全量${expectState === 'off' ? '关闭' : '开启'}${r.rows.length === 0 ? '（确认空清单）' : ''}，身份通过，读取时间 ${new Date(this.nowFn()).toISOString()}）；仅核验当前目标态已达成，不声明历史点击因果`;
    const res = orch.resolveUnknownWithReadback(shopCfg.id, slot.actionId, {
      confirmed: true,
      note,
      persist: () => this._saveState(),
    });
    const ok = res && res.ok === true;
    this._audit({ kind: 'ad-switch', step: 'resolve-unknown-attempt', shopId: shopCfg.id, actionId: slot.actionId, ok, reason: ok ? note : String((res && res.reason) || '释放失败：保持阻塞').slice(0, 160) });
    return { resolved: ok, reason: ok ? note : String((res && res.reason) || '释放失败：保持阻塞'), actionId: slot.actionId };
  }

  /**
   * 生产回读外壳（2026-09-29 08:00 事件；同日补验证修正收口判定）：
   * 给乘方整次回读加总截止时间。放行规则：下一次回读必须在「旧 work 已 settle 且本次涉及的
   * 浏览器会话全部严格关闭成功」之后才允许启动 opener；截止后 opener 才返回的迟到会话由
   * onSession 立即严格关闭，绝不留下无人管理的浏览器。收口未证明（work 未 settle 或任一会话
   * 关闭未成功）时返回 blocked unknown 并保持阻断（_pendingReadGate），下一轮回读先推进收口
   * （_advanceReadGate），未完成前不开新读取——不产生重叠读取。
   * 审计 kind:ad-state-read：start / done(ok|error) / deadline(cleanup=closed|blocked) / blocked，带 lastStep 与原因。
   */
  async _readChengfangAdStateBounded(shopCfg) {
    const timeoutMs = this._adStateMsOption('adStateReadTimeoutMs', 300000);
    const settleBoundMs = this._adStateMsOption('adStateSettleWaitMs', 5000);
    const closeWaitMs = this._adStateMsOption('adStateCloseWaitMs', 10000);
    if (this._pendingReadGate) {
      const adv = await this._advanceReadGate(this._pendingReadGate, settleBoundMs, closeWaitMs);
      if (!adv.done) {
        try { this._audit({ kind: 'ad-state-read', shopId: shopCfg.id, event: 'blocked', reason: `上一回读未完成收口（${adv.why}），保持阻断（不启动新回读）` }); } catch (_) { /* 审计失败不影响 */ }
        return { state: 'unknown', error: { status: 'blocked', reason: `上一回读未完成收口（${adv.why}），保持阻断（不启动新回读）`, blocked: 'ad_state_read', blockedBy: 'unread_session' } };
      }
      this._pendingReadGate = null;
    }
    try { this._audit({ kind: 'ad-state-read', shopId: shopCfg.id, event: 'start', timeoutMs }); } catch (_) { /* 审计失败不影响 */ }
    const steps = [];
    const closes = [];
    let session = null;
    let timedOut = false;
    const work = this._readChengfangAdState(shopCfg, {
      steps,
      onSession: (s) => {
        session = s;
        if (timedOut) {
          // 迟到会话（截止后才建立/返回）：立即严格关闭；关闭一发起就同步登记为 pending，
          // 旧 work 先 settle 时绝不因「closes 尚为空/条目未完成」误判全部已关闭（二次补验证修正）
          this._closeSessionTracked(s, closeWaitMs, closes, 'late-session');
        }
      },
    });
    const workRec = this._settleRecord(work);
    let timer = null;
    let deadlineFired = false;
    let result;
    try {
      result = await Promise.race([
        work,
        new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; deadlineFired = true; resolve({ __readDeadline: true }); }, timeoutMs); }),
      ]);
    } catch (e) {
      clearTimeout(timer);
      // work 理论上不 reject（内层全兜底）；防御性透传前尽量终止会话
      if (session) await this._closeSessionBounded(session, closeWaitMs).catch(() => {});
      throw e;
    }
    clearTimeout(timer);
    if (!deadlineFired) {
      try { this._audit({ kind: 'ad-state-read', shopId: shopCfg.id, event: 'done', outcome: result && result.error ? 'error' : 'ok', lastStep: steps.length ? steps[steps.length - 1] : null }); } catch (_) { /* 审计失败不影响 */ }
      return result;
    }
    // ── 截止收口：每一步都是真实收口证明，不以定时等待结束或 browser.closed 假值放行
    const lastStep = steps.length ? steps[steps.length - 1] : null;
    if (session) {
      // 关闭一发起就同步登记为 pending（见 _closeSessionTracked）
      this._closeSessionTracked(session, closeWaitMs, closes, 'session');
    }
    const settledNow = await Promise.race([workRec.settledP.then(() => true), new Promise((r) => setTimeout(r, settleBoundMs)).then(() => false)]);
    if (settledNow) {
      // work 已 settle：迟到会话登记必然已完成（onSession 同步登记先于 settle）——排空在途关闭结果
      for (let i = 0; i < closes.length; i++) {
        const c = closes[i];
        if (c.promise && c.closed === null) await Promise.race([c.promise, new Promise((r) => setTimeout(r, closeWaitMs))]);
      }
    }
    const pendingClose = closes.some((c) => c.closed === null);
    const allClosed = closes.every((c) => c.closed === true);
    if (!settledNow || !allClosed) {
      this._pendingReadGate = { workRec, sessionRef: () => session, closes };
      const why = !settledNow
        ? 'work 未 settle'
        : closes.filter((c) => c.closed !== true).map((c) => `${c.label}${c.closed === null ? ' 关闭进行中' : ' 关闭失败'}${c.error ? ': ' + String((c.error && c.error.message) || c.error).slice(0, 120) : ''}`).join('；');
      try { this._audit({ kind: 'ad-state-read', shopId: shopCfg.id, event: 'deadline', lastStep, timeoutMs, cleanup: 'blocked', why: why + (pendingClose ? '（存在在途关闭）' : '') }); } catch (_) { /* 审计失败不影响 */ }
      return { state: 'unknown', error: { status: 'blocked', reason: `回读截止（${timeoutMs}ms）已到：${why}，已保持阻断（不启动新回读）；最后步骤：${lastStep || '未记录'}`, blocked: 'ad_state_read', timeout: true, lastStep, cleanup: 'blocked' } };
    }
    try { this._audit({ kind: 'ad-state-read', shopId: shopCfg.id, event: 'deadline', lastStep, timeoutMs, cleanup: 'closed' }); } catch (_) { /* 审计失败不影响 */ }
    return { state: 'unknown', error: { status: 'blocked', reason: `回读截止（${timeoutMs}ms）已到，已终止本次会话；最后步骤：${lastStep || '未记录'}`, blocked: 'ad_state_read', timeout: true, lastStep, cleanup: 'closed' } };
  }

  /**
   * 生产默认：乘方双 UI（scope）只读回读 → on/off/mixed/unknown。
   * 复用会话开启器 + controller.readView/refreshView/分页；**不点击任何开关**。
   * 身份/清单/分页失败 → error(blocked)，不得包成 ok。
   * _meta（外壳注入）：steps=步骤收集数组；onSession=会话建立回调（供截止时终止会话）。
   */
  async _readChengfangAdState(shopCfg, _meta = null) {
    const markStep = (s) => { if (_meta && _meta.steps && _meta.steps.length < 64) _meta.steps.push(s); };
    const opener = this._chengfangOpener || defaultChengfangOpener;
    const loginCfg = this.config.login;
    const tabs = ((this.config.monitor && this.config.monitor.chengfang && this.config.monitor.chengfang.scope)
      || ['全店托管', '商品自选']).filter((t) => t === '全店托管' || t === '商品自选');
    let session = null;
    try {
      markStep('session-open');
      session = await opener({ loginCfg, shopCfg });
      if (_meta && _meta.onSession) _meta.onSession(session);
      if (!session || !session.page || !session.controller) {
        return { state: 'unknown', error: { status: 'blocked', reason: '乘方会话不完整（缺 page/controller）', blocked: 'ad_state_read' } };
      }
      const { page, controller } = session;
      markStep('identity');
      const identity = await controller.verifyIdentity({ page, shopCfg });
      guard.checkControllerIdentity(identity, shopCfg);
      // 余额（2026-09-27，账户级只读展示字段）：与广告状态同一乘方会话、同一页面，
      // infoItem 内 infoLabel/infoValue 配对读取；失败 → null（界面显示"未知"），
      // 绝不影响广告状态读取，也绝不进入开关判定。balanceAt 为本机读取时间。
      let balance = null;
      markStep('balance');
      try {
        const pageBalance = await page.evaluate(readQianchuanBalanceInPage);
        balance = balanceCentsFromPageResult(pageBalance);
        balance.balanceAt = new Date(this.nowFn()).toISOString();
      } catch (e) {
        balance = { balanceCents: null, balanceText: null, reason: String((e && e.message) || e).slice(0, 120), balanceAt: new Date(this.nowFn()).toISOString() };
      }
      const rows = [];
      let sawTab = false;
      let emptyEvidence = true;
      for (const tab of tabs) {
        if (controller.refreshView) {
          let rf;
          markStep(`refresh:${tab}`);
          try {
            rf = await controller.refreshView({ page, tab });
          } catch (e) {
            return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」刷新失败：${e.reason || e.message}`, blocked: 'inventory' } };
          }
          // 旧 UI 明确 legacy-ui → 保留既有语义，继续读取
          const legacyUi = !!(rf && (rf.reason === 'legacy-ui' || rf.ui === 'legacy'));
          if (!rf || typeof rf !== 'object') {
            return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」刷新结果不可识别（null/非对象）`, blocked: 'inventory' } };
          }
          if (legacyUi) {
            // 旧 UI：不猜测缺失数据，继续按 readView 契约读取
          } else if (rf.refreshed === false) {
            return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」刷新未成功：${rf.reason || '未刷新'}`, blocked: 'inventory' } };
          } else if (rf.refreshed !== true) {
            return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」刷新结果不可识别（refreshed=${JSON.stringify(rf.refreshed)}）`, blocked: 'inventory' } };
          } else if (rf.warning) {
            return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」刷新警告：${rf.warning}`, blocked: 'inventory' } };
          }
        }
        await controller.switchView({ page, tab });
        let pageNo = 0;
        const seenIds = new Set();
        const seenPages = new Set();
        let rowsInTab = 0;
        let totalHint = null;
        while (true) {
          pageNo += 1;
          markStep(`read:${tab}:p${pageNo}`);
          const v = await controller.readView({ page, tab });
          if (!v || (v.rows && v.rows.error) || v.error) {
            return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」第 ${pageNo} 页读取失败`, blocked: 'inventory' } };
          }
          sawTab = true;
          const list = (v.rows && v.rows.rows) || v.rows || [];
          if (!Array.isArray(list)) {
            return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」行数据非法`, blocked: 'inventory' } };
          }
          const pag = v.pagination || {};
          if (list.length === 0) {
            if (pag.total !== 0) {
              return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」无行但缺少空态证据（分页 total=${pag.total == null ? '缺失' : pag.total}）`, blocked: 'inventory' } };
            }
            emptyEvidence = emptyEvidence && true;
          } else {
            emptyEvidence = false;
            for (const r of list) {
              if (!r || r.id === undefined || r.id === null || r.id === '') {
                return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」第 ${pageNo} 页存在无稳定 ID 行，清单不可信`, blocked: 'inventory' } };
              }
              const idKey = String(r.id);
              if (seenIds.has(idKey)) {
                return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」计划 ID 跨页重复：${idKey}`, blocked: 'inventory' } };
              }
              seenIds.add(idKey);
              rowsInTab += 1;
              rows.push({ id: r.id, switchChecked: r.switchChecked });
            }
          }
          // 页码以读取器实际 activePage 为准（pageNo 缺失不得退回本地计数掩盖重复页）
          // 多页（已有前页或 hasNext=true）必须以 activePage 核对顺序；单页末页可缺省
          const multi = seenPages.size > 0 || pag.hasNext === true;
          const apRaw = pag.activePage;
          if (multi && (apRaw === undefined || apRaw === null)) {
            return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」第 ${pageNo} 页缺失 activePage：多页页码顺序不可核对`, blocked: 'inventory' } };
          }
          // 页面读取器从 DOM 文本解析 activePage，实际返回 "1" 这类十进制字符串。
          const apText = typeof apRaw === 'string' ? apRaw : null;
          const ap = (apRaw === undefined || apRaw === null) ? 1
            : (Number.isSafeInteger(apRaw) ? apRaw
              : (apText && /^[1-9]\d*$/.test(apText) ? Number(apText) : NaN));
          if (!Number.isSafeInteger(ap) || ap < 1) {
            return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」activePage 非法：${JSON.stringify(apRaw)}`, blocked: 'inventory' } };
          }
          if (seenPages.has(ap)) {
            return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」重复页：activePage=${ap}`, blocked: 'inventory' } };
          }
          const lastAp = seenPages.size ? Math.max(...seenPages) : 0;
          if (ap !== lastAp + 1) {
            return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」页码不递增：activePage=${ap}（期望 ${lastAp + 1}）`, blocked: 'inventory' } };
          }
          seenPages.add(ap);
          if (pag.total !== undefined && pag.total !== null) {
            if (!Number.isInteger(pag.total) || pag.total < 0) {
              return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」total 非法：${JSON.stringify(pag.total)}`, blocked: 'inventory' } };
            }
            if (totalHint === null) totalHint = pag.total;
            else if (pag.total !== totalHint) {
              return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」分页 total 不一致：${totalHint} → ${pag.total}`, blocked: 'inventory' } };
            }
          }
          if (pag.hasNext === false) {
            if (typeof totalHint === 'number' && rowsInTab !== totalHint) {
              return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」末页已读行数 ${rowsInTab} 与 total ${totalHint} 不一致：清单不完整`, blocked: 'inventory' } };
            }
            break;
          }
          if (pag.hasNext !== true) {
            return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」第 ${pageNo} 页 hasNext=${JSON.stringify(pag.hasNext)}：分页结束标记不明确，清单不完整`, blocked: 'inventory' } };
          }
          if (pageNo >= 20) {
            return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」分页超过上限，清单不完整`, blocked: 'inventory' } };
          }
          markStep(`next:${tab}:p${pageNo}`);
          const next = await controller.clickNextPage({ page });
          if (!next || next.clicked !== true) {
            return { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」翻页失败，清单不完整`, blocked: 'inventory' } };
          }
        }
      }
      if (!sawTab) {
        return { state: 'unknown', error: { status: 'blocked', reason: '乘方控制范围为空，无法回读状态', blocked: 'inventory' } };
      }
      const state = mapAdStateFromSwitchRows(rows, { confirmedEmpty: emptyEvidence && rows.length === 0 });
      // 不可识别开关类 unknown（无 error）的证据摘要：与带 error 的读取失败区分（2026-09-29 08:00 事件）
      let switchEvidence = null;
      if (state === 'unknown') {
        const badIdx = [];
        for (let i = 0; i < rows.length; i++) {
          const r = rows[i];
          if (!r || (r.switchChecked !== true && r.switchChecked !== false)) badIdx.push(i);
        }
        switchEvidence = { kind: 'unrecognized_switches', rowsTotal: rows.length, unrecognizedRows: badIdx.length, sampleRowIndexes: badIdx.slice(0, 5) };
      }
      // 透出本轮回读的页面身份（供账户映射自动建立使用；不改变既有状态语义）
      return { state, rows, identity, balance, switchEvidence };
    } catch (e) {
      return {
        state: 'unknown',
        error: {
          status: 'blocked',
          reason: e.reason || e.message,
          blocked: /身份/.test(String(e.reason || e.message)) ? 'identity' : 'inventory',
        },
      };
    } finally {
      try {
        if (session && typeof session.close === 'function') await session.close();
        else if (session && session.browser) await session.browser.close();
      } catch (_) { /* 关闭失败不冒泡 */ }
    }
  }

  /** 开启/暂停已执行批次唯一落库入口：盘点/未发出/门槛结果不进 actions；partial/unknown 如实记录。 */
  _commitExecutedBatch(shopId, batch) {
    if (!batch || !batch.outcome) return;
    const o = batch.outcome;
    // 盘点无动作 / 门槛 / 取消 / 演练：保留批次与审计，但不记「已执行广告动作」
    if (o === 'blocked' || o === 'blocked_window' || o === 'blocked_stopped' || o === 'blocked_coverage'
      || o === 'cancelled' || o === 'dry' || o === 'dry_failed'
      || o === 'nothing_to_close' || o === 'nothing_to_pause' || o === 'nothing_to_enable') {
      // nothing_to_* 仍是全量回读确认目标状态：立即更新页面广告状态（不记「已执行」批次）
      const confirmedAt = new Date(this.nowFn()).toISOString();
      if (o === 'nothing_to_pause' && batch.allPausedConfirmed === true) {
        this.adBelief[shopId] = { on: false, at: confirmedAt, evidence: '只读核验确认全部已暂停' };
        this._applyConfirmedAdState(shopId, 'off', confirmedAt, '只读核验确认全部已暂停');
        this._saveState();
      } else if (o === 'nothing_to_enable' && batch.allEnabledConfirmed === true) {
        this.adBelief[shopId] = { on: true, at: confirmedAt, evidence: '只读核验确认全部已开启' };
        this._applyConfirmedAdState(shopId, 'on', confirmedAt, '只读核验确认全部已开启');
        this._saveState();
      }
      return;
    }
    if (!batch.counts) return;
    batch.actionType = batch.actionType || 'enable';
    this._recordBatch(shopId, batch);
    this._memPush(this.actions, { shopId, ...this._summarizeBatch(batch) }, undefined, 'batch');
    this._audit({ kind: 'action', shopId, ...this._summarizeBatch(batch) });
  }

  /**
   * 决策 + 串行门外层统一入口：should_pause / should_enable。
   * 动作执行复用现有 runner/executor（不复制 Playwright）。
   */
  async _runShopSwitchAction(shopCfg, action, data, cycleToken, trigger, opts = {}) {
    if (!this._isShopActive(shopCfg.id)) {
      return { status: 'blocked', reason: '店铺已删除或停用，拒绝执行广告操作', zeroClick: true, outcome: 'blocked_stopped' };
    }
    // 缺少店铺配置仍拒绝；自动发现店使用自己的 Cookie，不要求预填账户号。
    const idGate = this._shopIdentityState(shopCfg);
    if (idGate.pending) {
      this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason: idGate.reason, blocked: 'identity_pending', zeroClick: true });
      return { status: 'blocked', reason: idGate.reason, zeroClick: true, outcome: 'blocked', blocked: 'identity_pending' };
    }
    // unknown 槽位核验释放（2026-09-29 第 6 阶段）：仅当该店存在 unknown 阻塞槽位时，用一次
    // 新鲜、完整、身份核验通过且有界的本轮回读严格确认旧动作目标状态已达成才释放；
    // 任一条件不满足则不做任何事（后续仍由串行门阻断，零点击）。
    await this._tryResolveUnknownSlotWithFreshRead(shopCfg);
    const thresholdCents = this._thresholdCents(shopCfg);
    const decide = (currentAdState) => this._switchOrchestrator.evaluatePeriodic({
      costCents: data.cost.valueCents,
      orders: data.orders.valueCount,
      thresholdCents,
      currentAdState,
      identityOk: true,
    });
    const targetState = action === 'enable' ? 'on' : 'off';
    const settled = await this._switchOrchestrator.runSwitchAction({
      shopId: shopCfg.id,
      action,
      targetState,
      allowAlreadyOffPause: opts.allowAlreadyOffPause === true,
      persistBeforeRelease: () => this._saveState(),
      readState: async () => {
        const r = await this._readCurrentAdState(shopCfg);
        return r.state;
      },
      decide,
      execute: async () => {
        // 动作发出前必须成功持久化 actionId/未结束状态（tryBegin 已占槽）
        const pre = this._persistBeforeDispatch(shopCfg.id, action, null);
        if (!pre.ok) {
          return { outcome: 'persistence_blocked', neverSent: true, reason: pre.reason, counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 } };
        }
        if (action === 'pause') {
          if (this._chengfangScopeConfigured()) {
            const r = await this._pollChengfangOver(shopCfg, data, cycleToken, trigger);
            return this._normalizeExecuteResult(r, 'pause');
          }
          if (this._legacyWholeShopAllowed()) {
            const r = await this._pollLegacyWholeShopOver(shopCfg, data, cycleToken);
            return this._normalizeExecuteResult(r, 'pause');
          }
          return {
            neverSent: true,
            outcome: 'blocked',
            reason: '未配置乘方控制范围（monitor.chengfang.scope）且未显式开启历史全店路径：监控不执行任何关闭',
          };
        }
        // 低于阈值开启：threshold_recovery（值守窗口；不受每日相位去重）
        return this._executeEnableBatchFor(shopCfg, cycleToken, {
          reason: data.evaluation && data.evaluation.reason,
          triggerLabel: 'below_threshold_enable',
          enableSource: 'threshold_recovery',
        });
      },
    });

    if (action === 'enable' && settled.serial && settled.serial !== 'not_sent') {
      const b0 = settled.batch || {};
      const br0 = b0.batch || b0;
      this._commitExecutedBatch(shopCfg.id, br0 && br0.outcome ? br0 : b0);
    }
    return this._mapSwitchReturn({ action, settled });
  }

  /**
   * 统一动作返回契约（单一映射）。优先级：blocked/status > dryRun/batch/outcome > zeroClick/decision。
   * 不覆盖门禁字段；不适用字段不伪造。
   */
  _mapSwitchReturn({ action, settled, extra = null }) {
    const s = settled || {};
    const inner = (s.batch && typeof s.batch === 'object') ? s.batch : {};
    const nested = (inner.batch && typeof inner.batch === 'object') ? inner.batch : inner;
    // 优先 settle 已带的 outcome（含 persistence_blocked），再 batch
    let outcome = s.outcome || nested.outcome || null;
    if (!outcome && s.persistence && s.persistence.ok === false && s.serial === 'not_sent') {
      outcome = 'persistence_blocked';
    }
    let status = 'ok';
    if (s.blocked === 'serial_gate') status = 'blocked';
    else if (nested.status === 'window_blocked' || outcome === 'blocked_window' || s.status === 'window_blocked') status = 'window_blocked';
    else if (nested.status === 'stopped' || outcome === 'blocked_stopped') status = 'stopped';
    else if (nested.status === 'blocked' || outcome === 'blocked' || outcome === 'blocked_coverage') status = 'blocked';
    else if (outcome === 'persistence_blocked') status = 'blocked';
    const dryRun = inner.dryRun === true || nested.dryRun === true || outcome === 'dry' || outcome === 'dry_failed';
    const zeroClick = s.zeroClick === true || s.serial === 'not_sent';
    const out = {
      status,
      over: status === 'ok' && !zeroClick && action === 'pause',
      zeroClick,
      action: action || null,
      actionId: s.actionId || null,
      serial: s.serial,
      decision: s.decision || null,
      currentAdState: s.currentAdState || null,
      reason: s.reason || null,
      outcome,
      dispatched: s.dispatched,
      batch: nested.outcome ? this._summarizeBatch(nested) : (inner.batch || null),
    };
    if (dryRun) out.dryRun = true;
    if (inner.chengfang) out.chengfang = inner.chengfang;
    if (inner.targetCount != null) out.targetCount = inner.targetCount;
    if (s.blocked) out.blocked = s.blocked;
    if (s.inflight) out.inflight = s.inflight;
    if (s.persistence) out.persistence = s.persistence;
    if (action === 'enable') out.enable = { outcome, serial: s.serial };
    if (extra) for (const [k, v] of Object.entries(extra)) { if (v !== undefined) out[k] = v; }
    return out;
  }

  /**
   * 把 monitor 路径返回值归一为编排器可收口的批次形状。
   * **缺失的 confirmed 布尔不得写成 false**（不得作为否定证据）；仅显式 true 时写入。
   */
  _normalizeExecuteResult(r, action) {
    const inner = (r && (r.batch || r.chengfang)) || {};
    const outcome = inner.outcome
      || (r && r.outcome)
      || (r && r.dryRun ? (inner.outcome || 'dry') : null)
      || (r && r.status) || 'unknown';
    const neverSent =
      (r && r.dryRun === true) ||
      (r && (r.status === 'blocked' || r.status === 'window_blocked' || r.status === 'stopped')) ||
      outcome === 'blocked' || outcome === 'blocked_window' || outcome === 'blocked_stopped' ||
      outcome === 'blocked_coverage' ||
      outcome === 'cancelled' || outcome === 'dry' || outcome === 'dry_failed';
    const out = {
      ...r,
      actionType: action,
      outcome,
      neverSent,
      dryRun: !!(r && r.dryRun),
      reason: (r && r.reason) || inner.reason || inner.confirmReason || null,
      confirmReason: inner.confirmReason || (r && r.batch && r.batch.confirmReason) || null,
      batch: r && r.batch ? r.batch : inner,
    };
    // 仅显式 true 写入；缺失/undefined 不得变成 false
    if (inner.allPausedConfirmed === true || (r && r.batch && r.batch.allPausedConfirmed === true) || (r && r.allPausedConfirmed === true)) {
      out.allPausedConfirmed = true;
    }
    if (inner.allEnabledConfirmed === true || (r && r.batch && r.batch.allEnabledConfirmed === true) || (r && r.allEnabledConfirmed === true)) {
      out.allEnabledConfirmed = true;
    }
    if (inner.allClosedConfirmed === true || (r && r.batch && r.batch.allClosedConfirmed === true) || (r && r.allClosedConfirmed === true)) {
      out.allClosedConfirmed = true;
    }
    return out;
  }

  /**
   * 低于阈值 / 每日开启共用的执行入口（复用 ChengfangRunner，不复制 Playwright）。
   * 返回形状与 runner 批次兼容，供编排器收口。
   */
  async _executeEnableBatchFor(shopCfg, cycleToken, { reason, triggerLabel, enableSource = 'daily_schedule' } = {}) {
    const runner = this._getChengfangRunner(shopCfg);
    const opener = this._chengfangOpener || defaultChengfangOpener;
    const loginCfg = this.config.login;
    try {
      if (!this.realMode) {
        const res = await runner.runDryEnableCycle({ shopCfg, pageOpener: opener, loginCfg, enableSource });
        return { ...res, neverSent: true, dryRun: true, triggerLabel, enableSource, reason: reason || res.reason };
      }
      this.schedule.lastWindowBlockReason = null;
      const batch = await runner.executeChengfangEnableBatch({
        shopCfg,
        cycleToken,
        trigger: { reason: reason || triggerLabel || 'enable' },
        pageOpener: opener,
        loginCfg,
        enableSource,
      });
      // 落库唯一入口在调用方 _commitExecutedBatch（此处不写 actions/batch，避免双写）
      return { ...batch, triggerLabel, enableSource };
    } catch (e) {
      const reason = `乘方开启批次异常：${e.reason || e.message}`;
      this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason }, undefined, 'error');
      this._audit({ kind: 'action', shopId: shopCfg.id, status: 'unknown', reason });
      // 异常可能已发出 → 交给编排器 markUnknown（不在此处 markNotSent）
      return { outcome: 'partial', reason, error: e, actionType: 'enable', counts: { confirmed: 0, failed: 0, unknown: 1, skipped: 0, cancelled: 0 } };
    }
  }

  // ── 单店铺轮询 ───────────────────────────────────────────────────
  async _pollShop(shopCfg, cycleToken, trigger) {
    const rt = this._runtime(shopCfg.id);
    try {
      // 1) 登录态静态核验（Cookie 文件存在/结构/有效期）
      const cookieMeta = loadShopCookieMeta(this.config.login, shopCfg);
      rt.cookieCheckedAt = new Date(this.nowFn()).toISOString();
      rt.cookieMeta = { count: cookieMeta.count, readOnly: cookieMeta.readOnly, maxExpires: cookieMeta.maxExpires };

      // 2) 读取+核验费用/订单并评估规则（含零订单重读核实）
      const coord = this._getCoordinator(shopCfg);
      let data;
      try {
        data = await coord.readAndEvaluate(shopCfg);
      } catch (e) {
        if (e instanceof NotConnectedError) {
          rt.lastError = '推广数据读取尚未接入（等待用户提供推广页面）';
          this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: rt.lastError }, undefined, 'error');
          this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason: rt.lastError });
          return { status: 'blocked', reason: rt.lastError };
        }
        throw e;
      }
      rt.lastError = null;
      rt.lastData = this._summarizeData(data);

      if (data.ok === false) {
        rt.lastData.blockedReason = data.reason;
        this._emitJudgement(shopCfg, { data, over: null, status: 'blocked', reason: data.reason });
        this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason: data.reason, blocked: data.blocked });
        return { status: 'blocked', reason: data.reason, blocked: data.blocked };
      }

      // 3) 门禁优先：有效控制路径/范围（already_* 不得把门禁失败包成 ok）
      if (!this._chengfangScopeConfigured() && !this._legacyWholeShopAllowed()) {
        const scopeBlockedReason = '未配置乘方控制范围（monitor.chengfang.scope）且未显式开启历史全店路径：监控不执行任何关闭';
        rt.lastData.blockedReason = scopeBlockedReason;
        this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: scopeBlockedReason }, undefined, 'error');
        this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason: scopeBlockedReason });
        return { status: 'blocked', reason: scopeBlockedReason };
      }

      // 4) 执行时间窗口（超标=暂停意图）：窗口外不打开执行会话，直接 window_blocked
      if (data.evaluation.over === true && !isAfterDailyStart(this.nowFn(), this.config.schedule.dailyStartHour)) {
        const hh = String(this.config.schedule.dailyStartHour).padStart(2, '0');
        const reason = `未到允许执行时段（每日 ${hh}:00 后，Asia/Shanghai）：已读取并记录，未执行真实关闭（手动检查不绕过时间限制）`;
        this.schedule.lastWindowBlockReason = reason;
        this._memPush(this.triggers, {
          shopId: shopCfg.id, mode: 'real', targetAction: 'pause', blocked: 'window', reason,
          targetCount: 0,
        }, undefined, 'trigger');
        this._audit({ kind: 'trigger', shopId: shopCfg.id, mode: 'real', targetAction: 'pause', blocked: 'window', reason });
        this._emitJudgement(shopCfg, { data, over: true, status: 'window_blocked', reason });
        return { status: 'window_blocked', reason };
      }

      // 5) 本轮回读 currentAdState（清单身份/完整性失败 → blocked，不得包成 ok）
      const stateRead = await this._readCurrentAdState(shopCfg);
      this._applyBalanceToLastData(rt, stateRead);
      if (stateRead.error) {
        const err = stateRead.error;
        rt.lastData.blockedReason = err.reason;
        // 失败/unknown：只读观测，不得伪称动作确认；旧确认时间随观测失效
        this._applyObservedAdState(shopCfg.id, 'unknown', `只读回读失败：${err.reason || 'unknown'}`);
        this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: err.reason }, undefined, 'error');
        this._emitJudgement(shopCfg, { data, over: data.evaluation.over === true, status: 'blocked', reason: err.reason, currentAdState: stateRead.state });
        this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason: err.reason, blocked: err.blocked, zeroClick: true });
        // 状态回读失败发生在任何开关之前：blocked + 原因 + zeroClick；不伪造成 already_* / 成功
        return {
          status: 'blocked',
          reason: err.reason,
          blocked: err.blocked || 'ad_state_read',
          zeroClick: true,
          decision: DECISION.UNKNOWN_BLOCKED,
          currentAdState: stateRead.state || 'unknown',
        };
      }
      const currentAdState = stateRead.state;
      this._applyObservedAdState(shopCfg.id, currentAdState, '只读清单/页面回读');
      rt.lastDataAt = new Date(this.nowFn()).toISOString();
      const thresholdCents = this._thresholdCents(shopCfg);
      const decision = this._switchOrchestrator.evaluatePeriodic({
        costCents: data.cost.valueCents,
        orders: data.orders.valueCount,
        thresholdCents,
        currentAdState,
        identityOk: true,
      });

      // 每周期一条判断
      this._emitJudgement(shopCfg, {
        data,
        over: data.evaluation.over === true,
        status: 'ok',
        reason: decision.reason || data.evaluation.reason,
        decision,
        currentAdState,
      });

      // 6) 决策分流：should_* 进入动作；超标 + already_off 走暂停只读盘点（nothing_to_close）
      if (decision.decision === DECISION.SHOULD_PAUSE) {
        return this._runShopSwitchAction(shopCfg, 'pause', data, cycleToken, trigger);
      }
      if (decision.decision === DECISION.ALREADY_OFF && data.evaluation.over === true) {
        return this._runShopSwitchAction(shopCfg, 'pause', data, cycleToken, trigger, { allowAlreadyOffPause: true });
      }
      if (decision.decision === DECISION.SHOULD_ENABLE) {
        return this._runShopSwitchAction(shopCfg, 'enable', data, cycleToken, trigger);
      }
      this._audit({
        kind: 'poll',
        shopId: shopCfg.id,
        status: 'ok',
        over: false,
        decision: decision.decision,
        currentAdState,
        zeroClick: true,
        reason: decision.reason,
      });
      return {
        status: 'ok',
        over: false,
        zeroClick: true,
        decision: decision.decision,
        metric: decision.metric,
        currentAdState,
        reason: decision.reason,
      };
    } catch (e) {
      const reason = e.reason || e.message;
      rt.lastError = reason;
      this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason, code: e.code || null }, undefined, 'error');
      this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'stopped', reason, code: e.code || null });
      log.warn(`店铺 ${shopCfg.id} 本轮停止: ${reason}`);
      return { status: 'stopped', reason, code: e.code || null };
    }
  }

  /**
   * 乘方主链路：超标 → ChengfangRunner。
   * - 演练（realMode=false）：只枚举将暂停目标，零业务点击（executor 由配置门槛自动转演练）。
   * - 真实（realMode=true）：runner 内部做集中门槛 → 操作前费用/订单重读 → 乘方全店托管+商品自选
   *   → 全量回读，逐请求检查停止/时段/跨日；只控制乘方，绝不进入历史全店路径。
   * 窗口未开放/门槛不通过 → 零请求，且不打开乘方页面。
   */
  async _pollChengfangOver(shopCfg, data, cycleToken, trigger) {
    const rt = this._runtime(shopCfg.id);
    const runner = this._getChengfangRunner(shopCfg);
    const opener = this._chengfangOpener || defaultChengfangOpener;
    const loginCfg = this.config.login;

    if (!this.realMode) {
      let res;
      try {
        res = await runner.runDryCycle({ shopCfg, pageOpener: opener, loginCfg });
      } catch (e) {
        const reason = `乘方演练周期失败：${e.reason || e.message}`;
        rt.lastError = reason;
        this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason }, undefined, 'error');
        this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'stopped', reason });
        return { status: 'stopped', reason };
      }
      if (res.outcome === 'dry_failed') {
        const reason = res.error || res.reason || '乘方演练未完成（身份/读取/分页/选择范围失败）';
        rt.lastError = reason;
        this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: `乘方演练失败：${reason}` }, undefined, 'error');
        this._memPush(this.triggers, {
          shopId: shopCfg.id, mode: 'dry', targetAction: 'pause', failed: true, reason,
          businessDate: data.cost.businessDate,
          costText: `${centsToYuan(data.cost.valueCents)} 元`,
          orders: data.orders.valueCount,
          targetCount: 0, targets: [],
          dryOutcome: 'dry_failed',
          note: `演练未完成（失败），不计为"正常枚举"：${reason}`,
        }, undefined, 'trigger');
        this._audit({ kind: 'trigger', shopId: shopCfg.id, mode: 'dry', failed: true, reason });
        return { status: 'ok', over: true, dryRun: true, targetCount: 0, chengfang: { outcome: 'dry_failed', error: reason } };
      }
      const triggerRec = {
        shopId: shopCfg.id, mode: 'dry', targetAction: 'pause',
        scope: '乘方(全店托管+商品自选)',
        reason: data.evaluation.reason,
        businessDate: data.cost.businessDate,
        costText: `${centsToYuan(data.cost.valueCents)} 元`,
        orders: data.orders.valueCount,
        perOrderText: perOrderDisplayText(data.cost.valueCents, data.orders.valueCount),
        targetCount: (res.targets || []).length,
        targets: res.targets,
        dryOutcome: res.outcome,
        note: res.error
          ? `演练模式：命中乘方超额条件，但演练未完成（${res.error}）`
          : '演练模式：命中乘方超额条件，以下为将暂停的乘方目标（未点击任何开关/暂停/删除）',
      };
      this._memPush(this.triggers, triggerRec, undefined, 'trigger');
      this._audit({ kind: 'trigger', ...triggerRec, targets: (res.targets || []).map((t) => t.planId || t.adId) });
      return { status: 'ok', over: true, dryRun: true, targetCount: (res.targets || []).length, chengfang: { outcome: res.outcome, error: res.error } };
    }

    this.schedule.lastWindowBlockReason = null;
    const batch = await runner.executeChengfangBatch({
      shopCfg,
      cycleToken,
      trigger: { reason: data.evaluation.reason },
      pageOpener: opener,
      loginCfg,
    });
    if (batch.outcome === 'blocked_window') {
      this.schedule.lastWindowBlockReason = batch.reason;
      // 真实 trigger 也必须带显式动作标签（值守侧 describeTrigger 只认 targetAction，不猜）
      this._memPush(this.triggers, { shopId: shopCfg.id, mode: 'real', targetAction: 'pause', blocked: 'window', reason: batch.reason, targetCount: 0 }, undefined, 'trigger');
      this._audit({ kind: 'trigger', shopId: shopCfg.id, mode: 'real', targetAction: 'pause', blocked: 'window', reason: batch.reason });
      return { status: 'window_blocked', reason: batch.reason };
    }
    if (batch.outcome === 'blocked_stopped') {
      const reason = batch.reason || '监控已停止，未发出乘方暂停请求';
      this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'stopped', reason });
      return { status: 'stopped', reason };
    }
    if (batch.outcome === 'blocked') {
      const reason = batch.reason || '乘方执行被门槛阻止，未发出任何请求';
      rt.lastData.blockedReason = reason;
      this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason }, undefined, 'error');
      this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason });
      return { status: 'blocked', reason, batch: this._summarizeBatch(batch) };
    }
    // cancelled / nothing_to_pause / all_paused_confirmed / partial → 记录批次
    // 第 4 项：显式声明动作类型，下游禁止从 outcome 推断
    batch.actionType = batch.actionType || 'pause';
    this._recordBatch(shopCfg.id, batch);
    this._memPush(this.actions, { shopId: shopCfg.id, ...this._summarizeBatch(batch) }, undefined, 'batch');
    this._audit({ kind: 'action', shopId: shopCfg.id, ...this._summarizeBatch(batch) });
    return { status: 'ok', over: true, batch: this._summarizeBatch(batch) };
  }

  // ── 每日自动开启相位（07:00 窗口，每天一次；独立于费用/订单阈值）────

  /** 每日开启相位：遍历启用的店铺执行开启（真实=executeChengfangEnableBatch；演练=runDryEnableCycle）。 */
  async _runEnablePhase(gen, businessDate = null, { scope = 'scheduler' } = {}) {
    // 互斥：暂停巡查或其他周期进行中 → 绝不并发开启（同一店铺执行互斥），调用方稍后重试
    if (this._cycleRunning) {
      return { skipped: true, reason: '已有周期进行中（暂停/开启互斥），本轮开启相位跳过' };
    }
    // scope='scheduler'：独立每日开启调度器驱动（默认）。生命周期只随 _enableGen/
    // enableRunning 终止，令牌 kind='enable'——"停止值守"绝不取消每日开启。
    // scope='pause'：值守循环的历史回退路径（未启用独立调度器时，开启窗口由值守循环
    // 驱动）；随 this.running/_gen 终止，令牌 kind='pause'（停止值守一并中止）。
    const schedScope = scope !== 'pause';
    const token = { aborted: false, kind: schedScope ? 'enable' : 'pause' };
    this._activeTokens.add(token);
    this._cycleRunning = true;
    const today = businessDate || shanghaiDate(this.nowFn());
    try {
      for (const shopCfg of this._activeShops()) {
        if (schedScope) {
          if (gen !== this._enableGen || !this.enableRunning) break;
        } else if (gen !== this._gen || !this.running) {
          break;
        }
        if (token.aborted) break;
        // 删除后调度器再次检查活动列表
        if (!this._isShopActive(shopCfg.id)) continue;
        if (this._enablePhaseDone(shopCfg.id, today)) continue;
        await this._runShopEnablePhase(shopCfg, token, today);
      }
    } finally {
      this._activeTokens.delete(token);
      this._cycleRunning = false;
    }
    return { skipped: false };
  }

  /**
   * 手动验证每日开启（2026-09-29 第 10 阶段）：对单个已启用店铺，任意时刻触发**同一套**
   * 每日开启预检与决策链（_runShopEnablePhase，source='manual_verify'）——同一真实回读
   * （v3 有界）、身份核验、串行门、当日去重、审计与 fail-closed 规则，不另造旁路。
   * 边界：异步执行（HTTP 不悬挂），状态经 getManualEnableVerifyStatus() 可回读；
   * 与巡查/自动开启共用 _cycleRunning 互斥（在途即拒绝，不等待）；当日已 success 去重拒绝；
   * 不改写自动排程（_enableSchedule 的 nextRunAt 不由手动路径设置）。
   */
  runManualEnableVerify(shopId) {
    const shopCfg = (this.config.shops || []).find((s) => s && s.id === shopId);
    if (!shopCfg || !this._isShopActive(shopId)) {
      return { ok: false, error: `店铺不存在或未启用：${String(shopId)}`, code: 'shop_not_active' };
    }
    if (this._manualVerify && this._manualVerify.status === 'running') {
      return { ok: false, error: '已有手动验证进行中，请稍后（可经状态接口回读进度）', code: 'manual_busy' };
    }
    if (this._cycleRunning) {
      return { ok: false, error: '已有巡查/开启周期进行中（互斥），本轮拒绝手动验证', code: 'cycle_busy' };
    }
    const today = shanghaiDate(this.nowFn());
    if (this._enablePhaseDone(shopId, today)) {
      return { ok: false, error: `该店 ${today} 每日开启已成功（当日去重，不再重复执行）`, code: 'already_done_today', alreadyDone: true };
    }
    const startedAt = new Date(this.nowFn()).toISOString();
    this._manualVerify = { shopId, status: 'running', startedAt, finishedAt: null, result: null };
    const token = { aborted: false, kind: 'enable' };
    this._activeTokens.add(token);
    this._cycleRunning = true;
    this._audit({ kind: 'enable-phase', shopId, event: 'manual-verify-start', trigger: 'manual_verify', businessDate: today });
    (async () => {
      try {
        const r = await this._runShopEnablePhase(shopCfg, token, today, 'manual_verify');
        this._manualVerify = {
          shopId, status: 'done', startedAt, finishedAt: new Date(this.nowFn()).toISOString(),
          result: { status: r.status || null, skipped: r.skipped === true, zeroClick: r.zeroClick === true, decision: r.decision || null, currentAdState: r.currentAdState || null, reason: r.reason || null },
        };
        this._audit({ kind: 'enable-phase', shopId, event: 'manual-verify-done', trigger: 'manual_verify', businessDate: today, outcome: r.status || null, decision: r.decision || null, currentAdState: r.currentAdState || null, zeroClick: r.zeroClick === true, reason: r.reason || null });
      } catch (e) {
        this._manualVerify = { shopId, status: 'failed', startedAt, finishedAt: new Date(this.nowFn()).toISOString(), result: { error: String((e && (e.reason || e.message)) || e).slice(0, 200) } };
        this._audit({ kind: 'enable-phase', shopId, event: 'manual-verify-failed', trigger: 'manual_verify', businessDate: today, reason: String((e && (e.reason || e.message)) || e).slice(0, 200) });
      } finally {
        this._activeTokens.delete(token);
        this._cycleRunning = false;
      }
    })();
    return { ok: true, started: true, manualVerify: { ...this._manualVerify } };
  }

  /** 手动验证状态回读（供 watch-drill 状态接口透出；不改任何状态）。 */
  getManualEnableVerifyStatus() {
    return this._manualVerify ? { ...this._manualVerify } : null;
  }

  /**
   * 单店铺开启相位：
   * - 演练（realMode=false）：只枚举将开启目标，零业务点击（executor 由配置门槛自动转演练）。
   * - 真实（realMode=true）：runner 内部做集中门槛（realMode+enableEnabled）→ 开启窗口 → 停止
   *   → 乘方全店托管+商品自选 → 全量回读；逐请求检查停止/时段/跨日。
   * 窗口未开放/门槛不通过 → 零请求，且不打开乘方页面。
   * source（2026-09-29 第 10 阶段）：'daily_schedule'（自动定时，默认）|'manual_verify'（人工按需验证）。
   * 手动验证走同一回读/身份/串行门/去重/审计链，仅 trigger 标记与 gate 时段门槛不同（见 chengfang-gate）。
   */
  async _runShopEnablePhase(shopCfg, cycleToken, businessDate = null, source = 'daily_schedule') {
    const rt = this._runtime(shopCfg.id);
    const runner = this._getChengfangRunner(shopCfg);
    const opener = this._chengfangOpener || defaultChengfangOpener;
    const loginCfg = this.config.login;
    const enableHour = this._enableHour();
    const today = businessDate || shanghaiDate(this.nowFn());

    // 决策层：当前状态只来自本轮回读（adBelief 仅审计，不得代替回读、不得直接触发点击）
    const stateRead0 = await this._readCurrentAdState(shopCfg);
    const currentAdState = stateRead0.state;
    // unknown 槽位核验释放（2026-09-29 第 6 阶段）：每日开启相位复用**同一份**本轮回读做核验
    // （不重开页面、零额外点击）。释放条件要求回读状态=旧动作目标态，因此释放成功时
    // currentAdState 即目标态，后续决策自然进入正常路径（如 pause 槽位被全量 off 释放 →
    // off → should_enable 正常执行）；释放不成功则槽位继续阻断（runSwitchAction 由串行门拒绝）。
    await this._tryResolveUnknownSlotWithFreshRead(shopCfg, stateRead0);
    // 每日开启沿用店铺配置检查；自动发现店不因缺少账户号被拦截。
    const dailyIdState = this._shopIdentityState(shopCfg);
    const dailyIdentityOk = !dailyIdState.pending;
    const dailyIdentityNote = dailyIdState.reason;
    const dailyDecision = this._switchOrchestrator.evaluateDailyEnable({
      currentAdState,
      identityOk: dailyIdentityOk,
      identityReason: dailyIdentityNote,
    });
    const belief = (this.adBelief || {})[shopCfg.id];
    this._audit({
      kind: 'enable-phase',
      shopId: shopCfg.id,
      event: 'daily-decide',
      trigger: source,
      currentAdState,
      decision: dailyDecision.decision,
      beliefOn: belief ? belief.on === true : null,
      // 区分两类 unknown（2026-09-29 08:00 事件）：readError=带 error 的读取失败；readNote=清单完成但开关不可识别（无 error）
      readError: stateRead0.error ? { status: stateRead0.error.status || null, blocked: stateRead0.error.blocked || null, reason: String(stateRead0.error.reason || '').slice(0, 200), timeout: stateRead0.error.timeout === true ? true : undefined } : null,
      readNote: stateRead0.switchEvidence || null,
    });

    if (dailyDecision.zeroClick) {
      const reason = dailyDecision.reason;
      // already_on（本轮回读已开启）→ 登记 success；unknown/身份失败 → 不占用成功
      const phaseStatus = dailyDecision.decision === DECISION.ALREADY_ON ? 'success' : 'failed';
      this._setEnablePhase(shopCfg.id, today, phaseStatus, {
        phase: 'precheck',
        reason,
        currentAdState,
        decision: dailyDecision.decision,
      });
      this._audit({ kind: 'enable-phase', shopId: shopCfg.id, event: 'skipped-zero-click', trigger: source, note: reason, currentAdState, decision: dailyDecision.decision, beliefAt: belief && belief.at, readError: stateRead0.error ? { status: stateRead0.error.status || null, blocked: stateRead0.error.blocked || null, reason: String(stateRead0.error.reason || '').slice(0, 200), timeout: stateRead0.error.timeout === true ? true : undefined } : null, readNote: stateRead0.switchEvidence || null });
      try { log.info(`每日开启跳过（${shopCfg.id}）：${reason}`); } catch (_) { /* 日志失败不影响 */ }
      return { status: 'ok', skipped: true, zeroClick: true, decision: dailyDecision.decision, currentAdState, reason };
    }

    // 第 3 项：执行前记录 in_progress（区分"执行中"），成功/失败/未知分别落状态。
    // 重启时 in_progress → unknown（见 _reconcileEnablePhaseOnBoot），不会重复开启。
    const prevRec = this.getEnablePhaseRecord(shopCfg.id, today);
    const prevNote = (prevRec && prevRec.status === 'unknown')
      ? `上次为 unknown（${prevRec.reason || '结果未确认'}），本轮先按真实状态回读处理，不盲重发` : null;
    this._setEnablePhase(shopCfg.id, today, 'in_progress', {
      phase: this.realMode ? 'execute' : 'dry',
      enableHour,
      prevNote,
    });
    if (prevNote) {
      this._audit({ kind: 'enable-phase', shopId: shopCfg.id, event: 'reconcile', note: prevNote });
    }

    // 决策 + 串行门 + 复用 runner/executor
    const settled = await this._switchOrchestrator.runSwitchAction({
      shopId: shopCfg.id,
      action: 'enable',
      targetState: 'on',
      persistBeforeRelease: () => this._saveState(),
      readState: async () => {
        const r = await this._readCurrentAdState(shopCfg);
        return r.state;
      },
      decide: (st) => this._switchOrchestrator.evaluateDailyEnable({
        currentAdState: st,
        identityOk: dailyIdentityOk,
        identityReason: dailyIdentityNote,
      }),
      execute: async () => {
        const pre = this._persistBeforeDispatch(shopCfg.id, 'enable', null);
        if (!pre.ok) {
          return { outcome: 'persistence_blocked', neverSent: true, reason: pre.reason, counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 } };
        }
        return this._executeEnableBatchFor(shopCfg, cycleToken, {
          reason: source === 'manual_verify' ? '手动验证触发（人工按需）' : `每日 ${enableHour}:00 自动开启`,
          triggerLabel: source === 'manual_verify' ? 'manual_verify' : 'daily_enable',
          businessDate: today,
          enableSource: source,
        });
      },
    });

    // 串行门拒绝先于普通 zeroClick（避免误报 already_on/成功）
    if (settled.blocked === 'serial_gate') {
      this._setEnablePhase(shopCfg.id, today, 'unknown', {
        phase: 'execute', reason: settled.reason, blocked: 'serial_gate', actionId: null,
      });
      return this._mapSwitchReturn({ action: 'enable', settled, extra: { status: 'blocked' } });
    }
    // 纯决策跳过（未登记 actionId、无执行结果）
    if (settled.zeroClick && !settled.actionId && !settled.batch) {
      const phaseStatus = settled.decision === DECISION.ALREADY_ON ? 'success' : 'failed';
      this._setEnablePhase(shopCfg.id, today, phaseStatus, {
        phase: 'precheck', reason: settled.reason, decision: settled.decision,
      });
      return this._mapSwitchReturn({ action: 'enable', settled, extra: { skipped: true } });
    }

    const batch = settled.batch || {};
    if (batch.dryRun === true || settled.outcome === 'dry' || settled.outcome === 'dry_failed') {
      const failed = settled.outcome === 'dry_failed';
      const reason = batch.error || batch.reason || settled.reason || null;
      if (failed) {
        this._setEnablePhase(shopCfg.id, today, 'failed', { phase: 'dry', reason });
        this._memPush(this.triggers, {
          shopId: shopCfg.id, mode: 'dry', targetAction: 'enable', failed: true, reason,
          businessDate: today, targetCount: 0, targets: [], dryOutcome: 'dry_failed',
          note: `每日开启相位演练未完成（失败），不计为"正常枚举"：${reason}`,
        }, undefined, 'trigger');
        this._audit({ kind: 'trigger', shopId: shopCfg.id, mode: 'dry', failed: true, reason });
        return this._mapSwitchReturn({
          action: 'enable', settled,
          extra: { dryRun: true, targetCount: 0, enable: { outcome: 'dry_failed', error: reason } },
        });
      }
      const targetCount = (batch.targets || []).length;
      this._memPush(this.triggers, {
        shopId: shopCfg.id, mode: 'dry', targetAction: 'enable',
        scope: '乘方(全店托管+商品自选)',
        reason: `每日 ${enableHour}:00 自动开启相位`, businessDate: today,
        targetCount, targets: batch.targets, dryOutcome: settled.outcome || 'dry',
        note: '演练模式：每日开启相位将开启以下乘方目标（未点击任何开关/开启/删除）',
      }, undefined, 'trigger');
      this._audit({ kind: 'trigger', shopId: shopCfg.id, mode: 'dry', targetAction: 'enable', targetCount });
      this._setEnablePhase(shopCfg.id, today, 'dry_done', { phase: 'dry', reason: null, targetCount });
      return this._mapSwitchReturn({
        action: 'enable', settled,
        extra: { dryRun: true, targetCount, enable: { outcome: settled.outcome || 'dry' } },
      });
    }

    this._commitExecutedBatch(shopCfg.id, batch);

    if (settled.serial === 'not_sent' && (settled.outcome === 'blocked' || settled.outcome === 'blocked_window' || settled.outcome === 'blocked_stopped')) {
      this._setEnablePhase(shopCfg.id, today, 'failed', {
        phase: 'execute', reason: settled.reason, blocked: settled.outcome,
      });
      if (settled.reason) {
        this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: settled.reason }, undefined, 'error');
      }
      if (settled.outcome === 'blocked_window') {
        this.schedule.lastWindowBlockReason = settled.reason;
        this._memPush(this.triggers, { shopId: shopCfg.id, mode: 'real', targetAction: 'enable', blocked: 'window', reason: settled.reason, targetCount: 0 }, undefined, 'trigger');
      }
      return this._mapSwitchReturn({ action: 'enable', settled });
    }

    const okStatus = settled.serial === 'confirmed' ? 'success' : 'unknown';
    this._setEnablePhase(shopCfg.id, today, okStatus, {
      phase: 'execute', outcome: settled.outcome, serial: settled.serial,
      allEnabledConfirmed: settled.serial === 'confirmed', actionId: settled.actionId,
      reason: settled.reason || null,
    });
    return this._mapSwitchReturn({ action: 'enable', settled });
  }

  /**
   * 历史全店关闭路径（旧覆盖表/协调器流程）。仅在测试显式开启
   * monitor.legacyWholeShopCloseEnabled=true 时可达；生产配置不设置该开关，
   * 确保自动监控绝不进入其他产品覆盖流程。
   */
  async _pollLegacyWholeShopOver(shopCfg, data, cycleToken) {
    const rt = this._runtime(shopCfg.id);
    const coord = this._getCoordinator(shopCfg);
    let inventory;
    try {
      inventory = await coord.listAllAds(shopCfg);
    } catch (e) {
      const reason = `广告清单读取失败：${e.reason || e.message}`;
      rt.lastData.blockedReason = reason;
      this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason }, undefined, 'error');
      this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason });
      return { status: 'blocked', reason };
    }
    const activeTargets = inventory.ads.filter((a) => guard.closableSideOfAd(a) === 'closable');
    const sideUnknown = inventory.ads.filter((a) => guard.closableSideOfAd(a) === 'unknown').length;
    const coverageGaps = inventory.coverageGaps || [];

    // 演练：记录"会关闭哪些广告"；真实：窗口门槛 + 协调器执行
    if (!this.realMode) {
      const gapNotes = [
        ...coverageGaps.map((g) => g.reason),
        ...(sideUnknown > 0 ? [`${sideUnknown} 个广告开关/状态侧别未知`] : []),
      ];
      const triggerRec = {
        shopId: shopCfg.id, mode: 'dry',
        // 与本路径批次的 actionType 词汇一致（legacy 关闭批次默认 actionType='pause'）
        targetAction: 'pause',
        reason: data.evaluation.reason,
        businessDate: data.cost.businessDate,
        costText: `${centsToYuan(data.cost.valueCents)} 元`,
        orders: data.orders.valueCount,
        perOrderText: perOrderDisplayText(data.cost.valueCents, data.orders.valueCount),
        targetCount: activeTargets.length,
        targets: activeTargets.map((a) => ({ adId: a.adId, name: a.name, adType: a.adType || null, status: a.status, switchChecked: a.switchChecked !== undefined ? a.switchChecked : null })),
        inventoryPages: inventory.pages,
        coverageGaps,
        sideUnknownCount: sideUnknown,
        coverageNote: gapNotes.length
          ? `覆盖缺口（阻止"全店"结论）：${gapNotes.join('；')}`
          : '已配置投放类型均完整读取，无覆盖缺口',
        note: gapNotes.length
          ? '演练模式：命中超额条件；但存在覆盖缺口——真实执行将被阻止，不得宣称全店可关闭'
          : '演练模式：命中全店超额条件，真实执行时将关闭以下全部投放侧广告',
      };
      this._memPush(this.triggers, triggerRec, undefined, 'trigger');
      this._audit({ kind: 'trigger', ...triggerRec, targets: triggerRec.targets.map((t) => t.adId) });
      return { status: 'ok', over: true, dryRun: true, targetCount: activeTargets.length, coverageGaps, sideUnknown };
    }

    // 真实模式：手动/定时一视同仁，受时间窗口限制
    if (!isAfterDailyStart(this.nowFn(), this.config.schedule.dailyStartHour)) {
      const hh = String(this.config.schedule.dailyStartHour).padStart(2, '0');
      const reason = `未到允许执行时段（每日 ${hh}:00 后，Asia/Shanghai）：已读取并记录，未执行真实关闭（手动检查不绕过时间限制）`;
      this.schedule.lastWindowBlockReason = reason;
      this._memPush(this.triggers, { shopId: shopCfg.id, mode: 'real', targetAction: 'pause', blocked: 'window', reason, targetCount: activeTargets.length }, undefined, 'trigger');
      this._audit({ kind: 'trigger', shopId: shopCfg.id, mode: 'real', targetAction: 'pause', blocked: 'window', reason });
      return { status: 'window_blocked', reason };
    }
    this.schedule.lastWindowBlockReason = null;

    const todayStatus = new Map(); // 批次内结果累积（跨批次状态以最新清单读取为准）
    const batch = await coord.executeWholeShopCloseBatch({ shopCfg, cycleToken, todayStatus, trigger: { reason: data.evaluation.reason } });
    batch.actionType = batch.actionType || 'pause';
    this._recordBatch(shopCfg.id, batch);
    this._memPush(this.actions, { shopId: shopCfg.id, ...this._summarizeBatch(batch) }, undefined, 'batch');
    this._audit({ kind: 'action', shopId: shopCfg.id, ...this._summarizeBatch(batch) });
    return { status: 'ok', over: true, batch: this._summarizeBatch(batch) };
  }

  _summarizeData(data) {
    if (data.ok === false) {
      return {
        businessDate: data.cost && data.cost.businessDate,
        costCents: data.cost && data.cost.valueCents,
        costText: data.cost && data.cost.valueCents !== undefined && data.cost.valueCents !== null ? `${centsToYuan(data.cost.valueCents)} 元` : null,
        rawCostText: data.cost && data.cost.rawText,
        orders: data.orders && data.orders.valueCount,
        source: (data.cost && data.cost.source) || null,
        fetchedAt: data.cost && data.cost.fetchedAt,
        pageUpdatedAt: (data.cost && data.cost.pageUpdatedAt) || (data.orders && data.orders.pageUpdatedAt) || null,
        perOrderText: '—',
        over: false,
      };
    }
    return {
      businessDate: data.cost.businessDate,
      costCents: data.cost.valueCents,
      costText: `${centsToYuan(data.cost.valueCents)} 元`,
      rawCostText: data.cost.rawText,
      orders: data.orders.valueCount,
      source: data.cost.source,
      fetchedAt: data.cost.fetchedAt,
      pageUpdatedAt: data.cost.pageUpdatedAt || data.orders.pageUpdatedAt || null,
      perOrderText: perOrderDisplayText(data.cost.valueCents, data.orders.valueCount),
      over: data.evaluation.over,
    };
  }

  /**
   * 批次结果归一化（供 actions 事件流使用）。
   *
   * 2026-09-15 修复第 4 项：显式携带 `actionType`（'pause' | 'enable'），
   * **禁止下游用 `outcome` 字符串推断动作**（旧实现用 `/enable/i.test(outcome)`
   * 判断，导致 `nothing_to_enable`/`blocked_window`（开启窗口未到）等被误判为暂停）。
   *
   * 判定顺序（fail-closed，宁可标 unknown 也不猜）：
   *   1) 批次自带 `actionType`（runner 显式声明，最可信）；
   *   2) 否则用"专属字段"反推：allEnabledConfirmed/allPausedConfirmed 存在时成立；
   *   3) 否则查 `_actionTypes` 登记表（runDryCycle/runDryEnableCycle 的调用方登记）；
   *   4) 都拿不到 → `actionType: 'unknown'`（下游按"未识别"保守处理）。
   */
  _summarizeBatch(batch) {
    const allConfirmed = batch.allClosedConfirmed === true || batch.allPausedConfirmed === true;
    let actionType = batch.actionType || batch.action || null;
    if (!actionType) {
      if (batch.allEnabledConfirmed !== undefined || batch.dryEnableRun === true) actionType = 'enable';
      else if (batch.allPausedConfirmed !== undefined || batch.dryRun === true) actionType = 'pause';
      else if (batch.actionTypeHint) actionType = batch.actionTypeHint;
      else actionType = 'unknown';
    }
    return {
      actionType,
      action: actionType,
      outcome: batch.outcome,
      reason: batch.reason || null,
      counts: batch.counts,
      targets: batch.targets,
      inventoryPages: batch.inventoryPages,
      allClosedConfirmed: allConfirmed,
      allPausedConfirmed: batch.allPausedConfirmed === true,
      allEnabledConfirmed: batch.allEnabledConfirmed === true,
      confirmReason: batch.confirmReason || null,
      finalInventoryPages: batch.finalInventoryPages !== undefined ? batch.finalInventoryPages : null,
      remaining: batch.remaining || null,
      batchDate: batch.batchDate || null,
      error: batch.error ? (batch.error.message || String(batch.error)) : null,
      details: batch.details || null,
    };
  }

  /** 批次结果按 店铺+业务日期 合并进持久化状态（修复 Codex 问题 #4 的日期维度）。 */
  _recordBatch(shopId, batch) {
    const date = batch.batchDate || shanghaiDate(this.nowFn());
    if (!this.batches[shopId]) this.batches[shopId] = {};
    const rec = this.batches[shopId][date] || {
      runs: [],
      totals: { confirmed: [], failed: [], unknown: [], skipped: [] },
      allClosedConfirmed: false,
    };
    const isEnable = batch.allEnabledConfirmed !== undefined; // 开启批次（映射 confirmed_open → confirmed）
    rec.runs.push({
      at: new Date(this.nowFn()).toISOString(),
      outcome: batch.outcome,
      counts: batch.counts,
      allClosedConfirmed: batch.allClosedConfirmed === true || batch.allPausedConfirmed === true,
      allPausedConfirmed: batch.allPausedConfirmed === true,
      allEnabledConfirmed: isEnable ? batch.allEnabledConfirmed === true : undefined,
      reason: batch.reason || null,
    });
    const addAll = (key, list) => {
      for (const id of list || []) if (!rec.totals[key].includes(id)) rec.totals[key].push(id);
    };
    for (const d of batch.details || []) {
      const confirmedOutcome = isEnable ? 'confirmed_open' : 'confirmed_closed';
      if (d.outcome === confirmedOutcome) addAll('confirmed', [d.adId]);
      else if (d.outcome === 'unknown') addAll('unknown', [d.adId]);
      else if (d.outcome === 'skipped') addAll('skipped', [d.adId]);
      else addAll('failed', [d.adId]);
    }
    rec.allClosedConfirmed = batch.allClosedConfirmed === true || batch.allPausedConfirmed === true;
    rec.allPausedConfirmed = batch.allPausedConfirmed === true;
    if (isEnable) rec.allEnabledConfirmed = batch.allEnabledConfirmed === true;
    rec.lastBatchAt = new Date(this.nowFn()).toISOString();
    // Cookie 回写结果（2026-09-16 用户明确授权的能力）：单独记录，绝不影响批次 outcome/counts。
    if (batch.cookieWriteback) {
      this.lastCookieWriteback = { ...batch.cookieWriteback, at: new Date(this.nowFn()).toISOString(), shopId };
    }
    this.batches[shopId][date] = rec;
    // 2026-09-21：广告开/关状态标记（每日 07:00 开启前置门依据）。
    // 只有**回读确认**的批次才更新：暂停确认（含 nothing_to_pause 只读核验）→ 关；
    // 开启确认（含 nothing_to_enable）→ 开。partial/unknown 不更新（不臆断）。
    if (batch.allPausedConfirmed === true) {
      this.adBelief[shopId] = { on: false, at: rec.lastBatchAt, evidence: batch.outcome === 'nothing_to_pause' ? '只读核验确认全部已暂停' : '暂停批次回读确认全部已暂停' };
      this._applyConfirmedAdState(shopId, 'off', rec.lastBatchAt, this.adBelief[shopId].evidence);
    } else if (batch.allEnabledConfirmed === true) {
      this.adBelief[shopId] = { on: true, at: rec.lastBatchAt, evidence: batch.outcome === 'nothing_to_enable' ? '只读核验确认全部已开启' : '开启批次回读确认全部已开启' };
      this._applyConfirmedAdState(shopId, 'on', rec.lastBatchAt, this.adBelief[shopId].evidence);
    }
    this._pruneBatches();
    this._saveState();
  }

  /**
   * 仅在**明确全量回读确认**后更新该店当前广告状态与确认时间。
   * - 不用费用/订单采集时间（lastDataAt）冒充动作确认时间；
   * - partial / unknown / 未发出 / persistence_failed 不得调用本方法；
   * - 确认时间单独记 adStateConfirmedAt；使旧的只读观测时间失效（当前状态以动作为准）。
   */
  _applyConfirmedAdState(shopId, state, confirmedAt, evidence) {
    if (state !== 'on' && state !== 'off') return;
    const rt = this._runtime(shopId);
    rt.lastAdState = state;
    rt.adStateConfirmedAt = confirmedAt || new Date(this.nowFn()).toISOString();
    rt.adStateConfirmEvidence = evidence || null;
    // 当前状态已由动作确认建立 → 旧只读观测时间不得再作为本状态的展示时间
    rt.adStateObservedAt = null;
    rt.adStateObserveEvidence = null;
    rt.adStateEvidenceKind = 'action_confirm';
  }

  /**
   * 只读回读观测（refreshShopData / _pollShop）更新当前状态。
   * - 记 adStateObservedAt（观测时间），**不写** adStateConfirmedAt；
   * - 较新的只读观测覆盖状态时，使旧的「动作确认时间」失效，
   *   避免页面出现「新状态 + 旧确认时间」；
   * - unknown/失败同样只记观测，不得伪称动作确认。
   */
  _applyObservedAdState(shopId, state, evidence) {
    const rt = this._runtime(shopId);
    const next = state || 'unknown';
    rt.lastAdState = next;
    rt.adStateObservedAt = new Date(this.nowFn()).toISOString();
    rt.adStateObserveEvidence = evidence || null;
    // 当前状态由本轮只读证据建立 → 旧动作确认时间不得配对本状态
    rt.adStateConfirmedAt = null;
    rt.adStateConfirmEvidence = null;
    rt.adStateEvidenceKind = 'read_only';
  }

  _runtime(shopId) {
    let rt = this._runtimeMap && this._runtimeMap.get(shopId);
    if (!rt) {
      rt = {};
      if (!this._runtimeMap) this._runtimeMap = new Map();
      this._runtimeMap.set(shopId, rt);
    }
    return rt;
  }

  // ── 界面状态 ─────────────────────────────────────────────────────
  getStatus() {
    const nowMs = this.nowFn();
    const today = shanghaiDate(nowMs);
    const shops = (this.config.shops || []).map((s) => {
      const rt = (this._runtimeMap && this._runtimeMap.get(s.id)) || {};
      let cookieInfo;
      try {
        const meta = loadShopCookieMeta(this.config.login, s);
        cookieInfo = { found: true, readOnly: meta.readOnly, cookieCount: meta.count, maxExpires: meta.maxExpires, expired: meta.fxgExpired };
      } catch (e) {
        cookieInfo = { found: false, error: e.reason || e.message };
      }
      const dateRec = (this.batches[s.id] && this.batches[s.id][today]) || null;
      const enableRec = this.getEnablePhaseRecord(s.id, today);
      const thresholdCents = this._thresholdCents(s);
      return {
        id: s.id,
        name: s.name || null,
        displayName: s.displayName || s.name || s.id,
        cookieFile: s.cookieFile,
        enabled: s.enabled !== false,
        deleted: s.deleted === true,
        deletedAt: s.deletedAt || null,
        thresholdCents,
        platform: s.platform || 'douyin',
        cookieInfo,
        lastError: rt.lastError || null,
        today: rt.lastData || null,
        lastDataAt: rt.lastDataAt || (rt.lastData && rt.lastData.fetchedAt) || null,
        lastAdState: rt.lastAdState || null,
        // 证据时间语义分离：动作确认 vs 只读观测；互斥（观测覆盖后旧确认失效）
        adStateConfirmedAt: rt.adStateConfirmedAt || null,
        adStateConfirmEvidence: rt.adStateConfirmEvidence || null,
        adStateObservedAt: rt.adStateObservedAt || null,
        adStateObserveEvidence: rt.adStateObserveEvidence || null,
        adStateEvidenceKind: rt.adStateEvidenceKind || null,
        // 自动发现店使用 Cookie 会话，缺少预填账户号不产生待核验状态。
        identityPending: this._shopIdentityState(s).pending,
        identityNote: this._shopIdentityState(s).reason,
        enablePhase: enableRec || null,
        batchToday: dateRec ? { runs: dateRec.runs.length, totals: { confirmed: dateRec.totals.confirmed.length, failed: dateRec.totals.failed.length, unknown: dateRec.totals.unknown.length, skipped: dateRec.totals.skipped.length }, allClosedConfirmed: dateRec.allClosedConfirmed, allPausedConfirmed: dateRec.allPausedConfirmed === true, allEnabledConfirmed: dateRec.allEnabledConfirmed === true, lastBatchAt: dateRec.lastBatchAt, lastRuns: dateRec.runs.slice(-3) } : null,
      };
    });
      return {
        mode: this.modeLabel,
        realMode: this.realMode,
        ready: this.cfgResult.ready,
        pending: this.pending,
        configSource: this.cfgResult.sourcePath,
        clock: shanghaiClockText(nowMs),
        businessDate: today,
        monitor: {
          running: this.running,
          phase: this.schedule.phase,
          cycleNo: this.cycleNo || 0,
          startedAt: this.startedAt,
          lastCycleAt: this.lastCycleAt,
          nextRunAt: this.schedule.nextRunAt,
          waitingFor08: this.schedule.waitingFor08,
          windowBlockReason: this.schedule.lastWindowBlockReason,
          dailyStartHour: this.config.schedule.dailyStartHour,
          intervalMinutes: this.config.schedule.intervalMinutes,
          enableHour: this._enableHour(),
          // 落地确认/回读的**实际生效**轮询配置（唯一来源 execution.readbackTimeoutMs /
          // readbackIntervalMs，与执行器同源解析）：页面必须展示真实生效值，不展示 fallback 猜测值。
          polling: resolvePollingConfig(this.config.execution),
          // 最近一次会话 Cookie 回写结果（仅元信息：数量/域名/是否冲突，绝不包含任何 Cookie 值）
          cookieWriteback: this.lastCookieWriteback || null,
          // 独立每日开启调度器（与"启动值守"完全分离的生命周期；界面必须分别展示）
          enableScheduler: {
            running: this.enableRunning,
            configEnabled: !!((this.config.monitor && this.config.monitor.chengfang || {}).enableSchedulerEnabled),
            stoppedByUser: this._enableSchedule.stoppedByUser === true,
            stoppedAt: this._enableSchedule.stoppedAt || null,
            phase: this._enableSchedule.phase,
            nextRunAt: this._enableSchedule.nextRunAt,
            lastRunAt: this._enableSchedule.lastRunAt || null,
            lastMissedReason: this._enableSchedule.lastMissedReason || null,
          },
        // 第 3 项：按店铺+上海日期的持久化开启相位状态（界面展示"今日是否已开启"及失败/未知原因）
        enablePhaseToday: shops.filter((s) => s.deleted !== true).map((s) => ({ shopId: s.id, record: s.enablePhase })).filter((x) => x.record),
        // 兼容字段：任一活动店铺今日 success 即视为该日期已完成（不再是纯内存值）
        lastEnableDate: shops.some((s) => s.deleted !== true && s.enablePhase && s.enablePhase.status === 'success') ? today : null,
        snapshotMaxAgeMinutes: this.config.monitor.snapshotMaxAgeMinutes,
        mockDataSource: this.config.monitor.mockDataSource === true,
        chengfang: (this.config.monitor && this.config.monitor.chengfang) || null,
        legacyWholeShopCloseEnabled: this._legacyWholeShopAllowed(),
      },
      shops,
      // 紧凑多店铺行（主控制页直接消费；不含 Cookie/令牌/密钥）
      shopRows: (this.config.shops || []).filter((s) => s && s.deleted !== true).map((s) => {
        const rt = (this._runtimeMap && this._runtimeMap.get(s.id)) || {};
        const t = rt.lastData || null;
        return {
          id: s.id,
          name: s.name || s.id,
          displayName: s.displayName || s.name || s.id,
          adState: rt.lastAdState || 'unknown',
          adStateConfirmedAt: rt.adStateConfirmedAt || null,
          adStateObservedAt: rt.adStateObservedAt || null,
          adStateEvidenceKind: rt.adStateEvidenceKind || null,
          lastDataAt: rt.lastDataAt || (t && t.fetchedAt) || null,
          costCents: t && t.costCents != null ? t.costCents : null,
          costText: t ? t.costText : null,
          orders: t && t.orders != null ? t.orders : null,
          // 千川可用余额（2026-09-27，账户级只读展示字段；null=本轮未读到，界面显示"未知"）
          balanceCents: t && t.balanceCents != null ? t.balanceCents : null,
          balanceAt: t && t.balanceAt ? t.balanceAt : null,
          thresholdCents: this._thresholdCents(s),
          over: t ? t.over === true : null,
          lastError: rt.lastError || (t && t.blockedReason) || null,
          // 状态供界面兼容；正常配置店铺不显示待核验标记。
          identityPending: this._shopIdentityState(s).pending,
          identityNote: this._shopIdentityState(s).reason,
          enabled: s.enabled !== false,
          platform: s.platform || 'douyin',
        };
      }),
      rules: this.config.rules || [],
      // 事件流（2026-09-15 修复第 1 项）：附带单调序号，供消费方可靠增量。
      evtSeq: this._evtSeq || 0,
      cycleNo: this.cycleNo || 0,
      triggers: this.triggers.slice(-100).reverse(),
      actions: this.actions.slice(-100).reverse(),
      judgements: this.judgements.slice(-100).reverse(),
      recentErrors: this.recentErrors.slice(-50).reverse(),
      // 过程事件（retry/paused/view/identity/abort/done/step…，2026-09-15 修复第 1 项第二轮）
      processEvents: this.processEvents.slice(-100).reverse(),
      promoReaderConnected: this._injectedReader ? this._injectedReader.connected : false,
    };
  }
}

module.exports = { Monitor, STATE_VERSION };
