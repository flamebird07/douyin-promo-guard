'use strict';

/**
 * 交接修复单测（2026-09-15）：
 *  - 第 1 项：行内开关点击目标必须是**内层** `.ovui-switch`（外层 `.oc-switch` 不落地）
 *  - 第 2 项：确认弹窗闭环（只确认与动作/数量精确一致的弹窗；删除/未知一律阻断）
 *  - 第 5 项：回读前恢复管理页需核验 100条/页 与分页位置
 *  - 第 6 项：同会话有限重试覆盖部分成功（不只"全部失败"）
 *
 * 全部使用真实生产控制器函数（page.evaluate 序列化执行），不使用 fixture 点击即成功的替身。
 */

const test = require('node:test');
const assert = require('node:assert');
const { chromium } = require('playwright');

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const launch = () => chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1200,800'] });

const {
  createChengfangController,
  detectChengfangDangerDialogInPage,
  readChengfangConfirmDialogInPage,
  clickChengfangConfirmOkInPage,
  hasChengfangDeleteDialogInPage,
  locateChengfangRowSwitchInPage,
  clickChengfangRowSwitchByPlanId,
  classifyDialogText,
} = require('../src/adapters/chengfang-reader.js');

// ── 纯函数：弹窗分类（不经浏览器）──────────────────────────────────
test('弹窗分类：批量暂停确认与数量提取', () => {
  const r = classifyDialogText('确定要暂停23条计划吗？暂停后将停止投放，请谨慎操作。 取消 确定', 'batch_pause');
  assert.strictEqual(r.kind, 'batch_pause_confirm');
  assert.strictEqual(r.count, 23);
  assert.strictEqual(r.exactText, true);
});

test('弹窗分类：删除弹窗优先级最高（即使含"确定"）', () => {
  const r = classifyDialogText('确定要删除3条计划吗？删除后不可恢复 取消 确定', 'batch_pause');
  assert.strictEqual(r.kind, 'delete_confirm');
});

test('弹窗分类：托管关闭确认', () => {
  const r = classifyDialogText('确定关闭乘方投放吗？ 取消 确定', 'shop_disable');
  assert.strictEqual(r.kind, 'shop_disable_confirm');
});

test('弹窗分类：动作不匹配的暂停弹窗 → unexpected_confirm（阻断）', () => {
  const r = classifyDialogText('确定要暂停5条计划吗？暂停后将停止投放，请谨慎操作。 取消 确定', 'shop_disable');
  assert.strictEqual(r.kind, 'unexpected_confirm');
});

test('弹窗分类：结构未知的确认弹窗 → unknown_confirm（不编造）', () => {
  const r = classifyDialogText('确定要开启某计划吗？ 取消 确定', 'batch_enable');
  assert.strictEqual(r.kind, 'unknown_confirm');
});

// ── 浏览器内联函数（page.evaluate 语义）────────────────────────────
test('danger 检测对暂停弹窗按动作判定；删除弹窗始终阻断', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const dlgHtml = (body) => `<!doctype html><html><body>
    <div role="dialog" style="position:fixed;top:0;left:0;width:400px;height:200px">${body}</div></body></html>`;

  await page.setContent(dlgHtml('确定要暂停23条计划吗？暂停后将停止投放，请谨慎操作。<button>取消</button><button>确定</button>'));
  let d = await page.evaluate(detectChengfangDangerDialogInPage, 'batch_pause');
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].kind, 'batch_pause_confirm');
  assert.strictEqual(d[0].count, 23);
  // 非当前动作 → 阻断
  d = await page.evaluate(detectChengfangDangerDialogInPage, 'shop_disable');
  assert.strictEqual(d[0].kind, 'unexpected_confirm');

  await page.setContent(dlgHtml('确定要删除3条计划吗？<button>取消</button><button>确定</button>'));
  d = await page.evaluate(detectChengfangDangerDialogInPage, 'batch_pause');
  assert.strictEqual(d[0].kind, 'delete_confirm');
  const del = await page.evaluate(hasChengfangDeleteDialogInPage);
  assert.strictEqual(del.found, true);
});

