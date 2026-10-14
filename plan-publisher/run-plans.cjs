'use strict';

// Standalone deterministic publisher entry. Nothing is loaded from the project
// root, no browser is opened, and no state is written until main() is called.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const wf = require('./plan-workflow.cjs');
const guard = require('./direct-draft-controller.cjs');
const { createConfirmationServer } = require('./confirmation-ui.cjs');
const shopProfile = require('./shop-profile.cjs');

const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'plan-publisher-state.json');
const PUBLISHED_FILE = path.join(ROOT, 'published-products.json');
const ATTEMPTS_FILE = path.join(ROOT, 'plan-publication-attempts.json');
const LOCK_FILE = path.join(ROOT, 'plan-publisher.lock');
const SEED_FILE = path.join(ROOT, 'fixtures', 'published-plan-seed.json');
const CREATION_URL = 'https://qianchuan.jinritemai.com' + wf.BUSINESS.creationUrl;

// The publisher's ONE storage authority is THIS module's own directory (ROOT).
// The external adapter project root (guard.resolveProjectRoot) exists only to
// read config/cookie and require the reader; it is NEVER a write authority for
// publisher state / history / attempts / lock / seed / guidance. main() must use
// this derived path (not shopStatePaths(..., adapterRoot, ...)) so the legacy
// default keeps reading the SAME flat files in place and every generic shop stays
// isolated under ROOT/shop-state/<slug>__<account>/.
function publisherStatePaths(profile, legacyDefault) {
  return shopProfile.shopStatePaths(profile, ROOT, { legacy: legacyDefault === true });
}

// Internal scheduled-entry path helper ONLY: carries the offline test's o.stateRoot DI
// so runScheduledPlan can write into a throwaway tree without ever widening the public
// publisherStatePaths API (which stays ROOT-only, two arguments).
function scheduledStatePaths(profile, legacyDefault, stateRoot) {
  return shopProfile.shopStatePaths(profile, stateRoot || ROOT, { legacy: legacyDefault === true });
}

// Navigation-only account hint for the EXISTING openChengfangShop fallback. A
// shop's local config row may be account-less (e.g. 敏敏本机: accountId null), yet
// the host has ALREADY verified the real 千川 account from the live header (a
// frozen profile account, or the CLI `--account` run parameter). Copy that config
// row preserving EVERY field so the reader's existing 抖店→千川 home fallback can
// target the account instead of mistaking the auto school.jinritemai.com page for
// a popup — WITHOUT rewriting the navigation. This is a HINT, never
// authentication: the live session is still re-proven by verifyLiveIdentity
// AFTER the browser opens, and the CLI/live match gate is unchanged. A KNOWN local
// account that contradicts the hint is refused; when both sides are unknown the
// hint stays null (never guessed). Pure: the input object is never mutated and no
// Cookie / config file is read or written.
function navigationShopCfg(shopCfg, accountHint) {
  const src = shopCfg && typeof shopCfg === 'object' ? shopCfg : {};
  const configured = src.accountId == null || String(src.accountId) === '' ? null : String(src.accountId);
  const hint = accountHint == null || String(accountHint) === '' ? null : String(accountHint);
  if (configured !== null && hint !== null && configured !== hint) {
    const error = new Error('nav-account-hint-conflicts-with-configured:' + configured + '!=' + hint);
    error.code = 'shop-profile-invalid';
    error.reason = 'nav-account-hint-conflicts-with-configured';
    throw error;
  }
  return { ...src, accountId: configured !== null ? configured : hint };
}

// 真实管理入口（客户 2026-10-11 实测）：旧 /uni-prom/overall 重定向首页；正确为
// /overall-prom?aavid=<账户>&campaignType=1。ctx.managementUrl 可覆盖（多店）。
const MANAGEMENT_URL = 'https://qianchuan.jinritemai.com/overall-prom?aavid=' + wf.BUSINESS.accountId + '&campaignType=1';
const POLL_MS = 500;

function atomicWrite(file, value) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(4).toString('hex');
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = null;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd != null) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const recoveryFile = file + '.recovery';
  const token = crypto.randomBytes(16).toString('hex');
  const writeOwnedLock = (recoveryToken = null) => {
    if (fs.existsSync(recoveryFile)) {
      let marker=null;try{marker=JSON.parse(fs.readFileSync(recoveryFile,'utf8'));}catch(_){}
      if(!recoveryToken||!marker||marker.token!==recoveryToken)throw new Error('publisher-lock-recovery-in-progress');
    }
    const fd = fs.openSync(file, 'wx', 0o600);
    const record = { pid: process.pid, startedAt: new Date().toISOString(), token };
    try { fs.writeFileSync(fd, JSON.stringify(record)); fs.fsyncSync(fd); }
    catch (error) { try { fs.closeSync(fd); } catch (_) {} try { fs.unlinkSync(file); } catch (_) {} throw error; }
    if (fs.existsSync(recoveryFile)) {
      let marker=null;try{marker=JSON.parse(fs.readFileSync(recoveryFile,'utf8'));}catch(_){}
      if(recoveryToken&&marker&&marker.token===recoveryToken)return {fd,record};
      try { fs.closeSync(fd); } finally {
        try { const current = JSON.parse(fs.readFileSync(file, 'utf8')); if (current.token === token) fs.unlinkSync(file); } catch (_) {}
      }
      throw new Error('publisher-lock-recovery-race');
    }
    return { fd, record };
  };
  let owned;
  try { owned = writeOwnedLock(); }
  catch (initial) {
    if (!initial || initial.code !== 'EEXIST') throw initial;
    if (fs.existsSync(recoveryFile)) throw new Error('publisher-lock-recovery-in-progress');
    let staleText, stale, stat;
    try {
      staleText = fs.readFileSync(file, 'utf8');
      stat = fs.statSync(file);
      stale = JSON.parse(staleText);
      const tokenValid=typeof stale?.token==='string'&&/^[a-f0-9]{32}$/.test(stale.token);
      const legacyValid=stale&&stale.token==null&&typeof stale.startedAt==='string'&&Number.isFinite(Date.parse(stale.startedAt));
      if (!stale || !Number.isSafeInteger(stale.pid) || stale.pid <= 0 || !tokenValid&&!legacyValid) throw new Error('invalid-lock-record');
    } catch (_) { throw new Error('publisher-lock-owner-unknown'); }
    try { process.kill(stale.pid, 0); throw new Error('publisher-lock-owner-active'); }
    catch (probe) {
      if (probe && probe.message === 'publisher-lock-owner-active') throw probe;
      if (!probe || probe.code !== 'ESRCH') throw new Error('publisher-lock-owner-unknown');
    }
    const recoveryToken = crypto.randomBytes(16).toString('hex');
    let recoveryFd;
    try {
      recoveryFd = fs.openSync(recoveryFile, 'wx', 0o600);
      fs.writeFileSync(recoveryFd, JSON.stringify({ pid: process.pid, token: recoveryToken })); fs.fsyncSync(recoveryFd);
    } catch (_) { if (recoveryFd != null) try { fs.closeSync(recoveryFd); } catch (_) {} throw new Error('publisher-lock-recovery-in-progress'); }
    try {
      const latestText = fs.readFileSync(file, 'utf8');
      const latestStat = fs.statSync(file);
      const latest = JSON.parse(latestText);
      if (latestText !== staleText || latest.pid !== stale.pid || latest.token !== stale.token || latestStat.dev !== stat.dev || latestStat.ino !== stat.ino) throw new Error('publisher-lock-owner-changed-during-recovery');
      try { process.kill(stale.pid, 0); throw new Error('publisher-lock-owner-active'); }
      catch (probe) {
        if (probe && probe.message === 'publisher-lock-owner-active') throw probe;
        if (!probe || probe.code !== 'ESRCH') throw new Error('publisher-lock-owner-unknown');
      }
      fs.unlinkSync(file);
      owned = writeOwnedLock(recoveryToken);
    } catch (error) {
      try { fs.closeSync(recoveryFd); } catch (_) {}
      try {
        const marker = JSON.parse(fs.readFileSync(recoveryFile, 'utf8'));
        if (marker.token === recoveryToken) fs.unlinkSync(recoveryFile);
      } catch (_) {}
      throw error;
    }
    try { fs.closeSync(recoveryFd); } catch (_) {}
    try { const marker = JSON.parse(fs.readFileSync(recoveryFile, 'utf8')); if (marker.token === recoveryToken) fs.unlinkSync(recoveryFile); } catch (_) {}
  }
  const { fd } = owned;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { fs.closeSync(fd); }
    finally {
      try { const current = JSON.parse(fs.readFileSync(file, 'utf8')); if (current.token === token && current.pid === process.pid) fs.unlinkSync(file); } catch (_) {}
    }
  };
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function until(read, accept, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (accept(last)) return last;
    await sleep(POLL_MS);
  }
  throw new Error(label + '-timeout');
}

function listManualUnresolved(attempts) {
  const initial = Object.entries((attempts && attempts.consumed) || {}).filter(([, r]) => r && ['pending', 'dispatched', 'unknown'].includes(r.status));
  const final = Object.entries((attempts && attempts.finalConsumed) || {}).filter(([, r]) => r && ['pending', 'unknown'].includes(r.status));
  return [...initial.map(([id, record]) => ({ kind: 'initial', id, record })), ...final.map(([id, record]) => ({ kind: 'final', id, record }))];
}
function shouldRunReadOnlyRecovery(state, attempts) {
  return listManualUnresolved(attempts).length > 0 || wf.hasUnresolvedPlan(state || {});
}

// ── R42 scope(S8/B)：当日「准备阶段停滞」的安全收口（preparationClosed ≠ 发布成功）──────
// 正式排程 run 在 preparing 相位抛异常时，只有能从**确实存在的记录**正面证明
// 「从未进入任何消费」才允许收口为 preparation-stopped：
//   * 状态文件可读、当日、active 严格 preparing，携带符合正式排程来源的 runId；
//   * active 完全没有 frozen/confirmationId/manifestHash/planId/nonce；
//   * plans / confirmationConsumptions 为已存在数组且不含本份号或本 runId；
//   * attempts 三张表（consumed/finalConsumed/reopenConsumed）无任何本 runId 或同日同份号记录
//     （任何状态都算消费痕迹，pending/unknown 也不例外）；
//   * 无任何手动未决（listManualUnresolved 严格为空）。
// 缺失/损坏文件的"记录缺席"一律不当作证明：文件不可读即拒绝（保持 unknown）。
const SCHEDULED_RUN_ORIGIN_RE = /^plan-scheduler-(\d{4}-\d{2}-\d{2})-[0-9a-f]{16}$/;
function provePreparationZeroConsumption(stateRaw, attempts, businessDate) {
  const a = (stateRaw && stateRaw.active) || null;
  if (!a || a.status !== 'preparing') return { ok: false, reason: 'not-preparing-phase' };
  // R42 scope(S9)：日状态级未决旗标（与 hasUnresolvedPlan 的 s.unknown / s.pending 同一语义面）
  // 是消费疑点：一律禁止收口，绝不把带旗标的 preparing 当"零消费"。
  if (stateRaw.unknown || stateRaw.pending) return { ok: false, reason: 'day-state-unresolved-flag-present' };
  if (String(stateRaw.businessDate || '') !== String(businessDate)) return { ok: false, reason: 'state-business-date-mismatch' };
  if (String(a.businessDate || '') !== String(businessDate)) return { ok: false, reason: 'active-business-date-mismatch' };
  const planNumber = Number(a.planNumber);
  if (!Number.isInteger(planNumber) || planNumber < 1) return { ok: false, reason: 'active-plan-number-invalid' };
  const runId = String(a.runId || '');
  const origin = SCHEDULED_RUN_ORIGIN_RE.exec(runId);
  if (!origin || origin[1] !== String(businessDate)) return { ok: false, reason: 'run-origin-not-scheduled' };
  if (a.frozen || a.confirmationId != null || a.manifestHash != null || a.planId != null || a.nonce != null) {
    return { ok: false, reason: 'confirmation-artifacts-present' };
  }
  if (!Array.isArray(stateRaw.plans)) return { ok: false, reason: 'plans-list-unreadable' };
  if (stateRaw.plans.some(p => p && Number(p.planNumber) === planNumber)) return { ok: false, reason: 'plan-number-already-in-plans' };
  if (!Array.isArray(stateRaw.confirmationConsumptions)) return { ok: false, reason: 'confirmation-consumptions-unreadable' };
  if (stateRaw.confirmationConsumptions.some(r => r && (String(r.runId || '') === runId
    || (String(r.businessDate || '') === String(businessDate) && Number(r.planNumber) === planNumber)))) {
    return { ok: false, reason: 'confirmation-consumption-recorded' };
  }
  if (!attempts || typeof attempts !== 'object' || !attempts.consumed || typeof attempts.consumed !== 'object') {
    return { ok: false, reason: 'attempts-store-unreadable' };
  }
  for (const mapName of ['consumed', 'finalConsumed', 'reopenConsumed']) {
    for (const rec of Object.values(attempts[mapName] || {})) {
      if (!rec) continue;
      if (String(rec.runId || '') === runId) return { ok: false, reason: mapName + '-consumption-for-run' };
      if (String(rec.businessDate || '') === String(businessDate) && Number(rec.planNumber) === planNumber) {
        return { ok: false, reason: mapName + '-consumption-for-same-day-plan' };
      }
    }
  }
  if (listManualUnresolved(attempts).length > 0) return { ok: false, reason: 'manual-unresolved-present' };
  return {
    ok: true, planNumber, runId,
    proof: { initialConsumptions: 0, finalConsumptions: 0, reopenConsumptions: 0, manualUnresolved: 0, plansContainsNumber: false, confirmationConsumptionsRecorded: false },
  };
}

// ── 预导航打开失败的"从未发布"证明（R43/S43）─────────────────────────────────
// 正式排程 run 在 openShop 抛错（尚未取得任何活动页，结构上不可能有发布/消费）时，只有对当日
// day-state 与 attempts store **新鲜回读**、正面证明"无任何发布/消费记录"才可返回可安全重试的
// unsubmitted：**只认耐久状态/尝试事实，绝不认错误文本**（例如 ERR_CONNECTION_CLOSED）。
//   允许收口：state 文件缺失（本店从未在此留下发布），或 active 处于 pre-consumption 相位
//   （pending/preparing/preparation-stopped）且不含任何 frozen/CID/manifestHash/planId/nonce；
//   plans 无 success、confirmationConsumptions 无本日记录、attempts 三表无本日记录。
//   拒绝收口（保持原 failed）：文件不可读/损坏、任一消费痕迹、未决发布相位、本日成功记录。
// 返回 { ok, proof? , reason? }。proof 与调度器 strictNoPublicationProof 形状逐字一致。
function proveNoPublicationPreOpen(stateFile, attemptsFile, businessDate, scope) {
  const date = String(businessDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, reason: 'proof-date-invalid' };
  // scope is OPTIONAL and only NARROWS the proof to ONE exact business plan:
  //   { planNumber, accountId?, shop?, runId? } — used to resume a later plan whose pre-open
  //   failed while an EARLIER same-day plan already succeeded (the blanket "any success on the
  //   day" ban would wrongly permanently seal that recoverable remainder). Absent scope = whole-day.
  //   When shop/accountId/planNumber/runId are supplied they are echoed back into the returned
  //   proof so a downstream consumer can bind it to the EXACT run it came from (never a bare
  //   generic flag). Absent fields are echoed as null so an unbound proof can never satisfy a
  //   bound retry.
  const sc = scope && typeof scope === 'object' && !Array.isArray(scope) ? scope : null;
  const scopedPlan = sc && Number.isInteger(sc.planNumber) && sc.planNumber >= 1 ? sc.planNumber : null;
  const bindShop = sc && typeof sc.shop === 'string' && sc.shop.trim() !== '' ? sc.shop.trim() : null;
  const bindAccount = sc && sc.accountId != null && String(sc.accountId) !== '' ? String(sc.accountId) : null;
  const bindRunId = sc && typeof sc.runId === 'string' && sc.runId !== '' ? sc.runId : null;
  // Raw bytes actually read this run; fed into a deterministic sourceHash so a later mutation
  // can re-verify the SAME store contents (changed / deleted bytes => a different hash => refuse).
  let stateText = null, attemptsText = null;
  if (fs.existsSync(stateFile)) {
    let text;
    try { text = fs.readFileSync(stateFile, 'utf8'); }
    catch (_) { return { ok: false, reason: 'proof-state-unreadable' }; }
    stateText = text;
    let raw;
    try { raw = JSON.parse(text); }
    catch (_) { return { ok: false, reason: 'proof-state-unreadable' }; }
    // A PRESENT-but-malformed day-state (JSON null / array / scalar) is NOT evidence of "never
    // published": only a real object with the expected schema may prove absence. Missing file
    // (never created) stays a valid proof; corrupt/malformed must refuse.
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'proof-state-malformed' };
    // MANDATORY day-state schema: a present file must carry a REAL businessDate for THIS day and a
    // REAL plans array with well-formed entries. The mere ABSENCE of a known consumption key is
    // never treated as "no consumption" (an unrelated object like {lostState:1} must refuse).
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(raw.businessDate || ''))) return { ok: false, reason: 'proof-state-malformed' };
    if (String(raw.businessDate) !== date) return { ok: false, reason: 'proof-state-date-mismatch' };
    if (!Array.isArray(raw.plans)) return { ok: false, reason: 'proof-state-malformed' };
    if (raw.plans.some(p => !p || typeof p !== 'object' || Array.isArray(p) || !Number.isInteger(Number(p.planNumber)) || Number(p.planNumber) < 1)) {
      return { ok: false, reason: 'proof-state-malformed' };
    }
    const plans = raw.plans;
    if (raw.confirmationConsumptions !== undefined && !Array.isArray(raw.confirmationConsumptions)) return { ok: false, reason: 'proof-state-malformed' };
    if (raw.manualUiPublicationFacts !== undefined && !Array.isArray(raw.manualUiPublicationFacts)) return { ok: false, reason: 'proof-state-malformed' };
    // S45 scoped boundary: a target plan T may be resumed when every publication/consumption
    // artifact on the day belongs ONLY to an EARLIER plan that already succeeded. An artifact is
    // tolerated iff it is unambiguously bound to a plan number < T that is a confirmed success in
    // `plans`; an artifact bound to T, to a later plan, or UNBOUND/ambiguous (no numeric
    // planNumber) is a real consumption risk and refuses. Unscoped (whole-day) keeps the blanket ban.
    const successPlanNumbers = new Set(plans.filter(p => String(p.status) === 'success').map(p => Number(p.planNumber)));
    const artifactRefusesTarget = (planNo) => {
      if (scopedPlan == null) return true;
      if (!Number.isInteger(planNo)) return true;
      if (planNo === scopedPlan) return true;
      if (planNo < scopedPlan && successPlanNumbers.has(planNo)) return false;
      return true;
    };
    if (raw.firstPublishedPlan != null) {
      const fp = raw.firstPublishedPlan;
      if (typeof fp !== 'object' || Array.isArray(fp) || artifactRefusesTarget(Number(fp.planNumber))) {
        return { ok: false, reason: 'proof-consumption-artifacts-present' };
      }
    }
    const a = raw.active || null;
    if (a != null && (typeof a !== 'object' || Array.isArray(a))) return { ok: false, reason: 'proof-state-malformed' };
    if (a) {
      if (a.frozen || a.confirmationId != null || a.manifestHash != null || a.planId != null || a.nonce != null) {
        if (artifactRefusesTarget(Number(a.planNumber))) return { ok: false, reason: 'proof-consumption-artifacts-present' };
      }
      const st = String(a.status || '');
      if (st && !['pending', 'preparing', 'preparation-stopped'].includes(st) && artifactRefusesTarget(Number(a.planNumber))) {
        return { ok: false, reason: 'proof-unresolved-publication-phase:' + st };
      }
    }
    // A plan record is a consumption artifact if it succeeded OR carries a planId/manifestHash.
    const planConsumed = (p) => !!p && (String(p.status) === 'success' || p.planId != null || p.manifestHash != null);
    if (scopedPlan != null) {
      if (plans.some(p => Number(p.planNumber) === scopedPlan && planConsumed(p))) return { ok: false, reason: 'proof-plans-contain-success' };
    } else if (plans.some(planConsumed)) {
      return { ok: false, reason: 'proof-plans-contain-success' };
    }
    const cc = Array.isArray(raw.confirmationConsumptions) ? raw.confirmationConsumptions : [];
    if (cc.some(r => r && String(r.businessDate || '') === date && (scopedPlan == null || r.planNumber == null || Number(r.planNumber) === scopedPlan))) {
      return { ok: false, reason: 'proof-confirmation-consumption-recorded' };
    }
    const mu = Array.isArray(raw.manualUiPublicationFacts) ? raw.manualUiPublicationFacts : [];
    if (mu.some(r => r && String(r.businessDate || '') === date && (scopedPlan == null || r.planNumber == null || Number(r.planNumber) === scopedPlan))) {
      return { ok: false, reason: 'proof-manual-publication-recorded' };
    }
  }
  if (fs.existsSync(attemptsFile)) {
    // Validate the RAW store shape BEFORE trusting guard.loadAttemptsStore (whose ENOENT path
    // silently fills absent maps and would read a malformed present file as "empty first try").
    let rawAttempts;
    try { attemptsText = fs.readFileSync(attemptsFile, 'utf8'); rawAttempts = JSON.parse(attemptsText); }
    catch (_) { return { ok: false, reason: 'proof-attempts-unreadable' }; }
    if (!rawAttempts || typeof rawAttempts !== 'object' || Array.isArray(rawAttempts)) return { ok: false, reason: 'proof-attempts-malformed' };
    for (const mapName of ['consumed', 'finalConsumed', 'reopenConsumed']) {
      const m = rawAttempts[mapName];
      if (m !== undefined && (!m || typeof m !== 'object' || Array.isArray(m))) return { ok: false, reason: 'proof-attempts-malformed' };
    }
    let store;
    try { store = guard.loadAttemptsStore(attemptsFile); }
    catch (_) { return { ok: false, reason: 'proof-attempts-unreadable' }; }
    // A present consume record MUST itself be well-formed: real YYYY-MM-DD businessDate, numeric
    // planNumber, and a recognised status. A record whose scope is missing/invalid is UNKNOWN — it
    // can never be silently dropped as "not for this day/plan" — so any such record refuses.
    const RECOGNIZED_ATTEMPT_STATUS = new Set(['pending', 'dispatched', 'unknown', 'success', 'failed']);
    for (const mapName of ['consumed', 'finalConsumed', 'reopenConsumed']) {
      for (const rec of Object.values((store && store[mapName]) || {})) {
        if (!rec || typeof rec !== 'object' || Array.isArray(rec)
          || !/^\d{4}-\d{2}-\d{2}$/.test(String(rec.businessDate || ''))
          || !Number.isInteger(Number(rec.planNumber)) || Number(rec.planNumber) < 1
          || !RECOGNIZED_ATTEMPT_STATUS.has(String(rec.status || ''))) {
          return { ok: false, reason: 'proof-attempt-record-malformed' };
        }
        if (String(rec.businessDate) !== date) continue;
        if (scopedPlan != null && Number(rec.planNumber) !== scopedPlan) continue;
        return { ok: false, reason: 'proof-attempt-record-for-date' };
      }
    }
  }
  return {
    ok: true,
    proof: {
      method: 'pre-navigation-open-failed', businessDate: date,
      opened: false, stateProven: true, attemptsProven: true,
      shop: bindShop, accountId: bindAccount, planNumber: scopedPlan, runId: bindRunId,
      sourceHash: preOpenSourceHash(stateText, attemptsText),
    },
  };
}

// Deterministic content hash of the two stores a zero-publication proof actually read. An absent
// file maps to a distinct sentinel (never conflated with an empty/whitespace file), so a later
// mutation-time re-read that finds CHANGED or DELETED bytes yields a different hash and refuses.
const PRE_OPEN_ABSENT_SENTINEL = '\u0000ABSENT\u0000';
function preOpenSourceHash(stateText, attemptsText) {
  const s = stateText == null ? PRE_OPEN_ABSENT_SENTINEL : ('S:' + stateText);
  const a = attemptsText == null ? PRE_OPEN_ABSENT_SENTINEL : ('A:' + attemptsText);
  return sha256Hex(s + '\u0001' + a);
}

function readStoreTextSafe(file) {
  try { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; }
  catch (_) { return undefined; } // unreadable: distinct from absent, so a re-read never falsely matches
}

// Recompute the proof's sourceHash straight from the CURRENT on-disk stores. A caller that must
// re-verify at mutation time under its own lock uses this to detect changed/deleted bytes.
function currentPreOpenSourceHash(stateFile, attemptsFile) {
  const s = readStoreTextSafe(stateFile);
  const a = readStoreTextSafe(attemptsFile);
  if (s === undefined || a === undefined) return null;
  return preOpenSourceHash(s, a);
}

// Deterministic sha256 (hex) of an entry's recorded reason — the ONLY quantity used to bind a
// release proof to the EXACT scheduler entry it targets (never a bare/reused boolean flag).
function sha256Hex(text) { return crypto.createHash('sha256').update(String(text == null ? '' : text)).digest('hex'); }

function readSchedulerLedgerRaw(ledgerFile) {
  let text;
  try { text = fs.readFileSync(ledgerFile, 'utf8'); }
  catch (_) { return { ok: false, reason: 'release-ledger-unreadable' }; }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (_) { return { ok: false, reason: 'release-ledger-corrupt' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !parsed.days || typeof parsed.days !== 'object' || Array.isArray(parsed.days)) {
    return { ok: false, reason: 'release-ledger-corrupt' };
  }
  return { ok: true, ledger: parsed };
}

// ── Explicit trusted release binding (S44) ────────────────────────────────────
// The ONLY supported way to release a per-day terminal `failed`/`blocked` scheduler entry for
// the CURRENT business day without a raw ledger edit. A valid proof binds:
//   (a) the EXACT current ledger entry (shop + date + plan + record status + entry status +
//       sha256 of the entry's own recorded reason), and
//   (b) an independent fresh zero-publication re-proof at the SAME shop/date/plan scope
//       (proveNoPublicationPreOpen with that exact plan scope).
// It never splices a different reason/fact, never another shop/date/plan, never an unauthenticated
// or arbitrary claim: unknown/frozen/consumed/in-progress entries are structurally rejected.
function proveSchedulerReleaseProof(ledgerFile, statePaths, spec) {
  const s = spec && typeof spec === 'object' && !Array.isArray(spec) ? spec : {};
  const businessDate = String(s.businessDate || '');
  const shop = String(s.shop || '').trim();
  const planNumber = s.planNumber;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return { ok: false, reason: 'release-date-invalid' };
  if (!shop) return { ok: false, reason: 'release-shop-missing' };
  if (!Number.isInteger(planNumber) || planNumber < 1) return { ok: false, reason: 'release-plan-invalid' };
  if (!statePaths || !statePaths.stateFile || !statePaths.attemptsFile) return { ok: false, reason: 'release-state-paths-missing' };
  const led = readSchedulerLedgerRaw(ledgerFile);
  if (!led.ok) return led;
  const day = led.ledger.days[businessDate];
  const rec = day && day.shops && day.shops[shop];
  if (!rec || typeof rec !== 'object') return { ok: false, reason: 'release-no-current-entry' };
  const entry = rec.entries && rec.entries[String(planNumber)];
  if (!entry || typeof entry !== 'object') return { ok: false, reason: 'release-no-current-entry' };
  if (rec.status !== 'failed' && rec.status !== 'blocked') return { ok: false, reason: 'release-record-not-terminal-failure:' + String(rec.status) };
  if (entry.status !== 'failed' && entry.status !== 'preparation-stopped') return { ok: false, reason: 'release-entry-not-prepublication:' + String(entry.status) };
  const pub = proveNoPublicationPreOpen(statePaths.stateFile, statePaths.attemptsFile, businessDate, { planNumber, accountId: s.accountId, shop });
  if (!pub.ok) return { ok: false, reason: pub.reason };
  // Bind the entry's OWN recorded runId when it carries one; a legacy entry (no runId) stays null
  // — we never invent or splice a runId from an unrelated closure.
  const entryRunId = (typeof entry.runId === 'string' && entry.runId)
    ? entry.runId
    : ((typeof entry.preparationRunId === 'string' && entry.preparationRunId) ? entry.preparationRunId : null);
  const proof = {
    status: 'scheduler-release-prepublication',
    method: 'scheduler-release-prepublication',
    businessDate, shop, planNumber,
    accountId: s.accountId == null ? null : String(s.accountId),
    recStatus: String(rec.status),
    entryStatus: String(entry.status),
    entryReasonHash: sha256Hex(entry.reason),
    entryAt: entry.at != null ? String(entry.at) : null,
    entryRunId,
    // Fresh-source re-read anchors: the mutation-time releaser recomputes the source hash from
    // these exact bound paths and refuses on any changed / deleted bytes.
    sourceHash: pub.proof.sourceHash,
    sourceStateFile: statePaths.stateFile,
    sourceAttemptsFile: statePaths.attemptsFile,
    publicationProof: pub.proof,
  };
  return { ok: true, proof };
}

// 严格零消费证明判据：六个字段必须恰好为规定值。缺字段/其它值/非对象一律不算证明——
// 恢复入口与账本释放只认这个结构，绝不凭 status 文字或任意异常原因收口。
function strictZeroConsumptionProof(p) {
  return !!p && typeof p === 'object' && !Array.isArray(p)
    && p.initialConsumptions === 0 && p.finalConsumptions === 0 && p.reopenConsumptions === 0
    && p.manualUnresolved === 0 && p.plansContainsNumber === false && p.confirmationConsumptionsRecorded === false;
}

// Durable, data-preserving close: re-loads BOTH files fresh (absence/corruption = refuse),// re-proves zero consumption under the caller's lock, appends one bounded
// preparationClosureFacts record and flips active preparing → preparation-stopped.
// Nothing else is touched: plans / lastSelected / attempted / cursor / hints / history and the
// attempts store are all preserved verbatim. Idempotent by runId + businessDate.
function applyProvenPreparationClose(stateFile, attemptsFile, businessDate, closure, opts) {
  const o = opts || {};
  const now = typeof o.nowMs === 'function' ? o.nowMs() : Date.now();
  let raw;
  try { raw = JSON.parse(fs.readFileSync(stateFile, 'utf8')); }
  catch (error) { return { closed: false, reason: 'preparation-close-state-unreadable:' + scheduledErrorText(error) }; }
  // R42 scope(S9/S10)：**任何**调用方（只读恢复与 scheduled-run-catch 一视同仁）都必须确认
  // attempts 文件确实存在才可收口——guard loader 的 ENOENT→空 store 是"首次尝试"的全局初始
  // 语义，不得改、也不新增任何存储初始化机制；但准备收口证明绝不把"文件缺失/被删"当作
  // 零消费证据。缺失即拒绝（保持原 preparing/unknown），损坏仍由严格 schema 校验拒绝。
  if (!fs.existsSync(attemptsFile)) {
    return { closed: false, reason: 'preparation-close-attempts-file-missing' };
  }
  let attempts;
  try { attempts = guard.loadAttemptsStore(attemptsFile); }
  catch (error) { return { closed: false, reason: 'preparation-close-attempts-unreadable:' + scheduledErrorText(error) }; }
  const chk = provePreparationZeroConsumption(raw, attempts, businessDate);
  if (!chk.ok) return { closed: false, reason: 'preparation-close-recheck-failed:' + chk.reason };
  const fact = {
    status: 'preparationClosed', phase: 'preparing',
    reason: String(closure.reason || (raw.active && raw.active.reason) || 'preparing-exception'),
    source: String(closure.source || 'read-only-recovery'),
    runId: chk.runId, planNumber: chk.planNumber, businessDate: String(businessDate),
    shop: String(closure.shop || ''), accountId: String(closure.accountId == null ? '' : closure.accountId),
    zeroConsumptionProof: chk.proof, closedAt: new Date(now).toISOString(),
  };
  raw.preparationClosureFacts = Array.isArray(raw.preparationClosureFacts) ? raw.preparationClosureFacts.slice(-9) : [];
  if (!raw.preparationClosureFacts.some(f => f && String(f.runId) === fact.runId && String(f.businessDate) === fact.businessDate)) {
    raw.preparationClosureFacts.push(fact);
  }
  raw.active = {
    status: 'preparation-stopped', planNumber: chk.planNumber, runId: chk.runId, businessDate: String(businessDate),
    originalPhase: 'preparing', reason: fact.reason, source: fact.source, closedAt: fact.closedAt,
  };
  atomicWrite(stateFile, raw);
  return { closed: true, fact };
}

function pageText(el) { return (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); }
function categoryIsActive(snap, category) {
  const norm=x=>String(x||'').replace(/\s/g,'').replace(/流量扶持/g,'');
  return (snap&&snap.activeTabs||[]).some(t=>norm(t)===category||category==='搜索趋势'&&norm(t)==='搜索趋势推荐');
}
function pickerBatchStateMatches(snap, baseSelectedCount, batchSelectedCount) {
  const capacity=wf.BUSINESS.productsPerPlan-baseSelectedCount;
  return !!snap&&snap.ok===true&&Number.isInteger(baseSelectedCount)&&baseSelectedCount>=0
    &&capacity>=1&&capacity<=wf.BUSINESS.productsPerPlan
    &&Number.isInteger(batchSelectedCount)&&batchSelectedCount>=0&&batchSelectedCount<=capacity
    &&snap.remainingCapacity===capacity&&snap.selectedCount===batchSelectedCount;
}

// ── mixed-mode product catalog: native-scroll categories (cursor API, mode 3)
// versus the numeric-pager category 全部. The three native categories have no
// numeric currentPage, so the numeric guard must not be applied to them; their
// pagination is proven only through the page's OWN list-products exchanges that
// this transport passively observes (never a fetch we issue). ──
const CATALOG_ORIGIN = 'https://qianchuan.jinritemai.com';
const CATALOG_PATH = '/ad/api/creation/v1/product/list-products';
const CATALOG_ACCOUNT_KEY = 'aavid';
const CATALOG_TAB_KEY = 'tab';
const CATALOG_KEYWORD_KEY = 'keyword';
const CATALOG_CURSOR_KEY = 'cursor';
const CATALOG_INITIAL_CURSOR = '0';
const CATALOG_NATIVE_MODE = 3;
const CATEGORY_TAB = Object.freeze({ '店铺新品': '2', '破圈尖货': '15', '搜索趋势': '14', '全部': '1' });
const NATIVE_SCROLL_CATEGORIES = Object.freeze(['店铺新品', '破圈尖货', '搜索趋势']);
const NATIVE_SCROLL_TABS = Object.freeze(NATIVE_SCROLL_CATEGORIES.map(c => CATEGORY_TAB[c]));
const NATIVE_SCROLL_ROOT_SELECTOR = '.product-list';
const NATIVE_SCROLL_MAX_ADVANCES = 40;
const NATIVE_SCROLL_TIMEOUT_MS = 15000;

// Single source of truth for the per-category native-scroll cursor decision (S44). The three
// cases are DISTINCT and must never be conflated:
//   'switch' — entering a fresh category: cursor is reset to page 1 with NO stale nativeEof /
//              nativeAdvances carried over from a previous category.
//   'eof'    — the transport PROVED hasMore=false and every accumulated id landed in the DOM:
//              the ONLY honest exhaustion. Marks nativeEof:true for that category.
//   'budget' — the bounded advance budget was exhausted WITHOUT an EOF proof: this is NOT an
//              honest exhaust and must NEVER be persisted as nativeEof (it would make a later
//              resume believe the category ended). nativeEof is explicitly cleared.
function nativeAdvanceCursor(prev, cat, kind, nativeAdvances) {
  const seen = Array.isArray(prev && prev.seenProductIds) ? prev.seenProductIds.slice() : [];
  if (kind === 'eof') {
    return { category: cat, page: 1, seenProductIds: seen, nativeEof: true, nativeAdvances: Number.isInteger(nativeAdvances) ? nativeAdvances : 0 };
  }
  // 'switch' and 'budget' both hold an honest non-EOF cursor: nativeEof is cleared, never stale.
  return { category: cat, page: 1, seenProductIds: seen, nativeEof: false, nativeAdvances: Number.isInteger(nativeAdvances) ? nativeAdvances : 0 };
}
// S21 hard bound for the auto-pull off-page deselect walk-back: the All numeric pager
// never shows more than a few dozen pages live; a proven position farther back than this
// is treated as drift/unknown and stops honestly instead of walking.
const AUTO_PULL_OFFPAGE_MAX_PAGE_STEPS = 60;
// Bounded read-only SPA-hydration waits. After managerPage.goto(...,'domcontentloaded')
// the account reader returns null/unknown identity until the SPA hydrates, so we poll
// (never a fixed sleep, never a fake success) up to these production bounds before we
// touch any tab. A timeout stays a refusal with ZERO tab click / ZERO final consumption.
const MANAGEMENT_HYDRATE_TIMEOUT_MS = 30000;
const MANAGEMENT_TAB_SETTLE_TIMEOUT_MS = 15000;
// Bounded read-only wait for the row on the ORIGINAL page that already redirected to the
// real post-publish success management view (R40). This is a short, dedicated bound so a
// creation page that has NOT yet redirected (or is still settling) fails fast and cleanly
// falls back to the strict cold-goto path. A timeout stays a refusal, never a success.
const SUCCESS_MANAGEMENT_READ_TIMEOUT_MS = 20000;
const MANAGEMENT_ROUTE_RE = /^https:\/\/qianchuan\.jinritemai\.com\/(?:uni-prom\/overall|overall-prom)(?:[\/?#]|$)/i;

function normalizeCatalogCategory(label) {
  const norm = String(label == null ? '' : label).replace(/\s/g, '').replace(/流量扶持/g, '');
  return norm === '搜索趋势推荐' ? '搜索趋势' : norm;
}
function catalogTabForCategory(category) {
  return Object.prototype.hasOwnProperty.call(CATEGORY_TAB, category) ? CATEGORY_TAB[category] : null;
}
function isNativeScrollCategory(category) {
  return NATIVE_SCROLL_CATEGORIES.indexOf(category) !== -1;
}
function isNativeScrollTab(tab) {
  return NATIVE_SCROLL_TABS.indexOf(String(tab)) !== -1;
}
function unionCatalogIds(batches) {
  const out = [];
  const seen = new Set();
  for (const b of batches || []) for (const id of b.ids || []) if (!seen.has(id)) { seen.add(id); out.push(id); }
  return out;
}

// Pure, desensitized validation of one observed list-products REQUEST url. Only
// the exact endpoint, a unique exact account, a unique tab, an empty keyword and
// a unique cursor are accepted. The raw url (which may carry tokens) is never
// returned or logged; only the tab and cursor strings are surfaced.
function parseCatalogRequestUrl(rawUrl, expectedAccount) {
  let url;
  try { url = new URL(String(rawUrl)); } catch (_) { return { ok: false, reason: 'catalog-request-url-unparseable' }; }
  if (url.origin !== CATALOG_ORIGIN || url.pathname !== CATALOG_PATH) return { ok: false, reason: 'catalog-endpoint-mismatch' };
  const aavid = url.searchParams.getAll(CATALOG_ACCOUNT_KEY);
  if (aavid.length !== 1 || aavid[0] !== String(expectedAccount)) return { ok: false, reason: 'catalog-account-mismatch' };
  const tab = url.searchParams.getAll(CATALOG_TAB_KEY);
  if (tab.length !== 1) return { ok: false, reason: 'catalog-tab-not-unique' };
  const keyword = url.searchParams.getAll(CATALOG_KEYWORD_KEY);
  if (keyword.length > 1 || (keyword.length === 1 && keyword[0] !== '')) return { ok: false, reason: 'catalog-keyword-not-empty' };
  const cursor = url.searchParams.getAll(CATALOG_CURSOR_KEY);
  if (cursor.length !== 1) return { ok: false, reason: 'catalog-cursor-not-unique' };
  return { ok: true, tab: tab[0], cursor: cursor[0] };
}

// Pure validation of one observed list-products RESPONSE body for a NATIVE
// category. The numeric category 全部 has no native hasMore/mode field and must
// never be put through this rule. Duplicate or malformed IDs fail closed.
function parseCatalogResponseBody(json) {
  if (!json || typeof json !== 'object') return { ok: false, reason: 'catalog-response-body-invalid' };
  if (json.status_code !== 0) return { ok: false, reason: 'catalog-response-status-code-not-zero' };
  const data = json.data;
  if (!data || typeof data !== 'object') return { ok: false, reason: 'catalog-response-data-missing' };
  const rows = data.productListInfos;
  if (!Array.isArray(rows)) return { ok: false, reason: 'catalog-response-rows-not-array' };
  const ids = [];
  for (const row of rows) {
    const info = row && row.productInfo;
    const sid = String(info && info.id != null ? info.id : '');
    if (!/^\d{15,20}$/.test(sid)) return { ok: false, reason: 'catalog-response-id-invalid' };
    ids.push(sid);
  }
  if (new Set(ids).size !== ids.length) return { ok: false, reason: 'catalog-response-duplicate-id' };
  const pagination = data.pagination;
  if (!pagination || typeof pagination !== 'object') return { ok: false, reason: 'catalog-response-pagination-missing' };
  if (pagination.mode !== CATALOG_NATIVE_MODE) return { ok: false, reason: 'catalog-response-mode-not-native' };
  if (typeof pagination.hasMore !== 'boolean') return { ok: false, reason: 'catalog-response-hasmore-not-boolean' };
  if (typeof pagination.cursor !== 'string') return { ok: false, reason: 'catalog-response-cursor-not-string' };
  return { ok: true, ids, hasMore: pagination.hasMore, mode: pagination.mode, cursor: pagination.cursor };
}

// Every function passed to page.evaluate is self-contained because Playwright
// serializes it. The creation DOM selectors come from the frozen page evidence;
// every action re-derives the exact visible row/control and reads back state.
function openPickerInPage() {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  if(location.origin!=='https://qianchuan.jinritemai.com'||!/^\/uni-creation\/overall-product-multi\/?$/.test(location.pathname))throw new Error('not-authorized-creation-page');
  // '添加商品' is the empty-page native button; '继续添加商品' appears once products are already added.
  const buttons = [...document.querySelectorAll('button,[role="button"]')].filter(visible).filter(e => ['添加商品','继续添加商品'].includes((e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim()));
  if (buttons.length !== 1) throw new Error('product-picker-entry-not-unique');
  const entry = buttons[0];
  if (entry.disabled === true || entry.getAttribute('aria-disabled') === 'true') throw new Error('product-picker-entry-disabled');
  entry.click();
  return true;
}

async function ensureCommissionInPage() {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const target = () => [...document.querySelectorAll('input[type="checkbox"]')].filter(visible).filter(input => {
    let p = input.parentElement;
    for (let i = 0; p && i < 8; i++, p = p.parentElement) {
      const owned = [...p.querySelectorAll('input[type="checkbox"]')].filter(visible);
      if (owned.length === 1 && owned[0] === input && /含达人佣金/.test((p.innerText || p.textContent || '').replace(/\s+/g, ' '))) return true;
    }
    return false;
  });
  const disabled = input => {
    let p=input;
    for(let i=0;p&&i<9;i++,p=p.parentElement) {
      if(p.disabled===true||p.getAttribute('aria-disabled')==='true'||/(^|\s)(is-disabled|disabled)(\s|$)/i.test(String(p.className||'')))return true;
    }
    return false;
  };
  let actionTaken=false;
  for(let attempt=0;attempt<20;attempt++) {
    const boxes=target();
    if(boxes.length>1)throw new Error('commission-checkbox-not-unique');
    if(boxes.length===0) {
      if(actionTaken){await new Promise(resolve=>setTimeout(resolve,50));continue;}
      throw new Error('commission-checkbox-not-unique');
    }
    const input=boxes[0];
    if(typeof input.checked!=='boolean')throw new Error('commission-checkbox-state-unknown');
    if(disabled(input))throw new Error('commission-checkbox-disabled');
    if(actionTaken) {
      if(input.checked===true)return {checked:true};
      await new Promise(resolve=>setTimeout(resolve,50));continue;
    }
    const labels=[...document.querySelectorAll('label')].filter(visible).filter(l=>l.contains(input));
    if(labels.length!==1)throw new Error('commission-native-label-not-unique');
    if(disabled(labels[0]))throw new Error('commission-native-label-disabled');
    if(input.checked===true)return {checked:true};
    labels[0].click();
    actionTaken=true;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('commission-check-not-confirmed');
}

async function ensureDirectPayOffInPage() {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const target = () => [...document.querySelectorAll('input[type="checkbox"]')].filter(visible).filter(input => {
    let p = input.parentElement;
    for (let i = 0; p && i < 8; i++, p = p.parentElement) {
      const owned = [...p.querySelectorAll('input[type="checkbox"]')].filter(visible);
      if (owned.length === 1 && owned[0] === input && /货款直投/.test((p.innerText || p.textContent || '').replace(/\s+/g, ' '))) return true;
    }
    return false;
  });
  const disabled = input => {
    let p=input;
    for(let i=0;p&&i<9;i++,p=p.parentElement) {
      if(p.disabled===true||p.getAttribute('aria-disabled')==='true'||/(^|\s)(is-disabled|disabled)(\s|$)/i.test(String(p.className||'')))return true;
    }
    return false;
  };
  let actionTaken=false;
  for(let attempt=0;attempt<20;attempt++) {
    const boxes=target();
    if(boxes.length>1)throw new Error('direct-pay-checkbox-not-unique');
    if(boxes.length===0) {
      if(actionTaken){await new Promise(resolve=>setTimeout(resolve,50));continue;}
      throw new Error('direct-pay-checkbox-not-unique');
    }
    const input=boxes[0];
    if(typeof input.checked!=='boolean')throw new Error('direct-pay-checkbox-state-unknown');
    if(disabled(input))throw new Error('direct-pay-checkbox-disabled');
    if(actionTaken) {
      if(input.checked===false)return {checked:false};
      await new Promise(resolve=>setTimeout(resolve,50));continue;
    }
    const labels=[...document.querySelectorAll('label')].filter(visible).filter(l=>l.contains(input));
    if(labels.length!==1)throw new Error('direct-pay-native-label-not-unique');
    if(disabled(labels[0]))throw new Error('direct-pay-native-label-disabled');
    if(input.checked===false)return {checked:false};
    labels[0].click();
    actionTaken=true;
    await new Promise(resolve=>setTimeout(resolve,50));
  }
  throw new Error('direct-pay-uncheck-not-confirmed');
}

function drawerSnapshotInPage() {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const txt = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const selector = '[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]';
  const TAB_SEL = '[class*="product-drawer-header-tab-item"],[class*="ovui-tabs__tab"]';
  const scopeTabs = scope => { const els = [...scope.querySelectorAll(TAB_SEL)].filter(visible); const leaf = e => { const desc = els.filter(x => x !== e && e.contains(x)); if (!desc.length) return txt(e); const deepest = desc.filter(d => !desc.some(o => o !== d && d.contains(o))); return txt(deepest[0]); }; return { owners: els.filter(e => !els.some(o => o !== e && o.contains(e))), leaf }; };
  const candidates = [...document.querySelectorAll(selector)].filter(visible).filter(el => {
    const all = txt(el);
    if (/为商品添加抖音号/.test(all)) return false;
    const { owners, leaf } = scopeTabs(el);
    const tabs = owners.map(leaf).map(s => s.replace(/\s+/g, '').replace(/流量扶持/g, ''));
    const has = x => tabs.includes(x) || (x === '搜索趋势' && tabs.includes('搜索趋势推荐'));
    return has('全部') && has('店铺新品') && has('破圈尖货') && has('搜索趋势') && /已选\s*\d+\s*\/\s*(?:[1-9]|[12]\d|30)/.test(all) && [...el.querySelectorAll('button,[role="button"]')].some(b => visible(b) && txt(b) === '下一步');
  });
  const roots = candidates.filter(el => !candidates.some(other => other !== el && other.contains(el)));
  if (roots.length !== 1) return { ok: false, reason: 'product-drawer-not-unique', count: roots.length };
  const root = roots[0];
  const cards = [...root.querySelectorAll('.card-container')].filter(visible).map(card => {
    const text = txt(card);
    const m = text.match(/ID\s*[:：]\s*(\d{15,20})/);
    const checks = [...card.querySelectorAll('input[type="checkbox"]')];
    return { id: m ? m[1] : null, text: text.slice(0, 1200), disabled: card.getAttribute('aria-disabled') === 'true' || !!card.querySelector('.card-product-item--disabled,[aria-disabled="true"],[disabled]'), checkboxCount: checks.length, checked: checks.length === 1 ? checks[0].checked === true : null };
  });
  const footer = root.innerText.match(/已选\s*(\d+)\s*\/\s*(\d{1,2})/);
  const { owners, leaf } = scopeTabs(root);
  const active = owners.filter(el => /active|selected|current/i.test(String(el.className || '')) || el.getAttribute('aria-selected') === 'true').map(leaf);
  const pager = [...root.querySelectorAll('[class*="pagination"],[class*="Pagination"],[class*="page-item"],[class*="pager"],[class*="Pager"],[class*="pages"]')].filter(visible);
  return { ok: true, cards, selectedCount: footer ? Number(footer[1]) : null, remainingCapacity: footer ? Number(footer[2]) : null, activeTabs: active, rootText: txt(root).slice(0, 1000), pagerCount: pager.length };
}

// R28: the real "全部" (All) numeric picker pager observed live in
// r27-numeric-pager-dom-readonly.json is
// .pagination-wrapper > .ovui-pagination > ul.ovui-page-turner, whose next control is a
// bare <li class="ovui-page-turner__item"> wrapping a
// <div class="ovui-page-turner__next-icon"><svg/></div> with NO text, NO role and NO title
// (its sibling prev-icon li carries ovui-page-turner__item--disabled on page 1; the next
// li does not). The frozen generic pageObserve only walks
// button/a/li/input/span/[role="button"] leaves and derives a "next" kind ONLY from the
// leaf's OWN class token, so this svg-only li never classifies as a next control —
// resolvePageTarget therefore correctly refuses with "No observed next control". This is a
// genuine All-closure gap, NOT a native-scroll issue: the three native scroll categories
// keep their unchanged original logic (this callback is never routed for them).
// This is a strict, self-contained, single-purpose fallback used ONLY for this exact
// observed All numeric shape. mode 'read' performs zero clicks. mode 'next' re-reads
// EVERYTHING fresh inside the same synchronous evaluate (no host round-trip can slip between
// the check and the click) and clicks the unique next LI exactly once, ONLY when every strict
// proof below affirmatively matches. S21 adds mode 'prev' as the exact backward mirror of
// 'next' (same scope proofs, same explicit-only disabled rule, one click on the unique
// prev-icon LI); 'read' and 'next' semantics are byte-for-byte unchanged and 'prev' is used
// ONLY by the bounded auto-pull off-page deselect walk-back, never for catalog advancement. Any unknown / ambiguous / mismatching shape returns
// ok:false with zero clicks; the caller must then STOP, never catch-and-continue past an
// unproven state. A missing or duplicate next control, an account/category/page/footer/
// checked-set/overlay drift, or a "disabled" signal that is not exactly one explicit
// ovui-page-turner__item--disabled token on this exact next li (e.g. an aria-disabled
// disagreeing with the class token) is NEVER treated as either a proven boundary or a
// safe-to-click state — it is always a zero-action stop. Only an explicit, proven disabled
// token on the unique next li of this exact verified drawer/page/footer IS the real boundary.
// The visible maximum page number (e.g. "60") is auxiliary readback evidence ONLY — it is
// never used to infer total page count or to prove a boundary on its own.
function numericPickerPagingInPage(payload) {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const txt = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const clsOf = e => String(e.className || '');
  const DIALOG_SEL = '[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]';

  const mode = payload && payload.mode;
  if (mode !== 'read' && mode !== 'next' && mode !== 'prev') return { ok: false, reason: 'numeric-pager-mode-unknown', clicked: false };
  if (location.origin !== 'https://qianchuan.jinritemai.com' || !/^\/uni-creation\/overall-product-multi\/?$/.test(location.pathname)) {
    return { ok: false, reason: 'numeric-pager-creation-page-not-authorized', clicked: false };
  }
  // aavid must be a single exact value on the live URL, never inferred from cached host state
  const aavid = new URLSearchParams(location.search).getAll('aavid');
  if (aavid.length !== 1) return { ok: false, reason: 'numeric-pager-aavid-not-unique', clicked: false };

  // account identity comes ONLY from the same navigator-header scope pageObserve already
  // trusts (exact .qc-page-navigator-container, fallback [class*="navigator"]); a drawer's own
  // text can never pose as the account
  const navExact = [...new Set([...document.querySelectorAll('.qc-page-navigator-container')])].filter(visible).filter(el => !el.closest(DIALOG_SEL));
  const navCands = navExact.length ? navExact : [...new Set([...document.querySelectorAll('[class*="navigator"]')])].filter(visible).filter(el => !el.closest(DIALOG_SEL));
  const accountIdSet = new Set();
  for (const el of navCands) {
    const ids = (txt(el).match(/ID\s*[:：]\s*\d{8,20}/g) || []).map(s => s.replace(/ID\s*[:：]\s*/, ''));
    for (const id of ids) accountIdSet.add(id);
  }
  const accountId = accountIdSet.size === 1 ? [...accountIdSet][0] : 'unknown';
  if (accountId === 'unknown') return { ok: false, reason: 'numeric-pager-account-unknown', clicked: false };

  // unique product drawer root — the same tab/footer signature drawerSnapshotInPage requires
  const TAB_SEL = '[class*="product-drawer-header-tab-item"],[class*="ovui-tabs__tab"]';
  const scopeTabs = scope => { const els = [...scope.querySelectorAll(TAB_SEL)].filter(visible); const leaf = e => { const desc = els.filter(x => x !== e && e.contains(x)); if (!desc.length) return txt(e); const deepest = desc.filter(d => !desc.some(o => o !== d && d.contains(o))); return txt(deepest[0]); }; return { owners: els.filter(e => !els.some(o => o !== e && o.contains(e))), leaf }; };
  const candidates = [...document.querySelectorAll(DIALOG_SEL)].filter(visible).filter(el => {
    const all = txt(el);
    if (/为商品添加抖音号/.test(all)) return false;
    const { owners, leaf } = scopeTabs(el);
    const tabs = owners.map(leaf).map(s => s.replace(/\s+/g, '').replace(/流量扶持/g, ''));
    const has = x => tabs.includes(x) || (x === '搜索趋势' && tabs.includes('搜索趋势推荐'));
    return has('全部') && has('店铺新品') && has('破圈尖货') && has('搜索趋势') && /已选\s*\d+\s*\/\s*(?:[1-9]|[12]\d|30)/.test(all) && [...el.querySelectorAll('button,[role="button"]')].some(b => visible(b) && txt(b) === '下一步');
  });
  const roots = candidates.filter(el => !candidates.some(other => other !== el && other.contains(el)));
  if (roots.length !== 1) return { ok: false, reason: 'numeric-pager-drawer-not-unique', clicked: false };
  const root = roots[0];

  // any visible dialog disjoint from this unique drawer root (an unrelated guide/confirm/
  // ad popup elsewhere on screen) is a blocking overlay; nested dialogs inside the drawer
  // itself are part of it, never a separate blocker
  const otherOverlays = [...document.querySelectorAll(DIALOG_SEL)].filter(visible).filter(el => el !== root && !root.contains(el) && !el.contains(root));
  if (otherOverlays.length > 0) return { ok: false, reason: 'numeric-pager-blocking-overlay-present', clicked: false };

  // "全部" must be the single active tab in this exact drawer
  const { owners, leaf } = scopeTabs(root);
  const active = owners.filter(el => /active|selected|current/i.test(clsOf(el)) || el.getAttribute('aria-selected') === 'true').map(leaf).map(s => s.replace(/\s+/g, ''));
  if (active.length !== 1 || active[0] !== '全部') return { ok: false, reason: 'numeric-pager-category-not-active', clicked: false };

  // the exact ovui pager region proven live this round, scoped strictly to this drawer
  const wrapper = [...root.querySelectorAll('.pagination-wrapper')].filter(visible);
  if (wrapper.length !== 1) return { ok: false, reason: 'numeric-pager-wrapper-not-unique', clicked: false };
  const ovui = [...wrapper[0].querySelectorAll('.ovui-pagination')].filter(visible);
  if (ovui.length !== 1) return { ok: false, reason: 'numeric-pager-ovui-pagination-not-unique', clicked: false };
  const turner = [...ovui[0].querySelectorAll('ul.ovui-page-turner')].filter(visible);
  if (turner.length !== 1) return { ok: false, reason: 'numeric-pager-turner-not-unique', clicked: false };
  const lis = [...turner[0].children].filter(el => el.tagName === 'LI' && /(^|\s)ovui-page-turner__item(\s|$)/.test(clsOf(el)));

  const disabledToken = el => /(^|\s)ovui-page-turner__item--disabled(\s|$)/.test(clsOf(el));

  // exactly one active (current) page li, and its own text must be a plain integer
  const activeLis = lis.filter(el => /(^|\s)ovui-page-turner__item--active(\s|$)/.test(clsOf(el)));
  if (activeLis.length !== 1) return { ok: false, reason: 'numeric-pager-current-page-not-unique', clicked: false };
  const activeText = txt(activeLis[0]);
  if (!/^\d{1,4}$/.test(activeText)) return { ok: false, reason: 'numeric-pager-current-page-not-a-number', clicked: false };
  const currentPage = Number(activeText);

  // exactly one next-icon, and it must belong to one of this turner's own li items
  const nextIconDivs = [...turner[0].querySelectorAll('.ovui-page-turner__next-icon')].filter(visible);
  if (nextIconDivs.length === 0) return { ok: false, reason: 'numeric-pager-no-next-control', clicked: false };
  if (nextIconDivs.length !== 1) return { ok: false, reason: 'numeric-pager-next-control-not-unique', clicked: false };
  const nextLi = nextIconDivs[0].closest('li.ovui-page-turner__item');
  if (!nextLi || lis.indexOf(nextLi) < 0) return { ok: false, reason: 'numeric-pager-next-control-not-a-known-item', clicked: false };

  // prev-icon is informational for 'read'/'next' (frozen common.prevDisabled readback
  // below); ONLY mode 'prev' may ever click it, under its own strict proof block.
  const prevIconDivs = [...turner[0].querySelectorAll('.ovui-page-turner__prev-icon')].filter(visible);
  const prevLi = prevIconDivs.length === 1 ? prevIconDivs[0].closest('li.ovui-page-turner__item') : null;

  // "disabled" is accepted ONLY from exactly one explicit ovui-page-turner__item--disabled
  // class token on the next li itself; an aria-disabled that disagrees with the class token
  // is 'unknown' (a hard stop), never silently read as enabled or as a proven boundary
  const nextDisabledClass = disabledToken(nextLi);
  const nextAriaDisabled = nextLi.getAttribute('aria-disabled') === 'true';
  let nextDisabled;
  if (nextAriaDisabled && !nextDisabledClass) nextDisabled = 'unknown';
  else if (nextDisabledClass) nextDisabled = true;
  else nextDisabled = false;

  // auxiliary readback: the total record text and the largest visible number leaf. NEVER used
  // to derive a total page count or to declare a boundary — only the explicit disabled token can.
  const regionText = txt(wrapper[0]);
  const recordMatch = regionText.match(/共\s*(\d+)\s*条记录/);
  const maxVisiblePageNumber = lis.filter(el => /^\d{1,4}$/.test(txt(el))).map(el => Number(txt(el))).reduce((m, n) => Math.max(m, n), 0) || null;

  // footer + checked cards use the exact same reading rules as drawerSnapshotInPage
  const footer = txt(root).match(/已选\s*(\d+)\s*\/\s*(\d{1,2})/);
  const footerSelectedCount = footer ? Number(footer[1]) : null;
  const footerRemainingCapacity = footer ? Number(footer[2]) : null;
  const cards = [...root.querySelectorAll('.card-container')].filter(visible).map(card => {
    const t = txt(card);
    const m = t.match(/ID\s*[:：]\s*(\d{15,20})/);
    const checks = [...card.querySelectorAll('input[type="checkbox"]')];
    return { id: m ? m[1] : null, checked: checks.length === 1 ? checks[0].checked === true : null };
  });
  const checkedIds = cards.filter(c => c.checked === true && c.id).map(c => String(c.id));

  const selectedIds = Array.isArray(payload.selectedIds) ? payload.selectedIds.map(String) : null;
  if (String(accountId) !== String(payload.accountId)) return { ok: false, reason: 'numeric-pager-account-mismatch', clicked: false };
  if (payload.expectedCurrentPage != null && currentPage !== Number(payload.expectedCurrentPage)) {
    return { ok: false, reason: 'numeric-pager-current-page-mismatch', clicked: false, currentPage };
  }
  if (payload.expectedSelectedCount != null && footerSelectedCount !== Number(payload.expectedSelectedCount)) {
    return { ok: false, reason: 'numeric-pager-footer-selected-count-mismatch', clicked: false, currentPage, footerSelectedCount };
  }
  if (payload.expectedCapacity != null && footerRemainingCapacity !== Number(payload.expectedCapacity)) {
    return { ok: false, reason: 'numeric-pager-footer-capacity-mismatch', clicked: false, currentPage, footerRemainingCapacity };
  }
  if (selectedIds && checkedIds.some(id => !selectedIds.includes(id))) {
    return { ok: false, reason: 'numeric-pager-checked-drift', clicked: false, currentPage, checkedIds };
  }

  const common = { currentPage, nextDisabled: nextDisabled === true, footerSelectedCount, footerRemainingCapacity, checkedIds, accountId, recordCount: recordMatch ? Number(recordMatch[1]) : null, maxVisiblePageNumber, prevDisabled: prevLi ? disabledToken(prevLi) : null };

  if (mode === 'read') return { ok: true, mode: 'read', clicked: false, ...common };

  if (mode === 'prev') {
    // S21 narrow backward step, exact mirror of the frozen 'next' contract: the unique
    // visible prev-icon must belong to one of this turner's own known li items, and
    // "disabled" is accepted ONLY from exactly one explicit ovui-page-turner__item--disabled
    // class token on that li (an aria-disabled disagreeing with the class token is
    // 'unknown' = hard stop, never a boundary and never clickable). Every scope proof above
    // (origin/path/aavid, unique account, unique drawer, no blocking overlay, 全部 active,
    // unique pager chain, unique numeric current page, footer/capacity, checked subset) has
    // already been re-read fresh inside THIS same synchronous evaluate before the click.
    if (prevIconDivs.length === 0) return { ok: false, reason: 'numeric-pager-no-prev-control', clicked: false };
    if (prevIconDivs.length !== 1) return { ok: false, reason: 'numeric-pager-prev-control-not-unique', clicked: false };
    const prevStepLi = prevIconDivs[0].closest('li.ovui-page-turner__item');
    if (!prevStepLi || lis.indexOf(prevStepLi) < 0) return { ok: false, reason: 'numeric-pager-prev-control-not-a-known-item', clicked: false };
    const prevDisabledClass = disabledToken(prevStepLi);
    const prevAriaDisabled = prevStepLi.getAttribute('aria-disabled') === 'true';
    let prevStepDisabled;
    if (prevAriaDisabled && !prevDisabledClass) prevStepDisabled = 'unknown';
    else if (prevDisabledClass) prevStepDisabled = true;
    else prevStepDisabled = false;
    if (prevStepDisabled === 'unknown') return { ok: false, reason: 'numeric-pager-prev-disabled-state-unknown', clicked: false, currentPage };
    if (prevStepDisabled === true) return { ok: true, mode: 'prev', boundary: true, clicked: false, ...common };
    prevStepLi.click();
    return { ok: true, mode: 'prev', clicked: true, ...common };
  }

  if (nextDisabled === 'unknown') return { ok: false, reason: 'numeric-pager-next-disabled-state-unknown', clicked: false, currentPage };
  if (nextDisabled === true) return { ok: true, mode: 'next', boundary: true, clicked: false, ...common };

  nextLi.click();
  return { ok: true, mode: 'next', clicked: true, ...common };
}

// Reads the single native scroll root (.product-list) of the unique product
// drawer. The scroll root is NOT disabled-tab evidence; it only reports the
// native scroll geometry and the accumulated visible card count. Self-contained
// for page.evaluate.
function nativeScrollStateInPage() {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const roots = [...document.querySelectorAll('.product-list')].filter(visible);
  const unique = roots.filter(el => !roots.some(o => o !== el && o.contains(el)));
  if (unique.length !== 1) return { ok: false, reason: 'native-scroll-root-not-unique', count: unique.length };
  const root = unique[0];
  return { ok: true, scrollTop: root.scrollTop || 0, scrollHeight: root.scrollHeight || 0, clientHeight: root.clientHeight || 0, cardCount: [...root.querySelectorAll('.card-container')].filter(visible).length };
}

// Performs exactly one native scroll step toward the bottom of the unique
// .product-list root. It never clicks a business control, never fabricates a
// numeric page, and reports the geometry before/after so the caller can require
// a fresh matching response plus at least one new DOM id before advancing.
// NARROW LAYOUT EXCEPTION (r19/r20/r21 field evidence): when the root is ALREADY at
// the loading edge and its unique direct-last EMPTY native loading sentinel (DIV,
// zero children AND empty textContent, visible via vShow, height 0, marker top exceeds the
// root bottom by 0<gap<1px) is clipped at the crop boundary, the component's own
// IntersectionObserver (root null, threshold 0.8) never reaches ratio>=0.8, so it never
// emits the fetch and progress stalls with hasMore still true. In exactly that verified
// shape we apply a tiny, bounded temporary height/min-height of 5px and then re-scroll to
// the NEW loading edge (the nudge extends scrollHeight; without the second scroll the
// marker stays outside the viewport and the real observer never fires). 5px guarantees
// ratio > 0.8 for every admitted 0<gap<1 after integer scroll-height rounding; the fixed
// 2px r20 value could not (e.g. 0.4375px gap => ratio 0.78125). The CALLER must restore
// it in a finally. Any other structure (no such marker / hidden / non-empty text or
// children / not at the edge / not clipped by <1px) keeps the original pure-scroll
// behavior with zero style change.
function nativeScrollStepInPage() {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const NUDGE_PX = '5px';
  const roots = [...document.querySelectorAll('.product-list')].filter(visible);
  const unique = roots.filter(el => !roots.some(o => o !== el && o.contains(el)));
  if (unique.length !== 1) throw new Error('native-scroll-root-not-unique');
  const root = unique[0];
  const before = { scrollTop: root.scrollTop || 0, scrollHeight: root.scrollHeight || 0, clientHeight: root.clientHeight || 0, cardCount: [...root.querySelectorAll('.card-container')].filter(visible).length };
  // The native loading edge is the deepest offset the root can reach in one
  // action: scrollHeight minus clientHeight. A single clientHeight step stalls
  // short of it whenever the remaining distance exceeds one viewport (e.g.
  // top560/height2460/client670 stops at 1230 instead of 1790), so the next
  // batch never triggers. Advance directly to the loading edge in ONE assignment;
  // this is still a native scroll only — no business click, no numeric page, no
  // network — and the caller still requires a fresh response plus new DOM ids.
  const loadingEdge = Math.max(0, before.scrollHeight - before.clientHeight);
  if (loadingEdge > before.scrollTop) root.scrollTop = loadingEdge;
  let marker = { nudged: false };
  try {
    const atEdge = (root.scrollTop || 0) >= loadingEdge;
    const childEls = [...(root.children || [])];
    const lastEl = childEls.length ? childEls[childEls.length - 1] : null;
    if (atEdge && lastEl && String(lastEl.tagName).toUpperCase() === 'DIV' && (lastEl.children || []).length === 0 && !String(lastEl.textContent || '').trim()) {
      const disp = getComputedStyle(lastEl).display;
      const rootRect = root.getBoundingClientRect();
      const rootBottom = (rootRect.top || 0) + (rootRect.height || 0);
      const mRect = lastEl.getBoundingClientRect();
      const mHeight = mRect.height || 0;
      const gap = (mRect.top || 0) - rootBottom;
      if (disp !== 'none' && mHeight === 0 && gap > 0 && gap < 1) {
        marker = {
          nudged: true,
          previous: {
            height: lastEl.style.getPropertyValue('height'),
            heightPriority: lastEl.style.getPropertyPriority('height'),
            minHeight: lastEl.style.getPropertyValue('min-height'),
            minHeightPriority: lastEl.style.getPropertyPriority('min-height'),
          },
        };
        lastEl.style.setProperty('height', NUDGE_PX, '');
        lastEl.style.setProperty('min-height', NUDGE_PX, '');
        // The nudge extends the scroll content, so the loading edge moved DOWN: re-scroll
        // to the NEW scrollHeight-clientHeight, otherwise the marker stays outside the
        // cropped viewport and the real IntersectionObserver never fires.
        const nudgedEdge = Math.max(0, (root.scrollHeight || 0) - (root.clientHeight || 0));
        if (nudgedEdge > (root.scrollTop || 0)) root.scrollTop = nudgedEdge;
      }
    }
  } catch (_) { /* unknown marker shape: never manipulate, keep the pure scroll */ }
  const finalEdge = marker.nudged ? Math.max(0, (root.scrollHeight || 0) - (root.clientHeight || 0)) : loadingEdge;
  return { ok: true, before, after: { scrollTop: root.scrollTop || 0, loadingEdge: finalEdge }, marker };
}

// Restore a marker nudged by nativeScrollStepInPage. The ONLY accepted target is the
// root's unique direct-last empty sentinel (DIV, zero children, empty textContent) whose
// inline height AND min-height equal the exact NUDGE value this round applied. It never
// pops an arbitrary same-style node from elsewhere in the root. When the target matches,
// ONLY height/min-height and their priorities revert to the caller-supplied previous
// values (removing the property when it was previously absent); the whole style attribute
// is never rewritten, so a later Vue vShow display:none / hasMore=false and every other
// inline property are preserved. If the token is not present (never nudged / shape
// changed) it does nothing and reports restored:false.
function restoreNativeMarkerNudgeInPage(previous) {
  const NUDGE_PX = '5px';
  const roots = [...document.querySelectorAll('.product-list')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; });
  const unique = roots.filter(el => !roots.some(o => o !== el && o.contains(el)));
  if (unique.length !== 1) return { restored: false, reason: 'native-scroll-root-not-unique' };
  const root = unique[0];
  const childEls = [...(root.children || [])];
  const marker = childEls.length ? childEls[childEls.length - 1] : null;
  const isNudgedSentinel = !!marker && String(marker.tagName).toUpperCase() === 'DIV'
    && (marker.children || []).length === 0 && !String(marker.textContent || '').trim()
    && marker.style.getPropertyValue('height') === NUDGE_PX && marker.style.getPropertyValue('min-height') === NUDGE_PX;
  if (!isNudgedSentinel) return { restored: false, reason: 'native-marker-token-absent' };
  const prev = previous || {};
  const apply = (prop, value, priority) => { if (!value) marker.style.removeProperty(prop); else marker.style.setProperty(prop, value, priority || ''); };
  apply('height', prev.height, prev.heightPriority);
  apply('min-height', prev.minHeight, prev.minHeightPriority);
  return { restored: true };
}

function clickDrawerTabInPage(name) {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const txt = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const norm = x => String(x).replace(/\s+/g, '').replace(/流量扶持/g, '');
  const TAB_SEL = '[class*="product-drawer-header-tab-item"],[class*="ovui-tabs__tab"]';
  const leafLabel = (e, els) => { const desc = els.filter(x => x !== e && e.contains(x)); if (!desc.length) return txt(e); const deepest = desc.filter(d => !desc.some(o => o !== d && d.contains(o))); return txt(deepest[0]); };
  const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]')].filter(visible);
  const roots = dialogs.filter(el => {
    const t = (el.innerText || el.textContent || '').replace(/\s+/g, ' ');
    const els = [...el.querySelectorAll(TAB_SEL)].filter(visible);
    const owners = els.filter(e => !els.some(o => o !== e && o.contains(e)));
    const labels = owners.map(e => norm(leafLabel(e, els)));
    const has = x => labels.includes(x) || (x === '搜索趋势' && labels.includes('搜索趋势推荐'));
    return !/为商品添加抖音号/.test(t) && has('全部') && has('店铺新品') && has('破圈尖货') && has('搜索趋势') && /已选\s*\d+\s*\/\s*\d+/.test(t);
  }).filter(el => !dialogs.some(other => other !== el && other.contains(el)));
  if (roots.length !== 1) throw new Error('product-drawer-not-unique');
  const drawer = roots[0];
  const tabAll = [...drawer.querySelectorAll(TAB_SEL)];
  const target = norm(name);
  const candidates = tabAll.filter(e => norm(leafLabel(e, tabAll)) === target || (target === '搜索趋势' && norm(leafLabel(e, tabAll)) === '搜索趋势推荐'));
  const owners = candidates.filter(e => !candidates.some(o => o !== e && o.contains(e)));
  if (owners.length !== 1) throw new Error('category-tab-not-unique:' + name);
  const owner = owners[0];
  if (!visible(owner)) throw new Error('category-tab-not-visible:' + name);
  const tokens = c => String(c == null ? '' : c).split(/\s+/);
  const ownerTokens = tokens(owner.className);
  if (ownerTokens.includes('ovui-tabs__tab-btn') && !ownerTokens.includes('ovui-tabs__tab')) {
    for (let p = owner.parentElement; p && p !== drawer; p = p.parentElement) if (tokens(p.className).includes('ovui-tabs__tab')) throw new Error('category-tab-owner-unknown:' + name);
  }
  const DISABLED_EXACT_TOKENS = ['ovui-tabs__tab--disabled', 'is-disabled', 'disabled'];
  for (let p = owner; p; p = p.parentElement) {
    // Real disabled evidence only: native disabled, inherited aria-disabled, or an
    // exact disabled token. Scroll-edge classes such as
    // ovui-tabs__nav-list-scroll-container--disabled-left must not match here.
    if (p.disabled === true || p.getAttribute('aria-disabled') === 'true' || tokens(p.className).some(t => DISABLED_EXACT_TOKENS.indexOf(t) !== -1)) throw new Error('category-tab-disabled:' + name);
    if (p === drawer) break;
  }
  const before = owner.getAttribute('aria-selected') === 'true' || /active|selected|current/i.test(String(owner.className || ''));
  if (!before) owner.click();
  return { clicked: !before, alreadyActive: before };
}

function selectNativeCardInPage(productId) {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const txt = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]')].filter(visible);
  const roots = dialogs.filter(el => /全部/.test(txt(el)) && /已选\s*\d+\s*\/\s*\d+/.test(txt(el)) && !/为商品添加抖音号/.test(txt(el))).filter(el => !dialogs.some(o => o !== el && o.contains(el)));
  if (roots.length !== 1) throw new Error('product-drawer-not-unique');
  const cards = [...roots[0].querySelectorAll('.card-container')].filter(visible).filter(c => {
    const m = txt(c).match(/ID\s*[:：]\s*(\d{15,20})/);
    return m && m[1] === String(productId);
  });
  if (cards.length !== 1) throw new Error('product-card-not-unique:' + productId);
  const card = cards[0];
  if (card.getAttribute('aria-disabled') === 'true' || card.querySelector('.card-product-item--disabled,[aria-disabled="true"],[disabled]')) throw new Error('product-card-disabled:' + productId);
  const inputs = [...card.querySelectorAll('input[type="checkbox"]')];
  if (inputs.length !== 1 || inputs[0].disabled) throw new Error('native-product-checkbox-not-unique:' + productId);
  const input = inputs[0];
  if (input.checked === true) return { id: String(productId), clicked: false, checkedNow: true, alreadyChecked: true };
  const labels = [...card.querySelectorAll('label')].filter(visible).filter(l => l.contains(input));
  if (labels.length === 1) labels[0].click(); else input.click();
  // The click is a single native label/input action only. A controlled checkbox
  // updates asynchronously and the input node may be re-rendered, so this evaluate
  // MUST NOT read the cached input.checked to decide success (that threw the old
  // product-checkbox-readback-failed before the UI landed). The caller performs a
  // bounded FRESH re-read on the latest node and footer count to confirm.
  return { id: String(productId), clicked: true, checkedNow: input.checked === true, pending: input.checked !== true };
}

function deselectNativeCardInPage(productId) {
  const visible = e => { const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'; };
  const txt = e => (e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  const roots=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]')].filter(visible).filter(el=>/全部/.test(txt(el))&&/已选\s*\d+\s*\/\s*\d+/.test(txt(el))&&!/为商品添加抖音号/.test(txt(el)));
  const drawers=roots.filter(el=>!roots.some(o=>o!==el&&o.contains(el)));
  if(drawers.length!==1)throw new Error('product-drawer-not-unique');
  const cards=[...drawers[0].querySelectorAll('.card-container')].filter(visible).filter(c=>{const m=txt(c).match(/ID\s*[:：]\s*(\d{15,20})/);return m&&m[1]===String(productId);});
  if(cards.length!==1)throw new Error('product-card-not-unique:'+productId);
  const checks=[...cards[0].querySelectorAll('input[type="checkbox"]')];
  if(checks.length!==1||checks[0].disabled)throw new Error('native-product-checkbox-not-unique:'+productId);
  if(!checks[0].checked) return {id:String(productId),clicked:false,checkedNow:false,alreadyUnchecked:true};
  const labels=[...cards[0].querySelectorAll('label')].filter(visible).filter(l=>l.contains(checks[0]));if(labels.length===1)labels[0].click();else checks[0].click();
  // Single native toggle only; the caller confirms the unchecked landing with a
  // bounded fresh re-read. Never reverse-toggle here, never trust the cached value.
  return {id:String(productId),clicked:true,checkedNow:checks[0].checked===true,pending:checks[0].checked===true};
}

// Self-contained draft-removal identity gate, inlined into each page.evaluate callback
// (a serialized callback can never reference a module helper). The real creation-page
// header .qc-page-navigator-container may be ABSENT, so fall back to the narrowest live
// account navigator (.qc-navigator-account) with a single proven id; URL/route alone is
// never treated as account confirmation.
function removeNativeCardInPage(input) {
  // Self-contained: `input` is either the legacy bare product id string (old
  // tests / calls) or {productId, accountId} from the generic per-shop driver.
  const productId = (input && typeof input === 'object') ? String(input.productId) : String(input);
  if (location.origin !== 'https://qianchuan.jinritemai.com' || !/^\/uni-creation\/overall-product-multi\/?$/.test(location.pathname)) throw new Error('draft-remove-not-authorized-creation-route');
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const txt = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const ACCOUNT=(input && typeof input === 'object' && input.accountId) ? String(input.accountId) : '1710242295996424';
  {
    const aavids=new URLSearchParams(String((typeof location!=='undefined'&&location.search)||'')).getAll('aavid');
    if(aavids.length!==1||aavids[0]!==ACCOUNT) throw new Error('draft-remove-account-identity-unknown');
    const idsOf=els=>new Set(els.flatMap(n=>[...txt(n).matchAll(/ID\s*[:：]\s*(\d{8,20})/g)].map(m=>m[1])));
    const legacy=[...document.querySelectorAll('.qc-page-navigator-container')].filter(visible);
    // The narrow .qc-navigator-account fallback is used ONLY when the legacy container is
    // entirely ABSENT. A present-but-conflicting / multiple legacy header must never be
    // overridden by a matching narrow nav (that would let a wrong account pass).
    if(legacy.length===0){
      const navs=[...document.querySelectorAll('.qc-navigator-account')].filter(visible);
      const ids=idsOf(navs);
      if(navs.length!==1||ids.size!==1||[...ids][0]!==ACCOUNT) throw new Error('draft-remove-account-identity-unknown');
    } else {
      const ids=idsOf(legacy);
      if(legacy.length!==1||ids.size!==1||[...ids][0]!==ACCOUNT) throw new Error('draft-remove-account-identity-unknown');
    }
  }
  const roots = [...document.querySelectorAll('table,[role="table"],[role="grid"],[class*="table"],[class*="Table"]')].filter(visible).filter(el => {
    const t = txt(el); return ['商品信息', '投放抖音号', '素材', '操作'].every(h => t.includes(h));
  });
  const scored = roots.map(el => ({ el, rows: [...el.querySelectorAll('tr,[role="row"],.ovui-table__row')].filter(visible).filter(r => /ID\s*[:：]\s*\d{15,20}/.test(txt(r))).length }));
  const max = Math.max(0, ...scored.map(x => x.rows));
  const best = scored.filter(x => x.rows === max).filter(x => !scored.some(y => y !== x && y.rows === max && x.el.contains(y.el)));
  if (best.length !== 1) throw new Error('creation-table-not-unique');
  const rows = [...best[0].el.querySelectorAll('tr,[role="row"],.ovui-table__row')].filter(visible).filter(r => {
    const ids = [...txt(r).matchAll(/ID\s*[:：]\s*(\d{15,20})/g)].map(m => m[1]); return ids.length === 1 && ids[0] === String(productId);
  });
  if (rows.length !== 1) throw new Error('creation-row-not-unique:' + productId);
  const buttons = [...rows[0].querySelectorAll('button,[role="button"],a')].filter(visible).filter(b => txt(b) === '删除');
  if (buttons.length !== 1) throw new Error('draft-remove-control-not-unique:' + productId);
  buttons[0].click();
  // Contract frozen by plan-workflow.test.cjs: exactly {clicked, productId}. A non-throwing return
  // IS the narrow in-row deletion proof -- it was reached only after re-verifying the authorized
  // creation route, the exact account identity, a UNIQUE table, the UNIQUE target draft row for
  // THIS productId, and a UNIQUE 删除 control that was then clicked once. repairDraft turns that
  // proven success into the removeProof it forwards to confirmDraftRemovalInPage.
  return { clicked: true, productId: String(productId) };
}

function confirmDraftRemovalInPage(input) {
  const productId = (input && typeof input === 'object') ? String(input.productId) : String(input);
  if (location.origin !== 'https://qianchuan.jinritemai.com' || !/^\/uni-creation\/overall-product-multi\/?$/.test(location.pathname)) throw new Error('draft-remove-confirm-not-authorized-creation-route');
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const txt = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const ACCOUNT=(input && typeof input === 'object' && input.accountId) ? String(input.accountId) : '1710242295996424';
  {
    const aavids=new URLSearchParams(String((typeof location!=='undefined'&&location.search)||'')).getAll('aavid');
    if(aavids.length!==1||aavids[0]!==ACCOUNT) throw new Error('draft-remove-confirm-account-identity-unknown');
    const idsOf=els=>new Set(els.flatMap(n=>[...txt(n).matchAll(/ID\s*[:：]\s*(\d{8,20})/g)].map(m=>m[1])));
    const legacy=[...document.querySelectorAll('.qc-page-navigator-container')].filter(visible);
    if(legacy.length===0){
      const navs=[...document.querySelectorAll('.qc-navigator-account')].filter(visible);
      const ids=idsOf(navs);
      if(navs.length!==1||ids.size!==1||[...ids][0]!==ACCOUNT) throw new Error('draft-remove-confirm-account-identity-unknown');
    } else {
      const ids=idsOf(legacy);
      if(legacy.length!==1||ids.size!==1||[...ids][0]!==ACCOUNT) throw new Error('draft-remove-confirm-account-identity-unknown');
    }
  }
  // A draft row 删除 removes the row IMMEDIATELY with no confirmation on the real page. We
  // never demand the removed row still exist. Only a deletion-confirm dialog naming the exact
  // product is clicked (once). A real draft removal success requires the target row to be
  // genuinely ABSENT AND no OTHER modal open: any present-but-unrecognised modal is an
  // unknown-dialog stop with ZERO confirm (never reported as noDialog success).
  const sel='[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="modal"],[class*="Modal"]';
  const allVisible=[...document.querySelectorAll(sel)].filter(visible);
  const rootsOf=arr=>arr.filter(el=>!arr.some(o=>o!==el&&o.contains(el)));
  const rowExists=id=>[...document.querySelectorAll('tr,[role="row"],.ovui-table__row')].filter(visible).some(r=>{const rid=[...txt(r).matchAll(/ID\s*[:：]\s*(\d{15,20})/g)].map(m=>m[1]);return rid.length===1&&rid[0]===String(id);});
  // 有界脱敏现场诊断（随原 Error 文本携带）：只读描述可见模态根的 tag/class/role、短文本、
  // 可见按钮，以及目标草稿行是否仍在。无 Cookie/HTML 全页/网络/存储；≥8 位数字掩码；
  // 顶层根至多 3 个、按钮至多 3 个、总长 ≤400 字符。识别 token 与零点击/停止语义不变。
  const scrub=t=>String(t==null?'':t).replace(/\s+/g,' ').replace(/\d{8,}/g,'***').trim().slice(0,80);
  const sceneOf=(els,id)=>{
    const scene={ modalCount:els.length, modals:rootsOf(els).slice(0,3).map(el=>({
      tag:String(el.tagName||'').toLowerCase().slice(0,16),
      cls:scrub((el.getAttribute&&el.getAttribute('class'))||'').slice(0,64),
      role:scrub((el.getAttribute&&el.getAttribute('role'))||'').slice(0,16),
      text:scrub(txt(el)),
      buttons:[...(el.querySelectorAll?el.querySelectorAll('button,[role="button"],a'):[])].filter(visible).slice(0,3).map(b=>scrub(txt(b)).slice(0,24))
    })), targetRowPresent:rowExists(id) };
    let s; try { s=JSON.stringify(scene); } catch(_) { s='{"modalCount":'+els.length+'}'; }
    return String(s||'').slice(0,400);
  };
  const del=allVisible.filter(d=>txt(d).includes(String(productId))&&/删除|移除/.test(txt(d)));
  const delRoots=rootsOf(del);
  if(delRoots.length===1){
    const buttons=[...delRoots[0].querySelectorAll('button,[role="button"]')].filter(visible).filter(b=>['确定','删除','移除'].includes(txt(b)));
    if(buttons.length!==1) throw new Error('draft-remove-confirm-not-unique');
    buttons[0].click();
    return { confirmed: true };
  }
  if(delRoots.length>1) throw new Error('draft-remove-dialog-not-unique');
  // Known creation-page draft-removal confirm that does NOT restate the product id
  // (real 瑾漂亮 platform): root div.ovui-modal__wrap.oc-modal-wrap, title "确定要删除商品吗？",
  // body "删除商品时，已添加的抖音号、素材将同步被清空", buttons 取消 / 确认. Because the id-bearing
  // `del` path above cannot match it, it is recognized by exact title+body and clicked ONLY when:
  //   (a) exactly one such known root exists AND it is the SOLE visible modal root (no other/多根),
  //   (b) the caller supplied a fresh narrow in-row deletion proof from removeNativeCardInPage tying
  //       it to THIS product/account on the authorized creation route (route re-verified live above),
  //   (c) a SINGLE enabled 确认 control exists (取消 ignored; disabled/多确认 refuse).
  // Anything else = zero-confirm refuse. A stray manager-page ad-delete has neither the creation
  // route (guarded above) nor the proof, so it can never be blind-confirmed on title alone.
  const KNOWN_DRAFT_TITLE='确定要删除商品吗？';
  const KNOWN_DRAFT_BODY='删除商品时，已添加的抖音号、素材将同步被清空';
  const clsOf=el=>String((el.getAttribute&&el.getAttribute('class'))||el.className||'');
  const isDisabled=el=>el.disabled===true||(el.getAttribute&&el.getAttribute('aria-disabled')==='true')||/disabled/i.test(clsOf(el));
  const allRoots=rootsOf(allVisible);
  const knownRoots=allRoots.filter(el=>{const t=txt(el);return t.includes(KNOWN_DRAFT_TITLE)&&t.includes(KNOWN_DRAFT_BODY);});
  if(knownRoots.length>0){
    if(knownRoots.length!==1||allRoots.length!==1) throw new Error('draft-remove-known-modal-not-unique');
    const proof=(input&&typeof input==='object')?input.removeProof:null;
    const proofOk=!!proof&&typeof proof==='object'&&proof.rowProof===true
      &&String(proof.productId)===String(productId)&&String(proof.accountId)===String(ACCOUNT)
      &&proof.route==='uni-creation/overall-product-multi';
    if(!proofOk) throw new Error('draft-remove-known-modal-unproven');
    const confirms=[...knownRoots[0].querySelectorAll('button,[role="button"]')].filter(visible).filter(b=>txt(b)==='确认'&&!isDisabled(b));
    if(confirms.length!==1) throw new Error('draft-remove-confirm-not-unique');
    confirms[0].click();
    return { confirmed: true, known: true };
  }
  if(allVisible.length>0) throw new Error('draft-remove-unknown-modal ' + sceneOf(allVisible, productId));
  const rowStill=rowExists(productId);
  if(rowStill) throw new Error('draft-remove-row-still-present');
  return { noDialog: true };
}

function bindingDrawerSnapshotInPage() {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const txt = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  // A real ovui checkbox may be blocked by an ancestor label carrying the
  // ovui-checkbox--disabled class even when the cached input.disabled is false,
  // so disabled evidence is read from the label/ancestor chain, never the input.
  const disabledEl = el => {
    for (let n = el; n; n = n.parentElement) {
      const cn = typeof n.className === 'string' ? n.className : ((n.getAttribute && n.getAttribute('class')) || '');
      if (/\bovui-checkbox--disabled\b/.test(String(cn))) return true;
      if (n.getAttribute && n.getAttribute('aria-disabled') === 'true') return true;
      if (n.disabled === true) return true;
    }
    return false;
  };
  const dialogs = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]')].filter(visible).filter(e => /为商品添加抖音号/.test(txt(e)));
  const roots = dialogs.filter(el => !dialogs.some(o => o !== el && o.contains(el)));
  if (roots.length !== 1) return { ok: false, reason: 'account-drawer-not-unique', count: roots.length };
  const root = roots[0];
  const rows = [...root.querySelectorAll('tr,[role="row"],.ovui-table__row')].filter(visible).filter(row => !row.closest('thead') && !row.querySelector('th')).map(row => {
    const text = txt(row);
    const accountIds = [...text.matchAll(/ID\s*[:：]?\s*([A-Za-z0-9_-]{8,32})/g)].map(m => m[1]);
    const checks = [...row.querySelectorAll('input[type="checkbox"]')].filter(visible);
    const label = checks.length === 1 ? checks[0].closest('label') : null;
    return { text: text.slice(0,300), ids: accountIds, checked: checks.length === 1 ? checks[0].checked === true : null, labelDisabled: label ? disabledEl(label) : null };
  }).filter(r => r.ids.length > 0);
  const headers = [...root.querySelectorAll('thead label.ovui-checkbox,th label.ovui-checkbox,[class*="table-header"] label.ovui-checkbox')].filter(visible);
  const footer = txt(root).match(/当前商品已选\s*[：:]?\s*(\d+)\s*\/\s*(\d+)/);
  // The batch action is a real BUTTON, not a checkbox: clicking it opens a separate
  // confirm modal. Report it as a button so the driver never fakes a checkbox path.
  const batchBtns = [...root.querySelectorAll('button,[role="button"]')].filter(visible).filter(b => txt(b) === '将所选抖音号批量添加至所有商品');
  const batchEnabled = batchBtns.length === 1 ? (batchBtns[0].disabled !== true && batchBtns[0].getAttribute('aria-disabled') !== 'true') : null;
  const buttons = [...root.querySelectorAll('button')].filter(visible).filter(b => txt(b) === '确定');
  // The drawer's left product list is a set of .panel nodes, each carrying the product id in its
  // id attribute; exactly one carries the "active" class and its accounts are what the row table
  // above reflects. Report the ordered panel ids and the unique active id so the driver can prove
  // WHICH product is the batch anchor (never assume the first). className string token match only
  // (no classList), so the read stays valid in the offline DOM harness too.
  const panelEls = [...root.querySelectorAll('.panel')].filter(visible);
  const panelId = el => String((el.getAttribute && el.getAttribute('id')) || '');
  const panelProductIds = panelEls.map(panelId).filter(id => /^\d{15,20}$/.test(id));
  const activeProductIds = panelEls
    .filter(el => String(el.className || '').split(/\s+/).includes('active'))
    .map(panelId).filter(id => /^\d{15,20}$/.test(id));
  return { ok: true, rows, headerSelectAllCount: headers.length, headerLabelDisabled: headers.length === 1 ? disabledEl(headers[0]) : null, selectedCount: footer ? Number(footer[1]) : null, totalCount: footer ? Number(footer[2]) : null, batchButtonCount: batchBtns.length, batchEnabled, confirmButtonCount: buttons.length, panelProductIds, activeProductIds };
}

// True only when the freshest binding snapshot shows a valid unique 1..2 (R32 min-1)
// target set: each row carries a single unique id that is one of expectedIds when
// expectedIds is a non-empty set (legacy / already-resolved shop) and otherwise is
// any unique row (a generic shop DISCOVERING its real bindable accounts), every row
// reads a DEFINITE checkbox state (checked===true or checked===false; an unknown
// checkbox — zero or multiple visible inputs — reads checked=null and is a hard
// reject), at least one row is actually checked, and the footer 已选 equals the
// checked-row count of 30. R33 (live one-of-two, fixtures/live-one-of-two-binding-r33.json):
// the operator permits binding >=1 of the displayed targets, so a settled drawer may
// legitimately show a checked subset (1 or 2) whose remaining target row is DEFINITELY
// unchecked and still ENABLED (available but intentionally not bound). The footer-match
// gate below is what ties 已选 to the real checked count, so this is NOT read as an
// unsettled partial and a fake selected2/footer2 can never pass. This is the identity
// gate re-applied at every bounded wait and the final judgment, so a row id that changes
// while the header/batch checkbox is landing cannot submit.
function bindingAccountsSnapshotSettled(snap, expectedIds, productsPerPlan) {
  const cap = Number.isInteger(productsPerPlan) ? productsPerPlan : 30;
  if (!snap || snap.ok !== true) return false;
  if (!Array.isArray(snap.rows) || snap.rows.length < 1 || snap.rows.length > 2) return false;
  if (snap.rows.some(r => !Array.isArray(r.ids) || r.ids.length !== 1)) return false;
  const ids = snap.rows.map(r => String(r.ids[0]));
  if (new Set(ids).size !== ids.length) return false;
  // Discovery mode: a generic shop that started with NO configured targets adopts
  // the drawer's OWN unique 1..2 checked rows as the frozen set, so an empty/absent
  // expectedIds means "any unique checked row is acceptable", never the legacy pair.
  // A non-empty expectedIds stays a strict membership gate (legacy + already-resolved
  // shops), so a foreign/duplicate row can never be accepted.
  const exp = (expectedIds || []).map(String);
  if (exp.length && !ids.every(id => exp.includes(id))) return false;
  const checked = snap.rows.filter(r => r.checked === true).length;
  if (checked < 1) return false;
  if (snap.rows.some(r => r.checked !== true && r.checked !== false)) return false;
  if (snap.selectedCount !== checked || snap.totalCount !== cap) return false;
  return true;
}

function selectAllAccountsInPage(payload) {
  // Optional payload {targets:[...]} carries the per-shop approved target ids;
  // legacy no-arg calls keep the frozen default two. A generic shop that has not
  // resolved its targets yet passes {targets:null, discovery:true}: the header
  // select-all then selects the shop's OWN available rows (unique 1..2, at least one
  // enabled/checkable) with NO fixed membership restriction — the caller freezes the
  // exact rows this single action checked and never clicks 联盟自动投.
  const DISCOVERY = !!(payload && payload.discovery === true);
  const TARGET = (payload && Array.isArray(payload.targets) && payload.targets.length) ? payload.targets.map(String) : ['79863866', '9zmao_fushi'];
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const disabledEl = el => { for (let n = el; n; n = n.parentElement) { const cn = typeof n.className === 'string' ? n.className : ((n.getAttribute && n.getAttribute('class')) || ''); if (/\bovui-checkbox--disabled\b/.test(String(cn))) return true; if (n.getAttribute && n.getAttribute('aria-disabled') === 'true') return true; if (n.disabled === true) return true; } return false; };
  const roots = [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]')].filter(visible).filter(e => /为商品添加抖音号/.test((e.innerText || e.textContent || '').replace(/\s+/g,' ')));
  const dialogs = roots.filter(el => !roots.some(o => o !== el && o.contains(el)));
  if (dialogs.length !== 1) throw new Error('account-drawer-not-unique');
  const labels = [...dialogs[0].querySelectorAll('thead label.ovui-checkbox,th label.ovui-checkbox,[class*="table-header"] label.ovui-checkbox')].filter(visible);
  if (labels.length !== 1) throw new Error('native-account-header-label-not-unique');
  const input = labels[0].querySelector('input[type="checkbox"]');
  if (!input) throw new Error('native-account-header-input-missing');
  // The header label may be blocked by an ovui-checkbox--disabled ancestor even when the
  // cached input.disabled reads false; that is a hard stop with ZERO clicks, never a
  // per-account fallback.
  for (let n = labels[0]; n; n = n.parentElement) {
    const cn = typeof n.className === 'string' ? n.className : ((n.getAttribute && n.getAttribute('class')) || '');
    if (/\bovui-checkbox--disabled\b/.test(String(cn))) throw new Error('native-account-header-label-disabled');
    if (n.getAttribute && n.getAttribute('aria-disabled') === 'true') throw new Error('native-account-header-label-disabled');
  }
  const state = [...dialogs[0].querySelectorAll('tr,[role="row"],.ovui-table__row')].filter(visible).filter(row => !row.closest('thead') && !row.querySelector('th')).map(row => {
    const t = (row.innerText || row.textContent || '').replace(/\s+/g,' ');
    const ids = [...t.matchAll(/ID\s*[:：]?\s*([A-Za-z0-9_-]{8,32})/g)].map(m=>m[1]);
    const c = [...row.querySelectorAll('input[type="checkbox"]')].filter(visible);
    return { ids, checked: c.length===1 && c[0].checked===true, labelDisabled: c.length===1 ? disabledEl(c[0]) : false };
  }).filter(x=>x.ids.length>0);
  const allIds=state.flatMap(x=>x.ids);
  // Identity scope stays strict (R32): rows may only carry approved target ids — a
  // 1-or-2 unique subset — so one unavailable target still allows selecting the
  // remaining available one in a single header action.
  if (state.length < 1 || state.length > 2 || state.some(x=>x.ids.length!==1) || new Set(allIds).size !== state.length || (!DISCOVERY && !allIds.every(id=>TARGET.includes(id)))) throw new Error('account-drawer-does-not-show-exact-target-rows');
  if (state.every(x=>x.checked===true||x.labelDisabled===true) && state.some(x=>x.checked===true)) {
    if (state.every(x=>x.checked) && input.checked !== true) throw new Error('header-select-all-state-conflicts-with-account-rows');
    return { alreadyChecked: true };
  }
  if (state.some(x=>x.checked) || input.checked === true) throw new Error('partial-account-selection-state-unknown');
  // A real ovui checkbox may be blocked by a LABEL ovui-checkbox--disabled ancestor even
  // while the INPUT.disabled reads false and the header itself is enabled. A header click
  // only toggles the ENABLED rows, so with at least one enabled unchecked row it selects
  // the remaining available targets in ONE action (R32 min-1). When EVERY unchecked row is
  // disabled there is nothing to select: hard stop with ZERO header clicks; the driver
  // reuses a proven bound anchor instead.
  if (state.every(x=>x.labelDisabled===true)) throw new Error('native-account-rows-label-disabled');
  {
    labels[0].click();
  }
  return { clicked: true };
}

// Drawer identity gate used (inlined per callback) by every batch/commit evaluate: a
// page.evaluate callback is serialized alone and can never reference a module helper, so
// this logic is embedded directly in each self-contained callback below.
//
// Click the batch BUTTON once. Real drawer uses a button (将所选抖音号批量添加至所有商品),
// NOT a checkbox: clicking it opens a separate confirm modal. Identity is re-verified on
// the freshest node before the click; any drift/unknown/disabled button => zero click.
function applyBatchAccountsInPage(payload) {
  const TARGET=(payload&&Array.isArray(payload.targets)&&payload.targets.length)?payload.targets.map(String):['79863866','9zmao_fushi'];
  const visible = e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'; };
  const txt = e => (e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  const isDisabled = el => { for (let n=el;n;n=n.parentElement){ const cn=typeof n.className==='string'?n.className:((n.getAttribute&&n.getAttribute('class'))||''); if(/\bovui-checkbox--disabled\b/.test(String(cn)))return true; if(n.getAttribute&&n.getAttribute('aria-disabled')==='true')return true; if(n.disabled===true)return true; } return false; };
  const drawerSettled = drawer => {
    const rows=[...drawer.querySelectorAll('tr,[role="row"],.ovui-table__row')].filter(visible).filter(row=>!row.closest('thead')&&!row.querySelector('th')).map(row=>{
      const t=txt(row);
      const ids=[...t.matchAll(/ID\s*[:：]?\s*([A-Za-z0-9_-]{8,32})/g)].map(m=>m[1]);
      const checks=[...row.querySelectorAll('input[type="checkbox"]')].filter(visible);
      return {ids,checked:checks.length===1&&checks[0].checked===true,labelDisabled:checks.length===1?isDisabled(checks[0]):null};
    }).filter(r=>r.ids.length>0);
    const footer=txt(drawer).match(/当前商品已选\s*[：:]?\s*(\d+)\s*\/\s*(\d+)/);
    const allIds=rows.flatMap(r=>r.ids);
    const checkedN=rows.filter(r=>r.checked===true).length;
    return rows.length>=1&&rows.length<=2&&rows.every(r=>r.ids.length===1&&(r.checked===true||r.labelDisabled!==null))&&checkedN>=1&&new Set(allIds).size===rows.length&&allIds.every(id=>TARGET.includes(id))&&!!footer&&Number(footer[1])===checkedN&&Number(footer[2])===30;
  };
  const roots=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]')].filter(visible).filter(e=>/为商品添加抖音号/.test(txt(e)));
  const dialogs=roots.filter(el=>!roots.some(o=>o!==el&&o.contains(el)));
  if(dialogs.length!==1) throw new Error('account-drawer-not-unique');
  const drawer=dialogs[0];
  if(!drawerSettled(drawer)) throw new Error('batch-apply-accounts-not-settled');
  const btns=[...drawer.querySelectorAll('button,[role="button"]')].filter(visible).filter(b=>txt(b)==='将所选抖音号批量添加至所有商品');
  if(btns.length!==1) throw new Error('batch-apply-button-not-unique');
  if(btns[0].disabled===true||btns[0].getAttribute('aria-disabled')==='true'||btns[0].closest('[aria-disabled="true"],[disabled]')) throw new Error('batch-apply-button-disabled');
  btns[0].click();
  return {clicked:true};
}

// Combined read of the SEPARATE batch confirm modal plus the drawer identity behind it.
// Used as the bounded fresh-read gate before the modal 确定. Self-contained.
function batchAddAllModalSnapshotInPage(payload) {
  const TARGET=(payload&&Array.isArray(payload.targets)&&payload.targets.length)?payload.targets.map(String):['79863866','9zmao_fushi'];
  const visible = e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'; };
  const txt = e => (e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  const sel='[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="modal"],[class*="Modal"],[class*="drawer"],[class*="Drawer"]';
  const all=[...document.querySelectorAll(sel)].filter(visible);
  const mRoots=all.filter(e=>/确定要添加至所有商品/.test(txt(e)));
  const modals=mRoots.filter(el=>!mRoots.some(o=>o!==el&&o.contains(el)));
  const dRoots=all.filter(e=>/为商品添加抖音号/.test(txt(e)));
  const drawers=dRoots.filter(el=>!dRoots.some(o=>o!==el&&o.contains(el)));
  let productCount=null,accountCount=null,drawerSettled=false;
  if(modals.length===1){const t=txt(modals[0]);const p=t.match(/将在\s*(\d+)\s*个商品/);const a=t.match(/添加\s*(\d+)\s*个抖音号/);productCount=p?Number(p[1]):null;accountCount=a?Number(a[1]):null;}
  if(drawers.length===1){
    const isDisabled = el => { for (let n=el;n;n=n.parentElement){ const cn=typeof n.className==='string'?n.className:((n.getAttribute&&n.getAttribute('class'))||''); if(/\bovui-checkbox--disabled\b/.test(String(cn)))return true; if(n.getAttribute&&n.getAttribute('aria-disabled')==='true')return true; if(n.disabled===true)return true; } return false; };
    const d=drawers[0];
    const rows=[...d.querySelectorAll('tr,[role="row"],.ovui-table__row')].filter(visible).filter(row=>!row.closest('thead')&&!row.querySelector('th')).map(row=>{const tt=txt(row);const ids=[...tt.matchAll(/ID\s*[:：]?\s*([A-Za-z0-9_-]{8,32})/g)].map(m=>m[1]);const checks=[...row.querySelectorAll('input[type="checkbox"]')].filter(visible);return {ids,checked:checks.length===1&&checks[0].checked===true,labelDisabled:checks.length===1?isDisabled(checks[0]):null};}).filter(r=>r.ids.length>0);
    const footer=txt(d).match(/当前商品已选\s*[：:]?\s*(\d+)\s*\/\s*(\d+)/);
    const allIds=rows.flatMap(r=>r.ids);
    const checkedN=rows.filter(r=>r.checked===true).length;
    drawerSettled=rows.length>=1&&rows.length<=2&&rows.every(r=>r.ids.length===1&&(r.checked===true||r.labelDisabled!==null))&&checkedN>=1&&new Set(allIds).size===rows.length&&allIds.every(id=>TARGET.includes(id))&&!!footer&&Number(footer[1])===checkedN&&Number(footer[2])===30;
  }
  return {ok:true, modalCount:modals.length, productCount, accountCount, drawerSettled};
}

// Click the batch confirm modal's 确定 exactly once, only after re-verifying the modal's
// declared product count (30 minus the anchor), its two-account text, AND the freshest
// drawer identity. Any drift / unknown modal => zero modal submit (not an ad publication).
function confirmBatchAddAllModalInPage(input) {
  // `input` is either the legacy bare expectedProducts number or {expectedProducts, targets}.
  const inputObj = input && typeof input === 'object' && !Array.isArray(input);
  const expectedProducts = inputObj ? input.expectedProducts : input;
  const TARGET = (inputObj && Array.isArray(input.targets) && input.targets.length) ? input.targets.map(String) : ['79863866', '9zmao_fushi'];
  const visible = e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'; };
  const txt = e => (e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  const sel='[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="modal"],[class*="Modal"],[class*="drawer"],[class*="Drawer"]';
  const all=[...document.querySelectorAll(sel)].filter(visible);
  const mRoots=all.filter(e=>/确定要添加至所有商品/.test(txt(e)));
  const modals=mRoots.filter(el=>!mRoots.some(o=>o!==el&&o.contains(el)));
  if(modals.length!==1) throw new Error('batch-add-modal-not-unique');
  const modal=modals[0];
  const t=txt(modal);
  const p=t.match(/将在\s*(\d+)\s*个商品/); const a=t.match(/添加\s*(\d+)\s*个抖音号/);
  const productCount=p?Number(p[1]):null; const accountCount=a?Number(a[1]):null;
  if(!Number.isInteger(expectedProducts)||productCount!==expectedProducts) throw new Error('batch-add-modal-product-count-mismatch');
  // R32: the modal may declare 1 or 2 target accounts (min-1); 0/3+/unknown is a drift.
  if(!(accountCount===1||accountCount===2)) throw new Error('batch-add-modal-account-count-mismatch');
  const dRoots=all.filter(e=>/为商品添加抖音号/.test(txt(e)));
  const drawers=dRoots.filter(el=>!dRoots.some(o=>o!==el&&o.contains(el)));
  if(drawers.length!==1) throw new Error('account-drawer-not-unique');
  {
    const isDisabled = el => { for (let n=el;n;n=n.parentElement){ const cn=typeof n.className==='string'?n.className:((n.getAttribute&&n.getAttribute('class'))||''); if(/\bovui-checkbox--disabled\b/.test(String(cn)))return true; if(n.getAttribute&&n.getAttribute('aria-disabled')==='true')return true; if(n.disabled===true)return true; } return false; };
    const d=drawers[0];
    const rows=[...d.querySelectorAll('tr,[role="row"],.ovui-table__row')].filter(visible).filter(row=>!row.closest('thead')&&!row.querySelector('th')).map(row=>{const tt=txt(row);const ids=[...tt.matchAll(/ID\s*[:：]?\s*([A-Za-z0-9_-]{8,32})/g)].map(m=>m[1]);const checks=[...row.querySelectorAll('input[type="checkbox"]')].filter(visible);return {ids,checked:checks.length===1&&checks[0].checked===true,labelDisabled:checks.length===1?isDisabled(checks[0]):null};}).filter(r=>r.ids.length>0);
    const footer=txt(d).match(/当前商品已选\s*[：:]?\s*(\d+)\s*\/\s*(\d+)/);
    const allIds=rows.flatMap(r=>r.ids);
    const checkedN=rows.filter(r=>r.checked===true).length;
    const settled=rows.length>=1&&rows.length<=2&&rows.every(r=>r.ids.length===1&&(r.checked===true||r.labelDisabled!==null))&&checkedN>=1&&new Set(allIds).size===rows.length&&allIds.every(id=>TARGET.includes(id))&&!!footer&&Number(footer[1])===checkedN&&Number(footer[2])===30;
    if(!settled) throw new Error('batch-add-modal-accounts-not-settled');
    if(accountCount!==checkedN) throw new Error('batch-add-modal-account-count-mismatch');
  }
  const buttons=[...modal.querySelectorAll('button,[role="button"]')].filter(visible).filter(b=>txt(b)==='确定');
  if(buttons.length!==1) throw new Error('batch-add-modal-confirm-not-unique');
  if(buttons[0].disabled===true||buttons[0].getAttribute('aria-disabled')==='true') throw new Error('batch-add-modal-confirm-disabled');
  buttons[0].click();
  return {clicked:true,productCount};
}

// Read-only snapshot of the asynchronous batch RESULT modal (以下商品部分抖音号添加失败).
// No click is performed here. A real result modal carries exactly one 我知道了 affordance
// and one row per batch-processed product (every product except the drawer anchor). It is
// SETTLED only when it is present, recognised by its known title, and its rows cover exactly
// (authorizedIds-1) UNIQUE authorized product ids, each carrying one definite 成功/失败 with no
// duplicate, outside-id or unreadable outcome. Absence is pending (not success); a present but
// unrecognised modal is unknown. Both must NOT be treated as a completed batch.
function batchResultSnapshotInPage(authorizedIds) {
  const visible = e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'; };
  const txt = e => (e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  const inputObj=authorizedIds&&typeof authorizedIds==='object'&&!Array.isArray(authorizedIds);
  const idList=(inputObj?authorizedIds.productIds:authorizedIds)||[];
  const anchorId=inputObj&&authorizedIds.anchorProductId!=null?String(authorizedIds.anchorProductId):null;
  const allowed=new Set(idList.map(String));
  const expected=idList.length-1;
  const all=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="modal"],[class*="Modal"]')].filter(visible);
  const ackRoots=all.filter(e=>[...e.querySelectorAll('button,[role="button"]')].filter(visible).some(b=>txt(b)==='我知道了'));
  const modals=ackRoots.filter(el=>!ackRoots.some(o=>o!==el&&o.contains(el)));
  if(modals.length===0) return {present:false, known:false, settled:false, rowCount:0, uniqueCount:0, outside:0, duplicate:false, ambiguous:0, failedIds:[], successCount:0};
  if(modals.length!==1) return {present:true, known:false, settled:false, reason:'batch-result-modal-not-unique', rowCount:0, uniqueCount:0, outside:0, duplicate:false, ambiguous:0, failedIds:[], successCount:0};
  const modal=modals[0];
  if(!/以下商品部分抖音号添加失败|部分抖音号添加失败|以下商品抖音号添加失败/.test(txt(modal))) return {present:true, known:false, settled:false, reason:'batch-result-modal-unknown', rowCount:0, uniqueCount:0, outside:0, duplicate:false, ambiguous:0, failedIds:[], successCount:0};
  const rows=[...modal.querySelectorAll('tr,[role="row"],[class*="row"]')].filter(visible);
  const parsed=[]; let ambiguous=0;
  for(const row of rows){
    const t=txt(row);
    const rid=[...t.matchAll(/ID\s*[:：]?\s*(\d{15,20})/g)].map(m=>m[1]);
    if(rid.length!==1){ if(/添加成功|添加失败/.test(t)) ambiguous++; continue; }
    const ok=/添加成功/.test(t)&&!/添加失败/.test(t);
    const fail=/添加失败/.test(t)&&!/添加成功/.test(t);
    if(!ok&&!fail){ ambiguous++; continue; }
    parsed.push({id:rid[0], outcome:fail?'fail':'ok'});
  }
  const idsArr=parsed.map(p=>p.id);
  const unique=[...new Set(idsArr)];
  const duplicate=unique.length!==idsArr.length;
  const outside=unique.filter(id=>!allowed.has(id)).length;
  const failedIds=unique.filter(id=>parsed.some(p=>p.id===id&&p.outcome==='fail'));
  const successCount=unique.filter(id=>parsed.some(p=>p.id===id&&p.outcome==='ok')).length;
  // When the current active anchor is known, the batch result must exclude EXACTLY that anchor
  // (the drawer already bound it) and contain every OTHER authorized id. A result that drops some
  // different id yet still lists the anchor must NOT pass, so an anchor-position change (2nd/last)
  // cannot be mistaken for a valid batch.
  let anchorMismatch=false;
  if(anchorId!=null){
    const missing=[...allowed].filter(id=>!unique.includes(id));
    anchorMismatch=unique.includes(anchorId)||missing.length!==1||missing[0]!==anchorId||!allowed.has(anchorId);
  }
  const settled=ambiguous===0&&outside===0&&!duplicate&&unique.length===expected&&!anchorMismatch;
  return {present:true, known:true, settled, rowCount:rows.length, uniqueCount:unique.length, outside, duplicate, ambiguous, anchorMismatch, failedIds, successCount};
}

// Acknowledge the asynchronous batch RESULT modal. Called ONLY after a bounded fresh read has
// positively settled the same result (batchResultSnapshotInPage.settled). Re-verifies the
// recognised, complete result on the freshest node before clicking the single 我知道了 once.
// Absence is NOT a normal close here (the caller must have waited): it throws. Unknown /
// incomplete / duplicate / outside / unreadable results throw with ZERO acknowledge.
function acknowledgeBatchResultInPage(authorizedIds) {
  const visible = e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'; };
  const txt = e => (e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  const inputObj=authorizedIds&&typeof authorizedIds==='object'&&!Array.isArray(authorizedIds);
  const authorizedList=(inputObj?authorizedIds.productIds:authorizedIds)||[];
  const TARGET=(inputObj&&Array.isArray(authorizedIds.targets)&&authorizedIds.targets.length)?authorizedIds.targets.map(String):['79863866','9zmao_fushi'];
  const anchorId=inputObj&&authorizedIds.anchorProductId!=null?String(authorizedIds.anchorProductId):null;
  const allowed=new Set(authorizedList.map(String));
  const expected=authorizedList.length-1;
  const all=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="modal"],[class*="Modal"]')].filter(visible);
  const ackRoots=all.filter(e=>[...e.querySelectorAll('button,[role="button"]')].filter(visible).some(b=>txt(b)==='我知道了'));
  const modals=ackRoots.filter(el=>!ackRoots.some(o=>o!==el&&o.contains(el)));
  if(modals.length===0) throw new Error('batch-result-modal-absent');
  if(modals.length!==1) throw new Error('batch-result-modal-not-unique');
  const modal=modals[0];
  if(!/以下商品部分抖音号添加失败|部分抖音号添加失败|以下商品抖音号添加失败/.test(txt(modal))) throw new Error('batch-result-modal-unknown');
  const rows=[...modal.querySelectorAll('tr,[role="row"],[class*="row"]')].filter(visible);
  const parsed=[]; let ambiguous=0;
  for(const row of rows){
    const t=txt(row);
    const rid=[...t.matchAll(/ID\s*[:：]?\s*(\d{15,20})/g)].map(m=>m[1]);
    if(rid.length!==1){ if(/添加成功|添加失败/.test(t)) ambiguous++; continue; }
    const ok=/添加成功/.test(t)&&!/添加失败/.test(t);
    const fail=/添加失败/.test(t)&&!/添加成功/.test(t);
    if(!ok&&!fail){ ambiguous++; continue; }
    parsed.push({id:rid[0], outcome:fail?'fail':'ok'});
  }
  const idsArr=parsed.map(p=>p.id);
  const unique=[...new Set(idsArr)];
  if(ambiguous!==0||unique.length!==idsArr.length||unique.some(id=>!allowed.has(id))||unique.length!==expected) throw new Error('batch-result-incomplete-or-unreadable');
  // At the ACK instant, with the current active anchor known, the result must exclude EXACTLY
  // that anchor and contain every other authorized id — the same anchor identity the snapshot
  // gate proved, re-checked on the freshest node before the single 我知道了 click.
  if(anchorId!=null){
    const missing=[...allowed].filter(id=>!unique.includes(id));
    if(unique.includes(anchorId)||missing.length!==1||missing[0]!==anchorId||!allowed.has(anchorId)) throw new Error('batch-result-anchor-identity-mismatch');
  }
  // Fresh identity re-check on the LIVE node at the ack instant: the account drawer must still
  // show a settled subset of 1-2 approved target accounts checked (R33 min-1; an unchecked row
  // may be a definite ENABLED row intentionally left unbound) with footer 已选 = checked count
  // of 30. This is self-contained (no module helpers, not count-only). If the account IDs have
  // drifted, throw with ZERO ack.
  {
    const isDisabled = el => { for (let n=el;n;n=n.parentElement){ const cn=typeof n.className==='string'?n.className:((n.getAttribute&&n.getAttribute('class'))||''); if(/\bovui-checkbox--disabled\b/.test(String(cn)))return true; if(n.getAttribute&&n.getAttribute('aria-disabled')==='true')return true; if(n.disabled===true)return true; } return false; };
    const selD='[class*="drawer"],[class*="Drawer"],[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="modal"],[class*="Modal"]';
    const allD=[...document.querySelectorAll(selD)].filter(visible);
    const dRoots=allD.filter(e=>/为商品添加抖音号/.test(txt(e)));
    const drawers=dRoots.filter(el=>!dRoots.some(o=>o!==el&&o.contains(el)));
    if(drawers.length!==1) throw new Error('batch-result-ack-account-drawer-not-unique');
    const d=drawers[0];
    const drows=[...d.querySelectorAll('tr,[role="row"],.ovui-table__row')].filter(visible).filter(row=>!row.closest('thead')&&!row.querySelector('th')).map(row=>{const tt=txt(row);const ids=[...tt.matchAll(/ID\s*[:：]?\s*([A-Za-z0-9_-]{8,32})/g)].map(m=>m[1]);const checks=[...row.querySelectorAll('input[type="checkbox"]')].filter(visible);return {ids,checked:checks.length===1&&checks[0].checked===true,labelDisabled:checks.length===1?isDisabled(checks[0]):null};}).filter(r=>r.ids.length>0);
    const dfooter=txt(d).match(/当前商品已选\s*[：:]?\s*(\d+)\s*\/\s*(\d+)/);
    const dAllIds=drows.flatMap(r=>r.ids);
    const dCheckedN=drows.filter(r=>r.checked===true).length;
    const dSettled=drows.length>=1&&drows.length<=2&&drows.every(r=>r.ids.length===1&&(r.checked===true||r.labelDisabled!==null))&&dCheckedN>=1&&new Set(dAllIds).size===drows.length&&dAllIds.every(id=>TARGET.includes(id))&&!!dfooter&&Number(dfooter[1])===dCheckedN&&Number(dfooter[2])===30;
    if(!dSettled) throw new Error('batch-result-ack-account-identity-drift');
    // With a strict object input the CURRENT active panel product must still be the exact anchor
    // the driver captured, and the drawer's .panel set must still equal the batch's productIds. The
    // result-set exclusion alone is not proof the ACTIVE product is unchanged, so re-read the live
    // panels at the ACK instant: a foreign/duplicate/missing/multiple/no active, or any panel-set
    // drift => ZERO acknowledge. Array (legacy) callers carry no anchor and skip this active check.
    if(anchorId!=null){
      const panelEls=[...d.querySelectorAll('.panel')].filter(visible);
      const pidOf=el=>String((el.getAttribute&&el.getAttribute('id'))||'');
      const panelIds=panelEls.map(pidOf).filter(id=>/^\d{15,20}$/.test(id));
      const puniq=[...new Set(panelIds)];
      const activeIds=panelEls.filter(el=>String(el.className||'').split(/\s+/).includes('active')).map(pidOf).filter(id=>/^\d{15,20}$/.test(id));
      const panelSetOk=panelIds.length===authorizedList.length&&puniq.length===authorizedList.length&&authorizedList.every(id=>puniq.includes(String(id)));
      const activeOk=activeIds.length===1&&String(activeIds[0])===anchorId;
      if(!panelSetOk) throw new Error('batch-result-ack-anchor-panel-set-drift');
      if(!activeOk) throw new Error('batch-result-ack-active-anchor-drift');
    }
  }
  const buttons=[...modal.querySelectorAll('button,[role="button"]')].filter(visible).filter(b=>txt(b)==='我知道了');
  if(buttons.length!==1) throw new Error('batch-result-acknowledge-not-unique');
  if(buttons[0].disabled===true||buttons[0].getAttribute('aria-disabled')==='true') throw new Error('batch-result-acknowledge-disabled');
  buttons[0].click();
  return {present:true, acked:true, failedIds:unique.filter(id=>parsed.some(p=>p.id===id&&p.outcome==='fail')), successCount:unique.filter(id=>parsed.some(p=>p.id===id&&p.outcome==='ok')).length};
}

// Close the KNOWN partial-failure notice (以下商品部分抖音号添加失败) with its own top-right ×.
// Unlike acknowledgeBatchResultInPage this does NOT require the notice to enumerate every batch
// product: a partial notice may list only some of the failures, and the operator has explicitly
// authorised closing it that way. Closing is NEVER a success claim — the caller must still prove
// each product read-only afterwards. Fail-closed with ZERO clicks unless: exactly one innermost
// visible root carries the known title; the 为商品添加抖音号 drawer is uniquely present and there is
// no other/unknown modal; every listed row is a definite 添加成功/添加失败 for an authorized id that
// is not the current anchor, with no duplicate or unreadable row; and that notice root exposes
// exactly one visible, enabled close control (preferring the top-right one when geometry exists).
// R16 (real UIA): the close affordance is NOT a button — it is a div/span carrying the exact
// class ovui-modal__close-icon inside the modal wrap, and the innermost known-title root may be
// only the modal body while the × is a SIBLING inside ovui-modal__wrap oc-modal-wrap. So the
// close is resolved inside the WHOLE known-title modal container (noticeOuter, the outermost
// known ancestor matching a modal/dialog/popup class), never a generic arbitrary ×. A real
// partial notice may render its product ids TRUNCATED (e.g. 3753795932…): such rows stay
// readable-outcome-only, are never mapped into failedIds, and closing never requires a complete
// enumerated result — the caller re-proves every panel read-only afterwards. Every specific
// close refusal carries a bounded, digit-masked diagnostic instead of being erased to generic.
function closeKnownPartialResultInPage(authorizedIds) {
  const visible = e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'; };
  const txt = e => (e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  const rectOf = e => { try { return e.getBoundingClientRect()||null; } catch(_) { return null; } };
  const KNOWN=/以下商品部分抖音号添加失败|部分抖音号添加失败|以下商品抖音号添加失败/;
  const clsOf=el=>String((el.getAttribute&&el.getAttribute('class'))||(typeof el.className==='string'?el.className:''));
  const inputObj=authorizedIds&&typeof authorizedIds==='object'&&!Array.isArray(authorizedIds);
  const idList=(inputObj?authorizedIds.productIds:authorizedIds)||[];
  const anchorId=inputObj&&authorizedIds.anchorProductId!=null?String(authorizedIds.anchorProductId):null;
  const allowed=new Set(idList.map(String));
  const all=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]')].filter(visible);
  const known=all.filter(e=>KNOWN.test(txt(e)));
  if(known.length===0) throw new Error('known-partial-result-notice-absent');
  const noticeRoots=known.filter(el=>!known.some(o=>o!==el&&o.contains(el)));
  if(noticeRoots.length!==1) throw new Error('known-partial-result-notice-not-unique');
  const notice=noticeRoots[0];
  // The known-title modal CONTAINER: outermost KNOWN ancestor that still matches a modal/dialog/
  // popup class (ovui-modal__wrap oc-modal-wrap). The top-right × is a SIBLING of the modal body
  // inside that wrap, so the close is searched in noticeOuter, never in the bare body.
  const noticeChain=known.filter(el=>el===notice||el.contains(notice));
  const modalChain=noticeChain.filter(el=>el===notice||/modal|dialog|popup/i.test(clsOf(el)));
  const noticeOuter=modalChain.find(el=>!modalChain.some(o=>o!==el&&o.contains(el)))||notice;
  const outer=all.filter(el=>!all.some(o=>o!==el&&o.contains(el)));
  const drawerRoots=outer.filter(e=>/为商品添加抖音号/.test(txt(e)));
  if(drawerRoots.length!==1) throw new Error('known-partial-result-account-drawer-not-unique');
  const drawer=drawerRoots[0];
  const others=outer.filter(e=>e!==drawer&&!drawer.contains(e));
  if(others.some(e=>e!==noticeOuter)) throw new Error('known-partial-result-unknown-modal');
  // Live drawer identity re-check BEFORE any click: the drawer must still expose exactly this
  // batch's unique 30-product panel set with ONE active panel equal to the captured anchor. A close
  // on a drifted panel set / ambiguous active could dismiss a notice belonging to another scope, so
  // any drift throws with ZERO clicks.
  if(anchorId!=null&&idList.length){
    const panelEls=[...drawer.querySelectorAll('.panel')].filter(visible);
    const pidOf=el=>String((el.getAttribute&&el.getAttribute('id'))||'');
    const pids=panelEls.map(pidOf).filter(id=>/^\d{15,20}$/.test(id));
    const uniq=[...new Set(pids)];
    if(pids.length!==idList.length||uniq.length!==idList.length||!idList.every(id=>uniq.includes(String(id)))) throw new Error('known-partial-result-panel-set-drift');
    const active=panelEls.filter(el=>String(el.className||'').split(/\s+/).includes('active')).map(pidOf);
    if(active.length!==1||String(active[0])!==anchorId) throw new Error('known-partial-result-active-anchor-drift');
  }
  const rows=[...noticeOuter.querySelectorAll('tr,[role="row"],[class*="row"]')].filter(visible);
  const TRUNC=/ID\s*[:：]?\s*\d{4,}\s*(?:…|\.\.\.)/;
  // 本批冻结的目标账号数只有对象形态才已知（数组 legacy 调用没有）：混合行的成功+失败必须恰好等于它。
  const accountCount=inputObj&&Array.isArray(authorizedIds.targets)?authorizedIds.targets.length:null;
  const accountKnown=accountCount===1||accountCount===2;
  const parsed=[]; let ambiguous=0, truncated=0;
  for(const row of rows){
    const t=txt(row);
    const rid=[...t.matchAll(/ID\s*[:：]?\s*(\d{15,20})/g)].map(m=>m[1]);
    const hasOk=/添加成功/.test(t), hasFail=/添加失败/.test(t);
    const ok=hasOk&&!hasFail;
    const fail=hasFail&&!hasOk;
    if(rid.length>1){ ambiguous++; continue; }
    if(rid.length===1){
      if(ok||fail){ parsed.push({id:rid[0], outcome:fail?'fail':'ok'}); continue; }
      // 真实混合行（例：1个抖音号添加成功，1个抖音号添加失败）：同一商品对多个授权账号一成一败，
      // 既不是"全失败"也不是矛盾文字。只有账号数已知、两笔计数都读得出、成功≥1 且失败≥1、两者之和
      // 恰等于账号数时才授权关闭；行仍记为 mixed，绝不并进成功宣称，关闭后仍须逐商品只读证明 ≥1。
      // 缺计数、合计与账号数不符或 0 成功，都仍是 ambiguous 负例。
      if(hasOk&&hasFail){
        const mOk=t.match(/(\d{1,3})\s*个抖音号添加成功/), mFail=t.match(/(\d{1,3})\s*个抖音号添加失败/);
        const nOk=mOk?Number(mOk[1]):-1, nFail=mFail?Number(mFail[1]):-1;
        if(accountKnown&&nOk>=1&&nFail>=1&&nOk+nFail===accountCount){ parsed.push({id:rid[0], outcome:'mixed'}); continue; }
      }
      ambiguous++; continue;
    }
    // 真实通知的展示 ID 常见截断（3753795932…）：只要求该行结果可判，绝不把截断 id 猜成授权商品，
    // 也绝不因截断而拒绝关闭；同行结果矛盾（含截断混合）仍是 ambiguous 负例。
    if(TRUNC.test(t)){
      if(!ok&&!fail){ ambiguous++; continue; }
      truncated++;
      continue;
    }
    if(hasOk||hasFail) ambiguous++;
  }
  if(parsed.length+truncated===0) throw new Error('known-partial-result-no-readable-outcome');
  if(ambiguous!==0) throw new Error('known-partial-result-unreadable-row');
  const idsArr=parsed.map(p=>p.id);
  const unique=[...new Set(idsArr)];
  if(unique.length!==idsArr.length) throw new Error('known-partial-result-duplicate-id');
  if(unique.some(id=>!allowed.has(id))) throw new Error('known-partial-result-outside-id');
  if(anchorId!=null&&unique.includes(anchorId)) throw new Error('known-partial-result-anchor-drift');
  const scrub=t=>String(t==null?'':t).replace(/\s+/g,' ').replace(/\d{8,}/g,'***').trim().slice(0,60);
  const isCloseText=el=>/^(×|✕|✖|X|x|关闭)$/.test(txt(el));
  const isCloseAria=el=>/关闭|close/i.test(String((el.getAttribute&&el.getAttribute('aria-label'))||'')+' '+String((el.getAttribute&&el.getAttribute('title'))||''));
  const isCloseClass=el=>/(^|[^a-z0-9])close([^a-z0-9]|$)/i.test(clsOf(el));
  const isClose=el=>isCloseText(el)||isCloseAria(el)||isCloseClass(el);
  // 有界脱敏现场诊断（随原始 close 错误文本携带，绝不抹成 generic）：只读描述已知通知容器与其
  // close 候选的 tag/class/短文本；≥8 位数字掩码、总长 ≤400；无 HTML/Cookie/存储/网络。
  const diagOf=()=>{
    const cands=[...noticeOuter.querySelectorAll('button,[role="button"],a,div,span,i,svg')].filter(visible).filter(isClose).slice(0,3).map(el=>({ tag:String(el.tagName||'').toLowerCase().slice(0,12), cls:scrub(clsOf(el)).slice(0,48), text:scrub(txt(el)).slice(0,24) }));
    const scene={ tag:String(noticeOuter.tagName||'').toLowerCase().slice(0,12), cls:scrub(clsOf(noticeOuter)).slice(0,64), role:scrub((noticeOuter.getAttribute&&noticeOuter.getAttribute('role'))||'').slice(0,16), titlePresent:KNOWN.test(txt(noticeOuter)), modalCount:outer.length, truncatedRows:truncated, closeCandidates:cands };
    let s; try { s=JSON.stringify(scene); } catch(_) { s='{"modalCount":'+outer.length+'}'; }
    return String(s||'').slice(0,400);
  };
  // close 只在**唯一已知标题容器** noticeOuter 内解析（覆盖 × 为 modalwrap 兄弟的形状），绝不通用任意 ×：
  // 先收拢嵌套候选，再优先唯一精确 class（ovui-modal__close-icon），最后才按右上几何定夺。div/span 图标
  // 与旧的 button/[role=button]/a 同等对待。
  let closes=[...noticeOuter.querySelectorAll('button,[role="button"],a,div,span,i,svg')].filter(visible).filter(isClose);
  closes=closes.filter(el=>!closes.some(o=>o!==el&&o.contains(el)));
  if(closes.length===0) throw new Error('known-partial-result-close-not-found '+diagOf());
  if(closes.length>1){
    const exact=closes.filter(el=>/ovui-modal__close-icon/.test(clsOf(el)));
    if(exact.length===1) closes=exact;
  }
  if(closes.length>1){
    // 优先右上角 close：只有几何信息可读且右上候选恰好唯一时才允许，否则视为歧义零点击。
    const nr=rectOf(noticeOuter);
    if(!nr||!Number.isFinite(nr.left)||!Number.isFinite(nr.top)||!Number.isFinite(nr.width)) throw new Error('known-partial-result-close-not-unique '+diagOf());
    const halfLeft=nr.left+nr.width/2, halfTop=nr.top+nr.height/2;
    closes=closes.filter(el=>{ const r=rectOf(el); return !!r&&Number.isFinite(r.left)&&Number.isFinite(r.top)&&(r.left+r.width/2)>=halfLeft&&(r.top+r.height/2)<=halfTop; });
    if(closes.length!==1) throw new Error('known-partial-result-close-not-unique '+diagOf());
  }
  const closeBtn=closes[0];
  if(closeBtn.disabled===true||closeBtn.getAttribute('aria-disabled')==='true'||/(^|[^a-z0-9])disabled([^a-z0-9]|$)/i.test(clsOf(closeBtn))) throw new Error('known-partial-result-close-disabled '+diagOf());
  closeBtn.click();
  return {present:true, closed:true, listedCount:unique.length, listedFailedIds:unique.filter(id=>parsed.some(p=>p.id===id&&p.outcome==='fail')), listedSuccessCount:unique.filter(id=>parsed.some(p=>p.id===id&&p.outcome==='ok')).length, listedTruncatedCount:truncated, anchorProductId:anchorId};
}

// After the result is acknowledged, the drawer's 确定 commits the DRAFT (never an ad
// publication). In some draft modes this raises a partial warning
// 部分商品未选择抖音号，确定提交吗？. That warning may only be accepted when the preceding
// batch result proved exact failed ids (knownFailures true); otherwise stop with zero
// clicks. No warning at all (drawer closed directly) is a normal outcome.
function acceptPartialDraftWarningInPage(knownFailures) {
  const visible = e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'; };
  const txt = e => (e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  const all=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="modal"],[class*="Modal"]')].filter(visible);
  const wRoots=all.filter(e=>/部分商品未选择抖音号，确定提交吗/.test(txt(e)));
  const modals=wRoots.filter(el=>!wRoots.some(o=>o!==el&&o.contains(el)));
  if(modals.length===0) return {present:false};
  if(modals.length!==1) throw new Error('partial-draft-warning-not-unique');
  if(knownFailures!==true) throw new Error('partial-draft-warning-without-known-failures');
  const buttons=[...modals[0].querySelectorAll('button,[role="button"]')].filter(visible).filter(b=>txt(b)==='确定');
  if(buttons.length!==1) throw new Error('partial-draft-warning-confirm-not-unique');
  buttons[0].click();
  return {present:true, accepted:true};
}

// Commit the binding drawer draft with its 确定, re-verifying the freshest settled
// known subset of approved target accounts (R33 min-1: at least one checked; an unchecked
// row may be an enabled target left intentionally unbound, but an unknown-checkbox row —
// labelDisabled null — is a hard reject) + footer 已选 = checked count of 30 on the live node (identity
// gate, self-contained). The batch is a button (handled earlier), so no batch checkbox
// is required here.
function confirmBatchAccountsApplyInPage(payload) {
  const TARGET=(payload&&Array.isArray(payload.targets)&&payload.targets.length)?payload.targets.map(String):['79863866','9zmao_fushi'];
  const visible = e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'; };
  const txt = e => (e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  const isDisabled = el => { for (let n=el;n;n=n.parentElement){ const cn=typeof n.className==='string'?n.className:((n.getAttribute&&n.getAttribute('class'))||''); if(/\bovui-checkbox--disabled\b/.test(String(cn)))return true; if(n.getAttribute&&n.getAttribute('aria-disabled')==='true')return true; if(n.disabled===true)return true; } return false; };
  const roots=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]')].filter(visible).filter(e=>/为商品添加抖音号/.test(txt(e)));
  const dialogs=roots.filter(el=>!roots.some(o=>o!==el&&o.contains(el)));
  if(dialogs.length!==1) throw new Error('account-drawer-not-unique');
  const drawer=dialogs[0];
  const rows=[...drawer.querySelectorAll('tr,[role="row"],.ovui-table__row')].filter(visible).filter(row=>!row.closest('thead')&&!row.querySelector('th')).map(row=>{
    const t=txt(row);
    const ids=[...t.matchAll(/ID\s*[:：]?\s*([A-Za-z0-9_-]{8,32})/g)].map(m=>m[1]);
    const checks=[...row.querySelectorAll('input[type="checkbox"]')].filter(visible);
    return {ids,checked:checks.length===1&&checks[0].checked===true,labelDisabled:checks.length===1?isDisabled(checks[0]):null};
  }).filter(r=>r.ids.length>0);
  if(rows.length<1||rows.length>2) throw new Error('account-rows-not-one-or-two-targets-before-submit');
  if(rows.some(r=>r.ids.length!==1)) throw new Error('account-row-id-not-unique-before-submit');
  const allIds=rows.flatMap(r=>r.ids);
  if(new Set(allIds).size!==rows.length||!allIds.every(id=>TARGET.includes(id))) throw new Error('account-id-drift-before-submit');
  const checkedN=rows.filter(r=>r.checked===true).length;
  // R33: an unchecked row only has to read a DEFINITE single-checkbox state (labelDisabled
  // null means zero or multiple visible inputs — an unreadable/unknown checkbox that must
  // never submit). An ENABLED row left deliberately unchecked is the approved min-1 subset
  // (binding >=1 of the displayed targets) and stays acceptable here.
  if(checkedN<1||rows.some(r=>r.checked!==true&&r.labelDisabled===null)) throw new Error('account-rows-not-checked-before-submit');
  const footer=txt(drawer).match(/当前商品已选\s*[：:]?\s*(\d+)\s*\/\s*(\d+)/);
  if(!footer||Number(footer[1])!==checkedN||Number(footer[2])!==30) throw new Error('account-footer-not-checked-count-of-30-before-submit');
  const buttons=[...drawer.querySelectorAll('button')].filter(visible).filter(b=>txt(b)==='确定');
  if(buttons.length!==1) throw new Error('account-drawer-confirm-not-unique');
  buttons[0].click();
  return {clicked:true};
}

// Uniquely open a product row's account-management button (管理抖音号 / 管理手动添加抖音号
// / 手动添加抖音号) from the creation main table. Returns {ok:false} (never throws) when
// the row or button is not uniquely present, so the driver can stop honestly.
function openAnchorManagementInPage(productId) {
  const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
  const txt=e=>(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  const rr=[...document.querySelectorAll('tr,[role="row"],.ovui-table__row')].filter(vis).filter(r=>[...txt(r).matchAll(/ID\s*[:：]\s*(\d{15,20})/g)].some(m=>m[1]===String(productId)));
  if(rr.length!==1)return {ok:false};
  const labels=new Set(['手动添加抖音号','管理手动添加抖音号','管理抖音号']);
  const bs=[...rr[0].querySelectorAll('button,[role="button"]')].filter(vis).filter(b=>labels.has(txt(b)));
  if(bs.length!==1)return {ok:false};
  bs[0].click();return {ok:true};
}

// Cancel an auto-opened, still-unsaved account drawer (Picker 下一步 opens it even on
// supplements). Only acts when there is exactly one 为商品添加抖音号 drawer with a unique
// enabled 取消 button; never clicks behind overlays and never commits a draft.
function cancelAutoOpenedDrawerInPage() {
  const vis=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
  const txt=e=>(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  const roots=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]')].filter(vis).filter(e=>/为商品添加抖音号/.test(txt(e)));
  const dialogs=roots.filter(el=>!roots.some(o=>o!==el&&o.contains(el)));
  if(dialogs.length!==1) return {cancelled:false};
  const buttons=[...dialogs[0].querySelectorAll('button,[role="button"]')].filter(vis).filter(b=>txt(b)==='取消');
  if(buttons.length!==1||buttons[0].disabled===true||buttons[0].getAttribute('aria-disabled')==='true') return {cancelled:false};
  buttons[0].click();
  return {cancelled:true};
}

// Normal-draft navigation ONLY: switch the account drawer's active product by clicking the
// single .panel whose id equals productId. It never touches a checkbox/input, never edits
// disabled/props, and never fires a business API — it is the same click a human makes to move
// to another product inside the drawer. Returns {clicked,id}; throws (zero click) unless the
// drawer is unique and exactly one visible panel matches the id.
function selectBindingDrawerPanelInPage(productId) {
  const visible = e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'; };
  const txt = e => (e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  const roots=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]')].filter(visible).filter(e=>/为商品添加抖音号/.test(txt(e)));
  const dialogs=roots.filter(el=>!roots.some(o=>o!==el&&o.contains(el)));
  if(dialogs.length!==1) throw new Error('account-drawer-not-unique');
  const target=String(productId);
  if(!/^\d{15,20}$/.test(target)) throw new Error('anchor-panel-id-invalid');
  const panels=[...dialogs[0].querySelectorAll('.panel')].filter(visible).filter(el=>String((el.getAttribute&&el.getAttribute('id'))||'')===target);
  if(panels.length!==1) throw new Error('anchor-panel-not-unique');
  panels[0].click();
  return {clicked:true,id:target};
}

// Read-only overlay census for the all-success (no result modal) branch. The account drawer
// (为商品添加抖音号) is EXPECTED to stay open while we navigate its .panel list; anything else
// on top — a still-present result popup, a lingering batch confirm modal, an unknown dialog, a
// partial warning — is a BLOCKING overlay that forbids navigation (we never click behind one).
// Modals nested inside the drawer count as part of the drawer, not as a separate overlay.
function bindingOverlaySnapshotInPage() {
  const visible = e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'; };
  const txt = e => (e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  const sel='[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]';
  const all=[...document.querySelectorAll(sel)].filter(visible);
  const outer=all.filter(el=>!all.some(o=>o!==el&&o.contains(el)));
  const drawerRoots=outer.filter(e=>/为商品添加抖音号/.test(txt(e)));
  return {accountDrawerCount:drawerRoots.length, blockingOverlayPresent:outer.some(e=>!/为商品添加抖音号/.test(txt(e)))};
}

function classifyAndCancelAutoPullInPage() {
  const visible = e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'; };
  const dialogs=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="modal"],[class*="Modal"]')].filter(visible);
  const exact=dialogs.filter(d=>(d.innerText||d.textContent||'').includes('已存在自动拉取投放计划，添加后将会关闭自动拉取抖音号功能'));
  if(exact.length===0) return { kind:'none', productIds:[] };
  const roots=exact.filter(el=>!exact.some(o=>o!==el&&o.contains(el)));
  if(roots.length!==1) return { kind:'unknown', reason:'auto-pull-dialog-not-unique', productIds:[] };
  const text=(roots[0].innerText||roots[0].textContent||'').replace(/\s+/g,' ').trim();
  return { kind:'observed', text };
}

function cancelObservedAutoPullInPage(expectedText) {
  const visible = e => { const r=e.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden'; };
  const norm=s=>String(s||'').replace(/\s+/g,' ').trim();
  const dialogs=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="modal"],[class*="Modal"]')].filter(visible).filter(d=>norm(d.innerText||d.textContent||'')===norm(expectedText));
  const roots=dialogs.filter(el=>!dialogs.some(o=>o!==el&&o.contains(el)));
  if(roots.length!==1)throw new Error('auto-pull-dialog-drift-or-not-unique');
  const buttons=[...roots[0].querySelectorAll('button,[role="button"]')].filter(visible).filter(b=>norm(b.innerText||b.textContent||'')==='取消');
  if(buttons.length!==1||buttons[0].disabled||buttons[0].getAttribute('aria-disabled')==='true')throw new Error('auto-pull-cancel-not-unique');
  buttons[0].click();
  return {cancelled:true};
}

function readMainTableInPage() {
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
  const txt=e=>(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  const req=['商品信息','投放抖音号','素材','操作'];
  const dialogs='[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]';
  const tables=[...document.querySelectorAll('table,[role="table"],[role="grid"],[class*="table"],[class*="Table"]')].filter(visible).filter(e=>!e.closest(dialogs)&&req.every(h=>txt(e).includes(h)));
  const scored=tables.map(el=>({el,rows:[...el.querySelectorAll('tr,[role="row"],.ovui-table__row')].filter(visible).filter(r=>/ID\s*[:：]\s*\d{15,20}/.test(txt(r))).length}));
  const max=Math.max(0,...scored.map(x=>x.rows));
  const roots=scored.filter(x=>x.rows===max).filter(x=>!scored.some(y=>y!==x&&y.rows===max&&x.el.contains(y.el)));
  if(roots.length!==1||max===0)return {ok:false,reason:'creation-table-not-unique-or-empty',rootCount:roots.length,rowCount:max};
  // Native single-manual layout (the real Minmin 30 rows): NO "N个抖音号" counter at all.
  // Positive proof = exactly one VISIBLE manual .aweme-entry outside the auto-pull subtree
  // carrying the 管理(手动添加)抖音号 control AND a visible .item-info-wrapper whose text is a
  // non-empty name + a non-empty explicit ID. A lone manage button, a lone name/ID, hidden or
  // duplicate entries, an empty name/ID or an unknown layout never count as 1; an explicit
  // "N个抖音号" counter always outranks this inference (contradiction keeps the counter).
  const singleManualCell=cellEl=>{
    const auto=[...cellEl.querySelectorAll('.auto-pull-aweme-wrapper')];
    const entries=[...cellEl.querySelectorAll('.aweme-entry')].filter(e=>!auto.some(a=>a.contains(e)));
    if(entries.length!==1||!visible(entries[0]))return false;
    if(!/管理(?:手动添加)?抖音号/.test(txt(entries[0])))return false;
    const infos=[...entries[0].querySelectorAll('.item-info-wrapper')].filter(visible);
    if(infos.length!==1)return false;
    const m=txt(infos[0]).match(/^(\S.*?)\s*ID\s*[:：]\s*(\S.*?)$/);
    return !!m&&m[1].trim()!==''&&m[2].trim()!=='';
  };
  const rows=[];
  for(const row of [...roots[0].el.querySelectorAll('tr,[role="row"],.ovui-table__row')].filter(visible)){
    const text=txt(row); const ids=[...text.matchAll(/ID\s*[:：]\s*(\d{15,20})/g)].map(m=>m[1]);
    if(ids.length!==1)continue;
    // Manual-account evidence is read ONLY from the unique aweme cell (.aweme-wrapper).
    // A bound count may still fall back to the row when no single wrapper exists, but an
    // empty (0) claim is never inferred from unrelated product-notice text: without a
    // unique .aweme-wrapper showing only the exact 添加抖音号 button the count stays null.
    const aweme=[...row.querySelectorAll('.aweme-wrapper')].filter(visible);
    const cell=aweme.length===1?txt(aweme[0]):null;
    const scope=cell===null?text:cell;
    const count=scope.match(/(\d+)\s*个抖音号\s*管理(?:手动添加)?抖音号/);
    const singleManual=!count&&cell!==null&&singleManualCell(aweme[0]);
    const explicitAuto=!singleManual&&/预估自动拉取\s*\d+\s*个/.test(scope)&&!count;
    const emptyAwemeCell=cell!==null&&!count&&!singleManual&&!explicitAuto&&!/管理(?:手动添加)?抖音号/.test(cell)&&/(^|\s)添加(?:手动添加)?抖音号(\s|$)/.test(cell);
    rows.push({productId:ids[0],text,manualAccounts:count?Number(count[1]):singleManual?1:(explicitAuto||emptyAwemeCell)?0:null,manualEvidence:!!count||singleManual||emptyAwemeCell,manualCountKnown:!!count||singleManual||explicitAuto||emptyAwemeCell,autoPullOnly:explicitAuto,reviewFailed:text.includes('当前商品广告审核不通过'),migrationWarning:text.includes('该商品已创建「全店托管」计划'),precheckRisk:text.includes('根据系统前置检测，当前商品可能审核不通过')});
  }
  return {ok:true,rows};
}

function creationPlanNameInPage(name) {
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
  const inputs=[...document.querySelectorAll('input,textarea')].filter(visible).filter(i=>/计划名称/.test(i.getAttribute('placeholder')||''));
  if(inputs.length!==1)throw new Error('plan-name-input-not-unique');
  const input=inputs[0];
  const setter=Object.getOwnPropertyDescriptor(input.tagName==='INPUT'?HTMLInputElement.prototype:HTMLTextAreaElement.prototype,'value').set;
  setter.call(input,name);input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));input.blur();
  if(input.value!==name)throw new Error('plan-name-readback-mismatch');
  return {planName:input.value};
}

function readManagementRowsInPage(planName) {
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
  const txt=e=>(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  // (1) accountId comes ONLY from a visible account-bar root. The real header has
  //     no .qc-page-navigator-container; the account sits in nested .navigator /
  //     .qc-ui-navigator / .ocean-vmok-plugin-navigator / .qc-navigator-account
  //     bars that all repeat the SAME id. Merge nested duplicates to the outermost
  //     visible root, collect every ID shown there, and require exactly one UNIQUE
  //     value. Two different ids, a hidden pseudo-bar, or an id that only appears in
  //     a product row / the URL is a refusal (null) -- never a success.
  const navCandidates=[...new Set([...document.querySelectorAll('.qc-page-navigator-container, .qc-navigator-account, [class*="navigator"]')])].filter(visible);
  const navRoots=navCandidates.filter(el=>!navCandidates.some(o=>o!==el&&o.contains(el)));
  const acctIds=new Set();
  for(const root of navRoots) for(const m of txt(root).matchAll(/ID\s*[:：]\s*(\d{8,20})/g)) acctIds.add(m[1]);
  const accountId=acctIds.size===1?[...acctIds][0]:null;
  const expectedName=String(planName);
  // (2) The plan name is a dedicated semantic node, NOT the whole cell text: the
  //     real name td concatenates the id / product-count / labels AROUND the name,
  //     so td full text never equals the plan name. Match the semantic
  //     .aurora-qc-promotion-product-adinfo-name-text node whose own text is EXACTLY
  //     the plan name (never .includes, so a longer name that merely shares a prefix
  //     cannot match). A nested outer name-row / typography span carries the same
  //     single name inside ONE td -- still one row, never two plans. Keep the legacy
  //     shape where the whole cell text is the pure name. The summary row is ignored.
  const nameSel='[class*="aurora-qc-promotion-product-adinfo-name-text"]';
  const rows=[...document.querySelectorAll('tr[data-row-key]')].filter(visible)
    .filter(row=>String(row.getAttribute('data-row-key')||'')!=='__qc_table_summary_row__')
    .map(row=>{
      const cells=[...row.querySelectorAll('td,[role="cell"]')].filter(visible);
      let nameEl=null;
      for(const cell of cells){
        const hit=[...cell.querySelectorAll(nameSel)].filter(e=>visible(e)&&txt(e)===expectedName);
        if(hit.length){nameEl=hit[hit.length-1];break;}
        if(txt(cell)===expectedName){nameEl=cell;break;}
      }
      return {row,nameEl};
    }).filter(x=>x.nameEl);
  return {accountId, rowCount:rows.length, rows:rows.map(({row,nameEl})=>{
    const text=txt(row); const key=row.getAttribute('data-row-key');
    const id=/^\d{12,20}$/.test(String(key||''))?String(key):null;
    // (3) Product count is a BARE number next to the 商品 label inside the name cell
    //     ("30 商品"); there is no 共 / 商品数 / 已选商品 prefix, so the old prefixed
    //     regex returned null. Read it from the name cell so the plan id / ROI /
    //     day-budget digits living in OTHER cells can never be mistaken for the
    //     count. The 抖音号 count comes from the same cell. The legacy prefixed
    //     forms and the older full-row fallback stay for back-compat.
    const nameCell=(nameEl.closest&&nameEl.closest('td,[role="cell"]'))||nameEl;
    const cellText=txt(nameCell);
    const productCount=(cellText.match(/(\d{1,4})\s*商品/)||[])[1]
      ||(text.match(/(?:共|商品数量|商品数|已选商品)\s*[:：]?\s*(\d{1,2})\s*(?:个)?商品/)||[])[1]
      ||(text.match(/商品\s*[:：]\s*(\d{1,2})\s*个/)||[])[1];
    const accountCount=(cellText.match(/(\d{1,3})\s*(?:个)?\s*抖音号/)||[])[1]
      ||(text.match(/(\d+)\s*(?:个)?\s*抖音号/)||[])[1];
    const roi=(text.match(/(?:综合营销ROI目标|ROI)\s*[:：]?\s*(\d+(?:\.\d+)?)/i)||[])[1]||(text.match(/目标\s*(\d+(?:\.\d+)?)/)||[])[1];
    const budget=(text.match(/(?:每日预算|日预算)\s*[:：]?\s*(\d+(?:\.\d+)?)\s*元/)||[])[1];
    const status=(text.match(/投放中|已暂停|已终止|已结束|审核中|已下线|未投放|投放完成|预算不足|已拒绝|暂停中|已删除|创建失败|发布失败/)||[])[0]||null;
    const commissionIncluded=/不含达人佣金出价|未含达人佣金出价/.test(text)?false:/含达人佣金出价/.test(text)?true:null;
    return {planId:id,planName:txt(nameEl),text,productCount:productCount==null?null:Number(productCount),accountCount:accountCount==null?null:Number(accountCount),roi:roi==null?null:Number(roi),dailyBudget:budget==null?null:Number(budget),commissionIncluded,status};
  })};
}

// R38 read-only FULL-modal landscape probe for the controlled one-shot reopen. It uses
// the SAME dialog selector the guard's native publishApply refuses on, so "no blocking
// modal" here means exactly "publishApply will not see a visible dialog". A bare
// visible:false / an unreadable DOM is reported as ok:false (ambiguous) and is NEVER
// treated as "no modal"; only a clean, queryable DOM with ZERO visible dialog roots
// yields noBlockingModal:true. It also reports finalPresent so the caller can refuse if
// the known final dialog is actually still up (that is the normal final path, not a
// reopen). Read-only: it never clicks, dismisses, or mutates anything.
function dialogLandscapeSnapshotInPage() {
  try {
    const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
    const txt=e=>(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
    const dialogSel='[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="drawer"],[class*="Drawer"],[class*="modal"],[class*="Modal"]';
    const all=[...document.querySelectorAll(dialogSel)].filter(visible);
    // merge nested same-dialog nodes down to their outermost roots
    const roots=all.filter(el=>!all.some(o=>o!==el&&o.contains(el)));
    const texts=roots.map(el=>txt(el).slice(0,200));
    const finalPresent=texts.some(t=>/为保证乘方投放的唯一性/.test(t));
    return {ok:true, visibleDialogRoots:roots.length, noBlockingModal:roots.length===0, finalPresent, dialogTexts:texts};
  } catch (e) { return {ok:false, noBlockingModal:false, reason:'modal-landscape-read-failed'}; }
}

// The known final mutual-exclusion modal is nested (ovui-modal__wrap >
// ovui-modal > header/body/footer/close). Every one of those nodes carries the
// keyword or lives inside a node that does, so a naive class-substring match
// counted the SAME dialog three times and returned 'final-dialog-not-unique'.
// Merge nested duplicates by keeping only the OUTERMOST candidate (drop any
// candidate another candidate contains); two truly independent identical modals
// are two roots and are refused. The business body is assembled from the header
// title + body only, so footer button labels never participate in the equality.
function finalDialogSnapshotInPage() {
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
  const txt=e=>(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  const KEY='为保证乘方投放的唯一性';
  const ds=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="modal"],[class*="Modal"]')].filter(visible);
  const matching=ds.filter(d=>txt(d).includes(KEY));
  const roots=matching.filter(m=>!matching.some(o=>o!==m&&o.contains(m)));
  if(roots.length!==1)return {visible:matching.length>0,text:'',confirmTarget:null,reason:'final-dialog-not-unique'};
  const d=roots[0];
  const parts=[];
  for(const sel of ['[class*="modal__header"]','[class*="modal__body"]']) for(const el of [...d.querySelectorAll(sel)].filter(visible)){const t=txt(el);if(t)parts.push(t);}
  const text=parts.join(' ');
  const nodes=[...d.querySelectorAll('button,span,a,[role="button"]')].filter(visible).filter(e=>txt(e)==='确认发布');
  const buttons=[...new Set(nodes.map(e=>e.tagName==='BUTTON'?e:e.closest('button')).filter(Boolean))];
  if(buttons.length!==1)return {visible:true,text,confirmTarget:null,reason:'final-button-not-unique'};
  const first=nodes[0];
  return {visible:true,text,confirmTarget:{tag:first.tagName,closestButton:first.tagName==='BUTTON'?true:!!first.closest('button')}};
}

// Fresh re-derivation immediately before the single click: re-merge to one modal
// root, re-check the SAME business body equals the expected constant, then resolve
// exactly one enabled semantic BUTTON (a SPAN whose closest button is the control),
// and click it once. Any drift, non-unique modal, or missing/multi/disabled button
// throws and performs zero clicks. No generalized unknown-text acceptance.
function clickFinalConfirmInPage(expectedText) {
  const visible=e=>{const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&getComputedStyle(e).visibility!=='hidden';};
  const norm=s=>String(s||'').replace(/\s+/g,'');
  const txt=e=>(e.innerText||e.textContent||'').replace(/\s+/g,' ').trim();
  const KEY='为保证乘方投放的唯一性';
  const ds=[...document.querySelectorAll('[role="dialog"],[aria-modal="true"],[class*="dialog"],[class*="Dialog"],[class*="modal"],[class*="Modal"]')].filter(visible).filter(d=>txt(d).includes(KEY));
  const roots=ds.filter(m=>!ds.some(o=>o!==m&&o.contains(m)));
  if(roots.length!==1)throw new Error('final-dialog-not-unique');
  const d=roots[0];
  const parts=[];
  for(const sel of ['[class*="modal__header"]','[class*="modal__body"]']) for(const el of [...d.querySelectorAll(sel)].filter(visible)){const t=txt(el);if(t)parts.push(t);}
  if(norm(parts.join(' '))!==norm(expectedText))throw new Error('final-dialog-drift');
  const nodes=[...d.querySelectorAll('button,span,a,[role="button"]')].filter(visible).filter(e=>txt(e)==='确认发布');
  const buttons=[...new Set(nodes.map(e=>e.tagName==='BUTTON'?e:e.closest('button')).filter(Boolean))];
  if(buttons.length!==1||buttons[0].disabled||buttons[0].getAttribute('aria-disabled')==='true'||buttons[0].closest('[aria-disabled="true"],[disabled]'))throw new Error('final-confirm-button-not-uniquely-enabled');
  buttons[0].click();
  return {clicked:true,via:nodes[0].tagName==='BUTTON'?'button':'closest-button'};
}

// ── creation-page guidance: c-lib mask roots + Firefly open-ShadowRoot notices ──
// These live guides are distinct from the product drawer's business 下一步 and
// from the final publish dialog. Only roots inside a visible .c-lib-guide-mask or
// a firefly open ShadowRoot popper may be acted on, with labels bound per root.
const GUIDANCE_ORIGIN = 'https://qianchuan.jinritemai.com';
// A single empty snapshot right after a click can be a transient async gap while
// the next guide root mounts, so an empty read is only trusted as "no guidance"
// after this bounded stable-empty window elapses with no root reappearing.
const GUIDANCE_SETTLE_MS = 600;
const GUIDANCE_SETTLE_POLL_MS = 150;

function isAllowedGuidanceKey(key, accountId) {
  const k = String(key == null ? '' : key);
  if (/^qc_lite_c_guide_/.test(k)) return true;
  if (k === 'compeleted-fireflies' || k === 'user-guide-achieved-tasks') return true;
  return k === 'UNI_PROM_GUIDE_FREQ_OVERALL_' + String(accountId);
}

// Self-contained snapshot/step callback for page.evaluate. One call either reads
// the current guidance roots or executes exactly one bound click after fresh
// re-derivation; anything unexpected stops honestly with zero actions.
function guidanceActionInPage(payload) {
  const accountId = String((payload && payload.accountId) || '');
  const mode = (payload && payload.mode) || 'snapshot';
  const ALLOWED = ['下一步', '我知道了', '知道了', '完成'];
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const txt = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  // Strict parameter semantics: exactly one aavid and it equals the verified
  // account. Substring matching would accept prefix collisions, aavid text
  // inside another parameter, or duplicated conflicting accounts.
  const aavid = new URLSearchParams(String(location.search || '')).getAll('aavid');
  if (location.origin !== 'https://qianchuan.jinritemai.com' || !/^\/uni-creation\/overall-product-multi\/?$/.test(location.pathname) || aavid.length !== 1 || aavid[0] !== accountId) throw new Error('guidance-page-not-authorized');
  // Precise disabled evidence along the real guidance scope (shadow may cross
  // root/host): native disabled, aria-disabled, or an exact standalone disabled
  // token. Scroll-container boundary classes (--disabled-left/right) are not
  // disabled tokens and never match here.
  const isDisabledEl = el => {
    if (!el) return false;
    if (el.disabled === true) return true;
    if (el.getAttribute && el.getAttribute('aria-disabled') === 'true') return true;
    const cn = typeof el.className === 'string' ? el.className : ((el.getAttribute && el.getAttribute('class')) || '');
    return String(cn).split(/\s+/).some(t => t === 'disabled' || t === 'is-disabled' || t === 'c-lib-guide-button-disabled' || t === 'firefly-content__button--disabled');
  };
  const disabledWithin = (rootEl, hostEl, button) => {
    for (let el = button; el; el = el.parentElement || el.parentNode) {
      if (isDisabledEl(el)) return true;
      if (el === rootEl) break;
    }
    return hostEl ? isDisabledEl(hostEl) : false;
  };
  const roots = [];
  const buttons = [];
  const scopes = [];
  const unknown = [];
  const masks = [...document.querySelectorAll('[class*="c-lib-guide-mask"]')].filter(visible);
  const maskRoots = masks.filter(el => !masks.some(o => o !== el && o.contains(el)));
  if (maskRoots.length > 1) unknown.push('guidance-root-duplicate');
  for (const mask of maskRoots.length === 1 ? maskRoots : []) {
    const candidates = [...mask.querySelectorAll('[class*="c-lib-guide-button"]')].filter(visible);
    if (candidates.length !== 1) { unknown.push('guidance-unknown-root-shape'); continue; }
    const button = candidates[0];
    const label = txt(button);
    if (ALLOWED.indexOf(label) === -1) { unknown.push('guidance-unknown-root-shape'); continue; }
    roots.push({ order: roots.length, kind: 'clib', content: txt(mask), label, disabled: disabledWithin(mask, null, button) });
    buttons.push(button);
    scopes.push({ rootEl: mask, hostEl: null });
  }
  // Only a genuine FIREFLY-CONTENT custom element with an open ShadowRoot is
  // guidance scope. An ordinary business widget that merely hosts firefly-shaped
  // classes inside its shadow tree is excluded and never clicked.
  const hosts = [];
  const walkHosts = node => { for (const child of (node.children || [])) { if (child.shadowRoot && String(child.tagName || '').toUpperCase() === 'FIREFLY-CONTENT') hosts.push(child); walkHosts(child); } };
  walkHosts(document.body);
  const fireflyMatches = [];
  for (const host of hosts) {
    let poppers = [];
    try { poppers = [...host.shadowRoot.querySelectorAll('.firefly-popper-content')].filter(visible); } catch (_) { continue; }
    for (const popper of poppers) {
      let candidates = [];
      try { candidates = [...popper.querySelectorAll('.firefly-content__button.firefly-content__next-step-button')].filter(visible); } catch (_) { continue; }
      // A visible genuine popper is always retained for root verification. When
      // it exposes no unique known allowed control (missing button or a changed
      // class), it is reported unknown below rather than silently disappearing
      // from the snapshot and letting the runner conclude "complete".
      fireflyMatches.push({ host, popper, candidates });
    }
  }
  if (fireflyMatches.length > 1) unknown.push('guidance-root-duplicate');
  for (const match of fireflyMatches.length === 1 ? fireflyMatches : []) {
    if (match.candidates.length !== 1) { unknown.push('guidance-unknown-root-shape'); continue; }
    const button = match.candidates[0];
    const label = txt(button);
    if (ALLOWED.indexOf(label) === -1) { unknown.push('guidance-unknown-root-shape'); continue; }
    roots.push({ order: roots.length, kind: 'firefly', content: txt(match.popper), label, disabled: disabledWithin(match.popper, match.host, button) });
    buttons.push(button);
    scopes.push({ rootEl: match.popper, hostEl: match.host });
  }
  if (mode === 'snapshot') return { present: roots.length > 0, unknown: unknown.length ? 'guidance-' + (unknown.indexOf('guidance-root-duplicate') !== -1 ? 'root-duplicate' : 'unknown-root-shape') : null, roots };
  if (unknown.length) throw new Error(unknown.indexOf('guidance-root-duplicate') !== -1 ? 'guidance-root-duplicate' : 'guidance-unknown-root-shape');
  const idx = roots.findIndex(r => r.order === payload.order && r.kind === payload.kind && r.content === payload.content && r.label === payload.label);
  if (idx === -1) throw new Error('guidance-root-drift');
  const button = buttons[idx];
  if (!visible(button)) throw new Error('guidance-button-not-visible');
  if (disabledWithin(scopes[idx].rootEl, scopes[idx].hostEl, button)) throw new Error('guidance-button-disabled');
  button.click();
  return { clicked: true, kind: payload.kind, label: payload.label };
}

// Reads only whitelisted guidance localStorage keys for this account. Never
// touches cookies, tokens, auth or session entries.
function guidanceStorageCaptureInPage(accountId) {
  const allowed = key => (/^qc_lite_c_guide_/.test(key) || key === 'compeleted-fireflies' || key === 'user-guide-achieved-tasks' || key === 'UNI_PROM_GUIDE_FREQ_OVERALL_' + String(accountId));
  const values = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !allowed(key)) continue;
    const value = localStorage.getItem(key);
    if (typeof value === 'string') values.push({ key, value });
  }
  return { values };
}

// Registered via context.addInitScript so it runs before the app scripts of a
// fresh creation document; restores only missing whitelisted guidance flags for
// the exact account and origin, and never overwrites newer live values.
function guidanceRestoreInitScript(payload) {
  try {
    if (location.origin !== payload.origin) return;
    if (!/^\/uni-creation\/overall-product-multi\/?$/.test(location.pathname)) return;
    const aavid = new URLSearchParams(String(location.search || '')).getAll('aavid');
    if (aavid.length !== 1 || aavid[0] !== String(payload.accountId)) return;
    const allowed = key => (/^qc_lite_c_guide_/.test(key) || key === 'compeleted-fireflies' || key === 'user-guide-achieved-tasks' || key === 'UNI_PROM_GUIDE_FREQ_OVERALL_' + String(payload.accountId));
    for (const item of payload.entries || []) {
      if (!item || typeof item.key !== 'string' || typeof item.value !== 'string') continue;
      if (!allowed(item.key)) continue;
      try { if (localStorage.getItem(item.key) === null) localStorage.setItem(item.key, item.value); } catch (_) {}
    }
  } catch (_) {}
}

function validateGuidanceState(state, accountId, origin) {
  if (!state || state.version !== 1 || String(state.accountId) !== String(accountId) || state.origin !== origin || !Array.isArray(state.values)) return { ok: false, reason: 'guidance-state-schema-invalid' };
  const seen = new Set();
  for (const item of state.values) {
    if (!item || typeof item.key !== 'string' || typeof item.value !== 'string') return { ok: false, reason: 'guidance-state-entry-invalid' };
    if (seen.has(item.key)) return { ok: false, reason: 'guidance-state-duplicate-key' };
    if (!isAllowedGuidanceKey(item.key, accountId)) return { ok: false, reason: 'guidance-state-key-not-allowed' };
    seen.add(item.key);
  }
  return { ok: true, values: state.values.map(item => ({ key: item.key, value: item.value })) };
}

function guidanceFilePath(accountId, baseDir) {
  const dir = baseDir || path.join(process.env.LOCALAPPDATA || '', 'PlanPublisher', 'guidance');
  return path.join(dir, String(accountId) + '.json');
}

// A SINGLE pure seam derives BOTH halves of the guidance scope from the same
// account-scoped runtime paths, so the file the driver SAVES is by construction
// the file the run RESTORES. An isolated (generic) shop shares its own
// `<shop-state>/<slug>__<account>/guidance` dir for both; the legacy default keeps
// its historical LOCALAPPDATA location (no baseDir / no privateDir) unchanged.
function guidanceScopeFor(paths) {
  const isolated = !!(paths && paths.isolated && paths.guidanceDir);
  return isolated
    ? { privateDir: paths.guidanceDir, restoreOptions: { baseDir: paths.guidanceDir } }
    : { privateDir: undefined, restoreOptions: {} };
}

function readPrivateGuidanceState(file, accountId, origin = GUIDANCE_ORIGIN) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return { ok: false, reason: 'private-guidance-file-missing' }; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (_) { return { ok: false, reason: 'private-guidance-file-invalid-json' }; }
  const result = validateGuidanceState(parsed, accountId, origin);
  return result.ok ? { ok: true, values: result.values } : { ok: false, reason: result.reason };
}

// Atomic write with full readback. A missing file is created; an existing file
// with any invalid shape (bad JSON, wrong account, unknown key, duplicate key)
// is preserved untouched and the save is refused honestly.
function persistPrivateGuidanceState(file, accountId, values, origin = GUIDANCE_ORIGIN) {
  const incoming = validateGuidanceState({ version: 1, accountId: String(accountId), origin, values: values || [] }, accountId, origin);
  if (!incoming.ok) return { saved: false, reason: incoming.reason };
  let merged = new Map(incoming.values.map(item => [item.key, item.value]));
  if (fs.existsSync(file)) {
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return { saved: false, reason: 'private-guidance-file-invalid-json' }; }
    const existing = validateGuidanceState(parsed, accountId, origin);
    if (!existing.ok) return { saved: false, reason: existing.reason };
    const combined = new Map(existing.values.map(item => [item.key, item.value]));
    for (const item of incoming.values) combined.set(item.key, item.value);
    merged = combined;
  }
  const state = { version: 1, accountId: String(accountId), origin, updatedAt: new Date().toISOString(), values: [...merged.entries()].map(([key, value]) => ({ key, value })) };
  atomicWrite(file, state);
  let readback;
  try { readback = validateGuidanceState(JSON.parse(fs.readFileSync(file, 'utf8')), accountId, origin); } catch (_) { return { saved: false, reason: 'guidance-state-readback-unreadable' }; }
  if (!readback.ok) return { saved: false, reason: 'guidance-state-readback-invalid' };
  if (JSON.stringify(readback.values) !== JSON.stringify(state.values)) return { saved: false, reason: 'guidance-state-readback-mismatch' };
  return { saved: true, count: state.values.length };
}

async function installGuidanceRestore(context, accountId, options = {}) {
  const file = guidanceFilePath(accountId, options.baseDir);
  const read = readPrivateGuidanceState(file, accountId);
  if (!read.ok) return { registered: false, count: 0, reason: read.reason };
  // addInitScript returns a Promise; the before-app guarantee only holds once it
  // resolves. A rejection propagates so the caller never falsely reports
  // registered or continues creating as though the flags were restored.
  await context.addInitScript(guidanceRestoreInitScript, { accountId: String(accountId), origin: GUIDANCE_ORIGIN, entries: read.values });
  return { registered: true, count: read.values.length };
}

// Reads guidance snapshots until either a fresh root appears, an unknown
// non-empty result arrives, or an empty result has been stable for the bounded
// window. This prevents a transient async gap between steps from being mistaken
// for "no more guidance" and finishing the sequence early.
async function settleGuidanceSnapshot(page, accountId) {
  let emptySince = null;
  for (;;) {
    const snap = await page.evaluate(guidanceActionInPage, { mode: 'snapshot', accountId });
    if (snap && snap.unknown) return snap;
    if (snap && snap.present && Array.isArray(snap.roots) && snap.roots.length) return snap;
    const now = Date.now();
    if (emptySince === null) emptySince = now;
    if (now - emptySince >= GUIDANCE_SETTLE_MS) return { present: false, unknown: null, roots: [] };
    await sleep(GUIDANCE_SETTLE_POLL_MS);
  }
}

async function runGuidanceOnPage(page, accountId, maxSteps = 8) {
  const handled = [];
  for (;;) {
    const snap = await settleGuidanceSnapshot(page, accountId);
    if (snap.unknown) throw new Error(String(snap.unknown));
    if (!snap.present) return { handled };
    if (handled.length >= maxSteps) throw new Error('guidance-step-limit-exceeded');
    const root = snap.roots[0];
    await page.evaluate(guidanceActionInPage, { mode: 'step', accountId, order: root.order, kind: root.kind, content: root.content, label: root.label });
    handled.push({ kind: root.kind, label: root.label });
    await until(
      () => page.evaluate(guidanceActionInPage, { mode: 'snapshot', accountId }),
      s => s.unknown === true || !s.present || !s.roots.some(r => r.kind === root.kind && r.content === root.content),
      8000, 'guidance-advance');
  }
}

// After real guidance clicks land, cookies are written back once and the allowed
// guidance flags persist to the private per-account file with readback. Zero
// guidance means zero clicks, zero cookie writes and zero flag writes.
async function runGuidancePhase(page, deps) {
  const { accountId, saveCookies, persistFlags, maxSteps = 8 } = deps;
  const processed = await runGuidanceOnPage(page, accountId, maxSteps);
  if (!processed.handled.length) return { handled: 0, cookieStatus: 'not-needed', flagsSaved: false, flagsReason: null };
  let cookie;
  try { cookie = await saveCookies(); } catch (error) { cookie = { status: 'failed', reason: String((error && error.message) || error) }; }
  if (!cookie || cookie.status !== 'saved' || cookie.conflict === true) return { handled: processed.handled.length, cookieStatus: (cookie && cookie.status) || 'failed', flagsSaved: false, flagsReason: 'cookie-not-saved' };
  let flags;
  try { flags = await persistFlags(); } catch (_) { flags = { saved: false, reason: 'guidance-persist-exception' }; }
  return { handled: processed.handled.length, cookieStatus: 'saved', flagsSaved: flags.saved === true, flagsReason: flags.saved === true ? null : (flags.reason || 'guidance-state-not-saved'), flagCount: flags.count || 0 };
}

// A guidance overlay can appear LATE, right before a native-scroll advance: the probe
// reads the plain page (no overlay), then the native scroll is about to run when a
// 下一步 / 我知道了 popup lands. Such a recognized overlay must be handled by the
// EXISTING guidance phase (real clicks + cookie writeback + private flag readback) and
// then confirmed GONE before the scroll continues -- never scrolled past. This helper
// is the orchestration seam only: every side effect (click, cookie write, flag write)
// happens inside the injected runGuidancePhase, so the caller passes the REAL phase and
// the helper stays offline-testable with a fake page + fake phase.
//
// Contract (fail-closed, no widening of the click/label/recognition surface):
//   * snapshot unknown                -> stop with the ORIGINAL unknown reason (no phase,
//                                        zero clicks, zero scroll)
//   * snapshot absent (none)          -> return handled:0 with ZERO phase / cookie / flag
//                                        work; the caller may continue
//   * snapshot present (known)        -> run the real phase, then require a FRESH
//                                        snapshot to be affirmatively absent before
//                                        allowing continuation; handled>0 with a cookie
//                                        status other than 'saved' or flagsSaved!==true
//                                        stops, and a still-present / unknown fresh
//                                        snapshot stops. A phase that handled 0 (the
//                                        overlay vanished on its own after the probe)
//                                        continues only when the fresh snapshot is absent.
async function handleLateGuidanceBeforeNativeAdvance(page, accountId, runGuidancePhase) {
  const guide = await page.evaluate(guidanceActionInPage, { mode: 'snapshot', accountId });
  if (guide && guide.unknown) throw new Error(String(guide.unknown));
  if (!guide || guide.present !== true) return { handled: 0 };
  const phase = await runGuidancePhase();
  const handled = phase && Number.isInteger(phase.handled) ? phase.handled : 0;
  if (handled > 0 && (phase.cookieStatus !== 'saved' || phase.flagsSaved !== true)) {
    throw new Error('native-advance-guide-state-not-persisted');
  }
  const fresh = await page.evaluate(guidanceActionInPage, { mode: 'snapshot', accountId });
  if (fresh && fresh.unknown) throw new Error(String(fresh.unknown));
  if (fresh && fresh.present) throw new Error('native-advance-guide-overlay-present');
  return { handled };
}

// Passive observer of the page's OWN GET list-products exchanges. It issues no
// fetch and changes no browser/CDP/API behavior; it only attaches request and
// response listeners. Validation is strict: exact endpoint, unique exact
// account, unique tab, empty keyword, unique cursor, HTTP 200, status_code 0,
// native mode 3, boolean hasMore, string cursor, 15-20 digit unique IDs, and a
// per-tab cursor chain whose first request cursor is literally '0'. Only
// desensitized pagination metadata and IDs are retained in memory; raw URLs,
// headers, bodies, cookies and opaque cursor values are never logged or written.
// The numeric category 全部 (tab 1) carries no native hasMore/mode field and is
// deliberately ignored here so the numeric guard path stays authoritative.
function createCatalogTransport(getPage, accountId) {
  let attachedPage = null;
  let onRequest = null;
  let onResponse = null;
  let drawerEpoch = 0;
  let seqCounter = 0;
  const requestMeta = new Map();
  const batches = [];
  const anomalies = [];
  const lastCursorByTab = new Map();
  const consumedCursorsByTab = new Map();
  let processing = Promise.resolve();

  // A request may only mutate state while it is still the current binding: it is
  // attached, its epoch still equals drawerEpoch, and requestMeta still maps it to
  // exactly this meta object (beginDrawerEpoch/detach clear that map). This is
  // re-checked after every await so a beginDrawerEpoch or detach that lands while
  // response.json() is pending cannot let an old/late/rejected body write the new
  // epoch's batches, cursor chain or anomalies.
  function isCurrentBinding(request, meta) {
    if (!attachedPage) return false;
    if (meta.epoch !== drawerEpoch) return false;
    return requestMeta.get(request) === meta;
  }

  function detach() {
    if (attachedPage) {
      if (onRequest) { try { attachedPage.removeListener('request', onRequest); } catch (_) {} }
      if (onResponse) { try { attachedPage.removeListener('response', onResponse); } catch (_) {} }
    }
    attachedPage = null; onRequest = null; onResponse = null;
  }
  function attach() {
    const page = getPage();
    if (!page || typeof page.on !== 'function' || typeof page.removeListener !== 'function') return false;
    if (attachedPage === page) return true;
    detach();
    onRequest = request => {
      let method, url;
      try { method = request.method(); url = request.url(); } catch (_) { return; }
      if (method !== 'GET') return;
      let parsed; try { parsed = new URL(url); } catch (_) { return; }
      if (parsed.origin !== CATALOG_ORIGIN || parsed.pathname !== CATALOG_PATH) return;
      const tabAll = parsed.searchParams.getAll(CATALOG_TAB_KEY);
      const cursorAll = parsed.searchParams.getAll(CATALOG_CURSOR_KEY);
      requestMeta.set(request, { seq: seqCounter++, epoch: drawerEpoch, tab: tabAll.length === 1 ? tabAll[0] : null, cursor: cursorAll.length === 1 ? cursorAll[0] : null, url });
    };
    onResponse = response => { processing = processing.then(() => processResponse(response)).catch(() => {}); };
    page.on('request', onRequest);
    page.on('response', onResponse);
    attachedPage = page;
    return true;
  }
  async function processResponse(response) {
    let request; try { request = response.request(); } catch (_) { return; }
    const meta = requestMeta.get(request);
    if (!meta) return;                      // not an observed catalog request, or issued before attach
    if (meta.epoch !== drawerEpoch) return; // late response from a previous drawer epoch
    if (!isNativeScrollTab(meta.tab)) return; // numeric/unknown tab is not governed by native rules
    const reqCheck = parseCatalogRequestUrl(meta.url, accountId);
    if (!reqCheck.ok) { anomalies.push({ reason: reqCheck.reason, tab: meta.tab }); return; }
    if (reqCheck.tab !== meta.tab || reqCheck.cursor !== meta.cursor) { anomalies.push({ reason: 'catalog-request-shape-drift', tab: meta.tab }); return; }
    let status; try { status = response.status(); } catch (_) { status = null; }
    if (status !== 200) { anomalies.push({ reason: 'catalog-http-status-not-200', tab: meta.tab }); return; }
    let json; try { json = await response.json(); } catch (_) { if (isCurrentBinding(request, meta)) anomalies.push({ reason: 'catalog-response-json-unparseable', tab: meta.tab }); return; }
    // Epoch/detach may have advanced while the body awaited; a stale binding must
    // write nothing to the current epoch.
    if (!isCurrentBinding(request, meta)) return;
    const bodyCheck = parseCatalogResponseBody(json);
    if (!bodyCheck.ok) { anomalies.push({ reason: bodyCheck.reason, tab: meta.tab }); return; }
    const expected = lastCursorByTab.has(meta.tab) ? lastCursorByTab.get(meta.tab) : CATALOG_INITIAL_CURSOR;
    if (meta.cursor !== expected) { anomalies.push({ reason: 'catalog-cursor-chain-broken', tab: meta.tab }); return; }
    const consumed = consumedCursorsByTab.get(meta.tab) || new Set();
    if (consumed.has(meta.cursor)) { anomalies.push({ reason: 'catalog-duplicate-query', tab: meta.tab }); return; }
    consumed.add(meta.cursor);
    consumedCursorsByTab.set(meta.tab, consumed);
    // The opaque response cursor is kept only in memory for chaining; the stored
    // batch carries desensitized pagination metadata and IDs, never a raw url,
    // header, body, cookie or cursor value.
    lastCursorByTab.set(meta.tab, bodyCheck.cursor);
    batches.push({ seq: meta.seq, epoch: drawerEpoch, tab: meta.tab, ids: bodyCheck.ids, hasMore: bodyCheck.hasMore, mode: bodyCheck.mode });
  }
  return {
    attach,
    detach,
    get available() { return !!attachedPage; },
    beginDrawerEpoch() { drawerEpoch++; batches.length = 0; anomalies.length = 0; requestMeta.clear(); lastCursorByTab.clear(); consumedCursorsByTab.clear(); seqCounter = 0; },
    async flush() { try { await processing; } catch (_) {} },
    anomaly() { return anomalies.length ? anomalies[0].reason : null; },
    batchesForTab(tab) { const t = String(tab); return batches.filter(b => b.epoch === drawerEpoch && b.tab === t); },
    firstBatchForTab(tab) { const list = this.batchesForTab(tab); return list.length ? list[0] : null; },
    lastBatchForTab(tab) { const list = this.batchesForTab(tab); return list.length ? list[list.length - 1] : null; },
  };
}

function createRealDrivers(ctx) {
  let page = ctx.page || null;
  const { managerPage, context, dayState, persist, publishedIds, attemptedSet, hints, accountId, opened, projectRoot, planNumber, runId } = ctx;
  // Per-shop business facts threaded into every serialized in-page helper. When a
  // caller (the legacy main / old tests) provides nothing, these fall back to the
  // frozen default business so behaviour is unchanged.
  const isLegacy = ctx.legacyBusiness !== false;
  // STARTING target set. Only the legacy default identity may fall back to the frozen
  // two accounts. A non-legacy shop legitimately begins with NO configured targets
  // (e.g. `--shop NAME` alone, or a config shop whose accountId is null): preparation
  // must be allowed to DISCOVER this shop's real bindable accounts from the live native
  // drawer instead of throwing here. Publication stays fail-closed: the frozen plan
  // carries whatever was actually discovered, and a still-unresolved set can never be
  // frozen/authorized/published.
  const configuredTargets = Array.isArray(ctx.boundAccounts) && ctx.boundAccounts.length
    ? ctx.boundAccounts.map(String)
    : (isLegacy ? wf.BUSINESS.boundAccounts.map(String) : null);
  // Mutable: filled in ONCE by bindAccountsToAll from the positively-settled drawer
  // readback, then threaded into every later serialized helper / modal / commit /
  // result gate so the whole run uses one immutable discovered set (never a fixed
  // array, never the legacy pair). Read-only exposed as `resolvedBoundAccounts`.
  let resolvedTargets = configuredTargets;
  const productsPerPlan = Number.isInteger(ctx.productsPerPlan) ? ctx.productsPerPlan : wf.BUSINESS.productsPerPlan;
  // 目标 ROI（客户 2026-10-11）：由当前店铺 trusted business 提供；缺失/非法回落 15。
  // 严格：只接受正有限 number（支持 13.5），绝不 Number() 脏值。
  const business = wf.bizOf(ctx.business);
  const targetRoi = (function () {
    const r = business && business.roi;
    return (typeof r === 'number' && Number.isFinite(r) && r > 0) ? r : 15;
  })();
  // 日预算（客户 2026-10-11 S4：排程 policy.dailyBudget 可含 450）：同样由本店 trusted
  // business 提供；缺失/非法回落 legacy 300，legacy 原行为逐字节不变。
  const targetBudget = (function () {
    const b = business && business.dailyBudget;
    return (typeof b === 'number' && Number.isFinite(b) && b > 0) ? b : 300;
  })();
  const creationUrl = ctx.creationUrl || CREATION_URL;
  const managementUrl = ctx.managementUrl || MANAGEMENT_URL;
  // While unresolved the payload carries an explicit discovery marker; helpers must
  // never fall back to the legacy default for a generic shop.
  const targetPayload = () => (resolvedTargets ? { targets: resolvedTargets } : { targets: null, discovery: true });
  const transport = createCatalogTransport(() => page, accountId);
  // S21 private per-picker-epoch position ledger: for every product THIS run actually
  // selects, record its trusted provenance BEFORE the select click, proven by the existing
  // fresh strict reads (settleProductPage's account/route/unique-drawer/category/
  // complete-card proofs — for numeric 全部 the observed page number, for a native scroll
  // category the observed category/tab plus its fresh bound catalog chain — plus selectCard's
  // own unique-drawer card-presence/checked-false read). In-memory only, never persisted,
  // never derived from cursor/hints old values. It exists solely so an auto-pull dialog that
  // lists an already selected product from an EARLIER page/category can be walked back to
  // with a positive same-epoch proof; anything without such a proof keeps the original
  // honest auto-pull-product-not-visible stop. S23: a native entry records ONLY
  // {epoch,cat,tab,native:true} — never a numeric page (a native scroll category must never
  // masquerade as one); its retrieval re-observes the category through the existing strict
  // switchCategory/nativeAdvance chain, never through numeric paging.
  let pickerEpoch = 0;
  const selectedPositions = new Map();
  let pickerRunContext = null;
  // Bounded wait for native catalog settling/advancement. Production uses the
  // frozen default; tests may shrink it to keep no-progress stops fast. The
  // bound only limits waiting — it never converts a timeout into EOF.
  const nativeTimeoutMs = Number.isInteger(ctx.nativeScrollTimeoutMs) && ctx.nativeScrollTimeoutMs > 0 ? ctx.nativeScrollTimeoutMs : NATIVE_SCROLL_TIMEOUT_MS;
  // Bounded read-only waits for the management SPA. These never convert a timeout
  // into success and never click: they gate the tab click behind a real, hydrated
  // account identity. The identity must report the target accountId (a premature
  // null/unknown after goto fails here), and any tab-mount / route field the reader
  // actually reports must be trustworthy: a reported url must match the qianchuan
  // route, and a reported hasSubTabs/hasChengfangNav must be true (the real
  // readChengfangAccountInPage reports all of these, defaulting false before
  // hydration, so a false/unmounted tab is never guessed true). Fields a minimal
  // legacy reader omits are not demanded. Tests may shrink the bounds; production 15/30s.
  const managementHydrateTimeoutMs = Number.isInteger(ctx.managementHydrateTimeoutMs) && ctx.managementHydrateTimeoutMs > 0 ? ctx.managementHydrateTimeoutMs : MANAGEMENT_HYDRATE_TIMEOUT_MS;
  const managementTabSettleTimeoutMs = Number.isInteger(ctx.managementTabSettleTimeoutMs) && ctx.managementTabSettleTimeoutMs > 0 ? ctx.managementTabSettleTimeoutMs : MANAGEMENT_TAB_SETTLE_TIMEOUT_MS;
  const successManagementReadTimeoutMs = Number.isInteger(ctx.successManagementReadTimeoutMs) && ctx.successManagementReadTimeoutMs > 0 ? ctx.successManagementReadTimeoutMs : SUCCESS_MANAGEMENT_READ_TIMEOUT_MS;
  // The completeness predicate is SHARED by the fallback cold-goto read and the R40
  // redirected-page direct read: a row is complete only when the name matches uniquely
  // (or >1 rows) with a legal new plan id and every required field actually present.
  function managementRowComplete(expectedAccount) {
    return x => x && (x.rowCount > 1 || (x.rowCount === 1 && String(x.accountId) === String(expectedAccount) && x.rows[0]
      && /^\d{12,20}$/.test(String(x.rows[0].planId || ''))
      && x.rows[0].productCount !== null && x.rows[0].accountCount !== null && x.rows[0].roi !== null
      && x.rows[0].dailyBudget !== null && x.rows[0].commissionIncluded !== null && !!x.rows[0].status));
  }
  function managementIdentityHydrated(identity, expectedId) {
    if (!identity) return false;
    if (String(identity.accountId) !== String(expectedId)) return false;
    if (typeof identity.url === 'string' && identity.url !== '' && !MANAGEMENT_ROUTE_RE.test(identity.url)) return false;
    if (typeof identity.hasSubTabs === 'boolean' && identity.hasSubTabs !== true) return false;
    if (typeof identity.hasChengfangNav === 'boolean' && identity.hasChengfangNav !== true) return false;
    return true;
  }
  async function settleManagementIdentity(expectedId) {
    try {
      const identity = await until(() => managerPage.evaluate(ctx.readAccountInPage), x => managementIdentityHydrated(x, expectedId), managementHydrateTimeoutMs, 'management-identity-hydrate');
      return { ok: true, identity };
    } catch (error) {
      const msg = String((error && error.message) || '');
      return { ok: false, reason: /management-identity-hydrate-timeout/.test(msg) ? 'management-identity-hydrate-timeout' : 'management-identity-hydrate-failed' };
    }
  }
  // ── R36: bounded SPA list-stability settle (read-only, never a fixed sleep) ────
  // A fresh goto / sub-tab switch shows the previous tab's cached total (e.g. 1)
  // and an intermediate total that later grows (e.g. 10 -> 32). The FIRST numeric
  // total is NOT settled data. A snapshot is trusted only when rows + pagination
  // are complete AND two consecutive reads agree exactly (same total / pageSize /
  // activePage / rows length) AND the pagination is arithmetically consistent:
  // hasNext === (activePage < ceil(total/pageSize)). A transient total like 10 with
  // pageSize 10 but hasNext true (4 real pages) fails that invariant and is waited
  // out, never used as the freeze base. A timeout is an honest refusal, never a success.
  function shopSnapshotShape(rows, pagination) {
    if (!pagination || !rows || !Array.isArray(rows.rows)) return null;
    const total = Number(pagination.total), pageSize = Number(pagination.pageSize), activePage = Number(pagination.activePage);
    if (!Number.isInteger(total) || total < 0 || !Number.isInteger(pageSize) || pageSize < 1 || !Number.isInteger(activePage) || activePage < 1) return null;
    if (typeof pagination.hasNext !== 'boolean') return null;
    const expectedPages = Math.ceil(total / pageSize);
    if (pagination.hasNext !== (activePage < expectedPages)) return null;
    return { total, pageSize, activePage, hasNext: pagination.hasNext, rows: rows.rows, emptyState: rows.emptyState === true };
  }
  async function settleShopTabList(readRows, readPagination, expectedActivePage) {
    let prev = null;
    const requirePage = Number.isInteger(expectedActivePage);
    return until(async () => {
      const [rows, pagination] = await Promise.all([managerPage.evaluate(readRows), managerPage.evaluate(readPagination)]);
      const shape = shopSnapshotShape(rows, pagination);
      if (!shape) { prev = null; return null; }
      // R38: when the caller is waiting for a SPECIFIC page (page 1 after goFirst),
      // a consistent-but-OLD page is never "settled" -- the SPA may still be showing
      // the previous page (e.g. page 4) twice in a row. Only the target page counts,
      // and it must still be twice-consecutive-consistent. This never re-clicks first
      // and never sleeps: a page that never arrives is a bounded timeout (the caller
      // refuses), not a false success.
      if (requirePage && shape.activePage !== expectedActivePage) { prev = null; return null; }
      const sig = JSON.stringify([shape.total, shape.pageSize, shape.activePage, shape.hasNext, shape.rows.length, shape.emptyState]);
      if (prev && prev.sig === sig) return { shape, stable: true };
      prev = { sig };
      return null;
    }, x => x !== null && x.stable === true, managementTabSettleTimeoutMs, 'shop-tab-list-settle');
  }
  // A native switch is settled only when the active normalized label matches, the
  // bound first batch (request cursor '0') for this exact tab is captured, and the
  // visible DOM card IDs equal that batch's IDs. A transient empty list before the
  // bound batch arrives is never treated as an empty-category success.
  function nativeSwitchSettled(snap, batch) {
    if (!snap || !snap.ok || !batch) return false;
    const domIds = snap.cards.map(c => String(c.id || '')).filter(Boolean).slice().sort();
    const batchIds = (batch.ids || []).slice().sort();
    if (domIds.length !== batchIds.length) return false;
    for (let i = 0; i < domIds.length; i++) if (domIds[i] !== batchIds[i]) return false;
    return true;
  }
  // A product page is "complete, unique and valid" only when it is non-empty and every
  // visible card carries a distinct 15-20-digit id. A transient empty list or a duplicate /
  // invalid id during a re-render is NOT a stable error, and never a dedup/skip: the caller
  // bounded-waits for the SAME picker / category / page / epoch + a normal footer and no
  // unknown-checked drift to settle to a real complete unique valid list before it selects,
  // pages or submits. Genuine identity drift stops immediately instead of being waited away.
  function listPageComplete(snap) {
    const cards = (snap && Array.isArray(snap.cards)) ? snap.cards : [];
    if (cards.length === 0) return false;
    const ids = cards.map(c => (c && c.id != null ? String(c.id) : ''));
    if (ids.length !== cards.length) return false;
    if (ids.some(id => !/^\d{15,20}$/.test(id))) return false;
    return ids.length === new Set(ids).size;
  }
  // Bounded read-only settle of the current product list right after an open / category
  // switch / page advance. NO business action is performed here — only drawer / observe /
  // transport flush reads. The very first read decides whether the page is already a
  // trustworthy complete unique valid list; a transient blank/duplicate retries within the
  // bound, while any real drift (drawer not unique, tab/category, numeric page, footer/
  // capacity, unknown checked set, account, main-table) throws immediately so the whole
  // workflow stops with zero unproven selection / paging / submit.
  async function settleProductPage({ cat, native, tab, pageNo, selectedIds, baseSelectedCount }) {
    const read = async () => {
      const snap = await page.evaluate(drawerSnapshotInPage);
      if (!snap || snap.ok !== true) throw new Error('current-product-page-drawer-not-unique');
      if (!categoryIsActive(snap, cat)) throw new Error('current-product-page-category-not-active');
      // The visible checked set is checked before the footer count: an unknown card showing
      // as checked is the more specific identity violation and must report as checked-drift
      // even when the same fault also shifts the footer selectedCount (they can co-occur).
      const checkedNow = snap.cards.filter(c => c.checked === true && c.id).map(c => String(c.id));
      if (checkedNow.some(id => !selectedIds.includes(id))) throw new Error('current-product-page-checked-drift');
      if (!pickerBatchStateMatches(snap, baseSelectedCount, selectedIds.length - baseSelectedCount)) throw new Error('current-product-page-footer-capacity-drift');
      if (native) {
        await transport.flush();
        const anomaly = transport.anomaly();
        if (anomaly) throw new Error('native-catalog-anomaly:' + anomaly);
        const lastBatch = transport.lastBatchForTab(tab);
        if (!lastBatch) throw new Error('native-catalog-first-batch-missing');
        // A LEGAL empty native category is bound to this round's hasMore=false + empty response
        // ids + empty DOM. A non-empty bound response (or hasMore still true) whose DOM is empty
        // /duplicate is a transient to settle, never an exhausted / empty-category completion.
        if (lastBatch.hasMore === false && (lastBatch.ids || []).length === 0 && snap.cards.length === 0) return { snap, empty: true, complete: true };
        return { snap, empty: false, complete: listPageComplete(snap) };
      }
      // Numeric categories stay anchored to the REAL observe page identity — never native
      // transport data: the same product modal present plus the exact expected currentPage. When
      // observe also reports the creation identity it must be this account with a unique main
      // table, EXCEPT for the exact "known-first-empty" shape proven live in R27: a genuinely
      // first-ever plan (baseSelectedCount===0) whose creation page has not built its main table
      // yet (mainTableUnique is false ONLY because there are ZERO roots and ZERO rows, never
      // because roots are ambiguous/foreign), on this exact origin/path, with this exact account,
      // with every zero-count field affirmatively present and equal to 0/[] — not merely absent
      // or undefined. Anything else (a missing/unknown field, more than one root, any foreign
      // product row, a base>0 backfill that finds no table, or a wrong account) keeps the
      // original strict rejection. A normal mainTableUnique===true page is untouched.
      const obs = await observe();
      const pg = obs && obs.pagination;
      if (!pg || pg.modalPresent !== true || pg.inProductModal !== true) throw new Error('current-product-page-pagination-observation-incomplete');
      if (pg.currentPage !== pageNo) throw new Error('current-product-page-number-drift');
      if (obs && obs.creation) {
        const c = obs.creation;
        const knownFirstEmptyShape = baseSelectedCount === 0
          && c.mainTableUnique === false
          && Array.isArray(c.mainRootEvidence) && c.mainRootEvidence.length === 0
          && c.productRowCount === 0
          && Array.isArray(c.rows) && c.rows.length === 0
          && Array.isArray(c.productIds) && c.productIds.length === 0
          && c.uniqueProductCount === 0
          && c.originOk === true
          && c.pathOk === true
          && String(c.accountId) === String(accountId);
        if (!knownFirstEmptyShape) {
          if (c.mainTableUnique !== true) throw new Error('current-product-page-main-table-not-unique');
          if (String(c.accountId) !== String(accountId)) throw new Error('current-product-page-account-drift');
        }
      }
      return { snap, empty: false, complete: listPageComplete(snap) };
    };
    let r;
    try { r = await until(read, x => x.complete === true, nativeTimeoutMs, 'current-product-page-settle'); }
    catch (error) {
      // A drift/anomaly thrown by a read surfaces at once (never waited for to disappear).
      // Only a persistent complete-less list (empty / duplicate / invalid ids on an otherwise
      // coherent page) reaches the bound: stop with an explicit reason and zero unproven actions.
      if (/current-product-page-settle-timeout/.test(String(error && error.message || ''))) throw new Error('current-product-page-not-stable-empty-or-duplicate');
      throw error;
    }
    return r;
  }
  async function observe() { return page.evaluate(guard.pageObserve); }
  async function drawer() {
    const snap=await page.evaluate(drawerSnapshotInPage);
    if(!snap.ok)throw new Error(snap.reason);
    return snap;
  }
  async function waitForDrawer() { return until(()=>page.evaluate(drawerSnapshotInPage), x=>x.ok, 15000, 'product-drawer'); }
  async function switchCategory(category) {
    const before=await drawer();
    if (isNativeScrollCategory(category)) {
      const tab=catalogTabForCategory(category);
      if(!tab)throw new Error('native-category-tab-unknown:'+category);
      if(!transport.attach())throw new Error('native-catalog-transport-unavailable');
      const already=categoryIsActive(before,category);
      // An already-active native category must not be re-clicked and must not wait
      // for a new response that will never come; reuse a fresh bound first batch.
      if(!already)await page.evaluate(clickDrawerTabInPage,category);
      const after=await until(async()=>{
        await transport.flush();
        const snap=await page.evaluate(drawerSnapshotInPage);
        return {snap,batch:transport.firstBatchForTab(tab),anomaly:transport.anomaly()};
      },x=>!!x.anomaly||(x.snap.ok&&categoryIsActive(x.snap,category)&&nativeSwitchSettled(x.snap,x.batch)),nativeTimeoutMs,'native-category-switch');
      if(after.anomaly)throw new Error('native-catalog-anomaly:'+after.anomaly);
      if(!after.batch)throw new Error('native-catalog-first-batch-missing');
      const scrollState=await page.evaluate(nativeScrollStateInPage);
      if(!scrollState.ok)throw new Error(scrollState.reason||'native-scroll-root-unknown');
      if(scrollState.scrollTop!==0)throw new Error('native-scroll-root-not-at-top');
      return after.snap;
    }
    const action=await page.evaluate(clickDrawerTabInPage,category);
    const beforeIds=before.cards.map(x=>x.id).filter(Boolean).sort().join(',');
    const after=await until(()=>page.evaluate(drawerSnapshotInPage),x=>x.ok&&categoryIsActive(x,category)&&(!action.clicked||x.cards.map(c=>c.id).filter(Boolean).sort().join(',')!==beforeIds),10000,'category-tab-and-cards');
    const afterObs=await observe();
    if(afterObs.pagination.currentPage!==1||!categoryIsActive(after,category))throw new Error('category-switch-page-state-unknown');
    return after;
  }
  async function changePage(context) {
    const beforeObs=await observe(); const before=await drawer();
    if(beforeObs.pagination.currentPage==null||!beforeObs.pagination.inProductModal||beforeObs.pagination.modalPresent!==true)throw new Error('pagination-observation-incomplete');
    const command={observation:beforeObs.observation,kind:'next'};
    let target;
    try { target=guard.resolvePageTarget(beforeObs,command); }
    catch(error) {
      // Only a live explicit boundary is category exhaustion. Missing/unknown
      // controls and stale observations stop the whole workflow.
      const msg=String(error&&error.message||'');
      if(/Already at next boundary|next control disabled/.test(msg))return {boundary:true,currentPage:beforeObs.pagination.currentPage};
      // R28: the real "全部" (All) numeric pager renders its next step as a bare svg-only
      // li (see numericPickerPagingInPage's header comment) that the frozen generic
      // resolvePageTarget correctly cannot see. This is a genuine All-closure gap, not a
      // native-scroll issue and not a stale/ambiguous observation: fall back ONLY for the
      // exact All numeric category, never for a native-scroll category or an unknown one.
      if(/No observed next control/.test(msg) && context && context.cat==='全部' && context.native===false) {
        // R29: the real All pager's numbered "2" IS a generically observable leaf, so when this
        // fresh observation affirmatively carries exactly one enabled number leaf for the next
        // page, the guard-native leaf click is the correct advance and the svg-only next li never
        // gets clicked. Only a genuinely unobserved next number falls through to R28's svg proof.
        // R30: the real All window can also sit briefly UNRENDERED right after the open / the first
        // cursor-restore click (live proof: ok=true drawer, 0 cards, footer kept, currentPage 1 and
        // only the current number leaf, and the complete unique valid list plus number "2" landing a
        // beat later). Classifying from that stale observation mistook the not-yet-arrived "2" for a
        // permanent absence and sent a still-loading page into the strict svg proof, which timed out
        // while the number would have worked. So FIRST reuse the existing bounded read-only
        // settleProductPage on the current page — transient blank/duplicate/invalid cards wait under
        // its same contract (same bound, no new sleep constant, no extra timeout budget, no repeated
        // click), while account/category/page/footer/capacity/checked/main drift still stops
        // immediately — THEN re-read a FRESH observe + drawer of the SAME currentPage and decide the
        // target only from it: an observed next number takes the R29 leaf once (svg untouched), a
        // number still genuinely absent on a settled page keeps R28's strict svg proof. The generic
        // next path and the three native paths are untouched.
        const readinessPage=beforeObs.pagination.currentPage;
        const readinessSelected=(context.selectedIds||[]).map(String);
        await settleProductPage({cat:context.cat,native:false,pageNo:readinessPage,selectedIds:readinessSelected,baseSelectedCount:context.baseSelectedCount});
        const freshObs=await observe();
        if(!freshObs||!freshObs.pagination||freshObs.pagination.modalPresent!==true||freshObs.pagination.inProductModal!==true||freshObs.pagination.currentPage!==readinessPage)throw new Error('all-pager-readiness-observation-drift');
        const fresh=await drawer();
        const numericLeaf=await changePageViaNumericLeafPager(context, freshObs, fresh);
        if(numericLeaf) return numericLeaf;
        return changePageViaNumericOvuiPager(context, freshObs, fresh);
      }
      throw error;
    }
    await page.evaluate(guard.pageApply,{...target,observation:beforeObs.observation});
    const beforeIds=before.cards.map(c=>c.id).filter(Boolean).sort().join(',');
    const activeBefore=(before.activeTabs||[]).map(x=>String(x).replace(/\s/g,'')).sort().join('|');
    const after=await until(async()=>({obs:await observe(),snap:await page.evaluate(drawerSnapshotInPage)}),x=>x.snap.ok&&x.obs.pagination.currentPage!==beforeObs.pagination.currentPage&&x.snap.cards.map(c=>c.id).filter(Boolean).sort().join(',')!==beforeIds,15000,'page-change');
    const check=guard.evaluatePageConfirmation(beforeObs.pagination,{kind:'next'},after.obs.pagination);
    const activeAfter=(after.snap.activeTabs||[]).map(x=>String(x).replace(/\s/g,'')).sort().join('|');
    if(check.confirmed!==true||after.obs.pagination.currentPage!==beforeObs.pagination.currentPage+1||activeBefore!==activeAfter)throw new Error('page-advance-not-exactly-confirmed');
    return {...after,confirmed:true,observedPage:after.obs.pagination.currentPage};
  }
  // The strict All-numeric-ovui fallback (see numericPickerPagingInPage's header comment).
  // The mode:'next' evaluate re-verifies EVERYTHING (origin/path/aavid, unique account,
  // no blocking overlay, unique drawer, 全部 active, unique pagination-wrapper/
  // ovui-pagination/ul.ovui-page-turner, unique active-current-page li, unique next li,
  // explicit-only disabled token, footer/capacity, checked-drift) synchronously in-page
  // before its one and only click; any unproven shape returns ok:false with zero clicks
  // and must stop the whole workflow immediately (never caught and continued past).
  // After a proven click, a bounded FRESH read-only re-verification (never a re-click)
  // waits for the exact landing state: active page === before+1, a complete non-empty
  // unique valid card set that actually changed, the footer/capacity preserved, the
  // category still active, and no unknown-checked drift. A timeout or any intermediate
  // unproven state is a hard stop — never a false confirmed and never a stale pageNo+1.
  async function changePageViaNumericOvuiPager(context, beforeObs, before) {
    const expectedCurrentPage = beforeObs.pagination.currentPage;
    const beforeIds = before.cards.map(c => c.id).filter(Boolean).sort().join(',');
    const payload = {
      mode: 'next', expectedCurrentPage,
      expectedSelectedCount: before.selectedCount, expectedCapacity: before.remainingCapacity,
      selectedIds: context.selectedIds || [], accountId,
    };
    const next = await page.evaluate(numericPickerPagingInPage, payload);
    if (!next || next.ok !== true) throw new Error('numeric-ovui-page-advance-not-proven:' + (next && next.reason || 'unknown'));
    if (next.boundary === true) return { boundary: true, currentPage: next.currentPage };
    if (next.clicked !== true) throw new Error('numeric-ovui-page-advance-not-clicked');
    const readPayload = { mode: 'read', expectedCurrentPage: null, selectedIds: context.selectedIds || [], accountId };
    const after = await until(async () => ({
      result: await page.evaluate(numericPickerPagingInPage, readPayload),
      snap: await page.evaluate(drawerSnapshotInPage),
    }), x => x.result.ok === true
      && x.result.currentPage === expectedCurrentPage + 1
      && x.snap.ok === true && categoryIsActive(x.snap, '全部') && listPageComplete(x.snap)
      && x.snap.cards.map(c => c.id).filter(Boolean).sort().join(',') !== beforeIds
      && x.result.footerSelectedCount === before.selectedCount
      && x.result.footerRemainingCapacity === before.remainingCapacity
      && x.result.checkedIds.every(id => (context.selectedIds || []).map(String).includes(id)),
      nativeTimeoutMs, 'numeric-ovui-page-advance');
    return { confirmed: true, observedPage: after.result.currentPage, snap: after.snap };
  }
  // R29 narrow helper: advance the All numeric picker through the FROZEN generic guard by
  // clicking the observed, affirmatively-enabled number leaf of currentPage+1. The leaf must come
  // from the same fresh observation, must be strictly unique and affirmatively enabled (a
  // duplicate, a disabled leaf or any unknown state is a zero-action stop that is never routed
  // around), and never a jump input, an arbitrary page or a hand-made DOM index. Before the
  // single guard click the existing frozen reads re-prove the same scope (unique All drawer,
  // footer delta/capacity, checked subset, main table vs this round's base, account/origin/path,
  // no guide overlay); pageApply performs its own fresh read before that click. After it, a
  // bounded read-only re-verification must land on exactly currentPage+1 with a complete,
  // unique, valid and actually changed card set, preserved footer, no checked drift and the same
  // account/category — a paged:true dispatch alone is never success, and nothing is re-clicked.
  // Returns null ONLY when no next number leaf was observed, keeping R28's svg fallback in force.
  async function changePageViaNumericLeafPager(context, beforeObs, before) {
    const currentPage = beforeObs.pagination.currentPage;
    const nextPage = currentPage + 1;
    const classify = items => {
      const matches = (Array.isArray(items) ? items : [])
        .filter(i => !!i && i.kind === 'number' && i.page === nextPage && Number.isInteger(i.index) && i.index >= 0);
      if (matches.length === 0) return 'absent';
      if (matches.length > 1) return 'duplicate';
      if (matches[0].disabled !== false) return 'disabled-or-unknown';
      return 'ready';
    };
    const initial = classify(beforeObs.pagination.items);
    if (initial === 'absent') return null;
    if (initial === 'duplicate') throw new Error('numeric-leaf-next-page-control-duplicate');
    if (initial === 'disabled-or-unknown') throw new Error('numeric-leaf-next-page-control-disabled-or-unknown');
    const selectedIds = (context.selectedIds || []).map(String);
    await settleProductPage({ cat: context.cat, native: false, pageNo: currentPage, selectedIds, baseSelectedCount: context.baseSelectedCount });
    const scope = await page.evaluate(numericPickerPagingInPage, {
      mode: 'read', expectedCurrentPage: currentPage,
      expectedSelectedCount: before.selectedCount, expectedCapacity: before.remainingCapacity,
      selectedIds, accountId,
    });
    if (!scope || scope.ok !== true) throw new Error('numeric-leaf-scope-not-proven:' + (scope && scope.reason || 'unknown'));
    if (scope.currentPage !== currentPage) throw new Error('numeric-leaf-scope-page-drift');
    if (String(scope.accountId) !== String(accountId)) throw new Error('numeric-leaf-scope-account-drift');
    const guide = await page.evaluate(guidanceActionInPage, { mode: 'snapshot', accountId });
    if (guide && guide.unknown) throw new Error(String(guide.unknown));
    if (guide && guide.present) throw new Error('numeric-leaf-guide-overlay-present');
    const targetObs = await observe();
    if (!targetObs || !targetObs.pagination || targetObs.pagination.modalPresent !== true
      || targetObs.pagination.inProductModal !== true || targetObs.pagination.currentPage !== currentPage) {
      throw new Error('numeric-leaf-target-observation-not-fresh');
    }
    if (classify(targetObs.pagination.items) !== 'ready') throw new Error('numeric-leaf-target-control-not-uniquely-enabled');
    const target = guard.resolvePageTarget(targetObs, { observation: targetObs.observation, page: nextPage });
    if (!target || target.mode !== 'click' || target.expectKind !== 'number' || target.expectPage !== nextPage) {
      throw new Error('numeric-leaf-target-not-number-click');
    }
    const beforeIds = before.cards.map(c => c.id).filter(Boolean).sort().join(',');
    const activeBefore = (before.activeTabs || []).map(x => String(x).replace(/\s/g, '')).sort().join('|');
    await page.evaluate(guard.pageApply, { ...target, observation: targetObs.observation });
    const after = await until(async () => ({
      obs: await observe(),
      result: await page.evaluate(numericPickerPagingInPage, { mode: 'read', expectedCurrentPage: null, selectedIds, accountId }),
      snap: await page.evaluate(drawerSnapshotInPage),
    }), x => x.obs.pagination && x.obs.pagination.currentPage === nextPage
      && x.result.ok === true && x.result.currentPage === nextPage
      && String(x.result.accountId) === String(accountId)
      && x.result.footerSelectedCount === before.selectedCount
      && x.result.footerRemainingCapacity === before.remainingCapacity
      && x.result.checkedIds.every(id => selectedIds.includes(id))
      && x.snap.ok === true && categoryIsActive(x.snap, '全部') && listPageComplete(x.snap)
      && x.snap.cards.map(c => c.id).filter(Boolean).sort().join(',') !== beforeIds,
      nativeTimeoutMs, 'numeric-leaf-page-advance');
    const activeAfter = (after.snap.activeTabs || []).map(x => String(x).replace(/\s/g, '')).sort().join('|');
    if (activeBefore !== activeAfter) throw new Error('numeric-leaf-category-drift');
    return { confirmed: true, observedPage: after.obs.pagination.currentPage, snap: after.snap };
  }
  // S21 narrow helper: step the All numeric picker BACKWARD by exactly one page through the
  // frozen strict in-page proof (numericPickerPagingInPage mode 'prev' — unique drawer /
  // account / route / category / page / footer / checked-subset all re-read synchronously
  // before the single prev-icon click; missing / duplicate / disabled-or-unknown control is
  // a zero-click refusal). After the proven click, a bounded FRESH read-only re-verification
  // (never a re-click) waits for the exact landing: observe + pager read both on
  // currentPage-1, a complete unique valid card set that actually changed, footer/capacity
  // preserved, category still 全部, account identical, no unknown-checked drift; then
  // settleProductPage re-proves drawer / category / observed page / footer / checked subset /
  // creation main-table identity on the landed page. A timeout or any drift is a hard stop.
  // Only the numeric category 全部 may ever route here; a native scroll category is never
  // paged numerically.
  async function stepAllNumericPrev(context, curPage) {
    const before = await drawer();
    const selectedIds = (context.selectedIds || []).map(String);
    const res = await page.evaluate(numericPickerPagingInPage, {
      mode: 'prev', expectedCurrentPage: curPage,
      expectedSelectedCount: before.selectedCount, expectedCapacity: before.remainingCapacity,
      selectedIds, accountId,
    });
    if (!res || res.ok !== true) throw new Error('numeric-prev-page-step-not-proven:' + (res && res.reason || 'unknown'));
    if (res.boundary === true) throw new Error('numeric-prev-page-boundary-unexpected');
    if (res.clicked !== true) throw new Error('numeric-prev-page-step-not-clicked');
    const beforeIds = before.cards.map(c => c.id).filter(Boolean).sort().join(',');
    const after = await until(async () => ({
      result: await page.evaluate(numericPickerPagingInPage, { mode: 'read', expectedCurrentPage: null, selectedIds, accountId }),
      snap: await page.evaluate(drawerSnapshotInPage),
      obs: await observe(),
    }), x => x.result.ok === true && x.result.currentPage === curPage - 1
      && x.obs.pagination && x.obs.pagination.modalPresent === true && x.obs.pagination.inProductModal === true && x.obs.pagination.currentPage === curPage - 1
      && String(x.result.accountId) === String(accountId)
      && x.result.footerSelectedCount === before.selectedCount
      && x.result.footerRemainingCapacity === before.remainingCapacity
      && x.result.checkedIds.every(id => selectedIds.includes(String(id)))
      && x.snap.ok === true && categoryIsActive(x.snap, '全部') && listPageComplete(x.snap)
      && x.snap.cards.map(c => c.id).filter(Boolean).sort().join(',') !== beforeIds,
      nativeTimeoutMs, 'numeric-prev-page-step');
    await settleProductPage({ cat: '全部', native: false, pageNo: curPage - 1, selectedIds, baseSelectedCount: context.baseSelectedCount });
    return after.result.currentPage;
  }
  // S21: cancel an auto-pull-identified product that is NOT on the current visible page.
  // Invisible ≠ unselected: ONLY when the id is positively proven (a) to belong to this
  // batch's live logical selection and (b) to carry a same-epoch trusted numeric 全部
  // position recorded before its own select click, walk the All numeric pager back with the
  // narrow strict prev step, deselect the UNIQUE card once after verifying it is explicitly
  // checked true, await the real checked=false landing with the footer/capacity closed, sync
  // the logical selection, re-prove full page identity (account / route / unique All drawer /
  // observed page / complete card set / checked subset / footer / main table), then walk
  // forward to the ORIGINAL page through the existing frozen next-only changePage proofs so
  // the caller resumes exactly where it stopped with the original cursor semantics. S23: a
  // trusted same-epoch NATIVE provenance is delegated to deselectAutoPullNativeOffCategory
  // (strict category-switch retrieval, never numeric paging). Anything
  // unproven (no position, stale epoch, not in batch, native provenance missing/foreign,
  // position ahead of current, unbounded distance, control not uniquely enabled, card not
  // unique, checked not explicitly true, any drift, failed landing, failed return) keeps the
  // ORIGINAL honest stop with zero further submission — never a guessed cancel, never a
  // batch wipe, never a picker re-open bypass.
  async function deselectAutoPullProductOffPage(id, pendingCheckedId) {
    const run = pickerRunContext;
    const pos = selectedPositions.get(String(id));
    if (!run || !pos || pos.epoch !== pickerEpoch) throw new Error('auto-pull-product-not-visible:' + id);
    if (!(dayState.lastSelected || []).map(String).includes(String(id))) throw new Error('auto-pull-product-not-visible:' + id);
    const unionSelected = () => {
      const s = (dayState.lastSelected || []).map(String);
      if (pendingCheckedId != null && !s.includes(String(pendingCheckedId))) s.push(String(pendingCheckedId));
      return s;
    };
    const obsNow = await observe();
    if (!obsNow || !obsNow.pagination || obsNow.pagination.modalPresent !== true || obsNow.pagination.inProductModal !== true || !Number.isInteger(obsNow.pagination.currentPage)) {
      throw new Error('auto-pull-offpage-current-observation-incomplete');
    }
    const fromPage = obsNow.pagination.currentPage;
    // S23: an off-category NATIVE provenance is retrieved through the existing strict
    // native chain (switchCategory + fresh bound first batch + nativeAdvance EOF proofs),
    // never through numeric paging; everything else keeps the original honest stop.
    if (pos.native === true) {
      await deselectAutoPullNativeOffCategory(id, pos, run, fromPage, unionSelected);
      return;
    }
    if (pos.cat !== '全部' || !Number.isInteger(pos.page) || pos.page < 1) throw new Error('auto-pull-product-not-visible:' + id);
    if (pos.page > fromPage) throw new Error('auto-pull-offpage-position-ahead-of-current');
    if (fromPage - pos.page > AUTO_PULL_OFFPAGE_MAX_PAGE_STEPS) throw new Error('auto-pull-offpage-distance-unbounded');
    const baseSelectedCount = run.baseSelectedCount;
    let cur = fromPage;
    while (cur > pos.page) {
      cur = await stepAllNumericPrev({ cat: '全部', native: false, selectedIds: unionSelected(), baseSelectedCount }, cur);
    }
    const settled = await settleProductPage({ cat: '全部', native: false, pageNo: pos.page, selectedIds: unionSelected(), baseSelectedCount });
    const matches = settled.snap.cards.filter(c => String(c.id) === String(id));
    if (matches.length !== 1) throw new Error('auto-pull-offpage-card-not-unique-at-proven-page:' + id);
    if (matches[0].checked !== true && matches[0].checked !== false) throw new Error('auto-pull-offpage-checked-state-unknown:' + id);
    if (matches[0].checked !== true) throw new Error('auto-pull-offpage-card-not-checked:' + id);
    const beforeCount = settled.snap.selectedCount;
    const beforeCapacity = settled.snap.remainingCapacity;
    await page.evaluate(deselectNativeCardInPage, id);
    try {
      await until(async () => {
        const s = await page.evaluate(drawerSnapshotInPage);
        if (!s || !s.ok) throw new Error('product-drawer-not-unique');
        const c = s.cards.find(x => String(x.id) === String(id));
        return { done: !!c && c.checked === false && s.selectedCount === beforeCount - 1 && s.remainingCapacity === beforeCapacity };
      }, x => x.done === true, nativeTimeoutMs, 'auto-pull-offpage-deselect-readback');
    } catch (_) { throw new Error('auto-pull-offpage-deselect-unconfirmed:' + id); }
    dayState.lastSelected = (dayState.lastSelected || []).map(String).filter(x => x !== String(id));
    selectedPositions.delete(String(id));
    await settleProductPage({ cat: '全部', native: false, pageNo: pos.page, selectedIds: unionSelected(), baseSelectedCount });
    let ret = cur;
    while (ret < fromPage) {
      const advanced = await changePage({ cat: '全部', native: false, selectedIds: unionSelected(), baseSelectedCount, expectedCapacity: run.expectedCapacity });
      if (advanced && advanced.boundary === true) throw new Error('auto-pull-offpage-return-boundary-unexpected');
      if (!advanced || advanced.confirmed !== true || advanced.observedPage !== ret + 1) throw new Error('auto-pull-offpage-return-unconfirmed');
      ret = advanced.observedPage;
    }
    await settleProductPage({ cat: '全部', native: false, pageNo: fromPage, selectedIds: unionSelected(), baseSelectedCount });
  }
  // S23: cancel an auto-pull-identified product whose trusted same-epoch provenance is a
  // NATIVE scroll category (real stop: candidate selected earlier in 店铺新品, browse then
  // moved to the numeric 全部 where the known cancel dialog named it — invisible there and
  // absent from the current main table). Positive live batch membership + the recorded
  // {epoch,cat,tab,native:true} are the ONLY entry; retrieval then uses the EXISTING strict
  // helpers end to end: a fresh recording epoch for the passive transport (a same-drawer
  // re-entry legitimately re-issues the tab's cursor-'0' first batch; a pre-existing anomaly
  // stops first and the epoch reset never clicks, reopens or clears anything else),
  // switchCategory's bound first-batch + DOM-equality settle, bounded nativeAdvance steps
  // with the fresh chained-response + DOM-growth proofs (a proven EOF before the target is
  // an honest not-found stop, never a guess), then the UNIQUE card with EXPLICIT checked
  // true gets exactly one native deselect, awaited to explicit checked=false with the
  // footer exactly -1 and capacity preserved, logical selection synced, and the page
  // re-proven (chain/DOM/footer/checked/drawer/category). Return to the ORIGINAL numeric
  // 全部 observed page goes through the strict switchCategory (which only accepts an
  // observed page-1 landing) plus the existing next-only proven changePage advances — never
  // a numeric prev, a page jump, an arbitrary DOM index or the previous page count assumed
  // unobserved. Unknown/stale/foreign provenance, transport anomaly, EOF-before-target,
  // checked unknown/false, non-unique card, failed switch/readback/return all keep the
  // honest stop with zero further submission. Only the exact cancelled id leaves the
  // logical selection; every other selected id is preserved for the host's top-up.
  async function deselectAutoPullNativeOffCategory(id, pos, run, fromPage, unionSelected) {
    if (!isNativeScrollCategory(pos.cat) || catalogTabForCategory(pos.cat) !== pos.tab) throw new Error('auto-pull-product-not-visible:' + id);
    const snapNow = await drawer();
    if (!categoryIsActive(snapNow, '全部')) throw new Error('auto-pull-product-not-visible:' + id);
    if (fromPage - 1 > AUTO_PULL_OFFPAGE_MAX_PAGE_STEPS) throw new Error('auto-pull-native-return-distance-unbounded');
    if (!transport.available) throw new Error('auto-pull-native-transport-unavailable');
    const tab = pos.tab;
    const baseSelectedCount = run.baseSelectedCount;
    const preAnomaly = transport.anomaly();
    if (preAnomaly) throw new Error('native-catalog-anomaly:' + preAnomaly);
    transport.beginDrawerEpoch();
    await switchCategory(pos.cat);
    let found = null;
    let advances = 0;
    for (;;) {
      const settled = await settleProductPage({ cat: pos.cat, native: true, tab, pageNo: 1, selectedIds: unionSelected(), baseSelectedCount });
      const matches = settled.snap.cards.filter(c => String(c.id) === String(id));
      if (matches.length > 1) throw new Error('auto-pull-native-card-not-unique:' + id);
      if (matches.length === 1) { found = { card: matches[0], snap: settled.snap }; break; }
      const adv = await nativeAdvance(tab);
      if (adv.eof) throw new Error('auto-pull-native-target-not-found:' + id);
      advances++;
      if (advances > NATIVE_SCROLL_MAX_ADVANCES) throw new Error('native-scroll-advance-limit-exceeded');
    }
    if (found.card.checked !== true && found.card.checked !== false) throw new Error('auto-pull-native-checked-state-unknown:' + id);
    if (found.card.checked !== true) throw new Error('auto-pull-native-card-not-checked:' + id);
    const beforeCount = found.snap.selectedCount;
    const beforeCapacity = found.snap.remainingCapacity;
    await page.evaluate(deselectNativeCardInPage, id);
    try {
      await until(async () => {
        const s = await page.evaluate(drawerSnapshotInPage);
        if (!s || !s.ok) throw new Error('product-drawer-not-unique');
        const c = s.cards.find(x => String(x.id) === String(id));
        return { done: !!c && c.checked === false && s.selectedCount === beforeCount - 1 && s.remainingCapacity === beforeCapacity };
      }, x => x.done === true, nativeTimeoutMs, 'auto-pull-native-deselect-readback');
    } catch (_) { throw new Error('auto-pull-native-deselect-unconfirmed:' + id); }
    dayState.lastSelected = (dayState.lastSelected || []).map(String).filter(x => x !== String(id));
    selectedPositions.delete(String(id));
    await settleProductPage({ cat: pos.cat, native: true, tab, pageNo: 1, selectedIds: unionSelected(), baseSelectedCount });
    await switchCategory('全部');
    let cur = 1;
    while (cur < fromPage) {
      const advanced = await changePage({ cat: '全部', native: false, selectedIds: unionSelected(), baseSelectedCount, expectedCapacity: run.expectedCapacity });
      if (advanced && advanced.boundary === true) throw new Error('auto-pull-native-return-boundary-unexpected');
      if (!advanced || advanced.confirmed !== true || advanced.observedPage !== cur + 1) throw new Error('auto-pull-native-return-unconfirmed');
      cur = advanced.observedPage;
    }
    await settleProductPage({ cat: '全部', native: false, pageNo: fromPage, selectedIds: unionSelected(), baseSelectedCount });
  }
  // Advances one native-scroll category by exactly one scroll of the unique
  // .product-list root. EOF is bound only to this round's successful
  // hasMore=false plus DOM verification of every accumulated id. A missing fresh
  // chained response, or no new id landing in the DOM, is an unknown stop and is
  // never treated as EOF or as a short-time no-progress completion.
  async function nativeAdvance(tab) {
    await transport.flush();
    const anomaly=transport.anomaly();
    if(anomaly)throw new Error('native-catalog-anomaly:'+anomaly);
    const last=transport.lastBatchForTab(tab);
    if(!last)throw new Error('native-catalog-batch-missing');
    if(last.hasMore===false) {
      const accIds=unionCatalogIds(transport.batchesForTab(tab));
      const domIds=(await drawer()).cards.map(c=>String(c.id||'')).filter(Boolean);
      const domSet=new Set(domIds);
      if(!accIds.every(id=>domSet.has(id)))throw new Error('native-eof-dom-mismatch');
      return {eof:true};
    }
    // A late-recognized guidance overlay must be handled by the EXISTING guidance phase
    // (下一步 / 我知道了 + cookie/flag writeback) and confirmed gone BEFORE we read the
    // scroll comparison baseline. That handling can itself trigger async catalog batches,
    // so flush and re-check the transport anomaly afterwards and take the baseline from
    // the RESULTING latest batch: a guide-triggered batch must never be read as this
    // round's scroll progress. An unknown overlay still stops with its original reason
    // and zero clicks; an absent overlay does zero phase/cookie/flag work.
    await handleLateGuidanceBeforeNativeAdvance(page,accountId,guidancePhase);
    await transport.flush();
    const postGuideAnomaly=transport.anomaly();
    if(postGuideAnomaly)throw new Error('native-catalog-anomaly:'+postGuideAnomaly);
    const baselineBatch=transport.lastBatchForTab(tab);
    if(!baselineBatch)throw new Error('native-catalog-batch-missing');
    const prevSeq=baselineBatch.seq;
    const prevDom=new Set((await drawer()).cards.map(c=>String(c.id||'')).filter(Boolean));
    const step=await page.evaluate(nativeScrollStepInPage);
    if(!step||!step.ok)throw new Error('native-scroll-step-failed');
    const markerNudged=!!(step.marker&&step.marker.nudged===true);
    try {
      let next=null,advAnomaly=null;
      try {
        const res=await until(async()=>{await transport.flush();return {batch:transport.lastBatchForTab(tab),anomaly:transport.anomaly()};},x=>!!x.anomaly||(x.batch&&x.batch.seq>prevSeq),nativeTimeoutMs,'native-scroll-batch');
        advAnomaly=res.anomaly||null;next=advAnomaly?null:res.batch;
      } catch(_) { next=null; }
      if(advAnomaly)throw new Error('native-catalog-anomaly:'+advAnomaly);
      if(!next)throw new Error('native-catalog-no-progress');
      let grew=false;
      try { await until(async()=>{const s=await page.evaluate(drawerSnapshotInPage);return s.ok?s.cards.map(c=>String(c.id||'')).filter(Boolean):[];},ids=>ids.some(id=>!prevDom.has(id)),nativeTimeoutMs,'native-scroll-dom-growth'); grew=true; }
      catch(_) { grew=false; }
      if(!grew)throw new Error('native-catalog-no-progress');
      return {eof:false};
    } finally {
      // Restore ANY temporary marker style we applied, on success / timeout / anomaly
      // alike. Only height/min-height (and their priority) we set are reverted; Vue vShow
      // display and all other inline properties stay untouched. A failed or unconfirmed
      // restore is surfaced, never swallowed: we must not claim the marker was restored.
      if (markerNudged) {
        const restoreResult = await page.evaluate(restoreNativeMarkerNudgeInPage, step.marker.previous);
        if (!restoreResult || restoreResult.restored !== true) {
          throw new Error('native-marker-restore-unconfirmed' + (restoreResult && restoreResult.reason ? ':' + restoreResult.reason : ''));
        }
      }
    }
  }
  async function openPicker() {
    // Register the passive catalog listener BEFORE the drawer opens so the initial
    // native first-batch is captured rather than only the first scroll, then start
    // a fresh drawer epoch so late responses from a previous drawer are rejected.
    if (transport.attach()) transport.beginDrawerEpoch();
    await page.evaluate(openPickerInPage);
    return waitForDrawer();
  }
  // pendingCheckedId (optional): the id whose select click may have TRIGGERED this dialog.
  // It is already checked in the drawer but not yet committed to dayState.lastSelected, so
  // the off-page walk-back's drift proofs must accept it as a known checked id.
  async function cancelAutoPull(pendingCheckedId) {
    const observed=await page.evaluate(classifyAndCancelAutoPullInPage);
    if(observed.kind==='none')return observed;
    if(observed.kind!=='observed')throw new Error(observed.reason||'unknown-dialog-state');
    const classified=wf.classifyAddDialog(observed.text);
    if(classified.action!=='cancel')throw new Error(classified.reason||'unknown-add-dialog');
    await page.evaluate(cancelObservedAutoPullInPage,observed.text);
    await until(()=>page.evaluate(classifyAndCancelAutoPullInPage),x=>x.kind==='none',8000,'auto-pull-cancel');
    const cancelledNow=[];
    // 可变的 pending 引用：某目标一旦被正面证明取消（可见或 off-page），它已离开抽屉勾选集，
    // 必须停止把这一确切 ID 再并入后续 off-page walk-back 的 unionSelected（否则会虚增计数漂移）。
    let pendingChecked = pendingCheckedId != null ? String(pendingCheckedId) : null;
    for(const id of classified.productIds) {
        const snap=await drawer(); const card=snap.cards.find(c=>c.id===id);
        if(!card){
          // S21: not visible on the current page is NOT proof of "not selected". Only a
          // positive same-epoch batch membership + trusted numeric position allows the
          // bounded native walk-back deselect; every unproven case still throws the
          // original auto-pull-product-not-visible stop (never swallowed, never guessed
          // from a smaller footer count).
          await deselectAutoPullProductOffPage(id,pendingChecked);
        } else if(card.checked===true) {
          // Single native deselect toggle, then a bounded FRESH re-read on the latest
          // node. Pending is still pending (never re-clicked); only a confirmed
          // unchecked/absent card is accepted, otherwise this is a hard stop.
          const matches=snap.cards.filter(c=>String(c.id)===String(id));
          if(matches.length!==1||matches[0].checked!==true) throw new Error('auto-pull-cancel-target-not-uniquely-checked:'+id);
          if(!Number.isInteger(snap.selectedCount)||!Number.isInteger(snap.remainingCapacity)) throw new Error('auto-pull-cancel-footer-state-unknown:'+id);
          const beforeCount=snap.selectedCount, beforeCapacity=snap.remainingCapacity;
          const activeBefore=(snap.activeTabs||[]).map(t=>String(t));
          await page.evaluate(deselectNativeCardInPage,id);
          try {
            await until(async()=>{
              const s=await page.evaluate(drawerSnapshotInPage);
              if(!s||!s.ok) throw new Error('product-drawer-not-unique');
              const c=s.cards.find(x=>String(x.id)===id);
              const tabs=(s.activeTabs||[]).map(t=>String(t));
              const categoryKept=activeBefore.every(t=>tabs.includes(t));
              // 正面证明：唯一目标明确 checked FALSE、footer 恰好 -1、remainingCapacity 不变、当前类别仍 active。
              return { done: !!c && c.checked===false && s.selectedCount===beforeCount-1 && s.remainingCapacity===beforeCapacity && categoryKept===true };
            },x=>x.done===true,nativeTimeoutMs,'auto-pull-deselect-fresh-readback');
          } catch(_) { throw new Error('auto-pull-product-still-selected:'+id); }
          // S25：本单件可见目标已正面证明取消，进入下一目标前**只**剔除这一确切 ID 的当前逻辑
          // 选中/出处，使后续 off-page walk-back 的 unionSelected 读到"当前已证明集合"。旧代码
          // 整个循环结束后才同步（见下），令 off-page 严格 footer 证明看到 stale 逻辑数（如 22）
          // vs 实际 footer（如 20）而误报 current-product-page-footer-capacity-drift 真停。
          dayState.lastSelected=(dayState.lastSelected||[]).map(String).filter(x=>x!==String(id));
          selectedPositions.delete(String(id));
        } else {
          // 未勾选/未知/歧义的可见目标绝不当作取消：硬停，绝不剔除、绝不计数、绝不提交、绝不假成功。
          throw new Error('auto-pull-cancel-target-state-unconfirmed:'+id);
        }
        if(pendingChecked!=null && pendingChecked===String(id)) pendingChecked=null;
        attemptedSet.add(id);
        cancelledNow.push(String(id));
        dayState.attempted=[...attemptedSet];dayState.hints=hints;await persist(dayState);
    }
    // The exact cancelled ids leave the real logical selection set (the host re-syncs its
    // selectedIds from dayState.lastSelected right after this returns); every other selected
    // id is preserved so the run can top the batch back up to 30 and submit again.
    const cancelledSet=new Set(cancelledNow);
    if((dayState.lastSelected||[]).some(x=>cancelledSet.has(String(x)))){
      dayState.lastSelected=(dayState.lastSelected||[]).filter(x=>!cancelledSet.has(String(x)));
      for(const cid of cancelledNow)selectedPositions.delete(cid);
    }
    dayState.attempted=[...attemptedSet];dayState.hints=hints;await persist(dayState);
    return {kind:'cancelled',productIds:classified.productIds};
  }
  // position (optional): the caller's SAME-ROUND strict page proof for this candidate
  // ({epoch,cat:'全部',page} from the settled observed numeric page). It is recorded in the
  // private epoch ledger BEFORE the select click — never derived from cursor/hints old
  // values — so a later auto-pull dialog naming this product can be walked back to it.
  async function selectCard(card, selectedList, position) {
    const id=String(card.id||'');
    if(!/^\d{15,20}$/.test(id))return {selected:false,reason:'product-id-unknown'};
    const parsed=wf.parseProductCard(card);
    hints[id]=wf.mergeCardHints(hints, [parsed])[id];
    if(parsed.reviewFailed||!parsed.selectable||publishedIds.has(id)||attemptedSet.has(id))return {selected:false,reason:parsed.reviewFailed?'review-failed':'not-eligible'};
    attemptedSet.add(id);
    dayState.attempted=[...attemptedSet];dayState.hints=hints;dayState.cursor={...dayState.cursor,seenProductIds:[...new Set([...(dayState.cursor.seenProductIds||[]),id])]};
    await persist(dayState);
    const before=await drawer();
    const existing=before.cards.find(c=>c.id===id);
    if(!existing)throw new Error('candidate-disappeared-before-selection:'+id);
    if(existing.checked===true)return {selected:true,alreadyChecked:true};
    if(existing.checked!==false||existing.checkboxCount!==1)throw new Error('native-checkbox-state-unknown:'+id);
    if(position&&position.epoch===pickerEpoch){
      if(position.native===true&&isNativeScrollCategory(position.cat)&&catalogTabForCategory(position.cat)===position.tab){
        // S23: native provenance = observed category + tab ONLY, never a numeric page.
        selectedPositions.set(id,{epoch:pickerEpoch,cat:position.cat,tab:position.tab,native:true});
      } else if(position.cat==='全部'&&Number.isInteger(position.page)&&position.page>=1){
        selectedPositions.set(id,{epoch:pickerEpoch,cat:'全部',page:position.page});
      }
    }
    await page.evaluate(selectNativeCardInPage,id);
    const auto=await cancelAutoPull(id);
    if(auto.kind==='cancelled'&&auto.productIds.includes(id)) {
      selectedPositions.delete(id);
      const skipped=await drawer();
      if(skipped.cards.find(c=>String(c.id)===id)?.checked===true)throw new Error('auto-pull-product-still-selected:'+id);
      return {selected:false,skippedAutoPull:true};
    }
    // Bounded FRESH re-read on the latest node before treating the selection as
    // real: a controlled checkbox may land after this evaluate, and the original
    // input/card may be re-rendered into a replacement node. drawerSnapshot is
    // re-queried every poll so no stale reference is trusted. No second click is
    // issued while pending. A timeout, a missing target id, a non-unique drawer or a
    // footer count that is not a positive integer is a hard stop, never a success.
    try {
      await until(async()=>{
        const s=await page.evaluate(drawerSnapshotInPage);
        if(!s||!s.ok) return {settled:false};
        const c=s.cards.find(x=>String(x.id)===id);
        return {settled: !!c && c.checked===true && Number.isInteger(s.selectedCount) && s.selectedCount>=1};
      },x=>x.settled===true,nativeTimeoutMs,'native-checkbox-fresh-readback');
    } catch(_) { throw new Error('native-checkbox-readback-failed:'+id); }
    // Ids cancelled by THIS select's auto-pull dialog leave the logical selection even when
    // the stale host list still carries them; every other previously selected id is kept.
    const cancelledNow=new Set(auto&&auto.kind==='cancelled'?(auto.productIds||[]).map(String):[]);
    dayState.lastSelected=[...(selectedList||[]).map(String).filter(x=>!cancelledNow.has(x)),id];dayState.hints=hints;await persist(dayState);
    return {selected:true};
  }
  async function browseProducts(input) {
    // Best-effort passive listener registration before any drawer/category/scroll
    // action. Native categories hard-require it inside switchCategory; the numeric
    // category never depends on it, so pages without .on stay fully supported.
    transport.attach();
    try {
    let snap;
    try { snap=await drawer(); } catch (_) { snap=await openPicker(); }
    let selectedIds=(input.selectedIds||[]).map(String);
    const baseSelectedCount=selectedIds.length;
    const expectedCapacity=Number(input.needed==null?wf.BUSINESS.productsPerPlan-baseSelectedCount:input.needed);
    if(!Number.isInteger(expectedCapacity)||expectedCapacity<1||expectedCapacity>30||baseSelectedCount+expectedCapacity!==wf.BUSINESS.productsPerPlan)throw new Error('picker-remaining-capacity-does-not-match-plan');
    if(expectedCapacity!==wf.BUSINESS.productsPerPlan-baseSelectedCount||!pickerBatchStateMatches(snap,baseSelectedCount,0))throw new Error('picker-initial-batch-count-or-capacity-mismatch');
    const visibleChecked=snap.cards.filter(c=>c.checked===true&&c.id).map(c=>String(c.id));
    if(visibleChecked.some(id=>!selectedIds.includes(id)))throw new Error('restored-selection-does-not-match-persisted-state');
    // S21: one browseProducts run is one picker epoch. Position entries only ever live for
    // the epoch that recorded them; a restored base selection legitimately carries NO
    // position (it was not proven in this epoch) and can never be walked back to.
    pickerEpoch+=1;
    selectedPositions.clear();
    pickerRunContext={baseSelectedCount,expectedCapacity};
    dayState.lastSelected=selectedIds.slice();
    const ordered=input.categories||wf.CATEGORY_TAB_ORDER;
    let cat=dayState.cursor&&ordered.includes(dayState.cursor.category)?dayState.cursor.category:ordered[0];
    let categoryIndex=Math.max(0,ordered.indexOf(cat));
    let pageNo=1;
    if(!categoryIsActive(snap,cat)){snap=await switchCategory(cat);pageNo=1;}
    if(!isNativeScrollCategory(cat)&&dayState.cursor&&Number.isInteger(dayState.cursor.page)&&dayState.cursor.page>1) {
      // Reopening starts at page one; restore only through observed forward steps.
      // Native scroll categories always rescan from the top and dedup via
      // seenProductIds/attempted/published, so no numeric restore is attempted.
      while(pageNo<dayState.cursor.page){const restored=await changePage({cat,native:isNativeScrollCategory(cat),selectedIds,baseSelectedCount,expectedCapacity});if(!restored.confirmed||restored.observedPage!==pageNo+1)throw new Error('cursor-restore-page-unconfirmed');pageNo=restored.observedPage;}
    }
    for(;categoryIndex<ordered.length;categoryIndex++) {
      cat=ordered[categoryIndex];
      const native=isNativeScrollCategory(cat);
      const tab=native?catalogTabForCategory(cat):null;
      if(native&&!tab)throw new Error('native-category-tab-unknown:'+cat);
      let nativeAdvances=0;
      if(categoryIndex!==Math.max(0,ordered.indexOf(dayState.cursor&&dayState.cursor.category))) { snap=await switchCategory(cat);pageNo=1; }
      else {
        if(!categoryIsActive(snap,cat))snap=await switchCategory(cat);
      }
      for(;;) {
        // Bounded read-only settle first: a transient empty/duplicate DOM right after an open,
        // category switch or page advance must be given a chance to become a real complete unique
        // valid list before we act; genuine identity drift stops immediately. No tab re-click, no
        // picker re-open, no checkbox/batch/header re-do happens here.
        const settledPage=await settleProductPage({cat,native,tab,pageNo,selectedIds,baseSelectedCount});
        snap=settledPage.snap;
        const cardIds=snap.cards.map(c=>c.id).filter(Boolean);
        if(native&&settledPage.empty)break;
        if(native){
          // page:1 is a neutral legacy schema value only; an observed numeric pager
          // is never claimed for a native scroll category.
          dayState.category=cat;dayState.page=1;dayState.cursor={category:cat,page:1,seenProductIds:[...new Set([...(dayState.cursor.seenProductIds||[]),...cardIds])]};await persist(dayState);
        } else {
          dayState.category=cat;dayState.page=pageNo;dayState.cursor={category:cat,page:pageNo,seenProductIds:[...new Set([...(dayState.cursor.seenProductIds||[]),...cardIds])]};await persist(dayState);
        }
        const chosen=[];
        // S21/S23 position proof for this exact settled page: settleProductPage above has just
        // re-proven account / creation route / unique drawer / active category / complete unique
        // valid card set — for the numeric 全部 also the observed page number, for a native
        // scroll category also the fresh bound catalog chain for its tab — so every candidate
        // on it may carry its provenance into selectCard for the pre-click ledger entry. A
        // native entry never carries a numeric page (it must never masquerade as one); any
        // other non-numeric category passes no position at all and keeps the honest stop.
        const position=native
          ?(tab?{epoch:pickerEpoch,cat,tab,native:true}:null)
          :(cat==='全部'?{epoch:pickerEpoch,cat,page:pageNo}:null);
        for(const raw of snap.cards) {
          const current=await drawer();
          const selectedNow=current.cards.filter(c=>c.checked===true&&c.id).map(c=>String(c.id));
          if(selectedNow.some(id=>!selectedIds.includes(id)))throw new Error('visible-selection-drift-from-persisted-ids');
          if(selectedIds.length>=wf.BUSINESS.productsPerPlan)break;
          if(selectedIds.includes(String(raw.id)))continue;
          const result=await selectCard(raw,selectedIds,position);
          if(result.selected){
            chosen.push(String(raw.id));
            // Adopt selectCard's committed logical selection (it already excluded any id an
            // auto-pull cancel proved deselected); the alreadyChecked defensive path keeps its
            // old semantics by appending an id that is genuinely checked but not yet listed.
            selectedIds=dayState.lastSelected.slice();
            if(!selectedIds.includes(String(raw.id))){selectedIds.push(String(raw.id));dayState.lastSelected=selectedIds.slice();}
            await persist(dayState);
          }
          if(result.skippedAutoPull){
            selectedIds=dayState.lastSelected.slice();
            await input.onProgress({...dayState,lastSelected:selectedIds,hints,attempted:[...attemptedSet],cursor:dayState.cursor});
            continue;
          }
          selectedIds=dayState.lastSelected.slice();
          await input.onProgress({...dayState,lastSelected:selectedIds,hints,attempted:[...attemptedSet],cursor:dayState.cursor});
        }
        const latest=await drawer();
        if(!pickerBatchStateMatches(latest,baseSelectedCount,selectedIds.length-baseSelectedCount))throw new Error('picker-footer-count-drift');
        if(latest.cards.filter(c=>c.checked===true&&c.id).some(c=>!selectedIds.includes(String(c.id))))throw new Error('picker-visible-selection-drift');
        if(selectedIds.length>=wf.BUSINESS.productsPerPlan){
          const submit=await commitPicker({baseSelectedCount,expectedCapacity});
          if(submit&&submit.submitted===true)return {ok:true,selectedIds:selectedIds.slice(0,wf.BUSINESS.productsPerPlan),hints,attempted:[...attemptedSet],cursor:dayState.cursor};
          const cancelled=new Set((submit&&submit.productIds||[]).map(String));
          if(!submit||submit.autoPullCancelled!==true||!cancelled.size||[...cancelled].some(id=>!selectedIds.includes(id)))throw new Error('picker-submit-result-unknown');
          selectedIds=selectedIds.filter(id=>!cancelled.has(id));
          if(selectedIds.length<baseSelectedCount||selectedIds.length>=wf.BUSINESS.productsPerPlan)throw new Error('auto-pull-deselection-count-invalid');
          dayState.lastSelected=selectedIds.slice();dayState.attempted=[...attemptedSet];dayState.hints=hints;await persist(dayState);
          await input.onProgress({...dayState,lastSelected:selectedIds,hints,attempted:[...attemptedSet],cursor:dayState.cursor});
          // A submit-time auto-pull cancellation invalidates only its identified
          // candidates. Re-scan this exact live page before advancing: an
          // unattempted usable replacement may already be visible here. Each
          // candidate is marked attempted before selection, so restarting this
          // bounded page loop cannot retry the canceled row indefinitely.
          const afterCancel=await drawer();
          const currentBatchCount=selectedIds.length-baseSelectedCount;
          if(!pickerBatchStateMatches(afterCancel,baseSelectedCount,currentBatchCount))throw new Error('auto-pull-backfill-footer-count-unknown');
          const hasCurrentPageReplacement=afterCancel.cards.some(card=>{
            const id=String(card.id||'');
            if(!/^\d{15,20}$/.test(id)||selectedIds.includes(id)||attemptedSet.has(id)||publishedIds.has(id))return false;
            const parsed=wf.parseProductCard(card);
            return parsed.selectable&&!parsed.reviewFailed;
          });
          if(hasCurrentPageReplacement)continue;
        }
        if(native){
          const adv=await nativeAdvance(tab);
          if(adv.eof){
            // 真实 EOF：transport 已证明本类目 hasMore=false 且累计 id 全部落到 DOM。诚实耗尽。
            dayState.cursor=nativeAdvanceCursor(dayState.cursor,cat,'eof',nativeAdvances);
            await persist(dayState);
            break;
          }
          nativeAdvances++;
          // 有界推进预算用尽 ≠ 诚实 EOF：只停止本类目并转入下一个类目（绝不硬抛
          // scheduled-run-exception 把整店卡死，也绝不放宽 nativeAdvance 内部的无进展/transport
          // 异常硬判据、绝不重复发布）。cursor 显式清除可能残留的 nativeEof（预算耗尽不是 EOF），
          // 常量刻意保持 40，不盲目抬高。
          dayState.cursor=nativeAdvanceCursor(dayState.cursor,cat,'budget',nativeAdvances);
          await persist(dayState);
          if(nativeAdvances>=NATIVE_SCROLL_MAX_ADVANCES)break;
          continue;
        }
        const advanced=await changePage({cat,native,selectedIds,baseSelectedCount,expectedCapacity});
        if(advanced&&advanced.boundary===true)break;
        if(!advanced.confirmed||advanced.observedPage!==pageNo+1)throw new Error('page-advance-unconfirmed-before-cursor-write');
        pageNo=advanced.observedPage;
      }
    }
    return {ok:false,reason:'catalog-exhausted-or-safe-pagination-boundary',selectedIds,hints,attempted:[...attemptedSet],cursor:dayState.cursor};
    } finally { pickerRunContext=null;selectedPositions.clear();transport.detach(); }
  }
  async function commitPicker({baseSelectedCount=0,expectedCapacity=wf.BUSINESS.productsPerPlan}={}) {
    const snap=await drawer();
    if(!pickerBatchStateMatches(snap,baseSelectedCount,expectedCapacity)||baseSelectedCount+expectedCapacity!==wf.BUSINESS.productsPerPlan||dayState.lastSelected.length!==wf.BUSINESS.productsPerPlan||new Set(dayState.lastSelected.map(String)).size!==wf.BUSINESS.productsPerPlan)throw new Error('picker-selection-not-exactly-30');
    const selected=dayState.lastSelected.map(String);
    const obs=await observe();const next=obs.elements.filter(e=>e.text==='下一步'&&e.tag==='BUTTON');
    if(next.length!==1)throw new Error('product-picker-next-button-not-unique');
    await page.evaluate(guard.actionApply,{observation:obs.observation,index:next[0].index,op:'click',expectedText:'下一步'});
    const result=await until(async()=>({auto:await page.evaluate(classifyAndCancelAutoPullInPage),drawer:await page.evaluate(drawerSnapshotInPage),table:await page.evaluate(readMainTableInPage)}),x=>x.auto.kind!=='none'||(!x.drawer.ok&&x.table.ok),15000,'picker-submit-or-auto-pull');
    if(result.auto.kind==='unknown')throw new Error(result.auto.reason||'auto-pull-dialog-unknown-after-submit');
    if(result.auto.kind==='observed') {
      const auto=await cancelAutoPull();
      if(auto.kind!=='cancelled'||!auto.productIds.length)throw new Error('auto-pull-cancel-not-confirmed-after-submit');
      const toRemove=new Set(auto.productIds.map(String));
      if([...toRemove].some(id=>!selected.includes(id)))throw new Error('auto-pull-id-not-in-submitted-selection');
      const remaining=selected.filter(id=>!toRemove.has(id));
      if(dayState.lastSelected.some(id=>!selected.includes(String(id))))throw new Error('picker-logical-selection-drift');
      dayState.lastSelected=remaining;dayState.attempted=[...attemptedSet];await persist(dayState);
      return {submitted:false,autoPullCancelled:true,productIds:[...toRemove]};
    }
    await guidancePhase();
    return {submitted:true,productIds:selected};
  }
  async function readMainTable() {
    const r=await page.evaluate(readMainTableInPage);if(!r.ok)throw new Error(r.reason);return r.rows;
  }
  async function bindAccountsToAll({productIds}) {
    const ids=(productIds||[]).map(String);
    if(ids.length!==30||new Set(ids).size!==30) return {ok:false,reason:'product-ids-not-exactly-30'};
    const rows=await readMainTable();
    if(rows.length!==30||new Set(rows.map(r=>String(r.productId))).size!==30||rows.some(r=>!ids.includes(r.productId))||ids.some(id=>!rows.some(r=>String(r.productId)===id)))return {ok:false,reason:'main-table-does-not-match-selected-ids'};
    // R32 min-1: an anchor is any product whose main-table row shows at least 1 manual
    // account bound (1 or 2); the anchor's drawer may confirm 1 or 2 target accounts.
    const anchor=rows.find(r=>Number.isInteger(r.manualAccounts)&&r.manualAccounts>=1);
    // Identity scope: the drawer rows must be a UNIQUE 1-or-2 set. Once this shop's
    // targets are resolved (legacy default, an explicitly configured shop, or an
    // earlier discovery pass) they must be a subset of that frozen set — never a
    // foreign account. While still UNRESOLVED (discovery) any unique 1-or-2 rows are
    // provisionally acceptable; the exact ids are frozen from the settled select-all
    // readback by resolveDiscoveredTargets below and enforced from then on.
    const matchTargets=ids=>{const t=resolvedTargets;return !t||ids.every(id=>t.includes(id));};
    const exactTwo=s=>!!s&&s.ok===true&&Array.isArray(s.rows)&&s.rows.length>=1&&s.rows.length<=2&&s.rows.every(r=>Array.isArray(r.ids)&&r.ids.length===1)&&new Set(s.rows.flatMap(r=>r.ids).map(String)).size===s.rows.length&&matchTargets(s.rows.flatMap(r=>r.ids).map(String));
    // Freeze the shop's OWN bindable accounts ONCE from a positively-settled drawer
    // snapshot: reject an empty drawer (no bindable account) or a malformed id, and
    // adopt the exact unique ids. Idempotent — later rebinding rounds keep the set.
    const resolveDiscoveredTargets=s=>{
      if(resolvedTargets) return {ok:true,boundAccounts:resolvedTargets.slice()};
      const found=[...new Set((((s&&s.rows)||[]).map(r=>(r.ids||[])[0])).filter(Boolean).map(String))];
      if(found.length<1) return {ok:false,reason:'no-bindable-target-accounts-discovered'};
      if(found.length>2) return {ok:false,reason:'too-many-bindable-target-accounts'};
      if(found.some(id=>!/^[0-9A-Za-z_-]{4,32}$/.test(id))) return {ok:false,reason:'discovered-target-id-invalid'};
      resolvedTargets=found;
      return {ok:true,boundAccounts:found.slice()};
    };
    // A real ovui account row may be blocked by its LABEL carrying ovui-checkbox--disabled
    // even while the header itself is enabled and INPUT.disabled reads false. When such an
    // UNSELECTED disabled row is present we reuse the already-bound anchor instead.
    const rowsBlockedUnchecked=s=>!!s&&s.ok===true&&Array.isArray(s.rows)&&s.rows.some(r=>r.checked!==true&&r.labelDisabled===true);
    // Proven batch identity helpers (defined here so reopenBoundAnchor can settle-wait on them):
    // a trustworthy drawer must expose the exact 30-product panel set for this batch, a SINGLE
    // active product inside it, and a CONSISTENT selection: all-unchecked-0/30, all-checked-k/30
    // (k=1 or 2), or checked-plus-disabled-unchecked at checked-count/30.
    const provePanelSet=s=>{
      if(!s||s.ok!==true) return null;
      const pidList=Array.isArray(s.panelProductIds)?s.panelProductIds.map(String):[];
      const uniq=[...new Set(pidList)];
      if(pidList.length!==ids.length||uniq.length!==ids.length||!ids.every(id=>uniq.includes(id))) return null;
      if(!Array.isArray(s.activeProductIds)||s.activeProductIds.length!==1) return null;
      const a=String(s.activeProductIds[0]);
      return ids.includes(a)?a:null;
    };
    const panelSetEqualsIds=s=>{
      if(!s||s.ok!==true) return false;
      const pidList=Array.isArray(s.panelProductIds)?s.panelProductIds.map(String):[];
      const uniq=[...new Set(pidList)];
      return pidList.length===ids.length&&uniq.length===ids.length&&ids.every(id=>uniq.includes(id));
    };
    const consistentSelectionState=s=>{
      if(!s||s.ok!==true||!Array.isArray(s.rows)||s.rows.length<1||s.rows.length>2) return false;
      // R33: every displayed row must read a DEFINITE checkbox state (an unknown
      // checkbox — checked neither true nor false — is a hard reject, never treated
      // as unchecked). A settled selection is then any known checked subset 1..2 (the
      // operator permits binding >=1 of the displayed targets, so an ENABLED row left
      // deliberately unchecked is legitimate) as long as the footer 已选 equals the
      // actual checked-row count and the total is 30. 0/30, 1/30 and 2/30 all pass; a
      // fake selected2/footer2, a footer conflict or a mid-toggle unknown never does.
      if(s.rows.some(r=>r.checked!==true&&r.checked!==false)) return false;
      const checkedN=s.rows.filter(r=>r.checked===true).length;
      return s.selectedCount===checkedN&&s.totalCount===30;
    };
    // A legitimate reuse target is any product that is itself bound to at least 1 manual
    // account in THIS batch's main table read — not only the first rows.find anchor. This
    // lets a drawer whose active is already a second legitimately-bound product be reused
    // directly.
    const isBoundManual2InBatch=pid=>rows.some(r=>String(r.productId)===String(pid)&&Number.isInteger(r.manualAccounts)&&r.manualAccounts>=1);
    async function readDrawer() {
      try { return await until(()=>page.evaluate(bindingDrawerSnapshotInPage),x=>x.ok&&exactTwo(x),10000,'account-drawer'); }
      catch(_) { return await page.evaluate(bindingDrawerSnapshotInPage).catch(()=>null); }
    }
    async function reopenBoundAnchor() {
      if(!anchor) return null;
      // Cancel the auto-opened unsaved drawer and require POSITIVE closed evidence before
      // opening the anchor management button — never click behind a lingering/unknown overlay.
      await page.evaluate(cancelAutoOpenedDrawerInPage).catch(()=>null);
      let closedEvid=false;
      try {
        await until(()=>page.evaluate(bindingDrawerSnapshotInPage),x=>!!x&&x.ok===false&&x.count===0,6000,'auto-drawer-closed');
        closedEvid=true;
      } catch(_) { closedEvid=false; }
      // Timeout / null / unknown / multiple / still-open drawer => zero anchor-open, zero batch.
      if(closedEvid!==true) return null;
      const reopened=await page.evaluate(openAnchorManagementInPage,anchor.productId).catch(()=>null);
      if(!reopened||reopened.ok!==true) return null;
      // Bounded READ-ONLY settle for THIS reopen branch only. The freshly-managed drawer may
      // transiently read not-yet-checked accounts or an active that has not yet fallen back to the
      // requested anchor; wait (no clicks) until it proves the exact 30-panel set, the SINGLE active
      // EQUALS the requested anchor, and the 1-or-2 target accounts form a settled known subset
      // (>=1 checked, remaining rows definite unchecked) at footer checked-count/30. Never loop
      // forever or click behind an overlay: on timeout return the last read for the caller guards.
      const settled=s=>!!s&&s.ok===true&&exactTwo(s)&&consistentSelectionState(s)&&Array.isArray(s.rows)&&s.rows.some(r=>r.checked===true)&&s.rows.every(r=>r.checked===true||r.checked===false)&&provePanelSet(s)===String(anchor.productId);
      try { return await until(()=>page.evaluate(bindingDrawerSnapshotInPage),settled,nativeTimeoutMs,'anchor-reopen-settled'); }
      catch(_) { return await page.evaluate(bindingDrawerSnapshotInPage).catch(()=>null); }
    }
    // ALL-SUCCESS WITH NO RESULT MODAL: the platform only raises the per-product result popup on a
    // PARTIAL failure. A full-success batch leaves the drawer open with NO popup, so the settled
    // result wait times out. That must NOT be read as success and must NOT bypass any guard: we
    // prove completion by an entirely READ-ONLY UI readback, bounded ordinary .panel navigation
    // across the batch's known unique 30 ids. Each target must show a settled known subset of the
    // approved target accounts (R33 min-1: >=1 checked, remaining rows definite unchecked — an
    // enabled row left intentionally unbound is legitimate) at footer checked-count/30
    // with the SAME exact 30-panel set and a SINGLE active === the target; before
    // every navigation the PREVIOUS active/drawer identity/panel set/accounts/footer are re-read and
    // any blocking overlay census is re-checked. A new/unknown overlay, account drift, unknown row,
    // footer conflict, foreign/duplicate panel, wrong active or a zero-checked selection stops with ZERO
    // acknowledge and ZERO drawer commit — we never click behind an overlay. Only after all 30 are
    // positively proven do we navigate back to the ORIGINAL captured batchAnchorId, fresh-prove it,
    // and then proceed (still zero ACK) to the normal drawer 确定 + full main-table readback. The
    // empty failedIds is derived from this full 30 proof, never from the mere absence of a popup.
    async function proveAllSuccessByPanelNavigation(originalAnchor, mode) {
      const partial=mode==='partial';
      const panelIds=[...new Set(ids.map(String))];
      if(panelIds.length!==30) return {ok:false,reason:'batch-result-pending-or-unknown-not-confirmed'};
      const provesTarget=(s,pid)=>!!s&&s.ok===true&&exactTwo(s)&&consistentSelectionState(s)&&s.totalCount===30
        &&Array.isArray(s.rows)&&s.rows.some(r=>r.checked===true)&&s.rows.every(r=>r.checked===true||r.checked===false)&&panelSetEqualsIds(s)&&provePanelSet(s)===String(pid);
      // 严格 partial 口径：一个商品的**明确 0** 只有在同一 30-panel 身份、唯一 active=该商品、账号行仍是
      // 本店已发现的 1-2 个目标账号且全部未选、页脚恰为 0/30 时才算成立。缺行/页脚冲突/账号漂移/读不回
      // 一律不算 0（算 unknown，直接停），绝不把"没结果/一直在加载"当成 0。
      const provesZero=(s,pid)=>!!s&&s.ok===true&&exactTwo(s)&&consistentSelectionState(s)&&s.totalCount===30&&s.selectedCount===0
        &&Array.isArray(s.rows)&&s.rows.length>=1&&s.rows.every(r=>r.checked===false)&&panelSetEqualsIds(s)&&provePanelSet(s)===String(pid);
      const proves=(s,pid)=>partial?(provesTarget(s,pid)||provesZero(s,pid)):provesTarget(s,pid);
      const zeroIds=[],boundIds=[];
      const noBlocking=async()=>{ const ov=await page.evaluate(bindingOverlaySnapshotInPage).catch(()=>null); return !!ov&&ov.accountDrawerCount===1&&ov.blockingOverlayPresent===false; };
      // The drawer must still be uniquely present and free of any blocking overlay before the very
      // first navigation; if we cannot confirm that, this is still pending/unknown, not success.
      if(!(await noBlocking())) return {ok:false,reason:'batch-result-pending-or-unknown-not-confirmed'};
      let prev=null;
      for(const pid of panelIds){
        // Re-check the PREVIOUS verification still holds on a fresh read before moving on, and re-run
        // the blocking-overlay census; a mid-probe popup/drift stops before any further navigation.
        if(prev!==null){
          const re=await page.evaluate(bindingDrawerSnapshotInPage).catch(()=>null);
          if(!proves(re,prev)) return {ok:false,reason:'batch-result-panel-navigation-prev-drift'};
          if(!(await noBlocking())) return {ok:false,reason:'batch-result-panel-navigation-blocking-overlay'};
        }
        let clk=null;
        try { clk=await page.evaluate(selectBindingDrawerPanelInPage,pid); } catch(_) { return {ok:false,reason:'batch-result-panel-navigation-rejected'}; }
        if(!clk||clk.clicked!==true||String(clk.id)!==String(pid)) return {ok:false,reason:'batch-result-panel-navigation-not-confirmed'};
        let fresh=null;
        try { fresh=await until(()=>page.evaluate(bindingDrawerSnapshotInPage), s=>proves(s,pid), nativeTimeoutMs,'batch-result-panel-verified'); }
        catch(_) { fresh=await page.evaluate(bindingDrawerSnapshotInPage).catch(()=>null); }
        if(!proves(fresh,pid)) return {ok:false,reason:'batch-result-panel-target-not-verified'};
        if(!(await noBlocking())) return {ok:false,reason:'batch-result-panel-navigation-blocking-overlay'};
        if(partial){ (provesTarget(fresh,pid)?boundIds:zeroIds).push(String(pid)); }
        prev=pid;
      }
      // All 30 proven: navigate back to the original batch anchor and fresh-prove it before the commit.
      if(!(await noBlocking())) return {ok:false,reason:'batch-result-panel-navigation-blocking-overlay'};
      let back=null;
      try { back=await page.evaluate(selectBindingDrawerPanelInPage,originalAnchor); } catch(_) { return {ok:false,reason:'batch-result-anchor-restore-rejected'}; }
      if(!back||back.clicked!==true||String(back.id)!==String(originalAnchor)) return {ok:false,reason:'batch-result-anchor-restore-not-confirmed'};
      let restored=null;
      try { restored=await until(()=>page.evaluate(bindingDrawerSnapshotInPage), s=>proves(s,originalAnchor), nativeTimeoutMs,'batch-result-anchor-restored'); }
      catch(_) { restored=await page.evaluate(bindingDrawerSnapshotInPage).catch(()=>null); }
      if(!proves(restored,originalAnchor)) return {ok:false,reason:'batch-result-anchor-restore-not-verified'};
      if(!(await noBlocking())) return {ok:false,reason:'batch-result-panel-navigation-blocking-overlay'};
      if(partial&&provesTarget(restored,originalAnchor)&&!boundIds.some(id=>id===String(originalAnchor))) boundIds.push(String(originalAnchor));
      return partial?{ok:true,boundIds,zeroIds}:{ok:true};
    }
    // STEP 1: The picker 下一步 auto-opens the 为商品添加抖音号 drawer. Read the CURRENT
    // drawer FIRST — never force a management-button click while a usable drawer is open,
    // and never click behind an overlay.
    let snap=await readDrawer();
    // STEP 2 (supplement): with no usable auto drawer but a proven manual2 anchor, cancel the
    // auto-opened unsaved drawer, then uniquely open the anchor's management button.
    let reopenedInStep2=false;
    if(!snap||!snap.ok||!exactTwo(snap)){
      if(anchor){
        snap=await reopenBoundAnchor();
        reopenedInStep2=true;
        if((!snap||!snap.ok||!exactTwo(snap))&&anchor) return {ok:false,reason:'anchor-account-management-button-not-unique'};
      }
    }
    if(!snap||!snap.ok||!exactTwo(snap))return {ok:false,reason:'account-drawer-does-not-show-exact-two-target-accounts'};
    if(snap.totalCount!==30||![0,1,2].includes(snap.selectedCount))return {ok:false,reason:'account-drawer-selected-count-not-0-1-or-2-of-30'};
    // A LABEL-disabled header, or an unselected LABEL-disabled account row, forbids the
    // header select-all. Reuse the already-bound anchor once (its reopened drawer shows a
    // settled known subset with >=1 checked at footer checked-count/30) instead of clicking;
    // never assume a disabled-row click.
    const blockedHeaderOrRows=s=>s.ok===true&&Array.isArray(s.rows)&&s.rows.some(r=>r.checked!==true&&(s.headerLabelDisabled===true||r.labelDisabled===true));
    // The batch anchor is the product whose drawer is ACTIVE (its accounts get bound by the draft
    // 确定; the batch adds to the OTHER 29). It may be the first, the second, or the last product —
    // so it must come from the freshly-read active panel id, never from ids[0]. Before ANY
    // navigation / header / batch the drawer must expose a trustworthy 30-product panel list whose
    // set is exactly this batch, with a SINGLE active product that belongs to it (provePanelSet is
    // defined above reopenBoundAnchor). The real batch target is ALWAYS the strict object form.
    if(!consistentSelectionState(snap))return {ok:false,reason:'account-drawer-footer-row-state-conflict'};
    let batchAnchorId=provePanelSet(snap);
    if(!batchAnchorId)return {ok:false,reason:'account-drawer-panel-identity-unverified'};
    let state=snap.rows.map(r=>r.checked);
    // settled-checked (R33): at least one row actually checked and every row reads a
    // definite state (checked, or unchecked whether LABEL-disabled or an enabled target
    // left intentionally unbound — the approved min-1 subset)
    const settledChecked=s=>Array.isArray(s.rows)&&s.rows.length>=1&&s.rows.some(r=>r.checked===true)&&s.rows.every(r=>r.checked===true||r.checked===false);
    let fullyChecked=settledChecked(snap);
    if(fullyChecked){
      // The auto/current drawer already shows its 1-or-2 available target accounts CHECKED
      // at footer checked-count/30 on its ACTIVE
      // product. Reuse that product directly as the batch anchor with ZERO cancel/reopen/header —
      // but ONLY when the active product is itself a legitimately-bound manual2 inside this batch.
      // It need NOT be the first rows.find manual2; a second (or last) bound product's active is a
      // valid batch scope, so do not require every initial active to equal the first anchor.
      if(!isBoundManual2InBatch(batchAnchorId))return {ok:false,reason:'account-drawer-active-anchor-not-bound-manual2'};
    } else if(anchor&&!reopenedInStep2&&(blockedHeaderOrRows(snap)||(String(batchAnchorId)!==String(anchor.productId)&&!isBoundManual2InBatch(batchAnchorId)))){
      // A known manual2 anchor exists and the current 0/30 drawer must NOT be header-clicked here:
      // either its header/rows are LABEL-disabled, OR its ACTIVE product is a different, not-yet-
      // bound product (e.g. a freshly backfilled supplement whose own accounts are unbound). Reuse
      // the already-bound anchor regardless: cancel → positive-closed → uniquely open the anchor's
      // management → settle (read-only) to the proven drawer whose unique active EQUALS that
      // requested management product and whose 1-or-2 target rows are a settled known subset
      // (>=1 checked, remaining rows definite unchecked) at footer checked-count/30. ZERO extra
      // header click. Only THIS reopen-management path
      // requires active === the requested management product. (When the current active is itself the
      // anchor or another bound manual2 and is unblocked, fall through and header it directly.)
      snap=await reopenBoundAnchor();
      if(!snap||!snap.ok||!exactTwo(snap))return {ok:false,reason:rowsBlockedUnchecked(snap)?'native-account-rows-label-disabled':'native-account-header-select-all-disabled'};
      if(!consistentSelectionState(snap))return {ok:false,reason:'account-drawer-footer-row-state-conflict'};
      const reopenedAnchor=provePanelSet(snap);
      if(!reopenedAnchor)return {ok:false,reason:'anchor-account-panel-identity-unverified'};
      if(String(reopenedAnchor)!==String(anchor.productId))return {ok:false,reason:'anchor-active-management-product-mismatch'};
      state=snap.rows.map(r=>r.checked);
      fullyChecked=settledChecked(snap);
      if(!fullyChecked&&(snap.headerLabelDisabled===true||rowsBlockedUnchecked(snap)))return {ok:false,reason:'native-account-header-select-all-disabled'};
      batchAnchorId=reopenedAnchor;
    } else if(!anchor&&blockedHeaderOrRows(snap)){
      // NO bound anchor exists and the current active's accounts/header are disabled: bounded,
      // ordinary .panel navigation across the proven known ids looks for an active product whose
      // 1-or-2 target rows are ALL-UNCHECKED (0/30) with at least one ENABLED row (a LABEL-disabled
      // row is an unavailable target: the single header select-all then selects the remaining
      // available ones in ONE action), then a single header select-all.
      // Each candidate re-proves consistency / panel set / active and stops with ZERO further action
      // on any drift/duplicate/foreign/partial/footer anomaly; a fully-disabled candidate is skipped
      // without ever clicking a disabled checkbox; if none is usable we stop bounded.
      const panelIds=[...new Set(snap.panelProductIds.map(String))];
      const initialActive=batchAnchorId;
      const usableFor=(s,pid)=>s&&s.ok===true&&Array.isArray(s.activeProductIds)&&s.activeProductIds.length===1&&String(s.activeProductIds[0])===pid&&exactTwo(s)&&s.headerLabelDisabled===false&&Array.isArray(s.rows)&&s.rows.length>=1&&s.rows.length<=2&&s.rows.every(r=>r.ids.length===1&&r.checked===false)&&s.rows.some(r=>r.labelDisabled===false)&&s.selectedCount===0&&s.totalCount===30;
      let found=false;
      for(const pid of panelIds){
        if(pid===String(initialActive)) continue;
        let clk=null;
        try { clk=await page.evaluate(selectBindingDrawerPanelInPage,pid); } catch(_) { return {ok:false,reason:'account-anchor-panel-navigation-rejected'}; }
        if(!clk||clk.clicked!==true||String(clk.id)!==pid) return {ok:false,reason:'account-anchor-panel-navigation-not-confirmed'};
        let fresh=null;
        try {
          fresh=await until(()=>page.evaluate(bindingDrawerSnapshotInPage), s=>usableFor(s,pid), nativeTimeoutMs,'account-anchor-panel-usable');
        } catch(_) { fresh=await page.evaluate(bindingDrawerSnapshotInPage).catch(()=>null); }
        if(!fresh||fresh.ok!==true) return {ok:false,reason:'account-anchor-panel-readback-unknown'};
        // S26/S27：既有 consistentSelectionState(3338-3341) 与 3554 把页脚 selectedCount 视为当前唯一
        // active 商品"已勾选账号行数"的回读（全选→selectedCount=行数、全未选→0）；本页脚正则只捕获
        // `当前商品已选：(0)/(\d+)` 两个数字，不臆造其"30"的业务含义。当某候选商品在上方既有有界等待后
        // 仍稳定回读到 rows 为空、页脚 0/30，且本批 30 面板集合逐字不变、唯一 active===该候选时：这只是
        // "全未选→selectedCount 0"口径在零账号行下的自然一致情形（0 行=0 勾选），既不是页脚/行状态冲突，
        // 也绝不等于该商品已绑定成功。快照生产者未提供"暂无可选抖音号"空态文本字段，故不引入任何未证实的
        // 文本证明；保留上面 until 有界等待（行随后出现即按可用候选处理），仅对确经有界等待仍稳定为空的
        // 候选如实 continue 换下一个已知候选。绝不把空行计入绑定/成功/消费；整批皆空则循环穷尽 → 原
        // account-anchor-no-usable-product 诚实停止（零假成功）。
        const noEligibleForProduct=fresh.ok===true&&Array.isArray(fresh.rows)&&fresh.rows.length===0&&Number(fresh.selectedCount)===0&&Number(fresh.totalCount)===30&&panelSetEqualsIds(fresh)&&provePanelSet(fresh)===String(pid);
        if(noEligibleForProduct) continue;
        if(!consistentSelectionState(fresh)) return {ok:false,reason:'account-drawer-footer-row-state-conflict'};
        // Distinguish a broken 30-panel SET from a broken ACTIVE product so the stop reason is
        // meaningful: first prove the panel set still equals this batch, then prove the single
        // active still equals the candidate we navigated to.
        if(!panelSetEqualsIds(fresh)) return {ok:false,reason:'account-anchor-panel-set-drift'};
        const fAnchor=provePanelSet(fresh);
        if(!fAnchor||String(fAnchor)!==pid) return {ok:false,reason:'account-anchor-active-drift'};
        if(!exactTwo(fresh)) return {ok:false,reason:'account-anchor-account-identity-drift'};
        const checkedCount=fresh.rows.filter(r=>r.checked===true).length;
        if(checkedCount>0&&!settledChecked(fresh)) return {ok:false,reason:'account-anchor-partial-selection'};
        if(fresh.headerLabelDisabled===true||fresh.rows.every(r=>r.labelDisabled===true)) continue; // nothing selectable => next known candidate, never click a disabled checkbox
        snap=fresh; state=fresh.rows.map(r=>r.checked); fullyChecked=settledChecked(fresh); batchAnchorId=pid; found=true; break;
      }
      if(!found) return {ok:false,reason:'account-anchor-no-usable-product'};
    }
    // (no anchor + a usable unblocked 0/30, or an already-reopened STEP2 anchor still reading 0/30
    //  and unblocked) falls through to the single header select-all below.
    if(anchor&&String(batchAnchorId)!==String(anchor.productId)&&!isBoundManual2InBatch(batchAnchorId))return {ok:false,reason:'anchor-active-management-product-mismatch'};
    const fullyUnchecked=state.every(x=>x===false);
    const checkedNow=snap.rows.filter(r=>r.checked===true).length;
    if(snap.selectedCount===0&&!fullyUnchecked||snap.selectedCount>0&&(!fullyChecked||snap.selectedCount!==checkedNow))return {ok:false,reason:'account-drawer-footer-row-state-conflict'};
    if(!fullyChecked){
      await page.evaluate(selectAllAccountsInPage, targetPayload());
      let after;
      try {
        after=await until(()=>page.evaluate(bindingDrawerSnapshotInPage),
          s=>bindingAccountsSnapshotSettled(s,resolvedTargets,productsPerPlan),
          nativeTimeoutMs,'native-header-select-all');
      } catch(_) { after=await page.evaluate(bindingDrawerSnapshotInPage); }
      if(!bindingAccountsSnapshotSettled(after,resolvedTargets,productsPerPlan))return {ok:false,reason:'native-header-select-all-not-confirmed'};
      // Before the batch is applied, confirm the SAME captured active product / same 30-panel set
      // is still current: the header fresh-wait must not have let the drawer switch out from under
      // the anchor, or the batch would run on the wrong scope.
      if(!consistentSelectionState(after)||provePanelSet(after)!==batchAnchorId)return {ok:false,reason:'native-header-active-product-drift'};
      // Freeze THIS shop's real bindable accounts from the settled select-all readback
      // (no-op once already resolved). Everything downstream (batch modal, result,
      // drawer commit, returned accountIds) uses exactly this frozen set.
      const rz=resolveDiscoveredTargets(after);
      if(!rz.ok)return {ok:false,reason:rz.reason};
    } else {
      // The drawer already showed this product's accounts CHECKED (e.g. a prior same-day
      // plan). Freeze the shop's real bindable accounts from that settled readback so the
      // returned set / later gates use the discovered ids rather than the unresolved null.
      const rz=resolveDiscoveredTargets(snap);
      if(!rz.ok)return {ok:false,reason:rz.reason};
    }
    // STEP 3: batch is a BUTTON that opens a SEPARATE confirm modal (将在29个商品上批量添加
    // 2个抖音号). Click the button once, then a bounded FRESH wait that the modal is present
    // with the expected product/account counts while the drawer identity stays settled, then
    // click the MODAL 确定 once. Account drift / unknown modal => zero modal submit.
    await page.evaluate(applyBatchAccountsInPage, targetPayload());
    const expectedProducts=Math.max(0,ids.length-1);
    let modal;
    try {
      modal=await until(()=>page.evaluate(batchAddAllModalSnapshotInPage, targetPayload()),
        s=>s&&s.modalCount===1&&s.productCount===expectedProducts&&(s.accountCount===1||s.accountCount===2)&&s.drawerSettled===true,
        nativeTimeoutMs,'native-batch-apply-modal');
    } catch(_) { modal=null; }
    if(!modal||modal.modalCount!==1||modal.productCount!==expectedProducts||(modal.accountCount!==1&&modal.accountCount!==2)||modal.drawerSettled!==true)return {ok:false,reason:'native-batch-apply-modal-not-confirmed'};
    await page.evaluate(confirmBatchAddAllModalInPage,{expectedProducts,targets:resolvedTargets});
    // STEP 4: the real per-product RESULT modal is ASYNC. Bounded-wait on a READ-ONLY snapshot
    // until a POSITIVELY settled, complete result (recognised title, exactly the expected
    // unique authorized ids, each one definite 成功/失败, no duplicate/outside/unreadable row).
    // A not-yet-present modal is PENDING, not success; absence after the timeout or an unknown
    // result stops with ZERO acknowledge and ZERO drawer commit. No click is ever inside until.
    // The batch result is gated on the CURRENT active anchor (never ids[0]): when the anchor is
    // known the strict object form requires the result to exclude exactly that anchor and cover
    // every other authorized id. A legacy array form is only used if no anchor could be proven.
    // The batch result is gated on the CURRENT active anchor (never ids[0]). batchAnchorId is
    // always a proven non-null active id here, so the production driver uses the strict object
    // form unconditionally: the result must exclude exactly that anchor and cover every other
    // authorized id, and the ACK callback additionally re-proves that anchor is still the drawer's
    // active product. The legacy array form exists only for the public callback's standalone tests.
    const batchTarget={productIds:ids,anchorProductId:batchAnchorId,targets:resolvedTargets};
    let failedIds,failedSet,knownFailures;
    let settled=null;
    try { settled=await until(()=>page.evaluate(batchResultSnapshotInPage,batchTarget), s=>s&&s.settled===true, nativeTimeoutMs,'batch-result-settle'); }
    catch(_) { settled=null; }
    if(settled&&settled.settled===true){
      // The per-product RESULT modal really appeared and positively settled: the ONLY original
      // strict path — acknowledge the exact failed ids, then the drawer 确定 + partial warning.
      let result;
      try { result=await page.evaluate(acknowledgeBatchResultInPage,batchTarget); } catch(_) { return {ok:false,reason:'batch-result-not-acknowledged'}; }
      failedIds=((result&&Array.isArray(result.failedIds))?result.failedIds:[]).map(String);
      failedSet=new Set(failedIds);
      knownFailures=failedSet.size>0;
    } else {
      const rs=await page.evaluate(batchResultSnapshotInPage,batchTarget).catch(()=>null);
      if(rs&&rs.present===true&&rs.known===true&&rs.settled===false){
        // 已知部分失败提示但**没有**按旧口径列满全部 29 份结果（部分提示可能只列一部分失败，不等于全批
        // 失败，也不等于全批成功）：走本轮新增的 partial-close 通道——只用该已知标题根内的唯一右上角
        // close 关闭它（未知弹窗/多根/多 close/身份漂移在回调里零点击抛回），关闭本身绝不当成功。
        // 关闭后必须复用同一把只读 panel 逐商品导航，逐个确定当前授权 30 个唯一商品的已选账号：
        // >=1 保留、明确 0 记入 failedIds 交给既有 removal/backfill、任何缺失/unknown 立刻停下且
        // 零抽屉提交。全部读完才允许进入既有 确定 + 部分提交警告。
        let closed=null, closeErr=null;
        try { closed=await page.evaluate(closeKnownPartialResultInPage,batchTarget); } catch(e) { closeErr=e; }
        if(!closed||closed.closed!==true){
          // 保留 specific close error 的有界脱敏诊断（绝不 catch 全抹成 generic）：只做掩码+截断，不再吞掉
          // 具体拒绝原因；零点击/零提交语义不变。
          const closeError=closeErr?String(closeErr.message||'').replace(/\s+/g,' ').replace(/\d{8,}/g,'***').trim().slice(0,200):null;
          return {ok:false,reason:'known-partial-result-notice-not-closeable',...(closeError?{closeError}:{})};
        }
        let gone=false;
        try { await until(()=>page.evaluate(bindingOverlaySnapshotInPage),o=>!!o&&o.accountDrawerCount===1&&o.blockingOverlayPresent===false,nativeTimeoutMs,'known-partial-notice-closed'); gone=true; }
        catch(_) { gone=false; }
        if(gone!==true) return {ok:false,reason:'known-partial-result-notice-still-blocking'};
        const probe=await proveAllSuccessByPanelNavigation(batchAnchorId,'partial');
        if(probe.ok!==true) return probe;
        failedIds=(probe.zeroIds||[]).map(String);
        failedSet=new Set(failedIds);
        knownFailures=failedIds.length>0;
      } else {
        // The settled wait timed out. A present-but-unsettled modal is PENDING/UNKNOWN and must STOP,
        // never be probed around. Only a genuinely ABSENT result popup AND no other blocking overlay
        // AND a uniquely-present drawer is the platform's all-success-with-no-modal case; even then we
        // do not treat "no popup" as success — we prove it with a bounded read-only .panel readback of
        // all 30 ids (zero ACK). If that proof cannot be completed we stop with zero drawer commit.
        const ov=await page.evaluate(bindingOverlaySnapshotInPage).catch(()=>null);
        if(!rs||rs.present===true) return {ok:false,reason:'batch-result-pending-or-unknown-not-confirmed'};
        if(!ov||ov.accountDrawerCount!==1||ov.blockingOverlayPresent===true) return {ok:false,reason:'batch-result-pending-or-unknown-not-confirmed'};
        const probe=await proveAllSuccessByPanelNavigation(batchAnchorId);
        if(probe.ok!==true) return probe;
        failedIds=[];failedSet=new Set();knownFailures=false;
      }
    }
    // STEP 5: commit the drawer DRAFT with 确定 (identity re-verified in the callback), then
    // accept a partial-submit warning ONLY when the recorded outcome proved exact failed ids
    // (settled result modal, or an explicit 0 read from every panel in the partial-close path).
    await page.evaluate(confirmBatchAccountsApplyInPage, targetPayload());
    try { await page.evaluate(acceptPartialDraftWarningInPage,knownFailures); } catch(_) { return {ok:false,reason:'partial-draft-warning-not-acceptable'}; }
    // The fresh main table is the source of truth (R32 min-1): a row showing a definite
    // >=1 manual count is KEPT even if the batch result listed it as failed ("1个抖音号
    // 添加失败" can still mean the other account landed). A row in the proven failed set
    // may read 0 (both targets missed => removal/backfill handles it); a NON-failed row
    // must show a definite integer >=1 — 0/unknown/null never passes here, so an unknown
    // outcome is never widened into success.
    let final;
    try {
      final=await until(readMainTable,rs=>rs.length===30&&new Set(rs.map(r=>String(r.productId))).size===30&&ids.every(id=>rs.some(r=>String(r.productId)===id))&&rs.every(r=>(Number.isInteger(r.manualAccounts)&&r.manualAccounts>=1)||failedSet.has(String(r.productId))),15000,'manual-account-bind-readback');
    } catch(_) { return {ok:false,reason:'manual-account-bind-readback-does-not-match-recorded-outcome'}; }
    await guidancePhase();
    return {ok:true,accountIds:resolvedTargets.slice(),productCount:final.length,rows:final,partial:knownFailures,batchApplied:true,failedIds};
  }
  async function repairDraft({removeIds,backfillCount,onProgress}) {
    const before=await readMainTable();
    for(const id of removeIds) {
      const row=before.find(r=>r.productId===String(id));
      if(!row||!(row.autoPullOnly===true||row.manualEvidence===true&&Number.isInteger(row.manualAccounts)&&row.manualAccounts<1||row.reviewFailed))return {ok:false,reason:'removal-lacks-explicit-current-row-evidence:'+id};
      const removed=await page.evaluate(removeNativeCardInPage,{productId:String(id),accountId});
      await sleep(350);
      // 草稿删除后的引导浮窗只走**既有严格 guidance 身份/允许按钮**通道（未知一律不操作）；
      // 处理完后 confirm 仍按原规则：无对话框=即时移除，识别到的删除对话框=一次确认，
      // 已知无 ID 平台确认（"确定要删除商品吗？"）仅当携带 remove 已证明的行内删除证明时才点一次，
      // 其它任何仍在的模态=零点击 fail-closed（附带有限脱敏诊断，便于下一轮取证）。
      // remove 不抛即证明：已在授权创建路由、精确账户、唯一目标草稿行内点了一次唯一"删除"。
      // 该狭义证明只在本 repairDraft 链构造并透传，绝不新增全局权限 API / 通用 nonce。
      const removeProof=(removed&&removed.clicked===true&&String(removed.productId)===String(id))
        ?{rowProof:true,productId:String(id),accountId:String(accountId),route:'uni-creation/overall-product-multi'}:null;
      try { await guidancePhase(); } catch (_) { /* guidance 未知/失败：不改动作，交由 confirm 严格停止 */ }
      await page.evaluate(confirmDraftRemovalInPage,{productId:String(id),accountId,removeProof});
      await until(readMainTable,rows=>!rows.some(r=>r.productId===String(id)),10000,'draft-row-removal');
      attemptedSet.add(String(id));
    }
    dayState.lastSelected=(await readMainTable()).map(r=>String(r.productId));dayState.attempted=[...attemptedSet];await persist(dayState);
    const snap=await openPicker();
    const selected=dayState.lastSelected.map(String);
    if(selected.length!==30-removeIds.length||snap.selectedCount!==0||snap.remainingCapacity!==30-selected.length)throw new Error('post-removal-picker-selected-count-mismatch');
    const result=await browseProducts({selectedIds:selected,needed:30-selected.length,hints,publishedSet:new Set(publishedIds),attemptedSet,cursor:dayState.cursor,categories:wf.CATEGORY_TAB_ORDER,onProgress});
    if(!result.ok)return {ok:false,reason:result.reason,selectedCount:result.selectedIds.length,progress:result.selectedIds.length>selected.length};
    const newIds=result.selectedIds;
    const rows=await readMainTable();
    if(rows.length!==30||new Set(rows.map(r=>String(r.productId))).size!==30||rows.some(r=>!newIds.includes(r.productId))||newIds.some(id=>!rows.some(r=>String(r.productId)===id)))return {ok:false,reason:'repair-final-rows-do-not-match-final-picker'};
    dayState.lastSelected=newIds;dayState.hints=hints;await persist(dayState);
    return {ok:true,mainRows:rows,selectedCount:newIds.length,progress:true};
  }
  async function configurePlan({businessDate}) {
    const obs=await observe();if(!obs.creation||obs.creation.accountId!==accountId||!obs.creation.mainTableUnique)return {ok:false,reason:'creation-settings-observation-incomplete'};
    await guidancePhase();
    if(obs.creation.commissionChecked!==true) await page.evaluate(ensureCommissionInPage);
    if(obs.creation.optionalDirectPayChecked!==false) await page.evaluate(ensureDirectPayOffInPage);
    const toggles=await observe();
    if(!toggles.creation||toggles.creation.accountId!==accountId||toggles.creation.commissionChecked!==true||toggles.creation.optionalDirectPayChecked!==false)return {ok:false,reason:'commission-or-direct-pay-state-unknown'};
    const roi=toggles.elements.filter(e=>e.fillField&&e.fillField.recognized&&e.fillField.kind==='roi');
    const budget=toggles.elements.filter(e=>e.fillField&&e.fillField.recognized&&e.fillField.kind==='budget');
    if(roi.length!==1||budget.length!==1)return {ok:false,reason:'roi-budget-fields-not-unique'};
    if(String(roi[0].value)!==String(targetRoi))await page.evaluate(guard.actionApply,{observation:toggles.observation,index:roi[0].index,op:'fill',value:String(targetRoi),kind:'roi'});
    const fresh=await observe();const budgetNow=fresh.elements.filter(e=>e.fillField&&e.fillField.recognized&&e.fillField.kind==='budget');
    if(budgetNow.length!==1) return {ok:false,reason:'budget-field-drift'};
    if(String(budgetNow[0].value)!==String(targetBudget))await page.evaluate(guard.actionApply,{observation:fresh.observation,index:budgetNow[0].index,op:'fill',value:String(targetBudget),kind:'budget'});
    const planName=shanghaiPlanName(businessDate,planNumber);
    await page.evaluate(creationPlanNameInPage,planName);
    const verified=await observe();
    if(String(verified.creation.roi)!==String(targetRoi)||String(verified.creation.budget)!==String(targetBudget)||verified.creation.commissionChecked!==true||verified.creation.optionalDirectPayChecked!==false||verified.creation.planName!==planName)return {ok:false,reason:'plan-settings-readback-mismatch'};
    // Post-configuration guidance (including a config-stage 下一步) must be
    // handled and read back before this plan can reach ready-awaiting-confirmation.
    await guidancePhase();
    return {ok:true,planName};
  }
  async function readFinalDialog() { return page.evaluate(finalDialogSnapshotInPage); }
  // ── R39 controlled-reopen driver methods (read the CREATION page, not managerPage) ──
  // resumeKnownFinalOnly's reopen branch needs THREE real callables on the driver; in R38
  // they were referenced but never provided (typeof undefined), so the real recovery entry
  // could not run. These are thin pass-throughs to the SAME in-page guards the normal flow
  // already uses -- no business callback is re-implemented here and no click/await logic is
  // copied into the root.
  // (1) read-only full modal landscape over the shared dialog selector; zero side effects.
  async function readModalLandscape() { return page.evaluate(dialogLandscapeSnapshotInPage); }
  // (2) the single native "发布计划" click via the existing pure guard.publishApply: it
  // re-derives origin/path/account/30-unique/manual/ROI15/budget300/commission/name/directPay
  // from the CURRENT DOM and refuses (throws) on any drift or any visible dialog. The caller
  // passes the already-fresh observation token; we never fabricate it and never bare-click.
  // The real publishApply shape ({clicked:true,published:'unverified'}) is returned verbatim.
  async function clickNativePublishPlan(cmd) { return page.evaluate(guard.publishApply, cmd); }
  // (3) bounded post-click read of BOTH the known final dialog and the full modal landscape.
  // A known unique final resolves immediately with its own snapshot; ANY other visible blocking
  // modal resolves immediately as an unknown-visible dialog so the resume helper refuses rather
  // than waiting it out as "no modal". A frame with no dialog is never enough proof: the only
  // way to report noDialog is to exhaust the bounded window and then see a fresh strict
  // landscape of zero roots. Identity/origin uncertainty (a failed landscape read) is never
  // turned into noDialog. No auto-click, no reopen here; a bounded timeout is evidence-gathering,
  // NOT a publish failure. ctx.awaitFinalDialogTimeoutMs lets offline tests shrink the window.
  async function awaitFinalDialog() {
    const timeoutMs = Number.isInteger(ctx.awaitFinalDialogTimeoutMs) ? ctx.awaitFinalDialogTimeoutMs : 15000;
    let found = null;
    try {
      found = await until(async () => {
        const land = await page.evaluate(dialogLandscapeSnapshotInPage);
        const dlg = await page.evaluate(finalDialogSnapshotInPage);
        if (dlg && dlg.visible === true && !dlg.reason
          && wf.matchFinalExclusionDialog(dlg.text).known && wf.resolveFinalPublishButton(dlg.confirmTarget).ok) return { kind: 'known', dlg };
        if (land && land.ok === true && land.noBlockingModal === false) return { kind: 'unknown', text: (dlg && dlg.text) || (land.dialogTexts || []).join(' ') || 'unknown-blocking-modal' };
        return null;
      }, x => x !== null, timeoutMs, 'await-final-dialog');
    } catch (error) { found = null; }
    if (found && found.kind === 'known') return found.dlg;
    if (found && found.kind === 'unknown') return { visible: true, text: found.text, confirmTarget: null };
    let fresh = null;
    try { fresh = await page.evaluate(dialogLandscapeSnapshotInPage); } catch (_) { fresh = null; }
    if (fresh && fresh.ok === true && fresh.noBlockingModal === true && fresh.finalPresent !== true) return { visible: false, noDialog: true, landscape: fresh };
    return { visible: false, noDialog: false, reason: (fresh && fresh.ok === false) ? 'await-final-dialog-landscape-unproven' : 'await-final-dialog-window-expired' };
  }
  // R40 Objective A: after a real publish the platform auto-redirects the ORIGINAL
  // creation `page` to the same-account management route (the view that actually lists
  // the new plan). Prefer reading THAT live page directly — zero cold-goto, zero tab
  // switch — and only fall back to the strict cold-goto path when the original page is
  // still on creation or otherwise not a credible management view. We never fabricate a
  // filter URL/query, and never treat a sourceFrom=createSuccess string as row proof:
  // success requires the ACTUAL unique exact-name row + complete fields read from the DOM.
  async function readRowOnRedirectedManagementPage(planName, expectedAccount) {
    if (!page || typeof ctx.readAccountInPage !== 'function') return null;
    let identity;
    try { identity = await page.evaluate(ctx.readAccountInPage); } catch (_) { return null; }
    if (!identity || String(identity.accountId) !== String(expectedAccount)) return null;
    if (typeof identity.url === 'string' && identity.url !== '' && !MANAGEMENT_ROUTE_RE.test(identity.url)) return null;
    let result;
    try {
      result = await until(() => page.evaluate(readManagementRowsInPage, planName), managementRowComplete(expectedAccount), successManagementReadTimeoutMs, 'success-management-row');
    } catch (error) {
      const msg = String((error && error.message) || '');
      if (/success-management-row-timeout/.test(msg)) return { found: false, reason: 'management-row-or-required-fields-timeout' };
      return { found: false, reason: 'management-row-read-failed' };
    }
    if (String(result.accountId) !== String(expectedAccount)) return { found: false, reason: 'management-account-identity-drift' };
    if (result.rowCount !== 1) return { found: true, uniqueRow: false, accountId: expectedAccount, reason: 'management-plan-name-not-unique' };
    return { found: true, uniqueRow: true, accountId: expectedAccount, ...result.rows[0] };
  }
  async function readManagementRow({planName,accountId:expectedAccountId}) {
    const acc = String(expectedAccountId || accountId);
    if (acc !== String(accountId)) return { found: false, reason: 'management-account-identity-unknown' };
    const direct = await readRowOnRedirectedManagementPage(planName, acc);
    // R41: a direct-page read that TIMED OUT or ERRORED (found:false with one of the
    // two honest "couldn't read" reasons) must NOT permanently skip the strict cold-goto
    // fallback — the redirected page may simply never render the row list even though the
    // management view itself works. Identity drift / duplicate names / a real success are
    // conclusive and still returned as-is; null (page not a credible management view)
    // falls through exactly like before.
    const fallbackEligible = !!direct && direct.found === false
      && (direct.reason === 'management-row-or-required-fields-timeout' || direct.reason === 'management-row-read-failed');
    if (direct && !fallbackEligible) return direct;
    await managerPage.goto(managementUrl,{waitUntil:'domcontentloaded',timeout:60000});
    if(String(expectedAccountId||accountId)!==String(accountId))return {found:false,reason:'management-account-identity-unknown'};
    const settled=await settleManagementIdentity(accountId);
    if(!settled.ok)return {found:false,reason:settled.reason};
    const clicked=await managerPage.evaluate(ctx.clickSubTab('商品自选'));
    if(!clicked||clicked.clicked!==true)return {found:false,reason:'management-product-self-tab-not-found'};
    let result;
    try { result=await until(()=>managerPage.evaluate(readManagementRowsInPage,planName),managementRowComplete(accountId),120000,'management-row-complete'); }
    catch(error) {
      if(/management-row-complete-timeout/.test(String(error&&error.message||'')))return {found:false,reason:'management-row-or-required-fields-timeout'};
      return {found:false,reason:'management-row-read-failed'};
    }
    if(result.accountId!==accountId)return {found:false,reason:'management-account-identity-drift'};
    if(result.rowCount!==1)return {found:true,uniqueRow:false,accountId,reason:'management-plan-name-not-unique'};
    return {found:true,uniqueRow:true,accountId,...result.rows[0]};
  }
  async function readCurrentShopEnableState() {
    try {
      const identity=await managerPage.evaluate(ctx.readAccountInPage);
      if(!identity||String(identity.accountId)!==String(accountId)||!/^https:\/\/qianchuan\.jinritemai\.com\/(?:uni-prom\/overall|overall-prom)(?:[/?#]|$)/i.test(String(identity.url||'')))return {readOk:false,enabled:null,reason:'current-shop-state-identity-or-route-unknown'};
      const readRows=ctx.readShopRowsInPage,readPagination=ctx.readShopPaginationInPage,goFirst=ctx.goFirstShopPageInPage,goNext=ctx.goNextShopPageInPage;
      if(typeof readRows!=='function'||typeof readPagination!=='function'||typeof goFirst!=='function'||typeof goNext!=='function')return {readOk:false,enabled:null,reason:'current-shop-state-read-contract-missing'};
      const allRows=[];
      for(const tabName of ['商品自选','全店托管']) {
        const tab=await managerPage.evaluate(ctx.clickSubTab(tabName));
        if(!tab||tab.clicked!==true)return {readOk:false,enabled:null,reason:'current-shop-state-tab-not-confirmed:'+tabName};
        // R36: a just-switched tab may briefly show the PREVIOUS tab's cached total
        // or an intermediate total that later grows; the FIRST numeric total is not
        // settled. Settle the rows + pagination twice-consecutive-consistent (with
        // hasNext page math) BEFORE goFirst, then again on page 1, and never accept
        // an old / transient numeric. Timeout is an honest refusal, never enabled.
        let settled;
        try { settled=await settleShopTabList(readRows,readPagination); }
        catch(error){ return {readOk:false,enabled:null,reason:'current-shop-state-tab-settle-timeout:'+tabName}; }
        const first=await managerPage.evaluate(goFirst);
        if(first&&first.reason)return {readOk:false,enabled:null,reason:'current-shop-state-first-page-unavailable:'+tabName};
        try { settled=await settleShopTabList(readRows,readPagination,1); }
        catch(error){ return {readOk:false,enabled:null,reason:'current-shop-state-tab-settle-timeout:'+tabName}; }
        let shape=settled.shape;
        if(shape.activePage!==1)return {readOk:false,enabled:null,reason:'current-shop-state-first-page-not-settled:'+tabName};
        const allTabRows=[];const total=shape.total;const pageSize=shape.pageSize;
        if(!Number.isInteger(total)||total<1||!Number.isInteger(pageSize)||pageSize<1)return {readOk:false,enabled:null,reason:'current-shop-state-list-incomplete:'+tabName};
        const totalPages=Math.ceil(total/pageSize);let currentPage=1;
        for(let pageNo=1;pageNo<=totalPages;pageNo++) {
          if(shape.total!==total)return {readOk:false,enabled:null,reason:'current-shop-state-total-drift:'+tabName};
          if(shape.activePage!==pageNo)return {readOk:false,enabled:null,reason:'current-shop-state-page-identity-unknown:'+tabName};
          if(shape.hasNext!==(pageNo<totalPages))return {readOk:false,enabled:null,reason:'current-shop-state-pagination-incomplete:'+tabName};
          const ids=shape.rows.map(row=>String(row.id||''));
          const expectedOnPage=pageNo<totalPages?pageSize:(total-(pageNo-1)*pageSize);
          if(ids.length!==expectedOnPage)return {readOk:false,enabled:null,reason:'current-shop-state-list-incomplete:'+tabName};
          if(ids.some(id=>!/^\d{12,20}$/.test(id))||new Set(ids).size!==ids.length||allTabRows.some(row=>ids.includes(String(row.id))))return {readOk:false,enabled:null,reason:'current-shop-state-row-ids-unknown:'+tabName};
          allTabRows.push(...shape.rows);
          if(pageNo<totalPages) {
            const before=ids.slice().sort().join(',');
            const move=await managerPage.evaluate(goNext);
            if(!move||move.clicked!==true)return {readOk:false,enabled:null,reason:'current-shop-state-next-page-unavailable:'+tabName};
            try { shape=await until(async()=>{const [r2,p2]=await Promise.all([managerPage.evaluate(readRows),managerPage.evaluate(readPagination)]);const s=shopSnapshotShape(r2,p2);if(!s||s.total!==total||s.activePage!==pageNo+1)return null;if(s.rows.map(row=>String(row.id||'')).sort().join(',')===before)return null;return s;},x=>x!==null,managementTabSettleTimeoutMs,'current-shop-state-page'); }
            catch(error){ return {readOk:false,enabled:null,reason:'current-shop-state-page-transition-timeout:'+tabName}; }
          }
        }
        if(allTabRows.length!==total)return {readOk:false,enabled:null,reason:'current-shop-state-total-mismatch:'+tabName};
        allRows.push(...allTabRows);
      }
      const ids=allRows.map(row=>String(row.id||''));
      if(new Set(ids).size!==ids.length)return {readOk:false,enabled:null,reason:'current-shop-state-cross-tab-duplicate-plan-id'};
      const states=allRows.map(row=>row.switchChecked);
      if(states.some(value=>typeof value!=='boolean'))return {readOk:false,enabled:null,reason:'current-shop-state-switch-unknown'};
      if(states.some(value=>value!==states[0]))return {readOk:false,enabled:null,reason:'current-shop-state-mixed'};
      return {readOk:true,enabled:states[0],accountId:String(accountId),rowCount:states.length,source:'fresh-exact-shop-both-plan-tabs-complete-switches'};
    } catch(error) { return {readOk:false,enabled:null,reason:'current-shop-state-read-failed:'+(error&&error.message||'unknown')}; }
  }
  async function readExistingPlanIds() {
    return managerPage.evaluate(()=>[...document.querySelectorAll('tr[data-row-key]')].map(r=>r.getAttribute('data-row-key')).filter(x=>/^\d{12,20}$/.test(String(x))));
  }
  // Trusted read-only absence scan for the final-only resume path. It does NOT
  // reuse the plain publish main's readManagementRow semantics and makes ZERO
  // writes: it reuses the SAME managerPage / ctx identity + 商品自选 tab + the
  // existing shop row/pagination/first/next readers and exhaustively walks EVERY
  // page of the correct account's 商品自选 list. After a goto / tab switch the SPA
  // briefly shows the previous tab's cached total or an intermediate total that later
  // grows (real evidence: parseable total 10 while the tab actually has 32 rows across
  // 4 pages, hasNext true). The FIRST numeric total is therefore NOT trusted: the list
  // is settled only when rows + pagination are complete AND two consecutive reads agree
  // (total/pageSize/activePage/rows-length) AND the pagination is arithmetically
  // consistent (hasNext === activePage < ceil(total/pageSize)). Absence is confirmed ONLY
  // when the account is correct and stays identical on every page, the scan walks EVERY
  // page to the last (strict hasNext completion), the frozen total never drifts mid-scan,
  // ids are unique/non-duplicate, per-page row counts match the page capacity, and this
  // exact plan name appears 0 times (or a settled total===0 with a loaded empty state).
  // Any identity drift, mid-scan total change, timeout, missing field or unexhausted scan
  // returns absenceConfirmed:false. When absent it also returns every pre-existing plan id
  // (from ALL pages, not one page) so the caller can freeze the old-id set BEFORE the
  // single final click; a present name (>=1) is refused. It never clicks and never mutates state.
  async function readManagementAbsence({planName,accountId:expectedAccountId}={}) {
    const expected=String(expectedAccountId||accountId);
    if(expected!==String(accountId))return {absenceConfirmed:false,absent:false,present:false,reason:'absence-account-identity-unknown'};
    try {
      await managerPage.goto(managementUrl,{waitUntil:'domcontentloaded',timeout:60000});
      const settled=await settleManagementIdentity(accountId);
      if(!settled.ok)return {absenceConfirmed:false,absent:false,present:false,reason:settled.reason};
      const tab=await managerPage.evaluate(ctx.clickSubTab('商品自选'));
      if(!tab||tab.clicked!==true)return {absenceConfirmed:false,absent:false,present:false,reason:'absence-tab-not-confirmed'};
      if(typeof ctx.readShopRowsInPage!=='function'||typeof ctx.readShopPaginationInPage!=='function'||typeof ctx.goFirstShopPageInPage!=='function'||typeof ctx.goNextShopPageInPage!=='function')return {absenceConfirmed:false,absent:false,present:false,reason:'absence-read-contract-missing'};
      let listSettled;
      try { listSettled=await settleShopTabList(ctx.readShopRowsInPage,ctx.readShopPaginationInPage); }
      catch(error){ return {absenceConfirmed:false,absent:false,present:false,reason:'absence-tab-list-settle-timeout'}; }
      let shape=listSettled.shape;
      if(shape.activePage!==1){
        const first=await managerPage.evaluate(ctx.goFirstShopPageInPage);
        if(first&&first.reason)return {absenceConfirmed:false,absent:false,present:false,reason:'absence-first-page-unavailable'};
        try { listSettled=await settleShopTabList(ctx.readShopRowsInPage,ctx.readShopPaginationInPage,1); }
        catch(error){ return {absenceConfirmed:false,absent:false,present:false,reason:'absence-tab-list-settle-timeout'}; }
        shape=listSettled.shape;
        if(shape.activePage!==1)return {absenceConfirmed:false,absent:false,present:false,reason:'absence-first-page-not-settled'};
      }
      const baseTotal=shape.total,pageSize=shape.pageSize,totalPages=Math.ceil(baseTotal/pageSize);
      if(baseTotal===0){
        const emptyName=await managerPage.evaluate(readManagementRowsInPage,planName);
        const ident0=await managerPage.evaluate(ctx.readAccountInPage);
        if(!ident0||String(ident0.accountId)!==String(accountId))return {absenceConfirmed:false,present:false,reason:'absence-page-identity-drift'};
        if(emptyName&&emptyName.rowCount===0&&shape.emptyState===true&&shape.rows.length===0)
          return {absenceConfirmed:true,absent:true,present:false,seenPlanIds:[],accountId,account:expected,total:0,pages:1};
        return {absenceConfirmed:false,absent:false,present:false,reason:'absence-zero-total-not-confirmed-empty'};
      }
      const seenPlanIds=[];let nameMatches=0,scanned=0;
      for(let pageNo=1;pageNo<=totalPages;pageNo++){
        if(shape.total!==baseTotal)return {absenceConfirmed:false,present:false,reason:'absence-total-drift'};
        if(shape.activePage!==pageNo)return {absenceConfirmed:false,present:false,reason:'absence-page-identity-unknown'};
        if(shape.hasNext!==(pageNo<totalPages))return {absenceConfirmed:false,present:false,reason:'absence-pagination-incomplete'};
        const ident=await managerPage.evaluate(ctx.readAccountInPage);
        if(!ident||String(ident.accountId)!==String(accountId))return {absenceConfirmed:false,present:false,reason:'absence-page-identity-drift'};
        const nameRes=await managerPage.evaluate(readManagementRowsInPage,planName);
        nameMatches+=(nameRes&&nameRes.rowCount)||0;
        const ids=shape.rows.map(r=>String(r&&r.id||''));
        const expectedOnPage=pageNo<totalPages?pageSize:(baseTotal-(pageNo-1)*pageSize);
        if(ids.length!==expectedOnPage)return {absenceConfirmed:false,present:false,reason:'absence-row-count-mismatch'};
        if(ids.some(id=>!/^\d{12,20}$/.test(id))||new Set(ids).size!==ids.length)return {absenceConfirmed:false,present:false,reason:'absence-row-ids-unknown'};
        if(seenPlanIds.some(x=>ids.includes(x)))return {absenceConfirmed:false,present:false,reason:'absence-duplicate-plan-id'};
        seenPlanIds.push(...ids);scanned+=ids.length;
        if(pageNo<totalPages){
          const before=ids.slice().sort().join(',');
          const move=await managerPage.evaluate(ctx.goNextShopPageInPage);
          if(!move||move.clicked!==true)return {absenceConfirmed:false,present:false,reason:'absence-next-page-unavailable'};
          try { shape=await until(async()=>{const [r2,p2]=await Promise.all([managerPage.evaluate(ctx.readShopRowsInPage),managerPage.evaluate(ctx.readShopPaginationInPage)]);const s=shopSnapshotShape(r2,p2);if(!s||s.total!==baseTotal||s.activePage!==pageNo+1)return null;if(s.rows.map(x=>String(x&&x.id||'')).sort().join(',')===before)return null;return s;},x=>x!==null,managementTabSettleTimeoutMs,'absence-page'); }
          catch(error){ return {absenceConfirmed:false,present:false,reason:'absence-page-transition-timeout'}; }
        }
      }
      if(scanned!==baseTotal||seenPlanIds.length!==baseTotal)return {absenceConfirmed:false,present:false,reason:'absence-total-mismatch'};
      if(nameMatches>=1)return {absenceConfirmed:false,absent:false,present:true,seenPlanIds,account:expected,total:baseTotal,nameMatches,reason:'absence-plan-name-present'};
      return {absenceConfirmed:true,absent:true,present:false,seenPlanIds,account:expected,accountId:expected,total:baseTotal,pages:totalPages};
    } catch(error){ return {absenceConfirmed:false,present:false,reason:'absence-scan-failed:'+(error&&error.message||'unknown')}; }
  }
  async function saveCookies() {
    const session=opened&&opened.cookieSession;
    if(!session||!context||!session.filePath||!session.startFingerprint)return {status:'skipped',reason:'live-cookie-session-unavailable'};
    const probe=await managerPage.evaluate(guard.cookieIdentityProbe,accountId);
    const {writebackSessionCookies,fingerprintFile}=require(path.join(projectRoot,'src/login/cookie-writeback'));
    let expectedWrite=null;
    const ownedContext=new Proxy(context,{get(target,property){
      if(property!=='cookies')return Reflect.get(target,property,target);
      return async(...args)=>{
      const cookies=await Reflect.apply(Reflect.get(target,'cookies',target),target,args);
      if(Array.isArray(cookies)) {
        const serialized=JSON.stringify(cookies,null,2);
        expectedWrite={
          sha256:crypto.createHash('sha256').update(serialized,'utf8').digest('hex'),
          bytes:Buffer.byteLength(serialized,'utf8'),
          count:cookies.length,
          domains:new Set(cookies.map(cookie=>cookie&&cookie.domain)).size,
        };
      }
      return cookies;
      };
    }});
    const summary=await guard.runSaveCookies({}, {context:ownedContext,cookieSession:session,probe,accountId,writeback:opts=>writebackSessionCookies(opts)});
    if(summary.status==='saved') {
      const fp=fingerprintFile(session.filePath);
      const proof=guard.updateCookieSessionFingerprint(session,summary,expectedWrite,fp);
      if(!proof.updated)return {status:'failed',reason:proof.reason||'cookie-post-write-fingerprint-readback-mismatch'};
    }
    return {status:summary.status,reason:summary.reason||null,count:summary.count||null,bytes:summary.bytes||null,domains:summary.domains||null,conflict:summary.conflict===true};
  }
  const guidancePhase=()=>runGuidancePhase(page,{accountId,saveCookies,persistFlags:async()=>{
    const captured=await page.evaluate(guidanceStorageCaptureInPage,accountId);
    return persistPrivateGuidanceState(guidanceFilePath(accountId,ctx.guidancePrivateDir),accountId,(captured&&captured.values)||[]);
  }});
  return {openCreationPage:async()=>{
    const creationPage=await context.newPage();
    await creationPage.goto(creationUrl,{waitUntil:'domcontentloaded',timeout:60000});
    page=creationPage;
    const obs=await until(observe,x=>x.creation&&x.creation.accountId===accountId,30000,'creation-page-identity');
    const guidance=await guidancePhase();
    if(obs.creation.commissionChecked!==true) await page.evaluate(ensureCommissionInPage);
    const fresh=await observe();
    return {header:{originOk:/^https:\/\/qianchuan\.jinritemai\.com$/.test(new URL(fresh.url).origin),accountId:fresh.creation.accountId,commissionOptionPresent:fresh.creation.commissionChecked===true},guidance:{handled:guidance.handled,flagsSaved:guidance.flagsSaved===true}};
  },browseProducts,bindAccountsToAll,readMainTable,repairDraft,configurePlan,readFinalDialog,readModalLandscape,clickNativePublishPlan,awaitFinalDialog,readManagementRow,readManagementAbsence,readCurrentShopEnableState,readExistingPlanIds,saveCookies,commitPicker,observe,clickFinalConfirm:async({expectedText})=>page.evaluate(clickFinalConfirmInPage,expectedText),evaluate:(fn,arg)=>page.evaluate(fn,arg),get page(){return page;},get managerPage(){return managerPage;},get resolvedBoundAccounts(){return resolvedTargets?resolvedTargets.slice():null;},get guidancePrivateDir(){return ctx.guidancePrivateDir||null;}};
}

function shanghaiPlanName(date, planNumber, nowMs) {
  const now=new Date(nowMs===undefined?Date.now():nowMs);
  const p=new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(now);
  const get=t=>(p.find(x=>x.type===t)||{}).value||'00';
  return `${date}_千川乘方_${get('hour')}:${get('minute')}:${get('second')}${planNumber>1?'_'+planNumber:''}`;
}

function reserveFinalAndRecord(attemptFile, frozen) {
  guard.consumeFinalConfirmationOnce(attemptFile,frozen.confirmationId,frozen.manifestHash);
}

async function inspectRecoveryOnly({root, unresolved, state, business}) {
  const biz=business||wf.BUSINESS;
  const {loadConfig}=require(path.join(root,'src/config'));
  const {openChengfangShop,readChengfangAccountInPage,clickChengfangSubTab,closeBrowser}=require(path.join(root,'src/adapters/chengfang-reader'));
  const result=loadConfig();if(!result.ready)throw new Error('project-config-not-ready');
  // Read-only recovery must NOT be blocked by the external monitor `enabled` flag,
  // and a generic shop whose config accountId is null must still be openable: the
  // unique named row is selected, a KNOWN local account that differs from the frozen
  // business account is refused, and an UNKNOWN local account defers to the live check
  // below BEFORE any sub-tab click or readback.
  const shopCfg=shopProfile.selectNamedShopConfig(result.config,biz.shop,{accountId:biz.accountId});
  // Thread the frozen business account into the navigation object as a HINT only;
  // the live identity is STILL re-checked below before any tab click / readback.
  const opened=await openChengfangShop({loginCfg:result.config.login,shopCfg:navigationShopCfg(shopCfg,biz.accountId),headless:false});
  try {
    const identity=await opened.target.evaluate(readChengfangAccountInPage);
    if(biz.accountId!=null&&String(identity.accountId)!==String(biz.accountId))throw new Error('recovery-account-identity-unknown');
    await opened.target.evaluate(clickChengfangSubTab('商品自选'));
    const active=state.active&&state.active.frozen;
    if(!active)return {status:'recovery-unresolved-no-frozen-plan',unresolvedCount:unresolved.length};
    const rows=await opened.target.evaluate(readManagementRowsInPage,active.planName);
    return {status:'read-only-recovery-observed',planName:active.planName,rowCount:rows.rowCount,accountId:rows.accountId,unresolvedCount:unresolved.length};
  } finally { await closeBrowser(opened.browser); }
}

// ── narrow final-confirm-only resumption (exported, dependency-injected) ──────
// resumeKnownFinalOnly resumes ONLY the single plan whose initial publish already
// dispatched but whose FINAL mutual-exclusion confirm stopped with reason
// 'unknown-or-new-final-dialog' and left finalConsumed empty. It NEVER replays the
// initial publish, never resets nonce/day-state/unknown back to dispatched, and does
// not open a browser/CDP or touch the network itself: every live reader and every
// file path is injected, and there is no import-time side effect (main() is not
// called). Normal `main` stays read-only-recovery; this is a deliberate, separately
// authorized entry the host brain may call with a page it ALREADY owns.
//
// R34A hardening:
//   * pre-existing plan IDs are FROZEN from the trusted management ABSENCE scan
//     BEFORE any consumption/click; the post-click "is this planId new?" test uses
//     that frozen set, never a re-read of the (already updated) management page, so
//     a just-created id can never be misclassified as plan-id-not-new;
//   * absence uses readManagementAbsence (a real createRealDrivers method): it must
//     report absenceConfirmed===true, correct account, an exhausted full-page scan and
//     the complete seenPlanIds. A found:false with timeout/identity-unknown/unexhausted
//     scan is NOT trusted and yields ZERO consumption and ZERO clicks;
//   * the frozen manifest hash is RECOMPUTED from the durable active.frozen and must
//     match its own claimed hash (no tampered frozen passing on copied fields);
//   * after a confirmed absence the creation page is re-observed fresh (name/30 unique
//     ids/integer manual>=1/ROI15/day300/commission ON/direct-pay OFF/origin/account)
//     and the modal must be the KNOWN unique body with a unique enabled semantic button;
//   * the final confirm stays a durable one-shot reservation BEFORE the single click;
//     any dispatch exception is recorded 'unknown' and never retried;
//   * business SUCCESS is persisted durably first (both attempt ledgers + published
//     products + day-state plans/firstPublishedPlan), and the ordinary enable hook is
//     only READ afterwards via planPostPublishEnable: a fresh readOk+enabled keeps
//     published-success (next main may continue to the next plan), while paused/mixed/
//     unknown or an unverified hook reports post-publish-enable-stopped WITHOUT discarding
//     the published fact and WITHOUT ever assuming it was enabled.
async function resumeKnownFinalOnly(deps) {
  const d = deps || {};
  const now = typeof d.nowMs === 'function' ? d.nowMs() : (d.nowMs != null ? d.nowMs : Date.now());
  // trusted business（客户 2026-10-11）：默认回落 legacy 冻结默认（accountId/roi/30 商品），
  // 显式传入则按该店身份/ROI 泛化；默认路径行为不变（legacy 兼容）。
  const business = wf.bizOf(d.business);
  const account = String(business.accountId);
  const productsPerPlan = Number.isInteger(business.productsPerPlan) ? business.productsPerPlan : wf.BUSINESS.productsPerPlan;
  const expectedRoi = (typeof business.roi === 'number' && Number.isFinite(business.roi) && business.roi > 0) ? business.roi : 15;
  // 日预算随可信 business（S4：排程 policy 可到 450）；缺失回落 legacy 300，legacy 原行为不变。
  const expectedBudget = (typeof business.dailyBudget === 'number' && Number.isFinite(business.dailyBudget) && business.dailyBudget > 0) ? business.dailyBudget : 300;
  const refuse = (reason) => ({ status: 'refused', reason, clicked: false, clicks: 0 });
  const need = (name) => { if (typeof d[name] !== 'function') throw new Error('resume-dependency-missing:' + name); };
  for (const fn of ['observeCreation', 'readFinalDialog', 'clickFinalConfirm', 'readManagementRow', 'readManagementAbsence']) need(fn);
  if (!d.stateFile || !d.publishedFile || !d.attemptsFile) throw new Error('resume-file-scope-missing');

  const frozen = d.frozen;
  if (!frozen || !frozen.confirmationId || !frozen.manifestHash || !frozen.planName
    || !(Number.isInteger(frozen.planNumber) && frozen.planNumber >= 1 && frozen.planNumber <= 10)
    || !frozen.businessDate || !frozen.runId) return refuse('expected-frozen-incomplete');
  if (String(frozen.accountId) !== account) return refuse('expected-frozen-account-mismatch');

  // Same business-day guard: a stopped final confirm is only resumable today.
  if (wf.shanghaiDate(now) !== String(frozen.businessDate)) return refuse('business-date-changed');
  const businessDate = String(frozen.businessDate);

  let state;
  try { state = wf.loadDayState(d.stateFile, businessDate); } catch (e) { return refuse('day-state-unreadable:' + (e && e.message)); }
  const active = state.active;
  if (!active || active.status !== 'publish-unknown' || active.reason !== 'unknown-or-new-final-dialog') return refuse('not-the-unique-stopped-final-confirm');
  const af = active.frozen;
  if (!af || af.confirmationId !== frozen.confirmationId || af.manifestHash !== frozen.manifestHash
    || Number(af.planNumber) !== Number(frozen.planNumber) || String(af.runId) !== String(frozen.runId)
    || String(af.businessDate) !== businessDate || String(af.accountId) !== account
    || af.planName !== frozen.planName) return refuse('active-frozen-mismatch');
  // Recompute the durable frozen's own hash: a tampered frozen (fields edited but the
  // hash copied, or vice-versa) fails this and cannot ride the resume path.
  if (wf.manifestHash(af) !== af.manifestHash) return refuse('frozen-manifest-tampered');
  if ((af.productIds || []).map(String).join(',') !== (frozen.productIds || []).map(String).join(',')) return refuse('frozen-product-ids-mismatch');

  // Latest same-day human authorization (host passes the user's explicit acceptance)
  // plus the durable human-consumption record already written by the confirmation UI.
  const ha = d.humanAuth;
  if (!ha || ha.authorized !== true || ha.confirmationId !== frozen.confirmationId
    || ha.manifestHash !== frozen.manifestHash || Number(ha.planNumber) !== Number(frozen.planNumber)
    || String(ha.businessDate) !== businessDate || ha.planName !== frozen.planName) return refuse('human-authorization-mismatch');
  const consumed = (state.confirmationConsumptions || []).filter(c => c && c.confirmationId === frozen.confirmationId && c.manifestHash === frozen.manifestHash && Number(c.planNumber) === Number(frozen.planNumber));
  if (consumed.length === 0) return refuse('human-consumption-record-missing');

  // Initial attempt must exist as 'unknown' (the official stop overwrote dispatched);
  // finalConsumed must be absent (this is the FIRST final attempt, never a replay).
  let attempts;
  try { attempts = guard.loadAttemptsStore(d.attemptsFile); } catch (e) { return refuse('attempts-unreadable:' + (e && e.message)); }
  const init = attempts.consumed[frozen.confirmationId];
  if (!init || init.status !== 'unknown' || init.manifestHash !== frozen.manifestHash
    || String(init.runId) !== String(frozen.runId) || String(init.businessDate) !== businessDate
    || Number(init.planNumber) !== Number(frozen.planNumber)) return refuse('initial-attempt-not-unknown');
  if (Object.prototype.hasOwnProperty.call(attempts.finalConsumed, frozen.confirmationId)) return refuse('final-already-consumed');

  // Trusted read-only absence BEFORE anything is consumed or clicked. Only a fully
  // exhausted, correct-account scan that reports absenceConfirmed===true with a
  // complete seenPlanIds may proceed; the frozen old-id set is taken from here and is
  // the ONLY set used to judge the new plan id as "new" after the click.
  const abs = await d.readManagementAbsence({ planName: frozen.planName, accountId: account });
  if (abs && abs.present === true) return refuse('already-published-in-manager');
  if (!abs || abs.absenceConfirmed !== true) return refuse('management-absence-untrusted');
  if (String(abs.accountId || abs.account) !== account) return refuse('management-absence-account-mismatch');
  if (!Array.isArray(abs.seenPlanIds)) return refuse('management-absence-seen-ids-missing');
  const frozenOldPlanIds = abs.seenPlanIds.map(String);

  // Fresh creation re-observe against the frozen manifest.
  const obs = await d.observeCreation();
  const o = obs && obs.creation ? obs.creation : obs;
  if (!o || o.originOk !== true || o.pathOk !== true || String(o.accountId) !== account) return refuse('creation-origin-or-account-drift');
  if (String(o.planName) !== String(frozen.planName)) return refuse('creation-plan-name-drift');
  if (Number(o.uniqueProductCount) !== productsPerPlan || Number(o.productRowCount) !== productsPerPlan
    || !Array.isArray(o.productIds) || o.productIds.length !== productsPerPlan) return refuse('creation-product-count-drift');
  const fIds = (frozen.productIds || []).map(String).slice().sort().join(',');
  const oIds = o.productIds.map(String).slice().sort().join(',');
  if (!fIds || fIds !== oIds) return refuse('creation-product-ids-not-frozen');
  const rows = Array.isArray(o.rows) ? o.rows : [];
  if (o.eachRowHasManualAccount !== true || rows.length !== productsPerPlan
    || !rows.every(r => r && Number.isInteger(Number(r.manualAccounts)) && Number(r.manualAccounts) >= 1)) return refuse('creation-manual-account-drift');
  if (String(o.roi) !== String(expectedRoi) || String(o.budget) !== String(expectedBudget) || o.commissionChecked !== true
    || o.optionalDirectPayChecked !== false || Number(o.publishButtonCount) !== 1) return refuse('creation-config-drift');

  // ── shared success/failure persistence ─────────────────────────────────────
  // Persist the business fact durably FIRST (attempt ledgers + published products +
  // day-state + firstPublishedPlan), then only READ the ordinary enable hook (never
  // extended, never assumed). `finalClicks` distinguishes a real final-confirm from a
  // DIRECT publish (platform submitted with no dialog): a direct success NEVER writes a
  // finalConsumed / never fakes a final click -- only the reopen marker records its
  // result. `reopenClicks` (0/1) mirrors the controlled one-shot reopen accounting.
  async function commitPublishedSuccess(outcome, { reopenClicks, finalClicks, readback }) {
    const hadFinal = finalClicks > 0;
    if (outcome.outcome !== 'success') {
      // Preserve unknown/failed: no replay; a real final stays 'unknown'; the initial is
      // never promoted to success; the reopen marker locks the second reopen.
      if (hadFinal) guard.recordFinalConfirmationOutcome(d.attemptsFile, frozen.confirmationId, 'unknown');
      guard.recordPublicationOutcome(d.attemptsFile, frozen.confirmationId, outcome.outcome === 'failed' ? 'failed' : 'unknown');
      if (reopenClicks) { try { guard.recordReopenOutcome(d.attemptsFile, frozen.confirmationId, 'unknown'); } catch (_) {} }
      const latest = wf.loadDayState(d.stateFile, businessDate);
      latest.active = { ...(latest.active || {}), status: 'publish-unknown', planNumber: frozen.planNumber, frozen, reason: outcome.reason || 'resume-not-confirmed' };
      wf.persistDayState(d.stateFile, latest);
      return { status: outcome.outcome === 'failed' ? 'failed' : 'unknown', reason: outcome.reason || 'resume-not-confirmed', planId: outcome.planId || null, clicked: hadFinal, clicks: finalClicks, reopenClicks, finalClicks, noReplay: true };
    }
    let finalDurable = true;
    if (hadFinal) finalDurable = guard.recordFinalConfirmationOutcome(d.attemptsFile, frozen.confirmationId, 'success');
    const initialDurable = guard.recordPublicationOutcome(d.attemptsFile, frozen.confirmationId, 'success');
    if (finalDurable !== true || initialDurable !== true) {
      return { status: 'unknown', reason: 'resume-outcome-not-durable', planId: outcome.planId, clicked: hadFinal, clicks: finalClicks, reopenClicks, finalClicks, noReplay: true };
    }
    try {
      const pubStore = wf.loadPublishedStore(d.publishedFile, d.seedFile);
      const next = wf.appendPublished(pubStore, { productIds: frozen.productIds, planId: outcome.planId, date: businessDate });
      wf.persistPublished(d.publishedFile, next);
      const updated = wf.loadDayState(d.stateFile, businessDate);
      updated.plans = [...(updated.plans || []), { planNumber: frozen.planNumber, status: 'success', planId: String(outcome.planId), manifestHash: frozen.manifestHash }];
      if (Number(frozen.planNumber) === 1 && !updated.firstPublishedPlan) {
        updated.firstPublishedPlan = { planNumber: 1, status: 'success', planId: String(outcome.planId), account_id: account, product_ids: frozen.productIds.slice(), planName: frozen.planName, manifestHash: frozen.manifestHash, businessDate, runId: frozen.runId };
      }
      updated.lastSelected = []; updated.runId = frozen.runId; updated.businessDate = businessDate;
      wf.persistDayState(d.stateFile, updated);
      if (reopenClicks) guard.recordReopenOutcome(d.attemptsFile, frozen.confirmationId, 'success');
    } catch (error) {
      return { status: 'unknown', reason: 'resume-write-back-failed:' + (error && error.message), planId: outcome.planId, clicked: hadFinal, clicks: finalClicks, reopenClicks, finalClicks, noReplay: true };
    }
    let enableObservation = { action: 'stop', status: 'unknown-current-state', reason: 'enable-read-hook-not-provided' };
    let current = { readOk: false, enabled: null, reason: 'enable-read-hook-not-provided' };
    if (typeof d.readCurrentShopEnableState === 'function') {
      try { current = await d.readCurrentShopEnableState(); } catch (error) { current = { readOk: false, enabled: null, reason: 'enable-read-failed:' + (error && error.message) }; }
      enableObservation = wf.planPostPublishEnable(current, {});
    }
    const publishedSuccess = true;
    const enableOk = current.readOk === true && current.enabled === true && enableObservation.status === 'already-enabled';
    try {
      const latest = wf.loadDayState(d.stateFile, businessDate);
      if (enableOk) latest.active = null;
      else latest.active = { ...(latest.active || {}), status: 'post-publish-enable-stopped', planNumber: frozen.planNumber, frozen, planId: String(outcome.planId), reason: (current.reason || enableObservation.gap || enableObservation.reason || 'current-shop-not-safely-enabled') };
      wf.persistDayState(d.stateFile, latest);
    } catch (error) {
      return { status: 'unknown', reason: 'resume-enable-state-persist-failed:' + (error && error.message), planId: outcome.planId, clicked: hadFinal, clicks: finalClicks, reopenClicks, finalClicks, noReplay: true };
    }
    if (typeof d.saveCookies === 'function') { try { await d.saveCookies(); } catch (_) {} }
    return {
      status: 'success', publishedSuccess, directPublish: finalClicks === 0, planId: String(outcome.planId), clicked: hadFinal, clicks: finalClicks, reopenClicks, finalClicks, readback,
      postPublishEnable: { status: enableOk ? 'already-enabled' : (enableObservation.status || 'unknown-current-state'), reason: enableOk ? null : (current.reason || enableObservation.gap || enableObservation.reason || null), actionTaken: false, continueNextPlan: enableOk === true },
    };
  }

  // Known unique final dialog present: reserve + single final click + readback + persist.
  // Used both by the default final-only path (reopenClicks 0) and by a controlled reopen
  // that brought the known dialog back (reopenClicks 1). The "is this planId new?" test
  // uses ONLY the pre-click frozen old-id set; the management page is never re-scanned.
  async function finalizeKnownDialogClick(reopenClicks) {
    try {
      guard.consumeFinalConfirmationOnce(d.attemptsFile, frozen.confirmationId, frozen.manifestHash, {
        reason: 'unknown-or-new-final-dialog', humanAuthorizedAt: String(ha.at || new Date(now).toISOString()), humanConfirmation: '确认发布',
      });
    } catch (e) { return { status: 'refused', reason: 'final-confirm-consume-failed:' + (e && e.message), clicked: false, clicks: 0, reopenClicks, finalClicks: 0 }; }
    let finalClick;
    try {
      finalClick = await d.clickFinalConfirm({ expectedText: wf.FINAL_EXCLUSION_TEXT, confirmationId: frozen.confirmationId, manifestHash: frozen.manifestHash });
    } catch (error) {
      try { guard.recordFinalConfirmationOutcome(d.attemptsFile, frozen.confirmationId, 'unknown'); } catch (_) {}
      if (reopenClicks) { try { guard.recordReopenOutcome(d.attemptsFile, frozen.confirmationId, 'unknown'); } catch (_) {} }
      return { status: 'unknown', reason: 'final-confirm-dispatch-unknown:' + (error && error.message), clicked: false, clicks: 1, reopenClicks, finalClicks: 1, noReplay: true };
    }
    if (!finalClick || finalClick.clicked !== true) {
      try { guard.recordFinalConfirmationOutcome(d.attemptsFile, frozen.confirmationId, 'unknown'); } catch (_) {}
      if (reopenClicks) { try { guard.recordReopenOutcome(d.attemptsFile, frozen.confirmationId, 'unknown'); } catch (_) {} }
      return { status: 'unknown', reason: (finalClick && finalClick.reason) || 'final-confirm-not-confirmed', clicked: false, clicks: 1, reopenClicks, finalClicks: 1, noReplay: true };
    }
    const readback = await d.readManagementRow({ planName: frozen.planName, accountId: account });
    const outcome = wf.classifyPublishOutcome(readback, { planName: frozen.planName, accountId: account, existingPlanIds: frozenOldPlanIds, productsPerPlan, roi: expectedRoi, dailyBudget: expectedBudget });
    return commitPublishedSuccess(outcome, { reopenClicks, finalClicks: 1, readback });
  }

  // Known unique modal + unique enabled semantic button, read fresh before reserving.
  const dlg = await d.readFinalDialog();
  const knownFinalNow = !!dlg && dlg.visible === true && wf.matchFinalExclusionDialog(dlg.text).known && wf.resolveFinalPublishButton(dlg.confirmTarget).ok;
  if (knownFinalNow) return finalizeKnownDialogClick(0);

  // The known final dialog is NOT present. Default stays final-only -> refuse. Only an
  // EXPLICIT opt-in, one-shot, controlled reopen may proceed, and only after we can
  // DEFINITIVELY prove no final or other blocking modal is present (a bare visible:false
  // with an ambiguous reason is never treated as "no modal"). This path never generalises
  // to an unknown retry: it is the single already-authorized first plan whose final modal
  // disappeared, with the final still unconsumed.
  if (d.allowReopenMissingFinal !== true) return refuse('final-dialog-unknown-or-new');
  for (const fn of ['readModalLandscape', 'clickNativePublishPlan', 'awaitFinalDialog']) {
    if (typeof d[fn] !== 'function') return refuse('reopen-dependency-missing:' + fn);
  }
  let landscape;
  try { landscape = await d.readModalLandscape(); } catch (e) { return refuse('reopen-modal-landscape-read-failed:' + (e && e.message)); }
  if (!landscape || landscape.ok !== true || landscape.noBlockingModal !== true) return refuse('reopen-modal-landscape-unproven');
  if (landscape.finalPresent === true) return refuse('reopen-final-modal-present');

  // Durable one-shot reopen marker BEFORE the single native click; it can never be
  // cleared, so any later exception/timeout/crash refuses a second reopen and default
  // main still routes to read-only recovery. A persistence failure throws -> 0 clicks.
  try {
    guard.consumeReopenOnce(d.attemptsFile, frozen.confirmationId, { businessDate, runId: String(frozen.runId), manifestHash: frozen.manifestHash, planNumber: frozen.planNumber });
  } catch (e) {
    if (/already consumed/.test(String(e && e.message))) return refuse('reopen-already-consumed');
    if (/invalid|unreadable/.test(String(e && e.message))) return refuse('reopen-marker-store-invalid');
    return refuse('reopen-marker-write-failed:' + (e && e.message));
  }

  // Single native "发布计划" reopen click. Reuses guard.publishApply semantics (the
  // injected dep must itself re-derive every DOM precondition and refuse any visible
  // dialog) -- never a copied unbounded locator.
  let nativeClick;
  try {
    nativeClick = await d.clickNativePublishPlan({ observation: obs.observation, planNumber: frozen.planNumber, accountId: account, productIds: frozen.productIds, planName: frozen.planName, roi: String(expectedRoi), budget: String(expectedBudget) });
  } catch (error) {
    try { guard.recordReopenOutcome(d.attemptsFile, frozen.confirmationId, 'unknown'); } catch (_) {}
    return { status: 'unknown', reason: 'reopen-native-dispatch-unknown:' + (error && error.message), clicked: false, clicks: 0, reopenClicks: 1, finalClicks: 0, noReplay: true };
  }
  if (!nativeClick || nativeClick.clicked !== true) {
    try { guard.recordReopenOutcome(d.attemptsFile, frozen.confirmationId, 'unknown'); } catch (_) {}
    return { status: 'unknown', reason: (nativeClick && nativeClick.reason) || 'reopen-native-not-confirmed', clicked: false, clicks: 0, reopenClicks: 1, finalClicks: 0, noReplay: true };
  }

  // Bounded fresh read of the known unique final dialog after the reopen.
  let dlg2;
  try { dlg2 = await d.awaitFinalDialog(); } catch (error) {
    try { guard.recordReopenOutcome(d.attemptsFile, frozen.confirmationId, 'unknown'); } catch (_) {}
    return { status: 'unknown', reason: 'reopen-await-final-dialog-failed:' + (error && error.message), clicked: false, clicks: 0, reopenClicks: 1, finalClicks: 0, noReplay: true };
  }
  const knownAfterReopen = !!dlg2 && dlg2.visible === true && wf.matchFinalExclusionDialog(dlg2.text).known && wf.resolveFinalPublishButton(dlg2.confirmTarget).ok;
  const visibleButUnknown = !!dlg2 && dlg2.visible === true && !knownAfterReopen;
  const noDialogAfterReopen = !!dlg2 && dlg2.visible === false && dlg2.noDialog === true;
  if (visibleButUnknown) {
    try { guard.recordReopenOutcome(d.attemptsFile, frozen.confirmationId, 'unknown'); } catch (_) {}
    return { status: 'unknown', reason: 'reopen-new-unknown-modal', clicked: false, clicks: 0, reopenClicks: 1, finalClicks: 0, noReplay: true };
  }
  if (knownAfterReopen) return finalizeKnownDialogClick(1);
  if (noDialogAfterReopen) {
    // No dialog at all: the platform may have submitted directly. Verify with a fresh
    // management readback; ONLY a confirmed exact name + NEW id + complete settings is a
    // real direct success, and it NEVER fabricates a finalConsumed / final click.
    const readback = await d.readManagementRow({ planName: frozen.planName, accountId: account });
    const outcome = wf.classifyPublishOutcome(readback, { planName: frozen.planName, accountId: account, existingPlanIds: frozenOldPlanIds, productsPerPlan, roi: expectedRoi, dailyBudget: expectedBudget });
    if (outcome.outcome !== 'success') {
      guard.recordPublicationOutcome(d.attemptsFile, frozen.confirmationId, 'unknown');
      try { guard.recordReopenOutcome(d.attemptsFile, frozen.confirmationId, 'unknown'); } catch (_) {}
      const latest = wf.loadDayState(d.stateFile, businessDate);
      latest.active = { ...(latest.active || {}), status: 'publish-unknown', planNumber: frozen.planNumber, frozen, reason: outcome.reason || 'reopen-direct-not-confirmed' };
      wf.persistDayState(d.stateFile, latest);
      return { status: 'unknown', reason: outcome.reason || 'reopen-direct-readback-unconfirmed', planId: outcome.planId || null, clicked: false, clicks: 0, reopenClicks: 1, finalClicks: 0, noReplay: true };
    }
    return commitPublishedSuccess(outcome, { reopenClicks: 1, finalClicks: 0, readback });
  }
  // Missing / ambiguous post-click evidence: stop as unknown, never reopen a second time.
  try { guard.recordReopenOutcome(d.attemptsFile, frozen.confirmationId, 'unknown'); } catch (_) {}
  return { status: 'unknown', reason: 'reopen-final-dialog-evidence-ambiguous', clicked: false, clicks: 0, reopenClicks: 1, finalClicks: 0, noReplay: true };
}

// ── R40 Objective B: browser-write-free / ad-click-free fact reconciliation ─────
// The main brain already performed a REAL controlled publish/reopen for the single
// already-authorized first plan and the platform really generated it, but the local
// driver readback FAILED (active is 'publish-unknown' with a CHANGED reason and the
// one-shot final/reopen markers are already consumed as unknown). This entry ONLY
// reconciles the durable local facts from a fresh, trusted READ of the real management
// row. It NEVER opens a browser, NEVER clicks publish/final/reopen, NEVER reserves or
// consumes a nonce, NEVER resets the original unknown one-shot records to retryable, and
// NEVER re-reads the current plan ids to define the "old" set (the complete prior old-id
// list is INJECTED by the main brain as trusted evidence). It is deliberately separate
// from normal `main` / HTTP confirm / selection binding, which are unchanged.
//
// Success requires, all together: unique frozen scope match to the durable active, same
// business day, recomputed manifest hash intact, exact same CID/run/account/name/30
// product ids, an existing same-CID/hash human authorization + durable consumption
// record, the initial attempt still durably 'unknown' with the final AND reopen markers
// already present (unknown/pending), and a fresh readManagementRow whose row passes the
// UNCHANGED wf.classifyPublishOutcome (account / exact name / NEW id outside the injected
// old set / 30 products / 1-or-2 manual accounts / ROI 15 / day 300 / commission / a
// legal live 投放 status). Only then are the original ledgers promoted to a real success
// and the published products + day plan + firstPublishedPlan appended (idempotent: a
// second run never duplicates). The publication fact is persisted BEFORE the fresh
// shop-enable READ; if the shop is not verifiably all-enabled (paused / mixed / unknown)
// the active stays post-publish-enable-stopped with the new id and we NEVER fake enabled
// and NEVER clear it. A persistence failure keeps the already-written facts and reports
// without any re-publish. Plans 2 & 3 are not prepared or published here.
async function reconcilePublishedReadbackOnly(deps) {
  const d = deps || {};
  const now = typeof d.nowMs === 'function' ? d.nowMs() : (d.nowMs != null ? d.nowMs : Date.now());
  // trusted business（客户 2026-10-11）：默认回落 legacy 冻结默认；显式传入按该店身份/ROI 泛化。
  const business = wf.bizOf(d.business);
  const account = String(business.accountId);
  const productsPerPlan = Number.isInteger(business.productsPerPlan) ? business.productsPerPlan : wf.BUSINESS.productsPerPlan;
  const expectedRoi = (typeof business.roi === 'number' && Number.isFinite(business.roi) && business.roi > 0) ? business.roi : 15;
  const refuse = (reason) => ({ status: 'refused', reason, clicked: false, clicks: 0, noAction: true });

  // Fail closed against any accidental live-action wiring: this entry only READS.
  for (const forbidden of ['clickFinalConfirm', 'clickNativePublishPlan', 'awaitFinalDialog', 'consumeFinalConfirmationOnce', 'consumeReopenOnce', 'reserveConfirmation', 'startPublish', 'publishApply']) {
    if (typeof d[forbidden] === 'function') return refuse('reconcile-forbids-live-action-dependency:' + forbidden);
  }
  for (const fn of ['readManagementRow', 'readCurrentShopEnableState']) {
    if (typeof d[fn] !== 'function') throw new Error('reconcile-dependency-missing:' + fn);
  }
  if (!d.stateFile || !d.publishedFile || !d.attemptsFile) throw new Error('reconcile-file-scope-missing');
  if (!Array.isArray(d.trustedPriorOldPlanIds)) return refuse('trusted-prior-old-plan-ids-missing');

  const frozen = d.frozen;
  if (!frozen || !frozen.confirmationId || !frozen.manifestHash || !frozen.planName
    || !(Number.isInteger(frozen.planNumber) && frozen.planNumber >= 1 && frozen.planNumber <= 10)
    || !frozen.businessDate || !frozen.runId) return refuse('expected-frozen-incomplete');
  if (String(frozen.accountId) !== account) return refuse('expected-frozen-account-mismatch');
  if (wf.shanghaiDate(now) !== String(frozen.businessDate)) return refuse('business-date-changed');
  const businessDate = String(frozen.businessDate);

  let state;
  try { state = wf.loadDayState(d.stateFile, businessDate); } catch (e) { return refuse('day-state-unreadable:' + (e && e.message)); }

  let attempts;
  try { attempts = guard.loadAttemptsStore(d.attemptsFile); } catch (e) { return refuse('attempts-unreadable:' + (e && e.message)); }
  const init = attempts.consumed[frozen.confirmationId];
  if (!init || init.manifestHash !== frozen.manifestHash
    || String(init.runId) !== String(frozen.runId) || String(init.businessDate) !== businessDate
    || Number(init.planNumber) !== Number(frozen.planNumber)) return refuse('initial-attempt-missing');

  // Idempotent already-reconciled path: the initial is durably success -> never append
  // again. This is checked BEFORE the publish-unknown guard because a completed reconcile
  // leaves active as post-publish-enable-stopped (or null), not publish-unknown. Re-read
  // (read-only) to confirm the durable day plan / published plan / real management row all
  // still agree on the same NEW id; any disagreement is a conflict stop, never a rewrite.
  if (init.status === 'success') {
    const dayPlan = (state.plans || []).find(p => Number(p.planNumber) === Number(frozen.planNumber) && p.status === 'success' && p.planId);
    let pubStore = null;
    try { pubStore = wf.loadPublishedStore(d.publishedFile, d.seedFile); } catch (e) { return refuse('published-unreadable:' + (e && e.message)); }
    if (!dayPlan) return refuse('already-success-but-day-plan-missing');
    const inPublished = pubStore.plans.some(p => String(p.planId) === String(dayPlan.planId));
    if (!inPublished) return refuse('already-success-but-published-missing');
    const readback = await d.readManagementRow({ planName: frozen.planName, accountId: account });
    const outcome = wf.classifyPublishOutcome(readback, { planName: frozen.planName, accountId: account, existingPlanIds: d.trustedPriorOldPlanIds.map(String), productsPerPlan, roi: expectedRoi, dailyBudget: business.dailyBudget });
    if (outcome.outcome !== 'success' || String(outcome.planId) !== String(dayPlan.planId)) return refuse('already-success-reconcile-conflict');
    return { status: 'alreadyReconciled', planId: String(dayPlan.planId), clicked: false, clicks: 0, noAction: true, noReplay: true };
  }

  // The reconcile-unknown path: the durable active is the unique publish-unknown stopped
  // publication (with the post-resume CHANGED reason) whose one-shot markers are already
  // consumed as unknown/pending.
  const active = state.active;
  if (!active || active.status !== 'publish-unknown') return refuse('not-the-unique-unknown-publication');
  const af = active.frozen;
  if (!af || af.confirmationId !== frozen.confirmationId || af.manifestHash !== frozen.manifestHash
    || Number(af.planNumber) !== Number(frozen.planNumber) || String(af.runId) !== String(frozen.runId)
    || String(af.businessDate) !== businessDate || String(af.accountId) !== account
    || af.planName !== frozen.planName) return refuse('active-frozen-mismatch');
  if (wf.manifestHash(af) !== af.manifestHash) return refuse('frozen-manifest-tampered');
  if ((af.productIds || []).map(String).join(',') !== (frozen.productIds || []).map(String).join(',')) return refuse('frozen-product-ids-mismatch');

  const ha = d.humanAuth;
  if (!ha || ha.authorized !== true || ha.confirmationId !== frozen.confirmationId
    || ha.manifestHash !== frozen.manifestHash || Number(ha.planNumber) !== Number(frozen.planNumber)
    || String(ha.businessDate) !== businessDate || ha.planName !== frozen.planName) return refuse('human-authorization-mismatch');
  const humanConsumed = (state.confirmationConsumptions || []).filter(c => c && c.confirmationId === frozen.confirmationId && c.manifestHash === frozen.manifestHash && Number(c.planNumber) === Number(frozen.planNumber));
  if (humanConsumed.length === 0) return refuse('human-consumption-record-missing');

  const finalRec = attempts.finalConsumed[frozen.confirmationId];
  const reopenRec = (attempts.reopenConsumed || {})[frozen.confirmationId];

  // Only the unique frozen where the initial is still 'unknown' AND BOTH the final and
  // reopen one-shot markers are already consumed (unknown/pending) is reconcilable here.
  if (init.status !== 'unknown') return refuse('initial-attempt-not-unknown');
  if (!finalRec || !['unknown', 'pending'].includes(finalRec.status)) return refuse('final-marker-not-unknown');
  if (!reopenRec || !['unknown', 'pending'].includes(reopenRec.status)) return refuse('reopen-marker-not-unknown');

  // Trusted fresh READ of the real management row; classify with the injected prior old
  // ids ONLY (never a re-read of the now-updated management page as the old set).
  const readback = await d.readManagementRow({ planName: frozen.planName, accountId: account });
  const outcome = wf.classifyPublishOutcome(readback, { planName: frozen.planName, accountId: account, existingPlanIds: d.trustedPriorOldPlanIds.map(String), productsPerPlan, roi: expectedRoi, dailyBudget: business.dailyBudget });
  if (outcome.outcome !== 'success') {
    // Never promote; the original unknown one-shot records and the publish-unknown active
    // stay exactly as they are; report honestly; zero live action.
    return { status: outcome.outcome === 'failed' ? 'failed' : 'unknown', reason: outcome.reason || 'reconcile-readback-not-confirmed', planId: outcome.planId || null, clicked: false, clicks: 0, noAction: true, noReplay: true };
  }
  const planId = String(outcome.planId);

  // Promote the ORIGINAL one-shot records to the real success (they already exist; this is
  // not a new consumption). Durable first; a non-durable promotion stops before any file
  // append, keeping the unknown facts intact and taking no further action.
  let finalDurable = true;
  try { finalDurable = guard.recordFinalConfirmationOutcome(d.attemptsFile, frozen.confirmationId, 'success'); } catch (_) { finalDurable = false; }
  const initialDurable = guard.recordPublicationOutcome(d.attemptsFile, frozen.confirmationId, 'success');
  let reopenDurable = true;
  try { reopenDurable = guard.recordReopenOutcome(d.attemptsFile, frozen.confirmationId, 'success'); } catch (_) { reopenDurable = false; }
  if (finalDurable !== true || initialDurable !== true || reopenDurable !== true) {
    return { status: 'unknown', reason: 'reconcile-outcome-not-durable', planId, clicked: false, clicks: 0, noAction: true, noReplay: true };
  }

  // Append published products + day plan + firstPublishedPlan, idempotent against a
  // second run. On any write error keep what was already written and report (no re-publish).
  try {
    const pubStore = wf.loadPublishedStore(d.publishedFile, d.seedFile);
    if (!pubStore.plans.some(p => String(p.planId) === planId)) {
      const next = wf.appendPublished(pubStore, { productIds: frozen.productIds, planId, date: businessDate });
      wf.persistPublished(d.publishedFile, next);
    }
    const updated = wf.loadDayState(d.stateFile, businessDate);
    if (!(updated.plans || []).some(p => String(p.planId) === planId && Number(p.planNumber) === Number(frozen.planNumber))) {
      updated.plans = [...(updated.plans || []), { planNumber: frozen.planNumber, status: 'success', planId, manifestHash: frozen.manifestHash }];
    }
    if (Number(frozen.planNumber) === 1 && !updated.firstPublishedPlan) {
      updated.firstPublishedPlan = { planNumber: 1, status: 'success', planId, account_id: account, product_ids: frozen.productIds.slice(), planName: frozen.planName, manifestHash: frozen.manifestHash, businessDate, runId: frozen.runId };
    }
    updated.lastSelected = []; updated.runId = frozen.runId; updated.businessDate = businessDate;
    wf.persistDayState(d.stateFile, updated);
  } catch (error) {
    return { status: 'unknown', reason: 'reconcile-write-back-failed:' + (error && error.message), planId, clicked: false, clicks: 0, noAction: true, noReplay: true };
  }

  // Fresh shop-enable READ happens AFTER the publication fact is durable. Never assume or
  // force enabled: paused / mixed / unknown keeps post-publish-enable-stopped WITH the new
  // id and does NOT clear active. No enable hook is wired or invoked here; the lock / daily
  // dedup are unchanged; a 凌晨 already_on record is never treated as now-enabled.
  let current = { readOk: false, enabled: null, reason: 'enable-read-failed' };
  try { current = await d.readCurrentShopEnableState(); } catch (error) { current = { readOk: false, enabled: null, reason: 'enable-read-failed:' + (error && error.message) }; }
  const enableObservation = wf.planPostPublishEnable(current, {});
  const enableOk = current.readOk === true && current.enabled === true && enableObservation.status === 'already-enabled';
  try {
    const latest = wf.loadDayState(d.stateFile, businessDate);
    if (enableOk) latest.active = null;
    else latest.active = { ...(latest.active || {}), status: 'post-publish-enable-stopped', planNumber: frozen.planNumber, frozen, planId, reason: (current.reason || enableObservation.gap || enableObservation.reason || 'current-shop-not-safely-enabled') };
    wf.persistDayState(d.stateFile, latest);
  } catch (error) {
    return { status: 'unknown', reason: 'reconcile-enable-state-persist-failed:' + (error && error.message), planId, clicked: false, clicks: 0, noAction: true, noReplay: true };
  }
  return {
    status: 'success', reconciled: true, planId, clicked: false, clicks: 0, noAction: true, noReplay: true, readback,
    postPublishEnable: { status: enableOk ? 'already-enabled' : (enableObservation.status || 'unknown-current-state'), reason: enableOk ? null : (current.reason || enableObservation.gap || enableObservation.reason || null), actionTaken: false, continueNextPlan: enableOk === true },
  };
}

async function main() {
  let releaseLock=null, opened=null, ui=null, preserveOwnedBrowser=false, postPublishEnableObservation=null;
  try {
    const root=guard.resolveProjectRoot(process.env);
    const shopArg=shopProfile.parseShopArg(process.argv.slice(2));
    if(shopArg.error)throw new Error(shopArg.error);
    const legacyProfile=shopProfile.profileFromBusiness(wf.BUSINESS);
    const legacyDefault=(!shopArg.shop||shopArg.shop===wf.BUSINESS.shop)&&!shopArg.account&&!shopArg.targets;
    const {openChengfangShop,readChengfangAccountInPage,clickChengfangSubTab,collectChengfangRowsInPage,collectChengfangPaginationInPage,clickChengfangFirstPageInPage,clickChengfangNextPageInPage,closeBrowser}=require(path.join(root,'src/adapters/chengfang-reader'));
    const {loadConfig}=require(path.join(root,'src/config'));
    const cfg=loadConfig();if(!cfg.ready)throw new Error('project-config-not-ready');
    // 手动入口也必须用页面保存的 ROI/预算（客户 2026-10-11）：ROI 取本店配置 targetRoi
    // （buildShopProfile 同一条严格校验，脏值一律拒绝），预算取正式 planPublishing.dailyBudget，
    // 缺省保持 legacy 15/300。ROI/预算变动**不**改变目录派生（slug 只由店名+账户决定）。
    const manualBudget=(function(){
      const pp=(cfg.config&&cfg.config.planPublishing)||{};
      const b=pp.dailyBudget;
      if(b===undefined||b===null)return 300;
      if(typeof b!=='number'||!Number.isFinite(b)||!(b>0))throw new Error('plan-publishing-budget-invalid');
      return b;
    })();
    let business,paths,shopCfg=null;
    if(legacyDefault){
      // Unique-by-name selection that IGNORES the external monitor `enabled` flag
      // (an enabled:false row must never exclude the explicitly named default shop)
      // while still requiring the KNOWN legacy account to match.
      shopCfg=shopProfile.selectNamedShopConfig(cfg.config,wf.BUSINESS.shop,{accountId:wf.BUSINESS.accountId});
      business=shopProfile.buildShopProfile({...legacyProfile,roi:shopCfg.targetRoi,dailyBudget:manualBudget,maxPlansPerDay:shopCfg.plansPerShopPerDay});
      // The default shop's runtime scope is account-independent and known before any
      // browser, so its original lock-before-open ordering is preserved EXACTLY (no
      // behaviour change for the existing flat files / lock).
      paths=publisherStatePaths(legacyProfile,true);
    } else {
      shopCfg=shopProfile.selectShopConfig(cfg.config,shopArg.shop);
      business=shopProfile.buildShopProfile({
        shop:shopCfg.name,
        accountId:shopCfg.accountId!=null?shopCfg.accountId:shopArg.account,
        boundAccounts:(shopArg.targets&&shopArg.targets.length)?shopArg.targets:(shopCfg.boundAccounts||null),
        roi:shopCfg.targetRoi,
        dailyBudget:manualBudget,
        maxPlansPerDay:shopCfg.plansPerShopPerDay,
        creationPath:(shopCfg.creationPath||wf.BUSINESS.creationPath),
      });
    }
    const date=wf.shanghaiDate(Date.now());
    if(legacyDefault)releaseLock=acquireLock(paths.lockFile);
    // Identity is proven from the LIVE session BEFORE any account-scoped path, lock or
    // state/history read/write. A generic shop whose configured accountId is null must
    // never create a `...__pending` directory or claim a published history before its
    // real 千川 account is known; only a verified identity derives the per-account
    // runtime scope. A same-name shop resolving to a different account is a distinct
    // scope; the same shop + account keeps its existing directory/history in place.
    // The verified business account (frozen profile or CLI --account read from the
    // live header) is threaded into the EXISTING home-navigation object as a HINT
    // only; the live identity is STILL re-proven by verifyLiveIdentity below and the
    // CLI/live match gate is unchanged. The hint never authenticates or writes config.
    opened=await openChengfangShop({loginCfg:cfg.config.login,shopCfg:navigationShopCfg(shopCfg,business.accountId),headless:false});
    const identity=await opened.target.evaluate(readChengfangAccountInPage);
    const liveCheck=shopProfile.verifyLiveIdentity(business,String(identity.accountId));
    if(!liveCheck.ok)throw new Error(liveCheck.reason);
    if(shopArg.account&&String(shopArg.account)!==liveCheck.accountId)throw new Error('cli-account-does-not-match-live-session');
    if(!business.accountId||String(business.accountId)!==liveCheck.accountId)business=shopProfile.buildShopProfile({...business,accountId:liveCheck.accountId});
    // NOW derive the account-scoped runtime paths + lock, then read this shop's state.
    if(!legacyDefault){
      paths=publisherStatePaths(business,false);
      releaseLock=acquireLock(paths.lockFile);
    }
    const STATE_FILE=paths.stateFile, PUBLISHED_FILE=paths.publishedFile, ATTEMPTS_FILE=paths.attemptsFile;
    const stateRaw=fs.existsSync(STATE_FILE)?JSON.parse(fs.readFileSync(STATE_FILE,'utf8')):null;
    const attempts=guard.loadAttemptsStore(ATTEMPTS_FILE);
    const unresolved=listManualUnresolved(attempts);
    if(shouldRunReadOnlyRecovery(stateRaw||{},attempts)) {
      const recovery=await inspectRecoveryOnly({root,unresolved,state:stateRaw||{},business});
      console.log(JSON.stringify({op:'stopped',reason:'read-only-recovery-required',recovery}));
      return;
    }
    const state=wf.loadDayState(STATE_FILE,date);
    const published=wf.loadPublishedStore(PUBLISHED_FILE,paths.seedFile,business.accountId);
    if(published.seeded)wf.persistPublished(PUBLISHED_FILE,published);
    // Per-shop state binding: a shop directory may only ever belong to one verified
    // 千川 account. A same-name shop later resolved to a different account stops here
    // instead of mixing histories.
    if(paths.isolated){
      const identityFile=path.join(paths.dir,'shop-identity.json');
      if(fs.existsSync(identityFile)){
        let prev=null;try{prev=JSON.parse(fs.readFileSync(identityFile,'utf8'));}catch(_){prev=null;}
        const same=shopProfile.assertSameShopIdentity({shop:business.shop,accountId:prev&&prev.accountId},{shop:business.shop,accountId:liveCheck.accountId});
        if(!same.ok)throw new Error('shop-state-identity-binding-conflict:'+same.reason);
      } else {
        atomicWrite(identityFile,{shop:business.shop,accountId:liveCheck.accountId,verifiedAt:new Date().toISOString()});
      }
    }
    const tab=await opened.target.evaluate(clickChengfangSubTab('商品自选'));
    if(!tab||tab.clicked!==true)throw new Error('management-product-self-tab-not-observed');
    const context=opened.context;
    // Restore this account's completed guidance flags before any new creation
    // document's app scripts run; a missing/invalid private file never injects.
    // The SAME scope feeds the driver's flag SAVE below, so a generic shop writes
    // to (and later restores from) ITS OWN account-scoped guidance dir; the legacy
    // default keeps the historical LOCALAPPDATA location for both ends.
    const guidanceScope=guidanceScopeFor(paths);
    const guidanceRestore=await installGuidanceRestore(context,business.accountId,guidanceScope.restoreOptions);
    console.log(JSON.stringify({op:'guidance-restore-init',registered:guidanceRestore.registered===true,count:guidanceRestore.count||0,reason:guidanceRestore.reason||null}));
    const runId='plan-publisher-'+date+'-'+crypto.randomBytes(8).toString('hex');
    const history=wf.loadPublishedStore(PUBLISHED_FILE,paths.seedFile,business.accountId);
    const publishedIds=new Set(history.publishedIds.map(String));
    const consumedToday=Object.values(attempts.consumed||{}).filter(r=>r.businessDate===date&&r.status==='success');
    // S17：本日份数必须把**已证明的手动原生 UI 发布事实**一并算入（否则会把已真实发布的
    // 第 1 份当未发布、从 1 重新准备）。无手动事实时与 consumedToday.length+1 逐字一致。
    // CLI 每日份数上限：采用本店有效 maxPlansPerDay（合法整数 1..10，缺省回落 3），
    // 与调度器/publisher/workflow 同一"合法配置可覆盖 Frozen 默认"口径，绝不无条件放宽到 >10。
    const cliMaxPlans = (Number.isInteger(business.maxPlansPerDay) && business.maxPlansPerDay >= 1 && business.maxPlansPerDay <= 10)
      ? business.maxPlansPerDay : 3;
    let planNumber=Math.min(cliMaxPlans+1,nextPlanNumberForDay(state,attempts,date,business.accountId,(published.plans||[])));
    if(planNumber>cliMaxPlans){console.log(JSON.stringify({op:'stopped',reason:'daily-plan-limit-reached'}));return;}
    let dayState={...state,runId,businessDate:date,active:null,lastSelected:[],plans:[...(state.plans||[])]};
    const persist=next=>{Object.assign(dayState,next);wf.persistDayState(STATE_FILE,dayState);};
    const managerPage=opened.target;
    let attemptsNow=guard.loadAttemptsStore(ATTEMPTS_FILE);
    const confirmationConsumed=new Set(Object.entries(attemptsNow.consumed||{}).filter(([,r])=>r.status!=='failed').map(([id])=>id));
    const confirmationErrors=new Map();
    ui=createConfirmationServer({host:'127.0.0.1',port:0,consumed:confirmationConsumed,reserveConfirmation:async(auth,frozen)=>{
      const latest=wf.loadDayState(STATE_FILE,date);
      if(!latest.active||latest.active.frozen.manifestHash!==frozen.manifestHash)throw new Error('confirmation-plan-state-drift');
      latest.confirmationConsumptions=[...(latest.confirmationConsumptions||[]),{confirmationId:frozen.confirmationId,manifestHash:frozen.manifestHash,planNumber:frozen.planNumber,at:new Date().toISOString()}];
      latest.active={...latest.active,status:'confirmation-consumed'};wf.persistDayState(STATE_FILE,latest);dayState=latest;
    },onError:async(error,frozen)=>{
      const reason='confirmation-handler-error:'+(error&&error.message||'unknown');
      confirmationErrors.set(frozen.confirmationId,reason);
      try { const latest=wf.loadDayState(STATE_FILE,date);latest.active={...(latest.active||{}),status:'publish-unknown',planNumber:frozen.planNumber,frozen,reason};wf.persistDayState(STATE_FILE,latest);dayState=latest; } catch (_) {}
    }});
    const address=await ui.start();
    console.log(JSON.stringify({op:'confirmation-ui',url:`http://127.0.0.1:${address.port}/`,host:'127.0.0.1',stable:true}));
    while(planNumber<=cliMaxPlans) {
      if(wf.shanghaiDate(Date.now())!==date){console.log(JSON.stringify({op:'stopped',reason:'business-date-changed-restart-required'}));break;}
      const activeState=wf.loadDayState(STATE_FILE,date);
      if(wf.hasUnresolvedPlan(activeState))throw new Error('day-state-pending-or-unknown-read-only-recovery-required');
      dayState={...activeState,runId,businessDate:date,active:null,lastSelected:[]};
      const attemptedSet=new Set(dayState.attempted||[]);const hints={...(dayState.hints||{})};
      const drivers=createRealDrivers({page:null,managerPage,context,dayState,persist,publishedIds,attemptedSet,hints,accountId:business.accountId,business,boundAccounts:business.boundAccounts||null,productsPerPlan:business.productsPerPlan,creationUrl:business.creationUrl,managementUrl:shopProfile.managementUrlFor(business),legacyBusiness:legacyDefault,guidancePrivateDir:guidanceScope.privateDir,opened,projectRoot:root,planNumber,runId,readAccountInPage:readChengfangAccountInPage,clickSubTab:clickChengfangSubTab,readShopRowsInPage:collectChengfangRowsInPage,readShopPaginationInPage:collectChengfangPaginationInPage,goFirstShopPageInPage:clickChengfangFirstPageInPage,goNextShopPageInPage:clickChengfangNextPageInPage});
      // The manager page/context and drivers are held for the complete run. Each
      // preparation creates its own fresh creation page and never carries an old
      // selected list or confirmation into the next plan.
      const prep=await wf.preparePlan({
        planNumber,runId,businessDate:date,dayState,business,publishedIds:[...publishedIds],publishedSet:publishedIds,
        requireRealDrivers:true,openCreationPage:drivers.openCreationPage,browseProducts:drivers.browseProducts,
        bindAccountsToAll:drivers.bindAccountsToAll,readMainTable:drivers.readMainTable,repairDraft:drivers.repairDraft,
        configurePlan:drivers.configurePlan,persistState:persist,hints,nowMs:Date.now(),
      });
      if(prep.status!=='ready-awaiting-confirmation') {
        preserveOwnedBrowser=true;
        dayState.active={status:'preparing',reason:prep.reason,planNumber};persist(dayState);
        console.log(JSON.stringify({op:'stopped',stage:prep.stage,reason:prep.reason,planNumber}));break;
      }
      const frozen=prep.frozen;
      // Adopt the RESOLVED profile for freeze/confirmation/publish. A generic shop that
      // started with null targets discovers them during preparation; main must NOT keep
      // the initial null-target profile (which would skip the frozen-target identity
      // check at confirmation). Prefer the driver's own resolved set, fall back to the
      // frozen manifest's set; the legacy default profile is unchanged (already equal).
      const driverResolved=drivers.resolvedBoundAccounts;
      const resolvedBound=(driverResolved&&driverResolved.length)?driverResolved:(frozen.boundAccounts||null);
      if(resolvedBound&&resolvedBound.length&&String((business.boundAccounts||[]).join(','))!==String(resolvedBound.join(','))){
        business=shopProfile.buildShopProfile({...business,boundAccounts:resolvedBound});
      }
      dayState.active={status:'ready-awaiting-confirmation',frozen,planNumber};dayState.lastSelected=frozen.productIds.slice();dayState.hints=hints;persist(dayState);
      const existingPlanIds=await drivers.readExistingPlanIds();
      let publishCallbackFinished=false;
      // Hand the UI the SAME resolved trusted profile used for publish, so the
      // confirmation page shows this shop and the confirm gate authorizes against
      // it (never the frozen artifact or the HTTP form). `business` here is the
      // profile adopted above after driver target discovery; the legacy default is
      // unchanged (already equal to BUSINESS).
      ui.setPlan(frozen,async(_authorization,_planAtStart,body)=>{
        let result;
        try {
          const request={...body,method:'POST',planNumber:Number(body.planNumber),acceptedDisclosures:body.acceptedDisclosures===true||body.acceptedDisclosures==='true'};
          result=await wf.publishConfirmedPlan(frozen,request,{
            nowMs:()=>Date.now(),observe:drivers.observe,runPublishPlan:guard.runPublishPlan,business,
            publishDeps:{attemptsFile:ATTEMPTS_FILE,evaluate:drivers.evaluate,onEvent:()=>{},
              contract:{boundAccounts:frozen.boundAccounts,productsPerPlan:business.productsPerPlan,roi:business.roi,dailyBudget:business.dailyBudget,maxPlansPerDay:business.maxPlansPerDay,isLegacy:legacyDefault}},
            approvedFirstPlan:planNumber===1?null:dayState.firstPublishedPlan,
            readFinalDialog:drivers.readFinalDialog,awaitFinalDialog:drivers.awaitFinalDialog,consumeFinalConfirmation:(_f,_a)=>reserveFinalAndRecord(ATTEMPTS_FILE,frozen),
            recordFinalConfirmationOutcome:(_f,status)=>guard.recordFinalConfirmationOutcome(ATTEMPTS_FILE,frozen.confirmationId,status),
            clickFinalConfirm:drivers.clickFinalConfirm,readManagementRow:drivers.readManagementRow,existingPlanIds,
          });
        } catch(error) { result={status:'unknown',reason:'confirmed-flow-exception:'+(error&&error.message||'unknown')}; }
        let outcome=result.status==='success'?'success':result.status==='failed'?'failed':'unknown';
        const cookie=await drivers.saveCookies().catch(error=>({status:'failed',reason:error.message}));
        try {
          const updated=wf.loadDayState(STATE_FILE,date);
          updated.active={status:outcome==='success'?'publish-finalizing':'publish-unknown',planNumber,frozen,reason:result.reason||null,planId:result.planId||null};
          wf.persistDayState(STATE_FILE,updated);dayState=updated;
          if(outcome==='success') {
            const newStore=wf.appendPublished(wf.loadPublishedStore(PUBLISHED_FILE,paths.seedFile,business.accountId),{productIds:frozen.productIds,planId:result.planId,date});
            wf.persistPublished(PUBLISHED_FILE,newStore);publishedIds.clear();for(const id of newStore.publishedIds)publishedIds.add(String(id));
            updated.plans=[...(updated.plans||[]),{planNumber,status:'success',planId:String(result.planId),manifestHash:frozen.manifestHash}];
            if(planNumber===1)updated.firstPublishedPlan={planNumber:1,status:'success',planId:String(result.planId),account_id:business.accountId,product_ids:frozen.productIds.slice(),planName:frozen.planName,manifestHash:frozen.manifestHash,businessDate:date,runId};
          }
          if(result.finalClick&&result.finalClick.clicked===true) {
            const finalStatus=guard.recordFinalConfirmationOutcome(ATTEMPTS_FILE,frozen.confirmationId,outcome==='success'?'success':'unknown');
            if(finalStatus!==true){outcome='unknown';result={...result,status:'unknown',reason:'final-confirm-outcome-not-durable'};}
          }
          const initialStatus=guard.recordPublicationOutcome(ATTEMPTS_FILE,frozen.confirmationId,outcome);
          if(initialStatus!==true){outcome='unknown';result={...result,status:'unknown',reason:'publication-outcome-not-durable'};}
          updated.active={status:outcome==='success'?'post-publish-enable-check-pending':'publish-unknown',planNumber,frozen,reason:result.reason||null,planId:result.planId||null,cookieStatus:cookie.status};
          if(outcome==='success'){updated.lastSelected=[];updated.runId=runId;updated.businessDate=date;}
          wf.persistDayState(STATE_FILE,updated);dayState=updated;
        } catch(error) {
          outcome='unknown';result={...result,status:'unknown',reason:'publication-state-persist-failed:'+(error&&error.message||'unknown')};
          try {
            guard.recordFinalConfirmationOutcome(ATTEMPTS_FILE,frozen.confirmationId,'unknown');
            guard.recordPublicationOutcome(ATTEMPTS_FILE,frozen.confirmationId,'unknown');
            const latest=wf.loadDayState(STATE_FILE,date);latest.active={status:'publish-unknown',planNumber,frozen,reason:result.reason};wf.persistDayState(STATE_FILE,latest);dayState=latest;
          } catch(persistError) { confirmationErrors.set(frozen.confirmationId,result.reason+':state-recovery-persist-failed'); }
        }
        console.log(JSON.stringify({op:'cookie-writeback',planNumber,status:cookie.status,reason:cookie.reason||null,count:cookie.count||null,domains:cookie.domains||null}));
        if(outcome==='success') {
          const current=await drivers.readCurrentShopEnableState();
          postPublishEnableObservation=wf.planPostPublishEnable(current,{});
          console.log(JSON.stringify({op:'post-publish-enable-readback',accountId:current.accountId||null,readOk:current.readOk===true,enabled:typeof current.enabled==='boolean'?current.enabled:null,rowCount:current.rowCount||null,status:postPublishEnableObservation.status,reason:current.reason||postPublishEnableObservation.gap||null,actionTaken:false}));
          if(postPublishEnableObservation.action==='stop') {
            const latest=wf.loadDayState(STATE_FILE,date);
            latest.active={...(latest.active||{}),status:'post-publish-enable-stopped',postPublishEnable:{status:postPublishEnableObservation.status,reason:current.reason||postPublishEnableObservation.gap||null}};
            wf.persistDayState(STATE_FILE,latest);dayState=latest;preserveOwnedBrowser=true;
          } else if(postPublishEnableObservation.status==='already-enabled') {
            const latest=wf.loadDayState(STATE_FILE,date);
            latest.active={...(latest.active||{}),status:'published-success',postPublishEnable:{status:postPublishEnableObservation.status}};
            wf.persistDayState(STATE_FILE,latest);dayState=latest;
          } else {
            const latest=wf.loadDayState(STATE_FILE,date);
            latest.active={...(latest.active||{}),status:'post-publish-enable-stopped',postPublishEnable:{status:postPublishEnableObservation.status,reason:'no-verified-normal-enable-hook'}};
            wf.persistDayState(STATE_FILE,latest);dayState=latest;preserveOwnedBrowser=true;
          }
        }
        console.log(JSON.stringify({op:'publish-result',planNumber,status:result.status,planId:result.planId||null,reason:result.reason||null}));
        publishCallbackFinished=true;
        return result;
      },{business});
      await new Promise(resolve=>{const timer=setInterval(()=>{let s;try{s=wf.loadDayState(STATE_FILE,date);}catch(_){if(confirmationErrors.has(frozen.confirmationId)){clearInterval(timer);resolve();}return;}if(confirmationErrors.has(frozen.confirmationId)||publishCallbackFinished&&(!s.active||['published-success','publish-unknown','post-publish-enable-stopped','preparation-stopped'].includes(s.active.status))){clearInterval(timer);resolve();}},500);});
      const after=wf.loadDayState(STATE_FILE,date);
      if(confirmationErrors.has(frozen.confirmationId)){console.log(JSON.stringify({op:'stopped',reason:'confirmation-handler-error-read-only-recovery-required'}));break;}
      if(after.active&&after.active.status==='published-success') {
        if(postPublishEnableObservation&&postPublishEnableObservation.status==='already-enabled') { planNumber++;continue; }
        preserveOwnedBrowser=true;console.log(JSON.stringify({op:'stopped',reason:'post-publish-current-shop-state-not-safely-enabled'}));break;
      }
      if(after.active&&['publish-unknown','post-publish-enable-stopped','preparation-stopped','confirmation-consumed','publish-finalizing'].includes(after.active.status))preserveOwnedBrowser=true;
      break;
    }
    const cookie=await createRealDrivers({page:managerPage,managerPage,context,dayState,persist,publishedIds,attemptedSet:new Set(dayState.attempted||[]),hints:dayState.hints||{},accountId:business.accountId,boundAccounts:business.boundAccounts||null,productsPerPlan:business.productsPerPlan,creationUrl:business.creationUrl,managementUrl:shopProfile.managementUrlFor(business),legacyBusiness:legacyDefault,guidancePrivateDir:guidanceScope.privateDir,opened,projectRoot:root,planNumber,runId,readAccountInPage:readChengfangAccountInPage,clickSubTab:clickChengfangSubTab}).saveCookies().catch(e=>({status:'failed',reason:e.message}));
    console.log(JSON.stringify({op:'cookie-writeback',status:cookie.status,reason:cookie.reason||null,count:cookie.count||null,domains:cookie.domains||null}));
    if(!postPublishEnableObservation)console.log(JSON.stringify({op:'post-publish-enable-readback',status:'not-applicable-no-new-publish',actionTaken:false}));
  } catch(error) {
    if(opened)preserveOwnedBrowser=true;
    console.log(JSON.stringify({op:'stopped',reason:String(error&&error.message||error)}));
  } finally {
    if(ui) await ui.stop().catch(()=>{});
    if(opened&&opened.browser&&!preserveOwnedBrowser) { const {closeBrowser}=require(path.join(guard.resolveProjectRoot(process.env),'src/adapters/chengfang-reader')); await closeBrowser(opened.browser).catch(()=>{}); }
    if(releaseLock)releaseLock();
  }
}

// ── R42 explicit-failure, one-shot replacement retry helper ──────────────────
// The ONLY real entry that may re-drive a previously-failed same-day second plan
// after the platform explicitly refused it (e.g. "发布失败 … 商品已下架"). It does
// NOT re-implement any browser business: it (1) leaves the trusted durable
// explicit-platform-failure trace on the ORIGINAL frozen via the guard, then
// (2) delegates to the UNCHANGED wf.publishConfirmedPlan with a thin wrapper that
// injects the retryOfConfirmationId into the guard command. The retry entitlement
// is never fabricated here: it is proven from the ledger inside
// guard.consumePublicationOnce, and every other precondition (new CID/hash, same
// run/date/account/planNumber/planName, exact 29 retained + 1 replaced, no other
// in-flight unknown) is enforced there before any click. A single helper call can
// therefore open at most ONE new retry; the original record is bound forever.
async function publishExplicitFailureReplacementOnly(deps) {
  const d = deps || {};
  const required = ['attemptsFile', 'oldFrozen', 'newFrozen', 'trustedFailureProof', 'humanRequest', 'observe'];
  const missing = required.filter(k => d[k] == null);
  if (missing.length) throw new Error('explicit-failure-replacement dependency missing: ' + missing.join(','));
  // 1. Trusted, durable evidence of the ORIGINAL explicit platform refusal.
  const failureRecord = guard.recordExplicitPlatformFailure(d.attemptsFile, d.oldFrozen, d.trustedFailureProof);
  const retryOfConfirmationId = String(d.oldFrozen.confirmationId);
  // 2. Carry the retry authorization through the unchanged human-gated flow.
  const retryRunner = (cmd, runDeps) => guard.runPublishPlan(
    { ...cmd, authorization: { ...(cmd && cmd.authorization), retryOfConfirmationId } },
    runDeps,
  );
  const result = await wf.publishConfirmedPlan(d.newFrozen, d.humanRequest, {
    ...d,
    runPublishPlan: retryRunner,
    approvedFirstPlan: d.approvedFirstPlan,
  });
  return {
    status: (result && result.status) || 'unknown',
    planId: (result && result.planId) || null,
    reason: (result && result.reason) || null,
    retryOfConfirmationId,
    failedProductId: failureRecord && failureRecord.explicitPlatformFailure
      ? failureRecord.explicitPlatformFailure.failingProductId : null,
  };
}

// ── S4 每日排程真实发布入口（客户 2026-10-11）────────────────────────────────
// main() 之外的唯一"递归/排程"真实入口，与 main 完全同源：复用现有 production
// openShop 实时身份发现（配置 accountId=null 也不预先 blocked、不要求人工填号、
// 绝不借其它店身份、绝不硬编码）、账号绑定/填写/prepare 冻结（真实 nonce +
// manifestHash）、guard.runPublishPlan 的发布前一次性初始消费、已知最终弹窗的
// 一次性消费与有界 await、管理页**新 planId** readback，以及同一耐久落盘顺序。
// 自动发布只由**已持久化的显式 policy（enabled && autoConfirm）**加调用参数共同决定，
// 默认一律人工；授权来源如实记 authorizedBy='recurring-user-policy'，绝不伪造
// humanApproved。单次调用只发布指定业务日的下一份计划（账本推导），绝不准备第 4 份；
// 任何未决/未知只读停止、不重放；跨日旧 manifest 停止；关闭自有浏览器前保存 Cookie。
function scheduledErrorText(error) {
  return String((error && (error.reason || error.message)) || error || 'unknown');
}

// R41 scope(1): a PROVEN-successful publication whose post-publish ENABLE step stopped
// (active=post-publish-enable-stopped) is the one stale state a trusted readback may close
// without human replay. This classifier is pure and deliberately over-strict: every field
// must agree across day-state, attempts ledger and the frozen manifest, the manifest hash
// must recompute, and zero manual-unresolved records may exist. Anything weaker (pending /
// unknown / final-markers not success / hash mismatch / planId absent) returns not-closable
// and callers keep the ORIGINAL read-only-recovery block untouched. Date policy (cross-day
// vs same-day) is the caller's decision, not this function's.
function classifyProvenEnableStoppedState(stateRaw, attempts, business) {
  const st = stateRaw || {};
  const att = attempts || {};
  const a = st.active || {};
  if (a.status !== 'post-publish-enable-stopped') return { closable: false, reason: 'not-enable-stopped' };
  if (listManualUnresolved(att).length > 0) return { closable: false, reason: 'manual-unresolved-present' };
  const frozen = a.frozen || {};
  if (!frozen.confirmationId || !frozen.manifestHash || !frozen.planName || !frozen.accountId || !frozen.runId) {
    return { closable: false, reason: 'frozen-identity-incomplete' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(frozen.businessDate || ''))) return { closable: false, reason: 'frozen-date-missing' };
  if (String(st.businessDate || '') !== String(frozen.businessDate)) return { closable: false, reason: 'state-date-mismatch' };
  let recomputed = null;
  try { recomputed = typeof wf.manifestHash === 'function' ? wf.manifestHash(frozen) : null; } catch (_) { recomputed = null; }
  if (!recomputed || recomputed !== String(frozen.manifestHash)) return { closable: false, reason: 'frozen-manifest-hash-mismatch' };
  if (!business || business.accountId == null || String(business.accountId) !== String(frozen.accountId)) {
    return { closable: false, reason: 'account-not-current-live-identity' };
  }
  const cid = String(frozen.confirmationId);
  const rec = (att.consumed || {})[cid];
  if (!rec || rec.status !== 'success') return { closable: false, reason: 'publication-consumption-not-proven-success' };
  // 与本机正式记录实际形态对齐：必要身份（runId/businessDate/planNumber/manifestHash）
  // 必须存在且严格一致；accountId/planName 由重算一致的冻结 hash、当前同店 live 身份、
  // 同份成功 day/store 与唯一管理行回读绑定，正式消费记录常不携带这两个字段——携带时
  // 绝不接受不匹配，缺失时不虚构比对（其余门槛一律不放宽）。
  const identityAgree = typeof rec.runId === 'string' && rec.runId === String(frozen.runId || '')
    && typeof rec.businessDate === 'string' && rec.businessDate === String(frozen.businessDate)
    && Number(rec.planNumber) === Number(frozen.planNumber)
    && typeof rec.manifestHash === 'string' && rec.manifestHash === String(frozen.manifestHash)
    && (rec.accountId == null || String(rec.accountId) === String(frozen.accountId))
    && (rec.planName == null || String(rec.planName) === String(frozen.planName));
  if (!identityAgree) return { closable: false, reason: 'consumption-identity-mismatch' };
  const fin = (att.finalConsumed || {})[cid];
  if (fin !== undefined && (!fin || fin.status !== 'success')) return { closable: false, reason: 'final-consumption-not-success' };
  const reopen = (att.reopenConsumed || {})[cid];
  if (reopen !== undefined) return { closable: false, reason: 'reopen-record-present' };
  const planId = String(a.planId || frozen.planId || '');
  if (!/^\d{12,20}$/.test(planId)) return { closable: false, reason: 'plan-id-not-proven' };
  const plansEntry = (Array.isArray(st.plans) ? st.plans : []).find(p => p && Number(p.planNumber) === Number(frozen.planNumber));
  if (!plansEntry || plansEntry.status !== 'success' || String(plansEntry.planId) !== planId
    || String(plansEntry.manifestHash || '') !== String(frozen.manifestHash)) {
    return { closable: false, reason: 'day-plan-success-not-proven' };
  }
  return {
    closable: true,
    planNumber: Number(frozen.planNumber),
    planId,
    confirmationId: cid,
    planName: String(frozen.planName),
    manifestHash: String(frozen.manifestHash),
    closedBusinessDate: String(frozen.businessDate),
    stopReason: a.reason || null,
  };
}

// Durable, race-safe close of a proven enable-stopped state: re-reads the file, requires the
// exact same active confirmationId/planId as the classification snapshot, appends a permanent
// fact (history preserved — the original enable-failure reason is recorded verbatim), then
// clears `active`. Returns closed:false WITHOUT writing if anything changed meanwhile.
function applyProvenEnableStoppedClose(stateFile, closable, opts) {
  const o = opts || {};
  const nowIso = new Date(typeof o.nowMs === 'function' ? o.nowMs() : Date.now()).toISOString();
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) { return { closed: false, reason: 'state-unreadable-at-close' }; }
  const a = (raw && raw.active) || {};
  if (a.status !== 'post-publish-enable-stopped') return { closed: false, reason: 'state-changed-before-close' };
  const f = a.frozen || {};
  if (String(f.confirmationId || '') !== String(closable.confirmationId)) return { closed: false, reason: 'state-confirmation-changed-before-close' };
  if (String(a.planId || f.planId || '') !== String(closable.planId)) return { closed: false, reason: 'state-plan-id-changed-before-close' };
  raw.provenPublishEnableFacts = Array.isArray(raw.provenPublishEnableFacts) ? raw.provenPublishEnableFacts.slice() : [];
  const fact = {
    businessDate: closable.closedBusinessDate, planNumber: closable.planNumber, planId: closable.planId,
    confirmationId: closable.confirmationId, manifestHash: closable.manifestHash,
    enableStopReason: a.reason || closable.stopReason || null, status: 'post-publish-enable-stopped',
    closedAt: nowIso, closedBy: 'proven-publication-readback',
  };
  raw.provenPublishEnableFacts.push(fact);
  raw.active = null;
  try { atomicWrite(stateFile, raw); } catch (_) { return { closed: false, reason: 'state-write-failed-at-close' }; }
  return { closed: true, fact };
}

// Readback drivers for recovery/close: the SAME createRealDrivers production path, only with
// a no-op persist and empty in-memory sets (read-only; durable writes happen via their own
// atomic writers). o.successManagementReadTimeoutMs is passed through for offline tests only.
function recoveryReadbackDrivers(o, opened, business, adapterRoot, readAccountFn, clickSubTabFn, readers, legacyDefault, stateRaw) {
  return createRealDrivers({
    page: opened.target, managerPage: opened.target, context: opened.context,
    dayState: stateRaw || {}, persist: () => {}, publishedIds: new Set(), attemptedSet: new Set(), hints: {},
    accountId: business.accountId, business, boundAccounts: business.boundAccounts || null,
    productsPerPlan: business.productsPerPlan, creationUrl: business.creationUrl,
    managementUrl: shopProfile.managementUrlFor(business), legacyBusiness: legacyDefault === true,
    opened, projectRoot: adapterRoot, planNumber: 1, runId: 'readback-recovery',
    readAccountInPage: readAccountFn, clickSubTab: clickSubTabFn,
    readShopRowsInPage: readers.collectChengfangRowsInPage, readShopPaginationInPage: readers.collectChengfangPaginationInPage,
    goFirstShopPageInPage: readers.clickChengfangFirstPageInPage, goNextShopPageInPage: readers.clickChengfangNextPageInPage,
    successManagementReadTimeoutMs: Number.isInteger(o.successManagementReadTimeoutMs) && o.successManagementReadTimeoutMs > 0 ? o.successManagementReadTimeoutMs : undefined,
  });
}

async function runScheduledPlan(businessInput, opts) {
  const o = opts || {};
  const nowOf = () => (typeof o.nowMs === 'function' ? o.nowMs() : (Number.isFinite(o.nowMs) ? o.nowMs : Date.now()));
  const log = typeof o.onLog === 'function' ? o.onLog : () => {};
  const AUTHORIZED_BY = 'recurring-user-policy';
  const result = (status, reason, extra) => ({
    status, reason: reason || null, planId: null, authorizedBy: AUTHORIZED_BY, humanApproved: false,
    recurringPolicyAuthorized: policyApproved(), ...(extra || {}),
  });
  // policyProvider（新鲜读取）优先于入口快照：排程侧传入的是"当前已生效配置"，
  // 入口检查也必须是那一份，不能拿调用方冻结的旧快照授权。
  const policy = typeof o.policyProvider === 'function'
    ? (() => { try { return o.policyProvider(); } catch (_) { return null; } })()
    : (o.policy !== undefined && o.policy !== null ? o.policy : null);
  function policyApproved() {
    return o.autoConfirm === true && !!policy && policy.enabled === true && policy.autoConfirm === true;
  }
  if (!policyApproved()) return result('blocked', 'auto-publish-not-authorized', { noAction: true });
  const businessDate = String(o.businessDate || wf.shanghaiDate(nowOf()));
  if (businessDate !== wf.shanghaiDate(nowOf())) return result('blocked', 'scheduled-business-date-changed', { noAction: true });

  const adapterRoot = o.projectRoot || guard.resolveProjectRoot(process.env);
  const loadConfigFn = typeof o.loadConfig === 'function' ? o.loadConfig : () => require(path.join(adapterRoot, 'src/config')).loadConfig();
  let cfg;
  try { cfg = loadConfigFn(); } catch (error) { return result('failed', 'scheduled-config-load-failed:' + scheduledErrorText(error), { noAction: true }); }
  if (!cfg || cfg.ready !== true || !cfg.config || !Array.isArray(cfg.config.shops)) return result('blocked', 'project-config-not-ready', { noAction: true });

  const inputShop = String((businessInput && (businessInput.shop || businessInput.name)) || '').trim();
  if (!inputShop) return result('failed', 'scheduled-shop-missing', { noAction: true });
  const inputAccount = businessInput && businessInput.accountId != null && String(businessInput.accountId) !== '' ? String(businessInput.accountId) : null;
  let shopCfg;
  try { shopCfg = shopProfile.selectNamedShopConfig(cfg.config, inputShop, { accountId: inputAccount }); }
  catch (error) { return result('failed', 'scheduled-shop-selection-failed:' + scheduledErrorText(error), { noAction: true }); }

  let business;
  try {
    business = shopProfile.buildShopProfile({
      shop: inputShop,
      accountId: inputAccount != null ? inputAccount : (shopCfg.accountId != null && String(shopCfg.accountId) !== '' ? String(shopCfg.accountId) : null),
      boundAccounts: (businessInput && businessInput.boundAccounts && businessInput.boundAccounts.length) ? businessInput.boundAccounts : (shopCfg.boundAccounts || null),
      productsPerPlan: businessInput && businessInput.productsPerPlan,
      roi: o.roi != null ? o.roi : (businessInput && businessInput.roi),
      dailyBudget: o.dailyBudget != null ? o.dailyBudget : (businessInput && businessInput.dailyBudget),
      commissionIncluded: businessInput && businessInput.commissionIncluded,
      directPay: businessInput && businessInput.directPay,
      maxPlansPerDay: businessInput && businessInput.maxPlansPerDay,
      creationPath: (businessInput && businessInput.creationPath) || shopCfg.creationPath || wf.BUSINESS.creationPath,
    });
  } catch (error) { return result('failed', 'scheduled-profile-invalid:' + scheduledErrorText(error), { noAction: true }); }

  const legacyProfile = shopProfile.profileFromBusiness(wf.BUSINESS);
  const stateRoot = o.stateRoot || ROOT;
  // 每日本份上限：采用调度器带来的**本店有效**plansPerShopPerDay（合法整数 1..10，缺省回落 3）。
  // 默认无配置覆盖仍为 3（第 4 份一律拒绝），合法配置可放到 1..10；绝不无条件放宽 Frozen 上界。
  const maxPlans = (Number.isInteger(o.plansPerShopPerDay) && o.plansPerShopPerDay >= 1 && o.plansPerShopPerDay <= 10)
    ? o.plansPerShopPerDay : 3;
  // 新鲜授权核查（客户 2026-10-11）：入口查一次**不够**——prepare 可能耗时数分钟，期间用户
  // 可能停用、改 ROI/预算或删店。初始消费/点击前与最终消费/点击前各核一次，只信**当前**
  // policyProvider / currentShopProvider 给出的当前配置，不信入口冻结快照。漂移后一律零未来
  // 点击、绝不消费新确认；初始已点击后才发现漂移只能保持 unknown（绝不重点初始）。
  function freshPolicy() {
    if (typeof o.policyProvider === 'function') { try { return o.policyProvider(); } catch (_) { return null; } }
    return policy;
  }
  function freshShopConfig() {
    if (typeof o.currentShopProvider !== 'function') return null;
    try { const s = o.currentShopProvider(); return s ? s : { missing: true }; } catch (_) { return { unreadable: true }; }
  }
  function policyDriftReason() {
    if (o.autoConfirm !== true) return 'auto-confirm-not-authorized';
    const p = freshPolicy();
    if (!p || p.enabled !== true || p.autoConfirm !== true) return 'policy-disabled-or-not-autoconfirmed';
    if (wf.shanghaiDate(nowOf()) !== businessDate) return 'business-date-changed';
    const shop = freshShopConfig();
    if (shop && shop.unreadable === true) return 'current-config-unreadable';
    // 当前配置里已找不到本店（等效于删除/改名脱离配置）：一律 fail-closed，零未来点击。
    if (shop && shop.missing === true) return 'shop-missing-from-current-config';
    // 每店每日份数漂移：以**当前**店铺配置 plansPerShopPerDay（合法整数 1..10）优先，
    // 否则回落全局 policy.plansPerShopPerDay（1..3），再否则默认 3。派发所带份数必须与
    // 该"当前有效上限"逐字一致；页面把数量改小（如 6→3）即刻视为漂移，停止后续点击。
    if (Number.isInteger(o.plansPerShopPerDay)) {
      let currentLimit = Number.isInteger(p.plansPerShopPerDay) ? p.plansPerShopPerDay : 3;
      if (shop && Object.prototype.hasOwnProperty.call(shop, 'plansPerShopPerDay')) {
        const n = shop.plansPerShopPerDay;
        if (typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= 10) currentLimit = n;
      }
      if (Number(o.plansPerShopPerDay) !== currentLimit) return 'policy-plans-drift';
    }
    if (p.dailyBudget != null && Number(p.dailyBudget) !== Number(o.dailyBudget)) return 'policy-budget-drift';
    if (shop) {
      if (shop.deleted === true) return 'shop-deleted';
      if (shop.accountId != null && String(shop.accountId) !== '' && String(shop.accountId) !== String(business.accountId)) return 'shop-account-drift';
      if (shop.targetRoi != null && String(shop.targetRoi) !== String(business.roi)) return 'shop-roi-drift';
    }
    return null;
  }
  // 与 main 一致：默认店的 runtime scope 事先已知，保持"先锁后开"的原顺序；
  // 账号未知（null）的店必须先用同一店 Cookie 证明身份，才派生按账户隔离的路径与锁。
  let legacyDefault = shopProfile.isLegacyDefaultProfile(business, legacyProfile);
  let paths = null, releaseLock = null, opened = null, readers = null, drivers = null;
  let preserveOwnedBrowser = false, cookiesSaved = false;
  // runId is generated BEFORE navigation so a pre-open failure can bind its zero-publication proof
  // to the exact run invocation (reuses the existing scheme, moved earlier — not a new one).
  const runId = 'plan-scheduler-' + businessDate + '-' + crypto.randomBytes(8).toString('hex');
  try {
    if (legacyDefault) { paths = scheduledStatePaths(business, true, stateRoot); releaseLock = acquireLock(paths.lockFile); }
    readers = o.readers || require(path.join(adapterRoot, 'src/adapters/chengfang-reader'));
    const openShopFn = typeof o.openShop === 'function' ? o.openShop : readers.openChengfangShop;
    const readAccountFn = typeof o.readAccountInPage === 'function' ? o.readAccountInPage : readers.readChengfangAccountInPage;
    const clickSubTabFn = typeof o.clickSubTab === 'function' ? o.clickSubTab : readers.clickChengfangSubTab;
    if (typeof openShopFn !== 'function' || typeof readAccountFn !== 'function') return result('failed', 'scheduled-reader-capability-missing', { noAction: true });
    opened = await openShopFn({ loginCfg: cfg.config.login, shopCfg: navigationShopCfg(shopCfg, business.accountId), headless: o.headless === true });
    if (!opened || !opened.target || !opened.context) { preserveOwnedBrowser = true; return result('failed', 'scheduled-shop-open-incomplete', { noAction: true }); }
    // 严格当前 Cookie 广告身份验证：配置账号未知即采用实时账号；已知但不符一律拒绝。
    const identity = await opened.target.evaluate(readAccountFn);
    const liveCheck = shopProfile.verifyLiveIdentity(business, String(identity && identity.accountId));
    if (!liveCheck.ok) { preserveOwnedBrowser = true; return result('blocked', 'live-account-identity-unverified:' + liveCheck.reason, { noAction: true }); }
    if (!business.accountId || String(business.accountId) !== liveCheck.accountId) {
      business = shopProfile.buildShopProfile({ ...business, accountId: liveCheck.accountId });
      legacyDefault = shopProfile.isLegacyDefaultProfile(business, legacyProfile);
    }
    if (!paths) { paths = scheduledStatePaths(business, legacyDefault, stateRoot); releaseLock = acquireLock(paths.lockFile); }
    const STATE_FILE = paths.stateFile, PUBLISHED_FILE = paths.publishedFile, ATTEMPTS_FILE = paths.attemptsFile;

    const stateRaw = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : null;
    const attempts = guard.loadAttemptsStore(ATTEMPTS_FILE);
    if (shouldRunReadOnlyRecovery(stateRaw || {}, attempts)) {
      // R41 scope(1): the formal auto entry may ONLY self-close a CROSS-DAY enable-stopped
      // stale state whose publication is proven successful by the durable ledger AND by a
      // live management readback of the exact unique new row. Same-day unresolved states,
      // pending/unknown anything: keep the original read-only-recovery block verbatim
      // (no replay, no weakening; explicit recovery is a separate trusted entry point).
      const closable = classifyProvenEnableStoppedState(stateRaw, attempts, business);
      let closedNow = false;
      if (closable.closable && closable.closedBusinessDate !== businessDate) {
        let rb = null;
        try {
          const rbDrivers = recoveryReadbackDrivers(o, opened, business, adapterRoot, readAccountFn, clickSubTabFn, readers, legacyDefault, stateRaw);
          rb = await rbDrivers.readManagementRow({ planName: closable.planName, accountId: business.accountId });
        } catch (_) { rb = null; }
        if (rb && rb.found === true && rb.uniqueRow === true && String(rb.planId) === String(closable.planId)) {
          const applied = applyProvenEnableStoppedClose(STATE_FILE, closable, { nowMs: nowOf() });
          closedNow = applied.closed === true;
          if (closedNow) log('info', 'scheduled-enable-stopped-closed ' + closable.closedBusinessDate + ' plan' + closable.planNumber + ' ' + closable.planId);
        }
      }
      if (!closedNow) {
        preserveOwnedBrowser = true;
        return result('blocked', 'read-only-recovery-required', { noAction: true, noReplay: true });
      }
    }
    const dayStateInitial = wf.loadDayState(STATE_FILE, businessDate);
    if (wf.hasUnresolvedPlan(dayStateInitial)) {
      preserveOwnedBrowser = true;
      return result('blocked', 'read-only-recovery-required-day-state', { noAction: true, noReplay: true });
    }
    const published = wf.loadPublishedStore(PUBLISHED_FILE, paths.seedFile, business.accountId);
    if (published.seeded) wf.persistPublished(PUBLISHED_FILE, published);
    // 按店状态目录只能属于一个已验证账户（与 main 同一条绑定规则）。
    if (paths.isolated) {
      const identityFile = path.join(paths.dir, 'shop-identity.json');
      if (fs.existsSync(identityFile)) {
        let prev = null; try { prev = JSON.parse(fs.readFileSync(identityFile, 'utf8')); } catch (_) { prev = null; }
        const same = shopProfile.assertSameShopIdentity({ shop: business.shop, accountId: prev && prev.accountId }, { shop: business.shop, accountId: liveCheck.accountId });
        if (!same.ok) { preserveOwnedBrowser = true; return result('blocked', 'shop-state-identity-binding-conflict:' + same.reason, { noAction: true }); }
      } else {
        atomicWrite(identityFile, { shop: business.shop, accountId: liveCheck.accountId, verifiedAt: new Date(nowOf()).toISOString() });
      }
    }
    const tab = await opened.target.evaluate(clickSubTabFn('商品自选'));
    if (!tab || tab.clicked !== true) { preserveOwnedBrowser = true; return result('failed', 'management-product-self-tab-not-observed'); }
    const context = opened.context;
    const guidanceScope = guidanceScopeFor(paths);
    const guidanceRestore = await installGuidanceRestore(context, business.accountId, guidanceScope.restoreOptions);
    log('info', 'scheduled-guidance-restore ' + (guidanceRestore.registered === true) + ' ' + (guidanceRestore.reason || ''));
    const history = wf.loadPublishedStore(PUBLISHED_FILE, paths.seedFile, business.accountId);
    const publishedIds = new Set(history.publishedIds.map(String));
    // 账本推导"本业务日的下一份"：调度器计数只是参考，耐久账本才是唯一权威。
    const consumedToday = Object.values(attempts.consumed || {}).filter(r => r && r.businessDate === businessDate && r.status === 'success');
    // S17：已证明手动原生 UI 发布事实同样占本日份数（防已真实发布的一份被当未发布重发）。
    const planNumber = nextPlanNumberForDay(dayStateInitial, attempts, businessDate, business.accountId, (published.plans || []));
    if (planNumber > maxPlans) {
      return result('blocked', 'daily-plan-limit-reached', { planNumber: null, succeededToday: consumedToday.length, noAction: true });
    }
    let dayState = { ...dayStateInitial, runId, businessDate, active: null, lastSelected: [], plans: [...(dayStateInitial.plans || [])] };
    const persist = next => { Object.assign(dayState, next); wf.persistDayState(STATE_FILE, dayState); };
    const attemptedSet = new Set(dayState.attempted || []);
    const hints = { ...(dayState.hints || {}) };
    const driversFactory = typeof o.driversFactory === 'function' ? o.driversFactory : createRealDrivers;
    drivers = driversFactory({
      page: null, managerPage: opened.target, context, dayState, persist, publishedIds, attemptedSet, hints,
      accountId: business.accountId, business, boundAccounts: business.boundAccounts || null,
      productsPerPlan: business.productsPerPlan, creationUrl: business.creationUrl,
      managementUrl: shopProfile.managementUrlFor(business), legacyBusiness: legacyDefault,
      guidancePrivateDir: guidanceScope.privateDir, opened, projectRoot: adapterRoot, planNumber, runId,
      readAccountInPage: readAccountFn, clickSubTab: clickSubTabFn,
      readShopRowsInPage: readers.collectChengfangRowsInPage, readShopPaginationInPage: readers.collectChengfangPaginationInPage,
      goFirstShopPageInPage: readers.clickChengfangFirstPageInPage, goNextShopPageInPage: readers.clickChengfangNextPageInPage,
      awaitFinalDialogTimeoutMs: Number.isInteger(o.awaitFinalDialogTimeoutMs) ? o.awaitFinalDialogTimeoutMs : undefined,
    });
    const prep = await wf.preparePlan({
      planNumber, runId, businessDate, dayState, business, publishedIds: [...publishedIds], publishedSet: publishedIds,
      requireRealDrivers: true, openCreationPage: drivers.openCreationPage, browseProducts: drivers.browseProducts,
      bindAccountsToAll: drivers.bindAccountsToAll, readMainTable: drivers.readMainTable, repairDraft: drivers.repairDraft,
      configurePlan: drivers.configurePlan, persistState: persist, hints, nowMs: nowOf(),
    });
    if (prep.status !== 'ready-awaiting-confirmation') {
      // prep 以"停止"返回（非 ready）但**不抛异常**：旧代码在此直接 blocked 返回，把当日该份永久
      // 留在 active:preparing，只能靠只读恢复事后收口。这里复用与 scheduled-run-catch **同一**严格
      // 耐久判据 applyProvenPreparationClose：在**持锁**下**新鲜重读**两份文件，只有正面证明本日该份
      // 从未进入任何消费（六 zeros 齐全、无 frozen/CID/手动未决、runId/份号/业务日逐字相符）才收口为
      // preparation-stopped，并带回既有 mapper 要求的 identity/planNumber/runId/businessDate/
      // preparationClosure 形状；原 prep reason 与 stage 逐字保留在结果与耐久事实里。任何证明不严
      // （文件缺失/损坏、有 frozen/CID/消费痕迹、手动未决、plan 记录、身份/日期/phase 不符等）一律
      // 保持原 blocked/noAction 语义与 canonical 状态纹丝不动，绝不伪造证明、绝不改写 attempts、
      // 绝不清状态、绝不允许未知初始/最终消费重试。
      const prepReason = 'prepare-stopped:' + (prep.reason || prep.stage);
      if (paths) {
        let closure = null;
        try {
          closure = applyProvenPreparationClose(paths.stateFile, paths.attemptsFile, businessDate, {
            source: 'scheduled-prepare-stopped', reason: prepReason,
            shop: business && business.shop, accountId: business && business.accountId,
          }, { nowMs: nowOf });
        } catch (_) { closure = null; }
        if (closure && closure.closed === true) {
          // 已证明零消费收口（非未决发布）：与既有 catch 清理一致，允许关闭自有 headless 浏览器，
          // 不保留、不外泄 owned browser；其它失败的资源语义一律不动。
          log('warn', 'scheduled-preparation-closed ' + closure.fact.planNumber + ' ' + closure.fact.runId + ' ' + closure.fact.reason);
          return result('preparation-stopped', prepReason, {
            stage: prep.stage, noAction: true, noReplay: true,
            planNumber: closure.fact.planNumber, businessDate, runId: closure.fact.runId,
            preparationClosure: closure.fact,
          });
        }
      }
      preserveOwnedBrowser = true;
      return result('blocked', prepReason, { stage: prep.stage, noAction: true });
    }
    const frozen = prep.frozen;
    const driverResolved = drivers.resolvedBoundAccounts;
    const resolvedBound = (driverResolved && driverResolved.length) ? driverResolved : (frozen.boundAccounts || null);
    if (resolvedBound && resolvedBound.length && String((business.boundAccounts || []).join(',')) !== String(resolvedBound.join(','))) {
      business = shopProfile.buildShopProfile({ ...business, boundAccounts: resolvedBound });
    }
    dayState.active = { status: 'ready-awaiting-confirmation', frozen, planNumber, authorizedBy: AUTHORIZED_BY };
    dayState.lastSelected = frozen.productIds.slice(); dayState.hints = hints; persist(dayState);
    const existingPlanIds = await drivers.readExistingPlanIds();
    // 派发前 fresh 跨日检查：绝不用今天的身份/manifest 组合配昨天的业务日。
    if (wf.shanghaiDate(nowOf()) !== businessDate || frozen.businessDate !== businessDate) {
      preserveOwnedBrowser = true;
      return result('blocked', 'business-date-changed-before-dispatch', { planNumber, noAction: true, noReplay: true });
    }
    const request = {
      method: 'POST', action: '确认发布本计划', nonce: frozen.nonce, planNumber: Number(frozen.planNumber),
      manifestHash: frozen.manifestHash, businessDate: frozen.businessDate, acceptedDisclosures: true,
      authorizedBy: AUTHORIZED_BY, recurringPolicyConfirmed: true,
    };
    const attemptsNow = guard.loadAttemptsStore(ATTEMPTS_FILE);
    const confirmationConsumed = new Set(Object.entries(attemptsNow.consumed || {}).filter(([, r]) => r && r.status !== 'failed').map(([id]) => id));
    // 初始消费/点击前最后一道新鲜授权：任何漂移都在**任何点击与任何消费之前**停止。
    const driftBeforeInitial = policyDriftReason();
    if (driftBeforeInitial) {
      preserveOwnedBrowser = true;
      // 未发生任何消费/点击，因此这不是"未决发布"：把 ready-awaiting-confirmation 收口为
      // preparation-stopped，用户重新启用后本日仍可继续，不会被只读恢复永久卡住。
      try {
        const latest = wf.loadDayState(STATE_FILE, businessDate);
        latest.active = { status: 'preparation-stopped', planNumber, reason: 'scheduled-policy-drift-before-initial:' + driftBeforeInitial, at: new Date(nowOf()).toISOString() };
        wf.persistDayState(STATE_FILE, latest); dayState = latest;
      } catch (_) { /* 状态写失败不改变"零点击、零消费"的事实 */ }
      return result('blocked', 'scheduled-policy-drift-before-initial:' + driftBeforeInitial, { planNumber, manifestHash: frozen.manifestHash, noAction: true, noReplay: true });
    }
    const innerGate = typeof o.runPublishGate === 'function' ? o.runPublishGate : guard.runPublishPlan;
    let res;
    try {
      res = await wf.publishConfirmedPlan(frozen, request, {
        nowMs: () => nowOf(), observe: drivers.observe,
        // 点击前的即时新鲜核查：门本身不改（仍是原 guard.runPublishPlan / 注入门），
        // 只在**派发那一步**再确认一次授权未漂移；拒绝即抛，由 wf 归为 initial-publish
        // unknown（零点击、绝不重放），绝不假装成功。
        runPublishPlan: async (cmd, gateDeps) => {
          const why = policyDriftReason();
          if (why) throw new Error('scheduled-policy-drift-before-initial-click:' + why);
          return innerGate(cmd, gateDeps);
        },
        business, consumed: confirmationConsumed,
        publishDeps: {
          attemptsFile: ATTEMPTS_FILE, evaluate: drivers.evaluate, onEvent: () => {},
          contract: { boundAccounts: frozen.boundAccounts, productsPerPlan: business.productsPerPlan, roi: business.roi, dailyBudget: business.dailyBudget, maxPlansPerDay: business.maxPlansPerDay, isLegacy: legacyDefault },
        },
        approvedFirstPlan: planNumber === 1 ? null : dayState.firstPublishedPlan,
        readFinalDialog: drivers.readFinalDialog, awaitFinalDialog: drivers.awaitFinalDialog,
        // 最终消费/点击前同样新鲜核查：此时初始点击**已经发生**，拒绝只能保持 unknown
        // 且绝不重放初始；绝不在漂移后消费最终确认或点击最终按钮。
        consumeFinalConfirmation: () => {
          const why = policyDriftReason();
          if (why) throw new Error('scheduled-policy-drift-before-final-consume:' + why);
          return reserveFinalAndRecord(ATTEMPTS_FILE, frozen);
        },
        recordFinalConfirmationOutcome: (_f, status) => guard.recordFinalConfirmationOutcome(ATTEMPTS_FILE, frozen.confirmationId, status),
        clickFinalConfirm: async (arg) => {
          const why = policyDriftReason();
          if (why) return { clicked: false, reason: 'scheduled-policy-drift-before-final-click:' + why };
          return drivers.clickFinalConfirm(arg);
        },
        readManagementRow: drivers.readManagementRow, existingPlanIds,
      });
    } catch (error) {
      res = { status: 'unknown', reason: 'scheduled-flow-exception:' + scheduledErrorText(error) };
    }
    if (res.status === 'refused') {
      // 确认门/新鲜观察在**任何消费与任何点击之前**拒绝：账本无记录可写，诚实记 blocked。
      return result('blocked', 'confirmation-refused:' + (res.reason || 'refused'), { planNumber, manifestHash: frozen.manifestHash, noAction: true, noReplay: true });
    }
    let outcome = res.status === 'success' ? 'success' : res.status === 'failed' ? 'failed' : 'unknown';
    const cookie = await drivers.saveCookies().catch(error => ({ status: 'failed', reason: scheduledErrorText(error) }));
    cookiesSaved = true;
    try {
      const updated = wf.loadDayState(STATE_FILE, businessDate);
      updated.active = { status: outcome === 'success' ? 'publish-finalizing' : 'publish-unknown', planNumber, frozen, reason: res.reason || null, planId: res.planId || null, authorizedBy: AUTHORIZED_BY };
      wf.persistDayState(STATE_FILE, updated); dayState = updated;
      if (outcome === 'success') {
        const newStore = wf.appendPublished(wf.loadPublishedStore(PUBLISHED_FILE, paths.seedFile, business.accountId), { productIds: frozen.productIds, planId: res.planId, date: businessDate });
        wf.persistPublished(PUBLISHED_FILE, newStore);
        publishedIds.clear(); for (const id of newStore.publishedIds) publishedIds.add(String(id));
        updated.plans = [...(updated.plans || []), { planNumber, status: 'success', planId: String(res.planId), manifestHash: frozen.manifestHash }];
        if (planNumber === 1) updated.firstPublishedPlan = { planNumber: 1, status: 'success', planId: String(res.planId), account_id: business.accountId, product_ids: frozen.productIds.slice(), planName: frozen.planName, manifestHash: frozen.manifestHash, businessDate, runId };
      }
      if (res.finalClick && res.finalClick.clicked === true) {
        const recorded = guard.recordFinalConfirmationOutcome(ATTEMPTS_FILE, frozen.confirmationId, outcome === 'success' ? 'success' : 'unknown');
        if (recorded !== true) { outcome = 'unknown'; res = { ...res, status: 'unknown', reason: 'final-confirm-outcome-not-durable' }; }
      }
      const initialRecorded = guard.recordPublicationOutcome(ATTEMPTS_FILE, frozen.confirmationId, outcome);
      if (initialRecorded !== true) { outcome = 'unknown'; res = { ...res, status: 'unknown', reason: 'publication-outcome-not-durable' }; }
      updated.active = { status: outcome === 'success' ? 'post-publish-enable-check-pending' : 'publish-unknown', planNumber, frozen, reason: res.reason || null, planId: res.planId || null, cookieStatus: cookie.status, authorizedBy: AUTHORIZED_BY };
      if (outcome === 'success') { updated.lastSelected = []; updated.runId = runId; updated.businessDate = businessDate; }
      wf.persistDayState(STATE_FILE, updated); dayState = updated;
    } catch (error) {
      outcome = 'unknown';
      res = { ...res, status: 'unknown', reason: 'scheduled-state-persist-failed:' + scheduledErrorText(error) };
      try {
        guard.recordFinalConfirmationOutcome(ATTEMPTS_FILE, frozen.confirmationId, 'unknown');
        guard.recordPublicationOutcome(ATTEMPTS_FILE, frozen.confirmationId, 'unknown');
        const latest = wf.loadDayState(STATE_FILE, businessDate);
        latest.active = { status: 'publish-unknown', planNumber, frozen, reason: res.reason }; wf.persistDayState(STATE_FILE, latest); dayState = latest;
      } catch (_) {}
    }
    log('info', 'scheduled-cookie-writeback ' + (cookie.status || '') + ' ' + (cookie.reason || ''));
    // 普通开启不在这里做：本入口只**只读**核实当前店状态。真正的开启复用 Monitor
    // 既有正式能力（排程侧 enableShop 钩子），失败绝不回滚已发布事实。
    // 发布耐久事实（新 ID readback + 初始/最终消费已落盘 → outcome==='success'）与开启
    // 读数**相互独立**：active 保持 published-success，开启结果只作为独立
    // postPublishEnable 事实/失败记录；绝不因"暂停/读数未知"把已确认发布写成未决的
    // post-publish-enable-stopped（那会让本日剩余份数被只读恢复挡住而重复不出）。
    // 真正的 publish-unknown 仍然原样保留且绝不重放。
    let postPublishEnable = null;
    if (outcome === 'success') {
      let current = { readOk: false, enabled: null, reason: 'enable-read-failed' };
      try { current = await drivers.readCurrentShopEnableState(); } catch (error) { current = { readOk: false, enabled: null, reason: 'enable-read-failed:' + scheduledErrorText(error) }; }
      // 本入口对开启**只读**：无论读数结论如何，actionTaken 恒为 false（与持久化的
      // enableFact/active 一致），开启动作只属于排程侧 enableShop 钩子。
      postPublishEnable = { ...wf.planPostPublishEnable(current, {}), actionTaken: false };
      const enableFact = { status: postPublishEnable.status, reason: current.reason || postPublishEnable.gap || null, actionTaken: false };
      try {
        const latest = wf.loadDayState(STATE_FILE, businessDate);
        latest.active = { ...(latest.active || {}), status: 'published-success', postPublishEnable: enableFact, actionTaken: false };
        wf.persistDayState(STATE_FILE, latest); dayState = latest;
      } catch (error) {
        // 只写失败开启事实这一笔；已确认的发布成功不降级为 unknown。
        postPublishEnable = { ...postPublishEnable, stateWriteFailed: true };
        enableFact.reason = 'enable-state-persist-failed:' + scheduledErrorText(error);
        try {
          const retry = wf.loadDayState(STATE_FILE, businessDate);
          retry.active = { ...(retry.active || {}), status: 'published-success', postPublishEnable: enableFact, actionTaken: false };
          wf.persistDayState(STATE_FILE, retry); dayState = retry;
        } catch (_) { /* 日状态仍不可写：attempts/published 已落盘，排程按真实日读数计数 */ }
      }
    }
    if (outcome !== 'success') preserveOwnedBrowser = true;
    return result(outcome, res.reason || null, {
      planId: res.planId || null, planNumber, confirmationId: frozen.confirmationId, manifestHash: frozen.manifestHash,
      businessDate, runId, cookieStatus: cookie.status || null, postPublishEnable,
      clicks: (res.clickResult && res.clickResult.clicked === true ? 1 : 0) + (res.finalClick && res.finalClick.clicked === true ? 1 : 0),
      noReplay: outcome !== 'success',
    });
  } catch (error) {
    const reason = scheduledErrorText(error);
    if (/read-only recovery|pending\/unknown/i.test(reason)) {
      preserveOwnedBrowser = true;
      return result('blocked', 'read-only-recovery-required:' + reason, { noAction: true, noReplay: true });
    }
    // R42 scope(S8/B)：准备异常只有在**正面证明当日该份从未进入任何消费**时才收口为
    // preparation-stopped（noAction，非未决发布）；任何 frozen/CID/消费痕迹/文件不可读一律
    // 保持原 unknown+noReplay，绝不放松、绝不据此自动重发。
    if (opened && paths) {
      let closure = null;
      try {
        closure = applyProvenPreparationClose(paths.stateFile, paths.attemptsFile, businessDate, {
          source: 'scheduled-run-catch', reason: 'scheduled-run-exception:' + reason,
          shop: business && business.shop, accountId: business && business.accountId,
        }, { nowMs: nowOf });
      } catch (_) { closure = null; }
      if (closure && closure.closed === true) {
        log('warn', 'scheduled-preparation-closed ' + closure.fact.planNumber + ' ' + closure.fact.runId + ' ' + closure.fact.reason);
        return result('preparation-stopped', 'scheduled-run-exception:' + reason, {
          noAction: true, noReplay: true, planNumber: closure.fact.planNumber, businessDate, runId: closure.fact.runId,
          preparationClosure: closure.fact,
        });
      }
    }
    if (!opened) {
      // 预导航打开失败（尚未取得任何活动页 → 结构上不可能有任何发布/消费）。只有对当日日状态与
      // attempts **新鲜回读**、正面证明"无任何发布/消费记录"（proveNoPublicationPreOpen）时，才以
      // 可安全重试的 'unsubmitted' 返回并带回耐久无发布证明；证明不成立一律保持原 failed
      // （绝不放宽、绝不按错误文本放行、绝不据此自动重发未知/已消费的份）。
      let pub = null;
      try {
        const p = scheduledStatePaths(business, legacyDefault, stateRoot);
        pub = proveNoPublicationPreOpen(p.stateFile, p.attemptsFile, businessDate, {
          planNumber: Number.isInteger(o.planNumber) && o.planNumber >= 1 ? o.planNumber : null,
          accountId: business.accountId == null ? null : String(business.accountId),
          shop: business.shop, runId,
        });
      } catch (_) { pub = null; }
      if (pub && pub.ok) {
        preserveOwnedBrowser = false;
        return result('unsubmitted', 'scheduled-pre-navigation-open-failed:' + reason, {
          businessDate, runId, noAction: true, noReplay: false, publicationProof: pub.proof,
        });
      }
    }
    preserveOwnedBrowser = !!opened;
    return result(opened ? 'unknown' : 'failed', 'scheduled-run-exception:' + reason, { noReplay: !!opened });
  } finally {
    if (opened) {
      if (!preserveOwnedBrowser) {
        if (!cookiesSaved) {
          try {
            const drv = drivers || createRealDrivers({ page: opened.target, managerPage: opened.target, context: opened.context, dayState: {}, persist: () => {}, publishedIds: new Set(), attemptedSet: new Set(), hints: {}, accountId: business.accountId, business, opened, projectRoot: adapterRoot, planNumber: 1, runId: 'scheduled-cleanup' });
            await drv.saveCookies();
          } catch (_) {}
        }
        const closeFn = typeof o.closeBrowser === 'function' ? o.closeBrowser : (readers && readers.closeBrowser);
        if (closeFn && opened.browser) await Promise.resolve(closeFn(opened.browser)).catch(() => {});
      }
    }
    if (releaseLock) releaseLock();
  }
}

// 排程 readDaySuccess 的真实读数（同店 namespace，含手动发布成功）：
//  * 已知账户：legacy 走原扁平文件，其它店走 shop-state/<slug>__<account> 隔离目录；
//  * 账户未知：只按该目录 own 的 shop-identity.json（店名精确 + 合法账户）定位本店；
//    多候选（同名店多账户目录）一律抛错——绝不"猜第一家"、绝不跨店借用身份；完全没有
//    已验证目录 = 可证明的今日零成功（不是"读数不可知"）；
//  * 文件损坏/不可读：抛错（排程据此把该店记 unknown，绝不静默按 0 重发）。
// 成功数 = 日状态 plans(status success, 同 businessDate) 与 attempts consumed(同日 success)
// 的 planNumber 去重并集。
function readDaySuccessForShop(shopLike, businessDate, opts) {
  const o = opts || {};
  const root = o.stateRoot || ROOT;
  const shop = String((shopLike && (shopLike.shop || shopLike.name)) || '').trim();
  if (!shop) throw new Error('day-success-shop-missing');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || ''))) throw new Error('day-success-date-invalid');
  const cfgAccount = shopLike && shopLike.accountId != null && String(shopLike.accountId) !== '' ? String(shopLike.accountId) : null;
  const legacyProfile = shopProfile.profileFromBusiness(wf.BUSINESS);
  let dirs;
  if (cfgAccount !== null) {
    dirs = shopProfile.isLegacyDefaultProfile({ shop, accountId: cfgAccount }, legacyProfile)
      ? [root] : [path.join(root, 'shop-state', shopProfile.shopSlug({ shop, accountId: cfgAccount }))];
  } else {
    const base = path.join(root, 'shop-state');
    let names = [];
    try { names = fs.existsSync(base) ? fs.readdirSync(base) : []; } catch (error) { throw new Error('day-success-state-unreadable:' + scheduledErrorText(error)); }
    // 目录名前缀只是纵深防御；同店身份的权威证明是该目录 own 的 shop-identity.json。
    // 前缀命中即视为本店候选目录：其中 identity **缺失/损坏/店名冲突/账户非法一律抛明确
    // 不可知**（读数不可信时绝不返回 0 让排程重发）；只有前缀完全无命中才是可证明的零。
    const prefix = shopProfile.shopSlug({ shop }).replace(/__pending$/, '') + '__';
    dirs = [];
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const dir = path.join(base, name);
      const identityFile = path.join(dir, 'shop-identity.json');
      if (!fs.existsSync(identityFile)) throw new Error('day-success-identity-missing:' + name);
      let identity = null;
      try { identity = JSON.parse(fs.readFileSync(identityFile, 'utf8')); } catch (error) {
        throw new Error('day-success-identity-corrupt:' + name + ':' + scheduledErrorText(error));
      }
      if (!identity || typeof identity !== 'object') throw new Error('day-success-identity-corrupt:' + name);
      if (String(identity.shop) !== shop) throw new Error('day-success-identity-shop-conflict:' + name);
      const account = identity.accountId != null ? String(identity.accountId) : '';
      if (!/^\d{6,24}$/.test(account)) throw new Error('day-success-identity-account-invalid:' + name);
      dirs.push({ dir, account });
    }
    const unique = [...new Set(dirs.map(d => d.dir))];
    // 0 个候选：本店从未建立任何已验证状态目录（可证明的今日零成功，不是"读数不可知"）。
    // >1 个候选（同名店多账户目录）：绝不"猜第一家"，抛错让排程按 unknown 停止。
    if (unique.length > 1) throw new Error('day-success-identity-ambiguous:' + unique.length);
    if (unique.length === 0) return 0;
    dirs = [unique[0]];
  }
  const successes = new Set();
  for (const entry of dirs) {
    const dir = typeof entry === 'string' ? entry : entry.dir;
    const loopAccount = typeof entry === 'string' ? cfgAccount : entry.account;
    const stateFile = path.join(dir, 'plan-publisher-state.json');
    const attemptsFile = path.join(dir, 'plan-publication-attempts.json');
    if (fs.existsSync(stateFile)) {
      let st;
      try { st = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (error) { throw new Error('day-success-state-corrupt:' + scheduledErrorText(error)); }
      if (st && String(st.businessDate) === String(businessDate)) {
        for (const p of (st.plans || [])) if (p && p.status === 'success' && Number.isInteger(Number(p.planNumber))) successes.add(Number(p.planNumber));
        // 合法 manualUI 回读作为独立已证明 fact 纳入计数（按 account/date/planNumber/唯一 planId，
        // 与 published store、dayplans 一致防漂移，并与 controller consumption 去重）。
        // fail-closed：同店同日任一已证明事实无法闭环即抛不可知，绝不静默少报而诱发排程重发。
        const dayFacts = (Array.isArray(st.manualUiPublicationFacts) ? st.manualUiPublicationFacts : [])
          .filter(f => f && String(f.businessDate || '') === String(businessDate) && (loopAccount == null || String(f.accountId || '') === String(loopAccount)));
        if (dayFacts.length) {
          const pubFile = path.join(dir, 'published-products.json');
          if (!fs.existsSync(pubFile)) throw new Error('day-success-manual-fact-published-missing');
          let pub;
          try { pub = JSON.parse(fs.readFileSync(pubFile, 'utf8')); } catch (error) { throw new Error('day-success-published-corrupt:' + scheduledErrorText(error)); }
          const pubPlans = (pub && Array.isArray(pub.plans)) ? pub.plans : [];
          const proven = manualUiSuccessPlanNumbers(st, businessDate, loopAccount, pubPlans);
          for (const n of proven) successes.add(n);
          for (const f of dayFacts) {
            const n = Number(f && f.planNumber);
            if (f && f.status === 'published-success' && String(f.source || '') === wf.MANUAL_UI_SOURCE && Number.isInteger(n) && !proven.has(n)) {
              throw new Error('day-success-manual-fact-inconsistent:' + n);
            }
          }
        }
      }
    }
    if (fs.existsSync(attemptsFile)) {
      let store;
      try { store = guard.loadAttemptsStore(attemptsFile); } catch (error) { throw new Error('day-success-attempts-corrupt:' + scheduledErrorText(error)); }
      for (const rec of Object.values(store.consumed || {})) {
        if (rec && String(rec.businessDate) === String(businessDate) && rec.status === 'success' && Number.isInteger(Number(rec.planNumber))) successes.add(Number(rec.planNumber));
      }
    }
  }
  return successes.size;
}

// 账号发现（运行时能力）：配置 accountId=null 的店用**生产 openShop + 严格同店 Cookie
// 身份验证**取真实千川账户；只读、零点击，关闭浏览器前保存 Cookie。为不预先要求人工填号、
// 也**绝不借用其它店身份**而：成功返回 accountId 字符串；身份确实未知/未通过同店验证时返回
// { error } **具体原因**（调用方据此 blocked 并逐字保留，绝不吞成通用 unknown-account，绝不
// 据此自动重试或当作登录过期）；能力缺失返回 { error:'discovery-capability-unavailable' }。
// headless 由调用方透传（内部免审核后台发布与 runPlan 一致走无窗口）。
async function discoverShopAccountByLiveSession(shopCfg, business, opts) {
  const o = opts || {};
  const adapterRoot = o.projectRoot || guard.resolveProjectRoot(process.env);
  const readers = o.readers || require(path.join(adapterRoot, 'src/adapters/chengfang-reader'));
  const openShopFn = typeof o.openShop === 'function' ? o.openShop : readers.openChengfangShop;
  const readAccountFn = typeof o.readAccountInPage === 'function' ? o.readAccountInPage : readers.readChengfangAccountInPage;
  if (typeof openShopFn !== 'function' || typeof readAccountFn !== 'function') return { error: 'discovery-capability-unavailable' };
  let loginCfg = o.loginCfg;
  if (loginCfg === undefined) {
    try {
      const cfg = (typeof o.loadConfig === 'function' ? o.loadConfig() : require(path.join(adapterRoot, 'src/config')).loadConfig());
      loginCfg = cfg && cfg.config ? cfg.config.login : null;
    } catch (_) { loginCfg = null; }
  }
  let opened = null, account = null;
  try {
    opened = await openShopFn({ loginCfg, shopCfg: navigationShopCfg(shopCfg, business && business.accountId), headless: o.headless === true });
    if (!opened || !opened.target) return { error: 'discovery-open-incomplete' };
    const identity = await opened.target.evaluate(readAccountFn);
    const check = shopProfile.verifyLiveIdentity(business || { accountId: null }, String(identity && identity.accountId));
    if (!check.ok) return { error: 'discovery-identity-unverified:' + (check.reason || 'unknown') };
    account = check.accountId;
    try {
      const drv = createRealDrivers({ page: opened.target, managerPage: opened.target, context: opened.context, dayState: {}, persist: () => {}, publishedIds: new Set(), attemptedSet: new Set(), hints: {}, accountId: account, business: { accountId: account }, opened, projectRoot: adapterRoot, planNumber: 1, runId: 'account-discovery' });
      await drv.saveCookies();
    } catch (_) {}
    return account;
  } catch (e) {
    return { error: 'discovery-open-failed:' + scheduledErrorText(e) };
  } finally {
    if (opened && opened.browser) {
      const closeFn = typeof o.closeBrowser === 'function' ? o.closeBrowser : readers.closeBrowser;
      if (closeFn) await Promise.resolve(closeFn(opened.browser)).catch(() => {});
    }
  }
}

// R41 scope(3): the EXPLICIT trusted scheduled read-only recovery entry. Deliberately
// separate from the old manual `reconcilePublishedReadbackOnly` (whose humanAuth /
// confirmationConsumptions semantics stay untouched and un-weakened): recurring-policy plans
// persist PUBLICATION and ENABLE as separate facts, so recovery promotes only a live-readback-
// PROVEN publication, and records the enable result as an independent postPublishEnable fact
// (never post-publish-enable-stopped, never a guessed success):
//   (a) same-day publish-unknown originating from this policy whose ONLY unresolved ledger
//       entry is that initial consumption → strict same-shop live identity + real management
//       readback + wf.classifyPublishOutcome must say success (unique exact-name row, new
//       planId, complete fields) before any durable write; per-fact immediate persistence;
//   (b) a proven enable-stopped state (same- or cross-day) → the same readback-gated durable
//       close the formal entry applies;
//   (c) already-promoted states return alreadyReconciled without touching the page
//       (idempotent across restarts and repeated calls);
//   (d) anything unproven / ambiguous / drifted: ZERO state change, noReplay:true, and the
//       honest 'unknown' — never a replay of a possibly-published plan, never another shop's
//       identity, never a fabricated account.
async function recoverShopDayReadback(shopLike, businessDate, opts) {
  const o = opts || {};
  const shop = String((shopLike && (shopLike.shop || shopLike.name)) || '').trim();
  if (!shop) return { ok: false, status: 'failed', reason: 'recovery-shop-missing' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(businessDate || ''))) return { ok: false, status: 'failed', reason: 'recovery-business-date-invalid' };
  const nowMs = typeof o.nowMs === 'function' ? o.nowMs : () => Date.now();
  const adapterRoot = o.projectRoot || guard.resolveProjectRoot(process.env);
  const stateRoot = o.stateRoot || ROOT;
  const legacyProfile = shopProfile.profileFromBusiness(wf.BUSINESS);
  const summaryBase = { businessDate, shop };
  let cfg;
  try {
    cfg = typeof o.loadConfig === 'function' ? o.loadConfig() : require(path.join(adapterRoot, 'src/config')).loadConfig();
  } catch (error) { return { ok: false, status: 'failed', reason: 'recovery-config-load-failed:' + scheduledErrorText(error) }; }
  if (!cfg || cfg.ready !== true || !cfg.config || !Array.isArray(cfg.config.shops)) return { ok: false, status: 'blocked', reason: 'project-config-not-ready' };
  const inputAccount = shopLike && shopLike.accountId != null && String(shopLike.accountId) !== '' ? String(shopLike.accountId) : null;
  let shopCfg;
  try { shopCfg = shopProfile.selectNamedShopConfig(cfg.config, shop, { accountId: inputAccount }); }
  catch (error) { return { ok: false, status: 'failed', reason: 'recovery-shop-selection-failed:' + scheduledErrorText(error) }; }
  let business;
  try {
    business = shopProfile.buildShopProfile({
      shop,
      accountId: inputAccount != null ? inputAccount : (shopCfg.accountId != null && String(shopCfg.accountId) !== '' ? String(shopCfg.accountId) : null),
      boundAccounts: shopCfg.boundAccounts || null,
      roi: shopCfg.targetRoi,
      dailyBudget: Number.isFinite(shopCfg.dailyBudget) && shopCfg.dailyBudget > 0 ? shopCfg.dailyBudget : 300,
      maxPlansPerDay: shopCfg.plansPerShopPerDay,
      creationPath: shopCfg.creationPath || wf.BUSINESS.creationPath,
    });
  } catch (error) { return { ok: false, status: 'failed', reason: 'recovery-profile-invalid:' + scheduledErrorText(error) }; }
  let readers = o.readers;
  if (!readers) { try { readers = require(path.join(adapterRoot, 'src/adapters/chengfang-reader')); } catch (_) { readers = null; } }
  if (!readers) return { ok: false, status: 'failed', reason: 'recovery-reader-capability-missing' };
  const openShopFn = typeof o.openShop === 'function' ? o.openShop : readers.openChengfangShop;
  const readAccountFn = typeof o.readAccountInPage === 'function' ? o.readAccountInPage : readers.readChengfangAccountInPage;
  const clickSubTabFn = typeof o.clickSubTab === 'function' ? o.clickSubTab : readers.clickChengfangSubTab;
  if (typeof openShopFn !== 'function' || typeof readAccountFn !== 'function') return { ok: false, status: 'failed', reason: 'recovery-reader-capability-missing' };
  let opened = null, releaseLock = null, drivers = null, identityVerified = false;
  try {
    opened = await openShopFn({ loginCfg: cfg.config.login, shopCfg: navigationShopCfg(shopCfg, business.accountId), headless: o.headless === true });
    if (!opened || !opened.target || !opened.context) return { ok: false, status: 'failed', reason: 'recovery-shop-open-incomplete' };
    const identity = await opened.target.evaluate(readAccountFn);
    const liveCheck = shopProfile.verifyLiveIdentity(business, String(identity && identity.accountId));
    if (!liveCheck.ok) return { ok: false, status: 'blocked', reason: 'live-account-identity-unverified:' + liveCheck.reason };
    business = shopProfile.buildShopProfile({ ...business, accountId: liveCheck.accountId });
    identityVerified = true;
    const legacyDefault = shopProfile.isLegacyDefaultProfile(business, legacyProfile);
    const paths = scheduledStatePaths(business, legacyDefault, stateRoot);
    releaseLock = acquireLock(paths.lockFile);
    const STATE_FILE = paths.stateFile, PUBLISHED_FILE = paths.publishedFile, ATTEMPTS_FILE = paths.attemptsFile;
    if (paths.isolated) {
      const identityFile = path.join(paths.dir, 'shop-identity.json');
      if (fs.existsSync(identityFile)) {
        let prev = null; try { prev = JSON.parse(fs.readFileSync(identityFile, 'utf8')); } catch (_) { prev = null; }
        const same = shopProfile.assertSameShopIdentity({ shop: business.shop, accountId: prev && prev.accountId }, { shop: business.shop, accountId: liveCheck.accountId });
        if (!same.ok) return { ok: false, status: 'blocked', reason: 'shop-state-identity-binding-conflict:' + same.reason };
      }
    }
    if (!fs.existsSync(STATE_FILE)) return { ok: true, status: 'nothingToRecover', reason: 'no-day-state-file', ...summaryBase, accountId: business.accountId };
    const stateRaw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const attempts = guard.loadAttemptsStore(ATTEMPTS_FILE);
    const a = (stateRaw && stateRaw.active) || {};
    const frozen = a.frozen || {};
    const cid = String(frozen.confirmationId || '');
    drivers = recoveryReadbackDrivers(o, opened, business, adapterRoot, readAccountFn, clickSubTabFn, readers, legacyDefault, stateRaw);
    // (c) idempotent: the SAME scheduled confirmation already durably promoted → no page read.
    if (a.status === 'published-success' && cid && String(frozen.businessDate || '') === businessDate
      && (attempts.consumed || {})[cid] && (attempts.consumed || {})[cid].status === 'success'
      && (Array.isArray(stateRaw.plans) ? stateRaw.plans : []).some(p => p && Number(p.planNumber) === Number(frozen.planNumber) && p.status === 'success'
        && String(p.manifestHash || '') === String(frozen.manifestHash))) {
      return { ok: true, status: 'alreadyReconciled', planNumber: Number(frozen.planNumber), planId: String(a.planId || ''), confirmationId: cid, manifestHash: String(frozen.manifestHash), ...summaryBase, accountId: business.accountId };
    }
    // (a) scheduled-origin same-day publish-unknown promotion, proof-first.
    if (a.status === 'publish-unknown' && String(stateRaw.businessDate || '') === businessDate && a.authorizedBy === 'recurring-user-policy' && cid) {
      const unresolved = listManualUnresolved(attempts);
      // 只允许同一冻结确认号的初始/最终未决（真实发布中断会同时留下两种记录）；
      // 跨 CID、跨店、跨日或任何其他人工未决一律拒绝。
      const soleScope = unresolved.every(u => u.id === cid);
      const anyThis = unresolved.length === 0 ? (((attempts.consumed || {})[cid] || {}).status === 'success') : true;
      const rec = (attempts.consumed || {})[cid];
      // 严格核对记录**实际携带**的身份字段（runId/businessDate/planNumber/manifestHash
      // 必须存在且一致）；accountId/planName 若记录未携带则不虚构比对，携带则必须一致。
      const presentFieldsAgree = (r) => r
        && typeof r.runId === 'string' && r.runId === String(frozen.runId || '')
        && typeof r.businessDate === 'string' && r.businessDate === businessDate
        && Number(r.planNumber) === Number(frozen.planNumber)
        && typeof r.manifestHash === 'string' && r.manifestHash === String(frozen.manifestHash)
        && (r.accountId == null || String(r.accountId) === String(business.accountId))
        && (r.planName == null || String(r.planName) === String(frozen.planName || ''));
      const recAgree = !!rec && ['pending', 'dispatched', 'unknown', 'success'].includes(rec.status) && presentFieldsAgree(rec)
        && typeof rec.runId === 'string' && typeof rec.businessDate === 'string'
        && Number.isInteger(Number(rec.planNumber)) && typeof rec.manifestHash === 'string';
      const fin = (attempts.finalConsumed || {})[cid];
      const finOk = fin === undefined || (['pending', 'unknown', 'success'].includes(fin.status)
        && (fin.runId == null || String(fin.runId) === String(frozen.runId || ''))
        && (fin.businessDate == null || String(fin.businessDate) === businessDate)
        && (fin.planNumber == null || Number(fin.planNumber) === Number(frozen.planNumber))
        && (fin.manifestHash == null || String(fin.manifestHash) === String(frozen.manifestHash))
        && (fin.accountId == null || String(fin.accountId) === String(business.accountId))
        && (fin.planName == null || String(fin.planName) === String(frozen.planName || '')));
      const reopen = (attempts.reopenConsumed || {})[cid];
      const reopenOk = reopen === undefined || ['pending', 'unknown', 'success'].includes(reopen.status);
      if (!soleScope || !anyThis || !recAgree || !finOk || !reopenOk) {
        return { ok: true, status: 'unknown', noReplay: true, reason: 'recovery-scope-not-sole-scheduled-unknown', ...summaryBase, accountId: business.accountId };
      }
      // R5：恢复的是**历史已发计划**；期望参数必须取自该冻结清单重验哈希后的历史 ROI/预算/
      // 商品数，绝不拿当前页面设置（用户可能已改 ROI/预算）顶替。冻结期望缺失、哈希不符或
      // 数值不合法时 fail-closed：零改写、绝不判成功，也绝不回退当前设置。
      const frozenRoi = Number(frozen.roi);
      const frozenBudget = Number(frozen.dailyBudget);
      const frozenProducts = Array.isArray(frozen.productIds) ? frozen.productIds.length : NaN;
      if (wf.manifestHash(frozen) !== String(frozen.manifestHash || '')
        || !(Number.isFinite(frozenRoi) && frozenRoi > 0)
        || !(Number.isFinite(frozenBudget) && frozenBudget > 0)
        || !(Number.isInteger(frozenProducts) && frozenProducts > 0)) {
        return { ok: true, status: 'unknown', noReplay: true, reason: 'recovery-frozen-expectation-unproven', ...summaryBase, accountId: business.accountId };
      }
      let rb = null;
      try { rb = await drivers.readManagementRow({ planName: String(frozen.planName), accountId: business.accountId }); } catch (_) { rb = null; }
      const publishedStore = wf.loadPublishedStore(PUBLISHED_FILE, paths.seedFile, business.accountId);
      const existingPlanIds = [...new Set([
        ...(publishedStore.plans || []).map(p => String((p && p.planId) || '')).filter(Boolean),
        ...(Array.isArray(stateRaw.plans) ? stateRaw.plans : []).map(p => String((p && p.planId) || '')).filter(Boolean),
      ])];
      const cls = wf.classifyPublishOutcome(rb, {
        planName: String(frozen.planName), accountId: business.accountId, existingPlanIds,
        productsPerPlan: frozenProducts, roi: frozenRoi, dailyBudget: frozenBudget,
      });
      // 半完成恢复收敛：同确认的消费已耐久 success、发布清单已耐久含该 planId（同日），
      // 但日状态尚未记账 → 回读命中重复 planId 不再判死；仅把**该已证明归属本确认**的
      // planId 从既有清单剔除后重新分类。其余任何重复/漂移检查原样保留。
      let clsFinal = cls;
      if (cls.outcome !== 'success' && String(cls.reason || '') === 'plan-id-not-new'
        && rb && rb.found === true && rb.uniqueRow === true) {
        const dupId = String(rb.planId || '');
        const finNow0 = (attempts.finalConsumed || {})[cid];
        const durableHalf = ((attempts.consumed || {})[cid] || {}).status === 'success'
          && (finNow0 === undefined || finNow0.status === 'success')
          && dupId !== ''
          && (publishedStore.plans || []).some(p => p && String(p.planId || '') === dupId && String(p.date || '') === businessDate)
          && !(Array.isArray(stateRaw.plans) ? stateRaw.plans : []).some(p => p && Number(p.planNumber) === Number(frozen.planNumber) && p.status === 'success');
        if (durableHalf) {
          const recl = wf.classifyPublishOutcome(rb, {
            planName: String(frozen.planName), accountId: business.accountId,
            existingPlanIds: existingPlanIds.filter(id => id !== dupId),
            productsPerPlan: frozenProducts, roi: frozenRoi, dailyBudget: frozenBudget,
          });
          if (recl.outcome === 'success') clsFinal = recl;
        }
      }
      if (clsFinal.outcome !== 'success') {
        return { ok: true, status: 'unknown', noReplay: true, reason: String(clsFinal.reason || 'readback-did-not-prove-success'), planNumber: Number(frozen.planNumber), ...summaryBase, accountId: business.accountId };
      }
      const planId = String(clsFinal.planId || (rb && rb.planId) || '');
      if (!/^\d{12,20}$/.test(planId)) return { ok: true, status: 'unknown', noReplay: true, reason: 'recovered-plan-id-invalid', ...summaryBase, accountId: business.accountId };
      // per-fact immediate persistence, attempts first so a crash can never leave the day
      // state claiming success while the ledger still shows an unresolved publish.
      const storeNow = guard.loadAttemptsStore(ATTEMPTS_FILE);
      if ((storeNow.consumed || {})[cid] && storeNow.consumed[cid].status !== 'success'
        && guard.recordPublicationOutcome(ATTEMPTS_FILE, cid, 'success') !== true) {
        return { ok: true, status: 'unknown', noReplay: true, reason: 'recovery-attempts-write-failed', ...summaryBase, accountId: business.accountId };
      }
      const finNow = (storeNow.finalConsumed || {})[cid];
      if (finNow && finNow.status !== 'success'
        && guard.recordFinalConfirmationOutcome(ATTEMPTS_FILE, cid, 'success') !== true) {
        return { ok: true, status: 'unknown', noReplay: true, reason: 'recovery-final-write-failed', ...summaryBase, accountId: business.accountId };
      }
      if (!(publishedStore.plans || []).some(p => String((p && p.planId) || '') === planId)) {
        wf.persistPublished(PUBLISHED_FILE, wf.appendPublished(publishedStore, { productIds: (frozen.productIds || []).map(String), planId, date: businessDate }));
      }
      const latest = wf.loadDayState(STATE_FILE, businessDate);
      const la = latest.active || {};
      if (!la || String((la.frozen || {}).confirmationId || '') !== cid) {
        return { ok: true, status: 'unknown', noReplay: true, reason: 'state-changed-before-recovery-persist', ...summaryBase, accountId: business.accountId };
      }
      latest.plans = Array.isArray(latest.plans) ? latest.plans.slice() : [];
      if (!latest.plans.some(p => p && Number(p.planNumber) === Number(frozen.planNumber) && p.status === 'success' && String(p.planId || '') === planId)) {
        latest.plans.push({ planNumber: Number(frozen.planNumber), status: 'success', planId, manifestHash: String(frozen.manifestHash) });
      }
      if (Number(frozen.planNumber) === 1 && !latest.firstPublishedPlan) {
        latest.firstPublishedPlan = { planNumber: 1, status: 'success', planId, account_id: business.accountId, product_ids: (frozen.productIds || []).map(String).slice(), planName: String(frozen.planName), manifestHash: String(frozen.manifestHash), businessDate, runId: String(frozen.runId || '') };
      }
      let current = { readOk: false, enabled: null, reason: 'enable-read-not-attempted' };
      try { current = await drivers.readCurrentShopEnableState(); } catch (error) { current = { readOk: false, enabled: null, reason: 'enable-read-failed:' + scheduledErrorText(error) }; }
      const planFact = wf.planPostPublishEnable(current, {});
      // 发布/开启分离：开启结论只作为独立事实；绝不写 post-publish-enable-stopped。
      latest.active = {
        status: 'published-success', planNumber: Number(frozen.planNumber), frozen, planId,
        authorizedBy: 'recurring-user-policy',
        postPublishEnable: { status: planFact.status, reason: current.reason || planFact.gap || null, actionTaken: false },
        actionTaken: false, recoveredBy: 'scheduled-readback-recovery', recoveredAt: new Date(nowMs()).toISOString(),
      };
      wf.persistDayState(STATE_FILE, latest);
      return { ok: true, status: 'recovered', planNumber: Number(frozen.planNumber), planId, confirmationId: cid, manifestHash: String(frozen.manifestHash), enableStatus: planFact.status, ...summaryBase, accountId: business.accountId };
    }
    // (b) proven enable-stopped (same- or cross-day) → readback-gated durable close.
    if (a.status === 'post-publish-enable-stopped') {
      const closable = classifyProvenEnableStoppedState(stateRaw, attempts, business);
      if (!closable.closable) {
        return { ok: true, status: 'unknown', noReplay: true, reason: 'enable-stopped-not-proven:' + closable.reason, ...summaryBase, accountId: business.accountId };
      }
      let rb2 = null;
      try { rb2 = await drivers.readManagementRow({ planName: closable.planName, accountId: business.accountId }); } catch (_) { rb2 = null; }
      if (!(rb2 && rb2.found === true && rb2.uniqueRow === true && String(rb2.planId) === String(closable.planId))) {
        return { ok: true, status: 'unknown', noReplay: true, reason: 'enable-stopped-readback-not-proven', closedBusinessDate: closable.closedBusinessDate, ...summaryBase, accountId: business.accountId };
      }
      const applied = applyProvenEnableStoppedClose(STATE_FILE, closable, { nowMs });
      if (!applied.closed) {
        return { ok: true, status: 'unknown', noReplay: true, reason: applied.reason, ...summaryBase, accountId: business.accountId };
      }
      return { ok: true, status: 'closed', planNumber: closable.planNumber, planId: closable.planId, confirmationId: closable.confirmationId, manifestHash: closable.manifestHash, closedBusinessDate: closable.closedBusinessDate, ...summaryBase, accountId: business.accountId };
    }
    // (e) R42 scope(S8/B)：当日排程 origin 准备停滞（preparing、无 frozen/CID/manifest、任何
    // 初始/最终/reopen/手动消费都不存在）→ 耐久收口为 preparationClosed（不是发布成功）。
    // 证明不齐一律诚实 unknown、零改写、零重放；本分支**从不读管理页**，纯文件正面证据。
    if (a.status === 'preparing') {
      const chk = provePreparationZeroConsumption(stateRaw, attempts, businessDate);
      if (!chk.ok) {
        return { ok: true, status: 'unknown', noReplay: true, reason: 'preparation-closure-not-proven:' + chk.reason, ...summaryBase, accountId: business.accountId };
      }
      const closure = applyProvenPreparationClose(STATE_FILE, ATTEMPTS_FILE, businessDate, {
        source: 'read-only-recovery', reason: String(a.reason || 'preparing-stall-observed-by-readonly-recovery'),
        shop: business.shop, accountId: business.accountId,
      }, { nowMs });
      if (closure.closed !== true) {
        return { ok: true, status: 'unknown', noReplay: true, reason: closure.reason, ...summaryBase, accountId: business.accountId };
      }
      return { ok: true, status: 'preparationClosed', planNumber: closure.fact.planNumber, runId: closure.fact.runId, closedAt: closure.fact.closedAt, reason: closure.fact.reason, preparationClosure: closure.fact, ...summaryBase, accountId: business.accountId };
    }
    // (e2) 幂等收敛：publisher 侧已耐久收口（catch 或前次恢复写入）但排程账本尚未映射 →
    // 由耐久事实重新派生同一 preparationClosed 证明，零再改写。
    // R42 scope(S9)：与 (e) 同一门槛——日状态携带 unknown/pending 未决旗标时绝不重派生收口。
    if (a.status === 'preparation-stopped' && !stateRaw.unknown && !stateRaw.pending) {
      const facts = (Array.isArray(stateRaw.preparationClosureFacts) ? stateRaw.preparationClosureFacts : [])
        .filter(f => f && f.status === 'preparationClosed' && String(f.businessDate || '') === businessDate
          && String(f.accountId || '') === String(business.accountId)
          && SCHEDULED_RUN_ORIGIN_RE.test(String(f.runId || ''))
          && Number.isInteger(Number(f.planNumber)) && Number(f.planNumber) >= 1
          && strictZeroConsumptionProof(f.zeroConsumptionProof));
      const last = facts.slice(-1)[0];
      if (last) {
        return { ok: true, status: 'preparationClosed', alreadyClosed: true, planNumber: Number(last.planNumber), runId: String(last.runId), closedAt: last.closedAt || null, reason: String(last.reason || ''), preparationClosure: last, ...summaryBase, accountId: business.accountId };
      }
    }
    // (d) any other unresolved shape: honest unknown, zero mutation, zero replay.
    if (wf.hasUnresolvedPlan(stateRaw) || listManualUnresolved(attempts).length > 0) {
      return { ok: true, status: 'unknown', noReplay: true, reason: 'unresolved-state-not-recoverable-by-readback', ...summaryBase, accountId: business.accountId };
    }
    // (b2) 中断收敛：旧 enable-stopped 已耐久关闭（facts 已落盘、active 已清空）但排程
    // 账本尚未释放——由耐久证明重新派生 'closed'，绝不把普通 nothingToRecover 泛化成可释放。
    const closedFacts = (Array.isArray(stateRaw.provenPublishEnableFacts) ? stateRaw.provenPublishEnableFacts : [])
      .filter(f => f && String(f.businessDate || '') === businessDate && f.status === 'post-publish-enable-stopped'
        && /^\d{12,20}$/.test(String(f.planId || '')) && f.confirmationId
        && /^[a-f0-9]{64}$/i.test(String(f.manifestHash || ''))
        && Number.isInteger(Number(f.planNumber)) && Number(f.planNumber) >= 1)
      .slice(-1)[0] || null;
    if (closedFacts) {
      const frec = (attempts.consumed || {})[String(closedFacts.confirmationId)];
      const ffin = (attempts.finalConsumed || {})[String(closedFacts.confirmationId)];
      const freopen = (attempts.reopenConsumed || {})[String(closedFacts.confirmationId)];
      if (frec && frec.status === 'success' && String(frec.manifestHash || '') === String(closedFacts.manifestHash)
        && Number(frec.planNumber) === Number(closedFacts.planNumber)
        && (!ffin || ffin.status === 'success') && freopen === undefined) {
        return { ok: true, status: 'closed', planNumber: Number(closedFacts.planNumber), planId: String(closedFacts.planId), confirmationId: String(closedFacts.confirmationId), manifestHash: String(closedFacts.manifestHash), closedBusinessDate: String(closedFacts.businessDate), recoveredFromDurableFact: true, ...summaryBase, accountId: business.accountId };
      }
    }
    return { ok: true, status: 'nothingToRecover', ...summaryBase, accountId: business.accountId };
  } catch (error) {
    return { ok: false, status: 'failed', reason: 'recovery-exception:' + scheduledErrorText(error) };
  } finally {
    if (opened && identityVerified) {
      try {
        const drv = drivers || createRealDrivers({ page: opened.target, managerPage: opened.target, context: opened.context, dayState: {}, persist: () => {}, publishedIds: new Set(), attemptedSet: new Set(), hints: {}, accountId: business.accountId, business, opened, projectRoot: adapterRoot, planNumber: 1, runId: 'recovery-cleanup' });
        await Promise.resolve(drv.saveCookies()).catch(() => {});
      } catch (_) { /* Cookie 保存失败不改变只读恢复结论 */ }
    }
    if (opened && opened.browser) {
      const closeFn = typeof o.closeBrowser === 'function' ? o.closeBrowser : (readers && readers.closeBrowser);
      if (closeFn) await Promise.resolve(closeFn(opened.browser)).catch(() => {});
    }
    if (releaseLock) releaseLock();
  }
}

// ── S17 手动原生 UI 发布入账（仅 Root 操作者显式调用，绝不自动触发）──────────────
// 用户在原生千川页面上亲手完成的一次真实发布（Main 因 known-partial-notice-not-closeable
// 停在 preparing），必须能被**如实**纳入当日份数，而**不是**重发、也**不是**伪造一次
// controller 消费。此入口：
//   * 只做只读回读 + 独立事实落账；不点击、不接 API/定时器、不接任何 live-action 依赖；
//   * 要求 operatorAuthorized===true + 完整原生 preflight receipt + 现场 Cookie 证明的
//     账户一致 + 管理页**唯一同名同 planId** 行经既有 classifyPublishOutcome 判成功；
//   * 任何缺失/漂移（收据/账户/日/run/份号/名/商品数/唯一性/绑定 0/ROI/预算/佣金/未决消费/
//     缺 attempts/operator 未授权）在原 preparing 上**零未来点击、零消费、零导入**停下；
//   * 证明通过后才按「事实 → published → dayplans → active」顺序落盘，全程不写 attempts，
//     绝不伪造 manifestHash / nonce / consumed / finalConsumed / reopen；
//   * 中断后重入：同 receipt + 实际管理回读证明 → 幂等补齐，active 最后才收敛。
function manualUiSuccessPlanNumbers(state, businessDate, accountId, publishedPlans) {
  const s = state || {};
  const facts = Array.isArray(s.manualUiPublicationFacts) ? s.manualUiPublicationFacts : [];
  const plans = Array.isArray(s.plans) ? s.plans : [];
  const out = new Set();
  for (const f of facts) {
    if (!f || f.status !== 'published-success' || String(f.source || '') !== wf.MANUAL_UI_SOURCE) continue;
    if (String(f.businessDate || '') !== String(businessDate)) continue;
    if (accountId != null && String(f.accountId || '') !== String(accountId)) continue;
    const n = Number(f.planNumber);
    if (!Number.isInteger(n) || n < 1 || n > 3) continue;
    const planId = String(f.planId || '');
    if (!/^\d{12,20}$/.test(planId)) continue;
    if (!/^[a-f0-9]{64}$/i.test(String(f.receiptHash || ''))) continue;
    // 防漂移：必须与 dayplans 的成功条目、以及（提供时）published store 的 planId 一致。
    const dp = plans.find(p => p && Number(p.planNumber) === n && p.status === 'success' && String(p.source || '') === wf.MANUAL_UI_SOURCE);
    if (!dp || String(dp.planId || '') !== planId) continue;
    if (Array.isArray(publishedPlans) && !publishedPlans.some(p => p && String(p.planId || '') === planId)) continue;
    out.add(n);
  }
  return out;
}
// 当日「下一份」份号：attempts.consumed 的同日成功数 + 尚未被消费覆盖的已证明手动事实数 + 1。
// 无手动事实时与既有 consumedToday.length + 1 完全一致（绝不改变普通 publisher 行为）。
function nextPlanNumberForDay(state, attempts, businessDate, accountId, publishedPlans) {
  const consumed = Object.values((attempts && attempts.consumed) || {})
    .filter(r => r && String(r.businessDate) === String(businessDate) && r.status === 'success');
  const consumedNums = new Set(consumed.map(r => Number(r.planNumber)));
  const manual = manualUiSuccessPlanNumbers(state, businessDate, accountId, publishedPlans);
  const extraManual = [...manual].filter(n => !consumedNums.has(n)).length;
  return consumed.length + extraManual + 1;
}

async function reconcileManualUiPublication(deps) {
  const d = deps || {};
  const now = typeof d.nowMs === 'function' ? d.nowMs() : (d.nowMs != null ? d.nowMs : Date.now());
  const refuse = (reason, extra) => ({ status: 'refused', reason, written: 0, clicked: false, clicks: 0, noAction: true, noReplay: true, ...(extra || {}) });

  // 1. 显式 Root 操作者授权 + 授权来源（缺一不可）
  if (d.operatorAuthorized !== true) return refuse('operator-not-authorized');
  const authorizationSource = String(d.authorizationSource || '').trim();
  if (!authorizationSource) return refuse('authorization-source-missing');

  // 2. 绝不接线任何真实点击/消费能力（误接即拒绝，绝不"顺手"复用）
  for (const forbidden of ['clickFinalConfirm', 'clickNativePublishPlan', 'awaitFinalDialog', 'consumeFinalConfirmationOnce', 'consumeReopenOnce', 'consumePublicationOnce', 'reserveConfirmation', 'consumeFinalConfirmation', 'startPublish', 'publishApply', 'runPublishPlan']) {
    if (typeof d[forbidden] === 'function') return refuse('manual-reconcile-forbids-live-action-dependency:' + forbidden);
  }
  if (typeof d.readManagementRow !== 'function') throw new Error('manual-reconcile-dependency-missing:readManagementRow');
  if (!d.stateFile || !d.publishedFile || !d.attemptsFile) throw new Error('manual-reconcile-file-scope-missing');
  if (!Array.isArray(d.existingPlanIds)) return refuse('existing-plan-ids-missing');

  const business = wf.bizOf(d.business);
  const account = String(business.accountId);

  // 3. 完整原生 preflight receipt 严格校验（口径与既有 profile 一致）
  const receipt = d.receipt;
  const v = wf.validateManualUiReceipt(receipt, business);
  if (!v.ok) return refuse('receipt-invalid:' + v.reason);
  const businessDate = String(receipt.businessDate);
  if (wf.shanghaiDate(now) !== businessDate) return refuse('business-date-not-today');
  const observedPlanId = String(d.observedPlanId || '');
  if (!/^\d{12,20}$/.test(observedPlanId)) return refuse('observed-plan-id-invalid');

  // 4. 现场 Cookie 证明的真实账户必须与本店身份一致（离线由 fake provider 注入）
  const verifiedAccountId = d.verifiedAccountId != null ? String(d.verifiedAccountId) : null;
  if (verifiedAccountId === null) return refuse('live-account-not-verified');
  if (verifiedAccountId !== account) return refuse('live-account-mismatch');

  // 3b. 锁是**必填**前提：手动回读证明的 durable 写入必须实际持锁，缺失或获取失败一律在
  // 任何写入之前拒绝；operator 授权绝不构成绕过，也绝不新增任何 stateRoot 旁路。
  if (!d.lockFile) return refuse('manual-reconcile-lock-required');
  let releaseLock = null;
  try { releaseLock = acquireLock(d.lockFile); }
  catch (e) { return refuse('manual-reconcile-lock-busy:' + scheduledErrorText(e)); }
  try {
    // 原始 state 必须在任何 loadDayState 归一 / 任何写入**之前**读取并严格校验：
    // loadDayState 只回显当日游标字段，会把顶层 unknown/pending 静默丢掉；绝不能让一个
    // 真实未决被归一后当作「已可收口」而错误 success（幂等重入同样不得吞掉新的未决）。
    let rawStateText = null;
    try { rawStateText = fs.readFileSync(d.stateFile, 'utf8'); }
    catch (e) { return refuse('day-state-unreadable:' + ((e && e.code) || (e && e.message))); }
    let rawState = null;
    try { rawState = JSON.parse(rawStateText); } catch (_) { return refuse('day-state-unparseable'); }
    if (!rawState || typeof rawState !== 'object' || Array.isArray(rawState)) return refuse('day-state-invalid-shape');
    if (rawState.unknown === true || rawState.pending === true) return refuse('day-state-unresolved-flag-present');
    let state;
    try { state = wf.loadDayState(d.stateFile, businessDate); } catch (e) { return refuse('day-state-unreadable:' + (e && e.message)); }
    // 「完整真实 attempts 存在」是放行前提之一：guard loader 的 ENOENT→空 store 是「首次尝试」
    // 的全局语义，不得改；但手动回读证明绝不把「文件缺失/被删」当作零消费证据（缺失即拒绝）。
    if (!fs.existsSync(d.attemptsFile)) return refuse('attempts-store-missing');
    // guard.loadAttemptsStore 对缺失的 finalConsumed/reopenConsumed 会用默认空对象补齐——那是
    // 「首次尝试」的全局语义，不能当作本店本日「零消费完整证明」。手动回读证明必须**先读原始
    // JSON**，严格确认 consumed/finalConsumed/reopenConsumed 三张表都存在且为普通对象；
    // 缺失 / null / 数组 / 畸形一律拒绝且零改写，绝不用 defaults 冒充完整证明。
    let rawAttemptsText = null;
    try { rawAttemptsText = fs.readFileSync(d.attemptsFile, 'utf8'); }
    catch (e) { return refuse('attempts-store-unreadable:' + ((e && e.code) || (e && e.message))); }
    let rawAttempts = null;
    try { rawAttempts = JSON.parse(rawAttemptsText); } catch (_) { return refuse('attempts-store-unparseable'); }
    if (!rawAttempts || typeof rawAttempts !== 'object' || Array.isArray(rawAttempts)) return refuse('attempts-store-invalid-shape');
    for (const tableName of ['consumed', 'finalConsumed', 'reopenConsumed']) {
      const table = rawAttempts[tableName];
      if (!table || typeof table !== 'object' || Array.isArray(table)) return refuse('attempts-' + tableName + '-missing-or-invalid');
    }
    let attempts;
    try { attempts = guard.loadAttemptsStore(d.attemptsFile); } catch (e) { return refuse('attempts-unreadable:' + (e && e.message)); }
    if (!attempts || typeof attempts !== 'object' || !attempts.consumed || typeof attempts.consumed !== 'object') return refuse('attempts-store-unreadable');

    const receiptHash = wf.manualUiReceiptHash(receipt);
    const facts = Array.isArray(state.manualUiPublicationFacts) ? state.manualUiPublicationFacts : [];
    const priorFact = facts.find(f => f && f.status === 'published-success' && String(f.planId || '') === observedPlanId) || null;
    const idempotent = !!priorFact
      && String(priorFact.source || '') === wf.MANUAL_UI_SOURCE
      && String(priorFact.receiptHash || '') === receiptHash
      && Number(priorFact.planNumber) === 1
      && String(priorFact.businessDate || '') === businessDate
      && String(priorFact.accountId || '') === account
      && String(priorFact.runId || '') === String(receipt.runId);

    if (!idempotent) {
      // 仅允许此确切手动来源的 preparing：无 frozen/nonce/确认痕迹、零消费、无他处未决。
      const a = state.active || null;
      if (!a || a.status !== 'preparing') return refuse('not-manual-preparing-origin');
      if (state.unknown || state.pending) return refuse('day-state-unresolved-flag-present');
      if (String(state.businessDate || '') !== businessDate) return refuse('state-business-date-mismatch');
      if (Number(a.planNumber) !== 1) return refuse('active-plan-number-invalid');
      if (a.frozen || a.confirmationId != null || a.manifestHash != null || a.planId != null || a.nonce != null) return refuse('confirmation-artifacts-present');
      const runId = String(a.runId || (rawState && rawState.runId) || '');
      const origin = wf.MANUAL_RUN_ORIGIN_RE.exec(runId);
      if (!origin || origin[1] !== businessDate) return refuse('run-origin-not-manual');
      if (runId !== String(receipt.runId)) return refuse('receipt-run-id-mismatch');
      if (!Array.isArray(state.plans)) return refuse('plans-list-unreadable');
      if (state.plans.some(p => p && Number(p.planNumber) === 1)) return refuse('plan-number-already-in-day-plans');
      if (!Array.isArray(state.confirmationConsumptions)) return refuse('confirmation-consumptions-unreadable');
      if (state.confirmationConsumptions.length > 0) return refuse('confirmation-consumption-present');
      for (const mapName of ['consumed', 'finalConsumed', 'reopenConsumed']) {
        for (const rec of Object.values(attempts[mapName] || {})) {
          if (!rec) continue;
          if (String(rec.runId || '') === String(receipt.runId)) return refuse(mapName + '-consumption-for-run');
          if (String(rec.businessDate || '') === businessDate && Number(rec.planNumber) === 1) return refuse(mapName + '-consumption-for-same-day-plan');
        }
      }
      if (listManualUnresolved(attempts).length > 0) return refuse('manual-unresolved-present');
    }

    // 4b. 原始 firstPublishedPlan：若已记录一份**不同**的成功首份（planId / 日期 / 账户 /
    // 商品合同冲突），说明当日首份已被别的计划占用。此时绝不能在保留错误 first 的同时把
    // 当前回读记为成功——必须在任何写之前核对，冲突即零写拒绝。若原 first 与本次合同一致，
    // 则保留原记录、不重写（避免任何漂移）。
    const rawFirst = rawState.firstPublishedPlan;
    if (rawFirst && typeof rawFirst === 'object' && !Array.isArray(rawFirst) && rawFirst.status === 'success') {
      const fProducts = Array.isArray(rawFirst.product_ids) ? rawFirst.product_ids.map(String) : [];
      const sameProducts = fProducts.length === v.productIds.length
        && JSON.stringify([...fProducts].sort()) === JSON.stringify([...v.productIds].sort());
      const firstConsistent = Number(rawFirst.planNumber) === 1
        && String(rawFirst.planId || '') === observedPlanId
        && String(rawFirst.account_id || rawFirst.accountId || '') === account
        && String(rawFirst.businessDate || '') === businessDate
        && sameProducts;
      if (!firstConsistent) return refuse('first-published-plan-conflict');
    }

    // 5. published store 现状（幂等重入时自有 planId 从"已存在集合"剔除后重判）
    let pubStore = null;
    try { pubStore = wf.loadPublishedStore(d.publishedFile, d.seedFile, account); } catch (e) { return refuse('published-unreadable:' + (e && e.message)); }
    const baseExisting = d.existingPlanIds.map(String);
    if (!idempotent && baseExisting.includes(observedPlanId)) return refuse('plan-id-not-new');
    const classifyExisting = idempotent ? baseExisting.filter(id => id !== observedPlanId) : baseExisting;

    // 6. 真实管理页回读：唯一同名同 planId 行 + 30 商品 / 1-2 账号 / ROI / 预算 / 佣金
    let readback = null;
    try { readback = await d.readManagementRow({ planName: String(receipt.planName), accountId: account }); }
    catch (e) { return refuse('management-readback-failed:' + (e && e.message)); }
    const outcome = wf.classifyPublishOutcome(readback, {
      planName: String(receipt.planName), accountId: account, existingPlanIds: classifyExisting,
      productsPerPlan: business.productsPerPlan, roi: business.roi, dailyBudget: business.dailyBudget,
    });
    if (outcome.outcome !== 'success') return refuse('management-readback-not-success:' + (outcome.reason || outcome.outcome));
    if (String(outcome.planId) !== observedPlanId) return refuse('observed-plan-id-mismatch');

    // ── 全部检查已通过，才开始 durable 写：事实 → published → dayplans → active ──
    let written = 0;
    const originalReason = idempotent
      ? (priorFact.originalReason == null ? null : String(priorFact.originalReason))
      : (state.active && state.active.reason != null ? String(state.active.reason) : null);
    const runId = String(receipt.runId);
    const fact = idempotent ? priorFact : wf.buildManualUiPublicationFact({
      planId: observedPlanId, planName: receipt.planName, businessDate, runId, accountId: account,
      receiptHash, authorizationSource, productIds: v.productIds, originalReason, nowMs: now,
    });

    try {
      const cur = wf.loadDayState(d.stateFile, businessDate);
      cur.manualUiPublicationFacts = Array.isArray(cur.manualUiPublicationFacts) ? cur.manualUiPublicationFacts : [];
      if (!cur.manualUiPublicationFacts.some(f => f && String(f.planId || '') === observedPlanId && String(f.receiptHash || '') === receiptHash)) {
        cur.manualUiPublicationFacts.push(fact);
      }
      wf.persistDayState(d.stateFile, cur);
      written |= 1;
    } catch (e) { return { status: 'unknown', reason: 'manual-reconcile-fact-write-failed:' + (e && e.message), written, clicked: false, clicks: 0, noReplay: true }; }

    try {
      const store = wf.loadPublishedStore(d.publishedFile, d.seedFile, account);
      if (!(store.plans || []).some(p => String((p && p.planId) || '') === observedPlanId)) {
        wf.persistPublished(d.publishedFile, wf.appendPublished(store, { productIds: v.productIds, planId: observedPlanId, date: businessDate }));
      }
      written |= 2;
    } catch (e) { return { status: 'unknown', reason: 'manual-reconcile-published-write-failed:' + (e && e.message), written, clicked: false, clicks: 0, noReplay: true }; }

    try {
      const cur = wf.loadDayState(d.stateFile, businessDate);
      cur.plans = Array.isArray(cur.plans) ? cur.plans.slice() : [];
      if (!cur.plans.some(p => p && Number(p.planNumber) === 1 && p.status === 'success' && String(p.planId || '') === observedPlanId)) {
        cur.plans.push({ planNumber: 1, status: 'success', planId: observedPlanId, source: wf.MANUAL_UI_SOURCE, receiptHash, businessDate });
      }
      if (!cur.firstPublishedPlan) {
        cur.firstPublishedPlan = { planNumber: 1, status: 'success', planId: observedPlanId, account_id: account, product_ids: v.productIds.slice(), planName: String(receipt.planName), source: wf.MANUAL_UI_SOURCE, receiptHash, businessDate, runId };
      }
      cur.lastSelected = [];
      wf.persistDayState(d.stateFile, cur);
      written |= 4;
    } catch (e) { return { status: 'unknown', reason: 'manual-reconcile-day-plan-write-failed:' + (e && e.message), written, clicked: false, clicks: 0, noReplay: true }; }

    try {
      const cur = wf.loadDayState(d.stateFile, businessDate);
      cur.active = {
        status: 'published-success', planNumber: 1, planId: observedPlanId,
        source: wf.MANUAL_UI_SOURCE, receiptHash, originalPhase: 'preparing', originalReason,
        runId, businessDate, manualUiReconciledAt: new Date(now).toISOString(),
      };
      wf.persistDayState(d.stateFile, cur);
      written |= 8;
    } catch (e) { return { status: 'unknown', reason: 'manual-reconcile-active-write-failed:' + (e && e.message), written, clicked: false, clicks: 0, noReplay: true }; }

    return {
      status: idempotent ? 'alreadyReconciled' : 'success', reconciled: true, planNumber: 1, planId: observedPlanId,
      receiptHash, source: wf.MANUAL_UI_SOURCE, clicked: false, clicks: 0, noAction: true, noReplay: true,
      productIds: v.productIds.slice(), readback,
    };
  } finally {
    if (releaseLock) releaseLock();
  }
}

module.exports={publisherStatePaths,bindingAccountsSnapshotSettled,publishExplicitFailureReplacementOnly,atomicWrite,acquireLock,until,listManualUnresolved,shouldRunReadOnlyRecovery,proveNoPublicationPreOpen,proveSchedulerReleaseProof,sha256Hex,preOpenSourceHash,currentPreOpenSourceHash,nativeAdvanceCursor,navigationShopCfg,pickerBatchStateMatches,normalizeCatalogCategory,catalogTabForCategory,isNativeScrollCategory,isNativeScrollTab,unionCatalogIds,parseCatalogRequestUrl,parseCatalogResponseBody,nativeScrollStateInPage,nativeScrollStepInPage,restoreNativeMarkerNudgeInPage,createCatalogTransport,CATEGORY_TAB,NATIVE_SCROLL_CATEGORIES,NATIVE_SCROLL_TABS,CATALOG_ORIGIN,CATALOG_PATH,CATALOG_INITIAL_CURSOR,CATALOG_NATIVE_MODE,openPickerInPage,ensureCommissionInPage,ensureDirectPayOffInPage,drawerSnapshotInPage,clickDrawerTabInPage,numericPickerPagingInPage,selectNativeCardInPage,deselectNativeCardInPage,removeNativeCardInPage,confirmDraftRemovalInPage,bindingDrawerSnapshotInPage,selectAllAccountsInPage,applyBatchAccountsInPage,confirmBatchAccountsApplyInPage,batchAddAllModalSnapshotInPage,confirmBatchAddAllModalInPage,batchResultSnapshotInPage,acknowledgeBatchResultInPage,closeKnownPartialResultInPage,acceptPartialDraftWarningInPage,openAnchorManagementInPage,cancelAutoOpenedDrawerInPage,selectBindingDrawerPanelInPage,bindingOverlaySnapshotInPage,classifyAndCancelAutoPullInPage,readMainTableInPage,creationPlanNameInPage,readManagementRowsInPage,dialogLandscapeSnapshotInPage,finalDialogSnapshotInPage,clickFinalConfirmInPage,guidanceActionInPage,guidanceStorageCaptureInPage,guidanceRestoreInitScript,isAllowedGuidanceKey,validateGuidanceState,guidanceFilePath,guidanceScopeFor,readPrivateGuidanceState,persistPrivateGuidanceState,installGuidanceRestore,runGuidanceOnPage,runGuidancePhase,handleLateGuidanceBeforeNativeAdvance,createRealDrivers,shanghaiPlanName,inspectRecoveryOnly,resumeKnownFinalOnly,reconcilePublishedReadbackOnly,runScheduledPlan,readDaySuccessForShop,discoverShopAccountByLiveSession,classifyProvenEnableStoppedState,applyProvenEnableStoppedClose,recoverShopDayReadback,scheduledErrorText,reconcileManualUiPublication,manualUiSuccessPlanNumbers,nextPlanNumberForDay,main};

if(require.main===module)main();
