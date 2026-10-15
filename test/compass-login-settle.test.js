'use strict';

/**
 * R53 回归：电商罗盘订单读取链（readOrderSummary 全链路）接入抖店首页
 * 自动 SSO 有界收敛（复用 R51 waitForDoudianHomepageSettled）。
 *
 * 根证（reference-readonly-session.json，2026-10-15 只读复测）：同一有效 Cookie
 * 装入全新浏览器后，抖店首页先停在 /login/common 自动 SSO 中转，约 30s 才落到
 * /ffa/mshop/homepage/index。旧实现固定等 6s 即把中转地址判 AuthError →
 * Min 店铺面板被误判 requiresLogin=true 要求重扫（伪登录过期）。
 *
 * 本文件全部离线：注入 browserFactory + 虚拟时钟 + 即时 sleep，零真实浏览器/
 * 零网络/零真实 Cookie。覆盖：
 * - 自动 SSO ~30s 收敛后全链路成功（当前订单值 0 是合法读取值）；
 * - 持续登录页（正证据）→ 才判 AuthError（有界）；
 * - 教程/未知导航、页面被关闭、网络超时 → DataGuard/原始网络错误，不触发重扫；
 * - 浏览器清理；店铺身份不匹配仍被阻止；占位/口径无效当前值仍 fail-closed。
 * 运行：node --test test/compass-login-settle.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  createCompassOrderReader,
  extractOrderValueInPage,
} = require('../src/adapters/compass-order-reader');
const {
  collectLoginExpiryEvidence,
  DEFAULT_SETTLE_TIMEOUT_MS,
  DEFAULT_SETTLE_INTERVAL_MS,
} = require('../src/adapters/qianchuan-reader');
const { AuthError, DataGuardError } = require('../src/lib/errors');

const LOGIN_CFG = {
  cookieSourceDir: null,
  edgePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  douyinHomeUrl: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
};
const FXG_HOME = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const LOGIN_COMMON = 'https://fxg.jinritemai.com/login/common';
const COMPASS_URL = 'https://compass.jinritemai.com/shop/dashboard/index?page_name=经营概况';
const TUTORIAL_URL = 'https://school.jinritemai.com/doudian/web/article/7024879829574287367';
const SHOP_CFG = { id: 'shop-min', name: '敏敏高定私服', cookieFile: '敏敏高定私服' };

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compass-login-settle-test-'));
  fs.writeFileSync(path.join(dir, '敏敏高定私服.json'), JSON.stringify([
    { name: 'sessionid', value: 'FAKE_NOT_REAL', domain: '.fxg.jinritemai.com', path: '/', expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: true, sameSite: 'Lax' },
  ]));
  LOGIN_CFG.cookieSourceDir = dir;
});

/** 虚拟时钟：sleep 即时返回并推进虚拟时间（零真实等待）。 */
function makeVirtualClock(startMs = 0) {
  let t = startMs;
  let sleepCalls = 0;
  return {
    nowFn: () => t,
    sleep: async (ms) => { sleepCalls += 1; t += ms; },
    sleepCalls: () => sleepCalls,
    now: () => t,
  };
}

/**
 * 可编程 stub 浏览器：url() 按 urlQueue 出队（队尾滞留）；
 * evaluate 按参数形状分派：{uuid} → 罗盘指标探测结果；'经营概况' → 概况可见性；
 * 无参（登录正证据探针）→ null（loginUrl 由 URL 判定）。
 * locator('[class*="userName"]') → 右上角店铺名。
 */