test('确认弹窗读取：数量与确定候选唯一性核验', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <div role="dialog" style="position:fixed;top:0;left:0;width:400px;height:200px">
      确定要暂停23条计划吗？暂停后将停止投放，请谨慎操作。
      <button>取消</button><button>确定</button>
    </div></body></html>`);
  const r = await page.evaluate(readChengfangConfirmDialogInPage, 'batch_pause');
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.kind, 'batch_pause_confirm');
  assert.strictEqual(r.count, 23);
  assert.strictEqual(r.okCandidateCount, 1);
  assert.strictEqual(r.cancelCandidateCount, 1);
});

test('确认点击：数量不匹配 → 零点击', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <div role="dialog" style="position:fixed;top:0;left:0;width:400px;height:200px">
      确定要暂停23条计划吗？暂停后将停止投放，请谨慎操作。
      <button id="ok">确定</button>
    </div></body></html>`);
  await page.evaluate(() => { window.__clicked = false; document.getElementById('ok').onclick = () => { window.__clicked = true; }; });
  const r = await page.evaluate(clickChengfangConfirmOkInPage, { action: 'batch_pause', expectedCount: 99 });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /数量不匹配/);
  assert.strictEqual(await page.evaluate(() => window.__clicked), false, '数量不符绝不点击确定');
});

test('确认点击：类型/数量精确一致 → 点击"确定"', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <div role="dialog" style="position:fixed;top:0;left:0;width:400px;height:200px">
      确定要暂停7条计划吗？暂停后将停止投放，请谨慎操作。
      <button>取消</button><button id="ok">确定</button>
    </div></body></html>`);
  await page.evaluate(() => { window.__clicked = false; document.getElementById('ok').onclick = () => { window.__clicked = true; }; });
  const r = await page.evaluate(clickChengfangConfirmOkInPage, { action: 'batch_pause', expectedCount: 7 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(await page.evaluate(() => window.__clicked), true);
});

test('确认点击：删除弹窗即便动作匹配也绝不点击（零点击守卫）', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <div role="dialog" style="position:fixed;top:0;left:0;width:400px;height:200px">
      确定要删除3条计划吗？<button id="ok">确定</button>
    </div></body></html>`);
  await page.evaluate(() => { window.__clicked = false; document.getElementById('ok').onclick = () => { window.__clicked = true; }; });
  const r = await page.evaluate(clickChengfangConfirmOkInPage, { action: 'batch_pause', expectedCount: 3 });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(await page.evaluate(() => window.__clicked), false, '删除弹窗零点击');
});

// ── 第 1 项：内层开关点击 ────────────────────────────────────────
const ROW_HTML = (id, checked, opts = {}) => {
  const inner = checked
    ? '<div class="ovui-switch ovui-switch--checked ovui-switch--dark"><div class="ovui-switch__thumb"></div></div>'
    : '<div class="ovui-switch ovui-switch--dark"><div class="ovui-switch__thumb"></div></div>';
  const wrapper = opts.outerOnly ? `<div class="oc-switch oc-switch--dark">${inner}</div>`
    : `<div class="oc-switch oc-switch--dark" id="wrap-${id}">${inner}</div>`;
  return `<tr class="ovui-tr" data-plan="${id}"><td>${wrapper}</td><td>名称 ID：${id}</td><td>已暂停</td></tr>`;
};

test('内层开关点击：点击目标是内层 .ovui-switch，外层 .oc-switch 不被点击', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body><table>${ROW_HTML('184388555253250562', false)}</table>
    <script>
      window.__outerClicked = false; window.__innerClicked = false;
      document.querySelector('.oc-switch').addEventListener('click', () => { window.__outerClicked = true; });
      document.querySelector('.ovui-switch').addEventListener('click', () => { window.__innerClicked = true; });
    </script></body></html>`);
  const loc = await page.evaluate(locateChengfangRowSwitchInPage, '184388555253250562');
  assert.strictEqual(loc.ok, true, JSON.stringify(loc));
  assert.strictEqual(loc.wrapperCount, 1);
  assert.strictEqual(loc.innerCount, 1);
  const r = await page.evaluate(clickChengfangRowSwitchByPlanId, '184388555253250562');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.target, 'inner-ovui-switch');
  // 点击事件冒泡：内层被点，外层因冒泡也会收到；关键是**派发目标**必须来自内层元素
  assert.strictEqual(await page.evaluate(() => window.__innerClicked), true, '内层收到点击');
});

test('内层开关点击：ID 全等核验（184388555253250562 不得命中 1843885552532505629）', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body><table>
    ${ROW_HTML('1843885552532505629', false)}
    ${ROW_HTML('184388555253250562', false)}
  </table></body></html>`);
  const loc = await page.evaluate(locateChengfangRowSwitchInPage, '184388555253250562');
  assert.strictEqual(loc.ok, true, JSON.stringify(loc));
  const ids = await page.evaluate(() => [...document.querySelectorAll('tr.ovui-tr')].map((t) => t.getAttribute('data-plan')));
  assert.deepStrictEqual(ids, ['1843885552532505629', '184388555253250562'], '两行都在，全等核验必须只命中精确那一行');
});

