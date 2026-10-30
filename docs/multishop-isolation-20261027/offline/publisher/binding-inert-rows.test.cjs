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

function mainRows(noAnchor) {
  return IDS30.map((productId, i) => ({
    productId,
    manualAccounts: noAnchor ? 0 : (i === 0 ? 2 : 1),
    manualEvidence: true,
    manualCountKnown: true,
    autoPullOnly: false,
    reviewFailed: false,
    text: 'ID：' + productId,
  }));
}

// `mutate` may rewrite the rows of a selected panel; `selectedCountAt` may override the
// footer count. Both are keyed by the panel index so a single later panel can be broken.
// D43 additions: `initialRows` is what the FIRST (anchor) panel already shows when the
// auto drawer is read, `initialHeaderDisabled` its header state, `noAnchor` makes the main
// table read zero manual accounts for every product (no bound anchor at all), and `reopen`
// simulates the real management-button reopen: cancel → proven closed → open the anchor's
// drawer again, whose rows/header are then whatever `reopen.rows`/`reopen.headerDisabled`
// say. The drawer primitives are matched by their real function NAMES, exactly like the
// production driver calls them.
// D44 additions: `reopenFail` makes the management open return no snapshot at all (a real
// ambiguous/failed button click), and `emptyPanel` simulates the live D42 contradictory
// render of ONE later panel — `{ idx, mode: 'first'|'always', footer, wrongActiveOnRevisit }`:
// while that panel is active and its visit count is 1 ('first') or any ('always') it returns
// ZERO account rows with a positive footer selectedCount (the footer 当前商品已选 2/30 with no
// rows), header enabled. `wrongActiveOnRevisit` makes the refreshed (2nd) visit report the
// WRONG unique active, so the bounded refresh must not adopt it.
// D45 note: every driver below returns NO result modal (batchResultSnapshotInPage present:false),
// which is the live D45 shape — the absent-popup branch now classifies all 30 panels as proven
// BOUND or proven ZERO instead of demanding all-success. `emptyPanel` with footer 0 is the
// "0 rows at 0/30" unknown case that must still stop.
// D46 additions: `probeTimeoutMs` overrides the bounded native wait (default 30) so a phase-2
// window can span several reads — the partial branch now gives the real binding outcome the FULL
// window and only classifies a stable zero at expiry; `activeOverride({idx, read, active})` may
// report a WRONG unique active for selected panel reads, simulating mid-window identity drift.
function makeDriver({ mutate, selectedCountAt, initialRows, initialHeaderDisabled, noAnchor, reopen, reopenFail, emptyPanel, probeTimeoutMs, activeOverride } = {}) {
  let active = IDS30[0];
  let panelReads = 0;
  let drawerOpen = true;
  let reopenedFor = null;
  const visits = new Map();
  const calls = { panel: [], selectAll: 0, applyBatch: 0, modalConfirm: 0, commit: 0, cancel: 0, anchorOpen: [], unknown: [] };
  const page = {
    url: () => 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi?aavid=' + ACCOUNT,
    evaluate: async (fn, arg) => {
      if (fn === rp.readMainTableInPage) return { ok: true, rows: mainRows(noAnchor) };
      if (fn === rp.bindingDrawerSnapshotInPage) {
        if (!drawerOpen) return { ok: false, count: 0 };
        const idx = IDS30.indexOf(String(active));
        const visit = visits.get(String(active)) || 0;
        if (emptyPanel && idx === emptyPanel.idx && (emptyPanel.mode === 'always' || visit <= 1)) {
          return {
            ok: true, spinnerCount: 0, headerLabelDisabled: false,
            rows: [], panelProductIds: IDS30.slice(), activeProductIds: [String(active)],
            selectedCount: Number.isInteger(emptyPanel.footer) ? emptyPanel.footer : 2, totalCount: 30,
          };
        }
        const read = panelReads++;
        const isReopenedAnchor = reopenedFor !== null && String(active) === String(reopenedFor) && reopen;
        let rows = isReopenedAnchor ? reopen.rows()
          : (idx === 0 ? (typeof initialRows === 'function' ? initialRows() : targetRows()) : laterRows());
        if (typeof mutate === 'function') {
          const next = mutate({ idx, read, rows: rows.map(r => ({ ...r, ids: r.ids.slice() })) });
          if (Array.isArray(next)) rows = next;
        }
        const checked = rows.filter(r => r.checked === true).length;
        const footer = typeof selectedCountAt === 'function' ? selectedCountAt({ idx, checked }) : checked;
        const wrongActive = !!emptyPanel && emptyPanel.wrongActiveOnRevisit === true && idx === emptyPanel.idx && visit >= 2;
        let activeId = wrongActive ? IDS30[0] : String(active);
        if (typeof activeOverride === 'function' && idx >= 0) {
          const ov = activeOverride({ idx, read, active: String(active) });
          if (ov) activeId = String(ov);
        }
        return {
          ok: true, spinnerCount: 0,
          headerLabelDisabled: isReopenedAnchor ? reopen.headerDisabled === true : initialHeaderDisabled === true,
          rows, panelProductIds: IDS30.slice(), activeProductIds: [activeId],
          selectedCount: footer, totalCount: 30,
        };
      }
      if (fn === rp.selectBindingDrawerPanelInPage) {
        const id = String(arg);
        calls.panel.push(id);
        active = id;
        panelReads = 0;
        visits.set(id, (visits.get(id) || 0) + 1);
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
      const name = String((fn && fn.name) || 'anonymous');
      if (name === 'cancelAutoOpenedDrawerInPage') { calls.cancel++; drawerOpen = false; return { cancelled: true }; }
      if (name === 'openAnchorManagementInPage') {
        calls.anchorOpen.push(String(arg));
        if (reopenFail === true) return null;
        drawerOpen = true;
        reopenedFor = String(arg);
        active = String(arg);
        panelReads = 0;
        return { ok: true, productId: String(arg) };
      }
      calls.unknown.push(name);
      return null;
    },
  };
  const driver = rp.createRealDrivers({
    page, managerPage: {}, context: {},
    dayState: { lastSelected: [], cursor: { seenProductIds: [] } },
    persist: async () => {}, publishedIds: new Set(), attemptedSet: new Set(),
    hints: {}, accountId: ACCOUNT, boundAccounts: TARGETS.slice(), opened: {},
    projectRoot: __dirname, planNumber: 1, runId: 'offline',
    nativeScrollTimeoutMs: Number.isInteger(probeTimeoutMs) && probeTimeoutMs > 0 ? probeTimeoutMs : 30,
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

// ── D43: the same inert-row shape on the ACTION (reuse) side ─────────────────
// The live D43 stop was prepare-stopped:native-account-header-select-all-disabled at
// stage account-rebinding: a REBIND batch whose drawer already showed the two approved
// targets CHECKED beside two grey foreign rows was judged by the STRICT action identity,
// so the correct selection was cancelled and the anchor was reopened; the reopened
// management drawer then had no checked row and a disabled header, which is exactly the
// stop above. These tests drive the REAL createRealDrivers().bindAccountsToAll through
// that sequence.
const uncheckedTargets = () => TARGETS.map(id => ({ ids: [id], checked: false, labelDisabled: false }));
const greyTargets = () => TARGETS.map(id => ({ ids: [id], checked: false, labelDisabled: true }));
const inertForeign = () => FOREIGN.map(id => ({ ids: [id], checked: false, labelDisabled: true }));

test('D43 a rebind drawer already showing the targets checked beside inert foreign rows is reused with ZERO reopen/header', async () => {
  const h = makeDriver({ initialRows: laterRows });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, true, JSON.stringify(res.reason || res));
  assert.equal(res.batchApplied, true);
  assert.deepEqual(res.accountIds, TARGETS, 'the frozen target identity is preserved — no foreign id is ever adopted');
  assert.equal(h.calls.cancel, 0, 'a correct checked drawer is never cancelled');
  assert.equal(h.calls.anchorOpen.length, 0, 'no management reopen of an already-correct drawer');
  assert.equal(h.calls.selectAll, 0, 'no header select-all is needed or performed');
  assert.equal(h.calls.applyBatch, 1);
  assert.equal(h.calls.modalConfirm, 1);
  assert.equal(h.calls.commit, 1);
  assert.equal(h.calls.panel.length, 31);
  assertNoForeignAction(h.calls);
});

test('D43 an anchor reopen that settles on the targets checked beside inert foreign rows is reusable', async () => {
  const h = makeDriver({
    initialRows: uncheckedTargets,
    initialHeaderDisabled: true,
    reopen: { rows: laterRows, headerDisabled: false },
  });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, true, JSON.stringify(res.reason || res));
  assert.deepEqual(res.accountIds, TARGETS);
  assert.equal(h.calls.cancel, 1, 'the unusable 0/30 auto drawer is cancelled exactly once');
  assert.deepEqual(h.calls.anchorOpen, [IDS30[0]], 'the bound anchor is reopened exactly once');
  assert.equal(h.calls.selectAll, 0, 'the reopened drawer is reused, never header-clicked');
  assert.equal(h.calls.applyBatch, 1);
  assert.equal(h.calls.modalConfirm, 1);
  assert.equal(h.calls.commit, 1);
  assertNoForeignAction(h.calls);
});

test('D43 a CHECKED foreign row is never reused, even beside correctly checked targets', async () => {
  const h = makeDriver({
    noAnchor: true,
    initialRows: () => targetRows().concat([{ ids: [FOREIGN[0]], checked: true, labelDisabled: false }, { ids: [FOREIGN[1]], checked: false, labelDisabled: true }]),
  });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'account-drawer-does-not-show-exact-two-target-accounts');
  assert.equal(h.calls.selectAll, 0);
  assert.equal(h.calls.applyBatch, 0);
  assert.equal(h.calls.commit, 0);
});

test('D43 an ENABLED unchecked foreign row is never reused, even beside correctly checked targets', async () => {
  const h = makeDriver({
    noAnchor: true,
    initialRows: () => targetRows().concat([{ ids: [FOREIGN[0]], checked: false, labelDisabled: false }, { ids: [FOREIGN[1]], checked: false, labelDisabled: true }]),
  });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'account-drawer-does-not-show-exact-two-target-accounts');
  assert.equal(h.calls.selectAll, 0);
  assert.equal(h.calls.applyBatch, 0);
  assert.equal(h.calls.commit, 0);
});

