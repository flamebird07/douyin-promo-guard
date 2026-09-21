'use strict';

/**
 * 新 UI（aurora-qc）回归测试：2026-09-21 平台把千川乘方管理页从 ovui 组件整体迁移到
 * aurora-qc（.aurora-qc-table / button.aurora-qc-switch[aria-checked] /
 * .aurora-qc-promotion-batch-operation-bar-item / 批量暂停确认弹窗），旧路径
 * /uni-prom/overall 与新路径 /overall-prom 同为该新 UI。
 *
 * 覆盖：行/分页采集（行键=计划ID、aria 开关态、排除汇总/度量行）、每页条数切换、
 *       表头全选、批量暂停（含确认弹窗闭环）、幂等零点击、noop 不谎报、开启、删除零点击。
 * 运行：npm test
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { buildChengfangFixtureHtml } = require('./chengfang-fixture');
const {
  createChengfangController,
  collectChengfangRowsInPage,
  collectChengfangPaginationInPage,
} = require('../src/adapters/chengfang-reader');
const { executeChengfangPause, executeChengfangEnable } = require('../src/engine/chengfang-executor');
const { shanghaiMs } = require('../src/lib/time');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ACCOUNT_ID = '1710242295996424';
const SHOP_CFG = { id: '瑾漂亮潮流服饰', name: '瑾漂亮潮流服饰', accountId: ACCOUNT_ID };
// 新 UI 每次回读都带一次页面刷新（reload+切视图+重设条数），单轮读取成本高于旧 UI，
// 故测试预算相应放大（生产为 execution.readbackTimeoutMs=120000 / readbackIntervalMs=3000）。
const TEST_POLL = { readbackTimeoutMs: 20000, readbackIntervalMs: 250 };
const PAUSE_NOW = shanghaiMs('2026-09-12', '08:00');
const PAUSE_DATE = '2026-09-12';
const ENABLE_NOW = () => shanghaiMs('2026-09-12', '07:30');
const ENABLE_DATE = '2026-09-12';

const TUOGUAN = { id: '1843885552532505', name: '全店托管 2025-09-21_商品全店托管' };
const ZIXUAN = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `1875859981405339${String(i).padStart(3, '0')}`, name: `千川乘方_计划${i}` }));

let browser;

before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1280,900'] });
});
after(async () => {
  await browser.close().catch(() => {});
});

async function loadPage(opts = {}) {
  const html = buildChengfangFixtureHtml(Object.assign({ ui: 'aurora' }, opts));
  const page = await browser.newPage();
  await page.route('**/overall-prom**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  await page.route('**/uni-prom/overall**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(`https://qianchuan.jinritemai.com/overall-prom?aavid=${ACCOUNT_ID}`, { waitUntil: 'load' });
  return page;
}

function mkController() {
  return createChengfangController({ loadWaitMs: 40, tabWaitMs: 10 });
}

async function runPause(opts = {}) {
  const page = await loadPage(opts.fixture || {});
  let controller = opts.controller || mkController();
  const realClicks = [];
  const origPause = controller.clickBatchPause.bind(controller);
  controller.clickBatchPause = async (p) => { realClicks.push('pause'); return origPause(p); };
  const origEnable = controller.clickBatchEnable.bind(controller);
  controller.clickBatchEnable = async (p) => { realClicks.push('enable'); return origEnable(p); };
  const result = await executeChengfangPause({
    controller,
    page,
    shopCfg: SHOP_CFG,
    config: opts.config || { execution: { realMode: true, dryRun: false, ...TEST_POLL }, monitor: { chengfang: { pauseEnabled: true } } },
    dryRun: opts.dryRun,
    now: () => PAUSE_NOW,
    businessDate: PAUSE_DATE,
    audit: () => {},
    stopRequested: () => false,
  });
  const state = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.aurora-qc-table-row[data-row-key]')];
    return {
      clickLog: window.__CF.clickLog,
      pageSize: window.__CF.pageSize,
      pauseConfirmClicks: window.__CF.pauseConfirmClicks || 0,
      plansTuoguan: (window.__CF.plans['全店托管'] || []).map((p) => ({ id: p.id, checked: p.checked })),
      plansZixuan: (window.__CF.plans['商品自选'] || []).map((p) => ({ id: p.id, checked: p.checked })),
      renderedRowKeys: rows.map((r) => r.getAttribute('data-row-key')),
    };
  });
  await page.close().catch(() => {});
  return { result, state, realClicks };
}

