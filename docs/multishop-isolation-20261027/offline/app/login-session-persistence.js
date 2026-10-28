'use strict';
/**
 * login-session-persistence.js — 登录会话持久化：复用校验 + 原子提交（LOGIN-REUSE-1，2026-10-15）。
 *
 * 背景：旧 login-shop.js 在拿到首页 URL + 语义店名后立即抓 Cookie 落盘并上报成功，
 * 从不验证“保存的 Cookie 能否在全新上下文中再次登录”。此前保存的 JinCookie
 * （10-15 16:06，JSON/结构有效、无显式过期）实际无法复用，服务端失效原因未知——
 * 本模块不改写因果，只把“保存时可复用”变成落盘前置条件。
 *
 * 规则（主脑要求逐条落实）：
 *  - 登录完成 URL ≠ 登录成功：候选 Cookie 先在内存中捕获，再在同浏览器的隔离新上下文
 *    （同视口/时区、无其它 Cookie）里注入并访问抖店首页，要求受信 https FXG 源、
 *    非登录页、语义身份与原店铺一致，且两次读取（间隔轮询周期）稳定，才算复用通过；
 *    初始 URL 到位本身不算通过；SSO 跳转瞬态在时限内容忍；
 *  - 校验通过后返回**新上下文刷新后的** Cookie（非候选旧快照）；抓取后会重新校验当前页面
 *    仍是受信 FXG 非登录首页且语义身份一致（URL/身份在抓取期间漂移即拒绝、不写 Cookie）；
 *    刷新数组须通过结构校验、不丢关键 jinritemai 域、且不相对候选数量坍缩（<60%）；
 *    探测上下文用毕必关，原浏览器/上下文由调用方生命周期管理；
 *  - 落盘仅在证明之后：同目录独占临时文件 + fsync + rename + 回读比对；指纹携带实际字节
 *    sha256，写临时文件前与 fsync 之后、rename 之前各重检一次——期间出现更新的登录写入即拒绝
 *    覆盖、清理自有临时文件并保留并发新字节；回读不一致绝不报告成功；
 *  - 不合并宽泛 Cookie、不输出 Cookie 值、无全局旁路；fs 依赖可注入仅供离线测试。
 */

const fsDefault = require('fs');
const crypto = require('crypto');

const FXG_HOME_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const TRUSTED_FXG_ORIGIN_RE = /^https:\/\/fxg\.jinritemai\.com\//;
// 刷新后 Cookie 数量不得低于候选的这一比例（防同域会话坍缩，如 6→1）。
const MIN_REFRESH_KEEP_RATIO = 0.6;

// 新交接/自有探测路径的失败原因一律使用固定安全文案：底层异常消息可能携带
// URL、令牌或 Cookie 片段，绝不拼进返回值/日志。
const SAFE_FAILURE_REASONS = Object.freeze({
  bad_args: '复用校验参数不完整',
  capture: '候选 Cookie 捕获失败，拒绝继续（未落盘）',
  shape: 'Cookie 结构异常（空/缺 name/domain/value/path），拒绝注入与落盘',
  reuse_unverified: '新会话未获得稳定的受信任店铺身份，拒绝落盘',
  auth_drift: 'Cookie 抓取后会话发生漂移，拒绝落盘',
  domain_loss: '复用校验后 Cookie 缺失关键 jinritemai 域，拒绝落盘',
  cookie_collapse: '复用校验后 Cookie 数量相对候选坍缩，拒绝落盘',
  cookie_drift: '身份复验期间 Cookie 或页面发生变化，拒绝提交较早快照',
  error: '复用校验异常，拒绝落盘',
  probe_launch: '创建独立探测浏览器失败或探测对象不是全新进程，拒绝继续（未落盘）',
  probe_close: '独立探测浏览器进程未能确认关闭，拒绝返回 Cookie（避免遗留自有进程）',
  handoff_close: '关闭扫码源上下文/进程失败或未能证明已退出，拒绝继续（避免双活）',
  final_reuse_unverified: '最终独立复用校验未通过，拒绝落盘',
});

function safeFailureReason(code) {
  return SAFE_FAILURE_REASONS[code] || '复用/交接校验未通过，拒绝落盘';
}

/** Cookie 数组形态校验（仅结构，不看值）：非空 + name/domain/path 为非空字符串、value 为字符串。 */
function cookiesShapeOk(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return false;
  return cookies.every((c) => c
    && typeof c.name === 'string' && c.name.length > 0
    && typeof c.value === 'string'
    && typeof c.domain === 'string' && c.domain.length > 0
    && typeof c.path === 'string');
}

