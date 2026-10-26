'use strict';

/**
 * POPUP-CLOSE-20261025：费用读取链路的已知介绍浮窗收口（隔离回归测试）。
 *
 * 全部为 Node 纯 mock DOM/VM + mock page/browser：
 *  - 不启动真实 Playwright / 浏览器 / CDP / 网络；
 *  - 不读写 Cookie 文件、不接触生产目录、不访问任何真实页面；
 *  - 页面内函数（handleChengfangOverlayInPage、费用就绪探针等）用 node:vm 在 mock
 *    document/location 上执行**真实源码**（fn.toString()，非重写副本）；
 *  - 通过 createQianchuanCostReader 的 openSession 注入口接线真实读函数，证明费用
 *    入口（readCostSummary → waitForQianchuanConsumeReady → 截图）真实集成了既有
 *    chengfang-reader 白名单关闭器（运行时 lazy require，无顶层循环依赖）。
 *
 * 覆盖：新版 root overall-release-modal-v2-wrap、唯一 close-button + iconpark 图标、
 * 关联空 mask、有帮助/没帮助链接与两个业务 CTA（绝不点）、无窗零点击零固定等待、
 * 迟到浮窗、延迟 X（有界重读）、点击后未消失如实记录。读数口径（周期/金额）沿用
 * 既有验证，不修改、不放松。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const {
  createQianchuanCostReader,
  waitForQianchuanConsumeReady,
} = require('../src/adapters/qianchuan-reader');
const {
  handleChengfangOverlayInPage,
  dismissKnownChengfangOverlays,
} = require('../src/adapters/chengfang-reader');
const { shanghaiDate } = require('../src/lib/time');

// 合成账号 ID（非生产账号）；页面只用于 URL/path 信任判断。
const QC_HOME_URL = 'https://qianchuan.jinritemai.com/home?aavid=1000000000000001';
const TODAY = shanghaiDate(Date.now());

// ── 极简 mock DOM（只支持本测试用到的选择器形态）─────────────────────────

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

  get innerText() { return this.textContent; }
  get childNodes() { return this.children; }
  get parentNode() { return this.parentElement; }
  get nextElementSibling() {
    const s = this.parentElement ? this.parentElement.children : [];
    const i = s.indexOf(this);
    return i >= 0 ? (s[i + 1] || null) : null;
  }
  get value() { return this.attrs.value != null ? String(this.attrs.value) : ''; }

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

function removeNode(node) {
  node.removed = true;
  if (node.parentElement) node.parentElement.removeChild(node);
}

// ── 千川首页费用卡 + 新版介绍浮窗 fixture ───────────────────────────────

/**
 * 新版介绍浮窗（overall-release-modal-v2-wrap）：
 *  - 唯一关闭控件 button.close-button[aria-label="关闭"][type="button"]，
 *    内含 iconpark-icon[name="oc-icon-close"]；
 *  - 紧邻空 mask tools-vmok-plugin-popup__mask（同一 body 下的兄弟节点）；
 *  - 浮窗内另有「有帮助」「没帮助」链接与「投放乘方」「开启货款直投」两个业务 CTA
 *    （业务 CTA 绝不能被点击）。
 * noControl=true 时先不渲染关闭控件，用于验证控件晚到的有界重读。
 */
function addIntroPopup(root, opts = {}) {
  const works = opts.works !== false;
  const mask = new FakeNode('div', { class: 'tools-vmok-plugin-popup__mask' });
  const wrap = new FakeNode('div', { class: 'tools-vmok-plugin-modal__wrap overall-release-modal-v2-wrap' });
  const content = new FakeNode('div', { class: 'content' });
  wrap.appendChild(content);
  content.appendChild(new FakeNode('div', {}, '千川乘方·智能营销引擎 找到生意增长更优解'));
  const cta1 = new FakeNode('button', {}, '投放乘方');
  const cta2 = new FakeNode('button', {}, '开启货款直投');
  content.appendChild(cta1);
  content.appendChild(cta2);
  content.appendChild(new FakeNode('a', { href: '#helpful' }, '有帮助'));
  content.appendChild(new FakeNode('a', { href: '#unhelpful' }, '没帮助'));
  let closeBtn = null;
  if (opts.noControl !== true) closeBtn = addClose();
  function addClose() {
    const b = new FakeNode('button', { class: 'close-button', 'aria-label': '关闭', type: 'button' });
    b.appendChild(new FakeNode('iconpark-icon', { name: 'oc-icon-close' }));
    if (works) b.onClick = () => { removeNode(wrap); removeNode(mask); };
    content.appendChild(b);
    closeBtn = b;
    return b;
  }
  root.appendChild(mask);
  root.appendChild(wrap);
  return {
    mask, wrap, content, ctas: [cta1, cta2],
    get closeBtn() { return closeBtn; },
    addClose,
  };
}

