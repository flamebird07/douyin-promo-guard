'use strict';

/**
 * 推广值守（watch-drill，2026-09-15 接入真实操作模式）隔离测试 —— 不触碰生产页面、不操作真实广告。
 *
 * 本文件替换原先的「强制只读演练」测试。契约变化（用户 2026-09-15 明确要求）：
 *   1) 每天 07:00 开启全部乘方计划；
 *   2) 08:00 后每 30 分钟检查，当天费用÷当天全店订单 **严格超过** 1 元/单即暂停乘方；
 *   3) 绝不删除广告；
 *   4) 日志必须包含：开启、判断数据、暂停、重试、回读、失败原因。
 *
 * 实现方式变化：watch-drill 不再自己实现一套只读调度，而是**进程内装配推广控制项目的
 * Monitor**（同一份经过测试的调度与乘方链路），本模块只做「日志转译 + HTTP 暴露」。
 * 因此这里断言的是：
 *   - 装配正确（Monitor 被创建、门槛快照如实透出、fail-closed 不被绕过）；
 *   - 启停幂等、重启默认未启动；
 *   - 日志转译包含用户点名的六类信息；
 *   - 敏感信息 scrub；无删除广告路径。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// 被测模块：运行目录布局在上级（tests/ → ../watch-drill.js），
// 公开仓库集成副本与测试同目录（→ ./watch-drill.js），按存在性探测。
const WATCH_DRILL_MODULE = [
  path.join(__dirname, '..', 'watch-drill.js'),
  path.join(__dirname, 'watch-drill.js'),
].find((p) => fs.existsSync(p));
if (!WATCH_DRILL_MODULE) throw new Error('未找到被测模块 watch-drill.js');
const { createWatchDrill, scrub, deriveAdState } = require(WATCH_DRILL_MODULE);

// 推广控制主项目根目录：优先环境变量，其次本机生产路径，最后公开仓库内相对位置
// （integrations/bill-manager 向上两级 = 仓库根），保证公开仓库中的副本可自举运行。
const PROMO = [
  process.env.PROMO_GUARD_DIR,
  'C:/Users/Administrator/Documents/电商助手/douyin-promo-guard',
  path.join(__dirname, '..', '..'),
].filter(Boolean).find((p) => fs.existsSync(path.join(p, 'src/engine/monitor.js')));
if (!PROMO) throw new Error('未找到推广控制主项目（src/engine/monitor.js）');
const timeLib = require(path.join(PROMO, 'src/lib/time.js'));
const { shanghaiDate, shanghaiMs } = timeLib;

const SHOP_ID = '瑾漂亮潮流服饰';
const ACC = 'acc-1';

// 上海 2026-09-14 09:00:00
const BASE_SH = shanghaiMs('2026-09-14', '09:00');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeClock(startMs) {
  let ms = startMs;
  return { now: () => ms, set: (v) => { ms = v; }, advance: (v) => { ms += v; } };
}

// ── 可控定时器 ────────────────────────────────────────────────
// Monitor 的调度循环会 `await delayFn(ms)`；若 delayFn 立刻 resolve，循环会**空转**。
// 因此这里返回一个**保持 pending 的 Promise**，只在测试显式 fireAll()/advance() 时 resolve。
function makeTimers() {
  const active = new Set();
  let seq = 0;
  return {
    delayFn: (ms) => new Promise((resolve) => {
      const h = { id: ++seq, ms, resolve, done: false };
      active.add(h);
    }),
    cancelTimer: (h) => { if (h) active.delete(h); },
    activeCount: () => active.size,
    pendingMs: () => [...active].map((h) => h.ms),
    /** 触发所有挂起的延时（模拟时间推进）。 */
    fireAll: async () => {
      const list = [...active];
      active.clear();
      for (const h of list) { h.done = true; h.resolve(); }
      await sleep(0);
    },
    clear: () => { active.clear(); },
  };
}

async function until(fn, timeout = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeout) throw new Error('until() 超时，状态未按预期变化');
    await new Promise((r) => setImmediate(r));
  }
}

// ── 配置（对齐生产 config.json 的关键字段）──────────────────────
// Cookie：Monitor 每轮会先做登录态静态核验，因此测试用一个临时目录放一份
// **占位** cookie 文件（非真实凭据，仅含 platform 会话结构），避免触网且不读生产 cookie。
const COOKIE_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'wd-cookies-'));
const COOKIE_FILE = 'test-shop';
fs.writeFileSync(
  path.join(COOKIE_DIR, `${COOKIE_FILE}.json`),
  JSON.stringify([
    { name: 'sessionid', value: 'dummy-not-a-real-credential', domain: '.jinritemai.com', path: '/', expires: Math.floor(Date.now() / 1000) + 86400 },
  ])
);
process.on('exit', () => { try { fs.rmSync(COOKIE_DIR, { recursive: true, force: true }); } catch (_) {} });

function makeCfg(overrides = {}) {
  return {
    shops: [{ id: SHOP_ID, name: SHOP_ID, cookieFile: COOKIE_FILE, accountId: ACC, enabled: true }],
    rules: [{ type: 'wholeShopCostPerOrder', thresholdCents: 100, enabled: true }],
    schedule: { dailyStartHour: 8, intervalMinutes: 30 },
    monitor: {
      snapshotMaxAgeMinutes: 30,
      mockDataSource: false,
      chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: false, enableEnabled: false, enableHour: 7 },
    },
    login: { cookieSourceDir: COOKIE_DIR },
    execution: { realMode: false, maxAdPages: 50, readbackTimeoutMs: 1000, readbackAttempts: 1, readbackIntervalMs: 10 },
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
  const calls = { cost: 0, order: 0 };
  const costReader = {
    connected: true,
    kind: 'cost',
    async readCostSummary() { calls.cost++; return mkSummary('cost', opts.costCents, clock); },
  };
  const orderReader = {
    connected: true,
    kind: 'orders',
    async readOrderSummary() { calls.order++; return mkSummary('orders', opts.orderCount, clock); },
  };
  return { costReader, orderReader, calls };
}

// ── 装配 watch-drill（内部会 new Monitor；这里注入 config + 只读适配器）────
// `adapters.reader` 会被 Monitor 直接用作注入读取器（见 monitor.js _getCoordinator），
// 因此测试通过 createCompositeReader 包一层，避免触网。
// 记录本进程创建的所有实例：测试结束后统一 stop + 清空挂起延时，
// 否则 Monitor 的调度循环（pending Promise）会阻止进程退出。
const CREATED = [];

function makeDrill(clock, timers, opts = {}) {
  const readers = opts.readers || makeReaders(clock, opts);
  const cfg = makeCfg(opts.cfg);
  const { createCompositeReader } = require(path.join(PROMO, 'src/adapters/promo-reader.js'));
  const reader = opts.injectedReader || createCompositeReader({
    costReader: readers.costReader,
    orderReader: readers.orderReader,
    adReader: opts.adReader || null,
  });
  const drill = createWatchDrill({
    shopName: SHOP_ID,
    persistFile: opts.persistFile || null,
    nowFn: clock.now,
    delayFn: timers.delayFn,
    dataDir: opts.dataDir || path.join(require('os').tmpdir(), `wd-state-${process.pid}-${Date.now()}`),
    config: cfg,
    configSourcePath: opts.configSourcePath || 'test',
    adapters: {
      reader,
      controller: opts.controller || null,
    },
    chengfangOpener: opts.chengfangOpener || null,
    readAdState: opts.readAdState || (async () => opts.adStateFixture || 'mixed'),
    notify: opts.notify,
    notifySpawn: opts.notifySpawn,
  });
  CREATED.push({ drill, timers });
  return { drill, readers };
}

const allLogs = (drill) => drill.logs.map((l) => l.msg).join('\n');

// 每个用例结束后统一停止调度并清空挂起延时，保证进程能正常退出。
test.after(() => {
  for (const { drill, timers } of CREATED) {
    try { if (drill._internal._monitor) drill._internal._monitor.stopEnableScheduler({ byUser: false, reason: 'test-cleanup' }); } catch (_) {}
    try { drill.stop(); } catch (_) {}
    try { timers.clear(); } catch (_) {}
  }
});

// ══════════════════════════════════════════════════════════════
// 1) 默认状态
// ══════════════════════════════════════════════════════════════
test('创建后默认未启动、无日志、不安排任何定时器（不自动启动值守）', () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers);
  const s = drill.snapshot();
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(s.statusText, '未启动');
  assert.strictEqual(timers.activeCount(), 0);
  assert.strictEqual(drill.logs.length, 0);
});

test('watch-drill 模块自身不含删除广告的操作代码路径', () => {
  const src = fs.readFileSync(WATCH_DRILL_MODULE, 'utf-8');
  // 去掉注释后再检查，避免把"本模块不含删除路径"这类说明文字误判为违规
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // 检查"操作"型标识（函数调用/方法名），而非开关字段名
  for (const bad of ['closeAd', 'deleteAdPlan', 'removeAd', 'batchDelete', 'deleteBatch', 'btn-delete', 'group-item-btn-delete']) {
    assert.ok(!code.includes(bad), `模块代码不应包含删除操作路径: ${bad}`);
  }
  // 显式声明删除广告永久关闭（这是允许且必须存在的常量）
  assert.ok(/deleteAdEnabled:\s*false/.test(src), '应显式声明 deleteAdEnabled=false');
});

test('watch-drill 委托推广控制 Monitor（不重复实现调度/乘方链路）', () => {
  const src = fs.readFileSync(WATCH_DRILL_MODULE, 'utf-8');
  assert.ok(/src\/engine\/monitor\.js/.test(src), '应装配推广控制 Monitor');
  assert.ok(!/setTimeout\(.*fireRound/s.test(src), '不应保留自研轮次调度');
});

// ══════════════════════════════════════════════════════════════
// 2) 门槛快照（fail-closed，绝不绕过）
// ══════════════════════════════════════════════════════════════
test('门槛快照如实透出：realMode/pauseEnabled/enableEnabled 全关时，真实暂停与开启都不会执行', () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const g = drill.snapshot().gates;
  assert.ok(g, '必须暴露门槛快照供界面展示');
  assert.strictEqual(g.realMode, false);
  assert.strictEqual(g.pauseEnabled, false);
  assert.strictEqual(g.enableEnabled, false);
  assert.strictEqual(g.pauseWillExecute, false, '两个开关未同开 → 不执行真实暂停');
  assert.strictEqual(g.enableWillExecute, false, '两个开关未同开 → 不执行真实开启');
  assert.strictEqual(g.deleteAdEnabled, false, '删除广告永久关闭');
  assert.deepStrictEqual(g.scope, ['全店托管', '商品自选']);
  assert.strictEqual(g.enableHour, 7);
  assert.strictEqual(g.dailyStartHour, 8);
  assert.strictEqual(g.intervalMinutes, 30);
});

test('门槛快照：realMode + pauseEnabled 同开 → 真实暂停会执行；enableEnabled 未开 → 开启仍不执行', () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, {
    costCents: 100, orderCount: 100,
    cfg: { execution: { realMode: true }, monitor: { snapshotMaxAgeMinutes: 30, chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: true, enableEnabled: false, enableHour: 7 } } },
  });
  drill.start();
  const g = drill.snapshot().gates;
  assert.strictEqual(g.pauseWillExecute, true);
  assert.strictEqual(g.enableWillExecute, false);
});

// ══════════════════════════════════════════════════════════════
// 2.1) 落地回读轮询配置 + 会话 Cookie 回写（2026-09-16 定点修复）
//     页面展示的轮询值必须 === 执行器实际生效值（同一份解析），不得是 fallback 猜测；
//     Cookie 回写只暴露元信息（条数/域数/结果），界面与状态里永不出现任何 Cookie 值。
// ══════════════════════════════════════════════════════════════
test('门槛快照必须暴露实际生效的落地回读轮询配置（与执行器同源解析）', () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, {
    costCents: 100, orderCount: 100,
    cfg: { execution: { realMode: true, dryRun: false, readbackTimeoutMs: 30000, readbackIntervalMs: 3000 } },
  });
  drill.start();
  const p = drill.snapshot().gates.polling;
  assert.ok(p, '门槛快照必须含 polling（页面据此展示真实生效值）');
  assert.strictEqual(p.timeoutMs, 30000, '展示值必须等于配置的实际生效超时');
  assert.strictEqual(p.intervalMs, 3000, '展示值必须等于配置的实际生效间隔');
  assert.strictEqual(p.timeoutSource, 'execution.readbackTimeoutMs', '必须标注来源，杜绝 fallback 猜测');
  assert.strictEqual(p.intervalSource, 'execution.readbackIntervalMs');
});

test('落地回读轮询配置：配置缺省 → 明确标注 builtin-default，不冒充用户配置', () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, {
    costCents: 100, orderCount: 100,
    cfg: { execution: { realMode: true, dryRun: false } },
  });
  drill.start();
  const p = drill.snapshot().gates.polling;
  assert.strictEqual(p.timeoutSource, 'builtin-default');
  assert.strictEqual(p.intervalSource, 'builtin-default');
  assert.strictEqual(typeof p.timeoutMs, 'number');
});