/** 收集 jinritemai.com 系关键域名集合（小写、去前导点）。 */
function jinritemaiDomains(cookies) {
  const set = new Set();
  for (const c of Array.isArray(cookies) ? cookies : []) {
    const d = String((c && c.domain) || '').replace(/^\./, '').toLowerCase();
    if (/(^|\.)jinritemai\.com$/.test(d)) set.add(d);
  }
  return set;
}

/** 刷新后的 Cookie 不得相对候选丢失既有关键 jinritemai 域（防会话坍缩）。 */
function noCriticalDomainLoss(candidate, refreshed) {
  const before = jinritemaiDomains(candidate);
  const after = jinritemaiDomains(refreshed);
  for (const d of before) {
    if (!after.has(d)) return false;
  }
  return true;
}

/** 刷新后 Cookie 数量不得相对候选坍缩（即便关键域仍在，条数骤降也视为会话异常）。 */
function refreshedCountOk(candidate, refreshed) {
  if (!Array.isArray(refreshed)) return false;
  if (!Array.isArray(candidate) || candidate.length === 0) return refreshed.length > 0;
  const need = Math.ceil(candidate.length * MIN_REFRESH_KEEP_RATIO);
  return refreshed.length >= need;
}

/**
 * 目标文件指纹（写入保护用）：携带实际字节 sha256，而非仅 size/mtime；
 * absent 标记区分文件不存在。同尺寸同 mtime 但字节不同也能被 sha256 辨出。
 */
function fingerprintOf(filePath, fsMod) {
  const fsm = fsMod || fsDefault;
  try {
    const st = fsm.statSync(filePath);
    const hash = crypto.createHash('sha256');
    hash.update(fsm.readFileSync(filePath));
    return { exists: true, size: st.size, mtimeMs: st.mtimeMs, sha256: hash.digest('hex') };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { exists: false, size: null, mtimeMs: null, sha256: null };
    throw e;
  }
}

function sameFingerprint(a, b) {
  if (!a || !b) return false;
  if (Boolean(a.exists) !== Boolean(b.exists)) return false;
  if (!a.exists) return true;
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.sha256 === b.sha256;
}

/**
 * 写前保留上一版（独占创建 + fsync + 回读逐字节比对）；失败即放弃提交（fail-closed）。
 * 备份名不含 .json 后缀，不会被店铺 *.json 扫描误认。
 */
