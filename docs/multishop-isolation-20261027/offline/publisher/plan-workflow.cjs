'use strict';
// High-level DETERMINISTIC plan-publish workflow (no LLM, no network at require
// time). It reuses the accepted R9 guard (direct-draft-controller.cjs) for every
// real page interaction and adds only the pure decision logic + persistent state
// needed to freeze today's proven 千川 商品自选 flow into a repeatable program.
//
// Design rules honored here:
//  - Nothing reads config/cookies/credentials at require time; requiring this
//    module has zero side effects (no file writes, no browser, no network).
//  - Every browser touch is an INJECTED dependency (deps.*), so the real
//    sequence is testable offline with fake pages/fixtures, and the same pure
//    functions below are what the tests exercise (never a parallel fake flow).
//  - Default start only PREPARES a plan and stops at 'ready-awaiting-confirmation';
//    publication requires an explicit, one-shot human POST confirmation bound to
//    a per-plan nonce + frozen-manifest hash + business date.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── fixed business configuration (瑾漂亮潮流服饰 / 千川乘方 商品自选) ──────────
const BUSINESS = Object.freeze({
  shop: '瑾漂亮潮流服饰',
  accountId: '1710242295996424',
  // The page account name may render as 伊人美 / 伊伊人美; identity is proven by
  // the navigator-header account ID, never by the display name.
  pageAccountNameVariants: ['伊人美', '伊伊人美'],
  productsPerPlan: 30,
  boundAccounts: Object.freeze(['79863866', '9zmao_fushi']),
  roi: 15,
  dailyBudget: 300,
  commissionIncluded: true,
  directPay: false,
  maxPlansPerDay: 3,
  creationPath: '/uni-creation/overall-product-multi',
  creationUrl: '/uni-creation/overall-product-multi?aavid=1710242295996424',
});

// Resolve the effective business profile for a call. An explicitly injected
// profile (the generic multi-shop path) wins; otherwise the frozen legacy
// default is used unchanged, so every existing call site keeps its exact
// behaviour while a different shop can be threaded through the same functions.
function bizOf(value) { return value && typeof value === 'object' ? value : BUSINESS; }

// 某 profile 本日合法份数上界：优先其已配置的 maxPlansPerDay（严格整数 1..10），
// 缺字段/非法一律回落默认 3。默认无覆盖仍只允许 1..3（第 4 份一律拒绝）；
// 配置为 6 时允许 1..6，但第 7 份仍拒绝——绝不无条件放宽，也绝不因配置回落而截断已真实成功的历史计数。
const DEFAULT_MAX_PLANS_PER_DAY = 3;
const MIN_MAX_PLANS_PER_DAY = 1;
const MAX_MAX_PLANS_PER_DAY = 10;
function effectivePlanLimit(biz) {
  if (biz && Object.prototype.hasOwnProperty.call(biz, 'maxPlansPerDay')) {
    const n = biz.maxPlansPerDay;
    if (typeof n === 'number' && Number.isInteger(n) && n >= MIN_MAX_PLANS_PER_DAY && n <= MAX_MAX_PLANS_PER_DAY) return n;
  }
  return DEFAULT_MAX_PLANS_PER_DAY;
}

// The explicit approved manual-binding targets a profile carries. A generic shop
// MUST carry its own discovered/frozen boundAccounts; this returns null when it
// carries none so the caller can fail closed rather than silently inherit the
// legacy default.
function configuredTargets(biz) {
  return biz && Array.isArray(biz.boundAccounts) && biz.boundAccounts.length
    ? [...new Set(biz.boundAccounts.map(String))] : null;
}
// True only for the frozen legacy default identity (shop + account match).
function isLegacyBusiness(biz) {
  return !biz || biz === BUSINESS
    || (String(biz.shop) === String(BUSINESS.shop) && biz.accountId != null && String(biz.accountId) === String(BUSINESS.accountId));
}
// Approved targets for a profile: its own when configured, the frozen legacy two
// for the legacy default identity, otherwise null (never the legacy default for a
// different shop — a generic profile without targets must stop).
function approvedTargets(biz) {
  const own = configuredTargets(biz);
  if (own) return own;
  if (isLegacyBusiness(biz)) return BUSINESS.boundAccounts.map(String);
  return null;
}

// Category browse order: recommended pools first, fall back to 全部 only when the
// recommendations are insufficient to fill 30 unique valid products (req 3).
const CATEGORY_TAB_ORDER = Object.freeze(['店铺新品', '破圈尖货', '搜索趋势', '全部']);

// Known final mutual-exclusion dialog (req 12). Comparison ignores whitespace
// only; anything else (new/unknown copy) stops and is surfaced to the human.
// This is the business BODY (header title + body) only. The footer button labels
// ("取消" / "确认发布") are NOT part of the body equality check; the confirm action
// is validated separately as a unique enabled semantic BUTTON (SPAN->closest button),
// so button copy can never be used to fabricate or gate the body match.
const FINAL_EXCLUSION_TEXT =
  '为保证乘方投放的唯一性，温馨提示您: 乘方投放时，受互斥影响的放量投放-全域投放计划、'
  + '控成本投放-全域投放计划将被删除（如有）。同时小店随心推订单将被终止，终止后不可恢复。 '
  + '若当前商品和抖音号已在全域投放，也可前往全域升级为乘方计划，升级后原有全域计划投放数据不受影响。';

const AUTO_PULL_MARK = '已存在自动拉取投放计划，添加后将会关闭自动拉取抖音号功能';
const MIGRATION_MARK = '该商品已创建「全店托管」计划';
const PRECHECK_MARK = '根据系统前置检测，当前商品可能审核不通过';
const REVIEW_FAILED_MARK = '当前商品广告审核不通过';
// The ONLY positive platform copy that proves a product/account pair already has a
// plan. It comes from the real disabled checkbox of the account drawer (live hover
// text "商品与该抖音号已存在商品投放计划查看详情"). A gray/disabled checkbox alone is
// NOT duplicate evidence — it can be an incomplete load or an unauthorized account.
const ALREADY_PLANNED_MARK = '商品与该抖音号已存在商品投放计划';

// ── S17 手动原生 UI 发布入账（仅 Root 操作者显式调用）────────────────────────
// 用户在原生千川页面上亲自完成的一次真实发布，既不是本机 controller 的一次
// consume，也不是任何 frozen/nonce 确认。它的来源被永久标注为
// source='user-authorized-native-ui'，并以独立的 manualUiPublicationFacts 记账，
// 绝不伪造 manifestHash / nonce / consumed / finalConsumed / reopen 记录。
const MANUAL_UI_SOURCE = 'user-authorized-native-ui';
// 手动入账所绑定的精确手动来源 runId：就是 main() 自身的一次性 publisher runId。
// 排程来源（plan-scheduler-…）绝不走此入口，避免与排程/恢复语义混淆。
const MANUAL_RUN_ORIGIN_RE = /^plan-publisher-(\d{4}-\d{2}-\d{2})-[0-9a-f]{16}$/;

// ── time (Asia/Shanghai) ────────────────────────────────────────────────────
function shanghaiDate(nowMs) {
  const d = new Date(nowMs === undefined ? Date.now() : nowMs);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(d);
  const get = t => (parts.find(p => p.type === t) || {}).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

// ── atomic persistence helpers ──────────────────────────────────────────────
// Synchronous JSON writer with the EXACT same contract as before (write tmp + rename in
// the SAME directory, byte-identical JSON.stringify(data,null,2), fail-closed). On Windows
// a renameSync can fail with a TRANSIENT EPERM/EACCES/EBUSY even when nothing is actually
// wrong, which previously aborted the whole save. Now only TRANSIENT codes are retried a
// bounded number of times inside a small total synchronous wait (strictly under 1s). A
// final success is PROVEN by reading the target back; a persistent failure rethrows the
// original error and leaves the old target untouched (never deleted / never a guessed
// success). If the target already holds the exact intended bytes (positive identical-bytes
// evidence) the durable state is already correct, so we return WITHOUT renaming — never a
// success inferred from a failed rename alone.
function syncSleep(ms) {
  if (!(ms > 0)) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function atomicWriteJson(file, data) {
  const tmp = file + '.tmp';
  const payload = JSON.stringify(data, null, 2);
  const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);
  const MAX_ATTEMPTS = 6;         // bounded: never an infinite loop
  const MAX_TOTAL_WAIT_MS = 900;  // synchronous wait budget, under 1s
  const BACKOFF = [50, 100, 200, 300];
  const targetMatches = () => { try { return fs.readFileSync(file, 'utf8') === payload; } catch (_) { return false; } };
  let attempt = 0, waited = 0;
  for (;;) {
    attempt++;
    let err = null;
    try { fs.writeFileSync(tmp, payload); fs.renameSync(tmp, file); }
    catch (e) { err = e; }
    if (!err) {
      if (fs.readFileSync(file, 'utf8') !== payload) throw new Error('atomic-write-verify-mismatch');
      return;
    }
    if (!TRANSIENT.has(err.code)) throw err;   // real / non-transient: fail closed at once
    if (targetMatches()) return;               // positive identical-bytes proof (no rename needed)
    if (attempt >= MAX_ATTEMPTS) throw err;     // persistent lock: old target intact, visible failure
    const pause = BACKOFF[Math.min(attempt - 1, BACKOFF.length - 1)];
    if (waited + pause <= MAX_TOTAL_WAIT_MS) { syncSleep(pause); waited += pause; }
  }
}

// ── published-history store (independent, persistent, seed-once) (req 4) ────
function readPublishedSeed(seedFile) {
  const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
  const fromPlans = (seed.plans || []).flatMap(p => (p.product_ids || []).map(String));
  const ids = Array.isArray(seed.productIds) && seed.productIds.length
    ? seed.productIds.map(String) : fromPlans;
  return {
    ids,
    plans: (seed.plans || []).map(p => ({ planId: String(p.planId), date: p.date || null })),
    accountId: seed.accountId != null ? String(seed.accountId) : null,
  };
}

// Missing file => first run ever: seed ONCE from the packaged 120-id seed. Any
// other read failure fails closed (never silently reset history to empty).
function loadPublishedStore(file, seedFile, expectedAccountId) {
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') raw = null;
    else throw new Error('published store unreadable (fail-closed): ' + ((e && e.code) || e.message));
  }
  if (raw === null) {
    const seed = seedFile && fs.existsSync(seedFile) ? readPublishedSeed(seedFile) : { ids: [], plans: [], accountId: null };
    // A seed may only seed the EXACT shop it belongs to. An account-scoped
    // expectedAccountId with a foreign / unverifiable seed fails closed instead
    // of importing another shop's published history into this shop.
    if (expectedAccountId != null && seed.ids.length > 0 && String(seed.accountId || '') !== String(expectedAccountId)) {
      throw new Error('published seed account mismatch (fail-closed)');
    }
    return { seeded: true, seededFrom: seedFile || null, publishedIds: [...new Set(seed.ids)], plans: seed.plans };
  }
  let parsed;
  try { parsed = JSON.parse(raw); } catch (e) { throw new Error('published store invalid (fail-closed)'); }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.publishedIds)) {
    throw new Error('published store invalid (fail-closed)');
  }
  return { seeded: false, seededFrom: parsed.seededFrom || null, publishedIds: parsed.publishedIds.map(String), plans: parsed.plans || [] };
}

function appendPublished(store, plan) {
  const ids = [...new Set([...store.publishedIds, ...(plan.productIds || []).map(String)])];
  const plans = [...(store.plans || []), { planId: String(plan.planId), date: plan.date || null }];
  return { seeded: false, seededFrom: store.seededFrom || null, publishedIds: ids, plans };
}

function persistPublished(file, store) { atomicWriteJson(file, store); }

