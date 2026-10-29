'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const wf = require('./plan-workflow.cjs');
const rp = require('./run-plans.cjs');
const { createDailyRunner } = require('./daily-plan-runner.cjs');

const DATE = '2026-10-29';
const IDS = Array.from({ length: 30 }, (_, i) => String(1234567890123450 + i));
const TARGETS = ['fixture_account_a', 'fixture_account_b'];
const BIZ = { ...wf.BUSINESS, shop: 'Jin fixture', accountId: '100001', boundAccounts: TARGETS, roi: 13.5 };
const rows = () => IDS.map(productId => ({ productId, manualAccounts: 1, manualEvidence: true, manualCountKnown: true, autoPullOnly: false, reviewFailed: false }));
const fail = () => { throw new Error('unexpected publication or repair'); };

function preparation(bindAccountsToAll) {
  return wf.preparePlan({
    planNumber: 1, runId: `plan-scheduler-${DATE}-aaaaaaaaaaaaaaaa`, businessDate: DATE,
    business: BIZ, requireRealDrivers: true, nowMs: Date.parse(`${DATE}T00:01:00+08:00`),
    dayState: { attempted: [], lastSelected: [], hints: {} }, publishedIds: [], publishedSet: new Set(),
    openCreationPage: async () => ({ header: { originOk: true, accountId: BIZ.accountId, commissionOptionPresent: true } }),
    browseProducts: async () => ({ ok: true, selectedIds: IDS, hints: {}, attempted: [] }),
    bindAccountsToAll, readMainTable: async () => rows(), repairDraft: fail,
    configurePlan: fail, persistState: async () => {},
  });
}

function realBinder(mutate) {
  let active = IDS[0], navigated = false;
  const calls = { panel: 0, ack: 0, commit: 0, batch: 0, modal: 0 };
  const page = { evaluate: async (fn, arg) => {
    if (fn === rp.readMainTableInPage) return { ok: true, rows: rows() };
    if (fn === rp.bindingDrawerSnapshotInPage) {
      const snapshot = {
        ok: true, spinnerCount: 0, rows: TARGETS.map(id => ({ ids: [id], checked: true, labelDisabled: false })),
        headerSelectAllCount: 1, headerLabelDisabled: false, selectedCount: 2, totalCount: 30,
        batchButtonCount: 1, batchEnabled: true, panelProductIds: IDS.slice(), activeProductIds: [active],
      };
      return navigated ? mutate(snapshot) : snapshot;
    }
    if (fn === rp.applyBatchAccountsInPage) { calls.batch++; return { clicked: true }; }
    if (fn === rp.batchAddAllModalSnapshotInPage) return { modalCount: 1, productCount: 29, accountCount: 2, drawerSettled: true };
    if (fn === rp.confirmBatchAddAllModalInPage) { calls.modal++; return { clicked: true }; }
    if (fn === rp.batchResultSnapshotInPage) return { present: false, settled: false };
    if (fn === rp.bindingOverlaySnapshotInPage) return { accountDrawerCount: 1, blockingOverlayPresent: false };
    if (fn === rp.selectBindingDrawerPanelInPage) { active = String(arg); navigated = true; calls.panel++; return { clicked: true, id: active }; }
    if (fn === rp.acknowledgeBatchResultInPage) { calls.ack++; return fail(); }
    if (fn === rp.confirmBatchAccountsApplyInPage) { calls.commit++; return { clicked: true }; }
    if (fn === rp.acceptPartialDraftWarningInPage) return { clicked: false };
    if (fn === rp.guidanceActionInPage) return { present: false, unknown: false, roots: [] };
    if (!fn.name) return { ok: true };
    throw new Error('unexpected driver callback: ' + fn.name);
  } };
  const driver = rp.createRealDrivers({
    page, managerPage: {}, context: {}, dayState: { lastSelected: [], cursor: { seenProductIds: [] } },
    persist: async () => {}, publishedIds: new Set(), attemptedSet: new Set(), hints: {},
    business: BIZ, boundAccounts: TARGETS, accountId: BIZ.accountId, opened: {}, projectRoot: __dirname,
    planNumber: 1, runId: 'fixture', nativeScrollTimeoutMs: 1,
  });
  return { bind: () => driver.bindAccountsToAll({ productIds: IDS }), calls };
}

