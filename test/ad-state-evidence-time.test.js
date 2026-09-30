'use strict';

/**
 * 隔离测试：页面当前广告状态与显示时间必须同源对应。
 * - 动作全量确认 on → on + 动作确认时间
 * - 随后只读回读 off → off + 较新观测时间，不得再配旧 on 确认时间
 * - unknown/失败不得伪称确认
 * - A 店更新不得改 B 店时间
 * mock + 临时目录；不访问真实广告页。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { Monitor } = require('../src/engine/monitor');
const { makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock, waitFor } = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');
const { deriveAdState } = require('../integrations/bill-manager/watch-drill');

function setup(t, { shops } = {}) {
  const cookieDir = makeTempDir('pg-adtime-cookies-');
  const dataDir = makeTempDir('pg-adtime-data-');
  t.after(() => {
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const list = shops || [
    { id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true },
    { id: 'shop-b', name: '店B', cookieFile: '店B', enabled: true },
  ];
  for (const s of list) writeTempCookie(cookieDir, s.cookieFile);
  const cfgResult = makeCfgResult({ cookieDir, shops: list, monitor: { legacyWholeShopCloseEnabled: true } });
  const clock = makeClock(shanghaiMs('2026-09-28', '10:00'));
  const controller = makeStatefulController({
    identity: { id: 'shop-a', name: '店A' },
    ads: [{ adId: 'ad-1', name: '甲', status: '投放中' }],
  });
  const reader = makeLinkedReader(controller, { costCents: 100, orders: 10, pageSource: 'mock' }, clock.nowFn);
  const monitor = new Monitor(cfgResult, { reader, controller }, {
    dataDir,
    nowFn: clock.nowFn,
    delayFn: clock.delayFn,
  });
  return { monitor, clock };
}

test('动作全量确认 on → 显示 on 与对应动作确认时间', async (t) => {
  const { monitor } = setup(t, {
    shops: [{ id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true }],
  });
  monitor._applyConfirmedAdState('shop-a', 'on', '2026-09-28T02:03:46.000Z', '开启批次回读确认全部已开启');

  const status = monitor.getStatus();
  const shop = status.shops.find((s) => s.id === 'shop-a');
  assert.strictEqual(shop.lastAdState, 'on');
  assert.strictEqual(shop.adStateConfirmedAt, '2026-09-28T02:03:46.000Z');
  assert.strictEqual(shop.adStateObservedAt, null);
  assert.strictEqual(shop.adStateEvidenceKind, 'action_confirm');

  const ad = deriveAdState(status, shop);
  assert.strictEqual(ad.state, 'on');
  assert.strictEqual(ad.at, '2026-09-28T02:03:46.000Z', '展示时间=动作确认时间');
  assert.strictEqual(ad.evidenceKind, 'action_confirm');
  assert.strictEqual(ad.confirmedAt, '2026-09-28T02:03:46.000Z');
});

test('随后只读回读 off → off + 较新观测时间，不再配旧 on 确认时间', async (t) => {
  const { monitor } = setup(t, {
    shops: [{ id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true }],
  });
  monitor._applyConfirmedAdState('shop-a', 'on', '2026-09-28T02:03:46.000Z', '开启确认');
  // 模拟较晚只读回读到 off
  monitor._applyObservedAdState('shop-a', 'off', '只读清单/页面回读');

  const rt = monitor._runtime('shop-a');
  assert.strictEqual(rt.lastAdState, 'off');
  assert.strictEqual(rt.adStateConfirmedAt, null, '旧 on 确认时间必须失效');
  assert.ok(rt.adStateObservedAt, '写入本轮观测时间');
  assert.strictEqual(rt.adStateEvidenceKind, 'read_only');

  const status = monitor.getStatus();
  const shop = status.shops.find((s) => s.id === 'shop-a');
  const ad = deriveAdState(status, shop);
  assert.strictEqual(ad.state, 'off');
  assert.strictEqual(ad.on, false);
  assert.strictEqual(ad.at, shop.adStateObservedAt, '展示时间=较新只读观测时间');
  assert.strictEqual(ad.confirmedAt, null);
  assert.strictEqual(ad.evidenceKind, 'read_only');
  assert.notStrictEqual(ad.at, '2026-09-28T02:03:46.000Z', '不得显示旧 on 确认时间');
});

test('unknown/失败不能伪称确认', async (t) => {
  const { monitor } = setup(t, {
    shops: [{ id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true }],
  });
  monitor._applyConfirmedAdState('shop-a', 'on', '2026-09-28T02:00:00.000Z', '开启确认');
  // 只读失败 → unknown，不得保留确认时间
  monitor._applyObservedAdState('shop-a', 'unknown', '只读回读失败：清单不完整');

  const rt = monitor._runtime('shop-a');
  assert.strictEqual(rt.lastAdState, 'unknown');
  assert.strictEqual(rt.adStateConfirmedAt, null);
  assert.strictEqual(rt.adStateEvidenceKind, 'read_only');

  const status = monitor.getStatus();
  const shop = status.shops.find((s) => s.id === 'shop-a');
  const ad = deriveAdState(status, shop);
  assert.strictEqual(ad.state, 'unknown');
  assert.strictEqual(ad.confirmedAt, null, '失败不得伪称已确认');
  assert.strictEqual(ad.evidenceKind, 'read_only');

  // 未调用确认/观测 API 时：无状态证据时间 → at 不得用 lastDataAt 冒充
  const shop2 = { id: 'shop-a', lastAdState: 'on', lastDataAt: '2026-09-28T01:00:00.000Z' };
  const ad2 = deriveAdState({}, shop2);
  assert.strictEqual(ad2.at, null, '无状态证据时间时 at=null，不得用 lastDataAt');
  assert.strictEqual(ad2.confirmedAt, null);
  assert.strictEqual(ad2.observedAt, null);
  assert.strictEqual(ad2.evidenceKind, null);
});

test('A 店更新不得改 B 店时间', async (t) => {
  const { monitor } = setup(t);
  monitor._applyConfirmedAdState('shop-a', 'on', '2026-09-28T02:03:46.000Z', 'A开启确认');
  monitor._applyConfirmedAdState('shop-b', 'off', '2026-09-28T02:01:00.000Z', 'B暂停确认');

  const beforeB = monitor._runtime('shop-b');
  const bConfirm = beforeB.adStateConfirmedAt;
  const bState = beforeB.lastAdState;

  // 只更新 A 的只读观测
  monitor._applyObservedAdState('shop-a', 'off', 'A只读回读');

  const afterA = monitor._runtime('shop-a');
  const afterB = monitor._runtime('shop-b');
  assert.strictEqual(afterA.lastAdState, 'off');
  assert.strictEqual(afterA.adStateConfirmedAt, null);
  assert.ok(afterA.adStateObservedAt);

  assert.strictEqual(afterB.lastAdState, bState, 'B 状态不变');
  assert.strictEqual(afterB.adStateConfirmedAt, bConfirm, 'B 确认时间不变');
  assert.strictEqual(afterB.adStateObservedAt, null);

  const status = monitor.getStatus();
  const shopB = status.shops.find((s) => s.id === 'shop-b');
  const adB = deriveAdState(status, shopB);
  assert.strictEqual(adB.at, '2026-09-28T02:01:00.000Z');
  assert.strictEqual(adB.evidenceKind, 'action_confirm');
});

test('动作确认覆盖观测：再确认后回到 action_confirm 时间', async (t) => {
  const { monitor } = setup(t, {
    shops: [{ id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true }],
  });
  monitor._applyObservedAdState('shop-a', 'off', '只读');
  monitor._applyConfirmedAdState('shop-a', 'on', '2026-09-28T03:00:00.000Z', '再次开启确认');

  const rt = monitor._runtime('shop-a');
  assert.strictEqual(rt.lastAdState, 'on');
  assert.strictEqual(rt.adStateConfirmedAt, '2026-09-28T03:00:00.000Z');
  assert.strictEqual(rt.adStateObservedAt, null, '确认后旧观测时间失效');
  assert.strictEqual(rt.adStateEvidenceKind, 'action_confirm');
});
