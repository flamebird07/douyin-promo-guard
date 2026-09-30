'use strict';

/**
 * 隔离测试：deriveAdState 不得用费用/订单采集时间（lastDataAt）冒充广告状态时间。
 * 恒定覆盖推广仓集成片段；仅当部署位存在独立父仓生产实体（bill-manager/watch-drill.js）
 * 时，另测该副本并断言两份实现同口径（GitHub 单仓检出时父仓专属部分以 skip 注明原因）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// 推广仓发布片段：仓库内相对路径，任何检出布局均存在。
const derivePromo = require('../integrations/bill-manager/watch-drill').deriveAdState;

// 父仓生产 watch-drill：相对本测试文件解析（test/ → 推广仓根 → 业务父目录 → bill-manager），
// 不依赖固定用户名/安装目录。仅当该文件真实存在时加载——单仓检出（GitHub）没有父仓，
// 此时不得把同一模块加载两次冒充双副本比较。
const PROD_WATCH_DRILL = path.join(__dirname, '..', '..', 'bill-manager', 'watch-drill.js');
const deriveProd = fs.existsSync(PROD_WATCH_DRILL) ? require(PROD_WATCH_DRILL).deriveAdState : null;

const COPIES = [{ name: 'promo-integrations', derive: derivePromo }];
if (deriveProd) COPIES.push({ name: 'bill-manager-prod', derive: deriveProd });

for (const { name, derive } of COPIES) {
  test(`${name}：仅有动作确认 → at=确认时间，evidenceKind=action_confirm`, () => {
    const shop = {
      id: 'shop-a',
      lastAdState: 'on',
      adStateConfirmedAt: '2026-09-28T02:03:46.000Z',
      lastDataAt: '2026-09-28T01:00:00.000Z',
    };
    const ad = derive({}, shop);
    assert.strictEqual(ad.state, 'on');
    assert.strictEqual(ad.at, '2026-09-28T02:03:46.000Z');
    assert.strictEqual(ad.evidenceKind, 'action_confirm');
    assert.strictEqual(ad.confirmedAt, '2026-09-28T02:03:46.000Z');
    assert.strictEqual(ad.observedAt, null);
  });

  test(`${name}：仅有只读观测 → at=观测时间，evidenceKind=read_only`, () => {
    const shop = {
      id: 'shop-a',
      lastAdState: 'off',
      adStateObservedAt: '2026-09-28T03:00:00.000Z',
      lastDataAt: '2026-09-28T01:00:00.000Z',
    };
    const ad = derive({}, shop);
    assert.strictEqual(ad.state, 'off');
    assert.strictEqual(ad.at, '2026-09-28T03:00:00.000Z');
    assert.strictEqual(ad.evidenceKind, 'read_only');
    assert.strictEqual(ad.observedAt, '2026-09-28T03:00:00.000Z');
    assert.strictEqual(ad.confirmedAt, null);
  });

  test(`${name}：无状态证据时间 → at=null，不得读取 lastDataAt 冒充`, () => {
    const shop = {
      id: 'shop-a',
      lastAdState: 'on',
      lastDataAt: '2026-09-28T01:00:00.000Z',
    };
    const ad = derive({}, shop);
    assert.strictEqual(ad.at, null, '无 adStateObservedAt/adStateConfirmedAt 时 at 必须为 null');
    assert.strictEqual(ad.evidenceKind, null);
    assert.strictEqual(ad.confirmedAt, null);
    assert.strictEqual(ad.observedAt, null);
    assert.strictEqual(ad.state, 'on', '状态本身仍如实返回');
    // lastDataAt 不得混入状态时间字段
    assert.notStrictEqual(ad.at, shop.lastDataAt);
  });

  test(`${name}：观测优先于确认（语义分离仍在）`, () => {
    const shop = {
      id: 'shop-a',
      lastAdState: 'off',
      adStateObservedAt: '2026-09-28T04:00:00.000Z',
      adStateConfirmedAt: '2026-09-28T02:00:00.000Z',
      lastDataAt: '2026-09-28T01:00:00.000Z',
    };
    const ad = derive({}, shop);
    assert.strictEqual(ad.at, '2026-09-28T04:00:00.000Z');
    assert.strictEqual(ad.evidenceKind, 'read_only');
    assert.strictEqual(ad.observedAt, '2026-09-28T04:00:00.000Z');
  });
}

test('两份副本同口径：同一输入输出 at/evidenceKind 一致', { skip: !deriveProd && '单仓检出无独立父仓实体，无双副本可比较' }, () => {
  const cases = [
    { id: 'a', lastAdState: 'on', adStateConfirmedAt: '2026-09-28T02:00:00.000Z', lastDataAt: '2026-09-28T01:00:00.000Z' },
    { id: 'b', lastAdState: 'off', adStateObservedAt: '2026-09-28T03:00:00.000Z' },
    { id: 'c', lastAdState: 'on', lastDataAt: '2026-09-28T01:00:00.000Z' },
  ];
  for (const shop of cases) {
    const a = derivePromo({}, shop);
    const b = deriveProd({}, shop);
    assert.strictEqual(a.at, b.at, `shop ${shop.id} at 一致`);
    assert.strictEqual(a.evidenceKind, b.evidenceKind, `shop ${shop.id} evidenceKind 一致`);
    assert.strictEqual(a.state, b.state);
  }
});

test('buildShopRows（promo 副本）：费用 lastDataAt 仍独立保留，不进 adState.at', () => {
  const { buildShopRows } = require('../integrations/bill-manager/watch-drill');
  const status = {
    shops: [{
      id: 'shop-a',
      name: '店A',
      platform: 'douyin',
      lastAdState: 'on',
      lastDataAt: '2026-09-12T09:00:00.000Z',
      today: { costCents: 100, orders: 2 },
      thresholdCents: 100,
    }],
    monitor: { enablePhaseToday: [] },
  };
  const rows = buildShopRows(status);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].lastDataAt, '2026-09-12T09:00:00.000Z', '费用采集时间仍在独立字段');
  assert.strictEqual(rows[0].adState.at, null, '无状态证据时 adState.at 不得取 lastDataAt');
  assert.strictEqual(rows[0].adState.evidenceKind, null);
});
