'use strict';

/**
 * S99：商品分析新登录 → 推广控制独立 Cookie 副本初始化（同一交付的 app 侧）。
 *
 * 用户目标（原话）：商品分析登录新账号扫码登录以后准备两份一样的 cookies，一份给商品
 * 分析、一份给推广广告控制，之后各自刷新、互不影响；不得再让用户重复扫码。
 *
 * 职责边界：
 *  - 只在 login-shop.js 完成「身份确认 + 会话复用校验 + 主文件 commitCookiesAtomic
 *    CAS 成功」之后被调用；从**这次已验证且已提交的同一快照**（commit.sha256 冻结
 *    哈希核验）初始化 guard 工作副本，两份初始字节完全相同。绝不重新抓不相关
 *    context，绝不读取另一轮更晚的来源，绝不合并。
 *  - 本次登录证明贯穿整条链：committedPath 必须是 cookiesDir 内**精确同名的普通文件**；
 *    commit.sha256 缺失即失败（不默默省略证明）；guard 复制 helper 内每一次来源读取都
 *    以 expectedSourceSha256 绑定该冻结 sha，任何期间漂移即副本失败并保留原副本/主文件。
 *  - 成功判据（唯一）：本次已验证 commit 的冻结快照真正复制完成、目标副本回读字节
 *    sha256 与该快照逐字节一致、且 helper 报告的提交状态属于「已提交」集合、无
 *    sidecarFailed / 竞态 / 保留旧副本 / 锁忙；S100 追加：跨越 helper 全部 meta 提交
 *    与副本回读窗口后，来源必须仍是同一精确普通文件且仍是本次冻结快照、目的当前
 *    字节仍一致（最终事实核验；不宣称消除该校验之后的并发窗口）。其余一律 ok:false
 *    （分析登录成功事实保留，join 零调用，可重试同步，无需重新扫码）。已有工作副本
 *    结构可读**不等于**本次同步成功。
 *  - guard 副本写入完全复用 guard/src/login/cookie-workcopy.js 的 ensureWorkCopy
 *    （同一复制算法：工作根短锁 / 冻结字节 / 全指纹 CAS / provenance sidecar /
 *    原子替换），不在 app 侧另造第二套写入实现。
 *  - 集成定位：生产部署中推广控制项目是 bill-manager 的同级目录 `douyin-promo-guard`
 *    （DEFAULT_PROMO_GUARD_DIR），可用 PROMO_GUARD_DIR 或参数显式覆盖（测试注入同一路径）。
 *    目标目录确实不存在 → 诚实 skipped（独立使用兼容，不阻断商品分析登录）；
 *    目录存在但模块/配置加载失败、或配置与本次 Cookie 目录不一致 → **可重试失败**
 *    （绝不把"缺模块/错误配置"静默等同"没集成所以跳过成功"）。
 *  - 任何副本失败都不回滚/不触碰已成功提交的商品分析主文件；结果经机器可解析
 *    marker（PROMO_COPY_RESULT: 单行 JSON）传递给 server，不输出任何 Cookie 值。
 *
 * 本模块不 require guard 根入口、不 require app/server、不启动浏览器。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cookieVault = require('./cookie-vault');
const { commitCookiesAtomic } = require('./login-session-persistence');

const COPY_MARKER_PREFIX = 'PROMO_COPY_RESULT:';
/** 生产部署：推广控制项目与 bill-manager 同级，目录名为 douyin-promo-guard。 */
const DEFAULT_PROMO_GUARD_DIR = path.resolve(__dirname, '..', 'douyin-promo-guard');

/**
 * helper 返回值中「本次冻结快照确已提交到工作副本」的状态集合。
 * 任何 *-retained / *-race-* / *-failed / *-mismatch 状态都不算成功。
 */
const COMMITTED_COPY_STATUSES = [
  'imported', 'replaced-legacy', 'refreshed-from-source', 'recommitted-fresh-login',
  'unchanged', 'rematerialized',
];