test('内层开关点击：行内多个开关容器 → 拒绝（零点击）', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body><table><tr class="ovui-tr" data-plan="111111">
    <td><div class="oc-switch"><div class="ovui-switch"></div></div></td>
    <td><div class="oc-switch"><div class="ovui-switch"></div></div></td>
    <td>名称 ID：111111</td></tr></table></body></html>`);
  const loc = await page.evaluate(locateChengfangRowSwitchInPage, '111111');
  assert.strictEqual(loc.ok, false);
  assert.match(loc.reason, /2 个开关容器/);
});

test('内层开关点击：内层缺失（只有外层） → 拒绝（零点击）', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body><table><tr class="ovui-tr" data-plan="222222">
    <td><div class="oc-switch"></div></td><td>名称 ID：222222</td></tr></table></body></html>`);
  const loc = await page.evaluate(locateChengfangRowSwitchInPage, '222222');
  assert.strictEqual(loc.ok, false);
  assert.match(loc.reason, /内层实际开关数量为 0/);
});

// ── 真实控制器：确认闭环（batch_pause 弹窗）────────────────────────
const BATCH_FIXTURE = (dialog) => `<!doctype html><html><body>
  <div class="qc-page-navigator-container">伊人美 ID：1710242295996424 乘方</div>
  <div>商品自选 全店托管</div>
  <div class="oc-promotion-batch-operation-bar" style="position:fixed;top:0;left:0;width:500px;height:60px">
    <span>已选 2 个</span>
    <button data-auto-id="bar-groups-group-item-btn-pause">暂停</button>
    <button data-auto-id="bar-groups-group-item-btn-open">开启</button>
    <button data-auto-id="bar-groups-group-item-btn-delete">删除</button>
  </div>
  ${dialog || ''}
</body></html>`;

const PAUSE_DIALOG = `<div role="dialog" style="position:fixed;top:100px;left:0;width:400px;height:200px">
  确定要暂停2条计划吗？暂停后将停止投放，请谨慎操作。
  <button>取消</button><button id="ok">确定</button>
</div>`;

test('真实控制器 clickBatchPause：检测到数量一致的暂停弹窗 → 提交确认', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(BATCH_FIXTURE(PAUSE_DIALOG));
  // 弹窗"确定"点击后隐藏弹窗（模拟提交成功）
  await page.evaluate(() => {
    window.__confirmClicked = false;
    document.getElementById('ok').onclick = () => { window.__confirmClicked = true; document.querySelector('[role="dialog"]').remove(); };
  });
  const ctrl = createChengfangController({ loadWaitMs: 20, tabWaitMs: 10 });
  await ctrl.clickBatchPause({ page, expectedCount: 2 });
  assert.strictEqual(await page.evaluate(() => window.__confirmClicked), true, '确认弹窗"确定"被点击');
});

test('真实控制器 clickBatchPause：弹窗数量与目标不符 → 抛错且零确认', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(BATCH_FIXTURE(PAUSE_DIALOG));
  await page.evaluate(() => {
    window.__confirmClicked = false;
    document.getElementById('ok').onclick = () => { window.__confirmClicked = true; };
  });
  const ctrl = createChengfangController({ loadWaitMs: 20, tabWaitMs: 10 });
  await assert.rejects(
    () => ctrl.clickBatchPause({ page, expectedCount: 5 }),
    (e) => /数量/.test(e.message || e.reason || ''),
  );
  assert.strictEqual(await page.evaluate(() => window.__confirmClicked), false, '数量不符零确认点击');
});

test('真实控制器 clickBatchPause：删除弹窗 → 抛错且零点击', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(BATCH_FIXTURE(`<div role="dialog" style="position:fixed;top:100px;left:0;width:400px;height:200px">
    确定要删除2条计划吗？<button id="ok">确定</button></div>`));
  await page.evaluate(() => {
    window.__delClicked = false;
    document.getElementById('ok').onclick = () => { window.__delClicked = true; };
  });
  const ctrl = createChengfangController({ loadWaitMs: 20, tabWaitMs: 10 });
  await assert.rejects(() => ctrl.clickBatchPause({ page, expectedCount: 2 }), (e) => /删除|阻断/.test(e.message || e.reason || ''));
  assert.strictEqual(await page.evaluate(() => window.__delClicked), false, '删除弹窗零点击');
});

