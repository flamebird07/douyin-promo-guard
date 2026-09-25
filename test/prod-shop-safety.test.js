'use strict';

/**
 * 针对性隔离测试：生产接入与安全缺口。
 * 覆盖：持久化先写后报/回滚、展示名与身份字段分离、删除不中止他店、
 * 引号/注入安全、生产 watch-drill 多店铺接口。
 * 临时目录 + mock，不加载生产配置，不调用外部接口。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Monitor } = require('../src/engine/monitor');
const {
  makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock, waitFor,
} = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');

const PROD_WATCH_DRILL = path.join(__dirname, '..', '..', 'bill-manager', 'watch-drill.js');

function setupShops(t, opts = {}) {
  const cookieDir = makeTempDir('pg-safe-cookies-');
  const dataDir = makeTempDir('pg-safe-data-');
  const cfgDir = makeTempDir('pg-safe-cfg-');
  const cfgPath = path.join(cfgDir, 'config.json');
  t.after(() => {
    try { fs.rmSync(cookieDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
    try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch (_) {}
  });
  const shops = (opts.shops || [
    { id: 'shop-a', name: '甲店', compassShopName: '甲店罗盘', cookieFile: '甲店', enabled: true, platform: 'douyin' },
    { id: 'shop-b', name: '乙店', compassShopName: '乙店罗盘', cookieFile: '乙店', enabled: true, platform: 'pinduoduo' },
    { id: 'shop-c', name: '丙店', compassShopName: '丙店罗盘', cookieFile: '丙店', enabled: true, platform: 'douyin' },
  ]).map((s) => ({ ...s }));
  for (const s of shops) writeTempCookie(cookieDir, s.cookieFile, { expired: false });
  const rawCfg = {
    shops,
    rules: [{ type: 'wholeShopCostPerOrder', name: 'r', thresholdCents: opts.thresholdCents ?? 100, comparator: '>', period: 'today', timezone: 'Asia/Shanghai', enabled: true }],
  };
  fs.writeFileSync(cfgPath, JSON.stringify(rawCfg, null, 2));
  const cfgResult = makeCfgResult({ cookieDir, shops, rules: rawCfg.rules, execution: opts.execution || {}, monitor: opts.monitor || { legacyWholeShopCloseEnabled: true }, thresholdCents: opts.thresholdCents });
  cfgResult.sourcePath = cfgPath;
  const clock = opts.clock || makeClock(shanghaiMs('2026-09-12', '09:00'));
  const controllers = new Map();
  const readers = new Map();
  for (const s of shops) {
    const ads = [{ adId: `${s.id}-ad-1`, name: '广告1', status: '投放中', switchChecked: true }];
    const c = makeStatefulController({ identity: { id: s.id, name: s.name }, ads, ...(opts.controllerOpts && opts.controllerOpts[s.id] ? opts.controllerOpts[s.id] : {}) });
    const r = makeLinkedReader(c, {
      costCents: (opts.costByShop && opts.costByShop[s.id]) ?? 500,
      orders: (opts.ordersByShop && opts.ordersByShop[s.id]) ?? 10,
      costShopId: s.id, orderShopId: s.id, adsShopId: s.id,
      costDate: '2026-09-12', orderDate: '2026-09-12', adsDate: '2026-09-12',
      costFetchedAt: new Date(clock.nowFn()).toISOString(),
      orderFetchedAt: new Date(clock.nowFn()).toISOString(),
      adsFetchedAt: new Date(clock.nowFn()).toISOString(),
      pageSource: opts.pageSource || 'mock',
    }, clock.nowFn);
    controllers.set(s.id, c);
    readers.set(s.id, r);
  }
  const routerReader = {
    connected: true, source: opts.pageSource || 'mock',
    async readCostSummary(p) { return readers.get((p && p.shopCfg && p.shopCfg.id) || 'shop-a').readCostSummary(); },
    async readOrderSummary(p) { return readers.get((p && p.shopCfg && p.shopCfg.id) || 'shop-a').readOrderSummary(); },
    async listAdPage(p) { return readers.get((p && p && p.shopCfg && p.shopCfg.id) || 'shop-a').listAdPage(p || {}); },
  };
  const routerController = {
    connected: true, source: 'mock',
    async verifyIdentity(p) { return controllers.get((p && p.shopCfg && p.shopCfg.id) || 'shop-a').verifyIdentity(); },
    async getAd(p) { return controllers.get((p && p.shopCfg && p.shopCfg.id) || 'shop-a').getAd(p); },
    async closeAd(p) { return controllers.get((p && p.shopCfg && p.shopCfg.id) || 'shop-a').closeAd(p); },
  };
  const monitor = new Monitor(cfgResult, { reader: routerReader, controller: routerController }, {
    dataDir, nowFn: clock.nowFn, delayFn: clock.delayFn,
  });
  return { monitor, cfgPath, cfgDir, cookieDir, dataDir, controllers, readers, clock, shops };
}

// ── 1. 持久化先写后报 / 写入失败回滚 ───────────────────────────────
test('修改店铺：配置文件不可写 → 失败并回滚内存，不报告成功', async (t) => {
  const { monitor, cfgPath, cfgDir } = setupShops(t);
  // 把配置路径指向一个不可写目录（用只读文件模拟写失败）
  const roDir = makeTempDir('pg-safe-ro-');
  t.after(() => { try { fs.rmSync(roDir, { recursive: true, force: true }); } catch (_) {} });
  const roCfg = path.join(roDir, 'config.json');
  fs.writeFileSync(roCfg, JSON.stringify({ shops: [{ id: 'shop-a', name: '甲店', cookieFile: '甲店' }] }, null, 2));
  // 在 Windows 上用只读文件属性或指向目录使写失败：把 sourcePath 指向不存在的父目录
  monitor.cfgResult.sourcePath = path.join(roDir, 'no-such-sub', 'config.json');
  const before = { ...monitor._findShop('shop-a') };
  const r = monitor.updateShop('shop-a', { displayName: '不应生效', thresholdCents: 300 });
  assert.strictEqual(r.ok, false, '写入失败不得报告成功');
  assert.strictEqual(r.rolledBack, true, '内存必须回滚');
  const after = monitor._findShop('shop-a');
  assert.strictEqual(after.displayName, before.displayName, 'displayName 已回滚');
  assert.strictEqual(after.thresholdCents, before.thresholdCents, 'thresholdCents 已回滚');
  assert.strictEqual(after.name, '甲店', '身份 name 不变');
});

test('删除店铺：配置写入失败 → 回滚内存，不报告成功，店铺仍活动', async (t) => {
  const { monitor } = setupShops(t);
  monitor.cfgResult.sourcePath = path.join(os.tmpdir(), 'pg-no-such-dir-' + Date.now(), 'config.json');
  const r = monitor.deleteShop('shop-b');
  assert.strictEqual(r.ok, false, '写入失败不得报告删除成功');
  assert.strictEqual(r.rolledBack, true);
  assert.ok(monitor._isShopActive('shop-b'), '回滚后店铺仍活动');
});

test('修改店铺：写入成功后重启恢复（配置落盘可读回）', async (t) => {
  const { monitor, cfgPath, cookieDir, dataDir, clock } = setupShops(t);
  const r = monitor.updateShop('shop-a', { displayName: '甲店新名', thresholdCents: 222 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.persisted, true);
  // 模拟重启：从磁盘重新读配置并构造新 Monitor
  const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  const diskShop = raw.shops.find((s) => s.id === 'shop-a');
  assert.strictEqual(diskShop.displayName, '甲店新名');
  assert.strictEqual(diskShop.thresholdCents, 222);
  assert.strictEqual(diskShop.name, '甲店', '重启后身份 name 仍为原值');
  const cfgResult2 = makeCfgResult({ cookieDir, shops: raw.shops, rules: raw.rules, monitor: { legacyWholeShopCloseEnabled: true } });
  cfgResult2.sourcePath = cfgPath;
  const c2 = makeStatefulController({ identity: { id: 'shop-a', name: '甲店' }, ads: [{ adId: 'a', name: 'x', status: '投放中', switchChecked: true }] });
  const r2 = makeLinkedReader(c2, { costCents: 500, orders: 10, costShopId: 'shop-a', orderShopId: 'shop-a', adsShopId: 'shop-a', costDate: '2026-09-12', orderDate: '2026-09-12', adsDate: '2026-09-12', costFetchedAt: new Date(clock.nowFn()).toISOString(), pageSource: 'mock' }, clock.nowFn);
  const monitor2 = new Monitor(cfgResult2, { reader: r2, controller: c2 }, { dataDir, nowFn: clock.nowFn });
  const row = monitor2.getStatus().shopRows.find((x) => x.id === 'shop-a');
  assert.strictEqual(row.displayName, '甲店新名');
  assert.strictEqual(row.thresholdCents, 222);
});

// ── 2. 展示名与身份字段分离 ────────────────────────────────────────
test('修改展示名称：不得改变 name/compassShopName/id/accountId/cookieFile', async (t) => {
  const { monitor, cfgPath } = setupShops(t);
  const r = monitor.updateShop('shop-a', { displayName: '全新展示名', thresholdCents: 188 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.identityUnchanged, true);
  const shop = monitor._findShop('shop-a');
  assert.strictEqual(shop.name, '甲店', '身份 name 不变');
  assert.strictEqual(shop.id, 'shop-a');
  assert.strictEqual(shop.compassShopName, '甲店罗盘', 'compassShopName 不变');
  assert.strictEqual(shop.cookieFile, '甲店', 'cookieFile 不变');
  assert.strictEqual(shop.displayName, '全新展示名', '仅 displayName 变');
  const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).shops.find((s) => s.id === 'shop-a');
  assert.strictEqual(disk.name, '甲店');
  assert.strictEqual(disk.compassShopName, '甲店罗盘');
  assert.strictEqual(disk.cookieFile, '甲店');
  assert.strictEqual(disk.displayName, '全新展示名');
});

// ── 3. 删除一家店不得中止其他店铺在途任务 ──────────────────────────
test('甲店在途、删除乙店：甲店不受影响，乙店不再发新动作', async (t) => {
  const { monitor, controllers } = setupShops(t, {
    costByShop: { 'shop-a': 2000, 'shop-b': 2000, 'shop-c': 100 },
    ordersByShop: { 'shop-a': 10, 'shop-b': 10, 'shop-c': 10 },
  });
  // 启动一轮 pollOnce（会遍历三店）；在甲店执行期间删除乙店
  const pollPromise = monitor.pollOnce('test');
  // 立刻删除乙店（甲/丙在途或待处理）
  const del = monitor.deleteShop('shop-b');
  assert.strictEqual(del.ok, true);
  const p = await pollPromise;
  assert.ok(p.ok, 'pollOnce 完成');
  assert.strictEqual(p.results.length, 3, '三店都有结果（不静默漏掉）');
  const byId = Object.fromEntries(p.results.map((x) => [x.shopId, x]));
  assert.ok(byId['shop-a'], '甲店有结果');
  assert.ok(byId['shop-c'], '丙店有结果');
  // 甲店结果不得因删除乙店而中止
  assert.notStrictEqual(byId['shop-a'].status, 'skipped', '甲店不被跳过');
  // 乙店：要么 skipped，要么原有结果；但删除后不再有新 closeCalls 增长（下面再验）
  const bClosesBefore = controllers.get('shop-b').state.closeCalls.length;
  // 再跑一轮：乙店必须被跳过
  const p2 = await monitor.pollOnce('test');
  const b2 = p2.results.find((x) => x.shopId === 'shop-b');
  assert.ok(!b2 || b2.status === 'skipped', '删除后乙店不再轮询');
  assert.strictEqual(controllers.get('shop-b').state.closeCalls.length, bClosesBefore, '乙店不再发新广告动作');
});

test('删除甲店时甲店即将发动作：被删除店不再发新动作，其他店不受影响', async (t) => {
  const { monitor, controllers } = setupShops(t, {
    costByShop: { 'shop-a': 5000, 'shop-b': 500, 'shop-c': 500 },
    ordersByShop: { 'shop-a': 10, 'shop-b': 10, 'shop-c': 10 },
  });
  // 先删甲店（持久化成功）
  const del = monitor.deleteShop('shop-a');
  assert.strictEqual(del.ok, true);
  const aClosesBefore = controllers.get('shop-a').state.closeCalls.length;
  // 轮询：甲店必须被跳过，不发新动作；乙/丙正常
  const p = await monitor.pollOnce('test');
  const a = p.results.find((x) => x.shopId === 'shop-a');
  assert.ok(!a || a.status === 'skipped', '甲店被跳过');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, aClosesBefore, '甲店不再发新广告动作');
  assert.ok(p.results.find((x) => x.shopId === 'shop-b'), '乙店仍有结果');
  assert.ok(p.results.find((x) => x.shopId === 'shop-c'), '丙店仍有结果');
  // 手动动作也拒绝
  const shopA = monitor._findShop('shop-a');
  const act = await monitor._runShopSwitchAction(shopA, 'pause', {
    cost: { valueCents: 99999, businessDate: '2026-09-12' },
    orders: { valueCount: 1, businessDate: '2026-09-12' },
    evaluation: { over: true, reason: 'x' },
  }, { aborted: false }, 'test');
  assert.ok(act.zeroClick === true || act.status === 'blocked' || act.outcome === 'blocked_stopped', '删除后拒绝广告操作');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, aClosesBefore, '手动动作也不发新请求');
});

// ── 4. 引号 / 注入安全（名称含引号不破坏结构）────────────────────
test('展示名含引号/尖括号：持久化成功且不改变身份字段，状态可安全序列化', async (t) => {
  const { monitor, cfgPath } = setupShops(t);
  const evil = `甲"店'><img src=x onerror=alert(1)>`;
  const r = monitor.updateShop('shop-a', { displayName: evil, thresholdCents: 100 });
  assert.strictEqual(r.ok, true);
  const shop = monitor._findShop('shop-a');
  assert.strictEqual(shop.displayName, evil);
  assert.strictEqual(shop.name, '甲店');
  // JSON 序列化不破坏结构
  const dump = JSON.stringify(monitor.getStatus().shopRows);
  assert.ok(dump.includes('甲\\"店') || dump.includes(evil) || JSON.parse(dump).find((x) => x.id === 'shop-a').displayName === evil);
  // 写回磁盘可读
  const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).shops.find((s) => s.id === 'shop-a');
  assert.strictEqual(disk.displayName, evil);
});

// ── 5. 成功读取断言（禁止提前 return 假通过）──────────────────────
test('多店成功读取：逐店费用/订单/阈值/零广告动作（独立成功路径）', async (t) => {
  const { monitor, controllers } = setupShops(t, {
    costByShop: { 'shop-a': 1111, 'shop-b': 2222, 'shop-c': 3333 },
    ordersByShop: { 'shop-a': 11, 'shop-b': 22, 'shop-c': 33 },
    thresholdCents: 100,
  });
  const r = await monitor.refreshShopData('shop-a');
  assert.strictEqual(r.ok, true, '成功路径必须 ok');
  assert.strictEqual(r.data.costCents, 1111);
  assert.strictEqual(r.data.orders, 11);
  assert.strictEqual(r.readOnly, true);
  assert.strictEqual(r.zeroClick, true);
  const r2 = await monitor.refreshShopData('shop-b');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(r2.data.costCents, 2222);
  assert.strictEqual(r2.data.orders, 22);
  const r3 = await monitor.refreshShopData('shop-c');
  assert.strictEqual(r3.ok, true);
  assert.strictEqual(r3.data.costCents, 3333);
  assert.strictEqual(r3.data.orders, 33);
  for (const c of controllers.values()) {
    assert.strictEqual(c.state.closeCalls.length, 0, '只读更新零广告动作');
  }
  const rows = monitor.getStatus().shopRows;
  assert.strictEqual(rows.length, 3);
  const byId = Object.fromEntries(rows.map((x) => [x.id, x]));
  assert.strictEqual(byId['shop-a'].costCents, 1111);
  assert.strictEqual(byId['shop-b'].costCents, 2222);
  assert.strictEqual(byId['shop-c'].costCents, 3333);
  assert.strictEqual(byId['shop-b'].thresholdCents, 100);
});

test('独立失败用例：身份不匹配 → 不声称成功，零动作', async (t) => {
  const { monitor, controllers, readers } = setupShops(t);
  readers.get('shop-a').readCostSummary = async () => ({
    source: 'mock', kind: 'cost', shopId: 'WRONG', businessDate: '2026-09-12',
    fetchedAt: new Date().toISOString(), valueCents: 1,
  });
  const r = await monitor.refreshShopData('shop-a');
  // 失败路径：ok 不得为 true（或 ok:true 但带 blocked + zeroClick）
  if (r.ok === true) {
    assert.strictEqual(r.zeroClick, true);
    assert.ok(r.blocked || r.reason, '失败须给原因');
    assert.notStrictEqual(r.data.costCents, 500, '不得伪造正常数据');
  } else {
    assert.ok(r.reason, '失败须给原因');
  }
  for (const c of controllers.values()) {
    assert.strictEqual(c.state.closeCalls.length, 0);
  }
});

// 2026-09-24 生产实录回归：费用源 accountId 与配置不一致 →
// 「全店推广费用广告账户映射不匹配：配置 X，页面实际 Y。零关闭」（code=AUTH）。
// fail-closed 契约：轮询阻断、零广告动作、明确返回阻止原因、
// 绝不把页面账户写回配置（等主脑人工核对后另行修改）。
test('账户映射不匹配（费用源 accountId）：轮询 fail-closed 阻断，零动作，配置不被覆盖', async (t) => {
  const { monitor, cfgPath, controllers, readers } = setupShops(t, {
    shops: [
      { id: 'shop-a', name: '甲店', compassShopName: '甲店罗盘', cookieFile: '甲店', accountId: '1710242295996424', enabled: true, platform: 'douyin' },
    ],
  });
  // 费用源上报的 accountId 与配置不一致（模拟 2026-09-24 10:05 生产事件）
  readers.get('shop-a').readCostSummary = async () => ({
    source: 'mock', kind: 'cost', shopId: 'shop-a', accountId: '100761046755',
    businessDate: '2026-09-12', fetchedAt: new Date(monitor.nowFn()).toISOString(), valueCents: 500,
  });
  const before = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  const p = await monitor.pollOnce('test');
  const r = (p.results || []).find((x) => x.shopId === 'shop-a');
  assert.ok(r, '店铺必须有轮询结果（不静默漏掉）');
  assert.strictEqual(r.status, 'stopped', `轮询必须 fail-closed 阻断，实际：${JSON.stringify(r).slice(0, 200)}`);
  assert.strictEqual(r.code, 'AUTH', '身份类错误 code=AUTH');
  assert.match(r.reason, /广告账户映射不匹配/, '须写明账户映射不匹配');
  assert.match(r.reason, /配置 1710242295996424/, '须写明配置账户');
  assert.match(r.reason, /页面实际 100761046755/, '须写明页面实际账户');
  assert.match(r.reason, /零关闭/, '须声明零关闭');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 0, '零广告动作');
  // 绝不把页面账户覆盖进配置
  const after = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  assert.strictEqual(after.shops[0].accountId, '1710242295996424', '配置 accountId 未被覆盖');
  assert.deepStrictEqual(after, before, '配置文件整体未被改动');
});

// ── 6. 批量开始/停止作用域文案 ────────────────────────────────────
test('批量开始/停止：activeShopCount 覆盖全部未删除店；不影响 enableScheduler 生命周期', async (t) => {
  const { monitor } = setupShops(t);
  monitor.deleteShop('shop-c');
  const s = monitor.start();
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.activeShopCount, 2);
  // 每日 07:00 任务（enableRunning）与 start/stop 值守相互独立
  const enableWas = monitor.enableRunning;
  monitor.stop();
  assert.strictEqual(monitor.enableRunning, enableWas, '停止值守不改变每日开启任务状态');
});

// ── 7. 生产 watch-drill 多店铺接口 ────────────────────────────────
test('生产 watch-drill：buildShopRows 逐店结构 + adControl 仅抖店', () => {
  assert.ok(fs.existsSync(PROD_WATCH_DRILL), '生产副本存在');
  const { buildShopRows, deriveAdState } = require(PROD_WATCH_DRILL);
  const status = {
    shops: [
      { id: 'shop-a', name: '甲店', displayName: '甲店', platform: 'douyin', lastAdState: 'on', thresholdCents: 100, today: { costCents: 10, orders: 1 } },
      { id: 'shop-b', name: '乙店', displayName: '乙店', platform: 'pinduoduo', lastAdState: 'off', thresholdCents: 150, today: { costCents: 20, orders: 2 } },
    ],
    monitor: { enablePhaseToday: [] },
  };
  const rows = buildShopRows(status);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].platform, 'douyin');
  assert.strictEqual(rows[0].adControl, true, '抖店有广告控制');
  assert.strictEqual(rows[1].platform, 'pinduoduo');
  assert.strictEqual(rows[1].adControl, false, '拼多多无广告控制（不假装支持）');
  assert.strictEqual(rows[0].thresholdCents, 100);
  assert.strictEqual(rows[1].thresholdCents, 150);
  assert.ok(!JSON.stringify(rows[0]).includes('乙店'));
});

test('生产 watch-drill：serveHttp 暴露逐店 refresh/update/delete', async (t) => {
  const { createWatchDrill } = require(PROD_WATCH_DRILL);
  const cfgDir = makeTempDir('pg-prod-wd-');
  t.after(() => { try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch (_) {} });
  const cfgPath = path.join(cfgDir, 'config.json');
  const shops = [
    { id: 'shop-a', name: '甲店', cookieFile: '甲店', enabled: true, platform: 'douyin' },
    { id: 'shop-b', name: '乙店', cookieFile: '乙店', enabled: true, platform: 'douyin' },
  ];
  const cookieDir = path.join(cfgDir, 'cookies');
  fs.mkdirSync(cookieDir, { recursive: true });
  writeTempCookie(cookieDir, '甲店');
  writeTempCookie(cookieDir, '乙店');
  fs.writeFileSync(cfgPath, JSON.stringify({ shops, rules: [{ type: 'wholeShopCostPerOrder', name: 'r', thresholdCents: 100, comparator: '>', period: 'today', timezone: 'Asia/Shanghai', enabled: true }] }, null, 2));
  const drill = createWatchDrill({
    config: {
      shops, rules: rawRules(),
      execution: { dryRun: true, realMode: false, maxRetries: 0, retryBackoffMs: 0, closeTimeoutMs: 100, readbackTimeoutMs: 100, readbackAttempts: 1, readbackIntervalMs: 1, zeroOrderRecheck: 0, maxAdPages: 5 },
      schedule: { dailyStartHour: 8, intervalMinutes: 30, timezone: 'Asia/Shanghai' },
      monitor: { snapshotMaxAgeMinutes: 30, mockDataSource: false },
      login: { cookieSourceDir: cookieDir, edgePath: 'x', douyinHomeUrl: 'https://example.test' },
    },
    configSourcePath: cfgPath,
    dataDir: path.join(cfgDir, 'data'),
    adapters: null,
  });
  // 注入 mock monitor 以测 HTTP 路由
  const calls = [];
  drill._internal._monitor = {
    running: false, realMode: false, modeLabel: 'test', cycleNo: 0,
    getStatus: () => ({ shops: shops.map((s) => ({ ...s, deleted: false, thresholdCents: 100 })), rules: [], monitor: { cycleNo: 0 }, shopRows: [] }),
    async refreshShopData(id) { calls.push(['refresh', id]); return { ok: true, shopId: id, data: { costCents: 1 }, zeroClick: true, readOnly: true }; },
    updateShop(id, patch) { calls.push(['update', id, patch]); return { ok: true, shopId: id, displayName: patch.displayName || 'x', thresholdCents: patch.thresholdCents || 100, persisted: true }; },
    deleteShop(id) { calls.push(['delete', id]); return { ok: true, shopId: id, deleted: true, keepHistory: true, keepCookies: true }; },
    getEventStream: () => ({ events: [], seq: 0, dropped: [], droppedCount: 0 }),
  };
  const makeRes = () => {
    const r = { code: null, body: null };
    r.writeHead = (c) => { r.code = c; };
    r.end = (s) => { r.body = JSON.parse(s); };
    return r;
  };
  const call = async (method, p, bodyObj) => {
    const req = { method, url: p, on(ev, fn) { if (ev === 'data') fn(JSON.stringify(bodyObj || {})); if (ev === 'end') fn(); } };
    // readBody 监听 data/end；简化：直接包一层
    const req2 = {
      method, url: p,
      on(ev, fn) {
        if (ev === 'data') fn(Buffer.from(JSON.stringify(bodyObj || {})));
        if (ev === 'end') setImmediate(fn);
        if (ev === 'error') { /* ignore */ }
      },
    };
    const res = makeRes();
    await drill.serveHttp(req2, res);
    return res;
  };
  const r1 = await call('POST', '/api/watch-drill/shop/refresh', { shopId: 'shop-a' });
  assert.strictEqual(r1.code, 200);
  assert.strictEqual(r1.body.ok, true);
  assert.deepStrictEqual(calls[0], ['refresh', 'shop-a']);
  const r2 = await call('POST', '/api/watch-drill/shop/update', { shopId: 'shop-a', displayName: '新名', thresholdCents: 200 });
  assert.strictEqual(r2.code, 200);
  assert.strictEqual(r2.body.ok, true);
  assert.strictEqual(calls[1][0], 'update');
  const r3 = await call('POST', '/api/watch-drill/shop/delete', { shopId: 'shop-b' });
  assert.strictEqual(r3.code, 200);
  assert.strictEqual(r3.body.ok, true);
  assert.strictEqual(r3.body.keepHistory, true);
  assert.deepStrictEqual(calls[2], ['delete', 'shop-b']);
  // 缺 shopId → 400
  const r4 = await call('POST', '/api/watch-drill/shop/refresh', {});
  assert.strictEqual(r4.code, 400);
});

function rawRules() {
  return [{ type: 'wholeShopCostPerOrder', name: 'r', thresholdCents: 100, comparator: '>', period: 'today', timezone: 'Asia/Shanghai', enabled: true }];
}
