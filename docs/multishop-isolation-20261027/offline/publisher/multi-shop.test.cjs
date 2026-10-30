'use strict';
// OFFLINE regression for the generic explicit-shop business profile path. No
// network, browser, cookies, real config, LLM or file writes. It exercises the
// REAL exported seams that main()/driver use (never a parallel copy):
//   * shop-profile.cjs pure helpers (validation / selection / isolation / seed),
//   * plan-workflow.cjs profile-aware target + confirmation gates,
//   * direct-draft-controller.cjs publish-authorization account contract,
//   * run-plans.cjs createRealDrivers per-shop target threading.
// Run: node --test multi-shop.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');

const wf = require('./plan-workflow.cjs');
const sp = require('./shop-profile.cjs');
const ctl = require('./direct-draft-controller.cjs');
const rp = require('./run-plans.cjs');
const ui = require('./confirmation-ui.cjs');

const LEGACY = wf.BUSINESS;
const SEED_FILE = path.join(__dirname, 'fixtures', 'published-plan-seed.json');
const LEGACY_PROFILE = sp.profileFromBusiness(LEGACY);
const MINMIN = sp.buildShopProfile({ shop: '敏敏高定私服', accountId: null, boundAccounts: ['9zmao_fushi'] });
const MINMIN_FULL = sp.buildShopProfile({ shop: '敏敏高定私服', accountId: '1696626252631053', boundAccounts: ['9zmao_fushi'] });
const THIRD = sp.buildShopProfile({ shop: '虚构第三店', accountId: '1880000000000001', boundAccounts: ['zhanghao_001'] });

const NOW = Date.now();
const TODAY = wf.shanghaiDate(NOW);
const ids30 = () => Array.from({ length: 30 }, (_, i) => String(770000000000000000n + BigInt(i)));