function backupExistingExact(fsm, cookiePath, buf) {
  const backupPath = `${cookiePath}.prev-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  let fd = null;
  try {
    fd = fsm.openSync(backupPath, 'wx', 0o600);
    fsm.writeSync(fd, buf);
    fsm.fsyncSync(fd);
    fsm.closeSync(fd);
    fd = null;
  } catch (e) {
    if (fd !== null) { try { fsm.closeSync(fd); } catch (_) { /* ignore */ } }
    try { fsm.unlinkSync(backupPath); } catch (_) { /* 只清自有备份 */ }
    return { ok: false, reason: (e && e.message) || String(e) };
  }
  try {
    const back = fsm.readFileSync(backupPath);
    if (!back.equals(buf)) return { ok: false, reason: '备份文件回读与上一版字节不一致' };
  } catch (e) {
    return { ok: false, reason: `备份文件无法回读（${(e && e.message) || e}）` };
  }
  return { ok: true, backupPath };
}

/**
 * 原子提交已验证 Cookie 到目标文件。
 * 保护流程：
 *  0) 可选 expectedPayloadSha256：拟写字节必须与本次已验证冻结快照逐字节一致（不一致零写入）；
 *  0.5) 可选 backupPrev：写前把上一版独占备份到 <target>.prev-*（失败即放弃提交）；
 *  1) 写临时文件前重检目标指纹（捕获校验/复用期间更新的登录写入）；
 *  2) 独占创建自有临时文件（'wx'）→ 写 → fsync → close；
 *  3) fsync/close 之后、rename 之前立即重检指纹（捕获 fsync 窗口内的并发写入）——
 *     不一致则删除自有临时文件、保留并发新字节、返回 conflict；
 *  4) rename → 回读比对；回读字节与预期不一致时绝不报告成功：无法断言“仍是我们写入的字节”
 *     （rename 之后被并发更新）时如实抛错，交由主流程按写盘失败处理，不破坏并发文件。
 * 任意 rename 前异常/写盘异常均不触碰旧字节，只清理本进程自有临时文件。
 * @returns {{ok:true, bytes:number, count:number, sha256:string, backupPath?:string}
 *          |{ok:false, code:'conflict'|'shape'|'payload_mismatch'|'backup_failed', reason:string}}
 */
function commitCookiesAtomic(cookiePath, cookies, opts) {
  const o = opts || {};
  const fsm = o.fsModule || fsDefault;
  const expected = o.fingerprint || fingerprintOf(cookiePath, fsm);
  if (!cookiesShapeOk(cookies)) {
    return { ok: false, code: 'shape', reason: 'Cookie 结构校验失败（空/缺 name/domain/value/path）' };
  }
  const payload = JSON.stringify(cookies, null, 2);
  const payloadSha = crypto.createHash('sha256').update(payload).digest('hex');
  if (typeof o.expectedPayloadSha256 === 'string' && o.expectedPayloadSha256.trim()
    && payloadSha !== o.expectedPayloadSha256.trim()) {
    return { ok: false, code: 'payload_mismatch', reason: '待写字节与本次已验证冻结快照 sha256 不一致：拒绝写入（不落未验证内容）' };
  }
  // (1) 写临时文件前的指纹重检
  if (!sameFingerprint(expected, fingerprintOf(cookiePath, fsm))) {
    return { ok: false, code: 'conflict', reason: '目标 Cookie 文件在校验期间被更新（存在更新的登录写入），拒绝覆盖以保护新文件' };
  }
  let backupPath = null;
  if (o.backupPrev === true) {
    const cur = fingerprintOf(cookiePath, fsm);
    if (cur.exists) {
      let prevBuf;
      try { prevBuf = fsm.readFileSync(cookiePath); } catch (e) {
        return { ok: false, code: 'backup_failed', reason: `写前读取上一版失败（${(e && e.message) || e}）：放弃提交` };
      }
      const bk = backupExistingExact(fsm, cookiePath, prevBuf);
      if (!bk.ok) return { ok: false, code: 'backup_failed', reason: `写前备份上一版失败（${bk.reason}）：放弃提交` };
      backupPath = bk.backupPath;
    }
  }
  const tmp = `${cookiePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  let fd;
  let owned = false;
  try {
    fd = fsm.openSync(tmp, 'wx'); // 独占创建，确保临时文件归本进程所有
    owned = true;
    fsm.writeSync(fd, payload);
    fsm.fsyncSync(fd);
  } catch (e) {
    if (fd !== undefined) { try { fsm.closeSync(fd); } catch (e2) { /* 忽略 */ } }
    if (owned) { try { fsm.unlinkSync(tmp); } catch (e2) { /* 只清自有临时文件 */ } }
    throw e; // 写盘异常：清理自有临时文件，旧字节保持不变，抛出交由主流程 COOKIE_SAVE_FAILED
  }
  try {
    fsm.closeSync(fd);
  } catch (e) {
    try { fsm.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
    throw e;
  }
  // (3) fsync/close 之后、rename 之前立即重检指纹
  if (!sameFingerprint(expected, fingerprintOf(cookiePath, fsm))) {
    try { fsm.unlinkSync(tmp); } catch (e2) { /* 只清自有临时文件 */ }
    return { ok: false, code: 'conflict', reason: '目标 Cookie 文件在提交窗口内（fsync 期间）被更新，拒绝覆盖以保护并发新文件' };
  }
  try {
    fsm.renameSync(tmp, cookiePath);
  } catch (e) {
    try { fsm.unlinkSync(tmp); } catch (e2) { /* 忽略 */ }
    throw e; // rename 失败：旧文件未动，清理自有临时文件后抛出
  }
  // (4) rename 之后回读比对：不一致绝不报告成功
  let readBack;
  try {
    readBack = fsm.readFileSync(cookiePath, 'utf8');
  } catch (e) {
    throw new Error('Cookie 提交后无法回读，不能断言写入生效（拒绝报告成功）');
  }
  if (readBack !== payload) {
    // 当前字节不是我们刚写入的 payload → rename 之后发生并发更新；
    // 无法断言“仍是我们写入的字节”，故不回滚、不覆盖并发文件，如实抛错（主流程按写盘失败处理）。
    throw new Error('Cookie 提交后回读与预期不一致，检测到并发新内容，拒绝报告成功（不覆盖并发文件）');
  }
  let parsed = null;
  try { parsed = JSON.parse(readBack); } catch (e) { /* 回读解析失败 */ }
  if (!Array.isArray(parsed) || parsed.length !== cookies.length) {
    throw new Error('Cookie 提交后回读解析与预期不一致，拒绝报告成功');
  }
  // R87：一并返回**实际写入字节**的 sha256，供调用方仅在落盘哈希与之逐字节一致时推进自有
  // 运行基线/候选（绝不重新读取任意"最新文件"当新基线）。不影响既有 ok/bytes/count 契约。
  return {
    ok: true,
    bytes: Buffer.byteLength(payload),
    count: cookies.length,
    sha256: payloadSha,
    ...(backupPath ? { backupPath } : {}),
  };
}

/**
 * 候选会话复用校验：在同一个浏览器里开隔离新上下文（同视口/时区），注入原上下文
 * 刚捕获的候选 Cookie，访问抖店首页，做有界被动等待，要求非登录页 + 语义身份与
 * 原店铺一致且两次读取稳定。通过则返回**新上下文刷新后的** Cookie 数组。
 *
 * 调用方传入自己拥有的 browser/context（QR 原上下文，保持存活）、原店铺身份及
 * 既有身份函数（collect/extract/isLoginPageUrl）与 sleep（可注入假时钟）。
 * @param {{browser:object, context:object, expectedShopName:string,
 *          collectPageIdentityCandidates:Function, extractShopIdentity:Function,
 *          isLoginPageUrl:Function, viewport?:object, timezoneId?:string,
 *          homeUrl?:string, maxWaitMs?:number, pollIntervalMs?:number,
 *          navTimeoutMs?:number, assertLive?:Function, sleep:Function}} opts
 * @returns {Promise<{ok:true, cookies:object[]}|{ok:false, code:string, reason:string}>}
 */
async function verifySessionReuse(opts) {
  const o = opts || {};
  const {
    browser, context, expectedShopName,
    collectPageIdentityCandidates, extractShopIdentity, isLoginPageUrl,
    homeUrl = FXG_HOME_URL,
    viewport, timezoneId,
    maxWaitMs = 45000, pollIntervalMs = 2000,
    navTimeoutMs = 60000,
    deadline, now = Date.now,
    assertLive,
    sleep,
  } = o;
  if (!browser || !context || !expectedShopName
    || !collectPageIdentityCandidates || !extractShopIdentity || !isLoginPageUrl || !sleep) {
    return { ok: false, code: 'bad_args', reason: '复用校验参数不完整' };
  }
  if (assertLive != null && typeof assertLive !== 'function') {
    return { ok: false, code: 'bad_args', reason: '复用校验参数不完整（assertLive 必须是函数）' };
  }
  let candidate;
  try {
    candidate = await context.cookies();
  } catch (e) {
    return { ok: false, code: 'capture', reason: '候选 Cookie 捕获失败：' + e.message };
  }
  // 注入前校验候选结构：非空 + name/value/domain/path 合法（损坏候选不注入、不落盘）
  if (!cookiesShapeOk(candidate)) {
    return { ok: false, code: 'shape', reason: '候选 Cookie 结构异常（空/缺 name/domain/value/path），拒绝注入与落盘' };
  }
  let probeContext = null;
  // 每次轮询前给调用方一个有界检查点（取消/超时）；清理仍在 finally 完成，绝不假取消。
  const checkLive = () => { if (typeof assertLive === 'function') assertLive(); };
  const remainingMs = () => (deadline == null ? null : Math.max(0, deadline - now()));
  try {
    checkLive();
    // 有界导航：已配置 navTimeoutMs 仍然生效，但绝不越过外层剩余期限。
    const navBudget = deadline == null ? navTimeoutMs : Math.max(1, Math.min(navTimeoutMs, deadline - now()));
    if (deadline != null && remainingMs() <= 0) {
      return { ok: false, code: 'reuse_unverified', reason: '复用校验已用尽剩余期限' };
    }
    const ctxOpts = {};
    if (viewport) ctxOpts.viewport = viewport;
    if (timezoneId) ctxOpts.timezoneId = timezoneId;
    probeContext = await browser.newContext(ctxOpts);
    await probeContext.addCookies(candidate);
    const probePage = await probeContext.newPage();
    await probePage.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: navBudget });

    // 身份轮询同样受剩余期限约束（已注入的 maxWaitMs/pollIntervalMs 不被放大）。
    const waitBudget = deadline == null ? maxWaitMs : Math.max(0, Math.min(maxWaitMs, deadline - now()));
    const maxAttempts = Math.max(1, Math.ceil(waitBudget / pollIntervalMs));
    let goodReads = 0;
    let verified = false;
    let reason = '未在受信任抖店首页获得稳定身份';
    for (let i = 0; i < maxAttempts; i++) {
      checkLive();
      if (deadline != null && now() >= deadline) {
        reason = '复用校验已用尽剩余期限';
        break;
      }
      if (i > 0) {
        const snooze = deadline == null ? pollIntervalMs : Math.max(0, Math.min(pollIntervalMs, deadline - now()));
        if (snooze > 0) await sleep(snooze);
      }
      const url = String(probePage.url());
      if (TRUSTED_FXG_ORIGIN_RE.test(url) && !isLoginPageUrl(url)) {
        const candidates = await probePage.evaluate(collectPageIdentityCandidates);
        const identity = extractShopIdentity(candidates);
        if (identity.ok && identity.name === expectedShopName) {
          goodReads += 1;
          if (goodReads >= 2) { verified = true; break; }
          continue; // 首次一致读取，等待下一轮间隔后的确认读取
        }
        if (identity.ok) {
          reason = `新会话身份与原店铺不一致（${JSON.stringify(identity.name)} ≠ ${JSON.stringify(expectedShopName)}）`;
        } else {
          reason = '新会话未确认身份：' + identity.reason;
        }
      } else {
        reason = `新会话仍在登录/非受信页面（${url.slice(0, 80)}）`;
      }
      goodReads = 0; // 非稳定读取即重置（两次一致读取须连续、隔轮询间隔）
    }
    if (!verified) {
      return { ok: false, code: 'reuse_unverified', reason: reason + `（${Math.min(maxAttempts * pollIntervalMs, maxWaitMs) / 1000 | 0}s 内）` };
    }
    // 抓取探测上下文刷新后的 Cookie（非候选旧快照）
    checkLive();
    const refreshed = await probeContext.cookies();
    // 关键：抓取 Cookie 之后，重新校验“当前”页面仍是受信 FXG 非登录首页且语义身份与原店铺一致。
    // 取样 evaluate 前后 URL——若抓取期间发生 URL 或身份漂移 → 拒绝，不写 Cookie。
    const urlBeforeEval = String(probePage.url());
    const postCandidates = await probePage.evaluate(collectPageIdentityCandidates);
    const urlAfterEval = String(probePage.url());
    const trustedNow = TRUSTED_FXG_ORIGIN_RE.test(urlBeforeEval) && !isLoginPageUrl(urlBeforeEval)
      && TRUSTED_FXG_ORIGIN_RE.test(urlAfterEval) && !isLoginPageUrl(urlAfterEval);
    const urlDrift = urlBeforeEval !== urlAfterEval;
    const postIdentity = extractShopIdentity(postCandidates);
    const identityOk = postIdentity.ok && postIdentity.name === expectedShopName;
    if (!trustedNow || urlDrift || !identityOk) {
      let drift;
      if (!trustedNow) drift = `Cookie 抓取后会话漂移到登录/非受信页面（${urlAfterEval.slice(0, 80)}）`;
      else if (urlDrift) drift = `Cookie 抓取过程中 URL 漂移（${urlBeforeEval.slice(0, 60)} → ${urlAfterEval.slice(0, 60)}）`;
      else drift = `Cookie 抓取后身份漂移（${postIdentity.ok ? JSON.stringify(postIdentity.name) : postIdentity.reason} ≠ ${JSON.stringify(expectedShopName)}）`;
      return { ok: false, code: 'auth_drift', reason: drift + '，拒绝落盘' };
    }
    if (!cookiesShapeOk(refreshed)) {
      return { ok: false, code: 'shape', reason: '复用校验后 Cookie 结构异常，拒绝落盘' };
    }
    if (!noCriticalDomainLoss(candidate, refreshed)) {
      return { ok: false, code: 'domain_loss', reason: '复用校验后 Cookie 相对候选缺失关键 jinritemai 域（疑似会话坍缩），拒绝落盘' };
    }
    if (!refreshedCountOk(candidate, refreshed)) {
      return { ok: false, code: 'cookie_collapse', reason: `复用校验后 Cookie 数量相对候选坍缩（${candidate.length}→${refreshed.length}，低于候选的 ${Math.round(MIN_REFRESH_KEEP_RATIO * 100)}%），拒绝落盘` };
    }
    const finalCookies = await probeContext.cookies();
    if (JSON.stringify(finalCookies) !== JSON.stringify(refreshed) || String(probePage.url()) !== urlAfterEval) {
      return { ok: false, code: 'cookie_drift', reason: '身份复验期间 Cookie 或页面发生变化：拒绝提交较早快照' };
    }
    await probeContext.close();
    probeContext = null;
    // 仅返回最近一次已验证的刷新 Cookie；不声明未来有效期保证。
    return { ok: true, cookies: refreshed };
  } catch (e) {
    return { ok: false, code: 'error', reason: '复用校验异常：' + e.message };
  } finally {
    if (probeContext) {
      try { await probeContext.close(); } catch (e) { /* 关闭失败不掩盖原始结果 */ }
    }
  }
}

