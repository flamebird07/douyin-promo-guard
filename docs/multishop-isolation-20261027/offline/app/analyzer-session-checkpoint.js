'use strict';
/**
 * analyzer-session-checkpoint.js — 电商助手分析器会话保存链（AD-AUTO-PLAN-REPAIR-20261012-S76，2026-10-16）。
 *
 * S75 版缺口（Root 只读反例 root-analyzer-gaps-r75.cjs 对实际导出复现，三例均错误 saved=true）：
 *  a) 身份与 context 未绑定：page.context() 指向别的 context / page 已关闭仍保存；
 *  b) cookiePath 不与店铺绑定：期望/页面均为本店、目标 basename 却是另一店铺.json 也照写；
 *  c) expectedShopName 为空即跳过 identity.ok：空语义（无账户ID）下身份缺失也写 default/任意文件。
 *
 * S76 绑定规则（只收紧，不放松）：
 *  - Cookie 捕获前与异步身份 probe 之后均复验 page.context()===context 且 page.isClosed()===false
 *    （Playwright 形态）；方法不可得/不一致/已关闭/期间漂移 → 拒绝，零写入；
 *  - 语义身份（login-shop-identity：userName-leaf / headerShopName-container）恒为必过门槛：
 *    expected 非空要求与目标 shopNameArg 原文精确相等（getShopNameFromPage 及其参数回退不作为
 *    证据）；expected 为空（无账户ID/新店名）也必须取得唯一当前语义身份——无账户ID≠无身份，
 *    不再保留“登录成功即保存”的空语义放行；
 *  - 目标文件名与身份绑定：path.basename(cookiePath) 必须精确等于 safeNameOf(当前语义身份)+'.json'
 *    （沿用 login-shop-identity 既有安全文件名规则，从严格原文身份推导）；default.json/另店文件/
 *    不匹配文件一律拒绝写入，不模糊另找目标、不改配置、不新注册表；
 *  - 复用 login-session-persistence 既有能力：结构校验、关键 jinritemai 域/数量相对加载候选
 *    的比较、指纹 CAS 原子提交（startFingerprint 由调用方在本轮加载/扫码开始前捕获，防止
 *    覆盖期间发生的并发新登录写入）；
 *  - 不额外调用 verifySessionReuse：它返回的是**探测上下文**刷新后的 Cookie，不是本次 owned
 *    context 快照；分析器登录事实已由调用方判定成立，检查点在捕获后复验 owned 页面即可；
 *  - 任何失败都不等价于 Cookie 过期（结果恒带 expired:false）：调用方不得据此写
 *    cookie_expired.txt、输出 COOKIE_EXPIRED 或中断已登录的分析流程。
 *
 * AD-COOKIE-FOUR-TIER 补修（2026-10-19）：提交前增加「同一冻结字节」独立新上下文验证
 * （可复用 + 本店；D6 起生产必须显式提供 candidateBrowserFactory，每候选独立浏览器
 * 进程，主浏览器仅作为禁止复用/关闭对象；失败零写入且 expired:false），并在写前保留
 * 上一版 `<target>.prev-*`（fail-closed）。生产调用同时
 * 传 roots/appRoot 时执行 assertAnalyzerWorkTarget，拒绝原始归档/推广恢复/推广工作
 * 目录与另店文件，只允许写分析工作副本。无浏览器且无注入验证器时一律拒绝写回
 * （fail-closed，绝不静默跳过验证；离线调用方必须显式注入可核验验证器）。
 * finalCookies 补修（2026-10-20）：验证上下文访问后平台可能轮换认证 Cookie，两个检查点
 * 写入并返回的唯一集合是验证器返回的 finalCookies（结构校验 + 相对候选不丢关键
 * jinritemai 认证域，确定性序列化 payload 与 expectedPayloadSha256 一致）；finalCookies
 * 缺失/空/结构坏/丢关键域一律 fail-closed 零写入，绝不回退把验证前 captured 交
 * commitCookiesAtomic。
 */

