'use strict';

/**
 * 第 13 阶段补验证 —— 隔离判别测试（业务仓外副本；零页面/零广告/零真实配置）。
 *
 * 唯一目标：对主脑定位的两处直接缺口做最小修正后的**判别性**验证，全部走集成层实际
 * `GET /api/watch-drill/state` 路径（不是只测 Monitor.getStatus()）：
 *   A) 运行期新增后，同一 /state 的 shops、shopRows、shopName 三处一致；
 *   B) 来源 Cookie 文件删除后，上述列表保留既有店（不删除/不停用/不隐藏）；
 *   C) 配置落盘失败时，集成层不得声称"持久化成功"（/state.shopDiscovery.persisted/ok 为 false）；
 *      写入条件恢复后，**同一进程、无需重启**即可再次落盘成功。
 * 同时保留既有规则：只追加、软删除不复活、零页面回读、零广告动作。
 *
 * 隔离方式：临时 Cookie 目录 + 临时 config.json（作为 configSourcePath 落盘目标）；
 * watch-drill 由 PROMO_GUARD_DIR 解析到本隔离推广仓副本。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const GUARD_COPY = path.resolve(__dirname, '..');
process.env.PROMO_GUARD_DIR = GUARD_COPY;

/**
 * 解析被测 watch-drill.js（3443 集成层运行实体）。同一测试需在多种布局下可直接运行：
 *  - 隔离布局：promo-stage13-verify/guard-copy/test → ../../bm-copy/watch-drill.js
 *  - 正式仓布局：douyin-promo-guard/test → ../../bill-manager/watch-drill.js
 *  - 单仓检出（GitHub）：以上均不存在时，回退到仓库内发布片段
 *    integrations/bill-manager/watch-drill.js（优先级最低，不覆盖任何显式指定/布局）
 * 亦可用环境变量 WATCH_DRILL_MODULE 显式指定被测文件（优先级最高）。
 */
function resolveWatchDrillModule() {
  const candidates = [
    process.env.WATCH_DRILL_MODULE,
    path.resolve(__dirname, '..', '..', 'bm-copy', 'watch-drill.js'),
    path.resolve(__dirname, '..', '..', 'bill-manager', 'watch-drill.js'),
    path.resolve(__dirname, '..', 'integrations', 'bill-manager', 'watch-drill.js'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch (_) { /* 探测失败换下一个 */ }
  }
  throw new Error(`未找到 watch-drill.js，候选：${candidates.join(' | ')}`);
}
const WATCH_DRILL_MODULE = resolveWatchDrillModule();
const { createWatchDrill } = require(WATCH_DRILL_MODULE);

const FAKE_COOKIES = [{
  name: 'sessionid', value: 'FAKE_VALUE_NOT_REAL', domain: '.jinritemai.com', path: '/',
  expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: true, sameSite: 'Lax',
}];

const CREATED = [];

function tmpDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function writeCookie(dir, name) { fs.writeFileSync(path.join(dir, `${name}.json`), JSON.stringify(FAKE_COOKIES), 'utf8'); }
function makeClock(start = Date.now()) { const b = { now: start }; return { nowFn: () => b.now, advance: (ms) => { b.now += ms; } }; }

function makeCfg(cookieDir, shops) {
  return {
    shops,
    rules: [{
      type: 'wholeShopCostPerOrder', name: '当天每单成本超额关全店', metric: 'cost_per_order',
      thresholdCents: 100, comparator: '>', period: 'today', timezone: 'Asia/Shanghai', enabled: true,
    }],
    schedule: { dailyStartHour: 8, intervalMinutes: 30, timezone: 'Asia/Shanghai' },
    execution: {
      dryRun: true, realMode: false, maxRetries: 1, retryBackoffMs: 1, closeTimeoutMs: 1000,
      readbackTimeoutMs: 1000, readbackAttempts: 1, readbackIntervalMs: 1, zeroOrderRecheck: 0, maxAdPages: 10,
    },
    monitor: {
      snapshotMaxAgeMinutes: 30, mockDataSource: false,
      chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: false, enableEnabled: false, enableHour: 7, enableSchedulerEnabled: false },
    },
    login: { cookieSourceDir: cookieDir, edgePath: 'C:/no/such/edge.exe', douyinHomeUrl: 'https://example.test/home' },
  };
}

