'use strict';

/**
 * 隔离单测：阈值开关决策 + 同店动作串行化门。
 * 仅 mock/fixture；不启动服务/登录/广告页/飞书/真实开关/通知。
 * 注：tryBegin 双请求仅验证进程内串行门，**不是**真实 07:00/值守集成验证。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  decideAdSwitchAction,
  METRIC,
  DECISION,
} = require('../src/engine/ad-switch-decision');
const { createSwitchSerialGate, SETTLE_KIND } = require('../src/engine/switch-serial');

const TH = 100;

function dec(over) {
  return decideAdSwitchAction({
    costCents: 5000,
    orders: 100,
    thresholdCents: TH,
    currentAdState: 'off',
    identityOk: true,
    ...over,
  });
}

// ── 阈值矩阵（原有语义保持）────────────────────────────────────
test('低于阈值 + off → should_enable', () => {
  const r = dec({ costCents: 5000, currentAdState: 'off' });
  assert.strictEqual(r.metric, METRIC.BELOW);
  assert.strictEqual(r.decision, DECISION.SHOULD_ENABLE);
  assert.strictEqual(r.action, 'enable');
  assert.strictEqual(r.zeroClick, false);
});

test('低于阈值 + on → already_on（保持）', () => {
  const r = dec({ costCents: 5000, currentAdState: 'on' });
  assert.strictEqual(r.decision, DECISION.ALREADY_ON);
  assert.strictEqual(r.zeroClick, true);
});

test('高于阈值 + on → should_pause', () => {
  const r = dec({ costCents: 10001, currentAdState: 'on' });
  assert.strictEqual(r.metric, METRIC.ABOVE);
  assert.strictEqual(r.decision, DECISION.SHOULD_PAUSE);
  assert.strictEqual(r.action, 'pause');
});

test('高于阈值 + off → already_off（保持）', () => {
  const r = dec({ costCents: 10001, currentAdState: 'off' });
  assert.strictEqual(r.decision, DECISION.ALREADY_OFF);
});

test('等于阈值 + on/off → equal_no_action 零动作', () => {
  for (const currentAdState of ['on', 'off']) {
    const r = dec({ costCents: 10000, currentAdState });
    assert.strictEqual(r.metric, METRIC.EQUAL);
    assert.strictEqual(r.decision, DECISION.EQUAL_NO_ACTION);
    assert.strictEqual(r.zeroClick, true);
  }
});

test('整数比较：9900/100 不得当作 1 元', () => {
  const r = dec({ costCents: 9900, currentAdState: 'off' });
  assert.strictEqual(r.metric, METRIC.BELOW);
  assert.strictEqual(r.decision, DECISION.SHOULD_ENABLE);
});

test('unknown → unknown_blocked', () => {
  const r = dec({ costCents: 10001, currentAdState: 'unknown' });
  assert.strictEqual(r.decision, DECISION.UNKNOWN_BLOCKED);
  assert.strictEqual(r.zeroClick, true);
});

test('零订单 / 非法指标 → data_blocked', () => {
  assert.strictEqual(dec({ orders: 0, costCents: 5000 }).decision, DECISION.DATA_BLOCKED);
  assert.strictEqual(dec({ costCents: 12.5 }).decision, DECISION.DATA_BLOCKED);
  assert.strictEqual(dec({ dataError: 'parse' }).decision, DECISION.DATA_BLOCKED);
});

test('不同店铺互不阻塞', () => {
  const gate = createSwitchSerialGate();
  assert.strictEqual(gate.tryBegin('shop-a', 'enable').ok, true);
  assert.strictEqual(gate.tryBegin('shop-b', 'pause').ok, true);
  assert.strictEqual(gate.isBusy('shop-a'), true);
  assert.strictEqual(gate.isBusy('shop-b'), true);
});

// ── identityOk 严格 true ────────────────────────────────────────
test('identityOk 缺失/null/假值/字符串均 data_blocked', () => {
  for (const identityOk of [undefined, null, false, 'true', '1', 1, 0, {}]) {
    const r = decideAdSwitchAction({
      costCents: 10001,
      orders: 100,
      thresholdCents: TH,
      currentAdState: 'on',
      identityOk,
    });
    assert.strictEqual(r.decision, DECISION.DATA_BLOCKED, String(identityOk));
    assert.strictEqual(r.blocked, 'identity_mismatch');
    assert.strictEqual(r.zeroClick, true);
    assert.strictEqual(r.action, null);
  }
  // 严格 true 时走正常决策：费用高于阈值且当前 on → should_pause（不降低断言）
  assert.strictEqual(
    dec({ identityOk: true, costCents: 10001, currentAdState: 'on' }).decision,
    DECISION.SHOULD_PAUSE
  );
});

// ── 乘法溢出 ────────────────────────────────────────────────────
test('orders × thresholdCents 溢出安全整数 → data_blocked', () => {
  const r = decideAdSwitchAction({
    costCents: 1,
    orders: Number.MAX_SAFE_INTEGER,
    thresholdCents: 2,
    currentAdState: 'off',
    identityOk: true,
  });
  assert.strictEqual(r.decision, DECISION.DATA_BLOCKED);
  assert.strictEqual(r.blocked, 'overflow');
  assert.strictEqual(r.expectedCents, null);
});

// ── 串行化门：动作可能已发出后超时（markUnknown）─────────────────
test('动作可能已发出后超时（markUnknown）→ 同向/反向请求均被拒绝', () => {
  const gate = createSwitchSerialGate();
  const a = gate.tryBegin('shop-001', 'enable');
  assert.strictEqual(a.ok, true);
  assert.ok(a.actionId);
  // 超时/异常 ≠ 未发出
  const u = gate.markUnknown('shop-001', a.actionId, 'readback timeout');
  assert.strictEqual(u.ok, true);
  assert.strictEqual(gate.hasUnknownBlock('shop-001'), true);
  for (const action of ['enable', 'pause']) {
    const r = gate.tryBegin('shop-001', action);
    assert.strictEqual(r.ok, false, `unknown 阻塞时 ${action} 必须拒绝`);
    assert.match(r.reason, /未知|串行化/);
  }
});

test('明确未发出（markNotSent）时可以释放并再次 tryBegin', () => {
  const gate = createSwitchSerialGate();
  const a = gate.tryBegin('shop-001', 'pause');
  const n = gate.markNotSent('shop-001', a.actionId);
  assert.strictEqual(n.ok, true);
  assert.strictEqual(gate.isBusy('shop-001'), false);
  assert.strictEqual(gate.tryBegin('shop-001', 'pause').ok, true);
});

test('正常确认后可以释放（markConfirmed → markSettled CONFIRMED）', () => {
  const gate = createSwitchSerialGate();
  const a = gate.tryBegin('shop-001', 'enable');
  assert.strictEqual(a.ok, true);
  const c = gate.markConfirmed('shop-001', a.actionId);
  assert.strictEqual(c.ok, true);
  assert.strictEqual(gate.isBusy('shop-001'), true, 'markConfirmed 本身不释放');
  const s = gate.markSettled('shop-001', a.actionId, { kind: SETTLE_KIND.CONFIRMED });
  assert.strictEqual(s.ok, true);
  assert.strictEqual(s.confirmed, true);
  assert.strictEqual(gate.isBusy('shop-001'), false);
  assert.strictEqual(gate.tryBegin('shop-001', 'enable').ok, true);
});

test('未确认不能伪装成功释放（markSettled CONFIRMED 不得自行制造已确认）', () => {
  const gate = createSwitchSerialGate();
  const a = gate.tryBegin('shop-001', 'pause');
  const s = gate.markSettled('shop-001', a.actionId, { kind: SETTLE_KIND.CONFIRMED });
  assert.strictEqual(s.ok, false);
  assert.match(s.reason, /未确认|伪装/);
  assert.strictEqual(gate.isBusy('shop-001'), true);
  assert.strictEqual(gate.peek('shop-001').confirmed, false);
  assert.strictEqual(gate.tryBegin('shop-001', 'pause').ok, false);
});

test('unknown 经 confirmed:true 恢复（resolveUnknownAfterReadback）', () => {
  const gate = createSwitchSerialGate();
  const a = gate.tryBegin('shop-001', 'enable');
  gate.markUnknown('shop-001', a.actionId, 'timeout');
  assert.strictEqual(gate.tryBegin('shop-001', 'enable').ok, false);
  const r = gate.resolveUnknownAfterReadback('shop-001', a.actionId, {
    confirmed: true,
    note: '只读回读已确认全部开启',
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.confirmed, true);
  assert.strictEqual(gate.isBusy('shop-001'), false);
  assert.strictEqual(gate.tryBegin('shop-001', 'enable').ok, true);
});

test('unknown 的缺参/false 回读不释放，保持阻塞', () => {
  const gate = createSwitchSerialGate();
  const a = gate.tryBegin('shop-001', 'pause');
  gate.markUnknown('shop-001', a.actionId, 'timeout');

  for (const p of [undefined, null, {}, { confirmed: false }, { confirmed: 'true' }, { confirmed: 1 }, { confirmed: 0 }]) {
    const r = gate.resolveUnknownAfterReadback('shop-001', a.actionId, p);
    assert.strictEqual(r.ok, false, `回读入参 ${JSON.stringify(p)} 不得释放`);
    assert.match(r.reason, /保持 unknown 阻塞|未确认/);
    assert.strictEqual(gate.isBusy('shop-001'), true, '保持阻塞');
    assert.strictEqual(gate.hasUnknownBlock('shop-001'), true);
  }
  assert.strictEqual(gate.tryBegin('shop-001', 'pause').ok, false);
  assert.strictEqual(gate.tryBegin('shop-001', 'enable').ok, false);
});

test('unknown 不能通过 markNotSent 或 markConfirmed 绕过', () => {
  const gate = createSwitchSerialGate();
  const a = gate.tryBegin('shop-001', 'enable');
  gate.markUnknown('shop-001', a.actionId, 'timeout');

  const n = gate.markNotSent('shop-001', a.actionId);
  assert.strictEqual(n.ok, false);
  assert.match(n.reason, /markNotSent|unknown/);
  assert.strictEqual(gate.hasUnknownBlock('shop-001'), true);

  const c = gate.markConfirmed('shop-001', a.actionId);
  assert.strictEqual(c.ok, false);
  assert.match(c.reason, /markConfirmed|恢复入口|unknown/);
  assert.strictEqual(gate.hasUnknownBlock('shop-001'), true);
  assert.strictEqual(gate.peek('shop-001').confirmed, false);

  const s = gate.markSettled('shop-001', a.actionId, { kind: SETTLE_KIND.NOT_SENT });
  assert.strictEqual(s.ok, false);
  const s2 = gate.markSettled('shop-001', a.actionId, { kind: SETTLE_KIND.CONFIRMED });
  assert.strictEqual(s2.ok, false);

  assert.strictEqual(gate.isBusy('shop-001'), true);
  assert.strictEqual(gate.tryBegin('shop-001', 'enable').ok, false);
});

test('已 confirmed 的动作不得经 markNotSent 释放', () => {
  const gate = createSwitchSerialGate();
  const a = gate.tryBegin('shop-001', 'enable');
  assert.strictEqual(gate.markConfirmed('shop-001', a.actionId).ok, true);
  const n = gate.markNotSent('shop-001', a.actionId);
  assert.strictEqual(n.ok, false);
  assert.match(n.reason, /markNotSent|confirmed/i);
  assert.strictEqual(gate.isBusy('shop-001'), true);
  // 应走 CONFIRMED 结束
  assert.strictEqual(
    gate.markSettled('shop-001', a.actionId, { kind: SETTLE_KIND.CONFIRMED }).ok,
    true
  );
  assert.strictEqual(gate.isBusy('shop-001'), false);
});

test('旧 actionId 回调不能确认/释放新动作', () => {
  const gate = createSwitchSerialGate();
  const old = gate.tryBegin('shop-001', 'enable');
  gate.markUnknown('shop-001', old.actionId, 'timeout');
  // 旧动作经唯一恢复入口 confirmed:true 结束
  const r = gate.resolveUnknownAfterReadback('shop-001', old.actionId, {
    confirmed: true,
    note: 'readback ok',
  });
  assert.strictEqual(r.ok, true);
  const neu = gate.tryBegin('shop-001', 'pause');
  assert.strictEqual(neu.ok, true);
  // 旧 actionId 回调一律失败
  assert.strictEqual(gate.markConfirmed('shop-001', old.actionId).ok, false);
  assert.strictEqual(gate.markNotSent('shop-001', old.actionId).ok, false);
  assert.strictEqual(gate.markUnknown('shop-001', old.actionId).ok, false);
  assert.strictEqual(
    gate.resolveUnknownAfterReadback('shop-001', old.actionId, { confirmed: true }).ok,
    false
  );
  assert.strictEqual(
    gate.markSettled('shop-001', old.actionId, { kind: SETTLE_KIND.CONFIRMED }).ok,
    false
  );
  // 新动作仍在
  assert.strictEqual(gate.isBusy('shop-001'), true);
  assert.strictEqual(gate.peek('shop-001').actionId, neu.actionId);
});

test('修改返回对象不能绕过锁（slot/peek 为快照）', () => {
  const gate = createSwitchSerialGate();
  const a = gate.tryBegin('shop-001', 'enable');
  a.slot.settled = true;
  a.slot.unknown = false;
  a.slot.actionId = 'hacked';
  const p = gate.peek('shop-001');
  p.settled = true;
  p.unknown = true;
  assert.strictEqual(gate.isBusy('shop-001'), true, '外部改快照不得释放锁');
  assert.strictEqual(gate.hasUnknownBlock('shop-001'), false);
  assert.strictEqual(gate.tryBegin('shop-001', 'pause').ok, false);
  assert.strictEqual(gate.peek('shop-001').actionId, a.actionId, '内部 actionId 不被篡改');
});

test('enable/pause 并发：第二个被门阻止（进程内单测，非真实相位集成）', () => {
  const gate = createSwitchSerialGate();
  const a = gate.tryBegin('shop-001', 'enable');
  assert.strictEqual(a.ok, true);
  const b = gate.tryBegin('shop-001', 'pause');
  assert.strictEqual(b.ok, false);
  // 同为 enable 也不得并发（门语义，非集成验证）
  const c = gate.tryBegin('shop-001', 'enable');
  assert.strictEqual(c.ok, false);
});

test('markSettled 必须用 kind，禁止 ok 布尔混语义', () => {
  const gate = createSwitchSerialGate();
  const a = gate.tryBegin('shop-001', 'enable');
  assert.strictEqual(gate.markSettled('shop-001', a.actionId, { ok: false }).ok, false);
  assert.strictEqual(gate.markSettled('shop-001', a.actionId, {}).ok, false);
  // 明确未发出
  assert.strictEqual(
    gate.markSettled('shop-001', a.actionId, { kind: SETTLE_KIND.NOT_SENT }).ok,
    true
  );
  const b = gate.tryBegin('shop-001', 'pause');
  // 未知 → 保留阻塞
  assert.strictEqual(
    gate.markSettled('shop-001', b.actionId, { kind: SETTLE_KIND.UNKNOWN, reason: 'timeout' }).ok,
    true
  );
  assert.strictEqual(gate.isBusy('shop-001'), true);
  assert.strictEqual(gate.hasUnknownBlock('shop-001'), true);
  // unknown 不得经 CONFIRMED 伪释放
  assert.strictEqual(
    gate.markSettled('shop-001', b.actionId, { kind: SETTLE_KIND.CONFIRMED }).ok,
    false
  );
  // 唯一恢复入口
  assert.strictEqual(
    gate.resolveUnknownAfterReadback('shop-001', b.actionId, { confirmed: true }).ok,
    true
  );
  assert.strictEqual(gate.isBusy('shop-001'), false);
});

test('生产 API 不提供无条件 clear', () => {
  const gate = createSwitchSerialGate();
  assert.strictEqual(typeof gate.clear, 'undefined');
});

test('metric 与 decision 标签分离（矩阵）', () => {
  const rows = [
    [1, 1, 'off', METRIC.BELOW, DECISION.SHOULD_ENABLE],
    [1, 1, 'on', METRIC.BELOW, DECISION.ALREADY_ON],
    [101, 1, 'on', METRIC.ABOVE, DECISION.SHOULD_PAUSE],
    [101, 1, 'off', METRIC.ABOVE, DECISION.ALREADY_OFF],
    [100, 1, 'on', METRIC.EQUAL, DECISION.EQUAL_NO_ACTION],
    [100, 1, 'off', METRIC.EQUAL, DECISION.EQUAL_NO_ACTION],
  ];
  for (const [cost, orders, st, m, d] of rows) {
    const r = dec({ costCents: cost, orders, thresholdCents: 100, currentAdState: st });
    assert.strictEqual(r.metric, m, JSON.stringify([cost, orders, st]));
    assert.strictEqual(r.decision, d, JSON.stringify([cost, orders, st]));
  }
});

// ── mixed（部分 on、部分 off）────────────────────────────────────
test('mixed：above+mixed → should_pause（仅停 on 项）；below+mixed → should_enable（仅开 off 项）；equal+mixed 零动作', () => {
  const above = dec({ costCents: 10001, currentAdState: 'mixed' });
  assert.strictEqual(above.metric, METRIC.ABOVE);
  assert.strictEqual(above.decision, DECISION.SHOULD_PAUSE);
  assert.strictEqual(above.action, 'pause');
  assert.match(above.reason, /mixed/);

  const below = dec({ costCents: 5000, currentAdState: 'mixed' });
  assert.strictEqual(below.metric, METRIC.BELOW);
  assert.strictEqual(below.decision, DECISION.SHOULD_ENABLE);
  assert.strictEqual(below.action, 'enable');
  assert.match(below.reason, /mixed/);

  const eq = dec({ costCents: 10000, currentAdState: 'mixed' });
  assert.strictEqual(eq.metric, METRIC.EQUAL);
  assert.strictEqual(eq.decision, DECISION.EQUAL_NO_ACTION);
  assert.strictEqual(eq.zeroClick, true);
});

test('mixed 不得当 unknown：超标 mixed 仍应 should_pause，不得 unknown_blocked', () => {
  const r = dec({ costCents: 10001, currentAdState: 'mixed' });
  assert.notStrictEqual(r.decision, DECISION.UNKNOWN_BLOCKED);
  assert.strictEqual(r.decision, DECISION.SHOULD_PAUSE);
});

test('unknown 仍 fail-closed（含超标），不因 over 绕过', () => {
  const r = dec({ costCents: 10001, currentAdState: 'unknown' });
  assert.strictEqual(r.decision, DECISION.UNKNOWN_BLOCKED);
  assert.strictEqual(r.zeroClick, true);
});