function sha256Of(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 加载 guard 集成（模块 + 实际配置）。
 * @returns {{configured:true, guardDir:string, workcopy:object, session:object, loginCfg:object}
 *          |{configured:false, absent:boolean, reason:string}}
 *   absent=true  → 目标目录确实不存在：独立使用兼容（skipped，不阻断登录）
 *   absent=false → 目录存在但模块/配置不可用：可重试失败（join 零调用），绝不静默跳过
 */
function loadPromoGuardIntegration(opts = {}) {
  const fsm = opts.fsModule || fs;
  const guardDir = opts.guardDir
    || (typeof process.env.PROMO_GUARD_DIR === 'string' && process.env.PROMO_GUARD_DIR.trim())
    || DEFAULT_PROMO_GUARD_DIR;
  let guardIsDir = false;
  let guardAbsent = false;
  try {
    guardIsDir = fsm.statSync(guardDir).isDirectory();
  } catch (e) {
    // 只有确实 ENOENT 才算「目录不存在」；普通文件占位 / EACCES / 不可判断一律 absent=false
    guardAbsent = !!(e && e.code === 'ENOENT');
  }
  if (!guardIsDir) {
    if (guardAbsent) {
      return {
        configured: false, absent: true,
        reason: `未检测到推广控制目录（${path.basename(String(guardDir))}）：按独立使用兼容跳过副本初始化`,
      };
    }
    return {
      configured: false, absent: false,
      reason: '推广控制路径存在但不是目录，或状态不可判断（普通文件占位/权限错误等）：按可重试失败处理，不谎称"目录不存在所以跳过"',
    };
  }
  let workcopy = null;
  let session = null;
  try {
    workcopy = opts.workcopyModule || require(path.join(guardDir, 'src', 'login', 'cookie-workcopy.js'));
    session = opts.sessionModule || require(path.join(guardDir, 'src', 'login', 'session.js'));
  } catch (e) {
    return {
      configured: false, absent: false,
      reason: `推广控制目录存在但复制模块加载失败（${(e && e.message) || e}）：按可重试失败处理，不宣称集成成功`,
    };
  }
  if (!workcopy || typeof workcopy.ensureWorkCopy !== 'function' || typeof workcopy.validateCookieArray !== 'function'
    || typeof workcopy.safeCookieBaseName !== 'function') {
    return { configured: false, absent: false, reason: '推广控制复制模块接口不完整（缺 ensureWorkCopy/validateCookieArray/safeCookieBaseName）：按可重试失败处理' };
  }
  let loginCfg = opts.guardLoginCfg || null;
  if (!loginCfg) {
    try {
      const guardConfig = require(path.join(guardDir, 'src', 'config.js'));
      loginCfg = guardConfig.loadConfig().config.login;
    } catch (e) {
      return {
        configured: false, absent: false,
        reason: `推广控制配置不可用（${(e && e.message) || e}）：按可重试失败处理，不宣称集成成功`,
      };
    }
  }
  const workRoot = (session && typeof session.PROJECT_COOKIES_DIR === 'string' && session.PROJECT_COOKIES_DIR.trim())
    ? session.PROJECT_COOKIES_DIR : null;
  if (!opts.workDir && !workRoot) {
    return { configured: false, absent: false, reason: '推广控制未提供工作根（session.PROJECT_COOKIES_DIR 缺失）：按可重试失败处理，拒绝写入未知目录' };
  }
  return { configured: true, guardDir, workcopy, session, loginCfg };
}

/**
 * 从已提交的主 Cookie 文件初始化 guard 独立副本（本次已验证新登录 → authorizedFreshLogin）。
 *
 * @param {object} p
 * @param {string} p.committedPath   本次 commitCookiesAtomic 已成功提交的主文件精确路径
 *                                   （必须是 p.cookiesDir 内精确同名普通文件）
 * @param {string} p.commitSha256    commit 返回的实际写入字节 sha256（缺失即失败）
 * @param {string} p.cookiesDir      商品分析 COOKIES_DIR（须与 guard cookieSourceDir realpath 一致）
 * @param {string} [p.guardDir]      推广控制根目录（默认 PROMO_GUARD_DIR / ../douyin-promo-guard）
 * @param {string} [p.workDir]       guard 工作根覆盖（仅离线测试；生产用 guard PROJECT_COOKIES_DIR）
 * @param {object} [p.fsModule]      注入 fs（离线测试）
 * @param {object} [p.frozenDest]    分发开始前冻结的值守工作副本指纹（CAS 基线；
 *                                   验证/分发期间被并发新登录写入则较新者胜出）
 * @returns {{ok:true, copyPath:string, status:string, committedSha256:string}|
 *           {ok:false, skipped?:boolean, reason:string, retryable:boolean}}
 */
function initPromoCookieCopy(p) {
  const fsm = p.fsModule || fs;
  const fail = (reason, extra = {}) => ({ ok: false, skipped: false, retryable: true, reason, ...extra });

  const integ = loadPromoGuardIntegration(p);
  if (!integ.configured) {
    if (integ.absent) return { ok: false, skipped: true, retryable: false, reason: integ.reason };
    return fail(integ.reason);
  }

  // ── 本次登录证明：commit.sha256 必须存在（不得默默省略证明）──
  const commitSha = typeof p.commitSha256 === 'string' ? p.commitSha256.trim() : '';
  if (!commitSha) {
    return fail('缺少本次提交的 commit.sha256：无法证明副本来源是本次已验证登录快照，拒绝初始化副本（主文件不受影响）');
  }

  // ── committedPath 必须绑定 cookiesDir 内精确同名普通文件（不只取 basename）──
  if (typeof p.cookiesDir !== 'string' || !p.cookiesDir.trim()) {
    return fail('缺少本次商品分析 Cookie 目录（cookiesDir）：拒绝从未知目录初始化副本');
  }
  let fileName = null;
  try {
    fileName = integ.workcopy.safeCookieBaseName(path.basename(String(p.committedPath || '')));
  } catch (e) {
    return fail(`本次提交的文件名非法（${(e && e.message) || e}）：拒绝初始化副本`);
  }
  const boundPath = path.join(p.cookiesDir, fileName);
  if (!p.committedPath || path.resolve(String(p.committedPath)) !== path.resolve(boundPath)) {
    return fail('committedPath 不是本次商品分析 Cookie 目录内的精确同名文件：拒绝从其他目录初始化副本（不重新抓浏览器 Cookie、不合并）');
  }
  let boundStat = null;
  try { boundStat = fsm.lstatSync(boundPath); } catch (_) { boundStat = null; }
  if (!boundStat || !boundStat.isFile()) {
    return fail('本次提交的主 Cookie 文件不是普通文件（缺失/符号链接/目录）：拒绝初始化副本');
  }

  // ── 集成配置核对：guard 来源目录必须就是商品分析 Cookie 目录（realpath，含别名归一）──
  const configuredSource = integ.loginCfg && typeof integ.loginCfg.cookieSourceDir === 'string'
    ? integ.loginCfg.cookieSourceDir.trim() : '';
  if (!configuredSource) {
    // 集成已加载却缺来源配置：这是现有集成的配置缺失（可修正后重试），不是「未集成独立使用」
    return fail('推广控制集成已加载但未配置 cookieSourceDir（缺失/空值）：无法核对来源一致性，按可重试失败处理（不当"未集成跳过"），拒绝在未知目录创建文件');
  }
  let srcReal = null;
  let appReal = null;
  try { srcReal = fsm.realpathSync(configuredSource); } catch (_) { srcReal = null; }
  try { appReal = fsm.realpathSync(p.cookiesDir); } catch (_) { appReal = null; }
  if (!srcReal || !appReal || srcReal !== appReal) {
    return fail('推广控制配置的 cookieSourceDir 与商品分析 Cookie 目录不一致：拒绝把副本来源指向未知目录（需修正推广控制配置后重试）');
  }

  // ── 冻结快照核验：主文件当前字节 sha256 必须等于本次 commit.sha256 ──
  let buf;
  try {
    buf = fsm.readFileSync(boundPath);
  } catch (e) {
    return fail(`无法读取本次已提交的主 Cookie 文件（${(e && e.message) || e}）；商品分析主文件不受影响`);
  }
  const sha = sha256Of(buf);
  if (sha !== commitSha) {
    return fail('已提交快照 sha256 核验失败（主文件在提交后被并发更改）：拒绝用不一致来源初始化副本，不触碰主文件');
  }
  let parsed = null;
  try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { parsed = null; }
  const v = parsed === null ? { ok: false, reason: 'JSON 解析失败' } : integ.workcopy.validateCookieArray(parsed);
  if (!v.ok) {
    return fail(`已提交快照结构校验失败（${v.reason}）：不初始化副本，不触碰主文件`);
  }

  // ── 复用 guard 同一复制算法写入 guard 工作根 ──
  // authorizedFreshLogin：本次为已验证新登录（真实身份/复用校验 + 主文件 CAS 提交完成）；
  // expectedSourceSha256：helper 内每一次来源读取都绑定本次 commit.sha256，期间漂移即失败。
  const workDir = p.workDir || integ.session.PROJECT_COOKIES_DIR;
  let r;
  try {
    r = integ.workcopy.ensureWorkCopy({
      sourceDir: p.cookiesDir,
      fileName,
      workDir,
      fsMod: fsm,
      authorizedFreshLogin: true,
      expectedSourceSha256: commitSha,
      ...(p.frozenDest && typeof p.frozenDest === 'object' ? { frozenDest: p.frozenDest } : {}),
    });
  } catch (e) {
    return fail(`推广副本写入失败（${(e && e.message) || e}）；商品分析主文件已成功提交、不受影响，可重试同步`);
  }
  const sync = r && r.sourceSync ? r.sourceSync : {};
  const status = typeof sync.status === 'string' ? sync.status : '（无状态）';
  if (sync.sidecarFailed === true) {
    return fail(`推广副本 provenance sidecar 提交失败（${sync.reason || status}）：不宣称本次登录副本成功，可重试同步`);
  }
  if (COMMITTED_COPY_STATUSES.indexOf(status) < 0) {
    return fail(`推广副本未完成本次已验证快照的提交（状态 ${status}：${sync.reason || '未提交本次快照'}）；保留现有副本与主文件，可重试同步`);
  }
  // ── 目标字节实证：回读副本，必须与本次 commit.sha256 逐字节一致 ──
  let back;
  try {
    back = fsm.readFileSync(r.path);
  } catch (e) {
    return fail(`推广副本写入后无法回读（${(e && e.message) || e}）：不能断言两份内容一致，按失败处理`);
  }
  const backSha = sha256Of(back);
  if (backSha !== commitSha) {
    return fail('推广副本回读字节与本次已验证提交快照不一致：拒绝报告成功（不宣称两份内容相同）');
  }
  // ── S100 最终事实核验：跨越 helper 全部 meta 提交窗口与上面的副本回读窗口 ──
  // helper 在写 meta 前验过来源，但 meta 临时文件 fsync/rename 期间来源可能已变成并发
  // 新登录；仅凭 dest==commitSha 不能宣称「两份当前相同」。此处以当前事实复核来源与
  // 目的双方：来源必须仍是同一精确普通文件且字节仍是本次已验证冻结快照，任一漂移/
  // 读取失败/删除/换别名 → 可重试失败（join 零调用），保留并发文件与商品分析登录
  // 事实，不反写/不回滚来源。注：最终核验之后仍存在理论并发窗口，本模块不宣称消除。
  let srcFinalStat = null;
  try { srcFinalStat = fsm.lstatSync(boundPath); } catch (_) { srcFinalStat = null; }
  if (!srcFinalStat || !srcFinalStat.isFile()) {
    return fail('主 Cookie 文件在副本提交/回读之后已不是同一精确普通文件（被删除/替换/换别名）：拒绝宣称两份当前相同，可重试同步（主登录事实保留，不反写来源）');
  }
  let srcFinal = null;
  try {
    srcFinal = fsm.readFileSync(boundPath);
  } catch (e) {
    return fail(`最终核验阶段无法回读主 Cookie 文件（${(e && e.message) || e}）：不能断言两份当前相同，按可重试失败处理（不触碰主文件）`);
  }
  if (sha256Of(srcFinal) !== commitSha) {
    return fail('主 Cookie 文件在推广副本提交/回读期间已被并发更改（不再是本次已验证冻结快照）：拒绝宣称双副本成功；保留并发新文件与商品分析登录事实，不反写/不回滚来源，可重试同步');
  }
  let destFinal = null;
  try {
    destFinal = fsm.readFileSync(r.path);
  } catch (e) {
    return fail(`最终核验阶段无法回读推广副本（${(e && e.message) || e}）：不能断言两份当前相同，按可重试失败处理`);
  }
  if (sha256Of(destFinal) !== commitSha) {
    return fail('推广副本在最终核验阶段已被并发更改（当前字节不是本次已验证冻结快照）：拒绝报告成功，保留并发文件，可重试同步');
  }
  return {
    ok: true,
    copyPath: r.path,
    status,
    committedSha256: commitSha,
    sidecarFailed: false,
    reason: null,
  };
}

/**
 * 分发开始前的只读冻结：解析 guard 集成并捕获**值守工作副本**当前指纹。
 * 本函数零写入；结果供 initPromoCookieCopy 的 frozenDest CAS 使用。
 * 集成缺失（独立使用）→ configured:false/absent:true；模块/配置不可用 → retryable。
 */
function preparePromoCopyDistribution(p = {}) {
  const fsm = p.fsModule || fs;
  const integ = loadPromoGuardIntegration(p);
  if (!integ.configured) {
    return {
      configured: false, absent: !!integ.absent, retryable: !integ.absent,
      reason: integ.reason, fileName: null, workDir: null, frozenDest: null,
    };
  }
  let fileName;
  try {
    fileName = integ.workcopy.safeCookieBaseName(path.basename(String(p.committedPath || '')));
  } catch (e) {
    return {
      configured: false, absent: false, retryable: true,
      reason: `本次提交的文件名非法（${(e && e.message) || e}）：拒绝初始化副本`,
      fileName: null, workDir: null, frozenDest: null,
    };
  }
  const workDir = p.workDir || integ.session.PROJECT_COOKIES_DIR;
  if (!workDir) {
    return {
      configured: false, absent: false, retryable: true,
      reason: '推广控制未提供工作根：拒绝写入未知目录',
      fileName, workDir: null, frozenDest: null,
    };
  }
  const workPath = path.join(workDir, fileName);
  let frozenDest;
  try {
    frozenDest = integ.workcopy.captureFile(fsm, workPath);
  } catch (e) {
    return {
      configured: false, absent: false, retryable: true,
      reason: `无法冻结值守工作副本当前指纹（${(e && e.message) || e}）：拒绝分发`,
      fileName, workDir, frozenDest: null,
    };
  }
  return { configured: true, absent: false, retryable: false, reason: null, fileName, workDir, workPath, frozenDest, integ };
}

/**
 * 四层同阶段分发（真实登录入口与测试共用同一实现）。
 *
 * 顺序（硬约束）：**先**把经过 verifySessionReuse 的同一份已验证字节 exclusive 创建到
 * 原始不可变归档并回读核验成功，**再**提交商品分析工作副本 → 值守工作副本 → 推广恢复副本。
 *  - 归档失败：分析/值守/恢复三个目标一律零写入（本函数直接返回 archiveFailed）；
 *  - 分析工作副本提交失败（含并发较新登录）：不向值守/恢复写旧快照；
 *  - 所有目标指纹在**任何写入之前**冻结（analyzerFingerprint 来自校验前；
 *    值守 frozenDest 与恢复 frozenBaseline 在函数入口捕获），提交不使用验证后重新捕获的基线；
 *  - legacy 迁移只写 legacy-unverified 归档，不向任何工作/恢复角色传播；
 *  - 返回逐角色状态；调用方据此输出 partial/retryable，绝不先报成功再发现失败。
 *
 * @param {object} p
 * @param {string} p.shopSafeName 店铺安全段
 * @param {Array}  p.cookies      本次已验证 Cookie 数组
 * @param {Buffer} [p.verifiedBuf] 本次已验证的精确字节（强烈建议传入）
 * @param {string} [p.verifiedSha256] 已验证冻结 sha（缺省由 verifiedBuf 计算）
 * @param {string} p.cookiePath   商品分析工作副本精确路径
 * @param {string} p.cookiesDir   商品分析 Cookie 目录
 * @param {object} [p.analyzerFingerprint] 校验前捕获的分析工作副本指纹（CAS 基线）
 * @param {Buffer|null} [p.legacyBytes] 提交前捕获的旧工作副本字节（只作 legacy-unverified）
 * @param {object} p.roots        cookie-vault.defaultRoots 产物
 * @param {object} [p.fsModule]
 * @param {function} [p.nowFn]
 * @param {function} [p.audit]
 * @returns {{ok:boolean, partial:boolean, archiveFailed:boolean, roles:object,
 *            commit:object|null, copyResult:object|null, verifiedSha256:string}}
 */
function distributeVerifiedLogin(p = {}) {
  const fsm = p.fsModule || fs;
  const nowFn = p.nowFn || (() => Date.now());
  const roles = {
    rawArchive: { ok: false, reason: '未执行' },
    legacyMigration: { ok: true, skipped: true, reason: '无旧工作副本' },
    analyzerWork: { ok: false, reason: '未执行' },
    guardWork: { ok: false, reason: '未执行' },
    guardRecovery: { ok: false, reason: '未执行' },
  };
  const fail = (reason, extra = {}) => ({
    ok: false, partial: true, archiveFailed: false, roles,
    commit: null, copyResult: null, verifiedSha256: null, reason, ...extra,
  });

  const cookies = p.cookies;
  const verifiedBuf = Buffer.isBuffer(p.verifiedBuf)
    ? p.verifiedBuf
    : Buffer.from(JSON.stringify(cookies, null, 2), 'utf8');
  const verifiedSha = sha256Of(verifiedBuf);
  if (typeof p.verifiedSha256 === 'string' && p.verifiedSha256.trim() && p.verifiedSha256.trim() !== verifiedSha) {
    return fail('已验证字节与冻结 sha256 不一致：拒绝分发（不写入任何角色）');
  }
  let shopSafeName;
  try { shopSafeName = cookieVault.safeShopSegment(p.shopSafeName); } catch (e) {
    return fail(`店铺安全段非法（${(e && e.message) || e}）：拒绝分发`);
  }
  if (typeof p.cookiePath !== 'string' || !p.cookiePath) {
    return fail('缺少商品分析工作副本路径：拒绝分发');
  }
  if (!p.analyzerFingerprint || typeof p.analyzerFingerprint !== 'object') {
    return fail('缺少分发前冻结的分析工作副本指纹：拒绝使用验证后重新捕获的基线提交');
  }
  const roots = p.roots || cookieVault.defaultRoots({});

  // ── 分发前冻结所有目标（只读，零写入）──────────────────────────────
  let guardPrep;
  try {
    guardPrep = preparePromoCopyDistribution({
      ...p,
      committedPath: p.cookiePath,
      fileName: `${shopSafeName}.json`,
    });
  } catch (e) {
    guardPrep = { configured: false, absent: false, retryable: true, reason: `值守目标冻结异常（${(e && e.message) || e}）` };
  }
  const recoveryPath = path.join(roots.recoveryDir, `${shopSafeName}.json`);
  let recoveryBaseline = p.recoveryBaseline || null;
  if (!recoveryBaseline) {
    const st = cookieVault.targetState(fsm, recoveryPath);
    recoveryBaseline = st.error ? null : { exists: !!st.exists, sha256: st.exists ? st.sha256 : null };
  }

  // ── 1) 原始快照：exclusive create + 回读核验；失败 → 三目标全不变 ──
  let raw;
  try {
    raw = cookieVault.createRawSnapshot({
      shopSafeName,
      buf: verifiedBuf,
      expectedSha256: verifiedSha,
      roots,
      fsModule: fsm,
      nowFn,
      audit: p.audit,
    });
  } catch (e) {
    raw = { ok: false, reason: (e && e.message) || String(e) };
  }
  roles.rawArchive = raw.ok
    ? {
      ok: true, versionId: raw.versionId,
      sha256Prefix: raw.sha256.slice(0, 12),
      manifestOk: raw.manifestOk, readOnlyAttrOk: raw.readOnlyAttrOk,
    }
    : { ok: false, reason: raw.reason };
  if (!raw.ok) {
    const skipReason = '原始快照归档未成功：按先存原则，分析/值守/恢复目标一律零写入';
    roles.legacyMigration = { ok: false, skipped: true, reason: skipReason };
    roles.analyzerWork = { ok: false, skipped: true, reason: skipReason };
    roles.guardWork = { ok: false, skipped: true, reason: skipReason };
    roles.guardRecovery = { ok: false, skipped: true, reason: skipReason };
    return {
      ok: false, partial: true, archiveFailed: true, roles,
      commit: null, copyResult: null, verifiedSha256: verifiedSha,
      reason: `原始快照归档失败：${raw.reason}（未提交任何工作/恢复副本）`,
    };
  }

  // ── 2) 商品分析工作副本（同一冻结字节 + 校验前指纹 CAS + 旧版备份）──
  let commit;
  try {
    commit = commitCookiesAtomic(p.cookiePath, cookies, {
      fingerprint: p.analyzerFingerprint,
      expectedPayloadSha256: verifiedSha,
      backupPrev: p.backupAnalyzerPrev !== false,
      fsModule: fsm,
    });
  } catch (e) {
    commit = { ok: false, code: 'save_error', reason: (e && e.message) || String(e) };
  }
  if (!commit || commit.ok !== true) {
    const reason = (commit && commit.reason) || '商品分析工作副本提交失败';
    roles.analyzerWork = { ok: false, code: (commit && commit.code) || 'save_error', reason };
    const skipReason = '分析工作副本未提交：不向值守/恢复写入旧快照（并发较新登录优先）';
    roles.legacyMigration = { ok: false, skipped: true, reason: skipReason };
    roles.guardWork = { ok: false, skipped: true, reason: skipReason };
    roles.guardRecovery = { ok: false, skipped: true, reason: skipReason };
    return {
      ok: false, partial: true, archiveFailed: false, roles,
      commit, copyResult: null, verifiedSha256: verifiedSha, reason,
    };
  }
  roles.analyzerWork = {
    ok: true, sha256Prefix: commit.sha256.slice(0, 12),
    backupPath: commit.backupPath ? path.basename(commit.backupPath) : null,
  };

  // ── 3) legacy 迁移：仅 legacy-unverified 归档，不向其他角色传播 ──
  try {
    if (Buffer.isBuffer(p.legacyBytes) && sha256Of(p.legacyBytes) !== verifiedSha) {
      const mig = cookieVault.archiveLegacyBytes({
        shopSafeName,
        buf: p.legacyBytes,
        roots,
        fsModule: fsm,
        nowFn,
        audit: p.audit,
      });
      roles.legacyMigration = mig.ok
        ? { ok: true, skipped: false, versionId: mig.versionId, sha256Prefix: mig.sha256.slice(0, 12), structureValid: mig.structureValid, origin: 'legacy-unverified' }
        : { ok: false, skipped: false, reason: mig.reason };
    } else {
      roles.legacyMigration = { ok: true, skipped: true, reason: p.legacyBytes ? '与本次快照字节一致' : '无旧工作副本' };
    }
  } catch (e) {
    roles.legacyMigration = { ok: false, skipped: false, reason: (e && e.message) || String(e) };
  }

  // ── 4) 推广值守工作副本（本次冻结快照 + 分发起始冻结目的指纹）──
  let copyResult = null;
  if (!guardPrep.configured) {
    copyResult = {
      ok: false, skipped: !!guardPrep.absent, retryable: guardPrep.retryable !== false,
      reason: guardPrep.reason || '推广控制集成不可用',
    };
    roles.guardWork = copyResult.skipped
      ? { ok: false, skipped: true, reason: copyResult.reason }
      : { ok: false, retryable: true, reason: copyResult.reason };
  } else {
    try {
      copyResult = initPromoCookieCopy({
        committedPath: p.cookiePath,
        commitSha256: verifiedSha,
        cookiesDir: p.cookiesDir,
        guardDir: p.guardDir,
        workDir: guardPrep.workDir,
        guardLoginCfg: p.guardLoginCfg,
        fsModule: fsm,
        frozenDest: guardPrep.frozenDest,
      });
    } catch (e) {
      copyResult = { ok: false, retryable: true, reason: `推广副本初始化异常：${(e && e.message) || e}` };
    }
    roles.guardWork = copyResult && copyResult.ok
      ? { ok: true, status: copyResult.status || null, sha256Prefix: String(copyResult.committedSha256 || verifiedSha).slice(0, 12) }
      : {
        ok: false,
        skipped: !!(copyResult && copyResult.skipped),
        retryable: !!(copyResult && copyResult.retryable),
        reason: (copyResult && copyResult.reason) || '未知原因',
      };
  }

  // ── 5) 推广恢复副本（只读角色）：exclusive create 新不可变版本，绝不覆盖既有文件 ──
  let recRes = null;
  try {
    recRes = cookieVault.updateGuardRecoveryFromVerified({
      shopSafeName,
      cookies,
      verifiedSha256: verifiedSha,
      roots,
      fsModule: fsm,
      nowFn,
      frozenBaseline: recoveryBaseline,
      audit: p.audit,
    });
  } catch (e) {
    recRes = { ok: false, retryable: true, reason: (e && e.message) || String(e) };
  }
  roles.guardRecovery = recRes.ok
    ? { ok: true, versionId: recRes.versionId, sha256Prefix: recRes.sha256.slice(0, 12), metaOk: recRes.metaOk }
    : { ok: false, retryable: !!(recRes.retryable), reason: recRes.reason };

  const ok = roles.rawArchive.ok && roles.analyzerWork.ok
    && roles.guardWork.ok && roles.guardRecovery.ok;
  return {
    ok, partial: !ok, archiveFailed: false, roles,
    commit, copyResult, verifiedSha256: verifiedSha,
    reason: ok ? null : '存在未完成角色：登录事实保留，可按角色重试同步',
  };
}

/**
 * 从登录子进程 stdout 行中解析副本结果 marker（纯函数，server 复用）。
 * marker 为单行 `PROMO_COPY_RESULT:{...}`；行缓冲/跨 chunk UTF-8 由既有
 * createLoginStdoutLineParser 负责，本函数只处理完整行。
 * @param {string[]} lines
 * @returns {{present:boolean, parseError:boolean, conflict:boolean, result:object|null}}
 */
function parseCopyResultLines(lines) {
  const out = { present: false, parseError: false, conflict: false, result: null };
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = String(raw || '').trim();
    if (!line.startsWith(COPY_MARKER_PREFIX)) continue;
    out.present = true;
    let parsed = null;
    try { parsed = JSON.parse(line.slice(COPY_MARKER_PREFIX.length)); } catch (_) { parsed = null; }
    if (!parsed || typeof parsed !== 'object') { out.parseError = true; continue; }
    if (out.result === null) out.result = parsed;
    else if (JSON.stringify(out.result) !== JSON.stringify(parsed)) out.conflict = true;
  }
  return out;
}