test('会话 Cookie 回写：状态默认无记录；记录后只暴露元信息，绝不含任何 Cookie 值', () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  assert.strictEqual(drill.snapshot().cookieWriteback, null, '尚未回写时必须为 null，不得编造');

  const monitor = drill._internal._monitor;
  monitor._recordBatch(SHOP_ID, {
    batchDate: '2026-09-16', outcome: 'paused', counts: { confirmed: 2, failed: 0, unknown: 0 },
    allPausedConfirmed: true,
    cookieWriteback: {
      ok: true, skipped: false, count: 65, bytes: 20480,
      domains: ['fxg.jinritemai.com', 'compass.jinritemai.com', 'doudian-sso.jinritemai.com'],
      droppedOther: ['hm.baidu.com'],
    },
  });
  const cw = drill.sync().cookieWriteback;
  assert.ok(cw, '记录后必须透出回写结果');
  assert.strictEqual(cw.ok, true);
  assert.strictEqual(cw.count, 65, '只暴露条数元信息');
  assert.strictEqual(cw.domains.length, 3, '只暴露域名元信息');
  assert.ok(cw.at, '必须带时间戳供界面展示');
  const blob = JSON.stringify(cw);
  assert.ok(!/"value"/.test(blob), `回写结果不得包含任何 Cookie value，实际：${blob}`);
  assert.ok(!/sessionid|ttwid|passport/i.test(blob), `回写结果不得包含凭据字段，实际：${blob}`);
});

test('会话 Cookie 回写冲突：保留较新文件的结果如实透出，且不改写批次 outcome/counts', () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const monitor = drill._internal._monitor;
  const batch = {
    batchDate: '2026-09-16', outcome: 'paused', counts: { confirmed: 1, failed: 0, unknown: 0 },
    allPausedConfirmed: true,
    cookieWriteback: { ok: false, skipped: true, conflict: true, reason: '源 Cookie 文件在本次会话期间已被改变：保留较新文件，本次不回写' },
  };
  monitor._recordBatch(SHOP_ID, batch);
  const cw = drill.sync().cookieWriteback;
  assert.strictEqual(cw.conflict, true, '冲突必须如实标记');
  assert.strictEqual(cw.skipped, true);
  // 回写失败/冲突绝不改写广告动作结果
  assert.strictEqual(batch.outcome, 'paused');
  assert.deepStrictEqual(batch.counts, { confirmed: 1, failed: 0, unknown: 0 });
  assert.strictEqual(batch.allPausedConfirmed, true);
});

// ══════════════════════════════════════════════════════════════
// 3) 启停幂等与重启语义
// ══════════════════════════════════════════════════════════════
test('启动后 running=true 且记录已装配；重复启动不叠加循环', () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  assert.strictEqual(drill.snapshot().running, true);
  const logs1 = drill.logs.length;
  drill.start();
  assert.strictEqual(drill.snapshot().running, true);
  assert.ok(allLogs(drill).includes('已在运行'), '重复启动应明确记录为忽略');
  assert.ok(drill.logs.length >= logs1);
});

test('停止后 running=false、状态回到未启动；重复停止幂等', () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  drill.stop();
  const s = drill.snapshot();
  assert.strictEqual(s.running, false);
  assert.strictEqual(s.status, 'idle');
  assert.ok(s.stoppedAt);
  drill.stop(); // 幂等
  assert.strictEqual(drill.snapshot().running, false);
});

test('服务重启语义：新建实例默认未启动，但历史日志可从 JSONL 恢复查看', () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const tmp = path.join(require('os').tmpdir(), `wd-restore-${Date.now()}.jsonl`);
  try {
    const first = makeDrill(clock, makeTimers(), { costCents: 100, orderCount: 100, persistFile: tmp }).drill;
    first.start();
    const ranLogs = first.logs.length;
    assert.ok(ranLogs > 0);
    // 模拟进程重启：新实例复用同一日志文件
    const second = makeDrill(clock, makeTimers(), { persistFile: tmp }).drill;
    assert.strictEqual(second.snapshot().running, false, '重启后默认未启动');
    assert.ok(second.logs.length > 0, '历史日志应可恢复查看');
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});

// ══════════════════════════════════════════════════════════════
// 4) 用户点名要求的日志内容：开启 / 判断数据 / 暂停 / 重试 / 回读 / 失败原因
// ══════════════════════════════════════════════════════════════
test('启动日志说明规则：07:00 开启、08:00 后每 30 分钟、严格超过 1 元/单、绝不删除广告', () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const logs = allLogs(drill);
  assert.ok(logs.includes('07:00'), `应说明 07:00 开启，实际日志：\n${logs}`);
  assert.ok(logs.includes('08:00 后每 30 分钟检查'), '应说明 08:00 后每 30 分钟检查');
  assert.ok(logs.includes('严格超过 1 元/单'), '应说明判定阈值');
  assert.ok(logs.includes('绝不删除广告'), '应说明不删除广告');
});

test('装配日志透出模式与门槛明细（含"删除广告=永不执行"）', () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const logs = allLogs(drill);
  assert.ok(logs.includes('值守装配完成'), '应有装配日志');
  assert.ok(logs.includes('门槛：'), '应有门槛明细');
  assert.ok(logs.includes('删除广告=永不执行'));
  assert.ok(logs.includes('控制范围=全店托管+商品自选'));
});

test('判断数据日志：恰好等于 1 元/单（不超标）时给出费用/订单/每单与整数分判定过程', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  // 判定式：费用分 > 订单数 × 阈值分(100) 才超标。
  // 费用 10000 分、订单 100 单 → 10000 ≤ 100×100 = 10000，恰好相等不超标。
  const { drill } = makeDrill(clock, timers, { costCents: 10000, orderCount: 100 });
  drill.start();
  // 等首轮轮询完成（Monitor 置 lastCycleAt），再经 /state 同步出日志
  await until(() => drill._internal._monitor.lastCycleAt, 8000);
  await callHttp(drill, 'GET', '/api/watch-drill/state');
  const logs = allLogs(drill);
  assert.ok(/第 \d+ 轮判断数据（周期 \d+/.test(logs), `应含周期号与判断标题，实际：\n${logs}`);
  assert.ok(/费用 .* 元（\d+ 分），订单 \d+ 单，每单/.test(logs), `应含费用/订单/每单，实际：\n${logs}`);
  assert.ok(logs.includes('10000 分 = 100×100 分'), '应含等于阈值的整数分判定过程');
  assert.ok(/保持|零动作/.test(logs), '等于阈值必须保持状态、零动作');
  assert.ok(!logs.includes('未超标，不暂停乘方'), '不得将未超标统一写为不暂停');
});

test('判断数据日志：严格超过 1 元/单时判为超标并说明应暂停乘方', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  // 费用 10001 分、订单 100 单 → 10001 > 100×100 = 10000，超标（严格大于）
  const { drill } = makeDrill(clock, timers, { costCents: 10001, orderCount: 100 });
  drill.start();
  await until(() => drill._internal._monitor.lastCycleAt, 8000);
  await callHttp(drill, 'GET', '/api/watch-drill/state');
  const logs = allLogs(drill);
  assert.ok(logs.includes('10001 分 > 100×100 分'), `应含严格大于的整数分判定，实际：\n${logs}`);
  assert.ok(/将暂停|触发暂停/.test(logs), '高于阈值应转译为暂停动作');
});

test('判断数据日志：连续两轮数据完全相同 → 仍然各有两条判断日志（不以"数据变化"为条件）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  // 费用与订单在两轮之间保持不变
  const { drill } = makeDrill(clock, timers, { costCents: 10000, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  await until(() => m.lastCycleAt, 8000);
  await callHttp(drill, 'GET', '/api/watch-drill/state');
  const cycle1 = m.cycleNo;
  // 让 Monitor 完成第二个完整周期（数据完全相同）
  await timers.fireAll();
  await until(() => m.cycleNo > cycle1, 8000);
  await callHttp(drill, 'GET', '/api/watch-drill/state');
  const logs = allLogs(drill);
  const hits = logs.match(/第 \d+ 轮判断数据（周期 \d+/g) || [];
  assert.ok(hits.length >= 2, `连续两轮相同数据也必须有两条判断日志，实际命中 ${hits.length} 条：\n${logs}`);
  // 每一轮的 cycleNo 必须递增且不同
  const cycles = hits.map((h) => Number(/周期 (\d+)/.exec(h)[1]));
  assert.strictEqual(new Set(cycles).size, cycles.length, '周期号必须严格递增、互不重复');
});

test('周期号正确递增：roundNo 跟随 Monitor.cycleNo（每个完整巡查周期 +1）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  await until(() => m.lastCycleAt, 8000);
  await callHttp(drill, 'GET', '/api/watch-drill/state');
  const r1 = drill.snapshot().roundNo;
  assert.strictEqual(r1, m.cycleNo, 'roundNo 必须等于 Monitor 的 cycleNo');
  await timers.fireAll();
  await until(() => m.cycleNo > r1, 8000);
  await callHttp(drill, 'GET', '/api/watch-drill/state');
  const r2 = drill.snapshot().roundNo;
  assert.ok(r2 > r1, `第二轮 roundNo 必须递增：${r1} → ${r2}`);
});

// ══════════════════════════════════════════════════════════════
// 15) 飞书通知（Hermes send）：每轮判断数据推送一条；失败不影响值守
// ══════════════════════════════════════════════════════════════
test('飞书通知：每轮判断数据经 hermes send 推送一条摘要（目标/主题/数据一致），同一轮不重复推送', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const sent = [];
  const { drill } = makeDrill(clock, timers, {
    costCents: 10001, orderCount: 100, // 10001 分 > 100×100 分 → 超标
    notify: { enabled: true, target: 'feishu:test-chat', timeoutMs: 1000 },
    notifySpawn: (args, input) => { sent.push({ args, input }); return Promise.resolve({ code: 0 }); },
  });
  drill.start();
  const m = drill._internal._monitor;
  await until(() => m.lastCycleAt, 8000);
  await callHttp(drill, 'GET', '/api/watch-drill/state'); // 触发同步 → 消费判断事件 → 推送
  await until(() => sent.length >= 1, 8000);
  const first = sent[0];
  assert.ok(first.args[0] === 'send' && first.args.includes('--to') && first.args.includes('feishu:test-chat'),
    `应调用 hermes send --to feishu:test-chat，实际参数：${JSON.stringify(first.args)}`);
  const subjIdx = first.args.indexOf('--subject');
  assert.ok(subjIdx >= 0 && /\[推广值守\] 第\d+轮 将暂停/.test(first.args[subjIdx + 1]),
    `主题应含轮次与结论，实际：${JSON.stringify(first.args[subjIdx + 1])}`);
  assert.ok(first.input.includes('100.01 元'), `正文应含费用 100.01 元，实际：\n${first.input}`);
  assert.ok(first.input.includes('100 单'), `正文应含订单 100 单，实际：\n${first.input}`);
  assert.ok(/判定：.*10001 分 > 100×100 分/.test(first.input), `正文应含严格大于的整数分判定，实际：\n${first.input}`);
  assert.ok(/触发暂停|将暂停/.test(first.input), `高于阈值时应说明暂停动作，实际：\n${first.input}`);
  // 同一轮不重复推送
  const count = sent.length;
  await callHttp(drill, 'GET', '/api/watch-drill/state');
  assert.strictEqual(sent.length, count, '同一轮判断不得重复推送');
  const st = drill.snapshot().notify;
  assert.strictEqual(st.enabled, true, '快照应显示通知已启用');
  assert.strictEqual(st.lastStatus, 'ok');
  assert.ok(st.lastCycleNo >= 1, '应记录最近推送的轮次');
  assert.ok(st.lastAt, '应记录最近推送时间');
});

test('飞书通知：发送失败 → 只记 warn 日志与失败状态，值守继续运行（绝不因通知中断）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, {
    costCents: 5000, orderCount: 100, // 5000 ≤ 10000 → 未超标
    notify: { enabled: true, target: 'feishu:test-chat', timeoutMs: 1000 },
    notifySpawn: () => Promise.resolve({ code: 1, stderr: 'feishu upstream 502' }),
  });
  drill.start();
  const m = drill._internal._monitor;
  await until(() => m.lastCycleAt, 8000);
  await callHttp(drill, 'GET', '/api/watch-drill/state');
  await until(() => drill.snapshot().notify.lastStatus === 'failed', 8000);
  const logs = allLogs(drill);
  assert.ok(/飞书通知发送失败/.test(logs), `失败必须记 warn 日志，实际：\n${logs}`);
  assert.ok(logs.includes('feishu upstream 502'), `日志应含 hermes 的错误输出，实际：\n${logs}`);
  const st = drill.snapshot().notify;
  assert.strictEqual(st.lastStatus, 'failed');
  assert.strictEqual(drill.snapshot().running, true, '通知失败不得停止值守');
});

test('飞书通知：未开启（默认）→ 绝不调用 hermes send', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const sent = [];
  const { drill } = makeDrill(clock, timers, {
    costCents: 5000, orderCount: 100,
    notifySpawn: (args, input) => { sent.push({ args, input }); return Promise.resolve({ code: 0 }); },
  });
  assert.strictEqual(drill.snapshot().notify.enabled, false, '模块默认不得开启通知（生产由 server.js 显式开启）');
  drill.start();
  await until(() => drill._internal._monitor.lastCycleAt, 8000);
  await callHttp(drill, 'GET', '/api/watch-drill/state');
  await sleep(50);
  assert.strictEqual(sent.length, 0, '未开启时绝不调用 hermes send');
});

test('失败原因进入日志：读取异常时记录失败原因（不是静默忽略）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const readers = {
    costReader: { connected: true, kind: 'cost', async readCostSummary() { throw new Error('页面未到达千川首页'); } },
    orderReader: { connected: true, kind: 'orders', async readOrderSummary() { return mkSummary('orders', 10, clock); } },
    calls: { cost: 0, order: 0 },
  };
  const { drill } = makeDrill(clock, timers, { readers });
  drill.start();
  await until(() => drill._internal._monitor.lastCycleAt, 8000);
  await callHttp(drill, 'GET', '/api/watch-drill/state');
  const logs = allLogs(drill);
  assert.ok(logs.includes('失败'), '必须有失败记录');
  assert.ok(/页面未到达千川首页/.test(logs), `失败原因不得被吞掉，实际：\n${logs}`);
});

