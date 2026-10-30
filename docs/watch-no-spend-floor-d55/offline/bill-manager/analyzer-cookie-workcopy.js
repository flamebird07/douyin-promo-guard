'use strict';

/**
 * analyzer-cookie-workcopy.js — 商品分析侧四层适配（AD-COOKIE-FOUR-TIER-20261019-F1）。
 *
 * 职责（纯适配，不启动浏览器、不启动 main）：
 *  1. assertAnalyzerWorkTarget：任何分析器对工作副本的写入前，程序层拒绝触及
 *     原始归档 / 推广恢复目录 / 推广工作目录 / 另店文件；目标必须是
 *     analyzerWorkDir 内的普通文件（或不存在），并做 dev+ino 硬链接别名核查。
 *  2. restoreAnalysisWorkCopy：分析工作副本登录/加载失败时的恢复链——
 *     分析工作副本 → 匹配店铺的最近原始快照（新→旧，有界一次循环，按 sha 去重）。
 *     每个候选先经独立验证（默认：传入 browser 开隔离新上下文，要求受信 FXG
 *     非登录页 + 语义身份唯一且 safeNameOf(身份)===本店安全段），验证通过才
 *     CAS 原子提升（vault.promoteCandidateToWorkFile：保留上一版 + 冲突保留并发新文件）。
 *     全部失败：如实保留各候选错误，不盲覆盖、不跨店猜文件、不写任何归档/来源。
 *
 * 恢复边界：仅在明确 auth/文件完整性失败路径调用（登录检测失败/候选损坏），
 * 不因普通网络/DOM 故障触发。候选验证不写任何归档或来源。
 *
 * 审计脱敏：只含店铺安全段、来源、sha 前缀、结果与原因；无 Cookie 值/完整 URL/token。
 */

const fs = require('fs');
const path = require('path');
const vault = require('./cookie-vault');
const {
  collectPageIdentityCandidates, extractShopIdentity, isLoginPageUrl, safeNameOf,
} = require('./login-shop-identity');

const FXG_HOME_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const TRUSTED_FXG_ORIGIN_RE = /^https:\/\/fxg\.jinritemai\.com\//;
/** 恢复链候选上限（工作副本 1 + 归档最近 3）：有界一次循环，不无限重试。 */
const MAX_RESTORE_CANDIDATES = 4;

function isSafeShopSegment(s) {
  const seg = String(s == null ? '' : s);
  return !!seg && seg !== '.' && seg !== '..' && !/[/\\]/.test(seg);
}

/** 分析器工作路径（appRoot 可注入；生产 appRoot = bill-manager 目录）。 */
function analyzerWorkPathsFor(opts = {}) {
  const roots = opts.roots || vault.defaultRoots({ appRoot: opts.appRoot });
  const shopSeg = opts.shopSafeName;
  return { roots, shopSeg, workDir: roots.analyzerWorkDir, workPath: path.join(roots.analyzerWorkDir, `${shopSeg}.json`) };
}

/**
 * 分析器写入目标门禁：拒绝归档/恢复目录/推广工作目录/另店文件/符号链接；
 * 通过返回 true，否则抛错（fail-closed，检查点外层捕获后零写入）。
 * @param {string} cookiePath 目标文件（应为 analyzerWorkDir/<shopSeg>.json）
 * @param {object} [opts] { appRoot | roots, shopSafeName?, fsModule? }
 */
