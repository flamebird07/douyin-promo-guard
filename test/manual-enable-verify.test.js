'use strict';

/**
 * 隔离测试（第 10 阶段）：每日开启窗口去 dailyStartHour 上界 + 手动验证入口。
 * - W1/W2/W3：独立调度循环——enableHour 晚于 dailyStartHour（19 点）时到点执行（旧代码空窗口，
 *   判别）；启动已过点不倒补；当日 success 后登记次日（排程不被手动验证改写见 M6）。
 * - M1–M7：手动验证入口（runManualEnableVerify）——同一开启预检链、任意时刻、异步可回读、
 *   当日去重、互斥拒绝、并发拒绝、unknown 零点击、不改自动排程。
 * - G1–G8：chengfang-gate 请求门——daily_schedule 去上界、manual_verify 任意时刻放行但
 *   保留 realMode/停止/非法来源门槛、threshold_recovery/pause 语义不回归。
 * 不访问真实页面：乘方会话经 opts.chengfangOpener 注入假对象（零点击计数）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor.js');
const { buildChengfangRequestGate } = require('../src/engine/chengfang-gate.js');
const { makeTempDir, makeCfgResult, makeClock, waitFor } = require('./helpers.js');
const { shanghaiMs } = require('../src/lib/time.js');

const TAB_MAIN = '全店托管';
const TAB_SUB = '商品自选';
const ON_VIEWS = { [TAB_MAIN]: [{ rows: [{ id: 'p1', switchChecked: true }] }], [TAB_SUB]: [{ rows: [] }] };
const OFF_VIEWS = { [TAB_MAIN]: [{ rows: [{ id: 'p1', switchChecked: false }] }], [TAB_SUB]: [{ rows: [] }] };
const UNKNOWN_VIEWS = { [TAB_MAIN]: [{ rows: [{ id: 'p1', switchChecked: true }, { id: 'p2', switchChecked: null }] }], [TAB_SUB]: [{ rows: [] }] };

/** 假乘方会话（零点击计数；hangOn='readView' 第 1 次读取挂起，用于并发手动测试）。 */
function makeFake({ shopId = 'shop-a', views, hangOn = null } = {}) {
  const calls = { opener: 0, identity: 0, readView: 0, click: 0 };
  const browsers = [];
  const opener = async () => {
    calls.opener += 1;
    const browser = { closed: false, hanging: [] };
    browsers.push(browser);
    const page = { browser: () => browser, evaluate: async () => null };
    const perTabPage = {};
    const controller = {
      async verifyIdentity() {
        calls.identity += 1;
        if (browser.closed) throw new Error('Target closed');
        return { ok: true, pageShopId: shopId, pageShopName: shopId };
      },
      async refreshView() { if (browser.closed) throw new Error('Target closed'); return { refreshed: true }; },
      async switchView() { if (browser.closed) throw new Error('Target closed'); },
      async readView({ tab }) {
        calls.readView += 1;
        if (browser.closed) throw new Error('Target closed');
        if (hangOn === 'readView' && calls.readView === 1) return new Promise((_, reject) => browser.hanging.push({ reject }));
        const list = views[tab] || [{ rows: [] }];
        const p = list[Math.min(perTabPage[tab] || 0, list.length - 1)];
        perTabPage[tab] = (perTabPage[tab] || 0) + 1;
        const total = views[tab].reduce((n, pg) => n + pg.rows.length, 0);
        return { rows: { rows: p.rows.map((x) => ({ ...x })) }, pagination: { total, hasNext: false, activePage: '1' } };
      },
      async clickNextPage() { calls.click += 1; return { clicked: true }; },
      async clickBatchPause() { calls.click += 1; return {}; },
      async clickBatchEnable() { calls.click += 1; return {}; },
      async clickRowSwitch() { calls.click += 1; return {}; },
    };
    browser.close = async () => { browser.closed = true; for (const x of browser.hanging.splice(0)) x.reject(new Error('Target closed')); };
    return { browser, page, controller, account: null, context: null, cookieSession: null };
  };
  return { opener, calls, browsers };
}