/** 建实例；cfgPath 既作为落盘目标，也以相同内容初始化磁盘，保证内存/磁盘一致。 */
function makeDrill({ cookieDir, cfgPath, clock, shops, counters }) {
  fs.writeFileSync(cfgPath, JSON.stringify({ shops, login: { cookieSourceDir: cookieDir } }, null, 2), 'utf8');
  const drill = createWatchDrill({
    shopName: shops[0] ? shops[0].name : '—',
    config: makeCfg(cookieDir, shops),
    configSourcePath: cfgPath,
    nowFn: clock.nowFn,
    dataDir: tmpDir('s13b-data-'),
    adapters: { reader: null, controller: null },
    chengfangOpener: async () => { counters.opener += 1; throw new Error('隔离测试不得打开页面'); },
    readAdState: async () => { counters.readAdState += 1; throw new Error('隔离测试不得回读'); },
    persistFile: null,
  });
  CREATED.push(drill);
  return drill;
}

/** 走集成层实际 HTTP 路由：GET /api/watch-drill/state。 */
async function getState(drill) {
  let body = null; let code = null;
  const req = { method: 'GET', url: '/api/watch-drill/state', on: () => {}, destroy: () => {} };
  const res = { writeHead: (c) => { code = c; }, end: (b) => { body = b; } };
  await drill.serveHttp(req, res);
  assert.equal(code, 200, 'GET /state 应返回 200');
  const parsed = JSON.parse(body);
  assert.equal(parsed.ok, true, '/state 应答 ok 应为 true');
  return parsed.state;
}

/** 跨过 2s 发现节流窗口后再拉取 /state（保证发现真实执行）。 */
async function pull(drill, clock) { clock.advance(3000); return getState(drill); }

const ids = (arr) => (arr || []).map((x) => x && x.id).filter(Boolean);
const sorted = (a) => a.slice().sort();

/** 三处一致性不变量：shops 与 shopRows 的 id 集合一致；shopName 等于 shops 名称拼接。 */
function assertTriplet(state, label) {
  const s = ids(state.shops); const r = ids(state.shopRows);
  assert.deepEqual(sorted(s), sorted(r), `${label}：/state.shops 与 /state.shopRows 的 id 集合必须一致`);
  const expect = (state.shops || []).map((x) => x.name).join('、') || '—';
  assert.equal(state.shopName, expect, `${label}：/state.shopName 必须等于 shops 名称拼接`);
}

test.after(() => {
  for (const drill of CREATED) {
    try { drill.stop(); } catch (_) { /* ignore */ }
    try { clearInterval(drill._internal._syncTimer); } catch (_) { /* ignore */ }
  }
});

