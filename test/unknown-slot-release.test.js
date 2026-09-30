'use strict';

/**
 * 隔离测试（第 6 阶段补丁）：unknown 串行门槽位的核验释放。
 * 释放证据全部必要条件（缺一保持阻断、零点击）：
 *   该店存在 unknown 槽位（精确 actionId）+ 本轮新鲜回读（无 error/超时）+ rows 全量背书
 *   + identity.ok===true + 回读状态严格等于旧动作目标态（pause→全量 off / enable→全量 on）
 *   + 经 resolveUnknownWithReadback 同步持久化门禁释放。
 * 不采信：adBelief、费用观测、无 rows 摘要、单页结果、旧时间戳。
 * 判别性：R1/R2 在补丁前（v3 正式仓版 monitor.js）失败（方法缺失/槽位仍阻塞），补丁后通过。
 * 不访问真实页面：乘方会话经 opts.chengfangOpener 注入假对象（零点击计数）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor.js');
const { makeTempDir, makeCfgResult } = require('./helpers.js');

const TAB_MAIN = '全店托管';
const TAB_SUB = '商品自选';
const SLOT_ACTION_ID = 'act_1790657904936_4'; // 与生产潮流服饰槽位同形（pause unknown）

/** 假乘方会话：views[tab]=分页列表；hangOn='readView' 第 1 次读取挂起（验证 v3 截止仍在）。 */
function makeFake({ shopId = 'shop-a', views, hangOn = null } = {}) {
  const calls = { opener: 0, identity: 0, readView: 0, click: 0 };
  const browsers = [];
  const opener = async () => {
    calls.opener += 1;
    const browser = { closed: false, hanging: [] };
    browsers.push(browser);
    const page = { browser: () => browser, evaluate: async () => null };
    const perTabPage = {};
    const controller = {
      async verifyIdentity() {
        calls.identity += 1;
        if (browser.closed) throw new Error('Target closed');
        return { ok: true, pageShopId: shopId, pageShopName: shopId };
      },
      async refreshView() { if (browser.closed) throw new Error('Target closed'); return { refreshed: true }; },
      async switchView() { if (browser.closed) throw new Error('Target closed'); },
      async readView({ tab }) {
        calls.readView += 1;
        if (browser.closed) throw new Error('Target closed');
        if (hangOn === 'readView' && calls.readView === 1) return new Promise((_, reject) => browser.hanging.push({ reject }));
        const list = views[tab] || [{ rows: [] }];
        const p = list[Math.min(perTabPage[tab] || 0, list.length - 1)];
        perTabPage[tab] = (perTabPage[tab] || 0) + 1;
        const total = views[tab].reduce((n, pg) => n + pg.rows.length, 0);
        return { rows: { rows: p.rows.map((x) => ({ ...x })) }, pagination: { total, hasNext: p.hasNext === true, activePage: '1' } };
      },
      async clickNextPage() { calls.click += 1; return { clicked: true }; },
      async clickBatchPause() { calls.click += 1; return {}; },
      async clickBatchEnable() { calls.click += 1; return {}; },
      async clickRowSwitch() { calls.click += 1; return {}; },
    };
    browser.close = async () => {
      browser.closed = true;
      for (const x of browser.hanging.splice(0)) x.reject(new Error('Target closed'));
    };
    return { browser, page, controller, account: null, context: null, cookieSession: null };
  };
  return { opener, calls, browsers };
}

/** dataDir 预置 unknown 槽位 state.json（boot 恢复为 unknown:true，与生产重启后形态一致）。 */
function seedSlot(dataDir, shopId, action, actionId) {
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
    version: 1,
    batches: {},
    enablePhase: {},
    adBelief: {},
    enableScheduler: {},
    switchSlots: { slots: [{ shopId, action, actionId, startedAt: Date.now(), confirmed: false, settled: false, unknown: false, blockedReason: null }] },
    savedAt: new Date().toISOString(),
  }));
}