function buildMonitor({ dataDir, openerFn, clock, enableHour = 7 }) {
  const cfgResult = makeCfgResult({
    shops: [
      { id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true },
      { id: 'shop-b', name: 'shop-b', cookieFile: 'shop-b', accountId: null, enabled: true },
    ],
    monitor: { legacyWholeShopCloseEnabled: true, chengfang: { scope: [TAB_MAIN, TAB_SUB], enableHour, enableSchedulerEnabled: true, pauseEnabled: true, enableEnabled: true } },
  });
  return new Monitor(cfgResult, null, {
    dataDir,
    chengfangOpener: openerFn,
    nowFn: clock ? clock.nowFn : undefined,
    delayFn: clock ? clock.delayFn : undefined,
  });
}

function auditList(dataDir) {
  const p = path.join(dataDir, 'audit.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

// ── W 系列：独立调度循环窗口语义 ────────────────────────────────────

test('W1 判别：enableHour=19（晚于 dailyStartHour=8）到点执行开启相位（旧代码空窗口不执行）', async () => {
  const dataDir = makeTempDir('stage10-');
  const clock = makeClock(shanghaiMs('2026-09-29', '18:59'));
  const fakeA = makeFake({ shopId: 'shop-a', views: ON_VIEWS });
  const fakeB = makeFake({ shopId: 'shop-b', views: ON_VIEWS });
  const monitor = buildMonitor({
    dataDir, clock, enableHour: 19,
    openerFn: async (args) => (args.shopCfg.id === 'shop-a' ? fakeA.opener() : fakeB.opener()),
  });
  const r = monitor.startEnableScheduler();
  assert.equal(r.ok, true);
  assert.ok(/2026-09-29T11:00:00.000Z$/.test(r.nextRunAt), `登记应为当日 19:00，实际 ${r.nextRunAt}`);
  clock.releaseOne(); // 推进到 19:00，循环醒来进入窗口
  await waitFor(() => fakeA.calls.opener + fakeB.calls.opener >= 2, 3000, '到点应执行开启相位');
  const decide = auditList(dataDir).find((j) => j.event === 'daily-decide' && j.shopId === 'shop-a');
  assert.ok(decide, '应有 daily-decide（旧代码 19 点不在 [7,8) 窗口，不执行 → 本用例判别失败）');
  assert.equal(decide.currentAdState, 'on');
  assert.equal(decide.decision, 'already_on');
  assert.equal(decide.trigger, 'daily_schedule');
  assert.equal(monitor.getEnablePhaseRecord('shop-a', '2026-09-29').status, 'success');
  await waitFor(() => monitor._enableSchedule.phase === 'waiting_window', 2000, '执行完应回到等待');
  assert.ok(/2026-09-30T11:00:00.000Z$/.test(monitor._enableSchedule.nextRunAt), `全部成功后应登记次日 19:00，实际 ${monitor._enableSchedule.nextRunAt}`);
  monitor.stopEnableScheduler({ byUser: false });
});

test('W2 启动已过点不倒补：15:00 启动（enableHour=7）→ 登记次日，不执行', async () => {
  const dataDir = makeTempDir('stage10-');
  const clock = makeClock(shanghaiMs('2026-09-29', '15:00'));
  const fake = makeFake({ shopId: 'shop-a', views: ON_VIEWS });
  const monitor = buildMonitor({ dataDir, clock, enableHour: 7, openerFn: fake.opener });
  const r = monitor.startEnableScheduler();
  assert.equal(r.ok, true);
  assert.ok(/2026-09-29T23:00:00.000Z$/.test(r.nextRunAt), `过点启动应登记次日 07:00 上海（=2026-09-29T23:00Z），实际 ${r.nextRunAt}`);
  // 不推进时钟：当天（15:00 起）循环应保持等待、零执行（不倒补）
  await new Promise((res) => setTimeout(res, 120));
  assert.equal(fake.calls.opener, 0, '不得擅自补发历史开启');
  assert.equal(auditList(dataDir).filter((j) => j.event === 'daily-decide').length, 0);
  monitor.stopEnableScheduler({ byUser: false });
});

test('W3 窗口未到点不提前：6:59 启动（enableHour=7）→ 等 7:00 才执行', async () => {
  const dataDir = makeTempDir('stage10-');
  const clock = makeClock(shanghaiMs('2026-09-29', '06:59'));
  const fake = makeFake({ shopId: 'shop-a', views: ON_VIEWS });
  const fakeB = makeFake({ shopId: 'shop-b', views: ON_VIEWS });
  const monitor = buildMonitor({
    dataDir, clock, enableHour: 7,
    openerFn: async (args) => (args.shopCfg.id === 'shop-a' ? fake.opener() : fakeB.opener()),
  });
  monitor.startEnableScheduler();
  clock.releaseOne(); // → 07:00
  await waitFor(() => fake.calls.opener >= 1, 3000, '到点应执行');
  const decide = auditList(dataDir).find((j) => j.event === 'daily-decide' && j.shopId === 'shop-a');
  assert.ok(decide && decide.decision === 'already_on');
  monitor.stopEnableScheduler({ byUser: false });
});

// ── M 系列：手动验证入口 ────────────────────────────────────────────

test('M1 判别：白天 10:00 手动验证 → 同一开启预检链（回读/决策/审计 trigger=manual_verify/零点击）', async () => {
  const dataDir = makeTempDir('stage10-');
  const clock = makeClock(shanghaiMs('2026-09-29', '10:00'));
  const fake = makeFake({ shopId: 'shop-a', views: ON_VIEWS });
  const monitor = buildMonitor({ dataDir, clock, enableHour: 7, openerFn: fake.opener });
  const r = monitor.runManualEnableVerify('shop-a');
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.started, true);
  await waitFor(() => monitor.getManualEnableVerifyStatus().status === 'done', 5000, '手动验证应完成');
  const mv = monitor.getManualEnableVerifyStatus();
  assert.equal(mv.status, 'done');
  assert.equal(mv.result.decision, 'already_on');
  assert.equal(mv.result.zeroClick, true);
  const audits = auditList(dataDir);
  const decide = audits.find((j) => j.event === 'daily-decide' && j.shopId === 'shop-a');
  assert.ok(decide, '应有 daily-decide（旧代码无手动入口 → 本用例判别失败）');
  assert.equal(decide.trigger, 'manual_verify');
  assert.equal(decide.currentAdState, 'on');
  assert.ok(audits.some((j) => j.event === 'manual-verify-start') && audits.some((j) => j.event === 'manual-verify-done'));
  assert.equal(monitor.getEnablePhaseRecord('shop-a', '2026-09-29').status, 'success');
  assert.equal(fake.calls.click, 0, 'already_on 零点击');
  assert.equal(monitor._cycleRunning, false, '完成后互斥释放');
});

test('M2 当日去重：已 success 后再次手动验证 → 拒绝且不再开启会话', async () => {
  const dataDir = makeTempDir('stage10-');
  const clock = makeClock(shanghaiMs('2026-09-29', '10:00'));
  const fake = makeFake({ shopId: 'shop-a', views: ON_VIEWS });
  const monitor = buildMonitor({ dataDir, clock, enableHour: 7, openerFn: fake.opener });
  await monitor.runManualEnableVerify('shop-a');
  await waitFor(() => monitor.getManualEnableVerifyStatus().status === 'done', 5000);
  const openerBefore = fake.calls.opener;
  const r2 = monitor.runManualEnableVerify('shop-a');
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'already_done_today');
  assert.equal(r2.alreadyDone, true);
  assert.equal(fake.calls.opener, openerBefore, '去重拒绝后不得再开会话');
});