for (const [name, mutate, expected] of [
  ['spinner', s => ({ ...s, spinnerCount: 1 }), { spinnerCount: 1, activeTargetMatch: false }],
  ['foreign panel', s => ({ ...s, panelProductIds: [...IDS.slice(1), '9999999999999999'] }), { panelSetExactMatch: false }],
  ['duplicate active', s => ({ ...s, activeProductIds: [IDS[0], IDS[0]] }), { activeCount: 2, activeTargetMatch: false }],
  ['footer conflict', s => ({ ...s, selectedCount: 1 }), { selectedCount: 1, expectedSelectedCount: 2, activeTargetMatch: true }],
  ['foreign account', s => ({ ...s, rows: [{ ids: ['foreign_fixture'], checked: true }], selectedCount: 1 }), { activeTargetMatch: true, rowCount: 1 }],
  ['unknown checkbox', s => ({ ...s, rows: [{ ids: [TARGETS[0]], checked: null }], selectedCount: 0 }), { unknownStateCount: 1 }],
]) {
  test(`real panel verification -> workflow -> parent diagnostic retains ${name}, without accepting the panel`, async () => {
    const h = realBinder(mutate);
    const result = await preparation(h.bind);
    assert.equal(result.status, 'stopped');
    assert.equal(result.stage, 'account-binding');
    assert.equal(result.reason, 'batch-result-panel-target-not-verified');
    assert.equal(result.frozen, undefined);
    assert.deepEqual(h.calls, { panel: 1, ack: 0, commit: 0, batch: 1, modal: 1 });
    const packet = rp.buildScheduledPreparationDiagnostic(result);
    assert.equal(packet.binding.phase, 'panel-navigation');
    assert.equal(packet.binding.expectedTotalCount, 30);
    assert.equal(packet.binding.expectedPanelCount, 30);
    for (const [key, value] of Object.entries(expected)) assert.equal(packet.binding[key], value, key);
    const serialized = JSON.stringify(packet);
    for (const secret of [...IDS, ...TARGETS, 'foreign_fixture']) assert.equal(serialized.includes(secret), false);
  });
}

test('all 30 exact panels still pass the unchanged binder and restore the anchor', async () => {
  const h = realBinder(s => s);
  const result = await h.bind();
  assert.equal(result.ok, true);
  assert.deepEqual(result.failedIds, []);
  assert.deepEqual(h.calls, { panel: 31, ack: 0, commit: 1, batch: 1, modal: 1 });
});

test('discovery diagnostics retain only existing booleans/counts and never accept secret-shaped values', async () => {
  const diag = {
    phase: 'discovery-union', rowCount: 2, knownCheckedCount: 1, unknownStateCount: 0, selectedCount: 1, totalCount: 30,
    spinnerCount: 0, expectedTotalCount: 30, panelSetExactMatch: true, activeTargetMatch: true,
    uniqueRowCount: false, malformedIdCount: 1, footerMatchesChecked: true,
    rawRowText: 'PRIVATE_FIXTURE', accountIds: TARGETS,
  };
  const result = await preparation(async () => ({ ok: false, reason: 'account-anchor-account-identity-drift', diag }));
  const packet = rp.buildScheduledPreparationDiagnostic(result);
  assert.equal(result.status, 'stopped');
  assert.equal(packet.binding.phase, 'discovery-union');
  assert.equal(packet.binding.uniqueRowCount, false);
  assert.equal(packet.binding.malformedIdCount, 1);
  assert.equal(packet.binding.footerMatchesChecked, true);
  assert.equal(JSON.stringify(packet).includes('PRIVATE_FIXTURE'), false);
  assert.equal(JSON.stringify(packet).includes(TARGETS[0]), false);
  const invalid = await preparation(async () => ({ ok: false, reason: 'batch-result-panel-target-not-verified', diag: {
    ...diag, spinnerCount: 'PRIVATE_FIXTURE', activeTargetMatch: 'true', panelCount: Infinity, expectedTotalCount: {}, uniqueRowCount: 1,
  } }));
  for (const key of ['spinnerCount', 'activeTargetMatch', 'panelCount', 'expectedTotalCount', 'uniqueRowCount']) {
    assert.equal(invalid.bindingDiag[key], null, key);
  }
});

test('legacy minimal diagnostic shape stays unchanged', async () => {
  const diag = { phase: 'initial-auto-drawer', rowCount: 2, knownCheckedCount: 1, unknownStateCount: 0, selectedCount: 2, totalCount: 30 };
  const result = await preparation(async () => ({ ok: false, reason: 'account-drawer-footer-row-state-conflict', diag }));
  assert.deepEqual(result.bindingDiag, diag);
});

function runnerHarness(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd36-runner-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'config.json');
  const config = {
    enabled: true, autoConfirm: true, time: '08:00', plansPerShopPerDay: 3, dailyBudget: 300,
    adapterRoot: root, login: { cookieWorkDir: root, cookieSourceDir: root },
    shops: [{ id: 'jin', name: BIZ.shop, accountId: BIZ.accountId, plansPerShopPerDay: 3, targetRoi: 13.5 }],
  };
  const save = () => fs.writeFileSync(configFile, JSON.stringify(config));
  save();
  let wiring, runResult;
  const calls = [];
  const runner = createDailyRunner({
    configFile, dataDir: path.join(root, 'data'), stateRoot: path.join(root, 'state'),
    nowMs: () => Date.parse(`${DATE}T00:01:00+08:00`),
    schedulerModule: {
      createScheduler: (options) => { wiring = options; return { tick: fail }; },
      hasInProgress: (rec) => Object.values(rec.entries).some(e => e.status === 'in-progress'),
      countSuccessEntries: (rec) => Object.values(rec.entries).filter(e => e.status === 'success').length,
    },
    deps: {
      runPlan: async (business, opts) => { calls.push({ business, opts }); return runResult; },
      readDaySuccess: fail, discoverAccount: fail,
    },
  });
  return { runner, config, save, wiring, calls, setResult: (r) => { runResult = r; } };
}

