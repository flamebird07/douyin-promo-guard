'use strict';

/**
 * cookie-vault.js — 四层 Cookie 分层保管库（AD-COOKIE-FOUR-TIER-20261019-F1）。
 *
 * 四层角色（同一店）：
 *  1. 原始快照（raw archive）  <appRoot>/cookie-archive/raw/<safeName>/<versionId>.json
 *     —— 每次已验证扫码另存新版本（exclusive create + 版本ID + sha + manifest），
 *        永不覆盖/删除旧版本；程序层只读（chmod 0444 + 写入器拒绝触及），不宣称对抗
 *        真实 OS 管理员的绝对防篡改。
 *  2. 商品分析工作副本        <appRoot>/cookies/<safeName>.json（既有目录，既有角色）
 *     —— 分析器检查点写回（身份绑定 + 指纹 CAS）。
 *  3. 推广恢复副本（只读角色）  <guardRoot>/cookie-recovery/<safeName>/<versionId>.json
 *     —— 仅由本次已验证登录（verifiedSha256 冻结核验）以 exclusive create 新版本写入；
 *        创建后永不再写入/覆盖/追加（与原始归档同一版本化机制）。历史固定路径
 *        cookie-recovery/<safeName>.json 只作为只读来源兼容读取，绝不就地重写。
 *  4. 推广值守工作副本        <guardRoot>/cookies/<safeName>.json（既有目录，既有角色）
 *     —— 由 guard ensureWorkCopy(authorizedFreshLogin) / 写回链更新。
 *
 * 隔离硬规则（落实为代码路径）：
 *  - 工作副本不可反向覆盖原始：所有角色写入目标先经 assertNotArchivePath /
 *    isInsideDir 拒绝归档内路径；promote 前做 dev+ino 硬链接别名核查（防写穿归档）。
 *  - 不可跨业务互写：恢复目录不得与 analyzer/guard 工作目录、归档 realpath 重合。
 *  - raw archive 与 guard recovery 目录都不在任何 *.json 店铺扫描目录内
 *    （app 扫描 app/cookies；guard 扫描 guard/cookies 与来源目录）。
 *  - 来源完整性：归档版本读取必须 lstat 普通文件（符号链接/目录拒绝）且 sha256 与
 *    manifest 记录一致；路径别名（realpath）不当作隔离成功。
 *  - 并发：CAS 基线（absent/精确 sha）+ tmp 'wx' + fsync + rename 前复验 + 回读比对；
 *    并发较新登录胜出（保留并发文件，不回滚、不 rebase）。核对与 rename 之间仍有
 *    极小窗口，本模块不宣称消除最后系统调用之间的所有竞态。
 *  - 旧 app/cookies 迁移只可存 legacy-unverified 归档：结构健康 ≠ 登录有效，
 *    不向其他角色传播、不删除旧文件。
 *
 * 审计：只记录店铺安全段、角色、时间、sha 前缀、验证结果/拒绝原因；
 * 绝不记录任何 Cookie 值、完整 URL、token。
 *
 * 本模块为纯模块：无顶层副作用、不启动浏览器、不 require guard/app 业务入口。
 * fs 可注入（仅离线测试）；路径一律由参数/roots 或 __dirname 解析，不硬编码生产机器路径。
 */

const fsDefault = require('fs');
const path = require('path');
const crypto = require('crypto');

const ARCHIVE_DIRNAME = 'cookie-archive';
const RAW_DIRNAME = 'raw';
const RECOVERY_DIRNAME = 'cookie-recovery';
const MANIFEST_NAME = 'manifest.json';
const MANIFEST_VERSION = 1;
/** 单店归档版本参与硬链接核查/列表的合理上界（防御异常目录，不构成业务上限）。 */
const MAX_VERSIONS_SCAN = 50;

