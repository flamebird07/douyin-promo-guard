'use strict';
// R65 preparation-diagnostics tests. Pure DI, no fs/network/browser.
// Exercises the ACTUAL wf.preparePlan + runGuidancePhase + handleLateGuidanceBeforeNativeAdvance
// and asserts only whitelisted diagnostic fields cross the workflow/parent boundary.
const assert = require('assert');
const Module = require('module');
const path = require('path');
const stubPath = path.resolve(__dirname, 'confirmation-ui.cjs');
if (!Module._cache[stubPath]) {
  const m = new Module(stubPath, module);
  m.filename = stubPath;
  m.loaded = true;
  m.exports = { createConfirmationServer: () => ({ listen() {}, close() {} }) };
  Module._cache[stubPath] = m;
}
const wf = require('./plan-workflow.cjs');
const rp = require('./run-plans.cjs');

const BIZ = {
  shop: 'TESTSHOP', accountId: '1710242295996424',
  boundAccounts: ['79863866', '9zmao_fushi'],
  productsPerPlan: 30, roi: 15, dailyBudget: 300,
  commissionIncluded: true, directPay: false,
  maxPlansPerDay: 3, creationPath: '/uni-creation/overall-product-multi',
  creationUrl: '/uni-creation/overall-product-multi?aavid=1710242295996424',
};

function validRows(n, startOffset) {
  const base = 1234567890123450 + (startOffset || 0);
  return Array.from({ length: n }, (_, i) => ({
    productId: String(base + i),
    manualAccounts: 1, manualEvidence: true, autoPullOnly: false, reviewFailed: false, precheck: false,
  }));
}

function baseDeps(overrides) {
  return Object.assign({
    planNumber: 1, runId: 'plan-scheduler-2026-10-12-aaaaaaaaaaaaaaaa', businessDate: '2026-10-12',
    business: BIZ, requireRealDrivers: true, nowMs: Date.UTC(2026, 9, 12, 4, 42, 0),
    dayState: { attempted: [], lastSelected: [], hints: {} },
    publishedIds: [], publishedSet: new Set(),
    openCreationPage: async () => ({ header: { originOk: true, accountId: BIZ.accountId, commissionOptionPresent: true } }),
    browseProducts: async () => ({ ok: true, selectedIds: validRows(30).map(r => r.productId), hints: {}, attempted: [], cursor: { category: '店铺新品', page: 1, seenProductIds: [] } }),
    bindAccountsToAll: async () => ({ ok: true, accountIds: ['79863866', '9zmao_fushi'] }),
    readMainTable: async () => validRows(30),
    repairDraft: async () => ({ ok: true, mainRows: validRows(30), selectedCount: 30, progress: true }),
    configurePlan: async () => ({ ok: true, planName: '创建计划2026-10-12_12:42' }),
    persistState: async () => {},
  }, overrides || {});
}

