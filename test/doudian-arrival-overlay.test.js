'use strict';

/**
 * 抖店首页营销浮窗有限处理 回归测试（AD-DOUDIAN-ARRIVAL-OVERLAY-20261019-F1）。
 *
 * 全程离线：本地 Edge + setContent 合成 fixture（about:blank，零网络）；
 * 使用真实 URL 的用例经 page.route 全量通配拦截（双星号 glob 模式）后直接
 * fulfill 本地 HTML，Playwright 路由在发网络前返回，绝不触达生产路径。
 *
 * fixture 依据只读脱敏现场事实 home-modal.json：
 *   唯一可见根 class 含 ws-arrival-modal-wrap；文案豆包混资活动；
 *   控件：BUTTON「立即报名」（primary）/ BUTTON「我知道了」（default）/
 *   style_closeBtn 关闭 div（内含 svg）。
 *
 * 覆盖：真实已知浮窗、业务危险内容、隐藏根/隐藏控件/多控件、多根、无浮窗、
 * 关闭不消失（有界收敛）、可信域门（Node + 页内）、实际入口顺序（千川前置处置、
 * 真实指针拦截下先 dismiss 后点击成交订单数）、对既有桩的零扰动短路。
 * AD-ARRIVAL-RENDER-WAIT-20261019-F1 追加：唯一可信根先出现、dismiss 控件晚渲染的
 * 有限重读（就绪后单次正确点击、永远无控件预算内 fail-closed、等待中出现危险/多根/
 * 多控件即停零点击、等待重读期间导航变更实时复核不复用旧 urlHint、非唯一根不重读、
 * 等待预算/间隔归一化与硬上限、真实 fixture 延迟渲染端到端、无浮窗零睡眠不回归）。
 * 运行：node --test test/doudian-arrival-overlay.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { chromium } = require('playwright');

const {
  dismissDoudianArrivalOverlay,
  probeDoudianArrivalOverlay,
  handleArrivalOverlayInPage,
  isTrustedDoudianHomepageUrl,
  OVERLAY_ROOT_CLASS,
  DISMISS_TEXT,
  CLOSE_BTN_TOKEN,
  DANGER_WORDS,
  HOME_HOST,
  HOME_PATH_PREFIX,
  MAX_ROUNDS_HARD_LIMIT,
  DEFAULT_WAIT_BUDGET_MS,
  MAX_WAIT_BUDGET_MS,
  DEFAULT_WAIT_INTERVAL_MS,
  MIN_WAIT_INTERVAL_MS,
} = require('../src/adapters/doudian-arrival-overlay');
const { reachQianchuanHome } = require('../src/adapters/qianchuan-reader');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const FXG_HOME = `https://${HOME_HOST}${HOME_PATH_PREFIX}/index`;
const QC_HOME_URL = 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424';

let browser;
let page;

before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1200,800'] });
  page = await browser.newPage();
});

after(async () => {
  await browser.close().catch(() => {});
});

// ── fixture 构造（按 home-modal.json 实测结构）──────────────────────

const ACTIVITY_TEXT = '豆包混资10月9日起开始发券，承诺平台出资>=商家出资！商家出1%-5%，平台补1%-10%！快来开拓豆包电商新蓝海！';
const WRAP_CLS = 'index-module_wrap__VTvWq ws-arrival-modal-wrap style_wrapper__dM8rn index-module_centered__R684Z';
// 属性值内嵌 JS 用 &quot; 实体，避免双引号截断 onclick 属性
const REMOVE_ROOT_JS = "var r=this.closest('[class*=&quot;ws-arrival-modal-wrap&quot;]'); if (r) r.remove();";

function knowBtn({ hidden = false, removes = true } = {}) {
  return `<button class="style_btn__AyLWE style_btnDefault__BPgp4"${hidden ? ' style="display:none"' : ''}`
    + ` onclick="window.__log.push('know');${removes ? REMOVE_ROOT_JS : ''}">${DISMISS_TEXT}</button>`;
}
function enrollBtn() {
  return '<button class="style_btn__AyLWE style_btnPrimary__Zyzz0" onclick="window.__log.push(\'enroll\')">立即报名</button>';
}
function closeDiv({ removes = true } = {}) {
  return `<div class="${CLOSE_BTN_TOKEN}__vmXYD" onclick="window.__log.push('close');${removes ? REMOVE_ROOT_JS : ''}">`
    + '<svg viewBox="0 0 10 10"></svg></div>';
}
function modalRoot(inner, { style = '', cls = WRAP_CLS } = {}) {
  return `<div class="${cls}"${style ? ` style="${style}"` : ''}>${inner}</div>`;
}
const REAL_MODAL_INNER = `<div class="style_title__x">豆包混资活动</div><div class="style_desc__x">${ACTIVITY_TEXT}</div>`
  + enrollBtn() + knowBtn() + closeDiv();

async function setBody(inner) {
  await page.setContent(
    `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><script>window.__log=[];</script>${inner}</body></html>`,
    { waitUntil: 'load' },
  );
}
const readLog = () => page.evaluate(() => window.__log.slice());

const INPAGE_BASE = {
  rootClass: OVERLAY_ROOT_CLASS,
  dismissText: DISMISS_TEXT,
  closeToken: CLOSE_BTN_TOKEN,
  dangerWords: DANGER_WORDS,
  expectHost: HOME_HOST,
  expectPathPrefix: HOME_PATH_PREFIX,
};
// fixture 页 location 为 about:blank：页内地址复核在直调用例中显式关闭（生产默认强制，
// Node 端可信门另有专项用例，不受影响）。
const inPage = (mode, extra = {}) =>
  page.evaluate(handleArrivalOverlayInPage, { ...INPAGE_BASE, mode, checkUrl: false, ...extra });

/**
 * 独立 VM 上下文地址注入：真实 Edge 拒绝 history.pushState 写入 userinfo 凭据
 * （SecurityError），且不得为此更改浏览器安全设置。这里把 location.href 精确设为
 * 目标字符串，在独立 VM 上下文编译并执行**真实** handleArrivalOverlayInPage 的
 * 序列化源码（源码在 VM realm 内解析 location/document），配合合成 DOM 验证
 * 页内地址门的真实行为。纯本地、零网络、零认证。
 */
