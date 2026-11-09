'use strict';

/**
 * 批次二（PROMO-IMPL-D1）改动一回归：_cycleRunning 收敛为巡查循环自身重入守卫。
 *  - 手动只读刷新 / joinShopNow / 手动验证不再被「巡查周期进行中」全局布尔拦截；
 *  - 同店互斥仍由 _shopProcessing（_shopBusy/_tryAcquireShop）负责；
 *  - pollOnce 保留自身重入守卫；
 *  - 每日开启相位不再与巡查共用全局布尔。
 * 不访问真实页面：mock reader/controller + 临时目录。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { Monitor } = require('../src/engine/monitor.js');
const {
  makeTempDir, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock,
} = require('./helpers.js');
const { shanghaiMs } = require('../src/lib/time');

const SHOP = { id: 'shop-a', name: '甲店', cookieFile: '甲店', accountId: null, enabled: true };

function setup() {
  const dataDir = makeTempDir('batch2-cycle-');
  const cookieDir = makeTempDir('batch2-cookie-');
  const clock = makeClock(shanghaiMs('2026-11-09', '09:00'));
  const controller = makeStatefulController({
    identity: { id: SHOP.id, name: SHOP.name },
    ads: [{ adId: 'shop-a-ad-1', name: '广告1', status: '投放中', switchChecked: true }],
  });
  const reader = makeLinkedReader(controller, {
    costCents: 500,
    orders: 10,
    costShopId: SHOP.id,
    orderShopId: SHOP.id,
    adsShopId: SHOP.id,
    costDate: '2026-11-09',
    orderDate: '2026-11-09',
    adsDate: '2026-11-09',
    costFetchedAt: new Date(clock.nowFn()).toISOString(),
    orderFetchedAt: new Date(clock.nowFn()).toISOString(),
    adsFetchedAt: new Date(clock.nowFn()).toISOString(),
  }, clock.nowFn);
  const cfgResult = makeCfgResult({
    cookieDir,
    shops: [{ ...SHOP }],
    monitor: { legacyWholeShopCloseEnabled: true },
  });
  const routerReader = {
    connected: true,
    source: 'mock',
    async readCostSummary() { return reader.readCostSummary(); },
    async readOrderSummary() { return reader.readOrderSummary(); },
    async listAdPage(p) { return reader.listAdPage(p || {}); },
  };
  const routerController = {
    connected: true,
    source: 'mock',
    async verifyIdentity() { return controller.verifyIdentity(); },
    async getAd(p) { return controller.getAd(p); },
    async closeAd(p) { return controller.closeAd(p); },
  };
  const monitor = new Monitor(cfgResult, { reader: routerReader, controller: routerController }, {
    dataDir,
    nowFn: clock.nowFn,
    delayFn: clock.delayFn,
  });
  return { monitor, controller, clock };
}

test('B2-1 巡查周期进行中：手动只读刷新照常执行（不再 cycle_busy）', async () => {
  const { monitor, controller } = setup();
  monitor._cycleRunning = true; // 模拟巡查循环在途
  const r = await monitor.refreshShopData(SHOP.id);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.notEqual(r.blocked, 'cycle_busy', '不得再被全局 _cycleRunning 拦截');
  assert.equal(r.blocked, undefined);
  assert.equal(r.readOnly, true);
  assert.equal(controller.state.closeCalls.length, 0, '只读刷新零点击');
  monitor._cycleRunning = false;
});

test('B2-2 同店在途：手动只读刷新仍被 _shopProcessing 拦截（shop_busy）', async () => {
  const { monitor } = setup();
  monitor._shopProcessing.add(SHOP.id);
  const r = await monitor.refreshShopData(SHOP.id);
  assert.equal(r.blocked, 'shop_busy', JSON.stringify(r));
  assert.equal(r.zeroClick, true);
  monitor._shopProcessing.delete(SHOP.id);
});

test('B2-3 巡查周期进行中：joinShopNow 照常执行（不再被全局布尔跳过）', async () => {
  const { monitor } = setup();
  monitor.running = true;
  monitor._cycleRunning = true;
  let polled = 0;
  monitor._pollShop = async () => { polled += 1; return { status: 'ok', zeroClick: true }; };
  const r = await monitor.joinShopNow(SHOP.id, { trigger: 'test' });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.status, 'ok');
  assert.equal(polled, 1);
  monitor._cycleRunning = false;
});

test('B2-4 同店在途：joinShopNow 有界等待释放后仍执行（同店互斥保留）', async () => {
  const { monitor } = setup();
  monitor.running = true;
  monitor._shopProcessing.add(SHOP.id);
  let polled = 0;
  monitor._pollShop = async () => { polled += 1; return { status: 'ok', zeroClick: true }; };
  const timer = setTimeout(() => monitor._shopProcessing.delete(SHOP.id), 30);
  try {
    const r = await monitor.joinShopNow(SHOP.id, { trigger: 'test' });
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(polled, 1);
  } finally {
    clearTimeout(timer);
    monitor._shopProcessing.delete(SHOP.id);
  }
});

test('B2-5 pollOnce 保留自身重入守卫（同循环 tick 未结束不重入）', async () => {
  const { monitor } = setup();
  monitor._cycleRunning = true;
  const r = await monitor.pollOnce('test');
  assert.equal(r.ok, false);
  assert.match(r.reason, /已有轮询周期进行中/);
  monitor._cycleRunning = false;
});

test('B2-6 每日开启相位不再被巡查全局布尔拒绝', async () => {
  const { monitor } = setup();
  monitor.enableRunning = true;
  monitor._enableGen = 1;
  monitor._readAdState = async () => ({ state: 'off', identity: null });
  let batches = 0;
  monitor._executeEnableBatchFor = async () => { batches += 1; return { outcome: 'dry', dryRun: true, neverSent: true }; };
  monitor._cycleRunning = true; // 模拟暂停巡查在途
  try {
    const r = await monitor._runEnablePhase(1, '2026-11-09');
    assert.equal(r.skipped, false, JSON.stringify(r));
    assert.equal(batches, 1, '开启相位应实际进入单店执行（同店锁负责并发）');
  } finally {
    monitor._cycleRunning = false;
    monitor.enableRunning = false;
  }
});