// stateful page.evaluate stub for runGuidancePhase: first snapshot has one overlay
// root, subsequent snapshots are absent so runGuidanceOnPage exits after one step.
function makeGuidancePage() {
  let snapCount = 0;
  return {
    evaluate: async (_fn, arg) => {
      const mode = arg && arg.mode;
      if (mode === 'snapshot') {
        snapCount++;
        if (snapCount === 1) return { present: true, unknown: null, roots: [{ order: 0, kind: 'next-step', content: 'c', label: '下一步' }], roots_present: true };
        return { present: false, unknown: null, roots: [] };
      }
      if (mode === 'step') return { ok: true };
      return { present: false, unknown: null, roots: [] };
    },
  };
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

// ── A: configurePlan settings mismatch whitelist ─────────────────────────────
test('A1 plan-settings-readback-mismatch preserves expected/observed whitelist', async () => {
  const result = await wf.preparePlan(baseDeps({
    configurePlan: async () => ({
      ok: false, reason: 'plan-settings-readback-mismatch',
      expected: { roi: 15, budget: 300, commissionChecked: true, optionalDirectPayChecked: false, planName: '创建计划2026-10-12_12:42' },
      observed: { roi: '15.0', budget: '300', commissionChecked: true, optionalDirectPayChecked: false, planName: '创建计划2026-10-12_12:42' },
      cookieHeader: 'SECRET-COOKIE', arbitraryPath: 'C:\\Users\\secret\\file', accountToken: 'tk-abcdef',
    }),
  }));
  assert.strictEqual(result.status, 'stopped');
  assert.strictEqual(result.stage, 'plan-settings');
  assert.strictEqual(result.reason, 'plan-settings-readback-mismatch');
  assert.ok(result.settingsDiag, 'settingsDiag must be attached');
  assert.deepStrictEqual(result.settingsDiag.expected, { roi: 15, budget: 300, commissionChecked: true, optionalDirectPayChecked: false, planName: '创建计划2026-10-12_12:42' });
  assert.deepStrictEqual(result.settingsDiag.observed, { roi: '15.0', budget: '300', commissionChecked: true, optionalDirectPayChecked: false, planName: '创建计划2026-10-12_12:42' });
  const serialized = JSON.stringify(result);
  assert.strictEqual(serialized.includes('SECRET-COOKIE'), false, 'cookie material must never cross boundary');
  assert.strictEqual(serialized.includes('C:\\Users'), false, 'path material must never cross boundary');
  assert.strictEqual(serialized.includes('tk-abcdef'), false);
});

test('A2 non-mismatch settings stop carries no settingsDiag', async () => {
  const result = await wf.preparePlan(baseDeps({
    configurePlan: async () => ({ ok: false, reason: 'settings-not-confirmed' }),
  }));
  assert.strictEqual(result.status, 'stopped');
  assert.strictEqual(result.reason, 'settings-not-confirmed');
  assert.ok(!result.settingsDiag);
});

test('A3 arbitrary text in planName is dropped (fails whitelist)', async () => {
  const result = await wf.preparePlan(baseDeps({
    configurePlan: async () => ({
      ok: false, reason: 'plan-settings-readback-mismatch',
      expected: { roi: 15, budget: 300, commissionChecked: true, optionalDirectPayChecked: false, planName: 'https://evil.example/path' },
      observed: null,
    }),
  }));
  assert.strictEqual(result.settingsDiag.expected.planName, null);
  assert.strictEqual(result.settingsDiag.observed, null);
});

// ── B: binding diag whitelist carry-through ─────────────────────────────────
test('B1 initial-binding failure whitelist carry', async () => {
  const result = await wf.preparePlan(baseDeps({
    bindAccountsToAll: async () => ({
      ok: false, reason: 'account-drawer-footer-row-state-conflict',
      diag: { phase: 'initial-auto-drawer', rowCount: 30, knownCheckedCount: 2, unknownStateCount: 0, selectedCount: 3, totalCount: 30, rawRowText: 'SECRET ROW', accountIds: ['79863866'], path: 'C:\\x' },
    }),
  }));
  assert.strictEqual(result.status, 'stopped');
  assert.strictEqual(result.stage, 'account-binding');
  assert.strictEqual(result.reason, 'account-drawer-footer-row-state-conflict');
  assert.deepStrictEqual(result.bindingDiag, { phase: 'initial-auto-drawer', rowCount: 30, knownCheckedCount: 2, unknownStateCount: 0, selectedCount: 3, totalCount: 30 });
  const serialized = JSON.stringify(result);
  assert.strictEqual(serialized.includes('SECRET ROW'), false);
  assert.strictEqual(serialized.includes('C:\\x'), false);
});

test('B2 rebind failure whitelist carry', async () => {
  let readCall = 0, bindCall = 0;
  const result = await wf.preparePlan(baseDeps({
    readMainTable: async () => {
      readCall++;
      if (readCall === 1) {
        const rows = validRows(30);
        rows[0] = { ...rows[0], manualAccounts: 0 };
        rows[1] = { ...rows[1], manualAccounts: 0 };
        return rows;
      }
      return validRows(30);
    },
    bindAccountsToAll: async () => {
      bindCall++;
      if (bindCall === 1) return { ok: true, accountIds: ['79863866', '9zmao_fushi'] };
      return { ok: false, reason: 'account-drawer-footer-row-state-conflict', diag: { phase: 'reopened-anchor', rowCount: 5, knownCheckedCount: 1, unknownStateCount: 0, selectedCount: 1, totalCount: 5, arbitrary: 'leak' } };
    },
    catalogRemainingIds: validRows(4, 900000).map(r => r.productId),
  }));
  assert.strictEqual(result.status, 'stopped');
  assert.strictEqual(result.stage, 'account-rebinding');
  assert.deepStrictEqual(result.bindingDiag, { phase: 'reopened-anchor', rowCount: 5, knownCheckedCount: 1, unknownStateCount: 0, selectedCount: 1, totalCount: 5 });
  assert.strictEqual(JSON.stringify(result).includes('leak'), false);
});

test('B3 successful binding has no diag attached', async () => {
  const result = await wf.preparePlan(baseDeps());
  assert.strictEqual(result.status, 'ready-awaiting-confirmation');
  assert.strictEqual(result.bindingDiag, undefined);
});

// ── C: runGuidancePhase / handleLate safe diagnostics ───────────────────────
test('C1 handled-0 no cookie/flag writes, safe diagnostic present', async () => {
  let cookiesCalled = false, flagsCalled = false;
  const page = { evaluate: async () => ({ present: false, unknown: null, roots: [] }) };
  const out = await rp.runGuidancePhase(page, {
    accountId: BIZ.accountId,
    saveCookies: async () => { cookiesCalled = true; return { status: 'saved' }; },
    persistFlags: async () => { flagsCalled = true; return { saved: true }; },
  });
  assert.strictEqual(out.handled, 0);
  assert.strictEqual(out.cookieStatus, 'not-needed');
  assert.strictEqual(out.conflict, false);
  assert.strictEqual(out.cookieReason, 'unknown');
  assert.strictEqual(cookiesCalled, false);
  assert.strictEqual(flagsCalled, false);
  assert.ok(out.diagnostic && out.diagnostic.phase === 'guidance');
});

test('C2 cookie conflict categorized; arbitrary reason string dropped', async () => {
  const out = await rp.runGuidancePhase(makeGuidancePage(), {
    accountId: BIZ.accountId,
    saveCookies: async () => ({ status: 'saved', conflict: true, reason: 'shop-state-cookie-conflict-XYZ-https://secret.example/cookie' }),
    persistFlags: async () => ({ saved: true }),
  });
  assert.strictEqual(out.handled, 1);
  assert.strictEqual(out.cookieStatus, 'saved');
  assert.strictEqual(out.conflict, true);
  assert.strictEqual(out.cookieReason, 'conflict');
  assert.strictEqual(out.flagsSaved, true);
  assert.strictEqual(out.flagsReason, null);
  const s = JSON.stringify(out);
  assert.strictEqual(s.includes('XYZ'), false);
  assert.strictEqual(s.includes('secret.example'), false);
});

test('C3 identity-not-confirmed and no-live-session categories', async () => {
  const out1 = await rp.runGuidancePhase(makeGuidancePage(), {
    accountId: BIZ.accountId,
    saveCookies: async () => ({ status: 'failed', reason: 'cookie-identity-not-confirmed-account-mismatch' }),
    persistFlags: async () => ({ saved: true }),
  });
  assert.strictEqual(out1.cookieReason, 'identity-not-confirmed');
  const out2 = await rp.runGuidancePhase(makeGuidancePage(), {
    accountId: BIZ.accountId,
    saveCookies: async () => ({ status: 'skipped', reason: 'live-cookie-session-unavailable' }),
    persistFlags: async () => ({ saved: true }),
  });
  assert.strictEqual(out2.cookieReason, 'no-live-session');
});

test('C4 flags failure preserves known enum; arbitrary reason -> unknown', async () => {
  const out = await rp.runGuidancePhase(makeGuidancePage(), {
    accountId: BIZ.accountId,
    saveCookies: async () => ({ status: 'saved' }),
    persistFlags: async () => ({ saved: false, reason: 'fs-write-failed at path /private/foo/bar.txt' }),
  });
  assert.strictEqual(out.flagsSaved, false);
  assert.strictEqual(out.flagsReason, 'unknown');
  assert.strictEqual(JSON.stringify(out).includes('private/foo'), false);
});

test('C5 handleLate throws EXACT original message with safe diagnostic', async () => {
  const page = { evaluate: async (_fn, arg) => (arg && arg.mode === 'snapshot')
    ? { present: true, unknown: null, roots: [{ order: 0, kind: 'k', content: 'c', label: 'l' }] }
    : { ok: true } };
  let caught = null;
  try {
    await rp.handleLateGuidanceBeforeNativeAdvance(page, BIZ.accountId, async () => ({
      handled: 1, cookieStatus: 'failed', flagsSaved: false, conflict: true, cookieReason: 'conflict',
    }));
  } catch (error) { caught = error; }
  assert.ok(caught instanceof Error);
  assert.strictEqual(caught.message, 'native-advance-guide-state-not-persisted');
  assert.ok(caught.guidanceDiagnostic);
  assert.strictEqual(caught.guidanceDiagnostic.cookieReason, 'conflict');
});

test('C6 handleLate accepts a cookie CAS conflict only when private guidance flags were saved', async () => {
  let snap = 0;
  const page = { evaluate: async (_fn, arg) => {
    if (arg && arg.mode === 'snapshot') {
      snap++;
      return snap === 1
        ? { present: true, unknown: null, roots: [{ order: 0, kind: 'k', content: 'c', label: 'l' }] }
        : { present: false, unknown: null, roots: [] };
    }
    return { ok: true };
  } };
  const out = await rp.handleLateGuidanceBeforeNativeAdvance(page, BIZ.accountId, async () => ({
    handled: 1, cookieStatus: 'failed', flagsSaved: true, conflict: true, cookieReason: 'conflict',
  }));
  assert.strictEqual(out.handled, 1);
});

// ── D: onPreparationDiagnostic callback ────────────────────────────────────
test('D1 initial ready emits exactly one packet with actual counts', async () => {
  const packets = [];
  const result = await wf.preparePlan(baseDeps({ onPreparationDiagnostic: s => packets.push(s) }));
  assert.strictEqual(result.status, 'ready-awaiting-confirmation');
  assert.strictEqual(packets.length, 1);
  assert.strictEqual(packets[0].phase, 'initial');
  assert.strictEqual(packets[0].round, 0);
  assert.strictEqual(packets[0].rowCount, 30);
  assert.strictEqual(packets[0].uniqueCount, 30);
  assert.strictEqual(packets[0].deficientCount, 0);
  assert.strictEqual(packets[0].unknownManualCount, 0);
  assert.strictEqual(packets[0].reviewFailedCount, 0);
  assert.strictEqual(packets[0].ambiguousCount, 0);
  assert.strictEqual(packets[0].capacity, 30);
  assert.strictEqual(packets[0].ready, true);
});

test('D2 post-repair/rebind emits initial + after-rebind, capped at 31', async () => {
  const packets = [];
  let readCall = 0;
  const deficient = () => {
    const rows = validRows(30);
    rows[0] = { ...rows[0], manualAccounts: 0 };
    return rows;
  };
  const result = await wf.preparePlan(baseDeps({
    onPreparationDiagnostic: s => packets.push(s),
    readMainTable: async () => { readCall++; return readCall === 1 ? deficient() : validRows(30); },
    catalogRemainingIds: [],
  }));
  assert.strictEqual(result.status, 'ready-awaiting-confirmation');
  assert.ok(packets.length >= 2, 'at least initial + one after-rebind');
  assert.strictEqual(packets[0].phase, 'initial');
  assert.strictEqual(packets[0].ready, false);
  assert.strictEqual(packets[0].deficientCount, 1);
  const last = packets[packets.length - 1];
  assert.strictEqual(last.phase, 'after-rebind');
  assert.strictEqual(last.ready, true);
  assert.ok(packets.length <= 31);
});

test('D3 throwing callback causes zero business behavior change', async () => {
  const result = await wf.preparePlan(baseDeps({
    onPreparationDiagnostic: () => { throw new Error('callback-boom'); },
  }));
  assert.strictEqual(result.status, 'ready-awaiting-confirmation');
  assert.ok(result.frozen);
});

// ── runner (synchronous, pure assertions, no I/O) ──────────────────────────
(async () => {
  let failed = 0;
  for (const t of tests) {
    try { await t.fn(); process.stdout.write('ok  ' + t.name + '\n'); }
    catch (error) { failed++; process.stdout.write('FAIL ' + t.name + '\n     ' + (error && error.message) + '\n'); }
  }
  process.stdout.write('\n' + (tests.length - failed) + '/' + tests.length + ' passed\n');
  process.exit(failed ? 1 : 0);
})();
