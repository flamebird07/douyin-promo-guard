'use strict';

/**
 * 乘方暂停执行器流程测试：真实控制器（createChengfangController，小等待注入）
 * 驱动本地 DOM fixture 状态机页面（Playwright route 拦截 + 生产 DOM 函数），
 * 覆盖用户要求的全部场景：
 * - 正常路径：全店托管 + 商品自选全部暂停，allPausedConfirmed=true
 * - 托管已关闭 → 幂等跳过（行开关零点击）
 * - 开启/暂停/删除同时存在 → 只点暂停（删除零点击）
 * - 暂停按钮缺失/多候选 → 零点击停止
 * - 删除弹窗/非预期弹窗 → 停止，不点"确定"
 * - 100条/页、超过100条（多页）、空清单、翻页失败、跨页全选、暂停后列表收缩
 * - 暂停未生效（noop）→ 操作后强制新扫描发现仍开启 → 不报告全部暂停
 * - 两部分一项失败 → 不报告全部暂停
 * - dryRun：只枚举目标，零点击
 * - 自动开启（executeChengfangEnable，07:00 窗口）：realMode+enableEnabled 门禁、
 *   开启/暂停/删除并存只点开启、100条/页跨页/同名不同ID、开启后列表变化、
 *   千川首次未落地同会话单次重试、跳回首页同会话恢复乘方URL、开启前/最终
 *   身份复核期间停止/跨日/账户变化/关闭 enableEnabled 均零点击
 * 运行：npm test
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');
const { buildChengfangFixtureHtml } = require('./chengfang-fixture');
const { createChengfangController } = require('../src/adapters/chengfang-reader');
const { executeChengfangPause, executeChengfangEnable } = require('../src/engine/chengfang-executor');
const { buildChengfangRequestGate } = require('../src/engine/chengfang-gate');
const { makeClock } = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const ACCOUNT_ID = '1710242295996424';
const SHOP_CFG = { id: '瑾漂亮潮流服饰', name: '瑾漂亮潮流服饰', accountId: ACCOUNT_ID };

const TUOGUAN_PLAN = { id: '184388555253250562', name: '全店托管 2025-09-21_商品全店托管', checked: true };
const ZIXUAN_PLANS = (n) =>
  Array.from({ length: n }, (_, i) => ({ id: `1875859981405339${String(i).padStart(3, '0')}`, name: `千川乘方_计划${i}`, checked: true }));

let browser;
let page;

before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1280,900'] });
});

after(async () => {
  await browser.close().catch(() => {});
});

async function loadPage(opts = {}) {
  const html = buildChengfangFixtureHtml(opts);
  page = await browser.newPage();
  await page.route('**/uni-prom/overall**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  await page.goto(`https://qianchuan.jinritemai.com/uni-prom/overall?aavid=${ACCOUNT_ID}`, { waitUntil: 'load' });
  return page;
}

function makeController() {
  return createChengfangController({ loadWaitMs: 40, tabWaitMs: 10 });
}

// 暂停路径固定基准时钟：不依赖真实墙钟时间。真实时钟在上海 08:00 前运行时，
// "每日 08:00 后"请求门禁会拦截所有真实点击，导致用例随运行时刻漂移（夜间必挂）。
// 开启路径（runEnable）已有等价固定基准（ENABLE_NOW/ENABLE_DATE）。
const PAUSE_NOW = shanghaiMs('2026-09-12', '08:00');
const PAUSE_DATE = '2026-09-12';

async function run(opts = {}) {
  const pageRef = await loadPage(opts.fixture || {});
  let controller = opts.controller || makeController();
  if (opts.controllerOverride) controller = await opts.controllerOverride(controller, pageRef);
  const config = opts.config || {
    execution: { realMode: true, dryRun: false },
    monitor: { chengfang: { pauseEnabled: true } },
  };
  const result = await executeChengfangPause({
    controller,
    page: pageRef,
    shopCfg: SHOP_CFG,
    // 真实执行门槛（集中校验）：测试真实点击路径时必须配置 realMode=true + pauseEnabled=true；
    // 显式 dryRun:true 仍强制演练（零点击）。
    config,
    dryRun: opts.dryRun,
    now: opts.now || (() => PAUSE_NOW),
    businessDate: opts.businessDate !== undefined ? opts.businessDate : PAUSE_DATE,
    audit: () => {},
    stopRequested: opts.stopRequested || (() => false),
  });
  const state = await pageRef.evaluate(() => ({
    clickLog: window.__CF.clickLog,
    pageSize: window.__CF.pageSize,
    plansTuoguan: (window.__CF.plans['全店托管'] || []).map((p) => ({ id: p.id, checked: p.checked })),
    plansZixuan: (window.__CF.plans['商品自选'] || []).map((p) => ({ id: p.id, checked: p.checked })),
  }));
  await pageRef.close().catch(() => {});
  return { result, state };
}

const pauseClicks = (state) => state.clickLog.filter((c) => c.type === 'pause');
const deleteClicks = (state) => state.clickLog.filter((c) => c.type === 'delete');
const switchClicks = (state) => state.clickLog.filter((c) => c.type === 'switch');

// ── 正常路径 ─────────────────────────────────────────────────────────

test('正常：全店托管1条开启 + 商品自选23条 → 全部暂停，allPausedConfirmed=true', async () => {
  const { result, state } = await run({
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(23) } },
    dryRun: false,
  });
  assert.strictEqual(result.allPausedConfirmed, true, result.confirmReason);
  assert.strictEqual(result.views.tuoguan.confirmedCount, 1);
  assert.strictEqual(result.views.zixuan.confirmedCount, 23);
  assert.strictEqual(switchClicks(state).length, 1, '全店托管行开关点击一次');
  assert.strictEqual(pauseClicks(state).length, 1, '商品自选批量暂停一次');
  assert.strictEqual(deleteClicks(state).length, 0, '删除零点击');
  assert.strictEqual(state.pageSize, 100, '已切换 100条/页');
  assert.ok(state.plansTuoguan.every((p) => p.checked === false), '全店托管已关闭');
  assert.ok(state.plansZixuan.every((p) => p.checked === false), '商品自选全部关闭');
  // 点击暂停时选中集合 = 23 条（全选范围）
  assert.strictEqual(pauseClicks(state)[0].ids.length, 23);
});