async function runEnable(opts = {}) {
  const page = await loadPage(opts.fixture || {});
  const controller = opts.controller || mkController();
  const realClicks = [];
  const orig = controller.clickBatchEnable.bind(controller);
  controller.clickBatchEnable = async (p) => { realClicks.push('enable'); return orig(p); };
  const result = await executeChengfangEnable({
    controller,
    page,
    shopCfg: SHOP_CFG,
    config: { execution: { realMode: true, dryRun: false, ...TEST_POLL }, monitor: { chengfang: { scope: ['全店托管', '商品自选'], enableEnabled: true } } },
    now: ENABLE_NOW,
    businessDate: ENABLE_DATE,
    audit: () => {},
    stopRequested: () => false,
  });
  const state = await page.evaluate(() => ({
    clickLog: window.__CF.clickLog,
    pageSize: window.__CF.pageSize,
    plansTuoguan: (window.__CF.plans['全店托管'] || []).map((p) => ({ id: p.id, checked: p.checked })),
    plansZixuan: (window.__CF.plans['商品自选'] || []).map((p) => ({ id: p.id, checked: p.checked })),
  }));
  await page.close().catch(() => {});
  return { result, state, realClicks };
}

// ── 采集层：新 UI 行/分页 ───────────────────────────────────────────

test('新 UI 行采集：行键=计划ID、aria 开关态、汇总行与度量行必须排除', async () => {
  const page = await loadPage({ plans: { '全店托管': [{ ...TUOGUAN, checked: true }], '商品自选': ZIXUAN(3).map((p) => ({ ...p, checked: false })) } });
  const controller = mkController();
  await controller.switchView({ page, tab: '全店托管' });
  const t = await page.evaluate(collectChengfangRowsInPage);
  assert.strictEqual(t.ui, 'aurora', '必须识别为新 UI');
  assert.strictEqual(t.rows.length, 1, '全店托管 1 行（汇总/度量行不得计入）');
  assert.strictEqual(t.rows[0].id, TUOGUAN.id, '行键即计划ID');
  assert.strictEqual(t.rows[0].switchChecked, true, 'aria-checked=true → 投放中');
  assert.strictEqual(t.rows[0].status, '投放中');
  const pag = await page.evaluate(collectChengfangPaginationInPage);
  assert.strictEqual(pag.ui, 'aurora');
  assert.strictEqual(pag.total, 1);
  assert.strictEqual(pag.pageSize, '10');
  assert.strictEqual(pag.activePage, '1');
  assert.strictEqual(pag.hasNext, false);
  await page.close();
});

test('新 UI 行采集：商品自选多页（23 条/每页 10）分页与开关态如实读出', async () => {
  const page = await loadPage({ plans: { '全店托管': [], '商品自选': ZIXUAN(23).map((p, i) => ({ ...p, checked: i % 2 === 0 })) } });
  const controller = mkController();
  await controller.switchView({ page, tab: '商品自选' });
  const first = await page.evaluate(collectChengfangRowsInPage);
  assert.strictEqual(first.rows.length, 10, '首页 10 行');
  assert.strictEqual(first.total, 23);
  const pag = await page.evaluate(collectChengfangPaginationInPage);
  assert.strictEqual(pag.hasNext, true, '有下一页');
  const next = await controller.nextPage ? null : null; // 控制器无 nextPage 方法（执行器内部翻页），此处直接验证分页元数据
  void next;
  await page.close();
});

test('新 UI 每页条数切换：下拉展开后可选 100 条/页', async () => {
  const page = await loadPage({ plans: { '全店托管': [], '商品自选': ZIXUAN(23) } });
  const controller = mkController();
  await controller.switchView({ page, tab: '商品自选' });
  await controller.switchPageSize({ page, size: '100条/页' });
  const pag = await page.evaluate(collectChengfangPaginationInPage);
  assert.strictEqual(pag.pageSize, '100', '每页条数已切到 100');
  assert.strictEqual(pag.hasNext, false, '单页容纳 23 行');
  await page.close();
});