const path = require('path');
const crypto = require('crypto');
const {
  cookiesShapeOk, noCriticalDomainLoss, refreshedCountOk,
  fingerprintOf, commitCookiesAtomic,
} = require('./login-session-persistence');
const {
  collectPageIdentityCandidates, extractShopIdentity, isLoginPageUrl, safeNameOf,
} = require('./login-shop-identity');
const {
  assertAnalyzerWorkTarget, createAnalyzerDefaultVerifier,
} = require('./analyzer-cookie-workcopy');

// 受信抖店商家后台源（与 login-session-persistence 内部常量等值；该模块未导出，此处为本地副本）
const TRUSTED_FXG_ORIGIN_RE = /^https:\/\/fxg\.jinritemai\.com\//;

function checkpointFail(code, reason, extra) {
  return Object.assign({ ok: false, code, reason, expired: false }, extra || {});
}

/** 与持久化完全一致的拟写字节 + 自有 sha256（先冻结字节，再验证，再提交）。 */
function frozenPayloadOf(cookies) {
  const buf = Buffer.from(JSON.stringify(cookies, null, 2), 'utf8');
  return { buf, serialized: buf.toString('utf8'), sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

/**
 * 写前候选独立验证（AD-COOKIE-FOUR-TIER 补修 + D6 进程隔离）：
 *  - 优先使用调用方注入的 precommitVerify（测试/原生注入保持不变）；
 *  - 否则必须显式提供 o.candidateBrowserFactory：验证器为每个候选启动全新浏览器进程，
 *    且主分析浏览器（o.browser / context.browser() / o.forbiddenBrowsers）只作为禁止对象，
 *    **绝不**回退共享主浏览器进程；
 *  - 无工厂/无注入时**拒绝写回**（fail-closed）：绝不返回 null 让生产检查点静默跳过
 *    验证。离线调用方必须显式注入可核验的 precommitVerify（测试不得靠生产跳过验证迁就）。
 *  - 验证成功（ok:true）必须携带验证上下文的最终 Cookie 集合 finalCookies（访问后可能
 *    已被平台轮换）：本函数对其做结构校验并核对相对候选未丢失关键 jinritemai 认证域，
 *    以确定性序列化生成落盘 payload；finalCookies 缺失/空/结构坏/丢关键域一律 fail-closed，
 *    绝不回退写验证前 captured。
 *  - 验证器返回 stopChain:true（关闭未获证明/工厂违约）原样上抛，调用方据此零写入。
 * @returns {Promise<{ok:boolean, stopChain?:boolean, reason?:string, finalCookies?:object[], payload?:object}>}
 */
async function verifyCandidateIfAvailable(o, context, captured, identityName) {
  const payload = frozenPayloadOf(captured);
  let verify = typeof o.precommitVerify === 'function' ? o.precommitVerify : null;
  if (!verify) {
    const forbiddenBrowsers = [];
    if (Array.isArray(o.forbiddenBrowsers)) {
      for (const b of o.forbiddenBrowsers) { if (b) forbiddenBrowsers.push(b); }
    }
    if (o.browser) forbiddenBrowsers.push(o.browser);
    if (context && typeof context.browser === 'function') {
      try {
        const ownedMain = context.browser();
        if (ownedMain) forbiddenBrowsers.push(ownedMain);
      } catch (_) { /* 主浏览器不可得：仅影响禁止集合，不影响工厂要求 */ }
    }
    if (typeof o.candidateBrowserFactory === 'function') {
      const dv = createAnalyzerDefaultVerifier({
        candidateBrowserFactory: o.candidateBrowserFactory,
        forbiddenBrowsers,
        sleep: o.sleep,
        verifyMaxWaitMs: o.verifyMaxWaitMs,
      });
      verify = (cand) => dv({ cookies: cand.cookies, shopSafeName: safeNameOf(identityName) });
    }
  }
  if (!verify) {
    return {
      ok: false,
      reason: '无候选专用浏览器工厂/验证器：无法在独立进程中验证候选可复用性与本店身份（fail-closed，拒绝写入，保留现有工作副本）',
    };
  }
  try {
    const vr = await verify({
      cookies: captured,
      buf: payload.buf,
      serialized: payload.serialized,
      sha256: payload.sha256,
      shopSafeName: safeNameOf(identityName),
    });
    if (!vr || vr.ok !== true) {
      const out = { ok: false, reason: (vr && vr.reason) || '候选未通过独立新上下文复用/店铺验证' };
      if (vr && vr.stopChain === true) out.stopChain = true;
      return out;
    }
    // 唯一允许落盘的是验证上下文最终 Cookie 集合 finalCookies（可能已被平台轮换）：
    // 缺失/空/结构坏/相对候选丢关键 jinritemai 认证域 → fail-closed，绝不回退写验证前 captured。
    if (!cookiesShapeOk(vr.finalCookies)) {
      return { ok: false, reason: '验证器未返回有效 finalCookies（验证上下文最终 Cookie 集合缺失/空/结构坏）：拒绝写入，不回退验证前 captured' };
    }
    if (!noCriticalDomainLoss(captured, vr.finalCookies)) {
      return { ok: false, reason: '验证上下文最终 Cookie 相对候选缺失关键 jinritemai 认证域（疑似会话坍缩）：拒绝写入，不回退验证前 captured' };
    }
    return { ok: true, finalCookies: vr.finalCookies, payload: frozenPayloadOf(vr.finalCookies) };
  } catch (_) {
    return { ok: false, reason: '候选独立验证异常（异常详情可能含敏感值，不回显）' };
  }
}

/**
 * 身份/上下文绑定复验（S76）：page 必须仍属于本次 owned 分析 context 且未关闭。
 * page.context()/isClosed() 任一不可得（非 Playwright 形态）、指向别的 context、
 * 已关闭或调用抛错，都无法证明“取样的页面就是捕获 Cookie 的 context 当前页” → 拒绝。
 * @returns {{ok:false,code:'context_binding',reason:string,expired:false}|null} null 表示绑定成立
 */
function checkContextBinding(context, page, phase) {
  if (typeof page.context !== 'function' || typeof page.isClosed !== 'function') {
    return checkpointFail('context_binding', `${phase}：page 未提供 context()/isClosed()，无法证明身份取样页属于本次分析 context，拒绝写入目标文件`);
  }
  try {
    if (page.context() !== context) {
      return checkpointFail('context_binding', `${phase}：page.context() 与本次分析 context 不一致（页面不属于捕获 Cookie 的 context），拒绝写入目标文件`);
    }
    if (page.isClosed()) {
      return checkpointFail('context_binding', `${phase}：page 已关闭，身份/URL 复验不再可信，拒绝写入目标文件`);
    }
  } catch (e) {
    return checkpointFail('context_binding', `${phase}：context()/isClosed() 复验异常：` + (e && e.message));
  }
  return null;
}

/**
 * 分析器会话检查点保存（扫码与复用登录统一入口）。
 * @param {{context:object, page:object, cookiePath:string,
 *          expectedShopName:string, candidateCookies:object[]|null,
 *          startFingerprint:object, fsModule?:object}} opts
 *   - context/page：本次 owned 分析浏览器上下文与其首页 page（仍在 FXG 后台时调用；
 *     page 必须暴露 context()/isClosed()，Playwright Page 形态）；
 *   - candidateCookies：本轮从目标文件解析出的加载候选（不可解析/非数组传 null，比较跳过）；
 *   - startFingerprint：本轮加载/扫码开始前的目标文件指纹（fingerprintOf 产物，含 sha256）；
 *   - fsModule：可选注入 fs（仅离线测试用）。
 * @returns {Promise<{ok:true, count:number, bytes:number, shopName:string, source:string, expired:boolean}|
 *                   {ok:false, code:string, reason:string, expired:boolean}>}
 *   拒绝码：bad_args / context_binding / capture / shape / identity_error / auth_drift /
 *   identity_no_candidates|identity_conflict|identity_invalid / shop_mismatch / target_mismatch /
 *   domain_loss / cookie_collapse / conflict|shape(提交) / save_error。
 */
async function saveAnalyzerSessionCheckpoint(opts) {
  const o = opts || {};
  const {
    context, page, cookiePath,
    expectedShopName, candidateCookies, startFingerprint,
    fsModule,
  } = o;
  if (!context || !page || !cookiePath || !startFingerprint) {
    return checkpointFail('bad_args', '会话检查点参数不完整（context/page/cookiePath/startFingerprint 缺失）');
  }
  const expected = String(expectedShopName || '').trim();

  // 0) 捕获前绑定复验：page 必须属于本次 owned context 且未关闭，否则后续取样不可信
  const bindBefore = checkContextBinding(context, page, 'Cookie捕获前');
  if (bindBefore) return bindBefore;

  // 1) 取回本次 owned context 的当前 Cookie 快照（要落盘的就是这份，不是探测上下文的）
  let captured;
  try {
    captured = await context.cookies();
  } catch (e) {
    return checkpointFail('capture', '当前会话 Cookie 捕获失败：' + (e && e.message));
  }
  if (!cookiesShapeOk(captured)) {
    return checkpointFail('shape', '当前会话 Cookie 结构异常（空/缺 name/domain/value/path），拒绝写入');
  }

  // 2) 取回之后立即复验当前页面：取样前后 URL 都在受信 FXG 非登录页、无漂移；
  //    异步身份 probe 之后再次复验 context 绑定（捕获与取样之间换 context/关页即拒绝）
  let urlBefore;
  let urlAfter;
  let candidates;
  try {
    urlBefore = String(page.url());
    candidates = await page.evaluate(collectPageIdentityCandidates);
    urlAfter = String(page.url());
  } catch (e) {
    return checkpointFail('identity_error', '当前页面身份复验失败：' + (e && e.message));
  }
  const bindAfter = checkContextBinding(context, page, '身份probe后');
  if (bindAfter) return bindAfter;
  const trustedBefore = TRUSTED_FXG_ORIGIN_RE.test(urlBefore) && !isLoginPageUrl(urlBefore);
  const trustedAfter = TRUSTED_FXG_ORIGIN_RE.test(urlAfter) && !isLoginPageUrl(urlAfter);
  if (!trustedBefore || !trustedAfter) {
    return checkpointFail('auth_drift', `Cookie捕获后页面不在受信抖店后台（${urlAfter.slice(0, 80)}），拒绝写入目标文件`);
  }
  if (urlBefore !== urlAfter) {
    return checkpointFail('auth_drift', `Cookie捕获过程中 URL 漂移（${urlBefore.slice(0, 60)} → ${urlAfter.slice(0, 60)}），拒绝写入目标文件`);
  }
  // 语义身份恒必过（expected 为空也不例外）：无账户ID≠无身份，任何保存都必须有
  // 当前严格语义身份唯一有效，绝不以 shopNameArg/getShopNameFromPage 回退当证据。
  const identity = extractShopIdentity(candidates);
  if (!identity.ok) {
    return checkpointFail('identity_' + identity.code, `未取得当前唯一语义身份（无账户ID/新店名也不例外，无账户ID≠无身份）：` + identity.reason);
  }
  if (expected && identity.name !== expected) {
    return checkpointFail('shop_mismatch', `页面语义身份 ${JSON.stringify(identity.name)} 与目标店铺 ${JSON.stringify(expected)} 不一致，拒绝写入目标文件`);
  }
  // 目标文件名与身份绑定（S76）：basename 必须精确等于当前语义身份的安全文件名推导结果；
  // 另店文件/default.json/改名文件均拒绝，不做模糊另找、不给空身份特例放行。
  const safeTargetBase = safeNameOf(identity.name) + '.json';
  const targetBase = path.basename(cookiePath);
  if (targetBase !== safeTargetBase) {
    return checkpointFail('target_mismatch', `目标文件 ${JSON.stringify(targetBase)} 与当前语义身份 ${JSON.stringify(identity.name)} 的安全文件名 ${JSON.stringify(safeTargetBase)} 不符（另店/default/改名文件），拒绝写入；不另行挑选目标文件`);
  }

  // 3) 相对加载候选的比较：关键 jinritemai 域不丢、数量不坍缩（候选不可解析时仅保留指纹保护）
  if (Array.isArray(candidateCookies)) {
    if (!noCriticalDomainLoss(candidateCookies, captured)) {
      return checkpointFail('domain_loss', '当前会话相对加载时候选缺失关键 jinritemai 域（疑似会话坍缩），拒绝写入');
    }
    if (!refreshedCountOk(candidateCookies, captured)) {
      return checkpointFail('cookie_collapse', `当前会话 Cookie 数量相对候选坍缩（候选 ${candidateCookies.length} → 当前 ${captured.length}），拒绝写入`);
    }
  }

  // 3.5) 仅分析工作副本可写：生产调用传入 roots/appRoot 时执行四层门禁
  //（拒绝原始归档/推广恢复目录/推广工作目录/另店文件/符号链接）；不改变既有调用语义。
  if (o.roots || o.appRoot) {
    try {
      assertAnalyzerWorkTarget(cookiePath, {
        roots: o.roots, appRoot: o.appRoot, shopSafeName: safeNameOf(identity.name), fsModule,
      });
    } catch (e) {
      return checkpointFail('target_mismatch', '目标文件未通过分析工作副本门禁：' + ((e && e.message) || e));
    }
  }

  // 3.6) 先独立验证拟写入的同一冻结字节（可复用 + 正确店铺），失败零写入、旧副本保留
  const verified = await verifyCandidateIfAvailable(o, context, captured, identity.name);
  if (!verified || verified.ok !== true) {
    return checkpointFail(
      'candidate_verify',
      `候选未通过独立进程/新上下文复用/店铺验证：${(verified && verified.reason) || '验证器不可用'}（保留现有工作副本，未写入）`,
      verified && verified.stopChain === true ? { stopChain: true } : null,
    );
  }
  // 唯一落盘集合是验证上下文最终 finalCookies（可能已被平台轮换）：禁止把验证前 captured 交原子提交。
  const finalCookies = verified.finalCookies;
  const payload = verified.payload;

  // 4) 指纹 CAS 原子提交（同一冻结字节 + 写前备份旧版）：基线是本轮加载/扫码前的
  //    startFingerprint，期间出现更新的登录写入即拒绝。
  let commit;
  try {
    commit = commitCookiesAtomic(cookiePath, finalCookies, {
      fingerprint: startFingerprint,
      fsModule,
      expectedPayloadSha256: payload.sha256,
      backupPrev: true,
    });
  } catch (e) {
    // commitCookiesAtomic 在 rename 已生效后回读失败/发现并发新内容也会抛错：此时无法确认
    // 目标文件字节是否已变，绝不声称“旧字节保持不变”，也不回滚/覆盖并发内容、不假报成功。
    return checkpointFail('save_error', 'Cookie 保存失败（写盘异常，rename 可能已生效或存在并发更新，无法确认目标文件当前字节；不回滚、不覆盖并发内容）：' + (e && e.message));
  }
  if (!commit.ok) {
    return checkpointFail(commit.code, commit.reason + '；目标文件字节保持不变');
  }
  // R87：仅当落盘字节确为本轮已验证冻结快照（提交返回的 own sha256 与当前落盘 sha256 逐字节
  // 一致）才暴露 ownedFingerprint/ownedCookies，供调用方推进本轮运行基线/候选；否则两者为 null，
  // 绝不重新读取任意"最新文件"当新基线（外部并发新 Cookie 必须被保留，不切基线）。
  let ownedFingerprint = null;
  try {
    const onDisk = fingerprintOf(cookiePath, fsModule);
    if (onDisk.exists === true && commit.sha256 && onDisk.sha256 === commit.sha256) {
      ownedFingerprint = onDisk;
    }
  } catch (_) { ownedFingerprint = null; }
  return {
    ok: true,
    expired: false,
    count: commit.count,
    bytes: commit.bytes,
    shopName: identity.name,
    source: identity.source,
    ownedFingerprint,
    ownedCookies: ownedFingerprint ? finalCookies : null,
    backupPath: commit.backupPath || null,
  };
}

// ── 电商罗盘（compass）经营页收尾保存（R87）───────────────────────────────
// 缺口：douyin-shop-analyzer 只在离开 FXG 前保存一次会话，随后走完整罗盘全流程直到 finally
// 关浏览器，期间刷新的 Cookie 从未回写。本函数在关闭前以**当前时刻**事实重新核验罗盘经营页
// 的严格语义店铺名身份后保存；不新增导航、不强行回 FGX、不放宽 URL 或变为任意网页。
// 与 FXG 检查点同口径的绑定：context 绑定、可信 /shop 页、唯一可见 [class*=userName] 店名、
// 目标文件名与语义身份安全文件名绑定、相对加载候选的域/数量比较、加载前指纹 CAS 原子提交。

const COMPASS_HOST = 'compass.jinritemai.com';
const COMPASS_PATH_RE = /^\/shop(?:\/|$)/;
const COMPASS_LOGIN_RE = /\/login|\/passport|\/signin|sso\.jinritemai/i;

/** 严格可信罗盘经营页判定（URL 解析，绝不子串匹配）。 */
function isTrustedCompassUrl(u) {
  if (typeof u !== 'string' || u.length === 0) return false;
  let p;
  try { p = new URL(u); } catch (_) { return false; }
  if (p.origin !== `https://${COMPASS_HOST}`) return false;
  if (COMPASS_LOGIN_RE.test(p.pathname)) return false;
  return COMPASS_PATH_RE.test(p.pathname);
}

/**
 * 罗盘右侧身份候选收集（自包含：会被序列化进真实页面 evaluate 执行，不能引用闭包）。
 * 只认可见 [class*="userName"] 叶子文本（与 compass-order-reader 读法同口径）；可见性
 * fail-closed（rect 抛错/0 尺寸/display:none/visibility:hidden 一律不可见）；绝不做坐标扫描/
 * 正文兜底/"返回旧版"式黑名单。
 */
function collectCompassShopNameCandidates() {
  return (function () {
    const out = [];
    const doc = (typeof document !== 'undefined' && document) ? document : null;
    if (!doc || typeof doc.querySelectorAll !== 'function') return out;
    const visible = (el) => {
      let r;
      try { r = el.getBoundingClientRect(); } catch (_) { return false; }
      if (!r || !(r.width > 0 && r.height > 0)) return false;
      if (typeof getComputedStyle === 'function') {
        let cs;
        try { cs = getComputedStyle(el); } catch (_) { cs = null; }
        if (cs) {
          if (String(cs.display || '').toLowerCase() === 'none') return false;
          if (String(cs.visibility || '').toLowerCase() === 'hidden') return false;
        }
      }
      return true;
    };
    const els = doc.querySelectorAll('[class*="userName"]');
    for (let i = 0; i < els.length; i += 1) {
      const el = els[i];
      if (!visible(el)) continue;
      const t = String((el.textContent || '')).replace(/\s+/g, ' ').trim();
      if (t) out.push({ source: 'compass-userName', text: t });
    }
    return out;
  })();
}

/** 从罗盘候选提取唯一语义店名（仅 trim；多候选不同 → conflict；缺失 → no_candidates）。 */
function extractCompassShopName(candidates) {
  const list = Array.isArray(candidates)
    ? candidates.filter((c) => c && c.source === 'compass-userName' && typeof c.text === 'string')
    : [];
  const names = [...new Set(list.map((c) => String(c.text).trim()).filter((t) => t.length > 0))];
  if (names.length === 0) return { ok: false, code: 'no_candidates', reason: '罗盘页未取得可见 [class*=userName] 语义店铺名（未加载/未登录/结构不符）' };
  if (names.length > 1) return { ok: false, code: 'conflict', reason: `罗盘页可见店铺名候选冲突（${names.map((x) => JSON.stringify(x)).join('、')}）` };
  return { ok: true, name: names[0] };
}

/**
 * 分析器罗盘收尾会话检查点（关闭前调用）。
 * @param {{context:object, page:object, cookiePath:string, expectedShopName:string,
 *          candidateCookies:object[]|null, startFingerprint:object, fsModule?:object}} opts
 * @returns {Promise<{ok:true, expired:boolean, count:number, bytes:number, shopName:string,
 *                    ownedFingerprint:object|null, ownedCookies:object[]|null}|
 *                   {ok:false, code:string, reason:string, expired:boolean}>}
 */
async function saveAnalyzerCompassCheckpoint(opts) {
  const o = opts || {};
  const {
    context, page, cookiePath, expectedShopName, candidateCookies, startFingerprint, fsModule,
  } = o;
  if (!context || !page || !cookiePath || !startFingerprint) {
    return checkpointFail('bad_args', '罗盘收尾检查点参数不完整（context/page/cookiePath/startFingerprint 缺失）');
  }
  const expected = String(expectedShopName || '').trim();

  const bindBefore = checkContextBinding(context, page, 'Cookie捕获前');
  if (bindBefore) return bindBefore;

  let captured;
  try {
    captured = await context.cookies();
  } catch (e) {
    return checkpointFail('capture', '当前会话 Cookie 捕获失败：' + (e && e.message));
  }
  if (!cookiesShapeOk(captured)) {
    return checkpointFail('shape', '当前会话 Cookie 结构异常（空/缺 name/domain/value/path），拒绝写入');
  }

  let urlBefore;
  let urlAfter;
  let candidates;
  try {
    urlBefore = String(page.url());
    candidates = await page.evaluate(collectCompassShopNameCandidates);
    urlAfter = String(page.url());
  } catch (e) {
    return checkpointFail('identity_error', '当前罗盘页身份复验失败：' + (e && e.message));
  }
  const bindAfter = checkContextBinding(context, page, '身份probe后');
  if (bindAfter) return bindAfter;
  const trustedBefore = isTrustedCompassUrl(urlBefore);
  const trustedAfter = isTrustedCompassUrl(urlAfter);
  // 当前页不是可信罗盘经营页（登录页/中转/伪域/任意路径/FXG 等）→ 安全跳过，绝不导航补正。
  if (!trustedBefore || !trustedAfter) {
    return checkpointFail('not_trusted_page', `当前页不是可信罗盘经营页 /shop（${urlAfter.slice(0, 80)}），安全跳过收尾保存（不新增导航）`);
  }
  if (urlBefore !== urlAfter) {
    return checkpointFail('auth_drift', `Cookie捕获过程中罗盘页 URL 漂移（${urlBefore.slice(0, 60)} → ${urlAfter.slice(0, 60)}），拒绝写入目标文件`);
  }
  const identity = extractCompassShopName(candidates);
  if (!identity.ok) return checkpointFail('identity_' + identity.code, identity.reason);
  if (expected && identity.name !== expected) {
    return checkpointFail('shop_mismatch', `罗盘页语义身份 ${JSON.stringify(identity.name)} 与目标店铺 ${JSON.stringify(expected)} 不一致，拒绝写入目标文件`);
  }
  const safeTargetBase = safeNameOf(identity.name) + '.json';
  const targetBase = path.basename(cookiePath);
  if (targetBase !== safeTargetBase) {
    return checkpointFail('target_mismatch', `目标文件 ${JSON.stringify(targetBase)} 与罗盘语义身份 ${JSON.stringify(identity.name)} 的安全文件名 ${JSON.stringify(safeTargetBase)} 不符（跨店/default/改错文件），拒绝写入`);
  }
  if (Array.isArray(candidateCookies)) {
    if (!noCriticalDomainLoss(candidateCookies, captured)) {
      return checkpointFail('domain_loss', '当前会话相对加载候选缺失关键 jinritemai 域（疑似会话坍缩），拒绝写入');
    }
    if (!refreshedCountOk(candidateCookies, captured)) {
      return checkpointFail('cookie_collapse', `当前会话 Cookie 数量相对候选坍缩（候选 ${candidateCookies.length} → 当前 ${captured.length}），拒绝写入`);
    }
  }

  // 仅分析工作副本可写（生产传入 roots/appRoot 时执行四层门禁）
  if (o.roots || o.appRoot) {
    try {
      assertAnalyzerWorkTarget(cookiePath, {
        roots: o.roots, appRoot: o.appRoot, shopSafeName: safeNameOf(identity.name), fsModule,
      });
    } catch (e) {
      return checkpointFail('target_mismatch', '目标文件未通过分析工作副本门禁：' + ((e && e.message) || e));
    }
  }
  // 先独立验证同一冻结字节（可复用 + 正确店铺），失败零写入、旧副本保留
  const verified = await verifyCandidateIfAvailable(o, context, captured, identity.name);
  if (!verified || verified.ok !== true) {
    return checkpointFail(
      'candidate_verify',
      `候选未通过独立进程/新上下文复用/店铺验证：${(verified && verified.reason) || '验证器不可用'}（保留现有工作副本，未写入）`,
      verified && verified.stopChain === true ? { stopChain: true } : null,
    );
  }
  // 唯一落盘集合是验证上下文最终 finalCookies（可能已被平台轮换）：禁止把验证前 captured 交原子提交。
  const finalCookies = verified.finalCookies;
  const payload = verified.payload;

  let commit;
  try {
    commit = commitCookiesAtomic(cookiePath, finalCookies, {
      fingerprint: startFingerprint,
      fsModule,
      expectedPayloadSha256: payload.sha256,
      backupPrev: true,
    });
  } catch (e) {
    return checkpointFail('save_error', 'Cookie 保存失败（写盘异常，rename 可能已生效或存在并发更新，无法确认目标文件当前字节；不回滚、不覆盖并发内容）：' + (e && e.message));
  }
  if (!commit.ok) {
    return checkpointFail(commit.code, commit.reason + '；目标文件字节保持不变');
  }
  let ownedFingerprint = null;
  try {
    const onDisk = fingerprintOf(cookiePath, fsModule);
    if (onDisk.exists === true && commit.sha256 && onDisk.sha256 === commit.sha256) {
      ownedFingerprint = onDisk;
    }
  } catch (_) { ownedFingerprint = null; }
  return {
    ok: true,
    expired: false,
    count: commit.count,
    bytes: commit.bytes,
    shopName: identity.name,
    ownedFingerprint,
    ownedCookies: ownedFingerprint ? finalCookies : null,
    backupPath: commit.backupPath || null,
  };
}

module.exports = {
  TRUSTED_FXG_ORIGIN_RE,
  checkContextBinding,
  isTrustedCompassUrl,
  collectCompassShopNameCandidates,
  extractCompassShopName,
  saveAnalyzerSessionCheckpoint,
  saveAnalyzerCompassCheckpoint,
};
