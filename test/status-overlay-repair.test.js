'use strict';

/**
 * AD-GUARD-STATUS-OVERLAY-20261018-F1 回归：
 *  A. monitor._recordBatch / getStatus 批次确认口径——同日 allPausedConfirmed 与
 *     allEnabledConfirmed 双 true 假象（先开后停 / 先停后开 / partial 未知 / 旧持久双 true）；
 *     不清历史（runs/totals 原样），确认时间不跨批次嫁接，adBelief/自动动作逻辑不变。
 *  B. dismissKnownChengfangOverlays 有界等待重读——2026-10-18 真实反例：
 *     瑾：探针遇导航 Execution context destroyed 立即失败；
 *     敏敏：同一浮窗加载完成后存在唯一 .tools-vmok-plugin-modal__close-icon（overlay-dom.json
 *     白名单探针 state=dismissable），生产较早检查却 no-control 立即失败。
 *     只读探针的短暂导航与已知 root 控件未就绪 → 有界重读（明确上限+审计）后重新核验
 *     可信 URL/唯一控件；未知/多义/危险仍零点击零重读；永久缺控件如实阻断；
 *     绝不点业务 CTA「新建自动投放计划」；点击后消失确认保留，导航中不误判已关闭。
 *
 * 全部隔离运行：mock DOM/VM + 临时目录 + 合成数据；不触网、不开浏览器、不读写 Cookie 值。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const { Monitor } = require('../src/engine/monitor');
const {
  handleChengfangOverlayInPage,
  dismissKnownChengfangOverlays,
} = require('../src/adapters/chengfang-reader');
const { makeTempDir, writeTempCookie, makeCfgResult, makeClock } = require('./helpers');
const { shanghaiMs, shanghaiDate } = require('../src/lib/time');

// ── A. monitor 批次确认口径 ─────────────────────────────────────────────

function setupMonitor(t) {
  const cookieDir = makeTempDir('pg-f1-cookies-');
  const dataDir = makeTempDir('pg-f1-data-');
  t.after(() => {
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const shops = [{ id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true }];
  for (const s of shops) writeTempCookie(cookieDir, s.cookieFile);
  const cfgResult = makeCfgResult({ cookieDir, shops });
  const clock = makeClock(shanghaiMs('2026-10-18', '10:00'));
  const monitor = new Monitor(cfgResult, { reader: null, controller: null }, {
    dataDir,
    nowFn: clock.nowFn,
    delayFn: clock.delayFn,
  });
  return { monitor, clock, today: shanghaiDate(clock.nowFn()) };
}

const COUNTS0 = { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 };

test('A1 先开后停：暂停批次落库后旧 allEnabledConfirmed 必须重置（不再双 true）', (t) => {
  const { monitor, clock, today } = setupMonitor(t);
  monitor._recordBatch('shop-a', { outcome: 'all_enabled_confirmed', allEnabledConfirmed: true, counts: COUNTS0, details: [], batchDate: today });
  const recMid = monitor.batches['shop-a'][today];
  assert.equal(recMid.allEnabledConfirmed, true);
  assert.equal(recMid.allPausedConfirmed, false);

  clock.advance(60000); // 冻结时钟需显式推进，保证两批次时间可区分
  monitor._recordBatch('shop-a', { outcome: 'all_paused_confirmed', allPausedConfirmed: true, allClosedConfirmed: true, counts: COUNTS0, details: [], batchDate: today });
  const rec = monitor.batches['shop-a'][today];
  assert.equal(rec.allPausedConfirmed, true);
  assert.equal(rec.allEnabledConfirmed, false, '暂停确认后同日不得残留 allEnabledConfirmed=true');
  assert.equal(rec.allClosedConfirmed, true);
  assert.equal(rec.runs.length, 2, '历史 runs 不清除');

  // adBelief / 自动动作逻辑不变：暂停确认 → off
  assert.equal(monitor.adBelief['shop-a'].on, false);
  const shop = monitor.getStatus().shops.find((s) => s.id === 'shop-a');
  assert.equal(shop.lastAdState, 'off');

  const bt = shop.batchToday;
  assert.equal(bt.allPausedConfirmed, true);
  assert.equal(bt.allEnabledConfirmed, false);
  assert.equal(bt.confirmedAt, rec.runs[1].at, '确认时间取暂停批次自身时间，不跨批次嫁接');
  assert.notEqual(bt.confirmedAt, rec.runs[0].at);
});

test('A2 先停后开：开启确认批次落库后旧 allPaused/allClosed 必须重置', (t) => {
  const { monitor, clock, today } = setupMonitor(t);
  monitor._recordBatch('shop-a', { outcome: 'all_paused_confirmed', allPausedConfirmed: true, allClosedConfirmed: true, counts: COUNTS0, details: [], batchDate: today });
  clock.advance(60000);
  monitor._recordBatch('shop-a', { outcome: 'all_enabled_confirmed', allEnabledConfirmed: true, counts: COUNTS0, details: [], batchDate: today });
  const rec = monitor.batches['shop-a'][today];
  assert.equal(rec.allEnabledConfirmed, true);
  assert.equal(rec.allPausedConfirmed, false, '开启确认后同日不得残留 allPausedConfirmed=true');
  assert.equal(rec.allClosedConfirmed, false);

  assert.equal(monitor.adBelief['shop-a'].on, true, 'adBelief 逻辑不变：开启确认 → on');
  const bt = monitor.getStatus().shops.find((s) => s.id === 'shop-a').batchToday;
  assert.equal(bt.allEnabledConfirmed, true);
  assert.equal(bt.allPausedConfirmed, false);
  assert.equal(bt.confirmedAt, rec.runs[1].at, '确认时间取开启批次自身时间');
  assert.notEqual(bt.confirmedAt, rec.runs[0].at, '时间不得跨批次嫁接');
});

test('A3 partial 未知：既不继承旧开启确认，也不宣称暂停（totals 仍是历史累计）', (t) => {
  const { monitor, today } = setupMonitor(t);
  monitor._recordBatch('shop-a', {
    outcome: 'all_enabled_confirmed', allEnabledConfirmed: true, counts: COUNTS0,
    details: [{ adId: 'ad-1', outcome: 'confirmed_open' }], batchDate: today,
  });
  monitor._recordBatch('shop-a', {
    outcome: 'partial', counts: { confirmed: 1, failed: 0, unknown: 49, skipped: 0, cancelled: 0 },
    details: [{ adId: 'ad-2', outcome: 'unknown' }], reason: '在途读取未落定', batchDate: today,
  });
  const rec = monitor.batches['shop-a'][today];
  assert.equal(rec.allEnabledConfirmed, false, 'partial 后不得保留旧「全部已开启确认」');
  assert.equal(rec.allPausedConfirmed, false, 'partial 不得宣称已暂停');

  const shop = monitor.getStatus().shops.find((s) => s.id === 'shop-a');
  const bt = shop.batchToday;
  assert.equal(bt.allEnabledConfirmed, false);
  assert.equal(bt.allPausedConfirmed, false);
  assert.equal(bt.confirmedAt, null, '无当前确认侧 → 无确认时间');
  // totals 是历史累计（不清除），但不得用于判定当前开关
  assert.deepEqual(bt.totals, { confirmed: 1, failed: 0, unknown: 1, skipped: 0 });
  assert.equal(bt.runs, 2);
  // adBelief 不因 partial 更新（保持开启确认时的 on）
  assert.equal(monitor.adBelief['shop-a'].on, true);
});

test('A4 旧持久双 true 记录：getStatus 按最近 run 修正投影，不清历史、时间不嫁接', (t) => {
  const { monitor, today } = setupMonitor(t);
  // 模拟 state-before.json 瑾漂亮形状：旧版本落盘的同日双 true 持久记录
  const t1 = '2026-10-17T16:13:47.111Z';
  const t2 = '2026-10-18T08:13:46.829Z';
  const t3 = '2026-10-18T08:24:26.668Z';
  monitor.batches['shop-a'] = {
    [today]: {
      runs: [
        { at: t1, outcome: 'all_enabled_confirmed', counts: COUNTS0, allClosedConfirmed: false, allPausedConfirmed: false, allEnabledConfirmed: true, reason: '开启确认' },
        { at: t2, outcome: 'partial', counts: COUNTS0, allClosedConfirmed: false, allPausedConfirmed: false, reason: '在途读取未落定' },
        { at: t3, outcome: 'all_paused_confirmed', counts: COUNTS0, allClosedConfirmed: true, allPausedConfirmed: true, reason: '暂停确认' },
      ],
      totals: { confirmed: ['x1'], failed: [], unknown: ['x2'], skipped: [] },
      allClosedConfirmed: true,
      allPausedConfirmed: true,
      allEnabledConfirmed: true, // ← 旧版本残留的双 true
      lastBatchAt: t3,
    },
  };
  const bt = monitor.getStatus().shops.find((s) => s.id === 'shop-a').batchToday;
  assert.equal(bt.allPausedConfirmed, true);
  assert.equal(bt.allEnabledConfirmed, false, '投影必须按最近 run 修正，双 true 不得透出');
  assert.equal(bt.allClosedConfirmed, true);
  assert.equal(bt.confirmedAt, t3, '确认时间来自暂停确认 run 自身，不得嫁接 t1');
  // 不清历史
  assert.equal(bt.runs, 3);
  assert.deepEqual(bt.totals, { confirmed: 1, failed: 0, unknown: 1, skipped: 0 });
  assert.equal(bt.lastRuns.length, 3);
  assert.equal(bt.lastRuns[0].allEnabledConfirmed, true, '历史 run 原样保留');
});

// ── B. 浮窗有界重读（真实反例回归）─────────────────────────────────────

const QC_URL = 'https://qianchuan.jinritemai.com/overall-prom';

// 极简 mock DOM（与 qianchuan-overlay-recovery.test.js 同构，只支持所需选择器形态）
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
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  removeChild(child) { this.children = this.children.filter((c) => c !== child); child.parentElement = null; }
  getBoundingClientRect() {
    if (!this.visible || this.removed) return { width: 0, height: 0, top: 0, left: 0 };
    return { width: 120, height: 40, top: 0, left: 0 };
  }
  contains(node) {
    if (!node) return false;
    if (node === this) return true;
    return this.children.some((c) => c.contains(node));
  }
  click() { this.clicked += 1; if (typeof this.onClick === 'function') this.onClick(this); }
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
  return { root, document: { querySelectorAll: (sel) => queryAll(root, sel), querySelector: (sel) => queryAll(root, sel)[0] || null } };
}
function runInPage(fn, arg, env) {
  const ctx = vm.createContext({
    document: env.document,
    location: { href: env.url },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    URL, Node: { TEXT_NODE: 3 }, console, setTimeout,
  });
  const call = arg === undefined ? 'undefined' : JSON.stringify(arg);
  return vm.runInContext(`(${fn.toString()})(${call})`, ctx);
}
function removeNode(node) {
  node.removed = true;
  if (node.parentElement) node.parentElement.removeChild(node);
}

/** overlay-dom.json 脱敏形状：真实敏敏浮窗（modal-wrap + 业务 CTA「新建自动投放计划」+ 唯一 X）。 */
function addRealOverlay(root, { withClose } = {}) {
  const wrap = new FakeNode('div', { class: 'tools-vmok-plugin-modal__wrap ocean-vmok-plugin-oc-modal-wrap' });
  root.appendChild(wrap);
  const inner = new FakeNode('div', {}, '开启联盟合作达人自动投 效率翻倍 增量到手 成本可控');
  wrap.appendChild(inner);
  const cta = new FakeNode('button', { class: 'tools-vmok-plugin-button aweme-auto-pull-modal-btn' }, ' 新建自动投放计划 ');
  inner.appendChild(cta);
  let x = null;
  if (withClose) x = addCloseIcon(inner, wrap);
  return { wrap, inner, cta, get x() { return x; }, addClose: () => { x = addCloseIcon(inner, wrap); return x; } };
}
function addCloseIcon(inner, wrap) {
  const x = new FakeNode('div', { class: 'tools-vmok-plugin-modal__close-icon' });
  x.onClick = () => removeNode(wrap);
  inner.appendChild(x);
  return x;
}