// ── shop-profile: legacy default compatibility ──────────────────────────────
test('legacy default profile is derived from BUSINESS and keeps its frozen identity', () => {
  assert.equal(LEGACY_PROFILE.shop, LEGACY.shop);
  assert.equal(LEGACY_PROFILE.accountId, LEGACY.accountId);
  assert.deepEqual([...LEGACY_PROFILE.boundAccounts], [...LEGACY.boundAccounts]);
  assert.equal(LEGACY_PROFILE.productsPerPlan, 30);
  assert.equal(LEGACY_PROFILE.roi, 15);
  assert.equal(LEGACY_PROFILE.dailyBudget, 300);
  assert.equal(LEGACY_PROFILE.commissionIncluded, true);
  assert.equal(LEGACY_PROFILE.directPay, false);
  assert.ok(sp.isLegacyDefaultProfile(LEGACY_PROFILE, LEGACY_PROFILE));
  assert.equal(LEGACY_PROFILE.creationUrl, 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi?aavid=1710242295996424');
});

test('buildShopProfile allows a null accountId (敏敏本机) and derives create/manage URLs only once known', () => {
  assert.equal(MINMIN.accountId, null);
  assert.deepEqual([...MINMIN.boundAccounts], ['9zmao_fushi']);
  assert.match(MINMIN.creationUrl, /^https:\/\/qianchuan\.jinritemai\.com\/uni-creation\/overall-product-multi$/);
  assert.ok(sp.isLegacyDefaultProfile(MINMIN, LEGACY_PROFILE) === false);
});

test('buildShopProfile rejects a malformed accountId / empty targets, and never hard-codes the legacy pair', () => {
  assert.throws(() => sp.buildShopProfile({ shop: 'x', accountId: 'abc' }), /account-id-invalid|shop-profile-invalid/);
  assert.throws(() => sp.buildShopProfile({ shop: 'x', boundAccounts: [] }), /bound-accounts-empty|shop-profile-invalid/);
  assert.notDeepEqual([...THIRD.boundAccounts], [...LEGACY.boundAccounts]);
});

// ── selection + identity guards ─────────────────────────────────────────────
test('selectShopConfig selects a uniquely named shop by name alone (enabled is an external monitor flag, not a publish authorization)', () => {
  const config = { shops: [
    { name: '敏敏高定私服', accountId: null, enabled: true },
    { name: '虚构第三店', accountId: '1880000000000001', enabled: true },
    { name: '禁用店', accountId: '1880000000000003', enabled: false },
  ] };
  assert.equal(sp.selectShopConfig(config, '敏敏高定私服').name, '敏敏高定私服');
  // An explicitly named shop carrying enabled:false is STILL selectable: the flag
  // gates external monitoring, not publishing. Selection never enables monitoring,
  // never rewrites the config row, and never bypasses the live Cookie identity check.
  const disabled = sp.selectShopConfig(config, '禁用店');
  assert.equal(disabled.name, '禁用店');
  assert.equal(disabled.enabled, false, 'the row keeps enabled:false — selection does not turn monitoring on');
  assert.equal(config.shops[2].enabled, false, 'the config object is never mutated');
  assert.throws(() => sp.selectShopConfig(config, '不存在的店'), /shop-selection-not-unique:0/);
  const dup = { shops: [ { name: 'x' }, { name: 'x' } ] };
  assert.throws(() => sp.selectShopConfig(dup, 'x'), /shop-selection-not-unique:2/, 'a duplicated name stays refused');
});

// The shared entry selector that BOTH main() (legacy default) and inspectRecoveryOnly
// call. It must ignore the external monitor `enabled` flag on BOTH paths, while still
// refusing duplicates and a KNOWN local account that disagrees with the expected one.
test('selectNamedShopConfig keeps an enabled:false default selectable, allows a null-config generic shop, and refuses duplicates / known-account drift', () => {
  const config = { shops: [
    { name: LEGACY.shop, accountId: LEGACY.accountId, enabled: false },
    { name: '虚构第三店', accountId: '1880000000000001', enabled: true },
    { name: '通用店', accountId: null, enabled: false },
  ] };
  // main() legacy default: enabled:false must NOT exclude the explicitly named shop.
  const legacy = sp.selectNamedShopConfig(config, LEGACY.shop, { accountId: LEGACY.accountId });
  assert.equal(legacy.name, LEGACY.shop);
  assert.equal(legacy.enabled, false, 'the disabled flag is preserved, never flipped');
  assert.equal(config.shops[0].enabled, false, 'selection never rewrites the config row');
  // inspectRecoveryOnly: a generic shop with an UNKNOWN (null) local account is still
  // selectable so its own Cookie can be opened for the live identity proof.
  assert.equal(sp.selectNamedShopConfig(config, '通用店', { accountId: '1696626252631053' }).name, '通用店');
  // A KNOWN local account that differs from the expected live/frozen one is refused.
  assert.throws(() => sp.selectNamedShopConfig(config, '虚构第三店', { accountId: '1696626252631053' }), /shop-config-account-mismatch/);
  // Duplicate / missing names stay refused on the shared entry too.
  assert.throws(() => sp.selectNamedShopConfig({ shops: [ { name: 'x' }, { name: 'x' } ] }, 'x'), /shop-selection-not-unique:2/);
  assert.throws(() => sp.selectNamedShopConfig(config, '不存在的店'), /shop-selection-not-unique:0/);
});

// The recovery entry may SELECT a null-config generic shop, but the live session must
// PROVE the frozen account before any sub-tab click / readback: unknown or wrong live
// identities stay zero-click (the pure verifyLiveIdentity seam stands in for the real
// browser entry — the assertions are the gate, not deleted).
test('recovery gate: a null-config shop is opened, but an unknown/wrong live identity yields zero tab click', () => {
  const config = { shops: [ { name: '敏敏高定私服', accountId: null, enabled: false } ] };
  const business = sp.buildShopProfile({ shop: '敏敏高定私服', accountId: '1696626252631053', boundAccounts: ['9zmao_fushi'] });
  const shopCfg = sp.selectNamedShopConfig(config, business.shop, { accountId: business.accountId });
  assert.ok(shopCfg && shopCfg.accountId == null, 'the null-config row is what gets opened');
  let tabClicks = 0;
  const enterRecovery = (liveAccountId) => {
    const check = sp.verifyLiveIdentity(business, liveAccountId);
    if (!check.ok) return { status: 'refused', reason: check.reason, tabClicks };
    tabClicks++; // reaching here models the single clickChengfangSubTab('商品自选')
    return { status: 'read-only-recovery-observed', accountId: check.accountId, tabClicks };
  };
  assert.equal(enterRecovery('unknown').status, 'refused');
  assert.equal(enterRecovery('1880000000000001').status, 'refused', 'a wrong live account stays refused');
  assert.equal(enterRecovery(null).status, 'refused');
  assert.equal(tabClicks, 0, 'unknown / wrong live identities click no tab and read nothing');
  assert.equal(enterRecovery('1696626252631053').status, 'read-only-recovery-observed');
  assert.equal(tabClicks, 1, 'the tab is only reached after the live identity matches the frozen account');
});

test('verifyLiveIdentity adopts a null-config account, matches a configured one, and refuses unknown', () => {
  assert.deepEqual(sp.verifyLiveIdentity(MINMIN, '1696626252631053'), { ok: true, reason: null, accountId: '1696626252631053' });
  assert.equal(sp.verifyLiveIdentity(MINMIN_FULL, '1696626252631053').ok, true);
  assert.equal(sp.verifyLiveIdentity(MINMIN_FULL, '1880000000000001').ok, false);
  assert.equal(sp.verifyLiveIdentity(MINMIN_FULL, 'unknown').reason, 'live-account-identity-unknown');
  assert.equal(sp.verifyLiveIdentity(MINMIN_FULL, null).ok, false);
});

test('parseShopArg accepts --shop / --account / --targets and rejects an empty shop', () => {
  const a = sp.parseShopArg(['--shop', '敏敏高定私服', '--targets', '9zmao_fushi']);
  assert.equal(a.shop, '敏敏高定私服');
  assert.deepEqual(a.targets, ['9zmao_fushi']);
  assert.equal(sp.parseShopArg(['--shop=']).error, 'shop-arg-empty');
  assert.equal(sp.parseShopArg(['--account=']).error, 'account-arg-empty');
});

// ── per-shop state isolation ────────────────────────────────────────────────
test('shopStatePaths isolates each shop by slug+account; same name / different account never collide', () => {
  const root = path.join(__dirname, 'tmp-shop-state');
  const legacy = sp.shopStatePaths(LEGACY_PROFILE, root, { legacy: true });
  const legacyAsIsolated = sp.shopStatePaths(LEGACY_PROFILE, root, { legacy: false });
  const minminOnly = sp.shopStatePaths(MINMIN, root, { legacy: false });
  assert.equal(legacy.isolated, false);
  assert.equal(legacy.stateFile, path.join(root, 'plan-publisher-state.json'));
  assert.notEqual(legacyAsIsolated.stateFile, legacy.stateFile);
  assert.notEqual(minminOnly.stateFile, legacy.stateFile);
  const minminA = sp.shopStatePaths(sp.buildShopProfile({ shop: '敏敏高定私服', accountId: '1696626252631053', boundAccounts: ['9zmao_fushi'] }), root, {});
  const minminB = sp.shopStatePaths(sp.buildShopProfile({ shop: '敏敏高定私服', accountId: '1770000000000002', boundAccounts: ['other_shop_a'] }), root, {});
  assert.notEqual(minminA.dir, minminB.dir, 'same shop name with a different account must not share state');
  assert.ok(!fs.existsSync(path.join(root, 'shop-state')), 'deriving paths must never create directories');
});

test('assertSameShopIdentity refuses a same-name shop resolved to a different account', () => {
  assert.equal(sp.assertSameShopIdentity(MINMIN_FULL, MINMIN_FULL).ok, true);
  assert.equal(sp.assertSameShopIdentity(MINMIN_FULL, THIRD).ok, false);
  const sameNameA = { shop: '敏敏高定私服', accountId: '1696626252631053' };
  const sameNameB = { shop: '敏敏高定私服', accountId: '1770000000000002' };
  assert.equal(sp.assertSameShopIdentity(sameNameA, sameNameB).reason, 'shop-account-mismatch');
});

// ── cross-shop published-history seed isolation ─────────────────────────────
test('the legacy 120-id seed belongs only to the legacy account and cannot seed a new shop', () => {
  const seed = JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  assert.equal(sp.seedBelongsToProfile(seed, LEGACY_PROFILE), true);
  assert.equal(sp.seedBelongsToProfile(seed, MINMIN_FULL), false, 'another shop must not import the legacy history');
  const missing = path.join(__dirname, 'tmp-missing-published.json');
  assert.ok(!fs.existsSync(missing));
  assert.throws(() => wf.loadPublishedStore(missing, SEED_FILE, MINMIN_FULL.accountId), /published seed account mismatch/);
});

// ── plan-workflow: profile-aware approved targets ───────────────────────────
test('approvedTargets never silently falls back to the legacy pair for a different shop', () => {
  assert.deepEqual(wf.approvedTargets(LEGACY), [...LEGACY.boundAccounts]);
  assert.deepEqual(wf.approvedTargets(LEGACY_PROFILE), [...LEGACY.boundAccounts]);
  assert.deepEqual(wf.approvedTargets(MINMIN), ['9zmao_fushi']);
  assert.deepEqual(wf.approvedTargets(THIRD), ['zhanghao_001']);
  assert.equal(wf.approvedTargets({ shop: '新店', accountId: '1880000000000009', boundAccounts: null }), null);
  assert.equal(wf.isLegacyBusiness(LEGACY), true);
  assert.equal(wf.isLegacyBusiness(MINMIN), false);
});

test('verifyAccountBinding accepts the shop-real target set and rejects foreign rows', () => {
  const drawer = (ids) => ({ rows: ids.map(id => ({ text: 'ID：' + id, checked: true })), text: '当前商品已选：' + ids.length + '/30' });
  assert.equal(wf.verifyAccountBinding(drawer(['9zmao_fushi']), 30, MINMIN).ok, true);
  assert.equal(wf.verifyAccountBinding(drawer(['zhanghao_001']), 30, MINMIN).ok, false, 'a foreign account is not an approved target');
  assert.equal(wf.verifyAccountBinding(drawer(['9zmao_fushi', 'zhanghao_001']), 30, MINMIN).ok, false, 'two accounts when the shop only approved one');
  assert.equal(wf.verifyAccountBinding(drawer(['79863866', '9zmao_fushi']), 30, LEGACY).ok, true, 'legacy default still accepts its frozen two');
});

// ── plan-workflow: confirmation gate is account/profile bound ───────────────
function frozenFor(profile, planName) {
  return wf.freezePlan({
    planNumber: 1, runId: 'run-' + profile.shop, businessDate: TODAY,
    accountId: profile.accountId, planName,
    productIds: ids30(), boundAccounts: [...profile.boundAccounts],
  }, { business: profile, nowMs: NOW });
}
function requestFor(frozen) {
  return { method: 'POST', action: '确认发布本计划', nonce: frozen.nonce, planNumber: frozen.planNumber,
    manifestHash: frozen.manifestHash, businessDate: frozen.businessDate, acceptedDisclosures: true };
}

test('validateConfirmation authorizes each shop against its OWN profile (single-account generic path)', () => {
  for (const profile of [LEGACY_PROFILE, MINMIN_FULL, THIRD]) {
    const frozen = frozenFor(profile, 'plan-' + profile.shop);
    const verdict = wf.validateConfirmation(frozen, requestFor(frozen), { business: profile, nowMs: NOW, consumed: new Set() });
    assert.equal(verdict.authorized, true, profile.shop + ' must authorize its own frozen plan: ' + (verdict.reason || ''));
    assert.deepEqual(verdict.authorization.boundAccounts, [...profile.boundAccounts]);
  }
});

test('validateConfirmation refuses cross-shop identity, target drift, manifest drift and replay with zero click', () => {
  const frozen = frozenFor(MINMIN_FULL, 'plan-minmin');
  assert.equal(wf.validateConfirmation(frozen, requestFor(frozen), { business: THIRD, nowMs: NOW }).authorized, false, 'another shop must not authorize this plan');
  const drifted = { ...frozen, planName: 'tampered-plan-name' };
  assert.equal(wf.validateConfirmation(drifted, requestFor(frozen), { business: MINMIN_FULL, nowMs: NOW }).reason, 'manifest-drift');
  const targetDrift = { ...frozen, boundAccounts: ['zhanghao_001'] };
  assert.equal(wf.validateConfirmation(targetDrift, requestFor(frozen), { business: MINMIN_FULL, nowMs: NOW }).reason, 'frozen-manifest-invalid');
  assert.equal(wf.validateConfirmation(frozen, requestFor(frozen), { business: MINMIN_FULL, nowMs: NOW, consumed: new Set([frozen.confirmationId]) }).reason, 'confirmation-already-consumed');
  const stale = { ...requestFor(frozen), businessDate: wf.shanghaiDate(NOW - 2 * 24 * 3600 * 1000) };
  assert.equal(wf.validateConfirmation(frozen, stale, { business: MINMIN_FULL, nowMs: NOW }).authorized, false);
  const badNonce = { ...requestFor(frozen), nonce: 'deadbeef' };
  assert.equal(wf.validateConfirmation(frozen, badNonce, { business: MINMIN_FULL, nowMs: NOW }).reason, 'nonce-mismatch');
});

// ── run-plans driver: per-shop target threading + preparation-time discovery ──
test('createRealDrivers allows preparation-time target discovery for a generic shop but never inherits the legacy pair', () => {
  // Preparation may begin with NO configured targets (e.g. `--shop NAME` alone): the
  // driver must be CONSTRUCTIBLE so bindAccountsToAll can discover the shop's real
  // bindable accounts from the live drawer. The old "throw when targets missing"
  // behaviour is replaced by "discoverable at preparation, fail-closed at publish".
  const discovery = rp.createRealDrivers({ legacyBusiness: false, accountId: '1696626252631053' });
  assert.equal(discovery.resolvedBoundAccounts, null, 'an unresolved generic shop starts with NO targets, never the legacy pair');
  const configured = rp.createRealDrivers({ legacyBusiness: false, boundAccounts: ['9zmao_fushi'], accountId: '1696626252631053' });
  assert.deepEqual(configured.resolvedBoundAccounts, ['9zmao_fushi'], 'a configured generic shop proves its OWN single account and never falls back to 79863866');
  const legacy = rp.createRealDrivers({ accountId: '1710242295996424' });
  assert.deepEqual(legacy.resolvedBoundAccounts, ['79863866', '9zmao_fushi'], 'legacy callers keep the frozen default pair');
  // Publication stays fail-closed: the R9 guard refuses a non-legacy contract that
  // carries no independently configured bound accounts (zero click).
  const prods = ids30();
  const acc = '1696626252631053';
  const obs = makeObs(acc, prods, 'p');
  assert.throws(() => ctl.validatePublishAuthorization(makeAuth(obs, acc, prods, 'p', ['9zmao_fushi']), obs, acc, 'run-x', { account_id: acc, product_ids: prods }, { productsPerPlan: 30, isLegacy: false }), /non-legacy shop/);
});

// ── direct-draft-controller: publish authorization account contract ─────────
function makeObs(accountId, productIds, planName) {
  return { observation: 'obs-' + accountId, creation: {
    originOk: true, pathOk: true, mainTableUnique: true, accountId,
    productRowCount: productIds.length, uniqueProductCount: productIds.length, eachRowHasManualAccount: true,
    productIds, roi: 15, budget: 300, commissionChecked: true, planName,
    publishButtonCount: 1, publishEnabledUnique: true, optionalDirectPayChecked: false, visibleDialogCount: 0,
  } };
}
function makeAuth(obs, accountId, productIds, planName, boundAccounts) {
  return { op: 'publish-plan', planNumber: 1, authorization: {
    runId: 'run-x', observation: obs.observation, accountId, planName, confirmationId: 'conf-1',
    roi: 15, dailyBudget: 300, commissionIncluded: true, boundAccounts,
    businessDate: '2026-10-11', manifestHash: 'a'.repeat(64), productIds,
  } };
}

test('validatePublishAuthorization keeps the legacy no-contract default but fails closed for a non-legacy shop', () => {
  const acc = LEGACY.accountId;
  const prods = ids30();
  const obs = makeObs(acc, prods, 'p');
  const approved = { account_id: acc, product_ids: prods };
  const legacy = ctl.validatePublishAuthorization(makeAuth(obs, acc, prods, 'p', ['79863866', '9zmao_fushi']), obs, acc, 'run-x', approved);
  assert.equal(legacy.planNumber, 1);
  assert.deepEqual(legacy.boundAccounts, ['79863866', '9zmao_fushi']);

  const genericAcc = '1696626252631053';
  const gObs = makeObs(genericAcc, prods, 'p');
  const gApproved = { account_id: genericAcc, product_ids: prods };
  const ok = ctl.validatePublishAuthorization(makeAuth(gObs, genericAcc, prods, 'p', ['9zmao_fushi']), gObs, genericAcc, 'run-x', gApproved, { boundAccounts: ['9zmao_fushi'], productsPerPlan: 30, roi: 15, dailyBudget: 300, isLegacy: false });
  assert.deepEqual(ok.boundAccounts, ['9zmao_fushi']);

  assert.throws(() => ctl.validatePublishAuthorization(makeAuth(gObs, genericAcc, prods, 'p', ['9zmao_fushi']), gObs, genericAcc, 'run-x', gApproved, { productsPerPlan: 30, isLegacy: false }), /non-legacy shop/);
  assert.throws(() => ctl.validatePublishAuthorization(makeAuth(gObs, genericAcc, prods, 'p', ['79863866', '9zmao_fushi']), gObs, genericAcc, 'run-x', gApproved, { boundAccounts: ['9zmao_fushi'], isLegacy: false }), /exact configured approved accounts/);
  assert.throws(() => ctl.validatePublishAuthorization(makeAuth(gObs, genericAcc, prods, 'p', ['9zmao_fushi']), gObs, '1880000000000001', 'run-x', gApproved, { boundAccounts: ['9zmao_fushi'], isLegacy: false }), /identity/);
});

// ── preparePlan: REAL auto-discovery from a generic shop's binding drawer ────
// A generic shop starts from ONLY its shop name + a verified live account: its
// boundAccounts are null and must be DISCOVERED (never a fixed 敏敏 array, never the
// legacy pair) from the native drawer during preparation.
const MINMIN_DISCOVERY = sp.buildShopProfile({ shop: '敏敏高定私服', accountId: '1696626252631053', boundAccounts: null });
const THIRD_DISCOVERY = sp.buildShopProfile({ shop: '虚构第三店', accountId: '1880000000000001', boundAccounts: null });

function mainRowsFor(ids) {
  return ids.map(pid => ({ productId: pid, manualAccounts: 1, manualEvidence: true, manualCountKnown: true, autoPullOnly: false, reviewFailed: false, text: 'row ' + pid }));
}
async function prepareWithDiscovery(profile, discovered, planName) {
  const ids = ids30();
  return wf.preparePlan({
    planNumber: 1, runId: 'run-' + profile.shop, businessDate: TODAY, dayState: wf.newDayState(TODAY), business: profile,
    openCreationPage: async () => ({ header: { originOk: true, accountId: profile.accountId, commissionOptionPresent: true } }),
    browseProducts: async () => ({ ok: true, selectedIds: ids, hints: {}, attempted: [], cursor: { category: '全部', page: 1 } }),
    // The REAL bindAccountsToAll returns the accounts it bound; here a fake stands in for
    // the native drawer readback so the prepare→freeze→confirm seam is exercised.
    bindAccountsToAll: async () => ({ ok: true, accountIds: discovered }),
    readMainTable: async () => mainRowsFor(ids),
    repairDraft: async () => { throw new Error('ready rows must not need repair'); },
    configurePlan: async () => ({ ok: true, planName }),
    persistState: async () => {},
  });
}

test('preparePlan AUTO-DISCOVERS a generic shop single account, freezes it, and authorizes against the RESOLVED profile', async () => {
  const prep = await prepareWithDiscovery(MINMIN_DISCOVERY, ['9zmao_fushi'], 'minmin-discovery');
  assert.equal(prep.status, 'ready-awaiting-confirmation', prep.reason || '');
  assert.deepEqual([...prep.frozen.boundAccounts], ['9zmao_fushi'], 'the frozen plan carries the shop-discovered account, never a fixed array');
  assert.equal(prep.frozen.accountId, '1696626252631053');
  // main adopts the RESOLVED profile (never the initial null-target one) for the gate.
  const resolved = sp.buildShopProfile({ ...MINMIN_DISCOVERY, boundAccounts: prep.frozen.boundAccounts });
  const verdict = wf.validateConfirmation(prep.frozen, requestFor(prep.frozen), { business: resolved, nowMs: NOW, consumed: new Set() });
  assert.equal(verdict.authorized, true, verdict.reason || '');
  assert.deepEqual(verdict.authorization.boundAccounts, ['9zmao_fushi']);
  // A resolved profile that drifted to a DIFFERENT target set must refuse (zero click).
  const drifted = sp.buildShopProfile({ ...MINMIN_DISCOVERY, boundAccounts: ['zhanghao_001'] });
  assert.equal(wf.validateConfirmation(prep.frozen, requestFor(prep.frozen), { business: drifted, nowMs: NOW }).authorized, false);
});

test('a different random shop auto-discovers its OWN single account through the same flow without cross-contamination', async () => {
  const prep = await prepareWithDiscovery(THIRD_DISCOVERY, ['zhanghao_001'], 'third-discovery');
  assert.equal(prep.status, 'ready-awaiting-confirmation', prep.reason || '');
  assert.deepEqual([...prep.frozen.boundAccounts], ['zhanghao_001']);
  assert.ok(!prep.frozen.boundAccounts.includes('9zmao_fushi') && !prep.frozen.boundAccounts.includes('79863866'), 'no legacy/other-shop account may leak in');
  const resolved = sp.buildShopProfile({ ...THIRD_DISCOVERY, boundAccounts: prep.frozen.boundAccounts });
  assert.equal(wf.validateConfirmation(prep.frozen, requestFor(prep.frozen), { business: resolved, nowMs: NOW }).authorized, true);
});

// The REAL serialized binding pipeline (createRealDrivers.bindAccountsToAll) must
// DISCOVER the single native-drawer row and thread it into every later helper — not
// merely a pure helper. Each instance keeps its OWN mutable resolved set.
async function runDiscoveryBinding({ accountId, accountRow }) {
  const ids = ids30();
  const rows = mainRowsFor(ids);
  let confirmed = 0;
  const snap = { ok: true, rows: [{ ids: [accountRow], checked: false, labelDisabled: false }], headerSelectAllCount: 1, headerLabelDisabled: false, selectedCount: 0, totalCount: 30, batchButtonCount: 1, batchEnabled: true, panelProductIds: ids, activeProductIds: [ids[0]] };
  const page = { evaluate: async (fn, arg) => {
    if (fn === rp.readMainTableInPage) return { ok: true, rows };
    if (fn === rp.bindingDrawerSnapshotInPage) return { ...snap, rows: snap.rows.map(r => ({ ...r })) };
    // R134 discovery freeze: the whole-batch union scan navigates the real 30 panels read-only
    // and then restores the original active panel before any header/batch action. The fixture
    // therefore has to expose the real panel-navigation + overlay probes, and its drawer
    // snapshot must report the CURRENT active panel (provePanelSet requires it).
    if (fn === rp.selectBindingDrawerPanelInPage) { snap.activeProductIds = [String(arg)]; return { clicked: true, id: String(arg) }; }
    if (fn === rp.bindingOverlaySnapshotInPage) return { accountDrawerCount: 1, blockingOverlayPresent: false };
    // R134 freezes this shop's union from the COMPLETED whole-batch scan before any header
    // action, so the header select-all now carries the FROZEN target set (the strictest form,
    // and still never the legacy pair) instead of the earlier null+discovery payload.
    if (fn === rp.selectAllAccountsInPage) { assert.deepEqual(arg && arg.targets, [accountRow], 'select-all must carry the frozen discovered account, never the legacy pair'); snap.rows.forEach(r => { r.checked = true; }); snap.selectedCount = 1; return { clicked: true }; }
    if (fn === rp.applyBatchAccountsInPage) { assert.deepEqual(arg.targets, [accountRow], 'batch apply must carry the discovered account'); return { clicked: true }; }
    if (fn === rp.batchAddAllModalSnapshotInPage) { assert.deepEqual(arg.targets, [accountRow]); return { ok: true, modalCount: 1, productCount: 29, accountCount: 1, drawerSettled: true }; }
    if (fn === rp.confirmBatchAddAllModalInPage) { assert.deepEqual(arg.targets, [accountRow]); return { clicked: true, productCount: 29 }; }
    if (fn === rp.batchResultSnapshotInPage) { assert.deepEqual(arg.targets, [accountRow]); return { present: true, known: true, settled: true, uniqueCount: 29, outside: 0, duplicate: false, ambiguous: 0, failedIds: [], successCount: 29 }; }
    if (fn === rp.acknowledgeBatchResultInPage) return { present: true, acked: true, failedIds: [], successCount: 29 };
    if (fn === rp.confirmBatchAccountsApplyInPage) { confirmed++; return { clicked: true }; }
    if (fn === rp.acceptPartialDraftWarningInPage) return { present: false };
    if (fn === rp.guidanceActionInPage) return { present: false, unknown: false, roots: [] };
    if (!fn.name) return { ok: true };
    throw new Error('unexpected fake page function ' + fn.name);
  } };
  const driver = rp.createRealDrivers({ page, managerPage: {}, context: {}, dayState: { lastSelected: [], cursor: {} }, persist: async () => {}, publishedIds: new Set(), attemptedSet: new Set(), hints: {}, accountId, opened: {}, projectRoot: __dirname, planNumber: 1, runId: 'offline', legacyBusiness: false });
  const before = driver.resolvedBoundAccounts;
  const result = await driver.bindAccountsToAll({ productIds: ids });
  return { driver, before, result, confirmed: () => confirmed };
}

test('the REAL bindAccountsToAll auto-discovers a single native drawer account and threads it into every helper', async () => {
  const run = await runDiscoveryBinding({ accountId: '1696626252631053', accountRow: '9zmao_fushi' });
  assert.equal(run.before, null, 'starts unresolved');
  assert.equal(run.result.ok, true, run.result.reason || '');
  assert.deepEqual(run.result.accountIds, ['9zmao_fushi'], 'the discovered single account is returned, never the legacy pair');
  assert.equal(run.confirmed(), 1, 'drawer draft committed exactly once');
  assert.deepEqual(run.driver.resolvedBoundAccounts, ['9zmao_fushi'], 'the instance resolved to its OWN discovered set');
});

test('two discovery driver instances never share a mutable target profile', async () => {
  const a = await runDiscoveryBinding({ accountId: '1696626252631053', accountRow: '9zmao_fushi' });
  const b = await runDiscoveryBinding({ accountId: '1880000000000001', accountRow: 'zhanghao_001' });
  assert.deepEqual(a.driver.resolvedBoundAccounts, ['9zmao_fushi']);
  assert.deepEqual(b.driver.resolvedBoundAccounts, ['zhanghao_001']);
  assert.notDeepEqual(a.driver.resolvedBoundAccounts, b.driver.resolvedBoundAccounts);
});

// ── discovery gate: disabled / unknown / drift stop with zero click ──────────
test('bindingAccountsSnapshotSettled fails closed on an unknown drawer, a disabled-only drawer and target drift', () => {
  const checked = (id) => ({ ok: true, rows: [{ ids: [id], checked: true, labelDisabled: false }], selectedCount: 1, totalCount: 30 });
  assert.equal(rp.bindingAccountsSnapshotSettled({ ok: false, reason: 'account-drawer-not-unique', count: 0 }, null, 30), false, 'unknown drawer never settles');
  assert.equal(rp.bindingAccountsSnapshotSettled(null, null, 30), false);
  const disabledOnly = { ok: true, rows: [{ ids: ['9zmao_fushi'], checked: false, labelDisabled: true }], selectedCount: 0, totalCount: 30 };
  assert.equal(rp.bindingAccountsSnapshotSettled(disabledOnly, null, 30), false, 'an all-disabled drawer has no bindable account and must not settle');
  assert.equal(rp.bindingAccountsSnapshotSettled(checked('zhanghao_001'), ['9zmao_fushi'], 30), false, 'a foreign row is target drift');
  assert.equal(rp.bindingAccountsSnapshotSettled(checked('9zmao_fushi'), null, 30), true, 'discovery accepts the drawer own single checked row');
  assert.equal(rp.bindingAccountsSnapshotSettled(checked('9zmao_fushi'), ['9zmao_fushi'], 30), true);
});

// ── publisher ROOT is the ONLY storage authority ─────────────────────────────
// The external adapter project root exists only to read config/cookie and require
// the reader; it must NEVER become a write authority for publisher state. This
// exercises the REAL seam WITHOUT a browser / main(): it copies the publisher
// module into a THROWAWAY module dir (so its own __dirname IS the publisher root)
// and a separate throwaway adapter dir, then reads/writes through the real
// publisherStatePaths + plan-workflow.cjs loaders.
test('publisherStatePaths pins every state path to the publisher module root and never touches an adapter root', () => {
  const publisherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'publisher-mod-'));
  const adapterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adapter-proj-'));
  try {
    for (const f of ['run-plans.cjs', 'plan-workflow.cjs', 'direct-draft-controller.cjs', 'confirmation-ui.cjs', 'shop-profile.cjs']) {
      fs.copyFileSync(path.join(__dirname, f), path.join(publisherDir, f));
    }
    fs.mkdirSync(path.join(publisherDir, 'fixtures'), { recursive: true });
    fs.copyFileSync(SEED_FILE, path.join(publisherDir, 'fixtures', 'published-plan-seed.json'));
    const temp = require(path.join(publisherDir, 'run-plans.cjs'));
    const twf = require(path.join(publisherDir, 'plan-workflow.cjs'));
    const tsp = require(path.join(publisherDir, 'shop-profile.cjs'));
    assert.equal(temp.publisherStatePaths.length, 2, 'publisherStatePaths takes only (profile, legacyDefault) — an adapter root is not a parameter');

    // The legacy default keeps TODAY'S flat files in place, but in the PUBLISHER dir.
    const legacyProfile = tsp.profileFromBusiness(twf.BUSINESS);
    const legacy = temp.publisherStatePaths(legacyProfile, true);
    assert.equal(legacy.isolated, false);
    assert.equal(legacy.dir, publisherDir);
    assert.equal(legacy.stateFile, path.join(publisherDir, 'plan-publisher-state.json'));
    assert.equal(legacy.publishedFile, path.join(publisherDir, 'published-products.json'));
    assert.ok(legacy.lockFile.startsWith(publisherDir) && !legacy.lockFile.startsWith(adapterDir));

    // Pre-existing production-shaped legacy state: 3 same-day plan entries + a
    // 210-product published history.
    const date = twf.shanghaiDate(Date.now());
    twf.persistDayState(legacy.stateFile, { ...twf.newDayState(date), plans: [{ planId: 'p1' }, { planId: 'p2' }, { planId: 'p3' }] });
    const ids210 = Array.from({ length: 210 }, (_, i) => String(880000000000000000n + BigInt(i)));
    twf.persistPublished(legacy.publishedFile, { seeded: false, seededFrom: null, publishedIds: ids210, plans: [] });

    // The default selection reads back the SAME in-place state via the real loaders.
    assert.equal(twf.loadDayState(legacy.stateFile, date).plans.length, 3, 'legacy default reads its existing 3-plan day state');
    const hist = twf.loadPublishedStore(legacy.publishedFile, legacy.seedFile, twf.BUSINESS.accountId);
    assert.equal(hist.publishedIds.length, 210, 'legacy default reads its existing 210-product history');
    assert.equal(hist.seeded, false);

    // A generic shop is isolated UNDER the publisher root, scoped by its REAL
    // account and never a `__pending` directory.
    const minmin = tsp.buildShopProfile({ shop: '敏敏高定私服', accountId: '1696626252631053', boundAccounts: ['9zmao_fushi'] });
    const shop = temp.publisherStatePaths(minmin, false);
    assert.equal(shop.isolated, true);
    assert.ok(shop.dir.startsWith(path.join(publisherDir, 'shop-state')), 'generic state lives under the PUBLISHER root');
    assert.ok(shop.dir.includes('1696626252631053'));
    assert.ok(!shop.dir.includes('__pending'), 'a verified account never derives a __pending scope');
    // An adapter project root passed as a third argument is NOT accepted as authority.
    const forced = temp.publisherStatePaths(minmin, false, adapterDir);
    assert.equal(forced.dir, shop.dir, 'the adapter root is never a write authority');
    assert.ok(!fs.existsSync(path.join(publisherDir, 'shop-state')), 'deriving paths writes nothing');
    assert.deepEqual(fs.readdirSync(adapterDir), [], 'the adapter project dir must never receive publisher state');

    // Legacy and 敏敏 keep separate day-state + history files; writing one never
    // touches the other (no mixing).
    assert.notEqual(shop.stateFile, legacy.stateFile);
    assert.notEqual(shop.publishedFile, legacy.publishedFile);
    fs.mkdirSync(path.dirname(shop.stateFile), { recursive: true });
    twf.persistDayState(shop.stateFile, { ...twf.newDayState(date), plans: [{ planId: 'm1' }] });
    assert.equal(twf.loadDayState(shop.stateFile, date).plans.length, 1);
    assert.equal(twf.loadDayState(legacy.stateFile, date).plans.length, 3, 'writing the generic shop never touches legacy state');
    assert.equal(twf.loadPublishedStore(legacy.publishedFile, legacy.seedFile, twf.BUSINESS.accountId).publishedIds.length, 210);

    // Same shop name resolved to a DIFFERENT account stays an independent scope.
    const other = tsp.buildShopProfile({ shop: '敏敏高定私服', accountId: '1770000000000002', boundAccounts: ['other_shop_a'] });
    const otherPaths = temp.publisherStatePaths(other, false);
    assert.notEqual(otherPaths.dir, shop.dir);
    assert.notEqual(otherPaths.stateFile, shop.stateFile);
  } finally {
    fs.rmSync(publisherDir, { recursive: true, force: true });
    fs.rmSync(adapterDir, { recursive: true, force: true });
  }
});

