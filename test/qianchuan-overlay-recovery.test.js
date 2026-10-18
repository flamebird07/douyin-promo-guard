'use strict';

/**
 * 千川已知引导/介绍浮窗：白名单探针/关闭器 + 同店保留窗口有界恢复（隔离测试）。
 *
 * 全部为 Node 纯 mock DOM/VM + mock page/context/browser：
 *  - 不启动真实 Playwright / 浏览器 / CDP / 桌面 / 网络；
 *  - 不读写 Cookie 文件、不接触生产目录、不发任何消息/调度；
 *  - 页面内函数用 node:vm 在 mock document/location 上执行真实源码（非重写副本）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const {
  handleChengfangOverlayInPage,
  dismissKnownChengfangOverlays,
  advanceChengfangPlanViewInPage,
  isTrustedChengfangUrl,
  hasChengfangManualReview,
  retainChengfangPageForManualReview,
  watchChengfangControlsForManualReview,
  openChengfangShop,
} = require('../src/adapters/chengfang-reader');
const { DataGuardError } = require('../src/lib/errors');

const QC_URL = 'https://qianchuan.jinritemai.com/overall-prom';
const ACCOUNT = '1710242295996424';

// ── 极简 mock DOM（只支持本模块用到的选择器形态）─────────────────────────

class FakeNode {
  constructor(tag, attrs, text) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.attrs = Object.assign({}, attrs || {});
    this.className = this.attrs.class || '';
    this.children = [];
    this.parentElement = null;
    this.ownText = text || '';
    this.visible = this.attrs.visible !== false;
    this.removed = false;
    this.clicked = 0;
    this.onClick = null;
  }

  get textContent() {
    if (this.removed) return '';
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? String(this.attrs[name]) : null;
  }

  setAttribute(name, value) { this.attrs[name] = String(value); }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  removeChild(child) {
    this.children = this.children.filter((c) => c !== child);
    child.parentElement = null;
  }

  getBoundingClientRect() {
    if (!this.visible || this.removed) return { width: 0, height: 0, top: 0, left: 0 };
    return { width: 120, height: 40, top: 0, left: 0 };
  }

  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }

  click() {
    this.clicked += 1;
    if (typeof this.onClick === 'function') this.onClick(this);
  }

  querySelectorAll(sel) { return queryAll(this, sel); }

  querySelector(sel) { return queryAll(this, sel)[0] || null; }
}

function hasClass(node, cls) {
  return String(node.className || '').split(/\s+/).filter(Boolean).includes(cls);
}

function matchCompound(node, comp) {
  if (!node || node.removed) return false;
  const tag = /^([a-zA-Z][\w-]*)/.exec(comp);
  if (tag && node.tagName !== tag[1].toUpperCase()) return false;
  for (const c of comp.match(/\.([\w-]+)/g) || []) {
    if (!hasClass(node, c.slice(1))) return false;
  }
  const attrRe = /\[([\w-]+)(?:([*^$]?=)"([^"]*)")?\]/g;
  let m;
  while ((m = attrRe.exec(comp))) {
    const name = m[1];
    const op = m[2];
    const val = m[3];
    const actual = node.getAttribute(name);
    if (actual == null) return false;
    if (!op) continue;
    if (op === '=' && actual !== val) return false;
    if (op === '*=' && !actual.includes(val)) return false;
  }
  return true;
}

function matchSelector(node, sel) {
  const parts = sel.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  if (!matchCompound(node, parts[parts.length - 1])) return false;
  let idx = parts.length - 2;
  let cur = node.parentElement;
  while (idx >= 0) {
    if (!cur) return false;
    if (matchCompound(cur, parts[idx])) idx -= 1;
    cur = cur.parentElement;
  }
  return true;
}

function queryAll(root, sel) {
  const selectors = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  const walk = (node) => {
    for (const child of node.children) {
      if (child.removed) continue;
      if (selectors.some((s) => matchSelector(child, s))) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

function makeDom() {
  const root = new FakeNode('body');
  return {
    root,
    document: {
      querySelectorAll(sel) { return queryAll(root, sel); },
      querySelector(sel) { return queryAll(root, sel)[0] || null; },
    },
  };
}

/** 在 mock 页面环境里执行模块内真实函数源码。 */
function runInPage(fn, arg, env, extra) {
  const ctx = vm.createContext(Object.assign({
    document: env.document,
    location: { href: env.url },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    URL,
    Node: { TEXT_NODE: 3 },
    console,
    setTimeout,
  }, extra || {}));
  const call = arg === undefined ? 'undefined' : JSON.stringify(arg);
  return vm.runInContext(`(${fn.toString()})(${call})`, ctx);
}

/** 在同一个 vm 上下文里定义多个模块函数源码后调用（用于验证函数间组合行为）。 */
function runWithHelpers(env, helpers, callExpr) {
  const ctx = vm.createContext({
    document: env.document,
    location: { href: env.url },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    URL,
    Node: { TEXT_NODE: 3 },
    console,
    setTimeout,
  });
  const src = `(function () {
    ${helpers.map((f) => f.toString()).join('\n')}
    return ${callExpr};
  })()`;
  return vm.runInContext(src, ctx);
}

// ── 浮窗 fixture ────────────────────────────────────────────────────────

function removeNode(node) {
  node.removed = true;
  if (node.parentElement) node.parentElement.removeChild(node);
}

function addIntro(root, opts = {}) {
  const closeCount = opts.closeCount === undefined ? 1 : opts.closeCount;
  const works = opts.works !== false;
  const wrap = new FakeNode('div', { class: 'ocean-vmok-plugin-oc-modal-wrap' });
  root.appendChild(wrap);
  const inner = new FakeNode('div', { 'data-e2e': 'oc_emptyKey_overall-prom' }, opts.text || '');
  wrap.appendChild(inner);
  const closes = [];
  for (let i = 0; i < closeCount; i++) {
    const x = new FakeNode('span', { class: 'tools-vmok-plugin-modal__close-icon' });
    x.onClick = () => { if (works) removeNode(wrap); };
    inner.appendChild(x);
    closes.push(x);
  }
  return { wrap, inner, closes };
}

function addGuide(root, opts = {}) {
  const text = opts.text === undefined ? '跳过' : opts.text;
  const count = opts.count === undefined ? 1 : opts.count;
  const works = opts.works !== false;
  const g = new FakeNode('div', { class: 'qc-guide-container' });
  root.appendChild(g);
  const btns = [];
  for (let i = 0; i < count; i++) {
    const b = new FakeNode('button', {}, text);
    b.onClick = () => { if (works) removeNode(g); };
    g.appendChild(b);
    btns.push(b);
  }
  return { g, btns };
}

function addUnknownModal(root) {
  const m = new FakeNode('div', { class: 'ovui-modal' });
  root.appendChild(m);
  return m;
}

// ── mock page / browser / context ───────────────────────────────────────

