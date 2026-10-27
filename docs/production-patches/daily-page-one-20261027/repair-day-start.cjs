'use strict';
// S5R1(2026-10-26 stage / 2026-10-27 rework) patrol-plan-refill — controlled
// CURRENT-day browse-start repair for ONE proven-stopped shop day.
//
// Purpose: the user's explicit rule 每天从第一页找未发布商品 must be applied ONCE to a
// shop whose CURRENT business-day day-state stopped mid-catalog at a safe pagination
// boundary (active.status='preparation-stopped'), WITHOUT touching any same-day
// success/financial record. loadDayState in plan-workflow.cjs resets on a NEW day; this
// tool performs the equivalent browse reset on the SAME day for that one proven-stopped
// state, under every usual writer lock, with byte-exact CAS + backup.
//
// This file is SOURCE ONLY. It never runs at require time, never touches a browser,
// network, config or Cookie, and never writes anything unless its (testable) core is
// invoked by main() with explicit absolute paths AFTER source/test acceptance and with
// the publisher idle. It changes ONLY state.page / state.category / state.cursor to the
// newDayState(date) defaults; every other field is preserved EXACTLY (byte-identical
// key order; only the three browse fields are replaced). The day ledger, the attempts
// store and the published book are read for criteria and are NEVER rewritten — their
// on-disk bytes must be unchanged after a repair.
//
// S5R1 REAL fixture gap fix: the real Jin ledger carries entry1 SUCCESS (its consumed
// confirmationId is RETAINED legitimate history, NOT open consumption) AND an entry2
// with status 'preparation-stopped'. entry2 is allowed ONLY when it is the exact
// resolved close of the CURRENT day state: same runId (entry.preparationRunId or
// entry.runId === active.runId), same plan number, same reason, and no
// confirmationId/planId/manifestHash/nonce/frozen artifacts — plus the NATIVE zero
// consumption proof of the state (reproveDurablePreparationStoppedClose) which is
// re-run BEFORE and AFTER the cursor reset. Unknown / in-progress / consumed / frozen
// next entries are still rejected; entries and financial facts are never modified.
//
// Proof binding: no cursor reset is trusted on hashes alone. The NATIVE proof
// reproveDurablePreparationStoppedClose(shopLike, businessDate, {stateRoot,...}) from
// run-plans.cjs is re-run BEFORE and AFTER the reset; both runs must verify the durable
// preparation-stopped close, the shop/account identity, strict zero consumption, and
// return paths (stateFile/attemptsFile/publishedFile) that EXACTLY match the paths
// passed here. expectedStateSha is only the pre-CAS surface for the state file bytes
// themselves; it does NOT by itself prove the closure stays stable across the cursor
// change — the after-reset native re-proof does.
//
// Locks: the scheduler ledger lock (JSON {pid,at}, acquireProcessLock) and the
// publisher lock (JSON {pid,startedAt,token} with recovery semantics, run-plans
// acquireLock) have DIFFERENT native formats and takeover rules. This repair NEVER
// parses or steals either format on its own: if either lock file already exists it
// refuses upfront with zero writes, and acquisition is delegated to the two native
// functions only (an EEXIST race still yields busy/error, never a takeover).
//
// CLI (run by main only):
//   node repair-day-start.cjs --stateFile <abs> --ledgerFile <abs> --publishedFile <abs> \
//     --attemptsFile <abs> --stateRoot <abs> --businessDate YYYY-MM-DD --shopId <id> \
//     --shopName <name> --accountId <id> --expectedStateSha <64hex> --backupRoot <abs> \
//     [--schedulerPath <abs>] [--publisherLockFile <abs>] [--expectedPlanNumber 2] [--verifyOnly]

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const wf = require('./plan-workflow.cjs');

