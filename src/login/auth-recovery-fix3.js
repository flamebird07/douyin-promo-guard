'use strict';

/**
 * fix3：登录失效后的**固定四份候选**有界恢复（简尚口径，收紧版）。
 *
 * 背景（2026-11-02）：简尚衣橱优品店本地四层 Cookie 文件全部结构健康，但源端持续落
 * /login/common。旧恢复链按「最多 5 份候选」逐份验证，会把同一会话的瘦身副本/旧快照
 * 反复送验——既耗配额，也容易被误读成"换一份就能好"。本模块把口径收紧为：
 *
 *   候选 1  值守工作副本：<workDir>/<店名>.json
 *   候选 2  商品分析来源：<login.cookieSourceDir>/<店名>.json
 *   候选 3  恢复层最新可解析主文件：<recoveryDir>/<店名>/v*.json（新→旧，首个可解析）
 *   候选 4  归档层最新可解析主文件：<archiveRoot>/<店名>/v*.json（新→旧，首个可解析）
 *   +       已登记同店多账号工作副本（shopCfg.cookieFiles / shopCfg.accounts，有才用）
 *
 * 严格边界：
 *  - 不扩第 5 份固定层；不扫 vault/`.prev-*` 全桶；恢复层/归档层各只取 1 份主文件；
 *  - 写坏窄定义（isWrittenBad）只认：不可解析 / 缺 auth 三键 / auth 过期 / 空文件；
 *  - 「文件健康但浏览器仍落登录页」= 源端不认 ≠ 写坏：绝不因此覆盖，且与当前已失败
 *    会话 **auth 指纹相同** 的候选不再重复送验（不盲换、不盲覆盖）；
 *  - 只有「更健康 / 不同会话」的候选才允许进入一次独立核验；核验通过才备份并原子提升；
 *  - 全失败：先产出证据包，并要求对照店 checkLogin 通过（证明不是全局 checkLogin 误杀）
 *    才允许 auth 结案；结案回调供调用方释放该店串行门，不堵其他店；
 *  - 绝不扫码、绝无 qr 旁路；本模块不启动浏览器（核验函数由调用方注入）。
 *
 * 脱敏：所有输出只含 name/expires/条数/sha8/判定，绝不包含 Cookie value。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AuthError } = require('../lib/errors');
const { safeCookieBaseName, validateCookieArray } = require('./cookie-workcopy');
const { serializeCookies, finalPreservesCandidateAuth } = require('./cookie-writeback');

/** 关键登录认证 Cookie（与 session.js / cookie-writeback 同口径）。 */
const AUTH_COOKIE_NAMES = Object.freeze(['sessionid', 'sessionid_ss', 'sid_tt']);
/** 固定四份候选（不含多账号）。 */
const FIX3_MAX_BASE_CANDIDATES = 4;
/** 已登记多账号工作副本上限（有才用，不硬补第二账号）。 */
const FIX3_MAX_ACCOUNT_CANDIDATES = 3;
/** 单轮核验次数硬上限（每份候选至多一次）。 */
const FIX3_MAX_VERIFICATIONS = 4;
/** 目录内「最新可解析主文件」的受限扫描窗口（只用于找 1 份，不构成候选扩容）。 */
const FIX3_DIR_SCAN_LIMIT = 8;
/** fix3 备份前缀（字节备份；与既有 `.prev-*` 区分）。 */
const FIX3_BACKUP_PREFIX = '.bak-fix3-';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时间戳：YYYYMMDD-HHMMSS（备份名可读、可排序）。 */
function stampOf(nowMs) {
  const d = new Date(nowMs);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** 店铺名候选（compassShopName / name，trim 去重；空配置返回空数组）。 */
function shopNamesOf(shopCfg) {
  const out = [];
  for (const n of [shopCfg && shopCfg.compassShopName, shopCfg && shopCfg.name]) {
    const t = String(n == null ? '' : n).trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function exists(fsm, p) {
  if (typeof fsm.existsSync === 'function') {
    try { return fsm.existsSync(p); } catch (_) { return false; }
  }
  try { fsm.lstatSync(p); return true; } catch (_) { return false; }
}

/**
 * 单份 Cookie 健康检查（结构化、脱敏、可机器复现）。
 *
 * 窄写坏判定只由 verdict 决定：
 *   bad-json / bad-empty / bad-auth-missing / bad-auth-expired / unreadable
 * 其余（healthy）即使源端仍落登录页，也只是「源端不认」，不是写坏。
 *
 * @param {Buffer|null} buf 冻结字节
 * @param {{nowMs?:number, unreadableReason?:string}} [opts]
 * @returns {object} 不含任何 Cookie value
 */
function inspectCookieHealth(buf, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : Date.now();
  const base = {
    verdict: 'unreadable',
    parseable: false,
    count: 0,
    expiredCount: 0,
    authComplete: false,
    authExpired: false,
    maxAuthExpires: null,
    auth: {},
    authFingerprint: null,
    authSha8: null,
    reason: opts.unreadableReason || '文件不可读',
  };
  if (!Buffer.isBuffer(buf)) return base;
  let parsed;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch (_) {
    return { ...base, verdict: 'bad-json', reason: 'JSON 解析失败' };
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ...base, verdict: 'bad-empty', parseable: true, reason: '不是非空 Cookie 数组（空文件）' };
  }

  const byName = new Map();
  for (const c of parsed) {
    if (!c || typeof c.name !== 'string') continue;
    if (!byName.has(c.name)) byName.set(c.name, []);
    byName.get(c.name).push(c);
  }
  const auth = {};
  let authComplete = true;
  let authExpired = false;
  let maxAuthExpires = null;
  const fingerprintParts = [];
  for (const name of AUTH_COOKIE_NAMES) {
    const list = byName.get(name) || [];
    const c = list.length === 1 ? list[0] : null;
    const present = !!c && typeof c.value === 'string' && c.value.length > 0;
    const expSec = c && typeof c.expires === 'number' ? c.expires : -1;
    const definite = Number.isFinite(expSec) && expSec > 0;
    const expired = present && definite && expSec * 1000 <= nowMs;
    auth[name] = {
      present,
      expires: definite ? new Date(expSec * 1000).toISOString() : null,
      expired,
      duplicate: list.length > 1,
    };
    if (!present) authComplete = false;
    if (expired) authExpired = true;
    if (present && definite) {
      maxAuthExpires = maxAuthExpires === null ? expSec : Math.max(maxAuthExpires, expSec);
    }
    if (present) fingerprintParts.push(`${name}=${c.value}`);
  }
  const expiredCount = parsed.filter((c) => c && typeof c.expires === 'number' && c.expires > 0 && c.expires * 1000 <= nowMs).length;
  const authFingerprint = authComplete ? sha256(Buffer.from(fingerprintParts.join('\n'), 'utf8')) : null;
  const verdict = !authComplete ? 'bad-auth-missing' : (authExpired ? 'bad-auth-expired' : 'healthy');
  const reason = verdict === 'bad-auth-missing'
    ? `缺少关键登录认证 Cookie（${AUTH_COOKIE_NAMES.filter((n) => !auth[n].present).join(',')}）`
    : (verdict === 'bad-auth-expired' ? '关键登录认证 Cookie 已过期' : null);

  return {
    verdict,
    parseable: true,
    count: parsed.length,
    expiredCount,
    authComplete,
    authExpired,
    maxAuthExpires,
    auth,
    authFingerprint,
    authSha8: authFingerprint ? authFingerprint.slice(0, 8) : null,
    reason,
  };
}

/** 窄写坏定义：只有这五类算「写坏或不可用文件」。 */
function isWrittenBad(health) {
  return !!health && ['bad-json', 'bad-empty', 'bad-auth-missing', 'bad-auth-expired', 'unreadable'].includes(health.verdict);
}

/** 证据用健康摘要（绝不含 value）。 */
function publicHealth(h) {
  if (!h) return null;
  return {
    verdict: h.verdict,
    parseable: h.parseable === true,
    count: h.count,
    expiredCount: h.expiredCount,
    authComplete: h.authComplete === true,
    authExpired: h.authExpired === true,
    authSha8: h.authSha8 || null,
    maxAuthExpires: h.maxAuthExpires && h.maxAuthExpires > 0 ? new Date(h.maxAuthExpires * 1000).toISOString() : null,
    auth: Object.fromEntries(AUTH_COOKIE_NAMES.map((n) => [n, h.auth && h.auth[n] ? {
      present: h.auth[n].present === true,
      expires: h.auth[n].expires || null,
      expired: h.auth[n].expired === true,
    } : null])),
    reason: h.reason || null,
  };
}

/** 冻结读取一份候选（lstat 拒绝符号链接/目录；缺失/不可读如实标注）。 */
function captureCandidate(fsm, filePath, meta) {
  let lst;
  try {
    lst = fsm.lstatSync(filePath);
  } catch (e) {
    const missing = e && e.code === 'ENOENT';
    return {
      ...meta, path: filePath, ok: false, missing,
      health: inspectCookieHealth(null, { nowMs: meta.nowMs, unreadableReason: missing ? '文件缺失' : '文件状态不可判定' }),
    };
  }
  if (!lst.isFile()) {
    return {
      ...meta, path: filePath, ok: false, missing: false,
      health: inspectCookieHealth(null, { nowMs: meta.nowMs, unreadableReason: '不是普通文件（符号链接/目录拒绝）' }),
    };
  }
  try {
    const buf = fsm.readFileSync(filePath);
    return {
      ...meta, path: filePath, ok: true, buf, sha256: sha256(buf),
      health: inspectCookieHealth(buf, { nowMs: meta.nowMs }),
    };
  } catch (e) {
    return {
      ...meta, path: filePath, ok: false, missing: false,
      health: inspectCookieHealth(null, { nowMs: meta.nowMs, unreadableReason: '读取失败' }),
    };
  }
}

/**
 * 目录内「最新可解析主文件」：按文件名倒序（版本号内嵌 UTC 时刻，可字典序比较），
 * 受限窗口内取首个 JSON 可解析且非空数组的文件。只返回 1 份，不扩候选。
 */
function latestParseableInDir(fsm, dir, meta) {
  let names;
  try {
    names = fsm.readdirSync(dir)
      .filter((f) => /\.json$/i.test(f) && f !== 'manifest.json' && !f.startsWith('.'))
      .sort((a, b) => String(b).localeCompare(String(a)))
      .slice(0, FIX3_DIR_SCAN_LIMIT);
  } catch (_) {
    return null;
  }
  let newest = null;
  for (const f of names) {
    const c = captureCandidate(fsm, path.join(dir, f), { ...meta, fileName: f });
    if (!newest) newest = c;
    if (c.ok && c.health.parseable === true && c.health.count > 0) return c;
  }
  // 没有可解析主文件：仍把**最新一份**作为该层候选返回（由窄写坏判定如实标 bad-json），
  // 不静默降级成 missing——否则证据包看不到"该层最新文件不可解析"。
  return newest;
}

/** 已登记同店多账号工作副本（只接受显式配置，绝不按目录猜第二账号）。 */
function registeredAccountFiles(shopCfg, primaryName) {
  const out = [];
  const push = (v) => {
    if (typeof v !== 'string' || !v.trim()) return;
    try {
      const n = safeCookieBaseName(v.trim());
      if (n !== primaryName && !out.includes(n)) out.push(n);
    } catch (_) { /* 非法文件名：忽略，不猜 */ }
  };
  if (shopCfg && Array.isArray(shopCfg.cookieFiles)) shopCfg.cookieFiles.forEach(push);
  if (shopCfg && Array.isArray(shopCfg.accounts)) {
    for (const a of shopCfg.accounts) {
      if (typeof a === 'string') push(a);
      else if (a && typeof a === 'object') push(a.cookieFile);
    }
  }
  return out.slice(0, FIX3_MAX_ACCOUNT_CANDIDATES);
}

/**
 * 组装固定四份候选（+ 已登记多账号）。
 * @returns {{candidates:object[], notes:object[]}}
 */
function collectFix3Candidates(p) {
  const fsm = p.fsm;
  const nowMs = p.nowMs;
  const name = p.name;
  const shopSafeName = p.shopSafeName;
  const candidates = [];
  const notes = [];

  // 1) 值守工作副本（基线；默认不重复送验，但必须做健康检查）
  candidates.push(captureCandidate(fsm, path.join(p.workDir, name), {
    slot: 'work', source: 'guard-duty-work', fileName: name, nowMs,
  }));

  // 2) 商品分析来源（login.cookieSourceDir；与工作根 realpath 重合则跳过）
  const sourceDir = p.sourceDir;
  if (!sourceDir) {
    notes.push({ slot: 'source', result: 'not-configured', reason: '未配置 login.cookieSourceDir' });
  } else {
    let srcReal = null;
    let workReal = null;
    try { srcReal = fsm.realpathSync(sourceDir); } catch (_) { srcReal = null; }
    try { workReal = fsm.realpathSync(p.workDir); } catch (_) { workReal = null; }
    if (srcReal && workReal && srcReal === workReal) {
      notes.push({ slot: 'source', result: 'alias-skipped', reason: '来源目录与工作根 realpath 重合' });
    } else {
      candidates.push(captureCandidate(fsm, path.join(sourceDir, name), {
        slot: 'source', source: 'analyzer-source', fileName: name, nowMs,
      }));
    }
  }

  // 3) 恢复层：只取 1 份「最新可解析主文件」
  const recoveryDir = p.recoveryDir;
  const recoveryShopDir = path.join(recoveryDir, shopSafeName);
  let rec = latestParseableInDir(fsm, recoveryShopDir, { slot: 'recovery', source: 'guard-recovery', nowMs });
  if (!rec) {
    // 兼容历史固定路径 <recoveryDir>/<name>.json（仍只算 1 份）
    const legacy = path.join(recoveryDir, name);
    if (exists(fsm, legacy)) {
      rec = captureCandidate(fsm, legacy, { slot: 'recovery', source: 'guard-recovery', fileName: name, nowMs });
    }
  }
  if (rec) candidates.push(rec);
  else notes.push({ slot: 'recovery', result: 'missing', reason: '恢复层无最新可解析主文件' });

  // 4) 归档层：只取 1 份「最新可解析主文件」
  const archiveShopDir = p.archiveRoot ? path.join(p.archiveRoot, shopSafeName) : null;
  if (!archiveShopDir) {
    notes.push({ slot: 'archive', result: 'not-configured', reason: '无法从 login.cookieSourceDir 推导归档根' });
  } else {
    const arch = latestParseableInDir(fsm, archiveShopDir, { slot: 'archive', source: 'raw-archive', nowMs });
    if (arch) candidates.push(arch);
    else notes.push({ slot: 'archive', result: 'missing', reason: '归档层无最新可解析主文件' });
  }

  // + 已登记同店多账号工作副本（有才用）
  for (const file of registeredAccountFiles(p.shopCfg, name)) {
    const c = captureCandidate(fsm, path.join(p.workDir, file), {
      slot: `account:${file}`, source: `account-work:${file}`, fileName: file, nowMs,
    });
    if (c.ok) candidates.push(c);
    else notes.push({ slot: `account:${file}`, result: 'missing', reason: '已登记账号工作副本不存在（不硬补第二账号）' });
  }

  return { candidates, notes };
}

/** 字节备份：<work>.bak-fix3-YYYYMMDD-HHMMSS（冲突时追加短随机，绝不覆盖已有备份）。 */
function backupWorkCopy(fsm, workPath, nowFn) {
  let buf;
  try {
    buf = fsm.readFileSync(workPath);
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: true, skipped: true, backupPath: null };
    return { ok: false, reason: '备份读取失败（不回显异常详情）' };
  }
  const stamp = stampOf(nowFn());
  let backupPath = `${workPath}${FIX3_BACKUP_PREFIX}${stamp}`;
  if (exists(fsm, backupPath)) backupPath = `${backupPath}-${crypto.randomBytes(3).toString('hex')}`;
  let fd = null;
  try {
    fd = fsm.openSync(backupPath, 'wx');
    fsm.writeSync(fd, buf);
    fsm.fsyncSync(fd);
    fsm.closeSync(fd);
    fd = null;
  } catch (_) {
    if (fd !== null) { try { fsm.closeSync(fd); } catch (_) { /* ignore */ } }
    try { if (exists(fsm, backupPath)) fsm.unlinkSync(backupPath); } catch (_) { /* 只清自有备份 */ }
    return { ok: false, reason: '备份写入失败：拒绝在无备份的情况下提升' };
  }
  return { ok: true, skipped: false, backupPath };
}

/** 原子精确写（tmp 'wx' + fsync + rename 前复验 + 回读比对）。 */
function atomicWriteExact(fsm, targetPath, buf, beforeRename) {
  const dir = path.dirname(targetPath);
  const tmp = path.join(dir, `.${path.basename(targetPath)}.tmp-fix3-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  let fd = null;
  let owned = false;
  try {
    fd = fsm.openSync(tmp, 'wx');
    owned = true;
    fsm.writeSync(fd, buf);
    fsm.fsyncSync(fd);
    fsm.closeSync(fd);
    fd = null;
    if (typeof beforeRename === 'function') {
      const chk = beforeRename() || {};
      if (chk.ok !== true) {
        try { fsm.unlinkSync(tmp); } catch (_) { /* ignore */ }
        owned = false;
        return { ok: false, conflict: chk.kind === 'target-drift', reason: chk.reason || 'rename 前复验未通过' };
      }
    }
    fsm.renameSync(tmp, targetPath);
  } catch (_) {
    if (fd !== null) { try { fsm.closeSync(fd); } catch (_) { /* ignore */ } }
    if (owned) { try { fsm.unlinkSync(tmp); } catch (_) { /* ignore */ } }
    return { ok: false, reason: '原子写入失败（不回显异常详情）' };
  }
  try {
    const back = fsm.readFileSync(targetPath);
    if (sha256(back) !== sha256(buf)) {
      return { ok: false, conflict: true, reason: '写入后回读字节不一致（并发更新）：不报告成功' };
    }
  } catch (_) {
    return { ok: false, reason: '写入后无法回读' };
  }
  return { ok: true, sha256: sha256(buf) };
}

function targetState(fsm, workPath) {
  const cap = captureCandidate(fsm, workPath, { nowMs: Date.now() });
  if (cap.ok) return { exists: true, sha256: cap.sha256 };
  if (cap.missing) return { exists: false };
  return { exists: true, error: '目标状态不可判定' };
}

/** 证据包（全失败/成功都返回；只含标识与判定，绝不含 Cookie value）。 */
function buildEvidence(p) {
  return {
    kind: 'fix3-auth-closure',
    shop: p.shopSafeName,
    time: new Date(p.nowFn()).toISOString(),
    policy: 'fix3-four',
    fixedCandidates: FIX3_MAX_BASE_CANDIDATES,
    candidates: p.attempts.map((a) => ({
      slot: a.slot,
      source: a.source,
      file: a.fileName,
      health: a.health,
      decision: a.decision,
      verification: a.verification || null,
      reason: a.reason || null,
    })),
    notes: p.notes,
    verificationCalls: p.verificationCalls,
    controlCheck: p.control,
    falsePositiveExclusion: {
      writtenBadNarrow: true,
      healthyFileNotOverwritten: p.overwritten !== true,
      sameSessionNotRetried: p.sameSessionSkipped === true,
      controlShopNotFalselyKilled: !!(p.control && p.control.ok === true),
      readFailureNotMislabeledAsAuth: '由调用方 AUTH-60S 正证据门负责（本模块不升级 auth）',
    },
    authClosedOut: p.authClosedOut === true,
    // CODE_FAIL 加严（2026-11-02）：fix3-four 结案/未结案文案一律不含扫码类结论。
    conclusion: p.authClosedOut === true
      ? 'auth 结案：固定四份候选均不可用（写坏或文件健康但源端不认，已排除代码误判/对照店未误杀），不要求重新登录旁路'
      : '未结案：全候选不可用，但对照片 checkLogin 未通过或未提供，保持原读取失败语义（不释放串行门，不要求重新登录旁路）',
  };
}

/**
 * 有界恢复主入口。
 *
 * @param {object} loginCfg login 配置段（cookieSourceDir 等）
 * @param {string} cookieFile 店铺 Cookie 文件名（可含/不含 .json）
 * @param {object} opts
 *   - workDir {string} 必填（工作根；由调用方解析，测试上下文不得静默落生产）
 *   - shopCfg {object} 店铺配置（name/compassShopName/cookieFiles/accounts）
 *   - verify {Function} 必填：async ({cookies, expectedShopNames, source}) => {ok, finalCookies?, classification?, reason?}
 *   - controlCheck {Function} 可选：async ({shopSafeName, evidence}) => {ok, reason?, shop?}
 *   - onAuthClosedOut {Function} 可选：auth 结案后回调（用于释放串行门）
 *   - recoveryDir / archiveRoot / fsModule / nowFn / excludeWorkCopy
 * @returns {Promise<object>}
 */
async function runFix3Recovery(loginCfg, cookieFile, opts = {}) {
  const fsm = opts.fsModule || fs;
  const nowFn = opts.nowFn || (() => Date.now());
  const nowMs = Number.isFinite(opts.nowMs) ? Number(opts.nowMs) : nowFn();
  const workDir = opts.workDir;
  if (!workDir || typeof workDir !== 'string') {
    throw new AuthError('fix3 恢复缺少隔离工作根（opts.workDir）：fail-closed，拒绝默认写入生产 cookies/');
  }
  const name = safeCookieBaseName(cookieFile);
  const shopSafeName = name.slice(0, -5);
  const shopCfg = opts.shopCfg || {};
  const expectedNames = shopNamesOf(shopCfg);
  const verify = opts.verify;
  const attempts = [];
  const notes = [];
  const startedAt = nowFn();
  if (expectedNames.length === 0) {
    return {
      ok: false,
      authClosedOut: false,
      reason: '未配置店铺名（compassShopName/name）：无法验证候选身份，拒绝恢复',
      attempts,
      evidence: null,
    };
  }
  if (typeof verify !== 'function') {
    return {
      ok: false,
      authClosedOut: false,
      reason: '未提供候选验证器（verify）：fail-closed，不提升（绝不静默放行）',
      attempts,
      evidence: null,
    };
  }

  const sourceDir = loginCfg && typeof loginCfg.cookieSourceDir === 'string' && loginCfg.cookieSourceDir.trim()
    ? loginCfg.cookieSourceDir.trim() : null;
  const recoveryDir = opts.recoveryDir || path.resolve(__dirname, '..', '..', 'cookie-recovery');
  const archiveRoot = opts.archiveRoot || (sourceDir
    ? path.resolve(sourceDir, '..', 'cookie-archive', 'raw')
    : null);

  const { candidates, notes: collectNotes } = collectFix3Candidates({
    fsm, nowMs, name, shopSafeName, workDir, sourceDir, recoveryDir, archiveRoot, shopCfg,
  });
  notes.push(...collectNotes);

  const baseline = candidates.find((c) => c.slot === 'work') || null;
  const baselineHealth = baseline && baseline.health;
  const baselineHealthy = !!(baselineHealth && baselineHealth.verdict === 'healthy');
  const baselineSha = baseline && baseline.ok ? baseline.sha256 : null;

  // 资格判定：写坏永不恢复；同 auth 指纹（同一已失败会话）不重复送验；更旧的会话不送验。
  const queue = [];
  let sameSessionSkipped = false;
  for (const c of candidates) {
    const entry = {
      slot: c.slot,
      source: c.source,
      fileName: c.fileName,
      health: publicHealth(c.health),
      decision: null,
      reason: null,
    };
    if (c.slot === 'work') {
      entry.decision = opts.excludeWorkCopy === false ? 'eligible-work' : 'excluded-work';
      entry.reason = opts.excludeWorkCopy === false ? null : '登录失效入口：当前字节刚在真实浏览器验证失败，排除重复候选';
      attempts.push(entry);
      if (opts.excludeWorkCopy === false && !isWrittenBad(c.health)) queue.push(c);
      continue;
    }
    if (!c.ok) {
      entry.decision = c.missing ? 'missing' : 'unreadable';
      entry.reason = c.health && c.health.reason ? c.health.reason : null;
    } else if (isWrittenBad(c.health)) {
      entry.decision = 'written-bad';
      entry.reason = c.health.reason || '写坏或不可用文件（窄定义）';
    } else if (String(c.slot).startsWith('account:')) {
      if (baselineHealthy && c.health.authFingerprint && c.health.authFingerprint === baselineHealth.authFingerprint) {
        entry.decision = 'same-session';
        entry.reason = '已登记账号与当前失败会话同一 auth 指纹：不重复送验';
      } else {
        entry.decision = 'eligible-account';
        queue.push(c);
      }
    } else if (!baselineHealthy) {
      entry.decision = 'eligible-baseline-bad';
      queue.push(c);
    } else if (c.health.authFingerprint && baselineHealth.authFingerprint
      && c.health.authFingerprint === baselineHealth.authFingerprint) {
      entry.decision = 'same-session';
      entry.reason = '与已失败的当前会话同一 auth 指纹：源端不认≠写坏，不重复验证、不盲覆盖';
      sameSessionSkipped = true;
    } else if (c.health.maxAuthExpires != null && baselineHealth.maxAuthExpires != null
      && c.health.maxAuthExpires < baselineHealth.maxAuthExpires) {
      entry.decision = 'older-session';
      entry.reason = '认证 Cookie 过期时间早于当前工作副本：不是更健康候选，不覆盖';
    } else {
      entry.decision = 'eligible';
      queue.push(c);
    }
    attempts.push(entry);
  }

  const bounded = queue.slice(0, FIX3_MAX_VERIFICATIONS);
  let verificationCalls = 0;
  let overwritten = false;

  for (const c of bounded) {
    const entry = attempts.find((a) => a.slot === c.slot);
    let parsed;
    try {
      parsed = JSON.parse(c.buf.toString('utf8'));
    } catch (_) {
      entry.verification = { result: 'invalid-structure', reason: 'JSON 解析失败' };
      continue;
    }
    const shape = validateCookieArray(parsed);
    if (!shape.ok) {
      entry.verification = { result: 'invalid-structure', reason: shape.reason };
      continue;
    }
    verificationCalls += 1;
    let vr;
    try {
      vr = await verify({ cookies: parsed, expectedShopNames: expectedNames, source: c.source });
    } catch (_) {
      vr = { ok: false, classification: 'verify-error', reason: '验证器异常（详情可能含敏感值，已脱敏）' };
    }
    if (!vr || vr.ok !== true) {
      entry.verification = {
        result: 'verify-failed',
        classification: (vr && vr.classification) || null,
        reason: (vr && vr.reason) || '未通过独立验证',
      };
      continue;
    }
    if (!Array.isArray(vr.finalCookies) || vr.finalCookies.length === 0) {
      entry.verification = { result: 'final-missing', reason: '验证器未返回非空最终集合：拒绝提升' };
      continue;
    }
    const finalShape = validateCookieArray(vr.finalCookies);
    if (!finalShape.ok) {
      entry.verification = { result: 'final-invalid', reason: `最终集合结构无效（${finalShape.reason}）` };
      continue;
    }
    const auth = finalPreservesCandidateAuth(vr.finalCookies, parsed);
    if (!auth.ok) {
      entry.verification = { result: 'final-invalid', reason: auth.reason };
      continue;
    }
    let promoteBuf;
    try {
      promoteBuf = Buffer.from(serializeCookies(vr.finalCookies), 'utf8');
    } catch (_) {
      entry.verification = { result: 'final-invalid', reason: '最终集合序列化失败' };
      continue;
    }

    // 冻结基线 CAS：验证期间工作副本被并发更新（如新扫码登录）→ 放弃提升，较新登录胜出。
    const cur = targetState(fsm, path.join(workDir, name));
    if (cur.error) {
      entry.verification = { result: 'promote-failed', reason: '目标状态不可判定：拒绝提升' };
      continue;
    }
    if (cur.exists !== (baselineSha !== null) || (cur.exists && baselineSha !== null && cur.sha256 !== baselineSha)) {
      entry.verification = { result: 'promote-failed', conflict: true, reason: '验证期间工作副本被并发更新：放弃提升，保留并发新文件' };
      continue;
    }

    const bk = backupWorkCopy(fsm, path.join(workDir, name), nowFn);
    if (!bk.ok) {
      entry.verification = { result: 'backup-failed', reason: bk.reason };
      continue;
    }
    const beforeRename = () => {
      const chk = targetState(fsm, path.join(workDir, name));
      if (chk.error) return { ok: false, kind: 'target-drift', reason: 'rename 前复验：目标状态不可判定' };
      if (chk.exists !== (baselineSha !== null) || (chk.exists && baselineSha !== null && chk.sha256 !== baselineSha)) {
        return { ok: false, kind: 'target-drift', reason: 'rename 前复验：工作副本已被并发写入者更新' };
      }
      return { ok: true };
    };
    const wr = atomicWriteExact(fsm, path.join(workDir, name), promoteBuf, beforeRename);
    if (!wr.ok) {
      entry.verification = { result: 'promote-failed', reason: wr.reason };
      continue;
    }
    overwritten = true;
    entry.verification = { result: 'verified', classification: 'verified-in-new-context-final' };
    const evidence = buildEvidence({
      shopSafeName, nowFn, attempts, notes, verificationCalls,
      control: null, authClosedOut: false, overwritten: true, sameSessionSkipped,
    });
    return {
      ok: true,
      policy: 'fix3-four',
      source: c.source,
      slot: c.slot,
      sourceSha256: c.sha256,
      targetSha256: wr.sha256,
      backupPath: bk.backupPath || null,
      verificationCalls,
      attempts,
      evidence,
      elapsedMs: Math.max(0, nowFn() - startedAt),
    };
  }

  // 全失败：先交证据包；对照店 checkLogin 通过才允许 auth 结案。
  const preEvidence = buildEvidence({
    shopSafeName, nowFn, attempts, notes, verificationCalls,
    control: null, authClosedOut: false, overwritten, sameSessionSkipped,
  });
  let control = { ok: false, skipped: true, reason: '未提供对照店 checkLogin（未完成误判排除）' };
  if (typeof opts.controlCheck === 'function') {
    try {
      const r = await opts.controlCheck({ shopSafeName, evidence: preEvidence });
      control = r && typeof r === 'object' ? { ...r, ok: r.ok === true } : { ok: false, reason: '对照店 checkLogin 未返回结构化结果' };
    } catch (_) {
      control = { ok: false, reason: '对照店 checkLogin 异常（详情已脱敏）' };
    }
  }
  const authClosedOut = control.ok === true;
  const evidence = buildEvidence({
    shopSafeName, nowFn, attempts, notes, verificationCalls,
    control, authClosedOut, overwritten, sameSessionSkipped,
  });
  if (authClosedOut && typeof opts.onAuthClosedOut === 'function') {
    try { await opts.onAuthClosedOut(evidence); } catch (_) { /* 回调失败不改变结案事实 */ }
  }
  return {
    ok: false,
    policy: 'fix3-four',
    authClosedOut,
    controlCheck: control,
    reason: authClosedOut
      ? `固定四份候选均不可用（验证调用 ${verificationCalls} 次）：文件健康但源端不认或写坏，已排除代码误判（对照店 checkLogin 通过）；auth 结案，不要求重新登录旁路`
      : `固定四份候选均不可用（验证调用 ${verificationCalls} 次）：对照店 checkLogin 未通过/未提供，未完成误判排除，不结案（保持原读取失败语义，不要求重新登录旁路）`,
    attempts,
    notes,
    verificationCalls,
    evidence,
    elapsedMs: Math.max(0, nowFn() - startedAt),
  };
}

module.exports = {
  AUTH_COOKIE_NAMES,
  FIX3_MAX_BASE_CANDIDATES,
  FIX3_MAX_ACCOUNT_CANDIDATES,
  FIX3_MAX_VERIFICATIONS,
  FIX3_BACKUP_PREFIX,
  inspectCookieHealth,
  isWrittenBad,
  publicHealth,
  collectFix3Candidates,
  backupWorkCopy,
  runFix3Recovery,
};
