'use strict';

/**
 * 隔离测试：电商罗盘订单读取器的纯逻辑（指标消歧/日期口径/身份核验/数值解析）。
 * 页面胶水层（Playwright）由实机验证覆盖，见 HANDOFF.md。
 * 运行：npm test（node --test）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const {
  extractOrderMetric,
  pickValueFromCardText,
  verifyDateScopeFromUrl,
  matchShopIdentity,
} = require('../src/adapters/compass-order-reader');
const { parseIntegerCount } = require('../src/lib/money');
const { shanghaiMs, shanghaiDate } = require('../src/lib/time');

const NOW = shanghaiMs('2026-09-13', '09:20');

test('指标消歧：精确"成交订单数"唯一命中；不混用成交人数/件数/金额', () => {
  const r = extractOrderMetric([
    { label: '成交金额', valueText: '¥1,884.40' },
    { label: '成交订单数', valueText: '16' },
    { label: '商品曝光人数', valueText: '1.84万' },
    { label: '成交人数', valueText: '45' },
    { label: '今日成交订单数', valueText: '16' }, // 图例类不同名，不精确匹配
  ]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.valueText, '16');
});

test('指标消歧：找不到精确指标 → 明确原因（不得用相近指标替代）', () => {
  const r = extractOrderMetric([
    { label: '成交人数', valueText: '45' },
    { label: '今日成交订单数', valueText: '16' },
  ]);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /不使用成交人数|未找到/);
});

test('指标消歧：同名指标多处出现 → 按歧义阻止', () => {
  const r = extractOrderMetric([
    { label: '成交订单数', valueText: '16' },
    { label: '成交订单数', valueText: '14' },
  ]);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /歧义/);
});

test('卡片文本提取数值（真实页面证据格式）', () => {
  assert.strictEqual(pickValueFromCardText('成交订单数16昨日145同行基准114'), '16');
  assert.strictEqual(pickValueFromCardText('成交订单数 1,234 昨日145'), '1,234');
  assert.strictEqual(pickValueFromCardText('成交金额¥1,884.40'), null);
});

test('日期口径核验：date_type=1 且 date_value 为当天单日 → 通过', () => {
  const sec = String(Math.floor(shanghaiMs('2026-09-13', '00:00') / 1000));
  const url = `https://compass.jinritemai.com/shop?date_type=1&date_value=${sec}%2C${sec}&index_selected=pay_cnt`;
  const r = verifyDateScopeFromUrl(url, NOW);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.businessDate, '2026-09-13');
});

test('日期口径核验：非实时类型/昨日/缺参数/非法值 → 阻止', () => {
  const todaySec = String(Math.floor(shanghaiMs('2026-09-13', '00:00') / 1000));
  const yesterdaySec = String(Math.floor(shanghaiMs('2026-09-12', '00:00') / 1000));
  assert.strictEqual(verifyDateScopeFromUrl(`https://c.jinritemai.com/shop?date_type=2&date_value=${yesterdaySec}%2C${todaySec}`, NOW).ok, false, 'date_type 非 1');
  assert.strictEqual(verifyDateScopeFromUrl(`https://c.jinritemai.com/shop?date_type=1&date_value=${yesterdaySec}%2C${yesterdaySec}`, NOW).ok, false, '昨日单日');
  assert.strictEqual(verifyDateScopeFromUrl(`https://c.jinritemai.com/shop?date_type=1&date_value=${yesterdaySec}%2C${todaySec}`, NOW).ok, false, '跨日区间不是单日当天');
  assert.strictEqual(verifyDateScopeFromUrl('https://c.jinritemai.com/shop?date_type=1', NOW).ok, false, '缺 date_value');
  const bad = verifyDateScopeFromUrl(`https://c.jinritemai.com/shop?date_type=1&date_value=abc`, NOW);
  assert.strictEqual(bad.ok, false, '非法 date_value');
  assert.match(bad.reason, /不是当天|无法确认/);
});

test('身份核验：页面店铺名与配置精确相等；TODO 配置/不匹配 → 阻止', () => {
  assert.deepStrictEqual(matchShopIdentity('瑾漂亮潮流服饰', { name: '瑾漂亮潮流服饰' }), { ok: true, pageShopName: '瑾漂亮潮流服饰' });
  assert.strictEqual(matchShopIdentity('别的店铺', { name: '瑾漂亮潮流服饰' }).ok, false);
  assert.strictEqual(matchShopIdentity('瑾漂亮潮流服饰 ', { name: '瑾漂亮潮流服饰' }).ok, true, '首尾空白容忍');
  assert.strictEqual(matchShopIdentity('瑾漂亮潮流服饰', { name: '瑾漂亮潮流服饰有限' }).ok, false, '部分匹配不算');
  const todo = matchShopIdentity('瑾漂亮潮流服饰', { name: 'TODO_店铺名称_待配置' });
  assert.strictEqual(todo.ok, false);
  assert.match(todo.reason, /未配置店铺名称/);
  // compassShopName 优先于 name
  assert.strictEqual(matchShopIdentity('罗盘名', { name: '其他名', compassShopName: '罗盘名' }).ok, true);
});

test('订单数值解析：整数字符串合法；万级/小数/占位符按失败处理（fail-closed）', () => {
  assert.strictEqual(parseIntegerCount('16').count, 16);
  assert.strictEqual(parseIntegerCount('1,280').count, 1280);
  assert.strictEqual(parseIntegerCount('0').count, 0, '凌晨为 0 是合法读取值（交由零订单重读处理）');
  assert.strictEqual(parseIntegerCount('1.84万').ok, false, '万级展示值不能当订单数');
  assert.strictEqual(parseIntegerCount('16.5').ok, false);
  assert.strictEqual(parseIntegerCount('—').ok, false);
});

test('当天日期推导与 URL 时间戳换算一致（真实页面 date_value=1789228800 对应 2026-09-13）', () => {
  assert.strictEqual(new Date(1789228800 * 1000).toISOString(), '2026-09-12T16:00:00.000Z');
  assert.strictEqual(shanghaiDate(1789228800 * 1000), '2026-09-13');
});