function runInPageWithHref(href, dom) {
  const sandbox = {
    location: { href },
    document: dom.document,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    URL,
  };
  vm.createContext(sandbox);
  const args = { ...INPAGE_BASE, mode: 'dismiss', checkUrl: true };
  const src = `(${handleArrivalOverlayInPage.toString()})(${JSON.stringify(args)})`;
  return vm.runInContext(src, sandbox, { timeout: 2000 });
}

/** 合成浮窗 DOM：唯一可见根 + 「立即报名」/「我知道了」两个按钮，记录点击与根查询次数。 */
function syntheticOverlayDom() {
  const clicks = [];
  const btn = (text, tag) => ({
    tagName: 'BUTTON',
    textContent: text,
    getBoundingClientRect: () => ({ width: 96, height: 32 }),
    click: () => { clicks.push(tag); },
  });
  const enroll = btn('立即报名', 'enroll');
  const know = btn(DISMISS_TEXT, 'know');
  const root = {
    textContent: `豆包混资活动${DISMISS_TEXT}立即报名`,
    getBoundingClientRect: () => ({ width: 640, height: 480 }),
    querySelectorAll: (sel) => (sel === 'button, [role="button"]' ? [enroll, know] : []),
  };
  let rootQueries = 0;
  const document = {
    querySelectorAll: (sel) => {
      if (String(sel).includes(OVERLAY_ROOT_CLASS)) { rootQueries += 1; return [root]; }
      return [];
    },
  };
  return { document, clicks, get rootQueries() { return rootQueries; } };
}

// ── 纯函数：严格可信地址门 ─────────────────────────────────────────

test('isTrustedDoudianHomepageUrl：精确 origin+path 通过；lookalike/http/非默认端口/credentials/错路径或裸前缀相似路径/about:blank 一律拒绝', () => {
  assert.strictEqual(isTrustedDoudianHomepageUrl(FXG_HOME), true);
  assert.strictEqual(isTrustedDoudianHomepageUrl('https://fxg.jinritemai.com/ffa/mshop/homepage'), true);
  assert.strictEqual(isTrustedDoudianHomepageUrl('https://fxg.jinritemai.com/ffa/mshop/homepage/'), true);
  assert.strictEqual(isTrustedDoudianHomepageUrl('https://fxg.jinritemai.com:443/ffa/mshop/homepage/index'), true, '显式默认端口 443 等同无端口');
  assert.strictEqual(isTrustedDoudianHomepageUrl('https://fxg.jinritemai.com.evil.test/ffa/mshop/homepage/index'), false);
  assert.strictEqual(isTrustedDoudianHomepageUrl('https://evil.test/ffa/mshop/homepage/index'), false);
  assert.strictEqual(isTrustedDoudianHomepageUrl('http://fxg.jinritemai.com/ffa/mshop/homepage/index'), false);
  assert.strictEqual(isTrustedDoudianHomepageUrl('https://fxg.jinritemai.com:444/ffa/mshop/homepage/index'), false);
  assert.strictEqual(isTrustedDoudianHomepageUrl('https://fxg.jinritemai.com:8443/ffa/mshop/homepage/index'), false);
  assert.strictEqual(isTrustedDoudianHomepageUrl('https://u@fxg.jinritemai.com/ffa/mshop/homepage/index'), false, 'credentials 必须保守拒绝');
  assert.strictEqual(isTrustedDoudianHomepageUrl('https://u:p@fxg.jinritemai.com/ffa/mshop/homepage/index'), false);
  assert.strictEqual(isTrustedDoudianHomepageUrl('https://fxg.jinritemai.com/other/path'), false);
  assert.strictEqual(isTrustedDoudianHomepageUrl('https://fxg.jinritemai.com/ffa/mshop/homepage-evil'), false, '裸前缀相似路径不得通过');
  assert.strictEqual(isTrustedDoudianHomepageUrl('https://fxg.jinritemai.com/ffa/mshop/homepagee/index'), false);
  assert.strictEqual(isTrustedDoudianHomepageUrl('about:blank'), false);
  assert.strictEqual(isTrustedDoudianHomepageUrl(''), false);
  assert.strictEqual(isTrustedDoudianHomepageUrl(null), false);
});

// ── 页内函数：真实已知浮窗与各阻断路径 ─────────────────────────────

