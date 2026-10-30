'use strict';
// S68 offline verification. No network, no browser, no CDP, no real config/cookies,
// no real app imports, no main()/start. Run: node --test final-modal-r68.test.cjs
// The REAL exported run-plans collectors (finalDialogSnapshotInPage /
// clickFinalConfirmInPage) execute inside a serialized VM against the OBSERVED
// Aurora modal shape (actual-aurora-modal-shape.json) and the old OVUI fixtures;
// the REAL exported resumeScheduledKnownFinalOnly / resumeKnownFinalOnly run over
// owned OS-temp state/attempts/published fixtures with fake UI + manager callbacks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const rp = require('./run-plans.cjs');
const pw = require('./plan-workflow.cjs');
const guard = require('./direct-draft-controller.cjs');

// ---------- minimal DOM harness (same pattern as the read-only legacy suites) ----------
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
  dispatchEvent(ev) { (this.__events = this.__events || []).push(ev && ev.type ? ev.type : 'event'); },
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
  if (opts.role) el.attrs.role = opts.role;
  if (opts.attrs) for (const k in opts.attrs) el.attrs[k] = String(opts.attrs[k]);
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

function makePage(bodyKids) {
  SEQ = 0;
  const body = El('body', {}, bodyKids || []);
  const doc = {
    body,
    querySelectorAll(sel) { if (sel.trim() === 'body *') return allDesc(body); return allDesc(body).filter(el => matchesSel(el, sel)); },
    querySelector(sel) { const a = this.querySelectorAll(sel); return a[0] || null; },
  };
  const windowObj = {};
  const loc = { pathname: '/create-ad/overall-product', origin: 'https://qianchuan.jinritemai.com', href: 'https://qianchuan.jinritemai.com/create-ad/overall-product' };
  const ctx = {
    window: windowObj, document: doc, location: loc,
    getComputedStyle: el => ({ visibility: el.__vis || 'visible' }),
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

// ---------- known final-dialog copy (exact constant lives in plan-workflow) ----------
const ns = s => String(s == null ? '' : s).replace(/\s+/g, '');
const FINAL_HDR = '为保证乘方投放的唯一性，温馨提示您:';
const BODY_LINE1 = '乘方投放时，受互斥影响的放量投放-全域投放计划、控成本投放-全域投放计划将被删除（如有）。同时小店随心推订单将被终止，终止后不可恢复。';
const BODY_LINE2 = '若当前商品和抖音号已在全域投放，也可前往全域升级为乘方计划，升级后原有全域计划投放数据不受影响。';
const FINAL_BODY = BODY_LINE1 + ' ' + BODY_LINE2;

// ---------- OBSERVED Aurora shape (actual-aurora-modal-shape.json, R67 root capture) ----------
// .aurora-qc-modal-wrap > .aurora-qc-modal[role=dialog] > .aurora-qc-modal-container
// > { close button, .aurora-qc-modal-header > .aurora-qc-modal-title,
//     .aurora-qc-modal-body > .content-emJ6fK > 2 text divs,
//     .aurora-qc-modal-footer > .footer-CP6Qzd > 取消/确认发布 buttons > spans }
function auroraFinalModal(o = {}) {
  const rect = o.rect || [800, 600];
  // the observed confirm control is a SPAN label inside a semantic BUTTON; the button
  // itself carries no direct text node. spanOnlyText hides the button box (zero rect)
  // so ONLY the span is a visible text match -> the closest-button resolution path.
  const btnRect = o.spanOnlyText ? [0, 0] : [120, 40];
  const confirmChildren = o.loneSpan
    ? [El('span', { rect: [100, 24], text: '确认发布' })]
    : [El('button', { class: 'aurora-qc-btn aurora-qc-btn-primary', rect: btnRect, disabled: !!o.disabled }, [El('span', { rect: [100, 24], text: '确认发布' })])];
  const cancelBtn = El('button', { class: 'aurora-qc-btn aurora-qc-btn-default', rect: [100, 40] }, [El('span', { rect: [90, 24], text: '取消' })]);
  const footerInner = El('div', { class: 'footer-CP6Qzd', rect: [600, 60] }, [cancelBtn].concat(confirmChildren));
  if (o.duplicateButton) footerInner.__kids.push(El('button', { class: 'aurora-qc-btn', rect: [120, 40] }, [El('span', { rect: [100, 24], text: '确认发布' })]));
  const footer = El('div', { class: 'aurora-qc-modal-footer', rect: [600, 60] }, [footerInner]);
  const closeBtn = El('button', { class: 'aurora-qc-modal-close', rect: [20, 20] }, [
    El('span', { class: 'aurora-qc-modal-close-x', rect: [16, 16] }, [El('span', { class: 'aurora-qc-icon aurora-qc-icon-close aurora-qc-modal-close-icon', rect: [16, 16], role: 'img' })]),
  ]);
  const containerKids = [closeBtn];
  if (!o.noHeader) {
    const headerCls = o.foreignHeader ? 'some-foreign-header' : 'aurora-qc-modal-header';
    containerKids.push(El('div', { class: headerCls, rect: [600, 40] }, [El('div', { class: 'aurora-qc-modal-title', rect: [560, 24], text: FINAL_HDR })]));
  }
  if (!o.noBody) {
    const bodyCls = o.foreignBody ? 'some-foreign-body' : 'aurora-qc-modal-body aurora-qc-modal-body acss-13873h3';
    const body = El('div', { class: bodyCls, rect: [600, 200] }, [
      El('div', { class: 'content-emJ6fK', rect: [560, 160] }, [
        El('div', { rect: [560, 80], text: o.bodyLine1 == null ? BODY_LINE1 : o.bodyLine1 }),
        El('div', { rect: [560, 80], text: o.bodyLine2 == null ? BODY_LINE2 : o.bodyLine2 }),
      ]),
    ]);
    containerKids.push(body);
    if (o.duplicateBody) containerKids.push(El('div', { class: 'aurora-qc-modal-body', rect: [600, 200], text: '第二个独立可见 body' }));
    if (o.foreignBodyExtra) containerKids.push(El('div', { class: 'ovui-modal__body', rect: [600, 100], text: '外来 body 区块' }));
  }
  containerKids.push(footer);
  const container = El('div', { class: 'aurora-qc-modal-container', rect }, containerKids);
  const modal = El('div', { class: 'aurora-qc-modal css-1oisu5x', rect, role: 'dialog' }, [container]);
  const wrap = El('div', { class: 'aurora-qc-modal-wrap aurora-qc-modal-centered', rect }, [modal]);
  return { wrap, container, footer, footerInner, cancelBtn, confirmChildren };
}

// ---------- old OVUI shape (legacy fixtures must remain valid) ----------
function ovuiFinalModal(o = {}) {
  const rect = o.rect || [800, 600];
  const confirmChildren = o.loneSpan
    ? [El('span', { rect: [100, 24], text: '确认发布' })]
    : [El('button', { rect: [120, 40], disabled: !!o.disabled }, [El('span', { rect: [100, 24], text: '确认发布' })])];
  const cancel = El('button', { rect: [100, 40], text: '取消' });
  const footer = El('div', { class: 'ovui-modal__footer', rect: [600, 60] }, [cancel].concat(confirmChildren));
  const header = El('div', { class: 'ovui-modal__header ovui-modal__header-with-close', rect: [600, 40], text: FINAL_HDR });
  const body = El('div', { class: 'ovui-modal__body custom-body', rect: [600, 200], text: o.bodyText == null ? FINAL_BODY : o.bodyText });
  const closeIcon = El('div', { class: 'ovui-modal__close-icon', rect: [20, 20] });
  const icon = El('iconpark-icon', { class: 'oc-modal-header-icon oc-icon-info', rect: [20, 20] });
  const inner = El('div', { class: 'ovui-modal', rect: [rect[0] - 100, rect[1] - 100] }, [closeIcon, header, icon, body, footer]);
  const leaveFooter = El('div', { class: 'uni-live-leave-page-modal-footer', rect: [600, 60], text: '取消 确认发布' });
  const wrap = El('div', { class: 'ovui-modal__wrap oc-modal-wrap', rect }, [inner, leaveFooter]);
  return { wrap, header, body, footer, cancel };
}

function snapshotOf(kids) { return makePage(kids).run(rp.finalDialogSnapshotInPage); }

// ════════════════════════════════════════════════════════════════════════════
// Part 1 — real exported collectors on the OBSERVED Aurora shape
// ════════════════════════════════════════════════════════════════════════════

test('S68 aurora: nested header/title + body/content assemble to EXACTLY the known constant; footer labels excluded', () => {
  const m = auroraFinalModal();
  const r = snapshotOf([m.wrap]);
  assert.equal(r.reason, undefined, 'the observed aurora root must merge to ONE known root');
  assert.equal(r.visible, true);
  assert.equal(ns(r.text), ns(pw.FINAL_EXCLUSION_TEXT), 'header+body only equals the frozen constant (whitespace-equivalent)');
  assert.equal(pw.matchFinalExclusionDialog(r.text).known, true);
  assert.equal(r.text.includes('取消'), false, 'footer cancel copy never enters the business body');
  assert.equal(r.text.includes('确认发布'), false, 'footer confirm copy never enters the business body');
  assert.equal(r.text.split('为保证乘方投放的唯一性').length, 2, 'nested title never duplicates the header text');
  assert.equal(r.text.split('乘方投放时').length, 2, 'nested body content never duplicates the body text');
  assert.equal(pw.resolveFinalPublishButton(r.confirmTarget).ok, true);
});

test('S68 aurora: one real final click on the unique enabled button; cancel untouched', () => {
  const m = auroraFinalModal();
  const p = makePage([m.wrap]);
  const res = p.runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT);
  assert.equal(res.clicked, true);
  const confirmBtn = m.confirmChildren[0];
  assert.equal(confirmBtn.__clicked, 1, 'exactly one click on the semantic confirm button');
  assert.equal(m.cancelBtn.__clicked, 0, 'cancel never clicked');
});

test('S68 aurora: a SPAN label resolves through its closest semantic button and clicks the button once', () => {
  const m = auroraFinalModal({ spanOnlyText: true });
  const r = snapshotOf([m.wrap]);
  assert.equal(ns(r.text), ns(pw.FINAL_EXCLUSION_TEXT));
  assert.equal(r.confirmTarget.tag, 'SPAN');
  assert.equal(r.confirmTarget.closestButton, true);
  assert.equal(pw.resolveFinalPublishButton(r.confirmTarget).ok, true);
  const p = makePage([auroraFinalModal({ spanOnlyText: true }).wrap]);
  const res = p.runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT);
  assert.equal(res.clicked, true);
  assert.equal(res.via, 'closest-button');
  // a LONE span with no closest button never resolves and never clicks
  const lone = auroraFinalModal({ loneSpan: true });
  const lr = snapshotOf([lone.wrap]);
  assert.equal(lr.reason, 'final-button-not-unique');
  const lp = makePage([auroraFinalModal({ loneSpan: true }).wrap]);
  assert.throws(() => lp.runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT), /button-not-uniquely-enabled/);
});