function makePage({ url = QC_URL, dom = makeDom(), header = null, hasSubTabs = true } = {}) {
  const page = {
    _url: url,
    _dom: dom,
    _closed: false,
    _hasSubTabs: hasSubTabs,
    _header: header || { accountId: ACCOUNT, accountName: '伊人美', candidates: 1, unique: true, loginVisible: false },
    _headerGate: null,
    _context: null,
    _evaluateCount: 0,
    _activePage: '1',
    _accountHook: null,
    async evaluate(fn, arg) {
      page._evaluateCount += 1;
      const name = fn && fn.name;
      if (name === 'readChengfangAccountInPage') {
        if (typeof page._accountHook === 'function') {
          const hooked = await page._accountHook(page, arg);
          if (hooked !== undefined) return hooked;
        }
        return {
          url: page._url, accountId: ACCOUNT, accountName: '伊人美',
          hasChengfangNav: true, hasSubTabs: page._hasSubTabs, navText: '乘方',
        };
      }
      if (name === 'probeQianchuanHeaderIdentityInPage') {
        if (page._headerGate) await page._headerGate;
        return page._header;
      }
      if (name === 'handleChengfangOverlayInPage' || name === 'advanceChengfangPlanViewInPage') {
        return runInPage(fn, arg, { document: page._dom.document, url: page._url });
      }
      if (name === 'navigateChengfangPlanViewInPage') return { action: 'none' };
      if (name === 'collectChengfangPaginationInPage') {
        return { activePage: String(page._activePage), pageSize: '100', ui: 'aurora' };
      }
      return undefined; // 导航点击等匿名函数
    },
    url() { return page._url; },
    async waitForTimeout() {},
    async waitForFunction() {},
    async goto() {},
    async bringToFront() {},
    on() {},
    isClosed() { return page._closed; },
    context() { return page._context; },
    close() { page._closed = true; },
  };
  return page;
}

function makeReviewBrowser(page) {
  const reviewContext = {
    async newPage() { page._context = reviewContext; return page; },
    async storageState() { return { cookies: [] }; },
    async cookies() { return [{ name: 'mock', value: 'mock' }]; },
  };
  const browser = {
    _closed: false,
    on() {},
    async newContext() { return reviewContext; },
    async close() { browser._closed = true; },
    isConnected() { return browser._closed !== true; },
  };
  return { browser, reviewContext };
}

function baseFixture(shopId) {
  const dom = makeDom();
  const target = makePage({ url: QC_URL, dom, header: { accountId: ACCOUNT, candidates: 1, unique: true, loginVisible: false } });
  const context = { async storageState() { return { cookies: [] }; } };
  return { shopCfg: { id: shopId }, loginCfg: {}, dom, target, context };
}

async function holdWithReviewWindow(shopId, reviewPageOpts = {}) {
  const f = baseFixture(shopId);
  const reviewPage = makePage(Object.assign({ url: QC_URL }, reviewPageOpts));
  const { browser, reviewContext } = makeReviewBrowser(reviewPage);
  const originalCookieSession = {
    filePath: 'C:/mock/店铺.json',
    startFingerprint: { sha256: 'deadbeef' },
    identityPage: { mock: 'original-context-page' },
  };
  const held = await retainChengfangPageForManualReview({
    context: f.context,
    target: f.target,
    shopCfg: f.shopCfg,
    loginCfg: {},
    browserFactory: async () => browser,
    cookieSession: originalCookieSession,
  });
  return { ...f, reviewPage, browser, reviewContext, held, originalCookieSession };
}

// ── 1) 白名单探针/关闭器 ────────────────────────────────────────────────

test('已知介绍浮窗：唯一X可关闭，二次观察消失才算完成', async () => {
  const dom = makeDom();
  const intro = addIntro(dom.root);
  const page = makePage({ dom });
  const r = await dismissKnownChengfangOverlays({ page });
  assert.equal(r.dismissed, true);
  assert.equal(r.action, 'dismiss-intro');
  assert.equal(intro.closes[0].clicked, 1, '只点一次唯一X');
  assert.equal(intro.wrap.removed, true);
  const after = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL });
  assert.equal(after.state, 'none');
});

test('点击后未消失：如实失败，不伪造关闭', async () => {
  const dom = makeDom();
  const intro = addIntro(dom.root, { works: false });
  const page = makePage({ dom });
  const r = await dismissKnownChengfangOverlays({ page });
  assert.equal(r.dismissed, false);
  assert.equal(r.state, 'not-disappeared');
  assert.equal(intro.closes[0].clicked, 1);
});

test('未知浮窗/多候选X/多个独立浮窗/非可信host：一律零点击阻断', () => {
  const a = makeDom();
  addUnknownModal(a.root);
  const ra = runInPage(handleChengfangOverlayInPage, { click: true }, { document: a.document, url: QC_URL });
  assert.equal(ra.state, 'blocked');
  assert.equal(ra.clicked, false);
  assert.ok(ra.blockers.some((b) => b.startsWith('unknown-overlay')));

  const b = makeDom();
  const multi = addIntro(b.root, { closeCount: 2 });
  const rb = runInPage(handleChengfangOverlayInPage, { click: true }, { document: b.document, url: QC_URL });
  assert.equal(rb.state, 'blocked');
  assert.equal(rb.clicked, false);
  assert.ok(rb.blockers.some((x) => x.startsWith('ambiguous-close')));
  assert.equal(multi.closes[0].clicked, 0);
  assert.equal(multi.closes[1].clicked, 0);

  const c = makeDom();
  const one = addIntro(c.root);
  const two = addIntro(c.root);
  const rc = runInPage(handleChengfangOverlayInPage, { click: true }, { document: c.document, url: QC_URL });
  assert.equal(rc.state, 'blocked');
  assert.ok(rc.blockers.some((x) => x.startsWith('multiple-intro')));
  assert.equal(one.closes[0].clicked, 0);
  assert.equal(two.closes[0].clicked, 0);

  const d = makeDom();
  const introD = addIntro(d.root);
  const rd = runInPage(handleChengfangOverlayInPage, { click: true }, {
    document: d.document, url: 'https://fxg.jinritemai.com/ffa/mshop/homepage',
  });
  assert.equal(rd.trusted, false);
  assert.equal(rd.clicked, false);
  assert.equal(introD.closes[0].clicked, 0);
});

test('跳过/我知道了仅限已知guidance容器范围，容器外同文本零点击', () => {
  const a = makeDom();
  const g = addGuide(a.root, { text: '我知道了' });
  const ra = runInPage(handleChengfangOverlayInPage, { click: true }, { document: a.document, url: QC_URL });
  assert.equal(ra.clicked, true);
  assert.equal(ra.action, 'skip-guide');
  assert.equal(g.btns[0].clicked, 1);

  const b = makeDom();
  const stray = new FakeNode('button', {}, '我知道了');
  b.root.appendChild(stray);
  const rb = runInPage(handleChengfangOverlayInPage, { click: true }, { document: b.document, url: QC_URL });
  assert.equal(rb.state, 'none');
  assert.equal(rb.clicked, false);
  assert.equal(stray.clicked, 0);
});

