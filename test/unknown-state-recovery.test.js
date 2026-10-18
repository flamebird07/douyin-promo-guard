'use strict';

/**
 * 状态未知修复（2026-10-18）离线回归：真实 Monitor 方法链 + 假 page/controller。
 *
 * 覆盖：
 *  1) 32 vs 31 瞬态不一致 → 同周期最多一次有界只读重读 → 32/32 恢复；
 *  2) 稳定不一致 → 保留有原因 unknown，零点击，不无限重试；
 *  3) 管理页导航未稳定一次 → 新 session 重读成功；
 *  4) 持续 Auth → 不盲试、不要求扫码误判（由正式 AuthError 分类）；
 *  5) close 失败/迟到 work → 不启动第二次读取，且只阻断本店（跨店隔离）；
 *  6) 总期限与次数可控；
 *  7) refreshShopData：新 Auth 撤销旧 on、旧原因被新因覆盖、成功清除、注入 error 不丢；
 *  8) 跨周期收口门（F3-R7）：无句柄未知失败连续两调用只 opener 一次；真实适配器 close
 *     拒绝 → 凭 WeakMap 收口句柄推进，关闭成功后自动清门并从新 session 读取成功（跨店隔离）。
 *
 * 不访问浏览器/CDP/网络/真实 Cookie；所有生产模块仅注入假对象。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor.js');
const { AuthError, DataGuardError } = require('../src/lib/errors.js');
const { openChengfangShop, readChengfangCleanupEvidence } = require('../src/adapters/chengfang-reader.js');
const {
  makeTempDir, makeCfgResult, makeStatefulController, makeLinkedReader,
} = require('./helpers.js');

const TAB_MAIN = '全店托管';
const TAB_SUB = '商品自选';
const SHOP_A = { id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true };
const SHOP_B = { id: 'shop-b', name: 'shop-b', cookieFile: 'shop-b', accountId: null, enabled: true };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rows(prefix, count, checked = true) {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i + 1}`, switchChecked: checked }));
}

/** 32 条但末页只读回 31 条（total=32），用于复现 UTC03:25 的清单不一致。 */
function inconsistentViews(prefix = 'p') {
  return {
    [TAB_MAIN]: [
      { rows: rows(prefix, 10), hasNext: true, total: 32 },
      { rows: rows(`${prefix}b`, 10), hasNext: true, total: 32 },
      { rows: rows(`${prefix}c`, 10), hasNext: true, total: 32 },
      { rows: rows(`${prefix}d`, 1), hasNext: false, total: 32 },
    ],
    [TAB_SUB]: [{ rows: [], hasNext: false, total: 0 }],
  };
}

function fullViews(prefix = 'p') {
  return {
    [TAB_MAIN]: [
      { rows: rows(prefix, 10), hasNext: true, total: 32 },
      { rows: rows(`${prefix}b`, 10), hasNext: true, total: 32 },
      { rows: rows(`${prefix}c`, 10), hasNext: true, total: 32 },
      { rows: rows(`${prefix}d`, 2), hasNext: false, total: 32 },
    ],
    [TAB_SUB]: [{ rows: [], hasNext: false, total: 0 }],
  };
}

