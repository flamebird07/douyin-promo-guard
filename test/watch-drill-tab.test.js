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

/** 以桩 DOM/fetch 运行片段脚本，返回渲染结果与控制句柄（可改写 /logs 响应后再次刷新）。 */
async function renderFragment(state, opts = {}) {
  const elements = {};
  const mkEl = () => ({ textContent: '', className: '', innerHTML: '', style: {} });
  for (const id of ['wdShopName', 'wdStatusBadge', 'wdToggleBtn', 'wdModeBadge', 'wdGates', 'wdGap', 'wdEnableTaskState', 'wdEnableTaskNext', 'wdEnableTaskMissed', 'wdEnableTaskBtn', 'wdToggleHint', 'wdLastCheck', 'wdNextRun', 'wdEnableToday', 'wdPhase', 'wdCost', 'wdOrders', 'wdPerOrder', 'wdConclusion', 'wdReason', 'wdError', 'wdLog']) {
    elements[id] = mkEl();
  }
  // /logs 响应盒：测试可在多次刷新之间改写，模拟接口语义变化（缺口出现/消失）
  const logsResp = { current: opts.logsResponse || { ok: true, seq: 1, logs: [], gap: null, droppedCount: 0 } };
  const sandbox = {
    document: { getElementById: (id) => elements[id] || mkEl(), hidden: true, querySelector: () => null },
    setInterval: () => 0,
    clearInterval: () => {},
    fetch: (p) => Promise.resolve({
      json: () => Promise.resolve(
        String(p).includes('/api/watch-drill/state')
          ? { ok: true, state }
          : logsResp.current,
      ),
    }),
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(extractWatchScript(fs.readFileSync(FRAG, 'utf-8')), sandbox, { filename: 'watch-drill-tab.html#watch-script' });
  const settle = async () => {
    for (let i = 0; i < 4; i += 1) await new Promise((r) => setImmediate(r));
  };
  await settle(); // 让脚本启动时的 wdRefreshAll 异步链（state→logs→renderGap/renderLogs）跑完
  return {
    badgeText: elements.wdModeBadge.textContent,
    gatesHtml: elements.wdGates.innerHTML,
    els: elements,
    logsResp,
    refreshAll: () => sandbox.window.wdRefreshAll(),
    settle,
  };
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

// ══════════════════════════════════════════════════════════════
// 第四轮回归（Codex 复核）：未知模式展示 + 日志缺口提示。
// 以 Node VM 真实运行片段脚本断言实际渲染输出；修复前的旧代码在本节用例上必须失败。
// ══════════════════════════════════════════════════════════════

const GATES_UNKNOWN_MODE = {
  realMode: false, modeKnown: false, dryRun: true, pauseEnabled: false, enableEnabled: false,
  pauseWillExecute: false, enableWillExecute: false,
  pauseGateReason: 'execution.realMode 未开启（演练模式不执行真实暂停）',
  enableGateReason: null, blockedBy: ['realMode 未开启', 'execution.dryRun=true（演练）'],
  scope: ['全店托管', '商品自选'], deleteAdEnabled: false,
};

test('未知模式徽标：realMode=false 但 modeKnown=false → 显示"待核实"，不得当作已确认演练', async () => {
  // Codex 复现形状：realMode=false + realModeKnown=false + gates.modeKnown=false + modeText=待核实
  const { badgeText } = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: false, realModeKnown: false,
    modeText: '待核实（配置缺少 execution.realMode，不得据此认为安全）',
    running: false, status: 'idle', gates: GATES_UNKNOWN_MODE,
  });
  assert.ok(/待核实/.test(badgeText), `未知模式必须显示"待核实"，实际：${badgeText}`);
  assert.ok(!badgeText.includes('演练模式'), `未知模式不得显示"演练模式"（不能把未知当作已确认演练），实际：${badgeText}`);
  assert.ok(!badgeText.includes('不操作广告'), `未知模式不得宣称"不操作广告"，实际：${badgeText}`);
});