function makeScriptedPage(dom, opts = {}) {
  const audits = [];
  const page = {
    _n: 0,
    _url: QC_URL,
    async evaluate(fn, arg) {
      page._n += 1;
      if (opts.failFirstN && page._n <= opts.failFirstN) {
        throw new Error(opts.failMessage || 'page.evaluate: Execution context was destroyed, most likely because of a navigation');
      }
      if (opts.failAlways) throw new Error(opts.failMessage || 'boom');
      if (fn && fn.name === 'handleChengfangOverlayInPage') {
        if (typeof opts.beforeProbe === 'function') opts.beforeProbe(page._n);
        return runInPage(fn, arg, { document: dom.document, url: page._url });
      }
      return undefined;
    },
    async waitForTimeout(ms) { await new Promise((r) => setTimeout(r, Math.min(ms, 5))); },
  };
  const audit = (e) => audits.push(e);
  return { page, audits, audit };
}

test('B1 真实反例（瑾）：探针遇导航 Execution context destroyed → 有界重读后成功关闭唯一 X', async () => {
  const dom = makeDom();
  const ov = addRealOverlay(dom.root, { withClose: true });
  const { page, audits, audit } = makeScriptedPage(dom, { failFirstN: 1 });
  const r = await dismissKnownChengfangOverlays({ page, audit, shopId: '瑾漂亮潮流服饰', transientGapMs: 10, transientBudgetMs: 2000 });
  assert.equal(r.dismissed, true);
  assert.equal(r.action, 'dismiss-intro');
  assert.equal(ov.x.clicked, 1, '重新核验可信 URL/唯一控件后只点一次既有白名单 X');
  assert.equal(ov.cta.clicked, 0, '业务 CTA「新建自动投放计划」绝不点击');
  const rereads = audits.filter((a) => a.result === 'transient-reread');
  assert.ok(rereads.length >= 1, '每次有界重读必须留审计');
  assert.match(rereads[0].reason, /probe-navigation/);
  assert.match(rereads[0].reason, /有界重读 1\/10/, '审计含明确上限');
});

