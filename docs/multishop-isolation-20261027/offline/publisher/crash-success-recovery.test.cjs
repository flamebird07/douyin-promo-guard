'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const wf = require('./plan-workflow.cjs');
const guard = require('./direct-draft-controller.cjs');
const rp = require('./run-plans.cjs');
const profile = require('./shop-profile.cjs');
const scheduler = require('../bill-manager/promo-plan-scheduler.js');
const { createDailyRunner } = require('./daily-plan-runner.cjs');

const DATE = '2040-01-02';
const NOW = Date.parse(DATE + 'T04:00:00Z');
const SHOP = 'D47 synthetic shop';
const ACCOUNT = '9000000000000001';
const runId = n => `plan-scheduler-${DATE}-${String(n).padStart(16, '0')}`;
const planId = n => String(9000000000000000n + BigInt(n));
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};
const snapshot = files => files.map(file => ({ file, bytes: fs.readFileSync(file).toString('hex'), mtime: fs.statSync(file, { bigint: true }).mtimeNs }));
const unchanged = before => assert.deepEqual(snapshot(before.map(x => x.file)), before);

function fixture(t, options = {}) {
  const forbidden = () => { throw new Error('browser, network and real publishing are forbidden'); };
  t.mock.method(globalThis, 'fetch', forbidden);
  for (const name of ['node:http', 'node:https']) {
    for (const method of ['request', 'get']) t.mock.method(require(name), method, forbidden);
  }
  for (const method of ['connect', 'createConnection']) t.mock.method(require('node:net'), method, forbidden);
  t.mock.method(require('node:net').Socket.prototype, 'connect', forbidden);
  t.mock.method(require('node:tls'), 'connect', forbidden);
  t.mock.method(rp, 'runScheduledPlan', forbidden);
  const root = fs.mkdtempSync(path.join(__dirname, '.d47-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const count = options.count || 1;
  const shop = { id: 'synthetic', name: SHOP, accountId: ACCOUNT, productsPerPlan: options.nativeSummary ? 30 : 3 };
  const dir = path.join(root, 'shop-state', profile.shopSlug({ shop: SHOP, accountId: ACCOUNT }));
  const files = {
    state: path.join(dir, 'plan-publisher-state.json'),
    attempts: path.join(dir, 'plan-publication-attempts.json'),
    published: path.join(dir, 'published-products.json'),
    identity: path.join(dir, 'shop-identity.json'),
    seed: path.join(dir, 'fixtures', 'published-plan-seed.json'),
    ledger: path.join(root, 'data', 'ledger.json'),
    config: path.join(root, 'config.json'),
  };
  write(files.identity, { shop: SHOP, accountId: ACCOUNT, verifiedAt: '2040-01-01T00:00:00.000Z' });
  write(files.seed, { accountId: ACCOUNT, shop: SHOP, productIds: [], plans: [],
    capturedAt: '2040-01-01T00:00:00.000Z', scope: 'account-history', sourceEvidence: 'synthetic',
    sourceSha256: 'a'.repeat(64) });
  if (!options.unseededAttempts) write(files.attempts, { consumed: {}, finalConsumed: {}, reopenConsumed: {} });
  let published = { publishedIds: [], plans: [] };
  const state = wf.newDayState(DATE);
  const entries = {};
  const frozen = [];
  const attempts = { consumed: {}, finalConsumed: {}, reopenConsumed: {} };
  for (let n = 1; n <= count; n++) {
    const f = options.nativeSummary ? {
      planNumber: n, runId: runId(n), businessDate: DATE, accountId: ACCOUNT,
      planName: 'Synthetic native plan ' + n, confirmationId: 'synthetic-native-cid-' + n,
      manifestHash: crypto.createHash('sha256').update('synthetic opaque stored hash ' + n).digest('hex'),
      productIds: Array.from({ length: 30 }, (_, i) => String(9000000000001000n + BigInt(n * 100 + i))),
    } : wf.freezePlan({ planNumber: n, runId: runId(n), businessDate: DATE,
      accountId: ACCOUNT, planName: 'Synthetic plan ' + n, roi: 15, dailyBudget: 300,
      commissionIncluded: true, directPay: false, boundAccounts: ['synthetic-binding'],
      productIds: Array.from({ length: 3 }, (_, i) => String(9000000000001000n + BigInt(n * 10 + i))),
      disclosures: { migration: [], precheck: [], reviewFailed: [] },
    }, { nowMs: NOW, nonce: String(n).repeat(32) });
    frozen.push(f);
    const receipt = { planNumber: n, runId: f.runId, businessDate: DATE, manifestHash: f.manifestHash,
      status: 'success', at: new Date(NOW).toISOString() };
    attempts.consumed[f.confirmationId] = { ...receipt };
    attempts.finalConsumed[f.confirmationId] = { ...receipt };
    if (options.nativeWriter) {
      guard.consumePublicationOnce(files.attempts, n, f.confirmationId, f);
      assert.equal(guard.recordPublicationOutcome(files.attempts, f.confirmationId, 'dispatched'), true);
      guard.consumeFinalConfirmationOnce(files.attempts, f.confirmationId, f.manifestHash);
      assert.equal(guard.recordFinalConfirmationOutcome(files.attempts, f.confirmationId, 'success'), true);
      assert.equal(guard.recordPublicationOutcome(files.attempts, f.confirmationId, 'success'), true);
      const native = read(files.attempts);
      for (const table of ['consumed', 'finalConsumed']) {
        const { at, ...scope } = native[table][f.confirmationId];
        const { at: syntheticAt, ...syntheticScope } = receipt;
        assert.equal(typeof at, 'string');
        assert.equal(typeof syntheticAt, 'string');
        assert.deepEqual(scope, syntheticScope);
      }
    }
    state.plans.push({ planNumber: n, status: 'success', planId: planId(n), manifestHash: f.manifestHash });
    published = wf.appendPublished(published, { productIds: f.productIds, planId: planId(n), date: DATE });
    if (n === 1) state.firstPublishedPlan = { planNumber: 1, status: 'success', planId: planId(1),
      account_id: ACCOUNT, product_ids: f.productIds.slice(), planName: f.planName,
      manifestHash: f.manifestHash, businessDate: DATE, runId: f.runId };
    entries[n] = n === count
      ? { planNumber: n, status: 'in-progress', startedAt: new Date(NOW).toISOString() }
      : { planNumber: n, status: 'success', planId: planId(n), at: 'preserved-original-at', enable: 'preserved-original-enable' };
  }
  state.runId = runId(options.nativeSummary ? count + 1 : count);
  if (options.nativeSummary) {
    const fact = { status: 'preparationClosed', phase: 'preparing',
      reason: 'prepare-stopped:account-anchor-account-identity-drift', source: 'scheduled-prepare-stopped',
      runId: state.runId, planNumber: count + 1, businessDate: DATE, shop: SHOP, accountId: ACCOUNT,
      zeroConsumptionProof: { initialConsumptions: 0, finalConsumptions: 0, reopenConsumptions: 0,
        manualUnresolved: 0, plansContainsNumber: false, confirmationConsumptionsRecorded: false },
      closedAt: new Date(NOW).toISOString() };
    state.active = { status: 'preparation-stopped', planNumber: fact.planNumber, runId: fact.runId,
      businessDate: DATE, originalPhase: 'preparing', reason: fact.reason, source: fact.source, closedAt: fact.closedAt };
    state.preparationClosureFacts = [fact];
  } else {
    state.active = { status: 'published-success', planNumber: count, frozen: frozen[count - 1],
      planId: planId(count), authorizedBy: 'recurring-user-policy', actionTaken: false };
  }
  const rec = { status: 'unknown', plans: count, error: 'unresolved-in-progress-no-replay', entries };
  const ledger = { version: 1, days: {
    [DATE]: { shops: { synthetic: rec,
      untouched: { status: 'success', plans: 1, entries: { 1: { planNumber: 1, status: 'success', planId: planId(8) } } } } },
    '2040-01-01': { shops: { synthetic: { status: 'success', plans: 1,
      entries: { 1: { planNumber: 1, status: 'success', planId: planId(9) } } } } },
  } };
  write(files.state, state);
  if (!options.nativeWriter) write(files.attempts, attempts);
  write(files.published, published);
  write(files.ledger, ledger);
  write(files.config, { enabled: true, autoConfirm: true, adapterRoot: root, stateRoot: root,
    login: { cookieWorkDir: root, cookieSourceDir: root }, shops: [shop] });
  const calls = { run: [], discovery: 0, open: 0, local: 0, ledgerWrites: 0, allowRun: false };
  const deps = {
    runPlan: async (_business, o) => {
      calls.run.push(o.planNumber);
      if (!calls.allowRun) throw new Error('runPlan forbidden during recovery');
      return { status: 'success', planId: planId(o.planNumber) };
    },
    readDaySuccess: (...args) => rp.readDaySuccessForShop(...args),
    discoverAccount: () => { calls.discovery++; throw new Error('forbidden discovery'); },
    resolvePublisherPaths: rp.resolvePublisherStatePaths,
    currentSourceHash: rp.currentPreOpenSourceHash,
    recoverLocalPreparation: () => { calls.local++; throw new Error('unexpected preparation recovery'); },
  };
  const schedulerModule = { ...scheduler, saveLedger: (...args) => { calls.ledgerWrites++; return scheduler.saveLedger(...args); } };
  const f = { root, dir, files, state, rec, ledger, frozen, deps, calls, schedulerModule,
    modify(name, fn) { const value = read(files[name]); fn(value); write(files[name], value); },
    next(status = 'preparing') {
      f.modify('state', s => { s.runId = runId(count + 1); s.active = { status, planNumber: count + 1,
        runId: s.runId, businessDate: DATE, reason: 'prepare-stopped:account-anchor-account-identity-drift' }; });
    },
    makeRunner() { return createDailyRunner({ configFile: files.config, dataDir: path.dirname(files.ledger), stateRoot: root,
      schedulerModule, deps, nowMs: () => NOW, openShop: () => { calls.open++; throw new Error('forbidden browser'); } }); },
    recover() { return f.makeRunner().recoverShopDay('synthetic', DATE); },
  };
  return f;
}

function noActions(f) {
  assert.deepEqual(f.calls.run, []);
  assert.equal(f.calls.discovery, 0);
  assert.equal(f.calls.open, 0);
  assert.equal(f.calls.local, 0);
}

async function rejected(f, expected) {
  const before = snapshot(Object.values(f.files).filter(file => fs.existsSync(file)));
  const result = await f.recover();
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.released, false);
  if (expected) assert.match(result.reason, expected);
  unchanged(before);
  assert.equal(f.calls.ledgerWrites, 0);
  noActions(f);
  return result;
}

test('D47 retained native frozen: recover one entry without browser, then byte/mtime no-op', async t => {
  const forbidden = () => { throw new Error('network is forbidden during local recovery'); };
  t.mock.method(globalThis, 'fetch', forbidden);
  t.mock.method(require('node:http'), 'request', forbidden);
  t.mock.method(require('node:https'), 'request', forbidden);
  t.mock.method(require('node:net'), 'connect', forbidden);
  t.mock.method(require('node:tls'), 'connect', forbidden);
  const f = fixture(t, { nativeWriter: true });
  const durable = snapshot([f.files.state, f.files.attempts, f.files.published, f.files.identity]);
  const result = await f.recover();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.released, true);
  assert.equal(result.planId, planId(1));
  const after = read(f.files.ledger);
  const rec = after.days[DATE].shops.synthetic;
  assert.equal(rec.status, 'partial');
  assert.equal(rec.plans, 1);
  assert.equal(rec.error, null);
  assert.equal(rec.entries[1].startedAt, f.rec.entries[1].startedAt);
  assert.equal(rec.entries[1].recoveredBy, 'durable-crash-success-recovery');
  assert.equal(rec.entries[1].authorizedBy, undefined);
  assert.deepEqual(after.days['2040-01-01'], f.ledger.days['2040-01-01']);
  assert.deepEqual(after.days[DATE].shops.untouched, f.ledger.days[DATE].shops.untouched);
  unchanged(durable);
  const beforeAgain = snapshot(Object.values(f.files));
  const again = await f.recover();
  assert.equal(again.idempotent, true, JSON.stringify(again));
  assert.equal(again.released, false);
  assert.equal(f.calls.ledgerWrites, 1);
  unchanged(beforeAgain);
  noActions(f);
});

