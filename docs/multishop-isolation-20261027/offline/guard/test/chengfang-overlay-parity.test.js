'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const {
  handleChengfangOverlayInPage,
  advanceChengfangPlanViewInPage,
  dismissKnownChengfangOverlays,
} = require('../src/adapters/chengfang-reader');

const QC_URL = 'https://qianchuan.jinritemai.com/overall-prom';

class FakeNode {
  constructor(tag = 'div', attrs = {}, text = '') {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.className = attrs.class || '';
    this.childNodes = [];
    this.parentNode = null;
    this.clicked = 0;
    this.removed = false;
    this.rect = { left: 12.5, top: -3.25, width: 120.5, height: 40.25 };
    if (text) this.childNodes.push({ nodeType: 3, textContent: text });
  }

  get children() { return this.childNodes.filter((node) => node.nodeType === 1); }
  get textContent() { return this.childNodes.map((node) => node.textContent).join(''); }
  get nextElementSibling() {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }

  getAttribute(name) {
    return Object.prototype.hasOwnProperty.call(this.attrs, name) ? String(this.attrs[name]) : null;
  }

  appendChild(node) {
    node.parentNode = this;
    this.childNodes.push(node);
    return node;
  }

  remove() {
    this.removed = true;
    if (this.parentNode) {
      this.parentNode.childNodes = this.parentNode.childNodes.filter((node) => node !== this);
      this.parentNode = null;
    }
  }

  getBoundingClientRect() {
    for (let node = this; node; node = node.parentNode) {
      if (node.removed || node.attrs.display === 'none' || node.attrs.visible === false) {
        return { left: 0, top: 0, width: 0, height: 0 };
      }
    }
    return this.rect;
  }

  contains(node) {
    for (let current = node; current; current = current.parentNode) {
      if (current === this) return true;
    }
    return false;
  }

