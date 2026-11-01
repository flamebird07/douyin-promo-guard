'use strict';

/**
 * 隔离测试（第 10 阶段补验证）：当日未完成重试不被窗口外分支覆盖。
 * 缺口（主脑发现，已复现）：首轮执行失败 → nextRunAt=+5min；提前唤醒/时钟回拨使回环
 * 时刻早于 nextRunAt（arrived=false 且 hour>=enableHour）→ 旧代码落入"窗口外"分支，
 * _nextEnableWindowStartMs 把 nextRunAt 覆盖为次日 → 当日重试丢失。
 * 修复：已登记的下次运行仍在未来时不得覆盖，重新等待到该时刻。
 * 覆盖：R1 提前唤醒后重试保留（判别：旧代码失败）；R2 到点前不提前；R3 重试链持续（+5min 链）；
 * R4 全部 success 后登记次日首查窗口（重试链终止）；R5 跨日不补开（重试链跨午夜自然停止 +
 * 凌晨开机记昨日 missed）；R6 手动验证不改自动排程（含重试点场景）。
 * 当前语义（2026-10-09 固化）：上海每日 00:05 后首查、无小时上界（晚开机立即补检查）；
 * 注册即已到点时首轮在登记后立即执行，失败重试 +5min，全部 success 后登记次日 00:05。
 * 可控时钟支持 partialWake（resolve 挂起等待但只推进部分时长 = 模拟提前唤醒/时钟回拨）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor.js');
const { makeTempDir, makeCfgResult } = require('./helpers.js');
const { shanghaiMs } = require('../src/lib/time.js');

const MIN = 60 * 1000;

function miniClock(startMs) {
  let now = startMs;
  const gates = [];
  return {
    nowFn: () => now,
    delayFn: (ms) => new Promise((res) => gates.push({ ms, res })),
    pending: () => gates.length,
    wake: (advanceMs) => { now += advanceMs; for (const g of gates.splice(0)) g.res(); },
    partialWake: (advanceMs) => { now += advanceMs; for (const g of gates.splice(0)) g.res(); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitGated(clock, label, timeout = 3000) {
  const t0 = Date.now();
  while (!clock.pending()) {
    if (Date.now() - t0 > timeout) throw new Error(`waitFor 超时: ${label}`);
    await sleep(10);
  }
  await sleep(60);
}

function buildMonitor({ dataDir, clock, readState }) {
  // 当前产品语义（2026-10-09 起固化）：每日 00:05 后首次检查；enableHour 已废弃，不参与调度。
  // 00:05 后开机即视为已到点（晚开机补检查），无小时上界。
  const cfgResult = makeCfgResult({
    shops: [{ id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true }],
    monitor: { legacyWholeShopCloseEnabled: true, chengfang: { scope: ['全店托管', '商品自选'], firstCheckMinuteOfDay: 5, enableSchedulerEnabled: true } },
  });
  return new Monitor(cfgResult, null, {
    dataDir, nowFn: clock.nowFn, delayFn: clock.delayFn,
    readAdState: readState || (async () => ({ state: 'unknown', switchEvidence: { kind: 'unrecognized_switches', rowsTotal: 2, unrecognizedRows: 1, sampleRowIndexes: [0] } })),
  });
}

function decides(dataDir) {
  const p = path.join(dataDir, 'audit.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.includes('"event":"daily-decide"')).length : 0;
}

test('R1 判别：首轮失败→重试点(+5min)→提前唤醒不覆盖→到点第二次尝试（旧代码重试丢失）', async () => {
  const dataDir = makeTempDir('s10b-');
  // 00:04：当日首查窗口（00:05）尚未打开，登记今日 00:05；推进 1 分钟后执行首轮。
  const clock = miniClock(shanghaiMs('2026-09-29', '00:04'));
  const monitor = buildMonitor({ dataDir, clock }); // 回读恒 unknown → 每轮 failed
  monitor.startEnableScheduler();
  await waitGated(clock, 'registered');
  assert.ok(/T16:05:00\.000Z$/.test(monitor._enableSchedule.nextRunAt), `注册应=00:05，实际 ${monitor._enableSchedule.nextRunAt}`);

  clock.wake(1 * MIN); // → 00:05 首轮执行
  await waitGated(clock, 'first-run-hang');
  assert.equal(decides(dataDir), 1, '首轮应有 1 次 decide');
  const nr1 = monitor._enableSchedule.nextRunAt;
  assert.ok(/T16:10:00\.000Z$/.test(nr1), `失败后应登记 +5min=00:10，实际 ${nr1}`);

  // 提前唤醒：只推进 2 分钟（00:07 < 00:10）——模拟时钟回拨/提前返回
  clock.partialWake(2 * MIN);
  await waitGated(clock, 'early-wake-hang');
  assert.equal(decides(dataDir), 1, '到点前不得提前执行');
  const nr2 = monitor._enableSchedule.nextRunAt;
  assert.ok(/T16:10:00\.000Z$/.test(nr2), `提前唤醒后重试点必须保持 00:10（旧代码被覆盖为次日 → 本断言判别失败），实际 ${nr2}`);

  // 到点：00:10 → 第二次尝试
  clock.wake(3 * MIN); // → 00:10
  await waitGated(clock, 'retry-hang');
  assert.equal(decides(dataDir), 2, '5 分钟到点必须发生第二次尝试（旧代码只等次日 → 判别失败）');
  const nr3 = monitor._enableSchedule.nextRunAt;
  assert.ok(/T16:15:00\.000Z$/.test(nr3), `重试仍失败应再登记 +5min=00:15，实际 ${nr3}`);
  monitor.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' });
});

test('R2 到点前不提前：重试等待期内反复提前唤醒，零额外执行', async () => {
  const dataDir = makeTempDir('s10b-');
  const clock = miniClock(shanghaiMs('2026-09-29', '00:04'));
  const monitor = buildMonitor({ dataDir, clock });
  monitor.startEnableScheduler();
  await waitGated(clock, 'registered');
  clock.wake(1 * MIN); // 00:05 首轮
  await waitGated(clock, 'first-run-hang');
  assert.equal(decides(dataDir), 1);
  for (let i = 0; i < 3; i++) { // 三次提前唤醒（每次 1 分钟）
    clock.partialWake(1 * MIN);
    await waitGated(clock, `early-${i}`);
    assert.equal(decides(dataDir), 1, `提前唤醒 ${i} 不得触发执行`);
  }
  assert.ok(/T16:10:00\.000Z$/.test(monitor._enableSchedule.nextRunAt), `重试点保持 00:10，实际 ${monitor._enableSchedule.nextRunAt}`);
  monitor.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' });
});

test('R3 重试链持续：连续失败轮之间始终 +5min 递进，不跳次日', async () => {
  const dataDir = makeTempDir('s10b-');
  const clock = miniClock(shanghaiMs('2026-09-29', '18:59'));
  const monitor = buildMonitor({ dataDir, clock });
  monitor.startEnableScheduler();
  await waitGated(clock, 'registered');
  clock.wake(1 * MIN); // 19:00
  await waitGated(clock, 'r0');
  for (let round = 1; round <= 3; round++) {
    clock.wake(5 * MIN); // 每轮到点
    await waitGated(clock, `r${round}`);
    assert.equal(decides(dataDir), round + 1, `第 ${round} 轮重试应执行`);
    const hhmm = new Date(monitor._enableSchedule.nextRunAt).toISOString().slice(11, 16);
    const expectMin = 5 + round * 5;
    assert.ok(hhmm.endsWith(String(expectMin).padStart(2, '0')), `第 ${round} 轮后应登记 11:${String(expectMin).padStart(2, '0')}Z，实际 ${monitor._enableSchedule.nextRunAt}`);
  }
  monitor.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' });
});

test('R4 全部 success 后登记次日首查窗口（重试链终止）', async () => {
  const dataDir = makeTempDir('s10b-');
  const clock = miniClock(shanghaiMs('2026-09-29', '18:59'));
  let reads = 0;
  const monitor = buildMonitor({
    dataDir, clock,
    readState: async () => { reads += 1; return reads === 1 ? { state: 'unknown', switchEvidence: { kind: 'unrecognized_switches', rowsTotal: 1, unrecognizedRows: 1, sampleRowIndexes: [0] } } : { state: 'on' }; },
  }); // 第 1 轮 unknown→failed；第 2 轮 on→already_on→success
  monitor.startEnableScheduler();
  await waitGated(clock, 'registered');
  // 晚开机补检查：18:59（>=00:05，无小时上界）注册即已到点 → 首轮立即执行 failed，重试点=+5min=19:04
  assert.equal(decides(dataDir), 1, '晚开机注册即应补首查');
  assert.ok(/T11:04:00\.000Z$/.test(monitor._enableSchedule.nextRunAt), `失败后应登记 +5min=上海 19:04（=T11:04Z），实际 ${monitor._enableSchedule.nextRunAt}`);
  clock.wake(5 * MIN); // → 19:04 第二轮 already_on → success
  await waitGated(clock, 'second');
  assert.equal(monitor.getEnablePhaseRecord('shop-a', '2026-09-29').status, 'success');
  assert.ok(/2026-09-29T16:05:00\.000Z$/.test(monitor._enableSchedule.nextRunAt), `success 后应登记次日首查窗口：上海 09-30 00:05（=2026-09-29T16:05Z），实际 ${monitor._enableSchedule.nextRunAt}`);
  monitor.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' });
});

test('R5 跨日不补开：重试链跨过午夜后自然停止；凌晨开机记昨日 missed、等当日窗口', async () => {
  // 场景 A：23:55 晚开机 → 注册即补首查（failed）→ 重试点落在次日 00:00（窗口关闭段）→
  // 自然停止、不为昨日补开；等到当日 00:05 才按**新日期**执行首查（昨日记录不被改写）。
  const dataDir = makeTempDir('s10b-');
  const clock = miniClock(shanghaiMs('2026-09-29', '23:55'));
  const monitor = buildMonitor({ dataDir, clock }); // 恒 failed
  monitor.startEnableScheduler();
  await waitGated(clock, 'registered');
  assert.equal(decides(dataDir), 1, '23:55 仍在当日窗口（00:05 起无小时上界）：注册即补首查');
  assert.ok(/2026-09-29T16:00:00\.000Z$/.test(monitor._enableSchedule.nextRunAt), `重试点应为次日上海 00:00（=2026-09-29T16:00Z），实际 ${monitor._enableSchedule.nextRunAt}`);
  // 跨日推进：09-30 00:00（首查窗口 00:00–00:04 关闭）→ 不执行、等待当日 00:05
  clock.wake(5 * MIN); // → 09-30 00:00
  await waitGated(clock, 'midnight');
  assert.equal(decides(dataDir), 1, '凌晨窗口关闭段不得执行开启（不为昨日补开）');
  assert.ok(/2026-09-29T16:05:00\.000Z$/.test(monitor._enableSchedule.nextRunAt), `凌晨等待目标=当日上海 00:05（=2026-09-29T16:05Z），实际 ${monitor._enableSchedule.nextRunAt}`);
  // 到当日 00:05：按新日期 09-30 首查（非补开昨日；昨日记录保持 failed）
  clock.wake(5 * MIN); // → 09-30 00:05
  await waitGated(clock, 'newday');
  assert.equal(decides(dataDir), 2, '当日 00:05 窗口开启后执行新一天首查');
  assert.equal(monitor.getEnablePhaseRecord('shop-a', '2026-09-29').status, 'failed', '昨日记录不被改写/补开');
  assert.ok(monitor.getEnablePhaseRecord('shop-a', '2026-09-30'), '跨日后的执行记在新日期名下');
  monitor.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' });

  // 场景 B：昨日整天无任何记录、凌晨 00:02 开机 → 如实记昨日 missed（不擅自补开），等当日 00:05。
  const dataDirB = makeTempDir('s10b-');
  const clockB = miniClock(shanghaiMs('2026-09-30', '00:02'));
  const monitorB = buildMonitor({ dataDir: dataDirB, clock: clockB }); // 恒 failed
  monitorB.startEnableScheduler();
  await waitGated(clockB, 'registered-b');
  assert.equal(decides(dataDirB), 0, '凌晨段不得执行开启（不补开）');
  const es = monitorB.getStatus().monitor.enableScheduler;
  assert.match(es.lastMissedReason || '', /2026-09-29.*错过|错过.*2026-09-29|不擅自补开/, `missed 原因须指向昨日，实际 ${JSON.stringify(es.lastMissedReason)}`);
  assert.equal(monitorB._enableSchedule.lastMissedDate, '2026-09-29', '内部去重标记应为昨日');
  assert.ok(/2026-09-29T16:05:00\.000Z$/.test(monitorB._enableSchedule.nextRunAt), `凌晨等待目标=当日上海 00:05（=2026-09-29T16:05Z），实际 ${monitorB._enableSchedule.nextRunAt}`);
  monitorB.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' });
});

test('R6 手动验证不改自动排程（含重试点场景）', async () => {
  const dataDir = makeTempDir('s10b-');
  const clock = miniClock(shanghaiMs('2026-09-29', '18:59'));
  let reads = 0;
  const monitor = buildMonitor({
    dataDir, clock,
    readState: async () => { reads += 1; return reads <= 1 ? { state: 'unknown', switchEvidence: { kind: 'unrecognized_switches', rowsTotal: 1, unrecognizedRows: 1, sampleRowIndexes: [0] } } : { state: 'on' }; },
  });
  monitor.startEnableScheduler();
  await waitGated(clock, 'registered');
  // 晚开机补检查：注册即首轮 failed → 重试点 19:04（=T11:04Z）
  assert.equal(decides(dataDir), 1, '晚开机注册即应补首查');
  const nr = monitor._enableSchedule.nextRunAt;
  assert.ok(/T11:04:00\.000Z$/.test(nr), `重试点应为上海 19:04（=T11:04Z），实际 ${nr}`);
  // 重试等待期内做一次手动验证（第二读 on → already_on success）——不得改写自动排程
  const r = monitor.runManualEnableVerify('shop-a');
  assert.equal(r.ok, true);
  const t0 = Date.now();
  while (monitor.getManualEnableVerifyStatus().status === 'running' && Date.now() - t0 < 5000) await sleep(20);
  assert.equal(monitor.getManualEnableVerifyStatus().status, 'done');
  assert.equal(monitor._enableSchedule.nextRunAt, nr, '手动验证不得改写自动排程（含重试点）');
  monitor.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' });
});
