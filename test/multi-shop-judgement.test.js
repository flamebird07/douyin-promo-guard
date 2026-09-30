'use strict';

/**
 * 隔离测试：判断日志去重范围 = 同一轮 + 同一店。
 * 两店同轮各记一条；完成顺序颠倒不影响；同店同轮重复调用只记一条。
 * mock + 临时目录，不访问真实广告页。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { Monitor } = require('../src/engine/monitor');
const { makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock, waitFor } = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');

function setup(t) {
  const cookieDir = makeTempDir('pg-judge-cookies-');
  const dataDir = makeTempDir('pg-judge-data-');
  t.after(() => {
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const shops = [
    { id: 'shop-a', name: '店A', cookieFile: '店A', enabled: true },
    { id: 'shop-b', name: '店B', cookieFile: '店B', enabled: true },
  ];
  for (const s of shops) writeTempCookie(cookieDir, s.cookieFile);
  const cfgResult = makeCfgResult({ cookieDir, shops, monitor: { legacyWholeShopCloseEnabled: true } });
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
  return { monitor, shops };
}

function fakeData(costCents, orders) {
  return {
    ok: true,
    cost: { valueCents: costCents, businessDate: '2026-09-28' },
    orders: { valueCount: orders },
    evaluation: { over: false, reason: 'test' },
  };
}

test('同轮两店：各记录一条 judgement，含各自 shopId 与判定数据', async (t) => {
  const { monitor, shops } = setup(t);
  monitor._currentCycle = { cycleNo: 1, trigger: 'interval', startedAt: new Date().toISOString() };
  monitor.cycleNo = 1;

  const recA = monitor._emitJudgement(shops[0], {
    data: fakeData(20000, 100),
    over: true,
    status: 'ok',
    reason: '店A超标',
    currentAdState: 'on',
  });
  const recB = monitor._emitJudgement(shops[1], {
    data: fakeData(5000, 100),
    over: false,
    status: 'ok',
    reason: '店B未超标',
    currentAdState: 'off',
  });

  const j = monitor.judgements.filter((x) => x.kind === 'judgement');
  assert.strictEqual(j.length, 2, '同轮两店各一条');
  assert.strictEqual(j[0].shopId, 'shop-a');
  assert.strictEqual(j[1].shopId, 'shop-b');
  assert.strictEqual(j[0].cycleNo, 1);
  assert.strictEqual(j[1].cycleNo, 1);
  assert.strictEqual(j[0].costCents, 20000);
  assert.strictEqual(j[0].orders, 100);
  assert.strictEqual(j[0].over, true);
  assert.strictEqual(j[1].costCents, 5000);
  assert.strictEqual(j[1].over, false);
  assert.strictEqual(recA.shopId, 'shop-a');
  assert.strictEqual(recB.shopId, 'shop-b');
});

test('完成顺序颠倒：后启动先完成的一店不吞掉另一店', async (t) => {
  const { monitor, shops } = setup(t);
  monitor._currentCycle = { cycleNo: 2, trigger: 'manual', startedAt: new Date().toISOString() };
  monitor.cycleNo = 2;

  // 先记 shop-b（后完成/先写入），再记 shop-a
  monitor._emitJudgement(shops[1], { data: fakeData(1, 1), over: false, status: 'ok', reason: 'b-first' });
  monitor._emitJudgement(shops[0], { data: fakeData(2, 2), over: false, status: 'ok', reason: 'a-second' });

  const j = monitor.judgements.filter((x) => x.kind === 'judgement');
  assert.strictEqual(j.length, 2);
  const ids = j.map((x) => x.shopId).sort();
  assert.deepEqual(ids, ['shop-a', 'shop-b']);
  assert.strictEqual(j[0].shopId, 'shop-b', '按完成/写入顺序，不按配置顺序吞并');
  assert.strictEqual(j[1].shopId, 'shop-a');
});

test('同店同轮重复调用：只记录一次；换轮后再记一条', async (t) => {
  const { monitor, shops } = setup(t);
  monitor._currentCycle = { cycleNo: 3, trigger: 'interval', startedAt: new Date().toISOString() };
  monitor.cycleNo = 3;

  monitor._emitJudgement(shops[0], { data: fakeData(100, 1), over: false, status: 'ok', reason: 'first' });
  monitor._emitJudgement(shops[0], { data: fakeData(100, 1), over: false, status: 'ok', reason: 'dup-in-cycle' });
  monitor._emitJudgement(shops[0], { data: fakeData(100, 1), over: false, status: 'ok', reason: 'dup-again' });

  let j = monitor.judgements.filter((x) => x.kind === 'judgement');
  assert.strictEqual(j.length, 1, '同店同轮只一条');
  assert.strictEqual(j[0].reason, 'first');

  // 同店另一轮 → 再记一条
  monitor._currentCycle = { cycleNo: 4, trigger: 'interval', startedAt: new Date().toISOString() };
  monitor.cycleNo = 4;
  monitor._emitJudgement(shops[0], { data: fakeData(100, 1), over: false, status: 'ok', reason: 'next-cycle' });

  j = monitor.judgements.filter((x) => x.kind === 'judgement');
  assert.strictEqual(j.length, 2);
  assert.strictEqual(j[1].cycleNo, 4);
  assert.strictEqual(j[1].reason, 'next-cycle');
});

test('并行完成交错：A-B-A 重入不重复，B 仍记入', async (t) => {
  const { monitor, shops } = setup(t);
  monitor._currentCycle = { cycleNo: 5, trigger: 'interval', startedAt: new Date().toISOString() };
  monitor.cycleNo = 5;

  monitor._emitJudgement(shops[0], { data: fakeData(1, 1), over: false, status: 'ok', reason: 'a1' });
  monitor._emitJudgement(shops[1], { data: fakeData(2, 2), over: false, status: 'ok', reason: 'b1' });
  monitor._emitJudgement(shops[0], { data: fakeData(1, 1), over: false, status: 'ok', reason: 'a2-reentry' });

  const j = monitor.judgements.filter((x) => x.kind === 'judgement');
  assert.strictEqual(j.length, 2);
  assert.deepEqual(j.map((x) => x.shopId), ['shop-a', 'shop-b']);
  assert.strictEqual(j[0].reason, 'a1', '同店重入不改写已有记录');
});