// ── per-business-day cursor state (reset on a new day) (req 4/5) ────────────
function newDayState(businessDate) {
  return {
    businessDate,
    page: 1,
    category: CATEGORY_TAB_ORDER[0],
    lastSelected: [],
    attempted: [],
    cursor: { category: CATEGORY_TAB_ORDER[0], page: 1, seenProductIds: [] },
    hints: {},
    plans: [],
    active: null,
    firstPublishedPlan: null,
    confirmationConsumptions: [],
    manualUiPublicationFacts: [],
  };
}
function loadDayState(file, businessDate) {
  let raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (e) {
    if (e && e.code === 'ENOENT') raw = null;
    else throw new Error('day-state unreadable (fail-closed): ' + ((e && e.code) || e.message));
  }
  if (raw === null) return newDayState(businessDate);
  const p = JSON.parse(raw);
  const unresolved = p && (p.unknown || p.pending === true || p.active && [
    'preparing', 'ready-awaiting-confirmation', 'confirmation-consumed', 'post-publish-enable-check-pending', 'post-publish-enable-stopped',
    'publish-pending', 'publish-finalizing', 'publish-unknown', 'final-confirm-pending', 'final-confirm-unknown',
  ].includes(p.active.status));
  if (p && p.businessDate !== businessDate && unresolved) {
    throw new Error('previous business date has pending/unknown plan state; read-only recovery required before a new run');
  }
  // Same-day continuation keeps page/category/lastSelected/attempted. attempted is a
  // PER-DAY set, never a permanent blacklist (a product that failed today is eligible
  // again on a later day). A NEW business day resets EVERY per-day fact INCLUDING the
  // catalog browse position (page/category/cursor/seenProductIds): the user's explicit
  // 2026-10-27 rule is "每天从第一页找未发布商品", so each new day re-browses from page 1
  // of the first category with an empty seen set. Already-published products stay
  // deduped ONLY by the global published-products store, never by an inherited
  // attempted or seen set.
  if (p && p.businessDate === businessDate) {
    return {
      businessDate,
      page: Number.isInteger(p.page) && p.page >= 1 ? p.page : 1,
      category: CATEGORY_TAB_ORDER.includes(p.category) ? p.category : CATEGORY_TAB_ORDER[0],
      lastSelected: Array.isArray(p.lastSelected) ? p.lastSelected.map(String) : [],
      attempted: Array.isArray(p.attempted) ? p.attempted.map(String) : [],
      cursor: p.cursor && typeof p.cursor === 'object'
        ? { category: CATEGORY_TAB_ORDER.includes(p.cursor.category) ? p.cursor.category : CATEGORY_TAB_ORDER[0], page: Number.isInteger(p.cursor.page) && p.cursor.page >= 1 ? p.cursor.page : 1, seenProductIds: Array.isArray(p.cursor.seenProductIds) ? p.cursor.seenProductIds.map(String) : [] }
        : { category: CATEGORY_TAB_ORDER.includes(p.category) ? p.category : CATEGORY_TAB_ORDER[0], page: Number.isInteger(p.page) && p.page >= 1 ? p.page : 1, seenProductIds: [] },
      hints: p.hints && typeof p.hints === 'object' ? p.hints : {},
      plans: Array.isArray(p.plans) ? p.plans : [],
      active: p.active || null,
      firstPublishedPlan: p.firstPublishedPlan || null,
      confirmationConsumptions: Array.isArray(p.confirmationConsumptions) ? p.confirmationConsumptions : [],
      // S17：手动原生 UI 发布的独立事实必须跨正常 persist 保留（绝不能因一次
      // loadDayState→persistDayState 往返而丢失，否则日计数会被误降、诱发重发）。
      manualUiPublicationFacts: Array.isArray(p.manualUiPublicationFacts) ? p.manualUiPublicationFacts : [],
    };
  }
  // New business day: a completely fresh day state at page 1 of the first category
  // with an empty seen set (user rule 2026-10-27: 每天从第一页找未发布商品). Nothing
  // is inherited from the previous day — dedupe across days is carried solely by the
  // global published-products store.
  return newDayState(businessDate);
}
// Retained for backward compatibility only — loadDayState no longer inherits the
// browse cursor across business days (superseded by the 2026-10-27 user rule above).
// No caller in this module invokes it anymore; it is kept so external scripts that
// imported the helper keep working and the historical behaviour stays auditable.
function inheritBrowseCursor(fresh, prev) {
  const p = prev && typeof prev === 'object' ? prev : null;
  if (!p) return fresh;
  const validPage = v => (Number.isInteger(v) && v >= 1 ? v : 1);
  const validCategory = v => (CATEGORY_TAB_ORDER.includes(v) ? v : CATEGORY_TAB_ORDER[0]);
  fresh.page = validPage(p.page);
  fresh.category = validCategory(p.category);
  const cur = p.cursor && typeof p.cursor === 'object' ? p.cursor : null;
  fresh.cursor = cur
    ? { category: validCategory(cur.category), page: validPage(cur.page), seenProductIds: Array.isArray(cur.seenProductIds) ? cur.seenProductIds.map(String) : [] }
    : { category: fresh.category, page: fresh.page, seenProductIds: [] };
  return fresh;
}
function persistDayState(file, st) { atomicWriteJson(file, st); }
function hasUnresolvedPlan(state) {
  const s = state || {};
  return !!(s.unknown || s.pending === true || s.active && [
    'preparing', 'ready-awaiting-confirmation', 'confirmation-consumed',
    'post-publish-enable-check-pending', 'post-publish-enable-stopped',
    'publish-pending', 'publish-finalizing', 'publish-unknown', 'final-confirm-pending', 'final-confirm-unknown',
  ].includes(s.active.status));
}

// ── product card parsing + hint merge (req 3/8) ─────────────────────────────
function parseProductId(text) {
  const m = /ID[:：\s]*(\d{15,20})/.exec(String(text || ''));
  return m ? m[1] : null;
}
function parseProductCard(card) {
  const text = String((card && card.text) || '');
  const productId = (card && card.id != null && String(card.id) !== '') ? String(card.id) : parseProductId(text);
  return {
    productId,
    text,
    selectable: !(card && card.disabled === true) && !!productId,
    migrationWarning: text.includes(MIGRATION_MARK),
    precheckRisk: text.includes(PRECHECK_MARK), // disclosable, NOT a hard reject
    reviewFailed: text.includes(REVIEW_FAILED_MARK), // explicit hard reject copy
  };
}

// Merge per-ID hints. A card that later stops showing a risk keeps the earlier
// saved hint (history is never erased); flags only ever turn on, text updates.
function mergeCardHints(prev, incoming) {
  const out = { ...(prev || {}) };
  for (const c of incoming || []) {
    if (!c || !c.productId) continue;
    const id = String(c.productId);
    const before = out[id] || { migrationWarning: false, precheckRisk: false, reviewFailed: false, text: '' };
    out[id] = {
      migrationWarning: before.migrationWarning || !!c.migrationWarning,
      precheckRisk: before.precheckRisk || !!c.precheckRisk,
      reviewFailed: before.reviewFailed || !!c.reviewFailed,
      text: c.text || before.text,
    };
  }
  return out;
}

// Deterministic per-page selection step (req 3/4). Skips already-published
// history, per-day attempted failures, and non-selectable cards; fills up to the
// remaining capacity in visible order.
function selectFromPage(state, cards, business) {
  const biz = bizOf(business);
  const selected = [...(state.selectedIds || [])];
  const published = state.publishedSet instanceof Set ? state.publishedSet : new Set((state.publishedSet || []).map(String));
  const attempted = state.attemptedSet instanceof Set ? state.attemptedSet : new Set((state.attemptedSet || []).map(String));
  const capacity = Number.isInteger(state.capacity) ? state.capacity : biz.productsPerPlan;
  let hints = state.hints || {};
  const newlySelected = [];
  for (const raw of cards || []) {
    if (selected.length >= capacity) break;
    const c = raw.productId ? raw : parseProductCard(raw);
    if (!c.productId || !c.selectable) continue;
    const id = String(c.productId);
    hints = mergeCardHints(hints, [c]);
    if (published.has(id) || attempted.has(id) || selected.includes(id)) continue;
    selected.push(id);
    newlySelected.push(id);
  }
  return { selectedIds: selected, hints, newlySelected, full: selected.length >= capacity };
}

// ── creation-header / commission gate (req 2) ───────────────────────────────
function verifyCreationHeader(obs, business) {
  const biz = bizOf(business);
  const o = obs || {};
  if (o.originOk !== true) return { ok: false, reason: 'origin-mismatch' };
  if (String(o.accountId || 'unknown') !== String(biz.accountId)) return { ok: false, reason: 'account-mismatch' };
  if (o.commissionOptionPresent !== true) {
    // The old SPA creation page lacked the 含达人佣金 option; if a freshly opened
    // page still lacks it we KEEP the current page, report, and stop (never guess
    // a switch, never click 联盟自动投 to change the copy, never drop a draft).
    return { ok: false, reason: 'commission-option-missing' };
  }
  return { ok: true, reason: null };
}

// ── account-drawer binding verification (req 6) ─────────────────────────────
function parseAccountDrawer(drawer) {
  const rows = (drawer && drawer.rows) || [];
  const norm = rows.map(r => {
    const text = String(r.text || '');
    const m = /ID[:：\s]*([0-9A-Za-z_]+)/.exec(text);
    return { id: m ? m[1] : null, text, checked: r.checked === true };
  });
  const selMatch = /当前商品已选[:：]\s*(\d+)\s*\/\s*(\d+)/.exec(String((drawer && drawer.text) || ''));
  return {
    rows: norm,
    selectedCount: selMatch ? Number(selMatch[1]) : null,
    capacity: selMatch ? Number(selMatch[2]) : null,
  };
}
function verifyAccountBinding(drawer, capacity, business) {
  const biz = bizOf(business);
  const d = parseAccountDrawer(drawer);
  const ids = d.rows.map(r => r.id).filter(Boolean);
  const targets = approvedTargets(biz);
  // rows may only carry approved target identities: a unique 1..N subset of the
  // configured candidates, never an extra/foreign account (R32 min-1). A generic
  // profile with no configured targets (live-discovery mode) carries the drawer
  // rows themselves as the frozen set, but STILL requires >=1 unique id and NEVER
  // silently inherits the legacy two (fail-closed).
  if (ids.length < 1 || new Set(ids).size !== ids.length
    || (targets ? (ids.length > targets.length || ids.some(i => !targets.includes(i))) : false)) {
    return { ok: false, reason: targets ? 'account-rows-not-target-subset' : 'account-rows-unresolved-no-configured-targets', ids };
  }
  if (!d.rows.every(r => r.checked)) return { ok: false, reason: 'an-account-row-not-checked', ids };
  const cap = Number.isInteger(capacity) ? capacity : biz.productsPerPlan;
  // footer 已选 must equal the checked target count (1 or 2); auto-pull never counts
  if (d.selectedCount !== ids.length) return { ok: false, reason: 'selected-count-not-checked-accounts', selectedCount: d.selectedCount };
  if (d.capacity != null && d.capacity !== cap) return { ok: false, reason: 'capacity-mismatch', capacity: d.capacity };
  return { ok: true, reason: null, checkedAccounts: ids, selectedCount: d.selectedCount, capacity: d.capacity };
}
// Choose an anchor product that already has at least one approved manual account
// bound (1 or 2), so a product whose accounts are momentarily unavailable can
// still be bound by a batch-apply from a valid anchor; the main table remains the
// source of truth.
function chooseAnchorProduct(mainRows) {
  for (const r of mainRows || []) {
    if (r.productId && Number.isInteger(r.manualAccounts) && r.manualAccounts >= 1 && !r.reviewFailed) return String(r.productId);
  }
  return null;
}

// ── main-table parsing + readiness gate + removal/backfill (req 7) ──────────
// Pure availability classification for ONE product/account observation. The only
// proven "already planned / unbindable" evidence is explicit platform copy or a
// definite current-row manual count of 0 with manual evidence. A gray checkbox, an
// empty load, a still-spinning panel, an unauthorized account and any unreadable
// state are 'disabled-unknown'/'unknown' and must STOP — never be deleted as a
// duplicate. `settled` is the caller's own proof that the panel finished loading
// (spinner gone, exact panel set, rows/footer stable); an unsettled observation is
// always unknown regardless of its visible text.
function classifyAvailabilityEvidence(input) {
  const o = input || {};
  const text = String(o.text || '');
  const settled = o.settled !== false;
  if (!settled) return { kind: 'unknown', proven: false, actionable: 'stop', reason: 'panel-not-settled' };
  if (text.includes(ALREADY_PLANNED_MARK)) return { kind: 'already-planned', proven: true, actionable: 'remove-and-continue', reason: 'explicit-already-planned-copy' };
  if (o.reviewFailed === true || text.includes(REVIEW_FAILED_MARK)) return { kind: 'review-failed', proven: true, actionable: 'remove-and-continue', reason: 'explicit-review-failed-copy' };
  if (Number.isInteger(o.manualAccounts) && o.manualAccounts >= 1) return { kind: 'bound', proven: false, actionable: 'keep', reason: 'manual-account-present' };
  if (o.autoPullOnly === true) return { kind: 'unbindable', proven: true, actionable: 'remove-and-continue', reason: 'auto-pull-only-no-manual' };
  if (o.manualEvidence === true && Number.isInteger(o.manualAccounts) && o.manualAccounts < 1) return { kind: 'unbindable', proven: true, actionable: 'remove-and-continue', reason: 'manual-count-zero' };
  if (o.checkboxState === 'disabled') return { kind: 'disabled-unknown', proven: false, actionable: 'stop', reason: 'gray-or-disabled-without-explicit-copy' };
  return { kind: 'unknown', proven: false, actionable: 'stop', reason: 'availability-evidence-unknown' };
}

