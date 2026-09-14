'use strict';

/**
 * DOM 回归测试：千川计划列表行收集（生产函数 collectQianchuanRowsInPage，
 * 与页面读取调用的是同一个函数，通过 Playwright setContent 加载实测结构 fixture）。
 * 覆盖：表头/汇总行排除、开关选中态、行内计划ID、同名计划各自独立（不按名称合并）、total 提取。
 * 运行：npm test
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { collectQianchuanRowsInPage } = require('../src/adapters/qianchuan-reader');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

function row({ name, checked = false, inlineId = null, extraText = '' }) {
  if (inlineId) extraText = `ID:${inlineId} 已终止 ${extraText}`;
  const swCls = checked ? 'oc-switch oc-switch--checked oc-switch--dark' : 'oc-switch oc-switch--dark';
  return `<tr class="ovui-tr">
    <td><div class="oc-typography-value-int">${name}</div><span>${extraText}</span></td>
    <td><div class="${swCls}"><div class="ovui-switch__thumb"></div></div></td>
  </tr>`;
}

function buildPageHtml({ rows, total = null, withHeader = true, withSummary = false }) {
  const header = withHeader
    ? '<tr class="ovui-tr"><td>抖音号</td><td>投放状态</td><td>投放设置</td></tr>'
    : '';
  const summary = withSummary
    ? '<tr class="ovui-tr ovui-t-summary"><td>共 N 个抖音号</td></tr>'
    : '';
  return `<!DOCTYPE html><html><body>
  <table>
    ${header}
    ${rows.map(row).join('')}
    ${summary}
  </table>
  ${total ? `<div class="pager">共 ${total} 条记录</div>` : ''}
  </body></html>`;
}

let browser;
let page;

before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1200,800'] });
  page = await browser.newPage();
});

after(async () => {
  await browser.close().catch(() => {});
});

async function collect(html) {
  await page.setContent(html, { waitUntil: 'load' });
  return page.evaluate(collectQianchuanRowsInPage);
}

test('正常：全域行（无行内ID）+ 标准行（行内ID）+ 开关状态，表头/汇总行被排除', async () => {
  const r = await collect(buildPageHtml({
    total: 3,
    rows: [
      { name: '瑾漂亮私服', checked: false, extraText: '已暂停 系统暂停未有效投放 0.00' },
      { name: '2024-10-23_托管_【上传YLB3】9833_R3 日常销售托管', checked: true, inlineId: '1813702913164419', extraText: 'ID:1813702913164419 已终止' },
      { name: '芦淞区瑾漂亮服饰商行', checked: false, extraText: '已暂停 0.00' },
    ],
  }));
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.rows.length, 3, '表头行（无开关）与汇总行都被排除');
  assert.strictEqual(r.rows[0].name, '瑾漂亮私服');
  assert.strictEqual(r.rows[0].switchChecked, false);
  assert.strictEqual(r.rows[1].switchChecked, true);
  assert.strictEqual(r.rows[1].rowText.includes('ID:1813702913164419'), true, '标准行行内含计划ID');
  assert.deepStrictEqual(r.rows.map((x) => x.rowIndex), [0, 1, 2], '行索引连续，支持行定位');
});

test('回归：同名计划各自独立成行（不按名称合并），跨行 rowIndex 唯一', async () => {
  const r = await collect(buildPageHtml({
    rows: [
      { name: '同名计划', checked: true, extraText: 'ID:1813702913164419' },
      { name: '同名计划', checked: false, extraText: 'ID:1813702884025450' },
    ],
  }));
  assert.strictEqual(r.rows.length, 2, '同名两行都保留');
  assert.deepStrictEqual(r.rows.map((x) => x.rowIndex), [0, 1]);
  assert.notStrictEqual(r.rows[0].rowText, r.rows[1].rowText, '行文本不同（ID 不同），绑定各自稳定 ID');
});

test('回归：开关选中态精确读取（checked 类）', async () => {
  const r = await collect(buildPageHtml({
    rows: [
      { name: '开启计划', checked: true },
      { name: '关闭计划', checked: false },
    ],
  }));
  assert.strictEqual(r.rows[0].switchChecked, true);
  assert.strictEqual(r.rows[1].switchChecked, false);
});

test('total 提取：缺失时不虚构（total=null，完整性由上层对账）', async () => {
  const r = await collect(buildPageHtml({ rows: [{ name: 'A', checked: true }], total: null }));
  assert.strictEqual(r.total, null);
});

test('跨页场景：不同页内容独立收集（模拟翻页后的第二页 DOM）', async () => {
  const page1 = await collect(buildPageHtml({
    total: 157,
    rows: [{ name: '同名计划', checked: true, inlineId: '1813702913164419' }],
  }));
  const page2 = await collect(buildPageHtml({
    total: 157,
    rows: [{ name: '同名计划', checked: false, inlineId: '1813702884025450' }],
  }));
  // 跨页同名：行内 ID 不同 → 是不同计划，不得按名称合并
  assert.strictEqual(page1.rows[0].rowText.includes('1813702913164419'), true);
  assert.strictEqual(page2.rows[0].rowText.includes('1813702884025450'), true);
  assert.strictEqual(page1.total, 157);
  assert.strictEqual(page2.total, 157);
});