  matches(selector) {
    return selector.split(',').some((part) => {
      const compound = part.trim();
      const tag = /^([a-zA-Z][\w-]*)/.exec(compound);
      if (tag && this.tagName !== tag[1].toUpperCase()) return false;
      for (const cls of compound.match(/\.([\w-]+)/g) || []) {
        if (!this.className.split(/\s+/).includes(cls.slice(1))) return false;
      }
      for (const match of compound.matchAll(/\[([\w-]+)(?:([*]?=)"([^"]*)")?\]/g)) {
        const actual = this.getAttribute(match[1]);
        if (actual === null) return false;
        if (match[2] === '=' && actual !== match[3]) return false;
        if (match[2] === '*=' && !actual.includes(match[3])) return false;
      }
      return !this.removed;
    });
  }

  querySelectorAll(selector) {
    const found = [];
    const visit = (root) => {
      for (const child of root.children) {
        if (child.removed) continue;
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  click() {
    this.clicked += 1;
    if (this.onClick) this.onClick();
  }
}

function makeDom() {
  const body = new FakeNode('body');
  const queries = [];
  const document = {
    body,
    documentElement: new FakeNode('html'),
    querySelectorAll(selector) {
      queries.push(selector);
      return body.querySelectorAll(selector);
    },
  };
  Object.defineProperty(document, 'cookie', { get() { throw new Error('PRIVATE_COOKIE_ACCESS'); } });
  return { body, document, queries };
}

function runInPage(dom, options = { click: false }, fn = handleChengfangOverlayInPage) {
  const context = vm.createContext({
    document: dom.document,
    location: { href: QC_URL },
    URL,
    getComputedStyle(node) {
      let visibility = 'visible';
      for (let current = node; current; current = current.parentNode) {
        if (current.attrs.visibility) { visibility = current.attrs.visibility; break; }
      }
      return { display: node.attrs.display || 'block', visibility };
    },
  });
  const result = vm.runInContext(`(${fn.toString()})(${JSON.stringify(options)})`, context);
  return JSON.parse(JSON.stringify(result));
}

function addUnknown(parent, text = '') {
  return parent.appendChild(new FakeNode('div', { class: 'launcher_popupSlot__1C2rh' }, text));
}

function addIntro(parent, { v2 = false, count = 1, text = '', works = true } = {}) {
  const root = parent.appendChild(new FakeNode('div', {
    class: 'ocean-vmok-plugin-oc-modal-wrap' + (v2 ? ' overall-release-modal-v2-wrap' : ''),
  }, text));
  const controls = [];
  for (let i = 0; i < count; i++) {
    const close = root.appendChild(v2
      ? new FakeNode('button', { class: 'close-button', 'aria-label': '关闭', type: 'button' })
      : new FakeNode('span', { class: 'tools-vmok-plugin-modal__close-icon' }));
    if (v2) close.appendChild(new FakeNode('iconpark-icon', { name: 'oc-icon-close' }));
    close.onClick = () => { if (works) root.remove(); };
    controls.push(close);
  }
  const business = root.appendChild(new FakeNode('button', {}, '去开启'));
  return { root, controls, business };
}

function assertZeroClicks(nodes) {
  for (const node of nodes) assert.equal(node.clicked, 0);
}

test('unknown launcher exposes numeric structure and text lengths only, never dismisses', () => {
  const dom = makeDom();
  const popup = addUnknown(dom.body, 'PRIVATE_ROOT_TEXT');
  Object.assign(popup.attrs, {
    id: 'PRIVATE_ACCOUNT_ID', title: 'PRIVATE_TITLE',
    'aria-label': 'PRIVATE_ROOT_LABEL', 'data-account': 'PRIVATE_ACCOUNT',
    href: QC_URL + '#PRIVATE_HREF', 'data-cookie': 'PRIVATE_COOKIE',
  });
  for (const key of ['outerHTML', 'innerHTML', 'attributes', 'id', 'href']) {
    Object.defineProperty(popup, key, { get() { throw new Error('PRIVATE_FORBIDDEN_READ'); } });
  }
  const copy = popup.appendChild(new FakeNode('span', { class: 'body-copy', role: 'note' }, 'PRIVATE_VISIBLE_TEXT'));
  popup.appendChild(new FakeNode('div', { display: 'none' }, 'PRIVATE_HIDDEN_TEXT'));
  for (const tag of ['script', 'style', 'noscript', 'template']) {
    popup.appendChild(new FakeNode(tag, {}, `PRIVATE_${tag.toUpperCase()}_TEXT`));
  }
  const close = popup.appendChild(new FakeNode('span', {
    class: 'tools-vmok-plugin-modal__close-icon', 'aria-label': 'PRIVATE_CLOSE_LABEL',
    title: 'PRIVATE_CLOSE_TITLE',
  }, 'PRIVATE_CLOSE_TEXT'));
  const nodes = dom.body.querySelectorAll('*');
  const result = runInPage(dom, { click: true });
  assert.equal(result.state, 'blocked');
  assert.equal(result.clicked, false);
  assert.equal(result.action, 'none');
  assert.equal(result.closeCandidates, 0);
  assert.equal(result.textCandidates, 0);
  assert.deepEqual(result.blockers, ['unknown-overlay:1']);
  const diag = result.unknownDiag[0];
  assert.equal(diag.cls, 'launcher_popupSlot__1C2rh');
  assert.deepEqual(diag.rect, popup.rect);
  assert.ok(Object.values(diag.rect).every(Number.isFinite));
  assert.equal(diag.directChildren, 7);
  assert.equal(diag.visibleDirectChildren, 6);
  assert.equal(diag.directChildrenTruncated, false);
  assert.equal(diag.children.length, 5);
  assert.deepEqual(diag.children[0], { tag: 'span', cls: 'body-copy', role: 'note', visible: true });
  assert.equal(diag.children[1].visible, false);
  assert.equal(diag.rawChars, popup.textContent.length);
  assert.equal(diag.visChars, 'PRIVATE_ROOT_TEXT'.length + copy.textContent.length + close.textContent.length);
  assert.equal(diag.visibleDescendants, 2);
  assert.equal(diag.containedIntroRoots, 0);
  assert.equal(diag.containedGuideRoots, 0);
  assert.equal(diag.visibleCloseControls, 1);
  assert.equal(diag.closeControls[0].legacyClose, true);
  assert.equal(diag.closeControls[0].ariaClose, false);
  assert.equal(diag.scanTruncated, false);
  assert.equal(diag.incomplete, undefined);
  assert.equal(dom.queries.length, 3, 'diagnostics must not add document-wide selectors');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|https?:|outerHTML|innerHTML|data-account|data-cookie/);
  assertZeroClicks(nodes);
});

test('unknown diagnostics cap candidates, child/control samples and structural strings', () => {
  const dom = makeDom();
  for (let i = 0; i < 8; i++) {
    const popup = dom.body.appendChild(new FakeNode('div', {
      class: 'launcher_popupSlot__1C2rh ' + 'x'.repeat(100), role: 'r'.repeat(100),
    }));
    for (let j = 0; j < 8; j++) {
      popup.appendChild(new FakeNode('custom-' + 't'.repeat(50), {
        class: 'tools-vmok-plugin-modal__close-icon ' + 'c'.repeat(100), role: 'r'.repeat(100),
      }));
    }
  }
  const nodes = dom.body.querySelectorAll('*');
  const result = runInPage(dom, { click: true });
  assert.deepEqual(result.blockers, ['unknown-overlay:8']);
  assert.equal(result.unknownDiag.length, 5);
  for (const diag of result.unknownDiag) {
    assert.equal(diag.directChildren, 8);
    assert.equal(diag.visibleDirectChildren, 8);
    assert.equal(diag.children.length, 5);
    assert.equal(diag.closeControls.length, 5);
    assert.equal(diag.visibleCloseControls, 8);
    assert.equal(diag.closeControlsTruncated, true);
    assert.equal(diag.scanTruncated, false);
    for (const summary of [diag, ...diag.children, ...diag.closeControls]) {
      assert.ok(summary.tag.length <= 24);
      assert.ok(summary.cls.length <= 60);
      assert.ok(summary.role.length <= 24);
    }
  }
  assert.equal(result.state, 'blocked');
  assert.equal(result.clicked, false);
  assertZeroClicks(nodes);
});

test('wide unknown trees have bounded inspection with explicit partial counts', () => {
  const dom = makeDom();
  const popup = addUnknown(dom.body);
  for (let i = 0; i < 250; i++) popup.appendChild(new FakeNode('div'));
  const result = runInPage(dom, { click: true });
  const diag = result.unknownDiag[0];
  assert.equal(diag.directChildren, 250);
  assert.equal(diag.visibleDirectChildren, 200);
  assert.equal(diag.directChildrenTruncated, true);
  assert.equal(diag.scannedNodes, 200);
  assert.equal(diag.visibleDescendants, 199);
  assert.equal(diag.scanTruncated, true);
  assert.equal(diag.children.length, 5);
  assert.equal(diag.incomplete, undefined);
  assert.equal(result.state, 'blocked');
  assertZeroClicks(dom.body.querySelectorAll('*'));
});

test('deep unknown trees stop locally and mark text lengths as partial', () => {
  const dom = makeDom();
  const popup = addUnknown(dom.body, 'a'.repeat(1201));
  let tail = popup;
  for (let i = 0; i < 250; i++) tail = tail.appendChild(new FakeNode('div'));
  const deepClose = tail.appendChild(new FakeNode('span', { class: 'tools-vmok-plugin-modal__close-icon' }, 'PRIVATE_DEEP_TEXT'));
  const diag = runInPage(dom).unknownDiag[0];
  assert.equal(diag.scannedNodes, 200);
  assert.equal(diag.scanTruncated, true);
  assert.equal(diag.rawChars, 1201);
  assert.equal(diag.visChars, 1201);
  assert.equal(diag.directChildren, 1);
  assert.equal(diag.directChildrenTruncated, false);
  assert.equal(diag.visibleCloseControls, 0);
  assert.equal(diag.incomplete, undefined);
  assert.equal(deepClose.clicked, 0);
  assert.doesNotMatch(JSON.stringify(diag), /PRIVATE_|a{20}/);
});

test('visible recognizable controls use fixed enums and booleans, not arbitrary labels', () => {
  const dom = makeDom();
  const popup = addUnknown(dom.body);
  popup.appendChild(new FakeNode('span', { class: 'tools-vmok-plugin-modal__close-icon', 'aria-label': 'PRIVATE_LABEL' }));
  const v2 = popup.appendChild(new FakeNode('button', { class: 'close-button', 'aria-label': '关闭', type: 'button' }));
  v2.appendChild(new FakeNode('iconpark-icon', { name: 'oc-icon-close' }));
  for (const text of ['跳 过', '跳过引导', '我知道了']) popup.appendChild(new FakeNode('button', {}, text));
  popup.appendChild(new FakeNode('button', { title: 'PRIVATE_TITLE' }, 'PRIVATE_BUSINESS_TEXT'));
  popup.appendChild(new FakeNode('button', {}, '去开启'));
  popup.appendChild(new FakeNode('span', { class: 'tools-vmok-plugin-modal__close-icon', visibility: 'hidden' }));
  const hidden = popup.appendChild(new FakeNode('div', { display: 'none' }));
  hidden.appendChild(new FakeNode('button', {}, '跳过'));
  const nodes = dom.body.querySelectorAll('*');
  const result = runInPage(dom, { click: true });
  const diag = result.unknownDiag[0];
  assert.equal(diag.visibleCloseControls, 5);
  assert.equal(diag.closeControlsTruncated, false);
  assert.deepEqual(diag.closeControls.map((control) => control.closeText), [null, null, 'skip', 'skip-guide', 'acknowledge']);
  assert.equal(diag.closeControls[0].legacyClose, true);
  assert.equal(diag.closeControls[0].ariaClose, false);
  assert.equal(diag.closeControls[1].v2CloseButton, true);
  assert.equal(diag.closeControls[1].ariaClose, true);
  assert.equal(result.state, 'blocked');
  assert.equal(result.clicked, false);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_|跳过|我知道了|去开启/);
  assertZeroClicks(nodes);
});

test('contained known-root counts are not guessed from guide classes, shared attributes or siblings', () => {
  const dom = makeDom();
  const intro = addIntro(dom.body);
  const guide = dom.body.appendChild(new FakeNode('div', { class: 'qc-guide-container' }));
  guide.appendChild(new FakeNode('button', {}, '跳过'));
  const popup = addUnknown(dom.body);
  popup.appendChild(new FakeNode('div', { class: 'productFundModuleGuide' }, '去开启'));
  popup.appendChild(new FakeNode('div', { 'data-e2e': 'oc_emptyKey_overall-prom' }));
  popup.appendChild(new FakeNode('div', { class: 'ocean-vmok-plugin-oc-modal-wrap', display: 'none' }));
  const result = runInPage(dom, { click: true });
  assert.equal(result.unknownDiag.length, 1);
  assert.equal(result.unknownDiag[0].containedIntroRoots, 0);
  assert.equal(result.unknownDiag[0].containedGuideRoots, 0);
  assert.equal(result.state, 'blocked');
  assert.ok(result.blockers.includes('unknown-overlay:1'));
  assert.ok(result.blockers.includes('intro-and-guide'));
  assert.equal(intro.controls[0].clicked, 0);
  assertZeroClicks(dom.body.querySelectorAll('*'));
});

test('diagnostic exceptions preserve original blockers and do not suppress other candidates', () => {
  const dom = makeDom();
  const broken = addUnknown(dom.body);
  const healthy = addUnknown(dom.body);
  const getRect = broken.getBoundingClientRect.bind(broken);
  let reads = 0;
  broken.getBoundingClientRect = () => {
    reads += 1;
    if (reads > 1) throw new Error('PRIVATE_DIAGNOSTIC_EXCEPTION');
    return getRect();
  };
  const result = runInPage(dom, { click: true });
  assert.equal(result.state, 'blocked');
  assert.equal(result.clicked, false);
  assert.deepEqual(result.blockers, ['unknown-overlay:2']);
  assert.equal(result.unknownDiag[0].incomplete, true);
  assert.equal(result.unknownDiag[1].incomplete, undefined);
  assert.deepEqual(result.unknownDiag[1].rect, healthy.rect);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
  assertZeroClicks([broken, healthy]);
});

test('existing blocked audit carries bounded structure with one read, no waits and no clicks', async () => {
  const dom = makeDom();
  const popup = addUnknown(dom.body, 'PRIVATE_AUDIT_TEXT');
  const close = popup.appendChild(new FakeNode('span', { class: 'tools-vmok-plugin-modal__close-icon' }));
  const audits = [];
  const evaluations = [];
  const page = {
    async evaluate(fn, options) {
      evaluations.push(options.click);
      return runInPage(dom, options, fn);
    },
    async waitForTimeout() { assert.fail('unknown overlays must not wait or retry'); },
  };
  const result = await dismissKnownChengfangOverlays({ page, audit: (event) => audits.push(event) });
  assert.equal(result.state, 'blocked');
  assert.equal(result.dismissed, false);
  assert.equal(result.reason, 'unknown-overlay:1');
  assert.deepEqual(evaluations, [false]);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].kind, 'chengfang-overlay');
  assert.equal(audits[0].action, 'probe');
  assert.equal(audits[0].result, 'blocked');
  assert.deepEqual(audits[0].unknownDiag, result.unknownDiag);
  assert.equal(audits[0].unknownDiag[0].rawChars, 'PRIVATE_AUDIT_TEXT'.length);
  assert.equal(audits[0].unknownDiag[0].incomplete, undefined);
  assert.doesNotMatch(JSON.stringify({ result, audits }), /PRIVATE_/);
  assert.equal(close.clicked, 0);
});