function makeFakeFactory(script) {
  let idx = 0;
  const calls = { opener: 0, readView: 0, close: 0, click: 0, adClicks: 0, switchView: 0 };
  const browsers = [];
  const opener = async () => {
    calls.opener += 1;
    const entry = script[Math.min(idx, script.length - 1)];
    idx += 1;
    if (entry && entry.throw) throw entry.throw;
    const cfg = entry || {};
    const browser = { closed: false, hanging: [] };
    browsers.push(browser);
    const assertOpen = () => { if (browser.closed) throw new Error('Target page/context has been closed'); };
    const page = { browser: () => browser, evaluate: async () => null };
    const perTab = {};
    const controller = {
      async verifyIdentity() {
        assertOpen();
        if (cfg.identityFail) return { ok: false, reason: '页面店铺身份不匹配' };
        return { ok: true, pageShopId: cfg.shopId || SHOP_A.id, pageShopName: cfg.shopId || SHOP_A.id };
      },
      async refreshView({ tab }) {
        assertOpen();
        if (cfg.refreshError) throw new DataGuardError(cfg.refreshError);
        return { refreshed: true };
      },
      async switchView() { assertOpen(); calls.switchView += 1; },
      async readView({ tab }) {
        assertOpen();
        calls.readView += 1;
        if (cfg.hangRead && calls.readView === 1) {
          return new Promise((_, reject) => browser.hanging.push({ reject }));
        }
        if (cfg.readDelayMs && calls.readView === 1) await sleep(cfg.readDelayMs);
        const pages = (cfg.views && cfg.views[tab]) || [{ rows: [], hasNext: false, total: 0 }];
        const i = Math.min(perTab[tab] || 0, pages.length - 1);
        perTab[tab] = (perTab[tab] || 0) + 1;
        const p = pages[i];
        const total = p.total !== undefined ? p.total : pages.reduce((n, x) => n + x.rows.length, 0);
        return {
          rows: { rows: p.rows.map((r) => ({ ...r })) },
          pagination: {
            total,
            hasNext: p.hasNext === undefined ? false : p.hasNext,
            activePage: String(i + 1),
          },
        };
      },
      async clickNextPage() { assertOpen(); calls.click += 1; return { clicked: true }; },
      async clickBatchPause() { calls.adClicks += 1; return {}; },
      async clickBatchEnable() { calls.adClicks += 1; return {}; },
      async clickRowSwitch() { calls.adClicks += 1; return {}; },
    };
    browser.close = async () => {
      calls.close += 1;
      if (cfg.closeMode === 'never') return new Promise(() => {});
      if (cfg.closeMode === 'reject') {
        for (const x of browser.hanging.splice(0)) x.reject(new Error('Target page/context has been closed'));
        throw new Error('模拟会话关闭失败');
      }
      browser.closed = true;
      for (const x of browser.hanging.splice(0)) x.reject(new Error('Target page/context has been closed'));
    };
    return { browser, page, controller, account: null, context: null, cookieSession: null };
  };
  return { opener, calls, browsers };
}

/**
 * 真实适配器失败路径夹具：openHome 已创建浏览器，但导航停留在登录地址。
 * closeMode='ok'  → browser.close() 成功，isConnected() 变 false（正向证明）；
 * closeMode='reject' → browser.close() 拒绝，isConnected() 仍 true（反向证明）。
 * openChengfangShop 的 catch 会调用真实 closeBrowser 后再独立核对连接事实。
 * closeMode 可在测试中翻转（setCloseMode），模拟同一浏览器后续关闭终于成功的跨周期场景。
 */
function makeNavFailureHome({ closeMode = 'ok' } = {}) {
  let connected = true;
  const mode = { closeMode };
  const browser = {
    isConnected: () => connected,
    close: async () => {
      if (mode.closeMode === 'reject') throw new Error('mock browser.close rejected');
      connected = false;
    },
  };
  const target = {
    async waitForTimeout() {},
    getByText() { return { first: () => ({ click: async () => {} }) }; },
    async evaluate() { return { url: 'https://business.oceanengine.com/login', hasSubTabs: false }; },
    async waitForFunction() {},
  };
  const openHome = async () => ({ browser, context: {}, target, cookieSession: {} });
  return { openHome, browser, isConnected: () => connected, setCloseMode: (m) => { mode.closeMode = m; } };
}

/** 通过真实 openChengfangShop 失败路径产生错误，返回 { error, nav }。 */
async function runRealNavFailure(shopCfg, opts = {}) {
  const nav = makeNavFailureHome(opts);
  let error = null;
  try {
    await openChengfangShop({
      loginCfg: {},
      shopCfg,
      openHome: nav.openHome,
      sessionCheckpoint: async () => ({ saved: false, skipped: true }),
    });
  } catch (e) {
    error = e;
  }
  assert.ok(error, '导航失败必须抛出原始错误');
  return { error, nav };
}