test('M3 在途互斥：巡查/开启周期进行中 → 拒绝（不等待）', async () => {
  const dataDir = makeTempDir('stage10-');
  const clock = makeClock(shanghaiMs('2026-09-29', '10:00'));
  const fake = makeFake({ shopId: 'shop-a', views: ON_VIEWS });
  const monitor = buildMonitor({ dataDir, clock, enableHour: 7, openerFn: fake.opener });
  monitor._cycleRunning = true; // 模拟巡查在途
  const r = monitor.runManualEnableVerify('shop-a');
  assert.equal(r.ok, false);
  assert.equal(r.code, 'cycle_busy');
  assert.equal(fake.calls.opener, 0);
  monitor._cycleRunning = false;
});

test('M4 并发手动拒绝：手动验证运行中再触发 → manual_busy', async () => {
  const dataDir = makeTempDir('stage10-');
  const clock = makeClock(shanghaiMs('2026-09-29', '10:00'));
  const fake = makeFake({ shopId: 'shop-a', views: ON_VIEWS, hangOn: 'readView' });
  const monitor = buildMonitor({ dataDir, clock, enableHour: 7, openerFn: fake.opener });
  const r1 = monitor.runManualEnableVerify('shop-a');
  assert.equal(r1.ok, true);
  const r2 = monitor.runManualEnableVerify('shop-a');
  assert.equal(r2.ok, false);
  assert.equal(r2.code, 'manual_busy');
  assert.equal(fake.calls.opener, 1, '并发拒绝后不得开第二个会话');
  // 释放挂起读取，让异步任务收尾
  for (const b of fake.browsers) await b.close().catch(() => {});
  await waitFor(() => monitor.getManualEnableVerifyStatus().status !== 'running', 5000);
});

