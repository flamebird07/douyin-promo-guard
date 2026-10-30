'use strict';

/**
 * 独立"每店每日 N 份推广计划"一次性 CLI（客户 2026-10-25 授权，R3 最小实施；R4 返修）。
 *
 * R4 变更（仅本 5 文件）：
 * - adapterRoot 与 login.cookieWorkDir/cookieSourceDir 必须显式绝对路径；空占位即"未配置"，
 *   --check 如实报错、createDailyRunner fail-closed，绝不回落值守 guard/config/cookies；
 * - discoverAccount 与 runPlan 经 run-plans 既有 opts.openShop DI 包装
 *   readers.openChengfangShop({...args, readOnlyStatus:true})（保留 login/shop/headless，
 *   常规店返回原生 opened；首次使用页面由 readOnlyStatus 语义接线）；
 * - 每次真正发单/开新会话前 fresh 读自己的最新 policy：scheduler 缓存 cfg 时停用同样
 *   立即停止底层 runPlan/discover（诚实 unknown/blocked，绝不伪造成功、不借值守开关）。
 *
 * 与推广值守完全独立：
 * - 只复用纯排程器 createScheduler（sibling bill-manager/promo-plan-scheduler.js），
 *   绝不 import/boot watch-drill / server / Monitor / 3443 服务；
 * - 发布能力复用同目录 run-plans.cjs 既有 runScheduledPlan / readDaySuccessForShop /
 *   discoverShopAccountByLiveSession，不重写发布链；
 * - 自带 daily-plan-config.json + daily-plan-data/ledger.json（根可注入以便离线测试）；
 * - 默认 enabled:false / autoConfirm:false，配置不含任何 Cookie 值；
 * - 本模块导入零动作；require.main 才进 main()；--check 纯校验零写入零浏览器；
 *   --run 只做一次 tick，不 start()、不建常驻定时器/HTTP 端口/新数据库，自然退出；
 * - 不注入 enableShop 钩子（不调用值守开启/暂停/runManualEnableVerify）；
 * - policyProvider / currentShopProvider / listShops 每次 fresh 读自己的配置文件，
 *   停用后零未来派发，不继承值守开关；publisher 既有按店状态目录（stateRoot 缺省
 *   即 run-plans 自身 ROOT）原样保留，不清零旧成功/未知事实。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const RUNNER_DIR = __dirname;
const DEFAULT_CONFIG_FILE = path.join(RUNNER_DIR, 'daily-plan-config.json');
const DEFAULT_DATA_DIR = path.join(RUNNER_DIR, 'daily-plan-data');
const HM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** 校验独立配置。永远返回 { ok, value, reasons }；非法值不静默修补成可发布。 */
function validateDailyConfig(raw) {
  const reasons = [];
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const value = {
    enabled: src.enabled === true,
    autoConfirm: src.autoConfirm === true,
    // patrol-plan-refill：08:00 门槛已移除（补发全天随值守巡查触发）。独立视图的 time 一律
    // 归一为中性 00:00（dispatchFrom 0 → 任何时刻 tick 都到点）；旧配置文件里的 08:00 等
    // 废弃值只做形状校验、绝不再作为派发门槛展示或生效。
    time: '00:00',
    timezone: 'Asia/Shanghai',
    plansPerShopPerDay: 3,
    dailyBudget: 300,
    adapterRoot: typeof src.adapterRoot === 'string' ? src.adapterRoot : '',
    stateRoot: typeof src.stateRoot === 'string' ? src.stateRoot : '',
    shops: [],
    login: (src.login && typeof src.login === 'object' && !Array.isArray(src.login)) ? src.login : null,
  };
  if (src.enabled !== undefined && typeof src.enabled !== 'boolean') reasons.push('enabled 必须是布尔值');
  if (src.autoConfirm !== undefined && typeof src.autoConfirm !== 'boolean') reasons.push('autoConfirm 必须是布尔值');
  if (src.time !== undefined) {
    // 废弃字段：形状仍如实校验（非法值报原因），但任何合法值（含旧 08:00）都被忽略并
    // 归一为上面的中性 00:00，绝不再回填 src 值。
    if (!HM_RE.test(String(src.time).trim())) reasons.push('time 必须是 00:00–23:59 的 HH:mm');
  }
  if (src.timezone !== undefined && src.timezone !== 'Asia/Shanghai') reasons.push('timezone 仅支持 Asia/Shanghai');
  if (src.plansPerShopPerDay !== undefined) {
    const n = src.plansPerShopPerDay;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 3) reasons.push('plansPerShopPerDay 必须是 1..3 的整数');
    else value.plansPerShopPerDay = n;
  }
  if (src.dailyBudget !== undefined) {
    const b = src.dailyBudget;
    if (typeof b !== 'number' || !Number.isFinite(b) || !(b > 0)) reasons.push('dailyBudget 必须是正有限数字');
    else value.dailyBudget = b;
  }
  // 独立运行不得回落值守 guard/config：adapterRoot 与 login 两个 Cookie 路径必须是
  // 显式绝对路径；空占位（样例未填）就是"未配置"，--check/真实运行都必须如实报错。
  const absStr = (v) => { const t = typeof v === 'string' ? v.trim() : ''; return t !== '' && path.isAbsolute(t); };
  if (!absStr(src.adapterRoot)) reasons.push('adapterRoot 必须是非空绝对路径（douyin-promo-guard 工作副本根）');
  if (src.stateRoot !== undefined && src.stateRoot !== '' && !absStr(src.stateRoot)) {
    reasons.push('stateRoot 只能为空（沿用原 publisher 状态目录）或非空绝对路径');
  }
  const login = src.login;
  if (!login || typeof login !== 'object' || Array.isArray(login)) {
    reasons.push('login 必须是对象（含 cookieWorkDir/cookieSourceDir 绝对路径）');
  } else {
    if (!absStr(login.cookieWorkDir)) reasons.push('login.cookieWorkDir 必须是非空绝对路径（现有商品分析普通工作副本）');
    if (!absStr(login.cookieSourceDir)) reasons.push('login.cookieSourceDir 必须是非空绝对路径（与 cookieWorkDir 同一现有商品分析工作根）');
  }
  if (!Array.isArray(src.shops)) reasons.push('shops 必须是数组');
  else {
    const seen = new Set();
    for (const s of src.shops) {
      if (!s || typeof s !== 'object') { reasons.push('shops 条目必须是对象'); break; }
      const name = String(s.name == null ? '' : s.name).trim();
      const id = String(s.id == null ? name : s.id).trim();
      if (!name) { reasons.push('shops 条目缺 name'); break; }
      if (seen.has(id)) { reasons.push('shops id 重复:' + id); break; }
      seen.add(id);
      if (s.deleted !== undefined && typeof s.deleted !== 'boolean') reasons.push('shops[' + id + '].deleted 必须是布尔值');
      if (s.accountId != null && String(s.accountId) !== '' && !/^\d{6,24}$/.test(String(s.accountId))) {
        reasons.push('shops[' + id + '].accountId 必须是 6..24 位数字或 null');
      }
      if (s.targetRoi != null && (typeof s.targetRoi !== 'number' || !(s.targetRoi > 0))) {
        reasons.push('shops[' + id + '].targetRoi 必须是正数或省略（省略沿用合法默认 15）');
      }
    }
    value.shops = src.shops;
  }
  return { ok: reasons.length === 0, value, reasons };
}

function readDailyConfig(file) {
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { ok: false, value: null, reasons: ['config-read-failed:' + ((e && e.message) || e)] }; }
  return validateDailyConfig(raw);
}

/** 候选排程器路径：工作副本（plan-publisher 的 sibling bill-manager）与生产布局
 *  （guard root 的 sibling bill-manager）都尝试，允许显式注入覆盖。 */
function resolveSchedulerPath(adapterRoot, explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (adapterRoot) {
    candidates.push(path.join(adapterRoot, 'bill-manager', 'promo-plan-scheduler.js'));
    candidates.push(path.join(adapterRoot, '..', 'bill-manager', 'promo-plan-scheduler.js'));
  }
  candidates.push(path.join(RUNNER_DIR, '..', 'bill-manager', 'promo-plan-scheduler.js'));
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (_) { /* 继续下一候选 */ } }
  return null;
}

/** 装载真实发布依赖：同目录 run-plans.cjs 既有导出（导入无动作，仅 require.main 才 main）。 */
function loadRealDeps() {
  const publisher = require(path.join(RUNNER_DIR, 'run-plans.cjs'));
  return {
    runPlan: publisher.runScheduledPlan,
    readDaySuccess: publisher.readDaySuccessForShop,
    discoverAccount: publisher.discoverShopAccountByLiveSession,
    // R7：本地准备恢复（无浏览器、纯文件、锁内 CAS 收口）——同一 run-plans 既有导出，
    // 绝不 import watch-drill / Monitor；缺导出时恢复钩子不接线（诚实不可用，不伪造）。
    recoverLocalPreparation: typeof publisher.recoverLocalPreparationClose === 'function' ? publisher.recoverLocalPreparationClose : null,
    // R8：已耐久 preparation-stopped 的只读重证支路 + canonical release 证明/源字节 CAS 能力。
    reproveDurablePreparationStopped: typeof publisher.reproveDurablePreparationStoppedClose === 'function' ? publisher.reproveDurablePreparationStoppedClose : null,
    // R12：首份、从未进入 publish 的 preparing + attempts 原始缺失的显式正面证明恢复
    // （同店 publisher 锁内 NP 证明 + 源字节 CAS + 六零耐久事实；缺导出时不接线，诚实不可用）。
    recoverFirstPreparingNoPublication: typeof publisher.recoverFirstPreparingByNoPublicationProof === 'function' ? publisher.recoverFirstPreparingByNoPublicationProof : null,
    proveSchedulerRelease: typeof publisher.proveSchedulerReleaseProof === 'function' ? publisher.proveSchedulerReleaseProof : null,
    // R9：只按同店 publisher 路径（legacy profile 或 shop-identity.json）派生的状态/attempts/
    // published/seed 路径。失败发生在任何创建之前、state 文件不存在时仍能明确派生，绝不猜路径。
    resolvePublisherPaths: typeof publisher.resolvePublisherStatePaths === 'function' ? publisher.resolvePublisherStatePaths : null,
    currentSourceHash: typeof publisher.currentPreOpenSourceHash === 'function' ? publisher.currentPreOpenSourceHash : null,
  };
}

// ── R7 严格准备收口适配（判据与值守 watch-drill 同源的窄映射，零共享改动）──────────
// 六字段零消费证明：缺字段/其它值/非对象一律不算证明（与 run-plans/promo-plan-scheduler
// 的 strictZeroConsumptionProof 同一结构判据；此处复制窄映射，不 import 值守模块）。
function strictZeroConsumptionProof(p) {
  return !!p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length === 6
    && p.initialConsumptions === 0 && p.finalConsumptions === 0 && p.reopenConsumptions === 0
    && p.manualUnresolved === 0 && p.plansContainsNumber === false && p.confirmationConsumptionsRecorded === false;
}

const SCHEDULED_RUN_ORIGIN_RE = /^plan-scheduler-(\d{4}-\d{2}-\d{2})-[0-9a-f]{16}$/;

// R13：唯一被允许进入显式首份 NP 恢复支路的精确 scheduled-run exception reason
// （简尚 2026-10-25 20:07 实录：numeric pager 遮挡在 30 商品冻结前抛异常、attempts
// 原始缺失、canonical F1 因缺 attempts 拒绝）。整串逐字比对，绝不前缀/通配泛化；
// 其它任何 scheduled-run-exception:* 仍走 canonical F1 的既有严格拒绝。
const R13_EXPLICIT_NP_EXCEPTION_REASON = 'scheduled-run-exception:numeric-leaf-scope-not-proven:numeric-pager-blocking-overlay-present';

// R16：唯一被允许进入显式"已回读成功收敛"支路的精确 unknown reason（简尚 2026-10-25 20:36
// 实录：原生提交成功、管理页首次 hydrate 超时，runScheduledPlan 诚实返回 unknown；主脑随后已用
// 既有 recoverShopDayReadback 只读回读把同一份号耐久升格为 published-success +
// recoveredBy=scheduled-readback-recovery）。整串逐字比对，绝不前缀/通配泛化；其它任何
// unknown reason（含 management-identity-hydrate-failed）都不进入本支路、仍走既有严格拒绝。
const R16_READBACK_CONVERGENCE_REASON = 'management-identity-hydrate-timeout';

function sha256Hex(text) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text)).digest('hex');
}

/**
 * 创建一次性 runner。opts（全部可注入，测试用假 clock / 假 deps / 临时根）：
 * - configFile / dataDir / adapterRoot / stateRoot / schedulerPath / schedulerModule
 * - deps: { runPlan, readDaySuccess, discoverAccount }（缺省装载真实 run-plans.cjs 导出）
 * - nowMs / onLog / lockStaleMs
 * 返回 { tick, scheduler }。tick() 执行一次排程 tick 后返回；不 start()、无定时器。
 */