// ── 幂等跳过 ─────────────────────────────────────────────────────────

test('托管已关闭：幂等跳过（行开关零点击），商品自选照常处理', async () => {
  const { result, state } = await run({
    fixture: {
      plans: { '全店托管': [{ ...TUOGUAN_PLAN, checked: false }], '商品自选': ZIXUAN_PLANS(5) },
    },
    dryRun: false,
  });
  assert.strictEqual(result.views.tuoguan.status, 'already_paused');
  assert.strictEqual(switchClicks(state).length, 0, '已关闭托管不再点击');
  assert.strictEqual(result.allPausedConfirmed, true, result.confirmReason);
  assert.strictEqual(result.views.zixuan.confirmedCount, 5);
});

test('两视图均空（已确认无计划）：confirmed_empty，allPausedConfirmed=true（无目标）', async () => {
  const { result, state } = await run({
    fixture: { plans: { '全店托管': [], '商品自选': [] } },
    dryRun: false,
  });
  assert.strictEqual(result.views.tuoguan.status, 'confirmed_empty');
  assert.strictEqual(result.views.zixuan.status, 'confirmed_empty');
  assert.strictEqual(result.allPausedConfirmed, true, '无目标时视为已满足（无开启对象）');
  assert.strictEqual(pauseClicks(state).length, 0);
  assert.strictEqual(switchClicks(state).length, 0);
});

// ── 防误删：按钮定位 / 弹窗 ─────────────────────────────────────────

test('开启/暂停/删除同时存在：只点暂停，删除零点击', async () => {
  const { result, state } = await run({
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(3) } },
    dryRun: false,
  });
  assert.strictEqual(result.allPausedConfirmed, true, result.confirmReason);
  assert.strictEqual(deleteClicks(state).length, 0, '删除按钮绝不被点击');
  assert.ok(pauseClicks(state).length >= 1);
});

test('暂停按钮缺失：零点击停止，不报告全部暂停', async () => {
  const { result, state } = await run({
    fixture: {
      plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(3) },
      batchButtons: { pause: '' },
    },
    dryRun: false,
  });
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.match(result.views.zixuan.status, /partial_failed/);
  assert.match(result.views.zixuan.reason, /未找到"暂停"/);
  assert.strictEqual(pauseClicks(state).length, 0);
  assert.strictEqual(deleteClicks(state).length, 0);
});

test('暂停按钮多候选：零点击停止', async () => {
  const { result, state } = await run({
    fixture: {
      plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(3) },
      batchButtons: {
        pause: '<button data-auto-id="bar-groups-group-item-btn-pause">暂停</button><button data-e2e="batch_pause">暂停</button>',
      },
    },
    dryRun: false,
  });
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.match(result.views.zixuan.reason, /出现 \d+ 个"暂停"候选/);
  assert.strictEqual(pauseClicks(state).length, 0);
});

test('删除确认弹窗：停止，不点击"确定"，删除零点击', async () => {
  const { result, state } = await run({
    fixture: {
      // 托管已关闭：确保弹窗在商品自选步骤确定性触发（弹窗在任何视图中都会先于业务点击被拦截）
      plans: { '全店托管': [{ ...TUOGUAN_PLAN, checked: false }], '商品自选': ZIXUAN_PLANS(3) },
      dialog: '<div role="dialog" style="position:fixed;top:0;left:0;width:400px;height:200px"><span>确认删除该计划？删除后不可恢复</span><button>确定</button></div>',
    },
    dryRun: false,
  });
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.match(result.views.zixuan.reason, /非预期弹窗|删除/);
  assert.strictEqual(pauseClicks(state).length, 0);
  assert.strictEqual(deleteClicks(state).length, 0);
});

test('非预期确认弹窗：停止（不点击通用"确定"）', async () => {
  const { result, state } = await run({
    fixture: {
      plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(3) },
      dialog: '<div role="dialog" style="position:fixed;top:0;left:0;width:400px;height:200px"><span>确认执行批量操作？</span><button>确定</button></div>',
    },
    dryRun: false,
  });
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.strictEqual(pauseClicks(state).length, 0);
});

// ── 分页与数量 ──────────────────────────────────────────────────────

test('超过100条（120条/2页）：跨页全部处理，无漏处理', async () => {
  const { result, state } = await run({
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(120) } },
    dryRun: false,
  });
  assert.strictEqual(result.allPausedConfirmed, true, result.confirmReason);
  assert.strictEqual(result.views.zixuan.confirmedCount, 120);
  const pausedIds = new Set();
  for (const c of pauseClicks(state)) for (const id of c.ids) pausedIds.add(id);
  assert.strictEqual(pausedIds.size, 120, '全部 120 个目标都被发起暂停（无漏页）');
  assert.strictEqual(deleteClicks(state).length, 0);
});

test('暂停后列表收缩（120条→暂停后行消失）：无漏处理，但回读 missing 不谎报全部暂停', async () => {
  const { result, state } = await run({
    fixture: {
      plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(120) },
      state: { shrink: true },
    },
    dryRun: false,
  });
  // 处理过程：每次暂停覆盖全部选中行，两批合计 120 个（第一批100 + 第二批20）
  const pausedIds = new Set();
  for (const c of pauseClicks(state)) for (const id of c.ids) pausedIds.add(id);
  assert.strictEqual(pausedIds.size, 120, '收缩导致页码位移时仍无漏处理（稳定ID基准）');
  // 回读：行已从列表消失 → 不当作已关闭 → 不报告全部暂停
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.ok(result.finalVerify.missing.length >= 120, '全量回读如实报告缺失');
  assert.match(result.confirmReason, /找不到/);
});

test('翻页失败（hasNext=true 但 next 无效）：停止，不谎报全部暂停', async () => {
  const { result } = await run({
    fixture: {
      plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(120) },
    },
    dryRun: false,
    controllerOverride: async (controller, pageRef) => {
      // 覆写 clickNextPage：模拟页面翻页失效
      const orig = controller.clickNextPage.bind(controller);
      controller.clickNextPage = async (p) => {
        const r = await orig(p);
        return { clicked: false, reason: '翻页失效（测试注入）' };
      };
      return controller;
    },
  });
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.match(result.confirmReason, /翻页失败|停止/);
});

