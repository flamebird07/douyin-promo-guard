const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const publisher = require('./run-plans.cjs');
const { createScheduler } = require('../integrations/bill-manager/promo-plan-scheduler');
const { readPlanPublishStatus } = require('../src/ui/server');

test('the next Shanghai date skips just the exhausted shop across ticks and restart', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-rest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shops = ['shop-A', 'shop-B'].map((name, n) => ({ id: name, name, accountId: String(980001 + n) }));
  const first = shops[0];
  const { paths } = publisher.resolvePublisherStatePaths(first, root);
  const business = { shop: first.name, accountId: first.accountId };
  publisher.atomicWrite(path.join(paths.dir, 'shop-identity.json'), business);
  const fact = publisher.recordCatalogEnd(paths, business, '2026-12-31', 60);
  const config = { enabled: true, autoConfirm: true, time: '00:00', timezone: 'Asia/Shanghai', plansPerShopPerDay: 1, dailyBudget: 300, shops };
  publisher.atomicWrite(path.join(root, 'daily-plan-config.json'), config);
  const view = date => readPlanPublishStatus(Date.parse(date + 'T00:05:00+08:00'), root).byShop;
  assert.deepEqual(view('2026-12-31')[first.name].restTomorrow, fact);
  assert.equal(view('2027-01-01')[first.name].overall, 'catalog-rest-day');
  assert.equal(view('2027-01-02')[first.name].restToday, null);
  const dispatches = [];
  const tick = date => createScheduler({
    planPublishing: config, listShops: () => shops, nowMs: () => Date.parse(date + 'T00:05:00+08:00'),
    ledgerFile: path.join(root, 'ledger.json'),
    readCatalogRest: (shop, day) => publisher.readCatalogRest(shop, day, root),
    buildBusiness: s => ({ shop: s.name, accountId: s.accountId }),
    runPlan: async b => { dispatches.push([date,b.shop]); return { status: 'success', planId: '123456789012' }; },
  }).tick();
  await tick('2026-12-31');
  for (let i = 0; i < 2; i++) {
    const result = await tick('2027-01-01');
    assert.equal(result.results.find(s => s.shopId === first.id).status, 'catalog-rest-day');
  }
  await tick('2027-01-02');
  assert.deepEqual(dispatches, [
    ['2026-12-31','shop-A'], ['2026-12-31','shop-B'], ['2027-01-01','shop-B'],
    ['2027-01-02','shop-A'], ['2027-01-02','shop-B'],
  ]);
});

test('the dashboard replaces an obsolete failure only with a matching published receipt', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'publish-view-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const date = '2026-11-25';
  const s = { name: '店铺', id: 'store-id', accountId: '980001' };
  const { paths } = publisher.resolvePublisherStatePaths(s, root);
  const write = publisher.atomicWrite;
  write(path.join(paths.dir, 'shop-identity.json'), {shop: s.name, accountId: s.accountId});
  write(path.join(root, 'daily-plan-config.json'), { enabled: true, plansPerShopPerDay: 1, shops: [s] });
  write(path.join(root, 'daily-plan-data/ledger.json'), {days: { [date]: {shops: {
    [s.id]: {plans: 1, entries: {1: {status: 'unknown', reason: 'old failure', at: date + 'T00:00:00Z'}}},
  }}}});
  const plan = { planNumber: 1, status: 'success', manifestHash: 'matching', planId: '123456789012' };
  const rec = { ...plan, runId: 'test', businessDate: date, at: date + 'T01:00:00Z' };
  write(paths.stateFile, {businessDate: date, plans: [plan]});
  write(paths.publishedFile, {plans: [{date, planId: plan.planId}]});
  const status = () => readPlanPublishStatus(Date.parse(rec.at), root).byShop[s.name];
  write(paths.attemptsFile, { consumed: {id: rec}, finalConsumed: {} });
  assert.equal(status().lastStatus, 'unknown');
  write(paths.attemptsFile, { consumed: {id: rec}, finalConsumed: {id: rec} });
  assert.equal(status().lastStatus, 'success');
  assert.equal(status().lastAt, rec.at);
  assert.equal(status().reason, null);
  assert.equal(status().lastPlanId, plan.planId);
});
