'use strict';
// Offline regression tests. No network, no browser, no real config/credentials.
// Run: node --test direct-draft-controller.test.cjs
// The in-page callbacks (pageObserve/pageApply/actionApply) and the requestShow
// evaluate body are executed against a tiny in-workspace DOM/vm harness so the
// real callbacks -- not a copy of them -- are what is exercised.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const c = require('./direct-draft-controller.cjs');
const wf = require('./plan-workflow.cjs');
const r42 = require('./run-plans.cjs');

// ---------- minimal DOM harness ----------
let SEQ = 0;

const ElementProto = {
  getAttribute(name) {
    if (name === 'class') return this.className != null ? String(this.className) : null;
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
  },
  setAttribute(name, val) {
    if (name === 'class') { this.className = val; return; }
    this.attrs[name] = String(val);
  },
  removeAttribute(name) {
    if (name === 'class') { this.className = ''; return; }
    delete this.attrs[name];
  },
  getBoundingClientRect() {
    const r = this.__rect;
    return r ? { width: r[0], height: r[1], x: r[2] || 0, y: r[3] || 0 } : { width: 0, height: 0, x: 0, y: 0 };
  },
  get innerText() { return this.__computeText(); },
  get textContent() { return this.__computeText(); },
  get children() { return this.__kids; },
  get parentElement() { return this.parent; },
  __computeText() {
    let s = '';
    const walk = n => { if (n.__text != null) s += n.__text + ' '; for (const ch of n.__kids) walk(ch); };
    walk(this);
    return s.replace(/\s+/g, ' ').trim();
  },
  querySelectorAll(sel) { const out = []; const walk = n => { for (const ch of n.__kids) { if (matchesSel(ch, sel)) out.push(ch); walk(ch); } }; walk(this); return out; },
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
  closest(sel) { let n = this; while (n) { if (matchesSel(n, sel)) return n; n = n.parent; } return null; },
  contains(other) { let n = other; while (n) { if (n === this) return true; n = n.parent; } return false; },
  click() { this.__clicked++; },
  dispatchEvent(ev) { this.__events.push(ev && ev.type ? ev.type : 'event'); },
  blur() { this.__blurred = true; },
  focus() {},
  scrollBy() { this.__scrolled = true; },
  remove() { this.isConnected = false; },
};

function El(tag, opts = {}, kids = []) {
  opts = opts || {};
  const el = Object.create(ElementProto);
  el.tagName = String(tag).toUpperCase();
  el.__seq = SEQ++;
  el.attrs = {};
  el.className = opts.class != null ? opts.class : (opts.cls || '');
  el.__text = opts.text != null ? String(opts.text) : null;
  el.__rect = opts.rect;
  el.__vis = opts.hidden ? 'hidden' : 'visible';
  el.disabled = !!opts.disabled;
  if ('checked' in opts) el.checked = opts.checked;
  el.isConnected = true;
  el.__events = []; el.__clicked = 0; el.__kids = []; el.parent = null;
  if (opts.placeholder) el.attrs.placeholder = String(opts.placeholder);
  if (opts.ariaLabel) el.attrs['aria-label'] = opts.ariaLabel;
  if (opts.ariaCurrent) el.attrs['aria-current'] = opts.ariaCurrent;
  if (opts.role) el.attrs.role = opts.role;
  if (opts.type) el.attrs.type = opts.type;
  if (opts.title) el.attrs.title = opts.title;
  if (opts.attrs) for (const k in opts.attrs) el.attrs[k] = String(opts.attrs[k]);
  if ('value' in opts) el.value = opts.value;
  for (const ch of kids) { if (!ch) continue; ch.parent = el; el.__kids.push(ch); }
  return el;
}

function allDesc(node) { const out = []; const walk = n => { for (const ch of n.__kids) { out.push(ch); walk(ch); } }; walk(node); return out; }

function parseCompound(str) {
  const parts = []; let i = 0;
  const tm = str.match(/^[a-zA-Z][a-zA-Z0-9-]*/);
  if (tm) { parts.push({ t: 'tag', v: tm[0].toUpperCase() }); i = tm[0].length; }
  while (i < str.length) {
    if (str[i] === '[') {
      const close = str.indexOf(']', i);
      const inside = str.slice(i + 1, close);
      const am = inside.match(/^([a-zA-Z-]+)([*^$]?=)?"?([^"]*)"?:?$/);
      if (am && am[2]) parts.push({ t: 'attr', name: am[1], op: am[2], val: am[3] });
      else parts.push({ t: 'attr', name: inside.trim(), op: 'present' });
      i = close + 1;
    } else if (str[i] === '.') {
      const mm = str.slice(i).match(/^\.([A-Za-z0-9_-]+)/); parts.push({ t: 'class', v: mm[1] }); i += mm[0].length;
    } else { i++; }
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
  const groups = selStr.split(',');
  return groups.some(g => { const parts = parseCompound(g.trim()); return parts.length > 0 && parts.every(p => matchPart(el, p)); });
}

function HTMLInputElement() {}
HTMLInputElement.prototype = { blur() { this.__blurred = true; }, focus() {}, dispatchEvent(ev) { this.__events = this.__events || []; this.__events.push(ev && ev.type ? ev.type : 'event'); } };
Object.defineProperty(HTMLInputElement.prototype, 'value', {
  configurable: true,
  get() { return this.__value; },
  set(v) { this.value = v; },
});
function HTMLTextAreaElement() {}
HTMLTextAreaElement.prototype = { blur() { this.__blurred = true; }, dispatchEvent() {} };
Object.defineProperty(HTMLTextAreaElement.prototype, 'value', { configurable: true, get() { return this.__value; }, set(v) { this.value = v; } });
function Event(type) { this.type = type; }
function KeyboardEvent(o) { this.key = o && o.key; }

function makePage(bodyKids, pathname, origin) {
  SEQ = 0;
  const body = El('body', {}, bodyKids || []);
  const doc = {
    body,
    querySelectorAll(sel) { if (sel.trim() === 'body *') return allDesc(body); return allDesc(body).filter(el => matchesSel(el, sel)); },
    querySelector(sel) { const a = this.querySelectorAll(sel); return a[0] || null; },
  };
  const windowObj = {};
  const org = origin || 'https://qianchuan.example.com';
  const loc = { pathname: pathname || '/uni-creation/overall-product-multi', origin: org, href: org + (pathname || '/uni-creation/overall-product-multi') };
  let clock = 1700000000000;
  const ctx = {
    window: windowObj, document: doc, location: loc,
    getComputedStyle: el => ({ visibility: el.__vis || 'visible' }),
    HTMLInputElement, HTMLTextAreaElement, Event, KeyboardEvent,
    Date: { now() { return ++clock; } },
    console: { log() {} },
  };
  const context = vm.createContext(ctx);
  windowObj.document = doc; windowObj.location = loc;
  return {
    context, windowObj, doc, body,
    run(fn) { return vm.runInContext('(' + fn.toString() + ').call(window)', context); },
    // Run a controller callback with an argument inside the SAME context so
    // window state established by a prior pageObserve is visible to it.
    runWith(fn, arg) {
      context.__arg = arg;
      return vm.runInContext('window.__r=((' + fn.toString() + ').call(window, __arg))', context);
    },
  };
}

// ---------- fixtures ----------
function pagerFixture(o = {}) {
  const nums = o.numbers || [1, 2, 3];
  const lis = [];
  for (const n of nums) {
    const active = o.active === n;
    const ariaLabel = o.perPageAria ? ('第' + n + '页，共' + (o.total || nums.length) + '页') : undefined;
    const btn = El('button', { rect: [30, 30], text: String(n), ariaLabel, disabled: o.disabledNumbers && o.disabledNumbers.includes(n) });
    lis.push(El('li', { rect: [32, 32], class: active ? 'active' : '', ariaCurrent: active ? 'page' : undefined }, [btn]));
  }
  if (o.ellipsis) {
    lis.push(El('li', { rect: [20, 30], class: 'ellipsis', text: '…' }));
    const btn = El('button', { rect: [30, 30], text: String(o.max || 10) });
    lis.push(El('li', { rect: [32, 32] }, [btn]));
  }
  if (o.showNext !== false) lis.push(El('button', { rect: [40, 30], class: 'arrow-right', text: '下一页' }));
  if (o.showPrev) lis.push(El('button', { rect: [40, 30], class: 'arrow-left', text: '上一页' }));
  if (o.jump) lis.push(El('input', { rect: [60, 30], class: 'ovui-pagination__jump', placeholder: '跳至页' }));
  const pagerUl = El('ul', { class: 'ovui-pager-ul', rect: [600, 40] }, lis);
  const kids = [];
  if (o.total) kids.push(El('span', { rect: [80, 20], text: '共 ' + o.total + ' 页' }));
  kids.push(pagerUl);
  return El('div', { class: 'ovui-pagination', rect: [620, 60] }, kids);
}

function modalFixture(pagerOpts, inner) {
  return El('div', { class: 'ovui-dialog', rect: [800, 600], attrs: { 'aria-modal': 'true', 'aria-label': '选择要投放的商品' } }, [
    El('h2', { rect: [300, 30], text: '选择要投放的商品' }),
    El('div', { class: 'ovui-tabs', rect: [500, 40], hidden: true }, [
      El('button', { rect: [60, 30], text: '全部' }),
      El('button', { rect: [70, 30], text: '店铺新品' }),
    ]),
    El('button', { rect: [70, 30], text: '确认' }),
    El('button', { rect: [80, 30], text: '立即发布' }),
    ...(inner || []),
    pagerFixture(pagerOpts),
  ]);
}

function formItem(label, placeholder) {
  return El('div', { class: 'ovui-form-item', rect: [300, 60] }, [
    El('label', { rect: [150, 24], text: label }),
    El('input', { rect: [140, 30], placeholder }),
  ]);
}

function happyBody() {
  return [
    modalFixture({ numbers: [1, 2, 3], total: 5, active: 2, perPageAria: true }),
    El('input', { rect: [200, 30], placeholder: '搜索商品名称' }),
    formItem('目标ROI(投产比)', '请输入目标ROI'),
    formItem('日预算(元)', '请输入日预算'),
  ];
}

function idxOf(obs, pred) { const e = obs.elements.find(pred); return e ? e.index : -1; }

// ---------- module / pure tests ----------
test('requiring the module has no auth/config/browser side effects and exports the real callbacks', () => {
  assert.equal(typeof c.resolveProjectRoot, 'function');
  assert.equal(typeof c.requestShow, 'function');
  assert.equal(typeof c.resolvePageTarget, 'function');
  assert.equal(typeof c.pageObserve, 'function');
  assert.equal(typeof c.pageApply, 'function');
  assert.equal(typeof c.actionApply, 'function');
  assert.deepEqual(c.ACTION_OPS, ['click', 'fill', 'scroll']);
  assert.ok(!c.ACTION_OPS.includes('page'), 'op=page must be a separate operation, not a relaxed fill');
});