function sha256Of(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function shortSha(s) {
  return typeof s === 'string' && s.length >= 12 ? `${s.slice(0, 12)}…` : '（无）';
}

/**
 * 默认角色路径（appRoot 默认本模块所在 bill-manager 目录；guardRoot 默认同级
 * douyin-promo-guard，可用 PROMO_GUARD_DIR 环境变量或参数覆盖——测试注入同一路径）。
 */
function defaultRoots(opts = {}) {
  const appRoot = opts.appRoot || __dirname;
  const guardRoot = opts.guardRoot
    || (typeof process.env.PROMO_GUARD_DIR === 'string' && process.env.PROMO_GUARD_DIR.trim())
    || path.resolve(__dirname, '..', 'douyin-promo-guard');
  return {
    appRoot,
    guardRoot,
    archiveRoot: opts.archiveRoot || path.join(appRoot, ARCHIVE_DIRNAME, RAW_DIRNAME),
    recoveryDir: opts.recoveryDir || path.join(guardRoot, RECOVERY_DIRNAME),
    analyzerWorkDir: opts.analyzerWorkDir || path.join(appRoot, 'cookies'),
    guardWorkDir: opts.guardWorkDir || path.join(guardRoot, 'cookies'),
  };
}

/** 店铺安全段（目录/文件名主段）：拒绝空、路径分隔符与 ..；不做二次改写（改写=身份转换，必须上游拒绝）。 */
function safeShopSegment(safeName) {
  const s = String(safeName == null ? '' : safeName).trim();
  if (!s || s === '.' || s === '..' || /[/\\]/.test(s)) {
    throw new Error(`店铺安全段非法: ${JSON.stringify(String(safeName))}`);
  }
  return s;
}

function targetState(fsm, p) {
  let lst = null;
  try { lst = fsm.lstatSync(p); } catch (e) {
    if (e && e.code === 'ENOENT') return { exists: false };
    return { exists: false, error: `目标状态不可判定（${(e && e.message) || e}）` };
  }
  if (!lst.isFile()) {
    return { exists: true, isFile: false, error: '目标路径是符号链接/目录/非普通文件：拒绝写入（路径别名不当隔离）' };
  }
  let buf;
  try { buf = fsm.readFileSync(p); } catch (e) {
    return { exists: true, isFile: true, error: `目标文件读取失败（${(e && e.message) || e}）` };
  }
  return { exists: true, isFile: true, sha256: sha256Of(buf), size: lst.size, dev: lst.dev, ino: lst.ino };
}

/** realpath 重合（含 junction/symlink 别名）判定；任一侧不可解析时退化为字面比较。 */
function sameRealDir(fsm, a, b) {
  let ra; let rb;
  try { ra = fsm.realpathSync(a); } catch (_) { ra = path.resolve(String(a)); }
  try { rb = fsm.realpathSync(b); } catch (_) { rb = path.resolve(String(b)); }
  return ra === rb;
}

/** targetPath 是否位于 rootDir 内（realpath；target 自身可不存在——用现存父链解析）。 */
function isInsideDir(fsm, rootDir, targetPath) {
  if (!rootDir || !targetPath) return false;
  let r;
  try { r = fsm.realpathSync(rootDir); } catch (_) { return false; }
  let t = path.resolve(String(targetPath));
  try { t = fsm.realpathSync(t); } catch (_) {
    const parent = path.dirname(t);
    let pr;
    try { pr = fsm.realpathSync(parent); } catch (_) { return false; }
    t = path.join(pr, path.basename(t));
  }
  const rel = path.relative(r, t);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 程序层归档保护：目标在归档内 → 抛错。所有工作写入器（检查点/写回/提升）
 * 写目标前必须调用；真实 OS 管理员仍可改文件，不宣称绝对防篡改。
 */
function assertNotArchivePath(targetPath, opts = {}) {
  const fsm = opts.fsModule || fsDefault;
  const roots = opts.roots || defaultRoots(opts);
  if (isInsideDir(fsm, roots.archiveRoot, targetPath)) {
    throw new Error('目标路径位于原始快照归档内：工作写入器禁止触及归档（AD-COOKIE-FOUR-TIER）');
  }
  return true;
}

/**
 * 硬链接别名核查：目标与该店任一归档版本 dev+ino 相同 → 视为写穿归档风险。
 * best-effort：枚举/stat 失败不阻断（如实记录在文档的边界说明中）。
 */
function hardlinkAliasToArchive(fsm, targetPath, archiveRoot, shopSafeName, st) {
  if (!st || !st.exists || st.error || st.ino === undefined) return false;
  if (!archiveRoot || !shopSafeName) return false;
  const shopDir = path.join(archiveRoot, shopSafeName);
  let names = [];
  try { names = fsm.readdirSync(shopDir).filter((f) => f.endsWith('.json') && f !== MANIFEST_NAME); } catch (_) { return false; }
  const limited = names.slice(0, MAX_VERSIONS_SCAN);
  for (const f of limited) {
    try {
      const vst = fsm.statSync(path.join(shopDir, f));
      if (vst.dev === st.dev && vst.ino === st.ino) return true;
    } catch (_) { /* 单个版本 stat 失败跳过 */ }
  }
  return false;
}

/**
 * 精确字节原子写：tmp 'wx' 独占创建 → fsync → （beforeRename 复验）→ rename → 回读比对。
 * 目标父目录必须已存在（调用方负责）。绝不写半文件；失败清理自有临时文件。
 */
function atomicWriteExact(fsm, targetPath, buf, opts = {}) {
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
        return {
          ok: false, aborted: true, conflict: chk.kind === 'target-drift',
          reason: chk.reason || 'rename 前复验未通过：放弃提交',
        };
      }
    }
    fsm.renameSync(tmp, targetPath);
  } catch (e) {
    if (fd !== null) { try { fsm.closeSync(fd); } catch (_) { /* ignore */ } }
    if (owned) { try { fsm.unlinkSync(tmp); } catch (_) { /* 只清自有临时文件 */ } }
    return { ok: false, reason: (e && e.message) || String(e) };
  }
  try {
    const back = fsm.readFileSync(targetPath);
    if (sha256Of(back) !== sha256Of(buf)) {
      return { ok: false, conflict: true, reason: '写入后回读与预期字节不一致（并发更新）：不报告成功' };
    }
  } catch (e) {
    return { ok: false, reason: `写入后无法回读: ${(e && e.message) || e}` };
  }
  return { ok: true, sha256: sha256Of(buf), bytes: buf.length };
}

