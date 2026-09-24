'use strict';

/**
 * 默认调用链隔离测试：**不**注入 opts.readAdState，**不**替换编排器 execute。
 * 允许注入本地 fixture 会话开启器；Monitor/runner/reader/executor/gate 默认协同。
 * 不启服务、不登录、不访问真实广告/飞书。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const { chromium } = require('playwright');
const { Monitor } = require('../src/engine/monitor');
const { makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock, waitFor } = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');
const { buildChengfangFixtureHtml } = require('./chengfang-fixture');
const { createChengfangController } = require('../src/adapters/chengfang-reader');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ACCOUNT_ID = '1710242295996424';
const SHOP = { id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', accountId: ACCOUNT_ID, enabled: true };
const TUOGUAN = { id: '184388555253250562', name: '全店托管', checked: true };
const ZIX = (n, checked = true) =>
  Array.from({ length: n }, (_, i) => ({ id: `1875859981405339${String(i).padStart(3, '0')}`, name: `计划${i}`, checked }));

let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1280,900'] });
});
after(async () => { await browser.close().catch(() => {}); });

async function setupDefault(t, { costCents = 5000, orders = 100, fixture, clock, realMode = true, monitorChengfang = {} } = {}) {
  const cookieDir = makeTempDir('dc-ck-');
  const dataDir = makeTempDir('dc-data-');
  t.after(() => {
    try { mon.stopEnableScheduler({ byUser: false, reason: 'cleanup' }); } catch (_) {}
    try { mon.stop(); } catch (_) {}
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  writeTempCookie(cookieDir, '测试店铺一');
  const cfgResult = makeCfgResult({
    cookieDir,
    shops: [SHOP],
    execution: { realMode, dryRun: !realMode, readbackTimeoutMs: 3000, readbackIntervalMs: 200 },
    monitor: {
      chengfang: Object.assign({ scope: ['全店托管', '商品自选'], pauseEnabled: true, enableEnabled: true }, monitorChengfang),
    },
  });
  const controller = makeStatefulController({ identity: { id: SHOP.id, name: SHOP.name, accountId: ACCOUNT_ID }, ads: [] });
  const reader = makeLinkedReader(controller, {
    costCents, orders, pageSource: 'promo-page', costAccountId: ACCOUNT_ID,
  }, clock ? clock.nowFn : undefined);
  const track = { sessions: 0, clickLog: null };
  // 仅注入 fixture 会话开启器；**不**注入 readAdState / 编排器 execute
  const mon = new Monitor(cfgResult, { reader, controller }, {
    dataDir,
    nowFn: clock ? clock.nowFn : undefined,
    delayFn: clock ? clock.delayFn : undefined,
    chengfangOpener: async () => {
      track.sessions += 1;
      const page = await browser.newPage();
      const html = buildChengfangFixtureHtml(fixture || { plans: { '全店托管': [], '商品自选': [] } });
      await page.route('**/uni-prom/overall**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
      await page.goto(`https://qianchuan.jinritemai.com/uni-prom/overall?aavid=${ACCOUNT_ID}`, { waitUntil: 'load' });
      const ctrl = createChengfangController({ loadWaitMs: 40, tabWaitMs: 10 });
      return {
        page,
        controller: ctrl,
        close: async () => {
          track.clickLog = await page.evaluate(() => window.__CF.clickLog).catch(() => null);
          await page.close().catch(() => {});
        },
      };
    },
  });
  return { mon, track, controller, reader };
}

const enableClicks = (log) => (log || []).filter((c) => c.type === 'enable');
const pauseClicks = (log) => (log || []).filter((c) => c.type === 'pause');
const switchClicks = (log) => (log || []).filter((c) => c.type === 'switch');