// ── 跨页全选 ────────────────────────────────────────────────────────

test('表头全选框为跨页全选（平台可清除跨页选择）：清除后按当前页目标重选，覆盖全部目标', async () => {
  const { result, state } = await run({
    fixture: {
      plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(120) },
      state: { selectAllScope: 'cross', crossPageClearable: true },
    },
    dryRun: false,
  });
  assert.strictEqual(result.allPausedConfirmed, true, result.confirmReason);
  assert.ok(result.selectionNote.includes('已清除跨页选择'), `选择范围以实测为准：${result.selectionNote}`);
  const pausedIds = new Set();
  for (const c of pauseClicks(state)) for (const id of c.ids) pausedIds.add(id);
  assert.strictEqual(pausedIds.size, 120);
});

test('表头全选框为跨页全选但平台残留不可见选择（无法确认范围）：停止，不宽松通过', async () => {
  const { result, state } = await run({
    fixture: {
      plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(120) },
      state: { selectAllScope: 'cross', crossPageClearable: false },
    },
    dryRun: false,
  });
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.match(result.confirmReason, /残留|不可确认|停止/);
  assert.strictEqual(pauseClicks(state).length, 0, '范围不可确认时不发出批量暂停');
  assert.strictEqual(deleteClicks(state).length, 0);
});

// ── 强制新扫描 / 失败传播 ───────────────────────────────────────────

test('暂停两次均未生效（noop）：同会话仅重试一次后仍不报告全部暂停', async () => {
  const { result, state } = await run({
    fixture: {
      plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(3) },
      state: { pauseEffect: 'noop' },
    },
    dryRun: false,
  });
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.match(result.views.zixuan.reason, /开关仍开启/);
  // 点击已发生（pause 动作发出），但结果以强制新扫描回读为准
  assert.strictEqual(pauseClicks(state).length, 2, '首次未落地时仅同会话重试一次');
  assert.ok(state.plansZixuan.some((p) => p.checked === true), '平台未生效，行仍开启');
});

test('千川首次暂停未落地：保持同一会话重试一次，第二次回读确认关闭', async () => {
  const { result, state } = await run({
    fixture: {
      plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(3) },
      state: { pauseEffect: 'first-noop' },
    },
    dryRun: false,
  });
  assert.strictEqual(result.allPausedConfirmed, true, result.confirmReason);
  assert.strictEqual(pauseClicks(state).length, 2, '首次未落地后仅同会话重试一次');
  assert.strictEqual(deleteClicks(state).length, 0, '删除始终零点击');
  assert.ok(state.plansZixuan.every((p) => p.checked === false), '第二次后全部关闭');
});

test('商品自选一项失败（读取失败）：不报告全部暂停（区分读取失败与已确认无计划）', async () => {
  const pageRef = await loadPage({ plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(3) } });
  const controller = makeController();
  // 覆写 readView：商品自选视图返回读取失败
  const origRead = controller.readView.bind(controller);
  controller.readView = async (p) => {
    const v = await origRead(p);
    if (p.tab === '商品自选') return { tab: '商品自选', rows: { error: 'fixture 注入读取失败' }, pagination: null };
    return v;
  };
  const result = await executeChengfangPause({
    controller,
    page: pageRef,
    shopCfg: SHOP_CFG,
    config: { execution: { realMode: true, dryRun: false }, monitor: { chengfang: { pauseEnabled: true } } },
    dryRun: false,
    now: () => PAUSE_NOW,
    businessDate: PAUSE_DATE,
    audit: () => {},
  });
  await pageRef.close().catch(() => {});
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.strictEqual(result.views.tuoguan.confirmedCount, 1, '全店托管已处理');
  assert.strictEqual(result.views.zixuan.status, 'read_failed', '读取失败≠已确认无计划');
});

// ── dryRun / 身份核验 ───────────────────────────────────────────────

test('dryRun：只枚举目标，零点击（全选框/暂停/开关均不点）', async () => {
  const { result, state } = await run({
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(23) } },
    dryRun: true,
  });
  assert.strictEqual(result.mode, 'dry-run');
  assert.strictEqual(state.clickLog.length, 0, '演练零点击');
  assert.strictEqual(result.allPausedConfirmed, false, '演练不宣称已暂停');
  assert.strictEqual(result.dryRunTargets.length, 24, '枚举全部目标（1托管+23商品自选）');
  assert.ok(result.dryRunTargets.every((t) => t.action.startsWith('pause')), '只含暂停动作');
});

test('身份核验失败（账户不匹配）：停止，零点击', async () => {
  const { result, state } = await run({
    fixture: {
      plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(3) },
      navText: '首页 乘方 全域投放 品牌投放 数据 工具 财务 营销学堂 成长伙伴 99+ 伊人美 ID：1710242295000000',
    },
    dryRun: false,
  });
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.strictEqual(result.views.identity.status, 'read_failed');
  assert.match(result.confirmReason, /身份核验失败/);
  assert.strictEqual(state.clickLog.length, 0);
});

// ── 全量回读：完整当前范围（缺空态证据 / 重新开启）────────────────────

test('空清单缺分页总数证据：read_failed，不当作无计划（零点击）', async () => {
  const { result, state } = await run({
    fixture: { plans: { '全店托管': [], '商品自选': [] }, paginationMissing: true },
    dryRun: false,
  });
  assert.strictEqual(result.allPausedConfirmed, false);
  // 全店托管（第一区域）缺空态证据即停止，商品自选不会被当作已确认无计划
  assert.strictEqual(result.views.tuoguan.status, 'read_failed');
  assert.strictEqual(result.views.zixuan, undefined, '托管区域失败先行停止，未到达商品自选');
  assert.match(result.confirmReason, /空态证据|分页 total/);
  assert.strictEqual(state.clickLog.length, 0, '无法确认空态时零点击');
});

