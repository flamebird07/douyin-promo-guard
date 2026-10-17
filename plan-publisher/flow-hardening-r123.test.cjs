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
    assert.equal(res.bindingEvidence.proven, false, 'an unproven panel never makes the batch removable: ' + JSON.stringify(opt));
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