function assertAnalyzerWorkTarget(cookiePath, opts = {}) {
  const fsm = opts.fsModule || fs;
  const roots = opts.roots || vault.defaultRoots({ appRoot: opts.appRoot });
  const base = path.basename(String(cookiePath || ''));
  if (!base.endsWith('.json')) {
    throw new Error(`分析器写入目标必须是 .json 文件（实测 ${JSON.stringify(base)}）：拒绝`);
  }
  const shopSeg = base.slice(0, -5);
  if (!isSafeShopSegment(shopSeg)) {
    throw new Error(`分析器写入目标店铺段非法: ${JSON.stringify(base)}：拒绝`);
  }
  if (vault.isInsideDir(fsm, roots.archiveRoot, cookiePath)) {
    throw new Error('分析器写入目标位于原始快照归档内：工作副本不可反向覆盖原始，拒绝');
  }
  if (vault.isInsideDir(fsm, roots.recoveryDir, cookiePath)) {
    throw new Error('分析器写入目标位于推广恢复副本目录：禁止跨业务互写，拒绝');
  }
  if (vault.isInsideDir(fsm, roots.guardWorkDir, cookiePath)) {
    throw new Error('分析器写入目标位于推广值守工作目录：禁止跨业务互写，拒绝');
  }
  if (!vault.isInsideDir(fsm, roots.analyzerWorkDir, cookiePath)) {
    throw new Error(`分析器写入目标不在商品分析工作目录内（${roots.analyzerWorkDir}）：拒绝写入未知位置`);
  }
  if (typeof opts.shopSafeName === 'string' && opts.shopSafeName && shopSeg !== opts.shopSafeName) {
    throw new Error(`分析器写入目标店铺段 ${JSON.stringify(shopSeg)} 与期望 ${JSON.stringify(opts.shopSafeName)} 不符：拒绝另店/改名文件`);
  }
  let lst = null;
  try { lst = fsm.lstatSync(cookiePath); } catch (_) { lst = null; }
  if (lst && !lst.isFile()) {
    throw new Error('分析器写入目标是符号链接/目录/非普通文件：拒绝（路径别名不当隔离）');
  }
  if (lst) {
    const st = vault.targetState(fsm, cookiePath);
    // dev+ino 硬链接别名核查（防写穿归档）
    const hl = vaultHardlinkCheck(fsm, cookiePath, roots, shopSeg, st);
    if (hl) throw new Error('分析器写入目标与原始归档为同一存储对象（dev+ino 相同，疑似硬链接）：拒绝，防止写穿归档');
  }
  vault.assertNotArchivePath(cookiePath, { roots, fsModule: fsm });
  return true;
}

function vaultHardlinkCheck(fsm, targetPath, roots, shopSeg, st) {
  // vault 未导出独立 hardlink 检查时用 promote 前置等价实现：枚举该店版本比对 dev+ino
  let names = [];
  const shopDir = path.join(roots.archiveRoot, shopSeg);
  try { names = fsm.readdirSync(shopDir).filter((f) => f.endsWith('.json') && f !== vault.MANIFEST_NAME); } catch (_) { return false; }
  if (!st || !st.exists || st.error || st.ino === undefined) return false;
  for (const f of names.slice(0, vault.MAX_VERSIONS_SCAN)) {
    try {
      const vst = fsm.statSync(path.join(shopDir, f));
      if (vst.dev === st.dev && vst.ino === st.ino) return true;
    } catch (_) { /* 单版本失败跳过 */ }
  }
  return false;
}

/**
 * 默认候选验证器（D6 最小进程隔离）：每个候选必须由调用方提供的
 * opts.candidateBrowserFactory 启动**全新浏览器进程**，验证器自身绝不隐式 launch、
 * 也绝不使用主分析浏览器（browser-only 回退已移除）。每次调用流程：
 *  1. 调用工厂取得新 browser；拒绝与 forbiddenBrowsers（主分析浏览器）同一对象或
 *     与前序候选重复的对象——这一步发生在 newContext/addCookies 之前；
 *  2. 开全新空上下文注入候选 Cookie，访问抖店首页，要求受信 FXG 非登录页 +
 *     语义身份唯一且 safeNameOf(身份名) === 本店安全段；
 *  3. 无论成功/失败/异常，只关闭本候选自己启动的 context 与 browser，绝不关闭
 *     主分析浏览器；关闭未获证明（close 抛错或 isConnected 仍为真）时返回
 *     ok:false + stopChain:true，并锁存不再启动后续候选。
 * 成功返回该验证上下文的最终 Cookie 集合 finalCookies（访问后可能被平台轮换，
 * 唯一允许提升/落盘的集合）；读取失败/空/结构无效 fail-closed，绝不回退验证前候选。
 * 异常文本一律脱敏，绝不回显 Cookie/令牌/完整 URL。
 */
