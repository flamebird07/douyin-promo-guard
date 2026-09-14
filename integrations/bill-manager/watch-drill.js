'use strict';

/**
 * 推广值守演练（强制只读）—— 3443 电商助手「推广值守演练」Tab 的后端调度服务。
 *
 * 设计要点（第十轮接入，用户规则）：
 * - 独立强制演练入口：只评估「千川账户整体消耗」与「罗盘经营概况(全店+实时)成交订单数」，
 *   判定 费用整数分 > 订单数×100 才超标（恰好 1 元/单不超标）。
 *   本模块**不含任何广告操作代码路径**：不导入/不调用乘方执行器、广告控制器、开关、
 *   批量暂停、开启、删除。即使推广控制配置 realMode/pauseEnabled 为 true，本入口仍零广告操作。
 * - 后端调度：上海时间 08:00 后立即读取一次，此后每 30 分钟巡查；08:00 前等待到 08:00；
 *   跨日按既有规则（推广控制 src/lib/time.js nextIntervalDelayMs）处理。
 *   调度在 3443 进程内（setTimeout 链），不依赖浏览器 Tab；刷新/切换 Tab/关闭页面不重复
 *   启动也不停止后台值守；多页面观察同一实例。
 * - 幂等：重复 start() 不创建新循环；stop() 后不再安排下一轮，正在读取的任务按明确状态
 *   结束后停止（不误报立即停止）。
 * - 重启语义：服务重启后 running=false（默认未启动，页面如实显示）；日志有界持久化到
 *   JSONL 文件，页面重新打开可恢复查看。
 * - 单轮失败/读取超时不卡死调度：每轮读取有独立超时（默认 120s）；新读取开始前必须确认
 *   旧读取已结束或已取消释放（单一活跃读取守护），无法确认时本轮跳过并显示「等待旧读取结束」，
 *   仍安排下一轮——不重叠浏览器任务、不堆积任务、不静默停机。
 * - 日志安全：绝不记录 Cookie/令牌/敏感请求参数；统一 scrubbing；日志行上限 2000 字符。
 *
 * 数据读取复用（不重新实现抓取）：
 *   - createQianchuanCostReader   （推广控制 src/adapters/qianchuan-reader.js，千川首页账户整体消耗）
 *   - createCompassOrderReader    （推广控制 src/adapters/compass-order-reader.js，罗盘经营概况全店+实时）
 *   - guard 校验链                （推广控制 src/engine/guard.js：结构/身份/日期=当天/时效/同店同日）
 *   - evaluateWholeShopCostPerOrder（推广控制 src/engine/rules.js：整数分判定，不先四舍五入每单成本）
 */

const fs = require('fs');
const path = require('path');

const PROMO_GUARD_DIR = process.env.PROMO_GUARD_DIR || 'C:/Users/Administrator/Documents/ChatGPT/推广广告控制';
const promo = (rel) => require(path.join(PROMO_GUARD_DIR, rel));

const { shanghaiDate, shanghaiMs, shanghaiWall, shanghaiClockText, nextIntervalDelayMs } = promo('src/lib/time.js');
const { centsToYuan } = promo('src/lib/money.js');

const STATUS_TEXT = {
  idle: '未启动',
  reading: '读取中',
  waiting: '等待下一轮',
  waiting08: '等待08:00',
  failed: '读取失败',
};