test('D47 next preparation without a trusted closure still cannot prove native success', async t => {
  for (const status of ['preparing', 'preparation-stopped']) await t.test(status, async st => {
    const f = fixture(st);
    f.next(status);
    const first = read(f.files.state).firstPublishedPlan;
    for (const key of ['roi', 'dailyBudget', 'commissionIncluded', 'directPay', 'boundAccounts', 'disclosures']) {
      assert.equal(Object.hasOwn(first, key), false);
    }
    await rejected(f, /^recovery-crash-native-next-closure-not-proven$/);
  });
});

test('D47 absent/historical active cannot supply a lost target frozen manifest', async t => {
  await t.test('absent active', async st => {
    const f = fixture(st);
    f.modify('state', s => { s.active = null; });
    await rejected(f, /frozen-unavailable-without-active/);
  });
  await t.test('historical active is not the current success', async st => {
    const f = fixture(st);
    f.modify('state', s => { s.active.businessDate = '2040-01-01'; });
    await rejected(f, /active-identity-conflict/);
  });
  await t.test('invented history field is never a proof source', async st => {
    const f = fixture(st);
    f.modify('state', s => { s.activeHistory = [s.active]; s.active = null; });
    await rejected(f, /frozen-unavailable-without-active/);
  });
});

test('D47 scheduler only dispatches remaining numbers and preserves existing success entries', async t => {
  const f = fixture(t, { count: 2 });
  const firstBytes = JSON.stringify(f.rec.entries[1]);
  assert.equal((await f.recover()).ok, true);
  const recovered = JSON.stringify(read(f.files.ledger).days[DATE].shops.synthetic.entries[2]);
  f.calls.allowRun = true;
  const runner = f.makeRunner();
  const tick = await runner.tick();
  assert.equal(tick.ran, true);
  assert.deepEqual(f.calls.run, [3]);
  await runner.tick();
  assert.deepEqual(f.calls.run, [3]);
  const rec = read(f.files.ledger).days[DATE].shops.synthetic;
  assert.equal(rec.status, 'success');
  assert.equal(JSON.stringify(rec.entries[1]), firstBytes);
  assert.equal(JSON.stringify(rec.entries[2]), recovered);
  assert.equal(f.calls.open, 0);
  assert.equal(f.calls.discovery, 0);
});

test('D47 all slots proven: converge success without dispatch', async t => {
  const f = fixture(t, { count: 3 });
  assert.equal((await f.recover()).ok, true);
  assert.equal(read(f.files.ledger).days[DATE].shops.synthetic.status, 'success');
  await f.makeRunner().tick();
  noActions(f);
});