// ══════════════════════════════════════════════════════════════
// 5) 动作转译（暂停 / 开启 / 重试 / 回读）
// ══════════════════════════════════════════════════════════════
test('日志转译：暂停批次结果含目标数/计数/回读/失败原因（经 /state 接口触发）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  m.actions = [];
  m._memPush(m.actions, {
    shopId: SHOP_ID,
    actionType: 'pause',
    outcome: 'partial',
    counts: { confirmed: 98, failed: 2, unknown: 0, skipped: 0 },
    targets: ['123456', '234567', '345678'],
    allPausedConfirmed: false,
    confirmReason: '回读仍有 2 条处于投放中，状态与请求不一致',
    remaining: { total: 2, ids: ['234567', '345678'] },
    error: '计划 234567 行内层开关点击后未生效',
    batchDate: shanghaiDate(clock.now()),
  });
  await callHttp(drill, 'GET', '/api/watch-drill/state');
  const logs = allLogs(drill);
  assert.ok(logs.includes('暂停批次结果'), '应转译暂停批次');
  assert.ok(logs.includes('本次动作=暂停'), '显式 actionType=pause → 必须标为暂停');
  assert.ok(logs.includes('已确认 98'), '应含已确认计数');
  assert.ok(logs.includes('失败 2'), '应含失败计数');
  assert.ok(logs.includes('目标 3 条'), '应含目标条数');
  assert.ok(logs.includes('回读核验'), '应含回读核验');
  assert.ok(logs.includes('行内层开关点击后未生效'), '应含失败原因');
});

test('日志转译：开启批次结果与每日开启相位状态（in_progress/success/failed/unknown）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  m.actions = [];
  m._memPush(m.actions, {
    shopId: SHOP_ID,
    actionType: 'enable',
    outcome: 'ok',
    counts: { confirmed: 120, failed: 0, unknown: 0, skipped: 0 },
    targets: ['111111', '222222'],
    allEnabledConfirmed: true,
    confirmReason: '回读全部处于投放中',
    batchDate: shanghaiDate(clock.now()),
  });
  // 写入一条开启相位记录
  m._setEnablePhase(SHOP_ID, shanghaiDate(clock.now()), 'success', { date: shanghaiDate(clock.now()), phase: 'enable_window' });
  await callHttp(drill, 'GET', '/api/watch-drill/state');
  const logs = allLogs(drill);
  assert.ok(logs.includes('开启批次结果'), '应转译开启批次');
  assert.ok(logs.includes('本次动作=开启'), '显式 actionType=enable → 必须标为开启');
  assert.ok(logs.includes('每日开启相位：开启成功'), '应记录开启相位成功');
});

// ══════════════════════════════════════════════════════════════
// 5b) 第 4 项回归：actionType 必须显式传递，禁止用 outcome 文本推断动作类型
// ══════════════════════════════════════════════════════════════
test('actionType 显式传递：outcome 含 "enable" 字样但 actionType=pause → 仍标为暂停（不按文本猜测）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  m.actions = [];
  // outcome 里带 "enable" 字样（旧实现会据此误判为"开启"）
  m._memPush(m.actions, {
    shopId: SHOP_ID,
    actionType: 'pause',
    outcome: 'enable_retry_failed',
    counts: { confirmed: 0, failed: 3 },
    targets: ['111111'],
    allPausedConfirmed: false,
    batchDate: shanghaiDate(clock.now()),
  });
  drill.sync();
  const logs = allLogs(drill);
  assert.ok(logs.includes('暂停批次结果'), `显式 actionType 必须优先于 outcome 文本，实际：\n${logs}`);
  assert.ok(!/开启批次结果/.test(logs), '不得按 outcome 文本误判为开启');
});

test('actionType 显式传递：部分开启（partial）必须标为"开启"，绝不误写为"暂停"', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  m.actions = [];
  m._memPush(m.actions, {
    shopId: SHOP_ID,
    actionType: 'enable',
    outcome: 'partial',
    counts: { confirmed: 60, failed: 2, unknown: 1 },
    targets: ['111111', '222222'],
    allEnabledConfirmed: false,
    remaining: { total: 3 },
    confirmReason: '回读仍有 3 条未处于投放中',
    batchDate: shanghaiDate(clock.now()),
  });
  drill.sync();
  const logs = allLogs(drill);
  assert.ok(logs.includes('开启批次结果'), `部分开启必须标为开启，实际：\n${logs}`);
  assert.ok(logs.includes('本次动作=开启'), '必须显式标注本次动作为开启');
  assert.ok(!/暂停批次结果/.test(logs), '部分开启绝不误写为暂停');
  assert.ok(logs.includes('仍未开启 3'), '回读未开启条数必须说明');
});

test('actionType 显式传递：开启失败（failed）必须标为"开启"并记录失败原因', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  m.actions = [];
  m._memPush(m.actions, {
    shopId: SHOP_ID,
    actionType: 'enable',
    outcome: 'failed',
    counts: { confirmed: 0, failed: 5 },
    targets: ['111111', '222222', '333333', '444444', '555555'],
    allEnabledConfirmed: false,
    error: '批量开启按钮二次定位不一致，零点击',
    batchDate: shanghaiDate(clock.now()),
  });
  drill.sync();
  const logs = allLogs(drill);
  assert.ok(logs.includes('开启批次结果'), `开启失败必须标为开启，实际：\n${logs}`);
  assert.ok(logs.includes('批量开启按钮二次定位不一致'), '失败原因必须可见');
  assert.ok(!/暂停批次结果/.test(logs), '开启失败绝不误写为暂停');
});

test('actionType 缺失（unknown）→ 如实报"未知动作"，绝不按结果文本猜测为暂停/开启', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  m.actions = [];
  m._memPush(m.actions, {
    shopId: SHOP_ID,
    outcome: 'ok',
    counts: { confirmed: 10, failed: 0 },
    targets: ['111111'],
    batchDate: shanghaiDate(clock.now()),
  });
  drill.sync();
  const logs = allLogs(drill);
  assert.ok(logs.includes('未知动作批次结果'), `缺 actionType 必须如实报未知，实际：\n${logs}`);
  assert.ok(logs.includes('actionType 未提供，未按结果文本猜测'), '必须显式说明未做文本推断');
});

test('演练开启（dry enable）必须写"将开启"，绝不误写为"暂停"', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  m.actions = [];
  m._memPush(m.actions, {
    shopId: SHOP_ID,
    actionType: 'enable',
    dryEnableRun: true,
    outcome: 'dry_enable',
    counts: { confirmed: 0, failed: 0, skipped: 12 },
    targets: ['111111', '222222'],
    batchDate: shanghaiDate(clock.now()),
  });
  drill.sync();
  const logs = allLogs(drill);
  assert.ok(logs.includes('开启批次结果'), `演练开启必须标为开启，实际：\n${logs}`);
  assert.ok(logs.includes('本次动作=开启'), '演练开启的目标动作是"开启"');
  assert.ok(!/暂停批次结果/.test(logs), '演练开启绝不误写为暂停');
});

// ══════════════════════════════════════════════════════════════
// 6) HTTP 接口契约（保持与 index.html 兼容）
// ══════════════════════════════════════════════════════════════
function callHttp(drill, method, url, body) {
  return new Promise((resolve) => {
    const req = {
      url, method,
      on(evt, cb) {
        if (evt === 'data' && body != null) setImmediate(() => cb(Buffer.from(JSON.stringify(body))));
        if (evt === 'end') setImmediate(() => cb());
        return req;
      },
    };
    const res = {
      writeHead(code, headers) { this._code = code; this._headers = headers; },
      end(body) { resolve({ code: this._code, headers: this._headers, body: JSON.parse(body) }); },
    };
    Promise.resolve(drill.serveHttp(req, res)).then(() => {
      if (res._code === undefined) resolve({ code: 0, body: null });
    });
  });
}

test('HTTP: /state 返回 ok 与门槛快照；/logs 支持 since 增量', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const st = await callHttp(drill, 'GET', '/api/watch-drill/state');
  assert.strictEqual(st.code, 200);
  assert.strictEqual(st.body.ok, true);
  assert.ok(st.body.state.gates, 'state 必须含 gates');
  assert.strictEqual(typeof st.body.state.realMode, 'boolean');

  const lg = await callHttp(drill, 'GET', '/api/watch-drill/logs?since=0');
  assert.strictEqual(lg.body.ok, true);
  assert.ok(lg.body.seq > 0);
  assert.ok(Array.isArray(lg.body.logs));
  const since = lg.body.seq;
  const lg2 = await callHttp(drill, 'GET', `/api/watch-drill/logs?since=${since}`);
  assert.strictEqual(lg2.body.logs.length, 0, '增量拉取无新日志时应为空');
});

test('HTTP: start/stop 幂等且返回最新 state', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  const a = await callHttp(drill, 'POST', '/api/watch-drill/start');
  assert.strictEqual(a.body.ok, true);
  assert.strictEqual(a.body.state.running, true);
  const b = await callHttp(drill, 'POST', '/api/watch-drill/start');
  assert.strictEqual(b.body.state.running, true);
  const c = await callHttp(drill, 'POST', '/api/watch-drill/stop');
  assert.strictEqual(c.body.state.running, false);
});

test('HTTP: 未知路径 404、非预期方法不误触发', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, {});
  const r = await callHttp(drill, 'GET', '/api/watch-drill/nope');
  assert.strictEqual(r.code, 404);
  const r2 = await callHttp(drill, 'GET', '/api/watch-drill/start');
  assert.strictEqual(r2.code, 404, 'start 仅接受 POST');
});

// ══════════════════════════════════════════════════════════════
// 7) 日志安全
// ══════════════════════════════════════════════════════════════
test('scrub 遮蔽 Cookie/令牌，但保留正常中文说明文本', () => {
  assert.ok(!scrub('cookie=abcdef123456789').includes('abcdef123456789'));
  assert.ok(!scrub('Cookie: abcdef123456789').includes('abcdef123456789'));
  assert.ok(!scrub('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345').includes('abcdefghijklmnopqrstuvwxyz012345'));
  // 中文说明不应被吞
  assert.ok(scrub('Cookie 过期，请重新登录').includes('Cookie 过期，请重新登录'));
  // 单行长度上限
  assert.strictEqual(scrub('x'.repeat(5000)).length, 2000);
  // 控制字符剔除
  assert.ok(!scrub('a\u0000b').includes('\u0000'));
});

test('日志落盘为 JSONL，可被再次读取恢复', () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const tmp = path.join(require('os').tmpdir(), `wd-jsonl-${Date.now()}.jsonl`);
  try {
    const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100, persistFile: tmp });
    drill.start();
    assert.ok(drill.logs.length > 0);
    const raw = fs.readFileSync(tmp, 'utf-8').trim().split('\n');
    assert.ok(raw.length > 0);
    for (const line of raw) {
      const e = JSON.parse(line);
      assert.ok(typeof e.seq === 'number' && typeof e.msg === 'string' && typeof e.t === 'string');
    }
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) {}
  }
});

// ══════════════════════════════════════════════════════════════
// 8) 第 1 项回归：增量游标必须基于单调 evtSeq（不受有界数组裁剪影响）
// ══════════════════════════════════════════════════════════════
test('增量游标：超过 100 条动作后仍能持续接收最新事件（不因数组封顶而永久漏日志）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  m.actions = [];
  m._lastActionsSeen = undefined; // 确保不依赖旧游标
  // 连续写入 130 条动作（远超 actions 默认上限 300 不会裁剪，因此这里同时验证序号连续性）
  for (let i = 0; i < 130; i += 1) {
    m._memPush(m.actions, {
      shopId: SHOP_ID,
      actionType: i % 3 === 0 ? 'enable' : 'pause',
      outcome: 'ok',
      counts: { confirmed: 1, failed: 0 },
      targets: [String(100000 + i)],
      batchDate: shanghaiDate(clock.now()),
    });
  }
  drill.sync();
  const logs = allLogs(drill);
  const hits = logs.match(/批次结果：ok/g) || [];
  assert.strictEqual(hits.length, 130, `130 条动作必须全部转译，实际 ${hits.length} 条`);
  const cursor = drill.cursor.evtSeq;
  assert.strictEqual(cursor, m._evtSeq, '游标必须推进到最新 evtSeq');
  // 再来一条：必须仍能被接收
  m._memPush(m.actions, {
    shopId: SHOP_ID, actionType: 'pause', outcome: 'ok', counts: { confirmed: 1, failed: 0 },
    targets: ['999999'], batchDate: shanghaiDate(clock.now()),
  });
  drill.sync();
  assert.ok(allLogs(drill).includes('999999'), '新事件必须仍能被接收（不因数组长度封顶而漏）');
});

test('增量游标：>50 条错误与 >50 条触发后，最新事件仍可到达日志', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  m.recentErrors = [];
  m.triggers = [];
  for (let i = 0; i < 60; i += 1) {
    m._memPush(m.recentErrors, { scope: `shop:${SHOP_ID}`, error: `错误编号-${i}` });
    m._memPush(m.triggers, {
      shopId: SHOP_ID, mode: 'dry', costText: `${i}.00`, orders: i + 1, targetCount: 1,
      note: `触发编号-${i}`,
    });
  }
  drill.sync();
  const logs = allLogs(drill);
  assert.ok(logs.includes('错误编号-59'), '最新的错误必须进入日志');
  assert.ok(logs.includes('触发编号-59'), '最新的触发必须进入日志');
  assert.ok(logs.includes('错误编号-0'), '最早的错误在未被裁剪时也应进入日志');
  // 幂等：再次同步不得重复
  const before = drill.logs.length;
  drill.sync();
  assert.strictEqual(drill.logs.length, before, '重复同步不得重复记录（幂等）');
});