/**
 * 单活动上下文交接（AD-MINMIN-LOGIN-HANDOFF-20261021-F1，2026-10-21）。
 *
 * 现场故障：QR 源 context 在 verifySessionReuse 创建 probe context 时仍存活，两个上下文
 * 同时持有同一账号登录态；平台可能在探测访问中轮换凭据，导致随后保存/恢复的 Cookie 与
 * 仍在使用的源上下文互相作废。
 *
 * 规则（login-shop.js 与 douyin-promo-guard qr-login.js 共用本实现，不得各自复制）：
 *  1) 只从源 context 捕获一次候选 Cookie，随后**立即关闭源 context**；关闭失败即拒绝继续
 *     （避免双活上下文）。源 context 的关闭发生在任何 probe context 创建之前。
 *  2) 用冻结候选在独立新上下文做第一次复用验证；平台可能在该次访问中再次轮换，故对第一次
 *     返回的最终集再做一次全新上下文的独立验证。每次验证仍走 verifySessionReuse 的全部
 *     门禁（受信 https FXG 源、非登录页、语义身份、稳定两次读取、关键域、数量、抓取后
 *     漂移复验），不在此处放宽或绕过任何一条。
 *  3) 只返回**最后一次验证 context 的最终 Cookie**；调用方四层分发必须使用这份集合。
 *  4) 任一步失败 → 返回 ok:false，不返回任何 Cookie；调用方据此零写入（fail-closed）。
 *  5) 提供 probeFactory（每次调用必须返回一个**新的独立浏览器进程**）时走严格单进程交接：
 *     先关闭并证明源 context/源进程已退出，再为每一次复用验证各开一个自有探测进程，
 *     每次验证后关闭并证明该探测进程退出；只返回第二次探测的最终 Cookie。任一关闭无法
 *     证明 → handoff_close / probe_close，拒绝返回 Cookie。未提供 probeFactory 的既有
 *     调用方保持原行为（同浏览器内隔离 context），以便逐步迁移。
 *
 * @param {{browser:object, context:object, expectedShopName:string,
 *          collectPageIdentityCandidates:Function, extractShopIdentity:Function,
 *          isLoginPageUrl:Function, viewport?:object, timezoneId?:string,
 *          homeUrl?:string, maxWaitMs?:number, pollIntervalMs?:number,
 *          navTimeoutMs?:number, assertLive?:Function,
 *          probeFactory?:Function, closeSource?:Function, sleep:Function}} opts
 * @returns {Promise<{ok:true, cookies:object[], candidateCount:number, verifiedCount:number}
 *          |{ok:false, code:string, reason:string}>}
 */
