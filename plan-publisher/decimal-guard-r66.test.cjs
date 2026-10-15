'use strict';
// decimal-guard-r66 offline guard tests. No network, no browser, no real config.
// Run: node --test decimal-guard-r66.test.cjs
// Exercises the REAL exported samePositiveDecimalValue, the REAL host
// validatePublishAuthorization gate, and the REAL serialized publishApply source
// through the same in-workspace DOM/vm harness pattern used by
// direct-draft-controller.test.cjs (copied read-only; that file is not modified).
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const c = require('./direct-draft-controller.cjs');

// ---------- minimal DOM harness (same pattern as the existing test file) ----------
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
  if (opts.role) el.attrs.role = opts.role;
  if (opts.type) el.attrs.type = opts.type;
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
    Date: { now() { return ++clock; } },
    console: { log() {} },
  };
  const context = vm.createContext(ctx);
  windowObj.document = doc; windowObj.location = loc;
  return {
    context, windowObj, doc, body,
    run(fn) { return vm.runInContext('(' + fn.toString() + ').call(window)', context); },
    runWith(fn, arg) {
      context.__arg = arg;
      return vm.runInContext('window.__r=((' + fn.toString() + ').call(window, __arg))', context);
    },
  };
}

// ---------- creation-page fixture (same pattern as the existing test file) ----------
const APPROVED_IDS = Array.from({ length: 30 }, (_, i) => '7123456789012345' + String(1000 + i));
const APPROVED_FIRST_PLAN = { account_id: '1710242295996424', product_ids: APPROVED_IDS.slice() };
const PLAN_NAME = '2026-10-08_千川乘方_17:34:05';

function creationFixture(o = {}) {
  const count = o.count == null ? 30 : o.count;
  const kids = [];
  if (!o.noNavigator) kids.push(El('div', { class: 'qc-page-navigator-container', rect: [900, 40], text: '千川 乘方 ID：1710242295996424 伊人美' }));
  else kids.push(El('div', { rect: [400, 30], text: '伊人美 ID：1710242295996424' }));
  const rowOf = i => El('tr', { rect: [600, 40] }, [
    El('td', { rect: [500, 30], text: '商品' + i + ' 店铺新品 ID：' + APPROVED_IDS[i] + (o.dupId && i === 0 ? ' ID：' + APPROVED_IDS[1] : '') }),
    El('td', { rect: [140, 30], text: (o.manual == null ? 2 : o.manual) + '个抖音号 管理手动添加抖音号 预估自动拉取 0 个' }),
  ]);
  kids.push(El('table', { class: 'ovui-table', rect: [900, 640] }, [
    El('tr', { rect: [900, 30] }, [
      El('th', { rect: [220, 20], text: '商品信息' }),
      El('th', { rect: [160, 20], text: '投放抖音号' }),
      El('th', { rect: [160, 20], text: '素材（默认启用智能优选，推荐同步添加自选素材）' }),
      El('th', { rect: [80, 20], text: '操作' }),
    ]),
    ...Array.from({ length: count }, (_, i) => rowOf(i)),
  ]));
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
  if (o.dialog) kids.push(El('div', { class: 'ovui-modal', rect: [300, 200], attrs: { 'aria-modal': 'true' } }));
  return kids;
}
function makeCreationPage(o, pathname) {
  return makePage(creationFixture(o || {}), pathname || '/uni-creation/overall-product-multi', 'https://qianchuan.jinritemai.com');
}
function publishBtnOf(p) { return p.body.querySelectorAll('button').filter(b => b.__text === '发布计划')[0]; }
function baseAuth(obs, o = {}) {
  return Object.assign({
    runId: 'run-x', observation: obs.observation, accountId: '1710242295996424',
    productIds: APPROVED_IDS.slice(), roi: 15, dailyBudget: 300, commissionIncluded: true,
    boundAccounts: ['79863866', '9zmao_fushi'], businessDate: '2026-10-09', manifestHash: 'a'.repeat(64),
    planName: PLAN_NAME, confirmationId: 'conf-1',
  }, o.auth || {});
}
function pubCmd(obs, o = {}) {
  return { op: 'publish-plan', planNumber: o.planNumber != null ? o.planNumber : 1, authorization: baseAuth(obs, o) };
}
// drives the REAL serialized publishApply through the vm (fn.toString() path,
// exactly like Playwright serializing the callback into the page)
function runPublish(p, obs, o = {}) {
  const a = baseAuth(obs, o);
  const cmd = { observation: a.observation, planNumber: o.planNumber != null ? o.planNumber : 1, accountId: a.accountId, productIds: a.productIds, planName: a.planName };
  if (o.roi !== undefined) cmd.roi = o.roi;
  if (o.budget !== undefined) cmd.budget = o.budget;
  return p.runWith(c.publishApply, cmd);
}
function throwsMessage(fn) {
  try { fn(); return null; } catch (e) { return String((e && e.message) || e); }
}