for (const kind of ['legacy', 'v2', 'guide']) {
  test(`known ${kind} overlay retains one click and two disappearance observations`, async () => {
    const dom = makeDom();
    let control;
    let business;
    if (kind === 'guide') {
      const root = dom.body.appendChild(new FakeNode('div', { class: 'qc-guide-container' }));
      control = root.appendChild(new FakeNode('button', {}, '我知道了'));
      control.onClick = () => root.remove();
      business = root.appendChild(new FakeNode('button', {}, '去开启'));
    } else {
      const intro = addIntro(dom.body, { v2: kind === 'v2' });
      control = intro.controls[0];
      business = intro.business;
    }
    const probe = runInPage(dom);
    assert.equal(probe.state, 'dismissable');
    assert.equal(probe.unknownDiag, undefined);
    assert.equal(control.clicked, 0);
    const evaluations = [];
    let waits = 0;
    const page = {
      async evaluate(fn, options) {
        evaluations.push(options.click);
        return runInPage(dom, options, fn);
      },
      async waitForTimeout() { waits += 1; },
    };
    const result = await dismissKnownChengfangOverlays({ page });
    assert.equal(result.dismissed, true);
    assert.equal(result.state, 'none');
    assert.equal(result.action, kind === 'guide' ? 'skip-guide' : 'dismiss-intro');
    assert.deepEqual(evaluations, [false, true, false, false]);
    assert.equal(waits, 2);
    assert.equal(control.clicked, 1);
    assert.equal(business.clicked, 0);
  });
}