function createDailyRunner(o = {}) {
  const opts = o || {};
  const configFile = opts.configFile || DEFAULT_CONFIG_FILE;
  const dataDir = opts.dataDir || DEFAULT_DATA_DIR;
  const readFresh = () => readDailyConfig(configFile);

  const initial = readFresh();
  if (!initial.ok) {
    const err = new Error('daily-plan-config-invalid: ' + initial.reasons.join('; '));
    err.reasons = initial.reasons;
    throw err;
  }
  const adapterRoot = opts.adapterRoot || initial.value.adapterRoot;
  // stateRoot 缺省不覆盖：run-plans.cjs 用自身 ROOT，publisher 既有按店状态/成功事实
  // 继续在原目录保留以正确去重；只有显式注入（测试）才改。
  const stateRoot = opts.stateRoot || (initial.value.stateRoot ? initial.value.stateRoot : '');
  const stateOverride = stateRoot ? { stateRoot } : {};

  const schedulerPath = resolveSchedulerPath(adapterRoot, opts.schedulerPath);
  const schedulerModule = opts.schedulerModule || (schedulerPath ? require(schedulerPath) : null);
  if (!schedulerModule || typeof schedulerModule.createScheduler !== 'function') {
    throw new Error('promo-plan-scheduler-not-resolvable' + (schedulerPath ? ':' + schedulerPath : ''));
  }
  const deps = opts.deps || loadRealDeps();
  for (const k of ['runPlan', 'readDaySuccess', 'discoverAccount']) {
    if (typeof deps[k] !== 'function') throw new Error('daily-plan-deps-missing:' + k);
  }

  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const ledgerFile = path.join(dataDir, 'ledger.json');

  // 每次调用都 fresh 读自己的配置文件（不缓存）：policy / 店名单 / 登录视图全用当前字节；
  // 停用（enabled/autoConfirm false）后 listShops 返回空 → 零未来派发，绝不继承值守开关。
  function policyProvider() {
    const c = readFresh();
    if (!c.ok) return null;
    return {
      enabled: c.value.enabled,
      autoConfirm: c.value.autoConfirm,
      plansPerShopPerDay: c.value.plansPerShopPerDay,
      dailyBudget: c.value.dailyBudget,
      time: c.value.time,
      timezone: c.value.timezone,
    };
  }
  function currentShopProvider(name) {
    const c = readFresh();
    if (!c.ok) return { unreadable: true };
    const s = c.value.shops.find((x) => String(x.name) === String(name));
    return s ? s : { missing: true };
  }
  function loadConfigView() {
    const c = readFresh();
    if (!c.ok) return { ready: false, reason: 'daily-plan-config-unreadable' };
    // 独立视图：shops 来自本配置；login 仅路径/开关（cookieWorkDir / cookieSourceDir 等），
    // 绝不含 Cookie 值，也绝不让 runScheduledPlan 落回值守 guard/config。
    return { ready: true, config: { shops: c.value.shops, login: c.value.login } };
  }
  const liveShops = () => {
    const c = readFresh();
    return c.ok ? c.value.shops.filter((s) => s && s.deleted !== true).map((s) => ({ ...s })) : [];
  };

  // R4：首次使用页面接线——discoverAccount 与 runPlan 都经 run-plans 既有 opts.openShop DI，
  // 包装真实 adapter readers.openChengfangShop({...args, readOnlyStatus:true})（保留传入的
  // loginCfg/shopCfg/headless 等），常规店返回原生 opened 对象。readers 懒加载（--check/纯
  // 注入测试不触发 require adapter）；opts.readers / opts.openShop 为离线捕获实参的注入缝。
  let readersRef = opts.readers || null;
  let wrappedOpenShop = typeof opts.openShop === 'function' ? opts.openShop : null;
  const openShop = async (args) => {
    if (!wrappedOpenShop) {
      let readers = readersRef;
      if (!readers) {
        readers = require(path.join(adapterRoot, 'src', 'adapters', 'chengfang-reader'));
        readersRef = readers;
      }
      if (!readers || typeof readers.openChengfangShop !== 'function') {
        throw new Error('daily-plan-openShop-capability-missing');
      }
      wrappedOpenShop = (a) => readers.openChengfangShop({ ...a, readOnlyStatus: true });
    }
    return wrappedOpenShop(args);
  };
  // R4：停用检查必须真的有效——scheduler 初始 cfg 会缓存 enabled，单批中途停用时它仍会调
  // 后面的 runPlan/discover。独立 wrapper 在每次真正发单/开新会话前 fresh 读自己的最新
  // policy；停用后零底层调用（诚实 unknown/blocked，绝不伪造成功、绝不借值守开关）。
  const freshEnabled = () => {
    const p = policyProvider();
    return !!p && p.enabled === true && p.autoConfirm === true;
  };
  const FRESH_DISABLED_RUN = { status: 'unknown', reason: 'daily-plan-fresh-disabled-no-dispatch', noAction: true, noReplay: true };

  // ── R7 严格准备收口钩子（同锁内映射；绝不手改账本、绝不重置成功）──────────────
  // runAccountByRunId：本进程内每次真实派发把 runId → 已验证 business.accountId 记下，
  // 供同步钩子做账号精确绑定（缺/漂移一律 applied:false 保持 unknown）。
  const runAccountByRunId = new Map();
  const shopNameOf = (shopId) => {
    const c = readFresh();
    if (!c.ok) return null;
    const s = c.value.shops.find((x) => String(x.id != null ? x.id : x.name) === String(shopId));
    return s ? String(s.name) : null;
  };
  // tick 持锁内被 scheduler 同步调用的窄映射：仅当 runPlan 以「携带严格零消费
  // preparationClosure 事实的 preparation-stopped」返回，且事实逐字绑定同店名（配置名，
  // 非账本 id 键）/账号/业务日/份号/runId（排程 origin 内嵌当日）与当前账本条目
  // （status unknown|failed、reason 逐字、无任何 CID/planId/manifest/nonce/frozen 痕迹、
  // 成功计数一致、无其它在途）时，把**这一份**映射为 preparation-stopped（成功计数与
  // 其它条目原样保留；unsubmitted 退避记账由 scheduler 既有分支完成）。任何缺证明/
  // 漂移/其它消费一律 applied:false，条目保持 unknown，绝不凭 reason 字符串放行。
  const applyRunResultToLedger = (ledger, businessDate, shopId, r, cfg, planNumber) => {
    try {
      if (!r || typeof r !== 'object' || r.status !== 'preparation-stopped') return { applied: false };
      const fact = r.preparationClosure;
      if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return { applied: false };
      if (fact.status !== 'preparationClosed') return { applied: false };
      // R8：与旧 watch-drill strictPreparationFact 完全对齐——phase 必须 preparing、份号 1..10、
      // reason 非空且有界、外层 run 结果与耐久事实 reason 逐字一致；错误闭合证明永不写。
      if (fact.phase !== 'preparing') return { applied: false };
      const factPlan = Number(fact.planNumber);
      if (!Number.isInteger(factPlan) || factPlan < 1 || factPlan > 10) return { applied: false };
      const shopName = shopNameOf(shopId);
      if (!shopName || String(fact.shop || '') !== shopName) return { applied: false };
      if (String(fact.businessDate || '') !== String(businessDate)) return { applied: false };
      if (Number(fact.planNumber) !== Number(planNumber)) return { applied: false };
      const origin = SCHEDULED_RUN_ORIGIN_RE.exec(String(fact.runId || ''));
      if (!origin || origin[1] !== String(businessDate)) return { applied: false };
      if (String(r.runId || '') !== String(fact.runId)) return { applied: false };
      if (String(r.businessDate || '') !== String(businessDate)) return { applied: false };
      if (Number(r.planNumber) !== Number(planNumber)) return { applied: false };
      if (!/^\d{6,24}$/.test(String(fact.accountId || ''))) return { applied: false };
      // 外层 run 结果若携带账号，必须与内层事实逐字一致（内外同账号）。
      if (r.accountId != null && String(r.accountId) !== '' && String(r.accountId) !== String(fact.accountId)) return { applied: false };
      const expectedAccount = runAccountByRunId.get(String(fact.runId));
      if (expectedAccount == null || expectedAccount === '' || expectedAccount !== String(fact.accountId)) return { applied: false };
      if (!strictZeroConsumptionProof(fact.zeroConsumptionProof)) return { applied: false };
      if (typeof fact.reason !== 'string' || fact.reason.trim() === '' || fact.reason.length > 1024) return { applied: false };
      if (String(fact.reason) !== String(r.reason == null ? '' : r.reason)) return { applied: false };
      const day = ledger && ledger.days && ledger.days[businessDate];
      const rec = day && day.shops && day.shops[shopId];
      const key = String(planNumber);
      const e = rec && rec.entries && rec.entries[key];
      if (!e || (e.status !== 'unknown' && e.status !== 'failed')) return { applied: false };
      if (String(e.reason || '') !== String(r.reason || '')) return { applied: false };
      if (e.confirmationId != null || e.planId != null || e.manifestHash != null || e.nonce != null || e.frozen) return { applied: false };
      if (!rec || rec.confirmationId != null || rec.frozen || rec.nonce != null) return { applied: false };
      if (typeof schedulerModule.hasInProgress === 'function' && schedulerModule.hasInProgress(rec)) return { applied: false };
      if (typeof schedulerModule.countSuccessEntries === 'function'
        && schedulerModule.countSuccessEntries(rec) !== (Number(rec.plans) || 0)) return { applied: false };
      rec.entries[key] = {
        planNumber: Number(key), status: 'preparation-stopped', reason: String(r.reason),
        preparationRunId: String(fact.runId), closedAt: typeof fact.closedAt === 'string' ? fact.closedAt : null,
        recoveredBy: 'run-preparation-closure',
      };
      return { applied: true };
    } catch (_) { return { applied: false }; }
  };

  // 崩溃遗留 in-progress 的本地准备恢复（browser-free）：先走 publisher 既有
  // recoverLocalPreparationClose（其内部取 publisher 真实互斥锁、新鲜回读、严格零消费
  // 证明 + 写前 CAS + 耐久收口），再把其严格事实经**唯一** canonical
  // applySchedulerReleaseToRecord（共享 scheduler 原样导出）映射为可重试 unsubmitted。
  // 锁忙/证明不齐/身份或份号漂移/源字节漂移一律 applied:false，本店保持 unknown 终态。
  const recoverStalePreparation = async (shop, ctx) => {
    try {
      if (typeof deps.recoverLocalPreparation !== 'function') {
        return { applied: false, reason: 'stale-preparation-recovery-unavailable' };
      }
      const rec0 = ctx && ctx.rec;
      const entries = (rec0 && rec0.entries) || {};
      const inFlight = Object.keys(entries).filter((k) => entries[k] && entries[k].status === 'in-progress');
      if (inFlight.length !== 1) return { applied: false, reason: 'stale-preparation-not-unique-in-progress:' + inFlight.length };
      const key = inFlight[0];
      const planNumber = Number(entries[key].planNumber != null ? entries[key].planNumber : key);
      const shopLike = {
        shop: shop && shop.name,
        accountId: shop && shop.accountId != null && String(shop.accountId) !== '' ? String(shop.accountId) : null,
      };
      const local = await deps.recoverLocalPreparation(shopLike, ctx.businessDate, { ...stateOverride, planNumber });
      if (!local || local.ok !== true) {
        return { applied: false, reason: 'stale-preparation-local-recovery-refused:' + ((local && local.reason) || 'unknown') };
      }
      if (local.status !== 'preparationClosed' || !local.preparationClosure) {
        return { applied: false, reason: 'stale-preparation-local-recovery-not-closed:' + ((local && local.status) || 'unknown') };
      }
      const fact = local.preparationClosure;
      if (String(fact.shop || '') !== String(shop && shop.name)) return { applied: false, reason: 'stale-preparation-shop-mismatch' };
      if (Number(fact.planNumber) !== planNumber) return { applied: false, reason: 'stale-preparation-plan-mismatch' };
      if (String(fact.businessDate || '') !== String(ctx.businessDate)) return { applied: false, reason: 'stale-preparation-date-mismatch' };
      if (!strictZeroConsumptionProof(fact.zeroConsumptionProof)) return { applied: false, reason: 'stale-preparation-proof-not-strict' };
      // R9：账号必须绑定到本店已配置/已解析的可信 ID；配置为 null 时才采用 publisher
      // 解析出的 own identity，绝不把空账号当成"已证明身份"。
      const cfgAccount = shop && shop.accountId != null && String(shop.accountId) !== '' ? String(shop.accountId) : '';
      const boundAccount = cfgAccount !== '' ? cfgAccount : String(local.accountId != null ? local.accountId : '');
      if (!/^\d{6,24}$/.test(boundAccount)) return { applied: false, reason: 'stale-preparation-account-identity-unavailable' };
      if (String(fact.accountId || '') !== boundAccount) return { applied: false, reason: 'stale-preparation-account-mismatch' };
      if (!/^[0-9a-f]{64}$/.test(String(local.sourceHash || ''))) return { applied: false, reason: 'stale-preparation-source-hash-invalid' };
      // R9：fresh 源字节 CAS（state + attempts + published + identity 面）。证明写完到映射之间
      // 任何字节漂移都拒绝，绝不把旧证明套到新字节上。
      if (typeof deps.currentSourceHash !== 'function') return { applied: false, reason: 'stale-preparation-source-verify-unavailable' };
      let freshHash = null;
      try {
        freshHash = deps.currentSourceHash(local.sourceStateFile, local.sourceAttemptsFile,
          Array.isArray(local.sourceExtraFiles) ? local.sourceExtraFiles : []);
      } catch (_) { freshHash = null; }
      if (typeof freshHash !== 'string' || freshHash !== String(local.sourceHash)) {
        return { applied: false, reason: 'stale-preparation-source-drift' };
      }
      const shopId = String(ctx && ctx.shopId != null ? ctx.shopId : '');
      if (shopId === '') return { applied: false, reason: 'stale-preparation-shop-id-unavailable' };
      const startedAt = typeof entries[key].startedAt === 'string' ? entries[key].startedAt : null;
      // R9：外层 release proof 的 shop 是**账本 shopId**，内层 closureProof.shop 必须与外层逐字
      // 相同（strictLocalPreparationClosureProof 的硬要求）；真实店名只放进 publisherShop。
      const closureProof = {
        method: 'local-preparation-closed', businessDate: String(ctx.businessDate), shop: shopId,
        publisherShop: String(shop && shop.name), accountId: boundAccount,
        planNumber, runId: String(fact.runId || local.runId || ''), sourceHash: String(local.sourceHash),
        reason: String(fact.reason || local.reason || ''), zeroConsumptionProof: fact.zeroConsumptionProof,
        entryStartedAt: startedAt,
      };
      const proof = {
        status: 'scheduler-release-prepublication', method: 'scheduler-release-prepublication',
        businessDate: String(ctx.businessDate), shop: shopId, planNumber,
        accountId: boundAccount, recStatus: 'unknown', entryStatus: 'in-progress',
        entryStartedAt: startedAt, entryReasonHash: sha256Hex(entries[key].reason),
        entryProvenanceMethod: 'local-preparation-closed', preparationClosureProof: closureProof,
      };
      const limit = typeof schedulerModule.resolveShopPlansPerDay === 'function'
        ? schedulerModule.resolveShopPlansPerDay(shop, ctx.cfg && ctx.cfg.plansPerShopPerDay) : 3;
      const mapped = schedulerModule.applySchedulerReleaseToRecord(rec0, proof, typeof opts.nowMs === 'function' ? opts.nowMs() : Date.now(), limit);
      if (!mapped || mapped.changed !== true) return { applied: false, reason: 'stale-preparation-release-binding-mismatch' };
      return { applied: true };
    } catch (e) { return { applied: false, reason: 'stale-preparation-recovery-threw:' + ((e && e.message) || e) }; }
  };

  const scheduler = schedulerModule.createScheduler({
    planPublishing: {
      enabled: initial.value.enabled,
      autoConfirm: initial.value.autoConfirm,
      // 2026-10-26 patrol-plan-refill（客户要求）：补发检查全天随值守触发，去掉 08:00 门槛。
      // 中性 00:00 = dispatchFrom 0 → 任何时刻 tick 都到点；配置 time 字段不再作为派发门槛
      //（保留字段仅为兼容旧配置文件形状）。跨日隔离仍由账本 businessDate 保证。
      time: '00:00',
      timezone: initial.value.timezone,
      plansPerShopPerDay: initial.value.plansPerShopPerDay,
      dailyBudget: initial.value.dailyBudget,
    },
    ledgerFile,
    lockFile: ledgerFile + '.lock',
    lockStaleMs: opts.lockStaleMs,
    // 2026-10-26 patrol-plan-refill 返修：删除自造的 48 次/日封顶（客户从未要求任一新的
    // 任意上限）。值守模式下，**严格证明从未提交**的缺额可在后续每次巡逻检查重试，直到
    // 配置的成功目标；unknown/已消费/已成功一律不重放，既有退避/成功账本原样保留。
    // 实现：向 scheduler 显式传 null = 无上限（Infinity）——仅独立 runner 这一个调用方使用；
    // 其它调用方（含 watch-drill 旧内嵌发布器）缺省仍为 legacy 3，行为不变。
    maxUnsubmittedRetries: Object.prototype.hasOwnProperty.call(opts, 'maxUnsubmittedRetries')
      ? (opts.maxUnsubmittedRetries === undefined ? null : opts.maxUnsubmittedRetries)
      : null,
    nowMs: opts.nowMs,
    onLog,
    listShops: liveShops,
    buildBusiness: (shop, ctx) => ({
      shop: shop.name,
      accountId: shop.accountId != null && String(shop.accountId) !== '' ? String(shop.accountId) : null,
      boundAccounts: shop.boundAccounts || null,
      // 未配 ROI 传 undefined → 排程器沿用合法默认 15（promo-plan-scheduler.js L805）。
      roi: typeof shop.targetRoi === 'number' && shop.targetRoi > 0 ? shop.targetRoi : undefined,
      dailyBudget: ctx.dailyBudget,
      productsPerPlan: shop.productsPerPlan,
      commissionIncluded: shop.commissionIncluded,
      directPay: shop.directPay,
      maxPlansPerDay: ctx.plansPerShopPerDay,
      creationPath: shop.creationPath || undefined,
    }),
    readDaySuccess: (shopId, businessDate) => {
      const c = readFresh();
      const s = c.ok && c.value.shops.find((x) => String(x.id != null ? x.id : x.name) === String(shopId));
      if (!s) throw new Error('daily-plan-shop-not-in-config:' + shopId);
      return deps.readDaySuccess(
        { shop: s.name, accountId: s.accountId != null && String(s.accountId) !== '' ? String(s.accountId) : null },
        businessDate,
        Object.keys(stateOverride).length ? { ...stateOverride } : {}
      );
    },
    discoverAccount: (shop, business) => {
      if (!freshEnabled()) return { error: 'daily-plan-fresh-disabled-no-discovery' };
      return deps.discoverAccount(
        shop,
        business,
        { headless: true, loadConfig: loadConfigView, projectRoot: adapterRoot, openShop, ...stateOverride }
      );
    },
    runPlan: async (business, planOpts) => {
      if (!freshEnabled()) return { ...FRESH_DISABLED_RUN };
      const r = await deps.runPlan(business, {
        ...planOpts,
        projectRoot: adapterRoot,
        loadConfig: loadConfigView,
        policyProvider,
        currentShopProvider: () => currentShopProvider(business.shop),
        headless: true,
        onLog,
        openShop,
        ...stateOverride,
      });
      // R7：记下本 runId 的已验证账号，供同步钩子 applyRunResultToLedger 精确绑定。
      if (r && typeof r === 'object' && typeof r.runId === 'string' && r.runId !== '') {
        runAccountByRunId.set(String(r.runId), String(business.accountId != null ? business.accountId : ''));
      }
      return r;
    },
    // 不注入 enableShop：发布后不调用值守开启/暂停（enable 记为 enable-unsupported）。
    // R7：注入同锁内严格准备收口映射（applyRunResultToLedger）与崩溃遗留 in-progress 的
    // 本地准备恢复（recoverStalePreparation，仅 browser-free 本地恢复 + canonical release）。
    // 判据全部严格绑定店/账号/日/份号/runId/零消费证明；不满足保持 unknown-noReplay。
    applyRunResultToLedger,
    ...(typeof deps.recoverLocalPreparation === 'function' ? { recoverStalePreparation } : {}),
    // R9：canonical 释放的锁内新鲜度钩子。releaseProvenRemainder 在取得排程锁后调用本钩子，
    // 用 proof 自带的 state/attempts/extras 路径重算当前磁盘字节；任一漂移/不可读即
    // release-source-not-fresh。没有哈希能力时返回 false（绝不把未复核当成新鲜）。
    verifyReleaseSourceProof: (proof) => {
      try {
        if (!proof || typeof deps.currentSourceHash !== 'function') return false;
        const extras = Array.isArray(proof.sourceExtraFiles) ? proof.sourceExtraFiles : [];
        const fresh = deps.currentSourceHash(proof.sourceStateFile, proof.sourceAttemptsFile, extras);
        return typeof fresh === 'string' && fresh === String(proof.sourceHash);
      } catch (_) { return false; }
    },
  });

  // R8：显式本地恢复入口（主脑可用；无 UI、无新功能）。对某店某业务日按三种真实形状逐字处理，
  // 全部只按证明，绝不手改账本、绝不凭 reason 字符串清 unknown、绝不放宽未闭合 preparing 门：
  //  1) failed/blocked 零发布（简尚实录）→ publisher proveSchedulerReleaseProof（内部独立零发布
  //     复证 + 账本条目逐字绑定）+ fresh 源字节 CAS + scheduler.releaseProvenRemainder；
  //  2) prepare-stopped:* unknown 条目（canonical F1 不收）→ publisher 只读重证支路
  //     reproveDurablePreparationStoppedClose（已耐久 preparation-stopped + 唯一严格事实 +
  //     正常 writer schema attempts + 新鲜零消费/发布重证 + 源字节 CAS），再在排程锁内按
  //     watch-drill 既有 preparationClosed 窄映射（复制必要逻辑，不 import 值守）只把**那一条**
  //     unknown 转 preparation-stopped；成功条目与其它 unknown 原样保留，幂等；
  //  2b) R16 已回读成功收敛：唯一 unknown reason 逐字 management-identity-hydrate-timeout，
  //     且 publisher 耐久事实（published-success active + 同 CID initial/final 双 success +
  //     日成功计划与独立发布面同一真实唯一 planId）全部证明 → 纯本地把该条收敛为
  //     success + 真实 planId（来源记为已回读恢复），绝不重放、绝不开浏览器；
  //  3) canonical F1（唯一 in-progress / exception unknown 条目）→ 既有 recoverLocalPreparationClose
  //     + canonical release（与 R7 相同）。
  async function recoverShopDay(shopIdOrName, businessDate) {
    const fail = (reason, extra) => Object.assign({ ok: false, released: false, reason }, extra || {});
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || ''))) return fail('recovery-business-date-invalid');
    const c = readFresh();
    if (!c.ok) return fail('recovery-config-unreadable');
    const shop = c.value.shops.find((x) => String(x.id != null ? x.id : x.name) === String(shopIdOrName) || String(x.name) === String(shopIdOrName));
    if (!shop || shop.deleted === true) return fail('recovery-shop-not-in-config:' + shopIdOrName);
    const shopId = String(shop.id != null ? shop.id : shop.name);
    const cfgAccount = shop.accountId != null && String(shop.accountId) !== '' ? String(shop.accountId) : null;
    const shopLike = { shop: shop.name, accountId: cfgAccount };
    const nowMs = opts.nowMs || Date.now;
    const recOf = (ledger) => (ledger && ledger.days && ledger.days[businessDate] && ledger.days[businessDate].shops
      && ledger.days[businessDate].shops[shopId]) || null;
    let rec0 = recOf(schedulerModule.loadLedger(ledgerFile));
    if (!rec0) return fail('recovery-no-current-record');

    const crashRecoverySources = ['durable-crash-success-recovery', 'native-first-success-summary-recovery'];
    const crashCandidates = Object.keys(rec0.entries || {}).filter(k => {
      const e = rec0.entries[k];
      return e && (e.status === 'in-progress'
        || (e.status === 'success' && crashRecoverySources.includes(e.recoveredBy)));
    });
    if (crashCandidates.length && (rec0.status === 'unknown'
      || crashCandidates.some(k => crashRecoverySources.includes(rec0.entries[k].recoveredBy)))) {
      const crashRecovery = (() => {
        const refuse = reason => fail('recovery-crash-' + reason);
        const object = x => !!x && typeof x === 'object' && !Array.isArray(x);
        const read = f => JSON.parse(fs.readFileSync(f, 'utf8'));
        if (crashCandidates.length !== 1) return refuse('entry-not-unique');
        const key = crashCandidates[0];
        const entry = rec0.entries[key];
        const planNo = entry.planNumber;
        const already = entry.status === 'success';
        if (!already && rec0.error !== 'unresolved-in-progress-no-replay') return null;
        if (typeof deps.resolvePublisherPaths !== 'function' || typeof deps.currentSourceHash !== 'function') return refuse('capability-unavailable');
        let resolved;
        try { resolved = deps.resolvePublisherPaths(shopLike, stateRoot || undefined); }
        catch (_) { return refuse('paths-unavailable'); }
        if (!resolved || resolved.ok !== true || !resolved.paths) return refuse('paths-unavailable');
        const paths = resolved.paths;
        const account = String(resolved.accountId || '');
        if (!/^\d{6,24}$/.test(account) || (cfgAccount !== null && cfgAccount !== account)) return refuse('account-conflict');
        if (!paths.stateFile || !paths.attemptsFile || !paths.publishedFile || !paths.lockFile) return refuse('paths-incomplete');
        const extras = [...new Set([...(resolved.sourceExtraFiles || []), paths.publishedFile,
          ...(resolved.identityFile ? [resolved.identityFile] : []), ...(paths.seedFile ? [paths.seedFile] : [])])];
        const sourceHash = () => {
          try { return deps.currentSourceHash(paths.stateFile, paths.attemptsFile, extras); }
          catch (_) { return null; }
        };
        const before = sourceHash();
        if (!/^[a-f0-9]{64}$/.test(String(before || ''))) return refuse('source-unreadable');
        let state, attempts, published;
        try { state = read(paths.stateFile); } catch (_) { return refuse('state-unreadable'); }
        if (!object(state) || state.businessDate !== businessDate) return refuse('state-date-or-shape');
        // A genuinely unconsumed current preparation still belongs to canonical F1, not success recovery.
        if (!already && Array.isArray(state.plans) && !state.plans.some(p => p && Number(p.planNumber) === Number(planNo))
          && object(state.active) && state.active.status === 'preparing' && Number(state.active.planNumber) === Number(planNo)) return null;
        if (fs.existsSync(paths.lockFile) || fs.existsSync(paths.lockFile + '.recovery')) return refuse('publisher-lock-busy');
        try { attempts = read(paths.attemptsFile); } catch (_) { return refuse('attempts-unreadable'); }
        try { published = read(paths.publishedFile); } catch (_) { return refuse('published-unreadable'); }
        const limit = schedulerModule.resolveShopPlansPerDay(shop, c.value.plansPerShopPerDay);
        if (!object(rec0.entries) || !Number.isInteger(planNo) || planNo < 1 || planNo > limit || key !== String(planNo)) return refuse('entry-plan-number');
        if (!already && (typeof entry.startedAt !== 'string' || !Number.isFinite(Date.parse(entry.startedAt)))) return refuse('entry-start-missing');
        if (state.unknown || state.pending) return refuse('state-unresolved');
        const identityAgrees = r => object(r)
          && (r.shop == null || String(r.shop) === String(shop.name))
          && (r.accountId == null || String(r.accountId) === account)
          && (r.account_id == null || String(r.account_id) === account)
          && (r.businessDate == null || r.businessDate === businessDate);
        if (![state, rec0, entry].every(identityAgrees)) return refuse('identity-conflict');
        if (rec0.frozen != null || rec0.nonce != null || rec0.confirmationId != null || entry.frozen != null || entry.nonce != null) return refuse('ledger-artifacts');
        const ledgerEntries = Object.entries(rec0.entries);
        for (const [k, e] of ledgerEntries) {
          if (!identityAgrees(e) || !Number.isInteger(e.planNumber) || k !== String(e.planNumber)
            || e.planNumber < 1 || e.planNumber > limit || (k !== key && e.status !== 'success')) return refuse('other-entry-unresolved-or-invalid');
        }
        if (!Array.isArray(state.plans) || state.plans.length !== ledgerEntries.length) return refuse('day-plans-count');
        const plans = new Map();
        const ids = new Set();
        for (const p of state.plans) {
          if (!identityAgrees(p) || p.status !== 'success' || !Number.isInteger(p.planNumber)
            || !rec0.entries[String(p.planNumber)] || plans.has(p.planNumber)
            || !/^\d{12,20}$/.test(String(p.planId || '')) || ids.has(String(p.planId))
            || !/^[a-f0-9]{64}$/.test(String(p.manifestHash || ''))) return refuse('day-plan-conflict');
          const le = rec0.entries[String(p.planNumber)];
          if ((p.planNumber !== planNo || le.planId != null) && String(le.planId || '') !== String(p.planId)) return refuse('ledger-plan-id-conflict');
          plans.set(p.planNumber, p); ids.add(String(p.planId));
        }
        // The unchanged scheduler dispatches rec.plans + 1, so success numbers must form a prefix.
        for (let n = 1; n <= plans.size; n++) if (!plans.has(n)) return refuse('noncontiguous-success');
        const target = plans.get(planNo);
        if (!target) return refuse('day-success-missing');
        if (object(attempts) && !Object.hasOwn(attempts, 'reopenConsumed')) attempts = { ...attempts, reopenConsumed: {} };
        if (!object(attempts) || !['consumed', 'finalConsumed', 'reopenConsumed'].every(k => object(attempts[k]))) return refuse('attempts-tables-incomplete');
        if (Object.keys(attempts.reopenConsumed).length) return refuse('reopen-consumption-present');
        const current = new Map();
        const consumedRuns = new Set();
        for (const [cid, initial] of Object.entries(attempts.consumed)) {
          const final = attempts.finalConsumed[cid];
          if (!object(initial) || !object(final) || initial.status !== 'success' || final.status !== 'success') return refuse('consumption-not-success-pair');
          if (!/^\d{4}-\d{2}-\d{2}$/.test(String(initial.businessDate || '')) || initial.businessDate > businessDate
            || typeof initial.runId !== 'string' || !initial.runId || !Number.isInteger(initial.planNumber)
            || initial.planNumber < 1 || !/^[a-f0-9]{64}$/.test(String(initial.manifestHash || ''))) return refuse('consumption-scope-missing');
          const scheduledOrigin = SCHEDULED_RUN_ORIGIN_RE.exec(initial.runId);
          if ((scheduledOrigin && scheduledOrigin[1] !== initial.businessDate) || consumedRuns.has(initial.runId)) return refuse('consumption-run-conflict');
          consumedRuns.add(initial.runId);
          for (const field of ['runId', 'businessDate', 'planNumber', 'manifestHash']) {
            if (initial[field] !== final[field]) return refuse('consumption-scope-conflict');
          }
          for (const r of [initial, final]) {
            if ((r.confirmationId != null && r.confirmationId !== cid)
              || (r.shop != null && String(r.shop) !== String(shop.name))
              || (r.accountId != null && String(r.accountId) !== account)
              || (r.account_id != null && String(r.account_id) !== account)) return refuse('consumption-identity-conflict');
          }
          if (initial.businessDate !== businessDate) continue;
          const p = plans.get(initial.planNumber);
          const origin = SCHEDULED_RUN_ORIGIN_RE.exec(initial.runId);
          if (!p || !origin || origin[1] !== businessDate || current.has(initial.planNumber)
            || p.manifestHash !== initial.manifestHash) return refuse('current-consumption-conflict');
          for (const r of [initial, final, p, rec0.entries[String(initial.planNumber)]]) {
            if (r.runId != null && r.runId !== initial.runId) return refuse('run-id-conflict');
            if (r.confirmationId != null && r.confirmationId !== cid) return refuse('cid-conflict');
            if (r.manifestHash != null && r.manifestHash !== p.manifestHash) return refuse('manifest-conflict');
            if (r.planId != null && String(r.planId) !== String(p.planId)) return refuse('plan-id-conflict');
          }
          current.set(initial.planNumber, { cid, initial, final });
        }
        if (Object.keys(attempts.finalConsumed).some(cid => !Object.hasOwn(attempts.consumed, cid))) return refuse('orphan-final-consumption');
        if (current.size !== plans.size) return refuse('success-consumption-missing');
        if (!Array.isArray(state.confirmationConsumptions) || !Array.isArray(state.manualUiPublicationFacts)
          || state.manualUiPublicationFacts.length) return refuse('state-consumption-lists');
        const seenConfirmations = new Set();
        for (const r of state.confirmationConsumptions) {
          const pair = object(r) && current.get(r.planNumber);
          if (!pair || !identityAgrees(r) || r.confirmationId !== pair.cid || r.manifestHash !== pair.initial.manifestHash
            || (r.runId != null && r.runId !== pair.initial.runId) || seenConfirmations.has(r.confirmationId)) return refuse('state-confirmation-conflict');
          seenConfirmations.add(r.confirmationId);
        }
        if (!object(published) || !identityAgrees(published) || !Array.isArray(published.plans)
          || !Array.isArray(published.publishedIds)) return refuse('published-shape');
        const seenPublished = new Set();
        const todayPublished = new Set();
        for (const p of published.plans) {
          if (!object(p) || !/^\d{12,20}$/.test(String(p.planId || '')) || seenPublished.has(String(p.planId))) return refuse('published-plan-duplicate-or-invalid');
          if ((p.shop != null && String(p.shop) !== String(shop.name))
            || (p.accountId != null && String(p.accountId) !== account)
            || (p.account_id != null && String(p.account_id) !== account)
            || (p.businessDate != null && p.businessDate !== p.date)) return refuse('published-identity-conflict');
          seenPublished.add(String(p.planId));
          if (ids.has(String(p.planId)) && p.date !== businessDate) return refuse('published-date-conflict');
          if (p.date === businessDate) {
            const dp = state.plans.find(x => String(x.planId) === String(p.planId));
            if (!dp || !identityAgrees(p) || (p.planNumber != null && p.planNumber !== dp.planNumber)
              || (p.manifestHash != null && p.manifestHash !== dp.manifestHash)
              || (p.runId != null && p.runId !== current.get(dp.planNumber).initial.runId)) return refuse('published-plan-conflict');
            todayPublished.add(String(p.planId));
          }
        }
        if (todayPublished.size !== plans.size) return refuse('published-success-missing');
        const active = state.active;
        const pair = current.get(planNo);
        let successProof;
        if (active == null) return refuse('frozen-unavailable-without-active');
        if (!identityAgrees(active)) return refuse('active-identity-conflict');
        if (active.status === 'preparing' || active.status === 'preparation-stopped') {
          const origin = SCHEDULED_RUN_ORIGIN_RE.exec(String(active.runId || ''));
          if (active.planNumber !== plans.size + 1 || active.planNumber > limit || active.businessDate !== businessDate
            || !origin || origin[1] !== businessDate || (state.runId != null && state.runId !== active.runId)
            || ['frozen', 'confirmationId', 'manifestHash', 'planId', 'nonce'].some(k => active[k] != null)) return refuse('next-preparation-not-safe');
          for (const table of ['consumed', 'finalConsumed', 'reopenConsumed']) {
            if (Object.values(attempts[table]).some(r => r.runId === active.runId
              || (r.businessDate === businessDate && r.planNumber === active.planNumber))) return refuse('next-preparation-consumed');
          }
          if (planNo !== 1 || ledgerEntries.length !== 1 || plans.size !== 1 || current.size !== 1
            || typeof entry.startedAt !== 'string' || !Number.isFinite(Date.parse(entry.startedAt))) return refuse('native-first-only');
          if (!resolved.identityFile || !paths.seedFile) return refuse('native-source-paths-incomplete');
          // Account identity (shop-identity.json) and the account-scoped historical seed are
          // ACCOUNT-level facts, not facts of today's plan. Each is validated against its own
          // real schema: carried shop/accountId/account_id must agree with the resolved identity
          // (no conflict, no malformed document). The seed's productIds is the account's
          // cumulative published history and its plans are past planId/date pairs, so they may
          // legitimately differ from today's first plan in membership, order and date; they are
          // never used as evidence for today's planId/hash/run/product mapping.
          const accountSourceAgrees = r => object(r)
            && (r.shop == null || String(r.shop) === String(shop.name))
            && (r.accountId == null || String(r.accountId) === account)
            && (r.account_id == null || String(r.account_id) === account);
          for (const [kind, file] of [['identity', resolved.identityFile], ['seed', paths.seedFile]]) {
            if (!fs.existsSync(file)) continue;
            let doc;
            try { doc = read(file); } catch (_) { return refuse('native-source-' + kind + '-unreadable'); }
            if (!accountSourceAgrees(doc)) return refuse('native-source-' + kind + '-conflict');
            if (kind !== 'seed') continue;
            if (doc.productIds != null) {
              if (!Array.isArray(doc.productIds) || new Set(doc.productIds).size !== doc.productIds.length
                || doc.productIds.some(id => typeof id !== 'string' || !/^\d{15,20}$/.test(id))) return refuse('native-source-seed-products-invalid');
              // Non-empty history must stay attributable to this exact account.
              if (doc.productIds.length && String(doc.accountId == null ? '' : doc.accountId) !== account) return refuse('native-source-seed-conflict');
            }
            if (doc.plans != null && (!Array.isArray(doc.plans) || doc.plans.some(p => !object(p)
              || !/^\d{12,20}$/.test(String(p.planId || ''))
              || (p.date != null && !/^\d{4}-\d{2}-\d{2}$/.test(String(p.date)))))) return refuse('native-source-seed-plans-invalid');
            if (doc.capturedAt != null && !Number.isFinite(Date.parse(String(doc.capturedAt)))) return refuse('native-source-seed-captured-at-invalid');
          }
          const fact = Array.isArray(state.preparationClosureFacts) && state.preparationClosureFacts.length === 1
            ? state.preparationClosureFacts[0] : null;
          const stopReason = 'prepare-stopped:account-anchor-account-identity-drift';
          if (active.status !== 'preparation-stopped' || active.originalPhase !== 'preparing'
            || active.source !== 'scheduled-prepare-stopped' || active.reason !== stopReason
            || state.runId !== active.runId || !identityAgrees(fact)
            || fact.status !== 'preparationClosed' || fact.phase !== active.originalPhase
            || fact.runId !== active.runId || fact.businessDate !== businessDate || fact.planNumber !== 2
            || fact.shop !== shop.name || String(fact.accountId || '') !== account
            || fact.reason !== active.reason || fact.source !== active.source
            || typeof fact.closedAt !== 'string' || !Number.isFinite(Date.parse(fact.closedAt))
            || active.closedAt !== fact.closedAt || !strictZeroConsumptionProof(fact.zeroConsumptionProof)) return refuse('native-next-closure-not-proven');
          const artifacts = ['frozen', 'confirmationId', 'manifestHash', 'planId', 'nonce', 'frozenDisposition', 'policyCancel'];
          if ([active, fact, state].some(r => artifacts.some(k => r[k] != null)
            || (r.date != null && r.date !== businessDate))
            || (active.phase != null && active.phase !== fact.phase)
            || (active.actionTaken != null && active.actionTaken !== false)
            || (active.zeroConsumptionProof != null && !strictZeroConsumptionProof(active.zeroConsumptionProof))
            || state.confirmationConsumptions.length) return refuse('native-next-artifacts');
          const first = state.firstPublishedPlan;
          if (!identityAgrees(first) || first.status !== 'success' || first.planNumber !== 1
            || String(first.planId || '') !== String(target.planId) || first.businessDate !== businessDate
            || first.manifestHash !== target.manifestHash || first.runId !== pair.initial.runId
            || String(first.account_id || '') !== account || typeof first.planName !== 'string' || !first.planName.trim()
            || typeof pair.cid !== 'string' || !pair.cid.trim()
            || first.frozen != null || first.nonce != null) return refuse('native-first-summary-conflict');
          const products = first.product_ids;
          if (!Array.isArray(products) || products.length !== 30 || new Set(products).size !== 30
            || products.some(id => typeof id !== 'string' || !/^\d{15,20}$/.test(id))) return refuse('native-first-products');
          const publishedIds = new Set(published.publishedIds.map(String));
          if (!products.every(id => publishedIds.has(id))) return refuse('published-products-missing');
          const publishedTarget = published.plans.find(p => String(p.planId) === String(target.planId));
          for (const r of [rec0, entry, first, target, attempts, pair.initial, pair.final, published, publishedTarget]) {
            if (!identityAgrees(r) || (r.planId != null && String(r.planId) !== String(target.planId))
              || (r.planNumber != null && r.planNumber !== 1) || (r.runId != null && r.runId !== first.runId)
              || (r.confirmationId != null && r.confirmationId !== pair.cid)
              || (r.manifestHash != null && r.manifestHash !== first.manifestHash)
              || (r.date != null && r.date !== businessDate)
              || (r.planName != null && r.planName !== first.planName)) return refuse('native-summary-binding-conflict');
            for (const field of ['productIds', 'product_ids']) {
              if (r[field] != null && (!Array.isArray(r[field])
                || JSON.stringify(r[field]) !== JSON.stringify(products))) return refuse('native-summary-product-order-conflict');
            }
          }
          // Native hashes attest a persisted success; absent manifest inputs cannot be recomputed or authorize publishing.
          successProof = { method: 'native-first-success-summary-ledger-convergence',
            recoveredBy: 'native-first-success-summary-recovery', runId: first.runId, manifestHash: first.manifestHash,
            sourceHash: before, manifestRecomputed: false, newPublicationAuthorized: false,
            proof: 'native-summary proof，未重算原始manifest；不用于新发布授权' };
          if (already && (entry.sourceHash !== before || entry.convergedFrom !== 'in-progress'
            || entry.runId !== first.runId || entry.confirmationId !== pair.cid
            || entry.manifestHash !== first.manifestHash || entry.planId !== String(target.planId)
            || entry.method !== successProof.method || entry.proof !== successProof.proof
            || entry.manifestRecomputed !== false || entry.newPublicationAuthorized !== false
            || rec0.plans !== 1 || rec0.status !== 'partial' || rec0.error !== null || rec0.partial != null)) return refuse('native-idempotent-source-conflict');
        } else {
          if (active.status !== 'published-success' || active.planNumber !== planNo
            || String(active.planId || '') !== String(target.planId)) return refuse('active-not-target-success');
          if (active.authorizedBy !== 'recurring-user-policy' || active.actionTaken !== false) return refuse('active-provenance-incomplete');
          const frozen = active.frozen;
          if (!object(frozen)) return refuse('frozen-missing');
          const wfMod = require(path.join(RUNNER_DIR, 'plan-workflow.cjs'));
          const fields = ['planNumber', 'runId', 'businessDate', 'accountId', 'planName', 'roi', 'dailyBudget',
            'commissionIncluded', 'directPay', 'boundAccounts', 'productIds', 'disclosures'];
          if (!fields.every(k => Object.hasOwn(frozen, k)) || !identityAgrees(frozen)
            || frozen.businessDate !== businessDate || String(frozen.accountId) !== account || frozen.planNumber !== planNo
            || frozen.runId !== pair.initial.runId || frozen.confirmationId !== pair.cid
            || frozen.manifestHash !== target.manifestHash || typeof frozen.planName !== 'string' || !frozen.planName.trim()
            || !Array.isArray(frozen.boundAccounts) || !frozen.boundAccounts.length
            || !object(frozen.disclosures) || !['migration', 'precheck', 'reviewFailed'].every(k => Array.isArray(frozen.disclosures[k]))) return refuse('frozen-incomplete-or-conflicting');
          let hash;
          try { hash = wfMod.manifestHash(frozen); } catch (_) { return refuse('manifest-unreadable'); }
          if (hash !== target.manifestHash) return refuse('manifest-recheck-failed');
          const productCount = Number.isInteger(shop.productsPerPlan) && shop.productsPerPlan > 0 ? shop.productsPerPlan : wfMod.BUSINESS.productsPerPlan;
          const products = Array.isArray(frozen.productIds) ? frozen.productIds.map(String) : [];
          if (products.length !== productCount || new Set(products).size !== productCount || products.some(id => !/^\d{15,20}$/.test(id))) return refuse('frozen-products');
          if (Number(frozen.roi) !== (shop.targetRoi || 15) || Number(frozen.dailyBudget) !== c.value.dailyBudget
            || frozen.commissionIncluded !== (shop.commissionIncluded !== false) || frozen.directPay !== (shop.directPay === true)) return refuse('frozen-settings');
          const publishedIds = new Set(published.publishedIds.map(String));
          if (!products.every(id => publishedIds.has(id))) return refuse('published-products-missing');
          const publishedTarget = published.plans.find(p => String(p.planId) === String(target.planId));
          for (const r of [rec0, entry, active, target, pair.initial, pair.final, publishedTarget]) {
            if ((r.runId != null && r.runId !== frozen.runId) || (r.planName != null && r.planName !== frozen.planName)
              || (r.confirmationId != null && r.confirmationId !== pair.cid)
              || (r.manifestHash != null && r.manifestHash !== hash)) return refuse('frozen-binding-conflict');
            for (const field of ['productIds', 'product_ids']) {
              if (r[field] != null && (!Array.isArray(r[field])
                || JSON.stringify(r[field].map(String).slice().sort()) !== JSON.stringify(products.slice().sort()))) return refuse('product-set-conflict');
            }
          }
          if (state.runId != null && state.runId !== frozen.runId) return refuse('state-run-conflict');
          const first = state.firstPublishedPlan;
          if (!identityAgrees(first) || first.status !== 'success' || first.planNumber !== 1
            || String(first.planId || '') !== String(plans.get(1).planId)
            || first.manifestHash !== plans.get(1).manifestHash || first.businessDate !== businessDate
            || first.runId !== current.get(1).initial.runId) return refuse('first-published-conflict');
          if (planNo === 1 && (String(first.account_id || '') !== account || first.planName !== frozen.planName
            || !Array.isArray(first.product_ids) || JSON.stringify(first.product_ids.map(String)) !== JSON.stringify(products))) return refuse('first-published-products-conflict');
          successProof = { method: 'durable-crash-success-ledger-convergence', recoveredBy: 'durable-crash-success-recovery',
            runId: frozen.runId, manifestHash: hash };
        }
        if (already && entry.recoveredBy !== successProof.recoveredBy) return refuse('recovery-method-conflict');
        if (sourceHash() !== before) return refuse('source-drift');
        if (typeof schedulerModule.acquireProcessLock !== 'function' || typeof schedulerModule.releaseProcessLock !== 'function'
          || typeof schedulerModule.saveLedger !== 'function' || typeof schedulerModule.countSuccessEntries !== 'function') return refuse('scheduler-capability-unavailable');
        const lockFile = ledgerFile + '.lock';
        const lock = schedulerModule.acquireProcessLock(lockFile, nowMs, 30 * 60 * 1000);
        if (!lock || lock.held !== true) return refuse('scheduler-lock-busy');
        try {
          const ledger = schedulerModule.loadLedger(ledgerFile);
          const rec = recOf(ledger);
          if (!rec || JSON.stringify(rec) !== JSON.stringify(rec0)) return refuse('record-drift-under-lock');
          if (fs.existsSync(paths.lockFile) || fs.existsSync(paths.lockFile + '.recovery')) return refuse('publisher-lock-busy-under-lock');
          if (sourceHash() !== before) return refuse('source-drift-under-lock');
          const result = { ...successProof, planNumber: planNo, planId: String(target.planId), confirmationId: pair.cid };
          if (already) return { ...result, ok: true, released: false, idempotent: true, reason: 'already-converged' };
          Object.assign(rec.entries[key], { status: 'success', planId: String(target.planId), ...successProof,
            confirmationId: pair.cid, convergedFrom: 'in-progress', convergedAt: new Date(nowMs()).toISOString() });
          rec.plans = schedulerModule.countSuccessEntries(rec);
          rec.status = rec.plans >= limit ? 'success' : 'partial';
          if (successProof.recoveredBy === 'native-first-success-summary-recovery') delete rec.partial;
          rec.error = null;
          rec.lastAt = new Date(nowMs()).toISOString();
          schedulerModule.saveLedger(ledgerFile, ledger);
          return { ...result, ok: true, released: true };
        } finally { schedulerModule.releaseProcessLock(lockFile, lock.token); }
      })();
      if (crashRecovery) return crashRecovery;
    }

    // ── 形状 1：failed/blocked 零发布 → publisher 严格 release 证明 + fresh CAS + canonical 释放。
    if (String(rec0.status) === 'failed' || String(rec0.status) === 'blocked') {
      if (typeof deps.proveSchedulerRelease !== 'function' || typeof deps.currentSourceHash !== 'function'
        || typeof deps.resolvePublisherPaths !== 'function') {
        return fail('recovery-release-capability-unavailable');
      }
      const keys = Object.keys((rec0 && rec0.entries) || {});
      if (keys.length !== 1) return fail('recovery-failed-entry-not-unique:' + keys.length);
      const e0 = rec0.entries[keys[0]];
      const planNo = Number(e0 && e0.planNumber != null ? e0.planNumber : keys[0]);
      // R9：路径必须从同店 publisher 身份规则显式派生（legacy profile 或 own
      // shop-identity.json），不依赖"当前还存在 state 文件"——简尚失败发生在任何创建之前。
      let pathsRes = null;
      try { pathsRes = deps.resolvePublisherPaths(shopLike, stateRoot || undefined); }
      catch (e) { return fail('recovery-release-path-resolution-threw:' + ((e && e.message) || e)); }
      if (!pathsRes || pathsRes.ok !== true || !pathsRes.paths
        || !pathsRes.paths.stateFile || !pathsRes.paths.attemptsFile) {
        return fail('recovery-release-state-paths-unavailable:' + ((pathsRes && pathsRes.reason) || 'unknown'));
      }
      // 账号绑定：配置账号优先；未配置时只接受 publisher 自身可证明的 identity，空值绝不放行。
      const resolvedAccount = cfgAccount !== null ? cfgAccount
        : (pathsRes.accountId != null && String(pathsRes.accountId) !== '' ? String(pathsRes.accountId) : null);
      if (!/^\d{6,24}$/.test(String(resolvedAccount || ''))) return fail('recovery-release-account-identity-unavailable');
      const sourceExtraFiles = Array.isArray(pathsRes.sourceExtraFiles) ? pathsRes.sourceExtraFiles.slice() : [];
      let proof = null;
      try {
        proof = deps.proveSchedulerRelease(ledgerFile,
          { stateFile: pathsRes.paths.stateFile, attemptsFile: pathsRes.paths.attemptsFile },
          { businessDate: String(businessDate), shop: shopId, planNumber: planNo,
            accountId: resolvedAccount, sourceExtraFiles });
      } catch (e) { return fail('recovery-release-proof-threw:' + ((e && e.message) || e)); }
      if (!proof || proof.ok !== true || !proof.proof) {
        return fail('recovery-release-proof-refused:' + ((proof && proof.reason) || 'unknown'));
      }
      // fresh 源字节 CAS：证明里的 sourceHash 必须仍是当前磁盘字节（含 published/identity/seed
      // 等独立发布面；路径集合与证明逐字相同）。
      let freshHash = null;
      try {
        freshHash = deps.currentSourceHash(proof.proof.sourceStateFile, proof.proof.sourceAttemptsFile,
          Array.isArray(proof.proof.sourceExtraFiles) ? proof.proof.sourceExtraFiles : []);
      } catch (_) { freshHash = null; }
      if (typeof freshHash !== 'string' || freshHash !== String(proof.proof.sourceHash)) {
        return fail('recovery-release-source-drift');
      }
      // 账本条目在异步证明期间不得漂移（逐字节复核后交 canonical 释放）。
      const recFresh = recOf(schedulerModule.loadLedger(ledgerFile));
      if (!recFresh || JSON.stringify(recFresh) !== JSON.stringify(rec0)) return fail('recovery-release-record-drift');
      return scheduler.releaseProvenRemainder(proof.proof);
    }

    // ── 形状 2：prepare-stopped:* unknown 条目 → 只读重证 + 锁内窄映射（不 import 值守）。
    const stopCandidates = Object.keys((rec0 && rec0.entries) || {})
      .filter((k) => {
        const e = rec0.entries[k];
        if (!e) return false;
        if (e.status === 'unknown' && String(e.reason || '').startsWith('prepare-stopped:')) return true;
        // R13：唯一精确已知的 exception reason（简尚 2026-10-25 20:07 实录）同样进入本支路：
        // 首份、从未冻结、attempts 原始缺失，耐久重证必然失败后由显式首份 NP 恢复窄收口；
        // 逐字整串比对，任何其它 scheduled-run-exception:* 不匹配、仍走 canonical F1 严格拒绝。
        if (e.status === 'unknown' && String(e.reason || '') === R13_EXPLICIT_NP_EXCEPTION_REASON) return true;
        // 幂等：本入口已窄映射过的条目再次调用时仍进入同一支路（只读重证 + 锁内 no-op），
        // 既不重复收口也不把已收口误当 canonical F1。
        return e.status === 'preparation-stopped' && e.recoveredBy === 'run-recovery-preparation-closure';
      });
    if (stopCandidates.length > 0) {
      if (typeof deps.reproveDurablePreparationStopped !== 'function' || typeof deps.currentSourceHash !== 'function'
        || typeof schedulerModule.acquireProcessLock !== 'function' || typeof schedulerModule.saveLedger !== 'function'
        || typeof schedulerModule.countSuccessEntries !== 'function') {
        return fail('recovery-reprove-capability-unavailable');
      }
      if (stopCandidates.length !== 1) return fail('recovery-stop-entry-not-unique:' + stopCandidates.length);
      const key = stopCandidates[0];
      const entry = rec0.entries[key];
      const planNo = Number(entry.planNumber != null ? entry.planNumber : key);
      if (entry.confirmationId != null || entry.planId != null || entry.manifestHash != null || entry.nonce != null || entry.frozen) {
        return fail('recovery-stop-entry-artifacts-present');
      }
      let reproof = await deps.reproveDurablePreparationStopped(shopLike, businessDate, { ...stateOverride, planNumber: planNo });
      // R12：首份、从未进入 publish 的 preparing + attempts **原始缺失**（简尚 2026-10-25 实录）
      // 无法被 reproveDurablePreparationStoppedClose 收口（active 仍 preparing、attempts 文件不存在）。
      // 仅当耐久重证未成立、份号确为第 1 份、且显式恢复能力可用时，走**显式正面证明恢复** helper
      // （同店 publisher 锁内 proveNoPublicationPreOpen + 独立发布面 + 源字节 CAS + 六零耐久事实，
      // active 翻 preparation-stopped，绝不创建/改写 attempts）。它返回与耐久重证同形的
      // preparationClosure/sourceHash，随后完全复用下面既有的锁内窄映射；任何拒绝/漂移保持原 unknown。
      const durableReproofFailed = !reproof || reproof.ok !== true || reproof.status !== 'preparationClosed' || !reproof.preparationClosure;
      if (durableReproofFailed && planNo === 1 && typeof deps.recoverFirstPreparingNoPublication === 'function') {
        const explicit = await deps.recoverFirstPreparingNoPublication(shopLike, businessDate,
          { ...stateOverride, planNumber: planNo, reason: String(entry.reason || ''), nowMs: opts.nowMs });
        if (explicit && explicit.ok === true && explicit.status === 'preparationClosed' && explicit.preparationClosure) {
          reproof = explicit;
        } else if (explicit && explicit.ok !== true) {
          return fail('recovery-reprove-refused:' + ((explicit.status || 'refused') + ':' + (explicit.reason || 'unknown')));
        }
      }
      if (!reproof || reproof.ok !== true || reproof.status !== 'preparationClosed' || !reproof.preparationClosure) {
        return fail('recovery-reprove-refused:' + ((reproof && (reproof.status + ':' + reproof.reason)) || 'unknown'));
      }
      const fact = reproof.preparationClosure;
      // 窄映射判据（与旧 watch-drill strictPreparationFact/preparationClosed 分支逐字对齐）：
      const origin = SCHEDULED_RUN_ORIGIN_RE.exec(String(fact.runId || ''));
      if (!origin || origin[1] !== String(businessDate)) return fail('recovery-stop-fact-run-id-invalid');
      if (fact.status !== 'preparationClosed' || fact.phase !== 'preparing') return fail('recovery-stop-fact-not-strict');
      if (!Number.isInteger(Number(fact.planNumber)) || Number(fact.planNumber) < 1 || Number(fact.planNumber) > 10) return fail('recovery-stop-fact-plan-invalid');
      if (String(fact.shop || '') !== String(shop.name)) return fail('recovery-stop-fact-shop-mismatch');
      const boundAccount = cfgAccount !== null ? cfgAccount : String(reproof.accountId != null ? reproof.accountId : (fact.accountId || ''));
      if (!/^\d{6,24}$/.test(boundAccount)) return fail('recovery-stop-account-identity-unavailable');
      if (String(fact.accountId || '') !== boundAccount) return fail('recovery-stop-fact-account-mismatch');
      if (String(fact.businessDate || '') !== String(businessDate)) return fail('recovery-stop-fact-date-mismatch');
      if (Number(fact.planNumber) !== planNo) return fail('recovery-stop-fact-plan-mismatch');
      if (typeof fact.reason !== 'string' || fact.reason.trim() === '' || fact.reason.length > 1024) return fail('recovery-stop-fact-reason-invalid');
      if (String(fact.reason) !== String(entry.reason || '')) return fail('recovery-stop-reason-not-verbatim');
      if (!strictZeroConsumptionProof(fact.zeroConsumptionProof)) return fail('recovery-stop-proof-not-strict');
      if (typeof reproof.runId === 'string' && String(reproof.runId) !== String(fact.runId)) return fail('recovery-stop-run-id-mismatch');
      // 持锁前 fresh 源字节 CAS（state + attempts + 独立发布/identity 面）。
      const casNow = () => {
        try {
          return deps.currentSourceHash(reproof.sourceStateFile, reproof.sourceAttemptsFile,
            Array.isArray(reproof.sourceExtraFiles) ? reproof.sourceExtraFiles : []);
        } catch (_) { return null; }
      };
      if (casNow() !== String(reproof.sourceHash || '')) return fail('recovery-stop-source-drift');
      // 排程持久锁内：fresh 重读账本 + 记录字节复核 + 窄映射 + 再取源哈希仍相同，才落盘。
      const lockFile = ledgerFile + '.lock';
      const lock = schedulerModule.acquireProcessLock(lockFile, nowMs, 30 * 60 * 1000);
      if (!lock || lock.held !== true) return fail('recovery-stop-scheduler-lock-busy');
      try {
        const ledger = schedulerModule.loadLedger(ledgerFile);
        const rec = recOf(ledger);
        if (!rec || JSON.stringify(rec) !== JSON.stringify(rec0)) return fail('recovery-stop-record-drift');
        const e = rec.entries && rec.entries[key];
        if (!e) return fail('recovery-stop-entry-missing');
        // 幂等收敛：同一 runId + 同一原 reason 已收口 → 不再改写。
        if (e.status === 'preparation-stopped' && String(e.preparationRunId || '') === String(fact.runId)
          && String(e.reason || '') === String(fact.reason)) {
          return { ok: true, released: false, idempotent: true, planNumber: planNo, reason: 'already-closed' };
        }
        // 只把“该份从未消费”的那一条 unknown 换为 preparation-stopped；其余条目纹丝不动。
        if (e.status !== 'unknown' || String(e.reason || '') !== String(fact.reason)) {
          return fail('recovery-stop-entry-not-applicable:' + e.status);
        }
        if (typeof schedulerModule.hasInProgress === 'function' && schedulerModule.hasInProgress(rec)) {
          return fail('recovery-stop-in-progress-present');
        }
        if (casNow() !== String(reproof.sourceHash || '')) return fail('recovery-stop-source-drift-under-lock');
        e.planNumber = planNo; e.status = 'preparation-stopped';
        e.reason = String(fact.reason); e.preparationRunId = String(fact.runId);
        e.closedAt = new Date(nowMs()).toISOString(); e.recoveredBy = 'run-recovery-preparation-closure';
        rec.plans = schedulerModule.countSuccessEntries(rec);
        const limit = typeof schedulerModule.resolveShopPlansPerDay === 'function'
          ? schedulerModule.resolveShopPlansPerDay(shop, (c.value && c.value.plansPerShopPerDay) || 3) : 3;
        const unresolvedLeft = Object.keys(rec.entries).some((k2) => ['unknown', 'in-progress', 'failed'].includes(rec.entries[k2].status));
        if (!unresolvedLeft && (String(rec.status) === 'unknown' || String(rec.status) === 'blocked')) {
          rec.status = rec.plans >= limit ? 'success' : (rec.plans > 0 ? 'partial' : 'pending');
          rec.error = null;
        }
        rec.lastAt = new Date(nowMs()).toISOString();
        schedulerModule.saveLedger(ledgerFile, ledger);
        return { ok: true, released: true, planNumber: planNo, runId: String(fact.runId), rec, method: 'preparation-closed-narrow-mapping' };
      } finally {
        try { if (typeof schedulerModule.releaseProcessLock === 'function') schedulerModule.releaseProcessLock(lockFile, lock.token); } catch (_) { /* 释放失败交陈旧锁回收 */ }
      }
    }

    // ── 形状 2b（R16）：唯一 unknown 且 reason 逐字 R16_READBACK_CONVERGENCE_REASON，且 publisher
    // 侧同店/同日/同份号已被既有**只读回读恢复**耐久升格（active=published-success +
    // recoveredBy=scheduled-readback-recovery + authorizedBy=recurring-user-policy + 同 CID
    // initial/final 双 success + 日成功计划与独立发布面同一真实唯一 planId）→ 纯本地把**这一条**
    // 账本条目收敛为 success + 真实 planId（来源记为已回读恢复），rec.plans 重新按 entries 计数、
    // 状态收敛 partial 并清对应旧 error，让原 scheduler 只补剩余份数。绝不打开浏览器、绝不调用
    // runPlan/广告接口、绝不伪造零发布、绝不重放、绝不凭外部 count/rec.plans 判成功；旧 schema
    // 不携带 runId/CID/manifest 字段是合法的（携带则必须与耐久事实逐字一致）；任何证明不齐/
    // 跨 CID/其它未决/源或账本漂移/锁忙一律保持原 unknown。既有零发布路径（形状 1/2/3）全部保留。
    const readbackCandidates = Object.keys((rec0 && rec0.entries) || {}).filter((k) => {
      const e = rec0.entries[k];
      if (!e) return false;
      if (e.status === 'unknown' && String(e.reason || '') === R16_READBACK_CONVERGENCE_REASON) return true;
      // 幂等：本支路已收敛过的条目再次调用时仍进入同一支路（只读重证 + 锁内 no-op）。
      return e.status === 'success' && e.recoveredBy === 'scheduled-readback-recovery'
        && String(e.convergedFrom || '') === R16_READBACK_CONVERGENCE_REASON;
    });
    if (readbackCandidates.length > 0) {
      if (typeof deps.resolvePublisherPaths !== 'function' || typeof deps.currentSourceHash !== 'function'
        || typeof schedulerModule.acquireProcessLock !== 'function' || typeof schedulerModule.saveLedger !== 'function'
        || typeof schedulerModule.countSuccessEntries !== 'function') {
        return fail('recovery-readback-capability-unavailable');
      }
      if (readbackCandidates.length !== 1) return fail('recovery-readback-entry-not-unique:' + readbackCandidates.length);
      const key = readbackCandidates[0];
      const entry = rec0.entries[key];
      const planNo = Number(entry.planNumber != null ? entry.planNumber : key);
      const limit = typeof schedulerModule.resolveShopPlansPerDay === 'function'
        ? schedulerModule.resolveShopPlansPerDay(shop, (c.value && c.value.plansPerShopPerDay) || 3) : 3;
      if (!Number.isInteger(planNo) || planNo < 1 || planNo > limit) return fail('recovery-readback-plan-number-invalid');
      const alreadyConverged = entry.status === 'success';
      // 收敛前记录形状：unknown 记录、除本条外只允许既有 success 条目（原样保留计数），
      // 任何其它在途/未知/失败条目一律拒绝（那属于其它支路或其它事实）。
      if (!alreadyConverged && String(rec0.status) !== 'unknown') return fail('recovery-readback-record-status-not-unknown:' + rec0.status);
      for (const k2 of Object.keys((rec0 && rec0.entries) || {})) {
        if (String(k2) === String(key)) continue;
        if (String(((rec0.entries || {})[k2] || {}).status) !== 'success') return fail('recovery-readback-other-entry-unresolved:' + k2);
      }
      if (typeof schedulerModule.hasInProgress === 'function' && schedulerModule.hasInProgress(rec0)) {
        return fail('recovery-readback-in-progress-present');
      }
      if (!alreadyConverged && (entry.nonce != null || entry.frozen || rec0.confirmationId != null || rec0.frozen || rec0.nonce != null)) {
        return fail('recovery-readback-entry-artifacts-present');
      }
      // 路径按同店 publisher 身份规则显式派生（legacy profile 或 own shop-identity.json），绝不猜路径。
      let pathsRes = null;
      try { pathsRes = deps.resolvePublisherPaths(shopLike, stateRoot || undefined); }
      catch (e) { return fail('recovery-readback-path-resolution-threw:' + ((e && e.message) || e)); }
      if (!pathsRes || pathsRes.ok !== true || !pathsRes.paths
        || !pathsRes.paths.stateFile || !pathsRes.paths.attemptsFile || !pathsRes.paths.publishedFile) {
        return fail('recovery-readback-state-paths-unavailable:' + ((pathsRes && pathsRes.reason) || 'unknown'));
      }
      // 账号绑定：配置账号优先；未配置时只接受 publisher 自身可证明 identity，空值绝不放行。
      const boundAccount = cfgAccount !== null ? cfgAccount
        : (pathsRes.accountId != null && String(pathsRes.accountId) !== '' ? String(pathsRes.accountId) : null);
      if (!/^\d{6,24}$/.test(String(boundAccount || ''))) return fail('recovery-readback-account-identity-unavailable');
      const sourceExtraFiles = Array.isArray(pathsRes.sourceExtraFiles) ? pathsRes.sourceExtraFiles.slice() : [];
      // 源字节 CAS（state + attempts + published/identity/必要 seed 面）：读证明前取基线，
      // 读证明后与锁内各复核一次；任何漂移拒绝。
      const casNow = () => {
        try { return deps.currentSourceHash(pathsRes.paths.stateFile, pathsRes.paths.attemptsFile, sourceExtraFiles); }
        catch (_) { return null; }
      };
      const hashBefore = casNow();
      if (typeof hashBefore !== 'string' || hashBefore === '') return fail('recovery-readback-source-unreadable');
      let wfMod = null;
      try { wfMod = require(path.join(RUNNER_DIR, 'plan-workflow.cjs')); } catch (_) { wfMod = null; }
      if (!wfMod || typeof wfMod.manifestHash !== 'function' || typeof wfMod.hasUnresolvedPlan !== 'function'
        || typeof wfMod.loadPublishedStore !== 'function') return fail('recovery-readback-workflow-capability-missing');
      const readJsonFile = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
      let stateRaw = null;
      let attemptsRaw = null;
      try { stateRaw = readJsonFile(pathsRes.paths.stateFile); } catch (_) { return fail('recovery-readback-state-unreadable'); }
      try { attemptsRaw = readJsonFile(pathsRes.paths.attemptsFile); } catch (_) { return fail('recovery-readback-attempts-unreadable'); }
      if (!fs.existsSync(pathsRes.paths.publishedFile)) return fail('recovery-readback-published-missing');
      let publishedStore = null;
      try { publishedStore = wfMod.loadPublishedStore(pathsRes.paths.publishedFile, pathsRes.paths.seedFile || null, boundAccount); }
      catch (_) { return fail('recovery-readback-published-unreadable'); }
      // ── 日状态面：唯一 published-success active（回读恢复升格）+ 严格冻结清单重验 ──
      if (!stateRaw || typeof stateRaw !== 'object' || Array.isArray(stateRaw)) return fail('recovery-readback-state-malformed');
      if (String(stateRaw.businessDate || '') !== String(businessDate)) return fail('recovery-readback-state-date-mismatch');
      if (stateRaw.shop != null && String(stateRaw.shop) !== String(shop.name)) return fail('recovery-readback-state-shop-conflict');
      if (stateRaw.accountId != null && String(stateRaw.accountId) !== String(boundAccount)) return fail('recovery-readback-state-account-conflict');
      if (wfMod.hasUnresolvedPlan(stateRaw)) return fail('recovery-readback-state-unresolved-present');
      const active = stateRaw.active;
      if (!active || typeof active !== 'object' || Array.isArray(active)) return fail('recovery-readback-active-missing');
      if (String(active.status) !== 'published-success') return fail('recovery-readback-active-not-published-success:' + active.status);
      if (Number(active.planNumber) !== planNo) return fail('recovery-readback-active-plan-mismatch');
      if (String(active.recoveredBy || '') !== 'scheduled-readback-recovery') return fail('recovery-readback-active-not-readback-recovered');
      if (String(active.authorizedBy || '') !== 'recurring-user-policy') return fail('recovery-readback-active-authorization-mismatch');
      if (active.actionTaken !== false) return fail('recovery-readback-active-action-taken');
      const planId = String(active.planId || '');
      if (!/^\d{12,20}$/.test(planId)) return fail('recovery-readback-plan-id-invalid');
      const frozen = active.frozen;
      if (!frozen || typeof frozen !== 'object' || Array.isArray(frozen)) return fail('recovery-readback-frozen-missing');
      const cid = typeof frozen.confirmationId === 'string' ? frozen.confirmationId.trim() : '';
      if (cid === '') return fail('recovery-readback-confirmation-id-missing');
      const manifestHash = String(frozen.manifestHash || '').toLowerCase();
      if (!/^[a-f0-9]{64}$/.test(manifestHash)) return fail('recovery-readback-manifest-invalid');
      let manifestOk = false;
      try { manifestOk = String(wfMod.manifestHash(frozen)).toLowerCase() === manifestHash; } catch (_) { manifestOk = false; }
      if (!manifestOk) return fail('recovery-readback-manifest-hash-mismatch');
      if (String(frozen.businessDate || '') !== String(businessDate)) return fail('recovery-readback-frozen-date-mismatch');
      if (Number(frozen.planNumber) !== planNo) return fail('recovery-readback-frozen-plan-mismatch');
      if (String(frozen.accountId || '') !== String(boundAccount)) return fail('recovery-readback-frozen-account-mismatch');
      if (typeof frozen.planName !== 'string' || frozen.planName.trim() === '') return fail('recovery-readback-frozen-plan-name-missing');
      const rbOrigin = SCHEDULED_RUN_ORIGIN_RE.exec(String(frozen.runId || ''));
      if (!rbOrigin || rbOrigin[1] !== String(businessDate)) return fail('recovery-readback-frozen-run-id-invalid');
      // 已批准数值口径：ROI=配置 targetRoi（缺省合法默认 15）、预算=独立配置 dailyBudget、
      // 商品数=店配置 productsPerPlan（缺省 30）；任一不符即拒绝，绝不拿当前设置顶替。
      const expectedRoi = typeof shop.targetRoi === 'number' && shop.targetRoi > 0 ? shop.targetRoi : 15;
      if (Number(frozen.roi) !== expectedRoi) return fail('recovery-readback-frozen-roi-mismatch');
      const expectedBudget = Number(c.value.dailyBudget);
      if (!(Number.isFinite(expectedBudget) && expectedBudget > 0) || Number(frozen.dailyBudget) !== expectedBudget) {
        return fail('recovery-readback-frozen-budget-mismatch');
      }
      const expectedProducts = Number.isInteger(shop.productsPerPlan) && shop.productsPerPlan > 0
        ? shop.productsPerPlan : Number((wfMod.BUSINESS && wfMod.BUSINESS.productsPerPlan) || 30);
      const productIds = Array.isArray(frozen.productIds) ? frozen.productIds.map(String) : [];
      if (productIds.length !== expectedProducts || new Set(productIds).size !== expectedProducts) {
        return fail('recovery-readback-frozen-products-invalid');
      }
      // 手动原生 UI 独立事实面必须为空：任何一条都是另一发布面 → 拒绝。
      if ((Array.isArray(stateRaw.manualUiPublicationFacts) ? stateRaw.manualUiPublicationFacts : []).length !== 0) {
        return fail('recovery-readback-manual-facts-present');
      }
      // dayState.plans：全部 success、份号唯一；本份号恰好一条且 planId/manifest 与 active 逐字一致；
      // 其它 success 计划必须与账本既有 success 条目一一对应（planId 携带则一致），绝不多算。
      const ledgerSuccessByPlan = new Map();
      for (const k2 of Object.keys((rec0 && rec0.entries) || {})) {
        const e2 = rec0.entries[k2];
        if (e2 && e2.status === 'success') ledgerSuccessByPlan.set(Number(e2.planNumber != null ? e2.planNumber : k2), e2);
      }
      if (!alreadyConverged && ledgerSuccessByPlan.has(planNo)) return fail('recovery-readback-plan-already-success-in-ledger');
      const dayPlans = Array.isArray(stateRaw.plans) ? stateRaw.plans : [];
      const daySuccess = dayPlans.filter((p) => p && p.status === 'success');
      if (dayPlans.length !== daySuccess.length) return fail('recovery-readback-day-plans-not-all-success');
      if (daySuccess.length !== ledgerSuccessByPlan.size + (alreadyConverged ? 0 : 1)) {
        return fail('recovery-readback-day-success-count-mismatch:' + daySuccess.length);
      }
      const seenPlanNumbers = new Set();
      let matchedCurrent = false;
      for (const p of daySuccess) {
        const n = Number(p && p.planNumber);
        if (!Number.isInteger(n) || n < 1 || seenPlanNumbers.has(n)) return fail('recovery-readback-day-plan-number-invalid');
        seenPlanNumbers.add(n);
        if (n === planNo) {
          matchedCurrent = true;
          if (String(p.planId || '') !== planId) return fail('recovery-readback-day-plan-id-mismatch');
          if (String(p.manifestHash || '').toLowerCase() !== manifestHash) return fail('recovery-readback-day-plan-manifest-mismatch');
          continue;
        }
        const le = ledgerSuccessByPlan.get(n);
        if (!le) return fail('recovery-readback-day-plan-without-ledger-success:' + n);
        if (le.planId != null && String(le.planId) !== String(p.planId || '')) return fail('recovery-readback-day-plan-id-mismatch:' + n);
      }
      if (!matchedCurrent) return fail('recovery-readback-day-success-missing-for-plan');
      if (stateRaw.firstPublishedPlan != null
        && String((stateRaw.firstPublishedPlan || {}).planId || '') !== planId) return fail('recovery-readback-first-plan-mismatch');
      // ── attempts 面：同 CID initial 与 final 都必须真实存在且耐久 success；三表全量扫描，
      // 任何跨 CID/未决/失败/异日消费一律拒绝（绝不只数条数）。──
      if (!attemptsRaw || typeof attemptsRaw !== 'object' || Array.isArray(attemptsRaw)) return fail('recovery-readback-attempts-malformed');
      const consumedTable = attemptsRaw.consumed;
      if (!consumedTable || typeof consumedTable !== 'object' || Array.isArray(consumedTable)) {
        return fail('recovery-readback-attempts-consumed-missing');
      }
      const attemptsTables = {
        consumed: consumedTable,
        finalConsumed: attemptsRaw.finalConsumed == null ? {} : attemptsRaw.finalConsumed,
        reopenConsumed: attemptsRaw.reopenConsumed == null ? {} : attemptsRaw.reopenConsumed,
      };
      for (const tName of ['finalConsumed', 'reopenConsumed']) {
        const t = attemptsTables[tName];
        if (typeof t !== 'object' || Array.isArray(t)) return fail('recovery-readback-attempts-malformed');
      }
      const agreeIdentity = (r, requireCore) => {
        if (!r || typeof r !== 'object' || Array.isArray(r)) return false;
        if (r.status !== 'success') return false;
        if (r.runId != null && String(r.runId) !== String(frozen.runId)) return false;
        if (r.businessDate != null && String(r.businessDate) !== String(businessDate)) return false;
        if (r.planNumber != null && Number(r.planNumber) !== planNo) return false;
        if (r.manifestHash != null && String(r.manifestHash).toLowerCase() !== manifestHash) return false;
        if (r.accountId != null && String(r.accountId) !== String(boundAccount)) return false;
        if (r.planName != null && String(r.planName) !== String(frozen.planName)) return false;
        if (requireCore && (typeof r.runId !== 'string' || r.runId !== String(frozen.runId)
          || typeof r.businessDate !== 'string' || r.businessDate !== String(businessDate)
          || Number(r.planNumber) !== planNo
          || typeof r.manifestHash !== 'string' || String(r.manifestHash).toLowerCase() !== manifestHash)) return false;
        return true;
      };
      if (!agreeIdentity(consumedTable[cid], true)) return fail('recovery-readback-initial-consumption-not-proven');
      if (!agreeIdentity(attemptsTables.finalConsumed[cid], false)) return fail('recovery-readback-final-consumption-not-proven');
      for (const mapName of ['consumed', 'finalConsumed', 'reopenConsumed']) {
        for (const recCid of Object.keys(attemptsTables[mapName])) {
          if (String(recCid) !== cid) return fail('recovery-readback-cross-cid-consumption:' + mapName);
          if (mapName === 'reopenConsumed') return fail('recovery-readback-reopen-consumption-present');
          if (!agreeIdentity(attemptsTables[mapName][recCid], mapName === 'consumed')) {
            return fail('recovery-readback-consumption-not-sole-success:' + mapName);
          }
        }
      }
      // ── 独立发布事实面：published-products.json 必须真实存在，且同 planId 全局唯一、
      // 同日唯一、日期一致，冻结 30 商品 ID 全部在独立发布 IDs 中。──
      const pubPlans = Array.isArray(publishedStore.plans) ? publishedStore.plans : [];
      const sameId = pubPlans.filter((p) => String((p && p.planId) || '') === planId);
      if (sameId.length !== 1) return fail('recovery-readback-published-plan-not-unique:' + sameId.length);
      if (String((sameId[0] && sameId[0].date) || '') !== String(businessDate)) return fail('recovery-readback-published-date-mismatch');
      const sameDay = pubPlans.filter((p) => String((p && p.date) || '') === String(businessDate));
      if (sameDay.length !== 1) return fail('recovery-readback-published-day-not-unique:' + sameDay.length);
      const publishedIdSet = new Set((Array.isArray(publishedStore.publishedIds) ? publishedStore.publishedIds : []).map(String));
      if (!productIds.every((id) => publishedIdSet.has(id))) return fail('recovery-readback-published-products-missing');
      // 读证明期间源字节与账本原文都不得漂移。
      if (casNow() !== hashBefore) return fail('recovery-readback-source-drift');
      const recFresh = recOf(schedulerModule.loadLedger(ledgerFile));
      if (!recFresh || JSON.stringify(recFresh) !== JSON.stringify(rec0)) return fail('recovery-readback-record-drift');
      // 旧 schema 适配：条目不携带 runId/CID/manifest/planId 是合法的；携带则必须逐字一致。
      if (entry.runId != null && String(entry.runId) !== String(frozen.runId)) return fail('recovery-readback-entry-run-id-mismatch');
      if (entry.confirmationId != null && String(entry.confirmationId) !== cid) return fail('recovery-readback-entry-confirmation-mismatch');
      if (entry.manifestHash != null && String(entry.manifestHash).toLowerCase() !== manifestHash) return fail('recovery-readback-entry-manifest-mismatch');
      if (entry.planId != null && String(entry.planId) !== planId) return fail('recovery-readback-entry-plan-id-mismatch');
      // 排程持久锁内：fresh 重读账本 + 记录字节复核 + 源字节再验证，才允许改**这一条**。
      const rbLockFile = ledgerFile + '.lock';
      const rbLock = schedulerModule.acquireProcessLock(rbLockFile, nowMs, 30 * 60 * 1000);
      if (!rbLock || rbLock.held !== true) return fail('recovery-readback-scheduler-lock-busy');
      try {
        const ledger = schedulerModule.loadLedger(ledgerFile);
        const rec = recOf(ledger);
        if (!rec || JSON.stringify(rec) !== JSON.stringify(rec0)) return fail('recovery-readback-record-drift-under-lock');
        const e = rec.entries && rec.entries[key];
        if (!e) return fail('recovery-readback-entry-missing');
        // 幂等收敛：同一条已按同一耐久事实收敛 → 只读返回，零重复写。
        if (e.status === 'success' && e.recoveredBy === 'scheduled-readback-recovery'
          && String(e.convergedFrom || '') === R16_READBACK_CONVERGENCE_REASON && String(e.planId || '') === planId) {
          return { ok: true, released: false, idempotent: true, planNumber: planNo, planId, reason: 'already-converged' };
        }
        if (e.status !== 'unknown' || String(e.reason || '') !== R16_READBACK_CONVERGENCE_REASON) {
          return fail('recovery-readback-entry-not-applicable:' + e.status);
        }
        if (typeof schedulerModule.hasInProgress === 'function' && schedulerModule.hasInProgress(rec)) {
          return fail('recovery-readback-in-progress-under-lock');
        }
        if (casNow() !== hashBefore) return fail('recovery-readback-source-drift-under-lock');
        e.planNumber = planNo;
        e.status = 'success';
        e.planId = planId;
        e.confirmationId = cid;
        e.manifestHash = manifestHash;
        e.recoveredBy = 'scheduled-readback-recovery';
        e.convergedFrom = R16_READBACK_CONVERGENCE_REASON;
        e.convergedAt = new Date(nowMs()).toISOString();
        rec.plans = schedulerModule.countSuccessEntries(rec);
        const rbUnresolvedLeft = Object.keys(rec.entries).some((k2) => ['unknown', 'in-progress', 'failed'].includes(rec.entries[k2].status));
        if (!rbUnresolvedLeft && (String(rec.status) === 'unknown' || String(rec.status) === 'blocked')) {
          rec.status = rec.plans >= limit ? 'success' : (rec.plans > 0 ? 'partial' : 'pending');
          rec.error = null;
        }
        rec.lastAt = new Date(nowMs()).toISOString();
        schedulerModule.saveLedger(ledgerFile, ledger);
        return {
          ok: true, released: true, planNumber: planNo, planId, confirmationId: cid, manifestHash,
          rec, method: 'readback-success-ledger-convergence',
        };
      } finally {
        try { if (typeof schedulerModule.releaseProcessLock === 'function') schedulerModule.releaseProcessLock(rbLockFile, rbLock.token); } catch (_) { /* 释放失败交陈旧锁回收 */ }
      }
    }

    // ── 形状 3：canonical F1（R7 既有路径）。
    if (typeof deps.recoverLocalPreparation !== 'function') return fail('recovery-capability-unavailable');
    const local = await deps.recoverLocalPreparation(shopLike, businessDate, { ...stateOverride });
    if (!local || local.ok !== true || local.status !== 'preparationClosed' || !local.preparationClosure) {
      return fail('recovery-local-not-closed:' + ((local && (local.status + ':' + local.reason)) || 'unknown'));
    }
    const fact = local.preparationClosure;
    if (String(fact.shop || '') !== String(shop.name)) return fail('recovery-fact-shop-mismatch');
    if (String(fact.businessDate || '') !== String(businessDate)) return fail('recovery-fact-date-mismatch');
    const ledger = schedulerModule.loadLedger(ledgerFile);
    const rec = recOf(ledger);
    const e = rec && rec.entries && rec.entries[String(fact.planNumber)];
    if (!e) return fail('recovery-no-current-entry');
    // canonical F1 只接受 unknown 记录 + in-progress/unknown 条目；其它形状如实拒绝。
    if (String(rec.status) !== 'unknown' || (String(e.status) !== 'in-progress' && String(e.status) !== 'unknown')) {
      return fail('recovery-entry-not-canonical-releasable:' + rec.status + '/' + e.status);
    }
    const entryStatus = String(e.status);
    const startedAt = typeof e.startedAt === 'string' ? e.startedAt : null;
    // R9：账号必须绑定到本店已配置/已解析的可信 ID；六字段零消费证明之外不接受空账号。
    const boundAccount = cfgAccount !== null ? cfgAccount
      : (local.accountId != null && String(local.accountId) !== '' ? String(local.accountId)
        : (fact.accountId != null ? String(fact.accountId) : ''));
    if (!/^\d{6,24}$/.test(boundAccount)) return fail('recovery-account-identity-unavailable');
    if (String(fact.accountId || '') !== boundAccount) return fail('recovery-account-mismatch');
    // R9：fresh 源字节 CAS（state + attempts + published/identity 面）。证明写完到 canonical
    // 映射之间任何字节漂移都拒绝；锁内钩子会再用同一路径集合复核一次。
    if (typeof deps.currentSourceHash !== 'function') return fail('recovery-source-verify-unavailable');
    let freshSource = null;
    try {
      freshSource = deps.currentSourceHash(local.sourceStateFile, local.sourceAttemptsFile,
        Array.isArray(local.sourceExtraFiles) ? local.sourceExtraFiles : []);
    } catch (_) { freshSource = null; }
    if (typeof freshSource !== 'string' || freshSource !== String(local.sourceHash || '')) {
      return fail('recovery-source-drift');
    }
    const proof = {
      status: 'scheduler-release-prepublication', method: 'scheduler-release-prepublication',
      businessDate: String(businessDate), shop: shopId, planNumber: Number(fact.planNumber),
      accountId: boundAccount,
      recStatus: 'unknown', entryStatus, entryStartedAt: startedAt,
      entryReasonHash: sha256Hex(e.reason), entryProvenanceMethod: 'local-preparation-closed',
      // 锁内新鲜度复核路径集合（与证明/预检完全相同），供 verifyReleaseSourceProof 重算。
      sourceHash: String(local.sourceHash || ''),
      sourceStateFile: local.sourceStateFile,
      sourceAttemptsFile: local.sourceAttemptsFile,
      sourceExtraFiles: Array.isArray(local.sourceExtraFiles) ? local.sourceExtraFiles.slice() : [],
      preparationClosureProof: {
        method: 'local-preparation-closed', businessDate: String(businessDate), shop: shopId,
        publisherShop: String(shop.name),
        accountId: boundAccount,
        planNumber: Number(fact.planNumber), runId: String(fact.runId || local.runId || ''),
        sourceHash: String(local.sourceHash || ''), reason: String(fact.reason || local.reason || ''),
        zeroConsumptionProof: fact.zeroConsumptionProof, entryStartedAt: startedAt,
      },
    };
    return scheduler.releaseProvenRemainder(proof);
  }

  return {
    scheduler,
    tick: () => scheduler.tick(),
    ledgerFile,
    configFile,
    adapterRoot,
    openShop,
    stateRoot: stateRoot || null,
    schedulerPath,
    recoverShopDay,
  };
}