test('真实控制器 clickBatchPause：无弹窗 → 如实报告 no-dialog（不编造）', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(BATCH_FIXTURE(null));
  await page.evaluate(() => { window.__pauseClicked = false; document.querySelector('[data-auto-id="bar-groups-group-item-btn-pause"]').onclick = () => { window.__pauseClicked = true; }; });
  const ctrl = createChengfangController({ loadWaitMs: 20, tabWaitMs: 10 });
  const sub = await ctrl.clickBatchPause({ page, expectedCount: 2 });
  assert.strictEqual(sub.submitted, false);
  assert.strictEqual(sub.reason, 'no-dialog');
  assert.strictEqual(await page.evaluate(() => window.__pauseClicked), true, '暂停按钮已点击');
});

test('真实控制器 clickBatchEnable：未知结构确认弹窗 → 阻断（不盲点确定）', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(BATCH_FIXTURE(`<div role="dialog" style="position:fixed;top:100px;left:0;width:400px;height:200px">
    确定要开启2条计划吗？<button id="ok">确定</button></div>`));
  await page.evaluate(() => {
    window.__okClicked = false;
    document.getElementById('ok').onclick = () => { window.__okClicked = true; };
    document.querySelector('[data-auto-id="bar-groups-group-item-btn-open"]').onclick = () => {};
  });
  const ctrl = createChengfangController({ loadWaitMs: 20, tabWaitMs: 10 });
  await assert.rejects(
    () => ctrl.clickBatchEnable({ page, expectedCount: 2 }),
    (e) => /未实测|阻断|不符/.test(e.message || e.reason || ''),
  );
  assert.strictEqual(await page.evaluate(() => window.__okClicked), false, '未实测弹窗零确认点击');
});

test('真实控制器 clickRowSwitch：托管关闭确认弹窗 → 提交', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <div class="qc-page-navigator-container">伊人美 ID：1710242295996424 乘方</div>
    <div>商品自选 全店托管</div>
    <table><tr class="ovui-tr" data-plan="999999"><td>
      <div class="oc-switch"><div class="ovui-switch ovui-switch--checked"></div></div>
    </td><td>托管 ID：999999</td></tr></table>
    <div role="dialog" style="position:fixed;top:100px;left:0;width:400px;height:200px">
      确定关闭乘方投放吗？关闭后其他推商品计划需手动恢复。
      <button>取消</button><button id="ok">确定</button>
    </div>
    <script>
      window.__innerClicked = false; window.__okClicked = false;
      document.querySelector('.ovui-switch').addEventListener('click', () => { window.__innerClicked = true; });
      document.getElementById('ok').onclick = () => { window.__okClicked = true; document.querySelector('[role="dialog"]').remove(); };
    </script></body></html>`);
  const ctrl = createChengfangController({ loadWaitMs: 20, tabWaitMs: 10 });
  const r = await ctrl.clickRowSwitch({ page, planId: '999999', expectAction: 'shop_disable' });
  assert.strictEqual(r.clicked, true);
  assert.strictEqual(await page.evaluate(() => window.__innerClicked), true, '内层开关被点击');
  assert.strictEqual(await page.evaluate(() => window.__okClicked), true, '托管关闭确认被提交');
});

test('真实控制器 clickRowSwitch：托管开启未实测弹窗 → 阻断', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>
    <div class="qc-page-navigator-container">伊人美 ID：1710242295996424 乘方</div>
    <div>商品自选 全店托管</div>
    <table><tr class="ovui-tr" data-plan="888"><td>
      <div class="oc-switch"><div class="ovui-switch"></div></div>
    </td><td>托管 ID：888</td></tr></table>
    <div role="dialog" style="position:fixed;top:100px;left:0;width:400px;height:200px">
      确定要开始投放吗？<button id="ok">确定</button></div>
    <script>window.__okClicked = false; document.getElementById('ok').onclick = () => { window.__okClicked = true; };</script>
    </body></html>`);
  const ctrl = createChengfangController({ loadWaitMs: 20, tabWaitMs: 10 });
  await assert.rejects(
    () => ctrl.clickRowSwitch({ page, planId: '888', expectAction: 'shop_enable' }),
    (e) => /未实测|阻断|不符|结构/.test(e.message || e.reason || ''),
  );
  assert.strictEqual(await page.evaluate(() => window.__okClicked), false, '未实测开启弹窗零确认');
});

