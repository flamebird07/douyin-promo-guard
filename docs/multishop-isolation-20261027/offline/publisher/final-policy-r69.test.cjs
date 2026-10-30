'use strict';
// S69 offline verification. No network, no browser, no CDP, no real config/cookies,
// no real app imports, no main()/start. Run only via:
//   node --test final-modal-r68.test.cjs final-policy-r69.test.cjs
// Everything here drives the REAL exported entries (run-plans.resumeScheduledKnownFinalOnly
// and direct-draft-controller.consumeFinalConfirmationOnce) over owned OS-temp ledgers.
// No test relies on a self-made stand-in for the code under test: the guard/resume logic
// is the shipped implementation; only the UI/manager callbacks and the trusted policy
// provider are faked, exactly as the real host would inject them.
//
// Focus (the two real S68 acceptance gaps):
//   1) The REAL provider shop shape carries `id` = the shop NAME (not the ad accountId).
//      scheduledAuthorityDrift must NOT treat shop.id as the account; identity is proven
//      strictly by shop.name / shop.accountId / enabled===true / a valid targetRoi, and a
//      MISSING identity/ROI field is never defaulted to "allowed".
//   2) The scheduled (auto) final-confirm reservation must record an INDEPENDENT strict
//      recurring-user-policy recovery context -- never a fabricated human authorization,
//      never a human field mixed in, never a fallback to the manual path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rp = require('./run-plans.cjs');
const pw = require('./plan-workflow.cjs');
const guard = require('./direct-draft-controller.cjs');

const R69_ACCOUNT = '1710242295996424'; // legacy frozen business account (public config value)
const R69_SHOP = '瑾漂亮潮流服饰';
const R69_OLD_IDS = ['900000000001', '900000000002', '900000000303'];

// A REAL trusted-provider shop row: `id` is the shop NAME (application identifier), NOT
// the ad accountId; accountId is its own field. Under the old buggy drift check the
// correct shop was rejected (id !== account); the fixed check ignores id and passes.
function realShopRow(over = {}) {
  return Object.assign({ id: R69_SHOP, name: R69_SHOP, accountId: R69_ACCOUNT, targetRoi: 15, enabled: true }, over);
}