function buildMonitor({ dataDir, openerFn, timeoutMs = 400, closeWaitMs = 200, settleWaitMs = 200, readAdState = null }) {
  const cfgResult = makeCfgResult({
    shops: [SHOP_A, SHOP_B],
    monitor: {
      chengfang: {
        scope: [TAB_MAIN, TAB_SUB],
        adStateReadTimeoutMs: timeoutMs,
        adStateCloseWaitMs: closeWaitMs,
        adStateSettleWaitMs: settleWaitMs,
      },
    },
  });
  return new Monitor(cfgResult, null, { dataDir, chengfangOpener: openerFn, readAdState });
}

function auditEvents(dataDir) {
  const p = path.join(dataDir, 'audit.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

test('T1 32vs31 首轮不一致 → 同一周期一次有界只读重读 → 32/32 恢复 on（零点击）', async () => {
  const dataDir = makeTempDir('usr-t1-');
  const fake = makeFakeFactory([
    { shopId: SHOP_A.id, views: inconsistentViews('a') },
    { shopId: SHOP_A.id, views: fullViews('b') },
  ]);
  const mon = buildMonitor({ dataDir, openerFn: fake.opener });
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'on', JSON.stringify(r.error || r));
  assert.equal(r.error, undefined);
  assert.equal(fake.calls.opener, 2, '只允许一次额外完整重读');
  assert.equal(fake.calls.adClicks, 0, '重读不得点击任何开关');
  assert.equal(fake.browsers[0].closed, true, '首轮会话必须严格关闭后才允许重读');
  const evs = auditEvents(dataDir).filter((j) => j.kind === 'ad-state-read');
  assert.ok(evs.some((j) => j.event === 'retry'), '必须留下 retry 审计');
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), null, '恢复后不得留下阻断门');
});

test('T2 稳定 32vs31 → 两次后保留有原因 unknown，零点击、不无限重试', async () => {
  const dataDir = makeTempDir('usr-t2-');
  const fake = makeFakeFactory([
    { shopId: SHOP_A.id, views: inconsistentViews('a') },
    { shopId: SHOP_A.id, views: inconsistentViews('b') },
    { shopId: SHOP_A.id, views: fullViews('c') },
  ]);
  const mon = buildMonitor({ dataDir, openerFn: fake.opener });
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown');
  assert.equal(r.error.retried, true);
  assert.match(r.error.reason, /末页已读行数 31 与 total 32 不一致/);
  assert.match(r.error.reason, /已重试1次仍未恢复/);
  assert.equal(fake.calls.opener, 2, '最多两次（首读 + 一次重读）');
  assert.equal(fake.calls.adClicks, 0);
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), null);
});

test('T3 导航未稳定且真实适配器证明已严格关闭 → 仅一次新 session 重读成功；不是登录失效', async () => {
  const dataDir = makeTempDir('usr-t3-');
  const ok = makeFakeFactory([{ shopId: SHOP_A.id, views: fullViews('b') }]);
  let openerCalls = 0;
  let navError = null;
  const mon = buildMonitor({
    dataDir,
    openerFn: async (args) => {
      openerCalls += 1;
      if (openerCalls === 1) {
        const r = await runRealNavFailure(args.shopCfg, { closeMode: 'ok' });
        navError = r.error;
        throw r.error;
      }
      return ok.opener(args);
    },
  });
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'on', JSON.stringify(r.error || r));
  assert.equal(openerCalls, 2, '只有关闭证明成立才允许一次重读');
  assert.match(navError.message, /导航"乘方"未到达管理页/, '原始错误必须原样保留');
  assert.deepEqual(
    readChengfangCleanupEvidence(navError),
    { attempted: true, closed: true, source: 'browser.isConnected' },
    '证据必须来自真实适配器失败路径的关闭后连接核对',
  );
  assert.equal(ok.calls.adClicks, 0);
});

