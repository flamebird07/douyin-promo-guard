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
const { loadShopCookieMeta, resolveCookieFile, checkLoginByBrowser } = require('../login/session');
const { validateTargetRoi, DEFAULT_TARGET_ROI, validatePlansPerShop, DEFAULT_PLANS_PER_SHOP, resolveEffectivePlansPerShop } = require('../config');
const { createPromoReaderNotConnected, createMockPromoReader } = require('../adapters/promo-reader');
const { createAdControllerNotConnected, createMockAdController } = require('../adapters/ad-controller');
const { WholeShopCloseCoordinator } = require('./close-coordinator');
const { ChengfangRunner, defaultChengfangOpener } = require('./chengfang-runner');
const { readQianchuanBalanceInPage, balanceCentsFromPageResult, readChengfangCleanupEvidence, verifyChengfangReadOnlyEmpty } = require('../adapters/chengfang-reader');
const { resolvePollingConfig } = require('../lib/bounded-poll');
const { evidenceCode, isEmptyTableCode } = require('../lib/empty-inventory-evidence');
const { resolveChengfangRealAllowed, resolveChengfangEnableAllowed, resolveFirstCheckMinuteOfDay, firstCheckTimeText } = require('./chengfang-gate');
const { perOrderDisplayText, SPEND_FLOOR_CENTS } = require('./rules');
const { decideAdSwitchAction, DECISION } = require('./ad-switch-decision');
const { AdSwitchOrchestrator, createSwitchSerialGate } = require('./ad-switch-orchestrator');
const { mapAdStateFromAdList, mapAdStateFromSwitchRows, normalizeAdState } = require('./ad-switch-state');
const { discoverShopsFromCookies } = require('./shop-discovery');
const guard = require('./guard');
const { NotConnectedError, AuthError } = require('../lib/errors');
const { buildHoldLogFields } = require('../login/auth-failure-text');
const { shanghaiDate, shanghaiClockText, shanghaiWall, shanghaiMs, nextIntervalDelayMs } = require('../lib/time');
const { centsToYuan } = require('../lib/money');
const log = require('../lib/log');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', '..', 'data');
const STATE_VERSION = 2;
// 首查未完成/未确认时的有界重试节奏（与独立每日开启调度器 _enableLoop 的 RETRY_MS 一致）。
const ENABLE_RETRY_MS = 5 * 60 * 1000;
// fix2 有界收口：旧 enable 动作停在 unknown 串行门、且本轮回读始终 mixed（无法确认目标 on）时，
// 等待达到下列上限即按「未确认终态」结案（unknown_expired，confirmed 恒 false）并释放串行门，
// 今日不再自动补点——禁止无限等待一个永远无法核验的旧动作。
const SERIAL_GATE_MAX_WAIT_MS = 30 * 60 * 1000;
// fix3 对照店 checkLogin 的对照上限：串行窗口内最多启动 2 家已配置且 cookie 可用的对照店
// （每次一个新浏览器进程，checkLoginByBrowser 自带 finally 关闭）。都不通过 → 未结案。
const AUTH_CONTROL_MAX_SHOPS = 2;
// 传输层网络失败（Chromium/Playwright net::ERR_* 与底层 socket 错误码）：与页面内容、登录态、
// 清单完整性无关的瞬时链路故障（连接被关闭/重置、断网、DNS 解析失败、socket hang up 等）。
// 这类原因必须由同轮一次重读 + 每店有限恢复链接管，否则本店挂到下一个 30 分钟周期。
// 仅作"可重试"识别：Auth/身份/Cookie/截止/清单不可重试等仍在调用处先行排除。
const TRANSPORT_READ_REASON_RE = /net::ERR_(?:CONNECTION_(?:CLOSED|RESET|ABORTED|REFUSED)|INTERNET_DISCONNECTED|NETWORK_CHANGED|NETWORK_IO_SUSPENDED|SOCKET_NOT_CONNECTED|ADDRESS_UNREACHABLE|NAME_(?:NOT_RESOLVED|RESOLUTION_FAILED)|PROXY_CONNECTION_FAILED|TEMPORARILY_REDIRECTED|EMPTY_RESPONSE|TIMED_OUT)|socket hang up|ECONN(?:RESET|REFUSED|ABORTED|TIMEDOUT)|ETIMEDOUT|EAI_AGAIN/;
// 商品自选首屏分页结束标记缺失（2026-10-22 独立验收边界）：常量字符串 + 对单次原始原因**严格相等**，
// 绝不做"包含即命中"的正则匹配——否则拼接过的组合文本会带着早已过期的短语把链错误续上。
// 允许它进入既有有界恢复链（新 session 只读全量重读；当次读数仍 blocked/zeroClick，绝不复用不完整 rows）。
// 不得泛化：其他 tab、第 2 页起、hasNext 为字符串/true、页码乱序、重复 ID、total 非法等一律不在此列。
const SUBSELECT_FIRST_PAGE_HASNEXT_NULL_REASON = '乘方「商品自选」第 1 页 hasNext=null：分页结束标记不明确，清单不完整';
// mixed 收敛视图（界面/推送文案）：mixed 只作过渡观测，永不算完成；三种态全部来自真实门闩/回读状态。
const MIXED_RECONCILE_TEXT = Object.freeze({
  pending_recheck: '待收敛',
  rejudging: '重新判定',
  retrying: '重试中',
  // 明确没有安排任何收敛动作（店铺停用/只读刷新、或等于阈值等合法零动作）：
  // mixed 仍是过渡观测、仍非完成态，但不得宣称"待收敛"（没有收敛被安排）。
  no_repair_scheduled: '混合（未安排收敛，非完成态）',
});

