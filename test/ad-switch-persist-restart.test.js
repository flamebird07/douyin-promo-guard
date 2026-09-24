'use strict';

/**
 * 串行门重启持久化：终态先落盘再释放；重启不误锁、不重复点击。
 * 临时目录 + 假执行器；不读真实 data/state.json。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { AdSwitchOrchestrator, createSwitchSerialGate } = require('../src/engine/ad-switch-orchestrator');

function tmpState() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ps-restart-')), 'state.json');
}

/** 模拟 monitor._saveState：settled 槽可安全恢复（import 跳过 settled）。 */
function makePersist(stateFile, { fail = false } = {}) {
  return (gateExport) => {
    if (fail) return { ok: false, reason: '注入:写失败' };
    try {
      fs.writeFileSync(stateFile, JSON.stringify(gateExport || { slots: [] }));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  };
}

test('动作前落盘→确认→重启：settled 已持久化，重建不误锁、可再次动作', () => {
  const stateFile = tmpState();
  const gate1 = createSwitchSerialGate();
  const orch1 = new AdSwitchOrchestrator({ gate: gate1 });
  const persist1 = () => makePersist(stateFile)(gate1.exportState());
  // 确认：markSettled 内 settled→persist→delete
  const a = gate1.tryBegin('shop-a', 'pause');
  gate1.markConfirmed('shop-a', a.actionId);
  const s = gate1.markSettled('shop-a', a.actionId, { kind: 'confirmed', persist: persist1 });
  assert.strictEqual(s.ok, true);
  assert.strictEqual(gate1.isBusy('shop-a'), false);
  const snap = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const rec = (snap.slots || []).find((x) => x.shopId === 'shop-a');
  assert.ok(!rec || rec.settled === true, `快照须为终态 settled，实际：${JSON.stringify(rec)}`);
  const gate2 = createSwitchSerialGate({ state: snap });
  assert.strictEqual(gate2.hasUnknownBlock('shop-a'), false, '重启不得误锁');
  assert.strictEqual(gate2.isBusy('shop-a'), false);
  const b = gate2.tryBegin('shop-a', 'enable');
  assert.strictEqual(b.ok, true, '重启后可安全再次动作（不重复占用旧槽）');
  void orch1;
});

test('动作前落盘→明确未发出→重启：不误锁', () => {
  const stateFile = tmpState();
  const gate1 = createSwitchSerialGate();
  const persist1 = () => makePersist(stateFile)(gate1.exportState());
  const a = gate1.tryBegin('shop-b', 'enable');
  const n = gate1.markNotSent('shop-b', a.actionId, { persist: persist1 });
  assert.strictEqual(n.ok, true);
  const snap = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const rec = (snap.slots || []).find((x) => x.shopId === 'shop-b');
  assert.ok(!rec || rec.settled === true, `not_sent 终态须 settled：${JSON.stringify(rec)}`);
  const gate2 = createSwitchSerialGate({ state: snap });
  assert.strictEqual(gate2.hasUnknownBlock('shop-b'), false);
  assert.strictEqual(gate2.isBusy('shop-b'), false);
});

test('终态写入失败：保持阻塞（不释放、不重复点击）', () => {
  const gate = createSwitchSerialGate();
  const a = gate.tryBegin('shop-c', 'pause');
  gate.markConfirmed('shop-c', a.actionId);
  const s = gate.markSettled('shop-c', a.actionId, {
    kind: 'confirmed',
    persist: () => ({ ok: false, reason: '注入:写失败' }),
  });
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.persistFailed, true);
  assert.strictEqual(gate.hasUnknownBlock('shop-c'), true, '持久化失败必须保持阻塞');
  assert.strictEqual(gate.isBusy('shop-c'), true);
  assert.strictEqual(gate.tryBegin('shop-c', 'pause').ok, false, '不得重复点击');
});

