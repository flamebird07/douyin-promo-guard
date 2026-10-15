'use strict';
// S71 offline verification (Root runs it independently; nothing here is executed by the
// worker). No network, no browser, no CDP, no real config/cookies, no main()/start.
//   node --test session-loss-r70.test.cjs
//
// Every test drives the REAL exported entries over REAL OS-temp files/ledgers:
//   * run-plans.resumeScheduledKnownFinalOnly  (the shipped scheduled final resume core)
//   * run-plans.closeExpiredScheduledKnownFinalUnsubmitted (the new S71 one-shot close)
//   * direct-draft-controller.consumePublicationOnce / loadAttemptsStore (the shipped guard)
// The only fakes are the UI/manager callbacks and the trusted host proof providers --
// exactly the injection points the real host uses. No business function is re-implemented.
//
// Focus (the two real S71 gaps):
//   1) Root date-boundary counterexample: a Shanghai-day flip DURING a provider await must
//      never reach the actual final click. The provider is awaited at three gates; a flip
//      during the 1st / 2nd / 3rd await each yields ZERO actual clicks, with the pre-consume
//      gates leaving zero marks and the post-consume gate leaving the reserved final
//      'unknown' (retained, never replayed).
//   2) The exported one-shot cross-day close of a PREVIOUS business day's stopped known-final
//      confirm that was never submitted, so a dangling old unknown cannot block the next day.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rp = require('./run-plans.cjs');
const pw = require('./plan-workflow.cjs');
const guard = require('./direct-draft-controller.cjs');

const R70_ACCOUNT = '1710242295996424'; // legacy frozen business account (public config value)
const R70_SHOP = '瑾漂亮潮流服饰';
const R70_OLD_IDS = ['900000000001', '900000000002', '900000000303'];
// Clock-independent: Shanghai has no DST, so ±24h is exactly yesterday / tomorrow.
const R70_OLD_DAY = pw.shanghaiDate(Date.now() - 24 * 3600 * 1000); // the previous business day
const R70_TWO_DAYS_AGO = pw.shanghaiDate(Date.now() - 2 * 24 * 3600 * 1000);
const R70_TODAY = pw.shanghaiDate(Date.now());
const R70_NEW_DAY = pw.shanghaiDate(Date.now() + 24 * 3600 * 1000); // the next business day
const R70_PRODUCTS = Array.from({ length: 30 }, (_, i) => '38450000000000' + String(i).padStart(2, '0'));

// ─────────────────────────────────────────────────────────────────────────────
// Fixture A — the shipped scheduled final-resume flow (S68/S69 shape, reused here).
// ─────────────────────────────────────────────────────────────────────────────
function scheduledFixture(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r71-sched-'));
  const stateFile = path.join(dir, 'plan-publisher-state.json');
  const publishedFile = path.join(dir, 'published-products.json');
  const attemptsFile = path.join(dir, 'plan-publication-attempts.json');
  const businessDate = pw.shanghaiDate(o.now || Date.now());
  const planNumber = o.planNumber || 1;
  const base = {
    planNumber, runId: 'run-1', businessDate, accountId: R70_ACCOUNT,
    planName: businessDate + '_千川乘方_22:28:24' + (planNumber > 1 ? '_' + planNumber : ''),
    roi: 15, dailyBudget: 300,
    commissionIncluded: true, directPay: false, boundAccounts: ['79863866', '9zmao_fushi'],
    productIds: R70_PRODUCTS.slice(), disclosures: { migration: [], precheck: [], reviewFailed: [] },
    nonce: 'nonce-1', confirmationId: 'conf-1', frozenAt: new Date().toISOString(),
  };
  const frozen = Object.assign({}, base, { manifestHash: pw.manifestHash(base) });
  const active = { status: 'publish-unknown', reason: 'unknown-or-new-final-dialog', planNumber, frozen, authorizedBy: 'recurring-user-policy' };
  pw.persistDayState(stateFile, {
    businessDate, plans: [], active, firstPublishedPlan: null, lastSelected: R70_PRODUCTS.slice(),
    confirmationConsumptions: [], // scheduled path: manual consumption list stays EMPTY
  });
  fs.writeFileSync(attemptsFile, JSON.stringify({
    consumed: { 'conf-1': { planNumber, runId: 'run-1', businessDate, manifestHash: frozen.manifestHash, status: 'unknown', at: new Date().toISOString() } },
    finalConsumed: o.finalConsumed || {},
  }, null, 2));
  fs.writeFileSync(publishedFile, JSON.stringify({ publishedIds: ['old-product-1'], plans: [] }, null, 2));
  const recurringAuth = Object.assign({
    authorizedBy: 'recurring-user-policy', humanApproved: false,
    confirmationId: frozen.confirmationId, manifestHash: frozen.manifestHash, planNumber,
    businessDate, planName: frozen.planName, accountId: R70_ACCOUNT,
  }, o.recurringAuth || {});
  let providerCalls = 0;
  // S72: a MUTABLE clock (never a fixed call-count sequence). The provider itself flips it to
  // `t1` on its Nth real await, so the day flip lands DURING that await regardless of how many
  // times nowOf() is consulted — the post-await re-check (not a call index) is what must catch it.
  let clockNow = (o.clock && o.clock.t0 != null) ? o.clock.t0 : (o.now != null ? o.now : Date.now());
  const goodResult = () => ({
    policy: Object.assign({ enabled: true, autoConfirm: true, dailyBudget: 300, plansPerShopPerDay: 3 }, o.policy || {}),
    shop: o.shop === null ? null : Object.assign({ id: R70_SHOP, name: R70_SHOP, accountId: R70_ACCOUNT, targetRoi: 15, enabled: true }, o.shop || {}),
  });
  const recurringPolicyProvider = o.providerThrow
    ? () => { throw new Error('localhost-state-unreadable'); }
    : async () => {
      providerCalls++;
      if (o.clock && providerCalls === o.clock.flipOnCall) clockNow = o.clock.t1;
      return goodResult();
    };
  const calls = { click: 0 };
  const creation = Object.assign({
    originOk: true, pathOk: true, accountId: R70_ACCOUNT, planName: frozen.planName,
    uniqueProductCount: 30, productRowCount: 30, productIds: R70_PRODUCTS.slice(), eachRowHasManualAccount: true,
    rows: R70_PRODUCTS.map(id => ({ productId: id, manualAccounts: 2 })),
    roi: '15.00', budget: '300.00',
    commissionChecked: true, optionalDirectPayChecked: false, publishButtonCount: 1,
  }, o.creation || {});
  const newPlanId = o.newPlanId || '123456789012';
  const successRow = { found: true, planName: frozen.planName, uniqueRow: true, accountId: R70_ACCOUNT, planId: newPlanId, productCount: 30, accountCount: 2, roi: 15, dailyBudget: 300, commissionIncluded: true, status: '投放中' };
  const deps = {
    nowMs: o.clock ? () => clockNow : () => (o.now != null ? o.now : Date.now()),
    stateFile, publishedFile, attemptsFile, frozen, recurringAuth, recurringPolicyProvider,
    readManagementAbsence: async () => ({ absenceConfirmed: true, absent: true, present: false, seenPlanIds: R70_OLD_IDS, accountId: R70_ACCOUNT, total: R70_OLD_IDS.length }),
    observeCreation: async () => ({ creation }),
    readFinalDialog: async () => (o.dialog === null ? null : Object.assign({ visible: true, text: pw.FINAL_EXCLUSION_TEXT, confirmTarget: { tag: 'SPAN', closestButton: true } }, o.dialog || {})),
    readManagementRow: async () => (o.postRow === null ? { found: false } : Object.assign({}, successRow, o.postRow || {})),
    clickFinalConfirm: async () => { calls.click++; return { clicked: true }; },
    readCurrentShopEnableState: async () => ({ readOk: true, enabled: true, accountId: R70_ACCOUNT }),
    allowReopenMissingFinal: o.allowReopen === true,
  };
  return { dir, deps, frozen, businessDate, calls, stateFile, publishedFile, attemptsFile, newPlanId, providerCalls: () => providerCalls };
}

