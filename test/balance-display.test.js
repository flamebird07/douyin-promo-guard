'use strict';

/**
 * 千川可用余额展示链路隔离测试（2026-09-27 第 2 阶段展示收尾）：
 * - watch-drill buildShopRows 透传（两店不同余额 / 同账户两店各显同值不叠加 / 缺失 → null）
 * - bill-manager/index.html 真实渲染（Playwright 本地文件加载 + 路由拦截 /api 响应；
 *   renderState 为 IIFE 闭包私有 → 通过页面自身 wdShopRefresh→POST→renderState 链路驱动刷新；
 *   以 evaluate 内 DOM click 触发隐藏面板内按钮，不改变输入焦点）
 * - 推广仓独立控制台 src/ui/server.js renderShops 渲染（提取 <script> 块 + 桩 DOM；
 *   桩的文本收集含 td 子节点，"09-27 13:00 读取"断言确实读到新建小字节点）
 * 不访问真实广告页；余额只是展示字段，测试同时证明费用/订单/阈值/编辑框行为不变。
 * 运行：node --test test/balance-display.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const vm = require('vm');
const { buildShopRows } = require(path.join(__dirname, '..', '..', 'bill-manager', 'watch-drill.js'));

const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const INDEX_HTML = path.join(__dirname, '..', '..', 'bill-manager', 'index.html');
const SERVER_JS = path.join(__dirname, '..', 'src', 'ui', 'server.js');

// ── watch-drill buildShopRows 透传 ───────────────────────────────────

test('buildShopRows：余额按店透传；同账户两店各显同值不叠加；缺失 → null（未知）', () => {
  const status = {
    monitor: { enablePhaseToday: [] },
    lastRounds: {},
    lastRound: null,
    batches: {},
    adBelief: {},
    shops: [
      { id: 'shop-a', name: '店A', deleted: false, thresholdCents: 100, lastAdState: 'on',
        today: { costCents: 100, orders: 10, balanceCents: 27390, balanceAt: '2026-09-27T05:00:00.000Z' } },
      { id: 'shop-b', name: '店B', deleted: false, thresholdCents: 100, lastAdState: 'on',
        today: { costCents: 200, orders: 20, balanceCents: 27390, balanceAt: '2026-09-27T05:00:00.000Z' } },
      { id: 'shop-c', name: '店C', deleted: false, thresholdCents: 100, lastAdState: 'on',
        today: { costCents: 300, orders: 30 } },
    ],
  };
  const rows = buildShopRows(status);
  assert.strictEqual(rows.length, 3);
  // 两店不同余额各自透传
  assert.strictEqual(rows[0].balanceCents, 27390);
  assert.strictEqual(rows[0].balanceAt, '2026-09-27T05:00:00.000Z');
  // 同一账户对应多店：各店行显示同一账户余额，但字段是透传不是求和（27390 ≠ 27390+27390）
  assert.strictEqual(rows[1].balanceCents, 27390);
  assert.notStrictEqual(rows[1].balanceCents, 54780, '同账户多店不得把余额重复相加');
  // 缺失 → null（界面显示"未知"，不得编造 0）
  assert.strictEqual(rows[2].balanceCents, null);
  assert.strictEqual(rows[2].balanceAt, null);
  // 费用/订单/阈值照常透传（余额不影响既有字段）
  assert.strictEqual(rows[0].costCents, 100);
  assert.strictEqual(rows[0].orders, 10);
  assert.strictEqual(rows[0].thresholdCents, 100);
});

// ── bill-manager/index.html renderState 真实渲染 ─────────────────────

let browser;
const rowsWithBalance = [
  { id: 'shop-a', name: '店A', displayName: '店A', platform: 'douyin', platformLabel: '抖店', adControl: true,
    adState: { on: true, state: 'on', note: '开启' }, costCents: 100, orders: 10, thresholdCents: 100,
    balanceCents: 27390, balanceAt: '2026-09-27T05:00:00.000Z', identityPending: false, lastError: null },
  { id: 'shop-b', name: '店B', displayName: '店B', platform: 'douyin', platformLabel: '抖店', adControl: true,
    adState: { on: true, state: 'on', note: '开启' }, costCents: 200, orders: 20, thresholdCents: 100,
    balanceCents: null, balanceAt: null, identityPending: false, lastError: null },
];
const baseState = () => ({
  shopName: '测试店铺',
  shops: [],
  lastRounds: {},
  lastRound: null,
  realMode: true,
  realModeKnown: true,
  modeText: '真实执行',
  running: true,
  status: 'reading',
  roundNo: 1,
  cycleNo: 1,
  startedAt: '2026-09-27T05:00:00.000Z',
  stoppedAt: null,
  lastCheckAt: null,
  nextRunAt: null,
  lastError: null,
  gates: { realMode: true, pauseEnabled: true, enableEnabled: true, dryRun: false },
  enableTask: { running: true, phase: 'waiting_window', nextRunAt: null, lastRunAt: null },
  notify: { enabled: false },
  windowBlockReason: null,
  polling: { timeoutMs: 120000, intervalMs: 3000 },
});

before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1280,900'] });
});

after(async () => {
  await browser.close().catch(() => {});
});

test('index.html 多店行（激活推广值守页签）：余额+可见上海时间/未知；店B 刷新真实发生且 DOM 更新；编辑框输入与焦点保留', async () => {
  const page = await browser.newPage();
  // 页面自身 IIFE 的 wdShopRefresh→POST /shop/refresh→renderState 链路：/api 响应由路由控制
  // （renderState 为闭包私有，不直接调用）。currentState 在触发刷新前切换为"刷新后"状态。
  let currentState = Object.assign(baseState(), { shopRows: rowsWithBalance });
  let refreshCalls = 0;
  await page.route('**/api/**', (route) => {
    const u = route.request().url();
    if (u.includes('/api/watch-drill/shop/refresh')) {
      refreshCalls += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, state: currentState }) });
    }
    if (u.includes('/api/watch-drill/state')) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, state: currentState }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
  });
  await page.goto('file:///' + INDEX_HTML.replace(/\\/g, '/'), { waitUntil: 'load' });
  // 前置条件：用页面现有入口激活"推广值守"页签（#tab-watchdrill 默认 display:none，
  // 未激活时 input.focus() 对不可渲染元素无效——上阶段焦点断言失败的根因）
  await page.click('button.tab-btn[onclick*="watchdrill"]', { timeout: 15000 });
  await page.waitForSelector('#tab-watchdrill.active', { state: 'attached', timeout: 15000 });
  await page.waitForSelector('.wd-shop-row', { state: 'attached', timeout: 15000 });
  const initial = await page.evaluate(() => Array.from(document.querySelectorAll('.wd-shop-row')).map((el) => el.innerText.replace(/\s+/g, ' ')));
  assert.match(initial[0], /千川可用余额 273\.90 元（09-27 13:00 读取）/, '店A 行内可见余额与上海本机读取时间（UTC 05:00 → 上海 13:00）');
  assert.match(initial[1], /千川可用余额 未知/, '店B 无余额显示"未知"，不得显示 0');
  // 同账户两店不叠加：两行各自显示 273.90/未知，页面不存在 547.80
  assert.doesNotMatch(initial.join(' '), /547\.80/);

  // 打开店A编辑框 + 输入 9.99 + 聚焦
  await page.evaluate(() => {
    var box = document.querySelector('#wd-edit-shop-a');
    if (box) box.style.display = 'block';
    var input = box && box.querySelector('.wd-ethr');
    if (input) { input.value = '9.99'; input.focus(); input.__balTestMark = 'shop-a-input'; }
  });
  // 刷新前的前置断言（本阶段核心）：输入框真实可见且 document.activeElement 就是它
  const pre = await page.evaluate(() => {
    var box = document.querySelector('#wd-edit-shop-a');
    var input = box && box.querySelector('.wd-ethr');
    var r = input && input.getBoundingClientRect();
    return {
      boxOpen: !!box && box.style.display === 'block',
      inputVisible: !!input && !!input.offsetParent && r.width > 0 && r.height > 0,
      focused: document.activeElement === input,
      marked: !!input && input.__balTestMark === 'shop-a-input',
    };
  });
  assert.strictEqual(pre.boxOpen, true, '刷新前：店A 编辑框已打开');
  assert.strictEqual(pre.inputVisible, true, '刷新前：输入框真实可见（页签已激活，前置条件有效）');
  assert.strictEqual(pre.focused, true, '刷新前：document.activeElement 即该输入框（真实聚焦）');
  assert.strictEqual(pre.marked, true, '刷新前：输入节点已标记（用于刷新后节点同一性核对）');

  // 刷新后的可识别新内容：店B 从"未知"变为"千川可用余额 273.90 元（09-27 13:30 读取）"
  currentState = Object.assign(baseState(), { shopRows: [
    rowsWithBalance[0],
    Object.assign({}, rowsWithBalance[1], { balanceCents: 27390, balanceAt: '2026-09-27T05:30:00.000Z' }),
  ] });

  // 以不改焦点的方式（evaluate 内 DOM click）触发隐藏面板内店B"立即更新"
  const refreshResponse = page.waitForResponse((r) => r.url().includes('/api/watch-drill/shop/refresh') && r.request().method() === 'POST');
  await page.evaluate(() => {
    var btn = document.querySelector('[data-wd-act="refresh"][data-wd-id="shop-b"]');
    if (!btn) throw new Error('未找到店B立即更新按钮');
    btn.click();
  });
  const resp = await refreshResponse;
  assert.strictEqual(resp.status(), 200, '刷新请求已发出且响应到达');
  assert.strictEqual(refreshCalls >= 1, true, 'shop/refresh 至少调用一次');

  // 响应已被页面实际处理：等待刷新后的新内容（旧 DOM 是"未知"，不含该串，不会假通过）
  await page.waitForFunction(() => {
    var b = Array.from(document.querySelectorAll('.wd-shop-row')).find((el) => (el.getAttribute('data-wd-shop') || '') === 'shop-b');
    return !!b && b.innerText.indexOf('千川可用余额 273.90 元（09-27 13:30 读取）') >= 0;
  }, { timeout: 15000 });

  const after = await page.evaluate(() => {
    var rows = Array.from(document.querySelectorAll('.wd-shop-row'));
    var a = rows.find((el) => (el.getAttribute('data-wd-shop') || '') === 'shop-a');
    var b = rows.find((el) => (el.getAttribute('data-wd-shop') || '') === 'shop-b');
    var box = a && a.querySelector('#wd-edit-shop-a');
    var input = box && box.querySelector('.wd-ethr');
    return {
      aText: a ? a.innerText.replace(/\s+/g, ' ') : null,
      bText: b ? b.innerText.replace(/\s+/g, ' ') : null,
      boxOpen: !!box && box.style.display === 'block',
      inputValue: input ? input.value : null,
      inputVisible: !!input && !!input.offsetParent && input.getBoundingClientRect().width > 0,
      focusKept: document.activeElement === input,
      sameNode: !!input && input.__balTestMark === 'shop-a-input',
      activeTag: document.activeElement ? (document.activeElement.tagName || '').toLowerCase() : null,
    };
  });
  assert.match(after.bText, /千川可用余额 273\.90 元（09-27 13:30 读取）/, '店B 刷新后 DOM 更新为新余额与上海读取时间');
  assert.match(after.aText, /千川可用余额 273\.90 元（09-27 13:00 读取）/, '店A 行不因刷新丢失余额与时间');
  assert.strictEqual(after.boxOpen, true, '店A 编辑框仍打开');
  assert.strictEqual(after.inputValue, '9.99', '未保存输入值保留');
  assert.strictEqual(after.inputVisible, true, '刷新后：输入框仍可见');
  assert.strictEqual(after.sameNode, true, '输入节点与刷新前为同一节点（标记保留）');
  assert.strictEqual(after.focusKept, true, '刷新后焦点仍在同一输入节点');
  await page.close();
});

// ── 推广仓独立控制台 renderShops 渲染 ────────────────────────────────

test('独立控制台 renderShops：余额列有值显示元+可见读取时间（来自新建子节点）、缺失显示未知', () => {
  const src = fs.readFileSync(SERVER_JS, 'utf-8');
  const blocks = [...src.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const hit = blocks.filter((b) => b.includes('function renderShops'));
  assert.strictEqual(hit.length, 1, `控制台应恰好包含一个 renderShops 脚本块，实际 ${hit.length} 个`);
  const nodesById = {};
  const sandbox = {
    document: {
      createElement: () => ({ children: [], style: {}, textContent: '', className: '', id: '', title: '', type: '', step: '', min: '', value: '', setAttribute() {}, appendChild(c) { this.children.push(c); }, addEventListener() {}, classList: { add() {} }, querySelector: () => null, querySelectorAll: () => [] }),
      getElementById(id) {
        // 稳定返回同一节点：renderShops 的 body.appendChild 行必须能在断言中读到
        if (!nodesById[id]) nodesById[id] = { children: [], innerHTML: '', textContent: '', appendChild(c) { this.children.push(c); }, addEventListener() {} };
        return nodesById[id];
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
    },
    editState: {},
    setInterval: () => 0,
    setTimeout: () => 0,
    // 顶层 refresh() 的 /api/status 拉取：挂起以避免异步 renderShops([]) 覆盖断言目标
    fetch: () => new Promise(() => {}),
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(hit[0], sandbox, { filename: 'server-console.js' });
  const rows = [
    { id: 'shop-a', name: '店A', displayName: '店A', adState: 'on', lastDataAt: '2026-09-27T05:00:00.000Z',
      costCents: 100, costText: '1.00 元', orders: 10, thresholdCents: 100, balanceCents: 27390, balanceAt: '2026-09-27T05:00:00.000Z' },
    { id: 'shop-b', name: '店B', displayName: '店B', adState: 'on', lastDataAt: '2026-09-27T05:00:00.000Z',
      costCents: 200, costText: '2.00 元', orders: 20, thresholdCents: 100, balanceCents: null, balanceAt: null },
  ];
  sandbox.renderShops(rows);
  const shopBody = sandbox.document.getElementById('shopBody');
  const dump = (node) => [node.textContent || ''].concat((node.children || []).map(dump)).join(' ');
  const html = shopBody.children.map(dump).join('\n');
  assert.match(html, /273\.90 元/, '有余额按元显示');
  assert.match(html, /09-27 13:00 读取/, '可见上海读取时间来自新建小字子节点（td 自身文本只有金额）');
  assert.match(html, /未知/, '缺失显示"未知"');
  assert.match(html, /1\.00 元/, '费用列不受余额影响');
  assert.doesNotMatch(html, /547\.80/, '不叠加');
});
