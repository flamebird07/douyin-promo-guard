'use strict';

/**
 * 隔离测试：全店规则判定 与 数据守卫（逐源身份/日期/时效）。
 * 运行：npm test（node --test）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { evaluateWholeShopCostPerOrder, perOrderDisplayText } = require('../src/engine/rules');
const guard = require('../src/engine/guard');
const { loadConfig } = require('../src/config');
const { DataGuardError, AuthError } = require('../src/lib/errors');
const { shanghaiMs, shanghaiDate } = require('../src/lib/time');

const SHOP = { id: 'shop-001', name: '测试店铺一', cookieFile: 'x', accountId: null };

// ── 全店规则（用户规则：费用分 > 订单数×100，恰好相等不关）─────────
test('规则边界：100 元 / 100 单 = 恰好 1 元/单 → 不关闭', () => {
  const r = evaluateWholeShopCostPerOrder({ costCents: 10000, orders: 100, thresholdCents: 100 });
  assert.strictEqual(r.over, false, '恰好相等不关闭');
});

test('规则边界：100.01 元 / 100 单 → 关闭全部目标广告', () => {
  const r = evaluateWholeShopCostPerOrder({ costCents: 10001, orders: 100, thresholdCents: 100 });
  assert.strictEqual(r.over, true, '整数分 10001 > 100×100=10000');
});

test('规则边界：禁止四舍五入每单成本（0.99 元/单不得因舍入误判）', () => {
  // 99 元 / 100 单 = 0.99 元/单，四舍五入到 1 元会误判"等于阈值"
  const r = evaluateWholeShopCostPerOrder({ costCents: 9900, orders: 100, thresholdCents: 100 });
  assert.strictEqual(r.over, false);
});

test('规则：费用为 0 永不触发；订单为 0 阻止关闭', () => {
  const zero = evaluateWholeShopCostPerOrder({ costCents: 0, orders: 50, thresholdCents: 100 });
  assert.strictEqual(zero.over, false);
  const blocked = evaluateWholeShopCostPerOrder({ costCents: 5000, orders: 0, thresholdCents: 100 });
  assert.strictEqual(blocked.over, false);
  assert.strictEqual(blocked.blocked, 'zero_orders');
  assert.match(blocked.reason, /阻止|异常/);
});

test('规则：非法输入必须抛错而不是当 0', () => {
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: null, orders: 10, thresholdCents: 100 }), DataGuardError);
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: 12.5, orders: 10, thresholdCents: 100 }), DataGuardError);
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: 100, orders: 10.5, thresholdCents: 100 }), DataGuardError);
  assert.throws(() => evaluateWholeShopCostPerOrder({ costCents: 100, orders: 10, thresholdCents: 0 }), DataGuardError);
});

test('每单成本展示文本标注仅展示用途', () => {
  const t = perOrderDisplayText(10001, 100);
  assert.match(t, /1\.0001/);
  assert.match(t, /整数运算/);
});

// ── Summary 守卫 ─────────────────────────────────────────────────
const costSummary = (over = {}) => ({
  source: 'promo-page', kind: 'cost', shopId: 'shop-001',
  businessDate: shanghaiDate(shanghaiMs('2026-09-12', '09:00')),
  fetchedAt: new Date(shanghaiMs('2026-09-12', '09:00')).toISOString(),
  valueCents: 10001, ...over,
});
const orderSummary = (over = {}) => ({
  source: 'promo-page', kind: 'orders', shopId: 'shop-001',
  businessDate: shanghaiDate(shanghaiMs('2026-09-12', '09:00')),
  fetchedAt: new Date(shanghaiMs('2026-09-12', '09:00')).toISOString(),
  valueCount: 100, ...over,
});
const NOW = shanghaiMs('2026-09-12', '09:10');

test('Summary 结构：缺 shopId/日期/抓取时间/解析错误/非法值都必须拒绝', () => {
  assert.throws(() => guard.validateSummaryShape({ ...costSummary(), shopId: undefined }, '全店推广费用'), DataGuardError);
  assert.throws(() => guard.validateSummaryShape({ ...costSummary(), businessDate: '2026-9-12' }, '全店推广费用'), DataGuardError);
  assert.throws(() => guard.validateSummaryShape({ ...costSummary(), fetchedAt: 'not-a-date' }, '全店推广费用'), DataGuardError);
  assert.throws(() => guard.validateSummaryShape({ ...costSummary(), parseError: '金额为占位符: —' }, '全店推广费用'), DataGuardError);
  assert.throws(() => guard.validateSummaryShape({ ...costSummary(), valueCents: null }, '全店推广费用'), DataGuardError);
  assert.throws(() => guard.validateSummaryShape({ ...orderSummary(), valueCount: 12.5 }, '全店订单数'), DataGuardError);
  assert.throws(() => guard.validateSummaryShape({ ...orderSummary(), valueCount: -1 }, '全店订单数'), DataGuardError);
  assert.doesNotThrow(() => guard.validateSummaryShape(costSummary(), '全店推广费用'));
});

test('逐源身份核验：WRONG_SHOP 快照必须被拒绝（Codex 复核问题 #3 回归）', () => {
  assert.throws(() => guard.checkSourceIdentity(costSummary({ shopId: 'WRONG_SHOP' }), SHOP, '全店推广费用'), AuthError);
  assert.throws(() => guard.checkSourceIdentity(orderSummary({ shopId: 'shop-0011' }), SHOP, '全店订单数'), AuthError, '仅差一字符也不行');
  assert.doesNotThrow(() => guard.checkSourceIdentity(costSummary(), SHOP, '全店推广费用'));
});

test('逐源身份核验：配置了广告账户 ID 时账户映射必须一致', () => {
  const shopAcc = { ...SHOP, accountId: 'acc-1' };
  assert.doesNotThrow(() => guard.checkSourceIdentity(costSummary({ accountId: 'acc-1' }), shopAcc, '全店推广费用'));
  assert.throws(() => guard.checkSourceIdentity(costSummary({ accountId: 'acc-2' }), shopAcc, '全店推广费用'), AuthError);
  assert.throws(() => guard.checkSourceIdentity(costSummary({ accountId: null }), shopAcc, '全店推广费用'), AuthError);
});

test('业务日期必须是当天（上海）—— 跨日数据不用于关闭决策', () => {
  assert.throws(() => guard.checkBusinessDateToday(costSummary({ businessDate: '2026-09-11' }), '全店推广费用', NOW), DataGuardError);
  assert.doesNotThrow(() => guard.checkBusinessDateToday(costSummary(), '全店推广费用', NOW));
});

test('时效：抓取超龄拒绝；未来时间戳拒绝', () => {
  assert.throws(() => guard.checkFreshness(new Date(NOW - 120 * 60000).toISOString(), 30, NOW, '全店推广费用'), DataGuardError);
  assert.throws(() => guard.checkFreshness(new Date(NOW + 60 * 60000).toISOString(), 30, NOW, '全店推广费用'), DataGuardError);
  assert.doesNotThrow(() => guard.checkFreshness(new Date(NOW - 5 * 60000).toISOString(), 30, NOW, '全店推广费用'));
});

test('费用与订单必须同店铺、同业务日期', () => {
  assert.doesNotThrow(() => guard.checkSameShopAndDate(costSummary(), orderSummary()));
  assert.throws(() => guard.checkSameShopAndDate(costSummary({ shopId: 'shop-999' }), orderSummary()), DataGuardError);
  assert.throws(() => guard.checkSameShopAndDate(costSummary(), orderSummary({ businessDate: '2026-09-11' })), DataGuardError);
});

test('广告控制页身份核验：不匹配/未读取都拒绝', () => {
  assert.doesNotThrow(() => guard.checkControllerIdentity({ ok: true, pageShopId: 'shop-001', pageShopName: '测试店铺一' }, SHOP));
  assert.throws(() => guard.checkControllerIdentity({ ok: true, pageShopId: 'shop-999' }, SHOP), AuthError);
  assert.throws(() => guard.checkControllerIdentity({ ok: false, reason: '身份校验未接入' }, SHOP), AuthError);
  assert.throws(() => guard.checkControllerIdentity(null, SHOP), AuthError);
});

test('广告清单分页核验：未读完（hasNext=true）必须拒绝；逐页身份核验', () => {
  const mkPage = (pageNo, ads, hasNext, over = {}) => ({
    source: 'promo-page', shopId: 'shop-001', businessDate: shanghaiDate(NOW),
    fetchedAt: new Date(NOW - 60000).toISOString(), pageNo, hasNext, ads, ...over,
  });
  const ad = (id) => ({ adId: id, name: 'A' + id, status: '投放中' });
  // 未读完
  assert.throws(
    () => guard.collectInventoryPages([mkPage(1, [ad('a1'), ad('a2')], true)], SHOP, NOW, 30, false),
    DataGuardError,
    '仍有下一页时不能宣称全店'
  );
  // 某页身份不对
  assert.throws(
    () => guard.collectInventoryPages(
      [mkPage(1, [ad('a1')], false), { ...mkPage(2, [ad('a2')], false), shopId: 'WRONG_SHOP' }],
      SHOP, NOW, 30, false
    ),
    AuthError
  );
  // 缺稳定 ID
  assert.throws(
    () => guard.collectInventoryPages([mkPage(1, [{ name: 'no-id', status: '投放中' }], false)], SHOP, NOW, 30, false),
    DataGuardError
  );
  // 正常多页
  const r = guard.collectInventoryPages(
    [mkPage(1, [ad('a1'), ad('a2')], false), mkPage(2, [ad('a3')], false)],
    SHOP, NOW, 30, false
  );
  assert.strictEqual(r.pages, 2);
  assert.deepStrictEqual(r.ads.map((a) => a.adId), ['a1', 'a2', 'a3']);
});

test('分页契约严格化：hasNext 缺失/null/字符串都不能当作清单结束（第三轮验收问题 2）', () => {
  const mkPage = (pageNo, ads, hasNext) => ({
    source: 'promo-page', shopId: 'shop-001', businessDate: shanghaiDate(NOW),
    fetchedAt: new Date(NOW - 60000).toISOString(), pageNo, hasNext, ads,
  });
  const ad = (id) => ({ adId: id, name: 'A', status: '投放中' });
  // 末页缺失 hasNext（当前值为 undefined）→ 契约非法，不得当完整
  assert.throws(
    () => guard.collectInventoryPages([mkPage(1, [ad('a1')], undefined)], SHOP, NOW, 30, false),
    /hasNext 缺失|hasNext.*布尔/,
    '缺失 hasNext 被静默认定为完整 — 已修复'
  );
  assert.throws(
    () => guard.collectInventoryPages([mkPage(1, [ad('a1')], null)], SHOP, NOW, 30, false),
    DataGuardError,
    'null 不能当结束'
  );
  assert.throws(
    () => guard.collectInventoryPages([mkPage(1, [ad('a1')], 'false')], SHOP, NOW, 30, false),
    DataGuardError,
    '字符串 "false" 不能当结束'
  );
  // 只有显式 boolean false 才通过
  assert.doesNotThrow(() => guard.collectInventoryPages([mkPage(1, [ad('a1')], false)], SHOP, NOW, 30, false));
});

test('分页契约严格化：重复页码、循环游标、跨页重复广告 ID 必须拒绝', () => {
  const mkPage = (pageNo, ads, hasNext, over = {}) => ({
    source: 'promo-page', shopId: 'shop-001', businessDate: shanghaiDate(NOW),
    fetchedAt: new Date(NOW - 60000).toISOString(), pageNo, hasNext, ads, ...over,
  });
  const ad = (id) => ({ adId: id, name: 'A', status: '投放中' });
  // 页码重复/乱序
  assert.throws(
    () => guard.collectInventoryPages(
      [mkPage(1, [ad('a1')], true, { pageToken: 't1' }), mkPage(1, [ad('a2')], false, { pageToken: 't2' })],
      SHOP, NOW, 30, false
    ),
    /页码契约非法/,
    '重复页码未检出 — 已修复'
  );
  // 游标循环
  assert.throws(
    () => guard.collectInventoryPages(
      [mkPage(1, [ad('a1')], true, { pageToken: 'same' }), mkPage(2, [ad('a2')], false, { pageToken: 'same' })],
      SHOP, NOW, 30, false
    ),
    /游标循环/,
    '循环游标未检出 — 已修复'
  );
  // 同一广告 ID 跨页重复
  assert.throws(
    () => guard.collectInventoryPages(
      [mkPage(1, [ad('a1'), ad('a2')], true, { pageToken: 't1' }), mkPage(2, [ad('a2')], false, { pageToken: 't2' })],
      SHOP, NOW, 30, false
    ),
    /跨页重复/,
    '重复广告 ID 未检出 — 已修复'
  );
});

test('分页核验：真实模式下清单来源也必须校验（mock 来源拒绝）', () => {
  const mkPage = (pageNo, ads, hasNext, source) => ({
    source, shopId: 'shop-001', businessDate: shanghaiDate(NOW),
    fetchedAt: new Date(NOW - 60000).toISOString(), pageNo, hasNext, ads,
  });
  const ad = (id) => ({ adId: id, name: 'A', status: '投放中' });
  assert.throws(
    () => guard.collectInventoryPages([mkPage(1, [ad('a1')], false, 'mock')], SHOP, NOW, 30, true),
    DataGuardError,
    '真实模式下 mock 清单来源未被拒绝 — 已修复'
  );
  assert.doesNotThrow(() => guard.collectInventoryPages([mkPage(1, [ad('a1')], false, 'promo-page')], SHOP, NOW, 30, true));
});

test('真实模式禁止 mock 来源', () => {
  assert.throws(() => guard.checkSourceAllowed('mock', true), DataGuardError);
  assert.doesNotThrow(() => guard.checkSourceAllowed('mock', false));
  assert.doesNotThrow(() => guard.checkSourceAllowed('promo-page', true));
});

// ── 配置校验 ─────────────────────────────────────────────────────
test('首版配置（示例=正式）：店铺已确定，规则已落实，配置齐备且演练模式', () => {
  const path = require('path');
  const { loadConfigFrom } = require('../src/config');
  const cfg = loadConfigFrom(path.join(__dirname, '..', 'config', 'config.example.json')); // 锁定示例文件，不受 config.json 是否存在影响
  assert.strictEqual(cfg.ready, true, '用户已确认店铺与入口，示例即首版正式配置');
  const shop = cfg.config.shops[0];
  assert.strictEqual(shop.name, '瑾漂亮潮流服饰', '首版店铺（用户确认）');
  assert.strictEqual(shop.accountId, '1710242295996424', '千川账户ID（页面实测）');
  assert.strictEqual(shop.cookieFile, '瑾漂亮潮流服饰');
  assert.strictEqual(cfg.config.monitor.orderDataSource, 'compass');
  assert.strictEqual(cfg.config.monitor.costDataSource, 'qianchuan');
  assert.strictEqual(cfg.config.monitor.adListDataSource, 'qianchuan');
  const r = cfg.config.rules[0];
  assert.strictEqual(r.type, 'wholeShopCostPerOrder');
  assert.strictEqual(r.thresholdCents, 100, '用户规则 1 元/单');
  assert.strictEqual(r.comparator, '>', '恰好相等不关闭');
  assert.strictEqual(cfg.config.schedule.dailyStartHour, 8, '每天 08:00 后');
  assert.strictEqual(cfg.config.schedule.intervalMinutes, 30, '每半小时巡查');
  assert.strictEqual(cfg.config.execution.realMode, false, '真实执行默认关闭');
  assert.deepStrictEqual(cfg.pending, [], '首版配置齐备，无待配置项（入口已由用户确认，无需深层网址）');
});

test('配置校验：非法数值必须进 pending 禁止启动', () => {
  // 通过 loadRaw 之外的路径不易注入；这里直接验证 collectPending 逻辑的入参面
  const { intInRange } = require('../src/config');
  assert.ok(intInRange(0, 1, 100000000, 'x'));
  assert.ok(intInRange(1.5, 1, 10, 'x'));
  assert.ok(intInRange('30', 1, 1440, 'x'));
  assert.ok(intInRange(1441, 1, 1440, 'x'));
  assert.strictEqual(intInRange(30, 1, 1440, 'x'), null);
});