test('advance 序列化后自包含：不注入任何 helper 也只关浮窗、不碰 tab', () => {
  const dom = makeDom();
  const intro = addIntro(dom.root);
  const tab = new FakeNode('div', { role: 'tab' }, '商品');
  dom.root.appendChild(tab);
  // 关键回归：不预注入 handleChengfangOverlayInPage（真实 page.evaluate 只序列化本函数）。
  const r = runInPage(advanceChengfangPlanViewInPage, undefined, { document: dom.document, url: QC_URL });
  assert.equal(r.trusted, true);
  assert.equal(r.clicked, true);
  assert.equal(r.action, 'dismiss-intro');
  assert.equal(intro.closes[0].clicked, 1);
  assert.equal(tab.clicked, 0, '导航函数不得点击 tab');
});

test('危险业务文本即使落在已知CSS外壳内也一律阻断（CSS不能代替内容判定）', () => {
  for (const text of [
    '确认删除这 30 条计划？删除后不可恢复',
    '为保证投放的唯一性，受到互斥影响的计划将暂停，小店随心推订单将终止且不可恢复，确认开启乘方投放',
    '确定要暂停 30 条计划吗',
  ]) {
    const dom = makeDom();
    const intro = addIntro(dom.root, { text });
    const r = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
    assert.equal(r.state, 'blocked', `应阻断：${text}`);
    assert.equal(r.clicked, false);
    assert.equal(intro.closes[0].clicked, 0, '危险文本外壳内零点击');
  }
});

test('已知浮窗旁的 business-confirm 未知对话框必须进入 foreign 扫描并阻断', () => {
  const dom = makeDom();
  const intro = addIntro(dom.root);
  const biz = new FakeNode('div', { class: 'business-confirm' }, '确定要暂停 30 条计划吗');
  dom.root.appendChild(biz);
  const r = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'blocked');
  assert.equal(r.clicked, false);
  assert.ok(r.blockers.some((b) => b.startsWith('unknown-overlay')));
  assert.equal(intro.closes[0].clicked, 0);
});

test('同一外壳同时含已知浮窗与业务对话框：不把整棵外壳当白名单', () => {
  const dom = makeDom();
  const shell = new FakeNode('div', { class: 'ocean-vmok-plugin-oc-modal-wrap' });
  dom.root.appendChild(shell);
  const inner = new FakeNode('div', { 'data-e2e': 'oc_emptyKey_overall-prom' });
  shell.appendChild(inner);
  const x = new FakeNode('span', { class: 'tools-vmok-plugin-modal__close-icon' });
  inner.appendChild(x);
  const biz = new FakeNode('div', { class: 'business-confirm' }, '确认删除 30 条计划');
  shell.appendChild(biz);
  const r = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'blocked');
  assert.equal(r.clicked, false);
  assert.equal(x.clicked, 0);
});

test('严格可信URL判定只认千川乘方管理页', () => {
  assert.equal(isTrustedChengfangUrl(QC_URL), true);
  assert.equal(isTrustedChengfangUrl('https://qianchuan.jinritemai.com/uni-prom/overall?aavid=1'), true);
  assert.equal(isTrustedChengfangUrl('https://fxg.jinritemai.com/overall-prom'), false);
  assert.equal(isTrustedChengfangUrl('http://qianchuan.jinritemai.com/overall-prom'), false);
  assert.equal(isTrustedChengfangUrl('https://qianchuan.jinritemai.com/login'), false);
  assert.equal(isTrustedChengfangUrl('https://qianchuan.jinritemai.com/home'), false);
});

// ── 2) 控制器：业务动作不重放，只读动作可有界恢复 ────────────────────────

test('业务动作定位失败：保留窗口、零重放、零点击', async () => {
  const f = baseFixture('overlay-business-no-replay');
  const reviewPage = makePage({ url: QC_URL });
  const { browser } = makeReviewBrowser(reviewPage);
  let pauseCalls = 0;
  let enableCalls = 0;
  const controller = watchChengfangControlsForManualReview({
    async clickBatchPause() { pauseCalls += 1; throw new DataGuardError('批量操作栏内未找到"暂停"按钮'); },
    async clickBatchEnable() { enableCalls += 1; },
  }, { ...f, reviewBrowserFactory: async () => browser });
  try {
    await assert.rejects(controller.clickBatchPause(), /已保留可见千川页面供人工检查/);
    assert.equal(pauseCalls, 1, '业务动作绝不自动重放');
    assert.equal(enableCalls, 0);
    assert.equal(hasChengfangManualReview(f.shopCfg), true);
  } finally {
    await browser.close();
  }
});

test('只读导航定位失败：先有界关闭已知浮窗，再重试一次', async () => {
  const dom = makeDom();
  const intro = addIntro(dom.root);
  const page = makePage({ dom });
  const f = {
    shopCfg: { id: 'overlay-readonly-retry' },
    loginCfg: {},
    context: {},
    target: page,
    reviewBrowserFactory: async () => { throw new Error('只读重试不应保留窗口'); },
  };
  let calls = 0;
  const controller = watchChengfangControlsForManualReview({
    async switchView() {
      calls += 1;
      if (calls === 1) throw new DataGuardError('切换子标签失败：未找到目标标签');
      return { ok: true };
    },
  }, f);
  const r = await controller.switchView({ page, tab: '商品自选' });
  assert.deepEqual(r, { ok: true });
  assert.equal(calls, 2);
  assert.equal(intro.closes[0].clicked, 1);
});

test('翻页非幂等：第一次已生效后抛错，绝不二次翻页', async () => {
  const dom = makeDom();
  addIntro(dom.root);
  const page = makePage({ dom });
  page._activePage = '1';
  let calls = 0;
  const controller = watchChengfangControlsForManualReview({
    async clickNextPage() {
      calls += 1;
      page._activePage = '2'; // 第一次点击已真实翻页，随后才抛错
      throw new DataGuardError('分页器内未找到下一页按钮');
    },
  }, { shopCfg: { id: 'overlay-next-already-moved' }, context: null, target: page });
  await assert.rejects(controller.clickNextPage({ page }));
  assert.equal(calls, 1, '页码已变化 → 零隐式重放（避免漏页/二次翻页）');
});

