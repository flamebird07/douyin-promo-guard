'use strict';

/**
 * 隔离测试：同轮跨店有界并行 + 确认后广告状态即时更新。
 * 全部 mock + 临时目录，不访问真实广告页、不触发真实开关。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor');
const { makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock, waitFor } = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');
const { deriveAdState } = require('../integrations/bill-manager/watch-drill');

function setupTwoShops(t, opts = {}) {
  const cookieDir = makeTempDir('pg-para-cookies-');
  const dataDir = makeTempDir('pg-para-data-');
  t.after(() => {
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const shops = opts.shops || [
    { id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true },
    { id: 'shop-b', name: '店B', cookieFile: '店B', enabled: true },
    { id: 'shop-c', name: '店C', cookieFile: '店C', enabled: true },
  ];
  // 仅写入配置内店铺的 Cookie，避免自动发现补进多余店
  for (const s of shops) {
    if (s.cookieFile) writeTempCookie(cookieDir, s.cookieFile);
  }
  const cfgResult = makeCfgResult({
    cookieDir,
    shops,
    monitor: { legacyWholeShopCloseEnabled: true },
    execution: opts.execution,
  });
  const clock = opts.clock || makeClock(shanghaiMs('2026-09-28', '10:00'));
  const controller = makeStatefulController({
    identity: { id: 'shop-a', name: '店A' },
    ads: [{ adId: 'ad-1', name: '甲', status: '投放中' }],
  });
  const reader = makeLinkedReader(controller, { costCents: 100, orders: 10, pageSource: 'mock' }, clock.nowFn);
  const monitor = new Monitor(cfgResult, { reader, controller }, {
    dataDir,
    nowFn: clock.nowFn,
    delayFn: clock.delayFn,
  });
  return { monitor, dataDir, cookieDir, clock };
}

test('同轮两店确实重叠开始，且并行上限为 2', async (t) => {
  const { monitor } = setupTwoShops(t);
  let inFlight = 0;
  let peak = 0;
  const startOrder = [];
  const barriers = [];
  monitor._pollShop = async (shop) => {
    startOrder.push(shop.id);
    peak = Math.max(peak, ++inFlight);
    const gate = new Promise((r) => barriers.push(r));
    await gate;
    inFlight--;
    return { status: 'ok', shopId: shop.id };
  };
  const p = monitor.pollOnce('test');
  await waitFor(() => startOrder.length >= 2, 2000);
  assert.ok(startOrder.includes('shop-a') && startOrder.includes('shop-b'), '两店应重叠开始');
  assert.strictEqual(peak, 2, '两店同时在途');
  // 放行前 2 家后，第 3 家应被限流为最多再开 1
  while (barriers.length) barriers.shift()();
  await waitFor(() => startOrder.length >= 3, 2000);
  while (barriers.length) barriers.shift()();
  const r = await p;
  assert.ok(r.ok);
  assert.strictEqual(r.results.length, 3);
  assert.ok(peak <= 2, `并行上限 2，实际 peak=${peak}`);
  // 结果按配置顺序
  assert.deepEqual(r.results.map((x) => x.shopId), ['shop-a', 'shop-b', 'shop-c']);
});

test('结果不串店：每店结果绑定自身 shopId', async (t) => {
  const { monitor } = setupTwoShops(t, {
    shops: [
      { id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true },
      { id: 'shop-b', name: '店B', cookieFile: '店B', enabled: true },
    ],
  });
  monitor._pollShop = async (shop) => {
    await new Promise((r) => setTimeout(r, shop.id === 'shop-a' ? 30 : 5));
    return { status: 'ok', marker: shop.id };
  };
  const r = await monitor.pollOnce('test');
  assert.deepEqual(r.results.map((x) => x.shopId), ['shop-a', 'shop-b']);
  assert.strictEqual(r.results[0].marker, 'shop-a');
  assert.strictEqual(r.results[1].marker, 'shop-b');
});

test('单店失败不得取消另一店', async (t) => {
  const { monitor } = setupTwoShops(t, {
    shops: [
      { id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true },
      { id: 'shop-b', name: '店B', cookieFile: '店B', enabled: true },
    ],
  });
  monitor._pollShop = async (shop) => {
    if (shop.id === 'shop-a') throw new Error('店A读取失败');
    await new Promise((r) => setTimeout(r, 20));
    return { status: 'ok', okShop: true };
  };
  const r = await monitor.pollOnce('test');
  assert.strictEqual(r.results[0].status, 'stopped');
  assert.match(r.results[0].reason, /店A读取失败/);
  assert.strictEqual(r.results[1].status, 'ok');
  assert.strictEqual(r.results[1].okShop, true);
});

test('停止后不得启动尚在队列中的店', async (t) => {
  const { monitor } = setupTwoShops(t, {
    shops: [
      { id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true },
      { id: 'shop-b', name: '店B', cookieFile: '店B', enabled: true },
      { id: 'shop-c', name: '店C', cookieFile: '店C', enabled: true },
    ],
  });
  const started = [];
  let releaseA;
  const heldA = new Promise((r) => { releaseA = r; });
  monitor._pollShop = async (shop) => {
    started.push(shop.id);
    if (shop.id === 'shop-a') await heldA;
    return { status: 'ok' };
  };
  // 限制为 1 以便精确测停止语义：通过 monkey-patch 保证只有 1 家在途时 stop
  // （生产并行上限为 2；此处用挂起第一家 + 立即 stop，验证队列不启动）
  const p = monitor.pollOnce('test');
  await waitFor(() => started.includes('shop-a'), 1000);
  monitor.stop();
  releaseA();
  // 另一家若已在途则允许完成；未启动的不得再启动
  await new Promise((r) => setTimeout(r, 50));
  const r = await p;
  assert.ok(r.ok);
  const unstarted = r.results.filter((x) => x.status === 'skipped' && /停止/.test(x.reason || ''));
  // 至少保证：停止后不会出现「新启动且完成」的第三家以外的额外动作店
  assert.ok(started.length <= 2, `停止后不应再启动队列店，已启动=${started.join(',')}`);
  assert.ok(unstarted.length >= 1 || started.length < 3, '停止后队列中的店不得启动');
});

test('软删除店不得发新动作/跳过处理', async (t) => {
  const { monitor } = setupTwoShops(t, {
    shops: [
      { id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true },
      { id: 'shop-b', name: '店B', cookieFile: '店B', enabled: true, deleted: true },
    ],
  });
  const started = [];
  monitor._pollShop = async (shop) => {
    started.push(shop.id);
    return { status: 'ok' };
  };
  const r = await monitor.pollOnce('test');
  assert.deepEqual(started, ['shop-a']);
  assert.ok(!started.includes('shop-b'));
});

test('同店动作仍串行：串行门拒绝同店并发开关', async (t) => {
  const { monitor } = setupTwoShops(t, {
    shops: [{ id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true }],
  });
  const g = monitor._switchGate;
  const b1 = g.tryBegin('shop-a', 'enable');
  assert.ok(b1.ok);
  const b2 = g.tryBegin('shop-a', 'pause');
  assert.strictEqual(b2.ok, false);
  assert.match(b2.reason, /串行化门/);
  // 不同店可并行占槽
  const b3 = g.tryBegin('shop-b', 'enable');
  assert.ok(b3.ok);
});

test('确认后状态立即更新：全量回读确认 on，且确认时间不等于费用采集时间', async (t) => {
  const { monitor } = setupTwoShops(t, {
    shops: [{ id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true }],
  });
  const rt = monitor._runtime('shop-a');
  rt.lastDataAt = '2026-09-28T01:00:00.000Z'; // 动作前费用/订单采集时间
  rt.lastAdState = 'off'; // 动作前状态

  const confirmedAt = '2026-09-28T02:03:46.000Z';
  monitor._recordBatch('shop-a', {
    actionType: 'enable',
    batchDate: '2026-09-28',
    outcome: 'all_enabled_confirmed',
    counts: { confirmed: 1, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
    details: [{ adId: 'ad-1', outcome: 'confirmed_open' }],
    allEnabledConfirmed: true,
  });
  // lastBatchAt 由 nowFn 决定；直接断言 runtime 已被确认状态覆盖
  assert.strictEqual(rt.lastAdState, 'on');
  assert.ok(rt.adStateConfirmedAt, '必须写入确认时间');
  assert.notStrictEqual(rt.adStateConfirmedAt, rt.lastDataAt, '确认时间不得用费用采集时间冒充');
  assert.ok(rt.adStateConfirmEvidence);

  const status = monitor.getStatus();
  const shop = status.shops.find((s) => s.id === 'shop-a');
  assert.strictEqual(shop.lastAdState, 'on');
  assert.ok(shop.adStateConfirmedAt);

  const ad = deriveAdState(status, shop);
  assert.strictEqual(ad.state, 'on');
  assert.strictEqual(ad.on, true);
  assert.strictEqual(ad.at, shop.adStateConfirmedAt, '展示时间取确认时间');
});

test('partial/unknown/未发出 不得伪更新成功状态', async (t) => {
  const { monitor } = setupTwoShops(t, {
    shops: [{ id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true }],
  });
  const rt = monitor._runtime('shop-a');
  rt.lastAdState = 'off';
  rt.lastDataAt = '2026-09-28T01:00:00.000Z';

  // partial：不全量确认
  monitor._recordBatch('shop-a', {
    actionType: 'enable',
    batchDate: '2026-09-28',
    outcome: 'partial',
    counts: { confirmed: 0, failed: 0, unknown: 1, skipped: 0, cancelled: 0 },
    details: [{ adId: 'ad-1', outcome: 'unknown' }],
    allEnabledConfirmed: false,
  });
  assert.strictEqual(rt.lastAdState, 'off', 'partial 不得改写状态');
  assert.strictEqual(rt.adStateConfirmedAt || null, null);

  // persistence_blocked / neverSent
  monitor._commitExecutedBatch('shop-a', {
    actionType: 'enable',
    outcome: 'persistence_blocked',
    neverSent: true,
    counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
  });
  assert.strictEqual(rt.lastAdState, 'off');

  // unknown 批次
  monitor._recordBatch('shop-a', {
    actionType: 'enable',
    batchDate: '2026-09-28',
    outcome: 'unknown',
    counts: { confirmed: 0, failed: 0, unknown: 1, skipped: 0, cancelled: 0 },
    details: [{ adId: 'ad-1', outcome: 'unknown' }],
  });
  assert.strictEqual(rt.lastAdState, 'off', 'unknown 不得改写状态');
});

test('nothing_to_enable 全量只读核验也更新状态；nothing 未确认则不更新', async (t) => {
  const { monitor } = setupTwoShops(t, {
    shops: [{ id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true }],
  });
  const rt = monitor._runtime('shop-a');
  rt.lastAdState = 'off';

  monitor._commitExecutedBatch('shop-a', {
    actionType: 'enable',
    outcome: 'nothing_to_enable',
    allEnabledConfirmed: true,
    counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
  });
  assert.strictEqual(rt.lastAdState, 'on');
  assert.ok(rt.adStateConfirmedAt);

  rt.lastAdState = 'on';
  rt.adStateConfirmedAt = null;
  monitor._commitExecutedBatch('shop-a', {
    actionType: 'enable',
    outcome: 'nothing_to_enable',
    // 缺失 allEnabledConfirmed → 不得伪更新
    counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
  });
  assert.strictEqual(rt.lastAdState, 'on');
  assert.strictEqual(rt.adStateConfirmedAt, null);
});