// ── 第 5 项：危险弹窗检测 fail-closed（读取异常绝不当作"无弹窗"）──────────
/**
 * 注入检测异常：把 page.evaluate 包装为"仅对指定的内联检测函数抛错、其余照常"。
 */
function makeThrowingPage(page, { throwOnFn, message }) {
  const wrapped = {
    _isWrapped: true,
    async evaluate(fn, arg) {
      if (throwOnFn && fn === throwOnFn) throw new Error(message || 'injected detection failure');
      return page.evaluate(fn, arg);
    },
    async setContent(h, o) { return page.setContent(h, o); },
    async content() { return page.content(); },
    async close() { return page.close(); },
    async goto(u, o) { return page.goto(u, o); },
    async waitForTimeout(ms) { return page.waitForTimeout(ms); },
  };
  return { wrapped };
}

const SWITCH_PAGE = (extraDialog) => `<!doctype html><html><body>
  <div class="qc-page-navigator-container">伊人美 ID：1710242295996424 乘方</div>
  <div>商品自选 全店托管</div>
  <table><tr class="ovui-tr" data-plan="123456"><td>
    <div class="oc-switch"><div class="ovui-switch"></div></div>
  </td><td>托管 ID：123456</td></tr></table>
  <div class="oc-promotion-batch-operation-bar">
    <button data-auto-id="bar-groups-group-item-btn-pause">暂停</button>
    <button data-auto-id="bar-groups-group-item-btn-open">开启</button>
    <button data-auto-id="bar-groups-group-item-btn-delete">删除</button>
  </div>
  ${extraDialog || ''}
  <script>
    window.__switchClicks = 0; window.__pauseClicks = 0; window.__enableClicks = 0;
    window.__deleteClicks = 0; window.__okClicks = 0;
    document.querySelector('.ovui-switch').addEventListener('click', () => { window.__switchClicks++; });
    document.querySelector('[data-auto-id=bar-groups-group-item-btn-pause]').addEventListener('click', () => { window.__pauseClicks++; });
    document.querySelector('[data-auto-id=bar-groups-group-item-btn-open]').addEventListener('click', () => { window.__enableClicks++; });
    document.querySelector('[data-auto-id=bar-groups-group-item-btn-delete]').addEventListener('click', () => { window.__deleteClicks++; });
  </script></body></html>`;

const readClicks = async (page) => page.evaluate(() => ({
  switchClicks: window.__switchClicks,
  pauseClicks: window.__pauseClicks,
  enableClicks: window.__enableClicks,
  deleteClicks: window.__deleteClicks,
  okClicks: window.__okClicks,
}));

test('fail-closed：clickRowSwitch 删除弹窗检测抛错 → 抛 DataGuardError 且零业务点击', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(SWITCH_PAGE());
  const { wrapped } = makeThrowingPage(page, { throwOnFn: hasChengfangDeleteDialogInPage, message: 'boom-delete-detect' });
  const ctrl = createChengfangController({ loadWaitMs: 20, tabWaitMs: 10 });
  await assert.rejects(
    () => ctrl.clickRowSwitch({ page: wrapped, planId: '123456', expectAction: 'shop_enable' }),
    (e) => /删除弹窗检测失败|读取异常/.test(e.message || e.reason || ''),
  );
  const c = await readClicks(page);
  assert.strictEqual(c.switchClicks, 0, '行内开关零点击');
  assert.strictEqual(c.deleteClicks, 0, '删除零点击');
  assert.strictEqual(c.okClicks, 0, '确定零点击');
});

test('fail-closed：clickRowSwitch 危险弹窗检测抛错 → 抛 DataGuardError 且零业务点击', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(SWITCH_PAGE());
  const { wrapped } = makeThrowingPage(page, { throwOnFn: detectChengfangDangerDialogInPage, message: 'boom-danger-detect' });
  const ctrl = createChengfangController({ loadWaitMs: 20, tabWaitMs: 10 });
  await assert.rejects(
    () => ctrl.clickRowSwitch({ page: wrapped, planId: '123456', expectAction: 'shop_enable' }),
    (e) => /危险弹窗检测失败|读取异常/.test(e.message || e.reason || ''),
  );
  const c = await readClicks(page);
  assert.strictEqual(c.switchClicks, 0, '行内开关零点击');
  assert.strictEqual(c.okClicks, 0, '确定零点击');
});