test('全量回读前重新开启对象（fixture 注入）：不谎报全部暂停', async () => {
  const { result, state } = await run({
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(3) } },
    dryRun: false,
    controllerOverride: async (controller, pageRef) => {
      const orig = controller.ensureFirstPage.bind(controller);
      let injected = false;
      controller.ensureFirstPage = async (p) => {
        if (!injected) {
          injected = true;
          await pageRef.evaluate(() => window.__CF.addPlan('商品自选', { id: '199999999999999999', name: '被恢复投放的计划', checked: true }));
        }
        return orig(p);
      };
      return controller;
    },
  });
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.match(result.confirmReason, /开启侧/);
  assert.strictEqual(pauseClicks(state).length, 1, '暂停动作已发出但结果以全量回读为准');
  assert.strictEqual(deleteClicks(state).length, 0);
});

// ── 点击结果未知：禁止盲点重试（尤其托管开关是切换动作）────────────────

test('托管开关点击结果未知但回读已关闭：不重复切换，确认成功', async () => {
  let switchCalls = 0;
  const { result, state } = await run({
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(2) } },
    dryRun: false,
    controllerOverride: async (controller, pageRef) => {
      const orig = controller.clickRowSwitch.bind(controller);
      controller.clickRowSwitch = async (p) => {
        switchCalls += 1;
        if (switchCalls === 1) {
          await orig(p); // 点击已生效（fixture 翻转开关）
          throw new Error('fixture: 点击后连接中断，结果未知');
        }
        return orig(p);
      };
      return controller;
    },
  });
  assert.strictEqual(result.allPausedConfirmed, true, result.confirmReason);
  assert.strictEqual(switchCalls, 1, '结果未知只回读确认，绝不盲点重试');
  assert.strictEqual(switchClicks(state).length, 1);
});

test('托管开关点击结果未知且回读仍开启：禁止重复切换（避免反向开启），停止', async () => {
  let switchCalls = 0;
  const { result, state } = await run({
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(2) } },
    dryRun: false,
    controllerOverride: async (controller) => {
      const orig = controller.clickRowSwitch.bind(controller);
      controller.clickRowSwitch = async (p) => {
        switchCalls += 1;
        if (switchCalls === 1) throw new Error('fixture: 点击未生效且结果未知');
        return orig(p);
      };
      return controller;
    },
  });
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.match(result.confirmReason, /禁止重复切换|结果未知/);
  assert.strictEqual(switchCalls, 1, '只尝试一次，绝不盲点重试');
  assert.strictEqual(switchClicks(state).length, 0, '未发生第二次切换');
});

// ── 请求级门槛：选择完成后停止 ────────────────────────────────────────

test('选择完成后收到停止：不发出批量暂停请求', async () => {
  let stopped = false;
  const { result, state } = await run({
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN_PLANS(5) } },
    dryRun: false,
    controllerOverride: async (controller, pageRef) => {
      const orig = controller.readBatchBar.bind(controller);
      controller.readBatchBar = async (p) => {
        stopped = true; // 选择完成（批量栏被读取）后停止 → 点击前门槛拦截
        return orig(p);
      };
      return controller;
    },
    stopRequested: () => stopped,
  });
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.match(result.confirmReason, /停止发出批量暂停请求/);
  assert.strictEqual(pauseClicks(state).length, 0);
  assert.strictEqual(deleteClicks(state).length, 0);
});

// ── 请求级门槛：实时重算当前配置许可（问题三）────────────────────────

test('gate 实时重算：构造 gate 后关闭 pauseEnabled → 下次 check 拒绝（不依赖静态 realAllowed）', () => {
  const clock = makeClock(shanghaiMs('2026-09-12', '10:00'));
  const config = {
    execution: { realMode: true, dryRun: false },
    monitor: { chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: true } },
    schedule: { dailyStartHour: 8, timezone: 'Asia/Shanghai' },
  };
  const gate = buildChengfangRequestGate({ config, nowFn: clock.nowFn, stopRequested: () => false, businessDate: '2026-09-12' });
  assert.strictEqual(gate().ok, true, '初始许可通过');
  config.monitor.chengfang.pauseEnabled = false; // 运行中修改配置对象属性
  const closed = gate();
  assert.strictEqual(closed.ok, false, '关闭许可后实时反映');
  assert.match(closed.reason, /pauseEnabled/);
  config.monitor.chengfang.pauseEnabled = true;
  assert.strictEqual(gate().ok, true, '重新打开后放行');
});

test('gate 实时重算：关闭 realMode 同样被实时拦截', () => {
  const clock = makeClock(shanghaiMs('2026-09-12', '10:00'));
  const config = {
    execution: { realMode: true, dryRun: false },
    monitor: { chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: true } },
    schedule: { dailyStartHour: 8, timezone: 'Asia/Shanghai' },
  };
  const gate = buildChengfangRequestGate({ config, nowFn: clock.nowFn, stopRequested: () => false, businessDate: '2026-09-12' });
  assert.strictEqual(gate().ok, true);
  config.execution.realMode = false;
  const closed = gate();
  assert.strictEqual(closed.ok, false);
  assert.match(closed.reason, /realMode/);
});

// ── 最终身份核验期间状态变化（beforeDispatch 二次 requestGate，问题四补漏）──
// 修复：身份复核成功返回后必须再次同步检查 requestGate；停止/跨日/许可在异步
// 核验期间变化时立即抛错，禁止派发点击。托管开关与商品自选批量暂停共用该保护。

test('最终身份核验期间收到停止：复核返回后 requestGate 拦截，零业务点击', async () => {
  let stopped = false;
  let identityCalls = 0;
  const { result, state } = await run({
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': [] } },
    dryRun: false,
    stopRequested: () => stopped,
    controllerOverride: async (controller) => {
      const orig = controller.verifyIdentity.bind(controller);
      controller.verifyIdentity = async (p) => {
        identityCalls += 1;
        const r = await orig(p);
        if (identityCalls === 2) stopped = true; // 最终派发前身份复核返回前收到停止
        return r;
      };
      return controller;
    },
  });
  assert.ok(identityCalls >= 2, '身份复核确实发生（第二次调用）');
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.match(result.confirmReason, /点击前最终检查拦截/);
  assert.strictEqual(state.clickLog.length, 0, '零业务点击');
  assert.strictEqual(switchClicks(state).length, 0, '托管开关零点击');
  assert.strictEqual(pauseClicks(state).length, 0);
  assert.strictEqual(deleteClicks(state).length, 0);
});