test('D43 a genuinely unusable reopened anchor (no checked row, disabled header) still stops with the exact live reason', async () => {
  const h = makeDriver({
    initialRows: uncheckedTargets,
    initialHeaderDisabled: true,
    reopen: { rows: greyTargets, headerDisabled: true },
  });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'native-account-header-select-all-disabled', 'the D43 stop reason is preserved, never masked');
  assert.equal(h.calls.selectAll, 0, 'a disabled header is never clicked');
  assert.equal(h.calls.applyBatch, 0);
  assert.equal(h.calls.modalConfirm, 0);
  assert.equal(h.calls.commit, 0);
  assert.equal(h.calls.cancel, 1);
  assert.deepEqual(h.calls.anchorOpen, [IDS30[0]]);
});

test('D43 inert foreign rows never turn an all-unchecked drawer into a reusable selection', async () => {
  const h = makeDriver({
    initialRows: () => uncheckedTargets().concat(inertForeign()),
    initialHeaderDisabled: true,
    reopen: { rows: () => greyTargets().concat(inertForeign()), headerDisabled: true },
  });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'native-account-rows-label-disabled', 'a 0-checked panel is a real stop, not a reuse');
  assert.equal(h.calls.selectAll, 0);
  assert.equal(h.calls.applyBatch, 0);
  assert.equal(h.calls.modalConfirm, 0);
  assert.equal(h.calls.commit, 0);
});