test('B2 真实反例（敏敏）：已知浮窗控件尚未就绪 no-control → 有界等待重读后就绪并关闭', async () => {
  const dom = makeDom();
  const ov = addRealOverlay(dom.root, { withClose: false });
  // 第 3 次探针前控件才渲染完成（真实现场：加载完成后唯一 close-icon 存在）
  const { page, audits, audit } = makeScriptedPage(dom, {
    beforeProbe: (n) => { if (n === 3) ov.addClose(); },
  });
  const r = await dismissKnownChengfangOverlays({ page, audit, shopId: '敏敏高定私服', transientGapMs: 10, transientBudgetMs: 2000 });
  assert.equal(r.dismissed, true);
  assert.equal(r.action, 'dismiss-intro');
  assert.equal(ov.x.clicked, 1);
  assert.equal(ov.cta.clicked, 0, '不得为绕过 no-control 而点业务 CTA 或扩大选择器');
  const rereads = audits.filter((a) => a.result === 'transient-reread');
  assert.ok(rereads.length >= 1);
  assert.match(rereads[0].reason, /control-not-ready/);
});

test('B3 永久缺控件：预算/次数耗尽后如实阻断 no-control，零点击、上限生效', async () => {
  const dom = makeDom();
  const ov = addRealOverlay(dom.root, { withClose: false });
  const { page, audits, audit } = makeScriptedPage(dom);
  const r = await dismissKnownChengfangOverlays({
    page, audit, shopId: 'no-control-forever',
    transientGapMs: 1, transientBudgetMs: 60000, maxTransientRereads: 3,
  });
  assert.equal(r.dismissed, false);
  assert.equal(r.state, 'no-control');
  assert.equal(ov.cta.clicked, 0);
  assert.equal(ov.wrap.removed, false);
  // 次数上限：首次探针 + 3 次有界重读 = 4 次探针（点击从未发生）
  assert.equal(page._n, 4, '有界重读次数必须服从明确上限');
  assert.equal(audits.filter((a) => a.result === 'transient-reread').length, 3);
  const blocked = audits.filter((a) => a.result === 'blocked');
  assert.ok(blocked.length >= 1, '最终阻断必须留审计');
});