test('S68 old OVUI fixture remains valid: same exact text, same single click', () => {
  const m = ovuiFinalModal();
  const r = snapshotOf([m.wrap]);
  assert.equal(r.reason, undefined);
  assert.equal(ns(r.text), ns(pw.FINAL_EXCLUSION_TEXT), 'legacy ovui header/body assembly unchanged');
  assert.equal(r.text.includes('取消'), false);
  assert.equal(pw.resolveFinalPublishButton(r.confirmTarget).ok, true);
  const p = makePage([ovuiFinalModal().wrap]);
  assert.equal(p.runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT).clicked, true);
});

test('S68 collectors: tampered warn text is never accepted and never clicked', () => {
  const m = auroraFinalModal({ bodyLine2: BODY_LINE2 + ' 新增强制条款' });
  const r = snapshotOf([m.wrap]);
  assert.equal(r.reason, undefined);
  assert.equal(pw.matchFinalExclusionDialog(r.text).known, false, 'changed copy is not the known dialog');
  const p = makePage([auroraFinalModal({ bodyLine2: BODY_LINE2 + 'X' }).wrap]);
  assert.throws(() => p.runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT), /final-dialog-drift/);
});

test('S68 collectors: two independent known modals (aurora+aurora, aurora+ovui) refuse with zero clicks', () => {
  for (const pair of [[auroraFinalModal().wrap, auroraFinalModal().wrap], [auroraFinalModal().wrap, ovuiFinalModal().wrap]]) {
    const r = snapshotOf(pair);
    assert.equal(r.reason, 'final-dialog-not-unique');
    assert.equal(r.text, '');
    const p = makePage(pair);
    assert.throws(() => p.runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT), /final-dialog-not-unique/);
  }
});