const mutations = [
  ['only cached count', 'state', s => { s.plans = []; s.active = null; }],
  ['missing final table', 'attempts', a => { delete a.finalConsumed; }],
  ['null reopen table', 'attempts', a => { a.reopenConsumed = null; }],
  ['array consumed table', 'attempts', a => { a.consumed = []; }],
  ['missing paired final', 'attempts', a => { a.finalConsumed = {}; }],
  ['unknown initial', 'attempts', a => { Object.values(a.consumed)[0].status = 'unknown'; }],
  ['unknown final', 'attempts', a => { Object.values(a.finalConsumed)[0].status = 'unknown'; }],
  ['final CID mismatch', 'attempts', a => { a.finalConsumed.foreign = Object.values(a.finalConsumed)[0]; delete a.finalConsumed[Object.keys(a.consumed)[0]]; }],
  ['extra unresolved initial', 'attempts', a => { a.consumed.extra = { status: 'pending', businessDate: DATE, planNumber: 2, runId: runId(2) }; }],
  ['extra unresolved final', 'attempts', a => { a.finalConsumed.extra = { status: 'pending' }; }],
  ['reopen consumption', 'attempts', a => { a.reopenConsumed.extra = { status: 'success' }; }],
  ['final manifest conflict', 'attempts', a => { Object.values(a.finalConsumed)[0].manifestHash = 'f'.repeat(64); }],
  ['attempt different run', 'attempts', a => { Object.values(a.finalConsumed)[0].runId = runId(8); }],
  ['attempt cross date', 'attempts', a => { Object.values(a.consumed)[0].businessDate = '2040-01-01'; }],
  ['attempt cross shop', 'attempts', a => { Object.values(a.consumed)[0].shop = 'other synthetic shop'; }],
  ['state cross date', 'state', s => { s.businessDate = '2040-01-01'; }],
  ['state cross account', 'state', s => { s.accountId = '9000000000000002'; }],
  ['state unresolved flag', 'state', s => { s.pending = true; }],
  ['day plan ID conflict', 'state', s => { s.plans[0].planId = planId(8); }],
  ['duplicate day plan', 'state', s => { s.plans.push({ ...s.plans[0] }); }],
  ['manual publication fact', 'state', s => { s.manualUiPublicationFacts.push({ status: 'unknown' }); }],
  ['missing confirmation list', 'state', s => { delete s.confirmationConsumptions; }],
  ['extra state consumption', 'state', s => { s.confirmationConsumptions.push({ confirmationId: 'extra', planNumber: 2 }); }],
  ['frozen missing', 'state', s => { delete s.active.frozen; }],
  ['frozen missing disclosures', 'state', s => { delete s.active.frozen.disclosures; }],
  ['frozen product drift', 'state', s => { s.active.frozen.productIds[0] = '9000000000009999'; }],
  ['frozen account drift', 'state', s => { s.active.frozen.accountId = '9000000000000002'; }],
  ['frozen CID drift', 'state', s => { s.active.frozen.confirmationId = 'wrong-cid'; }],
  ['active unresolved', 'state', s => { s.active.status = 'publish-finalizing'; }],
  ['active run drift', 'state', s => { s.active.runId = runId(8); }],
  ['first plan product drift', 'state', s => { s.firstPublishedPlan.product_ids.reverse(); }],
  ['first plan run drift', 'state', s => { s.firstPublishedPlan.runId = runId(8); }],
  ['published duplicate plan', 'published', p => { p.plans.push({ ...p.plans[0] }); }],
  ['published cross date', 'published', p => { p.plans[0].date = '2040-01-01'; }],
  ['published cross shop', 'published', p => { p.plans[0].shop = 'other synthetic shop'; }],
  ['published missing product', 'published', p => { p.publishedIds.pop(); }],
  ['published missing plans', 'published', p => { delete p.plans; }],
  ['published extra same-day plan', 'published', p => { p.plans.push({ planId: planId(8), date: DATE }); }],
  ['entry run drift', 'ledger', l => { l.days[DATE].shops.synthetic.entries[1].runId = runId(8); }],
  ['entry date drift', 'ledger', l => { l.days[DATE].shops.synthetic.entries[1].businessDate = '2040-01-01'; }],
  ['entry CID drift', 'ledger', l => { l.days[DATE].shops.synthetic.entries[1].confirmationId = 'other'; }],
  ['entry manifest drift', 'ledger', l => { l.days[DATE].shops.synthetic.entries[1].manifestHash = 'f'.repeat(64); }],
  ['entry plan ID drift', 'ledger', l => { l.days[DATE].shops.synthetic.entries[1].planId = planId(8); }],
  ['entry key drift', 'ledger', l => { l.days[DATE].shops.synthetic.entries[1].planNumber = 2; }],
  ['extra in-progress', 'ledger', l => { l.days[DATE].shops.synthetic.entries[2] = { status: 'in-progress', planNumber: 2 }; }],
  ['extra unknown', 'ledger', l => { l.days[DATE].shops.synthetic.entries[2] = { status: 'unknown', planNumber: 2 }; }],
  ['identity cross shop', 'identity', i => { i.shop = 'other synthetic shop'; }],
  ['initial plan ID conflict', 'attempts', a => { Object.values(a.consumed)[0].planId = planId(8); }],
  ['initial CID field conflict', 'attempts', a => { Object.values(a.consumed)[0].confirmationId = 'foreign-cid'; }],
  ['initial product conflict', 'attempts', a => { Object.values(a.consumed)[0].productIds = []; }],
  ['final plan name conflict', 'attempts', a => { Object.values(a.finalConsumed)[0].planName = 'foreign-name'; }],
  ['published product set conflict', 'published', p => { p.plans[0].productIds = ['9000000000009999']; }],
  ['published CID conflict', 'published', p => { p.plans[0].confirmationId = 'foreign-cid'; }],
  ['native authorization missing', 'state', s => { delete s.active.authorizedBy; }],
  ['native action flag conflicts', 'state', s => { s.active.actionTaken = true; }],
  ['frozen ROI missing', 'state', s => { delete s.active.frozen.roi; }],
  ['frozen budget missing', 'state', s => { delete s.active.frozen.dailyBudget; }],
  ['frozen bindings missing', 'state', s => { delete s.active.frozen.boundAccounts; }],
  ['frozen flags missing', 'state', s => { delete s.active.frozen.directPay; }],
  ['duplicate CID for same plan', 'attempts', a => {
    a.consumed.duplicate = { ...Object.values(a.consumed)[0], runId: runId(8) };
    a.finalConsumed.duplicate = { ...a.consumed.duplicate };
  }],
  ['historical date hides current run', 'attempts', a => {
    a.consumed.duplicate = { ...Object.values(a.consumed)[0], businessDate: '2040-01-01' };
    a.finalConsumed.duplicate = { ...a.consumed.duplicate };
  }],
];
for (const [name, file, mutate] of mutations) test('D47 zero-write refusal: ' + name, async t => {
  const f = fixture(t);
  f.modify(file, mutate);
  await rejected(f, /^recovery-crash-/);
});

for (const file of ['state', 'attempts', 'published']) test('D47 zero-write refusal: unreadable ' + file, async t => {
  const f = fixture(t);
  fs.writeFileSync(f.files[file], '{broken');
  await rejected(f, /unreadable/);
});

for (const file of ['state', 'attempts', 'published']) test('D47 zero-write refusal: missing ' + file, async t => {
  const f = fixture(t);
  fs.unlinkSync(f.files[file]);
  await rejected(f, /unreadable/);
  assert.equal(fs.existsSync(f.files[file]), false);
});

test('D47 unsafe subsequent active never counts as zero consumption', async t => {
  const cases = [
    ['wrong number', s => { s.active.planNumber = 3; }],
    ['wrong run date', s => { s.active.runId = 'plan-scheduler-2040-01-01-0000000000000002'; }],
    ['wrong business date', s => { s.active.businessDate = '2040-01-01'; }],
    ['wrong shop', s => { s.active.shop = 'other synthetic shop'; }],
    ['wrong account', s => { s.active.accountId = '9000000000000002'; }],
    ['frozen from another plan', s => { s.active.frozen = { planNumber: 2 }; }],
    ['CID artifact', s => { s.active.confirmationId = 'next-cid'; }],
    ['same run as success', s => { s.active.runId = s.runId = runId(1); }],
    ['ready confirmation', s => { s.active.status = 'ready-awaiting-confirmation'; }],
  ];
  for (const [name, mutate] of cases) await t.test(name, async st => {
    const f = fixture(st);
    f.next(); f.modify('state', mutate);
    await rejected(f, /next-preparation-not-safe|next-preparation-consumed|active-/);
  });
});

test('D47 next preparation with extra consumption or borrowed frozen is refused', async t => {
  await t.test('next run consumed', async st => {
    const f = fixture(st);
    f.next();
    f.modify('attempts', a => { a.consumed.next = { planNumber: 2, runId: runId(2), businessDate: DATE,
      manifestHash: 'e'.repeat(64), status: 'unknown' }; });
    await rejected(f, /consumption-not-success-pair/);
  });
  await t.test('complete target frozen attached to next active', async st => {
    const f = fixture(st);
    f.next();
    f.modify('state', s => { s.active.frozen = f.frozen[0]; });
    await rejected(f, /next-preparation-not-safe/);
  });
});

test('D47 noncontiguous successes cannot make the scheduler skip a gap', async t => {
  const f = fixture(t, { count: 2 });
  f.modify('ledger', l => { delete l.days[DATE].shops.synthetic.entries[1]; });
  f.modify('state', s => { s.plans.shift(); });
  await rejected(f, /noncontiguous-success/);
});

test('D47 idempotent calls recheck source bytes under lock before returning', async t => {
  const f = fixture(t);
  assert.equal((await f.recover()).ok, true);
  f.calls.ledgerWrites = 0;
  let reads = 0;
  f.deps.currentSourceHash = (...args) => ++reads === 3 ? 'f'.repeat(64) : rp.currentPreOpenSourceHash(...args);
  await rejected(f, /source-drift-under-lock/);
});

test('D47 historical paired success stays inert, historical unresolved blocks', async t => {
  const f = fixture(t);
  f.modify('attempts', a => {
    const old = { status: 'success', businessDate: '2040-01-01', planNumber: 1,
      runId: 'plan-scheduler-2040-01-01-0000000000000008', manifestHash: 'a'.repeat(64) };
    a.consumed['synthetic-history'] = old;
    a.finalConsumed['synthetic-history'] = { ...old };
  });
  assert.equal((await f.recover()).ok, true);
  f.calls.ledgerWrites = 0;
  f.modify('attempts', a => { a.finalConsumed['synthetic-history'].status = 'unknown'; });
  await rejected(f, /consumption-not-success-pair/);
});

