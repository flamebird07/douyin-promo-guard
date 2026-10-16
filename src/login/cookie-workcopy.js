'use strict';

/**
 * 推广侧 Cookie 工作副本（S99）：把「商品分析（电商助手）来源目录」当作**只读上游**，
 * 在本项目 cookies/ 工作根维护每店独立副本；自动写回链（cookie-writeback /
 * session-cookie-checkpoint）只允许落在工作副本上，绝不回写共享上游文件。
 *
 * 用户目标（2026-10-16 原话）：商品分析登录新账号扫码成功后准备两份一样的 Cookie，
 * 一份给商品分析、一份给推广广告控制，之后**各自刷新、互不影响**，不再要求重复扫码。
 * 因此「来源内容变化」本身**不等于**用户重新扫过码：商品分析普通读取的收尾保存同样会
 * 改写上游文件。只有 app 侧完成真实身份/复用校验 + 主文件 CAS 提交后的
 * `authorizedFreshLogin` 明确调用，才代表一次新登录。
 *
 * 硬性约束（全部落实为代码路径）：
 *  1. 对来源目录零写入：不 write/rename/unlink/chmod/mkdir，不在来源目录放 sidecar/tmp；
 *     临时文件与 sidecar（.meta）只写工作根。
 *  2. 来源必须是普通文件（lstat isFile；符号链接拒绝）、可解析的非空 Playwright Cookie
 *     数组，条目须有 name/value/domain/path 字符串且含 jinritemai 业务域；结构合格
 *     ≠ 平台登录有效，真实业务身份门（登录检测/身份核验）维持不变。
 *  3. 来源坏/为空/缺域/缺失/竞态时**绝不破坏已存在的工作副本**：有健康副本则保留并
 *     如实返回 sourceSync 状态；没有则抛 AuthError，绝不谎报成功。
 *  4. 普通解析（resolveCookieFile / 未授权调用）对**结构健康的独立工作副本永不覆盖**，
 *     即使来源 sha 已变化（可能只是商品分析侧收尾保存）：如实返回 source-diverged-kept
 *     / meta-missing-retained，并报告来源与副本的差异，绝不据 mtime/hash 推断发生过扫码。
 *     工作副本不存在或结构不可用时，才允许用已验证的有效来源首次导入。
 *  5. 只有 `authorizedFreshLogin=true`（app 已完成真实身份/复用校验 + 主文件 CAS 提交，
 *     并携带 `expectedSourceSha256` = 本次 commit.sha256）才按该冻结快照更新工作副本，
 *     实现「初始两份字节相同」；helper 内每一次来源读取都必须与该冻结 sha 一致，
 *     任何期间漂移即副本失败，不读到后来的快照还算本次登录。
 *  6. sidecar（<file>.json.meta，源 sha256 + 导入 sha256，不含 Cookie 值）只用于**如实
 *     报告**同步状态；它缺失或过期都不会让普通解析去覆盖健康副本（S97 的「meta 过期 →
 *     重导入覆盖已刷新副本」风险由第 4 条语义直接消除，不额外引入 pending journal）。
 *     sidecar 可在副本字节与来源一致时用同一原子写安全重建；写失败不谎报原子/成功：
 *     副本仍返回可用，但 sourceSync.sidecarFailed=true。
 *  7. 同店跨进程并发用工作根短期排他锁（<file>.json.lock，'wx' 独占创建 + finally
 *     释放自有锁）：忙时有界短重试后 fail-closed（保留已有健康副本或抛错），
 *     绝不静默清除 unknown 锁、不长时间忙等；不同店互不影响。锁只约束使用同一锁的
 *     调用者，**不代替**与 cookie-writeback / 登录写入器之间的 CAS：后者靠下面第 8 条
 *     的目的指纹比对-后-写保护。
 *  8. 冻结字节 + 全指纹 CAS：一次 readFileSync 的同一 Buffer 同时用于解析与 sha256；
 *     比较一律用完整指纹（sha256 + size + mtimeMs），不只 hash。目的状态在
 *     ①调用入口（含 absent / 非普通文件）②锁内写前 ③tmp fsync 之后、rename 之前
 *     三处复验，来源在①②③同样复验；任何漂移即放弃提交，保留并发新文件与原健康
 *     副本，绝不重新读取并无依据 rebase/合并。③到 rename 之间仍存在不可消除的极小
 *     窗口（单机同用户场景如实承认，不夸大为完全互斥）；旧实现把「整个 fsync 窗口
 *     都不检查」说成小窗口，是不实的，已修正。
 *  9. 源/工作目录 realpath 重合（含 junction/symlink 别名）→ 拒绝，不把路径别名当
 *     隔离成功；工作副本路径已是符号链接/非普通文件 → 拒绝写入。
 * 10. 复制写入来源原始字节，保留所有 Cookie 属性（含 partitionKey 等），不重新序列化。
 *
 * 离线测试可注入 fsMod/workDir；生产调用（session.resolveCookieFile）工作根来自
 * PROJECT_COOKIES_DIR（或 guard 配置 login.cookieWorkDir），不接受不可信调用者任意写
 * 路径。安全 basename 规则与 session.js 相同（拒绝 / \\ 与 ..）。不打印/不返回任何
 * Cookie 值（状态里只出现 sha256 前缀等元信息）。
 */