function makeStubCompassEnv({
  urlQueue = [],
  onGoto = null,
  probe = null,
  pageShopName = SHOP_CFG.name,
  overviewOk = true,
  entryCount = 1,
  entryAppearAfterWait = 0,
  closeAfterFirstSettleSleep = false,
} = {}) {
  const calls = { gotos: [], closes: 0, urlCalls: 0, sleeps: 0, evaluates: 0 };
  let urlIdx = 0;
  let closedFlag = false;
  let entryWaitCalls = 0;
  const defaultProbe = () => ({
    code: 'ok', valueText: '0', labelText: '成交订单数', cardText: '成交订单数0昨日145同行基准114',
    saleScope: { realtimeActive: true, saleAllActive: true, realtimeFound: true, saleAllFound: true, tabs: [] },
    overviewTimestamp: null,
  });
  const page = {
    __calls: calls,
    goto: async (u) => { calls.gotos.push(u); if (onGoto) return onGoto(u); return null; },
    waitForTimeout: async (ms) => { calls.sleeps += 1; void ms; },
    waitForLoadState: async () => {},
    waitForFunction: async () => null,
    waitForURL: async () => null,
    url: () => { calls.urlCalls += 1; return urlQueue[Math.min(urlIdx++, urlQueue.length - 1)]; },
    isClosed: () => closedFlag,
    title: async () => '首页',
    screenshot: async () => {},
    evaluate: async (fn, arg) => {
      calls.evaluates += 1;
      if (arg && typeof arg === 'object' && typeof arg.uuid === 'string') {
        return (probe || defaultProbe)(arg);
      }
      if (arg === '经营概况') return overviewOk;
      return null; // collectLoginExpiryEvidence 页内探针：无正证据
    },
    getByText: () => ({
      first() { return this; },
      // R54：精确入口延迟渲染 —— 首次 count 为 0，locator.waitFor 有界等待后被 SPA 挂载
      count: async () => (entryWaitCalls >= entryAppearAfterWait ? entryCount : 0),
      waitFor: async () => { entryWaitCalls += 1; },
      click: async () => {},
    }),
    getByRole: () => ({ count: async () => 0 }),
    locator: () => ({
      first() { return this; },
      count: async () => 0,
      click: async () => {},
      waitFor: async () => {},
      isVisible: async () => false,
      textContent: async () => pageShopName,
    }),
  };
  const context = {
    addCookies: async () => {},
    newPage: async () => page,
    waitForEvent: async () => null,
    on() {},
    off() {},
  };
  const browser = {
    newContext: async () => context,
    close: async () => { calls.closes += 1; browser.closed = true; },
  };
  return {
    page, context, browser, calls,
    settleSleep: async (ms) => {
      calls.sleeps += 1;
      if (closeAfterFirstSettleSleep) closedFlag = true;
      void ms;
    },
  };
}

/** 组装 reader 参数：注入 browserFactory + 虚拟时钟（settleSleep 经 p.sleep 生效）。 */
function readerOpts(stub, clock, extra = {}) {
  return {
    loginCfg: LOGIN_CFG,
    nowFn: clock.nowFn,
    sleep: clock.sleep,
    settleSleep: stub.settleSleep,
    evidenceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'compass-evidence-')),
    browserFactory: async () => stub.browser,
    ...extra,
  };
}

function makeReader(stub, clock, extra = {}) {
  return createCompassOrderReader(readerOpts(stub, clock, extra));
}

// ── 依赖复用：单向 import 安全 + 登录正证据导出 ────────────────────

test('依赖复用：qianchuan-reader 导出 collectLoginExpiryEvidence（罗盘链单向复用，无循环依赖）', () => {
  assert.strictEqual(typeof collectLoginExpiryEvidence, 'function');
  assert.strictEqual(typeof extractOrderValueInPage, 'function');
});

// ── 全链路：自动 SSO 30s 收敛 → 罗盘订单成功读取 ────────────────────

test('自动 SSO ~30s：中转 10 次探测后落首页 → 全链路成功，实时全店订单 0 是合法读取值', async () => {
  const clock = makeVirtualClock();
  // 收敛期：快检查 + 9 次中转 + 第 10 次(虚拟 30s)首页；随后点击入口 → 罗盘
  const queue = [];
  for (let i = 0; i < 10; i += 1) queue.push(LOGIN_COMMON);
  queue.push(FXG_HOME, COMPASS_URL, COMPASS_URL);
  const stub = makeStubCompassEnv({ urlQueue: queue });
  const reader = makeReader(stub, clock);
  const r = await reader.readOrderSummary({ shopCfg: SHOP_CFG });
  assert.strictEqual(r.source, 'promo-page');
  assert.strictEqual(r.kind, 'orders');
  assert.strictEqual(r.shopId, SHOP_CFG.id);
  assert.strictEqual(r.valueCount, 0, '订单 0 为合法读取值（凌晨零订单语义保留）');
  assert.strictEqual(r.rawText, '0');
  assert.match(r.dateScopeEvidence, /全店/);
  assert.match(r.dateScopeEvidence, /实时/);
  assert.strictEqual(r.identitySource.adapter, 'compass-order-reader');
  assert.strictEqual(r.identityEvidence.pageShopName, SHOP_CFG.name, '店铺身份精确核验通过');
  assert.ok(/compass\.jinritemai\.com/.test(r.pageUrl));
  assert.strictEqual(stub.calls.closes, 1, '读取结束必须关闭本次创建的浏览器');
});

