'use strict';

/**
 * 公开仓库值守页面片段（integrations/bill-manager/watch-drill-tab.html）回归测试。
 *
 * 第三轮修复背景：3443 主页在 realMode=true + pauseEnabled=true + enableEnabled=true
 * + dryRun=true 时，两个 WillExecute 均为 false，但徽标曾误显示
 * 「真实执行 · 但开关未全开，暂不会操作」——此时真正阻断动作的是 dryRun，
 * 不一定是开关。修复后徽标与门槛明细必须显示**真实阻断原因**（blockedBy/gate reason）。
 *
 * 本测试用 Node VM + 桩 DOM/fetch 直接运行片段里的值守渲染脚本（真实 renderState，
 * 不做字符串级Mock），保证公开仓库中的页面片段行为与要求一致。不触网、不启动值守、
 * 不操作真实广告。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const FRAG = path.join(__dirname, '..', 'integrations', 'bill-manager', 'watch-drill-tab.html');

function extractWatchScript(htmlSrc) {
  const blocks = [...htmlSrc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  const hit = blocks.filter((b) => b.includes('wdModeBadge') && b.includes('renderState'));
  assert.strictEqual(hit.length, 1, `片段应恰好包含一个值守渲染脚本块（含 renderState），实际 ${hit.length} 个`);
  return hit[0];
}

/** 以桩 DOM/fetch 运行片段脚本，返回渲染后的徽标文本与门槛明细 HTML。 */
async function renderFragment(state) {
  const elements = {};
  const mkEl = () => ({ textContent: '', className: '', innerHTML: '', style: {} });
  for (const id of ['wdShopName', 'wdStatusBadge', 'wdToggleBtn', 'wdModeBadge', 'wdGates', 'wdLastCheck', 'wdNextRun', 'wdEnableToday', 'wdPhase', 'wdCost', 'wdOrders', 'wdPerOrder', 'wdConclusion', 'wdReason', 'wdError', 'wdLog']) {
    elements[id] = mkEl();
  }
  const sandbox = {
    document: { getElementById: (id) => elements[id] || mkEl(), hidden: true, querySelector: () => null },
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: (p) => Promise.resolve({
      json: () => Promise.resolve(
        String(p).includes('/api/watch-drill/state')
          ? { ok: true, state }
          : { ok: true, seq: 1, logs: [] },
      ),
    }),
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(extractWatchScript(fs.readFileSync(FRAG, 'utf-8')), sandbox, { filename: 'watch-drill-tab.html#watch-script' });
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  return { badgeText: elements.wdModeBadge.textContent, gatesHtml: elements.wdGates.innerHTML };
}

test('片段存在且包含值守渲染脚本（renderState + wdModeBadge）', () => {
  const src = fs.readFileSync(FRAG, 'utf-8');
  assert.ok(src.includes('id="tab-watchdrill"'), '片段必须是 #tab-watchdrill 容器');
  assert.ok(src.includes('renderState'), '片段必须含 renderState');
});

test('徽标：三开关全开 + dryRun=true → 点名 dryRun 阻断，不再误报"开关未全开"', async () => {
  const { badgeText, gatesHtml } = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: true, running: false, status: 'idle', statusText: '未启动',
    gates: {
      realMode: true, pauseEnabled: true, enableEnabled: true, dryRun: true,
      pauseWillExecute: false, enableWillExecute: false,
      pauseGateReason: 'execution.dryRun=true（演练模式，禁止真实暂停）',
      enableGateReason: 'execution.dryRun=true（演练模式，禁止真实开启）',
      blockedBy: ['execution.dryRun=true（演练）'],
      scope: ['全店托管', '商品自选'], deleteAdEnabled: false,
    },
  });
  assert.ok(/dryRun/.test(badgeText), `徽标必须点名 dryRun 阻断，实际：${badgeText}`);
  assert.ok(!badgeText.includes('开关未全开'), `三开关全开时不得误报"开关未全开"，实际：${badgeText}`);
  assert.ok(badgeText.includes('真实执行'), `徽标必须保留真实执行模式标识，实际：${badgeText}`);
  assert.ok(gatesHtml.includes('dryRun=<b>true</b>'), `门槛明细必须展示 dryRun=true，实际：${gatesHtml}`);
  assert.ok(/execution\.dryRun=true/.test(gatesHtml), `门槛明细必须展示 dryRun 拦截原因，实际：${gatesHtml}`);
  assert.ok(gatesHtml.includes('不会执行'), `dryRun 下两个 WillExecute 必须显示不会执行，实际：${gatesHtml}`);
});

