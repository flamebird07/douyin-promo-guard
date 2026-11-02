'use strict';

/**
 * fix2：serial_gate 有界收口（gate 层单元测试）。
 * 语义：unknown 槽位在有限次数/超时后按「未确认终态」结案（settledAs=unknown_expired，
 * confirmed 恒 false），只结束无限阻塞，不声明目标达成；缺 reason / 非 unknown /
 * 非白名单动作 / 持久化失败 一律保持阻塞（fail-closed）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { createSwitchSerialGate, SETTLE_KIND } = require('../src/engine/switch-serial.js');

function seedUnknown(gate, shopId, action, reason) {
  const b = gate.tryBegin(shopId, action);
  assert.equal(b.ok, true, JSON.stringify(b));
  const u = gate.markUnknown(shopId, b.actionId, reason || '执行结果未知/回读失败');
  assert.equal(u.ok, true, JSON.stringify(u));
  return b.actionId;
}

test('B1 unknown enable 槽位有界收口 → 未确认终态结案并释放，confirmed 恒 false', () => {
  const gate = createSwitchSerialGate();
  const actionId = seedUnknown(gate, 'shop-a', 'enable');
  assert.equal(gate.hasUnknownBlock('shop-a'), true, '预置应为 unknown 阻塞');

  const r = gate.expireUnknown('shop-a', actionId, {
    reason: '3 次尝试/等待 30 分钟仍无法核验目标 on',
    actions: ['enable'],
  });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.kind, SETTLE_KIND.UNKNOWN_EXPIRED);
  assert.equal(r.settledAs, SETTLE_KIND.UNKNOWN_EXPIRED);
  assert.equal(r.confirmed, false, '有界收口不得声明已确认');
  assert.equal(gate.hasUnknownBlock('shop-a'), false, '收口后不再 unknown 阻塞');
  assert.equal(gate.isBusy('shop-a'), false, '串行门已释放');

  // 释放后新动作可登记；旧 actionId 不得影响新动作
  const b2 = gate.tryBegin('shop-a', 'enable');
  assert.equal(b2.ok, true, JSON.stringify(b2));
  assert.notEqual(b2.actionId, actionId);
});

test('B2 缺 reason → 拒绝（禁止静默释放，保持 unknown 阻塞）', () => {
  const gate = createSwitchSerialGate();
  const actionId = seedUnknown(gate, 'shop-a', 'enable');
  for (const reason of [undefined, '', '   ']) {
    const r = gate.expireUnknown('shop-a', actionId, { reason, actions: ['enable'] });
    assert.equal(r.ok, false, `reason=${JSON.stringify(reason)} 应被拒绝`);
    assert.match(String(r.reason), /reason/);
  }
  assert.equal(gate.hasUnknownBlock('shop-a'), true, '拒绝后必须保持阻塞');
});

test('B3 非 unknown（in-flight / confirmed）→ 拒绝', () => {
  const gate = createSwitchSerialGate();
  const b = gate.tryBegin('shop-a', 'enable');
  const r1 = gate.expireUnknown('shop-a', b.actionId, { reason: 'x', actions: ['enable'] });
  assert.equal(r1.ok, false, 'in-flight 不是 unknown，不得走有界收口');

  gate.markConfirmed('shop-a', b.actionId);
  const r2 = gate.expireUnknown('shop-a', b.actionId, { reason: 'x', actions: ['enable'] });
  assert.equal(r2.ok, false, 'confirmed 槽位不得走有界收口');
  assert.equal(gate.isBusy('shop-a'), true, '槽位保持未结束');
});

test('B4 默认白名单仅 enable：pause unknown 槽位不参与有界收口', () => {
  const gate = createSwitchSerialGate();
  const actionId = seedUnknown(gate, 'shop-a', 'pause');
  const r = gate.expireUnknown('shop-a', actionId, { reason: '有界' });
  assert.equal(r.ok, false, '默认不得收口 pause');
  assert.equal(gate.hasUnknownBlock('shop-a'), true);
});

test('B5 终态持久化失败 → 回滚为 unknown 阻塞（不删槽）', () => {
  const gate = createSwitchSerialGate();
  const actionId = seedUnknown(gate, 'shop-a', 'enable');
  const r = gate.expireUnknown('shop-a', actionId, {
    reason: '有界收口',
    actions: ['enable'],
    persist: () => ({ ok: false, reason: '磁盘只读' }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.persistFailed, true);
  assert.match(String(r.reason), /persistence_blocked/);
  assert.equal(gate.hasUnknownBlock('shop-a'), true, '落盘失败必须保持阻塞');
  assert.equal(gate.peek('shop-a').actionId, actionId);
});

test('B6 已结束槽位不可再收口；actionId 不匹配一律拒绝', () => {
  const gate = createSwitchSerialGate();
  const actionId = seedUnknown(gate, 'shop-a', 'enable');
  assert.equal(gate.expireUnknown('shop-a', 'act_other', { reason: '有界' }).ok, false, 'actionId 不匹配须拒绝');
  assert.equal(gate.expireUnknown('shop-a', actionId, { reason: '有界' }).ok, true);
  const again = gate.expireUnknown('shop-a', actionId, { reason: '有界' });
  assert.equal(again.ok, false, '已结束不得重复收口');
});
