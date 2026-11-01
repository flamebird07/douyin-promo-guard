'use strict';

/**
 * 2026-11-01 简尚衣橱优品店：空壳 aurora-qc-loading-mask 最小修法回归。
 * - 精确空壳 → transient，有界重读，消失后 none，全程零点击
 * - 持续存在至预算耗尽 → blocked，零点击
 * - 畸形 / 与其它弹窗并存 → 立即 blocked
 * - intro / guide / side-panel / danger 既有路径不破
 *
 * 隔离：mock DOM/VM；不触网、不开浏览器。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const {
  handleChengfangOverlayInPage,
  dismissKnownChengfangOverlays,
} = require('../src/adapters/chengfang-reader');

const QC_URL = 'https://qianchuan.jinritemai.com/overall-prom';

class FakeNode {
  constructor(tag, attrs, text) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.attrs = Object.assign({}, attrs || {});
    this.className = this.attrs.class || '';
    this.children = [];
    this.childNodes = this.children;
    this.parentElement = null;
    this.parentNode = null;
    this.ownText = text || '';
    this.visible = this.attrs.visible !== false;
    this.removed = false;
    this.clicked = 0;
    this.onClick = null;
    this.nodeType = 1;
  }
  get textContent() {
    if (this.removed) return '';
    return this.ownText + this.children.map((c) => c.textContent).join('');
  }
  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? String(this.attrs[name]) : null;
  }
  appendChild(child) {
    child.parentElement = this;
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    child.parentElement = null;
    child.parentNode = null;
  }
  getBoundingClientRect() {
    if (!this.visible || this.removed) return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
    const w = Number(this.attrs.w) || 120;
    const h = Number(this.attrs.h) || 40;
    const left = Number(this.attrs.left) || 0;
    const top = Number(this.attrs.top) || 0;
    return { width: w, height: h, top, left, right: left + w, bottom: top + h };
  }
  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }
  click() { this.clicked += 1; if (typeof this.onClick === 'function') this.onClick(this); }
  querySelectorAll(sel) { return queryAll(this, sel); }
  querySelector(sel) { return queryAll(this, sel)[0] || null; }
  matches(sel) { return matchSelector(this, sel); }
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
    const actual = node.getAttribute(m[1]);
    if (actual == null) return false;
    if (!m[2]) continue;
    if (m[2] === '=' && actual !== m[3]) return false;
    if (m[2] === '*=' && !actual.includes(m[3])) return false;
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
  root.tagName = 'BODY';
  return {
    root,
    document: {
      body: root,
      documentElement: root,
      querySelectorAll: (sel) => queryAll(root, sel),
      querySelector: (sel) => queryAll(root, sel)[0] || null,
    },
  };
}
function runInPage(fn, arg, env) {
  const ctx = vm.createContext({
    document: env.document,
    location: { href: env.url },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', content: 'none', position: 'static', transform: 'none' }),
    URL,
    Node: { TEXT_NODE: 3, ELEMENT_NODE: 1 },
    console,
    setTimeout,
  });
  const call = arg === undefined ? 'undefined' : JSON.stringify(arg);
  return vm.runInContext(`(${fn.toString()})(${call})`, ctx);
}
function removeNode(node) {
  node.removed = true;
  if (node.parentElement) node.parentElement.removeChild(node);
}
function addLoadingMask(root, attrs) {
  const mask = new FakeNode('div', Object.assign({
    class: 'acss-1wxmyce aurora-qc-loading-mask',
    w: 1824,
    h: 86,
    left: 48,
    top: 343,
  }, attrs || {}));
  root.appendChild(mask);
  return mask;
}
function addIntro(root, { withClose } = {}) {
  const wrap = new FakeNode('div', { class: 'tools-vmok-plugin-modal__wrap ocean-vmok-plugin-oc-modal-wrap' });
  root.appendChild(wrap);
  const inner = new FakeNode('div', { class: 'aweme-auto-pull-modal-content' }, '开启联盟合作达人自动投');
  wrap.appendChild(inner);
  const cta = new FakeNode('button', { class: 'tools-vmok-plugin-button' }, '新建自动投放计划');
  inner.appendChild(cta);
  let x = null;
  if (withClose) {
    x = new FakeNode('div', { class: 'tools-vmok-plugin-modal__close-icon' });
    x.onClick = () => removeNode(wrap);
    inner.appendChild(x);
  }
  return { wrap, cta, x };
}
function addGuide(root) {
  const g = new FakeNode('div', { class: 'productFundModuleGuide' });
  root.appendChild(g);
  const skip = new FakeNode('button', {}, '跳过');
  skip.onClick = () => removeNode(g);
  g.appendChild(skip);
  return { g, skip };
}
function makeScriptedPage(dom, opts = {}) {
  const audits = [];
  const page = {
    _n: 0,
    _url: QC_URL,
    async evaluate(fn, arg) {
      page._n += 1;
      if (typeof opts.beforeProbe === 'function') opts.beforeProbe(page._n, dom);
      return runInPage(fn, arg, { document: dom.document, url: page._url });
    },
    async waitForTimeout(ms) { await new Promise((r) => setTimeout(r, Math.min(ms, 5))); },
  };
  const audit = (e) => audits.push(e);
  return { page, audits, audit };
}

test('L1 精确空壳 loading mask：探针 → transient（非 none/blocked），零点击', () => {
  const dom = makeDom();
  const mask = addLoadingMask(dom.root);
  const r = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL });
  assert.equal(r.trusted, true);
  assert.equal(r.state, 'transient');
  assert.equal(r.kind, 'aurora-qc-loading-mask');
  assert.equal(r.clicked, false);
  assert.equal(r.action, 'none');
  assert.equal(mask.clicked, 0);
  assert.ok(r.transient && r.transient.waitable === true);
});

test('L2 空壳 mask 数次后消失 → 有界重读 + 最终 none，零点击', async () => {
  const dom = makeDom();
  const mask = addLoadingMask(dom.root);
  const { page, audits, audit } = makeScriptedPage(dom, {
    beforeProbe: (n) => { if (n === 3) removeNode(mask); },
  });
  const r = await dismissKnownChengfangOverlays({
    page, audit, shopId: '简尚衣橱优品店',
    transientGapMs: 5, transientBudgetMs: 2000, maxTransientRereads: 10,
  });
  assert.equal(r.state, 'none');
  assert.equal(r.dismissed, false);
  assert.equal(mask.clicked, 0);
  const rereads = audits.filter((a) => a.result === 'transient-reread');
  assert.ok(rereads.length >= 1, '必须留下 transient-reread 审计');
  assert.match(rereads[0].reason, /aurora-qc-loading-mask/);
  assert.ok(page._n >= 3);
});

test('L3 空壳 mask 持续至预算耗尽 → blocked，零点击，不放行', async () => {
  const dom = makeDom();
  const mask = addLoadingMask(dom.root);
  const { page, audits, audit } = makeScriptedPage(dom);
  const r = await dismissKnownChengfangOverlays({
    page, audit, shopId: '简尚衣橱优品店',
    transientGapMs: 1, transientBudgetMs: 60000, maxTransientRereads: 3,
  });
  assert.equal(r.dismissed, false);
  assert.equal(r.state, 'blocked');
  assert.equal(r.reason, 'unknown-overlay:1');
  assert.equal(mask.clicked, 0);
  assert.equal(page._n, 4, '首次 + 3 次有界重读');
  assert.equal(audits.filter((a) => a.result === 'transient-reread').length, 3);
  assert.ok(audits.some((a) => a.result === 'blocked'));
});

test('L4 畸形：同 class 带文本 → 立即 blocked，不进 transient', () => {
  const dom = makeDom();
  const mask = new FakeNode('div', { class: 'acss-1wxmyce aurora-qc-loading-mask' }, '加载中');
  dom.root.appendChild(mask);
  const r = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'blocked');
  assert.ok(r.blockers.some((b) => b.startsWith('unknown-overlay')));
  assert.notEqual(r.state, 'transient');
});

test('L5 畸形：同 class 带元素子节点 → 立即 blocked', () => {
  const dom = makeDom();
  const mask = addLoadingMask(dom.root);
  mask.appendChild(new FakeNode('span', {}, ''));
  const r = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'blocked');
  assert.ok(r.blockers.some((b) => b.startsWith('unknown-overlay')));
});

test('L6 并存：空壳 mask + 未知弹窗 → 立即 blocked，零重读', async () => {
  const dom = makeDom();
  const mask = addLoadingMask(dom.root);
  const other = new FakeNode('div', { class: 'ovui-modal' }, 'unknown biz');
  dom.root.appendChild(other);
  const { page, audits, audit } = makeScriptedPage(dom);
  const r = await dismissKnownChengfangOverlays({
    page, audit, transientGapMs: 1, transientBudgetMs: 3000,
  });
  assert.equal(r.state, 'blocked');
  assert.equal(page._n, 1, '并存不得触发 transient 重读');
  assert.equal(mask.clicked, 0);
  assert.equal(other.clicked, 0);
  assert.equal(audits.filter((a) => a.result === 'transient-reread').length, 0);
});

test('L7 并存：空壳 mask + intro → 立即 blocked（不吞 intro）', () => {
  const dom = makeDom();
  addLoadingMask(dom.root);
  addIntro(dom.root, { withClose: true });
  const r = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'blocked');
  assert.ok(r.blockers.some((b) => b.startsWith('unknown-overlay')));
});

test('L8 模糊 substring 不得误伤：类名仅含 loading-mask 子串但无精确 token → blocked/非 transient', () => {
  const dom = makeDom();
  const mask = new FakeNode('div', { class: 'acss-x foo-aurora-qc-loading-mask-bar' });
  dom.root.appendChild(mask);
  const r = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL });
  assert.notEqual(r.state, 'transient');
  assert.equal(r.state, 'blocked');
});

test('L9 回归 intro：唯一关闭 X 仍 dismissable，业务 CTA 零点击', () => {
  const dom = makeDom();
  const ov = addIntro(dom.root, { withClose: true });
  const r = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'dismissable');
  assert.equal(r.clicked, true);
  assert.equal(r.action, 'dismiss-intro');
  assert.equal(ov.x.clicked, 1);
  assert.equal(ov.cta.clicked, 0);
});

test('L10 回归 guide：唯一跳过仍可关', () => {
  const dom = makeDom();
  const g = addGuide(dom.root);
  const r = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'dismissable');
  assert.equal(r.kind, 'guide');
  assert.equal(r.clicked, true);
  assert.equal(g.skip.clicked, 1);
});

test('L11 回归 danger-text：确认删除仍立即阻断，零点击', () => {
  const dom = makeDom();
  const wrap = new FakeNode('div', { class: 'tools-vmok-plugin-modal__wrap' }, '确认删除这 30 条计划？删除后不可恢复');
  dom.root.appendChild(wrap);
  const x = new FakeNode('div', { class: 'tools-vmok-plugin-modal__close-icon' });
  wrap.appendChild(x);
  const r = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'blocked');
  assert.ok(r.blockers.includes('danger-text'));
  assert.equal(x.clicked, 0);
});

test('L12 click:true 遇上空壳 mask：仍 transient/不点击（绝不可点 mask）', () => {
  const dom = makeDom();
  const mask = addLoadingMask(dom.root);
  const r = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'transient');
  assert.equal(r.clicked, false);
  assert.equal(mask.clicked, 0);
});

test('L13 无浮窗 none：行为不变', async () => {
  const dom = makeDom();
  const { page, audits, audit } = makeScriptedPage(dom);
  const r = await dismissKnownChengfangOverlays({ page, audit, transientGapMs: 1, transientBudgetMs: 3000 });
  assert.equal(r.state, 'none');
  assert.equal(page._n, 1);
  assert.equal(audits.length, 0);
});