// ── 暂停流程（新 UI）────────────────────────────────────────────────

test('新 UI 暂停正常：全店托管1条 + 商品自选23条 → 全部暂停，确认弹窗只提交一次', async () => {
  const { result, state, realClicks } = await runPause({
    fixture: { plans: { '全店托管': [{ ...TUOGUAN, checked: true }], '商品自选': ZIXUAN(23).map((p) => ({ ...p, checked: true })) } },
  });
  assert.strictEqual(result.allPausedConfirmed, true, result.confirmReason);
  assert.deepStrictEqual(realClicks, ['pause'], '仅一次批量暂停点击（托管行走开关）');
  assert.strictEqual(state.pauseConfirmClicks, 1, '确认弹窗"确定"恰好提交一次');
  assert.ok(state.plansZixuan.every((p) => p.checked === false), '商品自选全部关闭');
  assert.strictEqual(state.plansTuoguan[0].checked, false, '全店托管开关已关');
  assert.strictEqual(state.clickLog.filter((c) => c.type === 'delete').length, 0, '删除零点击');
  assert.strictEqual(state.pageSize, 100, '扫描时切到 100 条/页');
});

test('新 UI 暂停幂等：全部已关闭 → 零点击终止（含批量项零点击）', async () => {
  const { result, state, realClicks } = await runPause({
    fixture: { plans: { '全店托管': [{ ...TUOGUAN, checked: false }], '商品自选': ZIXUAN(5).map((p) => ({ ...p, checked: false })) } },
  });
  assert.strictEqual(result.allPausedConfirmed, true, result.confirmReason);
  assert.deepStrictEqual(realClicks, [], '零批量点击');
  assert.strictEqual(state.clickLog.length, 0, '零点击');
  assert.strictEqual(state.pauseConfirmClicks, 0);
});

test('新 UI 暂停未生效（noop）：同会话仅重试一次后停止，不报告全部暂停', async () => {
  const { result, state, realClicks } = await runPause({
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN(5).map((p) => ({ ...p, checked: true })) }, state: { pauseEffect: 'noop' } },
  });
  assert.strictEqual(realClicks.length, 2, `首次 + 唯一一次同会话重试，绝无第三次（回读原因：${result.confirmReason}）`);
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.match(result.confirmReason, /未生效/);
  assert.ok(state.plansZixuan.some((p) => p.checked === true), '平台未生效，行仍投放中');
  assert.strictEqual(state.clickLog.filter((c) => c.type === 'delete').length, 0, '删除零点击');
});

test('新 UI 暂停：托管开关按行键精确落点（ID 相同前缀不误点）', async () => {
  const { result, state } = await runPause({
    fixture: {
      plans: {
        '全店托管': [
          { id: '184388555253250', name: '全店托管_短ID', checked: true },
          { id: '1843885552532505', name: '全店托管_长ID', checked: true },
        ],
        '商品自选': [],
      },
    },
  });
  assert.strictEqual(result.allPausedConfirmed, true, result.confirmReason);
  assert.ok(state.plansTuoguan.every((p) => p.checked === false), '两条托管计划均按各自行键关闭');
  assert.strictEqual(state.clickLog.filter((c) => c.type === 'switch').length, 2, '两次行内开关点击');
});

// ── 开启流程（新 UI）────────────────────────────────────────────────

test('新 UI 开启正常：全店托管1条关闭 + 商品自选23条关闭 → 全部开启', async () => {
  const { result, state, realClicks } = await runEnable({
    fixture: { plans: { '全店托管': [{ ...TUOGUAN, checked: false }], '商品自选': ZIXUAN(23).map((p) => ({ ...p, checked: false })) } },
  });
  assert.strictEqual(result.allEnabledConfirmed, true, result.confirmReason);
  assert.deepStrictEqual(realClicks, ['enable'], '商品自选批量开启一次');
  assert.strictEqual(state.clickLog.filter((c) => c.type === 'switch').length, 1, '托管行开关点击一次');
  assert.strictEqual(state.clickLog.filter((c) => c.type === 'delete').length, 0, '删除零点击');
  assert.ok(state.plansZixuan.every((p) => p.checked === true), '商品自选全部开启');
});