// 敏感信息 scrubbing（与 server.js logToFile 同策略；日志永不写 Cookie 值）
// 注意：值匹配要求"不是中文开头"，避免把「Cookie 过期」这类正常说明文本整段吞掉；
// 只遮蔽紧随敏感键之后的令牌/路径型内容。
function scrub(msg) {
  let s = typeof msg === 'string' ? msg : String(msg);
  s = s
    .replace(/((?:cookie|token|secret|password|passwd|pwd|app_secret|api_key|apikey)[=:\s"']+)(?![\u4e00-\u9fff])([^\s"',}{]{6,})/gi, '$1***')
    .replace(/(Bearer\s+)(?![\u4e00-\u9fff])[^\s]{20,}/gi, '$1***');
  return s.replace(/[\r]/g, '').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '').slice(0, 2000);
}

function createWatchDrill(opts = {}) {
  const logLimit = opts.logLimit || 500;
  const readTimeoutMs = opts.readTimeoutMs || 120000;
  const prevGraceMs = opts.prevGraceMs || 15000;

  const drill = {
    shopName: opts.shopName || '瑾漂亮潮流服饰',
    forcedDrill: true,
    state: {
      running: false,
      status: 'idle',
      roundNo: 0,
      startedAt: null,
      stoppedAt: null,
      lastCheckAt: null,
      nextRunAt: null,
      lastError: null,
      lastRound: null,
    },
    _logs: [],
    _seq: 0,
    _timer: null,
    _cfg: null,
    _shop: null,
    _loaded: false,
    _prevRoundPromise: null,
    _activeReads: [],   // 单一活跃读取守护：{label, promise, cancel, settled, timedOut}；任一时刻最多一个未结束
    _now: opts.nowFn || (() => Date.now()),
    _delay: opts.delayFn || ((ms, cb) => setTimeout(cb, Math.max(0, ms))),
    _clearTimer: opts.cancelTimer || ((h) => { if (h) clearTimeout(h); }),
    _persistFile: opts.persistFile || null,
    _prevGraceMs: prevGraceMs,
    _readTimeoutMs: readTimeoutMs,
  };

  // ── 日志（内存有界 + JSONL 持久化）──────────────────────────────
  function restoreLogs() {
    try {
      const raw = fs.readFileSync(drill._persistFile, 'utf-8');
      const lines = raw.split(/\r?\n/).filter(Boolean).slice(-logLimit);
      for (const ln of lines) {
        const e = JSON.parse(ln);
        if (e && typeof e.seq === 'number' && typeof e.msg === 'string') {
          drill._logs.push({ seq: e.seq, t: e.t, level: e.level || 'info', msg: e.msg });
        }
      }
      drill._seq = drill._logs.reduce((m, l) => Math.max(m, l.seq), 0);
    } catch (_) { /* 无文件/损坏：从空日志开始，不阻塞 */ }
  }
  if (drill._persistFile) restoreLogs();

  function pushLog(level, msg) {
    drill._seq += 1;
    const e = { seq: drill._seq, t: new Date(drill._now()).toISOString(), level, msg: scrub(msg) };
    drill._logs.push(e);
    if (drill._logs.length > logLimit) drill._logs.splice(0, drill._logs.length - logLimit);
    if (drill._persistFile) {
      try {
        fs.appendFileSync(drill._persistFile, JSON.stringify(e) + '\n');
        const st = fs.statSync(drill._persistFile);
        if (st.size > 512 * 1024) {
          const keep = fs.readFileSync(drill._persistFile, 'utf-8').split(/\r?\n/).filter(Boolean).slice(-1000);
          fs.writeFileSync(drill._persistFile, keep.join('\n') + '\n');
        }
      } catch (_) { /* 持久化失败不影响运行 */ }
    }
    return e;
  }

  // ── 配置与读取器（复用推广控制已验证实现）────────────────────────
  function ensureLoaded() {
    if (drill._loaded) return;
    let cfg;
    if (opts.config) {
      cfg = opts.config;
    } else {
      const { loadConfig } = promo('src/config.js');
      const r = loadConfig();
      if (r.pending.length > 0) throw new Error(`推广控制配置不完整：${r.pending.join('；')}`);
      cfg = r.config;
    }
    const shop = opts.shopCfg || (Array.isArray(cfg.shops) && cfg.shops[0]);
    if (!shop || !shop.id) throw new Error('配置缺少目标店铺（shops 为空或缺少 id）');
    drill._cfg = cfg;
    drill._shop = shop;
    drill.shopName = shop.name || shop.id;
    drill._loaded = true;
  }

  function makeReaders() {
    if (opts.readers) return opts.readers;
    const loginCfg = drill._cfg.login;
    const nowFn = drill._now;
    const qc = promo('src/adapters/qianchuan-reader.js');
    const compass = promo('src/adapters/compass-order-reader.js');
    return {
      costReader: qc.createQianchuanCostReader({ loginCfg, nowFn }),
      orderReader: compass.createCompassOrderReader({ loginCfg, nowFn }),
    };
  }

  // ── 调度 ───────────────────────────────────────────────────────
  function scheduleNext(lastRunMs, lastFailed) {
    drill._clearTimer(drill._timer);
    drill._timer = null;
    const st = drill.state;
    if (!st.running) {
      st.status = 'idle';
      st.nextRunAt = null;
      return;
    }
    const nowMs = drill._now();
    const cfg = drill._cfg || {};
    const startHour = (cfg.schedule && cfg.schedule.dailyStartHour) || 8;
    const interval = (cfg.schedule && cfg.schedule.intervalMinutes) || 30;
    const wall = shanghaiWall(nowMs);
    if (wall.hour < startHour) {
      // 08:00 前：等待到当日 08:00
      const target = shanghaiMs(wall.date, `${String(startHour).padStart(2, '0')}:00`);
      st.status = lastFailed ? 'failed' : 'waiting08';
      st.nextRunAt = new Date(target).toISOString();
      drill._timer = drill._delay(Math.max(0, target - nowMs), fireRound);
      return;
    }
    if (!lastRunMs) {
      // 启动即读取一次（08:00 后）
      st.status = 'reading';
      st.nextRunAt = null;
      drill._timer = null;
      runRound().catch((e) => pushLog('error', `值守轮次异常：${(e && e.message) || String(e)}`));
      return;
    }
    const n = nextIntervalDelayMs(nowMs, lastRunMs, interval, startHour);
    st.nextRunAt = new Date(n.nextRunAt).toISOString();
    st.status = lastFailed ? 'failed' : (n.crossDay ? 'waiting08' : 'waiting');
    drill._timer = drill._delay(n.delayMs, fireRound);
  }

  function fireRound() {
    runRound().catch((e) => pushLog('error', `值守轮次异常：${(e && e.message) || String(e)}`));
  }

  // ── 单一活跃读取守护（修复超时重叠）──────────────────────────
  // 旧读取（含已超时但未结束、浏览器未确认释放）未结束前，禁止启动新读取；
  // 优先尝试取消并确认释放（读取任务可返回 {promise, cancel}），无法确认时
  // 本轮跳过并显示「等待旧读取结束」，仍安排下一轮——不重叠任务、不堆积、不静默停机。
  function pruneSettledReads() {
    drill._activeReads = drill._activeReads.filter((e) => !e.settled);
  }

  function allSettledSoon(entries, ms) {
    if (entries.length === 0) return Promise.resolve(true);
    const all = Promise.all(entries.map((e) => e.promise.catch(() => {}))).then(() => true);
    return Promise.race([
      all,
      new Promise((r) => setTimeout(() => r(false), Math.max(1, ms))),
    ]);
  }

  async function ensureNoPendingReads() {
    pruneSettledReads();
    if (drill._activeReads.length === 0) return true;
    // 1) 有界宽限等待旧读取自然结束
    if (await allSettledSoon(drill._activeReads, drill._prevGraceMs)) {
      pruneSettledReads();
      return true;
    }
    // 2) 尝试取消并等待确认释放；无取消能力的读取无法确认释放 → 本轮跳过
    const pending = drill._activeReads.filter((e) => !e.settled);
    const cancellable = pending.filter((e) => typeof e.cancel === 'function');
    for (const e of cancellable) {
      try { e.cancel(); } catch (_) { /* 取消失败按未释放处理 */ }
    }
    if (cancellable.length === 0) return false;
    if (await allSettledSoon(pending, drill._prevGraceMs)) {
      pruneSettledReads();
      return true;
    }
    return false;
  }

  // 受守护读取：启动前确认无未结束旧读取；task 为 Promise 或 {promise, cancel}。
  async function guardedRead(label, makeTask, ms) {
    if (!(await ensureNoPendingReads())) {
      const pend = drill._activeReads.filter((e) => !e.settled).map((e) => e.label).join('、');
      throw new Error(`等待旧读取结束：上一轮「${pend}」读取任务仍未结束（无法确认释放），本轮跳过读取`);
    }
    const raw = makeTask();
    const promise = (raw && typeof raw.then === 'function') ? raw : raw.promise;
    const cancel = (raw && typeof raw.cancel === 'function') ? raw.cancel.bind(raw) : null;
    const entry = { label, promise, cancel, settled: false, timedOut: false };
    drill._activeReads.push(entry);
    promise.then(
      () => { entry.settled = true; },
      () => { entry.settled = true; }
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        entry.timedOut = true;
        reject(new Error(`${label}超时（${Math.round(ms / 1000)} 秒），本轮无法判断`));
      }, ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }

  async function runRound() {
    if (!drill.state.running) return;
    const prev = drill._prevRoundPromise;
    drill._prevRoundPromise = runRoundBody(prev);
    await drill._prevRoundPromise;
  }

  async function runRoundBody(prev) {
    if (prev) await prev.catch(() => {});
    const st = drill.state;
    if (!st.running) return;
    st.status = 'reading';
    st.roundNo += 1;
    const roundNo = st.roundNo;
    const startedAt = drill._now();
    const bd = shanghaiDate(startedAt);
    pushLog('info', `── 轮次 ${roundNo} · ${shanghaiClockText(startedAt)} · 业务日期 ${bd} · 开始读取 ──`);

    const round = {
      roundNo, businessDate: bd, startedAt,
      finishedAt: null, durationMs: null, failed: false,
      conclusion: 'unknown', conclusionText: null, reason: null,
      costCents: null, costRaw: null, costFetchedAt: null,
      orders: null, ordersRaw: null, ordersFetchedAt: null,
      perOrderText: null,
    };

    try {
      ensureLoaded();
      // 登录态静态核验（不启动浏览器；失效/缺失即本轮无法判断）
      const cookieCheck = opts.cookieMetaCheck || promo('src/login/session.js').loadShopCookieMeta;
      cookieCheck(drill._cfg.login, drill._shop);

      const readers = makeReaders();

      // 1) 费用 = 千川账户整体消耗（账户整体，当天）
      const cost = await guardedRead('费用读取', () => readers.costReader.readCostSummary({ shopCfg: drill._shop }), drill._readTimeoutMs);
      round.costCents = cost.valueCents;
      round.costRaw = cost.rawText || String(cost.valueCents);
      round.costFetchedAt = cost.fetchedAt;
      pushLog('info', `费用=千川账户整体消耗：${centsToYuan(cost.valueCents)} 元（页面原始 ${JSON.stringify(round.costRaw)}，读取于 ${cost.fetchedAt}）`);

      // 2) 订单 = 罗盘经营概况「全店 + 实时」成交订单数
      const orders = await guardedRead('订单读取', () => readers.orderReader.readOrderSummary({ shopCfg: drill._shop }), drill._readTimeoutMs);
      round.orders = orders.valueCount;
      round.ordersRaw = orders.rawText || String(orders.valueCount);
      round.ordersFetchedAt = orders.fetchedAt;
      pushLog('info', `订单=罗盘经营概况（全店+实时）：${orders.valueCount} 单（页面原始 ${JSON.stringify(round.ordersRaw)}，读取于 ${orders.fetchedAt}）`);

      // 3) 数据可信校验（复用推广控制 guard 链；演练零操作，不设真实/演练来源之别，跳过 checkSourceAllowed）
      const guard = promo('src/engine/guard.js');
      const nowMs = drill._now();
      const maxAge = (drill._cfg.monitor && drill._cfg.monitor.snapshotMaxAgeMinutes) || 30;
      for (const [k, s, lab] of [['cost', cost, '全店推广费用'], ['orders', orders, '全店订单数']]) {
        guard.validateSummaryShape(s, lab);
        guard.checkSourceIdentity(s, drill._shop, lab);
        guard.checkBusinessDateToday(s, lab, nowMs);
        guard.checkFreshness(s.fetchedAt, maxAge, nowMs, lab);
      }
      guard.checkSameShopAndDate(cost, orders);

      // 4) 判定：费用整数分 > 订单数 × 阈值分 才超标（恰好相等不超标）
      const rule = (drill._cfg.rules || []).find((r) => r.type === 'wholeShopCostPerOrder' && r.enabled !== false);
      if (!rule) throw new Error('未找到启用的 wholeShopCostPerOrder 规则，无法判定');
      const threshold = rule.thresholdCents;

      if (orders.valueCount === 0) {
        const reason = cost.valueCents > 0
          ? '全店订单为 0 但推广费用大于 0：数据异常，无法按每单成本判断（需重读核实）'
          : '全店订单为 0：无法按每单成本判断';
        round.conclusion = 'unknown';
        round.conclusionText = '本轮无法判断';
        round.reason = reason;
        pushLog('warn', `本轮无法判断：${reason}（失败也记录下一轮安排，避免静默停机）`);
      } else {
        const { evaluateWholeShopCostPerOrder, perOrderDisplayText } = promo('src/engine/rules.js');
        const ev = evaluateWholeShopCostPerOrder({ costCents: cost.valueCents, orders: orders.valueCount, thresholdCents: threshold });
        round.perOrderText = perOrderDisplayText(cost.valueCents, orders.valueCount);
        const perApprox = (cost.valueCents / orders.valueCount / 100).toFixed(2);
        if (ev.over) {
          round.conclusion = 'over';
          round.conclusionText = '超标';
          round.reason = ev.reason;
          pushLog('warn',
            `费用${centsToYuan(cost.valueCents)}元，订单${orders.valueCount}单，每单约${perApprox}元；`
            + `${cost.valueCents}分 > ${orders.valueCount}×${threshold}分=${ev.expectedCents}分，超标；`
            + `应暂停乘方全店托管和商品自选，本轮未执行（仅演练，不操作广告）。`);
        } else {
          round.conclusion = 'under';
          round.conclusionText = '未超标';
          round.reason = ev.reason;
          pushLog('info',
            `费用${centsToYuan(cost.valueCents)}元，订单${orders.valueCount}单，每单约${perApprox}元；`
            + `${cost.valueCents}分 ≤ ${orders.valueCount}×${threshold}分=${ev.expectedCents}分，未超标。本轮仅演练，不暂停广告。`);
        }
      }
    } catch (e) {
      round.failed = true;
      round.reason = (e && e.message) || String(e);
      pushLog('error', `本轮无法判断：${round.reason}（失败也记录下一轮安排，避免静默停机）`);
    }

    round.finishedAt = drill._now();
    round.durationMs = round.finishedAt - startedAt;
    st.lastRound = round;
    st.lastCheckAt = new Date(round.finishedAt).toISOString();
    st.lastError = round.failed ? round.reason : null;

    // 安排下一轮（停止后不再安排；失败也记录下一轮，状态显示读取失败）
    scheduleNext(startedAt, round.failed);
    const nextTxt = st.nextRunAt ? shanghaiClockText(Date.parse(st.nextRunAt)) : null;
    if (!st.running) {
      st.status = 'idle';
      st.nextRunAt = null;
    }
    pushLog('info',
      st.running
        ? `本轮耗时 ${(round.durationMs / 1000).toFixed(1)} 秒；下次检查时间 ${nextTxt}`
        : `本轮耗时 ${(round.durationMs / 1000).toFixed(1)} 秒；值守已停止，不再安排下一轮`);
  }

  // ── 对外操作 ───────────────────────────────────────────────────
  function start() {
    const st = drill.state;
    if (st.running) return snapshot();
    try {
      ensureLoaded();
    } catch (e) {
      st.lastError = (e && e.message) || String(e);
      pushLog('error', `值守启动失败：${st.lastError}（不启动调度）`);
      return snapshot();
    }
    st.running = true;
    st.startedAt = new Date(drill._now()).toISOString();
    st.stoppedAt = null;
    st.lastError = null;
    pushLog('info', `值守启动（强制只读演练，不操作广告）· 店铺 ${drill.shopName}`);
    scheduleNext(null, false);
    return snapshot();
  }

  function stop() {
    const st = drill.state;
    if (!st.running) return snapshot();
    st.running = false;
    st.stoppedAt = new Date(drill._now()).toISOString();
    drill._clearTimer(drill._timer);
    drill._timer = null;
    if (st.status !== 'reading') {
      st.status = 'idle';
      st.nextRunAt = null;
    }
    pushLog('info', '值守停止：不再开始新一轮；正在读取的任务按明确状态结束后停止');
    return snapshot();
  }

  function snapshot() {
    const st = drill.state;
    return {
      shopName: drill.shopName,
      forcedDrill: true,
      running: st.running,
      status: st.status,
      statusText: STATUS_TEXT[st.status] || st.status,
      roundNo: st.roundNo,
      startedAt: st.startedAt,
      stoppedAt: st.stoppedAt,
      lastCheckAt: st.lastCheckAt,
      nextRunAt: st.nextRunAt,
      lastError: st.lastError,
      lastRound: st.lastRound,
    };
  }

  async function serveHttp(req, res) {
    const send = (code, obj) => {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (_) { return send(400, { error: 'URL 非法' }); }
    const p = url.pathname;
    try {
      if (p === '/api/watch-drill/start' && req.method === 'POST') return send(200, { ok: true, state: start() });
      if (p === '/api/watch-drill/stop' && req.method === 'POST') return send(200, { ok: true, state: stop() });
      if (p === '/api/watch-drill/state' && req.method === 'GET') return send(200, { ok: true, state: snapshot() });
      if (p === '/api/watch-drill/logs' && req.method === 'GET') {
        const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
        const logs = drill._logs.filter((l) => l.seq > since);
        return send(200, { ok: true, seq: drill._seq, logs });
      }
      return send(404, { error: 'Not Found' });
    } catch (e) {
      return send(500, { error: String((e && e.message) || e).slice(0, 200) });
    }
  }

  return {
    start,
    stop,
    snapshot,
    serveHttp,
    get state() { return drill.state; },
    get logs() { return drill._logs.slice(); },
    _internal: drill,
  };
}

module.exports = { createWatchDrill, STATUS_TEXT, scrub };