function createAnalyzerDefaultVerifier(opts = {}) {
  const factory = opts.candidateBrowserFactory;
  const forbidden = new Set();
  if (Array.isArray(opts.forbiddenBrowsers)) {
    for (const b of opts.forbiddenBrowsers) { if (b) forbidden.add(b); }
  }
  // 兼容显式传入的 browser：只作为禁止对象，绝不作为验证用浏览器。
  if (opts.browser) forbidden.add(opts.browser);
  const used = new WeakSet();
  let latched = false;
  const sleepFn = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const maxAttempts = Math.max(1, Math.ceil((opts.verifyMaxWaitMs || 12000) / 2000));

  return async function verifyCandidate(p) {
    if (latched) {
      return { ok: false, stopChain: true, reason: '候选进程隔离验证已中止（前序候选关闭未获证明/工厂违约）：不再启动后续候选进程（fail-closed）' };
    }
    if (typeof factory !== 'function') {
      // 工厂只负责启动浏览器；无工厂即拒绝，绝不回退共享主浏览器，也不在验证器内隐式 launch。
      return { ok: false, reason: '未提供候选专用浏览器工厂：无法在独立进程中验证候选（fail-closed，不提升）' };
    }
    let browser = null;
    let ctx = null;
    let owned = false;
    let result = null;
    try {
      try {
        browser = await factory();
      } catch (_) {
        latched = true;
        return { ok: false, stopChain: true, reason: '候选浏览器工厂异常（异常详情可能含敏感值，已脱敏不回显）：已中止后续候选（fail-closed）' };
      }
      if (!browser || typeof browser.newContext !== 'function') {
        latched = true;
        return { ok: false, stopChain: true, reason: '候选浏览器工厂未返回可用浏览器：无法证明独立进程归属，已中止后续候选（fail-closed）' };
      }
      if (forbidden.has(browser)) {
        latched = true;
        return { ok: false, stopChain: true, reason: '候选浏览器工厂返回主分析浏览器（禁止复用/禁止关闭）：已中止后续候选（fail-closed）' };
      }
      if (used.has(browser)) {
        latched = true;
        return { ok: false, stopChain: true, reason: '候选浏览器工厂重复返回同一浏览器对象（进程未独立）：已中止后续候选（fail-closed）' };
      }
      used.add(browser);
      owned = true;
      ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
      if (!ctx || typeof ctx.addCookies !== 'function' || typeof ctx.newPage !== 'function') {
        throw new Error('candidate context invalid');
      }
      await ctx.addCookies(p.cookies);
      const page = await ctx.newPage();
      await page.goto(opts.homeUrl || FXG_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      for (let i = 0; i < maxAttempts; i += 1) {
        if (i > 0) await sleepFn(2000);
        const url = String(page.url());
        if (!TRUSTED_FXG_ORIGIN_RE.test(url) || isLoginPageUrl(url)) continue;
        const candidates = await page.evaluate(collectPageIdentityCandidates);
        const identity = extractShopIdentity(candidates);
        if (!identity.ok) continue;
        if (safeNameOf(identity.name) !== p.shopSafeName) {
          result = { ok: false, reason: `候选会话身份与本店不符（${JSON.stringify(safeNameOf(identity.name))} ≠ ${JSON.stringify(p.shopSafeName)}）：拒绝（不跨店恢复）` };
          break;
        }
        // 平台可能在验证上下文访问期间轮换认证 Cookie：唯一允许提升/落盘的是该验证
        // 上下文的最终 Cookie 集合。读取异常/空/结构无效一律 fail-closed，绝不回退
        // 返回验证前候选（p.cookies）。
        let finalCookies = null;
        try { finalCookies = await ctx.cookies(); } catch (_) { finalCookies = null; }
        const fv = vault.validateCookieStructure(finalCookies);
        if (!fv.ok) {
          result = { ok: false, reason: `验证上下文最终 Cookie 集合不可读或结构无效（${fv.reason}）：fail-closed 拒绝提升（不回退验证前候选）` };
          break;
        }
        result = { ok: true, finalCookies };
        break;
      }
      if (!result) {
        result = { ok: false, reason: '候选未在独立新上下文取得受信抖店首页的唯一本店语义身份（登录无效）' };
      }
    } catch (_) {
      // 外部异常（浏览器/页面驱动）可能回显 Cookie 值或带 token 的完整 URL：
      // 只记录固定脱敏原因，绝不拼接 e.message / String(e)。
      result = { ok: false, reason: '候选验证异常（异常详情可能含 Cookie/令牌等敏感值，已脱敏不回显）：拒绝验证/提升' };
    } finally {
      // 只关闭本候选自有 context/browser；关闭证明失败即拒绝结果并锁存链。
      let closeFailed = false;
      if (ctx) { try { await ctx.close(); } catch (_) { closeFailed = true; } }
      if (owned && browser) {
        try { await browser.close(); } catch (_) { closeFailed = true; }
        try {
          if (typeof browser.isConnected === 'function' && browser.isConnected() !== false) closeFailed = true;
        } catch (_) { closeFailed = true; }
      }
      if (closeFailed) {
        latched = true;
        return { ok: false, stopChain: true, reason: '候选浏览器进程/上下文关闭未获证明（isConnected 仍为真或关闭异常）：已中止后续候选且拒绝提升（fail-closed）' };
      }
    }
    return result;
  };
}

function candidateSessionIdentity(cand) {
  let cookies;
  try { cookies = JSON.parse(cand.buf.toString('utf8')); } catch (_) { return null; }
  if (!vault.validateCookieStructure(cookies).ok) return null;
  const names = ['sessionid', 'sessionid_ss', 'sid_tt'];
  const found = new Set();
  const keys = new Set();
  const rows = [];
  for (const c of cookies) {
    if (!names.includes(c.name)) continue;
    if (!c.value.trim()) return null;
    let partition = c.partitionKey ?? null;
    if (partition && typeof partition === 'object' && !Array.isArray(partition)) {
      const entries = Object.entries(partition).sort(([a], [b]) => a.localeCompare(b));
      if (entries.some(([, v]) => v !== null && !['string', 'boolean', 'number'].includes(typeof v))) return null;
      partition = entries;
    } else if (partition !== null && typeof partition !== 'string') return null;
    const key = JSON.stringify([c.name, c.domain, c.path, partition, c.hasCrossSiteAncestor ?? null]);
    if (keys.has(key)) return null;
    keys.add(key);
    found.add(c.name);
    rows.push(JSON.stringify([key, c.value]));
  }
  if (found.size !== names.length) return null;
  return `session:${vault.sha256Of(JSON.stringify(rows.sort()))}`;
}

function sessionBreadthOrder(cands) {
  const representatives = [];
  const variants = [];
  const seen = new Set();
  for (const c of cands) {
    const key = candidateSessionIdentity(c) || `sha:${c.sha256}`;
    (seen.has(key) ? variants : representatives).push(c);
    seen.add(key);
  }
  return representatives.concat(variants);
}

/**
 * 分析工作副本恢复链（登录验证失败/候选损坏时调用；一次有界循环）。
 * @param {object} opts
 * @param {string} opts.workPath    分析工作副本精确路径（analyzerWorkDir/<seg>.json）
 * @param {object} [opts.roots]     vault.defaultRoots 产物（测试注入临时目录）
 * @param {object} [opts.browser]   主分析浏览器（D6 起仅作为禁止复用/关闭对象，不再作验证浏览器）
 * @param {function} [opts.candidateBrowserFactory] 每候选启动全新浏览器进程的工厂（默认验证器必需）
 * @param {object[]} [opts.forbiddenBrowsers] 额外禁止复用/关闭的主浏览器对象
 * @param {function} [opts.verify]  注入验证器 async ({cookies, shopSafeName, source}) => {ok, finalCookies?, reason?, stopChain?}
 *                                   （ok:true 必须携带验证上下文最终 finalCookies；缺失/无效 fail-closed 不提升；
 *                                    stopChain:true 表示关闭未获证明/工厂违约，恢复链必须立即停止）
 * @param {object} [opts.fsModule]  注入 fs（离线测试）
 * @param {function} [opts.nowFn]   可注入时钟
 * @param {function} [opts.audit]   脱敏审计回调
 * @returns {Promise<{ok:true, source:string, sourceSha256:string, targetSha256:string, backupPath:string|null, attempts:object[]}
 *                   |{ok:false, reason:string, attempts:object[]}>}
 */
async function restoreAnalysisWorkCopy(opts = {}) {
  const fsm = opts.fsModule || fs;
  const nowFn = opts.nowFn || (() => Date.now());
  const attempts = [];
  const workPath = String(opts.workPath || '');
  const base = path.basename(workPath);
  if (!base.endsWith('.json')) {
    return { ok: false, reason: `恢复目标必须是 .json 文件（实测 ${JSON.stringify(base)}）`, attempts };
  }
  const shopSeg = base.slice(0, -5);
  if (!isSafeShopSegment(shopSeg)) {
    return { ok: false, reason: `恢复目标店铺段非法: ${JSON.stringify(base)}`, attempts };
  }
  const roots = opts.roots || vault.defaultRoots({ appRoot: opts.appRoot });

  // 候选 1：分析工作副本当前字节（可能就是损坏/失效的那份；验证器会判它）
  const cands = [];
  const wst = vault.targetState(fsm, workPath);
  // 冻结基线：验证开始前的目标指纹（{exists, sha256}）；提升前必须与当前状态一致，
  // 验证期间发生的并发新扫码登录写入胜出（拒绝提升，不覆盖）。不可判定时为 null。
  const frozenBaseline = wst.error ? null : { exists: !!wst.exists, sha256: wst.exists ? wst.sha256 : null };
  if (!wst.error && wst.exists) {
    cands.push({ source: 'analyzer-work', buf: fsm.readFileSync(workPath), sha256: wst.sha256 });
  } else {
    attempts.push({ source: 'analyzer-work', result: 'unreadable', reason: wst.error || '工作副本缺失' });
  }
  // 本地恢复扫描可更深；平台验证仍使用既有首选/legacy 窗口。
  const recoveryScan = vault.MAX_RECOVERY_VERSIONS_SCAN === 200;
  let listed;
  try { listed = vault.listSnapshotVersions({ shopSafeName: shopSeg, roots, fsModule: fsm, internalRecoveryScan: recoveryScan }); } catch (e) {
    listed = { ok: false, reason: (e && e.message) || String(e) };
  }
  if (listed.ok) {
    if (listed.manifestMissing) {
      attempts.push({ source: 'raw-archive', result: 'manifest-missing', reason: '归档 manifest 缺失/损坏：按目录列举回退（读取时仍核验 sha）' });
    }
    const archWindow = MAX_RESTORE_CANDIDATES - 1;
    const bounded = listed.versions.slice(0, recoveryScan ? 200 : 50);
    for (const legacy of [false, true]) {
      let window = legacy ? [] : cands.slice();
      const windowLimit = archWindow + window.length;
      const seenSha = new Set(cands.map((c) => c.sha256));
      const sessions = new Set(window.map((c) => candidateSessionIdentity(c) || `sha:${c.sha256}`));
      for (const v of bounded) {
        if ((v.origin === 'legacy-unverified') !== legacy) continue;
        const r = vault.readSnapshotVersion({ versionPath: v.versionPath, expectedSha256: v.sha256 || undefined, fsModule: fsm });
        if (!r.ok) {
          attempts.push({ source: `raw-archive:${v.versionId}`, result: 'integrity-failed', reason: r.reason });
          continue;
        }
        if (seenSha.has(r.sha256)) {
          attempts.push({ source: `raw-archive:${v.versionId}`, result: 'dedup', sha256Prefix: vault.shortSha(r.sha256) });
          continue;
        }
        seenSha.add(r.sha256);
        const c = { source: `raw-archive:${v.versionId}`, buf: r.buf, sha256: r.sha256 };
        sessions.add(candidateSessionIdentity(c) || `sha:${c.sha256}`);
        window = sessionBreadthOrder([...window, c]).slice(0, windowLimit);
        if (sessions.size >= windowLimit) break;
      }
      if (legacy) cands.push(...window);
      else cands.splice(0, cands.length, ...window);
    }
  } else {
    attempts.push({ source: 'raw-archive', result: 'unavailable', reason: listed.reason });
  }

  const verify = opts.verify || createAnalyzerDefaultVerifier(opts);
  const seen = new Set();
  let verifyCalls = 0;
  let chainStopped = false;
  for (const cand of cands) {
    if (seen.has(cand.sha256)) {
      attempts.push({ source: cand.source, result: 'dedup', sha256Prefix: vault.shortSha(cand.sha256) });
      continue;
    }
    seen.add(cand.sha256);
    let parsed = null;
    try { parsed = JSON.parse(cand.buf.toString('utf8')); } catch (_) { parsed = null; }
    const v = parsed === null ? { ok: false, reason: 'JSON 解析失败' } : vault.validateCookieStructure(parsed);
    if (!v.ok) {
      attempts.push({ source: cand.source, result: 'invalid-structure', reason: v.reason });
      continue;
    }
    verifyCalls += 1;
    let vr;
    try {
      vr = await verify({ cookies: parsed, shopSafeName: shopSeg, candidatePath: cand.source, source: cand.source });
    } catch (_) {
      // 注入验证器的外部异常同样可能含 Cookie/token：固定脱敏原因，绝不回显异常内容。
      vr = { ok: false, reason: '验证器异常（异常详情可能含 Cookie/令牌等敏感值，已脱敏不回显）' };
    }
    if (!vr || vr.ok !== true) {
      const reason = (vr && vr.reason) || '未通过验证';
      if (vr && vr.stopChain === true) {
        // 候选进程/上下文关闭未获证明（或工厂违约）：立即停止后续候选与提升，
        // 不把不确定状态带入下一候选。
        attempts.push({ source: cand.source, result: 'verify-aborted', reason });
        chainStopped = true;
        break;
      }
      attempts.push({ source: cand.source, result: 'verify-failed', reason });
      continue;
    }
    // 只提升验证上下文的最终 Cookie 集合（访问后可能已被平台轮换）：finalCookies
    // 缺失/空/结构无效 fail-closed，绝不回退提升验证前候选字节。
    const fv = vault.validateCookieStructure(vr.finalCookies);
    if (!fv.ok) {
      attempts.push({ source: cand.source, result: 'verify-failed', reason: `验证器未返回有效 finalCookies（${fv.reason}）：fail-closed 拒绝提升（不回退验证前候选）` });
      continue;
    }
    const promotedBuf = Buffer.from(JSON.stringify(vr.finalCookies, null, 2), 'utf8');
    const promotedSha = vault.sha256Of(promotedBuf);
    if (frozenBaseline === null) {
      attempts.push({ source: cand.source, result: 'promote-failed', conflict: true, reason: '恢复开始前的目标状态不可判定：拒绝提升（fail-closed，不盲覆盖未知现状）' });
      continue;
    }
    const promote = vault.promoteCandidateToWorkFile({
      candidateBuf: promotedBuf,
      candidateSha256: promotedSha,
      targetPath: workPath,
      roots,
      shopSafeName: shopSeg,
      role: 'analyzer-work',
      fsModule: fsm,
      nowFn,
      frozenBaseline,
    });
    if (!promote.ok) {
      attempts.push({ source: cand.source, result: 'promote-failed', reason: promote.reason });
      continue;
    }
    const entry = {
      kind: 'cookie-restore', shop: shopSeg, role: 'analyzer-work',
      time: new Date(nowFn()).toISOString(), source: cand.source,
      sourceSha256: cand.sha256, verification: 'verified-in-new-context',
      targetSha256: promote.targetSha256,
      backupPath: promote.backupPath ? path.basename(promote.backupPath) : null,
    };
    if (typeof opts.audit === 'function') { try { opts.audit(entry); } catch (_) { /* 审计失败不影响结果 */ } }
    return {
      ok: true, source: cand.source, sourceSha256: cand.sha256,
      targetSha256: promote.targetSha256, backupPath: promote.backupPath || null, attempts,
    };
  }
  const summary = {
    kind: 'cookie-restore', shop: shopSeg, role: 'analyzer-work',
    time: new Date(nowFn()).toISOString(), ok: false, attempts,
  };
  if (typeof opts.audit === 'function') { try { opts.audit(summary); } catch (_) { /* ignore */ } }
  return {
    ok: false,
    reason: chainStopped
      ? `候选独立进程关闭未获证明/隔离中止：已停止后续候选并保留工作副本现状（单次有界循环，验证调用 ${verifyCalls} 次）`
      : `全部 ${attempts.length} 个候选未通过验证/提升失败：保留工作副本现状，不盲覆盖（单次有界循环，验证调用 ${verifyCalls} 次）`,
    attempts,
  };
}

module.exports = {
  FXG_HOME_URL,
  MAX_RESTORE_CANDIDATES,
  isSafeShopSegment,
  analyzerWorkPathsFor,
  assertAnalyzerWorkTarget,
  createAnalyzerDefaultVerifier,
  restoreAnalysisWorkCopy,
};
