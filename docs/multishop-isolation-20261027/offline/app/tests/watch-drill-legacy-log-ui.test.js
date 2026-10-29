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
const renderer = slice('      function renderLogs(logs) {', '      async function loadStateAndLogs()');
const loader = slice('      async function loadStateAndLogs()', '      function wdToggle()');
const badgeSource = slice("        var badge = $('wdStatusBadge');", "        var btn = $('wdToggleBtn');");
const fallback = '；未识别事件名，按原样透出';
function legacy(kind, detail = '', level = 'info', prefix = '') {
  return Object.freeze({ t: 'fixture-time', level,
    msg: prefix + '过程：过程事件（' + kind + '）' + detail + fallback });
}
function element() {
  return {
    children: [], className: '', value: '', scrollHeight: 0,
    get textContent() { return this.value + this.children.map((child) => child.textContent).join(''); },
    set textContent(value) { this.value = String(value); this.children.length = 0; },
    set innerHTML(value) { throw new Error('HTML rendering forbidden: ' + value); },
    appendChild(child) { this.children.push(child); },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
    querySelector(selector) {
      assert.equal(selector, '.t');
      return this.children.flatMap((child) => child.children).find((child) => child.className === 't') || null;
    },
  };
}
function fixture() {
  const box = element();
  box.textContent = '尚未有日志';
  const sandbox = {
    $: (id) => { assert.equal(id, 'wdLog'); return box; },
    document: { createElement: element },
    fmtTime: (text) => text, compactUrls: (text) => text,
    esc() { throw new Error('textContent must not double-escape'); },
    fetch() { throw new Error('network forbidden'); },
    setTimeout() { throw new Error('timers forbidden'); },
    setInterval() { throw new Error('timers forbidden'); },
  };
  vm.createContext(sandbox);
  vm.runInContext(renderer, sandbox, { filename: 'index.html:renderLogs' });
  return { box, sandbox, render: sandbox.renderLogs, project: sandbox.projectUserLog,
    messages: () => box.children.map((line) => line.children[1].textContent) };
}

const checkpointSaveReasons = Object.freeze([
  '候选未通过独立复用/身份验证：未提供候选专用浏览器工厂（candidateBrowserFactory）：无法独立验证候选（fail-closed，拒绝借用业务浏览器/上下文，拒绝自启真实浏览器，不写入）（保留现有工作副本，未写入）',
  '候选未通过独立复用/身份验证：身份复验期间 Cookie 或页面变化：拒绝提交较早快照（保留现有工作副本，未写入）',
]);
const checkpointKinds = Object.freeze(['cookie-writeback', 'session-cookie-writeback', 'checkpoint-propagate']);
const checkpointDiagnostics = Object.freeze(['info', 'warn', 'warning', 'error'].flatMap((level) =>
  checkpointSaveReasons.flatMap((reason) => [
    ...checkpointKinds.flatMap((kind) => [
      legacy(kind, '（说明：' + reason + '）', level),
      legacy(kind, '（失败原因：' + reason + '）', level, '[店铺：甲店] '),
    ]),
    Object.freeze({ t: 'fixture-time', level, msg: '[店铺：瑾漂亮潮流服饰] 处理异常（说明：' + reason + '）' }),
  ])));
const internal = Object.freeze([
  legacy('start', '（第 1 次）'),
  legacy('poll', '（说明：shop-processing-busy）'),
  legacy('poll', '（说明：serial-other-shop-busy）'),
  legacy('cookie-writeback', '（说明：候选未通过独立复用/身份验证：未提供候选专用浏览器工厂（candidateBrowserFactory）...）'),
  legacy('cookie-writeback', '（说明：候选未通过独立复用/身份验证：未提供候选专用浏览器工厂（candidateBrowserFactory））'),
  legacy('checkpoint-propagate'),
  legacy('doudian-arrival'),
  ...checkpointDiagnostics,
]);

