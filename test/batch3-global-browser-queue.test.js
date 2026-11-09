'use strict';

/**
 * 批次三（PROMO-IMPL-F1）：全局浏览器操作排队锁（跨进程文件锁）。
 *
 * 用户决策（2026-11-09）：无法确认多店并行浏览器操作安全，先做**全局排队**。
 * 锁原语复用 promo-plan-scheduler 的 acquireProcessLock/releaseProcessLock
 * （O_EXCL 独占创建 + {pid,at} + 过期接管），键固定 global-browser-op。
 *
 * 被测行为（全部 mock + 临时目录，不访问真实页面）：
 *  1) monitor 读取外壳锁忙 → 本轮跳过该店，audit kind=poll/status=skipped/
 *     reason=global-browser-op-busy，且不改写广告状态、不进入真实读取；
 *  2) monitor 读取外壳锁空闲 → 正常执行，finally 释放锁；
 *  3) monitor 读取异常（操作 throw）→ 不残留锁；
 *  4) 未注入锁（null）→ 与旧版行为一致；
 *  5) 开关动作执行处锁忙 → 零动作跳过（不调用真实执行体）；
 *  6) 发布排程锁忙 → 该店本轮不派发且记录原因；正常路径取放对称；
 *  7) 恢复端点全局锁忙 → 409；per-shop → global 顺序一致（per-shop 忙时不取全局）；
 *  8) 两锁均空闲 → 恢复链结束后 per-shop 与全局锁都已释放（无泄漏）。
 *
 * 发布/恢复侧直接使用父仓 bill-manager 的生产实现（BM_DIR 可显式覆盖）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { Monitor } = require('../src/engine/monitor.js');
const {
  makeTempDir, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock, writeTempCookie,
} = require('./helpers.js');
const { shanghaiMs } = require('../src/lib/time');

const BM_DIR = process.env.BM_DIR || path.join(__dirname, '..', '..', 'bill-manager');
const SCHED_MODULE = path.join(BM_DIR, 'promo-plan-scheduler.js');
const WATCH_DRILL_MODULE = path.join(BM_DIR, 'watch-drill.js');
const HAS_BILL_MANAGER = fs.existsSync(SCHED_MODULE) && fs.existsSync(WATCH_DRILL_MODULE);

const DATE = '2026-11-09';
const SHOP_ID = 'shop-a';
const SHOP_A = { id: SHOP_ID, name: '甲店', cookieFile: 'shop-a', accountId: 'acc-a', enabled: true };

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// ══════════════════════════════════════════════════════════════
// Monitor 侧
// ══════════════════════════════════════════════════════════════

function setupMonitor(lock) {
  const dataDir = makeTempDir('f1-data-');
  const cookieDir = makeTempDir('f1-cookie-');
  writeTempCookie(cookieDir, SHOP_A.cookieFile);
  const clock = makeClock(shanghaiMs(DATE, '09:00'));
  const controller = makeStatefulController({
    identity: { id: SHOP_A.id, name: SHOP_A.name },
    ads: [{ adId: 'a-1', name: '广告1', status: '投放中', switchChecked: true }],
  });
  const reader = makeLinkedReader(controller, {
    costCents: 50, orders: 100,
    costShopId: SHOP_ID, orderShopId: SHOP_ID, adsShopId: SHOP_ID,
    costDate: DATE, orderDate: DATE, adsDate: DATE,
    costFetchedAt: new Date(clock.nowFn()).toISOString(),
    orderFetchedAt: new Date(clock.nowFn()).toISOString(),
    adsFetchedAt: new Date(clock.nowFn()).toISOString(),
  }, clock.nowFn);
  const cfgResult = makeCfgResult({
    cookieDir,
    shops: [SHOP_A],
    monitor: { chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: false, enableEnabled: false } },
  });
  const opts = { dataDir, nowFn: clock.nowFn, delayFn: clock.delayFn };
  if (lock !== undefined) opts.globalBrowserLock = lock;
  const monitor = new Monitor(cfgResult, { reader, controller }, opts);
  return { monitor, controller, clock, dataDir };
}

function readAudit(monitor) {
  try {
    return fs.readFileSync(monitor.auditFile, 'utf8')
      .trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (_) {
    return [];
  }
}

test('F1-M1 读取外壳锁忙：值守本轮跳过该店，audit 记 global-browser-op-busy，不改写广告状态', async () => {
  let innerCalls = 0;
  let releases = 0;
  const { monitor } = setupMonitor({
    acquire: () => ({ held: false, busy: true }),
    release: () => { releases += 1; },
  });
  monitor._readChengfangAdState = async () => { innerCalls += 1; return { state: 'off' }; };
  const rt = monitor._runtime(SHOP_A.id);
  rt.lastAdState = { state: 'on', at: 'seeded' };

  const r = await monitor.pollOnce('test');
  assert.equal(r.ok, true);
  assert.equal(r.results.length, 1);
  assert.equal(r.results[0].status, 'skipped', JSON.stringify(r.results[0]));
  assert.equal(innerCalls, 0, '锁忙时不得进入真实读取（浏览器未打开）');
  assert.equal(releases, 0, '未取得锁不得释放');
  assert.deepEqual(rt.lastAdState, { state: 'on', at: 'seeded' }, '锁忙不得改写广告状态');
  const audit = readAudit(monitor).filter((x) => x.kind === 'poll' && x.status === 'skipped');
  assert.ok(audit.some((x) => x.reason === 'global-browser-op-busy'), JSON.stringify(audit));
});

test('F1-M2 读取外壳锁空闲：正常执行，finally 释放锁', async () => {
  let innerCalls = 0;
  const released = [];
  const { monitor } = setupMonitor({
    acquire: () => ({ held: true, token: 'tok-1' }),
    release: (token) => { released.push(token); },
  });
  monitor._readChengfangAdState = async (shopCfg, meta) => {
    innerCalls += 1;
    if (meta) meta.closeState = { closed: true, source: 'session' };
    // 低于阈值 + 已开启 → 本轮不应产生任何开关动作（只验证取放对称）。
    return { state: 'on' };
  };

  const r = await monitor.pollOnce('test');
  assert.equal(r.ok, true);
  assert.notEqual(r.results[0].status, 'skipped', JSON.stringify(r.results[0]));
  assert.equal(innerCalls, 1, '锁空闲时必须执行一次真实读取');
  assert.deepEqual(released, ['tok-1'], 'finally 必须释放本次取得的锁');
});

test('F1-M3 读取异常（操作 throw）：不残留锁', async () => {
  const released = [];
  const { monitor } = setupMonitor({
    acquire: () => ({ held: true, token: 'tok-throw' }),
    release: (token) => { released.push(token); },
  });
  monitor._readChengfangAdState = async () => { throw new Error('fixture-read-boom'); };

  await assert.rejects(() => monitor._readChengfangAdStateBounded(SHOP_A), /fixture-read-boom/);
  assert.deepEqual(released, ['tok-throw'], '异常路径也必须释放锁');
});

test('F1-M4 未注入锁（null）：旧行为不排队，读取照常', async () => {
  let innerCalls = 0;
  const { monitor } = setupMonitor(undefined);
  assert.equal(monitor._globalBrowserLock, null);
  monitor._readChengfangAdState = async (shopCfg, meta) => {
    innerCalls += 1;
    if (meta) meta.closeState = { closed: true, source: 'session' };
    return { state: 'off' };
  };
  const r = await monitor._readChengfangAdStateBounded(SHOP_A);
  assert.equal(innerCalls, 1);
  assert.equal(r.state, 'off');
});

test('F1-M5 开关动作执行处锁忙：零动作跳过，不调用真实执行体', async () => {
  let innerCalls = 0;
  const { monitor } = setupMonitor({
    acquire: () => ({ held: false, busy: true }),
    release: () => { throw new Error('must-not-release'); },
  });
  monitor._executeEnableBatchForInner = async () => { innerCalls += 1; return { outcome: 'all_enabled_confirmed' }; };
  const r = await monitor._executeEnableBatchFor(SHOP_A, { aborted: false }, { reason: 'test' });
  assert.equal(innerCalls, 0, '锁忙不得调用真实开启执行体');
  assert.equal(r.status, 'skipped');
  assert.equal(r.globalBusy, true);
  const audit = readAudit(monitor).filter((x) => x.reason === 'global-browser-op-busy');
  assert.ok(audit.length >= 1, JSON.stringify(audit));
});

// ══════════════════════════════════════════════════════════════
// 发布排程侧（父仓 bill-manager）
// ══════════════════════════════════════════════════════════════

function makeSchedulerDir() {
  return {
    ledgerFile: path.join(tmp('f1-sched-'), 'ledger.json'),
    leaseDir: tmp('f1-sched-lease-'),
  };
}

function makeScheduler(leaseDir, ledgerFile, runPlan) {
  const schedMod = require(SCHED_MODULE);
  const clockMs = Date.parse('2026-11-09T00:30:00Z'); // 上海 08:30
  const calls = [];
  const scheduler = schedMod.createScheduler({
    planPublishing: {
      enabled: true, autoConfirm: true, time: '08:00', plansPerShopPerDay: 1,
      dailyBudget: 300, timezone: 'Asia/Shanghai',
    },
    ledgerFile,
    lockFile: ledgerFile + '.lock',
    leaseDir,
    nowMs: () => clockMs,
    intervalMs: 60 * 60 * 1000,
    listShops: () => [{ id: 'S1', name: '瑾漂亮潮流服饰' }],
    buildBusiness: (shop) => ({ shop: shop.name, accountId: '1710242295996424', roi: 15, dailyBudget: 300 }),
    runPlan: runPlan || (async () => { calls.push(1); return { status: 'success', planId: 'p1' }; }),
    readDaySuccess: () => 0,
  });
  return { scheduler, calls };
}

test('F1-S1 发布排程全局锁忙：该店本轮不派发且记录原因', { skip: !HAS_BILL_MANAGER }, async () => {
  const schedMod = require(SCHED_MODULE);
  const { leaseDir, ledgerFile } = makeSchedulerDir();
  const lockFile = schedMod.globalBrowserOpLockPath(leaseDir);
  const held = schedMod.acquireProcessLock(lockFile, () => Date.now(), 60 * 1000);
  assert.equal(held.held, true);
  try {
    const { scheduler, calls } = makeScheduler(leaseDir, ledgerFile, null);
    const r = await scheduler.tick();
    assert.equal(calls.length, 0, '全局锁忙时不得调用 runPlan（不派发）');
    assert.equal(r.ran, true, JSON.stringify(r));
    const rec = (r.results || []).find((x) => x.shopId === 'S1');
    assert.ok(rec, JSON.stringify(r.results));
    assert.equal(rec.reason, 'global-browser-op-busy', JSON.stringify(rec));
    const ledger = schedMod.loadLedger(ledgerFile);
    const day = ledger.days && ledger.days[DATE];
    const shopRec = day && day.shops && day.shops.S1;
    assert.ok(!shopRec || !shopRec.entries || !shopRec.entries['1'], '锁忙不得写 in-progress 条目');
  } finally {
    schedMod.releaseProcessLock(lockFile, held.token);
  }
});

test('F1-S2 发布排程全局锁空闲：正常派发，结束后释放（取放对称）', { skip: !HAS_BILL_MANAGER }, async () => {
  const schedMod = require(SCHED_MODULE);
  const { leaseDir, ledgerFile } = makeSchedulerDir();
  const lockFile = schedMod.globalBrowserOpLockPath(leaseDir);
  const { scheduler, calls } = makeScheduler(leaseDir, ledgerFile, null);
  const r = await scheduler.tick();
  assert.equal(calls.length, 1, JSON.stringify(r));
  assert.equal(r.ran, true);
  assert.equal(fs.existsSync(lockFile), false, '正常结束后必须释放全局锁（取放对称）');
  const day = schedMod.loadLedger(ledgerFile).days && schedMod.loadLedger(ledgerFile).days[DATE];
  const rec = day && day.shops && day.shops.S1;
  assert.ok(rec && rec.plans === 1, JSON.stringify(rec));
});

// ══════════════════════════════════════════════════════════════
// 恢复端点（父仓 bill-manager watch-drill）
// ══════════════════════════════════════════════════════════════

function makeRecoveryDrill(leaseDir, publisherDir) {
  const { createWatchDrill } = require(WATCH_DRILL_MODULE);
  const cookieDir = tmp('f1-rec-cookie-');
  writeTempCookie(cookieDir, SHOP_A.cookieFile);
  const clockMs = Date.parse('2026-11-09T01:00:00Z'); // 上海 09:00
  const cfg = {
    shops: [{ id: SHOP_A.id, name: SHOP_A.name, cookieFile: SHOP_A.cookieFile, accountId: SHOP_A.accountId, enabled: true }],
    rules: [{ type: 'wholeShopCostPerOrder', thresholdCents: 100, enabled: true }],
    schedule: { dailyStartHour: 8, intervalMinutes: 30 },
    monitor: { snapshotMaxAgeMinutes: 30, chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: false, enableEnabled: false, enableHour: 7 } },
    login: { cookieSourceDir: cookieDir },
    execution: { realMode: false, maxAdPages: 50, readbackTimeoutMs: 1000, readbackAttempts: 1, readbackIntervalMs: 10 },
  };
  const timers = { delayFn: () => new Promise(() => {}) }; // 永不 resolve：不空转调度循环
  const drill = createWatchDrill({
    shopName: SHOP_A.id,
    nowFn: () => clockMs,
    delayFn: timers.delayFn,
    dataDir: tmp('f1-rec-data-'),
    config: cfg,
    configSourcePath: 'test',
    readAdState: async () => 'mixed',
    schedulerLeaseDir: leaseDir,
    publisherDir,
  });
  drill._internal._monitor = { _shopBusy: () => false };
  return { drill, clockMs };
}

function callHttp(drill, method, url, body) {
  return new Promise((resolve) => {
    const req = {
      url, method,
      on(evt, cb) {
        if (evt === 'data' && body != null) setImmediate(() => cb(Buffer.from(JSON.stringify(body))));
        if (evt === 'end') setImmediate(() => cb());
        return req;
      },
    };
    const res = {
      writeHead(code) { this._code = code; },
      end(payload) { resolve({ code: this._code, body: JSON.parse(payload) }); },
    };
    Promise.resolve(drill.serveHttp(req, res)).then(() => {
      if (res._code === undefined) resolve({ code: 0, body: null });
    });
  });
}

test('F1-R1 恢复端点全局锁忙：409；per-shop 租约在 finally 释放', { skip: !HAS_BILL_MANAGER }, async () => {
  const schedMod = require(SCHED_MODULE);
  const leaseDir = tmp('f1-rec-lease-');
  const publisherDir = tmp('f1-rec-pub-');
  const { drill, clockMs } = makeRecoveryDrill(leaseDir, publisherDir);
  try {
    const globalFile = schedMod.globalBrowserOpLockPath(leaseDir);
    const held = schedMod.acquireProcessLock(globalFile, () => Date.now(), 60 * 1000);
    assert.equal(held.held, true);
    try {
      const r = await callHttp(drill, 'POST', '/api/watch-drill/plan-publishing/recover', { shopId: SHOP_A.id });
      assert.equal(r.code, 409, JSON.stringify(r.body));
      assert.equal(r.body.busy, 'global-browser-op', JSON.stringify(r.body));
      const leaseFile = schedMod.shopDayLeasePath(leaseDir, schedMod.shopDayLeaseKey({
        accountId: SHOP_A.accountId, shopId: SHOP_A.id, businessDate: '2026-11-09',
      }));
      assert.equal(fs.existsSync(leaseFile), false, '409 后必须释放本次 per-shop 租约，不得留下假在途');
    } finally {
      schedMod.releaseProcessLock(globalFile, held.token);
    }
  } finally {
    try { drill.stop(); } catch (_) {}
  }
});

test('F1-R2 恢复端点 per-shop 租约忙：先判 per-shop，不取全局锁（顺序一致）', { skip: !HAS_BILL_MANAGER }, async () => {
  const schedMod = require(SCHED_MODULE);
  const leaseDir = tmp('f1-rec-lease-');
  const publisherDir = tmp('f1-rec-pub-');
  const { drill } = makeRecoveryDrill(leaseDir, publisherDir);
  const leaseFile = schedMod.shopDayLeasePath(leaseDir, schedMod.shopDayLeaseKey({
    accountId: SHOP_A.accountId, shopId: SHOP_A.id, businessDate: '2026-11-09',
  }));
  const held = schedMod.acquireProcessLock(leaseFile, () => Date.now(), 60 * 1000);
  assert.equal(held.held, true);
  try {
    const r = await callHttp(drill, 'POST', '/api/watch-drill/plan-publishing/recover', { shopId: SHOP_A.id });
    assert.equal(r.code, 409, JSON.stringify(r.body));
    assert.equal(fs.existsSync(schedMod.globalBrowserOpLockPath(leaseDir)), false,
      'per-shop 忙时必须先返回，绝不先取全局锁（全系统顺序 per-shop → global）');
  } finally {
    schedMod.releaseProcessLock(leaseFile, held.token);
    try { drill.stop(); } catch (_) {}
  }
});

test('F1-R3 两锁均空闲：恢复链结束后 per-shop 与全局锁全部释放（无泄漏）', { skip: !HAS_BILL_MANAGER }, async () => {
  const schedMod = require(SCHED_MODULE);
  const leaseDir = tmp('f1-rec-lease-');
  const publisherDir = tmp('f1-rec-pub-');
  const { drill } = makeRecoveryDrill(leaseDir, publisherDir);
  const leaseFile = schedMod.shopDayLeasePath(leaseDir, schedMod.shopDayLeaseKey({
    accountId: SHOP_A.accountId, shopId: SHOP_A.id, businessDate: '2026-11-09',
  }));
  try {
    const r = await callHttp(drill, 'POST', '/api/watch-drill/plan-publishing/recover', { shopId: SHOP_A.id });
    assert.notEqual(r.code, 409, JSON.stringify(r.body));
    assert.equal(fs.existsSync(leaseFile), false, 'per-shop 租约必须释放');
    assert.equal(fs.existsSync(schedMod.globalBrowserOpLockPath(leaseDir)), false, '全局锁必须释放');
  } finally {
    try { if (drill._planScheduler && typeof drill._planScheduler.stop === 'function') drill._planScheduler.stop(); } catch (_) {}
    try { drill.stop(); } catch (_) {}
  }
});