for (const scenario of [
  { name: 'missing close', options: { count: 0 }, state: 'no-control', blocker: null },
  { name: 'ambiguous close', options: { count: 2 }, state: 'blocked', blocker: 'ambiguous-close:2' },
  { name: 'visible danger', options: { text: '确认删除这 30 条计划？删除后不可恢复' }, state: 'blocked', blocker: 'danger-text' },
]) {
  test(`known intro parity: ${scenario.name}`, () => {
    const dom = makeDom();
    const intro = addIntro(dom.body, scenario.options);
    const result = runInPage(dom, { click: true });
    assert.equal(result.state, scenario.state);
    assert.equal(result.clicked, false);
    assert.equal(result.unknownDiag, undefined);
    if (scenario.blocker) assert.ok(result.blockers.includes(scenario.blocker));
    assertZeroClicks([...intro.controls, intro.business]);
  });
}

test('known multiple roots and guide ambiguity remain blocked without diagnostic reclassification', () => {
  const multiple = makeDom();
  const first = addIntro(multiple.body);
  const second = addIntro(multiple.body);
  const result = runInPage(multiple, { click: true });
  assert.equal(result.state, 'blocked');
  assert.ok(result.blockers.includes('multiple-intro:2'));
  assert.equal(result.unknownDiag, undefined);
  assertZeroClicks([...first.controls, ...second.controls]);
  const ambiguous = makeDom();
  const guide = ambiguous.body.appendChild(new FakeNode('div', { class: 'qc-guide-container' }));
  guide.appendChild(new FakeNode('button', {}, '跳过'));
  guide.appendChild(new FakeNode('button', {}, '我知道了'));
  const guideResult = runInPage(ambiguous, { click: true });
  assert.equal(guideResult.state, 'blocked');
  assert.ok(guideResult.blockers.includes('ambiguous-skip:2'));
  assert.equal(guideResult.unknownDiag, undefined);
  assertZeroClicks(guide.children);
});