test('T3b 导航失败但真实关闭被拒绝 → 无严格关闭证明，不重读、不假登录失效', async () => {
  const dataDir = makeTempDir('usr-t3b-');
  let openerCalls = 0;
  let navError = null;
  const mon = buildMonitor({
    dataDir,
    openerFn: async (args) => {
      openerCalls += 1;
      const r = await runRealNavFailure(args.shopCfg, { closeMode: 'reject' });
      navError = r.error;
      throw r.error;
    },
  });
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown');
  assert.equal(openerCalls, 1, '关闭未被证明时不得启动第二次读取');
  assert.equal(r.error.blockedBy, 'unread_session');
  assert.match(r.error.reason, /未获得严格关闭证明/);
  assert.match(r.error.reason, /导航"乘方"未到达管理页/, '原始错误原因必须可见');
  assert.notEqual(r.error.blocked, 'auth', '缺关闭证明不得冒充登录失效');
  assert.deepEqual(
    readChengfangCleanupEvidence(navError),
    { attempted: true, closed: false, source: 'browser.isConnected' },
  );
});

test('T3c 无任何关闭证明的 opener throw（普通 Error）→ 不重读，保持有原因 unknown', async () => {
  const dataDir = makeTempDir('usr-t3c-');
  let openerCalls = 0;
  const mon = buildMonitor({
    dataDir,
    openerFn: async () => {
      openerCalls += 1;
      throw new DataGuardError('导航"乘方"未到达管理页（当前 https://business.oceanengine.com/login）');
    },
  });
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown');
  assert.equal(openerCalls, 1, '没有关闭证明不得重读');
  assert.equal(r.error.blockedBy, 'unread_session');
  assert.match(r.error.reason, /未获得严格关闭证明/);
});

test('T4 持续 Auth → 不盲试第二次；分类 auth（只有正式登录检测可要求扫码）', async () => {
  const dataDir = makeTempDir('usr-t4-');
  const fake = makeFakeFactory([
    { throw: new AuthError('登录失效：持续命中登录页地址或可见登录控件，请重新扫码登录') },
    { shopId: SHOP_A.id, views: fullViews('b') },
  ]);
  const mon = buildMonitor({ dataDir, openerFn: fake.opener });
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown');
  assert.equal(r.error.blocked, 'auth');
  assert.equal(mon._readErrorKind(r.error), 'auth');
  assert.equal(fake.calls.opener, 1, 'Auth 不得重试');
});

test('T5 关闭失败/超时未收口 → 不启动第二次；且只阻断本店，B 店仍可读', async () => {
  const dataDir = makeTempDir('usr-t5-');
  const fakeA = makeFakeFactory([{ shopId: SHOP_A.id, views: fullViews('a'), hangRead: true, closeMode: 'reject' }]);
  const fakeB = makeFakeFactory([{ shopId: SHOP_B.id, views: fullViews('b') }]);
  const mon = buildMonitor({
    dataDir,
    openerFn: async (args) => (args.shopCfg.id === SHOP_A.id ? fakeA.opener(args) : fakeB.opener(args)),
    timeoutMs: 250,
    settleWaitMs: 200,
    closeWaitMs: 150,
  });
  const r1 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r1.error.timeout, true);
  assert.equal(r1.error.cleanup, 'blocked');
  const openerAfter = fakeA.calls.opener;
  const r2 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r2.error.blockedBy, 'unread_session');
  assert.equal(fakeA.calls.opener, openerAfter, '未收口前不得开新 session');
  const rB = await mon._readCurrentAdState(SHOP_B);
  assert.equal(rB.state, 'on', JSON.stringify(rB.error || rB));
  assert.equal(fakeB.calls.opener, 1, 'B 店不得被 A 店的收口门阻塞');
});

