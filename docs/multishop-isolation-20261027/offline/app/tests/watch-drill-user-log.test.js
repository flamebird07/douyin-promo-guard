'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'watch-drill.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const NOW = Date.parse('2026-10-29T06:00:00Z');

function fixture(restored = []) {
  const files = new Map([['memory-log', restored.map((e) => JSON.stringify(e)).join('\n') + (restored.length ? '\n' : '')]]);
  const writes = [];
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, __dirname: path.resolve(__dirname, '..'), __filename: path.join(__dirname, '..', 'watch-drill.js'),
    process: { env: { PROMO_GUARD_DIR: 'fixture-guard', PUBLISHER_DIR: 'fixture-publisher' }, pid: 1 },
    console: { log() {} }, URL, Date, Buffer,
    setTimeout() { throw new Error('timers forbidden'); }, clearTimeout() {},
    setInterval() { throw new Error('timers forbidden'); }, clearInterval() {},
    require(id) {
      if (id === 'path') return path;
      if (id === 'fs') return {
        existsSync: (p) => String(p).replace(/\\/g, '/').endsWith('/src/engine/monitor.js'),
        readFileSync(p) { if (files.has(p)) return files.get(p); throw new Error('fixture file unavailable'); },
        appendFileSync(p, text) { assert.equal(p, 'memory-log'); writes.push(text); files.set(p, files.get(p) + text); },
        statSync() { return { size: 100 }; },
      };
      if (id === 'child_process') return { spawn() { throw new Error('spawn forbidden'); } };
      if (id === './promo-plan-scheduler') return {};
      const normalized = id.replace(/\\/g, '/');
      if (normalized.endsWith('/src/lib/time.js')) return { shanghaiDate: () => '2026-10-29', shanghaiClockText: () => '2026-10-29 14:00:00' };
      if (normalized.endsWith('/src/lib/money.js')) return { centsToYuan: (n) => (n / 100).toFixed(2) };
      if (normalized.endsWith('/src/lib/log.js')) return { compactUrls: (s) => String(s) };
      if (normalized.endsWith('/src/engine/rules.js')) return { SPEND_FLOOR_CENTS: 5000 };
      if (normalized.endsWith('/src/lib/bounded-poll.js')) return { resolvePollingConfig: () => ({ timeoutMs: 15000, intervalMs: 2000 }) };
      throw new Error('unexpected dependency: ' + id);
    },
  };
  vm.runInNewContext(source, sandbox, { filename: 'watch-drill.js' });
  const shops = [
    { id: 'shop-a', name: 'fixture-a', displayName: '甲店', enabled: true },
    { id: 'shop-b', name: 'fixture-b', displayName: '乙店', enabled: true },
  ];
  const config = { shops, execution: { realMode: false, dryRun: true }, monitor: { chengfang: {} }, schedule: {}, rules: [] };
  const drill = module.exports.createWatchDrill({ config, nowFn: () => NOW, persistFile: 'memory-log', notify: { enabled: false } });
  const events = [];
  const monitor = {
    config, running: true, realMode: false, cycleNo: 1, _evtSeq: 0, _shopProcessing: new Set(),
    gatePreview: () => ({ pauseAllowed: false, enableAllowed: false }),
    getStatus() {
      return {
        businessDate: '2026-10-29', shops, rules: [],
        monitor: { running: true, phase: 'running', cycleRunning: this._shopProcessing.size > 0, cycleNo: 1, enablePhaseToday: [] },
      };
    },
    getEventStream(since) {
      return { seq: this._evtSeq, events: events.filter((e) => e.evtSeq > since), droppedCount: this.droppedCount || 0,
        dropped: this.droppedCount ? [{ firstSeq: 1, lastSeq: this.droppedCount, count: this.droppedCount }] : [] };
    },
    start() { throw new Error('start forbidden'); }, stop() { throw new Error('stop forbidden'); },
  };
  drill._internal._monitor = monitor;
  drill._internal._runtimeFingerprint = { fixture: true };
  function emit(fields) {
    const event = Object.freeze({ evtType: 'process', ts: '2026-10-29T06:00:00Z', ...fields, evtSeq: ++monitor._evtSeq });
    events.push(event);
    return event;
  }
  async function logs(since = 0) {
    let body;
    let code;
    await drill.serveHttp({ method: 'GET', url: '/api/watch-drill/logs?since=' + since, headers: {} }, {
      writeHead(value) { code = value; }, setHeader() {}, end(value) { body = JSON.parse(value); },
    });
    assert.equal(code, 200, JSON.stringify(body));
    return body;
  }
  return { drill, monitor, events, emit, logs, writes, files, shops };
}

