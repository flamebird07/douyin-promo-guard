'use strict';

/**
 * 隔离测试：监控引擎 v2（确定性门控时钟 + mock 适配器，不访问真实页面）。
 * 运行：npm test（node --test）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor');
const { makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock, waitFor } = require('./helpers');
const { shanghaiMs, shanghaiDate } = require('../src/lib/time');

const IDENTITY = { id: 'shop-001', name: '测试店铺一' };
// 2 页 × 2 条：3 个投放中（含零消耗）+ 1 个已暂停
const ADS = [
  { adId: 'ad-1001', name: '广告甲', status: '投放中' },
  { adId: 'ad-1002', name: '零消耗广告', status: '投放中' },
  { adId: 'ad-1003', name: '广告丙', status: '投放中' },
  { adId: 'ad-1004', name: '已暂停广告', status: '已暂停' },
];

function setup(t, {
  costCents = 15001, orders = 100, ads = ADS, readerDef = {}, controllerOpts = {},
  execution = {}, schedule = {}, shops, rules, pending,
  expiredCookie = false, missingCookie = false, noAdapters = false, clock = null,
} = {}) {
  const cookieDir = makeTempDir('pg-cookies-');
  const dataDir = makeTempDir('pg-data-');
  t.after(() => {
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  if (!missingCookie) writeTempCookie(cookieDir, '测试店铺一', { expired: expiredCookie });
  const cfgResult = makeCfgResult({ cookieDir, execution, schedule, shops, rules, pending, monitor: { legacyWholeShopCloseEnabled: true } });
  const controller = noAdapters ? null : makeStatefulController({ identity: IDENTITY, ads, ...controllerOpts });
  const reader = noAdapters ? null : makeLinkedReader(controller, { costCents, orders, pageSource: 'promo-page', ...readerDef }, clock ? clock.nowFn : undefined);
  const monitor = new Monitor(cfgResult, noAdapters ? null : { reader, controller }, {
    dataDir,
    nowFn: clock ? clock.nowFn : undefined,
    delayFn: clock ? clock.delayFn : undefined,
  });
  return { monitor, controller, reader, cfgResult, dataDir, cookieDir };
}

// ── 基础停机条件 ─────────────────────────────────────────────────
test('默认未接入：轮询明确停在"尚未接入"，不伪造数据', async (t) => {
  const { monitor } = setup(t, { noAdapters: true });
  const r = await monitor.pollOnce('test');
  assert.strictEqual(r.results[0].status, 'blocked');
  assert.match(r.results[0].reason, /尚未接入/);
  assert.strictEqual(monitor.getStatus().promoReaderConnected, false);
});

test('待配置/非法配置：拒绝启动与轮询', async (t) => {
  const { monitor } = setup(t, { pending: ['promoPage.url: 推广页面网址待配置'] });
  const s = monitor.start();
  assert.strictEqual(s.ok, false);
  assert.match(s.reason, /待配置/);
  const p = await monitor.pollOnce('test');
  assert.strictEqual(p.ok, false);
});

test('Cookie 过期：停止本轮自动操作', async (t) => {
  const { monitor } = setup(t, { expiredCookie: true });
  const r = await monitor.pollOnce('test');
  assert.strictEqual(r.results[0].status, 'stopped');
  assert.match(r.results[0].reason, /已过有效期/);
});

test('Cookie 缺失：停止并说明', async (t) => {
  const { monitor } = setup(t, { missingCookie: true });
  const r = await monitor.pollOnce('test');
  assert.strictEqual(r.results[0].status, 'stopped');
  assert.match(r.results[0].reason, /未找到/);
});

// ── 演练模式 ─────────────────────────────────────────────────────
test('演练模式：全店超标 → 记录"将关闭哪些广告"，绝不执行关闭', async (t) => {
  const { monitor, controller } = setup(t);
  const r = await monitor.pollOnce('test');
  assert.strictEqual(r.results[0].status, 'ok');
  assert.strictEqual(r.results[0].dryRun, true);
  assert.strictEqual(r.results[0].targetCount, 3, '3 个投放中广告（含零消耗）');
  assert.strictEqual(controller.state.closeCalls.length, 0, '演练不关闭');
  const trig = monitor.triggers[0];
  assert.strictEqual(trig.mode, 'dry');
  assert.strictEqual(trig.targetCount, 3);
  assert.match(trig.reason, /全店触发/);
});

test('演练模式：100元/100单恰好等于阈值 → 不触发', async (t) => {
  const { monitor } = setup(t, { costCents: 10000, orders: 100 });
  const r = await monitor.pollOnce('test');
  assert.strictEqual(r.results[0].over, false);
  assert.strictEqual(monitor.triggers.length, 0);
});

test('演练模式：零订单重读仍为 0 → 阻止并明确原因', async (t) => {
  const { monitor, reader } = setup(t, { orders: 0, readerDef: { ordersSequence: [0, 0] } });
  const r = await monitor.pollOnce('test');
  assert.strictEqual(r.results[0].status, 'blocked');
  assert.match(r.results[0].reason, /订单为 0/);
  assert.ok(reader.readOrderSummaryCalls >= 2, '已重读核实');
});

// ── 三源身份核验（Codex 问题 #3 回归）───────────────────────────
test('回归 #3：WRONG_SHOP 费用快照 + 正确控制器身份 → 零触发零关闭', async (t) => {
  const { monitor, controller } = setup(t, { readerDef: { costShopId: 'WRONG_SHOP' } });
  const r = await monitor.pollOnce('test');
  assert.strictEqual(r.results[0].status, 'stopped');
  assert.match(r.results[0].reason, /身份不匹配/);
  assert.strictEqual(monitor.triggers.length, 0);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('三源身份：订单来源店铺不匹配 → 零关闭', async (t) => {
  const { monitor, controller } = setup(t, { readerDef: { orderShopId: 'shop-002' } });
  const r = await monitor.pollOnce('test');
  assert.strictEqual(r.results[0].status, 'stopped');
  assert.match(r.results[0].reason, /身份不匹配|不一致/);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('三源身份：广告清单页店铺不匹配 → 零关闭', async (t) => {
  const { monitor, controller } = setup(t, { readerDef: { adsShopId: 'shop-002' } });
  const r = await monitor.pollOnce('test');
  assert.strictEqual(r.results[0].status, 'blocked', '清单读取失败按 blocked 处理，零关闭');
  assert.match(r.results[0].reason, /身份不匹配/);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

// ── 真实模式 ─────────────────────────────────────────────────────
test('真实模式 + mock 来源：直接拒绝执行', async (t) => {
  const { monitor, controller } = setup(t, { execution: { realMode: true }, readerDef: { pageSource: 'mock' } });
  const r = await monitor.pollOnce('test');
  assert.strictEqual(r.results[0].status, 'stopped');
  assert.match(r.results[0].reason, /禁止使用模拟数据/);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('真实模式 07:59：读取并记录但不关闭（手动检查不绕过时间限制）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '07:59'));
  const { monitor, controller } = setup(t, { execution: { realMode: true }, clock });
  const r = await monitor.pollOnce('manual-ui');
  assert.strictEqual(r.results[0].status, 'window_blocked');
  assert.match(r.results[0].reason, /08:00|手动检查不绕过/);
  assert.strictEqual(controller.state.closeCalls.length, 0);
  assert.ok(monitor.getStatus().monitor.windowBlockReason);
});

test('真实模式 08:00 整：执行全店关闭并回读确认，批次按实际业务日期持久化', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, controller } = setup(t, { execution: { realMode: true }, clock });
  const r = await monitor.pollOnce('interval');
  assert.strictEqual(r.results[0].status, 'ok');
  assert.strictEqual(r.results[0].batch.outcome, 'all_closed_confirmed');
  assert.strictEqual(controller.state.closeCalls.length, 3);
  const rec = monitor.batches['shop-001']['2026-09-12'];
  assert.ok(rec, '批次记录含实际业务日期（Codex 问题 #4）');
  assert.strictEqual(rec.allClosedConfirmed, true);
  assert.deepStrictEqual(rec.totals.confirmed.sort(), ['ad-1001', 'ad-1002', 'ad-1003']);
});

test('真实模式：清单页身份不匹配 → 零关闭（批次被阻止）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, controller } = setup(t, { execution: { realMode: true }, clock, readerDef: { adsShopId: 'shop-002' } });
  const r = await monitor.pollOnce('interval');
  assert.strictEqual(r.results[0].status, 'blocked');
  assert.match(r.results[0].reason, /身份不匹配/);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

// ── 调度循环（门控时钟）──────────────────────────────────────────
test('调度：07:59 启动 → 等待到 08:00 先查一次，随后每 30 分钟', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '07:59'));
  const { monitor } = setup(t, { clock });
  const pollAt = [];
  let polls = 0;
  const orig = monitor.pollOnce.bind(monitor);
  monitor.pollOnce = async (trigger) => {
    const r = await orig(trigger);
    if (trigger === 'interval') {
      polls += 1;
      pollAt.push(clock.now());
    }
    return r;
  };
  monitor.start();
  await waitFor(() => clock.pending() === 1, 2000, '等待08:00的延时挂起');
  assert.strictEqual(monitor.schedule.phase, 'waiting_window');
  clock.releaseOne(); // 07:59 → 08:00
  await waitFor(() => polls === 1 && clock.pending() === 1, 2000, '第一次巡查完成');
  assert.strictEqual(pollAt[0], shanghaiMs('2026-09-12', '08:00'), '08:00 前等待，整点先查');
  clock.releaseOne(); // 08:00 → 08:30
  await waitFor(() => polls === 2, 2000, '第二次巡查完成');
  assert.strictEqual(pollAt[1], shanghaiMs('2026-09-12', '08:30'), '30 分钟后再次巡查');
  monitor.stop();
  clock.releaseAll();
  await monitor._loopPromise;
  assert.strictEqual(polls, 2);
});

test('调度：23:50 巡查后跨午夜 → 等待次日 08:00 再巡查', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '23:50'));
  const { monitor } = setup(t, { clock });
  const pollDates = [];
  let polls = 0;
  const orig = monitor.pollOnce.bind(monitor);
  monitor.pollOnce = async (trigger) => {
    const r = await orig(trigger);
    if (trigger === 'interval') {
      polls += 1;
      pollDates.push(shanghaiDate(clock.now()));
    }
    return r;
  };
  monitor.start();
  await waitFor(() => polls === 1 && clock.pending() === 1, 2000, '23:50 巡查完成');
  // 巡查后循环应进入"跨日等待次日 08:00"状态
  assert.strictEqual(monitor.schedule.waitingFor08, true, '跨日 → 等待次日 08:00');
  assert.strictEqual(new Date(monitor.schedule.nextRunAt).getTime(), shanghaiMs('2026-09-13', '08:00'));
  clock.releaseOne(); // 23:50 → 次日 08:00
  await waitFor(() => polls === 2, 2000, '次日巡查完成');
  assert.deepStrictEqual(pollDates, ['2026-09-12', '2026-09-13']);
  monitor.stop();
  clock.releaseAll();
  await monitor._loopPromise;
});

test('调度：快速停止/重新启动不会产生多个调度循环', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor } = setup(t, { clock });
  let polls = 0;
  const orig = monitor.pollOnce.bind(monitor);
  monitor.pollOnce = async (trigger) => {
    const r = await orig(trigger);
    if (trigger === 'interval') polls += 1;
    return r;
  };
  monitor.start(); // gen1：巡查一次后挂在延时门上
  await waitFor(() => polls === 1 && clock.pending() === 1, 2000, '第一次巡查');
  monitor.stop();  // gen2
  monitor.start(); // gen3：新循环巡查一次后挂起
  await waitFor(() => polls === 2 && clock.pending() === 2, 2000, '新循环第一次巡查');
  monitor.stop();  // gen4
  clock.releaseAll(); // 唤醒所有挂起的旧循环 → 应全部因代数不匹配退出
  await monitor._loopPromise;
  await new Promise((r) => setTimeout(r, 30));
  assert.strictEqual(polls, 2, `不应出现多个调度循环（实际 ${polls} 次）`);
  assert.strictEqual(monitor.running, false);
});

// ── 持久化与跨日（Codex 问题 #4）────────────────────────────────
test('跨日执行：历史已关闭不永久跳过，按最新广告状态决定操作', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, controller } = setup(t, { execution: { realMode: true }, clock });
  await monitor.pollOnce('interval'); // 09-12 关闭全部 3 个
  assert.strictEqual(controller.state.closeCalls.length, 3);

  // 次日 08:05：费用仍超标，但清单显示全部已关闭 → 无需操作，不发请求
  clock.advance(shanghaiMs('2026-09-13', '08:05') - clock.now());
  const r2 = await monitor.pollOnce('interval');
  assert.strictEqual(r2.results[0].batch.outcome, 'nothing_to_close');
  assert.strictEqual(controller.state.closeCalls.length, 3, '已关闭的广告不重复关闭');

  // 人工恢复投放其中一个广告 → 最新清单显示投放中 → 重新关闭
  controller._testSetStatus('ad-1001', '投放中', true);
  const r3 = await monitor.pollOnce('interval');
  assert.strictEqual(r3.results[0].batch.outcome, 'all_closed_confirmed');
  assert.strictEqual(controller.state.closeCalls.length, 4);
  assert.ok(monitor.batches['shop-001']['2026-09-13'], '新日期批次记录独立存在');
});

test('重启恢复：损坏状态文件被隔离重建，监控功能正常', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:00'));
  const { monitor, controller, dataDir, cookieDir } = setup(t, { execution: { realMode: true }, clock });
  await monitor.pollOnce('interval');
  assert.strictEqual(controller.state.closeCalls.length, 3);

  fs.writeFileSync(path.join(dataDir, 'state.json'), '{broken json!!');
  const cfgResult = makeCfgResult({ cookieDir, execution: { realMode: true }, monitor: { legacyWholeShopCloseEnabled: true } });
  const controller2 = makeStatefulController({ identity: IDENTITY, ads: ADS });
  const reader2 = makeLinkedReader(controller2, { costCents: 15001, orders: 100, pageSource: 'promo-page' }, clock.nowFn);
  const monitor2 = new Monitor(cfgResult, { reader: reader2, controller: controller2 }, { dataDir, nowFn: clock.nowFn });
  const st = monitor2.getStatus();
  assert.strictEqual(st.shops[0].batchToday, null, '损坏批次汇总按空状态恢复');
  const corrupt = fs.readdirSync(dataDir).find((f) => f.startsWith('state.json.corrupt-'));
  assert.ok(corrupt, '损坏文件被隔离保留');
  const r = await monitor2.pollOnce('interval');
  assert.strictEqual(r.results[0].batch.outcome, 'all_closed_confirmed');
  assert.strictEqual(controller2.state.closeCalls.length, 3);
});

test('原子写：状态目录无 .tmp 残留', async (t) => {
  const { monitor, dataDir } = setup(t);
  await monitor.pollOnce('test');
  const leftovers = fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp'));
  assert.strictEqual(leftovers.length, 0);
});

// ── 状态快照 ─────────────────────────────────────────────────────
test('getStatus 暴露今日数据/调度/触发', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '09:00'));
  const { monitor } = setup(t, { clock });
  await monitor.pollOnce('test');
  const st = monitor.getStatus();
  assert.strictEqual(st.businessDate, '2026-09-12');
  assert.strictEqual(st.shops[0].today.costText, '150.01 元');
  assert.strictEqual(st.shops[0].today.orders, 100);
  assert.match(st.shops[0].today.perOrderText, /1\.5001/);
  assert.strictEqual(st.shops[0].today.over, true);
  assert.strictEqual(st.monitor.dailyStartHour, 8);
  assert.strictEqual(st.monitor.intervalMinutes, 30);
  assert.strictEqual(st.triggers.length, 1);
});

test('并发防重入：轮询进行中再次触发被跳过', async (t) => {
  const { monitor } = setup(t);
  const slow = monitor.pollOnce('first');
  const second = await monitor.pollOnce('second');
  await slow;
  assert.strictEqual(second.ok, false);
  assert.match(second.reason, /防并发|进行中/);
});