// ══════════════════════════════════════════════════════════════
// A) 运行期新增 → 同一 /state 三处一致（缺口 1 判别）
// ══════════════════════════════════════════════════════════════
test('A 运行期新增抖店后，/state 的 shops、shopRows、shopName 三处一致且已落盘', async () => {
  const cookieDir = tmpDir('s13b-ck-');
  const cfgPath = path.join(tmpDir('s13b-cfg-'), 'config.json');
  const clock = makeClock();
  const counters = { opener: 0, readAdState: 0 };
  writeCookie(cookieDir, 'shop-a');
  const shops = [{ id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', enabled: true }];
  const drill = makeDrill({ cookieDir, cfgPath, clock, shops, counters });

  drill.boot();
  const st0 = await pull(drill, clock);
  assert.deepEqual(ids(st0.shops), ['shop-a'], '基线 shops');
  assertTriplet(st0, '基线');

  // 运行中新增（模拟商品分析侧投放新 Cookie），不重启、不启值守
  writeCookie(cookieDir, '新店甲');
  const st1 = await pull(drill, clock);

  assert.ok(ids(st1.shops).includes('新店甲'), '/state.shops 必须出现新店（缺口 1：旧行为此处滞后）');
  assert.ok(ids(st1.shopRows).includes('新店甲'), '/state.shopRows 必须出现新店');
  assert.ok(String(st1.shopName).includes('新店甲'), '/state.shopName 必须出现新店（缺口 1：旧行为此处滞后）');
  assertTriplet(st1, '新增后');
  assert.deepEqual(ids(st1.shops), ['shop-a', '新店甲'], '只追加、保持既有下标语义');
  const added = st1.shops.find((s) => s.id === '新店甲');
  assert.equal(added.platform, 'douyin', '自动发现店 platform 恒为 douyin');

  // 集成层发现结果如实透出：本次已成功落盘
  assert.ok(st1.shopDiscovery, '/state.shopDiscovery 必须存在');
  assert.equal(st1.shopDiscovery.persisted, true, '成功落盘应 persisted=true');
  assert.equal(st1.shopDiscovery.ok, true, '成功落盘应 ok=true');
  assert.deepEqual(st1.shopDiscovery.added, ['新店甲']);

  // 磁盘确已写入新店
  const onDisk = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.ok(onDisk.shops.some((s) => s.id === '新店甲'), 'config.json 应已落盘新店');
});

// ══════════════════════════════════════════════════════════════
// B) 来源删除 → /state 列表保留既有店（缺口 1 对称面 + 既有规则）
// ══════════════════════════════════════════════════════════════
test('B 来源 Cookie 文件删除后，/state 的 shops、shopRows、shopName 保留既有店（不删除/不停用）', async () => {
  const cookieDir = tmpDir('s13b-ck-');
  const cfgPath = path.join(tmpDir('s13b-cfg-'), 'config.json');
  const clock = makeClock();
  const counters = { opener: 0, readAdState: 0 };
  writeCookie(cookieDir, 'shop-a');
  writeCookie(cookieDir, '店乙');
  const shops = [{ id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', enabled: true }];
  const drill = makeDrill({ cookieDir, cfgPath, clock, shops, counters });

  drill.boot();
  const st1 = await pull(drill, clock);
  assert.ok(ids(st1.shops).includes('店乙'), '运行中新增应进入 /state.shops');
  assertTriplet(st1, '新增后');

  // 来源删除
  clock.advance(3000);
  fs.unlinkSync(path.join(cookieDir, '店乙.json'));
  const st2 = await getState(drill);

  assert.ok(ids(st2.shops).includes('店乙'), '来源删除后 /state.shops 必须保留店乙');
  assert.ok(ids(st2.shopRows).includes('店乙'), '来源删除后 /state.shopRows 必须保留店乙');
  assert.ok(String(st2.shopName).includes('店乙'), '来源删除后 /state.shopName 必须保留店乙');
  assertTriplet(st2, '来源删除后');
  assert.deepEqual(st2.shopDiscovery.added, [], '删除来源不得触发任何 added');
  const kept = st2.shops.find((s) => s.id === '店乙');
  assert.ok(kept, '店铺条目必须保留');
  assert.notEqual(kept.deleted, true, '不得标记删除');
  assert.equal(kept.enabled !== false, true, '不得停用');
});

// ══════════════════════════════════════════════════════════════
// C) 落盘失败语义 + 同进程无需重启恢复（缺口 2 判别）
// ══════════════════════════════════════════════════════════════
test('C 落盘失败时 /state 不声称持久化成功；写入条件恢复后同进程无需重启即再次落盘', async () => {
  const cookieDir = tmpDir('s13b-ck-');
  const cfgPath = path.join(tmpDir('s13b-cfg-'), 'config.json');
  const clock = makeClock();
  const counters = { opener: 0, readAdState: 0 };
  writeCookie(cookieDir, 'shop-a');
  const shops = [{ id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', enabled: true }];
  const drill = makeDrill({ cookieDir, cfgPath, clock, shops, counters });

  drill.boot();
  await pull(drill, clock);
  const monitorBefore = drill._internal._monitor;
  assert.ok(monitorBefore, '装配后应存在 Monitor');

  // 运行中新增 + 制造落盘失败（config.json 破坏为非法 JSON）
  writeCookie(cookieDir, '落盘失败店');
  fs.writeFileSync(cfgPath, '{broken', 'utf8');
  const stFail = await pull(drill, clock);

  // 内存仍生效（既有可见性保留）：新店出现在三处
  assert.ok(ids(stFail.shops).includes('落盘失败店'), '内存已生效：/state.shops 含新店');
  assert.ok(ids(stFail.shopRows).includes('落盘失败店'), '内存已生效：/state.shopRows 含新店');
  assert.ok(String(stFail.shopName).includes('落盘失败店'), '内存已生效：/state.shopName 含新店');
  assertTriplet(stFail, '落盘失败后');

  // 集成层不得声称"持久化成功"
  assert.ok(stFail.shopDiscovery, '/state.shopDiscovery 必须存在');
  assert.equal(stFail.shopDiscovery.persisted, false, '落盘失败必须 persisted=false');
  assert.equal(stFail.shopDiscovery.ok, false, '落盘失败必须 ok=false（不得返回持久化成功）');
  assert.equal(stFail.shopDiscovery.pending, true, '落盘失败必须 pending=true（待重试）');
  assert.ok(stFail.shopDiscovery.reason, '落盘失败必须带可见原因');
  assert.deepEqual(stFail.shopDiscovery.added, ['落盘失败店']);

  // 底层契约直证（与 /state.shopDiscovery 同源）：跨节流再请求，落盘仍失败 → 不得报成功
  clock.advance(3000);
  const direct = monitorBefore.requestShopDiscovery();
  assert.equal(direct.ok, false, 'requestShopDiscovery 落盘失败时不得返回 ok=true');
  assert.equal(direct.persisted, false, 'requestShopDiscovery 落盘失败时不得返回 persisted=true');
  assert.equal(direct.pending, true, 'requestShopDiscovery 应保持待重试标记');

  // 磁盘确实未被成功写入（仍是我们写坏的原文）
  assert.equal(fs.readFileSync(cfgPath, 'utf8'), '{broken', '落盘失败时磁盘不得被改写');

  // 写入条件恢复：同一进程、同一 Monitor 实例，无需重启
  fs.writeFileSync(cfgPath, JSON.stringify({ shops, login: { cookieSourceDir: cookieDir } }, null, 2), 'utf8');
  const stRec = await pull(drill, clock);
  assert.equal(drill._internal._monitor, monitorBefore, '恢复过程不得重建 Monitor（即无需重启）');
  assert.equal(stRec.shopDiscovery.persisted, true, '恢复后应 persisted=true');
  assert.equal(stRec.shopDiscovery.ok, true, '恢复后应 ok=true');
  assert.equal(stRec.shopDiscovery.pending, false, '恢复后待重试标记应清除');
  assert.deepEqual(stRec.shopDiscovery.added, [], '恢复轮无新增（重试落盘）');
  assertTriplet(stRec, '恢复后');

  const diskAfter = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.ok(diskAfter.shops.some((s) => s.id === '落盘失败店'), '恢复后 config.json 应含此前待落盘的新店');
});

// ══════════════════════════════════════════════════════════════
// D) 既有规则保留：软删除不复活 + 零页面回读 + 零广告动作
// ══════════════════════════════════════════════════════════════
test('D 软删除不复活；发现流程零页面回读、零广告动作、值守与排程状态不变', async () => {
  const cookieDir = tmpDir('s13b-ck-');
  const cfgPath = path.join(tmpDir('s13b-cfg-'), 'config.json');
  const clock = makeClock();
  const counters = { opener: 0, readAdState: 0 };
  writeCookie(cookieDir, 'shop-a');
  writeCookie(cookieDir, '已删店');
  const shops = [
    { id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', enabled: true, thresholdCents: 150 },
    { id: '已删店', name: '已删店', cookieFile: '已删店', enabled: false, deleted: true },
  ];
  const drill = makeDrill({ cookieDir, cfgPath, clock, shops, counters });

  drill.boot();
  const st = await pull(drill, clock);

  // 软删除店不因同名 Cookie 复活：既不进入活动列表，也在底层配置保持 deleted/enabled 原状
  assert.equal(ids(st.shops).includes('已删店'), false, '软删除店不得进入 /state.shops 活动列表');
  assert.equal(ids(st.shopRows).includes('已删店'), false, '软删除店不得进入 shopRows 展示');
  const cfgDel = drill._internal._monitor.config.shops.find((s) => s.id === '已删店');
  assert.ok(cfgDel, '软删除条目应保留在底层配置（不被移除）');
  assert.equal(cfgDel.deleted, true, '软删除状态保持（不复活）');
  assert.equal(cfgDel.enabled, false, '停用状态保持');
  assert.equal(drill._internal._monitor.config.shops.length, 2, '不新增条目');
  assertTriplet(st, '软删除场景');

  // 既有店字段不被发现流程改动
  const kept = st.shops.find((s) => s.id === 'shop-a');
  assert.ok(kept, '既有店保留');
  const cfgShop = drill._internal._monitor.config.shops.find((s) => s.id === 'shop-a');
  assert.equal(cfgShop.thresholdCents, 150, '既有店 thresholdCents 不被发现流程改动');

  // 零页面回读 / 零广告动作：注入的 opener/readAdState 抛错桩计数必须为 0
  assert.equal(counters.opener, 0, '发现/状态拉取不得打开任何页面');
  assert.equal(counters.readAdState, 0, '发现/状态拉取不得回读广告状态');
  assert.equal(st.running, false, '值守未被启动');
  assert.equal(drill._internal._monitor._cycleRunning, false, '不得进入巡查周期');
  assert.equal(drill._internal._monitor._activeTokens.size, 0, '零在途令牌');
  assert.equal(drill._internal._monitor.enableRunning, false, '每日开启任务未运行');
});

// ══════════════════════════════════════════════════════════════
// E) 保留只追加规则：有可落盘目标时重复扫描幂等
//    （上一阶段 L3 的 harness 无落盘目标 sourcePath='test-inline'，故其 ok:true 断言
//      反映的是修正前旧语义；本用例在真实可落盘目标下证明幂等规则仍成立）
// ══════════════════════════════════════════════════════════════
test('E 有可落盘目标时重复扫描幂等：added=[]、ok=true、shops 逐字节不变', async () => {
  const cookieDir = tmpDir('s13b-ck-');
  const cfgPath = path.join(tmpDir('s13b-cfg-'), 'config.json');
  const clock = makeClock();
  const counters = { opener: 0, readAdState: 0 };
  writeCookie(cookieDir, 'shop-a');
  writeCookie(cookieDir, '店丙');
  const shops = [{ id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', enabled: true }];
  const drill = makeDrill({ cookieDir, cfgPath, clock, shops, counters });

  drill.boot();
  const st1 = await pull(drill, clock);
  assert.ok(ids(st1.shops).includes('店丙'), '首次应追加店丙');
  assert.equal(st1.shopDiscovery.ok, true, '有落盘目标且成功时应 ok=true');
  assert.equal(st1.shopDiscovery.persisted, true);
  const snap = JSON.stringify(st1.shops);

  for (let i = 0; i < 3; i++) {
    const st = await pull(drill, clock);
    assert.deepEqual(st.shopDiscovery.added, [], `第 ${i + 1} 次重复扫描不得重复追加`);
    assert.equal(st.shopDiscovery.ok, true, '无变化且已落盘时应 ok=true');
    assert.equal(st.shopDiscovery.pending, false, '无变化时不应有待重试标记');
    assert.equal(JSON.stringify(st.shops), snap, '重复扫描 shops 逐字节不变');
    assertTriplet(st, `幂等第 ${i + 1} 次`);
  }
});