// ── guidance scope: generic save file == restore file, legacy default, isolation ─
test('guidanceScopeFor makes a generic shop SAVE and RESTORE the same account-scoped file, keeps the legacy default, and isolates shops', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guidance-scope-'));
  try {
    const acc = '1696626252631053';
    const generic = sp.buildShopProfile({ shop: '敏敏高定私服', accountId: acc, boundAccounts: ['9zmao_fushi'] });
    const other = sp.buildShopProfile({ shop: '敏敏高定私服', accountId: '1770000000000002', boundAccounts: ['other_shop_a'] });

    // A generic shop uses ONE account-scoped dir for BOTH the save and the restore.
    const gPaths = rp.publisherStatePaths(generic, false);
    const gScope = rp.guidanceScopeFor(gPaths);
    assert.equal(gScope.privateDir, gPaths.guidanceDir);
    assert.equal(gScope.restoreOptions.baseDir, gPaths.guidanceDir);
    assert.equal(rp.guidanceFilePath(acc, gScope.privateDir), rp.guidanceFilePath(acc, gScope.restoreOptions.baseDir), 'save file must equal restore file');

    // The legacy default keeps its historical LOCALAPPDATA location on BOTH ends.
    const lScope = rp.guidanceScopeFor(rp.publisherStatePaths(LEGACY_PROFILE, true));
    assert.equal(lScope.privateDir, undefined);
    assert.deepEqual(lScope.restoreOptions, {});
    const defaultFile = rp.guidanceFilePath(LEGACY.accountId, lScope.privateDir);
    assert.equal(defaultFile, rp.guidanceFilePath(LEGACY.accountId, lScope.restoreOptions.baseDir));
    assert.equal(path.dirname(defaultFile), path.join(process.env.LOCALAPPDATA || '', 'PlanPublisher', 'guidance'));
    assert.notEqual(defaultFile, rp.guidanceFilePath(acc, gScope.privateDir), 'a generic shop never shares the legacy default file');

    // Same name / different account stays an independent guidance file.
    const oScope = rp.guidanceScopeFor(rp.publisherStatePaths(other, false));
    assert.notEqual(rp.guidanceFilePath(acc, gScope.privateDir), rp.guidanceFilePath('1770000000000002', oScope.privateDir));

    // REAL round-trip on THROWAWAY paths: the file the driver would SAVE is read back
    // by the REAL restorer, injecting exactly the saved entries (no browser, no real file).
    const tmpScope = rp.guidanceScopeFor(sp.shopStatePaths(generic, tmpRoot, {}));
    const saveFile = rp.guidanceFilePath(acc, tmpScope.privateDir);
    const key = 'qc_lite_c_guide_unit_probe';
    assert.equal(rp.persistPrivateGuidanceState(saveFile, acc, [{ key, value: 'probe' }]).saved, true);
    let injected = null;
    const restore = await rp.installGuidanceRestore({ addInitScript: async (fn, arg) => { injected = { fn, arg }; } }, acc, tmpScope.restoreOptions);
    assert.equal(restore.registered, true, restore.reason || '');
    assert.equal(restore.count, 1);
    assert.equal(injected.arg.accountId, acc);
    assert.deepEqual(injected.arg.entries, [{ key, value: 'probe' }]);

    // The DRIVER carries the scope main threads in (the ctx field whose absence was
    // the bug): with the generic scope it exposes that dir; without any scope it
    // keeps the legacy default (null → LOCALAPPDATA).
    const mk = (extra) => rp.createRealDrivers({ page: null, managerPage: {}, context: {}, dayState: {}, persist: async () => {}, publishedIds: new Set(), attemptedSet: new Set(), hints: {}, accountId: acc, legacyBusiness: false, planNumber: 1, runId: 'offline', ...extra });
    assert.equal(mk({ guidancePrivateDir: gScope.privateDir }).guidancePrivateDir, gPaths.guidanceDir);
    assert.equal(mk({}).guidancePrivateDir, null, 'a driver with no scope keeps the legacy default save target');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ── confirmation server: host-trusted business identity is the ONLY authority ─
// The real DI handler (GET + POST) is driven with fake req/res — no browser, no
// network. The confirmation page/decision must use the TRUSTED profile the host
// hands in (constructor / setPlan), never the frozen artifact or the HTTP form,
// so a generic shop cannot self-authorize and the legacy entry stays compatible.
function fakeRes() {
  let resolve;
  const done = new Promise(r => { resolve = r; });
  const res = {
    statusCode: null, headers: null, body: null,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers || null; return this; },
    end(b) { this.body = b; resolve(this); },
  };
  res.done = done;
  return res;
}
function driveGet(handler, url) {
  const res = fakeRes();
  handler({ method: 'GET', url: url || '/', on() {} }, res);
  return res.done;
}
function drivePost(handler, bodyStr) {
  const res = fakeRes();
  const handlers = {};
  const req = { method: 'POST', url: '/confirm', on(ev, cb) { handlers[ev] = cb; }, destroy() {} };
  handler(req, res);
  process.nextTick(() => { if (handlers.data) handlers.data(bodyStr); if (handlers.end) handlers.end(); });
  return res.done;
}
function formFor(frozen, extra) {
  const r = requestFor(frozen);
  const fields = {
    action: r.action, nonce: r.nonce, planNumber: r.planNumber, businessDate: r.businessDate,
    manifestHash: r.manifestHash, acceptedDisclosures: 'true', ...(extra || {}),
  };
  return Object.entries(fields).filter(([, v]) => v != null)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&');
}

test('confirmation server renders the host-trusted shop and authorizes its correct POST once, after reserve', async () => {
  const frozen = frozenFor(MINMIN_FULL, 'plan-minmin-ui');
  const order = [];
  const auths = [];
  const server = ui.createConfirmationServer({
    consumed: new Set(),
    reserveConfirmation: async () => { order.push('reserve'); },
  });
  server.setPlan(frozen, (auth, plan) => { order.push('confirm:' + plan.planNumber); auths.push(auth.boundAccounts); },
    { business: MINMIN_FULL });

  const page = await driveGet(server.handler);
  assert.equal(page.statusCode, 200);
  // Exact position: the shop paragraph shows the TRUSTED profile, not the legacy default.
  assert.ok(page.body.includes('<p>店铺：<strong>敏敏高定私服</strong>'), '正文准确位置显示当前可信店铺');
  assert.ok(!page.body.includes(LEGACY.shop), '旧默认店名“瑾漂亮潮流服饰”绝不出现');

  const post = await drivePost(server.handler, formFor(frozen));
  assert.equal(post.statusCode, 200, '正确 POST 被授权');
  assert.deepEqual(order, ['reserve', 'confirm:1'], 'reserve 先于恰好一次 callback');
  assert.deepEqual(auths, [['9zmao_fushi']], '授权使用敏敏自己的冻结目标账号');
});

test('confirmation server refuses cross-shop profile / target drift / repeat POST with zero callback', async () => {
  const frozen = frozenFor(MINMIN_FULL, 'plan-minmin-refuse');
  let calls = 0;
  const server = ui.createConfirmationServer({ consumed: new Set() });
  // (a) another shop's trusted profile must never authorize this frozen plan
  server.setPlan(frozen, () => { calls++; }, { business: THIRD });
  assert.equal((await drivePost(server.handler, formFor(frozen))).statusCode, 409);
  // (b) target drift: the frozen plan's accounts disagree with the trusted profile
  const drifted = { ...frozen, boundAccounts: ['zhanghao_001'] };
  server.setPlan(drifted, () => { calls++; }, { business: MINMIN_FULL });
  assert.equal((await drivePost(server.handler, formFor(drifted))).statusCode, 409);
  // (c) a repeated POST after one valid consume is refused
  server.setPlan(frozen, () => { calls++; }, { business: MINMIN_FULL });
  assert.equal((await drivePost(server.handler, formFor(frozen))).statusCode, 200);
  assert.equal((await drivePost(server.handler, formFor(frozen))).statusCode, 409, '同一份重复 POST 被拒');
  assert.equal(calls, 1, '仅唯一一次有效 POST 触发回调');
  assert.equal(server.consumed.has(frozen.confirmationId), true);
});

test('setPlan rebinds the trusted profile so the next shop authorizes under the next identity', async () => {
  const minminFrozen = frozenFor(MINMIN_FULL, 'plan-minmin-next');
  const thirdFrozen = frozenFor(THIRD, 'plan-third-next');
  const auths = [];
  const server = ui.createConfirmationServer({ consumed: new Set() });
  server.setPlan(minminFrozen, (a) => { auths.push(a.boundAccounts); }, { business: MINMIN_FULL });
  assert.equal((await drivePost(server.handler, formFor(minminFrozen))).statusCode, 200);
  server.setPlan(thirdFrozen, (a) => { auths.push(a.boundAccounts); }, { business: THIRD });
  assert.equal((await drivePost(server.handler, formFor(thirdFrozen))).statusCode, 200);
  // the previous shop's still-pending POST must not ride on the new profile
  assert.equal((await drivePost(server.handler, formFor(minminFrozen))).statusCode, 409);
  assert.deepEqual(auths, [['9zmao_fushi'], ['zhanghao_001']], '第二份使用第二家可信 profile，绝不复用第一家');
});

test('legacy setPlan stays compatible, while a generic plan with no trusted profile can never self-authorize', async () => {
  // Legacy API: no business anywhere -> the frozen default plan authorizes as before.
  const legFrozen = frozenFor(LEGACY_PROFILE, 'plan-legacy-compat');
  let legacyCalls = 0;
  const legacyServer = ui.createConfirmationServer({ consumed: new Set() });
  legacyServer.setPlan(legFrozen, () => { legacyCalls++; });
  const legPage = await driveGet(legacyServer.handler);
  assert.ok(legPage.body.includes(LEGACY.shop), '旧签名渲染仍是默认店铺');
  assert.equal((await drivePost(legacyServer.handler, formFor(legFrozen))).statusCode, 200);
  assert.equal(legacyCalls, 1, '旧签名旧店 API 原样授权');

  // Generic plan WITHOUT a trusted profile: display falls back to default and the
  // POST is refused (approval is never reconstructed from the frozen artifact).
  const minFrozen = frozenFor(MINMIN_FULL, 'plan-generic-self');
  let genericCalls = 0;
  const genericServer = ui.createConfirmationServer({ consumed: new Set() });
  genericServer.setPlan(minFrozen, () => { genericCalls++; });
  const gPage = await driveGet(genericServer.handler);
  assert.ok(gPage.body.includes(LEGACY.shop) && !gPage.body.includes(MINMIN_FULL.shop), '无可信 profile 时展示回落默认，不显示敏敏');
  assert.equal((await drivePost(genericServer.handler, formFor(minFrozen))).statusCode, 409, '通用计划无可信 profile 不能自授权');
  // An HTTP form cannot inject a business override either.
  const injected = formFor(minFrozen, { business: MINMIN_FULL.shop, shop: MINMIN_FULL.shop, accountId: MINMIN_FULL.accountId });
  assert.equal((await drivePost(genericServer.handler, injected)).statusCode, 409, 'HTTP 表单不能自构造可信 profile');
  assert.equal(genericCalls, 0);
});

// ── navigation-only account hint (open target, never identity) ──────────────
// A shop's local config row may be account-less (敏敏本机: accountId null) while the
// host has ALREADY verified the real 千川 account (frozen profile, or the CLI
// --account read off the live header). navigationShopCfg copies that row for the
// EXISTING 抖店→千川 home fallback so the reader targets the right account instead of
// the auto school.jinritemai.com page — a HINT only. The live session is still
// re-proven afterwards and the CLI/live gate is untouched.
test('navigationShopCfg hands the known account to a null-config shop without mutating it or touching any Cookie', () => {
  const configRow = Object.freeze({ name: MINMIN_FULL.shop, accountId: null, boundAccounts: ['9zmao_fushi'], enabled: true, creationPath: '/uni-creation/overall-product-multi' });
  const nav = rp.navigationShopCfg(configRow, MINMIN_FULL.accountId);
  assert.equal(nav.accountId, MINMIN_FULL.accountId, 'the host-verified account reaches the existing home fallback');
  assert.equal(configRow.accountId, null, 'the source config row is never mutated');
  assert.equal(nav.name, configRow.name);
  assert.deepEqual(nav.boundAccounts, ['9zmao_fushi'], 'every other field is preserved');
  assert.equal(nav.enabled, true);
  assert.equal(nav.creationPath, configRow.creationPath);
  assert.notEqual(nav, configRow, 'a copy is returned, never the frozen source object');
  // The hint is NOT a Cookie / config write: the copy carries no cookie material and
  // the pure helper performs no fs / browser / network access.
  assert.equal('cookies' in nav, false);
});

test('navigationShopCfg: known matching passes through, a known mismatch is refused, two unknowns never guess an account', () => {
  const matching = { name: 'x', accountId: MINMIN_FULL.accountId };
  assert.equal(rp.navigationShopCfg(matching, MINMIN_FULL.accountId).accountId, MINMIN_FULL.accountId, 'a matching known account is kept as-is');
  assert.equal(rp.navigationShopCfg(matching, null).accountId, MINMIN_FULL.accountId, 'a known config account survives an absent hint');
  assert.throws(() => rp.navigationShopCfg({ name: 'x', accountId: THIRD.accountId }, MINMIN_FULL.accountId), /nav-account-hint-conflicts-with-configured/, 'a known local account that contradicts the hint is refused');
  assert.equal(rp.navigationShopCfg({ name: 'x', accountId: null }, null).accountId, null, 'two unknowns keep null — the hint never guesses an account');
  assert.equal(rp.navigationShopCfg({ name: 'x' }, undefined).accountId, null, 'a missing accountId stays null without a hint');
  assert.equal(rp.navigationShopCfg({ name: 'x', accountId: '' }, '').accountId, null, 'empty strings normalise to null, never a guessed id');
});

// A string-match test proved only that the text "shopProfile.navigationShopCfg(shopCfg,...)"
// EXISTED — so it stayed green while BOTH real entries called a namespace that never
// exported the helper (a guaranteed TypeError before any navigation). This test instead
// RUNS both real entries against a throwaway adapter project: it copies the publisher
// modules into a temp dir, wires a fake config (a single generic shop, accountId:null) and
// a fake opener that records what it received and then throws a sentinel BEFORE any
// browser / network / Cookie / HTTP server / state write. If either entry namespaces the
// helper wrong, the opener is never reached and the assertion fails.
test('both real entries (main + inspectRecoveryOnly) actually reach the opener and hand it the account hint', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'run-plans.cjs'), 'utf8');
  // Static negative guard for the exact regression: the module-local helper must NEVER be
  // reached through shop-profile (which never exported it).
  assert.equal((src.match(/shopProfile\.navigationShopCfg/g) || []).length, 0, 'the local navigationShopCfg is never reached through shopProfile');

  const publisherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'navhint-mod-'));
  const adapterDir = fs.mkdtempSync(path.join(os.tmpdir(), 'navhint-adapter-'));
  const withinTmp = (p) => { const r = path.resolve(p); const t = path.resolve(os.tmpdir()); return r === t || r.startsWith(t + path.sep); };
  const SHOP = '虚构导航店';
  const HINT = '1770000000007777';
  const savedArgv = process.argv;
  const savedRoot = process.env.PROMO_PROJECT_ROOT;
  const savedLog = console.log;
  const logs = [];
  try {
    assert.ok(withinTmp(publisherDir) && withinTmp(adapterDir), 'scratch dirs stay inside the OS temp dir');
    for (const f of ['run-plans.cjs', 'plan-workflow.cjs', 'direct-draft-controller.cjs', 'confirmation-ui.cjs', 'shop-profile.cjs']) {
      fs.copyFileSync(path.join(__dirname, f), path.join(publisherDir, f));
    }
    fs.mkdirSync(path.join(publisherDir, 'fixtures'), { recursive: true });
    fs.copyFileSync(SEED_FILE, path.join(publisherDir, 'fixtures', 'published-plan-seed.json'));
    fs.mkdirSync(path.join(adapterDir, 'src', 'adapters'), { recursive: true });
    // Fake adapter project: the only local config row is a generic shop whose accountId is
    // null; the fake opener records the shopCfg/loginCfg/headless it received plus the LIVE
    // config rows, then throws a sentinel — so no browser/net/Cookie/state is ever touched.
    fs.writeFileSync(path.join(adapterDir, 'src', 'config.js'),
      "'use strict';\n" +
      "const rows={login:{shopDir:'fake-shop',stateDir:'fake-state'},shops:[{name:" + JSON.stringify(SHOP) + ",accountId:null,boundAccounts:['fake_target_a'],creationPath:'/uni-creation/overall-product-multi',enabled:true}]};\n" +
      "module.exports.loadConfig=()=>({ready:true,config:{login:rows.login,shops:rows.shops}});\n" +
      "module.exports.__rows=rows;\n");
    fs.writeFileSync(path.join(adapterDir, 'src', 'adapters', 'chengfang-reader.js'),
      "'use strict';\n" +
      "const cfg=require('../config.js');const calls=[];\n" +
      "function reach(args){calls.push({shopCfg:args&&args.shopCfg,loginCfg:args&&args.loginCfg,headless:args&&args.headless,liveShops:cfg.__rows.shops});const e=new Error('fake-opener-reached');e.code='fake-opener-sentinel';throw e;}\n" +
      "function notNavigable(){throw new Error('fake-adapter-not-navigable');}\n" +
      "function clickChengfangSubTab(){return notNavigable;}\n" +
      "function closeBrowser(){return Promise.resolve();}\n" +
      "module.exports={openChengfangShop:reach,readChengfangAccountInPage:notNavigable,clickChengfangSubTab,closeBrowser,collectChengfangRowsInPage:notNavigable,collectChengfangPaginationInPage:notNavigable,clickChengfangFirstPageInPage:notNavigable,clickChengfangNextPageInPage:notNavigable,__calls:calls};\n");

    const temp = require(path.join(publisherDir, 'run-plans.cjs'));
    const fakeConfig = require(path.join(adapterDir, 'src', 'config.js'));
    const fakeReader = require(path.join(adapterDir, 'src', 'adapters', 'chengfang-reader'));

    process.env.PROMO_PROJECT_ROOT = adapterDir;
    console.log = (...a) => { logs.push(a.map(String).join(' ')); };

    // ── entry 1: main() with a fictional shop + a normalized placeholder account ──
    process.argv = [process.execPath, path.join(publisherDir, 'run-plans.cjs'), '--shop', SHOP, '--account', HINT];
    await temp.main();
    assert.equal(fakeReader.__calls.length, 1, 'main() must reach the real opener (a wrong namespace never would)');
    assert.equal(fakeReader.__calls[0].shopCfg.accountId, HINT, 'the host-known account hint reaches the opener');
    assert.equal(fakeReader.__calls[0].headless, false);
    assert.equal(fakeReader.__calls[0].liveShops[0].accountId, null, 'the source config row is never mutated by the hint');
    assert.equal(fakeConfig.__rows.shops[0].accountId, null, 'the live config row keeps its null account');
    assert.ok(logs.some(l => l.includes('fake-opener-reached')), 'main caught the opener sentinel, proving the call really happened');

    // ── entry 2: inspectRecoveryOnly with the same frozen business ────────────
    fakeReader.__calls.length = 0;
    logs.length = 0;
    const business = sp.buildShopProfile({ shop: SHOP, accountId: HINT, boundAccounts: ['fake_target_a'] });
    await assert.rejects(
      () => temp.inspectRecoveryOnly({ root: adapterDir, unresolved: [], state: {}, business }),
      /fake-opener-reached/);
    assert.equal(fakeReader.__calls.length, 1, 'inspectRecoveryOnly must also reach the real opener');
    assert.equal(fakeReader.__calls[0].shopCfg.accountId, HINT, 'recovery threads the same frozen account hint');
    assert.equal(fakeReader.__calls[0].liveShops[0].accountId, null, 'recovery never mutates the config row');

    // Supplementary: the hint NEVER replaces the live identity proof in either entry.
    assert.match(src, /verifyLiveIdentity\(business,String\(identity\.accountId\)\)/, 'main keeps the live identity gate');
    assert.match(src, /recovery-account-identity-unknown/, 'recovery keeps the live identity gate');
    assert.match(src, /cli-account-does-not-match-live-session/, 'the CLI/live match gate is untouched');
  } finally {
    console.log = savedLog;
    process.argv = savedArgv;
    if (savedRoot === undefined) delete process.env.PROMO_PROJECT_ROOT; else process.env.PROMO_PROJECT_ROOT = savedRoot;
    if (withinTmp(publisherDir)) fs.rmSync(publisherDir, { recursive: true, force: true });
    if (withinTmp(adapterDir)) fs.rmSync(adapterDir, { recursive: true, force: true });
  }
});

