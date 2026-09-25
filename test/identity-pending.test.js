'use strict';

/**
 * 账户身份待核验隔离测试（2026-09-25 阶段 6）。
 * 用户已确认方案：自动发现店在页面/费用源双锚点一致前保持待身份核验，
 * 禁止真实开启/暂停/关闭/补点；一致时自动建立映射并解除；不一致时零动作、
 * 不覆盖、不代选。既有手工配置店行为不回归。
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

// ── 1. 新发现店：可展示、待核验、真实动作 0 ─────────────────────────

test('新 Cookie 自动发现后可展示，但未拿到账户身份时不进入真实动作（零关闭）', async (t) => {
  const { m, controllers } = setup(t, { shops: [shop()], costAccountId: 'ACC-COST', pageAccountId: null });
  const s = m.getStatus();
  assert.strictEqual(s.shops.length, 1, '待核验店在列表中可展示');
  assert.strictEqual(s.shops[0].identityPending, true, 'identityPending=true');
  assert.ok(/待身份核验/.test(s.shops[0].identityNote || ''), '状态说明含待身份核验');
  assert.strictEqual(s.shopRows[0].identityPending, true, 'shopRows 同步标记');
  const p = await m.pollOnce('test');
  const r = (p.results || [])[0] || {};
  assert.strictEqual(r.zeroClick, true, '零点击');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 0, '真实关闭调用为 0');
  // 判定层 blocked + 原因可见（judgement.decision 为决策字符串；阻止码在 reason/结果里）
  const j = m.judgements[m.judgements.length - 1];
  assert.ok(j, '有周期判定');
  assert.strictEqual(j.decision, 'data_blocked', '决策层 data_blocked 零动作');
  assert.ok(/待身份核验/.test(j.reason || ''), `判定原因含待身份核验：${j.reason}`);
  assert.strictEqual(m.getStatus().shops[0].identityPending, true, '仍未解除');
});

// ── 2. 双锚一致：自动建立并解除 ────────────────────────────────────

test('页面账户和费用账户一致：自动保存账户元数据（落盘）并允许后续值守动作', async (t) => {
  const { m, cfgPath, controllers } = setup(t, { shops: [shop()], costAccountId: 'ACC-1', pageAccountId: 'ACC-1', controllerAccountId: 'ACC-1' });
  assert.strictEqual(m.getStatus().shops[0].identityPending, true, '建立前 pending');
  const p = await m.pollOnce('test');
  const r = (p.results || [])[0] || {};
  assert.strictEqual(r.zeroClick, false, '解除后本轮按超标执行暂停（mock）');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 1, '建立后允许值守动作');
  assert.strictEqual(m._findShop('shop-a').accountId, 'ACC-1', '内存元数据已保存');
  const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  assert.strictEqual(disk.shops[0].accountId, 'ACC-1', '账户元数据原子落盘');
  assert.strictEqual(m.getStatus().shops[0].identityPending, false, '待核验解除');
  // 审计留痕
  const auditText = fs.readFileSync(path.join(m.dataDir, 'audit.jsonl'), 'utf-8');
  assert.ok(auditText.includes('"kind":"identity-establish"') && auditText.includes('"ok":true'), 'identity-establish 审计留痕');
  // 第二轮：广告已暂停（首批已关闭）→ nothing_to_close 不重复关闭；关键是不再有身份阻断
  const p2 = await m.pollOnce('test');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 1, '已关闭广告不重复关闭');
  assert.notStrictEqual(p2.results[0].blocked, 'identity_pending', '后续值守不再被身份阻断');
  assert.notStrictEqual(p2.results[0].status, 'stopped', '后续轮询正常（非 AUTH/异常停止）');
});

// ── 3. 双锚不一致：零动作、配置不变、原因保留 ──────────────────────

test('页面账户和费用账户不一致：零动作、配置不变、保留阻止原因、不代选不覆盖', async (t) => {
  const { m, cfgPath, controllers, disk } = setup(t, { shops: [shop()], costAccountId: 'ACC-COST', pageAccountId: 'ACC-PAGE' });
  const before = JSON.stringify(disk());
  const p = await m.pollOnce('test');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 0, '零真实动作');
  assert.strictEqual(JSON.stringify(disk()), before, 'config.json 一个字节都不变');
  const after = m.getStatus();
  assert.strictEqual(after.shops[0].identityPending, true, '保持待核验');
  assert.strictEqual(m._findShop('shop-a').accountId, undefined, '绝不自动选择任一账户写入');
  const errs = m.recentErrors.map((e) => e.error).join('\n');
  assert.ok(/账户来源不一致/.test(errs), `阻止原因保留：${errs.slice(0, 200)}`);
  const j = m.judgements[m.judgements.length - 1];
  assert.ok(/账户来源不一致/.test(j.reason || ''), '判定层同样可见阻止原因');
  // 重复轮询仍零动作、仍不写配置
  await m.pollOnce('test');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 0, '重复扫描仍零动作');
  assert.strictEqual(JSON.stringify(disk()), before, '重复扫描配置仍不变');
});

// ── 3b. 罗盘店铺名锚点（2026-09-25 阶段 6 修正）────────────────────

test('两个账户号一致但罗盘店铺名与 Cookie 基名不符：零动作、配置逐字节不变', async (t) => {
  const { m, cfgPath, controllers, disk } = setup(t, {
    shops: [shop()], costAccountId: 'ACC-1', pageAccountId: 'ACC-1', compassPageName: '别的店名',
  });
  const before = JSON.stringify(disk());
  await m.pollOnce('test');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 0, '零真实动作');
  assert.strictEqual(JSON.stringify(disk()), before, 'config.json 逐字节不变');
  assert.strictEqual(m._findShop('shop-a').accountId, undefined, '不写入任一账户');
  assert.strictEqual(m.getStatus().shops[0].identityPending, true, '保持待核验');
  const errs = m.recentErrors.map((e) => e.error).join('\n');
  assert.ok(/罗盘页面实测店铺名「别的店名」与 Cookie 文件基名「甲店」不一致/.test(errs), `阻止原因保留：${errs.slice(0, 200)}`);
  const j = m.judgements[m.judgements.length - 1];
  assert.ok(/罗盘页面实测店铺名/.test(j.reason || ''), '判定层可见阻止原因');
});

test('罗盘店铺名证据缺失（摘要无来源标记）：两账户一致也不建立、零动作', async (t) => {
  const { m, cfgPath, controllers, disk } = setup(t, {
    shops: [shop()], costAccountId: 'ACC-1', pageAccountId: 'ACC-1', compassPageName: null,
  });
  const before = JSON.stringify(disk());
  await m.pollOnce('test');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 0, '零真实动作');
  assert.strictEqual(JSON.stringify(disk()), before, 'config.json 逐字节不变');
  assert.strictEqual(m._findShop('shop-a').accountId, undefined, '不建立账户映射');
  assert.strictEqual(m.getStatus().shops[0].identityPending, true, '保持待核验');
  const errs = m.recentErrors.map((e) => e.error).join('\n');
  assert.ok(/订单证据来源门禁不通过/.test(errs) && /罗盘来源标记=缺失/.test(errs), `阻止原因保留：${errs.slice(0, 240)}`);
  // 立即更新（只读链路）同样不建立
  await m.refreshShopData('shop-a');
  assert.strictEqual(m._findShop('shop-a').accountId, undefined, '只读链路同样不建立');
});

// ── 3c. 订单证据来源门禁（2026-09-25 来源门禁补修）─────────────────

test('非罗盘订单源伪装同名字段（含伪造罗盘标记）：配置不符即门禁拦截，零动作、配置逐字节不变', async (t) => {
  const { m, cfgPath, controllers, disk } = setup(t, {
    shops: [shop()], costAccountId: 'ACC-1', pageAccountId: 'ACC-1',
    orderDataSource: 'not-compass', // 配置层即为非罗盘；摘要层伪装同名同标记也不放行
  });
  const before = JSON.stringify(disk());
  await m.pollOnce('test');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 0, '零真实动作');
  assert.strictEqual(JSON.stringify(disk()), before, 'config.json 逐字节不变');
  assert.strictEqual(m._findShop('shop-a').accountId, undefined, '不建立账户映射');
  assert.strictEqual(m.getStatus().shops[0].identityPending, true, '保持待核验');
  const errs = m.recentErrors.map((e) => e.error).join('\n');
  assert.ok(/订单证据来源门禁不通过/.test(errs) && /订单源配置=not-compass/.test(errs), `阻止原因保留：${errs.slice(0, 240)}`);
});

test('订单摘要来源为 mock：门禁拦截（摘要来源不符），零动作、不建立', async (t) => {
  const { m, controllers } = setup(t, {
    shops: [shop()], costAccountId: 'ACC-1', pageAccountId: 'ACC-1',
    realMode: false, ordersSource: 'mock', // dry 模式让 mock 来源穿过既有 guard，专测来源门禁
  });
  await m.pollOnce('test');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 0, '零真实动作');
  assert.strictEqual(m._findShop('shop-a').accountId, undefined, '不建立账户映射');
  assert.strictEqual(m.getStatus().shops[0].identityPending, true, '保持待核验');
  const errs = m.recentErrors.map((e) => e.error).join('\n');
  assert.ok(/订单证据来源门禁不通过/.test(errs) && /摘要来源=mock/.test(errs), `阻止原因保留：${errs.slice(0, 240)}`);
});

test('罗盘来源标记被剥离（identitySource 缺失）：同名 pageShopName 也不放行', async (t) => {
  const { m, controllers, disk } = setup(t, {
    shops: [shop()], costAccountId: 'ACC-1', pageAccountId: 'ACC-1',
    orderSummaryPatch: (o) => { delete o.identitySource; }, // 只留 identityEvidence.pageShopName
  });
  const before = JSON.stringify(disk());
  const s = m.getStatus();
  // 摘要里 identityEvidence.pageShopName 仍存在（同名同 Cookie 基名），但无来源标记
  await m.pollOnce('test');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 0, '零真实动作');
  assert.strictEqual(JSON.stringify(disk()), before, 'config.json 逐字节不变');
  assert.strictEqual(m._findShop('shop-a').accountId, undefined, '不建立账户映射');
  assert.strictEqual(s.shops[0].identityPending, true, '保持待核验');
  const errs = m.recentErrors.map((e) => e.error).join('\n');
  assert.ok(/订单证据来源门禁不通过/.test(errs) && /罗盘来源标记=缺失/.test(errs), `阻止原因保留：${errs.slice(0, 240)}`);
});

// ── 4. 每日 07:00 开启路径的身份门禁（2026-09-25 阶段 7）───────────
// 直接驱动 _runEnablePhase（等价于调度器运行态：enableRunning=true、gen 一致）；
// 开启批次 spy 采用安全桩（只计数、不透传）——即使出现缺陷路径也绝不触达真实页面。

test('每日开启：待身份核验店即使 off 且窗口内也不开启、不补点、不写成开启成功', async (t) => {
  const { m, controllers } = setup(t, {
    shops: [shop()], costAccountId: 'ACC-COST', pageAccountId: null, // 锚点不全 → 持续 pending
    realMode: true,
  });
  m.enableRunning = true; // 模拟每日开启调度器运行态
  let enableBatchCalls = 0;
  m._executeEnableBatchFor = async () => { enableBatchCalls += 1; return { outcome: 'dry', dryRun: true, neverSent: true }; };
  m._readAdState = async () => ({ state: 'off', identity: null }); // 广告当前为 off；锚点缺失
  const today = '2026-09-12';
  const r1 = await m._runEnablePhase(0, today);
  assert.strictEqual(r1.skipped, false, '进入开启相位处理（未被互斥跳过）');
  const rec = m.getEnablePhaseRecord('shop-a', today);
  assert.ok(rec, '有开启相位记录');
  assert.strictEqual(rec.status, 'failed', '身份未核验不得写成开启成功');
  assert.strictEqual(rec.phase, 'precheck', '停在决策前（未进入 execute/dry 批次）');
  assert.ok(/待身份核验/.test(rec.reason || ''), `原因含待身份核验：${rec.reason}`);
  assert.strictEqual(enableBatchCalls, 0, '底层开启批次调用为 0');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 0, '零广告动作');
  // 补点场景：窗口内重复触发仍零开启，相位不得转为 success/in_progress
  await m._runEnablePhase(0, today);
  assert.strictEqual(enableBatchCalls, 0, '重复触发不补点');
  const rec2 = m.getEnablePhaseRecord('shop-a', today);
  assert.strictEqual(rec2.status, 'failed', '重复触发仍不写成成功');
  assert.notStrictEqual(rec2.status, 'in_progress');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 0, '重复触发仍零动作');
  m.enableRunning = false;
});

test('每日开启：已删除店零动作（活动列表两层过滤，不进相位、不调用开启批次）', async (t) => {
  const { m, controllers } = setup(t, {
    shops: [shop({ deleted: true, enabled: false })],
    costAccountId: 'ACC-1', pageAccountId: 'ACC-1', controllerAccountId: 'ACC-1',
  });
  m.enableRunning = true;
  let enableBatchCalls = 0;
  m._executeEnableBatchFor = async () => { enableBatchCalls += 1; return { outcome: 'dry', dryRun: true, neverSent: true }; };
  m._readAdState = async () => ({ state: 'off', identity: null });
  const r = await m._runEnablePhase(0, '2026-09-12');
  assert.strictEqual(r.skipped, false);
  assert.strictEqual(enableBatchCalls, 0, '已删除店零开启批次');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 0, '零广告动作');
  assert.strictEqual(m.getEnablePhaseRecord('shop-a', '2026-09-12'), null, '不产生开启相位记录');
  assert.strictEqual(m._activeShops().length, 0, '不在活动列表');
  m.enableRunning = false;
});

// ── 4. 重启/重新构造后不误变成可执行 ───────────────────────────────

test('重启/重新构造后：未建立映射的待核验店仍不可执行', async (t) => {
  const first = setup(t, { shops: [shop()], costAccountId: 'ACC-COST', pageAccountId: null });
  const { m, cfgPath, controllers } = first;
  await m.pollOnce('test');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 0);
  const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  assert.strictEqual(disk.shops[0].accountId, undefined, '磁盘无账户元数据');
  // 模拟重启：磁盘配置重读 + 新 Monitor（同锚点缺失）
  const second = setup(t, { shops: disk.shops, costAccountId: 'ACC-COST', pageAccountId: null });
  const m2 = second.m;
  assert.strictEqual(m2.getStatus().shops[0].identityPending, true, '重新构造后仍待核验');
  const p2 = await m2.pollOnce('test');
  assert.strictEqual(second.controllers.get('shop-a').state.closeCalls.length, 0, '重启后仍零动作');
  assert.strictEqual(p2.results[0].zeroClick, true);
});

// ── 5. 既有手工配置店行为不回归 ────────────────────────────────────

test('已有配置账户的店铺：不回归（无待核验标记、正常决策、元数据不被覆盖）', async (t) => {
  const { m, controllers, cfgPath } = setup(t, {
    shops: [{ id: 'shop-m', name: '甲店', cookieFile: '甲店', enabled: true, accountId: 'ACC-M' }],
    costAccountId: 'ACC-M', pageAccountId: 'ACC-M', controllerAccountId: 'ACC-M',
  });
  const s = m.getStatus();
  assert.strictEqual(s.shops[0].identityPending, false, '手工配置店无待核验标记');
  const p = await m.pollOnce('test');
  assert.strictEqual(p.results[0].zeroClick, false);
  assert.strictEqual(controllers.get('shop-m').state.closeCalls.length, 1, '正常值守动作');
  assert.strictEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).shops[0].accountId, 'ACC-M', '元数据原样');
  const auditText = fs.readFileSync(path.join(m.dataDir, 'audit.jsonl'), 'utf-8');
  assert.ok(!auditText.includes('"kind":"identity-establish"'), '不产生身份建立审计（本来就已配置）');
});

test('手工配置但未填 accountId 的店：保持现行语义（不阻断），不误伤既有行为', async (t) => {
  const { m, controllers } = setup(t, {
    shops: [{ id: 'shop-l', name: '甲店', cookieFile: '甲店', enabled: true, accountId: null }],
    costAccountId: 'ACC-X', pageAccountId: 'ACC-Y', controllerAccountId: 'ACC-X',
  });
  const s = m.getStatus();
  assert.strictEqual(s.shops[0].identityPending, false, '非自动发现店不启用待核验（现行语义）');
  const p = await m.pollOnce('test');
  assert.strictEqual(controllers.get('shop-l').state.closeCalls.length, 1, '现行行为：正常值守动作');
});

test('手工配置店费用源账户不一致：既有 fail-closed 保持（AUTH 阻断、元数据不被覆盖）', async (t) => {
  const { m, controllers, cfgPath } = setup(t, {
    shops: [{ id: 'shop-m', name: '甲店', cookieFile: '甲店', enabled: true, accountId: 'ACC-M' }],
    costAccountId: 'ACC-WRONG', pageAccountId: 'ACC-M', controllerAccountId: 'ACC-M',
  });
  const p = await m.pollOnce('test');
  const r = (p.results || [])[0] || {};
  assert.strictEqual(r.status, 'stopped', '既有 guard AUTH 阻断');
  assert.strictEqual(r.code, 'AUTH');
  assert.strictEqual(controllers.get('shop-m').state.closeCalls.length, 0, '零动作');
  assert.strictEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).shops[0].accountId, 'ACC-M', '不覆盖既有元数据');
});

// ── 6. 删除店铺后仍不进值守、不建立身份 ────────────────────────────

test('删除店铺后仍不进入值守：轮询跳过、零动作、不做身份建立', async (t) => {
  const { m, controllers } = setup(t, { shops: [shop({ deleted: true, enabled: false })], costAccountId: 'ACC-1', pageAccountId: 'ACC-1' });
  assert.strictEqual(m._activeShops().length, 0, '不在活动范围');
  const p = await m.pollOnce('test');
  const r = (p.results || [])[0];
  assert.ok(!r || r.status === 'skipped', '轮询跳过');
  assert.strictEqual(controllers.get('shop-a').state.closeCalls.length, 0, '零动作');
  assert.strictEqual(m._findShop('shop-a').accountId, undefined, '不做身份建立');
});

// ── 7. 立即更新（只读）也能自动建立 ────────────────────────────────

test('立即更新（只读链路）：双锚一致时同样自动建立并解除待核验', async (t) => {
  const { m, cfgPath } = setup(t, { shops: [shop()], costAccountId: 'ACC-1', pageAccountId: 'ACC-1', controllerAccountId: 'ACC-1' });
  const r = await m.refreshShopData('shop-a');
  assert.strictEqual(r.ok, true, JSON.stringify(r).slice(0, 200));
  assert.strictEqual(r.readOnly, true, '立即更新保持只读');
  assert.strictEqual(m._findShop('shop-a').accountId, 'ACC-1', '元数据已建立');
  assert.strictEqual(m.getStatus().shops[0].identityPending, false, '待核验解除');
  assert.strictEqual(JSON.parse(fs.readFileSync(cfgPath, 'utf-8')).shops[0].accountId, 'ACC-1', '落盘');
});
