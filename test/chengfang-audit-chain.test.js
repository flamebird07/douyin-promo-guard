'use strict';

/**
 * AD-GUARD-COOKIE-AUDIT-CHAIN-20261019 F1 隔离测试：
 *
 * A) 审计透传链（只修缺失传参，不新建日志系统）：
 *    - ChengfangRunner._openSession 把 this.audit 传给 pageOpener（覆盖批次开会话、
 *      演练开会话；失败/正常收尾的 _closeSession 审计此前已接 this.audit）；
 *    - defaultChengfangOpener 把 audit 透传给 openChengfangShop（打开/检查点/浮窗）
 *      与 watchChengfangControlsForManualReview（控件失败恢复的浮窗审计用 session.audit）；
 *    - Monitor._readChengfangAdState（只读广告状态开会话）传 audit 给 opener，
 *      事件落 monitor 既有 audit.jsonl 与 processEvents；
 *    - 调用者未传 audit 的兼容语义不变。
 *
 * B) unknown-overlay 有界结构摘要（解除"无法定位剩余阻断"的直接证据缺口）：
 *    - 探针在 unknown 候选阻断时输出 unknownDiag（仅标签/类名/role，类名 60 字符
 *      严格截断、上限 5 条）；绝不含正文/outerHTML/URL/账户ID/Cookie；
 *    - dismissKnownChengfangOverlays 阻断路径把 unknownDiag 带进既有 chengfang-overlay
 *      审计事件；unknown/danger 门禁与零点击语义完全不变。
 *
 * 全部为 mock 工厂/注入 opener + node:vm 极简 DOM + 临时目录：
 * 无真实浏览器、无 Cookie 文件读写（仅合成 FAKE_ 值）、无网络、无 Git。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');

const cfMod = require('../src/adapters/chengfang-reader');
const { ChengfangRunner, defaultChengfangOpener } = require('../src/engine/chengfang-runner');
const { Monitor } = require('../src/engine/monitor');
const { makeTempDir, writeTempCookie, makeCfgResult } = require('./helpers');

// ── 极简 mock DOM（与 qianchuan-overlay-recovery/status-overlay-repair 同构子集）──

const QC_URL = 'https://qianchuan.jinritemai.com/overall-prom';
const SECRET_BODY = 'FAKE_BODY_NOISE_普通营销文案_绝不得进入审计';
const ACCOUNT_ID_TEXT = '1710242295996424';

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
  const parts = String(sel).trim().split(/\s+/).filter(Boolean);
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
      querySelectorAll: (sel) => queryAll(root, sel),
      querySelector: (sel) => queryAll(root, sel)[0] || null,
    },
  };
}
function runInPage(fn, arg, env) {
  const ctx = vm.createContext({
    document: env.document,
    location: { href: env.url },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    URL, Node: { TEXT_NODE: 3 }, console, setTimeout,
  });
  const call = arg === undefined ? 'undefined' : JSON.stringify(arg);
  return JSON.parse(JSON.stringify(vm.runInContext(`(${fn.toString()})(${call})`, ctx)));
}
function makePage(dom) {
  return {
    evaluate: async (fn, arg) => runInPage(fn, arg, { document: dom.document, url: QC_URL }),
    waitForTimeout: async () => {},
  };
}

// ── A1. defaultChengfangOpener 透传 audit（注入工厂 mock，无真实页面）──────────

function stubChengfangReader(t, captured) {
  const orig = {
    openChengfangShop: cfMod.openChengfangShop,
    createChengfangController: cfMod.createChengfangController,
    watchChengfangControlsForManualReview: cfMod.watchChengfangControlsForManualReview,
  };
  t.after(() => {
    cfMod.openChengfangShop = orig.openChengfangShop;
    cfMod.createChengfangController = orig.createChengfangController;
    cfMod.watchChengfangControlsForManualReview = orig.watchChengfangControlsForManualReview;
  });
  cfMod.openChengfangShop = async (p) => {
    captured.openShop = p;
    return {
      browser: { closed: false, close: async () => {} },
      target: { name: 'mock-target-page' },
      account: { id: 'mock-account' },
      context: { name: 'mock-context' },
      cookieSession: { filePath: null, startFingerprint: null },
    };
  };
  cfMod.createChengfangController = () => ({ name: 'mock-controller' });
  cfMod.watchChengfangControlsForManualReview = (controller, session) => {
    captured.watchSession = session;
    return controller;
  };
}

test('A1a defaultChengfangOpener：audit 透传给 openChengfangShop 与 manual-review watch；其余出参不变', async (t) => {
  const captured = {};
  stubChengfangReader(t, captured);
  const audit = (e) => { (captured.events = captured.events || []).push(e); };
  const loginCfg = { cookieSourceDir: 'X:/mock' };
  const shopCfg = { id: 'shop-001' };

  const session = await defaultChengfangOpener({ loginCfg, shopCfg, audit });

  assert.strictEqual(captured.openShop.audit, audit, 'openChengfangShop 必须收到 audit（真实写入/检查点/浮窗事件落主审计的前提）');
  assert.strictEqual(captured.openShop.loginCfg, loginCfg, '仅补传 audit，不改既有传参');
  assert.strictEqual(captured.openShop.shopCfg, shopCfg);
  assert.strictEqual(captured.watchSession.audit, audit, 'watchChengfangControlsForManualReview 必须收到 audit（session.audit 供控件失败恢复的浮窗审计）');
  assert.strictEqual(captured.watchSession.loginCfg, loginCfg);
  assert.strictEqual(captured.watchSession.shopCfg, shopCfg);
  assert.strictEqual(session.page.name, 'mock-target-page', '会话出参形状不变（page=target）');
  assert.strictEqual(session.controller.name, 'mock-controller', '控制器与出参形状不变');
  assert.strictEqual(session.browser.closed, false);
  assert.ok(session.cookieSession, 'cookieSession/context 透出语义不变');
});

test('A1b defaultChengfangOpener：调用方未传 audit 时兼容（audit=undefined 原样传下去，不抛错）', async (t) => {
  const captured = {};
  stubChengfangReader(t, captured);
  const session = await defaultChengfangOpener({ loginCfg: { c: 1 }, shopCfg: { id: 'shop-002' } });
  assert.strictEqual(captured.openShop.audit, undefined, '未传即 undefined：openChengfangShop 内部 fail-safe 为无操作');
  assert.strictEqual(captured.watchSession.audit, undefined);
  assert.ok(session.controller, '兼容路径正常返回会话');
});

// ── A2. ChengfangRunner._openSession 把 this.audit 传给 pageOpener ──────────────

test('A2 runner._openSession 注入 this.audit：批次/演练开会话同链；不完整会话仍 fail-closed', async () => {
  const events = [];
  const audit = (e) => events.push(e);
  const runner = new ChengfangRunner({ coordinator: {}, config: { monitor: {} }, now: () => Date.now(), audit });
  const loginCfg = { c: 1 };
  const shopCfg = { id: 'shop-003' };

  const seen = [];
  const opener = async (p) => { seen.push(p); return { page: {}, controller: {}, browser: { close: async () => {} } }; };
  const session = await runner._openSession(opener, shopCfg, loginCfg);
  assert.ok(session, '完整会话正常返回');
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].audit, audit, 'runner 必须把自身 audit 交给 pageOpener（生产即 → openChengfangShop）');
  assert.strictEqual(seen[0].shopCfg, shopCfg);
  assert.strictEqual(seen[0].loginCfg, loginCfg);

  // 旧版 pageOpener（只解构 loginCfg/shopCfg）兼容：多余 audit 键不影响
  const legacySeen = [];
  const legacyOpener = async ({ loginCfg: l, shopCfg: s }) => { legacySeen.push({ l, s }); return { page: {}, controller: {} }; };
  const s2 = await runner._openSession(legacyOpener, shopCfg, loginCfg);
  assert.ok(s2);
  assert.strictEqual(legacySeen[0].l, loginCfg);

  // 会话不完整仍拒绝（语义不变）
  await assert.rejects(
    () => runner._openSession(async () => ({ page: null }), shopCfg, loginCfg),
    /会话不完整/,
    '不传 audit 不得改变 fail-closed 校验',
  );
});

test('A2b runDryCycle 经 _openSession 收到 this.audit（演练入口同链，注入 mock opener）', async () => {
  const events = [];
  const runner = new ChengfangRunner({
    coordinator: {},
    config: { monitor: {}, execution: {}, rules: [], schedule: {} },
    now: () => Date.now(),
    audit: (e) => events.push(e),
  });
  let openerAudit = null;
  const opener = async (p) => {
    openerAudit = p.audit;
    // 让 executor 快速失败：controller 无 verifyIdentity → 抛错走 dry_failed 收尾（零真实点击）
    return { page: {}, controller: {}, browser: { close: async () => {} } };
  };
  const res = await runner.runDryCycle({ shopCfg: { id: 'shop-004' }, pageOpener: opener, loginCfg: {} });
  assert.strictEqual(openerAudit, runner.audit, '演练开会话必须带 runner.audit');
  assert.strictEqual(res.outcome, 'dry_failed', '不完整 mock 会话的失败收尾语义不变');
  assert.ok(events.some((e) => e.kind === 'chengfang-dry' && e.outcome === 'dry_failed'), '失败收尾事件仍经 this.audit 落审计');
});

// ── A3. Monitor 只读状态开会话把 _audit 传给 opener，事件落既有审计文件/事件流 ──

test('A3 monitor._readChengfangAdState 给 opener 传 audit；经该回调的事件落 audit.jsonl 与 processEvents（含 unknownDiag）', async (t) => {
  const cookieDir = makeTempDir('pg-chain-cookies-');
  const dataDir = makeTempDir('pg-chain-data-');
  t.after(() => {
    for (const d of [cookieDir, dataDir]) fs.rmSync(d, { recursive: true, force: true });
  });
  writeTempCookie(cookieDir, '测试店铺一');
  const cfgResult = makeCfgResult({ cookieDir, monitor: { mockDataSource: true } });
  const monitor = new Monitor(cfgResult, null, { dataDir, nowFn: () => Date.now() });
  const shopCfg = cfgResult.config.shops[0];

  let captured = null;
  monitor._chengfangOpener = async (p) => {
    captured = p;
    throw new Error('mock: 只测开会话传参，零真实页面');
  };

  await monitor._readChengfangAdState(shopCfg);
  assert.ok(captured, 'opener 必须被调用');
  assert.strictEqual(captured.shopCfg, shopCfg, '只读状态开会话的既有传参不变');
  assert.strictEqual(captured.loginCfg, cfgResult.config.login);
  assert.strictEqual(typeof captured.audit, 'function', '只读状态开会话必须收到 audit（此前未传 → 打开/浮窗/检查点事件不落主审计）');

  // 端到端：注入事件经该回调进既有审计双出口
  captured.audit({
    kind: 'chengfang-overlay', shopId: shopCfg.id, action: 'probe', result: 'blocked',
    reason: 'unknown-overlay:1',
    unknownDiag: [{ tag: 'div', cls: 'zz-unknown-panel', role: 'dialog' }],
  });
  const lines = fs.readFileSync(monitor.auditFile, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const hit = lines.find((l) => l.kind === 'chengfang-overlay' && l.reason === 'unknown-overlay:1');
  assert.ok(hit, '事件必须落 monitor 既有审计文件');
  assert.deepStrictEqual(hit.unknownDiag, [{ tag: 'div', cls: 'zz-unknown-panel', role: 'dialog' }]);
  assert.ok(monitor.processEvents.some((e) => e.kind === 'chengfang-overlay' && e.reason === 'unknown-overlay:1'),
    '事件流（_audit 双出口）同源可见');
});

// ── B1. 探针 unknown-overlay 有界结构摘要 ───────────────────────────────────────

function addUnknownDialog(dom, cls, role) {
  const el = new FakeNode('div', { class: cls, role: role || 'dialog' }, SECRET_BODY + ACCOUNT_ID_TEXT);
  dom.root.appendChild(el);
  return el;
}

test('B1 探针：unknown-overlay 阻断时输出有界 unknownDiag（仅 tag/cls/role；类名 60 截断、上限 5；无正文/账户ID），门禁与零点击不变', () => {
  const { handleChengfangOverlayInPage } = cfMod;
  const dom = makeDom();
  const longCls = 'zz-unknown-panel-' + 'x'.repeat(100);
  const dlg = addUnknownDialog(dom, longCls);

  const r = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom.document, url: QC_URL });
  assert.strictEqual(r.state, 'blocked', 'unknown 候选仍必须阻断（不放宽门禁）');
  assert.ok(r.blockers.includes('unknown-overlay:1'), '既有阻断摘要不变');
  assert.ok(Array.isArray(r.unknownDiag) && r.unknownDiag.length === 1, '必须有界结构摘要');
  const d0 = r.unknownDiag[0];
  assert.deepStrictEqual(Object.keys(d0).sort(), ['cls', 'role', 'tag'], '摘要字段仅限 tag/cls/role');
  assert.strictEqual(d0.tag, 'div');
  assert.strictEqual(d0.role, 'dialog');
  assert.strictEqual(d0.cls.length, 60, '类名严格截断 60');
  const dump = JSON.stringify(r.unknownDiag);
  assert.ok(!dump.includes(SECRET_BODY) && !dump.includes(ACCOUNT_ID_TEXT), '摘要绝不含正文/账户ID');
  assert.strictEqual(dlg.clicked, 0, '零点击语义不变');

  // 数量上限：7 个未知候选 → 计数 7，摘要只带前 5
  const dom2 = makeDom();
  for (let i = 0; i < 7; i++) addUnknownDialog(dom2, `p-${i}`);
  const r2 = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom2.document, url: QC_URL });
  assert.ok(r2.blockers.includes('unknown-overlay:7'), 'unknown 计数逐一如实');
  assert.strictEqual(r2.unknownDiag.length, 5, '摘要条数有界 ≤5');

  // 无 unknown 候选时不新增字段（不改变既有结果形状）
  const dom3 = makeDom();
  const r3 = runInPage(handleChengfangOverlayInPage, { click: false }, { document: dom3.document, url: QC_URL });
  assert.strictEqual(r3.state, 'none');
  assert.strictEqual(r3.unknownDiag, undefined);
});

// ── B2. dismissKnownChengfangOverlays 阻断审计携带 unknownDiag ──────────────────

test('B2 dismiss 阻断路径：既有 chengfang-overlay 审计事件带 unknownDiag；返回语义/零点击/门禁不变', async () => {
  const dom = makeDom();
  const dlg = addUnknownDialog(dom, 'zz-unknown-panel');
  const page = makePage(dom);
  const events = [];
  const { dismissKnownChengfangOverlays } = cfMod;

  const r = await dismissKnownChengfangOverlays({
    page, audit: (e) => events.push(e), shopId: 'shop-b2', maxRounds: 1,
  });
  assert.strictEqual(r.dismissed, false);
  assert.strictEqual(r.state, 'blocked', '阻断语义不变');
  assert.ok(String(r.reason).includes('unknown-overlay:1'));
  assert.deepStrictEqual(r.unknownDiag, [{ tag: 'div', cls: 'zz-unknown-panel', role: 'dialog' }]);
  assert.strictEqual(dlg.clicked, 0);

  const blocked = events.find((e) => e.kind === 'chengfang-overlay' && e.action === 'probe' && e.result === 'blocked');
  assert.ok(blocked, '既有 blocked 审计事件仍发出');
  assert.deepStrictEqual(blocked.unknownDiag, [{ tag: 'div', cls: 'zz-unknown-panel', role: 'dialog' }], '审计带结构摘要');
  const dump = JSON.stringify(events);
  assert.ok(!dump.includes(SECRET_BODY) && !dump.includes(ACCOUNT_ID_TEXT), '审计事件绝不含正文/账户ID');

  // 未传 audit 兼容：无回调不抛错
  const r2 = await dismissKnownChengfangOverlays({ page: makePage(makeDom()), shopId: 'x', maxRounds: 1 });
  assert.ok(r2 && typeof r2.state === 'string');
});

test('B2b 无 unknown 候选的正常阻断（no-control）不带 unknownDiag 字段（结果形状不变）', async () => {
  const dom = makeDom();
  const wrap = new FakeNode('div', { class: 'tools-vmok-plugin-modal__wrap' });
  dom.root.appendChild(wrap); // 已知 modal 容器，无唯一关闭控件 → no-control
  const events = [];
  const r = await cfMod.dismissKnownChengfangOverlays({
    page: makePage(dom), audit: (e) => events.push(e), shopId: 'shop-b2b', maxRounds: 1,
  });
  assert.strictEqual(r.state, 'no-control', '既有 no-control 阻断分类不变');
  assert.strictEqual(r.unknownDiag, undefined);
  const probeEvt = events.find((e) => e.result === 'blocked');
  assert.ok(probeEvt && probeEvt.unknownDiag === undefined, '无候选时审计不新增空字段');
});