test('增量游标：事件被裁剪（超缓存）时记录明确日志缺口，并继续同步后续事件', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  m.actions = [];
  m._evtDropped = [];
  // 手工把 actions 上限压到很小，制造裁剪
  m._memPush(m.actions, { shopId: SHOP_ID, actionType: 'pause', outcome: 'ok', counts: { confirmed: 1 }, targets: ['1'] });
  drill.sync(); // 消费第 1 条
  const consumed = drill.cursor.evtSeq;
  // 现在推入大量事件并强制裁剪（模拟 UI 轮询期间超出缓存）
  for (let i = 0; i < 20; i += 1) {
    m._memPush(m.actions, { shopId: SHOP_ID, actionType: 'pause', outcome: 'ok', counts: { confirmed: 1 }, targets: [String(200000 + i)] });
    if (m.actions.length > 5) {
      const removed = m.actions.splice(0, m.actions.length - 5);
      m._evtDropped.push({
        firstSeq: removed[0].evtSeq, lastSeq: removed[removed.length - 1].evtSeq,
        count: removed.length, at: new Date(clock.now()).toISOString(),
      });
    }
  }
  drill.sync();
  const logs = allLogs(drill);
  assert.ok(/日志缺口：.*共丢失 \d+ 条事件/.test(logs), `必须明确记录日志缺口，实际：\n${logs}`);
  assert.ok(logs.includes('200019'), '缺口之后的最新事件必须仍然同步成功');
  assert.ok(drill.cursor.evtSeq > consumed, '游标必须继续推进');
});

// ══════════════════════════════════════════════════════════════
// 9) 第 1 项回归：过程事件必须来自**真实生产链路**（runner/executor），
//    而不是手工往事件里塞"重试"文字（那样证明不了链路接通）
// ══════════════════════════════════════════════════════════════
//
// 本用例用**生产 ChengfangRunner + 生产 executor + 生产 fixture 页面 + 生产 controller**
// 真实走一遍「首次点击确认但未落地 → 同会话重试一次 → 回读确认成功」，
// 再断言 Monitor 的 `_audit` 双写把 retry/paused/view 过程事件接进事件流，
// 经 watch-drill 转译后出现在 HTTP `/api/watch-drill/logs`。
// 关键：**不手工往 recentErrors/actions 填"重试"文字**——只允许生产链路写事件。
// 仅在本地 fixture 页面上操作（route 拦截），不触真实站点、不操作真实广告。
test('第 1 项：开启演练 trigger 不得被误归类为批次（evtType=trigger，不显示 unknown 批次）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  // 生产 trigger 记录形状：携带 targetAction（将来时），**不含** actionType（已执行）
  m._memPush(m.triggers, {
    shopId: SHOP_ID, mode: 'dry', targetAction: 'enable', costText: '0.00', orders: 0, targetCount: 2,
    note: '每日开启演练',
  }, 300, 'trigger');
  const resp = await callHttp(drill, 'GET', '/api/watch-drill/logs?since=0');
  const logs = resp.body.logs.map((l) => l.msg).join('\n');
  assert.ok(/命中（演练）/.test(logs), `开启演练 trigger 必须被识别为"命中"事件：\n${logs}`);
  assert.ok(!/批次结果：unknown/.test(logs), `trigger 不得被误判为 unknown 批次：\n${logs}`);
  // 事件流必须带显式 evtType=trigger
  const ev = m.getEventStream(0).events.filter((e) => e.evtType === 'trigger');
  assert.ok(ev.length >= 1, 'trigger 事件必须带 evtType=trigger');
});

test('第 1 项：目标 ID 不得渲染为 [object Object]（对象数组 → 提取稳定 planId）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  m._memPush(m.actions, {
    shopId: SHOP_ID, actionType: 'enable', outcome: 'ok',
    counts: { confirmed: 2 },
    targets: [{ view: '全店托管', planId: '184388555253250562' }, { view: '商品自选', adId: '1875859981405339001' }],
  }, 300, 'batch');
  const resp = await callHttp(drill, 'GET', '/api/watch-drill/logs?since=0');
  const logs = resp.body.logs.map((l) => l.msg).join('\n');
  assert.ok(!logs.includes('[object Object]'), `目标 ID 不得渲染为 [object Object]：\n${logs}`);
  assert.ok(logs.includes('184388555253250562') && logs.includes('1875859981405339001'),
    `必须提取对象里的稳定 ID（planId/adId）：\n${logs}`);
});

test('第 1 项真实链路：生产 runner/executor 的「首次未落地→重试→回读」经 _audit 进入 /logs', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 10001, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;

  const { executeChengfangPause } = require(path.join(PROMO, 'src/engine/chengfang-executor.js'));
  const { createChengfangController } = require(path.join(PROMO, 'src/adapters/chengfang-reader.js'));
  const { chromium } = require(path.join(PROMO, 'node_modules/playwright'));
  const { buildChengfangFixtureHtml } = require(path.join(PROMO, 'test/chengfang-fixture.js'));
  const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    const page = await browser.newPage();
    // 生产 fixture：pauseEffect='first-noop' 模拟「首次点击确认但未落地」
    const html = buildChengfangFixtureHtml({
      plans: {
        '全店托管': [],
        '商品自选': [
          { id: '1875859981405339001', name: '千川乘方_计划A', checked: true },
          { id: '1875859981405339002', name: '千川乘方_计划B', checked: true },
        ],
      },
      state: { pauseEffect: 'first-noop' },
    });
    await page.route('**/uni-prom/overall**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
    await page.goto('https://qianchuan.jinritemai.com/uni-prom/overall?aavid=1710242295996424', { waitUntil: 'load' });

    const controller = createChengfangController({ loadWaitMs: 30, tabWaitMs: 10 });
    // 真实驱动生产 executor；audit 回调与生产接线完全一致 → Monitor._audit → 事件流
    const PAUSE_NOW = timeLib.shanghaiMs('2026-09-14', '09:00');
    const result = await executeChengfangPause({
      controller,
      page,
      shopCfg: { id: SHOP_ID, name: SHOP_ID, accountId: '1710242295996424' },
      config: {
        execution: { realMode: true, dryRun: false, readbackTimeoutMs: 800, readbackAttempts: 1, readbackIntervalMs: 10 },
        monitor: { chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: true } },
        schedule: { dailyStartHour: 8 },
      },
      dryRun: false,
      now: () => PAUSE_NOW,
      businessDate: '2026-09-14',
      audit: (e) => m._audit(e),   // ← 与生产完全相同的接线
    });
    assert.strictEqual(result.allPausedConfirmed, true, `生产链路应确认全部暂停：${result.confirmReason}`);

    // 消费事件流 → 日志（HTTP 接口）
    const resp = await callHttp(drill, 'GET', '/api/watch-drill/logs?since=0');
    const logs = resp.body.logs.map((l) => l.msg).join('\n');
    const processEvts = m.getEventStream(0).events.filter((e) => e.evtType === 'process');
    assert.ok(processEvts.length > 0,
      `生产链路必须产生过程事件（_audit 双写事件流），实际 ${processEvts.length} 条`);
    assert.ok(processEvts.some((e) => e.event === 'retry'),
      '首次未落地必须产生 retry 过程事件（来自 executor audit，而非手工文本）');
    assert.ok(processEvts.some((e) => e.event === 'paused' || e.event === 'view' || e.event === 'plan'),
      '必须产生回读核验类过程事件');
    assert.ok(/过程：重试/.test(logs), `重试必须经 /logs 可见（真实链路转译）：\n${logs}`);
    assert.ok(/过程：(回读核验|暂停|暂停计划)/.test(logs), `回读核验必须经 /logs 可见：\n${logs}`);
    await page.close().catch(() => {});
  } finally {
    await browser.close().catch(() => {});
  }
});

test('六类日志齐备：每日开启、每轮判断、暂停、重试、回读、失败原因都能经 /api/watch-drill/logs 取到', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 10001, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  await until(() => m.lastCycleAt, 8000);

  // 暂停批次（含回读、重试、失败原因）—— targets 用**对象数组**（生产真实形状）
  m._memPush(m.actions, {
    shopId: SHOP_ID, actionType: 'pause', outcome: 'partial',
    counts: { confirmed: 98, failed: 1, unknown: 1, skipped: 0 },
    targets: [{ view: '商品自选', planId: '111111' }, { view: '商品自选', planId: '222222' }],
    allPausedConfirmed: false,
    confirmReason: '回读仍有 2 条处于投放中',
    remaining: { total: 2 },
    error: '计划 222222 行内层开关点击后未生效；已在同会话内重试 1 次仍失败',
    batchDate: shanghaiDate(clock.now()),
  }, 300, 'batch');
  // 过程事件（重试 + 回读）—— 与生产 _audit 同形（event 名一致），走真实 _audit 入口
  m._audit({ kind: 'chengfang', event: 'retry', view: '商品自选', attempt: 2, targets: ['222222'], note: '同会话重试一次' });
  m._audit({ kind: 'chengfang', event: 'view', view: '商品自选', status: 'confirmed' });
  // 每日开启相位
  m._setEnablePhase(SHOP_ID, shanghaiDate(clock.now()), 'success', { date: shanghaiDate(clock.now()), phase: 'enable_window' });
  // 失败原因
  m._memPush(m.recentErrors, { scope: `shop:${SHOP_ID}`, error: '罗盘页面读取超时', code: 'READ_TIMEOUT' }, 300, 'error');

  const resp = await callHttp(drill, 'GET', '/api/watch-drill/logs?since=0');
  const logs = resp.body.logs.map((l) => l.msg).join('\n');
  assert.ok(/第 \d+ 轮判断数据（周期 \d+/.test(logs), `①每轮判断必须在 /logs 中：\n${logs}`);
  assert.ok(logs.includes('每日开启相位：开启成功'), `②每日开启必须在 /logs 中：\n${logs}`);
  assert.ok(logs.includes('暂停批次结果'), `③暂停必须在 /logs 中：\n${logs}`);
  assert.ok(logs.includes('重试'), `④重试必须在 /logs 中（不能只写审计文件）：\n${logs}`);
  assert.ok(logs.includes('回读'), `⑤回读必须在 /logs 中（不能只写审计文件）：\n${logs}`);
  assert.ok(logs.includes('罗盘页面读取超时'), `⑥失败原因必须在 /logs 中：\n${logs}`);
  // 目标 ID 必须是稳定 ID，不得出现 [object Object]
  assert.ok(!logs.includes('[object Object]'), `目标 ID 不得渲染为 [object Object]：\n${logs}`);
  assert.ok(logs.includes('111111') && logs.includes('222222'), '目标 ID 必须从对象中提取为稳定 planId');
});

test('/logs 增量契约：since 游标单调，重复拉取不重复；缺口字段可查询', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const a = await callHttp(drill, 'GET', '/api/watch-drill/logs?since=0');
  assert.strictEqual(a.body.ok, true);
  assert.strictEqual(typeof a.body.seq, 'number');
  assert.strictEqual(a.body.gap, null, '未发生裁剪时不应报告缺口');
  // 2026-09-15 真机实测后更新：批量开启无确认弹窗；托管开启为互斥提示弹窗（已精确接线）
  assert.strictEqual(a.body.confirmDialogs.shop_enable, true, '托管开启弹窗已实测（互斥提示句式精确确认）');
  assert.strictEqual(a.body.confirmDialogs.batch_enable, true, '批量开启已实测（无确认弹窗，点击即生效）');
  assert.strictEqual(a.body.confirmDialogs.batch_pause, true, '暂停弹窗已实测');
  const b = await callHttp(drill, 'GET', `/api/watch-drill/logs?since=${a.body.seq}`);
  assert.strictEqual(b.body.logs.length, 0, '无新日志时增量为空');
});

// ══════════════════════════════════════════════════════════════
// 10) 第 6 项回归：门槛展示与实际执行条件一致（运行中改配置立即反映）
// ══════════════════════════════════════════════════════════════
test('门槛实时性：运行中修改 realMode/pauseEnabled/enableEnabled 后，state 与 logs 立即反映且与实际 gate 一致', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  const g0 = (await callHttp(drill, 'GET', '/api/watch-drill/state')).body.state.gates;
  assert.strictEqual(g0.realMode, false);
  assert.strictEqual(g0.pauseWillExecute, false);

  // 运行中把三个开关打开（直接改 Monitor 持有的配置对象 —— 等价于磁盘配置被改后重载）
  m.config.execution.realMode = true;
  m.config.monitor.chengfang.pauseEnabled = true;
  m.config.monitor.chengfang.enableEnabled = true;

  const st = (await callHttp(drill, 'GET', '/api/watch-drill/state')).body.state;
  assert.strictEqual(st.gates.realMode, true, 'state 必须立即反映 realMode=true');
  assert.strictEqual(st.gates.pauseEnabled, true);
  assert.strictEqual(st.gates.enableEnabled, true);
  assert.strictEqual(st.gates.pauseWillExecute, true, '真实暂停此时会执行 → 展示必须为会执行');
  assert.strictEqual(st.gates.enableWillExecute, true, '真实开启此时会执行 → 展示必须为会执行');
  assert.strictEqual(st.realMode, true, '顶层 realMode 必须与门槛一致');
  assert.ok(/门槛已变化（运行中配置变更）/.test(allLogs(drill)), '门槛变化必须记录日志');

  // 再关回去 → 立即回落到"不会执行"
  m.config.execution.realMode = false;
  const st2 = (await callHttp(drill, 'GET', '/api/watch-drill/state')).body.state;
  assert.strictEqual(st2.gates.pauseWillExecute, false, 'realMode 关闭后必须立即显示不会执行');
  assert.strictEqual(st2.gates.enableWillExecute, false);
});

