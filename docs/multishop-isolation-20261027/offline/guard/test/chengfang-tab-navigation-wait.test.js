'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const {
  openChengfangShop,
  dismissKnownChengfangOverlays,
  handleChengfangOverlayInPage,
  navigateChengfangPlanViewInPage,
  readChengfangAccountInPage,
} = require('../src/adapters/chengfang-reader');
const { makeClock } = require('./helpers');

const HOME = 'https://qianchuan.jinritemai.com/home';
const MANAGER = 'https://qianchuan.jinritemai.com/overall-prom';
const FOREIGN = 'https://foreign.example/overall-prom';
const LOGIN = 'https://qianchuan.jinritemai.com/login';
const UNSUPPORTED = 'https://qianchuan.jinritemai.com/loading';
const ACCOUNT_ID = '1234567890123456';

class FakeNode {
  constructor(tag = 'div', attrs = {}, text = '') {
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.className = attrs.class || '';
    this.ownText = text;
    this.children = [];
    this.parentNode = null;
    this.visible = true;
    this.clicked = 0;
  }
  get textContent() { return this.ownText + this.children.map(node => node.textContent).join(''); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  getBoundingClientRect() {
    for (let node = this; node; node = node.parentNode) {
      if (!node.visible) return { left: 0, top: 0, width: 0, height: 0 };
    }
    return { left: 20, top: 20, width: 120, height: 40 };
  }
  matches(selector) {
    return selector.split(',').some(part => {
      const compound = part.trim();
      const tag = /^([a-zA-Z][\w-]*)/.exec(compound);
      if (tag && this.tagName !== tag[1].toUpperCase()) return false;
      for (const cls of compound.match(/\.([\w-]+)/g) || []) {
        if (!this.className.split(/\s+/).includes(cls.slice(1))) return false;
      }
      for (const match of compound.matchAll(/\[([\w-]+)(?:([*]?=)"([^"]*)")?\]/g)) {
        const value = this.getAttribute(match[1]);
        if (value === null) return false;
        if (match[2] === '=' && value !== match[3]) return false;
        if (match[2] === '*=' && !value.includes(match[3])) return false;
      }
      return true;
    });
  }
  querySelectorAll(selector) {
    return this.children.flatMap(node => [
      ...(node.matches(selector) ? [node] : []), ...node.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  click() { this.clicked += 1; if (this.onClick) this.onClick(); }
}

function makeSession(t, options = {}) {
  const clock = makeClock(100000);
  t.mock.method(Date, 'now', clock.nowFn);
  const events = [];
  const body = new FakeNode('body');
  const document = {
    body,
    documentElement: new FakeNode('html'),
    querySelectorAll: selector => body.querySelectorAll(selector),
    querySelector: selector => body.querySelector(selector),
  };
  Object.defineProperty(document, 'cookie', { get() { assert.fail('Cookie access is forbidden'); } });
  let url = HOME;
  let tabStartedAt = null;
  let ready = false;
  let connected = true;
  let lastTrusted = null;
  const elapsed = () => tabStartedAt === null ? null : clock.now() - tabStartedAt;
  const record = (kind, extra = {}) => events.push({ kind, at: elapsed(), trusted: lastTrusted, ...extra });
  const menu = body.appendChild(new FakeNode('a', { 'data-e2e': 'navigatormenu_overall' }, '乘方'));
  menu.onClick = () => { record('home-nav'); url = MANAGER; };
  const product = body.appendChild(new FakeNode('div', { role: 'tab', 'aria-selected': 'false' }, '商品'));
  const plan = body.appendChild(new FakeNode('div', { role: 'tab', 'aria-selected': 'false' }, '计划视图'));
  for (const node of [product, plan]) {
    node.onClick = () => { record('tab-click'); node.attrs['aria-selected'] = 'true'; };
  }
  const business = body.appendChild(new FakeNode('button', {}, '去开启'));
  business.onClick = () => record('business-click');
  let modal = null;
  let close = null;
  if (options.overlay) {
    modal = body.appendChild(new FakeNode('div', options.overlay === 'unknown'
      ? { role: 'dialog', class: 'business-confirm' }
      : { class: 'ocean-vmok-plugin-oc-modal-wrap' },
    options.overlay === 'danger' ? '确认删除这 30 条计划？删除后不可恢复' : '介绍'));
    modal.visible = false;
    close = modal.appendChild(new FakeNode('span', { class: 'tools-vmok-plugin-modal__close-icon' }));
    close.onClick = () => { record('overlay-close'); modal.visible = false; };
  }
  let modalShown = false;
  const page = new EventEmitter();
  page.url = () => url;
  page.isClosed = () => !connected;
  page.waitForTimeout = async ms => {
    assert.ok(Number.isFinite(ms) && ms >= 0);
    record('wait', { ms });
    clock.advance(ms);
  };
  page.waitForFunction = async () => { assert.equal(url, MANAGER); };
  page.evaluate = async (fn, arg) => {
    if (fn.name === 'probeQianchuanHeaderIdentityInPage') {
      return { unique: true, loginVisible: false, accountId: ACCOUNT_ID };
    }
    if (fn === readChengfangAccountInPage) {
      record('read-account');
      if (tabStartedAt === null) {
        assert.equal(url, MANAGER);
        tabStartedAt = clock.now();
        // The route snapshot precedes the next probe's late navigation.
        return { url, hasSubTabs: options.readOnlyStatus === true, accountId: ACCOUNT_ID };
      }
      ready = plan.getAttribute('aria-selected') === 'true' && options.tabsNeverReady !== true;
      return { url, hasSubTabs: ready, accountId: ACCOUNT_ID };
    }
    if (fn === handleChengfangOverlayInPage && tabStartedAt !== null) {
      url = ready && options.readyUrl ? options.readyUrl
        : options.urlAt ? options.urlAt(elapsed()) : MANAGER;
      if (modal && !modalShown) { modal.visible = true; modalShown = true; }
    }
    if (fn === navigateChengfangPlanViewInPage) record('navigate');
    const result = vm.runInNewContext(`(${fn.toString()})(${JSON.stringify(arg) || 'undefined'})`, {
      document, location: { href: url }, URL,
      getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    });
    if (fn === handleChengfangOverlayInPage) {
      lastTrusted = result.trusted;
      record('probe', { click: arg.click, state: result.state, blockers: Array.from(result.blockers) });
    }
    return result;
  };
  const browser = {
    isConnected: () => connected,
    async close() { record('browser-close'); connected = false; },
  };
  const context = {};
  const checkpoint = { saved: false, skipped: true, reason: 'injected-no-write' };
  const open = () => openChengfangShop({
    shopCfg: { id: 'tab-wait-test', accountId: ACCOUNT_ID },
    loginCfg: {},
    readOnlyStatus: options.readOnlyStatus === true,
    browserFactory: async () => { assert.fail('No browser may be launched'); },
    openHome: async () => ({ browser, context, target: page, cookieSession: null }),
    sessionCheckpoint: async () => { record('checkpoint'); return checkpoint; },
  });
  return { open, page, browser, context, checkpoint, events, elapsed, business, close,
    setUrl(value) { url = value; } };
}

function assertNoUntrustedActions(fixture) {
  const actions = fixture.events.filter(event => ['navigate', 'tab-click', 'overlay-close', 'business-click'].includes(event.kind));
  assert.ok(actions.every(event => event.trusted === true));
  assert.equal(fixture.business.clicked, 0);
  assert.ok(fixture.events.filter(event => event.kind === 'probe' && event.trusted === false)
    .every(event => event.click === false));
}

function assertSuccess(fixture, result) {
  assert.strictEqual(result.target, fixture.page);
  assert.strictEqual(result.browser, fixture.browser);
  assert.strictEqual(result.context, fixture.context);
  assert.strictEqual(result.cookieCheckpoint, fixture.checkpoint);
  assert.equal(result.account.accountId, ACCOUNT_ID);
  assert.equal(result.account.hasSubTabs, true);
  assert.equal(result.readOnlyEmpty, undefined);
  assert.equal(fixture.events.filter(event => event.kind === 'checkpoint').length, 1);
  assert.equal(fixture.events.filter(event => event.kind === 'browser-close').length, 0);
  assertNoUntrustedActions(fixture);
}

for (const readOnlyStatus of [false, true]) {
  for (const until of [4000, 17000]) {
    test(`late untrusted navigation recovers at ${until}ms; readOnlyStatus=${readOnlyStatus}`, async t => {
      const fixture = makeSession(t, { readOnlyStatus, urlAt: ms => ms < until ? UNSUPPORTED : MANAGER });
      const result = await fixture.open();
      assertSuccess(fixture, result);
      assert.equal(fixture.elapsed(), until + 4000);
      const probes = fixture.events.filter(event => event.kind === 'probe' && event.at !== null);
      assert.equal(probes[0].trusted, false);
      assert.ok(probes.some(event => event.trusted && event.at === until));
      assert.ok(fixture.events.filter(event => event.kind === 'navigate').every(event => event.at >= until));
      assert.equal(fixture.events.filter(event => event.kind === 'tab-click').length, 2);
    });
  }

  for (const [url, blocker] of [[FOREIGN, 'untrusted-origin'], [LOGIN, 'login-path'], [UNSUPPORTED, 'unsupported-path']]) {
    test(`persistent ${blocker} exhausts existing deadlines; readOnlyStatus=${readOnlyStatus}`, async t => {
      const fixture = makeSession(t, { readOnlyStatus, urlAt: () => url });
      await assert.rejects(fixture.open(), error => {
        assert.equal(error.code, 'DATA_GUARD');
        assert.match(error.reason, /浮窗探测不在可信千川页面.*子标签等待超时/);
        assert.doesNotMatch(error.reason, /判定关闭|登录失效|Cookie/);
        return true;
      });
      assert.equal(fixture.elapsed(), 55000);
      const probes = fixture.events.filter(event => event.kind === 'probe' && event.at !== null);
      assert.equal(probes.length, 28);
      assert.ok(probes.every(event => !event.trusted && event.at < 55000 && event.blockers.includes(blocker)));
      assert.ok(probes.some(event => event.at === 15000));
      const waits = fixture.events.filter(event => event.kind === 'wait' && event.at !== null);
      assert.equal(waits.reduce((sum, event) => sum + event.ms, 0), 55000);
      assert.ok(waits.every(event => event.at + event.ms <= (event.at < 15000 ? 15000 : 55000)));
      assert.equal(fixture.events.filter(event => event.kind === 'navigate').length, 0);
      assert.equal(fixture.events.filter(event => event.kind === 'read-account').length, 1);
      assert.equal(fixture.events.filter(event => event.kind === 'browser-close').length, 1);
      assert.equal(fixture.events.find(event => event.kind === 'browser-close').at, 55000);
      assertNoUntrustedActions(fixture);
    });
  }
}

for (const overlay of ['unknown', 'danger']) {
  for (const until of [0, 17000]) {
    test(`${overlay} modal is not retried after trust returns at ${until}ms`, async t => {
      const fixture = makeSession(t, { readOnlyStatus: true, overlay,
        urlAt: ms => ms < until ? UNSUPPORTED : MANAGER });
      await assert.rejects(fixture.open(), error => {
        assert.equal(error.code, 'DATA_GUARD');
        assert.match(error.reason, overlay === 'unknown' ? /unknown-overlay:1/ : /danger-text/);
        return true;
      });
      assert.equal(fixture.elapsed(), until);
      assert.equal(fixture.events.filter(event => event.kind === 'probe' && event.at !== null && event.trusted).length, 1);
      assert.equal(fixture.events.filter(event => event.kind === 'navigate').length, 0);
      assert.equal(fixture.close.clicked, 0);
      assertNoUntrustedActions(fixture);
    });
  }
}

test('trusted current flow keeps navigation, account and return shape unchanged', async t => {
  const fixture = makeSession(t, { readOnlyStatus: true });
  assertSuccess(fixture, await fixture.open());
  assert.equal(fixture.elapsed(), 4000);
  assert.equal(fixture.events.filter(event => event.kind === 'navigate').length, 2);
  assert.equal(fixture.events.filter(event => event.kind === 'probe').length, 4);
  assert.deepEqual(fixture.events.filter(event => event.kind === 'wait').map(event => event.ms), [2000, 9000, 2000, 2000]);
});

test('known popup is closed only after trust returns, with both disappearance probes retained', async t => {
  const fixture = makeSession(t, { readOnlyStatus: true, overlay: 'known', urlAt: ms => ms < 4000 ? UNSUPPORTED : MANAGER });
  assertSuccess(fixture, await fixture.open());
  assert.equal(fixture.close.clicked, 1);
  const closeIndex = fixture.events.findIndex(event => event.kind === 'overlay-close');
  assert.equal(fixture.events[closeIndex].at, 4000);
  const afterClose = fixture.events.slice(closeIndex + 1);
  const beforeNavigation = afterClose.slice(0, afterClose.findIndex(event => event.kind === 'navigate'));
  assert.equal(beforeNavigation.filter(event => event.kind === 'probe' && event.click === false && event.state === 'none').length, 2);
  assert.equal(fixture.elapsed(), 8500);
});

test('untrusted final ready check still fails immediately rather than opening another wait', async t => {
  const fixture = makeSession(t, { readOnlyStatus: true, readyUrl: LOGIN });
  await assert.rejects(fixture.open(), /浮窗探测不在可信千川页面（子标签就绪后）/);
  assert.equal(fixture.elapsed(), 4000);
  assert.equal(fixture.events.filter(event => event.kind === 'probe' && event.trusted === false).length, 1);
  assertNoUntrustedActions(fixture);
});

test('trust arriving exactly at the exhausted deadline does not start a fresh budget', async t => {
  const fixture = makeSession(t, { readOnlyStatus: true, urlAt: ms => ms < 55000 ? UNSUPPORTED : MANAGER });
  await assert.rejects(fixture.open(), /子标签等待超时/);
  assert.equal(fixture.elapsed(), 55000);
  assert.equal(fixture.events.filter(event => event.kind === 'navigate').length, 0);
  assertNoUntrustedActions(fixture);
});

test('trusted but missing tabs keeps the existing unknown-scope failure', async t => {
  const fixture = makeSession(t, { readOnlyStatus: true, tabsNeverReady: true });
  await assert.rejects(fixture.open(), /乘方只读页面范围无法确认，拒绝判定关闭/);
  assert.equal(fixture.elapsed(), 55000);
  assertNoUntrustedActions(fixture);
});

for (const url of [FOREIGN, LOGIN]) {
  test(`generic closer remains immediate and zero-click for ${url === LOGIN ? 'login' : 'foreign'}`, async t => {
    const fixture = makeSession(t);
    fixture.setUrl(url);
    const result = await dismissKnownChengfangOverlays({ page: fixture.page });
    assert.equal(result.state, 'untrusted');
    assert.equal(result.dismissed, false);
    assert.equal(fixture.events.length, 1);
    assert.equal(fixture.events[0].kind, 'probe');
    assertNoUntrustedActions(fixture);
  });
}
