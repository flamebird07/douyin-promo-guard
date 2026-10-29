'use strict';
// D40 offline regression: post-bind READ-ONLY panel validation must accept a panel
// that shows provably INERT foreign account rows (definitely unchecked AND
// label-disabled) beside correctly selected target accounts, while every action gate
// stays strict. The driver is the REAL createRealDrivers().bindAccountsToAll; only the
// page primitives are simulated (no network, browser, cookies, files or timers beyond
// the bounded production waits).
//   node --test publisher/binding-inert-rows.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');

const wf = require('./plan-workflow.cjs');
const rp = require('./run-plans.cjs');

const IDS30 = Array.from({ length: 30 }, (_, i) => '38458116252485' + String(55000 + i));
const TARGETS = ['79863866', '9zmao_fushi'];
const FOREIGN = ['other_account_1', 'other_account_2'];
const ACCOUNT = wf.BUSINESS.accountId;

const targetRows = () => TARGETS.map(id => ({ ids: [id], checked: true, labelDisabled: false }));
// Later panels in the real rebinding case list the same two selected targets PLUS two
// foreign accounts that are grey (无权限 / 投放限制): unchecked and label-disabled.
const laterRows = () => targetRows().concat(FOREIGN.map(id => ({ ids: [id], checked: false, labelDisabled: true })));

function mainRows() {
  return IDS30.map((productId, i) => ({
    productId,
    manualAccounts: i === 0 ? 2 : 1,
    manualEvidence: true,
    manualCountKnown: true,
    autoPullOnly: false,
    reviewFailed: false,
    text: 'ID：' + productId,
  }));
}

// `mutate` may rewrite the rows of a selected panel; `selectedCountAt` may override the
// footer count. Both are keyed by the panel index so a single later panel can be broken.
function makeDriver({ mutate, selectedCountAt } = {}) {
  let active = IDS30[0];
  let panelReads = 0;
  const calls = { panel: [], selectAll: 0, applyBatch: 0, modalConfirm: 0, commit: 0, unknown: [] };
  const page = {
    url: () => 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi?aavid=' + ACCOUNT,
    evaluate: async (fn, arg) => {
      if (fn === rp.readMainTableInPage) return { ok: true, rows: mainRows() };
      if (fn === rp.bindingDrawerSnapshotInPage) {
        const idx = IDS30.indexOf(String(active));
        const read = panelReads++;
        let rows = idx === 0 ? targetRows() : laterRows();
        if (typeof mutate === 'function') {
          const next = mutate({ idx, read, rows: rows.map(r => ({ ...r, ids: r.ids.slice() })) });
          if (Array.isArray(next)) rows = next;
        }
        const checked = rows.filter(r => r.checked === true).length;
        const footer = typeof selectedCountAt === 'function' ? selectedCountAt({ idx, checked }) : checked;
        return {
          ok: true, spinnerCount: 0, headerLabelDisabled: false,
          rows, panelProductIds: IDS30.slice(), activeProductIds: [String(active)],
          selectedCount: footer, totalCount: 30,
        };
      }
      if (fn === rp.selectBindingDrawerPanelInPage) {
        const id = String(arg);
        calls.panel.push(id);
        active = id;
        panelReads = 0;
        return { clicked: true, id };
      }
      if (fn === rp.selectAllAccountsInPage) { calls.selectAll++; return { clicked: true }; }
      if (fn === rp.applyBatchAccountsInPage) { calls.applyBatch++; return { clicked: true }; }
      if (fn === rp.batchAddAllModalSnapshotInPage) {
        return { ok: true, modalCount: 1, productCount: 29, accountCount: TARGETS.length, drawerSettled: true };
      }
      if (fn === rp.confirmBatchAddAllModalInPage) { calls.modalConfirm++; return { clicked: true, productCount: 29 }; }
      if (fn === rp.batchResultSnapshotInPage) {
        return { present: false, known: false, settled: false, rowCount: 0, uniqueCount: 0, outside: 0, duplicate: false, ambiguous: 0, failedIds: [], successCount: 0 };
      }
      if (fn === rp.bindingOverlaySnapshotInPage) return { accountDrawerCount: 1, blockingOverlayPresent: false };
      if (fn === rp.confirmBatchAccountsApplyInPage) { calls.commit++; return { clicked: true }; }
      if (fn === rp.acceptPartialDraftWarningInPage) return { present: false };
      if (fn === rp.guidanceActionInPage) return { present: false, unknown: null, roots: [] };
      calls.unknown.push(String((fn && fn.name) || 'anonymous'));
      return null;
    },
  };
  const driver = rp.createRealDrivers({
    page, managerPage: {}, context: {},
    dayState: { lastSelected: [], cursor: { seenProductIds: [] } },
    persist: async () => {}, publishedIds: new Set(), attemptedSet: new Set(),
    hints: {}, accountId: ACCOUNT, boundAccounts: TARGETS.slice(), opened: {},
    projectRoot: __dirname, planNumber: 1, runId: 'offline', nativeScrollTimeoutMs: 30,
  });
  return { driver, calls, active: () => active };
}

function assertNoForeignAction(calls) {
  assert.equal(calls.selectAll, 0, 'no header select-all: disabled foreign rows are never selected');
  assert.ok(calls.applyBatch <= 1, 'no extra batch/ad-plan action beyond the single existing apply');
  assert.ok(calls.modalConfirm <= 1, 'no extra batch modal confirm');
  assert.ok(calls.commit <= 1, 'no extra drawer commit');
  assert.ok(!calls.panel.some(id => !IDS30.includes(id)), 'panel navigation only ever targets batch product ids');
  assert.ok(!calls.unknown.some(n => /FinalConfirm|publish|actionApply/i.test(n)), 'no publication/final-confirm callback was invoked');
}