function sha256Hex(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function deny(reason, extra) {
  return { ok: false, repaired: false, stateWrites: 0, reason, ...(extra || {}) };
}

const ABS = v => typeof v === 'string' && v.trim() !== '' && path.isAbsolute(v);

// Production-path fix: the real standalone publisher has NO sibling bill-manager, so
// the scheduler/run-plans modules are resolved lazily at INVOCATION time only — an
// explicit caller path (main passes the real app module path) first, then the known
// isolation-tree candidate. require-time side effects stay zero for this module.
function loadSchedulerModule(o) {
  if (o.deps && o.deps.scheduler) return o.deps.scheduler;
  const candidates = [];
  if (typeof o.schedulerPath === 'string' && o.schedulerPath.trim() !== '') candidates.push(path.resolve(o.schedulerPath));
  candidates.push(path.join(__dirname, '..', 'bill-manager', 'promo-plan-scheduler.js'));
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* try next candidate */ }
  }
  return null;
}
function loadRunPlansModule(o) {
  if (o.deps && o.deps.runPlans) return o.deps.runPlans;
  const candidates = [];
  if (typeof o.runPlansPath === 'string' && o.runPlansPath.trim() !== '') candidates.push(path.resolve(o.runPlansPath));
  candidates.push(path.join(__dirname, 'run-plans.cjs'));
  for (const c of candidates) {
    try { return require(c); } catch (_) { /* try next candidate */ }
  }
  return null;
}

// Ledger criteria shared by the pre-lock preview and the under-lock re-read (the
// pre-lock view can go stale, so the exact same binding is re-proven under lock).
// prior plans (1..N-1): status 'success' REQUIRED; consumed CID / nonce / frozen on a
// prior SUCCESS entry is retained history, NOT open consumption (never rejected).
// plan N: absent, or the exact resolved preparation-stopped close of the CURRENT
// active (runId + reason + plan number, no consumption artifacts). Anything else —
// unknown / in-progress / consumed / frozen / foreign runId — refuses.
function validateLedgerForRepair(rec, expectedPlanNumber, activeRunId, activeReason) {
  if (!rec || typeof rec !== 'object') return 'ledger-record-missing';
  if (rec.status !== 'unsubmitted') return 'ledger-status-not-unsubmitted';
  const entries = rec.entries || {};
  for (const key of Object.keys(entries)) {
    if (!/^\d+$/.test(key) || Number(key) < 1 || Number(key) > expectedPlanNumber) {
      return 'ledger-entry-key-out-of-scope:' + key;
    }
  }
  for (let n = 1; n < expectedPlanNumber; n++) {
    const e = entries[String(n)];
    if (!e) return 'ledger-prior-plan-entry-missing:' + n;
    if (e.status !== 'success') return 'ledger-prior-entry-not-success:' + n;
  }
  const next = entries[String(expectedPlanNumber)];
  if (next) {
    if (next.status !== 'preparation-stopped') return 'ledger-next-entry-not-resolved-closed:' + next.status;
    if (Number(next.planNumber) !== expectedPlanNumber) return 'ledger-next-entry-plan-number-mismatch';
    const nextRunId = String(next.preparationRunId != null ? next.preparationRunId : (next.runId != null ? next.runId : ''));
    if (nextRunId !== String(activeRunId)) return 'ledger-next-entry-run-id-mismatch';
    if (String(next.reason || '') !== String(activeReason)) return 'ledger-next-entry-reason-mismatch';
    if (next.confirmationId != null || next.planId != null || next.manifestHash != null || next.nonce != null || next.frozen) {
      return 'ledger-next-entry-open-consumption';
    }
  }
  if (rec.confirmationId != null || rec.frozen || rec.nonce != null) return 'ledger-record-open-consumption';
  return null; // criteria hold
}