test('翻页非幂等：重读页码证明未生效才允许一次只读重试', async () => {
  const dom = makeDom();
  const intro = addIntro(dom.root);
  const page = makePage({ dom });
  page._activePage = '1';
  let calls = 0;
  const controller = watchChengfangControlsForManualReview({
    async clickNextPage() {
      calls += 1;
      if (calls === 1) throw new DataGuardError('分页器内未找到下一页按钮');
      return { clicked: true };
    },
  }, { shopCfg: { id: 'overlay-next-not-moved' }, context: null, target: page });
  const r = await controller.clickNextPage({ page });
  assert.deepEqual(r, { clicked: true });
  assert.equal(calls, 2);
  assert.equal(intro.closes[0].clicked, 1, '先有界关闭已知浮窗');
});

test('业务动作即使旁边有可关闭浮窗也零隐式重放、零浮窗探测', async () => {
  const dom = makeDom();
  const intro = addIntro(dom.root);
  const page = makePage({ dom });
  const before = page._evaluateCount;
  let calls = 0;
  const controller = watchChengfangControlsForManualReview({
    async clickBatchPause() {
      calls += 1;
      throw new DataGuardError('批量操作栏内未找到"暂停"按钮');
    },
  }, { shopCfg: { id: 'overlay-business-never-replay' }, context: null, target: page });
  await assert.rejects(controller.clickBatchPause({ page }));
  assert.equal(calls, 1);
  assert.equal(page._evaluateCount, before, '业务动作不得触发浮窗探测/重放');
  assert.equal(intro.closes[0].clicked, 0);
});

// ── 3) 保留窗口有界恢复 ────────────────────────────────────────────────

test('同店保留窗口：身份匹配 + 唯一X关闭并二次消失 → 有界解除并复用窗口', async () => {
  const held = await holdWithReviewWindow('overlay-release-ok');
  const intro = addIntro(held.reviewPage._dom.root);
  let openHomeCalls = 0;
  let checkpointArgs = null;
  try {
    assert.equal(hasChengfangManualReview(held.shopCfg), true);
    const r = await openChengfangShop({
      shopCfg: held.shopCfg,
      loginCfg: {},
      openHome: async () => { openHomeCalls += 1; throw new Error('不得新开浏览器'); },
      sessionCheckpoint: async (args) => { checkpointArgs = args; return { saved: true, skipped: false }; },
    });
    assert.equal(openHomeCalls, 0, '复用保留窗口，不新开');
    assert.equal(r.recoveredFromManualReview, true);
    assert.equal(r.cookieSession, null, '不把 reviewContext 的过期元信息交给后续回写');
    assert.equal(intro.closes[0].clicked, 1);
    assert.equal(hasChengfangManualReview(held.shopCfg), false);
    // Cookie：走既有检查点；新 reviewContext 不是原 context，元信息只含 filePath/startFingerprint
    assert.ok(checkpointArgs);
    assert.equal(checkpointArgs.context, held.reviewContext);
    assert.equal(checkpointArgs.target, held.reviewPage);
    assert.deepEqual(Object.keys(checkpointArgs.cookieSession).sort(), ['filePath', 'startFingerprint']);
    assert.equal(Object.prototype.hasOwnProperty.call(checkpointArgs.cookieSession, 'identityPage'), false,
      '绝不把原 context 的 identityPage 带进新 reviewContext 检查点');
    assert.notEqual(checkpointArgs.cookieSession, held.originalCookieSession, '不整体复制原 cookieSession');
  } finally {
    await held.browser.close();
  }
});

test('身份漂移/缺冻结身份/错host/legacyheld：一律不解除，guard 保持', async () => {
  // 身份漂移
  const drift = await holdWithReviewWindow('overlay-release-drift', {
    header: { accountId: '9999999999999999', candidates: 1, unique: true, loginVisible: false },
  });
  try {
    await assert.rejects(openChengfangShop({ shopCfg: drift.shopCfg, loginCfg: {}, openHome: async () => { throw new Error('不得新开'); } }),
      /等待人工检查/);
    assert.equal(hasChengfangManualReview(drift.shopCfg), true);
  } finally { await drift.browser.close(); }

  // 错 host
  const wrongHost = await holdWithReviewWindow('overlay-release-host', {
    url: 'https://fxg.jinritemai.com/ffa/mshop/homepage',
  });
  try {
    await assert.rejects(openChengfangShop({ shopCfg: wrongHost.shopCfg, loginCfg: {}, openHome: async () => { throw new Error('不得新开'); } }),
      /等待人工检查/);
    assert.equal(hasChengfangManualReview(wrongHost.shopCfg), true);
  } finally { await wrongHost.browser.close(); }

  // legacy：原会话没有唯一头部正证据 → 不冻结、不猜
  const legacy = baseFixture('overlay-release-legacy');
  legacy.target.evaluate = async (fn) => (fn && fn.name === 'probeQianchuanHeaderIdentityInPage'
    ? { accountId: null, candidates: 0, unique: false, loginVisible: false }
    : undefined);
  const legacyPage = makePage({ url: QC_URL });
  const legacyBrowser = makeReviewBrowser(legacyPage);
  try {
    const h = await retainChengfangPageForManualReview({
      context: legacy.context, target: legacy.target, shopCfg: legacy.shopCfg,
      loginCfg: {}, browserFactory: async () => legacyBrowser.browser,
    });
    assert.equal(h.held, true);
    await assert.rejects(openChengfangShop({ shopCfg: legacy.shopCfg, loginCfg: {}, openHome: async () => { throw new Error('不得新开'); } }),
      /等待人工检查/);
    assert.equal(hasChengfangManualReview(legacy.shopCfg), true);
  } finally { await legacyBrowser.browser.close(); }
});

test('浮窗未消失/未知浮窗：不解除 guard，也不新开', async () => {
  const stuck = await holdWithReviewWindow('overlay-release-stuck');
  addIntro(stuck.reviewPage._dom.root, { works: false });
  try {
    await assert.rejects(openChengfangShop({ shopCfg: stuck.shopCfg, loginCfg: {}, openHome: async () => { throw new Error('不得新开'); } }),
      /等待人工检查/);
    assert.equal(hasChengfangManualReview(stuck.shopCfg), true);
  } finally { await stuck.browser.close(); }

  const unknown = await holdWithReviewWindow('overlay-release-unknown');
  addUnknownModal(unknown.reviewPage._dom.root);
  try {
    await assert.rejects(openChengfangShop({ shopCfg: unknown.shopCfg, loginCfg: {}, openHome: async () => { throw new Error('不得新开'); } }),
      /等待人工检查/);
    assert.equal(hasChengfangManualReview(unknown.shopCfg), true);
  } finally { await unknown.browser.close(); }
});

