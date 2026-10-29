'use strict';
// D38 — scoped eligibility release + reachable-browse-position rewind for the next scheduled
// tick of the same day/plan after a PROVEN zero-publication preparation stop.
//
// Two layers are covered here:
//   1) the pure helper `preparationRetryReleaseIds` (gates, release set, purity, idempotence);
//   2) the REAL `runScheduledPlan` retry hook / state preparation, driven end-to-end with
//      injected fakes and a throwaway stateRoot, proving the helper's output actually reaches
//      the driversFactory/browseProducts inputs and the persisted day state (not just that the
//      helper returns ids in isolation).
// Offline only: no browser, no network, no Cookie/config read, no production state directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wf = require('./plan-workflow.cjs');
const rp = require('./run-plans.cjs');
const shopProfile = require('./shop-profile.cjs');

const preparationRetryReleaseIds = rp.preparationRetryReleaseIds;

const DATE = '2026-10-29';
const OTHER_DATE = '2026-10-28';
const ACCOUNT = '1710000000000123';
const OTHER_ACCOUNT = 'acct-2002';
const RUN_ID = 'plan-scheduler-2026-10-29-0123456789abcdef';

const A = '3600000000000001'; // attempted + hint(clean) -> released
const B = '3600000000000002'; // attempted + hint(migrationWarning only) -> released
const C = '3600000000000003'; // attempted + hint, but PUBLISHED -> never released
const D = '3600000000000004'; // attempted + reviewFailed hint -> never released
const E = '3600000000000005'; // attempted but NO durable hint -> fail closed
const F = '3600000000000006'; // attempted but MALFORMED hint -> fail closed
const G = '3600000000000007'; // attempted-only (older tick, lastSelected lost) -> released
const H = '3600000000000008'; // in lastSelected but NEVER attempted -> never released
const BAD = 'abc-123';       // malformed id -> ignored
const HINT = text => ({ migrationWarning: false, precheckRisk: null, reviewFailed: false, text });

const ZERO = Object.freeze({
  initialConsumptions: 0,
  finalConsumptions: 0,
  reopenConsumptions: 0,
  manualUnresolved: 0,
  plansContainsNumber: false,
  confirmationConsumptionsRecorded: false,
});

function clone(v) { return JSON.parse(JSON.stringify(v)); }

function baseState() {
  return {
    businessDate: DATE,
    page: 62,
    category: wf.CATEGORY_TAB_ORDER[0],
    cursor: { category: wf.CATEGORY_TAB_ORDER[0], page: 62, seenProductIds: [A, B, C] },
    // The exact live shape: a later tick's lastSelected only carries the newest survivors;
    // the older attempted ids (G) are no longer in lastSelected but stay sealed for the day.
    lastSelected: [A, H],
    attempted: [A, B, C, D, E, F, G],
    hints: {
      [A]: HINT('a'),
      [B]: { migrationWarning: true, precheckRisk: null, reviewFailed: false, text: 'b' },
      [C]: HINT('c'),
      [G]: HINT('g'),
      [H]: HINT('h'),
      [D]: { migrationWarning: false, precheckRisk: 'low-quality', reviewFailed: true, text: 'd' },
      [F]: 'not-an-object',
    },
    plans: [{ planNumber: 1, status: 'success', planId: '3600000000009999' }],
    active: { status: 'preparation-stopped', planNumber: 2, runId: RUN_ID, businessDate: DATE, reason: 'prepare-stopped:catalog-exhausted-or-safe-pagination-boundary' },
    firstPublishedPlan: null,
    confirmationConsumptions: [],
    manualUiPublicationFacts: [],
    preparationClosureFacts: [{
      status: 'preparationClosed',
      phase: 'preparing',
      businessDate: DATE,
      planNumber: 2,
      accountId: ACCOUNT,
      runId: RUN_ID,
      reason: 'prepare-stopped:catalog-exhausted-or-safe-pagination-boundary',
      zeroConsumptionProof: { ...ZERO },
    }],
  };
}

