'use strict';

/**
 * 隔离测试：多店铺状态、单店立即更新、修改、删除、批量启停、商品分析多店铺显示。
 * 全部使用临时目录 + mock，不加载生产配置，不调用外部接口。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor');
const {
  makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock, waitFor,
} = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');
const { createWatchDrill, deriveAdState, buildShopRows } = require('../integrations/bill-manager/watch-drill');

const SHOPS = [
  { id: 'shop-a', name: '甲店', cookieFile: '甲店', accountId: null, enabled: true, platform: 'douyin' },
  { id: 'shop-b', name: '乙店', cookieFile: '乙店', accountId: null, enabled: true, platform: 'pinduoduo' },
  { id: 'shop-c', name: '丙店', cookieFile: '丙店', accountId: null, enabled: true, platform: 'douyin' },
];

function setupMulti(t, opts = {}) {
  const cookieDir = makeTempDir('pg-mshop-cookies-');
  const dataDir = makeTempDir('pg-mshop-data-');
  const cfgPath = path.join(makeTempDir('pg-mshop-cfg-'), 'config.json');
  t.after(() => {
    try { fs.rmSync(cookieDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(path.dirname(cfgPath), { recursive: true, force: true }); } catch (_) {}
  });
  const shops = (opts.shops || SHOPS).map((s) => ({ ...s }));
  for (const s of shops) {
    if (s.deleted !== true) writeTempCookie(cookieDir, s.cookieFile || s.name, { expired: false });
  }
  // 写一份可持久化的配置文件（测试专用，无真实 Cookie/令牌）
  const rawCfg = { shops, rules: [{ type: 'wholeShopCostPerOrder', name: 'r', thresholdCents: opts.thresholdCents ?? 100, comparator: '>', period: 'today', timezone: 'Asia/Shanghai', enabled: true }] };
  fs.writeFileSync(cfgPath, JSON.stringify(rawCfg, null, 2));
  const cfgResult = makeCfgResult({
    cookieDir,
    shops,
    rules: rawCfg.rules,
    execution: opts.execution || {},
    schedule: opts.schedule || {},
    monitor: opts.monitor || { legacyWholeShopCloseEnabled: true },
    pending: opts.pending || [],
    thresholdCents: opts.thresholdCents,
  });
  cfgResult.sourcePath = cfgPath;

  // 每店独立 mock 控制器/读取器（时钟与 monitor 一致，保证业务日期=当天）
  const clock = opts.clock || makeClock(shanghaiMs('2026-09-12', '09:00'));
  const controllers = new Map();
  const readers = new Map();
  for (const s of shops) {
    const ads = (opts.adsByShop && opts.adsByShop[s.id]) || [
      { adId: `${s.id}-ad-1`, name: '广告1', status: '投放中', switchChecked: true },
    ];
    const c = makeStatefulController({ identity: { id: s.id, name: s.name }, ads });
    const r = makeLinkedReader(c, {
      costCents: (opts.costByShop && opts.costByShop[s.id]) ?? 500,
      orders: (opts.ordersByShop && opts.ordersByShop[s.id]) ?? 10,
      costShopId: s.id,
      orderShopId: s.id,
      adsShopId: s.id,
      costDate: '2026-09-12',
      orderDate: '2026-09-12',
      adsDate: '2026-09-12',
      costFetchedAt: new Date(clock.nowFn()).toISOString(),
      orderFetchedAt: new Date(clock.nowFn()).toISOString(),
      adsFetchedAt: new Date(clock.nowFn()).toISOString(),
      pageSource: opts.pageSource || 'mock',
    }, clock.nowFn);
    controllers.set(s.id, c);
    readers.set(s.id, r);
  }

  // 路由 reader/controller：按 shopCfg 分发到对应 mock
  const routerReader = {
    connected: true,
    source: opts.pageSource || 'mock',
    async readCostSummary(p) {
      const id = (p && p.shopCfg && p.shopCfg.id) || 'shop-a';
      return readers.get(id).readCostSummary();
    },
    async readOrderSummary(p) {
      const id = (p && p.shopCfg && p.shopCfg.id) || 'shop-a';
      return readers.get(id).readOrderSummary();
    },
    async listAdPage(p) {
      const id = (p && p.shopCfg && p.shopCfg.id) || 'shop-a';
      return readers.get(id).listAdPage(p || {});
    },
  };
  const routerController = {
    connected: true,
    source: 'mock',
    async verifyIdentity(p) {
      const id = (p && p.shopCfg && p.shopCfg.id) || 'shop-a';
      return controllers.get(id).verifyIdentity();
    },
    async getAd(p) {
      const id = (p && p.shopCfg && p.shopCfg.id) || 'shop-a';
      return controllers.get(id).getAd(p);
    },
    async closeAd(p) {
      const id = (p && p.shopCfg && p.shopCfg.id) || 'shop-a';
      return controllers.get(id).closeAd(p);
    },
  };

  const monitor = new Monitor(cfgResult, { reader: routerReader, controller: routerController }, {
    dataDir,
    nowFn: clock.nowFn,
    delayFn: clock.delayFn,
  });
  return { monitor, cfgResult, dataDir, cfgPath, cookieDir, controllers, readers, clock, shops };
}

// ── 多店铺状态 ─────────────────────────────────────────────────────
test('多店铺状态：getStatus.shopRows 逐店独立，含广告状态/时间/费用/订单/阈值', async (t) => {
  const { monitor } = setupMulti(t, {
    costByShop: { 'shop-a': 1500, 'shop-b': 800, 'shop-c': 200 },
    ordersByShop: { 'shop-a': 10, 'shop-b': 20, 'shop-c': 5 },
    thresholdCents: 100,
  });
  await monitor.pollOnce('test');
  const st = monitor.getStatus();
  const rows = st.shopRows;
  assert.strictEqual(rows.length, 3, '三家活动店铺');
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.ok(byId['shop-a'] && byId['shop-b'] && byId['shop-c']);
  for (const r of rows) {
    assert.ok(r.name, '有店铺名称');
    assert.ok(['on', 'off', 'mixed', 'unknown'].includes(r.adState), '广告状态四态之一');
    assert.ok(r.lastDataAt, '有上次数据更新时间');
    assert.ok(typeof r.costCents === 'number' || r.costCents === null);
    assert.ok(typeof r.orders === 'number' || r.orders === null);
    assert.strictEqual(r.thresholdCents, 100, '当前设定阈值');
  }
  assert.strictEqual(byId['shop-a'].costCents, 1500);
  assert.strictEqual(byId['shop-b'].orders, 20);
  // 不泄露敏感字段
  const dump = JSON.stringify(st);
  assert.ok(!/sessionid|FAKE_VALUE|Bearer\s+[A-Za-z0-9]/.test(dump), '状态不含 Cookie/令牌');
});

test('多店铺：单店失败不影响其他店轮询结果', async (t) => {
  const { monitor, readers } = setupMulti(t, {
    costByShop: { 'shop-a': 500, 'shop-b': 500, 'shop-c': 500 },
    ordersByShop: { 'shop-a': 10, 'shop-b': 10, 'shop-c': 10 },
  });
  // 乙店身份不匹配 → stopped；甲/丙仍应有结果
  readers.get('shop-b').readCostSummary = async () => ({
    source: 'mock', kind: 'cost', shopId: 'WRONG', businessDate: '2026-09-12',
    fetchedAt: new Date().toISOString(), valueCents: 500,
  });
  const r = await monitor.pollOnce('test');
  assert.strictEqual(r.results.length, 3, '三店都有结果，不静默漏掉');
  const byId = Object.fromEntries(r.results.map((x) => [x.shopId, x]));
  assert.ok(byId['shop-a'].status === 'ok' || byId['shop-a'].status === 'window_blocked');
  assert.strictEqual(byId['shop-b'].status, 'stopped', '乙店身份失败被拦下');
  assert.ok(byId['shop-c'].status === 'ok' || byId['shop-c'].status === 'window_blocked');
});

// ── 单店立即更新（只读） ───────────────────────────────────────────
test('立即更新：只读取该店数据并刷新该行，零广告开关', async (t) => {
  const { monitor, controllers } = setupMulti(t, {
    costByShop: { 'shop-a': 1234, 'shop-b': 1, 'shop-c': 1 },
    ordersByShop: { 'shop-a': 7, 'shop-b': 1, 'shop-c': 1 },
  });
  const r = await monitor.refreshShopData('shop-a');
  // 成功路径必须真正读到数据（禁止读取失败提前 return 冒充通过）
  assert.strictEqual(r.ok, true, '必须成功读取');
  assert.strictEqual(r.readOnly, true);
  assert.strictEqual(r.zeroClick, true);
  assert.strictEqual(r.data.costCents, 1234, '成功后断言逐店费用');
  assert.strictEqual(r.data.orders, 7, '成功后断言逐店订单');
  for (const c of controllers.values()) {
    assert.strictEqual(c.state.closeCalls.length, 0, '立即更新绝不触发广告开关');
  }
  const st = monitor.getStatus();
  const row = st.shopRows.find((x) => x.id === 'shop-a');
  assert.strictEqual(row.costCents, 1234);
  assert.strictEqual(row.orders, 7);
  assert.ok(row.lastDataAt);
});

test('立即更新：拒绝已删除店铺', async (t) => {
  const { monitor } = setupMulti(t);
  monitor.deleteShop('shop-b');
  const r = await monitor.refreshShopData('shop-b');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /已删除|停用/);
});

// ── 修改店铺 ───────────────────────────────────────────────────────
test('修改店铺：名称+阈值校验、持久化、刷新状态', async (t) => {
  const { monitor, cfgPath } = setupMulti(t);
  const r = monitor.updateShop('shop-a', { displayName: '甲店改名', thresholdCents: 250 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.displayName, '甲店改名');
  assert.strictEqual(r.thresholdCents, 250);
  assert.strictEqual(r.persisted, true);
  const st = monitor.getStatus();
  const row = st.shopRows.find((x) => x.id === 'shop-a');
  assert.strictEqual(row.displayName, '甲店改名');
  assert.strictEqual(row.thresholdCents, 250);
  // 落盘后磁盘配置也更新；身份字段不变
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  const disk = raw.shops.find((s) => s.id === 'shop-a');
  assert.strictEqual(disk.displayName, '甲店改名');
  assert.strictEqual(disk.thresholdCents, 250);
  assert.strictEqual(disk.name, '甲店', '身份 name 不被展示名修改');
  assert.strictEqual(disk.id, 'shop-a');
  assert.strictEqual(disk.cookieFile, '甲店');
});

test('修改店铺：非法阈值/空名称被拒绝', async (t) => {
  const { monitor } = setupMulti(t);
  assert.strictEqual(monitor.updateShop('shop-a', { thresholdCents: 0 }).ok, false);
  assert.strictEqual(monitor.updateShop('shop-a', { thresholdCents: 2000000 }).ok, false);
  assert.strictEqual(monitor.updateShop('shop-a', { displayName: '   ' }).ok, false);
  assert.strictEqual(monitor.updateShop('no-such', { displayName: 'x' }).ok, false);
});

test('修改店铺：阈值覆盖全局规则用于判定', async (t) => {
  // 全局 100 分；店铺 A 覆盖 200 分 → 费用 1500/10 单 = 150 分/单：全局超标，按店阈值不超标
  const { monitor, controllers } = setupMulti(t, {
    costByShop: { 'shop-a': 1500, 'shop-b': 500, 'shop-c': 500 },
    ordersByShop: { 'shop-a': 10, 'shop-b': 10, 'shop-c': 10 },
    thresholdCents: 100,
  });
  monitor.updateShop('shop-a', { thresholdCents: 200 });
  const r = await monitor.refreshShopData('shop-a');
  // 成功路径必须真正判定（禁止失败提前 return）
  assert.strictEqual(r.ok, true, '必须成功读取');
  assert.strictEqual(r.data.over, false, '按店铺阈值 200 分判定为未超标');
  const p = await monitor.pollOnce('test');
  const a = p.results.find((x) => x.shopId === 'shop-a');
  assert.ok(a, '有 A 店结果');
  assert.ok(a.status === 'ok' || a.status === 'window_blocked' || a.over === false);
  if (a.status === 'ok') assert.strictEqual(a.over, false);
  for (const c of controllers.values()) {
    assert.strictEqual(c.state.closeCalls.length, 0, '未超标零动作');
  }
});

// ── 删除店铺 ───────────────────────────────────────────────────────
test('删除店铺：软删后停止值守/轮询/操作，保留历史与 Cookie', async (t) => {
  const { monitor, cookieDir, dataDir, controllers } = setupMulti(t);
  await monitor.pollOnce('test');
  const r = monitor.deleteShop('shop-b');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.deleted, true);
  assert.strictEqual(r.keepHistory, true);
  assert.strictEqual(r.keepCookies, true);
  // Cookie 文件仍在
  assert.ok(fs.existsSync(path.join(cookieDir, '乙店.json')), 'Cookie 文件保留');
  // 轮询跳过已删除店
  const p = await monitor.pollOnce('test');
  const b = p.results.find((x) => x.shopId === 'shop-b');
  assert.ok(!b || b.status === 'skipped', '已删除店铺不再轮询');
  assert.strictEqual(p.results.filter((x) => x.shopId === 'shop-b' && x.status !== 'skipped').length, 0);
  // 手动更新拒绝
  const fr = await monitor.refreshShopData('shop-b');
  assert.strictEqual(fr.ok, false);
  // 手动修改拒绝
  assert.strictEqual(monitor.updateShop('shop-b', { displayName: 'x' }).ok, false);
  // 活动列表不含已删除
  assert.ok(!monitor._isShopActive('shop-b'));
  // 历史状态文件仍在
  assert.ok(fs.existsSync(path.join(dataDir, 'state.json')), '历史状态保留');
  // 广告操作被拒
  const shopB = monitor._findShop('shop-b');
  const act = await monitor._runShopSwitchAction(shopB, 'pause', {
    cost: { valueCents: 99999, businessDate: '2026-09-12' },
    orders: { valueCount: 1, businessDate: '2026-09-12' },
    evaluation: { over: true, reason: 'x' },
  }, { aborted: false }, 'test');
  assert.ok(act.zeroClick === true || act.status === 'blocked' || act.outcome === 'blocked_stopped', '删除后拒绝广告操作');
});

test('删除店铺：调度器与开启相位再次检查活动列表', async (t) => {
  const { monitor, shops } = setupMulti(t);
  monitor.deleteShop('shop-c');
  const active = monitor._activeShops().map((s) => s.id);
  assert.deepStrictEqual(active.sort(), ['shop-a', 'shop-b']);
  // 模拟开启相位遍历：已删除店不在活动列表
  assert.strictEqual(monitor._isShopActive('shop-c'), false);
  // getStatus 中已删除店不再出现在 shopRows
  const st = monitor.getStatus();
  const rowIds = st.shopRows.map((r) => r.id);
  assert.ok(!rowIds.includes('shop-c'), 'shopRows 不含已删除店铺');
});

// ── 批量开始/停止监控 ──────────────────────────────────────────────
test('批量开始/停止：作用于全部未删除店铺，不只操作第一家', async (t) => {
  const { monitor } = setupMulti(t);
  monitor.deleteShop('shop-c');
  // 先批量轮询（不启动循环，避免与手动 pollOnce 并发）：必须覆盖全部活动店铺
  const p0 = await monitor.pollOnce('test');
  const ids0 = p0.results.map((x) => x.shopId).sort();
  assert.deepStrictEqual(ids0, ['shop-a', 'shop-b'], '批量轮询覆盖全部活动店铺');
  // 开始监控：报告活动店铺数（批量语义）
  const s = monitor.start();
  assert.strictEqual(s.ok, true);
  assert.strictEqual(monitor.running, true);
  assert.strictEqual(s.activeShopCount, 2, '活动店铺 2 家（丙已删）');
  // 停止监控
  const st = monitor.stop();
  assert.strictEqual(st.ok, true);
  assert.strictEqual(monitor.running, false);
});

test('批量开始：待配置时整体拒绝（fail-closed）', async (t) => {
  const { monitor } = setupMulti(t, { pending: ['shops: 测试待配置'] });
  const s = monitor.start();
  assert.strictEqual(s.ok, false);
  assert.match(s.reason, /待配置/);
});

// ── 商品分析多店铺显示（watch-drill 数据层）────────────────────────
test('deriveAdState：多店铺开启记录按 shopId 隔离，不串店', () => {
  const status = {
    monitor: {
      enablePhaseToday: [
        { shopId: 'shop-a', record: { status: 'success', at: '2026-09-12T07:05:00.000Z' } },
        { shopId: 'shop-b', record: { status: 'failed', at: '2026-09-12T07:05:00.000Z' } },
      ],
    },
  };
  const a = deriveAdState(status, { id: 'shop-a', batchToday: null });
  const b = deriveAdState(status, { id: 'shop-b', batchToday: null });
  assert.strictEqual(a.note, '投放中');
  assert.strictEqual(b.note, '未知', '乙店失败记录不得被甲店 success 污染');
});

test('buildShopRows：多店铺保持平台-店铺对应，不拼成无法区分的字符串', () => {
  const status = {
    shops: [
      { id: 'shop-a', name: '甲店', platform: 'douyin', lastAdState: 'on', lastDataAt: '2026-09-12T09:00:00.000Z', today: { costCents: 100, orders: 2 }, thresholdCents: 100 },
      { id: 'shop-b', name: '乙店', platform: 'pinduoduo', lastAdState: 'off', lastDataAt: '2026-09-12T09:01:00.000Z', today: { costCents: 200, orders: 3 }, thresholdCents: 150 },
    ],
    monitor: { enablePhaseToday: [] },
  };
  const rows = buildShopRows(status);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].id, 'shop-a');
  assert.strictEqual(rows[0].platform, 'douyin');
  assert.strictEqual(rows[0].platformLabel, '抖店');
  assert.strictEqual(rows[0].adState.note, '开启');
  assert.strictEqual(rows[1].id, 'shop-b');
  assert.strictEqual(rows[1].platform, 'pinduoduo');
  assert.strictEqual(rows[1].platformLabel, '拼多多');
  assert.strictEqual(rows[1].adState.note, '暂停');
  assert.strictEqual(rows[1].thresholdCents, 150);
  // 每行独立，不是拼接串
  assert.ok(!JSON.stringify(rows[0]).includes('乙店'));
  assert.ok(!JSON.stringify(rows[1]).includes('甲店'));
});

test('watch-drill snapshot：多店铺 shops/shopRows/lastRounds 结构化输出', async (t) => {
  const { monitor, cfgResult } = setupMulti(t, {
    costByShop: { 'shop-a': 1000, 'shop-b': 2000, 'shop-c': 300 },
    ordersByShop: { 'shop-a': 10, 'shop-b': 10, 'shop-c': 10 },
  });
  await monitor.pollOnce('test');
  const drill = createWatchDrill({
    config: cfgResult.config,
    configSourcePath: cfgResult.sourcePath,
    dataDir: makeTempDir('pg-wd-data-'),
    adapters: { reader: null, controller: null },
  });
  // 直接注入 monitor 以测 snapshot 多店铺字段
  drill._internal._monitor = monitor;
  drill._internal.shops = cfgResult.config.shops.map((s) => ({
    id: s.id, name: s.name || s.id, platform: s.platform || 'douyin',
  }));
  drill.sync();
  const snap = drill.snapshot();
  assert.ok(Array.isArray(snap.shops) && snap.shops.length === 3);
  assert.ok(Array.isArray(snap.shopRows) && snap.shopRows.length === 3);
  assert.ok(snap.lastRounds && snap.lastRounds['shop-a']);
  const rowA = snap.shopRows.find((r) => r.id === 'shop-a');
  const rowB = snap.shopRows.find((r) => r.id === 'shop-b');
  assert.strictEqual(rowA.platform, 'douyin');
  assert.strictEqual(rowB.platform, 'pinduoduo');
  assert.strictEqual(rowA.thresholdCents, 100);
  // lastRounds 逐店
  assert.strictEqual(snap.lastRounds['shop-a'].shopName, '甲店');
  assert.strictEqual(snap.lastRounds['shop-b'].shopName, '乙店');
  assert.strictEqual(snap.lastRounds['shop-a'].costCents, 1000);
  assert.strictEqual(snap.lastRounds['shop-b'].costCents, 2000);
});

// ── 安全语义回归（未知/身份/分页 → 零动作）──────────────────────────
test('身份失败：立即更新零动作，状态未知', async (t) => {
  const { monitor, controllers, readers } = setupMulti(t);
  readers.get('shop-a').readCostSummary = async () => ({
    source: 'mock', kind: 'cost', shopId: 'WRONG_SHOP', businessDate: '2026-09-12',
    fetchedAt: new Date().toISOString(), valueCents: 1,
  });
  const r = await monitor.refreshShopData('shop-a');
  // readAndEvaluate 会因身份不匹配抛错或返回 blocked
  if (r.ok) {
    assert.strictEqual(r.zeroClick, true);
  } else {
    assert.match(String(r.reason), /身份|不匹配|不一致/);
  }
  for (const c of controllers.values()) {
    assert.strictEqual(c.state.closeCalls.length, 0);
  }
});
