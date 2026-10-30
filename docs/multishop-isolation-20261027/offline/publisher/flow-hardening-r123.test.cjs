'use strict';
// R123 offline behavioural regression for the REAL post-incident hardening:
//   * known creation guidance (跳过 / 我知道了) and known management obstructions
//   * panel-load / stale-cache proof before availability is judged
//   * explicit duplicate evidence only (gray is never a duplicate)
//   * whole-batch vs partial draft repair + durable forward cursor
//   * late review-failure coverage after binding/configuration
//   * known cancel-confirm + positive close before re-opening the anchor
//   * one bounded read-only refresh of the correct management page
// No network, no browser, no cookies, no production state, no timers beyond the
// bounded waits already used by the production code. Run:
//   node --test publisher/flow-hardening-r123.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const wf = require('./plan-workflow.cjs');
const rp = require('./run-plans.cjs');
const guard = require('./direct-draft-controller.cjs');

// ── tiny in-workspace DOM harness (only the surfaces the callbacks read) ─────
let SEQ = 0;
const ElementProto = {
  getAttribute(name) {
    if (name === 'class') return this.className != null ? String(this.className) : null;
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  },
  setAttribute(name, val) { if (name === 'class') { this.className = val; return; } this.attrs[name] = String(val); },
  getBoundingClientRect() { const r = this.__rect; const w = r ? r[0] : 0; const h = r ? r[1] : 0; return { width: w, height: h, x: 0, y: 0, top: 0, bottom: h }; },
  get innerText() { return this.__textValue(); },
  get textContent() { return this.__textValue(); },
  get children() { return this.__kids; },
  get parentElement() { return this.parent; },
  __textValue() { let s = ''; const walk = n => { if (n.__text != null) s += n.__text + ' '; for (const ch of n.__kids) walk(ch); }; walk(this); return s.replace(/\s+/g, ' ').trim(); },
  querySelectorAll(sel) { const out = []; const walk = n => { for (const ch of n.__kids) { if (matchesSel(ch, sel)) out.push(ch); walk(ch); } }; walk(this); return out; },
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  closest(sel) { let n = this; while (n) { if (matchesSel(n, sel)) return n; n = n.parent; } return null; },
  contains(other) { let n = other; while (n) { if (n === this) return true; n = n.parent; } return false; },
  click() { this.__clicks = (this.__clicks || 0) + 1; },
  attachShadow() { return null; },
  addEventListener(type, fn) { this.__ev = this.__ev || {}; (this.__ev[type] = this.__ev[type] || []).push(fn); },
  dispatchEvent(ev) {
    this.__ev = this.__ev || {};
    for (const fn of (this.__ev[ev.type] || [])) fn.call(this, ev);
    if (ev.bubbles && this.parent) this.parent.dispatchEvent(ev);
    return true;
  },
};
function parseCompound(str) {
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
function matchPart(el, p) {
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
function matchesSel(el, selStr) {
  return selStr.split(',').some(g => {
    const chain = g.trim().split(/\s+/).filter(Boolean);
    if (!chain.length) return false;
    const compound = (node, c) => { const ps = parseCompound(c); return ps.length > 0 && ps.every(p => matchPart(node, p)); };
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
function El(tag, opts = {}, kids = []) {
  const el = Object.create(ElementProto);
  el.tagName = String(tag).toUpperCase();
  el.__seq = SEQ++;
  el.attrs = {};
  el.className = opts.class != null ? opts.class : '';
  el.__text = opts.text != null ? String(opts.text) : null;
  el.__rect = opts.rect || [200, 40];
  el.disabled = opts.disabled === true;
  if (opts.checked !== undefined) el.checked = opts.checked === true;
  el.__kids = []; el.parent = null; el.__ev = {};
  if (opts.attrs) for (const k in opts.attrs) el.attrs[k] = String(opts.attrs[k]);
  for (const ch of kids) { if (!ch) continue; ch.parent = el; el.__kids.push(ch); }
  return el;
}
function makeCtx(bodyKids, locationOverride = {}) {
  const body = El('body', {}, bodyKids || []);
  const doc = {
    body,
    querySelectorAll(sel) { const out = []; const walk = n => { for (const ch of n.__kids) { if (matchesSel(ch, sel)) out.push(ch); walk(ch); } }; walk(body); return out; },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  };
  const ctx = {
    document: doc,
    location: { origin: 'https://qianchuan.jinritemai.com', pathname: '/overall-prom', search: '?aavid=' + wf.BUSINESS.accountId, ...locationOverride },
    getComputedStyle: el => ({ visibility: el.__vis || 'visible', display: 'block' }),
    MouseEvent: class MouseEvent { constructor(type, init) { this.type = type; this.bubbles = !!(init && init.bubbles); this.cancelable = !!(init && init.cancelable); } },
    Event: class Event { constructor(type, init) { this.type = type; this.bubbles = !!(init && init.bubbles); } },
    URLSearchParams, console: { log() {} },
  };
  vm.createContext(ctx);
  return { run(fn, arg) { const a = arguments.length > 1 ? ', ' + JSON.stringify(arg) : ''; return vm.runInContext('(' + fn.toString() + ').call(this' + a + ')', ctx); }, ctx, doc };
}
const plain = v => JSON.parse(JSON.stringify(v));

// ── 1. known creation guidance: 跳过 / 我知道了 only ─────────────────────────
test('R123 guidance accepts 跳过 / 我知道了 inside the known mask only, unknown label stays untouched', () => {
  const mask = (label, rect = [300, 200]) => El('div', { class: 'c-lib-guide-mask', rect }, [
    El('div', { text: '新手引导 第1步' }),
    El('button', { class: 'c-lib-guide-button', text: label }),
  ]);
  const dom = makeCtx([mask('跳过')], { pathname: '/uni-creation/overall-product-multi', search: '?aavid=' + wf.BUSINESS.accountId });
  const snap = plain(dom.run(rp.guidanceActionInPage, { mode: 'snapshot', accountId: wf.BUSINESS.accountId }));
  assert.equal(snap.present, true);
  assert.equal(snap.roots.length, 1);
  assert.equal(snap.roots[0].label, '跳过');
  const stepped = plain(dom.run(rp.guidanceActionInPage, { mode: 'step', accountId: wf.BUSINESS.accountId, ...snap.roots[0] }));
  assert.equal(stepped.clicked, true);
  assert.equal(stepped.label, '跳过');

  const known = makeCtx([mask('我知道了')], { pathname: '/uni-creation/overall-product-multi', search: '?aavid=' + wf.BUSINESS.accountId });
  assert.equal(plain(known.run(rp.guidanceActionInPage, { mode: 'snapshot', accountId: wf.BUSINESS.accountId })).roots[0].label, '我知道了');

  const foreign = makeCtx([mask('开启货款直投')], { pathname: '/uni-creation/overall-product-multi', search: '?aavid=' + wf.BUSINESS.accountId });
  const fs = plain(foreign.run(rp.guidanceActionInPage, { mode: 'snapshot', accountId: wf.BUSINESS.accountId }));
  assert.equal(fs.present, false);
  assert.match(fs.unknown, /guidance-unknown-root-shape/);
  assert.throws(() => foreign.run(rp.guidanceActionInPage, { mode: 'step', accountId: wf.BUSINESS.accountId, order: 0, kind: 'clib', content: 'x', label: '开启货款直投' }), /guidance-unknown-root-shape/);
});

test('R123 跳过 has explicit priority over 下一步 inside one real guide; same-priority duplicates stay unknown', () => {
  const guide = El('div', { class: 'c-lib-guide-mask', rect: [300, 200] }, [
    El('div', { text: '新手引导 第1步' }),
    El('button', { class: 'c-lib-guide-button', text: '下一步' }),
    El('button', { class: 'c-lib-guide-button', text: '跳过' }),
  ]);
  const dom = makeCtx([guide], { pathname: '/uni-creation/overall-product-multi', search: '?aavid=' + wf.BUSINESS.accountId });
  const snap = plain(dom.run(rp.guidanceActionInPage, { mode: 'snapshot', accountId: wf.BUSINESS.accountId }));
  assert.equal(snap.present, true);
  assert.equal(snap.roots.length, 1);
  assert.equal(snap.roots[0].label, '跳过', 'dismiss control wins the deterministic priority');
  assert.equal(plain(dom.run(rp.guidanceActionInPage, { mode: 'step', accountId: wf.BUSINESS.accountId, ...snap.roots[0] })).label, '跳过');

  const ambiguous = El('div', { class: 'c-lib-guide-mask', rect: [300, 200] }, [
    El('button', { class: 'c-lib-guide-button', text: '下一步' }),
    El('button', { class: 'c-lib-guide-button', text: '下一步' }),
  ]);
  const two = makeCtx([ambiguous], { pathname: '/uni-creation/overall-product-multi', search: '?aavid=' + wf.BUSINESS.accountId });
  const s2 = plain(two.run(rp.guidanceActionInPage, { mode: 'snapshot', accountId: wf.BUSINESS.accountId }));
  assert.equal(s2.present, false);
  assert.match(s2.unknown, /guidance-unknown-root-shape/);
  assert.throws(() => two.run(rp.guidanceActionInPage, { mode: 'step', accountId: wf.BUSINESS.accountId }), /guidance-unknown-root-shape/);
});

// ── 2. known management obstructions + refusals ─────────────────────────────
function mgmtRoot(kind) {
  if (kind === 'marketing') return El('div', { class: 'ovui-modal', text: '营销广告 限时活动' }, [
    El('button', { class: 'close', attrs: { 'aria-label': '关闭' }, text: '' }),
  ]);
  if (kind === 'balance') return El('div', { class: 'ovui-modal', text: '账户余额不足 请及时充值' }, [
    El('button', { text: '我知道了' }),
  ]);
  if (kind === 'unknown-two-close') return El('div', { class: 'ovui-modal', text: '营销广告 活动' }, [
    El('button', { attrs: { 'aria-label': '关闭' }, text: '' }),
    El('button', { attrs: { 'aria-label': '关闭' }, text: '' }),
  ]);
  if (kind === 'main-action') return El('div', { class: 'ovui-modal', text: '投放乘方 开启货款直投' }, [
    El('button', { text: '我知道了' }),
  ]);
  return null;
}
test('R123 management obstructions: only the known balance/营销 close is clicked, unknown and main actions are zero-click', () => {
  const account = wf.BUSINESS.accountId;
  const m = makeCtx([mgmtRoot('marketing')]);
  const s1 = plain(m.run(rp.managementObstructionActionInPage, { mode: 'snapshot', accountId: account }));
  assert.deepEqual(s1.kinds, ['marketing']);
  assert.equal(plain(m.run(rp.managementObstructionActionInPage, { mode: 'step', accountId: account })).clicked, true);

  const b = makeCtx([mgmtRoot('balance')]);
  assert.deepEqual(plain(b.run(rp.managementObstructionActionInPage, { mode: 'snapshot', accountId: account })).kinds, ['balance']);
  assert.equal(plain(b.run(rp.managementObstructionActionInPage, { mode: 'step', accountId: account })).label, '我知道了');

  const u = makeCtx([mgmtRoot('unknown-two-close')]);
  const us = plain(u.run(rp.managementObstructionActionInPage, { mode: 'snapshot', accountId: account }));
  assert.equal(us.present, true);
  assert.match(us.unknown, /management-obstruction-unknown/);
  assert.throws(() => u.run(rp.managementObstructionActionInPage, { mode: 'step', accountId: account }));

  const main = makeCtx([mgmtRoot('main-action')]);
  assert.match(plain(main.run(rp.managementObstructionActionInPage, { mode: 'snapshot', accountId: account })).unknown, /management-obstruction-unknown/);
  assert.throws(() => main.run(rp.managementObstructionActionInPage, { mode: 'step', accountId: account }));

  const wrongPath = makeCtx([mgmtRoot('balance')], { pathname: '/uni-creation/overall-product-multi' });
  assert.throws(() => wrongPath.run(rp.managementObstructionActionInPage, { mode: 'snapshot', accountId: account }), /management-obstruction-page-not-authorized/);
  const wrongShop = makeCtx([mgmtRoot('balance')], { search: '?aavid=9999999999999999' });
  assert.throws(() => wrongShop.run(rp.managementObstructionActionInPage, { mode: 'snapshot', accountId: account }), /management-obstruction-page-not-authorized/);
});

// ── 3. panel loading proof (spinner + exact set + active + footer) ───────────
const IDS30 = Array.from({ length: 30 }, (_, i) => '38458116252485' + String(55000 + i));
function snapOf(over = {}) {
  return Object.assign({
    ok: true,
    spinnerCount: 0,
    panelProductIds: IDS30.slice(),
    activeProductIds: [IDS30[0]],
    rows: [{ ids: ['79863866'], checked: false, labelDisabled: true }, { ids: ['9zmao_fushi'], checked: false, labelDisabled: false }],
    selectedCount: 0,
    totalCount: 30,
  }, over);
}
test('R123 a panel is usable only after the spinner is gone, the set is exact and the active is right', () => {
  assert.equal(rp.bindingPanelSettled(snapOf(), IDS30, IDS30[0]), true);
  assert.equal(rp.bindingPanelSettled(snapOf({ spinnerCount: 1 }), IDS30, IDS30[0]), false, 'spinner must block');
  assert.equal(rp.bindingPanelSettled(snapOf({ activeProductIds: [IDS30[1]] }), IDS30, IDS30[0]), false, 'stale active from previous panel');
  assert.equal(rp.bindingPanelSettled(snapOf({ panelProductIds: IDS30.slice(0, 29) }), IDS30, IDS30[0]), false, 'empty/incomplete panel set');
  assert.equal(rp.bindingPanelSettled(snapOf({ rows: [{ ids: ['79863866'], checked: null, labelDisabled: null }], selectedCount: null, totalCount: null }), IDS30, IDS30[0]), false, 'unfinished disabled row is not a settled state');
  // single manual account is a valid settled drawer
  assert.equal(rp.bindingAccountsSnapshotSettled(snapOf({ rows: [{ ids: ['9zmao_fushi'], checked: true }], selectedCount: 1, totalCount: 30 }), [], 30), true);
});

// ── 4. availability classification: gray is NOT duplicate ───────────────────
test('R123 only explicit copy proves duplicate; gray/disabled/unsettled never does', () => {
  const mark = wf.ALREADY_PLANNED_MARK;
  assert.equal(wf.classifyAvailabilityEvidence({ text: mark + ' 查看详情', settled: true }).kind, 'already-planned');
  assert.equal(wf.classifyAvailabilityEvidence({ text: '商品 A', checkboxState: 'disabled', settled: true }).kind, 'disabled-unknown');
  assert.equal(wf.classifyAvailabilityEvidence({ text: '商品 A', checkboxState: 'disabled', settled: true }).actionable, 'stop');
  const unsettled = wf.classifyAvailabilityEvidence({ text: mark, settled: false });
  assert.equal(unsettled.kind, 'unknown');
  assert.equal(unsettled.proven, false);
  assert.equal(wf.classifyAvailabilityEvidence({ text: 'x', manualAccounts: 0, manualEvidence: true }).kind, 'unbindable');
  assert.equal(wf.classifyAvailabilityEvidence({ text: '预估自动拉取 2 个', autoPullOnly: true }).actionable, 'remove-and-continue');
  assert.equal(wf.classifyAvailabilityEvidence({ text: 'x', manualAccounts: 2 }).kind, 'bound');
});

// ── 5. whole-batch vs partial removal + backfill ────────────────────────────
function row(id, extra = {}) { return Object.assign({ productId: id, manualAccounts: 2, manualEvidence: true, autoPullOnly: false, reviewFailed: false, alreadyPlanned: false, text: 'ID：' + id }, extra); }
test('R123 30 proven duplicates -> whole-batch removal and continue from the durable next page', () => {
  const rows = IDS30.map(id => row(id, { text: wf.ALREADY_PLANNED_MARK, manualAccounts: null, manualEvidence: false, alreadyPlanned: true }));
  const plan = wf.planRemovalAndBackfill({ rows, capacity: 30, catalogRemainingIds: IDS30.map(id => '90000000000000' + String(IDS30.indexOf(id)).padStart(4, '0')) });
  assert.equal(plan.mode, 'whole-batch-removal');
  assert.equal(plan.removeIds.length, 30);
  assert.equal(plan.requireNextPage, true);
  assert.equal(plan.backfillIds.length, 30);
  assert.equal(new Set(plan.removeIds).size, 30);
});

test('R123 a partially bad batch removes only the proven-bad rows and keeps the good ones', () => {
  const rows = IDS30.map((id, i) => i === 3 ? row(id, { reviewFailed: true }) : i === 7 ? row(id, { manualAccounts: 0, alreadyPlanned: false }) : row(id));
  const plan = wf.planRemovalAndBackfill({
    rows, capacity: 30,
    catalogRemainingIds: ['7777777777777001', '7777777777777002', '7777777777777003'],
    attemptedSet: new Set([IDS30[0]]),
    publishedSet: new Set([IDS30[1]]),
  });
  assert.equal(plan.mode, 'partial-removal');
  assert.deepEqual(plan.removeIds.sort(), [IDS30[3], IDS30[7]].sort());
  assert.equal(plan.backfillIds.length, 2);
  assert.ok(!plan.backfillIds.includes(IDS30[0]), 'attempted never re-picked');
  assert.ok(!plan.backfillIds.includes(IDS30[1]), 'local published never re-picked');
  assert.ok(!plan.backfillIds.includes(IDS30[2]), 'kept good product never re-picked');
});

test('R123 an unknown row blocks removal/backfill instead of being deleted as duplicate', () => {
  const rows = IDS30.map((id, i) => i === 0 ? row(id, { manualAccounts: null, manualEvidence: false, text: 'ID：' + id }) : row(id));
  const plan = wf.planRemovalAndBackfill({ rows, capacity: 30, catalogRemainingIds: ['8888888888888001'] });
  assert.equal(plan.removeIds.length, 0);
  assert.equal(plan.backfillIds.length, 0);
  assert.deepEqual(plan.blockedUnknownIds, [IDS30[0]]);
  assert.equal(plan.catalogExhausted, true);
});

// ── 6. durable cursor: real forward proof only ──────────────────────────────
test('R123 cursor advances only on the real next numeric page, never rewinds or fakes EOF', () => {
  const base = { category: '全部', page: 3, seenProductIds: [] };
  assert.equal(wf.advanceCatalogCursor(base, { kind: 'numeric', observedPage: 4, expectedPage: 3 }).ok, true);
  assert.equal(wf.advanceCatalogCursor(base, { kind: 'numeric', observedPage: 4, expectedPage: 3 }).cursor.page, 4);
  assert.equal(wf.advanceCatalogCursor(base, { kind: 'numeric', observedPage: 3, expectedPage: 3 }).reason, 'cursor-not-forward');
  assert.equal(wf.advanceCatalogCursor(base, { kind: 'numeric', observedPage: 5, expectedPage: 3 }).reason, 'cursor-page-skipped');
  assert.equal(wf.advanceCatalogCursor(base, { kind: 'numeric', observedPage: null, expectedPage: 3 }).ok, false);
  const native = { category: '店铺新品', page: 1, nativeEof: false };
  const n = wf.advanceCatalogCursor(native, { kind: 'native', category: '店铺新品', freshDistinctIds: true });
  assert.equal(n.ok, true); assert.equal(n.cursor.page, 1, 'native scroll never claims a numeric page');
  assert.equal(n.cursor.nativeEof, false);
  assert.equal(wf.advanceCatalogCursor(native, { kind: 'native', category: '店铺新品', freshDistinctIds: false }).reason, 'cursor-native-advance-unproven');
  assert.equal(wf.advanceCatalogCursor(native, { kind: 'native', category: '搜索趋势', freshDistinctIds: true }).reason, 'cursor-native-category-drift');
  assert.equal(wf.advanceCatalogCursor(native, { kind: 'native', category: '店铺新品', eofProven: true }).cursor.nativeEof, true);
  assert.equal(wf.advanceCatalogCursor(base, { kind: 'switch', category: '店铺新品' }).cursor.page, 1);
});

// ── 7. review stability contract ────────────────────────────────────────────
function readyRows() { return IDS30.map(id => ({ productId: id, manualAccounts: 2, manualEvidence: true, manualCountKnown: true, autoPullOnly: false, reviewFailed: false })); }
test('R123 review stability requires 30 valid + two stable reads + no late review failure', () => {
  assert.equal(wf.reviewStabilityContract({ rows: readyRows(), capacity: 30, stableReads: 2 }).ready, true);
  assert.equal(wf.reviewStabilityContract({ rows: readyRows(), capacity: 30, stableReads: 1 }).ready, false);
  const late = readyRows(); late[5].reviewFailed = true; late[5].text = wf.ALREADY_PLANNED_MARK;
  const bad = wf.reviewStabilityContract({ rows: late, capacity: 30, stableReads: 2 });
  assert.equal(bad.ready, false);
  assert.ok(bad.reasons.includes('review-failed'));
  const settings = wf.reviewStabilityContract({ rows: readyRows(), capacity: 30, stableReads: 2, settingsRequired: true, roi: 15, dailyBudget: 300, settings: { accountId: wf.BUSINESS.accountId, commissionChecked: true, optionalDirectPayChecked: false, roi: 15, budget: 301 } });
  assert.equal(settings.ready, false);
  assert.ok(settings.reasons.includes('budget-mismatch'));
});

// ── 8. late review failure after configuration: bounded repair, not a passive stop ─
test('R123 a late two-row review failure after configuration is replaced, rebound, reconfigured and re-proven', async () => {
  let stableCalls = 0, configureCalls = 0, bindCalls = 0, repairArgs = null;
  const late = readyRows();
  for (const i of [0, 1]) late[i] = { ...late[i], reviewFailed: true, text: 'ID：' + late[i].productId + ' 当前商品广告审核不通过，建议前往抖店修改，查看详情' };
  const next = readyRows().slice(2).concat([
    { productId: '3900000000000000001', manualAccounts: 2, manualEvidence: true, manualCountKnown: true, autoPullOnly: false, reviewFailed: false },
    { productId: '3900000000000000002', manualAccounts: 2, manualEvidence: true, manualCountKnown: true, autoPullOnly: false, reviewFailed: false },
  ]);
  const res = await wf.preparePlan({
    businessDate: '2026-10-17', planNumber: 1, runId: 'r123-offline', persistState: async () => {},
    openCreationPage: async () => ({ header: { originOk: true, accountId: wf.BUSINESS.accountId, commissionOptionPresent: true } }),
    browseProducts: async () => ({ ok: true, selectedIds: IDS30.slice(), attempted: [], cursor: { category: '全部', page: 1 } }),
    bindAccountsToAll: async () => { bindCalls++; return { ok: true, accountIds: wf.BUSINESS.boundAccounts.slice() }; },
    readMainTable: async () => next,
    awaitMainTableStable: async () => { stableCalls++; return { ok: true, rows: stableCalls === 2 ? late : (stableCalls === 1 ? readyRows() : next), stableReads: 2 }; },
    configurePlan: async () => { configureCalls++; return { ok: true, planName: '2026-10-17_千川乘方_12:00:00' }; },
    repairDraft: async args => {
      repairArgs = args;
      return { ok: true, mainRows: next, selectedCount: 30, progress: true };
    },
  });
  assert.equal(res.status, 'ready-awaiting-confirmation', JSON.stringify(res.reason || res.stage));
  assert.equal(configureCalls, 2, 'trusted parameters are configured again after the replacement');
  assert.equal(bindCalls, 2, 'the repaired batch is rebound');
  assert.equal(stableCalls >= 4, true, 'stable read is re-proven after rebind + reconfiguration');
  assert.deepEqual(repairArgs.removeIds.slice().sort(), IDS30.slice(0, 2).sort(), 'only the two late-failed rows are removed');
  assert.equal(repairArgs.requireNextPage, true);
  assert.equal(repairArgs.repairMode, 'partial-removal');
  assert.equal(res.frozen.productIds.length, 30);
  assert.equal(new Set(res.frozen.productIds).size, 30);
});

test('R123 a late UNKNOWN row still stops with zero removals and no reconfiguration', async () => {
  let configureCalls = 0, repairs = 0;
  const late = readyRows();
  late[5] = { productId: late[5].productId, manualAccounts: null, manualEvidence: false, autoPullOnly: false, reviewFailed: false, text: 'ID：' + late[5].productId };
  let stableCalls = 0;
  const res = await wf.preparePlan({
    businessDate: '2026-10-17', planNumber: 1, runId: 'r123-offline', persistState: async () => {},
    openCreationPage: async () => ({ header: { originOk: true, accountId: wf.BUSINESS.accountId, commissionOptionPresent: true } }),
    browseProducts: async () => ({ ok: true, selectedIds: IDS30.slice(), attempted: [], cursor: { category: '全部', page: 1 } }),
    bindAccountsToAll: async () => ({ ok: true, accountIds: wf.BUSINESS.boundAccounts.slice() }),
    readMainTable: async () => readyRows(),
    awaitMainTableStable: async () => { stableCalls++; return { ok: true, rows: stableCalls === 1 ? readyRows() : late, stableReads: 2 }; },
    configurePlan: async () => { configureCalls++; return { ok: true, planName: 'P' }; },
    repairDraft: async () => { repairs++; return { ok: true, mainRows: readyRows(), selectedCount: 30, progress: true }; },
  });
  assert.equal(res.status, 'stopped');
  assert.equal(res.stage, 'readiness-after-configuration');
  assert.equal(repairs, 0, 'unknown evidence never triggers removal');
  assert.equal(configureCalls, 1, 'no reconfiguration on an unknown row');
  assert.equal(res.frozen, undefined);
});

// ── 8b. whole-batch bind failure carries real evidence into repair ──────────
test('R123 all30 proven duplicate from a failed bind enters whole-batch repair with next-page proof', async () => {
  let repairs = 0, args = null;
  const rows = IDS30.map(productId => ({ productId, text: 'ID：' + productId + ' 商品与该抖音号已存在商品投放计划', manualAccounts: 0, manualEvidence: true, alreadyPlanned: true, reviewFailed: false }));
  let stableCalls = 0;
  const res = await wf.preparePlan({
    businessDate: '2026-10-17', planNumber: 1, runId: 'r123-offline', persistState: async () => {},
    requireRealDrivers: true, dayState: wf.newDayState('2026-10-17'),
    openCreationPage: async () => ({ header: { originOk: true, accountId: wf.BUSINESS.accountId, commissionOptionPresent: true } }),
    browseProducts: async () => ({ ok: true, selectedIds: IDS30.slice(), attempted: [], cursor: { category: '全部', page: 26 } }),
    bindAccountsToAll: async () => ({ ok: false, reason: 'account-anchor-no-usable-product', rows, failedIds: IDS30.slice() }),
    readMainTable: async () => rows,
    awaitMainTableStable: async () => { stableCalls++; return { ok: true, rows, stableReads: 2 }; },
    repairDraft: async x => { repairs++; args = x; return { ok: false, reason: 'offline-stop-after-proven-removal' }; },
    configurePlan: async () => { throw new Error('must not configure a fully duplicate batch'); },
  });
  assert.equal(repairs, 1);
  assert.equal(res.stage, 'repair');
  assert.equal(args.removeIds.length, 30);
  assert.equal(args.requireNextPage, true);
  assert.equal(args.repairMode, 'whole-batch-removal');
  assert.ok(stableCalls >= 1);
});

// ── 8c. the REAL bind driver returns rows/failedIds, not a bare anchor stop ─
test('R123 the real bind driver attaches verifiable rows and failedIds on failure', async () => {
  const ids = IDS30.slice();
  const baseRows = ids.map(productId => ({ productId, text: 'ID：' + productId, manualAccounts: 0, manualEvidence: true, manualCountKnown: true, autoPullOnly: false, reviewFailed: false }));
  let active = ids[0];
  const page = {
    url: () => 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi?aavid=' + wf.BUSINESS.accountId,
    evaluate: async (fn, arg) => {
      if (fn === rp.readMainTableInPage) return { ok: true, rows: baseRows };
      if (fn === rp.bindingDrawerSnapshotInPage) {
        return {
          ok: true, spinnerCount: 0, headerLabelDisabled: false,
          rows: [{ ids: ['79863866'], text: wf.ALREADY_PLANNED_MARK + ' 查看详情', checked: false, labelDisabled: true }],
          panelProductIds: ids, activeProductIds: [active], selectedCount: 0, totalCount: 30,
        };
      }
      if (fn === rp.selectBindingDrawerPanelInPage) { active = String(arg); return { clicked: true, id: String(arg) }; }
      if (fn === rp.guidanceActionInPage) return { present: false, unknown: null, roots: [] };
      return null;
    },
  };
  const driver = rp.createRealDrivers({
    page, managerPage: {}, context: {}, dayState: { lastSelected: [], cursor: { seenProductIds: [] } }, persist: async () => {},
    publishedIds: new Set(), attemptedSet: new Set(), hints: {}, accountId: wf.BUSINESS.accountId, opened: {}, projectRoot: __dirname,
    planNumber: 1, runId: 'offline', nativeScrollTimeoutMs: 60,
  });
  const res = await driver.bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'account-anchor-no-usable-product');
  assert.equal(res.rows.length, 30, 'the real rows are returned, never swallowed');
  assert.equal(res.failedIds.length, 30, 'every explicitly duplicate row is named');
  assert.ok(res.rows.every(r => r.alreadyPlanned === true), 'the settled panel copy is carried per product');
  assert.equal(res.bindingEvidence.proven, true);
});

// ── 9. management readback: bounded refresh, exact match, new id ────────────
function mgmtDriver({ rowsBefore, rowsAfter, identity = wf.BUSINESS.accountId, reloads = 0 }) {
  let reads = 0, gotoCount = 0, reloadCount = 0, tabCount = 0;
  const managerPage = {
    goto: async () => { gotoCount++; },
    reload: async () => { reloadCount++; },
    evaluate: async (fn, arg) => {
      if (fn === rp.readManagementRowsInPage) { reads++; return reads === 1 ? rowsBefore : rowsAfter; }
      if (typeof fn === 'string') { tabCount++; return { clicked: true }; }
      if (fn && fn.name === 'readIdentity') return { accountId: identity, url: 'https://qianchuan.jinritemai.com/overall-prom?aavid=' + identity, hasSubTabs: true };
      throw new Error('unexpected management evaluate ' + (fn && fn.name));
    },
  };
  const driver = rp.createRealDrivers({
    page: null, managerPage, context: {}, dayState: {}, persist: async () => {}, publishedIds: new Set(),
    attemptedSet: new Set(), hints: {}, accountId: wf.BUSINESS.accountId, opened: {}, projectRoot: __dirname, planNumber: 1, runId: 'offline',
    readAccountInPage: function readIdentity() {}, clickSubTab: label => 'subtab:' + label,
    managementHydrateTimeoutMs: 200, successManagementReadTimeoutMs: 200, managementTabSettleTimeoutMs: 200, managementRowCompleteTimeoutMs: 200,
  });
  return { driver, stats: () => ({ reads, gotoCount, reloadCount, tabCount }) };
}
const PLAN_NAME = '2026-10-17_千川乘方_12:00:00';
const completeRow = (over = {}) => ({ planId: '1879276940967959', planName: PLAN_NAME, text: PLAN_NAME, productCount: 30, accountCount: 2, roi: 15, dailyBudget: 300, commissionIncluded: true, status: '投放中', ...over });
test('R123 stale SPA (46 rows, no same-name row) refreshes once, then 47-row exact new-id row succeeds', async () => {
  const h = mgmtDriver({ rowsBefore: { accountId: wf.BUSINESS.accountId, rowCount: 0, rows: [] }, rowsAfter: { accountId: wf.BUSINESS.accountId, rowCount: 1, rows: [completeRow()] } });
  const row = await h.driver.readManagementRow({ planName: PLAN_NAME, accountId: wf.BUSINESS.accountId });
  assert.equal(row.found, true); assert.equal(row.uniqueRow, true); assert.equal(row.refreshed, true);
  assert.equal(h.stats().reloadCount, 1, 'exactly one read-only refresh');
  assert.equal(h.stats().gotoCount, 1, 'no extra publish/reopen navigation');
  const outcome = wf.classifyPublishOutcome(row, { planName: PLAN_NAME, accountId: wf.BUSINESS.accountId, existingPlanIds: ['1879276940967958'], productsPerPlan: 30, roi: 15, dailyBudget: 300 });
  assert.equal(outcome.outcome, 'success');
  assert.equal(outcome.planId, '1879276940967959');
});

test('R123 refreshed row is still refused for old id / wrong shop / fuzzy name / missing field / other params', async () => {
  const cases = [
    ['old-id', completeRow({ planId: '1879276940967958' }), { existingPlanIds: ['1879276940967958'] }, 'plan-id-not-new'],
    ['wrong-shop', completeRow({ accountId: '9999999999999999' }), {}, 'account-identity-mismatch'],
    ['fuzzy-name', completeRow({ planName: PLAN_NAME + ' 副本' }), {}, 'plan-name-mismatch'],
    ['missing-field', completeRow({ dailyBudget: null }), {}, 'field-mismatch'],
    ['other-roi', completeRow({ roi: 12 }), {}, 'field-mismatch'],
    ['other-budget', completeRow({ dailyBudget: 301 }), {}, 'field-mismatch'],
    ['no-commission', completeRow({ commissionIncluded: false }), {}, 'field-mismatch'],
    ['count-29', completeRow({ productCount: 29 }), {}, 'field-mismatch'],
    ['account-0', completeRow({ accountCount: 0 }), {}, 'field-mismatch'],
  ];
  for (const [name, row, extra, reason] of cases) {
    const rb = { found: true, uniqueRow: true, accountId: wf.BUSINESS.accountId, ...row };
    if (name === 'wrong-shop') rb.accountId = row.accountId;
    const exp = { planName: PLAN_NAME, accountId: wf.BUSINESS.accountId, existingPlanIds: [], productsPerPlan: 30, roi: 15, dailyBudget: 300, ...extra };
    const out = wf.classifyPublishOutcome(rb, exp);
    assert.notEqual(out.outcome, 'success', name);
    assert.match(String(out.reason), new RegExp(reason), name + ' -> ' + out.reason);
  }
});

// ── 10. known cancel-confirm: unique enabled button, no force ───────────────
function drawerWithConfirm({ confirms = 1, copy = '确定要取消选择抖音号吗？ 不选择抖音号商品将无法正常进行投放，确定取消吗', disabled = false } = {}) {
  const drawer = El('div', { class: 'ovui-modal', text: '为商品添加抖音号' }, [El('button', { text: '取消' })]);
  if (confirms === 0) return drawer;
  const btns = [];
  for (let i = 0; i < confirms; i++) btns.push(El('button', { text: '确定', disabled }));
  const confirm = El('div', { class: 'ovui-modal', text: copy }, [
    El('button', { text: '再想想' }), ...btns,
  ]);
  return El('body-wrap', {}, [drawer, confirm]);
}
test('R123 cancel-confirm is copy-bound and clicks one enabled 确定; duplicates/drift/disabled stay zero-click', () => {
  const account = wf.BUSINESS.accountId;
  const loc = { pathname: '/uni-creation/overall-product-multi', search: '?aavid=' + account };
  const ok = makeCtx([drawerWithConfirm()], loc);
  const s = plain(ok.run(rp.accountDrawerCancelConfirmInPage, { mode: 'snapshot', accountId: account }));
  assert.equal(s.present, true); assert.equal(s.known, true); assert.equal(s.count, 1);
  assert.equal(plain(ok.run(rp.accountDrawerCancelConfirmInPage, { mode: 'step', accountId: account })).clicked, true);

  const two = makeCtx([drawerWithConfirm({ confirms: 2 })], loc);
  assert.equal(plain(two.run(rp.accountDrawerCancelConfirmInPage, { mode: 'snapshot', accountId: account })).known, true);
  assert.throws(() => two.run(rp.accountDrawerCancelConfirmInPage, { mode: 'step', accountId: account }), /cancel-confirm-button-not-unique/);

  const drift = makeCtx([drawerWithConfirm({ copy: '确定要取消选择抖音号吗？ 再想想' })], loc);
  assert.throws(() => drift.run(rp.accountDrawerCancelConfirmInPage, { mode: 'step', accountId: account }), /cancel-confirm-copy-drift/);

  const disabled = makeCtx([drawerWithConfirm({ disabled: true })], loc);
  assert.throws(() => disabled.run(rp.accountDrawerCancelConfirmInPage, { mode: 'step', accountId: account }), /cancel-confirm-button-not-enabled/);

  const wrongRoute = makeCtx([drawerWithConfirm()], { pathname: '/overall-prom', search: '?aavid=' + account });
  assert.throws(() => wrongRoute.run(rp.accountDrawerCancelConfirmInPage, { mode: 'snapshot', accountId: account }), /cancel-confirm-page-not-authorized/);
});

test('R123 driver closes the known cancel-confirm BEFORE re-opening the anchor (positive close proof)', async () => {
  const ids = IDS30.slice();
  const rows = ids.map((productId, i) => ({ productId, manualAccounts: i === 0 ? 2 : 0, manualEvidence: i === 0, autoPullOnly: false, reviewFailed: false }));
  const clicks = [];
  const state = { drawerClosed: false, confirmVisible: false };
  const page = {
    evaluate: async (fn, arg) => {
      if (fn === rp.readMainTableInPage) return { ok: true, rows };
      if (fn === rp.bindingDrawerSnapshotInPage) return state.drawerClosed ? { ok: false, reason: 'account-drawer-not-unique', count: 0 } : { ok: true, rows: [], panelProductIds: [], activeProductIds: [], selectedCount: null, totalCount: null };
      if (fn === rp.cancelAutoOpenedDrawerInPage) { clicks.push('cancel'); state.confirmVisible = true; return { cancelled: true }; }
      if (fn === rp.accountDrawerCancelConfirmInPage) {
        const mode = arg && arg.mode;
        if (mode === 'snapshot') return { present: state.confirmVisible, known: true, count: 1, drawerPresent: true };
        clicks.push('confirm'); state.confirmVisible = false; state.drawerClosed = true; return { clicked: true };
      }
      if (fn === rp.openAnchorManagementInPage) { clicks.push('open'); return { ok: false }; }
      return null;
    },
  };
  const driver = rp.createRealDrivers({
    page, managerPage: {}, context: {}, dayState: { lastSelected: [], cursor: { seenProductIds: [] } }, persist: async () => {},
    publishedIds: new Set(), attemptedSet: new Set(), hints: {}, accountId: wf.BUSINESS.accountId, opened: {}, projectRoot: __dirname,
    planNumber: 1, runId: 'offline', nativeScrollTimeoutMs: 100, cancelConfirmHandling: true,
  });
  const res = await driver.bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, false);
  assert.deepEqual(clicks, ['cancel', 'confirm', 'open'], 'cancel -> confirm -> proven close -> open');
  assert.equal(state.drawerClosed, true);
});

// ── 11. binding failure info enters the prepare/repair contract ─────────────
test('R123 bind failure ids + actual rows reach repairDraft without weakening removal evidence', async () => {
  let repairArgs = null;
  const late = readyRows(); late[4].manualAccounts = 0; late[4].manualEvidence = true;
  let stableCalls = 0;
  const res = await wf.preparePlan({
    businessDate: '2026-10-17', planNumber: 1, runId: 'r123-offline', persistState: async () => {},
    openCreationPage: async () => ({ header: { originOk: true, accountId: wf.BUSINESS.accountId, commissionOptionPresent: true } }),
    browseProducts: async () => ({ ok: true, selectedIds: IDS30.slice(), attempted: [], cursor: { category: '全部', page: 1 } }),
    bindAccountsToAll: async () => ({ ok: true, accountIds: wf.BUSINESS.boundAccounts.slice(), failedIds: [IDS30[4]], rows: late }),
    readMainTable: async () => late,
    awaitMainTableStable: async () => { stableCalls++; return { ok: true, rows: late, stableReads: 2 }; },
    repairDraft: async args => { repairArgs = args; return { ok: false, reason: 'offline-stop' }; },
    configurePlan: async () => ({ ok: true, planName: 'P' }),
  });
  assert.equal(res.status, 'stopped');
  assert.equal(res.stage, 'repair');
  assert.deepEqual(repairArgs.failedIds, [IDS30[4]]);
  assert.ok(Array.isArray(repairArgs.bindingRows));
  assert.equal(repairArgs.repairMode, 'partial-removal');
  assert.equal(repairArgs.requireNextPage, true);
  assert.deepEqual(repairArgs.removeIds, [IDS30[4]]);
  assert.ok(stableCalls >= 1);
});

// ── 12. hover-only duplicate tooltip: attributable, per account, fail-closed ─
// The REAL copy lives in a floating tooltip that appears only after the disabled
// ovui checkbox label is hovered. The fixture is a real (offline) DOM; the driver
// chain and the in-page callback are the production ones.
const A1 = '79863866', A2 = '9zmao_fushi';
function tooltipFixture(ids) {
  const panels = ids.map(id => El('div', { class: 'panel', attrs: { id } }));
  const table = El('table', {});
  const tooltip = El('div', { class: 'ovui-tooltip', attrs: { role: 'tooltip' }, text: '', rect: [0, 0] });
  const root = El('div', { class: 'ovui-modal', text: '为商品添加抖音号' }, [...panels, table]);
  const dom = makeCtx([root, tooltip], { pathname: '/uni-creation/overall-product-multi', search: '?aavid=' + wf.BUSINESS.accountId });
  const state = { active: ids[0], accounts: {}, mode: 'duplicate', residual: false, hovered: false };
  const rebuild = () => {
    for (const p of panels) p.className = 'panel';
    const active = panels.find(p => p.getAttribute('id') === state.active);
    if (active) active.className = 'panel active';
    table.__kids = [];
    for (const acct of (state.accounts[state.active] || [])) {
      const box = El('input', { attrs: { type: 'checkbox' }, rect: [16, 16] });
      const label = El('label', { class: 'ovui-checkbox ovui-checkbox--disabled' }, [box]);
      label.addEventListener('mouseover', () => {
        state.hovered = true;
        tooltip.__rect = [200, 40];
        tooltip.__text = state.mode === 'unknown' ? '该抖音号暂不可用' : '商品与该抖音号已存在商品投放计划 查看详情';
      });
      const hide = () => { state.hovered = false; tooltip.__rect = [0, 0]; };
      label.addEventListener('mouseout', hide);
      label.addEventListener('mouseleave', hide);
      const row = El('tr', {}, [El('td', { text: 'ID：' + acct }), El('td', {}, [label])]);
      row.parent = table; table.__kids.push(row);
    }
    const shown = state.residual || state.hovered;
    tooltip.__rect = shown ? [200, 40] : [0, 0];
    if (shown) tooltip.__text = state.mode === 'unknown' ? '该抖音号暂不可用' : '商品与该抖音号已存在商品投放计划 查看详情';
  };
  return { dom, state, rebuild };
}
function tooltipPage(ids, opt = {}) {
  const fx = tooltipFixture(ids);
  let active = ids[0];
  const accountsFor = id => (opt.twoRow === id ? [A1, A2] : [A1]);
  const page = {
    url: () => 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi?aavid=' + wf.BUSINESS.accountId,
    evaluate: async (fn, arg) => {
      if (fn === rp.readMainTableInPage) return { ok: true, rows: ids.map(productId => ({ productId, text: 'ID：' + productId, manualAccounts: 0, manualEvidence: true, manualCountKnown: true, autoPullOnly: false, reviewFailed: false })) };
      if (fn === rp.bindingDrawerSnapshotInPage) return {
        ok: true, spinnerCount: 0, panelProductIds: ids.slice(), activeProductIds: [active], selectedCount: 0, totalCount: 30, rowSignature: 'sig',
        headerLabelDisabled: true, rows: accountsFor(active).map(a => ({ ids: [a], checked: false, labelDisabled: opt.usable === active ? false : true })),
      };
      if (fn === rp.selectBindingDrawerPanelInPage) { active = String(arg); fx.state.hovered = false; if (opt.driftAfterSelect === active) active = ids[0]; return { clicked: true, id: String(arg) }; }
      if (fn === rp.bindingRowTooltipInPage) {
        fx.state.active = active;
        fx.state.accounts[active] = accountsFor(active);
        fx.state.mode = (opt.unknownTooltip === active || opt.unknownTooltip === '*') ? 'unknown' : 'duplicate';
        fx.state.residual = opt.residual === active;
        fx.rebuild();
        return fx.dom.run(rp.bindingRowTooltipInPage, arg);
      }
      if (fn === rp.guidanceActionInPage) return { present: false, unknown: null, roots: [] };
      if (fn === rp.openAnchorManagementInPage) return { ok: false };
      throw new Error('Unexpected ' + fn.name);
    },
  };
  return page;
}
function tooltipDriver(ids, opt) {
  return rp.createRealDrivers({
    page: tooltipPage(ids, opt), managerPage: {}, context: {}, dayState: { lastSelected: [], cursor: { seenProductIds: [] } }, persist: async () => {},
    publishedIds: new Set(), attemptedSet: new Set(), hints: {}, accountId: wf.BUSINESS.accountId, opened: {}, projectRoot: __dirname,
    planNumber: 1, runId: 'offline', nativeScrollTimeoutMs: 80, cancelConfirmHandling: true,
  });
}
test('R125 hover tooltip on every account row of all 30 panels proves a real whole-batch duplicate', async () => {
  const ids = IDS30.slice();
  const res = await tooltipDriver(ids, { twoRow: ids[4] }).bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, false);
  assert.equal(res.duplicateProven, true, JSON.stringify(res.reason));
  assert.equal(res.rows.length, 30);
  assert.equal(res.failedIds.length, 30);
  assert.ok(res.rows.every(r => r.alreadyPlanned === true), 'each product carries its own hover proof');
  assert.ok(res.rows[4].text.includes(wf.ALREADY_PLANNED_MARK));
  assert.equal(res.bindingEvidence.proven, true);
});
test('R125 unknown hover copy / residual tooltip / usable account each void that product proof', async () => {
  const cases = [{ opt: { unknownTooltip: IDS30[3] }, bad: IDS30[3] }, { opt: { residual: IDS30[5] }, bad: IDS30[5] }, { opt: { usable: IDS30[7] }, bad: IDS30[7] }];
  for (const { opt, bad } of cases) {
    const ids = IDS30.slice();
    const res = await tooltipDriver(ids, opt).bindAccountsToAll({ productIds: ids });
    assert.equal(res.ok, false);
    assert.notEqual(res.duplicateProven, true, JSON.stringify(opt));
    const badRow = res.rows.find(r => String(r.productId) === String(bad));
    assert.notEqual(badRow.alreadyPlanned, true, 'the unproven product is never marked duplicate: ' + JSON.stringify(opt));
    if (opt.usable) {
      // A usable-account panel voids BOTH channels: not a duplicate AND not "no usable
      // account", so the batch stays non-removable on the original bare stop.
      assert.equal(res.bindingEvidence.proven, false, 'an unproven panel never makes the batch removable: ' + JSON.stringify(opt));
      assert.notEqual(res.accountUnavailableProven, true, JSON.stringify(opt));
      assert.ok(res.rows.every(r => r.accountUnavailableProven !== true), JSON.stringify(opt));
    } else {
      // R130: the DUPLICATE channel stays voided for the unknown/residual-copy panel, but
      // this fixture's 30 panels are ALL stably label-disabled, which is exactly the narrow
      // independent "no usable account" proof for the whole batch. The other 29 rows keep
      // their own genuine hover-duplicate evidence via the pre-existing settled merge.
      assert.equal(res.accountUnavailableProven, true, 'a stably all-disabled 30/30 batch carries the R130 proof: ' + JSON.stringify(opt));
      assert.equal(res.bindingEvidence.proven, true, JSON.stringify(opt));
      assert.ok(res.rows.every(r => r.accountUnavailableProven === true), JSON.stringify(opt));
      assert.equal(badRow.accountUnavailableProven, true, JSON.stringify(opt));
    }
  }
});

// ── 12b. stable main-table read must not drop the binder's hover proof ───────
test('R125 a fresh stable read without the tooltip text still repairs the hover-proven batch', async () => {
  const ids = IDS30.slice();
  let repairArgs = null;
  const bindingRows = ids.map(productId => ({ productId, text: 'ID：' + productId + ' ' + wf.ALREADY_PLANNED_MARK, manualAccounts: 0, manualEvidence: true, alreadyPlanned: true, duplicateEvidence: 'hover-tooltip' }));
  const fresh = ids.map(productId => ({ productId, text: 'ID：' + productId, manualAccounts: 0, manualEvidence: true, manualCountKnown: true }));
  const res = await wf.preparePlan({
    requireRealDrivers: true, businessDate: '2026-10-17', planNumber: 1, runId: 'r125-merge', persistState: async () => {},
    dayState: wf.newDayState('2026-10-17'), catalogRemainingIds: [],
    openCreationPage: async () => ({ header: { originOk: true, accountId: wf.BUSINESS.accountId, commissionOptionPresent: true } }),
    browseProducts: async () => ({ ok: true, selectedIds: ids, attempted: [], cursor: { category: '全部', page: 26 } }),
    bindAccountsToAll: async () => ({ ok: false, reason: 'account-anchor-no-usable-product', rows: bindingRows, failedIds: ids, duplicateProven: true }),
    readMainTable: async () => fresh,
    awaitMainTableStable: async () => ({ ok: true, rows: fresh, stableReads: 3 }),
    repairDraft: async args => { repairArgs = args; return { ok: false, reason: 'offline-stop-after-proven-removal' }; },
    configurePlan: async () => { throw new Error('must not configure a duplicate batch'); },
  });
  assert.equal(res.stage, 'repair', JSON.stringify(res.reason));
  assert.equal(repairArgs.removeIds.length, 30);
  assert.equal(repairArgs.provenDuplicateIds.length, 30, 'the explicit proof is handed to repair');
  assert.equal(repairArgs.repairMode, 'whole-batch-removal');
});

// ── 13. repair ordering: close the drawer BEFORE the first removal ───────────
function repairPage({ drawer = false, confirmKnown = true, rows = null, supported = true } = {}) {
  const calls = [];
  const state = { drawer, confirm: false };
  const page = {
    url: () => 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi?aavid=' + wf.BUSINESS.accountId,
    evaluate: async (fn, arg) => {
      if (fn === rp.readMainTableInPage) return { ok: true, rows: rows || [{ productId: IDS30[0], text: 'ID：' + IDS30[0], reviewFailed: true, manualAccounts: 1, manualEvidence: true }] };
      if (!supported && (fn === rp.bindingDrawerSnapshotInPage || fn === rp.cancelAutoOpenedDrawerInPage || fn === rp.accountDrawerCancelConfirmInPage || fn === rp.bindingOverlaySnapshotInPage)) throw new Error('Unexpected ' + fn.name);
      if (fn === rp.bindingDrawerSnapshotInPage) return state.drawer ? { ok: true, rows: [], count: 1 } : { ok: false, count: 0 };
      if (fn === rp.cancelAutoOpenedDrawerInPage) { calls.push('cancel'); state.confirm = true; return { cancelled: true }; }
      if (fn === rp.accountDrawerCancelConfirmInPage) {
        if (arg.mode === 'snapshot') return { present: state.confirm, known: confirmKnown, count: state.confirm ? 1 : 0, drawerPresent: state.drawer };
        calls.push('confirm'); state.confirm = false; state.drawer = false; return { clicked: true };
      }
      if (fn === rp.bindingOverlaySnapshotInPage) return { accountDrawerCount: state.drawer ? 1 : 0, blockingOverlayPresent: state.confirm };
      if (fn === rp.removeNativeCardInPage) { calls.push('remove'); throw new Error('ROOT_END_AFTER_FIRST_REMOVAL'); }
      throw new Error('Unexpected ' + fn.name);
    },
  };
  return { page, calls, state };
}
function repairDriver(page, extra = {}) {
  return rp.createRealDrivers({
    page, managerPage: {}, context: {}, dayState: { lastSelected: [IDS30[0]], cursor: { category: '全部', page: 5 } }, persist: async () => {},
    publishedIds: new Set(), attemptedSet: new Set(), hints: {}, accountId: wf.BUSINESS.accountId, opened: {}, projectRoot: __dirname,
    planNumber: 1, runId: 'r125-offline', cancelConfirmHandling: true, nativeScrollTimeoutMs: 80, ...extra,
  });
}
test('R125 repair closes the open drawer (cancel -> confirm -> proven closed) before the first removal', async () => {
  const h = repairPage({ drawer: true });
  const drv = repairDriver(h.page);
  let err = null;
  try { await drv.repairDraft({ removeIds: [IDS30[0]], backfillCount: 1, repairMode: 'partial-removal' }); } catch (e) { err = e; }
  assert.equal(err && err.message, 'ROOT_END_AFTER_FIRST_REMOVAL');
  assert.deepEqual(h.calls, ['cancel', 'confirm', 'remove']);
  assert.equal(h.state.drawer, false);
  assert.equal(h.state.confirm, false);
});
test('R125 an unknown cancel-confirm leaves the drawer open and performs zero removals', async () => {
  const h = repairPage({ drawer: true, confirmKnown: false });
  const res = await repairDriver(h.page).repairDraft({ removeIds: [IDS30[0]], backfillCount: 1, repairMode: 'partial-removal' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'draft-removal-cancel-confirm-unknown');
  assert.deepEqual(h.calls, ['cancel'], 'never clicks an unproven confirm and never removes');
});
test('R125 no drawer initially: proof still runs and the legacy path keeps removing', async () => {
  const h = repairPage({ drawer: false });
  let err = null;
  try { await repairDriver(h.page).repairDraft({ removeIds: [IDS30[0]], backfillCount: 1, repairMode: 'partial-removal' }); } catch (e) { err = e; }
  assert.equal(err && err.message, 'ROOT_END_AFTER_FIRST_REMOVAL');
  assert.deepEqual(h.calls, ['remove'], 'no cancel on a drawer-less page');
});
test('R125 a page without the drawer census keeps the pre-R125 path (no unknown evaluate regression)', async () => {
  const h = repairPage({ drawer: false, supported: false });
  let err = null;
  try { await repairDriver(h.page).repairDraft({ removeIds: [IDS30[0]], backfillCount: 1, repairMode: 'partial-removal' }); } catch (e) { err = e; }
  assert.equal(err && err.message, 'ROOT_END_AFTER_FIRST_REMOVAL');
  assert.deepEqual(h.calls, ['remove']);
});
test('R125 repair accepts a hover-proven duplicate id even when the fresh row has no manual evidence', async () => {
  const rows = [{ productId: IDS30[0], text: 'ID：' + IDS30[0], manualAccounts: null, manualEvidence: false, manualCountKnown: false }];
  const h = repairPage({ drawer: false, rows });
  let err = null;
  try { await repairDriver(h.page).repairDraft({ removeIds: [IDS30[0]], backfillCount: 1, repairMode: 'partial-removal', provenDuplicateIds: [IDS30[0]] }); } catch (e) { err = e; }
  assert.equal(err && err.message, 'ROOT_END_AFTER_FIRST_REMOVAL');
  assert.deepEqual(h.calls, ['remove']);

  const h2 = repairPage({ drawer: false, rows });
  const res = await repairDriver(h2.page).repairDraft({ removeIds: [IDS30[0]], backfillCount: 1, repairMode: 'partial-removal' });
  assert.equal(res.ok, false);
  assert.match(res.reason, /removal-lacks-explicit-current-row-evidence/);
  assert.deepEqual(h2.calls, [], 'without the proof nothing is removed');
});

// ── 14. S126: production drawer-contract exceptions must fail closed ─────────
test('R126 a production drawer census read exception is never treated as a legacy fake', async () => {
  const h = repairPage({ drawer: false, supported: false });
  const res = await repairDriver(h.page, { requireDrawerStability: true })
    .repairDraft({ removeIds: [IDS30[0]], backfillCount: 1, repairMode: 'partial-removal' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'account-drawer-census-unreadable-before-draft-removal');
  assert.deepEqual(h.calls, [], 'an unreadable production census performs zero removals');
});
test('R126 a production unknown authorization URL never defaults to allow', async () => {
  const h = repairPage({ drawer: false });
  h.page.url = () => { throw new Error('url unavailable'); };
  const res = await repairDriver(h.page, { requireDrawerStability: true })
    .repairDraft({ removeIds: [IDS30[0]], backfillCount: 1, repairMode: 'partial-removal' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'draft-removal-page-not-authorized');
  assert.deepEqual(h.calls, [], 'an unknown production URL performs zero removals');
});

// ── 15. S127: legacy attempts stores that legitimately omit unused optional maps ─
// The guard store requires `consumed`; `finalConsumed` / `reopenConsumed` are optional and an
// existing legacy file may simply not contain them. The pre-initial policy-cancel proof must
// read an ABSENT optional map as empty (never rewrite it into the source), while null / array /
// scalar optional values and a missing required `consumed` stay malformed.
const S127fs = require('node:fs');
const S127os = require('node:os');
const S127path = require('node:path');
const S127_CANCEL = 'scheduled-policy-drift-before-initial:policy-disabled-or-not-autoconfirmed';
const S127_SHOP = '敏敏高定私服';
const S127_ACCOUNT = '1696626252631053';
const S127_DATE = '2026-10-17';

function s127HistoryRecord(planNumber, status) {
  return { status: status || 'success', businessDate: '2026-10-16', planNumber,
    runId: 'plan-scheduler-2026-10-16-0123456789abcdef', manifestHash: 'ab'.repeat(32) };
}
function s127Store() {
  const store = { consumed: {}, finalConsumed: {} };
  for (let i = 1; i <= 19; i += 1) {
    store.consumed['closed-' + i] = s127HistoryRecord(i);
    store.finalConsumed['closed-' + i] = s127HistoryRecord(i);
  }
  return store;
}
function s127State() {
  const state = wf.newDayState(S127_DATE);
  state.active = { status: 'preparation-stopped', planNumber: 1, reason: S127_CANCEL,
    businessDate: S127_DATE, shop: S127_SHOP, accountId: S127_ACCOUNT };
  return state;
}
function s127WithFiles(mutateStore, fn) {
  const dir = S127fs.mkdtempSync(S127path.join(S127os.tmpdir(), 'r127-legacy-'));
  const stateFile = S127path.join(dir, 'plan-publisher-state.json');
  const attemptsFile = S127path.join(dir, 'plan-publication-attempts.json');
  const store = s127Store();
  mutateStore(store);
  S127fs.writeFileSync(stateFile, JSON.stringify(s127State(), null, 2));
  S127fs.writeFileSync(attemptsFile, JSON.stringify(store, null, 2));
  try { return fn(stateFile, attemptsFile); } finally { S127fs.rmSync(dir, { recursive: true, force: true }); }
}

test('R127 absent optional attempts maps prove zero reuse read-only; historical records and source bytes stay intact', () => {
  for (const mode of ['reopen-omitted-with-history', 'both-optional-omitted', 'all-three-empty-maps']) {
    s127WithFiles((store) => {
      if (mode !== 'all-three-empty-maps') delete store.reopenConsumed;
      if (mode === 'both-optional-omitted') delete store.finalConsumed;
      if (mode === 'all-three-empty-maps') { store.consumed = {}; store.finalConsumed = {}; store.reopenConsumed = {}; }
    }, (stateFile, attemptsFile) => {
      const before = S127fs.readFileSync(attemptsFile, 'utf8');
      const res = rp.provePreInitialPolicyCancelState(stateFile, attemptsFile, S127_DATE,
        { planNumber: 1, shop: S127_SHOP, accountId: S127_ACCOUNT });
      assert.equal(res.ok, true, mode + ': ' + JSON.stringify(res));
      assert.equal(res.proof.method, 'pre-initial-policy-cancel');
      assert.deepEqual(res.proof.zeroConsumptionProof, {
        initialConsumptions: 0, finalConsumptions: 0, reopenConsumptions: 0,
        manualUnresolved: 0, plansContainsNumber: false, confirmationConsumptionsRecorded: false,
      });
      assert.equal(res.proof.sourceHash, rp.preOpenSourceHash(S127fs.readFileSync(stateFile, 'utf8'), before));
      assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(before), 'reopenConsumed'),
        mode === 'both-optional-omitted' ? false : mode === 'all-three-empty-maps', mode + ': absent stays absent');
      assert.equal(S127fs.readFileSync(attemptsFile, 'utf8'), before, mode + ': proof never rewrites the attempts source');
      if (mode === 'reopen-omitted-with-history') {
        assert.equal(Object.keys(JSON.parse(before).consumed).length, 19);
        assert.equal(Object.keys(JSON.parse(before).finalConsumed).length, 19);
      }
    });
  }
});

test('R127 null/array/scalar optional maps and missing/invalid required consumed stay malformed', () => {
  const bad = [
    ['reopen null', s => { s.reopenConsumed = null; }],
    ['reopen array', s => { s.reopenConsumed = []; }],
    ['reopen scalar', s => { s.reopenConsumed = 'bad'; }],
    ['reopen number', s => { s.reopenConsumed = 7; }],
    ['final null', s => { s.finalConsumed = null; }],
    ['final array', s => { s.finalConsumed = []; }],
    ['final scalar', s => { s.finalConsumed = 'bad'; }],
    ['consumed missing', s => { delete s.consumed; }],
    ['consumed null', s => { s.consumed = null; }],
    ['consumed array', s => { s.consumed = []; }],
    ['consumed scalar', s => { s.consumed = 'bad'; }],
    ['today record in consumed', s => { s.consumed.today = { status: 'unknown', businessDate: S127_DATE, planNumber: 1 }; }],
    ['today record in finalConsumed', s => { s.finalConsumed.today = { status: 'pending', businessDate: S127_DATE, planNumber: 1 }; }],
    ['malformed historical record', s => { s.consumed.broken = { status: 'nope', businessDate: '2026-10-16', planNumber: 1 }; }],
  ];
  for (const [name, mutate] of bad) {
    s127WithFiles(mutate, (stateFile, attemptsFile) => {
      const before = S127fs.readFileSync(attemptsFile, 'utf8');
      const res = rp.provePreInitialPolicyCancelState(stateFile, attemptsFile, S127_DATE,
        { planNumber: 1, shop: S127_SHOP, accountId: S127_ACCOUNT });
      assert.equal(res.ok, false, name + ': ' + JSON.stringify(res));
      assert.match(String(res.reason), /^(policy-cancel-attempts-malformed|policy-cancel-attempt-record-(malformed|for-date))$/, name);
      assert.equal(S127fs.readFileSync(attemptsFile, 'utf8'), before, name + ': rejected proof never rewrites the source');
    });
  }
});

// ── 15. R128 panel-navigation target-stop diagnostic ───────────────────────
// The real failure exit `batch-result-panel-target-not-verified` used to return only a reason.
// These cases drive the ACTUAL createRealDrivers().bindAccountsToAll through both entry modes
// (known-partial notice + no-result-modal all-success) and assert the attached diag is the one
// from the LAST fresh read (14 sanitized numeric/identity fields, counts null when no snapshot
// could be read) while the stop is unchanged. Since D45 a definite-zero panel is PROVEN ZERO:
// it proceeds to the draft commit with the exact failedIds and stops later at the main-table
// readback mismatch carrying no diag at all — still a fail-closed stop, never success.
const R128_IDS = IDS30.slice();
const R128_ANCHOR = R128_IDS[0];
const R128_FAIL = R128_IDS[1];
const R128_DIAG_UNKNOWN = {
  phase: 'panel-navigation', spinnerCount: 0, rowCount: 2, knownCheckedCount: 1,
  unknownStateCount: 1, selectedCount: 5, expectedSelectedCount: 1, totalCount: 30,
  expectedTotalCount: 30, panelCount: 30, expectedPanelCount: 30,
  panelSetExactMatch: true, activeCount: 1, activeTargetMatch: true,
};
// buildScheduledPreparationDiagnostic widens the packet whitelist with three further fields
// the driver never emits, so they are pinned to null rather than dropped.
const R128_SCHED_DIAG_BINDING = {
  ...R128_DIAG_UNKNOWN,
  uniqueRowCount: null, malformedIdCount: null, footerMatchesChecked: null,
};
function r128Page(mode, shape) {
  let active = R128_ANCHOR;
  const calls = { commit: 0, warning: 0, header: 0 };
  const rows = R128_IDS.map((productId, i) => ({
    productId, text: 'ID：' + productId, manualAccounts: i === 0 ? 1 : 0,
    manualEvidence: true, manualCountKnown: true, autoPullOnly: false,
    reviewFailed: false, alreadyPlanned: false,
  }));
  const proven = pid => ({
    ok: true, spinnerCount: 0, headerLabelDisabled: false,
    rows: [{ ids: [A1], checked: true, labelDisabled: false }],
    panelProductIds: R128_IDS.slice(), activeProductIds: [pid], selectedCount: 1, totalCount: 30,
  });
  // A "previous" panel stays fully proven; only the panel the batch navigated TO is broken.
  const failing = () => {
    if (shape === 'missing') return null;
    if (shape === 'zero') return {
      ok: true, spinnerCount: 0, headerLabelDisabled: false,
      rows: [{ ids: [A1], checked: false, labelDisabled: false }],
      panelProductIds: R128_IDS.slice(), activeProductIds: [active], selectedCount: 0, totalCount: 30,
    };
    // unknown row state + a footer that disagrees with the known checked count
    return {
      ok: true, spinnerCount: 0, headerLabelDisabled: false,
      rows: [{ ids: [A1], checked: true, labelDisabled: false }, { ids: [A2], checked: undefined, labelDisabled: false }],
      panelProductIds: R128_IDS.slice(), activeProductIds: [active], selectedCount: 5, totalCount: 30,
    };
  };
  const page = {
    url: () => 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi?aavid=' + wf.BUSINESS.accountId,
    evaluate: async (fn, arg) => {
      if (fn === rp.readMainTableInPage) return { ok: true, rows };
      if (fn === rp.bindingDrawerSnapshotInPage) return active === R128_FAIL ? failing() : proven(active);
      if (fn === rp.selectBindingDrawerPanelInPage) { active = String(arg); return { clicked: true, id: String(arg) }; }
      if (fn === rp.selectAllAccountsInPage) { calls.header++; return { clicked: true }; }
      if (fn === rp.applyBatchAccountsInPage) return { clicked: true };
      if (fn === rp.batchAddAllModalSnapshotInPage) return { modalCount: 1, productCount: 29, accountCount: 1, drawerSettled: true };
      if (fn === rp.confirmBatchAddAllModalInPage) return { clicked: true };
      if (fn === rp.batchResultSnapshotInPage) return mode === 'partial'
        ? { present: true, known: true, settled: false }
        : { present: false, known: false, settled: false };
      if (fn === rp.closeKnownPartialResultInPage) return { closed: true };
      if (fn === rp.bindingOverlaySnapshotInPage) return { accountDrawerCount: 1, blockingOverlayPresent: false };
      if (fn === rp.confirmBatchAccountsApplyInPage) { calls.commit++; return { clicked: true }; } // drawer 确定
      if (fn === rp.acceptPartialDraftWarningInPage) { calls.warning++; return { accepted: true }; }
      if (fn === rp.guidanceActionInPage) return { present: false, unknown: null, roots: [] };
      throw new Error('R128 unexpected ' + (fn && fn.name));
    },
  };
  const driver = () => rp.createRealDrivers({
    page, managerPage: {}, context: {}, dayState: { lastSelected: [], cursor: { seenProductIds: [] } }, persist: async () => {},
    publishedIds: new Set(), attemptedSet: new Set(), hints: {}, accountId: wf.BUSINESS.accountId, opened: {}, projectRoot: __dirname,
    planNumber: 1, runId: 'offline-r128', nativeScrollTimeoutMs: 60, cancelConfirmHandling: true,
  });
  return { driver, calls, rows };
}
test('R128 the real bind target stop carries the LAST fresh numeric diag (partial + no-modal full), zero drawer commit', async () => {
  const cases = [
    ['partial unknown-row', 'partial', 'unknown', 'batch-result-panel-target-not-verified', R128_DIAG_UNKNOWN, 0, 0],
    ['no-modal full unknown-row', 'full', 'unknown', 'batch-result-panel-target-not-verified', R128_DIAG_UNKNOWN, 0, 0],
    ['no-modal full definite-zero', 'full', 'zero', 'manual-account-bind-readback-does-not-match-recorded-outcome', undefined, 1, 1],
    ['no-modal full unreadable snapshot', 'full', 'missing', 'batch-result-panel-target-not-verified',
      { phase: 'panel-navigation', spinnerCount: null, rowCount: null, knownCheckedCount: null, unknownStateCount: null,
        selectedCount: null, expectedSelectedCount: null, totalCount: null, expectedTotalCount: 30,
        panelCount: null, expectedPanelCount: 30, panelSetExactMatch: null, activeCount: null, activeTargetMatch: null }, 0, 0],
  ];
  for (const [name, mode, shape, expectedReason, expected, expectedCommits, expectedWarnings] of cases) {
    const fx = r128Page(mode, shape);
    const res = await fx.driver().bindAccountsToAll({ productIds: R128_IDS.slice() });
    assert.equal(res.ok, false, name + ': ' + JSON.stringify(res.reason));
    assert.equal(res.reason, expectedReason, name + ': same fail-closed stop');
    assert.deepEqual(res.diag, expected, name + ': diag must be the LAST fresh read, never an earlier proven panel');
    assert.equal(Object.prototype.hasOwnProperty.call(res, 'duplicateProven'), false, name + ': a failed probe never becomes duplicate proof');
    assert.equal(res.rows.length, 30, name + ': the real rows still reach repair');
    assert.equal(fx.calls.commit, expectedCommits, name + ': exact drawer 确定 count for this stop class (never beyond the proven-zero draft commit)');
    assert.equal(fx.calls.warning, expectedWarnings, name + ': exact partial-warning accept count for this stop class');
    if (expected === undefined) {
      assert.equal(res.diag, undefined, name + ': a readback stop attaches no panel diag at all');
      continue;
    }
    const raw = JSON.stringify(res.diag);
    assert.deepEqual(Object.keys(res.diag).sort(),
      ['activeCount', 'activeTargetMatch', 'expectedPanelCount', 'expectedSelectedCount', 'expectedTotalCount',
        'knownCheckedCount', 'panelCount', 'panelSetExactMatch', 'phase', 'rowCount',
        'selectedCount', 'spinnerCount', 'totalCount', 'unknownStateCount'], name + ': closed sanitized numeric/identity whitelist only');
    assert.equal(raw.includes(A1), false, name + ': no account id');
    assert.equal(raw.includes(A2), false, name + ': no account id');
    assert.equal(raw.includes('ID：'), false, name + ': no row text');
    assert.equal(/https?:|\//.test(raw), false, name + ': no URL/path');
  }
});
test('R128 that panel-navigation diag survives the real preparePlan stop and the scheduler packet verbatim', async () => {
  const fx = r128Page('full', 'unknown');
  const drv = fx.driver();
  let repairs = 0, configured = 0;
  const prep = await wf.preparePlan({
    requireRealDrivers: true, businessDate: '2026-10-17', planNumber: 1, runId: 'r128-prep', persistState: async () => {},
    dayState: wf.newDayState('2026-10-17'), catalogRemainingIds: [],
    openCreationPage: async () => ({ header: { originOk: true, accountId: wf.BUSINESS.accountId, commissionOptionPresent: true } }),
    browseProducts: async () => ({ ok: true, selectedIds: R128_IDS.slice(), attempted: [], cursor: { category: '全部', page: 26 } }),
    bindAccountsToAll: drv.bindAccountsToAll,
    readMainTable: drv.readMainTable,
    awaitMainTableStable: async () => ({ ok: true, rows: fx.rows, stableReads: 3 }),
    repairDraft: async () => { repairs++; return { ok: false, reason: 'offline-stop-after-diagnostic' }; },
    configurePlan: async () => { configured++; return { ok: true, planName: 'r128' }; },
  });
  assert.equal(prep.status, 'stopped', JSON.stringify(prep.reason));
  assert.equal(prep.stage, 'account-binding', 'the precise failing stage survives');
  assert.equal(prep.reason, 'batch-result-panel-target-not-verified', 'the original reason is not swallowed');
  assert.deepEqual(prep.bindingDiag, R128_DIAG_UNKNOWN, 'sanitizeBindingDiagnostic keeps exactly the numeric and identity-boolean fields');
  assert.equal(repairs, 0, 'an unproven batch is never handed to repair');
  assert.equal(configured, 0, 'no configuration after a failed bind');
  const packet = rp.buildScheduledPreparationDiagnostic(prep);
  assert.equal(packet.stage, 'account-binding');
  assert.equal(packet.reason, 'batch-result-panel-target-not-verified', 'the scheduler packet keeps the exact fixed reason literal');
  assert.deepEqual(packet.binding, R128_SCHED_DIAG_BINDING);
  const serialized = JSON.stringify(packet);
  assert.equal(serialized.includes(A1), false);
  assert.equal(serialized.includes(A2), false);
  assert.equal(serialized.includes('ID：'), false);
  assert.equal(/https?:/.test(serialized), false);
  // The closed reason enum stays closed: only exact known literals pass, free text never does.
  assert.equal(rp.buildScheduledPreparationDiagnostic({ stage: 'account-binding', reason: 'sessionid=FAKE_SECRET' }).reason, 'other-preparation-stop');
  assert.equal(rp.buildScheduledPreparationDiagnostic({ stage: 'account-binding', reason: 'batch-result-panel-target-not-verified/../x' }).reason, 'other-preparation-stop');

  // scheduler pass-through: the same failure through the REAL scheduled entry logs the packet
  const r128fs = require('node:fs'), r128os = require('node:os'), r128path = require('node:path');
  const dir = r128fs.mkdtempSync(r128path.join(r128os.tmpdir(), 'r128-sched-'));
  const accountId = '1888123400000001', shopName = 'R128离线诊断透传店';
  const shopRow = { name: shopName, accountId, targetRoi: 17, dailyBudget: 300, enabled: true };
  const readAccountStub = () => {};
  const fakeOpened = {
    target: { evaluate: async fn => (fn === readAccountStub ? { accountId } : { clicked: true }) },
    context: { addInitScript: async () => {} }, browser: {},
  };
  const logs = [];
  const fx2 = r128Page('full', 'unknown');
  const drv2 = fx2.driver();
  const schedDriver = {
    openCreationPage: async () => ({ header: { originOk: true, accountId, commissionOptionPresent: true } }),
    browseProducts: async () => ({ ok: true, selectedIds: R128_IDS.slice(), attempted: [], cursor: { category: '全部', page: 26 } }),
    bindAccountsToAll: drv2.bindAccountsToAll,
    readMainTable: drv2.readMainTable,
    awaitMainTableStable: async () => ({ ok: true, rows: fx2.rows, stableReads: 3 }),
    repairDraft: async () => ({ ok: false, reason: 'offline-scheduler-stop' }),
    configurePlan: async () => ({ ok: true, planName: 'r128-scheduler' }),
    saveCookies: async () => ({ status: 'skipped' }),
  };
  let scheduled;
  try {
    scheduled = await rp.runScheduledPlan(
      { shop: shopName, accountId, boundAccounts: [A1], roi: 17, dailyBudget: 300 },
      {
        projectRoot: dir, stateRoot: dir, businessDate: '2026-10-17',
        nowMs: () => Date.parse('2026-10-17T06:00:00Z'),
        planNumber: 1, plansPerShopPerDay: 3, dailyBudget: 300, roi: 17, autoConfirm: true,
        policy: { enabled: true, autoConfirm: true, plansPerShopPerDay: 3, dailyBudget: 300 },
        loadConfig: () => ({ ready: true, config: { login: {}, shops: [shopRow] } }),
        onLog: (level, msg) => logs.push(level + ' ' + msg),
        readers: {
          openChengfangShop: async () => fakeOpened, readChengfangAccountInPage: readAccountStub,
          clickChengfangSubTab: () => () => ({ clicked: true }), closeBrowser: async () => {},
        },
        driversFactory: () => schedDriver,
      },
    );
  } finally {
    r128fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(scheduled && typeof scheduled === 'object', 'scheduled entry returned nothing');
  assert.equal(scheduled.reason, 'prepare-stopped:batch-result-panel-target-not-verified', 'the durable/result reason keeps the original literal: ' + JSON.stringify(scheduled.reason));
  assert.equal(scheduled.noAction, true);
  const diagLines = logs.filter(line => line.includes('scheduled-preparation-diagnostic '));
  assert.equal(diagLines.length, 1, 'exactly one sanitized packet is logged: ' + JSON.stringify(logs));
  const logged = JSON.parse(diagLines[0].slice(diagLines[0].indexOf('scheduled-preparation-diagnostic ') + 'scheduled-preparation-diagnostic '.length));
  assert.equal(logged.stage, 'account-binding');
  assert.equal(logged.reason, 'batch-result-panel-target-not-verified');
  assert.deepEqual(logged.binding, R128_SCHED_DIAG_BINDING);
  const all = logs.join('\n');
  assert.equal(all.includes(A1), false);
  assert.equal(all.includes(A2), false);
  assert.equal(all.includes('ID：'), false);
  assert.equal(fx2.calls.commit, 0, 'scheduler failure still performs zero drawer 确定');
});

// ── 14. R129 catalog continuation: the REAL browseProducts execution path ───
// Covers the 2026-10-20 whole-batch incident: a native viewport with no fresh batch
// / no new DOM id is an UNKNOWN stall, never EOF; a proven hasMore=false chain is the
// only honest exhaustion; a numeric requireNextPage repair really walks the platform
// pager forward from the persisted page; attempted/removed ids are never re-picked and
// the durable cursor never rewinds across a simulated restart. Everything runs through
// the production browseProducts / nativeAdvance / changePage / commitPicker chain with
// a fake page + fake catalog network. Zero browser, zero network, zero publish.
const mkIds = (prefix, n) => Array.from({ length: n }, (_, i) => prefix + String(i).padStart(17 - prefix.length, '0'));
const NATIVE_CAT_SET = ['店铺新品', '破圈尖货', '搜索趋势'];
function browseHarness(cfg) {
  const accountId = wf.BUSINESS.accountId;
  const OBS = { token: 'obs-r129' };
  const tabState = {};
  for (const t of Object.keys(cfg.tabs || {})) tabState[t] = { windows: cfg.tabs[t], loaded: 0, chain: '0', steps: 0 };
  const numericOverride = cfg.numericPages || {};
  const defaultPageIds = p => mkIds('9' + String(p).padStart(4, '0'), 15);
  const idsForPage = p => numericOverride[p] || defaultPageIds(p);
  const state = { cat: cfg.initialCategory || '全部', page: cfg.initialPage || 1, selected: new Set(), closed: false, pagePath: [], pagerClicks: 0 };
  const handlers = { request: [], response: [] };
  function emitCatalog(tab) {
    const st = tabState[tab];
    if (!st || st.loaded >= st.windows.length) return false;
    const w = st.windows[st.loaded];
    st.loaded += 1;
    const requestCursor = st.chain;
    const nextCursor = 'rc-' + tab + '-' + st.loaded;
    const url = rp.CATALOG_ORIGIN + rp.CATALOG_PATH + '?aavid=' + accountId + '&tab=' + tab + '&cursor=' + requestCursor;
    const request = { method: () => 'GET', url: () => url };
    for (const h of handlers.request.slice()) h(request);
    const body = { status_code: 0, data: { productListInfos: w.ids.map(id => ({ productInfo: { id } })), pagination: { mode: 3, hasMore: w.hasMore, cursor: nextCursor } } };
    const response = { request: () => request, status: () => 200, json: async () => body };
    for (const h of handlers.response.slice()) h(response);
    st.chain = nextCursor;
    return true;
  }
  function nativeCards(tab) {
    const st = tabState[tab]; if (!st) return [];
    const out = []; const seen = new Set();
    for (let i = 0; i < st.loaded; i++) for (const id of st.windows[i].ids) if (!seen.has(id)) { seen.add(id); out.push(id); }
    return out;
  }
  function snapshot() {
    if (state.closed) return { ok: false, reason: 'picker-submitted-closed' };
    const ids = NATIVE_CAT_SET.includes(state.cat) ? nativeCards(rp.catalogTabForCategory(state.cat)) : idsForPage(state.page);
    const cards = ids.map(id => ({ id, text: 'ID：' + id, checked: state.selected.has(id), disabled: false, checkboxCount: 1 }));
    // pickerBatchStateMatches contract: selectedCount is THIS batch's selection (base 0 here)
    // and remainingCapacity is the batch capacity 30-base, constant during the run.
    return { ok: true, activeTabs: [state.cat], cards, selectedCount: cards.filter(c => c.checked).length, remainingCapacity: 30 };
  }
  function observeObj() {
    return {
      observation: OBS,
      url: 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi?aavid=' + accountId,
      elements: [{ text: '下一步', tag: 'BUTTON', index: 0 }],
      pagination: { currentPage: state.page, pageCount: null, modalPresent: !state.closed, inProductModal: !state.closed, items: [{ kind: 'next', index: 0, disabled: false }] },
    };
  }
  const page = {
    on: (ev, fn) => { handlers[ev] = (handlers[ev] || []).concat(fn); },
    removeListener: (ev, fn) => { if (handlers[ev]) handlers[ev] = handlers[ev].filter(f => f !== fn); },
    url: () => 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi?aavid=' + accountId,
    evaluate: async (fn, arg) => {
      if (fn === rp.drawerSnapshotInPage) return snapshot();
      if (fn === rp.openPickerInPage) { state.closed = false; return true; }
      if (fn === rp.clickDrawerTabInPage) {
        state.cat = String(arg);
        const tab = rp.catalogTabForCategory(state.cat);
        if (tab && tabState[tab] && tabState[tab].loaded === 0) emitCatalog(tab);
        return { clicked: true, alreadyActive: false };
      }
      if (fn === rp.nativeScrollStateInPage) return { ok: true, scrollTop: 0, scrollHeight: 2460, clientHeight: 670, cardCount: 0 };
      if (fn === rp.nativeScrollStepInPage) {
        const tab = rp.catalogTabForCategory(state.cat);
        if (tab && tabState[tab]) { tabState[tab].steps += 1; emitCatalog(tab); }
        return { ok: true, before: {}, after: {}, marker: { nudged: false } };
      }
      if (fn === rp.selectNativeCardInPage) { state.selected.add(String(arg)); return { id: String(arg), clicked: true, checkedNow: true, pending: false }; }
      if (fn === rp.classifyAndCancelAutoPullInPage) return { kind: 'none' };
      if (fn === rp.readMainTableInPage) return { ok: true, rows: [...state.selected].map(productId => ({ productId, text: 'ID：' + productId })) };
      if (fn === rp.guidanceActionInPage) return { present: false, unknown: null, roots: [] };
      if (fn === guard.pageObserve) return observeObj();
      if (fn === guard.pageApply) {
        if (arg && arg.mode === 'click' && arg.expectKind === 'next') { state.page += 1; state.pagePath.push(state.page); state.pagerClicks += 1; }
        return { paged: true };
      }
      if (fn === guard.actionApply) { if (arg && arg.op === 'click' && arg.expectedText === '下一步') state.closed = true; return { applied: true }; }
      throw new Error('unexpected r129 evaluate ' + (fn && fn.name));
    },
  };
  const dayState = cfg.dayState;
  const persistLog = [];
  const drivers = rp.createRealDrivers({
    page, managerPage: {}, context: {}, dayState,
    persist: async () => { persistLog.push(JSON.parse(JSON.stringify({ category: dayState.category, page: dayState.page, cursor: dayState.cursor, lastSelected: dayState.lastSelected }))); },
    publishedIds: new Set(cfg.publishedIds || []), attemptedSet: cfg.attemptedSet, hints: {}, accountId, opened: {}, projectRoot: __dirname,
    planNumber: 1, runId: 'offline-r129', nativeScrollTimeoutMs: 120,
  });
  function browse(input) {
    return drivers.browseProducts({
      selectedIds: [], needed: 30, hints: {}, categories: input && input.categories,
      requireNextPage: !!(input && input.requireNextPage), onProgress: async () => {},
    });
  }
  return { page, drivers, state, tabState, persistLog, snapshot, browse, dayState };
}
function baseDayState(cursor) {
  const d = wf.newDayState('2026-10-20');
  d.cursor = cursor; d.category = cursor.category; d.page = cursor.page; d.lastSelected = [];
  return d;
}

test('R129 native browse: two all-attempted windows then a fresh window keeps scrolling and selects 30 without reuse', async () => {
  const AT1 = mkIds('21000000000', 15);
  const AT2 = mkIds('21100000000', 15);
  const FRESH = mkIds('23000000000', 30);
  const fx = browseHarness({
    tabs: { '2': [{ ids: AT1, hasMore: true }, { ids: AT2, hasMore: true }, { ids: FRESH, hasMore: true }] },
    attemptedSet: new Set([...AT1, ...AT2]),
    dayState: baseDayState({ category: '店铺新品', page: 1, seenProductIds: [] }),
  });
  const res = await fx.browse({});
  assert.equal(res.ok, true, JSON.stringify(res.reason));
  assert.deepEqual(res.selectedIds.slice().sort(), FRESH.slice().sort(), 'only never-attempted ids are picked');
  assert.equal(res.selectedIds.filter(id => [...AT1, ...AT2].includes(id)).length, 0, 'removed/attempted ids are never re-picked');
  assert.equal(fx.tabState['2'].steps, 2, 'exactly two real scroll advances to reach the fresh window');
  const finalCursor = fx.dayState.cursor;
  assert.equal(finalCursor.category, '店铺新品');
  assert.notEqual(finalCursor.nativeEof, true, 'a mid-category resume never marks the category exhausted');
  assert.equal(fx.persistLog[fx.persistLog.length - 1].cursor.seenProductIds.length, 60, 'seen set grows monotonically across windows');
});

test('R129 native stall is NOT native-catalog-no-progress: bounded stalls close only that category and the next one still fills 30', async () => {
  const AT1 = mkIds('21000000000', 15);
  const FRESH15 = mkIds('15000000000', 30);
  const fx = browseHarness({
    tabs: { '2': [{ ids: AT1, hasMore: true }], '15': [{ ids: FRESH15, hasMore: true }] },
    attemptedSet: new Set(AT1),
    dayState: baseDayState({ category: '店铺新品', page: 1, seenProductIds: [] }),
  });
  const res = await fx.browse({});
  assert.equal(res.ok, true, 'the browse continues into 破圈尖货 instead of throwing: ' + JSON.stringify(res.reason));
  assert.equal(fx.tabState['2'].steps, 4, 'two stalled advances with one bounded retry each (NATIVE_SCROLL_STALL_RETRIES=1)');
  assert.equal(fx.tabState['15'].loaded, 1);
  const stallExit = fx.persistLog.find(e => e.cursor.category === '店铺新品' && Object.prototype.hasOwnProperty.call(e.cursor, 'nativeAdvances') && e.cursor.nativeEof === false);
  assert.ok(stallExit, 'the stalled category is closed with an explicit nativeEof:false budget cursor, never a fake EOF');
  assert.equal(res.selectedIds.filter(id => AT1.includes(id)).length, 0);
});

test('R129 only a transport-proven hasMore=false chain marks nativeEof; every category honestly exhausted ends the browse as catalog-exhausted', async () => {
  const A = mkIds('22000000000', 15), B = mkIds('15100000000', 15), C = mkIds('14100000000', 15);
  const fx = browseHarness({
    tabs: { '2': [{ ids: A, hasMore: false }], '15': [{ ids: B, hasMore: false }], '14': [{ ids: C, hasMore: false }] },
    attemptedSet: new Set([...A, ...B, ...C]),
    dayState: baseDayState({ category: '店铺新品', page: 1, seenProductIds: [] }),
  });
  const res = await fx.browse({ categories: ['店铺新品', '破圈尖货', '搜索趋势'] });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'catalog-exhausted-or-safe-pagination-boundary');
  assert.equal(res.selectedIds.length, 0);
  assert.equal(res.cursor.nativeEof, true, 'EOF was proven for the final category');
  assert.equal(res.cursor.category, '搜索趋势');
  assert.equal(Object.values(fx.tabState).reduce((n, st) => n + st.steps, 0), 0, 'a proven EOF never scrolls past it');
  for (const cat of ['店铺新品', '破圈尖货', '搜索趋势']) {
    assert.ok(fx.persistLog.some(e => e.cursor.category === cat && e.cursor.nativeEof === true), cat + ' carries its own honest EOF proof');
  }
});

test('R129 whole-batch repair with requireNextPage really walks the numeric pager to cursor.page+1 before scanning', async () => {
  const REMOVED = mkIds('26000000000', 30);
  const FRESH27 = mkIds('27000000000', 30);
  const fx = browseHarness({
    numericPages: { 26: REMOVED, 27: FRESH27 },
    attemptedSet: new Set(REMOVED),
    dayState: baseDayState({ category: '全部', page: 26, seenProductIds: [] }),
  });
  const res = await fx.browse({ requireNextPage: true });
  assert.equal(res.ok, true, JSON.stringify(res.reason));
  assert.deepEqual(res.selectedIds.slice().sort(), FRESH27.slice().sort());
  assert.equal(res.selectedIds.filter(id => REMOVED.includes(id)).length, 0, 'the whole removed batch can never come back');
  assert.equal(fx.state.pagerClicks, 26, '25 observed restore steps + exactly one forward step past the persisted page');
  assert.deepEqual(fx.state.pagePath, Array.from({ length: 26 }, (_, i) => i + 2), 'every platform-observed page strictly increases, never rewinds');
  assert.equal(fx.dayState.cursor.page, 27, 'the durable cursor is written only on the observed next page');
});

test('R129 simulated restart resumes from the persisted page and moves forward only — page 27 seen-ids are never re-picked, page 28 fills the batch', async () => {
  const REMOVED = mkIds('26000000000', 30);
  const SEEN27 = mkIds('27000000000', 30);
  const FRESH28 = mkIds('28000000000', 30);
  const fx = browseHarness({
    numericPages: { 26: REMOVED, 27: SEEN27, 28: FRESH28 },
    attemptedSet: new Set([...REMOVED, ...SEEN27]),
    dayState: baseDayState({ category: '全部', page: 27, seenProductIds: [...REMOVED, ...SEEN27] }),
  });
  const res = await fx.browse({ requireNextPage: true });
  assert.equal(res.ok, true, JSON.stringify(res.reason));
  assert.deepEqual(res.selectedIds.slice().sort(), FRESH28.slice().sort());
  assert.equal(Math.min(...fx.state.pagePath), 2, 'restore starts forward from the reopened page 1 and never lands below the persisted page');
  assert.ok(fx.state.pagePath.every((p, i) => i === 0 || p === fx.state.pagePath[i - 1] + 1), 'the observed pager path is stepwise forward');
  assert.equal(fx.dayState.cursor.page, 28);
  assert.equal(fx.dayState.cursor.seenProductIds.filter(id => SEEN27.includes(id)).length, 30, 'seen history is preserved forward, not rewritten');
});

test('R129 nativeAdvanceCursor: only the eof case may set nativeEof; budget/stall/scan/switch/advance all clear it', () => {
  const prev = { seenProductIds: ['1', '2'] };
  assert.equal(rp.nativeAdvanceCursor(prev, '店铺新品', 'eof', 7).nativeEof, true);
  assert.equal(rp.nativeAdvanceCursor(prev, '店铺新品', 'eof', 7).nativeAdvances, 7);
  for (const kind of ['budget', 'stall', 'scan', 'switch', 'advance']) {
    const c = rp.nativeAdvanceCursor(prev, '破圈尖货', kind, 3);
    assert.equal(c.nativeEof, false, kind + ' must never persist an honest-exhaust flag');
    assert.equal(c.category, '破圈尖货');
    assert.deepEqual(c.seenProductIds, ['1', '2'], 'seen ids carry forward untouched');
  }
  assert.equal(rp.nativeAdvanceCursor(prev, '店铺新品', 'eof', 'x').nativeAdvances, 0, 'a non-integer advance count is never fabricated');
});

// ── 16. R130 whole-batch "no usable account" proof → removal + forced next page ─
// The REAL 2026-10-20 branch: 瑾漂亮 resumed from the durable cursor page 31 onto page 33,
// the binder individually activated all 30 selected products in the same account's stable
// panel set and EVERY product provably had no usable account (zero account rows, or all
// rows LABEL-disabled). That exact 30/30 proof removes the batch, records it as attempted
// and forces the durable cursor one page forward — never back to page 1, never a re-scan
// of the exhausted page, never a reuse of the removed ids. Anything less (29/30, unknown,
// usable account, panel drift) keeps the original zero-removal stop. The proof is its own
// narrow channel: it never sets alreadyPlanned / duplicateProven.
const R130_A1 = '79863866';
function r130Driver(ids, opt = {}) {
  let active = ids[0];
  const mainRows = ids.map(productId => ({ productId, text: 'ID：' + productId, manualAccounts: 0, manualEvidence: true, manualCountKnown: true, autoPullOnly: false, reviewFailed: false, alreadyPlanned: false }));
  const snapFor = pid => {
    const base = { ok: true, spinnerCount: 0, panelProductIds: ids.slice(), activeProductIds: [pid], selectedCount: 0, totalCount: 30 };
    if (opt.unknown === pid) return { ...base, headerLabelDisabled: true, selectedCount: 1, rows: [{ ids: [R130_A1], checked: true, labelDisabled: true }] };
    if (opt.usable === pid) return { ...base, headerLabelDisabled: false, rows: [{ ids: [R130_A1], checked: false, labelDisabled: false }] };
    if (opt.drift === pid) return { ...base, headerLabelDisabled: true, panelProductIds: ids.slice(0, 29).concat(['9999999999999990']), rows: [{ ids: [R130_A1], checked: false, labelDisabled: true }] };
    if (pid === ids[0]) return { ...base, headerLabelDisabled: true, rows: [{ ids: [R130_A1], checked: false, labelDisabled: true }] };
    return { ...base, headerLabelDisabled: false, rows: [] };
  };
  const page = {
    url: () => 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi?aavid=' + wf.BUSINESS.accountId,
    evaluate: async (fn, arg) => {
      if (fn === rp.readMainTableInPage) return { ok: true, rows: mainRows };
      if (fn === rp.bindingDrawerSnapshotInPage) return snapFor(active);
      if (fn === rp.selectBindingDrawerPanelInPage) { active = String(arg); return { clicked: true, id: String(arg) }; }
      if (fn === rp.bindingRowTooltipInPage) return { ok: false };
      if (fn === rp.selectAllAccountsInPage) return { clicked: true };
      if (fn === rp.guidanceActionInPage) return { present: false, unknown: null, roots: [] };
      if (fn === rp.openAnchorManagementInPage) return { ok: false };
      throw new Error('Unexpected r130 evaluate ' + (fn && fn.name));
    },
  };
  return rp.createRealDrivers({
    page, managerPage: {}, context: {}, dayState: { lastSelected: [], cursor: { seenProductIds: [] } }, persist: async () => {},
    publishedIds: new Set(), attemptedSet: new Set(), hints: {}, accountId: wf.BUSINESS.accountId, opened: {}, projectRoot: __dirname,
    planNumber: 1, runId: 'offline-r130', nativeScrollTimeoutMs: 60,
  });
}

test('R130 30/30 stable no-usable-account panels carry the narrow per-product proof, never a duplicate disguise', async () => {
  const ids = IDS30.slice();
  const res = await r130Driver(ids).bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'account-anchor-no-usable-product');
  assert.equal(res.accountUnavailableProven, true, JSON.stringify(res.reason));
  assert.equal(Object.prototype.hasOwnProperty.call(res, 'duplicateProven'), false, 'no-usable-account never sets duplicateProven');
  assert.equal(res.rows.length, 30);
  assert.equal(res.failedIds.length, 30);
  assert.ok(res.rows.every(r => r.accountUnavailableProven === true), 'every product carries its own proof');
  assert.ok(res.rows.every(r => r.alreadyPlanned !== true && r.duplicateEvidence === undefined), 'the proof never masquerades as alreadyPlanned/duplicate');
  assert.ok(res.rows.every(r => r.accountUnavailableEvidence && r.accountUnavailableEvidence.productId === String(r.productId)), 'the evidence is bound per productId');
  const kinds = new Map(res.rows.map(r => [String(r.productId), r.accountUnavailableEvidence.kind]));
  assert.equal(kinds.get(String(ids[0])), 'all-rows-disabled', 'the initial all-disabled panel is proven too');
  assert.equal(kinds.get(String(ids[1])), 'rows-empty');
  assert.equal(kinds.get(String(ids[29])), 'rows-empty');
  assert.equal(res.bindingEvidence.proven, true);
});

test('R130 29/30 (unknown panel), a usable account, or panel drift each keep the bare zero-proof stop', async () => {
  const cases = [
    ['unknown-checked-disabled-panel', { unknown: IDS30[10] }, 'account-anchor-no-usable-product'],
    ['usable-account-panel', { usable: IDS30[7] }, 'native-header-select-all-not-confirmed'],
    ['panel-set-drift', { drift: IDS30[15] }, 'account-anchor-panel-set-drift'],
  ];
  for (const [name, opt, reason] of cases) {
    const ids = IDS30.slice();
    const res = await r130Driver(ids, opt).bindAccountsToAll({ productIds: ids });
    assert.equal(res.ok, false, name);
    assert.equal(res.reason, reason, name + ': ' + JSON.stringify(res.reason));
    assert.notEqual(res.accountUnavailableProven, true, name + ': a partial/unknown batch never carries the 30/30 proof');
    assert.notEqual(res.duplicateProven, true, name);
    assert.ok((res.rows || []).every(r => r.accountUnavailableProven !== true), name + ': no row-level proof survives');
    assert.equal(res.bindingEvidence.proven, false, name + ': the batch is not removable');
  }
});

test('R130 preparePlan: a fully proven 30/30 unavailable batch enters whole-batch repair with requireNextPage', async () => {
  const ids = IDS30.slice();
  let repairs = 0, repairArgs = null;
  const bindingRows = ids.map(productId => ({
    productId, text: 'ID：' + productId, manualAccounts: null, manualEvidence: false,
    accountUnavailableProven: true,
    accountUnavailableEvidence: { productId, kind: 'rows-empty', accountId: wf.BUSINESS.accountId },
  }));
  const fresh = ids.map(productId => ({ productId, text: 'ID：' + productId, manualAccounts: null, manualEvidence: false, manualCountKnown: false }));
  const res = await wf.preparePlan({
    requireRealDrivers: true, businessDate: '2026-10-17', planNumber: 1, runId: 'r130-prepare', persistState: async () => {},
    dayState: wf.newDayState('2026-10-17'), catalogRemainingIds: [],
    openCreationPage: async () => ({ header: { originOk: true, accountId: wf.BUSINESS.accountId, commissionOptionPresent: true } }),
    browseProducts: async () => ({ ok: true, selectedIds: ids, attempted: [], cursor: { category: '全部', page: 33 } }),
    bindAccountsToAll: async () => ({ ok: false, reason: 'account-anchor-no-usable-product', rows: bindingRows, failedIds: ids, accountUnavailableProven: true }),
    readMainTable: async () => fresh,
    awaitMainTableStable: async () => ({ ok: true, rows: fresh, stableReads: 3 }),
    repairDraft: async args => { repairs++; repairArgs = args; return { ok: false, reason: 'offline-stop-after-proven-removal' }; },
    configurePlan: async () => { throw new Error('must not configure a no-usable-account batch'); },
  });
  assert.equal(res.status, 'stopped');
  assert.equal(res.stage, 'repair', JSON.stringify(res.reason));
  assert.equal(repairs, 1);
  assert.equal(repairArgs.removeIds.length, 30);
  assert.equal(repairArgs.repairMode, 'whole-batch-removal');
  assert.equal(repairArgs.requireNextPage, true);
  assert.equal(repairArgs.provenAccountUnavailableIds.length, 30, 'the exact per-id proof reaches the removal gate');
  assert.deepEqual(repairArgs.provenDuplicateIds, [], 'no-usable-account is never laundered into a duplicate proof');
  assert.ok((repairArgs.bindingRows || []).every(r => r.alreadyPlanned !== true));
});

test('R130 preparePlan: a 29/30 evidence set keeps the original zero-removal account-binding stop', async () => {
  const ids = IDS30.slice();
  let repairs = 0, configures = 0;
  const bindingRows = ids.map((productId, i) => (i < 29
    ? { productId, text: 'ID：' + productId, manualAccounts: null, manualEvidence: false, accountUnavailableProven: true, accountUnavailableEvidence: { productId, kind: 'rows-empty' } }
    : { productId, text: 'ID：' + productId, manualAccounts: null, manualEvidence: false }));
  const fresh = ids.map((productId, i) => (i < 29
    ? { productId, text: 'ID：' + productId, manualAccounts: null, manualEvidence: false, manualCountKnown: false }
    : { productId, text: 'ID：' + productId, manualAccounts: null, manualEvidence: false, manualCountKnown: false }));
  const res = await wf.preparePlan({
    requireRealDrivers: true, businessDate: '2026-10-17', planNumber: 1, runId: 'r130-partial', persistState: async () => {},
    dayState: wf.newDayState('2026-10-17'), catalogRemainingIds: [],
    openCreationPage: async () => ({ header: { originOk: true, accountId: wf.BUSINESS.accountId, commissionOptionPresent: true } }),
    browseProducts: async () => ({ ok: true, selectedIds: ids, attempted: [], cursor: { category: '全部', page: 33 } }),
    bindAccountsToAll: async () => ({ ok: false, reason: 'account-anchor-no-usable-product', rows: bindingRows, failedIds: ids.slice(0, 29) }),
    readMainTable: async () => fresh,
    awaitMainTableStable: async () => ({ ok: true, rows: fresh, stableReads: 3 }),
    repairDraft: async () => { repairs++; return { ok: true }; },
    configurePlan: async () => { configures++; return { ok: true, planName: 'P' }; },
  });
  assert.equal(res.status, 'stopped');
  assert.equal(res.stage, 'account-binding');
  assert.equal(res.reason, 'account-anchor-no-usable-product', 'the original honest stop reason survives');
  assert.equal(repairs, 0, 'zero removals on a partial proof');
  assert.equal(configures, 0);
  assert.equal(res.bindingEvidence.proven, false);
});

test('R130 requireNextPage from durable page 33 advances exactly to page 34 before scanning — never page 1, never a page-33 re-pick', async () => {
  const REMOVED33 = mkIds('33000000000', 30);
  const FRESH34 = mkIds('34000000000', 30);
  const fx = browseHarness({
    numericPages: { 33: REMOVED33, 34: FRESH34 },
    attemptedSet: new Set(REMOVED33),
    dayState: baseDayState({ category: '全部', page: 33, seenProductIds: [...REMOVED33] }),
  });
  const res = await fx.browse({ requireNextPage: true });
  assert.equal(res.ok, true, JSON.stringify(res.reason));
  assert.deepEqual(res.selectedIds.slice().sort(), FRESH34.slice().sort(), 'only the NEXT page fills the batch');
  assert.equal(res.selectedIds.filter(id => REMOVED33.includes(id)).length, 0, 'the exhausted page-33 batch is never re-picked');
  assert.equal(fx.dayState.cursor.page, 34, 'the durable cursor advances by exactly +1');
  assert.equal(fx.dayState.cursor.category, '全部');
  assert.equal(Math.min(...fx.state.pagePath), 2, 'the observed pager path never lands below page 2');
  assert.ok(fx.state.pagePath.every((p, i) => i === 0 || p === fx.state.pagePath[i - 1] + 1), 'stepwise forward only, no rewind');
  assert.equal(fx.state.pagePath[fx.state.pagePath.length - 1], 34);
  assert.equal(fx.dayState.cursor.seenProductIds.filter(id => REMOVED33.includes(id)).length, 30, 'seen history is preserved forward');
});

// Full repairDraft integration for the proven batch: close drawer → per-row removal →
// attempted persistence → browseProducts(requireNextPage) → cursor forward proof.
function r130RepairHarness(REMOVED33, FRESH34, opt = {}) {
  const attempted = new Set();
  const fx = browseHarness({
    numericPages: { 33: REMOVED33, 34: FRESH34 },
    attemptedSet: attempted,
    dayState: baseDayState({ category: '全部', page: 33, seenProductIds: [] }),
  });
  const rowsFor = ids => ids.map(productId => ({
    productId, text: 'ID：' + productId, manualAccounts: null, manualEvidence: false, manualCountKnown: false,
    ...(opt.rowExtra || {}),
  }));
  const draftIds = new Set(REMOVED33);
  const removes = [];
  const stats = { openPickerCalls: 0 };
  const inner = fx.page.evaluate.bind(fx.page);
  fx.page.evaluate = async (fn, arg) => {
    if (fn === rp.bindingDrawerSnapshotInPage) return { ok: false, count: 0 };
    if (fn === rp.bindingOverlaySnapshotInPage) return { accountDrawerCount: 0, blockingOverlayPresent: false };
    if (fn === rp.cancelAutoOpenedDrawerInPage) return { cancelled: true };
    if (fn === rp.accountDrawerCancelConfirmInPage) return { present: false, known: true, count: 0 };
    if (fn === rp.openPickerInPage) { stats.openPickerCalls++; return inner(fn, arg); }
    if (fn === rp.readMainTableInPage) {
      if (draftIds.size) return { ok: true, rows: rowsFor([...draftIds]) };
      // The REAL platform read after the last row is deleted: the creation table is empty and
      // readMainTableInPage fails with the known empty-table reason (never ok:true rows:[]).
      // After the picker commit, main-table rows are the freshly selected batch again.
      if (!fx.state.closed) return opt.emptyTable || { ok: false, reason: 'creation-table-not-unique-or-empty', rootCount: 1, rowCount: 0 };
      return inner(fn, arg);
    }
    if (fn === rp.removeNativeCardInPage) { removes.push(String(arg.productId)); draftIds.delete(String(arg.productId)); return { clicked: true, productId: String(arg.productId) }; }
    if (fn === rp.confirmDraftRemovalInPage) return { confirmed: true };
    return inner(fn, arg);
  };
  return { fx, attempted, draftIds, removes, stats };
}

test('R130 repairDraft on the 30/30 proof removes the batch, records attempted, and replaces it strictly from page 34', async () => {
  const REMOVED33 = mkIds('33000000000', 30);
  const FRESH34 = mkIds('34000000000', 30);
  const h = r130RepairHarness(REMOVED33, FRESH34);
  const res = await h.fx.drivers.repairDraft({
    removeIds: REMOVED33.slice(),
    backfillCount: 30,
    repairMode: 'whole-batch-removal',
    requireNextPage: true,
    provenAccountUnavailableIds: REMOVED33.slice(),
    onProgress: async () => {},
  });
  assert.equal(res.ok, true, JSON.stringify(res.reason));
  assert.equal(res.mode, 'whole-batch-removal');
  assert.deepEqual(h.removes.slice().sort(), REMOVED33.slice().sort(), 'all 30 proven products are removed');
  assert.equal(h.draftIds.size, 0);
  assert.equal(REMOVED33.every(id => h.attempted.has(id)), true, 'the removed 30 all enter attempted');
  assert.equal(REMOVED33.filter(id => (h.fx.dayState.attempted || []).includes(id)).length, 30, 'attempted is persisted per-day');
  assert.deepEqual(res.mainRows.map(r => String(r.productId)).sort(), FRESH34.slice().sort(), 'the replacement batch never reuses a removed id');
  assert.equal(res.mainRows.filter(r => REMOVED33.includes(String(r.productId))).length, 0);
  assert.equal(h.fx.dayState.cursor.page, 34, 'the durable cursor moved exactly 33 -> 34');
  assert.ok(h.fx.state.pagePath.every((p, i) => i === 0 || p === h.fx.state.pagePath[i - 1] + 1), 'no page rewind during the forced next-page browse');
  assert.equal(res.progress, true);
  assert.equal(h.stats.openPickerCalls, 1, 'the exact empty-table transition proceeds to exactly one picker open');
});

test('R130 repairDraft refuses the unavailable-account proof unless it is the exact whole batch with a forced next page', async () => {
  const REMOVED33 = mkIds('33000000000', 30);
  const FRESH34 = mkIds('34000000000', 30);
  const variants = [
    ['29/30 proof set', { provenAccountUnavailableIds: REMOVED33.slice(0, 29), requireNextPage: true, repairMode: 'whole-batch-removal' }],
    ['no forced next page', { provenAccountUnavailableIds: REMOVED33.slice(), requireNextPage: false, repairMode: 'whole-batch-removal' }],
    ['partial-removal mode', { provenAccountUnavailableIds: REMOVED33.slice(), requireNextPage: true, repairMode: 'partial-removal', removeIds: REMOVED33.slice(0, 29) }],
  ];
  for (const [name, over] of variants) {
    const h = r130RepairHarness(REMOVED33, FRESH34);
    const args = {
      removeIds: REMOVED33.slice(),
      backfillCount: 30,
      repairMode: 'whole-batch-removal',
      requireNextPage: true,
      onProgress: async () => {},
      ...over,
    };
    const res = await h.fx.drivers.repairDraft(args);
    assert.equal(res.ok, false, name + ': ' + JSON.stringify(res));
    assert.match(String(res.reason), /^(removal-lacks-explicit-current-row-evidence|partial-removal-size-mismatch)/, name + ': ' + res.reason);
    assert.equal(h.removes.length, 0, name + ': zero removals without the exact proof');
    assert.equal(h.attempted.size, 0, name + ': nothing is recorded as attempted');
    assert.equal(h.draftIds.size, 30, name + ': the draft is untouched');
  }
});

// R132 production-chain negatives: the SAME exported createRealDrivers().repairDraft must
// keep the original fail-closed throw for every empty/not-unique table that is not the exact
// proven whole-batch transition. The picker is never opened on those reads.
test('R132 production repairDraft fails closed on every empty table without the exact transition', async () => {
  const REMOVED33 = mkIds('33000000000', 30);
  const FRESH34 = mkIds('34000000000', 30);
  // Table-shape rejection is additionally covered exhaustively (root counts, unknown reasons,
  // incomplete deletions) by the pure-gate R132 test below; these two drive the SAME cases
  // through the production repairDraft so the wiring itself is proven.
  const cases = [
    ['unknown table reason', { ok: false, reason: 'creation-table-drift', rootCount: 1, rowCount: 0 }],
    ['a residual row', { ok: false, reason: 'creation-table-not-unique-or-empty', rootCount: 1, rowCount: 1 }],
  ];
  for (const [name, emptyTable] of cases) {
    const h = r130RepairHarness(REMOVED33, FRESH34, { emptyTable });
    await assert.rejects(() => h.fx.drivers.repairDraft({
      removeIds: REMOVED33.slice(), backfillCount: 30,
      repairMode: 'whole-batch-removal', requireNextPage: true,
      provenAccountUnavailableIds: REMOVED33.slice(), onProgress: async () => {},
    }), /creation-table/, name);
    assert.equal(h.stats.openPickerCalls, 0, name + ': the picker is never opened on a non-proven empty table');
  }
  // Removal evidence can be complete (review-failed rows) while the 30/30 no-usable-account
  // proof is absent: that is still NOT the empty transition and must throw.
  const hNoProof = r130RepairHarness(REMOVED33, FRESH34, { rowExtra: { reviewFailed: true } });
  await assert.rejects(() => hNoProof.fx.drivers.repairDraft({
    removeIds: REMOVED33.slice(), backfillCount: 30,
    repairMode: 'whole-batch-removal', requireNextPage: true, onProgress: async () => {},
  }), /creation-table/, 'a whole-batch removal without the 30/30 unavailable proof never gets the empty transition');
  assert.equal(hNoProof.removes.length, 30, 'the review-failed batch is still removed under its own evidence');
  assert.equal(hNoProof.stats.openPickerCalls, 0);
});

// ── 17. R131: consecutive fully-proven unavailable batches walk page33 → page34 → page35 ─
// The REAL 2026-10-21 continuation: a replacement batch whose own rebind fails with the SAME
// exact 30/30 per-product no-usable-account proof must re-enter the SAME bounded repair loop
// (whole-batch-removal + requireNextPage + close/delete/attempted/persist/cursor-forward),
// never skip a page and never fake success. Anything less than the exact proof (29/30, a
// foreign/duplicate/unknown row, a merely usable account, a drifted 29-row batch, or a plain
// rebind failure) keeps the zero-extra-removal account-rebinding stop.
const P33 = mkIds('33000000000', 30);
const P34 = mkIds('34000000000', 30);
const P35 = mkIds('35000000000', 30);
function r131Harness(opt = {}) {
  const provenRows = ids => ids.map(productId => ({
    productId, text: 'ID：' + productId, manualAccounts: null, manualEvidence: false, manualCountKnown: false,
    accountUnavailableProven: true,
    accountUnavailableEvidence: { productId, kind: 'rows-empty', accountId: wf.BUSINESS.accountId },
  }));
  const bare = id => ({ productId: id, text: 'ID：' + id, manualAccounts: null, manualEvidence: false, manualCountKnown: false });
  const usable = id => ({ productId: id, text: 'ID：' + id, manualAccounts: 1, manualEvidence: true, manualCountKnown: true, autoPullOnly: false, reviewFailed: false, alreadyPlanned: false });
  const ready = ids => ids.map(productId => ({ productId, text: 'ID：' + productId, manualAccounts: 2, manualEvidence: true, manualCountKnown: true, autoPullOnly: false, reviewFailed: false, alreadyPlanned: false }));
  const persisted = [];
  const repairCalls = [];
  const bindCalls = [];
  const stats = { browseCalls: 0, stableCalls: 0, configureCalls: 0 };
  // The failed rebind of the FIRST replacement batch (page34), per variant.
  const rebindResults = {
    'exact-30-proof': () => ({ ok: false, reason: 'account-anchor-no-usable-product', rows: provenRows(P34), failedIds: P34.slice(), accountUnavailableProven: true }),
    'proof-29-of-30': () => ({ ok: false, reason: 'account-anchor-no-usable-product', rows: provenRows(P34.slice(0, 29)).concat([bare(P34[29])]), failedIds: P34.slice(0, 29) }),
    'proof-rows-29': () => ({ ok: false, reason: 'account-anchor-no-usable-product', rows: provenRows(P34.slice(0, 29)), failedIds: P34.slice(0, 29) }),
    'foreign-id': () => ({ ok: false, reason: 'account-anchor-no-usable-product', rows: provenRows(P34.slice(0, 29)).concat([provenRows(['9999999999999990'])[0]]), failedIds: P34.slice() }),
    'duplicate-id': () => ({ ok: false, reason: 'account-anchor-no-usable-product', rows: provenRows(P34.slice(0, 29)).concat([provenRows([P34[0]])[0]]), failedIds: P34.slice() }),
    'usable-account': () => ({ ok: false, reason: 'batch-result-panel-target-not-verified', rows: provenRows(P34.slice(0, 29)).concat([usable(P34[29])]), failedIds: P34.slice(0, 29) }),
    'unknown-row': () => ({ ok: false, reason: 'account-anchor-no-usable-product', rows: provenRows(P34.slice(0, 29)).concat([{ text: 'no id', manualAccounts: null, manualEvidence: false }]), failedIds: P34.slice() }),
    'plain-failure': () => ({ ok: false, reason: 'batch-result-panel-target-not-verified' }),
  };
  const variant = opt.rebindVariant || 'exact-30-proof';
  const deps = {
    requireRealDrivers: true,
    businessDate: '2026-10-21', planNumber: 1, runId: 'r131-' + variant,
    dayState: Object.assign(wf.newDayState('2026-10-21'), { cursor: { category: '全部', page: 33, seenProductIds: P33.slice() } }),
    catalogRemainingIds: [],
    persistState: async st => { persisted.push(JSON.parse(JSON.stringify(st))); },
    openCreationPage: async () => ({ header: { originOk: true, accountId: wf.BUSINESS.accountId, commissionOptionPresent: true } }),
    browseProducts: async () => {
      stats.browseCalls++;
      return { ok: true, selectedIds: P33.slice(), attempted: [], hints: {}, cursor: { category: '全部', page: 33, seenProductIds: P33.slice() } };
    },
    bindAccountsToAll: async a => {
      bindCalls.push(a);
      if (bindCalls.length === 1) return { ok: false, reason: 'account-anchor-no-usable-product', rows: provenRows(P33), failedIds: P33.slice(), accountUnavailableProven: true };
      if (bindCalls.length === 2) return rebindResults[variant]();
      return { ok: true, accountIds: wf.BUSINESS.boundAccounts.slice() };
    },
    readMainTable: async () => ready(P35),
    awaitMainTableStable: async () => {
      stats.stableCalls++;
      return stats.stableCalls === 1 ? { ok: true, rows: P33.map(bare), stableReads: 3 } : { ok: true, rows: ready(P35), stableReads: 3 };
    },
    repairDraft: async args => {
      repairCalls.push(args);
      for (const id of args.removeIds) args.attemptedSet.add(String(id));
      if (typeof args.onProgress === 'function') await args.onProgress({ attempted: [...args.attemptedSet] });
      if (opt.repairRows) return { ok: true, mainRows: opt.repairRows, selectedCount: 30, progress: true, mode: args.repairMode };
      const next = repairCalls.length === 1 ? P34 : P35;
      return { ok: true, mainRows: next.map(bare), selectedCount: 30, progress: true, mode: args.repairMode };
    },
    configurePlan: async () => { stats.configureCalls++; return { ok: true, planName: '2026-10-21_千川乘方_12:00:00' }; },
  };
  const run = () => wf.preparePlan(deps);
  return { run, persisted, repairCalls, bindCalls, stats, provenRows, bare, ready };
}

test('R131 two consecutive 30/30 unavailable batches: the SAME preparePlan removes page33, proves page34 unavailable, removes page34 and continues only into page35', async () => {
  const h = r131Harness();
  const res = await h.run();
  assert.equal(res.status, 'ready-awaiting-confirmation', JSON.stringify(res.reason || res.stage));
  assert.equal(h.repairCalls.length, 2, 'exactly two whole-batch repair rounds in one preparePlan');
  for (const [i, ids] of [[0, P33], [1, P34]]) {
    const args = h.repairCalls[i];
    assert.deepEqual(args.removeIds.slice().sort(), ids.slice().sort(), 'round ' + i + ' removes exactly its own proven batch');
    assert.equal(args.repairMode, 'whole-batch-removal');
    assert.equal(args.requireNextPage, true, 'round ' + i + ' forces the durable next page');
    assert.deepEqual((args.provenAccountUnavailableIds || []).slice().sort(), ids.slice().sort(), 'round ' + i + ' carries the exact 30/30 proof');
    assert.deepEqual(args.provenDuplicateIds, [], 'the unavailable proof never masquerades as a duplicate');
  }
  assert.equal(h.bindCalls.length, 3, 'initial bind + two rebinds');
  assert.equal(h.bindCalls[1].repairRound, 1);
  assert.deepEqual(h.bindCalls[1].productIds.slice().sort(), P34.slice().sort(), 'the first rebind targets exactly the page34 replacement batch');
  assert.equal(h.bindCalls[2].repairRound, 2);
  assert.deepEqual(h.bindCalls[2].productIds.slice().sort(), P35.slice().sort(), 'the second rebind targets exactly the page35 batch');
  assert.equal(h.stats.browseCalls, 1, 'the initial durable selection runs once — page 1 and exhausted pages are never re-scanned');
  assert.equal(h.stats.configureCalls, 1);
  // page33 + page34 ids all enter attempted and are persisted per-day; page35 never does.
  const last = h.persisted[h.persisted.length - 1];
  for (const id of [...P33, ...P34]) assert.ok(last.attempted.includes(id), 'attempted keeps every removed id: ' + id);
  assert.equal(last.attempted.filter(id => P35.includes(id)).length, 0, 'the continuing page35 batch is not attempted');
  assert.deepEqual(res.frozen.productIds.slice().sort(), P35.slice().sort(), 'the frozen plan is exactly the page35 batch');
  assert.equal(res.frozen.productIds.filter(id => P33.includes(id) || P34.includes(id)).length, 0, 'no removed id is ever reused');
});

test('R131 anything less than the exact 30/30 proof keeps the zero-extra-removal account-rebinding stop', async () => {
  const cases = [
    ['proof-29-of-30', 'account-anchor-no-usable-product'],
    ['proof-rows-29', 'account-anchor-no-usable-product'],
    ['foreign-id', 'account-anchor-no-usable-product'],
    ['duplicate-id', 'account-anchor-no-usable-product'],
    ['usable-account', 'batch-result-panel-target-not-verified'],
    ['unknown-row', 'account-anchor-no-usable-product'],
    ['plain-failure', 'batch-result-panel-target-not-verified'],
  ];
  for (const [variant, reason] of cases) {
    const h = r131Harness({ rebindVariant: variant });
    const res = await h.run();
    assert.equal(res.status, 'stopped', variant);
    assert.equal(res.stage, 'account-rebinding', variant + ': ' + JSON.stringify(res.stage));
    assert.equal(res.reason, reason, variant + ': the honest rebind failure reason survives');
    assert.equal(h.repairCalls.length, 1, variant + ': zero extra removals after the unproven rebind');
    assert.equal(h.stats.configureCalls, 0, variant);
    assert.equal(res.frozen, undefined, variant);
    const last = h.persisted[h.persisted.length - 1];
    assert.equal(last.attempted.filter(id => P34.includes(id)).length, 0, variant + ': the unproven page34 batch is never deleted/attempted');
    assert.equal(last.attempted.filter(id => P33.includes(id)).length, 30, variant + ': the proven page33 removal stays attempted');
  }
  // Batch drift (the repair returned only 29 rows) voids the proof channel even when the
  // rebound rows look perfect: the current batch itself is not the full 30.
  const drift = r131Harness({ repairRows: P34.slice(0, 29).map(id => ({ productId: id, text: 'ID：' + id, manualAccounts: null, manualEvidence: false, manualCountKnown: false })) });
  const dres = await drift.run();
  assert.equal(dres.status, 'stopped');
  assert.equal(dres.stage, 'account-rebinding');
  assert.equal(drift.repairCalls.length, 1, 'a drifted 29-row replacement batch performs zero extra removals');
  assert.equal(drift.stats.configureCalls, 0);
});

// ── 18. R132: the post-whole-batch-removal EMPTY main table is a narrow, proven transition ─
// Real 2026-10-21 evidence: after the exact 30/30 proven batch is fully deleted, the creation
// table is legitimately empty and the picker may open for the durable next page. Only that
// exact transition passes the gate; every other empty/not-unique table stays fail-closed.
test('R132 the exact whole-batch-removal + 30/30 proof with all 30 rows deleted allows the empty-table transition', () => {
  const base = {
    repairMode: 'whole-batch-removal', requireNextPage: true, capacity: 30,
    provenAccountUnavailableIds: P34.slice(), removeIds: P34.slice(), removedIds: P34.slice(),
    table: { ok: false, reason: 'creation-table-not-unique-or-empty', rootCount: 1, rowCount: 0 },
  };
  const g = wf.wholeBatchRemovalEmptyTableGate(base);
  assert.equal(g.allowed, true, JSON.stringify(g));
  assert.equal(g.reason, 'whole-batch-removal-empty-transition');
  // No candidate table root at all (the platform renders an empty state) is the same proven transition.
  assert.equal(wf.wholeBatchRemovalEmptyTableGate({ ...base, table: { ...base.table, rootCount: 0 } }).allowed, true);
  // A deleted-order shuffle changes nothing: the gate is set-based.
  assert.equal(wf.wholeBatchRemovalEmptyTableGate({ ...base, removedIds: P34.slice().reverse() }).allowed, true);
});

test('R132 every other empty or not-unique main table stays fail-closed', () => {
  const base = {
    repairMode: 'whole-batch-removal', requireNextPage: true, capacity: 30,
    provenAccountUnavailableIds: P34.slice(), removeIds: P34.slice(), removedIds: P34.slice(),
    table: { ok: false, reason: 'creation-table-not-unique-or-empty', rootCount: 1, rowCount: 0 },
  };
  const cases = [
    ['partial-removal mode', { repairMode: 'partial-removal' }, 'not-whole-batch-removal'],
    ['no forced next page', { requireNextPage: false }, 'next-page-not-required'],
    ['missing requireNextPage', { requireNextPage: undefined }, 'next-page-not-required'],
    ['29/30 proof', { provenAccountUnavailableIds: P34.slice(0, 29) }, 'proof-or-removal-set-not-exact-capacity'],
    ['29/30 removals', { removeIds: P34.slice(0, 29), removedIds: P34.slice(0, 29) }, 'proof-or-removal-set-not-exact-capacity'],
    ['removal not the proven set', { removeIds: P34.slice(0, 29).concat([P35[0]]) }, 'removal-set-not-exactly-proven'],
    ['deletion incomplete (29 removed)', { removedIds: P34.slice(0, 29) }, 'whole-batch-removal-incomplete'],
    ['unknown table reason', { table: { ok: false, reason: 'creation-table-drift', rootCount: 1, rowCount: 0 } }, 'not-the-known-empty-table-read'],
    ['a residual row', { table: { ok: false, reason: 'creation-table-not-unique-or-empty', rootCount: 1, rowCount: 1 } }, 'table-not-proven-empty'],
    ['multiple candidate roots', { table: { ok: false, reason: 'creation-table-not-unique-or-empty', rootCount: 2, rowCount: 0 } }, 'table-root-not-unique'],
    ['no table read at all', { table: undefined }, 'not-the-known-empty-table-read'],
  ];
  for (const [name, over, reason] of cases) {
    const g = wf.wholeBatchRemovalEmptyTableGate({ ...base, ...over });
    assert.equal(g.allowed, false, name + ': ' + JSON.stringify(g));
    assert.equal(g.reason, reason, name);
  }
});

// ── 19. R133: a verified target set is judged by per-read SUBSET MEMBERSHIP, never an exact frozen row key ─
// Real 2026-10-21 continuation stop `account-anchor-account-identity-drift` (page35→38, seen1152, attempted79,
// zero publication / noReplay). Business rule: every product needs AT LEAST ONE usable target 抖音号; the 30
// products do NOT all have to expose the same two accounts. Inside the resolved/frozen target set the same
// active product legitimately shows any NON-EMPTY SUBSET (1 or 2): a re-order, a late/missing disabled row or a
// 2→1 / 1→2 re-render are render-order facts, never identity drift. Identity stays STRICT per-read membership —
// a foreign/unknown id, a duplicate/ambiguous row, an unverified set, or zero usable target accounts (without the
// exact 30/30 unavailable proof) still fail closed with ZERO clicks. These cases drive the ACTUAL
// createRealDrivers().bindAccountsToAll (and preparePlan) through the production gates.
const R133_A1 = '79863866', R133_A2 = '9zmao_fushi', R133_FOREIGN = 'foreign_acct_01';
const dA1 = { id: R133_A1, enabled: false }, dA2 = { id: R133_A2, enabled: false };
const eA1 = { id: R133_A1, enabled: true }, eA2 = { id: R133_A2, enabled: true };
const R133_CYCLES = {
  // variant A: ids[0] is a fully-enabled auto-active anchor; ids[4] is the single all-disabled
  // (=> failed) product; every other product keeps >=1 enabled target, mixing 1- and 2-account
  // subsets (and a reversed order) so the batch legitimately ends with manualAccounts of 1 OR 2.
  A: i => {
    if (i === 0) return [eA1, eA2];
    if (i === 1) return [eA2, eA1];
    if (i === 2) return [eA1];
    if (i === 3) return [eA2];
    if (i === 4) return [dA1, dA2];
    const m = i % 4;
    return m === 0 ? [eA1, eA2] : m === 1 ? [eA2] : m === 2 ? [eA1] : [eA2, eA1];
  },
  // variant B: ids[0] is blocked (its A1 row is LABEL-disabled) so the bounded navigation picks
  // ids[1]; EVERY product keeps >=1 enabled target so the no-modal proof succeeds with mixed 1/2.
  B: i => {
    if (i === 0) return [dA1, eA2];
    if (i === 1) return [eA1, eA2];
    if (i === 2) return [eA2, dA1];
    if (i === 3) return [eA1];
    if (i === 4) return [eA2];
    const m = i % 4;
    return m === 0 ? [eA1, eA2] : m === 1 ? [eA2] : m === 2 ? [eA1] : [eA2, eA1];
  },
  // all products expose BOTH targets enabled (the late-render / foreign-poison base).
  all2: () => [eA1, eA2],
};
function r133SpecMap(ids, spec) {
  const m = new Map();
  ids.forEach((id, i) => m.set(String(id), typeof spec === 'function' ? spec(i, id) : spec[String(id)]));
  return m;
}
function r133Harness(ids, spec, opt = {}) {
  const specMap = r133SpecMap(ids, spec);
  const overrides = (opt.overrides || []).slice();
  let active = String(ids[0]);
  let phase = 'initial';
  let anchorPid = null;
  const anchorChecked = new Set();
  const failedSet = new Set();
  const calls = { header: 0, commit: 0, warning: 0, batch: 0, modalConfirm: 0, ack: 0, panelNav: 0 };
  const specOf = pid => specMap.get(String(pid)) || [];
  // Normalize a spec entry to its account-row list: a plain array is used as-is, a
  // `{raw:[...]}` entry renders those drawer rows verbatim (identity-drift panels).
  const rowsOf = pid => { const s = specOf(pid); if (Array.isArray(s)) return s; return (s && Array.isArray(s.raw)) ? s.raw : []; };
  const enabledIds = pid => rowsOf(pid).filter(r => r.enabled).map(r => r.id);
  const rowFor = (pid, r) => {
    let checked;
    if (phase === 'initial') checked = false;
    else if (phase === 'anchor') checked = r.enabled && String(pid) === anchorPid;
    else checked = r.enabled && anchorChecked.has(r.id); // batch
    return { ids: [r.id], checked, labelDisabled: !r.enabled };
  };
  const snapFor = pid => {
    if (overrides.length) return overrides.shift();
    const sp = specOf(pid);
    const rows = (sp && !Array.isArray(sp) && Array.isArray(sp.raw)) ? sp.raw : rowsOf(pid).map(r => rowFor(pid, r));
    const checkedN = rows.filter(r => r.checked).length;
    return {
      ok: true, spinnerCount: 0, headerLabelDisabled: false, panelProductIds: ids.map(String),
      activeProductIds: [String(pid)], rows, selectedCount: checkedN, totalCount: 30,
    };
  };
  const mainRows = () => ids.map(id => {
    let ma = 0;
    if (phase === 'batch') ma = rowsOf(id).filter(r => r.enabled && anchorChecked.has(r.id)).length;
    return { productId: id, text: 'ID：' + id, manualAccounts: ma, manualEvidence: true, manualCountKnown: true, autoPullOnly: false, reviewFailed: false, alreadyPlanned: false };
  });
  const page = {
    url: () => 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi?aavid=' + wf.BUSINESS.accountId,
    evaluate: async (fn, arg) => {
      if (fn === rp.readMainTableInPage) return { ok: true, rows: mainRows() };
      if (fn === rp.bindingDrawerSnapshotInPage) return snapFor(active);
      if (fn === rp.selectBindingDrawerPanelInPage) { active = String(arg); calls.panelNav++; return { clicked: true, id: String(arg) }; }
      if (fn === rp.selectAllAccountsInPage) {
        calls.header++; anchorPid = active; phase = 'anchor';
        enabledIds(anchorPid).forEach(id => anchorChecked.add(id));
        return { clicked: true };
      }
      if (fn === rp.applyBatchAccountsInPage) return { clicked: true };
      if (fn === rp.batchAddAllModalSnapshotInPage) return { modalCount: 1, productCount: ids.length - 1, accountCount: anchorChecked.size, drawerSettled: true };
      if (fn === rp.confirmBatchAddAllModalInPage) {
        calls.modalConfirm++; phase = 'batch'; failedSet.clear();
        for (const id of ids) {
          if (String(id) === String(anchorPid)) continue;
          if (!rowsOf(id).some(r => r.enabled && anchorChecked.has(r.id))) failedSet.add(String(id));
        }
        return { clicked: true };
      }
      if (fn === rp.batchResultSnapshotInPage) {
        if (opt.result === 'absent') return { present: false, known: false, settled: false };
        return { present: true, known: true, settled: true, anchorMismatch: false, outsideIds: [], duplicateRows: 0, unreadableRows: 0, failedIds: [...failedSet] };
      }
      if (fn === rp.acknowledgeBatchResultInPage) { calls.ack++; return { acknowledged: true, failedIds: [...failedSet] }; }
      if (fn === rp.confirmBatchAccountsApplyInPage) { calls.commit++; return { clicked: true }; }
      if (fn === rp.acceptPartialDraftWarningInPage) { calls.warning++; return { accepted: true }; }
      if (fn === rp.bindingOverlaySnapshotInPage) return { accountDrawerCount: 1, blockingOverlayPresent: false };
      if (fn === rp.bindingRowTooltipInPage) return { ok: false };
      if (fn === rp.openAnchorManagementInPage) return { ok: false };
      if (fn === rp.guidanceActionInPage) return { present: false, unknown: null, roots: [] };
      throw new Error('R133 unexpected ' + (fn && fn.name));
    },
  };
  const driver = () => rp.createRealDrivers({
    page, managerPage: {}, context: {}, dayState: { lastSelected: [], cursor: { seenProductIds: [] } }, persist: async () => {},
    publishedIds: new Set(), attemptedSet: new Set(), hints: {}, accountId: wf.BUSINESS.accountId, opened: {}, projectRoot: __dirname,
    planNumber: 1, runId: 'offline-r133', nativeScrollTimeoutMs: opt.nativeScrollTimeoutMs || 60,
  });
  return { driver, calls, ids, failedSet, specOf, enabledIds, get phase() { return phase; } };
}
const R133_FRESH = (...a) => r133Harness(...a);

test('R133 mixed non-empty subsets of the verified [A,B] set all bind (>=1 each), one all-disabled product is the only failure', async () => {
  const ids = IDS30.slice();
  const h = R133_FRESH(ids, R133_CYCLES.A);
  const res = await h.driver().bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, true, JSON.stringify(res.reason));
  assert.equal(res.partial, true, 'the single all-disabled product is an honest partial failure');
  assert.deepEqual(res.failedIds, [ids[4]], 'exactly the product with zero usable target rows fails');
  assert.deepEqual(res.accountIds.slice().sort(), wf.BUSINESS.boundAccounts.slice().map(String).sort(), 'the full frozen target set is returned, never a per-product subset');
  assert.equal(res.productCount, 30);
  assert.equal(res.rows.length, 30);
  const counts = res.rows.map(r => r.manualAccounts);
  assert.ok(counts.every(n => Number.isInteger(n) && n >= 1 || n === 0), 'every row is a definite count');
  assert.ok(counts.includes(1) && counts.includes(2), 'products legitimately end with 1 OR 2 bound accounts (not all the same two)');
  assert.equal(counts.filter(n => n === 2).length > 0 && counts.filter(n => n === 1).length > 0, true);
  assert.equal(h.calls.header, 1, 'exactly one header select-all');
  assert.equal(h.calls.commit, 1, 'exactly one drawer 确定');
  assert.equal(h.calls.warning, 1, 'exactly one partial-warning accept');
});

test('R133 a blocked initial panel navigates to a usable subset anchor and proves all 30 (no result modal) with mixed 1/2', async () => {
  const ids = IDS30.slice();
  const h = R133_FRESH(ids, R133_CYCLES.B, { result: 'absent' });
  const res = await h.driver().bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, true, JSON.stringify(res.reason));
  assert.notEqual(res.partial, true, 'no product failed: every one kept >=1 usable target');
  assert.deepEqual(res.failedIds, []);
  assert.deepEqual(res.accountIds.slice().sort(), wf.BUSINESS.boundAccounts.slice().map(String).sort());
  const counts = res.rows.map(r => r.manualAccounts);
  assert.ok(counts.every(n => Number.isInteger(n) && n >= 1), 'every product bound at least one target account');
  assert.ok(counts.includes(1) && counts.includes(2), 'mixed 1/2 across the batch');
  assert.equal(h.calls.header, 1);
  assert.equal(h.calls.commit, 1);
  assert.equal(h.calls.warning, 1);
  assert.ok(h.calls.panelNav >= 1, 'the bounded read-only panel navigation really ran');
});

test('R133 a late-rendering 2→1 or 1→2 subset of the SAME verified target is render order, never identity drift', async () => {
  const ids = IDS30.slice();
  const base = { ok: true, spinnerCount: 0, headerLabelDisabled: false, panelProductIds: ids.map(String), activeProductIds: [String(ids[0])], totalCount: 30 };
  const two = (footerNull) => ({ ...base, rows: [{ ids: [R133_A1], checked: false, labelDisabled: false }, { ids: [R133_A2], checked: false, labelDisabled: true }], selectedCount: footerNull ? null : 0 });
  const one = (footerNull) => ({ ...base, rows: [{ ids: [R133_A1], checked: false, labelDisabled: false }], selectedCount: footerNull ? null : 0 });
  const cases = [
    ['2to1', [two(true), one(false)]],
    ['1to2', [one(true), two(false)]],
  ];
  for (const [name, overrides] of cases) {
    const h = R133_FRESH(ids, R133_CYCLES.all2, { overrides: overrides.slice(), nativeScrollTimeoutMs: 1200 });
    const res = await h.driver().bindAccountsToAll({ productIds: ids });
    assert.equal(res.ok, true, name + ': ' + JSON.stringify(res.reason));
    assert.deepEqual(res.accountIds.slice().sort(), wf.BUSINESS.boundAccounts.slice().map(String).sort(), name);
    assert.equal(h.calls.header, 1, name + ': the drawer settled and the header fired exactly once');
    assert.equal(h.calls.commit, 1, name);
  }
});

test('R133 a transient FOREIGN account during the drawer settle poisons it permanently: fail-closed, zero clicks', async () => {
  const ids = IDS30.slice();
  const base = { ok: true, spinnerCount: 0, headerLabelDisabled: false, panelProductIds: ids.map(String), activeProductIds: [String(ids[0])], totalCount: 30, selectedCount: 0 };
  const foreign = { ...base, rows: [{ ids: [R133_FOREIGN], checked: false, labelDisabled: false }] };
  const h = R133_FRESH(ids, R133_CYCLES.all2, { overrides: [foreign, foreign], nativeScrollTimeoutMs: 1200 });
  const res = await h.driver().bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'account-drawer-does-not-show-exact-two-target-accounts', 'a foreign id is never waited away');
  assert.equal(h.calls.header, 0, 'zero header select-all behind a poisoned identity');
  assert.equal(h.calls.commit, 0, 'zero drawer 确定');
  assert.notEqual(res.accountUnavailableProven, true);
  assert.equal(res.bindingEvidence.proven, false);
});