test('同店并发：只允许一个恢复者，第二个不新开', async () => {
  const held = await holdWithReviewWindow('overlay-release-concurrent');
  addIntro(held.reviewPage._dom.root);
  let release;
  const gate = new Promise((r) => { release = r; });
  held.reviewPage._headerGate = gate;
  const p1 = openChengfangShop({
    shopCfg: held.shopCfg,
    loginCfg: {},
    openHome: async () => { throw new Error('不得新开'); },
    sessionCheckpoint: async () => ({ saved: false, skipped: true, reason: 'test' }),
  });
  await new Promise((r) => setTimeout(r, 0)); // 让第一个恢复者进入头部身份核验
  const p2 = openChengfangShop({
    shopCfg: held.shopCfg,
    loginCfg: {},
    openHome: async () => { throw new Error('不得新开'); },
  });
  try {
    await assert.rejects(p2, /另一个恢复流程正在进行/);
  } finally {
    release();
  }
  const r1 = await p1;
  assert.equal(r1.recoveredFromManualReview, true);
  assert.equal(hasChengfangManualReview(held.shopCfg), false);
  await held.browser.close();
});

test('checkpoint / 最终 await 期间同店 lease 不释放：并发 opener 不新开、guard 不提前解除', async () => {
  const held = await holdWithReviewWindow('overlay-checkpoint-lease');
  addIntro(held.reviewPage._dom.root);
  let releaseCheckpoint;
  const gate = new Promise((r) => { releaseCheckpoint = r; });
  let checkpointEntered = false;
  const p1 = openChengfangShop({
    shopCfg: held.shopCfg,
    loginCfg: {},
    openHome: async () => { throw new Error('不得新开'); },
    sessionCheckpoint: async () => {
      checkpointEntered = true;
      await gate;
      return { saved: false, skipped: true, reason: 'test' };
    },
  });
  for (let i = 0; i < 200 && !checkpointEntered; i += 1) {
    await new Promise((r) => setTimeout(r, 1));
  }
  assert.equal(checkpointEntered, true, '第一个恢复者应已进入 checkpoint 临界区');
  try {
    await assert.rejects(openChengfangShop({
      shopCfg: held.shopCfg, loginCfg: {},
      openHome: async () => { throw new Error('不得新开'); },
    }), /另一个恢复流程正在进行/);
    assert.equal(hasChengfangManualReview(held.shopCfg), true, 'checkpoint 期间 guard 不得提前解除');
  } finally {
    releaseCheckpoint();
  }
  const r1 = await p1;
  assert.equal(r1.recoveredFromManualReview, true);
  assert.equal(hasChengfangManualReview(held.shopCfg), false);
  await held.browser.close();
});

test('release 后最终身份重新读取异常：不退回旧快照，guard 保持且 lease 释放', async () => {
  const held = await holdWithReviewWindow('overlay-final-read-error');
  addIntro(held.reviewPage._dom.root);
  let reads = 0;
  held.reviewPage._accountHook = async () => {
    reads += 1;
    if (reads >= 2) throw new Error('fresh read boom');
    return undefined;
  };
  try {
    await assert.rejects(openChengfangShop({
      shopCfg: held.shopCfg, loginCfg: {},
      openHome: async () => { throw new Error('不得新开'); },
      sessionCheckpoint: async () => ({ saved: false, skipped: true, reason: 'test' }),
    }), /最终页面身份读取异常|不退回旧快照/);
    assert.equal(hasChengfangManualReview(held.shopCfg), true, '读取异常必须保持 guard');
    // lease 已随异常收口释放：恢复读取后再次尝试可安全交回（不会被 lease 卡死）。
    held.reviewPage._accountHook = null;
    const r2 = await openChengfangShop({
      shopCfg: held.shopCfg, loginCfg: {},
      openHome: async () => { throw new Error('不得新开'); },
      sessionCheckpoint: async () => ({ saved: false, skipped: true, reason: 'test' }),
    });
    assert.equal(r2.recoveredFromManualReview, true);
    assert.equal(hasChengfangManualReview(held.shopCfg), false);
  } finally {
    await held.browser.close();
  }
});

test('release 后最终身份漂移：不交回不可信会话，guard 保持', async () => {
  const held = await holdWithReviewWindow('overlay-final-read-drift');
  addIntro(held.reviewPage._dom.root);
  let reads = 0;
  held.reviewPage._accountHook = async () => {
    reads += 1;
    if (reads >= 2) {
      return {
        url: QC_URL, accountId: '9999999999999999', accountName: '漂移店',
        hasChengfangNav: true, hasSubTabs: true, navText: '乘方',
      };
    }
    return undefined;
  };
  try {
    await assert.rejects(openChengfangShop({
      shopCfg: held.shopCfg, loginCfg: {},
      openHome: async () => { throw new Error('不得新开'); },
      sessionCheckpoint: async () => ({ saved: false, skipped: true, reason: 'test' }),
    }), /不一致|漂移/);
    assert.equal(hasChengfangManualReview(held.shopCfg), true);
  } finally {
    await held.browser.close();
  }
});

// ── 3b) checkpoint await 期间漂移：删除 guard / 交回会话前的最终新鲜复核 ──

test('checkpoint 期间身份漂移（页面账户+头部同时换号）：拒绝交回，guard 保持', async () => {
  const held = await holdWithReviewWindow('overlay-drift-in-checkpoint');
  let drifted = false;
  held.reviewPage._accountHook = async () => (drifted ? {
    url: QC_URL, accountId: '9999999999999999', accountName: '漂移店',
    hasChengfangNav: true, hasSubTabs: true, navText: '乘方',
  } : undefined);
  try {
    await assert.rejects(openChengfangShop({
      shopCfg: held.shopCfg, loginCfg: {},
      openHome: async () => { throw new Error('不得新开'); },
      sessionCheckpoint: async () => {
        drifted = true;
        held.reviewPage._header = { accountId: '9999999999999999', accountName: '漂移店', candidates: 1, unique: true, loginVisible: false };
        return { saved: false, skipped: true, reason: 'test' };
      },
    }), /检查点后.*不一致/);
    assert.equal(hasChengfangManualReview(held.shopCfg), true, 'checkpoint 期间漂移必须保持 guard');
  } finally { await held.browser.close(); }
});

test('checkpoint 期间窗口切到登录页：拒绝交回，guard 保持', async () => {
  const held = await holdWithReviewWindow('overlay-login-in-checkpoint');
  try {
    await assert.rejects(openChengfangShop({
      shopCfg: held.shopCfg, loginCfg: {},
      openHome: async () => { throw new Error('不得新开'); },
      sessionCheckpoint: async () => {
        held.reviewPage._url = 'https://qianchuan.jinritemai.com/login';
        return { saved: false, skipped: true, reason: 'test' };
      },
    }), /检查点后最终页面身份/);
    assert.equal(hasChengfangManualReview(held.shopCfg), true);
  } finally { await held.browser.close(); }
});