test('快路径：固定 6s 后已在首页 → 零额外收敛等待，直接进入罗盘链', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubCompassEnv({ urlQueue: [FXG_HOME, COMPASS_URL, COMPASS_URL] });
  const reader = makeReader(stub, clock);
  const r = await reader.readOrderSummary({ shopCfg: SHOP_CFG });
  assert.strictEqual(r.valueCount, 0);
  assert.ok(clock.now() < DEFAULT_SETTLE_INTERVAL_MS, `快路径不付 45s 代价（虚拟时钟 ${clock.now()}ms）`);
});

// ── 真过期 vs 伪过期分类 ────────────────────────────────────────────

test('真过期：收敛上界后仍是登录页 → 有界 AuthError；分类前确实做了满额收敛', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubCompassEnv({ urlQueue: [LOGIN_COMMON] });
  await assert.rejects(
    () => makeReader(stub, clock).readOrderSummary({ shopCfg: SHOP_CFG }),
    (e) => e instanceof AuthError && /登录失效/.test(e.message),
  );
  const maxAttempts = Math.ceil(DEFAULT_SETTLE_TIMEOUT_MS / DEFAULT_SETTLE_INTERVAL_MS) + 1;
  assert.ok(stub.calls.urlCalls >= 1 + maxAttempts, `分类前地址探测 ${stub.calls.urlCalls} 次 ≥ ${1 + maxAttempts}`);
  assert.ok(clock.now() <= DEFAULT_SETTLE_TIMEOUT_MS + DEFAULT_SETTLE_INTERVAL_MS, '等待必须有界');
  assert.strictEqual(stub.calls.closes, 1, '失败路径必须关闭浏览器');
});

test('教程页滞留（无关导航）：收敛上界后是 DataGuard 导航事实，绝不触发重扫语义', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubCompassEnv({ urlQueue: [TUTORIAL_URL] });
  await assert.rejects(
    () => makeReader(stub, clock).readOrderSummary({ shopCfg: SHOP_CFG }),
    (e) => e instanceof DataGuardError
      && !(e instanceof AuthError)
      && !/登录失效|请重新扫码登录/.test(e.message)
      && /收敛期|未到达首页/.test(e.message),
  );
  assert.strictEqual(stub.calls.closes, 1);
});

test('未知地址滞留（非首页非登录页）：DataGuard 导航事实，不是登录过期', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubCompassEnv({ urlQueue: ['https://unknown.example.com/somewhere'] });
  await assert.rejects(
    () => makeReader(stub, clock).readOrderSummary({ shopCfg: SHOP_CFG }),
    (e) => e instanceof DataGuardError && !(e instanceof AuthError),
  );
  assert.strictEqual(stub.calls.closes, 1);
});

test('收敛期页面被关闭：DataGuard（导航事实），不空转不重扫', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubCompassEnv({ urlQueue: [LOGIN_COMMON], closeAfterFirstSettleSleep: true });
  await assert.rejects(
    () => makeReader(stub, clock).readOrderSummary({ shopCfg: SHOP_CFG }),
    (e) => e instanceof DataGuardError && !(e instanceof AuthError) && /被关闭/.test(e.message),
  );
  assert.strictEqual(stub.calls.closes, 1);
});

test('网络超时（goto 失败）：原样网络错误（非登录语义）+ 浏览器清理', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubCompassEnv({ onGoto: () => { throw new Error('net::ERR_TIMED_OUT at fxg.jinritemai.com'); } });
  await assert.rejects(
    () => makeReader(stub, clock).readOrderSummary({ shopCfg: SHOP_CFG }),
    (e) => !(e instanceof AuthError) && /net::ERR_TIMED_OUT/.test(e.message),
  );
  assert.strictEqual(stub.calls.closes, 1, '初始化失败必须关闭浏览器');
});