test('R133 a foreign / ambiguous / unknown / duplicate account row on a navigated panel keeps the exact identity-drift stop, zero clicks', async () => {
  const ids = IDS30.slice();
  const cases = [
    ['foreign-C', [{ ids: [R133_A1], checked: false, labelDisabled: false }, { ids: [R133_FOREIGN], checked: false, labelDisabled: false }]],
    ['ambiguous-row', [{ ids: [R133_A1, R133_A2], checked: false, labelDisabled: false }]],
    ['unknown-empty-id', [{ ids: [], checked: false, labelDisabled: false }]],
    ['duplicate-id', [{ ids: [R133_A1], checked: false, labelDisabled: false }, { ids: [R133_A1], checked: false, labelDisabled: false }]],
  ];
  for (const [name, driftRows] of cases) {
    const spec = {};
    spec[String(ids[0])] = [dA1, dA2];           // fully-disabled initial => bounded navigation
    spec[String(ids[1])] = { raw: driftRows };    // the first navigated candidate carries the bad identity
    ids.slice(2).forEach(id => { spec[String(id)] = [dA1]; });
    const h = R133_FRESH(ids, spec);
    const res = await h.driver().bindAccountsToAll({ productIds: ids });
    assert.equal(res.ok, false, name);
    assert.equal(res.reason, 'account-anchor-account-identity-drift', name + ': ' + JSON.stringify(res.reason));
    assert.equal(h.calls.header, 0, name + ': zero header select-all');
    assert.equal(h.calls.commit, 0, name + ': zero drawer 确定');
    assert.notEqual(res.accountUnavailableProven, true, name + ': a drift stop never carries the 30/30 unavailable proof');
    assert.notEqual(res.duplicateProven, true, name);
    assert.equal(res.bindingEvidence.proven, false, name + ': the batch is not removable');
  }
});

