'use strict';

/**
 * 隔离测试（第 10 阶段补验证）：当日未完成重试不被窗口外分支覆盖。
 * 缺口（主脑发现，已复现）：首轮执行失败 → nextRunAt=+5min；提前唤醒/时钟回拨使回环
 * 时刻早于 nextRunAt（arrived=false 且 hour>=enableHour）→ 旧代码落入"窗口外"分支，
 * _nextEnableWindowStartMs 把 nextRunAt 覆盖为次日 → 当日重试丢失。
 * 修复：已登记的下次运行仍在未来时不得覆盖，重新等待到该时刻。
 * 覆盖：R1 提前唤醒后重试保留（判别：旧代码失败）；R2 到点前不提前；R3 重试链持续（+5min 链）；
 * R4 全部 success 后登记次日；R5 跨日不补开；R6 手动验证不改自动排程（含重试点场景）。
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

function buildMonitor({ dataDir, clock, enableHour = 19, readState }) {
  const cfgResult = makeCfgResult({
    shops: [{ id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true }],
    monitor: { legacyWholeShopCloseEnabled: true, chengfang: { scope: ['全店托管', '商品自选'], enableHour, enableSchedulerEnabled: true } },
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
  const clock = miniClock(shanghaiMs('2026-09-29', '18:59'));
  const monitor = buildMonitor({ dataDir, clock }); // 回读恒 unknown → 每轮 failed
  monitor.startEnableScheduler();
  await waitGated(clock, 'registered');
  assert.ok(/T11:00:00\.000Z$/.test(monitor._enableSchedule.nextRunAt), `注册应=19:00，实际 ${monitor._enableSchedule.nextRunAt}`);

  clock.wake(1 * MIN); // → 19:00 首轮执行
  await waitGated(clock, 'first-run-hang');
  assert.equal(decides(dataDir), 1, '首轮应有 1 次 decide');
  const nr1 = monitor._enableSchedule.nextRunAt;
  assert.ok(/T11:05:00\.000Z$/.test(nr1), `失败后应登记 +5min=19:05，实际 ${nr1}`);

  // 提前唤醒：只推进 2 分钟（19:02 < 19:05）——模拟时钟回拨/提前返回
  clock.partialWake(2 * MIN);
  await waitGated(clock, 'early-wake-hang');
  assert.equal(decides(dataDir), 1, '到点前不得提前执行');
  const nr2 = monitor._enableSchedule.nextRunAt;
  assert.ok(/T11:05:00\.000Z$/.test(nr2), `提前唤醒后重试点必须保持 19:05（旧代码被覆盖为次日 → 本断言判别失败），实际 ${nr2}`);

  // 到点：19:05 → 第二次尝试
  clock.wake(3 * MIN); // → 19:05
  await waitGated(clock, 'retry-hang');
  assert.equal(decides(dataDir), 2, '5 分钟到点必须发生第二次尝试（旧代码只等次日 → 判别失败）');
  const nr3 = monitor._enableSchedule.nextRunAt;
  assert.ok(/T11:10:00\.000Z$/.test(nr3), `重试仍失败应再登记 +5min=19:10，实际 ${nr3}`);
  monitor.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' });
});

test('R2 到点前不提前：重试等待期内反复提前唤醒，零额外执行', async () => {
  const dataDir = makeTempDir('s10b-');
  const clock = miniClock(shanghaiMs('2026-09-29', '18:59'));
  const monitor = buildMonitor({ dataDir, clock });
  monitor.startEnableScheduler();
  await waitGated(clock, 'registered');
  clock.wake(1 * MIN); // 19:00 首轮
  await waitGated(clock, 'first-run-hang');
  assert.equal(decides(dataDir), 1);
  for (let i = 0; i < 3; i++) { // 三次提前唤醒（每次 1 分钟）
    clock.partialWake(1 * MIN);
    await waitGated(clock, `early-${i}`);
    assert.equal(decides(dataDir), 1, `提前唤醒 ${i} 不得触发执行`);
  }
  assert.ok(/T11:05:00\.000Z$/.test(monitor._enableSchedule.nextRunAt), `重试点保持 19:05，实际 ${monitor._enableSchedule.nextRunAt}`);
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

test('R4 全部 success 后登记次日 enableHour（重试链终止）', async () => {
  const dataDir = makeTempDir('s10b-');
  const clock = miniClock(shanghaiMs('2026-09-29', '18:59'));
  let reads = 0;
  const monitor = buildMonitor({
    dataDir, clock,
    readState: async () => { reads += 1; return reads === 1 ? { state: 'unknown', switchEvidence: { kind: 'unrecognized_switches', rowsTotal: 1, unrecognizedRows: 1, sampleRowIndexes: [0] } } : { state: 'on' }; },
  }); // 第 1 轮 unknown→failed；第 2 轮 on→already_on→success
  monitor.startEnableScheduler();
  await waitGated(clock, 'registered');
  clock.wake(1 * MIN); // 19:00 首轮 failed
  await waitGated(clock, 'first');
  assert.ok(/T11:05:00\.000Z$/.test(monitor._enableSchedule.nextRunAt));
  clock.wake(5 * MIN); // 19:05 第二轮 already_on → success
  await waitGated(clock, 'second');
  assert.equal(monitor.getEnablePhaseRecord('shop-a', '2026-09-29').status, 'success');
  assert.ok(/2026-09-30T11:00:00\.000Z$/.test(monitor._enableSchedule.nextRunAt), `success 后应登记次日 19:00，实际 ${monitor._enableSchedule.nextRunAt}`);
  monitor.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' });
});

test('R5 跨日不补开：重试链跨过午夜后自然停止，次日凌晨记昨日 missed、等次日窗口', async () => {
  const dataDir = makeTempDir('s10b-');
  const clock = miniClock(shanghaiMs('2026-09-29', '23:55'));
  const monitor = buildMonitor({ dataDir, clock }); // 恒 failed
  monitor.startEnableScheduler();
  await waitGated(clock, 'registered');
  assert.ok(/2026-09-30T11:00:00\.000Z$/.test(monitor._enableSchedule.nextRunAt), `23:55 注册：当日 19:00 已过 → 应登记次日 19:00（=2026-09-30T11:00Z），实际 ${monitor._enableSchedule.nextRunAt}`);
  // 次日推进：00:00（凌晨段）→ 应记昨日(09-29) missed 并等 19:00
  clock.wake(5 * MIN); // → 09-30 00:00
  await waitGated(clock, 'midnight');
  const decidesBefore = decides(dataDir);
  assert.equal(decidesBefore, 0, '凌晨段不得执行开启（不补开）');
  const es = monitor.getStatus().monitor.enableScheduler;
  assert.match(es.lastMissedReason || '', /2026-09-29.*错过|错过.*2026-09-29|不擅自补开/, `missed 原因须指向昨日，实际 ${JSON.stringify(es.lastMissedReason)}`);
  assert.equal(monitor._enableSchedule.lastMissedDate, '2026-09-29', '内部去重标记应为昨日');
  assert.ok(/2026-09-30T11:00:00\.000Z$/.test(monitor._enableSchedule.nextRunAt), `凌晨等待目标=当日 19:00，实际 ${monitor._enableSchedule.nextRunAt}`);
  monitor.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' });
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
  clock.wake(1 * MIN); // 19:00 首轮 failed → 重试点 19:05
  await waitGated(clock, 'first');
  const nr = monitor._enableSchedule.nextRunAt;
  assert.ok(/T11:05:00\.000Z$/.test(nr));
  // 重试等待期内做一次手动验证（第二读 on → already_on success）——不得改写自动排程
  const r = monitor.runManualEnableVerify('shop-a');
  assert.equal(r.ok, true);
  const t0 = Date.now();
  while (monitor.getManualEnableVerifyStatus().status === 'running' && Date.now() - t0 < 5000) await sleep(20);
  assert.equal(monitor.getManualEnableVerifyStatus().status, 'done');
  assert.equal(monitor._enableSchedule.nextRunAt, nr, '手动验证不得改写自动排程（含重试点）');
  monitor.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' });
});