const fsDefault = require('fs');
const path = require('path');
const crypto = require('crypto');
const { AuthError } = require('../lib/errors');

const META_SUFFIX = '.meta';   // 不以 .json 结尾：不会被店铺发现（*.json 扫描）误扫
const LOCK_SUFFIX = '.lock';
const LOCK_TTL_MS = 15000;     // 超过该年龄的锁视为陈旧：仍不静默清除，只如实报告
const LOCK_RETRIES = 3;
const LOCK_RETRY_WAIT_MS = 20;

/** 与 session.js 相同的精确安全 basename 规则；非法即抛 AuthError。 */
function safeCookieBaseName(cookieFile) {
  if (!cookieFile || typeof cookieFile !== 'string' || cookieFile.startsWith('TODO')) {
    throw new AuthError('店铺 Cookie 文件名未配置（待配置项）');
  }
  const name = cookieFile.endsWith('.json') ? cookieFile : `${cookieFile}.json`;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    throw new AuthError(`Cookie 文件名非法: ${cookieFile}`);
  }
  return name;
}

function sha256Of(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function normDomain(d) {
  return String(d || '').trim().replace(/^\./, '').toLowerCase();
}

/**
 * 来源结构校验（不做模糊匹配，不判定平台登录有效性）。
 * @returns {{ok:true}|{ok:false, reason:string}}
 */
function validateCookieArray(parsed) {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return { ok: false, reason: '不是非空 Playwright Cookie 数组' };
  }
  for (const c of parsed) {
    if (!c || typeof c !== 'object') return { ok: false, reason: '含非对象条目' };
    for (const k of ['name', 'value', 'domain', 'path']) {
      if (typeof c[k] !== 'string' || (k !== 'value' && c[k].trim() === '')) {
        return { ok: false, reason: `条目缺少字符串字段 ${k}` };
      }
    }
  }
  if (!parsed.some((c) => c.value.length > 0)) {
    return { ok: false, reason: '所有条目 value 均为空（登录态可疑）' };
  }
  if (!parsed.some((c) => /(^|\.)jinritemai\.com$/.test(normDomain(c.domain)))) {
    return { ok: false, reason: '不含 jinritemai.com 业务域' };
  }
  return { ok: true };
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch (_) { /* 环境不支持则退化为不等待 */ }
}

/** 冻结读取：同一 Buffer 用于解析与哈希；附带 stat（size/mtime）。失败返回 {error}。 */
function captureFile(fsm, p) {
  try {
    const lst = fsm.lstatSync(p);
    if (!lst.isFile()) return { error: '不是普通文件（符号链接/目录拒绝）' };
    const buf = fsm.readFileSync(p);
    const st = fsm.statSync(p);
    return { buf, sha256: sha256Of(buf), size: st.size, mtimeMs: st.mtimeMs };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { error: 'missing' };
    return { error: (e && e.message) || String(e) };
  }
}