// ── D44: stop-reason truthfulness + bounded refresh of a contradictory empty panel ───────
// The D43 stop above used to be reported as 'anchor-account-management-button-not-unique' even
// though the management open DID succeed and returned a readable drawer whose rows were simply
// all unchecked + label-disabled. That is a page-snapshot fact, not an ambiguous button, so the
// stop now keeps the row-state literal. The button literal stays for the case it actually
// describes: an open that produced NO drawer snapshot at all.
test('D44 an unreadable reopen (no drawer snapshot) keeps the exact management-button stop', async () => {
  const h = makeDriver({
    initialRows: () => uncheckedTargets().concat(inertForeign()),
    initialHeaderDisabled: true,
    reopenFail: true,
  });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'anchor-account-management-button-not-unique', 'a genuinely failed open is still reported as such');
  assert.equal(h.calls.cancel, 1);
  assert.deepEqual(h.calls.anchorOpen, [IDS30[0]]);
  assert.equal(h.calls.selectAll, 0);
  assert.equal(h.calls.applyBatch, 0);
  assert.equal(h.calls.modalConfirm, 0);
  assert.equal(h.calls.commit, 0);
});

test('D44 a transient contradictory empty panel (rows 0, footer 2) recovers through ONE bounded re-navigation of the SAME product', async () => {
  const h = makeDriver({ emptyPanel: { idx: 5, mode: 'first', footer: 2 } });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, true, JSON.stringify(res.reason || res));
  assert.equal(res.batchApplied, true);
  assert.deepEqual(res.accountIds, TARGETS, 'the frozen target identity is never re-derived from a footer');
  assert.equal(h.calls.selectAll, 0, 'a refresh never selects accounts');
  assert.equal(h.calls.applyBatch, 1);
  assert.equal(h.calls.modalConfirm, 1);
  assert.equal(h.calls.commit, 1);
  assert.equal(h.calls.panel.length, 33, '30 panel proofs + one away/back refresh pair + one anchor restore');
  assert.equal(h.calls.panel[6], IDS30[0], 'the refresh leaves to another KNOWN panel of the same batch');
  assert.equal(h.calls.panel[7], IDS30[5], 'and comes straight back to the SAME proven product');
  assert.equal(h.calls.panel[h.calls.panel.length - 1], IDS30[0]);
  assertNoForeignAction(h.calls);
});