test('D47 source drift before and inside scheduler lock refuses writes', async t => {
  for (const call of [2, 3]) await t.test('hash read ' + call, async st => {
    const f = fixture(st);
    let reads = 0;
    f.deps.currentSourceHash = (...args) => {
      if (++reads === call) return 'f'.repeat(64);
      return rp.currentPreOpenSourceHash(...args);
    };
    await rejected(f, /source-drift/);
  });
});

test('D47 actual source and ledger mutations at lock acquisition are detected', async t => {
  for (const file of ['state', 'attempts', 'published', 'identity', 'ledger']) await t.test(file, async st => {
    const f = fixture(st);
    const ledgerBefore = snapshot([f.files.ledger]);
    f.schedulerModule.acquireProcessLock = (...args) => {
      const lock = scheduler.acquireProcessLock(...args);
      fs.appendFileSync(f.files[file], '\n');
      if (file === 'ledger') f.modify('ledger', l => { l.days[DATE].shops.synthetic.entries[1].startedAt = '2040-01-02T03:00:00Z'; });
      return lock;
    };
    const result = await f.recover();
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.reason, /source-drift-under-lock|record-drift-under-lock/);
    if (file !== 'ledger') unchanged(ledgerBefore);
    assert.equal(f.calls.ledgerWrites, 0);
    noActions(f);
  });
});

test('D47 scheduler and publisher locks are never stolen', async t => {
  for (const kind of ['scheduler', 'publisher', 'publisher-recovery']) await t.test(kind, async st => {
    const f = fixture(st);
    const lock = kind === 'scheduler' ? f.files.ledger + '.lock'
      : path.join(f.dir, 'plan-publisher.lock' + (kind === 'publisher-recovery' ? '.recovery' : ''));
    write(lock, { pid: process.pid, at: new Date(NOW).toISOString(), startedAt: new Date(NOW).toISOString(), token: '1'.repeat(32) });
    const before = snapshot([lock]);
    await rejected(f, /lock-busy/);
    unchanged(before);
  });
});

test('D47 R16 branch keeps its precise reason and readback provenance requirement', async t => {
  const f = fixture(t);
  f.modify('ledger', l => { l.days[DATE].shops.synthetic.entries[1] = {
    planNumber: 1, status: 'unknown', reason: 'management-identity-hydrate-timeout' }; });
  await rejected(f, /recovery-readback-active-not-readback-recovered/);
  f.modify('state', s => { s.active.recoveredBy = 'scheduled-readback-recovery'; });
  assert.equal((await f.recover()).ok, true);
  assert.equal(read(f.files.ledger).days[DATE].shops.synthetic.entries[1].recoveredBy, 'scheduled-readback-recovery');
  const before = snapshot(Object.values(f.files));
  assert.equal((await f.recover()).idempotent, true);
  unchanged(before);
});

test('D47 unrelated unknown remains no-replay under the unchanged scheduler', async t => {
  const f = fixture(t);
  f.modify('ledger', l => { l.days[DATE].shops.synthetic.entries[1] = { planNumber: 1, status: 'unknown', reason: 'unrelated-unknown' }; });
  const runner = f.makeRunner();
  await runner.tick();
  noActions(f);
  assert.equal(read(f.files.ledger).days[DATE].shops.synthetic.entries[1].status, 'unknown');
});

test('D47 canonical unconsumed preparing recovery remains available', async t => {
  const f = fixture(t);
  const s = wf.newDayState(DATE);
  s.active = { status: 'preparing', planNumber: 1, runId: runId(1), businessDate: DATE };
  write(f.files.state, s);
  write(f.files.attempts, { consumed: {}, finalConsumed: {}, reopenConsumed: {} });
  write(f.files.published, { publishedIds: [], plans: [] });
  f.modify('ledger', l => { l.days[DATE].shops.synthetic.plans = 0; });
  f.deps.recoverLocalPreparation = rp.recoverLocalPreparationClose;
  const result = await f.recover();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(read(f.files.ledger).days[DATE].shops.synthetic.entries[1].status, 'preparation-stopped');
  assert.equal(read(f.files.ledger).days[DATE].shops.synthetic.plans, 0);
});

test('D47 fixture stays synthetic and read-only dependencies stay unchanged during recovery', async t => {
  const files = [path.join(__dirname, 'run-plans.cjs'), path.join(__dirname, 'plan-workflow.cjs'),
    path.join(__dirname, '..', 'bill-manager', 'promo-plan-scheduler.js')];
  const hashes = () => files.map(f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'));
  const before = hashes();
  const f = fixture(t);
  assert.equal((await f.recover()).ok, true);
  assert.deepEqual(hashes(), before);
  assert.equal(path.relative(__dirname, f.root).startsWith('..'), false);
  noActions(f);
});

function nativeFixture(t, options = {}) {
  const f = fixture(t, { ...options, nativeSummary: true });
  f.modify('attempts', a => {
    for (let n = 1; n <= 44; n++) {
      const date = new Date(NOW - n * 86400000).toISOString().slice(0, 10);
      const old = { status: 'success', businessDate: date, planNumber: 1,
        runId: `plan-scheduler-${date}-${String(n).padStart(16, '0')}`, manifestHash: 'a'.repeat(64),
        at: date + 'T04:00:00.000Z' };
      a.consumed['synthetic-history-' + n] = old;
      a.finalConsumed['synthetic-history-' + n] = { ...old };
    }
  });
  return f;
}

const NATIVE_METHOD = 'native-first-success-summary-ledger-convergence';
const NATIVE_SOURCE = 'native-first-success-summary-recovery';
const NATIVE_NOTICE = 'native-summary proof，未重算原始manifest；不用于新发布授权';

test('D47-R2 native writer summary without frozen: recover once, reprove byte/mtime no-op', async t => {
  const f = nativeFixture(t, { nativeWriter: true });
  const state = read(f.files.state);
  const attempts = read(f.files.attempts);
  assert.deepEqual(Object.keys(state.firstPublishedPlan).sort(),
    ['planNumber', 'status', 'planId', 'account_id', 'product_ids', 'planName', 'manifestHash', 'businessDate', 'runId'].sort());
  assert.equal(state.firstPublishedPlan.product_ids.length, 30);
  assert.equal(Object.keys(attempts.consumed).length, 45);
  assert.equal(Object.keys(attempts.finalConsumed).length, 45);
  assert.deepEqual(attempts.reopenConsumed, {});
  assert.deepEqual(state.confirmationConsumptions, []);
  assert.deepEqual(state.manualUiPublicationFacts, []);
  for (const record of [state, ...Object.values(attempts.consumed), ...Object.values(attempts.finalConsumed)]) {
    assert.doesNotMatch(JSON.stringify(record), /"(?:frozen|nonce|roi|dailyBudget|boundAccounts|disclosures)":/);
  }
  assert.deepEqual(read(f.files.published).plans, [{ planId: planId(1), date: DATE }]);
  t.mock.method(wf, 'manifestHash', () => { throw new Error('native summary must not recompute a manifest'); });
  const sources = snapshot([f.files.state, f.files.attempts, f.files.published, f.files.identity, f.files.seed]);
  f.modify('ledger', l => { l.days[DATE].shops.synthetic.partial = true; });
  const result = await f.recover();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.released, true);
  assert.equal(result.method, NATIVE_METHOD);
  assert.equal(result.recoveredBy, NATIVE_SOURCE);
  assert.equal(result.proof, NATIVE_NOTICE);
  assert.equal(result.manifestRecomputed, false);
  assert.equal(result.newPublicationAuthorized, false);
  const ledger = read(f.files.ledger);
  const rec = ledger.days[DATE].shops.synthetic;
  assert.equal(rec.status, 'partial');
  assert.equal(rec.plans, 1);
  assert.equal(rec.error, null);
  assert.equal(Object.hasOwn(rec, 'partial'), false);
  assert.deepEqual(Object.keys(rec.entries), ['1']);
  assert.equal(rec.entries[1].status, 'success');
  assert.equal(rec.entries[1].runId, runId(1));
  assert.equal(rec.entries[1].planId, planId(1));
  assert.equal(rec.entries[1].confirmationId, Object.keys(attempts.consumed)[0]);
  assert.equal(rec.entries[1].manifestHash, state.firstPublishedPlan.manifestHash);
  assert.equal(rec.entries[1].startedAt, f.rec.entries[1].startedAt);
  assert.equal(rec.entries[1].sourceHash, result.sourceHash);
  assert.equal(rec.entries[1].authorizedBy, undefined);
  assert.equal(JSON.stringify(ledger.days['2040-01-01']), JSON.stringify(f.ledger.days['2040-01-01']));
  assert.equal(JSON.stringify(ledger.days[DATE].shops.untouched), JSON.stringify(f.ledger.days[DATE].shops.untouched));
  unchanged(sources);
  const beforeAgain = snapshot(Object.values(f.files));
  const again = await f.recover();
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.idempotent, true);
  assert.equal(again.released, false);
  assert.equal(again.method, NATIVE_METHOD);
  assert.equal(again.proof, NATIVE_NOTICE);
  assert.equal(f.calls.ledgerWrites, 1);
  unchanged(beforeAgain);
  noActions(f);
});

