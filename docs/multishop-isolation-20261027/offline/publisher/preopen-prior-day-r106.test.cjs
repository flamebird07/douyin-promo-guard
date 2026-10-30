'use strict';
// S106/S108 offline verification (Root runs it; nothing here is executed by the worker).
// No network, no browser, no real config/cookies, no main()/start.
//   node --test preopen-prior-day-r106.test.cjs
//
// Focus — the cross-day pre-open proof fix: proveNoPublicationPreOpen must ACCEPT a strictly
// earlier, FULLY CLOSED prior-day store (real shipped shape from reference/actual-prior-day-shape)
// as independent proof of ZERO publication on the CURRENT day, and must keep refusing everything
// else (unclosed old day / current-day trace / unresolved / conflict / future / missing date /
// ambiguity). The date difference by itself is never the proof; positive structural closure is.
// Every test drives the REAL exported functions over REAL OS-temp files. The store is read-only:
// each case also asserts the prior success + all nonce/CID bytes stay untouched.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rp = require('./run-plans.cjs');
const wf = require('./plan-workflow.cjs');

const PRIOR = '2026-10-16';   // the real closed business day (state store still carries it)
const TODAY = '2026-10-17';   // the current business day whose zero publication we prove
const FUTURE = '2026-10-18';
const ACCOUNT = '1710242295996424';
const SHOP = '锦年服饰测试店';
const RUN_PRIOR = 'plan-scheduler-' + PRIOR + '-0123456789abcdef';
const PLAN_IDS = ['1696101600000001', '1696101600000002', '1696101600000003'];
const PRODUCTS = Array.from({ length: 30 }, (_, i) => '38450000000000' + String(i).padStart(2, '0'));
const FREEZE_AT = Date.parse(PRIOR + 'T03:00:00.000Z');

function frozenFor(i) {
  return wf.freezePlan({
    planNumber: i, runId: RUN_PRIOR, businessDate: PRIOR, accountId: ACCOUNT,
    roi: 15, dailyBudget: 300, commissionIncluded: true, directPay: false,
    boundAccounts: ['79863866'], productIds: PRODUCTS.slice(),
    planName: SHOP + '-' + PRIOR + '-' + i,
  }, { nowMs: FREEZE_AT, confirmationId: 'conf-prior-' + i, nonce: 'nonce-prior-' + i });
}

// The REAL shipped prior-day shape (mirrors reference/actual-prior-day-shape.json):
// plans entries carry status/planNumber/manifestHash and NO reliable businessDate (null in the
// real store); active is the terminal published-success with a self-consistent frozen
// (confirmationId/nonce/manifestHash/accountId) and recovery fields; attempts carry success
// consumptions keyed by confirmationId plus older history days (incl. a terminal failed).
function buildStore(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r106-store-'));
  const stateFile = path.join(dir, 'plan-publisher-state.json');
  const attemptsFile = path.join(dir, 'plan-publication-attempts.json');
  const frozens = [null, frozenFor(1), frozenFor(2), frozenFor(3)];
  const plansCount = o.plansCount || 3;
  const plans = [];
  const consumed = {};
  const finalConsumed = {};
  for (let i = 1; i <= plansCount; i += 1) {
    const f = frozens[i];
    plans.push({ planNumber: i, status: 'success', planId: PLAN_IDS[i - 1], manifestHash: f.manifestHash, businessDate: null });
    consumed[f.confirmationId] = { planNumber: i, runId: RUN_PRIOR, businessDate: PRIOR, manifestHash: f.manifestHash, status: 'success', at: PRIOR + 'T03:1' + i + ':00.000Z' };
    finalConsumed[f.confirmationId] = { planNumber: i, runId: RUN_PRIOR, businessDate: PRIOR, manifestHash: f.manifestHash, status: 'success', at: PRIOR + 'T03:2' + i + ':00.000Z' };
  }
  // older terminal history (must never block, must never be rewritten):
  consumed['conf-old-11-1'] = { planNumber: 1, runId: 'run-old', businessDate: '2026-10-11', manifestHash: 'ab'.repeat(32), status: 'success', at: '2026-10-11T03:00:00.000Z' };
  consumed['conf-old-15-1'] = { planNumber: 1, runId: 'run-old15', businessDate: '2026-10-15', manifestHash: 'cd'.repeat(32), status: 'failed', at: '2026-10-15T03:00:00.000Z', resolution: { kind: 'expired-known-final-unsubmitted' } };
  // older FINAL terminal failure with a known resolution — real shape carries such records and
  // they must never cause the whole prior-day proof to be refused.
  finalConsumed['conf-old-15-1'] = { planNumber: 1, runId: 'run-old15', businessDate: '2026-10-15', manifestHash: 'cd'.repeat(32), status: 'failed', at: '2026-10-15T03:30:00.000Z', resolution: { kind: 'expired-known-final-unsubmitted' } };
  const state = {
    businessDate: PRIOR,
    unknown: false,
    pending: false,
    runId: RUN_PRIOR,
    active: {
      status: 'published-success', planNumber: plansCount, planId: PLAN_IDS[plansCount - 1],
      frozen: frozens[plansCount], authorizedBy: 'recurring-user-policy',
      postPublishEnable: { status: 'unknown-current-state' }, actionTaken: false,
      recoveredBy: null, recoveredAt: null,
    },
    plans,
    firstPublishedPlan: null,
    lastSelected: PRODUCTS.slice(),
    confirmationConsumptions: [],
    manualUiPublicationFacts: [],
  };
  const attempts = { consumed, finalConsumed, reopenConsumed: {} };
  if (o.mutateState) o.mutateState(state);
  if (o.mutateAttempts) o.mutateAttempts(attempts);
  if (o.noAttemptsFile !== true) fs.writeFileSync(attemptsFile, JSON.stringify(attempts, null, 2));
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
  return { dir, stateFile, attemptsFile, frozens };
}

