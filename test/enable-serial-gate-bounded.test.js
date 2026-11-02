'use strict';

/**
 * fix2：瑾漂亮形态（enable + serial_gate + ad=mixed）的有界收口。
 *
 * 复现的生产形态（state.json）：旧 enable 动作因进程重启恢复为 unknown 阻塞槽；
 * 每轮首查回读恒为 mixed —— 既不能确认目标 on（不满足 unknown 释放条件），也不是全量 off
 * （不满足「目标未达成」结案），于是每 5 分钟被串行门拒绝一次，当日无限重试、跨日也不收敛。
 *
 * 期望（本测试锁定）：
 *   - 达到有界上限（3 次尝试 / 30 分钟等待，任一）→ 相位落 'exhausted' 终态，
 *     旧槽按 unknown_expired（未确认）结案并释放串行门，本轮零点击，今日不再自动补点；
 *   - 未达上限 → 行为不变（unknown + blocked=serial_gate，继续有界重试）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor.js');
const { makeTempDir, makeCfgResult } = require('./helpers.js');

const SHOP = 'shop-a';
const SLOT_ACTION_ID = 'act_1793552524247_3'; // 与生产瑾漂亮 unknown enable 槽同形
const DAY = '2026-11-02';

/** mixed 清单：一行 on、一行 off → 归一态 mixed（既非目标 on，也非全量 off）。 */
const MIXED_READ = {
  state: 'mixed',
  rows: [{ id: 'p1', switchChecked: true }, { id: 'p2', switchChecked: false }],
  identity: { ok: true },
};

function seedSlot(dataDir, { startedAt, action = 'enable' }) {
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
    version: 1,
    batches: {},
    enablePhase: {},
    adBelief: {},
    enableScheduler: {},
    switchSlots: {
      slots: [{
        shopId: SHOP, action, actionId: SLOT_ACTION_ID,
        startedAt: startedAt == null ? Date.now() : startedAt,
        confirmed: false, settled: false, unknown: false, blockedReason: null,
      }],
    },
    savedAt: new Date().toISOString(),
  }));
}

function buildMonitor(dataDir, { read = MIXED_READ } = {}) {
  const cfgResult = makeCfgResult({
    shops: [{ id: SHOP, name: SHOP, cookieFile: SHOP, accountId: null, enabled: true }],
    monitor: { legacyWholeShopCloseEnabled: true, chengfang: { scope: ['全店托管', '商品自选'] } },
  });
  return new Monitor(cfgResult, null, { dataDir, readAdState: async () => read });
}

