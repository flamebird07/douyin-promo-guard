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
const { perOrderDisplayText } = require('./rules');
const guard = require('./guard');
const { NotConnectedError } = require('../lib/errors');
const { shanghaiDate, shanghaiClockText, shanghaiWall, isAfterDailyStart, msUntilDailyStart, msUntilHour, nextIntervalDelayMs } = require('../lib/time');
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

    this.adapters = adapters || null;
    this._injectedReader = (adapters && adapters.reader) || null;
    this._injectedController = (adapters && adapters.controller) || null;
    this._coordinators = new Map(); // shopId -> WholeShopCloseCoordinator（跨周期保留在途请求登记）
    this._chengfangRunners = new Map(); // shopId -> ChengfangRunner（乘方主链路）
    this._chengfangOpener = opts.chengfangOpener || null; // 测试注入：本地 DOM fixture 会话开启器

    this.running = false;
    this._gen = 0;               // 代数：stop/start 快速切换时防止多循环
    this._loopPromise = null;
    this._cycleRunning = false;
    this._activeTokens = new Set();

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

    // 事件序号（2026-09-15 修复第 1 项）：单调递增、永不回退，供外部增量消费。
    // 消费方以 evtSeq 为游标，不再依赖有界数组长度；裁剪区段记录在 _evtDropped。
    this._evtSeq = 0;
    this._evtDropped = [];

    // 巡查周期序号（2026-09-15 修复第 3 项）：每个完整周期 +1，用于"每周期必记一条判断"。
    this.cycleNo = 0;
    this.lastJudgementCycleNo = 0;
    // 每周期判断记录（2026-09-15 修复第 3 项）：**每个完整周期一条**，
    // 不以"数据是否变化"为记录条件（旧实现靠 changed 判定 → 连续相同数据会漏判断日志）。
    this.judgements = [];

    const loaded = this._loadState();
    this.batches = loaded.batches || {}; // shopId -> date -> { runs:[], totals:{} }
    this.enablePhase = loaded.enablePhase || {};
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
      this._memPush(this.recentErrors, { scope: 'enable-phase', error: `重启回读：${recovered.length} 条开启相位记录由 in_progress 转为 unknown（先回读，不盲重发）`, recovered });
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
          this._memPush(this.recentErrors, { scope: 'state', error: `状态文件损坏已隔离重建: ${e.message}` });
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

  _audit(entry) {
    try {
      this._ensureDataDir();
      fs.appendFileSync(this.auditFile, JSON.stringify({ ts: new Date(this.nowFn()).toISOString(), ...log.sanitize(entry) }) + '\n');
    } catch (_) { /* 审计落盘失败不阻塞 */ }
  }

  /**
   * 有界数组写入 + **单调递增稳定序号**（2026-09-15 修复第 1 项）。
   *
   * 旧行为：消费方以 `arr.length` 作为增量游标。数组上限 300，一旦写满就会
   * 从头部裁剪，长度停止增长 → 消费方永远看不到新事件（永久漏日志）；
   * 或者裁剪后长度回退 → 重复消费。
   *
   * 修复：每条事件附加单调递增的 `evtSeq`（进程内全局唯一、永不回退），
   * 并在裁剪时把被丢弃的区段记入 `this._evtDropped`（供消费方报告日志缺口）。
   * 消费方以 `evtSeq > lastSeq` 判定增量，与数组长度无关。
   *
   * @param {Array} arr   有界数组（triggers/actions/recentErrors）
   * @param {object} entry 事件体
   * @param {number} [limit] 数组上限
   */
  _memPush(arr, entry, limit) {
    const cap = limit || 300;
    this._evtSeq = (this._evtSeq || 0) + 1;
    const ts = new Date(this.nowFn()).toISOString();
    arr.push({ evtSeq: this._evtSeq, ts, ...log.sanitize(entry) });
    if (arr.length > cap) {
      const removed = arr.splice(0, arr.length - cap);
      // 记录被裁剪的序号区段，供消费方在游标落后时报告明确缺口（而非静默漏日志）
      const firstSeq = removed[0] && removed[0].evtSeq;
      const lastSeq = removed[removed.length - 1] && removed[removed.length - 1].evtSeq;
      if (typeof firstSeq === 'number' && typeof lastSeq === 'number') {
        this._evtDropped.push({ firstSeq, lastSeq, count: removed.length, at: ts });
        if (this._evtDropped.length > 50) this._evtDropped.splice(0, this._evtDropped.length - 50);
      }
    }
    return this._evtSeq;
  }

  /**
   * 事件流快照（供外部增量消费）。
   *
   * - `events`：当前仍保留在内存中的事件（按 evtSeq 升序，跨 triggers/actions/recentErrors 合并）
   * - `seq`：当前最大 evtSeq（进程内单调，永不回退）
   * - `dropped`：因有界裁剪而丢失的序号区段（消费方可据此报告"日志缺口 N 条"）
   *
   * 消费方应保存上次的 `seq`，下次以 `since=seq` 拉取；即使期间发生裁剪，
   * 也能通过 `dropped` 如实告知缺口，而不是永久漏日志或静默错位。
   */
  getEventStream(since = 0) {
    const all = [];
    for (const arr of [this.triggers, this.actions, this.recentErrors, this.judgements]) {
      for (const e of arr) if (e && typeof e.evtSeq === 'number') all.push(e);
    }
    all.sort((a, b) => a.evtSeq - b.evtSeq);
    const dropped = (this._evtDropped || []).filter((d) => d.lastSeq > since && d.firstSeq > since);
    return {
      seq: this._evtSeq || 0,
      cycleNo: this.cycleNo || 0,
      events: all.filter((e) => e.evtSeq > since),
      dropped,
      droppedCount: dropped.reduce((n, d) => n + d.count, 0),
    };
  }

  // ── 模式 ─────────────────────────────────────────────────────────
  get realMode() { return this.config.execution.realMode === true; }
  get modeLabel() { return this.realMode ? '真实执行' : '演练模式（只记录不关闭）'; }

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
    this._gen += 1;          // 使旧循环退出、旧 delay 中断
    this.running = false;
    // 停止所有在途轮询周期：周期内不再发起新的关闭请求（已发出的继续回读确认）
    for (const t of this._activeTokens) t.aborted = true;
    this.schedule.phase = 'stopped';
    this.schedule.nextRunAt = null;
    log.info('监控已停止（已发出的关闭请求将继续回读确认）');
    this._audit({ kind: 'monitor', event: 'stop' });
    return { ok: true };
  }

  /** 默认可中断延时：分片睡眠，代数变化或停止时提前返回。 */
  async _chunkedDelay(ms, gen) {
    const step = 250;
    let waited = 0;
    while (waited < ms) {
      if (gen !== undefined && gen !== this._gen) return;
      if (!this.running) return;
      const chunk = Math.min(step, ms - waited);
      await new Promise((r) => setTimeout(r, chunk));
      waited += chunk;
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
      if (enableWindow && w.hour >= enableHour && w.hour < sch.dailyStartHour) {
        const today = w.date;
        // 仅当所有启用店铺当日均为 success 时才算"已完成"
        const shopsToRun = (this.config.shops || []).filter(
          (s) => s.enabled !== false && !this._enablePhaseDone(s.id, today)
        );
        if (shopsToRun.length > 0) {
          this.schedule.phase = 'enable_window';
          this.schedule.waitingFor08 = false;
          try {
            await this._runEnablePhase(gen, today);
          } catch (e) {
            this._memPush(this.recentErrors, { scope: 'cycle', error: `乘方自动开启相位失败：${e.message}` });
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
        this._memPush(this.recentErrors, { scope: 'cycle', error: e.message });
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
    const token = { aborted: false };
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
      this._memPush(this.judgements, { kind: 'judgement', ...rec });
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
          this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: rt.lastError });
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
      this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: scopeBlockedReason });
      this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason: scopeBlockedReason });
      return { status: 'blocked', reason: scopeBlockedReason };
    } catch (e) {
      const reason = e.reason || e.message;
      rt.lastError = reason;
      this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason, code: e.code || null });
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
        this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason });
        this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'stopped', reason });
        return { status: 'stopped', reason };
      }
      if (res.outcome === 'dry_failed') {
        const reason = res.error || res.reason || '乘方演练未完成（身份/读取/分页/选择范围失败）';
        rt.lastError = reason;
        this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: `乘方演练失败：${reason}` });
        this._memPush(this.triggers, {
          shopId: shopCfg.id, mode: 'dry', actionType: 'pause', action: 'pause', failed: true, reason,
          businessDate: data.cost.businessDate,
          costText: `${centsToYuan(data.cost.valueCents)} 元`,
          orders: data.orders.valueCount,
          targetCount: 0, targets: [],
          dryOutcome: 'dry_failed',
          note: `演练未完成（失败），不计为"正常枚举"：${reason}`,
        });
        this._audit({ kind: 'trigger', shopId: shopCfg.id, mode: 'dry', failed: true, reason });
        return { status: 'ok', over: true, dryRun: true, targetCount: 0, chengfang: { outcome: 'dry_failed', error: reason } };
      }
      const triggerRec = {
        shopId: shopCfg.id, mode: 'dry', actionType: 'pause', action: 'pause',
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
      this._memPush(this.triggers, triggerRec);
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
      this._memPush(this.triggers, { shopId: shopCfg.id, mode: 'real', blocked: 'window', reason: batch.reason, targetCount: 0 });
      this._audit({ kind: 'trigger', shopId: shopCfg.id, mode: 'real', blocked: 'window', reason: batch.reason });
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
      this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason });
      this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason });
      return { status: 'blocked', reason, batch: this._summarizeBatch(batch) };
    }
    // cancelled / nothing_to_pause / all_paused_confirmed / partial → 记录批次
    // 第 4 项：显式声明动作类型，下游禁止从 outcome 推断
    batch.actionType = batch.actionType || 'pause';
    this._recordBatch(shopCfg.id, batch);
    this._memPush(this.actions, { shopId: shopCfg.id, ...this._summarizeBatch(batch) });
    this._audit({ kind: 'action', shopId: shopCfg.id, ...this._summarizeBatch(batch) });
    return { status: 'ok', over: true, batch: this._summarizeBatch(batch) };
  }

  // ── 每日自动开启相位（07:00 窗口，每天一次；独立于费用/订单阈值）────

  /** 每日开启相位：遍历启用的店铺执行开启（真实=executeChengfangEnableBatch；演练=runDryEnableCycle）。 */
  async _runEnablePhase(gen, businessDate = null) {
    const token = { aborted: false };
    this._activeTokens.add(token);
    this._cycleRunning = true;
    const today = businessDate || shanghaiDate(this.nowFn());
    try {
      for (const shopCfg of this.config.shops) {
        if (gen !== this._gen || !this.running) break;
        if (token.aborted) break;
        if (shopCfg.enabled === false) continue;
        if (this._enablePhaseDone(shopCfg.id, today)) continue;
        await this._runShopEnablePhase(shopCfg, token, today);
      }
    } finally {
      this._activeTokens.delete(token);
      this._cycleRunning = false;
    }
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
        this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason });
        this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'stopped', reason });
        return { status: 'stopped', reason };
      }
      if (res.outcome === 'dry_failed') {
        const reason = res.error || res.reason || '乘方开启演练未完成（身份/读取/分页/选择范围失败）';
        rt.lastError = reason;
        this._setEnablePhase(shopCfg.id, today, 'failed', { phase: 'dry', reason });
        this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: `乘方开启演练失败：${reason}` });
        this._memPush(this.triggers, {
          shopId: shopCfg.id, mode: 'dry', actionType: 'enable', action: 'enable',
          scope: '乘方(全店托管+商品自选)', failed: true, reason,
          businessDate: today, targetCount: 0, targets: [],
          dryOutcome: 'dry_failed',
          note: `每日开启相位演练未完成（失败），不计为"正常枚举"：${reason}`,
        });
        this._audit({ kind: 'trigger', shopId: shopCfg.id, mode: 'dry', failed: true, reason });
        return { status: 'ok', dryRun: true, targetCount: 0, enable: { outcome: 'dry_failed', error: reason } };
      }
      const triggerRec = {
        shopId: shopCfg.id, mode: 'dry', actionType: 'enable', action: 'enable',
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
      this._memPush(this.triggers, triggerRec);
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
      this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason });
      this._audit({ kind: 'action', shopId: shopCfg.id, status: 'unknown', reason });
      return { status: 'unknown', reason };
    }
    if (batch.outcome === 'blocked_window') {
      this.schedule.lastWindowBlockReason = batch.reason;
      this._setEnablePhase(shopCfg.id, today, 'failed', { phase: 'execute', reason: batch.reason, blocked: 'window' });
      this._memPush(this.triggers, { shopId: shopCfg.id, mode: 'real', blocked: 'window', reason: batch.reason, targetCount: 0 });
      this._audit({ kind: 'trigger', shopId: shopCfg.id, mode: 'real', blocked: 'window', reason: batch.reason });
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
      this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason });
      this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason });
      return { status: 'blocked', reason, batch: this._summarizeBatch(batch) };
    }
    // nothing_to_enable / all_enabled_confirmed / partial → 记录批次
    // 第 4 项：显式声明动作类型，下游禁止从 outcome 推断
    batch.actionType = batch.actionType || 'enable';
    this._recordBatch(shopCfg.id, batch);
    this._memPush(this.actions, { shopId: shopCfg.id, ...this._summarizeBatch(batch) });
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
      this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason });
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
      this._memPush(this.triggers, triggerRec);
      this._audit({ kind: 'trigger', ...triggerRec, targets: triggerRec.targets.map((t) => t.adId) });
      return { status: 'ok', over: true, dryRun: true, targetCount: activeTargets.length, coverageGaps, sideUnknown };
    }

    // 真实模式：手动/定时一视同仁，受时间窗口限制
    if (!isAfterDailyStart(this.nowFn(), this.config.schedule.dailyStartHour)) {
      const hh = String(this.config.schedule.dailyStartHour).padStart(2, '0');
      const reason = `未到允许执行时段（每日 ${hh}:00 后，Asia/Shanghai）：已读取并记录，未执行真实关闭（手动检查不绕过时间限制）`;
      this.schedule.lastWindowBlockReason = reason;
      this._memPush(this.triggers, { shopId: shopCfg.id, mode: 'real', blocked: 'window', reason, targetCount: activeTargets.length });
      this._audit({ kind: 'trigger', shopId: shopCfg.id, mode: 'real', blocked: 'window', reason });
      return { status: 'window_blocked', reason };
    }
    this.schedule.lastWindowBlockReason = null;

    const todayStatus = new Map(); // 批次内结果累积（跨批次状态以最新清单读取为准）
    const batch = await coord.executeWholeShopCloseBatch({ shopCfg, cycleToken, todayStatus, trigger: { reason: data.evaluation.reason } });
    batch.actionType = batch.actionType || 'pause';
    this._recordBatch(shopCfg.id, batch);
    this._memPush(this.actions, { shopId: shopCfg.id, ...this._summarizeBatch(batch) });
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
      promoReaderConnected: this._injectedReader ? this._injectedReader.connected : false,
    };
  }
}

module.exports = { Monitor, STATE_VERSION };
