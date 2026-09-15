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
    this._lastEnableDate = null; // 每日自动开启相位已执行的上海日历日（跨日重置，当天只一次）

    this.triggers = [];          // 命中记录（演练=将关闭；真实=已触发执行）
    this.actions = [];           // 真实执行批次结果
    this.recentErrors = [];

    const loaded = this._loadState();
    this.batches = loaded.batches || {}; // shopId -> date -> { runs:[], totals:{} }
    this._saveState();
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
      return { version: STATE_VERSION, batches: {} };
    }
  }

  _saveState() {
    try {
      this._ensureDataDir();
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ version: STATE_VERSION, batches: this.batches, savedAt: new Date(this.nowFn()).toISOString() }, null, 2));
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

  _memPush(arr, entry) {
    arr.push({ ts: new Date(this.nowFn()).toISOString(), ...log.sanitize(entry) });
    if (arr.length > 300) arr.splice(0, arr.length - 300);
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
   * - 开启窗口 [enableHour, dailyStartHour)：每天一次自动开启（跨日重置，见 _lastEnableDate）；
   *   执行后等待到 dailyStartHour 进入暂停巡查。
   * - 00:00–enableHour：等待开启窗口起点（未配置开启窗口则等待 dailyStartHour）。
   * - dailyStartHour 后：暂停巡查（原有逻辑），跨日等待目标改为 enableHour（若配置了开启窗口），
   *   使次日 07:00 的自动开启相位能被唤醒，而不是直接跳到 08:00。
   * 停止/重启通过代数防止多循环；所有等待用 delayFn（可注入时钟门）。
   */
  async _intervalLoop(gen) {
    const sch = this.config.schedule;
    const enableHour = this._enableHour();
    const enableWindow = this._enableWindowConfigured();
    while (gen === this._gen && this.running) {
      const now = this.nowFn();
      const w = shanghaiWall(now);

      // ── 开启窗口：[enableHour, dailyStartHour)，每天一次（跨日重置）──
      if (enableWindow && w.hour >= enableHour && w.hour < sch.dailyStartHour) {
        const today = w.date;
        if (this._lastEnableDate !== today) {
          this._lastEnableDate = today;
          this.schedule.phase = 'enable_window';
          this.schedule.waitingFor08 = false;
          try {
            await this._runEnablePhase(gen);
          } catch (e) {
            this._memPush(this.recentErrors, { scope: 'cycle', error: `乘方自动开启相位失败：${e.message}` });
          }
        }
        // 窗口内剩余时间：等到 dailyStartHour 进入暂停巡查
        const waitMs = msUntilDailyStart(now, sch.dailyStartHour);
        const target = now + waitMs;
        this.schedule.nextRunAt = new Date(target).toISOString();
        this.schedule.phase = 'waiting_window';
        this.schedule.waitingFor08 = true;
        this.schedule.lastWindowBlockReason = `等待每日 ${sch.dailyStartHour}:00（Asia/Shanghai）进入暂停巡查`;
        await this.delayFn(waitMs, gen);
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
    try {
      const results = [];
      for (const shopCfg of this.config.shops) {
        if (token.aborted) break;
        if (shopCfg.enabled === false) continue;
        results.push({ shopId: shopCfg.id, ...(await this._pollShop(shopCfg, token, trigger)) });
      }
      this.lastCycleAt = new Date(this.nowFn()).toISOString();
      return { ok: true, trigger, results };
    } finally {
      this._activeTokens.delete(token);
      this._cycleRunning = false;
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
        this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason: data.reason, blocked: data.blocked });
        return { status: 'blocked', reason: data.reason, blocked: data.blocked };
      }
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
          shopId: shopCfg.id, mode: 'dry', failed: true, reason,
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
        shopId: shopCfg.id, mode: 'dry', scope: '乘方(全店托管+商品自选)',
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
    this._recordBatch(shopCfg.id, batch);
    this._memPush(this.actions, { shopId: shopCfg.id, ...this._summarizeBatch(batch) });
    this._audit({ kind: 'action', shopId: shopCfg.id, ...this._summarizeBatch(batch) });
    return { status: 'ok', over: true, batch: this._summarizeBatch(batch) };
  }

  // ── 每日自动开启相位（07:00 窗口，每天一次；独立于费用/订单阈值）────

  /** 每日开启相位：遍历启用的店铺执行开启（真实=executeChengfangEnableBatch；演练=runDryEnableCycle）。 */
  async _runEnablePhase(gen) {
    const token = { aborted: false };
    this._activeTokens.add(token);
    this._cycleRunning = true;
    try {
      for (const shopCfg of this.config.shops) {
        if (gen !== this._gen || !this.running) break;
        if (token.aborted) break;
        if (shopCfg.enabled === false) continue;
        await this._runShopEnablePhase(shopCfg, token);
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
  async _runShopEnablePhase(shopCfg, cycleToken) {
    const rt = this._runtime(shopCfg.id);
    const runner = this._getChengfangRunner(shopCfg);
    const opener = this._chengfangOpener || defaultChengfangOpener;
    const loginCfg = this.config.login;
    const enableHour = this._enableHour();

    if (!this.realMode) {
      let res;
      try {
        res = await runner.runDryEnableCycle({ shopCfg, pageOpener: opener, loginCfg });
      } catch (e) {
        const reason = `乘方开启演练周期失败：${e.reason || e.message}`;
        rt.lastError = reason;
        this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason });
        this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'stopped', reason });
        return { status: 'stopped', reason };
      }
      if (res.outcome === 'dry_failed') {
        const reason = res.error || res.reason || '乘方开启演练未完成（身份/读取/分页/选择范围失败）';
        rt.lastError = reason;
        this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: `乘方开启演练失败：${reason}` });
        this._memPush(this.triggers, {
          shopId: shopCfg.id, mode: 'dry', scope: '乘方(全店托管+商品自选)', failed: true, reason,
          businessDate: shanghaiDate(this.nowFn()), targetCount: 0, targets: [],
          dryOutcome: 'dry_failed',
          note: `每日开启相位演练未完成（失败），不计为"正常枚举"：${reason}`,
        });
        this._audit({ kind: 'trigger', shopId: shopCfg.id, mode: 'dry', failed: true, reason });
        return { status: 'ok', dryRun: true, targetCount: 0, enable: { outcome: 'dry_failed', error: reason } };
      }
      const triggerRec = {
        shopId: shopCfg.id, mode: 'dry', scope: '乘方(全店托管+商品自选)',
        reason: `每日 ${enableHour}:00 自动开启相位`,
        businessDate: shanghaiDate(this.nowFn()),
        targetCount: (res.targets || []).length,
        targets: res.targets,
        dryOutcome: res.outcome,
        note: res.error
          ? `演练模式：每日开启相位演练未完成（${res.error}）`
          : `演练模式：每日开启相位将开启以下乘方目标（未点击任何开关/开启/删除）`,
      };
      this._memPush(this.triggers, triggerRec);
      this._audit({ kind: 'trigger', ...triggerRec, targets: (res.targets || []).map((t) => t.planId || t.adId) });
      return { status: 'ok', dryRun: true, targetCount: (res.targets || []).length, enable: { outcome: res.outcome, error: res.error } };
    }

    this.schedule.lastWindowBlockReason = null;
    const batch = await runner.executeChengfangEnableBatch({
      shopCfg,
      cycleToken,
      trigger: { reason: `每日 ${enableHour}:00 自动开启` },
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
      const reason = batch.reason || '监控已停止，未发出乘方开启请求';
      this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'stopped', reason });
      return { status: 'stopped', reason };
    }
    if (batch.outcome === 'blocked') {
      const reason = batch.reason || '乘方开启被门槛阻止，未发出任何请求';
      rt.lastData = rt.lastData || {};
      rt.lastData.blockedReason = reason;
      this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: reason });
      this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason });
      return { status: 'blocked', reason, batch: this._summarizeBatch(batch) };
    }
    // nothing_to_enable / all_enabled_confirmed / partial → 记录批次
    this._recordBatch(shopCfg.id, batch);
    this._memPush(this.actions, { shopId: shopCfg.id, ...this._summarizeBatch(batch) });
    this._audit({ kind: 'action', shopId: shopCfg.id, ...this._summarizeBatch(batch) });
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

  _summarizeBatch(batch) {
    const allConfirmed = batch.allClosedConfirmed === true || batch.allPausedConfirmed === true;
    return {
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
      return {
        id: s.id,
        name: s.name || null,
        cookieFile: s.cookieFile,
        enabled: s.enabled !== false,
        cookieInfo,
        lastError: rt.lastError || null,
        today: rt.lastData || null,
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
        startedAt: this.startedAt,
        lastCycleAt: this.lastCycleAt,
        nextRunAt: this.schedule.nextRunAt,
        waitingFor08: this.schedule.waitingFor08,
        windowBlockReason: this.schedule.lastWindowBlockReason,
        dailyStartHour: this.config.schedule.dailyStartHour,
        intervalMinutes: this.config.schedule.intervalMinutes,
        enableHour: this._enableHour(),
        lastEnableDate: this._lastEnableDate,
        snapshotMaxAgeMinutes: this.config.monitor.snapshotMaxAgeMinutes,
        mockDataSource: this.config.monitor.mockDataSource === true,
        chengfang: (this.config.monitor && this.config.monitor.chengfang) || null,
        legacyWholeShopCloseEnabled: this._legacyWholeShopAllowed(),
      },
      shops,
      rules: this.config.rules || [],
      triggers: this.triggers.slice(-100).reverse(),
      actions: this.actions.slice(-100).reverse(),
      recentErrors: this.recentErrors.slice(-50).reverse(),
      promoReaderConnected: this._injectedReader ? this._injectedReader.connected : false,
    };
  }
}

module.exports = { Monitor, STATE_VERSION };