test('未知模式徽标：已确认演练仍显示"演练模式"；门槛未取得（gates 缺失）→ 待核实', async () => {
  // 已确认演练（modeKnown=true）→ 保留"演练模式 · 不操作广告"
  const confirmed = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: false, realModeKnown: true,
    modeText: '演练模式（不操作广告）', running: false, status: 'idle',
    gates: { ...GATES_UNKNOWN_MODE, modeKnown: true },
  });
  assert.ok(confirmed.badgeText.includes('演练模式'), `已确认演练必须显示演练模式，实际：${confirmed.badgeText}`);
  assert.ok(!/待核实/.test(confirmed.badgeText), `已确认演练不得显示待核实，实际：${confirmed.badgeText}`);
  // 门槛未取得（gates=null）→ 不得宣称演练安全
  const noGates = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: false, realModeKnown: false,
    running: false, status: 'idle', gates: null,
  });
  assert.ok(/待核实/.test(noGates.badgeText), `门槛未取得必须显示待核实，实际：${noGates.badgeText}`);
  assert.ok(!noGates.badgeText.includes('不操作广告'), `门槛未取得不得宣称不操作广告，实际：${noGates.badgeText}`);
});

test('日志缺口：/logs 无新日志但 gap.droppedCount=700 → 展示缺口；重复拉取不重复追加；缺口消失即隐藏', async () => {
  const r = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: false, realModeKnown: true, running: false, status: 'idle',
    gates: { ...GATES_UNKNOWN_MODE, modeKnown: true },
  }, {
    logsResponse: { ok: true, seq: 5, logs: [], gap: { droppedCount: 700, trimmedTotal: 700, source: 'eventStream' }, droppedCount: 700 },
  });
  // 无新增普通日志（logs=[]）也必须展示接口提供的缺口
  assert.strictEqual(r.els.wdGap.style.display, 'block', `缺口提示必须可见，实际：${JSON.stringify(r.els.wdGap)}`);
  assert.ok(r.els.wdGap.textContent.includes('共丢失 700 条'), `缺口提示必须含真实条数，实际：${r.els.wdGap.textContent}`);
  // 重复拉取（相同缺口）：textContent 整体覆写，不得重复追加
  await r.refreshAll();
  await r.settle();
  const hits = (r.els.wdGap.textContent.match(/共丢失 700 条/g) || []).length;
  assert.strictEqual(hits, 1, `重复拉取不得重复追加缺口提示，实际 ${hits} 处：${r.els.wdGap.textContent}`);
  // 缺口消失（接口语义：gap=null 且 droppedCount=0 = 未发生裁剪）→ 明确隐藏
  r.logsResp.current = { ok: true, seq: 6, logs: [], gap: null, droppedCount: 0 };
  await r.refreshAll();
  await r.settle();
  assert.strictEqual(r.els.wdGap.style.display, 'none', `缺口消失后必须隐藏提示，实际：${JSON.stringify(r.els.wdGap)}`);
  assert.strictEqual(r.els.wdGap.textContent, '', '缺口消失后必须清空提示文本');
});

test('独立每日开启任务行：running → 已登记待命+下次时间+停用按钮；stoppedByUser → 恢复按钮', async () => {
  // 运行中（已登记）
  const r1 = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: true, running: false, status: 'idle',
    enableTask: { running: true, configEnabled: true, stoppedByUser: false, nextRunAt: '2026-09-16T23:00:00.000Z', lastMissedReason: null },
    gates: { realMode: true, pauseEnabled: true, enableEnabled: true, dryRun: false, pauseWillExecute: true, enableWillExecute: true, blockedBy: [], scope: ['全店托管', '商品自选'], deleteAdEnabled: false },
  });
  assert.ok(r1.els.wdEnableTaskState.textContent.includes('已登记待命'), `实际：${r1.els.wdEnableTaskState.textContent}`);
  assert.ok(r1.els.wdEnableTaskNext.textContent.includes('下次开启'), `必须显示下次开启时间，实际：${r1.els.wdEnableTaskNext.textContent}`);
  assert.strictEqual(r1.els.wdEnableTaskBtn.textContent, '停用每日开启');
  // 用户独立停用
  const r2 = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: true, running: false, status: 'idle',
    enableTask: { running: false, configEnabled: true, stoppedByUser: true, nextRunAt: null, lastMissedReason: null },
    gates: { realMode: true, pauseEnabled: true, enableEnabled: true, dryRun: false, pauseWillExecute: true, enableWillExecute: true, blockedBy: [], scope: ['全店托管', '商品自选'], deleteAdEnabled: false },
  });
  assert.ok(r2.els.wdEnableTaskState.textContent.includes('已停用'), `实际：${r2.els.wdEnableTaskState.textContent}`);
  assert.strictEqual(r2.els.wdEnableTaskBtn.textContent, '恢复每日开启');
});

