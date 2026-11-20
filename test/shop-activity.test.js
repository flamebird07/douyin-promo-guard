'use strict';

/**
 * 单店「当前动作」投影隔离测试（2026-11-20）。
 * 合同：租约在途（巡查/读取数据/登录接管/每日开启）→ 对应文本；释放或无在途 → 「空闲」。
 * 只读刷新在途（rt.dataRefreshing）无租约时也投影为「读取数据中（只读）」。
 * 不访问真实页面；运行：node --test test/shop-activity.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor');
const { makeTempDir, writeTempCookie, makeCfgResult } = require('./helpers');

function setup(t) {
  const cookieDir = makeTempDir('pg-cookies-');
  const dataDir = makeTempDir('pg-data-');
  t.after(() => {
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  writeTempCookie(cookieDir, '测试店铺一', {});
  const cfgResult = makeCfgResult({
    shops: [{ id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', enabled: true }],
  });
  const monitor = new Monitor(cfgResult, null, { dataDir, nowFn: () => Date.now(), delayFn: async () => {} });
  return { monitor };
}

const rowActivity = (monitor) => monitor.getStatus().shopRows[0].activity;

test('无在途 → 「空闲」', (t) => {
  const { monitor } = setup(t);
  assert.strictEqual(rowActivity(monitor), '空闲');
});

test('巡查租约在途 → 「值守巡查处理中」；释放 → 「空闲」', (t) => {
  const { monitor } = setup(t);
  assert.strictEqual(monitor._tryAcquireShop('shop-001', '值守巡查处理中'), true);
  assert.strictEqual(rowActivity(monitor), '值守巡查处理中');
  monitor._releaseShop('shop-001');
  assert.strictEqual(rowActivity(monitor), '空闲');
});

test('四个登记点的动作文本如实透出（读取数据/每日开启/登录接管）', (t) => {
  const { monitor } = setup(t);
  for (const [text] of [['读取数据中（只读）'], ['每日开启广告处理中'], ['登录接管处理中']]) {
    assert.strictEqual(monitor._tryAcquireShop('shop-001', text), true);
    assert.strictEqual(rowActivity(monitor), text);
    monitor._releaseShop('shop-001');
  }
  assert.strictEqual(rowActivity(monitor), '空闲');
});

test('互斥语义不回归：在途时再次 acquire 失败且不覆盖既有文本', (t) => {
  const { monitor } = setup(t);
  assert.strictEqual(monitor._tryAcquireShop('shop-001', '值守巡查处理中'), true);
  assert.strictEqual(monitor._tryAcquireShop('shop-001', '读取数据中（只读）'), false, '同店在途必须拒绝');
  assert.strictEqual(rowActivity(monitor), '值守巡查处理中', '既有文本不被覆盖');
  assert.strictEqual(monitor._shopBusy('shop-001'), true);
  monitor._releaseShop('shop-001');
  assert.strictEqual(monitor._shopBusy('shop-001'), false);
});

test('租约内细化：巡查各阶段文本（读取数据/读取广告状态）覆盖初始文本；释放后回空闲', (t) => {
  const { monitor } = setup(t);
  assert.strictEqual(monitor._tryAcquireShop('shop-001', '值守巡查处理中'), true);
  monitor._setShopActivity('shop-001', '读取数据中（费用/订单）');
  assert.strictEqual(rowActivity(monitor), '读取数据中（费用/订单）');
  monitor._setShopActivity('shop-001', '读取广告状态（乘方清单回读）');
  assert.strictEqual(rowActivity(monitor), '读取广告状态（乘方清单回读）');
  monitor._setShopActivity('shop-001', '关闭广告中（乘方暂停）');
  assert.strictEqual(rowActivity(monitor), '关闭广告中（乘方暂停）');
  monitor._releaseShop('shop-001');
  assert.strictEqual(rowActivity(monitor), '空闲');
});

test('细化打点不越权：未持租约时 _setShopActivity 不生效', (t) => {
  const { monitor } = setup(t);
  monitor._setShopActivity('shop-001', '读取数据中（费用/订单）');
  assert.strictEqual(rowActivity(monitor), '空闲', '无租约不得出现活动文本');
});
