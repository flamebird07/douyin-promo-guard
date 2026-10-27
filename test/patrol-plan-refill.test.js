'use strict';

/**
 * Monitor onPollComplete（2026-10-26 patrol-plan-refill）离线测试：
 * 只测「完整周期收口后的非阻塞补发回调」门控语义——
 *   - 完成周期（ok=true 且至少一店真实处理）→ 恰好触发一次，且触发时 _cycleRunning 已清；
 *   - 回调抛错/返回 rejected promise → 绝不影响 pollOnce 结果；
 *   - 并发拒（busy）/全店 skipped/无启用店/pending 配置 → 一律不触发；
 * 纯内存 + 临时目录；不启动浏览器、不触网、不读任何 Cookie。
 *
 * 运行：node --test test/patrol-plan-refill.test.js
 */

const { test } = require('node:test');
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Monitor } = require('../src/engine/monitor.js');

const SHOP = { id: 'shop-1', name: '店铺一', displayName: '店铺一', platform: 'douyin', cookieFile: '店铺一', targetRoi: 15 };
const NOW = Date.UTC(2026, 9, 25, 2, 0, 0); // 上海 2026-10-25 10:00

function makeMonitor(shops, onPollComplete) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patrol-refill-mon-'));
  const cfgResult = {
    config: {
      monitor: { mockDataSource: true, mockData: { cost: 0, orders: 0, ads: { pages: [] } } },
      shops: shops || [SHOP],
      execution: { realMode: false },
      rules: [],
    },
    pending: [],
    ready: true,
    sourcePath: 'injected',
  };
  const m = new Monitor(cfgResult, { reader: {}, controller: {} }, {
    dataDir,
    nowFn: () => NOW,
    onPollComplete,
  });
  // 门控语义单测：把周期内店铺处理桩掉，其余并发/活跃门用确定性桩固定。
  m._pollShop = async () => ({ status: 'ok' });
  m._activeShops = () => (shops === undefined ? [SHOP] : shops);
  m._isShopActive = () => true;
  m._shopBusy = () => false;
  m._tryAcquireShop = () => true;
  m._releaseShop = () => {};
  return m;
}

test('完整周期：onPollComplete 恰好触发一次，且触发时周期锁已清', async () => {
  const calls = [];
  const m = makeMonitor(undefined, (info) => {
    calls.push({ ...info, cycleRunningAtCall: m._cycleRunning });
  });
  const r = await m.pollOnce('interval');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.length, 1, '完成周期必须恰好触发一次');
  assert.strictEqual(calls[0].cycleNo, r.cycleNo);
  assert.strictEqual(calls[0].cycleRunningAtCall, false, '触发必须发生在 _cycleRunning 清除之后');
  const r2 = await m.pollOnce('manual');
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(calls.length, 2, '第二个完成周期各触发一次（不叠加不去重跨周期）');
  assert.strictEqual(calls[1].cycleNo, r2.cycleNo);
});

test('回调抛错 / 返回 rejected promise：pollOnce 结果不受影响、无未处理异常', async () => {
  const mThrow = makeMonitor(undefined, () => { throw new Error('callback-boom'); });
  const r1 = await mThrow.pollOnce('interval');
  assert.strictEqual(r1.ok, true, '同步抛错不得改变巡查结果');
  const mReject = makeMonitor(undefined, () => Promise.reject(new Error('callback-reject')));
  const r2 = await mReject.pollOnce('interval');
  assert.strictEqual(r2.ok, true, 'rejected promise 不得改变巡查结果');
});

test('并发拒（busy）：第二连发不触发；收口后仅原周期触发一次', async () => {
  const calls = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const m = makeMonitor(undefined, (info) => calls.push(info.cycleNo));
  const slow = m.pollOnce('interval');
  const busy = await m.pollOnce('manual');
  assert.strictEqual(busy.ok, false);
  release();
  const done = await slow;
  assert.strictEqual(done.ok, true);
  assert.strictEqual(calls.length, 1, 'busy 拒绝的连发不触发；仅完成的原周期触发一次');
});

test('周期内停止（token.aborted）：即使此前已有店真实处理也不触发补发回调', async () => {
  const calls = [];
  const m = makeMonitor(undefined, (info) => calls.push(info.cycleNo));
  // 首店处理中途值守被停止（stop() 会把本轮 kind:'pause' 令牌置 aborted）：
  // 该周期不是"完整完成的数据周期"，收口后不得触发补发。
  m._pollShop = async (shopCfg, token) => { token.aborted = true; return { status: 'ok' }; };
  const r = await m.pollOnce('interval');
  assert.strictEqual(r.ok, true, '巡查结果本身如实完成');
  assert.strictEqual(Array.isArray(r.results) && r.results.some((x) => x && x.status !== 'skipped'), true, '确有一店真实处理（排除 all-skipped 干扰）');
  assert.strictEqual(calls.length, 0, '被中止的周期绝不触发补发回调');
});

test('全店 skipped（同店在途/停用等）→ 不触发', async () => {
  const calls = [];
  const m = makeMonitor(undefined, (info) => calls.push(info.cycleNo));
  m._pollShop = async () => ({ status: 'skipped', reason: 'shop-processing-busy' });
  const r = await m.pollOnce('interval');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.length, 0, '全店 skipped 的周期不是可补发的完整数据周期');
});

test('无启用店（shops 空）→ 不触发', async () => {
  const calls = [];
  const m = makeMonitor([], (info) => calls.push(info.cycleNo));
  const r = await m.pollOnce('interval');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(calls.length, 0, '无启用店周期不触发');
});

test('pending 非法配置（拒绝轮询）→ 不触发', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patrol-refill-mon-'));
  const calls = [];
  const m = new Monitor(
    { config: { monitor: {}, shops: [SHOP] }, pending: ['monitor.intervalMinutes 缺失'], ready: false, sourcePath: 'injected' },
    { reader: {}, controller: {} },
    { dataDir, nowFn: () => NOW, onPollComplete: (info) => calls.push(info.cycleNo) },
  );
  const r = await m.pollOnce('interval');
  assert.strictEqual(r.ok, false, 'pending 配置必须拒绝轮询');
  assert.strictEqual(calls.length, 0, '被拒绝的轮询不触发补发');
});

test('未注入 onPollComplete：行为与旧版一致（零触发零异常）', async () => {
  const m = makeMonitor(undefined, undefined);
  const r = await m.pollOnce('interval');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(m._onPollComplete, null);
});
