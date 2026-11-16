'use strict';

/**
 * 2026-11-13 简尚衣橱优品店：孤儿空壳 tools-vmok-plugin-popup__mask 最小修法回归。
 * 弹窗本体（modal wrap）不在 DOM，只剩零子节点/零文本/零关闭控件的全屏空壳遮罩，
 * 会滞留数小时至数天；唯一空壳孤儿遮罩 → dismissable（点击遮罩本身触发插件
 * backdrop 关闭监听），非空壳/多浮层/危险文本/并存已知弹窗一律维持 unknown 阻断。
 * - 既有附属遮罩路径（introRoots===1 紧邻兄弟）优先，无回归
 * - aurora-qc-loading-mask 瞬态（2026-11-01）无回归
 * - 点击后未消失 → not-disappeared，fail-closed 保留
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
  get nextElementSibling() {
    const s = this.parentNode ? this.parentNode.children : [];
    const i = s.indexOf(this);
    return i >= 0 ? (s[i + 1] || null) : null;
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
/** 真实 DOM 语义的文本节点（nodeType=3）：isEmptyMaskShell 按 childNodes 检查非空文本。 */
function addTextNode(el, text) {
  const n = { nodeType: 3, textContent: text, children: [], removed: false, className: '', getAttribute: () => null };
  el.childNodes.push(n);
  return n;
}
/** 生产取证形态：全屏 1920×1080 空壳遮罩，零子节点零文本；点击模拟插件 backdrop 关闭监听移除遮罩。 */
function addOrphanMask(root, attrs) {
  const mask = new FakeNode('div', Object.assign({
    class: 'tools-vmok-plugin-popup__mask',
    w: 1920,
    h: 1080,
    left: 0,
    top: 0,
  }, attrs || {}));
  mask.onClick = () => removeNode(mask);
  root.appendChild(mask);
  return mask;
}
/** 已知介绍弹窗（ocean-vmok-plugin-oc-modal-wrap + .aweme-auto-pull-modal-content），唯一可见关闭 X。 */
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
function addLoadingMask(root) {
  const mask = new FakeNode('div', { class: 'acss-1wxmyce aurora-qc-loading-mask', w: 1824, h: 86, left: 48, top: 343 });
  root.appendChild(mask);
  return mask;
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

test('O1 正向主链：孤儿空壳 mask → dismissable/dismiss-orphan-mask；点击移除后二次探针 none', () => {
  const dom = makeDom();
  const mask = addOrphanMask(dom.root);
  const probe = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL });
  assert.equal(probe.trusted, true);
  assert.equal(probe.state, 'dismissable');
  assert.equal(probe.kind, 'orphan-vmok-mask');
  assert.equal(probe.key, 'tools-vmok-plugin-popup__mask');
  assert.equal(probe.action, 'dismiss-orphan-mask');
  assert.equal(probe.clicked, false);
  assert.equal(probe.blockers.length, 0);
  assert.equal(mask.clicked, 0);

  const clicked = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(clicked.state, 'dismissable');
  assert.equal(clicked.clicked, true);
  assert.equal(clicked.action, 'dismiss-orphan-mask');
  assert.equal(mask.clicked, 1);
  assert.equal(mask.removed, true, '模拟插件响应点击移除遮罩');

  const after = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL });
  assert.equal(after.state, 'none');
});

test('O2 端到端：dismissKnownChengfangOverlays → dismissed，审计含 dismiss-orphan-mask/dismissed', async () => {
  const dom = makeDom();
  const mask = addOrphanMask(dom.root);
  const { page, audits, audit } = makeScriptedPage(dom);
  const r = await dismissKnownChengfangOverlays({ page, audit, shopId: '简尚衣橱优品店', gapMs: 5 });
  assert.equal(r.dismissed, true);
  assert.equal(r.state, 'none');
  assert.equal(r.action, 'dismiss-orphan-mask');
  assert.equal(mask.clicked, 1);
  assert.equal(mask.removed, true);
  const dismissedEvents = audits.filter((a) => a.action === 'dismiss-orphan-mask' && a.result === 'dismissed');
  assert.equal(dismissedEvents.length, 1);
  assert.equal(dismissedEvents[0].kind, 'chengfang-overlay');
  assert.equal(dismissedEvents[0].shopId, '简尚衣橱优品店');
  assert.ok(!audits.some((a) => a.result === 'blocked'));
});

test('O3 mask 含 1 个元素子节点 → 仍 unknown-overlay:1 blocked（不放宽）', () => {
  const dom = makeDom();
  const mask = addOrphanMask(dom.root);
  mask.appendChild(new FakeNode('span', {}, ''));
  const r = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'blocked');
  assert.ok(r.blockers.includes('unknown-overlay:1'));
  assert.notEqual(r.kind, 'orphan-vmok-mask');
  assert.equal(mask.clicked, 0);
});