test('最终身份核验期间跨午夜：复核返回后 requestGate 跨日拦截，零业务点击', async () => {
  let identityCalls = 0;
  let nowMs = shanghaiMs('2026-09-12', '08:00');
  const { result, state } = await run({
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': [] } },
    dryRun: false,
    businessDate: '2026-09-12',
    now: () => nowMs,
    controllerOverride: async (controller) => {
      const orig = controller.verifyIdentity.bind(controller);
      controller.verifyIdentity = async (p) => {
        identityCalls += 1;
        const r = await orig(p);
        if (identityCalls === 2) nowMs = shanghaiMs('2026-09-13', '00:05'); // 复核期间跨午夜
        return r;
      };
      return controller;
    },
  });
  assert.ok(identityCalls >= 2, '身份复核确实发生（第二次调用）');
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.match(result.confirmReason, /点击前最终检查拦截|跨日/);
  assert.strictEqual(state.clickLog.length, 0, '零业务点击');
  assert.strictEqual(switchClicks(state).length, 0, '托管开关零点击');
});

test('最终身份核验期间关闭 pauseEnabled：复核返回后 requestGate 实时拦截，零业务点击', async () => {
  let identityCalls = 0;
  const config = {
    execution: { realMode: true, dryRun: false },
    monitor: { chengfang: { pauseEnabled: true } },
    schedule: { dailyStartHour: 8 },
  };
  const { result, state } = await run({
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': [] } },
    dryRun: false,
    config,
    controllerOverride: async (controller) => {
      const orig = controller.verifyIdentity.bind(controller);
      controller.verifyIdentity = async (p) => {
        identityCalls += 1;
        const r = await orig(p);
        if (identityCalls === 2) config.monitor.chengfang.pauseEnabled = false; // 复核期间关闭许可
        return r;
      };
      return controller;
    },
  });
  assert.ok(identityCalls >= 2, '身份复核确实发生（第二次调用）');
  assert.strictEqual(result.allPausedConfirmed, false);
  assert.match(result.confirmReason, /点击前最终检查拦截|pauseEnabled/);
  assert.strictEqual(state.clickLog.length, 0, '零业务点击');
  assert.strictEqual(switchClicks(state).length, 0, '托管开关零点击');
  assert.strictEqual(pauseClicks(state).length, 0);
});

// ═══════════════════════════════════════════════════════════════════
// 乘方自动开启（每日 07:00 窗口）：executeChengfangEnable
// 门禁 = realMode + enableEnabled + 上海 [enableHour, dailyStartHour) 窗口
// + 未停止 + 业务日期一致；开启不读费用/订单阈值。
// ═══════════════════════════════════════════════════════════════════

const enableClicks = (state) => state.clickLog.filter((c) => c.type === 'enable');
const TUOGUAN_CLOSED = { ...TUOGUAN_PLAN, checked: false };
const ZIXUAN_CLOSED = (n) => ZIXUAN_PLANS(n).map((p) => ({ ...p, checked: false }));
const ENABLE_NOW = () => shanghaiMs('2026-09-12', '07:30'); // 默认注入：开启窗口内
const ENABLE_DATE = '2026-09-12';

async function runEnable(opts = {}) {
  const pageRef = await loadPage(opts.fixture || {});
  let controller = opts.controller || makeController();
  if (opts.controllerOverride) controller = await opts.controllerOverride(controller, pageRef);
  const config = opts.config || {
    execution: { realMode: true, dryRun: false },
    monitor: { chengfang: { scope: ['全店托管', '商品自选'], enableEnabled: true } },
  };
  const result = await executeChengfangEnable({
    controller,
    page: pageRef,
    shopCfg: SHOP_CFG,
    config,
    dryRun: opts.dryRun,
    now: opts.now || ENABLE_NOW,
    businessDate: opts.businessDate || ENABLE_DATE,
    audit: () => {},
    stopRequested: opts.stopRequested || (() => false),
  });
  const state = await pageRef.evaluate(() => ({
    clickLog: window.__CF.clickLog,
    pageSize: window.__CF.pageSize,
    plansTuoguan: (window.__CF.plans['全店托管'] || []).map((p) => ({ id: p.id, checked: p.checked })),
    plansZixuan: (window.__CF.plans['商品自选'] || []).map((p) => ({ id: p.id, checked: p.checked })),
  }));
  await pageRef.close().catch(() => {});
  return { result, state };
}

// ── 开启正常路径 / 幂等 ─────────────────────────────────────────────

test('开启正常：全店托管1条关闭 + 商品自选23条关闭 → 全部开启，allEnabledConfirmed=true', async () => {
  const { result, state } = await runEnable({
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': ZIXUAN_CLOSED(23) } },
  });
  assert.strictEqual(result.allEnabledConfirmed, true, result.confirmReason);
  assert.strictEqual(result.views.tuoguan.confirmedCount, 1);
  assert.strictEqual(result.views.zixuan.confirmedCount, 23);
  assert.strictEqual(switchClicks(state).length, 1, '全店托管行开关点击一次');
  assert.strictEqual(enableClicks(state).length, 1, '商品自选批量开启一次');
  assert.strictEqual(deleteClicks(state).length, 0, '删除零点击');
  assert.strictEqual(state.pageSize, 100, '已切换 100条/页');
  assert.ok(state.plansTuoguan.every((p) => p.checked === true), '全店托管已开启');
  assert.ok(state.plansZixuan.every((p) => p.checked === true), '商品自选全部开启');
  assert.strictEqual(enableClicks(state)[0].ids.length, 23, '点击开启时选中 23 条');
});