test('S68 collectors: missing header/body, duplicate visible body, foreign sections -> no final click, no root-text fallback', () => {
  // header node entirely absent: the KEY copy is gone with it -> not even a known root
  const noHdr = auroraFinalModal({ noHeader: true });
  const r1 = snapshotOf([noHdr.wrap]);
  assert.equal(r1.visible, false);
  assert.equal(r1.reason, 'final-dialog-not-unique');
  assert.equal(r1.text, '', 'no full-root innerText fallback');
  assert.throws(() => makePage([auroraFinalModal({ noHeader: true }).wrap]).runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT), /final-dialog-not-unique/);
  // KEY present but the header carries a foreign class -> sections refuse
  const foreignHdr = auroraFinalModal({ foreignHeader: true });
  const r2 = snapshotOf([foreignHdr.wrap]);
  assert.equal(r2.reason, 'final-dialog-sections-not-unique');
  assert.equal(r2.text, '');
  assert.throws(() => makePage([auroraFinalModal({ foreignHeader: true }).wrap]).runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT), /final-dialog-sections-not-unique/);
  // body missing
  const r3 = snapshotOf([auroraFinalModal({ noBody: true }).wrap]);
  assert.equal(r3.reason, 'final-dialog-sections-not-unique');
  assert.throws(() => makePage([auroraFinalModal({ noBody: true }).wrap]).runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT), /final-dialog-sections-not-unique/);
  // duplicate visible sibling body
  const r4 = snapshotOf([auroraFinalModal({ duplicateBody: true }).wrap]);
  assert.equal(r4.reason, 'final-dialog-sections-not-unique');
  assert.throws(() => makePage([auroraFinalModal({ duplicateBody: true }).wrap]).runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT), /final-dialog-sections-not-unique/);
  // foreign extra body section inside the known root
  const r5 = snapshotOf([auroraFinalModal({ foreignBodyExtra: true }).wrap]);
  assert.equal(r5.reason, 'final-dialog-sections-not-unique');
  // foreign-classed body only
  const r6 = snapshotOf([auroraFinalModal({ foreignBody: true }).wrap]);
  assert.equal(r6.reason, 'final-dialog-sections-not-unique');
});