test('徽标：三开关全开且 dryRun=false → 显示"会操作广告"（无阻断字样）', async () => {
  const { badgeText } = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: true, running: true, status: 'waiting',
    gates: {
      realMode: true, pauseEnabled: true, enableEnabled: true, dryRun: false,
      pauseWillExecute: true, enableWillExecute: true,
      pauseGateReason: null, enableGateReason: null, blockedBy: [],
      scope: ['全店托管', '商品自选'], deleteAdEnabled: false,
    },
  });
  assert.ok(badgeText.includes('会操作广告'), `应显示会操作广告，实际：${badgeText}`);
  assert.ok(!/阻断/.test(badgeText), `无阻断时不得显示阻断字样，实际：${badgeText}`);
});

test('徽标：开关未开且无 dryRun → 点名开关阻断，不误报 dryRun', async () => {
  const { badgeText } = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: true, running: false, status: 'idle',
    gates: {
      realMode: true, pauseEnabled: false, enableEnabled: false, dryRun: false,
      pauseWillExecute: false, enableWillExecute: false,
      pauseGateReason: 'monitor.chengfang.pauseEnabled 未开启（乘方暂停动作处于演练门禁）',
      enableGateReason: 'monitor.chengfang.enableEnabled 未开启（乘方开启动作处于关闭门禁）',
      blockedBy: ['暂停开关未开启', '开启开关未开启'],
      scope: ['全店托管', '商品自选'], deleteAdEnabled: false,
    },
  });
  assert.ok(/开关/.test(badgeText), `开关未开时徽标应点名开关阻断，实际：${badgeText}`);
  assert.ok(!/dryRun/.test(badgeText), `无 dryRun 时不得误报 dryRun 阻断，实际：${badgeText}`);
});

test('徽标：realMode=false → 演练模式（不操作广告）', async () => {
  const { badgeText } = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: false, running: false, status: 'idle',
    gates: {
      realMode: false, pauseEnabled: true, enableEnabled: true, dryRun: true,
      pauseWillExecute: false, enableWillExecute: false,
      pauseGateReason: 'execution.realMode 未开启（演练模式不执行真实暂停）',
      enableGateReason: null, blockedBy: ['realMode 未开启', 'execution.dryRun=true（演练）'],
      scope: ['全店托管', '商品自选'], deleteAdEnabled: false,
    },
  });
  assert.ok(badgeText.includes('演练模式'), `realMode=false 应显示演练模式，实际：${badgeText}`);
});

test('门槛明细：始终声明"删除广告：永不执行"', async () => {
  const { gatesHtml } = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: true, running: false, status: 'idle',
    gates: {
      realMode: true, pauseEnabled: false, enableEnabled: false, dryRun: true,
      pauseWillExecute: false, enableWillExecute: false,
      pauseGateReason: 'x', enableGateReason: 'y', blockedBy: ['暂停开关未开启'],
      scope: ['全店托管', '商品自选'], deleteAdEnabled: false,
    },
  });
  assert.ok(gatesHtml.includes('删除广告'), '门槛明细必须含删除广告声明');
  assert.ok(gatesHtml.includes('永不执行'), '删除广告必须声明为永不执行');
});