async function verifyHandoffAfterClosingSource(opts) {
  const o = opts || {};
  const {
    browser, context, expectedShopName,
    collectPageIdentityCandidates, extractShopIdentity, isLoginPageUrl, sleep,
    probeFactory, closeSource,
  } = o;
  if (!browser || !context || typeof context.cookies !== 'function' || typeof context.close !== 'function'
    || !expectedShopName || !collectPageIdentityCandidates || !extractShopIdentity
    || !isLoginPageUrl || typeof sleep !== 'function') {
    return { ok: false, code: 'bad_args', reason: '交接校验参数不完整（browser/context/expectedShopName/身份函数/sleep 必须齐全）' };
  }
  if (probeFactory !== undefined && typeof probeFactory !== 'function') {
    return { ok: false, code: 'bad_args', reason: '交接校验参数不完整（probeFactory 必须是函数）' };
  }
  if (closeSource !== undefined && (typeof closeSource !== 'function' || typeof probeFactory !== 'function')) {
    return { ok: false, code: 'bad_args', reason: '交接校验参数不完整（closeSource 只能与 probeFactory 同时提供）' };
  }
  let candidate;
  try {
    candidate = await context.cookies();
  } catch (e) {
    return { ok: false, code: 'capture', reason: safeFailureReason('capture') };
  }
  // ── 新路径（probeFactory）：每个 Cookie 的复用验证都在自有独立浏览器进程中完成 ──
  // 源 context 与源浏览器进程必须先关闭且可证明，之后才允许创建第一个探测进程。
  if (probeFactory) {
    try {
      if (closeSource) {
        await closeSource();
      } else {
        let contextError = null;
        try { await context.close(); } catch (e) { contextError = e; }
        const closed = await closeBrowserProven(browser, { requireProof: true });
        if (contextError || !closed) throw new Error('source close unproven');
      }
      // 即使调用方 closeSource 正常返回，也必须独立证明源浏览器已断开，
      // 否则“回调返回”就会被当成假证明继续创建探测进程。
      if (typeof browser.isConnected !== 'function') throw new Error('source proof unavailable');
      // 严格证明：非 false（含 undefined/null/非布尔）一律视为未证明退出。
      if (browser.isConnected() !== false) throw new Error('source still connected');
    } catch (e) {
      return { ok: false, code: 'handoff_close', reason: safeFailureReason('handoff_close') };
    }
    if (typeof o.assertLive === 'function') o.assertLive();
    if (!cookiesShapeOk(candidate)) {
      return { ok: false, code: 'shape', reason: safeFailureReason('shape') };
    }
    // 每个探测对象必须全新：源浏览器与已用过的探测对象都不得复用（闭包 WeakSet，
    // 不新增配置字段）。检查发生在 verifySessionReuse 创建上下文/addCookies 之前。
    const seen = new WeakSet();
    if (browser && typeof browser === 'object') seen.add(browser);
    const probeOpts = Object.assign({}, o, { seen });
    // 第一次独立探测：只注入冻结候选；返回前关闭该探测进程并证明退出。
    const frozenSource = { cookies: async () => candidate };
    const first = await runOwnedProbe(probeFactory, frozenSource, probeOpts);
    if (!first.ok) return first;
    // 第二次独立探测：用第一次探测的最终 Cookie，在另一个自有新进程中复验（绝不复用旧备份）。
    const frozenFirst = { cookies: async () => first.cookies };
    const second = await runOwnedProbe(probeFactory, frozenFirst, probeOpts);
    if (!second.ok) {
      return {
        ok: false,
        code: second.code || 'final_reuse_unverified',
        reason: '关闭源上下文后最终独立复用校验未通过：' + (second.reason || safeFailureReason('final_reuse_unverified')),
      };
    }
    // 只返回最后一次独立探测进程的最终 Cookie；不声明未来有效期保证。
    return {
      ok: true,
      cookies: second.cookies,
      candidateCount: candidate.length,
      verifiedCount: second.cookies.length,
    };
  }
  // ── 兼容路径（未提供 probeFactory 的既有调用方）：保持原行为 ──
  // 源 context 必须在任何 probe context 创建之前关闭；关闭失败即拒绝继续（避免双活）。
  try {
    await context.close();
  } catch (e) {
    return { ok: false, code: 'handoff_close', reason: '关闭扫码源上下文失败，拒绝继续（避免双活上下文）：' + ((e && e.message) || e) };
  }
  if (!cookiesShapeOk(candidate)) {
    return { ok: false, code: 'shape', reason: '候选 Cookie 结构异常（空/缺 name/domain/value/path），拒绝注入与落盘' };
  }
  // 源 context 已关闭：只用冻结候选做第一次独立验证。
  const frozenSource = { cookies: async () => candidate };
  const first = await verifySessionReuse(Object.assign({}, o, { context: frozenSource }));
  if (!first.ok) return first;
  // 最后一次独立验证：证明第一次验证 context 的最终 Cookie 仍可在另一个新上下文复用。
  const frozenFirst = { cookies: async () => first.cookies };
  const second = await verifySessionReuse(Object.assign({}, o, { context: frozenFirst }));
  if (!second.ok) {
    return {
      ok: false,
      code: second.code || 'final_reuse_unverified',
      reason: '关闭源上下文后最终独立复用校验未通过：' + (second.reason || '未取得可复用的最终会话'),
    };
  }
  // 只返回最后一次验证 context 的最终 Cookie；不声明未来有效期保证。
  return {
    ok: true,
    cookies: second.cookies,
    candidateCount: candidate.length,
    verifiedCount: second.cookies.length,
  };
}