// ---------- 1. exported helper matrix ----------
const ACCEPT_PAIRS = [
  ['15', 15], ['15.00', 15], [15, '15.00'], ['15.0', '15'], ['15', '15.000'],
  ['13.5', '13.50'], [13.5, 13.5], ['300', '300.00'], [300, '300.00'],
  ['450', '450.0'], ['0.1', '0.10'], [0.1, '0.10'], ['007.50', '7.5'],
  [' 15.00 ', 15], ['1', '1.0'], [0.5, '.5'.replace('.', '0.')],
];
const REJECT_PAIRS = [
  ['15.00000000000000001', '15'], ['14.99', '15'], ['15.01', 15], ['300.01', 300],
  ['0', '0'], ['0.00', 0], ['-15', '-15'], [-15, -15], ['-15.00', '15'], ['15', '-15'],
  ['', ''], ['   ', '15'], [null, null], [undefined, undefined], [true, true], [false, false],
  [{}, {}], [[], []], [[15], 15], [NaN, NaN], [Infinity, Infinity], [-Infinity, '-15'],
  ['15e0', '15'], ['15E1', '150'], ['0x15', '21'], ['15.00元', '15'], ['¥15', '15'],
  ['1,500', '1500'], ['15.00a', '15'], ['15..0', '15'], ['.', '.'], ['15.', '15'],
  ['1/5', '0.2'], [() => 15, 15], [Symbol.iterator, Symbol.iterator],
  ['9'.repeat(129), '9'.repeat(129)],
];
test('samePositiveDecimalValue accepts only exact base-10 digit equivalence (15/15.00, 13.5/13.50, 300/300.00, 450/450.0, 0.1/0.10)', () => {
  for (const [a, b] of ACCEPT_PAIRS) assert.equal(c.samePositiveDecimalValue(a, b), true, `${String(a)} vs ${String(b)} must be equal`);
});
test('samePositiveDecimalValue rejects different digits, zero/negative, blanks, null/bool/object, NaN/Infinity, exponents, hex, units, commas, junk, over-length', () => {
  for (const [a, b] of REJECT_PAIRS) assert.equal(c.samePositiveDecimalValue(a, b), false, `${String(a)} vs ${String(b)} must not be equal`);
});
test('samePositiveDecimalValue length bound: 128 digits pass, 129 fail; never rounds like Number()', () => {
  assert.equal(c.samePositiveDecimalValue('9'.repeat(128), '9'.repeat(128)), true);
  assert.equal(c.samePositiveDecimalValue('15.00000000000000001', '15.00000000000000001'), true); // identical digits still equal
  assert.equal(Number('15.00000000000000001') === 15, true, 'baseline: float rounding WOULD wrongly pass -- the string path must not');
});

// ---------- 2. host validatePublishAuthorization gate ----------
test('validatePublishAuthorization passes the real readback shape: DOM roi 15.00 / budget 300 vs authorized 15 / 300', () => {
  const p = makeCreationPage({ roi: '15.00', budget: '300' });
  const obs = p.run(c.pageObserve);
  assert.equal(obs.creation.roi, '15.00');
  const ok = c.validatePublishAuthorization(pubCmd(obs), obs, '1710242295996424', 'run-x', APPROVED_FIRST_PLAN);
  assert.equal(ok.roi, 15);
  assert.equal(ok.dailyBudget, 300);
});
test('validatePublishAuthorization also passes formatted budget 300.00 and refuses every digit-invalid/unknown/foreign roi/budget', () => {
  const passCases = [{ roi: '15.00', budget: '300.00' }, { roi: '15.0', budget: '0300' }, { roi: '015', budget: '300' }];
  for (const pageOpts of passCases) {
    const p = makeCreationPage(pageOpts);
    const obs = p.run(c.pageObserve);
    const ok = c.validatePublishAuthorization(pubCmd(obs), obs, '1710242295996424', 'run-x', APPROVED_FIRST_PLAN);
    assert.equal(ok.roi, 15, JSON.stringify(pageOpts) + ' must pass');
  }
  const failCases = [
    { roi: '14.99', budget: '300' }, { roi: '15.00000000000000001', budget: '300' },
    { roi: '15', budget: '301' }, { roi: '15', budget: '300.01' },
    { roi: '15e0', budget: '300' }, { roi: '15.00元', budget: '300' },
    { roi: '', budget: '300' }, { roi: '15', budget: '' }, { roi: '-15', budget: '300' },
  ];
  for (const pageOpts of failCases) {
    const p = makeCreationPage(pageOpts);
    const obs = p.run(c.pageObserve);
    assert.throws(() => c.validatePublishAuthorization(pubCmd(obs), obs, '1710242295996424', 'run-x', APPROVED_FIRST_PLAN), /ROI\/budget values mismatch/, JSON.stringify(pageOpts) + ' must be refused');
  }
});
test('validatePublishAuthorization authorization-object contract unchanged: roi 16 vs configured 15 still refused, formatted DOM cannot bypass unknown commission', () => {
  const p = makeCreationPage({ roi: '15.00' });
  const obs = p.run(c.pageObserve);
  assert.throws(() => c.validatePublishAuthorization(pubCmd(obs, { auth: { roi: 16 } }), obs, '1710242295996424', 'run-x', APPROVED_FIRST_PLAN), /roi/);
  const p2 = makeCreationPage({ roi: '15.00', commissionChecked: null });
  const obs2 = p2.run(c.pageObserve);
  assert.throws(() => c.validatePublishAuthorization(pubCmd(obs2), obs2, '1710242295996424', 'run-x', APPROVED_FIRST_PLAN), /commission/);
});