test('真实已知浮窗：只读探测=dismissable/know_button，零点击、DOM 不变', async () => {
  await setBody(modalRoot(REAL_MODAL_INNER));
  const r = await inPage('probe');
  assert.strictEqual(r.status, 'dismissable');
  assert.strictEqual(r.controlKind, 'know_button');
  assert.strictEqual(r.visibleRoots, 1);
  assert.strictEqual(r.textControls, 1);
  assert.strictEqual(r.closeControls, 1);
  assert.ok(r.rootText.includes('豆包混资'));
  assert.deepStrictEqual(await readLog(), []);
});

test('真实已知浮窗：处置=仅点击「我知道了」，浮窗真实消失，绝不点「立即报名」', async () => {
  await setBody(modalRoot(REAL_MODAL_INNER));
  const r = await inPage('dismiss');
  assert.strictEqual(r.status, 'clicked');
  assert.strictEqual(r.clickedKind, 'know_button');
  assert.deepStrictEqual(await readLog(), ['know'], '只允许「我知道了」被点击一次');
  const left = await page.evaluate((cls) => document.querySelectorAll(`[class*="${cls}"]`).length, OVERLAY_ROOT_CLASS);
  assert.strictEqual(left, 0, '点击后浮窗根真实消失');
});

test('无浮窗页面：立即 none，零操作', async () => {
  await setBody('<div class="compassTitle-a1b2">成交订单数</div><div>正常首页内容</div>');
  const r = await inPage('dismiss');
  assert.strictEqual(r.status, 'none');
  assert.strictEqual(r.visibleRoots, 0);
  assert.deepStrictEqual(await readLog(), []);
});

test('仅隐藏浮窗根（display:none）：按 none 处理，绝不触碰隐藏节点', async () => {
  await setBody(modalRoot(REAL_MODAL_INNER, { style: 'display:none' }));
  const r = await inPage('dismiss');
  assert.strictEqual(r.status, 'none');
  assert.strictEqual(r.hiddenRoots, 1);
  assert.deepStrictEqual(await readLog(), []);
});

test('多个可见浮窗根：multi_visible_roots 阻断，零点击', async () => {
  await setBody(modalRoot(REAL_MODAL_INNER) + modalRoot(REAL_MODAL_INNER));
  const r = await inPage('dismiss');
  assert.strictEqual(r.status, 'multi_visible_roots');
  assert.strictEqual(r.visibleRoots, 2);
  assert.deepStrictEqual(await readLog(), []);
});

test('业务危险内容（支付/账单/删除/扫码登录字样）：danger_content 阻断，即使带「我知道了」也零点击', async () => {
  await setBody(modalRoot(`<div>检测到未支付账单，确认后将删除店铺装修记录，请扫码登录继续</div>${knowBtn()}`));
  const r = await inPage('dismiss');
  assert.strictEqual(r.status, 'danger_content');
  for (const w of ['支付', '账单', '删除', '扫码', '登录']) assert.ok(r.dangerWords.includes(w), `应命中危险词 ${w}`);
  assert.deepStrictEqual(await readLog(), []);
});

test('多个可见「我知道了」控件：multi_dismiss_controls 阻断，零点击', async () => {
  await setBody(modalRoot(`<div>${ACTIVITY_TEXT}</div>${knowBtn()}${knowBtn()}`));
  const r = await inPage('dismiss');
  assert.strictEqual(r.status, 'multi_dismiss_controls');
  assert.strictEqual(r.textControls, 2);
  assert.deepStrictEqual(await readLog(), []);
});

test('隐藏重复控件不计入：一个隐藏 + 一个可见「我知道了」→ 点击唯一可见者', async () => {
  await setBody(modalRoot(`<div>${ACTIVITY_TEXT}</div>${knowBtn({ hidden: true })}${knowBtn()}`));
  const r = await inPage('dismiss');
  assert.strictEqual(r.status, 'clicked');
  assert.strictEqual(r.clickedKind, 'know_button');
  assert.strictEqual(r.textControls, 1, '隐藏控件不得计入唯一性');
  assert.deepStrictEqual(await readLog(), ['know']);
});

test('无「我知道了」但本精确根内唯一可见关闭控件：允许点击 style_closeBtn', async () => {
  await setBody(modalRoot(`<div>${ACTIVITY_TEXT}</div>${enrollBtn()}${closeDiv()}`));
  const r = await inPage('dismiss');
  assert.strictEqual(r.status, 'clicked');
  assert.strictEqual(r.clickedKind, 'close_btn');
  assert.deepStrictEqual(await readLog(), ['close']);
});

test('未知内容（仅「立即报名」、无关闭控件）：no_dismiss_control 阻断，绝不代点报名', async () => {
  await setBody(modalRoot(`<div>${ACTIVITY_TEXT}</div>${enrollBtn()}`));
  const r = await inPage('dismiss');
  assert.strictEqual(r.status, 'no_dismiss_control');
  assert.deepStrictEqual(await readLog(), []);
});

test('页内地址复核：checkUrl 强制时对 about:blank → url_mismatch，零操作（防 evaluate 期间导航）', async () => {
  await setBody(modalRoot(REAL_MODAL_INNER));
  const r = await page.evaluate(handleArrivalOverlayInPage, { ...INPAGE_BASE, mode: 'dismiss', checkUrl: true });
  assert.strictEqual(r.status, 'url_mismatch');
  assert.deepStrictEqual(await readLog(), []);
});

// ── Node 胶水层：可信门、有界轮次、回读语义 ────────────────────────