function prove(store, businessDate, scope) {
  return rp.proveNoPublicationPreOpen(store.stateFile, store.attemptsFile, businessDate || TODAY,
    scope === undefined ? { planNumber: 1, accountId: ACCOUNT, shop: SHOP } : scope);
}
function assertReadOnly(store, beforeState, beforeAttempts) {
  assert.equal(fs.readFileSync(store.stateFile, 'utf8'), beforeState, 'prior store state bytes untouched (success + nonce/CID preserved)');
  if (beforeAttempts !== null) assert.equal(fs.readFileSync(store.attemptsFile, 'utf8'), beforeAttempts, 'prior store attempts bytes untouched');
}

// ── 1) the REAL closed prior-day shape proves TODAY's zero publication ────────
test('prior-day closure: real shipped closed shape proves current-day zero publication (read-only)', () => {
  const store = buildStore();
  const stBefore = fs.readFileSync(store.stateFile, 'utf8');
  const atBefore = fs.readFileSync(store.attemptsFile, 'utf8');
  const r = prove(store, TODAY);
  assert.equal(r.ok, true, JSON.stringify(r.reason));
  assert.equal(r.proof.method, 'pre-navigation-open-failed');
  assert.equal(r.proof.businessDate, TODAY);
  assert.equal(r.proof.opened, false);
  assert.equal(r.proof.stateProven, true);
  assert.equal(r.proof.attemptsProven, true);
  assert.equal(r.proof.shop, SHOP);
  assert.equal(r.proof.accountId, ACCOUNT);
  assert.equal(r.proof.planNumber, 1);
  assert.match(r.proof.sourceHash, /^[0-9a-f]{64}$/);
  assert.ok(r.proof.priorDayClosure, 'read-back closure annotation present');
  assert.equal(r.proof.priorDayClosure.sourceBusinessDate, PRIOR);
  assert.deepEqual(r.proof.priorDayClosure.planNumbers, [1, 2, 3]);
  assertReadOnly(store, stBefore, atBefore);
  // the closure echoes stay INSIDE the original store untouched:
  const st = JSON.parse(fs.readFileSync(store.stateFile, 'utf8'));
  assert.equal(st.active.status, 'published-success');
  assert.equal(st.active.frozen.nonce, 'nonce-prior-3', 'nonce preserved');
  assert.equal(st.active.frozen.confirmationId, 'conf-prior-3', 'CID preserved');
  fs.rmSync(store.dir, { recursive: true, force: true });
});