test('D44 a persistent contradictory empty panel stops after exactly ONE refresh (never an unbounded retry)', async () => {
  const h = makeDriver({ emptyPanel: { idx: 5, mode: 'always', footer: 2 } });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'batch-result-panel-target-not-verified', 'footer 2 with no rows is never success');
  assert.equal(h.calls.panel.filter(id => id === IDS30[5]).length, 2, 'exactly one away/back pair for that panel');
  assert.equal(h.calls.selectAll, 0);
  assert.equal(h.calls.applyBatch, 1);
  assert.equal(h.calls.modalConfirm, 1);
  assert.equal(h.calls.commit, 0, 'an unproven panel never commits the drawer');
});

test('D44 a refresh that lands on a WRONG active identity stops instead of adopting the footer', async () => {
  const h = makeDriver({ emptyPanel: { idx: 5, mode: 'first', footer: 2, wrongActiveOnRevisit: true } });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'batch-result-panel-target-not-verified');
  assert.equal(h.calls.panel.filter(id => id === IDS30[5]).length, 2);
  assert.equal(h.calls.selectAll, 0);
  assert.equal(h.calls.commit, 0);
  assert.equal(h.calls.modalConfirm, 1);
  assertNoForeignAction(h.calls);
});

// ── D45: an ABSENT result popup must classify every panel as bound or proven-zero ────────
// Live D45 (2026-10-29 21:53:59 capture): the batch raised NO result modal at all; every panel
// read the exact identity (30 panels, unique active, spinner 0, header enabled) and TWO panels
// showed BOTH frozen targets unchecked at 当前商品已选 0/30. The old absent-popup branch demanded
// all-success, so those two PROVEN-ZERO panels ended the run as
// prepare-stopped:batch-result-panel-target-not-verified even though 28 products were bound.
// The SAME 30-panel proof now runs in 'partial' mode: proven-zero ids become the exact failedIds
// of the EXISTING partial commit / removal / replacement workflow, while an all-bound proof keeps
// the unchanged full success. Absence of the popup never means empty, unknown or success.
const zeroTargets = () => TARGETS.map(id => ({ ids: [id], checked: false, labelDisabled: false }));

test('D45 an absent popup with ONE proven-zero panel returns that exact id and takes the partial commit path', async () => {
  const h = makeDriver({ mutate: ({ idx }) => (idx === 5 ? zeroTargets() : null) });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, true, JSON.stringify(res.reason || res));
  assert.equal(res.partial, true, 'a panel proven at exactly 0/30 is a real partial outcome, never success');
  assert.deepEqual(res.failedIds, [IDS30[5]], 'only the panel proven at exactly 0/30 becomes a failed id');
  assert.deepEqual(res.accountIds, TARGETS, 'the frozen target identity is never re-derived from a footer');
  assert.equal(h.calls.applyBatch, 1);
  assert.equal(h.calls.modalConfirm, 1);
  assert.equal(h.calls.commit, 1, 'the existing partial draft commit still runs');
  assert.equal(h.calls.selectAll, 0, 'a read-only proof never selects accounts');
  assert.equal(h.calls.panel.length, 31, '30 panel proofs + one anchor restore');
  assert.equal(h.calls.panel[h.calls.panel.length - 1], IDS30[0], 'the original anchor is restored before the commit');
  assert.equal(h.active(), IDS30[0]);
  assertNoForeignAction(h.calls);
});