test('R133 an empty account drawer (no bindable target row) stays fail-closed with zero clicks', async () => {
  const ids = IDS30.slice();
  const h = R133_FRESH(ids, () => []);
  const res = await h.driver().bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'account-drawer-does-not-show-exact-two-target-accounts', JSON.stringify(res.reason));
  assert.equal(h.calls.header, 0);
  assert.equal(h.calls.commit, 0);
  assert.notEqual(res.accountUnavailableProven, true);
  assert.equal(res.bindingEvidence.proven, false);
});

test('R133 the 30/30 no-usable-account proof survives subset rendering (R130 gate preserved), never a duplicate disguise', async () => {
  const ids = IDS30.slice();
  const spec = {};
  spec[String(ids[0])] = [dA1, dA2];  // initial all-disabled panel
  ids.slice(1).forEach(id => { spec[String(id)] = [dA1]; }); // every other product: a single disabled target row
  const h = R133_FRESH(ids, spec);
  const res = await h.driver().bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'account-anchor-no-usable-product', JSON.stringify(res.reason));
  assert.equal(res.accountUnavailableProven, true, 'the exact 30/30 per-product proof still lands');
  assert.equal(Object.prototype.hasOwnProperty.call(res, 'duplicateProven'), false, 'never laundered into a duplicate proof');
  assert.equal(res.rows.length, 30);
  assert.equal(res.failedIds.length, 30);
  assert.ok(res.rows.every(r => r.accountUnavailableProven === true), 'every product carries its own proof');
  const kinds = new Map(res.rows.map(r => [String(r.productId), r.accountUnavailableEvidence.kind]));
  assert.equal(kinds.get(String(ids[0])), 'all-rows-disabled');
  assert.equal(kinds.get(String(ids[5])), 'all-rows-disabled', 'a single disabled subset row is the same all-disabled proof');
  assert.equal(res.bindingEvidence.proven, true, 'the proven batch is removable');
  assert.equal(h.calls.header, 0, 'zero header select-all on an all-unavailable batch');
});

