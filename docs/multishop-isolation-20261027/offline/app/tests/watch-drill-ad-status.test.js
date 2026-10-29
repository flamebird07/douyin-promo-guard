'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function slice(from, to) {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start);
  assert.ok(start >= 0 && end > start, from);
  return html.slice(start, end);
}
const helpers = slice('      function esc(s) {', '      function api(');
const rowSource = slice('        function shopRowHtml(r, idx) {', "        $('wdShopEmpty').style.display");
const joinSource = slice('        function withJoin(r) {', '        function shopRowHtml(r, idx) {');
const statusSource = slice('      function rowsHaveReadError(s) {', '      // R42-F1:STATUS_META_END');
const badgeSource = slice("        var badge = $('wdStatusBadge');", "        var btn = $('wdToggleBtn');");
const modeSource = slice("        var mb = $('wdModeBadge');", '        var fb = function (v)');
const logSource = slice('      function renderLogs(logs) {', '      async function loadStateAndLogs()');
const NOW = Date.parse('2026-10-29T04:30:00.000Z');
const OLD = '2026-10-28T02:00:00.000Z';
const FRESH = '2026-10-29T04:29:00.000Z';
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : [NOW])); }
  static now() { return NOW; }
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const times = freeze([
  ['old', OLD], ['fresh', FRESH], ['missing', undefined], ['invalid', 'not-a-date'],
  ['35-minute boundary', new Date(NOW - 35 * 60 * 1000).toISOString()],
  ['over 35 minutes', new Date(NOW - 35 * 60 * 1000 - 1).toISOString()],
  ['future', new Date(NOW + 60000).toISOString()],
]);
function adAt(state, field, time) {
  return { state, evidenceKind: field === 'confirmedAt' ? 'action_confirm' : 'read_only',
    ...(time === undefined ? {} : { [field]: time }) };
}
function row(overrides = {}) {
  return freeze({ id: 'shop-a', name: '甲店', platform: 'douyin', adControl: true,
    adState: { state: 'on' }, lastDataAt: FRESH, ...overrides });
}
function element() {
  return {
    children: [], className: '', style: {}, value: '', scrollHeight: 0,
    get textContent() { return this.value + this.children.map((child) => child.textContent).join(''); },
    set textContent(value) { this.value = String(value); this.children.length = 0; },
    set innerHTML(value) { throw new Error('HTML DOM insertion forbidden: ' + value); },
    appendChild(child) { this.children.push(child); },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
    querySelector(selector) {
      assert.equal(selector, '.t');
      return this.children.flatMap((child) => child.children).find((child) => child.className === 't') || null;
    },
  };
}
function fixture(overrides = {}) {
  const snapshot = freeze({ running: true, status: 'waiting', cycleRunning: false,
    businessDate: '2026-10-29', shopRows: [], ...overrides });
  const nodes = { wdLog: element(), wdStatusBadge: element(), wdModeBadge: element() };
  nodes.wdLog.textContent = '尚未有日志';
  const forbidden = () => { throw new Error('network, timers and backend calls are forbidden'); };
  const sandbox = {
    s: snapshot, joinsForRows: snapshot.loginJoins || {}, Date: FixedDate,
    $: (id) => { assert.ok(Object.hasOwn(nodes, id), id); return nodes[id]; },
    document: { createElement: element }, deleteBlocked: () => false,
    fetch: forbidden, api: forbidden, setTimeout: forbidden, setInterval: forbidden,
  };
  vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
  vm.runInContext(helpers + statusSource + joinSource + rowSource + logSource
    + '\nfunction renderBadge() { var st = statusMeta(s);\n' + badgeSource + '\n}'
    + '\nfunction renderMode() {\n' + modeSource + '\n}', sandbox, { filename: 'index.html:watch-drill-renderers' });
  return { sandbox, nodes, render: (r, idx = 0) => sandbox.shopRowHtml(sandbox.withJoin(r), idx) };
}
function statusOf(output) {
  const match = /<span class="wd-shop-state"[^>]*>([^<]*)<\/span>/.exec(output);
  assert.ok(match, output);
  return match[1];
}