/**
 * Testable core. All writes stay inside the passed stateFile directory and backupRoot.
 * opts (paths ABSOLUTE):
 *  - stateFile, ledgerFile, publishedFile, attemptsFile, stateRoot, backupRoot,
 *    businessDate, shopId (ledger key), shopName (native-proof shop), accountId,
 *    expectedStateSha (sha256 hex of the CURRENT exact state bytes), expectedPlanNumber
 *    (default 2), verifyOnly (default false), nowMs (default Date.now),
 *    lockStaleMs (default 30min), schedulerPath / runPlansPath (optional explicit
 *    module paths — production control plane only), publisherLockFile (optional abs),
 *    deps { scheduler, runPlans, onLocksAcquired, onStateWritten } for tests.
 *    onLocksAcquired / onStateWritten are invocation-only test seams: they can inject
 *    concurrent drift to exercise the fail-closed paths, but they never relax a check.
 * Returns metadata only (counts/hashes/booleans); never data or credential values.
 */
function planDayStartRepair(opts) {
  const o = opts || {};
  if (!ABS(o.stateFile) || !ABS(o.ledgerFile) || !ABS(o.publishedFile) || !ABS(o.attemptsFile)
    || !ABS(o.stateRoot) || !ABS(o.backupRoot)) {
    return deny('paths-must-be-absolute');
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(o.businessDate || ''))) return deny('business-date-invalid');
  if (typeof o.shopId !== 'string' || o.shopId.trim() === '') return deny('shop-id-missing');
  if (typeof o.shopName !== 'string' || o.shopName.trim() === '') return deny('shop-name-missing');
  if (typeof o.accountId !== 'string' || o.accountId.trim() === '') return deny('account-id-missing');
  if (!/^[0-9a-f]{64}$/.test(String(o.expectedStateSha || ''))) return deny('expected-state-sha-invalid');
  const expectedPlanNumber = Number.isInteger(o.expectedPlanNumber) ? o.expectedPlanNumber : 2;
  const verifyOnly = o.verifyOnly === true;
  const nowMs = typeof o.nowMs === 'function' ? o.nowMs : () => Date.now();
  const lockStaleMs = Number.isFinite(o.lockStaleMs) && o.lockStaleMs > 0 ? o.lockStaleMs : 30 * 60 * 1000;

  const scheduler = loadSchedulerModule(o);
  if (!scheduler || typeof scheduler.acquireProcessLock !== 'function'
    || typeof scheduler.releaseProcessLock !== 'function' || typeof scheduler.loadLedger !== 'function') {
    return deny('scheduler-module-unresolvable');
  }
  const runPlans = loadRunPlansModule(o);
  const reprove = runPlans && runPlans.reproveDurablePreparationStoppedClose;
  const acquirePublisherLock = runPlans && runPlans.acquireLock;
  if (typeof reprove !== 'function' || typeof acquirePublisherLock !== 'function') {
    return deny('run-plans-module-unresolvable');
  }

  // NATIVE proof runner: the proof must verify the durable close, the identity, the
  // zero consumption, and must have resolved EXACTLY the paths passed in here.
  const samePath = (a, b) => path.resolve(String(a)) === path.resolve(String(b));
  const nativeProof = (label) => {
    let p;
    try {
      p = reprove({ shop: String(o.shopName), accountId: String(o.accountId) }, String(o.businessDate), {
        stateRoot: String(o.stateRoot), planNumber: expectedPlanNumber,
      });
    } catch (e) {
      return { ok: false, reason: label + '-native-proof-threw:' + ((e && e.message) || 'unknown') };
    }
    if (!p || p.ok !== true || p.status !== 'preparationClosed') {
      return { ok: false, reason: label + '-native-proof-refused:' + ((p && p.reason) || 'no-result') };
    }
    if (Number(p.planNumber) !== expectedPlanNumber) return { ok: false, reason: label + '-native-proof-plan-number-mismatch' };
    if (String(p.runId || '') !== String(activeRunId)) return { ok: false, reason: label + '-native-proof-run-id-mismatch' };
    if (!samePath(p.stateFile, o.stateFile) || !samePath(p.attemptsFile, o.attemptsFile)
      || !samePath(p.publishedFile, o.publishedFile)) {
      return { ok: false, reason: label + '-native-proof-path-mismatch' };
    }
    return { ok: true, sourceHash: p.sourceHash, zeroConsumptionProof: p.zeroConsumptionProof, closedAt: p.closedAt || null };
  };

  // 1) read the exact current state bytes + CAS against the caller-proven hash
  let stateBytes;
  try { stateBytes = fs.readFileSync(o.stateFile); }
  catch (e) { return deny('state-unreadable:' + ((e && e.code) || 'unknown')); }
  const beforeSha = sha256Hex(stateBytes);
  if (beforeSha !== String(o.expectedStateSha)) {
    return deny('state-hash-cas-mismatch', { beforeSha });
  }
  let state;
  try { state = JSON.parse(stateBytes.toString('utf8')); }
  catch (_) { return deny('state-invalid-json'); }
  if (state.businessDate !== String(o.businessDate)) return deny('state-not-current-business-date');
  if (!state.active || state.active.status !== 'preparation-stopped') {
    return deny('active-not-preparation-stopped');
  }
  if (Number(state.active.planNumber) !== expectedPlanNumber) return deny('active-plan-number-mismatch');
  const activeRunId = String(state.active.runId || '');
  if (activeRunId === '') return deny('active-run-id-missing');
  const activeReason = String(state.active.reason || '');

  // 2) NATIVE durable-close proof BEFORE any lock/write
  const proofBefore = nativeProof('before');
  if (!proofBefore.ok) return deny(proofBefore.reason, { stateWrites: 0 });

  // 3) frozen companions the repair must preserve byte-exactly (ledger is re-read as
  //    bytes under the lock too, not just the parsed record)
  const ledgerBytes0 = fs.readFileSync(o.ledgerFile);
  const publishedBytes0 = fs.readFileSync(o.publishedFile);
  const attemptsBytes0 = fs.readFileSync(o.attemptsFile);

  const checkLedgerFile = () => {
    const ledger = scheduler.loadLedger(o.ledgerFile);
    if (ledger.corrupt) return 'ledger-corrupt-fail-closed';
    const rec = ledger.days && ledger.days[o.businessDate] && ledger.days[o.businessDate].shops
      && ledger.days[o.businessDate].shops[o.shopId];
    if (!rec) return 'ledger-no-shop-day-record';
    const bad = validateLedgerForRepair(rec, expectedPlanNumber, activeRunId, activeReason);
    if (bad) return bad;
    // plans counter must count ONLY actual successes — a failed/preparation-stopped
    // plan is NOT a success and must never count toward the daily goal.
    const successCount = Object.keys(rec.entries || {})
      .filter(k => rec.entries[k] && rec.entries[k].status === 'success').length;
    if (Number(rec.plans) !== successCount) {
      return 'ledger-plans-count-drift';
    }
    return null;
  };
  const ledgerProblem = checkLedgerFile();
  if (ledgerProblem) return deny(ledgerProblem);

  // 4) build the repaired state: ONLY the three browse fields move to newDayState defaults
  const fresh = wf.newDayState(String(o.businessDate));
  const repaired = { ...state, page: fresh.page, category: fresh.category, cursor: fresh.cursor };
  const repairedBytes = Buffer.from(JSON.stringify(repaired, null, 2), 'utf8');
  const afterSha = sha256Hex(repairedBytes);

  if (verifyOnly) {
    return {
      ok: true, repaired: false, verifyOnly: true, stateWrites: 0, beforeSha,
      afterShaPreview: afterSha, proofSourceHashBefore: proofBefore.sourceHash,
    };
  }

  // 5) locks — refuse ANY existing lock file upfront (never parse/steal either native
  //    format), then acquire through the two NATIVE functions only.
  const ledgerLockFile = o.ledgerFile + '.lock';
  const publisherLockFile = o.publisherLockFile
    ? (ABS(o.publisherLockFile) ? o.publisherLockFile : null)
    : null;
  if (o.publisherLockFile && !publisherLockFile) return deny('publisher-lock-path-not-absolute');
  if (fs.existsSync(ledgerLockFile)) return deny('ledger-lock-file-exists-refuse', { stateWrites: 0 });
  if (publisherLockFile && fs.existsSync(publisherLockFile)) return deny('publisher-lock-file-exists-refuse', { stateWrites: 0 });

  const held = [];
  const releaseAll = () => {
    for (let i = held.length - 1; i >= 0; i--) {
      const h = held[i];
      try {
        if (h.kind === 'publisher') { if (typeof h.release === 'function') h.release(); }
        else scheduler.releaseProcessLock(h.file, h.token);
      } catch (_) { /* release failure is left to the stale-lock recovery owners */ }
    }
  };
  try {
    const ledgerLock = scheduler.acquireProcessLock(ledgerLockFile, nowMs, lockStaleMs);
    if (!ledgerLock.held) {
      return deny('ledger-lock-busy:' + ledgerLockFile, { busy: true, error: ledgerLock.error || null });
    }
    held.push({ kind: 'ledger', file: ledgerLockFile, token: ledgerLock.token });
    let publisherRelease = null;
    if (publisherLockFile) {
      try {
        publisherRelease = acquirePublisherLock(publisherLockFile); // native: throws on any existing/racy owner
      } catch (e) {
        return deny('publisher-lock-busy:' + publisherLockFile, { error: (e && e.message) || String(e) });
      }
      held.push({ kind: 'publisher', file: publisherLockFile, release: publisherRelease });
    }

    // Test seam: injected drift must land BEFORE the under-lock re-reads so the CAS
    // re-check can actually observe it (native callers without the hook are unchanged).
    if (typeof (o.deps && o.deps.onLocksAcquired) === 'function') {
      try { o.deps.onLocksAcquired(); } catch (_) { /* test seam only */ }
    }

    // 6) under-lock re-validation: pre-lock previews go stale, so EVERY surface is
    //    re-read and re-proven here before any write.
    let freshBytes;
    try { freshBytes = fs.readFileSync(o.stateFile); }
    catch (e) { return deny('state-reread-failed:' + ((e && e.code) || 'unknown')); }
    if (sha256Hex(freshBytes) !== String(o.expectedStateSha)) {
      return deny('state-changed-under-lock-cas-fail', { stateWrites: 0 });
    }
    if (sha256Hex(fs.readFileSync(o.ledgerFile)) !== sha256Hex(ledgerBytes0)) {
      return deny('ledger-changed-under-lock', { stateWrites: 0 });
    }
    if (sha256Hex(fs.readFileSync(o.publishedFile)) !== sha256Hex(publishedBytes0)) {
      return deny('published-book-changed-under-lock', { stateWrites: 0 });
    }
    if (sha256Hex(fs.readFileSync(o.attemptsFile)) !== sha256Hex(attemptsBytes0)) {
      return deny('attempts-changed-under-lock', { stateWrites: 0 });
    }
    const ledgerProblemUnderLock = checkLedgerFile();
    if (ledgerProblemUnderLock) return deny('under-lock-' + ledgerProblemUnderLock, { stateWrites: 0 });
    const proofLocked = nativeProof('locked');
    if (!proofLocked.ok) return deny(proofLocked.reason, { stateWrites: 0 });

    // 7) backup the EXACT original bytes into the explicit report backupRoot
    fs.mkdirSync(o.backupRoot, { recursive: true });
    const backupFile = path.join(o.backupRoot, 'plan-publisher-state-before-browse-repair-' + beforeSha.slice(0, 16) + '.json');
    const backupTmp = backupFile + '.tmp';
    fs.writeFileSync(backupTmp, stateBytes);
    fs.renameSync(backupTmp, backupFile);

    // 8) atomic tmp + rename
    const tmp = o.stateFile + '.tmp';
    fs.writeFileSync(tmp, repairedBytes);
    fs.renameSync(tmp, o.stateFile);
    const readback = fs.readFileSync(o.stateFile);
    if (sha256Hex(readback) !== afterSha) {
      const rollbackTmp = o.stateFile + '.tmp';
      fs.writeFileSync(rollbackTmp, stateBytes);
      fs.renameSync(rollbackTmp, o.stateFile);
      return deny('write-verification-failed-rolled-back', { stateWrites: 0, backupFile });
    }

    if (typeof (o.deps && o.deps.onStateWritten) === 'function') {
      try { o.deps.onStateWritten(); } catch (_) { /* test seam only */ }
    }

    // 9) post-write proof: ledger / attempts / published bytes unchanged AND the
    //    NATIVE closure proof still verifies AFTER the cursor reset. Any failure here
    //    rolls the state back to the exact original bytes — but ONLY while the on-disk
    //    bytes are still ours; a foreign concurrent write is reported, never overwritten.
    const failAfterWrite = (reason) => {
      const now = fs.readFileSync(o.stateFile);
      if (sha256Hex(now) === afterSha) {
        const rollbackTmp = o.stateFile + '.tmp';
        fs.writeFileSync(rollbackTmp, stateBytes);
        fs.renameSync(rollbackTmp, o.stateFile);
        return deny(reason, { stateWrites: 0, rolledBack: true, backupFile });
      }
      return deny(reason + ':foreign-drift-no-rollback', { stateWrites: 1, rolledBack: false, backupFile });
    };
    if (sha256Hex(fs.readFileSync(o.ledgerFile)) !== sha256Hex(ledgerBytes0)) {
      return failAfterWrite('ledger-drifted-after-repair');
    }
    if (sha256Hex(fs.readFileSync(o.attemptsFile)) !== sha256Hex(attemptsBytes0)) {
      return failAfterWrite('attempts-drifted-after-repair');
    }
    if (sha256Hex(fs.readFileSync(o.publishedFile)) !== sha256Hex(publishedBytes0)) {
      return failAfterWrite('published-book-drifted-after-repair');
    }
    const proofAfter = nativeProof('after');
    if (!proofAfter.ok) return failAfterWrite(proofAfter.reason);

    return {
      ok: true, repaired: true, stateWrites: 1,
      businessDate: String(o.businessDate), shopId: String(o.shopId),
      beforeSha, afterSha, backupFile,
      changedFields: ['page', 'category', 'cursor'],
      proofSourceHashBefore: proofBefore.sourceHash,
      proofSourceHashAfter: proofAfter.sourceHash,
    };
  } finally {
    releaseAll();
  }
}

