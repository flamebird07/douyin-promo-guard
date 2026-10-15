'use strict';
// R63 offline regression for the auto-opened account-drawer settle gap. The REAL exported
// createRealDrivers from run-plans.cjs runs against an injected fake page and a short
// nativeScrollTimeoutMs budget: no network, no browser, no credentials, no real commit.
// Asserts (1) a transiently-conflicting/unknown drawer settles PASSIVELY before any header
// click, (2) a persistent conflict keeps the EXACT original reason with zero actions and
// sanitized numeric diagnostics, (3) active/account-identity drift observed after a
// trustworthy read is never adopted, (4) a valid >=1 checked subset is preserved without a
// forced select-all, and (5) drawer reads stay bounded. Run: node --test drawer-settle-r63.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const wf = require('./plan-workflow.cjs');
const rp = require('./run-plans.cjs');

const IDS = Array.from({ length: 30 }, (_, i) => '384581162524855' + String(5100 + i));
const GOOD = ['79863866', '9zmao_fushi'];

const snapOf = ov => Object.assign({
  ok: true,
  rows: GOOD.map(id => ({ ids: [id], checked: false })),
  headerSelectAllCount: 1, selectedCount: 0, totalCount: 30,
  batchButtonCount: 1, batchEnabled: true, headerLabelDisabled: false,
  panelProductIds: IDS, activeProductIds: [IDS[0]]
}, ov || {});

function drawerSettleHost({ reads, anchorManualAccounts = 0, timeoutMs = 200 }) {
  let cursor = 0;
  const st = { drawerReads: 0, headerCalls: 0, applyCalls: 0, panelClicks: 0, modalConfirmed: 0, confirmed: 0, headerAfterDrawerReads: null };
  const log = [];
  const page = { evaluate: async (fn, arg) => {
    if (fn === rp.readMainTableInPage) return { ok: true, rows: IDS.map((productId, i) => ({ productId, manualAccounts: i === 0 ? anchorManualAccounts : 0, manualEvidence: true, manualCountKnown: true, autoPullOnly: false, reviewFailed: false })) };
    if (fn === rp.bindingDrawerSnapshotInPage) {
      const s = reads[Math.min(cursor, reads.length - 1)]; cursor++; st.drawerReads++; log.push('read');
      return s;
    }
    if (fn === rp.selectAllAccountsInPage) { st.headerCalls++; st.headerAfterDrawerReads = st.drawerReads; log.push('header'); return { clicked: true }; }
    if (fn === rp.applyBatchAccountsInPage) { st.applyCalls++; log.push('apply'); return { clicked: true }; }
    if (fn === rp.batchAddAllModalSnapshotInPage) { log.push('modal-snapshot'); return { ok: true, modalCount: 0, productCount: 29, accountCount: 2, drawerSettled: false }; }
    if (fn === rp.confirmBatchAddAllModalInPage) { st.modalConfirmed++; return { clicked: true, productCount: 29 }; }
    if (fn === rp.confirmBatchAccountsApplyInPage) { st.confirmed++; return { clicked: true }; }
    if (fn === rp.selectBindingDrawerPanelInPage) { st.panelClicks++; log.push('panel'); return { clicked: true, id: String(arg) }; }
    if (fn === rp.guidanceActionInPage) return { present: false, unknown: false, roots: [] };
    if (!fn.name) return { ok: true };
    throw new Error('unexpected drawer-settle function ' + String(fn && fn.name));
  } };
  const driver = rp.createRealDrivers({ page, managerPage: {}, context: {}, dayState: { lastSelected: [], cursor: { seenProductIds: [] } }, persist: async () => {}, publishedIds: new Set(), attemptedSet: new Set(), hints: {}, accountId: wf.BUSINESS.accountId, opened: {}, projectRoot: __dirname, planNumber: 1, runId: 'offline', nativeScrollTimeoutMs: timeoutMs });
  return { bind: () => driver.bindAccountsToAll({ productIds: IDS }), state: () => Object.assign({}, st), log: () => log.slice() };
}

test('a transient footer/row conflict settles passively and the header click happens only AFTER the settled read', async () => {
  const h = drawerSettleHost({ reads: [
    snapOf({ rows: [{ ids: [GOOD[0]], checked: true }, { ids: [GOOD[1]], checked: false }], selectedCount: 0 }),
    snapOf({}),
    snapOf({ rows: GOOD.map(id => ({ ids: [id], checked: true })), selectedCount: 2 })
  ] });
  const r = await h.bind();
  const s = h.state();
  assert.equal(s.headerCalls, 1, 'settled 0/30 reaches exactly one header select-all');
  assert.equal(s.headerAfterDrawerReads, 2, 'header only after the transient conflict was re-read as settled');
  assert.deepEqual(h.log().slice(0, 4), ['read', 'read', 'header', 'read']);
  assert.equal(s.applyCalls, 1);
  assert.equal(s.modalConfirmed, 0, 'fake stops before modal 确定/commit');
  assert.equal(s.confirmed, 0);
  assert.equal(s.panelClicks, 0);
  assert.equal(r.ok, false); assert.equal(r.reason, 'native-batch-apply-modal-not-confirmed');
});