function addCostCard(root, { centsText = '14.98', periodValue = TODAY } = {}) {
  const picker = new FakeNode('div', { class: 'report-shortcuts-datepicker' });
  picker.appendChild(new FakeNode('input', { value: periodValue }));
  picker.appendChild(new FakeNode('input', { value: periodValue }));
  root.appendChild(picker);
  const card = new FakeNode('div', { class: 'summaryCard' },
    `账户整体消耗(元)${centsText}相比上周期+70.03%`);
  root.appendChild(card);
  root.appendChild(new FakeNode('div', { class: 'refreshTime' }, '更新于：10-25 12:00'));
  return { picker, card };
}

function makeEnv({ url = QC_HOME_URL } = {}) {
  const root = new FakeNode('body');
  return {
    url, root,
    document: {
      body: root,
      documentElement: null,
      querySelectorAll(sel) { return queryAll(root, sel); },
      querySelector(sel) { return queryAll(root, sel)[0] || null; },
    },
    probeCount: 0,
    beforeProbe: null,
    onEvaluate: null,
    shots: 0,
    shotOverlayPresent: null,
    timeouts: 0,
  };
}

/** 在 mock 页面环境里执行模块内真实函数源码。 */
function runInPage(fn, arg, env) {
  const ctx = vm.createContext({
    document: env.document,
    location: { href: env.url },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    URL,
    Node: { TEXT_NODE: 3 },
    console,
    setTimeout,
  });
  const call = arg === undefined ? 'undefined' : JSON.stringify(arg);
  return vm.runInContext(`(${fn.toString()})(${call})`, ctx);
}

function introPopupPresent(env) {
  return queryAll(env.root, '.overall-release-modal-v2-wrap').some((el) => !el.removed && el.visible);
}

/** mock page：evaluate 执行真实函数源码；探针前可按需注入状态。 */
function makePage(env) {
  return {
    url: () => env.url,
    async evaluate(fn, arg) {
      if (typeof fn !== 'function') throw new Error('mock evaluate 只支持函数');
      const src = fn.toString();
      if (typeof env.onEvaluate === 'function') env.onEvaluate(src, arg);
      if (src.includes('summaryCard')) {
        env.probeCount += 1;
        if (typeof env.beforeProbe === 'function') env.beforeProbe(env.probeCount);
      }
      return runInPage(fn, arg, env);
    },
    async waitForTimeout() { env.timeouts += 1; },
    async screenshot() {
      env.shots += 1;
      env.shotOverlayPresent = introPopupPresent(env);
    },
  };
}

function makeCostReader(env) {
  const target = makePage(env);
  const browser = { closed: 0, async close() { this.closed += 1; } };
  const reader = createQianchuanCostReader({
    loginCfg: {},
    openSession: async () => ({ browser, target }),
    // 已存在目录：避免测试在系统临时目录创建文件；mock screenshot 不落盘。
    evidenceDir: __dirname,
  });
  return { reader, target, browser, env };
}

function totalClicks(nodes) {
  return nodes.reduce((sum, n) => sum + n.clicked, 0);
}

// ── 直接探针：新版 root / 唯一 X / 关联空 mask / 业务 CTA ─────────────────

