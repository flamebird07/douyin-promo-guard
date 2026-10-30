'use strict';

/**
 * D53（2026-10-30）：停止每日开启任务绝不连带停止费比暂停巡查。
 *
 * 源码既有契约（monitor.stopEnableScheduler 注释/日志）："只中止 kind:'enable' 的令牌，
 * 暂停巡查不受影响"。enableSchedulerShouldRun() 亦为"配置允许 且 未被用户独立停用"。
 * 缺口：_pollShop 的首查安全门禁只看配置（_enableSchedulerConfigured），独立停用后
 * 当日无首查记录 → 每轮 audit trigger blocked=window，费比暂停永远走不到
 * 当前广告状态回读与正常暂停。
 *
 * 本文件全部为假依赖（假 Cookie 目录 / 假 reader+controller / 假乘方会话 / 假时钟），
 * 通过真实 pollOnce 主链断言行为，不访问生产、不访问真实页面。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor.js');
const { makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController } = require('./helpers.js');
const { shanghaiMs, shanghaiDate } = require('../src/lib/time.js');

const ACCOUNT_ID = '1710242295996424';
const SHOP = { id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', accountId: ACCOUNT_ID, enabled: true };
const DAY = '2026-10-30';

/**
 * 假乘方会话（本地对象，无浏览器）：实现 executeChengfangPause 所需的最小读/点契约。
 * landingConfirmed=false → 点击后回读仍在开启侧（用于未知动作串行门用例）。
 * 任何"开启"方向的派发都会被计数（主链若误发开启，断言立即失败）。
 */
function makeFakeChengfang(opts = {}) {
  const landingConfirmed = opts.landingConfirmed !== false;
  const plans = {
    '全店托管': (opts.tuoguan || [{ id: '184388555253250562', checked: true }]).map((p) => ({ ...p })),
    '商品自选': (opts.zixuan || []).map((p) => ({ ...p })),
  };
  const counters = { sessions: 0, closes: 0, pauseClicks: 0, enableClicks: 0, deleteClicks: 0, rowReads: 0 };
  const controller = {
    _beforeDispatch: null,
    setBeforeDispatch(fn) { this._beforeDispatch = fn; },
    async verifyIdentity() {
      if (opts.identityOk === false) return { ok: false, reason: 'fake: 账户身份不匹配' };
      return { ok: true, pageShopId: SHOP.id, pageShopName: SHOP.name, pageAccountId: ACCOUNT_ID };
    },
    async switchView() { return { clicked: true }; },
    async switchPageSize() { return { clicked: true }; },
    async ensureFirstPage() { return { clicked: false }; },
    async clickNextPage() { return { clicked: false, reason: 'fake: 单页' }; },
    async refreshView() { return { ok: true }; },
    async detectDanger() { return []; },
    async readView({ tab }) {
      const list = plans[tab] || [];
      counters.rowReads += 1;
      return {
        tab,
        rows: { rows: list.map((p) => ({ id: p.id, switchChecked: p.checked === true })), total: list.length },
        pagination: { total: list.length, pageSize: '100条/页', activePage: 1, hasNext: false },
      };
    },
    async selectAllInPage() { return { clicked: true }; },
    async readSelection({ tab }) {
      const list = plans[tab || '商品自选'] || [];
      const selectedIds = list.map((p) => String(p.id));
      return { selectedIds, selectedCount: selectedIds.length };
    },
    async readBatchBar() { return { visible: true, selectedCount: 1, buttons: ['开启', '暂停', '删除'] }; },
    async setRowCheckbox() { return { ok: true }; },
    async clickRowSwitch({ planId, expectAction }) {
      if (this._beforeDispatch) await this._beforeDispatch({ page: {} });
      if (expectAction === 'shop_enable') { counters.enableClicks += 1; throw new Error('fake: 暂停巡查不得发出开启'); }
      if (expectAction !== 'shop_disable') throw new Error(`fake: 非预期行内动作 ${expectAction}`);
      counters.pauseClicks += 1;
      const p = (plans['全店托管'] || []).find((x) => x.id === planId);
      if (p && landingConfirmed) p.checked = false;
      return { clicked: true };
    },
    async clickBatchPause() {
      if (this._beforeDispatch) await this._beforeDispatch({ page: {} });
      counters.pauseClicks += 1;
      if (landingConfirmed) for (const p of plans['商品自选']) p.checked = false;
      return { clicked: true };
    },
    async clickBatchEnable() { counters.enableClicks += 1; throw new Error('fake: 暂停巡查不得发出批量开启'); },
  };
  const page = { url: () => 'https://qianchuan.jinritemai.com/uni-prom/overall?aavid=' + ACCOUNT_ID };
  const opener = async () => {
    counters.sessions += 1;
    return { page, controller, close: async () => { counters.closes += 1; } };
  };
  return { opener, controller, plans, counters };
}