test('M5 unknown 零点击：开关不可识别 → fail-closed 跳过、enablePhase failed、手动状态可回读', async () => {
  const dataDir = makeTempDir('stage10-');
  const clock = makeClock(shanghaiMs('2026-09-29', '21:00'));
  const fake = makeFake({ shopId: 'shop-a', views: UNKNOWN_VIEWS });
  const monitor = buildMonitor({ dataDir, clock, enableHour: 7, openerFn: fake.opener });
  const r = monitor.runManualEnableVerify('shop-a');
  assert.equal(r.ok, true);
  await waitFor(() => monitor.getManualEnableVerifyStatus().status === 'done', 5000);
  const mv = monitor.getManualEnableVerifyStatus();
  assert.equal(mv.result.decision, 'unknown_blocked');
  assert.equal(mv.result.zeroClick, true);
  assert.equal(monitor.getEnablePhaseRecord('shop-a', '2026-09-29').status, 'failed');
  assert.equal(monitor.getEnablePhaseRecord('shop-a', '2026-09-29').phase, 'precheck');
  assert.equal(fake.calls.click, 0);
  const decide = auditList(dataDir).find((j) => j.event === 'daily-decide' && j.shopId === 'shop-a');
  assert.equal(decide.trigger, 'manual_verify');
  assert.ok(decide.readNote && decide.readNote.unrecognizedRows === 1, 'B 类证据应随审计透出');
});

test('M6 不改自动排程：手动验证完成前后 _enableSchedule.nextRunAt 不变', async () => {
  const dataDir = makeTempDir('stage10-');
  const clock = makeClock(shanghaiMs('2026-09-29', '10:00'));
  const fake = makeFake({ shopId: 'shop-a', views: ON_VIEWS });
  const monitor = buildMonitor({ dataDir, clock, enableHour: 7, openerFn: fake.opener });
  monitor.startEnableScheduler();
  const before = monitor._enableSchedule.nextRunAt;
  await monitor.runManualEnableVerify('shop-a');
  await waitFor(() => monitor.getManualEnableVerifyStatus().status === 'done', 5000);
  assert.equal(monitor._enableSchedule.nextRunAt, before, '手动验证不得改写自动排程');
  monitor.stopEnableScheduler({ byUser: false });
});