test('默认读取：全开→on；全关→off；混合→mixed（不注入 readAdState）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:30'));
  const a = await setupDefault(t, {
    clock, costCents: 10000, // equal → 零动作，仅验证读取
    fixture: { plans: { '全店托管': [{ ...TUOGUAN, checked: true }], '商品自选': ZIX(2, true) } },
  });
  // 通过默认 _readCurrentAdState（会经 fixture 会话）
  const r1 = await a.mon._readCurrentAdState(SHOP);
  assert.strictEqual(r1.state, 'on');
  assert.ok(a.track.sessions >= 1, '默认读取须开会话');

  const b = await setupDefault(t, {
    clock, costCents: 10000,
    fixture: { plans: { '全店托管': [{ ...TUOGUAN, checked: false }], '商品自选': ZIX(2, false) } },
  });
  assert.strictEqual((await b.mon._readCurrentAdState(SHOP)).state, 'off');

  const c = await setupDefault(t, {
    clock, costCents: 10000,
    fixture: { plans: { '全店托管': [{ ...TUOGUAN, checked: true }], '商品自选': ZIX(1, false) } },
  });
  assert.strictEqual((await c.mon._readCurrentAdState(SHOP)).state, 'mixed');
});

test('默认读取：身份失败 / 读取失败 → error(blocked)，零动作', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:30'));
  const bad = '首页 乘方 全域投放 品牌投放 伊人美 ID：1999888877776666';
  const a = await setupDefault(t, {
    clock, costCents: 5000,
    fixture: { plans: { '全店托管': ZIX(1), '商品自选': ZIX(1) }, navText: bad },
  });
  const r = await a.mon._readCurrentAdState(SHOP);
  assert.strictEqual(r.state, 'unknown');
  assert.strictEqual(r.error.status, 'blocked');
  const p = await a.mon.pollOnce('interval');
  assert.strictEqual(p.results[0].status, 'blocked');
  assert.match(p.results[0].reason || '', /身份/);
  assert.strictEqual(p.results[0].zeroClick, true, '身份失败须 zeroClick');
  assert.strictEqual(p.results[0].decision, 'unknown_blocked');
  // 底层开关调用为 0
  assert.strictEqual(enableClicks(a.track.clickLog).length, 0);
  assert.strictEqual(pauseClicks(a.track.clickLog).length, 0);
  assert.strictEqual(switchClicks(a.track.clickLog).length, 0);
});

test('08:00 后低于阈值且已暂停 → 默认链路开启一次并回读', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:30'));
  const { mon, track } = await setupDefault(t, {
    clock, costCents: 5000,
    fixture: { plans: { '全店托管': [{ ...TUOGUAN, checked: false }], '商品自选': ZIX(2, false) } },
  });
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].decision, 'should_enable');
  assert.strictEqual(r.results[0].zeroClick, false);
  assert.strictEqual(enableClicks(track.clickLog).length >= 1, true, '默认链路应开启');
  assert.strictEqual(pauseClicks(track.clickLog).length, 0);
  assert.strictEqual(mon.actions.length >= 0, true);
});

test('已开启（on）低于阈值 → 零点击', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:30'));
  const { mon, track } = await setupDefault(t, {
    clock, costCents: 5000,
    fixture: { plans: { '全店托管': [{ ...TUOGUAN, checked: true }], '商品自选': ZIX(2, true) } },
  });
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].decision, 'already_on');
  assert.strictEqual(r.results[0].zeroClick, true);
  assert.strictEqual(enableClicks(track.clickLog).length, 0);
  assert.strictEqual(switchClicks(track.clickLog).length, 0);
});

test('mixed 只开启暂停项（不点已开）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:30'));
  const { mon, track } = await setupDefault(t, {
    clock, costCents: 5000,
    fixture: {
      plans: {
        '全店托管': [{ ...TUOGUAN, checked: false }],
        '商品自选': [{ id: '1875859981405339001', name: '已开', checked: true }, { id: '1875859981405339002', name: '未开', checked: false }],
      },
    },
  });
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].decision, 'should_enable');
  assert.strictEqual(enableClicks(track.clickLog).length >= 1, true);
  // 底层只应处理关闭侧；已开启项不得被再点
  assert.strictEqual(pauseClicks(track.clickLog).length, 0);
});