// The fresh main table is the source of truth for COUNTS, but it cannot show a hover-only
// duplicate tooltip. When a failed bind already proved per-product explicit evidence for
// THIS batch, that evidence is merged onto the matching fresh row — only the explicit
// alreadyPlanned / reviewFailed / autoPullOnly flags and the R130 narrow
// accountUnavailableProven flag (all 30 products proven to have NO usable account),
// never a count, never a foreign id.
// Fresh rows keep their own manualAccounts / manualEvidence, so a good row can never turn
// into a removal just because an old (or another product's) proof existed.
function mergeSettledPanelEvidence(freshRows, evidenceRows) {
  const rows = Array.isArray(freshRows) ? freshRows : [];
  const evidence = new Map((Array.isArray(evidenceRows) ? evidenceRows : [])
    .filter(r => r && r.productId)
    .map(r => [String(r.productId), r]));
  return rows.map(r => {
    const ev = r && r.productId ? evidence.get(String(r.productId)) : null;
    if (!ev) return r;
    const already = ev.alreadyPlanned === true;
    const review = ev.reviewFailed === true;
    const auto = ev.autoPullOnly === true;
    const unavail = ev.accountUnavailableProven === true;
    if (!already && !review && !auto && !unavail) return r;
    const text = String(r.text || '');
    return {
      ...r,
      text: (already && !text.includes(ALREADY_PLANNED_MARK)) ? (text + ' ' + ALREADY_PLANNED_MARK).trim() : text,
      alreadyPlanned: r.alreadyPlanned === true || already,
      reviewFailed: r.reviewFailed === true || review,
      autoPullOnly: r.autoPullOnly === true || auto,
      accountUnavailableProven: r.accountUnavailableProven === true || unavail,
      accountUnavailableEvidence: unavail && ev.accountUnavailableEvidence
        ? ev.accountUnavailableEvidence
        : (r.accountUnavailableEvidence || null),
    };
  });
}

// R131: a replacement batch's own failed rebind may carry the SAME narrow R130 proof — every
// one of the CURRENT batch's 30 products proven to have NO usable account. Only that exact,
// whole-batch, id-matched proof is allowed to re-enter the bounded repair loop and walk forward
// to the next page. It must be per-product accountUnavailableProven for EXACTLY the current
// batch's 30 unique ids: no unknown row, no foreign id, no duplicate id, no drift (a missing or
// extra product), and no merely-unbound/available row. Anything less (29/30, a foreign or
// duplicate id, an available account, an unknown row, or a plain rebind failure with no such
// proof) returns ok:false so the caller keeps its zero-removal account-rebinding stop.
function reboundUnavailableProof(rebound, currentBatchIds, capacity) {
  const rows = (rebound && Array.isArray(rebound.rows)) ? rebound.rows : null;
  if (!rows || !rows.length) return { ok: false, reason: 'rebound-rows-missing' };
  const batchIdSet = new Set((currentBatchIds || []).map(String));
  if (batchIdSet.size !== capacity) return { ok: false, reason: 'current-batch-not-full' };
  const seen = new Set();
  for (const r of rows) {
    if (!r || r.productId == null) return { ok: false, reason: 'rebound-row-unknown' };
    const id = String(r.productId);
    if (seen.has(id)) return { ok: false, reason: 'rebound-row-duplicate' };
    seen.add(id);
    if (!batchIdSet.has(id)) return { ok: false, reason: 'rebound-row-foreign' };
    if (r.accountUnavailableProven !== true) return { ok: false, reason: 'rebound-row-not-proven' };
  }
  if (seen.size !== capacity) return { ok: false, reason: 'rebound-proof-incomplete' };
  return { ok: true, provenIds: [...seen], batchIdSet };
}

// R132: the REAL 2026-10-21 page33→page35 evidence. After an EXACT whole-batch removal of a
// fully proven 30/30 no-usable-account batch, the creation main table is legitimately EMPTY
// for one transition: all 30 proven rows are deleted and the picker may open to backfill from
// the durable next page. Only that single fully-proven transition may treat the known
// 'creation-table-not-unique-or-empty' read with rowCount 0 (and at most one candidate table
// root) as normal; every other empty / not-unique table read — a partial removal, a missing
// forced next page, an incomplete or id-drifted proof, an incomplete deletion, any residual
// row, multiple candidate roots, or an unknown read — stays fail-closed. Pure gate: it changes
// no state and grants nothing by itself; the repair driver must still perform its own proofs.
function wholeBatchRemovalEmptyTableGate(input) {
  const o = input || {};
  const cap = Number.isInteger(o.capacity) ? o.capacity : bizOf(o.business).productsPerPlan;
  const uniq = v => [...new Set((Array.isArray(v) ? v : []).filter(x => x != null).map(String))];
  const proven = uniq(o.provenAccountUnavailableIds);
  const removeIds = uniq(o.removeIds);
  const removedIds = uniq(o.removedIds);
  const table = o.table || {};
  if (o.repairMode !== 'whole-batch-removal') return { allowed: false, reason: 'not-whole-batch-removal' };
  if (o.requireNextPage !== true) return { allowed: false, reason: 'next-page-not-required' };
  if (!(Number.isInteger(cap) && cap > 0)) return { allowed: false, reason: 'capacity-unknown' };
  if (proven.length !== cap || removeIds.length !== cap) return { allowed: false, reason: 'proof-or-removal-set-not-exact-capacity' };
  if (!removeIds.every(id => proven.includes(id))) return { allowed: false, reason: 'removal-set-not-exactly-proven' };
  if (!removeIds.every(id => removedIds.includes(id))) return { allowed: false, reason: 'whole-batch-removal-incomplete' };
  if (table.reason !== 'creation-table-not-unique-or-empty') return { allowed: false, reason: 'not-the-known-empty-table-read' };
  if (table.rowCount !== 0) return { allowed: false, reason: 'table-not-proven-empty' };
  if (!(table.rootCount === 0 || table.rootCount === 1)) return { allowed: false, reason: 'table-root-not-unique' };
  return { allowed: true, reason: 'whole-batch-removal-empty-transition' };
}

function parseMainTableRow(rowText) {
  const text = String(rowText || '');
  const idMatches = [];
  const re = /ID[:：]\s*(\d{15,20})(?!\d)/g;
  let m;
  while ((m = re.exec(text))) idMatches.push(m[1]);
  const uniq = [...new Set(idMatches)];
  const mm = text.match(/(\d+)\s*个抖音号\s*管理(?:手动添加)?抖音号/);
  // Plain-text fallback for the native single-manual layout (no "N个抖音号" counter): the
  // ONLY positive copy is the full adjacency "non-empty name token + non-empty explicit
  // ID token + 管理(手动添加)抖音号" (the real row: "<店铺名> ID：9zmao_fushi 管理手动添加抖音号").
  // A product-ID-shaped token (15-20 digits) can never pose as the account, and a lone
  // manage button / lone name / lone ID stays unknown -- never guessed as manual.
  const singleManual = !mm && /(?:^|\s)\S+\s+ID\s*[:：]\s*(?!\d{15,20}(?:\s|$))\S+\s+管理(?:手动添加)?抖音号(?:\s|$)/.test(text);
  const autoPullOnly = !mm && !singleManual && /预估自动拉取\s*\d+\s*个/.test(text);
  const manualAccounts = mm ? Number(mm[1]) : (singleManual ? 1 : (autoPullOnly ? 0 : null));
  return {
    productId: uniq.length === 1 ? uniq[0] : null,
    ambiguous: uniq.length > 1,
    idCount: uniq.length,
    manualAccounts,
    // BOTH real copies are manual-management evidence: "N个抖音号 管理手动添加抖音号"
    // and "N个抖音号 管理抖音号". Auto-pull-only ("预估自动拉取 N 个" with no manual
    // management phrase) never counts as a manual binding.
    // A visible auto-pull-only counter is known state (zero manual bindings),
    // but it is not manual-binding evidence. Keep it distinct from an unknown
    // parse so the exact deficient row can be repaired without guessing.
    manualEvidence: !!mm || singleManual,
    manualCountKnown: !!mm || singleManual || autoPullOnly,
    autoPullOnly,
    reviewFailed: text.includes(REVIEW_FAILED_MARK),
    alreadyPlanned: text.includes(ALREADY_PLANNED_MARK),
    precheck: text.includes(PRECHECK_MARK),
  };
}

function evaluateReadiness(rows, capacity, business) {
  const biz = bizOf(business);
  const cap = Number.isInteger(capacity) ? capacity : biz.productsPerPlan;
  const parsed = (rows || []).map(r => (r.productId !== undefined ? r : parseMainTableRow(r.text || r)));
  const withId = parsed.filter(r => r.productId);
  const uniqueIds = [...new Set(withId.map(r => String(r.productId)))];
  const deficientIds = withId.filter(r => r.alreadyPlanned === true || r.reviewFailed === true || r.autoPullOnly === true || r.accountUnavailableProven === true || r.manualEvidence !== false && Number.isInteger(r.manualAccounts) && r.manualAccounts < 1).map(r => String(r.productId));
  const unknownManualIds = withId.filter(r => r.alreadyPlanned !== true && !r.reviewFailed && r.autoPullOnly !== true && r.accountUnavailableProven !== true && (r.manualEvidence === false || !Number.isInteger(r.manualAccounts))).map(r => String(r.productId));
  const reviewFailedIds = withId.filter(r => r.reviewFailed).map(r => String(r.productId));
  const alreadyPlannedIds = withId.filter(r => r.alreadyPlanned).map(r => String(r.productId));
  const ambiguousCount = parsed.filter(r => r.ambiguous || r.idCount === 0).length;
  const ready = uniqueIds.length === cap
    && withId.length === cap
    && withId.every(r => r.alreadyPlanned !== true && r.autoPullOnly !== true && r.accountUnavailableProven !== true && r.manualEvidence !== false && Number.isInteger(r.manualAccounts) && r.manualAccounts >= 1 && !r.reviewFailed);
  return {
    ready,
    uniqueCount: uniqueIds.length,
    uniqueIds,
    rowCount: parsed.length,
    deficientIds: [...new Set(deficientIds)],
    unknownManualIds: [...new Set(unknownManualIds)],
    reviewFailedIds: [...new Set(reviewFailedIds)],
    alreadyPlannedIds: [...new Set(alreadyPlannedIds)],
    ambiguousCount,
    capacity: cap,
  };
}