// ---------- 3. REAL serialized publishApply through vm ----------
test('serialized publishApply clicks exactly once with the readback formatting (roi 15.00) on a valid full 30-row DOM', () => {
  const p = makeCreationPage({ roi: '15.00' });
  const obs = p.run(c.pageObserve);
  const btn = publishBtnOf(p);
  const r = runPublish(p, obs);
  assert.equal(r.clicked, true);
  assert.equal(r.published, 'unverified');
  assert.equal(btn.__clicked, 1, 'exactly one click with formatted ROI');
});
test('serialized publishApply honors explicit authorized roi/budget numbers against formatted DOM values', () => {
  const p = makeCreationPage({ roi: '15.00', budget: '300.00' });
  const obs = p.run(c.pageObserve);
  const btn = publishBtnOf(p);
  const r = runPublish(p, obs, { roi: 15, budget: 300 });
  assert.equal(r.clicked, true);
  assert.equal(btn.__clicked, 1);
});
test('serialized publishApply zero clicks: different digits, rounding trap, malformed roi/budget, foreign account, dup ids, commission, dialog, name', () => {
  const badPages = [
    ['roi 14.99', { roi: '14.99' }, undefined],
    ['roi 15.00000000000000001 (float-equal trap)', { roi: '15.00000000000000001' }, undefined],
    ['budget 301', { budget: '301' }, undefined],
    ['budget 300.01', { budget: '300.01' }, undefined],
    ['roi 15e0', { roi: '15e0' }, undefined],
    ['roi with unit', { roi: '15.00元' }, undefined],
    ['roi blank', { roi: '' }, undefined],
    ['explicit cmd.roi 15 vs DOM 14.99', { roi: '14.99' }, { roi: 15 }],
    ['cmd.roi as malformed string', { roi: '15' }, { roi: '15e0' }],
    ['foreign account (no navigator header)', { noNavigator: true }, undefined],
    ['duplicate ids in one row', { dupId: true }, undefined],
    ['commission unchecked', { commissionChecked: false }, undefined],
    ['commission unknown', { commissionChecked: null }, undefined],
    ['direct-pay checked', { directPayChecked: true }, undefined],
    ['visible dialog', { dialog: true }, undefined],
    ['29 rows', { count: 29 }, undefined],
    ['plan name drift', { planName: 'some other name' }, undefined],
  ];
  for (const [name, pageOpts, cmdOpts] of badPages) {
    const p = makeCreationPage(pageOpts);
    const obs = p.run(c.pageObserve);
    const btn = publishBtnOf(p);
    const msg = throwsMessage(() => runPublish(p, obs, cmdOpts || {}));
    assert.notEqual(msg, null, name + ' must throw');
    if (btn) assert.equal(btn.__clicked, 0, name + ' must produce zero clicks');
  }
});
test('parity: the REAL serialized publishApply and the exported host helper decide every roi shape identically', () => {
  const values = ['15', '15.00', '15.0', '015', ' 15.00 ', '14.99', '15.00000000000000001', '15e0', '0x15', '15.00元', '1,500', '', '   ', '-15', '15.', '300.00'];
  for (const value of values) {
    const expected = c.samePositiveDecimalValue(value, 15);
    const p = makeCreationPage({ roi: value });
    const obs = p.run(c.pageObserve);
    const btn = publishBtnOf(p);
    let clicked = false;
    try { runPublish(p, obs); clicked = true; } catch (e) { clicked = false; }
    assert.equal(clicked, expected, 'serialized publishApply vs helper on ' + JSON.stringify(value));
    assert.equal(btn.__clicked, expected ? 1 : 0, 'click count parity on ' + JSON.stringify(value));
  }
});
test('parity: budget gate decides identically to the exported helper (legacy default 300 semantics kept)', () => {
  for (const value of ['300', '300.00', '0300.0', '300.01', '450', '', '300元']) {
    const expected = c.samePositiveDecimalValue(value, 300);
    const p = makeCreationPage({ budget: value });
    const obs = p.run(c.pageObserve);
    const btn = publishBtnOf(p);
    let clicked = false;
    try { runPublish(p, obs); clicked = true; } catch (e) { clicked = false; }
    assert.equal(clicked, expected, 'budget parity on ' + JSON.stringify(value));
    assert.equal(btn.__clicked, expected ? 1 : 0);
  }
});
test('serialized publishApply stays self-contained: its source references no outer identifier (no eval/newFunction/injected globals)', () => {
  const src = c.publishApply.toString();
  assert.ok(!/\beval\b|new Function|samePositiveDecimalValue|canonicalizePositiveDecimal/.test(src), 'closure must be self-contained');
  assert.ok(/canonPosDec/.test(src), 'in-page comparator is inline in the serialized function');
});
