'use strict';

/**
 * 批次二（PROMO-IMPL-D1）读门收敛后的回归：把原「分组有限恢复链」用例改写为
 * 「单次读 + 同一 deadline 内最多重试一次 + 无跨周期状态」语义。
 *
 * 旧语义（已删除）：首次失败后最多重试 10 次、每 2 次一组、组间等待 300000ms、
 * 按店恢复链 / 持久收口门 / 后台 timer。
 * 新语义：每次 _readCurrentAdState 独立浏览器；瞬态失败只重试一次；无 timer、无恢复链、
 * 无读门；关闭失败只影响本次结果（不作 on/off 证据），下一次读取照常新建会话。
 *
 * 不访问浏览器/CDP/网络/真实 Cookie。
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
const SHOP_A = { id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true };
const SHOP_B = { id: 'shop-b', name: 'shop-b', cookieFile: 'shop-b', accountId: null, enabled: true };

function rows(prefix, count, checked = true) {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i + 1}`, switchChecked: checked }));
}

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
 * 假 opener/controller：
 *  - failUntil：前 N 个 session 返回 32vs31 瞬态不一致，其后返回完整 32/32；
 *  - closeMode：'ok' | 'reject'（可翻转）。
 */
function makeFactory(opts = {}) {
  let failUntil = opts.failUntil == null ? Infinity : opts.failUntil;
  const closeMode = { value: opts.closeMode || 'ok' };
  const calls = { opener: 0, readView: 0, close: 0, adClicks: 0 };
  const openByShop = {};

  const opener = async (args) => {
    calls.opener += 1;
    const openNo = calls.opener;
    const shopOpen = (openByShop[args.shopCfg.id] = (openByShop[args.shopCfg.id] || 0) + 1);
    const failing = typeof failUntil === 'function'
      ? failUntil(args.shopCfg.id, shopOpen) === true
      : shopOpen <= failUntil;
    if (opts.authOn && opts.authOn(openNo)) {
      throw new AuthError('登录失效：持续命中登录页地址或可见登录控件，请重新扫码登录');
    }
    const browser = { closed: false };
    const page = { browser: () => browser, evaluate: async () => null };
    const perTab = {};
    const assertOpen = () => { if (browser.closed) throw new Error('Target page/context has been closed'); };
    const controller = {
      async verifyIdentity() {
        assertOpen();
        if (opts.identityFailOn && opts.identityFailOn(openNo)) {
          return { ok: false, reason: '页面店铺身份不匹配' };
        }
        return { ok: true, pageShopId: args.shopCfg.id, pageShopName: args.shopCfg.id };
      },
      async refreshView() { assertOpen(); return { refreshed: true }; },
      async switchView() { assertOpen(); },
      async readView({ tab }) {
        assertOpen();
        calls.readView += 1;
        const pages = (failing ? inconsistentViews(`f${openNo}`) : fullViews(`s${openNo}`))[tab]
          || [{ rows: [], hasNext: false, total: 0 }];
        const i = Math.min(perTab[tab] || 0, pages.length - 1);
        perTab[tab] = (perTab[tab] || 0) + 1;
        const p = pages[i];
        return {
          rows: { rows: p.rows.map((r) => ({ ...r })) },
          pagination: { total: p.total, hasNext: p.hasNext, activePage: String(i + 1) },
        };
      },
      async clickNextPage() { assertOpen(); return { clicked: true }; },
      async clickBatchPause() { calls.adClicks += 1; return {}; },
      async clickBatchEnable() { calls.adClicks += 1; return {}; },
      async clickRowSwitch() { calls.adClicks += 1; return {}; },
    };
    browser.close = async () => {
      calls.close += 1;
      if (closeMode.value === 'reject') throw new Error('mock browser.close rejected');
      browser.closed = true;
    };
    return { browser, page, controller };
  };

  return {
    opener,
    calls,
    setFailUntil(n) { failUntil = n; },
    setCloseMode(m) { closeMode.value = m; },
  };
}

function buildMonitor({ dataDir, opener, shops = [SHOP_A, SHOP_B] }) {
  const cfgResult = makeCfgResult({
    shops: shops.map((s) => ({ ...s })),
    monitor: {
      chengfang: {
        scope: [TAB_MAIN, TAB_SUB],
        adStateReadTimeoutMs: 3000,
        adStateCloseWaitMs: 30,
      },
    },
  });
  return new Monitor(cfgResult, null, { dataDir, chengfangOpener: opener });
}

