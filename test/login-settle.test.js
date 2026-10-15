'use strict';

/**
 * R51 回归：抖店首页自动 SSO 收敛（伪登录过期 FALSE-EXPIRED 修复）。
 * 根证 reference-readonly-session.json（2026-10-15 只读复测，敏敏高定私服）：
 *   同一已保存 Cookie 装入全新无头 Edge → DOMContentLoaded 后 5s/15s 仍在
 *   /login/common（自动 SSO 中转），30s 自动落到 /ffa/mshop/homepage/index。
 * 旧实现固定等 5s 即把中转 URL 判 AuthError → requiresLogin=true 伪过期。
 * 本文件全部离线（注入 browserFactory + 虚拟时钟 + 即时 sleep），零真实等待/零网络。
 * 运行：node --test test/login-settle.test.js
 */

const { test, before } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  openQianchuanHome,
  waitForDoudianHomepageSettled,
  isDoudianHomepageUrl,
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
const QC_HOME = 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424';

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-settle-test-'));
  fs.writeFileSync(path.join(dir, '测试店铺.json'), JSON.stringify([
    { name: 'sessionid', value: 'FAKE_NOT_REAL', domain: '.fxg.jinritemai.com', path: '/', expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: true, sameSite: 'Lax' },
  ]));
  LOGIN_CFG.cookieSourceDir = dir;
});

/** 虚拟时钟：settleSleep 即时返回并推进虚拟时间（测试零真实等待）。 */
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

/** 可编程 stub 浏览器：url() 按 urlQueue 顺序出队（队尾滞留）；登录正证据探针全空。 */
function makeStubPage({ urlQueue = [], onGoto = null, entryCount = 1, closeAfterFirstSleep = false } = {}) {
  const calls = { gotos: [], closes: 0, urlCalls: 0, sleeps: 0 };
  let urlIdx = 0;
  let closedFlag = false;
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
    reload: async () => {},
    goBack: async () => {},
    evaluate: async () => null, // collectLoginExpiryEvidence 页内探针：无正证据（loginUrl 由 URL 判定）
    getByRole: () => ({ count: async () => 0 }),
    getByText: () => ({
      first() { return this; },
      nth() { return this; },
      count: async () => entryCount,
      click: async () => {},
      waitFor: async () => {},
      isVisible: async () => false,
      evaluate: async () => '', // entryCandidateHref：候选最近 <a> href 为空（非教程链接）
    }),
    locator: () => ({
      nth() { return this; },
      first() { return this; },
      count: async () => 0,
      click: async () => {},
      waitFor: async () => {},
      isVisible: async () => false,
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
      if (closeAfterFirstSleep) closedFlag = true;
      void ms;
    },
  };
}

function settleOpts(clock, extra = {}) {
  return { settleNowFn: clock.nowFn, settleSleep: clock.sleep, ...extra };
}

// ── 纯函数：严格 host/path 判定 ────────────────────────────────────

test('isDoudianHomepageUrl：严格 origin+path；lookalike 域名/子串伪造不算首页', () => {
  assert.strictEqual(isDoudianHomepageUrl(FXG_HOME), true);
  assert.strictEqual(isDoudianHomepageUrl('https://fxg.jinritemai.com/ffa/mshop/homepage/index?foo=1'), true);
  assert.strictEqual(isDoudianHomepageUrl(LOGIN_COMMON), false, '登录中转页不算首页');
  assert.strictEqual(isDoudianHomepageUrl('https://fxg.jinritemai.com.evil.test/ffa/mshop/homepage/index'), false, 'lookalike 域名（后缀伪装）拒绝');
  assert.strictEqual(isDoudianHomepageUrl('https://evil.test/?u=https://fxg.jinritemai.com/ffa/mshop/homepage'), false, 'URL 参数内包含首页地址拒绝');
  assert.strictEqual(isDoudianHomepageUrl('http://fxg.jinritemai.com/ffa/mshop/homepage/index'), false, '非 https 拒绝');
  assert.strictEqual(isDoudianHomepageUrl(''), false);
  assert.strictEqual(isDoudianHomepageUrl(null), false);
});

// ── waitForDoudianHomepageSettled：有界收敛语义 ────────────────────

test('快路径：已是首页 → attempts=0、零等待（不付 45s 代价）', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubPage({ urlQueue: [FXG_HOME] });
  const r = await waitForDoudianHomepageSettled(stub.page, { settleNowFn: clock.nowFn, settleSleep: stub.settleSleep });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.attempts, 0, '已是首页不进入轮询');
  assert.strictEqual(r.waited, false);
  assert.strictEqual(stub.calls.sleeps, 0, '零 sleep');
});

test('延迟收敛：中转 URL ~30s 后到首页 → 成功；等待有界（≤45s+一个 interval）', async () => {
  const clock = makeVirtualClock();
  // 快检查 1 次 + 每 3s 一次轮询；第 10 次轮询（虚拟 ~30s）到首页
  const queue = [LOGIN_COMMON];
  for (let i = 1; i <= 9; i += 1) queue.push(LOGIN_COMMON);
  queue.push(FXG_HOME);
  const stub = makeStubPage({ urlQueue: queue });
  const r = await waitForDoudianHomepageSettled(stub.page, { settleNowFn: clock.nowFn, settleSleep: stub.settleSleep });
  assert.strictEqual(r.ok, true, '30s 内自动收敛成功（根证复现）');
  assert.strictEqual(r.url, FXG_HOME);
  assert.strictEqual(r.attempts, 10, '第 10 次轮询命中');
  assert.ok(clock.now() <= DEFAULT_SETTLE_TIMEOUT_MS + DEFAULT_SETTLE_INTERVAL_MS, `虚拟时钟 ${clock.now()}ms 必须有界`);
});