test('normal internal process telemetry is hidden while the raw stream and cursor stay intact', async () => {
  const f = fixture();
  f.emit({ kind: 'doudian-arrival', shopId: 'shop-a', event: 'checkpoint' });
  f.emit({ kind: 'chengfang-entry', shopId: 'shop-a', event: 'route-observation' });
  f.emit({ kind: 'session-cookie-writeback', shopId: 'shop-a', ok: true, reason: 'session checkpoint' });
  f.emit({ kind: 'chengfang', shopId: 'shop-a', event: 'identity', ok: true });
  f.emit({ kind: 'unfamiliar-enable-telemetry', shopId: 'shop-b' });
  const original = JSON.stringify(f.events);
  const result = await f.logs();
  assert.equal(result.logs.length, 0);
  assert.equal(result.consumedEvtSeq, 5);
  assert.equal(result.droppedCount, 0);
  assert.equal(JSON.stringify(f.events), original);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.logs()).logs.length, 0);
});

test('INTERNAL process categories suppress every failure form without changing raw events or cursor', async () => {
  const f = fixture();
  const samples = [
    { ok: true, reason: '回写失败' },
    { failed: true, reason: '内部步骤文案已改变' },
    { error: '登录凭据保存失败' },
    { ok: false, reason: '源上下文在独立验证期间已推进 Cookie：不提交过时候选、不回灌、不合并' },
    { success: false, reason: '读取通道暂时不可用' },
    { blocked: true },
    { status: 'read_failed' },
    { result: 'blocked' },
    { outcome: 'partial' },
    { event: 'retry', attempt: 2 },
    { event: 'readback', confirmed: 0 },
    ...['info', 'warn', 'warning', 'error', 'fatal'].map((level) => ({ level, reason: '不同的内部诊断' })),
  ];
  for (const evtType of ['process', 'future-event-type']) {
    for (const kind of ['cookie-writeback', 'session-cookie-writeback', 'checkpoint-propagate']) {
      for (const entry of samples) f.emit({ evtType, kind, shopId: 'shop-a', ...entry });
    }
  }
  const original = JSON.stringify(f.events);
  const result = await f.logs();
  assert.equal(result.logs.length, 0);
  assert.equal(result.consumedEvtSeq, f.events.length);
  assert.equal(result.droppedCount, 0);
  assert.equal(JSON.stringify(f.events), original);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.logs()).logs.length, 0);
  f.emit({ evtType: 'error', shopId: 'shop-b', error: '读取失败：Cookie 无效' });
  const next = await f.logs(result.seq);
  assert.equal(next.logs.length, 1);
  assert.match(next.logs[0].msg, /^\[店铺：乙店\].*读取失败：Cookie 无效/);
  assert.equal(next.consumedEvtSeq, f.events.length);
});

