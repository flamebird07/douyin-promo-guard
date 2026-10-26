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
 *  7. **写后确切字节自校验（2026-10-18 强化）**：写入前先序列化并计算自有指纹，
 *     写后读回落盘文件逐字节比对；不一致即失败，且**不回滚**——落盘内容已不是本次写入
 *     的那份（可能被其他 writer 替换），回滚会覆盖并发新数据。rollbackIfUnchanged 仅保留
 *     给需要显式回滚的调用方，本写入器不再以"写后读到的 sha"作为自有指纹。
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
 *
 * 2026-10-18 第三轮定点修复（登录 Cookie 完整性 / 写后确切字节校验）：
 *  旧实现的两个漏洞：
 *   a) validateCookieSet 只校验"至少一个 value 非空 + 关键域存在 + 条数不塌缩"，
 *      因此原集合里仍有效的 sid_guard/sessionid 等认证 Cookie 被删除、被置空、
 *      或被改写成已过期条目时，写回仍然返回 ok=true —— 把可用登录态覆盖成不可用。
 *   b) 写后自校验只用 sameCookieShape（条数/域名），同形不同值（写错内容）仍算成功；
 *      且回滚用的 own sha 是在写入**之后**从落盘文件读取的，若另一 writer 恰在此窗口
 *      写入新内容，会把别人的指纹当成自己的，随后回滚覆盖并发新数据。
 *  现修复：
 *   a) 写前按**精确身份键 (name, domain, path, partitionKey)** 核验原集合中仍然有效的
 *      认证 Cookie（白名单 AUTH_COOKIE_NAMES）：新集合必须存在同身份键、非空值且未过期的
 *      条目。只保护"原集合中仍然有效"的条目——旧集合本就过期/空值/不存在的认证 Cookie
 *      不臆造为必需项，正常非空轮换（值变化）不受影响。
 *   b) 写入前先序列化，计算**本次拟写字节**的 sha256 作为自有写入指纹；写后读回确切字节
 *      逐字节比对。不一致时判定失败（绝不假成功），且**不回滚**——因为落盘内容不是我们
 *      写的那份，回滚会覆盖其他 writer 的新数据。错误/返回值/审计只含名称、数量、指纹，
 *      绝不含 Cookie 值。
 *
 * 2026-10-18 第四轮定点修复（Root 独立反例 A–D）：
 *   A) fsync 临时文件期间另一 writer 改写目标文件 → rename 仍会覆盖新文件并返回成功。
 *      现于 fsync 之后、rename 之前按本次冻结的目标文件指纹再核对一次；漂移则删除本次
 *      临时文件、保留他人新文件、明确报冲突。atomicWriteJson/atomicWriteSerialized 公共
 *      API 兼容（新参数可选）。仍不宣称消除最后系统调用之间的所有竞态（窗口极小但非零）。
 *   B) expires=0 是 Unix epoch（早已过期），不是会话 Cookie（Playwright 会话标记是 -1）；
 *      旧判定 `e > 0` 误放行 expires=0。有效 sessionid 被改成 expires=0 必须拒绝。
 *   C) 同一精确身份键出现多个候选（如一个有效 sessionid + 一个空 sessionid）时，
 *      旧 `cands.some(有效)` 放行，但重新注入可能后者覆盖前者 → 改为保守拒绝重复候选
 *      （不同 partitionKey 属不同身份键，可并存）。
 *   D) context.cookies()/序列化异常的 e.message 可能含 Cookie 值 → 不再把任意异常内容
 *      输出到审计；仅回显检查点自产且显式标记 reasonSafeForAudit 的阶段原因，
 *      其余降级为无值的安全错误码。
 *
 * 2026-10-20 第六轮（AD-WATCHDOG-COOKIE-VERIFY-20261020-F1）：**写回/提升的是验证 context
 *  的最终已验证 Cookie 集合**。
 *  根因（瑾漂亮潮流服饰持续"登录验证未通过"的重点核查假设，离线链路证实）：候选验证器把
 *  待写字节注入独立验证 context 并访问受信抖店首页；平台可能在这次验证访问中**轮换登录
 *  Cookie**（旧会话令牌作废、新令牌下发）。旧实现只回 `{ok:true}`，随后仍落盘**原始候选**
 *  字节，验证 context 中更新后的 Cookie 被丢弃 → 落盘即过时，下次加载直接登录失效。
 *  现修复：
 *   a) 验证器只有在同一独立 context 已取得受信抖店首页与唯一正确店名后，才安全取得该
 *      context 的**最终 Cookie 集合**并随 `{ok:true, finalCookies}` 返回；
 *   b) 写入器对最终集合重新执行结构、关键 auth（相对落盘集合与候选集合双保险）、防跨店
 *      域完整性与既有 CAS 校验，落盘**最终已验证集合的确定性序列化字节**；
 *   c) 兼容路径：验证器未返回最终集合（含空/非法）→ fail-closed 拒绝写入，绝不落盘
 *      未验证数据；原因/审计只含 Cookie 名称、数量、指纹，绝不含值。
 *
 * 2026-10-19 第五轮（AD-COOKIE-FOUR-TIER）：**先独立验证后提交**。
 *  旧实现把「当前 context 的 cookies() + 当前页身份」直接写盘：坏掉的候选（例如页面
 *  仍显示已登录但会话 Cookie 已被服务端作废）会污染工作副本。现支持由调用方注入
 *  `precommitVerify({cookies, serialized, buf, sha256})`（生产由 session-cookie-checkpoint
 *  用同一浏览器的**隔离新 context** 注入本次待写字节，验证可复用性与店铺身份；无浏览器
 *  可用时必须 fail-closed）。验证通过后：
 *   a) 以 `precommitBaseline`（验证开始前冻结的目标指纹，默认会话初始指纹）复核目标：
 *      验证期间出现并发新登录/写入 → 较新者胜出，放弃本次回写；
 *   b) 写前保留上一版 `<target>.prev-<ts>-<rand>`（fail-closed：备份失败即放弃）；
 *   c) CAS 写入 + 逐字节回读（沿用既有语义）。
 *  验证/备份只在调用方显式传入 `precommitVerify` 时启用，既有直接调用者语义不变。
 *  目标路径可经 `workRoot`/`protectedDirs` 限制：必须在工作根内，且不得位于来源、
 *  归档、恢复、分析工作目录内（不重写其他层）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 业务关键域后缀：这些域在回写中缺失 → 直接拒绝覆盖。 */