function scheduledFixture(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r69-sched-'));
  const stateFile = path.join(dir, 'plan-publisher-state.json');
  const publishedFile = path.join(dir, 'published-products.json');
  const attemptsFile = path.join(dir, 'plan-publication-attempts.json');
  const businessDate = pw.shanghaiDate(o.now || Date.now());
  const planNumber = o.planNumber || 1;
  const productIds = Array.from({ length: 30 }, (_, i) => '38450000000000' + String(i).padStart(2, '0'));
  const base = {
    planNumber, runId: 'run-1', businessDate, accountId: R69_ACCOUNT,
    planName: businessDate + '_千川乘方_22:28:24' + (planNumber > 1 ? '_' + planNumber : ''),
    roi: 15, dailyBudget: 300,
    commissionIncluded: true, directPay: false, boundAccounts: ['79863866', '9zmao_fushi'],
    productIds, disclosures: { migration: [], precheck: [], reviewFailed: [] },
    nonce: 'nonce-1', confirmationId: 'conf-1', frozenAt: new Date().toISOString(),
  };
  const frozen = Object.assign({}, base, { manifestHash: pw.manifestHash(base) });
  const active = { status: 'publish-unknown', reason: 'unknown-or-new-final-dialog', planNumber, frozen, authorizedBy: 'recurring-user-policy' };
  pw.persistDayState(stateFile, {
    businessDate, plans: [], active, firstPublishedPlan: null, lastSelected: productIds.slice(),
    confirmationConsumptions: [], // scheduled path: manual consumption list stays EMPTY
  });
  // The initial record CARRIES runId/businessDate/planNumber/manifestHash (the shipped
  // consumePublicationOnce shape); accountId/planName are bound by the recovery context.
  fs.writeFileSync(attemptsFile, JSON.stringify({
    consumed: { 'conf-1': { planNumber, runId: 'run-1', businessDate, manifestHash: frozen.manifestHash, status: 'unknown', at: new Date().toISOString() } },
    finalConsumed: o.finalConsumed || {},
  }, null, 2));
  fs.writeFileSync(publishedFile, JSON.stringify({ publishedIds: ['old-product-1'], plans: [] }, null, 2));
  const recurringAuth = Object.assign({
    authorizedBy: 'recurring-user-policy', humanApproved: false,
    confirmationId: frozen.confirmationId, manifestHash: frozen.manifestHash, planNumber,
    businessDate, planName: frozen.planName, accountId: R69_ACCOUNT,
  }, o.recurringAuth || {});
  const recurringPolicyProvider = o.providerThrow
    ? () => { throw new Error('localhost-state-unreadable'); }
    : async () => ({
        policy: Object.assign({ enabled: true, autoConfirm: true, dailyBudget: 300, plansPerShopPerDay: 3 }, o.policy || {}),
        shop: o.shop === null ? null : (o.shopRaw !== undefined ? o.shopRaw : realShopRow(o.shop || {})),
      });
  const calls = { click: 0 };
  const creation = Object.assign({
    originOk: true, pathOk: true, accountId: R69_ACCOUNT, planName: frozen.planName,
    uniqueProductCount: 30, productRowCount: 30, productIds, eachRowHasManualAccount: true,
    rows: productIds.map(id => ({ productId: id, manualAccounts: 2 })),
    roi: '15.00', budget: '300.00',
    commissionChecked: true, optionalDirectPayChecked: false, publishButtonCount: 1,
  }, o.creation || {});
  const newPlanId = o.newPlanId || '123456789012';
  const successRow = { found: true, planName: frozen.planName, uniqueRow: true, accountId: R69_ACCOUNT, planId: newPlanId, productCount: 30, accountCount: 2, roi: 15, dailyBudget: 300, commissionIncluded: true, status: '投放中' };
  const deps = {
    nowMs: () => (o.now || Date.now()),
    stateFile, publishedFile, attemptsFile, frozen, recurringAuth, recurringPolicyProvider,
    readManagementAbsence: async () => ({ absenceConfirmed: true, absent: true, present: false, seenPlanIds: R69_OLD_IDS, accountId: R69_ACCOUNT, total: R69_OLD_IDS.length }),
    observeCreation: async () => ({ creation }),
    readFinalDialog: async () => (o.dialog === null ? null : Object.assign({ visible: true, text: pw.FINAL_EXCLUSION_TEXT, confirmTarget: { tag: 'SPAN', closestButton: true } }, o.dialog || {})),
    readManagementRow: async () => (o.postRow === null ? { found: false } : Object.assign({}, successRow, o.postRow || {})),
    clickFinalConfirm: async () => { calls.click++; return { clicked: true }; },
    readCurrentShopEnableState: async () => ({ readOk: true, enabled: true, accountId: R69_ACCOUNT }),
  };
  return { dir, deps, frozen, businessDate, calls, stateFile, publishedFile, attemptsFile, newPlanId };
}