test('judgements, pause/enable, retries, readback and results remain shop-scoped business logs', async () => {
  const f = fixture();
  f.emit({ evtType: 'judgement', kind: 'judgement', shopId: 'shop-a', cycleNo: 1, costCents: 12000, orders: 50, thresholdCents: 100, over: true, decision: 'should_pause' });
  f.emit({ kind: 'chengfang', event: 'plan', shopId: 'shop-a', targets: ['p1'] });
  f.emit({ kind: 'chengfang', event: 'retry', shopId: 'shop-a', attempt: 2 });
  f.emit({ kind: 'chengfang', event: 'readback', shopId: 'shop-a', confirmed: ['p1'] });
  f.emit({ evtType: 'batch', shopId: 'shop-a', actionType: 'pause', outcome: 'ok', allPausedConfirmed: true, counts: { confirmed: 1 }, targets: ['p1'] });
  f.emit({ kind: 'chengfang-enable', event: 'plan', shopId: 'shop-b', targets: ['p2'] });
  f.emit({ evtType: 'trigger', shopId: 'shop-b', mode: 'dry', targetAction: 'enable', targetCount: 1 });
  const result = await f.logs();
  assert.equal(result.logs.length, 7);
  for (const entry of result.logs.slice(0, 5)) assert.match(entry.msg, /^\[店铺：甲店\]/);
  for (const entry of result.logs.slice(5)) assert.match(entry.msg, /^\[店铺：乙店\]/);
  const text = result.logs.map((e) => e.msg).join('\n');
  for (const pattern of [/判断数据/, /暂停/, /重试/, /回读/, /批次结果/, /开启/]) assert.match(text, pattern);
  assert.doesNotMatch(text, /未识别事件名|过程事件/);
  assert.equal(result.logs[2].level, 'warn');
});

test('unrecognized real failures survive regardless of event name or success flags', async () => {
  const f = fixture();
  const samples = [
    { event: 'new-event', error: '读取失败：fixture detail' },
    { event: 'new-event', ok: false, reason: '页面不可用' },
    { event: 'new-event', status: 'read_failed' },
    { event: 'new-event', result: 'blocked' },
    { event: 'new-event', failed: true },
    { event: 'new-event', outcome: 'partial' },
    { kind: 'future-business', ok: true, reason: '回写失败' },
    { event: 'new-event', reason: '读取通道暂时不可用' },
    { evtType: 'error', error: '主读取错误' },
    { evtType: 'future-event-type', event: 'new-event', error: '新事件类型的真实错误' },
    ...['cookie-writeback', 'session-cookie-writeback', 'checkpoint-propagate'].map((kind) => ({
      evtType: 'error', kind, error: '读取失败：Cookie 无效',
    })),
    ...['poll', 'login', 'cookie-writeback-other', 'session-cookie-writeback-other', 'checkpoint-propagate-other'].map((kind) => ({
      kind, ok: false, reason: '源上下文在独立验证期间已推进 Cookie：不提交过时候选、不回灌、不合并',
    })),
    { kind: 'poll', event: 'cookie-writeback', error: '读取失败：Cookie 无效' },
    { kind: 'chengfang-overlay', result: 'blocked', reason: 'unknown-overlay:1' },
  ];
  for (const entry of samples) f.emit({ shopId: 'shop-b', ...entry });
  const result = await f.logs();
  assert.equal(result.logs.length, samples.length);
  for (const entry of result.logs) assert.match(entry.msg, /^\[店铺：乙店\]/);
  assert.match(result.logs[0].msg, /fixture detail/);
  assert.equal(result.logs[0].level, 'error');
  assert.match(result.logs.at(-1).msg, /浮窗处理受阻.*unknown-overlay:1/);
});

test('late A events are never attributed to active B and unowned events remain explicitly unowned', async () => {
  const f = fixture();
  f.monitor._shopProcessing.add('shop-a');
  f.emit({ event: 'readback', shopId: 'shop-a', confirmed: 1 });
  f.monitor._shopProcessing.clear();
  f.monitor._shopProcessing.add('shop-b');
  f.emit({ event: 'readback', shopId: 'shop-b', confirmed: 2 });
  f.emit({ event: 'late-error', shopId: 'shop-a', error: '延迟错误' });
  f.emit({ event: 'unowned-error', error: '缺少归属' });
  const result = await f.logs();
  assert.match(result.logs[0].msg, /^\[店铺：甲店\]/);
  assert.match(result.logs[1].msg, /^\[店铺：乙店\]/);
  assert.match(result.logs[2].msg, /^\[店铺：甲店\]/);
  assert.match(result.logs[3].msg, /^\[店铺未标明\]/);
  assert.doesNotMatch(result.logs[3].msg, /甲店|乙店/);
});