test('D40 later panel with 2 inert foreign rows is accepted; all 30 panels proven and the anchor restored', async () => {
  const h = makeDriver();
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, true, JSON.stringify(res.reason || res));
  assert.equal(res.batchApplied, true);
  assert.equal(res.partial, false);
  assert.deepEqual(res.accountIds, TARGETS, 'the original target identity is preserved');
  assert.equal(h.calls.panel.length, 31, '30 panel proofs + one restore of the original anchor');
  assert.equal(h.calls.panel[0], IDS30[0]);
  assert.equal(h.calls.panel[h.calls.panel.length - 1], IDS30[0]);
  assert.equal(h.active(), IDS30[0], 'the drawer was restored to the original batch anchor');
  assert.equal(h.calls.applyBatch, 1);
  assert.equal(h.calls.modalConfirm, 1);
  assert.equal(h.calls.commit, 1);
  assertNoForeignAction(h.calls);
});

test('D40 a CHECKED foreign row fails the post-bind proof (never accepted as a target)', async () => {
  const h = makeDriver({
    mutate: ({ idx, rows }) => {
      if (idx === 5) rows[2].checked = true;
      return rows;
    },
  });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'batch-result-panel-target-not-verified');
  assertNoForeignAction(h.calls);
});

test('D40 an ENABLED foreign row (even unchecked) fails the post-bind proof', async () => {
  const h = makeDriver({
    mutate: ({ idx, rows }) => {
      if (idx === 5) rows[2].labelDisabled = false;
      return rows;
    },
  });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'batch-result-panel-target-not-verified');
  assertNoForeignAction(h.calls);
});

test('D40 an UNKNOWN foreign checkbox/disabled state fails the post-bind proof', async () => {
  const unknownChecked = makeDriver({
    mutate: ({ idx, rows }) => { if (idx === 5) rows[2].checked = null; return rows; },
  });
  const a = await unknownChecked.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(a.ok, false);
  assert.equal(a.reason, 'batch-result-panel-target-not-verified');

  const unknownDisabled = makeDriver({
    mutate: ({ idx, rows }) => { if (idx === 5) rows[2].labelDisabled = null; return rows; },
  });
  const b = await unknownDisabled.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(b.ok, false);
  assert.equal(b.reason, 'batch-result-panel-target-not-verified');
});

test('D40 malformed or duplicate foreign account ids fail the post-bind proof', async () => {
  const malformed = makeDriver({
    mutate: ({ idx, rows }) => { if (idx === 5) rows[2].ids = ['bad id!']; return rows; },
  });
  const m = await malformed.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(m.ok, false);
  assert.equal(m.reason, 'batch-result-panel-target-not-verified');

  const duplicate = makeDriver({
    mutate: ({ idx, rows }) => { if (idx === 5) rows[3].ids = rows[2].ids.slice(); return rows; },
  });
  const d = await duplicate.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(d.ok, false);
  assert.equal(d.reason, 'batch-result-panel-target-not-verified');
});

test('D40 an inert row that changes state between the identity read and the follow-up read fails', async () => {
  const h = makeDriver({
    mutate: ({ idx, read, rows }) => {
      // read 0 = the identity read (still inert); from read 1 on the grey row turns usable.
      if (idx === 5 && read >= 1) rows[2].labelDisabled = false;
      return rows;
    },
  });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'batch-result-panel-target-not-verified');
  assertNoForeignAction(h.calls);
});

test('D41 an inert foreign row that DISAPPEARS after the identity read is accepted (render, not drift)', async () => {
  const h = makeDriver({
    mutate: ({ idx, read, rows }) => {
      // read 0 = the identity read (2 selected targets + 2 grey foreign rows); every later
      // read of the same panel renders only the 2 selected targets. Each read is internally
      // consistent (footer === checked count, exact 30-panel set, unique active), so this is
      // legitimate rendering and must NOT fail the post-bind proof.
      if (idx === 5 && read >= 1) return rows.slice(0, 2);
      return rows;
    },
  });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, true, JSON.stringify(res.reason || res));
  assert.equal(res.batchApplied, true);
  assert.equal(res.partial, false);
  assert.deepEqual(res.accountIds, TARGETS, 'the original target identity is preserved');
  assert.equal(h.calls.panel.length, 31, '30 panel proofs + one restore of the original anchor');
  assert.equal(h.active(), IDS30[0]);
  assert.equal(h.calls.applyBatch, 1);
  assert.equal(h.calls.modalConfirm, 1);
  assert.equal(h.calls.commit, 1);
  assertNoForeignAction(h.calls);
});

test('D40 footer 2 with a wrong actual checked count fails the post-bind proof', async () => {
  const h = makeDriver({ selectedCountAt: ({ idx, checked }) => (idx === 5 ? checked + 1 : checked) });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'batch-result-panel-target-not-verified');
  assertNoForeignAction(h.calls);
});

test('D40 a panel showing ONLY foreign rows (no target row at all) fails the post-bind proof', async () => {
  const h = makeDriver({
    mutate: ({ idx, rows }) => {
      if (idx === 5) return rows.filter(r => FOREIGN.includes(r.ids[0]));
      return rows;
    },
  });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'batch-result-panel-target-not-verified');
});