/**
 * 关闭浏览器并证明进程已断开：close() 成功且 isConnected() 为 false。
 * 新路径要求可证明（requireProof 默认 true）：缺少 isConnected 或类型不可用即视为
 * 不可证明，返回 false —— 调用方必须 fail-closed，绝不把“关闭调用返回”当成已退出。
 * 仍会先尝试 close()，避免因证明缺失而遗留资源。
 */
async function closeBrowserProven(browser, options) {
  const requireProof = !options || options.requireProof !== false;
  if (!browser || typeof browser.close !== 'function') return false;
  try { await browser.close(); } catch (e) { return false; }
  // 显式旧兼容：调用方声明无需断开证明时，close() 成功即视为完成。
  if (!requireProof) return true;
  if (typeof browser.isConnected !== 'function') return false;
  try {
    // 严格证明：只有明确的 false 才算已断开；undefined/null/非布尔值均视为未知，不得当作证明。
    return browser.isConnected() === false;
  } catch (e) {
    return false;
  }
}

/**
 * 在调用方提供的独立浏览器进程中跑一次 verifySessionReuse，并在返回前关闭该进程且证明退出。
 * 探测进程关闭失败 → probe_close（即使验证本身通过也拒绝返回 Cookie）。
 * 取消/超时检查放在关闭之后：取消不得留下仍存活的探测浏览器。
 *
 * 约束：
 *  - probeFactory 每次必须返回全新浏览器对象；源浏览器/已用过的探测对象在注入前拒绝；
 *  - factory 拒绝可能表示“进程已创建但未知”，只记录 unknownLaunch，绝不当作已清理；
 *  - factory 在取消后才解析时，关闭该探测且绝不继续 addCookies；
 *  - 失败原因一律固定文案，不拼接底层异常消息。
 */