test('S68 collectors: disabled or ambiguous confirm button refuses with zero clicks', () => {
  const dis = auroraFinalModal({ disabled: true });
  const dp = makePage([dis.wrap]);
  assert.throws(() => dp.runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT), /button-not-uniquely-enabled/);
  const realDis = dis.confirmChildren[0];
  assert.equal(realDis.__clicked, 0, 'disabled button never clicked');
  const dup = auroraFinalModal({ duplicateButton: true });
  assert.equal(snapshotOf([dup.wrap]).reason, 'final-button-not-unique');
  assert.throws(() => makePage([auroraFinalModal({ duplicateButton: true }).wrap]).runWith(rp.clickFinalConfirmInPage, pw.FINAL_EXCLUSION_TEXT), /button-not-uniquely-enabled/);
  // a fully hidden dialog is not a visible known final
  const hidden = auroraFinalModal();
  hidden.wrap.__vis = 'hidden';
  for (const n of allDesc(hidden.wrap)) n.__vis = 'hidden';
  const rh = snapshotOf([hidden.wrap]);
  assert.equal(rh.visible, false);
});

// ════════════════════════════════════════════════════════════════════════════
// Part 2 — real exported resumeScheduledKnownFinalOnly over owned temp fixtures
// ════════════════════════════════════════════════════════════════════════════

const R68_ACCOUNT = '1710242295996424'; // legacy frozen business account (public config value)
const R68_SHOP = '瑾漂亮潮流服饰';
const R68_OLD_IDS = ['900000000001', '900000000002', '900000000303'];

function scheduledFixture(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r68-sched-'));
  const stateFile = path.join(dir, 'plan-publisher-state.json');
  const publishedFile = path.join(dir, 'published-products.json');
  const attemptsFile = path.join(dir, 'plan-publication-attempts.json');
  const businessDate = pw.shanghaiDate(o.now || Date.now());
  const planNumber = o.planNumber || 1;
  const productIds = Array.from({ length: 30 }, (_, i) => '38450000000000' + String(i).padStart(2, '0'));
  const base = {
    planNumber, runId: 'run-1', businessDate, accountId: R68_ACCOUNT,
    planName: businessDate + '_千川乘方_22:28:24' + (planNumber > 1 ? '_' + planNumber : ''),
    roi: 15, dailyBudget: 300,
    commissionIncluded: true, directPay: false, boundAccounts: ['79863866', '9zmao_fushi'],
    productIds, disclosures: { migration: [], precheck: [], reviewFailed: [] },
    nonce: 'nonce-1', confirmationId: 'conf-1', frozenAt: new Date().toISOString(),
  };
  const frozen = Object.assign({}, base, { manifestHash: pw.manifestHash(base) });
  if (o.frozenBusinessDate) frozen.businessDate = o.frozenBusinessDate;
  const active = o.active || { status: 'publish-unknown', reason: 'unknown-or-new-final-dialog', planNumber, frozen, authorizedBy: 'recurring-user-policy' };
  const manualRecord = { confirmationId: frozen.confirmationId, manifestHash: frozen.manifestHash, planNumber, at: new Date().toISOString() };
  pw.persistDayState(stateFile, {
    businessDate, plans: [], active, firstPublishedPlan: null, lastSelected: productIds.slice(),
    confirmationConsumptions: o.authority === 'manual' ? [manualRecord] : [], // scheduled: EMPTY manual consumptions
  });
  fs.writeFileSync(attemptsFile, JSON.stringify({
    consumed: { 'conf-1': { planNumber, runId: 'run-1', businessDate, manifestHash: frozen.manifestHash, status: 'unknown', at: new Date().toISOString() } },
    finalConsumed: o.finalConsumed || {},
  }, null, 2));
  fs.writeFileSync(publishedFile, JSON.stringify({ publishedIds: ['old-product-1'], plans: [] }, null, 2));
  const recurringAuth = Object.assign({
    authorizedBy: 'recurring-user-policy', humanApproved: false,
    confirmationId: frozen.confirmationId, manifestHash: frozen.manifestHash, planNumber,
    businessDate, planName: frozen.planName, accountId: R68_ACCOUNT,
  }, o.recurringAuth || {});
  const humanAuth = o.authority === 'manual'
    ? { confirmationId: frozen.confirmationId, manifestHash: frozen.manifestHash, planNumber, businessDate, planName: frozen.planName, authorized: true, at: new Date().toISOString() }
    : undefined;
  let providerCalls = 0;
  const goodResult = () => ({
    policy: Object.assign({ enabled: true, autoConfirm: true, dailyBudget: 300, plansPerShopPerDay: 3 }, o.policy || {}),
    shop: o.shop === null ? null : Object.assign({ name: R68_SHOP, accountId: R68_ACCOUNT, targetRoi: 15, enabled: true }, o.shop || {}),
  });
  const recurringPolicyProvider = o.providerThrow
    ? () => { throw new Error('localhost-state-unreadable'); }
    : async () => {
        providerCalls++;
        if (Array.isArray(o.driftOnProviderCall) && o.driftOnProviderCall.includes(providerCalls)) {
          return Object.assign(goodResult(), o.driftResult || { policy: { enabled: false, autoConfirm: true, dailyBudget: 300 } });
        }
        return goodResult();
      };
  const calls = { click: 0, reservedAtClick: null };
  const creation = Object.assign({
    originOk: true, pathOk: true, accountId: R68_ACCOUNT, planName: frozen.planName,
    uniqueProductCount: 30, productRowCount: 30, productIds, eachRowHasManualAccount: true,
    rows: productIds.map(id => ({ productId: id, manualAccounts: 2 })),
    roi: '15.00', budget: '300.00', // observed platform rendering; must pass via samePositiveDecimalValue
    commissionChecked: true, optionalDirectPayChecked: false, publishButtonCount: 1,
  }, o.creation || {});
  const newPlanId = o.newPlanId || '123456789012';
  const successRow = { found: true, planName: frozen.planName, uniqueRow: true, accountId: R68_ACCOUNT, planId: newPlanId, productCount: 30, accountCount: 2, roi: 15, dailyBudget: 300, commissionIncluded: true, status: '投放中' };
  const deps = {
    nowMs: Array.isArray(o.nowSeq)
      ? (() => { let i = 0; return () => { const v = o.nowSeq[Math.min(i, o.nowSeq.length - 1)]; i++; return v; }; })()
      : () => (o.now || Date.now()),
    stateFile, publishedFile, attemptsFile, frozen, recurringAuth, humanAuth, recurringPolicyProvider,
    readManagementAbsence: async () => ({ absenceConfirmed: true, absent: true, present: false, seenPlanIds: R68_OLD_IDS, accountId: R68_ACCOUNT, total: R68_OLD_IDS.length }),
    observeCreation: async () => ({ creation }),
    readFinalDialog: async () => (o.dialog === null ? null : Object.assign({ visible: true, text: pw.FINAL_EXCLUSION_TEXT, confirmTarget: { tag: 'SPAN', closestButton: true } }, o.dialog || {})),
    readManagementRow: async () => (o.postRow === null ? { found: false } : Object.assign({}, successRow, o.postRow || {})),
    clickFinalConfirm: async () => {
      calls.click++;
      calls.reservedAtClick = JSON.parse(fs.readFileSync(attemptsFile, 'utf8')).finalConsumed['conf-1'];
      return { clicked: true };
    },
    readCurrentShopEnableState: async () => ({ readOk: true, enabled: true, accountId: R68_ACCOUNT }),
    allowReopenMissingFinal: o.allowReopen === true,
  };
  return { dir, deps, frozen, businessDate, calls, stateFile, publishedFile, attemptsFile, newPlanId, providerCalls: () => providerCalls };
}

