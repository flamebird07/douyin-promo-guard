'use strict';

/**
 * DIAN-6 隔离回归：不启动服务、不访问真实页面、不读取真实 Cookie、不执行真实广告点击。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor');
const { decideAdSwitchAction, DECISION } = require('../src/engine/ad-switch-decision');
const { createWatchDrill } = require('../integrations/bill-manager/watch-drill');
const { makeCfgResult, makeTempDir, waitFor } = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');

const RETRY_MS = 5 * 60 * 1000;
const DAY = '2026-11-03';

function gatedClock(startMs) {
  let now = startMs;
  const waits = [];
  return {
    nowFn: () => now,
    delayFn: (ms) => new Promise((resolve) => waits.push({ ms, resolve })),
    waits,
    releaseOne() {
      const w = waits.shift();
      if (w) { now += w.ms; w.resolve(); }
      return w;
    },
    releaseEarly(ms) {
      const w = waits.shift();
      if (w) { now += ms; w.resolve(); }
      return w;
    },
    set(ms) { now = ms; },
  };
}

function cfg(shops, enableSchedulerEnabled = true) {
  return makeCfgResult({
    shops,
    monitor: {
      legacyWholeShopCloseEnabled: true,
      chengfang: {
        scope: ['全店托管', '商品自选'],
        firstCheckMinuteOfDay: 5,
        enableSchedulerEnabled,
      },
    },
  });
}

function loopMonitor(clock, shops) {
  return new Monitor(cfg(shops), null, {
    dataDir: makeTempDir('enable-loop-late-join-'),
    nowFn: clock.nowFn,
    delayFn: clock.delayFn,
  });
}

async function startLoop(monitor) {
  monitor.enableRunning = true;
  monitor._enableGen += 1;
  const gen = monitor._enableGen;
  const promise = monitor._enableLoop(gen);
  return { gen, promise };
}

async function stopLoop(monitor, clock, promise) {
  monitor.enableRunning = false;
  monitor._enableGen += 1;
  for (const w of clock.waits.splice(0)) w.resolve();
  await promise;
}

test('a/b/h：窗口已开且 nextRunAt 在次日，立即补跑且只含未完成活动店；终态与删除店不重复', async () => {
  const shops = [
    { id: 'pending', name: 'pending', cookieFile: 'pending' },
    { id: 'success', name: 'success', cookieFile: 'success' },
    { id: 'mixed', name: 'mixed', cookieFile: 'mixed' },
    { id: 'exhausted', name: 'exhausted', cookieFile: 'exhausted' },
    { id: 'deleted', name: 'deleted', cookieFile: 'deleted', deleted: true },
  ];
  const clock = gatedClock(shanghaiMs(DAY, '10:00'));
  const m = loopMonitor(clock, shops);
  m._setEnablePhase('success', DAY, 'success');
  m._setEnablePhase('mixed', DAY, 'mixed_converged');
  m._setEnablePhase('exhausted', DAY, 'exhausted');
  m._enableSchedule.nextRunAt = new Date(shanghaiMs('2026-11-04', '00:05')).toISOString();
  const calls = [];
  m._runEnablePhase = async (_gen, date) => {
    calls.push(m._activeShops().filter((s) => !m._enablePhaseDone(s.id, date)).map((s) => s.id));
    m._setEnablePhase('pending', date, 'success');
  };

  const { promise } = await startLoop(m);
  await waitFor(() => calls.length === 1 && clock.waits.length === 1, 2000, 'late join 进入首查');
  assert.deepStrictEqual(calls, [['pending']]);
  assert.ok(clock.waits[0].ms <= RETRY_MS, `单次等待不得超过 5 分钟，实际 ${clock.waits[0].ms}`);
  await stopLoop(m, clock, promise);
});

test('c：无未完成店时分段等待（每段≤5分钟），新活动店加入后下一醒来重新判定', async () => {
  const shops = [{ id: 'done', name: 'done', cookieFile: 'done' }];
  const clock = gatedClock(shanghaiMs(DAY, '10:00'));
  const m = loopMonitor(clock, shops);
  m._setEnablePhase('done', DAY, 'success');
  m._enableSchedule.nextRunAt = new Date(shanghaiMs('2026-11-04', '00:05')).toISOString();
  const calls = [];
  m._runEnablePhase = async (_gen, date) => {
    calls.push(m._activeShops().filter((s) => !m._enablePhaseDone(s.id, date)).map((s) => s.id));
    m._setEnablePhase('late', date, 'success');
  };

  const { promise } = await startLoop(m);
  await waitFor(() => clock.waits.length === 1, 2000, '等待次日窗口');
  assert.equal(calls.length, 0);
  assert.ok(clock.waits[0].ms <= RETRY_MS);
  m.config.shops.push({ id: 'late', name: 'late', cookieFile: 'late' });
  clock.releaseOne();
  await waitFor(() => calls.length === 1, 2000, '醒来重判新店');
  assert.deepStrictEqual(calls[0], ['late']);
  await stopLoop(m, clock, promise);
});

test('d：00:05 前绝不提前；到首查边界后的首次醒来才执行', async () => {
  const clock = gatedClock(shanghaiMs(DAY, '00:04'));
  const m = loopMonitor(clock, [{ id: 'shop', name: 'shop', cookieFile: 'shop' }]);
  m._enableSchedule.nextRunAt = new Date(shanghaiMs(DAY, '00:05')).toISOString();
  let calls = 0;
  m._runEnablePhase = async (_gen, date) => { calls += 1; m._setEnablePhase('shop', date, 'success'); };
  const { promise } = await startLoop(m);
  await waitFor(() => clock.waits.length === 1, 2000, '00:05 前等待');
  assert.equal(calls, 0);
  assert.ok(clock.waits[0].ms <= RETRY_MS);
  clock.releaseOne();
  await waitFor(() => calls === 1, 2000, '00:05 到点执行');
  await stopLoop(m, clock, promise);
});

test('重试安全：未完成店已有同日 +5 分钟 retryAt 时，提前唤醒不得提前执行', async () => {
  const clock = gatedClock(shanghaiMs(DAY, '10:00'));
  const m = loopMonitor(clock, [{ id: 'shop', name: 'shop', cookieFile: 'shop' }]);
  m._enableSchedule.nextRunAt = new Date(shanghaiMs(DAY, '10:05')).toISOString();
  let calls = 0;
  m._runEnablePhase = async () => { calls += 1; };
  const { promise } = await startLoop(m);
  await waitFor(() => clock.waits.length === 1, 2000, '等待合法重试点');
  assert.equal(calls, 0);
  assert.equal(clock.waits[0].ms, RETRY_MS);
  clock.releaseEarly(2 * 60 * 1000);
  await waitFor(() => clock.waits.length === 1, 2000, '提前唤醒后继续等待');
  assert.equal(calls, 0, '提前唤醒不得绕过同日 retryAt');
  assert.equal(clock.waits[0].ms, 3 * 60 * 1000);
  await stopLoop(m, clock, promise);
});

test('e/f：回读 unknown、费用超阈值与 0 单规则 C 均不会给出开启动作', () => {
  const base = { costCents: 5000, orders: 100, thresholdCents: 100, currentAdState: 'off', identityOk: true };
  const unknown = decideAdSwitchAction({ ...base, currentAdState: 'unknown' });
  assert.equal(unknown.decision, DECISION.UNKNOWN_BLOCKED);
  assert.equal(unknown.zeroClick, true);
  const over = decideAdSwitchAction({ ...base, costCents: 10001, currentAdState: 'on' });
  assert.equal(over.decision, DECISION.SHOULD_PAUSE);
  assert.notEqual(over.action, 'enable');
  const zero = decideAdSwitchAction({ ...base, orders: 0, currentAdState: 'mixed' });
  assert.equal(zero.decision, DECISION.ZERO_ORDER_NO_PAUSE);
  assert.equal(zero.action, null);
  assert.equal(zero.zeroClick, true);
});

test('g/h：mixed+window_blocked 连续三轮仅一次 audit/notify；第4轮不重复，删除会清 streak', async () => {
  const dataDir = makeTempDir('mixed-stuck-gate-');
  const sent = [];
  const clock = { nowFn: () => shanghaiMs(DAY, '10:00') };
  const config = cfg([{ id: 'shop', name: '测试店', cookieFile: 'shop' }], false).config;
  const drill = createWatchDrill({
    config,
    dataDir,
    nowFn: clock.nowFn,
    autostartOnBoot: false,
    notify: { enabled: true, target: 'feishu:test-chat', timeoutMs: 1000 },
    notifySpawn: (args, input) => { sent.push({ args, input }); return Promise.resolve({ code: 0 }); },
  });
  drill.boot();
  const m = drill._internal._monitor;
  let clicks = 0;
  m._pollShop = async () => ({
    status: 'window_blocked', currentAdState: 'mixed', businessDate: DAY,
    zeroClick: true, clicks,
  });

  await m.pollOnce('mixed-1');
  await m.pollOnce('mixed-2');
  assert.equal(m.processEvents.filter((e) => e.step === 'mixed-stuck-gate').length, 0);
  await m.pollOnce('mixed-3');
  await m.pollOnce('mixed-4');
  assert.equal(clicks, 0);
  assert.equal(m.processEvents.filter((e) => e.kind === 'poll' && e.step === 'mixed-stuck-gate').length, 1);
  drill.sync();
  await waitFor(() => sent.length === 1, 2000, 'mixed 告警通知');
  assert.ok(sent[0].args.includes('feishu:test-chat'));
  assert.match(sent[0].args[sent[0].args.indexOf('--subject') + 1], /mixed 连续 3 轮/);
  assert.match(sent[0].input, /仅告警与审计，未自动点击/);
  drill.sync();
  assert.equal(sent.length, 1, '同店同日第 4 轮及重复消费不得再次通知');

  // 删除店会清除尚未达到三轮的连续计数；恢复后必须重新累计三轮。
  const otherDir = makeTempDir('mixed-stuck-delete-');
  const m2 = new Monitor(cfg([{ id: 'shop', name: 'shop', cookieFile: 'shop' }]), null, {
    dataDir: otherDir, nowFn: clock.nowFn,
  });
  m2._pollShop = m._pollShop;
  await m2.pollOnce('d1');
  await m2.pollOnce('d2');
  m2.config.shops[0].deleted = true;
  await m2.pollOnce('deleted');
  m2.config.shops[0].deleted = false;
  await m2.pollOnce('r1');
  assert.equal(m2.processEvents.filter((e) => e.step === 'mixed-stuck-gate').length, 0);
  await m2.pollOnce('r2');
  await m2.pollOnce('r3');
  assert.equal(m2.processEvents.filter((e) => e.step === 'mixed-stuck-gate').length, 1);

  const auditLines = fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8')
    .split('\n').filter((line) => line.includes('mixed-stuck-gate'));
  assert.equal(auditLines.length, 1);
  drill.stop();
});