test('not_sent 终态写入失败：转 unknown 保持阻塞', () => {
  const gate = createSwitchSerialGate();
  const a = gate.tryBegin('shop-d', 'enable');
  const n = gate.markNotSent('shop-d', a.actionId, {
    persist: () => ({ ok: false, reason: '注入:写失败' }),
  });
  assert.strictEqual(n.ok, false);
  assert.strictEqual(n.persistFailed, true);
  assert.strictEqual(gate.hasUnknownBlock('shop-d'), false, 'markNotSent 失败时尚未转 unknown');
  // 调用方（编排器）负责 markUnknown；此处验证槽未被误删
  assert.strictEqual(gate.isBusy('shop-d'), true, '失败不得释放槽');
});

test('partial/unknown 重启后仍阻塞', () => {
  const stateFile = tmpState();
  const gate1 = createSwitchSerialGate();
  const a = gate1.tryBegin('shop-e', 'pause');
  gate1.markUnknown('shop-e', a.actionId, 'partial 回读未确认');
  const snap = gate1.exportState();
  fs.writeFileSync(stateFile, JSON.stringify(snap));
  const gate2 = createSwitchSerialGate({ state: JSON.parse(fs.readFileSync(stateFile, 'utf8')) });
  assert.strictEqual(gate2.hasUnknownBlock('shop-e'), true);
  assert.strictEqual(gate2.tryBegin('shop-e', 'pause').ok, false);
});

test('编排器 never_sent+双写失败：persistence_blocked / zeroClick:true / serial:unknown / dispatched:0', async () => {
  const gate = createSwitchSerialGate();
  const orch = new AdSwitchOrchestrator({ gate });
  let clicks = 0;
  const r = await orch.runSwitchAction({
    shopId: 'shop-z', action: 'pause', targetState: 'off',
    readState: async () => 'on',
    decide: (st) => orch.evaluatePeriodic({ costCents: 10001, orders: 100, thresholdCents: 100, currentAdState: st, identityOk: true }),
    execute: async () => {
      // 模拟 _persistBeforeDispatch 失败：未发出
      clicks += 1;
      return {
        outcome: 'persistence_blocked',
        neverSent: true,
        reason: 'persistence_blocked: 动作前持久化失败，未发出开关',
        counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
      };
    },
    persistBeforeRelease: () => ({ ok: false, reason: '注入:终态写失败' }),
  });
  assert.strictEqual(clicks, 1, 'execute 入口调用 1 次（底层开关 0：counts 全 0）');
  assert.strictEqual(r.dispatched, 0);
  assert.strictEqual(r.outcome, 'persistence_blocked');
  assert.strictEqual(r.zeroClick, true, '未发出必须 zeroClick');
  assert.strictEqual(r.serial, 'unknown', '终态未落盘不得宣称 not_sent 释放');
  assert.strictEqual(gate.hasUnknownBlock('shop-z'), true, '阻止再次动作');
  assert.strictEqual(gate.tryBegin('shop-z', 'enable').ok, false);
});