// ── no module-load side effects ─────────────────────────────────────────────
test('requiring the multi-shop modules writes no workspace state', () => {
  assert.ok(!fs.existsSync(path.join(__dirname, 'plan-publication-attempts.json')));
  assert.ok(!fs.existsSync(path.join(__dirname, 'shop-state')));
});

// ── late guidance before a native scroll: the EXISTING guidance phase is reused ──
// A late-recognized 下一步 / 我知道了 popup that lands right before a native-scroll advance
// must be handled by the real guidance phase and confirmed gone, never scrolled past. The
// helper is dependency-injected (page + accountId + runGuidancePhase), so a fake page
// fixture drives every branch offline with the REAL guidanceActionInPage reference; the
// REAL nativeAdvance passes the REAL guidancePhase (verified structurally below).
function lateGuidePage(snapshots) {
  const calls = { snapshot: 0, step: 0 };
  const page = { evaluate: async (fn, arg) => {
    if (fn === rp.guidanceActionInPage && arg && arg.mode === 'snapshot') {
      const s = snapshots[Math.min(calls.snapshot, snapshots.length - 1)];
      calls.snapshot++;
      return s;
    }
    if (fn === rp.guidanceActionInPage && arg && arg.mode === 'step') { calls.step++; return { clicked: true }; }
    throw new Error('unexpected late-guide evaluate ' + (fn && fn.name));
  } };
  return { page, calls };
}
const ABSENT_GUIDE = { present: false, unknown: null, roots: [] };
const ACCT = '1696626252631053';
const KNOWN_GUIDE = { present: true, unknown: null, roots: [{ order: 0, kind: 'firefly', content: '千川乘方重磅升级 我知道了', label: '我知道了', disabled: false }] };