test('checkpoint 期间新增未知弹窗：拒绝交回，guard 保持，零点击', async () => {
  const held = await holdWithReviewWindow('overlay-unknown-in-checkpoint');
  let modal = null;
  try {
    await assert.rejects(openChengfangShop({
      shopCfg: held.shopCfg, loginCfg: {},
      openHome: async () => { throw new Error('不得新开'); },
      sessionCheckpoint: async () => {
        modal = addUnknownModal(held.reviewPage._dom.root);
        return { saved: false, skipped: true, reason: 'test' };
      },
    }), /检查点后最终浮窗只读复核未通过/);
    assert.equal(hasChengfangManualReview(held.shopCfg), true);
    assert.equal(modal.clicked, 0, '最终复核纯只读：绝不点击未知弹窗');
  } finally { await held.browser.close(); }
});

test('checkpoint 期间页面读取失败（关闭/不可达）：拒绝交回，guard 保持；lease 释放可下一轮重试', async () => {
  const held = await holdWithReviewWindow('overlay-boom-in-checkpoint');
  let boom = false;
  const realEval = held.reviewPage.evaluate.bind(held.reviewPage);
  held.reviewPage.evaluate = async (fn, arg) => {
    if (boom && fn && fn.name === 'readChengfangAccountInPage') {
      throw new Error('Target page, context or browser has been closed');
    }
    return realEval(fn, arg);
  };
  try {
    await assert.rejects(openChengfangShop({
      shopCfg: held.shopCfg, loginCfg: {},
      openHome: async () => { throw new Error('不得新开'); },
      sessionCheckpoint: async () => { boom = true; return { saved: false, skipped: true, reason: 'test' }; },
    }), /检查点后最终身份读取异常|不退回旧快照/);
    assert.equal(hasChengfangManualReview(held.shopCfg), true, '读取异常不得当作正常交回，guard 保持');
    // 异常收口已释放恢复者 lease：窗口恢复可读后下一轮可安全交回（不被 lease 卡死）。
    boom = false;
    const r2 = await openChengfangShop({
      shopCfg: held.shopCfg, loginCfg: {},
      openHome: async () => { throw new Error('不得新开'); },
      sessionCheckpoint: async () => ({ saved: false, skipped: true, reason: 'test' }),
    });
    assert.equal(r2.recoveredFromManualReview, true);
    assert.equal(hasChengfangManualReview(held.shopCfg), false);
  } finally { await held.browser.close(); }
});

test('checkpoint 期间保留窗口真实关闭：拒绝交回、不伪造成功（关闭窗口的 guard 由既有 isClosed 清理，非交回路径）', async () => {
  const held = await holdWithReviewWindow('overlay-closed-in-checkpoint');
  let opens = 0;
  try {
    await assert.rejects(openChengfangShop({
      shopCfg: held.shopCfg, loginCfg: {},
      openHome: async () => { opens += 1; throw new Error('不得新开'); },
      sessionCheckpoint: async () => { held.reviewPage._closed = true; return { saved: false, skipped: true, reason: 'test' }; },
    }), /等待人工检查|检查点期间保留窗口被关闭/);
    assert.equal(opens, 0, '被拒绝的恢复绝不落到新开路径');
  } finally { await held.browser.close(); }
});

test('不变身份：checkpoint 后仍做最终新鲜复核，返回的是最后鲜读账户而非旧快照', async () => {
  const held = await holdWithReviewWindow('overlay-post-checkpoint-fresh');
  let phase = 'pre';
  held.reviewPage._accountHook = async () => (phase === 'post' ? {
    url: QC_URL, accountId: ACCOUNT, accountName: '伊人美',
    hasChengfangNav: true, hasSubTabs: true, navText: '乘方', _postFreshRead: true,
  } : undefined);
  let checkpointDone = false;
  try {
    const r = await openChengfangShop({
      shopCfg: held.shopCfg, loginCfg: {},
      openHome: async () => { throw new Error('不得新开'); },
      sessionCheckpoint: async () => { checkpointDone = true; phase = 'post'; return { saved: false, skipped: true, reason: 'test' }; },
    });
    assert.equal(r.recoveredFromManualReview, true);
    assert.equal(checkpointDone, true);
    assert.equal(r.account && r.account._postFreshRead, true, '返回账户必须来自 checkpoint 之后的最后鲜读');
    assert.equal(hasChengfangManualReview(held.shopCfg), false);
  } finally { await held.browser.close(); }
});

test('checkpoint 后最终鲜读期间同店 lease 仍持有：并发 opener 被拒、零新 opener、guard 不提前解除', async () => {
  const held = await holdWithReviewWindow('overlay-post-read-lease');
  let reads = 0;
  let releaseRead;
  const gate = new Promise((r) => { releaseRead = r; });
  held.reviewPage._accountHook = async () => {
    reads += 1;
    if (reads >= 3) await gate; // 第 3 次账户读取 = checkpoint 后的最终鲜读
    return undefined;
  };
  const p1 = openChengfangShop({
    shopCfg: held.shopCfg, loginCfg: {},
    openHome: async () => { throw new Error('不得新开'); },
    sessionCheckpoint: async () => ({ saved: false, skipped: true, reason: 'test' }),
  });
  for (let i = 0; i < 200 && reads < 3; i += 1) await new Promise((r) => setTimeout(r, 1));
  assert.ok(reads >= 3, '第一个恢复者应已进入 checkpoint 后的最终鲜读临界区');
  let opens2 = 0;
  try {
    await assert.rejects(openChengfangShop({
      shopCfg: held.shopCfg, loginCfg: {},
      openHome: async () => { opens2 += 1; throw new Error('不得新开'); },
    }), /另一个恢复流程正在进行/);
    assert.equal(opens2, 0);
    assert.equal(hasChengfangManualReview(held.shopCfg), true, '最终鲜读期间 guard 不得提前解除');
  } finally {
    releaseRead();
  }
  const r1 = await p1;
  assert.equal(r1.recoveredFromManualReview, true);
  assert.equal(hasChengfangManualReview(held.shopCfg), false);
  await held.browser.close();
});

test('跨店隔离：A 店保留窗口不阻断 B 店正常打开', async () => {
  const held = await holdWithReviewWindow('overlay-shop-a');
  try {
    const domB = makeDom();
    const pageB = makePage({ dom: domB });
    const browserB = makeReviewBrowser(pageB);
    const contextB = { async storageState() { return { cookies: [] }; }, async cookies() { return [{ name: 'm', value: 'm' }]; } };
    const r = await openChengfangShop({
      shopCfg: { id: 'overlay-shop-b' },
      loginCfg: {},
      openHome: async () => ({ browser: browserB.browser, context: contextB, target: pageB, cookieSession: null }),
      sessionCheckpoint: async () => ({ saved: false, skipped: true, reason: 'test' }),
    });
    assert.equal(r.recoveredFromManualReview, undefined);
    assert.equal(hasChengfangManualReview({ id: 'overlay-shop-a' }), true, 'A 店 guard 不受影响');
    await browserB.browser.close();
  } finally {
    await held.browser.close();
  }
});

// ── 4) Cookie 检查点不掩盖原始错误 ──────────────────────────────────────