// ── Regression: the shipped positive scheduled path still completes ONE final click ──
test('S71 scheduled (regression): a valid scope still completes exactly ONE final click', async () => {
  const f = scheduledFixture();
  try {
    const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
    assert.equal(r.status, 'success');
    assert.equal(r.clicks, 1);
    assert.equal(f.calls.click, 1);
    assert.equal(r.authorizedBy, 'recurring-user-policy');
    assert.equal(r.humanApproved, false);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ── Requirement 1: the Root date-boundary counterexample ─────────────────────
// The scheduled resume consults the trusted policy provider at THREE awaited gates, in this
// order: gate-before-absence, gate B (immediately before the final consumption), gate C
// (immediately before the final click). Each gate rejects a day flip that happens DURING its
// await via a POST-await re-check. The clock is a MUTABLE value and the provider flips it on
// its own Nth await — no dependence on how many times nowOf() is called. The 3rd gate is
// EXACTLY the Root reproduction (call started on day D, the final provider read resumed on
// D+1, the old helper still clicked once): the reservation is already durable, so it must
// stay 'unknown' (retained, never replayed) with ZERO clicks.
test('S72 date-await: a Shanghai-day flip during ANY provider await yields ZERO actual clicks', async () => {
  const t0 = Date.now();
  const t1 = t0 + 2 * 24 * 3600 * 1000; // always a different (later) Shanghai day
  const cases = [
    {
      name: 'first await (gate before absence)',
      flipOnCall: 1,
      reason: 'scheduled-policy-drift-before-absence:business-date-changed',
      status: 'refused', finalMark: 0, expectedProviderCalls: 1,
    },
    {
      name: 'second await (gate B, before the final consumption)',
      flipOnCall: 2,
      reason: 'scheduled-policy-drift-before-final-consume:business-date-changed',
      status: 'refused', finalMark: 0, expectedProviderCalls: 2,
    },
    {
      name: 'third await (gate C, immediately before the final click) — the Root counterexample',
      flipOnCall: 3,
      reason: 'scheduled-policy-drift-before-final-click:business-date-changed',
      status: 'unknown', finalMark: 1, expectedProviderCalls: 3,
    },
  ];
  for (const c of cases) {
    const f = scheduledFixture({ now: t0, clock: { t0, t1, flipOnCall: c.flipOnCall } });
    try {
      const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
      assert.equal(r.status, c.status, c.name + ' status');
      assert.equal(r.reason, c.reason, c.name + ' reason');
      assert.equal(f.calls.click, 0, c.name + ' performs ZERO actual clicks');
      assert.equal(r.clicks, 0, c.name + ' never claims a click');
      assert.equal(f.providerCalls(), c.expectedProviderCalls, c.name + ' provider call count');
      const att = guard.loadAttemptsStore(f.attemptsFile);
      const fin = Object.prototype.hasOwnProperty.call(att.finalConsumed, 'conf-1') ? 1 : 0;
      assert.equal(fin, c.finalMark, c.name + ' finalConsumed marks');
      if (c.finalMark === 1) {
        assert.equal(att.finalConsumed['conf-1'].status, 'unknown', c.name + ' reserved final stays unknown (never replayed)');
      }
      assert.equal(att.consumed['conf-1'].status, 'unknown', c.name + ' initial never promoted');
      // a second run can never turn the stopped scope into a click
      const again = await rp.resumeScheduledKnownFinalOnly(f.deps);
      assert.notEqual(again.status, 'success', c.name + ' no replay success');
      assert.equal(f.calls.click, 0, c.name + ' still zero clicks');
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Fixture B — the S71 one-shot cross-day close.
// The durable initial record uses the REAL shipped consumePublicationOnce shape that
// carries NO accountId / planName (only planNumber / runId / businessDate / manifestHash).
// ─────────────────────────────────────────────────────────────────────────────
function closeFixture(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r71-close-'));
  const stateFile = path.join(dir, 'plan-publisher-state.json');
  const publishedFile = path.join(dir, 'published-products.json');
  const attemptsFile = path.join(dir, 'plan-publication-attempts.json');
  const oldDay = o.oldDay || R70_OLD_DAY;
  const planNumber = o.planNumber || 1;
  const base = {
    planNumber, runId: 'run-1', businessDate: oldDay, accountId: R70_ACCOUNT,
    planName: oldDay + '_千川乘方_22:28:24',
    roi: 15, dailyBudget: 300,
    commissionIncluded: true, directPay: false, boundAccounts: ['79863866', '9zmao_fushi'],
    productIds: R70_PRODUCTS.slice(), disclosures: { migration: [], precheck: [], reviewFailed: [] },
    nonce: 'nonce-1', confirmationId: 'conf-1',
    // S72: the freeze happens on the (old) business day — shownAt must be >= frozenAt, so it can
    // never be a forward-dated (impossible) evidence set.
    frozenAt: oldDay + 'T02:00:00.000Z',
  };
  const frozen = Object.assign({}, base, { manifestHash: pw.manifestHash(base) }, o.frozenOver || {});
  const active = Object.assign(
    { status: 'publish-unknown', reason: 'unknown-or-new-final-dialog', planNumber, frozen, authorizedBy: 'recurring-user-policy' },
    o.activeOver || {},
  );
  pw.persistDayState(stateFile, Object.assign({
    businessDate: oldDay, plans: [], active, firstPublishedPlan: null, lastSelected: R70_PRODUCTS.slice(),
    confirmationConsumptions: [],
  }, o.stateOver || {}));
  // REAL shape: no accountId / planName on the initial record.
  const initial = Object.assign({
    planNumber, runId: 'run-1', businessDate: oldDay, manifestHash: frozen.manifestHash,
    status: 'unknown', at: new Date().toISOString(),
  }, o.initialOver || {});
  const attempts = Object.assign({ consumed: Object.assign({ 'conf-1': initial }, o.extraConsumed || {}), finalConsumed: {} }, o.attemptsOver || {});
  fs.writeFileSync(attemptsFile, JSON.stringify(attempts, null, 2));
  // A prior (minute-shop) success artefact that the close must leave byte-identical.
  fs.writeFileSync(publishedFile, JSON.stringify({ publishedIds: ['old-product-1', 'old-product-2'], plans: [{ planNumber: 9, status: 'success', planId: '999999999999', businessDate: '2026-10-01' }] }, null, 2));

  // Historical (old-day) evidence times, ordered shownAt <= lostAt <= exitedAt, all in the past.
  const shownAt = o.shownAt || oldDay + 'T14:00:00.000Z';
  const lostAt = o.lostAt || oldDay + 'T14:05:00.000Z';
  const exitedAt = o.exitedAt || oldDay + 'T14:06:00.000Z';
  // observedAt is the FRESH host read moment: default to "just now" so it is a valid, non-future,
  // in-window observation (an old JSON replay would be stale and refused).
  const observedAt = o.observedAt || new Date().toISOString();
  const knownFinalObservationProvider = o.knownFinalObservationProvider || (async () => Object.assign({
    accountId: R70_ACCOUNT, shop: R70_SHOP, planName: frozen.planName, confirmationId: 'conf-1',
    manifestHash: frozen.manifestHash, runId: 'run-1', businessDate: oldDay, planNumber,
    productIds: R70_PRODUCTS.slice(), text: pw.FINAL_EXCLUSION_TEXT, shownAt, lostAt, pid: 4242,
  }, o.obsOver || {}));
  const sessionLossProvider = o.sessionLossProvider || (async () => Object.assign({
    accountId: R70_ACCOUNT, planName: frozen.planName, confirmationId: 'conf-1',
    manifestHash: frozen.manifestHash, runId: 'run-1', businessDate: oldDay, planNumber,
    pid: 4242, startedAt: oldDay + 'T13:00:00.000Z', exitedAt, exited: true, revived: false, observedAt,
  }, o.lossOver || {}));
  const readManagementAbsence = o.readManagementAbsence || (async () => Object.assign({
    absenceConfirmed: true, absent: true, present: false, accountId: R70_ACCOUNT,
    seenPlanIds: R70_OLD_IDS.slice(), total: R70_OLD_IDS.length, pages: 1, observedAt,
  }, o.absOver || {}));

  const deps = Object.assign({
    nowMs: () => (o.now || Date.now()),
    business: { shop: R70_SHOP, accountId: R70_ACCOUNT, productsPerPlan: 30 },
    stateFile, publishedFile, attemptsFile, frozen,
    knownFinalObservationProvider, sessionLossProvider, readManagementAbsence,
  }, o.depsOver || {});
  return { dir, deps, frozen, oldDay, stateFile, publishedFile, attemptsFile, frozenHash: frozen.manifestHash };
}

function readBytes(file) { return fs.readFileSync(file); }
function assertUnchanged(file, bytes, why) {
  assert.ok(readBytes(file).equals(bytes), why);
}

// ── Requirement 2: the positive close ────────────────────────────────────────
test('S71 close: a previous-day stopped known-final (never submitted) closes to a terminal failed + closed-unsubmitted', async () => {
  const f = closeFixture();
  try {
    const pubBefore = readBytes(f.publishedFile);
    const r = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f.deps);
    assert.equal(r.status, 'closed');
    assert.equal(r.changed, true);
    assert.equal(r.clicks, 0, 'never clicks');
    assert.equal(r.finalWrites, 0, 'never writes a final marker');
    assert.equal(r.closedBusinessDate, R70_OLD_DAY);

    // attempts: ONLY this CID's initial unknown -> terminal failed + structured resolution.
    const att = guard.loadAttemptsStore(f.attemptsFile);
    assert.ok(Object.prototype.hasOwnProperty.call(att.consumed, 'conf-1'), 'original CID retained');
    const rec = att.consumed['conf-1'];
    assert.equal(rec.status, 'failed');
    const res = rec.resolution;
    assert.ok(res && typeof res === 'object');
    assert.equal(res.kind, 'expired-known-final-unsubmitted');
    assert.equal(res.notPlatformFailure, true, 'explicitly NOT a platform publish failure');
    assert.equal(res.notPublishSuccess, true);
    assert.equal(res.previousStatus, 'unknown');
    assert.equal(res.originalRecord.status, 'unknown', 'the original record is preserved verbatim');
    assert.equal(res.frozen.confirmationId, 'conf-1');
    assert.equal(res.knownFinalObservation.textKnown, true);
    assert.equal(res.knownFinalObservation.accountId, R70_ACCOUNT);
    assert.equal(res.sessionLoss.revived, false);
    assert.equal(res.absenceProof.present, false);
    assert.equal(res.absenceProof.absenceConfirmed, true);
    assert.equal(res.closedBusinessDate, R70_OLD_DAY);
    assert.ok(/^[0-9a-f]{64}$/.test(res.closureHash), 'closureHash is a sha256');
    // NO final / reopen / explicitFailure / retry grant was fabricated.
    assert.equal(rec.explicitPlatformFailure, undefined, 'no platform-failure record');
    assert.equal(rec.retryConfirmationId, undefined, 'no retry authorization');
    assert.ok(!Object.prototype.hasOwnProperty.call(att.finalConsumed, 'conf-1'), 'no final marker');
    assert.ok(!Object.prototype.hasOwnProperty.call(att.reopenConsumed || {}, 'conf-1'), 'no reopen marker');

    // day state: the old active becomes the explicit terminal closed-unsubmitted, frozen retained.
    const st = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
    assert.equal(st.active.status, 'closed-unsubmitted');
    assert.equal(st.active.frozen.confirmationId, 'conf-1', 'original frozen retained');
    assert.equal(st.active.resolutionRef.kind, 'expired-known-final-unsubmitted');
    assert.ok(Array.isArray(st.expiredUnsubmittedClosures) && st.expiredUnsubmittedClosures.length === 1);
    assert.equal(st.businessDate, R70_OLD_DAY, 'history not lost');

    // the prior (minute-shop) success file is untouched, byte for byte.
    assertUnchanged(f.publishedFile, pubBefore, 'published success file bytes unchanged');

    // the NEXT day now loads normally (no dangling old unknown) and a fresh consumption passes.
    const nextDay = pw.loadDayState(f.stateFile, R70_NEW_DAY);
    assert.equal(nextDay.businessDate, R70_NEW_DAY);
    const newLedger = path.join(f.dir, 'new-day-attempts.json');
    fs.copyFileSync(f.attemptsFile, newLedger);
    guard.consumePublicationOnce(newLedger, 1, 'new-conf', { runId: 'run-2', businessDate: R70_NEW_DAY, manifestHash: 'h'.repeat(64), maxPlansPerDay: 3 });
    assert.ok(Object.prototype.hasOwnProperty.call(guard.loadAttemptsStore(newLedger).consumed, 'new-conf'), 'new day / new nonce consumption passes');

    // the OLD day + same plan can never be consumed again, and the old CID is never replayed.
    assert.throws(() => guard.consumePublicationOnce(f.attemptsFile, 1, 'other-conf', { runId: 'run-1', businessDate: R70_OLD_DAY, manifestHash: 'h'.repeat(64), maxPlansPerDay: 3 }),
      /already consumed for the business date/);
    assert.throws(() => guard.consumePublicationOnce(f.attemptsFile, 1, 'conf-1', { runId: 'run-1', businessDate: R70_OLD_DAY, manifestHash: f.frozenHash, maxPlansPerDay: 3 }),
      /already consumed; replay refused/);

    // idempotent: a second close reports already-closed with zero further writes.
    const attBytes = readBytes(f.attemptsFile);
    const stBytes = readBytes(f.stateFile);
    const again = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f.deps);
    assert.equal(again.status, 'already-closed');
    assert.equal(again.changed, false);
    assertUnchanged(f.attemptsFile, attBytes, 'no further ledger write');
    assertUnchanged(f.stateFile, stBytes, 'no further state write');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ── Requirement 2: the negative matrix (any gap -> refused, ZERO storage writes) ──
test('S71 close: every missing / drifted / present precondition refuses with ZERO storage writes', async () => {
  const cases = [
    ['expected-frozen-incomplete', { frozenOver: { confirmationId: '' } }, {}],
    ['expected-frozen-incomplete', { frozenOver: { accountId: '9999999999999999' } }, {}],
    ['business-date-not-old', { oldDay: R70_TODAY }, {}],
    ['state-business-date-mismatch', { stateOver: { businessDate: R70_TWO_DAYS_AGO } }, {}],
    ['not-the-unique-stopped-final-confirm', {}, { activeOver: { reason: 'some-other-reason' } }],
    ['not-the-unique-stopped-final-confirm', {}, { activeOver: { status: 'post-publish-enable-stopped' } }],
    ['recurring-authority-marker-missing', {}, { activeOver: { authorizedBy: 'manual' } }],
    ['frozen-manifest-tampered', {}, {}], // the frozen's own hash is broken in-place below
    ['initial-attempt-not-unknown', {}, { initialOver: { status: 'dispatched' } }],
    ['initial-attempt-missing', {}, { initialOver: { __remove: true } }],
    ['initial-attempt-account-mismatch', {}, { initialOver: { accountId: '8888888888888888' } }],
    ['initial-attempt-planName-mismatch', {}, { initialOver: { planName: '别的计划名' } }],
    ['final-record-present', {}, { attemptsOver: { finalConsumed: { 'conf-1': { planNumber: 1, runId: 'run-1', businessDate: R70_OLD_DAY, manifestHash: 'x'.repeat(64), status: 'unknown', at: new Date().toISOString() } } } }],
    ['reopen-record-present', {}, { attemptsOver: { reopenConsumed: { 'conf-1': { planNumber: 1, runId: 'run-1', businessDate: R70_OLD_DAY, manifestHash: 'x'.repeat(64), status: 'unknown', at: new Date().toISOString() } } } }],
    ['human-consumption-recorded', {}, { stateOver: { confirmationConsumptions: [{ confirmationId: 'conf-1', manifestHash: 'x'.repeat(64), planNumber: 1 }] } }],
    // S72: keep the REAL current CID intact and only append an unrelated unresolved 'other-conf',
    // so the refusal is the intended other-unresolved-scope path (a mutated current-CID hash would
    // instead trip the earlier initial-attempt-scope-mismatch gate).
    ['other-unresolved-scope-present', {}, { extraConsumed: { 'other-conf': { planNumber: 2, runId: 'run-2', businessDate: R70_OLD_DAY, manifestHash: 'y'.repeat(64), status: 'unknown', at: new Date().toISOString() } } }],
    ['plan-number-already-recorded', {}, { stateOver: { plans: [{ planNumber: 1, status: 'success', planId: '111111111111' }] } }],
  ];
  for (const [reason, fixtureOpts, extra] of cases) {
    const f = closeFixture(Object.assign({}, fixtureOpts, extra));
    try {
      // the tampered-frozen case needs a frozen whose recomputed hash differs from its own:
      if (reason === 'frozen-manifest-tampered') {
        const st = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
        st.active.frozen.planName = st.active.frozen.planName + '_tampered'; // hash no longer matches
        // keep the outer frozen in sync so the mismatch is specifically the hash recompute
        fs.writeFileSync(f.stateFile, JSON.stringify(st, null, 2));
        f.deps.frozen.planName = st.active.frozen.planName;
      }
      if (extra && extra.initialOver && extra.initialOver.__remove) {
        fs.writeFileSync(f.attemptsFile, JSON.stringify({ consumed: {}, finalConsumed: {} }, null, 2));
      }
      const attBefore = readBytes(f.attemptsFile);
      const stBefore = readBytes(f.stateFile);
      const r = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f.deps);
      assert.equal(r.status, 'refused', reason + ' -> refused');
      assert.equal(r.reason, reason, reason + ' exact reason');
      assert.equal(r.changed, false);
      assert.equal(r.finalWrites, 0);
      assertUnchanged(f.attemptsFile, attBefore, reason + ' leaves the ledger untouched');
      assertUnchanged(f.stateFile, stBefore, reason + ' leaves the state untouched');
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('S71 close: proof-provider gaps (observation / session-loss / absence) all refuse with ZERO writes', async () => {
  const cases = [
    ['known-final-observation-text-not-known', { obsOver: { text: '一个未知的新弹窗文案' } }],
    ['known-final-observation-scope-mismatch', { obsOver: { manifestHash: 'f'.repeat(64) } }],
    ['known-final-observation-scope-mismatch', { obsOver: { accountId: '9999999999999999' } }],
    ['known-final-observation-product-ids-mismatch', { obsOver: { productIds: R70_PRODUCTS.slice(1) } }],
    ['known-final-warning-time-invalid', { shownAt: '2026-10-14T15:00:00.000Z', lostAt: '2026-10-14T14:00:00.000Z' }],
    ['session-loss-proof-scope-mismatch', { lossOver: { manifestHash: 'f'.repeat(64) } }],
    ['session-revived-not-lost', { lossOver: { revived: true } }],
    ['session-loss-time-invalid', { exitedAt: '2026-10-14T13:00:00.000Z' }], // exit BEFORE the warning was lost
    ['plan-present-in-management', { absOver: { present: true, absenceConfirmed: false } }],
    ['management-absence-untrusted', { absOver: { absenceConfirmed: false } }],
    ['management-absence-account-mismatch', { absOver: { accountId: '9999999999999999' } }],
    ['management-absence-seen-ids-missing', { absOver: { seenPlanIds: null } }],
    ['management-absence-seen-ids-not-unique', { absOver: { seenPlanIds: ['a', 'a'], total: 2 } }],
    ['management-absence-total-mismatch', { absOver: { total: 5 } }],
    ['management-absence-pages-unverified', { absOver: { pages: 0 } }],
  ];
  for (const [reason, opts] of cases) {
    const f = closeFixture(opts);
    try {
      const attBefore = readBytes(f.attemptsFile);
      const stBefore = readBytes(f.stateFile);
      const r = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f.deps);
      assert.equal(r.status, 'refused', reason + ' -> refused');
      assert.equal(r.reason, reason, reason + ' exact reason');
      assertUnchanged(f.attemptsFile, attBefore, reason + ' leaves the ledger untouched');
      assertUnchanged(f.stateFile, stBefore, reason + ' leaves the state untouched');
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
  // a provider that throws fails closed
  const f = closeFixture({ knownFinalObservationProvider: async () => { throw new Error('host-io'); } });
  try {
    const r = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f.deps);
    assert.equal(r.status, 'refused');
    assert.ok(r.reason.startsWith('known-final-observation-failed:'), r.reason);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ── Requirement 2: drift during the callbacks (identity / status hash) ────────
test('S71 close: an identity/status change during the callbacks is refused with ZERO writes', async () => {
  const attBeforeHolder = {};
  const f = closeFixture({
    knownFinalObservationProvider: async () => {
      // a concurrent writer mutates the ledger mid-proof
      const att = JSON.parse(fs.readFileSync(attBeforeHolder.attemptsFile, 'utf8'));
      att.consumed['concurrent-conf'] = { planNumber: 2, runId: 'run-9', businessDate: R70_OLD_DAY, manifestHash: 'z'.repeat(64), status: 'unknown', at: new Date().toISOString() };
      fs.writeFileSync(attBeforeHolder.attemptsFile, JSON.stringify(att, null, 2));
      return { accountId: R70_ACCOUNT, shop: R70_SHOP, planName: attBeforeHolder.frozen.planName, confirmationId: 'conf-1',
        manifestHash: attBeforeHolder.frozen.manifestHash, runId: 'run-1', businessDate: R70_OLD_DAY, planNumber: 1,
        productIds: R70_PRODUCTS.slice(), text: pw.FINAL_EXCLUSION_TEXT, pid: 4242,
        shownAt: R70_OLD_DAY + 'T14:00:00.000Z', lostAt: R70_OLD_DAY + 'T14:05:00.000Z' };
    },
  });
  try {
    attBeforeHolder.attemptsFile = f.attemptsFile;
    attBeforeHolder.frozen = f.frozen;
    const stBefore = readBytes(f.stateFile);
    const r = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'scope-drift-during-proofs');
    assertUnchanged(f.stateFile, stBefore, 'the concurrent writer touched only the ledger; the close wrote nothing more');
    // the injected concurrent record is still the sole additional change (close added no closure)
    const att = guard.loadAttemptsStore(f.attemptsFile);
    assert.ok(Object.prototype.hasOwnProperty.call(att.consumed, 'concurrent-conf'));
    assert.equal(att.consumed['conf-1'].status, 'unknown', 'the close did not terminalize the initial');
    assert.equal(att.consumed['conf-1'].resolution, undefined);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ── Requirement 2: CAS — a change AFTER the proofs but before the lock is refused ──
test('S71 close: CAS re-read catches a concurrent writer that lands before the lock -> refused, no writes', async () => {
  let injected = false;
  const f = closeFixture();
  try {
    f.deps.acquireLock = (lockFile) => {
      // acquireLock is the CAS boundary: a concurrent writer sneaks in here.
      const att = JSON.parse(fs.readFileSync(f.attemptsFile, 'utf8'));
      att.consumed['conf-1'] = Object.assign({}, att.consumed['conf-1'], { status: 'dispatched' });
      fs.writeFileSync(f.attemptsFile, JSON.stringify(att, null, 2));
      injected = true;
      return () => {};
    };
    const stBefore = readBytes(f.stateFile);
    const r = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f.deps);
    assert.equal(injected, true, 'the CAS injection ran');
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'scope-drift-before-close');
    assertUnchanged(f.stateFile, stBefore, 'no state write on a CAS mismatch');
    assert.equal(guard.loadAttemptsStore(f.attemptsFile).consumed['conf-1'].status, 'dispatched', 'the concurrent change is preserved');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ── Requirement 2: a corrupt ledger fails closed ─────────────────────────────
test('S71 close: a corrupt ledger refuses with ZERO writes', async () => {
  const f = closeFixture();
  try {
    fs.writeFileSync(f.attemptsFile, '{ this is not json');
    const stBefore = readBytes(f.stateFile);
    const r = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f.deps);
    assert.equal(r.status, 'refused');
    assert.ok(r.reason.startsWith('expired-close-unreadable:'), r.reason);
    assertUnchanged(f.stateFile, stBefore, 'no state write on corruption');
    assert.equal(fs.readFileSync(f.attemptsFile, 'utf8'), '{ this is not json', 'the corrupt ledger is not silently rewritten');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ── Requirement 2: atomic-write failure -> conservative half, then idempotent completion ──
test('S71 close: a failed day-state write is reported half-completed and a re-run finishes it idempotently', async () => {
  const f = closeFixture();
  try {
    const pubBefore = readBytes(f.publishedFile);
    let failedOnce = false;
    f.deps.atomicWriteState = (file, value) => { failedOnce = true; throw new Error('disk-full'); };
    const half = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f.deps);
    assert.equal(failedOnce, true);
    assert.equal(half.status, 'half-completed', 'never reported as success');
    assert.equal(half.reason, 'expired-close-state-write-failed:disk-full');
    assert.equal(half.wroteAttempts, true);
    assert.equal(half.wroteState, false);
    // Step A persisted (the ledger is terminal) but the day state is still the old stopped confirm.
    const att = guard.loadAttemptsStore(f.attemptsFile);
    assert.equal(att.consumed['conf-1'].status, 'failed');
    assert.equal(att.consumed['conf-1'].resolution.kind, 'expired-known-final-unsubmitted');
    const st = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
    assert.equal(st.active.status, 'publish-unknown', 'the day state is untouched by the failed write');
    assert.equal(st.expiredUnsubmittedClosures, undefined);

    // Re-run with the real writer: it re-verifies the SAME fresh scope and FINISHES (not "success").
    const attBytes = readBytes(f.attemptsFile);
    delete f.deps.atomicWriteState;
    const done = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f.deps);
    assert.equal(done.status, 'completed', 'idempotent completion of the half');
    assert.equal(done.changed, true);
    assert.equal(done.wroteAttempts, false, 'the already-terminal ledger is not rewritten');
    assert.equal(done.wroteState, true);
    assertUnchanged(f.attemptsFile, attBytes, 'ledger bytes preserved on the finish');
    const st2 = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
    assert.equal(st2.active.status, 'closed-unsubmitted');
    assert.ok(Array.isArray(st2.expiredUnsubmittedClosures) && st2.expiredUnsubmittedClosures.length === 1);
    assertUnchanged(f.publishedFile, pubBefore, 'published file still untouched');

    // and a third call is a pure already-closed no-op.
    const third = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f.deps);
    assert.equal(third.status, 'already-closed');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ── Requirement 3: the OLD real initial shape (no accountId / planName) is handled ──
test('S71 close: the shipped initial shape (no accountId / planName) closes; a CARRIED field that drifts is refused', async () => {
  const f = closeFixture();
  try {
    const raw = JSON.parse(fs.readFileSync(f.attemptsFile, 'utf8'));
    assert.ok(!Object.prototype.hasOwnProperty.call(raw.consumed['conf-1'], 'accountId'), 'fixture initial carries no accountId');
    assert.ok(!Object.prototype.hasOwnProperty.call(raw.consumed['conf-1'], 'planName'), 'fixture initial carries no planName');
    const r = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f.deps);
    assert.equal(r.status, 'closed', 'the real account/planName-less shape still closes');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  // a CARRIED identity field that disagrees with the frozen scope must refuse.
  const f2 = closeFixture({ initialOver: { planName: '与冻结不同的计划名' } });
  try {
    const stBefore = readBytes(f2.stateFile);
    const r = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f2.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'initial-attempt-planName-mismatch');
    assertUnchanged(f2.stateFile, stBefore, 'no write on carried-field drift');
  } finally { fs.rmSync(f2.dir, { recursive: true, force: true }); }
});

// ── Requirement 2: the close never fabricates a same-day resend capability ────
test('S71 close: the closure is NOT a publish success — today 0/3 stays 0/3 and no plan/day success is written', async () => {
  const f = closeFixture();
  try {
    const r = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f.deps);
    assert.equal(r.status, 'closed');
    const st = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
    assert.deepEqual(st.plans, [], 'no success plan appended for the closed day');
    assert.equal(st.firstPublishedPlan, null, 'no firstPublishedPlan fabricated');
    assert.ok(!('published-success' === (st.active && st.active.status)), 'never claims published success');
    assert.equal(st.active.status, 'closed-unsubmitted');
    const att = guard.loadAttemptsStore(f.attemptsFile);
    assert.equal(att.consumed['conf-1'].status, 'failed', 'closed as an unsubmitted terminal, never a success');
    assert.ok(!Object.prototype.hasOwnProperty.call(att.finalConsumed, 'conf-1'), 'no final marker fabricated');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// S72 additions — the four Root exported negative counterexamples plus the strict
// time / session-identity evidence gates. Every case drives the REAL close entry over
// REAL OS-temp files and asserts BOTH the exact refusal reason AND ZERO storage writes.
// ─────────────────────────────────────────────────────────────────────────────
async function assertCloseRefused(opts, reason) {
  const f = closeFixture(opts);
  try {
    const attBefore = readBytes(f.attemptsFile);
    const stBefore = readBytes(f.stateFile);
    const r = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f.deps);
    assert.equal(r.status, 'refused', reason + ' -> refused');
    assert.equal(r.reason, reason, reason + ' exact reason');
    assert.equal(r.changed, false);
    assert.equal(r.finalWrites, 0);
    assertUnchanged(f.attemptsFile, attBefore, reason + ' leaves the ledger untouched');
    assertUnchanged(f.stateFile, stBefore, reason + ' leaves the state untouched');
    return r;
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
}

// Root counterexample 1: future-proof-times (2098/2099/2100) must never close.
test('S72 close: proof times in the future / before the freeze are refused with ZERO writes', async () => {
  const t = Date.now();
  const future = (y) => new Date(t + y * 365 * 24 * 3600 * 1000).toISOString();
  await assertCloseRefused(
    { shownAt: future(82), lostAt: future(83), exitedAt: future(84) },
    'known-final-observation-time-future');
  await assertCloseRefused(
    { exitedAt: future(1) },
    'session-loss-time-future');
  await assertCloseRefused(
    { shownAt: R70_OLD_DAY + 'T01:00:00.000Z' }, // before frozenAt (old-day 02:00)
    'known-final-observation-before-freeze');
  // observedAt must be a fresh, non-future, in-window read (never an old JSON replay)
  await assertCloseRefused({ lossOver: { observedAt: future(1) } }, 'session-loss-observed-at-stale');
  await assertCloseRefused({ absOver: { observedAt: future(1) } }, 'management-absence-observed-at-stale');
  await assertCloseRefused({ lossOver: { observedAt: '2020-01-01T00:00:00.000Z' } }, 'session-loss-observed-at-stale');
  await assertCloseRefused({ absOver: { observedAt: '2020-01-01T00:00:00.000Z' } }, 'management-absence-observed-at-stale');
});

// Root-aligned: session-loss must be EXPLICIT (exited===true, revived===false) and the owner pid
// must strictly match the one recorded by the trusted observation.
test('S72 close: explicit exited / revived / owner-pid session evidence is required', async () => {
  await assertCloseRefused({ lossOver: { exited: undefined } }, 'session-loss-exit-unconfirmed');
  await assertCloseRefused({ lossOver: { exited: false } }, 'session-loss-exit-unconfirmed');
  await assertCloseRefused({ lossOver: { exited: 'yes' } }, 'session-loss-exit-unconfirmed');
  await assertCloseRefused({ lossOver: { revived: true } }, 'session-revived-not-lost');
  await assertCloseRefused({ lossOver: { revived: undefined } }, 'session-revived-not-lost');
  await assertCloseRefused({ lossOver: { pid: 7777 } }, 'session-loss-pid-mismatch');
  await assertCloseRefused({ obsOver: { pid: 31337 } }, 'session-loss-pid-mismatch');
  await assertCloseRefused({ lossOver: { pid: 0 } }, 'session-loss-pid-invalid');
  await assertCloseRefused({ obsOver: { pid: undefined } }, 'known-final-observation-pid-missing');
  await assertCloseRefused({ obsOver: { pid: null } }, 'known-final-observation-pid-missing');
});

// Root counterexample 4: an unbound day-level unknown/pending flag must refuse with zero rewrite
// and must NEVER be cleared as a side effect.
test('S72 close: an unbound day-level unknown / pending flag refuses and is never cleared', async () => {
  await assertCloseRefused({ stateOver: { unknown: true } }, 'unbound-day-unknown-flag');
  await assertCloseRefused({ stateOver: { pending: true } }, 'unbound-day-unknown-flag');
});

// Root counterexample 2: a frozen-field change that lands AFTER the lock (bytes/hash changed but
// the manifest STRING untouched) must be caught by the full byte-level CAS, not a manifest compare.
test('S72 close: a frozen-field drift landed under the lock is refused by the full byte CAS', async () => {
  let injected = false;
  const f = closeFixture();
  try {
    f.deps.acquireLock = (lockFile) => {
      const s = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
      s.active.frozen.roi = 99; // manifestHash string unchanged; only bytes reveal the tamper
      fs.writeFileSync(f.stateFile, JSON.stringify(s));
      injected = true;
      return rp.acquireLock(lockFile);
    };
    const attBefore = readBytes(f.attemptsFile);
    const r = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f.deps);
    assert.equal(injected, true, 'the under-lock injection ran');
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'scope-drift-before-close');
    assert.equal(r.finalWrites, 0);
    assertUnchanged(f.attemptsFile, attBefore, 'the ledger is never terminalized on a CAS mismatch');
    assert.equal(guard.loadAttemptsStore(f.attemptsFile).consumed['conf-1'].status, 'unknown');
    assert.equal(JSON.parse(fs.readFileSync(f.stateFile, 'utf8')).active.status, 'publish-unknown', 'the concurrent write is preserved');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// Root counterexample 3: the frozen entry day must be re-checked against the SAME current Shanghai
// day after every await — "today -> tomorrow" must refuse even though tomorrow is still > oldDay.
test('S72 close: a current-day flip during a proof callback (today -> tomorrow) refuses with ZERO writes', async () => {
  const f = closeFixture();
  try {
    // The mutable clock is installed AFTER the fixture (so the fixture's fresh observedAt is <= now).
    let n = Date.now();
    f.deps.nowMs = () => n;
    const original = f.deps.readManagementAbsence;
    f.deps.readManagementAbsence = async (x) => { const r = await original(x); n += 24 * 3600 * 1000; return r; };
    const attBefore = readBytes(f.attemptsFile);
    const stBefore = readBytes(f.stateFile);
    const r = await rp.closeExpiredScheduledKnownFinalUnsubmitted(f.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'current-day-changed-during-proof');
    assertUnchanged(f.attemptsFile, attBefore, 'no ledger write on a mid-proof day flip');
    assertUnchanged(f.stateFile, stBefore, 'no state write on a mid-proof day flip');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