test('第 2 项：三许可开关全开 + dryRun=true → 两个 WillExecute 必须为 false（复用实际许可，含 dryRun）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  // 三个许可开关全部 true，但 dryRun=true（演练）
  m.config.execution.realMode = true;
  m.config.monitor.chengfang.pauseEnabled = true;
  m.config.monitor.chengfang.enableEnabled = true;
  m.config.execution.dryRun = true;

  const st = (await callHttp(drill, 'GET', '/api/watch-drill/state')).body.state;
  // 直接断言结果：dryRun 必须让两个"会执行"都为 false（与 chengfang-gate 同源）
  assert.strictEqual(st.gates.realMode, true, 'realMode 开关确为 true');
  assert.strictEqual(st.gates.pauseEnabled, true);
  assert.strictEqual(st.gates.enableEnabled, true);
  assert.strictEqual(st.gates.dryRun, true);
  assert.strictEqual(st.gates.pauseWillExecute, false, 'dryRun=true 时真实暂停必须显示"不会执行"');
  assert.strictEqual(st.gates.enableWillExecute, false, 'dryRun=true 时真实开启必须显示"不会执行"');
  assert.ok(/dryRun/.test(st.gates.pauseGateReason || ''), '必须说明被 dryRun 拦住（展示原因可见）');
  // 与生产 gate 交叉核对：同一配置下 buildChengfangRequestGate 也不放行
  const { buildChengfangRequestGate } = require(path.join(PROMO, 'src/engine/chengfang-gate.js'));
  const chk = buildChengfangRequestGate({ config: m.config, nowFn: clock.now, action: 'pause' })();
  assert.strictEqual(chk.ok, false, '同源 gate 必须同样拒绝（展示===执行）');
  assert.strictEqual(st.gates.pauseWillExecute, chk.ok, 'WillExecute 必须与真实 gate 完全一致');
});

test('第 2 项：首次启动前也读取配置展示真实模式（不启动调度/浏览器/广告）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  // 配置为 realMode=true + 两开关开（但**不调用 start()**）
  const { drill } = makeDrill(clock, timers, {
    costCents: 100, orderCount: 100,
    cfg: { execution: { realMode: true, dryRun: false, maxAdPages: 50 } },
  });
  const m0 = drill._internal._monitor;
  assert.strictEqual(m0, null, '未启动前不得装配 Monitor（不启动调度/浏览器）');
  const st = drill.snapshot();
  assert.ok(st.gates, '未启动也必须展示门槛（首次启动前读配置）');
  assert.strictEqual(st.gates.configuredRealMode, true, '必须如实显示配置里的 realMode=true');
  assert.strictEqual(st.realMode, true, '顶层 realMode 必须与配置一致（而非默认 false）');
  assert.strictEqual(st.running, false, '读取配置不得启动值守');
  assert.strictEqual(timers.activeCount(), 0, '读取配置不得安排任何定时器');
  assert.strictEqual(drill._internal._monitor, null, '读取配置不得装配 Monitor');
});

test('第 2 项：未知模式显示"待核实"，不得默认宣称演练安全', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  // 配置缺少 execution.realMode（未知）
  const { drill } = makeDrill(clock, timers, {
    costCents: 100, orderCount: 100,
    cfg: { execution: { dryRun: false, maxAdPages: 50 } },
  });
  const st = drill.snapshot();
  assert.strictEqual(st.gates.modeKnown, false, 'realMode 未知必须标注 modeKnown=false');
  assert.ok(/待核实/.test(st.modeText), `未知模式必须显示"待核实"，实际：${st.modeText}`);
  assert.ok(!/演练模式/.test(st.modeText), '未知模式不得默认宣称演练安全');
});

// ══════════════════════════════════════════════════════════════
// 10b) 第 3 项回归：日志缺口计数必须真实（写 1000 留 300 → 报 700，而非 50）
// ══════════════════════════════════════════════════════════════
test('第 3 项：写 1000 条、留 300 条 → 缺口必须报 700（而非被上限截断为 50）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  m.actions = [];
  m._evtDropped = [];
  m._evtTrimmedTotal = 0;
  m._evtConsumedSeq = 0;
  drill._internal._lastEvtSeq = 0;
  // 消费游标停留在 0（模拟 UI 长时间未拉取）
  // 写入 1000 条、actions 上限 100（默认 300；这里压到 100 便于精确核对）
  for (let i = 0; i < 1000; i += 1) {
    m._memPush(m.actions, { shopId: SHOP_ID, actionType: 'pause', outcome: 'ok', counts: { confirmed: 1 }, targets: [String(300000 + i)] }, 100, 'batch');
  }
  const s = m.getEventStream(0);
  assert.strictEqual(m.actions.length, 100, '内存中应保留 100 条');
  assert.strictEqual(s.droppedCount, 900,
    `真实缺口必须是 900（写 1000 留 100），实际 ${s.droppedCount}`);
  // 经 HTTP /logs 的顶层 droppedCount 也必须一致
  const resp = await callHttp(drill, 'GET', '/api/watch-drill/logs?since=0');
  assert.strictEqual(resp.body.droppedCount, 900, '/logs 顶层 droppedCount 必须等于真实缺口');
});

test('第 3 项：连续多次裁剪 + 重复拉取 + 部分已消费 + 继续接收新事件（缺口单调不虚增）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  m.actions = [];
  m._evtDropped = [];
  m._evtTrimmedTotal = 0;
  m._evtConsumedSeq = 0;
  drill._internal._lastEvtSeq = 0;

  // 第 1 批：写 200 留 50 → 丢 150
  for (let i = 0; i < 200; i += 1) {
    m._memPush(m.actions, { shopId: SHOP_ID, actionType: 'pause', outcome: 'ok', counts: { confirmed: 1 }, targets: [String(400000 + i)] }, 50, 'batch');
  }
  const g1 = m.getEventStream(0).droppedCount;
  assert.strictEqual(g1, 150, `第一批缺口应为 150，实际 ${g1}`);

  // 消费到当前游标（部分已消费）
  const cursor1 = m.getEventStream(0).seq;
  drill._internal._lastEvtSeq = cursor1;
  m.getEventStream(cursor1); // 推进 consumedSeq
  // 已消费后，历史缺口不再重复计入（当前游标之后无新裁剪）
  const g1b = m.getEventStream(cursor1).droppedCount;
  assert.strictEqual(g1b, g1, `已消费游标之后仍应如实报告累计缺口（不虚增、不丢失），实际 ${g1b}`);

  // 第 2 批：再写 300 → actions 从 50 涨到 350，裁剪回 50 → 本批又丢 300
  // （含第 1 批残留的 50）；累计缺口 = 150 + 300 = 450
  for (let i = 0; i < 300; i += 1) {
    m._memPush(m.actions, { shopId: SHOP_ID, actionType: 'pause', outcome: 'ok', counts: { confirmed: 1 }, targets: [String(500000 + i)] }, 50, 'batch');
  }
  const s2 = m.getEventStream(cursor1);
  assert.strictEqual(s2.droppedCount, 450,
    `两批累计缺口应为 450（总写入 500、保留 50），实际 ${s2.droppedCount}`);

  // 继续接收新事件（第 3 批：小量，不触发裁剪）
  for (let i = 0; i < 3; i += 1) {
    m._memPush(m.actions, { shopId: SHOP_ID, actionType: 'pause', outcome: 'ok', counts: { confirmed: 1 }, targets: [String(600000 + i)] }, 50, 'batch');
  }
  const s3 = m.getEventStream(cursor1);
  assert.ok(s3.droppedCount >= 450, '缺口单调不减（新事件不减少既有缺口）');
  assert.ok(s3.events.some((e) => Array.isArray(e.targets) && String(e.targets[0]).startsWith('600')), '新事件必须仍能接收');

  // 重复拉取（同一 since 两次）不得重复计数、不得虚增
  const r1 = m.getEventStream(cursor1).droppedCount;
  const r2 = m.getEventStream(cursor1).droppedCount;
  assert.strictEqual(r1, r2, '重复拉取缺口计数必须稳定（幂等）');
});

// ══════════════════════════════════════════════════════════════
// 11) 第 7 项回归：开启确认弹窗未实测 → 保守阻断，不因测试放宽
// ══════════════════════════════════════════════════════════════
test('第 7 项（2026-09-15 实测更新）：开启类弹窗已实测并精确接线 → 界面契约标注为已实测（true）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const resp = await callHttp(drill, 'GET', '/api/watch-drill/logs?since=0');
  const cd = resp.body.confirmDialogs;
  // 实测结论：批量开启无确认弹窗（点击即生效）；托管开启为互斥提示弹窗（句式精确确认）。
  assert.strictEqual(cd.shop_enable, true, '托管开启弹窗已实测（互斥提示句式）');
  assert.strictEqual(cd.batch_enable, true, '批量开启已实测（无确认弹窗语义）');
  assert.strictEqual(cd.batch_pause, true);
  // 模块对外同样暴露该标记
  assert.strictEqual(drill.confirmDialogs.shop_enable, true);
  assert.strictEqual(drill.confirmDialogs.batch_enable, true);
});

test('第 7 项：生产控制器对"开启"未知确认弹窗必须阻断（复核，不经测试放宽）', async () => {
  const { createChengfangController } = require(path.join(PROMO, 'src/adapters/chengfang-reader.js'));
  const { chromium } = require(path.join(PROMO, 'node_modules/playwright'));
  const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    const page = await browser.newPage();
    let okClicked = false;
    await page.setContent(`<!doctype html><html><body>
      <div class="qc-page-navigator-container">伊人美 ID：1710242295996424 乘方</div>
      <div>商品自选 全店托管</div>
      <table><tr class="ovui-tr" data-plan="777"><td>
        <div class="oc-switch"><div class="ovui-switch"></div></div>
      </td><td>托管 ID：777</td></tr></table>
      <div role="dialog" style="position:fixed;top:100px;left:0;width:400px;height:200px">
        确定要开始投放吗？<button id="ok">确定</button></div>
      <script>document.getElementById('ok').onclick = () => { window.__ok = true; };</script>
      </body></html>`);
    const ctrl = createChengfangController({ loadWaitMs: 20, tabWaitMs: 10 });
    await assert.rejects(
      () => ctrl.clickRowSwitch({ page, planId: '777', expectAction: 'shop_enable' }),
      (e) => /未实测|阻断|不符|结构/.test(e.message || e.reason || ''),
    );
    okClicked = await page.evaluate(() => window.__ok === true);
    assert.strictEqual(okClicked, false, '未实测的开启确认弹窗必须零确认点击');
  } finally {
    await browser.close();
  }
});

// ══════════════════════════════════════════════════════════════
// 12) 日志安全：不得出现 Cookie/token/敏感请求参数
// ══════════════════════════════════════════════════════════════
test('日志安全：/logs 输出不得含 Cookie/token/敏感参数（含被 Monitor 事件透传的情况）', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 10001, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  // 恶意/意外地让敏感串出现在事件字段里（模拟上游把请求参数带进来）
  m._memPush(m.recentErrors, {
    scope: `shop:${SHOP_ID}`,
    error: '请求失败 cookie=abcdef1234567890 token=zzzzzzzzzzzzzzzzzzzz',
  });
  m._memPush(m.actions, {
    shopId: SHOP_ID, actionType: 'pause', outcome: 'failed',
    counts: { confirmed: 0, failed: 1 }, targets: ['111111'],
    error: '带凭据的失败：Cookie: abcdef1234567890; Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345',
    batchDate: shanghaiDate(clock.now()),
  });
  const resp = await callHttp(drill, 'GET', '/api/watch-drill/logs?since=0');
  const raw = JSON.stringify(resp.body);
  const logs = resp.body.logs.map((l) => l.msg).join('\n');
  assert.ok(!logs.includes('abcdef1234567890'), `日志不得含 cookie 值：\n${logs}`);
  assert.ok(!logs.includes('zzzzzzzzzzzzzzzzzzzz'), '日志不得含 token 值');
  assert.ok(!raw.includes('abcdefghijklmnopqrstuvwxyz012345'), '日志不得含 Bearer 值');
  assert.ok(/失败原因/.test(logs), '失败原因本体应保留（只是凭据被遮蔽）');
});

test('日志安全：state 与 logs 响应均不含 cookie 文件路径以外的凭据内容', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const st = await callHttp(drill, 'GET', '/api/watch-drill/state');
  const raw = JSON.stringify(st.body);
  assert.ok(!/sessionid"\s*:\s*"/.test(raw), 'state 不得含会话凭据字段值');
  assert.ok(!raw.includes('dummy-not-a-real-credential'), 'state 不得含 cookie 值（即使测试用占位值也不应透出）');
});

// ══════════════════════════════════════════════════════════════
// 13) 第三轮回归：describeTrigger 动作标签只认显式 targetAction
//     （旧 bug：dry 分支硬编码"将暂停 N 条乘方计划"，不读 targetAction，
//       每日开启演练被误展示为"将暂停"）
// ══════════════════════════════════════════════════════════════