test('B4 未知/多义/危险阻断：零重读、零点击（不借有界重读扩权）', async () => {
  // 未知浮窗
  const a = makeDom();
  const um = new FakeNode('div', { class: 'ovui-modal' }, 'unknown');
  a.root.appendChild(um);
  const pa = makeScriptedPage(a);
  const ra = await dismissKnownChengfangOverlays({ page: pa.page, audit: pa.audit, transientGapMs: 1, transientBudgetMs: 3000 });
  assert.equal(ra.dismissed, false);
  assert.equal(ra.state, 'blocked');
  assert.equal(pa.page._n, 1, 'blocked 不得触发重读');
  assert.equal(um.clicked, 0);

  // 多个独立真实 modal（multiple-intro）
  const b = makeDom();
  addRealOverlay(b.root, { withClose: true });
  const ov2 = addRealOverlay(b.root, { withClose: true });
  const pb = makeScriptedPage(b);
  const rb = await dismissKnownChengfangOverlays({ page: pb.page, audit: pb.audit, transientGapMs: 1, transientBudgetMs: 3000 });
  assert.equal(rb.state, 'blocked');
  assert.equal(pb.page._n, 1);
  assert.equal(ov2.cta.clicked, 0);

  // 危险业务文本
  const c = makeDom();
  const wrap = new FakeNode('div', { class: 'tools-vmok-plugin-modal__wrap' }, '确认删除这 30 条计划？删除后不可恢复');
  c.root.appendChild(wrap);
  const xc = new FakeNode('div', { class: 'tools-vmok-plugin-modal__close-icon' });
  wrap.appendChild(xc);
  const pc = makeScriptedPage(c);
  const rc = await dismissKnownChengfangOverlays({ page: pc.page, audit: pc.audit, transientGapMs: 1, transientBudgetMs: 3000 });
  assert.equal(rc.state, 'blocked');
  assert.equal(pc.page._n, 1);
  assert.equal(xc.clicked, 0, '危险确认框绝不点任何控件');
});