test('恢复成功但检查点抛错：不掩盖本次打开结果，如实记为 skipped', async () => {
  const held = await holdWithReviewWindow('overlay-checkpoint-throw');
  addIntro(held.reviewPage._dom.root);
  try {
    const r = await openChengfangShop({
      shopCfg: held.shopCfg,
      loginCfg: {},
      openHome: async () => { throw new Error('不得新开'); },
      sessionCheckpoint: async () => { throw new Error('checkpoint boom'); },
    });
    assert.equal(r.recoveredFromManualReview, true);
    assert.equal(r.cookieCheckpoint.saved, false);
    assert.equal(r.cookieCheckpoint.skipped, true);
    assert.match(r.cookieCheckpoint.reason, /checkpoint boom/);
  } finally {
    await held.browser.close();
  }
});

test('普通打开失败：检查点异常不掩盖原始错误', async () => {
  const dom = makeDom();
  const page = makePage({ url: 'https://qianchuan.jinritemai.com/home', dom });
  const { browser } = makeReviewBrowser(page);
  await assert.rejects(openChengfangShop({
    shopCfg: { id: 'overlay-original-error' },
    loginCfg: {},
    openHome: async () => ({ browser, context: { async storageState() { return { cookies: [] }; } }, target: page, cookieSession: null }),
    sessionCheckpoint: async () => { throw new Error('checkpoint boom'); },
  }), /导航"乘方"未到达管理页/);
});

// ── 5) 普通打开阶段也做有界浮窗关闭 ──────────────────────────────────────

test('普通打开阶段：已知浮窗被有界关闭，未知浮窗零点击', async () => {
  const dom = makeDom();
  const intro = addIntro(dom.root);
  const page = makePage({ dom });
  const { browser } = makeReviewBrowser(page);
  const r = await openChengfangShop({
    shopCfg: { id: 'overlay-normal-open' },
    loginCfg: {},
    openHome: async () => ({ browser, context: { async storageState() { return { cookies: [] }; } }, target: page, cookieSession: null }),
    sessionCheckpoint: async () => ({ saved: false, skipped: true, reason: 'test' }),
  });
  assert.ok(r.account);
  assert.equal(intro.closes[0].clicked, 1);

  // 未知浮层不是「打开成功」：必须在业务路径前阻断，且零点击。
  const dom2 = makeDom();
  const unknown = addUnknownModal(dom2.root);
  const page2 = makePage({ dom: dom2 });
  const b2 = makeReviewBrowser(page2);
  await assert.rejects(openChengfangShop({
    shopCfg: { id: 'overlay-normal-open-unknown' },
    loginCfg: {},
    openHome: async () => ({ browser: b2.browser, context: { async storageState() { return { cookies: [] }; } }, target: page2, cookieSession: null }),
    sessionCheckpoint: async () => ({ saved: false, skipped: true, reason: 'test' }),
  }), /浮窗阻断|unknown-overlay/);
  assert.equal(unknown.clicked, 0);
  await b2.browser.close();
});

test('子标签 ready 不是浮窗消失的证明：就绪后的未知浮窗仍阻断', async () => {
  const dom = makeDom();
  const page = makePage({ dom });
  const { browser } = makeReviewBrowser(page);
  let reads = 0;
  page._accountHook = async () => {
    reads += 1;
    // 第 1 次读取发生在普通导航后；第 2 次读取位于子标签等待循环，
    // 此时注入未知浮窗并让子标签就绪，验证最终复核不会拿 ready 当免死金牌。
    if (reads === 2) addUnknownModal(dom.root);
    return undefined;
  };
  await assert.rejects(openChengfangShop({
    shopCfg: { id: 'overlay-ready-then-unknown' },
    loginCfg: {},
    openHome: async () => ({
      browser,
      context: { async storageState() { return { cookies: [] }; } },
      target: page, cookieSession: null,
    }),
    sessionCheckpoint: async () => ({ saved: false, skipped: true, reason: 'test' }),
  }), /浮窗阻断/);
  await browser.close();
});

// ── 6) 真实脱敏 DOM 形状回归（F1-R5：分类回归补修）─────────────────────

/** 共享埋点属性 [data-e2e="oc_emptyKey_overall-prom"] 的普通非模态元素（导航/徽标/工具栏/popover）。 */
function addSharedE2eChrome(root) {
  const mk = (cls) => {
    const n = new FakeNode('div', { class: cls, 'data-e2e': 'oc_emptyKey_overall-prom' }, '导航/工具栏文案');
    root.appendChild(n);
    return n;
  };
  return [
    mk('ocean-vmok-plugin-navigator ocean-vmok-plugin-nav-absolute ocean-vmok-plugin-nav-transparent'),
    mk('ocean-vmok-plugin-oc-new-badge ocean-vmok-plugin-oc-new-badge-right'),
    mk('ocean-vmok-plugin-navigator-right-tool'),
    mk('ocean-vmok-plugin-oc-popover'),
  ];
}

/** 首页普通右侧货款直投卡片：270x190，只有业务"去开启"CTA，无跳过/我知道了/关闭。 */
function addFundGuide(root) {
  const card = new FakeNode('div', { class: 'productFundModuleGuide-BSA0DN' },
    '开启货款直投升级版，抢量快人一步!告别手动充值，一键操作效率高 精准预估消耗 按需转入不停投');
  root.appendChild(card);
  const cta = new FakeNode('button', { class: 'fund-cta' }, '去开启');
  card.appendChild(cta);
  return { card, cta };
}

/** 真实介绍 modal：modal-wrap 容器语义 + 唯一白名单 X。 */
function addRealModal(root, opts = {}) {
  const works = opts.works !== false;
  const wrap = new FakeNode('div', {
    class: 'tools-vmok-plugin-modal__wrap ocean-vmok-plugin-oc-modal-wrap overall-release-modal-v2-wrap',
    'data-e2e': 'oc_emptyKey_home',
  }, opts.text || '联盟合作达人自动投 抢占流量不错过');
  root.appendChild(wrap);
  const x = new FakeNode('span', { class: 'tools-vmok-plugin-modal__close-icon' });
  x.onClick = () => { if (works) removeNode(wrap); };
  wrap.appendChild(x);
  return { wrap, x };
}

// ① 共享E2E导航/徽标/工具栏/popover + 一个真实modal：只点modal唯一X，导航/业务零点击
test('共享E2E非模态元素 + 一个真实modal：只关真实modal唯一X，导航零点击', () => {
  const dom = makeDom();
  const chrome = addSharedE2eChrome(dom.root);
  const modal = addRealModal(dom.root);
  const r = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(r.trusted, true);
  assert.equal(r.state, 'dismissable');
  assert.equal(r.action, 'dismiss-intro');
  assert.equal(r.clicked, true);
  assert.ok(!r.blockers.some((b) => b.startsWith('multiple-intro')), '共享埋点不得再触发 multiple-intro');
  assert.equal(modal.x.clicked, 1, '只点真实modal唯一X');
  for (const c of chrome) assert.equal(c.clicked, 0, '导航/徽标/工具栏/popover 绝不点击');
});