// Remove only rows with CURRENT real-row evidence of being clearly deficient
// (0 manual accounts; R32: 1 or 2 both qualify) or clearly review-failed; an
// unparsable/unknown row is
// NEVER removed on a parse failure. Then backfill from not-yet-attempted catalog
// products until 30 valid, each with at least 1 manual account, or the catalog is
// exhausted. Each candidate is tried at
// most once per day. Only the CURRENT creation local-draft products are removed;
// the workflow never clicks the management page's existing-ad delete.
function planRemovalAndBackfill(input) {
  const biz = bizOf(input.business);
  const capacity = Number.isInteger(input.capacity) ? input.capacity : biz.productsPerPlan;
  const rows = (input.rows || []).map(r => (r.productId !== undefined ? r : parseMainTableRow(r.text || r)));
  const evidenceById = input.evidenceById && typeof input.evidenceById === 'object' ? input.evidenceById : {};
  const classifications = [];
  const removeIds = [];
  const removeReasons = {};
  for (const r of rows) {
    if (!r.productId) continue; // unknown/ambiguous parse => keep, never delete
    const id = String(r.productId);
    const cls = classifyAvailabilityEvidence({ ...r, ...(evidenceById[id] || {}) });
    classifications.push({ productId: id, kind: cls.kind, proven: cls.proven, actionable: cls.actionable, reason: cls.reason });
    if (r.reviewFailed) { removeIds.push(id); removeReasons[id] = 'review-failed'; }
    else if (r.alreadyPlanned) { removeIds.push(id); removeReasons[id] = 'already-planned'; }
    else if (r.accountUnavailableProven === true) { removeIds.push(id); removeReasons[id] = 'account-unavailable-proven'; }
    else if (r.autoPullOnly === true || r.manualEvidence !== false && Number.isInteger(r.manualAccounts) && r.manualAccounts < 1) {
      removeIds.push(id); removeReasons[id] = 'manual-accounts-' + r.manualAccounts;
    }
  }
  const uniqueRemove = [...new Set(removeIds)];
  const unknownIds = rows.filter(r => r.productId && !r.alreadyPlanned && !r.reviewFailed && r.autoPullOnly !== true && r.accountUnavailableProven !== true && (r.manualEvidence === false || !Number.isInteger(r.manualAccounts))).map(r => String(r.productId));
  const currentValid = new Set(rows.filter(r => r.productId && !r.alreadyPlanned && r.manualEvidence !== false && Number.isInteger(r.manualAccounts) && r.manualAccounts >= 1 && !r.reviewFailed && !uniqueRemove.includes(String(r.productId))).map(r => String(r.productId)));
  const need = Math.max(0, capacity - currentValid.size);
  const attempted = input.attemptedSet instanceof Set ? input.attemptedSet : new Set((input.attempted || []).map(String));
  const published = input.publishedSet instanceof Set ? input.publishedSet : new Set((input.published || []).map(String));
  const backfillIds = [];
  for (const id of (unknownIds.length ? [] : (input.catalogRemainingIds || []))) {
    if (backfillIds.length >= need) break;
    const s = String(id);
    if (currentValid.has(s) || attempted.has(s) || published.has(s) || backfillIds.includes(s)) continue;
    backfillIds.push(s);
  }
  // Whole-batch vs partial is derived ONLY from the proven removal set: all 30 proven
  // duplicate/unbindable/review-failed is the real batch case (remove the batch, then
  // continue from the durable forward cursor); a mixed batch removes only the proven
  // bad rows and keeps the good ones. Any unknown row blocks removals entirely (the
  // caller's existing stop) and is reported explicitly, never silently deleted.
  const mode = uniqueRemove.length === 0 ? 'no-removal'
    : (uniqueRemove.length >= capacity ? 'whole-batch-removal' : 'partial-removal');
  return {
    removeIds: uniqueRemove,
    removeReasons,
    backfillIds,
    need,
    mode,
    requireNextPage: uniqueRemove.length > 0,
    blockedUnknownIds: [...new Set(unknownIds)],
    classifications,
    unknownIds: [...new Set(unknownIds)],
    catalogExhausted: backfillIds.length < need,
  };
}

// ── durable cursor forward-proof + post-binding review stability ────────────
// The catalog cursor is durable and shop-scoped (persisted in that shop's day state).
// A cursor may only move FORWARD on real proof: for a numeric category the platform's
// own observed page number must be exactly previous+1; a native scroll category keeps
// its category/tab cursor and NEVER claims a numeric page; a category switch resets to
// page 1. A late guidance/cancel/backfill callback can therefore never rewind the
// cursor or fabricate EOF. EOF is a state, not a timeout.
function advanceCatalogCursor(cursor, proof) {
  const prev = { category: null, page: 1, ...(cursor || {}) };
  const p = proof || {};
  if (p.kind === 'switch') {
    if (!p.category) return { ok: false, reason: 'cursor-switch-category-missing', cursor: prev };
    return { ok: true, cursor: { ...prev, category: String(p.category), page: 1, nativeEof: false } };
  }
  if (p.kind === 'native') {
    if (!p.category || String(p.category) !== String(prev.category)) return { ok: false, reason: 'cursor-native-category-drift', cursor: prev };
    if (p.eofProven === true) return { ok: true, cursor: { ...prev, page: 1, nativeEof: true } };
    if (p.freshDistinctIds !== true) return { ok: false, reason: 'cursor-native-advance-unproven', cursor: prev };
    return { ok: true, cursor: { ...prev, page: 1, nativeEof: false } };
  }
  if (p.kind === 'numeric') {
    const observed = Number(p.observedPage);
    const expected = Number.isInteger(p.expectedPage) ? p.expectedPage : Number(prev.page);
    if (!Number.isInteger(observed) || observed < 1) return { ok: false, reason: 'cursor-page-unknown', cursor: prev };
    if (observed !== expected + 1) return { ok: false, reason: observed <= expected ? 'cursor-not-forward' : 'cursor-page-skipped', cursor: prev };
    return { ok: true, cursor: { ...prev, page: observed, nativeEof: false } };
  }
  return { ok: false, reason: 'cursor-proof-kind-unknown', cursor: prev };
}

// Final fresh gate before any publish: 30 unique rows, each with >=1 manual account,
// no review-failed row, and the exact settings, observed on at least two consecutive
// stable reads. Unknown / not-yet-stable / drifting settings is never ready.
function reviewStabilityContract(input) {
  const o = input || {};
  const cap = Number.isInteger(o.capacity) ? o.capacity : bizOf(o.business).productsPerPlan;
  const readiness = o.readiness && typeof o.readiness === 'object' ? o.readiness : evaluateReadiness(o.rows || [], cap, o.business);
  const reasons = [];
  if (readiness.ready !== true) reasons.push('readiness-not-ready');
  if (readiness.reviewFailedIds && readiness.reviewFailedIds.length) reasons.push('review-failed');
  if (readiness.alreadyPlannedIds && readiness.alreadyPlannedIds.length) reasons.push('already-planned');
  if (!(Number.isInteger(o.stableReads) && o.stableReads >= 2)) reasons.push('rows-not-stable');
  if (o.settingsRequired === true) {
    const s = o.settings || {};
    if (s.accountId == null || String(s.accountId) !== String((o.business || BUSINESS).accountId)) reasons.push('settings-account-unknown');
    if (s.commissionChecked !== true) reasons.push('commission-not-confirmed');
    if (s.optionalDirectPayChecked !== false) reasons.push('direct-pay-not-off');
    if (o.roi != null && Number(s.roi) !== Number(o.roi)) reasons.push('roi-mismatch');
    if (o.dailyBudget != null && Number(s.budget) !== Number(o.dailyBudget)) reasons.push('budget-mismatch');
  }
  return { ready: reasons.length === 0, reasons, readiness };
}

// ── add-confirmation dialog classification (req 8) ──────────────────────────
function classifyAddDialog(text, business) {
  const biz = bizOf(business);
  const t = String(text || '');
  if (!t.trim()) return { kind: 'empty', action: 'none', productIds: [] };
  if (t.includes(AUTO_PULL_MARK)) {
    const ids = [];
    const re = /ID[:：\s]*(\d{15,20})/g;
    let m;
    while ((m = re.exec(t))) ids.push(m[1]);
    // The dialog shows a product column AND an account column; the千川 account id
    // (16 digits) is NOT a product to skip. Drop it so the skip/backfill set is
    // accurate to product ids only.
    const uniq = [...new Set(ids)].filter(id => id !== String(biz.accountId));
    // Must CANCEL this dialog, deselect the identified product ids, and skip +
    // backfill them; never confirm (which would disable an existing plan's
    // auto-pull). If the ids cannot be determined, stop.
    if (uniq.length === 0) return { kind: 'auto-pull', action: 'stop', productIds: [], reason: 'auto-pull-ids-unknown' };
    return { kind: 'auto-pull', action: 'cancel', productIds: uniq };
  }
  if (/确定|确认/.test(t)) return { kind: 'unknown-confirm', action: 'stop', productIds: [] };
  return { kind: 'other', action: 'none', productIds: [] };
}

// ── final mutual-exclusion dialog + semantic button (req 12) ────────────────
function normalizeSpace(s) { return String(s || '').replace(/\s+/g, ''); }
function matchFinalExclusionDialog(text) {
  const norm = normalizeSpace(text);
  const expected = normalizeSpace(FINAL_EXCLUSION_TEXT);
  return { known: norm === expected, exact: norm === expected };
}
// getByText('确认发布') returns a SPAN today; its closest BUTTON is the real
// semantic button. Resolve the button, never the span, so a span-guard failure
// is not mis-recorded as "already clicked".
function resolveFinalPublishButton(getByTextResult) {
  const r = getByTextResult || {};
  if (r.tag === 'BUTTON') return { ok: true, target: 'button', via: 'direct-button' };
  if (r.closestButton === true) return { ok: true, target: 'button', via: 'span-closest-button' };
  return { ok: false, reason: 'semantic-button-not-resolved' };
}

// ── confirmation freeze / nonce / manifest hash (req 10/11) ─────────────────
function canonicalManifest(plan) {
  return JSON.stringify({
    planNumber: plan.planNumber,
    runId: String(plan.runId),
    businessDate: plan.businessDate,
    accountId: String(plan.accountId),
    planName: String(plan.planName || ''),
    roi: plan.roi,
    dailyBudget: plan.dailyBudget,
    commissionIncluded: plan.commissionIncluded === true,
    directPay: plan.directPay === true,
    boundAccounts: [...(plan.boundAccounts || [])].map(String).slice().sort(),
    productIds: (plan.productIds || []).map(String), // exact frozen order
    disclosures: {
      migration: [...((plan.disclosures && plan.disclosures.migration) || [])].map(String).sort(),
      precheck: [...((plan.disclosures && plan.disclosures.precheck) || [])].map(String).sort(),
      reviewFailed: [...((plan.disclosures && plan.disclosures.reviewFailed) || [])].map(String).sort(),
    },
  });
}
function manifestHash(plan) {
  return crypto.createHash('sha256').update(canonicalManifest(plan)).digest('hex');
}
function makeNonce() { return crypto.randomBytes(16).toString('hex'); }

// ── S17 手动原生 UI preflight receipt：纯校验 + 证据 hash ─────────────────────
// receipt 是 Root 操作者在原生页面现场核对出的完整前置事实：店/账户/业务日/本 run
// /第一份/计划名/30 个唯一商品（每项手动绑定账号数 >=1）/ROI/预算/含佣金/直投 Off。
// 这里只做**纯**结构对齐（口径与既有 profile 一致），不读页面、不写文件。
function canonicalManualUiReceipt(receipt) {
  const r = receipt || {};
  const goods = (r.goods || []).map(g => ({ id: String((g && g.id) == null ? '' : g.id), manualAccounts: Number(g && g.manualAccounts) }));
  return JSON.stringify({
    shop: String(r.shop || ''),
    accountId: String(r.accountId == null ? '' : r.accountId),
    businessDate: String(r.businessDate || ''),
    runId: String(r.runId || ''),
    planNumber: Number(r.planNumber),
    planName: String(r.planName || ''),
    roi: Number(r.roi),
    dailyBudget: Number(r.dailyBudget),
    commissionIncluded: r.commissionIncluded === true,
    directPay: r.directPay === true,
    goods,
  });
}
function manualUiReceiptHash(receipt) {
  return crypto.createHash('sha256').update(canonicalManualUiReceipt(receipt)).digest('hex');
}
// 严格合同校验：任何缺失/漂移都返回 { ok:false, reason }，调用方据此保持原 preparing、
// 零未来点击、零记录消费、零导入。
function validateManualUiReceipt(receipt, business) {
  const biz = bizOf(business);
  const r = receipt || {};
  const deny = reason => ({ ok: false, reason });
  if (!r || typeof r !== 'object' || Array.isArray(r)) return deny('receipt-missing');
  if (String(r.shop || '') !== String(biz.shop)) return deny('shop-mismatch');
  if (r.accountId == null || String(r.accountId) !== String(biz.accountId)) return deny('account-mismatch');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.businessDate || ''))) return deny('business-date-invalid');
  const runMatch = MANUAL_RUN_ORIGIN_RE.exec(String(r.runId || ''));
  if (!runMatch) return deny('run-id-not-manual-origin');
  if (runMatch[1] !== String(r.businessDate)) return deny('run-id-date-mismatch');
  if (Number(r.planNumber) !== 1) return deny('plan-number-not-1');
  if (!r.planName || typeof r.planName !== 'string') return deny('plan-name-missing');
  if (!Array.isArray(r.goods)) return deny('goods-missing');
  const perPlan = Number.isInteger(biz.productsPerPlan) ? biz.productsPerPlan : 30;
  if (r.goods.length !== perPlan) return deny('goods-count-not-' + perPlan);
  const ids = [];
  for (const g of r.goods) {
    if (!g || typeof g !== 'object') return deny('goods-entry-invalid');
    const id = String(g.id == null ? '' : g.id);
    if (!/^\d{15,20}$/.test(id)) return deny('goods-id-invalid');
    if (!Number.isInteger(Number(g.manualAccounts)) || Number(g.manualAccounts) < 1) return deny('goods-manual-accounts-below-1');
    ids.push(id);
  }
  if (new Set(ids).size !== ids.length) return deny('goods-ids-not-unique');
  if (r.productIds != null) {
    const pids = (Array.isArray(r.productIds) ? r.productIds : []).map(String);
    if (pids.length !== perPlan || new Set(pids).size !== perPlan) return deny('product-ids-not-' + perPlan + '-unique');
    if (JSON.stringify([...pids].sort()) !== JSON.stringify([...ids].sort())) return deny('product-ids-goods-mismatch');
  }
  if (!(Number(r.roi) > 0) || Number(r.roi) !== Number(biz.roi)) return deny('roi-mismatch');
  if (Number(r.dailyBudget) !== Number(biz.dailyBudget)) return deny('daily-budget-mismatch');
  if (r.commissionIncluded !== true) return deny('commission-not-included');
  if (r.directPay !== false) return deny('direct-pay-not-off');
  return { ok: true, reason: null, productIds: ids, perPlan };
}
// 由已验证 receipt + 现场观察到的 planId 构造一条独立事实（不含任何伪造的
// manifestHash / nonce / 消费痕迹），保留原 preparing 相位的 reason / runId 证据。
function buildManualUiPublicationFact(input) {
  const i = input || {};
  return {
    status: 'published-success',
    source: MANUAL_UI_SOURCE,
    planNumber: 1,
    planId: String(i.planId),
    planName: String(i.planName || ''),
    businessDate: String(i.businessDate),
    runId: String(i.runId),
    accountId: String(i.accountId),
    receiptHash: String(i.receiptHash),
    authorizationSource: String(i.authorizationSource || ''),
    productIds: (i.productIds || []).map(String),
    originalPhase: 'preparing',
    originalReason: i.originalReason == null ? null : String(i.originalReason),
    observedAt: new Date(i.nowMs === undefined ? Date.now() : i.nowMs).toISOString(),
  };
}