test('legacy telemetry and full checkpoint-save diagnostics stay hidden without clearing the placeholder or input history', () => {
  const f = fixture();
  const before = JSON.stringify(internal);
  for (const entry of internal) assert.equal(f.project(entry), null, entry.msg);
  f.render(internal);
  assert.equal(f.box.textContent, '尚未有日志');
  assert.equal(f.box.children.length, 0);
  assert.equal(JSON.stringify(internal), before);
  f.render(Object.freeze([{ t: 'fixture', level: 'info', msg: '[店铺：甲店] 判断数据：已读取' }]));
  f.render(internal);
  assert.deepEqual(f.messages(), ['[店铺：甲店] 判断数据：已读取']);
});

test('login, reading and overlay failures survive legacy info with complete balanced nested detail', () => {
  const f = fixture();
  const samples = [
    [legacy('chengfang-overlay', '（说明：unknown-overlay:1）'), '浮窗处理受阻：检测到未识别浮窗（1 个）'],
    [legacy('poll', '（说明：浮窗阻断（子标签就绪后）：unknown-overlay:1，停止自动操作）'),
      '浮窗阻断（子标签就绪后）：检测到未识别浮窗（1 个），停止自动操作'],
    [legacy('poll', '（说明：登录失效：需要重新登录）'), '登录失效：需要重新登录'],
    [legacy('poll', '（第 2 次）（失败原因：读取失败（页面异常（详情未就绪）），停止自动操作）', 'info', '[店铺：甲店] '),
      '[店铺：甲店] 第 2 次；读取失败（页面异常（详情未就绪）），停止自动操作'],
    [legacy('cookie-writeback', '（失败原因：登录凭据保存失败）'), '登录凭据保存失败'],
    [legacy('start', '（说明：登录失效）'), '登录失效'],
    [legacy('checkpoint-propagate', '（说明：读取通道暂时不可用）'), '读取通道暂时不可用'],
    [legacy('poll', '（说明：shop-processing-busy；读取失败）'), 'shop-processing-busy；读取失败'],
    [legacy('cookie-writeback', '（说明：候选未通过独立复用/身份验证：未提供候选专用浏览器工厂（candidateBrowserFactory）；读取失败）'),
      '候选未通过独立复用/身份验证：未提供候选专用浏览器工厂（candidateBrowserFactory）；读取失败'],
  ];
  for (const [entry, expected] of samples) {
    assert.equal(f.project(entry), expected);
    assert.doesNotMatch(f.project(entry), /过程事件|未识别事件名|按原样透出/);
  }
  f.render(Object.freeze(samples.map(([entry]) => entry)));
  assert.deepEqual(f.messages(), samples.map(([, expected]) => expected));
});

test('unknown messages and warning/error levels are never discarded by an internal event name', () => {
  const f = fixture();
  for (const level of ['warn', 'warning', 'error']) {
    assert.equal(f.project(legacy('poll', '（说明：shop-processing-busy）', level)), 'shop-processing-busy');
    assert.equal(f.project(legacy('future-event', '（失败原因：新业务失败（完整详情））', level)), '新业务失败（完整详情）');
    assert.ok(f.project(legacy('future-event', '', level)));
    const entry = Object.freeze({ level, msg: '未分类业务消息：需人工处理' });
    assert.equal(f.project(entry), entry.msg);
  }
  assert.ok(f.project(legacy('future-event')));
  assert.equal(f.project(legacy('poll', '（说明：future-reason）')), 'future-reason');
  const error = legacy('doudian-arrival', '（失败原因：读取失败）', 'error');
  f.render([error]);
  assert.equal(f.box.children[0].children[1].className, 'lvl-error');
  assert.deepEqual(f.messages(), ['读取失败']);
});