test('开启幂等：已全部开启 → 托管 already_enabled 跳过，零点击', async () => {
  const { result, state } = await runEnable({
    fixture: { plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': ZIXUAN_PLANS(5) } },
  });
  assert.strictEqual(result.views.tuoguan.status, 'already_enabled');
  assert.strictEqual(switchClicks(state).length, 0, '已开启托管不再点击');
  assert.strictEqual(enableClicks(state).length, 0);
  assert.strictEqual(result.allEnabledConfirmed, true, result.confirmReason);
});

test('开启：两视图均空（已确认无计划）→ confirmed_empty，allEnabledConfirmed=true（无目标）', async () => {
  const { result, state } = await runEnable({
    fixture: { plans: { '全店托管': [], '商品自选': [] } },
  });
  assert.strictEqual(result.views.tuoguan.status, 'confirmed_empty');
  assert.strictEqual(result.views.zixuan.status, 'confirmed_empty');
  assert.strictEqual(result.allEnabledConfirmed, true, '无目标时视为已满足（无关闭对象）');
  assert.strictEqual(enableClicks(state).length, 0);
  assert.strictEqual(switchClicks(state).length, 0);
});

// ── 范围与按钮定位（开启只点开启）──────────────────────────────────

test('开启/暂停/删除并存：开启只点开启，暂停与删除均零点击', async () => {
  const { result, state } = await runEnable({
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN_CLOSED(5) } },
  });
  assert.strictEqual(result.allEnabledConfirmed, true, result.confirmReason);
  assert.strictEqual(enableClicks(state).length, 1, '只点开启');
  assert.strictEqual(pauseClicks(state).length, 0, '不点暂停');
  assert.strictEqual(deleteClicks(state).length, 0, '删除始终零点击');
});

test('开启按钮缺失：零点击停止，不报告全部开启', async () => {
  const { result, state } = await runEnable({
    fixture: {
      plans: { '全店托管': [], '商品自选': ZIXUAN_CLOSED(3) },
      batchButtons: { open: '' },
    },
  });
  assert.strictEqual(enableClicks(state).length, 0);
  assert.strictEqual(deleteClicks(state).length, 0);
  assert.strictEqual(result.allEnabledConfirmed, false);
  assert.match(result.confirmReason, /开启/);
});

test('开启按钮多候选：零点击停止', async () => {
  const { result, state } = await runEnable({
    fixture: {
      plans: { '全店托管': [], '商品自选': ZIXUAN_CLOSED(3) },
      batchButtons: {
        open: '<button data-auto-id="bar-groups-group-item-btn-open">开启</button><button data-auto-id="bar-groups-group-item-btn-open-x">开启</button>',
      },
    },
  });
  assert.strictEqual(enableClicks(state).length, 0);
  assert.strictEqual(result.allEnabledConfirmed, false);
  assert.match(result.confirmReason, /候选/);
});

test('开启按钮唯一但缺少稳定标识：拒绝模糊文本兜底，零点击', async () => {
  const { result, state } = await runEnable({
    fixture: {
      plans: { '全店托管': [], '商品自选': ZIXUAN_CLOSED(3) },
      batchButtons: { open: '<button>开启</button>' },
    },
  });
  assert.strictEqual(enableClicks(state).length, 0);
  assert.strictEqual(result.allEnabledConfirmed, false);
  assert.match(result.confirmReason, /可识别标记/);
});

// ── 开启门禁（realMode / enableEnabled）────────────────────────────

test('开启：realMode=false → 自动转演练（只枚举目标），零点击，不报告已开启', async () => {
  const { result, state } = await runEnable({
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': ZIXUAN_CLOSED(5) } },
    config: {
      execution: { realMode: false, dryRun: false },
      monitor: { chengfang: { scope: ['全店托管', '商品自选'], enableEnabled: true } },
    },
    dryRun: false,
  });
  assert.strictEqual(result.mode, 'dry-run');
  assert.strictEqual(result.dryRunTargets.length, 6, '枚举 1 托管 + 5 商品自选');
  assert.strictEqual(switchClicks(state).length, 0);
  assert.strictEqual(enableClicks(state).length, 0);
  assert.strictEqual(deleteClicks(state).length, 0);
  assert.strictEqual(result.allEnabledConfirmed, false, '演练不得宣称已开启');
  assert.match(result.confirmReason, /演练/);
});

test('开启：enableEnabled=false → 自动转演练，零点击', async () => {
  const { result, state } = await runEnable({
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN_CLOSED(3) } },
    config: {
      execution: { realMode: true, dryRun: false },
      monitor: { chengfang: { scope: ['全店托管', '商品自选'], enableEnabled: false } },
    },
    dryRun: false,
  });
  assert.strictEqual(result.mode, 'dry-run');
  assert.strictEqual(enableClicks(state).length, 0);
  assert.strictEqual(result.allEnabledConfirmed, false);
});

// ── 商品自选 100条/页 / 跨页 / 同名不同ID / 列表变化 ────────────────

test('开启：商品自选 120条/2页（100条每页）跨页全部开启，同名不同ID精确去重', async () => {
  const plans = ZIXUAN_CLOSED(120).map((p, i) => (
    i < 3 ? { ...p, name: '同名计划A' } : (i < 5 ? { ...p, name: '同名计划B' } : p)
  ));
  const { result, state } = await runEnable({
    fixture: { plans: { '全店托管': [], '商品自选': plans } },
  });
  assert.strictEqual(state.pageSize, 100);
  assert.strictEqual(result.allEnabledConfirmed, true, result.confirmReason);
  // 批量操作后平台回到第一页（fixture 重置 page=1）：第二页目标在逐页处理阶段以
  // notFound 记录，最终以全量回读（verifyAllEnabled）确认全部 120 条开启。
  assert.strictEqual(result.views.zixuan.confirmedCount, 120, '全量回读确认 120 条全部开启');
  assert.strictEqual(enableClicks(state).length, 2, '两页各一次批量开启');
  const ids = state.plansZixuan.map((p) => p.id);
  assert.strictEqual(new Set(ids).size, 120, '稳定ID无重复（同名不合并）');
  assert.ok(state.plansZixuan.every((p) => p.checked === true), '全部开启');
  assert.strictEqual(deleteClicks(state).length, 0);
});

