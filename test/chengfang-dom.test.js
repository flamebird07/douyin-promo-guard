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
  clickChengfangSubTab,
  readChengfangBatchBarInPage,
  advanceChengfangPlanViewInPage,
  readChengfangAccountInPage,
  parseBalanceTextToCents,
  readQianchuanBalanceInPage,
  balanceCentsFromPageResult,
  createChengfangController,
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

test('新账户乘方页：关闭介绍浮层 → 商品 → 计划视图后才出现控制子标签', async () => {
  await page.setContent(`
    <div data-e2e="oc_emptyKey_overall-prom" class="ocean-vmok-plugin-oc-modal-wrap" id="intro">
      <div class="tools-vmok-plugin-modal__close-icon" id="close-intro">关闭</div>
    </div>
    <div role="tab" aria-selected="false" id="product">商品</div>
    <div role="tab" aria-selected="false" id="plan" hidden>计划视图</div>
    <div id="subtabs"></div>
    <script>
      document.getElementById('close-intro').onclick = () => document.getElementById('intro').remove();
      document.getElementById('product').onclick = () => {
        document.getElementById('product').setAttribute('aria-selected', 'true');
        document.getElementById('plan').hidden = false;
      };
      document.getElementById('plan').onclick = () => {
        document.getElementById('plan').setAttribute('aria-selected', 'true');
        document.getElementById('subtabs').innerHTML = '<div role="tab">商品自选</div><div role="tab">全店托管</div>';
      };
    </script>`);
  assert.strictEqual((await page.evaluate(advanceChengfangPlanViewInPage)).action, 'dismiss-intro');
  assert.strictEqual((await page.evaluate(advanceChengfangPlanViewInPage)).action, 'open-product');
  assert.strictEqual((await page.evaluate(advanceChengfangPlanViewInPage)).action, 'open-plan-view');
  assert.strictEqual((await page.evaluate(readChengfangAccountInPage)).hasSubTabs, true);
  assert.strictEqual((await page.evaluate(advanceChengfangPlanViewInPage)).action, 'none');
});

test('商品行文字不能冒充计划标签；引导只点唯一跳过按钮', async () => {
  await page.setContent('<div>商品自选</div><div>全店托管</div><div role="dialog" id="guide"><p>产品引导</p><button onclick="this.parentElement.remove()"><span>跳过</span></button></div><button id="other">跳过</button>');
  assert.equal((await page.evaluate(readChengfangAccountInPage)).hasSubTabs, false);
  assert.equal((await page.evaluate(advanceChengfangPlanViewInPage)).action, 'skip-guide');
  assert.equal(await page.locator('#guide').count(), 0);
  assert.equal(await page.locator('#other').count(), 1);
});

// ── 新 UI 子视图单选组（2026-09-27 实页证据：计划视图下两子视图是 aurora 单选组）──

/**
 * 实页结构复刻（cf-deep-1790476750352.json）：
 * div.tabs-* > .aurora-qc-radio-group > .aurora-qc-radio-button-wrapper（选中者带
 * -checked 后缀，内含 input[type=radio]）+ span.aurora-qc-radio-button-label。
 * -checked 类由"React"在点击后 100ms 异步更新（模拟实页异步重渲染，考验轮询核对）。
 */
