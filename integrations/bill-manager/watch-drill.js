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

// 推广控制主项目根目录解析：优先环境变量；其次本机生产路径；最后按公开仓库内
// 相对位置（integrations/bill-manager 向上两级 = 仓库根）探测，使公开仓库中的
// 副本在无生产路径的机器上也能装配同一份生产模块。
function resolvePromoGuardDir() {
  const candidates = [
    process.env.PROMO_GUARD_DIR,
    'C:/Users/Administrator/Documents/ChatGPT/推广广告控制',
    path.join(__dirname, '..', '..'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(path.join(c, 'src/engine/monitor.js'))) return c; } catch (_) { /* 探测失败换下一个 */ }
  }
  return candidates[0];
}
const PROMO_GUARD_DIR = resolvePromoGuardDir();
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
      enableTask: null,      // 独立每日开启任务状态（与 running 完全分离的生命周期）
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
    _config: opts.config || null,   // 只读配置缓存（供首次启动前展示真实模式）
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
    // 未启动（无 Monitor）时也要读配置展示真实模式与门槛；
    // 但读取配置**绝不**启动调度/浏览器/广告动作（这里只做纯函数式读取）。
    const cfg = (m && m.config) || drill._config || {};
    const cf = (cfg.monitor && cfg.monitor.chengfang) || {};
    const exec = cfg.execution || {};

    // 2026-09-15 修复第 2 项（第二轮）：复用**与执行器完全一致**的许可判断。
    // 旧行为：`pauseWillExecute = realMode && pauseEnabled` —— 只看 realMode 与开关，
    // **不含 dryRun**。于是"三开关全开 + dryRun=true"时页面显示"会执行"，
    // 而执行器（chengfang-gate）实际以 dryRun 拒绝 → 展示与执行不一致（危险误导）。
    // 修复：直接调用 chengfang-gate 的 resolveChengfang*Allowed（含 dryRun 检查），
    // 与 buildChengfangRequestGate 同源，杜绝两套近似逻辑漂移。
    const gate = (m && typeof m.gatePreview === 'function') ? m.gatePreview() : null;
    // 未装配 Monitor 时，直接调用**生产同一份**许可判断（chengfang-gate），
    // 保证「首次启动前的展示」与「运行中执行器」也是同一套逻辑（含 dryRun）。
    let realAllowedRes;
    let enableAllowedRes;
    if (gate) {
      realAllowedRes = { ok: gate.pauseAllowed, reason: gate.pauseReason };
      enableAllowedRes = { ok: gate.enableAllowed, reason: gate.enableReason };
    } else {
      try {
        const { resolveChengfangRealAllowed, resolveChengfangEnableAllowed } = require(path.join(PROMO_GUARD_DIR, 'src/engine/chengfang-gate.js'));
        realAllowedRes = resolveChengfangRealAllowed(cfg);
        enableAllowedRes = resolveChengfangEnableAllowed(cfg);
      } catch (_) {
        realAllowedRes = { ok: false, reason: '无法读取执行许可（未装配 Monitor 且 chengfang-gate 不可用）' };
        enableAllowedRes = { ok: false, reason: '无法读取执行许可（未装配 Monitor 且 chengfang-gate 不可用）' };
      }
    }
    const realAllowed = realAllowedRes.ok === true;
    const enableAllowed = enableAllowedRes.ok === true;

    // 真实模式以 Monitor 的实时 getter 为准（而非装配时的快照）
    const realMode = m ? m.realMode === true : exec.realMode === true;
    const pauseEnabled = cf.pauseEnabled === true;
    const enableEnabled = cf.enableEnabled === true;
    const dryRun = exec.dryRun === true;

    return {
      realMode,
      pauseEnabled,
      enableEnabled,
      dryRun,
      // 配置里声明的模式（供"首次启动前"如实展示；未知不臆断）
      configuredRealMode: exec.realMode === true,
      modeKnown: typeof exec.realMode === 'boolean',
      // 未知模式 → 待核实（不得默认宣称演练安全）
      modeText: (typeof exec.realMode !== 'boolean')
        ? '待核实（配置缺少 execution.realMode，不得据此认为安全）'
        : (realMode ? '真实执行' : '演练模式（不操作广告）'),
      scope: Array.isArray(cf.scope) ? cf.scope.slice() : [],
      enableHour: Number.isInteger(cf.enableHour) ? cf.enableHour : 7,
      enableSchedulerEnabled: cf.enableSchedulerEnabled === true,
      dailyStartHour: (cfg.schedule && cfg.schedule.dailyStartHour) || 8,
      intervalMinutes: (cfg.schedule && cfg.schedule.intervalMinutes) || 30,
      // 真实暂停/开启是否**当前**会落地 —— 由真实许可（含 dryRun）决定，与执行器一致
      pauseWillExecute: realAllowed,
      enableWillExecute: enableAllowed,
      // 拦截原因（展示层可直接显示"为什么不会执行"）
      pauseGateReason: realAllowed ? null : (realAllowedRes.reason || '未满足执行许可'),
      enableGateReason: enableAllowed ? null : (enableAllowedRes.reason || '未满足执行许可'),
      // 具体是哪一道门槛拦住的（界面必须可见）
      blockedBy: [
        exec.realMode !== true ? 'realMode 未开启' : null,
        dryRun ? 'execution.dryRun=true（演练）' : null,
        pauseEnabled !== true ? '暂停开关未开启' : null,
        enableEnabled !== true ? '开启开关未开启' : null,
      ].filter(Boolean),
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

  /** 从 Monitor getStatus 提取独立每日开启任务状态（无 Monitor 时 null）。 */
  function syncEnableTask() {
    const m = drill._monitor;
    if (!m || typeof m.getStatus !== 'function') return null;
    const ms = m.getStatus().monitor || {};
    return ms.enableScheduler
      ? { ...ms.enableScheduler, enableHour: ms.enableHour, dailyStartHour: ms.dailyStartHour }
      : null;
  }

  // ── Monitor 装配（延迟到首次 start，避免加载即触网/建状态）────────────────
  /**
   * 只读加载配置（2026-09-15 修复第 2 项，第二轮）。
   *
   * 用途：**首次启动前**也要能如实展示真实模式与门槛，否则用户看到的是默认 false，
   * 误以为"必然是演练、安全"。此函数只 `loadConfig()` 读磁盘并缓存到 `drill._config`，
   * **绝不** new Monitor、绝不 start 调度、绝不打开浏览器、绝不做任何广告动作。
   */
  function loadConfigReadOnly() {
    if (drill._config) return drill._config;
    if (opts.config) { drill._config = opts.config; return drill._config; }
    try {
      const { loadConfig } = promo('src/config.js');
      const r = loadConfig();
      drill._config = r.config;
    } catch (e) {
      // 读配置失败不阻塞：标记为未知（展示"待核实"），不得默认宣称演练安全
      pushLog('warn', `读取配置失败（模式待核实，不臆断为演练安全）：${(e && e.message) || String(e)}`);
      drill._config = {};
    }
    return drill._config;
  }

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
    // 2026-09-15 修复第 1 项（第二轮）：targets 是**对象数组** [{view, planId}]，
    // 旧代码直接 `targets.join(',')` → 界面出现 "ID [object Object]"。
    // 修复：从对象里提取稳定 ID（planId / adId），无法提取时退回字符串化。
    const idOf = (t) => {
      if (t === null || t === undefined) return null;
      if (typeof t === 'string' || typeof t === 'number') return String(t);
      if (typeof t === 'object') {
        const v = t.planId !== undefined ? t.planId : (t.adId !== undefined ? t.adId : (t.id !== undefined ? t.id : null));
        return v === null ? null : String(v);
      }
      return String(t);
    };
    const ids = targetIds.map(idOf).filter((v) => v !== null && v !== '');
    // 动作标签：显式字段优先；未知则如实标注（绝不按 outcome 文本猜测）
    const label = ACTION_LABEL[kind] || '未知动作';
    const verb = kind === 'unknown' ? '将操作' : `将${label}`;
    return `${label}批次结果：${a.outcome || 'unknown'}（${bits.join('，') || '无明细'}）`
      + `；目标 ${targetIds.length} 条${ids.length ? `（ID ${ids.slice(0, 5).join(',')}${ids.length > 5 ? '…' : ''}）` : ''}`
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

  /**
   * 命中事件（演练枚举 / 真实触发）。
   *
   * 2026-09-15 修复（第三轮）：dry 分支曾硬编码"将暂停 N 条乘方计划"，
   * 不读 `targetAction`，于是每日开启演练（targetAction='enable'）被误展示为
   * "将暂停"。现在动作标签只认**显式 targetAction 字段**：
   *   - 'pause' → 将暂停；'enable' → 将开启；
   *   - 缺失/未知 → 如实标注"未知动作/待核实"，绝不从 outcome/note 文本猜测。
   * 真实 trigger（如被时间窗口拦下）同样带 targetAction（Monitor 侧已补字段）。
   */
  function describeTrigger(t) {
    if (t.failed) {
      return `命中处理失败：${t.reason || '未知原因'}${t.dryOutcome ? `（${t.dryOutcome}）` : ''}`;
    }
    const act = (t.targetAction === 'pause' || t.targetAction === 'enable') ? t.targetAction : null;
    const dataBits = [];
    if (t.costText !== undefined) dataBits.push(`费用 ${t.costText}`);
    if (t.orders !== undefined) dataBits.push(`订单 ${t.orders} 单`);
    const dataText = dataBits.length ? `${dataBits.join('，')}，` : '';
    const actionText = act === 'pause'
      ? `将暂停 ${t.targetCount || 0} 条乘方计划`
      : (act === 'enable'
        ? `将开启 ${t.targetCount || 0} 条乘方计划`
        : `未知动作/待核实（targetAction ${t.targetAction === undefined ? '缺失' : `为未识别值 ${JSON.stringify(t.targetAction)}`}，未按结果文本猜测），目标 ${t.targetCount || 0} 条乘方计划`);
    if (t.mode === 'dry') {
      return `命中（演练）：${dataText}${actionText}（演练不点击）${t.note ? `；${t.note}` : ''}`;
    }
    return `命中（真实）：${dataText}${actionText}`
      + (t.blocked ? `（未执行：${t.reason || '被门槛/窗口拦下'}）` : '')
      + (t.note ? `；${t.note}` : '');
  }

  /** 错误事件（失败原因，界面必须可见）。 */
  function describeError(e) {
    return `失败原因：${e.error}${e.code ? ` [${e.code}]` : ''}${e.scope ? `（${e.scope}）` : ''}`;
  }

  /**
   * 过程事件转译（2026-09-15 修复第 1 项，第二轮）。
   *
   * 这些事件来自 runner/executor 的 `_audit`（原仅写审计文件），现已双写进事件流。
   * 按**明确 event 名**转译，覆盖用户点名的「重试 / 回读 / 暂停 / 开启相位」：
   *   - retry            → 重试
   *   - paused / plan    → 暂停（含回读确认结果）
   *   - view / readback  → 回读核验
   *   - identity         → 身份核验
   *   - abort / done     → 停止 / 完成
   *   - step / *enable*  → 开启相位
   * 未识别的 event 名按原样透出（绝不臆造语义、绝不静默丢弃）。
   */
  const PROCESS_LABEL = {
    retry: { label: '重试', level: 'warn' },
    paused: { label: '暂停', level: 'info' },
    plan: { label: '暂停计划', level: 'info' },
    view: { label: '回读核验', level: 'info' },
    readback: { label: '回读核验', level: 'info' },
    identity: { label: '身份核验', level: 'info' },
    abort: { label: '已停止', level: 'warn' },
    done: { label: '批次完成', level: 'info' },
    step: { label: '执行步骤', level: 'info' },
    enable: { label: '开启相位', level: 'info' },
    enable_phase: { label: '开启相位', level: 'info' },
    enable_done: { label: '开启相位完成', level: 'info' },
  };
  // 独立每日开启调度器的审计事件（kind='enable-scheduler'，按 kind 精确分派）
  const ENABLE_SCHEDULER_LABEL = {
    registered: { label: '每日开启任务登记', level: 'info' },
    stopped: { label: '每日开启任务停止', level: 'warn' },
    window_missed: { label: '每日开启错过窗口', level: 'warn' },
  };
  function describeProcess(p) {
    if (p.kind === 'enable-scheduler' && p.event) {
      const em = ENABLE_SCHEDULER_LABEL[p.event] || null;
      const en = em ? em.label : `每日开启任务事件（${p.event}）`;
      const eb = [];
      if (p.nextRunAt) eb.push(`下次 ${p.nextRunAt}`);
      if (p.date) eb.push(`日期 ${p.date}`);
      if (p.reason) eb.push(p.reason);
      if (p.byUser !== undefined) eb.push(p.byUser ? '用户独立停用' : '非用户操作');
      return `过程：${en}${eb.length ? `（${eb.join('，')}）` : ''}` + (em ? '' : '；未识别事件名，按原样透出');
    }
    const ev = String(p.event || p.kind || 'unknown');
    // "*enable*" 家族一律归入开启相位（不逐字枚举）
    const meta = PROCESS_LABEL[ev] || (/enable/i.test(ev) ? { label: '开启相位', level: 'info' } : null);
    const name = meta ? meta.label : `过程事件（${ev}）`;
    const bits = [];
    if (p.view) bits.push(`视图 ${p.view}`);
    if (p.attempt !== undefined) bits.push(`第 ${p.attempt} 次`);
    if (p.confirmed !== undefined) {
      const c = Array.isArray(p.confirmed) ? p.confirmed.map((x) => (x && typeof x === 'object' ? (x.planId || x.adId || '') : x)).filter(Boolean) : p.confirmed;
      bits.push(`已确认 ${Array.isArray(c) ? c.length : c}`);
    }
    if (p.note) bits.push(String(p.note));
    if (p.reason) bits.push(`说明：${p.reason}`);
    if (p.error) bits.push(`失败原因：${p.error}`);
    const level = p.failed === true || p.error ? 'error' : (meta ? meta.level : 'info');
    return `过程：${name}${bits.length ? `（${bits.join('，')}）` : ''}` + (meta ? '' : '；未识别事件名，按原样透出');
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
      // 独立每日开启任务状态（与 running=暂停值守 完全分离，界面分别展示）
      st.enableTask = status.monitor.enableScheduler
        ? { ...status.monitor.enableScheduler, enableHour: status.monitor.enableHour, dailyStartHour: status.monitor.dailyStartHour }
        : null;
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
          // 2026-09-15 修复第 1 项（第二轮）：**按显式 evtType 分派**。
          // 旧行为：靠字段形状猜类型（`evt.actionType !== undefined` 判批次），
          // 于是开启演练的 trigger（原携带 actionType:'enable'）被误判为批次，
          // 显示成"开启批次结果：unknown"——用户看到的是错的结论。
          // 修复：Monitor 为每条事件打上显式 evtType，消费方无歧义分派；
          // 仅当 evtType 缺失（旧 Monitor/兼容路径）才回退到形状推断。
          const type = evt.evtType || null;
          const isJudgement = type ? type === 'judgement' : (evt.kind === 'judgement');
          const isBatch = type ? type === 'batch' : (!isJudgement && (
            evt.actionType !== undefined || evt.action !== undefined
            || evt.outcome !== undefined || evt.counts !== undefined
            || evt.allPausedConfirmed !== undefined || evt.allEnabledConfirmed !== undefined
            || evt.allClosedConfirmed !== undefined
          ));
          const isTrigger = type ? type === 'trigger' : (!isJudgement && !isBatch && (
            evt.mode !== undefined || evt.failed !== undefined
            || evt.costText !== undefined || evt.targetCount !== undefined
          ));
          const isProcess = type ? type === 'process' : false;
          const isError = type
            ? type === 'error'
            : (!isJudgement && !isBatch && !isTrigger && !isProcess && typeof evt.error === 'string');

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
          } else if (isProcess) {
            // 真实过程事件（runner/executor 的 retry/paused/view/identity/abort/done/step…）
            pushLog((evt.failed === true || evt.error) ? 'error' : 'info', describeProcess(evt));
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
  /**
   * 服务启动装配（2026-09-15 上线）：3443 进程启动即调用，不依赖任何页面访问。
   * - 装配 Monitor（只读装配，不启动暂停巡查/值守）；
   * - 按配置自动登记独立每日开启任务（重启自动恢复；用户独立停用除外）；
   * - 启动后台周期同步：无人打开页面也持续转译事件流并落盘值守日志。
   */
  function boot() {
    try {
      ensureMonitor();
    } catch (e) {
      pushLog('error', `值守装配失败（服务启动）：${(e && e.message) || String(e)}`);
      return snapshot();
    }
    const m = drill._monitor;
    if (m.enableSchedulerShouldRun()) {
      const r = m.startEnableScheduler({ reason: '服务启动自动恢复' });
      if (r && r.ok === false) {
        pushLog('warn', `每日开启任务登记失败：${r.reason}`);
      } else {
        const t = (drill.state.enableTask = syncEnableTask()) || {};
        pushLog('info', `独立每日开启任务已登记：每日 ${String(t.enableHour).padStart(2, '0')}:00（上海）自动开启全部乘方计划（含人工暂停的）；`
          + `下次开启 ${t.nextRunAt || '—'}；与"启动值守"相互独立（停止值守不取消本任务）。`);
      }
    } else {
      const cf = (m.config.monitor && m.config.monitor.chengfang) || {};
      pushLog('info', cf.enableSchedulerEnabled === true
        ? '每日开启任务保持"用户独立停用"状态（服务重启不自动恢复，可在页面手动恢复）'
        : '独立每日开启任务未启用（monitor.chengfang.enableSchedulerEnabled=false）');
    }
    if (!drill._syncTimer) {
      drill._syncTimer = setInterval(() => { try { syncFromMonitor(); } catch (_) { /* 后台同步失败不影响运行 */ } }, 60 * 1000);
      if (typeof drill._syncTimer.unref === 'function') drill._syncTimer.unref();
    }
    syncFromMonitor();
    return snapshot();
  }

  /** 独立每日开启任务：停用（页面控制；持久化，重启不自动恢复）。 */
  function stopEnableScheduler() {
    try {
      const m = ensureMonitor();
      const r = m.stopEnableScheduler({ byUser: true, reason: '页面独立停用' });
      pushLog(r && r.wasRunning ? 'warn' : 'info', `每日开启任务已停用（${r && r.wasRunning ? '此前运行中，已中止未派发的开启' : '此前未在运行'}）；暂停值守不受影响。`);
    } catch (e) {
      pushLog('error', `停用每日开启任务失败：${(e && e.message) || String(e)}`);
    }
    syncFromMonitor();
    return snapshot();
  }

  /** 独立每日开启任务：恢复（清除独立停用标记并重新登记）。 */
  function startEnableScheduler() {
    try {
      const m = ensureMonitor();
      const r = m.resumeEnableScheduler({ reason: '页面手动恢复' });
      if (r && r.ok === false) pushLog('warn', `每日开启任务恢复失败：${r.reason}`);
    } catch (e) {
      pushLog('error', `恢复每日开启任务失败：${(e && e.message) || String(e)}`);
    }
    syncFromMonitor();
    return snapshot();
  }

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
    // 2026-09-15 修复第 2 项（第二轮）：**首次启动前**也读取配置展示真实模式。
    // 旧行为：未启动时 gates=null、realMode 回落到构造时的 false → 用户误以为
    // "必然是演练、安全"。修复：未启动时只读加载配置（不启动调度/浏览器/广告），
    // 用 computeGates() 如实展示 configuredRealMode 与门槛；未知模式显示"待核实"。
    let gates = st.gates;
    if (!m) {
      try {
        loadConfigReadOnly();
        gates = computeGates();
        st.gates = gates;
        drill.realMode = gates.realMode === true;
        drill.shopName = (drill._config && Array.isArray(drill._config.shops))
          ? (drill._config.shops.map((s) => s.name || s.id).join('、') || '—')
          : drill.shopName;
        // 未装配 Monitor（boot 前）：如实展示"调度器未运行"；配置开关与停用标记未知不臆断
        if (!st.enableTask) {
          const cf = (drill._config && drill._config.monitor && drill._config.monitor.chengfang) || {};
          st.enableTask = {
            running: false, configEnabled: cf.enableSchedulerEnabled === true,
            stoppedByUser: null, phase: null, nextRunAt: null, lastRunAt: null,
            lastMissedReason: null,
            enableHour: gates.enableHour, dailyStartHour: gates.dailyStartHour,
          };
        }
      } catch (_) { /* 读配置失败：保留 null/未知，不臆断 */ }
    }
    return {
      shopName: drill.shopName,
      realMode: m ? m.realMode === true : (gates ? gates.realMode === true : drill.realMode),
      // 首次启动前也如实告知：模式是否已知、配置声明的模式是什么
      realModeKnown: gates ? gates.modeKnown !== false : false,
      modeText: gates ? gates.modeText : '待核实（尚未读取配置）',
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
      gates,
      enableTask: st.enableTask || null,
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

  /**
   * 最近一次日志缺口（2026-09-15 修复第 3 项，第二轮）。
   *
   * 旧行为：从日志文本正则回读 "共丢失 N 条"，只能反映**最后一条**缺口日志，
   * 且与 Monitor 的真实计数脱节（写 1000 留 300 时只报 50）。
   * 修复：直接用 Monitor 的 `getEventStream().droppedCount`（= 累计裁剪 + 未消费区段），
   * 这才是当前消费游标之后的**真实**缺口；日志文本仅作为兜底（无 Monitor 时）。
   */
  function latestGap() {
    const m = drill._monitor;
    if (m && typeof m.getEventStream === 'function') {
      try {
        const s = m.getEventStream(drill._lastEvtSeq);
        if (typeof s.droppedCount === 'number') {
          // 无缺口时返回 null（与既有 HTTP 契约一致：gap=null 表示"未发生裁剪"）
          if (s.droppedCount === 0) return null;
          return { droppedCount: s.droppedCount, trimmedTotal: s.trimmedTotal || 0, source: 'eventStream' };
        }
      } catch (_) { /* 回退到日志文本 */ }
    }
    for (let i = drill._logs.length - 1; i >= 0; i -= 1) {
      const mm = /日志缺口：.*共丢失 (\d+) 条事件/.exec(drill._logs[i].msg);
      if (mm) return { at: drill._logs[i].t, droppedCount: Number(mm[1]), source: 'logText' };
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
    batch_enable: true,  // 2026-09-15 真机实测：商品自选批量开启**无确认弹窗**（点击即生效，回读确认）
    shop_disable: true,  // 实测「确定关闭乘方投放吗？」
    shop_enable: true,   // 2026-09-15 真机实测：「为保证投放的唯一性…受到互斥影响…」【再想想】【确定】
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
      // 独立每日开启任务控制（与"启动值守"完全分离；页面提供独立按钮）
      if (p === '/api/watch-drill/daily-enable/start' && req.method === 'POST') return send(200, { ok: true, state: startEnableScheduler() });
      if (p === '/api/watch-drill/daily-enable/stop' && req.method === 'POST') return send(200, { ok: true, state: stopEnableScheduler() });
      if (p === '/api/watch-drill/state' && req.method === 'GET') { syncFromMonitor(); return send(200, { ok: true, state: snapshot() }); }
      if (p === '/api/watch-drill/logs' && req.method === 'GET') {
        syncFromMonitor();
        const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
        const logs = drill._logs.filter((l) => l.seq > since);
        const gap = latestGap();
        return send(200, {
          ok: true,
          seq: drill._seq,
          logs,
          gap,                                        // 明确的日志缺口（真实 droppedCount）
          droppedCount: gap ? gap.droppedCount : 0,   // 顶层直供：当前消费游标之后的真实缺口
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
    /** 服务启动装配：登记独立每日开启任务 + 后台周期同步（不启动暂停值守）。 */
    boot,
    /** 独立每日开启任务控制（与 start/stop 值守相互独立）。 */
    startEnableScheduler,
    stopEnableScheduler,
    snapshot,
    serveHttp,
    /** 显式同步（测试/调试用；HTTP 各接口内部已自动调用）。 */
    sync() { syncFromMonitor(); return snapshot(); },
    /** 重读门槛快照（运行中配置变更后立即反映）。 */
    refreshGates,
    /** 门槛快照（未启动时也只读读配置，不启动调度/浏览器/广告）。 */
    gates() { loadConfigReadOnly(); return computeGates(); },
    /** 事件流游标（排障/测试用）。 */
    get cursor() { return { evtSeq: drill._lastEvtSeq, cycleNo: drill._lastCycleNo }; },
    get state() { return drill.state; },
    get logs() { return drill._logs.slice(); },
    confirmDialogs: CONFIRM_DIALOG_MEASURED,
    _internal: drill,
  };
}

module.exports = { createWatchDrill, STATUS_TEXT, scrub };