test('B5 非导航类探针异常（页面已关闭）：立即失败，不消耗重读预算', async () => {
  const dom = makeDom();
  const { page, audits, audit } = makeScriptedPage(dom, {
    failAlways: true, failMessage: 'Target page, context or browser has been closed',
  });
  const r = await dismissKnownChengfangOverlays({ page, audit, transientGapMs: 1, transientBudgetMs: 3000 });
  assert.equal(r.dismissed, false);
  assert.equal(r.state, 'probe-failed');
  assert.equal(page._n, 1);
  assert.equal(audits.filter((a) => a.result === 'transient-reread').length, 0);
});

test('B6 点击后消失确认保留：二次观察期间导航异常不得误判为已关闭', async () => {
  const dom = makeDom();
  const ov = addRealOverlay(dom.root, { withClose: true });
  let n = 0;
  const audits = [];
  const page = {
    async evaluate(fn, arg) {
      n += 1;
      if (n === 1) return runInPage(fn, arg, { document: dom.document, url: QC_URL }); // 探针 dismissable
      if (n === 2) return runInPage(fn, arg, { document: dom.document, url: QC_URL }); // 点击（X 不生效）
      throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
    },
    async waitForTimeout(ms) { await new Promise((r) => setTimeout(r, Math.min(ms, 5))); },
  };
  // X 点击不消失（works=false 形状）：把 onClick 置空，wrap 不移除
  ov.x.onClick = null;
  const r = await dismissKnownChengfangOverlays({ page, audit: (e) => audits.push(e), transientGapMs: 1, transientBudgetMs: 3000 });
  assert.equal(r.dismissed, false);
  assert.equal(r.state, 'not-disappeared', '导航中/未消失一律如实失败，绝不伪造关闭');
  assert.equal(ov.x.clicked, 1);
});