test('prior-day closure: unscoped whole-day proof still works from the closed old store', () => {
  const store = buildStore();
  const r = prove(store, TODAY, null);
  assert.equal(r.ok, true, JSON.stringify(r.reason));
  assert.equal(r.proof.planNumber, null);
  fs.rmSync(store.dir, { recursive: true, force: true });
});

test('prior-day closure: same-day proof path is unchanged (missing file and pre-consumption active)', () => {
  const store = buildStore({ noAttemptsFile: true, mutateState: (s) => { s.businessDate = TODAY; s.active = { status: 'pending' }; s.plans = []; } });
  const r = prove(store, TODAY);
  assert.equal(r.ok, true, JSON.stringify(r.reason));
  assert.equal(r.proof.priorDayClosure, undefined, 'same-day proof carries no closure annotation');
  fs.rmSync(store.dir, { recursive: true, force: true });
});

// ── 2) proveSchedulerReleaseProof binds the closed prior-day store to the current entry ──
function seedLedger(dir, recs, shopKey) {
  const file = path.join(dir, 'scheduler-ledger.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, days: { [TODAY]: { shops: { [shopKey]: recs } } } }, null, 2));
  return file;
}
const JIN_REC = () => ({
  status: 'failed', plans: 0, lastAt: TODAY + 'T00:00:00.000Z',
  error: 'scheduled-run-exception:登录失效',
  entries: { '1': { planNumber: 1, status: 'failed', reason: 'scheduled-run-exception:登录失效', at: TODAY + 'T00:00:00.000Z' } },
});

test('release proof: failed record + failed entry 1 releases via the ONLY scheduler protocol', () => {
  const store = buildStore();
  const ledgerFile = seedLedger(store.dir, JIN_REC(), SHOP);
  const r = rp.proveSchedulerReleaseProof(ledgerFile, { stateFile: store.stateFile, attemptsFile: store.attemptsFile },
    { businessDate: TODAY, shop: SHOP, planNumber: 1, accountId: ACCOUNT });
  assert.equal(r.ok, true, JSON.stringify(r.reason));
  assert.equal(r.proof.status, 'scheduler-release-prepublication');
  assert.equal(r.proof.recStatus, 'failed');
  assert.equal(r.proof.entryStatus, 'failed');
  assert.equal(r.proof.entryReasonHash, rp.sha256Hex('scheduled-run-exception:登录失效'));
  assert.equal(r.proof.publicationProof.businessDate, TODAY);
  assert.equal(r.proof.publicationProof.priorDayClosure.sourceBusinessDate, PRIOR);
  assert.match(r.proof.sourceHash, /^[0-9a-f]{64}$/);
  assert.equal(r.proof.sourceStateFile, store.stateFile);
  fs.rmSync(store.dir, { recursive: true, force: true });
});

test('release proof negatives: terminal-success record / unknown entry / no entry all refuse', () => {
  const base = buildStore();
  // A terminal-success record must carry its own entry: otherwise the shape gate would first hit
  // release-no-current-entry and never exercise the record-status refusal this case is about.
  let ledgerFile = seedLedger(base.dir, {
    status: 'success', plans: 3, error: null,
    entries: { '1': { planNumber: 1, status: 'success', reason: null, at: TODAY + 'T00:00:00.000Z' } },
  }, SHOP);
  let r = rp.proveSchedulerReleaseProof(ledgerFile, { stateFile: base.stateFile, attemptsFile: base.attemptsFile },
    { businessDate: TODAY, shop: SHOP, planNumber: 1, accountId: ACCOUNT });
  assert.equal(r.ok, false);
  assert.match(r.reason, /release-record-not-terminal-failure/);
  ledgerFile = seedLedger(base.dir, { status: 'failed', plans: 0, entries: { '1': { planNumber: 1, status: 'unknown', reason: 'publish-unknown', at: TODAY } }, error: 'x' }, SHOP);
  r = rp.proveSchedulerReleaseProof(ledgerFile, { stateFile: base.stateFile, attemptsFile: base.attemptsFile },
    { businessDate: TODAY, shop: SHOP, planNumber: 1, accountId: ACCOUNT });
  assert.equal(r.ok, false);
  assert.match(r.reason, /release-entry-not-prepublication:unknown/);
  ledgerFile = seedLedger(base.dir, { status: 'failed', plans: 0, entries: {}, error: 'x' }, SHOP);
  r = rp.proveSchedulerReleaseProof(ledgerFile, { stateFile: base.stateFile, attemptsFile: base.attemptsFile },
    { businessDate: TODAY, shop: SHOP, planNumber: 1, accountId: ACCOUNT });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'release-no-current-entry');
  fs.rmSync(base.dir, { recursive: true, force: true });
});