// ② 单独 fundGuide 普通卡片：不报浮窗/零点击
test('普通货款直投卡片单独存在：不报浮窗（state none），不点去开启', () => {
  const dom = makeDom();
  const fund = addFundGuide(dom.root);
  const r = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'none');
  assert.equal(r.clicked, false);
  assert.equal(fund.cta.clicked, 0, '无浮层语义的业务卡片 CTA 绝不点击');
});

// ③ fundGuide + 真实modal：只关modal，不点"去开启"
test('货款直投卡片 + 真实modal：只关真实modal，不点业务"去开启"', () => {
  const dom = makeDom();
  const fund = addFundGuide(dom.root);
  const modal = addRealModal(dom.root);
  const r = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'dismissable');
  assert.equal(r.action, 'dismiss-intro');
  assert.equal(r.clicked, true);
  assert.equal(modal.x.clicked, 1);
  assert.equal(fund.cta.clicked, 0, '真实modal与货款卡片并存时仍只关modal');
});

// ④ 真实多个独立modal / 危险 / 未知：仍阻断（多候选保护未删）
test('多个独立真实modal / 危险文本：保留多候选阻断，不刷绿', () => {
  const a = makeDom();
  const m1 = addRealModal(a.root);
  const m2 = addRealModal(a.root);
  const ra = runInPage(handleChengfangOverlayInPage, { click: true }, { document: a.document, url: QC_URL });
  assert.equal(ra.state, 'blocked');
  assert.ok(ra.blockers.some((b) => b.startsWith('multiple-intro')), '两个真实独立modal仍必须阻断');
  assert.equal(m1.x.clicked, 0);
  assert.equal(m2.x.clicked, 0);

  const b = makeDom();
  const dm = addRealModal(b.root, { text: '确认删除这 30 条计划？删除后不可恢复' });
  const rb = runInPage(handleChengfangOverlayInPage, { click: true }, { document: b.document, url: QC_URL });
  assert.equal(rb.state, 'blocked');
  assert.ok(rb.blockers.includes('danger-text'));
  assert.equal(dm.x.clicked, 0);

  const c = makeDom();
  const um = addRealModal(c.root);
  addUnknownModal(c.root);
  const rc = runInPage(handleChengfangOverlayInPage, { click: true }, { document: c.document, url: QC_URL });
  assert.equal(rc.state, 'blocked');
  assert.ok(rc.blockers.some((x) => x.startsWith('unknown-overlay')));
  assert.equal(um.x.clicked, 0);
});

// ⑤ 单店正常打开完成dismiss后二次消失 + 独立工作路径checkpoint调用及源路径零写
test('正常同店恢复：dismiss 消失后实际调用 checkpoint，其 cookieSession.filePath 只指向推广值守独立副本', async () => {
  const f = baseFixture('overlay-cookie-workcopy');
  const reviewPage = makePage({ url: QC_URL });
  const { browser, reviewContext } = makeReviewBrowser(reviewPage);
  const sourceShared = {
    filePath: 'C:/mock/app/cookies/商品分析源店铺.json',
    startFingerprint: { sha256: 'deadbeef' },
    identityPage: { mock: 'original-context-page' },
  };
  const held = await retainChengfangPageForManualReview({
    context: f.context, target: f.target, shopCfg: f.shopCfg, loginCfg: {},
    browserFactory: async () => browser,
    cookieSession: { filePath: 'C:/mock/guard/cookies/推广值守独立工作副本.json', startFingerprint: sourceShared.startFingerprint, identityPage: sourceShared.identityPage },
  });
  assert.equal(held.held, true);
  const modal = addRealModal(reviewPage._dom.root);
  let checkpointArgs = null;
  try {
    const r = await openChengfangShop({
      shopCfg: f.shopCfg, loginCfg: {},
      openHome: async () => { throw new Error('不得新开'); },
      sessionCheckpoint: async (args) => { checkpointArgs = args; return { saved: true, skipped: false }; },
    });
    assert.equal(r.recoveredFromManualReview, true);
    assert.equal(modal.x.clicked, 1, '真实modal关闭后才继续');
    assert.ok(checkpointArgs, 'manager-ready checkpoint 必须实际被调用');
    assert.equal(checkpointArgs.context, reviewContext);
    assert.equal(checkpointArgs.target, reviewPage);
    assert.deepEqual(Object.keys(checkpointArgs.cookieSession).sort(), ['filePath', 'startFingerprint'],
      '仅传 filePath/startFingerprint，绝不带原 context identityPage');
    assert.equal(Object.prototype.hasOwnProperty.call(checkpointArgs.cookieSession, 'identityPage'), false);
    assert.equal(checkpointArgs.cookieSession.filePath, 'C:/mock/guard/cookies/推广值守独立工作副本.json',
      '只能走推广值守独立副本');
    assert.doesNotMatch(String(checkpointArgs.cookieSession.filePath), /app[\\/]cookies/, '绝不指回商品分析源Cookie');
    assert.notEqual(checkpointArgs.cookieSession.filePath, sourceShared.filePath, '不回写源路径');
  } finally {
    await browser.close();
  }
});

// ⑥ 保存冲突/错身份：checkpoint 返回 skipped，未知绝不谎报 saved
test('错身份/保存冲突：checkpoint skipped，绝不谎报 saved', async () => {
  const held = await holdWithReviewWindow('overlay-cookie-conflict');
  addRealModal(held.reviewPage._dom.root);
  try {
    const r = await openChengfangShop({
      shopCfg: held.shopCfg, loginCfg: {},
      openHome: async () => { throw new Error('不得新开'); },
      sessionCheckpoint: async () => ({ saved: false, skipped: true, reason: '身份冲突/未唯一匹配，未保存' }),
    });
    assert.equal(r.recoveredFromManualReview, true);
    assert.equal(r.cookieCheckpoint.saved, false, '缺正证据不得记为 saved');
    assert.equal(r.cookieCheckpoint.skipped, true);
    assert.match(r.cookieCheckpoint.reason, /身份冲突/);
  } finally {
    await held.browser.close();
  }
});

// ── 7) 无模型运行依赖 ──────────────────────────────────────────────────

test('实现无模型/网络运行依赖（纯页面探针 + mock 即可运行）', () => {
  const src = fs.readFileSync(require.resolve('../src/adapters/chengfang-reader'), 'utf8');
  assert.equal(/openai|anthropic|gemini|deepseek|codebuddy|chatgpt/i.test(src), false);
  const dom = makeDom();
  const page = makePage({ dom });
  assert.equal(typeof page.evaluate, 'function');
  assert.equal(runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL }).trusted, true);
});