test('B7 无浮窗（none）：零重读直接通过，行为与旧版一致', async () => {
  const dom = makeDom();
  const { page, audit, audits } = makeScriptedPage(dom);
  const r = await dismissKnownChengfangOverlays({ page, audit, transientGapMs: 1, transientBudgetMs: 3000 });
  assert.equal(r.state, 'none');
  assert.equal(r.dismissed, false);
  assert.equal(page._n, 1);
  assert.equal(audits.length, 0);
});

// ── C. 危险文本：只看实际渲染文本（隐藏模板/背景/脚本不得误判为现场危险浮层）───

test('C1 危险文本仅在隐藏节点/脚本：不再触发 danger-text 阻断，且留下无敏感原文的结构化诊断', () => {
  const dom = makeDom();
  // 已知介绍浮层（modal-wrap，唯一可见关闭控件），可见正文是普通说明
  const wrap = new FakeNode('div', { class: 'tools-vmok-plugin-modal__wrap' }, '新功能上线说明 全域投放升级');
  dom.root.appendChild(wrap);
  // 隐藏子节点（display:none 语义：可见性不成立 → getBoundingClientRect 返回 0）携带危险文本
  const hidden = new FakeNode('div', { class: 'tpl', visible: false }, '确定要删除这 5 条计划吗？删除后不可恢复');
  wrap.appendChild(hidden);
  // 脚本节点（非渲染）携带危险文本
  const script = new FakeNode('script', {}, '是否确认暂停全部计划');
  wrap.appendChild(script);
  addCloseIcon(wrap, wrap);
  const r = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL });
  assert.equal(r.trusted, true);
  assert.ok(!r.blockers.includes('danger-text'), '仅隐藏/脚本文本不构成现场危险浮层，不得阻断');
  assert.equal(r.state, 'dismissable', '存在唯一可见关闭控件的正常介绍浮层仍可白名单关闭');
  const dg = (r.dangerDiag || []).find((d) => d.hidden === true);
  assert.ok(dg, '必须记录隐藏危险文本的结构化诊断以便精确定位');
  assert.equal(dg.scope, 'known');
  assert.equal(typeof dg.rawChars, 'number');
  assert.equal(typeof dg.visChars, 'number');
  assert.ok(dg.rawChars > dg.visChars, '原始文本更长而可见文本更短，正说明命中来自未渲染节点');
  for (const key of ['text', 'snippet', 'raw', 'visible']) {
    assert.ok(!(key in dg), `诊断字段 ${key} 不得携带任何页面原文`);
  }
});

test('C2 真实可见危险确认仍必须阻断（未削弱 danger 规则，fail-closed 保留）', () => {
  const dom = makeDom();
  const wrap = new FakeNode('div', { class: 'tools-vmok-plugin-modal__wrap' }, '确定要暂停 8 条计划吗？暂停后将停止投放，请谨慎操作');
  dom.root.appendChild(wrap);
  addCloseIcon(wrap, wrap);
  const r = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL });
  assert.ok(r.blockers.includes('danger-text'), '可见危险确认必须阻断');
  assert.equal(r.state, 'blocked');
  const dg = (r.dangerDiag || []).find((d) => d.hidden === false);
  assert.ok(dg, '可见危险命中必须记录诊断（scope/tag/chars）');
  assert.equal(dg.scope, 'known');
  assert.equal(typeof dg.chars, 'number');
});

test('C3 未知弹层内可见危险文本：作为 dialog 候选同样阻断并标注 scope', () => {
  const dom = makeDom();
  // 非白名单业务对话框（仅命中泛 modal 选择器 → foreign/dialog 候选），可见危险文本
  const dlg = new FakeNode('div', { class: 'ovui-modal ovui-dialog', role: 'dialog' }, '是否确认终止投放？终止后不可恢复');
  dom.root.appendChild(dlg);
  const r = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL });
  assert.ok(r.blockers.includes('danger-text'));
  assert.equal(r.state, 'blocked');
  const dg = (r.dangerDiag || []).find((d) => d.hidden === false);
  assert.ok(dg && dg.scope === 'dialog', '未知弹层危险文本 scope 应为 dialog');
});

