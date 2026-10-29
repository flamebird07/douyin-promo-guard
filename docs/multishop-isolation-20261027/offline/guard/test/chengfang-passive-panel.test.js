'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { handleChengfangOverlayInPage, dismissKnownChengfangOverlays } = require('../src/adapters/chengfang-reader');

class Element {
  constructor(tag = 'div', attrs = {}, text = '', rect = null) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = attrs;
    this.className = attrs.class || '';
    this.childNodes = text ? [{ nodeType: 3, textContent: text }] : [];
    this.rect = rect;
    this.parentNode = null;
    this.clicked = 0;
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  get nextElementSibling() {
    const siblings = this.parentNode ? this.parentNode.children : [];
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  getAttribute(key) { return Object.hasOwn(this.attrs, key) ? String(this.attrs[key]) : null; }
  append(node) { node.parentNode = this; this.childNodes.push(node); return node; }
  remove() {
    if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter((n) => n !== this);
    this.parentNode = null;
    this.removed = true;
  }
  contains(node) {
    for (let p = node; p; p = p.parentNode) if (p === this) return true;
    return false;
  }
  getBoundingClientRect() {
    for (let p = this; p; p = p.parentNode) {
      if (p.removed || p.attrs.display === 'none' || p.attrs.visibility === 'hidden') return { left: 0, top: 0, width: 0, height: 0 };
    }
    return this.rect || (this.parentNode && this.parentNode.getBoundingClientRect()) || { left: 0, top: 0, width: 1920, height: 1080 };
  }
  matches(selector) {
    return selector.split(',').some((part) => {
      const s = part.trim();
      const tag = /^([\w-]+)/.exec(s);
      if (tag && tag[1].toUpperCase() !== this.tagName) return false;
      for (const cls of s.match(/\.[\w-]+/g) || []) if (!this.className.split(/\s+/).includes(cls.slice(1))) return false;
      for (const m of s.matchAll(/\[([\w-]+)(?:([*]?=)"([^"]*)")?\]/g)) {
        const value = this.getAttribute(m[1]);
        if (value === null || (m[2] === '=' && value !== m[3]) || (m[2] === '*=' && !value.includes(m[3]))) return false;
      }
      return !this.removed;
    });
  }
  querySelectorAll(selector) {
    const found = [];
    const visit = (parent) => {
      for (const child of parent.children) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  click() { this.clicked++; if (this.onClick) this.onClick(); }
}

function fixture({ close = false, obstruction = false } = {}) {
  const body = new Element('body');
  const target = body.append(new Element('button', { type: 'button', role: 'tab' }, '计划视图', {
    left: obstruction ? 1520 : 300, top: obstruction ? 550 : 180, width: 120, height: 32,
  }));
  const panel = body.append(new Element('div', { class: 'launcher_popupSlot__1C2rh' }, '', {
    left: 1502, top: 449, width: 360, height: 471,
  }));
  const content = panel.append(new Element('div', { class: 'floatball-popup-container' }, '合成侧边帮助面板'));
  const document = {
    body, documentElement: { clientWidth: 1920, clientHeight: 1080 },
    querySelectorAll: (s) => body.querySelectorAll(s),
    elementFromPoint(x, y) {
      return body.querySelectorAll('*').reverse().find((node) => {
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && x >= r.left && x < r.left + r.width && y >= r.top && y < r.top + r.height;
      }) || body;
    },
  };
  Object.defineProperty(document, 'cookie', { get() { throw new Error('Cookie access forbidden'); } });
  const dom = { body, target, panel, content, document, href: 'https://qianchuan.jinritemai.com/overall-prom' };
  dom.addClose = () => {
    const button = content.append(new Element('button', { type: 'button', 'aria-label': '关闭' }, '×', {
      left: 1826, top: 461, width: 24, height: 24,
    }));
    button.onClick = () => panel.remove();
    return button;
  };
  if (close) dom.close = dom.addClose();
  return dom;
}

function probe(dom, options = { click: false }) {
  const context = vm.createContext({
    document: dom.document, location: { href: dom.href }, URL,
    getComputedStyle: (node, pseudo) => pseudo
      ? { content: node.attrs.pseudoContent || 'none', position: node.attrs.pseudoPosition || 'static', display: 'block' }
      : { display: node.attrs.display || 'block', visibility: node.attrs.visibility || 'visible' },
  });
  return JSON.parse(JSON.stringify(vm.runInContext(`(${handleChengfangOverlayInPage.toString()})(${JSON.stringify(options)})`, context)));
}

function zeroClicks(dom) {
  for (const node of dom.body.querySelectorAll('*')) assert.equal(node.clicked, 0);
  assert.equal(dom.target.clicked, 0);
}

function pageFor(dom, beforeEvaluate) {
  let count = 0;
  return {
    async evaluate(fn, options) {
      assert.equal(fn, handleChengfangOverlayInPage);
      if (beforeEvaluate) beforeEvaluate(++count, options);
      return probe(dom, options);
    },
    async waitForTimeout() {},
  };
}

test('a non-modal side panel does not block unobstructed targets solely by popup class', () => {
  const dom = fixture();
  const result = probe(dom, { click: true });
  assert.equal(result.state, 'none');
  assert.deepEqual(result.sidePanels, [{ obstructed: false, checkedTargets: 1, close: false }]);
  assert.equal(result.clicked, false);
  assert.doesNotMatch(JSON.stringify(result), /合成侧边帮助面板/);
  zeroClicks(dom);
});

test('classification uses evidence, not a launcher class whitelist', () => {
  const dom = fixture();
  dom.panel.attrs.class = dom.panel.className = 'unfamiliar-popup';
  assert.equal(probe(dom).state, 'none');
  dom.panel.rect.left = 700;
  assert.equal(probe(dom).state, 'blocked');
  zeroClicks(dom);
});

test('an unknown panel covering an actual target without a safe close stays blocked', () => {
  const dom = fixture({ obstruction: true });
  assert.equal(probe(dom, { click: true }).state, 'blocked');
  zeroClicks(dom);
});

test('geometric overlap with a non-intercepting panel is not mistaken for obstruction', () => {
  const dom = fixture({ obstruction: true });
  dom.document.elementFromPoint = () => dom.target;
  assert.equal(probe(dom, { click: true }).state, 'none');
  zeroClicks(dom);
});

test('viewport and hit-test evidence are required', () => {
  for (const missing of ['viewport', 'hit-test', 'target']) {
    const dom = fixture();
    if (missing === 'viewport') delete dom.document.documentElement.clientWidth;
    if (missing === 'hit-test') delete dom.document.elementFromPoint;
    if (missing === 'target') dom.target.remove();
    assert.equal(probe(dom, { click: true }).state, 'blocked');
    zeroClicks(dom);
  }
});

test('modal, transparent backdrop, nested dialog and overflowing descendants cannot pass', () => {
  for (const kind of ['role', 'aria', 'native', 'backdrop', 'nested', 'overflow', 'pseudo', 'large']) {
    const dom = fixture({ close: true });
    if (kind === 'role') dom.panel.attrs.role = 'dialog';
    if (kind === 'aria') dom.panel.attrs['aria-modal'] = 'true';
    if (kind === 'native') dom.body.append(new Element('dialog', { open: '' }, '原生对话框'));
    if (kind === 'backdrop') dom.body.append(new Element('div', { class: 'transparent-backdrop' }));
    if (kind === 'nested') dom.content.append(new Element('div', { role: 'alertdialog' }, '请确认'));
    if (kind === 'overflow') dom.content.append(new Element('div', {}, '', { left: 0, top: 0, width: 1920, height: 1080 }));
    if (kind === 'pseudo') Object.assign(dom.panel.attrs, { pseudoContent: '" "', pseudoPosition: 'fixed' });
    if (kind === 'large') dom.panel.rect = { left: 0, top: 0, width: 1920, height: 1080 };
    assert.equal(probe(dom, { click: true }).state, 'blocked', kind);
    zeroClicks(dom);
  }
});

test('overflow hit-testing cannot be bypassed by a small root rectangle', () => {
  const dom = fixture();
  dom.document.elementFromPoint = () => dom.content;
  assert.equal(probe(dom, { click: true }).state, 'blocked');
  zeroClicks(dom);
});

test('unique visible top-right close is preferred and does not click any page X or business action', () => {
  const dom = fixture({ close: true });
  const otherX = dom.body.append(new Element('button', { type: 'button' }, '×', { left: 20, top: 20, width: 24, height: 24 }));
  const business = dom.content.append(new Element('button', { type: 'button' }, '去开启', { left: 1600, top: 800, width: 100, height: 32 }));
  const result = probe(dom, { click: true });
  assert.equal(result.action, 'dismiss-side-panel');
  assert.equal(result.clicked, true);
  assert.equal(dom.close.clicked, 1);
  assert.equal(otherX.clicked, 0);
  assert.equal(business.clicked, 0);
  assert.equal(dom.target.clicked, 0);
});

test('ambiguous, occluded, misplaced, disabled or submit close controls cause zero clicks', () => {
  for (const kind of ['duplicate', 'occluded', 'misplaced', 'disabled', 'submit']) {
    const dom = fixture({ close: true, obstruction: true });
    if (kind === 'duplicate') dom.addClose();
    if (kind === 'occluded') dom.document.elementFromPoint = () => dom.content;
    if (kind === 'misplaced') dom.close.rect.top = 820;
    if (kind === 'disabled') dom.close.disabled = true;
    if (kind === 'submit') dom.close.attrs.type = 'submit';
    assert.equal(probe(dom, { click: true }).state, 'blocked', kind);
    zeroClicks(dom);
  }
});

test('dangerous business confirmations and login/security prompts never get a close click', () => {
  for (const text of ['确认删除计划', '确认暂停计划', '授权登录', '扫码登录', '请输入验证码', '安全验证']) {
    const dom = fixture({ close: true });
    dom.content.childNodes.unshift({ nodeType: 3, textContent: text });
    assert.equal(probe(dom, { click: true }).state, 'blocked', text);
    zeroClicks(dom);
  }
  const dom = fixture({ close: true });
  dom.href = 'https://qianchuan.jinritemai.com/login';
  assert.equal(probe(dom, { click: true }).state, 'blocked');
  zeroClicks(dom);
});

test('known intro closing still uses its original scoped control', () => {
  const dom = fixture();
  dom.panel.remove();
  const intro = dom.body.append(new Element('div', { class: 'ocean-vmok-plugin-oc-modal-wrap' }));
  const close = intro.append(new Element('span', { class: 'tools-vmok-plugin-modal__close-icon' }));
  const business = intro.append(new Element('button', {}, '去开启'));
  close.onClick = () => intro.remove();
  assert.equal(probe(dom, { click: true }).action, 'dismiss-intro');
  assert.equal(close.clicked, 1);
  assert.equal(business.clicked, 0);
});

test('wrapper around a known intro cannot swallow a sibling business dialog', () => {
  const dom = fixture();
  dom.content.append(new Element('div', { class: 'ocean-vmok-plugin-oc-modal-wrap' }))
    .append(new Element('span', { class: 'tools-vmok-plugin-modal__close-icon' }));
  dom.content.append(new Element('div', { role: 'dialog' }, '独立确认'));
  assert.equal(probe(dom, { click: true }).state, 'blocked');
  zeroClicks(dom);
});

test('side-panel inspection remains bounded', () => {
  const dom = fixture({ close: true });
  for (let i = 0; i < 220; i++) dom.content.append(new Element('span'));
  assert.equal(probe(dom, { click: true }).state, 'blocked');
  zeroClicks(dom);
});

test('close success requires two disappearance probes', async () => {
  const dom = fixture({ close: true, obstruction: true });
  const probes = [];
  const audit = [];
  const result = await dismissKnownChengfangOverlays({
    page: pageFor(dom, (count, options) => probes.push(options)), shopId: 'fixture-shop', audit: (e) => audit.push(e), gapMs: 0,
  });
  assert.equal(result.dismissed, true);
  assert.equal(result.action, 'dismiss-side-panel');
  assert.equal(dom.close.clicked, 1);
  assert.equal(probes.filter((p) => p.requirePanelGone === true).length, 2);
  assert.equal(audit.at(-1).result, 'dismissed');
});

test('closing only the button does not falsely confirm disappearance of a passive panel', async () => {
  const dom = fixture({ close: true });
  dom.close.onClick = () => dom.close.remove();
  const result = await dismissKnownChengfangOverlays({ page: pageFor(dom), gapMs: 0 });
  assert.equal(result.dismissed, false);
  assert.equal(result.state, 'not-disappeared');
  assert.equal(dom.close.clicked, 1);
});

test('a panel that remains after clicking is not blindly retried', async () => {
  const dom = fixture({ close: true });
  dom.close.onClick = () => {};
  const result = await dismissKnownChengfangOverlays({ page: pageFor(dom), gapMs: 0 });
  assert.equal(result.state, 'not-disappeared');
  assert.equal(dom.close.clicked, 1);
});

test('reappearance during the second disappearance probe is not reported as success', async () => {
  const dom = fixture({ close: true });
  const page = pageFor(dom, (count) => {
    if (count === 4) { dom.panel.removed = false; dom.body.append(dom.panel); }
  });
  const result = await dismissKnownChengfangOverlays({ page, gapMs: 0 });
  assert.equal(result.state, 'not-disappeared');
  assert.equal(dom.close.clicked, 1);
});

test('click-time probe rechecks newly appeared dangerous content', async () => {
  const dom = fixture({ close: true });
  const page = pageFor(dom, (count) => {
    if (count === 2) dom.content.childNodes.push({ nodeType: 3, textContent: '确认删除计划' });
  });
  const result = await dismissKnownChengfangOverlays({ page, gapMs: 0 });
  assert.equal(result.dismissed, false);
  zeroClicks(dom);
});
