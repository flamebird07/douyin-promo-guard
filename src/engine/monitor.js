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
const { resolvePollingConfig } = require('../lib/bounded-poll');
const { resolveChengfangRealAllowed, resolveChengfangEnableAllowed } = require('./chengfang-gate');
const { perOrderDisplayText } = require('./rules');
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
    // 每周期判断记录（2026-09-15 修复第 3 项）：**每个完整周期一条**，
    // 不以"数据是否变化"为记录条件（旧实现靠 changed 判定 → 连续相同数据会漏判断日志）。
    this.judgements = [];

    const loaded = this._loadState();
    this.batches = loaded.batches || {}; // shopId -> date -> { runs:[], totals:{} }
    // 最近一次会话 Cookie 回写结果（仅元信息：条数/域名/冲突；绝不保存任何 Cookie 值）。
    // 不持久化：重启后清空，避免把上一进程的凭据状态当作本次会话的事实。
    this.lastCookieWriteback = null;
    this.enablePhase = loaded.enablePhase || {};
    // 独立停用标记持久化（重启后不得"复活"用户明确停用的每日开启任务）
    if (loaded.enableScheduler && typeof loaded.enableScheduler === 'object') {
      this._enableSchedule.stoppedByUser = loaded.enableScheduler.stoppedByUser === true;
      this._enableSchedule.stoppedAt = loaded.enableScheduler.stoppedAt || null;
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

  _saveState() {
    try {
      this._ensureDataDir();
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({
        version: STATE_VERSION,
        batches: this.batches,
        enablePhase: this.enablePhase || {},
        enableScheduler: {
          stoppedByUser: this._enableSchedule.stoppedByUser === true,
          stoppedAt: this._enableSchedule.stoppedAt || null,
        },
        savedAt: new Date(this.nowFn()).toISOString(),
      }, null, 2));
      fs.renameSync(tmp, this.stateFile);
    } catch (e) {
      log.warn('状态持久化失败:', e.message);
    }
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
  start() {
    if (this.pending.length > 0) {
      return { ok: false, reason: `存在待配置/非法配置项，不允许启动监控: ${this.pending.join('；')}` };
    }
    if (this.running) return { ok: true, alreadyRunning: true };
    this._gen += 1;
    this.running = true;
    this.startedAt = new Date(this.nowFn()).toISOString();
    const gen = this._gen;
    this._audit({ kind: 'monitor', event: 'start', mode: this.modeLabel });
    this._loopPromise = this._intervalLoop(gen);
    log.info(`监控已启动（${this.modeLabel}，每日 ${this.config.schedule.dailyStartHour}:00 后，每 ${this.config.schedule.intervalMinutes} 分钟）`);
    return { ok: true };
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
    const anyRecord = (this.config.shops || []).some((s) => this.getEnablePhaseRecord(s.id, date));
    if (anyRecord) return; // 今日已执行过（success/failed/unknown 均有记录），非"错过"
    this._enableSchedule.lastMissedDate = date;
    const dh = String(this.config.schedule.dailyStartHour).padStart(2, '0');
    const eh = String(this._enableHour()).padStart(2, '0');
    const reason = `今日开启窗口（上海 ${eh}:00–${dh}:00）已过且当日未执行开启：不擅自补开广告，等待明日窗口`;
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
   * 独立每日开启循环：等待每日 [enableHour, dailyStartHour) 窗口 → 执行开启相位
   * （复用 _runEnablePhase：按店铺+日期持久化、成功不重复、unknown 先回读）。
   * 与暂停巡查循环（_intervalLoop）并存：共享 _cycleRunning 互斥与执行器，
   * 但生命周期独立——"停止值守"不影响本循环。
   */
  async _enableLoop(gen) {
    const sch = this.config.schedule;
    while (gen === this._enableGen && this.enableRunning) {
      const now = this.nowFn();
      const w = shanghaiWall(now);
      if (w.hour >= this._enableHour() && w.hour < sch.dailyStartHour) {
        const today = w.date;
        const shopsToRun = (this.config.shops || []).filter(
          (s) => s.enabled !== false && !this._enablePhaseDone(s.id, today),
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
          // 今日全部店铺已 success → 等窗口结束（不重复开启）
          this._enableSchedule.phase = 'enable_window';
        }
        const afterMs = this.nowFn();
        const afterWall = shanghaiWall(afterMs);
        if (afterWall.date !== w.date) continue; // 执行中跨日：回环重判
        if (afterWall.hour < sch.dailyStartHour) {
          const waitMs = msUntilDailyStart(afterMs, sch.dailyStartHour);
          if (waitMs > 0) { await this._enableDelay(waitMs, gen); }
          continue;
        }
        continue; // 已过 dailyStartHour（慢执行跨窗）→ 回环按窗口外逻辑登记明日
      }
      // ── 窗口外 ──
      if (w.hour >= sch.dailyStartHour) {
        this._noteMissedEnableWindowIfNeeded(w.date);
      }
      const targetMs = this._nextEnableWindowStartMs(now);
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
        // 仅当所有启用店铺当日均为 success 时才算"已完成"
        const shopsToRun = (this.config.shops || []).filter(
          (s) => s.enabled !== false && !this._enablePhaseDone(s.id, today)
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
      try {
        await this.pollOnce('interval');
      } catch (e) {
        this._memPush(this.recentErrors, { scope: 'cycle', error: e.message }, undefined, 'error');
      }
      if (gen !== this._gen || !this.running) return;
      const lastRun = this.nowFn();
      this.schedule.lastRunAt = new Date(lastRun).toISOString();
      const nd = nextIntervalDelayMs(this.nowFn(), lastRun, sch.intervalMinutes, sch.dailyStartHour, enableWindow ? enableHour : undefined);
      this.schedule.nextRunAt = new Date(nd.nextRunAt).toISOString();
      this.schedule.waitingFor08 = nd.crossDay; // 跨日 → 等待次日 enableHour（或 startHour）
      if (nd.crossDay) this.schedule.phase = 'waiting_window';
      await this.delayFn(nd.delayMs, gen);
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
      const results = [];
      for (const shopCfg of this.config.shops) {
        if (token.aborted) break;
        if (shopCfg.enabled === false) continue;
        results.push({ shopId: shopCfg.id, ...(await this._pollShop(shopCfg, token, trigger)) });
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
  _emitJudgement(shopCfg, { data, over, status, reason }) {
    const cycleNo = (this._currentCycle && this._currentCycle.cycleNo) || this.cycleNo;
    const costCents = data && data.cost ? data.cost.valueCents : null;
    const orders = data && data.orders ? data.orders.valueCount : null;
    const rule = (this.config.rules || []).find((r) => r.type === 'wholeShopCostPerOrder' && r.enabled !== false);
    const thresholdCents = rule ? rule.thresholdCents : null;
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
      perOrderText: (data && data.cost && data.orders && typeof costCents === 'number' && orders > 0)
        ? perOrderDisplayText(costCents, orders) : null,
      at: new Date(this.nowFn()).toISOString(),
    };
    // 每个周期一条（同一个 cycleNo 只记一次，防止重入重复）
    if (this.lastJudgementCycleNo !== cycleNo) {
      this._memPush(this.judgements, { kind: 'judgement', ...rec }, undefined, 'judgement');
      this.lastJudgementCycleNo = cycleNo;
    }
    return rec;
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

      // 3) 评估结果分流
      if (data.ok === false) {
        // 零订单/无效订单已重读核实仍异常 → 阻止本轮关闭
        rt.lastData.blockedReason = data.reason;
        this._emitJudgement(shopCfg, { data, over: null, status: 'blocked', reason: data.reason });
        this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason: data.reason, blocked: data.blocked });
        return { status: 'blocked', reason: data.reason, blocked: data.blocked };
      }
      // 2026-09-15 修复第 3 项：**每个完整周期记录一条判断**，不以"数据是否变化"为条件。
      this._emitJudgement(shopCfg, { data, over: data.evaluation.over === true, status: 'ok', reason: data.evaluation.reason });
      if (!data.evaluation.over) {
        this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'ok', over: false, reason: data.evaluation.reason });
        return { status: 'ok', over: false, reason: data.evaluation.reason };
      }

      // 4) 超标 → 分流：乘方主链路（生产唯一路径）；历史全店路径仅测试显式开启
      if (this._chengfangScopeConfigured()) {
        return this._pollChengfangOver(shopCfg, data, cycleToken, trigger);
      }
      if (this._legacyWholeShopAllowed()) {
        return this._pollLegacyWholeShopOver(shopCfg, data, cycleToken);
      }
      const scopeBlockedReason = '未配置乘方控制范围（monitor.chengfang.scope）且未显式开启历史全店路径：监控不执行任何关闭';
      rt.lastData.blockedReason = scopeBlockedReason;
      this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: scopeBlockedReason }, undefined, 'error');
      this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason: scopeBlockedReason });
      return { status: 'blocked', reason: scopeBlockedReason };
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
      for (const shopCfg of this.config.shops) {
        if (schedScope) {
          if (gen !== this._enableGen || !this.enableRunning) break;
        } else if (gen !== this._gen || !this.running) {
          break;
        }
        if (token.aborted) break;
        if (shopCfg.enabled === false) continue;
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
   * 单店铺开启相位：
   * - 演练（realMode=false）：只枚举将开启目标，零业务点击（executor 由配置门槛自动转演练）。
   * - 真实（realMode=true）：runner 内部做集中门槛（realMode+enableEnabled）→ 开启窗口 → 停止
   *   → 乘方全店托管+商品自选 → 全量回读；逐请求检查停止/时段/跨日。
   * 窗口未开放/门槛不通过 → 零请求，且不打开乘方页面。
   */
  async _runShopEnablePhase(shopCfg, cycleToken, businessDate = null) {
    const rt = this._runtime(shopCfg.id);
    const runner = this._getChengfangRunner(shopCfg);
    const opener = this._chengfangOpener || defaultChengfangOpener;
    const loginCfg = this.config.login;
    const enableHour = this._enableHour();
    const today = businessDate || shanghaiDate(this.nowFn());

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

    if (!this.realMode) {
      let res;
      try {
        res = await runner.runDryEnableCycle({ shopCfg, pageOpener: opener, loginCfg });
      } catch (e) {
        const reason = `乘方开启演练周期失败：${e.reason || e.message}`;
        rt.lastError = reason;
        this._setEnablePhase(shopCfg.id, today, 'failed', { phase: 'dry', reason });
        this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason }, undefined, 'error');
        this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'stopped', reason });
        return { status: 'stopped', reason };
      }
      if (res.outcome === 'dry_failed') {
        const reason = res.error || res.reason || '乘方开启演练未完成（身份/读取/分页/选择范围失败）';
        rt.lastError = reason;
        this._setEnablePhase(shopCfg.id, today, 'failed', { phase: 'dry', reason });
        this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: `乘方开启演练失败：${reason}` }, undefined, 'error');
        this._memPush(this.triggers, {
          shopId: shopCfg.id, mode: 'dry', targetAction: 'enable', failed: true, reason,
          businessDate: today, targetCount: 0, targets: [],
          dryOutcome: 'dry_failed',
          note: `每日开启相位演练未完成（失败），不计为"正常枚举"：${reason}`,
        }, undefined, 'trigger');
        this._audit({ kind: 'trigger', shopId: shopCfg.id, mode: 'dry', failed: true, reason });
        return { status: 'ok', dryRun: true, targetCount: 0, enable: { outcome: 'dry_failed', error: reason } };
      }
      const triggerRec = {
        shopId: shopCfg.id, mode: 'dry', targetAction: 'enable',
        scope: '乘方(全店托管+商品自选)',
        reason: `每日 ${enableHour}:00 自动开启相位`,
        businessDate: today,
        targetCount: (res.targets || []).length,
        targets: res.targets,
        dryOutcome: res.outcome,
        note: res.error
          ? `演练模式：每日开启相位演练未完成（${res.error}）`
          : `演练模式：每日开启相位将开启以下乘方目标（未点击任何开关/开启/删除）`,
      };
      this._memPush(this.triggers, triggerRec, undefined, 'trigger');
      this._audit({ kind: 'trigger', ...triggerRec, targets: (res.targets || []).map((t) => t.planId || t.adId) });
      // 演练不计入"已开启成功"——保留为 dry_done（不阻塞当日真实窗口，但也不谎报成功）
      this._setEnablePhase(shopCfg.id, today, res.error ? 'unknown' : 'dry_done', {
        phase: 'dry', reason: res.error || null, targetCount: (res.targets || []).length,
      });
      return { status: 'ok', dryRun: true, targetCount: (res.targets || []).length, enable: { outcome: res.outcome, error: res.error } };
    }

    this.schedule.lastWindowBlockReason = null;
    let batch;
    try {
      batch = await runner.executeChengfangEnableBatch({
        shopCfg,
        cycleToken,
        trigger: { reason: `每日 ${enableHour}:00 自动开启` },
        pageOpener: opener,
        loginCfg,
      });
    } catch (e) {
      const reason = `乘方开启批次异常：${e.reason || e.message}`;
      // 异常可能已发出部分请求 → unknown（不盲重发，等待回读）
      this._setEnablePhase(shopCfg.id, today, 'unknown', { phase: 'execute', reason });
      this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason }, undefined, 'error');
      this._audit({ kind: 'action', shopId: shopCfg.id, status: 'unknown', reason });
      return { status: 'unknown', reason };
    }
    if (batch.outcome === 'blocked_window') {
      this.schedule.lastWindowBlockReason = batch.reason;
      this._setEnablePhase(shopCfg.id, today, 'failed', { phase: 'execute', reason: batch.reason, blocked: 'window' });
      // 真实 trigger 也必须带显式动作标签（值守侧 describeTrigger 只认 targetAction，不猜）
      this._memPush(this.triggers, { shopId: shopCfg.id, mode: 'real', targetAction: 'enable', blocked: 'window', reason: batch.reason, targetCount: 0 }, undefined, 'trigger');
      this._audit({ kind: 'trigger', shopId: shopCfg.id, mode: 'real', targetAction: 'enable', blocked: 'window', reason: batch.reason });
      return { status: 'window_blocked', reason: batch.reason };
    }
    if (batch.outcome === 'blocked_stopped') {
      const reason = batch.reason || '监控已停止，未发出乘方开启请求';
      // 未发出任何请求 → 不占用当日（标记为 failed，允许窗口内重试）
      this._setEnablePhase(shopCfg.id, today, 'failed', { phase: 'execute', reason, stopped: true });
      this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'stopped', reason });
      return { status: 'stopped', reason };
    }
    if (batch.outcome === 'blocked') {
      const reason = batch.reason || '乘方开启被门槛阻止，未发出任何请求';
      rt.lastData = rt.lastData || {};
      rt.lastData.blockedReason = reason;
      this._setEnablePhase(shopCfg.id, today, 'failed', { phase: 'execute', reason });
      this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason }, undefined, 'error');
      this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason });
      return { status: 'blocked', reason, batch: this._summarizeBatch(batch) };
    }
    // nothing_to_enable / all_enabled_confirmed / partial → 记录批次
    // 第 4 项：显式声明动作类型，下游禁止从 outcome 推断
    batch.actionType = batch.actionType || 'enable';
    this._recordBatch(shopCfg.id, batch);
    this._memPush(this.actions, { shopId: shopCfg.id, ...this._summarizeBatch(batch) }, undefined, 'batch');
    this._audit({ kind: 'action', shopId: shopCfg.id, ...this._summarizeBatch(batch) });
    // 全部确认开启 → success；部分确认 → unknown（不谎报成功，不阻塞已确认部分）
    const okStatus = batch.allEnabledConfirmed === true ? 'success' : 'unknown';
    this._setEnablePhase(shopCfg.id, today, okStatus, {
      phase: 'execute',
      outcome: batch.outcome,
      allEnabledConfirmed: batch.allEnabledConfirmed === true,
      reason: batch.reason || null,
    });
    return { status: 'ok', enable: { outcome: batch.outcome }, batch: this._summarizeBatch(batch) };
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
    this._pruneBatches();
    this._saveState();
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
      return {
        id: s.id,
        name: s.name || null,
        cookieFile: s.cookieFile,
        enabled: s.enabled !== false,
        cookieInfo,
        lastError: rt.lastError || null,
        today: rt.lastData || null,
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
        enablePhaseToday: shops.map((s) => ({ shopId: s.id, record: s.enablePhase })).filter((x) => x.record),
        // 兼容字段：任一启用店铺今日 success 即视为该日期已完成（不再是纯内存值）
        lastEnableDate: shops.some((s) => s.enablePhase && s.enablePhase.status === 'success') ? today : null,
        snapshotMaxAgeMinutes: this.config.monitor.snapshotMaxAgeMinutes,
        mockDataSource: this.config.monitor.mockDataSource === true,
        chengfang: (this.config.monitor && this.config.monitor.chengfang) || null,
        legacyWholeShopCloseEnabled: this._legacyWholeShopAllowed(),
      },
      shops,
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
