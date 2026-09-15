'use strict';

/**
 * 推广值守 —— 3443 电商助手「推广值守」Tab 的后端调度服务（2026-09-15 接入真实操作模式）。
 *
 * 用户规则（唯一目标）：
 *   1) 每天 07:00 开启全部乘方计划（全店托管 + 商品自选，含昨日暂停的全部计划）；
 *   2) 08:00 后每 30 分钟检查：当天「账户整体消耗」÷ 当天「全店订单数」**严格超过** 1 元/单
 *      （整数分判定：费用分 > 订单数×100，恰好相等不暂停）时暂停乘方；
 *   3) 绝不删除广告；
 *   4) 界面日志必须包含：开启、判断数据、暂停、重试、回读、失败原因。
 *
 * 实现要点：
 * - **不重新实现业务逻辑**：本模块只做「进程内装配 + 日志转译 + HTTP 暴露」。
 *   调度、门槛、乘方读写、回读核验、有限重试全部复用推广控制项目已验证的
 *   `src/engine/monitor.js`（Monitor）、`src/engine/chengfang-runner.js`、
 *   `src/engine/chengfang-executor.js`。这样 3443 与 CLI 使用同一份经过测试的链路，
 *   不会出现"两份实现互相漂移"。
 * - 真实执行的最终开关仍在推广控制 `config.json`：
 *   `execution.realMode` + `monitor.chengfang.pauseEnabled` / `enableEnabled`
 *   （fail-closed：任一不满足即不会发出真实广告操作，日志会如实说明被哪一道门槛拦住）。
 *   本模块**不提供**任何绕过这些门槛的入口。
 * - 调度在 3443 进程内（Monitor 的 `_intervalLoop`，setTimeout 链），不依赖浏览器 Tab；
 *   刷新/切换 Tab/关闭页面既不重复启动也不停止后台值守；多页面观察同一实例。
 * - 重启语义：服务重启后默认未启动（页面如实显示）；日志有界持久化到 JSONL。
 * - 日志安全：绝不记录 Cookie/令牌/敏感请求参数；统一 scrubbing；单行上限 2000 字符。
 */

const fs = require('fs');
const path = require('path');

const PROMO_GUARD_DIR = process.env.PROMO_GUARD_DIR || 'C:/Users/Administrator/Documents/ChatGPT/推广广告控制';
const promo = (rel) => require(path.join(PROMO_GUARD_DIR, rel));

const { shanghaiDate, shanghaiClockText } = promo('src/lib/time.js');
const { centsToYuan } = promo('src/lib/money.js');

const STATUS_TEXT = {
  idle: '未启动',
  reading: '检查中',
  waiting: '等待下一轮',
  waiting08: '等待下一轮',
  waiting_window: '等待每日窗口',
  enable_window: '每日开启中',
  failed: '检查失败',
  stopped: '已停止',
  blocked: '已阻塞',
};