test('R133 preparePlan: a binding whose 30 rows mix 1 and 2 bound target accounts freezes ready without any repair', async () => {
  const ids = IDS30.slice();
  const mixed = ids.map((id, i) => ({
    productId: id, text: 'ID：' + id, manualAccounts: i % 2 === 0 ? 1 : 2,
    manualEvidence: true, manualCountKnown: true, autoPullOnly: false, reviewFailed: false, alreadyPlanned: false,
  }));
  let repairs = 0, configures = 0, stableCalls = 0;
  const res = await wf.preparePlan({
    requireRealDrivers: true, businessDate: '2026-10-21', planNumber: 1, runId: 'r133-prepare', persistState: async () => {},
    dayState: wf.newDayState('2026-10-21'), catalogRemainingIds: [],
    openCreationPage: async () => ({ header: { originOk: true, accountId: wf.BUSINESS.accountId, commissionOptionPresent: true } }),
    browseProducts: async () => ({ ok: true, selectedIds: ids.slice(), attempted: [], cursor: { category: '全部', page: 38 } }),
    bindAccountsToAll: async () => ({ ok: true, accountIds: wf.BUSINESS.boundAccounts.slice().map(String), productCount: 30, rows: mixed, partial: false, failedIds: [] }),
    readMainTable: async () => mixed,
    awaitMainTableStable: async () => { stableCalls++; return { ok: true, rows: mixed, stableReads: 3 }; },
    repairDraft: async () => { repairs++; return { ok: true }; },
    configurePlan: async () => { configures++; return { ok: true, planName: '2026-10-21_千川乘方_12:00:00' }; },
  });
  assert.equal(res.status, 'ready-awaiting-confirmation', JSON.stringify(res.reason));
  assert.equal(repairs, 0, 'a mixed 1/2 batch is already valid: zero removals');
  assert.equal(configures, 1);
  assert.ok(stableCalls >= 1);
  assert.deepEqual(res.frozen.boundAccounts.slice().sort(), wf.BUSINESS.boundAccounts.slice().map(String).sort(), 'the frozen plan carries the full verified target set');
  assert.equal(res.frozen.productIds.length, 30);
  assert.equal(res.readiness.ready, true);
});