// ── AUTH-60S 登录证据硬化（FINAL 2026-11-02）─────────────────────────────
// **所有正向证据**（登录页 URL / 可见登录表单 / 可见登录控件 / 可见登录对话框）都必须
// 跨轮次**连续**观测 ≥ 本窗口才允许 AUTH 升级（requiresLogin=true / AuthError 文案①）；
// 短暂 /login（重定向延迟、SSO /login/common）与瞬时强 UI 一律不得立即 AUTH。
// body 文本「扫码登录」等与 hidden 控件永不单独构成 AUTH。中断时段不累计
// （离开正向证据/读取成功/无证据轮次 → 清零重计）。未满窗口：kind=read_failed、
// requiresLogin=false、用户可见文案固定「读取失败」（不显示观测进度类文案）。
const AUTH_LOGIN_URL_HOLD_MS = 60000;
// 四条固定文案（与 bill-manager 页面主提示同源；kind → 文案）：
//  ① 登录已失效，请重新登录   ② Cookie 缺失，请重新导入
//  ③ 读取失败                 ④ 读取超时，将自动重试
// CODE_FAIL 加严（2026-11-02）：对外提示一律不含扫码类结论（fix3-four 与默认路径同口径）。
const READ_FAILURE_HINTS = Object.freeze({
  auth: '登录已失效，请重新登录',
  cookie_invalid: 'Cookie 缺失，请重新导入',
  cookie_blocked: 'Cookie 缺失，请重新导入',
  identity: '读取失败',
  read_failed: '读取失败',
  timeout: '读取超时，将自动重试',
  retrying: null, // 行内 note 已带"正在重试"，不覆盖主文案
});
// CODE_FAIL 加严（2026-11-02）：fix3-four 路径（读取器已交付 authClosure 证据，结案与
// 未结案都会交付）的对外提示一律不含扫码类结论；两种终态各自固定一条文案。
const FIX3_AUTH_HINTS = Object.freeze({
  closed: '登录已失效（auth 已结案，不要求重新登录旁路）',
  open: '登录已失效（auth 未结案，不要求重新登录旁路）',
});

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
    // 值守补发钩子（2026-10-26 patrol-plan-refill）：仅在**完整完成**的普通数据周期
    // （ok=true 且至少一店真实处理）收口后异步触发；拒绝/跳过/中止/无启用店/UI 只读 GET
    // 一律不触发。回调异常绝不影响巡查结果与后续调度（publisher 侧失败不殃及值守）。
    this._onPollComplete = typeof opts.onPollComplete === 'function' ? opts.onPollComplete : null;
    this.delayFn = opts.delayFn || ((ms) => this._chunkedDelay(ms));
    this._injectedDelayFn = opts.delayFn || null; // 测试可控时钟：开启调度循环复用同一时钟门
    // AUTH-60S FINAL：shopId -> { key, kind, firstSeenAt }（正向证据连续观测窗口；
    // loginUrl 的 key 用 origin+pathname，纯强 UI 用稳定伪 key ui:form/ui:control/ui:dialog；
    // 同 key 连续命中保持起点，key 变化/离开正向证据/读取成功即清除，中断不累计）。
    this._authEvidenceWatch = new Map();
    // fix3：对照店 checkLogin 实现（测试注入；生产默认 session.checkLoginByBrowser）。
    // 只用于「当前店浏览器已关闭、下一店未启动」的串行窗口内排除全局误判。
    this._authControlLogin = typeof opts.authControlLogin === 'function' ? opts.authControlLogin : null;
    // fix3：结案证据对象 → 证据文件路径（同一份证据经 onAuthClosedOut 与错误路径各到一次，
    // 只落盘一次；写盘失败不缓存，后续路径可重试）。
    this._authClosureEvidenceFiles = new WeakMap();

    this.adapters = adapters || null;
    this._injectedReader = (adapters && adapters.reader) || null;
    this._injectedController = (adapters && adapters.controller) || null;
    this._coordinators = new Map(); // shopId -> WholeShopCloseCoordinator（跨周期保留在途请求登记）
    this._chengfangRunners = new Map(); // shopId -> ChengfangRunner（乘方主链路）
    this._chengfangOpener = opts.chengfangOpener || null; // 测试注入：本地 DOM fixture 会话开启器
    // 同店跨上下文浏览器会话互斥（PROMO-IMPL-E1）：发布/恢复入口持有的当日 shop/day lease。
    // 生产由 watch-drill 装配时注入 leaseDir + leaseExists(shopCfg, businessDate, leaseDir)；
    // 缺省 null = 不检查，行为与旧版完全一致（monitor 不直接依赖父仓文件/路径规则）。
    this._publishLeaseDir = typeof opts.leaseDir === 'string' && opts.leaseDir.trim() !== '' ? opts.leaseDir : null;
    this._publishLeaseExists = typeof opts.leaseExists === 'function' ? opts.leaseExists : null;
    // 全局浏览器操作排队锁（PROMO-IMPL-F1）：所有会打开该店浏览器的读取/开关动作在跨进程
    // 全局锁内执行，锁忙本轮跳过该店。生产由 watch-drill 注入 {acquire,release}（复用
    // promo-plan-scheduler 的文件锁原语）；缺省 null = 不排队，行为与旧版完全一致。
    this._globalBrowserLock = (opts.globalBrowserLock && typeof opts.globalBrowserLock.acquire === 'function')
      ? opts.globalBrowserLock : null;
    // 决策层 + 串行门外层（2026-09-22）：每日 07:00 开启 / 低于阈值开启 / 高于阈值暂停统一入口
    this._readAdState = opts.readAdState || null; // 测试注入：本轮回读 currentAdState
    this._switchOrchestrator = opts.switchOrchestrator || null; // 测试注入
    this._switchGate = opts.switchGate || null;

    this.running = false;
    this._gen = 0;               // 代数：stop/start 快速切换时防止多循环（暂停巡查）
    this._loopPromise = null;
    this._cycleRunning = false;
    this._activeTokens = new Set();
    this._shopProcessing = new Set(); // WD-NEW-1 并发收口：同店处理互斥（巡查/接管/每日开启/手动验证共用）
    this._shopActivity = new Map(); // 单店当前动作文本（与 _shopProcessing 同生命周期；2026-11-20 控制台「当前动作」列）

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

    // 首查门禁连续 mixed 观测：streak 仅保留进程内连续轮次；同店同业务日已告警键持久化，
    // 防止进程重启后对同一天重复告警。只做审计/通知信号，绝不参与任何开关决策。
    this._mixedStuckGateStreaks = new Map();

    const loaded = this._loadState();
    this.batches = loaded.batches || {}; // shopId -> date -> { runs:[], totals:{} }
    // 最近一次会话 Cookie 回写结果（仅元信息：条数/域名/冲突；绝不保存任何 Cookie 值）。
    // 不持久化：重启后清空，避免把上一进程的凭据状态当作本次会话的事实。
    this.lastCookieWriteback = null;
    this.enablePhase = loaded.enablePhase || {};
    this.mixedStuckGateAlerts = loaded.mixedStuckGateAlerts || {};
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
   * fix2：serial_gate / ad=mixed 的**有界收口**判定与执行。
   *
   * 触发前提（全部满足才可能收口）：
   *   1) 自动路径（手动验证不参与，避免人工操作被自动结案）；
   *   2) 本轮 unknown 槽位核验**未释放**（_tryResolveUnknownSlotWithFreshRead 未返回 resolved===true；
   *      该入口不可用时同样按槽位事实判定，不得因核验链缺失而永久阻塞）；
   *   3) 本轮回读严格为 mixed（旧 enable 目标 on 无法确认，也不是全量 off 可结案）；
   *   4) 槽位仍是 unknown、未结束、且 action=enable；
   *   5) 槽位等待 ≥ SERIAL_GATE_MAX_WAIT_MS。
   *
   * 收口语义：走 gate.expireUnknown（settledAs=unknown_expired，confirmed 恒 false）——
   * 只结束无限阻塞，不声明目标达成、不声明历史点击因果；本轮零点击，今日不再自动补点。
   * 未达等待上限则返回 null（保持既有 unknown 有界重试）。
   *
   * @returns {null|{actionId:string, waitedMs:number, reason:string}}
   */
  _expireUnresolvedSerialGateIfBounded(shopCfg, today, unknownResolve, observedState, source) {
    if (source === 'manual_verify') return null;
    // unknownResolve=null 表示核验入口不可用/无槽位，不等于「已释放」：仍须按槽位事实有界收口。
    if (unknownResolve && unknownResolve.resolved === true) return null;
    if (observedState !== 'mixed') return null;
    const orch = this._switchOrchestrator;
    if (!orch || typeof orch.peek !== 'function' || typeof orch.expireUnknownSlot !== 'function') return null;
    const slot = orch.peek(shopCfg.id);
    if (!slot || slot.unknown !== true || slot.settled === true || slot.action !== 'enable') return null;

    const startedAt = Number(slot.startedAt);
    const waitedMs = Number.isFinite(startedAt) ? Math.max(0, this.nowFn() - startedAt) : 0;
    const maxWaitMs = Number(this._serialGateMaxWaitMs) || SERIAL_GATE_MAX_WAIT_MS;
    if (waitedMs < maxWaitMs) return null;

    const reason = `serial_gate 有界收口：旧 enable 动作 ${slot.actionId} 等待 ${Math.round(waitedMs / 60000)} 分钟后结果仍未确认（本轮回读 mixed，既不能确认目标 on，也不是全量 off 可结案）；按「未确认终态」结案（unknown_expired，未确认、不声明历史点击因果）并释放串行门，本轮零点击、今日不再自动补点，下次开启窗口按新鲜回读重新判定`;
    const r = orch.expireUnknownSlot(shopCfg.id, slot.actionId, {
      reason,
      actions: ['enable'],
      persist: () => this._saveState(),
    });
    if (!r || r.ok !== true) {
      this._audit({
        kind: 'ad-switch', step: 'serial-gate-bounded', shopId: shopCfg.id, ok: false,
        actionId: slot.actionId, waitedMs,
        reason: `有界收口未生效（保持阻塞）：${(r && r.reason) || '未知'}`,
      });
      return null;
    }
    this._audit({
      kind: 'ad-switch', step: 'serial-gate-bounded', shopId: shopCfg.id, ok: true,
      actionId: slot.actionId, waitedMs, observedAdState: observedState,
      settledAs: 'unknown_expired', confirmed: false, reason,
    });
    return { actionId: slot.actionId, waitedMs, reason };
  }

  /**
   * fix3：auth 结案前先落盘证据包（四份健康表/判定/对照店结论，绝不含 Cookie value）。
   * 写盘失败不改变结案判定，但会留审计；返回证据文件路径（失败 null）。
   */
  _writeAuthClosureEvidence(shopId, evidence) {
    if (!evidence || typeof evidence !== 'object') return null;
    try {
      const dir = path.join(this.dataDir, 'auth-evidence');
      fs.mkdirSync(dir, { recursive: true });
      const ts = new Date(this.nowFn()).toISOString().replace(/[:.]/g, '-');
      const safe = String(shopId).replace(/[^\w\u4e00-\u9fa5.-]/g, '_');
      const file = path.join(dir, `${safe}-${ts}.json`);
      fs.writeFileSync(file, JSON.stringify(evidence, null, 2), 'utf8');
      this._audit({
        kind: 'auth-closure', shopId, step: 'evidence-written',
        file: path.basename(file), authClosedOut: evidence.authClosedOut === true,
      });
      return file;
    } catch (_) {
      return null;
    }
  }

  /**
   * fix3：auth 结案后的串行门释放（不是动作达成声明）。
   *
   * 仅当读取器已交付 `authClosure.authClosedOut === true`（固定四份候选均不可用 +
   * 对照店 checkLogin 已排除全局误判）时调用：把该店遗留的 unknown 串行槽按
   * unknown_expired（confirmed 恒 false）结案并释放，避免登录失效把本店后续动作
   * 永久堵在门上。只影响该店，不动其他店的门；无 unknown 槽则零动作。
   *
   * @returns {null|{ok:boolean, reason?:string, settledAs?:string}}
   */
  _releaseSerialGateForAuthClosure(shopId, closure) {
    const orch = this._switchOrchestrator;
    if (!orch || typeof orch.peek !== 'function' || typeof orch.expireUnknownSlot !== 'function') return null;
    const slot = orch.peek(shopId);
    if (!slot || slot.settled === true || slot.unknown !== true) return null;
    const conclusion = closure && closure.evidence && closure.evidence.conclusion
      ? String(closure.evidence.conclusion)
      : '固定四份候选均不可用且已排除代码误判';
    const reason = `auth 结案后释放串行门：${conclusion}；按未确认终态结案（不声明动作达成），本轮零点击，不堵后续店铺`;
    const r = orch.expireUnknownSlot(shopId, slot.actionId, {
      reason,
      actions: ['enable', 'pause'],
      persist: () => this._saveState(),
    });
    this._audit({
      kind: 'auth-closure', shopId, step: 'release-serial-gate',
      ok: !!(r && r.ok === true), actionId: slot.actionId,
      settledAs: (r && r.settledAs) || null, confirmed: false,
      reason: (r && r.reason) || reason,
    });
    return r;
  }

  /**
   * fix3：结案证据的统一收口（幂等）。onAuthClosedOut 回调与错误路径（err.authClosure）
   * 携带的是同一份证据对象：只写一次证据包；authClosedOut===true 时再释放该店串行门。
   * 证据未落盘则保持串行门阻塞（fail-closed），不改变读取错误语义。
   *
   * @returns {{written:boolean, file:string|null}}
   */
  _settleAuthClosure(shopId, closure) {
    if (!closure || !closure.evidence || typeof closure.evidence !== 'object') {
      return { written: false, file: null };
    }
    const evidence = closure.evidence;
    let file = this._authClosureEvidenceFiles.get(evidence) || null;
    if (!file) {
      try { file = this._writeAuthClosureEvidence(shopId, evidence); } catch (_) { file = null; }
      if (file) this._authClosureEvidenceFiles.set(evidence, file);
    }
    if (file && closure.authClosedOut === true) {
      try { this._releaseSerialGateForAuthClosure(shopId, closure); } catch (_) { /* 释放失败不改变结案事实 */ }
    }
    return { written: !!file, file };
  }

  /**
   * fix3：读取器恢复链的对照店接线（按店铺绑定）。
   *
   * - restoreControlCheck：全候选不可用时，在「当前店浏览器已关闭、下一店未启动」的串行
   *   窗口内，对另一家已配置且 cookie 可用的对照店跑 checkLogin；通过才允许 auth 结案。
   * - onAuthClosedOut：结案证据一到即走 _settleAuthClosure（落盘 + 释放该店串行门），
   *   与错误路径共用幂等收口，不重复写盘。
   *
   * 未登记 authRecoveryPolicy 的店铺不会进入 fix3 恢复链，这两个选项对其零影响。
   */
  _authRecoveryWiring(shopCfg) {
    const shopId = shopCfg && shopCfg.id ? String(shopCfg.id) : null;
    if (!shopId) return {};
    return {
      restoreControlCheck: (ctx) => this._authControlCheck(shopCfg, ctx || {}),
      onAuthClosedOut: async (evidence) => {
        this._settleAuthClosure(shopId, { authClosedOut: true, evidence });
      },
    };
  }

  /**
   * fix3：对照店 checkLogin（排除代码误判/全局登录失效）。
   *
   * 调用窗口由读取器保证：当前店店铺浏览器已关闭并获证明后才进入恢复链。
   * 跨店互不阻塞（他店处理在途不影响本店对照检查）。对照店必须已配置、未删除、
   * cookie 文件可解析且未过期；checkLogin 用独立浏览器进程，函数返回前必然关闭。
   *
   * @returns {Promise<{ok:boolean, reason:string, shop:string|null}>}
   */
  async _authControlCheck(shopCfg, ctx = {}) {
    const selfId = shopCfg && shopCfg.id ? String(shopCfg.id) : null;
    const shopSafeName = ctx && ctx.shopSafeName ? String(ctx.shopSafeName) : null;
    const fail = (reason) => {
      this._audit({ kind: 'auth-closure', step: 'control-check', shopId: selfId, shopSafeName, ok: false, reason });
      return { ok: false, reason, shop: null };
    };
    const loginCfg = this.config.login || {};
    const shops = (this.config.shops || [])
      .filter((s) => s && s.deleted !== true && s.cookieFile && String(s.id) !== selfId)
      // 已启用的店优先，其余保持配置顺序（确定性选择，不随机挑对照店）。
      .sort((a, b) => Number(b.enabled !== false) - Number(a.enabled !== false));
    if (shops.length === 0) {
      return fail('无其他已配置店铺可作对照：未完成误判排除（不结案）');
    }
    const login = this._authControlLogin || checkLoginByBrowser;
    const tried = [];
    for (const s of shops.slice(0, AUTH_CONTROL_MAX_SHOPS)) {
      let resolved;
      try {
        // 过期/缺失/不可解析 → 该店 cookie 不可用，换下一家（绝不据此结案）。
        loadShopCookieMeta(loginCfg, s);
        resolved = resolveCookieFile(loginCfg, s.cookieFile);
      } catch (_) {
        tried.push(`${s.id}（cookie 不可用）`);
        continue;
      }
      let r;
      try {
        r = await login(loginCfg, resolved.path);
      } catch (_) {
        tried.push(`${s.id}（checkLogin 异常）`);
        continue;
      }
      if (r && r.loggedIn === true) {
        const reason = `对照店「${s.id}」checkLogin 通过：排除全局误判`;
        this._audit({ kind: 'auth-closure', step: 'control-check', shopId: selfId, shopSafeName, ok: true, controlShop: s.id, reason });
        return { ok: true, reason, shop: s.id };
      }
      tried.push(`${s.id}（checkLogin 未通过）`);
    }
    return fail(`对照店 checkLogin 未通过/不可用（${tried.join('、')}）：未完成误判排除（不结案）`);
  }

  /**
   * 今日是否仍需执行开启相位。
   * success（正常开启确认）或 mixed_converged（首查入口经有证据的 mixed 交接、本轮完整回读
   * 确认已收敛到统一态）均视为"今日已处理"（不再强制重开）；失败/unknown 允许在窗口内按规则
   * 再处理，但 unknown 必须先回读确认，见 _runEnablePhase。
   * exhausted（fix2 有界收口：serial_gate 超次数/超时后按未确认终态结案）同样是**当日终态**：
   * 不再自动补点，避免对同一个永远无法核验的旧动作无限重试；次日窗口按新鲜回读重新判定。
   */
  _enablePhaseDone(shopId, date) {
    const rec = this.getEnablePhaseRecord(shopId, date);
    return !!(rec && (rec.status === 'success' || rec.status === 'mixed_converged' || rec.status === 'exhausted'));
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
        mixedStuckGateAlerts: this.mixedStuckGateAlerts || {},
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
   * （跨日仍按 dailyStartHour 规则，由 nextIntervalDelayMs 统一处理；首查由独立调度器在 00:05 处理）。
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
    // 2026-10-09 R2：与 _intervalLoop 一致——首查窗口配置时跨日目标为首查时刻（次日 00:05 唤醒
    // 首查+巡查），而非旧 dailyStartHour（08:00）。修复阈值联动重排在 23:50 后跨日时把下一次
    // 首查完成后的费比巡查推迟到 08:00 的缺陷；无首查配置时保留旧 dailyStartHour 跨日目标。
    const enableWindow = this._enableWindowConfigured();
    const crossDayMinute = enableWindow ? this._firstCheckMinuteOfDay() : null;
    const nd = nextIntervalDelayMs(this.nowFn(), lastRun, sch.intervalMinutes, sch.dailyStartHour, null, crossDayMinute);
    this.schedule.lastRunAt = new Date(lastRun).toISOString();
    this.schedule.nextRunAt = new Date(nd.nextRunAt).toISOString();
    this.schedule.waitingFor08 = nd.crossDay && !enableWindow; // 首查配置时不再等 08:00
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
    log.info(`监控已启动（${this.modeLabel}，活动店铺 ${activeShopCount} 家，启动即巡查，之后每 ${this.config.schedule.intervalMinutes} 分钟；暂停无每日时段门槛）`);
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
    // 2026-10-09：00:05 后只要在线就检查（晚开机补检查）。今日窗口已开（>= 00:05）→
    // 立即登记为"已到点"（nextRunAt=now，arrived=true），循环据此判断当日是否已完成：
    // 已完成（per-shop+date success）→ 登记次日 00:05；未完成 → 立即执行首查（暂停才开启，
    // 已开启零点击记完成）。今日窗口未到（00:00–00:04:59）→ 登记今日 00:05 等待。
    const nowMs0 = this.nowFn();
    const todayWindowMs = shanghaiMs(shanghaiWall(nowMs0).date, this._firstCheckTimeText());
    const nextMs = nowMs0 >= todayWindowMs ? nowMs0 : this._nextEnableWindowStartMs(nowMs0);
    this._enableSchedule.nextRunAt = new Date(nextMs).toISOString();
    const nextClock = shanghaiClockText(nextMs);
    this._audit({ kind: 'enable-scheduler', event: 'registered', nextRunAt: this._enableSchedule.nextRunAt, reason: opts.reason || null });
    log.info(`独立每日首次开启检查已登记（每日 ${this._firstCheckTimeText()} 后检查当天是否暂停，暂停才作为当天首次开启；已开启零点击记完成；无小时上界，晚开机补检查；下次 ${nextClock}；与"启动值守"相互独立）`);
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

  /** 下一次首次开启检查窗口起点（上海 firstCheckTime，配置缺省 00:05）的绝对毫秒时间。
   *  今日窗口起点已过 → 明日同一时刻（用于完成后登记次日，杜绝 busy-loop）。 */
  _nextEnableWindowStartMs(nowMs) {
    const w = shanghaiWall(nowMs);
    const hm = this._firstCheckTimeText();
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
    const hhmm = this._firstCheckTimeText();
    const reason = `${date} 首查窗口（上海 ${hhmm} 起至当日结束）已全部过去且当日未执行开启：不擅自补开广告，等待次日窗口`;;
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
   * 独立每日首次开启检查循环：等待每日 firstCheckTime（默认 00:05）起的当日窗口 → 执行开启相位
   * （复用 _runEnablePhase：按店铺+日期持久化、成功不重复、unknown 先回读）。
   * 2026-10-09：取消 enableHour/07:00 固定开启、改 00:05 后检查，无小时上界——服务在当日
   * 00:05 之后启动时 nextRunAt=now（已到点），立即判断当日是否已完成：已完成（per-shop+date
   * success）→ 登记次日 00:05；未完成 → 立即首查（晚开机补检查）。
   * 执行后：全部 success → 登记次日 firstCheckTime；仍有未完成 → 5 分钟后有界重试（跨日自然停）。
   * 与暂停巡查循环（_intervalLoop）并存；生命周期独立——"停止值守"不影响本循环。
   * 并发安全由每店 _shopProcessing 互斥保证，不再使用全局周期布尔（批次二收敛）。
   */
  async _enableLoop(gen) {
    const sch = this.config.schedule;
    while (gen === this._enableGen && this.enableRunning) {
      const now = this.nowFn();
      const w = shanghaiWall(now);
      const nrMs = Date.parse(this._enableSchedule.nextRunAt || '');
      const windowOpen = this._dailyFirstCheckOpen(w);
      const today = w.date;
      const shopsToRun = windowOpen
        ? this._activeShops().filter(
          (s) => !this._enablePhaseDone(s.id, today),
        )
        : [];
      // 活动店在首查窗口开启后加入/恢复时，旧 nextRunAt 可能仍指向次日。
      // 只要今天尚有未完成店，就视为已到点，复用既有首查链；nextRunAt 不得把它挂到次日。
      const scheduledDue = Number.isFinite(nrMs) && now >= nrMs;
      const scheduledBeyondRetryBound = !Number.isFinite(nrMs) || nrMs - now > ENABLE_RETRY_MS;
      // 合法的当日 +5min 重试点仍须等到点；只有缺失/超出有界复查范围（典型为误排到次日）
      // 才由未完成活动店覆盖，以免提前唤醒导致无间隔重复首查。
      const arrived = scheduledDue || (shopsToRun.length > 0 && scheduledBeyondRetryBound);
      if (windowOpen && arrived) {
        if (shopsToRun.length > 0) {
          this._enableSchedule.phase = 'enable_window';
          try {
            await this._runEnablePhase(gen, today);
            this._enableSchedule.lastRunAt = new Date(this.nowFn()).toISOString();
          } catch (e) {
            this._memPush(this.recentErrors, { scope: 'enable-scheduler', error: `每日开启任务异常：${e.message}` }, undefined, 'error');
          }
        } else {
          // 今日全部店铺已 success → 等次日 firstCheckTime（不重复开启）
          this._enableSchedule.phase = 'enable_window';
        }
        const afterMs = this.nowFn();
        const afterWall = shanghaiWall(afterMs);
        if (afterWall.date !== w.date) continue; // 执行中跨日：回环重判（窗口外逻辑登记明日）
        const still = this._activeShops().some((s) => !this._enablePhaseDone(s.id, today));
        if (still) {
          // 有未完成店：有界重试（RETRY_MS 后再试；跨日由回环窗口判定自然停止）
          const retryAt = afterMs + ENABLE_RETRY_MS;
          this._enableSchedule.nextRunAt = new Date(retryAt).toISOString();
          await this._enableDelay(ENABLE_RETRY_MS, gen);
          continue;
        }
        const targetMs = this._nextEnableWindowStartMs(afterMs);
        this._enableSchedule.phase = 'waiting_window';
        this._enableSchedule.nextRunAt = new Date(targetMs).toISOString();
        await this._enableDelay(Math.min(ENABLE_RETRY_MS, Math.max(0, targetMs - afterMs)), gen);
        continue;
      }
      // ── 窗口外 / 未到点 ──
      if (!this._dailyFirstCheckOpen(w)) {
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
      await this._enableDelay(Math.min(ENABLE_RETRY_MS, Math.max(0, targetMs - now)), gen);
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
   * 费比暂停巡查循环（2026-10-09 R1，S2 2026-11-08）：
   * - 费比巡查无首查/时段门槛：启动即查，之后严格按 intervalMinutes；跨日也不等待固定时刻。
   * - 每日开启是独立相位，统一由独立 _enableLoop 调度，本循环不承载任何开启路径。
   * 停止/重启通过代数防止多循环；所有等待用 delayFn（可注入时钟门）。
   */
  async _intervalLoop(gen) {
    const sch = this.config.schedule;
    const enableWindow = this._enableWindowConfigured();
    // R5：nextPatrolDueMs 是本循环的已完成店费比巡查到期时刻（绝对 ms）。
    // 规则：
    //  0 = 尚未建立 → 首次有机会立即巡查一次；
    //  未到点绝不 pollOnce（不拉已完成店费用/订单/广告、不派发动作）；
    //  仅"实际完成一次费比 poll"后按 intervalMinutes 更新到期；
    //  外部阈值重排（_scheduleEpoch 变化）把到期 rebase 到最新 schedule.nextRunAt 的"精确目标"（不用 min，
    //  以免保留已过时的旧到期 → R5-2）。
    // 这样可根除"只在混合分支守 due、通用尾巴却无条件 poll"（R5-1/R5-3）以及"min 保留旧到期"（R5-2）。
    let nextPatrolDueMs = 0;
    while (gen === this._gen && this.running) {
      const now = this.nowFn();
      // 费比暂停巡查无每日窗口门槛：启动即查，之后只按 intervalMinutes 节流。
      // 每日开启统一由独立 _enableLoop 调度，本循环不再承载开启路径。
      this.schedule.phase = 'running';
      this.schedule.waitingFor08 = false;

      // 到期才实际巡查（pollOnce 内部按店首查安全门禁：pending 店 window_blocked/零广告写入，done 店正常费比）。
      const dueNow = nextPatrolDueMs === 0 || now >= nextPatrolDueMs;
      if (dueNow) {
        // 停止后立即启动时旧周期可能仍在途：等其退出再跑，不把互斥跳过当作已巡查而盲目推迟半小时。
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
        // 完成一次真实费比巡查后严格按配置间隔更新；跨日不等待首查或 dailyStartHour。
        nextPatrolDueMs = lastRun + (sch.intervalMinutes * 60 * 1000);
      }

      // 下一次唤醒：到费比巡查到期。
      const nowAfter = this.nowFn();
      const wakeMs = nextPatrolDueMs;
      const waitMs = Math.max(0, wakeMs - nowAfter);
      const epochBefore = this._scheduleEpoch || 0;
      this.schedule.nextRunAt = new Date(wakeMs).toISOString();
      if (enableWindow && shanghaiWall(wakeMs).date !== shanghaiWall(nowAfter).date) this.schedule.phase = 'waiting_window';
      await this.delayFn(waitMs, gen);
      if (gen !== this._gen || !this.running) return;
      // R5-2：挂起期间发生外部阈值重排（pollNowAndReschedule 改写 nextRunAt 并 bump epoch）→
      // 以最新外部"精确目标" rebase 共享到期，绝不用 min 保留已过时的旧到期（否则会在旧 00:36 误巡查）。
      if ((this._scheduleEpoch || 0) !== epochBefore) {
        const extTarget = Date.parse(this.schedule.nextRunAt || '');
        if (Number.isFinite(extTarget)) {
          nextPatrolDueMs = extTarget;
          this.schedule.lastWindowBlockReason = `阈值联动重排生效：费比巡查到期 rebase 到最新调度 ${this.schedule.nextRunAt}`;
        }
        continue;
      }
    }
  }

  _pruneMixedStuckGateStreaks() {
    const active = new Set(this._activeShops().map((s) => String(s.id)));
    for (const key of this._mixedStuckGateStreaks.keys()) {
      const shopId = String(key).split('\u0000', 1)[0];
      if (!active.has(shopId)) this._mixedStuckGateStreaks.delete(key);
    }
  }

  /**
   * 同店同业务日连续 3 个完整 poll 结论均为 mixed + 首查门禁时，只发一次审计信号。
   * 通知由 watch-drill 消费该 process event 并复用既有 Hermes 通道；本方法不触发任何广告动作。
   */
  _observeMixedStuckGate(shopId, result) {
    const id = String(shopId == null ? '' : shopId);
    if (!id || !this._isShopActive(shopId)) {
      for (const key of this._mixedStuckGateStreaks.keys()) {
        if (String(key).startsWith(`${id}\u0000`)) this._mixedStuckGateStreaks.delete(key);
      }
      return;
    }
    const businessDate = (result && /^\d{4}-\d{2}-\d{2}$/.test(String(result.businessDate || '')))
      ? String(result.businessDate)
      : shanghaiDate(this.nowFn());
    const key = `${id}\u0000${businessDate}`;
    // 业务日切换后旧 streak 不得继续累计；daily alerted 另行持久化并保留有限历史。
    for (const oldKey of this._mixedStuckGateStreaks.keys()) {
      if (oldKey !== key && String(oldKey).startsWith(`${id}\u0000`)) this._mixedStuckGateStreaks.delete(oldKey);
    }
    const matched = !!(result && result.status === 'window_blocked' && result.currentAdState === 'mixed');
    if (!matched) {
      this._mixedStuckGateStreaks.delete(key);
      return;
    }
    const consecutive = (this._mixedStuckGateStreaks.get(key) || 0) + 1;
    this._mixedStuckGateStreaks.set(key, consecutive);
    const byDate = (this.mixedStuckGateAlerts[id] = this.mixedStuckGateAlerts[id] || {});
    if (consecutive < 3 || byDate[businessDate]) return;

    byDate[businessDate] = { at: new Date(this.nowFn()).toISOString(), consecutive };
    const dates = Object.keys(byDate).sort();
    while (dates.length > 7) delete byDate[dates.shift()];
    this._saveState(); // 告警去重尽力持久化；失败也不得阻塞巡查或引入任何点击。
    this._audit({
      kind: 'poll', step: 'mixed-stuck-gate', shopId, businessDate,
      consecutive, status: 'window_blocked', currentAdState: 'mixed', zeroClick: true,
      reason: '连续 3 轮广告状态 mixed 且被当日首查安全门禁拦截，需人工关注首查收敛链',
    });
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
    let completed = null;
    // 巡查周期序号（2026-09-15 修复第 3 项）：一次 pollOnce = 一个完整周期，序号明确递增。
    this.cycleNo += 1;
    const cycleNo = this.cycleNo;
    this._currentCycle = { cycleNo, trigger, startedAt: this.nowFn() };
    try {
      // 同轮跨店严格串行（D24 2026-10-29 用户最新要求，取代 2026-09-28 两店有界并行）：
      // 店铺按配置顺序一家处理完（读取/决策/动作/回读收口）再启动下一家，
      // 与商品分析批处理的逐店 Playwright 生命周期（开页→处理→finally browser.close）对齐。
      // 同一家店仍由每店处理互斥 + 串行门保证开关不并发。
      // 结果仍按配置顺序归集；停止后不再启动队列中的店；单店失败不影响另一店。
      // 不使用 Promise.race 假装取消在途页面读取——已启动的 _pollShop 自然结束。
      const shops = this._activeShops();
      const results = new Array(shops.length);

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
        // 同店处理互斥（WD-NEW-1 并发收口）：该店正被登录接管/每日开启/手动验证处理 → 本轮跳过
        // （零派发、如实记录；不阻塞其他店铺；该店由在途处理负责，下一轮常规巡查再核）
        if (this._shopBusy(shopCfg.id)) {
          results[idx] = { shopId: shopCfg.id, status: 'skipped', reason: '该店已有处理在途（登录接管/每日开启/手动验证），本轮跳过避免同店并发' };
          this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'skipped', reason: 'shop-processing-busy' });
          return;
        }
        if (!this._tryAcquireShop(shopCfg.id, '值守巡查处理中')) {
          results[idx] = { shopId: shopCfg.id, status: 'skipped', reason: '同店处理互斥获取失败（并发防御），本轮跳过' };
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
        } finally {
          this._releaseShop(shopCfg.id);
        }
      };

      // 严格串行：上一家 _pollShop（含其内部读取/动作/回读与 finally 收口）完成后才启动下一家
      for (let i = 0; i < shops.length; i += 1) await runOne(shops[i], i);

      // 防御：极端情况下若有空槽，按配置顺序补齐 skipped（不伪造成功）
      for (let i = 0; i < results.length; i += 1) {
        if (results[i] === undefined) {
          results[i] = { shopId: shops[i].id, status: 'skipped', reason: '本轮未处理（并行收口遗漏，如实记录）' };
        }
      }

      // 只观察每店本轮最终结论；非匹配轮重置 streak，已告警的同日去重键保持。
      this._pruneMixedStuckGateStreaks();
      for (let i = 0; i < shops.length; i += 1) this._observeMixedStuckGate(shops[i].id, results[i]);

      this.lastCycleAt = new Date(this.nowFn()).toISOString();
      completed = { ok: true, trigger, cycleNo, results };
      return completed;
    } finally {
      this._activeTokens.delete(token);
      this._cycleRunning = false;
      this._currentCycle = null;
      // 收口后再触发值守补发检查：此时 _cycleRunning 已清、各店处理锁已释放，
      // 回调只做非阻塞入队（如隐藏子进程触发独立发布器），绝不在巡查路径内等待发布。
      // patrol-plan-refill 返修：被停止/中止（token.aborted）的周期即使此前已有店真实处理，
      // 也不是"完整完成的数据周期"，绝不触发补发——数据快照可能停在中途，补发检查必须
      // 只挂在未被中止的完整周期上。
      if (completed && !token.aborted && this._onPollComplete) {
        const eligible = Array.isArray(completed.results)
          && completed.results.some((x) => x && x.status !== 'skipped');
        if (eligible) {
          try {
            const maybe = this._onPollComplete({
              cycleNo: completed.cycleNo, trigger: completed.trigger, at: this.nowFn(),
              shops: Array.isArray(completed.results) ? completed.results.length : 0,
            });
            if (maybe && typeof maybe.catch === 'function') maybe.catch(() => { /* 回调自身失败不影响巡查 */ });
          } catch (e) {
            try { this._audit({ kind: 'poll', status: 'warn', reason: 'on-poll-complete-error:' + ((e && e.message) || e) }); } catch (_) { /* 审计失败也不再外抛 */ }
          }
        }
      }
    }
  }

  // ── 适配器/协调器 ────────────────────────────────────────────────
  _makeReader(shopCfg) {
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
    // fix3 生产接线：千川 cost/ad 与罗盘 order 的恢复链共享同一对按店铺绑定的选项。
    // 未登记 authRecoveryPolicy 的店铺不会进入 fix3 恢复链，接线对其零影响。
    const authRecovery = this._authRecoveryWiring(shopCfg);
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
        // 2026-10-18：会话 Cookie 检查点/回写审计接入既有 _audit（此前未传，回写事件
        // 不落到审计文件与事件流）。仅接线，不改调度/动作/读取语义。
        audit: (e) => this._audit(e),
        // fix3：全候选不可用时对照店 checkLogin + 结案回调（详见 _authRecoveryWiring）。
        ...authRecovery,
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
      // 2026-10-18：罗盘收尾检查点回写审计同样接入 _audit（此前未传，事件不落审计）。
      orderReader = createCompassOrderReader({
        loginCfg: this.config.login, nowFn: this.nowFn, audit: (e) => this._audit(e), ...authRecovery,
      });
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
        reader: this._injectedReader || this._makeReader(shopCfg),
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

  /** 每日首次开启检查的当天最早时刻（分钟，0–1439；配置缺省 5 = 00:05，Asia/Shanghai）。
   *  2026-10-09 取消 07:00 固定开启、改 00:05 后检查；enableHour 不再参与调度。 */
  _firstCheckMinuteOfDay() {
    const cf = this.config.monitor && this.config.monitor.chengfang;
    return resolveFirstCheckMinuteOfDay(cf);
  }

  /** 首查时刻展示文本（HH:MM，上海）。 */
  _firstCheckTimeText() {
    const cf = this.config.monitor && this.config.monitor.chengfang;
    return firstCheckTimeText(cf);
  }

  /** 上海墙上时间是否已过当日首查时刻（>= firstCheckMinuteOfDay）。 */
  _dailyFirstCheckOpen(w) {
    return (w.hour * 60 + (w.minute || 0)) >= this._firstCheckMinuteOfDay();
  }

  /** 是否启用每日首次开启相位（与暂停共用乘方范围配置；窗口 [00:05, 当日结束]）。 */
  _enableWindowConfigured() {
    return this._chengfangScopeConfigured();
  }

  /**
   * 是否启用了独立每日首查调度器（enableSchedulerEnabled=true）。
   * 2026-10-09 R1：首查安全门禁仅在调度器实际启用时生效——
   * 未启用调度器时（如纯费比测试），费比控制不受首查安全门禁拦截，保留旧行为。
   */
  _enableSchedulerConfigured() {
    const cf = (this.config.monitor && this.config.monitor.chengfang) || {};
    return cf.enableSchedulerEnabled === true;
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
    const evaluation = (data && data.evaluation) || null;
    // 消耗门槛已取消（D55）；ROI 提示由规则/决策投影，消费方（日志/页面）不重算金额。
    const spendProtected = decision ? decision.spendProtected === true
      : (evaluation ? evaluation.spendProtected === true : null);
    const pauseEligible = decision ? decision.pauseEligible === true
      : (evaluation ? evaluation.pauseEligible === true : false);
    const roiTooLow = decision ? decision.roiTooLow === true
      : (evaluation && status !== 'blocked' ? evaluation.roiTooLow === true : false);
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
      // 兼容投影：spendFloorCents=0 且 spendProtected=false（无消耗门槛）；pauseEligible=严格超标；roiTooLow=仅提示不自动改 ROI
      spendFloorCents: SPEND_FLOOR_CENTS,
      spendProtected,
      pauseEligible,
      roiTooLow,
      // 决策层标签（metric/decision 分离；currentAdState 只来自本轮回读）
      currentAdState: currentAdState || null,
      metric: (decision && decision.metric) || null,
      decision: (decision && decision.decision) || null,
      zeroClick: decision ? decision.zeroClick !== false : undefined,
      perOrderText: (data && data.cost && data.orders && typeof costCents === 'number' && orders > 0)
        ? perOrderDisplayText(costCents, orders) : null,
      // mixed 只作过渡观测：推送/界面须显式呈现待收敛/重新判定/重试中，不得呈现为一次成功
      mixedReconcile: currentAdState === 'mixed' ? this._mixedReconcileView(shopCfg.id) : null,
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
  /**
   * 未删除店铺清单（调度/手动操作的唯一活动范围）。
   * D56：取消单店停用后，活动范围只由软删除决定；是否巡查由全局开关
   * （this.running / enableRunning）统一控制，历史 enabled=false 不再生效。
   */
  _activeShops() {
    return (this.config.shops || []).filter((s) => s && s.deleted !== true);
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
   * WD-NEW-1（2026-10-02）：新增 `opts.force`——事件驱动的立即发现（如登录成功后接管新店）
   * 绕过 2s 节流。节流仍保护周期性 /state 拉取路径（无参调用行为完全不变）。
   * @returns {{ok:boolean, throttled?:boolean, added?:string[], persisted?:boolean, pending?:boolean, reason?:string|null}} 摘要（供测试与日志）
   */
  requestShopDiscovery(opts = {}) {
    const now = this.nowFn();
    const minInterval = 2000;
    if (!((opts && opts.force === true))
      && this._lastShopDiscoveryAt && now - this._lastShopDiscoveryAt < minInterval) {
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
        scannedDirs: r.scannedDirs,
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
    // AD-WATCHDOG-TEST-ISOLATION-20261020：把配置的隔离工作根显式注入发现扫描；
    // 测试上下文缺少工作根时由 shop-discovery fail-closed，绝不默认扫描生产 cookies/。
    const workDir = typeof loginCfg.cookieWorkDir === 'string' && loginCfg.cookieWorkDir.trim()
      ? loginCfg.cookieWorkDir.trim() : undefined;
    const r = discoverShopsFromCookies({
      loginCfg,
      shops: this.config.shops || [],
      ...(workDir ? { projectCookiesDir: workDir } : {}),
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

  restoreDeletedShop(shopId) {
    const { resolveRestoreTarget, restoreShopConfig } = require('./shop-restore');
    const target = resolveRestoreTarget(this.config.shops, shopId);
    if (!target.ok) {
      return { ok: false, restored: false, persisted: false, code: target.code, reason: target.code };
    }
    const result = restoreShopConfig({
      configPath: this.cfgResult && this.cfgResult.sourcePath,
      auditPath: this.auditFile,
      shopId,
      expectedShops: this.config.shops,
    });
    if (result.restored && result.persisted === true) {
      target.entry.deleted = false;
      target.entry.enabled = false;
    }
    return result.ok ? { ...result, entry: target.entry } : { ...result, reason: result.code };
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
   * 余额（2026-09-27，账户级只读展示字段）写入 target（可为未提交的 candidate）：
   * 本轮读取失败/缺失 → balanceCents=null（界面显示"未知"），不沿用旧值伪装成本轮新读数；
   * 终态三字段：balanceStatus='ok'|'error'|'missing'|'skipped'，balanceReason 仅非 ok 时有值。
   * 绝不进入费用/订单/阈值/开关判定与通知判断。
   */
  _applyBalanceToLastData(target, stateRead) {
    if (!target) return;
    const bal = stateRead && stateRead.balance ? stateRead.balance : null;
    if (bal && bal.balanceCents != null) {
      target.balanceCents = bal.balanceCents;
      target.balanceAt = bal.balanceAt || null;
      target.balanceStatus = 'ok';
      target.balanceReason = null;
    } else if (bal && bal.reason) {
      target.balanceCents = null;
      target.balanceAt = bal.balanceAt || null;
      target.balanceStatus = 'error';
      target.balanceReason = String(bal.reason);
    } else {
      target.balanceCents = null;
      target.balanceAt = bal && bal.balanceAt ? bal.balanceAt : null;
      target.balanceStatus = 'missing';
      target.balanceReason = '本轮未返回余额读数';
    }
  }

  // 在途可见性（2026-10-31 竞态修正）：本轮 candidate 组装期间只置 refreshing 标记，
  // 绝不把半成品（无余额终态的新读数）提前提交为 rt.lastData。
  _markShopDataRefreshing(rt) {
    rt.dataRefreshing = true;
    if (rt.lastData && typeof rt.lastData === 'object') rt.lastData.refreshing = true;
  }

  // 原子提交：整轮读数（含余额终态）组装完成后一次性替换 lastData 并清除在途标记。
  _commitShopLastData(rt, candidate) {
    candidate.refreshing = false;
    rt.lastData = candidate;
    rt.lastDataAt = new Date(this.nowFn()).toISOString();
    rt.dataRefreshing = false;
  }

  // 早退路径（门禁/窗口/读取失败，未回读广告状态）：candidate 先写余额终态 skipped，
  // 避免提交后 UI 把缺失读数和未读混淆；再原子提交。
  _commitShopLastDataSkippedBalance(rt, candidate, reason) {
    candidate.balanceCents = null;
    candidate.balanceStatus = 'skipped';
    candidate.balanceReason = reason;
    candidate.balanceAt = null;
    this._commitShopLastData(rt, candidate);
  }

  // 概览先行落盘（2026-11-02 第 1 项：概览与清单空态解耦）：cost+orders 已核验成功即写
  // rt.lastData / shopRows，余额记终态 skipped（本轮尚未回读，不留下"null 无终态"半成品）。
  // 随后的商品自选空态/广告状态回读失败、抛错或超时只影响 adState 与开关动作，
  // 绝不回滚、也绝不把本轮已成功的 costCents/orders 打成 null。
  _commitShopOverview(rt, candidate) {
    candidate.balanceCents = null;
    candidate.balanceStatus = 'skipped';
    candidate.balanceReason = '概览已写入，本轮千川余额尚未回读';
    candidate.balanceAt = null;
    // 广告状态回读仍在途：保留 refreshing，界面显示"刷新中"，不把半轮当完成态。
    candidate.refreshing = true;
    rt.lastData = candidate;
    rt.lastDataAt = new Date(this.nowFn()).toISOString();
    rt.dataRefreshing = true;
  }

  async refreshShopData(shopId) {
    const shopCfg = this._findShop(shopId);
    if (!shopCfg) return { ok: false, reason: '店铺不存在' };
    // F4（2026-10-24）：删除店仍拒绝；D56 起未删除店铺（历史 enabled=false 亦视为正常店）允许本
    // **只读**更新（登录后一次只读数据刷新）。本方法只读，不进入任何广告操作。
    if (shopCfg.deleted === true) {
      return { ok: false, reason: '店铺已删除，不再值守/更新', deleted: true };
    }
    if (this.pending.length > 0) {
      return { ok: false, reason: `存在待配置/非法配置项，不允许更新: ${this.pending.join('；')}` };
    }
    // D24 逐店串行（跨入口收口）：目标店正被巡查周期/每日开启/登录接管在途处理时，
    // 本只读刷新不叠加并发同店处理，如实返回可稍后重试（复用既有每店处理互斥，不另造锁）。
    if (!this._tryAcquireShop(shopId, '读取数据中（只读）')) {
      return {
        ok: true, readOnly: true, shopId, adState: 'unknown',
        blocked: 'shop_busy',
        reason: '该店已有处理在途（巡查/每日开启/登录接管/恢复链），本次手动更新未叠加新读取',
        zeroClick: true,
      };
    }
    const rt = this._runtime(shopId);
    try {
      const coord = this._getCoordinator(shopCfg);
      let data;
      try {
        data = await coord.readAndEvaluate(shopCfg, { readOnlyRefresh: true });
      } catch (e) {
        if (e instanceof NotConnectedError) {
          rt.lastError = '推广数据读取尚未接入';
          return { ok: false, reason: rt.lastError, zeroClick: true };
        }
        throw e;
      }
      rt.lastError = null;
      // 竞态修正（2026-10-31）：本轮读数先组装为 candidate，_readCurrentAdState（含余额）
      // 完成并把余额终态写入 candidate 后才原子提交为 rt.lastData；在途仅 refreshing 标记。
      const candidate = this._summarizeData(data);
      if (data.ok !== false && data.evaluation) {
        candidate.spendFloorCents = SPEND_FLOOR_CENTS;
        candidate.spendProtected = data.evaluation.spendProtected === true;
        candidate.pauseEligible = data.evaluation.pauseEligible === true;
        candidate.roiTooLow = data.evaluation.roiTooLow === true;
      }
      this._markShopDataRefreshing(rt);
      // 概览已成功 → 立即落盘（第 1 项解耦）：后续广告状态回读失败/抛错不再吞掉 cost/orders。
      if (data.ok !== false) this._commitShopOverview(rt, candidate);
      // 只读回读广告状态（on/off/mixed/unknown）；失败 → unknown + blocked 说明
      const stateRead = await this._readCurrentAdState(shopCfg);
      this._applyBalanceToLastData(candidate, stateRead);
      // 全局浏览器操作锁忙（PROMO-IMPL-F1）：本次只读刷新让位，不写 adState、不落读取失败。
      if (stateRead.globalBusy === true) {
        this._auditGlobalBrowserOpBusy(shopId);
        return {
          ok: true, readOnly: true, shopId, adState: rt.lastAdState,
          blocked: 'global-browser-op-busy', reason: stateRead.error.reason, zeroClick: true,
        };
      }
      if (stateRead.error) {
        // 新错误覆盖旧因；Auth 失败同时撤销旧 on 证据；未知保持零广告开关。
        this._applyReadFailure(shopCfg.id, stateRead.error);
        candidate.roiTooLow = false;
        candidate.pauseEligible = false;
        // 返回的 blocked 与 lastReadError.kind 同源（F5-R9）：注入/适配器给出的通用
        // blocked=auth 若被具体原因推翻（Cookie/身份/读取失败），不得继续对外冒充 auth。
        const errKind = this._readErrorKind(stateRead.error, shopCfg.id);
        let blocked = stateRead.error.blocked || 'ad_state_read';
        if (errKind === 'cookie_invalid' || errKind === 'cookie_blocked' || errKind === 'identity') blocked = errKind;
        else if (blocked === 'auth' && errKind !== 'auth') blocked = errKind;
        if (data.blocked === 'orders_unavailable') candidate.blockedReason = data.reason;
        // 竞态修正：先提交带余额终态的本轮读数，再返回，UI 不再看到陈旧/半成品混合。
        this._commitShopLastData(rt, candidate);
        return {
          ok: data.blocked !== 'orders_unavailable',
          readOnly: true,
          shopId,
          data: rt.lastData,
          adState: rt.lastAdState,
          blocked,
          reason: stateRead.error.reason,
          zeroClick: true,
        };
      }
      // 成功同店新回读：清除旧错误/旧阻断原因，再写入本轮只读观测。
      this._clearReadFailure(shopCfg.id);
      // 只读观测更新状态；失败/unknown 也不得保留旧动作确认时间去配对新状态
      this._applyObservedAdState(shopCfg.id, stateRead.state || 'unknown', '只读清单/页面回读');
      this._commitShopLastData(rt, candidate);
      if (data.ok === false) {
        rt.lastData.blockedReason = data.reason;
        return {
          ok: data.blocked !== 'orders_unavailable',
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
      // F5-R9：AuthError/blocked=auth 只是"读取被拒绝"，不是登录失效的充分证据。
      // 按具体原因分类（Cookie 解析/结构、Cookie 读取受阻、身份），无正证据的通用
      // auth 一律按读取失败保留原 reason，绝不要求扫码。
      // AUTH-60S：携带 loginEvidence 时按结构性证据 + 连续观测窗口分类。
      const cls = this._failureClassWithError(shopId, e, reason);
      const authType = (e instanceof AuthError || (e && e.code === 'AUTH'));
      const blocked = cls || (authType ? 'read_failed' : 'data');
      this._applyReadFailure(shopId, {
        reason, blocked,
        auth: cls === 'auth' || undefined,
        loginEvidence: (e && e.loginEvidence) || undefined,
        // fix3：auth 结案证据必须随错误对象进入 _applyReadFailure，否则无法释放串行门。
        authClosure: (e && e.authClosure) || undefined,
      });
      this._memPush(this.recentErrors, { scope: `shop:${shopId}`, error: reason }, undefined, 'error');
      this._audit({ kind: 'shop-refresh', shopId, ok: false, reason, blocked, zeroClick: true });
      return { ok: false, reason, zeroClick: true };
    } finally {
      // 异常/早退不得把 refreshing 卡在 true（candidate 未提交则维持上一轮已提交读数）。
      rt.dataRefreshing = false;
      if (rt.lastData && typeof rt.lastData === "object") rt.lastData.refreshing = false;
      this._releaseShop(shopId);
    }
  }

  /**
   * 同店处理互斥（WD-NEW-1 并发收口，2026-10-02）：所有会对同一店铺执行
   * 「读取+决策+动作+回读」整段处理的入口共用一把每店锁——
   *   - pollOnce（暂停巡查，逐店取得资格，busy 店本轮跳过零派发）；
   *   - joinShopNow（登录接管，busy 时有界等待释放后再自行处理，绝不与巡查并发同店）；
   *   - _runShopEnablePhase（每日开启循环与手动验证的共同单店入口，busy 即跳过零动作）。
   * 广告开关串行门只约束开关点击，不覆盖重复读取/决策/共享运行时状态，不能替代本互斥。
   * 每店独立：一把店锁绝不阻塞不相关店铺；取得资格后、派发前必须复核 running/删除/令牌；
   * 正常完成、异常、取消都在 finally 释放，绝不留下忙状态。
   */
  _shopBusy(shopId) {
    return this._shopProcessing.has(String(shopId));
  }

  /**
   * 单店当前动作（2026-11-20 主控制页「当前动作」列）：租约登记时附带人类可读文本，
   * 释放即清除——如实反映该店此刻在做什么（巡查/读取/开启/登录接管），
   * 不做任何推断或美化；无租约且无只读刷新在途 → 空闲。
   */
  _tryAcquireShop(shopId, activityText) {
    const k = String(shopId);
    if (this._shopProcessing.has(k)) return false;
    this._shopProcessing.add(k);
    if (activityText) this._shopActivity.set(k, String(activityText));
    return true;
  }

  _releaseShop(shopId) {
    const k = String(shopId);
    this._shopProcessing.delete(k);
    this._shopActivity.delete(k);
  }

  /** 在途动作文本（无租约返回 null；只读刷新的 dataRefreshing 由投影层合并）。 */
  _shopActivityText(shopId) {
    return this._shopActivity.get(String(shopId)) || null;
  }

  /** 租约持有期间细化当前动作文本（如 巡查租约内：读取数据 → 关闭广告 → 回读确认）。未持租约不生效。 */
  _setShopActivity(shopId, text) {
    const k = String(shopId);
    if (this._shopProcessing.has(k)) this._shopActivity.set(k, String(text));
  }

  /**
   * 发布/恢复租约在途判定（PROMO-IMPL-E1）：同一店铺当日已有发布/恢复入口持锁时，
   * 值守读取/动作必须让位（同店串行、跨店不受影响）。lease 路径与 expiry 规则由
   * watch-drill 注入的 leaseExists 负责；未注入 → false（旧行为零变化）。
   */
  _publishLeaseInFlight(shopCfg, businessDate) {
    if (typeof this._publishLeaseExists !== 'function') return false;
    try {
      return this._publishLeaseExists(shopCfg, businessDate || shanghaiDate(this.nowFn()), this._publishLeaseDir) === true;
    } catch (_) {
      return false;
    }
  }

  /**
   * 全局浏览器操作排队锁（PROMO-IMPL-F1）：跨进程文件锁的取放由 watch-drill 注入
   * （复用 promo-plan-scheduler 的 acquireProcessLock/releaseProcessLock）。未注入 → 不排队。
   * 取锁失败（含异常）一律视为忙：让位本店，不在持锁时等待，也不把异常当空闲放行。
   */
  _acquireGlobalBrowserOp() {
    if (!this._globalBrowserLock) return { held: true, token: null, noLock: true };
    try {
      const r = this._globalBrowserLock.acquire();
      if (r && r.held === true) return { held: true, token: r.token };
      return { held: false };
    } catch (_) {
      return { held: false };
    }
  }

  _releaseGlobalBrowserOp(acq) {
    if (!acq || acq.held !== true || acq.noLock === true) return;
    try { this._globalBrowserLock.release(acq.token); } catch (_) { /* 释放失败不覆盖原结果 */ }
  }

  /**
   * 在全局浏览器操作锁内执行 fn：正常/异常都在 finally 释放，返回 {busy:false,value}
   * 或 {busy:true}（未执行 fn）。不新增状态机，只在既有读取/动作外壳外面包一层。
   */
  async _withGlobalBrowserOp(fn) {
    const acq = this._acquireGlobalBrowserOp();
    if (!acq.held) return { busy: true };
    try {
      return { busy: false, value: await fn() };
    } finally {
      this._releaseGlobalBrowserOp(acq);
    }
  }

  /** 锁忙跳过审计（kind=poll / status=skipped / reason 固定），与 E1 租约跳过同形状。 */
  _auditGlobalBrowserOpBusy(shopId) {
    try {
      this._audit({ kind: 'poll', shopId, status: 'skipped', reason: 'global-browser-op-busy' });
    } catch (_) { /* 审计失败不影响让位 */ }
  }

  /**
   * WD-NEW-1 补修（2026-10-02）：登录成功后**只对目标店**立即执行一次单店巡查。
   *
   * 与 pollNowAndReschedule（全店周期 + 全局 nextRunAt 重排）刻意不同：
   *  - 只处理目标店：不遍历其他店铺（其他店执行次数为 0）、不改写任何全局调度字段；
   *  - 门禁齐全：配置待配置项拒绝；值守未运行拒绝（pollOnce 不查 running，本路径必须自查，
   *    杜绝“停止后仍启动新的广告处理”）；店铺不存在/软删除/停用拒绝（软删除绝不复活）；
   *  - 同店处理互斥（并发收口）：目标店正在被常规巡查/每日开启/手动验证处理时**有界等待其
   *    释放**（每店锁，不阻塞不相关店铺）；等待结束后先复核 running（停止优先）、再试取得
   *    资格，取得后派发前复核取消令牌与删除状态——等待期间停止/删除 → 零新派发；
   *  - 取消机制复用：注册 kind:'pause' 令牌到 _activeTokens（stop() 即中止，已启动的
   *    动作按既有取消/回读规则收尾）；
   *  - 结果如实透出：{ ok, shopId, status, ... }，status ∈ ok/blocked/window_blocked/
   *    stopped/skipped——调用方必须按目标店实际 status 与必要回读判定接管完成；
   *    不与“全局周期是否处理过目标店”做隐式合并（等待后总是自行处理+回读，依据明确）；
   *  - 绝不删除广告；动作是否落地仍由既有 fail-closed 门槛（realMode/dryRun/开关/窗口）决定。
   *
   * @param {string} shopId 店铺 ID（与 config.shops[].id 精确匹配）
   * @param {{trigger?:string}} [opts]
   * @returns {Promise<{ok:boolean, shopId?:string, status?:string, reason?:string, [k:string]:any}>}
   */
  async joinShopNow(shopId, opts = {}) {
    if (this.pending.length > 0) {
      return { ok: false, status: 'blocked', reason: `存在待配置/非法配置项，不允许处理: ${this.pending.join('；')}` };
    }
    if (this.running !== true) {
      return { ok: false, status: 'stopped', reason: '值守未运行：不派发任何处理（零动作）' };
    }
    const shopCfg = this._findShop(shopId);
    if (!shopCfg) return { ok: false, status: 'blocked', reason: '店铺不存在' };
    if (!this._isShopActive(shopId)) {
      return { ok: false, status: 'blocked', reason: '店铺已删除或停用，不再值守（软删除不复活）', deleted: shopCfg.deleted === true };
    }
    // 同店处理互斥：目标店正在被处理 → 有界等待释放；等待结束后先复核 running，再取得资格
    if (this._shopBusy(shopId)) {
      const sch = this.config.schedule || {};
      const deadline = this.nowFn() + Math.max(2 * 60 * 1000, (sch.intervalMinutes || 30) * 60 * 1000);
      while (this._shopBusy(shopId) && this.running === true && this.nowFn() < deadline) {
        await new Promise((res) => setTimeout(res, 200));
      }
      if (this.running !== true) {
        return { ok: false, status: 'stopped', reason: '值守已停止：未派发目标店处理（零动作）' };
      }
      if (this._shopBusy(shopId)) {
        return { ok: false, status: 'skipped', reason: '目标店处理长时间未释放，本次立即处理未派发（店铺已在列表，常规巡查会处理）' };
      }
    }
    // D24T 等待期间复核：取得资格前重新尝试同店锁，绝不让两个入口同时各持一家店。
    if (!this._tryAcquireShop(shopId, '登录接管处理中')) {
      return { ok: false, status: 'skipped', reason: '该店已有处理在途（并发去重）' };
    }
    const token = { aborted: false, kind: 'pause' };
    this._activeTokens.add(token);
    try {
      // 派发前最后一刻复核：停止/删除不得启动新的广告处理（已启动的按既有取消/回读规则收尾）
      if (token.aborted || this.running !== true) {
        return { ok: false, status: 'stopped', reason: '值守已停止：未派发目标店处理（零动作）' };
      }
      if (!this._isShopActive(shopId)) {
        return { ok: false, status: 'blocked', reason: '店铺已被删除，取消本次处理' };
      }
      this._audit({ kind: 'join-shop', shopId, trigger: (opts && opts.trigger) || 'new-shop-join' });
      const result = await this._pollShop(shopCfg, token, (opts && opts.trigger) || 'new-shop-join');
      return { ok: true, shopId, ...(result || {}) };
    } catch (e) {
      return { ok: false, status: 'stopped', reason: (e && e.message) || String(e) };
    } finally {
      this._releaseShop(shopId);
      this._activeTokens.delete(token);
    }
  }

  /**
   * 修改店铺**展示名称**、阈值、目标 ROI（targetRoi）与每店每日计划条数（plansPerShopPerDay）。
   * - 展示名写入 `displayName`，**绝不修改**身份字段 `name`/`id`/`compassShopName`/`accountId`/`cookieFile`；
   * - targetRoi 采用 config.validateTargetRoi 严格合同：缺字段→默认 15；明确值只接受正有限 number
   *   （支持 13.5），拒绝空/null/布尔/NaN/Infinity/0/负数/'15abc'；**只改 ROI**，不触发巡检启停、
   *   不改阈值/身份/Cookie；
   * - plansPerShopPerDay 采用 config.validatePlansPerShop 严格合同（客户 2026-10-13："每天几条加在
   *   目标 ROI 后面，可按店调整"）：整数 1..10；缺字段回落全局默认 3；
   * - 先持久化（原子写），成功后才报告 ok:true；写入失败精确回滚内存并返回失败。
   * 不暴露/不修改 Cookie、令牌、密钥。
   */
  updateShop(shopId, { displayName, name, thresholdCents, targetRoi, plansPerShopPerDay } = {}) {
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
    if (targetRoi !== undefined) {
      const roiCheck = validateTargetRoi(targetRoi);
      if (!roiCheck.ok) {
        return { ok: false, reason: `目标 ROI 无效：${roiCheck.reason}`, roiInvalid: true };
      }
      patch.targetRoi = roiCheck.value;
    }
    // 每店每天计划数量（客户 2026-10-13 合同："每天几条加在目标 ROI 后面，可按店调整"；整数 1..10）
    if (plansPerShopPerDay !== undefined && plansPerShopPerDay !== null) {
      const ppCheck = validatePlansPerShop(Number(plansPerShopPerDay));
      if (!ppCheck.ok) {
        return { ok: false, reason: `每日计划条数无效：${ppCheck.reason}`, plansPerShopInvalid: true };
      }
      patch.plansPerShopPerDay = ppCheck.value;
    }
    if (Object.keys(patch).length === 0) {
      return { ok: false, reason: '未提供可修改字段（展示名称/阈值/目标 ROI/每日计划条数）' };
    }
    // 整店浅快照：写入失败精确回滚（含字段是否存在）
    const snapshotBefore = { ...shop };
    const from = {
      displayName: shop.displayName !== undefined ? shop.displayName : (shop.name || shop.id),
      thresholdCents: shop.thresholdCents ?? this._thresholdCents(shop),
      targetRoi: shop.targetRoi !== undefined ? shop.targetRoi : DEFAULT_TARGET_ROI,
      plansPerShopPerDay: resolveEffectivePlansPerShop(shop, DEFAULT_PLANS_PER_SHOP),
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
      to: {
        displayName: shop.displayName || shop.name,
        thresholdCents: shop.thresholdCents ?? this._thresholdCents(shop),
        targetRoi: shop.targetRoi !== undefined ? shop.targetRoi : DEFAULT_TARGET_ROI,
        plansPerShopPerDay: resolveEffectivePlansPerShop(shop, DEFAULT_PLANS_PER_SHOP),
      },
      identityUnchanged: true,
      persisted: true,
    });
    this._saveState();
    return {
      ok: true,
      shopId,
      displayName: shop.displayName || shop.name,
      thresholdCents: shop.thresholdCents ?? this._thresholdCents(shop),
      targetRoi: shop.targetRoi !== undefined ? shop.targetRoi : DEFAULT_TARGET_ROI,
      plansPerShopPerDay: resolveEffectivePlansPerShop(shop, DEFAULT_PLANS_PER_SHOP),
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
   * 读取失败细分（2026-10-18 F5-R9）：
   * 通用 AuthError / blocked=auth **不是**「登录失效」的充分证据。Cookie 文件解析/结构
   * 损坏、文件缺失/不可读、工作副本同步锁、身份冲突/未配置都由 AuthError 抛出，但它们
   * 是本地可修复故障，不要求用户扫码。只有正式登录检测给出的持续登录页/登录失效正证据
   * 才归 auth。返回 null 表示无特定类别（由调用方按原 blocked 处理）。
   */
  _readFailureClass(reason) {
    const r = String(reason || '');
    // Cookie 结构/解析坏：文件本身异常（不要求扫码）。
    if (/Cookie\s*文件解析失败|Cookie\s*文件内容不是非空数组|Cookie\s*数组中存在缺少|Cookie\s*文件格式|Cookie\s*结构/.test(r)) return 'cookie_invalid';
    // Cookie 读取/访问受阻：缺文件、路径不可读、同步锁、权限（本地故障，不要求扫码）。
    // 不把裸 ENOENT/EACCES 当 Cookie 故障（浏览器启动失败等应归 read_failed）。
    if (/未找到店铺[^\n]*Cookie\s*文件|Cookie\s*文件名未配置|Cookie\s*文件名非法|Cookie\s*文件不存在|Cookie\s*文件不可读|Cookie[^\n]{0,40}(EACCES|EPERM|ENOENT)|正在同步该店\s*Cookie\s*副本|工作副本锁|工作副本写入失败|工作副本状态不可判定|无法创建本项目\s*Cookie\s*工作目录/.test(r)) return 'cookie_blocked';
    // 身份冲突/未配置：与登录失效无关。
    if (/身份|accountId|账户\s*ID/.test(r)) return 'identity';
    // 登录正证据：正式登录检测的有界收敛结论。
    if (/登录失效|登录已失效|请重新扫码登录|重新扫码|持续登录页|登录验证未通过|会话已失效|登录态无效|未登录/.test(r)) return 'auth';
    return null;
  }

  // ── AUTH-60S 正向证据连续观测（按店铺，FINAL 2026-11-02）─────────────────
  // 结构性瞬时证据（err.loginEvidence，由 qianchuan-reader collectLoginExpiryEvidence
  // 产出）优先于 reason 文本分类：**任一正向证据**（loginUrl / 可见表单 / 可见控件 /
  // 可见对话框）都必须跨轮连续观测 ≥ AUTH_LOGIN_URL_HOLD_MS 才判 auth（强 UI 无旁路）；
  // 证据中途消失/key 变化即清零重计，中断时段不累计；证据无任何正向项（含裸 AuthError
  // 文本、body「扫码登录」字样、hidden 控件）一律 read_failed，绝不要求扫码。

  _authEvidenceWatchFor(shopId) {
    return this._authEvidenceWatch.get(String(shopId)) || null;
  }

  _clearAuthEvidenceWatch(shopId) {
    this._authEvidenceWatch.delete(String(shopId));
  }

  /**
   * 本轮正向证据 → 稳定观测 key（FINAL 规则 3/4）：
   * loginUrl 用 origin+pathname（strip query）；纯强 UI 用伪 key ui:form/ui:control/ui:dialog。
   * body 文本与 hidden 控件不是正向证据（reader 侧已只报可见结构性布尔）。
   */
  _positiveAuthEvidence(evidence) {
    const ev = (evidence && typeof evidence === 'object') ? evidence : null;
    if (!ev) return null;
    if (ev.loginUrl === true && typeof ev.loginUrlKey === 'string' && ev.loginUrlKey) return { key: ev.loginUrlKey, kind: 'url' };
    if (ev.loginFormVisible === true) return { key: 'ui:form', kind: 'form' };
    if (ev.loginControlVisible === true) return { key: 'ui:control', kind: 'control' };
    if (ev.loginDialogVisible === true) return { key: 'ui:dialog', kind: 'dialog' };
    return null;
  }

  /**
   * 观测一轮证据并维护连续窗口：
   * - 正向证据 key 与在观 key 相同 → 保持 firstSeenAt 起点（连续命中）；
   * - key 变化（含 URL↔强 UI 切换、URL pathname 变化）→ 以本轮为新起点（旧窗口作废）；
   * - 无正向证据（离开登录页/强 UI 消失/无证据轮次）→ 清除窗口，返回 null。
   */
  _observeAuthEvidenceWatch(shopId, evidence, now) {
    const k = String(shopId);
    const pos = this._positiveAuthEvidence(evidence);
    if (pos) {
      const rec = this._authEvidenceWatch.get(k);
      if (rec && rec.key === pos.key) {
        return { key: rec.key, kind: rec.kind, firstSeenAt: rec.firstSeenAt, heldMs: Math.max(0, now - rec.firstSeenAt) };
      }
      const fresh = { key: pos.key, kind: pos.kind, firstSeenAt: now };
      this._authEvidenceWatch.set(k, fresh);
      return { key: fresh.key, kind: fresh.kind, firstSeenAt: fresh.firstSeenAt, heldMs: 0 };
    }
    this._authEvidenceWatch.delete(k);
    return null;
  }

  /**
   * 组合判定（唯一 AUTH 升级入口，FINAL）：返回 { kind, evidenceKind, heldMs, observingSec? }。
   * 任一正向证据（URL 或强 UI）都必须 heldMs ≥ AUTH_LOGIN_URL_HOLD_MS 才 kind=auth；
   * 未满窗口一律 read_failed（requiresLogin=false，用户可见文案固定「读取失败」）。
   */
  _loginEvidenceDecision(shopId, evidence) {
    const w = this._observeAuthEvidenceWatch(shopId, evidence, this.nowFn());
    if (!w) return { kind: 'read_failed', evidenceKind: null, heldMs: 0 };
    if (w.heldMs >= AUTH_LOGIN_URL_HOLD_MS) return { kind: 'auth', evidenceKind: w.kind, heldMs: w.heldMs };
    return { kind: 'read_failed', evidenceKind: w.kind, heldMs: w.heldMs, observingSec: Math.floor(w.heldMs / 1000) };
  }

  /** 构造失败对象处的证据感知分类：有 loginEvidence → 组合判定；否则回退 reason 文本分类。 */
  _failureClassWithError(shopId, e, reason) {
    const ev = e && e.loginEvidence;
    if (ev && typeof ev === 'object' && shopId != null) {
      const d = this._loginEvidenceDecision(shopId, ev);
      return d.kind === 'auth' ? 'auth' : null;
    }
    return this._readFailureClass(reason);
  }

  /**
   * 读取错误分类（页面展示与重试门共用）：
   * - auth：正式登录检测已证明持续登录页/登录失效（只有此类可要求重新登录）；
   * - cookie_invalid：Cookie 文件解析/结构坏（本地故障，不要求扫码）；
   * - cookie_blocked：Cookie 文件缺失/不可读/同步锁（本地故障，不要求扫码）；
   * - identity：身份冲突/未配置；
   * - retrying：同一周期内正在做唯一一次有界只读重读；
   * - timeout：总截止已到（收口/清理结果另见 error.cleanup）；
   * - read_failed：其他读取失败（导航未稳定、清单不一致等），不得冒充登录失效。
   * 无正证据的通用 auth（blocked=auth / auth=true）一律降为 read_failed，绝不据此要求扫码。
   * AUTH-60S FINAL：传入 shopId 且 err.loginEvidence 存在时，结构性证据 + 连续观测窗口优先于
   * reason 文本分类（任一正向证据未满 60s → read_failed；跨轮连续 ≥60s 且证据仍在 → auth）。
   */
  _readErrorKind(err, shopId) {
    if (!err) return null;
    if (err.retrying === true) return 'retrying';
    if (err.blocked === 'cookie_invalid' || err.blocked === 'cookie_blocked' || err.blocked === 'identity') return err.blocked;
    if (err.timeout === true) return 'timeout';
    if (shopId != null && err.loginEvidence && typeof err.loginEvidence === 'object') {
      return this._loginEvidenceDecision(shopId, err.loginEvidence).kind;
    }
    const cls = this._readFailureClass(err.reason);
    if (cls) return cls;
    return 'read_failed';
  }

  /**
   * 动作前/回读失败详情脱敏（2026-10-19 缺口 B）：把 error 归约为机读摘要，
   * 只保留 status/blocked/reason(截断)/timeout/lastStep，绝不写入裸 Cookie/URL 参数/令牌。
   * 通过 log.sanitize 做值级兜底脱敏；临时错误保持其分类，不改写为登录失效。
   */
  _maskReadError(err, shopId) {
    if (!err) return null;
    const masked = log.sanitize({
      status: err.status || 'blocked',
      // 分类与页面 lastReadError.kind 同源：auth 仅在正式登录检测正证据下出现；
      // Cookie/身份/超时/瞬态分别归类，通用 auth 不会在这里被升级为登录失效。
      kind: this._readErrorKind(err, shopId),
      blocked: err.blocked || 'ad_state_read',
      reason: String(err.reason || '').slice(0, 200),
      lastStep: err.lastStep || null,
    });
    if (err.timeout === true) masked.timeout = true;
    return masked;
  }

  /**
   * 只对**明确瞬态且可安全重读**的错误允许一次额外完整回读：
   * - 清单末页行数与 total 不一致、分页 total 变化；
   * - 管理页导航未稳定/刷新后未恢复计划视图。
   * 明确 Auth/身份/人工检查/危险弹窗/重复 ID/超时收口未证明等一律不重试。
   */
  _isTransientReadError(err) {
    if (!err || err.status !== 'blocked') return false;
    if (err.blocked === 'auth' || err.blocked === 'identity' || err.timeout === true) return false;
    const reason = String(err.reason || '');
    // 契约硬化（2026-10-22 独立验收）：Cookie 本地故障（解析/结构坏、缺文件/不可读/同步锁）不是
    // 链路抖动，重读同一份坏副本不可能恢复；即使 reason 里混入 net::ERR_* 之类网络词也绝不进链。
    // 先看已分类的 blocked，再按原始 reason 复核（旧错误对象可能仍带 inventory/ad_state_read 等粗分类）。
    if (err.blocked === 'cookie_invalid' || err.blocked === 'cookie_blocked') return false;
    const failureClass = this._readFailureClass(reason);
    if (failureClass === 'cookie_invalid' || failureClass === 'cookie_blocked') return false;
    if (/登录失效|请重新扫码登录|身份|人工检查|删除确认|重复|计划 ID 跨页重复|无法核验|截止/.test(reason)) return false;
    // 空表机读码（生产者铸码，见 lib/empty-inventory-evidence）：只认结构化字段的严格相等，
    // 绝不按原因文本包含判定——展示用的组合文本会残留首次失败短语，按文本判会把已不合格的
    // 店铺错误续上恢复链。码只在「商品自选第 1 页 0 行 + 整数 total=1 + hasNext=false + 页码
    // 明确 + 身份/刷新/关闭明确 + 零派发」全部成立时才存在。
    if (isEmptyTableCode(err.emptyTableCode)) return true;
    // 传输层网络失败（net::ERR_CONNECTION_CLOSED 等）：原因文本即事实证据，只读重读安全，
    // 必须走同轮重读 + 有限恢复链；不得因不匹配页面级白名单而挂到下一周期（长期"读取受阻"）。
    if (TRANSPORT_READ_REASON_RE.test(reason)) return true;
    // 商品自选首屏分页结束标记缺失：本次清单不可信（当次仍 blocked/zeroClick），
    // 但全新 session 的只读全量重读安全，纳入既有有界链，避免本店挂到下一个 30 分钟周期。
    // 严格相等而非"包含"：组合展示文本里的历史短语不得再次点亮白名单。
    if (reason === SUBSELECT_FIRST_PAGE_HASNEXT_NULL_REASON) return true;
    return /末页已读行数\s*\d+\s*与\s*total\s*\d+\s*不一致|分页 total 不一致|导航"乘方"未到达管理页|乘方页未找到.*子标签|刷新后未能恢复商品计划视图|回读前刷新乘方管理页失败|乘方「[^」]+」刷新失败/.test(reason);
  }

  /** 回读失败：撤销旧 on 证据，写完整原因（lastError/today.blockedReason/结构化分类一致）。 */
  _applyReadFailure(shopId, err) {
    const rt = this._runtime(shopId);
    // 页面展示的错误详情同样脱敏：保留业务原因与分类，但绝不出站裸 Cookie/令牌/会话值。
    const baseReason = log.sanitize(String((err && err.reason) || '未知读取失败'));
    const hasEvidence = !!(err && err.loginEvidence && typeof err.loginEvidence === 'object');
    const kind = this._readErrorKind(err, shopId);
    // AUTH-60S FINAL：连续观测窗口只统计**带正向结构性证据**的轮次；本轮无证据
    // （Cookie/超时/裸异常等）即窗口中断，清除计时（中断时段不累计）。
    if (!hasEvidence) this._clearAuthEvidenceWatch(shopId);
    // FINAL 规则 5：未满 60s 用户可见文案固定「读取失败」（hint），reason 不追加
    // 「登录页观测中 Xs/60s」类进度文案；观测进度仅保留在内部调试字段 loginUrlObserv。
    let loginUrlObserv = null;
    if (hasEvidence && kind !== 'auth') {
      const w = this._authEvidenceWatchFor(shopId);
      if (w) {
        loginUrlObserv = { key: w.key, kind: w.kind, heldMs: Math.max(0, this.nowFn() - w.firstSeenAt), holdMs: AUTH_LOGIN_URL_HOLD_MS };
      }
    }
    // fix4（2026-11-03）：只在**已确认 auth** 的日志行追加 60s 保护字段，纯日志、不改判定：
    // heldMs 与 loginUrlObserv.heldMs 同源（now - firstSeenAt），holdMs=AUTH_LOGIN_URL_HOLD_MS。
    let holdLogFields = '';
    if (kind === 'auth') {
      const w = this._authEvidenceWatchFor(shopId);
      if (w) {
        holdLogFields = buildHoldLogFields({
          heldMs: Math.max(0, this.nowFn() - w.firstSeenAt),
          holdMs: AUTH_LOGIN_URL_HOLD_MS,
        });
      }
    }
    const reason = `${baseReason}${holdLogFields}`;
    // fix3-four 路径（authClosure 证据随错误交付）：对外提示不含扫码类结论，结案/未结案分列。
    const fix3Auth = kind === 'auth' && !!(err && err.authClosure);
    const hint = fix3Auth
      ? (err.authClosure.authClosedOut === true ? FIX3_AUTH_HINTS.closed : FIX3_AUTH_HINTS.open)
      : (READ_FAILURE_HINTS[kind] !== undefined ? READ_FAILURE_HINTS[kind] : null);
    rt.lastReadError = {
      kind,
      // 四条固定文案（单一来源）：页面/bill-manager 直接消费，不再各自猜文案。
      hint,
      requiresLogin: kind === 'auth',
      reason,
      loginUrlObserv,
      blocked: (err && err.blocked) || 'ad_state_read',
      lastStep: (err && err.lastStep) || null,
      retrying: kind === 'retrying',
      retried: err && err.retried === true,
      retryCount: (err && err.retryCount) || 0,
      at: new Date(this.nowFn()).toISOString(),
    };
    rt.lastError = reason;
    if (rt.lastData) rt.lastData.blockedReason = reason;
    // 新 Auth 失败撤销旧 on 证据：旧 adBelief/旧确认时间不得继续作为本轮可信依据。
    if (kind === 'auth') {
      // fix3：全候选不可用且对照店 checkLogin 已排除误判（authClosure.authClosedOut）→
      // 先落盘证据包，再按未确认终态释放该店旧 unknown 串行槽，避免 auth 结案后仍堵本店/后续店铺。
      // 无结案证据时不触碰任何门（保持既有 fail-closed 语义）。
      if (err && err.authClosure) {
        // 结案证据先落盘、再释放该店串行门；证据未落盘则保持门阻塞（fail-closed）。
        // 与 onAuthClosedOut 回调共用幂等收口：同一份证据只写一次盘。
        try { this._settleAuthClosure(shopId, err.authClosure); } catch (_) { /* 收口失败不掩盖读取错误 */ }
      }
      if (this.adBelief) delete this.adBelief[shopId];
      try { this._saveState(); } catch (_) { /* 持久化失败不掩盖本次错误 */ }
    }
    this._applyObservedAdState(shopId, 'unknown', `只读回读失败：${reason}`);
  }

  /** 同店成功新回读：清除旧读取错误与旧阻断原因（不得残留旧 Auth/导航失败）。 */
  _clearReadFailure(shopId) {
    const rt = this._runtime(shopId);
    rt.lastReadError = null;
    rt.lastError = null;
    if (rt.lastData) delete rt.lastData.blockedReason;
    // AUTH-60S：读取成功即离开正向证据 → 清除连续观测窗口（下次命中重新计时）。
    this._clearAuthEvidenceWatch(shopId);
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
        // 2026-10-10 mixed 交接证据：可返回 {state, rows}（rows=全量清单行；缺省即无清单背书，
        // 不得以摘要释放/交接）；字符串返回值保持既有语义（无 identity/rows/balance）。
        if (r && typeof r === 'object' && !Array.isArray(r)) {
          // 注入对象必须原样保留 error/switchEvidence/inventory：旧实现只取 state/identity/balance/rows，
          // 会把真实读取失败丢成"无 error 的 unknown"，下游因此无法区分读取失败与开关不可识别。
          return {
            state: r.error ? 'unknown' : normalizeAdState(r.state),
            identity: r.identity || null,
            balance: r.balance || null,
            rows: r.rows,
            inventory: r.inventory,
            error: r.error || undefined,
            switchEvidence: r.switchEvidence || null,
          };
        }
        return { state: normalizeAdState(r), balance: null };
      } catch (e) {
        const reason = e.reason || e.message;
        const isIdentity = /身份/.test(String(reason));
        const authType = (e instanceof AuthError || (e && e.code === 'AUTH')) && !isIdentity;
        // F5-R9：通用 AuthError 不升级为 auth；Cookie 解析/结构/读取受阻、身份按具体故障分类。
        // AUTH-60S FINAL：携带 loginEvidence 时按结构性证据 + 连续观测窗口判定（任一正向
        // 证据未满 60s → cls=null → read_failed，不冒充登录失效；强 UI 无即时旁路）。
        const cls = this._failureClassWithError(shopCfg.id, e, reason);
        const blocked = cls || (isIdentity ? 'identity' : (authType ? 'read_failed' : ((e && e.code === 'DATA_GUARD') ? 'inventory' : 'ad_state_read')));
        return {
          state: 'unknown',
          error: {
            status: 'blocked',
            reason,
            blocked,
            auth: cls === 'auth' || undefined,
            loginEvidence: (e && e.loginEvidence) || undefined,
            // fix3：保留读取器交付的 auth 结案证据（含四份健康表/对照店结论），
            // 供 _applyReadFailure 在确认结案后释放该店串行门。
            authClosure: (e && e.authClosure) || undefined,
          },
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
      // 身份/分页/完整性/Cookie 故障：blocked，不得映射成 ok/unknown 零点击
      const reason = e.reason || e.message;
      const cls = this._failureClassWithError(shopCfg.id, e, reason);
      return {
        state: 'unknown',
        error: {
          status: 'blocked',
          reason,
          blocked: cls || (/身份/.test(String(reason)) ? 'identity' : ((e && e.loginEvidence) ? 'read_failed' : 'inventory')),
          loginEvidence: (e && e.loginEvidence) || undefined,
          authClosure: (e && e.authClosure) || undefined,
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
    const closeFn = browser && typeof browser.close === 'function'
      ? () => browser.close()
      : (session && typeof session.close === 'function' ? () => session.close() : null);
    if (!closeFn) return { closed: true, error: null, promise: null };
    let settledOk = false;
    let settledErr = null;
    const p = Promise.resolve()
      .then(() => closeFn())
      .then(() => { settledOk = true; }, (e) => { settledErr = e || new Error('browser.close rejected'); });
    await Promise.race([p, new Promise((r) => setTimeout(r, waitMs))]);
    return { closed: settledOk && !settledErr, error: settledErr, promise: p };
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
    // 2026-11-05 修复 capability gate：settleUnknownEnableTargetNotAchieved 是 enable 专用
    // 「目标未达成结案」能力，缺失时不得拦掉 pause/enable 槽位的正常目标态核验释放
    // （resolveUnknownWithReadback 链路）；仅 enable 未达成分支在其能力缺失时 fail-closed。
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
    // 本轮完整清单/身份背书的行级事实（供"确认达成"与"目标未达成"两条结案路径共用）
    const rowsArray = Array.isArray(r.rows);
    const identityOk = !!(r.identity && r.identity.ok === true);
    const allOff = rowsArray && r.rows.length > 0 && r.rows.every((x) => x && x.switchChecked === false);
    let noReleaseReason = null;
    if (r.error) noReleaseReason = `回读失败/超时（${r.error.blocked || 'error'}）：${String(r.error.reason || '').slice(0, 120)}`;
    else if (r.state !== expectState) noReleaseReason = `本轮回读=${r.state}，旧 ${slot.action} 目标=${expectState}：目标态未确认`;
    else if (!rowsArray) noReleaseReason = '回读缺少全量清单背书（rows 缺失）：不得以摘要/单页释放';
    else if (!identityOk) noReleaseReason = '回读缺少身份核验证据（identity.ok 非 true）';
    else {
      const allTarget = r.rows.every((x) => x && x.switchChecked === (expectState === 'off' ? false : true));
      if (!allTarget) {
        const bad = r.rows.filter((x) => !x || x.switchChecked !== (expectState === 'off' ? false : true)).length;
        noReleaseReason = `清单存在 ${bad} 行非目标态：不得释放`;
      }
    }
    if (noReleaseReason) {
      // enable 永久阻断修复（2026-10-19）：旧 enable unknown 槽在本轮新鲜、完整、身份背书的
      // 回读里被**严格证明全量 off**——即旧动作目标 on 明确未达成。此时不是"结果未知"，可
      // 把旧动作以「未达成/已核验失败」终态安全结案并释放串行门，使同一轮正常决策创建新 enable。
      // 仅在无 error、清单完整、identity.ok===true、所有行严格 false、本轮归一态 off 时成立；
      // 其余（部分清单/identity false/mixed/unknown/超时）一律保持阻断、零点击。
      // 只陈述"当前全量状态证明目标未达成"，绝不谎称旧动作未点击、绝不声明历史点击因果。
      if (slot.action === 'enable' && expectState === 'on' && !r.error && identityOk && allOff && r.state === 'off') {
        // 能力缺失 fail-closed：orchestrator 未提供 enable 专用「目标未达成结案」入口时，
        // 不得抛异常、不得放宽释放、不得点 enable；明确返回 reason 保持阻断（2026-11-05）。
        if (typeof orch.settleUnknownEnableTargetNotAchieved !== 'function') {
          const why = 'enable 目标未达成结案能力缺失（settleUnknownEnableTargetNotAchieved 未实现）：fail-closed 保持阻断';
          this._audit({ kind: 'ad-switch', step: 'resolve-unknown-attempt', shopId: shopCfg.id, actionId: slot.actionId, ok: false, reason: why });
          return { resolved: false, reason: why, actionId: slot.actionId };
        }
        const evidence = { listComplete: true, identityOk: true, allRowsOff: true, rowCount: r.rows.length, freshState: 'off' };
        const evidenceSummary = `${r.rows.length} 行全量 switchChecked=false（当前全量 off），identity.ok=true，读取时间 ${new Date(this.nowFn()).toISOString()}`;
        const note = `旧 enable 目标（on）未达成：本轮新鲜完整回读全量 ${evidenceSummary}；以「已核验失败/未达成」终态安全结案（非 confirmed、不声明历史点击因果），同轮正常决策可创建新 enable`;
        const res = orch.settleUnknownEnableTargetNotAchieved(shopCfg.id, slot.actionId, {
          evidence,
          note,
          persist: () => this._saveState(),
        });
        const ok = res && res.ok === true;
        this._audit({
          kind: 'ad-switch', step: 'resolve-unknown-attempt', shopId: shopCfg.id, actionId: slot.actionId, ok,
          settledAs: ok ? 'enable_target_not_achieved' : null, evidence: ok ? evidence : null,
          reason: ok ? note : String((res && res.reason) || '目标未达成结案失败：保持阻塞').slice(0, 200),
        });
        return {
          resolved: ok,
          resolvedAs: ok ? 'enable_target_not_achieved' : undefined,
          actionId: slot.actionId,
          evidenceSummary: ok ? evidenceSummary : undefined,
          reason: ok ? note : String((res && res.reason) || '目标未达成结案失败：保持阻塞'),
        };
      }
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
   * 最近一次**动作回读确认**的同店状态（仅诊断展示用：区分「纯观测」与「真实确认」）。
   * 2026-10-10 客户答复后不再参与决策：equal+mixed 统一暂停收敛到 off，不沿用历史目标，
   * 也不因「无历史目标」零动作。来源只有回读确认过的批次（adBelief 由 _commitExecutedBatch
   * 仅在 allPaused/allEnabledConfirmed 时写入）；partial/unknown 不写 → null。
   */
  _reliableConfirmedTarget(shopId) {
    const b = (this.adBelief || {})[shopId];
    if (!b || !b.at) return null;
    if (b.on === true) return 'on';
    if (b.on === false) return 'off';
    return null;
  }

  /**
   * mixed 收敛视图（界面/推送消费）：mixed 只作过渡观测，**永不**作为完成态。
   * 全部取自真实状态源（运行时观测 + 串行门 + 执行器在途计数 + 最近一次决策 + 店铺启用态），
   * 不按文案猜测：
   *   retrying 重试中：该店修复动作正在执行；
   *   rejudging 重新判定：旧动作仍是 unknown 阻塞且本轮回读 mixed（证据优先保留）；
   *   no_repair_scheduled 未安排收敛：店铺停用/仅只读刷新，或最近一次决策是
   *     等于阈值保持等合法零动作——没有任何收敛动作被安排，
   *     mixed 仍非完成态，但不得宣称"待收敛"；
   *   pending_recheck 待收敛：活动店铺本轮回读 mixed，等待下一次重判/修复。
   *
   * @param {string} shopId
   * @param {object} [opts] { noRepairScheduled: true, cycleActive: true }
   *   noRepairScheduled=调用方已确认本轮无收敛安排；cycleActive=本轮真实巡查在途
   *   （此时不得用 Monitor.running=false 推断"未安排"）。
   */
  _mixedReconcileView(shopId, opts = {}) {
    const rt = (this._runtimeMap && this._runtimeMap.get(shopId)) || {};
    const orch = this._switchOrchestrator;
    const observed = rt.lastAdState || null;
    const inflight = orch && typeof orch.mixedInflightProof === 'function'
      ? (orch.mixedInflightProof(shopId).inflight || 0) : 0;
    const unknownBlock = orch && typeof orch.hasUnknownBlock === 'function'
      ? orch.hasUnknownBlock(shopId) === true : false;
    const pending = orch && typeof orch.pendingMixedReconcile === 'function'
      ? orch.pendingMixedReconcile(shopId) : null;
    // 店铺已删除：监控不再轮询，也没有任何收敛动作会被安排（只读刷新不得冒充待收敛）。
    // D56：单店停用已取消，未删除店铺即使历史 enabled=false 也属正常巡查范围。
    const shop = (this.config && Array.isArray(this.config.shops))
      ? this.config.shops.find((s) => s && s.id === shopId) : null;
    const shopInactive = !!(shop && shop.deleted === true);
    // 最近一次决策为合法零动作（等于阈值保持等）：本轮也没有安排收敛动作。
    // 每次 _applyObservedAdState 写入新观测都会清空 lastDecision，因此这里读到的只会是
    // 与当前观测同源的最新决策；后续只读刷新/新日期/新指标不会沿用旧决策。
    const lastDecision = rt.lastDecision && rt.lastDecision.decision;
    const decisionNoAction = lastDecision === DECISION.EQUAL_NO_ACTION
      || lastDecision === DECISION.ZERO_ORDER_NO_PAUSE
      || lastDecision === DECISION.SPEND_PROTECTED;
    // 监控未运行时没有后续定时巡查，也就不会安排新的收敛动作；但真实修复在途/unknown
    // 阻塞是硬证据，必须优先保留（见 evidenceBlocksNoRepair）。
    // opts.cycleActive=true：调用方正处于本轮真实巡查中，不得用"未运行"推断未安排。
    const monitorStopped = this.running === false && opts.cycleActive !== true;
    const evidenceBlocksNoRepair = inflight > 0 || unknownBlock;
    const noRepairScheduled = !evidenceBlocksNoRepair && (opts.noRepairScheduled === true
      || shopInactive || decisionNoAction || monitorStopped);
    let state = null;
    if (inflight > 0) state = 'retrying';
    else if (observed === 'mixed' && unknownBlock) state = 'rejudging';
    else if (noRepairScheduled && (observed === 'mixed' || pending)) state = 'no_repair_scheduled';
    else if (observed === 'mixed' || pending) state = 'pending_recheck';
    return {
      observedAdState: observed,
      mixedIsCompletion: false,
      completedByObservation: observed === 'on' || observed === 'off',
      reconcileState: state,
      reconcileText: MIXED_RECONCILE_TEXT[state] || null,
      unknownBlock,
      repairInflight: inflight > 0,
      pendingReconcile: pending || null,
      noRepairScheduled,
      reliableTarget: this._reliableConfirmedTarget(shopId),
    };
  }

  /**
   * mixed 重判所需的新鲜数据：当前费用、订单、最新阈值、身份。
   * 任一读取/核验失败 → null（调用方零新广告动作）。
   */
  async _readMixedReconcileData(shopCfg) {
    const coord = this._getCoordinator(shopCfg);
    let data;
    try {
      data = await coord.readAndEvaluate(shopCfg);
    } catch (e) {
      const reason = `mixed 重判重新读取费用/订单失败：${e.reason || e.message}`;
      this._audit({ kind: 'ad-switch', step: 'mixed-reconcile-data', shopId: shopCfg.id, ok: false, reason });
      return null;
    }
    if (!data || data.ok === false) {
      this._audit({ kind: 'ad-switch', step: 'mixed-reconcile-data', shopId: shopCfg.id, ok: false, reason: `mixed 重判费用/订单核验未通过：${(data && data.reason) || '未知'}` });
      return null;
    }
    const idState = this._shopIdentityState(shopCfg);
    return {
      data,
      thresholdCents: this._thresholdCents(shopCfg),
      identityOk: idState.pending !== true,
      identityReason: idState.reason,
    };
  }

  /**
   * mixed 重判 + 同轮一次修复（客户 2026-10-10 新目标：mixed 只是过渡观测，不是完成态）。
   *
   * 触发时机：本店存在旧 unknown 阻塞槽位（上一轮/重启遗留），或本轮动作刚回读未确认；
   * 两条路径都进入本方法，且**每次 _runShopSwitchAction 至多一次额外修复动作**
   * （嵌套修复自身带 fromMixedReconcile，不再递归交接）——不忙循环、不无限补点。
   *
   * 同轮真实链路：readFull（本轮完整清单）→ 新鲜费用/订单/最新阈值重判 → 证据齐全时
   * 串行门原子交接 → 再次 _runShopSwitchAction（Monitor→Orchestrator→runner/executor→
   * 动作后完整回读）。仍 mixed → 如实 pending（待收敛/后续重判），绝不标 confirmed。
   *
   * @returns {Promise<object|null>} null=本轮不交接（无 unknown 槽/非 mixed/已停止，
   *   交回原有收口与阻断路径）；否则返回 poll 结果同构状态对象。
   */
  async _mixedReconcileRepair(shopCfg, cycleToken, trigger, ctx = {}) {
    const orch = this._switchOrchestrator;
    if (!orch || typeof orch.reconcileMixedAndReoperate !== 'function') return null;
    if (cycleToken && cycleToken.aborted === true) {
      this._audit({ kind: 'ad-switch', step: 'mixed-reconcile', shopId: shopCfg.id, ok: false, reason: '本轮已停止/取消：零新广告动作，旧 unknown 保持阻塞' });
      return null;
    }
    if (!this._isShopActive(shopCfg.id)) {
      this._audit({ kind: 'ad-switch', step: 'mixed-reconcile', shopId: shopCfg.id, ok: false, reason: '店铺已删除或停用：零新广告动作' });
      return null;
    }
    let freshData = null;
    const res = await orch.reconcileMixedAndReoperate({
      shopId: shopCfg.id,
      readFull: async () => this._readCurrentAdState(shopCfg),
      redecide: async () => {
        freshData = await this._readMixedReconcileData(shopCfg);
        if (!freshData) {
          return { decision: DECISION.DATA_BLOCKED, action: null, zeroClick: true, reason: 'mixed 重判未取到可信的费用/订单/阈值：零新广告动作' };
        }
        const d = orch.evaluatePeriodic({
          costCents: freshData.data.cost.valueCents,
          orders: freshData.data.orders.valueCount,
          thresholdCents: freshData.thresholdCents,
          currentAdState: 'mixed',
          identityOk: freshData.identityOk === true,
          identityReason: freshData.identityReason || null,
          adStateSource: 'mixed_reconcile',
        });
        this._audit({
          kind: 'ad-switch',
          step: 'mixed-rejudge',
          shopId: shopCfg.id,
          stage: ctx.stage || 'entry',
          metric: d.metric,
          decision: d.decision,
          action: d.action,
          targetState: d.targetState,
          thresholdCents: freshData.thresholdCents,
          costCents: freshData.data.cost.valueCents,
          orders: freshData.data.orders.valueCount,
          previousAction: ctx.previousAction || null,
          directionFlipped: ctx.previousAction ? d.action !== ctx.previousAction : null,
          note: '观测来自本轮完整清单回读；equal+mixed 按客户 2026-10-10 答复统一暂停收敛 off，不沿用历史目标',
        });
        return d;
      },
      // 交接证据：旧执行器已结束且无在途写入才允许交接（读取收口由每次读取自身的有界关闭负责）。
      inflightProof: () => {
        const p = orch.mixedInflightProof(shopCfg.id);
        return {
          executorFinished: p.executorFinished === true,
          noInflightWrites: p.noInflightWrites === true,
          inflight: p.inflight || 0,
        };
      },
      persist: () => this._saveState(),
      // 交接成功、再操作开始前：停止/店铺失效必须零新动作并如实收口新登记槽（不留不死槽）
      abortCheck: () => {
        if (cycleToken && cycleToken.aborted === true) return '本轮已停止/取消';
        if (!this._isShopActive(shopCfg.id)) return '店铺已删除或停用';
        return null;
      },
      runAction: async (repairAction, rctx) => {
        this._audit({ kind: 'ad-switch', step: 'mixed-repair-start', shopId: shopCfg.id, action: repairAction, actionId: rctx.actionId, previousActionId: rctx.previousActionId, trigger: trigger || null });
        return this._runShopSwitchAction(shopCfg, repairAction, freshData.data, cycleToken, trigger, {
          fromMixedReconcile: true,
          previousActionId: rctx.previousActionId,
          preActionId: rctx.actionId,
          mixedConvergePause: (rctx.decision && rctx.decision.reconcileBasis) === 'equal_mixed_unified_pause',
        });
      },
    });
    if (!res || res.skipped === true) return null;
    const meta = {
      stage: ctx.stage || 'entry',
      reconciled: res.reconciled === true,
      // 未交接时 res.actionId 即旧槽；已交接时旧槽在 previousActionId，res.actionId 是新动作
      oldActionId: res.reconciled === true ? (res.previousActionId || null) : (res.actionId || null),
      previousAction: res.previousAction || null,
      actionId: res.actionId || null,
      repairAction: res.reconciled === true ? (res.repair && res.repair.action) || null : null,
      targetState: res.targetState || null,
      decision: res.decision || null,
      directionChanged: res.directionChanged === true,
      reason: res.reason || null,
    };
    if (res.reconciled !== true) {
      // 交接未成功：pending（重判为零动作）或 blocked（证据/回读/持久化/身份不足）——均零新动作
      const blockedDecision = res.decision === DECISION.DATA_BLOCKED || res.decision === DECISION.UNKNOWN_BLOCKED;
      const status = res.pending === true && !blockedDecision ? 'pending' : 'blocked';
      // F4 诚实性：只有**本轮回读可信且确为 mixed**才记 mixed；回读异常/被阻止 → 如实 unknown，
      // 绝不把失败写成 mixed 过渡态，也绝不写收敛。
      const trustworthy = res.observedTrustworthy === true;
      const observedState = trustworthy ? (res.currentAdState || 'mixed') : 'unknown';
      this._applyObservedAdState(
        shopCfg.id,
        observedState,
        trustworthy
          ? 'mixed 重判：本轮回读 mixed（过渡观测，非完成态）'
          : 'mixed 重判本轮未取得可信清单：保持 unknown（不伪称 mixed），零新广告动作',
      );
      this._audit({ kind: 'ad-switch', step: 'mixed-reconcile', shopId: shopCfg.id, ok: false, status, actionId: res.actionId || null, currentAdState: observedState, observedTrustworthy: trustworthy, reason: res.reason });
      return {
        status,
        over: false,
        zeroClick: true,
        action: ctx.action || null,
        actionId: res.actionId || null,
        serial: 'unknown',
        decision: res.decision || null,
        currentAdState: observedState,
        observedTrustworthy: trustworthy,
        reason: res.reason,
        outcome: null,
        batch: null,
        mixedReconcile: {
          ...meta,
          observedTrustworthy: trustworthy,
          observedAdState: observedState,
          state: status === 'pending' ? 'pending_recheck' : (trustworthy ? 'handoff_blocked' : 'read_untrusted'),
        },
        ...(status === 'blocked' ? { blocked: trustworthy ? 'mixed_handoff' : 'mixed_readback' } : { pending: true }),
      };
    }
    const repair = res.repair || {};
    // 收敛判定只认**本轮动作后的完整回读确认**（serial=confirmed 或批次显式全量确认布尔）；
    // 动作前的 mixed 观测（repair.currentAdState）不是收敛证据，也不是未收敛证据。
    const rb = repair.batch || {};
    const repairConfirmed = repair.serial === 'confirmed'
      || rb.allPausedConfirmed === true || rb.allEnabledConfirmed === true
      || (repair.chengfang && (repair.chengfang.allPausedConfirmed === true || repair.chengfang.allEnabledConfirmed === true));
    // 修复轮回读到的真实状态（本轮完整清单）：on/off=已统一（只读证据，非动作确认）；
    // mixed/unknown/null=仍未收敛。缺失时保持 unknown，**绝不补写 mixed**。
    const repairObserved = ['on', 'off', 'mixed', 'unknown'].includes(repair.currentAdState)
      ? repair.currentAdState
      : (['on', 'off', 'mixed', 'unknown'].includes(res.currentAdState) ? res.currentAdState : 'unknown');
    const readbackConverged = repairConfirmed !== true && (repairObserved === 'on' || repairObserved === 'off');
    meta.converged = repairConfirmed === true;
    meta.readbackConverged = readbackConverged;
    meta.repairStatus = repair.status || null;
    meta.repairSerial = repair.serial || null;
    meta.observedAdState = repairObserved;
    meta.state = repairConfirmed
      ? 'converged'
      : (repair.serial === 'unknown'
        ? 'not_converged'
        : (readbackConverged ? 'readback_converged' : 'pending_recheck'));
    this._audit({ kind: 'ad-switch', step: 'mixed-reconcile-done', shopId: shopCfg.id, actionId: meta.actionId, previousActionId: meta.previousActionId, repairStatus: repair.status || null, repairSerial: repair.serial || null, converged: repairConfirmed === true, observedAdState: repairObserved, reason: repair.reason || null });
    // 当前视图与「动作前观测」严格区分（F8）：
    // - repairConfirmed=true（本轮动作绑定的完整回读：serial confirmed / allEnabledConfirmed / allPausedConfirmed）
    //   才可建立当前 on/off，走 action_confirm 并保留真实确认时间；动作前的 mixed（repair.currentAdState）
    //   仅留在 meta.observedAdState 作诊断，绝不用旧 prestate 覆盖确认后视图。目标只认本轮动作类型
    //   （enable→on / pause→off），不据旧 adBelief/旧目标/仅计划动作/unknown 推断成功。
    // - 未确认（含本轮只读回读收敛 on/off 或非完成 mixed/unknown）：仍按只读观测进入视图，绝不伪称动作确认。
    if (repairConfirmed === true) {
      const confirmedTarget = meta.repairAction === 'enable' ? 'on'
        : meta.repairAction === 'pause' ? 'off'
        : (meta.targetState === 'on' || meta.targetState === 'off') ? meta.targetState : null;
      if (confirmedTarget) {
        const rt = this._runtime(shopCfg.id);
        // 保留既有真实确认时间（动作批次确认已落时间）；无则记本轮动作确认时间
        const keepAt = (rt.adStateEvidenceKind === 'action_confirm' && rt.lastAdState === confirmedTarget && rt.adStateConfirmedAt)
          ? rt.adStateConfirmedAt : undefined;
        this._applyConfirmedAdState(shopCfg.id, confirmedTarget, keepAt,
          `mixed 修复轮动作确认（${meta.repairAction || 'switch'}→${confirmedTarget}，本轮完整回读；动作前观测 ${repairObserved}）`);
      }
    } else if (repairObserved !== 'unknown' || repair.currentAdState == null) {
      this._applyObservedAdState(shopCfg.id, repairObserved, `mixed 修复轮回读 ${repairObserved}（只读证据）`);
    }
    const out = {
      ...repair,
      currentAdState: repairObserved,
      mixedReconcile: meta,
      previousActionId: meta.oldActionId || null,
    };
    // 再操作被终止/抛错/无结果（repair 为空）时，仍须给出与 poll 同构的如实契约：
    // 零动作/保持阻塞，绝不落到 ok，也绝不带出 mixed。
    if (!out.status) out.status = (res.blocked || res.serial === 'unknown') ? 'blocked' : 'pending';
    if (res.blocked) out.blocked = res.blocked;
    if (res.serial && out.serial == null) out.serial = res.serial;
    if (out.zeroClick == null) out.zeroClick = res.zeroClick === true;
    if (!out.reason) out.reason = res.reason || repair.reason || null;
    if (res.persistence) out.persistence = res.persistence;
    if (out.status !== 'ok') out.over = false;
    if (repairConfirmed !== true && out.status === 'ok' && !readbackConverged) {
      // mixed 修复动作后仍未取得完整回读确认，且本轮回读仍非统一 on/off：
      // 不是完成态，如实 pending（待收敛）；状态保持本轮真实观测（mixed/unknown），不伪 mixed。
      out.status = 'pending';
      out.pending = true;
    }
    return out;
  }

  /**
   * 生产回读外壳（批次二收敛：单次读 + 有界关闭 + 失败重试一次）：
   * - 每次读取独立浏览器；整次读取共用一个 deadline（默认 300s）；
   * - 会话关闭在 _readChengfangAdState 的 try/finally 内以 closeWaitMs（默认 60s）有界完成；
   * - 仅瞬态错误在同一 deadline 预算内重试一次；关闭失败只记日志，不登记跨周期收口门；
   * - 截止后到达的迟到会话立即有界关闭，绝不留无人管理的浏览器。
   * 审计 kind:ad-state-read：start / done(ok|error) / deadline / retry。
   */
  async _readChengfangAdStateBounded(shopCfg) {
    // 全局浏览器操作排队锁（PROMO-IMPL-F1）：外壳取锁 → 读取（含瞬态重读/会话关闭）→
    // finally 释放；锁忙不进入真实读取，返回带 globalBusy 的 unknown 标记，绝不编造平台状态。
    const r = await this._withGlobalBrowserOp(() => this._readChengfangAdStateBoundedInner(shopCfg));
    if (r.busy) {
      return {
        state: 'unknown', globalBusy: true,
        error: {
          status: 'blocked', reason: '全局浏览器操作锁忙（其它店发布/恢复/巡查在途），本轮跳过',
          blocked: 'global_browser_op_busy', globalBusy: true,
        },
      };
    }
    return r.value;
  }

  async _readChengfangAdStateBoundedInner(shopCfg) {
    const timeoutMs = this._adStateMsOption('adStateReadTimeoutMs', 300000);
    const closeWaitMs = this._adStateMsOption('adStateCloseWaitMs', 60000);
    // 首读与最多一次瞬态重读共用同一个 deadline；重读只使用剩余预算。
    const deadlineAt = Date.now() + timeoutMs;
    let attempt = 0;
    let firstTransientReason = null;
    while (true) {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) {
        const why = '总期限已到（重读前无剩余预算）';
        try { this._audit({ kind: 'ad-state-read', shopId: shopCfg.id, event: 'deadline', timeoutMs, cleanup: 'closed', why }); } catch (_) { /* 审计失败不影响 */ }
        return { state: 'unknown', error: { status: 'blocked', reason: `回读截止（${timeoutMs}ms）已到：${why}`, blocked: 'ad_state_read', timeout: true, cleanup: 'closed' } };
      }
      try { this._audit({ kind: 'ad-state-read', shopId: shopCfg.id, event: 'start', timeoutMs: remaining, attempt: attempt + 1 }); } catch (_) { /* 审计失败不影响 */ }
      const steps = [];
      let session = null;
      let timedOut = false;
      // 协作取消令牌：截止后不再启动新的店铺/候选浏览器进程，本次 work 尽快 settle。
      const cancelToken = { cancelled: false, reason: null };
      const meta = {
        steps,
        closeWaitMs,
        cancelToken,
        onSession: (sess) => {
          session = sess;
          // 迟到会话（截止后才建立/返回）：立即有界关闭；失败只记日志，不引入跨周期状态。
          if (timedOut) {
            this._closeSessionBounded(sess, closeWaitMs).then((r) => {
              if (!r.closed) log.warn(`回读迟到会话关闭失败（${shopCfg.id}）：${String((r.error && r.error.message) || r.error || 'unknown').slice(0, 120)}`);
            }).catch((e) => {
              log.warn(`回读迟到会话关闭异常（${shopCfg.id}）：${String((e && e.message) || e).slice(0, 120)}`);
            });
          }
        },
      };
      const work = this._readChengfangAdState(shopCfg, meta);
      let timer = null;
      let deadlineFired = false;
      let result;
      try {
        result = await Promise.race([
          work,
          new Promise((resolve) => { timer = setTimeout(() => { timedOut = true; deadlineFired = true; cancelToken.cancelled = true; cancelToken.reason = 'read-deadline'; resolve({ __readDeadline: true }); }, remaining); }),
        ]);
      } catch (e) {
        clearTimeout(timer);
        if (session) await this._closeSessionBounded(session, closeWaitMs).catch(() => {});
        throw e;
      }
      clearTimeout(timer);
      const lastStep = steps.length ? steps[steps.length - 1] : null;
      if (deadlineFired) {
        // 截止收口：对已建立的会话做一次有界关闭；无会话则由 onSession 在迟到会话到达时有界关闭。
        let cleanup = 'closed';
        if (session) {
          const cr = await this._closeSessionBounded(session, closeWaitMs);
          if (!cr.closed) {
            cleanup = 'blocked';
            log.warn(`回读截止后会话关闭失败（${shopCfg.id}）：${String((cr.error && cr.error.message) || cr.error || 'unknown').slice(0, 120)}`);
          }
        }
        try { this._audit({ kind: 'ad-state-read', shopId: shopCfg.id, event: 'deadline', lastStep, timeoutMs, cleanup, attempt: attempt + 1 }); } catch (_) { /* 审计失败不影响 */ }
        const why = cleanup === 'blocked' ? '会话关闭失败/未确认' : '已终止本次会话';
        return { state: 'unknown', error: { status: 'blocked', reason: `回读截止（${timeoutMs}ms）已到：${why}；最后步骤：${lastStep || '未记录'}`, blocked: 'ad_state_read', timeout: true, lastStep, cleanup } };
      }
      // 正常结束：闭环审计（done 携带脱敏后的 blocked/status/reason/timeout/lastStep）。
      try {
        const doneEvent = { kind: 'ad-state-read', shopId: shopCfg.id, event: 'done', outcome: result && result.error ? 'error' : 'ok', lastStep, attempt: attempt + 1 };
        if (result && result.error) {
          const m = this._maskReadError(result.error, shopCfg.id);
          doneEvent.status = m.status;
          doneEvent.errorKind = m.kind;
          doneEvent.blocked = m.blocked;
          doneEvent.reason = m.reason;
          if (m.timeout) doneEvent.timeout = true;
          if (m.lastStep) doneEvent.lastStep = doneEvent.lastStep || m.lastStep;
        }
        this._audit(doneEvent);
      } catch (_) { /* 审计失败不影响 */ }
      // 会话关闭证明：没有证据就是未证明，绝不默认已关闭。
      const closeState = meta.closeState || { closed: false, error: null, source: 'missing' };
      if (closeState.closed !== true) {
        const hadSession = closeState.source === 'session';
        const transient = !!(result && result.error && this._isTransientReadError(result.error));
        if (!hadSession && result && result.error && !transient) return result;
        const why = `本次会话未获得严格关闭证明${closeState.error ? ': ' + String((closeState.error && closeState.error.message) || closeState.error).slice(0, 120) : ''}`;
        log.warn(`回读会话关闭未获证明（${shopCfg.id}）：${why}`);
        const orig = result && result.error && result.error.reason ? `；原始错误：${result.error.reason}` : '';
        try { this._audit({ kind: 'ad-state-read', shopId: shopCfg.id, event: 'blocked', reason: why + orig, attempt: attempt + 1 }); } catch (_) { /* 审计失败不影响 */ }
        return { state: 'unknown', error: { status: 'blocked', reason: `回读结束但${why}${orig}，本次结果不作 on/off 证据`, blocked: 'ad_state_read', blockedBy: 'unread_session' } };
      }
      // 空表机读码铸造：只有本次会话关闭已获严格证明才会走到这里。
      if (result && result.error && result.error.emptyTableEvidence) {
        const ev = result.error.emptyTableEvidence;
        const code = evidenceCode({ ...ev, closeProven: true, dispatched: 0 });
        if (code) {
          result.error.emptyTableCode = code;
          try {
            this._audit({
              kind: 'ad-state-read', shopId: shopCfg.id, event: 'empty-table-evidence', code,
              tab: ev.tab, pageNo: ev.pageNo, attempt: attempt + 1,
              total: ev.pagination && ev.pagination.total, hasNext: ev.pagination && ev.pagination.hasNext,
              identityOk: ev.identityOk === true, refreshOk: ev.refreshOk === true,
            });
          } catch (_) { /* 审计失败不影响 */ }
        }
      }
      // 明确瞬态且可安全重读：同一 deadline 内最多一次额外完整回读（重新开 session）。
      if (attempt === 0 && result && result.error && this._isTransientReadError(result.error)) {
        const rem2 = deadlineAt - Date.now();
        if (rem2 > 0) {
          firstTransientReason = String(result.error.reason || '');
          const rt = this._runtime(shopCfg.id);
          rt.lastReadError = {
            kind: 'retrying',
            reason: firstTransientReason,
            blocked: result.error.blocked || 'ad_state_read',
            retrying: true,
            retried: false,
            at: new Date(this.nowFn()).toISOString(),
          };
          try { this._audit({ kind: 'ad-state-read', shopId: shopCfg.id, event: 'retry', attempt: 2, reason: firstTransientReason, remainingMs: rem2 }); } catch (_) { /* 审计失败不影响 */ }
          attempt = 1;
          continue;
        }
      }
      let out = result;
      if (attempt > 0 && result && result.error) {
        out = {
          ...result,
          error: {
            ...result.error,
            retried: true,
            retryCount: 1,
            reason: `首次回读失败（${firstTransientReason || '瞬态错误'}）；已重试1次仍未恢复：${result.error.reason}`,
          },
        };
      }
      if (attempt > 0) {
        // 重试结束必须收口“正在重试”标记：成功清除，失败改为最终分类。
        const rt = this._runtime(shopCfg.id);
        if (out && out.error) {
          rt.lastReadError = {
            kind: this._readErrorKind(out.error, shopCfg.id),
            reason: String(out.error.reason || ''),
            blocked: out.error.blocked || 'ad_state_read',
            retrying: false,
            retried: true,
            at: new Date(this.nowFn()).toISOString(),
          };
        } else if (rt.lastReadError && rt.lastReadError.kind === 'retrying') {
          rt.lastReadError = null;
        }
      }
      return out;
    }
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
      // audit 透传：只读状态开会话与批次开会话同链（默认开启器 → openChengfangShop/检查点）
      session = await opener({
        loginCfg, shopCfg, audit: (e) => this._audit(e), readOnlyStatus: true,
        // fix3：乘方/enable-phase 读取路径与 poll 同款对照店接线（restoreControlCheck +
        // onAuthClosedOut 经 defaultChengfangOpener → openChengfangShop → openQianchuanHome
        // 透传进恢复链）。未登记 authRecoveryPolicy 的店铺不进 fix3，对其零影响。
        ...this._authRecoveryWiring(shopCfg),
        ...( (_meta && _meta.cancelToken) ? { cancelToken: _meta.cancelToken } : {} ),
      });
      if (_meta && _meta.onSession) _meta.onSession(session);
      if (!session || !session.page || (!session.controller && !session.readOnlyEmpty)) {
        return { state: 'unknown', error: { status: 'blocked', reason: '乘方会话不完整（缺 page/controller）', blocked: 'ad_state_read' } };
      }
      const { page, controller } = session;
      markStep('identity');
      const identity = session.readOnlyEmpty
        ? await verifyChengfangReadOnlyEmpty({ evidence: session.readOnlyEmpty, page, shopCfg })
        : await controller.verifyIdentity({ page, shopCfg });
      guard.checkControllerIdentity(identity, shopCfg);
      const identityOk = identity.ok === true;
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
      if (session.readOnlyEmpty) {
        const freshIdentity = await verifyChengfangReadOnlyEmpty({ evidence: session.readOnlyEmpty, page, shopCfg });
        guard.checkControllerIdentity(freshIdentity, shopCfg);
        return { state: mapAdStateFromSwitchRows([], { confirmedEmpty: true }), rows: [], identity: freshIdentity, balance, switchEvidence: null };
      }
      const rows = [];
      let sawTab = false;
      let emptyEvidence = true;
      for (const tab of tabs) {
        let tabRefreshOk = false;
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
          tabRefreshOk = rf.refreshed === true;
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
              // 空表机读码证据（只观测本站点亲自掌握的事实；关闭证明与派发数由收口方补齐）：
              // 本次清单仍如实 unknown/blocked，绝不因为"可能有 1 行"而当作无计划。
              const err = { state: 'unknown', error: { status: 'blocked', reason: `乘方「${tab}」无行但缺少空态证据（分页 total=${pag.total == null ? '缺失' : pag.total}）`, blocked: 'inventory' } };
              err.error.emptyTableEvidence = {
                tab, pageNo, activePage: pag.activePage, rows: list,
                pagination: { total: pag.total, hasNext: pag.hasNext },
                identityOk, refreshOk: tabRefreshOk,
              };
              return err;
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
      const reason = e.reason || e.message;
      const isIdentity = /身份/.test(String(reason));
      const authType = (e instanceof AuthError || (e && e.code === 'AUTH')) && !isIdentity;
      // opener 在返回会话前失败时，适配器可能已创建并关闭了浏览器；只有它给出的
      // 「本次已严格关闭」独立核对证据才能作为同一周期重读的依据。
      const cleanup = readChengfangCleanupEvidence(e);
      if (_meta && cleanup) _meta.openerCleanup = cleanup;
      // F5-R9：Cookie 解析/结构/读取受阻、身份、通用 Auth 均按具体故障分类；
      // 只有正式登录检测的正证据才是 auth（可要求重新登录），其余保持原 reason。
      // AUTH-60S FINAL：携带 loginEvidence 时由结构性证据 + 连续观测窗口决定 cls（任一
      // 正向证据未满 60s → null → read_failed；跨轮连续 ≥60s 才 auth）。
      const cls = this._failureClassWithError(shopCfg && shopCfg.id, e, reason);
      const blocked = cls || (isIdentity ? 'identity' : (authType ? 'read_failed' : 'inventory'));
      return {
        state: 'unknown',
        error: {
          status: 'blocked',
          reason,
          blocked,
          auth: cls === 'auth' || undefined,
          loginEvidence: (e && e.loginEvidence) || undefined,
          // fix3：与 _readCurrentAdState 两个 catch 对齐——保留读取器交付的 auth 结案证据，
          // 供 _applyReadFailure 落盘证据包并在结案后释放该店串行门（不再丢弃）。
          authClosure: (e && e.authClosure) || undefined,
        },
      };
    } finally {
      // 严格关闭并记录结果：外层只有拿到 closed===true 才允许同一周期内重读；
      // 关闭失败/未确认一律阻断，绝不把"关不掉"当作可重试。
      // 关键修正（2026-10-18 F2-R3）：opener 抛错时 session 仍为 null，旧实现据此
      // 默认 closed=true，等于把「浏览器可能已创建但未证明关闭」当成可安全重读。
      let closed = false;
      let closeError = null;
      let source = 'missing';
      if (session) {
        // R9（2026-10-25）：无 _meta 直调时的 fallback 与有界外壳默认保持一致（60s），
        // 显式 adStateCloseWaitMs 配置仍优先；严格 browser.close 成功才算 closed 不变。
        const waitMs = (_meta && _meta.closeWaitMs) || this._adStateMsOption('adStateCloseWaitMs', 60000);
        const cr = await this._closeSessionBounded(session, waitMs);
        closed = cr.closed === true;
        closeError = cr.error || null;
        source = 'session';
      } else if (_meta && _meta.openerCleanup) {
        closed = _meta.openerCleanup.closed === true;
        source = 'opener-cleanup';
        if (!closed) closeError = new Error(`opener 失败路径未证明本次浏览器已关闭（${_meta.openerCleanup.source || 'unknown'}）`);
      } else {
        closeError = new Error('本次回读未建立可核验的会话，也没有可核验的关闭证明');
      }
      if (_meta) _meta.closeState = { closed, error: closeError, source };
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
   * opts.mixedConvergePause：本轮暂停的依据是「完整回读 mixed + 新鲜重判仍恰等于阈值」的统一收敛
   * 暂停（客户 2026-10-10），不是严格超标；执行器仍需自己复核新鲜数据等于阈值。
   */
  async _runShopSwitchAction(shopCfg, action, data, cycleToken, trigger, opts = {}) {
    // 预登记槽（mixed 交接原子登记）在任何提前退出前都必须精确收口为未发出，
    // 否则该店永久 busy（P2 泄漏）；落盘失败由编排器 fail-closed 转 unknown 阻塞。
    const settlePre = (reason) => {
      if (opts.preActionId == null) return null;
      const r = this._switchOrchestrator.settlePreActionNotSent(shopCfg.id, opts.preActionId, reason, () => this._saveState(), 'monitor-early-exit');
      return r.persistFailed === true
        ? { serial: 'unknown', blocked: 'persistence', persistence: { ok: false, reason: r.reason } }
        : { slotReleased: r.released === true };
    };
    if (!this._isShopActive(shopCfg.id)) {
      const pre = settlePre('店铺已删除或停用：未发出');
      return { status: 'blocked', reason: '店铺已删除或停用，拒绝执行广告操作', zeroClick: true, outcome: 'blocked_stopped', ...(pre || {}) };
    }
    // 缺少店铺配置仍拒绝；自动发现店使用自己的 Cookie，不要求预填账户号。
    const idGate = this._shopIdentityState(shopCfg);
    if (idGate.pending) {
      this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason: idGate.reason, blocked: 'identity_pending', zeroClick: true });
      const pre = settlePre(`身份待核验：未发出（${idGate.reason}）`);
      return { status: 'blocked', reason: idGate.reason, zeroClick: true, outcome: 'blocked', blocked: 'identity_pending', ...(pre || {}) };
    }
    if (opts.preActionId != null && cycleToken && cycleToken.aborted === true) {
      // 仅预登记槽需要此处提前退出（否则新槽永不恢复）；无预登记槽沿用执行器自身的停止/取消处理
      this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason: '本轮已停止/取消', blocked: 'stopped', zeroClick: true });
      const pre = settlePre('本轮已停止/取消：未发出');
      return { status: 'blocked', reason: '本轮已停止/取消，零广告动作', zeroClick: true, outcome: 'blocked_stopped', blocked: 'stopped', ...(pre || {}) };
    }
    // unknown 只作为上一轮审计结果，不是跨轮锁：本入口不再先做额外的整页回读核验
    // （那会让费比超标暂停多等一次页面读取）；串行门 tryBegin 会用新 actionId 直接
    // 替换旧 unknown 槽，仅真实 in-flight 才拒绝并发。
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
      preActionId: opts.preActionId || null,
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
            this._setShopActivity(shopCfg.id, this.realMode ? '关闭广告中（乘方暂停）' : '暂停枚举中（演练，零点击）');
            const r = await this._pollChengfangOver(shopCfg, data, cycleToken, trigger, {
              mixedConvergePause: opts.mixedConvergePause === true,
            });
            return this._normalizeExecuteResult(r, 'pause');
          }
          if (this._legacyWholeShopAllowed()) {
            this._setShopActivity(shopCfg.id, '关闭广告中（全店关闭）');
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
        this._setShopActivity(shopCfg.id, '开启广告中（乘方开启）');
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
    // 动作回读未确认（unknown/partial）且本轮不是修复轮：mixed 不是完成态，同轮重判并重操作一次
    // （有界：本调用带 fromMixedReconcile 的嵌套修复不再交接，不忙循环、不无限补点）。
    if (opts.fromMixedReconcile !== true && settled && settled.serial === 'unknown') {
      const postReconcile = await this._mixedReconcileRepair(shopCfg, cycleToken, trigger, {
        stage: 'post-action', action, previousAction: action,
      });
      if (postReconcile) return postReconcile;
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
    // 终态未落盘一律 persistence_blocked（不得按 serial 是否 not_sent 挑一半）：
    // 未发出/已确认收口失败都可能造成内存与磁盘分裂，必须如实 blocked 并保持门闩。
    if (!outcome && s.persistence && s.persistence.ok === false) {
      outcome = 'persistence_blocked';
    }
    let status = 'ok';
    if (s.blocked === 'serial_gate' || s.blocked === 'persistence'
        || s.blocked === 'pre_action_mismatch' || s.blocked === 'pre_action_settled') status = 'blocked';
    else if (nested.status === 'window_blocked' || outcome === 'blocked_window' || s.status === 'window_blocked') status = 'window_blocked';
    else if (nested.status === 'stopped' || outcome === 'blocked_stopped') status = 'stopped';
    else if (nested.status === 'blocked' || outcome === 'blocked' || outcome === 'blocked_coverage') status = 'blocked';
    else if (outcome === 'persistence_blocked') status = 'blocked';
    // fail-closed 的零动作判定（unknown/数据阻断）不得包成 ok：本轮没有可信状态，也没有动作
    else if (s.zeroClick === true && (s.decision === DECISION.UNKNOWN_BLOCKED || s.decision === DECISION.DATA_BLOCKED)) status = 'blocked';
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
  async _executeEnableBatchFor(shopCfg, cycleToken, opts = {}) {
    // 全局浏览器操作排队锁（PROMO-IMPL-F1）：开关动作执行处取锁 → 执行 → finally 释放。
    // 锁忙 = 本轮零动作跳过（不调用真实执行体、不点任何开关），审计同形状 skipped。
    const r = await this._withGlobalBrowserOp(() => this._executeEnableBatchForInner(shopCfg, cycleToken, opts));
    if (r.busy) {
      this._auditGlobalBrowserOpBusy(shopCfg.id);
      return {
        status: 'skipped', outcome: 'skipped', neverSent: true, globalBusy: true, zeroClick: true,
        reason: '全局浏览器操作锁忙（其它店发布/恢复/巡查在途），本轮跳过开关动作',
        counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
      };
    }
    return r.value;
  }

  async _executeEnableBatchForInner(shopCfg, cycleToken, { reason, triggerLabel, enableSource = 'daily_schedule' } = {}) {
    const runner = this._getChengfangRunner(shopCfg);
    const opener = this._chengfangOpener || defaultChengfangOpener;
    const loginCfg = this.config.login;
    try {
      this._setShopActivity(shopCfg.id, this.realMode ? '开启广告中（乘方开启）' : '开启枚举中（演练，零点击）');
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
    // 同店跨上下文互斥（PROMO-IMPL-E1）：该店当日发布/恢复租约在途 → 本轮读取/动作全部跳过，
    // 避免值守浏览器与发布/恢复浏览器同店并发（Cookie/会话为店铺级共享资源）。
    // 覆盖常规巡查与登录后立即巡查两条入口；跨店不受影响；不编造平台状态（unknownReason 原样）。
    if (this._publishLeaseInFlight(shopCfg)) {
      this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'skipped', reason: 'publish-lease-in-flight' });
      return { status: 'skipped', reason: '该店发布/恢复租约在途，本轮跳过避免同店浏览器并发' };
    }
    const rt = this._runtime(shopCfg.id);
    try {
      // 1) 登录态静态核验（Cookie 文件存在/结构/有效期）
      const cookieMeta = loadShopCookieMeta(this.config.login, shopCfg);
      rt.cookieCheckedAt = new Date(this.nowFn()).toISOString();
      rt.cookieMeta = { count: cookieMeta.count, readOnly: cookieMeta.readOnly, maxExpires: cookieMeta.maxExpires };

      // 2) 读取+核验费用/订单并评估规则（零订单与正单同一公式，2026-10-27 修正）
      const coord = this._getCoordinator(shopCfg);
      let data;
      try {
        this._setShopActivity(shopCfg.id, '读取数据中（费用/订单）');
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
      // 竞态修正（2026-10-31）：本轮读数组装为 candidate；_readCurrentAdState 之前绝不提交
      // rt.lastData，避免在途出现「新费用 + balanceCents=null（未写终态）」的半成品视图。
      const candidate = this._summarizeData(data);
      this._markShopDataRefreshing(rt);

      // 有效同日费用/订单的规则评估先投影兼容字段；后续决策以同值覆盖（仍在 candidate 上）。
      if (data.ok !== false && data.evaluation) {
        candidate.spendFloorCents = SPEND_FLOOR_CENTS;
        candidate.spendProtected = data.evaluation.spendProtected === true;
        candidate.pauseEligible = data.evaluation.pauseEligible === true;
        candidate.roiTooLow = data.evaluation.roiTooLow === true;
      }

      // 概览先行落盘（2026-11-02 第 1 项：概览与清单空态解耦）：cost+orders 已核验成功即写
      // rt.today / shopRows；后面的商品自选空态、ad=unknown、回读抛错或超时只影响 adState
      // 与开关动作，绝不把本轮已成功的 costCents/orders 吞掉或打成 null。
      if (data.ok !== false) this._commitShopOverview(rt, candidate);

      // 早退路径不读广告状态/余额：candidate 先写余额终态（skipped）再提交，保持终态完整。
      if (data.ok === false) {
        candidate.blockedReason = data.reason;
        this._commitShopLastDataSkippedBalance(rt, candidate, '本轮数据读取失败，未读取千川余额');
        this._emitJudgement(shopCfg, { data, over: null, status: 'blocked', reason: data.reason });
        this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason: data.reason, blocked: data.blocked });
        return { status: 'blocked', reason: data.reason, blocked: data.blocked };
      }

      // 3) 门禁优先：有效控制路径/范围（already_* 不得把门禁失败包成 ok）
      if (!this._chengfangScopeConfigured() && !this._legacyWholeShopAllowed()) {
        const scopeBlockedReason = '未配置乘方控制范围（monitor.chengfang.scope）且未显式开启历史全店路径：监控不执行任何关闭';
        candidate.blockedReason = scopeBlockedReason;
        this._commitShopLastDataSkippedBalance(rt, candidate, '控制范围门禁未通过，未读取千川余额');
        this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: scopeBlockedReason }, undefined, 'error');
        this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'blocked', reason: scopeBlockedReason });
        return { status: 'blocked', reason: scopeBlockedReason };
      }

      // 4) 时间窗口（客户 2026-11-08 S2：费比严格超标后暂停为最高业务优先级，
      // 删除 pauseEligible 的首查未完成与 dailyStartHour 早退——暂停不再被时间/首查窗口拦截；
      // 首查安全门禁仅拦下方的 threshold recovery enable，不拦 SHOULD_PAUSE 与超标 already_off）。
      // D53（2026-10-30）：门禁以**实际生效**的调度器判定为准（enableSchedulerShouldRun）。
      const enableWindowCfg = this.enableSchedulerShouldRun();
      const todayDate = shanghaiDate(this.nowFn());

      // 5) 本轮回读 currentAdState（清单身份/完整性失败 → blocked，不得包成 ok）
      this._setShopActivity(shopCfg.id, '读取广告状态（乘方清单回读）');
      const stateRead = await this._readCurrentAdState(shopCfg);
      this._applyBalanceToLastData(candidate, stateRead);
      // 全局浏览器操作锁忙（PROMO-IMPL-F1）：本轮跳过该店，绝不改写广告状态、不落读取失败。
      if (stateRead.globalBusy === true) {
        rt.dataRefreshing = false;
        if (rt.lastData && typeof rt.lastData === 'object') rt.lastData.refreshing = false;
        this._auditGlobalBrowserOpBusy(shopCfg.id);
        return { status: 'skipped', reason: '全局浏览器操作锁忙（其它店发布/恢复/巡查在途），本轮跳过', globalBusy: true };
      }
      if (stateRead.error) {
        const err = stateRead.error;
        // 失败/unknown：新错误覆盖旧因，撤销旧 on 证据；只读观测不得伪称动作确认。
        this._applyReadFailure(shopCfg.id, err);
        // 本轮没有可信决策 → 不保留上一轮的 ROI 提示（避免陈旧警告）
        candidate.roiTooLow = false;
        candidate.pauseEligible = false;
        // 竞态修正：带余额终态的本轮读数先原子提交，再返回 blocked。
        this._commitShopLastData(rt, candidate);
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
      this._clearReadFailure(shopCfg.id);
      this._applyObservedAdState(shopCfg.id, currentAdState, '只读清单/页面回读');
      // 竞态修正：余额终态已写入 candidate，此刻一次性原子提交为本轮可见读数。
      this._commitShopLastData(rt, candidate);
      const thresholdCents = this._thresholdCents(shopCfg);
      const decision = this._switchOrchestrator.evaluatePeriodic({
        costCents: data.cost.valueCents,
        orders: data.orders.valueCount,
        thresholdCents,
        currentAdState,
        identityOk: true,
      });
      // 同店同日有效判定 → 页面/日志的 ROI 提示投影（不由 UI 重算；消耗门槛已取消）
      rt.lastData.spendFloorCents = SPEND_FLOOR_CENTS;
      rt.lastData.spendProtected = decision.spendProtected === true;
      rt.lastData.pauseEligible = decision.pauseEligible === true;
      rt.lastData.roiTooLow = decision.roiTooLow === true;
      // 最近一次决策（供 getStatus/mixed 收敛视图如实区分「有修复安排」与「合法零动作」）。
      rt.lastDecision = {
        decision: decision.decision,
        metric: decision.metric,
        action: decision.action,
        targetState: decision.targetState,
        at: new Date(this.nowFn()).toISOString(),
      };

      // 等于阈值保持：合法零动作，本轮没有任何收敛动作被安排。
      // 此时 mixed 仍是过渡观测、仍非完成态，但不得宣称"待收敛"。
      // 只有「合法零动作 + 本轮读取无错误 + 无真实修复在途/unknown 阻塞」才是未安排收敛；
      // 真实 unknown 阻塞或修复在途按证据保留（rejudging/retrying），仍如实 pending。
      const legalNoAction = decision.decision === DECISION.EQUAL_NO_ACTION
        || decision.decision === DECISION.ZERO_ORDER_NO_PAUSE
        || decision.decision === DECISION.SPEND_PROTECTED;
      const mixedViewEarly = currentAdState === 'mixed'
        ? this._mixedReconcileView(shopCfg.id, { noRepairScheduled: legalNoAction, cycleActive: true })
        : null;
      const mixedNoRepair = !!(mixedViewEarly && mixedViewEarly.reconcileState === 'no_repair_scheduled');
      const mixedPending = currentAdState === 'mixed' && !mixedNoRepair;

      // 每周期一条判断：本轮回读 mixed 且零动作、且存在待执行收敛 → pending（待收敛），不是 ok；
      // 合法零动作（等于阈值保持）没有安排收敛 → 如实 ok + 非完成态。
      // mixed + 高于/等于阈值走 should_pause、低于走 should_enable（对侧修复），仍非完成态。
      this._emitJudgement(shopCfg, {
        data,
        over: data.evaluation.over === true,
        status: mixedPending && decision.zeroClick === true ? 'pending' : 'ok',
        reason: decision.reason || data.evaluation.reason,
        decision,
        currentAdState,
      });

      // 6) 决策分流：should_* 进入动作；超标 + already_off 走暂停只读盘点（nothing_to_close）
      // 首查安全门禁（2026-11-08 S2 收窄）：只拦 threshold recovery enable——
      // 费比导致的暂停不能被首查再次强制打开；SHOULD_PAUSE 与超标 already_off 盘点
      // 拥有最高业务优先级，不再被首查未完成拦截。
      if (enableWindowCfg && !this._enablePhaseDone(shopCfg.id, todayDate)
          && decision.decision === DECISION.SHOULD_ENABLE) {
        const reason = `当日首次开启检查未完成（首查安全门禁），费比控制暂不执行：已读取并记录`;
        this._audit({ kind: 'poll', shopId: shopCfg.id, status: 'window_blocked', reason, decision: decision.decision, zeroClick: true });
        return {
          status: 'window_blocked', reason, decision: decision.decision, zeroClick: true,
          currentAdState, businessDate: data.cost.businessDate || todayDate,
        };
      }
      if (decision.decision === DECISION.SHOULD_PAUSE) {
        return this._runShopSwitchAction(shopCfg, 'pause', data, cycleToken, trigger, {
          // 等值 + mixed 的统一暂停（客户 2026-10-10）：runner 需知道本次暂停依据是 mixed 收敛，
          // 而不是「严格超标」；其余 should_pause（超标）保持原严格复核语义。
          mixedConvergePause: decision.reconcileBasis === 'equal_mixed_unified_pause',
        });
      }
      if (decision.decision === DECISION.ALREADY_OFF && data.evaluation.over === true) {
        return this._runShopSwitchAction(shopCfg, 'pause', data, cycleToken, trigger, { allowAlreadyOffPause: true });
      }
      if (decision.decision === DECISION.SHOULD_ENABLE) {
        return this._runShopSwitchAction(shopCfg, 'enable', data, cycleToken, trigger);
      }
      // 其余零动作决策（统一 on/off 已达目标或等于阈值保持、数据/身份阻断、unknown fail-closed）。
      // mixed 只有**存在待执行收敛**时才如实 pending（待收敛/待下一次可信重判）；
      // 合法零动作（等于阈值保持）没有安排收敛 → ok + 明确"未安排收敛"，
      // 绝不伪造 on/off，也不谎称待收敛。
      const mixedStillOpen = currentAdState === 'mixed';
      // 复用本轮判定时已计算的视图：状态与 status 同源，避免二次读取运行时状态漂移。
      const mixedView = mixedStillOpen ? mixedViewEarly : null;
      this._audit({
        kind: 'poll',
        shopId: shopCfg.id,
        status: mixedPending ? 'pending' : 'ok',
        over: false,
        decision: decision.decision,
        metric: decision.metric,
        currentAdState,
        zeroClick: true,
        ...(mixedPending ? { pending: 'mixed_not_converged' } : {}),
        ...(mixedNoRepair ? { noRepairScheduled: true } : {}),
        reason: decision.reason,
      });
      return {
        status: mixedPending ? 'pending' : 'ok',
        over: false,
        zeroClick: true,
        ...(mixedPending ? { pending: true } : {}),
        decision: decision.decision,
        metric: decision.metric,
        currentAdState,
        spendProtected: decision.spendProtected === true,
        pauseEligible: decision.pauseEligible === true,
        roiTooLow: decision.roiTooLow === true,
        reason: decision.reason,
        ...(mixedStillOpen ? {
          mixedReconcile: {
            ...(mixedView || {}),
            stage: 'poll',
            reconciled: false,
            converged: false,
            state: mixedView ? mixedView.reconcileState : 'no_repair_scheduled',
            targetState: decision.targetState || null,
            decision: decision.decision,
            reason: decision.reason,
          },
        } : {}),
      };
    } catch (e) {
      const reason = e.reason || e.message;
      rt.lastError = reason;
      // 异常退出不得把 refreshing 卡在 true（candidate 未提交则维持上一轮已提交读数）。
      rt.dataRefreshing = false;
      if (rt.lastData && typeof rt.lastData === "object") rt.lastData.refreshing = false;
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
  async _pollChengfangOver(shopCfg, data, cycleToken, trigger, opts = {}) {
    // 全局浏览器操作排队锁（PROMO-IMPL-F1）：暂停动作执行处取锁 → 执行 → finally 释放。
    // 锁忙 = 本轮零动作跳过（不打开页面、不点任何开关）。
    const r = await this._withGlobalBrowserOp(() => this._pollChengfangOverInner(shopCfg, data, cycleToken, trigger, opts));
    if (r.busy) {
      this._auditGlobalBrowserOpBusy(shopCfg.id);
      return {
        status: 'skipped', outcome: 'skipped', neverSent: true, globalBusy: true, zeroClick: true,
        reason: '全局浏览器操作锁忙（其它店发布/恢复/巡查在途），本轮跳过暂停动作',
        counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
      };
    }
    return r.value;
  }

  async _pollChengfangOverInner(shopCfg, data, cycleToken, trigger, opts = {}) {
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
      // equal + mixed「统一暂停」：由串行门前的本轮完整回读 + 新鲜重判给出，runner 仍独立复核恰等于阈值
      mixedConvergePause: opts.mixedConvergePause === true,
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
    // 空表机读码 → 只读恢复桥接：partial 收口不变，不重跑 executor，不改写 outcome/counts
    return { status: 'ok', over: true, batch: this._summarizeBatch(batch) };
  }

  // ── 每日自动开启相位（07:00 窗口，每天一次；独立于费用/订单阈值）────

  /** 每日开启相位：遍历启用的店铺执行开启（真实=executeChengfangEnableBatch；演练=runDryEnableCycle）。 */
  async _runEnablePhase(gen, businessDate = null) {
    // 并发由单店锁 _shopProcessing（_runShopEnablePhase → _tryAcquireShop）保证：同店串行、
    // 异店可并行，不需要全局周期布尔。
    // 独立每日开启调度器驱动。生命周期只随 _enableGen/enableRunning 终止，
    // 令牌 kind='enable'——"停止值守"绝不取消每日开启。
    const token = { aborted: false, kind: 'enable' };
    this._activeTokens.add(token);
    const today = businessDate || shanghaiDate(this.nowFn());
    try {
      for (const shopCfg of this._activeShops()) {
        if (gen !== this._enableGen || !this.enableRunning) break;
        if (token.aborted) break;
        // 删除后调度器再次检查活动列表
        if (!this._isShopActive(shopCfg.id)) continue;
        if (this._enablePhaseDone(shopCfg.id, today)) continue;
        await this._runShopEnablePhase(shopCfg, token, today);
      }
    } finally {
      this._activeTokens.delete(token);
    }
    return { skipped: false };
  }

  /**
   * 手动验证每日开启（2026-09-29 第 10 阶段）：对单个已启用店铺，任意时刻触发**同一套**
   * 每日开启预检与决策链（_runShopEnablePhase，source='manual_verify'）——同一真实回读
   * （v3 有界）、身份核验、串行门、当日去重、审计与 fail-closed 规则，不另造旁路。
   * 边界：异步执行（HTTP 不悬挂），状态经 getManualEnableVerifyStatus() 可回读；
   * 与巡查/自动开启不共用全局周期布尔，同店互斥由 _shopProcessing（_shopBusy/_tryAcquireShop）
   * 负责（在途即拒绝，不等待）；当日已 success 去重拒绝；
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
    if (this._shopBusy(shopId)) {
      // WD-NEW-1 并发收口：登录接管等单店处理在途时，同店手动验证拒绝
      return { ok: false, error: '该店已有处理在途（登录接管等），本轮拒绝手动验证', code: 'shop_busy' };
    }
    const today = shanghaiDate(this.nowFn());
    if (this._enablePhaseDone(shopId, today)) {
      return { ok: false, error: `该店 ${today} 每日开启已成功（当日去重，不再重复执行）`, code: 'already_done_today', alreadyDone: true };
    }
    const startedAt = new Date(this.nowFn()).toISOString();
    this._manualVerify = { shopId, status: 'running', startedAt, finishedAt: null, result: null };
    const token = { aborted: false, kind: 'enable' };
    this._activeTokens.add(token);
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
  /**
   * 每日开启预检与决策链（单店）——同店处理互斥外壳（WD-NEW-1 并发收口）：
   * 登录接管/暂停巡查正在处理该店时，本次开启相位**跳过（零动作）**，绝不与其并发同店；
   * 每日任务保持既有重试语义（skipped 不标记当日完成，窗口内重试），手动验证如实报未执行。
   * 原预检与决策链整体移入 _runShopEnablePhaseInner，语义零改动。
   */
  async _runShopEnablePhase(shopCfg, cycleToken, businessDate = null, source = 'daily_schedule') {
    // 同店跨上下文互斥（PROMO-IMPL-E1）：发布/恢复租约在途时本次开启相位零动作，
    // 每日任务保持既有重试语义（skipped 不标记当日完成），手动验证如实报未执行。
    if (this._publishLeaseInFlight(shopCfg, businessDate)) {
      this._audit({ kind: 'enable-phase', shopId: shopCfg.id, event: 'skipped-publish-lease', trigger: source });
      return { status: 'skipped', zeroClick: true, reason: '该店发布/恢复租约在途，本次开启相位跳过（零动作）' };
    }
    if (this._shopBusy(shopCfg.id)) {
      this._audit({ kind: 'enable-phase', shopId: shopCfg.id, event: 'skipped-shop-busy', trigger: source });
      return { status: 'skipped', zeroClick: true, reason: '该店已有处理在途（登录接管/巡查），本次开启相位跳过（零动作）' };
    }
    if (!this._tryAcquireShop(shopCfg.id, '每日开启首查（回读广告状态）')) {
      return { status: 'skipped', zeroClick: true, reason: '同店处理互斥获取失败（并发防御），本次开启相位跳过（零动作）' };
    }
    try {
      return await this._runShopEnablePhaseInner(shopCfg, cycleToken, businessDate, source);
    } finally {
      this._releaseShop(shopCfg.id);
    }
  }

  async _runShopEnablePhaseInner(shopCfg, cycleToken, businessDate = null, source = 'daily_schedule') {
    const rt = this._runtime(shopCfg.id);
    const runner = this._getChengfangRunner(shopCfg);
    const opener = this._chengfangOpener || defaultChengfangOpener;
    const loginCfg = this.config.login;
    const firstCheckTime = this._firstCheckTimeText();
    const today = businessDate || shanghaiDate(this.nowFn());

    // 决策层：当前状态只来自本轮回读（adBelief 仅审计，不得代替回读、不得直接触发点击）
    const stateRead0 = await this._readCurrentAdState(shopCfg);
    const currentAdState = stateRead0.state;
    // 全局浏览器操作锁忙（PROMO-IMPL-F1）：本次开启相位零动作跳过（skipped 不标记当日完成，
    // 窗口内重试），不写 adState、不落读取失败。
    if (stateRead0.globalBusy === true) {
      this._auditGlobalBrowserOpBusy(shopCfg.id);
      return { status: 'skipped', zeroClick: true, globalBusy: true, reason: '全局浏览器操作锁忙（其它店发布/恢复/巡查在途），本次开启相位跳过（零动作）' };
    }
    // 缺口 B（2026-10-19）：开启相位的回读失败必须进入 API 页面详情（lastReadError/lastError）；
    // 本轮读取成功则清除上一轮遗留的旧错误，不把临时错误写成登录失效（_applyReadFailure 按具体分类）。
    if (stateRead0.error) this._applyReadFailure(shopCfg.id, stateRead0.error);
    else this._clearReadFailure(shopCfg.id);
    // unknown 槽位核验释放（2026-09-29 第 6 阶段）：每日开启相位复用**同一份**本轮回读做核验
    // （不重开页面、零额外点击）。释放条件要求回读状态=旧动作目标态，因此释放成功时
    // currentAdState 即目标态，后续决策自然进入正常路径（如 pause 槽位被全量 off 释放 →
    // off → should_enable 正常执行）；释放不成功则槽位继续阻断（runSwitchAction 由串行门拒绝）。
    const unknownResolve = await this._tryResolveUnknownSlotWithFreshRead(shopCfg, stateRead0);
    // 旧 enable 以「目标未达成」结案后，登记待关联信息，供本轮新建 enable 完成后写 old→new 审计。
    // 非本情形一律清除，避免跨轮/跨入口的过期 pending 被误关联到新动作。
    if (unknownResolve && unknownResolve.resolved === true && unknownResolve.resolvedAs === 'enable_target_not_achieved') {
      this._pendingEnableRecreation = {
        shopId: shopCfg.id,
        oldActionId: unknownResolve.actionId,
        settleKind: 'enable_target_not_achieved',
        evidenceSummary: unknownResolve.evidenceSummary || null,
        at: new Date(this.nowFn()).toISOString(),
      };
    } else if (this._pendingEnableRecreation && this._pendingEnableRecreation.shopId === shopCfg.id) {
      this._pendingEnableRecreation = null;
    }
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
      // 缺口 B：readError 必须带脱敏后的分类/原因/最后步骤，便于页面定位真实失败原因。
      readError: this._maskReadError(stateRead0.error, shopCfg.id),
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
        // 缺口 B：预检读取失败的详细原因随相位记录保留（成功/already_on 不携带）。
        readError: phaseStatus === 'failed' ? this._maskReadError(stateRead0.error, shopCfg.id) : null,
      });
      this._audit({ kind: 'enable-phase', shopId: shopCfg.id, event: 'skipped-zero-click', trigger: source, note: reason, currentAdState, decision: dailyDecision.decision, beliefAt: belief && belief.at, readError: this._maskReadError(stateRead0.error, shopCfg.id), readNote: stateRead0.switchEvidence || null });
      try { log.info(`每日开启跳过（${shopCfg.id}）：${reason}`); } catch (_) { /* 日志失败不影响 */ }
      return { status: 'ok', skipped: true, zeroClick: true, decision: dailyDecision.decision, currentAdState, reason };
    }

    // fix2：serial_gate / ad=mixed 有界收口（超 N 次尝试或超时 → 未确认终态，今日不再无限重试）。
    // 必须在 mixed 交接之前判定：交接依赖的旧槽位若永远无法核验，只会每 5 分钟重复拒绝。
    const bounded = this._expireUnresolvedSerialGateIfBounded(shopCfg, today, unknownResolve, currentAdState, source);
    if (bounded) {
      this._setEnablePhase(shopCfg.id, today, 'exhausted', {
        phase: 'serial_gate',
        blocked: 'serial_gate_bounded',
        settledAs: 'unknown_expired',
        oldEnableActionId: bounded.actionId,
        serialGateWaitedMs: bounded.waitedMs,
        currentAdState,
        firstCheckTime,
        viaMixedReconcile: false,
        mixedState: null,
        prevNote: null,
        actionId: null,
        allEnabledConfirmed: false,
        readError: null,
        reason: bounded.reason,
      });
      this._memPush(this.recentErrors, { scope: `shop:${shopCfg.id}`, error: bounded.reason }, undefined, 'error');
      return {
        status: 'exhausted', shopId: shopCfg.id, zeroClick: true,
        decision: dailyDecision.decision, currentAdState,
        blocked: 'serial_gate_bounded', exhausted: true,
        oldEnableActionId: bounded.actionId,
        serialGateWaitedMs: bounded.waitedMs,
        reason: bounded.reason,
        enable: { outcome: 'unknown_expired', serial: 'unknown_expired' },
      };
    }

    // F7：真实服务启动后首查/值守联动入口——旧 unknown 阻塞槽 + 本轮可信 mixed 且旧执行/读取
    // 严格结束（inflightProof=执行器已归零且读取闸已闭合）时，由本入口完成有证据的 mixed 交接收敛，
    // 让首查与后续费比控制不再互相死锁。未收敛/证据不足一律如实 unknown（有界重试），绝不因普通
    // 失败或 unknown 放宽安全门、绝不据历史槽伪收敛、绝不删除首查门禁或给 unknown 强写 success。
    if (this._switchOrchestrator.hasUnknownBlock(shopCfg.id)) {
      const rec = await this._mixedReconcileRepair(
        shopCfg,
        cycleToken,
        { reason: `每日 ${firstCheckTime} 后首次开启检查（mixed 交接恢复）` },
        { stage: 'first-check', action: 'enable' },
      );
      // rec=null → 本轮不交接（非 mixed/无槽/已停止）：照常进入串行门（旧 unknown 会拒绝并发，
      // 相位记 unknown 有界重试）；rec!=null → 按 mixed 恢复结果如实落账。
      if (rec) return this._finalizeEnablePhaseAfterMixedReconcile(shopCfg, today, firstCheckTime, rec);
    }

    // 第 3 项：执行前记录 in_progress（区分"执行中"），成功/失败/未知分别落状态。
    // 重启时 in_progress → unknown（见 _reconcileEnablePhaseOnBoot），不会重复开启。
    const prevRec = this.getEnablePhaseRecord(shopCfg.id, today);
    const prevNote = (prevRec && prevRec.status === 'unknown')
      ? `上次为 unknown（${prevRec.reason || '结果未确认'}），本轮先按真实状态回读处理，不盲重发` : null;
    this._setEnablePhase(shopCfg.id, today, 'in_progress', {
      phase: this.realMode ? 'execute' : 'dry',
      firstCheckTime,
      prevNote,
      // 本轮首读已成功（失败会在上方零点击提前返回）：清除上一轮遗留的读取错误详情。
      readError: null,
    });
    if (prevNote) {
      this._audit({ kind: 'enable-phase', shopId: shopCfg.id, event: 'reconcile', note: prevNote });
    }

    // 决策 + 串行门 + 复用 runner/executor
    // 缺口 B（2026-10-19）：动作前复核回读若失败，runSwitchAction 只取 state（unknown），
    // 会丢掉详细原因。这里在同一轮把脱敏详情落到 API 页面（_applyReadFailure）并留存副本，
    // 供后续 unknown/failed 相位记录使用；复核成功则清除旧错误。
    let enableReadError = null;
    const settled = await this._switchOrchestrator.runSwitchAction({
      shopId: shopCfg.id,
      action: 'enable',
      targetState: 'on',
      persistBeforeRelease: () => this._saveState(),
      readState: async () => {
        const r = await this._readCurrentAdState(shopCfg);
        if (r && r.globalBusy === true) {
          // 全局浏览器操作锁忙（PROMO-IMPL-F1）：动作前回读让位，不落读取失败、不执行开启。
          enableReadError = this._maskReadError(r.error, shopCfg.id);
          this._auditGlobalBrowserOpBusy(shopCfg.id);
        } else if (r && r.error) {
          enableReadError = this._maskReadError(r.error, shopCfg.id);
          this._applyReadFailure(shopCfg.id, r.error);
        } else {
          enableReadError = null;
          this._clearReadFailure(shopCfg.id);
        }
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
          reason: source === 'manual_verify' ? '手动验证触发（人工按需）' : `每日 ${firstCheckTime} 后首次开启检查`,
          triggerLabel: source === 'manual_verify' ? 'manual_verify' : 'daily_enable',
          businessDate: today,
          enableSource: source,
        });
      },
    });

    // 缺口 A（2026-10-19）：旧 enable unknown 以「目标未达成」结案后，同一轮新建的 enable 动作
    // 与旧 actionId 关联审计（保留 old actionId、结案类型、证据摘要、新 actionId）。
    if (settled.actionId && this._pendingEnableRecreation && this._pendingEnableRecreation.shopId === shopCfg.id) {
      const rec = this._pendingEnableRecreation;
      this._audit({
        kind: 'ad-switch', step: 'enable-recreated', shopId: shopCfg.id,
        oldActionId: rec.oldActionId, settledAs: rec.settleKind, evidenceSummary: rec.evidenceSummary,
        newActionId: settled.actionId, at: rec.at,
        reason: `旧 enable（${rec.oldActionId}）已按全量 off 安全结案（${rec.settleKind}，目标未达成，非 confirmed）；本轮据正常决策创建新 enable（${settled.actionId}）`,
      });
      this._pendingEnableRecreation = null;
    }

    // 串行门拒绝先于普通 zeroClick（避免误报 already_on/成功）
    if (settled.blocked === 'serial_gate') {
      this._setEnablePhase(shopCfg.id, today, 'unknown', {
        phase: 'execute', reason: settled.reason, blocked: 'serial_gate', actionId: null,
        // 串行门被拒时的动作前复核读错同样保留；本轮复核成功则清掉旧详情。
        readError: enableReadError || null,
      });
      return this._mapSwitchReturn({ action: 'enable', settled, extra: { status: 'blocked' } });
    }
    // 纯决策跳过（未登记 actionId、无执行结果）
    if (settled.zeroClick && !settled.actionId && !settled.batch) {
      const phaseStatus = settled.decision === DECISION.ALREADY_ON ? 'success' : 'failed';
      this._setEnablePhase(shopCfg.id, today, phaseStatus, {
        phase: 'precheck', reason: settled.reason, decision: settled.decision,
        readError: enableReadError || null,
      });
      return this._mapSwitchReturn({ action: 'enable', settled, extra: { skipped: true } });
    }

    const batch = settled.batch || {};
    if (batch.dryRun === true || settled.outcome === 'dry' || settled.outcome === 'dry_failed') {
      const failed = settled.outcome === 'dry_failed';
      const reason = batch.error || batch.reason || settled.reason || null;
      if (failed) {
        this._setEnablePhase(shopCfg.id, today, 'failed', { phase: 'dry', reason, readError: enableReadError || null });
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
        reason: `每日 ${firstCheckTime} 后首次开启检查相位`, businessDate: today,
        targetCount, targets: batch.targets, dryOutcome: settled.outcome || 'dry',
        note: '演练模式：每日开启相位将开启以下乘方目标（未点击任何开关/开启/删除）',
      }, undefined, 'trigger');
      this._audit({ kind: 'trigger', shopId: shopCfg.id, mode: 'dry', targetAction: 'enable', targetCount });
      this._setEnablePhase(shopCfg.id, today, 'dry_done', { phase: 'dry', reason: null, targetCount, readError: null });
      return this._mapSwitchReturn({
        action: 'enable', settled,
        extra: { dryRun: true, targetCount, enable: { outcome: settled.outcome || 'dry' } },
      });
    }

    this._commitExecutedBatch(shopCfg.id, batch);

    if (settled.serial === 'not_sent' && (settled.outcome === 'blocked' || settled.outcome === 'blocked_window' || settled.outcome === 'blocked_stopped')) {
      this._setEnablePhase(shopCfg.id, today, 'failed', {
        phase: 'execute', reason: settled.reason, blocked: settled.outcome,
        readError: enableReadError || null,
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
      // 缺口 B：动作前复核读失败的详细原因随 unknown 记录保留（confirmed 成功不携带旧错误）。
      readError: okStatus === 'unknown' ? (enableReadError || null) : null,
    });
    return this._mapSwitchReturn({ action: 'enable', settled });
  }

  /**
   * 首查入口完成 mixed 交接收敛后的相位落账（F7）。
   * - 仅当**本轮动作后完整回读确认**（mixedReconcile.converged 或 repairSerial==='confirmed'）才记为
   *   今日已处理：status 用独立 'mixed_converged'（区别于正常开启的 'success'），并如实记录本轮处理
   *   动作（enable/pause）与收敛到的目标态；旧 enable 动作在串行门内已被如实收口为未收敛、绝不伪确认，
   *   本处也绝不用 'success' 冒称旧开启成功——只是"今日首查已按新判定处理完毕，不再强制重开"。
   * - 未收敛（pending/not_converged/blocked/unknown，含交接后新槽被终止/落盘失败）→ 记 unknown，
   *   保持有界重试与首查安全门禁，零伪成功、不清旧槽、不重置生产数据。
   */
  _finalizeEnablePhaseAfterMixedReconcile(shopCfg, today, firstCheckTime, rec) {
    const mr = (rec && rec.mixedReconcile) || {};
    const converged = mr.converged === true || mr.repairSerial === 'confirmed' || rec.serial === 'confirmed';
    const handledAction = mr.repairAction || rec.action || null;
    // 收敛目标只认「本轮动作后完整回读确认」这一事实：converged 为真即批次已确认统一目标态，
    // 据此如实记录处理动作所达成的目标（enable→on / pause→off）；未收敛则回落到本轮真实观测
    // （mixed/unknown），绝不据旧动作或历史目标伪写成 on/off。observedPreAction 保留动作前观测以自证不伪装。
    const observedPreAction = mr.observedAdState || rec.currentAdState || null;
    const convergedTo = converged
      ? (handledAction === 'enable' ? 'on' : handledAction === 'pause' ? 'off' : observedPreAction)
      : observedPreAction;
    const oldActionId = mr.oldActionId || rec.previousActionId || null;
    if (converged) {
      this._setEnablePhase(shopCfg.id, today, 'mixed_converged', {
        phase: 'execute',
        viaMixedReconcile: true,
        mixedHandledAction: handledAction,
        mixedConvergedTo: convergedTo,
        observedPreActionState: observedPreAction,
        oldEnableActionId: oldActionId,
        oldEnableConfirmed: false,
        firstCheckTime,
        readError: null,
        reason: `mixed 交接已按本轮新判定收敛（处理动作=${handledAction || '—'}，动作前观测 ${observedPreAction || '—'}→完整回读确认 ${convergedTo || '—'}）：旧动作如实未收敛、未伪确认；今日首查据此完成，同日均不再强制重开`,
      });
      return {
        status: 'ok', shopId: shopCfg.id, decision: rec.decision || mr.decision || null,
        action: handledAction, serial: 'confirmed', currentAdState: convergedTo,
        observedPreActionState: observedPreAction,
        zeroClick: rec.zeroClick === true, viaMixedReconcile: true,
        oldEnableActionId: oldActionId, mixedReconcile: mr, reason: rec.reason || null,
        enable: { outcome: 'mixed_converged', serial: 'confirmed' },
      };
    }
    this._setEnablePhase(shopCfg.id, today, 'unknown', {
      phase: 'execute',
      viaMixedReconcile: true,
      mixedState: mr.state || rec.status || 'pending',
      oldEnableActionId: oldActionId,
      oldEnableConfirmed: false,
      firstCheckTime,
      reason: rec.reason || 'mixed 交接待收敛/证据不足：今日首查未完成，保持 unknown 有界重试，零伪成功',
    });
    return {
      status: rec.status || 'pending', shopId: shopCfg.id, decision: rec.decision || mr.decision || null,
      action: handledAction, serial: rec.serial || 'unknown', currentAdState: rec.currentAdState || 'mixed',
      zeroClick: rec.zeroClick === true, pending: rec.pending === true, blocked: rec.blocked || null,
      viaMixedReconcile: true, oldEnableActionId: oldActionId, mixedReconcile: mr, reason: rec.reason || null,
    };
  }

  /**
   * 历史全店关闭路径（旧覆盖表/协调器流程）。仅在测试显式开启
   * monitor.legacyWholeShopCloseEnabled=true 时可达；生产配置不设置该开关，
   * 确保自动监控绝不进入其他产品覆盖流程。
   */
  async _pollLegacyWholeShopOver(shopCfg, data, cycleToken) {
    // 全局浏览器操作排队锁（PROMO-IMPL-F1）：历史全店暂停动作同样在全局锁内执行。
    const r = await this._withGlobalBrowserOp(() => this._pollLegacyWholeShopOverInner(shopCfg, data, cycleToken));
    if (r.busy) {
      this._auditGlobalBrowserOpBusy(shopCfg.id);
      return {
        status: 'skipped', outcome: 'skipped', neverSent: true, globalBusy: true, zeroClick: true,
        reason: '全局浏览器操作锁忙（其它店发布/恢复/巡查在途），本轮跳过暂停动作',
        counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
      };
    }
    return r.value;
  }

  async _pollLegacyWholeShopOverInner(shopCfg, data, cycleToken) {
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

    // 真实暂停不设时间窗口：费比严格超标即进入关闭链路。
    // 该历史全店路径与乘方主路径保持同一优先级，避免切换配置后重新出现时段锁。
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
    // 同日确认标记以**最近一个批次**为准（2026-10-18 F1）：开启侧与暂停侧互斥重置，
    // 杜绝暂停批次落库后仍残留旧 allEnabledConfirmed=true（同日双 true 假象）。
    // 只影响展示口径；totals 仍是历史累计，adBelief/自动动作逻辑不变。
    if (isEnable) {
      rec.allEnabledConfirmed = batch.allEnabledConfirmed === true;
      rec.allPausedConfirmed = false;
      rec.allClosedConfirmed = false;
    } else {
      rec.allEnabledConfirmed = false;
      rec.allClosedConfirmed = batch.allClosedConfirmed === true || batch.allPausedConfirmed === true;
      rec.allPausedConfirmed = batch.allPausedConfirmed === true;
    }
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
    // 新鲜只读观测使旧决策失效：旧决策可能来自上一轮指标/日期或上一个动作，不能继续
    // 用于 mixed 收敛视图的"未安排收敛"判断；需要由本轮（或下一轮）重新给出决策。
    rt.lastDecision = null;
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
      // 旧持久记录可能带同日双 true（历史版本暂停批次后未重置 allEnabledConfirmed）。
      // 投影按**最近一次 run** 修正确认口径：不清历史（runs/totals 原样保留），
      // 确认时间取该 run 自身时间，不跨批次嫁接。
      const lastRun = (dateRec && Array.isArray(dateRec.runs) && dateRec.runs.length)
        ? dateRec.runs[dateRec.runs.length - 1] : null;
      const projPaused = !!(lastRun && lastRun.allPausedConfirmed === true);
      const projEnabled = !!(lastRun && lastRun.allEnabledConfirmed === true);
      const projClosed = !!(lastRun && (lastRun.allClosedConfirmed === true || lastRun.allPausedConfirmed === true));
      const enableRec = this.getEnablePhaseRecord(s.id, today);
      const thresholdCents = this._thresholdCents(s);
      // 同店同日有效投影：跨日/上一日数据不得把 ROI 提示带进今天。
      const todayData = rt.lastData || null;
      const todaySameDay = !!(todayData && todayData.businessDate === today);
      return {
        id: s.id,
        name: s.name || null,
        displayName: s.displayName || s.name || s.id,
        cookieFile: s.cookieFile,
        // D56：单店停用取消，有效启用状态等价于"未删除"（全局开关另由 monitor.running 表达）。
        enabled: s.deleted !== true,
        deleted: s.deleted === true,
        deletedAt: s.deletedAt || null,
        thresholdCents,
        // 目标 ROI（2026-10-12 S6）：真实状态输出必须携带本店**已保存**的 targetRoi，
        // 未配置时回落 DEFAULT_TARGET_ROI（15）；不写死店铺名/账号或 14/15 特例。
        targetRoi: s.targetRoi !== undefined ? s.targetRoi : DEFAULT_TARGET_ROI,
        platform: s.platform || 'douyin',
        cookieInfo,
        lastError: rt.lastError || null,
        // 读取失败结构化状态（完整原因 + 分类：retrying/read_failed/auth/timeout）。
        // 只用于如实展示与重试/扫码判定，绝不被当作 on/off 或成功证据。
        lastReadError: rt.lastReadError || null,
        today: rt.lastData || null,
        dataRefreshing: rt.dataRefreshing === true,
        lastDataAt: rt.lastDataAt || (rt.lastData && rt.lastData.fetchedAt) || null,
        // 兼容门槛字段（无消耗门槛，恒 0/false）：只展示同店同日有效投影，不把 null 当 0 重算
        spendFloorCents: SPEND_FLOOR_CENTS,
        spendProtected: todaySameDay ? todayData.spendProtected === true : null,
        pauseEligible: todaySameDay ? todayData.pauseEligible === true : false,
        roiTooLow: !!(todaySameDay && todayData.roiTooLow === true),
        lastAdState: rt.lastAdState || null,
        // 证据时间语义分离：动作确认 vs 只读观测；互斥（观测覆盖后旧确认失效）
        adStateConfirmedAt: rt.adStateConfirmedAt || null,
        adStateConfirmEvidence: rt.adStateConfirmEvidence || null,
        adStateObservedAt: rt.adStateObservedAt || null,
        adStateObserveEvidence: rt.adStateObserveEvidence || null,
        adStateEvidenceKind: rt.adStateEvidenceKind || null,
        // mixed 收敛视图（mixed 非完成态：界面呈现待收敛/重新判定/重试中）
        mixedReconcile: this._mixedReconcileView(s.id),
        // 自动发现店使用 Cookie 会话，缺少预填账户号不产生待核验状态。
        identityPending: this._shopIdentityState(s).pending,
        identityNote: this._shopIdentityState(s).reason,
        enablePhase: enableRec || null,
        batchToday: dateRec ? { runs: dateRec.runs.length, totals: { confirmed: dateRec.totals.confirmed.length, failed: dateRec.totals.failed.length, unknown: dateRec.totals.unknown.length, skipped: dateRec.totals.skipped.length }, allClosedConfirmed: projClosed, allPausedConfirmed: projPaused, allEnabledConfirmed: projEnabled, confirmedAt: (projClosed || projEnabled) ? (lastRun.at || dateRec.lastBatchAt) : null, lastBatchAt: dateRec.lastBatchAt, lastRuns: dateRec.runs.slice(-3) } : null,
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
          // 真实执行标志：仅 pollOnce/自动开启/手动验证在途为 true；空闲等待下次巡查为 false。
          // 消费方据此区分「检查中」与「值守中（等待下次检查）」，不靠时间猜测。
          cycleRunning: this._cycleRunning === true,
          cycleNo: this.cycleNo || 0,
          startedAt: this.startedAt,
          lastCycleAt: this.lastCycleAt,
          nextRunAt: this.schedule.nextRunAt,
          waitingFor08: this.schedule.waitingFor08,
          windowBlockReason: this.schedule.lastWindowBlockReason,
          dailyStartHour: this.config.schedule.dailyStartHour,
          intervalMinutes: this.config.schedule.intervalMinutes,
          // 2026-10-09 取消 enableHour/07:00 固定开启；改 firstCheckMinuteOfDay（默认 5=00:05）
          firstCheckMinuteOfDay: this._firstCheckMinuteOfDay(),
          firstCheckTime: this._firstCheckTimeText(),
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
        const mr = this._mixedReconcileView(s.id);
        return {
          id: s.id,
          name: s.name || s.id,
          displayName: s.displayName || s.name || s.id,
          adState: rt.lastAdState || 'unknown',
          adStateConfirmedAt: rt.adStateConfirmedAt || null,
          adStateObservedAt: rt.adStateObservedAt || null,
          adStateEvidenceKind: rt.adStateEvidenceKind || null,
          // mixed 非完成态：主控制页直接消费（待收敛/重新判定/重试中；on/off 才视为已收敛）
          mixedReconcile: {
            state: mr.reconcileState,
            text: mr.reconcileText,
            mixedIsCompletion: false,
            unknownBlock: mr.unknownBlock,
          },
          lastDataAt: rt.lastDataAt || (t && t.fetchedAt) || null,
          costCents: t && t.costCents != null ? t.costCents : null,
          costText: t ? t.costText : null,
          orders: t && t.orders != null ? t.orders : null,
          // 千川可用余额（2026-09-27，账户级只读展示字段；null=本轮未读到，界面显示"未知"）
          balanceCents: t && t.balanceCents != null ? t.balanceCents : null,
          balanceAt: t && t.balanceAt ? t.balanceAt : null,
          // 余额终态（2026-10-31 竞态修正）：ok/error/missing/skipped + 非 ok 具体原因
          balanceStatus: (t && t.balanceStatus) || null,
          balanceReason: (t && t.balanceStatus && t.balanceStatus !== 'ok') ? t.balanceReason || null : null,
          // 本轮刷新在途（candidate 未提交）：界面可显示"刷新中"，而非把陈旧读数当新读数
          refreshing: rt.dataRefreshing === true || (t && t.refreshing === true),
          thresholdCents: this._thresholdCents(s),
          // 目标 ROI + 每店每日计划条数（2026-11-19 主控制页编辑框）：有效值 = 已保存值，缺省回落合同默认
          targetRoi: s.targetRoi !== undefined ? s.targetRoi : DEFAULT_TARGET_ROI,
          plansPerShopPerDay: resolveEffectivePlansPerShop(s, DEFAULT_PLANS_PER_SHOP),
          plansPerShopPerDaySaved: Object.prototype.hasOwnProperty.call(s, 'plansPerShopPerDay') ? s.plansPerShopPerDay : null,
          over: t ? t.over === true : null,
          // 同店同日 ROI 提示投影（t.businessDate 必须等于今日；消耗门槛已取消）
          spendFloorCents: SPEND_FLOOR_CENTS,
          spendProtected: (t && t.businessDate === today) ? t.spendProtected === true : null,
          pauseEligible: (t && t.businessDate === today) ? t.pauseEligible === true : false,
          roiTooLow: !!(t && t.businessDate === today && t.roiTooLow === true),
          lastError: rt.lastError || (t && t.blockedReason) || null,
          // 状态供界面兼容；正常配置店铺不显示待核验标记。
          identityPending: this._shopIdentityState(s).pending,
          // 当前动作（2026-11-20 主控制页）：租约在途文本 > 只读刷新在途 > 空闲。如实投影，不推断。
          activity: this._shopActivityText(s.id)
            || (rt.dataRefreshing === true ? '读取数据中（只读）' : '空闲'),
          identityNote: this._shopIdentityState(s).reason,
          // D56：有效启用状态等价于"未删除"，避免把历史 enabled=false 的正常店误示为未启用。
          enabled: s.deleted !== true,
          platform: s.platform || 'douyin',
          // Cookie 登录文件状态（2026-11-19 主控制页 Cookie 列）：只读元信息
          // （是否找到/条数/过期/只读来源），绝不包含 Cookie 值本身。
          cookieInfo: (() => {
            try {
              const meta = loadShopCookieMeta(this.config.login, s);
              return { found: true, readOnly: meta.readOnly, cookieCount: meta.count, maxExpires: meta.maxExpires, expired: meta.fxgExpired };
            } catch (e) {
              return { found: false, error: e.reason || e.message };
            }
          })(),
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

module.exports = { Monitor, STATE_VERSION, AUTH_LOGIN_URL_HOLD_MS, READ_FAILURE_HINTS };