test('07:00 定时开启仍受原窗口（窗外 blocked_window）', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:30'));
  const { mon } = await setupDefault(t, {
    clock, costCents: 5000,
    fixture: { plans: { '全店托管': [{ ...TUOGUAN, checked: false }], '商品自选': ZIX(1, false) } },
    monitorChengfang: { enableEnabled: true },
  });
  const r = await mon._runShopEnablePhase(SHOP, { aborted: false }, '2026-09-12');
  assert.ok(r.status === 'window_blocked' || (r.reason && /时段|窗口/.test(r.reason)), JSON.stringify(r));
});

test('threshold_recovery 在值守窗口外（07:30）被拒', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '07:30'));
  const { mon, track } = await setupDefault(t, {
    clock, costCents: 5000,
    fixture: { plans: { '全店托管': [{ ...TUOGUAN, checked: false }], '商品自选': ZIX(1, false) } },
  });
  const r = await mon._executeEnableBatchFor(SHOP, { aborted: false }, {
    reason: 'below', triggerLabel: 'below_threshold_enable', enableSource: 'threshold_recovery',
  });
  assert.strictEqual(r.outcome, 'blocked_window');
  assert.strictEqual(enableClicks(track.clickLog).length, 0);
});

test('今日定时开启成功后，周期 threshold_recovery 仍可执行', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:30'));
  const fixture = {
    plans: {
      '全店托管': [{ ...TUOGUAN, checked: false }],
      '商品自选': [{ id: '1875859981405339001', name: 'a', checked: false }, { id: '1875859981405339002', name: 'b', checked: false }],
    },
  };
  const { mon, track } = await setupDefault(t, { clock, costCents: 5000, fixture });
  // 模拟今日 07:00 定时已成功（相位去重只影响 daily_schedule）
  mon._setEnablePhase(SHOP.id, '2026-09-12', 'success', { phase: 'execute', note: 'daily done' });
  const r = await mon._runShopSwitchAction(SHOP, 'enable', {
    cost: { valueCents: 5000, businessDate: '2026-09-12' },
    orders: { valueCount: 100 },
    evaluation: { reason: 'below' },
  }, { aborted: false }, 'interval');
  assert.strictEqual(r.decision, 'should_enable');
  assert.strictEqual(r.zeroClick, false, 'threshold_recovery 不受每日成功限制');
  assert.strictEqual(enableClicks(track.clickLog).length >= 1, true);
});

test('演练 / enableEnabled=false → 零点击', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:30'));
  const dry = await setupDefault(t, {
    clock, costCents: 5000, realMode: false,
    fixture: { plans: { '全店托管': [{ ...TUOGUAN, checked: false }], '商品自选': ZIX(1, false) } },
  });
  const r1 = await dry.mon.pollOnce('interval');
  assert.strictEqual(enableClicks(dry.track.clickLog).length, 0);
  assert.strictEqual(r1.results[0].zeroClick, true);

  const off = await setupDefault(t, {
    clock, costCents: 5000,
    fixture: { plans: { '全店托管': [{ ...TUOGUAN, checked: false }], '商品自选': ZIX(1, false) } },
    monitorChengfang: { enableEnabled: false },
  });
  await off.mon.pollOnce('interval');
  assert.strictEqual(enableClicks(off.track.clickLog).length, 0);
  assert.strictEqual(switchClicks(off.track.clickLog).length, 0);
});

test('隔离：refreshView 抛错 → blocked/unknown，零开关调用', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:30'));
  let clicks = 0;
  const { mon } = await setupDefault(t, {
    clock, costCents: 5000,
    fixture: { plans: { '全店托管': [{ id: 't1', checked: false }], '商品自选': [] } },
  });
  mon._chengfangOpener = async () => {
    clicks += 1;
    return {
      page: {},
      controller: {
        verifyIdentity: async () => ({ ok: true, pageShopId: SHOP.id, pageShopName: SHOP.name, pageAccountId: ACCOUNT_ID }),
        refreshView: async () => { throw new Error('刷新抛错'); },
        switchView: async () => {},
        readView: async () => ({ rows: { rows: [{ id: 't1', switchChecked: false }] }, pagination: { total: 1, hasNext: false } }),
      },
      close: async () => {},
    };
  };
  const r = await mon._readCurrentAdState(SHOP);
  assert.strictEqual(r.state, 'unknown');
  assert.strictEqual(r.error && r.error.status, 'blocked');
  assert.match(r.error.reason || '', /刷新失败/);
  assert.strictEqual(clicks, 1, '仅读取会话');
});