/** --check：纯校验零写入零浏览器。只读配置、解析排程器路径、核对 run-plans 导出存在。 */
function runCheck(o = {}) {
  const opts = o || {};
  const configFile = opts.configFile || DEFAULT_CONFIG_FILE;
  const cfg = readDailyConfig(configFile);
  const reasons = cfg.reasons.slice();
  // --check 必须准确报"未配置"：adapterRoot 与两个 Cookie 路径任一为空占位/相对路径，
  // 都不允许 ok:true（真实运行会回落 guard/cookies，正是要拦下的形态）。
  const adapterRootRaw = (cfg.ok && cfg.value.adapterRoot) || opts.adapterRoot || '';
  const adapterRootConfigured = typeof adapterRootRaw === 'string' && adapterRootRaw.trim() !== '' && path.isAbsolute(adapterRootRaw.trim());
  if (cfg.ok && !adapterRootConfigured) reasons.push('adapterRoot 未配置（需非空绝对路径）');
  const loginCfg = cfg.ok ? cfg.value.login : null;
  const loginConfigured = !!(loginCfg && typeof loginCfg.cookieWorkDir === 'string' && loginCfg.cookieWorkDir.trim() !== '' && path.isAbsolute(loginCfg.cookieWorkDir.trim())
    && typeof loginCfg.cookieSourceDir === 'string' && loginCfg.cookieSourceDir.trim() !== '' && path.isAbsolute(loginCfg.cookieSourceDir.trim()));
  if (cfg.ok && !loginConfigured) reasons.push('login.cookieWorkDir/cookieSourceDir 未配置（需非空绝对路径；不得回落值守 Cookie）');
  const adapterRoot = adapterRootConfigured ? adapterRootRaw.trim() : '';
  const schedulerPath = adapterRoot ? resolveSchedulerPath(adapterRoot, opts.schedulerPath) : null;
  let schedulerExportsOk = false;
  if (schedulerPath) {
    try { schedulerExportsOk = typeof require(schedulerPath).createScheduler === 'function'; }
    catch (_) { schedulerExportsOk = false; }
  }
  let publisherExportsOk = false;
  const missing = [];
  try {
    const p = require(path.join(RUNNER_DIR, 'run-plans.cjs'));
    publisherExportsOk = ['runScheduledPlan', 'readDaySuccessForShop', 'discoverShopAccountByLiveSession']
      .every((k) => { const okFn = typeof p[k] === 'function'; if (!okFn) missing.push(k); return okFn; });
  } catch (_) { publisherExportsOk = false; }
  const shops = cfg.ok ? cfg.value.shops : [];
  const summary = {
    ok: cfg.ok && adapterRootConfigured && loginConfigured && !!schedulerPath && schedulerExportsOk && publisherExportsOk,
    config: cfg.ok ? {
      enabled: cfg.value.enabled, autoConfirm: cfg.value.autoConfirm, time: cfg.value.time,
      plansPerShopPerDay: cfg.value.plansPerShopPerDay, dailyBudget: cfg.value.dailyBudget,
      shops: shops.map((s) => ({ id: s.id, name: s.name, deleted: s.deleted === true, targetRoi: s.targetRoi != null ? s.targetRoi : 15, accountId: s.accountId != null ? 'configured' : null })),
    } : null,
    reasons,
    adapterRootConfigured,
    loginConfigured,
    schedulerPath: schedulerPath || null,
    schedulerExportsOk,
    publisherExportsOk,
    publisherMissingExports: missing,
  };
  return summary;
}