// ── Requirement 1: the REAL provider shape (id = shop name) is ACCEPTED ──────────
test('S69 scheduled: real provider shape (id = shop NAME, not accountId) completes ONE final click', async () => {
  const f = scheduledFixture(); // realShopRow has id === name === shop, id !== account
  try {
    const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
    assert.equal(r.status, 'success');
    assert.equal(r.publishedSuccess, true);
    assert.equal(r.clicks, 1, 'exactly one final click');
    assert.equal(r.authorizedBy, 'recurring-user-policy');
    assert.equal(r.humanApproved, false);
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(r.policyAuthorizedAt));
    const st = pw.loadDayState(f.stateFile, f.businessDate);
    assert.deepEqual(st.confirmationConsumptions, [], 'no fabricated human consumption written');
    assert.equal(st.active, null);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('S69 scheduled: an id that differs from BOTH the name and the account is irrelevant to identity', async () => {
  // A provider whose internal id is an opaque app key must still be accepted when the
  // real identity fields (name/accountId/enabled/targetRoi) are correct.
  const f = scheduledFixture({ shopRaw: { id: 'app-internal-key-9931', name: R69_SHOP, accountId: R69_ACCOUNT, targetRoi: 15, enabled: true } });
  try {
    const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
    assert.equal(r.status, 'success');
    assert.equal(r.clicks, 1);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ── Requirement 1: missing / drifting identity or ROI, or provider error -> ZERO clicks ──
test('S69 scheduled: shop identity/ROI missing or drifting, or provider error, refuse with ZERO clicks', async () => {
  const cases = [
    // MISSING identity/ROI fields are never defaulted to "allowed"
    ['recurring-policy-shop-name-drift', { shopRaw: { id: R69_SHOP, accountId: R69_ACCOUNT, targetRoi: 15, enabled: true } }], // no name
    ['recurring-policy-shop-account-drift', { shopRaw: { id: R69_SHOP, name: R69_SHOP, targetRoi: 15, enabled: true } }], // no accountId
    ['recurring-policy-shop-disabled', { shopRaw: { id: R69_SHOP, name: R69_SHOP, accountId: R69_ACCOUNT, targetRoi: 15 } }], // no enabled
    ['recurring-policy-roi-drift', { shopRaw: { id: R69_SHOP, name: R69_SHOP, accountId: R69_ACCOUNT, enabled: true } }], // no targetRoi
    ['recurring-policy-shop-account-drift', { shopRaw: { id: R69_SHOP, name: R69_SHOP, accountId: '', targetRoi: 15, enabled: true } }], // empty accountId
    // DRIFTING identity/ROI
    ['recurring-policy-shop-name-drift', { shop: { name: '别的店' } }],
    ['recurring-policy-shop-account-drift', { shop: { accountId: '9999999999999999' } }],
    ['recurring-policy-shop-disabled', { shop: { enabled: false } }],
    ['recurring-policy-roi-drift', { shop: { targetRoi: '20' } }],
    ['recurring-policy-shop-missing', { shop: null }],
    ['recurring-policy-shop-deleted', { shop: { deleted: true } }],
  ];
  for (const [why, opts] of cases) {
    const f = scheduledFixture(opts);
    try {
      const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
      assert.equal(r.status, 'refused', why + ' -> refused');
      assert.equal(r.reason, 'scheduled-policy-drift-before-absence:' + why, why);
      assert.equal(r.authorizedBy, 'recurring-user-policy');
      assert.equal(r.humanApproved, false);
      assert.equal(f.calls.click, 0, why + ' performs ZERO actual clicks');
      assert.equal(r.clicks, 0);
      const att = guard.loadAttemptsStore(f.attemptsFile);
      assert.ok(!Object.prototype.hasOwnProperty.call(att.finalConsumed, 'conf-1'), why + ' leaves zero final marks');
      assert.equal(att.consumed['conf-1'].status, 'unknown', why + ' never promotes the initial');
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
  // provider exception fails closed
  const fp = scheduledFixture({ providerThrow: true });
  try {
    const r = await rp.resumeScheduledKnownFinalOnly(fp.deps);
    assert.equal(r.status, 'refused');
    assert.ok(r.reason.startsWith('scheduled-policy-drift-before-absence:recurring-policy-provider-failed:'), r.reason);
    assert.equal(fp.calls.click, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(guard.loadAttemptsStore(fp.attemptsFile).finalConsumed, 'conf-1'));
  } finally { fs.rmSync(fp.dir, { recursive: true, force: true }); }
});

// ── Requirement 2: the auto reservation record carries structured policy, NO human ──
test('S69 scheduled: the durable reservation records the structured policy context and NO human field', async () => {
  const f = scheduledFixture();
  try {
    const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
    assert.equal(r.status, 'success');
    const att = guard.loadAttemptsStore(f.attemptsFile);
    const rec = att.finalConsumed['conf-1'].recovery;
    assert.equal(rec.authorizedBy, 'recurring-user-policy');
    assert.equal(rec.humanApproved, false);
    assert.equal(rec.initialStatus, 'unknown');
    assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(rec.policyAuthorizedAt), 'real ISO policyAuthorizedAt');
    assert.equal(rec.confirmationId, 'conf-1');
    assert.equal(rec.manifestHash, f.frozen.manifestHash);
    assert.equal(rec.runId, 'run-1');
    assert.equal(rec.businessDate, f.businessDate);
    assert.equal(rec.planNumber, 1);
    assert.equal(rec.accountId, R69_ACCOUNT);
    assert.equal(rec.planName, f.frozen.planName);
    assert.ok(!Object.prototype.hasOwnProperty.call(rec, 'humanAuthorizedAt'), 'NO fabricated human authorization field');
    assert.ok(!Object.prototype.hasOwnProperty.call(rec, 'humanConfirmation'), 'NO fabricated human confirmation field');
    assert.ok(!Object.prototype.hasOwnProperty.call(rec, 'reason'), 'auto record does not reuse the manual reason key');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ── Requirement 2 (guard level): direct consumeFinalConfirmationOnce strictness ────
function guardLedger(dir, over = {}) {
  const attemptsFile = path.join(dir, 'attempts.json');
  const businessDate = pw.shanghaiDate(Date.now());
  const base = {
    planNumber: 1, runId: 'run-1', businessDate, accountId: R69_ACCOUNT,
    planName: businessDate + '_千川乘方_22:28:24', roi: 15, dailyBudget: 300,
    commissionIncluded: true, directPay: false, boundAccounts: ['79863866', '9zmao_fushi'],
    productIds: Array.from({ length: 30 }, (_, i) => '38450000000000' + String(i).padStart(2, '0')),
    disclosures: { migration: [], precheck: [], reviewFailed: [] },
    nonce: 'nonce-1', confirmationId: 'conf-1', frozenAt: new Date().toISOString(),
  };
  const manifestHash = pw.manifestHash(base);
  // This ledger's initial record CARRIES the identity fields (accountId/planName) so the
  // guard's strict "every carried field must match" rule is exercised for those too. (The
  // resume-flow fixture above uses the shipped consumePublicationOnce shape, which carries
  // only runId/businessDate/planNumber/manifestHash; there the guard binds accountId/
  // planName without a cross-check, and run-plans enforces them upstream instead.)
  const initial = Object.assign({ planNumber: 1, runId: 'run-1', businessDate, manifestHash, accountId: R69_ACCOUNT, planName: base.planName, status: 'unknown', at: new Date().toISOString() }, over);
  fs.writeFileSync(attemptsFile, JSON.stringify({ consumed: { 'conf-1': initial }, finalConsumed: {} }, null, 2));
  return { attemptsFile, businessDate, manifestHash, planName: base.planName };
}
function scheduledCtx(L, over = {}) {
  return Object.assign({
    authorizedBy: 'recurring-user-policy', humanApproved: false,
    policyAuthorizedAt: new Date().toISOString(),
    confirmationId: 'conf-1', manifestHash: L.manifestHash, runId: 'run-1',
    businessDate: L.businessDate, planNumber: 1, accountId: R69_ACCOUNT, planName: L.planName,
  }, over);
}

test('S69 guard: a valid scheduled context reserves once with structured policy recovery', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r69-guard-'));
  try {
    const L = guardLedger(dir);
    const rec = guard.consumeFinalConfirmationOnce(L.attemptsFile, 'conf-1', L.manifestHash, scheduledCtx(L));
    assert.equal(rec.status, 'pending');
    assert.equal(rec.recovery.authorizedBy, 'recurring-user-policy');
    assert.equal(rec.recovery.humanApproved, false);
    assert.equal(rec.recovery.accountId, R69_ACCOUNT);
    assert.equal(rec.recovery.planName, L.planName);
    assert.ok(!Object.prototype.hasOwnProperty.call(rec.recovery, 'humanAuthorizedAt'));
    assert.ok(!Object.prototype.hasOwnProperty.call(rec.recovery, 'humanConfirmation'));
    // strict one-shot: replay refused forever
    assert.throws(() => guard.consumeFinalConfirmationOnce(L.attemptsFile, 'conf-1', L.manifestHash, scheduledCtx(L)), /already consumed/i);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S69 guard: the auto branch rejects any human field mixed in and never falls back to manual', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r69-guard-'));
  try {
    const L = guardLedger(dir);
    // a scheduled marker carrying a human authorization string is refused outright
    assert.throws(() => guard.consumeFinalConfirmationOnce(L.attemptsFile, 'conf-1', L.manifestHash,
      scheduledCtx(L, { humanAuthorizedAt: new Date().toISOString(), humanConfirmation: '确认发布' })), /must not carry human\/manual field/i);
    assert.ok(!Object.prototype.hasOwnProperty.call(guard.loadAttemptsStore(L.attemptsFile).finalConsumed, 'conf-1'), 'nothing was reserved');
    // a scheduled marker carrying the manual reason key is refused (no silent manual path)
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'r69-guard2-'));
    try {
      const L2 = guardLedger(dir2);
      assert.throws(() => guard.consumeFinalConfirmationOnce(L2.attemptsFile, 'conf-1', L2.manifestHash,
        scheduledCtx(L2, { reason: 'unknown-or-new-final-dialog' })), /must not carry human\/manual field/i);
      assert.ok(!Object.prototype.hasOwnProperty.call(guard.loadAttemptsStore(L2.attemptsFile).finalConsumed, 'conf-1'));
    } finally { fs.rmSync(dir2, { recursive: true, force: true }); }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S69 guard: missing/malformed authorization fields on the scheduled context are refused', () => {
  const variants = [
    { humanApproved: true },                              // must be exactly false
    { policyAuthorizedAt: undefined },                    // missing ISO timestamp
    { policyAuthorizedAt: 'not-a-timestamp' },            // malformed
    { confirmationId: 'foreign-conf' },                   // identity binding mismatch
    { manifestHash: 'e'.repeat(64) },                     // manifest binding mismatch
    { runId: 'run-999' },                                 // initial scope mismatch
    { businessDate: '2020-01-01' },                       // initial scope mismatch
    { planNumber: 2 },                                    // initial scope mismatch
    { accountId: '9999999999999999' },                    // bound account drift
    { planName: '别的名字' },                              // bound planName drift
    { accountId: '' },                                    // incomplete binding
    { planName: '' },                                     // incomplete binding
  ];
  for (const over of variants) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r69-guard-bad-'));
    try {
      const L = guardLedger(dir);
      assert.throws(() => guard.consumeFinalConfirmationOnce(L.attemptsFile, 'conf-1', L.manifestHash, scheduledCtx(L, over)),
        /Scheduled recovery|binding|scope|mismatch|humanApproved|policyAuthorizedAt/i, JSON.stringify(over));
      assert.ok(!Object.prototype.hasOwnProperty.call(guard.loadAttemptsStore(L.attemptsFile).finalConsumed, 'conf-1'), 'no reservation for ' + JSON.stringify(over));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('S69 guard: a scheduled context against a dispatched initial is refused (recovery is unknown-only)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r69-guard-disp-'));
  try {
    const L = guardLedger(dir, { status: 'dispatched' });
    assert.throws(() => guard.consumeFinalConfirmationOnce(L.attemptsFile, 'conf-1', L.manifestHash, scheduledCtx(L)),
      /durably unknown/i);
    assert.ok(!Object.prototype.hasOwnProperty.call(guard.loadAttemptsStore(L.attemptsFile).finalConsumed, 'conf-1'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── Requirement 2: legacy manual context + normal dispatched path stay compatible ──
test('S69 guard: the legacy manual recovery context is unchanged and carries human metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r69-guard-manual-'));
  try {
    const L = guardLedger(dir); // initial status 'unknown'
    const at = new Date().toISOString();
    const rec = guard.consumeFinalConfirmationOnce(L.attemptsFile, 'conf-1', L.manifestHash,
      { reason: 'unknown-or-new-final-dialog', humanAuthorizedAt: at, humanConfirmation: '确认发布' });
    assert.equal(rec.status, 'pending');
    assert.equal(rec.recovery.reason, 'unknown-or-new-final-dialog');
    assert.equal(rec.recovery.humanConfirmation, '确认发布');
    assert.equal(rec.recovery.humanAuthorizedAt, at);
    assert.ok(!Object.prototype.hasOwnProperty.call(rec.recovery, 'authorizedBy'), 'manual record carries no policy authority');
    assert.ok(!Object.prototype.hasOwnProperty.call(rec.recovery, 'policyAuthorizedAt'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S69 guard: the normal dispatched path needs no recovery context and writes no recovery block', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r69-guard-normal-'));
  try {
    const L = guardLedger(dir, { status: 'dispatched' });
    const rec = guard.consumeFinalConfirmationOnce(L.attemptsFile, 'conf-1', L.manifestHash);
    assert.equal(rec.status, 'pending');
    assert.ok(!Object.prototype.hasOwnProperty.call(rec, 'recovery'), 'dispatched path records no recovery metadata');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('S69 guard: an unknown initial WITHOUT any controlled context is still refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r69-guard-none-'));
  try {
    const L = guardLedger(dir); // status 'unknown'
    assert.throws(() => guard.consumeFinalConfirmationOnce(L.attemptsFile, 'conf-1', L.manifestHash), /not durably confirmed/i);
    assert.throws(() => guard.consumeFinalConfirmationOnce(L.attemptsFile, 'conf-1', L.manifestHash, { reason: 'something-else' }), /not durably confirmed/i);
    assert.ok(!Object.prototype.hasOwnProperty.call(guard.loadAttemptsStore(L.attemptsFile).finalConsumed, 'conf-1'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