test('开启：开启后列表收缩（行消失）→ missing 不谎报全部开启', async () => {
  const { result, state } = await runEnable({
    fixture: {
      plans: { '全店托管': [], '商品自选': ZIXUAN_CLOSED(23) },
      state: { shrink: true },
    },
  });
  assert.strictEqual(enableClicks(state).length, 1, '批量开启发出一次');
  assert.strictEqual(result.allEnabledConfirmed, false, '行消失无法确认开启，不报告全部开启');
  assert.ok((result.finalVerify && result.finalVerify.missing.length) >= 23, '全量回读如实报告缺失');
  assert.match(result.confirmReason, /找不到/);
});

test('开启：空清单缺分页总数证据 → read_failed，不当作无计划（零点击）', async () => {
  const { result, state } = await runEnable({
    fixture: { plans: { '全店托管': [], '商品自选': [] }, paginationMissing: true },
  });
  assert.strictEqual(result.views.tuoguan.status, 'read_failed');
  assert.strictEqual(result.allEnabledConfirmed, false);
  assert.strictEqual(enableClicks(state).length, 0);
  assert.strictEqual(deleteClicks(state).length, 0);
});

test('开启：翻页失败（hasNext=true 但 next 无效）→ 停止，不谎报全部开启', async () => {
  const { result } = await runEnable({
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN_CLOSED(120) } },
    controllerOverride: async (controller) => {
      const orig = controller.clickNextPage.bind(controller);
      controller.clickNextPage = async (p) => {
        await orig(p);
        return { clicked: false, reason: '翻页失效（测试注入）' };
      };
      return controller;
    },
  });
  assert.strictEqual(result.allEnabledConfirmed, false);
  assert.match(result.confirmReason, /翻页失败|停止/);
});

// ── 千川首次未落地 / 同会话恢复乘方 URL ────────────────────────────

test('千川首次开启未落地（first-noop）：同会话仅重试一次，第二次回读确认开启', async () => {
  const { result, state } = await runEnable({
    fixture: {
      plans: { '全店托管': [], '商品自选': ZIXUAN_CLOSED(5) },
      state: { enableEffect: 'first-noop' },
    },
  });
  assert.strictEqual(enableClicks(state).length, 2, '首次未落地 + 同会话重试一次');
  assert.strictEqual(result.allEnabledConfirmed, true, result.confirmReason);
  assert.strictEqual(result.views.zixuan.processedCount, 5);
  assert.strictEqual(deleteClicks(state).length, 0, '删除始终零点击');
  assert.ok(state.plansZixuan.every((p) => p.checked === true), '第二次后全部开启');
});

test('开启连续两次未生效（noop）：同会话仅重试一次后停止，不报告全部开启且不再点击', async () => {
  const { result, state } = await runEnable({
    fixture: {
      plans: { '全店托管': [], '商品自选': ZIXUAN_CLOSED(5) },
      state: { enableEffect: 'noop' },
    },
  });
  assert.strictEqual(enableClicks(state).length, 2, '首次 + 唯一一次同会话重试，绝无第三次');
  assert.strictEqual(result.allEnabledConfirmed, false);
  assert.match(result.confirmReason, /未生效/);
  assert.ok(state.plansZixuan.some((p) => p.checked === false), '平台未生效，行仍关闭');
  assert.strictEqual(deleteClicks(state).length, 0);
});

test('千川提交后跳回首页：同会话恢复到记录的乘方 URL 回读并重试，最终确认开启', async () => {
  const enableClickCount = [];
  const { result, state } = await runEnable({
    fixture: {
      plans: { '全店托管': [], '商品自选': ZIXUAN_CLOSED(3) },
      state: { enableEffect: 'first-noop' }, // 首次点击确认但未落地 → 恢复后同会话重试一次
    },
    controllerOverride: async (controller) => {
      const orig = controller.verifyIdentity.bind(controller);
      let calls = 0;
      controller.verifyIdentity = async (p) => {
        calls += 1;
        if (calls === 3) return { ok: false, reason: '模拟提交后跳回首页（身份消失）' };
        return orig(p);
      };
      // page.goto 恢复会重建 fixture 的 __CF.clickLog → 用控制器包装计数"真正发出的开启点击"
      const origClick = controller.clickBatchEnable.bind(controller);
      controller.clickBatchEnable = async (p) => {
        enableClickCount.push(1);
        return origClick(p);
      };
      return controller;
    },
  });
  assert.strictEqual(result.allEnabledConfirmed, true, result.confirmReason);
  assert.strictEqual(enableClickCount.length, 2, '首次未落地 + 恢复到乘方URL后同会话重试一次成功（不重开浏览器）');
  assert.strictEqual(deleteClicks(state).length, 0);
});

test('恢复乘方管理页失败（持续非管理页）→ 结果未知，不报告全部开启，不再重试', async () => {
  const enableClickCount = [];
  const { result, state } = await runEnable({
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN_CLOSED(3) } },
    controllerOverride: async (controller) => {
      const orig = controller.verifyIdentity.bind(controller);
      let calls = 0;
      controller.verifyIdentity = async (p) => {
        calls += 1;
        if (calls >= 3) return { ok: false, reason: '持续不在乘方管理页（模拟恢复失败）' };
        return orig(p);
      };
      // page.goto 恢复会重建 fixture 的 __CF.clickLog → 用控制器包装计数已发出的开启点击
      const origClick = controller.clickBatchEnable.bind(controller);
      controller.clickBatchEnable = async (p) => {
        enableClickCount.push(1);
        return origClick(p);
      };
      return controller;
    },
  });
  assert.strictEqual(enableClickCount.length, 1, '首次开启已发出，恢复失败即停止，不再重试');
  assert.strictEqual(result.allEnabledConfirmed, false);
  assert.match(result.confirmReason, /无法恢复|回读/);
  assert.strictEqual(deleteClicks(state).length, 0);
});