// ── 既有数据护栏语义不放宽 ─────────────────────────────────────────

test('店铺身份不匹配：仍按 AuthError 阻止（精确比对，不放宽）', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubCompassEnv({
    urlQueue: [FXG_HOME, COMPASS_URL, COMPASS_URL],
    pageShopName: '别的店铺',
  });
  await assert.rejects(
    () => makeReader(stub, clock).readOrderSummary({ shopCfg: SHOP_CFG }),
    (e) => e instanceof AuthError && /身份不匹配/.test(e.message),
  );
  assert.strictEqual(stub.calls.closes, 1);
});

test('当前值为占位符（—）：DataGuard 阻止，不回退昨日/同行基准，不把占位当 0', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubCompassEnv({
    urlQueue: [FXG_HOME, COMPASS_URL, COMPASS_URL],
    probe: () => ({ code: 'value_placeholder', reason: '当前值为占位符「—」', hasYesterday: true }),
  });
  await assert.rejects(
    () => makeReader(stub, clock).readOrderSummary({ shopCfg: SHOP_CFG }),
    (e) => e instanceof DataGuardError && /成交订单数.*读取失败|占位/.test(e.message),
  );
  assert.strictEqual(stub.calls.closes, 1);
});

test('口径失效（实时选中但全店未选中）：DataGuard 阻止（双口径核验保留）', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubCompassEnv({
    urlQueue: [FXG_HOME, COMPASS_URL, COMPASS_URL],
    probe: () => ({
      code: 'ok', valueText: '17', labelText: '成交订单数', cardText: '成交订单数17',
      saleScope: { realtimeActive: true, saleAllActive: false, realtimeFound: true, saleAllFound: true, tabs: [] },
      overviewTimestamp: null,
    }),
  });
  await assert.rejects(
    () => makeReader(stub, clock).readOrderSummary({ shopCfg: SHOP_CFG }),
    (e) => e instanceof DataGuardError && /口径核验失败/.test(e.message),
  );
  assert.strictEqual(stub.calls.closes, 1);
});

// ── R54：SSO 后首页 SPA 入口延迟渲染（瞬时 count=0 非 结构性缺失） ──

test('R54 延迟入口：首页已就绪但精确"成交订单数"标签初始 count=0，有界等待挂载后成功读取订单 10', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubCompassEnv({
    urlQueue: [FXG_HOME, COMPASS_URL, COMPASS_URL],
    entryAppearAfterWait: 1, // 首次 count 为 0；waitFor 有界等待后才渲染
    probe: () => ({
      code: 'ok', valueText: '10', labelText: '成交订单数', cardText: '成交订单数10昨日145同行基准114',
      saleScope: { realtimeActive: true, saleAllActive: true, realtimeFound: true, saleAllFound: true, tabs: [] },
      overviewTimestamp: null,
    }),
  });
  const reader = makeReader(stub, clock);
  const r = await reader.readOrderSummary({ shopCfg: SHOP_CFG });
  assert.strictEqual(r.valueCount, 10, '延迟挂载的精确入口被点击后正确读取实时全店订单');
  assert.strictEqual(r.rawText, '10');
  assert.match(r.dateScopeEvidence, /全店/);
  assert.match(r.dateScopeEvidence, /实时/);
  assert.strictEqual(r.identityEvidence.pageShopName, SHOP_CFG.name);
  assert.strictEqual(stub.calls.closes, 1);
});

test('R54 持久缺失：有界等待后精确标签仍不存在 → 原 DataGuard 语义保留（非 Auth、不重扫）+ 清理', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubCompassEnv({
    urlQueue: [FXG_HOME, COMPASS_URL, COMPASS_URL],
    entryCount: 0, // 等待后仍无精确入口
  });
  await assert.rejects(
    () => makeReader(stub, clock).readOrderSummary({ shopCfg: SHOP_CFG }),
    (e) => e instanceof DataGuardError
      && !(e instanceof AuthError)
      && !/登录失效|请重新扫码登录/.test(e.message)
      && /未找到"成交订单数"文字入口/.test(e.message),
  );
  assert.strictEqual(stub.calls.closes, 1);
});
