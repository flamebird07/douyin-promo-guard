'use strict';

/**
 * 批次三（PROMO-IMPL-E1）：同店跨上下文浏览器会话互斥（值守侧）。
 *
 * 被测行为（全部 mock + 临时目录，不访问真实页面）：
 *  1) 该店当日发布/恢复租约在途 → 巡查跳过该店，audit 记
 *     kind=poll/status=skipped/reason=publish-lease-in-flight，且不编造平台状态；
 *  2) 无租约 / 租约已过期（leaseExists=false）→ 正常读取；
 *  3) 跨店不受影响：只有持租约的店跳过；
 *  4) 未注入 leaseExists（null）→ 与旧版行为一致（不检查、全部照常）；
 *  5) 每日开启相位在租约在途时零动作跳过（skipped + zeroClick）；
 *  6) 已无调用方的 _runEnablePhase scope='pause' 孤儿分支已删除（两参数调用即可遍历）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { Monitor } = require('../src/engine/monitor.js');
const {
  makeTempDir, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock, writeTempCookie,
} = require('./helpers.js');
const { shanghaiMs } = require('../src/lib/time');

const SHOP_A = { id: 'shop-a', name: '甲店', cookieFile: 'shop-a', accountId: 'acc-a', enabled: true };
const SHOP_B = { id: 'shop-b', name: '乙店', cookieFile: 'shop-b', accountId: 'acc-b', enabled: true };
const DATE = '2026-11-09';

function setup(opts = {}) {
  const shops = opts.shops || [SHOP_A];
  const dataDir = makeTempDir('b3-lease-');
  const cookieDir = makeTempDir('b3-cookie-');
  for (const s of shops) writeTempCookie(cookieDir, s.cookieFile);
  const clock = makeClock(shanghaiMs(DATE, '09:00'));
  const controller = makeStatefulController({
    identity: { id: shops[0].id, name: shops[0].name },
    ads: [{ adId: `${shops[0].id}-ad-1`, name: '广告1', status: '投放中', switchChecked: true }],
  });
  const reader = makeLinkedReader(controller, {
    costCents: 500,
    orders: 10,
    costShopId: shops[0].id,
    orderShopId: shops[0].id,
    adsShopId: shops[0].id,
    costDate: DATE,
    orderDate: DATE,
    adsDate: DATE,
    costFetchedAt: new Date(clock.nowFn()).toISOString(),
    orderFetchedAt: new Date(clock.nowFn()).toISOString(),
    adsFetchedAt: new Date(clock.nowFn()).toISOString(),
  }, clock.nowFn);
  const cfgResult = makeCfgResult({ cookieDir, shops });
  const dataReads = { n: 0 };
  const routerReader = {
    connected: true,
    source: 'mock',
    async readCostSummary(p) { dataReads.n += 1; return reader.readCostSummary(p); },
    async readOrderSummary(p) { dataReads.n += 1; return reader.readOrderSummary(p); },
    async listAdPage(p) { dataReads.n += 1; return reader.listAdPage(p || {}); },
  };
  const routerController = {
    connected: true,
    source: 'mock',
    async verifyIdentity(p) { return controller.verifyIdentity(p); },
    async getAd(p) { return controller.getAd(p); },
    async closeAd(p) { return controller.closeAd(p); },
  };
  const adReads = { n: 0 };
  const monitorOpts = {
    dataDir,
    nowFn: clock.nowFn,
    delayFn: clock.delayFn,
    readAdState: async () => { adReads.n += 1; return 'mixed'; },
  };
  if (opts.injectLease) {
    monitorOpts.leaseDir = pathForLeaseDir();
    monitorOpts.leaseExists = opts.leaseFn;
  }
  const monitor = new Monitor(cfgResult, { reader: routerReader, controller: routerController }, monitorOpts);
  return { monitor, controller, clock, dataDir, adReads, dataReads };
}

function pathForLeaseDir() {
  return makeTempDir('b3-lease-dir-');
}

function readAudit(monitor) {
  try {
    return fs.readFileSync(monitor.auditFile, 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (_) {
    return [];
  }
}

test('E1-1 租约在途：巡查跳过该店，audit 记 publish-lease-in-flight，不编造状态', async () => {
  let calls = 0;
  const { monitor, controller, adReads, dataReads } = setup({
    shops: [SHOP_A],
    injectLease: true,
    leaseFn: () => { calls += 1; return true; },
  });
  const r = await monitor.pollOnce('test');
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].status, 'skipped', JSON.stringify(r.results[0]));
  assert.match(String(r.results[0].reason || ''), /租约/);
  assert.equal(calls, 1, '必须查询该店当日租约');
  // 不得编造平台状态：跳过路径不写运行时观测（cookie/数据/广告状态读取均未启动）
  const rt = monitor._runtimeMap && monitor._runtimeMap.get(SHOP_A.id);
  assert.ok(!rt || rt.cookieCheckedAt === undefined, '跳过时不得进入读取链路');
  assert.equal(adReads.n, 0, '跳过时不得进行广告状态读取');
  assert.equal(dataReads.n, 0, '跳过时不得进行费用/订单读取');
  assert.equal(controller.state.closeCalls.length, 0, '跳过零动作');
  const audit = readAudit(monitor).filter((x) => x.kind === 'poll' && x.status === 'skipped');
  assert.ok(audit.some((x) => x.reason === 'publish-lease-in-flight'), JSON.stringify(audit));
  assert.ok(!audit.some((x) => x.adState), '跳过审计不得写入 adState');
});

test('E1-2 无租约/租约已过期（leaseExists=false）：正常读取', async () => {
  const { monitor, controller, dataReads } = setup({
    shops: [SHOP_A],
    injectLease: true,
    leaseFn: () => false,
  });
  const r = await monitor.pollOnce('test');
  assert.equal(r.ok, true);
  assert.notEqual(r.results[0].status, 'skipped', JSON.stringify(r.results[0]));
  const rt = monitor._runtimeMap.get(SHOP_A.id);
  assert.ok(rt && rt.cookieCheckedAt, '正常路径必须进入读取链路');
  assert.ok(dataReads.n >= 1, '正常路径必须进行费用/订单读取');
  assert.equal(controller.state.closeCalls.length, 0, '演练模式零点击');
});

test('E1-3 跨店：只有持租约的甲店跳过，乙店照常', async () => {
  const { monitor } = setup({
    shops: [SHOP_A, SHOP_B],
    injectLease: true,
    leaseFn: (shopCfg) => shopCfg.id === SHOP_A.id,
  });
  const r = await monitor.pollOnce('test');
  assert.equal(r.ok, true);
  assert.equal(r.results[0].status, 'skipped', JSON.stringify(r.results[0]));
  assert.notEqual(r.results[1].status, 'skipped', JSON.stringify(r.results[1]));
  const rtB = monitor._runtimeMap.get(SHOP_B.id);
  assert.ok(rtB && rtB.cookieCheckedAt, '乙店不受甲店租约影响');
});

test('E1-4 未注入 leaseExists：行为与旧版一致（不检查、全部照常）', async () => {
  const { monitor } = setup({ shops: [SHOP_A, SHOP_B] });
  assert.equal(monitor._publishLeaseExists, null);
  assert.equal(monitor._publishLeaseInFlight(SHOP_A), false);
  const r = await monitor.pollOnce('test');
  assert.equal(r.ok, true);
  assert.notEqual(r.results[0].status, 'skipped');
  assert.notEqual(r.results[1].status, 'skipped');
  assert.ok(!readAudit(monitor).some((x) => x.reason === 'publish-lease-in-flight'));
});

test('E1-5 每日开启相位：租约在途 → 零动作跳过（skipped + zeroClick）', async () => {
  const { monitor, controller } = setup({
    shops: [SHOP_A],
    injectLease: true,
    leaseFn: () => true,
  });
  const token = { aborted: false, kind: 'enable' };
  const r = await monitor._runShopEnablePhase(SHOP_A, token, DATE);
  assert.equal(r.status, 'skipped', JSON.stringify(r));
  assert.equal(r.zeroClick, true);
  assert.match(String(r.reason || ''), /租约/);
  assert.equal(controller.state.closeCalls.length, 0);
  assert.ok(readAudit(monitor).some((x) => x.kind === 'enable-phase' && x.event === 'skipped-publish-lease'));
});

test('E1-6 _runEnablePhase（两参数）遍历：租约在途时全部零动作', async () => {
  const { monitor, controller } = setup({
    shops: [SHOP_A, SHOP_B],
    injectLease: true,
    leaseFn: () => true,
  });
  monitor.enableRunning = true;
  monitor._enableGen = 1;
  await monitor._runEnablePhase(1, DATE);
  assert.equal(controller.state.closeCalls.length, 0, '开启相位零动作');
  const skips = readAudit(monitor).filter((x) => x.event === 'skipped-publish-lease');
  assert.equal(skips.length, 2, JSON.stringify(skips));
});