/** 可控时钟（门控延时，不真实等待 interval）。 */
function makeClock(startMs) {
  let now = startMs;
  const gates = [];
  return {
    nowFn: () => now,
    delayFn: (ms) => new Promise((res) => gates.push({ ms, res })),
    pending: () => gates.length,
    wake: (advanceMs) => { now += advanceMs; for (const g of gates.splice(0)) g.res(); },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitGated(clock, label, timeout = 5000) {
  const t0 = Date.now();
  while (!clock.pending()) {
    if (Date.now() - t0 > timeout) throw new Error(`waitFor 超时: ${label}`);
    await sleep(10);
  }
  await sleep(40);
}

/**
 * 组装真实 Monitor 主链（pollOnce）+ 全部假依赖。
 * @param {object} p
 * @param {number} p.atMs 假时钟时刻（上海墙上时间毫秒）
 * @param {number} [p.costCents] 当天消耗（分）
 * @param {number} [p.orders] 当天订单
 * @param {boolean} [p.enableSchedulerEnabled] 每日开启调度器配置
 * @param {(shopId:string)=>Promise<any>} [p.readState] 本轮回读当前广告状态
 * @param {object} [p.chengfang] 假乘方会话选项
 */
async function setup(p) {
  const cookieDir = makeTempDir('d53-ck-');
  const dataDir = makeTempDir('d53-data-');
  writeTempCookie(cookieDir, '测试店铺一');

  const cfgResult = makeCfgResult({
    cookieDir,
    shops: [SHOP],
    thresholdCents: 100,
    execution: Object.assign({
      realMode: true, dryRun: false, maxRetries: 1, retryBackoffMs: 1,
      closeTimeoutMs: 200, readbackTimeoutMs: 200, readbackAttempts: 2, readbackIntervalMs: 1,
      zeroOrderRecheck: 1, maxAdPages: 50,
    }, p.execution),
    schedule: { dailyStartHour: 8, intervalMinutes: 30, timezone: 'Asia/Shanghai' },
    monitor: {
      snapshotMaxAgeMinutes: 30, mockDataSource: false,
      chengfang: Object.assign({
        scope: ['全店托管', '商品自选'],
        pauseEnabled: true,
        enableEnabled: true,
        enableSchedulerEnabled: p.enableSchedulerEnabled === true,
      }, p.chengfangCfg),
    },
  });

  const controller = makeStatefulController({ identity: { id: SHOP.id, name: SHOP.name, accountId: ACCOUNT_ID }, ads: [] });
  const reader = makeLinkedReader(
    controller,
    { costCents: p.costCents, orders: p.orders, pageSource: 'promo-page', costAccountId: ACCOUNT_ID },
    p.clock.nowFn
  );

  const fake = makeFakeChengfang(p.chengfang);
  const stateCalls = [];
  const monitor = new Monitor(cfgResult, { reader, controller }, {
    dataDir,
    nowFn: p.clock.nowFn,
    delayFn: p.clock.delayFn,
    chengfangOpener: fake.opener,
    readAdState: async (shopId) => {
      stateCalls.push(shopId);
      return p.readState ? await p.readState(shopId) : { state: 'on' };
    },
  });

  const cleanup = () => {
    try { monitor.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' }); } catch (_) {}
    try { monitor.stop(); } catch (_) {}
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  const windowBlocks = () => monitor.triggers.filter((t) => t && t.blocked === 'window');
  const auditWindowBlocks = () => {
    const file = path.join(dataDir, 'audit.jsonl');
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
    return lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
      .filter((e) => e && (e.status === 'window_blocked' || e.blocked === 'window'));
  };
  return { monitor, fake, reader, controller, dataDir, cleanup, stateCalls, windowBlocks, auditWindowBlocks };
}

const at0800 = shanghaiMs(DAY, '08:00');
const at0759 = shanghaiMs(DAY, '07:59');

// ─────────────────────────────────────────────────────────────────────
test('D53-1 核心判别：独立停用每日开启 + 当日无首查 → 仍进入本轮回读与原费比暂停链（零开启、停用标记保留）', async () => {
  const clock = makeClock(at0800);
  const s = await setup({ clock, costCents: 10001, orders: 100, enableSchedulerEnabled: true });
  try {
    s.monitor.stopEnableScheduler({ byUser: true, reason: 'd53-test' });
    assert.equal(s.monitor._enableSchedule.stoppedByUser, true, '前置：停用标记应已写入');
    assert.equal(s.monitor.getEnablePhaseRecord(SHOP.id, DAY), undefined, '前置：当日无首查记录');

    const r = await s.monitor.pollOnce('d53');
    const one = r.results[0];

    assert.notEqual(one.status, 'window_blocked', `独立停用后费比暂停不得被首查门禁拦成 window_blocked，实际 ${one.status} / ${one.reason}`);
    assert.ok(s.stateCalls.length >= 1, '本轮必须真实回读当前广告状态（fresh state）');
    assert.ok(s.fake.counters.sessions >= 1, '必须进入原有乘方暂停主链（打开会话）');
    assert.ok(s.fake.counters.pauseClicks >= 1, '超标 + 回读开启侧 → 应发出暂停请求');
    assert.equal(s.fake.counters.enableClicks, 0, '不得发出任何开启请求');
    assert.equal(s.windowBlocks().length, 0, '不得再有 trigger blocked=window');
    assert.equal(s.auditWindowBlocks().length, 0, '审计不得留下 window_blocked 门禁记录');
    assert.equal(s.monitor._enableSchedule.stoppedByUser, true, '每日开启必须保持停用（不得被暂停轮恢复）');
    assert.equal(s.monitor.getEnablePhaseRecord(SHOP.id, DAY), undefined, '不得伪造/写入当日首查成功记录');
    assert.equal(s.monitor.enableRunning, false, '每日开启调度器保持未运行');
  } finally { s.cleanup(); }
});

test('D53-2 时间门保留：独立停用后 07:59 仍按原 dailyStartHour 门禁零动作', async () => {
  const clock = makeClock(at0759);
  const s = await setup({ clock, costCents: 10001, orders: 100, enableSchedulerEnabled: true });
  try {
    s.monitor.stopEnableScheduler({ byUser: true, reason: 'd53-test' });
    const r = await s.monitor.pollOnce('d53');
    const one = r.results[0];
    assert.equal(one.status, 'window_blocked', '07:59 仍须是原时间门禁');
    assert.match(String(one.reason || ''), /未到允许执行时段/, '应为原 dailyStartHour 时间门禁原因');
    assert.equal(s.fake.counters.sessions, 0, '零页面会话');
    assert.equal(s.fake.counters.pauseClicks, 0, '零暂停请求');
    assert.equal(s.fake.counters.enableClicks, 0, '零开启请求');
    assert.equal(s.monitor._enableSchedule.stoppedByUser, true, '停用标记保持');
  } finally { s.cleanup(); }
});

test('D53-3 50 元保护保留：独立停用后消耗≤50 元仍零点击', async () => {
  const clock = makeClock(at0800);
  const s = await setup({ clock, costCents: 4000, orders: 10, enableSchedulerEnabled: true });
  try {
    s.monitor.stopEnableScheduler({ byUser: true, reason: 'd53-test' });
    const r = await s.monitor.pollOnce('d53');
    const one = r.results[0];
    assert.equal(one.zeroClick, true, '50 元保护必须仍是合法零动作');
    assert.equal(s.fake.counters.sessions, 0, '50 元保护内不得打开乘方会话');
    assert.equal(s.fake.counters.pauseClicks, 0, '50 元保护内不得发出暂停');
    assert.equal(s.fake.counters.enableClicks, 0, '零开启');
  } finally { s.cleanup(); }
});

test('D53-4 当前状态 unknown 仍 fail-closed：独立停用后不得据费用直接暂停', async () => {
  const clock = makeClock(at0800);
  const s = await setup({
    clock, costCents: 10001, orders: 100, enableSchedulerEnabled: true,
    readState: async () => ({ state: 'unknown', switchEvidence: { kind: 'unrecognized_switches', rowsTotal: 2, unrecognizedRows: 1, sampleRowIndexes: [0] } }),
  });
  try {
    s.monitor.stopEnableScheduler({ byUser: true, reason: 'd53-test' });
    const r = await s.monitor.pollOnce('d53');
    const one = r.results[0];
    assert.equal(s.stateCalls.length >= 1, true, 'unknown 也必须来自本轮回读');
    assert.equal(s.fake.counters.sessions, 0, `回读 unknown 必须零会话，实际 ${JSON.stringify(one)}`);
    assert.equal(s.fake.counters.pauseClicks, 0, 'unknown 零暂停');
    assert.equal(s.fake.counters.enableClicks, 0, 'unknown 零开启');
    assert.equal(one.zeroClick, true, 'unknown 必须仍是零动作（既有语义：不因读到费用而动作）');
    assert.equal(one.currentAdState, 'unknown', '本轮状态如实回读为 unknown（不伪造成 on/off）');
  } finally { s.cleanup(); }
});

test('D53-5 身份/回读失败仍零动作：独立停用不放宽读取失败门禁', async () => {
  const clock = makeClock(at0800);
  const s = await setup({
    clock, costCents: 10001, orders: 100, enableSchedulerEnabled: true,
    readState: async () => { throw new Error('fake: 账户身份核验失败'); },
  });
  try {
    s.monitor.stopEnableScheduler({ byUser: true, reason: 'd53-test' });
    const r = await s.monitor.pollOnce('d53');
    const one = r.results[0];
    assert.equal(one.status, 'blocked', `身份失败必须 blocked，实际 ${JSON.stringify(one)}`);
    assert.equal(one.zeroClick, true, '身份失败零点击');
    assert.equal(s.fake.counters.sessions, 0, '身份失败不得打开会话');
    assert.equal(s.fake.counters.enableClicks, 0, '零开启');
  } finally { s.cleanup(); }
});

test('D53-6 首查门禁保留：enable 可运行且当日首查缺失 → 仍原首查门禁、零动作', async () => {
  const clock = makeClock(at0800);
  const s = await setup({ clock, costCents: 10001, orders: 100, enableSchedulerEnabled: true });
  try {
    assert.equal(s.monitor.enableSchedulerShouldRun(), true, '前置：配置开启且未停用');
    assert.equal(s.monitor.getEnablePhaseRecord(SHOP.id, DAY), undefined, '前置：当日无首查记录');
    const r = await s.monitor.pollOnce('d53');
    const one = r.results[0];
    assert.equal(one.status, 'window_blocked', `首查未完成必须仍是首查门禁，实际 ${JSON.stringify(one)}`);
    assert.match(String(one.reason || ''), /首次开启检查未完成/, '应为原首查安全门禁原因');
    assert.equal(s.stateCalls.length, 0, '门禁在读取当前广告状态之前');
    assert.equal(s.fake.counters.sessions, 0, '门禁零会话');
    assert.equal(s.fake.counters.pauseClicks, 0, '门禁零暂停');
    assert.equal(s.fake.counters.enableClicks, 0, '门禁零开启');
  } finally { s.cleanup(); }
});

test('D53-7 enable 可运行且首查已完成（already_on 记 success）→ 原行为：费比暂停正常放行', async () => {
  const clock = makeClock(at0800);
  const s = await setup({ clock, costCents: 10001, orders: 100, enableSchedulerEnabled: true });
  try {
    s.monitor.startEnableScheduler({ reason: 'd53-test' });
    await waitGated(clock, 'enable-phase');
    assert.equal(s.monitor.getEnablePhaseRecord(SHOP.id, DAY).status, 'success', '本轮回读已开启 → 首查记 success（零点击）');
    assert.equal(s.fake.counters.enableClicks, 0, 'already_on 不得发出开启点击');
    const before = s.fake.counters.sessions;
    const r = await s.monitor.pollOnce('d53');
    const one = r.results[0];
    assert.notEqual(one.status, 'window_blocked', `首查已完成的原有放行不得被改动，实际 ${JSON.stringify(one)}`);
    assert.ok(s.fake.counters.sessions > before, '首查完成后应进入原暂停链');
    assert.ok(s.fake.counters.pauseClicks >= 1, '应发出暂停请求');
    assert.equal(s.fake.counters.enableClicks, 0, '零开启点击');
  } finally { s.cleanup(); }
});

test('D53-8 未知动作串行门保持：上一轮暂停未确认 → 本轮不因读到费用清门或重发', async () => {
  const clock = makeClock(at0800);
  const s = await setup({
    clock, costCents: 10001, orders: 100, enableSchedulerEnabled: true,
    chengfang: { landingConfirmed: false },
  });
  try {
    s.monitor.stopEnableScheduler({ byUser: true, reason: 'd53-test' });
    const r1 = await s.monitor.pollOnce('d53-round1');
    assert.notEqual(r1.results[0].status, 'window_blocked', `第 1 轮必须真实执行暂停（不被首查门禁拦下），实际 ${JSON.stringify(r1.results[0])}`);
    const clicksAfter1 = s.fake.counters.pauseClicks;
    assert.ok(clicksAfter1 >= 1, '第 1 轮应已发出暂停请求（回读未确认）');
    const unknownAfter1 = s.monitor._switchOrchestrator.hasUnknownBlock(SHOP.id);
    assert.equal(unknownAfter1, true, '前置：第 1 轮暂停回读未确认，必须留下未收口的未知动作门（否则本用例无效）');

    const r2 = await s.monitor.pollOnce('d53-round2');
    const one2 = r2.results[0];
    assert.equal(s.monitor._switchOrchestrator.hasUnknownBlock(SHOP.id), true,
      `未知动作门不得因读到费用被直接清除（本轮 ${JSON.stringify(one2)}）`);
    assert.equal(s.fake.counters.pauseClicks, clicksAfter1, '存在未收口未知动作时不得重发暂停');
    assert.equal(s.fake.counters.enableClicks, 0, '未知动作期间不得反向开启');
  } finally { s.cleanup(); }
});

test('D53-9 停用标记不被巡查改写：多轮暂停后仍为停用、零开启调用', async () => {
  const clock = makeClock(at0800);
  const s = await setup({ clock, costCents: 10001, orders: 100, enableSchedulerEnabled: true });
  try {
    s.monitor.stopEnableScheduler({ byUser: true, reason: 'd53-test' });
    await s.monitor.pollOnce('d53-a');
    clock.wake(0);
    await s.monitor.pollOnce('d53-b');
    assert.equal(s.monitor._enableSchedule.stoppedByUser, true, '停用标记保持（不抹除）');
    assert.equal(s.monitor.enableRunning, false, '保持停用：不启动每日开启');
    assert.equal(s.fake.counters.enableClicks, 0, '两轮仍零开启调用');
    assert.equal(s.monitor.getEnablePhaseRecord(SHOP.id, DAY), undefined, '不伪造首查成功');
    assert.equal(shanghaiDate(clock.nowFn()), DAY);
  } finally { s.cleanup(); }
});