for (const state of ['on', 'off']) {
  for (const [label, time] of times) {
    test(`${state} keeps last observed AD STATUS with ${label} evidence time`, () => {
      const f = fixture();
      for (const field of ['confirmedAt', 'observedAt', 'at']) {
        const ad = adAt(state, field, time);
        const booleanAd = { ...ad, on: state === 'on' };
        delete booleanAd.state;
        for (const adState of [ad, booleanAd]) {
          const input = row({ adState });
          const before = JSON.stringify(input);
          const output = f.render(input);
          assert.equal(statusOf(output), state === 'on' ? '开启' : '暂停');
          assert.ok(output.includes('color:' + (state === 'on' ? '#16a34a' : '#b45309') + ';font-weight:600;'));
          assert.doesNotMatch(output, /待核实（上次/);
          assert.ok(output.includes('数据更新 ' + f.sandbox.fmtTime(FRESH)));
          const evidenceLabel = field === 'confirmedAt' ? '动作确认 ' : '只读观测 ';
          assert.ok(output.includes('状态核对 ' + (time === undefined
            ? '无状态证据时间' : evidenceLabel + f.sandbox.fmtTime(time))));
          assert.equal(JSON.stringify(input), before);
        }
      }
    });
  }
}

test('real login and reading errors override on/off for every evidence timestamp', () => {
  const detail = '读取失败：登录入口尚未就绪 <fixture> & "detail"';
  const cases = [
    [{ requiresLogin: true, readErrorReason: detail }, '登录验证未通过', true],
    [{ readFailure: { requiresLogin: true, detail } }, '登录验证未通过', true],
    [{ readErrorKind: 'auth', readErrorReason: detail }, '登录验证未通过', true],
    [{ readFailure: { detail } }, '读取受阻', true],
    [{ readErrorKind: 'transport' }, '读取受阻', false],
    [{ readErrorReason: detail }, '读取受阻', true],
    [{ lastError: detail }, '读取受阻', true],
    [{ readFailure: {} }, '读取受阻', false],
  ];
  const f = fixture();
  for (const state of ['on', 'off']) {
    for (const [, time] of times) {
      for (const field of ['confirmedAt', 'observedAt', 'at']) {
        for (const [error, expected, hasDetail] of cases) {
          const input = row({ adState: adAt(state, field, time), ...error });
          const before = JSON.stringify(input);
          const output = f.render(input);
          assert.equal(statusOf(output), expected);
          assert.doesNotMatch(output, /待核实（上次/);
          assert.equal((output.match(/class="wd-row-error"/g) || []).length, hasDetail ? 1 : 0);
          if (hasDetail) assert.ok(output.includes(f.sandbox.esc(detail)));
          assert.doesNotMatch(output, /<fixture>/);
          assert.equal(JSON.stringify(input), before);
        }
      }
    }
  }
});

test('loginJoin processing remains transient, terminal joins retain real errors, and inputs stay unchanged', () => {
  for (const state of ['on', 'off']) {
    for (const [, time] of times) {
      for (const field of ['loginJoin', '_liveLoginJoin']) {
        for (const status of ['processing', 'done', 'failed']) {
          const input = row({ adState: adAt(state, 'observedAt', time),
            requiresLogin: true, readFailure: { requiresLogin: true, detail: '登录验证失败 fixture' },
            [field]: { status } });
          const before = JSON.stringify(input);
          const output = fixture().render(input);
          assert.equal(statusOf(output), status === 'processing' ? '正在核验登录会话' : '登录验证未通过');
          assert.equal(output.includes('class="wd-row-error"'), status !== 'processing');
          assert.equal(output.includes('登录验证失败 fixture'), status !== 'processing');
          assert.equal(JSON.stringify(input), before);
        }
      }
    }
  }
});