test('late guidance before native advance: a KNOWN 我知道了 is handled once, cookie+flag saved, then a fresh-absent snapshot allows the scroll', async () => {
  const h = lateGuidePage([KNOWN_GUIDE, ABSENT_GUIDE]);
  const phases = [];
  const r = await rp.handleLateGuidanceBeforeNativeAdvance(h.page, ACCT, async () => { phases.push(1); return { handled: 1, cookieStatus: 'saved', flagsSaved: true }; });
  assert.equal(phases.length, 1, 'the real phase runs exactly once');
  assert.equal(r.handled, 1);
  assert.equal(h.calls.snapshot, 2, 'a fresh snapshot is read after the phase');
  assert.equal(h.calls.step, 0, 'the helper itself never clicks');
});

test('late guidance before native advance: an ABSENT overlay does zero phase/cookie/flag work and continues', async () => {
  const h = lateGuidePage([ABSENT_GUIDE]);
  let phases = 0;
  const r = await rp.handleLateGuidanceBeforeNativeAdvance(h.page, ACCT, async () => { phases++; throw new Error('phase must not run for an absent overlay'); });
  assert.equal(phases, 0, 'none => zero phase (so zero cookie and zero flag writes)');
  assert.equal(r.handled, 0);
  assert.equal(h.calls.snapshot, 1);
  assert.equal(h.calls.step, 0);
});