// Freeze a prepared plan into the confirmation artifact shown to the human. The
// frozen manifest hash binds the exact 30 ids + params + plan number + run + date.
function freezePlan(prepared, opts) {
  const o = opts || {};
  const biz = bizOf(o.business);
  const businessDate = prepared.businessDate || shanghaiDate(o.nowMs);
  const plan = {
    planNumber: prepared.planNumber,
    runId: prepared.runId,
    businessDate,
    accountId: String(prepared.accountId || biz.accountId),
    roi: prepared.roi != null ? prepared.roi : biz.roi,
    dailyBudget: prepared.dailyBudget != null ? prepared.dailyBudget : biz.dailyBudget,
    commissionIncluded: prepared.commissionIncluded == null ? biz.commissionIncluded !== false : prepared.commissionIncluded !== false,
    directPay: prepared.directPay == null ? biz.directPay === true : prepared.directPay === true,
    boundAccounts: prepared.boundAccounts || biz.boundAccounts,
    productIds: (prepared.productIds || []).map(String),
    planName: prepared.planName || null,
    disclosures: prepared.disclosures || { migration: [], precheck: [], reviewFailed: [] },
  };
  const hash = manifestHash(plan);
  return {
    ...plan,
    manifestHash: hash,
    nonce: o.nonce || makeNonce(),
    confirmationId: o.confirmationId || ('conf-' + hash.slice(0, 16) + '-' + (o.nonce ? String(o.nonce).slice(0, 8) : makeNonce().slice(0, 8))),
    disclosures: prepared.disclosures || { migration: [], precheck: [], reviewFailed: [] },
    frozenAt: new Date(o.nowMs === undefined ? Date.now() : o.nowMs).toISOString(),
  };
}

// Validate a human confirmation request against the frozen artifact. ONLY an
// explicit POST carrying the exact action text + matching nonce + matching plan
// number + matching business date (still today) + matching manifest hash +
// accepted disclosures authorizes publication. GET/refresh, repeat POST (already
// consumed), wrong nonce, another plan, an old date, or a drifted manifest all
// produce ZERO clicks. There is no unattended auto-confirm path.
function validateConfirmation(frozen, request, opts) {
  const o = opts || {};
  const biz = bizOf(o.business);
  const req = request || {};
  const expectedBound = approvedTargets(biz);
  const deny = reason => ({ authorized: false, reason });
  if (String(req.method || '').toUpperCase() !== 'POST') return deny('not-a-post');
  if (req.action !== '确认发布本计划') return deny('action-text-mismatch');
  if (!frozen || !frozen.nonce || req.nonce !== frozen.nonce) return deny('nonce-mismatch');
  if (!Number.isInteger(frozen.planNumber) || frozen.planNumber < 1 || frozen.planNumber > effectivePlanLimit(biz)) return deny('plan-number-invalid');
  if (!frozen.runId || !frozen.planName || !frozen.confirmationId) return deny('frozen-identity-incomplete');
  if (String(frozen.accountId) !== String(biz.accountId)
    || !(Number(frozen.roi) > 0) || Number(frozen.roi) !== Number(biz.roi) || Number(frozen.dailyBudget) !== Number(biz.dailyBudget)
    || frozen.commissionIncluded !== true || frozen.directPay !== false
    || !Array.isArray(frozen.boundAccounts) || frozen.boundAccounts.length < 1
    || (expectedBound && JSON.stringify([...(frozen.boundAccounts || [])].map(String).sort()) !== JSON.stringify(expectedBound.map(String).sort()))
    || (frozen.productIds || []).length !== biz.productsPerPlan
    || new Set((frozen.productIds || []).map(String)).size !== biz.productsPerPlan) return deny('frozen-manifest-invalid');
  if (Number(req.planNumber) !== Number(frozen.planNumber)) return deny('plan-number-mismatch');
  if (req.manifestHash !== frozen.manifestHash || manifestHash(frozen) !== frozen.manifestHash) return deny('manifest-drift');
  if (req.businessDate !== frozen.businessDate) return deny('business-date-mismatch');
  const today = shanghaiDate(o.nowMs);
  if (frozen.businessDate !== today) return deny('stale-date-not-today');
  if (req.acceptedDisclosures !== true) return deny('disclosures-not-accepted');
  const consumed = o.consumed instanceof Set ? o.consumed : new Set(o.consumed || []);
  if (consumed.has(frozen.confirmationId)) return deny('confirmation-already-consumed');
  return {
    authorized: true, reason: null,
    authorization: {
      runId: frozen.runId,
      accountId: frozen.accountId,
      planName: frozen.planName,
      confirmationId: frozen.confirmationId,
      manifestHash: frozen.manifestHash,
      businessDate: frozen.businessDate,
      planNumber: frozen.planNumber,
      productIds: frozen.productIds.slice(),
      boundAccounts: frozen.boundAccounts.slice(),
      roi: frozen.roi, dailyBudget: frozen.dailyBudget, commissionIncluded: true,
      directPay: frozen.directPay,
    },
  };
}

// ── publish result readback (req 13) ────────────────────────────────────────
// A publish CLICK is never business success. Wait for the management page under
// the exact account, switch to 商品自选, find the unique row by the exact plan
// name, and read back the real plan id / 30 products / 1-2 manual accounts / ROI15 /
// budget300 / commission / status. A timeout ALONE is 'unknown' (the redirect can
// take several seconds), never 'failed'; unknown is read-only, no auto re-submit.
function classifyPublishOutcome(readback, expected) {
  const rb = readback || {};
  const exp = expected || {};
  if (rb.found !== true) {
    return { outcome: 'unknown', reason: rb.reason || 'plan-row-not-found-yet', planId: null };
  }
  if (exp.planName && rb.planName !== exp.planName) {
    return { outcome: 'unknown', reason: 'plan-name-mismatch', planId: rb.planId || null };
  }
  if (rb.uniqueRow !== true) return { outcome: 'unknown', reason: 'plan-row-not-unique', planId: rb.planId || null };
  if (exp.accountId && String(rb.accountId || '') !== String(exp.accountId)) return { outcome: 'unknown', reason: 'account-identity-mismatch', planId: String(rb.planId) };
  if ((exp.existingPlanIds || []).map(String).includes(String(rb.planId))) return { outcome: 'unknown', reason: 'plan-id-not-new', planId: String(rb.planId) };
  const expProductCount = exp.productsPerPlan != null ? Number(exp.productsPerPlan) : 30;
  const expRoi = exp.roi != null ? Number(exp.roi) : 15;
  const expBudget = exp.dailyBudget != null ? Number(exp.dailyBudget) : 300;
  const failures = [];
  if (rb.productCount !== expProductCount) failures.push('productCount=' + rb.productCount);
  // R32: a plan row carries at least one of the approved manual targets;
  // 0 / >2 / non-integer readback is a field mismatch, never a success.
  // The platform may expose more than two real Douyin accounts. Publication is
  // valid when the readback proves a bounded non-empty set; the binding flow
  // independently proves the exact account identities and checked count.
  if (!Number.isInteger(rb.accountCount) || rb.accountCount < 1 || rb.accountCount > 10) failures.push('accountCount=' + rb.accountCount);
  if (Number(rb.roi) !== expRoi) failures.push('roi=' + rb.roi);
  if (Number(rb.dailyBudget) !== expBudget) failures.push('budget=' + rb.dailyBudget);
  if (rb.commissionIncluded !== true) failures.push('commission=' + rb.commissionIncluded);
  const FAILED_STATUS = ['已拒绝', '已终止', '已删除', '创建失败', '发布失败'];
  const LIVE_STATUS = ['投放中', '审核中', '预算不足'];
  if (rb.status && FAILED_STATUS.includes(rb.status)) {
    return { outcome: 'failed', reason: 'status=' + rb.status, planId: rb.planId || null };
  }
  if (!/^\d{12,20}$/.test(String(rb.planId || ''))) return { outcome: 'unknown', reason: 'plan-id-missing-or-invalid', planId: null };
  if (failures.length > 0) {
    return { outcome: 'unknown', reason: 'field-mismatch:' + failures.join(','), planId: rb.planId || null };
  }
  if (!rb.status || !LIVE_STATUS.includes(rb.status)) {
    return { outcome: 'unknown', reason: 'status-unrecognized:' + (rb.status || 'none'), planId: rb.planId || null };
  }
  return { outcome: 'success', reason: null, planId: rb.planId ? String(rb.planId) : null, status: rb.status };
}

// ── post-publish enable check (req 14) ──────────────────────────────────────
// Read the shop's real current state first. If already enabled => ZERO action. If
// genuinely paused, reuse the EXISTING locked daily-enable capability via an
// injected hook whose lock contract is explicit; if no verified same-shop locked
// entry is available, STOP at 'needs-existing-enable-capability' and report the
// gap. Never bypass the monitor in-flight lock, never rewrite the enable
// algorithm / locking / forced / cost-ratio rules, never clear the daily dedup,
// and never claim already_done_today means "enabled".
function planPostPublishEnable(currentState, deps) {
  const cs = currentState || {};
  const d = deps || {};
  if (cs.enabled === true) return { action: 'none', status: 'already-enabled' };
  if (cs.enabled === null || cs.enabled === undefined || cs.readOk !== true) {
    return { action: 'stop', status: 'unknown-current-state', reason: cs.reason || 'read-current-state-failed' };
  }
  // cs.enabled === false => genuinely paused
  const hook = d.enableHook;
  if (hook && hook.lockContractVerified === true && typeof hook.run === 'function') {
    return { action: 'delegate', status: 'delegated-to-existing-locked-enable', via: hook.name || 'locked-enable-hook' };
  }
  return {
    action: 'stop',
    status: 'needs-existing-enable-capability',
    gap: '未验证的同店受锁正常开启入口：不绕过监控在途锁、不改锁定/forced/费比规则、不清每日去重、不声称自动开启全闭环',
  };
}