test('mixed, unknown and unavailable states retain their existing reconciliation and error priorities', () => {
  const cases = [
    [{ adState: { state: 'mixed', on: true } }, '混合 · 待确认'],
    [{ adState: { state: 'mixed', reconcileState: 'no_repair_scheduled', unknownBlock: true } }, '混合（未安排收敛，非完成态）'],
    [{ adState: { state: 'mixed', reconcileText: '重试中', unknownBlock: true } }, '混合 · 待确认（重试中）（旧动作仍未确认）'],
    [{ adState: { state: 'mixed' }, requiresLogin: true, loginJoin: { status: 'processing' } }, '混合 · 待确认'],
    [{ adState: { state: 'mixed' }, readFailure: { detail: '混合读取失败' } }, '混合 · 待确认'],
    [{ adState: { state: 'unknown' } }, '未知'],
    [{ adState: { state: 'unknown' }, readRecovery: { text: '等待重试读取' }, readErrorReason: '读取失败' }, '未知（等待重试读取）'],
    [{ adState: { state: 'unknown' }, readRetrying: true }, '未知（正在重试读取）'],
    [{ adState: { state: 'unknown', readRetrying: true } }, '未知（正在重试读取）'],
    [{ adState: { state: 'unknown' }, readFailure: { detail: '读取失败' } }, '读取受阻'],
    [{ adState: { state: 'unknown' }, requiresLogin: true }, '登录验证未通过'],
    [{ adState: { state: 'unknown' }, loginJoin: { status: 'processing' }, requiresLogin: true }, '正在核验登录会话'],
    [{ adState: {} }, '未知'],
    [{ adState: null }, '未知'],
    [{ adState: { note: '尚未观测 <fixture>' } }, '尚未观测 &lt;fixture&gt;'],
  ];
  for (const [, time] of times) {
    for (const [overrides, expected] of cases) {
      const adState = overrides.adState && { ...overrides.adState, observedAt: time };
      const output = fixture().render(row({ ...overrides, adState }));
      assert.equal(statusOf(output), expected);
      if (overrides.readFailure || overrides.readErrorReason) assert.match(output, /class="wd-row-error"/);
    }
  }
});

test('actual update times, stale data notes, evidence provenance and unrelated plan uncertainty are preserved', () => {
  const f = fixture();
  const output = f.render(row({ lastDataAt: OLD,
    adState: { state: 'on', evidenceKind: 'action_confirm', confirmedAt: OLD, observedAt: FRESH, at: FRESH } }));
  assert.equal(statusOf(output), '开启');
  assert.ok(output.includes('数据更新 ' + f.sandbox.fmtTime(OLD) + ' （超过 30 分钟未刷新，陈旧数据）'));
  assert.ok(output.includes('状态核对 动作确认 ' + f.sandbox.fmtTime(OLD)));
  assert.match(output, /今日计划：待核实（无同日证据，不推断成败）/);
  assert.match(f.render(row({ lastDataAt: FRESH, today: { businessDate: '2026-10-28' } })), /非今日数据，陈旧/);
  assert.match(f.render(row({ lastDataAt: null })), /数据更新 尚无成功读取/);
  assert.match(f.render(row({ lastDataAt: 'invalid' })), /数据更新 —/);
  assert.ok(f.render(row({ adState: { state: 'off', at: OLD } })).includes('状态核对 观测 ' + f.sandbox.fmtTime(OLD)));
  const successfulPlan = fixture({ planPublishing: { today: { date: '2026-10-29',
    shops: { 'shop-a': { status: 'success', plans: 3 } } } } });
  const failedLogin = successfulPlan.render(row({ adState: { state: 'off' }, requiresLogin: true }));
  assert.equal(statusOf(failedLogin), '登录验证未通过');
  assert.match(failedLogin, /今日计划：3\/3 · 已完成/);
});

