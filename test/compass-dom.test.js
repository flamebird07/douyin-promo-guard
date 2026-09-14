'use strict';

/**
 * DOM 回归测试：用真实浏览器加载基于实测结构构造的 fixture，
 * 运行生产提取函数 extractOrderValueInPage（与页面读取调用的是同一个函数）。
 *
 * 覆盖场景（Codex 第三/四轮指出的风险）：
 * - 正常读取当前值（不误取昨日/同行基准）
 * - 当前值节点缺失但昨日数字存在 → 阻止，不回退
 * - 加载中（空）/占位符/隐藏节点/万级展示 → 阻止
 * - uuid 缺失 / label 不匹配 → 阻止
 * - 售卖类型=全店 与 日期=实时 双口径状态读取
 *
 * 运行：npm test（需要本机 Edge，仅本地 fixture，无网络访问）
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { extractOrderValueInPage } = require('../src/adapters/compass-order-reader');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

/** 基于实测 DOM 证据（2026-09-13）构造经营概况指标卡 fixture。 */
function buildPage({ orderCard, tabsHtml }) {
  return `<!DOCTYPE html><html><body>
  <div class="page">
    <div class="section-header"><div>经营概况</div><div>AI帮我分析退款</div></div>
    ${tabsHtml || ''}
    <div class="aurora-data-card">
      ${orderCard}
    </div>
  </div>
  </body></html>`;
}

function buildCard({ uuid = 'pay_cnt', label = '成交订单数', withValue = true, valueText = '26', valueStyle = '', withYesterday = true }) {
  const title = `<div class="aurora-data-card-title"><div class="aurora-data-card-title-left"><div class="aurora-data-card-title-text aurora-data-card-title-text-checked aurora-data-card-title-text-tab"><span data-index-uuid="${uuid}" data-index-name=""><div style="display:inline-block;position:relative;cursor:pointer;">${label}</div></span></div></div></div>`;
  const value = withValue
    ? `<div class="aurora-data-card-data"><div class="aurora-data-card-data-left"><div class="aurora-data-card-data-content"><div class="aurora-data-card-value"><div class="aurora-data-card-value-core"><div class="aurora-data-card-value-main"${valueStyle ? ` style="${valueStyle}"` : ''}>${valueText}</div></div></div></div></div></div>`
    : '';
  const right = withYesterday ? '<div class="aurora-data-card-main-right"><div>昨日 145</div><div>同行基准 114</div></div>' : '';
  return `<div class="aurora-data-card-card-item"><div class="aurora-data-card-row-content"><div class="aurora-data-card-main-left">${title}${value}</div>${right}</div></div>`;
}

const TABS_BOTH_ACTIVE = `
<div class="aurora-tabs-row"><div class="aurora-tabs-tab aurora-tabs-tab-active"><div class="aurora-tabs-tab-btn"><span>实时</span></div></div><div class="aurora-tabs-tab"><div class="aurora-tabs-tab-btn"><span>近1天</span></div></div><div class="aurora-tabs-tab"><div class="aurora-tabs-tab-btn"><span>近7天</span></div></div></div>
<div class="aurora-tabs-row"><div class="aurora-tabs-tab aurora-tabs-tab-active"><div class="aurora-tabs-tab-btn"><span>全店</span></div></div><div class="aurora-tabs-tab"><div class="aurora-tabs-tab-btn"><span>自营</span></div></div><div class="aurora-tabs-tab"><div class="aurora-tabs-tab-btn"><span>合作</span></div></div></div>`;

const TABS_SALE_NOT_ALL = `
<div class="aurora-tabs-row"><div class="aurora-tabs-tab aurora-tabs-tab-active"><div class="aurora-tabs-tab-btn"><span>实时</span></div></div><div class="aurora-tabs-tab"><div class="aurora-tabs-tab-btn"><span>近1天</span></div></div></div>
<div class="aurora-tabs-row"><div class="aurora-tabs-tab"><div class="aurora-tabs-tab-btn"><span>全店</span></div></div><div class="aurora-tabs-tab aurora-tabs-tab-active"><div class="aurora-tabs-tab-btn"><span>自营</span></div></div><div class="aurora-tabs-tab"><div class="aurora-tabs-tab-btn"><span>合作</span></div></div></div>`;

let browser;
let page;

before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1200,800'] });
  page = await browser.newPage();
});

after(async () => {
  await browser.close().catch(() => {});
});

const PROBE_ARGS = { uuid: 'pay_cnt', label: '成交订单数', overview: '经营概况' };

async function probe(html) {
  await page.setContent(html, { waitUntil: 'load' });
  return page.evaluate(extractOrderValueInPage, PROBE_ARGS);
}