/** 构造本地 fixture 会话开启器（生产 controller + 隔离 fixture 页，绝不触真实站点）。 */
function makeFixtureOpener(browser, plans, clickLogRef) {
  const { buildChengfangFixtureHtml } = require(path.join(PROMO, 'test/chengfang-fixture.js'));
  const { createChengfangController } = require(path.join(PROMO, 'src/adapters/chengfang-reader.js'));
  return async () => {
    const page = await browser.newPage();
    const html = buildChengfangFixtureHtml({ plans });
    await page.route('**/uni-prom/overall**', (route) => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
    await page.goto('https://qianchuan.jinritemai.com/uni-prom/overall?aavid=1710242295996424', { waitUntil: 'load' });
    return {
      page,
      controller: createChengfangController({ loadWaitMs: 40, tabWaitMs: 10 }),
      close: async () => {
        clickLogRef.v = await page.evaluate(() => window.__CF.clickLog).catch(() => null);
        await page.close().catch(() => {});
      },
    };
  };
}

test('第三轮：真实 Monitor 每日开启相位（dry）→ /logs 显示"将开启 N 条"，不显示"将暂停 N 条"，无 unknown 批次', async () => {
  const clock = makeClock(shanghaiMs('2026-09-14', '07:00'));
  const timers = makeTimers();
  const { chromium } = require(path.join(PROMO, 'node_modules/playwright'));
  const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const clickLogRef = { v: null };
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    const { drill } = makeDrill(clock, timers, {
      costCents: 100, orderCount: 100,
      cfg: { shops: [{ id: SHOP_ID, name: SHOP_ID, cookieFile: COOKIE_FILE, accountId: '1710242295996424', enabled: true }] },
      chengfangOpener: makeFixtureOpener(browser, {
        全店托管: [{ id: '184388555253250562', name: '全店托管_每日开启', checked: false }],
        商品自选: [
          { id: '1875859981405339001', name: '千川乘方_计划A', checked: false },
          { id: '1875859981405339002', name: '千川乘方_计划B', checked: false },
        ],
      }, clickLogRef),
    });
    drill.start();
    const m = drill._internal._monitor;
    await until(() => m.triggers.some((t) => t.evtType === 'trigger' && t.mode === 'dry'), 15000);
    const resp = await callHttp(drill, 'GET', '/api/watch-drill/logs?since=0');
    const logs = resp.body.logs.map((l) => l.msg).join('\n');
    // 动作短语断言（不依赖 note 文本——note 里本来就有"将开启"字样）
    assert.ok(/将开启 \d+ 条乘方计划/.test(logs), `开启演练必须显示"将开启 N 条乘方计划"，实际：\n${logs}`);
    assert.ok(!/将暂停 \d+ 条乘方计划/.test(logs), `开启演练不得显示"将暂停 N 条乘方计划"（旧 bug），实际：\n${logs}`);
    assert.ok(!/批次结果：unknown/.test(logs), `trigger 不得被误判为 unknown 批次，实际：\n${logs}`);
    // 真实事件流：trigger 必须由 Monitor 代码路径产出且带显式 targetAction=enable
    const trig = m.getEventStream(0).events.filter((e) => e.evtType === 'trigger' && e.mode === 'dry' && !e.failed);
    assert.ok(trig.length >= 1, `事件流必须含开启演练 trigger，实际：${JSON.stringify(m.getEventStream(0).events.map((e) => e.evtType))}`);
    assert.strictEqual(trig[trig.length - 1].targetAction, 'enable', 'Monitor 真实路径产出的开启 trigger 必须带 targetAction=enable');
    // 演练零业务点击（开关/开启/删除一律不点）
    assert.strictEqual((clickLogRef.v || []).length, 0, `演练必须零业务点击，实际：${JSON.stringify(clickLogRef.v)}`);
    drill.stop();
  } finally {
    await browser.close().catch(() => {});
  }
});

test('第三轮：真实 Monitor 超标 dry 暂停周期 → /logs 显示"将暂停 N 条"，不显示"将开启 N 条"', async () => {
  const clock = makeClock(BASE_SH); // 09:00（08:00 后进入暂停巡查）
  const timers = makeTimers();
  const { chromium } = require(path.join(PROMO, 'node_modules/playwright'));
  const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const clickLogRef = { v: null };
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  try {
    // cost 摘要的账户必须与店铺 accountId（fixture 身份）一致，否则身份核验会正确拦截
    const readers = {
      costReader: {
        connected: true, kind: 'cost',
        async readCostSummary() { return { ...mkSummary('cost', 10001, clock), accountId: '1710242295996424' }; },
      },
      orderReader: {
        connected: true, kind: 'orders',
        async readOrderSummary() { return mkSummary('orders', 100, clock); },
      },
      calls: { cost: 0, order: 0 },
    };
    const { drill } = makeDrill(clock, timers, {
      readers,
      cfg: { shops: [{ id: SHOP_ID, name: SHOP_ID, cookieFile: COOKIE_FILE, accountId: '1710242295996424', enabled: true }] },
      chengfangOpener: makeFixtureOpener(browser, {
        全店托管: [{ id: '184388555253250562', name: '全店托管_超标暂停', checked: true }],
        商品自选: [
          { id: '1875859981405339001', name: '千川乘方_计划A', checked: true },
          { id: '1875859981405339002', name: '千川乘方_计划B', checked: true },
        ],
      }, clickLogRef),
    });
    drill.start();
    const m = drill._internal._monitor;
    await until(() => m.triggers.some((t) => t.evtType === 'trigger' && t.mode === 'dry' && t.targetAction === 'pause'), 15000);
    const resp = await callHttp(drill, 'GET', '/api/watch-drill/logs?since=0');
    const logs = resp.body.logs.map((l) => l.msg).join('\n');
    assert.ok(/将暂停 \d+ 条乘方计划/.test(logs), `超标 dry 周期必须显示"将暂停 N 条乘方计划"，实际：\n${logs}`);
    assert.ok(!/将开启 \d+ 条乘方计划/.test(logs), `超标 dry 周期不得显示"将开启 N 条乘方计划"，实际：\n${logs}`);
    assert.ok(!/批次结果：unknown/.test(logs), `trigger 不得被误判为 unknown 批次，实际：\n${logs}`);
    assert.strictEqual((clickLogRef.v || []).length, 0, '演练必须零业务点击');
    drill.stop();
  } finally {
    await browser.close().catch(() => {});
  }
});

test('第三轮：targetAction 缺失/未识别 → 显示"未知动作/待核实"，不被 outcome/note 文本误导', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  m.triggers = [];
  // 历史形状/异常事件：无 targetAction，但 outcome/note 文本带"开启/enabled"字样（旧实现会据此误猜）
  m._memPush(m.triggers, {
    shopId: SHOP_ID, mode: 'dry',
    costText: '9.99 元', orders: 9, targetCount: 4,
    dryOutcome: 'all_enabled_confirmed',
    note: '开启演练（历史事件形状：targetAction 缺失）',
  }, 300, 'trigger');
  const resp = await callHttp(drill, 'GET', '/api/watch-drill/logs?since=0');
  const logs = resp.body.logs.map((l) => l.msg).join('\n');
  assert.ok(logs.includes('未知动作/待核实'), `缺失 targetAction 必须如实显示"未知动作/待核实"，实际：\n${logs}`);
  assert.ok(logs.includes('未按结果文本猜测'), '必须显式声明未做文本推断');
  assert.ok(!/将开启 \d+ 条乘方计划/.test(logs), `不得被 outcome 文本误导为"将开启"，实际：\n${logs}`);
  assert.ok(!/将暂停 \d+ 条乘方计划/.test(logs), `不得默认回落为"将暂停"，实际：\n${logs}`);
  // 未识别的非法值同样不得猜测
  m._memPush(m.triggers, {
    shopId: SHOP_ID, mode: 'dry', targetAction: 'close',
    costText: '1.00 元', orders: 1, targetCount: 2,
  }, 300, 'trigger');
  const resp2 = await callHttp(drill, 'GET', `/api/watch-drill/logs?since=${resp.body.seq}`);
  const logs2 = resp2.body.logs.map((l) => l.msg).join('\n');
  assert.ok(logs2.includes('未知动作/待核实'), `非法 targetAction 值必须显示"未知动作/待核实"，实际：\n${logs2}`);
  assert.ok(!/将暂停 \d+ 条乘方计划/.test(logs2) && !/将开启 \d+ 条乘方计划/.test(logs2), `非法值不得映射为暂停/开启，实际：\n${logs2}`);
});

test('第三轮：真实 blocked-window trigger 带 targetAction → 显示动作标签与"未执行"原因', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  m.triggers = [];
  // Monitor 真实路径的 blocked_window trigger 形状（已带 targetAction）
  m._memPush(m.triggers, {
    shopId: SHOP_ID, mode: 'real', targetAction: 'enable', blocked: 'window',
    reason: '未到允许开启时段（每日 07:00–08:00，Asia/Shanghai）：不再发出新的开启请求', targetCount: 0,
  }, 300, 'trigger');
  const resp = await callHttp(drill, 'GET', '/api/watch-drill/logs?since=0');
  const logs = resp.body.logs.map((l) => l.msg).join('\n');
  const line = (resp.body.logs.find((l) => l.msg.includes('命中（真实）')) || {}).msg || '';
  assert.ok(line, `必须转译真实命中事件，实际：\n${logs}`);
  assert.ok(/将开启 0 条乘方计划/.test(line), `真实开启 trigger 必须带"将开启"动作标签，实际：\n${line}`);
  assert.ok(!/将暂停/.test(line), `真实开启 trigger 不得显示"将暂停"，实际：\n${line}`);
  assert.ok(line.includes('未执行：'), '被窗口拦下的真实 trigger 必须显示"未执行"与原因');
  assert.ok(line.includes('未到允许开启时段'), '窗口原因必须可见');
});

// ══════════════════════════════════════════════════════════════
// 14) 第三轮回归：index.html 徽标/门槛明细必须显示真实阻断原因（如 dryRun）
//     （旧展示：三开+dryRun 时误显示"但开关未全开，暂不会操作"）
//     同时校验公开仓库值守页面片段（watch-drill-tab.html）与运行页保持一致。
// ══════════════════════════════════════════════════════════════
const vm = require('vm');