// ── CLI (main invokes; require-time side effects: none) ─────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (key === 'verifyOnly') { out.verifyOnly = true; continue; }
    if (next !== undefined && !next.startsWith('--')) { out[key] = next; i++; }
  }
  return out;
}

function main(argv) {
  const a = parseArgs(argv || process.argv);
  const result = planDayStartRepair({
    stateFile: a.stateFile,
    ledgerFile: a.ledgerFile,
    publishedFile: a.publishedFile,
    attemptsFile: a.attemptsFile,
    stateRoot: a.stateRoot,
    publisherLockFile: a.publisherLockFile,
    schedulerPath: a.schedulerPath,
    runPlansPath: a.runPlansPath,
    backupRoot: a.backupRoot,
    businessDate: a.businessDate,
    shopId: a.shopId,
    shopName: a.shopName || a.shopId,
    accountId: a.accountId,
    expectedStateSha: a.expectedStateSha,
    expectedPlanNumber: a.expectedPlanNumber != null ? Number(a.expectedPlanNumber) : undefined,
    verifyOnly: a.verifyOnly === true,
  });
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exitCode = result.ok ? 0 : 2;
  return result;
}

if (require.main === module) main(process.argv);

module.exports = { planDayStartRepair, parseArgs, sha256Hex, validateLedgerForRepair };