test('正常：锁定当前值节点（26），不误取昨日145/同行基准114，双口径选中', async () => {
  const r = await probe(buildPage({ orderCard: buildCard({ valueText: '26' }), tabsHtml: TABS_BOTH_ACTIVE }));
  assert.strictEqual(r.code, 'ok');
  assert.strictEqual(r.valueText, '26', '必须是当前值，不是昨日 145');
  assert.strictEqual(r.saleScope.realtimeActive, true);
  assert.strictEqual(r.saleScope.saleAllActive, true);
});

test('回归：当前值节点缺失但昨日数字存在 → 阻止，不回退读取 145', async () => {
  const r = await probe(buildPage({ orderCard: buildCard({ withValue: false, withYesterday: true }), tabsHtml: TABS_BOTH_ACTIVE }));
  assert.strictEqual(r.code, 'value_node_missing');
  assert.strictEqual(r.hasYesterday, true, '场景确认：昨日数字确实存在于卡片中');
  assert.strictEqual(r.valueText, undefined, '绝不返回昨日值');
});

test('回归：加载中（当前值节点为空）→ value_loading 阻止', async () => {
  const r = await probe(buildPage({ orderCard: buildCard({ valueText: '' }), tabsHtml: TABS_BOTH_ACTIVE }));
  assert.strictEqual(r.code, 'value_loading');
  assert.strictEqual(r.valueText, undefined);
});

test('回归：占位符（—）→ value_placeholder 阻止', async () => {
  const r = await probe(buildPage({ orderCard: buildCard({ valueText: '—' }), tabsHtml: TABS_BOTH_ACTIVE }));
  assert.strictEqual(r.code, 'value_placeholder');
});

test('回归：当前值节点隐藏（display:none）→ value_hidden 阻止', async () => {
  const r = await probe(buildPage({ orderCard: buildCard({ valueText: '26', valueStyle: 'display:none' }), tabsHtml: TABS_BOTH_ACTIVE }));
  assert.strictEqual(r.code, 'value_hidden');
});

test('回归：万级展示值（1.84万）→ value_not_plain_number 阻止（不用于订单数）', async () => {
  const r = await probe(buildPage({ orderCard: buildCard({ valueText: '1.84万' }), tabsHtml: TABS_BOTH_ACTIVE }));
  assert.strictEqual(r.code, 'value_not_plain_number');
});

test('回归：uuid 节点缺失 → no_uuid_element 阻止', async () => {
  const html = buildPage({ orderCard: buildCard({ uuid: 'other_uuid' }), tabsHtml: TABS_BOTH_ACTIVE });
  const r = await probe(html);
  assert.strictEqual(r.code, 'no_uuid_element');
});

test('回归：uuid 节点存在但标签文本不符 → label_mismatch 阻止', async () => {
  const r = await probe(buildPage({ orderCard: buildCard({ label: '成交金额' }), tabsHtml: TABS_BOTH_ACTIVE }));
  assert.strictEqual(r.code, 'label_mismatch');
});

test('口径：实时选中但售卖类型为"自营" → 提取返回状态，读取器据此阻止（saleAllActive=false）', async () => {
  const r = await probe(buildPage({ orderCard: buildCard({ valueText: '17' }), tabsHtml: TABS_SALE_NOT_ALL }));
  assert.strictEqual(r.code, 'ok');
  assert.strictEqual(r.saleScope.realtimeActive, true);
  assert.strictEqual(r.saleScope.saleAllActive, false, '全店未选中必须暴露给读取器');
});

test('口径：页面无 tabs（未渲染）→ 两个口径均为未确认', async () => {
  const r = await probe(buildPage({ orderCard: buildCard({ valueText: '17' }), tabsHtml: '' }));
  assert.strictEqual(r.code, 'ok');
  assert.strictEqual(r.saleScope.realtimeActive, false);
  assert.strictEqual(r.saleScope.saleAllActive, false);
});

test('更新时间归属：经营概况容器内的时间戳才被采集', async () => {
  const html = buildPage({ orderCard: buildCard({ valueText: '17' }), tabsHtml: TABS_BOTH_ACTIVE })
    .replace('<div class="section-header"><div>经营概况</div><div>AI帮我分析退款</div></div>',
      '<div class="section-header"><div>经营概况</div><div>AI帮我分析退款</div><span>2026/09/13 10:01:02</span></div>');
  const r = await probe(html);
  assert.strictEqual(r.code, 'ok');
  assert.strictEqual(r.overviewTimestamp, '2026/09/13 10:01:02');
});

test('更新时间归属：容器内无时间戳 → null（不用其他区块时间戳冒充）', async () => {
  const r = await probe(buildPage({ orderCard: buildCard({ valueText: '17' }), tabsHtml: TABS_BOTH_ACTIVE })
    .replace('</body>', '<div class="other-block">看流量 2026/09/13 09:39:29</div></body>'));
  assert.strictEqual(r.code, 'ok');
  assert.strictEqual(r.overviewTimestamp, null, '其他区块的时间戳不得采集');
});