test('late guidance before native advance: an UNKNOWN overlay stops with the ORIGINAL reason and zero phase/scroll', async () => {
  const h = lateGuidePage([{ present: false, unknown: 'guidance-unknown-root-shape', roots: [] }]);
  let phases = 0;
  await assert.rejects(rp.handleLateGuidanceBeforeNativeAdvance(h.page, ACCT, async () => { phases++; }), /guidance-unknown-root-shape/);
  assert.equal(phases, 0, 'an unknown overlay is never clicked by the helper');
  assert.equal(h.calls.step, 0);
});

test('late guidance before native advance: handled>0 with a cookie conflict or an unsaved flag stops before any scroll', async () => {
  const cookieFailed = lateGuidePage([KNOWN_GUIDE]);
  await assert.rejects(rp.handleLateGuidanceBeforeNativeAdvance(cookieFailed.page, ACCT, async () => ({ handled: 1, cookieStatus: 'failed', flagsSaved: false })), /native-advance-guide-state-not-persisted/);
  const flagFailed = lateGuidePage([KNOWN_GUIDE]);
  await assert.rejects(rp.handleLateGuidanceBeforeNativeAdvance(flagFailed.page, ACCT, async () => ({ handled: 1, cookieStatus: 'saved', flagsSaved: false })), /native-advance-guide-state-not-persisted/);
});

test('late guidance before native advance: cookie CAS conflict with saved private flags continues after fresh absence', async () => {
  const h = lateGuidePage([KNOWN_GUIDE, ABSENT_GUIDE]);
  const r = await rp.handleLateGuidanceBeforeNativeAdvance(h.page, ACCT, async () => ({ handled: 1, cookieStatus: 'failed', flagsSaved: true, conflict: true }));
  assert.equal(r.handled, 1);
  assert.equal(h.calls.snapshot, 2);
});

test('late guidance before native advance: a fresh still-present or unknown overlay stops after the phase', async () => {
  const stillPresent = lateGuidePage([KNOWN_GUIDE, { present: true, unknown: null, roots: [{ order: 0, kind: 'firefly', label: '下一步', disabled: false }] }]);
  await assert.rejects(rp.handleLateGuidanceBeforeNativeAdvance(stillPresent.page, ACCT, async () => ({ handled: 1, cookieStatus: 'saved', flagsSaved: true })), /native-advance-guide-overlay-present/);
  const freshUnknown = lateGuidePage([KNOWN_GUIDE, { present: false, unknown: 'guidance-unknown-root-shape', roots: [] }]);
  await assert.rejects(rp.handleLateGuidanceBeforeNativeAdvance(freshUnknown.page, ACCT, async () => ({ handled: 1, cookieStatus: 'saved', flagsSaved: true })), /guidance-unknown-root-shape/);
});