test('known adjacent empty mask affiliation is unchanged', () => {
  const dom = makeDom();
  const mask = dom.body.appendChild(new FakeNode('div', { class: 'tools-vmok-plugin-popup__mask' }));
  const intro = addIntro(dom.body, { v2: true });
  const result = runInPage(dom, { click: true });
  assert.equal(result.state, 'dismissable');
  assert.equal(result.clicked, true);
  assert.deepEqual(result.affiliatedMask, { cls: 'tools-vmok-plugin-popup__mask' });
  assert.equal(result.unknownDiag, undefined);
  assert.equal(intro.controls[0].clicked, 1);
  assert.equal(mask.clicked, 0);
  assert.equal(intro.business.clicked, 0);
});

test('ordinary guide-like marketing cards remain non-overlays with zero business clicks', () => {
  const dom = makeDom();
  const card = dom.body.appendChild(new FakeNode('div', { class: 'productFundModuleGuide' }));
  const business = card.appendChild(new FakeNode('button', {}, '去开启'));
  const result = runInPage(dom, { click: true });
  assert.equal(result.state, 'none');
  assert.equal(result.clicked, false);
  assert.equal(result.unknownDiag, undefined);
  assert.equal(business.clicked, 0);
});

test('serialized compatibility alias remains self-contained and blocks unknown controls', () => {
  const dom = makeDom();
  const popup = addUnknown(dom.body);
  const close = popup.appendChild(new FakeNode('span', { class: 'tools-vmok-plugin-modal__close-icon' }));
  const result = runInPage(dom, { click: true }, advanceChengfangPlanViewInPage);
  assert.equal(result.state, 'blocked');
  assert.equal(result.clicked, false);
  assert.equal(result.unknownDiag[0].incomplete, undefined);
  assert.equal(result.unknownDiag[0].visibleCloseControls, 1);
  assert.equal(close.clicked, 0);
});