function usage() {
  return [
    '用法: node daily-plan-runner.cjs --check | --run [--config <file>] [--data-dir <dir>] [--adapter-root <dir>] [--state-root <dir>] [--scheduler-path <file>]',
    '  --check  只读校验配置/排程器/发布导出，零写入零浏览器',
    '  --run    执行一次排程 tick 后自然退出（无常驻服务/定时器/端口）',
  ].join('\n');
}

async function main(argv) {
  const args = (argv || process.argv.slice(2));
  const flag = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check' || args[i] === '--run') flag.mode = args[i].slice(2);
    else if (args[i] === '--config') flag.configFile = args[++i];
    else if (args[i] === '--data-dir') flag.dataDir = args[++i];
    else if (args[i] === '--adapter-root') flag.adapterRoot = args[++i];
    else if (args[i] === '--state-root') flag.stateRoot = args[++i];
    else if (args[i] === '--scheduler-path') flag.schedulerPath = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') { console.log(usage()); return 0; }
    else { console.error('未知参数: ' + args[i] + '\n' + usage()); return 2; }
  }
  if (!flag.mode) { console.error(usage()); return 2; }
  const common = {
    configFile: flag.configFile, dataDir: flag.dataDir,
    adapterRoot: flag.adapterRoot, stateRoot: flag.stateRoot, schedulerPath: flag.schedulerPath,
  };
  const clean = (x) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined));
  if (flag.mode === 'check') {
    const r = runCheck(clean(common));
    console.log(JSON.stringify(r, null, 2));
    return r.ok ? 0 : 1;
  }
  // --run：单次 tick；不 start()，无 interval 定时器，事件循环清空后自然退出。
  const runner = createDailyRunner(clean(common));
  const result = await runner.tick();
  console.log(JSON.stringify({ ledgerFile: runner.ledgerFile, result }, null, 2));
  return 0;
}

module.exports = { validateDailyConfig, readDailyConfig, resolveSchedulerPath, createDailyRunner, runCheck, main, DEFAULT_CONFIG_FILE, DEFAULT_DATA_DIR };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch((e) => {
    console.error('daily-plan-runner 异常: ' + ((e && e.message) || e));
    process.exitCode = 1;
  });
}