test('business login/read failures retain full checkpoint vocabulary at every level', () => {
  const f = fixture();
  const samples = [];
  const prefix = '[店铺：甲店] ';
  for (const level of ['info', 'warn', 'warning', 'error']) {
    for (const reason of checkpointSaveReasons) {
      for (const msg of [
        prefix + '读取失败（说明：' + reason + '）',
        prefix + '登录失效（说明：' + reason + '）',
        prefix + '处理异常（说明：读取失败：' + reason + '）',
        prefix + '处理异常（说明：登录失效：' + reason + '）',
        prefix + '处理异常（说明：' + reason + '；读取失败）',
        prefix + '处理异常（说明：' + reason + '）；登录失效',
        '读取失败：' + prefix + '处理异常（说明：' + reason + '）',
      ]) samples.push([Object.freeze({ t: 'fixture', level, msg }), msg]);
      for (const kind of ['poll', ...checkpointKinds, 'future-event']) {
        for (const detail of ['登录失效：Cookie 无效；' + reason, '读取失败：' + reason, reason + '；读取失败']) {
          samples.push([legacy(kind, '（说明：' + detail + '）', level, prefix), prefix + detail]);
        }
      }
      for (const kind of checkpointKinds) {
        samples.push([legacy(kind, '（说明：' + reason + '）（失败原因：读取失败：Cookie 无效）', level, prefix),
          prefix + reason + '；读取失败：Cookie 无效']);
      }
      for (const kind of ['poll', 'future-event', 'cookie-writeback-other']) {
        samples.push([legacy(kind, '（说明：' + reason + '）', level, prefix), prefix + reason]);
      }
      samples.push([legacy('poll', '（说明：' + reason + '；unknown-overlay:1）', level, prefix),
        prefix + reason + '；检测到未识别浮窗（1 个）']);
    }
  }
  for (const [entry, expected] of samples) assert.equal(f.project(entry), expected, entry.msg);
  f.render(internal);
  f.render(samples.map(([entry]) => entry));
  f.render(internal);
  assert.deepEqual(f.messages(), samples.map(([, expected]) => expected));
});

test('checkpoint-save suppression requires the complete known reason and no-write ending', () => {
  const f = fixture();
  for (const level of ['info', 'warn', 'warning', 'error']) {
    for (const reason of checkpointSaveReasons) {
      for (const detail of [
        reason.replace('（保留现有工作副本，未写入）', ''),
        reason.replace('（保留现有工作副本，未写入）', '（保留现有工作副本，已写入）'),
        '候选未通过独立复用/身份验证：未知错误（保留现有工作副本，未写入）',
      ]) {
        for (const kind of checkpointKinds) {
          assert.equal(f.project(legacy(kind, '（说明：' + detail + '）', level)), detail);
        }
        const msg = '[店铺：甲店] 处理异常（说明：' + detail + '）';
        assert.equal(f.project(Object.freeze({ level, msg })), msg);
      }
    }
  }
});

test('malformed or unrecognized detail formats are kept rather than silently hidden', () => {
  const f = fixture();
  for (const detail of ['（说明：读取失败（未闭合）', '（说明：读取失败））', '未加括号的读取失败']) {
    const entry = legacy('poll', detail);
    assert.equal(f.project(entry), entry.msg);
  }
});

test('new shop-scoped business logs and unowned history remain unchanged and render as inert text', () => {
  const f = fixture();
  const messages = [
    '[店铺：甲店] 判断数据：费用 120 元；订单 50',
    '[店铺：乙店] 暂停计划：准备处理 1 条',
    '[店铺：甲店] 开启计划：回读确认成功',
    '[店铺：乙店] 执行重试：第 2 次',
    '[店铺：甲店] 批次结果：暂停成功',
    '[店铺：乙店] 新店接管：已加入值守',
    '[每日开启任务] 今日任务已登记',
    '[店铺未标明] 读取失败：缺少归属',
    '[店铺：甲 & <乙>] 读取失败：<img src=x onerror=fixture>',
  ];
  const logs = Object.freeze(messages.map((msg) => Object.freeze({ t: 'fixture', level: 'info', msg })));
  const before = JSON.stringify(logs);
  f.render(logs);
  assert.deepEqual(f.messages(), messages);
  const unowned = legacy('poll', '（说明：登录失效：请重新登录）');
  assert.equal(f.project(unowned), '登录失效：请重新登录');
  const owned = legacy('poll', '（说明：读取失败：<img src=x onerror=fixture>）', 'error', '[店铺：甲 & <乙>] ');
  f.render([owned]);
  assert.equal(f.messages().at(-1), '[店铺：甲 & <乙>] 读取失败：<img src=x onerror=fixture>');
  assert.equal(JSON.stringify(logs), before);
});