test('新版介绍浮窗：关联空mask归属、唯一close-button候选、业务CTA与链接零点击', () => {
  const env = makeEnv();
  const popup = addIntroPopup(env.root);

  const probe = runInPage(handleChengfangOverlayInPage, { click: false }, {
    document: env.document, url: env.url,
  });
  assert.equal(probe.trusted, true);
  assert.equal(probe.state, 'dismissable');
  assert.equal(probe.kind, 'intro');
  assert.equal(probe.closeCandidates, 1, '唯一 close-button 才算候选');
  assert.ok(probe.affiliatedMask, '关联空 mask 必须被归属而非当作未知浮层');
  assert.equal(probe.affiliatedMask.cls, 'tools-vmok-plugin-popup__mask');
  assert.equal(probe.blockers.length, 0);
  assert.equal(probe.clicked, false);
  assert.equal(popup.closeBtn.clicked, 0);

  const clicked = runInPage(handleChengfangOverlayInPage, { click: true }, {
    document: env.document, url: env.url,
  });
  assert.equal(clicked.clicked, true);
  assert.equal(clicked.action, 'dismiss-intro');
  assert.equal(popup.closeBtn.clicked, 1);
  assert.equal(popup.wrap.removed, true);
  assert.equal(popup.mask.removed, true);
  assert.equal(totalClicks(popup.ctas), 0, '投放乘方/开启货款直投绝不能被点');
  assert.equal(queryAll(env.root, 'a').reduce((s, a) => s + a.clicked, 0), 0, '有帮助/没帮助链接零点击');
});

test('延迟X：控件晚到时在预算内重读，仅点唯一X并确认消失', async () => {
  const env = makeEnv();
  const popup = addIntroPopup(env.root, { noControl: true });
  const page = makePage(env);
  let overlayProbes = 0;
  env.onEvaluate = (src) => {
    if (!src.includes('introRoots')) return;
    overlayProbes += 1;
    if (overlayProbes === 2) popup.addClose();
  };

  const r = await dismissKnownChengfangOverlays({ page });
  assert.equal(r.dismissed, true);
  assert.equal(r.state, 'none');
  assert.equal(r.action, 'dismiss-intro');
  assert.equal(popup.closeBtn.clicked, 1);
  assert.equal(totalClicks(popup.ctas), 0);
  assert.equal(popup.wrap.removed, true);
  assert.ok(env.timeouts >= 1, '控件晚到应发生有界重读等待');
});

test('点击后未消失：如实失败，不伪造关闭，业务CTA零点击', async () => {
  const env = makeEnv();
  const popup = addIntroPopup(env.root, { works: false });
  const page = makePage(env);

  const r = await dismissKnownChengfangOverlays({ page });
  assert.equal(r.dismissed, false);
  assert.equal(r.state, 'not-disappeared');
  assert.ok(popup.closeBtn.clicked >= 1);
  assert.equal(totalClicks(popup.ctas), 0);
  assert.equal(introPopupPresent(env), true, '未消失必须如实保留现场');
});

// ── 费用读取集成 ────────────────────────────────────────────────────────

test('费用读取开始即有介绍浮窗：关闭唯一X并确认消失，绝不点业务按钮', async () => {
  const env = makeEnv();
  const popup = addIntroPopup(env.root);
  addCostCard(env.root);
  const { reader } = makeCostReader(env);

  const r = await reader.readCostSummary({ shopCfg: { id: 'shop-1' } });

  // 读数沿原有口径：不拿旧数据、不伪造值。
  assert.equal(r.ok !== false, true);
  assert.equal(r.valueCents, 1498);
  assert.equal(r.rawText, '14.98');
  assert.equal(r.businessDate, TODAY);
  assert.ok(r.dateScopeEvidence.includes('当天单日'));
  // 唯一 X 被点击一次并确认消失（关闭器自带二次观察）。
  assert.equal(popup.closeBtn.clicked, 1);
  assert.equal(popup.wrap.removed, true);
  assert.equal(popup.mask.removed, true);
  // 绝不点业务 CTA 与有帮助/没帮助链接。
  assert.equal(totalClicks(popup.ctas), 0);
  assert.equal(queryAll(env.root, 'a').reduce((s, a) => s + a.clicked, 0), 0);
  // 截图前浮窗已消失，结果如实记录关闭证据。
  assert.equal(env.shotOverlayPresent, false);
  assert.ok(r.introOverlay.duringWait.some((o) => o.dismissed === true));
  // 最后一道闸运行时浮窗已消失：state=none、dismissed=false（如实记录）。
  assert.deepEqual(r.introOverlay.final, { dismissed: false, state: 'none' });
  // 就绪探针一次即成功：仅关闭器的两次消失观察等待，无额外轮询等待。
  assert.equal(env.timeouts, 2);
});