test('D45 an absent popup with TWO proven-zero panels reports exactly those two ids', async () => {
  const h = makeDriver({ mutate: ({ idx }) => (idx === 2 || idx === 5 ? zeroTargets() : null) });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, true, JSON.stringify(res.reason || res));
  assert.equal(res.partial, true);
  assert.deepEqual(res.failedIds.slice().sort(), [IDS30[2], IDS30[5]].sort());
  assert.equal(h.calls.commit, 1);
  assert.equal(h.calls.panel.length, 31);
  assertNoForeignAction(h.calls);
});

test('D45 an absent popup with all 30 panels proven bound stays a full success with NO failed ids', async () => {
  const h = makeDriver();
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, true, JSON.stringify(res.reason || res));
  assert.equal(res.partial, false);
  assert.deepEqual(res.failedIds, [], 'an all-bound 30-panel proof yields an empty failed set');
  assert.equal(h.calls.applyBatch, 1);
  assert.equal(h.calls.modalConfirm, 1);
  assert.equal(h.calls.commit, 1);
  assert.equal(h.calls.panel.length, 31);
  assertNoForeignAction(h.calls);
});

test('D45 an EMPTY panel (0 rows at 0/30) is UNKNOWN, never a proven zero: the bind still stops', async () => {
  const h = makeDriver({ emptyPanel: { idx: 5, mode: 'always', footer: 0 } });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'batch-result-panel-target-not-verified', 'zero rows is never "empty == zero"');
  assert.equal(h.calls.commit, 0, 'an unproven panel never commits the drawer');
  assert.equal(h.calls.panel.filter(id => id === IDS30[5]).length, 1, 'a 0-row panel triggers no refresh pair');
  assert.equal(h.calls.selectAll, 0);
});

test('D45 a proven-zero panel that ALSO shows an ENABLED foreign row is not a zero: the bind still stops', async () => {
  const h = makeDriver({
    mutate: ({ idx }) => (idx === 5 ? zeroTargets().concat([{ ids: [FOREIGN[0]], checked: false, labelDisabled: false }]) : null),
  });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'batch-result-panel-target-not-verified');
  assert.equal(h.calls.commit, 0);
  assert.equal(h.calls.selectAll, 0);
  assertNoForeignAction(h.calls);
});

test('D45 a panel whose footer disagrees with its unchecked rows is never a proven zero', async () => {
  const h = makeDriver({
    mutate: ({ idx }) => (idx === 5 ? zeroTargets() : null),
    selectedCountAt: ({ idx, checked }) => (idx === 5 ? checked + 1 : checked),
  });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'batch-result-panel-target-not-verified', 'footer 1 with 0 checked rows is a conflict, not a zero');
  assert.equal(h.calls.commit, 0);
});

// ── D46: the partial phase-2 window waits for the REAL outcome, then classifies a STABLE zero ──
// D45 closed the phase-2 window the moment a zero SHAPE read, which mis-judged the live late
// render (identity settled, rows/footer still stale-zero, real binding arrives one poll later).
// D46 keeps the two-phase budget: partial phase 2 is ended ONLY by provesTarget; at expiry a
// panel classifies PROVEN ZERO iff the LAST read is an identity-valid zero, a zero shape was
// seen inside the window and NO neither-bound-nor-zero read ever flipped it. Empty rows, a wrong
// active mid-window, or a zero→empty→zero flip stay fail-closed with the ORIGINAL reason.
test('D46 absent popup mixed: bound panels plus STABLE proven-zero panels yield exactly the zero ids as failedIds', async () => {
  const h = makeDriver({ mutate: ({ idx }) => (idx === 2 || idx === 5 || idx === 11 ? zeroTargets() : null) });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, true, JSON.stringify(res.reason || res));
  assert.equal(res.partial, true, 'stable proven-zero panels are a real partial outcome');
  assert.deepEqual(res.failedIds.slice().sort(), [IDS30[2], IDS30[5], IDS30[11]].sort(), 'failedIds are exactly the stable-zero panels');
  assert.equal(h.calls.commit, 1, 'the existing partial commit path still runs once');
  assert.equal(h.calls.selectAll, 0, 'a read-only proof never selects accounts');
  assert.equal(h.calls.panel.length, 31, '30 panel proofs + one anchor restore, no refresh pair');
  assertNoForeignAction(h.calls);
});