for (const limit of [2, 3]) test('D47-R2 native recovery then unchanged scheduler fills only 2..' + limit, async t => {
  const f = nativeFixture(t);
  f.modify('config', c => { c.plansPerShopPerDay = limit; });
  f.modify('ledger', l => { l.days[DATE].shops.synthetic.plans = 99; });
  const sources = snapshot([f.files.state, f.files.attempts, f.files.published, f.files.identity, f.files.seed]);
  assert.equal((await f.recover()).method, NATIVE_METHOD);
  noActions(f);
  const first = JSON.stringify(read(f.files.ledger).days[DATE].shops.synthetic.entries[1]);
  f.calls.allowRun = true;
  const runner = f.makeRunner();
  assert.equal((await runner.tick()).ran, true);
  await runner.tick();
  assert.deepEqual(f.calls.run, limit === 2 ? [2] : [2, 3]);
  assert.equal(JSON.stringify(read(f.files.ledger).days[DATE].shops.synthetic.entries[1]), first);
  assert.equal(read(f.files.ledger).days[DATE].shops.synthetic.plans, limit);
  unchanged(sources);
  assert.equal(f.calls.open, 0);
  assert.equal(f.calls.discovery, 0);
  assert.equal(f.calls.local, 0);
});

const fullManifestOnlyMutations = new Set(['frozen missing', 'frozen missing disclosures', 'frozen product drift',
  'frozen account drift', 'frozen CID drift', 'first plan product drift', 'native authorization missing',
  'frozen ROI missing', 'frozen budget missing', 'frozen bindings missing', 'frozen flags missing']);
for (const [name, file, mutate] of mutations.filter(([name]) => !fullManifestOnlyMutations.has(name))) {
  test('D47-R2 native shared zero-write refusal: ' + name, async t => {
    const f = nativeFixture(t);
    f.modify(file, mutate);
    await rejected(f, /^recovery-crash-/);
  });
}

const nativeMutations = [
  ['missing first summary', 'state', s => { delete s.firstPublishedPlan; }],
  ['non-first summary', 'state', s => { s.firstPublishedPlan.planNumber = 2; }],
  ['summary unknown', 'state', s => { s.firstPublishedPlan.status = 'unknown'; }],
  ['summary missing name', 'state', s => { delete s.firstPublishedPlan.planName; }],
  ['summary empty name', 'state', s => { s.firstPublishedPlan.planName = ' '; }],
  ['summary missing account', 'state', s => { delete s.firstPublishedPlan.account_id; }],
  ['summary missing product', 'state', s => { s.firstPublishedPlan.product_ids.pop(); }],
  ['summary duplicate product', 'state', s => { s.firstPublishedPlan.product_ids[1] = s.firstPublishedPlan.product_ids[0]; }],
  ['summary invalid product', 'state', s => { s.firstPublishedPlan.product_ids[0] = 'not-a-product'; }],
  ['summary numeric product', 'state', s => { s.firstPublishedPlan.product_ids[0] = Number(s.firstPublishedPlan.product_ids[0]); }],
  ['summary hash conflict', 'state', s => { s.firstPublishedPlan.manifestHash = 'f'.repeat(64); }],
  ['summary CID conflict', 'state', s => { s.firstPublishedPlan.confirmationId = 'foreign'; }],
  ['summary cross date', 'state', s => { s.firstPublishedPlan.businessDate = '2040-01-01'; }],
  ['summary cross shop', 'state', s => { s.firstPublishedPlan.shop = 'another synthetic shop'; }],
  ['summary account alias conflict', 'state', s => { s.firstPublishedPlan.accountId = '9000000000000002'; }],
  ['summary borrowed frozen', 'state', s => { s.firstPublishedPlan.frozen = {}; }],
  ['summary nonce artifact', 'state', s => { s.firstPublishedPlan.nonce = 'invented'; }],
  ['conflicting carried product order', 'state', s => { s.plans[0].productIds = s.firstPublishedPlan.product_ids.slice().reverse(); }],
  ['missing closure', 'state', s => { delete s.preparationClosureFacts; }],
  ['empty closure', 'state', s => { s.preparationClosureFacts = []; }],
  ['duplicate closure', 'state', s => { s.preparationClosureFacts.push({ ...s.preparationClosureFacts[0] }); }],
  ['extra unresolved closure', 'state', s => { s.preparationClosureFacts.push({ status: 'unknown' }); }],
  ['missing zero proof', 'state', s => { delete s.preparationClosureFacts[0].zeroConsumptionProof; }],
  ['extra zero proof field', 'state', s => { s.preparationClosureFacts[0].zeroConsumptionProof.extra = 0; }],
  ['boolean zero proof', 'state', s => { s.preparationClosureFacts[0].zeroConsumptionProof = true; }],
  ['preparing with copied closure', 'state', s => { s.active.status = 'preparing'; }],
  ['no active with copied closure', 'state', s => { s.active = null; }],
  ['historical active', 'state', s => { s.active.businessDate = '2040-01-01'; }],
  ['next run equals original', 'state', s => { s.active.runId = s.runId = s.preparationClosureFacts[0].runId = runId(1); }],
  ['original run equals next', 'attempts', a => {
    Object.values(a.consumed)[0].runId = runId(2); Object.values(a.finalConsumed)[0].runId = runId(2);
  }],
  ['borrowed next frozen', 'state', s => { s.active.frozen = { planNumber: 2 }; }],
  ['closure frozen artifact', 'state', s => { s.preparationClosureFacts[0].frozen = {}; }],
  ['active CID artifact', 'state', s => { s.active.confirmationId = 'next-cid'; }],
  ['closure CID artifact', 'state', s => { s.preparationClosureFacts[0].confirmationId = 'next-cid'; }],
  ['active manifest artifact', 'state', s => { s.active.manifestHash = 'f'.repeat(64); }],
  ['active plan ID artifact', 'state', s => { s.active.planId = planId(2); }],
  ['next consumption', 'attempts', a => { a.consumed.next = { status: 'unknown', runId: runId(2), planNumber: 2, businessDate: DATE }; }],
  ['historical unresolved', 'attempts', a => { a.finalConsumed['synthetic-history-44'].status = 'unknown'; }],
  ['empty paired CID', 'attempts', a => {
    const cid = Object.keys(a.consumed)[0];
    a.consumed[''] = a.consumed[cid]; a.finalConsumed[''] = a.finalConsumed[cid];
    delete a.consumed[cid]; delete a.finalConsumed[cid];
  }],
  ['record plan ID conflict', 'ledger', l => { l.days[DATE].shops.synthetic.planId = planId(8); }],
  ['record run conflict', 'ledger', l => { l.days[DATE].shops.synthetic.runId = runId(8); }],
  ['record hash conflict', 'ledger', l => { l.days[DATE].shops.synthetic.manifestHash = 'f'.repeat(64); }],
  ['entry missing start', 'ledger', l => { delete l.days[DATE].shops.synthetic.entries[1].startedAt; }],
  ['entry invalid start', 'ledger', l => { l.days[DATE].shops.synthetic.entries[1].startedAt = 'invalid'; }],
  ['zero-consumption next exceeds limit', 'config', c => { c.plansPerShopPerDay = 1; }],
];
for (const [name, file, mutate] of nativeMutations) test('D47-R2 native zero-write refusal: ' + name, async t => {
  const f = nativeFixture(t);
  f.modify(file, mutate);
  await rejected(f, /^recovery-crash-/);
});

for (const field of ['initialConsumptions', 'finalConsumptions', 'reopenConsumptions', 'manualUnresolved',
  'plansContainsNumber', 'confirmationConsumptionsRecorded']) {
  for (const kind of ['missing', 'nonzero']) test('D47-R2 strict six-zero: ' + field + '/' + kind, async t => {
    const f = nativeFixture(t);
    f.modify('state', s => {
      const p = s.preparationClosureFacts[0].zeroConsumptionProof;
      if (kind === 'missing') delete p[field];
      else p[field] = typeof p[field] === 'boolean' ? true : '0';
    });
    await rejected(f, /native-next-closure-not-proven/);
  });
}