// ── C4-C6. 页面根污染回归（observed-overlay.json 2026-10-19 /home 现场形状）───
// 现场摘要：handleChengfangOverlayInPage 返回 danger-text，唯一 dangerDiag 为
//   {scope:'dialog', tag:'body', cls:'tools-vmok-plugin-popup__lock', chars:1117, hidden:false}；
//   实际浮窗 overall-release-modal-v2-wrap 正文无危险词、有唯一
//   button.close-button[aria-label=关闭]；小店随心推/互斥 只出现在 body 背景正文。
//   下方合成 DOM 即该真实浏览器 fixture 的脱敏结构复现（无 URL/图片/埋点值），
//   mock 的 document.querySelectorAll 与浏览器一致：可命中页面根 body 本身。

const OBS_BODY_CLASS = 'tools-vmok-plugin-popup__lock';
const OBS_MODAL_CLASS = 'tools-vmok-plugin-modal__wrap ocean-vmok-plugin-oc-modal-wrap overall-release-modal-v2-wrap';

function makeBodyLockedDom() {
  const body = new FakeNode('body', { class: OBS_BODY_CLASS });
  const document = {
    body,
    querySelectorAll: (sel) => {
      const own = String(sel).split(',').map((s) => s.trim()).filter(Boolean)
        .some((s) => s.split(/\s+/).length === 1 && matchCompound(body, s));
      return (own ? [body] : []).concat(queryAll(body, sel));
    },
    querySelector: (sel) => document.querySelectorAll(sel)[0] || null,
  };
  return { root: body, document };
}

/** observed-overlay.json dom[0].html 结构复现：旧 X 因 --hide 不可见，唯一 v2 关闭按钮。 */
function addObservedReleaseModal(root) {
  const wrap = new FakeNode('div', { class: OBS_MODAL_CLASS });
  root.appendChild(wrap);
  wrap.appendChild(new FakeNode('div', {
    class: 'tools-vmok-plugin-modal__close-icon tools-vmok-plugin-modal__close-icon--hide',
    visible: false,
  }));
  const content = new FakeNode('div', { class: 'content' },
    '有帮助 没帮助 针对多项营销能力调优，通过智能预算分配与权益补贴，让每一笔投入更高效 了解详情 ');
  wrap.appendChild(content);
  const closeBtn = new FakeNode('button', { class: 'close-button', 'aria-label': '关闭', type: 'button' });
  content.appendChild(closeBtn);
  closeBtn.appendChild(new FakeNode('iconpark-icon', { name: 'oc-icon-close' }));
  const cta1 = new FakeNode('button', { class: 'tools-vmok-plugin-button' }, ' 投放乘方 ');
  const cta2 = new FakeNode('button', { class: 'tools-vmok-plugin-button' }, ' 开启货款直投 ');
  content.appendChild(cta1);
  content.appendChild(cta2);
  closeBtn.onClick = () => removeNode(wrap);
  return { wrap, closeBtn, cta1, cta2 };
}

test('C4 现场回归：body 携带 popup__lock+背景小店随心推/互斥时，已知 overall-release v2 浮窗仍判可安全关闭并只点唯一关闭钮', async () => {
  const dom = makeBodyLockedDom();
  dom.root.ownText = '首页 数据概览 小店随心推 计划互斥规则说明 素材管理 全域推广 出价建议 罗盘 ';
  const ov = addObservedReleaseModal(dom.root);
  const probe = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL });
  assert.equal(probe.trusted, true);
  assert.ok(!probe.blockers.includes('danger-text'), 'body 背景危险词不得污染弹窗判定（observed-overlay.json 旧误判复现）');
  assert.equal(probe.state, 'dismissable');
  assert.equal(probe.closeCandidates, 1);
  assert.ok(!(probe.dangerDiag || []).some((d) => d.tag === 'body'), 'body 页面根不得再作为弹窗危险容器');

  const { page, audit, audits } = makeScriptedPage(dom);
  const r = await dismissKnownChengfangOverlays({ page, audit, transientGapMs: 1, transientBudgetMs: 3000 });
  assert.equal(r.dismissed, true);
  assert.equal(r.action, 'dismiss-intro');
  assert.equal(ov.closeBtn.clicked, 1, '只点唯一 aria-label=关闭 钮一次');
  assert.equal(ov.cta1.clicked, 0, '绝不点业务 CTA 投放乘方');
  assert.equal(ov.cta2.clicked, 0, '绝不点业务 CTA 开启货款直投');
  assert.equal(ov.wrap.removed, true);
  assert.equal(audits.filter((a) => a.result === 'blocked').length, 0, '关闭走完整白名单校验后才点击，非假健康放行');
});