test('late guidance before native advance: an overlay that vanished on its own (handled 0) continues only when the fresh snapshot is absent', async () => {
  const gone = lateGuidePage([KNOWN_GUIDE, ABSENT_GUIDE]);
  const r = await rp.handleLateGuidanceBeforeNativeAdvance(gone.page, ACCT, async () => ({ handled: 0, cookieStatus: 'not-needed', flagsSaved: false }));
  assert.equal(r.handled, 0);
  const stuck = lateGuidePage([KNOWN_GUIDE, KNOWN_GUIDE]);
  await assert.rejects(rp.handleLateGuidanceBeforeNativeAdvance(stuck.page, ACCT, async () => ({ handled: 0, cookieStatus: 'not-needed', flagsSaved: false })), /native-advance-guide-overlay-present/);
});

test('the REAL nativeAdvance handles a late guidance overlay through the exported local helper and the real guidancePhase', () => {
  assert.equal(typeof rp.handleLateGuidanceBeforeNativeAdvance, 'function', 'the helper is exported for the offline DI tests');
  const src = fs.readFileSync(path.join(__dirname, 'run-plans.cjs'), 'utf8');
  const start = src.indexOf('async function nativeAdvance(');
  assert.ok(start >= 0, 'nativeAdvance must exist');
  const end = src.indexOf('async function openPicker()', start);
  const body = src.slice(start, end > start ? end : undefined);
  assert.match(body, /await handleLateGuidanceBeforeNativeAdvance\(page,\s*accountId,\s*guidancePhase\)/, 'nativeAdvance must call the REAL local helper with the REAL guidancePhase (not a copy)');
  assert.doesNotMatch(body, /throw new Error\('native-advance-guide-overlay-present'\)/, 'the old unconditional present-throw is gone; a present overlay now goes through the reused phase');
});

// ── R11: native single-manual-account layout (the real Minmin 30-row binding readback blocker) ──
// Offline DOM/vm mirror (same approach as the workspace's two existing harnesses, in place,
// not a general framework). It runs the REAL exported in-page readers — rp.readMainTableInPage,
// the ctl.pageObserve creation collector and the ctl.publishApply final guard — plus the pure
// wf.parseMainTableRow fallback against the read-only native fixture. No network/browser/Cookie.
const SINGLE_FIX = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'single-manual-account-native.json'), 'utf8'));
const R11_ACCT = '1696626252631053';
const R11_PLAN_NAME = '2026-10-11_敏敏高定私服_10:00:00';
const r11norm = s => String(s || '').replace(/\s+/g, ' ').trim();

const R11Proto = {
  getAttribute(name) {
    if (name === 'class') return this.className != null ? String(this.className) : null;
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  },
  getBoundingClientRect() { const r = this.__rect; return { width: r ? r[0] : 0, height: r ? r[1] : 0, x: 0, y: 0, top: 0, bottom: r ? r[1] : 0 }; },
  get innerText() { return this.__computeText(); },
  get textContent() { return this.__computeText(); },
  get children() { return this.__kids; },
  get parentElement() { return this.parent; },
  get value() { return this.__value == null ? '' : this.__value; },
  set value(v) { this.__value = String(v); },
  __computeText() { let s = ''; const walk = n => { if (n.__text != null) s += n.__text + ' '; for (const ch of n.__kids) walk(ch); }; walk(this); return s.replace(/\s+/g, ' ').trim(); },
  querySelectorAll(sel) { const out = []; const walk = n => { for (const ch of n.__kids) { if (r11Matches(ch, sel)) out.push(ch); walk(ch); } }; walk(this); return out; },
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  closest(sel) { let n = this; while (n) { if (r11Matches(n, sel)) return n; n = n.parent; } return null; },
  contains(other) { let n = other; while (n) { if (n === this) return true; n = n.parent; } return false; },
  click() { this.__clicks = (this.__clicks || 0) + 1; },
  dispatchEvent() { return true; },
};
function R11El(tag, opts = {}, kids = []) {
  opts = opts || {};
  const el = Object.create(R11Proto);
  el.tagName = String(tag).toUpperCase();
  el.attrs = {};
  el.className = opts.class != null ? opts.class : '';
  el.__text = opts.text != null ? String(opts.text) : null;
  el.__rect = opts.rect;
  el.__vis = opts.hidden ? 'hidden' : 'visible';
  el.disabled = opts.disabled === true;
  el.style = { setProperty() {}, getPropertyValue() { return ''; }, removeProperty() {} };
  el.__kids = []; el.parent = null;
  if (opts.checked !== undefined) el.checked = opts.checked === true;
  if (opts.value !== undefined) el.__value = String(opts.value);
  if (opts.attrs) for (const k in opts.attrs) el.attrs[k] = String(opts.attrs[k]);
  for (const ch of kids) { if (!ch) continue; ch.parent = el; el.__kids.push(ch); }
  return el;
}
function r11Parts(str) {
  const parts = []; let i = 0;
  const tm = str.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tm) { parts.push({ t: 'tag', v: tm[0].toUpperCase() }); i = tm[0].length; }
  while (i < str.length) {
    if (str[i] === '[') {
      const close = str.indexOf(']', i); const inside = str.slice(i + 1, close);
      const am = inside.match(/^([a-zA-Z-]+)([*^$]?=)?"?([^"]*)"?:?$/);
      if (am && am[2]) parts.push({ t: 'attr', name: am[1], op: am[2], val: am[3] });
      else parts.push({ t: 'attr', name: inside.trim(), op: 'present' });
      i = close + 1;
    } else if (str[i] === '.') { const mm = str.slice(i).match(/^\.([A-Za-z0-9_-]+)/); parts.push({ t: 'class', v: mm[1] }); i += mm[0].length; }
    else i++;
  }
  return parts;
}
function r11MatchPart(el, p) {
  if (p.t === 'tag') return el.tagName === p.v;
  if (p.t === 'class') return (' ' + el.className + ' ').includes(' ' + p.v + ' ');
  if (p.t === 'attr') {
    const cur = el.getAttribute(p.name);
    if (p.op === 'present') return cur != null;
    if (cur == null) return false;
    if (p.op === '=') return cur === p.val;
    if (p.op === '*=') return cur.includes(p.val);
    return false;
  }
  return false;
}
function r11Matches(el, selStr) {
  return selStr.split(',').some(g => {
    const chain = g.trim().split(/\s+/).filter(Boolean);
    if (!chain.length) return false;
    const compound = (node, c) => { const parts = r11Parts(c); return parts.length > 0 && parts.every(p => r11MatchPart(node, p)); };
    let node = el;
    if (!compound(node, chain[chain.length - 1])) return false;
    for (let i = chain.length - 2; i >= 0; i--) {
      node = node.parent;
      while (node && !compound(node, chain[i])) node = node.parent;
      if (!node) return false;
    }
    return true;
  });
}
function r11Ctx(bodyKids) {
  const body = R11El('body', {}, bodyKids || []);
  const allDesc = node => { const out = []; const walk = n => { for (const ch of n.__kids) { out.push(ch); walk(ch); } }; walk(node); return out; };
  const doc = {
    body,
    querySelectorAll(sel) { if (sel.trim() === 'body *') return allDesc(body); return allDesc(body).filter(el => r11Matches(el, sel)); },
    querySelector(sel) { const a = this.querySelectorAll(sel); return a[0] || null; },
  };
  const windowObj = {};
  let clock = 1760000000000;
  const ctx = {
    window: windowObj, document: doc,
    location: { origin: 'https://qianchuan.jinritemai.com', pathname: '/uni-creation/overall-product-multi', search: '' },
    getComputedStyle: el => ({ visibility: el.__vis || 'visible', display: 'block' }),
    Date: { now() { return ++clock; } }, setTimeout, URLSearchParams, console: { log() {} },
  };
  const context = vm.createContext(ctx);
  windowObj.document = doc;
  return {
    context, doc, body,
    run(fn, arg) { const a = arguments.length > 1 ? ', ' + JSON.stringify(arg) : ''; return vm.runInContext('(' + fn.toString() + ').call(window' + a + ')', context); },
  };
}
// fixture-shaped builders: one visible manual .aweme-entry (name + explicit ID + the
// 管理手动添加抖音号 control) and the SEPARATE .auto-pull-aweme-wrapper subtree
function r11ManualEntry(o = {}) {
  const kids = [];
  if (!o.noInfo) {
    const infoKids = [];
    if (o.name !== null) infoKids.push(R11El('div', { class: 'item-info-title', rect: [140, 10], text: o.name === undefined ? '瑾漂亮私服' : o.name }));
    if (o.acctIdLine !== null) infoKids.push(R11El('div', { class: 'item-info-bottom', rect: [140, 10], text: o.acctIdLine === undefined ? 'ID：9zmao_fushi' : o.acctIdLine }));
    kids.push(R11El('div', { class: 'item-info-wrapper', rect: [140, 20] }, infoKids));
  }
  kids.push(R11El('button', { rect: [110, 14], text: o.buttonText === undefined ? '管理手动添加抖音号' : o.buttonText }));
  return R11El('div', { class: 'aweme-entry', rect: [150, 24], hidden: o.hidden === true }, kids);
}
function r11AutoPull(n) { return R11El('div', { class: 'auto-pull-aweme-wrapper', rect: [150, 8], text: '预估自动拉取 ' + n + ' 个' }); }
function r11AwemeTd(kids) { return R11El('td', { rect: [160, 40] }, [R11El('div', { class: 'aweme-wrapper', rect: [150, 36] }, kids)]); }
function r11Row(id, awemeKids, o = {}) {
  return R11El('tr', { rect: [600, 44] }, [
    R11El('td', { rect: [500, 30], text: '商品 店铺新品 ID：' + id }),
    o.bareTd ? R11El('td', { rect: [160, 30], text: o.bareTd }) : r11AwemeTd(awemeKids),
  ]);
}
function r11Table(rows) {
  return R11El('table', { class: 'ovui-table', rect: [900, 640] }, [
    R11El('tr', { rect: [900, 30] }, [
      R11El('th', { rect: [220, 20], text: '商品信息' }), R11El('th', { rect: [160, 20], text: '投放抖音号' }),
      R11El('th', { rect: [160, 20], text: '素材（默认启用智能优选）' }), R11El('th', { rect: [80, 20], text: '操作' }),
    ]), ...rows,
  ]);
}
function r11CreationKids(rowKids) {
  return [
    R11El('div', { class: 'qc-page-navigator-container', rect: [900, 40], text: '千川 乘方 ID：' + R11_ACCT + ' 敏敏高定私服' }),
    r11Table(rowKids),
    R11El('div', { class: 'oc-switch-card-item', rect: [400, 60], text: '含达人佣金出价 说明' }, [
      R11El('input', { attrs: { type: 'checkbox' }, checked: true, rect: [20, 20] }),
    ]),
    R11El('div', { class: 'ovui-field-row', rect: [320, 60] }, [
      R11El('label', { rect: [180, 24], text: '综合营销ROI目标(含达人佣金)' }),
      R11El('input', { class: 'ovui-input', attrs: { placeholder: '请输入' }, value: '15', rect: [120, 30] }),
    ]),
    R11El('div', { class: 'ovui-field-row', rect: [320, 60] }, [
      R11El('label', { rect: [180, 24], text: '日预算' }),
      R11El('input', { class: 'ovui-input', attrs: { placeholder: '请输入' }, value: '300', rect: [120, 30] }),
    ]),
    R11El('div', { class: 'oc-input-group-wrap', rect: [320, 60], text: '计划名称 14/50' }, [
      R11El('input', { class: 'ovui-input', attrs: { placeholder: '请输入计划名称，1-50个字符' }, value: R11_PLAN_NAME, rect: [140, 30] }),
    ]),
    R11El('div', { class: 'good-direct-pay-guide', rect: [400, 80], text: '为店铺开启 货款直投升级版 勾选视为同意协议' }, [
      R11El('input', { attrs: { type: 'checkbox' }, checked: false, rect: [20, 20] }),
    ]),
    R11El('button', { rect: [100, 36], text: '发布计划' }),
  ];
}

