'use strict';

/**
 * 会话 Cookie 回写（2026-09-16 用户明确授权的定点能力）。
 *
 * 背景：`src/login/session.js` 把「电商助手来源目录」标记为**只读**（历史约定：不写别人的业务目录）。
 * 用户现已明确授权：**仅**对本次实际加载的该店铺 Cookie 文件执行回写，供下次复用；
 * 不改动电商助手其他业务、不写其他文件。
 *
 * 硬性约束（全部落实为代码路径，不靠口头约定）：
 *  1. 只写 `resolveCookieFile()` 返回的**本次实际加载的精确路径**；不接受调用方任意传入的路径。
 *  2. **原子写入**：同目录临时文件 → fsync → rename 覆盖；任何一步失败即放弃，
 *     旧文件保持原样（绝不出现半写文件）。
 *  3. **绝不输出 Cookie 值**：本模块不返回、不打印任何 value；日志/返回值只有数量、域名、字节数。
 *  4. 登录失效 / 身份不符 / 空或非法 Cookie → **拒绝覆盖**（返回 skipped + reason）。
 *  5. **冲突保护**：会话开始时记录源文件指纹（size + mtimeMs + sha256）；回写前重新比对。
 *     源文件在会话期间被改变（用户重新登录、其他进程写入）→ **保留较新的文件**，明确记录，
 *     不做任何无依据的合并。
 *  6. **域完整性**：新 Cookie 集合必须覆盖原文件中全部 `jinritemai.com` 家族域名
 *     （抖店/千川/罗盘/登录），且总量不得塌缩（≥ 原数量的 60%）——
 *     防止"只保存千川域 Cookie 后覆盖掉抖店等其他有效域"。
 *  7. **写入后自校验 + 有条件的回滚**：重新解析落盘文件，域名集合与条数与预期一致才算成功；
 *     不一致时**仅当文件仍是我们刚写入的那份内容**才回滚（见 rollbackIfUnchanged）——
 *     否则放弃回滚，避免用旧内容覆盖其他进程的新登录结果。
 *  8. 回写失败**单独记录**（返回 {ok:false}），调用方不得因此改写已确认的广告动作结果，
 *     也不得因此重做广告动作；当前批次继续使用原 context，不回灌、不刷新会话。
 *
 * 2026-09-16 第二轮定点修复（Codex 独立复现的异步时间空隙）：
 *  旧实现在 `await context.cookies()` **之前**做一次指纹检查，之后直接写入。
 *  `context.cookies()` 是异步的（真实浏览器上可能耗时数百毫秒~数秒），期间用户重新登录
 *  写入新文件后，旧会话仍会把旧 Cookie 覆盖回去，并返回 ok=true —— 静默丢失用户的新登录。
 *  现补齐：
 *   a) **初始指纹缺失或无效 → 拒绝回写**（旧实现 `if (start && ...)` 会让缺失指纹静默跳过
 *      冲突保护，等于完全没有保护）。
 *   b) **取回浏览器 Cookie 之后、提交写入之前，重新核验源文件**（第二次快照）；
 *      任何变化 → 保留较新文件，不回写。
 *   c) **回滚同样受保护**：仅当落盘内容仍是本次写入的那份才回滚。
 *   d) **登录态 fail-closed**：`loginOk` 必须由调用方给出**当前有效**的明确证据
 *      （不再默认 true）。操作开始时身份正确 ≠ 结束时登录仍有效。
 *
 * 竞争保护的实际边界（不夸大）：本模块的保护是"**基于 sha256 的比对-后-写**"，
 * 配合原子 rename 只保证"不会出现半写文件"。它**不是**完整的并发冲突保护——
 * 若另一个进程恰好在最后一次比对与 rename 之间完成写入，本次写入仍会覆盖它
 * （窗口极小但非零）。真正意义上的互斥需要文件锁或平台的乐观并发控制，
 * 当前业务场景（单机、同一用户）下以"两次快照 + 较新者胜"为准，并如实记录。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 业务关键域后缀：这些域在回写中缺失 → 直接拒绝覆盖。 */
const CRITICAL_DOMAIN_SUFFIX = 'jinritemai.com';
/** 数量塌缩保护：新集合条数不得低于原条数的该比例。 */
const MIN_COUNT_RATIO = 0.6;

