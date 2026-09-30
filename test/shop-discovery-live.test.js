'use strict';

/**
 * 隔离测试（第 13 阶段）：运行期店铺发现（requestShopDiscovery + watch-drill 钩子）。
 * 验收场景：
 *   L1 运行中新增有效抖店 Cookie → 一次发现调用进入 config.shops 与 getStatus().shops
 *      （=watch-drill shopRows 数据源），无需重启/启值守；实测时间上界见 R 计时。
 *   L2 来源 Cookie 文件删除 → 店铺保留（不删除/不停用/不隐藏）。
 *   L3 重复扫描幂等（added=[]、列表逐字节不变）。
 *   L4 已软删除（deleted:true）条目不因同名文件复活；既有条目字段不被改动。
 *   L5 持久化失败可见（recentErrors + 审计 persisted:false；内存仍生效）。
 *   L6 零真实业务动作（opener/readAdState 计数 0；值守启停状态不变；每日开启排程不变）。
 *   L7 节流（2s 内重复请求 throttled，不重复扫描）。
 * 隔离：临时 Cookie 目录 + 临时 config.json（sourcePath 指向它）；非 Cookie/非数组文件不建店。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor.js');
const { makeTempDir, makeCfgResult, writeTempCookie } = require('./helpers.js');

const FAKE_COOKIES = [{ name: 'sessionid', value: 'FAKE', domain: '.jinritemai.com', path: '/', expires: Date.now() / 1000 + 86400, httpOnly: true, secure: true, sameSite: 'Lax' }];

function writeCookieFile(dir, name) {
  fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(FAKE_COOKIES), 'utf8');
}

function makeNow(startMs = Date.now()) {
  const box = { now: startMs };
  return { nowFn: () => box.now, advance: (ms) => { box.now += ms; } };
}

function buildMonitor({ cookieDir, extraCfgFile = null, shops = null, nowFn = undefined }) {
  const cfgResult = makeCfgResult({
    cookieDir,
    shops: shops || [{ id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true }],
    monitor: { legacyWholeShopCloseEnabled: true, chengfang: { scope: ['全店托管', '商品自选'], enableHour: 7, enableSchedulerEnabled: true } },
  });
  if (extraCfgFile) cfgResult.sourcePath = extraCfgFile; // 可控持久化目标（含失败场景）
  return new Monitor(cfgResult, null, {
    dataDir: makeTempDir('s13-data-'),
    nowFn,
    chengfangOpener: async () => { throw new Error('隔离测试不得打开页面'); },
    readAdState: async () => { throw new Error('隔离测试不得回读'); },
  });
}

function statusShopIds(monitor) {
  return (monitor.getStatus().shops || []).map((s) => s.id);
}

test('L1 运行中新增有效抖店 Cookie → 一次发现调用即进入配置与状态（含计时上界）', async () => {
  const cookieDir = makeTempDir('s13-ck-');
  const cfgFile = path.join(makeTempDir('s13-cfg-'), 'config.json');
  writeCookieFile(cookieDir, 'shop-a'); // 既有店 Cookie（构造时已知）
  fs.writeFileSync(cfgFile, JSON.stringify({ shops: [{ id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', enabled: true }] }), 'utf8');
  const monitor = buildMonitor({ cookieDir, extraCfgFile: cfgFile });
  assert.deepEqual(statusShopIds(monitor), ['shop-a'], '初始仅既有店');

  const t0 = Date.now();
  writeCookieFile(cookieDir, '新店甲'); // 运行中新增（模拟商品分析侧投放新 Cookie）
  const r = monitor.requestShopDiscovery();
  const elapsed = Date.now() - t0;
  assert.equal(r.ok, true);
  assert.equal(r.throttled, false);
  assert.deepEqual(r.added, ['新店甲']);
  assert.deepEqual(statusShopIds(monitor), ['shop-a', '新店甲'], '发现后状态（=shopRows 数据源）应含新店');
  const added = monitor.config.shops.find((s) => s.id === '新店甲');
  assert.equal(added.enabled, true);
  assert.equal(added.autoDiscovered, true);
  assert.equal(added.platform, 'douyin');
  assert.ok(elapsed < 2000, `单次发现耗时上界（目录读+合并+原子写）实测 ${elapsed}ms < 2000ms`);
  // 持久化成功：config.json 已含新店
  const persisted = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
  assert.ok(persisted.shops.some((s) => s.id === '新店甲'), '配置应已落盘');
  monitor.stop();
});

test('L2 来源 Cookie 文件删除 → 店铺保留（不删除/不停用/不隐藏）', async () => {
  const cookieDir = makeTempDir('s13-ck-');
  const cfgFile = path.join(makeTempDir('s13-cfg-'), 'config.json');
  writeCookieFile(cookieDir, 'shop-a');
  writeCookieFile(cookieDir, '店乙');
  fs.writeFileSync(cfgFile, JSON.stringify({ shops: [{ id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', enabled: true }] }), 'utf8');
  const clock = makeNow();
  const monitor = buildMonitor({ cookieDir, extraCfgFile: cfgFile, nowFn: clock.nowFn });
  monitor.requestShopDiscovery(); // 店乙入库
  assert.deepEqual(statusShopIds(monitor), ['shop-a', '店乙']);

  clock.advance(3000); // 跨节流窗口
  fs.unlinkSync(path.join(cookieDir, '店乙.json')); // 来源删除
  const r2 = monitor.requestShopDiscovery();
  assert.equal(r2.ok, true);
  assert.deepEqual(r2.added, [], '删除来源不得触发任何 added');
  const kept = monitor.config.shops.find((s) => s.id === '店乙');
  assert.ok(kept, '店铺必须保留');
  assert.equal(kept.enabled, true, '不得停用');
  assert.notEqual(kept.deleted, true, '不得标记删除');
  assert.deepEqual(statusShopIds(monitor), ['shop-a', '店乙'], '展示列表不变');
  monitor.stop();
});

test('L3 重复扫描幂等：连续发现调用列表逐字节不变（有落盘目标；落盘成功才 ok:true）', async () => {
  // 夹具修正（第 14 阶段）：本用例给出**真实可落盘目标**（同 L1/L2/L5），使幂等验证运行在
  // 新语义下——ok:true 仅在"内存店铺已确认落盘"时成立。修正前本用例无落盘目标
  // （sourcePath='test-inline'），旧实现无论落盘成败都返回 ok:true，掩盖了落盘失败语义；
  // 现按"落盘成功才 ok:true"如实断言，且不删除原有幂等断言（added=[]、列表逐字节不变）。
  const cookieDir = makeTempDir('s13-ck-');
  const cfgFile = path.join(makeTempDir('s13-cfg-'), 'config.json');
  writeCookieFile(cookieDir, 'shop-a');
  writeCookieFile(cookieDir, '店丙');
  fs.writeFileSync(cfgFile, JSON.stringify({ shops: [{ id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', enabled: true }] }), 'utf8');
  const clock = makeNow();
  const monitor = buildMonitor({ cookieDir, extraCfgFile: cfgFile, nowFn: clock.nowFn });
  const first = monitor.requestShopDiscovery();
  assert.equal(first.ok, true, '有落盘目标且落盘成功时 ok=true');
  assert.equal(first.persisted, true, '有落盘目标且落盘成功时 persisted=true');
  const snap1 = JSON.stringify(monitor.config.shops);
  for (let i = 0; i < 3; i++) {
    clock.advance(3000); // 跨节流窗口
    const r = monitor.requestShopDiscovery();
    assert.equal(r.ok, true, `第 ${i + 1} 次重复扫描（无变化且已落盘）ok=true`);
    assert.equal(r.persisted, true, `第 ${i + 1} 次重复扫描 persisted=true`);
    assert.equal(r.pending, false, `第 ${i + 1} 次重复扫描不应有待重试标记`);
    assert.deepEqual(r.added || [], [], `第 ${i + 1} 次重复扫描不得重复追加`);
  }
  assert.equal(JSON.stringify(monitor.config.shops), snap1, '重复扫描幂等');
  monitor.stop();
});

test('L4 已软删除条目不因同名文件复活；既有条目字段不被改动', async () => {
  const cookieDir = makeTempDir('s13-ck-');
  writeCookieFile(cookieDir, '已删店');
  writeCookieFile(cookieDir, 'shop-a');
  const baseShop = { id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true, thresholdCents: 150 };
  const monitor = buildMonitor({
    cookieDir,
    shops: [baseShop, { id: '已删店', name: '已删店', cookieFile: '已删店', enabled: false, deleted: true }],
  });
  const r = monitor.requestShopDiscovery();
  assert.deepEqual(r.added || [], [], '同名 Cookie 不得复活软删除店');
  const del = monitor.config.shops.find((s) => s.id === '已删店');
  assert.equal(del.deleted, true, '软删除状态保持');
  assert.equal(del.enabled, false, '停用状态保持');
  const kept = monitor.config.shops.find((s) => s.id === 'shop-a');
  assert.equal(kept.thresholdCents, 150, '既有店字段不被发现流程改动');
  assert.equal(monitor.config.shops.length, 2, '不新增条目');
  monitor.stop();
});

test('L5 持久化失败可见：recentErrors + 审计 persisted:false，内存仍生效', async () => {
  const cookieDir = makeTempDir('s13-ck-');
  writeCookieFile(cookieDir, 'shop-a');
  const cfgFile = path.join(makeTempDir('s13-cfg-'), 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ shops: [{ id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', enabled: true }] }), 'utf8');
  const clock = makeNow();
  const monitor = buildMonitor({ cookieDir, extraCfgFile: cfgFile, nowFn: clock.nowFn });
  clock.advance(3000); // 跨节流窗口
  // 构造后运行中新增 Cookie，并制造持久化失败（config.json 破坏为非法 JSON）
  writeCookieFile(cookieDir, '落盘失败店');
  fs.writeFileSync(cfgFile, '{broken', 'utf8');
  const r = monitor.requestShopDiscovery();
  assert.deepEqual(r.added, ['落盘失败店'], '内存生效（发现成功）');
  const err = monitor.recentErrors.find((e) => String(e.error || '').includes('落盘失败店') && String(e.error || '').includes('配置落盘失败'));
  assert.ok(err, `recentErrors 应含可见失败记录，实际 ${JSON.stringify(monitor.recentErrors.slice(-2))}`);
  assert.ok(statusShopIds(monitor).includes('落盘失败店'), '状态展示不受落盘失败影响（内存已生效）');
  monitor.stop();
});

test('L6 零真实业务动作：不打开页面/不回读/不改值守与排程', async () => {
  const cookieDir = makeTempDir('s13-ck-');
  writeCookieFile(cookieDir, 'shop-a');
  writeCookieFile(cookieDir, '零动作店');
  const monitor = buildMonitor({ cookieDir });
  const runningBefore = monitor.running;
  monitor.requestShopDiscovery();
  assert.equal(monitor.running, runningBefore, '值守启停状态不变');
  assert.equal(monitor._cycleRunning, false, '不得进入巡查周期');
  assert.equal(monitor._activeTokens.size, 0, '零在途令牌');
  // 每日开启排程未登记（未启动调度器）；构造不触发任何 enable 行为
  assert.equal(monitor.enableRunning, false);
  // opener/readAdState 注入为抛错桩：若发现流程触发任何页面动作会抛错并使测试失败
  monitor.stop();
});

test('L7 节流：2s 内重复请求 throttled 且不重复扫描', async () => {
  const cookieDir = makeTempDir('s13-ck-');
  writeCookieFile(cookieDir, 'shop-a');
  const monitor = buildMonitor({ cookieDir });
  const r1 = monitor.requestShopDiscovery();
  assert.equal(r1.throttled, false);
  const r2 = monitor.requestShopDiscovery();
  assert.equal(r2.ok, true);
  assert.equal(r2.throttled, true, '节流窗口内应直接返回');
  monitor.stop();
});

test('L8 非 Cookie/非数组 json 不建店（仅抖店 Cookie 形态生效）', async () => {
  const cookieDir = makeTempDir('s13-ck-');
  writeCookieFile(cookieDir, 'shop-a');
  fs.writeFileSync(path.join(cookieDir, '备注.json'), JSON.stringify({ note: '不是 Cookie' }), 'utf8');
  fs.writeFileSync(path.join(cookieDir, 'readme.txt'), 'text', 'utf8');
  const monitor = buildMonitor({ cookieDir });
  const r = monitor.requestShopDiscovery();
  assert.deepEqual(r.added || [], [], '非数组 json/txt 不得建店');
  assert.deepEqual(statusShopIds(monitor), ['shop-a']);
  monitor.stop();
});