test('T6 共享总期限与次数可控：首读耗时后重读只用剩余预算，总数不超过 2', async () => {
  const dataDir = makeTempDir('usr-t6-');
  const fake = makeFakeFactory([
    { shopId: SHOP_A.id, views: inconsistentViews('a'), readDelayMs: 150 },
    { shopId: SHOP_A.id, views: fullViews('b'), readDelayMs: 150 },
  ]);
  const mon = buildMonitor({ dataDir, openerFn: fake.opener, timeoutMs: 400, closeWaitMs: 100 });
  const t0 = Date.now();
  const r = await mon._readCurrentAdState(SHOP_A);
  const elapsed = Date.now() - t0;
  assert.ok(fake.calls.opener <= 2, `opener=${fake.calls.opener}`);
  assert.ok(elapsed < 1200, `elapsed=${elapsed}`);
  assert.ok(r.state === 'on' || (r.error && r.error.timeout === true), JSON.stringify(r));
  const starts = auditEvents(dataDir).filter((j) => j.kind === 'ad-state-read' && j.event === 'start');
  assert.ok(starts.length <= 2);
  if (starts.length === 2) assert.ok(starts[1].timeoutMs <= 400, `remaining=${starts[1].timeoutMs}`);
});

test('T7 refreshShopData：注入 error 不丢；新 Auth 撤销旧 on；新因覆盖旧因；成功清除', async () => {
  const dataDir = makeTempDir('usr-t7-');
  let mode = 'auth';
  const controller = makeStatefulController({ identity: { id: SHOP_A.id, name: SHOP_A.name }, ads: [] });
  const reader = makeLinkedReader(controller, {
    costCents: 123, orders: 3, pageSource: 'promo-page',
    costShopId: SHOP_A.id, orderShopId: SHOP_A.id, adsShopId: SHOP_A.id,
  });
  const mon = buildMonitor({
    dataDir,
    openerFn: async () => { throw new Error('本用例注入 readAdState，不应打开页面'); },
    readAdState: async () => {
      if (mode === 'auth') throw new AuthError('登录失效：持续登录页，请重新扫码登录');
      if (mode === 'nav') return { state: 'unknown', error: { status: 'blocked', reason: '导航"乘方"未到达管理页', blocked: 'inventory' }, switchEvidence: { kind: 'test' } };
      return { state: 'on', identity: { ok: true }, rows: [{ id: 'p1', switchChecked: true }] };
    },
  });
  mon.adapters = { reader, controller };
  mon._injectedReader = reader;
  mon._injectedController = controller;
  mon.config.shops = [SHOP_A];
  mon.adBelief[SHOP_A.id] = { on: true, at: new Date().toISOString(), evidence: '旧 on 证据' };
  mon._applyConfirmedAdState(SHOP_A.id, 'on', new Date().toISOString(), '旧 on 证据');

  const r1 = await mon.refreshShopData(SHOP_A.id);
  assert.equal(r1.ok, true);
  assert.equal(r1.adState, 'unknown');
  assert.equal(r1.blocked, 'auth');
  assert.match(r1.reason, /登录失效/);
  assert.equal(mon._runtime(SHOP_A.id).adStateConfirmedAt, null, '旧 on 确认时间必须撤销');
  assert.equal(mon.adBelief[SHOP_A.id], undefined, 'Auth 失败撤销旧 adBelief');
  assert.equal(mon._runtime(SHOP_A.id).lastReadError.kind, 'auth');
  assert.equal(mon._runtime(SHOP_A.id).lastData.blockedReason, r1.reason, '最新 Auth 错误写入 today.blockedReason');

  mode = 'nav';
  const r2 = await mon.refreshShopData(SHOP_A.id);
  assert.equal(r2.blocked, 'inventory');
  assert.match(r2.reason, /导航"乘方"未到达管理页/);
  assert.equal(mon._runtime(SHOP_A.id).lastError, r2.reason, '新错误覆盖旧 lastError');
  assert.equal(mon._runtime(SHOP_A.id).lastData.blockedReason, r2.reason, '新错误覆盖旧 today.blockedReason');
  assert.equal(mon._runtime(SHOP_A.id).lastReadError.kind, 'read_failed', '导航失败不得冒充登录失效');

  mode = 'ok';
  const r3 = await mon.refreshShopData(SHOP_A.id);
  assert.equal(r3.ok, true);
  assert.equal(r3.adState, 'on');
  assert.equal(mon._runtime(SHOP_A.id).lastError, null, '成功同店新回读清除错误');
  assert.equal(mon._runtime(SHOP_A.id).lastData.blockedReason, undefined);
  assert.equal(mon._runtime(SHOP_A.id).lastReadError, null);
  assert.equal(mon._runtime(SHOP_A.id).lastAdState, 'on');
});