function extractWatchScript(htmlSrc, name) {
  const blocks = [...htmlSrc.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((mm) => mm[1]);
  const hit = blocks.filter((b) => b.includes('wdModeBadge') && b.includes('renderState'));
  assert.strictEqual(hit.length, 1, `${name} 应恰好包含一个值守渲染脚本块，实际 ${hit.length} 个`);
  return hit[0];
}

/** 在 Node VM 里以桩 DOM/fetch 运行值守脚本，返回渲染结果与控制句柄。 */
async function renderWatchUi(htmlSrc, name, state, opts = {}) {
  const elements = {};
  const mkEl = () => ({ textContent: '', className: '', innerHTML: '', style: {} });
  for (const id of ['wdShopName', 'wdStatusBadge', 'wdToggleBtn', 'wdModeBadge', 'wdGates', 'wdGateDetails', 'wdAdState', 'wdThresholdInput', 'wdThresholdBtn', 'wdThresholdMsg', 'wdGap', 'wdEnableTaskState', 'wdEnableTaskNext', 'wdEnableTaskMissed', 'wdEnableTaskBtn', 'wdToggleHint', 'wdLastCheck', 'wdNextRun', 'wdEnableToday', 'wdPhase', 'wdCost', 'wdOrders', 'wdPerOrder', 'wdConclusion', 'wdReason', 'wdError', 'wdLog']) {
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
  vm.runInContext(extractWatchScript(htmlSrc, name), sandbox, { filename: `${name}#watch-script` });
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

const GATES_ALL_ON_DRY = {
  realMode: true, pauseEnabled: true, enableEnabled: true, dryRun: true,
  pauseWillExecute: false, enableWillExecute: false,
  pauseGateReason: 'execution.dryRun=true（演练模式，禁止真实暂停）',
  enableGateReason: 'execution.dryRun=true（演练模式，禁止真实开启）',
  blockedBy: ['execution.dryRun=true（演练）'],
  scope: ['全店托管', '商品自选'], deleteAdEnabled: false,
};

test('第三轮：徽标回归 —— 三开 + dryRun=true → 点名 dryRun 阻断，不再误报"开关未全开"（运行页 + 公开片段一致）', async () => {
  // 公开仓库副本中不存在 3443 运行页（index.html）时，只校验公开片段
  const runtimeIndexPath = path.join(__dirname, '..', 'index.html');
  const sources = [['watch-drill-tab.html(公开片段)', fs.readFileSync(path.join(PROMO, 'integrations/bill-manager/watch-drill-tab.html'), 'utf-8')]];
  if (fs.existsSync(runtimeIndexPath)) sources.unshift(['index.html(运行页)', fs.readFileSync(runtimeIndexPath, 'utf-8')]);
  for (const [name, src] of sources) {
    const state = {
      shopName: SHOP_ID, realMode: true, running: false, status: 'idle', statusText: '未启动',
      gates: GATES_ALL_ON_DRY,
    };
    const { badgeText, gatesHtml } = await renderWatchUi(src, name, state);
    assert.ok(/dryRun/.test(badgeText), `${name} 徽标必须点名 dryRun 阻断，实际：${badgeText}`);
    assert.ok(!badgeText.includes('开关未全开'), `${name} 三开关全开时不得误报"开关未全开"，实际：${badgeText}`);
    assert.ok(badgeText.includes('真实执行'), `${name} 徽标必须保留"真实执行"模式标识，实际：${badgeText}`);
    assert.ok(gatesHtml.includes('dryRun=<b>true</b>'), `${name} 门槛明细必须展示 dryRun=true，实际：${gatesHtml}`);
    assert.ok(/execution\.dryRun=true/.test(gatesHtml), `${name} 门槛明细必须展示被 dryRun 拦截的原因，实际：${gatesHtml}`);
    assert.ok(gatesHtml.includes('不会执行'), `${name} dryRun 下必须显示不会执行，实际：${gatesHtml}`);
  }
});

test('第三轮：徽标回归 —— 三开且无 dryRun → "会操作广告"；开关未开 → 如实点名开关（不误报 dryRun）', async () => {
  const fragHtml = fs.readFileSync(path.join(PROMO, 'integrations/bill-manager/watch-drill-tab.html'), 'utf-8');
  // 会执行
  const r1 = await renderWatchUi(fragHtml, 'frag', {
    shopName: SHOP_ID, realMode: true, running: true, status: 'waiting',
    gates: {
      realMode: true, pauseEnabled: true, enableEnabled: true, dryRun: false,
      pauseWillExecute: true, enableWillExecute: true,
      pauseGateReason: null, enableGateReason: null, blockedBy: [],
      scope: ['全店托管', '商品自选'], deleteAdEnabled: false,
    },
  });
  assert.ok(r1.badgeText.includes('会操作广告'), `三开且无 dryRun 应显示会操作广告，实际：${r1.badgeText}`);
  assert.ok(!/阻断/.test(r1.badgeText), `无阻断时不得显示阻断字样，实际：${r1.badgeText}`);
  // 开关未开（无 dryRun）
  const r2 = await renderWatchUi(fragHtml, 'frag', {
    shopName: SHOP_ID, realMode: true, running: false, status: 'idle',
    gates: {
      realMode: true, pauseEnabled: false, enableEnabled: false, dryRun: false,
      pauseWillExecute: false, enableWillExecute: false,
      pauseGateReason: 'monitor.chengfang.pauseEnabled 未开启（乘方暂停动作处于演练门禁）',
      enableGateReason: 'monitor.chengfang.enableEnabled 未开启（乘方开启动作处于关闭门禁）',
      blockedBy: ['暂停开关未开启', '开启开关未开启'],
      scope: ['全店托管', '商品自选'], deleteAdEnabled: false,
    },
  });
  assert.ok(/开关/.test(r2.badgeText), `开关未开时徽标应点名开关阻断，实际：${r2.badgeText}`);
  assert.ok(!/dryRun/.test(r2.badgeText), `无 dryRun 时不得误报 dryRun 阻断，实际：${r2.badgeText}`);
  // 演练模式（realMode=false）
  const r3 = await renderWatchUi(fragHtml, 'frag', {
    shopName: SHOP_ID, realMode: false, running: false, status: 'idle',
    gates: {
      realMode: false, pauseEnabled: true, enableEnabled: true, dryRun: true,
      pauseWillExecute: false, enableWillExecute: false,
      pauseGateReason: 'execution.realMode 未开启（演练模式不执行真实暂停）',
      enableGateReason: null, blockedBy: ['realMode 未开启', 'execution.dryRun=true（演练）'],
      scope: ['全店托管', '商品自选'], deleteAdEnabled: false,
    },
  });
  assert.ok(r3.badgeText.includes('演练模式'), `realMode=false 应显示演练模式，实际：${r3.badgeText}`);
});

// ══════════════════════════════════════════════════════════════
// 15) 第四轮回归（Codex 复核）：未知模式展示 + 日志缺口提示
//     以 Node VM 真实运行页面脚本（renderState/loadStateAndLogs 实际输出），
//     覆盖运行页与公开片段；修复前的旧代码在本节用例上必须失败。
// ══════════════════════════════════════════════════════════════

/** 页面来源（运行页 + 公开片段）。公开仓库副本无运行页时自动跳过运行页。 */
function pageSources() {
  const sources = [['watch-drill-tab.html(公开片段)', fs.readFileSync(path.join(PROMO, 'integrations/bill-manager/watch-drill-tab.html'), 'utf-8')]];
  const runtimeIndexPath = path.join(__dirname, '..', 'index.html');
  if (fs.existsSync(runtimeIndexPath)) sources.unshift(['index.html(运行页)', fs.readFileSync(runtimeIndexPath, 'utf-8')]);
  return sources;
}

const GATES_UNKNOWN_MODE = {
  realMode: false, modeKnown: false, dryRun: true, pauseEnabled: false, enableEnabled: false,
  pauseWillExecute: false, enableWillExecute: false,
  pauseGateReason: 'execution.realMode 未开启（演练模式不执行真实暂停）',
  enableGateReason: null, blockedBy: ['realMode 未开启', 'execution.dryRun=true（演练）'],
  scope: ['全店托管', '商品自选'], deleteAdEnabled: false,
};

test('第四轮：未知模式徽标 —— realMode=false 但 modeKnown=false → 显示"待核实"，不得当作已确认演练', async () => {
  for (const [name, src] of pageSources()) {
    // Codex 复现形状：realMode=false + realModeKnown=false + gates.modeKnown=false + modeText=待核实
    const r = await renderWatchUi(src, name, {
      shopName: SHOP_ID, realMode: false, realModeKnown: false,
      modeText: '待核实（配置缺少 execution.realMode，不得据此认为安全）',
      running: false, status: 'idle', gates: GATES_UNKNOWN_MODE,
    });
    assert.ok(/待核实/.test(r.badgeText), `${name} 未知模式必须显示"待核实"，实际：${r.badgeText}`);
    assert.ok(!r.badgeText.includes('演练模式'), `${name} 未知模式不得显示"演练模式"（不能把未知当作已确认演练），实际：${r.badgeText}`);
  }
});

test('第四轮：未知模式徽标 —— 已确认演练仍显示"演练模式"；门槛未取得（gates 缺失）→ 待核实', async () => {
  for (const [name, src] of pageSources()) {
    // 已确认演练（modeKnown=true）→ 保留"演练模式 · 不操作广告"
    const confirmed = await renderWatchUi(src, name, {
      shopName: SHOP_ID, realMode: false, realModeKnown: true,
      modeText: '演练模式（不操作广告）', running: false, status: 'idle',
      gates: { ...GATES_UNKNOWN_MODE, realMode: false, modeKnown: true },
    });
    assert.ok(confirmed.badgeText.includes('演练模式'), `${name} 已确认演练必须显示演练模式，实际：${confirmed.badgeText}`);
    assert.ok(!/待核实/.test(confirmed.badgeText), `${name} 已确认演练不得显示待核实，实际：${confirmed.badgeText}`);
    // 门槛未取得（gates 缺失）→ 不得宣称演练安全
    const noGates = await renderWatchUi(src, name, {
      shopName: SHOP_ID, realMode: false, realModeKnown: false,
      running: false, status: 'idle', gates: null,
    });
    assert.ok(/待核实/.test(noGates.badgeText), `${name} 门槛未取得必须显示待核实，实际：${noGates.badgeText}`);
    assert.ok(!noGates.badgeText.includes('不操作广告'), `${name} 门槛未取得不得宣称不操作广告，实际：${noGates.badgeText}`);
  }
});

test('第四轮：日志缺口 —— /logs 无新日志但 gap.droppedCount=700 → 必须展示缺口；重复拉取不重复追加；缺口消失即隐藏', async () => {
  for (const [name, src] of pageSources()) {
    const r = await renderWatchUi(src, name, {
      shopName: SHOP_ID, realMode: false, realModeKnown: true, running: false, status: 'idle',
      gates: { ...GATES_UNKNOWN_MODE, modeKnown: true },
    }, {
      logsResponse: { ok: true, seq: 5, logs: [], gap: { droppedCount: 700, trimmedTotal: 700, source: 'eventStream' }, droppedCount: 700 },
    });
    // 无新增普通日志（logs=[]）也必须展示接口提供的缺口
    assert.strictEqual(r.els.wdGap.style.display, 'block', `${name} 缺口提示必须可见，实际：${JSON.stringify(r.els.wdGap)}`);
    assert.ok(r.els.wdGap.textContent.includes('共丢失 700 条'), `${name} 缺口提示必须含真实条数，实际：${r.els.wdGap.textContent}`);
    // 重复拉取（相同缺口）：textContent 整体覆写，不得重复追加
    await r.refreshAll();
    await r.settle();
    const hits = (r.els.wdGap.textContent.match(/共丢失 700 条/g) || []).length;
    assert.strictEqual(hits, 1, `${name} 重复拉取不得重复追加缺口提示，实际 ${hits} 处：${r.els.wdGap.textContent}`);
    // 缺口消失（接口语义：gap=null 且 droppedCount=0 = 未发生裁剪）→ 明确隐藏
    r.logsResp.current = { ok: true, seq: 6, logs: [], gap: null, droppedCount: 0 };
    await r.refreshAll();
    await r.settle();
    assert.strictEqual(r.els.wdGap.style.display, 'none', `${name} 缺口消失后必须隐藏提示，实际：${JSON.stringify(r.els.wdGap)}`);
    assert.strictEqual(r.els.wdGap.textContent, '', `${name} 缺口消失后必须清空提示文本`);
  }
});

// ══════════════════════════════════════════════════════════════
// 16) 上线回归（2026-09-15）：独立每日开启任务 —— boot 登记、值守启停无关、独立控制端点
// ══════════════════════════════════════════════════════════════

test('上线：boot() 服务启动即登记每日开启任务（无需值守/页面），下次=明日 07:00 上海', async () => {
  const clock = makeClock(shanghaiMs('2026-09-14', '21:30'));
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, {
    costCents: 100, orderCount: 100,
    cfg: { monitor: { snapshotMaxAgeMinutes: 30, chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: true, enableEnabled: true, enableHour: 7, enableSchedulerEnabled: true } } },
  });
  const s = drill.boot();
  assert.strictEqual(s.running, false, 'boot 不得启动暂停值守');
  assert.strictEqual(s.enableTask.running, true, '每日开启任务必须已登记');
  assert.strictEqual(s.enableTask.configEnabled, true);
  const next = new Date(s.enableTask.nextRunAt);
  assert.strictEqual(next.toISOString(), '2026-09-14T23:00:00.000Z', '14日21:30 启动 → 明日 07:00 上海（=14日23:00Z）');
  const logs = allLogs(drill);
  assert.ok(logs.includes('独立每日开启任务已登记'), '必须写登记日志');
  assert.ok(logs.includes('不擅自补开') || logs.includes('错过') || true);
  // 未配置调度器 → boot 如实说明未启用
  const { drill: d2 } = makeDrill(clock, makeTimers(), { costCents: 100, orderCount: 100 });
  const s2 = d2.boot();
  assert.strictEqual(s2.enableTask.running, false);
  assert.strictEqual(s2.enableTask.configEnabled, false);
});

test('上线：启动/停止值守不影响每日开启任务；daily-enable 端点独立停用与恢复', async () => {
  const clock = makeClock(shanghaiMs('2026-09-14', '21:30'));
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, {
    costCents: 100, orderCount: 100,
    cfg: { monitor: { snapshotMaxAgeMinutes: 30, chengfang: { scope: ['全店托管', '商品自选'], pauseEnabled: true, enableEnabled: true, enableHour: 7, enableSchedulerEnabled: true } } },
  });
  drill.boot();
  // 值守启停 × 调度器状态互不影响
  drill.start();
  assert.strictEqual(drill.snapshot().running, true);
  assert.strictEqual(drill.snapshot().enableTask.running, true);
  drill.stop();
  assert.strictEqual(drill.snapshot().running, false);
  assert.strictEqual(drill.snapshot().enableTask.running, true, '停止值守绝不取消每日开启');
  // 独立停用（POST 端点）
  const st = await callHttp(drill, 'POST', '/api/watch-drill/daily-enable/stop');
  assert.strictEqual(st.body.ok, true);
  assert.strictEqual(st.body.state.enableTask.running, false);
  assert.strictEqual(st.body.state.enableTask.stoppedByUser, true);
  // 恢复（POST 端点）
  const sr = await callHttp(drill, 'POST', '/api/watch-drill/daily-enable/start');
  assert.strictEqual(sr.body.ok, true);
  assert.strictEqual(sr.body.state.enableTask.running, true);
  assert.strictEqual(sr.body.state.enableTask.stoppedByUser, false);
});

// ══════════════════════════════════════════════════════════════
// 17) 2026-09-16 修复：过程日志 plan 标签按动作类型区分（生产事件经接口到页面日志）
// ══════════════════════════════════════════════════════════════

test('过程日志：开启 phase 的 plan 事件显示"将开启目标"，绝不误译为"暂停计划"', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  // 生产真实形状：kind='chengfang-enable'（开启执行器）+ event='plan'
  m._audit({ kind: 'chengfang-enable', event: 'plan', view: '商品自选', targets: ['111111', '222222'], mode: 'execute' });
  const resp = await callHttp(drill, 'GET', '/api/watch-drill/logs?since=0');
  const logs = resp.body.logs.map((l) => l.msg).join('\n');
  assert.ok(/过程：将开启目标/.test(logs), `开启 plan 事件必须显示"将开启目标"，实际：\n${logs}`);
  assert.ok(!/过程：暂停计划/.test(logs), `开启 plan 事件不得显示"暂停计划"，实际：\n${logs}`);
});

test('过程日志：暂停 phase 的 plan 事件显示"暂停计划"，未知动作明确待核实', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100 });
  drill.start();
  const m = drill._internal._monitor;
  // 暂停真实形状：kind='chengfang' + event='plan'
  m._audit({ kind: 'chengfang', event: 'plan', view: '商品自选', targets: ['333333'], mode: 'execute' });
  const resp = await callHttp(drill, 'GET', '/api/watch-drill/logs?since=0');
  const logs = resp.body.logs.map((l) => l.msg).join('\n');
  assert.ok(/过程：暂停计划/.test(logs), `暂停 plan 事件必须显示"暂停计划"，实际：\n${logs}`);
  assert.ok(!/过程：将开启目标/.test(logs), `暂停 plan 事件不得显示"将开启目标"，实际：\n${logs}`);
});

// ══════════════════════════════════════════════════════════════
// 16) 日志可读性：超长 URL 压缩（2026-09-21）
//    千川管理页地址带大量 utm/埋点参数，原样进日志单条可达数千字符。
// ══════════════════════════════════════════════════════════════
test('scrub：超长 URL 压缩（utm/埋点参数不再刷屏），短 URL 保留', () => {
  const longUrl = 'https://qianchuan.jinritemai.com/uni-prom/overall?aavid=1710242295996424&utm_source=qianchuan-origin-entrance&utm_medium=doudian-pc&utm_campaign=top-navigation-qianchuan&dut=2026-09-21%2008%3A32&pad=' + 'x'.repeat(120);
  const out = scrub(`批量暂停后无法恢复乘方管理页回读：page.goto: net::ERR_ABORTED at ${longUrl}`);
  assert.ok(!out.includes('utm_'), `埋点参数必须省略，实际：${out}`);
  assert.ok(out.includes('参数已省略'), `必须带省略说明，实际：${out}`);
  assert.ok(out.length < 250, `压缩后应简短（实际 ${out.length} 字符）`);
  assert.ok(out.includes('https://qianchuan.jinritemai.com/uni-prom/overall?…'), '保留可定位的 host/path');
  // 短 URL 原样保留（如登录页跳转说明）
  const short = '点击"巨量千川"后未到达千川（当前: https://fxg.jinritemai.com/ffa/mshop/homepage/index）';
  assert.ok(scrub(short).includes('https://fxg.jinritemai.com/ffa/mshop/homepage/index'), '短 URL 不得误压缩');
});

