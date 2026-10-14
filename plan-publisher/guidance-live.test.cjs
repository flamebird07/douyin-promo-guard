'use strict';

// S48 offline guidance diagnostics. Exercises the ACTUAL exported modules
// (run-plans.cjs guidanceActionInPage + createRealDrivers.openCreationPage and
// direct-draft-controller.cjs pageObserve) against a minimal in-process fake
// DOM + fake location/page. No network, no browser, no CDP, no real config,
// no main(). Only command: node --test guidance-live.test.cjs
//
// Purpose: the 2026-10-14 production stops carried the bare reason
// 'guidance-page-not-authorized' with zero evidence about WHICH strict check
// (origin / creation route / aavid count / aavid mismatch) fired. These tests
// pin (a) the real openCreationPage lifecycle ordering — goto, navigator-DOM
// identity wait, THEN the guidance URL gate — and (b) the refusal diagnostics
// for foreign origin, manager-page route, wrong/duplicate/missing aavid, while
// asserting the diagnostic never leaks the raw URL, other query parameters or
// cookies.

const test = require('node:test');
const assert = require('node:assert');
const rp = require('./run-plans.cjs');
const guard = require('./direct-draft-controller.cjs');

const ACCOUNT = '2800000000000001'; // synthetic 16-digit id, never a production account
const OTHER_ACCOUNT = '2800000000000002';
const ORIGIN = 'https://qianchuan.jinritemai.com';
const CREATION_PATH = '/uni-creation/overall-product-multi';