test('T8 注入对象保留 error/switchEvidence（不被丢成无原因 unknown）', async () => {
  const dataDir = makeTempDir('usr-t8-');
  const mon = buildMonitor({
    dataDir,
    openerFn: async () => { throw new Error('不应打开页面'); },
    readAdState: async () => ({
      state: 'on',
      error: { status: 'blocked', reason: '清单末页行数与 total 不一致', blocked: 'inventory' },
      switchEvidence: { kind: 'unrecognized_switches', rowsTotal: 2 },
      rows: [{ id: 'x', switchChecked: true }],
    }),
  });
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown', '带 error 时不得保留 on');
  assert.equal(r.error.reason, '清单末页行数与 total 不一致');
  assert.deepEqual(r.switchEvidence, { kind: 'unrecognized_switches', rowsTotal: 2 });
});

test('T9 现有保护不回退：身份失败/重复 ID 不重试，分页严格结束仍生效', async () => {
  {
    const dataDir = makeTempDir('usr-t9a-');
    const fake = makeFakeFactory([
      { shopId: SHOP_A.id, views: fullViews('a'), identityFail: true },
      { shopId: SHOP_A.id, views: fullViews('b') },
    ]);
    const mon = buildMonitor({ dataDir, openerFn: fake.opener });
    const r = await mon._readCurrentAdState(SHOP_A);
    assert.equal(r.error.blocked, 'identity');
    assert.equal(fake.calls.opener, 1, '身份失败不得重试');
  }
  {
    const dataDir = makeTempDir('usr-t9b-');
    const dup = {
      [TAB_MAIN]: [
        { rows: [{ id: 'same', switchChecked: true }], hasNext: true, total: 2 },
        { rows: [{ id: 'same', switchChecked: true }], hasNext: false, total: 2 },
      ],
      [TAB_SUB]: [{ rows: [], hasNext: false, total: 0 }],
    };
    const fake = makeFakeFactory([
      { shopId: SHOP_A.id, views: dup },
      { shopId: SHOP_A.id, views: fullViews('b') },
    ]);
    const mon = buildMonitor({ dataDir, openerFn: fake.opener });
    const r = await mon._readCurrentAdState(SHOP_A);
    assert.match(r.error.reason, /计划 ID 跨页重复/);
    assert.equal(fake.calls.opener, 1, '重复 ID 不得重试');
  }
  {
    const dataDir = makeTempDir('usr-t9c-');
    const bad = {
      [TAB_MAIN]: [{ rows: [{ id: 'p1', switchChecked: true }], hasNext: null, total: 1 }],
      [TAB_SUB]: [{ rows: [], hasNext: false, total: 0 }],
    };
    const fake = makeFakeFactory([{ shopId: SHOP_A.id, views: bad }]);
    const mon = buildMonitor({ dataDir, openerFn: fake.opener });
    const r = await mon._readCurrentAdState(SHOP_A);
    assert.match(r.error.reason, /分页结束标记不明确/);
    assert.equal(fake.calls.opener, 1);
  }
});

test('T10 跨周期：无句柄未知 opener 失败 → 连续两次调用也只启动一次 opener（持久收口门，跨店隔离）', async () => {
  const dataDir = makeTempDir('usr-t10-');
  let openerCalls = 0;
  const fakeB = makeFakeFactory([{ shopId: SHOP_B.id, views: fullViews('b') }]);
  const mon = buildMonitor({
    dataDir,
    openerFn: async (args) => {
      if (args.shopCfg.id === SHOP_B.id) return fakeB.opener(args);
      openerCalls += 1;
      // 普通 Error：既无关闭证据也无收口句柄，属未知失败
      throw new Error('导航"乘方"未到达管理页（当前 https://business.oceanengine.com/login）');
    },
  });
  const r1 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r1.state, 'unknown');
  assert.equal(openerCalls, 1, '首次失败内不得二次读取');
  assert.equal(r1.error.blockedBy, 'unread_session');
  assert.ok(mon._pendingReadGateFor(SHOP_A.id), '无关闭证明的瞬态失败必须登记按店持久收口门');
  const r2 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r2.state, 'unknown');
  assert.equal(r2.error.blockedBy, 'unread_session');
  assert.match(r2.error.reason, /收口句柄/);
  assert.equal(openerCalls, 1, '下一周期不得静默遗忘未证明的关闭再开 opener');
  assert.ok(mon._pendingReadGateFor(SHOP_A.id), '缺句柄时门必须保持（保守阻断）');
  const rB = await mon._readCurrentAdState(SHOP_B);
  assert.equal(rB.state, 'on', JSON.stringify(rB.error || rB));
  assert.equal(fakeB.calls.opener, 1, 'A 店收口门不得阻塞 B 店');
});