for (const [field, value] of Object.entries({ status: 'unknown', phase: 'ready-awaiting-confirmation',
  runId: runId(8), businessDate: '2040-01-01', shop: 'foreign synthetic shop', accountId: '9000000000000002',
  planNumber: 3, reason: 'prepare-stopped:other', source: 'read-only-recovery', closedAt: 'invalid' })) {
  test('D47-R2 closure field conflict: ' + field, async t => {
    const f = nativeFixture(t);
    f.modify('state', s => { s.preparationClosureFacts[0][field] = value; });
    await rejected(f, /native-next-closure-not-proven/);
  });
}

for (const [field, value] of Object.entries({ originalPhase: 'ready-awaiting-confirmation',
  runId: runId(8), businessDate: '2040-01-01', planNumber: 3, reason: 'prepare-stopped:other',
  source: 'read-only-recovery', closedAt: 'invalid', account_id: '9000000000000002' })) {
  test('D47-R2 active closure field conflict: ' + field, async t => {
    const f = nativeFixture(t);
    f.modify('state', s => { s.active[field] = value; });
    await rejected(f, /^recovery-crash-/);
  });
}

test('D47-R2 native summary mode never recovers a later success prefix', async t => {
  const f = nativeFixture(t, { count: 2 });
  await rejected(f, /native-first-only/);
});

for (const file of ['state', 'attempts', 'published', 'identity', 'seed']) {
  test('D47-R2 real source bytes drift under scheduler lock: ' + file, async t => {
    const f = nativeFixture(t);
    const ledgerBefore = snapshot([f.files.ledger]);
    f.schedulerModule.acquireProcessLock = (...args) => {
      const lock = scheduler.acquireProcessLock(...args);
      fs.appendFileSync(f.files[file], '\n');
      return lock;
    };
    const result = await f.recover();
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.reason, /source-drift-under-lock/);
    unchanged(ledgerBefore);
    assert.equal(f.calls.ledgerWrites, 0);
    noActions(f);
  });
  test('D47-R2 native idempotence binds original source bytes: ' + file, async t => {
    const f = nativeFixture(t);
    assert.equal((await f.recover()).ok, true);
    f.calls.ledgerWrites = 0;
    fs.appendFileSync(f.files[file], '\n');
    await rejected(f, /native-idempotent-source-conflict/);
  });
}

for (const call of [2, 3]) test('D47-R2 source CAS read ' + call + ' fails closed', async t => {
  const f = nativeFixture(t);
  let reads = 0;
  f.deps.currentSourceHash = (...args) => ++reads === call ? 'f'.repeat(64) : rp.currentPreOpenSourceHash(...args);
  await rejected(f, /source-drift/);
});

for (const kind of ['scheduler', 'publisher', 'publisher-recovery']) test('D47-R2 native lock busy: ' + kind, async t => {
  const f = nativeFixture(t);
  const lock = kind === 'scheduler' ? f.files.ledger + '.lock'
    : path.join(f.dir, 'plan-publisher.lock' + (kind === 'publisher-recovery' ? '.recovery' : ''));
  write(lock, { pid: process.pid, at: new Date(NOW).toISOString(), startedAt: new Date(NOW).toISOString(), token: '2'.repeat(32) });
  const before = snapshot([lock]);
  await rejected(f, /lock-busy/);
  unchanged(before);
});

for (const kind of ['publisher', 'publisher-recovery', 'ledger']) test('D47-R2 lock-time recheck: ' + kind, async t => {
  const f = nativeFixture(t);
  let raced;
  f.schedulerModule.acquireProcessLock = (...args) => {
    const lock = scheduler.acquireProcessLock(...args);
    if (kind === 'ledger') f.modify('ledger', l => { l.days[DATE].shops.synthetic.entries[1].startedAt = '2040-01-02T03:00:00Z'; });
    else write(path.join(f.dir, 'plan-publisher.lock' + (kind === 'publisher-recovery' ? '.recovery' : '')), { pid: process.pid });
    raced = snapshot(Object.values(f.files));
    return lock;
  };
  const result = await f.recover();
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.reason, /publisher-lock-busy-under-lock|record-drift-under-lock/);
  unchanged(raced);
  assert.equal(f.calls.ledgerWrites, 0);
  noActions(f);
});

test('D47-R2 native idempotence rechecks under lock, not just provenance tags', async t => {
  const f = nativeFixture(t);
  assert.equal((await f.recover()).ok, true);
  f.calls.ledgerWrites = 0;
  let reads = 0;
  f.deps.currentSourceHash = (...args) => ++reads === 3 ? 'f'.repeat(64) : rp.currentPreOpenSourceHash(...args);
  await rejected(f, /source-drift-under-lock/);
});

for (const file of ['identity', 'seed', 'attempts', 'published']) {
  test('D47-R2 all carried account aliases must agree: ' + file, async t => {
    const f = nativeFixture(t);
    f.modify(file, r => { r.account_id = '9000000000000002'; });
    await rejected(f, /native-source-identity-conflict|native-source-seed-conflict|native-summary-binding-conflict|published-shape/);
  });
}

for (const table of ['consumed', 'finalConsumed']) {
  for (const status of ['pending', 'dispatched', 'failed', null]) {
    test('D47-R2 any non-success consumption refuses: ' + table + '/' + status, async t => {
      const f = nativeFixture(t);
      f.modify('attempts', a => { Object.values(a[table])[0].status = status; });
      await rejected(f, /consumption-not-success-pair/);
    });
  }
}

for (const field of ['method', 'proof', 'manifestRecomputed', 'newPublicationAuthorized', 'sourceHash']) {
  test('D47-R2 idempotent provenance cannot lose its proof boundary: ' + field, async t => {
    const f = nativeFixture(t);
    assert.equal((await f.recover()).ok, true);
    f.calls.ledgerWrites = 0;
    f.modify('ledger', l => { delete l.days[DATE].shops.synthetic.entries[1][field]; });
    await rejected(f, /native-idempotent-source-conflict/);
  });
}

test('D47-R2 missing seed stays absent and is still a CAS source', async t => {
  const f = nativeFixture(t);
  fs.unlinkSync(f.files.seed);
  assert.equal((await f.recover()).ok, true);
  assert.equal(fs.existsSync(f.files.seed), false);
  f.calls.ledgerWrites = 0;
  write(f.files.seed, { accountId: ACCOUNT, shop: SHOP, productIds: [], plans: [],
    capturedAt: '2040-01-01T00:00:00.000Z', scope: 'account-history', sourceEvidence: 'synthetic',
    sourceSha256: 'a'.repeat(64) });
  await rejected(f, /native-idempotent-source-conflict/);
});

test('D47-R2 identity drift between path resolution and source snapshot is rejected', async t => {
  const f = nativeFixture(t);
  let raced;
  f.deps.resolvePublisherPaths = (...args) => {
    const resolved = rp.resolvePublisherStatePaths(...args);
    f.modify('identity', i => { i.accountId = '9000000000000002'; });
    raced = snapshot(Object.values(f.files));
    return resolved;
  };
  const result = await f.recover();
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.match(result.reason, /native-source-identity-conflict/);
  unchanged(raced);
  assert.equal(f.calls.ledgerWrites, 0);
  noActions(f);
});

test('D47-R2 fresh ledger preserves concurrent unrelated shop and day records', async t => {
  const f = nativeFixture(t);
  let unrelated;
  f.schedulerModule.acquireProcessLock = (...args) => {
    const lock = scheduler.acquireProcessLock(...args);
    f.modify('ledger', l => {
      l.days[DATE].shops.untouched.note = 'concurrent synthetic note';
      l.days['2040-01-01'].shops.synthetic.note = 'concurrent old-day note';
      unrelated = [JSON.stringify(l.days[DATE].shops.untouched), JSON.stringify(l.days['2040-01-01'])];
    });
    return lock;
  };
  assert.equal((await f.recover()).ok, true);
  const after = read(f.files.ledger);
  assert.deepEqual([JSON.stringify(after.days[DATE].shops.untouched), JSON.stringify(after.days['2040-01-01'])], unrelated);
  assert.equal(f.calls.ledgerWrites, 1);
  noActions(f);
});