const CRITICAL_DOMAIN_SUFFIX = 'jinritemai.com';
/** 数量塌缩保护：新集合条数不得低于原条数的该比例。 */
const MIN_COUNT_RATIO = 0.6;

/**
 * 受保护的登录认证 Cookie 名称（抖店/千川登录令牌族）。
 *
 * 依据：这些名称对应抖音/抖店的会话 ID、SSO 会话、uid 绑定与 UCP 授权令牌；
 * 任一原值非空且未过期的条目缺失、被置空或被改写成已过期条目，都会让下一次加载
 * 直接进入登录页。偏好类 Cookie（浮窗标记、站点偏好等）不属于认证，不在此列。
 *
 * 保护范围仅限"**原集合中仍然有效**"（value 非空、未过期）且具备完整身份键的条目：
 * 旧集合本就没有、本就过期或本就为空 → 不要求新集合保留（浏览器清理过期令牌不应阻断刷新）。
 */
const AUTH_COOKIE_NAMES = new Set([
  'sessionid',
  'sessionid_ss',
  'sid_guard',
  'sid_tt',
  'uid_tt',
  'uid_tt_ss',
  'sid_ucp_v1',
  'ssid_ucp_v1',
]);

function normDomain(d) {
  return String(d || '').trim().replace(/^\./, '').toLowerCase();
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * 过期判定：Playwright 的 expires 为秒级时间戳。
 *  - `-1` 是 Playwright 的会话 Cookie 标记（缺失/null 同义）→ 不判过期；
 *  - `0` 是 Unix epoch（1970-01-01），语义为**早已过期**，绝不是会话标记 → 判过期
 *    （2026-10-18 修复：旧实现 `e > 0` 把 expires=0 误当会话 Cookie 放行，
 *    有效 sessionid 被改写成 expires=0 后仍可覆盖旧文件）；
 *  - 正数 <= now → 已过期。
 */
function isExpiredCookie(c, nowSec = nowSeconds()) {
  if (!c || typeof c !== 'object') return false;
  if (c.expires === undefined || c.expires === null || c.expires === '') return false;
  const e = Number(c.expires);
  return Number.isFinite(e) && e >= 0 && e <= nowSec;
}

/** partitionKey 规范化（兼容字符串与对象两种形态；缺失/null 统一为空串）。 */
function normalizePartitionKey(pk) {
  if (pk === undefined || pk === null) return '';
  if (typeof pk === 'string') return pk;
  if (typeof pk === 'object') {
    const keys = Object.keys(pk).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(pk[k])}`).join(',')}}`;
  }
  return String(pk);
}

/**
 * 精确身份键：name + domain + path + partitionKey（如适用）。
 * domain 保留前导点语义（`.jinritemai.com` 与 `jinritemai.com` 是不同 Cookie），只做 trim/小写。
 * 返回字符串仅用于比对，不包含 value。
 */