test('T11 跨周期：真实适配器导航失败 close 拒绝 → 凭收口句柄推进关闭，成功后自动清门并从新 session 读取成功', async () => {
  const dataDir = makeTempDir('usr-t11-');
  const nav = makeNavFailureHome({ closeMode: 'reject' });
  const ok = makeFakeFactory([{ shopId: SHOP_A.id, views: fullViews('b') }]);
  const fakeB = makeFakeFactory([{ shopId: SHOP_B.id, views: fullViews('c') }]);
  let openerCalls = 0;
  const mon = buildMonitor({
    dataDir,
    openerFn: async (args) => {
      if (args.shopCfg.id === SHOP_B.id) return fakeB.opener(args);
      openerCalls += 1;
      if (openerCalls === 1) {
        // 第一次：走真实 openChengfangShop 失败路径（close 拒绝 → 无证明 + 有句柄）
        await openChengfangShop({
          loginCfg: {},
          shopCfg: args.shopCfg,
          openHome: nav.openHome,
          sessionCheckpoint: async () => ({ saved: false, skipped: true }),
        });
        throw new Error('不可达：openChengfangShop 导航失败必须抛出');
      }
      return ok.opener(args);
    },
  });
  const r1 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r1.state, 'unknown');
  assert.equal(r1.error.blockedBy, 'unread_session');
  assert.match(r1.error.reason, /导航"乘方"未到达管理页/, '原始错误原文必须保留');
  assert.equal(openerCalls, 1);
  const gate = mon._pendingReadGateFor(SHOP_A.id);
  assert.ok(gate, 'close 拒绝的失败必须登记持久收口门');
  assert.ok(gate.cleanupHandle, '真实适配器必须移交收口句柄（WeakMap，不可序列化）');
  assert.equal(gate.sessionRef(), null, '无会话门绝不携带会话引用');

  // 第二次调用：close 仍拒绝 → 先推进真实关闭，仍未证明 → 不新开 opener
  const r2 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r2.state, 'unknown');
  assert.equal(r2.error.blockedBy, 'unread_session');
  assert.match(r2.error.reason, /收口句柄/);
  assert.equal(openerCalls, 1, 'close 仍拒绝时不得启动新 session');
  assert.equal(nav.isConnected(), true, '推进尝试不得伪造关闭事实');

  // 同一假 browser 的 close 恢复可成功 → 后续调用自动推进关闭 → 清门 → 新 session 正常读取
  nav.setCloseMode('ok');
  const r3 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r3.state, 'on', JSON.stringify(r3.error || r3));
  assert.equal(openerCalls, 2, '只有真实关闭被证明后才允许下一次读取');
  assert.equal(nav.isConnected(), false, '本次失败浏览器必须由 Monitor 凭句柄真实关闭');
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), null, '关闭成功后不得残留收口门');
  assert.equal(ok.calls.adClicks, 0, '全程零广告点击');
  const rB = await mon._readCurrentAdState(SHOP_B);
  assert.equal(rB.state, 'on', JSON.stringify(rB.error || rB));
  assert.equal(fakeB.calls.opener, 1, '跨店隔离：A 店收口门全程未阻塞 B 店');
  assert.equal(fakeB.calls.adClicks, 0);
});