async function runOwnedProbe(probeFactory, frozenContext, opts) {
  const o = opts || {};
  const checkLive = () => { if (typeof o.assertLive === 'function') o.assertLive(); };
  const state = o.probeState && typeof o.probeState === 'object' ? o.probeState : null;
  // 鸭子类型而非 instanceof：调用方可能在不同 realm（如 VM 测试）创建 Set/WeakSet。
  const seen = o.seen && typeof o.seen.has === 'function' && typeof o.seen.add === 'function' ? o.seen : null;
  const live = state && state.live && typeof state.live.add === 'function' && typeof state.live.delete === 'function'
    ? state.live : null;
  checkLive();
  let probe = null;
  let owned = false;
  let result;
  try {
    try {
      probe = await probeFactory();
    } catch (e) {
      // factory 拒绝不代表没有进程被创建：清理状态未知，onCleanup 不得报告完成。
      if (state) state.unknownLaunch = true;
      return { ok: false, code: 'probe_launch', reason: safeFailureReason('probe_launch') };
    }
    if (!probe || typeof probe !== 'object') {
      return { ok: false, code: 'probe_launch', reason: safeFailureReason('probe_launch') };
    }
    if (seen && seen.has(probe)) {
      // 源浏览器或已用过的探测对象：在 addCookies 之前拒绝，不把旧进程当成新证明。
      return { ok: false, code: 'probe_launch', reason: safeFailureReason('probe_launch') };
    }
    if (seen) seen.add(probe);
    owned = true;
    if (live) live.add(probe);
    // factory 可能在取消后才解析：此处必须抛取消，由 finally 关闭该探测且不继续注入。
    checkLive();
    try {
      result = await verifySessionReuse(Object.assign({}, o, { browser: probe, context: frozenContext }));
    } catch (e) {
      result = null;
    }
    if (!result || result.ok !== true) {
      result = {
        ok: false,
        code: (result && result.code) || 'final_reuse_unverified',
        reason: safeFailureReason(result && result.code),
      };
    }
  } finally {
    if (owned) {
      const closed = await closeBrowserProven(probe, { requireProof: true });
      if (live) {
        if (closed) live.delete(probe);
        else state.closeUnproven = true;
      } else if (!closed && state) {
        state.closeUnproven = true;
      }
      if (!closed) result = { ok: false, code: 'probe_close', reason: safeFailureReason('probe_close') };
      // 取消/超时检查放在关闭之后：取消不得留下仍存活的探测浏览器。
      checkLive();
    }
  }
  return result;
}

module.exports = {
  FXG_HOME_URL,
  MIN_REFRESH_KEEP_RATIO,
  cookiesShapeOk,
  jinritemaiDomains,
  noCriticalDomainLoss,
  refreshedCountOk,
  fingerprintOf,
  backupExistingExact,
  commitCookiesAtomic,
  verifySessionReuse,
  verifyHandoffAfterClosingSource,
  closeBrowserProven,
};