// ══════════════════════════════════════════════════════════════
// 第五轮（2026-09-16 定点修复）：门槛明细必须展示**实际生效**的落地回读轮询配置
// 与最近一次 Cookie 回写结果（仅元信息，界面永不显示任何 Cookie 值）。
// ══════════════════════════════════════════════════════════════

test('门槛明细：展示实际生效的落地回读配置（超时/间隔/来源），值取自 gates.polling', async () => {
  const { gatesHtml } = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: true, running: false, status: 'idle',
    gates: {
      realMode: true, pauseEnabled: true, enableEnabled: true, dryRun: false,
      pauseWillExecute: true, enableWillExecute: true, blockedBy: [],
      scope: ['全店托管', '商品自选'], deleteAdEnabled: false,
      polling: { timeoutMs: 30000, intervalMs: 3000, timeoutSource: 'execution.readbackTimeoutMs', intervalSource: 'execution.readbackIntervalMs' },
    },
  });
  assert.ok(gatesHtml.includes('落地回读'), `门槛明细必须展示落地回读配置，实际：${gatesHtml}`);
  assert.ok(gatesHtml.includes('30000ms'), `必须展示实际生效超时值 30000ms，实际：${gatesHtml}`);
  assert.ok(gatesHtml.includes('3000ms'), `必须展示实际生效间隔值 3000ms，实际：${gatesHtml}`);
  assert.ok(gatesHtml.includes('execution.readbackTimeoutMs'), `必须展示配置来源（不得只显示猜测值），实际：${gatesHtml}`);
});

test('门槛明细：polling 缺失 → 明确显示"配置待读取"，不得编造数值', async () => {
  const { gatesHtml } = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: true, running: false, status: 'idle',
    gates: {
      realMode: true, pauseEnabled: true, enableEnabled: true, dryRun: false,
      pauseWillExecute: true, enableWillExecute: true, blockedBy: [],
      scope: ['全店托管', '商品自选'], deleteAdEnabled: false,
    },
  });
  assert.ok(gatesHtml.includes('配置待读取'), `polling 缺失必须显示待读取，实际：${gatesHtml}`);
  assert.ok(!gatesHtml.includes('30000ms'), `polling 缺失时不得编造数值，实际：${gatesHtml}`);
});

test('门槛明细：展示 Cookie 回写结果（已保存/冲突/失败），且绝不显示任何 Cookie 值', async () => {
  const base = {
    realMode: true, pauseEnabled: true, enableEnabled: true, dryRun: false,
    pauseWillExecute: true, enableWillExecute: true, blockedBy: [],
    scope: ['全店托管', '商品自选'], deleteAdEnabled: false,
  };
  const saved = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: true, running: false, status: 'idle', gates: base,
    cookieWriteback: { ok: true, skipped: false, count: 65, bytes: 20480, domains: ['fxg.jinritemai.com', 'compass.jinritemai.com'] },
  });
  assert.ok(saved.gatesHtml.includes('Cookie 回写'), `必须展示 Cookie 回写状态，实际：${saved.gatesHtml}`);
  assert.ok(saved.gatesHtml.includes('已保存'), `成功回写必须显示已保存，实际：${saved.gatesHtml}`);

  const conflict = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: true, running: false, status: 'idle', gates: base,
    cookieWriteback: { ok: false, skipped: true, conflict: true, reason: '源 Cookie 文件在本次会话期间已被改变' },
  });
  assert.ok(/冲突|保留较新文件/.test(conflict.gatesHtml), `冲突必须如实展示，实际：${conflict.gatesHtml}`);

  const failed = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: true, running: false, status: 'idle', gates: base,
    cookieWriteback: { ok: false, skipped: false, reason: 'Cookie 回写失败（旧文件保留）: EACCES' },
  });
  assert.ok(/失败/.test(failed.gatesHtml), `保存失败必须如实展示，实际：${failed.gatesHtml}`);

  const none = await renderFragment({
    shopName: '瑾漂亮潮流服饰', realMode: true, running: false, status: 'idle', gates: base,
  });
  assert.ok(none.gatesHtml.includes('尚无记录'), `无记录时必须显示尚无记录，实际：${none.gatesHtml}`);

  // 安全断言：界面绝不渲染任何 Cookie 值 / 敏感字段名
  for (const r of [saved, conflict, failed, none]) {
    assert.ok(!/value/i.test(r.gatesHtml), `界面不得出现 Cookie value 字段，实际：${r.gatesHtml}`);
    assert.ok(!r.gatesHtml.includes('sessionid'), `界面不得出现会话凭据，实际：${r.gatesHtml}`);
  }
});