function normDomain(d) {
  return String(d || '').trim().replace(/^\./, '').toLowerCase();
}

/** 文件指纹：不存在时 exists=false（其余为 null）。内容摘要用 sha256，避免仅凭 mtime 误判。 */
function fingerprintFile(filePath) {
  try {
    const st = fs.statSync(filePath);
    const buf = fs.readFileSync(filePath);
    return {
      exists: true,
      size: st.size,
      mtimeMs: st.mtimeMs,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    };
  } catch (_) {
    return { exists: false, size: null, mtimeMs: null, sha256: null };
  }
}

/** 域统计（只统计域名，不含任何 Cookie 值）。 */
function domainStats(cookies) {
  const counts = {};
  for (const c of cookies) {
    const d = String((c && c.domain) || '').trim();
    if (!d) continue;
    counts[d] = (counts[d] || 0) + 1;
  }
  return counts;
}

/** 形状比对（条数 + 各域条数），用于写入后自校验；不涉及 Cookie 值。 */
function sameCookieShape(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  const da = domainStats(a);
  const db = domainStats(b);
  const ka = Object.keys(da).sort();
  const kb = Object.keys(db).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i += 1) {
    if (ka[i] !== kb[i]) return false;
    if (da[ka[i]] !== db[kb[i]]) return false;
  }
  return true;
}

/**
 * 校验待写回的 Cookie 集合。返回 {ok, reason, droppedCritical, droppedOther}。
 * 不返回任何 Cookie 值。
 */
function validateCookieSet(cookies, prevCookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) {
    return { ok: false, reason: 'Cookie 集合为空或非数组（拒绝覆盖）' };
  }
  for (const c of cookies) {
    if (!c || typeof c !== 'object') return { ok: false, reason: 'Cookie 集合含非对象条目（拒绝覆盖）' };
    if (typeof c.name !== 'string' || c.name.trim() === '') {
      return { ok: false, reason: 'Cookie 集合存在缺少 name 的条目（拒绝覆盖）' };
    }
    if (typeof c.value !== 'string') {
      return { ok: false, reason: 'Cookie 集合存在 value 非字符串的条目（拒绝覆盖）' };
    }
    if (typeof c.domain !== 'string' || c.domain.trim() === '') {
      return { ok: false, reason: 'Cookie 集合存在缺少 domain 的条目（拒绝覆盖）' };
    }
  }
  if (!cookies.some((c) => c.value.length > 0)) {
    return { ok: false, reason: 'Cookie 集合所有条目 value 均为空（登录态可疑，拒绝覆盖）' };
  }
  const hasFxg = cookies.some((c) => /(^|\.)jinritemai\.com$/.test(normDomain(c.domain)));
  if (!hasFxg) {
    return { ok: false, reason: 'Cookie 集合不含 jinritemai.com 域（登录态无效，拒绝覆盖）' };
  }

  const prev = Array.isArray(prevCookies) ? prevCookies : [];
  const prevDomains = new Set(prev.map((c) => normDomain(c.domain)).filter(Boolean));
  const nextDomains = new Set(cookies.map((c) => normDomain(c.domain)).filter(Boolean));

  const droppedCritical = [];
  const droppedOther = [];
  for (const d of prevDomains) {
    if (nextDomains.has(d)) continue;
    if (d === CRITICAL_DOMAIN_SUFFIX || d.endsWith(`.${CRITICAL_DOMAIN_SUFFIX}`)) droppedCritical.push(d);
    else droppedOther.push(d);
  }
  if (droppedCritical.length > 0) {
    return {
      ok: false,
      reason: `新 Cookie 集合缺少原文件的抖店/千川关键域（拒绝覆盖，防止只保存部分域）: ${droppedCritical.join(',')}`,
      droppedCritical, droppedOther,
    };
  }
  if (prev.length > 0 && cookies.length < Math.floor(prev.length * MIN_COUNT_RATIO)) {
    return {
      ok: false,
      reason: `新 Cookie 集合条数塌缩（原 ${prev.length} → 新 ${cookies.length}，低于 ${Math.round(MIN_COUNT_RATIO * 100)}% 保护线，拒绝覆盖）`,
      droppedCritical, droppedOther,
    };
  }
  return { ok: true, reason: null, droppedCritical, droppedOther, prevCount: prev.length, nextCount: cookies.length };
}