test('current processing badge follows server owners, clears stale names, and never renders HTML', () => {
  const badge = element();
  const render = (processingShops) => vm.runInNewContext(badgeSource, {
    $: (id) => { assert.equal(id, 'wdStatusBadge'); return badge; },
    s: { processingShops }, st: { text: '检查中', cls: 'wd-reading' },
  });
  render([{ id: 'shop-a', name: '甲店' }]);
  assert.equal(badge.textContent, '检查中 · 正在处理：甲店');
  render([{ id: 'shop-b', name: '乙店' }]);
  assert.equal(badge.textContent, '检查中 · 正在处理：乙店');
  render([{ id: 'shop-c', name: '<img src=x onerror=fixture>' }]);
  assert.equal(badge.textContent, '检查中 · 正在处理：<img src=x onerror=fixture>');
  render([]);
  assert.equal(badge.textContent, '检查中');
  render(undefined);
  assert.equal(badge.textContent, '检查中');
});

test('real loader advances the API cursor through mixed, hidden-only and empty batches without mutating logs', async () => {
  const f = fixture();
  const business = Object.freeze({ seq: 2, t: 'fixture', level: 'error', msg: '[店铺：甲店] 读取失败' });
  const batches = Object.freeze([
    Object.freeze({ ok: true, seq: 90, logs: Object.freeze([internal[0], business, internal[1]]) }),
    Object.freeze({ ok: true, seq: 95, logs: internal }),
    Object.freeze({ ok: true, seq: 100, logs: Object.freeze([{ ...business, seq: 96, msg: '[店铺：乙店] 回读成功' }]) }),
    Object.freeze({ ok: true, seq: 105, logs: Object.freeze([]) }),
  ]);
  const original = JSON.stringify(batches);
  const requests = [], gaps = [];
  let batch = 0;
  Object.assign(f.sandbox, {
    stateReadVersion: 0, lastSeq: 0, shopDeleteState: {}, window: {},
    wd: { logs: batches[0].logs },
    showDeleteReceipts() {}, renderState() {},
    setError(message) { assert.equal(message, ''); },
    renderGap(gap) { gaps.push(gap); },
    async api(method, url) {
      assert.equal(method, 'GET');
      if (url === '/api/watch-drill/state') return { ok: true, state: { shopRows: [] } };
      requests.push(url);
      return batches[batch++];
    },
  });
  vm.runInContext(loader, f.sandbox, { filename: 'index.html:loadStateAndLogs' });
  for (const expected of [90, 95, 100, 105]) {
    await f.sandbox.loadStateAndLogs();
    assert.equal(f.sandbox.lastSeq, expected);
  }
  assert.deepEqual(requests, [0, 90, 95, 100].map((seq) => '/api/watch-drill/logs?since=' + seq));
  assert.deepEqual(f.messages(), ['[店铺：甲店] 读取失败', '[店铺：乙店] 回读成功']);
  assert.equal(f.sandbox.wd.logs, batches[0].logs);
  assert.equal(JSON.stringify(batches), original);
  assert.equal(gaps.length, 4);
});

test('existing 400-row display limit does not truncate the input history', () => {
  const f = fixture();
  const history = Object.freeze(Array.from({ length: 405 }, (_, seq) => Object.freeze({
    seq, t: 'fixture', level: 'info', msg: '[店铺：甲店] 判断数据 ' + seq,
  })).concat(internal));
  const original = JSON.stringify(history);
  f.render(history);
  assert.equal(f.box.children.length, 400);
  assert.equal(f.messages()[0], '[店铺：甲店] 判断数据 5');
  assert.equal(f.messages().at(-1), '[店铺：甲店] 判断数据 404');
  assert.equal(JSON.stringify(history), original);
});