// ── 20. R134: a DISCOVERY shop freezes the WHOLE-BATCH UNION via a read-only 30-panel scan, never the first product ─
// Real 2026-10-20 continuation stop `prepare-stopped:account-anchor-account-identity-drift` (瑾漂亮潮流服饰,
// page38 resume, attempted=90, zero publication / noReplay). Fact correction: the shop's business.boundAccounts
// AND config boundAccounts are BOTH null => the UNRESOLVED discovery branch; the previous round wrongly assumed a
// preconfigured account set. The old code froze the FIRST product panel's accounts as the whole-shop set (or froze
// a too-narrow set from an earlier batch) and then rejected later products' legitimate [B,A] panels as foreign
// drift. Business rule: every product needs AT LEAST ONE usable 抖音号 — the 30 products do NOT all have to expose
// the same accounts. R134: inside the exact 30-product panel, a READ-ONLY per-panel scan (ordinary .panel
// navigation only, zero checkbox/header/batch/commit clicks) proves every panel identity — strictly non-empty
// 1..10 rows, one unique well-formed known id per row, no duplicate/ambiguous/unknown id inside a panel, no
// 30-panel-set or active drift — and only the COMPLETED full-batch union (<=10) is frozen. Afterwards every
// product may show ANY NON-EMPTY SUBSET of that union; a foreign C / duplicate / ambiguous / unknown / empty
// panel / panel-set drift still fails closed with zero submission. These cases drive the ACTUAL
// createRealDrivers().bindAccountsToAll in discovery mode (legacyBusiness:false, NO boundAccounts).
const R134_ACCOUNT = '1696626252631053';
const R134_OUTSIDE = '999000111222333444';
function r134Harness(ids, spec, opt = {}) {
  const specMap = r133SpecMap(ids, spec);
  const overrides = (opt.overrides || []).slice();
  let active = String(ids[0]);
  let phase = 'initial';
  let anchorPid = null;
  const anchorChecked = new Set();
  const failedSet = new Set();
  const calls = { header: 0, commit: 0, warning: 0, batch: 0, modalConfirm: 0, ack: 0, panelNav: 0 };
  const entryOf = pid => specMap.get(String(pid)) || [];
  function rowFor(pid, r) {
    let checked;
    if (phase === 'initial') checked = false;
    else if (phase === 'anchor') checked = r.enabled && String(pid) === anchorPid;
    else checked = r.enabled && anchorChecked.has(r.id); // batch
    return { ids: [r.id], checked, labelDisabled: !r.enabled };
  }
  // A plain array spec entry is the account-row list; `{raw:[...]}` / `{panelDrift:[...]}` /
  // `{activeDrift:[...]}` render those drawer rows VERBATIM (malformed / drifted panels).
  const drawerRowsOf = pid => {
    const s = entryOf(pid);
    if (Array.isArray(s)) return s.map(r => rowFor(pid, r));
    if (s && Array.isArray(s.raw)) return s.raw;
    if (s && Array.isArray(s.panelDrift)) return s.panelDrift;
    if (s && Array.isArray(s.activeDrift)) return s.activeDrift;
    return [];
  };
  const enabledIds = pid => { const s = entryOf(pid); return Array.isArray(s) ? s.filter(r => r.enabled).map(r => r.id) : []; };
  const snapFor = pid => {
    if (overrides.length) return overrides.shift();
    const s = entryOf(pid);
    const rows = drawerRowsOf(pid);
    const checkedN = rows.filter(r => r.checked === true).length;
    const panelProductIds = (s && Array.isArray(s.panelDrift)) ? ids.map(String).slice(0, 29).concat([R134_OUTSIDE]) : ids.map(String);
    const activeProductIds = (s && Array.isArray(s.activeDrift)) ? [R134_OUTSIDE] : [String(pid)];
    return {
      ok: true, spinnerCount: 0, headerLabelDisabled: false, panelProductIds,
      activeProductIds, rows, selectedCount: checkedN, totalCount: 30,
    };
  };
  const mainRows = () => ids.map(id => {
    const s = entryOf(id);
    let ma = 0;
    if (phase === 'batch' && Array.isArray(s)) ma = s.filter(r => r.enabled && anchorChecked.has(r.id)).length;
    return { productId: id, text: 'ID：' + id, manualAccounts: ma, manualEvidence: true, manualCountKnown: true, autoPullOnly: false, reviewFailed: false, alreadyPlanned: false };
  });
  const page = {
    url: () => 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi?aavid=' + R134_ACCOUNT,
    evaluate: async (fn, arg) => {
      if (fn === rp.readMainTableInPage) return { ok: true, rows: mainRows() };
      if (fn === rp.bindingDrawerSnapshotInPage) return snapFor(active);
      if (fn === rp.selectBindingDrawerPanelInPage) { active = String(arg); calls.panelNav++; return { clicked: true, id: String(arg) }; }
      if (fn === rp.selectAllAccountsInPage) {
        calls.header++; anchorPid = active; phase = 'anchor';
        enabledIds(anchorPid).forEach(id => anchorChecked.add(id));
        return { clicked: true };
      }
      if (fn === rp.applyBatchAccountsInPage) { calls.batch++; return { clicked: true }; }
      if (fn === rp.batchAddAllModalSnapshotInPage) return { modalCount: 1, productCount: ids.length - 1, accountCount: anchorChecked.size, drawerSettled: true };
      if (fn === rp.confirmBatchAddAllModalInPage) {
        calls.modalConfirm++; phase = 'batch'; failedSet.clear();
        for (const id of ids) {
          if (String(id) === String(anchorPid)) continue;
          if (!enabledIds(id).some(aid => anchorChecked.has(aid))) failedSet.add(String(id));
        }
        return { clicked: true };
      }
      if (fn === rp.batchResultSnapshotInPage) {
        if (opt.result === 'absent') return { present: false, known: false, settled: false };
        return { present: true, known: true, settled: true, anchorMismatch: false, outsideIds: [], duplicateRows: 0, unreadableRows: 0, failedIds: [...failedSet] };
      }
      if (fn === rp.acknowledgeBatchResultInPage) { calls.ack++; return { acknowledged: true, failedIds: [...failedSet] }; }
      if (fn === rp.confirmBatchAccountsApplyInPage) { calls.commit++; return { clicked: true }; }
      if (fn === rp.acceptPartialDraftWarningInPage) { calls.warning++; return { accepted: true }; }
      if (fn === rp.bindingOverlaySnapshotInPage) return { accountDrawerCount: 1, blockingOverlayPresent: false };
      if (fn === rp.bindingRowTooltipInPage) return { ok: false };
      if (fn === rp.openAnchorManagementInPage) return { ok: false };
      if (fn === rp.guidanceActionInPage) return { present: false, unknown: null, roots: [] };
      throw new Error('R134 unexpected ' + (fn && fn.name));
    },
  };
  const driver = () => rp.createRealDrivers({
    page, managerPage: {}, context: {}, dayState: { lastSelected: [], cursor: { seenProductIds: [] } }, persist: async () => {},
    publishedIds: new Set(), attemptedSet: new Set(), hints: {}, accountId: R134_ACCOUNT, business: { accountId: R134_ACCOUNT }, opened: {}, projectRoot: __dirname,
    planNumber: 1, runId: 'offline-r134', legacyBusiness: false, nativeScrollTimeoutMs: opt.nativeScrollTimeoutMs || 60,
  });
  return {
    driver, calls, ids, failedSet,
    setSpec: (pid, entry) => { specMap.set(String(pid), entry); },
    reset: () => { phase = 'initial'; active = String(ids[0]); anchorPid = null; anchorChecked.clear(); failedSet.clear(); },
    get phase() { return phase; },
  };
}

