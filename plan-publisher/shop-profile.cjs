'use strict';
// Pure multi-shop PROFILE helpers (no fs writes, no browser, no network, no
// model at require time). This module only:
//   * validates / normalises an explicit shop business profile,
//   * derives the per-shop create/manage URLs and isolated state paths,
//   * selects the unique named shop from a project config,
//   * parses the --shop / --account / --targets entry arguments,
//   * compares shop identities and freezes binding targets without drift.
//
// It deliberately does NOT hard-code the legacy 瑾漂亮 default as authority:
// callers build the legacy profile with profileFromBusiness(wf.BUSINESS) so the
// frozen default stays a single source of truth in plan-workflow.cjs. Every
// function here is deterministic and side-effect free so the host brain can unit
// test the generic path WITHOUT launching any CLI, browser or cookie session.

const path = require('path');

const ACCOUNT_RE = /^\d{6,24}$/;
const TARGET_ID_RE = /^[0-9A-Za-z_-]{4,32}$/;

// 目标 ROI 默认值（客户 2026-10-11："缺字段默认 15"）。
const DEFAULT_TARGET_ROI = 15;

// 严格目标 ROI 解析：缺失（undefined/null）→ 默认 15；明确值只接受**正有限 number**
// （支持 13.5），拒绝布尔 / NaN / Infinity / 0 / 负数 / 形如 '15abc' 的字符串。
// 抛 shop-profile-invalid('roi-invalid')，绝不静默 Number() 一个脏值。
function parseTargetRoi(value) {
  if (value === undefined || value === null) return DEFAULT_TARGET_ROI;
  if (typeof value !== 'number' || !Number.isFinite(value) || !(value > 0)) throw invalid('roi-invalid');
  return value;
}

function invalid(reason) {
  const error = new Error(reason);
  error.code = 'shop-profile-invalid';
  error.reason = reason;
  return error;
}
function asArray(value) { return Array.isArray(value) ? value : []; }
function uniqStrings(list) {
  return [...new Set(asArray(list).map(x => String(x).trim()).filter(Boolean))];
}

// ── profile construction / normalisation ────────────────────────────────────
function normalizeBoundAccounts(list) {
  if (list == null) return null;
  const ids = uniqStrings(list);
  if (ids.length === 0) throw invalid('bound-accounts-empty');
  for (const id of ids) if (!TARGET_ID_RE.test(id)) throw invalid('bound-account-id-invalid:' + id);
  return Object.freeze(ids);
}