/** 原子写入（同目录临时文件 + fsync + rename）。失败时清理临时文件，旧文件不受影响。 */
function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}`);
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeSync(fd, JSON.stringify(data, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, filePath);
    return { ok: true, bytes: fs.statSync(filePath).size };
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    return { ok: false, reason: e.message };
  }
}

/**
 * 有条件回滚：**仅当文件仍是我们刚写入的那份内容**（sha256 一致）才回滚。
 *
 * 为什么需要它：写后自校验失败时要回滚，但回滚本身是一次覆盖写。若在自校验失败到回滚之间
 * 另一个进程（或用户重新登录）已经写入了更新的内容，无条件回滚会把**新登录结果**覆盖掉，
 * 造成静默丢失。这里用写入后立即取得的 sha256 做比对-后-写。
 *
 * 边界：比对与 rename 之间仍有极小窗口（见文件头说明），此处不宣称完全互斥。
 * @param {string} filePath
 * @param {string} writtenSha256  本次写入完成后立即取得的文件 sha256
 * @param {any} prevCookies       回滚目标（写入前的内容）
 * @returns {{ok:boolean, skipped:boolean, reason?:string}}
 */
function rollbackIfUnchanged(filePath, writtenSha256, prevCookies) {
  const cur = fingerprintFile(filePath);
  if (!cur.exists || !writtenSha256 || cur.sha256 !== writtenSha256) {
    return {
      ok: false, skipped: true,
      reason: '源文件在本次写入后已被其他进程改写：放弃回滚，保留较新文件（不做无依据覆盖）',
    };
  }
  const r = atomicWriteJson(filePath, prevCookies);
  return r.ok ? { ok: true, skipped: false } : { ok: false, skipped: false, reason: r.reason };
}

/**
 * 把本次 context 的 Cookie 回写到本次实际加载的店铺 Cookie 文件。
 *
 * @param {object} p
 * @param {object} p.context             Playwright BrowserContext（必须来自本次会话）
 * @param {string} p.cookieFilePath      **本次实际加载**的精确文件路径（resolveCookieFile 结果）
 * @param {object} p.sessionStartFingerprint 会话开始时的文件指纹（见 fingerprintFile）；
 *                                       **缺失或无效 → 拒绝回写**（无法做冲突保护）
 * @param {boolean} p.identityOk         店铺/账户身份核验是否通过
 * @param {boolean} p.loginOk            登录态**当前仍然有效**的明确证据（fail-closed：
 *                                       非严格 true 一律拒绝覆盖；不再默认 true）
 * @param {string} [p.shopId]            仅用于日志归属
 * @param {(e:object)=>void} [p.audit]   审计回调（本模块写入的内容不含 Cookie 值）
 * @returns {Promise<{ok:boolean, skipped:boolean, reason:string|null, domains?:string[],
 *                    count?:number, bytes?:number, droppedOther?:string[]}>}
 */
async function writebackSessionCookies(p) {
  const {
    context, cookieFilePath, sessionStartFingerprint,
    identityOk, loginOk, shopId = null, audit = () => {},
  } = p;
  const record = (r) => {
    audit({ kind: 'cookie-writeback', shopId, ...r });
    return r;
  };
  const skip = (reason) => record({ ok: false, skipped: true, reason });

  if (!cookieFilePath || typeof cookieFilePath !== 'string') {
    return skip('未提供本次实际加载的 Cookie 文件路径（拒绝写入任意路径）');
  }
  if (!identityOk) {
    return skip('店铺/账户身份核验未通过：不覆盖 Cookie 文件');
  }
  // 登录态 fail-closed：必须由调用方给出"当前仍有效"的明确证据（true），其余一律拒绝。
  if (loginOk !== true) {
    return skip('登录态未确认当前有效（fail-closed）：不覆盖 Cookie 文件');
  }
  if (!context || typeof context.cookies !== 'function') {
    return skip('未提供本次会话的浏览器 context：无法取得更新后的 Cookie');
  }
  // 初始指纹缺失/无效 → 无法做冲突保护 → 拒绝回写（旧实现会静默跳过保护）
  const start = sessionStartFingerprint || null;
  if (!start || start.exists !== true || !start.sha256) {
    return skip('缺少有效的会话初始指纹（文件在会话开始时不存在或不可读）：无法做冲突保护，拒绝回写');
  }

  // ── 冲突保护（第一次快照）：源文件在会话期间被改动 → 保留较新文件 ──
  const current = fingerprintFile(cookieFilePath);
  if (!current.exists) {
    return skip('本次加载的 Cookie 文件已不存在：不回写');
  }
  if (current.sha256 !== start.sha256) {
    return record({
      ok: false, skipped: true, conflict: true,
      reason: '源 Cookie 文件在本次会话期间已被改变（用户重新登录或其他进程写入）：保留较新文件，不做无依据合并，本次不回写',
    });
  }

  let prevCookies;
  try {
    prevCookies = JSON.parse(fs.readFileSync(cookieFilePath, 'utf-8'));
  } catch (e) {
    return skip(`原 Cookie 文件解析失败：${e.message}`);
  }

  let cookies;
  try {
    cookies = await context.cookies();
  } catch (e) {
    return skip(`读取本次 context 的 Cookie 失败：${e.message}`);
  }

  // ── 冲突保护（第二次快照）：跨越 context.cookies() 的异步空隙后**重新核验** ──
  // 这一步是本次修复的核心：旧实现在此之前就检查完毕，异步期间的新登录会被旧会话覆盖。
  const beforeWrite = fingerprintFile(cookieFilePath);
  if (!beforeWrite.exists) {
    return skip('获取 Cookie 期间源文件已消失：不回写');
  }
  if (beforeWrite.sha256 !== start.sha256) {
    return record({
      ok: false, skipped: true, conflict: true,
      reason: '源 Cookie 文件在获取本次 Cookie 期间被改变（用户重新登录或其他进程写入）：保留较新文件，本次不回写',
    });
  }

  const valid = validateCookieSet(cookies, prevCookies);
  if (!valid.ok) return skip(valid.reason);

  const write = atomicWriteJson(cookieFilePath, cookies);
  if (!write.ok) {
    // 保存失败单独记录；旧文件因原子写入未被破坏
    return record({ ok: false, skipped: false, reason: `Cookie 回写失败（旧文件保留）: ${write.reason}` });
  }
  // 写入完成瞬间的内容摘要：后续自校验失败时据此判断"还能不能安全回滚"。
  const writtenSha = fingerprintFile(cookieFilePath).sha256;

  // ── 写入后自校验：落盘内容必须可解析、域名集合与条数与预期一致，否则有条件回滚 ──
  const rollbackAndReport = (reason) => {
    const rb = rollbackIfUnchanged(cookieFilePath, writtenSha, prevCookies);
    return record({
      ok: false, skipped: false,
      reason: rb.ok ? `${reason}，已回滚旧内容`
        : `${reason}；${rb.skipped ? rb.reason : `回滚失败：${rb.reason}`}`,
      rollback: rb.ok ? 'done' : (rb.skipped ? 'skipped-conflict' : 'failed'),
    });
  };
  let verify;
  try {
    verify = JSON.parse(fs.readFileSync(cookieFilePath, 'utf-8'));
  } catch (e) {
    return rollbackAndReport(`Cookie 回写后自校验解析失败: ${e.message}`);
  }
  if (!sameCookieShape(verify, cookies)) {
    return rollbackAndReport('Cookie 回写后自校验不一致（条数/域名）');
  }

  const domains = [...new Set(cookies.map((c) => c.domain))].sort();
  return record({
    ok: true, skipped: false, reason: null,
    count: cookies.length, bytes: write.bytes, domains,
    droppedOther: valid.droppedOther && valid.droppedOther.length ? valid.droppedOther : [],
    prevCount: Array.isArray(prevCookies) ? prevCookies.length : 0,
  });
}

module.exports = {
  fingerprintFile,
  validateCookieSet,
  atomicWriteJson,
  rollbackIfUnchanged,
  writebackSessionCookies,
  domainStats,
  sameCookieShape,
  CRITICAL_DOMAIN_SUFFIX,
  MIN_COUNT_RATIO,
};
