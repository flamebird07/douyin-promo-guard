'use strict';

/**
 * 乘方 DOM 原语测试：用生产定位/提取逻辑（src/adapters/chengfang-reader.js 的
 * evaluate 侧函数）加载本地 DOM fixture（Playwright setContent），覆盖：
 * - "开启/暂停/删除"同时存在时只选中目标动作（暂停）；删除/开启绝不返回可点击对象
 * - 暂停按钮缺失/多候选/无标记 → 零点击（ok:false）
 * - 删除确认弹窗绝不确认（识别为 delete_confirm）
 * - 行收集：内层开关选中态穿透、稳定ID解析、表头/汇总排除、总数提取
 * - 分页信息、翻页、表头全选、选中行读取、行复选框校正、行内开关严格点击
 * 运行：npm test
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { buildChengfangFixtureHtml } = require('./chengfang-fixture');
const {
  collectChengfangRowsInPage,
  collectChengfangPaginationInPage,
  findChengfangBatchPauseButtonInPage,
  detectChengfangDangerDialogInPage,
  clickChengfangHeaderSelectAllInPage,
  readSelectedChengfangRowIdsInPage,
  clickChengfangRowSwitchByPlanId,
  setChengfangRowCheckboxByPlanId,
  clickChengfangNextPageInPage,
  readChengfangBatchBarInPage,
} = require('../src/adapters/chengfang-reader');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let browser;
let page;

before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1200,800'] });
  page = await browser.newPage();
});

after(async () => {
  await browser.close().catch(() => {});
});

const TUOGUAN_PLAN = { id: '184388555253250562', name: '全店托管 2025-09-21_商品全店托管', checked: true };
const ZIXUAN_PLANS = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `1875859981405339${String(i).padStart(3, '0')}`, name: `千川乘方_计划${i}`, checked: true }));

async function load(opts) {
  await page.setContent(buildChengfangFixtureHtml(opts), { waitUntil: 'load' });
}

// ── 防误删：批量操作栏按钮精确定位 ───────────────────────────────────

test('开启/暂停/删除 同时存在：只定位"暂停"，绝不返回删除/开启', async () => {
  await load({ plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': [] } });
  // 勾选一行使批量栏可见（模拟平台勾选状态后重渲染）
  await page.evaluate(() => { window.__CF.selected = ['184388555253250562']; window.render(); });
  const bar = await page.evaluate(readChengfangBatchBarInPage);
  assert.strictEqual(bar.visible, true);
  // DOM 顺序断言（fixture 结构：开启/暂停/删除），不排序避免中文码点排序歧义
  assert.deepStrictEqual(bar.buttons.map((b) => b.text), ['开启', '暂停', '删除']);
  const pause = await page.evaluate(findChengfangBatchPauseButtonInPage);
  assert.strictEqual(pause.ok, true);
  assert.match(pause.autoId, /btn-pause$/);
  assert.notStrictEqual(pause.autoId, undefined);
});

test('批量"暂停"按钮缺失：ok=false（删除/开启不得被误选为暂停）', async () => {
  await load({
    plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': [] },
    batchButtons: { pause: '' },
  });
  await page.evaluate(() => { document.getElementById('batchbar').style.display = 'flex'; });
  const r = await page.evaluate(findChengfangBatchPauseButtonInPage);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /未找到"暂停"/);
});

test('批量"暂停"存在多个候选：ok=false，拒绝点击', async () => {
  await load({
    plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': [] },
    batchButtons: {
      pause: '<button data-auto-id="bar-groups-group-item-btn-pause">暂停</button><button data-e2e="batch_pause">暂停</button>',
    },
  });
  await page.evaluate(() => { document.getElementById('batchbar').style.display = 'flex'; });
  const r = await page.evaluate(findChengfangBatchPauseButtonInPage);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /出现 \d+ 个"暂停"候选/);
});

test('唯一"暂停"无识别标记（纯文本）：ok=false（禁止模糊文本兜底）', async () => {
  await load({
    plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': [] },
    batchButtons: { pause: '<button>暂停</button>' },
  });
  await page.evaluate(() => { document.getElementById('batchbar').style.display = 'flex'; });
  const r = await page.evaluate(findChengfangBatchPauseButtonInPage);
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /禁止模糊文本兜底/);
});

test('删除确认弹窗：检测为 delete_confirm（绝不确认）', async () => {
  await load({
    plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': [] },
    dialog: '<div role="dialog" style="position:fixed;top:0;left:0;width:400px;height:200px"><span>确认删除该计划？删除后不可恢复</span><button>确定</button></div>',
  });
  const d = await page.evaluate(detectChengfangDangerDialogInPage);
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].kind, 'delete_confirm');
});

test('非预期确认弹窗（无"删除"字样）：检测为 unexpected_confirm', async () => {
  await load({
    plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': [] },
    dialog: '<div role="dialog" style="position:fixed;top:0;left:0;width:400px;height:200px"><span>确认执行操作？</span><button>确定</button></div>',
  });
  const d = await page.evaluate(detectChengfangDangerDialogInPage);
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].kind, 'unexpected_confirm');
});

// ── 行收集 ──────────────────────────────────────────────────────────

test('行收集：内层开关选中态穿透、稳定ID解析、表头排除', async () => {
  const plans = ZIXUAN_PLANS(3);
  await load({
    plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': plans },
    state: { view: '商品自选' },
  });
  const r = await page.evaluate(collectChengfangRowsInPage);
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.rows.length, 3, '表头行被排除');
  const ids = r.rows.map((row) => row.id).sort();
  assert.deepStrictEqual(ids, plans.map((p) => p.id).sort(), '稳定ID从行文本解析');
  for (const row of r.rows) {
    assert.strictEqual(row.switchChecked, true, '内层 .ovui-switch--checked 穿透检测');
    assert.strictEqual(row.idError, null);
  }
});

test('行收集：ID 从行文本解析（"名称 ID：<18位>"），行文本含 ID 时收集', async () => {
  // 手工构造带文本 ID 的行
  const html = buildChengfangFixtureHtml({
    plans: { '全店托管': [], '商品自选': [] },
  }).replace('</script>', '')
    .replace('<div id="list"></div>', `<div id="list"><table>
      <tr class="ovui-tr"><th><label class="ovui-checkbox" data-e2e="checkbox"><input type="checkbox"></label></th><th>计划</th></tr>
      <tr class="ovui-tr"><td><div class="oc-switch oc-switch--dark"><div class="ovui-switch ovui-switch--checked"></div></div></td><td>2026-09-09_千川乘方_21:05:31 ID：187585998140533930 已暂停</td></tr>
      <tr class="ovui-tr ovui-t-summary"><td>汇总行</td></tr>
    </table><div class="ovui-page-total">共 1 条记录</div></div>`)
    .replace('<script>', '<script>window.__CF && Object.assign(window.__CF, {plans:{},view:"商品自选"});');
  // 直接用简单页面（避免状态机干扰）
  await page.setContent(`<!DOCTYPE html><html><body><table>
    <tr class="ovui-tr"><th><label class="ovui-checkbox" data-e2e="checkbox"><input type="checkbox"></label></th><th>计划</th><th>状态</th></tr>
    <tr class="ovui-tr"><td><div class="oc-switch oc-switch--dark"><div class="ovui-switch ovui-switch--checked"></div></div></td><td>2026-09-09_千川乘方_21:05:31 ID：187585998140533930</td><td><span class="ad-status">已暂停</span></td></tr>
    <tr class="ovui-tr ovui-t-summary"><td>共 1 个抖音号</td></tr>
  </table>
  <div class="ovui-page-total">共 1 条记录</div>
  <div class="ovui-page-select"><input value="100条/页"></div>
  </body></html>`, { waitUntil: 'load' });
  const r = await page.evaluate(collectChengfangRowsInPage);
  assert.strictEqual(r.rows.length, 1, '汇总行被排除');
  assert.strictEqual(r.rows[0].id, '187585998140533930');
  assert.strictEqual(r.rows[0].switchChecked, true, '内层 --checked 穿透');
  assert.strictEqual(r.rows[0].status.includes('已暂停'), true);
});

test('行收集：行内多个候选ID → idError（拒绝猜测）', async () => {
  await page.setContent(`<!DOCTYPE html><html><body><table>
    <tr class="ovui-tr"><td><div class="oc-switch oc-switch--dark"><div class="ovui-switch ovui-switch--checked"></div></div></td><td>A ID：187585998140533930 商品ID：187585998140533931</td></tr>
  </table></body></html>`, { waitUntil: 'load' });
  const r = await page.evaluate(collectChengfangRowsInPage);
  assert.strictEqual(r.rows.length, 1);
  assert.strictEqual(r.rows[0].id, null);
  assert.match(r.rows[0].idError, /多个候选ID/);
});

// ── 分页与翻页 ──────────────────────────────────────────────────────

test('分页信息：total/pageSize/activePage/hasNext', async () => {
  await load({ plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(23) }, state: { view: '商品自选', pageSize: 100 } });
  const p = await page.evaluate(collectChengfangPaginationInPage);
  assert.strictEqual(p.total, 23);
  assert.strictEqual(p.pageSize, '100条/页');
  assert.strictEqual(p.activePage, '1');
  assert.strictEqual(p.hasNext, false);
});

test('翻页：next 可用时翻页成功；末页禁用返回 atEnd', async () => {
  await load({ plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(23) }, state: { view: '商品自选', pageSize: 10 } });
  const r1 = await page.evaluate(clickChengfangNextPageInPage);
  assert.strictEqual(r1.clicked, true);
  const p2 = await page.evaluate(collectChengfangPaginationInPage);
  assert.strictEqual(p2.activePage, '2');
  // 直接切到末页（第 3 页）并重渲染
  await page.evaluate(() => { window.__CF.page = 3; window.render(); });
  const rEnd = await page.evaluate(clickChengfangNextPageInPage);
  assert.strictEqual(rEnd.atEnd, true);
});

// ── 全选与选中读取 ──────────────────────────────────────────────────

test('表头全选框：勾选当前页全部行，选中行可读回', async () => {
  await load({ plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(3) }, state: { view: '商品自选', pageSize: 100 } });
  const r = await page.evaluate(clickChengfangHeaderSelectAllInPage);
  assert.strictEqual(r.clicked, true);
  const sel = await page.evaluate(readSelectedChengfangRowIdsInPage);
  assert.strictEqual(sel.selectedCount, 3);
  assert.strictEqual(sel.selectedIds.length, 3);
  const bar = await page.evaluate(readChengfangBatchBarInPage);
  assert.strictEqual(bar.visible, true);
  assert.strictEqual(bar.selectedCount, 3);
});

test('行复选框校正：setChengfangRowCheckboxByPlanId 取消勾选指定行', async () => {
  await load({ plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(3) }, state: { view: '商品自选', pageSize: 100 } });
  await page.evaluate(clickChengfangHeaderSelectAllInPage);
  const id0 = (await page.evaluate(readSelectedChengfangRowIdsInPage)).selectedIds[0];
  const r = await page.evaluate(setChengfangRowCheckboxByPlanId, { planId: id0, checked: false });
  assert.strictEqual(r.ok, true);
  const sel = await page.evaluate(readSelectedChengfangRowIdsInPage);
  assert.strictEqual(sel.selectedIds.includes(id0), false);
  assert.strictEqual(sel.selectedIds.length, 2);
});

// ── 行内开关（全店托管总开关）───────────────────────────────────────

test('行内开关：单候选点击成功并翻转；多个开关拒绝', async () => {
  await load({ plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': [] } });
  const r = await page.evaluate(clickChengfangRowSwitchByPlanId, TUOGUAN_PLAN.id);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.beforeChecked, true);
  // 行内出现两个 .oc-switch → 拒绝
  await page.evaluate(() => {
    const tr = document.querySelector('tr[data-plan]');
    tr.innerHTML = tr.innerHTML + '<div class="oc-switch oc-switch--dark"></div>';
  });
  const r2 = await page.evaluate(clickChengfangRowSwitchByPlanId, TUOGUAN_PLAN.id);
  assert.strictEqual(r2.ok, false);
  assert.match(r2.reason, /出现 \d+ 个开关/);
});

test('行内开关：找不到目标行 → 拒绝', async () => {
  await load({ plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': [] } });
  const r = await page.evaluate(clickChengfangRowSwitchByPlanId, '999999999999999999');
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /未找到计划ID/);
});