function emitAudit(audit, entry) {
  if (typeof audit !== 'function') return;
  try { audit(entry); } catch (_) { /* 审计失败不影响主流程 */ }
}

/** Cookie 数组结构校验（结构 ≠ 平台登录有效；与 guard validateCookieArray 同口径）。 */
function validateCookieStructure(parsed) {
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
  if (!parsed.some((c) => /(^|\.)jinritemai\.com$/.test(String(c.domain || '').replace(/^\./, '').toLowerCase()))) {
    return { ok: false, reason: '不含 jinritemai.com 业务域' };
  }
  return { ok: true };
}

function tsTag(nowFn) {
  const d = new Date(nowFn());
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

/**
 * 归档版本写入（内部共享）：exclusive create + fsync + chmod 0444 + manifest 原子入册。
 * chmod 0444 失败 → 如实失败（ok:false，versionWritten:true，文件保留不入册）——只读
 * 角色的只读属性是验收项，不是附带信息。manifest 缺失/损坏/别名 → 同样如实失败并报告
 * versionWritten:true（版本文件已落盘只读、状态未入册），
 * 绝不覆盖未知 manifest、绝不覆盖既有版本文件。
 */
function writeVersionFile(p) {
  const fsm = p.fsModule || fsDefault;
  const nowFn = p.nowFn || (() => Date.now());
  const roots = p.roots || defaultRoots({});
  const shopSeg = safeShopSegment(p.shopSafeName);
  const buf = p.buf;
  // rootDir 覆写仅用于复用同一版本化机制写其它只读角色（如推广恢复副本）；
  // 默认仍是原始归档根。
  const shopDir = path.join(p.rootDir || roots.archiveRoot, shopSeg);
  try { fsm.mkdirSync(shopDir, { recursive: true }); } catch (e) {
    return { ok: false, reason: `无法创建归档目录: ${(e && e.message) || e}` };
  }
  let versionId = null;
  let versionPath = null;
  let fd = null;
  for (let i = 0; i < 3 && fd === null; i += 1) {
    versionId = `v${tsTag(nowFn)}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
    versionPath = path.join(shopDir, `${versionId}.json`);
    try { fd = fsm.openSync(versionPath, 'wx'); } catch (e) {
      if (e && e.code === 'EEXIST') { fd = null; continue; }
      return { ok: false, reason: `归档版本文件独占创建失败: ${(e && e.message) || e}` };
    }
  }
  if (fd === null) {
    return { ok: false, reason: '归档版本ID连续冲突（3次独占创建均 EEXIST）：放弃本次快照，不覆盖既有版本' };
  }
  try {
    fsm.writeSync(fd, buf);
    fsm.fsyncSync(fd);
  } finally {
    try { fsm.closeSync(fd); } catch (_) { /* ignore */ }
  }
  const sha = sha256Of(buf);
  // ── 精确回读核验：归档版本落盘字节必须与本次已验证字节逐字节一致 ──
  // 只有回读 sha 一致才允许入册并向上游报告成功；否则如实失败（版本文件已独占创建，
  // 但不更新 manifest、不宣称归档成功）。
  let readBack = null;
  try { readBack = fsm.readFileSync(versionPath); } catch (e) {
    return { ok: false, versionWritten: true, versionId, versionPath, sha256: sha, reason: `归档版本写入后无法回读（${(e && e.message) || e}）：不宣称归档成功，未入册` };
  }
  if (sha256Of(readBack) !== sha) {
    return { ok: false, versionWritten: true, versionId, versionPath, sha256: sha, reason: '归档版本写入后回读与本次已验证字节不一致：不宣称归档成功，未入册（旧版本不受影响）' };
  }
  // COOKIE-FOUR-REPAIR-20261024（F2）：两只只读角色必须真正只读。chmod 0444 失败
  // 时不得只把 readOnlyAttrOk=false 放在旁边仍报告角色成功——如实失败（partial/失败
  // 由上游分发汇总），保留已创建的版本文件（不覆盖、不删除），且不入册为完整成功。
  let readOnlyAttrNote = null;
  try { fsm.chmodSync(versionPath, 0o444); } catch (e) {
    readOnlyAttrNote = (e && e.message) || String(e);
    return { ok: false, versionWritten: true, versionId, versionPath, sha256: sha,
      reason: `只读属性（0444）设置失败（${readOnlyAttrNote}）：版本文件已保留（不覆盖/不删除），不入册为完整成功` };
  }
  const readOnlyAttrOk = true;
  const manifestPath = path.join(shopDir, MANIFEST_NAME);
  let mst = null;
  try { mst = fsm.lstatSync(manifestPath); } catch (_) { mst = null; }
  if (mst && !mst.isFile()) {
    return { ok: false, versionWritten: true, versionId, versionPath, sha256: sha, reason: '归档 manifest 路径是符号链接/非普通文件：拒绝更新（版本文件已写入并只读，状态未入册）' };
  }
  let manifest = null;
  if (mst) {
    try { manifest = JSON.parse(fsm.readFileSync(manifestPath, 'utf8')); } catch (_) { manifest = null; }
    if (!manifest || manifest.version !== MANIFEST_VERSION || !Array.isArray(manifest.versions)) {
      return { ok: false, versionWritten: true, versionId, versionPath, sha256: sha, reason: '归档 manifest 损坏或未知格式：拒绝覆盖（版本文件已写入并只读，状态未入册；需人工核查）' };
    }
  } else {
    manifest = { version: MANIFEST_VERSION, shop: shopSeg, versions: [] };
  }
  manifest.versions.push({
    versionId,
    sha256: sha,
    bytes: buf.length,
    createdAtMs: nowFn(),
    origin: p.origin,
    structureValid: p.structureValid !== false,
  });
  const mw = atomicWriteExact(fsm, manifestPath, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  if (!mw.ok) {
    return { ok: false, versionWritten: true, versionId, versionPath, sha256: sha, reason: `归档 manifest 提交失败（${mw.reason}）：版本文件已写入并只读，状态未入册` };
  }
  emitAudit(p.audit, {
    kind: p.auditKind || 'raw-snapshot', shop: shopSeg, role: p.auditRole || 'raw-archive',
    time: new Date(nowFn()).toISOString(), versionId,
    sha256Prefix: sha.slice(0, 12), origin: p.origin, ok: true,
  });
  return {
    ok: true, versionId, versionPath, sha256: sha, bytes: buf.length,
    structureValid: p.structureValid !== false,
    manifestOk: true, readOnlyAttrOk, readOnlyAttrNote,
  };
}

/**
 * 创建本次已验证登录的原始快照（新版本，exclusive create，绝不覆盖旧版本）。
 * @param {object} p
 * @param {string} p.shopSafeName  店铺安全段（login-shop resolveCookieTarget 产物）
 * @param {Array}  p.cookies       本次已验证（复用校验通过）的 Cookie 数组
 * @param {object} [p.roots]      defaultRoots 产物（测试注入临时目录）
 * @param {object} [p.fsModule]   注入 fs（离线测试）
 * @param {function} [p.nowFn]    可注入时钟
 * @param {function} [p.audit]    脱敏审计回调
 */
function createRawSnapshot(p) {
  // 精确字节优先：登录入口必须把「通过 verifySessionReuse 的同一份已验证字节」原样入档，
  // 不允许归档侧重新序列化（重新序列化会产生另一份字节，破坏同源与 sha 冻结）。
  let buf = null;
  let parsed = p.cookies;
  if (Buffer.isBuffer(p.buf)) {
    buf = p.buf;
    if (!parsed) {
      try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { parsed = null; }
    }
  }
  const v = validateCookieStructure(parsed);
  if (!v.ok) {
    return { ok: false, reason: `原始快照结构校验失败（${v.reason}）：拒绝入档（已验证登录不该出现该状态，请如实上报）` };
  }
  if (!buf) buf = Buffer.from(JSON.stringify(p.cookies, null, 2), 'utf8');
  const sha = sha256Of(buf);
  if (typeof p.expectedSha256 === 'string' && p.expectedSha256.trim() && sha !== p.expectedSha256.trim()) {
    return { ok: false, reason: '待归档字节与本次已验证冻结 sha256 不一致：拒绝入档（不写入未验证内容）' };
  }
  return writeVersionFile({
    fsModule: p.fsModule,
    roots: p.roots || defaultRoots(p),
    shopSafeName: p.shopSafeName,
    buf,
    origin: 'verified-login',
    structureValid: true,
    nowFn: p.nowFn,
    audit: p.audit,
  });
}

/**
 * 旧 app/cookies 工作副本迁移：只存 legacy-unverified 归档。
 * 结构健康 ≠ 登录有效；不向其他角色传播、不删除旧文件、不改判其有效性。
 */
function archiveLegacyBytes(p) {
  const buf = Buffer.isBuffer(p.buf) ? p.buf : Buffer.from(String(p.buf), 'utf8');
  let parsed = null;
  try { parsed = JSON.parse(buf.toString('utf8')); } catch (_) { parsed = null; }
  const v = parsed === null ? { ok: false, reason: 'JSON 解析失败' } : validateCookieStructure(parsed);
  return writeVersionFile({
    fsModule: p.fsModule,
    roots: p.roots || defaultRoots(p),
    shopSafeName: p.shopSafeName,
    buf,
    origin: 'legacy-unverified',
    structureValid: v.ok,
    nowFn: p.nowFn,
    audit: p.audit,
  });
}

/**
 * 列出某店归档版本（新→旧）。manifest 可用时时入册版本为准；
 * manifest 缺失/损坏时回退目录列举（sha256 为 null，读取时必须另行核验）。
 */
function listSnapshotVersions(p) {
  const fsm = p.fsModule || fsDefault;
  const roots = p.roots || defaultRoots(p);
  const shopSeg = safeShopSegment(p.shopSafeName);
  const shopDir = path.join(p.rootDir || roots.archiveRoot, shopSeg);
  const manifestPath = path.join(shopDir, MANIFEST_NAME);
  let mst = null;
  try { mst = fsm.lstatSync(manifestPath); } catch (_) { mst = null; }
  const out = [];
  if (mst && mst.isFile()) {
    let manifest = null;
    try { manifest = JSON.parse(fsm.readFileSync(manifestPath, 'utf8')); } catch (_) { manifest = null; }
    if (manifest && manifest.version === MANIFEST_VERSION && Array.isArray(manifest.versions)) {
      // 先**全量**按 createdAtMs/versionId 倒序，**再**有界截断：入册顺序是追加顺序，
      // 若先截断，版本数超过 MAX_VERSIONS_SCAN 时窗口里只剩最旧的一批，最新已验证
      // 快照永远读不到（也让上层的"与最新一条比对去重"比的是最旧版本）。
      // versionId 形如 v<UTC 时间戳>-<pid>-<随机>，字典序即时间序，可作同刻次级键。
      const ranked = manifest.versions
        .filter((v) => v && typeof v.versionId === 'string' && v.versionId.length > 0)
        .slice()
        .sort((a, b) => (Number(b.createdAtMs) || 0) - (Number(a.createdAtMs) || 0)
          || String(b.versionId).localeCompare(String(a.versionId)));
      for (const v of ranked.slice(0, MAX_VERSIONS_SCAN)) {
        const versionPath = path.join(shopDir, `${v.versionId}.json`);
        let st = null;
        try { st = fsm.lstatSync(versionPath); } catch (_) { st = null; }
        if (st && st.isFile()) {
          out.push({
            versionId: v.versionId, versionPath, sha256: v.sha256 || null,
            createdAtMs: v.createdAtMs || 0, origin: v.origin || 'unknown',
            structureValid: v.structureValid !== false,
          });
        }
      }
      out.sort((a, b) => b.createdAtMs - a.createdAtMs || String(b.versionId).localeCompare(String(a.versionId)));
      return { ok: true, versions: out, manifestMissing: false };
    }
  }
  let names = [];
  try {
    names = fsm.readdirSync(shopDir).filter((f) => /^v.+\.json$/.test(f) && f !== MANIFEST_NAME);
  } catch (_) { names = []; }
  // 回退分支同理：目录列举顺序不代表新旧，必须先按 versionId（字典序＝时间序）
  // 全量倒序再截断，否则 >上限的归档目录里只能看到最旧的一批。
  names.sort((a, b) => String(b).localeCompare(String(a)));
  for (const f of names.slice(0, MAX_VERSIONS_SCAN)) {
    const versionPath = path.join(shopDir, f);
    let st = null;
    try { st = fsm.lstatSync(versionPath); } catch (_) { st = null; }
    if (st && st.isFile()) {
      out.push({ versionId: f.slice(0, -5), versionPath, sha256: null, createdAtMs: st.mtimeMs, origin: 'unlisted', structureValid: true });
    }
  }
  out.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return { ok: true, versions: out, manifestMissing: !mst };
}

/**
 * 读取单个归档版本（来源完整性核验）：必须普通文件（符号链接/目录拒绝），
 * 必须携带 manifest 记录的 expectedSha256 并逐字节核验，不一致即拒绝
 *（不凭 mtime 新就健康；manifest 缺失/未入册版本不得绕过 hash 验证）。
 */
function readSnapshotVersion(p) {
  const fsm = p.fsModule || fsDefault;
  const expected = typeof p.expectedSha256 === 'string' ? p.expectedSha256.trim() : '';
  if (!expected) {
    return { ok: false, reason: '缺少 manifest 记录的 sha256（manifest 缺失/未入册版本）：拒绝无核验读取，不得绕过来源完整性验证' };
  }
  let lst = null;
  try { lst = fsm.lstatSync(p.versionPath); } catch (e) {
    if (e && e.code === 'ENOENT') return { ok: false, reason: '归档版本文件缺失' };
    return { ok: false, reason: `归档版本不可读（${(e && e.message) || e}）` };
  }
  if (!lst.isFile()) return { ok: false, reason: '归档版本不是普通文件（符号链接/目录拒绝）' };
  let buf;
  try { buf = fsm.readFileSync(p.versionPath); } catch (e) {
    return { ok: false, reason: `归档版本读取失败（${(e && e.message) || e}）` };
  }
  const sha = sha256Of(buf);
  if (sha !== expected) {
    return { ok: false, reason: `归档版本 sha256 与 manifest 记录不一致（实测 ${shortSha(sha)}）：拒绝使用（来源完整性失败）` };
  }
  return { ok: true, buf, sha256: sha };
}

/**
 * 用本次已验证登录快照写入推广恢复副本（第 3 层，只读角色）。
 * COOKIE-FOUR-REPAIR-20261024：恢复副本与原始归档同为只读角色——每次已验证登录
 * 以 exclusive create 创建**新的独立不可变版本文件**（复用 writeVersionFile 版本化
 * 机制：独占创建 + fsync + chmod 0444 + manifest 原子入册），创建完成后本模块任何
 * 路径都永不再写入/覆盖/追加/替换既有版本。历史固定路径
 * <recoveryDir>/<safeName>.json 只作为只读来源兼容读取，绝不就地重写或"迁移"其字节。
 * 只接受 verifiedSha256 冻结核验通过的字节；恢复目录与工作/归档目录 realpath 重合 → 拒绝。
 * frozenBaseline 参数仅为旧调用方兼容保留：只读角色不存在覆盖窗口，不再参与判定。
 */
function updateGuardRecoveryFromVerified(p) {
  const fsm = p.fsModule || fsDefault;
  const nowFn = p.nowFn || (() => Date.now());
  const fail = (reason, extra = {}) => ({ ok: false, retryable: true, reason, ...extra });
  if (typeof p.verifiedSha256 !== 'string' || !p.verifiedSha256.trim()) {
    return fail('缺少本次已验证登录的冻结 sha256：恢复副本只接受已验证快照写入（拒绝未验证写入）');
  }
  const v = validateCookieStructure(p.cookies);
  if (!v.ok) return fail(`候选 Cookie 结构无效（${v.reason}）：拒绝写入恢复副本`);
  const payload = Buffer.from(JSON.stringify(p.cookies, null, 2), 'utf8');
  const sha = sha256Of(payload);
  if (sha !== p.verifiedSha256.trim()) {
    return fail('待写恢复副本字节与本次已验证冻结快照不一致：拒绝（不写入未验证内容）');
  }
  const roots = p.roots || defaultRoots(p);
  const recoveryDir = p.recoveryDir || roots.recoveryDir;
  const shopSeg = safeShopSegment(p.shopSafeName);
  for (const other of [roots.analyzerWorkDir, roots.guardWorkDir, roots.archiveRoot]) {
    if (other && sameRealDir(fsm, recoveryDir, other)) {
      return fail('恢复目录与工作/归档目录 realpath 重合（路径别名）：拒绝写入（不把恢复副本当工作/归档，不跨业务互写）');
    }
  }
  let lst = null;
  try { lst = fsm.lstatSync(recoveryDir); } catch (_) { lst = null; }
  if (!lst) {
    try { fsm.mkdirSync(recoveryDir, { recursive: true }); } catch (e) {
      return fail(`无法创建恢复目录: ${(e && e.message) || e}`);
    }
  } else if (!lst.isDirectory()) {
    return fail('恢复目录路径不是目录：拒绝写入');
  }
  // 版本目录（<recoveryDir>/<shopSeg>/）不得落在原始归档内。
  const versionRoot = path.join(recoveryDir, shopSeg);
  if (isInsideDir(fsm, roots.archiveRoot, versionRoot)) {
    return fail('恢复副本版本目录位于原始归档内：拒绝（归档只由 createRawSnapshot 写入）');
  }
  const wr = writeVersionFile({
    fsModule: fsm,
    roots,
    rootDir: recoveryDir,
    shopSafeName: shopSeg,
    buf: payload,
    origin: 'verified-login',
    structureValid: true,
    nowFn,
    audit: p.audit,
    auditKind: 'recovery-snapshot',
    auditRole: 'guard-recovery',
  });
  if (!wr.ok) return fail(wr.reason, { versionWritten: !!wr.versionWritten });
  return {
    ok: true, versionId: wr.versionId, path: wr.versionPath,
    sha256: sha, bytes: payload.length,
    manifestOk: wr.manifestOk, readOnlyAttrOk: wr.readOnlyAttrOk,
    metaOk: true, metaFailed: null,
  };
}

/**
 * 列出某店恢复副本版本（新→旧）；与 listSnapshotVersions 同口径，根为恢复目录。
 */
function listRecoveryVersions(p) {
  return listSnapshotVersions({ ...p, rootDir: (p.roots || defaultRoots(p)).recoveryDir });
}

/**
 * 把已独立验证的候选字节提升到工作副本（CAS + 保留上一版）。
 * 由调用方先完成候选验证（身份/可复用性）；本函数只负责安全落盘：
 *  - 目标必须不存在或为普通文件（符号链接/目录拒绝）；
 *  - 与该店归档 dev+ino 相同（硬链接别名）→ 拒绝（防写穿归档）；
 *  - frozenBaseline（推荐必传）：验证开始**前**冻结的目标指纹
 *    { exists, sha256|null }；当前状态与冻结基线不符 = 验证期间出现并发写入
 *    （如新扫码登录）→ 拒绝提升、保留并发新文件（较新登录胜出，不覆盖）；
 *  - 写前保留上一版到 <target>.prev-<ts>-<rand>（fail-closed：备份失败即放弃）；
 *  - CAS：基线（absent/精确 sha）+ rename 前复验 + 回读比对；并发写入者胜出。
 * 不写任何归档或来源；不校验候选业务身份（那是验证器职责）。
 */
function promoteCandidateToWorkFile(p) {
  const fsm = p.fsModule || fsDefault;
  const nowFn = p.nowFn || (() => Date.now());
  const targetPath = p.targetPath;
  const candBuf = p.candidateBuf;
  if (!Buffer.isBuffer(candBuf)) return { ok: false, reason: '候选内容缺失（必须为 Buffer）：拒绝提升' };
  const candSha = p.candidateSha256 || sha256Of(candBuf);
  const roots = p.roots || defaultRoots(p);
  const st = targetState(fsm, targetPath);
  if (st.error) return { ok: false, reason: st.error };
  if (hardlinkAliasToArchive(fsm, targetPath, roots.archiveRoot, p.shopSafeName, st)) {
    return { ok: false, reason: '目标文件与原始快照归档为同一存储对象（dev+ino 相同，疑似硬链接）：拒绝写入，防止写穿归档' };
  }
  let baseline;
  if (p.frozenBaseline) {
    const fb = p.frozenBaseline;
    const drifted = fb.exists !== st.exists
      || (fb.exists && st.exists && (fb.sha256 || null) !== (st.sha256 || null));
    if (drifted) {
      return { ok: false, conflict: true, reason: '目标工作副本在候选验证期间被并发更新（如新扫码登录写入）：拒绝提升，保留并发新文件（较新登录胜出，不覆盖）' };
    }
    baseline = fb.exists ? { exists: true, sha256: fb.sha256 } : { exists: false };
  } else {
    baseline = st.exists ? { exists: true, sha256: st.sha256 } : { exists: false };
  }
  let backupPath = null;
  if (st.exists) {
    const prevBuf = fsm.readFileSync(targetPath);
    backupPath = `${targetPath}.prev-${tsTag(nowFn)}-${crypto.randomBytes(3).toString('hex')}`;
    const bw = atomicWriteExact(fsm, backupPath, prevBuf);
    if (!bw.ok) return { ok: false, reason: `写工作副本前保留上一版失败：${bw.reason}` };
  }
  const beforeRename = () => {
    const cur = targetState(fsm, targetPath);
    if (cur.error) return { ok: false, kind: 'target-drift', reason: `rename 前复验：目标状态不可判定（${cur.error}）` };
    if (cur.exists !== baseline.exists || (cur.exists && baseline.exists && cur.sha256 !== baseline.sha256)) {
      return { ok: false, kind: 'target-drift', reason: 'rename 前复验：工作副本已被并发写入者更新：放弃本次提升，保留并发新文件（不 rebase、不合并）' };
    }
    if (typeof p.beforeRename === 'function') {
      const extra = p.beforeRename() || {};
      if (extra.ok !== true) return { ok: false, kind: extra.kind || 'extra-check', reason: extra.reason || '附加复验未通过' };
    }
    return { ok: true };
  };
  const wr = atomicWriteExact(fsm, targetPath, candBuf, { beforeRename });
  if (!wr.ok) return { ok: false, reason: wr.reason, conflict: !!wr.conflict };
  emitAudit(p.audit, {
    kind: 'work-promote', shop: p.shopSafeName || null, role: p.role || 'work-copy',
    time: new Date(nowFn()).toISOString(), sourceSha256Prefix: candSha.slice(0, 12),
    targetSha256Prefix: wr.sha256.slice(0, 12),
    backupPath: backupPath ? path.basename(backupPath) : null, ok: true,
  });
  return { ok: true, targetSha256: wr.sha256, backupPath };
}

module.exports = {
  ARCHIVE_DIRNAME,
  RAW_DIRNAME,
  RECOVERY_DIRNAME,
  MANIFEST_NAME,
  MAX_VERSIONS_SCAN,
  defaultRoots,
  safeShopSegment,
  sha256Of,
  shortSha,
  sameRealDir,
  isInsideDir,
  assertNotArchivePath,
  validateCookieStructure,
  atomicWriteExact,
  targetState,
  createRawSnapshot,
  archiveLegacyBytes,
  listSnapshotVersions,
  readSnapshotVersion,
  updateGuardRecoveryFromVerified,
  listRecoveryVersions,
  promoteCandidateToWorkFile,
};