test('R11 readMainTableInPage: the real single-manual native layout yields manual 1 (not autoPullOnly) across all 30 rows', () => {
  // read-only fixture sanity: all 30 observed rows carry the SAME native cell copy
  assert.equal(SINGLE_FIX.all30.length, 30);
  const realCell = r11norm(SINGLE_FIX.dom.text);
  assert.equal(realCell, '瑾漂亮私服 ID：9zmao_fushi 管理手动添加抖音号 预估自动拉取 0 个');
  for (const r of SINGLE_FIX.all30) assert.equal(r11norm(r.text), realCell);
  const ids = ids30();
  const rows = ids.map(id => r11Row(id, [r11ManualEntry(), r11AutoPull(0)]));
  // the offline mirror must reproduce the observed real cell text exactly
  assert.equal(r11norm(rows[0].querySelector('.aweme-wrapper').innerText), realCell);
  const res = r11Ctx([r11Table(rows)]).run(rp.readMainTableInPage);
  assert.equal(res.ok, true);
  assert.equal(res.rows.length, 30);
  for (let i = 0; i < 30; i++) {
    const r = res.rows[i];
    assert.equal(r.productId, ids[i], '商品 ID 只来自数字商品 ID；9zmao_fushi 绝不被当商品 ID');
    assert.equal(r.manualAccounts, 1, '真实单账号布局必须读成手动 1，不再误判 0');
    assert.equal(r.manualEvidence, true);
    assert.equal(r.manualCountKnown, true);
    assert.equal(r.autoPullOnly, false, '单手动 + 自动拉取 0 仍是手动 1，不是 autoOnly');
    assert.equal(r.reviewFailed, false);
  }
  // the very gate that blocked at manual-account-bind-readback now passes on these rows
  assert.equal(wf.evaluateReadiness(res.rows, 30).ready, true);
  // a higher auto-pull estimate never flips the positive manual evidence
  const auto3 = r11Ctx([r11Table([r11Row(ids[0], [r11ManualEntry(), r11AutoPull(3)])])]).run(rp.readMainTableInPage).rows[0];
  assert.equal(auto3.manualAccounts, 1);
  assert.equal(auto3.autoPullOnly, false);
});

test('R11 readMainTableInPage: weaker or contradictory single-entry evidence is never counted as manual 1', () => {
  const id = '3845667181236977848';
  const read = kids => r11Ctx([r11Table([r11Row(id, kids)])]).run(rp.readMainTableInPage).rows[0];
  // auto-only: no manual entry at all
  const autoOnly = read([r11AutoPull(0)]);
  assert.equal(autoOnly.manualAccounts, 0);
  assert.equal(autoOnly.autoPullOnly, true);
  assert.equal(autoOnly.manualEvidence, false);
  // unknown layout: no aweme cell, no counter -> stays unknown, never guessed
  const unknown = r11Ctx([r11Table([r11Row(id, null, { bareTd: '页面文案无法识别' })])]).run(rp.readMainTableInPage).rows[0];
  assert.equal(unknown.manualAccounts, null);
  assert.equal(unknown.manualCountKnown, false);
  // hidden entry
  assert.notEqual(read([r11ManualEntry({ hidden: true }), r11AutoPull(0)]).manualAccounts, 1);
  // duplicate visible entries
  assert.notEqual(read([r11ManualEntry(), r11ManualEntry(), r11AutoPull(0)]).manualAccounts, 1);
  // missing name
  assert.notEqual(read([r11ManualEntry({ name: null }), r11AutoPull(0)]).manualAccounts, 1);
  // empty explicit ID
  assert.notEqual(read([r11ManualEntry({ acctIdLine: 'ID：' }), r11AutoPull(0)]).manualAccounts, 1);
  // manage button but no account info subtree
  assert.notEqual(read([r11ManualEntry({ noInfo: true }), r11AutoPull(0)]).manualAccounts, 1);
  // an explicit counter outranks the single-entry inference (contradiction keeps the counter)
  const contra = read([R11El('div', { rect: [150, 16], text: '2个抖音号 管理手动添加抖音号' }), r11ManualEntry(), r11AutoPull(0)]);
  assert.equal(contra.manualAccounts, 2);
  // the legacy double-account bare-text row still passes unchanged
  const legacy = r11Ctx([r11Table([r11Row(id, null, { bareTd: '2个抖音号 管理手动添加抖音号 预估自动拉取 0 个' })])]).run(rp.readMainTableInPage).rows[0];
  assert.equal(legacy.manualAccounts, 2);
  assert.equal(legacy.manualEvidence, true);
  assert.equal(legacy.autoPullOnly, false);
});

test('R11 pageObserve creation collector: 30 native single-manual rows give eachRowHasManualAccount, one auto-only row keeps it closed', () => {
  const ids = ids30();
  const cr = r11Ctx(r11CreationKids(ids.map(id => r11Row(id, [r11ManualEntry(), r11AutoPull(0)])))).run(ctl.pageObserve).creation;
  assert.equal(cr.originOk, true);
  assert.equal(cr.pathOk, true);
  assert.equal(cr.accountId, R11_ACCT);
  assert.equal(cr.mainTableUnique, true);
  assert.equal(cr.productRowCount, 30);
  assert.equal(cr.uniqueProductCount, 30);
  assert.equal(cr.eachRowHasManualAccount, true, '真实 30 行单账号布局不再被收集器误判 manualAccounts 0');
  assert.deepEqual(JSON.parse(JSON.stringify(cr.rows.map(r => r.manualAccounts))), ids.map(() => 1));
  const mixed = ids.map((id, i) => (i === 5 ? r11Row(id, [r11AutoPull(0)]) : r11Row(id, [r11ManualEntry(), r11AutoPull(0)])));
  const cr2 = r11Ctx(r11CreationKids(mixed)).run(ctl.pageObserve).creation;
  assert.equal(cr2.eachRowHasManualAccount, false);
  assert.equal(cr2.rows[5].manualAccounts, 0);
});

test('R11 publishApply final guard: single-manual 30 rows pass with exactly one click; an auto-only row throws with zero clicks', () => {
  const ids = ids30();
  const kids = r11CreationKids(ids.map(id => r11Row(id, [r11ManualEntry(), r11AutoPull(0)])));
  const publishBtn = kids[kids.length - 1];
  const dom = r11Ctx(kids);
  const obs = dom.run(ctl.pageObserve);
  const res = dom.run(ctl.publishApply, { observation: obs.observation, planNumber: 1, accountId: R11_ACCT, productIds: ids, planName: R11_PLAN_NAME });
  assert.equal(res.clicked, true);
  assert.equal(publishBtn.__clicks, 1, '真实最终守卫对单账号布局恰好点击一次发布');
  const badKids = r11CreationKids(ids.map((id, i) => (i === 7 ? r11Row(id, [r11AutoPull(0)]) : r11Row(id, [r11ManualEntry(), r11AutoPull(0)]))));
  const badBtn = badKids[badKids.length - 1];
  const badDom = r11Ctx(badKids);
  const badObs = badDom.run(ctl.pageObserve);
  assert.throws(
    () => badDom.run(ctl.publishApply, { observation: badObs.observation, planNumber: 1, accountId: R11_ACCT, productIds: ids, planName: R11_PLAN_NAME }),
    /manual douyin account/);
  assert.equal(badBtn.__clicks, undefined, '任何一行缺手动证据都是抛出 + 零点击');
});

test('R11 parseMainTableRow: the plain-text fallback only accepts the full positive single-manual copy', () => {
  const pid = SINGLE_FIX.productId;
  const realRow = r11norm('商品0 店铺新品 ID：' + pid + ' ' + SINGLE_FIX.all30[0].text + ' 素材 操作');
  const parsed = wf.parseMainTableRow(realRow);
  assert.equal(parsed.productId, pid);
  assert.equal(parsed.manualAccounts, 1);
  assert.equal(parsed.manualEvidence, true);
  assert.equal(parsed.manualCountKnown, true);
  assert.equal(parsed.autoPullOnly, false);
  // a higher auto estimate never flips the positive manual copy
  assert.equal(wf.parseMainTableRow(realRow.replace('预估自动拉取 0 个', '预估自动拉取 3 个')).manualAccounts, 1);
  // a product-ID-shaped token can never pose as the account: manage button alone stays auto-only
  const buttonOnly = wf.parseMainTableRow('商品0 店铺新品 ID：3845667181236977849 管理手动添加抖音号 预估自动拉取 0 个');
  assert.equal(buttonOnly.manualAccounts, 0);
  assert.equal(buttonOnly.autoPullOnly, true);
  assert.equal(buttonOnly.manualEvidence, false);
  // name + ID without the manage control is not manual evidence
  const noControl = wf.parseMainTableRow('商品0 店铺新品 ID：3845667181236977850 瑾漂亮私服 ID：9zmao_fushi 预估自动拉取 0 个');
  assert.equal(noControl.manualAccounts, 0);
  assert.equal(noControl.manualEvidence, false);
  // a non-adjacent manage copy stays unknown — never any row ID pressed into service as manual
  const far = wf.parseMainTableRow('商品0 店铺新品 ID：3845667181236977851 素材 管理手动添加抖音号 页面文案无法识别');
  assert.equal(far.manualAccounts, null);
  assert.equal(far.manualCountKnown, false);
  // the original double-account counter copy is preserved
  assert.equal(wf.parseMainTableRow('示例商品 ID：3845667181236977852 2个抖音号 管理手动添加抖音号 预估自动拉取 0 个').manualAccounts, 2);
  // 30 real-shaped text rows pass the real readiness gate
  const rows = ids30().map((id, i) => ({ text: r11norm('商品' + i + ' 店铺新品 ID：' + id + ' ' + SINGLE_FIX.all30[i].text) }));
  const ready = wf.evaluateReadiness(rows, 30);
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.deficientIds, []);
  assert.deepEqual(ready.unknownManualIds, []);
});
