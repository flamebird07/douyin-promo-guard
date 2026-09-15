'use strict';

/**
 * 隔离测试：关闭流程 v2（mock 控制器，不访问真实页面）。
 * 关键回归（Codex 复核问题）：
 *   #2 回读不到广告不能证明已关闭 → 结果未知；
 *   #7 超时后底层请求延迟完成 → 不得发出重叠的新关闭请求；
 *   #6 停止信号 → 不发新请求。
 * 运行：npm test（node --test）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { closeOneAd } = require('../src/engine/close-flow');
const { CloseOutcomeUnknownError } = require('../src/lib/errors');
const { makeStatefulController, waitFor } = require('./helpers');

const SHOP = { id: 'shop-001', name: '测试店铺一', cookieFile: 'x', accountId: null };
const IDENTITY = { id: 'shop-001', name: '测试店铺一' };
const HIT = (adId, name) => ({ adId, name, reason: '全店触发：费用分 > 订单数×100 分' });
const OPTS = {
  realMode: true, maxRetries: 1, retryBackoffMs: 1,
  closeTimeoutMs: 200, readbackTimeoutMs: 200, readbackAttempts: 2, readbackIntervalMs: 1,
};

test('关闭成功：请求成功且回读确认已关闭', async () => {
  const controller = makeStatefulController({ identity: IDENTITY, ads: [{ adId: 'ad-1', name: 'A', status: '投放中' }] });
  const r = await closeOneAd({ controller, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-1', 'A'), opts: OPTS });
  assert.strictEqual(r.outcome, 'confirmed_closed');
  assert.strictEqual(r.beforeStatus, '投放中');
  assert.strictEqual(r.afterStatus, '已关闭');
});

test('关闭请求被拒：失败后有限重试，重试前重新做身份与对象复核', async () => {
  const controller = makeStatefulController({
    identity: IDENTITY,
    ads: [{ adId: 'ad-1', name: 'A', status: '投放中' }],
    failCloseFor: new Set(['ad-1']),
  });
  const r = await closeOneAd({ controller, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-1', 'A'), opts: OPTS });
  assert.strictEqual(r.outcome, 'failed');
  assert.strictEqual(r.attempts, 2);
  assert.strictEqual(controller.state.identityCalls, 2, '每次尝试都重新复核身份');
});

test('显式"结果未知"且回读确认已关闭 → confirmed（经回读核实）', async () => {
  const controller = makeStatefulController({
    identity: IDENTITY,
    ads: [{ adId: 'ad-1', name: 'A', status: '投放中' }],
    unknownFor: new Set(['ad-1']),
  });
  const r = await closeOneAd({ controller, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-1', 'A'), opts: OPTS });
  assert.strictEqual(r.outcome, 'confirmed_closed');
  assert.match(r.note, /回读确认/);
});

test('显式"结果未知"且回读仍是投放中 → 判定明确未生效并有限重试', async () => {
  const controller = makeStatefulController({
    identity: IDENTITY,
    ads: [{ adId: 'ad-1', name: 'A', status: '投放中' }],
    stuckFor: new Set(['ad-1']),
  });
  const r = await closeOneAd({ controller, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-1', 'A'), opts: OPTS });
  assert.strictEqual(r.outcome, 'failed');
  assert.match(r.error, /关闭未生效|关闭请求失败/);
  assert.strictEqual(r.attempts, 2);
});

test('回归 #2：回读不到广告不能证明已关闭 → 结果未知（不得 confirmed_closed）', async () => {
  const controller = makeStatefulController({ identity: IDENTITY, ads: [{ adId: 'ad-1', name: 'A', status: '投放中' }] });
  // 包装 getAd：关闭请求发出后回读一律"查无此广告"（模拟页面异常/被删除）
  const origGetAd = controller.getAd.bind(controller);
  let getAdCalls = 0;
  controller.getAd = async (p) => {
    getAdCalls += 1;
    if (getAdCalls > 1) return { found: false }; // 第一次是操作前复核，其后为回读
    return origGetAd(p);
  };
  const records = [];
  const r = await closeOneAd({ controller, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-1', 'A'), opts: OPTS, audit: (e) => records.push(e) });
  assert.strictEqual(r.outcome, 'unknown', '查无此广告 ≠ 已关闭');
  assert.match(r.error, /不能证明已关闭|结果未知/);
  assert.ok(records.some((e) => e.step === 'readback' && e.status === '(不存在)'));
});

test('回归 #2：回读全部失败 → 结果未知', async () => {
  const controller = makeStatefulController({ identity: IDENTITY, ads: [{ adId: 'ad-1', name: 'A', status: '投放中' }] });
  const origGetAd = controller.getAd.bind(controller);
  let getAdCalls = 0;
  controller.getAd = async (p) => {
    getAdCalls += 1;
    if (getAdCalls > 1) throw new Error('mock: 回读网络错误');
    return origGetAd(p);
  };
  const r = await closeOneAd({ controller, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-1', 'A'), opts: OPTS });
  assert.strictEqual(r.outcome, 'unknown');
  assert.match(r.error, /结果未知/);
});

test('回归 #7：超时后底层请求延迟完成 → 只发出一次关闭请求，不重叠重试（可控时序）', async () => {
  // 旧写法用 delayMsFor=260 与 closeTimeoutMs=200 的**真实计时差**区分分支：
  // 负载下回读可能落在延迟完成之后，走另一条 confirmed 文案（/延迟完成/ 断言随机失败）。
  // 现改为手工控制的延迟 Promise + 审计轨迹驱动解决时机，精确复现：
  //   超时分支 → 回读仍未关闭 → 在途请求落定 → 延迟后回读确认；
  // 各步以观察到的实际行为为界，不依赖任何狭窄计时差。
  const controller = makeStatefulController({
    identity: IDENTITY,
    ads: [{ adId: 'ad-1', name: 'A', status: '投放中' }],
  });
  let resolveClose;
  const closePromise = new Promise((res) => { resolveClose = res; });
  controller.closeAd = async (p) => {
    // 与 stateful 控制器同形的记账；不调用原实现——原实现会同步翻转广告状态，
    // 破坏「落定前回读必须仍在投放侧」的前提
    controller.state.closeCalls.push({ adId: p.adId, at: new Date().toISOString() });
    await closePromise;      // 请求挂起：任何时点都未落定（由测试显式放行）
    controller._testSetStatus('ad-1', '已关闭', false); // 落定后广告才进入关闭侧
  };
  const records = [];
  // 时序参数：closeTimeoutMs 只需>0（超时分支由审计确认，不靠等待时长）；
  // 500ms join 窗口仅为容纳负载下的调度延迟，与被验证行为无关。
  const TIMING = { ...OPTS, closeTimeoutMs: 500, readbackAttempts: 1, readbackIntervalMs: 1 };
  const flow = closeOneAd({ controller, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-1', 'A'), opts: TIMING, audit: (e) => records.push(e) });

  // ① 恰好发出一次关闭请求，随后超时分支落地（请求仍未落定、已登记在途）
  await waitFor(() => controller.state.closeCalls.length === 1, 2000, '关闭请求发出');
  await waitFor(() => records.some((e) => e.step === 'close-request' && e.unknown === true), 5000, '关闭请求超时分支');
  // ② 回读（延迟请求未完成）：广告仍在投放侧 → 此处不得确认关闭
  await waitFor(() => records.some((e) => e.step === 'readback' && e.ok === false && /尚未进入关闭侧/.test(e.note || '')), 5000, '落定前回读未关闭');
  assert.strictEqual(controller.state.closeCalls.length, 1, '回读期间绝不发出第二个关闭请求');
  // ③ 此时（且仅此时）让在途请求落定 → 流程必须「先等落定，再延迟回读」后才确认
  resolveClose();
  const r = await flow;
  assert.strictEqual(controller.state.closeCalls.length, 1, '绝不在旧请求仍在执行时发出第二个请求');
  assert.strictEqual(r.outcome, 'confirmed_closed', '延迟完成后经再次回读确认');
  assert.strictEqual(r.afterStatus, '已关闭', '确认依据是延迟落定后的回读状态');
  assert.match(r.note, /延迟完成/);
  assert.ok(records.some((e) => e.step === 'readback' && e.delayed === true && e.ok === true),
    '必须存在"延迟后回读"审计记录（确认发生在落定之后）');
});

test('在途请求登记：第二个调用加入既有请求，不重复发起', async () => {
  const controller = makeStatefulController({
    identity: IDENTITY,
    ads: [{ adId: 'ad-1', name: 'A', status: '投放中' }],
    delayMsFor: { 'ad-1': 80 },
  });
  const inflight = new Map();
  // 手工登记一个在途请求（模拟上一轮超时遗留）；在途键 = 类型|稳定ID
  const p = controller.closeAd({ adId: 'ad-1' });
  const entry = { promise: p, settled: false, outcome: null };
  p.then(() => { entry.settled = true; entry.outcome = { kind: 'ok' }; }, (e) => { entry.settled = true; entry.outcome = { kind: 'error', error: e }; });
  inflight.set('unknown|ad-1', entry);

  const r = await closeOneAd({ controller, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-1', 'A'), opts: OPTS, inflight });
  assert.strictEqual(controller.state.closeCalls.length, 1, '加入在途请求而不是发起新请求');
  assert.strictEqual(r.outcome, 'confirmed_closed');
});

test('停止信号：不发起新的关闭请求（outcome=skipped）', async () => {
  const controller = makeStatefulController({ identity: IDENTITY, ads: [{ adId: 'ad-1', name: 'A', status: '投放中' }] });
  const r = await closeOneAd({
    controller, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-1', 'A'), opts: OPTS,
    shouldAbortNewActions: () => true,
  });
  assert.strictEqual(r.outcome, 'skipped');
  assert.strictEqual(controller.state.closeCalls.length, 0);
  assert.strictEqual(r.note, 'stopped_before_request');
});

test('操作前身份复核不匹配：放弃且不发任何关闭请求', async () => {
  const controller = makeStatefulController({ identity: { id: 'shop-999', name: '别的店铺' }, ads: [{ adId: 'ad-1', name: 'A', status: '投放中' }] });
  const r = await closeOneAd({ controller, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-1', 'A'), opts: OPTS });
  assert.strictEqual(r.outcome, 'failed');
  assert.match(r.error, /身份复核/);
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('操作前对象不存在 / 状态异常：不操作', async () => {
  const c1 = makeStatefulController({ identity: IDENTITY, ads: [] });
  const r1 = await closeOneAd({ controller: c1, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-404', '不存在'), opts: OPTS });
  assert.strictEqual(r1.outcome, 'failed');
  assert.match(r1.error, /不存在/);
  assert.strictEqual(c1.state.closeCalls.length, 0);

  const c2 = makeStatefulController({ identity: IDENTITY, ads: [{ adId: 'ad-1', name: 'A', status: '审核中' }] });
  const r2 = await closeOneAd({ controller: c2, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-1', 'A'), opts: OPTS });
  assert.strictEqual(r2.outcome, 'failed');
  assert.match(r2.error, /不在可关闭状态/);
});

test('已关闭/已暂停：幂等跳过，不发关闭请求', async () => {
  const controller = makeStatefulController({ identity: IDENTITY, ads: [{ adId: 'ad-1', name: 'A', status: '已暂停' }] });
  const r = await closeOneAd({ controller, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-1', 'A'), opts: OPTS });
  assert.strictEqual(r.outcome, 'skipped');
  assert.strictEqual(controller.state.closeCalls.length, 0);
});

test('同名广告不同稳定 ID：各自独立关闭，互不影响', async () => {
  const controller = makeStatefulController({
    identity: IDENTITY,
    ads: [
      { adId: 'ad-1001', name: '同名广告', status: '投放中' },
      { adId: 'ad-1002', name: '同名广告', status: '投放中' },
    ],
  });
  const r1 = await closeOneAd({ controller, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-1001', '同名广告'), opts: OPTS });
  const r2 = await closeOneAd({ controller, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-1002', '同名广告'), opts: OPTS });
  assert.strictEqual(r1.outcome, 'confirmed_closed');
  assert.strictEqual(r2.outcome, 'confirmed_closed');
  assert.deepStrictEqual(controller.state.closeCalls.map((c) => c.adId).sort(), ['ad-1001', 'ad-1002']);
});

test('CloseOutcomeUnknownError 类型契约保持可用', () => {
  const e = new CloseOutcomeUnknownError('x');
  assert.ok(e instanceof Error);
  assert.strictEqual(e.code, 'CLOSE_UNKNOWN');
});

// ── 第五轮：统一参数契约与开关/运行状态分离语义 ──────────────────
test('close-flow 向控制器传递统一参数 {page, shopCfg, adId}（三处 getAd 调用一致）', async () => {
  const controller = makeStatefulController({ identity: IDENTITY, ads: [{ adId: 'ad-1', name: 'A', status: '已暂停' }] });
  const seen = [];
  const origGetAd = controller.getAd.bind(controller);
  controller.getAd = async (p) => { seen.push(p); return origGetAd(p); };
  const r = await closeOneAd({ controller, pageCtx: 'PAGE', shopCfg: SHOP, hit: HIT('ad-1', 'A'), opts: OPTS });
  assert.strictEqual(r.outcome, 'skipped', '已在关闭侧 → 跳过');
  assert.ok(seen.length >= 1);
  for (const p of seen) {
    assert.strictEqual(p.shopCfg, SHOP, 'shopCfg 必须传入（千川 getAd 需要 accountId）');
    assert.strictEqual(p.adId, 'ad-1');
    assert.strictEqual(p.page, 'PAGE');
  }
});

test('语义优先级：适配器 closableNow=true 优先于状态词（词表外也可按开关证据关闭）', async () => {
  const controller = makeStatefulController({ identity: IDENTITY, ads: [{ adId: 'ad-1', name: 'A', status: '神秘状态' }] });
  const origGetAd = controller.getAd.bind(controller);
  controller.getAd = async (p) => {
    const r = await origGetAd(p);
    // 适配器语义随底层状态变化：关闭后进入关闭侧
    return { ...r, closableNow: r.status !== '已关闭', alreadyClosedSide: r.status === '已关闭', switchChecked: r.status !== '已关闭' };
  };
  const r = await closeOneAd({ controller, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-1', 'A'), opts: OPTS });
  assert.strictEqual(r.outcome, 'confirmed_closed');
});

test('语义优先级：适配器 alreadyClosedSide=true 优先于状态词"投放中"（开关证据为准）', async () => {
  const controller = makeStatefulController({ identity: IDENTITY, ads: [{ adId: 'ad-1', name: 'A', status: '投放中' }] });
  const origGetAd = controller.getAd.bind(controller);
  controller.getAd = async (p) => {
    const r = await origGetAd(p);
    return { ...r, closableNow: false, alreadyClosedSide: true, switchChecked: false };
  };
  const r = await closeOneAd({ controller, pageCtx: null, shopCfg: SHOP, hit: HIT('ad-1', 'A'), opts: OPTS });
  assert.strictEqual(r.outcome, 'skipped', '开关未开启 = 已在关闭侧，即使状态词为投放中');
  assert.strictEqual(controller.state.closeCalls.length, 0);
});