// ── 3) the refusal matrix: date difference ALONE never proves — every gap stays refused ──
function refusedCase(label, buildOpts, scope, expectedReason) {
  const store = buildStore(buildOpts);
  try {
    const stBefore = fs.readFileSync(store.stateFile, 'utf8');
    const atBefore = fs.existsSync(store.attemptsFile) ? fs.readFileSync(store.attemptsFile, 'utf8') : null;
    const r = prove(store, TODAY, scope === undefined ? { planNumber: 1, accountId: ACCOUNT, shop: SHOP } : scope);
    assert.equal(r.ok, false, label + ' must refuse');
    if (expectedReason instanceof RegExp) assert.match(r.reason, expectedReason, label + ' reason boundary (got ' + r.reason + ')');
    else assert.equal(r.reason, expectedReason, label + ' exact reason (got ' + r.reason + ')');
    assertReadOnly(store, stBefore, atBefore);
  } finally {
    fs.rmSync(store.dir, { recursive: true, force: true });
  }
}

test('refusals: old-day unclosed / unresolved / conflicts / current-day traces / future / corrupt stay refused', () => {
  // Every case is INDEPENDENT and ALL are executed: one wrong reason must never hide the rest.
  const cases = [
    ['old-day-active-preparing', { mutateState: (s) => { s.active = { status: 'preparing', planNumber: 3, frozen: s.active.frozen }; } }, undefined, 'proof-prior-day-unclosed'],
    ['old-day-missing-active', { mutateState: (s) => { s.active = null; } }, undefined, 'proof-prior-day-unclosed'],
    ['old-day-failed-plan-not-closed', { mutateState: (s) => { s.plans[2].status = 'failed'; } }, undefined, 'proof-prior-day-unclosed'],
    ['old-day-empty-plans', { mutateState: (s) => { s.plans = []; } }, undefined, 'proof-prior-day-unclosed'],
    ['frozen-cid-unclosed', { mutateAttempts: (a) => { delete a.consumed['conf-prior-3']; } }, undefined, 'proof-prior-day-cid-unclosed'],
    ['frozen-cid-status-mismatch', { mutateAttempts: (a) => { a.consumed['conf-prior-3'].status = 'failed'; } }, undefined, 'proof-prior-day-cid-unclosed'],
    // Changing ONE binding (planNumber) can legitimately trip either the per-plan manifest binding
    // or the CID identity binding; both are valid refusals for this one-binding mutation.
    ['frozen-cid-wrong-plan', { mutateAttempts: (a) => { a.consumed['conf-prior-3'].planNumber = 2; } }, undefined, /^proof-prior-day-(identity-mismatch|manifest-conflict)$/],
    ['frozen-cid-run-conflict', { mutateAttempts: (a) => { a.consumed['conf-prior-3'].runId = 'other-run'; } }, undefined, 'proof-prior-day-identity-mismatch'],
    ['prior-final-failed', { mutateAttempts: (a) => { a.finalConsumed['conf-prior-3'].status = 'failed'; } }, undefined, 'proof-prior-day-final-unclosed'],
    ['prior-final-binding-conflict', { mutateAttempts: (a) => { a.finalConsumed['conf-prior-3'].manifestHash = 'ee'.repeat(32); } }, undefined, 'proof-prior-day-manifest-conflict'],
    ['prior-final-run-conflict', { mutateAttempts: (a) => { a.finalConsumed['conf-prior-3'].runId = 'other-run'; } }, undefined, 'proof-prior-day-identity-mismatch'],
    ['prior-final-closure-missing', { mutateAttempts: (a) => { delete a.finalConsumed['conf-prior-3']; } }, undefined, 'proof-prior-day-final-unclosed'],
    ['non-frozen-success-final-failed', { mutateAttempts: (a) => { a.finalConsumed['conf-prior-1'].status = 'failed'; } }, undefined, 'proof-prior-day-final-unclosed'],
    ['reopen-manifest-conflict', { mutateAttempts: (a) => { a.reopenConsumed['conf-prior-3'] = { planNumber: 3, runId: RUN_PRIOR, businessDate: PRIOR, manifestHash: 'ee'.repeat(32), status: 'success', at: PRIOR }; } }, undefined, 'proof-prior-day-manifest-conflict'],
    ['reopen-foreign-plan', { mutateAttempts: (a) => { a.reopenConsumed['conf-prior-9'] = { planNumber: 9, runId: 'r', businessDate: PRIOR, manifestHash: 'ab'.repeat(32), status: 'success', at: PRIOR }; } }, undefined, 'proof-prior-day-identity-mismatch'],
    ['frozen-explicit-foreign-shop', { mutateState: (s) => { s.active.frozen.shop = '另一家测试店'; } }, undefined, 'proof-prior-day-shop-mismatch'],
    ['attempts-unresolved-pending', { mutateAttempts: (a) => { a.consumed['conf-old-x'] = { planNumber: 2, runId: 'r', businessDate: PRIOR, manifestHash: 'ef'.repeat(32), status: 'pending', at: PRIOR }; } }, undefined, 'proof-prior-day-unresolved'],
    ['attempts-unresolved-unknown-old-day', { mutateAttempts: (a) => { a.finalConsumed['conf-old-y'] = { planNumber: 1, runId: 'r', businessDate: '2026-10-11', manifestHash: 'ab'.repeat(32), status: 'unknown', at: '2026-10-11' }; } }, undefined, 'proof-prior-day-unresolved'],
    ['current-day-attempt-success-other-plan', { mutateAttempts: (a) => { a.consumed['conf-today-2'] = { planNumber: 2, runId: 'rt', businessDate: TODAY, manifestHash: 'aa'.repeat(32), status: 'success', at: TODAY }; } }, undefined, 'proof-consumption-artifacts-present'],
    ['current-day-attempt-unknown-scoped', { mutateAttempts: (a) => { a.consumed['conf-today-1'] = { planNumber: 1, runId: 'rt', businessDate: TODAY, manifestHash: 'bb'.repeat(32), status: 'unknown', at: TODAY }; } }, undefined, 'proof-attempt-record-for-date'],
    ['current-day-confirmationConsumption', { mutateState: (s) => { s.confirmationConsumptions = [{ confirmationId: 'conf-t', businessDate: TODAY, planNumber: 1 }]; } }, undefined, 'proof-consumption-artifacts-present'],
    ['current-day-manual-fact', { mutateState: (s) => { s.manualUiPublicationFacts = [{ businessDate: TODAY, planNumber: 1, status: 'published-success' }]; } }, undefined, 'proof-consumption-artifacts-present'],
    ['plan-business-date-current-day', { mutateState: (s) => { s.plans[0].businessDate = TODAY; } }, undefined, 'proof-consumption-artifacts-present'],
    ['manifest-conflict-plans-vs-attempts', { mutateAttempts: (a) => { a.consumed['conf-prior-2'].manifestHash = 'ee'.repeat(32); } }, undefined, 'proof-prior-day-manifest-conflict'],
    ['frozen-business-date-foreign', { mutateState: (s) => { s.active.frozen.businessDate = '2026-10-15'; } }, undefined, 'proof-prior-day-identity-mismatch'],
    ['frozen-plan-conflict', { mutateState: (s) => { s.active.frozen.planNumber = 2; } }, undefined, 'proof-prior-day-identity-mismatch'],
    ['frozen-nonce-missing', { mutateState: (s) => { delete s.active.frozen.nonce; } }, undefined, 'proof-prior-day-unclosed'],
    ['frozen-manifest-broken', { mutateState: (s) => { s.active.frozen.manifestHash = 'not-a-hash'; } }, undefined, 'proof-prior-day-unclosed'],
    ['account-scope-conflict', { mutateState: (s) => { s.active.frozen.accountId = '9999999999999999'; } }, undefined, 'proof-prior-day-account-mismatch'],
    ['day-unknown-flag', { mutateState: (s) => { s.unknown = true; } }, undefined, 'proof-prior-day-ambiguous'],
    ['attempts-file-missing', { noAttemptsFile: true }, undefined, 'proof-prior-day-attempts-missing'],
    ['future-dated-store', { mutateState: (s) => { s.businessDate = FUTURE; } }, undefined, 'proof-state-date-mismatch'],
    ['missing-state-date', { mutateState: (s) => { s.businessDate = null; } }, undefined, 'proof-state-malformed'],
  ];
  const failures = [];
  for (const [label, opts, scope, expected] of cases) {
    try { refusedCase(label, opts, scope, expected); }
    catch (e) { failures.push(label + ': ' + ((e && e.message) || String(e))); }
  }
  // corrupt / malformed stores (shared schema gates keep refusing exactly like the same-day path)
  const corruptCases = [
    ['state-not-json', (s) => fs.writeFileSync(s.stateFile, '{ not json'), 'proof-state-unreadable'],
    ['state-garbage', (s) => fs.writeFileSync(s.stateFile, 'this is not even close'), 'proof-state-unreadable'],
    ['attempts-array', (s) => fs.writeFileSync(s.attemptsFile, '[[1]]'), 'proof-attempts-malformed'],
    // Real shipped behavior: guard.loadAttemptsStore rejects this record shape EARLIER as an
    // unreadable attempts store; assert the true first refusal, still zero writes.
    ['attempt-record-malformed', (s) => fs.writeFileSync(s.attemptsFile, JSON.stringify({ consumed: { 'x': { planNumber: 0, businessDate: 'garbage', status: 'weird' } }, finalConsumed: {}, reopenConsumed: {} })), 'proof-attempts-unreadable'],
  ];
  for (const [label, corrupt, expected] of corruptCases) {
    try {
      const store = buildStore();
      try {
        corrupt(store);
        // zero-modification baseline AFTER the intentional corruption: prove() must never rewrite.
        const stAfterCorrupt = fs.readFileSync(store.stateFile, 'utf8');
        const atAfterCorrupt = fs.readFileSync(store.attemptsFile, 'utf8');
        const r = prove(store, TODAY);
        assert.equal(r.ok, false, label + ' must refuse');
        assert.equal(r.reason, expected, label + ' exact reason (got ' + r.reason + ')');
        assert.equal(fs.readFileSync(store.stateFile, 'utf8'), stAfterCorrupt, label + ' state bytes untouched');
        assert.equal(fs.readFileSync(store.attemptsFile, 'utf8'), atAfterCorrupt, label + ' attempts bytes untouched');
      } finally {
        fs.rmSync(store.dir, { recursive: true, force: true });
      }
    } catch (e) {
      failures.push(label + ': ' + ((e && e.message) || String(e)));
    }
  }
  assert.equal(failures.length, 0, 'refusal matrix failures (' + failures.length + '):\n' + failures.join('\n'));
});

