'use strict';

/**
 * D24（2026-10-29 用户最新要求）确定性合成测试：店铺分析批次按"逐店串行"处理。
 * 全部 mock + 临时目录；只测真实导出（Monitor.pollOnce/_runEnablePhase/
 * runManualEnableVerify/refreshShopData），不访问真实页面、不触发真实开关。
 * 覆盖：串行 A/B/C、单店错误继续后续店、停止后队列店不再启动、
 * 新周期等待旧周期（互斥拒绝）、normal/daily/manual 跨入口不重叠。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { Monitor } = require('../src/engine/monitor');
const { makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock, waitFor } = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');

function setupShops(t, shops) {
  const cookieDir = makeTempDir('pg-serial-cookies-');
  const dataDir = makeTempDir('pg-serial-data-');
  t.after(() => {
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (const s of shops) if (s.cookieFile) writeTempCookie(cookieDir, s.cookieFile);
  const cfgResult = makeCfgResult({
    cookieDir,
    shops,
    monitor: { legacyWholeShopCloseEnabled: true },
  });
  const clock = makeClock(shanghaiMs('2026-10-29', '10:00'));
  const controller = makeStatefulController({
    identity: { id: shops[0].id, name: shops[0].name },
    ads: [{ adId: 'ad-1', name: '甲', status: '投放中' }],
  });
  const reader = makeLinkedReader(controller, { costCents: 100, orders: 10, pageSource: 'mock' }, clock.nowFn);
  const monitor = new Monitor(cfgResult, { reader, controller }, {
    dataDir,
    nowFn: clock.nowFn,
    delayFn: clock.delayFn,
  });
  return { monitor };
}

const ABC = () => ([
  { id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true },
  { id: 'shop-b', name: '店B', cookieFile: '店B', enabled: true },
  { id: 'shop-c', name: '店C', cookieFile: '店C', enabled: true },
]);

test('串行 A/B/C：任一时刻至多 1 家在途，按配置顺序启动，结果顺序一致', async (t) => {
  const { monitor } = setupShops(t, ABC());
  const events = [];
  let inFlight = 0;
  let peak = 0;
  monitor._pollShop = async (shop) => {
    events.push(`start:${shop.id}`);
    peak = Math.max(peak, ++inFlight);
    await new Promise((r) => setTimeout(r, 10));
    inFlight--;
    events.push(`end:${shop.id}`);
    return { status: 'ok', shopId: shop.id };
  };
  const r = await monitor.pollOnce('test');
  assert.ok(r.ok);
  assert.strictEqual(r.results.length, 3);
  assert.strictEqual(peak, 1, `严格串行：峰值必须 1，实际 ${peak}`);
  assert.deepEqual(events, [
    'start:shop-a', 'end:shop-a',
    'start:shop-b', 'end:shop-b',
    'start:shop-c', 'end:shop-c',
  ], '上一家完成后下一家才启动，顺序保持配置序');
  assert.deepEqual(r.results.map((x) => x.shopId), ['shop-a', 'shop-b', 'shop-c']);
});

test('单店错误继续：A 抛错不取消 B/C，错误如实记录、后续店正常处理', async (t) => {
  const { monitor } = setupShops(t, ABC());
  const handled = [];
  monitor._pollShop = async (shop) => {
    handled.push(shop.id);
    if (shop.id === 'shop-a') throw new Error('店A读取失败');
    await new Promise((r) => setTimeout(r, 5));
    return { status: 'ok', marker: shop.id };
  };
  const r = await monitor.pollOnce('test');
  assert.ok(r.ok);
  assert.deepEqual(handled, ['shop-a', 'shop-b', 'shop-c'], '错误后继续遍历');
  assert.strictEqual(r.results[0].status, 'stopped');
  assert.match(r.results[0].reason, /店A读取失败/);
  assert.strictEqual(r.results[1].status, 'ok');
  assert.strictEqual(r.results[2].status, 'ok');
});

test('停止后队列店不再启动：stop 令牌使未启动店 skipped（零新动作）', async (t) => {
  const { monitor } = setupShops(t, ABC());
  const started = [];
  let releaseA;
  const heldA = new Promise((r) => { releaseA = r; });
  monitor._pollShop = async (shop) => {
    started.push(shop.id);
    if (shop.id === 'shop-a') await heldA;
    return { status: 'ok' };
  };
  const p = monitor.pollOnce('test');
  await waitFor(() => started.includes('shop-a'), 1000);
  monitor.stop(); // 周期内不再启动新的处理
  releaseA();
  const r = await p;
  assert.ok(r.ok);
  assert.ok(!started.includes('shop-b') && !started.includes('shop-c'), `停止后队列店不得启动，已启动=${started.join(',')}`);
  const skipped = r.results.filter((x) => x.status === 'skipped' && /停止/.test(x.reason || ''));
  assert.strictEqual(skipped.length, 2, 'B/C 均按停止 skipped 记录');
});

test('新周期等待旧周期：旧周期在途时 pollOnce 拒绝（不并发、不静默合并）', async (t) => {
  const { monitor } = setupShops(t, ABC());
  let release;
  const held = new Promise((r) => { release = r; });
  monitor._pollShop = async (shop) => {
    if (shop.id === 'shop-a') await held;
    return { status: 'ok' };
  };
  const p1 = monitor.pollOnce('test');
  await new Promise((r) => setTimeout(r, 20));
  const p2 = await monitor.pollOnce('manual');
  assert.strictEqual(p2.ok, false);
  assert.match(p2.reason, /已有轮询周期进行中/);
  release();
  const r1 = await p1;
  assert.ok(r1.ok);
});

test('normal/daily/manual 跨入口互斥：巡查在途时每日开启相位与手动验证拒绝，不重叠', async (t) => {
  const { monitor } = setupShops(t, ABC());
  let release;
  const held = new Promise((r) => { release = r; });
  monitor._pollShop = async (shop) => {
    if (shop.id === 'shop-a') await held;
    return { status: 'ok' };
  };
  const p = monitor.pollOnce('interval');
  await new Promise((r) => setTimeout(r, 20));
  // 每日开启循环入口：巡查在途 → skipped（稍后重试），绝不并发
  const enable = await monitor._runEnablePhase(1, '2026-10-29');
  assert.strictEqual(enable.skipped, true);
  assert.match(enable.reason, /已有周期进行中/);
  // 手动验证入口：巡查在途 → 拒绝（cycle_busy）
  const manual = monitor.runManualEnableVerify('shop-b');
  assert.strictEqual(manual.ok, false);
  assert.strictEqual(manual.code, 'cycle_busy');
  release();
  const r = await p;
  assert.ok(r.ok);
});

test('手动只读刷新跨入口串行：目标店被在途处理占用时如实 shop_busy，不叠加并发读取', async (t) => {
  const { monitor } = setupShops(t, ABC());
  let release;
  const held = new Promise((r) => { release = r; });
  monitor._pollShop = async (shop) => {
    if (shop.id === 'shop-a') await held;
    return { status: 'ok' };
  };
  const p = monitor.pollOnce('interval');
  await waitFor(() => monitor._shopBusy('shop-a'), 1000);
  const busy = await monitor.refreshShopData('shop-a');
  assert.strictEqual(busy.blocked, 'shop_busy');
  assert.match(busy.reason, /处理在途/);
  assert.strictEqual(busy.zeroClick, true);
  release();
  await p;
  // 在途处理结束后锁必须已释放（可重新获取，无泄漏）
  assert.strictEqual(monitor._shopBusy('shop-a'), false);
});

// ── D24S：真实资源收口未证明时的跨店串行启动门（跨周期同样阻断）──────────
// 直接复用既有登记状态（_pendingReadGates/_cleanupRegistry）模拟
// "A 的 _pollShop 已返回、但其自有浏览器/会话收口仍未证明"。
// 登记簿/门是唯一事实源，与登记周期新旧无关；不得为推进而虚构清理。

function registerFakePendingGate(monitor, shopId) {
  const gate = { shopId: String(shopId), gateId: (monitor._readGateSeq += 1), phase: 'pending', closes: [] };
  monitor._setPendingReadGate(shopId, gate);
  monitor._cleanupRegister(gate);
  return gate;
}

function proveGateClosed(monitor, shopId, gate) {
  monitor._cleanupUnregister(gate);
  monitor._clearPendingReadGate(shopId);
}

test('A 返回时自有收口未证明 → B 不启动；实际关闭证明后下一周期 B 正常处理，无泄漏', async (t) => {
  const { monitor } = setupShops(t, ABC());
  const started = [];
  let gate = null;
  // 门必须一次性（ONE-SHOT）：模拟"A 本轮读取的超时收口未证明"，不是每次调用都新开超时
  let gateRegistered = false;
  monitor._pollShop = async (shop) => {
    started.push(shop.id);
    if (shop.id === 'shop-a' && !gateRegistered) {
      gateRegistered = true;
      gate = registerFakePendingGate(monitor, 'shop-a');
    }
    return { status: 'ok', shopId: shop.id };
  };
  // 第一周期：A 返回但收口未证明 → B/C 如实顺延，绝不启动
  const r1 = await monitor.pollOnce('test');
  assert.ok(r1.ok);
  assert.deepEqual(started, ['shop-a'], `收口未证明时不得启动下一家，实际=${started.join(',')}`);
  const deferred = r1.results.filter((x) => x.status === 'skipped' && /收口未证明/.test(x.reason || ''));
  assert.strictEqual(deferred.length, 2, 'B/C 均按收口未证明顺延（skipped，非伪造完成）');
  // 真实收口证明（复用既有注销/清门链）→ 登记状态归零，无残留
  proveGateClosed(monitor, 'shop-a', gate);
  assert.strictEqual(monitor._unprovenCleanupShopIds().size, 0, '收口证明后不得残留未收口登记');
  assert.strictEqual(monitor._shopProcessing.size, 0, '每店处理锁无泄漏');
  // 第二周期：实际收口证明后 B/C 正常处理（A 不再新开未收口资源）
  const r2 = await monitor.pollOnce('test');
  assert.ok(r2.ok);
  assert.deepEqual(started, ['shop-a', 'shop-a', 'shop-b', 'shop-c'], '收口证明后后续店正常处理');
  assert.strictEqual(r2.results.filter((x) => x.status === 'ok').length, 3);
});

test('跨周期严格串行：上一周期遗留的 A 收口未证明 → B/C 绝不启动；实际收口证明后恢复', async (t) => {
  const { monitor } = setupShops(t, ABC());
  const gate = registerFakePendingGate(monitor, 'shop-a'); // 模拟上一周期遗留的未收口门
  const started = [];
  monitor._pollShop = async (shop) => {
    started.push(shop.id);
    return { status: 'ok', shopId: shop.id };
  };
  // 登记簿/门是唯一事实源，与周期新旧无关：遗留门同样阻断他店启动（D24S，取代旧"防饿死豁免"）
  const r1 = await monitor.pollOnce('test');
  assert.ok(r1.ok);
  assert.deepEqual(started, ['shop-a'], `跨周期遗留未收口门必须阻断他店启动，实际=${started.join(',')}`);
  const deferred = r1.results.filter((x) => x.status === 'skipped' && /收口未证明/.test(x.reason || ''));
  assert.strictEqual(deferred.length, 2, 'B/C 均按收口未证明顺延，绝不并发启动');
  // 实际收口证明（注销/清门链）→ 阻断解除
  proveGateClosed(monitor, 'shop-a', gate);
  assert.strictEqual(monitor._unprovenCleanupShopIds().size, 0);
  const r2 = await monitor.pollOnce('test');
  assert.ok(r2.ok);
  assert.deepEqual(started, ['shop-a', 'shop-a', 'shop-b', 'shop-c'], '收口证明后 B/C 才可继续');
});

test('活动轮询中停止：队列店不启动、每店锁无泄漏（停止令牌优先于后续启动）', async (t) => {
  const { monitor } = setupShops(t, ABC());
  const started = [];
  let releaseA;
  const heldA = new Promise((r) => { releaseA = r; });
  monitor._pollShop = async (shop) => {
    started.push(shop.id);
    if (shop.id === 'shop-a') await heldA;
    return { status: 'ok' };
  };
  // 在途周期内停止（manual pollOnce 本就允许在 running=false 时工作，不得加全局 running 门槛）：
  // A 已启动允许自然收尾；B/C 不得再启动
  const p = monitor.pollOnce('test');
  await waitFor(() => started.includes('shop-a'), 1000);
  monitor.stop();
  releaseA();
  const r = await p;
  assert.ok(r.ok);
  assert.ok(!started.includes('shop-b') && !started.includes('shop-c'),
    `停止后队列店不得启动，已启动=${started.join(',')}`);
  const skipped = r.results.filter((x) => x.status === 'skipped' && /停止/.test(x.reason || ''));
  assert.strictEqual(skipped.length, 2, 'B/C 均按停止 skipped 记录');
  assert.strictEqual(monitor._shopProcessing.size, 0, '无每店锁泄漏');
  assert.strictEqual(monitor._cycleRunning, false, '周期收口无泄漏');
});

test('周期外手动刷新/立即处理：他店在途或收口未证明时复用 busy 响应，不叠加新处理', async (t) => {
  const { monitor } = setupShops(t, ABC());
  const gate = registerFakePendingGate(monitor, 'shop-a');
  // 无周期在途、他店收口未证明 → 只读刷新如实 busy（零点击）
  const busy = await monitor.refreshShopData('shop-b');
  assert.strictEqual(busy.blocked, 'shop_busy');
  assert.strictEqual(busy.zeroClick, true);
  assert.match(busy.reason, /收口未证明|处理在途/);
  // 登录接管立即处理：如实 skipped（零动作），不与他店未收口资源并发
  monitor.running = true; // 仅门禁语义（不启动循环）
  const join = await monitor.joinShopNow('shop-b');
  monitor.running = false;
  assert.strictEqual(join.ok, false);
  assert.strictEqual(join.status, 'skipped');
  assert.match(join.reason, /收口未证明|处理在途/);
  // 实际收口证明后周期外入口恢复（无死锁/无残留阻断）
  proveGateClosed(monitor, 'shop-a', gate);
  assert.strictEqual(monitor._unprovenCleanupShopIds().size, 0);
  const after = await monitor.refreshShopData('shop-b');
  assert.notStrictEqual(after.blocked, 'shop_busy', '收口证明后不得再因他店收口被拒');
});

// ── D24T（2026-10-29）：跨入口一次一家店补全──────────────────────────────
// 缺口：手动入口在周期外取得某店每店锁（_tryAcquireShop）后，pollOnce 的
// _cycleNewCleanupBlocker 只看未收口登记，看不到他店"处理在途"，B/C 照常启动。
// 修复：各业务启动入口（pollOnce/每日开启相位/手动验证/joinShopNow）统一用
// _otherBusyOrUnprovenShop 拦截他店在途；收口探测/恢复链关闭自有资源不经此门。

test('D24T 手动占用 A（_tryAcquireShop）时 pollOnce 不启动 B/C；A 释放后下一周期 A/B/C 正常', async (t) => {
  const { monitor } = setupShops(t, ABC());
  const started = [];
  monitor._pollShop = async (shop) => {
    started.push(shop.id);
    return { status: 'ok', shopId: shop.id };
  };
  // 模拟手动入口（只读刷新/登录接管/手动验证等）已取得 A 的每店处理锁
  assert.ok(monitor._tryAcquireShop('shop-a'));
  const r1 = await monitor.pollOnce('test');
  assert.ok(r1.ok);
  assert.deepEqual(started, [], `他店处理在途时本轮不得启动任何店，实际=${started.join(',')}`);
  const deferred = r1.results.filter((x) => x.status === 'skipped' && /处理在途/.test(x.reason || ''));
  assert.strictEqual(deferred.length, 3, 'A（同店在途）与 B/C（跨店串行）均如实顺延，绝不并发启动');
  assert.strictEqual(monitor._shopProcessing.size, 1, '不得泄漏/抢占手动入口持有的锁');
  // A 释放后下一周期恢复串行处理 A/B/C
  monitor._releaseShop('shop-a');
  const r2 = await monitor.pollOnce('test');
  assert.ok(r2.ok);
  assert.deepEqual(started, ['shop-a', 'shop-b', 'shop-c'], 'A 释放后下一周期 A/B/C 正常串行处理');
  assert.strictEqual(monitor._shopProcessing.size, 0, '周期收口无锁泄漏');
});

test('D24T 反向：手动占用 A 时每日开启相位不启动任何店；A 释放后恢复逐店串行', async (t) => {
  const { monitor } = setupShops(t, ABC());
  const started = [];
  // 只 stub 内层：外层 _runShopEnablePhase 是真实同店互斥外壳（busy 即 skipped 零动作），
  // 手动占用 A 时正是靠它阻止 A 启动（B/C 由 _runEnablePhase 的跨店串行门顺延）。
  monitor._runShopEnablePhaseInner = async (shopCfg) => {
    started.push(shopCfg.id);
    return { status: 'ok', skipped: true, zeroClick: true };
  };
  // 模拟独立每日开启调度器生命周期（不启动任何真实 timer/循环）：
  // scope='scheduler' 的相位循环只在 enableRunning=true 且 gen===_enableGen 时遍历店铺。
  monitor.enableRunning = true;
  monitor._enableGen = 1;
  try {
    assert.ok(monitor._tryAcquireShop('shop-a'));
    const r1 = await monitor._runEnablePhase(1, '2026-10-29');
    assert.strictEqual(r1.skipped, false);
    assert.deepEqual(started, [], `他店处理在途时开启相位不得启动任何店，实际=${started.join(',')}`);
    monitor._releaseShop('shop-a');
    const r2 = await monitor._runEnablePhase(1, '2026-10-29');
    assert.strictEqual(r2.skipped, false);
    assert.deepEqual(started, ['shop-a', 'shop-b', 'shop-c'], 'A 释放后开启相位恢复逐店串行');
  } finally {
    monitor.enableRunning = false;
  }
});

test('D24T 手动验证反向互斥：他店 A 处理在途时 runManualEnableVerify 如实拒绝（零动作）', async (t) => {
  const { monitor } = setupShops(t, ABC());
  assert.ok(monitor._tryAcquireShop('shop-a'));
  const r = monitor.runManualEnableVerify('shop-b');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'shop_busy');
  assert.match(r.error, /处理在途/);
  assert.strictEqual(monitor._cycleRunning, false, '拒绝不得占用周期互斥');
  assert.strictEqual(monitor._manualVerify || null, null, '未登记手动验证任务（零动作）');
  monitor._releaseShop('shop-a');
});

test('D24T joinShopNow 等待间隙复核：等待本店释放期间他店取得处理权 → 复查后如实 skipped', async (t) => {
  const { monitor } = setupShops(t, ABC());
  let dispatched = false;
  monitor._pollShop = async () => { dispatched = true; return { status: 'ok' }; };
  assert.ok(monitor._tryAcquireShop('shop-b')); // 目标店在途 → join 进入有界等待
  monitor.running = true; // 仅门禁语义（不启动循环）
  const p = monitor.joinShopNow('shop-b');
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(monitor._tryAcquireShop('shop-a')); // 等待期间他店 A 取得处理权（await 间隙）
  monitor._releaseShop('shop-b'); // 目标店释放：不得在未复查的情况下直接取得资格
  const r = await p;
  monitor.running = false;
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'skipped');
  assert.match(r.reason, /一次一家店|处理在途/);
  assert.strictEqual(dispatched, false, '未派发任何目标店处理（零动作）');
  assert.strictEqual(monitor._shopProcessing.has('shop-b'), false, '未取得/泄漏目标店处理锁');
  monitor._releaseShop('shop-a');
});

test('跨入口不同店不重叠：巡查周期在途时，他店手动刷新 cycle_busy、立即处理 skipped', async (t) => {
  const { monitor } = setupShops(t, ABC());
  let release;
  const held = new Promise((r) => { release = r; });
  monitor._pollShop = async (shop) => {
    if (shop.id === 'shop-a') await held;
    return { status: 'ok' };
  };
  const p = monitor.pollOnce('interval');
  await waitFor(() => monitor._shopBusy('shop-a'), 1000);
  // 他店只读刷新：周期在途 → 如实 cycle_busy，不叠加并发读取
  const busy = await monitor.refreshShopData('shop-b');
  assert.strictEqual(busy.blocked, 'cycle_busy');
  assert.strictEqual(busy.zeroClick, true);
  assert.match(busy.reason, /周期进行中/);
  // 他店登录接管立即处理：周期在途 → 如实 skipped（零动作）
  monitor.running = true; // 仅门禁语义（不启动循环）
  const join = await monitor.joinShopNow('shop-b');
  monitor.running = false;
  assert.strictEqual(join.ok, false);
  assert.strictEqual(join.status, 'skipped');
  assert.match(join.reason, /周期进行中/);
  release();
  const r = await p;
  assert.ok(r.ok);
  // 周期结束后跨入口恢复可用（无死锁/无泄漏）
  assert.strictEqual(monitor._cycleRunning, false);
  assert.strictEqual(monitor._shopProcessing.size, 0);
});