test('D47-R3 unseeded native writer keeps reopen absent across recovery and no-op', async t => {
  const writeFileSync = fs.writeFileSync;
  let attemptWrites = 0;
  t.mock.method(fs, 'writeFileSync', (file, data, ...args) => {
    if (String(file).endsWith('plan-publication-attempts.json.tmp')) {
      if (attemptWrites === 0) assert.equal(fs.existsSync(String(file).slice(0, -4)), false);
      assert.deepEqual(Object.keys(JSON.parse(data)).sort(), ['consumed', 'finalConsumed']);
      attemptWrites++;
    }
    return writeFileSync(file, data, ...args);
  });
  // Real native writer scope: exactly one group, built from NO attempts file, for TODAY.
  const f = fixture(t, { nativeSummary: true, nativeWriter: true, unseededAttempts: true });
  assert.equal(attemptWrites, 5);
  const nativeToday = read(f.files.attempts);
  assert.deepEqual(Object.keys(nativeToday.consumed), [f.frozen[0].confirmationId]);
  assert.deepEqual(Object.keys(nativeToday.finalConsumed), [f.frozen[0].confirmationId]);
  // Historical breadth (43 pairs) is deterministic synthetic same-shape data: identical field
  // set and success pairing as the native writer's own output, without 43*5 more real writes.
  const nativeShape = Object.keys(nativeToday.consumed[f.frozen[0].confirmationId]).sort();
  const nativeFinalShape = Object.keys(nativeToday.finalConsumed[f.frozen[0].confirmationId]).sort();
  f.modify('attempts', a => {
    for (let n = 1; n <= 43; n++) {
      const businessDate = new Date(NOW - n * 86400000).toISOString().slice(0, 10);
      const cid = 'synthetic-native-history-' + n;
      const record = { status: 'success', businessDate, planNumber: 1,
        runId: `plan-scheduler-${businessDate}-${String(n).padStart(16, '0')}`,
        manifestHash: 'a'.repeat(64), at: businessDate + 'T04:00:00.000Z' };
      assert.deepEqual(Object.keys(record).sort(), nativeShape);
      a.consumed[cid] = { ...record };
      a.finalConsumed[cid] = { ...record };
      assert.deepEqual(Object.keys(a.finalConsumed[cid]).sort(), nativeFinalShape);
    }
  });
  const attempts = read(f.files.attempts);
  assert.equal(attemptWrites, 5);
  assert.equal(Object.hasOwn(attempts, 'reopenConsumed'), false);
  assert.equal(Object.keys(attempts.consumed).length, 44);
  assert.equal(Object.keys(attempts.finalConsumed).length, 44);
  assert.equal(Object.values(attempts.consumed).filter(r => r.businessDate === DATE).length, 1);
  for (const [cid, initial] of Object.entries(attempts.consumed)) {
    const final = attempts.finalConsumed[cid];
    assert.equal(initial.status, 'success');
    assert.equal(final.status, 'success');
    for (const field of ['planNumber', 'runId', 'businessDate', 'manifestHash']) assert.equal(initial[field], final[field]);
  }
  t.mock.method(wf, 'manifestHash', () => { throw new Error('native summary must not recompute a manifest'); });
  const sources = snapshot(Object.values(f.files).filter(file => file !== f.files.ledger));
  const sourceHash = rp.currentPreOpenSourceHash(f.files.state, f.files.attempts,
    [f.files.published, f.files.identity, f.files.seed]);
  const beforeLedger = read(f.files.ledger);
  const result = await f.recover();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.released, true);
  assert.equal(result.method, NATIVE_METHOD);
  assert.equal(result.recoveredBy, NATIVE_SOURCE);
  assert.equal(result.proof, NATIVE_NOTICE);
  assert.equal(result.manifestRecomputed, false);
  assert.equal(result.newPublicationAuthorized, false);
  assert.equal(result.sourceHash, sourceHash);
  const ledger = read(f.files.ledger);
  const rec = ledger.days[DATE].shops.synthetic;
  assert.equal(rec.status, 'partial');
  assert.equal(rec.plans, 1);
  assert.equal(rec.error, null);
  assert.deepEqual(Object.keys(rec.entries), ['1']);
  assert.equal(rec.entries[1].status, 'success');
  assert.equal(rec.entries[1].planId, planId(1));
  assert.equal(rec.entries[1].runId, runId(1));
  assert.equal(rec.entries[1].confirmationId, f.frozen[0].confirmationId);
  assert.equal(rec.entries[1].sourceHash, sourceHash);
  assert.equal(rec.entries[1].startedAt, f.rec.entries[1].startedAt);
  beforeLedger.days[DATE].shops.synthetic = rec;
  assert.deepEqual(ledger, beforeLedger);
  assert.equal(f.calls.ledgerWrites, 1);
  unchanged(sources);
  assert.equal(Object.hasOwn(read(f.files.attempts), 'reopenConsumed'), false);
  const beforeAgain = snapshot(Object.values(f.files));
  const again = await f.recover();
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.idempotent, true);
  assert.equal(again.released, false);
  assert.equal(again.sourceHash, sourceHash);
  assert.equal(f.calls.ledgerWrites, 1);
  assert.equal(attemptWrites, 5);
  assert.equal(Object.hasOwn(read(f.files.attempts), 'reopenConsumed'), false);
  unchanged(beforeAgain);
  noActions(f);
});

for (const [name, mutate, reason] of [
  ['null reopen', a => { a.reopenConsumed = null; }, 'attempts-tables-incomplete'],
  ['array reopen', a => { a.reopenConsumed = []; }, 'attempts-tables-incomplete'],
  ['number reopen', a => { a.reopenConsumed = 0; }, 'attempts-tables-incomplete'],
  ['string reopen', a => { a.reopenConsumed = ''; }, 'attempts-tables-incomplete'],
  ['boolean reopen', a => { a.reopenConsumed = false; }, 'attempts-tables-incomplete'],
  ['nonempty reopen', a => { a.reopenConsumed = { used: { ...Object.values(a.consumed)[0] } }; }, 'reopen-consumption-present'],
  ['missing consumed', a => { delete a.consumed; }, 'attempts-tables-incomplete'],
  ['missing finalConsumed', a => { delete a.finalConsumed; }, 'attempts-tables-incomplete'],
  ['missing both required tables', a => { delete a.consumed; delete a.finalConsumed; }, 'attempts-tables-incomplete'],
  ['missing current final receipt', a => { delete a.finalConsumed[Object.keys(a.consumed)[0]]; }, 'consumption-not-success-pair'],
  ['missing historical final receipt', a => { delete a.finalConsumed['synthetic-history-44']; }, 'consumption-not-success-pair'],
  ['orphan final receipt', a => { delete a.consumed['synthetic-history-44']; }, 'orphan-final-consumption'],
  ['unknown initial receipt', a => { Object.values(a.consumed)[0].status = 'unknown'; }, 'consumption-not-success-pair'],
  ['unknown final receipt', a => { Object.values(a.finalConsumed)[0].status = 'unknown'; }, 'consumption-not-success-pair'],
]) test('D47-R3 absent reopen never excuses invalid attempts: ' + name, async t => {
  const f = nativeFixture(t, { nativeWriter: true, unseededAttempts: true });
  assert.equal(Object.hasOwn(read(f.files.attempts), 'reopenConsumed'), false);
  f.modify('attempts', mutate);
  const result = await rejected(f);
  assert.equal(result.reason, 'recovery-crash-' + reason);
});

for (const timing of ['under lock', 'after convergence']) {
  test('D47-R3 absent-to-empty reopen still changes source bytes: ' + timing, async t => {
    const f = nativeFixture(t, { nativeWriter: true, unseededAttempts: true });
    assert.equal(Object.hasOwn(read(f.files.attempts), 'reopenConsumed'), false);
    let raced;
    if (timing === 'under lock') {
      f.schedulerModule.acquireProcessLock = (...args) => {
        const lock = scheduler.acquireProcessLock(...args);
        f.modify('attempts', a => { a.reopenConsumed = {}; });
        raced = snapshot(Object.values(f.files));
        return lock;
      };
    } else {
      assert.equal((await f.recover()).ok, true);
      f.calls.ledgerWrites = 0;
      f.modify('attempts', a => { a.reopenConsumed = {}; });
      raced = snapshot(Object.values(f.files));
    }
    const ledgerBefore = snapshot([f.files.ledger]);
    const result = await f.recover();
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.released, false);
    assert.equal(result.reason, 'recovery-crash-' + (timing === 'under lock'
      ? 'source-drift-under-lock' : 'native-idempotent-source-conflict'));
    unchanged(ledgerBefore);
    unchanged(raced);
    assert.equal(f.calls.ledgerWrites, 0);
    noActions(f);
  });
}

// ── D47-R4: account identity / historical seed are ACCOUNT facts, not today's plan facts ──
const accountHistory = n => Array.from({ length: n }, (_, i) => String(9100000000000000n + BigInt(i)));