const TRUSTED = FXG_HOME;

function makeOverlayStubPage({ script = [], count = 1, url = TRUSTED } = {}) {
  const calls = { evaluate: 0, sleeps: 0, locator: 0, lastArgs: null };
  let i = 0;
  const pageStub = {
    url: () => url,
    locator: (sel) => {
      calls.locator += 1;
      assert.ok(sel.includes(OVERLAY_ROOT_CLASS), '预检只允许定位浮窗根选择器');
      return { count: async () => count };
    },
    evaluate: async (fn, args) => {
      calls.evaluate += 1;
      calls.lastArgs = args;
      const r = script[Math.min(i, script.length - 1)];
      i += 1;
      if (r instanceof Error) throw r;
      return r;
    },
    waitForTimeout: async () => { calls.sleeps += 1; },
  };
  return { page: pageStub, calls };
}

test('Node 可信域门：lookalike/http/非默认端口/credentials/错路径/about:blank → untrusted_url 阻断，页面零调用', async () => {
  for (const bad of [
    'https://fxg.jinritemai.com.evil.test/ffa/mshop/homepage/index',
    'http://fxg.jinritemai.com/ffa/mshop/homepage/index',
    'https://fxg.jinritemai.com:444/ffa/mshop/homepage/index',
    'https://u@fxg.jinritemai.com/ffa/mshop/homepage/index',
    'https://fxg.jinritemai.com/ffa/mshop/homepage-evil',
    'https://fxg.jinritemai.com/ffa/mshop/order-list',
    'about:blank',
  ]) {
    const { page: s, calls } = makeOverlayStubPage({ url: bad, script: [{ status: 'clicked' }] });
    const r = await dismissDoudianArrivalOverlay(s, {});
    assert.strictEqual(r.status, 'untrusted_url', bad);
    assert.strictEqual(r.blocked, true, bad);
    assert.strictEqual(calls.locator, 0, `${bad}：非可信地址不得触碰页面`);
    assert.strictEqual(calls.evaluate, 0, `${bad}：非可信地址不得注入页面函数`);
  }
});

test('0 个浮窗根：locator 预检 count=0 → 立即 none，不注入页面函数（无操作零开销）', async () => {
  const { page: s, calls } = makeOverlayStubPage({ count: 0 });
  const r = await dismissDoudianArrivalOverlay(s, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'none');
  assert.strictEqual(r.clickedCount, 0);
  assert.strictEqual(calls.evaluate, 0);
  assert.strictEqual(calls.sleeps, 0, '无浮窗不得引入任何固定睡眠（等待重读仅限唯一可信根场景）');
});

test('既有桩兼容：页面不支持 locator/count → probe_unavailable 非阻断，且零 evaluate（不扰动按序消费的桩）', async () => {
  const noLocator = { url: () => TRUSTED, evaluate: async () => { noLocator.__ev = (noLocator.__ev || 0) + 1; return null; }, waitForTimeout: async () => {} };
  const r = await dismissDoudianArrivalOverlay(noLocator, {});
  assert.strictEqual(r.status, 'probe_unavailable');
  assert.strictEqual(r.blocked, false);
  assert.strictEqual(noLocator.__ev || 0, 0, '计数不可用时不得继续 evaluate');
});

test('处置回读闭环：clicked → 下轮 none → closed，恰好 1 次点击；生产默认强制页内地址复核', async () => {
  const { page: s, calls } = makeOverlayStubPage({ script: [{ status: 'clicked', clickedKind: 'know_button', controlKind: 'know_button' }, { status: 'none' }] });
  const r = await dismissDoudianArrivalOverlay(s, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'closed');
  assert.strictEqual(r.closed, true);
  assert.strictEqual(r.clickedCount, 1);
  assert.strictEqual(calls.evaluate, 2, '点击 + 消失回读');
  assert.strictEqual(calls.lastArgs.checkUrl, true, '生产路径必须强制页内 host/path 复核');
  assert.strictEqual(calls.lastArgs.mode, 'dismiss');
});

test('关闭不消失：始终 clicked → 有界 maxRounds 收敛为 still_present，不无限循环', async () => {
  const { page: s, calls } = makeOverlayStubPage({ script: [{ status: 'clicked', clickedKind: 'know_button' }] });
  const r = await dismissDoudianArrivalOverlay(s, { maxRounds: 3, intervalMs: 10 });
  assert.strictEqual(r.status, 'still_present');
  assert.strictEqual(r.blocked, false);
  assert.strictEqual(r.clickedCount, 3);
  assert.strictEqual(calls.evaluate, 3);
  assert.strictEqual(calls.sleeps, 3, '每轮间有界等待');
});

test('轮次硬上限：非法 maxRounds(999) 夹到硬限；0/负数/NaN 回落默认（不零等待不忙等）', async () => {
  const { page: s, calls } = makeOverlayStubPage({ script: [{ status: 'clicked' }] });
  const r = await dismissDoudianArrivalOverlay(s, { maxRounds: 999 });
  assert.strictEqual(r.clickedCount, MAX_ROUNDS_HARD_LIMIT);
  assert.strictEqual(calls.evaluate, MAX_ROUNDS_HARD_LIMIT);
  const r2 = await dismissDoudianArrivalOverlay(makeOverlayStubPage({ script: [{ status: 'clicked' }] }).page, { maxRounds: 0, intervalMs: -5 });
  assert.ok(r2.clickedCount >= 1 && r2.clickedCount <= MAX_ROUNDS_HARD_LIMIT);
});