// ── S65 preparation diagnostics: whitelist sanitizers (fail-closed to null; unknown fields dropped) ──
// These helpers never invent values; they only copy through what the real driver already returned,
// after field-level whitelisting. Any unexpected / secret-shaped field is dropped to null. The full
// driver object, row text, accounts, IDs, URLs, cookies and paths are never propagated.
const SETTINGS_NUMBER_RE = /^\d+(?:\.\d{1,4})?$/;
const SETTINGS_PLAN_NAME_RE = /^[\u3400-\u4DBF\u4E00-\u9FFF0-9_:.\-]{1,48}$/;
function sanitizeSettingsScalar(value, kind) {
  if (value === null || value === undefined) return null;
  if (kind === 'number') {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.length <= 16 && SETTINGS_NUMBER_RE.test(value)) return value;
    return null;
  }
  if (kind === 'bool') return value === true || value === false ? value : null;
  if (kind === 'planName') {
    if (typeof value !== 'string' || value.length === 0 || value.length > 48) return null;
    return SETTINGS_PLAN_NAME_RE.test(value) ? value : null;
  }
  return null;
}
function sanitizeSettingsSide(side) {
  if (!side || typeof side !== 'object') return null;
  return {
    roi: sanitizeSettingsScalar(side.roi, 'number'),
    budget: sanitizeSettingsScalar(side.budget, 'number'),
    commissionChecked: sanitizeSettingsScalar(side.commissionChecked, 'bool'),
    optionalDirectPayChecked: sanitizeSettingsScalar(side.optionalDirectPayChecked, 'bool'),
    planName: sanitizeSettingsScalar(side.planName, 'planName'),
  };
}
function sanitizeSettingsDiagnostic(expected, observed) {
  const e = sanitizeSettingsSide(expected), o = sanitizeSettingsSide(observed);
  if (!e && !o) return null;
  return { expected: e, observed: o };
}
const BINDING_DIAG_PHASE_ENUM = new Set([
  'initial-auto-drawer', 'reopened-anchor', 'panel-candidate', 'pre-header',
  'panel-navigation', 'before-header', 'discovery-union',
]);
function sanitizeBindingDiagnostic(diag) {
  if (!diag || typeof diag !== 'object') return null;
  const numOr = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const phase = typeof diag.phase === 'string' && BINDING_DIAG_PHASE_ENUM.has(diag.phase) ? diag.phase : null;
  const result = {
    phase,
    rowCount: numOr(diag.rowCount),
    knownCheckedCount: numOr(diag.knownCheckedCount),
    unknownStateCount: numOr(diag.unknownStateCount),
    selectedCount: numOr(diag.selectedCount),
    totalCount: numOr(diag.totalCount),
  };
  for (const key of ['expectedSelectedCount', 'expectedTotalCount', 'spinnerCount', 'panelCount', 'expectedPanelCount', 'activeCount', 'malformedIdCount']) {
    if (Object.prototype.hasOwnProperty.call(diag, key)) result[key] = numOr(diag[key]);
  }
  for (const key of ['panelSetExactMatch', 'activeTargetMatch', 'uniqueRowCount', 'footerMatchesChecked']) {
    if (Object.prototype.hasOwnProperty.call(diag, key)) result[key] = sanitizeSettingsScalar(diag[key], 'bool');
  }
  return result;
}
function readinessSummary(readiness, phase, round) {
  if (!readiness || typeof readiness !== 'object') return null;
  const numOr = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const arrLen = v => (Array.isArray(v) ? v.length : null);
  return {
    phase: typeof phase === 'string' ? phase.slice(0, 24) : null,
    round: numOr(round),
    rowCount: numOr(readiness.rowCount),
    uniqueCount: numOr(readiness.uniqueCount),
    deficientCount: arrLen(readiness.deficientIds),
    unknownManualCount: arrLen(readiness.unknownManualIds),
    reviewFailedCount: arrLen(readiness.reviewFailedIds),
    ambiguousCount: numOr(readiness.ambiguousCount),
    capacity: numOr(readiness.capacity),
    ready: readiness.ready === true,
  };
}
// Callback errors are CAUGHT here — a diagnostic callback must never alter business behavior.
// Hard cap 31 per plan (existing round cap 30 → initial + 30 emissions max).
function makePreparationEmitter(cb) {
  if (typeof cb !== 'function') return () => {};
  let count = 0;
  return (readiness, phase, round) => {
    if (count >= 31) return;
    const summary = readinessSummary(readiness, phase, round);
    if (!summary) return;
    count++;
    try { cb(summary); } catch (_) { /* swallow: diagnostics must never leak failure into flow */ }
  };
}