function buildMonitor({ dataDir, openerFn, readAdState = null }) {
  const cfgResult = makeCfgResult({
    shops: [
      { id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true },
      { id: 'shop-b', name: 'shop-b', cookieFile: 'shop-b', accountId: null, enabled: true },
    ],
    monitor: { legacyWholeShopCloseEnabled: true, chengfang: { scope: [TAB_MAIN, TAB_SUB], adStateReadTimeoutMs: 300, adStateCloseWaitMs: 200, adStateSettleWaitMs: 300 } },
  });
  const opts = { dataDir, chengfangOpener: openerFn };
  if (readAdState) opts.readAdState = readAdState;
  return new Monitor(cfgResult, null, opts);
}

function auditList(dataDir) {
  const p = path.join(dataDir, 'audit.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

const OFF_VIEWS = { [TAB_MAIN]: [{ rows: [{ id: 'p1', switchChecked: false }, { id: 'p2', switchChecked: false }] }], [TAB_SUB]: [{ rows: [] }] };
const ON_VIEWS = { [TAB_MAIN]: [{ rows: [{ id: 'p1', switchChecked: true }] }], [TAB_SUB]: [{ rows: [] }] };
const MIXED_VIEWS = { [TAB_MAIN]: [{ rows: [{ id: 'p1', switchChecked: false }, { id: 'p2', switchChecked: true }] }], [TAB_SUB]: [{ rows: [] }] };

test('R1 正例：pause unknown 槽位 + 全量 off 新鲜回读 → 释放且零点击（判别：补丁前失败）', async () => {
  const dataDir = makeTempDir('stage6-');
  seedSlot(dataDir, 'shop-a', 'pause', SLOT_ACTION_ID);
  const fake = makeFake({ shopId: 'shop-a', views: OFF_VIEWS });
  const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
  const orch = monitor._switchOrchestrator;
  assert.equal(orch.hasUnknownBlock('shop-a'), true, '预置槽位应为 unknown 阻塞');
  const r = await monitor._tryResolveUnknownSlotWithFreshRead({ id: 'shop-a', name: 'shop-a' });
  assert.ok(r && r.resolved === true, `应释放，实际 ${JSON.stringify(r)}`);
  assert.equal(orch.hasUnknownBlock('shop-a'), false, '释放后不再有 unknown 阻塞');
  assert.equal(orch.isBusy('shop-a'), false, '释放后串行门可用');
  assert.equal(fake.calls.click, 0, '核验释放全程零点击');
  const evs = auditList(dataDir).filter((j) => j.step === 'resolve-unknown-attempt' || j.step === 'resolve-unknown');
  assert.ok(evs.some((j) => j.step === 'resolve-unknown-attempt' && j.ok === true), JSON.stringify(evs.map((x) => x.step)));
  assert.ok(/不声明历史点击因果/.test(evs.find((j) => j.step === 'resolve-unknown-attempt').reason), 'note 须明示不声明历史因果');
  // 释放后持久化：state.json 无未决槽位（persist 先于删槽，快照含 settled:true 条目属预期，boot 恢复会跳过）
  const st = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
  const unsettled = (st.switchSlots.slots || []).filter((x) => x.settled !== true);
  assert.equal(unsettled.length, 0, `不得残留未决槽位，实际 ${JSON.stringify(st.switchSlots.slots)}`);
  monitor.stop();
});

test('R2 行为级判别：每日开启相位预检——pause 槽位+全量 off → 释放后正常进入开启流程（不再 serial_gate 阻断）', async () => {
  const dataDir = makeTempDir('stage6-');
  seedSlot(dataDir, 'shop-a', 'pause', SLOT_ACTION_ID);
  const fake = makeFake({ shopId: 'shop-a', views: OFF_VIEWS });
  const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
  monitor.enableRunning = true;
  monitor._enableGen = 1;
  await monitor._runEnablePhase(1, '2026-09-30');
  const audits = auditList(dataDir);
  const decide = audits.find((j) => j.event === 'daily-decide' && j.shopId === 'shop-a');
  assert.ok(decide, '应有 decide 审计');
  assert.equal(decide.currentAdState, 'off');
  assert.equal(decide.decision, 'should_enable', `补丁前该场景为 unknown_blocked/serial_gate；实际 ${decide.decision}`);
  const gateRejects = audits.filter((j) => j.step === 'serial-gate' && j.ok === false);
  assert.equal(gateRejects.length, 0, `串行门不得再拒绝（补丁前必拒），实际 ${JSON.stringify(gateRejects.map((x) => x.reason))}`);
  assert.equal(fake.calls.click, 0, 'realMode=false 全程零真实点击（演练）');
  monitor.stop();
});

test('N1 负例：回读 error（身份失败）→ 不释放', async () => {
  const dataDir = makeTempDir('stage6-');
  seedSlot(dataDir, 'shop-a', 'pause', SLOT_ACTION_ID);
  const fake = makeFake({ shopId: 'shop-a', views: OFF_VIEWS });
  const monitor = buildMonitor({
    dataDir,
    openerFn: async () => {
      const s = await fake.opener();
      s.controller.verifyIdentity = async () => ({ ok: false, reason: '模拟身份失败' });
      return s;
    },
  });
  const r = await monitor._tryResolveUnknownSlotWithFreshRead({ id: 'shop-a', name: 'shop-a' });
  assert.ok(r && r.resolved === false, JSON.stringify(r));
  assert.equal(monitor._switchOrchestrator.hasUnknownBlock('shop-a'), true, '槽位保持 unknown');
  assert.equal(fake.calls.click, 0);
  monitor.stop();
});

test('N2 负例：回读超时（v3 截止）→ 不释放（证明 v3 有界仍生效）', async () => {
  const dataDir = makeTempDir('stage6-');
  seedSlot(dataDir, 'shop-a', 'pause', SLOT_ACTION_ID);
  const fake = makeFake({ shopId: 'shop-a', views: OFF_VIEWS, hangOn: 'readView' });
  const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
  const r = await monitor._tryResolveUnknownSlotWithFreshRead({ id: 'shop-a', name: 'shop-a' });
  assert.ok(r && r.resolved === false && /回读失败\/超时/.test(r.reason), JSON.stringify(r));
  assert.equal(monitor._switchOrchestrator.hasUnknownBlock('shop-a'), true);
  assert.equal(fake.browsers[0].closed, true, '超时会话已被 v3 收口');
  assert.equal(fake.calls.click, 0);
  monitor.stop();
});

test('N3 负例：mixed 回读 → 不释放', async () => {
  const dataDir = makeTempDir('stage6-');
  seedSlot(dataDir, 'shop-a', 'pause', SLOT_ACTION_ID);
  const fake = makeFake({ shopId: 'shop-a', views: MIXED_VIEWS });
  const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
  const r = await monitor._tryResolveUnknownSlotWithFreshRead({ id: 'shop-a', name: 'shop-a' });
  assert.ok(r && r.resolved === false && /目标态未确认/.test(r.reason), JSON.stringify(r));
  assert.equal(monitor._switchOrchestrator.hasUnknownBlock('shop-a'), true);
  monitor.stop();
});

test('N4 负例：开关不可识别（unknown 行）回读 → 不释放', async () => {
  const dataDir = makeTempDir('stage6-');
  seedSlot(dataDir, 'shop-a', 'pause', SLOT_ACTION_ID);
  const views = { [TAB_MAIN]: [{ rows: [{ id: 'p1', switchChecked: false }, { id: 'p2', switchChecked: null }] }], [TAB_SUB]: [{ rows: [] }] };
  const fake = makeFake({ shopId: 'shop-a', views });
  const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
  const r = await monitor._tryResolveUnknownSlotWithFreshRead({ id: 'shop-a', name: 'shop-a' });
  assert.ok(r && r.resolved === false, JSON.stringify(r));
  assert.equal(monitor._switchOrchestrator.hasUnknownBlock('shop-a'), true);
  monitor.stop();
});

test('N5 负例：无 rows 的摘要结果（注入路径）→ 不释放', async () => {
  const dataDir = makeTempDir('stage6-');
  seedSlot(dataDir, 'shop-a', 'pause', SLOT_ACTION_ID);
  const monitor = buildMonitor({
    dataDir,
    openerFn: async () => { throw new Error('不应开浏览器'); },
    readAdState: async () => ({ state: 'off' }), // 无 rows/identity 的注入摘要
  });
  const r = await monitor._tryResolveUnknownSlotWithFreshRead({ id: 'shop-a', name: 'shop-a' });
  assert.ok(r && r.resolved === false && /rows 缺失/.test(r.reason), JSON.stringify(r));
  assert.equal(monitor._switchOrchestrator.hasUnknownBlock('shop-a'), true);
  monitor.stop();
});

test('N6 负例：状态不匹配（pause 槽位 + on 回读）→ 不释放', async () => {
  const dataDir = makeTempDir('stage6-');
  seedSlot(dataDir, 'shop-a', 'pause', SLOT_ACTION_ID);
  const fake = makeFake({ shopId: 'shop-a', views: ON_VIEWS });
  const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
  const r = await monitor._tryResolveUnknownSlotWithFreshRead({ id: 'shop-a', name: 'shop-a' });
  assert.ok(r && r.resolved === false && /目标态未确认/.test(r.reason), JSON.stringify(r));
  assert.equal(monitor._switchOrchestrator.hasUnknownBlock('shop-a'), true);
  monitor.stop();
});

test('N7 负例：持久化失败 → 不释放且槽位保持 unknown（门禁回滚）', async () => {
  const dataDir = makeTempDir('stage6-');
  seedSlot(dataDir, 'shop-a', 'pause', SLOT_ACTION_ID);
  const fake = makeFake({ shopId: 'shop-a', views: OFF_VIEWS });
  const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
  const origSave = monitor._saveState.bind(monitor);
  let saveCalls = 0;
  monitor._saveState = () => { saveCalls += 1; return { ok: false, reason: '模拟持久化失败' }; };
  const r = await monitor._tryResolveUnknownSlotWithFreshRead({ id: 'shop-a', name: 'shop-a' });
  assert.ok(r && r.resolved === false && /持久化|persistence/.test(String(r.reason)), JSON.stringify(r));
  assert.equal(saveCalls >= 1, true, '应尝试持久化');
  const slot = monitor._switchOrchestrator.peek('shop-a');
  assert.ok(slot && slot.unknown === true && slot.settled !== true, `槽位应回滚 unknown，实际 ${JSON.stringify(slot)}`);
  assert.equal(monitor._switchOrchestrator.hasUnknownBlock('shop-a'), true);
  monitor._saveState = origSave;
  monitor.stop();
});

test('N8 隔离性：对无槽位的店调用返回 null，不动他店槽位；旧 actionId 不受影响', async () => {
  const dataDir = makeTempDir('stage6-');
  seedSlot(dataDir, 'shop-a', 'pause', SLOT_ACTION_ID);
  const fake = makeFake({ shopId: 'shop-b', views: OFF_VIEWS });
  const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
  const rb = await monitor._tryResolveUnknownSlotWithFreshRead({ id: 'shop-b', name: 'shop-b' });
  assert.equal(rb, null, '无 unknown 槽位的店不做任何事');
  assert.equal(monitor._switchOrchestrator.hasUnknownBlock('shop-a'), true, 'shop-a 槽位不受 shop-b 调用影响');
  monitor.stop();
});

test('N9 正例补充：enable unknown 槽位 + 全量 on 回读 → 释放', async () => {
  const dataDir = makeTempDir('stage6-');
  seedSlot(dataDir, 'shop-a', 'enable', 'act_enable_1');
  const fake = makeFake({ shopId: 'shop-a', views: ON_VIEWS });
  const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
  const r = await monitor._tryResolveUnknownSlotWithFreshRead({ id: 'shop-a', name: 'shop-a' });
  assert.ok(r && r.resolved === true, JSON.stringify(r));
  assert.equal(monitor._switchOrchestrator.hasUnknownBlock('shop-a'), false);
  assert.equal(fake.calls.click, 0);
  monitor.stop();
});