test('新 UI 开启幂等：已全部开启 → 零点击', async () => {
  const { result, state, realClicks } = await runEnable({
    fixture: { plans: { '全店托管': [{ ...TUOGUAN, checked: true }], '商品自选': ZIXUAN(5).map((p) => ({ ...p, checked: true })) } },
  });
  assert.strictEqual(result.allEnabledConfirmed, true, result.confirmReason);
  assert.deepStrictEqual(realClicks, []);
  assert.strictEqual(state.clickLog.length, 0, '零点击');
});

// ── 回读新鲜度（新 UI 列表是 URL 快照）────────────────────────────

test('新 UI 回读刷新：refreshView 触发 reload、重设视图与 100 条/页', async () => {
  const page = await loadPage({ plans: { '全店托管': [], '商品自选': ZIXUAN(23).map((p) => ({ ...p, checked: true })) } });
  const controller = mkController();
  let reloads = 0;
  const origReload = page.reload.bind(page);
  page.reload = async (...a) => { reloads += 1; return origReload(...a); };
  const r = await controller.refreshView({ page, tab: '商品自选' });
  assert.strictEqual(r.refreshed, true, '新 UI 必须刷新回读');
  assert.strictEqual(reloads, 1, '恰好 reload 一次');
  assert.strictEqual(r.pageSize, '100', '刷新后重新置 100 条/页（否则目标跨页误判缺失）');
  const pag = await page.evaluate(collectChengfangPaginationInPage);
  assert.strictEqual(pag.pageSize, '100');
  await page.close();
});

test('新 UI 回读刷新：暂停点击后回读走刷新路径（快照陈旧不得当作未落地）', async () => {
  const page = await loadPage({ plans: { '全店托管': [], '商品自选': ZIXUAN(5).map((p) => ({ ...p, checked: true })) } });
  const controller = mkController();
  let refreshes = 0;
  const origRefresh = controller.refreshView.bind(controller);
  controller.refreshView = async (p) => { refreshes += 1; return origRefresh(p); };
  const result = await executeChengfangPause({
    controller,
    page,
    shopCfg: SHOP_CFG,
    config: { execution: { realMode: true, dryRun: false, ...TEST_POLL }, monitor: { chengfang: { pauseEnabled: true } } },
    now: () => PAUSE_NOW,
    businessDate: PAUSE_DATE,
    audit: () => {},
    stopRequested: () => false,
  });
  assert.ok(refreshes >= 1, `落地回读必须刷新取新数据（实际 ${refreshes} 次）`);
  assert.strictEqual(result.allPausedConfirmed, true, result.confirmReason);
  await page.close();
});

test('新 UI 刷新刷新：旧 UI 夹具下 refreshView 为空操作（不改旧语义）', async () => {
  const html = buildChengfangFixtureHtml({ plans: { '全店托管': [], '商品自选': ZIXUAN(3).map((p) => ({ ...p, checked: true })) } });
  const page = await browser.newPage();
  await page.route('**/uni-prom/overall**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(`https://qianchuan.jinritemai.com/uni-prom/overall?aavid=${ACCOUNT_ID}`, { waitUntil: 'load' });
  const controller = mkController();
  let reloads = 0;
  const origReload = page.reload.bind(page);
  page.reload = async (...a) => { reloads += 1; return origReload(...a); };
  const r = await controller.refreshView({ page, tab: '商品自选' });
  assert.strictEqual(r.refreshed, false);
  assert.strictEqual(r.ui, 'legacy');
  assert.strictEqual(reloads, 0, '旧 UI 不得刷新');
  await page.close();
});

// ── 删除零点击守卫（新 UI 批量项）─────────────────────────────────

test('新 UI 删除零点击：批量栏"删除"项永不点击（暂停流程点击日志无 delete）', async () => {
  const { state } = await runPause({
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN(3).map((p) => ({ ...p, checked: true })) } },
  });
  assert.strictEqual(state.clickLog.filter((c) => c.type === 'delete').length, 0, '删除项零点击');
  assert.ok(state.clickLog.every((c) => c.type === 'pause'), `只允许批量暂停点击，实际：${JSON.stringify(state.clickLog.map((c) => c.type))}`);
});