test('M7 店铺校验：不存在/未启用的店铺拒绝；off 回读 → should_enable（同一决策链）', async () => {
  const dataDir = makeTempDir('stage10-');
  const clock = makeClock(shanghaiMs('2026-09-29', '10:00'));
  const fake = makeFake({ shopId: 'shop-a', views: OFF_VIEWS });
  const monitor = buildMonitor({ dataDir, clock, enableHour: 7, openerFn: fake.opener });
  const bad = monitor.runManualEnableVerify('no-such-shop');
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'shop_not_active');
  const r = monitor.runManualEnableVerify('shop-a');
  assert.equal(r.ok, true);
  await waitFor(() => monitor.getManualEnableVerifyStatus().status === 'done', 8000);
  const mv = monitor.getManualEnableVerifyStatus();
  assert.equal(mv.result.decision, 'should_enable', 'off 应回 should_enable（执行链受 realMode=false 走演练，零真实点击）');
  assert.equal(fake.calls.click, 0);
});

// ── G 系列：请求门（buildChengfangRequestGate）───────────────────────

const GATE_CFG = {
  execution: { realMode: true, dryRun: false },
  monitor: { chengfang: { enableEnabled: true, pauseEnabled: true, enableHour: 19 } },
  schedule: { dailyStartHour: 8 },
};
const GATE_CFG_DRY = { ...GATE_CFG, execution: { realMode: true, dryRun: true } };

function gateAt(cfg, hourMin, opts = {}) {
  const g = buildChengfangRequestGate({
    config: cfg,
    nowFn: () => shanghaiMs('2026-09-29', hourMin),
    businessDate: '2026-09-29',
    action: 'enable',
    ...opts,
  });
  return g();
}

test('G1 daily_schedule 去上界：19:30 与 23:30 放行（旧代码拒）', () => {
  assert.equal(gateAt(GATE_CFG, '19:30', { enableSource: 'daily_schedule' }).ok, true);
  assert.equal(gateAt(GATE_CFG, '23:30', { enableSource: 'daily_schedule' }).ok, true);
});

test('G2 daily_schedule 未到点拒绝：18:59（enableHour=19）', () => {
  const r = gateAt(GATE_CFG, '18:59', { enableSource: 'daily_schedule' });
  assert.equal(r.ok, false);
  assert.ok(/未到允许开启时段/.test(r.reason));
});

test('G3 manual_verify 任意时刻放行：10:00 / 23:30 / 01:00', () => {
  assert.equal(gateAt(GATE_CFG, '10:00', { enableSource: 'manual_verify' }).ok, true);
  assert.equal(gateAt(GATE_CFG, '23:30', { enableSource: 'manual_verify' }).ok, true);
  assert.equal(gateAt(GATE_CFG, '01:00', { enableSource: 'manual_verify' }).ok, true);
});

test('G4 manual_verify 仍受配置门禁：dryRun=true 拒绝', () => {
  const r = gateAt(GATE_CFG_DRY, '10:00', { enableSource: 'manual_verify' });
  assert.equal(r.ok, false);
  assert.ok(/演练/.test(r.reason));
});

test('G5 manual_verify 停止信号拒绝', () => {
  const r = gateAt(GATE_CFG, '10:00', { enableSource: 'manual_verify', stopRequested: () => true });
  assert.equal(r.ok, false);
  assert.ok(/停止信号/.test(r.reason));
});

test('G6 threshold_recovery 语义不回归：07:00 拒、08:01 放行', () => {
  assert.equal(gateAt(GATE_CFG, '07:00', { enableSource: 'threshold_recovery' }).ok, false);
  assert.equal(gateAt(GATE_CFG, '08:01', { enableSource: 'threshold_recovery' }).ok, true);
});

test('G7 非法来源拒绝', () => {
  const r = gateAt(GATE_CFG, '10:00', { enableSource: 'hack' });
  assert.equal(r.ok, false);
  assert.ok(/未知开启来源/.test(r.reason));
});

test('G8 暂停门槛不回归：07:00 拒（isAfterDailyStart 语义）', () => {
  const g = buildChengfangRequestGate({
    config: GATE_CFG,
    nowFn: () => shanghaiMs('2026-09-29', '07:00'),
    businessDate: '2026-09-29',
    action: 'pause',
  });
  assert.equal(g().ok, false);
});