function radioGroupFixtureHtml(opts = {}) {
  const zxChecked = opts.checked === '商品自选';
  const tgChecked = opts.checked !== '商品自选'; // 实页默认选中"全店托管"
  const wrap = (id, label, checked, extra = '') =>
    `<div class="aurora-qc-radio-button-wrapper${checked ? ' aurora-qc-radio-button-wrapper-checked' : ''}" id="${id}-wrap">`
    + (opts.noInput ? '' : `<input type="radio" name="_r_ci_" value="${id}" id="${id}-input"${checked ? ' checked' : ''}${extra}>`)
    + `<span class="aurora-qc-radio-button-label">${label}</span></div>`;
  return `<!DOCTYPE html><html><body>
    <div role="tab" aria-selected="true">商品</div>
    <div role="tab" aria-selected="true">计划视图</div>
    <div class="tabs-BBBF4_"><div class="aurora-qc-radio-group aurora-qc-radio-group-outline" id="group">
      ${wrap('zx', '商品自选', zxChecked, opts.zxDisabled ? ' disabled' : '')}
      ${wrap('tg', '全店托管', tgChecked)}
    </div></div>
    <div class="aurora-qc-table"><table><tbody class="aurora-qc-table-tbody">
      <tr data-row-key="187585998140533930"><td><span class="aurora-qc-tag-text">商品自选</span> 千川乘方_计划0</td></tr>
    </tbody></table></div>
    <script>
      window.__clicks = [];
      document.addEventListener('click', (e) => { window.__clicks.push(e.target.id || (e.target.tagName + ':' + e.target.className)); }, true);
      ${opts.noInput ? `
      document.getElementById('zx-wrap').addEventListener('click', () => {
        setTimeout(() => {
          document.getElementById('zx-wrap').classList.add('aurora-qc-radio-button-wrapper-checked');
          document.getElementById('tg-wrap').classList.remove('aurora-qc-radio-button-wrapper-checked');
        }, 100);
      });` : `
      for (const id of ['zx', 'tg']) {
        document.getElementById(id + '-input').addEventListener('click', () => {
          setTimeout(() => {
            document.getElementById('zx-wrap').classList.toggle('aurora-qc-radio-button-wrapper-checked', document.getElementById('zx-input').checked);
            document.getElementById('tg-wrap').classList.toggle('aurora-qc-radio-button-wrapper-checked', document.getElementById('tg-input').checked);
          }, 100);
        });
      }`}
    </script>
  </body></html>`;
}

test('新 UI 计划视图：子视图为 aurora 单选组 → hasSubTabs=true（表格/卡片同名字样不干扰）', async () => {
  await page.setContent(radioGroupFixtureHtml({ checked: '全店托管' }));
  const st = await page.evaluate(readChengfangAccountInPage);
  assert.strictEqual(st.hasSubTabs, true, '单选组两项须被识别为子视图导航');
});

test('新 UI 商品视图负例：仅商品卡片 .aurora-qc-tag-text 同名字样 → hasSubTabs=false', async () => {
  await page.setContent(`<!DOCTYPE html><html><body>
    <div role="tab" aria-selected="true">商品</div>
    <div role="tab" aria-selected="false">计划视图</div>
    <div class="aurora-qc-table"><table><tbody class="aurora-qc-table-tbody">
      <tr data-row-key="187585998140533900"><td><span class="aurora-qc-tag-text">商品自选</span> 卡片A</td></tr>
      <tr data-row-key="187585998140533901"><td><span class="aurora-qc-tag-text">全店托管</span> 卡片B</td></tr>
    </tbody></table></div>
  </body></html>`, { waitUntil: 'load' });
  const st = await page.evaluate(readChengfangAccountInPage);
  assert.strictEqual(st.hasSubTabs, false, '卡片文本（及其 tab 类表格容器）不得被误认成子视图导航');
});

test('新 UI 子视图切换：点击落在目标单选项 input，外层组容器零点击，选中态核对通过（两个方向 + 幂等）', async () => {
  await page.setContent(radioGroupFixtureHtml({ checked: '全店托管' }));
  // 方向 1：全店托管（默认）→ 商品自选
  const r1 = await page.evaluate(clickChengfangSubTab('商品自选'));
  assert.strictEqual(r1.clicked, true);
  assert.strictEqual(r1.target, 'aurora-radio');
  assert.strictEqual(r1.verified, true, '点击后须核对选中态（input.checked + 异步 -checked 类）');
  const clicks1 = await page.evaluate(() => window.__clicks);
  assert.ok(clicks1.includes('zx-input'), '点击必须落在目标单选项 input 上');
  assert.ok(!clicks1.some((c) => c.includes('group') || c.includes('tabs-BBBF4_') || c.includes('wrap')), '组容器/外层 tabs-* 容器/wrapper 均零点击');
  assert.strictEqual(await page.evaluate(() => document.getElementById('zx-input').checked), true, '目标 input 选中态已翻转');
  assert.strictEqual(await page.evaluate(() => document.getElementById('tg-input').checked), false);
  // 夹具模拟"React"在点击 100ms 后才更新 -checked 类（实页同为异步重渲染）
  await page.waitForTimeout(300);
  assert.strictEqual(await page.evaluate(() => document.getElementById('zx-wrap').className.includes('checked')), true, '异步 -checked 类已翻转');
  // 方向 2：商品自选 → 全店托管
  const r2 = await page.evaluate(clickChengfangSubTab('全店托管'));
  assert.strictEqual(r2.clicked, true);
  assert.strictEqual(r2.verified, true);
  const s2 = await page.evaluate(() => ({ zx: document.getElementById('zx-input').checked, tg: document.getElementById('tg-input').checked }));
  assert.deepStrictEqual(s2, { zx: false, tg: true });
  // 幂等：目标已选中 → alreadySelected，零新增点击
  const before = await page.evaluate(() => window.__clicks.length);
  const r3 = await page.evaluate(clickChengfangSubTab('全店托管'));
  assert.strictEqual(r3.clicked, true);
  assert.strictEqual(r3.alreadySelected, true);
  assert.strictEqual(await page.evaluate(() => window.__clicks.length), before, '已选中时不得再点击');
});