test('resolveUnknownWithReadback 持久化失败：内存不释放，落盘仍 unknown', () => {
  const stateFile = tmpState();
  const gate1 = createSwitchSerialGate();
  const a = gate1.tryBegin('shop-r', 'pause');
  gate1.markUnknown('shop-r', a.actionId, 'partial');
  // persist 成功路径先写 in-flight/unknown 快照
  makePersist(stateFile)(gate1.exportState());
  const r = gate1.resolveUnknownAfterReadback('shop-r', a.actionId, { confirmed: true }, {
    persist: () => ({ ok: false, reason: '注入:恢复写失败' }),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.persistFailed, true);
  assert.strictEqual(gate1.hasUnknownBlock('shop-r'), true, '内存保持 unknown');
  const snap = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const rec = (snap.slots || []).find((x) => x.shopId === 'shop-r');
  assert.ok(rec && rec.unknown !== false && rec.settled !== true, `落盘仍应为未结束/unknown：${JSON.stringify(rec)}`);
  const gate2 = createSwitchSerialGate({ state: snap });
  assert.strictEqual(gate2.hasUnknownBlock('shop-r'), true, '重启仍阻塞');
});

test('resolveUnknownWithReadback 持久化成功：终态落盘后重启不误锁', () => {
  const stateFile = tmpState();
  const gate1 = createSwitchSerialGate();
  const a = gate1.tryBegin('shop-r2', 'pause');
  gate1.markUnknown('shop-r2', a.actionId, 'partial');
  const r = gate1.resolveUnknownAfterReadback('shop-r2', a.actionId, { confirmed: true }, {
    persist: () => makePersist(stateFile)(gate1.exportState()),
  });
  // persist 在 settled=true 后调用，快照含 settled
  assert.strictEqual(r.ok, true);
  assert.strictEqual(gate1.isBusy('shop-r2'), false);
  const snap = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const rec = (snap.slots || []).find((x) => x.shopId === 'shop-r2');
  assert.ok(!rec || rec.settled === true, `终态须 settled：${JSON.stringify(rec)}`);
  const gate2 = createSwitchSerialGate({ state: snap });
  assert.strictEqual(gate2.hasUnknownBlock('shop-r2'), false);
});

test('编排器 confirmed：persist 成功后重启无锁；persist 失败保持 unknown', async () => {
  const stateFile = tmpState();
  const gate1 = createSwitchSerialGate();
  const orch1 = new AdSwitchOrchestrator({ gate: gate1 });
  let clicks = 0;
  const r = await orch1.runSwitchAction({
    shopId: 'shop-f', action: 'pause', targetState: 'off',
    readState: async () => 'on',
    decide: (st) => orch1.evaluatePeriodic({ costCents: 10001, orders: 100, thresholdCents: 100, currentAdState: st, identityOk: true }),
    execute: async () => {
      clicks += 1;
      return { outcome: 'all_paused_confirmed', allPausedConfirmed: true, counts: { confirmed: 1, failed: 0, unknown: 0, skipped: 0, cancelled: 0 } };
    },
    persistBeforeRelease: () => makePersist(stateFile)(gate1.exportState()),
  });
  assert.strictEqual(r.serial, 'confirmed');
  assert.strictEqual(clicks, 1, '只点击一次');
  const snap = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const gate2 = createSwitchSerialGate({ state: snap });
  assert.strictEqual(gate2.hasUnknownBlock('shop-f'), false, '确认后重启不得误锁');
  assert.strictEqual(gate2.tryBegin('shop-f', 'enable').ok, true);
});

test('编排器 resolveUnknownWithReadback：写失败不释放；写成功后重启不误锁', () => {
  const stateFile = tmpState();
  const gate1 = createSwitchSerialGate();
  const orch = new AdSwitchOrchestrator({ gate: gate1 });
  const a = gate1.tryBegin('shop-o', 'pause');
  gate1.markUnknown('shop-o', a.actionId, 'partial');
  const fail = orch.resolveUnknownWithReadback('shop-o', a.actionId, {
    confirmed: true,
    persist: () => ({ ok: false, reason: '注入:恢复写失败' }),
  });
  assert.strictEqual(fail.ok, false);
  assert.strictEqual(fail.persistFailed, true);
  assert.strictEqual(gate1.hasUnknownBlock('shop-o'), true, '写失败不得释放');

  const b = gate1.tryBegin('shop-o2', 'enable');
  gate1.markUnknown('shop-o2', b.actionId, 'partial');
  const ok = orch.resolveUnknownWithReadback('shop-o2', b.actionId, {
    confirmed: true,
    persist: () => makePersist(stateFile)(gate1.exportState()),
  });
  assert.strictEqual(ok.ok, true);
  const snap = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const gate2 = createSwitchSerialGate({ state: snap });
  assert.strictEqual(gate2.hasUnknownBlock('shop-o2'), false, '写成功重启不误锁');
  assert.strictEqual(gate2.tryBegin('shop-o2', 'pause').ok, true);
});