test('transient 重现：clicked → clicked → none 有界收敛为 closed（2 次点击）', async () => {
  const { page: s } = makeOverlayStubPage({ script: [{ status: 'clicked' }, { status: 'clicked' }, { status: 'none' }] });
  const r = await dismissDoudianArrivalOverlay(s, { maxRounds: 4 });
  assert.strictEqual(r.status, 'closed');
  assert.strictEqual(r.clickedCount, 2);
});

test('危险/歧义事实：blocked 阻断（评估返回即停，不再轮询不重复点击）', async () => {
  for (const st of ['danger_content', 'multi_visible_roots', 'multi_dismiss_controls', 'no_dismiss_control']) {
    const { page: s, calls } = makeOverlayStubPage({ script: [{ status: st, reason: `${st} 测试原因` }] });
    const r = await dismissDoudianArrivalOverlay(s, {});
    assert.strictEqual(r.blocked, true, st);
    assert.strictEqual(r.status, st);
    assert.strictEqual(calls.evaluate, 1, `${st} 后不得继续轮询`);
  }
});

test('探测异常/结构不可确认：probe_error / probe_unavailable 均非阻断（保持原链路）', async () => {
  const { page: s1 } = makeOverlayStubPage({ script: [new Error('Target page closed')] });
  const r1 = await dismissDoudianArrivalOverlay(s1, {});
  assert.strictEqual(r1.status, 'probe_error');
  assert.strictEqual(r1.blocked, false);
  const { page: s2 } = makeOverlayStubPage({ script: [null] });
  const r2 = await dismissDoudianArrivalOverlay(s2, {});
  assert.strictEqual(r2.status, 'probe_unavailable');
  assert.strictEqual(r2.blocked, false);
});

// ── 异步渲染有限重读（AD-ARRIVAL-RENDER-WAIT-20261019-F1）─────────
// 根证 arrival-timeline.json：唯一可信根第 8s 出现即 no_dismiss_control（倒计时渲染），
// 第 11s 起才 dismissable/know_button。旧实现首判 no_dismiss_control 即永久阻断。

const NDC_ROOT1 = { status: 'no_dismiss_control', visibleRoots: 1, reason: '浮窗内无唯一明确 dismiss 控件（等待渲染）' };

/** 注入假时钟 + 记录睡眠：测试零真实等待，预算判定可复现。 */
function makeWaitHarness(overrides = {}) {
  const sleeps = [];
  let t = 0;
  const opts = {
    sleep: async (ms) => { sleeps.push(ms); t += ms; },
    now: () => t,
    ...overrides,
  };
  return { opts, sleeps };
}

test('有限重读：唯一可信根控件就绪后恰好一次正确点击 → closed；waits 与关闭尝试分开，等待不消耗 maxRounds', async () => {
  const { page: s, calls } = makeOverlayStubPage({
    script: [NDC_ROOT1, NDC_ROOT1, NDC_ROOT1, { status: 'clicked', clickedKind: 'know_button', controlKind: 'know_button' }, { status: 'none' }],
  });
  // maxRounds=2：若等待误消耗关闭上限，此处会提前 still_present；closed 即证明计数分离
  const { opts, sleeps } = makeWaitHarness({ maxRounds: 2, intervalMs: 77, waitBudgetMs: 6000, waitIntervalMs: 500 });
  const r = await dismissDoudianArrivalOverlay(s, opts);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'closed');
  assert.strictEqual(r.closed, true);
  assert.strictEqual(r.clickedCount, 1, '控件就绪后只允许一次 dismiss 点击');
  assert.strictEqual(r.waits, 3, '3 次有界重读后控件出现');
  assert.strictEqual(r.rounds, 5, 'rounds 覆盖全部评估轮（3 等待 + 1 点击 + 1 消失回读）');
  assert.strictEqual(calls.evaluate, 5);
  assert.deepStrictEqual(sleeps, [500, 500, 500, 77], '等待按重读间隔睡眠；点击后按轮次间隔回读');
});

test('永远无控件：持续 no_dismiss_control（唯一可信根）→ 预算内有限重读后 fail-closed，绝不假报 none/closed，零点击', async () => {
  const { page: s, calls } = makeOverlayStubPage({ script: [NDC_ROOT1] });
  const { opts, sleeps } = makeWaitHarness({ waitBudgetMs: 1000, waitIntervalMs: 500 });
  const r = await dismissDoudianArrivalOverlay(s, opts);
  assert.strictEqual(r.blocked, true);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.closed, false);
  assert.strictEqual(r.status, 'no_dismiss_control', '预算耗尽仍为 no_dismiss_control，绝不降级为 none/closed');
  assert.strictEqual(r.clickedCount, 0);
  assert.strictEqual(r.waits, 2, '1000ms/500ms → 恰好 2 次重读后停止');
  assert.strictEqual(calls.evaluate, 3, '初次判定 + 2 次有界重读，不得无界循环');
  assert.deepStrictEqual(sleeps, [500, 500]);
  assert.match(r.reason, /零点击|fail-closed/);
});