test('新 UI 子视图切换：点击后选中态未变化 → clicked=false（不得虚报成功）', async () => {
  // disabled input：点击派发但原生不激活、选中态不变 → 必须失败并如实报告
  await page.setContent(radioGroupFixtureHtml({ checked: '全店托管', zxDisabled: true }));
  const r = await page.evaluate(clickChengfangSubTab('商品自选'));
  assert.strictEqual(r.clicked, false);
  assert.match(r.reason, /未确认/);
  assert.strictEqual(await page.evaluate(() => document.getElementById('zx-input').checked), false, '选中态确实未变化');
});

test('新 UI 子视图切换（无 input 防御）：点击 wrapper 后 -checked 类异步更新 → 轮询核对通过', async () => {
  await page.setContent(radioGroupFixtureHtml({ checked: '全店托管', noInput: true }));
  const r = await page.evaluate(clickChengfangSubTab('商品自选'));
  assert.strictEqual(r.clicked, true);
  assert.strictEqual(r.target, 'aurora-radio');
  assert.strictEqual(r.verified, true, '100ms 后 -checked 类才更新，轮询须核对到');
  const clicks = await page.evaluate(() => window.__clicks);
  assert.ok(clicks.includes('zx-wrap'), '无 input 时点击落在目标 wrapper');
  assert.ok(!clicks.some((c) => c.includes('group') || c.includes('tabs-BBBF4_')), '组容器零点击');
});

test('旧 UI 兼容：ovui tab 结构仍被 hasSubTabs 识别并切换子标签', async () => {
  await page.setContent(`<!DOCTYPE html><html><body>
    <div class="ovui-tabs">
      <div class="ovui-tabs__tab" id="t-tg"><span class="ovui-tabs__tab-btn">全店托管</span></div>
      <div class="ovui-tabs__tab" id="t-zx"><span class="ovui-tabs__tab-btn">商品自选</span></div>
    </div>
    <div id="view">tg</div>
    <script>
      document.querySelectorAll('.ovui-tabs__tab').forEach((t) => {
        t.onclick = () => { document.getElementById('view').textContent = t.id.slice(2); };
      });
    </script>
  </body></html>`, { waitUntil: 'load' });
  assert.strictEqual((await page.evaluate(readChengfangAccountInPage)).hasSubTabs, true);
  const r = await page.evaluate(clickChengfangSubTab('商品自选'));
  assert.strictEqual(r.clicked, true);
  assert.strictEqual(await page.evaluate(() => document.getElementById('view').textContent), 'zx', '旧 UI tab 点击仍切换视图');
});

// ── 新 UI 双 tab 变体（2026-09-27 实页证据 clf-inspect.json：潮流服饰）─────────

/**
 * 实页结构复刻：点"商品"后直接是两个 role=tab——
 * "商品自选"（文本全等）与"全店托管加速新品爆发"（tab 内层 span.tabLabel 自身
 * 文本"全店托管" + "加速新品爆发"，整段 textContent 需前缀匹配）。无计划视图、
 * 无单选组。aria-selected 由"React"在点击后 100ms 异步更新（模拟实页异步重渲染）。
 */