test('O4 mask 含非空文本节点 → 仍 unknown-overlay:1 blocked', () => {
  const dom = makeDom();
  const mask = new FakeNode('div', { class: 'tools-vmok-plugin-popup__mask', w: 1920, h: 1080 });
  addTextNode(mask, '提示内容');
  dom.root.appendChild(mask);
  const r = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'blocked');
  assert.ok(r.blockers.includes('unknown-overlay:1'));
  assert.equal(mask.clicked, 0);
});

test('O5 回归附属遮罩：mask + 已知 intro 同父紧邻兄弟 → 既有 intro/dismiss-intro 路径，孤儿分支不接管', () => {
  const dom = makeDom();
  const mask = addOrphanMask(dom.root);
  const ov = addIntro(dom.root, { withClose: true });
  assert.equal(mask.nextElementSibling, ov.wrap, 'fixture 必须同父紧邻');
  const probe = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL });
  assert.equal(probe.state, 'dismissable');
  assert.equal(probe.kind, 'intro');
  assert.equal(probe.action, 'dismiss-intro');
  assert.ok(probe.affiliatedMask, '必须走既有附属遮罩归属');
  assert.equal(probe.affiliatedMask.cls, 'tools-vmok-plugin-popup__mask');
  assert.equal(probe.blockers.length, 0);

  const clicked = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(clicked.clicked, true);
  assert.equal(clicked.action, 'dismiss-intro');
  assert.equal(ov.x.clicked, 1);
  assert.equal(mask.clicked, 0, '附属路径绝不点遮罩本身');
  assert.equal(ov.cta.clicked, 0);
});

test('O6 两个空壳 mask（foreign=2）→ unknown-overlay:2 blocked，零点击', () => {
  const dom = makeDom();
  const m1 = addOrphanMask(dom.root);
  const m2 = addOrphanMask(dom.root);
  const r = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'blocked');
  assert.ok(r.blockers.includes('unknown-overlay:2'));
  assert.equal(m1.clicked, 0);
  assert.equal(m2.clicked, 0);
});

test('O7 mask 与危险文本并存 → danger 优先 blocked，零点击', () => {
  const dom = makeDom();
  const mask = addOrphanMask(dom.root);
  const dialog = new FakeNode('div', { role: 'dialog' }, '确认删除这 30 条计划？删除后不可恢复');
  dom.root.appendChild(dialog);
  const r = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'blocked');
  assert.ok(r.blockers.includes('danger-text'));
  assert.equal(mask.clicked, 0);
});

test('O8 端到端 fail-closed：点击后遮罩不消失 → not-disappeared，审计 failed', async () => {
  const dom = makeDom();
  const mask = addOrphanMask(dom.root);
  mask.onClick = null; // 插件未响应点击：遮罩滞留
  const { page, audits, audit } = makeScriptedPage(dom);
  const r = await dismissKnownChengfangOverlays({ page, audit, shopId: '简尚衣橱优品店', gapMs: 5 });
  assert.equal(r.dismissed, false);
  assert.equal(r.state, 'not-disappeared');
  assert.equal(r.action, 'dismiss-orphan-mask');
  assert.equal(mask.clicked, 1);
  assert.equal(mask.removed, false);
  const failed = audits.filter((a) => a.action === 'dismiss-orphan-mask' && a.result === 'failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].reason, /未消失/);
  assert.ok(!audits.some((a) => a.result === 'dismissed'));
});

test('O9 回归 aurora（2026-11-01）：空壳 aurora-qc-loading-mask 单独存在 → 仍 transient，零点击', () => {
  const dom = makeDom();
  const mask = addLoadingMask(dom.root);
  const r = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'transient');
  assert.equal(r.kind, 'aurora-qc-loading-mask');
  assert.equal(r.clicked, false);
  assert.equal(mask.clicked, 0);
});

test('O10 token 精确：类名仅含 mask 子串但无精确 token → 仍 blocked，不误认孤儿', () => {
  const dom = makeDom();
  const mask = new FakeNode('div', { class: 'foo-tools-vmok-plugin-popup__mask-bar', w: 1920, h: 1080 });
  dom.root.appendChild(mask);
  const r = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'blocked');
  assert.ok(r.blockers.includes('unknown-overlay:1'));
  assert.equal(mask.clicked, 0);
});

test('O11 无浮窗 none：行为不变', async () => {
  const dom = makeDom();
  const { page, audits, audit } = makeScriptedPage(dom);
  const r = await dismissKnownChengfangOverlays({ page, audit, gapMs: 5 });
  assert.equal(r.state, 'none');
  assert.equal(r.dismissed, false);
  assert.equal(page._n, 1);
  assert.equal(audits.length, 0);
});