// ── 敏感信息 scrubbing（与 server.js 同策略；日志永不写 Cookie 值）────────────
// 值匹配要求"不是中文开头"，避免把「Cookie 过期」这类正常说明文本整段吞掉。
function scrub(msg) {
  let s = typeof msg === 'string' ? msg : String(msg);
  s = s
    .replace(/((?:cookie|token|secret|password|passwd|pwd|app_secret|api_key|apikey)[=:\s"']+)(?![\u4e00-\u9fff])([^\s"',}{]{6,})/gi, '$1***')
    .replace(/(Bearer\s+)(?![\u4e00-\u9fff])[^\s]{20,}/gi, '$1***');
  return s.replace(/[\r]/g, '').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '').slice(0, 2000);
}

function createWatchDrill(opts = {}) {
  const logLimit = opts.logLimit || 800;

  const drill = {
    shopName: opts.shopName || '—',
    // 兼容字段：不再有"强制只读演练"语义（2026-09-15 起接入真实操作模式）
    realMode: false,
    state: {
      running: false,
      status: 'idle',
      roundNo: 0,
      startedAt: null,
      stoppedAt: null,
      lastCheckAt: null,
      nextRunAt: null,
      lastError: null,
      lastRound: null,       // 转译后的最近一轮（供界面展示）
      gates: null,           // 真实执行门槛快照（界面必须让用户看到是否真的会操作广告）
      phase: null,           // Monitor 调度相位
      windowBlockReason: null,
      enablePhaseToday: [],
    },
    _logs: [],
    _seq: 0,
    _persistFile: opts.persistFile || null,
    _now: opts.nowFn || (() => Date.now()),
    _monitor: null,
    _unsubscribe: null,
    // ── 增量游标（2026-09-15 修复第 1 项）──────────────────────────────
    // 旧行为：`_lastActionsSeen = list.length` 这类**基于有界数组长度**的游标。
    // 数组会被 Monitor 裁剪（长度封顶），一旦被裁剪，`list.length` 不再增长，
    // 游标永远停在旧长度 → 新事件**永久漏日志**，或索引整体前移导致**重复日志**。
    // 修复：改用 Monitor 提供的单调递增 `evtSeq`，与数组长度完全解耦。
    _lastEvtSeq: 0,
    _lastCycleNo: 0,
    _lastJudgementCycleNo: 0,
    _lastEnableSeen: {},
  };

  // ── 日志（内存有界 + JSONL 持久化）────────────────────────────────────────
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

  // ── 真实执行门槛快照（fail-closed 依据；界面必须可见）─────────────────────
  /**
   * 计算门槛快照（2026-09-15 修复第 6 项）。
   *
   * 旧行为：`gates` 只在 `ensureMonitor()` 装配时取一次，之后**永不更新**。
   * 结果是：运行中把 `realMode`/`pauseEnabled`/`enableEnabled` 改掉后，
   * 页面仍然显示旧的"会执行/不会执行"，与实际执行条件**不一致**——
   * 用户可能以为不会操作广告（实际会），或以为会操作（实际被拦住）。
   *
   * 修复：每次轮询 state 时**重新读取当前 Monitor 配置**（含实时 `realMode`），
   * 保证展示门槛 === 实际 gate。fail-closed：不做任何缓存上的乐观推断。
   */
  function computeGates() {
    const m = drill._monitor;
    const cfg = (m && m.config) || {};
    const cf = (cfg.monitor && cfg.monitor.chengfang) || {};
    // 真实模式以 Monitor 的实时 getter 为准（而非装配时的快照）
    const realMode = m ? m.realMode === true : (cfg.execution && cfg.execution.realMode === true);
    const pauseEnabled = cf.pauseEnabled === true;
    const enableEnabled = cf.enableEnabled === true;
    return {
      realMode,
      pauseEnabled,
      enableEnabled,
      scope: Array.isArray(cf.scope) ? cf.scope.slice() : [],
      enableHour: Number.isInteger(cf.enableHour) ? cf.enableHour : 7,
      dailyStartHour: (cfg.schedule && cfg.schedule.dailyStartHour) || 8,
      intervalMinutes: (cfg.schedule && cfg.schedule.intervalMinutes) || 30,
      // 真实暂停/开启是否**当前**会落地（两个开关同时为真）
      pauseWillExecute: realMode && pauseEnabled,
      enableWillExecute: realMode && enableEnabled,
      deleteAdEnabled: false, // 常量：本系统不存在删除广告的代码路径
    };
  }

  /** 运行中配置变更 → 立即刷新门槛并记一条"门槛变化"日志（界面/审计可见）。 */
  function refreshGates() {
    const next = computeGates();
    const prev = drill.state.gates;
    drill.state.gates = next;
    if (prev && (prev.realMode !== next.realMode
      || prev.pauseEnabled !== next.pauseEnabled
      || prev.enableEnabled !== next.enableEnabled
      || prev.pauseWillExecute !== next.pauseWillExecute
      || prev.enableWillExecute !== next.enableWillExecute)) {
      pushLog('warn',
        `门槛已变化（运行中配置变更）：realMode=${next.realMode} / 暂停开关=${next.pauseEnabled} / 开启开关=${next.enableEnabled}`
        + `；真实暂停${next.pauseWillExecute ? '会执行' : '不会执行'}，真实开启${next.enableWillExecute ? '会执行' : '不会执行'}。`);
    }
    return next;
  }

  // ── Monitor 装配（延迟到首次 start，避免加载即触网/建状态）────────────────
  function ensureMonitor() {
    if (drill._monitor) return drill._monitor;
    const { Monitor } = promo('src/engine/monitor.js');
    let cfgResult;
    if (opts.config) {
      // 测试注入：直接使用给定配置，不读磁盘
      cfgResult = { config: opts.config, pending: opts.pending || [], ready: true, sourcePath: opts.configSourcePath || 'injected' };
    } else {
      const { loadConfig } = promo('src/config.js');
      const r = loadConfig();
      // pending 非空时 Monitor.start() 会自行拒绝；此处不提前抛错，
      // 让界面能如实展示"配置不完整"的具体原因。
      cfgResult = { config: r.config, pending: r.pending, ready: r.ready, sourcePath: r.sourcePath };
    }

    const monitor = new Monitor(cfgResult, opts.adapters || null, {
      dataDir: opts.dataDir || path.join(PROMO_GUARD_DIR, 'data'),
      nowFn: opts.nowFn || undefined,
      delayFn: opts.delayFn || undefined,
      chengfangOpener: opts.chengfangOpener || undefined,
    });
    drill._monitor = monitor;
    drill.shopName = (cfgResult.config.shops || []).map((s) => s.name || s.id).join('、') || '—';
    drill.realMode = monitor.realMode === true;

    // 门槛快照（fail-closed 依据；界面必须可见；此后每轮 refreshGates 重读）
    const g = refreshGates();
    pushLog('info',
      `值守装配完成 · 店铺 ${drill.shopName} · 模式：${monitor.realMode ? '真实执行' : '演练模式（不操作广告）'}`);
    pushLog('info',
      `门槛：realMode=${g.realMode} / 暂停开关=${g.pauseEnabled} / 开启开关=${g.enableEnabled}`
      + `；真实暂停${g.pauseWillExecute ? '会执行' : '不会执行'}，真实开启${g.enableWillExecute ? '会执行' : '不会执行'}`
      + `；控制范围=${g.scope.join('+') || '（未配置）'}；删除广告=永不执行。`);
    return monitor;
  }

  // ── Monitor → 日志转译（消费单调 evtSeq 事件流；含重试与回读）────────────
  // Monitor 内部已把每次真实批次结果写入 actions（含 counts/outcome/confirmReason/
  // remaining/details/actionType），这里只做**展示转译**，不改变任何执行语义。
  //
  // 2026-09-15 修复第 4 项：动作类型只认**显式字段** `actionType`/`action`。
  // 旧行为：`/enable/i.test(String(a.outcome || ''))` —— 用结果文本反推动作类型，
  // 于是 outcome 里只要出现 "enable" 字样就被判为"开启"，反之一切归为"暂停"。
  // 后果：**部分开启、开启失败、每日开启演练**会被误写成"暂停"（危险误导：
  // 用户以为系统在暂停广告，实际在开启）。修复后 `unknown` 如实报"未知"，
  // 绝不用文本猜测替代真实字段。
  const ACTION_LABEL = { pause: '暂停', enable: '开启', unknown: '未知动作' };
  function actionKindOf(a) {
    const raw = a && (a.actionType || a.action);
    return (raw === 'pause' || raw === 'enable') ? raw : 'unknown';
  }

  function describeBatch(a, kind) {
    const isPause = kind === 'pause';
    const isEnable = kind === 'enable';
    const counts = a.counts || {};
    const bits = [];
    if (counts.confirmed !== undefined) bits.push(`已确认 ${counts.confirmed}`);
    if (counts.failed !== undefined) bits.push(`失败 ${counts.failed}`);
    if (counts.unknown !== undefined) bits.push(`未知 ${counts.unknown}`);
    if (counts.skipped !== undefined) bits.push(`跳过 ${counts.skipped}`);
    if (a.remaining && typeof a.remaining.total === 'number') {
      bits.push(isPause ? `仍未暂停 ${a.remaining.total}` : (isEnable ? `仍未开启 ${a.remaining.total}` : `仍未落地 ${a.remaining.total}`));
    }
    const targetIds = Array.isArray(a.targets) ? a.targets : [];
    // 动作标签：显式字段优先；未知则如实标注（绝不按 outcome 文本猜测）
    const label = ACTION_LABEL[kind] || '未知动作';
    const verb = kind === 'unknown' ? '将操作' : `将${label}`;
    return `${label}批次结果：${a.outcome || 'unknown'}（${bits.join('，') || '无明细'}）`
      + `；目标 ${targetIds.length} 条${targetIds.length ? `（ID ${targetIds.slice(0, 5).join(',')}${targetIds.length > 5 ? '…' : ''}）` : ''}`
      + (isPause || isEnable ? `；本次动作=${label}` : `；本次动作=未知（actionType 未提供，未按结果文本猜测）`)
      + (a.confirmReason ? `；回读核验：${a.confirmReason}` : '')
      + (a.error ? `；失败原因：${a.error}` : '')
      + (kind === 'unknown' ? '' : `；${verb}，系统绝不删除广告。`);
  }

  /** 判断事件（判定 + 应执行的判断；来自 Monitor.judgements，每个巡查周期一条）。 */
  function describeJudgement(j) {
    const cost = j.costCents;
    const orders = j.orders;
    const thr = j.thresholdCents;
    const head = `第 ${j.cycleNo} 轮判断数据（周期 ${j.cycleNo}${j.trigger ? ` / ${j.trigger}` : ''}）：`;
    if (j.status === 'blocked') {
      return head + `本轮判断被拦下，未得出费用/订单结论；原因：${j.reason || '未知'}`;
    }
    const perOrder = j.perOrderText ? `，每单 ${j.perOrderText}` : '';
    const body = `费用 ${centsToYuan(cost)} 元（${cost} 分），订单 ${orders} 单${perOrder}`;
    if (j.over === true) {
      return head + `${body}；整数分判定 ${cost} 分 > ${orders}×${thr} 分（阈值 ${centsToYuan(j.expectedCents)} 元）→ 超标，应暂停乘方。`
        + (j.reason ? `；${j.reason}` : '');
    }
    return head + `${body}；整数分判定 ${cost} 分 ≤ ${orders}×${thr} 分（阈值 ${centsToYuan(j.expectedCents)} 元）→ 未超标，不暂停乘方。`;
  }

  /** 命中事件（演练枚举 / 真实触发）。 */
  function describeTrigger(t) {
    if (t.failed) {
      return `命中处理失败：${t.reason || '未知原因'}${t.dryOutcome ? `（${t.dryOutcome}）` : ''}`;
    }
    if (t.mode === 'dry') {
      return `命中（演练）：费用 ${t.costText}，订单 ${t.orders} 单，`
        + `将暂停 ${t.targetCount || 0} 条乘方计划（演练不点击）${t.note ? `；${t.note}` : ''}`;
    }
    return `命中（真实）：费用 ${t.costText}，订单 ${t.orders} 单，`
      + `目标 ${t.targetCount || 0} 条乘方计划${t.note ? `；${t.note}` : ''}`;
  }

  /** 错误事件（失败原因，界面必须可见）。 */
  function describeError(e) {
    return `失败原因：${e.error}${e.code ? ` [${e.code}]` : ''}${e.scope ? `（${e.scope}）` : ''}`;
  }

  /**
   * 增量同步（2026-09-15 修复第 1/2/3/4 项）。
   *
   * 游标使用 Monitor 的**单调递增 `evtSeq`**，与有界数组长度完全无关：
   *   - 即使 triggers/actions/recentErrors/judgements 被裁剪，新事件仍能持续接收；
   *   - 若在两次轮询之间发生了超出缓存的裁剪（丢了事件），依据 `dropped`
   *     记录一条**明确的日志缺口**，并继续同步，而不是永久漏日志或静默错位。
   */
  function syncFromMonitor() {
    const m = drill._monitor;
    if (!m) return;
    const st = drill.state;

    try {
      // 0) 门槛每次轮询重读（运行中配置变更 → 界面立即反映；fail-closed）
      refreshGates();

      const status = m.getStatus();

      // 1) 调度相位 / 下次执行 / 今日开启相位
      st.phase = status.monitor.phase;
      st.nextRunAt = status.monitor.nextRunAt;
      st.windowBlockReason = status.monitor.windowBlockReason;
      st.lastCheckAt = status.monitor.lastCycleAt;
      st.enablePhaseToday = status.monitor.enablePhaseToday || [];
      st.running = m.running === true;
      // roundNo 取 Monitor 的真实周期号（每个完整 pollOnce 递增一次）
      const mCycleNo = (status.monitor && status.monitor.cycleNo) || m.cycleNo || 0;
      if (typeof mCycleNo === 'number' && mCycleNo >= 0) st.roundNo = mCycleNo;
      if (st.running) {
        st.status = (status.monitor.phase === 'enable_window') ? 'enable_window'
          : (status.monitor.phase === 'waiting_window' ? 'waiting' : 'reading');
      } else if (st.status !== 'reading') {
        st.status = 'idle';
      }

      // 2) 最近一轮展示数据（判断日志统一由事件流产出，这里不再按"数据变化"记日志）
      const shop = (status.shops || [])[0];
      if (shop && shop.today) {
        const d = shop.today;
        st.lastRound = {
          roundNo: st.roundNo,
          businessDate: d.businessDate,
          costCents: d.costCents,
          costRaw: d.rawCostText,
          costText: d.costText,
          orders: d.orders,
          perOrderText: d.perOrderText,
          over: d.over === true,
          conclusion: d.over === true ? 'over' : 'under',
          conclusionText: d.over === true ? '超标' : '未超标',
          reason: d.blockedReason || null,
          fetchedAt: d.fetchedAt,
          pageUpdatedAt: d.pageUpdatedAt,
        };
        st.lastError = d.blockedReason || null;
      } else {
        st.lastError = st.lastRound && st.lastRound.reason ? st.lastRound.reason : null;
      }

      // 3) 事件流增量消费（唯一入口；游标 = evtSeq）
      const stream = (typeof m.getEventStream === 'function')
        ? m.getEventStream(drill._lastEvtSeq)
        : null;

      if (stream) {
        // 3a) 缺口先报：两次轮询之间被裁剪掉的事件必须**明确记录**，随后继续同步
        if (stream.droppedCount > 0) {
          const ranges = stream.dropped
            .map((d) => `${d.firstSeq}-${d.lastSeq}（${d.count} 条）`)
            .join('、');
          pushLog('warn',
            `日志缺口：上次同步后事件缓存发生裁剪，共丢失 ${stream.droppedCount} 条事件（序号 ${ranges}）；`
            + `后续事件继续同步，如需完整历史请查阅审计文件。`);
        }

        for (const evt of stream.events) {
          if (!evt || typeof evt.evtSeq !== 'number') continue;
          if (evt.evtSeq <= drill._lastEvtSeq) continue; // 幂等：绝不重复
          // 分类必须按**显式结构字段**判定，顺序为先具体后宽泛；
          // 注意：批次结果里 `error: null` 是合法值，不能用 `!== undefined` 误判为错误事件。
          const isJudgement = evt.kind === 'judgement';
          const isBatch = !isJudgement && (
            evt.actionType !== undefined || evt.action !== undefined
            || evt.outcome !== undefined || evt.counts !== undefined
            || evt.allPausedConfirmed !== undefined || evt.allEnabledConfirmed !== undefined
            || evt.allClosedConfirmed !== undefined
          );
          const isTrigger = !isJudgement && !isBatch && (
            evt.mode !== undefined || evt.failed !== undefined
            || evt.costText !== undefined || evt.targetCount !== undefined
          );
          const isError = !isJudgement && !isBatch && !isTrigger && typeof evt.error === 'string';

          if (isJudgement) {
            // 每个完整周期一条；超出缓存后仍能继续接收（evtSeq 游标）
            pushLog(evt.over === true ? 'warn' : 'info', describeJudgement(evt));
          } else if (isBatch) {
            // 批次结果事件（重试/回读结论随 outcome/confirmReason/remaining 一并进入日志）
            const kind = actionKindOf(evt);
            const ok = evt.allClosedConfirmed === true || evt.allPausedConfirmed === true
              || evt.allEnabledConfirmed === true || evt.outcome === 'ok';
            pushLog(ok ? 'info' : 'warn', describeBatch(evt, kind));
          } else if (isTrigger) {
            pushLog(evt.failed ? 'error' : (evt.mode === 'dry' ? 'info' : 'warn'), describeTrigger(evt));
          } else if (isError) {
            pushLog('error', describeError(evt));
          }
          drill._lastEvtSeq = evt.evtSeq;
        }
        // 即使本轮 events 为空，也要推进游标到当前最大序号（防止后续 dropped 判定错位）
        if (typeof stream.seq === 'number' && stream.seq > drill._lastEvtSeq
          && stream.events.length === 0) {
          drill._lastEvtSeq = stream.seq;
        }
      } else {
        // 兼容旧 Monitor（无事件流）：退化为按数组消费，并在日志中明确说明局限
        legacySyncByArray(status);
      }

      // 4) 开启相位状态变化（每次改为记一条，含失败/未知原因）
      for (const item of st.enablePhaseToday || []) {
        const rec = item.record || {};
        const key = `${item.shopId}:${rec.at || ''}`;
        if (drill._lastEnableSeen[item.shopId] === key) continue;
        drill._lastEnableSeen[item.shopId] = key;
        const label = { in_progress: '开启执行中', success: '开启成功', failed: '开启失败', unknown: '开启结果未知（需回读）', dry_done: '开启（演练，未点击）' }[rec.status] || rec.status;
        const lvl = rec.status === 'success' ? 'info' : (rec.status === 'failed' ? 'error' : (rec.status === 'unknown' ? 'warn' : 'info'));
        pushLog(lvl, `每日开启相位：${label}（店铺 ${item.shopId}，日期 ${rec.date || '—'}${rec.phase ? `，阶段 ${rec.phase}` : ''}）`
          + (rec.reason ? `；说明：${rec.reason}` : ''));
      }
    } catch (e) {
      pushLog('error', `状态同步异常：${(e && e.message) || String(e)}`);
    }
  }

  /**
   * 兼容路径（旧 Monitor 无 getEventStream）：按数组尾部消费。
   * 明确声明局限：有界数组被裁剪时可能漏事件——这也是必须升级 Monitor 的原因。
   */
  function legacySyncByArray(status) {
    const _harvest = (arr) => {
      const list = Array.isArray(arr) ? arr.slice().reverse() : [];
      return list;
    };
    const trig = _harvest(status.triggers);
    for (let i = drill._lastTriggersSeenLegacy || 0; i < trig.length; i += 1) {
      const t = trig[i];
      if (t) pushLog(t.failed ? 'error' : (t.mode === 'dry' ? 'info' : 'warn'), describeTrigger(t));
    }
    drill._lastTriggersSeenLegacy = trig.length;
    const acts = _harvest(status.actions);
    for (let i = drill._lastActionsSeenLegacy || 0; i < acts.length; i += 1) {
      const a = acts[i];
      if (!a) continue;
      const kind = actionKindOf(a);
      const ok = a.allClosedConfirmed === true || a.allPausedConfirmed === true || a.allEnabledConfirmed === true;
      pushLog(ok ? 'info' : 'warn', describeBatch(a, kind));
    }
    drill._lastActionsSeenLegacy = acts.length;
    const errs = _harvest(status.recentErrors);
    for (let i = drill._lastErrorSeenLegacy || 0; i < errs.length; i += 1) {
      const e = errs[i];
      if (e) pushLog('error', describeError(e));
    }
    drill._lastErrorSeenLegacy = errs.length;
    pushLog('warn', '当前 Monitor 未提供事件流（evtSeq）；已退化为按有界数组消费，可能漏事件。');
  }

  // ── 对外操作 ─────────────────────────────────────────────────────────────
  function start() {
    const st = drill.state;
    if (st.running && drill._monitor && drill._monitor.running) {
      pushLog('info', '值守已在运行，忽略重复启动（不叠加调度循环）');
      return snapshot();
    }
    let monitor;
    try {
      monitor = ensureMonitor();
    } catch (e) {
      st.lastError = (e && e.message) || String(e);
      pushLog('error', `值守启动失败：${st.lastError}（不启动调度）`);
      return snapshot();
    }
    const r = monitor.start();
    if (r && r.ok === false) {
      st.lastError = r.reason;
      pushLog('error', `值守启动被拒：${r.reason}`);
      return snapshot();
    }
    if (r && r.alreadyRunning) {
      pushLog('info', '值守已在运行，忽略重复启动（不叠加调度循环）');
    } else {
      st.startedAt = new Date(drill._now()).toISOString();
      st.stoppedAt = null;
      st.lastError = null;
      const g = st.gates || {};
      pushLog('info',
        `值守启动 · 店铺 ${drill.shopName} · 模式：${monitor.modeLabel}；`
        + `每日 ${String(g.enableHour).padStart(2, '0')}:00 开启乘方，${String(g.dailyStartHour).padStart(2, '0')}:00 后每 ${g.intervalMinutes} 分钟检查；`
        + `规则：当天费用÷当天全店订单 严格超过 1 元/单（整数分 >）即暂停乘方；绝不删除广告。`);
    }
    syncFromMonitor();
    return snapshot();
  }

  function stop() {
    if (drill._monitor) {
      drill._monitor.stop();
      pushLog('info', '值守停止：不再开始新一轮；正在进行的操作按明确状态结束后停止（已发出的请求继续回读确认）');
    }
    const st = drill.state;
    st.running = false;
    st.stoppedAt = new Date(drill._now()).toISOString();
    st.status = 'idle';
    st.nextRunAt = null;
    return snapshot();
  }

  function snapshot() {
    const st = drill.state;
    if (drill._monitor) {
      try {
        st.businessDate = shanghaiDate(drill._now());
        st.clock = shanghaiClockText(drill._now());
      } catch (_) { /* 时钟异常不阻塞快照 */ }
    }
    const m = drill._monitor;
    return {
      shopName: drill.shopName,
      realMode: m ? m.realMode === true : drill.realMode,
      running: st.running,
      status: st.status,
      statusText: STATUS_TEXT[st.status] || st.status,
      roundNo: st.roundNo,
      cycleNo: m ? (m.cycleNo || 0) : 0,
      startedAt: st.startedAt,
      stoppedAt: st.stoppedAt,
      lastCheckAt: st.lastCheckAt,
      nextRunAt: st.nextRunAt,
      lastError: st.lastError,
      lastRound: st.lastRound,
      gates: st.gates,
      phase: st.phase,
      windowBlockReason: st.windowBlockReason,
      enablePhaseToday: st.enablePhaseToday,
      businessDate: st.businessDate || null,
      clock: st.clock || null,
      // 事件流游标（供界面/排障核对"日志是否真的连续"）
      evtSeq: m ? (m._evtSeq || 0) : 0,
      consumedEvtSeq: drill._lastEvtSeq,
    };
  }

  function latestGap() {
    // 供界面/排障查询：最近一次明确记录的日志缺口条数
    for (let i = drill._logs.length - 1; i >= 0; i -= 1) {
      const m = /日志缺口：.*共丢失 (\d+) 条事件/.exec(drill._logs[i].msg);
      if (m) return { at: drill._logs[i].t, droppedCount: Number(m[1]) };
    }
    return null;
  }

  /**
   * 危险确认弹窗的当前实测状态（2026-09-15 第 7 项）。
   * 开启（shop_enable / batch_enable）确认弹窗结构**尚未实测** →
   * 保守策略：出现任何未知确认弹窗一律阻断，绝不盲点"确定"。
   * 界面据此必须显示"阻断"而不是"会执行"。
   */
  const CONFIRM_DIALOG_MEASURED = {
    batch_pause: true,   // 实测「确定要暂停N条计划吗？」
    batch_enable: false, // 未实测 → 出现确认弹窗即阻断
    shop_disable: true,  // 实测「确定关闭乘方投放吗？」
    shop_enable: false,  // 未实测 → 出现确认弹窗即阻断
  };

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
      if (p === '/api/watch-drill/state' && req.method === 'GET') { syncFromMonitor(); return send(200, { ok: true, state: snapshot() }); }
      if (p === '/api/watch-drill/logs' && req.method === 'GET') {
        syncFromMonitor();
        const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
        const logs = drill._logs.filter((l) => l.seq > since);
        return send(200, {
          ok: true,
          seq: drill._seq,
          logs,
          gap: latestGap(),           // 明确的日志缺口（如发生过裁剪）
          evtSeq: drill._monitor ? (drill._monitor._evtSeq || 0) : 0,
          consumedEvtSeq: drill._lastEvtSeq,
          confirmDialogs: CONFIRM_DIALOG_MEASURED, // 未实测的确认弹窗仍为阻断
        });
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
    /** 显式同步（测试/调试用；HTTP 各接口内部已自动调用）。 */
    sync() { syncFromMonitor(); return snapshot(); },
    /** 重读门槛快照（运行中配置变更后立即反映）。 */
    refreshGates,
    /** 事件流游标（排障/测试用）。 */
    get cursor() { return { evtSeq: drill._lastEvtSeq, cycleNo: drill._lastCycleNo }; },
    get state() { return drill.state; },
    get logs() { return drill._logs.slice(); },
    confirmDialogs: CONFIRM_DIALOG_MEASURED,
    _internal: drill,
  };
}

module.exports = { createWatchDrill, STATUS_TEXT, scrub };