test('隔离：新 UI 刷新未成功 / 重设每页条数失败 → blocked，零开关', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:30'));
  const { mon } = await setupDefault(t, { clock, costCents: 5000, fixture: { plans: { '全店托管': [], '商品自选': [] } } });
  mon._chengfangOpener = async () => ({
    page: {},
    controller: {
      verifyIdentity: async () => ({ ok: true, pageShopId: SHOP.id, pageShopName: SHOP.name, pageAccountId: ACCOUNT_ID }),
      refreshView: async () => ({ refreshed: false, reason: 'page.reload 不可用', ui: 'aurora' }),
      switchView: async () => {},
      readView: async () => ({ rows: { rows: [] }, pagination: { total: 0, hasNext: false } }),
    },
    close: async () => {},
  });
  const r = await mon._readCurrentAdState(SHOP);
  assert.strictEqual(r.error.status, 'blocked');
  assert.match(r.error.reason, /刷新未成功/);

  mon._chengfangOpener = async () => ({
    page: {},
    controller: {
      verifyIdentity: async () => ({ ok: true, pageShopId: SHOP.id, pageShopName: SHOP.name, pageAccountId: ACCOUNT_ID }),
      refreshView: async () => ({ refreshed: true, ui: 'aurora', pageSize: '10条/页', warning: '刷新后重设每页条数未成功：x' }),
      switchView: async () => {},
      readView: async () => ({ rows: { rows: [] }, pagination: { total: 0, hasNext: false } }),
    },
    close: async () => {},
  });
  const r2 = await mon._readCurrentAdState(SHOP);
  assert.strictEqual(r2.error.status, 'blocked');
  assert.match(r2.error.reason, /重设每页条数/);
});

test('隔离：分页 hasNext 缺失 → blocked；完整分页 → mixed', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:30'));
  const { mon } = await setupDefault(t, { clock, costCents: 5000, fixture: { plans: { '全店托管': [], '商品自选': [] } } });
  mon._chengfangOpener = async () => ({
    page: {},
    controller: {
      verifyIdentity: async () => ({ ok: true, pageShopId: SHOP.id, pageShopName: SHOP.name, pageAccountId: ACCOUNT_ID }),
      refreshView: async () => ({ refreshed: false, reason: 'legacy-ui', ui: 'legacy' }),
      switchView: async () => {},
      readView: async () => ({ rows: { rows: [{ id: 'a', switchChecked: true }] }, pagination: { total: 2 } }),
    },
    close: async () => {},
  });
  const r = await mon._readCurrentAdState(SHOP);
  assert.strictEqual(r.error.status, 'blocked');
  assert.match(r.error.reason, /hasNext/);

  mon._chengfangOpener = async () => {
    let n = 0;
    return {
      page: {},
      controller: {
        verifyIdentity: async () => ({ ok: true, pageShopId: SHOP.id, pageShopName: SHOP.name, pageAccountId: ACCOUNT_ID }),
        refreshView: async () => ({ refreshed: true, ui: 'aurora', pageSize: '100条/页' }),
        switchView: async () => {},
        readView: async () => {
          n += 1;
          return { rows: { rows: [{ id: 'a', switchChecked: true }, { id: 'b', switchChecked: false }] }, pagination: { total: 2, hasNext: false } };
        },
      },
      close: async () => {},
    };
  };
  const r2 = await mon._readCurrentAdState(SHOP);
  assert.strictEqual(r2.state, 'mixed');
  assert.ok(!r2.error);
});