function shopSlug(profile) {
  const raw = String((profile && profile.shop) || '').trim();
  const slug = raw.replace(/[^\w\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'shop';
  const account = profile && profile.accountId ? String(profile.accountId) : 'pending';
  return slug + '__' + account;
}

// Build a frozen, validated business profile. `boundAccounts` may be null when
// the host has not yet discovered the shop's bindable targets; `accountId` may
// be null when the local config carries none and the live session must prove it.
function buildShopProfile(input) {
  const i = input || {};
  const shop = String(i.shop || '').trim();
  if (!shop) throw invalid('shop-name-missing');
  const accountId = i.accountId == null || String(i.accountId) === '' ? null : String(i.accountId);
  if (accountId !== null && !ACCOUNT_RE.test(accountId)) throw invalid('account-id-invalid');
  const boundAccounts = normalizeBoundAccounts(i.boundAccounts);
  const productsPerPlan = i.productsPerPlan == null ? 30 : Number(i.productsPerPlan);
  if (!Number.isInteger(productsPerPlan) || productsPerPlan < 1 || productsPerPlan > 200) throw invalid('products-per-plan-invalid');
  const creationPath = String(i.creationPath || '/uni-creation/overall-product-multi');
  if (!creationPath.startsWith('/')) throw invalid('creation-path-invalid');
  const roi = parseTargetRoi(i.roi);
  const dailyBudget = i.dailyBudget == null ? 300 : Number(i.dailyBudget);
  if (!(dailyBudget > 0)) throw invalid('roi-or-budget-invalid');
  const profile = {
    shop,
    accountId,
    boundAccounts,
    productsPerPlan,
    roi,
    dailyBudget,
    commissionIncluded: i.commissionIncluded !== false,
    directPay: i.directPay === true,
    maxPlansPerDay: Number.isInteger(i.maxPlansPerDay) ? i.maxPlansPerDay : 3,
    creationPath,
    // Always an ABSOLUTE creation URL derived from the (validated) path + account,
    // so a relative legacy `creationUrl` can never be navigated as a bare path.
    creationUrl: 'https://qianchuan.jinritemai.com' + creationPath + (accountId ? '?aavid=' + accountId : ''),
  };
  profile.identityKey = shopSlug(profile);
  return Object.freeze(profile);
}

// Build the profile from a BUSINESS-shaped object (plan-workflow's frozen
// default or an equivalent injected business record).
function profileFromBusiness(business) {
  const b = business || {};
  return buildShopProfile({
    shop: b.shop,
    accountId: b.accountId,
    boundAccounts: b.boundAccounts,
    productsPerPlan: b.productsPerPlan,
    roi: b.roi,
    dailyBudget: b.dailyBudget,
    commissionIncluded: b.commissionIncluded,
    directPay: b.directPay,
    maxPlansPerDay: b.maxPlansPerDay,
    creationPath: b.creationPath,
    creationUrl: b.creationUrl,
  });
}

function creationUrlFor(profile) {
  return 'https://qianchuan.jinritemai.com' + String(profile.creationPath || '') + (profile.accountId ? '?aavid=' + profile.accountId : '');
}
// 真实管理（已发布计划列表）URL（客户 2026-10-11 实测）：旧 `/uni-prom/overall` 会重定向首页，
// 正确入口为 `/overall-prom?aavid=<账户>&campaignType=1`。账户缺失时仍返回同形状但不含 aavid，
// 由下游 verifyLiveIdentity 证明身份。
function managementUrlFor(profile) {
  const account = profile && profile.accountId ? String(profile.accountId) : '';
  return 'https://qianchuan.jinritemai.com/overall-prom' + (account ? '?aavid=' + account + '&campaignType=1' : '');
}

function isLegacyDefaultProfile(profile, legacy) {
  return !!profile && !!legacy
    && String(profile.shop) === String(legacy.shop)
    && String(profile.accountId) === String(legacy.accountId);
}

// ── per-shop runtime isolation ──────────────────────────────────────────────
// The legacy default shop keeps using today's flat files in place (no data
// migration); every other shop gets its own account-scoped directory so a same
// name with a different account can never mix state.
function shopStatePaths(profile, root, opts) {
  const o = opts || {};
  if (o.legacy === true) {
    return {
      isolated: false, dir: root,
      stateFile: path.join(root, 'plan-publisher-state.json'),
      publishedFile: path.join(root, 'published-products.json'),
      attemptsFile: path.join(root, 'plan-publication-attempts.json'),
      lockFile: path.join(root, 'plan-publisher.lock'),
      seedFile: path.join(root, 'fixtures', 'published-plan-seed.json'),
      guidanceDir: null,
    };
  }
  const dir = path.join(root, 'shop-state', shopSlug(profile));
  return {
    isolated: true, dir,
    stateFile: path.join(dir, 'plan-publisher-state.json'),
    publishedFile: path.join(dir, 'published-products.json'),
    attemptsFile: path.join(dir, 'plan-publication-attempts.json'),
    lockFile: path.join(dir, 'plan-publisher.lock'),
    seedFile: path.join(dir, 'fixtures', 'published-plan-seed.json'),
    guidanceDir: path.join(dir, 'guidance'),
  };
}

// A seed file only belongs to a profile when its recorded account matches; an
// unverifiable / foreign seed is never imported into a shop's history.
function seedBelongsToProfile(seed, profile) {
  if (!seed || !profile || !profile.accountId) return false;
  const account = seed.accountId != null ? String(seed.accountId) : (seed.account_id != null ? String(seed.account_id) : null);
  return !!account && account === String(profile.accountId);
}

// ── selection + identity guards ─────────────────────────────────────────────
// Selection is ONLY an explicit, by-name, unique match. `enabled` is an EXTERNAL
// monitor-participation marker, NOT a publish authorization: a user who explicitly
// names a shop that carries a verified Cookie may publish to it even when the flag
// is false. This never turns monitoring on, never rewrites the config row, and
// never bypasses the live Cookie identity check (verifyLiveIdentity) — an unknown
// or duplicate name still refuses, and a shop with no Cookie / mismatched live
// account still fails closed downstream. The bindable-account labelDisabled
// restriction is a separate gate and is left untouched.
//
// This is the single tiny pure selector the ordered main() entry and the read-only
// recovery entry BOTH call, so a monitor `enabled:false` row can never silently
// exclude an explicitly named shop from either path.
function selectNamedShopConfig(config, shopName, opts) {
  const o = opts || {};
  const shops = asArray(config && config.shops).filter(s => s && s.name === String(shopName));
  if (shops.length !== 1) throw invalid('shop-selection-not-unique:' + shops.length);
  const shop = shops[0];
  const expected = o.accountId == null || String(o.accountId) === '' ? null : String(o.accountId);
  const configured = shop.accountId == null || String(shop.accountId) === '' ? null : String(shop.accountId);
  // A KNOWN local account that differs from the expected (live/frozen) one is
  // refused outright. An UNKNOWN (null) configured account is allowed: the live
  // session must then PROVE the frozen account (verifyLiveIdentity) before any
  // tab switch or readback, so the shop's own Cookie is opened but nothing is
  // clicked/read until the identity is confirmed.
  if (expected !== null && configured !== null && configured !== expected) {
    throw invalid('shop-config-account-mismatch:' + configured + '!=' + expected);
  }
  return shop;
}

// Back-compat signature: a strictly by-name unique match with no account constraint.
function selectShopConfig(config, shopName) {
  return selectNamedShopConfig(config, shopName);
}

function parseShopArg(argv) {
  const args = asArray(argv);
  const out = { shop: null, account: null, targets: null, error: null };
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (a === '--shop') { out.shop = args[i + 1] != null ? String(args[i + 1]) : ''; i++; }
    else if (a.startsWith('--shop=')) out.shop = a.slice('--shop='.length);
    else if (a === '--account') { out.account = args[i + 1] != null ? String(args[i + 1]) : ''; i++; }
    else if (a.startsWith('--account=')) out.account = a.slice('--account='.length);
    else if (a === '--targets') { out.targets = String(args[i + 1] || '').split(',').map(s => s.trim()).filter(Boolean); i++; }
    else if (a.startsWith('--targets=')) out.targets = a.slice('--targets='.length).split(',').map(s => s.trim()).filter(Boolean);
  }
  if (out.shop === '') { out.error = 'shop-arg-empty'; out.shop = null; }
  if (out.account === '') { out.error = out.error || 'account-arg-empty'; out.account = null; }
  return out;
}

// The configured account (if any) must equal the live navigator account; a null
// configured account adopts the live one; an unknown live identity is refused.
function verifyLiveIdentity(profile, liveAccountId) {
  const live = liveAccountId == null ? null : String(liveAccountId);
  if (!live || live === 'unknown') return { ok: false, reason: 'live-account-identity-unknown', accountId: null };
  if (!ACCOUNT_RE.test(live)) return { ok: false, reason: 'live-account-identity-malformed', accountId: null };
  if (profile && profile.accountId != null && String(profile.accountId) !== live) {
    return { ok: false, reason: 'configured-account-does-not-match-live-session', accountId: null };
  }
  return { ok: true, reason: null, accountId: live };
}

// Freeze the discovered bindable targets ONCE. A profile that already carries
// targets may not silently change (drift => refuse); a null-target profile
// adopts the discovered set exactly.
function freezeBindingTargets(profile, discovered) {
  const found = uniqStrings(discovered);
  if (found.length === 0) return { ok: false, reason: 'no-bindable-target-accounts', boundAccounts: null };
  for (const id of found) if (!TARGET_ID_RE.test(id)) return { ok: false, reason: 'discovered-target-id-invalid', boundAccounts: null };
  if (profile && profile.boundAccounts && profile.boundAccounts.length) {
    const a = [...profile.boundAccounts].map(String).sort();
    const b = found.slice().sort();
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      return { ok: false, reason: 'binding-targets-drift', frozen: a, discovered: b, boundAccounts: null };
    }
    return { ok: true, reason: null, boundAccounts: profile.boundAccounts.slice(), frozen: true };
  }
  return { ok: true, reason: null, boundAccounts: found, frozen: false };
}

function assertSameShopIdentity(a, b) {
  if (!a || !b) return { ok: false, reason: 'profile-missing' };
  if (String(a.shop) !== String(b.shop)) return { ok: false, reason: 'shop-name-mismatch' };
  const aa = a.accountId == null ? null : String(a.accountId);
  const bb = b.accountId == null ? null : String(b.accountId);
  if (aa && bb && aa !== bb) return { ok: false, reason: 'shop-account-mismatch' };
  return { ok: true, reason: null };
}

module.exports = {
  buildShopProfile, profileFromBusiness, creationUrlFor, managementUrlFor,
  shopSlug, shopStatePaths, seedBelongsToProfile, isLegacyDefaultProfile,
  selectShopConfig, selectNamedShopConfig, parseShopArg, verifyLiveIdentity, freezeBindingTargets,
  assertSameShopIdentity, normalizeBoundAccounts,
};