function audits(dataDir) {
  const p = path.join(dataDir, 'audit.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

async function runPhase(monitor) {
  return monitor._runShopEnablePhase(
    { id: SHOP, name: SHOP },
    { aborted: false, kind: 'enable' },
    DAY,
    'daily_schedule',
  );
}

test('M1 旧槽等待超界 + 回读 mixed → 落 exhausted 终态、未确认结案、今日不再重试', async () => {
  const dataDir = makeTempDir('fix2-');
  seedSlot(dataDir, { startedAt: Date.now() - 2 * 60 * 60 * 1000 }); // 2 小时前（远超 30 分钟）
  const monitor = buildMonitor(dataDir);
  const orch = monitor._switchOrchestrator;
  assert.equal(orch.hasUnknownBlock(SHOP), true, '预置应为 unknown 阻塞');

  const r = await runPhase(monitor);

  assert.equal(r.status, 'exhausted', JSON.stringify(r));
  assert.equal(r.exhausted, true);
  assert.equal(r.zeroClick, true, '有界收口轮不得点击');
  assert.equal(r.blocked, 'serial_gate_bounded');
  assert.equal(orch.hasUnknownBlock(SHOP), false, '旧槽已按未确认终态结案，不再阻塞');
  assert.equal(orch.isBusy(SHOP), false, '串行门已释放');

  const rec = monitor.getEnablePhaseRecord(SHOP, DAY);
  assert.equal(rec.status, 'exhausted');
  assert.equal(rec.blocked, 'serial_gate_bounded');
  assert.equal(rec.settledAs, 'unknown_expired');
  assert.equal(rec.oldEnableActionId, SLOT_ACTION_ID);
  assert.ok(rec.serialGateAttempts >= 1);
  assert.match(rec.reason, /有界收口/);
  assert.match(rec.reason, /未确认/);
  assert.equal(monitor._enablePhaseDone(SHOP, DAY), true, 'exhausted 属当日终态，禁止再自动补点');

  const evs = audits(dataDir);
  const bounded = evs.find((e) => e.step === 'serial-gate-bounded');
  assert.ok(bounded && bounded.ok === true, JSON.stringify(evs.filter((e) => e.step).map((e) => e.step)));
  assert.equal(bounded.settledAs, 'unknown_expired');
  assert.equal(bounded.confirmed, false, '审计不得声明已确认');
  assert.ok(evs.some((e) => e.step === 'expire-unknown' && e.ok === true), '须走唯一收口入口并留审计');

  // 终态已落盘：state.json 无未决槽位
  const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  assert.equal((st.switchSlots.slots || []).filter((x) => x.settled !== true).length, 0, JSON.stringify(st.switchSlots));
  assert.equal(st.enablePhase[SHOP][DAY].status, 'exhausted');
  monitor.stop();
});

test('M2 未达上限（新槽 + 首次尝试）→ 行为不变：unknown + serial_gate 有界重试', async () => {
  const dataDir = makeTempDir('fix2-');
  seedSlot(dataDir, { startedAt: Date.now() });
  const monitor = buildMonitor(dataDir);
  const orch = monitor._switchOrchestrator;

  const r = await runPhase(monitor);

  assert.notEqual(r.status, 'exhausted', `未达上限不得收口：${JSON.stringify(r)}`);
  assert.equal(orch.hasUnknownBlock(SHOP), true, '槽位保持 unknown 阻塞');
  const rec = monitor.getEnablePhaseRecord(SHOP, DAY);
  assert.equal(rec.status, 'unknown');
  assert.equal(rec.blocked, 'serial_gate');
  assert.equal(rec.serialGateAttempts, 1, '首次尝试只累计次数');
  assert.equal(monitor._enablePhaseDone(SHOP, DAY), false, 'unknown 仍可在窗口内重试');
  assert.equal(audits(dataDir).some((e) => e.step === 'serial-gate-bounded'), false, '不得提前收口');
  monitor.stop();
});

test('M3 次数上限（3 次）→ 第 3 次尝试收口；前两次保持 unknown', async () => {
  const dataDir = makeTempDir('fix2-');
  seedSlot(dataDir, { startedAt: Date.now() }); // 时间未超界，只靠次数
  const monitor = buildMonitor(dataDir);
  monitor._serialGateMaxWaitMs = 24 * 60 * 60 * 1000; // 隔离时间维度

  const r1 = await runPhase(monitor);
  assert.notEqual(r1.status, 'exhausted');
  assert.equal(monitor.getEnablePhaseRecord(SHOP, DAY).serialGateAttempts, 1);
  assert.equal(monitor._switchOrchestrator.hasUnknownBlock(SHOP), true);

  const r2 = await runPhase(monitor);
  assert.notEqual(r2.status, 'exhausted');
  assert.equal(monitor.getEnablePhaseRecord(SHOP, DAY).serialGateAttempts, 2);
  assert.equal(monitor._switchOrchestrator.hasUnknownBlock(SHOP), true);

  const r3 = await runPhase(monitor);
  assert.equal(r3.status, 'exhausted', JSON.stringify(r3));
  assert.equal(monitor.getEnablePhaseRecord(SHOP, DAY).serialGateAttempts, 3);
  assert.equal(monitor._switchOrchestrator.hasUnknownBlock(SHOP), false);
  assert.equal(monitor._enablePhaseDone(SHOP, DAY), true);
  monitor.stop();
});

test('M4 回读非 mixed（off）→ 有界收口不介入（交给既有「目标未达成」结案路径）', () => {
  const dataDir = makeTempDir('fix2-');
  seedSlot(dataDir, { startedAt: Date.now() - 2 * 60 * 60 * 1000 });
  const monitor = buildMonitor(dataDir);

  const r = monitor._expireUnresolvedSerialGateIfBounded(
    { id: SHOP }, DAY, { resolved: false, reason: '目标态未确认' }, 'off', 'daily_schedule',
  );
  assert.equal(r, null, '非 mixed 不得走有界收口');
  assert.equal(monitor._switchOrchestrator.hasUnknownBlock(SHOP), true, '槽位保持原状');
  assert.equal(audits(dataDir).some((e) => e.step === 'serial-gate-bounded'), false);
  monitor.stop();
});