test('无浮窗：零点击、零无条件固定等待，费用照常读取', async () => {
  const env = makeEnv();
  addCostCard(env.root);
  const { reader } = makeCostReader(env);

  const r = await reader.readCostSummary({ shopCfg: { id: 'shop-1' } });

  assert.equal(r.valueCents, 1498);
  assert.equal(queryAll(env.root, 'button').reduce((s, b) => s + b.clicked, 0), 0);
  assert.equal(env.timeouts, 0, '无浮窗不得产生固定等待');
  assert.deepEqual(r.introOverlay.duringWait, [{ dismissed: false, state: 'none' }]);
  assert.deepEqual(r.introOverlay.final, { dismissed: false, state: 'none' });
});

test('等待期间晚到的浮窗：就绪等待每轮收口 + 截图前最后一道闸', async () => {
  const env = makeEnv();
  const cost = addCostCard(env.root, { periodValue: '2026-10-24' });
  let popup = null;
  env.beforeProbe = (n) => {
    if (n === 2) popup = addIntroPopup(env.root);
    if (n === 3) {
      cost.picker.children[0].setAttribute('value', TODAY);
      cost.picker.children[1].setAttribute('value', TODAY);
    }
  };
  const { reader } = makeCostReader(env);

  const r = await reader.readCostSummary({ shopCfg: { id: 'shop-1' } });

  assert.equal(r.valueCents, 1498);
  assert.equal(r.businessDate, TODAY);
  assert.ok(popup);
  assert.equal(popup.closeBtn.clicked, 1);
  assert.equal(totalClicks(popup.ctas), 0);
  assert.equal(popup.wrap.removed, true);
  assert.equal(env.shotOverlayPresent, false);
  assert.ok(r.introOverlay.duringWait.some((o) => o.dismissed === true));
});

test('费用读取中点击后不消失：不声称关闭成功，如实记录且费用照常返回', async () => {
  const env = makeEnv();
  const popup = addIntroPopup(env.root, { works: false });
  addCostCard(env.root);
  const { reader } = makeCostReader(env);

  const r = await reader.readCostSummary({ shopCfg: { id: 'shop-1' } });

  assert.equal(r.valueCents, 1498);
  assert.equal(r.introOverlay.final.dismissed, false);
  assert.equal(r.introOverlay.final.state, 'not-disappeared');
  assert.equal(r.introOverlay.duringWait.every((o) => o.dismissed === false), true);
  assert.ok(popup.closeBtn.clicked >= 1);
  assert.equal(totalClicks(popup.ctas), 0);
  assert.equal(env.shotOverlayPresent, true);
});

test('waitForQianchuanConsumeReady：默认（无 hook）行为不变；有 hook 时每轮先收口并如实记录', async () => {
  // 无 hook：结果不携带 overlayOutcomes（既有调用/测试零影响）。
  const envNoCard = makeEnv();
  const pageNoCard = makePage(envNoCard);
  const withoutHook = await waitForQianchuanConsumeReady(pageNoCard, {
    timeoutMs: 60, intervalMs: 30, sleep: async () => {},
  });
  assert.equal(withoutHook.ok, false);
  assert.equal('overlayOutcomes' in withoutHook, false);

  // 有 hook：每轮探测前都先调用一次关闭器；失败只记录、不影响就绪失败口径。
  const calls = [];
  const withHook = await waitForQianchuanConsumeReady(pageNoCard, {
    timeoutMs: 60, intervalMs: 30, sleep: async () => {},
    overlayCloser: async () => { calls.push(1); return { dismissed: false, state: 'blocked' }; },
  });
  assert.equal(withHook.ok, false);
  assert.equal(calls.length >= 1, true);
  assert.equal(withHook.overlayOutcomes.length, calls.length);
  assert.deepEqual(withHook.overlayOutcomes[0], { dismissed: false, state: 'blocked' });

  // 有 hook 且立即就绪：也先跑一次关闭器（覆盖"读取开始前已有浮窗"路径）。
  addCostCard(envNoCard.root);
  const readyNow = await waitForQianchuanConsumeReady(pageNoCard, {
    timeoutMs: 60, intervalMs: 30, sleep: async () => {},
    overlayCloser: async () => ({ dismissed: true, state: 'none' }),
  });
  assert.equal(readyNow.ok, true);
  assert.equal(readyNow.cents, 1498);
  assert.deepEqual(readyNow.overlayOutcomes, [{ dismissed: true, state: 'none' }]);
});