// ── high-level orchestration (DI; prepared => ready-awaiting-confirmation) ──
// preparePlan NEVER publishes. It assembles the frozen manifest and stops at
// 'ready-awaiting-confirmation'. publishConfirmedPlan requires a validated
// one-shot confirmation and delegates the real click + durable consumption to the
// R9 guard's runPublishPlan (persist-before-click), then handles the final
// mutual-exclusion dialog and the management-page readback.
async function preparePlan(deps) {
  const d = deps || {};
  const biz = bizOf(d.business);
  const businessDate = d.businessDate || shanghaiDate(d.nowMs);
  const dayState = d.dayState || newDayState(businessDate);
  if (d.requireRealDrivers === true) {
    const required = ['openCreationPage', 'browseProducts', 'bindAccountsToAll', 'readMainTable', 'repairDraft', 'configurePlan', 'persistState'];
    const missing = required.filter(k => typeof d[k] !== 'function');
    if (missing.length) return { status: 'stopped', stage: 'driver-contract', reason: 'missing-real-driver:' + missing.join(','), businessDate };
    if (hasUnresolvedPlan(dayState)) return { status: 'stopped', stage: 'state-recovery', reason: 'pending-or-unknown-plan-requires-read-only-recovery', businessDate };
  }
  const publishedSet = d.publishedSet instanceof Set ? d.publishedSet : new Set((d.publishedIds || []).map(String));
  const attemptedSet = new Set((dayState.attempted || []).map(String));
  const emitReadiness = makePreparationEmitter(d.onPreparationDiagnostic);
  let workingState = { ...dayState, attempted: [...(dayState.attempted || [])], lastSelected: [...(dayState.lastSelected || [])], hints: { ...(dayState.hints || {}) } };
  const persistState = typeof d.persistState === 'function' ? d.persistState : async () => {};
  workingState.active = { status: 'preparing', planNumber: d.planNumber || null, runId: d.runId || null, businessDate };
  await persistState(workingState);
  const saveProgress = async patch => {
    workingState = { ...workingState, ...patch };
    await persistState(workingState);
  };

  // 1) open a fresh page in the verified context at the known creation URL and
  //    prove the real header account + the commission option before selecting.
  const creation = await d.openCreationPage({ url: biz.creationUrl });
  const header = verifyCreationHeader(creation.header, biz);
  if (!header.ok) {
    // Keep the current page, report, and stop; do not guess a switch or drop a draft.
    return { status: 'stopped', stage: 'creation-header', reason: header.reason, businessDate };
  }

  // 2) deterministic selection across category tabs / pages up to 30 unique valid
  //    products, honoring published history + per-day attempted set + same-day cursor.
  let selected = [...(workingState.lastSelected || [])];
  let hints = { ...(workingState.hints || {}) };
  let browse = null;
  if (typeof d.browseProducts === 'function') {
    browse = await d.browseProducts({
      selectedIds: selected, hints, publishedSet, attemptedSet,
      cursor: workingState.cursor || { category: workingState.category || CATEGORY_TAB_ORDER[0], page: workingState.page || 1 },
      needed: biz.productsPerPlan - selected.length,
      categories: d.categoryOrder || CATEGORY_TAB_ORDER,
      onProgress: saveProgress,
    });
    if (!browse || browse.ok !== true) {
      return { status: 'stopped', stage: 'selection', reason: (browse && browse.reason) || 'real-selection-not-confirmed', selected: browse && browse.selectedIds || selected, businessDate };
    }
    selected = (browse.selectedIds || []).map(String);
    hints = browse.hints || hints;
    workingState = { ...workingState, lastSelected: selected, hints, attempted: [...new Set([...(workingState.attempted || []), ...(browse.attempted || [])])], cursor: browse.cursor || workingState.cursor };
    await persistState(workingState);
  } else {
    let capacity = biz.productsPerPlan - selected.length;
    const categories = d.categoryOrder || CATEGORY_TAB_ORDER;
    outer:
    for (const category of categories) {
      let page = dayState.page || 1;
      for (;;) {
        const cards = await d.readPageCards({ category, page });
        const step = selectFromPage(
          { selectedIds: selected, hints, publishedSet, attemptedSet, capacity: biz.productsPerPlan },
          cards,
        );
        selected = step.selectedIds; hints = step.hints;
        capacity = biz.productsPerPlan - selected.length;
        if (step.full) break outer;
        const adv = await d.goNextPage({ category, page });
        if (!adv || adv.confirmed !== true) break;
        if (adv.observedPage != null && adv.observedPage <= page) break;
        page = adv.observedPage;
      }
    }
  }
  if (selected.length < biz.productsPerPlan) {
    return { status: 'stopped', stage: 'selection-incomplete', reason: 'catalog-exhausted', selected, businessDate };
  }

  // 3) bind the approved target accounts to every product (header select-all once
  //    + batch apply), then read the main table and remove/backfill until 30 valid,
  //    each with at least 1 manually bound target account (R32; 2 is also fine).
  const binding = await d.bindAccountsToAll({ productIds: selected });
  // Account binding and plan configuration are both followed by a bounded PASSIVE read
  // of the CURRENT 30 rows: the platform can raise 广告审核不通过 a few seconds after the
  // first ready read. When the real driver exposes awaitMainTableStable the contract
  // uses its stable rows ONLY when the read itself proved stability (ok===true); a
  // timed-out / unproven read never donates its partial rows as ready. Otherwise the
  // plain read is used exactly as before.
  const readRows = async () => {
    if (typeof d.awaitMainTableStable === 'function') {
      const stable = await d.awaitMainTableStable({ capacity: biz.productsPerPlan });
      if (!stable || stable.ok !== true) {
        return { ok: false, reason: (stable && stable.reason) || 'main-table-not-stable', rows: [], stableReads: stable && stable.stableReads };
      }
      return { ok: true, rows: Array.isArray(stable.rows) ? stable.rows : [], stableReads: stable.stableReads };
    }
    return { ok: true, rows: await d.readMainTable(), stableReads: null };
  };
  let bindingFailedIds = (binding && Array.isArray(binding.failedIds)) ? binding.failedIds.map(String) : [];
  const bindingRows = (binding && Array.isArray(binding.rows)) ? binding.rows : null;
  const batchIdSet = new Set(selected.map(String));
  // Explicit per-product proofs that are allowed to survive into repair: only alreadyPlanned
  // flags (explicit platform copy / settled hover tooltip) for THIS batch's exact ids.
  const duplicateIdsOf = rows => [...new Set((Array.isArray(rows) ? rows : [])
    .filter(r => r && r.alreadyPlanned === true && batchIdSet.has(String(r.productId)))
    .map(r => String(r.productId)))];
  // R130: the narrow "no usable account" proof ids for THIS batch's exact selection.
  const accountUnavailableIdsOf = rows => [...new Set((Array.isArray(rows) ? rows : [])
    .filter(r => r && r.accountUnavailableProven === true && batchIdSet.has(String(r.productId)))
    .map(r => String(r.productId)))];
  let provenDuplicateIds = [];
  let provenAccountUnavailableIds = [];
  let mainRows;
  if (d.requireRealDrivers === true && (!binding || binding.ok !== true)) {
    // A failed bind is NOT automatically a stop any more: when the binder itself returns
    // the REAL current rows, or the main table can be read, a WHOLE batch whose every row
    // carries explicit platform evidence (already planned / review failed / definite zero
    // manual) is exactly the incident's whole-batch repair case. Anything less than a fully
    // proven batch (a missing row, an unknown manual state, a gray checkbox, a partial set)
    // keeps the original zero-removal stop.
    let candidates = null;
    if (typeof d.awaitMainTableStable === 'function') {
      const rr = await readRows();
      if (!rr.ok) {
        return { status: 'stopped', stage: 'stable-read', reason: 'binding-failure-' + rr.reason, businessDate };
      }
      candidates = rr.rows;
    } else {
      candidates = bindingRows && bindingRows.length ? bindingRows : (await readRows()).rows;
    }
    // A stable fresh read must not silently DROP the binder's explicit per-product proof
    // (that is how a hover-proven duplicate batch used to fall back to "unknown"). Merge
    // only the explicit flags, keyed by the exact id, and only for this batch's selection.
    if (candidates && bindingRows && bindingRows.length) {
      const batchIds = new Set(selected.map(String));
      candidates = mergeSettledPanelEvidence(candidates, bindingRows.filter(r => r && batchIds.has(String(r.productId))));
    }
    const readback = candidates && candidates.length ? evaluateReadiness(candidates, biz.productsPerPlan, biz) : null;
    const proof = candidates && candidates.length
      ? planRemovalAndBackfill({ rows: candidates, capacity: biz.productsPerPlan, attemptedSet, publishedSet, catalogRemainingIds: d.catalogRemainingIds || [] })
      : null;
    // R130: the narrow "no usable account" channel only opens when EVERY one of this
    // batch's 30 candidates carries the binder's per-product proof (29/30 keeps the
    // original zero-removal stop). It never masquerades as alreadyPlanned/duplicate.
    const unavailProvenAll = !!candidates && candidates.length === biz.productsPerPlan
      && candidates.every(r => r && r.accountUnavailableProven === true);
    const allProven = !!proof
      && candidates.length === biz.productsPerPlan
      && readback.uniqueCount === biz.productsPerPlan
      && readback.unknownManualIds.length === 0
      && readback.ambiguousCount === 0
      && proof.blockedUnknownIds.length === 0
      && proof.removeIds.length === biz.productsPerPlan
      // A whole batch is only replaceable on EXPLICIT per-product platform copy
      // (already planned / review failed / auto-pull-only) or on the R130 proof that
      // all 30 have no usable account. A gray checkbox or a
      // merely-unbound row (manual 0 before any bind) is NEVER such proof.
      && (unavailProvenAll || candidates.every(r => r.alreadyPlanned === true || r.reviewFailed === true || r.autoPullOnly === true));
    if (!allProven) {
      const bindingDiag = sanitizeBindingDiagnostic(binding && binding.diag);
      return {
        status: 'stopped', stage: 'account-binding',
        reason: (binding && binding.reason) || 'native-binding-not-confirmed',
        bindingDiag, bindingEvidence: { proven: false, rowCount: candidates ? candidates.length : 0, removable: proof ? proof.removeIds.length : 0, unknown: readback ? readback.unknownManualIds.length : null },
        businessDate,
      };
    }
    bindingFailedIds = proof.removeIds.slice();
    mainRows = candidates;
  } else {
    const rr = await readRows();
    if (!rr.ok) {
      return { status: 'stopped', stage: 'stable-read', reason: 'pre-configuration-' + rr.reason, businessDate };
    }
    mainRows = rr.rows;
  }
  provenDuplicateIds = duplicateIdsOf(mainRows);
  provenAccountUnavailableIds = accountUnavailableIdsOf(mainRows);
  hints = mergeCardHints(hints, mainRows.map(r => ({
    productId: r.productId, text: r.text || '', migrationWarning: r.migrationWarning,
    precheckRisk: r.precheckRisk || r.precheck, reviewFailed: r.reviewFailed,
  })));
  workingState = { ...workingState, hints };
  await persistState(workingState);
  let readiness = evaluateReadiness(mainRows, biz.productsPerPlan);
  emitReadiness(readiness, 'initial', 0);
  let finalRows = mainRows;
  for (let round = 0; !readiness.ready && round < biz.productsPerPlan; round++) {
    if (readiness.unknownManualIds.length) {
      return { status: 'stopped', stage: 'readiness', reason: 'manual-binding-evidence-unknown-no-removal', readiness, businessDate };
    }
    const plan = planRemovalAndBackfill({
      rows: mainRows, capacity: biz.productsPerPlan,
      attemptedSet, publishedSet, catalogRemainingIds: d.catalogRemainingIds || [],
    });
    if (!plan.removeIds.length) {
      return { status: 'stopped', stage: 'readiness', reason: plan.catalogExhausted ? 'catalog-exhausted-no-safe-repair' : 'no-current-row-evidence-for-removal', readiness, plan, businessDate };
    }
    const repaired = await d.repairDraft({
      removeIds: plan.removeIds,
      backfillIds: plan.backfillIds,
      backfillCount: plan.need,
      rows: mainRows,
      state: workingState,
      publishedSet,
      attemptedSet,
      hints,
      // Bind-failure information and the ACTUAL main rows enter the prepare/repair
      // contract. The repair driver may use them only as provenance (attempted /
      // diagnostics); removal still requires explicit current-row evidence, so an
      // unknown/failed binder message can never delete a good product.
      failedIds: bindingFailedIds,
      bindingRows: bindingRows || mainRows,
      provenDuplicateIds,
      provenAccountUnavailableIds,
      repairMode: plan.mode,
      requireNextPage: plan.requireNextPage,
      onProgress: saveProgress,
    });
    if (!repaired || repaired.ok === false) {
      return { status: 'stopped', stage: 'repair', reason: (repaired && repaired.reason) || 'repair-not-confirmed', readiness, plan, businessDate };
    }
    if (Array.isArray(repaired.mainRows)) finalRows = repaired.mainRows;
    else {
      const rr = await readRows();
      if (!rr.ok) return { status: 'stopped', stage: 'stable-read', reason: 'after-repair-' + rr.reason, businessDate };
      finalRows = rr.rows;
    }
    hints = mergeCardHints(hints, finalRows.map(r => ({
      productId: r.productId, text: r.text || '', migrationWarning: r.migrationWarning,
      precheckRisk: r.precheckRisk || r.precheck, reviewFailed: r.reviewFailed,
    })));
    workingState = { ...workingState, hints };
    await persistState(workingState);
    const afterRepair = evaluateReadiness(finalRows, biz.productsPerPlan);
    if (repaired.selectedCount === 0 || repaired.progress === false) {
      return { status: 'stopped', stage: 'readiness-after-repair', reason: 'repair-made-no-progress', readiness: afterRepair, businessDate };
    }
    const rebound = await d.bindAccountsToAll({ productIds: afterRepair.uniqueIds, repairRound: round + 1 });
    if (d.requireRealDrivers === true && (!rebound || rebound.ok !== true)) {
      // R131: the replacement batch itself may be a fully-proven 30/30 no-usable-account batch.
      // Only when this failed rebind carries per-product accountUnavailableProven for EXACTLY the
      // current batch's 30 unique ids (no unknown, no foreign, no duplicate, no drift, no
      // merely-available row) is that narrow proof merged back onto the current rows so the SAME
      // bounded repair loop walks forward to the next page via the existing whole-batch-removal +
      // requireNextPage + close/delete/attempted/persist/cursor-forward path. Anything less keeps
      // the original zero-removal account-rebinding stop; the page is never skipped and success
      // is never faked.
      const rebindProof = reboundUnavailableProof(rebound, afterRepair.uniqueIds, biz.productsPerPlan);
      if (!rebindProof.ok) {
        const rebindDiag = sanitizeBindingDiagnostic(rebound && rebound.diag);
        return { status: 'stopped', stage: 'account-rebinding', reason: (rebound && rebound.reason) || 'repair-rebinding-not-confirmed', bindingDiag: rebindDiag, businessDate };
      }
      mainRows = mergeSettledPanelEvidence(finalRows, rebound.rows.filter(r => r && rebindProof.batchIdSet.has(String(r.productId))));
      provenAccountUnavailableIds = rebindProof.provenIds.slice();
      bindingFailedIds = rebindProof.provenIds.slice();
    } else {
      const rrAfter = await readRows();
      if (!rrAfter.ok) return { status: 'stopped', stage: 'stable-read', reason: 'after-rebind-' + rrAfter.reason, businessDate };
      mainRows = rrAfter.rows;
      // A per-batch proof never outlives its batch: once the replacement rebound
      // successfully, the stale 30/30 proof is dropped so no later round can lean on it.
      provenAccountUnavailableIds = [];
    }
    hints = mergeCardHints(hints, mainRows.map(r => ({
      productId: r.productId, text: r.text || '', migrationWarning: r.migrationWarning,
      precheckRisk: r.precheckRisk || r.precheck, reviewFailed: r.reviewFailed,
    })));
    workingState = { ...workingState, hints };
    await persistState(workingState);
    readiness = evaluateReadiness(mainRows, biz.productsPerPlan);
    emitReadiness(readiness, 'after-rebind', round + 1);
    finalRows = mainRows;
    if (readiness.ready) break;
  }
  if (!readiness.ready) return { status: 'stopped', stage: 'readiness-after-repair', reason: 'still-not-30-valid', readiness, businessDate };

  let configured = null;
  if (typeof d.configurePlan === 'function') {
    configured = await d.configurePlan({ planNumber: d.planNumber, businessDate, mainRows: finalRows });
    if (!configured || configured.ok !== true || !configured.planName) {
      const reason = (configured && configured.reason) || 'settings-not-confirmed';
      const settingsDiag = reason === 'plan-settings-readback-mismatch'
        ? sanitizeSettingsDiagnostic(configured && configured.expected, configured && configured.observed)
        : null;
      return { status: 'stopped', stage: 'plan-settings', reason, settingsDiag, businessDate };
    }
  } else if (d.requireRealDrivers === true) {
    return { status: 'stopped', stage: 'plan-settings', reason: 'real-plan-settings-driver-missing', businessDate };
  }
  // Configuration is followed by a bounded, PASSIVE stability read of the SAME 30 rows.
  // A late 广告审核不通过 / newly duplicated row that appears after the settings were written
  // is NOT a passive stop when its evidence is explicit: the exact deficient rows are
  // replaced (continue from the durable forward cursor), the batch is rebound and the
  // trusted parameters are configured again, then the stable gate is re-proven. The loop is
  // bounded (at most 2 post-configuration repair rounds) and every unknown/ambiguous row
  // still stops with ZERO removal. Only the real driver (which can prove two consecutive
  // stable reads) participates; legacy offline drivers keep their exact previous behavior.
  if (typeof d.awaitMainTableStable === 'function') {
    let postRepairs = 0;
    for (;;) {
      const post = await d.awaitMainTableStable({ capacity: biz.productsPerPlan });
      if (!post || post.ok !== true) {
        return { status: 'stopped', stage: 'stable-read', reason: 'post-configuration-' + ((post && post.reason) || 'main-table-not-stable'), businessDate };
      }
      const postRows = Array.isArray(post.rows) ? post.rows : [];
      const gate = reviewStabilityContract({ rows: postRows, capacity: biz.productsPerPlan, business: biz, stableReads: post && post.stableReads });
      if (gate.ready) { finalRows = postRows; break; }
      const postReadiness = gate.readiness || evaluateReadiness(postRows, biz.productsPerPlan, biz);
      if (postReadiness.unknownManualIds.length || postReadiness.ambiguousCount > 0) {
        return { status: 'stopped', stage: 'readiness-after-configuration', reason: 'review-or-rows-not-stable-after-configuration', gateReasons: gate.reasons, readiness: postReadiness, businessDate };
      }
      const latePlan = planRemovalAndBackfill({
        rows: postRows, capacity: biz.productsPerPlan,
        attemptedSet, publishedSet, catalogRemainingIds: d.catalogRemainingIds || [],
      });
      if (!latePlan.removeIds.length) {
        return { status: 'stopped', stage: 'readiness-after-configuration', reason: 'review-or-rows-not-stable-after-configuration', gateReasons: gate.reasons, readiness: postReadiness, businessDate };
      }
      if (postRepairs >= 2) {
        return { status: 'stopped', stage: 'readiness-after-configuration', reason: 'configuration-repair-round-limit', gateReasons: gate.reasons, readiness: postReadiness, businessDate };
      }
      postRepairs++;
      const repaired = await d.repairDraft({
        removeIds: latePlan.removeIds,
        backfillIds: latePlan.backfillIds,
        backfillCount: latePlan.need,
        rows: postRows,
        state: workingState,
        publishedSet,
        attemptedSet,
        hints,
        failedIds: bindingFailedIds,
        bindingRows: postRows,
        provenDuplicateIds: duplicateIdsOf(postRows),
        repairMode: latePlan.mode,
        requireNextPage: latePlan.requireNextPage,
        onProgress: saveProgress,
      });
      if (!repaired || repaired.ok === false) {
        return { status: 'stopped', stage: 'repair', reason: (repaired && repaired.reason) || 'repair-not-confirmed', readiness: postReadiness, plan: latePlan, businessDate };
      }
      let repairedRows = Array.isArray(repaired.mainRows) ? repaired.mainRows : null;
      if (!repairedRows) {
        const rr = await readRows();
        if (!rr.ok) return { status: 'stopped', stage: 'stable-read', reason: 'after-configuration-repair-' + rr.reason, businessDate };
        repairedRows = rr.rows;
      }
      const afterRepair = evaluateReadiness(repairedRows, biz.productsPerPlan, biz);
      hints = mergeCardHints(hints, repairedRows.map(r => ({
        productId: r.productId, text: r.text || '', migrationWarning: r.migrationWarning,
        precheckRisk: r.precheckRisk || r.precheck, reviewFailed: r.reviewFailed,
      })));
      workingState = { ...workingState, hints };
      await persistState(workingState);
      const rebound = await d.bindAccountsToAll({ productIds: afterRepair.uniqueIds, repairRound: 'post-configuration' });
      if (d.requireRealDrivers === true && (!rebound || rebound.ok !== true)) {
        const rebindDiag = sanitizeBindingDiagnostic(rebound && rebound.diag);
        return { status: 'stopped', stage: 'account-rebinding', reason: (rebound && rebound.reason) || 'post-configuration-rebinding-not-confirmed', bindingDiag: rebindDiag, businessDate };
      }
      const rrStable = await readRows();
      if (!rrStable.ok) return { status: 'stopped', stage: 'stable-read', reason: 'post-configuration-rebind-' + rrStable.reason, businessDate };
      mainRows = rrStable.rows;
      finalRows = mainRows;
      const reconfigured = await d.configurePlan({ planNumber: d.planNumber, businessDate, mainRows: finalRows });
      if (!reconfigured || reconfigured.ok !== true || !reconfigured.planName) {
        const reason = (reconfigured && reconfigured.reason) || 'settings-not-confirmed';
        return { status: 'stopped', stage: 'plan-settings', reason, businessDate };
      }
      configured = reconfigured;
    }
  }
  const finalIds = evaluateReadiness(finalRows, biz.productsPerPlan).uniqueIds;
  // The frozen target set: live-discovered binding first, then an explicitly
  // injected set, then the profile's own configured targets (the legacy default
  // resolves to its frozen two). A generic shop that resolves to NONE must stop
  // here (fail-closed) instead of freezing an unauthorizable plan or silently
  // inheriting the legacy default.
  const boundAccounts = (binding && Array.isArray(binding.accountIds) && binding.accountIds.length)
    ? binding.accountIds.map(String)
    : (d.boundAccounts || approvedTargets(biz) || null);
  if (d.requireRealDrivers === true && (!boundAccounts || boundAccounts.length < 1)) {
    return { status: 'stopped', stage: 'account-binding', reason: 'no-approved-bind-targets', businessDate };
  }
  const frozen = await freezeReady(deps, finalIds, finalRows, businessDate, hints, configured && configured.planName, boundAccounts);
  return { status: 'ready-awaiting-confirmation', businessDate, binding, readiness, frozen };
}