test('R134 discovery: first product [A], later products [B,A] — the read-only 30-panel scan freezes union [A,B], then the batch succeeds', async () => {
  const ids = IDS30.slice();
  const spec = {};
  spec[String(ids[0])] = [eA1];                                   // the first panel exposes ONLY A
  ids.slice(1).forEach(id => { spec[String(id)] = [eA2, eA1]; }); // every later panel exposes [B,A]
  const h = r134Harness(ids, spec);
  const drv = h.driver();
  assert.equal(drv.resolvedBoundAccounts, null, 'a discovery shop starts with NO resolved targets');
  const res = await drv.bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, true, JSON.stringify(res.reason));
  assert.deepEqual(res.accountIds.slice().sort(), [R133_A1, R133_A2].sort(), 'the frozen set is the WHOLE-BATCH union [A,B], never the first product [A]');
  assert.deepEqual(drv.resolvedBoundAccounts.slice().sort(), [R133_A1, R133_A2].sort(), 'the driver instance resolved to the scanned union');
  assert.notEqual(res.partial, true);
  assert.deepEqual(res.failedIds, []);
  assert.equal(res.productCount, 30);
  assert.ok(res.rows.every(r => r.manualAccounts >= 1), 'every product bound >=1 usable account (the business minimum)');
  assert.equal(h.calls.panelNav, 30, '29 scan navigations + 1 anchor restore: the FULL batch was scanned read-only before the freeze');
  assert.equal(h.calls.header, 1, 'exactly one header select-all — only AFTER the union was frozen');
  assert.equal(h.calls.batch, 1, 'exactly one batch apply');
  assert.equal(h.calls.commit, 1, 'exactly one drawer 确定');
});