function dualTabFixtureHtml(opts = {}) {
  const zxSel = opts.checked === '商品自选';
  const tgSel = opts.checked !== '商品自选'; // 实页默认"全店托管加速新品爆发"选中
  const zxTab = `<div class="aurora-qc-tabs-tab${zxSel ? ' aurora-qc-tabs-tab-active' : ''}" id="zx-tab"><div class="aurora-qc-tabs-tab-btn" role="tab" aria-selected="${zxSel}" id="zx-btn">商品自选</div></div>`;
  const tgTab = `<div class="aurora-qc-tabs-tab${tgSel ? ' aurora-qc-tabs-tab-active' : ''}" id="tg-tab"><div class="aurora-qc-tabs-tab-btn" role="tab" aria-selected="${tgSel}" id="tg-btn"><span class="tabLabel-Fake123"><span>全店托管</span></span><span class="tabExt-Fake123">加速新品爆发</span></div></div>`;
  const multi = opts.multiPrefix ? `<div class="aurora-qc-tabs-tab" id="tg2-tab"><div class="aurora-qc-tabs-tab-btn" role="tab" aria-selected="false" id="tg2-btn"><span class="tabLabel-Fake123"><span>全店托管</span></span><span class="tabExt-Fake123">另一种</span></div></div>` : '';
  return `<!DOCTYPE html><html><body>
    <div role="tab" aria-selected="true">商品</div>
    <div class="aurora-qc-tabs"><div class="aurora-qc-tabs-nav"><div class="aurora-qc-tabs-nav-list">
      ${zxTab}${tgTab}${multi}
    </div></div></div>
    <div class="aurora-qc-table"><table><tbody class="aurora-qc-table-tbody">
      <tr data-row-key="187585998140533900"><td><span class="aurora-qc-tag-text">全店托管</span> 千川乘方_计划0</td></tr>
    </tbody></table></div>
    <script>
      window.__clicks = [];
      document.addEventListener('click', (e) => { window.__clicks.push(e.target.id || (e.target.tagName + ':' + e.target.className)); }, true);
      ${opts.frozen ? '' : `
      for (const id of ['zx', 'tg']) {
        document.getElementById(id + '-tab').addEventListener('click', () => {
          setTimeout(() => {
            document.getElementById('zx-btn').setAttribute('aria-selected', String(id === 'zx'));
            document.getElementById('tg-btn').setAttribute('aria-selected', String(id === 'tg'));
            document.getElementById('zx-tab').classList.toggle('aurora-qc-tabs-tab-active', id === 'zx');
            document.getElementById('tg-tab').classList.toggle('aurora-qc-tabs-tab-active', id === 'tg');
          }, 100);
        });
      }`}
    </script>
  </body></html>`;
}

test('新 UI 双 tab 变体（潮流服饰）：前缀 role=tab 命中 → hasSubTabs=true（卡片同名字样仍不误报）', async () => {
  await page.setContent(dualTabFixtureHtml({ checked: '全店托管加速新品爆发' }));
  const st = await page.evaluate(readChengfangAccountInPage);
  assert.strictEqual(st.hasSubTabs, true, '双 role=tab 变体须被识别（含前缀"全店托管加速新品爆发"）');
});

test('新 UI 双 tab 变体切换：两方向点击真实 tab 控件并核对 aria-selected 翻转；已选中幂等零点击', async () => {
  await page.setContent(dualTabFixtureHtml({})); // 实页默认"全店托管加速新品爆发"选中
  // 方向 1：全店托管加速新品爆发（默认）→ 商品自选
  const r1 = await page.evaluate(clickChengfangSubTab('商品自选'));
  assert.strictEqual(r1.clicked, true);
  assert.strictEqual(r1.target, 'aurora-tab');
  assert.strictEqual(r1.verified, true, '点击后须核对 aria-selected（异步 100ms，轮询覆盖）');
  const clicks1 = await page.evaluate(() => window.__clicks);
  assert.ok(clicks1.includes('zx-btn'), '点击必须落在目标 tab 控件上');
  await page.waitForTimeout(300);
  assert.strictEqual(await page.evaluate(() => document.getElementById('zx-btn').getAttribute('aria-selected')), 'true');
  assert.strictEqual(await page.evaluate(() => document.getElementById('tg-btn').getAttribute('aria-selected')), 'false');
  // 方向 2：商品自选 → 全店托管（前缀命中"全店托管加速新品爆发"）
  const r2 = await page.evaluate(clickChengfangSubTab('全店托管'));
  assert.strictEqual(r2.clicked, true);
  assert.strictEqual(r2.verified, true);
  await page.waitForTimeout(300);
  assert.strictEqual(await page.evaluate(() => document.getElementById('tg-btn').getAttribute('aria-selected')), 'true');
  assert.strictEqual(await page.evaluate(() => document.getElementById('zx-btn').getAttribute('aria-selected')), 'false');
  // 幂等：目标已选中 → alreadySelected，零新增点击
  const before = await page.evaluate(() => window.__clicks.length);
  const r3 = await page.evaluate(clickChengfangSubTab('全店托管'));
  assert.strictEqual(r3.clicked, true);
  assert.strictEqual(r3.alreadySelected, true);
  assert.strictEqual(await page.evaluate(() => window.__clicks.length), before, '已选中时不得再点击');
});