test('unknown checkbox states and a missing footer may settle into a usable drawer without any action', async () => {
  const h = drawerSettleHost({ reads: [
    snapOf({ rows: GOOD.map(id => ({ ids: [id], checked: null })), selectedCount: null, totalCount: null }),
    snapOf({}),
    snapOf({ rows: GOOD.map(id => ({ ids: [id], checked: true })), selectedCount: 2 })
  ] });
  const r = await h.bind();
  const s = h.state();
  assert.equal(s.headerCalls, 1, 'only after the unknown transient state settles to definite 0/30');
  assert.equal(s.headerAfterDrawerReads, 2);
  assert.equal(s.panelClicks, 0);
  assert.equal(r.reason, 'native-batch-apply-modal-not-confirmed');
});

test('a persistent footer/row conflict keeps the ORIGINAL reason, zero actions, bounded reads and sanitized numeric diagnostics', async () => {
  const h = drawerSettleHost({ reads: [snapOf({ rows: [{ ids: [GOOD[0]], checked: true }, { ids: [GOOD[1]], checked: false }], selectedCount: 0 })], timeoutMs: 1200 });
  const r = await h.bind();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'account-drawer-footer-row-state-conflict', 'persistent contradiction stays fail-closed with the same public reason');
  const s = h.state();
  assert.equal(s.headerCalls, 0); assert.equal(s.applyCalls, 0); assert.equal(s.panelClicks, 0);
  assert.ok(s.drawerReads <= 6, 'bounded poll + one fallback read, never an unbounded loop: ' + s.drawerReads);
  assert.equal(r.diag.phase, 'initial-auto-drawer');
  assert.equal(r.diag.rowCount, 2);
  assert.equal(r.diag.knownCheckedCount, 1);
  assert.equal(r.diag.unknownStateCount, 0);
  assert.equal(r.diag.selectedCount, 0);
  assert.equal(r.diag.totalCount, 30);
  const raw = JSON.stringify(r.diag);
  assert.ok(!raw.includes(GOOD[0]) && !raw.includes(GOOD[1]) && !raw.includes('384581'), 'diagnostics carry counts only, never ids/text');
});

test('active-product drift after a trustworthy read is never adopted and stops with zero actions', async () => {
  const h = drawerSettleHost({ reads: [
    snapOf({ rows: GOOD.map(id => ({ ids: [id], checked: null })) }),
    snapOf({ activeProductIds: [IDS[5]], rows: [{ ids: [GOOD[0]], checked: false }, { ids: [GOOD[1]], checked: false }], selectedCount: 0 })
  ] });
  const r = await h.bind();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'account-drawer-does-not-show-exact-two-target-accounts', 'the drifted identity is rejected, the existing exact-two guard reports it');
  const s = h.state();
  assert.equal(s.drawerReads, 2, 'one bounded poll read + one fallback read');
  assert.equal(s.headerCalls, 0); assert.equal(s.applyCalls, 0); assert.equal(s.panelClicks, 0);
});

test('a drifted-but-consistent snapshot whose panel set no longer matches the batch is never adopted', async () => {
  const h = drawerSettleHost({ reads: [
    snapOf({ rows: GOOD.map(id => ({ ids: [id], checked: null })) }),
    snapOf({ panelProductIds: IDS.slice(0, 29) })
  ] });
  const r = await h.bind();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'account-drawer-panel-identity-unverified');
  const s = h.state();
  assert.equal(s.headerCalls, 0); assert.equal(s.applyCalls, 0); assert.equal(s.panelClicks, 0);
});

test('account-row identity drift after a trustworthy read is never adopted and stops with zero actions', async () => {
  const h = drawerSettleHost({ reads: [
    snapOf({ rows: [{ ids: [GOOD[0]], checked: null }] }),
    snapOf({ rows: [{ ids: [GOOD[1]], checked: false }], selectedCount: 0 })
  ] });
  const r = await h.bind();
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'account-drawer-does-not-show-exact-two-target-accounts');
  const s = h.state();
  assert.equal(s.headerCalls, 0); assert.equal(s.applyCalls, 0); assert.equal(s.panelClicks, 0);
});

test('a stable valid 1-of-2 checked subset is preserved immediately with zero extra polling and no forced header', async () => {
  const h = drawerSettleHost({ reads: [snapOf({ rows: [{ ids: [GOOD[0]], checked: true }, { ids: [GOOD[1]], checked: false }], selectedCount: 1 })], anchorManualAccounts: 1 });
  const r = await h.bind();
  const s = h.state();
  assert.equal(s.drawerReads, 1, 'an already-settled drawer is adopted on the first read');
  assert.equal(s.headerCalls, 0, 'the deliberate unchecked row is never force-overwritten by a select-all');
  assert.equal(s.applyCalls, 1);
  assert.equal(s.modalConfirmed, 0); assert.equal(s.confirmed, 0);
  assert.equal(r.ok, false); assert.equal(r.reason, 'native-batch-apply-modal-not-confirmed');
});