test('上界：永不收敛 → 有界失败（硬限次收敛，虚拟时钟不越界）', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubPage({ urlQueue: [LOGIN_COMMON] });
  const r = await waitForDoudianHomepageSettled(stub.page, { settleNowFn: clock.nowFn, settleSleep: stub.settleSleep });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'settle-timeout');
  const maxAttempts = Math.ceil(DEFAULT_SETTLE_TIMEOUT_MS / DEFAULT_SETTLE_INTERVAL_MS) + 1;
  assert.strictEqual(r.attempts, maxAttempts, '恰好硬限次（16）后停止');
  assert.ok(clock.now() <= DEFAULT_SETTLE_TIMEOUT_MS + DEFAULT_SETTLE_INTERVAL_MS);
});

test('页面被关闭：有界返回 settle-page-closed，不空转', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubPage({ urlQueue: [LOGIN_COMMON], closeAfterFirstSleep: true });
  const r = await waitForDoudianHomepageSettled(stub.page, { settleNowFn: clock.nowFn, settleSleep: stub.settleSleep });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'settle-page-closed');
  assert.ok(r.attempts <= 2, '关闭后立即收敛');
});

// ── openQianchuanHome 全链路（真实生命周期，注入浏览器/时钟）──────

test('全链路：SSO 中转 30s 后落首页 → 不再伪报登录过期，正常走到千川（entry-click）', async () => {
  const clock = makeVirtualClock();
  // 收敛期：快检查 + 9 次中转 + 第 10 次(30s)首页；随后入口点击 → 千川首页
  const queue = [];
  for (let i = 0; i < 10; i += 1) queue.push(LOGIN_COMMON);
  queue.push(FXG_HOME, QC_HOME, QC_HOME, QC_HOME);
  const stub = makeStubPage({ urlQueue: queue });
  const r = await openQianchuanHome(
    LOGIN_CFG,
    { cookieFile: '测试店铺', accountId: '1710242295996424' },
    { browserFactory: async () => stub.browser, ...settleOpts(clock) },
  );
  assert.strictEqual(r.navMode, 'entry-click', '首页收敛成功后继续既有入口点击链路');
  assert.ok(String(r.target.url()).includes('qianchuan.jinritemai.com'));
  assert.strictEqual(stub.calls.closes, 0, '成功路径不关浏览器（由调用者释放）');
});

test('真过期：全上界后仍是登录页 → 才判 AuthError；且分类前确实做了满额有界收敛', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubPage({ urlQueue: [LOGIN_COMMON] }); // 永远停在登录页（持续态）
  await assert.rejects(
    () => openQianchuanHome(
      LOGIN_CFG,
      { cookieFile: '测试店铺', accountId: '1710242295996424' },
      { browserFactory: async () => stub.browser, ...settleOpts(clock) },
    ),
    (e) => e instanceof AuthError && /登录失效/.test(e.message),
  );
  const maxAttempts = Math.ceil(DEFAULT_SETTLE_TIMEOUT_MS / DEFAULT_SETTLE_INTERVAL_MS) + 1;
  // 1 次快检查 + 16 次轮询 = 分类前至少 17 次地址探测（证明先收敛后分类）
  assert.ok(stub.calls.urlCalls >= 1 + maxAttempts, `分类前地址探测 ${stub.calls.urlCalls} 次 ≥ ${1 + maxAttempts}`);
  assert.strictEqual(stub.calls.closes, 1, '失败路径必须关闭本次创建的浏览器');
});

test('无关导航（school 教程页滞留）：收敛上界后是 DataGuard 导航事实，不是登录过期', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubPage({
    urlQueue: ['https://school.jinritemai.com/doudian/web/article/7024879829574287367'],
  });
  await assert.rejects(
    () => openQianchuanHome(
      LOGIN_CFG,
      { cookieFile: '测试店铺', accountId: '1710242295996424' },
      { browserFactory: async () => stub.browser, ...settleOpts(clock) },
    ),
    (e) => e instanceof DataGuardError && !/登录失效|请重新扫码登录/.test(e.message) && /收敛期|未到达首页/.test(e.message),
  );
  assert.strictEqual(stub.calls.closes, 1);
});

test('网络超时（goto 失败）：原样错误（非登录语义）+ 浏览器清理', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubPage({ onGoto: () => { throw new Error('net::ERR_TIMED_OUT'); } });
  await assert.rejects(
    () => openQianchuanHome(
      LOGIN_CFG,
      { cookieFile: '测试店铺', accountId: '1710242295996424' },
      { browserFactory: async () => stub.browser, ...settleOpts(clock) },
    ),
    (e) => !(e instanceof AuthError) && /net::ERR_TIMED_OUT/.test(e.message),
  );
  assert.strictEqual(stub.calls.closes, 1, '初始化失败必须关闭浏览器');
});

test('lookalike 域名伪装首页：收敛不认（严格 host/path），上界后按 DataGuard 失败', async () => {
  const clock = makeVirtualClock();
  const stub = makeStubPage({ urlQueue: ['https://fxg.jinritemai.com.evil.test/ffa/mshop/homepage/index'] });
  await assert.rejects(
    () => openQianchuanHome(
      LOGIN_CFG,
      { cookieFile: '测试店铺', accountId: '1710242295996424' },
      { browserFactory: async () => stub.browser, ...settleOpts(clock) },
    ),
    (e) => e instanceof DataGuardError && !(e instanceof AuthError),
  );
  assert.strictEqual(stub.calls.closes, 1);
});