test('R134 discovery: a blocked first panel ([A disabled, B enabled]) still scans, freezes the union and binds every product >=1', async () => {
  const ids = IDS30.slice();
  const spec = {};
  spec[String(ids[0])] = [dA1, eA2];                              // blocked header branch (a disabled unchecked row)
  spec[String(ids[1])] = [eA2, eA1];                              // the usable navigation candidate
  ids.slice(2).forEach((id, i) => { spec[String(id)] = i % 2 === 0 ? [eA1] : [eA2, eA1]; });
  const h = r134Harness(ids, spec);
  const res = await h.driver().bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, true, JSON.stringify(res.reason));
  assert.deepEqual(res.accountIds.slice().sort(), [R133_A1, R133_A2].sort(), 'the union covers A even though the anchor candidate itself selects only B');
  assert.notEqual(res.partial, true, 'the A-only products are covered by the batch because the usable candidate exposes both');
  assert.deepEqual(res.failedIds, []);
  assert.ok(res.rows.every(r => r.manualAccounts >= 1), 'every product ends with >=1 bound account, mixed 1/2 allowed');
  assert.ok(res.rows.map(r => r.manualAccounts).includes(1) && res.rows.map(r => r.manualAccounts).includes(2), 'not all products share the same account set');
  assert.equal(h.calls.panelNav, 31, '29 scan + 1 restore + 1 bounded candidate navigation');
  assert.equal(h.calls.header, 1);
  assert.equal(h.calls.commit, 1);
});

test('R134 discovery: reversed order and different non-empty subsets of the union all bind (>=1 each), zero false failures', async () => {
  const ids = IDS30.slice();
  const spec = {};
  spec[String(ids[0])] = [eA2, eA1];                              // reversed-order first panel exposing the full union
  ids.slice(1).forEach((id, i) => {
    const m = i % 4;
    spec[String(id)] = m === 0 ? [eA1] : m === 1 ? [eA2] : m === 2 ? [eA1, eA2] : [eA2, eA1];
  });
  const h = r134Harness(ids, spec);
  const res = await h.driver().bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, true, JSON.stringify(res.reason));
  assert.deepEqual(res.accountIds.slice().sort(), [R133_A1, R133_A2].sort());
  assert.notEqual(res.partial, true);
  assert.deepEqual(res.failedIds, []);
  const counts = res.rows.map(r => r.manualAccounts);
  assert.ok(counts.every(n => n >= 1));
  assert.ok(counts.includes(1) && counts.includes(2), 'products legitimately end with 1 OR 2 bound accounts');
  assert.equal(h.calls.panelNav, 30);
  assert.equal(h.calls.header, 1);
  assert.equal(h.calls.commit, 1);
});