test('resolveProjectRoot requires explicit PROMO_PROJECT_ROOT with adapter files', () => {
  assert.throws(() => c.resolveProjectRoot({}), /PROMO_PROJECT_ROOT/);
  const root = fs.mkdtempSync(path.join(__dirname, 'promo-root-'));
  try {
    assert.throws(() => c.resolveProjectRoot({ PROMO_PROJECT_ROOT: root }), /missing required file/);
    fs.mkdirSync(path.join(root, 'src', 'adapters'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'config.js'), '');
    assert.throws(() => c.resolveProjectRoot({ PROMO_PROJECT_ROOT: root }), /chengfang-reader/);
    fs.writeFileSync(path.join(root, 'src', 'adapters', 'chengfang-reader.js'), '');
    assert.equal(c.resolveProjectRoot({ PROMO_PROJECT_ROOT: root }), path.resolve(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ---------- requestShow (gap E/G: window is a global, not a param; never claim movement) ----------
test('requestShow executes the real evaluate body against a window global and never claims visibility', async () => {
  const calls = [];
  const win = { screen: { availWidth: 1600, availHeight: 900 }, outerWidth: 1600, outerHeight: 900, moveTo() { calls.push('moveTo'); }, resizeTo() { calls.push('resizeTo'); } };
  const page = {
    bringToFront: async () => { calls.push('bringToFront'); },
    // Real Playwright serializes the callback and runs it with window as global.
    evaluate: async fn => vm.runInContext('(' + fn.toString() + ').call(window)', vm.createContext({ window: win })),
  };
  const r = await c.requestShow(page);
  assert.equal(r.requested, true);
  assert.equal(r.userVisible, 'unverified');
  assert.deepEqual(calls, ['bringToFront', 'moveTo', 'resizeTo']);
  assert.equal(r.steps[1].ok, true);
  assert.equal(r.steps[1].actualMovement, 'unverified');
  assert.ok(!('moved' in r.steps[1].detail), 'must not claim moved:true as actual movement');
});

test('requestShow records each failing step separately and still does not fake visibility', async () => {
  const page = { bringToFront: async () => { throw new Error('no front'); }, evaluate: async () => { throw new Error('eval blocked'); } };
  const r = await c.requestShow(page);
  assert.equal(r.requested, true);
  assert.equal(r.userVisible, 'unverified');
  assert.equal(r.steps[0].ok, false); assert.match(r.steps[0].error, /no front/);
  assert.equal(r.steps[1].ok, false); assert.match(r.steps[1].error, /eval blocked/);
});

// ---------- real pageObserve behavior (gap A) ----------
test('real pageObserve finds the unique product modal and reads explicit total + inherited current page', () => {
  const p = makePage(happyBody());
  const obs = p.run(c.pageObserve);
  assert.equal(obs.pagination.modalUnique, true);
  assert.equal(obs.pagination.inProductModal, true);
  assert.equal(obs.pagination.pageCount, 5);
  assert.equal(obs.pagination.pageCountSource, 'total-label');
  assert.equal(obs.pagination.currentPage, 2); // current marker lives on the <li>, leaf <button> inherits it
  const kinds = obs.pagination.items.map(i => i.kind);
  assert.ok(kinds.includes('number'));
});

test('pageObserve refuses an unlabeled contiguous pager: visible max is NOT total (gap B/C)', () => {
  const p = makePage([modalFixture({ numbers: [1, 2, 3, 4], active: 1 })]);
  const obs = p.run(c.pageObserve);
  assert.equal(obs.pagination.pageCount, null, 'a contiguous run 1..max without a total label must NOT be trusted as total');
  assert.equal(obs.pagination.pageCountSource, null);
  assert.equal(obs.pagination.currentPage, 1);
  // unknown total does not gate an observed enabled page: the plan is correct and
  // the total stays unknown
  const plan4 = c.resolvePageTarget(obs, { observation: obs.observation, page: 4 });
  assert.equal(plan4.mode, 'click');
  assert.equal(plan4.expectPage, 4);
  assert.equal(obs.pagination.pageCount, null, 'pageCount must stay null with no total label');
});

test('pageObserve fails closed on an ellipsis/sliding pager with no explicit total (gap C)', () => {
  const p = makePage([modalFixture({ numbers: [1, 2], active: 1, ellipsis: true, max: 10 })]);
  const obs = p.run(c.pageObserve);
  assert.equal(obs.pagination.pageCount, null, 'Math.max of visible numbers must NOT be trusted as total');
  assert.equal(obs.pagination.currentPage, 1);
});

test('pageObserve only accepts a UNIQUE visible product modal (gap B)', () => {
  // No modal at all.
  const none = makePage([El('input', { rect: [100, 30], placeholder: '搜索' })]).run(c.pageObserve);
  assert.equal(none.pagination.modalPresent, false);
  assert.equal(none.pagination.inProductModal, false);

  // The douyin-binding drawer ("为商品添加抖音号", product-name tabs only) is NOT a
  // product drawer: alone it matches nothing, and beside the real modal it no
  // longer creates a false ambiguity.
  const bindingDrawer = () => El('div', { class: 'ovui-modal', rect: [700, 500], attrs: { 'aria-modal': 'true', 'aria-label': '为商品添加抖音号' } }, [
    El('div', { rect: [600, 30], text: '商品名' }),
    El('button', { rect: [120, 30], text: '将所选抖音号批量添加至所有商品' }),
  ]);
  const bindOnly = makePage([bindingDrawer()]).run(c.pageObserve);
  assert.equal(bindOnly.pagination.modalPresent, false);
  const two = makePage([
    modalFixture({ numbers: [1, 2], total: 2, active: 1 }),
    bindingDrawer(),
  ]).run(c.pageObserve);
  assert.equal(two.pagination.modalUnique, true, 'the refused binding drawer must not be counted as a second product root');
  assert.equal(two.pagination.inProductModal, true);

  // Hidden modal root is ignored.
  const hidden = makePage([El('div', { class: 'ovui-dialog', hidden: true, rect: [800, 600], attrs: { 'aria-modal': 'true', 'aria-label': '选择要投放的商品' } }, [El('button', { rect: [50, 30], text: '全部' }), pagerFixture({ numbers: [1, 2], total: 2, active: 1 })])]).run(c.pageObserve);
  assert.equal(hidden.pagination.modalPresent, false);

  // Modal with two sibling ambiguous pagination regions is refused.
  const ambig = makePage([modalFixture({ numbers: [1], active: 1 }, [El('div', { class: 'ovui-pagination second', rect: [300, 40] }, [El('ul', { class: 'ovui-pager-ul', rect: [300, 40] }, [El('li', { rect: [30, 30] }, [El('button', { rect: [30, 30], text: '1' })])])])])]).run(c.pageObserve);
  assert.equal(ambig.pagination.pagAmbiguous, true);
  assert.equal(ambig.pagination.inProductModal, false);
});

// ---------- host gate resolvePageTarget on real observation ----------
test('resolvePageTarget plans a real page click from a real observation', () => {
  const p = makePage(happyBody());
  const obs = p.run(c.pageObserve);
  const plan = c.resolvePageTarget(obs, { observation: obs.observation, page: 3 });
  assert.equal(plan.mode, 'click');
  assert.equal(plan.expectKind, 'number');
  assert.ok(plan.index >= 0);
});

test('resolvePageTarget rejects forged/ambiguous/unknown pagination (gap C/D)', () => {
  const p = makePage(happyBody());
  const obs = p.run(c.pageObserve);
  const ell = makePage([modalFixture({ numbers: [1, 2], active: 1, ellipsis: true, max: 10 })]).run(c.pageObserve);
  const noModal = makePage([El('input', { rect: [100, 30], placeholder: '搜索' })]).run(c.pageObserve);
  assert.throws(() => c.resolvePageTarget(ell, { observation: ell.observation, page: 5 }), /unknown/);
  assert.throws(() => c.resolvePageTarget(noModal, { observation: noModal.observation, page: 2 }), /modal not observed|not inside/);
  assert.throws(() => c.resolvePageTarget(obs, { observation: 'stale', page: 3 }), /Observation expired/);
  assert.throws(() => c.resolvePageTarget(obs, { observation: obs.observation, page: 6 }), /out of observed/);
  assert.throws(() => c.resolvePageTarget(obs, { observation: obs.observation, page: 2 }), /Already on target page/);
});

test('resolvePageTarget only accepts strict positive integers for page', () => {
  const p = makePage(happyBody());
  const obs = p.run(c.pageObserve);
  const o = obs.observation;
  assert.throws(() => c.resolvePageTarget(obs, { observation: o, page: '3' }), /strict positive integer/);
  assert.throws(() => c.resolvePageTarget(obs, { observation: o, page: true }), /strict positive integer/);
  assert.throws(() => c.resolvePageTarget(obs, { observation: o, page: '' }), /strict positive integer/);
  assert.throws(() => c.resolvePageTarget(obs, { observation: o, page: 3.5 }), /strict positive integer/);
  assert.throws(() => c.resolvePageTarget(obs, { observation: o, page: 0 }), /strict positive integer/);
});

// ---------- positive chain pageObserve -> resolvePageTarget -> pageApply (gap D) ----------
test('full chain: pageApply clicks the observed pagination number and dispatches nothing before checks', () => {
  const p = makePage(happyBody());
  const obs = p.run(c.pageObserve);
  const plan = c.resolvePageTarget(obs, { observation: obs.observation, page: 3 });
  const result = p.runWith(c.pageApply, { ...plan, observation: obs.observation });
  assert.equal(result.paged, true);
  assert.equal(result.mode, 'click');
  assert.equal(result.kind, 'number');
});

// ---------- pageApply refuses forged indices that are not observed pagination (gap D) ----------
test('pageApply refuses ROI/budget/search/background/publish indices even when freshly passed', () => {
  const p = makePage(happyBody());
  const obs = p.run(c.pageObserve);
  const o = obs.observation;

  const searchIdx = idxOf(obs, e => e.tag === 'INPUT' && e.placeholder === '搜索商品名称');
  const roiIdx = idxOf(obs, e => e.tag === 'INPUT' && e.placeholder === '请输入目标ROI');
  const publishIdx = idxOf(obs, e => e.text === '立即发布');
  const confirmIdx = idxOf(obs, e => e.text === '确认');
  assert.ok(searchIdx >= 0 && roiIdx >= 0 && publishIdx >= 0 && confirmIdx >= 0);

  assert.throws(() => p.runWith(c.pageApply, { mode: 'click', index: searchIdx, observation: o, expectKind: 'number' }), /not inside the product-selection modal/);
  assert.throws(() => p.runWith(c.pageApply, { mode: 'click', index: roiIdx, observation: o, expectKind: 'number' }), /not inside the product-selection modal/);
  assert.throws(() => p.runWith(c.pageApply, { mode: 'click', index: publishIdx, observation: o, expectKind: 'number' }), /not part of the observed pagination region/);
  assert.throws(() => p.runWith(c.pageApply, { mode: 'click', index: confirmIdx, observation: o, expectKind: 'number' }), /not part of the observed pagination region/);
  // stale observation is rejected before touching anything
  assert.throws(() => p.runWith(c.pageApply, { mode: 'click', index: 0, observation: 'nope', expectKind: 'number' }), /Observation expired/);
});

// ---------- pageApply re-verifies live DOM before any dispatch (gap D, no cached blind trust) ----------
function observedEl(p, index) { return p.context.window.__directDraftElements[index]; }

test('pageApply zero-actions when a second product popup appears after observation', () => {
  const p = makePage(happyBody());
  const obs = p.run(c.pageObserve);
  const plan = c.resolvePageTarget(obs, { observation: obs.observation, page: 3 });
  const el = observedEl(p, plan.index);
  p.body.__kids.push(El('div', { class: 'ovui-modal', rect: [700, 500], attrs: { 'aria-modal': 'true', 'aria-label': '添加商品' } }, [
    El('div', { rect: [600, 30], text: '将所选抖音号批量添加至所有商品 全部' }),
  ]));
  assert.throws(() => p.runWith(c.pageApply, { ...plan, observation: obs.observation }), /no longer uniquely visible/);
  assert.equal(el.__clicked, 0, 'a second popup must produce zero actions');
});

test('pageApply zero-actions when the modal root becomes hidden after observation', () => {
  const p = makePage(happyBody());
  const obs = p.run(c.pageObserve);
  const plan = c.resolvePageTarget(obs, { observation: obs.observation, page: 3 });
  const el = observedEl(p, plan.index);
  p.context.window.__directDraftModalRoot.__vis = 'hidden';
  assert.throws(() => p.runWith(c.pageApply, { ...plan, observation: obs.observation }), /no longer uniquely visible/);
  assert.equal(el.__clicked, 0, 'a hidden root must produce zero actions');
});

test('pageApply zero-actions when the control gains a disabled ancestor', () => {
  const p = makePage(happyBody());
  const obs = p.run(c.pageObserve);
  const plan = c.resolvePageTarget(obs, { observation: obs.observation, page: 3 });
  const el = observedEl(p, plan.index);
  el.parentElement.disabled = true; // the pagination <li> is disabled by its parent
  assert.throws(() => p.runWith(c.pageApply, { ...plan, observation: obs.observation }), /Disabled element/);
  assert.equal(el.__clicked, 0, 'a newly disabled ancestor must produce zero actions');
});

test('pageApply zero-actions when the target leaf text changes its purpose', () => {
  const p = makePage(happyBody());
  const obs = p.run(c.pageObserve);
  const plan = c.resolvePageTarget(obs, { observation: obs.observation, page: 3 });
  const el = observedEl(p, plan.index);
  el.__text = '下一页'; // a number leaf repurposed into a next control
  assert.throws(() => p.runWith(c.pageApply, { ...plan, observation: obs.observation }), /purpose changed/);
  assert.equal(el.__clicked, 0, 'a purpose change must produce zero actions');
});

test('pageApply zero-actions when current/total page shifted after observation', () => {
  const p = makePage(happyBody());
  const obs = p.run(c.pageObserve);
  const plan = c.resolvePageTarget(obs, { observation: obs.observation, page: 3 });
  const el = observedEl(p, plan.index);
  const root = p.context.window.__directDraftModalRoot;
  // move the active marker to page 3 so current page no longer matches the signature
  const all = []; const walk = n => { for (const ch of n.__kids) { all.push(ch); walk(ch); } }; walk(root);
  const li2 = all.find(x => x.getAttribute('aria-current') === 'page');
  li2.removeAttribute('aria-current'); li2.className = '';
  const btn3 = all.find(x => x.tagName === 'BUTTON' && x.__text === '3');
  btn3.parentElement.setAttribute('aria-current', 'page'); btn3.parentElement.className = 'active';
  assert.throws(() => p.runWith(c.pageApply, { ...plan, observation: obs.observation }), /Current or total page changed/);
  assert.equal(el.__clicked, 0, 'a shifted current page must produce zero actions before dispatch');
});

// ---------- A: numbered leaf value must be re-checked before dispatch ----------
test('pageApply zero-actions when an observed number leaf value changes (3 becomes 2)', () => {
  const p = makePage(happyBody());
  const obs = p.run(c.pageObserve);
  const plan = c.resolvePageTarget(obs, { observation: obs.observation, page: 3 });
  const el = observedEl(p, plan.index);
  el.__text = '2'; // stale: clicking this index would now select page 2, not 3
  assert.equal(plan.expectPage, 3);
  assert.throws(() => p.runWith(c.pageApply, { ...plan, observation: obs.observation }), /pagination number changed since observation/);
  assert.equal(el.__clicked, 0, 'a changed page number must produce zero actions');
});

// ---------- B: target must still be visible, inside the region, a live leaf, not disabled ----------
test('pageApply zero-actions when the target leaf becomes hidden', () => {
  const p = makePage(happyBody());
  const obs = p.run(c.pageObserve);
  const plan = c.resolvePageTarget(obs, { observation: obs.observation, page: 3 });
  const el = observedEl(p, plan.index);
  el.__vis = 'hidden';
  assert.throws(() => p.runWith(c.pageApply, { ...plan, observation: obs.observation }), /no longer visible/);
  assert.equal(el.__clicked, 0, 'a hidden target must produce zero actions');
});

test('pageApply zero-actions when the observed leaf moves out of the pagination region', () => {
  const p = makePage(happyBody());
  const obs = p.run(c.pageObserve);
  const plan = c.resolvePageTarget(obs, { observation: obs.observation, page: 3 });
  const el = observedEl(p, plan.index);
  const li = el.parentElement;
  li.__kids = li.__kids.filter(x => x !== el);
  const root = p.context.window.__directDraftModalRoot; // still inside modal, outside region
  el.parent = root; root.__kids.push(el);
  assert.throws(() => p.runWith(c.pageApply, { ...plan, observation: obs.observation }), /no longer inside the current pagination region/);
  assert.equal(el.__clicked, 0, 'a leaf relocated out of the region must produce zero actions');
});

test('pageApply zero-actions for the three disabled forms (html attr, aria, disabled class)', () => {
  // (1) HTML disabled attribute on the target itself
  let p = makePage(happyBody());
  let obs = p.run(c.pageObserve);
  let plan = c.resolvePageTarget(obs, { observation: obs.observation, page: 3 });
  let el = observedEl(p, plan.index);
  el.disabled = true;
  assert.throws(() => p.runWith(c.pageApply, { ...plan, observation: obs.observation }), /Disabled element/);
  assert.equal(el.__clicked, 0);

  // (2) aria-disabled on an ancestor within the region
  p = makePage(happyBody());
  obs = p.run(c.pageObserve);
  plan = c.resolvePageTarget(obs, { observation: obs.observation, page: 3 });
  el = observedEl(p, plan.index);
  el.parentElement.setAttribute('aria-disabled', 'true');
  assert.throws(() => p.runWith(c.pageApply, { ...plan, observation: obs.observation }), /Disabled element/);
  assert.equal(el.__clicked, 0);

  // (3) explicit ovui disabled-class semantics (--disabled modifier)
  p = makePage(happyBody());
  obs = p.run(c.pageObserve);
  plan = c.resolvePageTarget(obs, { observation: obs.observation, page: 3 });
  el = observedEl(p, plan.index);
  el.setAttribute('class', 'ovui-pagination__item--disabled');
  assert.throws(() => p.runWith(c.pageApply, { ...plan, observation: obs.observation }), /Disabled element/);
  assert.equal(el.__clicked, 0);
});

// ---------- D: read-only pagination region metadata for live confirmation ----------
test('pageObserve reports read-only regionText/regionInputs without trusting them for pageCount', () => {
  const labeled = makePage(happyBody()).run(c.pageObserve);
  assert.equal(typeof labeled.pagination.regionText, 'string');
  assert.ok(Array.isArray(labeled.pagination.regionInputs));
  // an unlabeled contiguous pager: metadata is present but pageCount stays null
  const unlabeled = makePage([modalFixture({ numbers: [1, 2, 3, 4], active: 1 })]).run(c.pageObserve);
  assert.equal(unlabeled.pagination.pageCount, null);
  assert.equal(typeof unlabeled.pagination.regionText, 'string');
  // observed enabled page plans correctly even while the total stays unknown
  const plan4 = c.resolvePageTarget(unlabeled, { observation: unlabeled.observation, page: 4 });
  assert.equal(plan4.mode, 'click');
  assert.equal(plan4.expectPage, 4);
  assert.equal(unlabeled.pagination.pageCount, null);
});

// ---------- pageTo dispatch vs confirmation are separate, never auto-retried ----------
test('expectedPageFor computes the landing page from the command and pre-dispatch observation', () => {
  assert.equal(c.expectedPageFor({ currentPage: 2, pageCount: 5 }, { page: 4 }), 4);
  assert.equal(c.expectedPageFor({ currentPage: 2, pageCount: 5 }, { kind: 'next' }), 3);
  assert.equal(c.expectedPageFor({ currentPage: 2, pageCount: 5 }, { kind: 'prev' }), 1);
  assert.equal(c.expectedPageFor({ currentPage: null, pageCount: 5 }, { kind: 'next' }), null);
});

test('evaluatePageConfirmation treats dispatch as unconfirmed until the page moves', () => {
  const ok = c.evaluatePageConfirmation({ currentPage: 2 }, { page: 5 }, { currentPage: 5 });
  assert.equal(ok.confirmed, true); assert.equal(ok.expectedPage, 5); assert.equal(ok.observedCurrentPage, 5);
  // the fake page never moved: dispatch happened but the readback shows page 2 still
  const noPage = c.evaluatePageConfirmation({ currentPage: 2 }, { page: 5 }, { currentPage: 2 });
  assert.equal(noPage.confirmed, false); assert.equal(noPage.observedCurrentPage, 2);
  // a next that did not advance is not confirmed
  assert.equal(c.evaluatePageConfirmation({ currentPage: 2, pageCount: 5 }, { kind: 'next' }, { currentPage: 2 }).confirmed, false);
  // missing readback pagination is treated as unconfirmed
  const none = c.evaluatePageConfirmation({ currentPage: 2 }, { page: 5 }, null);
  assert.equal(none.confirmed, false); assert.equal(none.observedCurrentPage, null);
});

// ---------- actionApply wiring (gap F) ----------
test('actionApply fills only recognized ROI/budget fields, never search/page numbers', () => {
  const p = makePage(happyBody());
  const obs = p.run(c.pageObserve);
  const o = obs.observation;
  const roiIdx = idxOf(obs, e => e.tag === 'INPUT' && e.placeholder === '请输入目标ROI');
  const budgetIdx = idxOf(obs, e => e.tag === 'INPUT' && e.placeholder === '请输入日预算');
  const searchIdx = idxOf(obs, e => e.tag === 'INPUT' && e.placeholder === '搜索商品名称');

  const r1 = p.runWith(c.actionApply, { op: 'fill', index: roiIdx, value: '15', observation: o });
  assert.equal(r1.filled, true); assert.equal(r1.value, '15'); assert.equal(r1.field, 'roi');
  const r2 = p.runWith(c.actionApply, { op: 'fill', index: budgetIdx, value: '300', observation: o });
  assert.equal(r2.filled, true); assert.equal(r2.value, '300'); assert.equal(r2.field, 'budget');
  assert.throws(() => p.runWith(c.actionApply, { op: 'fill', index: searchIdx, value: '15', observation: o }), /ROI\/budget field not recognized/);
  assert.throws(() => p.runWith(c.actionApply, { op: 'fill', index: roiIdx, value: '99', observation: o }), /Only authorized ROI15\/budget300/);
});

test('actionApply ROI takes only 15 and budget only 300; reverse mismatch and cost/bid refused', () => {
  const p = makePage([
    formItem('目标ROI(投产比)', '请输入目标ROI'),
    formItem('日预算(元)', '请输入日预算'),
    formItem('转化成本(元)', '请输入成本'),
    formItem('单次出价(元)', '请输入出价'),
  ]);
  const obs = p.run(c.pageObserve);
  const o = obs.observation;
  const roiIdx = idxOf(obs, e => e.tag === 'INPUT' && e.placeholder === '请输入目标ROI');
  const budgetIdx = idxOf(obs, e => e.tag === 'INPUT' && e.placeholder === '请输入日预算');
  const costIdx = idxOf(obs, e => e.tag === 'INPUT' && e.placeholder === '请输入成本');
  const bidIdx = idxOf(obs, e => e.tag === 'INPUT' && e.placeholder === '请输入出价');
  assert.ok(roiIdx >= 0 && budgetIdx >= 0 && costIdx >= 0 && bidIdx >= 0);

  // reverse value mismatch: ROI field must not take 300, budget must not take 15
  assert.throws(() => p.runWith(c.actionApply, { op: 'fill', index: roiIdx, value: '300', observation: o }), /ROI field only accepts value 15/);
  assert.throws(() => p.runWith(c.actionApply, { op: 'fill', index: budgetIdx, value: '15', observation: o }), /Budget field only accepts value 300/);
  // correct side still works
  assert.equal(p.runWith(c.actionApply, { op: 'fill', index: roiIdx, value: '15', observation: o }).filled, true);
  assert.equal(p.runWith(c.actionApply, { op: 'fill', index: budgetIdx, value: '300', observation: o }).filled, true);
  // cost / bid are NOT independent authorization fields
  assert.throws(() => p.runWith(c.actionApply, { op: 'fill', index: costIdx, value: '15', observation: o }), /ROI\/budget field not recognized \(excluded-context\)/);
  assert.throws(() => p.runWith(c.actionApply, { op: 'fill', index: bidIdx, value: '300', observation: o }), /ROI\/budget field not recognized \(excluded-context\)/);
});

test('actionApply refuses a mixed ROI+budget container instead of trusting its full text', () => {
  // one big form-item whose text happens to contain BOTH ROI and 预算 keywords;
  // the real callback must refuse rather than treat container-wide text as proof
  const p = makePage([
    El('div', { class: 'ovui-form-item', rect: [400, 120] }, [
      El('label', { rect: [200, 20], text: '目标ROI(投产比) 与 日预算(元)' }),
      El('input', { rect: [140, 30], placeholder: '请输入数值' }),
    ]),
  ]);
  const obs = p.run(c.pageObserve);
  const o = obs.observation;
  const inputIdx = idxOf(obs, e => e.tag === 'INPUT' && e.placeholder === '请输入数值');
  assert.ok(inputIdx >= 0);
  assert.throws(() => p.runWith(c.actionApply, { op: 'fill', index: inputIdx, value: '15', observation: o }), /ROI\/budget field not recognized \(mixed-roi-budget\)/);
});

// ---------- C: nearby-field recognition against the REAL page evidence ----------
// Both inputs share placeholder "请输入", class ovui-input, and their nearest
// form-item selector matches nothing (fieldText null); the only usable signal is
// the accurate container label "综合营销ROI目标(含达人佣金)" / "日预算".
function realField(labelText) {
  return El('div', { class: 'ovui-field-row', rect: [320, 60] }, [
    El('label', { rect: [180, 24], text: labelText }),
    El('input', { rect: [120, 30], class: 'ovui-input', placeholder: '请输入' }),
  ]);
}

test('fill recognizes the real 请输入 inputs by their nearby ROI/日预算 label, not placeholder', () => {
  const p = makePage([realField('综合营销ROI目标(含达人佣金)'), realField('日预算')]);
  const obs = p.run(c.pageObserve);
  const o = obs.observation;
  const roiRow = obs.elements.filter(e => e.tag === 'INPUT');
  assert.equal(roiRow.length, 2);
  const roiIdx = roiRow[0].index, budgetIdx = roiRow[1].index;
  assert.equal(obs.elements.find(e => e.index === roiIdx).fieldText, null);
  assert.equal(obs.elements.find(e => e.index === roiIdx).placeholder, '请输入');
  const rr = p.runWith(c.actionApply, { op: 'fill', index: roiIdx, value: '15', observation: o });
  assert.equal(rr.filled, true); assert.equal(rr.field, 'roi');
  assert.equal(rr.fieldSource.source, 'nearby-field');
  const rb = p.runWith(c.actionApply, { op: 'fill', index: budgetIdx, value: '300', observation: o });
  assert.equal(rb.filled, true); assert.equal(rb.field, 'budget');
  // exact pairing preserved: ROI takes only 15, budget only 300
  assert.throws(() => p.runWith(c.actionApply, { op: 'fill', index: roiIdx, value: '300', observation: o }), /ROI field only accepts value 15/);
  assert.throws(() => p.runWith(c.actionApply, { op: 'fill', index: budgetIdx, value: '15', observation: o }), /Budget field only accepts value 300/);
});

test('pageObserve reports the fieldText/label source used for nearby ROI/budget inputs', () => {
  const p = makePage([realField('综合营销ROI目标(含达人佣金)'), realField('日预算')]);
  const obs = p.run(c.pageObserve);
  const inputs = obs.elements.filter(e => e.tag === 'INPUT');
  assert.equal(inputs[0].fillField.recognized, true);
  assert.equal(inputs[0].fillField.kind, 'roi');
  assert.equal(inputs[0].fillField.source, 'nearby-field');
  assert.match(inputs[0].fillField.labelSample, /ROI/);
  assert.equal(inputs[1].fillField.kind, 'budget');
  assert.match(inputs[1].fillField.labelSample, /预算/);
});

test('fill refuses a mixed or unlabeled real container and keeps rejecting by evidence', () => {
  // container label has both ROI and 预算 -> mixed; no nearby unique label -> refused
  const mixed = makePage([El('div', { class: 'ovui-field-row', rect: [320, 80] }, [
    El('label', { rect: [200, 20], text: '综合营销ROI目标(含达人佣金) 日预算' }),
    El('input', { rect: [120, 30], class: 'ovui-input', placeholder: '请输入' }),
  ])]);
  const mo = mixed.run(c.pageObserve);
  const mIdx = mo.elements.find(e => e.tag === 'INPUT').index;
  assert.throws(() => mixed.runWith(c.actionApply, { op: 'fill', index: mIdx, value: '15', observation: mo.observation }), /not recognized \(mixed-roi-budget\)/);
  // a lone input with no nearby ROI/budget label at all -> no-unique-labeled-field
  const unlabeled = makePage([El('div', { class: 'ovui-field-row', rect: [320, 60] }, [
    El('label', { rect: [120, 20], text: '备注' }),
    El('input', { rect: [120, 30], class: 'ovui-input', placeholder: '请输入' }),
  ])]);
  const uo = unlabeled.run(c.pageObserve);
  const uIdx = uo.elements.find(e => e.tag === 'INPUT').index;
  assert.throws(() => unlabeled.runWith(c.actionApply, { op: 'fill', index: uIdx, value: '15', observation: uo.observation }), /not recognized \(no-unique-labeled-field\)/);
});

// A real browser returns a live NodeList from querySelectorAll: iterable, with
// length and numeric indices, but NO .filter method. The offline harness returns
// plain Arrays, which previously masked a TypeError inside classifyFillField.
// These tests wrap only the fixture rows' querySelectorAll to return that real
// NodeList shape and run the full positive fill chain through BOTH callbacks
// (pageObserve and actionApply) that carry an inline classifyFillField.
function asNodeList(arr) {
  const list = { length: arr.length };
  arr.forEach((el, i) => { list[i] = el; });
  list[Symbol.iterator] = function* () { yield* arr; };
  return list; // deliberately no .filter — like a real browser NodeList
}

test('classifyFillField works against a real NodeList shape (no .filter) in pageObserve and actionApply', () => {
  const p = makePage([realField('综合营销ROI目标(含达人佣金)'), realField('日预算')]);
  const sample = asNodeList([p.body]);
  assert.equal(typeof sample.filter, 'undefined', 'fixture NodeList shape must lack .filter like a real browser');
  assert.equal(sample.length, 1);
  assert.equal(sample[0], p.body);
  assert.deepEqual([...sample], [p.body]);
  // wrap every fixture element's querySelectorAll so ancestor walks see NodeList
  const all = []; const walk = n => { for (const ch of n.__kids) { all.push(ch); walk(ch); } }; walk(p.body);
  for (const el of all) {
    const orig = el.querySelectorAll.bind(el);
    el.querySelectorAll = (sel) => sel === 'input,textarea' ? asNodeList(orig(sel)) : orig(sel);
  }
  const obs = p.run(c.pageObserve); // covers the pageObserve copy
  const inputs = obs.elements.filter(e => e.tag === 'INPUT');
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].fillField.recognized, true);
  assert.equal(inputs[0].fillField.kind, 'roi');
  assert.equal(inputs[1].fillField.kind, 'budget');
  const o = obs.observation;
  const rr = p.runWith(c.actionApply, { op: 'fill', index: inputs[0].index, value: '15', observation: o }); // covers the actionApply copy
  assert.equal(rr.filled, true); assert.equal(rr.field, 'roi'); assert.equal(rr.value, '15');
  const rb = p.runWith(c.actionApply, { op: 'fill', index: inputs[1].index, value: '300', observation: o });
  assert.equal(rb.filled, true); assert.equal(rb.field, 'budget'); assert.equal(rb.value, '300');
});

test('actionApply keeps publication/existing-ad blocks and refuses plain clicks on pagination controls', () => {
  const p = makePage(happyBody());
  const obs = p.run(c.pageObserve);
  const o = obs.observation;
  const publishIdx = idxOf(obs, e => e.text === '立即发布');
  assert.throws(() => p.runWith(c.actionApply, { op: 'click', index: publishIdx, observation: o }), /Publication\/access agreement blocked/);
  const numBtn = obs.pagination.items.find(i => i.kind === 'number' && i.page === 3);
  assert.ok(numBtn);
  assert.throws(() => p.runWith(c.actionApply, { op: 'click', index: numBtn.index, observation: o }), /must use op=page/);
});

test('actionApply still requires the observed draft product row identity for removal', () => {
  const p = makePage([
    modalFixture({ numbers: [1], active: 1, total: 1 }),
    El('tr', { rect: [500, 40] }, [El('td', { rect: [300, 30], text: '商品ID123 名称A' }), El('button', { rect: [60, 30], text: '移除' })]),
  ]);
  const obs = p.run(c.pageObserve);
  const o = obs.observation;
  const removeIdx = idxOf(obs, e => e.text === '移除');
  assert.ok(removeIdx >= 0);
  assert.throws(() => p.runWith(c.actionApply, { op: 'click', index: removeIdx, observation: o }), /Draft-only product removal requires observed row identity/);
  const ok = p.runWith(c.actionApply, { op: 'click', index: removeIdx, observation: o, draftProductId: 'ID123' });
  assert.equal(ok.clicked, true);
});

// ---------- static safety helpers ----------
test('publication and existing-ad semantics stay blocked, including icon-only buttons', () => {
  assert.match(c.isBlockedText(c.guardText('', '发布', '')), /Publication/);
  assert.match(c.isBlockedText(c.guardText('一键发布', '', '')), /Publication/);
  assert.match(c.isBlockedText(c.guardText('', '', '扣款授权协议')), /Publication/);
  assert.match(c.isBlockedText(c.guardText('', '暂停投放', '')), /Existing ad changes/);
  assert.equal(c.isBlockedText(c.guardText('2', '', '')), null);
  assert.equal(c.isBlockedText(c.guardText('下一页', '', '')), null);
});

test('remove/remove-all still requires the observed product row identity', () => {
  assert.equal(c.removalRequiresProductId('移除', 'id=123 名称', '123', true), false);
  assert.equal(c.removalRequiresProductId('移除', '', undefined, true), true);
  assert.equal(c.removalRequiresProductId('移除', 'id=456', '123', true), true);
  assert.equal(c.removalRequiresProductId('删除', 'id=123', '123', false), true);
});

test('fill whitelist keeps ROI15/budget300 only; page numbers must use op=page', () => {
  assert.deepEqual(c.FILL_VALUES, ['15', '300']);
  assert.ok(!c.ACTION_OPS.includes('page'));
});

// ---------- R7: real untitled product drawer recognition ----------
function realDrawerFixture(o = {}) {
  const tabs = El('div', { class: 'product-drawer-header', rect: [640, 44] },
    ['全部', '店铺新品', '破圈尖货流量扶持', '搜索趋势'].map(t =>
      El('div', { class: 'product-drawer-header-tab-item ovui-tabs__tab', rect: [90, 30], text: t })));
  const list = El('div', { class: 'product-drawer-list', rect: [640, 320] },
    [El('div', { rect: [560, 30], text: '示例商品A ID:7123456789012345678' })]);
  const denom = o.denominator == null ? 30 : o.denominator;
  const footer = El('div', { class: 'product-drawer-footer', rect: [640, 50] }, [
    El('span', { rect: [90, 24], text: '已选 ' + (o.selected == null ? 3 : o.selected) + '/' + denom }),
    El('button', { rect: [90, 30], text: '下一步' }),
  ]);
  const inner = [tabs, list, footer];
  if (o.pager) inner.push(pagerFixture(o.pager));
  return El('div', { class: 'product-drawer', rect: [800, 600], attrs: { 'aria-modal': 'true' } }, inner);
}

const unknownTotalPager = { numbers: [1, 2, 3, 4, 5], active: 1, ellipsis: true, max: 60 };

test('real untitled product drawer (tab header + 已选n/30 footer) is recognized without any 添加商品 title', () => {
  const p = makePage([realDrawerFixture({ pager: unknownTotalPager })]);
  const obs = p.run(c.pageObserve);
  assert.equal(obs.pagination.modalUnique, true);
  assert.equal(obs.pagination.inProductModal, true);
  assert.equal(obs.pagination.pageCount, null, '1..5 ... 60 with no 共60页 label must stay unknown');
  assert.equal(obs.pagination.currentPage, 1);
});

test('nested drawer candidates collapse to the minimal root; two disjoint drawers stay ambiguous', () => {
  const drawer = realDrawerFixture({ pager: { numbers: [1, 2], active: 1, ellipsis: true, max: 60 } });
  const wrapper = El('div', { class: 'product-drawer-layer', rect: [900, 700] }, [drawer]);
  const nested = makePage([wrapper]).run(c.pageObserve);
  assert.equal(nested.pagination.modalUnique, true, 'outer wrapper + inner drawer must collapse to ONE minimal root');
  const disjoint = makePage([
    realDrawerFixture({ pager: { numbers: [1], active: 1, ellipsis: true, max: 60 } }),
    realDrawerFixture({ pager: { numbers: [1], active: 1, ellipsis: true, max: 60 } }),
  ]).run(c.pageObserve);
  assert.equal(disjoint.pagination.modalUnique, false, 'two disjoint drawer matches must be refused');
});

test('titled drawer: a real product-list ID (ID: + 15-20 digits) counts as a product signal; plain list text does not', () => {
  const mk = listText => El('div', { class: 'ovui-dialog', rect: [800, 600], attrs: { 'aria-modal': 'true', 'aria-label': '添加商品' } },
    [El('div', { rect: [560, 30], text: listText })]);
  const withId = makePage([mk('示例商品A ID:7123456789012345678')]).run(c.pageObserve);
  assert.equal(withId.pagination.modalPresent, true, 'real product id belongs to the drawer root');
  const noId = makePage([mk('示例商品A')]).run(c.pageObserve);
  assert.equal(noId.pagination.modalPresent, false, 'no tab signals and no real product id => no drawer root');
});

test('unknown total: observed enabled page2/next allowed; unobserved/jump/disabled/stale refused', () => {
  const p = makePage([realDrawerFixture({ pager: unknownTotalPager })]);
  const obs = p.run(c.pageObserve);
  const o = obs.observation;
  assert.equal(obs.pagination.pageCount, null);
  const plan2 = c.resolvePageTarget(obs, { observation: o, page: 2 });
  assert.equal(plan2.mode, 'click');
  assert.equal(plan2.expectPage, 2);
  const r2 = p.runWith(c.pageApply, { ...plan2, observation: o });
  assert.equal(r2.paged, true);
  const planNext = c.resolvePageTarget(obs, { observation: o, kind: 'next' });
  assert.equal(planNext.expectKind, 'next');
  assert.throws(() => c.resolvePageTarget(obs, { observation: o, page: 99 }), /unknown/, 'unobserved page 99 must be refused while total is unknown');
  assert.throws(() => c.resolvePageTarget(obs, { observation: o, page: 1 }), /Already on target page/);
  const pDis = makePage([realDrawerFixture({ pager: { ...unknownTotalPager, disabledNumbers: [3] } })]);
  const obsDis = pDis.run(c.pageObserve);
  assert.throws(() => c.resolvePageTarget(obsDis, { observation: obsDis.observation, page: 3 }), /only observed page controls may be used/);
  assert.throws(() => c.resolvePageTarget(obs, { observation: 'stale', page: 2 }), /Observation expired/);
});

test('unknown total pageApply refuses when the live current page moved since observation', () => {
  const p = makePage([realDrawerFixture({ pager: unknownTotalPager })]);
  const obs = p.run(c.pageObserve);
  const plan = c.resolvePageTarget(obs, { observation: obs.observation, page: 2 });
  const el = observedEl(p, plan.index);
  const root = p.context.window.__directDraftModalRoot;
  const all = []; const walk = n => { for (const ch of n.__kids) { all.push(ch); walk(ch); } }; walk(root);
  const li1 = all.find(x => x.getAttribute('aria-current') === 'page');
  li1.removeAttribute('aria-current'); li1.className = '';
  const btn2 = all.find(x => x.tagName === 'BUTTON' && x.__text === '2');
  btn2.parentElement.setAttribute('aria-current', 'page'); btn2.parentElement.className = 'active';
  assert.throws(() => p.runWith(c.pageApply, { ...plan, observation: obs.observation }), /Current or total page changed/);
  assert.equal(el.__clicked, 0, 'a moved current page must produce zero actions');
});

// ---------- req5: remaining-capacity denominator 1..30 (2nd/3rd plan / top-up) ----------
test('drawer footer denominator accepts remaining capacity 1/2/12 and still refuses 0/31', () => {
  for (const denom of [1, 2, 12, 30]) {
    const p = makePage([realDrawerFixture({ selected: 0, denominator: denom, pager: unknownTotalPager })]);
    const obs = p.run(c.pageObserve);
    assert.equal(obs.pagination.modalPresent, true, '已选 0/' + denom + ' must be recognized as a product drawer');
    assert.equal(obs.pagination.modalUnique, true);
    assert.equal(obs.pagination.inProductModal, true);
    // a real enabled page control is still clickable regardless of remaining capacity
    const plan = c.resolvePageTarget(obs, { observation: obs.observation, page: 2 });
    assert.equal(plan.mode, 'click');
    assert.equal(p.runWith(c.pageApply, { ...plan, observation: obs.observation }).paged, true);
  }
  for (const denom of [0, 31]) {
    const p = makePage([realDrawerFixture({ selected: 0, denominator: denom, pager: unknownTotalPager })]);
    const obs = p.run(c.pageObserve);
    assert.equal(obs.pagination.modalPresent, false, '已选 0/' + denom + ' is out of the 1..30 remaining-capacity range and must not be trusted');
  }
});

// ---------- R7: deep ROI label beyond 6 levels, help-text cost/bid must not negate ----------
function deepLabeledField(labelText, withInput) {
  let node = El('div', { class: 'field-inner', rect: [420, 60] }, [withInput]);
  for (let i = 0; i < 7; i++) node = El('div', { class: 'field-wrap-' + i, rect: [520, 120] }, [node]);
  return El('div', { class: 'field-outer', rect: [560, 160] }, [
    El('span', { rect: [300, 20], text: labelText }),
    node,
  ]);
}

test('deep ROI label (8 ancestor levels) with 出价分析/综合成本 help text is recognized as roi', () => {
  const roiField = deepLabeledField('综合营销ROI目标(含达人佣金) 出价分析：帮助说明，综合成本仅供参考',
    El('input', { rect: [120, 30], class: 'ovui-input', placeholder: '请输入' }));
  const p = makePage([roiField, realField('日预算')]);
  const obs = p.run(c.pageObserve);
  const o = obs.observation;
  const inputs = obs.elements.filter(e => e.tag === 'INPUT');
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0].fillField.recognized, true);
  assert.equal(inputs[0].fillField.kind, 'roi');
  assert.ok(inputs[0].fillField.level >= 7, 'explicit ROI label must be found beyond the old 6-level bound');
  assert.ok(Array.isArray(inputs[0].fillField.ancestors) && inputs[0].fillField.ancestors.length <= 12);
  assert.ok(inputs[0].fillField.ancestors.every(a => typeof a.editableCount === 'number' && typeof a.tag === 'string'));
  const rr = p.runWith(c.actionApply, { op: 'fill', index: inputs[0].index, value: '15', observation: o });
  assert.equal(rr.filled, true); assert.equal(rr.field, 'roi'); assert.equal(rr.value, '15');
  assert.ok(rr.fieldSource.ancestors.length <= 12);
  // exact pairing preserved
  assert.throws(() => p.runWith(c.actionApply, { op: 'fill', index: inputs[0].index, value: '300', observation: o }), /ROI field only accepts value 15/);
});

test('deep true cost field (help-text-free label) stays refused even beyond 6 levels', () => {
  const costField = deepLabeledField('转化成本(元)', El('input', { rect: [120, 30], class: 'ovui-input', placeholder: '请输入' }));
  const p = makePage([costField]);
  const obs = p.run(c.pageObserve);
  const input = obs.elements.find(e => e.tag === 'INPUT');
  assert.equal(input.fillField.recognized, false);
  assert.throws(() => p.runWith(c.actionApply, { op: 'fill', index: input.index, value: '15', observation: obs.observation }), /ROI\/budget field not recognized/);
});

// ---------- R7: local command-file channel (pure helpers) ----------
test('command-file verdicts: stale runId and duplicate seq are zero-action rejects', () => {
  const valid = JSON.stringify({ runId: 'A', seq: 2, command: { op: 'click', index: 3 } });
  assert.equal(c.classifyCommandEntry(null, 'A', 0).action, 'wait');
  assert.equal(c.classifyCommandEntry('', 'A', 0).action, 'wait');
  assert.equal(c.classifyCommandEntry('{broken', 'A', 0).action, 'wait');
  const stale = c.classifyCommandEntry(JSON.stringify({ runId: 'OLD', seq: 1, command: { op: 'inspect' } }), 'A', 0);
  assert.equal(stale.action, 'reject');
  assert.match(stale.reason, /runId/);
  const dup = c.classifyCommandEntry(valid, 'A', 2);
  assert.equal(dup.action, 'reject');
  assert.match(dup.reason, /already-processed/);
  const badSeq = c.classifyCommandEntry(JSON.stringify({ runId: 'A', seq: 0, command: { op: 'inspect' } }), 'A', 0);
  assert.equal(badSeq.action, 'reject');
  const run = c.classifyCommandEntry(valid, 'A', 1);
  assert.equal(run.action, 'run');
  assert.equal(run.seq, 2);
  assert.equal(run.cmd.op, 'click');
  // record transitions: run advances lastSeq (persist-before-dispatch), reject keeps it
  const advanced = c.recordCommandState({ runId: 'A', lastSeq: 1, lastCommand: null }, { seq: 2, status: 'received', result: null, error: null }, true);
  assert.equal(advanced.lastSeq, 2);
  const kept = c.recordCommandState({ runId: 'A', lastSeq: 1, lastCommand: null }, { seq: 9, status: 'rejected', result: null, error: 'stale-or-foreign-runId' }, false);
  assert.equal(kept.lastSeq, 1);
  assert.match(kept.lastCommand.error, /runId/);
});

test('command-file ops are limited to the existing executors only', () => {
  for (const op of ['inspect', 'show', 'page', 'click', 'fill', 'scroll', 'popup-dismiss', 'save-cookies']) assert.ok(c.ALL_COMMAND_OPS.includes(op), op + ' must be allowed');
  for (const op of ['evaluate', 'shell', 'exec', 'close', 'login', 'relogin', 'navigate']) assert.ok(!c.ALL_COMMAND_OPS.includes(op), op + ' must never be allowed');
  // the two newly authorized ops are routed SEPARATELY, never as relaxed clicks
  assert.ok(!c.ACTION_OPS.includes('popup-dismiss'), 'popup-dismiss must be a distinct op, not a generic click');
  assert.ok(!c.ACTION_OPS.includes('save-cookies'), 'save-cookies must be a distinct runtime op, not a page action');
  const reject = c.classifyCommandEntry(JSON.stringify({ runId: 'A', seq: 1, command: { op: 'evaluate', code: '1+1' } }), 'A', 0);
  assert.equal(reject.action, 'reject');
  assert.match(reject.reason, /unsupported/);
});

// ---------- R8: shared serial command queue ----------
test('shared serial queue: zero execution before the first finishes; a rejected first does not block the next', async () => {
  assert.equal(typeof c.makeSerialRunner, 'function');
  let releaseFirst;
  const gate = new Promise(res => { releaseFirst = res; });
  const order = [];
  const runner = c.makeSerialRunner(async id => {
    order.push(id);
    if (id === 'first') { await gate; throw new Error('first-failed'); }
    return id;
  });
  const p1 = runner('first');
  const p2 = runner('second');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(order, ['first'], 'second command must not start before the first completes');
  releaseFirst();
  await assert.rejects(p1, /first-failed/);
  assert.equal(await p2, 'second');
  assert.deepEqual(order, ['first', 'second'], 'a rejected first command must not block the next');
});

// ---------- R5: one-shot publish-plan capability ----------
// A compact creation-page fixture mirroring the real DOM evidence: header with
// the account id, 30 product rows each carrying one ID： and a manual douyin
// count, commission checkbox (checked), ROI 15 / budget 300 recognized fields,
// plan-name input, unchecked optional direct-pay checkbox, one 发布计划 button.
const APPROVED_IDS = Array.from({ length: 30 }, (_, i) => '7123456789012345' + String(1000 + i));
const APPROVED_FIRST_PLAN = { account_id: '1710242295996424', product_ids: APPROVED_IDS.slice() };
const PLAN_NAME = '2026-10-08_千川乘方_17:34:05';

function creationFixture(o = {}) {
  const count = o.count == null ? 30 : o.count;
  const mainCount = o.splitTables ? 20 : count;
  const kids = [];
  // account id lives ONLY in the navigator header container (project identity
  // reader selector); with noNavigator the same id sits in a plain body div
  // and must NOT be accepted as the account
  if (!o.noNavigator) kids.push(El('div', { class: 'qc-page-navigator-container', rect: [900, 40], text: '千川 乘方 ID：1710242295996424 伊人美' }));
  else kids.push(El('div', { rect: [400, 30], text: '伊人美 ID：1710242295996424' }));
  const rowOf = i => El('tr', { rect: [600, 40] }, [
    El('td', { rect: [500, 30], text: '商品' + i + ' 店铺新品 ID：' + APPROVED_IDS[i] }),
    El('td', { rect: [140, 30], text: o.autoPull
      ? '管理手动添加抖音号 预估自动拉取 3 个'
      : (o.manual == null ? 2 : o.manual) + '个抖音号 管理手动添加抖音号 预估自动拉取 0 个' }),
  ]);
  // the unique creation main table, identified by its real header row
  kids.push(El('table', { class: 'ovui-table', rect: [900, 640] }, [
    El('tr', { rect: [900, 30] }, [
      El('th', { rect: [220, 20], text: '商品信息' }),
      El('th', { rect: [160, 20], text: '投放抖音号' }),
      El('th', { rect: [160, 20], text: '素材（默认启用智能优选，推荐同步添加自选素材）' }),
      El('th', { rect: [80, 20], text: '操作' }),
    ]),
    ...Array.from({ length: mainCount }, (_, i) => rowOf(i)),
  ]));
  // an unrelated second table whose rows carry ids but no creation header:
  // with splitTables the main table holds only 20 of the 30 rows
  if (o.splitTables) kids.push(El('table', { class: 'ovui-table', rect: [900, 300] },
    Array.from({ length: count - mainCount }, (_, i) => El('tr', { rect: [600, 40] }, [
      El('td', { rect: [500, 30], text: '凑数 ID：' + APPROVED_IDS[mainCount + i] })]))));
  kids.push(El('div', { class: 'oc-switch-card-item', rect: [400, 60], text: '含达人佣金出价 说明' }, [
    El('input', { type: 'checkbox', cls: 'ovui-checkbox__input', checked: o.commissionChecked === undefined ? true : o.commissionChecked, rect: [20, 20] })]));
  kids.push(El('div', { class: 'ovui-field-row', rect: [320, 60] }, [
    El('label', { rect: [180, 24], text: '综合营销ROI目标(含达人佣金)' }),
    El('input', { rect: [120, 30], cls: 'ovui-input', placeholder: '请输入', value: o.roi == null ? '15' : o.roi })]));
  kids.push(El('div', { class: 'ovui-field-row', rect: [320, 60] }, [
    El('label', { rect: [180, 24], text: '日预算' }),
    El('input', { rect: [120, 30], cls: 'ovui-input', placeholder: '请输入', value: o.budget == null ? '300' : o.budget })]));
  kids.push(El('div', { class: 'oc-input-group-wrap', rect: [320, 60], text: '计划名称 14/50' }, [
    El('input', { rect: [140, 30], cls: 'ovui-input', placeholder: '请输入计划名称，1-50个字符', value: o.planName || PLAN_NAME })]));
  if (!o.noDirectPay) kids.push(El('div', { class: 'good-direct-pay-guide', rect: [400, 80], text: '为店铺开启 货款直投升级版 勾选视为同意协议' }, [
    El('input', { type: 'checkbox', cls: 'ovui-checkbox__input', checked: o.directPayChecked === undefined ? false : o.directPayChecked, rect: [20, 20] })]));
  if (o.publishButton !== false) kids.push(El('button', { rect: [100, 36], text: '发布计划', disabled: o.publishDisabled === true }));
  if (o.extraPublish) kids.push(El('button', { rect: [100, 36], text: '发布计划' }));
  if (o.dialog) kids.push(El('div', { class: 'ovui-modal', rect: [300, 200], attrs: { 'aria-modal': 'true' } }));
  return kids;
}
function makeCreationPage(o, pathname) {
  return makePage(creationFixture(o), pathname || '/uni-creation/overall-product-multi', 'https://qianchuan.jinritemai.com');
}
function publishBtnOf(p) { return p.body.querySelectorAll('button').filter(b => b.__text === '发布计划')[0]; }
function baseAuth(obs, o = {}) {
  return Object.assign({
    runId: 'run-x', observation: obs.observation, accountId: '1710242295996424',
    productIds: APPROVED_IDS.slice(), roi: 15, dailyBudget: 300, commissionIncluded: true,
    boundAccounts: ['79863866', '9zmao_fushi'], businessDate: '2026-10-09', manifestHash: 'a'.repeat(64),
    planName: PLAN_NAME, confirmationId: 'conf-1',
  }, o.auth || {}, o.planName ? { planName: o.planName } : {}, o.productIds ? { productIds: o.productIds } : {});
}
function pubCmd(obs, o = {}) {
  return { op: 'publish-plan', planNumber: o.planNumber != null ? o.planNumber : 1, authorization: baseAuth(obs, o) };
}
function runPublish(p, obs, o = {}) {
  const a = baseAuth(obs, o);
  return p.runWith(c.publishApply, { observation: a.observation, planNumber: o.planNumber != null ? o.planNumber : 1, accountId: a.accountId, productIds: a.productIds, planName: a.planName });
}

test('requiring the module creates no attempts file; publish-plan is a separate gated op', () => {
  assert.ok(!fs.existsSync(path.join(__dirname, 'plan-publication-attempts.json')), 'module load must not create the workspace attempts ledger');
  assert.deepEqual(c.PUBLISH_OPS, ['publish-plan']);
  assert.ok(!c.ACTION_OPS.includes('publish-plan'));
  assert.ok(!c.FILL_VALUES.includes('publish-plan'));
  assert.ok(c.ALL_COMMAND_OPS.includes('publish-plan'));
  for (const op of ['evaluate', 'shell', 'exec', 'close', 'login', 'relogin', 'navigate']) assert.ok(!c.ALL_COMMAND_OPS.includes(op));
  const verdict = c.classifyCommandEntry(JSON.stringify({ runId: 'A', seq: 1, command: { op: 'publish-plan', planNumber: 1, authorization: {} } }), 'A', 0);
  assert.equal(verdict.action, 'run');
});

test('pageObserve creation summary reads every publish precondition from the live DOM', () => {
  const p = makeCreationPage({});
  const obs = p.run(c.pageObserve);
  const cr = obs.creation;
  assert.equal(cr.originOk, true);
  assert.equal(cr.pathOk, true);
  assert.equal(cr.accountId, '1710242295996424', 'account id comes from the navigator header, not from product rows or body text');
  assert.equal(cr.mainTableUnique, true, 'the creation main table must be uniquely identified by its real header');
  assert.equal(cr.productRowCount, 30);
  assert.equal(cr.uniqueProductCount, 30);
  assert.equal(cr.eachRowHasManualAccount, true);
  assert.deepEqual(Array.from(cr.rows.slice(0, 2).map(r => r.manualAccounts)), [2, 2]);
  assert.equal(cr.roi, '15');
  assert.equal(cr.budget, '300');
  assert.equal(cr.commissionChecked, true);
  assert.equal(cr.planName, PLAN_NAME);
  assert.equal(cr.publishButtonCount, 1);
  assert.equal(cr.publishEnabledUnique, true);
  assert.equal(cr.optionalDirectPayChecked, false);
  assert.equal(cr.visibleDialogCount, 0);
});

test('pageObserve creation summary reports unknown on a foreign origin/path or ambiguous identity', () => {
  const foreign = makePage(creationFixture({})).run(c.pageObserve).creation;
  assert.equal(foreign.originOk, false);
  const wrongPath = makeCreationPage({}, '/uni-creation/some-other-page').run(c.pageObserve).creation;
  assert.equal(wrongPath.pathOk, false);
  const noHeader = makePage(creationFixture({ count: 0 }).slice(1)).run(c.pageObserve).creation;
  assert.equal(noHeader.accountId, 'unknown');
  assert.equal(noHeader.mainTableUnique, true);
  const noButton = makeCreationPage({ publishButton: false }).run(c.pageObserve).creation;
  assert.equal(noButton.publishButtonCount, 0);
  assert.equal(noButton.publishEnabledUnique, false);
  const noDirectPay = makeCreationPage({ noDirectPay: true }).run(c.pageObserve).creation;
  assert.equal(noDirectPay.optionalDirectPayChecked, 'unknown');
});

test('validatePublishAuthorization accepts a fully consistent authorization', () => {
  const p = makeCreationPage({});
  const obs = p.run(c.pageObserve);
  const ok = c.validatePublishAuthorization(pubCmd(obs), obs, '1710242295996424', 'run-x', APPROVED_FIRST_PLAN);
  assert.equal(ok.planNumber, 1);
  assert.equal(ok.roi, 15);
  assert.equal(ok.confirmationId, 'conf-1');
});

test('publish gate refuses every mismatch (table-driven, all zero-click conditions)', () => {
  const cases = [];
  const add = (name, fn) => cases.push({ name, fn });
  // every case starts from the shared valid baseline fixture (proven fully
  // valid in the positive test above) and must throw for its own stated
  // reason (regex), not incidentally because another field broke
  const gate = (pageOpts, cmdOpts, configured, re) => {
    const p = makeCreationPage(pageOpts);
    const obs = p.run(c.pageObserve);
    assert.throws(() => c.validatePublishAuthorization(pubCmd(obs, cmdOpts), obs, configured || '1710242295996424', 'run-x', APPROVED_FIRST_PLAN), re || Error);
  };
  add('wrong origin', () => {
    const p = makePage(creationFixture({}), '/uni-creation/overall-product-multi');
    const obs = p.run(c.pageObserve);
    assert.throws(() => c.validatePublishAuthorization(pubCmd(obs), obs, '1710242295996424', 'run-x', APPROVED_FIRST_PLAN), /origin/);
  });
  add('wrong path', () => {
    const p = makeCreationPage({}, '/uni-creation/other');
    const obs = p.run(c.pageObserve);
    assert.throws(() => c.validatePublishAuthorization(pubCmd(obs), obs, '1710242295996424', 'run-x', APPROVED_FIRST_PLAN), /path/);
  });
  add('configured account mismatch', () => gate({}, {}, '9999999999999999', /identity/));
  add('account id outside the navigator header', () => gate({ noNavigator: true }, {}, null, /identity/));
  add('rows split across another table', () => gate({ splitTables: true }, {}, null, /product table mismatch/));
  add('rows with only auto-pulled douyin counts', () => gate({ autoPull: true }, {}, null, /product table mismatch/));
  add('unknown commission checkbox state', () => gate({ commissionChecked: null }, {}, null, /commission/));
  add('stale observation', () => {
    const p = makeCreationPage({});
    const obs = p.run(c.pageObserve);
    assert.throws(() => c.validatePublishAuthorization(pubCmd(obs, { auth: { observation: 'stale' } }), obs, '1710242295996424', 'run-x', APPROVED_FIRST_PLAN), /latest DOM observation/);
  });
  add('authorization runId mismatch', () => gate({}, { auth: { runId: 'other-run' } }));
  add('authorization numbers wrong', () => gate({}, { auth: { roi: 16 } }));
  add('29 ids', () => gate({}, { productIds: APPROVED_IDS.slice(0, 29) }));
  add('duplicate ids', () => gate({}, { productIds: APPROVED_IDS.slice(0, 29).concat([APPROVED_IDS[0]]) }));
  add('id set differs from DOM', () => {
    const swapped = APPROVED_IDS.slice(); swapped[0] = '71234567890123459999';
    gate({}, { productIds: swapped });
  });
  add('29 DOM rows', () => gate({ count: 29 }, {}));
  add('a row with zero manual accounts', () => gate({ manual: 0 }, {}));
  add('DOM roi wrong', () => gate({ roi: '16' }, {}));
  add('DOM budget wrong', () => gate({ budget: '301' }, {}));
  add('commission unchecked', () => gate({ commissionChecked: false }, {}));
  add('direct-pay checked', () => gate({ directPayChecked: true }, {}));
  add('direct-pay missing/unknown', () => gate({ noDirectPay: true }, {}));
  add('plan name mismatch', () => gate({}, { planName: 'some other name' }));
  add('publish button disabled', () => gate({ publishDisabled: true }, {}));
  add('two publish buttons', () => gate({ extraPublish: true }, {}));
  add('no publish button', () => gate({ publishButton: false }, {}));
  add('visible dialog present', () => gate({ dialog: true }, {}));
  add('planNumber invalid', () => gate({}, { planNumber: 4 }));
  add('plan 2 reusing the approved first-plan id set', () => gate({}, { planNumber: 2 }));
  add('plan 1 ids differ from approved file', () => {
    const swapped = APPROVED_IDS.slice(); swapped[0] = '71234567890123458888';
    gate({}, { productIds: swapped });
  });
  for (const { name, fn } of cases) { try { fn(); } catch (e) { e.message = name + ': ' + e.message; throw e; } }
});

test('publishApply clicks the single exact publish BUTTON exactly once after full DOM re-verification', () => {
  const p = makeCreationPage({});
  const obs = p.run(c.pageObserve);
  const btn = publishBtnOf(p);
  const r = runPublish(p, obs);
  assert.equal(r.clicked, true);
  assert.equal(r.published, 'unverified');
  assert.equal(btn.__clicked, 1, 'exactly one click on the exact BUTTON');
});

test('publishApply zero-click on every drift between observation payload and live DOM (table-driven)', () => {
  const badPages = [
    ['DOM roi 16', { roi: '16' }], ['DOM budget 301', { budget: '301' }],
    ['commission unchecked', { commissionChecked: false }],
    ['commission unknown', { commissionChecked: null }],
    ['direct-pay checked', { directPayChecked: true }],
    ['direct-pay unknown', { directPayChecked: null }],
    ['publish disabled', { publishDisabled: true }],
    ['two publish buttons', { extraPublish: true }],
    ['no publish button', { publishButton: false }],
    ['visible dialog', { dialog: true }],
    ['29 rows', { count: 29 }], ['zero-manual row', { manual: 0 }],
    ['auto-pull only rows', { autoPull: true }],
    ['rows split across another table', { splitTables: true }],
    ['no navigator header', { noNavigator: true }],
  ];
  for (const [name, pageOpts] of badPages) {
    const p = makeCreationPage(pageOpts);
    const obs = p.run(c.pageObserve);
    const btn = publishBtnOf(p);
    // VM-realm errors are not instanceof the host Error constructor; assert on
    // the throw itself plus the zero-click side effect, not the prototype
    assert.throws(() => runPublish(p, obs), () => true, name);
    if (btn) assert.equal(btn.__clicked, 0, name + ' must produce zero clicks');
  }
  // payload/DOM drift with a healthy page: wrong account, wrong id set, wrong name
  const p = makeCreationPage({});
  const obs = p.run(c.pageObserve);
  const btn = publishBtnOf(p);
  assert.throws(() => runPublish(p, obs, { auth: { accountId: '9999999999999999' } }), /Account/);
  const swapped = APPROVED_IDS.slice(); swapped[0] = '71234567890123457777';
  assert.throws(() => runPublish(p, obs, { productIds: swapped }), /id set/);
  assert.throws(() => runPublish(p, obs, { planName: 'renamed' }), /name/);
  assert.throws(() => runPublish(p, obs, { auth: { observation: 'stale' } }), /Observation/);
  assert.equal(btn.__clicked, 0);
  // a page never observed has no observation id at all
  const fresh = makeCreationPage({});
  assert.throws(() => fresh.runWith(c.publishApply, { observation: 'whatever', accountId: '1710242295996424', productIds: APPROVED_IDS, planName: PLAN_NAME }), /Observation/);
});

test('ordinary click cannot bypass the publication block via a child span of the BUTTON', () => {
  const span = El('span', { rect: [80, 30], text: '点我', class: 'publish-tab' });
  const btn = El('button', { rect: [100, 36], ariaLabel: '发布计划' }, [span]);
  const p = makePage([btn], '/uni-creation/overall-product-multi', 'https://qianchuan.jinritemai.com');
  const obs = p.run(c.pageObserve);
  const spanIdx = obs.elements.findIndex(e => e.tag === 'SPAN');
  assert.ok(spanIdx >= 0, 'span must be observable so the guard is actually exercised');
  assert.throws(() => p.runWith(c.actionApply, { op: 'click', index: spanIdx, observation: obs.observation, expectedText: '点我' }), /Publication\/access agreement blocked/);
  assert.equal(span.__clicked, 0);
  assert.equal(btn.__clicked, 0);
});

test('one-shot attempts store: durable consumption, replay refused across restart, fail-closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-attempts-'));
  const file = path.join(dir, 'plan-publication-attempts.json');
  try {
    const scope = { businessDate: '2026-10-09', runId: 'run-test', manifestHash: 'a'.repeat(64) };
    const st = c.consumePublicationOnce(file, 1, 'conf-1', scope);
    assert.equal(st.consumed['conf-1'].status, 'pending');
    assert.ok(fs.existsSync(file), 'consumption must be persisted before dispatch');
    // same confirmation, same or other plan: refused
    assert.throws(() => c.consumePublicationOnce(file, 1, 'conf-2', scope), /pending|plan number/);
    assert.throws(() => c.consumePublicationOnce(file, 2, 'conf-1', scope), /already consumed/);
    // "restart": a fresh read from disk keeps refusing replays
    assert.throws(() => c.consumePublicationOnce(file, 3, 'conf-1', scope), /already consumed/);
    // plan 2 needs its OWN new confirmation (cannot inherit plan 1's)
    c.recordPublicationOutcome(file, 'conf-1', 'success');
    const st2 = c.consumePublicationOnce(file, 2, 'conf-2', scope);
    assert.equal(st2.consumed['conf-2'].planNumber, 2);
    // an unknown dispatch outcome can never be retried, even with a new nonce
    c.recordPublicationOutcome(file, 'conf-2', 'unknown');
    assert.throws(() => c.consumePublicationOnce(file, 2, 'conf-2b', scope), /unknown|plan number/);
    assert.equal(c.loadAttemptsStore(file).consumed['conf-2'].status, 'unknown');
    // dispatched outcome is readable and still blocking
    c.recordPublicationOutcome(file, 'conf-1', 'dispatched');
    assert.equal(c.loadAttemptsStore(file).consumed['conf-1'].status, 'dispatched');
    // corrupt store fails closed
    fs.writeFileSync(file, 'not-json{');
    assert.throws(() => c.loadAttemptsStore(file), /fail-closed/);
    assert.throws(() => c.consumePublicationOnce(file, 3, 'conf-3', scope), /fail-closed/);
    // invalid historical records (null / string planNumber / unknown status)
    // fail the whole store closed instead of being skipped
    for (const bad of [null, { planNumber: '1', status: 'pending' }, { planNumber: 2, status: 'weird' }, { planNumber: 0, status: 'pending' }, { planNumber: 1 }]) {
      fs.writeFileSync(file, JSON.stringify({ consumed: { c1: bad } }));
      assert.throws(() => c.loadAttemptsStore(file), /fail-closed/, 'invalid record ' + JSON.stringify(bad));
      assert.throws(() => c.consumePublicationOnce(file, 3, 'conf-3', scope), /fail-closed/);
    }
    // a non-ENOENT read failure (path occupied by a directory) is NOT treated
    // as "first attempt ever" and must never reset the history to empty
    const occupied = path.join(dir, 'occupied');
    fs.mkdirSync(occupied);
    assert.throws(() => c.loadAttemptsStore(occupied), /fail-closed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('final exclusion confirmation has its own durable one-shot consumption', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'final-confirm-once-'));
  const file=path.join(dir,'attempts.json');
  const scope={businessDate:'2026-10-09',runId:'run-final',manifestHash:'b'.repeat(64)};
  try {
    c.consumePublicationOnce(file,1,'final-conf',scope);
    c.recordPublicationOutcome(file,'final-conf','dispatched');
    const record=c.consumeFinalConfirmationOnce(file,'final-conf',scope.manifestHash);
    assert.equal(record.status,'pending','最终互斥弹窗确认先独立落盘消费');
    assert.throws(()=>c.consumeFinalConfirmationOnce(file,'final-conf',scope.manifestHash),/already consumed/);
    assert.equal(c.recordFinalConfirmationOutcome(file,'final-conf','clicked'),true);
    assert.equal(c.loadAttemptsStore(file).finalConsumed['final-conf'].status,'clicked');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});