test('隔离清单完整性：refresh null / warning / total 缺行 / 重复 ID → blocked', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:30'));
  const { mon } = await setupDefault(t, { clock, costCents: 5000, fixture: { plans: { '全店托管': [], '商品自选': [] } } });
  const mk = (rf, read) => async () => ({
    page: {},
    controller: {
      verifyIdentity: async () => ({ ok: true, pageShopId: SHOP.id, pageShopName: SHOP.name, pageAccountId: ACCOUNT_ID }),
      refreshView: rf,
      switchView: async () => {},
      readView: read,
    },
    close: async () => {},
  });
  mon._chengfangOpener = mk(async () => null, async () => ({ rows: { rows: [] }, pagination: { total: 0, hasNext: false } }));
  let r = await mon._readCurrentAdState(SHOP);
  assert.match(r.error.reason, /不可识别|刷新/);

  mon._chengfangOpener = mk(async () => ({ refreshed: true, ui: 'aurora', pageSize: '100条/页', warning: '任意新 UI 警告' }), async () => ({ rows: { rows: [] }, pagination: { total: 0, hasNext: false } }));
  r = await mon._readCurrentAdState(SHOP);
  assert.match(r.error.reason, /刷新警告/);

  mon._chengfangOpener = mk(async () => ({ refreshed: true, ui: 'aurora', pageSize: '100条/页' }), async () => ({ rows: { rows: [{ id: 'a', switchChecked: true }] }, pagination: { total: 3, hasNext: false } }));
  r = await mon._readCurrentAdState(SHOP);
  assert.match(r.error.reason, /已读行数|清单不完整/);

  mon._chengfangOpener = mk(async () => ({ refreshed: false, reason: 'legacy-ui', ui: 'legacy' }), async () => ({ rows: { rows: [{ id: 'dup', switchChecked: true }, { id: 'dup', switchChecked: false }] }, pagination: { total: 2, hasNext: false } }));
  r = await mon._readCurrentAdState(SHOP);
  assert.match(r.error.reason, /重复/);
});

test('隔离 pollOnce 全链：清单不完整 → blocked/unknown，零 enable/pause/switch', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:30'));
  const { mon } = await setupDefault(t, { clock, costCents: 5000, fixture: { plans: { '全店托管': [], '商品自选': [] } } });
  const calls = { enable: 0, pause: 0 };
  const originalEnable = mon._executeEnableBatchFor.bind(mon);
  const originalPause = mon._pollChengfangOver.bind(mon);
  mon._executeEnableBatchFor = async (...args) => { calls.enable += 1; return originalEnable(...args); };
  mon._pollChengfangOver = async (...args) => { calls.pause += 1; return originalPause(...args); };
  let switchClicks = 0;
  mon._chengfangOpener = async () => ({
    page: {},
    controller: {
      verifyIdentity: async () => ({ ok: true, pageShopId: SHOP.id, pageShopName: SHOP.name, pageAccountId: ACCOUNT_ID }),
      refreshView: async () => ({ refreshed: true, ui: 'aurora', pageSize: '100条/页' }),
      switchView: async () => {},
      readView: async () => ({ rows: { rows: [{ id: 'a', switchChecked: true }] }, pagination: { total: 5, hasNext: false } }),
      clickRowSwitch: async () => { switchClicks += 1; },
      clickBatchPause: async () => { switchClicks += 1; },
      clickBatchEnable: async () => { switchClicks += 1; },
    },
    close: async () => {},
  });
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].status, 'blocked');
  assert.strictEqual(r.results[0].zeroClick, true);
  assert.strictEqual(r.results[0].decision, 'unknown_blocked');
  assert.strictEqual(calls.enable, 0);
  assert.strictEqual(calls.pause, 0);
  assert.strictEqual(switchClicks, 0, '底层开关调用为 0');
});