test('D47-R4 differing account seed history still allows native first recovery and idempotence', async t => {
  const f = nativeFixture(t);
  const history = accountHistory(120);
  f.modify('seed', s => {
    s.productIds = history.slice().reverse(); // account-wide history, different membership AND order
    s.plans = [{ planId: planId(51), date: '2039-11-30' }, { planId: planId(52), date: '2039-12-31' }];
    s.capturedAt = '2039-11-30T15:00:00.000Z';
  });
  const today = read(f.files.state).firstPublishedPlan;
  assert.deepEqual(today.product_ids.length, 30);
  assert.notDeepEqual(history, today.product_ids);
  assert.equal(history.some(id => today.product_ids.includes(id)), false);
  assert.equal(read(f.files.seed).plans[0].date === DATE, false);
  const sources = snapshot([f.files.state, f.files.attempts, f.files.published, f.files.identity, f.files.seed]);
  const result = await f.recover();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.released, true);
  assert.equal(result.method, NATIVE_METHOD);
  assert.equal(result.recoveredBy, NATIVE_SOURCE);
  assert.equal(result.manifestRecomputed, false);
  assert.equal(result.newPublicationAuthorized, false);
  const rec = read(f.files.ledger).days[DATE].shops.synthetic;
  assert.equal(rec.status, 'partial');
  assert.equal(rec.plans, 1);
  assert.equal(rec.error, null);
  assert.equal(rec.entries[1].status, 'success');
  assert.equal(rec.entries[1].planId, planId(1));
  assert.equal(f.calls.ledgerWrites, 1);
  unchanged(sources);
  const beforeAgain = snapshot(Object.values(f.files));
  const again = await f.recover();
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.idempotent, true);
  assert.equal(again.released, false);
  assert.equal(f.calls.ledgerWrites, 1);
  unchanged(beforeAgain);
  noActions(f);
});

test('D47-R4 absent reopen table combined with differing account seed history still recovers', async t => {
  const f = nativeFixture(t, { nativeWriter: true, unseededAttempts: true });
  assert.equal(Object.hasOwn(read(f.files.attempts), 'reopenConsumed'), false);
  const history = accountHistory(45);
  f.modify('seed', s => {
    s.productIds = history.slice().reverse();
    s.plans = [{ planId: planId(77), date: '2039-06-01' }];
  });
  const today = read(f.files.state).firstPublishedPlan;
  assert.notDeepEqual(read(f.files.seed).productIds, today.product_ids);
  const sources = snapshot([f.files.state, f.files.attempts, f.files.published, f.files.identity, f.files.seed]);
  const result = await f.recover();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.method, NATIVE_METHOD);
  assert.equal(read(f.files.ledger).days[DATE].shops.synthetic.entries[1].status, 'success');
  assert.equal(f.calls.ledgerWrites, 1);
  assert.equal(Object.hasOwn(read(f.files.attempts), 'reopenConsumed'), false);
  unchanged(sources);
  const beforeAgain = snapshot(Object.values(f.files));
  const again = await f.recover();
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.idempotent, true);
  assert.equal(f.calls.ledgerWrites, 1);
  unchanged(beforeAgain);
  noActions(f);
});

test('D47-R4 account seed cannot stand in for missing first-plan evidence', async t => {
  const f = nativeFixture(t);
  const today = read(f.files.state).firstPublishedPlan;
  f.modify('seed', s => { s.productIds = today.product_ids.slice(); s.plans = [{ planId: planId(1), date: DATE }]; });
  f.modify('state', s => { delete s.firstPublishedPlan; });
  await rejected(f, /native-first-summary-conflict/);
});

// Identity shop/accountId conflicts and identity JSON corruption are already caught by
// resolvePublisherStatePaths (fail-closed => paths-unavailable) BEFORE recovery reads it;
// the runner-level account-source check still catches what resolution cannot see
// (account_id aliases, drift between resolution and the snapshot, seed schema).
for (const [name, file, mutate, reason] of [
  ['identity accountId conflict', 'identity', i => { i.accountId = '9000000000000002'; }, 'paths-unavailable'],
  ['identity shop conflict', 'identity', i => { i.shop = 'another synthetic shop'; }, 'paths-unavailable'],
  ['identity account alias conflict', 'identity', i => { i.account_id = '9000000000000002'; }, 'native-source-identity-conflict'],
  ['seed accountId conflict', 'seed', s => { s.accountId = '9000000000000002'; }, 'native-source-seed-conflict'],
  ['seed shop conflict', 'seed', s => { s.shop = 'another synthetic shop'; }, 'native-source-seed-conflict'],
  ['seed account alias conflict', 'seed', s => { s.account_id = '9000000000000002'; }, 'native-source-seed-conflict'],
  ['seed history without account', 'seed', s => { delete s.accountId; s.productIds = accountHistory(2); }, 'native-source-seed-conflict'],
  ['seed products not array', 'seed', s => { s.productIds = 'not-a-list'; }, 'native-source-seed-products-invalid'],
  ['seed products duplicate', 'seed', s => { s.productIds = accountHistory(3); s.productIds[2] = s.productIds[1]; }, 'native-source-seed-products-invalid'],
  ['seed products invalid id', 'seed', s => { s.productIds = ['not-a-product']; }, 'native-source-seed-products-invalid'],
  ['seed products numeric id', 'seed', s => { s.productIds = [Number(accountHistory(1)[0])]; }, 'native-source-seed-products-invalid'],
  ['seed plans not array', 'seed', s => { s.plans = { planId: planId(51) }; }, 'native-source-seed-plans-invalid'],
  ['seed plan missing planId', 'seed', s => { s.plans = [{ date: '2039-11-30' }]; }, 'native-source-seed-plans-invalid'],
  ['seed plan bad date', 'seed', s => { s.plans = [{ planId: planId(51), date: 'not-a-date' }]; }, 'native-source-seed-plans-invalid'],
  ['seed capturedAt invalid', 'seed', s => { s.capturedAt = 'not-a-time'; }, 'native-source-seed-captured-at-invalid'],
]) test('D47-R4 account source zero-write refusal: ' + name, async t => {
  const f = nativeFixture(t);
  f.modify(file, mutate);
  const result = await rejected(f, /^recovery-crash-/);
  assert.equal(result.reason, 'recovery-crash-' + reason);
});

for (const [name, file, value, reason] of [
  ['identity array', 'identity', [], 'paths-unavailable'],
  ['identity string', 'identity', 'not-an-identity', 'paths-unavailable'],
  ['seed array', 'seed', [], 'native-source-seed-conflict'],
  ['seed string', 'seed', 'not-a-seed', 'native-source-seed-conflict'],
  ['identity invalid JSON', 'identity', '{not json', 'paths-unavailable'],
  ['seed invalid JSON', 'seed', '{not json', 'native-source-seed-unreadable'],
]) test('D47-R4 account source malformed refusal: ' + name, async t => {
  const f = nativeFixture(t);
  fs.writeFileSync(f.files[file], typeof value === 'string' && value.startsWith('{') ? value : JSON.stringify(value));
  const result = await rejected(f, /^recovery-crash-/);
  assert.equal(result.reason, 'recovery-crash-' + reason);
});

for (const [name, file, reason] of [['identity', 'identity', 'paths-unavailable'],
  ['seed', 'seed', 'source-unreadable']]) {
  test('D47-R4 unreadable account source directory is refused: ' + name, async t => {
    const f = nativeFixture(t);
    fs.rmSync(f.files[file]);
    fs.mkdirSync(f.files[file]);
    const ledgerBefore = snapshot([f.files.ledger]);
    const result = await f.recover();
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.released, false);
    assert.equal(result.reason, 'recovery-crash-' + reason);
    unchanged(ledgerBefore);
    assert.equal(f.calls.ledgerWrites, 0);
    noActions(f);
  });
}

for (const file of ['identity', 'seed']) {
  test('D47-R4 account identity drift under lock is rejected: ' + file, async t => {
    const f = nativeFixture(t);
    const ledgerBefore = snapshot([f.files.ledger]);
    let raced;
    f.schedulerModule.acquireProcessLock = (...args) => {
      const lock = scheduler.acquireProcessLock(...args);
      f.modify(file, r => { r.accountId = '9000000000000002'; });
      raced = snapshot(Object.values(f.files));
      return lock;
    };
    const result = await f.recover();
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.equal(result.released, false);
    assert.equal(result.reason, 'recovery-crash-source-drift-under-lock');
    unchanged(ledgerBefore);
    unchanged(raced);
    assert.equal(f.calls.ledgerWrites, 0);
    noActions(f);
  });
}