test('S68 scheduled: valid recurring authority + EMPTY manual consumptions completes ONE final click, zero initial, truthful metadata, roi 15.00 accepted', async () => {
  const f = scheduledFixture();
  try {
    const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
    assert.equal(r.status, 'success');
    assert.equal(r.publishedSuccess, true);
    assert.equal(r.clicks, 1, 'exactly one final click');
    assert.equal(r.finalClicks, 1);
    assert.equal(r.directPublish, false);
    assert.equal(f.calls.click, 1);
    assert.equal(r.authorizedBy, 'recurring-user-policy');
    assert.equal(r.humanApproved, false);
    assert.equal(typeof r.policyAuthorizedAt, 'string');
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(r.policyAuthorizedAt), 'policyAuthorizedAt is a real timestamp');
    // the durable reservation preceded the click
    assert.equal(f.calls.reservedAtClick && f.calls.reservedAtClick.status, 'pending');
    // truthful consume metadata: a structured recurring-user-policy authority record,
    // NEVER a fabricated human act (no humanAuthorizedAt / humanConfirmation on auto)
    const att = guard.loadAttemptsStore(f.attemptsFile);
    const fin = att.finalConsumed['conf-1'];
    assert.equal(fin.status, 'success');
    assert.equal(fin.recovery.authorizedBy, 'recurring-user-policy');
    assert.equal(fin.recovery.humanApproved, false);
    assert.equal(fin.recovery.initialStatus, 'unknown');
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(fin.recovery.policyAuthorizedAt), 'policyAuthorizedAt is a real ISO timestamp');
    assert.equal(fin.recovery.confirmationId, 'conf-1');
    assert.equal(fin.recovery.manifestHash, f.frozen.manifestHash);
    assert.equal(fin.recovery.runId, 'run-1');
    assert.equal(fin.recovery.businessDate, f.businessDate);
    assert.equal(fin.recovery.planNumber, 1);
    assert.equal(fin.recovery.accountId, R68_ACCOUNT);
    assert.equal(fin.recovery.planName, f.frozen.planName);
    assert.ok(!Object.prototype.hasOwnProperty.call(fin.recovery, 'humanAuthorizedAt'), 'auto record carries NO human authorization field');
    assert.ok(!Object.prototype.hasOwnProperty.call(fin.recovery, 'humanConfirmation'), 'auto record carries NO human confirmation field');
    assert.equal(att.consumed['conf-1'].status, 'success', 'initial unknown promoted only by the real success');
    assert.equal(att.reopenConsumed, undefined, 'auto mode never touches the reopen marker');
    // manual consumption list stays EMPTY (never forged, never required)
    const st = pw.loadDayState(f.stateFile, f.businessDate);
    assert.deepEqual(st.confirmationConsumptions, []);
    assert.equal(st.active, null, 'fresh readOk+enabled -> closed as published success');
    assert.equal((st.plans || []).length, 1);
    assert.equal(st.plans[0].planId, f.newPlanId);
    assert.equal(r.postPublishEnable.continueNextPlan, true);
    assert.equal(r.readback.roi, 15, 'positive ROI 15 (creation observed as 15.00) read back on the new row');
    assert.equal(r.readback.planId, f.newPlanId);
    const pub = JSON.parse(fs.readFileSync(f.publishedFile, 'utf8'));
    assert.ok(pub.publishedIds.includes('old-product-1'));
    assert.equal(pub.publishedIds.filter(id => id === '3845000000000000').length, 1);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('S68 scheduled: a valid per-shop cap override admits a higher frozen planNumber', async () => {
  const f = scheduledFixture({ planNumber: 4, shop: { plansPerShopPerDay: 10 } });
  try {
    const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
    assert.equal(r.status, 'success');
    assert.equal(r.clicks, 1);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('S68 scheduled: policy/shop drift matrix at the pre-absence gate refuses with ZERO marks and ZERO clicks', async () => {
  const cases = [
    ['recurring-policy-disabled', { policy: { enabled: false } }],
    ['recurring-policy-autoconfirm-off', { policy: { autoConfirm: false } }],
    ['recurring-policy-budget-drift', { policy: { dailyBudget: 450 } }],
    ['recurring-policy-roi-drift', { shop: { targetRoi: '20' } }],
    ['recurring-policy-shop-missing', { shop: null }],
    ['recurring-policy-shop-missing', { shop: { missing: true } }],
    ['recurring-policy-shop-deleted', { shop: { deleted: true } }],
    ['recurring-policy-shop-disabled', { shop: { enabled: false } }],
    ['recurring-policy-shop-name-drift', { shop: { name: '别的店' } }],
    ['recurring-policy-shop-account-drift', { shop: { accountId: '9999999999999999' } }],
    ['recurring-policy-plan-cap-exceeded', { planNumber: 4, policy: { plansPerShopPerDay: 3 } }],
    ['recurring-policy-unreadable', { driftOnProviderCall: [1], driftResult: { policy: null } }],
  ];
  for (const [why, opts] of cases) {
    const f = scheduledFixture(opts);
    try {
      const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
      assert.equal(r.status, 'refused', why + ' -> refused');
      assert.equal(r.reason, 'scheduled-policy-drift-before-absence:' + why);
      assert.equal(r.authorizedBy, 'recurring-user-policy');
      assert.equal(r.humanApproved, false);
      assert.equal(f.calls.click, 0, why + ' performs ZERO actual clicks');
      assert.equal(r.clicks, 0);
      const att = guard.loadAttemptsStore(f.attemptsFile);
      assert.ok(!Object.prototype.hasOwnProperty.call(att.finalConsumed, 'conf-1'), why + ' leaves zero final marks');
      assert.equal(att.consumed['conf-1'].status, 'unknown', why + ' never promotes the initial');
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('S68 scheduled: provider exceptions fail closed', async () => {
  const f = scheduledFixture({ providerThrow: true });
  try {
    const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
    assert.equal(r.status, 'refused');
    assert.ok(r.reason.startsWith('scheduled-policy-drift-before-absence:recurring-policy-provider-failed:'), r.reason);
    assert.equal(f.calls.click, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(guard.loadAttemptsStore(f.attemptsFile).finalConsumed, 'conf-1'));
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('S68 scheduled: authority-record / marker / provider-presence mismatches refuse before any gate', async () => {
  const cases = [
    ['recurring-authorization-mismatch', { recurringAuth: { confirmationId: 'foreign-conf' } }],
    ['recurring-authorization-mismatch', { recurringAuth: { manifestHash: 'e'.repeat(64) } }],
    ['recurring-authorization-mismatch', { recurringAuth: { humanApproved: true } }],
    ['recurring-authorization-mismatch', { recurringAuth: { authorizedBy: 'some-other-authority' } }],
    ['recurring-authorization-mismatch', { recurringAuth: { accountId: '9999999999999999' } }],
    ['recurring-authorization-mismatch', { recurringAuth: { planName: '别的名字' } }],
    ['recurring-authority-marker-missing', { active: { status: 'publish-unknown', reason: 'unknown-or-new-final-dialog', planNumber: 1, frozen: null } }],
  ];
  for (const [reason, opts] of cases) {
    const f = scheduledFixture(opts);
    if (opts.active) opts.active.frozen = f.frozen; // marker-missing case keeps the exact frozen
    if (opts.active) pw.persistDayState(f.stateFile, { businessDate: f.businessDate, plans: [], active: opts.active, firstPublishedPlan: null, lastSelected: [], confirmationConsumptions: [] });
    try {
      const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
      assert.equal(r.status, 'refused', reason);
      assert.equal(r.reason, reason);
      assert.equal(f.calls.click, 0);
      assert.ok(!Object.prototype.hasOwnProperty.call(guard.loadAttemptsStore(f.attemptsFile).finalConsumed, 'conf-1'));
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
  // provider missing entirely
  const f2 = scheduledFixture();
  try {
    delete f2.deps.recurringPolicyProvider;
    const r = await rp.resumeScheduledKnownFinalOnly(f2.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'recurring-policy-provider-missing');
    assert.equal(f2.calls.click, 0);
  } finally { fs.rmSync(f2.dir, { recursive: true, force: true }); }
});

test('S68 scheduled: an old business day refuses at the frozen gate AND at a fresh gate revalidation', async () => {
  const f1 = scheduledFixture({ frozenBusinessDate: '2020-01-01' });
  try {
    const r = await rp.resumeScheduledKnownFinalOnly(f1.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'business-date-changed');
    assert.equal(f1.calls.click, 0);
  } finally { fs.rmSync(f1.dir, { recursive: true, force: true }); }
  // day flips between entry and the pre-absence fresh revalidation
  const t0 = Date.now();
  const t1 = t0 + 2 * 24 * 3600 * 1000;
  const f2 = scheduledFixture({ nowSeq: [t0, t0, t1, t1, t1, t1, t1] });
  try {
    const r = await rp.resumeScheduledKnownFinalOnly(f2.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'scheduled-policy-drift-before-absence:business-date-changed');
    assert.equal(f2.calls.click, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(guard.loadAttemptsStore(f2.attemptsFile).finalConsumed, 'conf-1'));
  } finally { fs.rmSync(f2.dir, { recursive: true, force: true }); }
});

test('S68 scheduled: unknown/new final dialog refuses even with allowReopenMissingFinal; no reopen marker, no initial click', async () => {
  const f = scheduledFixture({ dialog: { text: '一个未知的新弹窗文案' }, allowReopen: true });
  try {
    const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'final-dialog-unknown-or-new');
    assert.equal(f.calls.click, 0);
    assert.equal(r.clicks, 0);
    const att = guard.loadAttemptsStore(f.attemptsFile);
    assert.ok(!Object.prototype.hasOwnProperty.call(att.finalConsumed, 'conf-1'));
    assert.ok(!Object.prototype.hasOwnProperty.call(att.reopenConsumed || {}, 'conf-1'), 'auto mode never writes the reopen marker');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('S68 scheduled: an already-consumed final is never replayed', async () => {
  const f = scheduledFixture({
    finalConsumed: { 'conf-1': { planNumber: 1, runId: 'run-1', businessDate: pw.shanghaiDate(Date.now()), manifestHash: 'x'.repeat(64), status: 'unknown', at: new Date().toISOString() } },
  });
  try {
    const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'final-already-consumed');
    assert.equal(f.calls.click, 0);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('S68 scheduled: drift BEFORE the final consume -> zero marks and zero clicks', async () => {
  const f = scheduledFixture({ driftOnProviderCall: [2] }); // gate B
  try {
    const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'scheduled-policy-drift-before-final-consume:recurring-policy-disabled');
    assert.equal(f.calls.click, 0);
    assert.equal(r.clicks, 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(guard.loadAttemptsStore(f.attemptsFile).finalConsumed, 'conf-1'), 'no mark was written');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('S68 scheduled: policy changes AFTER the final reservation -> ZERO actual clicks, marker stays unknown, no replay', async () => {
  const f = scheduledFixture({ driftOnProviderCall: [3] }); // gate C, after consume
  try {
    const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
    assert.equal(r.status, 'unknown');
    assert.equal(r.reason, 'scheduled-policy-drift-before-final-click:recurring-policy-disabled');
    assert.equal(r.clicked, false, 'never claims a click that did not happen');
    assert.equal(r.clicks, 0);
    assert.equal(r.finalClicks, 0);
    assert.equal(r.noReplay, true);
    assert.equal(f.calls.click, 0, 'zero actual final clicks');
    const att = guard.loadAttemptsStore(f.attemptsFile);
    assert.ok(Object.prototype.hasOwnProperty.call(att.finalConsumed, 'conf-1'), 'the reservation is never cleared');
    assert.equal(att.finalConsumed['conf-1'].status, 'unknown');
    assert.equal(att.consumed['conf-1'].status, 'unknown', 'initial stays unknown');
    const st = pw.loadDayState(f.stateFile, f.businessDate);
    assert.equal(st.active.status, 'publish-unknown', 'day state stays stopped/unknown');
    // replay is refused forever
    const again = await rp.resumeScheduledKnownFinalOnly(f.deps);
    assert.equal(again.status, 'refused');
    assert.equal(again.reason, 'final-already-consumed');
    assert.equal(f.calls.click, 0);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('S68 scheduled: an unknown readback stays unknown with no replay; a second run is refused', async () => {
  const f = scheduledFixture({ postRow: null });
  try {
    const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
    assert.equal(r.status, 'unknown');
    assert.equal(r.noReplay, true);
    assert.equal(f.calls.click, 1, 'the single final click did happen');
    const att = guard.loadAttemptsStore(f.attemptsFile);
    assert.equal(att.finalConsumed['conf-1'].status, 'unknown');
    assert.equal(att.consumed['conf-1'].status, 'unknown');
    const again = await rp.resumeScheduledKnownFinalOnly(f.deps);
    assert.equal(again.status, 'refused');
    // the unknown outcome durably rewrote active.reason, so the second run stops at the
    // earliest identity gate; either way it is a refusal with ZERO further clicks.
    assert.equal(again.reason, 'not-the-unique-stopped-final-confirm');
    assert.equal(f.calls.click, 1, 'no second click ever');
    assert.equal(guard.loadAttemptsStore(f.attemptsFile).finalConsumed['conf-1'].status, 'unknown', 'unknown retained, never replayed');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('S68 scheduled: creation drift still refuses inside the shared core (config gate uses the strict decimal guard)', async () => {
  for (const creation of [{ roi: '14' }, { roi: '15.5' }, { budget: '300.01' }, { publishButtonCount: 2 }, { commissionChecked: false }]) {
    const f = scheduledFixture({ creation });
    try {
      const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
      assert.equal(r.status, 'refused');
      assert.equal(r.reason, 'creation-config-drift');
      assert.equal(f.calls.click, 0);
      assert.ok(!Object.prototype.hasOwnProperty.call(guard.loadAttemptsStore(f.attemptsFile).finalConsumed, 'conf-1'));
    } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
  }
  // '15.00'/'300.00' equivalence is already proven by the success test above.
});

test('S68 manual wrapper: unchanged contract, NO scheduled fallback when humanAuth/consumption are missing', async () => {
  // scheduled-style deps (recurringAuth present, humanAuth absent, consumptions EMPTY)
  const f1 = scheduledFixture();
  try {
    const r = await rp.resumeKnownFinalOnly(f1.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'human-authorization-mismatch', 'manual API never falls back to the policy authority');
    assert.equal(r.authorizedBy, undefined, 'manual results carry no policy metadata');
    assert.equal(f1.calls.click, 0);
  } finally { fs.rmSync(f1.dir, { recursive: true, force: true }); }
  // humanAuth present but the durable manual consumption record missing
  const f2 = scheduledFixture({ authority: 'manual' });
  try {
    const st = JSON.parse(fs.readFileSync(f2.stateFile, 'utf8'));
    st.confirmationConsumptions = []; // no durable human consumption was ever written
    pw.persistDayState(f2.stateFile, st);
    const r = await rp.resumeKnownFinalOnly(f2.deps);
    assert.equal(r.status, 'refused');
    assert.equal(r.reason, 'human-consumption-record-missing');
    assert.equal(f2.calls.click, 0);
  } finally { fs.rmSync(f2.dir, { recursive: true, force: true }); }
});

test('S68 manual wrapper: the old manual success path still completes with its unchanged metadata', async () => {
  const f = scheduledFixture({ authority: 'manual' });
  try {
    const r = await rp.resumeKnownFinalOnly(f.deps);
    assert.equal(r.status, 'success');
    assert.equal(r.clicks, 1);
    assert.equal(r.authorizedBy, undefined);
    const att = guard.loadAttemptsStore(f.attemptsFile);
    assert.equal(att.finalConsumed['conf-1'].status, 'success');
    assert.equal(att.finalConsumed['conf-1'].recovery.humanConfirmation, '确认发布', 'manual metadata unchanged');
    assert.ok(/^\d{4}-\d{2}-\d{2}T/.test(att.finalConsumed['conf-1'].recovery.humanAuthorizedAt), 'manual keeps the human timestamp');
    const st = pw.loadDayState(f.stateFile, f.businessDate);
    assert.equal(st.confirmationConsumptions.length, 1, 'the manual consumption record is preserved, never rewritten by the auto path');
    assert.equal(st.active, null);
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});

test('S68 scheduled: auto mode never requires the manual consumption list (success with EMPTY consumptions already proven) and never writes it', async () => {
  const f = scheduledFixture();
  try {
    const r = await rp.resumeScheduledKnownFinalOnly(f.deps);
    assert.equal(r.status, 'success');
    const st = JSON.parse(fs.readFileSync(f.stateFile, 'utf8'));
    assert.deepEqual(st.confirmationConsumptions || [], [], 'no fabricated human consumption record was written');
  } finally { fs.rmSync(f.dir, { recursive: true, force: true }); }
});
