'use strict';

/**
 * 登录会话管理：Cookie 的精确加载与店铺身份绑定。
 *
 * 复用链（已核实，来自电商助手项目，只读参考未改动）：
 * - Cookie 文件格式：Playwright context.cookies() 的 JSON 数组
 *   （字段 name/value/domain/path/expires/httpOnly/secure/sameSite），
 *   由 bill-manager/login-shop.js 扫码后保存，bill-manager/douyin-shop-analyzer.js
 *   的 loadCookiesFromPath() 用 context.addCookies() 加载。
 * - 店铺列表来源：cookies 目录下的 *.json 文件名（bill-manager/server.js getShops()）。
 * - 登录有效性判定：访问 https://fxg.jinritemai.com/ffa/mshop/homepage/index 后
 *   URL 是否包含 "fxg.jinritemai.com/ffa/mshop/homepage"
 *   （douyin-shop-analyzer.js Step1 登录检测同款逻辑）。
 *
 * 安全约定：本模块绝不打印/返回 cookie 值；对外只暴露元信息（域名、过期时间）。
 *
 * 精确店铺规则（强制）：
 * - 必须由配置显式指定 cookieFile（不含 .json 的文件名）；
 * - 不做模糊匹配、不默认取第一个文件；找不到即报错停机。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AuthError } = require('../lib/errors');
const { safeCookieBaseName, ensureWorkCopy, validateCookieArray } = require('./cookie-workcopy');
// AD-COOKIE-FOUR-TIER-20261019-F1：恢复链身份验证复用既有严格语义探针/判定（无循环依赖：
// session-cookie-checkpoint 只依赖 cookie-writeback）。
const {
  probeDoudianShopIdentityInPage, decideDoudianIdentity, isVerifiedDoudianIdentityUrl,
} = require('./session-cookie-checkpoint');
// AD-WATCHDOG-COOKIE-VERIFY-20261020-F1：恢复提升最终已验证集合时复用写入器同口径的
// 确定性序列化与"最终集合相对候选的关键 auth 双保险"（无循环依赖：cookie-writeback 不引用 session）。
const { finalPreservesCandidateAuth, serializeCookies, sameCookieSet } = require('./cookie-writeback');
// 独立候选验证复用主链**同一份**有界被动收敛语义（45s/3s/严格首页判定/双保险限次）：
// 已保存 Cookie 装入全新上下文后自动 SSO 约 30s 才落首页（根证
// reference-readonly-session.json），旧的固定 20s/2s 轮询会把"仍在中转"误判成失效。
// 语义本体在 lib/settle-policy（叶子模块；qianchuan-reader 也引用它，反向 require 会成环）。
const {
  waitForDoudianHomepageSettled, settlePacing, sanitizePositiveMs,
} = require('../lib/settle-policy');

const PROJECT_COOKIES_DIR = path.join(__dirname, '..', '..', 'cookies');

/**
 * 测试上下文判定（AD-WATCHDOG-TEST-ISOLATION-20261020 的 fail-closed 隔离边界）。
 *
 * 缺陷背景：离线 Node 测试未提供隔离工作根时，resolveWorkDir 会静默回落到生产
 * 项目 cookies/，导致假 Cookie 被写入生产目录、再被自动发现持久化进生产配置。
 *
 * 判定只依赖测试运行器的客观信号（不读取调用方自称的标记）：
 *   - node --test 子进程注入的 NODE_TEST_CONTEXT（Node 官方测试运行器行为）；
 *   - 启动参数含 --test / --test=…；
 *   - 主模块本身是 test/*.test.js（直接 `node test/x.test.js` 运行的场景）。
 * 生产入口（node src/index.js serve / check / login）不满足以上任何一项。
 */
function isTestContext() {
  const ctx = process.env.NODE_TEST_CONTEXT;
  if (typeof ctx === 'string' && ctx !== '') return true;
  if (process.env.NODE_TEST === '1') return true;
  const args = [...(process.execArgv || []), ...(process.argv || [])];
  if (args.some((a) => typeof a === 'string' && (a === '--test' || a.startsWith('--test=')))) return true;
  try {
    const main = require.main && require.main.filename;
    if (main && /(^|[\\/])test[\\/][^\\/]+\.test\.js$/i.test(main)) return true;
  } catch (_) { /* 判定失败按非测试上下文处理，生产行为不变 */ }
  return false;
}

// ── AD-COOKIE-FOUR-TIER-20261019-F1：四层恢复链（值守工作 → 恢复副本 → 匹配店铺最近原始快照）──
// 路径一律由 __dirname / 可注入参数解析，不硬编码生产机器路径：
//   - guard 根：本文件 __dirname 上两级（douyin-promo-guard/src/login → 项目根）；
//   - 恢复副本目录：guard 根/cookie-recovery（不在任何 *.json 店铺扫描目录内）；
//   - bill-manager 归档模块（第 3 层候选来源）：兄弟项目 bill-manager/cookie-vault.js，
//     缺失时诚实跳过归档层（第 1/2 层恢复仍可用），绝不伪造成功。
const GUARD_ROOT_DIR = path.resolve(__dirname, '..', '..');
const DEFAULT_RECOVERY_DIR = path.join(GUARD_ROOT_DIR, 'cookie-recovery');
const DEFAULT_VAULT_MODULE_PATH = path.resolve(GUARD_ROOT_DIR, '..', 'bill-manager', 'cookie-vault.js');
const DEFAULT_FXG_HOME_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
/**
 * 恢复链候选上限（值守工作 1 + 分析来源 1 + 恢复副本 1 + 归档不同检查点补足）：有界一次循环。
 * AD-COOKIE-SOURCE-RECOVERY 新增「商品分析只读来源」一层（+1），不挤掉既有任一层；
 * 归档读取窗口与本上限同宽（vault 侧已先全量倒序再有界截断），并由
 * rankRestoreCandidatesGuard 按「不同 sha + 不同分钟桶」取额——重复入档不占额度，
 * 故上限内拿到的是真实最新 + 更早的**不同**检查点，而不是同一次会话态的重复快照。
 */
const RESTORE_MAX_CANDIDATES = 5;
/** 收敛到首页之后，语义身份探针的有界等待（节拍复用主链收敛间隔；非中转等待）。 */
const DEFAULT_VERIFY_IDENTITY_WAIT_MS = 20000;

/** 店铺名候选（compassShopName / name，trim 后去重；空配置返回空数组）。 */
function shopNamesOf(shopCfg) {
  const out = [];
  for (const n of [shopCfg && shopCfg.compassShopName, shopCfg && shopCfg.name]) {
    const t = String(n == null ? '' : n).trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/** 普通文件冻结捕获（符号链接/目录拒绝；缺失返回 missing）。mtimeMs 只用于候选排名，
 *  绝不作为"是否健康/是否放行"的依据（放行仍必须走结构校验 + 独立验证 + CAS）。 */
function captureNormalFileGuard(fsm, p) {
  let lst = null;
  try { lst = fsm.lstatSync(p); } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, code: 'missing', reason: '文件缺失' };
    return { ok: false, code: 'error', reason: `文件状态不可判定（${(e && e.message) || e}）` };
  }
  if (!lst.isFile()) return { ok: false, code: 'not-regular', reason: '不是普通文件（符号链接/目录拒绝）' };
  try {
    const buf = fsm.readFileSync(p);
    return { ok: true, buf, sha256: crypto.createHash('sha256').update(buf).digest('hex'), mtimeMs: Number(lst.mtimeMs) || 0 };
  } catch (e) {
    return { ok: false, code: 'error', reason: `读取失败（${(e && e.message) || e}）` };
  }
}