test('C5 现场回归：body 携带 popup__lock 时，body 下真实危险 dialog 仍独立扫描、danger-text 阻断且零点击', () => {
  const dom = makeBodyLockedDom();
  dom.root.ownText = '首页 小店随心推 互斥说明 数据概览 ';
  const dlg = new FakeNode('div', { class: 'ovui-modal ovui-dialog', role: 'dialog' }, '确定要删除这 12 条计划吗？删除后不可恢复');
  dom.root.appendChild(dlg);
  const x = new FakeNode('button', { class: 'close-button' });
  dlg.appendChild(x);
  const r = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(r.trusted, true);
  assert.ok(r.blockers.includes('danger-text'), '真实业务危险确认必须继续阻断，不得因排除页面根而放宽');
  assert.equal(r.state, 'blocked');
  assert.equal(r.clicked, false);
  assert.equal(x.clicked, 0, '危险弹层零点击');
  const dg = (r.dangerDiag || []).find((d) => d.hidden === false);
  assert.ok(dg && dg.tag === 'div' && dg.scope === 'dialog', '危险命中必须定位到真实弹窗本身，不得被 body 祖先去重吞掉或错位到 body');
});

test('C6 现场回归：body 携带 popup__lock 时，多个/未知弹窗与多介绍浮窗仍逐一阻断（根排除不放松 foreign/multiple）', () => {
  const dom = makeBodyLockedDom();
  const u1 = new FakeNode('div', { class: 'ovui-modal' }, 'unknown one');
  const u2 = new FakeNode('div', { role: 'alertdialog' }, 'unknown two');
  dom.root.appendChild(u1);
  dom.root.appendChild(u2);
  const r = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom.document, url: QC_URL });
  assert.equal(r.state, 'blocked');
  assert.ok(r.blockers.includes('unknown-overlay:2'), '独立未知弹窗必须逐一计入 foreign，不得被 body 祖先去重合并/吞掉');
  assert.equal(r.clicked, false);

  const dom2 = makeBodyLockedDom();
  addRealOverlay(dom2.root, { withClose: true });
  addRealOverlay(dom2.root, { withClose: true });
  const r2 = runInPage(handleChengfangOverlayInPage, { click: true }, { document: dom2.document, url: QC_URL });
  assert.equal(r2.state, 'blocked');
  assert.ok(r2.blockers.includes('multiple-intro:2'), '多个已知介绍浮窗仍阻断，不得借道关闭其一');
});

// ── D. engine 真实执行字段 cycleRunning（区分检查中 / 值守空闲等待）───────────

test('D1 getStatus 暴露 cycleRunning：默认空闲 false，周期在途 true，收口后回落 false', (t) => {
  const { monitor } = setupMonitor(t);
  assert.equal(monitor.running, false);
  assert.equal(monitor.getStatus().monitor.cycleRunning, false, '空闲（无周期在途）必须为 false，界面不得显示检查中');
  monitor._cycleRunning = true;
  assert.equal(monitor.getStatus().monitor.cycleRunning, true, 'pollOnce/开启/手动验证在途时为 true');
  monitor._cycleRunning = false;
  assert.equal(monitor.getStatus().monitor.cycleRunning, false, '周期收口后回到 false（空闲等待下次巡查）');
});