test('runner wiring remains all-hours, fresh quantity/ROI, independent policy, with deletion and global disable respected', async (t) => {
  const h = runnerHarness(t);
  assert.equal(h.wiring.planPublishing.time, '00:00');
  assert.equal(h.wiring.maxUnsubmittedRetries, null);
  assert.equal(h.wiring.enableShop, undefined);
  h.config.shops[0].plansPerShopPerDay = 4;
  h.config.shops[0].targetRoi = 14;
  h.save();
  const shop = h.wiring.listShops()[0];
  const business = h.wiring.buildBusiness(shop, { dailyBudget: 300, plansPerShopPerDay: shop.plansPerShopPerDay });
  assert.equal(business.roi, 14);
  assert.equal(business.maxPlansPerDay, 4);
  h.setResult({ status: 'unknown' });
  await h.wiring.runPlan(business, {});
  assert.equal(h.calls[0].opts.currentShopProvider().targetRoi, 14);
  assert.equal(h.calls[0].opts.policyProvider().time, '00:00');
  h.config.enabled = false;
  h.save();
  const disabled = await h.wiring.runPlan(business, {});
  assert.equal(disabled.noReplay, true);
  assert.equal(h.calls.length, 1);
  h.config.shops[0].deleted = true;
  h.save();
  assert.deepEqual(h.wiring.listShops(), []);
});

test('runner maps only a bound six-zero preparation closure; successful shops/entries stay immutable', async (t) => {
  const h = runnerHarness(t);
  const runId = `plan-scheduler-${DATE}-aaaaaaaaaaaaaaaa`;
  const reason = 'prepare-stopped:batch-result-panel-target-not-verified';
  const zeroConsumptionProof = {
    initialConsumptions: 0, finalConsumptions: 0, reopenConsumptions: 0,
    manualUnresolved: 0, plansContainsNumber: false, confirmationConsumptionsRecorded: false,
  };
  const fact = { status: 'preparationClosed', phase: 'preparing', shop: BIZ.shop, accountId: BIZ.accountId, businessDate: DATE, planNumber: 2, runId, reason, zeroConsumptionProof };
  const result = { status: 'preparation-stopped', reason, businessDate: DATE, planNumber: 2, runId, preparationClosure: fact };
  h.setResult(result);
  await h.wiring.runPlan(BIZ, {});
  const success = n => ({ status: 'success', plans: n, entries: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i + 1), { status: 'success', planNumber: i + 1, planId: `fixture-${n}-${i}` }])) });
  const base = { days: { [DATE]: { shops: {
    jin: { status: 'unknown', plans: 1, entries: { '1': { status: 'success', planId: 'fixture-jin-success' }, '2': { status: 'unknown', reason } } },
    min: success(4), jian: success(3),
  } } } };
  const ledger = structuredClone(base);
  assert.equal(h.wiring.applyRunResultToLedger(ledger, DATE, 'jin', result, {}, 2).applied, true);
  assert.equal(ledger.days[DATE].shops.jin.entries['2'].status, 'preparation-stopped');
  assert.deepEqual(ledger.days[DATE].shops.min, base.days[DATE].shops.min);
  assert.deepEqual(ledger.days[DATE].shops.jian, base.days[DATE].shops.jian);
  assert.deepEqual(ledger.days[DATE].shops.jin.entries['1'], base.days[DATE].shops.jin.entries['1']);
  assert.equal(ledger.days[DATE].shops.jin.plans, 1);
  for (const change of [
    r => { delete r.preparationClosure; },
    r => { r.status = 'unknown'; },
    r => { r.preparationClosure.accountId = '100002'; },
    r => { r.preparationClosure.zeroConsumptionProof.initialConsumptions = 1; },
    r => { delete r.preparationClosure.zeroConsumptionProof.finalConsumptions; },
  ]) {
    const bad = structuredClone(result), untouched = structuredClone(base);
    change(bad);
    assert.equal(h.wiring.applyRunResultToLedger(untouched, DATE, 'jin', bad, {}, 2).applied, false);
    assert.deepEqual(untouched, base);
  }
  for (const status of ['in-progress', 'success']) {
    const untouched = structuredClone(base);
    untouched.days[DATE].shops.jin.entries['2'].status = status;
    const before = structuredClone(untouched);
    assert.equal(h.wiring.applyRunResultToLedger(untouched, DATE, 'jin', result, {}, 2).applied, false);
    assert.deepEqual(untouched, before);
  }
});
