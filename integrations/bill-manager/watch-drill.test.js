'use strict';

/**
 * 推广值守演练（watch-drill）隔离测试 —— 不触碰生产页面。
 *
 * 覆盖用户规则：
 * - 幂等启动/停止、停止后不再安排下一轮、正在读取按明确状态结束；
 * - 上海 08:00 后立即读取一次、每 30 分钟巡查、08:00 前等待、跨日等到次日 08:00；
 * - 判定：费用整数分 > 订单数×100 才超标（恰好相等不超标）；零订单/读取失败显示「本轮无法判断」；
 * - 强制只读：即使配置 realMode=true、pauseEnabled=true，演练入口仍零广告操作；
 * - 单轮读取超时不卡死调度；重启后默认未启动、日志可恢复；日志 scrub 敏感信息。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createWatchDrill, scrub } = require('../watch-drill');

const PROMO = 'C:/Users/Administrator/Documents/ChatGPT/推广广告控制';
const timeLib = require(path.join(PROMO, 'src/lib/time.js'));
const { shanghaiDate, shanghaiMs } = timeLib;

const SHOP_ID = '瑾漂亮潮流服饰';
const ACC = 'acc-1';

// 上海 2026-09-14 09:00:00（UTC 01:00:00）
const BASE_SH = shanghaiMs('2026-09-14', '09:00');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 可控时钟 ──────────────────────────────────────────────────
function makeClock(startMs) {
  let ms = startMs;
  return {
    now: () => ms,
    set: (v) => { ms = v; },
    advance: (v) => { ms += v; },
  };
}

// ── 可控定时器（捕获 setTimeout 回调，测试手动触发）────────────
function makeTimers() {
  const active = new Set();
  let seq = 0;
  return {
    delayFn: (ms, cb) => { const h = { id: ++seq, ms, cb, fired: false }; active.add(h); return h; },
    cancelTimer: (h) => { if (h) active.delete(h); },
    activeCount: () => active.size,
    pendingMs: () => [...active].map((h) => h.ms),
    fireAll: async () => {
      const list = [...active];
      active.clear();
      for (const h of list) { h.fired = true; await h.cb(); }
    },
  };
}

async function until(fn, timeout = 3000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error('until() 超时，状态未按预期变化');
    await new Promise((r) => setImmediate(r));
  }
}

function makeCfg(overrides = {}) {
  return {
    shops: [{ id: SHOP_ID, name: SHOP_ID, cookieFile: 'cf', accountId: ACC, enabled: true }],
    rules: [{ type: 'wholeShopCostPerOrder', thresholdCents: 100, enabled: true }],
    schedule: { dailyStartHour: 8, intervalMinutes: 30 },
    monitor: { snapshotMaxAgeMinutes: 30, chengfang: { pauseEnabled: true } },
    login: {},
    execution: { realMode: true },
    ...overrides,
  };
}

function mkSummary(kind, v, clock) {
  const bd = shanghaiDate(clock.now());
  const fetchedAt = new Date(clock.now()).toISOString();
  if (kind === 'cost') {
    return { source: 'promo-page', kind: 'cost', shopId: SHOP_ID, accountId: ACC, businessDate: bd, fetchedAt, valueCents: v, rawText: String(v / 100) };
  }
  return { source: 'promo-page', kind: 'orders', shopId: SHOP_ID, accountId: null, businessDate: bd, fetchedAt, valueCount: v, rawText: String(v) };
}

function makeReaders(clock, opts = {}) {
  // calls.costPeak/orderPeak：并发读取峰值，用于断言任一时刻最多一个活跃读取任务
  const calls = { cost: 0, order: 0, costActive: 0, orderActive: 0, costPeak: 0, orderPeak: 0 };
  const adOps = [];
  const begin = (k) => { calls[k]++; calls[k + 'Active']++; calls[k + 'Peak'] = Math.max(calls[k + 'Peak'], calls[k + 'Active']); };
  const finish = (k) => { calls[k + 'Active']--; };
  return {
    costReader: {
      kind: 'cost',
      async readCostSummary() {
        begin('cost');
        try {
          if (opts.costError) throw opts.costError;
          if (opts.costHang) return await new Promise(() => {});
          // costDelay 仅作用于首次调用（构造「首轮超时、随后延迟结束」的回归场景）
          if (opts.costDelay) { const d = opts.costDelay; opts.costDelay = 0; await sleep(d); }
          return mkSummary('cost', opts.costCents, clock);
        } finally { finish('cost'); }
      },
    },
    orderReader: {
      kind: 'orders',
      async readOrderSummary() {
        begin('order');
        try {
          if (opts.orderError) throw opts.orderError;
          if (opts.orderHang) return await new Promise(() => {});
          if (opts.orderDelay) await sleep(opts.orderDelay);
          return mkSummary('orders', opts.orderCount, clock);
        } finally { finish('order'); }
      },
    },
    calls,
    adOps,
  };
}

function makeDrill(clock, timers, opts = {}) {
  const readers = opts.readers || makeReaders(clock, opts);
  const drill = createWatchDrill({
    shopName: SHOP_ID,
    persistFile: opts.persistFile || null,
    nowFn: clock.now,
    delayFn: timers.delayFn,
    cancelTimer: timers.cancelTimer,
    readTimeoutMs: opts.readTimeoutMs || 60000,
    prevGraceMs: opts.prevGraceMs || 20,
    config: makeCfg(opts.cfg),
    readers: { costReader: readers.costReader, orderReader: readers.orderReader },
    cookieMetaCheck: opts.cookieMetaCheck || (() => {}),
  });
  return { drill, readers };
}

const allLogs = (drill) => drill.logs.map((l) => l.msg).join('\n');

// ══════════════════════════════════════════════════════════════
// 1) 默认状态与强制只读标识
// ══════════════════════════════════════════════════════════════
test('创建后默认未启动，且为强制只读演练', () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers);
  const s = drill.snapshot();
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(s.forcedDrill, true);
  assert.strictEqual(s.statusText, '未启动');
  assert.strictEqual(timers.activeCount(), 0);
  assert.strictEqual(drill.logs.length, 0);
});

test('watch-drill 模块不含任何广告操作代码路径', () => {
  const src = fs.readFileSync(require.resolve('../watch-drill'), 'utf-8');
  const reqs = [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);
  for (const r of reqs) {
    assert.ok(!/ad-controller|chengfang|executor|close-flow|pause|enable|delete/i.test(r), `禁止引用广告操作模块: ${r}`);
  }
  for (const bad of ['closeAd', 'pauseAd', 'batchPause', 'ad-controller']) {
    assert.ok(!src.includes(bad), `模块不应包含: ${bad}`);
  }
});

// ══════════════════════════════════════════════════════════════
// 2) 启动/停止/幂等
// ══════════════════════════════════════════════════════════════
test('08:00 后启动立即读取一轮，随后等待下一轮（30 分钟）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill, readers } = makeDrill(clock, timers, { costCents: 7937, orderCount: 89 });
  drill.start();
  assert.strictEqual(drill.snapshot().status, 'reading');
  await until(() => drill.snapshot().status === 'waiting');
  assert.strictEqual(readers.calls.cost, 1);
  assert.strictEqual(readers.calls.order, 1);
  const s = drill.snapshot();
  assert.strictEqual(s.running, true);
  assert.ok(s.lastCheckAt);
  assert.ok(s.nextRunAt);
  assert.strictEqual(s.lastRound.conclusion, 'under');
  assert.strictEqual(new Date(s.nextRunAt).getTime(), BASE_SH + 30 * 60 * 1000);
  assert.strictEqual(timers.activeCount(), 1);
  const log = allLogs(drill);
  assert.ok(log.includes('开始读取'));
  assert.ok(log.includes('业务日期 2026-09-14'));
  assert.ok(log.includes('费用=千川账户整体消耗：79.37 元'));
  assert.ok(log.includes('订单=罗盘经营概况（全店+实时）：89 单'));
  assert.ok(log.includes('每单约0.89元'));
  assert.ok(log.includes('7937分 ≤ 89×100分=8900分，未超标。本轮仅演练，不暂停广告。'));
  assert.ok(log.includes('本轮耗时'));
  assert.ok(log.includes('下次检查时间'));
});

test('重复点击启动幂等：不产生多个循环', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill, readers } = makeDrill(clock, timers, { costCents: 5000, orderCount: 100 });
  drill.start();
  drill.start();
  drill.start();
  await until(() => drill.snapshot().status === 'waiting');
  assert.strictEqual(readers.calls.cost, 1, '只应执行一轮');
  assert.strictEqual(readers.calls.order, 1);
  assert.strictEqual(timers.activeCount(), 1, '只应有一个下一轮定时器');
});

test('停止在读取中：按明确状态结束，不误报立即停止，且不再安排下一轮', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill, readers } = makeDrill(clock, timers, { costCents: 5000, orderCount: 100, costDelay: 120 });
  drill.start();
  await until(() => readers.calls.cost === 1); // 读取已开始
  drill.stop();
  let s = drill.snapshot();
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.status, 'reading', '读取中停止：状态保持读取中，等待本轮明确结束');
  await until(() => drill.snapshot().status === 'idle');
  s = drill.snapshot();
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(s.nextRunAt, null);
  assert.strictEqual(timers.activeCount(), 0, '停止后不得再安排下一轮');
  const log = allLogs(drill);
  assert.ok(log.includes('值守停止：不再开始新一轮'));
  assert.ok(log.includes('值守已停止，不再安排下一轮'));
});

test('停止在等待中：立即空闲，定时器取消', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 5000, orderCount: 100 });
  drill.start();
  await until(() => drill.snapshot().status === 'waiting');
  drill.stop();
  const s = drill.snapshot();
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(s.nextRunAt, null);
  assert.strictEqual(timers.activeCount(), 0);
});

test('停止后再次启动可重新开始值守', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill, readers } = makeDrill(clock, timers, { costCents: 5000, orderCount: 100 });
  drill.start();
  await until(() => drill.snapshot().status === 'waiting');
  drill.stop();
  await until(() => drill.snapshot().status === 'idle');
  drill.start();
  await until(() => drill.snapshot().status === 'waiting');
  assert.strictEqual(readers.calls.cost, 2, '重新启动应执行新一轮');
});

// ══════════════════════════════════════════════════════════════
// 3) 判定与日志
// ══════════════════════════════════════════════════════════════
test('超标：费用整数分 > 订单数×100', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 10001, orderCount: 100 });
  drill.start();
  await until(() => drill.snapshot().status === 'waiting');
  const s = drill.snapshot();
  assert.strictEqual(s.lastRound.conclusion, 'over');
  assert.strictEqual(s.lastRound.conclusionText, '超标');
  const log = allLogs(drill);
  assert.ok(log.includes('费用100.01元，订单100单，每单约1.00元'));
  assert.ok(log.includes('10001分 > 100×100分=10000分，超标'));
  assert.ok(log.includes('应暂停乘方全店托管和商品自选，本轮未执行（仅演练，不操作广告）。'));
});

test('恰好等于阈值（1 元/单）不超标', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 10000, orderCount: 100 });
  drill.start();
  await until(() => drill.snapshot().status === 'waiting');
  const s = drill.snapshot();
  assert.strictEqual(s.lastRound.conclusion, 'under');
  assert.strictEqual(s.lastRound.conclusionText, '未超标');
  const log = allLogs(drill);
  assert.ok(log.includes('10000分 ≤ 100×100分=10000分，未超标。本轮仅演练，不暂停广告。'));
});

test('零订单显示「本轮无法判断」且记录原因', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 500, orderCount: 0 });
  drill.start();
  await until(() => drill.snapshot().status === 'waiting');
  const s = drill.snapshot();
  assert.strictEqual(s.lastRound.conclusion, 'unknown');
  assert.strictEqual(s.lastRound.conclusionText, '本轮无法判断');
  const log = allLogs(drill);
  assert.ok(log.includes('全店订单为 0 但推广费用大于 0：数据异常'));
});

test('读取失败显示「本轮无法判断」，且仍安排下一轮（避免静默停机）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { orderError: new Error('登录失效：Cookie 过期') });
  drill.start();
  await until(() => drill.snapshot().status === 'failed');
  const s = drill.snapshot();
  assert.strictEqual(s.running, true);
  assert.strictEqual(s.status, 'failed');
  assert.strictEqual(s.statusText, '读取失败');
  assert.ok(s.nextRunAt, '失败也必须记录下一轮安排');
  assert.strictEqual(timers.activeCount(), 1);
  const log = allLogs(drill);
  assert.ok(log.includes('本轮无法判断：登录失效：Cookie 过期'), '说明性中文文本不被遮蔽');
  assert.ok(log.includes('失败也记录下一轮安排，避免静默停机'));
});

test('登录 Cookie 静态核验失败：本轮无法判断，不读取数据', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill, readers } = makeDrill(clock, timers, {
    costCents: 5000, orderCount: 100,
    cookieMetaCheck: () => { throw new Error('店铺「瑾漂亮潮流服饰」的抖站 Cookie 已过有效期'); },
  });
  drill.start();
  await until(() => drill.snapshot().status === 'failed');
  assert.strictEqual(readers.calls.cost, 0, 'Cookie 失效不得启动浏览器读取');
  assert.strictEqual(readers.calls.order, 0);
  assert.ok(allLogs(drill).includes('本轮无法判断'));
});

// ══════════════════════════════════════════════════════════════
// 4) 调度：08:00 前等待 / 跨日
// ══════════════════════════════════════════════════════════════
test('08:00 前启动：等待到当日 08:00，不立即读取', async () => {
  const clock = makeClock(shanghaiMs('2026-09-14', '07:30'));
  const timers = makeTimers();
  const { drill, readers } = makeDrill(clock, timers, { costCents: 5000, orderCount: 100 });
  drill.start();
  const s = drill.snapshot();
  assert.strictEqual(s.status, 'waiting08');
  assert.strictEqual(s.statusText, '等待08:00');
  assert.strictEqual(readers.calls.cost, 0);
  assert.strictEqual(timers.activeCount(), 1);
  assert.strictEqual(new Date(s.nextRunAt).getTime(), shanghaiMs('2026-09-14', '08:00'));
  // 时钟走到 08:00 后触发定时器 → 立即读取
  clock.set(shanghaiMs('2026-09-14', '08:00'));
  await timers.fireAll();
  await until(() => drill.snapshot().status === 'waiting');
  assert.strictEqual(readers.calls.cost, 1, '到 08:00 后应执行第一轮读取');
});

test('跨日：23:30 轮次后等待到次日 08:00', async () => {
  const clock = makeClock(shanghaiMs('2026-09-14', '23:30'));
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 5000, orderCount: 100 });
  drill.start();
  await until(() => drill.snapshot().status === 'waiting08');
  const s = drill.snapshot();
  assert.strictEqual(s.status, 'waiting08');
  assert.strictEqual(new Date(s.nextRunAt).getTime(), shanghaiMs('2026-09-15', '08:00'));
  const log = allLogs(drill);
  assert.ok(log.includes('业务日期 2026-09-14'));
});

test('读取失败跨日：状态显示读取失败且仍等待次日 08:00', async () => {
  const clock = makeClock(shanghaiMs('2026-09-14', '23:30'));
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { orderError: new Error('读取失败') });
  drill.start();
  await until(() => drill.snapshot().status === 'failed');
  const s = drill.snapshot();
  assert.strictEqual(s.status, 'failed');
  assert.strictEqual(new Date(s.nextRunAt).getTime(), shanghaiMs('2026-09-15', '08:00'));
});

// ══════════════════════════════════════════════════════════════
// 5) 强制只读边界：双真实开关全开仍零广告操作
// ══════════════════════════════════════════════════════════════
test('即使 realMode=true 且 pauseEnabled=true，演练仍只读取数据，零广告操作', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill, readers } = makeDrill(clock, timers, {
    costCents: 10001, orderCount: 100, // 超标情形：若演练误操作会去暂停
    cfg: {
      shops: [{ id: SHOP_ID, name: SHOP_ID, cookieFile: 'cf', accountId: ACC, enabled: true }],
      rules: [{ type: 'wholeShopCostPerOrder', thresholdCents: 100, enabled: true }],
      schedule: { dailyStartHour: 8, intervalMinutes: 30 },
      monitor: { snapshotMaxAgeMinutes: 30, chengfang: { pauseEnabled: true } },
      login: {},
      execution: { realMode: true },
    },
  });
  drill.start();
  await until(() => drill.snapshot().status === 'waiting');
  assert.strictEqual(readers.calls.cost, 1);
  assert.strictEqual(readers.calls.order, 1);
  assert.deepStrictEqual(readers.adOps, [], '不得有任何广告操作');
  // 状态机全程只有读取（cost/order）两个调用源
  const s = drill.snapshot();
  assert.strictEqual(s.lastRound.conclusion, 'over');
  assert.strictEqual(s.lastRound.conclusionText, '超标');
  assert.ok(s.lastRound.reason.includes('全店触发'));
});

// ══════════════════════════════════════════════════════════════
// 6) 单轮超时 / 日志安全 / 重启语义 / HTTP 接口
// ══════════════════════════════════════════════════════════════
test('读取超时不卡死调度：本轮无法判断，下一轮仍安排', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill, readers } = makeDrill(clock, timers, { costHang: true, readTimeoutMs: 60 });
  drill.start();
  await until(() => drill.snapshot().status === 'failed', 3000);
  assert.strictEqual(readers.calls.cost, 1);
  const s = drill.snapshot();
  assert.ok(s.nextRunAt, '超时后仍要安排下一轮');
  assert.strictEqual(timers.activeCount(), 1);
  const log = allLogs(drill);
  assert.ok(log.includes('费用读取超时（0 秒），本轮无法判断'));
});

test('日志 scrub：Cookie/令牌绝不写入日志', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, {
    costError: new Error('读取失败 cookie=SUPER_SECRET_ABC123 token=TOKEN_XYZ_987654321'),
  });
  drill.start();
  await until(() => drill.snapshot().status === 'failed');
  const log = allLogs(drill);
  assert.ok(!log.includes('SUPER_SECRET_ABC123'), '不得出现原始 Cookie 值');
  assert.ok(!log.includes('TOKEN_XYZ_987654321'), '不得出现原始令牌值');
  assert.ok(log.includes('cookie=***'));
  assert.ok(log.includes('token=***'));
  assert.strictEqual(scrub('Bearer abcdefghijklmnopqrstuvwxyz0123456789'), 'Bearer ***');
});

test('重启语义：新实例默认未启动，日志从 JSONL 恢复', async () => {
  const tmp = path.join(os.tmpdir(), `wd-restart-${Date.now()}.jsonl`);
  try {
    const clock1 = makeClock(BASE_SH);
    const timers1 = makeTimers();
    const { drill: d1 } = makeDrill(clock1, timers1, { persistFile: tmp, costCents: 5000, orderCount: 100 });
    d1.start();
    await until(() => d1.snapshot().status === 'waiting');
    assert.ok(d1.logs.length > 0);

    const clock2 = makeClock(BASE_SH + 5 * 60 * 1000);
    const timers2 = makeTimers();
    const { drill: d2 } = makeDrill(clock2, timers2, { persistFile: tmp, costCents: 5000, orderCount: 100 });
    const s = d2.snapshot();
    assert.strictEqual(s.running, false, '服务重启默认不自动恢复值守');
    assert.strictEqual(s.status, 'idle');
    assert.ok(d2.logs.length > 0, '日志应从 JSONL 恢复');
    assert.strictEqual(timers2.activeCount(), 0);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
});

test('HTTP 接口：state/start/stop/logs(since 增量)', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 5000, orderCount: 100 });

  function fakeRes() {
    const chunks = [];
    return {
      chunks,
      writeHead(code, h) { this.code = code; this.headers = h; },
      end(s) { chunks.push(s); },
      json() { return JSON.parse(chunks.join('')); },
    };
  }
  const req = (url, method) => ({ url, method });

  let res = fakeRes();
  await drill.serveHttp(req('/api/watch-drill/state', 'GET'), res);
  let d = res.json();
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.state.running, false);
  assert.strictEqual(d.state.statusText, '未启动');

  res = fakeRes();
  await drill.serveHttp(req('/api/watch-drill/start', 'POST'), res);
  d = res.json();
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.state.running, true);
  await until(() => drill.snapshot().status === 'waiting');

  // 增量日志
  res = fakeRes();
  await drill.serveHttp(req('/api/watch-drill/logs?since=0', 'GET'), res);
  d = res.json();
  assert.ok(d.logs.length > 0);
  assert.strictEqual(d.seq, drill.logs[drill.logs.length - 1].seq);
  const since = d.seq;
  res = fakeRes();
  await drill.serveHttp(req(`/api/watch-drill/logs?since=${since}`, 'GET'), res);
  d = res.json();
  assert.strictEqual(d.logs.length, 0, 'since 之后无新日志');

  res = fakeRes();
  await drill.serveHttp(req('/api/watch-drill/stop', 'POST'), res);
  d = res.json();
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.state.running, false);

  res = fakeRes();
  await drill.serveHttp(req('/api/watch-drill/nope', 'GET'), res);
  assert.strictEqual(res.json().error, 'Not Found');
});

test('页面加载绝不自动启动（serveHttp 只读接口无副作用）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill, readers } = makeDrill(clock, timers, { costCents: 5000, orderCount: 100 });
  const res = { writeHead() {}, end() {} };
  await drill.serveHttp({ url: '/api/watch-drill/state', method: 'GET' }, res);
  await drill.serveHttp({ url: '/api/watch-drill/logs?since=0', method: 'GET' }, res);
  assert.strictEqual(readers.calls.cost, 0, '只读接口不得触发读取');
  assert.strictEqual(drill.snapshot().running, false);
  assert.strictEqual(timers.activeCount(), 0);
});

// ══════════════════════════════════════════════════════════════
// 7) 超时重叠修复回归：单一活跃读取守护
// ══════════════════════════════════════════════════════════════
const unsettledReads = (drill) => drill._internal._activeReads.filter((e) => !e.settled).length;

test('回归：旧读取永久未结束 → 后续轮次跳过读取并显示「等待旧读取结束」，不堆积、不静默卡住', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill, readers } = makeDrill(clock, timers, { costHang: true, readTimeoutMs: 60, prevGraceMs: 10 });
  drill.start();
  await until(() => drill.snapshot().status === 'failed'); // 首轮 60ms 超时，读取永久未结束
  assert.strictEqual(readers.calls.cost, 1);
  assert.strictEqual(unsettledReads(drill), 1, '超时读取仍在运行（未结束）');

  for (let i = 0; i < 3; i++) {
    clock.advance(30 * 60 * 1000);
    await timers.fireAll();
    await until(() => drill.snapshot().status === 'failed');
    assert.strictEqual(readers.calls.cost, 1, '旧读取未结束时不得启动新读取');
    assert.strictEqual(readers.calls.order, 0, '订单读取不得越过未结束的旧费用读取');
    assert.strictEqual(unsettledReads(drill), 1, '同一值守实例最多一个活跃读取任务');
    assert.strictEqual(timers.activeCount(), 1, '仍只安排下一轮，不堆积定时器');
    assert.ok(drill.snapshot().nextRunAt, '跳过轮次仍记录下一轮安排（避免静默停机）');
  }
  const log = allLogs(drill);
  assert.ok(log.includes('等待旧读取结束'), '应显示「等待旧读取结束」');
  assert.ok(!log.includes('本轮继续'), '不得出现旧的「超时读取仍在运行……本轮继续」放行行为');
  assert.strictEqual(readers.calls.costPeak, 1, '费用读取并发峰值不得超过 1');
  assert.strictEqual(readers.calls.orderPeak, 0);
});

test('回归：旧读取延迟结束后恢复读取（下一轮正常判定，不误跳轮次）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill, readers } = makeDrill(clock, timers, {
    costCents: 7937, orderCount: 89, costDelay: 80, readTimeoutMs: 30, prevGraceMs: 10,
  });
  drill.start();
  await until(() => drill.snapshot().status === 'failed'); // 首轮 30ms 超时（读取 80ms 后才结束）
  assert.strictEqual(readers.calls.cost, 1);
  await sleep(120); // 等旧读取真实结束并确认释放
  assert.strictEqual(unsettledReads(drill), 0, '旧读取延迟结束后已确认释放');

  clock.advance(30 * 60 * 1000);
  await timers.fireAll();
  await until(() => drill.snapshot().status === 'waiting');
  assert.strictEqual(readers.calls.cost, 2, '旧读取结束后下一轮恢复正常读取');
  assert.strictEqual(readers.calls.order, 1);
  const s = drill.snapshot();
  assert.strictEqual(s.lastRound.conclusion, 'under');
  assert.strictEqual(s.lastRound.roundNo, 2);
  assert.ok(!allLogs(drill).includes('等待旧读取结束'), '本轮无需等待，直接读取');
  assert.strictEqual(readers.calls.costPeak, 1, '恢复后仍无并发读取');
});

test('回归：读取中停止后立即重启，旧读取未结束前不得启动新读取', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill, readers } = makeDrill(clock, timers, { costHang: true, readTimeoutMs: 60, prevGraceMs: 10 });
  drill.start();
  await until(() => readers.calls.cost === 1); // 首轮读取中
  drill.stop();
  assert.strictEqual(drill.snapshot().status, 'reading', '读取中停止：状态保持读取中，等待本轮明确结束');
  drill.start(); // 立即重启
  await until(() => drill.snapshot().status === 'failed'); // 首轮超时结束 + 重启轮被读取门禁拦截
  assert.strictEqual(readers.calls.cost, 1, '旧读取未结束时，重启后的轮次不得启动新读取');
  assert.strictEqual(unsettledReads(drill), 1, '同一值守实例最多一个活跃读取任务');
  const s = drill.snapshot();
  assert.strictEqual(s.running, true, '重启后值守保持运行');
  assert.ok(s.nextRunAt, '被拦截的轮次仍安排下一轮，不静默停机');
  assert.strictEqual(timers.activeCount(), 1);
  assert.ok(allLogs(drill).includes('等待旧读取结束'), '重启轮应显示「等待旧读取结束」');
  assert.strictEqual(readers.calls.costPeak, 1);
  assert.strictEqual(readers.calls.orderPeak, 0);
});
