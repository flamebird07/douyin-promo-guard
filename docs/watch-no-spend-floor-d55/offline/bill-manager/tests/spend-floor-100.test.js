'use strict';

/**
 * 消耗门槛（D55 已取消 50 元门槛）：Monitor 判定 → watch-drill 投影 / 持久 JSONL / 页面行数据。
 *
 * 真实链路：Monitor.pollOnce（真实规则+决策+judgement 事件）→ watch-drill sync
 * （既有事件流消费 + buildShopRows 投影）→ 快照行与 JSONL 日志。
 * 不启动服务、不启动调度循环、不打开浏览器、不访问生产、不发飞书。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 安装到 bill-manager 后 app/tests 上两级的默认 guard 目录不存在：显式
// PROMO_GUARD_DIR 优先；未显式指定时保留隔离目录的默认相对路径。
const GUARD_DIR = process.env.PROMO_GUARD_DIR || path.join(__dirname, '..', '..', 'guard');
process.env.PROMO_GUARD_DIR = GUARD_DIR;
// 避免 watch-drill 在加载时探测/读取根外 publisher：给一个受控临时目录（只有空 shop-profile）。
const PUBLISHER_STUB = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-pub-'));
fs.writeFileSync(path.join(PUBLISHER_STUB, 'shop-profile.cjs'), 'module.exports = {};\n');
process.env.PUBLISHER_DIR = PUBLISHER_STUB;

const { buildShopRows, createWatchDrill } = require('../watch-drill');
const { Monitor } = require(path.join(GUARD_DIR, 'src/engine/monitor'));
const {
  makeTempDir, writeTempCookie, makeCfgResult, makeStatefulController,
} = require(path.join(GUARD_DIR, 'test/helpers'));
const { shanghaiMs, shanghaiDate } = require(path.join(GUARD_DIR, 'src/lib/time'));

const NOW = shanghaiMs('2026-10-17', '12:00');
const SHOP = { id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', accountId: null, enabled: true };
const IDENTITY = { id: 'shop-001', name: '测试店铺一', accountId: null };

function statusWith(rows, businessDate) {
  return { businessDate, shops: rows };
}

test('buildShopRows：只透传同店同日 bool 投影，UI 不拿 null 当 0 重算', () => {
  const today = '2026-10-17';
  const rows = buildShopRows(statusWith([
    {
      id: 'a', name: '甲', displayName: '甲', platform: 'douyin', lastAdState: 'on',
      today: { businessDate: today, costCents: 5001, orders: 1, roiTooLow: true, spendProtected: false, pauseEligible: true, spendFloorCents: 0 },
    },
    {
      id: 'b', name: '乙', displayName: '乙', platform: 'douyin', lastAdState: 'on',
      today: { businessDate: today, costCents: 5000, orders: 1, roiTooLow: false, spendProtected: false, pauseEligible: false },
    },
    {
      id: 'c', name: '丙', displayName: '丙', platform: 'douyin', lastAdState: 'on',
      today: { businessDate: '2026-10-16', costCents: 5001, orders: 1, roiTooLow: true },
    },
    {
      id: 'd', name: '丁', displayName: '丁', platform: 'douyin', lastAdState: 'on',
      today: { businessDate: today, costCents: null, orders: null, roiTooLow: null },
    },
    {
      id: 'e', name: '戊', displayName: '戊', platform: 'douyin', lastAdState: 'on',
      today: null,
    },
  ], today));

  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  assert.strictEqual(byId.a.roiTooLow, true);
  assert.strictEqual(byId.a.spendFloorCents, 0);
  assert.strictEqual(byId.b.roiTooLow, false, 'cost=5000 且后端 false 时不得重算为 true');
  assert.strictEqual(byId.b.spendProtected, false, '无消耗门槛：兼容字段恒 false');
  assert.strictEqual(byId.c.roiTooLow, false, '跨日（昨日 true）不得残留');
  assert.strictEqual(byId.d.roiTooLow, false, 'null 不得当 0 或 true');
  assert.strictEqual(byId.e.roiTooLow, false, '无 today 不得伪造提示');
});

async function monitorFixture(t, { costCents, orders = 100, adState = 'on' }) {
  const cookieDir = makeTempDir('sf-app-ck-');
  const dataDir = makeTempDir('sf-app-data-');
  writeTempCookie(cookieDir, '测试店铺一');
  const cfgResult = makeCfgResult({
    cookieDir,
    shops: [SHOP],
    thresholdCents: 100,
    execution: { realMode: false, dryRun: true, readbackTimeoutMs: 200, readbackIntervalMs: 1 },
    schedule: { dailyStartHour: 8 },
    monitor: { chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: true, enableEnabled: true } },
  });
  const reader = {
    connected: false,
    async readCostSummary({ shopCfg }) {
      return {
        source: 'promo-page', kind: 'cost', shopId: shopCfg.id,
        businessDate: shanghaiDate(NOW), fetchedAt: new Date(NOW).toISOString(),
        valueCents: costCents,
      };
    },
    async readOrderSummary({ shopCfg }) {
      return {
        source: 'promo-page', kind: 'orders', shopId: shopCfg.id,
        businessDate: shanghaiDate(NOW), fetchedAt: new Date(NOW).toISOString(),
        valueCount: orders,
      };
    },
    async listAdPage() { throw new Error('本测试注入 readAdState，不应读取清单'); },
  };
  const controller = makeStatefulController({ identity: IDENTITY, ads: [] });
  const mon = new Monitor(cfgResult, { reader, controller }, {
    dataDir,
    nowFn: () => NOW,
    readAdState: async () => adState,
  });
  // 隔离：自动发现不在本专项范围；固定为显式店铺，避免临时 Cookie 目录扩展出同名店。
  mon.config.shops = [SHOP];
  mon.requestShopDiscovery = () => ({ throttled: false, ok: true, persisted: true, added: [], skipped: [] });
  mon._pollChengfangOver = async () => ({
    status: 'ok', dryRun: true, over: true,
    batch: {
      actionType: 'pause', outcome: 'dry', dryRun: true,
      counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 }, targets: [],
    },
  });
  mon._executeEnableBatchFor = async () => ({
    outcome: 'all_enabled_confirmed', allEnabledConfirmed: true, actionType: 'enable',
    counts: { confirmed: 1, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
  });
  t.after(() => {
    try { mon.stop(); } catch (_) {}
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { mon, cfgResult, dataDir };
}

function makeDrill(t, cfgResult, dataDir) {
  const persistFile = path.join(dataDir, 'watch-drill.jsonl');
  const drill = createWatchDrill({
    config: cfgResult.config,
    nowFn: () => NOW,
    persistFile,
    dataDir,
  });
  t.after(() => { try { drill.stop(); } catch (_) {} });
  return { drill, persistFile };
}

test('真实链路：严格超标 → watch-drill 行提示 + JSONL 日志含 ROI设置过低（无消耗门槛）', async (t) => {
  const { mon, cfgResult, dataDir } = await monitorFixture(t, { costCents: 5001, orders: 50 });
  await mon.pollOnce('interval');
  const { drill, persistFile } = makeDrill(t, cfgResult, dataDir);
  drill._internal._monitor = mon;

  const snap = drill.sync();
  const row = snap.shopRows.find((x) => x.id === SHOP.id);
  assert.ok(row, '必须包含本店投影行');
  assert.strictEqual(row.roiTooLow, true);
  assert.strictEqual(row.spendProtected, false);
  assert.strictEqual(row.costCents, 5001);

  const raw = fs.readFileSync(persistFile, 'utf-8');
  const lines = raw.split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const hit = lines.find((l) => /ROI设置过低/.test(l.msg));
  assert.ok(hit, '持久 JSONL 必须能读到 ROI 提示');
  assert.match(hit.msg, /当日费比超标（无消耗门槛/);
  assert.doesNotMatch(hit.msg, /50\s*元/);
  assert.match(hit.msg, /5001/);
  assert.match(hit.msg, /100/);
  assert.strictEqual(hit.level, 'warn');
});

test('真实链路：低消耗（5000 分）高费比 → 行提示 + ROI 日志，不再宣称 50 元保护', async (t) => {
  const { mon, cfgResult, dataDir } = await monitorFixture(t, { costCents: 5000, orders: 1 });
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].decision, 'should_pause', '低消耗严格超标必须进入暂停判定');
  const { drill, persistFile } = makeDrill(t, cfgResult, dataDir);
  drill._internal._monitor = mon;

  const snap = drill.sync();
  const row = snap.shopRows.find((x) => x.id === SHOP.id);
  assert.strictEqual(row.roiTooLow, true);
  assert.strictEqual(row.spendProtected, false);

  const lines = fs.readFileSync(persistFile, 'utf-8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  const roi = lines.find((l) => /ROI设置过低/.test(l.msg));
  assert.ok(roi, '低消耗超标也必须产生 ROI 提示: ' + lines.map((l) => l.msg).join(' | '));
  assert.strictEqual(roi.level, 'warn');
  assert.doesNotMatch(roi.msg, /50\s*元/);
  assert.strictEqual(lines.some((l) => /50\s*元保护/.test(l.msg)), false, '日志不得再宣称 50 元保护');
});

test('跨日：Monitor 投影随业务日期失效，页面不残留昨日 ROI 提示', async (t) => {
  const { mon, cfgResult, dataDir } = await monitorFixture(t, { costCents: 5001, orders: 50 });
  await mon.pollOnce('interval');
  const { drill } = makeDrill(t, cfgResult, dataDir);
  drill._internal._monitor = mon;
  const first = drill.sync().shopRows.find((x) => x.id === SHOP.id);
  assert.strictEqual(first.roiTooLow, true);

  // 次日：Monitor 状态中的 today 仍是昨日数据，buildShopRows 必须按 businessDate 清掉提示
  const nextDay = shanghaiMs('2026-10-18', '12:00');
  mon.nowFn = () => nextDay;
  drill._internal._now = () => nextDay;
  const snap2 = drill.sync();
  const row2 = snap2.shopRows.find((x) => x.id === SHOP.id);
  assert.strictEqual(row2.roiTooLow, false, '跨日不得残留昨日警告');
  assert.strictEqual(snap2.businessDate, '2026-10-18');
});

test('0 订单/坏数据：Monitor 不产生 ROI 提示，页面行为空', async (t) => {
  const { mon, cfgResult, dataDir } = await monitorFixture(t, { costCents: 5001, orders: 0 });
  const r = await mon.pollOnce('interval');
  assert.strictEqual(r.results[0].status, 'blocked');
  const { drill } = makeDrill(t, cfgResult, dataDir);
  drill._internal._monitor = mon;
  const snap = drill.sync();
  const row = snap.shopRows.find((x) => x.id === SHOP.id);
  assert.strictEqual(row.roiTooLow, false);
  assert.notStrictEqual(row.today.roiTooLow, true, '坏数据不得产生提示');
});