function cookieIdentityKey(c) {
  const name = String((c && c.name) || '');
  const domain = String((c && c.domain) || '').trim().toLowerCase();
  const p = c && c.path !== undefined && c.path !== null ? String(c.path) : '/';
  const pk = normalizePartitionKey(c && c.partitionKey);
  return `${name}\u0000${domain}\u0000${p}\u0000${pk}`;
}

/**
 * 从原集合中提取"必须被新集合保留"的认证 Cookie。
 * 只返回：名称在白名单、value 非空、未过期、具备非空 domain 的条目。
 */
function protectedAuthCookies(prevCookies, nowSec = nowSeconds()) {
  const out = [];
  for (const c of Array.isArray(prevCookies) ? prevCookies : []) {
    if (!c || typeof c !== 'object') continue;
    if (!AUTH_COOKIE_NAMES.has(String(c.name))) continue;
    if (typeof c.value !== 'string' || c.value.length === 0) continue;
    if (typeof c.domain !== 'string' || c.domain.trim() === '') continue;
    if (isExpiredCookie(c, nowSec)) continue;
    out.push(c);
  }
  return out;
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

/** targetPath 是否位于 rootDir 内（realpath；target 可不存在，用现存父链解析）。 */
function isInsideRealDir(rootDir, targetPath) {
  if (!rootDir || !targetPath) return false;
  let r;
  try { r = fs.realpathSync(rootDir); } catch (_) { return false; }
  let t = path.resolve(String(targetPath));
  try { t = fs.realpathSync(t); } catch (_) {
    let pr;
    try { pr = fs.realpathSync(path.dirname(t)); } catch (_) { return false; }
    t = path.join(pr, path.basename(t));
  }
  const rel = path.relative(r, t);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function tsTag(nowFn) {
  const d = new Date(nowFn());
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/** 写前备份上一版（独占创建 + fsync + 回读比对）；失败即放弃提交（fail-closed）。 */
function backupExistingFile(targetPath, nowFn) {
  let buf;
  try { buf = fs.readFileSync(targetPath); } catch (_) {
    return { ok: false, reason: '读取上一版内容失败' };
  }
  const backupPath = `${targetPath}.prev-${tsTag(nowFn)}-${crypto.randomBytes(3).toString('hex')}`;
  let fd = null;
  try {
    fd = fs.openSync(backupPath, 'wx', 0o600);
    fs.writeSync(fd, buf);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
  } catch (_) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (__) { /* ignore */ } }
    try { fs.unlinkSync(backupPath); } catch (__) { /* 只清自有备份 */ }
    return { ok: false, reason: '写入备份文件失败' };
  }
  try {
    const back = fs.readFileSync(backupPath);
    if (!back.equals(buf)) return { ok: false, reason: '备份文件回读与上一版字节不一致' };
  } catch (_) {
    return { ok: false, reason: '备份文件无法回读' };
  }
  return { ok: true, backupPath };
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

  // ── 登录认证 Cookie 完整性（精确身份键 + 非空 + 未过期）──────────────
  // 只保护原集合中仍然有效的认证条目；值改变（正常轮换）允许，缺失/空值/已过期拒绝。
  const nowSec = nowSeconds();
  const protectedAuth = protectedAuthCookies(prevCookies, nowSec);
  if (protectedAuth.length > 0) {
    const byKey = new Map();
    for (const c of cookies) {
      const k = cookieIdentityKey(c);
      if (!byKey.has(k)) byKey.set(k, []);
      byKey.get(k).push(c);
    }
    const missing = [];
    const empty = [];
    const expired = [];
    const duplicate = [];
    for (const pc of protectedAuth) {
      const cands = byKey.get(cookieIdentityKey(pc));
      if (!cands || cands.length === 0) { missing.push(String(pc.name)); continue; }
      // 同一精确身份键出现多个候选（如一个有效 + 一个空值）→ 保守拒绝：
      // 重新注入时后者可能覆盖前者，"任一有效即通过"会放行这种覆盖。
      // 不同 partitionKey 是不同身份键，天然可并存，不在此列。
      if (cands.length > 1) { duplicate.push(String(pc.name)); continue; }
      const c = cands[0];
      if (typeof c.value === 'string' && c.value.length > 0 && !isExpiredCookie(c, nowSec)) continue;
      if (typeof c.value === 'string' && c.value.length === 0) empty.push(String(pc.name));
      else expired.push(String(pc.name));
    }
    const uniq = (arr) => [...new Set(arr)];
    if (missing.length || empty.length || expired.length || duplicate.length) {
      const parts = [];
      if (missing.length) parts.push(`缺失 ${uniq(missing).join(',')}`);
      if (empty.length) parts.push(`空值 ${uniq(empty).join(',')}`);
      if (expired.length) parts.push(`已过期 ${uniq(expired).join(',')}`);
      if (duplicate.length) parts.push(`同一身份键重复候选 ${uniq(duplicate).join(',')}`);
      return {
        ok: false,
        reason: `原集合中仍有效的登录认证 Cookie 在待写集合中${parts.join('；')}（拒绝覆盖，防止登录态失效）`,
        protectedAuth: uniq(protectedAuth.map((c) => String(c.name))),
        authMissing: uniq(missing),
        authEmpty: uniq(empty),
        authExpired: uniq(expired),
        authDuplicate: uniq(duplicate),
      };
    }
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
  return {
    ok: true, reason: null, droppedCritical, droppedOther,
    protectedAuth: [...new Set(protectedAuth.map((c) => String(c.name)))],
    prevCount: prev.length, nextCount: cookies.length,
  };
}

/** 与持久化完全一致的序列化格式（写入器与检查点共用同一字节口径）。 */
function serializeCookies(cookies) {
  return JSON.stringify(cookies, null, 2);
}

function sha256Of(bufOrString) {
  return crypto.createHash('sha256').update(bufOrString).digest('hex');
}

function sameCookieSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const canonical = cookies => cookies.map(cookie => JSON.stringify(Object.fromEntries(
    Object.keys(cookie).sort().map(key => [key, key === 'partitionKey' ? normalizePartitionKey(cookie[key]) : cookie[key]]),
  ))).sort();
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * 最终已验证集合相对「候选集合」的关键认证双保险：候选集合中仍然有效（非空、未过期、
 * 具备完整身份键）的认证 Cookie，必须在最终集合中以同身份键、非空、未过期、唯一出现。
 * 值可以轮换（正常刷新），但缺失/被置空/被改过期/同一身份键重复候选 → 拒绝（fail-closed）。
 * 只返回名称与判定，不含任何 Cookie 值。独立验证器内部已对回读集合做过同类核验，这里是
 * 写入器侧的第二道闸（防止验证器把候选原样回传却遗漏认证保护，或注入被改坏的最终集合）。
 */
function finalPreservesCandidateAuth(finalCookies, candidateCookies, nowSec = nowSeconds()) {
  const protectedAuth = protectedAuthCookies(candidateCookies, nowSec);
  if (protectedAuth.length === 0) return { ok: true, reason: null };
  const byKey = new Map();
  for (const c of Array.isArray(finalCookies) ? finalCookies : []) {
    const k = cookieIdentityKey(c);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(c);
  }
  const missing = [];
  const empty = [];
  const expired = [];
  const duplicate = [];
  for (const pc of protectedAuth) {
    const cands = byKey.get(cookieIdentityKey(pc));
    if (!cands || cands.length === 0) { missing.push(String(pc.name)); continue; }
    if (cands.length > 1) { duplicate.push(String(pc.name)); continue; }
    const c = cands[0];
    if (typeof c.value === 'string' && c.value.length > 0 && !isExpiredCookie(c, nowSec)) continue;
    if (typeof c.value === 'string' && c.value.length === 0) empty.push(String(pc.name));
    else expired.push(String(pc.name));
  }
  const uniq = (arr) => [...new Set(arr)];
  if (missing.length || empty.length || expired.length || duplicate.length) {
    const parts = [];
    if (missing.length) parts.push(`缺失 ${uniq(missing).join(',')}`);
    if (empty.length) parts.push(`空值 ${uniq(empty).join(',')}`);
    if (expired.length) parts.push(`已过期 ${uniq(expired).join(',')}`);
    if (duplicate.length) parts.push(`同一身份键重复候选 ${uniq(duplicate).join(',')}`);
    return {
      ok: false,
      reason: `候选集合中仍有效的登录认证 Cookie 在最终已验证集合中${parts.join('；')}（拒绝落盘，防止登录态失效）`,
      authMissing: uniq(missing), authEmpty: uniq(empty), authExpired: uniq(expired), authDuplicate: uniq(duplicate),
    };
  }
  return { ok: true, reason: null };
}

/**
 * 原子写入**确切字节**（同目录临时文件 + fsync + rename）。
 * 返回 {ok, bytes, sha256} —— sha256 是本次实际写入字节的摘要，可由调用方在写入前
 * 用同一份序列化预先计算，作为"自有写入指纹"。失败时清理临时文件，旧文件不受影响。
 *
 * 2026-10-18 修复（Root 反例 A）：fsync 临时文件期间另一 writer 改写目标文件后，
 * 旧实现仍执行 rename 覆盖新文件并返回成功。现支持可选 `expectedTargetSha256`
 * （本次冻结的目标文件指纹）：fsync 之后、rename 之前重新核对目标文件；漂移 →
 * 删除本次临时文件、保留他人新文件、返回明确冲突（conflict:true）。
 * 边界如实声明：核对与 rename 之间仍存在极小窗口，本函数**不宣称**消除最后
 * 系统调用之间的所有竞态（完整互斥需要文件锁）。
 */
function atomicWriteSerialized(filePath, serialized, expectedTargetSha256 = null) {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  let fd = null;
  try {
    const buf = Buffer.from(String(serialized), 'utf8');
    fd = fs.openSync(tmp, 'wx', 0o600);
    let off = 0;
    while (off < buf.length) off += fs.writeSync(fd, buf, off, buf.length - off);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (expectedTargetSha256) {
      const cur = fingerprintFile(filePath);
      if (!cur.exists || cur.sha256 !== expectedTargetSha256) {
        try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
        return {
          ok: false, conflict: true,
          reason: '目标文件在本次写入期间（fsync 后、rename 前）被其他写入者改写：放弃本次覆盖，保留他人新文件，已删除本次临时文件',
          beforeSha256: expectedTargetSha256, afterSha256: cur.sha256,
        };
      }
    }
    fs.renameSync(tmp, filePath);
    return { ok: true, bytes: buf.length, sha256: sha256Of(buf) };
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) { /* ignore */ } }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    return { ok: false, reason: e.message };
  }
}