test('等待预算硬上限与非法参数归一化：预算夹到 6000ms；非法值回落默认；间隔夹到下限', async () => {
  assert.strictEqual(DEFAULT_WAIT_BUDGET_MS, 6000);
  assert.strictEqual(MAX_WAIT_BUDGET_MS, 6000);
  assert.strictEqual(DEFAULT_WAIT_INTERVAL_MS, 500);
  const a = makeOverlayStubPage({ script: [NDC_ROOT1] });
  const ra = await dismissDoudianArrivalOverlay(a.page, { ...makeWaitHarness().opts, waitBudgetMs: 9999999, waitIntervalMs: 500 });
  assert.strictEqual(ra.waits, Math.floor(MAX_WAIT_BUDGET_MS / DEFAULT_WAIT_INTERVAL_MS), '超大预算夹到硬上限 6000ms');
  assert.strictEqual(a.calls.evaluate, ra.waits + 1);
  const b = makeOverlayStubPage({ script: [NDC_ROOT1] });
  const rb = await dismissDoudianArrivalOverlay(b.page, { ...makeWaitHarness().opts, waitBudgetMs: 1000, waitIntervalMs: 1 });
  assert.strictEqual(rb.waits, Math.floor(1000 / MIN_WAIT_INTERVAL_MS), '超小间隔夹到下限，避免忙等');
  const c = makeOverlayStubPage({ script: [NDC_ROOT1] });
  const rc = await dismissDoudianArrivalOverlay(c.page, { ...makeWaitHarness().opts, waitBudgetMs: 'x', waitIntervalMs: -5 });
  assert.strictEqual(rc.waits, Math.floor(DEFAULT_WAIT_BUDGET_MS / DEFAULT_WAIT_INTERVAL_MS), '非法参数回落 6000/500 默认');
});

test('等待后出现危险/多根/多控件：每轮完整判据立即阻断，零点击，不延长业务确认', async () => {
  const followUps = [
    { status: 'danger_content', visibleRoots: 1, dangerWords: ['支付'], reason: '浮窗文案命中业务危险词（支付）' },
    { status: 'multi_visible_roots', visibleRoots: 2, reason: '多个可见浮窗根' },
    { status: 'multi_dismiss_controls', visibleRoots: 1, textControls: 2, reason: '多个「我知道了」控件' },
  ];
  for (const f of followUps) {
    const { page: s, calls } = makeOverlayStubPage({ script: [NDC_ROOT1, NDC_ROOT1, f] });
    const { opts } = makeWaitHarness({ waitBudgetMs: 6000, waitIntervalMs: 500 });
    const r = await dismissDoudianArrivalOverlay(s, opts);
    assert.strictEqual(r.blocked, true, f.status);
    assert.strictEqual(r.status, f.status);
    assert.strictEqual(r.clickedCount, 0, `${f.status}：等待中出现危险事实必须零点击`);
    assert.strictEqual(r.waits, 2, `${f.status}：出现即停，不再继续重读`);
    assert.strictEqual(calls.evaluate, 3, `${f.status}：危险事实出现后不得再轮询`);
  }
});

test('等待重读期间导航变更：强制实时 page.url() 复核，绝不依据旧 urlHint 点击 → url_mismatch 零点击', async () => {
  let liveUrl = TRUSTED;
  let evals = 0;
  const stub = {
    url: () => liveUrl,
    locator: () => ({ count: async () => 1 }),
    evaluate: async () => {
      evals += 1;
      if (evals === 1) liveUrl = 'https://evil.test/ffa/mshop/homepage/index'; // 首判后页面已导航出可信域
      return NDC_ROOT1;
    },
    waitForTimeout: async () => {},
  };
  const { opts } = makeWaitHarness({ waitBudgetMs: 6000, waitIntervalMs: 500 });
  const r = await dismissDoudianArrivalOverlay(stub, { ...opts, urlHint: TRUSTED });
  assert.strictEqual(r.status, 'url_mismatch');
  assert.strictEqual(r.clickedCount, 0);
  assert.strictEqual(r.waits, 1);
  assert.strictEqual(evals, 1, '导航变更后必须在 evaluate 之前被实时地址门拦截');
  assert.match(r.reason, /实时|不复用旧 urlHint/);
});

test('no_dismiss_control 但可见根非唯一（0/2 个）：不进入等待重读，立即阻断', async () => {
  for (const roots of [0, 2]) {
    const { page: s, calls } = makeOverlayStubPage({ script: [{ ...NDC_ROOT1, visibleRoots: roots }] });
    const { opts } = makeWaitHarness({ waitBudgetMs: 6000, waitIntervalMs: 500 });
    const r = await dismissDoudianArrivalOverlay(s, opts);
    assert.strictEqual(r.blocked, true, `roots=${roots}`);
    assert.strictEqual(r.status, 'no_dismiss_control');
    assert.strictEqual(r.waits, 0, `roots=${roots}：非唯一可信根不得重读`);
    assert.strictEqual(calls.evaluate, 1, `roots=${roots}：首判即停`);
    assert.strictEqual(r.clickedCount, 0);
  }
});