test('D46 delayed binding outcome: zero-shape reads do NOT end the window — the late real binding proves and the batch fully succeeds', async () => {
  const h = makeDriver({
    probeTimeoutMs: 1100,
    mutate: ({ idx, read }) => {
      if (idx !== 5) return null;
      // read 0 = the identity read, read 1 = the first phase-2 poll: both still the stale zero
      // render. From read 2 the real bound rows appear — the window must still be open for it.
      if (read <= 1) return zeroTargets();
      return null;
    },
  });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, true, JSON.stringify(res.reason || res));
  assert.notEqual(res.partial, true, 'a panel whose real outcome lands inside the window is BOUND, never a zero');
  assert.deepEqual(res.failedIds, []);
  assert.equal(h.calls.commit, 1);
  assert.equal(h.calls.panel.length, 31, 'no refresh pair: the delayed outcome needed no re-navigation');
  assertNoForeignAction(h.calls);
});

test('D46 persistent EMPTY rows for the whole window stay fail-closed — never classified zero, never success, zero commit', async () => {
  const h = makeDriver({ probeTimeoutMs: 1100, emptyPanel: { idx: 5, mode: 'always', footer: 0 } });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'batch-result-panel-target-not-verified', 'rows=[] at 0/30 is unknown, not a proven zero');
  assert.notEqual(res.partial, true);
  assert.ok(!Array.isArray(res.failedIds) || !res.failedIds.includes(IDS30[5]), 'an unknown panel never enters failedIds');
  assert.equal(h.calls.commit, 0, 'an unproven panel never commits the drawer');
  assert.equal(h.calls.panel.filter(id => id === IDS30[5]).length, 1, 'no refresh pair is spent on a 0-row panel');
  assert.equal(h.calls.selectAll, 0);
});

test('D46 a wrong active that persists through the window is an identity failure, not a zero: the bind stops fail-closed', async () => {
  const h = makeDriver({
    probeTimeoutMs: 1100,
    activeOverride: ({ idx, read }) => (idx === 5 && read >= 1 ? IDS30[9] : null),
  });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'batch-result-panel-target-not-verified', 'active drift inside the window is never adopted and never classifies');
  assert.notEqual(res.partial, true);
  assert.equal(h.calls.commit, 0);
  assert.equal(h.calls.panel.filter(id => id === IDS30[5]).length, 1, 'the drifted panel is navigated to exactly once');
  assert.equal(h.calls.panel.filter(id => id === IDS30[9]).length, 0, 'the wrong active product is never clicked');
  assert.equal(h.calls.selectAll, 0);
});

test('D46 all 30 panels bound remains a full success with an empty failedIds (D46 regression of the D45 all-bound shape)', async () => {
  const h = makeDriver();
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, true, JSON.stringify(res.reason || res));
  assert.equal(res.partial, false);
  assert.deepEqual(res.failedIds, []);
  assert.equal(h.calls.commit, 1);
  assert.equal(h.calls.panel.length, 31);
  assertNoForeignAction(h.calls);
});

test('D46 an UNSTABLE zero (zero rows -> empty rows -> zero inside the window) is never classified zero: fail-closed stop', async () => {
  const h = makeDriver({
    probeTimeoutMs: 1100,
    mutate: ({ idx, read }) => {
      if (idx !== 5) return null;
      if (read <= 1) return zeroTargets();   // identity read + first phase-2 poll: zero shape
      if (read === 2) return [];             // flipped to EMPTY rows at 0/30 — neither bound nor zero
      if (read === 3) return zeroTargets();  // flips back to the zero shape
      return null;
    },
  });
  const res = await h.driver.bindAccountsToAll({ productIds: IDS30.slice() });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'batch-result-panel-target-not-verified', 'a shape flip forbids the zero classification');
  assert.notEqual(res.partial, true);
  assert.equal(h.calls.commit, 0, 'zero commit on the unstable window');
  assert.equal(h.calls.panel.filter(id => id === IDS30[5]).length, 1, 'no refresh pair: the last read is not a contradictory footer');
  assert.equal(h.calls.selectAll, 0);
});