// ── 4) sourceHash binds the exact bytes a prior-day proof read ────────────────
test('sourceHash: a later byte change on the prior store invalidates fresh re-verification', () => {
  const store = buildStore();
  const r = prove(store, TODAY);
  assert.equal(r.ok, true, JSON.stringify(r.reason));
  assert.equal(rp.currentPreOpenSourceHash(store.stateFile, store.attemptsFile), r.proof.sourceHash);
  const st = JSON.parse(fs.readFileSync(store.stateFile, 'utf8'));
  st.plans[0].planId = 'tampered000000000';
  fs.writeFileSync(store.stateFile, JSON.stringify(st, null, 2));
  assert.notEqual(rp.currentPreOpenSourceHash(store.stateFile, store.attemptsFile), r.proof.sourceHash, 'changed bytes => different hash => releaser refuses');
  fs.rmSync(store.dir, { recursive: true, force: true });
});

// ── 5) foreign-scope guard: an unbindable account scope never passes on another account's success ──
test('account scope: closure of a DIFFERENT account is never borrowed for the bound account', () => {
  const store = buildStore({ mutateState: (s) => { s.active.frozen.accountId = '8888888888888888'; } });
  const r = prove(store, TODAY, { planNumber: 1, accountId: ACCOUNT, shop: SHOP });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'proof-prior-day-account-mismatch');
  fs.rmSync(store.dir, { recursive: true, force: true });
});