test('开启：批量开启后强制新扫描回读失败 → 结果未知，不报告全部开启', async () => {
  const { result, state } = await runEnable({
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN_CLOSED(3) } },
    controllerOverride: async (controller) => {
      const orig = controller.readView.bind(controller);
      let zixuanReads = 0;
      controller.readView = async (p) => {
        const v = await orig(p);
        if (p.tab === '商品自选') {
          zixuanReads += 1;
          // 第 4 次商品自选读取 = 批量开启后的强制新扫描回读 → 注入失败
          if (zixuanReads === 4) return { tab: '商品自选', rows: { error: 'fixture 注入回读失败' }, pagination: null };
        }
        return v;
      };
      return controller;
    },
  });
  assert.strictEqual(enableClicks(state).length, 1, '开启点击已发出（结果以回读为准）');
  assert.strictEqual(result.allEnabledConfirmed, false, '回读失败不得判定全部开启');
  assert.match(result.confirmReason, /回读失败|结果未知/);
  assert.strictEqual(deleteClicks(state).length, 0);
});

// ── 开启前 / 最终身份复核期间中断 → 零点击 ─────────────────────────

test('开启：选择完成后收到停止 → 不发批量开启请求', async () => {
  let stopped = false;
  const { result, state } = await runEnable({
    fixture: { plans: { '全店托管': [], '商品自选': ZIXUAN_CLOSED(5) } },
    controllerOverride: async (controller) => {
      const orig = controller.readBatchBar.bind(controller);
      controller.readBatchBar = async (p) => {
        const r = await orig(p);
        stopped = true; // 选择完成后停止 → 点击前门槛拦截
        return r;
      };
      return controller;
    },
    stopRequested: () => stopped,
  });
  assert.strictEqual(enableClicks(state).length, 0);
  assert.strictEqual(result.allEnabledConfirmed, false);
  assert.match(result.confirmReason, /停止发出批量开启请求|停止/);
  assert.strictEqual(deleteClicks(state).length, 0);
});

test('开启：最终身份复核期间收到停止 → 复核返回后 requestGate 拦截，零业务点击', async () => {
  let stopped = false;
  let identityCalls = 0;
  const { result, state } = await runEnable({
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': [] } },
    stopRequested: () => stopped,
    controllerOverride: async (controller) => {
      const orig = controller.verifyIdentity.bind(controller);
      controller.verifyIdentity = async (p) => {
        identityCalls += 1;
        const r = await orig(p);
        if (identityCalls === 2) stopped = true; // 复核期间收到停止
        return r;
      };
      return controller;
    },
  });
  assert.ok(identityCalls >= 2, '身份复核确实发生（第二次调用）');
  assert.strictEqual(result.allEnabledConfirmed, false);
  assert.match(result.confirmReason, /停止/);
  assert.strictEqual(state.clickLog.length, 0, '零业务点击');
  assert.strictEqual(switchClicks(state).length, 0);
  assert.strictEqual(enableClicks(state).length, 0);
  assert.strictEqual(deleteClicks(state).length, 0);
});

test('开启：最终身份复核期间跨日（跨出开启窗口）→ 复核返回后 requestGate 拦截，零业务点击', async () => {
  let identityCalls = 0;
  let nowMs = shanghaiMs('2026-09-12', '07:30');
  const { result, state } = await runEnable({
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': [] } },
    businessDate: '2026-09-12',
    now: () => nowMs,
    controllerOverride: async (controller) => {
      const orig = controller.verifyIdentity.bind(controller);
      controller.verifyIdentity = async (p) => {
        identityCalls += 1;
        const r = await orig(p);
        if (identityCalls === 2) nowMs = shanghaiMs('2026-09-13', '08:00'); // 复核期间跨日且跨出窗口
        return r;
      };
      return controller;
    },
  });
  assert.ok(identityCalls >= 2, '身份复核确实发生（第二次调用）');
  assert.strictEqual(result.allEnabledConfirmed, false);
  assert.match(result.confirmReason, /跨日|开启时段/);
  assert.strictEqual(state.clickLog.length, 0, '零业务点击');
  assert.strictEqual(switchClicks(state).length, 0);
  assert.strictEqual(enableClicks(state).length, 0);
});

test('开启：最终身份复核期间页面账户变化 → 身份复检拦截，零业务点击', async () => {
  let identityCalls = 0;
  const { result, state } = await runEnable({
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': [] } },
    controllerOverride: async (controller) => {
      const orig = controller.verifyIdentity.bind(controller);
      controller.verifyIdentity = async (p) => {
        identityCalls += 1;
        if (identityCalls === 2) return { ok: false, reason: '页面账户与配置不一致（模拟切换账户）' };
        return orig(p);
      };
      return controller;
    },
  });
  assert.ok(identityCalls >= 2, '身份复核确实发生（第二次调用）');
  assert.strictEqual(result.allEnabledConfirmed, false);
  assert.match(result.confirmReason, /账户|身份/);
  assert.strictEqual(state.clickLog.length, 0, '零业务点击');
  assert.strictEqual(switchClicks(state).length, 0);
  assert.strictEqual(enableClicks(state).length, 0);
});

test('开启：最终身份复核期间关闭 enableEnabled → 复核返回后 requestGate 实时拦截，零业务点击', async () => {
  let identityCalls = 0;
  const config = {
    execution: { realMode: true, dryRun: false },
    monitor: { chengfang: { scope: ['全店托管', '商品自选'], enableEnabled: true } },
    schedule: { dailyStartHour: 8 },
  };
  const { result, state } = await runEnable({
    config,
    fixture: { plans: { '全店托管': [TUOGUAN_CLOSED], '商品自选': [] } },
    controllerOverride: async (controller) => {
      const orig = controller.verifyIdentity.bind(controller);
      controller.verifyIdentity = async (p) => {
        identityCalls += 1;
        const r = await orig(p);
        if (identityCalls === 2) config.monitor.chengfang.enableEnabled = false; // 复核期间关闭许可
        return r;
      };
      return controller;
    },
  });
  assert.ok(identityCalls >= 2, '身份复核确实发生（第二次调用）');
  assert.strictEqual(result.allEnabledConfirmed, false);
  assert.match(result.confirmReason, /enableEnabled/);
  assert.strictEqual(state.clickLog.length, 0, '零业务点击');
  assert.strictEqual(switchClicks(state).length, 0);
  assert.strictEqual(enableClicks(state).length, 0);
});