/** 原子写入 JSON（序列化异常视为写入失败，旧文件不受影响；可选冻结指纹透传 rename 前复核）。 */
function atomicWriteJson(filePath, data, expectedTargetSha256 = null) {
  let serialized;
  try {
    serialized = serializeCookies(data);
  } catch (e) {
    return { ok: false, reason: e.message };
  }
  return atomicWriteSerialized(filePath, serialized, expectedTargetSha256);
}

/**
 * 有条件回滚：**仅当文件仍是我们刚写入的那份内容**（sha256 一致）才回滚。
 *
 * 为什么需要它：回滚本身是一次覆盖写。若在失败判定到回滚之间另一个进程（或用户重新登录）
 * 已经写入了更新的内容，无条件回滚会把**新登录结果**覆盖掉，造成静默丢失。
 * 这里用**调用方在写入前预先计算的自有写入指纹**（本次拟写字节的 sha256）做比对-后-写；
 * 绝不能在写入后从落盘文件读取 sha 当作自有指纹（那可能属于另一个 writer）。
 *
 * 边界：比对与 rename 之间仍有极小窗口（见文件头说明），此处不宣称完全互斥。
 * @param {string} filePath
 * @param {string} writtenSha256  本次拟写字节的 sha256（写入前由调用方计算）
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
  // 回滚同样传入冻结指纹：fsync 后、rename 前再核对一次，缩小（不消除）比对-写入窗口。
  const r = atomicWriteJson(filePath, prevCookies, writtenSha256);
  if (r.ok) return { ok: true, skipped: false };
  if (r.conflict) {
    return {
      ok: false, skipped: true,
      reason: '源文件在回滚写入前（fsync 后、rename 前复核）已被其他进程改写：放弃回滚，保留较新文件',
    };
  }
  return { ok: false, skipped: false, reason: r.reason };
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
    precommitVerify = null, precommitBaseline = null,
    workRoot = null, protectedDirs = [], nowFn = () => Date.now(),
  } = p;
  const record = (r) => {
    audit({ kind: 'cookie-writeback', shopId, ...r });
    return r;
  };
  const skip = (reason) => record({ phase: 'precheck', ok: false, skipped: true, reason });

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
  // 目标必须是普通文件：符号链接/目录/别名一律拒绝（路径别名不当隔离）
  let targetLstat = null;
  try { targetLstat = fs.lstatSync(cookieFilePath); } catch (e) {
    return skip(`本次加载的 Cookie 文件状态不可判定（${(e && e.message) || e}）：拒绝回写`);
  }
  if (!targetLstat.isFile()) {
    return skip('Cookie 回写目标是符号链接/目录/非普通文件（路径别名）：拒绝写入');
  }

  // ── 写入目标边界：只允许本项目工作根内的文件，且不得触碰来源/归档/恢复/分析层 ──
  if (workRoot) {
    if (!isInsideRealDir(workRoot, cookieFilePath)) {
      return skip('Cookie 回写目标不在本项目工作根内（拒绝写入来源或其他路径）');
    }
    for (const dir of Array.isArray(protectedDirs) ? protectedDirs : []) {
      if (dir && isInsideRealDir(dir, cookieFilePath)) {
        return skip('Cookie 回写目标位于来源/归档/恢复/分析工作目录内（拒绝重写其他层）');
      }
    }
  }

  // ── 冲突保护（第一次快照）：源文件在会话期间被改动 → 保留较新文件 ──
  const current = fingerprintFile(cookieFilePath);
  if (!current.exists) {
    return skip('本次加载的 Cookie 文件已不存在：不回写');
  }
  if (current.sha256 !== start.sha256) {
    return record({
      phase: 'conflict', ok: false, skipped: true, conflict: true,
      beforeSha256: start.sha256, afterSha256: current.sha256,
      reason: '源 Cookie 文件在本次会话期间已被改变（用户重新登录或其他进程写入）：保留较新文件，不做无依据合并，本次不回写',
    });
  }

  let prevCookies;
  try {
    prevCookies = JSON.parse(fs.readFileSync(cookieFilePath, 'utf-8'));
  } catch (_) {
    // 不拼接 JSON.parse 的原始错误：其消息可能包含文件片段（Cookie 值）。
    return skip('原 Cookie 文件解析失败（不是有效 JSON）：拒绝覆盖（不回显文件内容）');
  }

  let cookies;
  try {
    cookies = await context.cookies();
  } catch (e) {
    // 任意异常的 e.message 可能含 Cookie 值（如驱动回显解析片段），绝不直接进审计。
    // 仅当异常由检查点自产（显式标记 reasonSafeForAudit=true，内容只有阶段原因）才回显；
    // 其余一律降级为无值的安全错误码。
    const safeReason = (e && e.reasonSafeForAudit === true && typeof e.message === 'string') ? e.message : null;
    return skip(safeReason !== null
      ? `读取本次 context 的 Cookie 失败（复验拒绝）：${safeReason}`
      : '读取本次 context 的 Cookie 失败（异常详情可能含 Cookie 值，不回显）：context-cookies-read-failed');
  }

  // ── 冲突保护（第二次快照）：跨越 context.cookies() 的异步空隙后**重新核验** ──
  // 这一步是本次修复的核心：旧实现在此之前就检查完毕，异步期间的新登录会被旧会话覆盖。
  const beforeWrite = fingerprintFile(cookieFilePath);
  if (!beforeWrite.exists) {
    return skip('获取 Cookie 期间源文件已消失：不回写');
  }
  if (beforeWrite.sha256 !== start.sha256) {
    return record({
      phase: 'conflict', ok: false, skipped: true, conflict: true,
      beforeSha256: start.sha256, afterSha256: beforeWrite.sha256,
      reason: '源 Cookie 文件在获取本次 Cookie 期间被改变（用户重新登录或其他进程写入）：保留较新文件，本次不回写',
    });
  }

  const valid = validateCookieSet(cookies, prevCookies);
  if (!valid.ok) {
    return record({
      phase: 'validate', ok: false, skipped: true, reason: valid.reason,
      ...(valid.protectedAuth ? { protectedAuth: valid.protectedAuth } : {}),
      ...(valid.authMissing ? { authMissing: valid.authMissing } : {}),
      ...(valid.authEmpty ? { authEmpty: valid.authEmpty } : {}),
      ...(valid.authExpired ? { authExpired: valid.authExpired } : {}),
      ...(valid.authDuplicate ? { authDuplicate: valid.authDuplicate } : {}),
      beforeSha256: beforeWrite.sha256,
    });
  }

  // ── 候选集合序列化 + 自有写入指纹：作为独立验证器的输入字节 ──────────────
  // 当没有独立验证器（既有直接调用者）时，落盘的就是这份候选字节（exact-bytes 语义不变）。
  // 有独立验证器时，落盘改为「验证 context 的最终已验证集合」的确定性序列化（见下）。
  let candSerialized;
  try {
    candSerialized = serializeCookies(cookies);
  } catch (e) {
    // 不回显 e.message：序列化异常内容可能涉及条目细节，只保留无值的安全错误码。
    return record({
      phase: 'write', ok: false, skipped: false,
      reason: 'Cookie 回写失败（旧文件保留，序列化异常详情不回显）: cookie-serialize-failed',
      beforeSha256: beforeWrite.sha256,
    });
  }
  const beforeSha256 = beforeWrite.sha256;

  // 实际落盘集合与其确定性字节/指纹：默认候选；独立验证通过后替换为最终已验证集合。
  let writeCookies = cookies;
  let serialized = candSerialized;
  let expectedBuf = Buffer.from(serialized, 'utf8');
  let expectedSha256 = sha256Of(expectedBuf);
  let backupPath = null;
  let verification = 'exact-bytes';
  let wroteFinalSet = false;
  let finalProtectedAuth = valid.protectedAuth || [];

  // ── 先独立验证（隔离新 context 注入本次待写字节）再提交 ────────────────
  // 生产入口（session-cookie-checkpoint）必须注入；无浏览器可用时验证器自身 fail-closed。
  // 验证失败 → 保留现有工作副本，本轮零写入；不触碰归档/恢复/分析层。
  if (typeof precommitVerify === 'function') {
    let vr;
    try {
      vr = await precommitVerify({ cookies, serialized: candSerialized, buf: Buffer.from(candSerialized, 'utf8'), sha256: sha256Of(Buffer.from(candSerialized, 'utf8')), shopId });
    } catch (_) {
      vr = { ok: false, reason: '候选独立验证抛出异常（异常详情可能含敏感值，不回显）' };
    }
    if (!vr || vr.ok !== true) {
      return record({
        phase: 'candidate-verify', ok: false, skipped: false,
        conflict: !!(vr && vr.conflict), verification: 'independent-new-context',
        ...(vr && vr.classification ? { classification: vr.classification } : {}),
        reason: (vr && typeof vr.reason === 'string' && vr.reason)
          ? `候选未通过独立复用/身份验证：${vr.reason}（保留现有工作副本，未写入）`
          : '候选未通过独立复用/身份验证（保留现有工作副本，未写入）',
        beforeSha256,
      });
    }
    // ── 写入/落盘的是验证 context 的「最终已验证集合」（第六轮 F1 根因修复）────────
    // 平台可能在验证访问本身中轮换登录 Cookie：候选原样落盘会立即过时。必须取得同一
    // 独立 context 取得受信首页+唯一正确店名后的最终 Cookie；兼容路径（验证器未返回
    // 最终集合 / 空 / 非法）一律 fail-closed，绝不落盘未验证的候选字节。
    const finalCookies = vr.finalCookies;
    if (!Array.isArray(finalCookies) || finalCookies.length === 0) {
      return record({
        phase: 'final-set', ok: false, skipped: false, verification: 'independent-new-context',
        reason: '独立验证通过但未返回最终已验证 Cookie 集合（缺失/为空/非法）：fail-closed，绝不落盘未验证候选字节',
        beforeSha256,
      });
    }
    // 对最终集合重新执行：结构 + 关键 auth（相对落盘集合）+ 防跨店域完整性/数量守卫。
    const finalValid = validateCookieSet(finalCookies, prevCookies);
    if (!finalValid.ok) {
      return record({
        phase: 'final-validate', ok: false, skipped: false, verification: 'independent-new-context',
        reason: finalValid.reason,
        ...(finalValid.authMissing ? { authMissing: finalValid.authMissing } : {}),
        ...(finalValid.authEmpty ? { authEmpty: finalValid.authEmpty } : {}),
        ...(finalValid.authExpired ? { authExpired: finalValid.authExpired } : {}),
        ...(finalValid.authDuplicate ? { authDuplicate: finalValid.authDuplicate } : {}),
        beforeSha256,
      });
    }
    // 关键 auth 相对「候选集合」双保险：候选中仍有效的认证 Cookie 必须在最终集合保留。
    const candAuth = finalPreservesCandidateAuth(finalCookies, cookies);
    if (!candAuth.ok) {
      return record({
        phase: 'final-validate', ok: false, skipped: false, verification: 'independent-new-context',
        reason: candAuth.reason,
        ...(candAuth.authMissing ? { authMissing: candAuth.authMissing } : {}),
        ...(candAuth.authExpired ? { authExpired: candAuth.authExpired } : {}),
        beforeSha256,
      });
    }
    // 最终集合序列化 + 自有写入指纹（写入/成功判定/回滚只认这份字节）。
    try {
      serialized = serializeCookies(finalCookies);
    } catch (e) {
      return record({
        phase: 'write', ok: false, skipped: false, verification: 'independent-new-context',
        reason: '最终已验证集合序列化失败（旧文件保留，异常详情不回显）: cookie-final-serialize-failed',
        beforeSha256,
      });
    }
    writeCookies = finalCookies;
    expectedBuf = Buffer.from(serialized, 'utf8');
    expectedSha256 = sha256Of(expectedBuf);
    wroteFinalSet = true;
    finalProtectedAuth = finalValid.protectedAuth || [];

    let currentCookies;
    try { currentCookies = await context.cookies(); } catch (_) {
      return skip('独立验证后无法复验源上下文：拒绝提交旧候选');
    }
    if (!sameCookieSet(JSON.parse(candSerialized), currentCookies)) {
      return record({
        phase: 'source-conflict', ok: false, skipped: true, conflict: true,
        reason: '源上下文在独立验证期间已推进 Cookie：不提交过时候选、不回灌、不合并',
      });
    }

    // 验证开始前冻结的目标指纹：验证期间被并发写入（较新登录）→ 较新者胜出
    const base = (precommitBaseline && precommitBaseline.exists === true && precommitBaseline.sha256)
      ? precommitBaseline : start;
    const afterVerify = fingerprintFile(cookieFilePath);
    if (!afterVerify.exists || afterVerify.sha256 !== base.sha256) {
      return record({
        phase: 'conflict', ok: false, skipped: true, conflict: true,
        verification: 'independent-new-context',
        beforeSha256: base.sha256,
        afterSha256: afterVerify.exists ? afterVerify.sha256 : null,
        reason: '候选验证期间目标文件被并发写入（较新登录胜出）：放弃本次回写，保留较新文件（不 rebase、不合并）',
      });
    }
    // 写前保留上一版（fail-closed：备份失败即放弃提交）
    const bk = backupExistingFile(cookieFilePath, nowFn);
    if (!bk.ok) {
      return record({
        phase: 'write', ok: false, skipped: false,
        reason: `写前备份上一版失败（${bk.reason}）：放弃本次回写，旧文件保持原样`,
        beforeSha256,
      });
    }
    backupPath = bk.backupPath;
    verification = 'independent-new-context';
  }

  // 冻结指纹传入原子写入：fsync 后、rename 前再核对一次目标文件（Root 反例 A）。
  const write = atomicWriteSerialized(cookieFilePath, serialized, beforeSha256);
  if (!write.ok) {
    // 保存失败单独记录；旧文件因原子写入未被破坏
    return record({
      phase: 'write', ok: false, skipped: false,
      ...(write.conflict ? { conflict: true, rollback: 'skipped-conflict' } : {}),
      reason: write.conflict
        ? `Cookie 回写冲突：${write.reason}（不覆盖他人内容）`
        : `Cookie 回写失败（旧文件保留）: ${write.reason}`,
      beforeSha256, expectedSha256,
      ...(write.afterSha256 ? { afterSha256: write.afterSha256 } : {}),
    });
  }

  // ── 写后校验：读回落盘**确切字节**，必须与本次拟写字节逐字节一致 ─────────
  // 不一致 = 落盘内容不是我们写的那份（并发 writer 覆盖/文件被替换）：
  //   * 绝不返回 ok=true（同形不同值不得假成功）；
  //   * 绝不回滚（回滚会覆盖其他 writer 的并发新数据）。
  let afterBuf = null;
  try { afterBuf = fs.readFileSync(cookieFilePath); } catch (_) { afterBuf = null; }
  const afterSha256 = afterBuf ? sha256Of(afterBuf) : null;
  const exactBytes = afterBuf !== null
    && afterBuf.length === expectedBuf.length
    && afterBuf.equals(expectedBuf);
  if (!exactBytes) {
    return record({
      phase: 'verify', ok: false, skipped: false, conflict: true,
      reason: 'Cookie 回写后落盘字节与本次拟写字节不一致（同形不同值或被其他写入者替换）：不判定成功，且不回滚覆盖他人内容',
      beforeSha256, expectedSha256, afterSha256, rollback: 'skipped-conflict',
    });
  }

  const domains = [...new Set(writeCookies.map((c) => c.domain))].sort();
  const done = record({
    phase: 'done', ok: true, skipped: false, reason: null,
    count: writeCookies.length, bytes: write.bytes, domains,
    droppedOther: valid.droppedOther && valid.droppedOther.length ? valid.droppedOther : [],
    prevCount: Array.isArray(prevCookies) ? prevCookies.length : 0,
    protectedAuth: finalProtectedAuth,
    beforeSha256, expectedSha256, afterSha256,
    verification,
    ...(wroteFinalSet ? { wroteFinalSet: true } : {}),
    ...(backupPath ? { backupPath } : {}),
  });
  // Cookie 句柄不可枚举，避免审计序列化泄露值。
  if (wroteFinalSet) {
    try {
      Object.defineProperty(done, 'finalCookies', { value: writeCookies, enumerable: false, writable: false });
    } catch (_) { /* 冻结环境定义失败：调用方按缺失句柄降级跳过，不假成功 */ }
  }
  return done;
}

module.exports = {
  fingerprintFile,
  validateCookieSet,
  atomicWriteJson,
  atomicWriteSerialized,
  rollbackIfUnchanged,
  writebackSessionCookies,
  domainStats,
  sameCookieShape,
  serializeCookies,
  sha256Of,
  sameCookieSet,
  isInsideRealDir,
  backupExistingFile,
  cookieIdentityKey,
  protectedAuthCookies,
  finalPreservesCandidateAuth,
  isExpiredCookie,
  AUTH_COOKIE_NAMES,
  CRITICAL_DOMAIN_SUFFIX,
  MIN_COUNT_RATIO,
};