test('新 UI 双 tab 变体：点击后 aria-selected 未翻转 → clicked=false（不虚报成功）', async () => {
  await page.setContent(dualTabFixtureHtml({ frozen: true })); // 无"React"模拟：点击后选中态不变
  const r = await page.evaluate(clickChengfangSubTab('商品自选'));
  assert.strictEqual(r.clicked, false);
  assert.match(r.reason, /未确认/);
  assert.strictEqual(await page.evaluate(() => document.getElementById('zx-btn').getAttribute('aria-selected')), 'false', '选中态确实未变化');
});

test('新 UI 双 tab 变体：前缀命中多个候选 → 拒绝猜测（clicked=false）', async () => {
  await page.setContent(dualTabFixtureHtml({ multiPrefix: true }));
  const r = await page.evaluate(clickChengfangSubTab('全店托管'));
  assert.strictEqual(r.clicked, false);
  assert.match(r.reason, /候选 2 个/);
});

// ── 千川可用余额（2026-09-27，账户级只读展示字段）─────────────────────────

/** 实页同构 DOM（bal-inspect.json）：infoItem 内 infoLabel + infoValue + 余额徽标 + 资金按钮。 */
const BAL_ITEM_HTML = (valueHtml) => `<div class="infoList-kJFfx6">
  <div class="infoItem-fWuH4T" id="bal-item">
    <div class="infoLabelReference-wfyTn5"></div>
    <div class="infoLabel-tcmJ_o" id="bal-label">千川可用余额(元)</div>
    <div class="infoContent-EIwyVr">${valueHtml}<div class="balanceSlot-Jygctx"><span class="aurora-qc-tag"><span class="aurora-qc-tag-text">余额不足</span></span></div></div>
    <button class="financeButton-Y06som" id="finance-btn"></button>
  </div>
  <div class="infoItem-fWuH4T"><div class="infoLabel-tcmJ_o">千川日预算(元)</div><div class="infoContent-EIwyVr"><div class="infoValue-TfdFGw" id="budget-val">不限</div></div></div>
</div>`;

const balPage = (valueHtml) => `<!DOCTYPE html><html><body>${BAL_ITEM_HTML(valueHtml)}
  <script>window.__clicks = []; document.addEventListener('click', (e) => window.__clicks.push(e.target.id || e.target.className), true);</script>
</body></html>`;

test('余额解析：0/1-2 位小数/千分位 → 安全整数分；其余一律 null（不编造 0）', () => {
  const f = parseBalanceTextToCents;
  assert.strictEqual(f('0'), 0, '真实零余额 = 0 分（与"未知"有明确区别）');
  assert.strictEqual(f('273.9'), 27390, '1 位小数补零到分');
  assert.strictEqual(f('298.05'), 29805);
  assert.strictEqual(f('1,234.56'), 123456, '千分位逗号容忍');
  assert.strictEqual(f('12345.6'), 1234560);
  assert.strictEqual(f(''), null);
  assert.strictEqual(f('abc'), null);
  assert.strictEqual(f('12.345'), null, '3 位小数不接受');
  assert.strictEqual(f('-5'), null);
  assert.strictEqual(f(null), null);
  assert.strictEqual(f('不限'), null, '日预算占位不得当余额');
});

test('余额读取（实页同构 DOM）：infoLabel/infoValue 配对取值；日预算/徽标/资金按钮零接触、零点击', async () => {
  await page.setContent(balPage('<div class="infoValue-TfdFGw" id="val">273.9</div>'));
  const r = await page.evaluate(readQianchuanBalanceInPage);
  assert.deepStrictEqual(r, { balanceText: '273.9', reason: null });
  assert.deepStrictEqual(balanceCentsFromPageResult(r), { balanceCents: 27390, balanceText: '273.9', reason: null });
  assert.strictEqual(await page.evaluate(() => window.__clicks.length), 0, '余额读取零点击');
});