function auditEvents(dataDir) {
  const p = path.join(dataDir, 'audit.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

test('G1 连续瞬态失败：物理读取=2（首读+重试1次），无恢复链/无timer/无读门状态', async () => {
  const dataDir = makeTempDir('grt-g1-');
  const fake = makeFactory({ failUntil: Infinity });
  const mon = buildMonitor({ dataDir, opener: fake.opener });

  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown');
  assert.equal(r.error.retried, true);
  assert.equal(r.error.retryCount, 1);
  assert.match(r.error.reason, /已重试1次仍未恢复/);
  assert.equal(fake.calls.opener, 2, '首读 + 恰好一次重读');
  assert.equal(fake.calls.adClicks, 0, '全程零广告点击');

  // 旧恢复链/读门/许可队列及其持久字段必须全部删除
  assert.equal(mon._readRecoveries, undefined);
  assert.equal(mon._pendingReadGates, undefined);
  assert.equal(mon._pendingReadGate, undefined);
  assert.equal(mon._readPermits, undefined);
  assert.equal(mon._cleanupRegistry, undefined);

  await new Promise((res) => setTimeout(res, 60));
  assert.equal(fake.calls.opener, 2, '不得再有后台链重试');
});

test('G2 第1次重试成功：不残留任何进度/错误状态', async () => {
  const dataDir = makeTempDir('grt-g2-');
  const fake = makeFactory({ failUntil: 1 });
  const mon = buildMonitor({ dataDir, opener: fake.opener });
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'on', JSON.stringify(r.error || r));
  assert.equal(r.error, undefined);
  assert.equal(fake.calls.opener, 2);
  assert.equal(mon._runtime(SHOP_A.id).lastReadError, null, '成功必须清旧读取错误');
  assert.equal(mon._readRecoveries, undefined);
});

test('G3 跨店独立：A 店瞬态失败不阻塞 B 店读取', async () => {
  const dataDir = makeTempDir('grt-g3-');
  const fake = makeFactory({ failUntil: (shopId) => shopId === SHOP_A.id });
  const mon = buildMonitor({ dataDir, opener: fake.opener });

  const rA = await mon._readCurrentAdState(SHOP_A);
  assert.equal(rA.state, 'unknown');
  const before = fake.calls.opener;
  const rB = await mon._readCurrentAdState(SHOP_B);
  assert.equal(rB.state, 'on', JSON.stringify(rB.error || rB));
  assert.equal(fake.calls.opener, before + 1, 'B 店只读取一次（自身首读成功）');
  assert.equal(fake.calls.adClicks, 0);
});

test('G4 重复调用不叠加后台链：每次都是独立的单次读+重试一次', async () => {
  const dataDir = makeTempDir('grt-g4-');
  const fake = makeFactory({ failUntil: Infinity });
  const mon = buildMonitor({ dataDir, opener: fake.opener });

  const r1 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r1.state, 'unknown');
  assert.equal(fake.calls.opener, 2);
  const r2 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r2.state, 'unknown');
  assert.equal(fake.calls.opener, 4, '第二次调用照常执行首读+重试一次，不合并后台链');
  await new Promise((res) => setTimeout(res, 60));
  assert.equal(fake.calls.opener, 4, '无后台 timer 追加读取');
});

test('G5 关闭拒绝：本次结果不作 on/off 证据；下一次读取照常新建会话（无持久门）', async () => {
  const dataDir = makeTempDir('grt-g5-');
  const fake = makeFactory({ failUntil: 0, closeMode: 'reject' });
  const mon = buildMonitor({ dataDir, opener: fake.opener });

  const r1 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r1.state, 'unknown');
  assert.equal(r1.error.blockedBy, 'unread_session');
  assert.match(r1.error.reason, /未获得严格关闭证明/);
  assert.equal(fake.calls.opener, 1, '首读成功，无需重试');

  const r2 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r2.error.blockedBy, 'unread_session');
  assert.equal(fake.calls.opener, 2, '无持久门：下一次读取自建新会话');

  fake.setCloseMode('ok');
  const r3 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r3.state, 'on', JSON.stringify(r3.error || r3));
  assert.equal(fake.calls.opener, 3);
  assert.equal(fake.calls.adClicks, 0);
});

test('G6 Auth/身份错误不盲试：opener 只一次，无重试/无残留状态', async () => {
  {
    const dataDir = makeTempDir('grt-g6a-');
    const fake = makeFactory({ authOn: () => true });
    const mon = buildMonitor({ dataDir, opener: fake.opener });
    const r = await mon._readCurrentAdState(SHOP_A);
    assert.equal(r.state, 'unknown');
    assert.equal(r.error.blocked, 'auth');
    assert.equal(fake.calls.opener, 1);
    assert.equal(mon._readRecoveries, undefined);
  }
  {
    const dataDir = makeTempDir('grt-g6b-');
    const fake = makeFactory({ failUntil: Infinity, identityFailOn: () => true });
    const mon = buildMonitor({ dataDir, opener: fake.opener });
    const r = await mon._readCurrentAdState(SHOP_A);
    assert.equal(r.error.blocked, 'identity');
    assert.equal(fake.calls.opener, 1);
    assert.equal(mon._readRecoveries, undefined);
  }
});

test('G7 状态投影不再包含旧 readRecovery 字段', async () => {
  const dataDir = makeTempDir('grt-g7-');
  const fake = makeFactory({ failUntil: Infinity });
  const mon = buildMonitor({ dataDir, opener: fake.opener });
  await mon._readCurrentAdState(SHOP_A);
  const status = mon.getStatus();
  const row = status.shops.find((s) => s.id === SHOP_A.id);
  assert.equal(row.readRecovery, undefined, '旧恢复进度投影必须删除');
  assert.equal(mon._readRecoveryView, undefined, '旧恢复视图方法必须删除');
});

test('G8 审计收敛：只有 start/done/retry，无 recovery-*/gate-* 事件', async () => {
  const dataDir = makeTempDir('grt-g8-');
  const fake = makeFactory({ failUntil: Infinity });
  const mon = buildMonitor({ dataDir, opener: fake.opener });
  await mon._readCurrentAdState(SHOP_A);
  const events = auditEvents(dataDir).filter((j) => j.kind === 'ad-state-read').map((j) => j.event);
  assert.ok(events.includes('start'), JSON.stringify(events));
  assert.ok(events.includes('done'), JSON.stringify(events));
  assert.ok(events.includes('retry'), JSON.stringify(events));
  for (const forbidden of ['gate-registered', 'gate-probe', 'gate-terminal', 'gate-released', 'recovery-scheduled', 'recovery-success', 'recovery-exhausted']) {
    assert.ok(!events.includes(forbidden), `不得再出现 ${forbidden}: ${JSON.stringify(events)}`);
  }
});
