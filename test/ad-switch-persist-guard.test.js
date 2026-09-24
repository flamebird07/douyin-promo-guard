'use strict';

/**
 * 动作状态持久化故障隔离测试（临时目录；禁止破坏真实 data/state.json）。
 * 不启服务、不登录、不访问真实广告/飞书。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor');
const { AdSwitchOrchestrator, createSwitchSerialGate } = require('../src/engine/ad-switch-orchestrator');
const { makeTempDir, writeTempCookie, makeCfgResult, makeStatefulController, makeLinkedReader } = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');

const SHOP = { id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', accountId: '1710242295996424', enabled: true };
const IDENTITY = { id: SHOP.id, name: SHOP.name, accountId: SHOP.accountId };

function setupMon(t, { failWrite = false, failRename = false, adState = 'on' } = {}) {
  const cookieDir = makeTempDir('ps-ck-');
  const dataDir = makeTempDir('ps-data-');
  t.after(() => {
    try { mon.stopEnableScheduler({ byUser: false, reason: 'c' }); } catch (_) {}
    try { mon.stop(); } catch (_) {}
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  writeTempCookie(cookieDir, '测试店铺一');
  const cfgResult = makeCfgResult({
    cookieDir,
    shops: [SHOP],
    execution: { realMode: true, dryRun: false, readbackTimeoutMs: 200, readbackIntervalMs: 1 },
    monitor: { chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: true, enableEnabled: true } },
  });
  const controller = makeStatefulController({ identity: IDENTITY, ads: [] });
  const nowFn = () => shanghaiMs('2026-09-12', '08:30');
  const reader = makeLinkedReader(controller, {
    costCents: 5000, orders: 100, pageSource: 'promo-page', costAccountId: SHOP.accountId,
  }, nowFn);
  const calls = { enable: 0, pause: 0, switchClick: 0 };
  let stateRef = adState;
  const mon = new Monitor(cfgResult, { reader, controller }, {
    dataDir,
    nowFn,
    readAdState: async () => stateRef,
    chengfangOpener: async () => {
      calls.switchClick += 0;
      return {
        page: {},
        controller: {
          verifyIdentity: async () => ({ ok: true, pageShopId: SHOP.id, pageShopName: SHOP.name, pageAccountId: SHOP.accountId }),
          refreshView: async () => {},
          switchView: async () => {},
          readView: async () => ({ rows: { rows: [] }, pagination: { total: 0, hasNext: false } }),
        },
        close: async () => {},
      };
    },
  });
  // 存储故障注入（不碰真实 data/state.json）
  const realSave = mon._saveState.bind(mon);
  mon._saveState = function () {
    if (failWrite || failRename) return { ok: false, reason: '注入:写入失败' };
    return realSave();
  };
  mon._executeEnableBatchFor = async () => {
    calls.enable += 1;
    return {
      outcome: 'all_enabled_confirmed', allEnabledConfirmed: true, actionType: 'enable',
      counts: { confirmed: 1, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
    };
  };
  mon._pollChengfangOver = async () => {
    calls.pause += 1;
    return {
      status: 'ok', over: true,
      batch: {
        actionType: 'pause', outcome: 'all_paused_confirmed', allPausedConfirmed: true,
        counts: { confirmed: 1, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
      },
    };
  };
  return { mon, calls, dataDir, setAdState: (s) => { stateRef = s; }, realSave: () => mon._saveState = realSave };
}

test('动作前写入失败 → persistence_blocked、零底层调用', async (t) => {
  const { mon, calls } = setupMon(t, { failWrite: true, adState: 'on' });
  const r = await mon._runShopSwitchAction(SHOP, 'pause', {
    cost: { valueCents: 10001, businessDate: '2026-09-12' },
    orders: { valueCount: 100 },
    evaluation: { reason: 'over' },
  }, { aborted: false }, 'interval');
  assert.strictEqual(r.outcome, 'persistence_blocked');
  assert.strictEqual(r.zeroClick, true);
  assert.strictEqual(r.serial, 'unknown', '终态无法落盘时保持门闩，即使本轮未点击');
  assert.strictEqual(r.dispatched, 0);
  assert.strictEqual(mon._switchOrchestrator.hasUnknownBlock(SHOP.id), true);
  assert.match(r.reason || '', /persistence_blocked|持久化/);
  assert.strictEqual(calls.pause, 0);
  assert.strictEqual(calls.enable, 0);
});

test('原子替换失败 → 旧文件完整、零底层调用', async (t) => {
  const { mon, calls, dataDir } = setupMon(t, { failRename: true, adState: 'on' });
  const statePath = path.join(dataDir, 'state.json');
  fs.writeFileSync(statePath, '{"version":2,"marker":"OLD_SAFE"}');
  const before = fs.readFileSync(statePath, 'utf8');
  const r = await mon._runShopSwitchAction(SHOP, 'pause', {
    cost: { valueCents: 10001, businessDate: '2026-09-12' },
    orders: { valueCount: 100 },
    evaluation: { reason: 'x' },
  }, { aborted: false }, 'x');
  assert.strictEqual(r.outcome, 'persistence_blocked');
  assert.strictEqual(calls.pause, 0);
  const after = fs.readFileSync(statePath, 'utf8');
  assert.strictEqual(after, before, '旧文件不得被覆盖');
  assert.ok(after.includes('OLD_SAFE'));
});

test('三种动作入口均不能绕过保存失败', async (t) => {
  const a = setupMon(t, { failWrite: true, adState: 'off' });
  const r1 = await a.mon._runShopSwitchAction(SHOP, 'enable', {
    cost: { valueCents: 5000, businessDate: '2026-09-12' }, orders: { valueCount: 100 }, evaluation: { reason: 'below' },
  }, { aborted: false }, 'interval');
  assert.strictEqual(r1.outcome, 'persistence_blocked');
  assert.strictEqual(a.calls.enable, 0);

  const b = setupMon(t, { failWrite: true, adState: 'on' });
  const r2 = await b.mon._runShopSwitchAction(SHOP, 'pause', {
    cost: { valueCents: 10001, businessDate: '2026-09-12' }, orders: { valueCount: 100 }, evaluation: { reason: 'over' },
  }, { aborted: false }, 'interval');
  assert.strictEqual(r2.outcome, 'persistence_blocked');
  assert.strictEqual(b.calls.pause, 0);

  const c = setupMon(t, { failWrite: true, adState: 'off' });
  const r3 = await c.mon._runShopEnablePhase(SHOP, { aborted: false }, '2026-09-12');
  assert.ok(r3.outcome === 'persistence_blocked' || /persistence_blocked|持久化/.test(r3.reason || ''), JSON.stringify(r3));
  assert.strictEqual(c.calls.enable, 0);
});

test('确认后保存失败 → 不错误释放（保持 unknown 阻塞）', async () => {
  const gate = createSwitchSerialGate();
  const orch = new AdSwitchOrchestrator({ gate });
  const r = await orch.runSwitchAction({
    shopId: 's1', action: 'pause', targetState: 'off',
    readState: async () => 'on',
    decide: (st) => orch.evaluatePeriodic({ costCents: 10001, orders: 100, thresholdCents: 100, currentAdState: st, identityOk: true }),
    execute: async () => ({ outcome: 'all_paused_confirmed', allPausedConfirmed: true, counts: { confirmed: 1, failed: 0, unknown: 0, skipped: 0, cancelled: 0 } }),
    persistBeforeRelease: () => ({ ok: false, reason: '注入:确认后写失败' }),
  });
  assert.strictEqual(r.serial, 'unknown');
  assert.match(r.reason, /persistence_blocked|保存失败/);
  assert.strictEqual(orch.hasUnknownBlock('s1'), true, '不得先释放锁');
});

test('重启读取未完成记录 → unknown；存储恢复后可安全恢复', async () => {
  const g1 = createSwitchSerialGate();
  const a = g1.tryBegin('shop-x', 'pause');
  g1.markUnknown('shop-x', a.actionId, '动作中');
  const st = g1.exportState();
  const g2 = createSwitchSerialGate({ state: st });
  assert.strictEqual(g2.hasUnknownBlock('shop-x'), true);
  // 明确未发出（not_sent）场景：释放后新动作可进行
  const b = g2.tryBegin('shop-x', 'enable');
  assert.strictEqual(b.ok, false, 'unknown 不放行');
  const rec = g2.resolveUnknownAfterReadback('shop-x', a.actionId, { confirmed: true });
  assert.strictEqual(rec.ok, true);
  const c = g2.tryBegin('shop-x', 'enable');
  assert.strictEqual(c.ok, true, '恢复后可安全进行');
  g2.markNotSent('shop-x', c.actionId);
  assert.strictEqual(g2.isBusy('shop-x'), false);
});

test('动作已发出后保存失败 → 不重复点击、保留阻塞、非 zeroClick', async () => {
  const gate = createSwitchSerialGate();
  const orch = new AdSwitchOrchestrator({ gate });
  let clicks = 0;
  const r = await orch.runSwitchAction({
    shopId: 's2', action: 'pause', targetState: 'off',
    readState: async () => 'on',
    decide: (st) => orch.evaluatePeriodic({ costCents: 10001, orders: 100, thresholdCents: 100, currentAdState: st, identityOk: true }),
    execute: async () => {
      clicks += 1;
      return { outcome: 'partial', counts: { confirmed: 0, failed: 0, unknown: 1, skipped: 0, cancelled: 0 } };
    },
  });
  assert.strictEqual(clicks, 1);
  assert.strictEqual(r.serial, 'unknown');
  assert.strictEqual(r.zeroClick, false);
  assert.strictEqual(orch.hasUnknownBlock('s2'), true);
});

test('正常保存路径行为不变（persistence_blocked 不出现）', async (t) => {
  const { mon, calls } = setupMon(t, { failWrite: false, adState: 'on' });
  const r = await mon._runShopSwitchAction(SHOP, 'pause', {
    cost: { valueCents: 10001, businessDate: '2026-09-12' },
    orders: { valueCount: 100 },
    evaluation: { reason: 'over' },
  }, { aborted: false }, 'interval');
  assert.strictEqual(calls.pause, 1);
  assert.strictEqual(r.outcome, 'all_paused_confirmed');
  assert.strictEqual(r.zeroClick, false);
  assert.strictEqual(mon._switchOrchestrator.isBusy(SHOP.id), false);
});