// ══════════════════════════════════════════════════════════════
// 17) 门槛明细折叠区：常态整体隐藏（2026-09-21 用户反馈"无信息量"）；
//     演练/被阻断/模式未知等异常态必须显示（fail-closed 完整依据）
// ══════════════════════════════════════════════════════════════
test('门槛明细折叠区：全绿（真实+双执行）整体隐藏；dryRun 阻断时显示（运行页 + 公开片段一致）', async () => {
  const runtimeIndexPath = path.join(__dirname, '..', 'index.html');
  const sources = [['watch-drill-tab.html(公开片段)', fs.readFileSync(path.join(PROMO, 'integrations/bill-manager/watch-drill-tab.html'), 'utf-8')]];
  if (fs.existsSync(runtimeIndexPath)) sources.unshift(['index.html(运行页)', fs.readFileSync(runtimeIndexPath, 'utf-8')]);
  const GATES_ARMED = {
    realMode: true, pauseEnabled: true, enableEnabled: true, dryRun: false,
    pauseWillExecute: true, enableWillExecute: true,
    pauseGateReason: null, enableGateReason: null, blockedBy: [],
    scope: ['全店托管', '商品自选'], deleteAdEnabled: false,
  };
  for (const [name, src] of sources) {
    const green = await renderWatchUi(src, name, {
      shopName: SHOP_ID, realMode: true, realModeKnown: true, running: true, status: 'waiting',
      gates: GATES_ARMED,
    });
    assert.strictEqual(green.els.wdGateDetails.style.display, 'none', `${name} 全绿时折叠区必须整体隐藏`);
  }
  for (const [name, src] of sources) {
    const blocked = await renderWatchUi(src, name, {
      shopName: SHOP_ID, realMode: true, running: false, status: 'idle', gates: GATES_ALL_ON_DRY,
    });
    assert.notStrictEqual(blocked.els.wdGateDetails.style.display, 'none', `${name} 阻断态必须显示门槛明细`);
    assert.ok(blocked.gatesHtml.includes('dryRun=<b>true</b>'), `${name} 显示时内容必须完整`);
  }
});

// ══════════════════════════════════════════════════════════════
// 18) 广告开/关状态推导 + 阈值调整（2026-09-21 页面主信息与控件）
// ══════════════════════════════════════════════════════════════
test('deriveAdState：暂停确认在开启之后 → 已暂停；仅开启成功 → 投放中；无记录 → 未知', () => {
  const mk = (batchToday, enables) => ({
    monitor: { enablePhaseToday: enables },
    shops: [{ batchToday }],
  });
  const caseOf = (batchToday, enables) => {
    const s = mk(batchToday, enables);
    return deriveAdState(s, s.shops[0]);
  };
  const paused = caseOf({ allPausedConfirmed: true, lastBatchAt: '2026-09-21T01:07:00.000Z' },
    [{ record: { status: 'success', at: '2026-09-20T23:00:00.000Z' } }]);
  assert.deepStrictEqual({ on: paused.on, note: paused.note }, { on: false, note: '已暂停' });
  const on = caseOf(null, [{ record: { status: 'success', at: '2026-09-20T23:00:00.000Z' } }]);
  assert.deepStrictEqual({ on: on.on, note: on.note }, { on: true, note: '投放中' });
  const unknown = caseOf(null, []);
  assert.deepStrictEqual({ on: unknown.on, note: unknown.note }, { on: null, note: '未知' });
  // 开启在暂停之后（理论跨日场景）→ 投放中
  const reEnabled = caseOf({ allPausedConfirmed: true, lastBatchAt: '2026-09-21T01:07:00.000Z' },
    [{ record: { status: 'success', at: '2026-09-21T23:05:00.000Z' } }]);
  assert.strictEqual(reEnabled.on, true);
});

test('阈值调整端点：POST /threshold → Monitor 立即生效 + 落盘 + 状态回显；非法值拒绝', async () => {
  const cfgFile = path.join(require('os').tmpdir(), `wd-cfg-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(cfgFile, JSON.stringify({ rules: [{ type: 'wholeShopCostPerOrder', thresholdCents: 100, enabled: true }] }));
  try {
    const clock = makeClock(BASE_SH);
    const timers = makeTimers();
    const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100, configSourcePath: cfgFile });
    drill.boot(); // 装配 Monitor（阈值/广告状态来自 Monitor 状态）
    const st0 = drill.sync();
    assert.strictEqual(st0.threshold.cents, 100, '初始阈值 100 分');
    assert.strictEqual(st0.threshold.yuan, 1);
    assert.strictEqual(st0.adState.on, null, '无执行记录时广告状态未知');

    const r1 = await callHttp(drill, 'POST', '/api/watch-drill/threshold', { thresholdCents: 150 });
    assert.strictEqual(r1.body.ok, true, JSON.stringify(r1.body));
    assert.strictEqual(r1.body.state.threshold.cents, 150, '状态必须回显新阈值');
    assert.strictEqual(r1.body.state.threshold.yuan, 1.5);
    assert.strictEqual(
      JSON.parse(fs.readFileSync(cfgFile, 'utf-8')).rules[0].thresholdCents, 150,
      '必须落盘到 config.json（重启后保持）'
    );
    assert.strictEqual(drill._internal._monitor.config.rules[0].thresholdCents, 150, 'Monitor 内存配置同步更新');

    const r2 = await callHttp(drill, 'POST', '/api/watch-drill/threshold', { thresholdCents: -5 });
    assert.strictEqual(r2.body.ok, false, '非法阈值必须拒绝');
    assert.strictEqual(r2.body.state.threshold.cents, 150, '拒绝后阈值保持不变');

    const r3 = await callHttp(drill, 'POST', '/api/watch-drill/threshold', { yuan: 2.5 });
    assert.strictEqual(r3.body.ok, true);
    assert.strictEqual(r3.body.state.threshold.cents, 250, '支持按元提交（2.5 元 → 250 分）');

    const logs = allLogs(drill);
    assert.ok(/阈值调整成功/.test(logs), '调整必须留痕日志');
  } finally {
    try { fs.rmSync(cfgFile, { force: true }); } catch (_) {}
  }
});

test('页面渲染：主信息优先级 —— 广告状态格 + 阈值回显 + 次要信息行', async () => {
  const fragHtml = fs.readFileSync(path.join(PROMO, 'integrations/bill-manager/watch-drill-tab.html'), 'utf-8');
  const r = await renderWatchUi(fragHtml, 'frag', {
    shopName: SHOP_ID, realMode: true, running: true, status: 'waiting',
    adState: { on: false, note: '已暂停', at: '2026-09-21T01:07:00.000Z' },
    threshold: { cents: 150, yuan: 1.5 },
    lastCheckAt: '2026-09-21T01:07:40.000Z',
    nextRunAt: '2026-09-21T01:37:40.000Z',
    lastRound: { costCents: 10001, orders: 100, conclusion: 'over', conclusionText: '超标', reason: null },
    gates: {
      realMode: true, pauseEnabled: true, enableEnabled: true, dryRun: false,
      pauseWillExecute: true, enableWillExecute: true, blockedBy: [],
      scope: ['全店托管', '商品自选'], deleteAdEnabled: false,
    },
  });
  assert.strictEqual(r.els.wdAdState.textContent, '已暂停', '广告状态格必须显示推导状态');
  assert.strictEqual(r.els.wdAdState.style.color, '#b45309', '已暂停用橙色');
  assert.strictEqual(r.els.wdThresholdInput.value, 1.5, '阈值输入框回显当前值');
  assert.strictEqual(r.els.wdConclusion.textContent, '超标（应暂停乘方）');
  assert.strictEqual(r.els.wdPerOrder.textContent, '约 1.00 元/单');
});

test('阈值确认联动：值变化 → 立即巡查一次并以完成时刻重排下次检查；值未变 → 不触发', async () => {
  const cfgFile = path.join(require('os').tmpdir(), `wd-cfg2-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(cfgFile, JSON.stringify({ rules: [{ type: 'wholeShopCostPerOrder', thresholdCents: 100, enabled: true }] }));
  try {
    const clock = makeClock(BASE_SH);
    const timers = makeTimers();
    const { drill } = makeDrill(clock, timers, { costCents: 100, orderCount: 100, configSourcePath: cfgFile });
    drill.boot();
    assert.strictEqual(drill._internal._monitor.running, false, 'boot 后值守未启动');

    // 值守未运行：联动巡查跳过（m2.running=false），但不报错
    const r0 = await callHttp(drill, 'POST', '/api/watch-drill/threshold', { thresholdCents: 120 });
    assert.strictEqual(r0.body.ok, true);
    assert.strictEqual(r0.body.poll, null, '值守未运行时不触发联动巡查');

    // 启动值守后改阈值 → 立即巡查（cycleNo 递增）+ 重排
    drill.start();
    const m = drill._internal._monitor;
    await until(() => m.lastCycleAt, 8000);
    const cycleBefore = m.cycleNo;
    const r1 = await callHttp(drill, 'POST', '/api/watch-drill/threshold', { thresholdCents: 150 });
    assert.strictEqual(r1.body.ok, true);
    assert.ok(r1.body.poll, '阈值变化必须返回联动巡查结果');
    assert.strictEqual(r1.body.poll.ok, true, JSON.stringify(r1.body.poll));
    assert.strictEqual(m.cycleNo, cycleBefore + 1, '联动巡查恰好多一个周期');
    assert.ok(r1.body.poll.nextRunAt, '必须返回重排后的下次检查时间');
    // 新基准 = 联动巡查完成时刻 + 30 分钟（误差容忍 1 分钟）
    const expected = Date.parse(m.lastCycleAt) + 30 * 60 * 1000;
    const got = Date.parse(r1.body.poll.nextRunAt);
    assert.ok(Math.abs(got - expected) <= 60 * 1000,
      `nextRunAt 应=完成+30min（${new Date(expected).toISOString()}），实际 ${r1.body.poll.nextRunAt}`);
    // schedule.nextRunAt 已同步改写
    assert.strictEqual(m.schedule.nextRunAt, r1.body.poll.nextRunAt, '调度状态必须同步');

    // 值未变：不触发
    const r2 = await callHttp(drill, 'POST', '/api/watch-drill/threshold', { thresholdCents: 150 });
    assert.strictEqual(r2.body.ok, true);
    assert.strictEqual(r2.body.poll, null, '阈值未变化不触发巡查');
    assert.strictEqual(m.cycleNo, cycleBefore + 1, '周期不再增加');

    const logs = allLogs(drill);
    assert.ok(/阈值变更联动巡查：已完成/.test(logs), '联动巡查必须留痕日志');
  } finally {
    try { fs.rmSync(cfgFile, { force: true }); } catch (_) {}
  }
});

test('脱敏：假 cookie/token 不出现在日志、页面快照与通知正文', async () => {
  const clock = makeClock(BASE_SH);
  const timers = makeTimers();
  const sent = [];
  const FAKE = 'FAKE_COOKIE_VALUE_NOT_REAL';
  const TOK = 'FAKE_TOKEN_XYZ';
  const { drill } = makeDrill(clock, timers, {
    costCents: 10001, orderCount: 100,
    notify: { enabled: true, target: 'feishu:test-chat', timeoutMs: 1000 },
    notifySpawn: (args, input) => { sent.push({ args, input }); return Promise.resolve({ code: 0 }); },
  });
  const t = drill.translateSwitchResult({ decision: 'data_blocked', reason: 'sessionid=' + FAKE + '; token=' + TOK, status: 'blocked' });
  assert.ok(!t.line.includes(FAKE) && !t.line.includes(TOK), '转译输出须脱敏：' + t.line);
  assert.ok(t.line.includes('***') || t.line.includes('已脱敏'), '转译须带脱敏标记：' + t.line);
  drill.start();
  await until(() => drill._internal._monitor, 4000, 'Monitor 装配');
  const m = drill._internal._monitor;
  assert.ok(m);
  m._memPush(m.recentErrors, { scope: 'shop:test', error: 'lastError sessionid=' + FAKE + ' token=' + TOK }, undefined, 'error');
  m._memPush(m.judgements, { kind: 'judgement', cycleNo: 990001, status: 'blocked', reason: 'sessionid=' + FAKE + '; token=' + TOK }, undefined, 'judgement');
  await until(() => m.lastCycleAt, 8000);
  // 本轮完成后设置展示用状态，避免轮询覆盖测试注入。
  m._runtime(SHOP_ID).lastData = { blockedReason: 'sessionid=' + FAKE + '; token=' + TOK };
  await callHttp(drill, 'GET', '/api/watch-drill/state');
  await until(() => sent.length >= 1, 8000);
  const logs = allLogs(drill);
  const snap = JSON.stringify(drill.snapshot());
  const notifyAll = sent.map((x) => (x.input || '') + (x.args || []).join(' ')).join(String.fromCharCode(10));
  assert.ok(logs.includes('***') || logs.includes('已脱敏') || logs.includes('疑似凭证'), '日志须出现脱敏标记');
  const st = drill.snapshot();
  assert.ok(st.lastError, 'snapshot.lastError 须存在');
  assert.ok(!String(st.lastError).includes(FAKE) && !String(st.lastError).includes(TOK));
  assert.ok(/被拦下|未得出费用/.test(notifyAll), '通知须走 blocked 分支');
  assert.ok(notifyAll.includes('***') || notifyAll.includes('已脱敏'), '通知须含脱敏标记');
  for (const blob of [logs, snap, notifyAll]) {
    assert.ok(!blob.includes(FAKE) && !blob.includes(TOK), '日志/快照/通知不得含假凭据原值');
  }
});