// ── minimal fake DOM ─────────────────────────────────────────────────────────
function makeNode(tag, opts = {}) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: opts.cls || '',
    attrs: opts.attrs || {},
    children: [],
    parentElement: null,
    innerText: opts.text || '',
    textContent: opts.text || '',
    value: opts.value === undefined ? '' : opts.value,
    checked: opts.checked === undefined ? false : opts.checked,
    disabled: opts.disabled === true,
    shadowRoot: opts.shadowRoot || null,
    clicks: 0,
  };
  node.getAttribute = name => (name === 'class' ? String(node.className || '') : (Object.prototype.hasOwnProperty.call(node.attrs, name) ? String(node.attrs[name]) : null));
  node.getBoundingClientRect = () => ({ x: 1, y: 1, width: 10, height: 10 });
  node.querySelectorAll = sel => descendants(node).filter(d => selectorMatches(d, sel));
  node.contains = x => { for (let n = x; n; n = n.parentElement) if (n === node) return true; return false; };
  node.closest = sel => { for (let n = node; n; n = n.parentElement) if (selectorMatches(n, sel)) return n; return null; };
  node.click = () => { node.clicks += 1; };
  return node;
}
function attach(parent, ...children) {
  for (const child of children) { child.parentElement = parent; parent.children.push(child); }
  return parent;
}
function descendants(node) {
  const out = [];
  const walk = n => { for (const c of n.children) { out.push(c); walk(c); } };
  walk(node);
  return out;
}
// Simple-selector matcher: comma lists of tag / .class / [attr] / [attr=v] /
// [attr*=v] with no combinators — the exact shapes pageObserve and the guidance
// callbacks use.
function selectorMatches(node, rawSel) {
  return String(rawSel).split(',').some(part => {
    const sel = part.trim();
    if (!sel) return false;
    const m = /^([a-zA-Z][\w-]*)?((?:\.[\w-]+|\[[^\]]+\])*)$/.exec(sel);
    if (!m) return false;
    if (m[1] && node.tagName !== m[1].toUpperCase()) return false;
    const rest = m[2] || '';
    const re = /\.[\w-]+|\[([^\]~^$*|=]+)(?:([~^$*]?=)("([^"]*)"|'([^']*)'|[^\]]+))?\]/g;
    let t;
    while ((t = re.exec(rest))) {
      if (t[0].startsWith('.')) {
        if (!String(node.className || '').split(/\s+/).includes(t[0].slice(1))) return false;
      } else {
        const attr = t[1];
        const actual = attr === 'class' ? String(node.className || '') : node.getAttribute(attr);
        if (actual == null) return false;
        if (t[2]) {
          const expected = String(t[3] != null ? (t[4] != null ? t[4] : t[5] != null ? t[5] : t[3]) : '').replace(/^['"]|['"]$/g, '');
          if (t[2] === '=') { if (actual !== expected) return false; }
          else if (t[2] === '*=') { if (!actual.includes(expected)) return false; }
          else return false;
        }
      }
    }
    return true;
  });
}

// Mutable fake page state: `location` and the `document.body` tree are swapped
// per scenario, then the REAL in-page callbacks run against them.
const location = { origin: '', pathname: '', search: '' };
const windowStub = {};
const documentStub = {
  get body() { return bodyEl; },
  querySelectorAll: sel => descendants(bodyEl).filter(d => selectorMatches(d, sel)),
};
let bodyEl = makeNode('body');
globalThis.location = location;
globalThis.window = windowStub;
globalThis.document = documentStub;
globalThis.getComputedStyle = () => ({ visibility: 'visible' });

function landPage(url, body) {
  const u = new URL(url);
  location.origin = u.origin;
  location.pathname = u.pathname;
  location.search = u.search;
  bodyEl = makeNode('body', { text: body && body.bodyText ? body.bodyText : '' });
  if (body && body.bodyChildren) attach(bodyEl, ...body.bodyChildren);
}
function evalInPage(fn, arg) { return fn(arg); }

// The creation-page DOM identity openCreationPage waits for: a navigator
// header carrying the account id, plus a checked 含达人佣金 checkbox.
function creationBodyChildren(account) {
  const nav = makeNode('div', { cls: 'qc-page-navigator-container', text: '巨量千川 ID：' + account });
  const commission = attach(makeNode('div', { text: '含达人佣金' }), makeNode('input', { attrs: { type: 'checkbox' }, checked: true }));
  return [nav, commission];
}

function creationUrl(aavid) { return ORIGIN + CREATION_PATH + (aavid != null ? '?aavid=' + aavid : ''); }

function makeDriver(url) {
  const fakePage = { url, async goto(target) { this.url = target; landPage(target, { bodyChildren: creationBodyChildren(ACCOUNT) }); }, evaluate: (fn, arg) => evalInPage(fn, arg) };
  const context = { newPage: async () => fakePage };
  return rp.createRealDrivers({
    page: null, managerPage: fakePage, context,
    dayState: { attempted: [], hints: {} },
    persist: async () => {},
    publishedIds: new Set(), attemptedSet: new Set(), hints: {},
    accountId: ACCOUNT,
    business: { accountId: ACCOUNT, roi: 15, dailyBudget: 300, productsPerPlan: 30, creationUrl: url },
    creationUrl: url, legacyBusiness: false,
    opened: {}, projectRoot: __dirname, planNumber: 1, runId: 'plan-scheduler-2026-10-14-test00000000000',
  });
}

// ── 1. real openCreationPage lifecycle: goto -> DOM identity wait -> guidance gate ──

test('GL1 correct lifecycle: authorized origin/path/aavid passes the gate with zero guidance clicks', async () => {
  const url = creationUrl(ACCOUNT) + '&token=SECRETVALUE';
  const driver = makeDriver(url);
  const result = await driver.openCreationPage();
  assert.strictEqual(result.header.originOk, true);
  assert.strictEqual(result.header.accountId, ACCOUNT);
  assert.strictEqual(result.header.commissionOptionPresent, true);
  assert.strictEqual(result.guidance.handled, 0);
});

test('GL2 wrong aavid: DOM identity passes but the guidance gate refuses with a desensitized diagnostic', async () => {
  const url = creationUrl(OTHER_ACCOUNT) + '&token=SECRETVALUE';
  const driver = makeDriver(url);
  await assert.rejects(
    () => driver.openCreationPage(),
    err => {
      assert.match(err.message, /^guidance-page-not-authorized\[origin=https:\/\/qianchuan\.jinritemai\.com,pathOk=true,aavidCount=1,aavidMatch=false,expectedAccount=2800000000000001\]$/);
      assert.ok(!err.message.includes('SECRETVALUE'), 'raw other query parameter leaked');
      assert.ok(!err.message.includes('?'), 'raw query string leaked');
      return true;
    },
  );
});

test('GL3 foreign origin refuses with origin diagnostic', async () => {
  const driver = makeDriver('https://foreign.example.com' + CREATION_PATH + '?aavid=' + ACCOUNT);
  await assert.rejects(
    () => driver.openCreationPage(),
    err => { assert.match(err.message, /guidance-page-not-authorized\[origin=https:\/\/foreign\.example\.com,pathOk=true,aavidCount=1,aavidMatch=true,/); return true; },
  );
});

test('GL4 manager-page route (/overall-prom) refuses with pathOk=false', async () => {
  const driver = makeDriver(ORIGIN + '/overall-prom?aavid=' + ACCOUNT + '&campaignType=1');
  await assert.rejects(
    () => driver.openCreationPage(),
    err => { assert.match(err.message, /guidance-page-not-authorized\[origin=https:\/\/qianchuan\.jinritemai\.com,pathOk=false,aavidCount=1,aavidMatch=true,/); return true; },
  );
});

test('GL5 duplicate aavid refuses with aavidCount=2 (no substring/prefix acceptance)', async () => {
  const driver = makeDriver(creationUrl(ACCOUNT) + '&aavid=' + OTHER_ACCOUNT);
  await assert.rejects(
    () => driver.openCreationPage(),
    err => { assert.match(err.message, /guidance-page-not-authorized\[.*aavidCount=2,aavidMatch=false,expectedAccount=2800000000000001\]/); return true; },
  );
});

test('GL6 missing aavid refuses with aavidCount=0', async () => {
  const driver = makeDriver(ORIGIN + CREATION_PATH);
  await assert.rejects(
    () => driver.openCreationPage(),
    err => { assert.match(err.message, /guidance-page-not-authorized\[.*aavidCount=0,aavidMatch=false,/); return true; },
  );
});

// ── 2. guidanceActionInPage unit semantics on the authorized page ────────────

test('GL7 authorized empty page: snapshot honestly reports no guidance', () => {
  landPage(creationUrl(ACCOUNT), { bodyChildren: creationBodyChildren(ACCOUNT) });
  const snap = evalInPage(rp.guidanceActionInPage, { mode: 'snapshot', accountId: ACCOUNT });
  assert.deepStrictEqual(snap, { present: false, unknown: null, roots: [] });
});

test('GL8 c-lib mask lifecycle: snapshot present, one bound step clicks exactly once', () => {
  landPage(creationUrl(ACCOUNT), {});
  const button = makeNode('span', { cls: 'c-lib-guide-button', text: '我知道了' });
  attach(bodyEl, attach(makeNode('div', { cls: 'c-lib-guide-mask', text: '新手引导 我知道了' }), button));
  const snap = evalInPage(rp.guidanceActionInPage, { mode: 'snapshot', accountId: ACCOUNT });
  assert.strictEqual(snap.present, true);
  assert.strictEqual(snap.roots.length, 1);
  assert.strictEqual(snap.roots[0].kind, 'clib');
  assert.strictEqual(snap.roots[0].label, '我知道了');
  assert.strictEqual(snap.roots[0].disabled, false);
  const step = evalInPage(rp.guidanceActionInPage, { mode: 'step', accountId: ACCOUNT, order: 0, kind: 'clib', content: '新手引导 我知道了', label: '我知道了' });
  assert.strictEqual(step.clicked, true);
  assert.strictEqual(button.clicks, 1);
});

test('GL9 firefly open-ShadowRoot popper: recognized and clickable; foreign origin still refused', () => {
  const next = makeNode('div', { cls: 'firefly-content__button firefly-content__next-step-button', text: '下一步' });
  const popper = attach(makeNode('div', { cls: 'firefly-popper-content', text: '引导说明 下一步' }), next);
  const shadowHostLike = { querySelectorAll: sel => [popper, ...descendants(popper)].filter(d => selectorMatches(d, sel)) };
  const host = makeNode('firefly-content', { shadowRoot: shadowHostLike });
  landPage(creationUrl(ACCOUNT), {});
  attach(bodyEl, host);
  const snap = evalInPage(rp.guidanceActionInPage, { mode: 'snapshot', accountId: ACCOUNT });
  assert.strictEqual(snap.present, true);
  assert.strictEqual(snap.roots[0].kind, 'firefly');
  const step = evalInPage(rp.guidanceActionInPage, { mode: 'step', accountId: ACCOUNT, order: 0, kind: 'firefly', content: '引导说明 下一步', label: '下一步' });
  assert.strictEqual(step.clicked, true);
  assert.strictEqual(next.clicks, 1);
  // Same shape on a foreign origin must refuse before any root inspection.
  const savedOrigin = location.origin;
  location.origin = 'https://foreign.example.com';
  assert.throws(() => evalInPage(rp.guidanceActionInPage, { mode: 'snapshot', accountId: ACCOUNT }), /guidance-page-not-authorized\[origin=https:\/\/foreign\.example\.com,/);
  location.origin = savedOrigin;
});

test('GL10 duplicate c-lib masks stay unknown (never click an ambiguous overlay)', () => {
  landPage(creationUrl(ACCOUNT), {});
  const mk = () => attach(makeNode('div', { cls: 'c-lib-guide-mask', text: '引导 我知道了' }), makeNode('span', { cls: 'c-lib-guide-button', text: '我知道了' }));
  attach(bodyEl, mk(), mk());
  const snap = evalInPage(rp.guidanceActionInPage, { mode: 'snapshot', accountId: ACCOUNT });
  assert.strictEqual(snap.unknown, 'guidance-root-duplicate');
  assert.throws(() => evalInPage(rp.guidanceActionInPage, { mode: 'step', accountId: ACCOUNT, order: 0, kind: 'clib', content: '引导 我知道了', label: '我知道了' }), /guidance-root-duplicate/);
});

test('GL11 disabled guidance button is reported and never clicked in step mode', () => {
  landPage(creationUrl(ACCOUNT), {});
  const button = makeNode('span', { cls: 'c-lib-guide-button', text: '下一步', disabled: true });
  attach(bodyEl, attach(makeNode('div', { cls: 'c-lib-guide-mask', text: '引导 下一步' }), button));
  const snap = evalInPage(rp.guidanceActionInPage, { mode: 'snapshot', accountId: ACCOUNT });
  assert.strictEqual(snap.present, true);
  assert.strictEqual(snap.roots[0].disabled, true);
  assert.throws(() => evalInPage(rp.guidanceActionInPage, { mode: 'step', accountId: ACCOUNT, order: 0, kind: 'clib', content: '引导 下一步', label: '下一步' }), /guidance-button-disabled/);
  assert.strictEqual(button.clicks, 0);
});