/**
 * 完整指纹相等（sha256 + size + mtimeMs）；不可读/不存在按 error 文本归类比较。
 * 只比 hash 会漏掉「同字节但被替换过」之外的状态漂移，故一律用完整指纹做 CAS。
 */
function sameFingerprint(a, b) {
  if (!a || !b) return false;
  if (a.error || b.error) return String(a.error || '') === String(b.error || '');
  return a.sha256 === b.sha256 && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** 只用于状态/日志的 sha 摘要前缀（绝不输出 Cookie 值）。 */
function shortSha(s) {
  return typeof s === 'string' && s.length >= 12 ? `${s.slice(0, 12)}…` : '（无）';
}

function readMeta(fsm, metaPath) {
  try {
    const m = JSON.parse(fsm.readFileSync(metaPath, 'utf8'));
    if (m && typeof m.sourceSha256 === 'string') return m;
    return null;
  } catch (_) { return null; }
}

/** provenance sidecar 字节（不含任何 Cookie 值）。 */
function metaBuffer(cap, nowFn) {
  return Buffer.from(JSON.stringify({
    version: 1,
    sourceSha256: cap.sha256,
    workSha256: cap.sha256,
    sourceSizeBytes: cap.size,
    sourceMtimeMs: cap.mtimeMs,
    importedAtMs: nowFn(),
  }, null, 2), 'utf8');
}

/** 工作副本是否「结构健康」（存在、普通文件、可解析、结构合格）。 */
function healthyCopy(fsm, workPath) {
  const cap = captureFile(fsm, workPath);
  if (cap.error) return { healthy: false, cap };
  let parsed = null;
  try { parsed = JSON.parse(cap.buf.toString('utf8')); } catch (_) { parsed = null; }
  const v = parsed === null ? { ok: false, reason: '工作副本解析失败' } : validateCookieArray(parsed);
  return { healthy: v.ok, cap, reason: v.ok ? null : v.reason };
}

/**
 * 工作根内原子写（tmp 'wx' + fsync + rename + 回读 sha 比对）。绝不触碰来源目录。
 *
 * @param {object} [opts.beforeRename] fsync 之后、rename 之前的新鲜复验回调：
 *   返回 {ok:true} 才提交；否则删除自有 tmp、保留目标现状，返回
 *   {ok:false, aborted:true, abortKind, reason}（S97 旧实现在 fsync 后直接 rename，
 *   把整个 fsync 窗口的并发更新覆盖掉了）。
 */
function atomicWriteInWorkDir(fsm, workDir, targetPath, buf, opts = {}) {
  const tmp = path.join(workDir, `.${path.basename(targetPath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  let fd;
  let owned = false;
  try {
    fd = fsm.openSync(tmp, 'wx');
    owned = true;
    fsm.writeSync(fd, buf);
    fsm.fsyncSync(fd);
    fsm.closeSync(fd);
    fd = undefined;
    if (typeof opts.beforeRename === 'function') {
      const chk = opts.beforeRename() || {};
      if (chk.ok !== true) {
        try { fsm.unlinkSync(tmp); } catch (_) { /* 只清自有临时文件 */ }
        owned = false;
        return {
          ok: false, aborted: true,
          abortKind: chk.kind || 'pre-rename-check',
          reason: chk.reason || 'rename 前复验未通过：放弃提交',
        };
      }
    }
    fsm.renameSync(tmp, targetPath);
  } catch (e) {
    if (fd !== undefined) { try { fsm.closeSync(fd); } catch (_) { /* ignore */ } }
    if (owned) { try { fsm.unlinkSync(tmp); } catch (_) { /* ignore */ } }
    return { ok: false, reason: (e && e.message) || String(e) };
  }
  try {
    const back = fsm.readFileSync(targetPath);
    if (sha256Of(back) !== sha256Of(buf)) {
      return { ok: false, reason: '写入后回读与预期字节不一致（并发更新），不报告成功' };
    }
  } catch (e) {
    return { ok: false, reason: `写入后无法回读: ${(e && e.message) || e}` };
  }
  return { ok: true };
}

/**
 * 确保工作根存在该店独立副本并返回其路径（同步、fail-closed）。
 *
 * @param {object} o
 * @param {string} o.sourceDir   只读上游目录（商品分析 cookies 目录）
 * @param {string} o.fileName    精确安全 basename（先经 safeCookieBaseName）
 * @param {string} [o.workDir]   工作根（生产为 PROJECT_COOKIES_DIR / login.cookieWorkDir）
 * @param {object} [o.fsMod]     注入 fs（离线测试）
 * @param {boolean} [o.authorizedFreshLogin] 仅 app 侧「本次已验证新登录」置 true：
 *                               允许按本次冻结快照替换已有健康副本；guard 自动解析
 *                               路径绝不置 true（普通来源变化不覆盖健康副本）
 * @param {string} [o.expectedSourceSha256] 本次已验证登录的 commit.sha256：helper 内
 *                               每一次来源读取都必须等于它，否则 fail-closed
 * @param {function} [o.nowFn]   可注入时钟（毫秒）
 * @returns {{path:string, dir:string, readOnly:false,
 *            sourceSync:{status:string, reason?:string, sourceSha256?:string, sidecarFailed?:boolean}}}
 * @throws {AuthError} 无可用副本且无法安全导入时
 */
function ensureWorkCopy(o) {
  const fsm = o.fsMod || fsDefault;
  const nowFn = typeof o.nowFn === 'function' ? o.nowFn : () => Date.now();
  const fileName = safeCookieBaseName(o.fileName);
  const sourceDir = o.sourceDir;
  const workDir = o.workDir;
  if (!sourceDir || typeof sourceDir !== 'string' || !workDir || typeof workDir !== 'string') {
    throw new AuthError('ensureWorkCopy 缺少来源目录或工作根（拒绝任意路径写入）');
  }
  const srcPath = path.join(sourceDir, fileName);
  const workPath = path.join(workDir, fileName);
  const metaPath = workPath + META_SUFFIX;
  const expectedSha = typeof o.expectedSourceSha256 === 'string' && o.expectedSourceSha256.trim()
    ? o.expectedSourceSha256.trim() : null;
  const authorized = o.authorizedFreshLogin === true;

  // ── 目录别名拒绝：realpath 重合（含 junction/symlink）不算隔离 ──
  if (!fsm.existsSync(workDir)) {
    try { fsm.mkdirSync(workDir, { recursive: true }); } catch (e) {
      throw new AuthError(`无法创建本项目 Cookie 工作目录: ${(e && e.message) || e}`);
    }
  }
  let srcReal; let workReal;
  try { srcReal = fsm.realpathSync(sourceDir); } catch (e) {
    throw new AuthError(`来源目录不可解析（拒绝把路径别名当隔离）: ${(e && e.message) || e}`);
  }
  try { workReal = fsm.realpathSync(workDir); } catch (e) {
    throw new AuthError(`工作目录不可解析: ${(e && e.message) || e}`);
  }
  if (srcReal === workReal) {
    throw new AuthError('来源目录与工作目录 realpath 重合（路径别名）：拒绝假装隔离成功');
  }

  const retained = (status, reason, sha) => ({
    path: workPath, dir: workDir, readOnly: false,
    sourceSync: { status, reason: reason || undefined, sourceSha256: sha || undefined },
  });

  // ── 冻结捕获：来源 + 目的初始状态（CAS 基线，整个调用期间沿用，不重新解释）──
  const src = captureFile(fsm, srcPath);
  const workInitial = healthyCopy(fsm, workPath);
  const destInitial = workInitial.cap;   // 含 absent（{error:'missing'}）与非普通文件

  // ── 本次已验证登录快照绑定：helper 第一次读取就必须等于 commit.sha256 ──
  if (expectedSha && (src.error || src.sha256 !== expectedSha)) {
    const reason = `来源与本次已验证登录快照不一致（期望 commit.sha256 ${shortSha(expectedSha)}，实测 ${src.error ? `不可读（${src.error}）` : shortSha(src.sha256)}）：拒绝把非本次登录的快照当作本次登录初始化/更新副本`;
    if (workInitial.healthy) return retained('source-snapshot-mismatch', `${reason}；保留现有工作副本，本轮零写入`, expectedSha);
    throw new AuthError(`${reason}（且无可用工作副本：fail-closed，不导入半新来源）`);
  }

  if (src.error) {
    const reason = src.error === 'missing' ? '来源文件缺失' : `来源文件不可用（${src.error}）`;
    if (workInitial.healthy) return retained('source-missing-retained', reason + '：保留已有健康工作副本，不破坏');
    throw new AuthError(`${reason}，且无可用的本项目工作副本（拒绝返回来源路径给写回链）`);
  }
  let parsedSrc = null;
  try { parsedSrc = JSON.parse(src.buf.toString('utf8')); } catch (_) { parsedSrc = null; }
  const srcValid = parsedSrc === null
    ? { ok: false, reason: '来源 JSON 解析失败' }
    : validateCookieArray(parsedSrc);
  if (!srcValid.ok) {
    const reason = `来源 Cookie 结构无效（${srcValid.reason}）`;
    if (workInitial.healthy) return retained('source-invalid-retained', reason + '：保留已有健康工作副本，不破坏');
    throw new AuthError(`${reason}，且无可用的本项目工作副本（结构合格才导入；登录有效性仍由业务身份门判定）`);
  }

  const meta = readMeta(fsm, metaPath);
  const metaMatches = !!(meta && meta.sourceSha256 === src.sha256);
  const copyEqualsSource = workInitial.healthy && workInitial.cap.sha256 === src.sha256;

  // ── 普通解析：结构健康的独立工作副本永不因来源变化被替换 ──
  if (workInitial.healthy && !authorized) {
    if (metaMatches) {
      // 来源与 provenance 一致：保留副本（可能已被本侧写回刷新）
      return retained(copyEqualsSource ? 'unchanged' : 'unchanged-refreshed-kept', null, src.sha256);
    }
    if (!meta && copyEqualsSource) {
      // 副本与来源逐字节一致：安全重建 sidecar（恢复边界之一；不触碰副本字节）
      const mw = atomicWriteInWorkDir(fsm, workDir, metaPath, metaBuffer(src, nowFn));
      return retained(mw.ok ? 'rematerialized' : 'meta-missing-retained',
        mw.ok ? undefined : `sidecar 重建失败（副本与来源一致，保留副本）: ${mw.reason}`, src.sha256);
    }
    if (!meta) {
      // legacy 冲突：sidecar 缺失，无法安全判断本地副本与来源谁新 → 诚实保留
      return retained('meta-missing-retained',
        '本地工作副本无 provenance sidecar 且与来源字节不同：无法安全判断新旧，保留本地副本（恢复边界：由下一次已验证新登录替换，或人工清理本地副本）',
        src.sha256);
    }
    // provenance 记录的来源 ≠ 当前来源：只是「上游文件被改写过」（商品分析普通读取的
    // 收尾保存同样会改上游），不构成新扫码证据 → 保留本侧独立副本，如实报告差异。
    return retained('source-diverged-kept',
      `来源内容已变化（来源 ${shortSha(src.sha256)} ≠ 已记录 ${shortSha(meta.sourceSha256)}），但本项目独立工作副本结构健康：普通解析不覆盖（副本可能已由本侧写回刷新）。仅 app「本次已验证新登录」（authorizedFreshLogin + commit.sha256）明确调用才更新副本`,
      src.sha256);
  }

  // ── 授权新登录且副本已等于本次冻结快照 → 幂等，无需写入 ──
  if (workInitial.healthy && authorized && metaMatches && copyEqualsSource) {
    return retained('unchanged', null, src.sha256);
  }

  // ── 导入路径（副本缺失/结构不可用的首次导入，或授权新登录替换）：短期排他锁 ──
  const lockPath = workPath + LOCK_SUFFIX;
  let lockFd = null;
  let lockAcquired = false;
  for (let i = 0; i < LOCK_RETRIES && !lockAcquired; i += 1) {
    try {
      lockFd = fsm.openSync(lockPath, 'wx');
      lockAcquired = true;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw new AuthError(`工作副本锁创建失败: ${(e && e.message) || e}`);
      if (i < LOCK_RETRIES - 1) sleepSync(LOCK_RETRY_WAIT_MS);
    }
  }
  if (!lockAcquired) {
    // 不静默清 unknown 锁；陈旧锁也如实报告（恢复边界：确认无进程同步后人工删除该 .lock）
    let ageNote = '';
    try {
      const lst = fsm.statSync(lockPath);
      const ageMs = nowFn() - lst.mtimeMs;
      ageNote = ageMs > LOCK_TTL_MS ? `（锁龄 ${Math.round(ageMs / 1000)}s 已超 ${LOCK_TTL_MS / 1000}s，疑似陈旧；不自动清除）` : '';
    } catch (_) { /* 锁状态不可读也不清除 */ }
    if (workInitial.healthy) return retained('busy-retained', `另一进程正在同步该店副本${ageNote}：保留现有副本，本轮不导入（不是本次同步成功）`);
    throw new AuthError(`另一进程正在同步该店 Cookie 副本${ageNote}：本轮 fail-closed，不导入、不清锁`);
  }
  try {
    if (lockFd !== null) {
      try { fsm.writeSync(lockFd, String(process.pid)); } catch (_) { /* 锁内容仅诊断用 */ }
      try { fsm.closeSync(lockFd); } catch (_) { /* ignore */ }
    }

    // ── 锁内来源复验：完整指纹必须仍等于本次冻结捕获（race fail-closed）──
    const src2 = captureFile(fsm, srcPath);
    if (src2.error || !sameFingerprint(src2, src)) {
      if (workInitial.healthy) return retained('source-race-retained', '导入前复验发现来源在竞态窗口内变化/不可读：保留现有副本，等待下一次解析');
      throw new AuthError('导入前复验发现来源在竞态窗口内变化/不可读：本轮 fail-closed（无可用副本，不导入半新来源）');
    }

    // ── 目的必须是普通文件（符号链接/目录/不可判定一律拒绝写入）──
    if (fsm.existsSync(workPath)) {
      try {
        const dl = fsm.lstatSync(workPath);
        if (!dl.isFile()) throw new AuthError('工作副本路径是符号链接/非普通文件（路径别名）：拒绝写入');
      } catch (e) {
        if (e instanceof AuthError) throw e;
        throw new AuthError(`工作副本状态不可判定: ${(e && e.message) || e}`);
      }
    }

    // ── 锁内目的 CAS 复验：必须仍等于调用入口的冻结目的状态（含 absent）──
    const destBaseline = captureFile(fsm, workPath);
    if (!sameFingerprint(destBaseline, destInitial)) {
      const drift = healthyCopy(fsm, workPath);
      if (drift.healthy) {
        // 并发写入者（写回链/另一次登录）已经更新了副本：保留并发新文件，绝不覆盖
        return retained('dest-drift-retained',
          '锁内复验发现工作副本在本次调用期间已被并发写入者更新：保留并发新文件，本轮不提交（与写回链之间的 CAS 失败，不 rebase、不合并）');
      }
      // 并发内容结构不可用（例如半写/被清空）：原本就没有健康副本可保护，按冻结来源导入，
      // 但 CAS 基线改为该并发状态，rename 前仍会再复验一次。
    }

    // ── 原子写：fsync 之后、rename 之前再做一次来源 + 目的新鲜复验 ──
    const w = atomicWriteInWorkDir(fsm, workDir, workPath, src2.buf, {
      beforeRename: () => {
        const s = captureFile(fsm, srcPath);
        if (s.error || !sameFingerprint(s, src2)) {
          return { ok: false, kind: 'source-drift', reason: 'tmp fsync 之后、rename 之前复验发现来源已变化：放弃提交' };
        }
        const d = captureFile(fsm, workPath);
        if (!sameFingerprint(d, destBaseline)) {
          return { ok: false, kind: 'dest-drift', reason: 'tmp fsync 之后、rename 之前复验发现工作副本已被并发写入者更新：放弃提交' };
        }
        return { ok: true };
      },
    });
    if (!w.ok) {
      // 提交未完成：绝不谎报成功；并发新文件与原健康副本都保持原样（tmp 已清理）
      const destNow = healthyCopy(fsm, workPath);
      if (w.aborted && w.abortKind === 'source-drift') {
        if (destNow.healthy) return retained('source-race-retained', `${w.reason}：保留现有工作副本，不写半新来源`);
        throw new AuthError(`${w.reason}：本轮 fail-closed（无可用副本，不导入半新来源）`);
      }
      if (w.aborted && w.abortKind === 'dest-drift') {
        if (destNow.healthy) return retained('dest-race-retained', `${w.reason}：保留并发新文件`);
        throw new AuthError(`${w.reason}；且目的当前内容结构不可用：fail-closed，不覆盖未知内容`);
      }
      if (destNow.healthy) return retained('import-failed-retained', `工作副本写入失败（${w.reason}）：保留现有副本，未破坏`);
      throw new AuthError(`工作副本写入失败: ${w.reason}`);
    }

    // ── rename 之后（sidecar 提交前）如实复验：副本字节已提交，只在报告上不宣称同步完成 ──
    const srcAfter = captureFile(fsm, srcPath);
    const destAfter = captureFile(fsm, workPath);
    if (!srcAfter.error && !sameFingerprint(srcAfter, src2)) {
      return retained('source-race-after-write', '副本已按冻结来源字节写入，但提交 sidecar 前来源又变化：不记录同步状态（下一次已验证新登录才会再更新副本）', src2.sha256);
    }
    if (!destAfter.error && destAfter.sha256 !== src2.sha256) {
      return retained('dest-race-after-write', '副本写入后被并发进程再次更新：保留并发新文件，不记录同步状态');
    }

    // ── sidecar 提交（不含 Cookie 值）；失败不谎报原子/成功 ──
    const mw = atomicWriteInWorkDir(fsm, workDir, metaPath, metaBuffer(src2, nowFn));
    const status = !workInitial.healthy ? 'imported'
      : (!meta ? 'replaced-legacy' : (metaMatches ? 'recommitted-fresh-login' : 'refreshed-from-source'));
    if (!mw.ok) {
      return {
        path: workPath, dir: workDir, readOnly: false,
        sourceSync: {
          status: 'imported-sidecar-failed', sidecarFailed: true, sourceSha256: src2.sha256,
          reason: `副本已写入但 provenance sidecar 提交失败（${mw.reason}）：不宣称原子/成功；sidecar 过期不会让普通解析覆盖本副本（普通解析对健康副本零覆盖），可由下一次已验证新登录或字节一致时的重建恢复`,
        },
      };
    }
    return {
      path: workPath, dir: workDir, readOnly: false,
      sourceSync: { status, sourceSha256: src2.sha256 },
    };
  } finally {
    // 只释放自有锁
    try { fsm.unlinkSync(lockPath); } catch (_) { /* ignore */ }
  }
}

module.exports = {
  safeCookieBaseName,
  validateCookieArray,
  sha256Of,
  captureFile,
  sameFingerprint,
  healthyCopy,
  atomicWriteInWorkDir,
  ensureWorkCopy,
  META_SUFFIX,
  LOCK_SUFFIX,
};