test('R134 discovery: a product whose usable accounts miss the frozen-anchor selection stays an honest partial failure, never a false success', async () => {
  const ids = IDS30.slice();
  const spec = {};
  spec[String(ids[0])] = [eA2];                                   // the anchor can only select B
  ids.slice(1).forEach((id, i) => { spec[String(id)] = i % 2 === 0 ? [eA1, eA2] : [eA2]; });
  spec[String(ids[3])] = [eA1];                                   // A-only: the B batch cannot bind it
  const h = r134Harness(ids, spec);
  const res = await h.driver().bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, true, JSON.stringify(res.reason));
  assert.deepEqual(res.accountIds.slice().sort(), [R133_A1, R133_A2].sort(), 'the scan still froze the full union [A,B]');
  assert.equal(res.partial, true);
  assert.deepEqual(res.failedIds, [String(ids[3])], 'exactly the product the batch could not reach is failed — repair handles it, no false success');
  assert.equal(h.calls.warning, 1);
  assert.equal(h.calls.commit, 1);
});

test('R134 discovery: a duplicate / ambiguous / unknown / EMPTY panel inside the scan keeps the identity-drift stop with zero clicks', async () => {
  const ids = IDS30.slice();
  const cases = [
    ['duplicate-id', { raw: [{ ids: [R133_A1], checked: false, labelDisabled: false }, { ids: [R133_A1], checked: false, labelDisabled: false }] }],
    ['ambiguous-row', { raw: [{ ids: [R133_A1, R133_A2], checked: false, labelDisabled: false }] }],
    ['unknown-empty-id', { raw: [{ ids: [], checked: false, labelDisabled: false }] }],
    ['empty-panel', { raw: [] }],
  ];
  for (const [name, bad] of cases) {
    const spec = {};
    spec[String(ids[0])] = [eA1];
    spec[String(ids[1])] = bad;                                   // the first navigated panel carries the bad identity
    ids.slice(2).forEach(id => { spec[String(id)] = [eA1]; });
    const h = r134Harness(ids, spec);
    const res = await h.driver().bindAccountsToAll({ productIds: ids });
    assert.equal(res.ok, false, name);
    assert.equal(res.reason, 'account-anchor-account-identity-drift', name + ': ' + JSON.stringify(res.reason));
    assert.equal(h.calls.header, 0, name + ': zero header select-all');
    assert.equal(h.calls.batch, 0, name + ': zero batch apply');
    assert.equal(h.calls.modalConfirm, 0, name + ': zero modal 确定');
    assert.equal(h.calls.commit, 0, name + ': zero drawer 确定');
    assert.equal(h.calls.panelNav, 1, name + ': stopped at the first navigated panel');
    assert.notEqual(res.accountUnavailableProven, true, name + ': a drift stop never carries the 30/30 unavailable proof');
    assert.notEqual(res.duplicateProven, true, name);
    assert.equal(res.bindingEvidence.proven, false, name + ': the batch is not removable');
  }
});

test('R134 discovery: panel-set drift and active drift inside the scan stop fail-closed with zero clicks', async () => {
  const ids = IDS30.slice();
  const goodRow = { ids: [R133_A1], checked: false, labelDisabled: false };
  const cases = [
    ['account-anchor-panel-set-drift', { panelDrift: [goodRow] }],
    ['account-anchor-active-drift', { activeDrift: [goodRow] }],
  ];
  for (const [reason, bad] of cases) {
    const spec = {};
    spec[String(ids[0])] = [eA1];
    spec[String(ids[1])] = bad;
    ids.slice(2).forEach(id => { spec[String(id)] = [eA1]; });
    const h = r134Harness(ids, spec);
    const res = await h.driver().bindAccountsToAll({ productIds: ids });
    assert.equal(res.ok, false, reason);
    assert.equal(res.reason, reason, JSON.stringify(res.reason));
    assert.equal(h.calls.header, 0, reason + ': zero header select-all');
    assert.equal(h.calls.batch, 0, reason + ': zero batch apply');
    assert.equal(h.calls.commit, 0, reason + ': zero drawer 确定');
    assert.equal(res.bindingEvidence.proven, false, reason);
  }
});

test('R134 discovery: an 11th distinct account across the batch exceeds the union cap of 10 and stops with zero clicks', async () => {
  const ids = IDS30.slice();
  const ten = Array.from({ length: 10 }, (_, i) => ({ id: 'union_acct_' + String(i).padStart(2, '0'), enabled: true }));
  const spec = {};
  spec[String(ids[0])] = ten;                                     // the first panel alone fills the cap
  spec[String(ids[1])] = [{ id: 'union_acct_10', enabled: true }]; // the 11th distinct id
  ids.slice(2).forEach(id => { spec[String(id)] = [ten[0]]; });
  const h = r134Harness(ids, spec);
  const res = await h.driver().bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'too-many-bindable-target-accounts', JSON.stringify(res.reason));
  assert.equal(h.calls.header, 0);
  assert.equal(h.calls.batch, 0);
  assert.equal(h.calls.commit, 0);
  assert.equal(res.bindingEvidence.proven, false);
});

test('R134 discovery: after the union is frozen, a FOREIGN account C on a later round poisons the settle — zero clicks, zero submission', async () => {
  const ids = IDS30.slice();
  const spec = {};
  spec[String(ids[0])] = [eA1];
  ids.slice(1).forEach((id, i) => { spec[String(id)] = i % 2 === 0 ? [eA2, eA1] : [eA1]; });
  const h = r134Harness(ids, spec);
  const drv = h.driver();
  const first = await drv.bindAccountsToAll({ productIds: ids });
  assert.equal(first.ok, true, JSON.stringify(first.reason));
  assert.deepEqual(drv.resolvedBoundAccounts.slice().sort(), [R133_A1, R133_A2].sort(), 'round 1 froze exactly the scanned union');
  const before = { ...h.calls };
  // A later rebind round on the SAME driver meets an account outside the frozen union.
  h.reset();
  h.setSpec(String(ids[0]), [{ id: R133_FOREIGN, enabled: true }]);
  const second = await drv.bindAccountsToAll({ productIds: ids });
  assert.equal(second.ok, false);
  assert.equal(second.reason, 'account-drawer-does-not-show-exact-two-target-accounts', JSON.stringify(second.reason));
  assert.equal(h.calls.header, before.header, 'zero NEW header select-all against a foreign id');
  assert.equal(h.calls.batch, before.batch, 'zero NEW batch apply');
  assert.equal(h.calls.modalConfirm, before.modalConfirm, 'zero NEW modal 确定');
  assert.equal(h.calls.commit, before.commit, 'zero NEW drawer 确定');
  assert.equal(second.bindingEvidence.proven, false);
});

// ── 21. R135: the real drawer flips the clicked .panel active LATE — the batch-result
// proof must bounded-wait the switch, never judge one immediate post-click read ────────
// Driven through the REAL createRealDrivers().bindAccountsToAll on the no-result-modal
// full-probe path (proveAllSuccessByPanelNavigation). The injection arms ONLY after the
// batch confirm (phase 'batch') and ONLY for one navigated product, so the read-only
// discovery 30-panel scan and its freeze semantics run completely unchanged.
function r135Harness(ids, opt = {}) {
  const specMap = r133SpecMap(ids, () => [eA1, eA2]);
  let active = String(ids[0]);
  let phase = 'initial';
  let anchorPid = null;
  const anchorChecked = new Set();
  const calls = { header: 0, commit: 0, warning: 0, batch: 0, modalConfirm: 0, ack: 0, panelNav: 0, injected: 0 };
  const entryOf = pid => specMap.get(String(pid)) || [];
  const rowFor = (pid, r) => {
    let checked;
    if (phase === 'initial') checked = false;
    else if (phase === 'anchor') checked = r.enabled && String(pid) === anchorPid;
    else checked = r.enabled && anchorChecked.has(r.id);
    return { ids: [r.id], checked, labelDisabled: !r.enabled };
  };
  const snapFor = pid => {
    const rows = entryOf(pid).map(r => rowFor(pid, r));
    const checkedN = rows.filter(r => r.checked === true).length;
    return {
      ok: true, spinnerCount: 0, headerLabelDisabled: false,
      panelProductIds: ids.map(String), activeProductIds: [String(pid)],
      rows, selectedCount: checkedN, totalCount: 30,
    };
  };
  const st = opt.stale || null;
  let armed = false, prevActive = null;
  let remaining = 0, seqPos = 0;
  // Each injected read may be a fixed kind (legacy `reads` counter) or a per-read sequence
  // (`seq`, optionally followed by a `tail` kind forever — used to start a drift/failure only
  // AFTER the identity phase settled). An exhausted `seq` with no `tail` becomes the settled
  // snapshot, which is how the delayed business outcome finally proves.
  const injectKind = kind => {
    const base = snapFor(active);
    switch (kind) {
      case 'identity-ok': return base; // identity holds; rows are the settled target rows
      case 'stale-active': return snapFor(prevActive); // the PREVIOUS panel is still active (late class flip)
      case 'read-error': throw new Error('R135 execution context destroyed');
      case 'panel-drift': return { ...base, panelProductIds: ids.map(String).slice(0, 29).concat([R134_OUTSIDE]) };
      case 'active-wrong': return { ...base, activeProductIds: [String(ids[9])] };
      case 'active-dup': return { ...base, activeProductIds: [String(active), String(prevActive)] };
      case 'active-none': return { ...base, activeProductIds: [] };
      // Identity (ok/spinner=0/exact panel set/unique target active) holds, but the account rows
      // and checked/footer are still stale or not ready: phase 1 may accept, phase 2 must wait.
      case 'identity-stale-rows': return { ...base, rows: base.rows.map(r => ({ ...r, checked: false })), selectedCount: 0 };
      case 'foreign-row': return { ...base, rows: [{ ids: [R133_FOREIGN], checked: true, labelDisabled: false }, base.rows[1]], selectedCount: 2 };
      case 'dup-row': return { ...base, rows: [{ ids: [R133_A1], checked: true, labelDisabled: false }, { ids: [R133_A1], checked: true, labelDisabled: false }], selectedCount: 2 };
      case 'ambiguous-row': return { ...base, rows: [{ ids: [R133_A1, R133_A2], checked: true, labelDisabled: false }], selectedCount: 1 };
      case 'empty-rows': return { ...base, rows: [], selectedCount: 0 };
      default: throw new Error('R135 unknown stale kind ' + kind);
    }
  };
  const shouldInject = () => armed && (Array.isArray(st.seq) ? (seqPos < st.seq.length || !!st.tail) : remaining > 0);
  const inject = () => {
    let kind;
    if (Array.isArray(st.seq)) {
      kind = seqPos < st.seq.length ? st.seq[seqPos++] : st.tail;
    } else {
      kind = st.kind;
      if (remaining !== Infinity) remaining--;
    }
    calls.injected++;
    return injectKind(kind);
  };
  const mainRows = () => ids.map(id => {
    const s = entryOf(id);
    const ma = phase === 'batch' ? s.filter(r => r.enabled && anchorChecked.has(r.id)).length : 0;
    return { productId: id, text: 'ID：' + id, manualAccounts: ma, manualEvidence: true, manualCountKnown: true, autoPullOnly: false, reviewFailed: false, alreadyPlanned: false };
  });
  const page = {
    url: () => 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi?aavid=' + R134_ACCOUNT,
    evaluate: async (fn, arg) => {
      if (fn === rp.readMainTableInPage) return { ok: true, rows: mainRows() };
      if (fn === rp.bindingDrawerSnapshotInPage) {
        if (shouldInject()) return inject();
        return snapFor(active);
      }
      if (fn === rp.selectBindingDrawerPanelInPage) {
        if (st && phase === 'batch' && !armed && String(arg) === String(st.pid)) {
          armed = true; prevActive = active;
          remaining = Number.isInteger(st.reads) ? st.reads : Infinity;
        }
        active = String(arg); calls.panelNav++; return { clicked: true, id: String(arg) };
      }
      if (fn === rp.selectAllAccountsInPage) {
        calls.header++; anchorPid = active; phase = 'anchor';
        entryOf(anchorPid).filter(r => r.enabled).forEach(r => anchorChecked.add(r.id));
        return { clicked: true };
      }
      if (fn === rp.applyBatchAccountsInPage) { calls.batch++; return { clicked: true }; }
      if (fn === rp.batchAddAllModalSnapshotInPage) return { modalCount: 1, productCount: ids.length - 1, accountCount: anchorChecked.size, drawerSettled: true };
      if (fn === rp.confirmBatchAddAllModalInPage) { calls.modalConfirm++; phase = 'batch'; return { clicked: true }; }
      if (fn === rp.batchResultSnapshotInPage) return { present: false, known: false, settled: false }; // no result modal → the full 30-panel probe
      if (fn === rp.acknowledgeBatchResultInPage) { calls.ack++; return { acknowledged: true, failedIds: [] }; }
      if (fn === rp.confirmBatchAccountsApplyInPage) { calls.commit++; return { clicked: true }; }
      if (fn === rp.acceptPartialDraftWarningInPage) { calls.warning++; return { accepted: true }; }
      if (fn === rp.bindingOverlaySnapshotInPage) return { accountDrawerCount: 1, blockingOverlayPresent: false };
      if (fn === rp.bindingRowTooltipInPage) return { ok: false };
      if (fn === rp.openAnchorManagementInPage) return { ok: false };
      if (fn === rp.guidanceActionInPage) return { present: false, unknown: null, roots: [] };
      throw new Error('R135 unexpected ' + (fn && fn.name));
    },
  };
  const driver = () => rp.createRealDrivers({
    page, managerPage: {}, context: {}, dayState: { lastSelected: [], cursor: { seenProductIds: [] } }, persist: async () => {},
    publishedIds: new Set(), attemptedSet: new Set(), hints: {}, accountId: R134_ACCOUNT, business: { accountId: R134_ACCOUNT }, opened: {}, projectRoot: __dirname,
    planNumber: 1, runId: 'offline-r135', legacyBusiness: false, nativeScrollTimeoutMs: opt.nativeScrollTimeoutMs || 1100,
  });
  return { driver, calls, ids };
}

test('R135 a delayed active switch: the first post-click reads still show the PREVIOUS panel, the bounded re-wait settles on the unique target and the batch succeeds', async () => {
  const ids = IDS30.slice();
  const h = r135Harness(ids, { stale: { pid: ids[5], kind: 'stale-active', reads: 2 } });
  const res = await h.driver().bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, true, JSON.stringify(res.reason));
  assert.equal(h.calls.injected, 2, 'exactly the two late-switch reads were absorbed by the bounded wait');
  assert.notEqual(res.partial, true);
  assert.deepEqual(res.failedIds, []);
  assert.equal(res.productCount, 30);
  assert.deepEqual(res.accountIds.slice().sort(), [R133_A1, R133_A2].sort(), 'the discovery union freeze is unchanged');
  assert.equal(h.calls.panelNav, 61, '29 scan + 1 scan-restore + 30 probe + 1 probe-restore: the FULL 30-panel scan and probe both ran');
  assert.equal(h.calls.header, 1, 'exactly one header select-all — only AFTER the union was frozen');
  assert.equal(h.calls.commit, 1, 'exactly one drawer 确定');
  assert.equal(h.calls.warning, 1, 'the standard post-commit warning census runs once with knownFailures=false');
});

test('R135 transient post-click read rejections during the late re-render never abort the bounded wait into an immediate judgement', async () => {
  const ids = IDS30.slice();
  const h = r135Harness(ids, { stale: { pid: ids[5], kind: 'read-error', reads: 2 } });
  const res = await h.driver().bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, true, JSON.stringify(res.reason));
  assert.equal(h.calls.injected, 2);
  assert.equal(h.calls.commit, 1);
  assert.deepEqual(res.failedIds, []);
  assert.equal(res.productCount, 30);
});

test('R135 a panel set that drifts while waiting for the clicked target is never adopted — the exact fail-closed stop, zero drawer commit', async () => {
  const ids = IDS30.slice();
  const h = r135Harness(ids, { stale: { pid: ids[5], kind: 'panel-drift' } });
  const res = await h.driver().bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'batch-result-panel-target-not-verified', JSON.stringify(res.reason));
  assert.equal(res.diag && res.diag.phase, 'panel-navigation');
  assert.equal(h.calls.commit, 0, 'zero drawer 确定');
  assert.equal(h.calls.warning, 0);
  assert.equal(h.calls.ack, 0, 'zero result ACK');
  assert.equal(h.calls.header, 1, 'the discovery scan/freeze ran unchanged before the probe');
  assert.equal(h.calls.panelNav, 36, '29 scan + 1 scan-restore + 6 probe clicks — stopped at the drifted target');
  assert.equal(res.bindingEvidence.proven, false);
  assert.equal(res.rows.length, 30);
});

test('R135 an ultimately wrong / duplicated / missing / never-switching active after the click still fails closed', async () => {
  const ids = IDS30.slice();
  const cases = [
    ['active-wrong', { kind: 'active-wrong' }],
    ['active-dup', { kind: 'active-dup' }],
    ['active-none', { kind: 'active-none' }],
    ['stale-forever', { kind: 'stale-active' }], // the late switch NEVER lands: honest timeout stop
  ];
  for (const [name, stale] of cases) {
    const h = r135Harness(ids, { stale: { pid: ids[5], ...stale } });
    const res = await h.driver().bindAccountsToAll({ productIds: ids });
    assert.equal(res.ok, false, name);
    assert.equal(res.reason, 'batch-result-panel-target-not-verified', name + ': ' + JSON.stringify(res.reason));
    assert.equal(h.calls.commit, 0, name + ': zero drawer 确定');
    assert.equal(h.calls.warning, 0, name);
    assert.equal(h.calls.ack, 0, name);
    assert.equal(res.bindingEvidence.proven, false, name);
    const raw = JSON.stringify(res.diag || null);
    assert.equal(raw.includes(R133_A1) || raw.includes(R133_A2), false, name + ': diag carries no account id');
  }
});

test('R135 foreign / duplicate / ambiguous / EMPTY account rows on the settled late target are NOT loosened by the re-wait', async () => {
  const ids = IDS30.slice();
  const cases = [
    ['foreign-row', { kind: 'foreign-row' }],
    ['dup-row', { kind: 'dup-row' }],
    ['ambiguous-row', { kind: 'ambiguous-row' }],
    ['empty-rows', { kind: 'empty-rows' }],
  ];
  for (const [name, stale] of cases) {
    const h = r135Harness(ids, { stale: { pid: ids[5], ...stale } });
    const res = await h.driver().bindAccountsToAll({ productIds: ids });
    assert.equal(res.ok, false, name);
    assert.equal(res.reason, 'batch-result-panel-target-not-verified', name + ': ' + JSON.stringify(res.reason));
    assert.equal(res.diag && res.diag.phase, 'panel-navigation', name);
    assert.equal(h.calls.commit, 0, name + ': zero drawer 确定');
    assert.equal(h.calls.warning, 0, name);
    assert.equal(h.calls.ack, 0, name);
    assert.equal(res.bindingEvidence.proven, false, name);
    assert.equal(res.rows.length, 30, name);
  }
});

// ── 22. R135/R136 STRICT TWO-PHASE BUDGET: identity first, business outcome second ─────
// These drive the REAL createRealDrivers().bindAccountsToAll. The critical case fails
// WITHOUT the fix: the old code spent ONE budget on proves(); when the click's active
// only settles at the very end of that budget it then judged the FIRST still-stale
// rows/footer read immediately after the identity re-wait. The sequential budget below
// gives the delayed business outcome its own window that starts at identity settle.
test('R135/R136 strict two-phase budget: stale old active, then unique target active with stale rows/footer, then a delayed proves success — the batch succeeds', async () => {
  const ids = IDS30.slice();
  const h = r135Harness(ids, {
    stale: {
      pid: ids[5],
      seq: ['stale-active', 'stale-active', 'identity-stale-rows', 'identity-stale-rows'],
    },
  });
  const res = await h.driver().bindAccountsToAll({ productIds: ids });
  assert.equal(res.ok, true, JSON.stringify(res.reason));
  assert.equal(h.calls.injected, 4, 'two late-active reads + two identity-only stale rows reads absorbed before the outcome');
  assert.notEqual(res.partial, true);
  assert.deepEqual(res.failedIds, []);
  assert.equal(res.productCount, 30);
  assert.deepEqual(res.accountIds.slice().sort(), [R133_A1, R133_A2].sort(), 'the discovery union freeze is unchanged');
  assert.equal(h.calls.panelNav, 61, '29 scan + 1 scan-restore + 30 probe + 1 probe-restore');
  assert.equal(h.calls.header, 1, 'exactly one header select-all');
  assert.equal(h.calls.commit, 1, 'exactly one drawer 确定');
  assert.equal(h.calls.warning, 1);
  assert.equal(h.calls.ack, 0, 'zero result ACK on the no-modal full-success path');
});

test('R135/R136 phase 2 re-proves the exact panel set + unique target active on every read and keeps every row gate closed', async () => {
  const ids = IDS30.slice();
  const cases = [
    ['panel-drift', 'panel-drift'],
    ['active-redrift', 'active-wrong'],
    ['active-dup', 'active-dup'],
    ['active-none', 'active-none'],
    ['foreign-row', 'foreign-row'],
    ['dup-row', 'dup-row'],
    ['ambiguous-row', 'ambiguous-row'],
    ['empty-rows', 'empty-rows'],
  ];
  for (const [name, tail] of cases) {
    const h = r135Harness(ids, {
      stale: { pid: ids[5], seq: ['stale-active', 'stale-active', 'identity-ok'], tail },
    });
    const res = await h.driver().bindAccountsToAll({ productIds: ids });
    assert.equal(res.ok, false, name);
    assert.equal(res.reason, 'batch-result-panel-target-not-verified', name + ': ' + JSON.stringify(res.reason));
    assert.equal(res.diag && res.diag.phase, 'panel-navigation', name);
    assert.equal(h.calls.commit, 0, name + ': zero drawer 确定');
    assert.equal(h.calls.warning, 0, name);
    assert.equal(h.calls.ack, 0, name);
    assert.equal(res.bindingEvidence.proven, false, name);
    const raw = JSON.stringify(res.diag || null);
    assert.equal(raw.includes(R133_A1) || raw.includes(R133_A2), false, name + ': diag carries no account id');
  }
});