async function freezeReady(deps, selectedIds, mainRows, businessDate, cardHints, configuredPlanName, boundAccounts) {
  const d = deps || {};
  const biz = bizOf(d.business);
  const hints = mergeCardHints(d.hints || {}, Object.entries(cardHints || {}).map(([productId, h]) => ({ productId, ...h })));
  const parsed = (mainRows || []).map(r => (r.productId !== undefined ? r : parseMainTableRow(r.text || r)));
  const migration = parsed.filter(r => r.productId && ((hints[String(r.productId)] && hints[String(r.productId)].migrationWarning) || r.migrationWarning)).map(r => String(r.productId));
  const precheck = parsed.filter(r => r.productId && ((hints[String(r.productId)] && hints[String(r.productId)].precheckRisk) || r.precheck)).map(r => String(r.productId));
  return freezePlan({
    planNumber: d.planNumber,
    runId: d.runId,
    businessDate,
    accountId: biz.accountId,
    planName: configuredPlanName || d.planName || null,
    productIds: selectedIds,
    boundAccounts: boundAccounts && boundAccounts.length ? boundAccounts : undefined,
    disclosures: { migration, precheck, reviewFailed: [] },
  }, { nowMs: d.nowMs, business: biz });
}

// Publish only after an explicit, validated, one-shot human confirmation. The real
// click + durable persist-before-click consumption is delegated to the R9 guard.
async function publishConfirmedPlan(frozen, request, deps) {
  const d = deps || {};
  const biz = bizOf(d.business);
  const verdict = validateConfirmation(frozen, request, {
    consumed: d.consumed,
    nowMs: typeof d.nowMs === 'function' ? d.nowMs() : d.nowMs,
    business: biz,
  });
  if (!verdict.authorized) return { status: 'refused', reason: verdict.reason };

  // Re-observe and re-check against the frozen info before consuming/clicking.
  const obs = await d.observe();
  if (!obs || !obs.observation) return { status: 'refused', reason: 'fresh-observation-missing' };
  const authorization = { ...verdict.authorization, observation: obs.observation };
  const cmd = { op: 'publish-plan', planNumber: frozen.planNumber, authorization };
  let clickResult;
  try {
    clickResult = await d.runPublishPlan(cmd, {
      ...(d.publishDeps || {}),
      latest: obs,
      runId: frozen.runId,
      configuredAccountId: frozen.accountId,
      approvedFirstPlan: d.approvedFirstPlan || { account_id: frozen.accountId, product_ids: frozen.productIds },
    });
  } catch (error) {
    return { status: 'unknown', stage: 'initial-publish', reason: 'dispatch-or-ledger-unknown:' + (error && error.message), clickResult: null };
  }
  if (!clickResult || clickResult.clicked !== true) return { status: 'unknown', stage: 'initial-publish', reason: 'publish-click-not-confirmed', clickResult };

  // Handle the known final mutual-exclusion dialog: only the whitespace-equal
  // known copy, already shown/accepted by the human, is confirmed exactly once.
  // 客户 2026-10-11 阻断修复：初始发布后最终弹窗**晚挂载**，立即 readFinalDialog 会误判 unknown
  // 而停。优先复用执行器已有的**有界等待** awaitFinalDialog（绝不重复点初始发布）；无该能力时
  // 退化为单次只读 readFinalDialog（保持旧语义，不新增点击）。
  let dialog;
  if (typeof d.awaitFinalDialog === 'function') {
    dialog = await d.awaitFinalDialog({ planNumber: frozen.planNumber });
  } else {
    dialog = await d.readFinalDialog();
  }
  const match = matchFinalExclusionDialog(dialog && dialog.text);
  if (!dialog || dialog.visible !== true || !match.known || request.acceptedDisclosures !== true) {
    return { status: 'stopped', stage: 'final-dialog-unknown', reason: 'unknown-or-new-final-dialog', clickResult };
  }
  const btn = resolveFinalPublishButton(dialog && dialog.confirmTarget);
  if (!btn.ok) return { status: 'stopped', stage: 'final-button', reason: btn.reason, clickResult };
  if (typeof d.consumeFinalConfirmation !== 'function') {
    return { status: 'stopped', stage: 'final-confirm-consumption', reason: 'durable-final-confirm-consumer-missing', clickResult };
  }
  try {
    await d.consumeFinalConfirmation(frozen, authorization);
  } catch (error) {
    return { status: 'unknown', stage: 'final-confirm-consumption', reason: 'final-confirm-consume-failed:' + (error && error.message), clickResult };
  }
  let finalClick;
  try { finalClick = await d.clickFinalConfirm({ expectedText: FINAL_EXCLUSION_TEXT, confirmationId: frozen.confirmationId, manifestHash: frozen.manifestHash }); }
  catch (error) { finalClick = { clicked: false, reason: 'dispatch-unknown:' + (error && error.message) }; }
  if (!finalClick || finalClick.clicked !== true) return { status: 'unknown', stage: 'final-confirm', reason: (finalClick && finalClick.reason) || 'final-confirm-not-confirmed', clickResult, finalClick };
  if (typeof d.recordFinalConfirmationOutcome === 'function') {
    try {
      const recorded = await d.recordFinalConfirmationOutcome(frozen, 'clicked');
      if (recorded === false) return { status: 'unknown', stage: 'final-confirm-ledger', reason: 'final-confirm-clicked-but-outcome-not-durable', clickResult, finalClick };
    } catch (error) {
      return { status: 'unknown', stage: 'final-confirm-ledger', reason: 'final-confirm-outcome-persist-failed:' + (error && error.message), clickResult, finalClick };
    }
  }

  // Readback on the management page (bounded; a timeout alone stays 'unknown').
  const readback = await d.readManagementRow({ planName: frozen.planName, accountId: biz.accountId });
  const outcome = classifyPublishOutcome(readback, {
    planName: frozen.planName,
    accountId: biz.accountId,
    existingPlanIds: d.existingPlanIds || [],
    productsPerPlan: biz.productsPerPlan,
    roi: biz.roi,
    dailyBudget: biz.dailyBudget,
  });
  return { status: outcome.outcome, planId: outcome.planId, reason: outcome.reason, clickResult, finalClick, readback };
}

// ── in-page collectors (self-contained; serialized by Playwright) ───────────
// Card collection MUST use the visible .card-container outer layer: the migration
// / precheck warning is a SIBLING of .card-product-item, so reading only the inner
// item would drop the warning. Each row binds one unique product id and keeps the
// full drawer text.
function collectProductCardsInPage() {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const text = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const out = [];
  const containers = [...document.querySelectorAll('.card-container')].filter(visible);
  for (const c of containers) {
    const full = text(c);
    const idm = /ID[:：]\s*(\d{15,20})/.exec(full);
    const disabled = !!c.querySelector('.card-product-item--disabled, [class*="disabled"]')
      || /已创建「全店托管」计划/.test(full) && !!c.querySelector('[aria-disabled="true"]');
    out.push({ id: idm ? idm[1] : null, text: full.slice(0, 1200), disabled: c.getAttribute('aria-disabled') === 'true' || disabled });
  }
  return out;
}

// Resolve the real semantic 确认发布 BUTTON (today getByText returns a SPAN whose
// closest BUTTON is the actual control); never click the span-guard failure path.
function resolveFinalConfirmButtonInPage() {
  const visible = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const text = e => (e.innerText || e.textContent || '').replace(/\s+/g, ' ').trim();
  const nodes = [...document.querySelectorAll('button,span,a,[role="button"]')].filter(visible).filter(e => text(e) === '确认发布');
  if (nodes.length === 0) return { ok: false, reason: 'confirm-publish-not-found' };
  const btns = [...new Set(nodes.map(n => (n.tagName === 'BUTTON' ? n : n.closest('button'))).filter(Boolean))];
  if (btns.length !== 1) return { ok: false, reason: 'confirm-publish-button-not-unique:' + btns.length };
  return { ok: true, tag: btns[0].tagName };
}

module.exports = {
  BUSINESS, CATEGORY_TAB_ORDER, FINAL_EXCLUSION_TEXT,
  bizOf, configuredTargets, isLegacyBusiness, approvedTargets,
  effectivePlanLimit,
  AUTO_PULL_MARK, MIGRATION_MARK, PRECHECK_MARK, REVIEW_FAILED_MARK,
  MANUAL_UI_SOURCE, MANUAL_RUN_ORIGIN_RE,
  canonicalManualUiReceipt, manualUiReceiptHash, validateManualUiReceipt, buildManualUiPublicationFact,
  shanghaiDate, atomicWriteJson,
  readPublishedSeed, loadPublishedStore, appendPublished, persistPublished,
  newDayState, loadDayState, persistDayState,
  parseProductId, parseProductCard, mergeCardHints, selectFromPage,
  verifyCreationHeader, parseAccountDrawer, verifyAccountBinding, chooseAnchorProduct,
  parseMainTableRow, evaluateReadiness, planRemovalAndBackfill,
  classifyAddDialog, normalizeSpace, matchFinalExclusionDialog, resolveFinalPublishButton,
  classifyAvailabilityEvidence, advanceCatalogCursor, reviewStabilityContract,
  reboundUnavailableProof, wholeBatchRemovalEmptyTableGate,
  ALREADY_PLANNED_MARK,
  canonicalManifest, manifestHash, makeNonce, freezePlan, validateConfirmation,
  classifyPublishOutcome, planPostPublishEnable,
  hasUnresolvedPlan,
  preparePlan, publishConfirmedPlan,
  sanitizeSettingsDiagnostic, sanitizeBindingDiagnostic, readinessSummary, makePreparationEmitter,
  collectProductCardsInPage, resolveFinalConfirmButtonInPage,
};
