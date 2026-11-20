'use strict';

/**
 * 巡查/调度修复测试（2026-11-21）：
 * 1) busy 跳过店收口补跑：巡查与每日开启相位共用单店锁，撞锁跳过的店在收口后
 *    锁已释放时补跑一次（结果不再停留 skipped）；锁仍被持有则不补跑（绝不并发）。
 * 2) daily_schedule enableHour 残留门禁撤除（2026-11-09 定稿回归锁定）：
 *    每日 00:05 后首查、暂停才开启、无小时上界——00:34（enableHour=7 之前的旧拦截时段）
 *    的 daily_schedule 真实开启不再被 blocked_window 拦截；threshold_recovery 的
 *    值守窗口（dailyStartHour）语义不回归（07:00 前仍拒）。
 * 不访问真实页面（pageOpener 注入假会话）；运行：node --test test/patrol-fixes.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { Monitor } = require('../src/engine/monitor');
const { ChengfangRunner } = require('../src/engine/chengfang-runner');
const { makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController, shanghaiDate } = require('./helpers');

function baseSetup(t, shops) {
  const cookieDir = makeTempDir('pg-cookies-');
  const dataDir = makeTempDir('pg-data-');
  t.after(() => {
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  for (const s of shops) writeTempCookie(cookieDir, s.cookieFile || s.name, {});
  const cfgResult = makeCfgResult({ shops });
  return { dataDir, cfgResult };
}

test('busy 跳过店：收口后锁已释放 → 补跑成功（结果非 skipped/busy）', async (t) => {
  const shops = [
    { id: 'shop-001', name: '店A', cookieFile: '店A', enabled: true },
    { id: 'shop-002', name: '店B', cookieFile: '店B', enabled: true },
  ];
  const { dataDir, cfgResult } = baseSetup(t, shops);
  const IDENTITY = { id: 'shop-001', name: '店A' };
  const controller = makeStatefulController({ identity: IDENTITY, ads: [] });
  const reader = makeLinkedReader(controller, { costCents: 50, orders: 1 });
  const monitor = new Monitor(cfgResult, { reader, controller }, { dataDir, nowFn: () => Date.now(), delayFn: async () => {} });
  // 巡查启动前持有店B 锁（模拟每日开启相位在途）
  assert.strictEqual(monitor._tryAcquireShop('shop-002', '每日开启首查（回读广告状态）'), true);
  // 审计钩子：巡查对店B 记 shop-processing-busy 的那一刻，模拟开启相位收口（同步释放锁）
  const origAudit = monitor._audit.bind(monitor);
  monitor._audit = (a) => {
    if (a && a.kind === 'poll' && a.status === 'skipped' && String(a.reason || '').includes('busy')) {
      monitor._releaseShop('shop-002');
    }
    return origAudit(a);
  };
  t.after(() => { monitor._audit = origAudit; });

  const r = await monitor.pollOnce('test');
  const shop2 = r.results.find((x) => x.shopId === 'shop-002');
  assert.ok(shop2, '店B 有结果');
  assert.ok(!(shop2.status === 'skipped' && /在途|并发|busy/i.test(String(shop2.reason || ''))),
    `店B 不得停留在 busy 跳过（补跑应接管）：${JSON.stringify(shop2)}`);
});

test('busy 跳过店：锁始终被持有 → 不补跑（绝不并发），结果如实 skipped', async (t) => {
  const shops = [
    { id: 'shop-001', name: '店A', cookieFile: '店A', enabled: true },
    { id: 'shop-002', name: '店B', cookieFile: '店B', enabled: true },
  ];
  const { dataDir, cfgResult } = baseSetup(t, shops);
  const IDENTITY = { id: 'shop-001', name: '店A' };
  const controller = makeStatefulController({ identity: IDENTITY, ads: [] });
  const reader = makeLinkedReader(controller, { costCents: 50, orders: 1 });
  const monitor = new Monitor(cfgResult, { reader, controller }, { dataDir, nowFn: () => Date.now(), delayFn: async () => {} });
  assert.strictEqual(monitor._tryAcquireShop('shop-002', '每日开启首查（回读广告状态）'), true);

  const r = await monitor.pollOnce('test');
  const shop2 = r.results.find((x) => x.shopId === 'shop-002');
  assert.strictEqual(shop2.status, 'skipped', '锁被持有时如实 skipped');
  assert.ok(/在途|并发|busy/i.test(String(shop2.reason || '')), `跳过原因须指向在途占用：${shop2.reason}`);
  assert.strictEqual(monitor._shopBusy('shop-002'), true, '外部持有的锁不被巡查释放');
});

test('daily_schedule 撤除 enableHour 残留门禁：00:34（旧拦截时段）不再 blocked_window', async (t) => {
  // 假时钟：上海 2026-11-21 00:34 = 2026-11-20T16:34:00Z（昨晚真实撞门时刻）
  const NOW = Date.parse('2026-11-20T16:34:00.000Z');
  const cookieDir = makeTempDir('pg-cookies-');
  const dataDir = makeTempDir('pg-data-');
  t.after(() => { fs.rmSync(cookieDir, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); });
  writeTempCookie(cookieDir, '店A', {});
  const cfgResult = makeCfgResult({
    shops: [{ id: 'shop-001', name: '店A', cookieFile: '店A', enabled: true }],
    monitor: { chengfang: { enableHour: 7 } }, // 显式保留旧配置值：门禁撤除后它不再拦截
  });
  const runner = new ChengfangRunner({
    config: Object.assign({}, cfgResult.config, {
      execution: { realMode: true, dryRun: false },
      monitor: { chengfang: { scope: ['全店托管'], pauseEnabled: true, enableEnabled: true, enableHour: 7 } },
    }),
    now: () => NOW,
    audit: () => {},
  });
  const r = await runner.executeChengfangEnableBatch({
    shopCfg: cfgResult.config.shops[0],
    cycleToken: null,
    trigger: 'test',
    pageOpener: async () => { throw new Error('测试不打开真实页面'); },
    loginCfg: {},
    enableSource: 'daily_schedule',
  });
  assert.notStrictEqual(r.outcome, 'blocked_window', `00:34 的 daily_schedule 开启不得再被 enableHour 拦截：${JSON.stringify(r)}`);
});

test('threshold_recovery 值守窗口语义不回归：07:00 前（dailyStartHour=8）仍拒', async (t) => {
  const NOW = Date.parse('2026-11-20T16:34:00.000Z'); // 上海 00:34
  const cookieDir = makeTempDir('pg-cookies-');
  const dataDir = makeTempDir('pg-data-');
  t.after(() => { fs.rmSync(cookieDir, { recursive: true, force: true }); fs.rmSync(dataDir, { recursive: true, force: true }); });
  writeTempCookie(cookieDir, '店A', {});
  const cfgResult = makeCfgResult({
    shops: [{ id: 'shop-001', name: '店A', cookieFile: '店A', enabled: true }],
    schedule: { dailyStartHour: 8, intervalMinutes: 30, timezone: 'Asia/Shanghai' },
    monitor: { chengfang: { scope: ['全店托管'], pauseEnabled: true, enableEnabled: true } },
  });
  const runner = new ChengfangRunner({
    config: Object.assign({}, cfgResult.config, { execution: { realMode: true, dryRun: false } }),
    now: () => NOW,
    audit: () => {},
  });
  const r = await runner.executeChengfangEnableBatch({
    shopCfg: cfgResult.config.shops[0],
    cycleToken: null,
    trigger: 'test',
    pageOpener: async () => { throw new Error('测试不打开真实页面'); },
    loginCfg: {},
    enableSource: 'threshold_recovery',
  });
  assert.strictEqual(r.outcome, 'blocked_window', 'threshold_recovery 的值守窗口门不回归');
  assert.ok(/值守窗口/.test(String(r.reason || '')), `拒绝原因指向值守窗口：${r.reason}`);
});