test('真实 fixture 延迟渲染端到端（复现 arrival-timeline 控件晚 ~3s）：有限重读后仅点「我知道了」一次并真实消失', async () => {
  const delayedInner = `<div class="style_title__x">豆包混资活动</div><div class="style_desc__x">${ACTIVITY_TEXT}</div>`
    + enrollBtn()
    + `<script>setTimeout(() => {`
    + ` document.querySelector('[class*="${OVERLAY_ROOT_CLASS}"]').insertAdjacentHTML('beforeend', ${JSON.stringify(knowBtn())});`
    + `}, 500);</script>`;
  await setBody(modalRoot(delayedInner));
  const asHome = {
    url: () => FXG_HOME,
    locator: (sel) => page.locator(sel),
    waitForTimeout: (ms) => page.waitForTimeout(ms),
    evaluate: (fn, args) => page.evaluate(fn, { ...args, checkUrl: false }),
  };
  const r = await dismissDoudianArrivalOverlay(asHome, { waitIntervalMs: 200, waitBudgetMs: 4000 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'closed');
  assert.strictEqual(r.clickedCount, 1, '控件就绪后恰好一次正确点击');
  assert.ok(r.waits >= 1, `控件晚渲染必须经历等待重读：waits=${r.waits}`);
  assert.deepStrictEqual(await readLog(), ['know'], '等待与点击全程绝不点「立即报名」');
  const left = await page.evaluate((cls) => document.querySelectorAll(`[class*="${cls}"]`).length, OVERLAY_ROOT_CLASS);
  assert.strictEqual(left, 0, '点击后浮窗根真实消失');
});

// ── 只读探测 helper（主脑现场验证用）──────────────────────────────

test('probeDoudianArrivalOverlay：真实 fixture 上只读探测零点击、DOM 不变', async () => {
  await setBody(modalRoot(REAL_MODAL_INNER));
  const asHome = {
    url: () => FXG_HOME,
    locator: (sel) => page.locator(sel),
    waitForTimeout: (ms) => page.waitForTimeout(ms),
    // fixture 页为 about:blank：仅此处关页内复核；Node 门与生产逻辑原样执行
    evaluate: (fn, args) => page.evaluate(fn, { ...args, checkUrl: false }),
  };
  const r = await probeDoudianArrivalOverlay(asHome, {});
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.status, 'dismissable');
  assert.strictEqual(r.controlKind, 'know_button');
  assert.deepStrictEqual(await readLog(), [], '只读探测绝不点击');
  const still = await page.evaluate((cls) => document.querySelectorAll(`[class*="${cls}"]`).length, OVERLAY_ROOT_CLASS);
  assert.strictEqual(still, 1, '只读探测不得修改 DOM');
});

test('dismissDoudianArrivalOverlay：真实 fixture 端到端 closed（经可信地址包装）', async () => {
  await setBody(modalRoot(REAL_MODAL_INNER));
  const asHome = {
    url: () => FXG_HOME,
    locator: (sel) => page.locator(sel),
    waitForTimeout: (ms) => page.waitForTimeout(ms),
    evaluate: (fn, args) => page.evaluate(fn, { ...args, checkUrl: false }),
  };
  const r = await dismissDoudianArrivalOverlay(asHome, { sleep: async () => {} });
  assert.strictEqual(r.status, 'closed');
  assert.deepStrictEqual(await readLog(), ['know']);
});

// ── 实际入口顺序 ──────────────────────────────────────────────────

function makeQcEntryStub(overlayScript) {
  const actions = [];
  let oi = 0;
  const qcTarget = {
    isClosed: () => false,
    url: () => QC_HOME_URL,
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
  };
  const context = { waitForEvent: async () => qcTarget };
  const pageStub = {
    url: () => FXG_HOME,
    waitForTimeout: async () => {},
    goto: async () => {},
    locator: () => { actions.push('overlay-count'); return { count: async () => 1 }; },
    evaluate: async (fn, args) => {
      actions.push('overlay-eval');
      const r = overlayScript[Math.min(oi, overlayScript.length - 1)];
      oi += 1;
      return r;
    },
    getByText: () => ({
      first() { return this; },
      nth() { return this; },
      count: async () => 1,
      evaluate: async () => '',
      click: async () => { actions.push('entry-click'); },
    }),
  };
  return { page: pageStub, context, actions };
}

