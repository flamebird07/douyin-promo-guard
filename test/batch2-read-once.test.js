'use strict';

/**
 * 批次二（PROMO-IMPL-D1）改动二回归：读门收敛为「单次读 + 有界关闭 + 失败重试一次」。
 *  - 每次读取独立浏览器；整次读取单一 deadline；
 *  - try/finally 有界关闭（默认 60s，可在测试中缩短）；
 *  - 瞬态失败只重试一次，之后不再有后台恢复链；
 *  - 关闭失败只记日志，不再登记跨周期收口门；下一次读取照常发起新会话。
 * 不访问真实页面/CDP/网络：全部为注入的假 opener/controller + 临时目录。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor.js');
const { AuthError } = require('../src/lib/errors.js');
const { makeTempDir, makeCfgResult } = require('./helpers.js');

const TAB_MAIN = '全店托管';
const TAB_SUB = '商品自选';
const SHOP = { id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true };

function rows(prefix, count, checked = true) {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i + 1}`, switchChecked: checked }));
}

/** 32/31 不一致（瞬态可重读）。 */
function inconsistentViews(prefix) {
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

/** 32/32 完整（读取成功）。 */
function fullViews(prefix) {
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

/**
 * 假 opener：
 *  - openViews(openNo) 决定第 N 个会话返回的清单；
 *  - hangReadOn(openNo) 为真时首个 readView 永不返回；
 *  - authOn(openNo) 为真时 opener 直接抛 AuthError；
 *  - closeMode 'ok' | 'reject' | 'never'。
 */
function makeFake({ openViews = () => fullViews('s'), hangReadOn = () => false, authOn = () => false, closeMode = 'ok' } = {}) {
  const calls = { opener: 0, readView: 0, close: 0, clicks: 0 };
  const browsers = [];
  const opener = async (args) => {
    calls.opener += 1;
    const openNo = calls.opener;
    if (authOn(openNo)) throw new AuthError('登录失效：持续命中登录页地址或可见登录控件，请重新扫码登录');
    const browser = { closed: false };
    browsers.push(browser);
    const perTab = {};
    let held = false;
    const assertOpen = () => { if (browser.closed) throw new Error('Target page/context has been closed'); };
    const controller = {
      async verifyIdentity() { assertOpen(); return { ok: true, pageShopId: args.shopCfg.id, pageShopName: args.shopCfg.id }; },
      async refreshView() { assertOpen(); return { refreshed: true }; },
      async switchView() { assertOpen(); },
      async readView({ tab }) {
        assertOpen();
        calls.readView += 1;
        if (!held && hangReadOn(openNo)) { held = true; return new Promise(() => {}); }
        const pages = (openViews(openNo) || {})[tab] || [{ rows: [], hasNext: false }];
        const i = Math.min(perTab[tab] || 0, pages.length - 1);
        perTab[tab] = (perTab[tab] || 0) + 1;
        const p = pages[i];
        const sum = pages.reduce((n, pg) => n + pg.rows.length, 0);
        const total = p.total != null ? p.total : sum;
        return { rows: { rows: p.rows.map((r) => ({ ...r })) }, pagination: { total, hasNext: p.hasNext === true, activePage: String(i + 1) } };
      },
      async clickNextPage() { assertOpen(); return { clicked: true }; },
      async clickBatchPause() { calls.clicks += 1; return {}; },
      async clickBatchEnable() { calls.clicks += 1; return {}; },
      async clickRowSwitch() { calls.clicks += 1; return {}; },
    };
    const browserObj = {
      close: async () => {
        calls.close += 1;
        if (closeMode === 'never') return new Promise(() => {});
        if (closeMode === 'reject') throw new Error('mock browser.close rejected');
        browser.closed = true;
      },
    };
    const page = { browser: () => browserObj, evaluate: async () => null };
    return { browser: browserObj, page, controller, account: null, context: null, cookieSession: null };
  };
  return { opener, calls, browsers };
}

function buildMonitor({ dataDir, opener, timeoutMs = 2000, closeWaitMs = 40 }) {
  const cfgResult = makeCfgResult({
    shops: [{ ...SHOP }],
    monitor: {
      legacyWholeShopCloseEnabled: true,
      chengfang: {
        scope: [TAB_MAIN, TAB_SUB],
        adStateReadTimeoutMs: timeoutMs,
        adStateCloseWaitMs: closeWaitMs,
        adStateSettleWaitMs: 30,
      },
    },
  });
  return new Monitor(cfgResult, null, { dataDir, chengfangOpener: opener });
}

function auditEvents(dataDir) {
  const p = path.join(dataDir, 'audit.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

test('B2R-1 瞬态失败：恰好重试一次（物理读取 2 次），无后台恢复链/无门状态', async () => {
  const dataDir = makeTempDir('b2r-1-');
  const fake = makeFake({ openViews: () => inconsistentViews('f') });
  const mon = buildMonitor({ dataDir, opener: fake.opener });

  const r = await mon._readCurrentAdState(SHOP);
  assert.equal(r.state, 'unknown');
  assert.equal(r.error.retried, true);
  assert.equal(r.error.retryCount, 1);
  assert.match(r.error.reason, /已重试1次仍未恢复/);
  assert.equal(fake.calls.opener, 2, '首读 + 一次重读');

  assert.equal(mon._readRecoveries, undefined, '恢复链状态必须已删除');
  assert.equal(mon._pendingReadGates, undefined, '读门登记簿必须已删除');
  assert.equal(mon._readPermits, undefined, '读取许可队列必须已删除');

  await new Promise((res) => setTimeout(res, 60));
  assert.equal(fake.calls.opener, 2, '不得再有后台链重试');
  assert.equal(fake.calls.clicks, 0, '零广告点击');
});

test('B2R-2 首次瞬态失败、重试成功：不残留任何进度/门状态', async () => {
  const dataDir = makeTempDir('b2r-2-');
  const fake = makeFake({
    openViews: (n) => (n === 1 ? inconsistentViews('f') : fullViews('s')),
  });
  const mon = buildMonitor({ dataDir, opener: fake.opener });

  const r = await mon._readCurrentAdState(SHOP);
  assert.equal(r.state, 'on', JSON.stringify(r.error || r));
  assert.equal(r.error, undefined);
  assert.equal(fake.calls.opener, 2);
  assert.equal(mon._runtime(SHOP.id).lastReadError, null);
  assert.equal(mon._readRecoveries, undefined);
  assert.equal(mon._pendingReadGates, undefined);
});

test('B2R-3 不可重试错误（Auth）：只读一次，不做盲目重试', async () => {
  const dataDir = makeTempDir('b2r-3-');
  const fake = makeFake({ authOn: () => true });
  const mon = buildMonitor({ dataDir, opener: fake.opener });

  const r = await mon._readCurrentAdState(SHOP);
  assert.equal(r.state, 'unknown');
  assert.equal(r.error.blocked, 'auth');
  assert.equal(fake.calls.opener, 1, 'Auth 不得自动重试');
});

test('B2R-4 关闭失败：有界返回（不无限等待）、记日志、下一次读取照常开新会话', async () => {
  const dataDir = makeTempDir('b2r-4-');
  const fake = makeFake({ hangReadOn: () => true, closeMode: 'reject' });
  const mon = buildMonitor({ dataDir, opener: fake.opener, timeoutMs: 120, closeWaitMs: 30 });

  const t0 = Date.now();
  const r1 = await mon._readCurrentAdState(SHOP);
  const elapsed = Date.now() - t0;
  assert.equal(r1.error.timeout, true, JSON.stringify(r1.error));
  assert.equal(r1.error.cleanup, 'blocked');
  assert.ok(fake.calls.close >= 1, '会话必须尝试关闭');
  assert.ok(elapsed < 2000, `有界关闭不得无限等待，elapsed=${elapsed}ms`);
  assert.equal(fake.browsers[0].closed, false, 'close 拒绝不得冒充已关闭');

  // 不再有收口门：下一次读取直接发起新会话（同店互斥由上层负责）
  const fake2 = makeFake({ openViews: () => fullViews('s') });
  const mon2 = buildMonitor({ dataDir: makeTempDir('b2r-4b-'), opener: fake2.opener });
  const r2 = await mon2._readCurrentAdState(SHOP);
  assert.equal(r2.state, 'on', JSON.stringify(r2.error || r2));
  assert.equal(fake2.calls.opener, 1);
});

test('B2R-5 截止后迟到会话：仍被有界关闭（不留无人管理浏览器）', async () => {
  const dataDir = makeTempDir('b2r-5-');
  const fake = makeFake({ openViews: () => fullViews('s'), closeMode: 'ok' });
  let openerCalls = 0;
  const mon = buildMonitor({
    dataDir,
    timeoutMs: 120,
    closeWaitMs: 30,
    opener: async (args) => {
      openerCalls += 1;
      if (openerCalls === 1) {
        await new Promise((r) => setTimeout(r, 250)); // 晚于 120ms 截止
      }
      return fake.opener(args);
    },
  });

  const r1 = await mon._readCurrentAdState(SHOP);
  assert.equal(r1.error.timeout, true, JSON.stringify(r1.error));
  await new Promise((r) => setTimeout(r, 350));
  assert.equal(fake.browsers[0].closed, true, '迟到会话必须被关闭');
  assert.equal(fake.calls.opener, 1);
});

test('B2R-6 有界关闭上界：默认 60000ms，close 永不完成时按 waitMs 返回', async () => {
  const dataDir = makeTempDir('b2r-6-');
  const cfgDefault = makeCfgResult({ shops: [{ ...SHOP }], monitor: { legacyWholeShopCloseEnabled: true } });
  const mon = new Monitor(cfgDefault, null, { dataDir, chengfangOpener: makeFake().opener });
  assert.equal(mon._adStateMsOption('adStateCloseWaitMs', 60000), 60000, '默认有界关闭 60s');

  const t0 = Date.now();
  const r = await mon._closeSessionBounded({ close: () => new Promise(() => {}) }, 30);
  const elapsed = Date.now() - t0;
  assert.equal(r.closed, false);
  assert.ok(elapsed >= 20 && elapsed < 1000, `关闭必须按 waitMs 有界返回，elapsed=${elapsed}ms`);
});

test('B2R-7 审计收敛：只保留 start/done/deadline/retry，无恢复链/读门事件', async () => {
  const dataDir = makeTempDir('b2r-7-');
  const fake = makeFake({ openViews: () => inconsistentViews('f') });
  const mon = buildMonitor({ dataDir, opener: fake.opener });
  await mon._readCurrentAdState(SHOP);

  const events = auditEvents(dataDir).filter((j) => j.kind === 'ad-state-read').map((j) => j.event);
  assert.ok(events.includes('start'), JSON.stringify(events));
  assert.ok(events.includes('done'), JSON.stringify(events));
  assert.ok(events.includes('retry'), JSON.stringify(events));
  for (const forbidden of ['gate-registered', 'gate-probe', 'gate-terminal', 'gate-released', 'recovery-scheduled', 'recovery-success', 'recovery-exhausted']) {
    assert.ok(!events.includes(forbidden), `不得再出现 ${forbidden}: ${JSON.stringify(events)}`);
  }
});