test('attempts store persist failure means zero dispatch', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-attempts-blocked-'));
  try {
    const file = path.join(dir, 'attempts.json');
    // occupy the .tmp staging path so the durable write itself fails
    // deterministically, BEFORE any dispatch could happen
    fs.mkdirSync(file + '.tmp');
    assert.throws(() => c.consumePublicationOnce(file, 1, 'conf-1', { businessDate: '2026-10-09', runId: 'run-test', manifestHash: 'a'.repeat(64) }), Error);
    assert.ok(!fs.existsSync(file), 'no ledger may appear when the durable write failed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---------- R7: real host publish flow through the injectable orchestrator ----------
// runPublishPlan is the exact sequence the live controller uses (validate the
// user's authorization against the latest OBSERVED state -> durable consume ->
// in-page dispatch -> outcome record); only the dependencies are injected.
function hostDeps(p, obs, o = {}) {
  return {
    latest: o.latest || obs,
    runId: o.runId || 'run-x',
    configuredAccountId: o.configuredAccountId || '1710242295996424',
    approvedFirstPlan: o.approvedFirstPlan || APPROVED_FIRST_PLAN,
    attemptsFile: o.attemptsFile,
    evaluate: o.evaluate || ((fn, arg) => Promise.resolve(p.runWith(fn, arg))),
    onEvent: o.onEvent,
  };
}

test('host publish flow: durable consumption precedes the single dispatch, then the outcome is recorded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-host-ok-'));
  const file = path.join(dir, 'plan-publication-attempts.json');
  try {
    const p = makeCreationPage({});
    const obs = p.run(c.pageObserve);
    const btn = publishBtnOf(p);
    const order = [];
    const deps = hostDeps(p, obs, {
      attemptsFile: file,
      evaluate: async (fn, arg) => {
        const st = JSON.parse(fs.readFileSync(file, 'utf8'));
        order.push('before-dispatch:' + st.consumed['conf-1'].status);
        const r = p.runWith(fn, arg);
        order.push('dispatched');
        return r;
      },
      onEvent: ev => order.push('event:' + ev.op + ':' + (ev.status || ev.clicked)),
    });
    const r = await c.runPublishPlan(pubCmd(obs), deps);
    assert.equal(r.clicked, true);
    assert.equal(r.published, 'unverified');
    assert.equal(r.planId, null);
    assert.equal(r.reviewStatus, 'unknown');
    assert.equal(btn.__clicked, 1, 'exactly one click in the real host sequence');
    assert.deepEqual(order, ['before-dispatch:pending', 'dispatched', 'event:publish-plan:true']);
    assert.equal(c.loadAttemptsStore(file).consumed['conf-1'].status, 'dispatched');
    // replay with a brand-new confirmation/nonce is still refused
    assert.throws(() => c.consumePublicationOnce(file, 1, 'conf-new', { businessDate: '2026-10-09', runId: 'run-x', manifestHash: 'a'.repeat(64) }), /pending\/unknown/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('host publish flow: stale observation / wrong runId / older token produce zero dispatch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-host-stale-'));
  const file = path.join(dir, 'plan-publication-attempts.json');
  try {
    const p = makeCreationPage({});
    const obs = p.run(c.pageObserve);
    const btn = publishBtnOf(p);
    let dispatches = 0;
    const base = { attemptsFile: file, evaluate: async (fn, arg) => { dispatches++; return p.runWith(fn, arg); } };
    await assert.rejects(c.runPublishPlan(pubCmd(obs, { auth: { observation: 'stale' } }), hostDeps(p, obs, base)), /latest DOM observation/);
    await assert.rejects(c.runPublishPlan(pubCmd(obs, { auth: { runId: 'run-other' } }), hostDeps(p, obs, base)), /runId/);
    // after a FRESH inspect the user's older observation token must not dispatch
    const fresh = p.run(c.pageObserve);
    await assert.rejects(c.runPublishPlan(pubCmd(obs), hostDeps(p, fresh, base)), /latest DOM observation/);
    assert.equal(dispatches, 0);
    assert.equal(btn.__clicked, 0);
    assert.ok(!fs.existsSync(file), 'a refused gate must leave no ledger record');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('host publish flow: ledger read failures, invalid records and persist failure all produce zero dispatch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-host-fail-'));
  try {
    const p = makeCreationPage({});
    const obs = p.run(c.pageObserve);
    let dispatches = 0;
    const mk = attemptsFile => hostDeps(p, obs, { attemptsFile, evaluate: async (fn, arg) => { dispatches++; return p.runWith(fn, arg); } });
    const occupied = path.join(dir, 'occupied');
    fs.mkdirSync(occupied);
    await assert.rejects(c.runPublishPlan(pubCmd(obs), mk(occupied)), /fail-closed/);
    const badRec = path.join(dir, 'bad-rec.json');
    fs.writeFileSync(badRec, JSON.stringify({ consumed: { c0: { planNumber: '2', status: 'pending' } } }));
    await assert.rejects(c.runPublishPlan(pubCmd(obs), mk(badRec)), /fail-closed/);
    const badStore = path.join(dir, 'bad-store.json');
    fs.writeFileSync(badStore, 'not-json{');
    await assert.rejects(c.runPublishPlan(pubCmd(obs), mk(badStore)), /fail-closed/);
    const persistFail = path.join(dir, 'never.json');
    fs.mkdirSync(persistFail + '.tmp');
    await assert.rejects(c.runPublishPlan(pubCmd(obs), mk(persistFail)), Error);
    assert.ok(!fs.existsSync(persistFail));
    assert.equal(dispatches, 0, 'every failure mode above must mean zero dispatch');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('host publish flow: a dispatch exception leaves the record unknown; restart or a new nonce still refuses', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-host-unknown-'));
  const file = path.join(dir, 'plan-publication-attempts.json');
  try {
    const p = makeCreationPage({});
    const obs = p.run(c.pageObserve);
    const btn = publishBtnOf(p);
    await assert.rejects(c.runPublishPlan(pubCmd(obs), hostDeps(p, obs, { attemptsFile: file, evaluate: async () => { throw new Error('page exploded'); } })), /page exploded/);
    assert.equal(c.loadAttemptsStore(file).consumed['conf-1'].status, 'unknown');
    await assert.rejects(c.runPublishPlan(pubCmd(obs, { auth: { confirmationId: 'conf-9' } }), hostDeps(p, obs, { attemptsFile: file, evaluate: async () => { throw new Error('second'); } })), /pending\/unknown/);
    assert.equal(btn.__clicked, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('host publish flow: DOM-region frauds produce zero clicks before any dispatch', async () => {
  const cases = [
    ['account id outside the navigator header', { noNavigator: true }, /identity/],
    ['rows split across another table', { splitTables: true }, /product table mismatch/],
    ['rows with only auto-pulled douyin counts', { autoPull: true }, /product table mismatch/],
    ['unknown commission checkbox state', { commissionChecked: null }, /commission/],
  ];
  for (const [name, pageOpts, re] of cases) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pub-host-dom-'));
    const file = path.join(dir, 'plan-publication-attempts.json');
    try {
      const p = makeCreationPage(pageOpts);
      const obs = p.run(c.pageObserve);
      const btn = publishBtnOf(p);
      await assert.rejects(c.runPublishPlan(pubCmd(obs), hostDeps(p, obs, { attemptsFile: file })), re, name);
      assert.equal(btn.__clicked, 0, name);
      assert.ok(!fs.existsSync(file), name);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test('publishApply re-validation: an ROI field relabeled to a cost/bid reference after the observation yields zero clicks', () => {
  const p = makeCreationPage({});
  const obs = p.run(c.pageObserve);
  assert.equal(obs.creation.roi, '15');
  const label = allDesc(p.body).find(e => e.__text === '综合营销ROI目标(含达人佣金)');
  assert.ok(label, 'fixture must contain the ROI label');
  label.__text = '综合成本与出价参考';
  const btn = publishBtnOf(p);
  assert.throws(() => runPublish(p, obs), () => true, 'cost/bid relabel must fail final revalidation');
  assert.equal(btn.__clicked, 0);
});

test('an explicit ROI target label still outranks cost/bid help text in both observer and callback', () => {
  const p = makeCreationPage({});
  const label = allDesc(p.body).find(e => e.__text === '综合营销ROI目标(含达人佣金)');
  label.__text = '综合营销ROI目标(含达人佣金) 帮助 出价分析 综合成本参考';
  const obs = p.run(c.pageObserve);
  assert.equal(obs.creation.roi, '15');
  const btn = publishBtnOf(p);
  assert.equal(runPublish(p, obs).clicked, true);
  assert.equal(btn.__clicked, 1);
});

// ================= R8: account attribution, bounded main evidence, popup-dismiss, cookie save =================

// header account with sub-navigation siblings that carry NO id: the exact
// account container wins and the id is proven, ignoring id-less navigation
test('R8 observer proves the account from the exact container while ignoring id-less sub-navigation', () => {
  const p = makePage([
    El('div', { class: 'top-navigator-wrap', rect: [900, 30], text: '首页 全域投放 数据' }),
    El('div', { class: 'qc-page-navigator-container', rect: [900, 40], text: '伊人美 ID：1710242295996424' }),
    El('div', { class: 'mobile-navigator', rect: [900, 30], text: '营销 学堂' }),
  ], '/uni-creation/overall-product-multi', 'https://qianchuan.jinritemai.com');
  const cr = p.run(c.pageObserve).creation;
  assert.equal(cr.accountId, '1710242295996424', 'a single exact account container wins even when [class*=navigator] matches several');
  assert.equal(cr.accountNavSource, 'exact');
  assert.ok(Array.isArray(cr.accountEvidence) && cr.accountEvidence.length >= 1, 'bounded account candidate evidence is emitted');
  assert.equal(cr.accountEvidence[0].tag, 'DIV');
});

test('R8 observer falls back to [class*=navigator] only when NO exact container exists', () => {
  const p = makePage([
    El('div', { class: 'site-navigator', rect: [900, 40], text: '账号 ID：1710242295996424' }),
  ], '/uni-creation/overall-product-multi', 'https://qianchuan.jinritemai.com');
  const cr = p.run(c.pageObserve).creation;
  assert.equal(cr.accountNavSource, 'fallback');
  assert.equal(cr.accountId, '1710242295996424');
});

test('R8 observer stays unknown on conflicting account ids, never backfilling the first one', () => {
  const p = makePage([
    El('div', { class: 'qc-page-navigator-container', rect: [900, 40], text: 'A ID：1710242295996424' }),
    El('div', { class: 'qc-page-navigator-container', rect: [900, 40], text: 'B ID：1710242295996425' }),
  ], '/uni-creation/overall-product-multi', 'https://qianchuan.jinritemai.com');
  assert.equal(p.run(c.pageObserve).creation.accountId, 'unknown');
});

test('R8 observer collapses nested/duplicate same-id headers into one proven account', () => {
  const inner = El('div', { class: 'qc-page-navigator-container', rect: [900, 30], text: 'ID：1710242295996424' });
  const outer = El('div', { class: 'qc-page-navigator-container', rect: [900, 40] }, [inner]);
  const p = makePage([outer], '/uni-creation/overall-product-multi', 'https://qianchuan.jinritemai.com');
  assert.equal(p.run(c.pageObserve).creation.accountId, '1710242295996424');
});

test('R8 publishApply accepts an exact account container despite id-less sibling navigation, still refuses conflicts', () => {
  // build a full creation page, then prepend an id-less navigator to prove it
  // does not confuse the account gate (exact container wins)
  const p = makeCreationPage({});
  p.body.__kids.unshift(El('div', { class: 'top-navigator-wrap', rect: [900, 30], text: '首页 全域投放' }));
  const obs = p.run(c.pageObserve);
  assert.equal(obs.creation.accountId, '1710242295996424');
  const btn = publishBtnOf(p);
  assert.equal(runPublish(p, obs).clicked, true);
  assert.equal(btn.__clicked, 1, 'an added id-less navigator never blocks a uniquely proven account');
  // conflicting ids keep failing closed
  const conflict = makeCreationPage({});
  conflict.body.__kids.push(El('div', { class: 'qc-page-navigator-container', rect: [900, 40], text: 'X ID：1710242295996425' }));
  const cobs = conflict.run(c.pageObserve);
  assert.equal(cobs.creation.accountId, 'unknown');
  assert.throws(() => runPublish(conflict, cobs), /identity/);
  assert.equal(publishBtnOf(conflict).__clicked, 0);
});

test('R8 observer emits bounded main-root evidence without changing the table rule', () => {
  const cr = makeCreationPage({}).run(c.pageObserve).creation;
  assert.equal(cr.mainTableUnique, true);
  assert.ok(Array.isArray(cr.mainRootEvidence) && cr.mainRootEvidence.length === 1);
  assert.equal(cr.mainRootEvidence[0].rowCount, 31, 'header row + 30 product rows are visible in the chosen root');
  assert.match(cr.mainRootEvidence[0].cls, /ovui-table/);
});

// ---------- popup-dismiss ----------
function popupPage() {
  const guide = El('div', { class: 'c-lib-guide-button inbl', rect: [100, 30], text: '下一步' });
  const ack = El('div', { class: 'c-lib-guide-button', rect: [100, 30], text: '我知道了' });
  const cleanClose = El('button', { class: 'ovui-dialog__close', rect: [24, 24], text: '×' });
  const dangerClose = El('button', { class: 'ovui-modal-close', rect: [24, 24], text: '×', ariaLabel: '发布计划' });
  const adCta = El('button', { class: 'c-lib-guide-button', rect: [100, 30], text: '新建自动投放计划' });
  const dlg = El('div', { class: 'ovui-dialog', rect: [300, 200], attrs: { 'aria-modal': 'true' } }, [cleanClose, dangerClose]);
  const p = makePage([guide, ack, adCta, dlg], '/uni-creation/overall-product-multi', 'https://qianchuan.jinritemai.com');
  return { p, guide, ack, adCta, cleanClose, dangerClose };
}

test('R8 observer lists bounded popup candidates read-only, without clicking anything', () => {
  const { p, guide, cleanClose, adCta } = popupPage();
  const obs = p.run(c.pageObserve);
  assert.equal(guide.__clicked, 0);
  assert.ok(obs.popupCandidates.some(x => x.targetKind === 'guide' && x.contextText === '下一步'));
  assert.ok(obs.popupCandidates.some(x => x.targetKind === 'close' && x.index === obs.elements.find(e => e.cls === 'ovui-dialog__close').index));
  assert.ok(!obs.popupCandidates.some(x => x.contextText === '新建自动投放计划'), 'an ad CTA is never offered as a dismiss candidate');
  void cleanClose; void adCta;
});

test('R8 popupDismissApply clicks only a fresh, label-matched guide/close', () => {
  const { p, guide, ack, cleanClose } = popupPage();
  const obs = p.run(c.pageObserve);
  const o = obs.observation;
  const gi = obs.elements.find(e => e.cls === 'c-lib-guide-button inbl').index;
  const ai = obs.elements.find(e => e.text === '我知道了').index;
  const ci = obs.elements.find(e => e.cls === 'ovui-dialog__close').index;
  assert.equal(p.runWith(c.popupDismissApply, { index: gi, observation: o, targetKind: 'guide', expectedText: '下一步' }).dismissed, true);
  assert.equal(guide.__clicked, 1);
  assert.equal(p.runWith(c.popupDismissApply, { index: ai, observation: o, expectedText: '我知道了' }).dismissed, true);
  assert.equal(ack.__clicked, 1);
  assert.equal(p.runWith(c.popupDismissApply, { index: ci, observation: o, targetKind: 'close' }).dismissed, true);
  assert.equal(cleanClose.__clicked, 1);
});

test('R8 popupDismissApply zero-click on stale token, kind/label drift, ad CTA and publication close', () => {
  const { p, guide, adCta, dangerClose } = popupPage();
  const obs = p.run(c.pageObserve);
  const o = obs.observation;
  const gi = obs.elements.find(e => e.cls === 'c-lib-guide-button inbl').index;
  const adIdx = obs.elements.find(e => e.text === '新建自动投放计划').index;
  const di = obs.elements.find(e => e.cls === 'ovui-modal-close').index;
  assert.throws(() => p.runWith(c.popupDismissApply, { index: gi, observation: 'old-token' }), /Observation/);
  assert.throws(() => p.runWith(c.popupDismissApply, { index: gi, observation: o, targetKind: 'close' }), /kind changed/);
  assert.throws(() => p.runWith(c.popupDismissApply, { index: gi, observation: o, expectedText: '我知道了' }), /label changed/);
  assert.throws(() => p.runWith(c.popupDismissApply, { index: adIdx, observation: o }), /recognised/);
  assert.throws(() => p.runWith(c.popupDismissApply, { index: di, observation: o, targetKind: 'close' }), /ad-CTA blocked/);
  assert.equal(guide.__clicked, 0);
  assert.equal(adCta.__clicked, 0);
  assert.equal(dangerClose.__clicked, 0);
});

// A close/X child must inherit the FULL dangerous semantics of its ancestor
// BUTTON, including the labels that only the element's own deny regex carried.
function nestedClosePage(parentLabel, parentAria) {
  const x = El('button', { class: 'qcs-icon-close', rect: [20, 20], text: '×' });
  const parent = El('button', { class: 'ovui-btn-primary', rect: [120, 36], text: parentLabel, ariaLabel: parentAria }, [x]);
  const dlg = El('div', { class: 'ovui-dialog', rect: [300, 200], attrs: { 'aria-modal': 'true' } }, [parent]);
  const p = makePage([dlg], '/uni-creation/overall-product-multi', 'https://qianchuan.jinritemai.com');
  return { p, x, parent };
}

test('R8 popupDismissApply refuses a child close nested in a dangerous parent BUTTON', () => {
  for (const label of ['创建计划', '提交计划', '保存并发布', '同意协议', '确认扣款', '暂停投放', '关闭投放']) {
    const { p, x, parent } = nestedClosePage(label);
    const obs = p.run(c.pageObserve);
    const xi = obs.elements.find(e => e.cls === 'qcs-icon-close').index;
    assert.throws(() => p.runWith(c.popupDismissApply, { index: xi, observation: obs.observation, targetKind: 'close' }),
      /ad-CTA ancestor blocked/, 'child close under ' + label);
    assert.equal(x.__clicked, 0, 'the child close under ' + label + ' is never clicked');
    assert.equal(parent.__clicked, 0, 'the dangerous parent under ' + label + ' is never clicked');
  }
});

test('R8 popupDismissApply refuses a dangerous parent BUTTON reached via aria-label too', () => {
  const { p, x, parent } = nestedClosePage('×', '提交计划');
  const obs = p.run(c.pageObserve);
  const xi = obs.elements.find(e => e.cls === 'qcs-icon-close').index;
  assert.throws(() => p.runWith(c.popupDismissApply, { index: xi, observation: obs.observation, targetKind: 'close' }), /ad-CTA ancestor blocked/);
  assert.equal(x.__clicked, 0);
  assert.equal(parent.__clicked, 0);
});

test('R8 popupDismissApply keeps a real close/guide operable under a benign parent', () => {
  const { p, x } = nestedClosePage('', '关闭');
  const guide = El('div', { class: 'c-lib-guide-button', rect: [100, 30], text: '我知道了' });
  p.doc.body.__kids.push(guide); guide.parent = p.doc.body;
  const obs = p.run(c.pageObserve);
  const xi = obs.elements.find(e => e.cls === 'qcs-icon-close').index;
  const gi = obs.elements.find(e => e.text === '我知道了').index;
  assert.equal(p.runWith(c.popupDismissApply, { index: xi, observation: obs.observation, targetKind: 'close' }).dismissed, true);
  assert.equal(x.__clicked, 1, 'an ordinary dialog close is still dismissable');
  assert.equal(p.runWith(c.popupDismissApply, { index: gi, observation: obs.observation, targetKind: 'guide', expectedText: '我知道了' }).dismissed, true);
  assert.equal(guide.__clicked, 1);
});

// ---------- cookie identity probe ----------
function probePage(headerId, extraText, pathname, origin) {
  const kids = [El('div', { class: 'qc-page-navigator-container', rect: [900, 40], text: '千川 乘方 ID：' + headerId })];
  if (extraText) kids.push(El('div', { rect: [200, 30], text: extraText }));
  return makePage(kids, pathname || '/promotion/qianchuan/home', origin || 'https://qianchuan.jinritemai.com');
}

test('R8 cookieIdentityProbe derives identity purely from the live DOM', () => {
  assert.equal(probePage('1710242295996424').runWith(c.cookieIdentityProbe, '1710242295996424').identityOk, true);
  const wrong = probePage('1710242295996424').runWith(c.cookieIdentityProbe, '9999999999999999');
  assert.equal(wrong.identityOk, false, 'a mismatched header account is never identityOk');
  const login = probePage('1710242295996424', '登录已失效，请重新扫码登录').runWith(c.cookieIdentityProbe, '1710242295996424');
  assert.equal(login.loginOk, false, 'login-expired text is a fresh negative');
  const foreign = probePage('1710242295996424', null, '/uni-creation/overall-product-multi', 'https://evil.example.com').runWith(c.cookieIdentityProbe, '1710242295996424');
  assert.equal(foreign.originOk, false);
  assert.equal(foreign.identityOk, false);
});

// ---------- runSaveCookies host assembly (DI; never touches the real helper) ----------
// Canonical contract proven from root/src/login/cookie-writeback.js:
//   await writebackSessionCookies(p)  -- ONE options object:
//   {context, cookieFilePath, sessionStartFingerprint, identityOk, loginOk, shopId, audit}
//   audit MUST be a function; the result is
//   {ok:boolean, skipped:boolean, reason:string|null, conflict?, count?, bytes?,
//    domains?:string[], rollback?} -- there is NO status/result field.
const SESSION = { filePath: 'C:/proj/state/cookies-1710242295996424.json', startFingerprint: { exists: true, sha256: 'fp-start' } };
const CTX = { __ctx: true };
const ACCOUNT = '1710242295996424';
function wd(spy) { return { originOk: true, identityOk: true, loginOk: true, headerAccountId: ACCOUNT, ...spy }; }

test('R8 runSaveCookies skips with ZERO helper calls when session/context is missing', async () => {
  let calls = 0;
  const wb = async () => { calls++; return { ok: true, skipped: false, reason: null }; };
  const r1 = await c.runSaveCookies({}, { context: null, cookieSession: SESSION, probe: wd(), writeback: wb, accountId: ACCOUNT });
  const r2 = await c.runSaveCookies({}, { context: CTX, cookieSession: null, probe: wd(), writeback: wb, accountId: ACCOUNT });
  const r3 = await c.runSaveCookies({}, { context: CTX, cookieSession: { filePath: SESSION.filePath }, probe: wd(), writeback: wb, accountId: ACCOUNT });
  assert.equal(r1.status, 'skipped');
  assert.equal(r2.reason, 'no-live-session');
  assert.equal(r3.reason, 'no-live-session', 'a session without a start fingerprint is never written back');
  assert.equal(calls, 0);
});

test('R8 runSaveCookies refuses with ZERO helper calls on fresh wrong account/origin/login', async () => {
  let calls = 0;
  const wb = async () => { calls++; return { ok: true, skipped: false, reason: null }; };
  await c.runSaveCookies({}, { context: CTX, cookieSession: SESSION, probe: wd({ identityOk: false }), writeback: wb, accountId: 'x' });
  await c.runSaveCookies({}, { context: CTX, cookieSession: SESSION, probe: wd({ originOk: false }), writeback: wb, accountId: 'x' });
  await c.runSaveCookies({}, { context: CTX, cookieSession: SESSION, probe: wd({ loginOk: false }), writeback: wb, accountId: 'x' });
  await c.runSaveCookies({}, { context: CTX, cookieSession: SESSION, probe: null, writeback: wb, accountId: 'x' });
  assert.equal(calls, 0, 'a fresh negative identity/login/origin must never reach the helper');
});

test('R8 runSaveCookies calls the canonical helper with exactly ONE options object', async () => {
  const seen = [];
  const wb = (...args) => {
    seen.push(args);
    const p = args[0];
    if (typeof p.audit !== 'function') throw new Error('audit must be callable for the canonical helper');
    p.audit({ kind: 'cookie-writeback', shopId: p.shopId, ok: true, skipped: false });
    return { ok: true, skipped: false, reason: null, count: 42, bytes: 8100, domains: ['qianchuan.jinritemai.com', 'jinritemai.com'] };
  };
  const r = await c.runSaveCookies(
    { path: 'C:/Windows/evil.txt', filePath: 'C:/evil', cookieFilePath: 'C:/evil2', cookieSession: { filePath: 'C:/evil3' }, context: 'NOT-the-real-context', shopId: 'evil-shop', identityOk: true, loginOk: true },
    { context: CTX, cookieSession: SESSION, probe: wd(), writeback: wb, accountId: ACCOUNT });
  assert.equal(seen.length, 1, 'exactly one helper call on a fully valid fresh probe');
  const [options, ...rest] = seen[0];
  assert.equal(rest.length, 0, 'no positional arguments are forwarded to the single-object helper');
  assert.equal(Object.keys(options).sort().join(','), 'audit,context,cookieFilePath,identityOk,loginOk,sessionStartFingerprint,shopId');
  assert.equal(options.context, CTX, 'context is the actual opened object, never a cmd value');
  assert.equal(options.cookieFilePath, SESSION.filePath, 'only the real session filePath is used, never a cmd-supplied path');
  assert.equal(options.sessionStartFingerprint, SESSION.startFingerprint, 'the session start fingerprint is forwarded unchanged');
  assert.equal(options.identityOk, true);
  assert.equal(options.loginOk, true);
  assert.equal(options.shopId, ACCOUNT, 'shopId is the configured account, never a cmd-supplied one');
  assert.equal(typeof options.audit, 'function', 'the canonical helper requires a callable audit');
  assert.equal(r.status, 'saved');
  assert.equal(r.success, true);
  assert.equal(r.count, 42);
  assert.equal(r.bytes, 8100);
  assert.equal(r.domains, 2, 'domains are recorded as a bounded count, not raw helper data');
});

test('R8 runSaveCookies forwards only strict-true fresh probe flags', async () => {
  const seen = [];
  const wb = async p => { seen.push(p); return { ok: false, skipped: true, reason: '登录态未确认当前有效（fail-closed）：不覆盖 Cookie 文件' }; };
  await c.runSaveCookies({}, { context: CTX, cookieSession: SESSION, probe: wd({ identityOk: 'yes', loginOk: 1 }), writeback: wb, accountId: ACCOUNT });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].identityOk, false, 'a truthy-but-not-strict-true fresh flag is never sent as true');
  assert.equal(seen[0].loginOk, false);
});

test('R8 runSaveCookies only treats ok===true && skipped===false as saved', async () => {
  const cases = [
    { value: { ok: true, skipped: false, reason: null, count: 5, bytes: 900, domains: ['a'] }, status: 'saved', success: true },
    { value: { ok: false, skipped: true, reason: '店铺/账户身份核验未通过：不覆盖 Cookie 文件' }, status: 'skipped', success: false },
    { value: { ok: false, skipped: true, conflict: true, reason: '源 Cookie 文件在本次会话期间已被改变' }, status: 'conflict', success: false, conflict: true },
    { value: { ok: false, skipped: false, reason: 'Cookie 回写失败（旧文件保留）: disk full' }, status: 'failed', success: false },
    { value: { ok: false, skipped: false, reason: 'Cookie 回写后自校验不一致（条数/域名），已回滚旧内容', rollback: 'done' }, status: 'failed', success: false, rollback: 'done' },
    { value: { ok: true, skipped: true, reason: 'contradictory shape' }, status: 'skipped', success: false },
    { value: {}, status: 'failed', success: false, reason: 'invalid-helper-result-shape' },
    { value: { status: 'done', result: 'ok' }, status: 'failed', success: false, reason: 'invalid-helper-result-shape' },
    { value: { ok: 'true', skipped: 'false' }, status: 'failed', success: false, reason: 'invalid-helper-result-shape' },
    { value: null, status: 'failed', success: false, reason: 'invalid-helper-result-shape' },
    { value: undefined, status: 'failed', success: false, reason: 'invalid-helper-result-shape' },
    { value: [], status: 'failed', success: false, reason: 'invalid-helper-result-shape' },
    { value: 'done', status: 'failed', success: false, reason: 'invalid-helper-result-shape' },
  ];
  for (let i = 0; i < cases.length; i++) {
    const tc = cases[i];
    const wb = async () => tc.value;
    const r = await c.runSaveCookies({}, { context: CTX, cookieSession: SESSION, probe: wd(), writeback: wb, accountId: ACCOUNT });
    assert.equal(r.status, tc.status, 'case ' + i + ' status');
    assert.equal(r.success, tc.success, 'case ' + i + ' success (never a default)');
    if (tc.reason !== undefined) assert.equal(r.reason, tc.reason, 'case ' + i + ' bounded reason');
    else if (tc.value && tc.value.reason) assert.equal(r.reason, tc.value.reason.slice(0, 200), 'case ' + i + ' preserved reason');
    if (tc.conflict) assert.equal(r.conflict, true, 'case ' + i + ' conflict flag preserved');
    if (tc.rollback) assert.equal(r.rollback, tc.rollback, 'case ' + i + ' rollback metadata preserved');
  }
});

test('R8 runSaveCookies preserves a helper failure as metadata and never calls publish', async () => {
  let publishTouched = 0;
  const wb = async () => { throw new Error('newer file conflict'); };
  const r = await c.runSaveCookies({}, { context: CTX, cookieSession: SESSION, probe: wd(), writeback: wb, accountId: ACCOUNT, onPublish: () => { publishTouched++; } });
  assert.equal(r.status, 'failed');
  assert.equal(r.success, false);
  assert.match(r.reason, /conflict/);
  assert.equal(publishTouched, 0, 'a save failure must not trigger any publication');
});

test('R8 runSaveCookies does not leak cookie values or raw helper arguments into the result', async () => {
  const wb = async p => ({ ok: true, skipped: false, reason: null, count: 5, bytes: 900, domains: ['a'], cookieJar: 'SECRET-COOKIE-DUMP', cookieFilePath: p.cookieFilePath, sessionStartFingerprint: p.sessionStartFingerprint });
  const r = await c.runSaveCookies({}, { context: CTX, cookieSession: SESSION, probe: wd(), writeback: wb, accountId: ACCOUNT });
  const blob = JSON.stringify(r);
  assert.ok(!/SECRET-COOKIE-DUMP/.test(blob), 'helper-returned cookie material must never be surfaced');
  assert.ok(!blob.includes(SESSION.filePath), 'the session path is not echoed into the save result');
  assert.ok(!blob.includes('fp-start'), 'the fingerprint value is not echoed into the save result');
});

// ---------- AD-GUIDANCE-COOKIE-PERSIST: canonical hash metadata passthrough ----------
// The fingerprint gate downstream can only advance on the canonical helper's OWN
// final write hash (post-normalization bytes). runSaveCookies therefore forwards
// expectedSha256/afterSha256 on a real saved write — strictly 64-hex digests only,
// so a malformed value can neither advance a fingerprint nor smuggle path/cookie
// material into the summary. Non-saved statuses carry no hashes at all.
test('AD-GUIDANCE runSaveCookies forwards the canonical write hashes on a saved write', async () => {
  const exp = 'e'.repeat(64), aft = 'a'.repeat(64);
  const wb = async () => ({ ok: true, skipped: false, reason: null, count: 5, bytes: 900, domains: ['a'], expectedSha256: exp, afterSha256: aft });
  const r = await c.runSaveCookies({}, { context: CTX, cookieSession: SESSION, probe: wd(), writeback: wb, accountId: ACCOUNT });
  assert.equal(r.status, 'saved');
  assert.equal(r.expectedSha256, exp, 'the canonical post-normalization write hash is forwarded for the fingerprint gate');
  assert.equal(r.afterSha256, aft, 'the helper immediate-readback hash is forwarded');
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes(SESSION.filePath), 'hash forwarding never echoes the cookie file path');
  assert.ok(!blob.includes('fp-start'), 'the session start fingerprint is not echoed');
});

test('AD-GUIDANCE runSaveCookies drops malformed or smuggled hash values', async () => {
  const bad = [
    'not-a-hash',
    'C:/Users/secret/cookies.json',
    'e'.repeat(63),
    'e'.repeat(64) + 'deadbeef',
    'z'.repeat(64),
    12345,
    null,
    undefined,
  ];
  for (const value of bad) {
    const wb = async () => ({ ok: true, skipped: false, reason: null, count: 5, bytes: 900, domains: ['a'], expectedSha256: value, afterSha256: value });
    const r = await c.runSaveCookies({}, { context: CTX, cookieSession: SESSION, probe: wd(), writeback: wb, accountId: ACCOUNT });
    assert.equal(r.status, 'saved', 'value ' + JSON.stringify(value) + ' still describes a saved write');
    assert.ok(!('expectedSha256' in r), 'non-64-hex expectedSha256 is dropped: ' + JSON.stringify(value));
    assert.ok(!('afterSha256' in r), 'non-64-hex afterSha256 is dropped: ' + JSON.stringify(value));
    const needle = String(value).slice(0, 24);
    if (needle !== 'null' && needle !== 'undefined') {
      assert.ok(!JSON.stringify(r).includes(needle), 'the dropped value never resurfaces in the summary');
    }
  }
});

test('AD-GUIDANCE runSaveCookies attaches no hashes to non-saved statuses', async () => {
  const exp = 'e'.repeat(64);
  for (const value of [
    { ok: false, skipped: false, reason: 'Cookie 回写失败（旧文件保留）', expectedSha256: exp, afterSha256: exp },
    { ok: false, skipped: true, conflict: true, reason: '外部已更新', expectedSha256: exp },
    { ok: true, skipped: true, reason: 'unchanged', expectedSha256: exp },
  ]) {
    const wb = async () => value;
    const r = await c.runSaveCookies({}, { context: CTX, cookieSession: SESSION, probe: wd(), writeback: wb, accountId: ACCOUNT });
    assert.notEqual(r.status, 'saved');
    assert.ok(!('expectedSha256' in r) && !('afterSha256' in r), 'a ' + r.status + ' summary carries no write hash');
  }
});

// The production chain contract: a SUCCESSFUL canonical write whose summary lacks
// (or carries only malformed) hashes must NOT advance the live session fingerprint.
test('AD-GUIDANCE updateCookieSessionFingerprint refuses without a canonical owned-write hash', () => {
  const good = { sha256: 'e'.repeat(64), bytes: 900, count: 5, domains: 1 };
  const summary = { status: 'saved', success: true, bytes: 900, count: 5, domains: 1 };
  const readback = { exists: true, size: 900, mtimeMs: 5, sha256: 'e'.repeat(64) };
  const session = { startFingerprint: { exists: true, size: 800, mtimeMs: 4, sha256: 's'.repeat(64) } };
  assert.equal(c.updateCookieSessionFingerprint(session, summary, null, readback).updated, false, '缺 hash 不推进');
  assert.equal(c.updateCookieSessionFingerprint(session, summary, { sha256: 'C:/Users/secret/cookies.json', bytes: 900, count: 5, domains: 1 }, readback).updated, false, 'malformed hash 不推进');
  assert.equal(session.startFingerprint.sha256, 's'.repeat(64), 'refused updates leave the session baseline untouched');
  assert.equal(c.updateCookieSessionFingerprint(session, summary, good, readback).updated, true, 'the canonical hash + identical readback advances the fingerprint');
  assert.equal(session.startFingerprint.sha256, 'e'.repeat(64));
});

// main() lazily requires the real module and cannot run offline, so the assembled
// call shape is guarded statically against the two regressions found in review.
test('R8 main assembles the canonical helper as a single options object', () => {
  const src = fs.readFileSync(path.join(__dirname, 'direct-draft-controller.cjs'), 'utf8');
  assert.match(src, /writeback: options => \{[\s\S]{0,220}?writebackSessionCookies\(options\);/, 'the lazy adapter must forward the single options object verbatim');
  assert.ok(!/writebackSessionCookies\(\s*context\s*,/.test(src), 'no positional forwarding to the canonical helper');
  assert.ok(!/res\.status \|\| res\.result/.test(src), 'an absent status/result field must never default to success');
});

// ---------- R32: min-1 manual target account — publish DOM guard accepts 1, refuses 0/auto ----------
test('R32 publish DOM guard accepts one manual account per row: observe flag true and publish clicks once', () => {
  const p = makeCreationPage({ manual: 1 });
  const obs = p.run(c.pageObserve);
  assert.equal(obs.creation.productRowCount, 30);
  assert.equal(obs.creation.uniqueProductCount, 30);
  assert.equal(obs.creation.eachRowHasManualAccount, true, '每件成功绑定1个手动账号即通过发布观察守卫');
  assert.deepEqual(Array.from(obs.creation.rows.slice(0, 2).map(r => r.manualAccounts)), [1, 1]);
  const btn = publishBtnOf(p);
  const r = runPublish(p, obs);
  assert.equal(r.clicked, true);
  assert.equal(btn.__clicked, 1, '1账号主表下发布按钮恰好一次');
});

test('R32 publish DOM guard still zero-clicks on a zero-manual or auto-pull-only table', () => {
  for (const opts of [{ manual: 0 }, { autoPull: true }]) {
    const p = makeCreationPage(opts);
    const obs = p.run(c.pageObserve);
    assert.equal(obs.creation.eachRowHasManualAccount, false, '0个或仅自动拉取不算手动绑定');
    const btn = publishBtnOf(p);
    assert.throws(() => runPublish(p, obs), () => true);
    assert.ok(btn.__clicked === undefined || btn.__clicked === 0, '零账号/自动拉取绝不点发布');
  }
});

test('R32 authorization still requires exactly the two approved candidate accounts', () => {
  const p = makeCreationPage({ manual: 1 });
  const obs = p.run(c.pageObserve);
  assert.throws(() => c.validatePublishAuthorization(pubCmd(obs, { auth: { boundAccounts: ['79863866'] } }), obs, '1710242295996424', 'run-x', APPROVED_FIRST_PLAN), /approved accounts/);
  assert.throws(() => c.validatePublishAuthorization(pubCmd(obs, { auth: { boundAccounts: ['79863866', 'other_acct'] } }), obs, '1710242295996424', 'run-x', APPROVED_FIRST_PLAN), /approved accounts/);
});

// ════════════════════════════════════════════════════════════════════════════
// R33 — final mutual-exclusion modal: nested nodes merge to ONE business body;
// clickFinalConfirmInPage re-checks it and clicks a unique enabled button once;
// resumeKnownFinalOnly narrows the exact stopped final-confirm. No browser, no
// network, no CDP -- the exported run-plans page functions are driven on the
// same fake DOM, and resumeKnownFinalOnly is dependency-injected over tmp files.
// ════════════════════════════════════════════════════════════════════════════
const rp = require('./run-plans.cjs');
const pw = require('./plan-workflow.cjs');
const ns = s => String(s == null ? '' : s).replace(/\s+/g, '');
const FINAL_HDR = '为保证乘方投放的唯一性，温馨提示您:';
const FINAL_BODY = '乘方投放时，受互斥影响的放量投放-全域投放计划、控成本投放-全域投放计划将被删除（如有）。同时小店随心推订单将被终止，终止后不可恢复。 若当前商品和抖音号已在全域投放，也可前往全域升级为乘方计划，升级后原有全域计划投放数据不受影响。';

// Builds the real 8-node ovui-modal tree (wrap>ovui-modal>{close,header,icon,body,footer} + leave-footer).
function finalModal(o = {}) {
  const rect = o.rect || [800, 600];
  const confirmChildren = o.loneSpan
    ? [El('span', { rect: [100, 24], text: '确认发布' })]
    : o.plainButton
      ? [El('button', { rect: [120, 40], disabled: !!o.disabled, text: '确认发布' })]
      : [El('button', { rect: [120, 40], disabled: !!o.disabled }, [El('span', { rect: [100, 24], text: '确认发布' })])];
  const cancel = El('button', { rect: [100, 40], text: '取消' });
  const footer = El('div', { class: 'ovui-modal__footer', rect: [600, 60] }, [cancel].concat(confirmChildren));
  if (o.duplicateButton) footer.__kids.push(El('button', { rect: [120, 40] }, [El('span', { rect: [100, 24], text: '确认发布' })]));
  const header = El('div', { class: 'ovui-modal__header ovui-modal__header-with-close', rect: [600, 40], text: FINAL_HDR });
  const body = El('div', { class: 'ovui-modal__body custom-body', rect: [600, 200], text: o.bodyText == null ? FINAL_BODY : o.bodyText });
  const closeIcon = El('div', { class: 'ovui-modal__close-icon', rect: [20, 20] });
  const icon = El('iconpark-icon', { class: 'oc-modal-header-icon oc-icon-info', rect: [20, 20] });
  const inner = El('div', { class: 'ovui-modal', rect: [rect[0] - 100, rect[1] - 100] }, [closeIcon, header, icon, body, footer]);
  const leaveFooter = El('div', { class: 'uni-live-leave-page-modal-footer', rect: [600, 60], text: o.footerText == null ? '取消 确认发布' : o.footerText });
  const wrap = El('div', { class: 'ovui-modal__wrap oc-modal-wrap', rect }, [inner, leaveFooter]);
  return { wrap, header, body, footer, confirmChildren, cancel };
}
function snapshotOf(kids) { return makePage(kids).run(rp.finalDialogSnapshotInPage); }

test('R33 final modal: 8 nested nodes merge to ONE business body exactly equal to the known constant', () => {
  const m = finalModal();
  const r = snapshotOf([m.wrap]);
  assert.equal(r.reason, undefined, 'nested duplicates must not be reported as not-unique');
  assert.equal(r.visible, true);
  assert.equal(ns(r.text), ns(pw.FINAL_EXCLUSION_TEXT), 'title+body collapses to exactly the known constant');
  assert.equal(ns(r.text).includes('取消'), false, 'footer button copy must never enter the business body');
  assert.equal(pw.resolveFinalPublishButton(r.confirmTarget).ok, true, 'span resolves to the real semantic button');
});

test('R33 final modal: two independent identical modals are refused (never merged across siblings)', () => {
  const a = finalModal(); const b = finalModal();
  const r = snapshotOf([a.wrap, b.wrap]);
  assert.equal(r.reason, 'final-dialog-not-unique', 'two same-text dialogs are two roots -> refuse');
  assert.equal(r.text, '');
});

test('R33 final modal: body copy drift changes the merged body (unknown -> publishConfirmedPlan stops)', () => {
  const m = finalModal({ bodyText: FINAL_BODY + ' 新增强制条款' });
  const r = snapshotOf([m.wrap]);
  assert.equal(r.reason, undefined);
  assert.equal(pw.matchFinalExclusionDialog(r.text).known, false, 'a changed business body is not the known dialog');
});

test('R33 final modal: a footer change does not fabricate the body', () => {
  const m = finalModal({ footerText: '取消 发布' });
  const r = snapshotOf([m.wrap]);
  assert.equal(ns(r.text), ns(pw.FINAL_EXCLUSION_TEXT), 'footer copy is excluded, so the body is unchanged');
});

test('R33 final modal: duplicate/absent-button cases refuse; click never fires on them', async () => {
  for (const opts of [{ duplicateButton: true }, { loneSpan: true }]) {
    const r = snapshotOf([finalModal(opts).wrap]);
    assert.equal(r.reason, 'final-button-not-unique', 'ambiguous confirm button refuses');
    const p = makePage([finalModal(opts).wrap]);
    assert.throws(() => p.runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT), /button-not-uniquely-enabled|final-dialog/);
  }
});

test('R33 clickFinalConfirm: single click on a unique enabled button; disabled/drift/none click zero', () => {
  const good = finalModal();
  const gp = makePage([good.wrap]);
  const res = gp.runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT);
  assert.equal(res.clicked, true);
  const confirmBtn = good.footer.__kids.find(k => k.tagName === 'BUTTON' && k !== good.cancel);
  assert.equal(confirmBtn.__clicked, 1, 'exactly one click on the semantic button');
  assert.equal(good.cancel.__clicked, undefined || 0, 'cancel never clicked');

  const dis = finalModal({ disabled: true });
  const dp = makePage([dis.wrap]);
  assert.throws(() => dp.runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT), /button-not-uniquely-enabled/);
  const realDis = dis.footer.__kids.find(k => k.tagName === 'BUTTON' && k !== dis.cancel);
  assert.ok(!realDis.__clicked, 'disabled button is never clicked');

  const drift = finalModal({ bodyText: FINAL_BODY + 'X' });
  const cp = makePage([drift.wrap]);
  assert.throws(() => cp.runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT), /final-dialog-drift/);

  const two = [finalModal().wrap, finalModal().wrap];
  const tp = makePage(two);
  assert.throws(() => tp.runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT), /final-dialog-not-unique/);
});

// ── consumeFinalConfirmationOnce: controlled recovery context ───────────────
test('R33 consumeFinalConfirmationOnce: an unknown initial is refused UNLESS the exact controlled recovery context is given', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r33-final-recover-'));
  const file = path.join(dir, 'attempts.json');
  const mh = 'a'.repeat(64);
  try {
    c.consumePublicationOnce(file, 1, 'unk-conf', { businessDate: '2026-10-11', runId: 'r', manifestHash: mh });
    c.recordPublicationOutcome(file, 'unk-conf', 'unknown');
    // general unknown is refused (unchanged old guard)
    assert.throws(() => c.consumeFinalConfirmationOnce(file, 'unk-conf', mh), /not durably confirmed/);
    // a wrong reason must NOT open the recovery path
    assert.throws(() => c.consumeFinalConfirmationOnce(file, 'unk-conf', mh, { reason: 'some-other-reason', humanAuthorizedAt: '2026-10-11T11:40:00Z' }), /not durably confirmed/);
    // exact controlled recovery context is allowed and preserves the initial unknown record
    const rec = c.consumeFinalConfirmationOnce(file, 'unk-conf', mh, { reason: 'unknown-or-new-final-dialog', humanAuthorizedAt: '2026-10-11T11:40:00Z', humanConfirmation: '确认发布' });
    assert.equal(rec.status, 'pending');
    assert.equal(rec.recovery.reason, 'unknown-or-new-final-dialog');
    assert.equal(c.loadAttemptsStore(file).consumed['unk-conf'].status, 'unknown', 'initial unknown原件不改');
    assert.throws(() => c.consumeFinalConfirmationOnce(file, 'unk-conf', mh, { reason: 'unknown-or-new-final-dialog', humanAuthorizedAt: '2026-10-11T11:40:00Z' }), /already consumed/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ── resumeKnownFinalOnly dependency-injected harness (R34A) ─────────────────
const R34_ACCOUNT = '1710242295996424';
const R34_OLD_IDS = ['900000000001', '900000000002', '900000000303']; // 3rd id stands for a later page
function resumeFixture(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r34-resume-'));
  const stateFile = path.join(dir, 'plan-publisher-state.json');
  const publishedFile = path.join(dir, 'published-products.json');
  const attemptsFile = path.join(dir, 'plan-publication-attempts.json');
  const businessDate = pw.shanghaiDate(o.now || Date.now());
  const productIds = Array.from({ length: 30 }, (_, i) => '38450000000000' + String(i).padStart(2, '0'));
  const base = {
    planNumber: 1, runId: 'run-1', businessDate, accountId: R34_ACCOUNT,
    planName: (o.planName || businessDate + '_千川乘方_11:31:53'), roi: 15, dailyBudget: 300,
    commissionIncluded: true, directPay: false, boundAccounts: ['79863866', '9zmao_fushi'],
    productIds, disclosures: { migration: [], precheck: [], reviewFailed: [] },
    nonce: 'nonce-1', confirmationId: 'conf-1', frozenAt: new Date().toISOString(),
  };
  const frozen = Object.assign({}, base, { manifestHash: o.tamper ? 'f'.repeat(64) : pw.manifestHash(base) });
  const active = o.active || { status: 'publish-unknown', reason: 'unknown-or-new-final-dialog', planNumber: 1, frozen };
  pw.persistDayState(stateFile, {
    businessDate, plans: [], active, firstPublishedPlan: null, lastSelected: productIds.slice(),
    confirmationConsumptions: (o.humanRecord === false ? [] : [{ confirmationId: frozen.confirmationId, manifestHash: frozen.manifestHash, planNumber: 1, at: new Date().toISOString() }]),
  });
  const consumedRec = o.consumed || { planNumber: 1, runId: 'run-1', businessDate, manifestHash: frozen.manifestHash, status: 'unknown', at: new Date().toISOString() };
  const finalConsumed = o.finalConsumed || {};
  fs.writeFileSync(attemptsFile, JSON.stringify({ consumed: { 'conf-1': consumedRec }, finalConsumed }, null, 2));
  fs.writeFileSync(publishedFile, JSON.stringify({ publishedIds: o.oldPublished || ['old-product-1'], plans: [] }, null, 2));
  const humanAuth = o.humanAuth === null ? null : (o.humanAuth || { confirmationId: frozen.confirmationId, manifestHash: frozen.manifestHash, planNumber: 1, businessDate, planName: frozen.planName, authorized: true, at: new Date().toISOString() });
  const calls = { click: 0, readExisting: 0, reservedAtClick: null };
  const creation = Object.assign({
    originOk: true, pathOk: true, accountId: R34_ACCOUNT, planName: frozen.planName, uniqueProductCount: 30, productRowCount: 30,
    productIds, eachRowHasManualAccount: true, rows: productIds.map(id => ({ productId: id, manualAccounts: 2 })),
    roi: '15', budget: '300', commissionChecked: true, optionalDirectPayChecked: false, publishButtonCount: 1,
  }, o.creation || {});
  const newPlanId = o.newPlanId || '123456789012';
  const successRow = { found: true, planName: frozen.planName, uniqueRow: true, accountId: R34_ACCOUNT, planId: newPlanId, productCount: 30, accountCount: 2, roi: 15, dailyBudget: 300, commissionIncluded: true, status: '投放中' };
  const absence = (() => {
    if (o.absencePresent) return { absenceConfirmed: false, present: true, seenPlanIds: R34_OLD_IDS, accountId: R34_ACCOUNT };
    if (o.absenceUntrusted) return { absenceConfirmed: false, present: false, reason: 'absence-pagination-settle-timeout' };
    if (o.absenceAccountWrong) return { absenceConfirmed: true, absent: true, present: false, seenPlanIds: R34_OLD_IDS, accountId: 'WRONG-ACCOUNT' };
    if (o.absenceNoSeenIds) return { absenceConfirmed: true, absent: true, present: false, accountId: R34_ACCOUNT };
    return { absenceConfirmed: true, absent: true, present: false, seenPlanIds: (o.seenIds || R34_OLD_IDS), accountId: R34_ACCOUNT, total: (o.seenIds || R34_OLD_IDS).length };
  })();
  const deps = {
    nowMs: () => (o.now || Date.now()),
    stateFile, publishedFile, attemptsFile, frozen, humanAuth,
    readManagementAbsence: async () => absence,
    observeCreation: async () => ({ creation }),
    readFinalDialog: async () => (o.dialog === null ? null : Object.assign({ visible: true, text: pw.FINAL_EXCLUSION_TEXT, confirmTarget: { tag: 'SPAN', closestButton: true } }, o.dialog || {})),
    readManagementRow: async () => (o.postRow === null ? { found: false } : Object.assign({}, successRow, o.postRow || {})),
    readExistingPlanIds: async () => { calls.readExisting++; return R34_OLD_IDS.concat([newPlanId]); },
    clickFinalConfirm: async () => { calls.click++; calls.reservedAtClick = JSON.parse(fs.readFileSync(attemptsFile, 'utf8')).finalConsumed['conf-1']; return o.clickThrow ? (() => { throw new Error('dispatch-blew-up'); })() : { clicked: o.clickClicked !== false }; },
    readCurrentShopEnableState: o.noEnable ? undefined : (async () => Object.assign({ readOk: true, enabled: true, accountId: R34_ACCOUNT }, o.enable || {})),
  };
  return { dir, deps, frozen, businessDate, calls, stateFile, publishedFile, attemptsFile, newPlanId };
}

test('R34 resumeKnownFinalOnly: old ids frozen from trusted absence before click; post-page re-read never used; fresh enable continues', async () => {
  const f = resumeFixture();
  try {
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'success');
    assert.equal(r.publishedSuccess, true);
    assert.equal(r.clicks, 1);
    assert.equal(f.calls.readExisting, 0, 'the frozen old-id set is used; existing ids are never re-read after click');
    assert.equal(f.calls.reservedAtClick && f.calls.reservedAtClick.status, 'pending', 'durable reservation precedes the click');
    assert.equal(r.postPublishEnable.continueNextPlan, true);
    const att = c.loadAttemptsStore(f.attemptsFile);
    assert.equal(att.consumed['conf-1'].status, 'success');
    assert.equal(att.finalConsumed['conf-1'].status, 'success');
    const st = pw.loadDayState(f.stateFile, f.businessDate);
    assert.equal(st.active, null, 'fresh readOk+enabled -> published-success, next main may continue');
    assert.equal((st.plans || []).length, 1);
    const pub = JSON.parse(fs.readFileSync(f.publishedFile, 'utf8'));
    assert.ok(pub.publishedIds.includes('old-product-1'), 'old published preserved');
    assert.equal(st.confirmationConsumptions.length, 1, 'human consumption record preserved');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R34 resumeKnownFinalOnly: enable paused/mixed/unknown keeps the published fact durable but stops the enable', async () => {
  for (const enable of [{ readOk: true, enabled: false }, { readOk: false, enabled: null }, { readOk: true, enabled: null }]) {
    const f = resumeFixture({ enable });
    try {
      const r = await rp.resumeKnownFinalOnly(f.deps);
      assert.equal(r.publishedSuccess, true, 'publication fact is business success regardless of enable state');
      assert.equal(r.postPublishEnable.continueNextPlan, false);
      assert.equal(r.postPublishEnable.actionTaken, false, 'no enable action taken');
      const att = c.loadAttemptsStore(f.attemptsFile);
      assert.equal(att.finalConsumed['conf-1'].status, 'success');
      assert.equal(att.consumed['conf-1'].status, 'success');
      const st = pw.loadDayState(f.stateFile, f.businessDate);
      assert.equal(st.active.status, 'post-publish-enable-stopped', 'enable not assumed on');
      assert.equal((st.plans || []).length, 1, 'new plan persisted despite enable unknown');
      const pub = JSON.parse(fs.readFileSync(f.publishedFile, 'utf8'));
      assert.ok(pub.publishedIds.length >= 31, 'new 30 ids kept even when enable unknown');
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('R34 resumeKnownFinalOnly: trusted absence incl a later-page old id still reads back a NEW id as success', async () => {
  const seen = ['900000000001', '900000000002', '900000000303', '900000000404', '900000000505'];
  const f = resumeFixture({ seenIds: seen, newPlanId: '700000000777' });
  try {
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'success');
    assert.equal(r.planId, '700000000777', 'new id not among the frozen (incl later-page) old ids is classified new');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R34 resumeKnownFinalOnly: readback id that collides with a frozen old id is NOT new -> unknown, never re-scanned', async () => {
  const f = resumeFixture({ postRow: { planId: '900000000303' } }); // equals a frozen absence id
  try {
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'unknown');
    assert.match(String(r.reason), /plan-id-not-new/);
    assert.equal(c.loadAttemptsStore(f.attemptsFile).finalConsumed['conf-1'].status, 'unknown', 'kept unknown, not replayed');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R34 resumeKnownFinalOnly: tampered frozen (fields vs stale manifestHash) is refused with zero clicks', async () => {
  const f = resumeFixture({ tamper: true });
  try {
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'frozen-manifest-tampered');
    assert.equal(f.calls.click, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(c.loadAttemptsStore(f.attemptsFile).finalConsumed, 'conf-1'));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R34 resumeKnownFinalOnly: a dispatch exception after reservation stays unknown and is never replayed', async () => {
  const f = resumeFixture({ clickThrow: true });
  try {
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'unknown');
    assert.equal(r.clicks, 1);
    assert.equal(c.loadAttemptsStore(f.attemptsFile).finalConsumed['conf-1'].status, 'unknown');
    const again = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(again.status, 'refused');
    assert.equal(again.reason, 'final-already-consumed');
    assert.equal(f.calls.click, 1, 'the failed final is never clicked a second time');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R34 resumeKnownFinalOnly: every trusted-absence / fresh-field / manifest gate mismatch refuses with ZERO clicks and no consumption', async () => {
  const cases = [
    ['not-the-unique-stopped-final-confirm', { active: { status: 'publish-unknown', reason: 'other-reason', planNumber: 1, frozen: null } }],
    ['initial-attempt-not-unknown', { consumed: { planNumber: 1, runId: 'run-1', businessDate: pw.shanghaiDate(Date.now()), manifestHash: 'a'.repeat(64), status: 'dispatched', at: 'x' } }],
    ['human-authorization-mismatch', { humanAuth: null }],
    ['human-consumption-record-missing', { humanRecord: false }],
    ['management-absence-untrusted', { absenceUntrusted: true }],
    ['already-published-in-manager', { absencePresent: true }],
    ['management-absence-account-mismatch', { absenceAccountWrong: true }],
    ['management-absence-seen-ids-missing', { absenceNoSeenIds: true }],
    ['creation-plan-name-drift', { creation: { planName: 'other-name' } }],
    ['creation-product-ids-not-frozen', { creation: { productIds: Array.from({ length: 30 }, (_, i) => 'drift-' + i) } }],
    ['creation-manual-account-drift', { creation: { eachRowHasManualAccount: false, rows: Array.from({ length: 30 }, () => ({ manualAccounts: 0 })) } }],
    ['creation-manual-account-drift', { creation: { rows: Array.from({ length: 30 }, () => ({ manualAccounts: 1.5 })) } }],
    ['creation-config-drift', { creation: { roi: '14' } }],
    ['final-dialog-unknown-or-new', { dialog: { text: '一个未知的新弹窗文案' } }],
  ];
  for (const [reason, opts] of cases) {
    const f = resumeFixture(opts);
    try {
      const r = await rp.resumeKnownFinalOnly(f.deps);
      assert.equal(r.status, 'refused', reason + ' -> refused');
      assert.equal(r.reason, reason);
      assert.equal(f.calls.click, 0, reason + ' must perform ZERO final clicks');
      assert.ok(!Object.prototype.hasOwnProperty.call(c.loadAttemptsStore(f.attemptsFile).finalConsumed, 'conf-1'), reason + ' must leave finalConsumed empty');
    } catch (e) { e.message = reason + ': ' + e.message; throw e; } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('R34 resumeKnownFinalOnly: a wrong business-day (not the stopped day) refuses with zero clicks', async () => {
  const f = resumeFixture({ now: Date.now() });
  try {
    f.deps.frozen = { ...f.frozen, businessDate: '2020-01-01' };
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'business-date-changed');
    assert.equal(f.calls.click, 0);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ── R35: bounded SPA-hydration waits driving the REAL createRealDrivers methods ─
// These tests construct the genuine readManagementRow / readManagementAbsence /
// readCurrentShopEnableState (via rp.createRealDrivers) and feed them a fake
// managerPage whose account reader is NOT hydrated on the first frames after a
// goto, exactly like the real SPA. The contract under test: the drivers must
// bounded-WAIT for a real hydrated identity (target accountId + qianchuan route +
// readable sub-tabs) before they click any tab, and must NEVER turn a timeout,
// a wrong account, a wrong origin or an unmounted tab into a click / a scan /
// a success. Production bounds are 15/30s; tests shrink the bound so a no-progress
// wait stays fast, and a timeout is asserted to be a refusal, never success.
const R35_ACCOUNT = '1710242295996424';
const R35_HYDRATED_URL = 'https://qianchuan.jinritemai.com/uni-prom/overall?aavid=' + R35_ACCOUNT;
const R35_UNKNOWN = { accountId: null, accountName: null, hasChengfangNav: false, hasSubTabs: false, url: '' };
function r35Identity(o = {}) { return Object.assign({ accountId: R35_ACCOUNT, accountName: '测试店铺', hasChengfangNav: true, hasSubTabs: true, url: R35_HYDRATED_URL }, o); }
function r35Tag(kind, fn, extra) { fn.__kind = kind; if (extra) Object.assign(fn, extra); return fn; }

function r35Drivers(cfg = {}) {
  const calls = { identity: 0, click: 0, rows: 0, pagination: 0, nameRow: 0, goFirst: 0, goNext: 0, goto: 0 };
  const env = { activeTab: null };
  const evaluate = async (fn, arg) => {
    if (fn === rp.readManagementRowsInPage) { calls.nameRow++; return (cfg.nameRow ? cfg.nameRow(calls, env, arg) : { rowCount: 0, accountId: R35_ACCOUNT, rows: [] }); }
    const kind = fn && fn.__kind;
    if (kind === 'identity') { calls.identity++; return (cfg.identity ? cfg.identity(calls.identity, env) : R35_UNKNOWN); }
    if (kind === 'click') { calls.click++; env.activeTab = fn.__tabName; return (cfg.click ? cfg.click(calls.click, fn.__tabName, env) : { clicked: true }); }
    if (kind === 'rows') { calls.rows++; return (cfg.rows ? cfg.rows(calls, env) : { rows: [], emptyState: true }); }
    if (kind === 'pagination') { calls.pagination++; return (cfg.pagination ? cfg.pagination(calls, env) : { total: 0, pageSize: 10, activePage: 1, hasNext: false }); }
    if (kind === 'goFirst') { calls.goFirst++; return (cfg.goFirst ? cfg.goFirst(calls, env) : {}); }
    if (kind === 'goNext') { calls.goNext++; return (cfg.goNext ? cfg.goNext(calls, env) : { clicked: true }); }
    throw new Error('R35 unexpected evaluate target: ' + (fn && (fn.name || String(fn))));
  };
  const managerPage = { goto: async () => { calls.goto++; }, evaluate };
  const ctx = {
    page: null, managerPage, context: {},
    dayState: { attempted: [], hints: {} }, persist: () => {}, publishedIds: new Set(), attemptedSet: new Set(), hints: {},
    accountId: R35_ACCOUNT, opened: null, projectRoot: __dirname, planNumber: 1, runId: 'run-r35',
    readAccountInPage: r35Tag('identity', function readAccountInPage() {}),
    clickSubTab: name => r35Tag('click', function clickSubTab() {}, { __tabName: name }),
    readShopRowsInPage: r35Tag('rows', function readShopRowsInPage() {}),
    readShopPaginationInPage: r35Tag('pagination', function readShopPaginationInPage() {}),
    goFirstShopPageInPage: r35Tag('goFirst', function goFirstShopPageInPage() {}),
    goNextShopPageInPage: r35Tag('goNext', function goNextShopPageInPage() {}),
    managementHydrateTimeoutMs: cfg.hydrateTimeoutMs || 2000,
    managementTabSettleTimeoutMs: cfg.tabSettleTimeoutMs || 2000,
  };
  return { drivers: rp.createRealDrivers(ctx), calls, env };
}

test('R35 readManagementAbsence: identity unknown on first frames then hydrates -> bounded wait, ONE tab click, trusted absence', async () => {
  const m = r35Drivers({
    hydrateTimeoutMs: 3000,
    identity: n => (n < 2 ? R35_UNKNOWN : r35Identity()),
    pagination: () => ({ total: 0, pageSize: 10, activePage: 1, hasNext: false }),
    rows: () => ({ rows: [], emptyState: true }),
    nameRow: () => ({ rowCount: 0, accountId: R35_ACCOUNT, rows: [] }),
  });
  const r = await m.drivers.readManagementAbsence({ planName: '2026-10-11_千川乘方_11:31:53', accountId: R35_ACCOUNT });
  assert.equal(r.absenceConfirmed, true, 'a truly absent, fully-hydrated scan is confirmed');
  assert.equal(r.absent, true);
  assert.ok(m.calls.identity >= 2, 'the reader was polled across frames, not read once');
  assert.equal(m.calls.click, 1, 'exactly one 商品自选 tab click, and only AFTER identity hydrated');
  assert.equal(m.calls.goFirst, 0, 'a settled first page (activePage 1) needs no goFirst');
  assert.equal(m.calls.goNext, 0);
});

test('R35 readManagementAbsence: identity never hydrates -> bounded timeout refusal, ZERO tab click / scan', async () => {
  const m = r35Drivers({ hydrateTimeoutMs: 600, identity: () => R35_UNKNOWN });
  const r = await m.drivers.readManagementAbsence({ planName: 'p', accountId: R35_ACCOUNT });
  assert.equal(r.absenceConfirmed, false, 'a timeout is never absence');
  assert.equal(r.present, false);
  assert.equal(r.reason, 'management-identity-hydrate-timeout');
  assert.equal(m.calls.click, 0, 'a premature/unhydrated identity must not trigger any tab click');
  assert.equal(m.calls.goFirst, 0);
});

test('R35 readManagementAbsence: wrong account id / wrong origin / unmounted sub-tab each refuse with ZERO clicks', async () => {
  const cases = [
    ['wrong-account-id', () => r35Identity({ accountId: '9999999999999999' })],
    ['wrong-origin', () => r35Identity({ url: 'https://evil.example.com/uni-prom/overall' })],
    ['tab-not-mounted', () => r35Identity({ hasSubTabs: false })],
    ['nav-not-mounted', () => r35Identity({ hasChengfangNav: false })],
  ];
  for (const [name, identity] of cases) {
    const m = r35Drivers({ hydrateTimeoutMs: 600, identity });
    const r = await m.drivers.readManagementAbsence({ planName: 'p', accountId: R35_ACCOUNT });
    assert.equal(r.absenceConfirmed, false, name + ' must not confirm absence');
    assert.equal(r.reason, 'management-identity-hydrate-timeout', name + ' -> bounded timeout');
    assert.equal(m.calls.click, 0, name + ' must perform ZERO tab clicks (never guess a true)');
    assert.equal(m.calls.goFirst, 0, name + ' must not walk pages');
  }
});

test('R35 readManagementRow: hydrates-after-delay then reads the unique completed row; a premature identity yields ZERO clicks', async () => {
  const ok = r35Drivers({
    hydrateTimeoutMs: 3000,
    identity: n => (n < 2 ? R35_UNKNOWN : r35Identity()),
    nameRow: () => ({ rowCount: 1, accountId: R35_ACCOUNT, rows: [{ planId: '123456789012', productCount: 30, accountCount: 2, roi: 15, dailyBudget: 300, commissionIncluded: true, status: '投放中' }] }),
  });
  const r1 = await ok.drivers.readManagementRow({ planName: 'p', accountId: R35_ACCOUNT });
  assert.equal(r1.found, true);
  assert.equal(r1.uniqueRow, true);
  assert.equal(r1.planId, '123456789012');
  assert.equal(ok.calls.click, 1, 'post-final readback clicks the tab once, only after hydration');

  const stuck = r35Drivers({ hydrateTimeoutMs: 600, identity: () => R35_UNKNOWN });
  const r2 = await stuck.drivers.readManagementRow({ planName: 'p', accountId: R35_ACCOUNT });
  assert.equal(r2.found, false);
  assert.equal(r2.reason, 'management-identity-hydrate-timeout');
  assert.equal(stuck.calls.click, 0, 'a premature read is a bounded wait, never a guessed success');
});

test('R35 readManagementRow: a single failed tab click is reported once and never re-clicked', async () => {
  const m = r35Drivers({ hydrateTimeoutMs: 3000, identity: () => r35Identity(), click: () => ({ clicked: false }) });
  const r = await m.drivers.readManagementRow({ planName: 'p', accountId: R35_ACCOUNT });
  assert.equal(r.found, false);
  assert.equal(r.reason, 'management-product-self-tab-not-found');
  assert.equal(m.calls.click, 1, 'the tab is clicked once after hydration; a failed click is not blindly retried');
});

test('R35 readCurrentShopEnableState: warm page settles after EACH tab click, one click per tab, reads both tabs complete', async () => {
  const m = r35Drivers({
    identity: () => r35Identity(),
    pagination: () => ({ total: 1, pageSize: 10, activePage: 1, hasNext: false }),
    rows: (calls, env) => ({ rows: [{ id: env.activeTab === '商品自选' ? '123456789012' : '223456789012', switchChecked: true }], emptyState: false }),
    goFirst: () => ({}),
  });
  const r = await m.drivers.readCurrentShopEnableState();
  assert.equal(r.readOk, true);
  assert.equal(r.enabled, true);
  assert.equal(m.calls.click, 2, 'exactly one tab click per tab (商品自选 + 全店托管), no re-click');
  assert.equal(m.calls.goFirst, 2);
});

test('R35 readCurrentShopEnableState: a sub-list that never settles after the tab click is a bounded refusal with NO further page action', async () => {
  const m = r35Drivers({
    tabSettleTimeoutMs: 600,
    identity: () => r35Identity(),
    pagination: () => ({}),
    rows: () => ({ rows: [], emptyState: false }),
  });
  const r = await m.drivers.readCurrentShopEnableState();
  assert.equal(r.readOk, false);
  assert.equal(r.enabled, null);
  assert.match(String(r.reason), /current-shop-state-tab-settle-timeout:商品自选$/);
  assert.equal(m.calls.click, 1, 'the tab is clicked once, then bounded-waited; never blindly re-clicked');
  assert.equal(m.calls.goFirst, 0, 'an unsettled sub-list never proceeds to page-1 read');
  assert.equal(m.calls.goNext, 0, 'no ad-state action is taken when the list is not proven complete');
});

// ── R36: SPA list-stability settle (multi-page completeness) ────────────────────
// A fresh goto / tab switch first shows a stale or intermediate total that later grows.
// The FIRST numeric total is not settled — it may be the previous tab's cache (1) or an
// intermediate that is arithmetically inconsistent (10 items but hasNext true with 4 real
// pages). Absence/enable-state may only confirm after a settled STABLE total, scanned
// across ALL pages with strict hasNext completion; a mid-scan total drift or a plan-name
// hit refuses, and a load that never stabilises is a bounded timeout refusal — never a
// fake success and never any ad/final click. These drive the REAL createRealDrivers.
const R36_IDS = Array.from({ length: 32 }, (_, i) => '412345' + String(100000 + i));
function r36PageIds(page) { const start = (page - 1) * 10, count = page < 4 ? 10 : 2; return R36_IDS.slice(start, start + count); }
function r36Drivers(cfg = {}) {
  const st = { pagination: 0, rows: 0, nameRow: 0, identity: 0, click: 0, goFirst: 0, goNext: 0, goto: 0, page: 1, activeTab: null };
  const evaluate = async (fn, arg) => {
    if (fn === rp.readManagementRowsInPage) { st.nameRow++; return cfg.nameRow ? cfg.nameRow(st, arg) : { rowCount: 0, accountId: R35_ACCOUNT, rows: [] }; }
    const kind = fn && fn.__kind;
    if (kind === 'identity') { st.identity++; return r35Identity(); }
    if (kind === 'click') { st.click++; st.activeTab = fn.__tabName; st.page = 1; return (cfg.click ? cfg.click(st, fn.__tabName) : { clicked: true }); }
    if (kind === 'rows') { st.rows++; return cfg.rows ? cfg.rows(st) : { rows: [], emptyState: true }; }
    if (kind === 'pagination') { st.pagination++; return cfg.pagination ? cfg.pagination(st) : { total: 0, pageSize: '10', activePage: '1', hasNext: false }; }
    if (kind === 'goFirst') { st.goFirst++; return cfg.goFirst ? cfg.goFirst(st) : {}; }
    if (kind === 'goNext') { st.goNext++; if (!cfg.goNext || cfg.goNext(st) !== false) st.page += 1; return { clicked: true }; }
    throw new Error('R36 unexpected evaluate target: ' + (fn && (fn.name || String(fn))));
  };
  const managerPage = { goto: async () => { st.goto++; }, evaluate };
  const ctx = {
    page: null, managerPage, context: {},
    dayState: { attempted: [], hints: {} }, persist: () => {}, publishedIds: new Set(), attemptedSet: new Set(), hints: {},
    accountId: R35_ACCOUNT, opened: null, projectRoot: __dirname, planNumber: 1, runId: 'run-r36',
    readAccountInPage: r35Tag('identity', function readAccountInPage() {}),
    clickSubTab: name => r35Tag('click', function clickSubTab() {}, { __tabName: name }),
    readShopRowsInPage: r35Tag('rows', function readShopRowsInPage() {}),
    readShopPaginationInPage: r35Tag('pagination', function readShopPaginationInPage() {}),
    goFirstShopPageInPage: r35Tag('goFirst', function goFirstShopPageInPage() {}),
    goNextShopPageInPage: r35Tag('goNext', function goNextShopPageInPage() {}),
    managementHydrateTimeoutMs: cfg.hydrateTimeoutMs || 3000,
    managementTabSettleTimeoutMs: cfg.tabSettleTimeoutMs || 3000,
  };
  return { drivers: rp.createRealDrivers(ctx), st };
}
// A 32-row / 4-page list whose reader shows the old cached total (1) then an inconsistent
// intermediate (10 with hasNext true) and only then a stable 32 (2 consecutive reads).
function r36Loading32(st) {
  if (st.pagination === 1) return { pagination: { total: 1, pageSize: '10', activePage: '1', hasNext: false }, rows: [{ id: R36_IDS[0], switchChecked: true }] };
  if (st.pagination === 2) return { pagination: { total: 10, pageSize: '10', activePage: '1', hasNext: true }, rows: r36PageIds(1).map(id => ({ id, switchChecked: true })) };
  return { pagination: { total: 32, pageSize: '10', activePage: String(st.page), hasNext: st.page < 4 }, rows: r36PageIds(st.page).map(id => ({ id, switchChecked: true })) };
}

test('R36 readManagementAbsence: settles old1->intermediate10->stable32 then scans all 4 pages (never confirms at 10)', async () => {
  const m = r36Drivers({
    pagination: st => r36Loading32(st).pagination,
    rows: st => ({ rows: r36Loading32(st).rows, emptyState: false }),
  });
  const r = await m.drivers.readManagementAbsence({ planName: '2026-10-11_千川乘方_11:31:53', accountId: R35_ACCOUNT });
  assert.equal(r.absenceConfirmed, true, 'absence is only trusted after the 32-row list is fully scanned');
  assert.equal(r.total, 32);
  assert.equal(r.pages, 4);
  assert.equal(r.seenPlanIds.length, 32);
  assert.equal(r.seenPlanIds[0], '412345100000');
  assert.equal(r.seenPlanIds[31], '412345100031');
  assert.equal(m.st.click, 1, 'only 商品自选 is clicked, and once');
  assert.equal(m.st.goNext, 3, 'three advances exhaust the 4 pages');
});

test('R36 readManagementAbsence: a mid-scan total change stops and never returns trusted absence', async () => {
  const m = r36Drivers({
    pagination: st => { const s = r36Loading32(st); return st.page >= 2 ? { total: 33, pageSize: '10', activePage: String(st.page), hasNext: true } : s.pagination; },
    rows: st => ({ rows: (st.page >= 2 ? r36PageIds(st.page) : r36Loading32(st).rows.map(x => x.id)).map(id => ({ id })), emptyState: false }),
  });
  const r = await m.drivers.readManagementAbsence({ planName: 'p', accountId: R35_ACCOUNT });
  assert.equal(r.absenceConfirmed, false, 'total drift mid-scan must stop, not confirm');
  assert.equal(r.present, false);
  assert.equal(m.st.goNext, 1, 'it stopped after the first advance when the total drifted');
});

test('R36 readManagementAbsence: stable 32 with the plan name found on page 4 is refused as present (never absence)', async () => {
  const m = r36Drivers({
    pagination: st => r36Loading32(st).pagination,
    rows: st => ({ rows: r36Loading32(st).rows.map(x => ({ id: x.id })), emptyState: false }),
    nameRow: (st) => (st.page === 4 ? { rowCount: 1, accountId: R35_ACCOUNT, rows: [{ planId: R36_IDS[31] }] } : { rowCount: 0, accountId: R35_ACCOUNT, rows: [] }),
  });
  const r = await m.drivers.readManagementAbsence({ planName: 'found-on-page-4', accountId: R35_ACCOUNT });
  assert.equal(r.absenceConfirmed, false);
  assert.equal(r.present, true, 'a name hit deep in pagination is still "present"');
  assert.equal(r.reason, 'absence-plan-name-present');
  assert.equal(m.st.goNext, 3, 'all pages were scanned before concluding presence');
});

test('R36 readManagementAbsence: a load that never settles into consistent pagination is a bounded timeout, never a scan', async () => {
  const m = r36Drivers({
    tabSettleTimeoutMs: 1200,
    pagination: () => ({ total: 10, pageSize: '10', activePage: '1', hasNext: true }),
    rows: () => ({ rows: r36PageIds(1).map(id => ({ id })), emptyState: false }),
  });
  const r = await m.drivers.readManagementAbsence({ planName: 'p', accountId: R35_ACCOUNT });
  assert.equal(r.absenceConfirmed, false, 'an unsettled list is never trusted');
  assert.equal(r.reason, 'absence-tab-list-settle-timeout');
  assert.equal(m.st.goNext, 0, 'no page walk / no ad action when pagination never stabilises');
});

test('R36 readManagementAbsence: a settled empty list (cold) is still a trusted absence', async () => {
  const m = r36Drivers({
    pagination: () => ({ total: 0, pageSize: '10', activePage: '1', hasNext: false }),
    rows: () => ({ rows: [], emptyState: true }),
    nameRow: () => ({ rowCount: 0, accountId: R35_ACCOUNT, rows: [] }),
  });
  const r = await m.drivers.readManagementAbsence({ planName: 'p', accountId: R35_ACCOUNT });
  assert.equal(r.absenceConfirmed, true);
  assert.equal(r.total, 0);
  assert.equal(r.pages, 1);
});

test('R36 readCurrentShopEnableState: rejects the previous tab stale total, settles 32/4pages + a 2-row tab, no regression', async () => {
  const m = r36Drivers({
    pagination: st => {
      if (st.activeTab === '商品自选') return { total: 2, pageSize: '10', activePage: '1', hasNext: false };
      // 全店托管: the very first read is the stale previous tab cache (total 2), then a real 32
      if (st.tabReads === undefined) st.tabReads = 0;
      st.tabReads++;
      if (st.tabReads <= 2) return { total: 2, pageSize: '10', activePage: '1', hasNext: false };
      return { total: 32, pageSize: '10', activePage: String(st.page), hasNext: st.page < 4 };
    },
    rows: st => {
      if (st.activeTab === '商品自选') return { rows: [{ id: '421000000001', switchChecked: true }, { id: '421000000002', switchChecked: true }], emptyState: false };
      if (st.tabReads <= 2) return { rows: [{ id: '421000000001', switchChecked: true }, { id: '421000000002', switchChecked: true }], emptyState: false };
      return { rows: r36PageIds(st.page).map(id => ({ id, switchChecked: true })), emptyState: false };
    },
  });
  const r = await m.drivers.readCurrentShopEnableState();
  assert.equal(r.readOk, true, JSON.stringify(r));
  assert.equal(r.enabled, true);
  assert.equal(r.rowCount, 34, '2 (商品自选) + 32 (全店托管, settled past the stale 2)');
  assert.equal(m.st.click, 2, 'one click per tab');
  assert.equal(m.st.goFirst, 2, 'one goFirst per tab');
  assert.equal(m.st.goNext, 3, 'only the settled 32-row tab walks its 4 pages');
});

// ── R37: real management-page DOM parsing entry (readManagementRowsInPage) ────────
// The main brain's real read-only evidence proved readManagementRowsInPage returned
// accountId:null / rowCount:0 / rows:[] for an EXISTING plan, not a logged-out
// account. The real DOM (2026-10-11) shows: (1) the header has NO
// .qc-page-navigator-container — the id lives in nested .navigator / .qc-ui-navigator
// / .ocean-vmok-plugin-navigator / .qc-navigator-account bars all repeating the SAME
// id; (2) the name td text is NOT the pure name — it concatenates "ID：<id> 30 商品
// 2 抖音号 自动拉取 素材" around a dedicated .aurora-qc-promotion-product-adinfo-name-text
// span whose own text is exactly the plan name; (3) the product count is a BARE "30"
// next to the 商品 label (no 共/商品数 prefix). These tests drive the REAL exported
// function against a fake DOM mirroring that evidence — they do NOT claim a real run.
const R37_ACCOUNT = '1710242295996424';
const R37_OLD_ID = '1878540017535338';
const R37_OLD_NAME = '2026-10-09_千川乘方_10:55:52';
const R37_FROZEN_NAME = '2026-10-11_千川乘方_11:31:53';

function r37AccountBar(o = {}) {
  const inner = El('div', { class: 'qc-navigator-account default', rect: [900, 40], text: '伊人美 ID：' + (o.id || R37_ACCOUNT) });
  const mid = El('div', { class: 'ocean-vmok-plugin-navigator', rect: [900, 44] }, [inner]);
  const qcu = El('div', { class: 'qc-ui-navigator', rect: [900, 48] }, [mid]);
  return El('div', { class: 'navigator', rect: [900, 52] }, [qcu]);
}
function r37NameCell(nameText, id) {
  return El('td', { rect: [420, 80] }, [
    El('div', { class: 'aurora-qc-promotion-product-adinfo-name-row', rect: [400, 60] }, [
      El('span', { class: 'aurora-qc-typography aurora-qc-promotion-product-adinfo-name-text', rect: [380, 24] }, [
        El('span', { class: 'aurora-qc-typography-content', rect: [380, 24], text: nameText }),
      ]),
    ]),
    El('div', { class: 'aurora-qc-promotion-product-adinfo-meta', rect: [400, 20], text: `ID：${id} 30 商品 2 抖音号 自动拉取 素材` }),
  ]);
}
function r37PlanRow(nameText, id, o = {}) {
  return El('tr', { rect: [900, 90], attrs: { 'data-row-key': id } }, [
    r37NameCell(nameText, id),
    El('td', { rect: [200, 60], text: '每日预算 300元 综合营销ROI目标 15.00' }),
    El('td', { rect: [200, 60], text: '含达人佣金出价 基础投放' }),
    El('td', { rect: [120, 60], text: '投放中 保 审核建议' }),
    ...(o.extraCells || []),
  ]);
}
function r37Run(kids, planName) {
  const p = makePage(kids, '/uni-prom/overall', 'https://qianchuan.jinritemai.com');
  return p.runWith(rp.readManagementRowsInPage, planName);
}

test('R37 readManagementRowsInPage: real nested navigator + aurora name-td yields unique id/30/2/15/300/commission/投放中', () => {
  const kids = [r37AccountBar(), r37PlanRow(R37_OLD_NAME, R37_OLD_ID)];
  const out = r37Run(kids, R37_OLD_NAME);
  assert.equal(out.accountId, R37_ACCOUNT, 'the account id comes from the nested visible account bar, not a product row');
  assert.equal(out.rowCount, 1, 'exactly one data row matches the exact plan name');
  const row = out.rows[0];
  assert.equal(row.planId, R37_OLD_ID, 'data-row-key is the plan id');
  assert.equal(row.planName, R37_OLD_NAME, 'planName is the PURE semantic name node, never the concatenated td text');
  assert.ok(!row.planName.includes('商品') && !row.planName.includes('ID'), 'planName is not the id/商品-count-polluted cell text');
  assert.equal(row.productCount, 30, 'the bare "30" beside the 商品 label is the product count');
  assert.equal(row.accountCount, 2);
  assert.equal(row.roi, 15);
  assert.equal(row.dailyBudget, 300);
  assert.equal(row.commissionIncluded, true);
  assert.equal(row.status, '投放中');
});

test('R37 readManagementRowsInPage: the frozen (not-yet-existing) name yields rowCount 0 through the same parser', () => {
  const kids = [r37AccountBar(), r37PlanRow(R37_OLD_NAME, R37_OLD_ID)];
  const out = r37Run(kids, R37_FROZEN_NAME);
  assert.equal(out.rowCount, 0, 'a different exact name matches nothing (this is what makes the absence scan trustworthy)');
});

test('R37 readManagementRowsInPage: a superstring / prefix plan name is never matched by .includes-style drift', () => {
  const kids = [r37AccountBar(), r37PlanRow('2026-10-09_千川乘方_10:55:528', '1878540017535339'), r37PlanRow(R37_OLD_NAME, R37_OLD_ID)];
  const out = r37Run(kids, R37_OLD_NAME);
  assert.equal(out.rowCount, 1, 'querying the exact name must not also match the longer 528 twin');
  assert.equal(out.rows[0].planId, R37_OLD_ID);
});

test('R37 readManagementRowsInPage: a hidden pseudo-header with a different id is rejected; the visible bar wins', () => {
  const hidden = El('div', { class: 'navigator', rect: [900, 40], text: '隐藏 ID：9999999999999999', hidden: true });
  const kids = [hidden, r37AccountBar()];
  const out = r37Run(kids, R37_OLD_NAME);
  assert.equal(out.accountId, R37_ACCOUNT, 'a hidden account bar never contributes its id');
});

test('R37 readManagementRowsInPage: two visible account bars with DIFFERENT ids refuse (no guessed account)', () => {
  const other = El('div', { class: 'qc-navigator-account', rect: [900, 40], text: '另一账户 ID：9999999999999999' });
  const kids = [r37AccountBar(), other, r37PlanRow(R37_OLD_NAME, R37_OLD_ID)];
  const out = r37Run(kids, R37_OLD_NAME);
  assert.equal(out.accountId, null, 'a non-unique account id is a refusal, never a guessed success');
});

test('R37 readManagementRowsInPage: with NO account bar the id is null even though product ids fill the page', () => {
  const kids = [r37PlanRow(R37_OLD_NAME, R37_OLD_ID)];
  const out = r37Run(kids, R37_OLD_NAME);
  assert.equal(out.accountId, null, 'product-row ids / URL are never accepted as the account bar');
});

test('R37 readManagementRowsInPage: two independent rows sharing the exact name are NOT unique (rowCount 2)', () => {
  const kids = [r37AccountBar(), r37PlanRow(R37_OLD_NAME, R37_OLD_ID), r37PlanRow(R37_OLD_NAME, '1878540017535340')];
  const out = r37Run(kids, R37_OLD_NAME);
  assert.equal(out.rowCount, 2, 'a duplicated name across distinct trs is surfaced so readManagementRow reports uniqueRow:false');
});

test('R37 readManagementRowsInPage: the summary row is ignored even if it carries the same name node', () => {
  const summary = El('tr', { rect: [900, 40], attrs: { 'data-row-key': '__qc_table_summary_row__' } }, [r37NameCell(R37_OLD_NAME, '000000000000')]);
  const kids = [r37AccountBar(), summary, r37PlanRow(R37_OLD_NAME, R37_OLD_ID)];
  const out = r37Run(kids, R37_OLD_NAME);
  assert.equal(out.rowCount, 1, 'the __qc_table_summary_row__ aggregate line is never a plan row');
  assert.equal(out.rows[0].planId, R37_OLD_ID);
});

test('R37 readManagementRowsInPage: a name cell missing the 商品 count yields productCount null (never a fake number)', () => {
  const nameCell = El('td', { rect: [420, 80] }, [
    El('div', { class: 'aurora-qc-promotion-product-adinfo-name-row', rect: [400, 60] }, [
      El('span', { class: 'aurora-qc-promotion-product-adinfo-name-text', rect: [380, 24], text: R37_OLD_NAME }),
    ]),
    El('div', { class: 'aurora-qc-promotion-product-adinfo-meta', rect: [400, 20], text: `ID：${R37_OLD_ID} 2 抖音号 自动拉取` }),
  ]);
  const row = El('tr', { rect: [900, 90], attrs: { 'data-row-key': R37_OLD_ID } }, [
    nameCell,
    El('td', { rect: [200, 60], text: '每日预算 300元 综合营销ROI目标 15.00' }),
    El('td', { rect: [200, 60], text: '含达人佣金出价 基础投放' }),
    El('td', { rect: [120, 60], text: '投放中' }),
  ]);
  const out = r37Run([r37AccountBar(), row], R37_OLD_NAME);
  assert.equal(out.rowCount, 1);
  assert.equal(out.rows[0].productCount, null, 'an absent product count stays null so readManagementRow keeps bounded-waiting, not success');
});

test('R37 readManagementRowsInPage: legacy pure-td name fixtures stay compatible', () => {
  const legacyRow = El('tr', { rect: [900, 80], attrs: { 'data-row-key': '1860000000000001' } }, [
    El('td', { rect: [300, 40], text: '2026-09-01_千川乘方_09:00:00' }),
    El('td', { rect: [200, 40], text: '共 12 个商品 3 个抖音号' }),
    El('td', { rect: [200, 40], text: '综合营销ROI目标：20 每日预算：500元' }),
    El('td', { rect: [120, 40], text: '不含达人佣金出价' }),
    El('td', { rect: [120, 40], text: '已暂停' }),
  ]);
  const out = r37Run([r37AccountBar(), legacyRow], '2026-09-01_千川乘方_09:00:00');
  assert.equal(out.rowCount, 1, 'the legacy whole-cell-equals-name form still matches');
  assert.equal(out.rows[0].planName, '2026-09-01_千川乘方_09:00:00');
  assert.equal(out.rows[0].productCount, 12);
  assert.equal(out.rows[0].accountCount, 3);
  assert.equal(out.rows[0].roi, 20);
  assert.equal(out.rows[0].dailyBudget, 500);
  assert.equal(out.rows[0].commissionIncluded, false);
  assert.equal(out.rows[0].status, '已暂停');
});

// ════════════════════════════════════════════════════════════════════════════
// R38A — minimal pagination wait: settleShopTabList must wait for a TARGET page
// after goFirst, not merely "two consecutive identical" snapshots. A stale OLD
// page (e.g. page 4) that is itself twice-consistent must never pass the page-1
// gate; only the target page arriving (even late) may settle, and a page that
// never arrives is a bounded timeout refusal with the single goFirst and ZERO
// extra clicks. These drive the REAL createRealDrivers.
// ════════════════════════════════════════════════════════════════════════════
const R38_IDS = ['511000000001', '511000000002', '511000000003', '511000000004', '511000000005'];
const R38_EN1 = ['421000000001', '421000000002'];
const R38_EN2 = ['422000000001', '422000000002'];
function r38Drivers(cfg = {}) {
  const st = { pagination: 0, rows: 0, nameRow: 0, identity: 0, click: 0, goFirst: 0, goNext: 0, goto: 0, page: 1, activeTab: null, afterFirst: false, postIter: 0 };
  const evaluate = async (fn, arg) => {
    if (fn === rp.readManagementRowsInPage) { st.nameRow++; return cfg.nameRow ? cfg.nameRow(st, arg) : { rowCount: 0, accountId: R35_ACCOUNT, rows: [] }; }
    const kind = fn && fn.__kind;
    if (kind === 'identity') { st.identity++; return r35Identity(); }
    if (kind === 'click') { st.click++; st.activeTab = fn.__tabName; st.page = 1; st.afterFirst = false; st.postIter = 0; return (cfg.click ? cfg.click(st, fn.__tabName) : { clicked: true }); }
    if (kind === 'rows') { st.rows++; st.postIter += 1; return cfg.rows ? cfg.rows(st) : { rows: [], emptyState: true }; }
    if (kind === 'pagination') { st.pagination++; return cfg.pagination ? cfg.pagination(st) : { total: 0, pageSize: '10', activePage: '1', hasNext: false }; }
    if (kind === 'goFirst') { st.goFirst++; st.afterFirst = true; st.postIter = 0; return cfg.goFirst ? cfg.goFirst(st) : {}; }
    if (kind === 'goNext') { st.goNext++; st.page += 1; return (cfg.goNext && cfg.goNext(st) === false) ? {} : { clicked: true }; }
    throw new Error('R38 unexpected evaluate target: ' + (fn && (fn.name || String(fn))));
  };
  const managerPage = { goto: async () => { st.goto++; }, evaluate };
  const ctx = {
    page: null, managerPage, context: {},
    dayState: { attempted: [], hints: {} }, persist: () => {}, publishedIds: new Set(), attemptedSet: new Set(), hints: {},
    accountId: R35_ACCOUNT, opened: null, projectRoot: __dirname, planNumber: 1, runId: 'run-r38',
    readAccountInPage: r35Tag('identity', function readAccountInPage() {}),
    clickSubTab: name => r35Tag('click', function clickSubTab() {}, { __tabName: name }),
    readShopRowsInPage: r35Tag('rows', function readShopRowsInPage() {}),
    readShopPaginationInPage: r35Tag('pagination', function readShopPaginationInPage() {}),
    goFirstShopPageInPage: r35Tag('goFirst', function goFirstShopPageInPage() {}),
    goNextShopPageInPage: r35Tag('goNext', function goNextShopPageInPage() {}),
    managementHydrateTimeoutMs: cfg.hydrateTimeoutMs || 3000,
    managementTabSettleTimeoutMs: cfg.tabSettleTimeoutMs || 4000,
  };
  return { drivers: rp.createRealDrivers(ctx), st };
}
// Stale OLD page 4 until goFirst; after goFirst the SPA lags on page 4 for one
// read, then arrives on page 1 (and stays). page 4 is itself arithmetically
// consistent (total 5, hasNext false, activePage 4), so a two-consecutive rule
// WITHOUT a target-page requirement would have (wrongly) accepted it.
function r38LatePage1(st, ids) {
  const ap = (!st.afterFirst || st.postIter <= 1) ? 4 : 1;
  return { ap, ids: ap === 1 ? ids : ids.slice(0, 2) };
}

test('R38A readManagementAbsence: a stable OLD page 4 then a LATE page 1 after ONE goFirst settles and confirms absence', async () => {
  const m = r38Drivers({
    pagination: st => { const { ap } = r38LatePage1(st, R38_IDS); return { total: 5, pageSize: '10', activePage: String(ap), hasNext: ap < 1 }; },
    rows: st => { const { ids } = r38LatePage1(st, R38_IDS); return { rows: ids.map(id => ({ id })), emptyState: false }; },
    nameRow: () => ({ rowCount: 0, accountId: R35_ACCOUNT, rows: [] }),
  });
  const r = await m.drivers.readManagementAbsence({ planName: R37_FROZEN_NAME, accountId: R35_ACCOUNT });
  assert.equal(r.absenceConfirmed, true, 'the frozen name absent on the settled page 1 is trusted');
  assert.equal(r.total, 5);
  assert.equal(r.seenPlanIds.length, 5);
  assert.equal(m.st.goFirst, 1, 'first page is clicked exactly ONCE');
  assert.equal(m.st.goNext, 0);
});

test('R38A readManagementAbsence: a page that NEVER reaches page 1 is a bounded timeout with the single goFirst and ZERO extra clicks', async () => {
  const m = r38Drivers({
    tabSettleTimeoutMs: 800,
    pagination: () => ({ total: 5, pageSize: '10', activePage: '4', hasNext: false }),
    rows: st => ({ rows: R38_IDS.slice(0, 2).map(id => ({ id })), emptyState: false }),
    nameRow: () => ({ rowCount: 0, accountId: R35_ACCOUNT, rows: [] }),
  });
  const r = await m.drivers.readManagementAbsence({ planName: 'p', accountId: R35_ACCOUNT });
  assert.equal(r.absenceConfirmed, false, 'an old page that never becomes page 1 is never trusted');
  assert.match(String(r.reason), /absence-tab-list-settle-timeout/);
  assert.equal(m.st.goFirst, 1, 'first is clicked once and NEVER blindly re-clicked');
  assert.equal(m.st.goNext, 0, 'no page walk when the target page never arrives');
});

test('R38A readCurrentShopEnableState: a LATE page 1 on BOTH tabs after ONE goFirst each settles and reads a fresh uniform enable state', async () => {
  const m = r38Drivers({
    pagination: st => { const ids = st.activeTab === '商品自选' ? R38_EN1 : R38_EN2; const { ap } = r38LatePage1(st, ids); return { total: ids.length, pageSize: '10', activePage: String(ap), hasNext: ap < 1 }; },
    rows: st => { const ids = st.activeTab === '商品自选' ? R38_EN1 : R38_EN2; const { ap, ids: shown } = r38LatePage1(st, ids); return { rows: (ap === 1 ? ids : shown).map(id => ({ id, switchChecked: true })), emptyState: false }; },
  });
  const r = await m.drivers.readCurrentShopEnableState();
  assert.equal(r.readOk, true, JSON.stringify(r));
  assert.equal(r.enabled, true);
  assert.equal(r.rowCount, 4, '2 (商品自选) + 2 (全店托管) once each reaches page 1');
  assert.equal(m.st.click, 2, 'one tab click per tab');
  assert.equal(m.st.goFirst, 2, 'each tab clicks first page exactly once');
});

test('R38A readCurrentShopEnableState: a tab stuck on an OLD page is a bounded refusal after ONE goFirst, no ad action', async () => {
  const m = r38Drivers({
    tabSettleTimeoutMs: 800,
    pagination: () => ({ total: 2, pageSize: '10', activePage: '4', hasNext: false }),
    rows: st => ({ rows: [{ id: '421000000001', switchChecked: true }], emptyState: false }),
  });
  const r = await m.drivers.readCurrentShopEnableState();
  assert.equal(r.readOk, false);
  assert.equal(r.enabled, null);
  assert.match(String(r.reason), /current-shop-state-tab-settle-timeout:商品自选$/);
  assert.equal(m.st.click, 1, 'the first tab is clicked once, then bounded-waited');
  assert.equal(m.st.goFirst, 1, 'first page clicked once; never re-clicked on the stuck list');
  assert.equal(m.st.goNext, 0, 'no state read / no page walk when page 1 never arrives');
});

// ════════════════════════════════════════════════════════════════════════════
// R38B — controlled ONE-SHOT, OPT-IN reopen of the already-authorized first
// plan whose known final dialog has DISAPPEARED. Default is final-only (missing
// modal -> refuse, ZERO clicks). Only allowReopenMissingFinal===true may proceed,
// and only after: every frozen/manifest/human/absence/creation guard passes, a
// read-only landscape PROVES no blocking/final modal, a durable one-shot reopen
// marker lands BEFORE the single native "发布计划" click, and a fresh bounded read
// of the post-click landscape. A direct (no-modal) success NEVER fabricates a
// finalConsumed / final click; an exception after the marker NEVER reopens twice.
// These drive the REAL resumeKnownFinalOnly.
// ════════════════════════════════════════════════════════════════════════════
function reopenFixture(opts = {}) {
  const f = resumeFixture(opts.resume || {});
  const d = f.deps, calls = f.calls;
  calls.landscape = 0; calls.native = 0; calls.nativeAt = null; calls.awaitFinal = 0; calls.dialogRead = 0;
  d.readFinalDialog = async () => { calls.dialogRead++; return opts.initialDialog === undefined ? null : opts.initialDialog; };
  if (opts.allowReopenMissingFinal === true) d.allowReopenMissingFinal = true;
  d.readModalLandscape = async () => { calls.landscape++; return opts.landscape === undefined ? { ok: true, visibleDialogRoots: 0, noBlockingModal: true, finalPresent: false } : (typeof opts.landscape === 'function' ? opts.landscape() : opts.landscape); };
  d.clickNativePublishPlan = async () => {
    calls.native++;
    const s = JSON.parse(fs.readFileSync(f.attemptsFile, 'utf8'));
    calls.nativeAt = s.reopenConsumed ? s.reopenConsumed['conf-1'] : undefined;
    if (opts.nativeThrow) throw new Error('native-click-blew-up');
    if (opts.native !== undefined) return (typeof opts.native === 'function' ? opts.native() : opts.native);
    return { clicked: true };
  };
  d.awaitFinalDialog = async () => { calls.awaitFinal++; return opts.awaitFinal === undefined ? { visible: false, noDialog: true } : (typeof opts.awaitFinal === 'function' ? opts.awaitFinal() : opts.awaitFinal); };
  if (opts.preseedReopen) {
    const s = JSON.parse(fs.readFileSync(f.attemptsFile, 'utf8'));
    s.reopenConsumed = Object.assign({}, s.reopenConsumed || {}, { 'conf-1': { planNumber: 1, runId: 'run-1', businessDate: f.businessDate, manifestHash: f.frozen.manifestHash, status: 'unknown', at: new Date().toISOString() } });
    fs.writeFileSync(f.attemptsFile, JSON.stringify(s, null, 2));
  }
  return f;
}
const KNOWN_FINAL_DLG = { visible: true, text: pw.FINAL_EXCLUSION_TEXT, confirmTarget: { tag: 'SPAN', closestButton: true } };

test('R38B default (no opt-in): a missing known final dialog refuses final-only and performs ZERO reopen/native clicks', async () => {
  const f = reopenFixture();
  try {
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'final-dialog-unknown-or-new');
    assert.equal(f.calls.native, 0, 'reopen native click never attempted without opt-in');
    assert.equal(f.calls.landscape, 0, 'no landscape read without opt-in');
    assert.equal(f.calls.click, 0, 'no final click');
    assert.ok(!Object.prototype.hasOwnProperty.call(c.loadAttemptsStore(f.attemptsFile).reopenConsumed || {}, 'conf-1'), 'no reopen marker without opt-in');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R38B opt-in reopen brings the known final back: ONE native reopen click + ONE final click, new-id readback, both markers success', async () => {
  const f = reopenFixture({ allowReopenMissingFinal: true, awaitFinal: KNOWN_FINAL_DLG });
  try {
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'success');
    assert.equal(r.publishedSuccess, true);
    assert.equal(r.reopenClicks, 1, 'exactly one controlled reopen native click');
    assert.equal(r.finalClicks, 1, 'the reopened known dialog is confirmed once');
    assert.equal(r.clicks, 1);
    assert.equal(f.calls.native, 1);
    assert.equal(f.calls.click, 1);
    assert.equal(f.calls.nativeAt && f.calls.nativeAt.status, 'pending', 'the durable reopen marker is on disk BEFORE the native click');
    const att = c.loadAttemptsStore(f.attemptsFile);
    assert.equal(att.reopenConsumed['conf-1'].status, 'success');
    assert.equal(att.finalConsumed['conf-1'].status, 'success');
    assert.equal(att.consumed['conf-1'].status, 'success');
    assert.ok(att.consumed['conf-1'].status === 'success' && (att.consumed['conf-1'].status || '') !== 'unknown', 'initial promoted once, never re-dispatched');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R38B opt-in reopen with NO dialog: platform direct-submit is a real success with finalClicks 0 and NEVER a faked finalConsumed', async () => {
  const f = reopenFixture({ allowReopenMissingFinal: true, awaitFinal: { visible: false, noDialog: true } });
  try {
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'success');
    assert.equal(r.directPublish, true);
    assert.equal(r.finalClicks, 0, 'a direct submit records ZERO final clicks');
    assert.equal(r.reopenClicks, 1);
    assert.equal(f.calls.click, 0, 'no final-confirm click fires');
    const att = c.loadAttemptsStore(f.attemptsFile);
    assert.ok(!Object.prototype.hasOwnProperty.call(att.finalConsumed, 'conf-1'), 'no finalConsumed fabricated on a direct publish');
    assert.equal(att.reopenConsumed['conf-1'].status, 'success');
    assert.equal(att.consumed['conf-1'].status, 'success', 'the initial attempt records the real business success');
    const st = pw.loadDayState(f.stateFile, f.businessDate);
    assert.equal((st.plans || []).length, 1, 'the new plan is durably written even without a final dialog');
    assert.ok(st.firstPublishedPlan && String(st.firstPublishedPlan.planId) === f.newPlanId, 'firstPublishedPlan carries the readback NEW id');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R38B opt-in reopen, no dialog, but NO trustworthy new row: stops as unknown, cannot repeat, no faked success', async () => {
  const f = reopenFixture({ allowReopenMissingFinal: true, awaitFinal: { visible: false, noDialog: true }, resume: { postRow: null } });
  try {
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'unknown');
    assert.equal(r.reopenClicks, 1);
    assert.equal(r.finalClicks, 0);
    assert.equal(r.noReplay, true);
    const att = c.loadAttemptsStore(f.attemptsFile);
    assert.equal(att.reopenConsumed['conf-1'].status, 'unknown');
    assert.equal(att.consumed['conf-1'].status, 'unknown', 'no trustworthy readback keeps the initial unknown');
    const again = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(again.status, 'refused', 'a second resume is refused (day-state no longer the stopped final, and the reopen marker exists)');
    assert.ok(['not-the-unique-stopped-final-confirm', 'reopen-already-consumed'].includes(again.reason), 'lockout reason, got ' + again.reason);
    assert.equal(again.clicked, false);
    assert.equal(f.calls.native, 1, 'the reopen is never clicked a second time');
    assert.equal(f.calls.click, 0, 'no final click on a direct-publish with no trustworthy row');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R38B opt-in reopen that surfaces an UNKNOWN modal: stops as reopen-new-unknown-modal, unknown marker, no final click', async () => {
  const f = reopenFixture({ allowReopenMissingFinal: true, awaitFinal: { visible: true, text: '一个未知的新弹窗文案', confirmTarget: null } });
  try {
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'unknown');
    assert.equal(r.reason, 'reopen-new-unknown-modal');
    assert.equal(r.finalClicks, 0);
    assert.equal(f.calls.click, 0);
    assert.equal(c.loadAttemptsStore(f.attemptsFile).reopenConsumed['conf-1'].status, 'unknown');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R38B opt-in reopen: a landscape that cannot PROVE no blocking modal refuses BEFORE any marker/click (ZERO reopen)', async () => {
  const cases = [
    ['reopen-modal-landscape-unproven', { ok: true, noBlockingModal: false, finalPresent: false }],
    ['reopen-modal-landscape-unproven', { ok: false, noBlockingModal: false }],
    ['reopen-final-modal-present', { ok: true, visibleDialogRoots: 1, noBlockingModal: true, finalPresent: true }],
  ];
  for (const [reason, landscape] of cases) {
    const f = reopenFixture({ allowReopenMissingFinal: true, landscape });
    try {
      const r = await rp.resumeKnownFinalOnly(f.deps);
      assert.equal(r.status, 'refused');
      assert.equal(r.reason, reason);
      assert.equal(f.calls.native, 0, reason + ' must click nothing');
      assert.ok(!Object.prototype.hasOwnProperty.call(c.loadAttemptsStore(f.attemptsFile).reopenConsumed || {}, 'conf-1'), reason + ' must not write a marker');
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('R38B opt-in reopen: a native dispatch EXCEPTION after the marker stays unknown and is NEVER reopened a second time', async () => {
  const f = reopenFixture({ allowReopenMissingFinal: true, nativeThrow: true });
  try {
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'unknown');
    assert.match(String(r.reason), /reopen-native-dispatch-unknown/);
    assert.equal(r.reopenClicks, 1);
    assert.equal(r.finalClicks, 0);
    assert.equal(r.noReplay, true);
    assert.equal(f.calls.nativeAt && f.calls.nativeAt.status, 'pending', 'marker existed before the throwing click');
    assert.equal(c.loadAttemptsStore(f.attemptsFile).reopenConsumed['conf-1'].status, 'unknown');
    const again = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(again.status, 'refused');
    assert.equal(again.reason, 'reopen-already-consumed');
    assert.equal(f.calls.native, 1, 'never clicked a second time');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R38B opt-in reopen: a pre-existing reopen marker (already consumed) refuses with ZERO native clicks', async () => {
  const f = reopenFixture({ allowReopenMissingFinal: true, preseedReopen: true });
  try {
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'reopen-already-consumed');
    assert.equal(f.calls.native, 0);
    assert.equal(f.calls.click, 0);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R38B opt-in reopen: every inherited guard (absence/account/creation/dialog-fresh) refuses with ZERO native clicks', async () => {
  const cases = [
    ['management-absence-untrusted', { resume: { absenceUntrusted: true } }],
    ['management-absence-account-mismatch', { resume: { absenceAccountWrong: true } }],
    ['creation-plan-name-drift', { resume: { creation: { planName: 'other' } } }],
    ['creation-config-drift', { resume: { creation: { roi: '14' } } }],
  ];
  for (const [reason, opts] of cases) {
    const f = reopenFixture(Object.assign({ allowReopenMissingFinal: true }, opts));
    try {
      const r = await rp.resumeKnownFinalOnly(f.deps);
      assert.equal(r.status, 'refused', reason);
      assert.equal(r.reason, reason);
      assert.equal(f.calls.native, 0, reason + ' must perform ZERO reopen native clicks');
      assert.ok(!Object.prototype.hasOwnProperty.call(c.loadAttemptsStore(f.attemptsFile).reopenConsumed || {}, 'conf-1'), reason + ' must not write a marker');
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('R38B opt-in reopen: an already-consumed FINAL (finalConsumed present) is refused BEFORE any reopen action', async () => {
  const f = reopenFixture({ allowReopenMissingFinal: true, resume: { finalConsumed: { 'conf-1': { planNumber: 1, status: 'unknown', at: new Date().toISOString() } } } });
  try {
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'final-already-consumed');
    assert.equal(f.calls.native, 0);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ── dialogLandscapeSnapshotInPage against the real fake DOM ──────────────────
function r38Landscape(kids) { return makePage(kids).run(rp.dialogLandscapeSnapshotInPage); }

test('R38B dialogLandscapeSnapshotInPage: an empty page proves NO blocking modal (noBlockingModal true)', () => {
  const r = r38Landscape([El('input', { rect: [100, 30], placeholder: '搜索' })]);
  assert.equal(r.ok, true);
  assert.equal(r.noBlockingModal, true);
  assert.equal(r.visibleDialogRoots, 0);
  assert.equal(r.finalPresent, false);
});

test('R38B dialogLandscapeSnapshotInPage: the nested known final collapses to ONE root and flags finalPresent', () => {
  const r = r38Landscape([finalModal().wrap]);
  assert.equal(r.ok, true);
  assert.equal(r.visibleDialogRoots, 1, 'nested modal nodes merge to the single outermost root');
  assert.equal(r.noBlockingModal, false);
  assert.equal(r.finalPresent, true);
});

test('R38B dialogLandscapeSnapshotInPage: an unrelated modal is a blocking modal but NOT the known final', () => {
  const dlg = El('div', { class: 'ovui-modal', rect: [700, 500], attrs: { 'aria-modal': 'true', 'aria-label': '添加商品' } }, [El('button', { rect: [50, 30], text: '确定' })]);
  const r = r38Landscape([dlg]);
  assert.equal(r.ok, true);
  assert.equal(r.noBlockingModal, false);
  assert.equal(r.finalPresent, false, 'a non-final blocking modal must not be read as "no modal"');
});

// ── consumeReopenOnce / recordReopenOutcome direct unit ──────────────────────
test('R38B consumeReopenOnce/recordReopenOutcome: one-shot durable marker; second consume refused; invalid scope/outcome refused; missing record false', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r38-reopen-'));
  const file = path.join(dir, 'attempts.json');
  const mh = 'a'.repeat(64);
  const scope = { businessDate: '2026-10-11', runId: 'r', manifestHash: mh, planNumber: 1 };
  try {
    fs.writeFileSync(file, JSON.stringify({ consumed: {}, finalConsumed: {} }, null, 2));
    const rec = c.consumeReopenOnce(file, 'conf-x', scope);
    assert.equal(rec.status, 'pending');
    assert.throws(() => c.consumeReopenOnce(file, 'conf-x', scope), /already consumed/);
    assert.equal(c.recordReopenOutcome(file, 'conf-x', 'success'), true);
    assert.equal(c.loadAttemptsStore(file).reopenConsumed['conf-x'].status, 'success');
    assert.equal(c.recordReopenOutcome(file, 'no-such', 'success'), false, 'no record -> false, never invents one');
    assert.throws(() => c.recordReopenOutcome(file, 'conf-x', 'weird'), /Invalid reopen outcome/);
    assert.throws(() => c.consumeReopenOnce(file, 'conf-y', { businessDate: '2026-10-11', runId: 'r', manifestHash: mh }), /planNumber scope missing/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ════════════════════════════════════════════════════════════════════════════
// R39 — the three recovery-entry methods must be REAL callables on the object
// createRealDrivers RETURNS (in R38 they were referenced by resumeKnownFinalOnly
// but never provided on the driver -> typeof undefined, so the real recovery
// entry could not run). Each test drives the genuine drivers.<method> and lets
// it call the SAME in-page guards (dialogLandscapeSnapshotInPage /
// finalDialogSnapshotInPage / the pure guard.publishApply) through a fake
// page.evaluate over a real fake DOM -- never a hand-written stand-in.
// ════════════════════════════════════════════════════════════════════════════
function r39Eval(p, opts = {}) {
  const counter = { landscape: 0, final: 0, publish: 0 };
  const page = {
    evaluate: async (fn, arg) => {
      if (opts.throwOnLandscape && fn === rp.dialogLandscapeSnapshotInPage) throw new Error('dom-blew-up');
      if (fn === rp.dialogLandscapeSnapshotInPage) counter.landscape++;
      else if (fn === rp.finalDialogSnapshotInPage) counter.final++;
      else if (fn === c.publishApply) counter.publish++;
      return arg === undefined ? p.run(fn) : p.runWith(fn, arg);
    },
  };
  return { page, counter };
}
function r39Drivers(page, extra = {}) {
  const ctx = {
    page, managerPage: { goto: async () => {}, evaluate: async () => ({}) }, context: {},
    dayState: { attempted: [], hints: {} }, persist: () => {}, publishedIds: new Set(), attemptedSet: new Set(), hints: {},
    accountId: '1710242295996424', opened: null, projectRoot: __dirname, planNumber: 1, runId: 'run-r39',
    readAccountInPage: function readAccountInPage() {}, clickSubTab: () => function clickSubTab() {},
    awaitFinalDialogTimeoutMs: extra.awaitFinalDialogTimeoutMs,
  };
  return rp.createRealDrivers(ctx);
}
const R39_ORIGIN = 'https://qianchuan.jinritemai.com';
const R39_PATH = '/uni-creation/overall-product-multi';
function r39EmptyPage() { return makePage([El('input', { rect: [100, 30], placeholder: '搜索' })], R39_PATH, R39_ORIGIN); }
function r39UnknownModalPage() {
  const dlg = El('div', { class: 'ovui-modal', rect: [700, 500], attrs: { 'aria-modal': 'true', 'aria-label': '添加商品' } }, [El('button', { rect: [50, 30], text: '确定' })]);
  return makePage([dlg], R39_PATH, R39_ORIGIN);
}

test('R39 createRealDrivers EXPOSES the three recovery methods as real functions (R38 blocker was typeof undefined)', () => {
  const { page } = r39Eval(makeCreationPage({}));
  const drivers = r39Drivers(page);
  for (const fn of ['readModalLandscape', 'clickNativePublishPlan', 'awaitFinalDialog']) {
    assert.equal(typeof drivers[fn], 'function', fn + ' must be a callable driver method now');
  }
});

test('R39 readModalLandscape: drives the REAL dialogLandscapeSnapshotInPage for none / unknown / known-final', async () => {
  const none = r39Drivers(r39Eval(r39EmptyPage()).page);
  const r0 = await none.readModalLandscape();
  assert.equal(r0.ok, true);
  assert.equal(r0.noBlockingModal, true, 'an empty creation page proves no blocking modal');
  assert.equal(r0.finalPresent, false);

  const unk = r39Drivers(r39Eval(r39UnknownModalPage()).page);
  const r1 = await unk.readModalLandscape();
  assert.equal(r1.ok, true);
  assert.equal(r1.noBlockingModal, false, 'a non-final modal IS a blocking modal, never "no modal"');
  assert.equal(r1.finalPresent, false);

  const fin = r39Drivers(r39Eval(makePage([finalModal().wrap], R39_PATH, R39_ORIGIN)).page);
  const r2 = await fin.readModalLandscape();
  assert.equal(r2.ok, true);
  assert.equal(r2.noBlockingModal, false);
  assert.equal(r2.finalPresent, true, 'the known final keyword is flagged, so a still-present final is never reopened');
});

test('R39 clickNativePublishPlan: delegates to the pure guard.publishApply, forwards the fresh observation, and clicks exactly once on a valid DOM', async () => {
  const p = makeCreationPage({});
  const ev = r39Eval(p);
  const drivers = r39Drivers(ev.page);
  const obs = await drivers.observe();
  assert.ok(obs && obs.observation, 'the real pageObserve mints an observation token');
  const btn = p.body.querySelectorAll('button').filter(b => b.__text === '发布计划')[0];
  const r = await drivers.clickNativePublishPlan({ observation: obs.observation, planNumber: 1, accountId: '1710242295996424', productIds: APPROVED_IDS.slice(), planName: PLAN_NAME });
  assert.equal(r.clicked, true, 'guard.publishApply itself reported the click');
  assert.equal(r.published, 'unverified', 'a click is never claimed as publication');
  assert.equal(ev.counter.publish, 1, 'it went through the REAL publishApply, not a stand-in');
  assert.equal(btn.__clicked, 1, 'exactly one click on the exact 发布计划 button');
});

test('R39 clickNativePublishPlan: a stale observation / disabled button / visible dialog makes the REAL publishApply THROW -> rejected with ZERO fabricated clicks', async () => {
  const stale = makeCreationPage({});
  const sd = r39Drivers(r39Eval(stale).page);
  await sd.observe();
  let threw = false;
  try { await sd.clickNativePublishPlan({ observation: 'stale-token', planNumber: 1, accountId: '1710242295996424', productIds: APPROVED_IDS.slice(), planName: PLAN_NAME }); }
  catch (e) { threw = true; assert.match(String(e.message), /Observation expired/); }
  assert.ok(threw, 'a stale observation must throw, never fabricate a click');
  assert.equal(stale.body.querySelectorAll('button').filter(b => b.__text === '发布计划')[0].__clicked, 0);

  const disabled = makeCreationPage({ publishDisabled: true });
  const dd = r39Drivers(r39Eval(disabled).page);
  const dobs = await dd.observe();
  await assert.rejects(() => dd.clickNativePublishPlan({ observation: dobs.observation, planNumber: 1, accountId: '1710242295996424', productIds: APPROVED_IDS.slice(), planName: PLAN_NAME }), /disabled/);
  assert.equal(disabled.body.querySelectorAll('button').filter(b => b.__text === '发布计划')[0].__clicked, 0, 'a disabled publish button is never clicked');

  const withDialog = makeCreationPage({ dialog: true });
  const wd = r39Drivers(r39Eval(withDialog).page);
  const wobs = await wd.observe();
  await assert.rejects(() => wd.clickNativePublishPlan({ observation: wobs.observation, planNumber: 1, accountId: '1710242295996424', productIds: APPROVED_IDS.slice(), planName: PLAN_NAME }), /dialog/);
  assert.equal(withDialog.body.querySelectorAll('button').filter(b => b.__text === '发布计划')[0].__clicked, 0, 'an unhandled visible dialog blocks the click (zero actions)');
});

test('R39 awaitFinalDialog: returns the known unique final dialog the instant it is present', async () => {
  const ev = r39Eval(makePage([finalModal().wrap], R39_PATH, R39_ORIGIN));
  const drivers = r39Drivers(ev.page, { awaitFinalDialogTimeoutMs: 2000 });
  const dlg = await drivers.awaitFinalDialog();
  assert.equal(dlg.visible, true);
  assert.equal(pw.matchFinalExclusionDialog(dlg.text).known, true, 'the known final copy is returned for confirmation');
  assert.equal(pw.resolveFinalPublishButton(dlg.confirmTarget).ok, true);
});

test('R39 awaitFinalDialog: an UNKNOWN blocking modal is returned immediately as visible-unknown (never waited out as "no modal")', async () => {
  const ev = r39Eval(r39UnknownModalPage());
  const drivers = r39Drivers(ev.page, { awaitFinalDialogTimeoutMs: 5000 });
  const t0 = Date.now();
  const dlg = await drivers.awaitFinalDialog();
  assert.equal(dlg.visible, true);
  assert.equal(pw.matchFinalExclusionDialog(dlg.text).known, false, 'an unknown modal must not masquerade as the known final');
  assert.equal(dlg.confirmTarget, null);
  assert.ok(Date.now() - t0 < 3000, 'it refuses on the FIRST frame, it does not burn the whole window');
  assert.ok(ev.counter.landscape >= 1, 'the real landscape read drove the decision');
});

test('R39 awaitFinalDialog: a genuinely empty page waits the bounded window THEN proves a fresh strict landscape of zero roots before reporting noDialog', async () => {
  const ev = r39Eval(r39EmptyPage());
  const drivers = r39Drivers(ev.page, { awaitFinalDialogTimeoutMs: 300 });
  const dlg = await drivers.awaitFinalDialog();
  assert.equal(dlg.visible, false);
  assert.equal(dlg.noDialog, true, 'noDialog only after the window expires AND a fresh landscape still shows nothing');
  assert.ok(ev.counter.landscape >= 2, 'a single first-frame empty is NEVER enough -- the reader polled repeatedly', ev.counter.landscape);
});

test('R39 awaitFinalDialog: a DOM read exception can NEVER be reported as noDialog (unknown is not absence)', async () => {
  const ev = r39Eval(r39EmptyPage(), { throwOnLandscape: true });
  const drivers = r39Drivers(ev.page, { awaitFinalDialogTimeoutMs: 200 });
  const dlg = await drivers.awaitFinalDialog();
  assert.equal(dlg.noDialog, false, 'a failed landscape read is unproven, never a no-dialog success path');
  assert.equal(dlg.visible, false);
});

// ── end-to-end integration: resumeKnownFinalOnly driven by the REAL driver methods ──
function r39Integration(revealFinal) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r39-int-'));
  const stateFile = path.join(dir, 'plan-publisher-state.json');
  const publishedFile = path.join(dir, 'published-products.json');
  const attemptsFile = path.join(dir, 'plan-publication-attempts.json');
  const businessDate = pw.shanghaiDate(Date.now());
  const productIds = APPROVED_IDS.slice();
  const OLD = ['900000000001', '900000000002'];
  const newPlanId = '777000000001';
  const base = {
    planNumber: 1, runId: 'run-1', businessDate, accountId: '1710242295996424', planName: PLAN_NAME,
    roi: 15, dailyBudget: 300, commissionIncluded: true, directPay: false, boundAccounts: ['79863866', '9zmao_fushi'],
    productIds, disclosures: { migration: [], precheck: [], reviewFailed: [] },
    nonce: 'n-1', confirmationId: 'conf-1', frozenAt: new Date().toISOString(),
  };
  const frozen = Object.assign({}, base, { manifestHash: pw.manifestHash(base) });
  pw.persistDayState(stateFile, {
    businessDate, plans: [], active: { status: 'publish-unknown', reason: 'unknown-or-new-final-dialog', planNumber: 1, frozen },
    firstPublishedPlan: null, lastSelected: productIds.slice(),
    confirmationConsumptions: [{ confirmationId: frozen.confirmationId, manifestHash: frozen.manifestHash, planNumber: 1, at: new Date().toISOString() }],
  });
  fs.writeFileSync(attemptsFile, JSON.stringify({ consumed: { 'conf-1': { planNumber: 1, runId: 'run-1', businessDate, manifestHash: frozen.manifestHash, status: 'unknown', at: new Date().toISOString() } }, finalConsumed: {} }, null, 2));
  fs.writeFileSync(publishedFile, JSON.stringify({ publishedIds: ['old-product-1'], plans: [] }, null, 2));
  const humanAuth = { confirmationId: frozen.confirmationId, manifestHash: frozen.manifestHash, planNumber: 1, businessDate, planName: frozen.planName, authorized: true, at: new Date().toISOString() };

  const creationP = makeCreationPage({});
  const finalP = makePage([finalModal().wrap], R39_PATH, R39_ORIGIN);
  const stage = { v: 'creation' };
  const publishBtn = creationP.body.querySelectorAll('button').filter(b => b.__text === '发布计划')[0];
  const page = {
    evaluate: async (fn, arg) => {
      if (fn === c.publishApply) { const r = creationP.runWith(c.publishApply, arg); if (revealFinal) stage.v = 'final'; return r; }
      const dom = (revealFinal && stage.v === 'final') ? finalP : creationP;
      return arg === undefined ? dom.run(fn) : dom.runWith(fn, arg);
    },
  };
  const drivers = r39Drivers(page, { awaitFinalDialogTimeoutMs: 300 });
  const calls = { finalClick: 0, landscapePre: 0 };
  const deps = {
    nowMs: () => Date.now(), stateFile, publishedFile, attemptsFile, frozen, humanAuth,
    readManagementAbsence: async () => ({ absenceConfirmed: true, absent: true, present: false, seenPlanIds: OLD, accountId: '1710242295996424', total: OLD.length }),
    observeCreation: () => drivers.observe(),
    readFinalDialog: async () => null,
    readManagementRow: async () => ({ found: true, planName: PLAN_NAME, uniqueRow: true, accountId: '1710242295996424', planId: newPlanId, productCount: 30, accountCount: 2, roi: 15, dailyBudget: 300, commissionIncluded: true, status: '投放中' }),
    clickFinalConfirm: async () => { calls.finalClick++; return { clicked: true }; },
    readCurrentShopEnableState: async () => ({ readOk: true, enabled: true, accountId: '1710242295996424' }),
    readModalLandscape: drivers.readModalLandscape,
    clickNativePublishPlan: drivers.clickNativePublishPlan,
    awaitFinalDialog: drivers.awaitFinalDialog,
    allowReopenMissingFinal: true,
  };
  return { dir, deps, frozen, businessDate, publishBtn, calls, newPlanId, attemptsFile, stateFile, publishedFile };
}

test('R39 integration: resumeKnownFinalOnly driven by the REAL driver reopen brings the known final back -> one native reopen + one final, markers success', async () => {
  const f = r39Integration(true);
  try {
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'success');
    assert.equal(r.reopenClicks, 1, 'exactly one native reopen click through the real publishApply');
    assert.equal(r.finalClicks, 1);
    assert.equal(f.publishBtn.__clicked, 1, 'the REAL guard.publishApply clicked the real button once');
    assert.equal(f.calls.finalClick, 1);
    const att = c.loadAttemptsStore(f.attemptsFile);
    assert.equal(att.reopenConsumed['conf-1'].status, 'success');
    assert.equal(att.finalConsumed['conf-1'].status, 'success');
    assert.equal(att.consumed['conf-1'].status, 'success');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R39 integration: resumeKnownFinalOnly driven by the REAL driver methods, platform direct-submits (no final) -> success finalClicks 0, NO faked finalConsumed', async () => {
  const f = r39Integration(false);
  try {
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'success');
    assert.equal(r.directPublish, true);
    assert.equal(r.reopenClicks, 1);
    assert.equal(r.finalClicks, 0, 'a direct submit records ZERO final clicks');
    assert.equal(f.publishBtn.__clicked, 1, 'the real publishApply performed the single native reopen click');
    assert.equal(f.calls.finalClick, 0, 'no final-confirm click fires');
    const att = c.loadAttemptsStore(f.attemptsFile);
    assert.ok(!Object.prototype.hasOwnProperty.call(att.finalConsumed, 'conf-1'), 'no finalConsumed fabricated');
    assert.equal(att.reopenConsumed['conf-1'].status, 'success');
    assert.equal(att.consumed['conf-1'].status, 'success');
    const st = pw.loadDayState(f.stateFile, f.businessDate);
    assert.ok(st.firstPublishedPlan && String(st.firstPublishedPlan.planId) === f.newPlanId, 'firstPublishedPlan carries the readback NEW id');
    // second resume is refused (day-state cleared + marker locks), never re-clicked
    const again = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(again.status, 'refused');
    assert.equal(f.publishBtn.__clicked, 1, 'never clicked a second time');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ── R40 Objective A: readManagementRow prefers the ORIGINAL redirected success page ──
// After a real publish the platform auto-redirects the creation `page` to the same-account
// management route that ACTUALLY lists the new plan. The old cold-goto+clickSubTab lands on
// the excluded filter view (only the prior plans). These tests drive the genuine
// createRealDrivers readManagementRow with SEPARATE `page` and `managerPage` fakes and
// assert: when `page` is on a credible route + real nav account it is read DIRECTLY (ZERO
// managerPage.goto, ZERO tab switch); a creation-route page still falls back strictly; a
// wrong account never reads rows; a field-incomplete redirected page is a bounded STOP, not
// a bounce to the excluded old tab. No fabricated filter URL / query, no sourceFrom shortcut.
function r40Drivers(cfg = {}) {
  const calls = { pageGoto: 0, mgrGoto: 0, pageIdentity: 0, mgrIdentity: 0, mgrClick: 0, pageNameRow: 0, mgrNameRow: 0 };
  const identityFn = r35Tag('identity', function readAccountInPage() {});
  const clickSubTab = name => r35Tag('click', function clickSubTab() {}, { __tabName: name });
  const page = cfg.pagePresent === false ? null : {
    goto: async () => { calls.pageGoto++; },
    evaluate: async (fn, arg) => {
      if (fn === rp.readManagementRowsInPage) { calls.pageNameRow++; return cfg.pageNameRow ? cfg.pageNameRow(calls, arg) : { rowCount: 0, accountId: R35_ACCOUNT, rows: [] }; }
      if (fn && fn.__kind === 'identity') { calls.pageIdentity++; if (cfg.pageIdentityThrow) throw new Error('boom'); return cfg.pageIdentity ? cfg.pageIdentity(calls.pageIdentity) : r35Identity(); }
      throw new Error('R40 unexpected page evaluate');
    },
  };
  const mgrEnv = { activeTab: null };
  const managerPage = {
    goto: async () => { calls.mgrGoto++; },
    evaluate: async (fn, arg) => {
      if (fn === rp.readManagementRowsInPage) { calls.mgrNameRow++; return cfg.mgrNameRow ? cfg.mgrNameRow(calls, mgrEnv, arg) : { rowCount: 0, accountId: R35_ACCOUNT, rows: [] }; }
      const kind = fn && fn.__kind;
      if (kind === 'identity') { calls.mgrIdentity++; return cfg.mgrIdentity ? cfg.mgrIdentity(calls.mgrIdentity, mgrEnv) : r35Identity(); }
      if (kind === 'click') { calls.mgrClick++; mgrEnv.activeTab = fn.__tabName; return cfg.mgrClickFn ? cfg.mgrClickFn(calls.mgrClick, fn.__tabName, mgrEnv) : { clicked: true }; }
      throw new Error('R40 unexpected manager evaluate');
    },
  };
  const ctx = {
    page, managerPage, context: {},
    dayState: { attempted: [], hints: {} }, persist: () => {}, publishedIds: new Set(), attemptedSet: new Set(), hints: {},
    accountId: R35_ACCOUNT, opened: null, projectRoot: __dirname, planNumber: 1, runId: 'run-r40',
    readAccountInPage: identityFn, clickSubTab,
    managementHydrateTimeoutMs: cfg.hydrateTimeoutMs || 1500,
    managementTabSettleTimeoutMs: cfg.tabSettleTimeoutMs || 1500,
    successManagementReadTimeoutMs: cfg.successTimeoutMs || 1500,
    // R41 added a bounded strict cold-goto fallback for an INCONCLUSIVE redirected read; without
    // this hook the fallback's own wait uses the production default and a fixture that never
    // completes a row would block for the whole production window instead of the test bound.
    managementRowCompleteTimeoutMs: cfg.rowCompleteTimeoutMs || 1500,
  };
  return { drivers: rp.createRealDrivers(ctx), calls };
}
const R40_SUCCESS_ROW = () => ({ rowCount: 1, accountId: R35_ACCOUNT, rows: [{ planId: '1234567890123456', planName: 'p', productCount: 30, accountCount: 2, roi: 15, dailyBudget: 300, commissionIncluded: true, status: '投放中' }] });

test('R40 readManagementRow: a redirected same-account management page is read DIRECTLY with ZERO cold goto and ZERO tab switch', async () => {
  const m = r40Drivers({ pagePresent: true, pageIdentity: () => r35Identity(), pageNameRow: R40_SUCCESS_ROW });
  const r = await m.drivers.readManagementRow({ planName: 'p', accountId: R35_ACCOUNT });
  assert.equal(r.found, true, 'the unique exact-name row is read from the live redirected page');
  assert.equal(r.uniqueRow, true);
  assert.equal(r.planId, '1234567890123456');
  assert.equal(r.productCount, 30);
  assert.equal(r.status, '投放中');
  assert.equal(m.calls.mgrGoto, 0, 'the original page is preferred; no cold-goto to the excluded filter view');
  assert.equal(m.calls.mgrClick, 0, 'no 商品自选 tab switch on the manager (which would hide the new plan)');
  assert.equal(m.calls.pageGoto, 0, 'the live page is read as-is, never re-navigated');
  assert.equal(m.calls.pageNameRow >= 1, true, 'the redirected page actually parsed rows');
});

test('R40 readManagementRow: a page still on the creation route falls back to the strict cold-goto path', async () => {
  const m = r40Drivers({
    pageIdentity: () => r35Identity({ url: 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi?aavid=' + R35_ACCOUNT }),
    mgrNameRow: R40_SUCCESS_ROW,
  });
  const r = await m.drivers.readManagementRow({ planName: 'p', accountId: R35_ACCOUNT });
  assert.equal(r.found, true, 'the fallback cold-goto still yields the row');
  assert.equal(m.calls.pageNameRow, 0, 'a creation-route page is never read for rows (never bounced onto a filter it cannot trust)');
  assert.equal(m.calls.mgrGoto, 1, 'strict fallback navigated the manager once');
  assert.equal(m.calls.mgrClick, 1, 'fallback settled + clicked the tab once');
});

test('R40 readManagementRow: a wrong expected account is refused BEFORE any navigation or row read', async () => {
  const m = r40Drivers({ pageNameRow: R40_SUCCESS_ROW, mgrNameRow: R40_SUCCESS_ROW });
  const r = await m.drivers.readManagementRow({ planName: 'p', accountId: '9999999999999999' });
  assert.equal(r.found, false);
  assert.equal(r.reason, 'management-account-identity-unknown');
  assert.equal(m.calls.pageNameRow, 0);
  assert.equal(m.calls.mgrGoto, 0);
});

test('R40 readManagementRow: a credible redirected page whose row is field-incomplete is a bounded STOP, and the incomplete row is never accepted', async () => {
  const m = r40Drivers({
    pageIdentity: () => r35Identity(),
    pageNameRow: () => ({ rowCount: 1, accountId: R35_ACCOUNT, rows: [{ planId: '1234567890123456', productCount: 30, accountCount: 2, roi: null, dailyBudget: 300, commissionIncluded: true, status: '投放中' }] }),
    successTimeoutMs: 400,
    rowCompleteTimeoutMs: 400,
  });
  const r = await m.drivers.readManagementRow({ planName: 'p', accountId: R35_ACCOUNT });
  assert.equal(r.found, false, 'a row missing a required field is never a success');
  assert.equal(r.reason, 'management-row-or-required-fields-timeout', 'an incomplete authoritative read is a refusal, never a success and never a fabricated row');
  // R41: a TIMEOUT on the redirected page is an INCONCLUSIVE read, not a conclusion, so it is
  // retried exactly ONCE on the strict cold-goto management path (identity settle + 商品自选
  // click + the same exact-name/complete-field contract). That path still refuses to invent a
  // complete row, so the whole call stays an honest bounded stop: the incomplete row is never
  // accepted and no row from the excluded old-tab view is ever returned as this plan's row.
  assert.equal(m.calls.mgrGoto, 1, 'exactly one bounded strict fallback, never a retry loop');
  assert.equal(m.calls.pageGoto, 0, 'the live redirected page is never re-navigated');
});

test('R40 readManagementRow: a redirected page reporting the WRONG nav account is never used for rows; strict fallback still guards', async () => {
  const m = r40Drivers({
    pageIdentity: () => r35Identity({ accountId: '9999999999999999' }),
    mgrNameRow: R40_SUCCESS_ROW,
  });
  const r = await m.drivers.readManagementRow({ planName: 'p', accountId: R35_ACCOUNT });
  assert.equal(m.calls.pageNameRow, 0, 'a wrong-account page never has its rows trusted');
  assert.equal(r.found, true, 'the strict fallback still reads the row');
  assert.equal(m.calls.mgrGoto, 1);
});

test('R40 readManagementRow: an identity read exception on the page is treated as "not usable" and falls back (never a crash, never fabricated)', async () => {
  const m = r40Drivers({ pageIdentityThrow: true, mgrNameRow: R40_SUCCESS_ROW });
  const r = await m.drivers.readManagementRow({ planName: 'p', accountId: R35_ACCOUNT });
  assert.equal(r.found, true, 'a failing page identity simply yields to the strict fallback');
  assert.equal(m.calls.pageNameRow, 0);
  assert.equal(m.calls.mgrGoto, 1);
});

// ── R40 Objective B: reconcilePublishedReadbackOnly (browser-write-free / ad-click-free) ──
// Reconciles the durable local facts of an ALREADY-real publication whose driver readback
// FAILED (active publish-unknown + CHANGED reason, final/reopen one-shot markers already
// consumed unknown). It only READS the management row, uses the main-brain-injected trusted
// prior old-id set (never re-reads current ids), promotes the original unknown one-shot
// records to a real success ONLY on a full classifyPublishOutcome success, appends published
// products + day plan idempotently, and NEVER clicks / consumes a nonce / fakes enabled.
const R40_ACCOUNT = '1710242295996424';
const R40_PRODUCT_IDS = Array.from({ length: 30 }, (_, i) => '38450000000000' + String(i).padStart(2, '0'));
function r40ReconcileFixture(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r40-reconcile-'));
  const stateFile = path.join(dir, 'state.json');
  const publishedFile = path.join(dir, 'published.json');
  const attemptsFile = path.join(dir, 'attempts.json');
  const businessDate = pw.shanghaiDate(o.now || Date.now());
  const base = {
    planNumber: 1, runId: 'run-1', businessDate, accountId: R40_ACCOUNT,
    planName: o.planName || (businessDate + '_千川乘方_11:31:53'), roi: 15, dailyBudget: 300, commissionIncluded: true, directPay: false,
    boundAccounts: ['79863866', '9zmao_fushi'], productIds: R40_PRODUCT_IDS,
    disclosures: { migration: [], precheck: [], reviewFailed: [] },
    nonce: 'nonce-1', confirmationId: 'conf-1', frozenAt: new Date().toISOString(),
  };
  const frozen = Object.assign({}, base, { manifestHash: o.tamper ? 'f'.repeat(64) : pw.manifestHash(base) });
  const active = 'active' in o ? o.active : { status: 'publish-unknown', reason: 'management-row-read-failed', planNumber: 1, frozen };
  pw.persistDayState(stateFile, {
    businessDate, plans: o.dayPlans || [], active, firstPublishedPlan: o.firstPublishedPlan || null, lastSelected: R40_PRODUCT_IDS.slice(),
    confirmationConsumptions: (o.humanRecord === false ? [] : [{ confirmationId: frozen.confirmationId, manifestHash: frozen.manifestHash, planNumber: 1, at: new Date().toISOString() }]),
  });
  const consumedRec = o.consumed || { planNumber: 1, runId: 'run-1', businessDate, manifestHash: frozen.manifestHash, status: 'unknown', at: new Date().toISOString() };
  const finalConsumed = 'finalConsumed' in o ? o.finalConsumed : { 'conf-1': { planNumber: 1, runId: 'run-1', businessDate, manifestHash: frozen.manifestHash, status: 'unknown', at: new Date().toISOString() } };
  const reopenConsumed = 'reopenConsumed' in o ? o.reopenConsumed : { 'conf-1': { planNumber: 1, runId: 'run-1', businessDate, manifestHash: frozen.manifestHash, status: 'unknown', at: new Date().toISOString() } };
  fs.writeFileSync(attemptsFile, JSON.stringify({ consumed: { 'conf-1': consumedRec }, finalConsumed, reopenConsumed }, null, 2));
  const baseIds = o.publishedIds || Array.from({ length: 120 }, (_, i) => 'base-product-' + i);
  const basePlans = o.publishedPlans || [{ planId: '900000000001', date: businessDate }, { planId: '900000000002', date: businessDate }, { planId: '900000000003', date: businessDate }, { planId: '900000000004', date: businessDate }];
  if (o.publishedRaw !== undefined) fs.writeFileSync(publishedFile, o.publishedRaw);
  else fs.writeFileSync(publishedFile, JSON.stringify({ publishedIds: baseIds, plans: basePlans }, null, 2));
  const humanAuth = o.humanAuth === null ? null : (o.humanAuth || { confirmationId: frozen.confirmationId, manifestHash: frozen.manifestHash, planNumber: 1, businessDate, planName: frozen.planName, authorized: true, at: new Date().toISOString() });
  const R40_OLD_IDS = basePlans.map(p => p.planId);
  const newPlanId = o.newPlanId || '1234567890123456';
  const newRow = o.readRow === null ? { found: false } : Object.assign({ found: true, uniqueRow: true, accountId: R40_ACCOUNT, planName: frozen.planName, planId: newPlanId, productCount: 30, accountCount: 2, roi: 15, dailyBudget: 300, commissionIncluded: true, status: '投放中' }, o.readRow || {});
  const calls = { readExisting: 0, click: 0 };
  const deps = {
    nowMs: () => (o.now || Date.now()),
    stateFile, publishedFile, attemptsFile, frozen, humanAuth,
    trustedPriorOldPlanIds: ('trustedOldIds' in o ? o.trustedOldIds : R40_OLD_IDS),
    readManagementRow: async () => newRow,
    readCurrentShopEnableState: o.noEnable ? undefined : (async () => Object.assign({ readOk: true, enabled: false, accountId: R40_ACCOUNT, reason: 'mixed' }, o.enable || {})),
    readExistingPlanIds: async () => { calls.readExisting++; return R40_OLD_IDS.concat([newPlanId]); },
  };
  if (o.withClickDep) deps.clickFinalConfirm = async () => { calls.click++; return { clicked: true }; };
  return { dir, deps, frozen, businessDate, calls, stateFile, publishedFile, attemptsFile, newPlanId, R40_OLD_IDS };
}

test('R40 reconcile: a trusted readback success promotes the original unknown records and appends 30 products/1 day plan, keeping mixed shop NOT cleared', async () => {
  const f = r40ReconcileFixture();
  try {
    const r = await rp.reconcilePublishedReadbackOnly(f.deps);
    assert.equal(r.status, 'success');
    assert.equal(r.planId, f.newPlanId);
    assert.equal(r.clicked, false, 'the executor performs ZERO actions');
    assert.equal(r.clicks, 0);
    assert.equal(r.noAction, true);
    assert.equal(f.calls.readExisting, 0, 'the injected trusted old-id set is used; current ids are never re-read');
    assert.equal(r.postPublishEnable.status, 'needs-existing-enable-capability', 'mixed shop is reported honestly, never faked enabled');
    assert.equal(r.postPublishEnable.continueNextPlan, false);
    const pub = JSON.parse(fs.readFileSync(f.publishedFile, 'utf8'));
    assert.equal(pub.publishedIds.length, 150, '120 history preserved + 30 new appended');
    assert.equal(pub.plans.length, 5, 'the new 5th plan appended once');
    assert.ok(pub.publishedIds.includes('base-product-0') && pub.publishedIds.includes(R40_PRODUCT_IDS[0]));
    const st = pw.loadDayState(f.stateFile, f.businessDate);
    assert.equal(st.plans.length, 1);
    assert.equal(st.plans[0].status, 'success');
    assert.ok(st.firstPublishedPlan && String(st.firstPublishedPlan.planId) === f.newPlanId, 'firstPublishedPlan carries the readback NEW id');
    assert.equal(st.active.status, 'post-publish-enable-stopped', 'mixed/paused keeps post-publish-enable-stopped WITH the new id; never cleared, never faked enabled');
    assert.equal(st.active.planId, f.newPlanId);
    const att = c.loadAttemptsStore(f.attemptsFile);
    assert.equal(att.consumed['conf-1'].status, 'success');
    assert.equal(att.finalConsumed['conf-1'].status, 'success');
    assert.equal(att.reopenConsumed['conf-1'].status, 'success');
    // second run is idempotent (already reconciled), never re-appends
    const r2 = await rp.reconcilePublishedReadbackOnly(f.deps);
    assert.equal(r2.status, 'alreadyReconciled');
    const pub2 = JSON.parse(fs.readFileSync(f.publishedFile, 'utf8'));
    assert.equal(pub2.publishedIds.length, 150, 'no duplicate append on a second run');
    assert.equal(pub2.plans.length, 5);
    const st2 = pw.loadDayState(f.stateFile, f.businessDate);
    assert.equal(st2.plans.length, 1, 'day plan is not duplicated');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R40 reconcile: a freshly-all-enabled shop clears the active and continues; mixed does not', async () => {
  const f = r40ReconcileFixture({ enable: { enabled: true } });
  try {
    const r = await rp.reconcilePublishedReadbackOnly(f.deps);
    assert.equal(r.status, 'success');
    assert.equal(r.postPublishEnable.status, 'already-enabled');
    assert.equal(r.postPublishEnable.continueNextPlan, true);
    const st = pw.loadDayState(f.stateFile, f.businessDate);
    assert.equal(st.active, null, 'a real fresh readOk+enabled clears active (never assumed)');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R40 reconcile: every classifyPublishOutcome / guard drift writes ZERO facts and keeps the unknown records', async () => {
  const drift = [
    ['new-id-in-old-set', { trustedOldIds: ['900000000001', '900000000002', '900000000003', '900000000004', '1234567890123456'] }],
    ['product-count', { readRow: { productCount: 12 } }],
    ['account-count', { readRow: { accountCount: 0 } }],
    ['roi', { readRow: { roi: 12 } }],
    ['budget', { readRow: { dailyBudget: 500 } }],
    ['commission', { readRow: { commissionIncluded: false } }],
    ['status', { readRow: { status: '建计划失败' } }],
    ['account-drift', { readRow: { accountId: '9999999999999999' } }],
    ['name-drift', { readRow: { planName: 'other-name' } }],
    ['row-not-found', { readRow: null }],
    ['manifest-tamper', { tamper: true }],
    ['no-old-ids', { trustedOldIds: undefined }],
    ['human-missing', { humanAuth: null }],
    ['no-consumption', { humanRecord: false }],
    ['dispatched-initial', { consumed: { planNumber: 1, runId: 'run-1', businessDate: pw.shanghaiDate(Date.now()), manifestHash: 'a'.repeat(64), status: 'dispatched', at: 'x' } }],
    ['reopen-marker-missing', { reopenConsumed: {} }],
    ['final-marker-success-premature', { finalConsumed: { 'conf-1': { planNumber: 1, runId: 'run-1', businessDate: pw.shanghaiDate(Date.now()), manifestHash: 'a'.repeat(64), status: 'success', at: 'x' } } }],
    ['wrong-account-frozen', { active: { status: 'publish-unknown', reason: 'x', planNumber: 1, frozen: { planNumber: 1, runId: 'run-1', businessDate: pw.shanghaiDate(Date.now()), accountId: 'WRONG', planName: 'p', manifestHash: 'a'.repeat(64), productIds: [] } } }],
  ];
  for (const [name, opts] of drift) {
    const f = r40ReconcileFixture(Object.assign({ now: Date.now() }, opts));
    try {
      const before = { pub: fs.readFileSync(f.publishedFile, 'utf8'), state: fs.readFileSync(f.stateFile, 'utf8'), attempts: fs.readFileSync(f.attemptsFile, 'utf8') };
      let r;
      try { r = await rp.reconcilePublishedReadbackOnly(f.deps); }
      catch (e) { r = { status: 'threw', reason: e.message }; }
      assert.notEqual(r.status, 'success', name + ' must never reconcile to success');
      assert.equal(r.clicked || false, false, name + ' performs no click');
      assert.equal(f.calls.readExisting, 0, name + ' never re-reads current ids');
      if (r.status !== 'threw') assert.equal(fs.readFileSync(f.publishedFile, 'utf8'), before.pub, name + ' must not mutate published');
      assert.equal(fs.readFileSync(f.attemptsFile, 'utf8'), before.attempts, name + ' must not promote/alter one-shot records');
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('R40 reconcile: business-date-changed refuses with ZERO writes', async () => {
  const f = r40ReconcileFixture({ now: Date.now() });
  try {
    const before = fs.readFileSync(f.attemptsFile, 'utf8');
    // Move "now" far into the future so shanghaiDate != frozen.businessDate.
    f.deps.nowMs = () => (Date.now() + 400 * 86400000);
    const r = await rp.reconcilePublishedReadbackOnly(f.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'business-date-changed');
    assert.equal(fs.readFileSync(f.attemptsFile, 'utf8'), before);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R40 reconcile: a live-action dependency (click) is REFUSED before any read, and no click fires', async () => {
  const f = r40ReconcileFixture({ withClickDep: true });
  try {
    const r = await rp.reconcilePublishedReadbackOnly(f.deps);
    assert.equal(r.status, 'refused');
    assert.ok(/reconcile-forbids-live-action-dependency/.test(r.reason), 'this entry only reads; a click dep is rejected outright');
    assert.equal(f.calls.click, 0, 'no click dependency was ever invoked');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R40 reconcile: a persistence failure keeps the already-written facts and reports, taking NO ad action', async () => {
  const f = r40ReconcileFixture({ publishedRaw: 'not-json{' });
  try {
    const r = await rp.reconcilePublishedReadbackOnly(f.deps);
    assert.equal(r.status, 'unknown', 'a write-back failure is reported honestly, never a success');
    assert.ok(/reconcile-write-back-failed/.test(r.reason));
    assert.equal(r.clicked, false, 'no ad action is taken even when the append fails');
    // The one-shot records were promoted (already-written facts), published/day were NOT appended.
    const att = c.loadAttemptsStore(f.attemptsFile);
    assert.equal(att.consumed['conf-1'].status, 'success');
    const st = pw.loadDayState(f.stateFile, f.businessDate);
    assert.equal(st.active.status, 'publish-unknown', 'the publish-unknown active stays until a clean re-reconcile, never faked cleared');
    assert.equal(st.plans.length, 0, 'no day plan appended on a failed write');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('R40 reconcile: the executor takes ZERO real browser/ad actions end-to-end (no click dep, readExisting never called, no publish)', async () => {
  const f = r40ReconcileFixture();
  try {
    const r = await rp.reconcilePublishedReadbackOnly(f.deps);
    assert.equal(r.status, 'success');
    assert.equal(r.clicked, false);
    assert.equal(r.clicks, 0);
    assert.equal(r.noAction, true);
    assert.equal(f.calls.readExisting, 0, 'this reconciliation never re-derives old ids by reading the live manager');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

// ── R42: explicit platform failure -> ONE same-day replacement retry ─────────
// The 2nd plan was explicitly refused by the platform (发布失败 / 商品已下架). These
// tests lock the whole contract: the trusted proof marks the ORIGINAL failed, and
// a single NEW frozen (29 kept + 1 replaced) may be retried EXACTLY once. None of
// the refusals may click; the original CID is refused forever.
const R42_TODAY = wf.shanghaiDate(Date.now());
const R42_OLD_IDS = APPROVED_IDS.slice();
const R42_FAIL_ID = R42_OLD_IDS[29];
const R42_REPLACEMENT_ID = '71234567890123459999';
const R42_NEW_IDS = R42_OLD_IDS.slice(0, 29).concat([R42_REPLACEMENT_ID]);
const R42_APPROVED_FIRST = { planNumber: 1, status: 'success', planId: '1234567890123456', account_id: '1710242295996424', product_ids: R42_OLD_IDS.slice() };

function r42Frozen(planNumber, ids, confirmationId, runId) {
  const plan = {
    planNumber, runId, businessDate: R42_TODAY, accountId: '1710242295996424', planName: PLAN_NAME,
    roi: 15, dailyBudget: 300, commissionIncluded: true, directPay: false,
    boundAccounts: ['79863866', '9zmao_fushi'], productIds: ids.slice(),
    disclosures: { migration: [], precheck: [], reviewFailed: [] },
  };
  return { ...plan, manifestHash: wf.manifestHash(plan), nonce: 'nonce-' + confirmationId, confirmationId, frozenAt: new Date().toISOString() };
}
function r42Proof(oldFrozen, o = {}) {
  const failingId = o.failingId || R42_FAIL_ID;
  return Object.assign({
    failureText: '发布失败 失败原因: 商品(ID:' + failingId + ')在抖音号(ID:69976954606)下不可投:商品已下架，请前往「抖店后台」 进行处理 我知道了',
    capturedAccountId: '1710242295996424',
    capturedCreationUrl: 'https://qianchuan.jinritemai.com/uni-creation/overall-product-multi?aavid=1710242295996424',
    capturedAt: new Date().toISOString(), evidenceSha256: 'c'.repeat(64),
    confirmationId: oldFrozen.confirmationId, manifestHash: oldFrozen.manifestHash,
  }, o);
}
function r42RetryScope(newFrozen) {
  return { businessDate: R42_TODAY, runId: 'run-x', manifestHash: newFrozen.manifestHash, retryOfConfirmationId: 'conf-old',
    accountId: '1710242295996424', planName: PLAN_NAME, productIds: R42_NEW_IDS };
}
function r42Seed(file, oldFrozen) {
  const scope = { businessDate: R42_TODAY, runId: oldFrozen.runId, manifestHash: oldFrozen.manifestHash };
  c.consumePublicationOnce(file, oldFrozen.planNumber, oldFrozen.confirmationId, scope);
  c.recordPublicationOutcome(file, oldFrozen.confirmationId, 'dispatched');
  c.consumeFinalConfirmationOnce(file, oldFrozen.confirmationId, oldFrozen.manifestHash);
  c.recordFinalConfirmationOutcome(file, oldFrozen.confirmationId, 'unknown');
  c.recordPublicationOutcome(file, oldFrozen.confirmationId, 'unknown');
}
function r42CreationPage(ids, o) {
  const p = makeCreationPage(o || {});
  const cells = allDesc(p.body).filter(e => e.tagName === 'TD' && /ID[:：]\s*\d{15,20}/.test(String(e.__text || '')));
  assert.ok(cells.length >= 30, 'creation fixture must expose the 30 product cells');
  for (let i = 0; i < 30; i++) cells[i].__text = '商品' + i + ' 店铺新品 ID：' + ids[i];
  return p;
}

test('R42 proof validator: only an explicit 发布失败+商品已下架 text naming one original id is accepted', () => {
  const oldFrozen = r42Frozen(2, R42_OLD_IDS, 'conf-old', 'run-x');
  const base = r42Proof(oldFrozen);
  assert.throws(() => c.validateExplicitFailureProof(oldFrozen, { ...base, failureText: '提交超时，请稍后重试' }), /发布失败/);
  assert.throws(() => c.validateExplicitFailureProof(oldFrozen, { ...base, failureText: '根据系统前置检测，当前商品可能审核不通过' }), /发布失败/);
  assert.throws(() => c.validateExplicitFailureProof(oldFrozen, { ...base, failureText: '发布失败' }), /商品已下架/);
  assert.throws(() => c.validateExplicitFailureProof(oldFrozen, { ...base, failureText: '发布失败 商品已下架' }), /exactly one product id/);
  assert.throws(() => c.validateExplicitFailureProof(oldFrozen, { ...base, evidenceSha256: 'zz' }), /sha256/);
  assert.throws(() => c.validateExplicitFailureProof(oldFrozen, { ...base, manifestHash: 'f'.repeat(64) }), /manifest hash/);
  assert.throws(() => c.validateExplicitFailureProof(oldFrozen, { ...base, capturedAccountId: '9999999999999999' }), /account/);
  assert.throws(() => c.validateExplicitFailureProof(oldFrozen, { ...base, capturedCreationUrl: 'https://evil.example.com/uni-creation/overall-product-multi' }), /origin/);
  assert.throws(() => c.validateExplicitFailureProof(oldFrozen, { ...base, failureText: base.failureText.replace(R42_FAIL_ID, '71111111111111111111') }), /not among the original 30/);
  const missing = { ...base }; delete missing.evidenceSha256;
  assert.throws(() => c.validateExplicitFailureProof(oldFrozen, missing), /evidenceSha256/);
  assert.throws(() => c.validateExplicitFailureProof({ ...oldFrozen, productIds: R42_NEW_IDS }, base), /hash mismatch/);
  assert.equal(c.validateExplicitFailureProof(oldFrozen, base).failingProductId, R42_FAIL_ID);
});

test('R42 recordExplicitPlatformFailure: durable failed mark, idempotent, conflicts refused, success never rewritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r42-rec-'));
  const file = path.join(dir, 'attempts.json');
  try {
    const oldFrozen = r42Frozen(2, R42_OLD_IDS, 'conf-old', 'run-x');
    r42Seed(file, oldFrozen);
    const rec = c.recordExplicitPlatformFailure(file, oldFrozen, r42Proof(oldFrozen));
    assert.equal(rec.status, 'failed');
    assert.equal(rec.priorStatus, 'unknown');
    assert.equal(rec.explicitPlatformFailure.failingProductId, R42_FAIL_ID);
    assert.equal(rec.explicitPlatformFailure.originalProductIds.length, 30);
    const store = c.loadAttemptsStore(file); // restart readback: a 'failed' final record is valid
    assert.equal(store.consumed['conf-old'].status, 'failed');
    assert.equal(store.finalConsumed['conf-old'].status, 'failed');
    assert.equal(store.finalConsumed['conf-old'].priorStatus, 'unknown');
    assert.equal(c.recordExplicitPlatformFailure(file, oldFrozen, r42Proof(oldFrozen)).status, 'failed', 'identical proof is idempotent');
    assert.throws(() => c.recordExplicitPlatformFailure(file, oldFrozen, r42Proof(oldFrozen, { evidenceSha256: 'd'.repeat(64) })), /conflict/);
    // a success original can NEVER be rewritten as failed
    const okFile = path.join(dir, 'ok.json');
    const okFrozen = r42Frozen(1, R42_NEW_IDS, 'conf-ok', 'run-x');
    c.consumePublicationOnce(okFile, 1, 'conf-ok', { businessDate: R42_TODAY, runId: 'run-x', manifestHash: okFrozen.manifestHash });
    c.recordPublicationOutcome(okFile, 'conf-ok', 'success');
    assert.throws(() => c.recordExplicitPlatformFailure(okFile, okFrozen, r42Proof(okFrozen, { failingId: R42_NEW_IDS[29] })), /not dispatched\/unknown/);
    // an unknown original without any final confirmation is refused
    const noFinal = path.join(dir, 'nofinal.json');
    const nf = r42Frozen(2, R42_OLD_IDS, 'conf-nf', 'run-x');
    c.consumePublicationOnce(noFinal, 2, 'conf-nf', { businessDate: R42_TODAY, runId: 'run-x', manifestHash: nf.manifestHash });
    c.recordPublicationOutcome(noFinal, 'conf-nf', 'unknown');
    assert.throws(() => c.recordExplicitPlatformFailure(noFinal, nf, r42Proof(nf)), /final confirmation/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R42 retry consumption: exact 29+1 swap with a NEW hash is consumed ONCE; every drift is zero-consumption', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r42-retry-'));
  const file = path.join(dir, 'attempts.json');
  try {
    const oldFrozen = r42Frozen(2, R42_OLD_IDS, 'conf-old', 'run-x');
    r42Seed(file, oldFrozen);
    c.recordExplicitPlatformFailure(file, oldFrozen, r42Proof(oldFrozen));
    const newFrozen = r42Frozen(2, R42_NEW_IDS, 'conf-new', 'run-x');
    const scope = r42RetryScope(newFrozen);
    assert.throws(() => c.consumePublicationOnce(file, 2, 'conf-old', scope), /already consumed/);
    assert.throws(() => c.consumePublicationOnce(file, 2, 'conf-x', { ...scope, manifestHash: oldFrozen.manifestHash }), /NEW manifest hash/);
    assert.throws(() => c.consumePublicationOnce(file, 2, 'conf-run', { ...scope, runId: 'run-other' }), /scope mismatch/);
    assert.throws(() => c.consumePublicationOnce(file, 2, 'conf-date', { ...scope, businessDate: '2026-10-10' }), /scope mismatch/);
    assert.throws(() => c.consumePublicationOnce(file, 2, 'conf-acct', { ...scope, accountId: '9999999999999999' }), /account/);
    const badKeep = R42_OLD_IDS.slice(); badKeep[0] = R42_REPLACEMENT_ID; // keeps the failed id -> removes the wrong id
    assert.throws(() => c.consumePublicationOnce(file, 2, 'conf-keep', { ...scope, productIds: badKeep }), /drop exactly/);
    const twoSwap = R42_OLD_IDS.slice(0, 28).concat([R42_REPLACEMENT_ID, '71234567890123458888']);
    assert.throws(() => c.consumePublicationOnce(file, 2, 'conf-two', { ...scope, productIds: twoSwap }), /drop exactly/);
    // a retry-of-a-retry is refused (the new record is not itself a failed original)
    // first, block on another in-flight unknown, then clear it
    c.consumePublicationOnce(file, 3, 'conf-other', { businessDate: R42_TODAY, runId: 'run-x', manifestHash: 'e'.repeat(64) });
    c.recordPublicationOutcome(file, 'conf-other', 'unknown');
    assert.throws(() => c.consumePublicationOnce(file, 2, 'conf-new', scope), /in-flight/);
    c.recordPublicationOutcome(file, 'conf-other', 'success');
    const st = c.consumePublicationOnce(file, 2, 'conf-new', scope);
    assert.equal(st.consumed['conf-new'].status, 'pending');
    assert.equal(st.consumed['conf-new'].retryOfConfirmationId, 'conf-old');
    assert.equal(st.consumed['conf-old'].retryConfirmationId, 'conf-new', 'original bound to its single retry in the same write');
    assert.equal(st.consumed['conf-old'].status, 'failed', 'the failed original is preserved, never cleared');
    // a second new confirmation for the same original is refused
    const new2 = r42Frozen(2, R42_NEW_IDS, 'conf-new2', 'run-x');
    assert.throws(() => c.consumePublicationOnce(file, 2, 'conf-new2', { ...scope, manifestHash: new2.manifestHash }), /already retried|in-flight/);
    // retrying the retry record itself is refused (no failure chain)
    c.recordPublicationOutcome(file, 'conf-new', 'dispatched');
    assert.throws(() => c.consumePublicationOnce(file, 2, 'conf-chain', { ...scope, retryOfConfirmationId: 'conf-new', manifestHash: 'f'.repeat(64) }), /lacks a trusted explicit/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R42 runPublishPlan retry: a valid new-frozen DOM clicks EXACTLY once and binds the retry', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r42-run-'));
  const file = path.join(dir, 'attempts.json');
  try {
    const oldFrozen = r42Frozen(2, R42_OLD_IDS, 'conf-old', 'run-x');
    r42Seed(file, oldFrozen);
    c.recordExplicitPlatformFailure(file, oldFrozen, r42Proof(oldFrozen));
    const newFrozen = r42Frozen(2, R42_NEW_IDS, 'conf-new', 'run-x');
    const p = r42CreationPage(R42_NEW_IDS);
    const obs = p.run(c.pageObserve);
    const btn = publishBtnOf(p);
    const cmd = pubCmd(obs, { planNumber: 2, productIds: R42_NEW_IDS, auth: { confirmationId: 'conf-new', retryOfConfirmationId: 'conf-old', manifestHash: newFrozen.manifestHash, businessDate: R42_TODAY } });
    const r = await c.runPublishPlan(cmd, hostDeps(p, obs, { attemptsFile: file, approvedFirstPlan: R42_APPROVED_FIRST }));
    assert.equal(r.clicked, true);
    assert.equal(r.retryOfConfirmationId, 'conf-old');
    assert.equal(btn.__clicked, 1, 'exactly one retry dispatch');
    const store = c.loadAttemptsStore(file);
    assert.equal(store.consumed['conf-new'].status, 'dispatched');
    assert.equal(store.consumed['conf-old'].status, 'failed');
    assert.equal(store.consumed['conf-old'].retryConfirmationId, 'conf-new');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R42 runPublishPlan retry: a durable-write failure after entitlement means ZERO clicks', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r42-runfail-'));
  const file = path.join(dir, 'attempts.json');
  try {
    const oldFrozen = r42Frozen(2, R42_OLD_IDS, 'conf-old', 'run-x');
    r42Seed(file, oldFrozen);
    c.recordExplicitPlatformFailure(file, oldFrozen, r42Proof(oldFrozen));
    const newFrozen = r42Frozen(2, R42_NEW_IDS, 'conf-new', 'run-x');
    fs.mkdirSync(file + '.tmp'); // force the retry persist to fail
    const p = r42CreationPage(R42_NEW_IDS);
    const obs = p.run(c.pageObserve);
    const btn = publishBtnOf(p);
    const cmd = pubCmd(obs, { planNumber: 2, productIds: R42_NEW_IDS, auth: { confirmationId: 'conf-new', retryOfConfirmationId: 'conf-old', manifestHash: newFrozen.manifestHash, businessDate: R42_TODAY } });
    await assert.rejects(c.runPublishPlan(cmd, hostDeps(p, obs, { attemptsFile: file, approvedFirstPlan: R42_APPROVED_FIRST })));
    assert.equal(btn.__clicked, 0, 'no dispatch without a durable retry reservation');
    assert.equal(c.loadAttemptsStore(file).consumed['conf-old'].retryConfirmationId, undefined);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('R42 helper publishExplicitFailureReplacementOnly: leaves the failure trace then drives the retry through wf', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r42-helper-'));
  const file = path.join(dir, 'attempts.json');
  try {
    const oldFrozen = r42Frozen(2, R42_OLD_IDS, 'conf-old', 'run-x');
    r42Seed(file, oldFrozen);
    const newFrozen = r42Frozen(2, R42_NEW_IDS, 'conf-new', 'run-x');
    const p = r42CreationPage(R42_NEW_IDS);
    const obs = p.run(c.pageObserve);
    const btn = publishBtnOf(p);
    const result = await r42.publishExplicitFailureReplacementOnly({
      attemptsFile: file, oldFrozen, newFrozen, trustedFailureProof: r42Proof(oldFrozen),
      humanRequest: { method: 'POST', action: '确认发布本计划', nonce: newFrozen.nonce, planNumber: 2, manifestHash: newFrozen.manifestHash, businessDate: R42_TODAY, acceptedDisclosures: true },
      observe: async () => obs,
      publishDeps: { attemptsFile: file, evaluate: (fn, arg) => Promise.resolve(p.runWith(fn, arg)), onEvent: () => {} },
      approvedFirstPlan: R42_APPROVED_FIRST,
      readFinalDialog: async () => ({ visible: false }),
      nowMs: () => Date.now(),
    });
    assert.equal(result.retryOfConfirmationId, 'conf-old');
    assert.equal(result.failedProductId, R42_FAIL_ID);
    assert.equal(result.status, 'stopped', 'no known final dialog after the retry dispatch -> honest stop');
    assert.equal(btn.__clicked, 1, 'the helper drives exactly one real retry dispatch');
    const store = c.loadAttemptsStore(file);
    assert.equal(store.consumed['conf-old'].status, 'failed');
    assert.equal(store.consumed['conf-new'].retryOfConfirmationId, 'conf-old');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