test('余额读取：真实零余额 → 0 分（与"未知"有明确区别）', async () => {
  await page.setContent(balPage('<div class="infoValue-TfdFGw">0</div>'));
  const r = await page.evaluate(readQianchuanBalanceInPage);
  assert.strictEqual(r.balanceText, '0');
  assert.strictEqual(balanceCentsFromPageResult(r).balanceCents, 0);
});

test('余额读取 fail-closed：缺标签/双 item/重复数值/非法原文 → null 不编造', async () => {
  await page.setContent('<div class="infoItem-fWuH4T"><div class="infoContent-EIwyVr"><div class="infoValue-TfdFGw">273.9</div></div></div>');
  let r = await page.evaluate(readQianchuanBalanceInPage);
  assert.strictEqual(r.balanceText, null);
  assert.match(r.reason, /未找到/);
  await page.setContent(balPage('<div class="infoValue-TfdFGw">273.9</div>') + BAL_ITEM_HTML('<div class="infoValue-TfdFGw">100.00</div>'));
  r = await page.evaluate(readQianchuanBalanceInPage);
  assert.strictEqual(r.balanceText, null);
  assert.match(r.reason, /infoItem 有 2 个/);
  await page.setContent(balPage('<div class="infoValue-TfdFGw">273.9</div><div class="infoValue-TfdFGw">100.2</div>'));
  r = await page.evaluate(readQianchuanBalanceInPage);
  assert.strictEqual(r.balanceText, null);
  assert.match(r.reason, /数值叶子 2 个/);
  await page.setContent(balPage('<div class="infoValue-TfdFGw">abc</div>'));
  r = await page.evaluate(readQianchuanBalanceInPage);
  assert.strictEqual(r.balanceText, 'abc');
  const c = balanceCentsFromPageResult(r);
  assert.strictEqual(c.balanceCents, null);
  assert.match(c.reason, /无法解析/);
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

test('非预期确认弹窗（无"删除"字样）：检测为 unknown_confirm（一律阻断，不盲点确定）', async () => {
  await load({
    plans: { '全店托管': [TUOGUAN_PLAN], '商品自选': [] },
    dialog: '<div role="dialog" style="position:fixed;top:0;left:0;width:400px;height:200px"><span>确认执行操作？</span><button>确定</button></div>',
  });
  const d = await page.evaluate(detectChengfangDangerDialogInPage);
  assert.strictEqual(d.length, 1);
  // 交接第 2 项契约：未识别的确认弹窗必须归为 unknown_confirm 并阻断（绝不按其文案盲点"确定"）
  assert.strictEqual(d[0].kind, 'unknown_confirm');
  assert.ok(typeof d[0].text === 'string' && d[0].text.length > 0, `应保留弹窗原文供排查，实际：${d[0].text}`);
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

// ── verifyIdentity：账户 ID 可选观察（Cookie 归属）────────────────────

async function loadIdentityPage(navText, urlPath) {
  const html = `<!DOCTYPE html><html><body>
    <div class="qc-page-navigator-container">${navText}</div>
    <div role="tab">商品自选</div>
    <div role="tab">全店托管</div>
  </body></html>`;
  const p = await browser.newPage();
  await p.route('**/uni-prom/overall**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
  await p.goto(urlPath, { waitUntil: 'load' });
  return p;
}

test('verifyIdentity：账户 ID 缺失/不一致不因 ID 失败；错误 URL/缺子视图仍拒绝', async () => {
  const controller = createChengfangController({ loadWaitMs: 10, tabWaitMs: 5 });
  const shopCfg = { id: 'shop-iso-1', name: '隔离店', cookieFile: 'iso-ck', accountId: '1710242295996424' };
  const QC = 'https://qianchuan.jinritemai.com/uni-prom/overall?aavid=x';
  const BAD = 'https://qianchuan.jinritemai.com/home';

  // 1) 页面 ID 与配置不同 → ok
  let p = await loadIdentityPage('乘方 伊人美 ID：999000111222333', QC);
  let r = await controller.verifyIdentity({ page: p, shopCfg });
  assert.strictEqual(r.ok, true, `不得因 ID 不一致失败：${r.reason || ''}`);
  assert.strictEqual(String(r.pageAccountId), '999000111222333', '观察值原样保留');
  assert.notStrictEqual(String(r.pageAccountId), shopCfg.accountId);
  await p.close();

  // 2) 页面 ID 缺失 → ok
  p = await loadIdentityPage('乘方 伊人美', QC);
  r = await controller.verifyIdentity({ page: p, shopCfg });
  assert.strictEqual(r.ok, true, `不得因 ID 缺失失败：${r.reason || ''}`);
  assert.ok(!r.pageAccountId, '缺失不得伪造成配置 ID');
  await p.close();

  // 3) 错误 URL 仍拒绝
  p = await loadIdentityPage('乘方 伊人美 ID：1710242295996424', BAD);
  r = await controller.verifyIdentity({ page: p, shopCfg });
  assert.strictEqual(r.ok, false);
  assert.match(String(r.reason), /未在乘方管理页/);
  await p.close();

  // 4) 缺必需子视图仍拒绝
  const p2 = await browser.newPage();
  await p2.route('**/uni-prom/overall**', (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    body: '<html><body><div class="qc-page-navigator-container">乘方 伊人美 ID：1710242295996424</div></body></html>',
  }));
  await p2.goto(QC, { waitUntil: 'load' });
  r = await controller.verifyIdentity({ page: p2, shopCfg });
  assert.strictEqual(r.ok, false);
  assert.match(String(r.reason), /子标签/);
  await p2.close();
});

test('verifyIdentity：正确 URL + 两子视图但无乘方导航 → 必须拒绝', async () => {
  const controller = createChengfangController({ loadWaitMs: 10, tabWaitMs: 5 });
  const shopCfg = { id: 'shop-iso-2', name: '隔离店2', cookieFile: 'iso-ck2', accountId: '1710242295996424' };
  const QC = 'https://qianchuan.jinritemai.com/uni-prom/overall?aavid=x';
  // URL 正确、子视图齐全，但导航文本不含「乘方」
  const p = await browser.newPage();
  await p.route('**/uni-prom/overall**', (route) => route.fulfill({
    status: 200, contentType: 'text/html; charset=utf-8',
    body: `<!DOCTYPE html><html><body>
      <div class="qc-page-navigator-container">首页 全域投放 品牌投放 数据 工具 财务 伊人美 ID：1710242295996424</div>
      <div role="tab">商品自选</div>
      <div role="tab">全店托管</div>
    </body></html>`,
  }));
  await p.goto(QC, { waitUntil: 'load' });
  const st = await p.evaluate(readChengfangAccountInPage);
  assert.strictEqual(st.hasSubTabs, true, 'fixture 须具备两子视图');
  assert.strictEqual(st.hasChengfangNav, false, 'fixture 须无乘方导航');
  const r = await controller.verifyIdentity({ page: p, shopCfg });
  assert.strictEqual(r.ok, false, '正确 URL + 子视图仍不足以通过');
  assert.match(String(r.reason), /乘方导航/);
  await p.close();
});

test('verifyIdentity：有乘方导航时账户 ID 缺失/不同仍通过', async () => {
  const controller = createChengfangController({ loadWaitMs: 10, tabWaitMs: 5 });
  const shopCfg = { id: 'shop-iso-3', name: '隔离店3', cookieFile: 'iso-ck3', accountId: '1710242295996424' };
  const QC = 'https://qianchuan.jinritemai.com/uni-prom/overall?aavid=x';

  let p = await loadIdentityPage('乘方 伊人美', QC); // 有导航、无 ID
  let r = await controller.verifyIdentity({ page: p, shopCfg });
  assert.strictEqual(r.ok, true, `有导航+无 ID 应通过：${r.reason || ''}`);
  await p.close();

  p = await loadIdentityPage('乘方 伊人美 ID：999000111222333', QC); // 有导航、ID 不同
  r = await controller.verifyIdentity({ page: p, shopCfg });
  assert.strictEqual(r.ok, true, `有导航+ID 不同应通过：${r.reason || ''}`);
  assert.strictEqual(String(r.pageAccountId), '999000111222333');
  await p.close();
});
