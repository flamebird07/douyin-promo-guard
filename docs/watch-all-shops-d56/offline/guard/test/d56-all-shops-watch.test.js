'use strict';

/**
 * D56：取消正常店铺单独停用功能。
 *
 * 目标语义：
 *   - 活动范围只由软删除决定：deleted !== true 的店铺（即使历史 enabled=false，如生产瑾漂亮）
 *     必须自动纳入常规巡查轮询、每日开启、登录后加入；
 *   - deleted=true 仍绝不复活、绝不进入巡查/每日开启/加入；
 *   - 全局开关仍有效：monitor.running=false 时 joinShopNow 拒绝派发；
 *   - 既有费率/身份（Cookie）守卫不得被放宽（等于阈值零动作、身份不符 stopped、0 订单 blocked）；
 *   - getStatus 投影不得把未删除店铺误示为未启用。
 *
 * 全部使用假读取器/控制器 + 临时目录 + 注入时钟；不启动服务、不打开浏览器、不访问生产。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// watch-drill 在本文件内延迟 require；先固定 work 副本与隔离 publisher 目录，
// 避免任何解析回落到 work 之外的生产路径。
const GUARD_DIR = path.resolve(__dirname, '..');
process.env.PROMO_GUARD_DIR = GUARD_DIR;
const PUBLISHER_STUB = fs.mkdtempSync(path.join(os.tmpdir(), 'd56-pub-'));
fs.writeFileSync(path.join(PUBLISHER_STUB, 'shop-profile.cjs'), 'module.exports = {};\n');
process.env.PUBLISHER_DIR = PUBLISHER_STUB;

const { Monitor } = require('../src/engine/monitor');
const {
  makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock,
} = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');

const RULES = [{ type: 'wholeShopCostPerOrder', name: 'r', thresholdCents: 100, comparator: '>', period: 'today', timezone: 'Asia/Shanghai', enabled: true }];
const NOW = shanghaiMs('2026-10-17', '09:00');

// 正常店（enabled=true）与历史停用店（enabled=false, deleted=false，对应生产瑾漂亮）。
const ON = { id: 'shop-on', name: '正常店', cookieFile: '正常店', enabled: true };
const OFF = { id: 'shop-legacy-off', name: '历史停用店', cookieFile: '历史停用店', enabled: false, deleted: false };

function setup(t, { shops, costCents = 6000, orders = 10 } = {}) {
  const cookieDir = makeTempDir('d56-ck-');
  const cfgDir = makeTempDir('d56-cfg-');
  const dataDir = makeTempDir('d56-data-');
  t.after(() => {
    for (const d of [cookieDir, cfgDir, dataDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    }
  });
  const list = (shops || []).map((s) => ({ ...s }));
  for (const s of list) {
    if (s.deleted !== true) writeTempCookie(cookieDir, s.cookieFile || s.name);
  }
  const cfgPath = path.join(cfgDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ shops: list, rules: RULES }, null, 2));
  const cfgResult = makeCfgResult({
    shops: list, cookieDir, rules: RULES,
    monitor: { legacyWholeShopCloseEnabled: true, orderDataSource: 'compass' },
    execution: { realMode: true },
  });
  cfgResult.sourcePath = cfgPath;
  const clock = makeClock(NOW);
  const controllers = new Map();
  const readers = new Map();
  for (const s of list) {
    const c = makeStatefulController({
      identity: { id: s.id, name: s.name, accountId: null },
      ads: [{ adId: `${s.id}-ad-1`, name: '广告1', status: '投放中', switchChecked: true }],
    });
    const r = makeLinkedReader(c, {
      costCents, orders,
      costShopId: s.id, orderShopId: s.id, adsShopId: s.id,
      costDate: '2026-10-17', orderDate: '2026-10-17', adsDate: '2026-10-17',
      costFetchedAt: new Date(clock.nowFn()).toISOString(),
      orderFetchedAt: new Date(clock.nowFn()).toISOString(),
      adsFetchedAt: new Date(clock.nowFn()).toISOString(),
      pageSource: 'promo-page',
    }, clock.nowFn);
    controllers.set(s.id, c);
    readers.set(s.id, r);
  }
  const routerReader = {
    connected: true, source: 'mock',
    async readCostSummary(p) { return readers.get((p && p.shopCfg && p.shopCfg.id) || list[0].id).readCostSummary(); },
    async readOrderSummary(p) {
      const id = (p && p.shopCfg && p.shopCfg.id) || list[0].id;
      const s = await readers.get(id).readOrderSummary();
      const shopCfg = list.find((x) => x.id === id) || {};
      const base = String(shopCfg.cookieFile || shopCfg.name || '').replace(/\.json$/i, '');
      return {
        ...s, source: 'promo-page',
        identityEvidence: { via: 'mock-compass', pageShopName: base },
        identitySource: { adapter: 'compass-order-reader', evidence: 'userName-exact-match', pageShopName: base },
      };
    },
    async listAdPage(p) { return readers.get((p && p.shopCfg && p.shopCfg.id) || list[0].id).listAdPage(p || {}); },
  };
  const routerController = {
    connected: true, source: 'mock',
    async verifyIdentity(p) { return controllers.get((p && p.shopCfg && p.shopCfg.id) || list[0].id).verifyIdentity(); },
    async getAd(p) { return controllers.get((p && p.shopCfg && p.shopCfg.id) || list[0].id).getAd(p); },
    async closeAd(p) { return controllers.get((p && p.shopCfg && p.shopCfg.id) || list[0].id).closeAd(p); },
  };
  const m = new Monitor(cfgResult, { reader: routerReader, controller: routerController }, {
    dataDir, nowFn: clock.nowFn, delayFn: clock.delayFn,
    readAdState: async () => ({ state: 'on', identity: null }),
  });
  return { m, controllers, readers, clock, cfgPath, dataDir, cfgResult };
}

test('D56-1 历史 enabled=false 未删除店：纳入活动范围并进入巡查轮询，状态不误示未启用', async (t) => {
  const { m, controllers } = setup(t, { shops: [ON, OFF] });
  assert.deepStrictEqual(m._activeShops().map((s) => s.id).sort(), ['shop-legacy-off', 'shop-on']);

  const r = await m.pollOnce('test');
  const byId = Object.fromEntries(r.results.map((x) => [x.shopId, x]));
  assert.ok(byId['shop-legacy-off'], '历史停用店必须被轮询（不得静默跳过）');
  assert.strictEqual(byId['shop-legacy-off'].status, 'ok');
  assert.strictEqual(controllers.get('shop-legacy-off').state.closeCalls.length, 1, '超标时按原速率规则执行');

  const st = m.getStatus();
  const cfgRow = st.shops.find((x) => x.id === 'shop-legacy-off');
  const uiRow = st.shopRows.find((x) => x.id === 'shop-legacy-off');
  assert.strictEqual(cfgRow.enabled, true, '状态投影不得再显示未启用');
  assert.strictEqual(cfgRow.deleted, false);
  assert.strictEqual(uiRow.enabled, true, '店铺行不得误示未启用');
});

test('D56-2 历史 enabled=false 未删除店：进入每日开启批次', async (t) => {
  const { m } = setup(t, { shops: [ON, OFF] });
  m.enableRunning = true;
  t.after(() => { m.enableRunning = false; });
  const called = [];
  m._executeEnableBatchFor = async (shopCfg) => {
    called.push(shopCfg && shopCfg.id);
    return { outcome: 'dry', dryRun: true, neverSent: true };
  };
  m._readAdState = async () => ({ state: 'off', identity: null });
  await m._runEnablePhase(0, '2026-10-17');
  assert.ok(called.includes('shop-legacy-off'), `每日开启必须处理历史停用店，实际 ${called.join('、')}`);
});

test('D56-3 历史 enabled=false 未删除店：全局值守运行时可登录后加入（joinShopNow）', async (t) => {
  const { m } = setup(t, { shops: [OFF], costCents: 100, orders: 10 });
  m.running = true;
  t.after(() => { m.running = false; });
  const r = await m.joinShopNow('shop-legacy-off', { trigger: 'new-shop-join' });
  assert.strictEqual(r.ok, true, `历史停用店应被接管：${JSON.stringify(r).slice(0, 200)}`);
  assert.strictEqual(r.status, 'ok');
});

test('D56-4 软删除店仍绝不复活/加入：活动范围、轮询、每日开启、加入全部排除；删除功能保留', async (t) => {
  const { m, controllers } = setup(t, { shops: [ON, { ...OFF, deleted: true }] });
  assert.deepStrictEqual(m._activeShops().map((s) => s.id), ['shop-on']);
  const p = await m.pollOnce('test');
  assert.deepStrictEqual(p.results.map((x) => x.shopId), ['shop-on'], '已删除店不得被轮询');
  assert.strictEqual(controllers.get(OFF.id).state.closeCalls.length, 0);

  m.enableRunning = true;
  t.after(() => { m.enableRunning = false; });
  const called = [];
  m._executeEnableBatchFor = async (shopCfg) => {
    called.push(shopCfg && shopCfg.id);
    return { outcome: 'dry', dryRun: true, neverSent: true };
  };
  m._readAdState = async () => ({ state: 'off', identity: null });
  await m._runEnablePhase(0, '2026-10-17');
  assert.strictEqual(called.includes(OFF.id), false, '已删除店不得进入每日开启');

  m.running = true;
  t.after(() => { m.running = false; });
  const j = await m.joinShopNow(OFF.id);
  assert.strictEqual(j.ok, false);
  assert.strictEqual(j.status, 'blocked');
  assert.strictEqual(j.deleted, true);

  // 删除功能保留：正常店软删除后立即退出活动范围，墓碑字段保持
  const d = m.deleteShop('shop-on');
  assert.strictEqual(d.ok, true);
  assert.strictEqual(m._findShop('shop-on').deleted, true);
  assert.strictEqual(m._activeShops().some((s) => s.id === 'shop-on'), false);
});

test('D56-5 全局停止仍有效：running=false 时即使在正常店铺也拒绝派发', async (t) => {
  const { m } = setup(t, { shops: [OFF], costCents: 100, orders: 10 });
  assert.strictEqual(m.running, false);
  const r = await m.joinShopNow('shop-legacy-off');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.status, 'stopped');
  assert.match(r.reason, /值守未运行/);
  assert.strictEqual(m.getStatus().monitor.running, false);
});

test('D56-6 原费率/身份守卫保持：等于阈值与严格低于阈值零动作、身份不符 stopped', async (t) => {
  // 等于阈值：cost=订单数×100 → 零广告动作
  const eq = setup(t, { shops: [OFF], costCents: 100, orders: 1 });
  const r1 = await eq.m.pollOnce('test');
  assert.strictEqual(r1.results[0].status, 'ok');
  assert.strictEqual(eq.controllers.get(OFF.id).state.closeCalls.length, 0, '恰好等于阈值绝不暂停');

  // 身份不符（费用源 shopId 与目标店不一致）→ stopped，零动作
  const idm = setup(t, { shops: [OFF] });
  idm.readers.get(OFF.id).readCostSummary = async () => ({
    source: 'promo-page', kind: 'cost', shopId: 'WRONG-SHOP',
    businessDate: '2026-10-17', fetchedAt: new Date(NOW).toISOString(), valueCents: 6000,
  });
  const r2 = await idm.m.pollOnce('test');
  assert.strictEqual(r2.results[0].status, 'stopped');
  assert.strictEqual(idm.controllers.get(OFF.id).state.closeCalls.length, 0);

  // 严格低于阈值（5999 分 / 100 单）→ 零动作，不得因取消单店停用而放宽费率守卫
  const low = setup(t, { shops: [OFF], costCents: 5999, orders: 100 });
  const r3 = await low.m.pollOnce('test');
  assert.strictEqual(r3.results[0].status, 'ok');
  assert.strictEqual(low.controllers.get(OFF.id).state.closeCalls.length, 0, '未超标绝不暂停');
});

test('D56-7 wrapper：历史 enabled=false 未删除店登录后走 targeted-join（不再回落只读刷新）', async (t) => {
  const { m, dataDir } = setup(t, { shops: [OFF], costCents: 100, orders: 10 });
  m.running = true;
  t.after(() => { m.running = false; });
  m.requestShopDiscovery = () => ({ ok: true, throttled: false, persisted: true, added: [], skipped: [] });

  const { createWatchDrill } = require('../../bill-manager/watch-drill');
  const drill = createWatchDrill({
    config: m.config,
    nowFn: () => NOW,
    dataDir,
    persistFile: path.join(dataDir, 'd56-watch-drill.jsonl'),
  });
  t.after(() => { try { drill.stop(); } catch (_) {} });
  drill._internal._monitor = m;

  const out = drill.joinShopAfterLogin({ shopName: '历史停用店' });
  assert.strictEqual(out.action, 'targeted-join', `实际 action=${out.action} reason=${out.reason}`);
  assert.strictEqual(out.joined, true);
  const finalOut = await out.completion;
  assert.strictEqual(finalOut.targetResult.status, 'ok');
  assert.strictEqual(finalOut.processed, true);
});