function call(state, over) {
  const o = over || {};
  return preparationRetryReleaseIds(
    state,
    o.date !== undefined ? o.date : DATE,
    o.plan !== undefined ? o.plan : 2,
    o.account !== undefined ? o.account : ACCOUNT,
    o.published,
  );
}

// ── 1) pure helper ──────────────────────────────────────────────────────────

test('releases every attempted id with a durable hint that is neither published nor genuinely rejected', () => {
  const r = call(baseState(), { published: [C] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ids, [A, B, G]);
  assert.deepEqual(r.fact, { runId: RUN_ID, planNumber: 2, businessDate: DATE });
});

test('the release covers the lost-lastSelected attempted batch (the live 29 → 12 regression)', () => {
  // G was attempted by an earlier tick and is no longer in lastSelected; a lastSelected-only
  // release would strand it for the whole day. It must be released and re-evaluated live.
  const s = baseState();
  assert.equal(s.lastSelected.includes(G), false);
  assert.equal(call(s, { published: [C] }).ids.includes(G), true);
});

test('an id that is only in lastSelected but never attempted is NOT released', () => {
  const r = call(baseState(), { published: [C] });
  assert.equal(r.ids.includes(H), false);
});

test('returns a reachable rewind descriptor (first category, page 1, empty seen set)', () => {
  const r = call(baseState(), { published: [C] });
  assert.deepEqual(r.rewind, { category: wf.CATEGORY_TAB_ORDER[0], page: 1, seenProductIds: [] });
  // the descriptor is data only: the helper never touches the input cursor
  const s = baseState();
  call(s, { published: [C] });
  assert.equal(s.cursor.page, 62);
  assert.equal(s.page, 62);
});

test('publishedIds accepted as a Set and as an array', () => {
  assert.deepEqual(call(baseState(), { published: new Set([C]) }).ids, [A, B, G]);
  assert.deepEqual(call(baseState(), { published: [C] }).ids, [A, B, G]);
});

test('no publishedIds argument means only the durable hint/reviewFailed gates apply', () => {
  assert.deepEqual(call(baseState(), { published: undefined }).ids, [A, B, C, G]);
});

test('published product ids are never released even when a durable hint exists', () => {
  const s = baseState();
  const r = call(s, { published: [C, G] });
  assert.deepEqual(r.ids, [A, B]);
});

test('reviewFailed hint keeps an attempted id excluded (genuine rejection)', () => {
  const s = baseState();
  s.hints[D].reviewFailed = false;
  assert.deepEqual(call(s, { published: [] }).ids, [A, B, C, D, G]);
});

test('missing / malformed hint keeps an attempted id excluded (fail closed)', () => {
  const s = baseState();
  delete s.hints[E];
  assert.deepEqual(call(s, { published: [] }).ids, [A, B, C, G]);
  s.hints[E] = 'not-an-object';
  assert.deepEqual(call(s, { published: [] }).ids, [A, B, C, G]);
  s.hints[E] = [1, 2];
  assert.deepEqual(call(s, { published: [] }).ids, [A, B, C, G]);
});

test('malformed ids and duplicates in attempted are ignored/deduped', () => {
  const s = baseState();
  s.attempted = [BAD, A, A, A, '123', '99999999999999999999999'];
  assert.deepEqual(call(s, { published: [] }).ids, [A]);
});

test('empty attempted is a successful no-op', () => {
  const s = baseState();
  s.attempted = [];
  const r = call(s, { published: [] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.ids, []);
});

test('active must be preparation-stopped (in-progress/unknown phases never release)', () => {
  for (const status of ['preparing', 'ready-awaiting-confirmation', 'confirmation-consumed', 'publish-pending', 'publish-unknown', 'post-publish-enable-stopped']) {
    const s = baseState();
    s.active.status = status;
    assert.equal(call(s, { published: [] }).reason, 'not-preparation-stopped');
  }
  const s2 = baseState();
  s2.active = null;
  assert.equal(call(s2, { published: [] }).reason, 'not-preparation-stopped');
});

test('active planNumber must equal the tick plan number', () => {
  assert.equal(call(baseState(), { published: [], plan: 3 }).reason, 'active-plan-mismatch');
});

test('active must carry the same business day as the tick', () => {
  const s = baseState();
  s.active.businessDate = OTHER_DATE;
  assert.equal(call(s, { published: [] }).reason, 'active-business-date-mismatch');
  delete s.active.businessDate;
  assert.equal(call(s, { published: [] }).reason, 'active-business-date-mismatch');
});

test('any frozen/confirmation artifact on active refuses (possibly-published run)', () => {
  for (const key of ['frozen', 'confirmationId', 'manifestHash', 'planId', 'nonce']) {
    const s = baseState();
    s.active[key] = key === 'frozen' ? { productIds: [A] } : 'x';
    assert.equal(call(s, { published: [] }).reason, 'confirmation-artifacts-present', key);
  }
});

test('missing preparationClosureFacts refuses', () => {
  const s = baseState();
  s.preparationClosureFacts = [];
  assert.equal(call(s, { published: [] }).reason, 'preparation-closure-not-proven');
  delete s.preparationClosureFacts;
  assert.equal(call(s, { published: [] }).reason, 'preparation-closure-not-proven');
});

test('weak / partial zero-consumption proof refuses', () => {
  const variants = [
    { ...ZERO, plansContainsNumber: true },
    { ...ZERO, initialConsumptions: undefined },
    { ...ZERO, finalConsumptions: 1 },
    { ...ZERO, reopenConsumptions: undefined },
    { ...ZERO, manualUnresolved: 1 },
    { ...ZERO, confirmationConsumptionsRecorded: true },
    null,
    'zero',
  ];
  for (const v of variants) {
    const s = baseState();
    s.preparationClosureFacts[0].zeroConsumptionProof = v;
    assert.equal(call(s, { published: [] }).reason, 'preparation-closure-not-proven', JSON.stringify(v));
  }
});

test('fact must match day/plan/account and prove scheduled origin', () => {
  const cases = [
    ['businessDate', OTHER_DATE],
    ['planNumber', 3],
    ['accountId', OTHER_ACCOUNT],
    ['runId', 'manual-ui-2026-10-29-abcdef'],
    // origin regex matches, but its embedded date contradicts the fact's business day
    ['runId', 'plan-scheduler-2026-10-28-0123456789abcdef'],
    ['status', 'preparationClosed-pending'],
  ];
  for (const [key, value] of cases) {
    const s = baseState();
    s.preparationClosureFacts[0][key] = value;
    assert.equal(call(s, { published: [] }).reason, 'preparation-closure-not-proven', key + '=' + value);
  }
});

test('active runId must be the same run that was proven closed', () => {
  const s = baseState();
  s.active.runId = 'plan-scheduler-2026-10-29-ffffffffffffffff';
  assert.equal(call(s, { published: [] }).reason, 'active-closure-run-mismatch');
});

test('state business date must match the tick business date', () => {
  const s = baseState();
  s.businessDate = OTHER_DATE;
  assert.equal(call(s, { published: [] }).reason, 'state-business-date-mismatch');
});

test('day-level unknown/pending flags refuse (unresolved consumption matter)', () => {
  const s1 = baseState(); s1.unknown = true;
  assert.equal(call(s1, { published: [] }).reason, 'day-state-unresolved-flag-present');
  const s2 = baseState(); s2.pending = true;
  assert.equal(call(s2, { published: [] }).reason, 'day-state-unresolved-flag-present');
});

test('state that already records THIS plan number refuses (never re-release a recorded plan)', () => {
  const s = baseState();
  s.plans.push({ planNumber: 2, status: 'unknown' });
  assert.equal(call(s, { published: [] }).reason, 'plan-number-already-recorded');
  const s2 = baseState();
  delete s2.plans;
  assert.equal(call(s2, { published: [] }).reason, 'plans-list-unreadable');
});

test('confirmation consumption for this run/day-plan refuses', () => {
  const s1 = baseState();
  s1.confirmationConsumptions.push({ runId: RUN_ID });
  assert.equal(call(s1, { published: [] }).reason, 'confirmation-consumption-recorded');
  const s2 = baseState();
  s2.confirmationConsumptions.push({ businessDate: DATE, planNumber: 2 });
  assert.equal(call(s2, { published: [] }).reason, 'confirmation-consumption-recorded');
  const s3 = baseState();
  delete s3.confirmationConsumptions;
  assert.equal(call(s3, { published: [] }).reason, 'confirmation-consumptions-unreadable');
});

test('manual UI publication facts are a consumption surface too', () => {
  const s1 = baseState();
  s1.manualUiPublicationFacts = { not: 'an array' };
  assert.equal(call(s1, { published: [] }).reason, 'manual-publication-facts-unreadable');
  const s2 = baseState();
  s2.manualUiPublicationFacts.push({ runId: RUN_ID });
  assert.equal(call(s2, { published: [] }).reason, 'manual-publication-recorded');
  const s3 = baseState();
  s3.manualUiPublicationFacts.push({ businessDate: DATE, planNumber: 2 });
  assert.equal(call(s3, { published: [] }).reason, 'manual-publication-recorded');
});

test('malformed state / date / plan / account inputs refuse with explicit reasons', () => {
  assert.equal(preparationRetryReleaseIds(null, DATE, 2, ACCOUNT, []).reason, 'state-malformed');
  assert.equal(preparationRetryReleaseIds([], DATE, 2, ACCOUNT, []).reason, 'state-malformed');
  assert.equal(preparationRetryReleaseIds('x', DATE, 2, ACCOUNT, []).reason, 'state-malformed');
  assert.equal(call(baseState(), { date: '2026/10/29', published: [] }).reason, 'date-invalid');
  assert.equal(call(baseState(), { plan: 0, published: [] }).reason, 'plan-invalid');
  assert.equal(call(baseState(), { plan: 1.5, published: [] }).reason, 'plan-invalid');
  assert.equal(call(baseState(), { plan: 'x', published: [] }).reason, 'plan-invalid');
  assert.equal(call(baseState(), { account: '', published: [] }).reason, 'account-missing');
  assert.equal(call(baseState(), { account: null, published: [] }).reason, 'account-missing');
});

test('pure: the input state (page/cursor/attempted/hints) is never mutated', () => {
  const s = baseState();
  s.quantity = 3;          // unrelated live policy fields must survive untouched
  s.roi = '2.5';
  const before = JSON.stringify(s);
  const r = call(s, { published: [C] });
  assert.equal(JSON.stringify(s), before);
  assert.deepEqual(r.ids, [A, B, G]);
  // the returned containers are fresh, not references into the input
  r.ids.push(F);
  r.rewind.seenProductIds.push(A);
  assert.equal(JSON.stringify(s), before);
});

test('idempotent: applying the release then calling again releases nothing', () => {
  const s = baseState();
  const first = call(s, { published: [C] });
  assert.deepEqual(first.ids, [A, B, G]);
  const released = new Set(first.ids);
  const after = clone(s);
  after.attempted = after.attempted.filter(id => !released.has(id));
  const second = call(after, { published: [C] });
  assert.equal(second.ok, true);
  assert.deepEqual(second.ids, []);
  assert.equal(second.fact.runId, RUN_ID);
});

test('no duplicate-publication vector: released ids exclude every published/rejected id', () => {
  const s = baseState();
  const r = call(s, { published: [C, '3600000000007777'] });
  for (const id of r.ids) {
    assert.equal(id === C, false);
    assert.equal(s.hints[id].reviewFailed === true, false);
  }
});

test('multiple closure facts: only the fact bound to the current active run is accepted', () => {
  const s = baseState();
  const oldRun = 'plan-scheduler-2026-10-29-1111111111111111';
  s.preparationClosureFacts.unshift({ status: 'preparationClosed', businessDate: DATE, planNumber: 2, accountId: ACCOUNT, runId: oldRun, zeroConsumptionProof: { ...ZERO } });
  // newest matching fact is the bound one -> still releases
  assert.deepEqual(call(s, { published: [C] }).ids, [A, B, G]);
  // if only the old, non-bound fact remains -> refuse at the active/fact run binding gate
  s.preparationClosureFacts.shift();
  s.preparationClosureFacts[0].runId = oldRun;
  assert.equal(call(s, { published: [C] }).reason, 'active-closure-run-mismatch');
});

// ── 2) real runScheduledPlan retry hook / state preparation ─────────────────

const NOW_MS = Date.parse('2026-10-29T00:05:00+08:00'); // Shanghai 2026-10-29
const SHOP = 'Jin retry fixture';
const PLAN1_RUN_ID = 'plan-scheduler-2026-10-29-1111111111111111';
const FIRST_CATEGORY = wf.CATEGORY_TAB_ORDER[0];

function retryState(proof) {
  return {
    businessDate: DATE,
    page: 62,
    category: FIRST_CATEGORY,
    lastSelected: [A],
    attempted: [A, B, C, D, E, F, G],
    cursor: { category: FIRST_CATEGORY, page: 62, seenProductIds: [A, B, C] },
    hints: {
      [A]: HINT('a'),
      [B]: { migrationWarning: true, precheckRisk: null, reviewFailed: false, text: 'b' },
      [C]: HINT('c'),
      [G]: HINT('g'),
      [D]: { migrationWarning: false, precheckRisk: 'low-quality', reviewFailed: true, text: 'd' },
      [F]: 'not-an-object',
    },
    plans: [{ planNumber: 1, status: 'success', planId: '3600000000009999' }],
    active: { status: 'preparation-stopped', planNumber: 2, runId: RUN_ID, businessDate: DATE, reason: 'prepare-stopped:catalog-exhausted-or-safe-pagination-boundary' },
    firstPublishedPlan: null,
    confirmationConsumptions: [],
    manualUiPublicationFacts: [],
    preparationClosureFacts: [{
      status: 'preparationClosed', phase: 'preparing', businessDate: DATE, planNumber: 2,
      accountId: ACCOUNT, runId: RUN_ID,
      reason: 'prepare-stopped:catalog-exhausted-or-safe-pagination-boundary',
      zeroConsumptionProof: proof || { ...ZERO },
    }],
  };
}

function fakeContext() {
  const base = {
    addInitScript: async () => undefined,
    cookies: async () => [],
    storageState: async () => ({ cookies: [], origins: [] }),
    on: () => undefined,
    pages: () => [],
    newPage: async () => { throw new Error('newPage must not be used in this fixture'); },
    browser: () => ({}),
  };
  return new Proxy(base, {
    get(target, key) {
      if (key in target) return target[key];
      return async () => null;
    },
  });
}

async function runFixture(t, opts) {
  const proof = opts && opts.proof;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd38-retry-'));
  t.after(() => { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* temp cleanup */ } });
  const dir = path.join(root, 'shop-state', shopProfile.shopSlug({ shop: SHOP, accountId: ACCOUNT }));
  fs.mkdirSync(dir, { recursive: true });
  const stateFile = path.join(dir, 'plan-publisher-state.json');
  const attemptsFile = path.join(dir, 'plan-publication-attempts.json');
  const publishedFile = path.join(dir, 'published-products.json');
  fs.writeFileSync(path.join(dir, 'shop-identity.json'), JSON.stringify({ shop: SHOP, accountId: ACCOUNT }));
  fs.writeFileSync(stateFile, JSON.stringify(retryState(proof), null, 2));
  fs.writeFileSync(attemptsFile, JSON.stringify({
    consumed: { 'fixture-cid-plan-1': { status: 'success', businessDate: DATE, planNumber: 1, runId: PLAN1_RUN_ID } },
    finalConsumed: {},
    reopenConsumed: {},
  }, null, 2));
  fs.writeFileSync(publishedFile, JSON.stringify({ publishedIds: [C], plans: [] }, null, 2));
  const publishedBefore = fs.readFileSync(publishedFile, 'utf8');

  const readAccountFn = async () => ({ accountId: ACCOUNT });
  const clickSubTabFn = () => () => ({ clicked: true });
  const opened = {
    target: { evaluate: async (fn) => (fn === readAccountFn ? { accountId: ACCOUNT } : { clicked: true }) },
    context: fakeContext(),
  };
  let captured = null;
  const driversFactory = (ctx) => {
    captured = ctx;
    return {
      openCreationPage: async () => ({ header: { originOk: true, accountId: ACCOUNT, commissionOptionPresent: true } }),
      browseProducts: async (input) => {
        captured.browseInput = input;
        return { ok: false, reason: 'catalog-exhausted-or-safe-pagination-boundary' };
      },
      bindAccountsToAll: async () => { throw new Error('bindAccountsToAll must not run in this fixture'); },
      readMainTable: async () => [],
      repairDraft: async () => { throw new Error('repairDraft must not run in this fixture'); },
      configurePlan: async () => { throw new Error('configurePlan must not run in this fixture'); },
    };
  };

  const res = await rp.runScheduledPlan(
    { shop: SHOP, accountId: ACCOUNT, boundAccounts: [ACCOUNT], roi: 13.5, dailyBudget: 300 },
    {
      autoConfirm: true,
      policyProvider: () => ({ enabled: true, autoConfirm: true, plansPerShopPerDay: 3, dailyBudget: 300 }),
      businessDate: DATE,
      nowMs: () => NOW_MS,
      projectRoot: root,
      loadConfig: () => ({
        ready: true,
        config: {
          shops: [{ id: 'jin', name: SHOP, accountId: ACCOUNT, boundAccounts: [ACCOUNT], targetRoi: 13.5, plansPerShopPerDay: 3 }],
          login: {},
        },
      }),
      stateRoot: root,
      openShop: async () => opened,
      readers: {},
      readAccountInPage: readAccountFn,
      clickSubTab: clickSubTabFn,
      driversFactory,
      plansPerShopPerDay: 3,
      onLog: () => {},
    },
  );
  return { res, captured, stateFile, publishedFile, publishedBefore };
}

test('integration: the real hook releases lost attempted ids and rewinds the browse position before prepare', async (t) => {
  const h = await runFixture(t);
  assert.equal(h.res.status, 'preparation-stopped', JSON.stringify(h.res));
  assert.equal(h.res.planNumber, 2);

  // The driversFactory saw the released attempted set and the reachable cursor, and the very
  // browseProducts invocation inherits them — i.e. the helper output is actually reached.
  for (const id of [A, B, G]) assert.equal(h.captured.attemptedSet.has(id), false, id);
  for (const id of [C, D, E, F]) assert.equal(h.captured.attemptedSet.has(id), true, id);
  assert.equal(h.captured.browseInput.cursor.page, 1);
  assert.equal(h.captured.browseInput.cursor.category, FIRST_CATEGORY);
  assert.deepEqual([...h.captured.browseInput.attemptedSet].sort(), [C, D, E, F].sort());

  const after = JSON.parse(fs.readFileSync(h.stateFile, 'utf8'));
  assert.deepEqual(after.attempted, [C, D, E, F]);
  assert.equal(after.page, 1);
  assert.equal(after.category, FIRST_CATEGORY);
  assert.deepEqual(after.cursor, { category: FIRST_CATEGORY, page: 1, seenProductIds: [] });
  assert.equal(after.plans.length, 1, 'no plan record is written by a preparation stop');
  assert.equal(after.active.status, 'preparation-stopped');
  assert.equal(after.preparationClosureFacts.some(f => Number(f.planNumber) === 2), true);
  assert.equal(fs.readFileSync(h.publishedFile, 'utf8'), h.publishedBefore, 'published store is never rewritten');
});

test('integration: without a proven closure the hook releases nothing and keeps the terminal cursor', async (t) => {
  const h = await runFixture(t, { proof: { ...ZERO, initialConsumptions: 1 } });
  // The preparation still stops honestly; the point is that the retry release did NOT fire.
  assert.equal(h.res.status, 'preparation-stopped', JSON.stringify(h.res));
  for (const id of [A, B, G]) assert.equal(h.captured.attemptedSet.has(id), true, id);
  assert.equal(h.captured.browseInput.cursor.page, 62);
  assert.equal(h.captured.browseInput.cursor.category, FIRST_CATEGORY);
  const after = JSON.parse(fs.readFileSync(h.stateFile, 'utf8'));
  assert.deepEqual(after.attempted, [A, B, C, D, E, F, G]);
  assert.equal(after.cursor.page, 62);
});