test('current processing projection follows actual owners and clears on idle without changing lifecycle', async () => {
  const f = fixture();
  for (const id of ['shop-a', 'shop-b']) {
    f.monitor._shopProcessing.clear();
    f.monitor._shopProcessing.add(id);
    await f.logs();
    const state = f.drill.snapshot();
    assert.equal(state.processingShops.length, 1);
    assert.equal(state.processingShops[0].id, id);
  }
  f.monitor._shopProcessing.clear();
  await f.logs();
  assert.equal(f.drill.snapshot().processingShops.length, 0);
  assert.equal(f.monitor.running, true);
  assert.equal(f.shops.every((s) => s.enabled === true), true);
});

test('global scheduler messages are not mislabeled as a shop', async () => {
  const f = fixture();
  f.monitor._shopProcessing.add('shop-a');
  f.emit({ kind: 'enable-scheduler', event: 'registered' });
  const result = await f.logs();
  assert.match(result.logs[0].msg, /^\[每日开启任务\]/);
  assert.doesNotMatch(result.logs[0].msg, /甲店/);
});

test('unknown shop IDs stay explicit and are not resolved by coincident display names', async () => {
  const f = fixture();
  f.emit({ event: 'retry', shopId: 'future-shop', attempt: 1 });
  f.emit({ event: 'retry', shopId: '甲店', attempt: 1 });
  const result = await f.logs();
  assert.match(result.logs[0].msg, /^\[店铺：future-shop\]/);
  assert.match(result.logs[1].msg, /^\[店铺：甲店\]/);
  assert.equal(f.shops[0].id, 'shop-a');
});

test('real trim gaps are still reported and hidden events are not counted as drops', async () => {
  const f = fixture();
  f.monitor._evtSeq = 3;
  f.monitor.droppedCount = 3;
  f.emit({ kind: 'doudian-arrival', event: 'checkpoint', shopId: 'shop-a' });
  f.emit({ event: 'readback', shopId: 'shop-a', confirmed: 1 });
  const result = await f.logs();
  assert.equal(result.droppedCount, 3);
  assert.equal(result.consumedEvtSeq, 5);
  assert.match(result.logs[0].msg, /日志缺口.*3 条/);
  assert.match(result.logs[1].msg, /回读/);
});

test('legacy telemetry is hidden only in the user projection; persisted errors and sequence survive', async () => {
  const raw = [
    { seq: 1, t: '2026-10-29T06:00:00Z', level: 'info', msg: '过程：过程事件（doudian-arrival）；未识别事件名，按原样透出' },
    { seq: 2, t: '2026-10-29T06:00:00Z', level: 'info', msg: '过程：过程事件（unfamiliar-error）；未识别事件名，按原样透出' },
    { seq: 3, t: '2026-10-29T06:00:00Z', level: 'error', msg: '过程：过程事件（doudian-arrival）（失败原因：读取失败）；未识别事件名，按原样透出' },
  ];
  const f = fixture(raw);
  const original = f.files.get('memory-log');
  const result = await f.logs();
  assert.deepEqual(result.logs.map((e) => e.seq), [2, 3]);
  assert.equal(result.seq, 3);
  assert.equal(f.drill._internal._logs.length, 3);
  assert.equal(f.files.get('memory-log'), original);
  assert.equal(f.writes.length, 0);
  assert.equal(f.drill.logs.length, 2);
  assert.equal((await f.logs(result.seq)).logs.length, 0);
});