test('实际入口顺序（千川）：处置浮窗严格先于「巨量千川」入口点击，消失后才点入口', async () => {
  const { page: s, context, actions } = makeQcEntryStub([{ status: 'clicked', clickedKind: 'know_button' }, { status: 'none' }]);
  const r = await reachQianchuanHome({ page: s, context, shopCfg: { accountId: '1710242295996424' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.mode, 'entry-click');
  assert.strictEqual(r.overlay.clickedCount, 1);
  assert.strictEqual(r.overlay.status, 'closed');
  const evalIdx = actions.lastIndexOf('overlay-eval');
  const clickIdx = actions.indexOf('entry-click');
  assert.ok(clickIdx > evalIdx, `处置必须在入口点击之前：${actions.join(' → ')}`);
  assert.strictEqual(actions.filter((a) => a === 'entry-click').length, 1, '入口恰好点击一次');
});

test('实际入口顺序（千川·阻断）：危险浮窗 → 零入口点击、不进兜底，reason 如实', async () => {
  const { page: s, context, actions } = makeQcEntryStub([{ status: 'danger_content', reason: '浮窗含业务危险词(支付)：零点击阻断' }]);
  const r = await reachQianchuanHome({ page: s, context, shopCfg: { accountId: '1710242295996424' } });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /营销浮窗处理受阻/);
  assert.ok(!actions.includes('entry-click'), '阻断后绝不点击入口');
});

test('实际入口顺序（罗盘根证复现）：route 全拦截的可信首页上，浮窗确实拦截「成交订单数」点击；先 dismiss 后点击成功，「立即报名」全程零触碰', async () => {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    #entry { padding: 24px; font-size: 20px; }
    .cover { position: fixed; inset: 0; z-index: 9999; background: rgba(0,0,0,.45); }
  </style></head><body>
  <script>window.__log=[];</script>
  <div id="entry" onclick="window.__log.push('label')">成交订单数</div>
  <div class="${WRAP_CLS} cover">
    <div>${ACTIVITY_TEXT}</div>
    ${enrollBtn()}
    ${knowBtn()}
    ${closeDiv()}
  </div>
  </body></html>`;
  await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  try {
    await page.goto(FXG_HOME, { waitUntil: 'load' });
    assert.strictEqual(page.url(), FXG_HOME);
    // 复现根证：拦截报错（被 ws-arrival-modal-wrap 盖住）
    await assert.rejects(
      () => page.getByText('成交订单数', { exact: true }).first().click({ timeout: 3000 }),
      /intercepts pointer events|超时|Timeout/i,
    );
    // 生产同一入口：真实页面（无包装，页内 checkUrl 强制、Node 门实时读取）
    const r = await dismissDoudianArrivalOverlay(page, { sleep: async () => {} });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.status, 'closed', '真实可信地址 + 唯一可见根 + 唯一「我知道了」→ 正常关闭');
    // 关闭后成交订单数入口可点（罗盘链在点击前的插入点语义成立）
    await page.getByText('成交订单数', { exact: true }).first().click({ timeout: 5000 });
    const log = await readLog();
    assert.ok(log.includes('know'), '浮窗经「我知道了」关闭');
    assert.ok(log.includes('label'), '浮窗消失后入口点击成功');
    assert.ok(!log.includes('enroll'), '绝不点击立即报名');
  } finally {
    await page.unroute('**/*');
  }
});

test('页内地址门：route 离线注入真实地址的非默认端口/裸前缀相似路径 → url_mismatch；凭据地址由独立 VM 精确注入真实页内函数验证，零点击、DOM 未触碰；可信正对照放行', async () => {
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>`
    + '<script>window.__log=[];</script>' + modalRoot(REAL_MODAL_INNER) + '</body></html>';
  await page.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  try {
    const badUrls = [
      'https://fxg.jinritemai.com:444/ffa/mshop/homepage/index',
      'https://fxg.jinritemai.com/ffa/mshop/homepage-evil',
      'https://fxg.jinritemai.com/ffa/mshop/homepagee/index',
    ];
    for (const bad of badUrls) {
      await page.goto(bad, { waitUntil: 'load' });
      assert.strictEqual(page.url(), bad);
      // 真实执行页内函数，checkUrl 强制（非 mock）
      const r = await page.evaluate(handleArrivalOverlayInPage, { ...INPAGE_BASE, mode: 'dismiss', checkUrl: true });
      assert.strictEqual(r.status, 'url_mismatch', bad);
      assert.deepStrictEqual(await readLog(), [], `${bad}：地址门不通过必须零点击`);
      const left = await page.evaluate((cls) => document.querySelectorAll(`[class*="${cls}"]`).length, OVERLAY_ROOT_CLASS);
      assert.strictEqual(left, 1, `${bad}：DOM 不得被触碰`);
    }
    // 可信正对照：回到无 credentials 的可信地址，同一真实页内函数必须放行（门不是恒拒）
    await page.goto(FXG_HOME, { waitUntil: 'load' });
    assert.strictEqual(page.url(), FXG_HOME);
    const rok = await page.evaluate(handleArrivalOverlayInPage, { ...INPAGE_BASE, mode: 'probe', checkUrl: true });
    assert.strictEqual(rok.status, 'dismissable', '可信地址 + checkUrl 强制应放行只读探测');
    assert.deepStrictEqual(await readLog(), [], '只读探测零点击');
  } finally {
    await page.unroute('**/*');
  }

  // credentials：真实 Edge 不允许 history.pushState 改写为带 userinfo 的同源地址
  // （SecurityError），且不得更改浏览器安全设置。改用独立 VM 上下文精确注入
  // location.href 后执行**真实** handleArrivalOverlayInPage 序列化源码 + 合成 DOM。
  const CREDENTIAL_URL = 'https://u@fxg.jinritemai.com/ffa/mshop/homepage/index';
  const credDom = syntheticOverlayDom();
  const rc = runInPageWithHref(CREDENTIAL_URL, credDom);
  assert.strictEqual(rc.status, 'url_mismatch', '可信 host/path 但带 credentials 必须拒绝');
  assert.deepStrictEqual(credDom.clicks, [], 'credentials 拒绝路径零点击');
  assert.strictEqual(credDom.rootQueries, 0, '地址门在触碰浮窗根之前返回，DOM 未触碰');

  // VM harness 正对照：同一真实函数在可信地址下必须正常识别并仅点击「我知道了」
  const okDom = syntheticOverlayDom();
  const ok = runInPageWithHref(FXG_HOME, okDom);
  assert.strictEqual(ok.status, 'clicked', '同一 VM 注入通道下可信地址必须放行');
  assert.strictEqual(ok.clickedKind, 'know_button');
  assert.deepStrictEqual(okDom.clicks, ['know'], '只允许「我知道了」被点击一次');
});