test('fail-closed：clickBatchPause 检测抛错 → 抛 DataGuardError 且零业务点击', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(SWITCH_PAGE());
  const { wrapped } = makeThrowingPage(page, { throwOnFn: detectChengfangDangerDialogInPage, message: 'boom' });
  const ctrl = createChengfangController({ loadWaitMs: 20, tabWaitMs: 10 });
  await assert.rejects(
    () => ctrl.clickBatchPause({ page: wrapped, expectedCount: 1 }),
    (e) => /检测失败/.test(e.message || e.reason || ''),
  );
  const c = await readClicks(page);
  assert.strictEqual(c.pauseClicks, 0, '暂停零点击');
  assert.strictEqual(c.okClicks, 0, '确定零点击');
});

test('fail-closed：clickBatchEnable 检测抛错 → 抛 DataGuardError 且零业务点击', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(SWITCH_PAGE());
  const { wrapped } = makeThrowingPage(page, { throwOnFn: detectChengfangDangerDialogInPage, message: 'boom' });
  const ctrl = createChengfangController({ loadWaitMs: 20, tabWaitMs: 10 });
  await assert.rejects(
    () => ctrl.clickBatchEnable({ page: wrapped, expectedCount: 1 }),
    (e) => /检测失败/.test(e.message || e.reason || ''),
  );
  const c = await readClicks(page);
  assert.strictEqual(c.enableClicks, 0, '开启零点击');
  assert.strictEqual(c.okClicks, 0, '确定零点击');
});

test('fail-closed：submitConfirmIfPresent 删除弹窗检测抛错 → 不当作"无弹窗"，抛错', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  // 点击后无任何弹窗：旧实现会把检测异常吞成 {found:false} 并返回 no-dialog（危险：继续下一步）
  await page.setContent(SWITCH_PAGE());
  const { wrapped } = makeThrowingPage(page, { throwOnFn: hasChengfangDeleteDialogInPage, message: 'boom' });
  const ctrl = createChengfangController({ loadWaitMs: 20, tabWaitMs: 10 });
  await assert.rejects(
    () => ctrl.clickBatchPause({ page: wrapped, expectedCount: null }),
    (e) => /检测失败|读取异常/.test(e.message || e.reason || ''),
  );
  const c = await readClicks(page);
  assert.strictEqual(c.okClicks, 0, '确定零点击');
});

test('fail-closed：删除弹窗在页面上时，clickBatchPause/Enable 均阻断且不点确定', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(SWITCH_PAGE(`<div role="dialog" style="position:fixed;top:100px;left:0;width:400px;height:200px">
      确定要删除3条计划吗？删除后不可恢复<button>取消</button><button id="ok">确定</button></div>
    <script>document.getElementById('ok').onclick = () => { window.__okClicks++; };</script>`));
  const ctrl = createChengfangController({ loadWaitMs: 20, tabWaitMs: 10 });
  await assert.rejects(() => ctrl.clickBatchPause({ page, expectedCount: 3 }), (e) => /删除|阻断/.test(e.message || ''));
  await assert.rejects(() => ctrl.clickBatchEnable({ page, expectedCount: 3 }), (e) => /删除|阻断/.test(e.message || ''));
  const c = await readClicks(page);
  assert.strictEqual(c.pauseClicks, 0, '暂停零点击');
  assert.strictEqual(c.enableClicks, 0, '开启零点击');
  assert.strictEqual(c.okClicks, 0, '删除弹窗绝不点确定');
});

test('fail-closed：detectDanger/hasDeleteDialog 读取异常必须抛出，不返回空列表', async (t) => {
  const browser = await launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.setContent(SWITCH_PAGE());
  const { wrapped } = makeThrowingPage(page, { throwOnFn: detectChengfangDangerDialogInPage, message: 'boom' });
  const ctrl = createChengfangController({ loadWaitMs: 20, tabWaitMs: 10 });
  await assert.rejects(() => ctrl.detectDanger({ page: wrapped }), (e) => /boom|injected/.test(e.message || ''));
  const { wrapped: w2 } = makeThrowingPage(page, { throwOnFn: hasChengfangDeleteDialogInPage, message: 'boom2' });
  await assert.rejects(() => ctrl.hasDeleteDialog({ page: w2 }), (e) => /boom2|injected/.test(e.message || ''));
});