/**
 * 副本结果策略（纯函数，server 复用）：商品分析登录成功事实不受副本失败影响；
 * 只有副本明确 ok:true（本次已验证快照逐字节复制完成）才允许值守接管（join）；
 * 失败/未知/跳过一律 join 零调用，并给出「无需重新扫码、可重试同步」的诚实用户文案。
 * @param {{present:boolean, parseError:boolean, conflict:boolean, result:object|null}} marker
 * @returns {{ok:boolean, skipped:boolean, unknown:boolean, joinAllowed:boolean,
 *            reason:string|null, userMessage:string|null}}
 */
function decidePromoCopyOutcome(marker) {
  const m = marker || { present: false, parseError: false, conflict: false, result: null };
  if (m.present && !m.parseError && !m.conflict && m.result && m.result.ok === true) {
    return { ok: true, skipped: false, unknown: false, joinAllowed: true, reason: null, userMessage: null };
  }
  if (m.present && (m.parseError || m.conflict)) {
    return {
      ok: false, skipped: false, unknown: true, joinAllowed: false,
      reason: '副本状态标记不可解析或冲突：按未知处理（不谎报成功）',
      userMessage: '商品分析登录成功，但推广会话副本状态未知：已跳过值守接管，可重试同步，无需重新扫码',
    };
  }
  if (!m.present || !m.result) {
    return {
      ok: false, skipped: false, unknown: true, joinAllowed: false,
      reason: '未检测到副本状态标记（登录脚本未输出）：按未知处理',
      userMessage: '商品分析登录成功，但推广会话副本状态未知：已跳过值守接管，可重试同步，无需重新扫码',
    };
  }
  const reason = String(m.result.reason || '未知原因');
  if (m.result.skipped === true) {
    return {
      ok: false, skipped: true, unknown: false, joinAllowed: false, reason,
      userMessage: `商品分析登录成功；推广控制副本未初始化（${reason}），已跳过值守接管`,
    };
  }
  return {
    ok: false, skipped: false, unknown: false, joinAllowed: false, reason,
    userMessage: `商品分析登录成功，推广会话副本保存失败（${reason}）：可重试同步，无需重新扫码`,
  };
}

module.exports = {
  COPY_MARKER_PREFIX,
  DEFAULT_PROMO_GUARD_DIR,
  COMMITTED_COPY_STATUSES,
  loadPromoGuardIntegration,
  preparePromoCopyDistribution,
  initPromoCookieCopy,
  distributeVerifiedLogin,
  parseCopyResultLines,
  decidePromoCopyOutcome,
};