/** 工作根内精确字节原子写（tmp 'wx' + fsync + rename 前复验 + 回读比对）。 */
function atomicWriteExactGuard(fsm, targetPath, buf, opts = {}) {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  let fd = null;
  let owned = false;
  try {
    fd = fsm.openSync(tmp, 'wx');
    owned = true;
    fsm.writeSync(fd, buf);
    fsm.fsyncSync(fd);
    fsm.closeSync(fd);
    fd = null;
    if (typeof opts.beforeRename === 'function') {
      const chk = opts.beforeRename() || {};
      if (chk.ok !== true) {
        try { fsm.unlinkSync(tmp); } catch (_) { /* 只清自有临时文件 */ }
        owned = false;
        return { ok: false, conflict: chk.kind === 'target-drift', reason: chk.reason || 'rename 前复验未通过：放弃提交' };
      }
    }
    fsm.renameSync(tmp, targetPath);
  } catch (e) {
    if (fd !== null) { try { fsm.closeSync(fd); } catch (_) { /* ignore */ } }
    if (owned) { try { fsm.unlinkSync(tmp); } catch (_) { /* ignore */ } }
    return { ok: false, reason: (e && e.message) || String(e) };
  }
  try {
    const back = fsm.readFileSync(targetPath);
    if (crypto.createHash('sha256').update(back).digest('hex') !== crypto.createHash('sha256').update(buf).digest('hex')) {
      return { ok: false, conflict: true, reason: '写入后回读与预期字节不一致（并发更新）：不报告成功' };
    }
  } catch (e) {
    return { ok: false, reason: `写入后无法回读: ${(e && e.message) || e}` };
  }
  return { ok: true, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/** 当前工作副本状态（absent / 精确 sha），供恢复提升 CAS 基线与 rename 前复验共用。 */
function guardWorkTargetState(fsm, workPath) {
  const cap = captureNormalFileGuard(fsm, workPath);
  if (cap.ok) return { exists: true, sha256: cap.sha256 };
  if (cap.code === 'missing') return { exists: false };
  return { exists: true, error: cap.reason };
}

/** 写工作副本前保留上一版（fail-closed：备份失败即放弃提升）。 */
function backupGuardWorkFile(fsm, workPath, nowFn) {
  const cap = captureNormalFileGuard(fsm, workPath);
  if (cap.code === 'missing') return { ok: true, skipped: true, backupPath: null };
  if (!cap.ok) return { ok: false, reason: cap.reason };
  const backupPath = `${workPath}.prev-${nowFn()}-${crypto.randomBytes(3).toString('hex')}`;
  const w = atomicWriteExactGuard(fsm, backupPath, cap.buf);
  if (!w.ok) return { ok: false, reason: `备份写入失败：${w.reason}` };
  return { ok: true, skipped: false, backupPath };
}

/** 归档层候选（bill-manager/cookie-vault.js；模块缺失/读取失败 → 诚实 unavailable）。
 *  读取窗口有界（默认 RESTORE_MAX_CANDIDATES）：vault 已按 createdAtMs/versionId 全量
 *  倒序再有界截断，故这里取到的是**真实最新**的一批，不是 manifest 追加顺序的头部。
 *  每个候选带 createdAtMs（归档入册时间）与 origin（来源类别），供上层按
 *  来源类别 + 不同 SHA/时间桶排名。非 legacy 与 legacy 各占一个同宽读取窗口（D4），
 *  类内保持 vault 的既有新→旧顺序：legacy 不得把已验证快照挤出首选窗口，但也不被
 *  首选窗口挤为零（验证失败后仍有有界回退窗口可试）。 */
function listArchiveCandidatesGuard(shopSafeName, opts, fsm, limit = RESTORE_MAX_CANDIDATES) {
  let vaultMod = opts.vaultModule || null;
  if (!vaultMod) {
    try { vaultMod = require(DEFAULT_VAULT_MODULE_PATH); } catch (e) {
      return { ok: false, reason: `归档模块不可用（${(e && e.message) || e}）：跳过归档层候选` };
    }
    if (!vaultMod || typeof vaultMod.listSnapshotVersions !== 'function' || typeof vaultMod.readSnapshotVersion !== 'function' || typeof vaultMod.defaultRoots !== 'function') {
      return { ok: false, reason: '归档模块接口不完整：跳过归档层候选' };
    }
  }
  let versions;
  try {
    const roots = vaultMod.defaultRoots({ guardRoot: GUARD_ROOT_DIR, ...(opts.vaultRoots || {}) });
    versions = vaultMod.listSnapshotVersions({ shopSafeName, roots, fsModule: fsm });
  } catch (e) {
    return { ok: false, reason: `归档列举异常（${(e && e.message) || e}）：跳过归档层候选` };
  }
  if (!versions || versions.ok !== true) {
    return { ok: false, reason: (versions && versions.reason) || '归档列举失败：跳过归档层候选' };
  }
  const items = [];
  const roots = vaultMod.defaultRoots({ guardRoot: GUARD_ROOT_DIR, ...(opts.vaultRoots || {}) });
  const maxRead = Math.max(1, Math.min(RESTORE_MAX_CANDIDATES, Number(limit) || 1));
  // 来源优先（先划分再按既有硬上限截断）：非 legacy（含 unknown/verified-login）在前，
  // legacy-unverified 作为回退在后；两类内部保持 vault 已给出的新→旧顺序。
  const nonLegacyVersions = [];
  const legacyVersions = [];
  for (const v of versions.versions) {
    if (v && v.origin === 'legacy-unverified') legacyVersions.push(v);
    else nonLegacyVersions.push(v);
  }
  // STARVATION-FIX（MULTISHOP-ISOLATION-20261027 D4）：非 legacy 与 legacy 各取独立的
  // maxRead 读取窗口，不再拼接后统一截断——否则 5 条以上较新非 legacy 会把 legacy 回退
  // 永久挤出窗口，每次恢复都重复读同一批失效快照。优先级仍由排名层保证（非 legacy 先验）。
  for (const v of nonLegacyVersions.slice(0, maxRead).concat(legacyVersions.slice(0, maxRead))) {
    const origin = (v && v.origin) || 'unknown';
    const r = vaultMod.readSnapshotVersion({ versionPath: v.versionPath, expectedSha256: v.sha256 || undefined, fsModule: fsm });
    if (r.ok) items.push({ source: `raw-archive:${v.versionId}`, buf: r.buf, sha256: r.sha256, path: v.versionPath, createdAtMs: Number(v.createdAtMs) || 0, origin });
    else items.push({ source: `raw-archive:${v.versionId}`, error: r.reason, origin });
  }
  return { ok: true, items, manifestMissing: versions.manifestMissing === true, archiveRoot: roots.archiveRoot };
}

/**
 * 商品分析只读来源候选（AD-COOKIE-SOURCE-RECOVERY）：login.cookieSourceDir 下精确同名
 * 工作副本。商品分析侧扫码/刷新会更新该上游文件，通常比 stale 的 guard 恢复副本/原始
 * 快照更新，故在恢复链中排在它们之前验证；但绝不据 mtime 放行——仍走调用方统一的
 * 结构校验 + sha 去重 + 独立浏览器验证 + 正确店名 + finalCookies 校验 + CAS 提升门禁，
 * 不盲拷贝、不降低身份核验。
 *
 * 隔离与安全（fail-closed）：
 *  - 未配置 login.cookieSourceDir → 如实跳过该层（不报错，其余恢复层照常）；
 *  - 来源目录 realpath 与 guard work/recovery/archive 任一重合（路径别名/junction/symlink）
 *    → 跳过，不当作独立候选（避免把 guard 自身目录当"上游"重复计层）；
 *  - 候选必须是普通文件：captureNormalFileGuard 用 lstat 拒绝符号链接/目录/非普通文件；
 *  - 只读捕获字节，绝不向上游来源目录写入（提升只落 guard 工作副本，由调用方 CAS 完成）。
 *
 * @returns {{source:string, buf:Buffer, sha256:string}|null}
 */
function captureAnalyzerSourceCandidateGuard(fsm, loginCfg, name, workReal, recReal, archReal, attempts) {
  const sourceDir = loginCfg && typeof loginCfg.cookieSourceDir === 'string' && loginCfg.cookieSourceDir.trim()
    ? loginCfg.cookieSourceDir.trim() : null;
  if (!sourceDir) {
    attempts.push({ source: 'analyzer-source', result: 'not-configured', reason: '未配置 login.cookieSourceDir：跳过商品分析只读来源层（其余恢复层照常）' });
    return null;
  }
  let srcReal = null;
  try { srcReal = fsm.realpathSync(sourceDir); } catch (_) { srcReal = null; }
  if (srcReal && ((workReal && srcReal === workReal) || (recReal && srcReal === recReal) || (archReal && srcReal === archReal))) {
    attempts.push({ source: 'analyzer-source', result: 'alias-skipped', reason: '商品分析来源目录与 guard work/recovery/archive 目录 realpath 重合（路径别名）：跳过该层，不当作独立候选' });
    return null;
  }
  const cap = captureNormalFileGuard(fsm, path.join(sourceDir, name));
  if (!cap.ok) {
    attempts.push({ source: 'analyzer-source', result: 'unreadable', reason: cap.reason });
    return null;
  }
  return { source: 'analyzer-source', buf: cap.buf, sha256: cap.sha256, createdAtMs: cap.mtimeMs };
}

/**
 * 默认候选验证器（生产实际接通；测试注入 verify 覆盖）：**每个候选**都通过显式提供的
 * candidateBrowserFactory 启动一份全新独立浏览器进程，在该进程内注入候选 Cookie、访问
 * 抖店首页，先做与主链**同一份**有界被动收敛（lib/settle-policy：默认 45s/3s，零点击/
 * 零导航/零请求，严格首页 host+path 判定），收敛到首页后才做语义身份轮询
 *（probeDoudianShopIdentityInPage + decideDoudianIdentity 同口径）。绝不凭 mtime/结构
 * 放行。COOKIE-PROCESS-ISOLATION-20261026：不再接收/复用调用方共享的 opts.browser
 *（同进程开 context 不满足"每份 Cookie 独立浏览器进程"）；工厂返回重复/被禁止的实例
 *（如主店铺浏览器或上一候选已用实例）→ 在 newContext/addCookies 之前 fail-closed 拒绝
 * 并闩锁停链，且**绝不由本验证器关闭外来/已用实例**（所有权在原所有者）。验证结束后
 * context 与**本候选专属浏览器进程**都必须关闭；关闭未获证明（close 抛错或仍连接）→ 本次验证绝不判成功，并以
 * stopChain 要求恢复链立即停止（候选 N 未收口前不得启动候选 N+1，也不得提升）。
 * 未显式提供工厂时 fail-closed 拒绝验证（绝不静默自启真实浏览器——离线测试
 * 与无浏览器环境一律不提升候选，防真实浏览器/网络副作用）。
 */
function createDefaultCandidateVerifier(loginCfg, opts = {}) {
  const factory = typeof opts.candidateBrowserFactory === 'function' ? opts.candidateBrowserFactory : null;
  const forbidden = Array.isArray(opts.forbiddenBrowsers)
    ? opts.forbiddenBrowsers.filter((b) => b && typeof b === 'object') : [];
  if (!factory) {
    return async function verifyCandidate() {
      return { ok: false, classification: 'verify-error', reason: '未提供候选专用浏览器工厂（candidateBrowserFactory）：无法独立验证候选（fail-closed，拒绝复用共享浏览器，拒绝自启真实浏览器，不提升）' };
    };
  }
  const usedBrowsers = new Set();
  // 不确定启动/收口后的闩锁：工厂抛错（可能已创建未返回的资源）或拒绝实例关闭未获证明后，
  // 本验证器后续调用一律直接 fail-closed 停链，绝不再调用工厂（不盲目重试）。
  let latchReason = null;
  return async function verifyCandidate(p) {
    if (latchReason) {
      return { ok: false, classification: 'verify-error', stopChain: true, reason: latchReason };
    }
    let browser = null;
    try {
      browser = await factory();
    } catch (_) {
      latchReason = '候选专用浏览器启动失败且资源收口状态不确定（工厂异常可能已创建未返回的进程）：已闩锁停止恢复链，后续候选一律拒绝启动（fail-closed，不提升；异常详情可能含敏感环境信息，已脱敏不回显）';
      return { ok: false, classification: 'verify-error', stopChain: true, reason: '候选专用浏览器启动失败（工厂异常后资源状态不确定）：停止恢复链并闩锁后续候选，不提升（异常详情可能含敏感环境信息，已脱敏不回显）' };
    }
    // D6E 所有权分离：被禁止的实例（如主店铺浏览器）与上一候选已使用过的实例都不归本
    // 候选所有。必须在 newContext/addCookies 之前拒绝；外来进程由原所有者收口——主店铺
    // 浏览器仍在业务使用，上一候选已在自己的 finally 关闭——本验证器绝不代关（不重复
    // close、不把主店浏览器关掉）。拒绝后闩锁，后续验证一律不再调用工厂。
    if (browser && (usedBrowsers.has(browser) || forbidden.includes(browser))) {
      latchReason = '候选浏览器工厂返回被禁止或重复/共享的浏览器实例（主店铺或上一候选已拥有并自行收口）：已闩锁停止恢复链，本候选绝不关闭外来进程，不提升';
      return {
        ok: false, classification: 'verify-error', stopChain: true,
        reason: '候选浏览器工厂返回重复/共享的浏览器实例（forbiddenBrowsers 或上一候选已使用；每个候选必须是全新独立进程）：fail-closed 拒绝验证，停止恢复链，不提升',
      };
    }
    // 不可用实例（null/非浏览器对象）：不属于任何外来所有者，保守关闭且**关闭需获证明**；
    // 未获证明（不确定收口）不得让下一候选启动。
    if (!browser || typeof browser.newContext !== 'function') {
      let closeProven = false;
      if (browser && typeof browser.close === 'function') {
        try { await browser.close(); closeProven = true; } catch (_) { closeProven = false; }
        if (closeProven && typeof browser.isConnected === 'function') {
          try { if (browser.isConnected() !== false) closeProven = false; } catch (_) { closeProven = false; }
        }
      }
      if (!closeProven) {
        latchReason = '被拒绝的候选浏览器实例关闭未获证明（close 异常或仍连接）：已闩锁停止恢复链，绝不带不确定收口进入下一候选';
        return { ok: false, classification: 'verify-error', stopChain: true, reason: '候选浏览器工厂返回不可用浏览器实例（每个候选必须是全新独立进程），且该实例关闭未获证明：停止恢复链，不提升' };
      }
      return { ok: false, classification: 'verify-error', reason: '候选浏览器工厂返回不可用浏览器实例（每个候选必须是全新独立进程）：fail-closed 拒绝验证，不提升' };
    }
    usedBrowsers.add(browser);
    let ctx = null;
    let outcome = null;
    try {
      ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
      await ctx.addCookies(p.cookies);
      const page = await ctx.newPage();
      await page.goto((loginCfg && loginCfg.douyinHomeUrl) || DEFAULT_FXG_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      const settleOpts = {
        settleTimeoutMs: opts.verifySettleTimeoutMs,
        settleIntervalMs: opts.verifySettleIntervalMs,
        settleNowFn: opts.verifyNowFn,
        settleSleep: opts.verifySleep,
      };
      // 有界被动收敛（实测约 30s 落首页）：中转期绝不判失效；到上界仍非首页才如实分类。
      const settled = await waitForDoudianHomepageSettled(page, settleOpts);
      const pacing = settlePacing(settleOpts);
      const identityMs = sanitizePositiveMs(opts.verifyMaxWaitMs, DEFAULT_VERIFY_IDENTITY_WAIT_MS);
      // 已落在任一受信任身份页（首页收敛成功，或直接落在账户中心等受支持路径）才给
      // 完整身份探针预算；到上界仍非身份页则不二次空等，单轮如实分类。
      const onIdentityPage = settled.ok === true || isVerifiedDoudianIdentityUrl(String(settled.url || ''));
      const maxAttempts = onIdentityPage ? Math.max(1, Math.ceil(identityMs / pacing.intervalMs)) : 1;
      let sawLoginEvidence = false;
      let reachedVerifiedIdentityUrl = false;
      let lastIdentityReason = null;
      for (let i = 0; i < maxAttempts; i += 1) {
        if (i > 0) {
          const sleep = opts.verifySleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
          await sleep(pacing.intervalMs);
        }
        const url = String(page.url());
        if (!isVerifiedDoudianIdentityUrl(url)) {
          // 明确登录页/登录中转地址 = 登录无效正证据（与"身份未核实/错店"区分）。
          if (/\/login|\/passport|\/signin|\/logout|sso\.jinritemai|\/account\/logout/i.test(url)) sawLoginEvidence = true;
          continue;
        }
        reachedVerifiedIdentityUrl = true;
        const obs = await page.evaluate(probeDoudianShopIdentityInPage).catch(() => null);
        if (obs && obs.loginVisible === true) sawLoginEvidence = true;
        const rd = decideDoudianIdentity({ url, expectedNames: p.expectedShopNames, observed: obs });
        if (!rd.ok) { lastIdentityReason = rd.reason; continue; }
        // 取得同一独立 context 在受信首页+唯一正确店名后的最终 Cookie（可能已含本次
        // 验证访问被平台轮换的新登录令牌）；提升的是这份最终已验证集合，杜绝过时候选。
        // 只有成功取得**非空**最终集合才可 ok=true；异常或空集合一律 fail-closed 为
        // verify-error（不回显异常细节，绝不 {ok:true, finalCookies:[]} 让空集合冒充成功）。
        let back = null;
        try { back = await ctx.cookies(); } catch (_) { back = null; }
        if (!Array.isArray(back) || back.length === 0) {
          outcome = { ok: false, classification: 'verify-error', reason: '独立验证上下文未返回非空最终 Cookie 集合（读取异常或空）：fail-closed 拒绝验证/提升（待重试，不要求扫码）' };
          break;
        }
        const afterCapture = await page.evaluate(probeDoudianShopIdentityInPage);
        const finalIdentity = decideDoudianIdentity({ url: String(page.url()), expectedNames: p.expectedShopNames, observed: afterCapture });
        if (!finalIdentity.ok || String(page.url()) !== url || finalIdentity.name !== rd.name) {
          outcome = { ok: false, classification: 'identity-unverified', reason: 'Cookie 捕获期间页面或身份漂移：拒绝提升' };
          break;
        }
        const finalCookies = await ctx.cookies();
        if (!sameCookieSet(back, finalCookies) || String(page.url()) !== url) {
          outcome = { ok: false, classification: 'verify-error', reason: '身份复验期间 Cookie 或页面变化：拒绝提升较早快照' };
          break;
        }
        outcome = { ok: true, finalCookies };
        break;
      }
      if (!outcome) {
        if (sawLoginEvidence) {
          outcome = { ok: false, classification: 'login-invalid', reason: '候选在独立浏览器进程命中登录页地址或可见登录控件（登录无效，需重新扫码）' };
        } else if (reachedVerifiedIdentityUrl) {
          outcome = { ok: false, classification: 'identity-unverified', reason: `候选在独立浏览器进程到达受信抖店首页但未取得唯一本店语义身份/疑错店（${lastIdentityReason || '身份未核实'}）：待核实/重试，不要求扫码` };
        } else {
          outcome = { ok: false, classification: 'identity-unverified', reason: '候选未在独立浏览器进程取得受信抖店首页的唯一本店语义身份（登录无效/错店/待核实，不要求扫码）' };
        }
      }
    } catch (_) {
      // 外部异常可能回显 Cookie 值/带 token 的 URL：只记录固定脱敏原因。验证异常绝不判"登录无效"。
      outcome = { ok: false, classification: 'verify-error', reason: '候选验证异常（异常详情可能含 Cookie/令牌等敏感值，已脱敏不回显）：拒绝验证/提升，待重试不要求扫码' };
    }
    if (ctx) { try { await ctx.close(); } catch (_) { /* 关闭失败不掩盖结果 */ } }
    // 本候选专属浏览器进程用毕必须真正关闭：close 抛错或仍连接 → 绝不判成功，并停止恢复链。
    let browserClosed = true;
    try { await browser.close(); } catch (_) { browserClosed = false; }
    if (browserClosed && typeof browser.isConnected === 'function') {
      try { if (browser.isConnected() !== false) browserClosed = false; } catch (_) { browserClosed = false; }
    }
    if (!browserClosed) {
      latchReason = '候选专用浏览器进程关闭未获证明（close 异常或仍连接）：停止恢复链，不提升、不进入下一候选';
      return { ok: false, classification: 'verify-error', stopChain: true, reason: latchReason };
    }
    return outcome;
  };
}

/**
 * 恢复候选排名（硬上限内选「真实最新 + 更早的不同检查点」）：
 *  - 三个上层候选（值守工作副本 / 商品分析来源 / 恢复副本）各至多一条，恒定保留（它们是
 *    现存状态本身，不参与归档时间排名）；
 *  - 归档候选先按来源类别（非 legacy 在前，legacy-unverified 回退在后；unknown/其他
 *    来源按非 legacy 兼容），类内按 createdAtMs 全量倒序（缺失时回落 versionId 内嵌
 *    UTC 时刻，绝不回落 manifest 追加顺序——那是最旧的一批）；
 *  - **同 sha 去重不占额度**：字节完全相同就是同一个检查点，重复验证只会白耗额度；
 *  - 归档层内**同一来源类别 + 同一分钟桶只占一个额度**：同一分钟的多次入档是同一
 *    会话态的重复快照，保留其中较新的一条、跳过更早的且**不占额度**；不同来源类别
 *    各自成桶，故较新的 legacy 不会遮蔽同分钟的已验证快照；
 *  - 额度用尽后其余如实标 beyond-limit（本轮不验证；下次恢复窗口仍可入选）；
 *  - D4 起 legacy-unverified 另有同宽的**回退窗口**（首选窗口之后按序验证，
 *    全局 sha 去重）：首选 5 条全部失效时 legacy 回退仍会被试到，不再被首选
 *    窗口永久挤出（排名审计 decision=selected-fallback / beyond-limit-fallback）。
 * 排名审计只输出标识（层级 / sha 前缀 / 秒级时刻 / 判定），绝不输出 Cookie 值或完整 sha。
 *
 * @returns {{selected:object[], ranking:object[], taken:number, considered:number}}
 */
function at0Bucket(kind, c) {
  const at = archiveEpochMs(c);
  return at > 0 ? `${kind}:${Math.floor(at / 60000)}` : null;
}

function rankRestoreCandidatesGuard(cands, limit = RESTORE_MAX_CANDIDATES) {
  const upper = cands.filter((c) => !String(c.source || '').startsWith('raw-archive:'));
  const archives = cands.filter((c) => String(c.source || '').startsWith('raw-archive:'));
  archives.sort((a, b) => (Number(isLegacyArchiveCandidate(a)) - Number(isLegacyArchiveCandidate(b)))
    || (archiveEpochMs(b) - archiveEpochMs(a))
    || String(b.source).localeCompare(String(a.source)));
  const maxSlots = Math.max(1, Number(limit) || 1);
  const selected = [];
  const ranking = [];
  const seenSha = new Set();
  const seenMinute = new Set();
  for (const c of upper) {
    selected.push(c);
    seenSha.add(c.sha256);
    ranking.push({ rank: ranking.length + 1, layer: c.source, sha256Prefix: String(c.sha256).slice(0, 12), decision: 'kept-layer' });
  }
  // STARVATION-FIX（D4）：两段有界窗口。首选窗口 = 上层候选 + 非 legacy 归档（合计
  // maxSlots，优先级不变：已验证/较新快照绝不被 stale legacy 顶替）；legacy 回退只在
  // 首选窗口之后另行选入（同样宽 maxSlots 的有界窗口，全局 sha 去重不重复验证）。
  // 首选窗口未耗尽额度时 legacy 也不再插进首选，而是统一排在回退窗口——调用方
  // 按顺序验证，行为等价（首选全失败后 legacy 必然被试到），排名审计保持"首选在前"。
  const legacyPending = [];
  const rankArchiveEntry = (c) => {
    const at = archiveEpochMs(c);
    return {
      rank: ranking.length + 1,
      layer: 'raw-archive',
      versionId: String(c.source).slice('raw-archive:'.length),
      atEpochSec: at > 0 ? Math.floor(at / 1000) : null,
      sha256Prefix: String(c.sha256).slice(0, 12),
      decision: null,
    };
  };
  for (const c of archives) {
    if (isLegacyArchiveCandidate(c)) { legacyPending.push(c); continue; }
    const entry = rankArchiveEntry(c);
    if (seenSha.has(c.sha256)) entry.decision = 'skipped-dup-sha';
    else if (selected.length >= maxSlots) entry.decision = 'beyond-limit';
    else {
      const bucket = at0Bucket('nonlegacy', c);
      if (bucket !== null && seenMinute.has(bucket)) entry.decision = 'skipped-dup-minute';
      else {
        entry.decision = 'selected';
        selected.push(c);
        seenSha.add(c.sha256);
        if (bucket !== null) seenMinute.add(bucket);
      }
    }
    ranking.push(entry);
  }
  let legacyTaken = 0;
  for (const c of legacyPending) {
    const entry = rankArchiveEntry(c);
    entry.window = 'legacy-fallback';
    if (seenSha.has(c.sha256)) entry.decision = 'skipped-dup-sha';
    else if (legacyTaken >= maxSlots) entry.decision = 'beyond-limit-fallback';
    else {
      const bucket = at0Bucket('legacy', c);
      if (bucket !== null && seenMinute.has(bucket)) entry.decision = 'skipped-dup-minute';
      else {
        entry.decision = 'selected-fallback';
        selected.push(c);
        seenSha.add(c.sha256);
        legacyTaken += 1;
        if (bucket !== null) seenMinute.add(bucket);
      }
    }
    ranking.push(entry);
  }
  return { selected, ranking, taken: selected.length, considered: cands.length };
}

/**
 * 归档候选来源类别：仅精确 origin === 'legacy-unverified' 归为 legacy 回退；
 * unknown/other（含 verified-login 与历史缺失 origin 的候选）按非 legacy 兼容。
 * 来源类别只影响候选排序/分钟桶，不构成登录有效性证明——仍走统一原生验证器。
 */
function isLegacyArchiveCandidate(c) {
  return String((c && c.origin) || 'unknown') === 'legacy-unverified';
}

/** 归档候选时刻：manifest createdAtMs 优先；缺失时解析 versionId 内嵌 UTC 时刻；都没有 → 0（排最后）。 */
function archiveEpochMs(c) {
  const n = Number(c && c.createdAtMs);
  if (Number.isFinite(n) && n > 0) return n;
  const m = /v(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/.exec(String((c && c.source) || ''));
  if (!m) return 0;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Number.isFinite(t) ? t : 0;
}

/**
 * 值守工作副本恢复（AD-COOKIE-FOUR-TIER-20261019-F1）：仅在业务入口明确
 * auth/登录失效失败后调用；候选链 = 值守工作副本 → 商品分析只读来源 → 恢复副本 →
 * 匹配店铺最近原始快照（AD-COOKIE-SOURCE-RECOVERY 新增「分析来源」层：商品分析侧
 * 扫码/刷新会更新该上游，通常比 stale 恢复/归档更新，故排在它们之前验证）。
 * 每个候选：普通文件冻结捕获（符号链接拒绝）→ 结构校验 → sha 去重 → 独立验证
 *（正确店名 + 有效登录，可注入；生产默认真实浏览器验证，绝不 stub 永真）→
 * 保留上一版 + CAS 原子提升到值守工作副本，记录来源 sha。全部失败如实保留错误、
 * 不盲覆盖、不无限循环、不跨店猜文件；候选验证不写任何归档或来源；恢复副本与
 * 归档只读（工作更新不得向上污染）。
 *
 * @param {object} loginCfg 配置 login 段
 * @param {string} cookieFile 精确店铺文件名（safeCookieBaseName 规则）
 * @param {object} opts { shopCfg, verify?, candidateBrowserFactory?, forbiddenBrowsers?,
 *                        vaultModule?, vaultRoots?, recoveryDir?, workDir?, fsModule?,
 *                        nowFn?, audit? }
 * @returns {Promise<{ok:true, source:string, sourceSha256:string, targetSha256:string, backupPath:string|null, attempts:object[]}
 *                   |{ok:false, reason:string, attempts:object[]}>}
 */
async function restoreDutyWorkCopy(loginCfg, cookieFile, opts = {}) {
  const fsm = opts.fsModule || fs;
  const nowFn = opts.nowFn || (() => Date.now());
  const attempts = [];
  const name = safeCookieBaseName(cookieFile);
  const workDir = resolveWorkDir(loginCfg, opts);
  const workPath = path.join(workDir, name);
  const shopSafeName = name.slice(0, -5);
  const expectedNames = shopNamesOf(opts.shopCfg || {});
  if (expectedNames.length === 0) {
    return { ok: false, reason: '未配置店铺名（compassShopName/name）：无法验证候选身份，拒绝恢复', attempts };
  }
  // 冻结基线（验证开始前）：目标指纹在此定格；任何候选提升前必须仍与该基线一致，
  // 验证期间发生的并发新扫码登录写入胜出（拒绝提升、保留并发新文件，不覆盖）。
  const frozenBaseline = guardWorkTargetState(fsm, workPath);
  if (frozenBaseline.error) {
    return { ok: false, reason: `无法冻结值守工作副本目标指纹（${frozenBaseline.error}）：拒绝恢复（fail-closed）`, attempts };
  }

  // 候选 1：值守工作副本当前字节（业务入口登录失效路径可排除：当前字节刚在真实
  // 浏览器验证失败，重复验证无意义；文件损坏/未知调用方仍按完整候选链处理）
  const w = captureNormalFileGuard(fsm, workPath);
  let workCand = null;
  if (opts.excludeWorkCopy === true) {
    attempts.push({ source: 'guard-duty-work', result: 'excluded', reason: '本次恢复由登录失效入口发起：值守工作副本当前字节即刚失败内容，排除重复候选（仍尝试分析来源/恢复副本/原始快照层）' });
  } else if (w.ok) {
    workCand = { source: 'guard-duty-work', buf: w.buf, sha256: w.sha256, createdAtMs: w.mtimeMs };
  } else {
    attempts.push({ source: 'guard-duty-work', result: 'unreadable', reason: w.reason });
  }

  // 目录 realpath（恢复副本别名判定 + 分析来源隔离共用）
  const recoveryDir = opts.recoveryDir || DEFAULT_RECOVERY_DIR;
  let recReal = null;
  let workReal = null;
  try { recReal = fsm.realpathSync(recoveryDir); } catch (_) { recReal = null; }
  try { workReal = fsm.realpathSync(workDir); } catch (_) { workReal = null; }

  // 候选 3：恢复副本（目录与工作根 realpath 重合时如实跳过，不当作两层）。
  // COOKIE-FOUR-REPAIR-20261024：恢复副本已是版本化只读角色——除历史固定路径
  // cookie-recovery/<name>.json（只读兼容读取）外，还读取版本目录
  // cookie-recovery/<shopSafeName>/v*.json（新→旧，只读捕获，绝不写入）。
  let recoveryCand = null;
  const recoveryVersionCands = [];
  if (recReal && workReal && recReal === workReal) {
    attempts.push({ source: 'guard-recovery', result: 'alias-skipped', reason: '恢复目录与工作根 realpath 重合（路径别名）：跳过该层，不当作独立候选' });
  } else {
    const r = captureNormalFileGuard(fsm, path.join(recoveryDir, name));
    if (r.ok) recoveryCand = { source: 'guard-recovery', buf: r.buf, sha256: r.sha256, createdAtMs: r.mtimeMs };
    else attempts.push({ source: 'guard-recovery', result: 'unreadable', reason: r.reason });
    try {
      const vdir = path.join(recoveryDir, shopSafeName);
      const vnames = fsm.readdirSync(vdir)
        .filter((f) => /^v.+\.json$/.test(f))
        .sort((a, b) => String(b).localeCompare(String(a)))
        .slice(0, 3);
      for (const f of vnames) {
        const vid = f.slice(0, -5);
        const rv = captureNormalFileGuard(fsm, path.join(vdir, f));
        if (rv.ok) recoveryVersionCands.push({ source: `guard-recovery:${vid}`, buf: rv.buf, sha256: rv.sha256, createdAtMs: rv.mtimeMs });
        else attempts.push({ source: `guard-recovery:${vid}`, result: 'unreadable', reason: rv.reason });
      }
    } catch (_) { /* 版本目录缺失：无版本化恢复副本，仅固定路径兼容层 */ }
  }

  // 候选 4..：匹配店铺的最近原始快照（bill-manager 归档；sha 与 manifest 记录核验）。
  // 读取窗口 = 硬上限（vault 已全量倒序再有界截断，故窗口内即真实最新的一批），
  // 之后由 rankRestoreCandidatesGuard 按「不同 sha + 不同分钟桶」排名取额，
  // 同 sha / 同分钟的重复入档不耗尽额度，保证上限内既拿到最新也拿到更早的不同检查点。
  // D4：归档读取层同时带回 legacy 回退窗口，排名层首选窗口之后按序补入（见
  // rankRestoreCandidatesGuard），首选全部失效时 legacy 候选仍会被验证。
  const arch = listArchiveCandidatesGuard(shopSafeName, opts, fsm, RESTORE_MAX_CANDIDATES);
  const archiveCands = [];
  let archReal = null;
  if (arch.ok) {
    if (arch.archiveRoot) { try { archReal = fsm.realpathSync(arch.archiveRoot); } catch (_) { archReal = null; } }
    if (arch.manifestMissing) {
      attempts.push({ source: 'raw-archive', result: 'manifest-missing', reason: '归档 manifest 缺失/损坏：按目录列举回退（读取时因无 manifest sha 而拒绝，不绕过来源完整性验证）' });
    }
    for (const item of arch.items) {
      if (item.error) attempts.push({ source: item.source, result: 'integrity-failed', reason: item.error });
      else archiveCands.push(item);
    }
  } else {
    attempts.push({ source: 'raw-archive', result: 'unavailable', reason: arch.reason });
  }

  // 候选 2（AD-COOKIE-SOURCE-RECOVERY 新增）：商品分析只读来源（login.cookieSourceDir
  // 精确同名工作副本）。商品分析侧扫码/刷新会更新该上游，通常比 stale 的 guard 恢复
  // 副本/原始快照更新——排在它们之前验证；但绝不据 mtime 放行，仍走下方统一的结构
  // 校验 + sha 去重 + 独立浏览器验证 + 正确店名 + finalCookies 校验 + CAS 提升门禁。
  // 隔离门：来源目录 realpath 与 guard work/recovery/archive 任一重合（路径别名）即跳过；
  // 候选必须是普通文件（符号链接/目录拒绝）；只读捕获，绝不向上游写入。
  const analyzerCand = captureAnalyzerSourceCandidateGuard(fsm, loginCfg, name, workReal, recReal, archReal, attempts);

  // 组装顺序：值守工作 → 分析来源（较新，先于 stale 恢复/归档）→ 恢复副本 → 归档；
  // 归档内部再按 createdAtMs 全量倒序 + 「不同 sha / 不同分钟桶」排名取额，
  // 重复入档（同 sha、或同分钟的更早一条）不占额度，硬上限内仍能同时覆盖最新与更早
  // 的不同检查点。排名审计（kind:cookie-restore-ranking）只含层级 / versionId /
  // sha 前缀 / 秒级时刻 / 判定，绝不含 Cookie 值。
  const cands = [];
  for (const c of [workCand, analyzerCand, recoveryCand, ...recoveryVersionCands, ...archiveCands]) {
    if (c) cands.push(c);
  }
  const ranked = rankRestoreCandidatesGuard(cands, RESTORE_MAX_CANDIDATES);
  if (typeof opts.audit === 'function') {
    try {
      opts.audit({
        kind: 'cookie-restore-ranking', shop: shopSafeName,
        time: new Date(nowFn()).toISOString(),
        limit: RESTORE_MAX_CANDIDATES, considered: ranked.considered, taken: ranked.taken,
        ranking: ranked.ranking,
      });
    } catch (_) { /* 审计失败不改变恢复语义 */ }
  }

  const verify = opts.verify || createDefaultCandidateVerifier(loginCfg, opts);
  const seen = new Set();
  let verifyCalls = 0;
  for (const cand of ranked.selected) {
    if (seen.has(cand.sha256)) {
      attempts.push({ source: cand.source, result: 'dedup', sha256Prefix: String(cand.sha256).slice(0, 12) + '…' });
      continue;
    }
    seen.add(cand.sha256);
    let parsed = null;
    try { parsed = JSON.parse(cand.buf.toString('utf8')); } catch (_) { parsed = null; }
    const v = parsed === null ? { ok: false, reason: 'JSON 解析失败' } : validateCookieArray(parsed);
    if (!v.ok) {
      attempts.push({ source: cand.source, result: 'invalid-structure', reason: v.reason });
      continue;
    }
    verifyCalls += 1;
    let vr;
    try {
      vr = await verify({ cookies: parsed, expectedShopNames: expectedNames, source: cand.source });
    } catch (_) {
      // 注入验证器的外部异常同样可能含 Cookie/token：固定脱敏原因，绝不回显异常内容。
      vr = { ok: false, reason: '验证器异常（异常详情可能含 Cookie/令牌等敏感值，已脱敏不回显）' };
    }
    if (!vr || vr.ok !== true) {
      attempts.push({
        source: cand.source, result: 'verify-failed',
        ...(vr && vr.classification ? { classification: vr.classification } : {}),
        ...(vr && vr.stopChain === true ? { stopChain: true } : {}),
        reason: (vr && vr.reason) || '未通过验证',
      });
      // COOKIE-PROCESS-ISOLATION-20261026：候选专属浏览器进程关闭未获证明 → 立即
      // 终止恢复链（不提升、不再启动下一候选进程；候选 N 收口前不得进入 N+1）。
      if (vr && vr.stopChain === true) break;
      continue;
    }
    // 第六轮 F1（根因修复）：只提升「验证 context 的最终已验证集合」的确定性序列化字节。
    // 平台可能在验证访问本身中轮换登录 Cookie，提升原始候选会立即过时——故**绝不回退提升
    // 原始候选字节**。验证器虽 ok=true 但未返回非空 finalCookies（旧桩/异常）视为无效成功：
    // 记录 final-missing、继续下一候选、零提升、零写入。
    if (!Array.isArray(vr.finalCookies) || vr.finalCookies.length === 0) {
      attempts.push({ source: cand.source, result: 'final-missing', reason: '验证器返回 ok 但未提供非空最终已验证 Cookie 集合：fail-closed 拒绝提升（绝不回退提升原始候选），继续下一候选' });
      continue;
    }
    let promoteBuf;
    let verificationLabel = 'verified-in-new-context-final';
    {
      const fv = validateCookieArray(vr.finalCookies);
      if (!fv.ok) {
        attempts.push({ source: cand.source, result: 'final-invalid', reason: `最终已验证集合结构无效（${fv.reason}）：拒绝提升（不写未验证数据）` });
        continue;
      }
      const auth = finalPreservesCandidateAuth(vr.finalCookies, parsed);
      if (!auth.ok) {
        attempts.push({ source: cand.source, result: 'final-invalid', reason: auth.reason });
        continue;
      }
      try {
        promoteBuf = Buffer.from(serializeCookies(vr.finalCookies), 'utf8');
      } catch (_) {
        attempts.push({ source: cand.source, result: 'final-invalid', reason: '最终已验证集合序列化失败：拒绝提升（异常详情不回显）' });
        continue;
      }
    }
    // 提升前比对冻结基线：验证期间目标被并发更新（如新扫码登录）→ 放弃提升，
    // 并发较新登录胜出（保留其文件，不覆盖、不 rebase、不合并）。
    const cur = guardWorkTargetState(fsm, workPath);
    if (cur.error) {
      attempts.push({ source: cand.source, result: 'promote-failed', reason: `目标状态不可判定（${cur.error}）：拒绝提升` });
      continue;
    }
    if (cur.exists !== frozenBaseline.exists || (cur.exists && cur.sha256 !== frozenBaseline.sha256)) {
      attempts.push({ source: cand.source, result: 'promote-failed', conflict: true, reason: '候选验证期间值守工作副本被并发更新（如新扫码登录）：放弃提升，保留并发新文件（较新登录胜出，不覆盖）' });
      continue;
    }
    // 保留上一版（fail-closed）+ CAS（rename 前复验冻结基线）+ 回读比对
    const bk = backupGuardWorkFile(fsm, workPath, nowFn);
    if (!bk.ok) {
      attempts.push({ source: cand.source, result: 'backup-failed', reason: bk.reason });
      continue;
    }
    const beforeRename = () => {
      const chk = guardWorkTargetState(fsm, workPath);
      if (chk.error) return { ok: false, kind: 'target-drift', reason: `rename 前复验：目标状态不可判定（${chk.error}）` };
      if (chk.exists !== frozenBaseline.exists || (chk.exists && chk.sha256 !== frozenBaseline.sha256)) {
        return { ok: false, kind: 'target-drift', reason: 'rename 前复验：工作副本已被并发写入者更新：放弃本次提升，保留并发新文件' };
      }
      return { ok: true };
    };
    const wr = atomicWriteExactGuard(fsm, workPath, promoteBuf, { beforeRename });
    if (!wr.ok) {
      attempts.push({ source: cand.source, result: 'promote-failed', reason: wr.reason });
      continue;
    }
    const entry = {
      kind: 'cookie-restore', shop: shopSafeName, role: 'guard-duty-work',
      time: new Date(nowFn()).toISOString(), source: cand.source,
      sourceSha256: cand.sha256, verification: verificationLabel,
      targetSha256: wr.sha256, backupPath: bk.backupPath ? path.basename(bk.backupPath) : null,
    };
    if (typeof opts.audit === 'function') { try { opts.audit(entry); } catch (_) { /* ignore */ } }
    return {
      ok: true, source: cand.source, sourceSha256: cand.sha256,
      targetSha256: wr.sha256, backupPath: bk.backupPath || null, attempts,
    };
  }
  if (typeof opts.audit === 'function') {
    try {
      opts.audit({
        kind: 'cookie-restore', shop: shopSafeName, role: 'guard-duty-work',
        time: new Date(nowFn()).toISOString(), ok: false, attempts,
      });
    } catch (_) { /* ignore */ }
  }
  return {
    ok: false,
    reason: `全部候选未通过验证或提升失败（验证调用 ${verifyCalls} 次）：保留工作副本现状，不盲覆盖（单次有界循环）`,
    attempts,
  };
}

module.exports = {
  PROJECT_COOKIES_DIR,
  GUARD_ROOT_DIR,
  DEFAULT_RECOVERY_DIR,
  DEFAULT_VAULT_MODULE_PATH,
  RESTORE_MAX_CANDIDATES,
  DEFAULT_VERIFY_IDENTITY_WAIT_MS,
  rankRestoreCandidatesGuard,
  archiveEpochMs,
  isTestContext,
  resolveWorkDir,
  resolveCookieFile,
  inspectCookieFile,
  loadShopCookieMeta,
  checkLoginByBrowser,
  listAvailableShops,
  shopNamesOf,
  restoreDutyWorkCopy,
  createDefaultCandidateVerifier,
};

/**
 * 工作根（写回链落盘目录）：默认固定本项目 cookies/；guard 配置可用
 * `login.cookieWorkDir`（必须绝对路径）显式指定隔离工作根（例如离线测试或多实例部署）。
 * 配置存在但非法 → 如实抛错，绝不静默回落到生产根写入。
 *
 * AD-WATCHDOG-TEST-ISOLATION-20261020：测试上下文（node --test / 直接运行 test/*.test.js）
 * 既未注入 opts.workDir、也未配置 cookieWorkDir 时 **fail-closed 抛错**，不再静默回落
 * 生产 PROJECT_COOKIES_DIR。生产入口不受影响（isTestContext=false 时保持原默认行为）。
 */
function resolveWorkDir(loginCfg, opts) {
  if (opts && typeof opts.workDir === 'string' && opts.workDir.trim()) return opts.workDir;
  const cfg = loginCfg && typeof loginCfg.cookieWorkDir === 'string' ? loginCfg.cookieWorkDir.trim() : '';
  if (!cfg) {
    if (isTestContext()) {
      throw new AuthError(
        '测试上下文缺少隔离 Cookie 工作根（login.cookieWorkDir 或 opts.workDir）：fail-closed，拒绝默认写入生产 cookies/'
      );
    }
    return PROJECT_COOKIES_DIR;
  }
  if (!path.isAbsolute(cfg)) {
    throw new AuthError(`login.cookieWorkDir 配置非法（必须是绝对路径，拒绝相对路径写入未知位置）: ${cfg}`);
  }
  return cfg;
}

/**
 * 本地工作根文件返回前的隔离门：必须是工作根内的**普通文件**（符号链接/junction/目录
 * 一律拒绝），否则等于把共享上游或别名路径交给自动写回链。结构/登录有效性仍由
 * inspectCookieFile 与业务身份门判定，本函数不放宽任何既有条件。
 */
function localWorkFile(fsm, filePath, workDir, sourceSync) {
  let lst = null;
  try { lst = fsm.lstatSync(filePath); } catch (_) { lst = null; }
  if (!lst || !lst.isFile()) {
    throw new AuthError(
      `本项目 Cookie 文件不是工作根内的普通文件（符号链接/目录/不可判定: ${filePath}）：拒绝把路径别名或共享上游返回给自动写回链`
    );
  }
  const out = { path: filePath, dir: workDir, readOnly: false };
  if (sourceSync) out.sourceSync = sourceSync;
  return out;
}

/**
 * 解析指定店铺的 Cookie 文件路径。
 *
 * S97 起（共享上游保护）：配置了**不同于本项目 cookies/** 的 cookieSourceDir 且存在
 * 精确同名来源文件时，来源目录被当作只读上游——绝不把来源路径返回给自动写回链
 * （cookie-writeback / session-cookie-checkpoint 用返回 path 建 cookieSession 回写，
 * 旧的 readOnly 标记并不能阻止写共享来源）。改为经 `cookie-workcopy.ensureWorkCopy`
 * 复制到本项目 cookies/ 的该店独立工作副本后返回：
 *   { path: 本项目副本, dir: 本项目 cookies/, readOnly: false, sourceSync: {...} }
 * QC / compass / 发布控制器等现有调用者无需修改，自动写回只会落在独立副本上。
 * 来源目录零写入（无 write/rename/unlink/chmod/mkdir/sidecar/tmp）；来源坏/缺失时
 * 保留已有健康副本或抛 AuthError，绝不返回来源路径兜底。
 *
 * S99 起（用户目标：两份 Cookie 各自刷新、互不影响）：普通解析**不再**因为来源内容
 * 变化就替换结构健康的独立工作副本（商品分析普通读取的收尾保存也会改写上游，来源
 * hash 变化不等于用户重新扫码）；只有 app 侧「本次已验证新登录」的 authorizedFreshLogin
 * 调用才按冻结 commit.sha256 更新副本。差异如实出现在 sourceSync.status/reason 中。
 *
 * 无来源配置（或来源目录与本项目 cookies/ 是同一字面目录）时保留原独立登录兼容：
 * 直接用本项目 cookies/ 文件，不反向写任何来源。字面不同但 realpath 重合的
 * junction/symlink 别名属于伪隔离 → 拒绝（不返回上游可写路径给写回链）。
 *
 * @param {object} loginCfg 配置 login 段（cookieSourceDir / cookieWorkDir 可为空）
 * @param {string} cookieFile 精确店铺文件名（不含 .json 亦可；拒绝路径穿越）
 * @param {object} [opts] 仅离线测试注入：{ workDir, fsMod }；生产调用不传，
 *                        工作根为 PROJECT_COOKIES_DIR（或 login.cookieWorkDir）
 */
function resolveCookieFile(loginCfg, cookieFile, opts = {}) {
  const fsm = (opts && opts.fsMod) || fs;
  const workDir = resolveWorkDir(loginCfg, opts);
  const name = safeCookieBaseName(cookieFile);
  const projectPath = path.join(workDir, name);
  const sourceDir = loginCfg && typeof loginCfg.cookieSourceDir === 'string' && loginCfg.cookieSourceDir.trim()
    ? loginCfg.cookieSourceDir.trim() : null;

  if (sourceDir) {
    // realpath 比较：symlink/junction 别名视同同一目录（不把路径别名当隔离，也不对同目录做复制）
    let srcReal = null;
    let workReal = null;
    try { srcReal = fsm.realpathSync(sourceDir); } catch (_) { srcReal = null; }
    try { workReal = fsm.realpathSync(workDir); } catch (_) { workReal = null; }
    const sameLiteralDir = path.resolve(sourceDir) === path.resolve(workDir);
    if (!sameLiteralDir && srcReal !== null && workReal !== null && srcReal === workReal) {
      // 配置成"另一个目录"却解析到上游本身（junction/symlink 别名）：伪隔离，必须拒绝
      throw new AuthError(
        `来源目录与工作目录是同一目录的路径别名（realpath 重合: ${srcReal}）：拒绝把共享上游当独立隔离返回给写回链`
      );
    }
    const separate = srcReal !== null && srcReal !== workReal;
    if (separate) {
      const srcPath = path.join(sourceDir, name);
      let srcIsFile = false;
      try { srcIsFile = fsm.lstatSync(srcPath).isFile(); } catch (_) { srcIsFile = false; }
      if (srcIsFile) {
        const r = ensureWorkCopy({ sourceDir, fileName: name, workDir, fsMod: fsm });
        return { path: r.path, dir: r.dir, readOnly: false, sourceSync: r.sourceSync };
      }
      // 来源文件缺失：本项目已有副本（如上游文件被移走）→ 继续用本地副本，不反向写来源
      if (fsm.existsSync(projectPath)) {
        return localWorkFile(fsm, projectPath, workDir, {
          status: 'source-file-missing-local-only',
          reason: '来源目录存在但缺少该店文件：使用本项目既有副本（已核验为工作根内普通文件，非共享上游别名）',
        });
      }
      throw new AuthError(
        `未找到店铺「${cookieFile}」的 Cookie 文件（已查找: ${workDir} 与 ${sourceDir}）`
      );
    }
    // 来源目录与工作根是同一字面目录（或来源目录不可解析）→ 按无独立来源的本地兼容处理
  }

  if (fsm.existsSync(projectPath)) {
    return localWorkFile(fsm, projectPath, workDir, null);
  }
  throw new AuthError(
    `未找到店铺「${cookieFile}」的 Cookie 文件（已查找: ${workDir}${sourceDir ? ` 与 ${sourceDir}` : ''}）`
  );
}

/**
 * 校验并返回 Cookie 元信息（不暴露任何值）。
 * @returns {{count:number, domains:string[], fxgExpired:boolean, maxExpires:number|null, readOnly:boolean, filePath:string}}
 */
function inspectCookieFile(cookieFilePath, readOnly) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(cookieFilePath, 'utf-8'));
  } catch (e) {
    throw new AuthError(`Cookie 文件解析失败: ${e.message}`);
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new AuthError('Cookie 文件内容不是非空数组（预期 Playwright cookies 格式）');
  }
  const required = ['name', 'value', 'domain'];
  for (const c of raw) {
    if (!c || typeof c !== 'object' || required.some((k) => typeof c[k] !== 'string')) {
      throw new AuthError('Cookie 数组中存在缺少 name/value/domain 的条目');
    }
  }
  const domains = [...new Set(raw.map((c) => c.domain))];
  const fxgCookies = raw.filter((c) => /(^|\.)jinritemai\.com$/.test(c.domain));
  let maxExpires = null;
  let fxgExpired = false;
  if (fxgCookies.length > 0) {
    const nowSec = Date.now() / 1000;
    maxExpires = Math.max(...fxgCookies.map((c) => (typeof c.expires === 'number' ? c.expires : 0)));
    // 会话 Cookie（expires=-1）视作未知，不据此判死；有明确过期时间且已过则判失效
    const definite = fxgCookies.filter((c) => typeof c.expires === 'number' && c.expires > 0);
    fxgExpired = definite.length > 0 && definite.every((c) => c.expires < nowSec);
  }
  return {
    count: raw.length,
    domains,
    fxgExpired,
    maxExpires: maxExpires && maxExpires > 0 ? maxExpires * 1000 : null,
    readOnly,
    filePath: cookieFilePath,
  };
}

/** 加载某店铺 Cookie 的元信息（不返回值本身）。 */
function loadShopCookieMeta(loginCfg, shopCfg) {
  const resolved = resolveCookieFile(loginCfg, shopCfg.cookieFile);
  const meta = inspectCookieFile(resolved.path, resolved.readOnly);
  if (meta.fxgExpired) {
    throw new AuthError(
      `店铺「${shopCfg.cookieFile}」的抖站 Cookie 已过有效期（最近过期时间 ${meta.maxExpires ? new Date(meta.maxExpires).toISOString() : '未知'}），本轮停止自动操作`
    );
  }
  return meta;
}

/**
 * 用已加载 Cookie 的上下文打开指定页面并检测登录态（复用参考项目的 URL 判定）。
 * 注意：本函数会真正启动浏览器，仅在已接入真实页面读取后由监控流程调用；
 * 本轮仅提供能力，不在无页面阶段自动执行。
 */
async function checkLoginByBrowser(loginCfg, cookieFilePath) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({
    headless: true,
    executablePath: loginCfg.edgePath,
    args: ['--window-size=1920,1080'],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const cookies = JSON.parse(fs.readFileSync(cookieFilePath, 'utf-8'));
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto(loginCfg.douyinHomeUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForTimeout(5000);
    const loggedIn = await page.evaluate(() =>
      window.location.href.includes('fxg.jinritemai.com/ffa/mshop/homepage')
    );
    return { loggedIn, url: page.url() };
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * 列出可用店铺名称（本项目工作根 + 配置的只读来源目录，仅文件名，不读内容）。
 * 目标店铺未明确配置时供用户选择，绝不默认第一个。
 * 工作根经 resolveWorkDir 解析：测试上下文缺少隔离工作根时 fail-closed（不扫生产目录）。
 */
function listAvailableShops(loginCfg) {
  const out = [];
  const workDir = resolveWorkDir(loginCfg);
  const dirs = [
    { dir: workDir, readOnly: false },
    { dir: loginCfg && loginCfg.cookieSourceDir, readOnly: true },
  ];
  const seen = new Set();
  for (const d of dirs) {
    if (!d.dir || !fs.existsSync(d.dir)) continue;
    for (const f of fs.readdirSync(d.dir)) {
      if (!f.endsWith('.json')) continue;
      const name = f.slice(0, -5);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({ name, dir: d.dir, readOnly: d.readOnly });
    }
  }
  return out;
}
