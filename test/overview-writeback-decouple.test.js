'use strict';

/**
 * 第 1 项（2026-11-02）：概览与清单空态解耦 —— 写回验收。
 *
 * 规则：_pollShop 里 cost+orders 一旦解析成功，就必须**立即**写入 rt.today / shopRows；
 * 之后的「商品自选空态 / ad=unknown / 回读抛错 / 回读在途」只影响 adState 与开关动作，
 * 绝不允许把本轮已成功的 costCents/orders 吞掉或打成 null。
 *
 * 全部隔离：临时目录 + 合成假 Cookie + 注入 readAdState / coordinator / orchestrator；
 * 不启动浏览器/调度器，不访问网络，不读生产路径，不做任何真实开关动作。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Monitor } = require('../src/engine/monitor');
const { evaluateWholeShopCostPerOrder } = require('../src/engine/rules');
const { decideAdSwitchAction } = require('../src/engine/ad-switch-decision');
const { makeTempDir, writeTempCookie, makeCfgResult, makeClock, waitFor } = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');

const SHOP = { id: 'shop-overview', name: '概览店', cookieFile: '概览店', enabled: true };
const COST_CENTS = 1200;
const ORDERS = 3;

function overviewData(nowMs, { costCents = COST_CENTS, orders = ORDERS } = {}) {
  const fetchedAt = new Date(nowMs).toISOString();
  return {
    ok: true,
    rechecked: 0,
    cost: { source: 'mock', businessDate: '2026-11-02', fetchedAt, rawText: null, valueCents: costCents, pageUpdatedAt: null },
    orders: { source: 'mock', businessDate: '2026-11-02', fetchedAt, rawText: null, valueCount: orders, pageUpdatedAt: null },
    evaluation: evaluateWholeShopCostPerOrder({ costCents, orders, thresholdCents: 100 }),
  };
}

function setup(t, { readAdState, dataFactory } = {}) {
  const cookieDir = makeTempDir('pg-ow-cookies-');
  const dataDir = makeTempDir('pg-ow-data-');
  const cookieWorkDir = makeTempDir('pg-ow-work-');
  t.after(() => {
    const tempRoot = fs.realpathSync(os.tmpdir()) + path.sep;
    for (const dir of [cookieDir, dataDir, cookieWorkDir]) {
      assert.ok(fs.realpathSync(dir).startsWith(tempRoot), 'cleanup stays inside the test temp root');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  writeTempCookie(cookieDir, SHOP.cookieFile);
  const cfgResult = makeCfgResult({
    cookieDir,
    cookieWorkDir,
    shops: [SHOP],
    execution: { realMode: false, dryRun: true },
    monitor: { legacyWholeShopCloseEnabled: true },
  });
  const clock = makeClock(shanghaiMs('2026-11-02', '10:00'));

  const coord = {
    async readAndEvaluate() {
      return (dataFactory || overviewData)(clock.now());
    },
  };

  const switchOrchestrator = {
    evaluatePeriodic(p) {
      return decideAdSwitchAction({
        costCents: p.costCents,
        orders: p.orders,
        thresholdCents: p.thresholdCents,
        currentAdState: p.currentAdState,
        identityOk: p.identityOk === true,
      });
    },
    runSwitchAction() {
      throw new Error('测试注入：不得派发任何开关动作');
    },
    hasUnknownBlock: () => false,
    peek: () => null,
    pendingMixedReconcile: () => null,
    mixedInflightProof: () => ({ inflight: 0 }),
    reconcileMixedAndReoperate: () => null,
  };

  // 注入的 readAdState 收到 monitor 引用：可在「广告状态读取进行中」断言概览是否已先落盘，
  // 这是「概览与清单空态解耦」的直接证据（而不是事后靠 error 分支补写）。
  const monitorRef = { current: null };
  const monitor = new Monitor(cfgResult, { controller: { state: {} } }, {
    dataDir,
    nowFn: clock.nowFn,
    delayFn: clock.delayFn,
    readAdState: (shopCfg) => readAdState(shopCfg, monitorRef.current),
    switchOrchestrator,
  });
  monitor._getCoordinator = () => coord;
  monitorRef.current = monitor;

  return {
    monitor,
    clock,
    rt: monitor._runtime(SHOP.id),
    poll: () => monitor._pollShop(SHOP, { aborted: false, kind: 'pause' }, 'manual'),
  };
}

function todayRow(monitor) {
  return monitor.getStatus().shops.find((s) => s.id === SHOP.id);
}

test('商品自选空态/ad=unknown（回读 error）不得吞掉已成功概览', async (t) => {
  let duringRead = null;
  const { monitor, rt, poll } = setup(t, {
    readAdState: async (shopCfg, m) => {
      // 读取广告状态这一刻：概览必须已经落盘（立即写，不等清单/开关回读）
      duringRead = m._runtime(SHOP.id).lastData;
      return {
        state: 'unknown',
        error: { status: 'blocked', reason: '商品自选第 1 页 0 行且缺少空态证据', blocked: 'inventory' },
      };
    },
  });

  const res = await poll();
  assert.strictEqual(res.status, 'blocked');

  assert.ok(duringRead, '广告状态读取开始前概览已写入 rt.lastData');
  assert.strictEqual(duringRead.costCents, COST_CENTS, '进入清单读取前 cost 已是数字');
  assert.strictEqual(duringRead.orders, ORDERS, '进入清单读取前 orders 已是数字');

  const shop = todayRow(monitor);
  assert.strictEqual(shop.today.costCents, COST_CENTS, '概览费用不得因空态失败变 null');
  assert.strictEqual(shop.today.orders, ORDERS, '概览订单不得因空态失败变 null');
  assert.strictEqual(rt.lastData.costCents, COST_CENTS);

  const row = monitor.getStatus().shopRows.find((r) => r.id === SHOP.id);
  assert.strictEqual(row.costCents, COST_CENTS, 'shopRows 直接消费 rt.lastData，必须是数字');
  assert.strictEqual(row.orders, ORDERS);
  assert.strictEqual(row.adState, 'unknown', '空态失败只影响 adState');
});

test('广告状态回读外壳抛错（异常退出）也不得吞掉已成功概览', async (t) => {
  const { monitor, poll } = setup(t, { readAdState: async () => ({ state: 'on' }) });
  // 模拟真实风险：回读外壳（_withShopReadPermit / 有界回读）在 try 之外抛错，
  // 异常直接落到 _pollShop 的兜底 catch —— 旧实现会让 candidate 永远不提交，today 保持 null。
  monitor._readCurrentAdState = async () => { throw new Error('炸读：回读外壳异常'); };

  const res = await poll();
  assert.notStrictEqual(res.status, 'ok', '异常回读不得被包成成功');

  const row = monitor.getStatus().shopRows.find((r) => r.id === SHOP.id);
  assert.strictEqual(row.costCents, COST_CENTS, '抛错路径同样必须保留本轮概览');
  assert.strictEqual(row.orders, ORDERS);
});

test('广告状态回读在途时，概览已先落盘（立即写，不等清单）', async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  // 1200 分 / 12 单 = 100 分 = 阈值 → 合法零动作，测试只关心写回时机
  const { monitor, poll } = setup(t, {
    readAdState: () => pending,
    dataFactory: (now) => overviewData(now, { costCents: COST_CENTS, orders: 12 }),
  });

  const running = poll();
  await waitFor(() => {
    const row = monitor.getStatus().shopRows.find((r) => r.id === SHOP.id);
    return row.costCents === COST_CENTS;
  }, 2000, '在途期间概览已写入 shopRows');

  const midRow = monitor.getStatus().shopRows.find((r) => r.id === SHOP.id);
  assert.strictEqual(midRow.costCents, COST_CENTS);
  assert.strictEqual(midRow.orders, 12);
  assert.strictEqual(midRow.refreshing, true, '在途仍如实标记刷新中，不把半轮当完成态');

  release({ state: 'on', rows: [{ id: 'p1', switchChecked: true }], identity: { ok: true }, balance: null });
  const res = await running;
  assert.strictEqual(res.status, 'ok');

  const row = monitor.getStatus().shopRows.find((r) => r.id === SHOP.id);
  assert.strictEqual(row.costCents, COST_CENTS);
  assert.strictEqual(row.orders, 12);
  assert.strictEqual(row.adState, 'on');
  assert.strictEqual(row.refreshing, false);
});

test('概览本身失败时不得伪造数字（对照组）', async (t) => {
  const { monitor, poll } = setup(t, {
    dataFactory: () => ({
      ok: false,
      blocked: 'identity',
      reason: '店铺身份不一致',
      cost: { source: 'mock', businessDate: '2026-11-02', fetchedAt: new Date(shanghaiMs('2026-11-02', '10:00')).toISOString(), valueCents: undefined },
      orders: { source: 'mock', businessDate: '2026-11-02', fetchedAt: new Date(shanghaiMs('2026-11-02', '10:00')).toISOString(), valueCount: undefined },
    }),
    readAdState: async () => ({ state: 'on' }),
  });

  const res = await poll();
  assert.strictEqual(res.status, 'blocked');
  const row = monitor.getStatus().shopRows.find((r) => r.id === SHOP.id);
  assert.strictEqual(row.costCents, null, '未解析到概览时保持 null，绝不补 0');
  assert.strictEqual(row.orders, null);
  assert.strictEqual(row.balanceStatus, 'skipped');
});