test('隔离分页契约：activePage 重复/缺序/total 不一致须阻止；1→2 且 total 一致通过', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:30'));
  const { mon } = await setupDefault(t, { clock, costCents: 5000, fixture: { plans: { '全店托管': [], '商品自选': [] } } });
  const mk = (pages) => async () => {
    const nextByTab = new Map();
    return {
      page: {},
      controller: {
        verifyIdentity: async () => ({ ok: true, pageShopId: SHOP.id, pageShopName: SHOP.name, pageAccountId: ACCOUNT_ID }),
        refreshView: async () => ({ refreshed: true, ui: 'aurora', pageSize: '100条/页' }),
        switchView: async () => {},
        readView: async ({ tab }) => {
          const i = nextByTab.get(tab) || 0;
          nextByTab.set(tab, i + 1);
          return pages[i] || pages[pages.length - 1];
        },
        clickNextPage: async () => ({ clicked: true }),
      },
      close: async () => {},
    };
  };
  // 两页 activePage 均为 1 → 阻止
  mon._chengfangOpener = mk([
    { rows: { rows: [{ id: 'a', switchChecked: true }] }, pagination: { activePage: 1, total: 2, hasNext: true } },
    { rows: { rows: [{ id: 'b', switchChecked: false }] }, pagination: { activePage: 1, total: 2, hasNext: false } },
  ]);
  let r = await mon._readCurrentAdState(SHOP);
  assert.match(r.error.reason, /重复页|页码/);

  // 多页 activePage 缺失 → 阻止
  mon._chengfangOpener = mk([
    { rows: { rows: [{ id: 'a', switchChecked: true }] }, pagination: { total: 2, hasNext: true } },
    { rows: { rows: [{ id: 'b', switchChecked: false }] }, pagination: { activePage: 2, total: 2, hasNext: false } },
  ]);
  r = await mon._readCurrentAdState(SHOP);
  assert.match(r.error.reason, /activePage/);

  // 末页行数 > total → 阻止
  mon._chengfangOpener = mk([
    { rows: { rows: [{ id: 'a', switchChecked: true }, { id: 'b', switchChecked: false }] }, pagination: { activePage: 1, total: 1, hasNext: false } },
  ]);
  r = await mon._readCurrentAdState(SHOP);
  assert.match(r.error.reason, /不一致|清单不完整/);

  // total 非法 → 阻止
  mon._chengfangOpener = mk([
    { rows: { rows: [{ id: 'a', switchChecked: true }] }, pagination: { activePage: 1, total: 'x', hasNext: false } },
  ]);
  r = await mon._readCurrentAdState(SHOP);
  assert.match(r.error.reason, /total 非法/);

  // 正常 1→2 且 total 一致 → mixed
  mon._chengfangOpener = mk([
    { rows: { rows: [{ id: 'a', switchChecked: true }] }, pagination: { activePage: '1', total: 2, hasNext: true } },
    { rows: { rows: [{ id: 'b', switchChecked: false }] }, pagination: { activePage: '2', total: 2, hasNext: false } },
  ]);
  r = await mon._readCurrentAdState(SHOP);
  assert.strictEqual(r.state, 'mixed');
  assert.ok(!r.error);
});

test('隔离 pollOnce：activePage 重复 → blocked，零 enable/pause/switch', async (t) => {
  const clock = makeClock(shanghaiMs('2026-09-12', '08:30'));
  const { mon } = await setupDefault(t, { clock, costCents: 5000, adState: 'off', fixture: { plans: { '全店托管': [], '商品自选': [] } } });
  let sw = 0;
  mon._chengfangOpener = async () => {
    let i = 0;
    const pages = [
      { rows: { rows: [{ id: 'a', switchChecked: true }] }, pagination: { activePage: 1, total: 2, hasNext: true } },
      { rows: { rows: [{ id: 'b', switchChecked: false }] }, pagination: { activePage: 1, total: 2, hasNext: false } },
    ];
    return {
      page: {},
      controller: {
        verifyIdentity: async () => ({ ok: true, pageShopId: SHOP.id, pageShopName: SHOP.name, pageAccountId: ACCOUNT_ID }),
        refreshView: async () => ({ refreshed: true, ui: 'aurora', pageSize: '100条/页' }),
        switchView: async () => {},
        readView: async () => pages[i++] || pages[pages.length - 1],
        clickNextPage: async () => ({ clicked: true }),
        clickRowSwitch: async () => { sw += 1; },
        clickBatchPause: async () => { sw += 1; },
        clickBatchEnable: async () => { sw += 1; },
      },
      close: async () => {},
    };
  };
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].status, 'blocked');
  assert.strictEqual(r.results[0].zeroClick, true);
  assert.strictEqual(sw, 0);
});