test('shop-scoped join overlays, timestamps and errors remain independent without changing disabled flags or controls', () => {
  const shops = [
    row({ id: 'shop-a', enabled: false, adState: { state: 'on', observedAt: OLD } }),
    row({ id: 'shop-b', name: '乙店', enabled: false, adState: { state: 'off' } }),
    row({ id: 'shop-c', name: '丙店', adState: { state: 'off', observedAt: FRESH },
      requiresLogin: true, readErrorReason: '登录验证未通过 fixture' }),
  ];
  const snapshot = freeze({ shopRows: shops });
  const before = JSON.stringify(snapshot);
  const f = fixture(snapshot);
  assert.deepEqual(shops.map((r) => statusOf(f.render(r))), ['开启', '暂停', '登录验证未通过']);
  const joined = fixture({ ...snapshot, loginJoins: { 'shop-c': { status: 'processing' } } });
  assert.deepEqual(shops.map((r) => statusOf(joined.render(r))), ['开启', '暂停', '正在核验登录会话']);
  assert.deepEqual(shops.slice().reverse().map((r) => statusOf(f.render(r))), ['登录验证未通过', '暂停', '开启']);
  for (const input of shops) {
    const output = f.render(input);
    assert.ok(output.includes('data-wd-shop="' + input.id + '"'));
    assert.match(output, /class="wd-live-status"/);
    assert.ok(output.includes('class="wd-edit-box" id="wd-edit-' + input.id + '"'));
    for (const action of ['refresh', 'edit', 'delete', 'save', 'cancel-edit']) {
      assert.ok(output.includes('data-wd-act="' + action + '" data-wd-id="' + input.id + '"'));
    }
  }
  const readOnlyShop = f.render(row({ platform: 'pinduoduo', adControl: false }));
  assert.match(readOnlyShop, /商品分析专用，无广告控制/);
  assert.doesNotMatch(readOnlyShop, /data-wd-act="(?:edit|delete)"/);
  assert.equal(JSON.stringify(snapshot), before);
  assert.equal(shops[0].enabled, false);
  assert.equal(shops[1].enabled, false);
});

test('current processing owners, global read warnings and unknown execution mode remain truthful', () => {
  const f = fixture();
  for (const [processingShops, expected] of [
    [[{ id: 'shop-a', name: '甲店' }], '值守中（等待下次检查） · 正在处理：甲店'],
    [[{ id: 'shop-b', name: '<fixture>乙店' }], '值守中（等待下次检查） · 正在处理：<fixture>乙店'],
    [[], '值守中（等待下次检查）'], [undefined, '值守中（等待下次检查）'],
  ]) {
    f.sandbox.s = freeze({ running: true, status: 'waiting', cycleRunning: false, processingShops });
    f.sandbox.renderBadge();
    assert.equal(f.nodes.wdStatusBadge.textContent, expected);
  }
  const failed = fixture({ shopRows: [row({ requiresLogin: true, readErrorKind: 'auth' })] });
  failed.sandbox.renderBadge();
  assert.equal(failed.nodes.wdStatusBadge.textContent, '值守中 · 读取异常需处理');
  assert.equal(failed.nodes.wdStatusBadge.className, 'wd-badge wd-failed');
  f.sandbox.renderMode();
  assert.equal(f.nodes.wdModeBadge.textContent, '模式待核实（配置缺少 execution.realMode，不得据此认为安全）');
  assert.equal(f.nodes.wdModeBadge.style.display, '');
});

test('shop status rendering does not clear, rewrite or reassign current business/error logs', () => {
  const f = fixture();
  const logs = freeze([
    { t: OLD, level: 'info', msg: '[店铺：甲店] 判断数据：已读取' },
    { t: FRESH, level: 'error', msg: '[店铺：乙店] 读取失败：<fixture> & detail' },
    { t: FRESH, level: 'warn', msg: '[店铺：丙店] 登录验证未通过' },
    { t: FRESH, level: 'error', msg: '[店铺未标明] 读取失败：缺少归属' },
  ]);
  const before = JSON.stringify(logs);
  f.sandbox.renderLogs(logs);
  const lines = f.nodes.wdLog.children.slice();
  for (const input of [row(), row({ adState: { state: 'off', observedAt: OLD } }), row({ requiresLogin: true })]) {
    f.render(input);
    f.sandbox.renderBadge();
  }
  assert.deepEqual(f.nodes.wdLog.children, lines);
  assert.deepEqual(lines.map((line) => line.children[1].textContent), logs.map((entry) => entry.msg));
  assert.equal(lines[1].children[1].className, 'lvl-error');
  assert.equal(lines[2].children[1].className, 'lvl-warn');
  assert.equal(JSON.stringify(logs), before);
});
