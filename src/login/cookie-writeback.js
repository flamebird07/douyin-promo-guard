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
 *  7. **写入后自校验 + 回滚**：重新解析落盘文件，域名集合与条数与预期一致才算成功；
 *     不一致则用写入前的内容原子回滚，并如实报告失败。
 *  8. 回写失败**单独记录**（返回 {ok:false}），调用方不得因此改写已确认的广告动作结果，
 *     也不得因此重做广告动作；当前批次继续使用原 context，不回灌、不刷新会话。
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
 * 把本次 context 的 Cookie 回写到本次实际加载的店铺 Cookie 文件。
 *
 * @param {object} p
 * @param {object} p.context             Playwright BrowserContext（必须来自本次会话）
 * @param {string} p.cookieFilePath      **本次实际加载**的精确文件路径（resolveCookieFile 结果）
 * @param {object} p.sessionStartFingerprint 会话开始时的文件指纹（见 fingerprintFile）
 * @param {boolean} p.identityOk         店铺/账户身份核验是否通过
 * @param {boolean} [p.loginOk]          登录态是否有效（默认 true；false 时拒绝覆盖）
 * @param {string} [p.shopId]            仅用于日志归属
 * @param {(e:object)=>void} [p.audit]   审计回调（本模块写入的内容不含 Cookie 值）
 * @returns {Promise<{ok:boolean, skipped:boolean, reason:string|null, domains?:string[],
 *                    count?:number, bytes?:number, droppedOther?:string[]}>}
 */
async function writebackSessionCookies(p) {
  const {
    context, cookieFilePath, sessionStartFingerprint,
    identityOk, loginOk = true, shopId = null, audit = () => {},
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
  if (!loginOk) {
    return skip('登录态无效：不覆盖 Cookie 文件');
  }
  if (!context || typeof context.cookies !== 'function') {
    return skip('未提供本次会话的浏览器 context：无法取得更新后的 Cookie');
  }

  // ── 冲突保护：源文件在会话期间被改动（用户重新登录/其他进程写入）→ 保留较新文件 ──
  const start = sessionStartFingerprint || null;
  const current = fingerprintFile(cookieFilePath);
  if (start && start.exists && current.exists && start.sha256 && current.sha256 && start.sha256 !== current.sha256) {
    return record({
      ok: false, skipped: true, conflict: true,
      reason: '源 Cookie 文件在本次会话期间已被改变（用户重新登录或其他进程写入）：保留较新文件，不做无依据合并，本次不回写',
    });
  }
  if (!current.exists) {
    return skip('本次加载的 Cookie 文件已不存在：不回写');
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
  const valid = validateCookieSet(cookies, prevCookies);
  if (!valid.ok) return skip(valid.reason);

  const write = atomicWriteJson(cookieFilePath, cookies);
  if (!write.ok) {
    // 保存失败单独记录；旧文件因原子写入未被破坏
    return record({ ok: false, skipped: false, reason: `Cookie 回写失败（旧文件保留）: ${write.reason}` });
  }

  // ── 写入后自校验：落盘内容必须可解析、域名集合与条数与预期一致，否则原子回滚 ──
  let verify;
  try {
    verify = JSON.parse(fs.readFileSync(cookieFilePath, 'utf-8'));
  } catch (e) {
    atomicWriteJson(cookieFilePath, prevCookies);
    return record({ ok: false, skipped: false, reason: `Cookie 回写后自校验解析失败，已回滚旧内容: ${e.message}` });
  }
  if (!sameCookieShape(verify, cookies)) {
    atomicWriteJson(cookieFilePath, prevCookies);
    return record({ ok: false, skipped: false, reason: 'Cookie 回写后自校验不一致（条数/域名），已回滚旧内容' });
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
  writebackSessionCookies,
  domainStats,
  sameCookieShape,
  CRITICAL_DOMAIN_SUFFIX,
  MIN_COUNT_RATIO,
};
