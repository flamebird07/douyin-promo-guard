'use strict';

/**
 * Cookie-first 店铺行为隔离测试。
 * 自动发现店使用各自 Cookie，无需预填广告账户号；显式配置账户号时保留原有校验。
 * 全部临时目录 + mock 读取器/控制器；不读取真实 Cookie 内容，不访问真实页面。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor');
const {
  makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock,
} = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');

const RULES = [{ type: 'wholeShopCostPerOrder', name: 'r', thresholdCents: 100, comparator: '>', period: 'today', timezone: 'Asia/Shanghai', enabled: true }];

/**
 * 构造单店/多店 Monitor：
 * - costAccountId：费用源实测账户（进 summary.accountId）；
 * - pageAccountId：乘方页面实测账户（经注入 readAdState 的 identity 锚点）；
 * - controllerAccountId：mock 控制器身份（coordinator 批次核验用）；
 * - compassPageName：罗盘页面实测店铺名（阶段 6 修正）——undefined=默认与
 *   Cookie 文件基名一致；null=证据缺失（不携带 identityEvidence/identitySource）；
 *   字符串=页面实测店铺名（可制造不一致）。
 * - orderDataSource：注入配置 monitor.orderDataSource（默认 'compass'；来源门禁核查）。
 * - ordersSource：订单摘要 source（默认 'promo-page'，与真实罗盘适配器一致）。
 * - orderSummaryPatch(out)：摘要后处理钩子（伪造/删除字段用）。
 * 正向路径订单摘要契约与真实罗盘适配器一致：source='promo-page' +
 * identitySource={adapter:'compass-order-reader', evidence:'userName-exact-match', pageShopName}。
 */
function setup(t, { shops, costAccountId = null, pageAccountId = null, controllerAccountId = null, realMode = true, compassPageName, orderDataSource = 'compass', ordersSource = 'promo-page', orderSummaryPatch = null, deleted = false } = {}) {
  const cookieDir = makeTempDir('pg-idp-cookies-');
  const cfgDir = makeTempDir('pg-idp-cfg-');
  const dataDir = makeTempDir('pg-idp-data-');
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
  const cfgResult = makeCfgResult({ shops: list, cookieDir, rules: RULES, monitor: { legacyWholeShopCloseEnabled: true, orderDataSource }, execution: { realMode } });
  cfgResult.sourcePath = cfgPath;
  const clock = makeClock(shanghaiMs('2026-09-12', '09:00'));
  const controllers = new Map();
  const readers = new Map();
  for (const s of list) {
    const c = makeStatefulController({
      identity: { id: s.id, name: s.name, accountId: controllerAccountId },
      ads: [{ adId: `${s.id}-ad-1`, name: '广告1', status: '投放中', switchChecked: true }],
    });
    const r = makeLinkedReader(c, {
      costCents: 2000, orders: 10, // 2000 分 > 10×100 → 超标
      costShopId: s.id, orderShopId: s.id, adsShopId: s.id,
      costDate: '2026-09-12', orderDate: '2026-09-12', adsDate: '2026-09-12',
      costFetchedAt: new Date(clock.nowFn()).toISOString(),
      orderFetchedAt: new Date(clock.nowFn()).toISOString(),
      adsFetchedAt: new Date(clock.nowFn()).toISOString(),
      pageSource: 'promo-page', // 真实模式下 guard 禁止 mock 来源（既有 fail-closed）
      costAccountId,
      adsAccountId: controllerAccountId, // 已配置账户时既有 guard 对广告清单的映射核验
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
      // 订单摘要来源契约（阶段 6 来源门禁）：与真实罗盘适配器一致——
      // source='promo-page' + identitySource 结构化标记；compassPageName=null
      // 模拟证据缺失；orderSummaryPatch 供伪造/删除字段用。
      const shopCfg = list.find((x) => x.id === id) || {};
      const base = String(shopCfg.cookieFile || shopCfg.name || '').replace(/\.json$/i, '');
      const name = compassPageName === undefined ? base : compassPageName;
      const out = { ...s, source: ordersSource };
      if (name !== null) {
        out.identityEvidence = { via: 'mock-compass', pageShopName: name };
        out.identitySource = { adapter: 'compass-order-reader', evidence: 'userName-exact-match', pageShopName: name };
      }
      if (orderSummaryPatch) orderSummaryPatch(out);
      return out;
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
    // 页面身份锚点：注入 readAdState 携带 identity（阶段 6 扩展契约）
    readAdState: async () => ({ state: 'on', identity: pageAccountId ? { pageAccountId, ok: true } : null }),
  });
  return { m, cfgPath, cookieDir, dataDir, controllers, clock, disk: () => JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) };
}