test('legacy INTERNAL categories are projection-only at every severity and preserve persisted sequence', async () => {
  const raw = [], visible = [];
  function append(level, msg, hidden) {
    raw.push(Object.freeze({ seq: raw.length + 1, t: '2026-10-29T06:00:00Z', level, msg }));
    if (!hidden) visible.push(raw.length);
  }
  for (const level of ['info', 'warn', 'warning', 'error', 'fatal']) {
    for (const kind of ['cookie-writeback', 'session-cookie-writeback', 'checkpoint-propagate']) {
      for (const prefix of ['', '[店铺：甲店] ']) {
        for (const detail of ['', '（说明：回写失败）', '（失败原因：读取失败：Cookie 无效）', '（说明：全新内部文案（详情））']) {
          append(level, prefix + '过程：过程事件（' + kind + '）' + detail + '；未识别事件名，按原样透出', true);
        }
      }
    }
    for (const kind of ['poll', 'login', 'chengfang-overlay', 'future-event', 'cookie-writeback-other', 'session-cookie-writeback-other', 'checkpoint-propagate-other']) {
      append(level, '[店铺：乙店] 过程：过程事件（' + kind + '）（失败原因：读取失败：Cookie 无效）；未识别事件名，按原样透出', false);
    }
    append(level, '[店铺：乙店] 失败原因：cookie-writeback 读取失败：Cookie 无效', false);
  }
  const f = fixture(raw);
  const original = f.files.get('memory-log');
  const result = await f.logs();
  assert.deepEqual(result.logs.map((e) => e.seq), visible);
  assert.equal(result.seq, raw.length);
  assert.equal(f.drill._internal._logs.length, raw.length);
  assert.equal(f.drill.logs.length, visible.length);
  assert.equal(f.files.get('memory-log'), original);
  assert.equal(f.writes.length, 0);
  assert.equal((await f.logs(result.seq)).logs.length, 0);
});

test('the existing status badge switches shop names and clears stale names with inert text', () => {
  const start = html.indexOf("        var badge = $('wdStatusBadge');");
  const end = html.indexOf("        var btn = $('wdToggleBtn');", start);
  assert.ok(start >= 0 && end > start);
  const badge = { textContent: '', className: '' };
  const render = (shops) => vm.runInNewContext(html.slice(start, end), {
    $: (id) => { assert.equal(id, 'wdStatusBadge'); return badge; },
    s: { processingShops: shops }, st: { text: '检查中', cls: 'wd-reading' },
  });
  render([{ id: 'shop-a', name: '甲店' }]);
  assert.match(badge.textContent, /正在处理：甲店/);
  render([{ id: 'shop-b', name: '乙店' }]);
  assert.match(badge.textContent, /正在处理：乙店/);
  assert.doesNotMatch(badge.textContent, /甲店/);
  render([{ id: 'x', name: '<img src=x onerror=fixture>' }]);
  assert.match(badge.textContent, /<img/);
  assert.equal(badge.innerHTML, undefined);
  render([]);
  assert.equal(badge.textContent, '检查中');
});

test('user log text is rendered literally through textContent, without double escaping names', () => {
  const start = html.indexOf('      function renderLogs(logs) {');
  const end = html.indexOf('      async function loadStateAndLogs()', start);
  assert.ok(start >= 0 && end > start);
  function element() {
    return { children: [], appendChild(node) { this.children.push(node); }, querySelector() { return true; }, scrollHeight: 0 };
  }
  const box = element();
  const text = '[店铺：甲 & <乙>] 读取失败';
  vm.runInNewContext(html.slice(start, end) + '\nrenderLogs(logs);', {
    logs: [{ t: 'fixture', level: 'error', msg: text }], $: () => box,
    document: { createElement: element }, fmtTime: (s) => s, compactUrls: (s) => s,
    esc() { throw new Error('textContent must not double-escape'); },
  });
  assert.equal(box.children[0].children[1].textContent, text);
  assert.equal(box.children[0].children[1].innerHTML, undefined);
});