const shop = (over = {}) => ({ id: 'shop-a', name: '甲店', cookieFile: '甲店', enabled: true, autoDiscovered: true, ...over });

// Cookie-first 行为：新店无需预填账户号，已有账户号仍照原有校验。

test('自动发现店有 Cookie 即可值守，不因缺少账户号显示待核验', async (t) => {
  const { m, controllers, disk } = setup(t, { shops: [shop()], costAccountId: 'ACC-COST', pageAccountId: null });
  assert.strictEqual(m.getStatus().shopRows[0].identityPending, false);
  const p = await m.pollOnce('test');
  assert.notStrictEqual(p.results[0].blocked, 'identity_pending');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 1, '超标时使用该店 Cookie 会话执行');
  assert.strictEqual(disk().shops[0].accountId, undefined, '不自动写入页面账户号');
});

test('自动发现店不要求费用页和乘方页账户号预先一致', async (t) => {
  const { m, controllers, disk } = setup(t, {
    shops: [shop()], costAccountId: 'ACC-COST', pageAccountId: 'ACC-PAGE',
  });
  const p = await m.pollOnce('test');
  assert.notStrictEqual(p.results[0].blocked, 'identity_pending');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 1);
  assert.strictEqual(disk().shops[0].accountId, undefined);
});

test('自动发现店只读更新不写入账户元数据', async (t) => {
  const { m, controllers, disk } = setup(t, { shops: [shop()], costAccountId: 'ACC-COST' });
  const r = await m.refreshShopData('shop-a');
  assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.strictEqual(r.readOnly, true);
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 0);
  assert.strictEqual(disk().shops[0].accountId, undefined);
});

test('每日开启对自动发现店正常进入开启批次', async (t) => {
  const { m } = setup(t, { shops: [shop()] });
  m.enableRunning = true;
  let calls = 0;
  m._executeEnableBatchFor = async () => { calls += 1; return { outcome: 'dry', dryRun: true, neverSent: true }; };
  m._readAdState = async () => ({ state: 'off', identity: null });
  await m._runEnablePhase(0, '2026-09-12');
  assert.strictEqual(calls, 1, '无账户号时仍进入该店开启批次');
  assert.strictEqual(m.getStatus().shopRows[0].identityPending, false);
  m.enableRunning = false;
});

test('显式配置的账户号不匹配：不因 ID 阻断，超标仍执行原有关闭路径，配置不被覆盖', async (t) => {
  const { m, controllers, disk } = setup(t, {
    shops: [{ id: 'shop-m', name: '甲店', cookieFile: '甲店', enabled: true, accountId: 'ACC-M' }],
    costAccountId: 'ACC-WRONG', pageAccountId: 'ACC-M', controllerAccountId: 'ACC-M',
  });
  const p = await m.pollOnce('test');
  // 归属=Cookie 文件+店铺 ID：费用源实测 ACC-WRONG / 乘方页 ACC-M 与配置 ACC-M 不一致
  // 不得仅因此 AUTH 停机；本夹具费用 2000 分 > 10 单×100 分（超标）且广告投放中，
  // 应与无账户号用例同构，照常执行原有整店关闭路径。
  assert.notStrictEqual(p.results[0].status, 'stopped', '不得仅因账户 ID 不一致返回 AUTH 停机');
  assert.strictEqual(controllers.get('shop-m').state.closeCalls.length, 1, '超标且投放中：使用该店 Cookie 会话执行原有关闭路径');
  assert.strictEqual(disk().shops[0].accountId, 'ACC-M', '配置账户字段不被页面观察值覆盖');
});

test('已删除店不进入巡查和每日开启', async (t) => {
  const { m, controllers } = setup(t, { shops: [shop({ deleted: true, enabled: false })] });
  assert.strictEqual(m._activeShops().length, 0);
  await m.pollOnce('test');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 0);
  m.enableRunning = true;
  let calls = 0;
  m._executeEnableBatchFor = async () => { calls += 1; return { outcome: 'dry', dryRun: true, neverSent: true }; };
  m._readAdState = async () => ({ state: 'off', identity: null });
  await m._runEnablePhase(0, '2026-09-12');
  assert.strictEqual(calls, 0);
  m.enableRunning = false;
});
