'use strict';

/**
 * 推广值守 —— 3443 电商助手「推广值守」Tab 的后端调度服务（2026-09-15 接入真实操作模式）。
 *
 * 用户规则（唯一目标，2026-10-09 更新）：
 *   1) 每天 00:05 后检查当天是否暂停，暂停才作为当天首次开启（全店托管 + 商品自选，
 *      含昨日暂停的全部计划）；已开启则零点击记完成；00:00–00:04:59 不强制开启；
 *   2) 08:00 后每 30 分钟费比检查：当天「账户整体消耗」÷ 当天「全店订单数」**严格超过** 1 元/单
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
 * - 重启语义（2026-10-09 客户要求）：服务启动时 watchDrill.boot() 自动启动推广值守一次
 *   （幂等；本次运行中人工停止后页面重开不恢复，下一次服务启动再次自动启动）。
 *   日志有界持久化到 JSONL。
 * - 日志安全：绝不记录 Cookie/令牌/敏感请求参数；统一 scrubbing；单行上限 2000 字符。
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 推广控制主项目根目录解析：优先环境变量；其次本机生产路径；最后按公开仓库内
// 相对位置（integrations/bill-manager 向上两级 = 仓库根）探测，使公开仓库中的
// 副本在无生产路径的机器上也能装配同一份生产模块。
function resolvePromoGuardDir() {
  const candidates = [
    process.env.PROMO_GUARD_DIR,
    'C:/Users/Administrator/Documents/电商助手/douyin-promo-guard',
    path.join(__dirname, '..', 'douyin-promo-guard'),
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
const { compactUrls } = promo('src/lib/log.js');
const { SPEND_FLOOR_CENTS } = promo('src/engine/rules.js');
// 后台自动发布排程（客户 2026-10-11）：本机模块，承担日期时刻判断/配置校验/原子账本；
// 真实发布执行器默认直接接 publisher 正式递归入口 runScheduledPlan（opts.schedulerRunPlan
// 仍可覆盖用于测试；绝不 stub/假冒）。
const { createScheduler, loadLedger, saveLedger, countSuccessEntries, hasInProgress, acquireProcessLock, releaseProcessLock, strictSchedulerReleaseProof, applySchedulerReleaseToRecord, resolveShopPlansPerDay, strictNoPublicationProof } = require('./promo-plan-scheduler');
// publisher 目录解析（用于排程默认 trusted business 构造）：优先显式环境变量；其次
// 本机已安装 publisher（相对「Documents」目录解析，bill-manager 位于 Documents/<组>/
// bill-manager，故 Documents = 上上级）；最后保留公开仓库内隔离副本 ../publisher。
// 判定依据是 shop-profile.cjs 实际存在；三者都不存在时返回第一个候选并如实未就绪
// （publisherRequire 返回 null，调用方不假装就绪）。
function resolvePublisherDir(di) {
  const d = di || {};
  const env = d.env || process.env;
  const exists = d.existsSync
    || ((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
  const selfDir = d.selfDir || __dirname;
  const documentsDir = d.documentsDir || path.resolve(selfDir, '..', '..');
  const candidates = [
    env.PUBLISHER_DIR,
    path.join(documentsDir, 'ChatGPT', '推广广告控制', 'plan-publisher'),
    path.join(selfDir, '..', 'publisher'),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (exists(path.join(c, 'shop-profile.cjs'))) return c; } catch (_) { /* 换下一个 */ }
  }
  return candidates[0];
}
const PUBLISHER_DIR = resolvePublisherDir();
const publisherRequire = (rel) => { try { return require(path.join(PUBLISHER_DIR, rel)); } catch (_) { return null; } };

// ── W4（2026-10-25）：独立 plan-publisher 当日结果的纯只读展示投影 ────────────
// 背景：三店发布已由独立 Windows 任务（plan-publisher 目录）完成并各自原生回读；
// 旧内嵌发布器保持 disabled。页面 planPublishing 只读旧内嵌 state，导致独立结果
// 无法展示。本段只读 PUBLISHER_DIR 下 daily-plan-config.json 与
// daily-plan-data/ledger.json，把**当前上海业务日**的独立结果投影成页面既有的
// planPublishing.today / lastRunDate / lastResults 形状。
// 约束：纯 fs 只读，不实例化/不 tick/不启用任何调度器，不导入 runScheduledPlan、
// Monitor、createDailyRunner，不写任何文件，不读 Cookie/令牌；证据不足（缺文件/
// 坏 JSON/跨日/计数冲突）一律如实待核实，绝不伪造成功，也绝不回退旧内嵌绿灯。
function readJsonFileReadOnly(readFile, p) {
  try {
    const text = readFile(p, 'utf8');
    if (typeof text !== 'string' || !text.trim()) return null;
    return JSON.parse(text);
  } catch (_) { return null; }
}

/** 单店当日结果评估：只在份号集合/唯一合法 planId/成功条数/rec.plans/每店上限
 *  全部一致且无未完成（unknown/in-progress/failed 等）条目时判 success；
 *  其余一律 incomplete，plans=已成功条数，error 为固定短说明（不复制原始 reason，
 *  不向页面输出 nonce/CID/manifest/Cookie 等原文）。 */
function evaluateIndependentShopDay(rec, cap) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const entries = (rec.entries && typeof rec.entries === 'object' && !Array.isArray(rec.entries))
    ? rec.entries : null;
  if (!entries) return { status: 'incomplete', plans: 0, error: '无当日条目证据（不推断成败）' };
  const recPlans = Number(rec.plans);
  const expected = (Number.isInteger(cap) && cap > 0) ? cap : null;
  if (expected == null) return { status: 'incomplete', plans: 0, error: '每店份数上限未知（不推断成败）' };
  const nums = new Set();
  const planIds = new Set();
  let successCount = 0;
  let pending = null;
  for (const k of Object.keys(entries)) {
    const e = entries[k];
    if (!e || typeof e !== 'object') return { status: 'incomplete', plans: 0, error: '条目非法：' + scrub(k) };
    const num = Number(e.planNumber != null ? e.planNumber : k);
    if (!Number.isInteger(num) || num < 1 || num > expected) {
      return { status: 'incomplete', plans: 0, error: '份号非法或超上限：' + num };
    }
    if (nums.has(num)) return { status: 'incomplete', plans: 0, error: '份号重复：第' + num + '份' };
    nums.add(num);
    if (e.status === 'success') {
      const pid = String(e.planId || '');
      if (!/^\d{12,20}$/.test(pid)) {
        return { status: 'incomplete', plans: 0, error: '成功条目缺合法 planId：第' + num + '份' };
      }
      if (planIds.has(pid)) return { status: 'incomplete', plans: 0, error: 'planId 重复：第' + num + '份' };
      planIds.add(pid);
      successCount += 1;
    } else {
      pending = pending || String(e.status || 'unknown');
    }
  }
  if (rec.status !== 'success' || nums.size !== expected || successCount !== expected
    || !Number.isInteger(recPlans) || recPlans !== expected) {
    return {
      status: 'incomplete', plans: successCount,
      error: pending ? '存在未完成条目（' + scrub(pending) + '）' : '计数与上限不一致（' + successCount + '/' + expected + '）',
    };
  }
  return { status: 'success', plans: successCount, error: null };
}

/** 独立结果投影（可导出供测试）：读 config+ledger，返回
 *  { installed, reason, today }。installed=false 表示独立安装文件均不存在；
 *  installed=true 但 today=null 表示
 *  独立安装存在而当日证据缺失/无效 → 必须清空展示为待核实。 */
function projectIndependentPlanResults(opts) {
  const o = opts || {};
  const readFile = o.readFileSync || ((p, enc) => fs.readFileSync(p, enc));
  const dir = (o.publisherDir != null) ? o.publisherDir : PUBLISHER_DIR;
  const businessDate = o.businessDate;
  if (typeof dir !== 'string' || !dir) return { installed: false, reason: 'no-publisher-dir', today: null };
  if (typeof businessDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
    return { installed: false, reason: 'invalid-business-date', today: null };
  }
  const cfg = readJsonFileReadOnly(readFile, path.join(dir, 'daily-plan-config.json'));
  const ledger = readJsonFileReadOnly(readFile, path.join(dir, 'daily-plan-data', 'ledger.json'));
  if (!cfg || !ledger) return { installed: !!cfg || !!ledger || fs.existsSync(path.join(dir, 'daily-plan-config.json')) || fs.existsSync(path.join(dir, 'daily-plan-data', 'ledger.json')), reason: 'independent-config-or-ledger-missing', today: null };
  if (!Array.isArray(cfg.shops) || !cfg.shops.length || !ledger.days || typeof ledger.days !== 'object') {
    return { installed: true, reason: 'independent-config-invalid', today: null };
  }
  const globalCap = (Number.isInteger(Number(cfg.plansPerShopPerDay)) && Number(cfg.plansPerShopPerDay) > 0)
    ? Number(cfg.plansPerShopPerDay) : null;
  const day = Object.prototype.hasOwnProperty.call(ledger.days, businessDate) ? ledger.days[businessDate] : null;
  const dayShops = (day && day.shops && typeof day.shops === 'object' && !Array.isArray(day.shops))
    ? day.shops : null;
  const shops = {};
  for (const s of cfg.shops) {
    if (!s || typeof s !== 'object') continue;
    const id = (s.id != null) ? String(s.id) : null;
    const name = (s.name != null) ? String(s.name) : null;
    if (!id && !name) continue;
    const cap = (Number.isInteger(Number(s.plansPerShopPerDay)) && Number(s.plansPerShopPerDay) > 0)
      ? Number(s.plansPerShopPerDay) : globalCap;
    const rec = dayShops ? (dayShops[id] || dayShops[name] || null) : null;
    const view = rec ? evaluateIndependentShopDay(rec, cap) : null;
    if (!view) continue;
    if (id) shops[id] = view;
    if (name && !Object.prototype.hasOwnProperty.call(shops, name)) shops[name] = view;
  }
  return { installed: true, reason: null, today: { date: businessDate, shops, source: 'independent' } };
}

/** 把独立投影叠加到旧内嵌排程状态的**浅拷贝**上：保留旧 config/运行/控制字段与
 *  旧 scheduler 对象原样（不 mutate state() 返回的内部对象）；独立已安装时
 *  today/lastRunDate/lastResults 一律以独立证据为准（无证据=清空，绝不回退旧绿灯）。 */
function mergeIndependentPlanPublishing(oldState, projection) {
  const base = (oldState && typeof oldState === 'object') ? { ...oldState } : null;
  if (!projection || projection.installed !== true) return base;
  const merged = base || {};
  if (projection.today) {
    merged.today = projection.today;
    merged.lastRunDate = projection.today.date;
    merged.lastResults = projection.today.shops;
  } else {
    merged.today = null;
    merged.lastRunDate = null;
    merged.lastResults = null;
  }
  merged.resultsSource = 'independent';
  return merged;
}
// 准备收口事实的 reason **有界长度上限**（承载合法长诊断，同时拒非正常超长/灌水）。
// publisher 生成的 reason 恒为 'scheduled-run-exception:'(23) + 错误文本；错误文本通常是
// page.evaluate 驱动包装（形如 'page.evaluate: Error: ' + <真实错误文本/错误堆栈> +
// ' (confirmDraftRemovalInPage)'），其中 confirmDraftRemovalInPage 的"未知模态"现场诊断在
// publisher 侧被有界脱敏为 ≤400 字符（run-plans.cjs sceneOf 的 .slice(0,400)）。
// 真实 provider 错误还**携带 page.evaluate 的真实错误堆栈**：实测生产原 reason 已达 256 字符
// （已含真实堆栈、尚未含现场诊断），把 ≤400 字符现场诊断并入同一错误 token 后合法 reason 达
// 657 字符。旧上限 512 会**误拒这条合法证明**（原 512 只覆盖了无真实堆栈的模拟形态）。
// 故取 1024 作有界合理上限：覆盖"真实堆栈 + 400 诊断 + 前后缀"仍留余量，同时拒异常超长/灌水。
// 绝不截断原 reason、绝不放宽 exact matching 与六 zeros/身份判据；超过该上限的异常 reason 仍一律拒。
const PREPARATION_REASON_MAX_LEN = 1024;
// 排程默认 trusted business 构造：由 shop-profile 从配置店铺生成（roi 取 targetRoi，
// 预算取排程 cfg.dailyBudget）；accountId 缺失时保持 null，由排程按"未知账户停止本店"
// 处理（不臆造身份，绝不用别的店 Cookie）。publisher 不可用时退回最小可信对象。
function buildTrustedBusiness(shop, ctx) {
  const budget = (ctx && Number.isFinite(ctx.dailyBudget) && ctx.dailyBudget > 0) ? ctx.dailyBudget : 300;
  // 本店今日有效份数上限：优先排程 ctx.plansPerShopPerDay（每店合法 1..10），否则取店自身
  // 已保存 plansPerShopPerDay，再否则回落 3。写入 maxPlansPerDay 使 frozen/确认/回读上界与本
  // 店配置逐字绑定（默认 3 拒绝第 4 份；配置 6 允许 1..6 但拒绝 7；恢复 3 后仍诚实保留已真实 6）。
  const shopPlans = (ctx && Number.isInteger(ctx.plansPerShopPerDay) && ctx.plansPerShopPerDay >= 1 && ctx.plansPerShopPerDay <= 10)
    ? ctx.plansPerShopPerDay
    : (Number.isInteger(shop.plansPerShopPerDay) && shop.plansPerShopPerDay >= 1 && shop.plansPerShopPerDay <= 10 ? shop.plansPerShopPerDay : 3);
  const sp = publisherRequire('shop-profile.cjs');
  if (sp && typeof sp.buildShopProfile === 'function') {
    return sp.buildShopProfile({
      shop: shop.name, accountId: shop.accountId != null ? shop.accountId : null,
      boundAccounts: shop.boundAccounts || null, roi: shop.targetRoi, dailyBudget: budget,
      maxPlansPerDay: shopPlans,
    });
  }
  return { shop: shop.name, accountId: shop.accountId != null ? shop.accountId : null,
    roi: shop.targetRoi, boundAccounts: shop.boundAccounts || null, dailyBudget: budget,
    maxPlansPerDay: shopPlans };
}

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
// 2026-09-21：附带压缩超长 URL（千川管理页带大量 utm/埋点参数，单条可达数千字符）。
function scrub(msg) {
  let s = typeof msg === 'string' ? msg : String(msg);
  s = s
    .replace(/((?:cookie|token|secret|password|passwd|pwd|app_secret|api_key|apikey|sessionid|session_id)[=:\s"']+)(?![\u4e00-\u9fff])([^\s"',}{]{6,})/gi, '$1***')
    .replace(/(Bearer\s+)(?![\u4e00-\u9fff])[^\s]{20,}/gi, '$1***');
  s = compactUrls(s);
  return s.replace(/[\r]/g, '').replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, '').slice(0, 2000);
}

/**
 * 递归脱敏：对象/数组/错误/嵌套结构中的所有字符串均经 scrub。
 * 保留 `***` 标记；原始 Cookie/token/secret 值不得出现在任何展示或持久化出口。
 */
function scrubDeep(value, seen) {
  if (value == null) return value;
  if (typeof value === 'string') return scrub(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: scrub(value.name), message: scrub(value.message), stack: scrub(value.stack || '') };
  }
  const guard = seen || new WeakSet();
  if (typeof value === 'object') {
    if (guard.has(value)) return '[circular]';
    guard.add(value);
    try {
      // 路径式循环检测（2026-09-24）：处理完即移出 guard——共享引用（如快照中
      // st.adState 与 st.shopRows[0].adState 为同一对象）各自得到一份脱敏副本，
      // 不再被误判成 [circular]；只有真正的环（祖先路径上再次遇到）才标记。
      if (Array.isArray(value)) {
        return value.map((v) => scrubDeep(v, guard));
      }
      const out = {};
      for (const k of Object.keys(value)) {
        out[k] = scrubDeep(value[k], guard);
      }
      return out;
    } finally {
      guard.delete(value);
    }
  }
  return scrub(String(value));
}

/**
 * 从今日暂停批次与每日开启记录推导广告当前开/关（2026-09-21 页面主信息）。
 * 多店铺：按 shopId 过滤开启相位记录，保持平台/店铺对应关系。
 * 依据是**本系统的执行记录**：最近一次回读确认的全量暂停 → 已暂停；其后若每日开启
 * 成功（跨日 07:00）→ 投放中；均无记录 → 未知。人工在千川端的开关不在此感知范围内
 * （下一轮巡查/批次回读会重新核对）。导出供测试直接覆盖各分支。
 * 注意：推广广告控制仅针对抖店（douyin）；拼多多店铺可出现在商品分析列表，但不参与广告控制。
 */

/**
 * 运行中的状态相位投影（纯函数，导出供测试）。
 * 关键修复：Monitor 在两次巡查之间空闲等待时 schedule.phase 仍为 'running'，
 * 旧投影把 running+phase='running' 一律映射 'reading'（检查中），导致空闲期间持续显示"检查中"。
 * 改为依据 engine 真实执行字段 cycleRunning（仅本刻有周期在途为 true）区分：
 *   - enable_window / waiting_window 相位原样映射；
 *   - 其余相位：cycleRunning=true → reading（检查中）；false → waiting（值守中·等待下次检查）。
 * 不靠时间猜测正在执行/空闲。
 */
function computeRunningStatus(phase, cycleRunning) {
  if (phase === 'enable_window') return 'enable_window';
  if (phase === 'waiting_window') return 'waiting';
  if (cycleRunning === true) return 'reading';
  return 'waiting';
}

function deriveAdState(status, shop) {
  const b = shop && shop.batchToday;
  const pausedAt = b && b.allPausedConfirmed === true ? (b.lastBatchAt || null) : null;
  let enabledAt = null;
  let enabledTs = -Infinity;
  const shopId = shop && (shop.id || shop.shopId);
  for (const it of (status && status.monitor && status.monitor.enablePhaseToday) || []) {
    if (shopId && it.shopId && it.shopId !== shopId) continue;
    const r = it.record || {};
    if (r.status === 'success' && r.at) {
      const t = Date.parse(r.at);
      if (!Number.isNaN(t) && t > enabledTs) { enabledTs = t; enabledAt = r.at; }
    }
  }
  if (shop && shop.lastAdState) {
    // mixed 只作过渡观测，不是完成态：界面文案必须带待收敛/重新判定/重试中，不得显示为一次成功
    const map = { on: { on: true, note: '开启' }, off: { on: false, note: '暂停' }, mixed: { on: null, note: '混合（待收敛，非完成态）' }, unknown: { on: null, note: '未知' } };
    const m = map[shop.lastAdState] || map.unknown;
    // unknown 必须带完整原因分类（不把读取失败/重试中/登录失效混成一个"未知"标签）。
    const re = shop.lastReadError || null;
    let note = m.note;
    if (shop.lastAdState === 'unknown' && re) {
      // 分类与主提示同源：通用 auth 无正证据 → 读取失败；Cookie 故障单独可见。
      const fv = classifyShopReadFailure(shop);
      const kind = fv ? (fv.category === 'login' ? 'auth' : fv.category) : 'read_failed';
      note = kind === 'retrying' ? '未知（正在重试读取）'
        : kind === 'auth' ? '未知（登录失效）'
          : kind === 'cookie_invalid' ? '未知（Cookie 文件异常）'
            : kind === 'cookie_blocked' ? '未知（Cookie 读取受阻）'
              : kind === 'identity' ? '未知（身份核验未通过）'
                : kind === 'timeout' ? '未知（读取超时）'
                  : '未知（读取失败）';
      if (re.retried === true) note = note.replace('）', '，已重试1次）');
    }
    // 有限恢复进度（F4-R8）：直接消费 Monitor 的真实投影（次数/下次时间/满10停止），
    // 不在页面重算计数或猜下一次时间；机读状态仍是 unknown，绝不改成 on/off。
    const recovery = shop.readRecovery || null;
    if (shop.lastAdState === 'unknown' && recovery && recovery.text) {
      note = `未知（${recovery.text}）`;
    }
    // 展示时间必须与当前状态同源且仅有状态证据：只读观测优先，其次动作确认。
    // 无 adStateObservedAt / adStateConfirmedAt 时 at=null；不得用费用/订单采集时间（lastDataAt）冒充。
    const at = shop.adStateObservedAt || shop.adStateConfirmedAt || null;
    const evidenceKind = shop.adStateObservedAt ? 'read_only'
      : (shop.adStateConfirmedAt ? 'action_confirm' : null);
    const rec = shop.mixedReconcile || null;
    const recState = rec && typeof rec.reconcileState === 'string' ? rec.reconcileState : null;
    // mixed 只消费后端结构化状态：no_repair_scheduled = 明确没有安排收敛
    // （店铺停用/只读刷新/等于阈值/50 元保护等合法零动作），不得用字符串原因猜测；
    // 真实待收敛/重新判定/重试中继续使用后端标签，原样保留。
    const noRepairScheduled = shop.lastAdState === 'mixed' && (recState === 'no_repair_scheduled'
      || (recState == null && !!(rec && rec.noRepairScheduled === true)));
    if (shop.lastAdState === 'mixed') {
      if (noRepairScheduled) note = '混合（未安排收敛，非完成态）';
      else if (rec && rec.reconcileText) note = `混合（${rec.reconcileText}，非完成态）`;
    }
    return {
      on: m.on,
      at,
      note,
      state: shop.lastAdState,
      // unknown 的完整原因（只读展示；绝不用于推断 on/off 或成功）
      unknownReason: re && re.reason ? String(re.reason) : null,
      unknownReasonKind: re ? (re.kind || 'read_failed') : null,
      readRetrying: !!(re && (re.kind === 'retrying' || re.retrying === true)),
      readRetried: !!(re && re.retried === true),
      // mixed 永不作为完成态；完成只认 on/off 且由全量回读确认
      isCompletion: shop.lastAdState === 'on' || shop.lastAdState === 'off',
      reconcileState: recState,
      reconcileText: rec ? rec.reconcileText : null,
      unknownBlock: rec ? rec.unknownBlock === true : false,
      noRepairScheduled,
      // 有限恢复链投影（真实计数/最大10/等待或执行中/下次时间/失败原因）
      readRecovery: recovery,
      confirmedAt: shop.adStateConfirmedAt || null,
      observedAt: shop.adStateObservedAt || null,
      evidenceKind,
    };
  }
  const pt = pausedAt ? Date.parse(pausedAt) : NaN;
  const et = enabledAt ? Date.parse(enabledAt) : NaN;
  if (pausedAt && !Number.isNaN(pt) && (Number.isNaN(et) || pt >= et)) {
    return { on: false, at: pausedAt, note: '已暂停', state: 'off' };
  }
  if (enabledAt && !Number.isNaN(et)) return { on: true, at: enabledAt, note: '投放中', state: 'on' };
  return { on: null, at: null, note: '未知', state: 'unknown' };
}

/**
 * 多店铺快照行：每店独立 { id, displayName, platform, adState, ... }。
 * 推广广告控制仅抖店；拼多多行 adControl=false，界面不得假装支持广告开关。
 */
// 「请重新扫码登录」只在**正向**证据下成立：Cookie 明确已过有效期，或状态文本明确
// 写「登录失效 / 请重新扫码登录 / 持续登录页」。导航失败（如 school 教程页、未到达千川）、
// Cookie 文件解析/结构坏、Cookie 文件缺失/不可读/同步锁、身份冲突/配置缺失等其他 AuthError
// 一律不触发该标记——它们不是"登录过期"（2026-10-18 F5-R9）。
const LOGIN_EXPIRED_POSITIVE_RE = /登录失效|登录已失效|请重新扫码登录|重新扫码|持续登录页|登录验证未通过|会话已失效|登录态无效|未登录/;
const COOKIE_DEFINITE_EXPIRED_RE = /已过有效期/;
// Cookie 文件本身坏（解析/结构）：本地文件异常，不是登录失效。
const COOKIE_INVALID_RE = /Cookie\s*文件解析失败|Cookie\s*文件内容不是非空数组|Cookie\s*数组中存在缺少|Cookie\s*文件格式|Cookie\s*结构/;
// Cookie 读取受阻（缺文件/路径不可读/同步锁/权限）：本地访问故障，不是登录失效。
// 裸 ENOENT/EACCES 不单独判定（浏览器启动失败等应归读取失败）。
const COOKIE_BLOCKED_RE = /未找到店铺[^\n]*Cookie\s*文件|Cookie\s*文件名未配置|Cookie\s*文件名非法|Cookie\s*文件不存在|Cookie\s*文件不可读|Cookie[^\n]{0,40}(EACCES|EPERM|ENOENT)|正在同步该店\s*Cookie\s*副本|工作副本锁|工作副本写入失败|工作副本状态不可判定|无法创建本项目\s*Cookie\s*工作目录/;
// 身份冲突/未配置：与登录失效无关。
const IDENTITY_FAILURE_RE = /身份|accountId|账户\s*ID/;

/**
 * 把失败类别映射成页面可读的主提示（单一来源，页面不再自己猜类别）。
 * retrying/timeout 不覆盖主文案（行内 note 已带"正在重试/读取超时"），只提供详情。
 */
function buildReadFailureView(kind, reason) {
  const r = reason ? String(reason) : '';
  const short = r.length > 80 ? `${r.slice(0, 80)}…` : r;
  switch (kind) {
    case 'auth':
      return { category: 'login', text: '登录验证未通过', detail: r || '登录验证未通过', requiresLogin: true };
    case 'cookie_invalid':
      return { category: 'cookie_invalid', text: 'Cookie文件异常', detail: r, requiresLogin: false };
    case 'cookie_blocked':
      return { category: 'cookie_blocked', text: 'Cookie读取受阻', detail: r, requiresLogin: false };
    case 'identity':
      return { category: 'identity', text: '身份核验未通过', detail: r, requiresLogin: false };
    case 'retrying':
      return { category: 'retrying', text: null, detail: r, requiresLogin: false };
    case 'timeout':
      return { category: 'timeout', text: null, detail: r, requiresLogin: false };
    default:
      return { category: 'read_failed', text: short ? `读取失败：${short}` : '读取失败', detail: r, requiresLogin: false };
  }
}

/**
 * 当前失败证据分类（页面主提示 + requiresLogin 共用）：
 *  1) 优先当前结构化 lastReadError 的具体分类与 reason；通用 kind=auth 必须再核实
 *     登录正证据，Cookie 解析/结构/读取受阻按具体原因归类，绝不凭 kind 要求扫码；
 *  2) 结构化错误存在时，旧的 today.blockedReason/lastError 不得盖过最新状态
 *     （新 read_failed / 新成功都要压过旧登录文案）；
 *  3) 仅在没有结构化错误时才兼容旧文案中的正式登录失效证据与 Cookie 元信息，
 *     不删除历史告警来伪装健康；过期计算规则不变。
 */
function classifyShopReadFailure(s) {
  if (!s) return null;
  const re = s.lastReadError || null;
  if (re) {
    const reason = re.reason ? String(re.reason) : '';
    let kind = re.kind || 'read_failed';
    if (COOKIE_INVALID_RE.test(reason)) kind = 'cookie_invalid';
    else if (COOKIE_BLOCKED_RE.test(reason)) kind = 'cookie_blocked';
    else if (kind === 'auth' && IDENTITY_FAILURE_RE.test(reason)) kind = 'identity';
    else if (kind === 'auth' && !LOGIN_EXPIRED_POSITIVE_RE.test(reason)) kind = 'read_failed';
    return buildReadFailureView(kind, reason);
  }
  const legacy = [s.lastError, s.today && s.today.blockedReason]
    .find((t) => typeof t === 'string' && LOGIN_EXPIRED_POSITIVE_RE.test(t));
  if (legacy) return buildReadFailureView('auth', String(legacy));
  // Cookie 元信息只在「当前没有成功读回状态」时作为主提示：本店已成功回读 on/off 时，
  // 缺失/异常的 Cookie 元信息不得盖过最新成功（否则就是新的假告警）。
  if (s.lastAdState === 'on' || s.lastAdState === 'off') return null;
  const ci = s.cookieInfo;
  if (ci && ci.found === false) {
    const e = String(ci.error || '');
    if (COOKIE_DEFINITE_EXPIRED_RE.test(e)) return buildReadFailureView('auth', e);
    return buildReadFailureView(COOKIE_INVALID_RE.test(e) ? 'cookie_invalid' : 'cookie_blocked', e);
  }
  return null;
}

function shopRequiresLogin(s) {
  if (!s) return false;
  // 单一来源：结构化分类优先；仅在没有更新结构化错误时才兼容旧登录文案与明确过期证据
  // （classifyShopReadFailure 内部处理），避免 requiresLogin 与页面主提示各说一套。
  // requiresLogin 布尔旧接口保留兼容；Cookie 本地故障、导航失败、身份冲突一律不要求扫码。
  const f = classifyShopReadFailure(s);
  return !!(f && f.requiresLogin === true);
}

function buildShopRows(status) {
  const shops = (status && status.shops) || [];
  return shops
    .filter((s) => s && s.deleted !== true)
    .map((s) => {
      const ad = deriveAdState(status, s);
      const platform = s.platform || 'douyin';
      // 50 元保护/ROI 提示只消费 Monitor 的同店同日受控投影（布尔），
      // 页面/本函数绝不拿 null 当 0 重算费用与费比；跨日即视为无有效提示。
      const businessDate = status && status.businessDate ? status.businessDate : null;
      const todaySameDay = !!(s.today && businessDate && s.today.businessDate === businessDate);
      // 读取失败证据只算一次：主提示、分类字段、requiresLogin 全部同源，避免各店
      // lastError / lastReadError / today 原因互相矛盾（F5-R9）。
      const failView = classifyShopReadFailure(s);
      const readFailure = failView ? {
        category: failView.category,
        text: failView.text ? scrub(String(failView.text)) : null,
        detail: failView.detail ? scrub(String(failView.detail)) : null,
        requiresLogin: failView.requiresLogin === true,
      } : null;
      return {
        id: s.id,
        name: s.name || s.id,
        displayName: s.displayName || s.name || s.id,
        platform,
        platformLabel: platform === 'pinduoduo' ? '拼多多' : '抖店',
        // 推广广告控制仅抖店
        adControl: platform !== 'pinduoduo',
        adState: ad,
        requiresLogin: shopRequiresLogin(s),
        // 读取失败分类与完整原因（页面用于区分"正在重试/读取失败/确证登录失效"）。
        // kind 与主提示同源（login→auth），不保留会被具体原因推翻的通用 auth。
        readErrorKind: readFailure
          ? (readFailure.category === 'login' ? 'auth' : readFailure.category)
          : null,
        readErrorReason: s.lastReadError && s.lastReadError.reason ? scrub(String(s.lastReadError.reason)) : null,
        readRetrying: !!(s.lastReadError && (s.lastReadError.kind === 'retrying' || s.lastReadError.retrying === true)),
        readRetried: !!(s.lastReadError && s.lastReadError.retried === true),
        // 页面主提示的单一来源（F5-R9）：login/cookie_invalid/cookie_blocked/identity/
        // read_failed/retrying/timeout；只有 login 才要求重新扫码，详情原样保留不隐藏。
        readFailure,
        // 有限恢复链（真实投影）：恢复中（x/10）/下次重试时间/已重试10次仍失败
        readRecovery: s.readRecovery || null,
        lastDataAt: s.lastDataAt || (s.today && s.today.fetchedAt) || null,
        costCents: s.today && s.today.costCents != null ? s.today.costCents : null,
        orders: s.today && s.today.orders != null ? s.today.orders : null,
        // 千川可用余额（2026-09-27，账户级只读展示字段；null=本轮未读到，界面显示"未知"）
        balanceCents: s.today && s.today.balanceCents != null ? s.today.balanceCents : null,
        balanceAt: s.today && s.today.balanceAt ? s.today.balanceAt : null,
        thresholdCents: s.thresholdCents != null ? s.thresholdCents : null,
        // 50 元保护/ROI 提示（仅同店同日有效；bool 来自 Monitor 判定投影）
        spendFloorCents: s.spendFloorCents != null ? s.spendFloorCents : SPEND_FLOOR_CENTS,
        spendProtected: todaySameDay ? s.today.spendProtected === true : null,
        pauseEligible: todaySameDay ? s.today.pauseEligible === true : false,
        roiTooLow: !!(todaySameDay && s.today.roiTooLow === true),
        // 目标 ROI（客户 2026-10-11）：界面展示并可修改；缺字段统一按默认 15 展示。
        targetRoi: s.targetRoi != null ? s.targetRoi : 15,
        // 账户身份状态（2026-09-25 阶段 6）：界面据此显示"待身份核验/已阻止"
        identityPending: s.identityPending === true,
        identityNote: s.identityNote ? scrub(String(s.identityNote)) : null,
        // 展示结构一律递归脱敏（today.blockedReason / today.reason / lastError / batchToday…）
        lastError: s.lastError ? scrub(String(s.lastError)) : null,
        today: s.today ? scrubDeep(s.today) : null,
        batchToday: s.batchToday ? scrubDeep(s.batchToday) : null,
      };
    });
}

function createWatchDrill(opts = {}) {
  const logLimit = opts.logLimit || 800;

  const drill = {
    shopName: opts.shopName || '—',
    shops: [],
    // 兼容字段：不再有"强制只读演练"语义（2026-09-15 起接入真实操作模式）
    realMode: false,
    state: {
      running: false,
      status: 'idle',
      cycleRunning: false,
      roundNo: 0,
      startedAt: null,
      stoppedAt: null,
      lastCheckAt: null,
      nextRunAt: null,
      lastError: null,
      lastRound: null,       // 转译后的最近一轮（兼容；多店用 lastRounds）
      shopRows: [],          // 多店铺紧凑行
      lastRounds: {},        // shopId -> 最近一轮
      gates: null,           // 真实执行门槛快照（界面必须让用户看到是否真的会操作广告）
      enableTask: null,      // 独立每日开启任务状态（与 running 完全分离的生命周期）
      polling: null,         // 落地确认/回读的实际生效轮询配置（与执行器同源）
      cookieWriteback: null, // 最近一次会话 Cookie 回写结果（仅元信息，不含任何 Cookie 值）
      phase: null,           // Monitor 调度相位
      windowBlockReason: null,
      enablePhaseToday: [],
      shopDiscovery: null,   // 运行期店铺发现结果（含落盘成功/待重试；第 13 阶段补验证）
      lastLoginJoin: null,   // WD-NEW-1：最近一次“登录成功后立即接管”的状态与结果（页面/返回状态回读用）
      loginJoins: {},        // WD-NEW-1 补修：按 shopId 归档的接管状态（不同店并发互不覆盖）
    },
    _logs: [],
    _seq: 0,
    _persistFile: opts.persistFile || null,
    _now: opts.nowFn || (() => Date.now()),
    _monitor: null,
    _planScheduler: null,   // 后台自动发布排程（独立于"启动值守"；boot 幂等装配）
    _unsubscribe: null,
    _loginJoins: new Map(), // WD-NEW-1 补修：shopId → 在途接管任务（同店合并、结束移除）
    _recoverInflight: new Set(), // R41 scope(3)：单店只读恢复在途锁（同店并发 409，不重复派发）
    _discoveryRecoveries: new Map(), // R78：shopId → 最近一次账户发现前置阻断恢复 promise（观察/测试可等待）
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
    // 只读运行时版本指纹（require.resolve 路径 + 文件 sha256；无密钥）
    _runtimeFingerprint: null,
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

  // ── 飞书通知（Hermes send；每轮巡查判断数据一条）────────────────────────
  // 链路：判断事件（每 30 分钟一轮，evtSeq 幂等去重）→ `hermes send --to <target>`
  // → Hermes 用其已绑定的飞书机器人投递。只发费用/订单/判定的文本摘要，
  // 绝不含 Cookie/密钥；发送失败只记 warn 日志并在 state.notify 如实展示，
  // 绝不影响值守调度本身。
  // 默认关闭：由生产装配方（server.js）显式开启，测试/公开仓库副本不触发真实发送。
  // 目标与 hermes 路径可用环境变量覆盖（WATCH_NOTIFY_TARGET / HERMES_BIN）。
  const notifyOverride = opts.notify || {};
  const notifyCfg = Object.assign({
    enabled: false,
    target: process.env.WATCH_NOTIFY_TARGET || 'feishu:oc_3f06614a465eef6c86262bc33677d9c9',
    timeoutMs: 20000,
  });
  for (const k of Object.keys(notifyOverride)) {
    if (notifyOverride[k] !== undefined) notifyCfg[k] = notifyOverride[k];
  }
  function resolveHermesBin() {
    const candidates = [process.env.HERMES_BIN, 'C:/Users/Administrator/.local/bin/hermes.exe'].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) { /* 换下一个 */ }
    }
    return 'hermes'; // 交给 PATH 解析（公开仓库副本的机器）
  }
  drill._notify = {
    enabled: notifyCfg.enabled === true,
    target: notifyCfg.target,
    lastCycleNo: 0,
    lastAt: null,
    lastStatus: null, // 'ok' | 'failed'
    lastError: null,
  };

  function defaultSpawnNotify(args, input) {
    return new Promise((resolve) => {
      let child;
      try {
        child = require('child_process').spawn(resolveHermesBin(), args, { windowsHide: true });
      } catch (e) {
        return resolve({ code: -1, stderr: String((e && e.message) || e) });
      }
      let err = '';
      const timer = setTimeout(() => { try { child.kill(); } catch (_) { /* 已退出 */ } }, notifyCfg.timeoutMs);
      child.stderr.on('data', (d) => { err += String(d); if (err.length > 4000) err = err.slice(-4000); });
      child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stderr: String((e && e.message) || e) }); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stderr: err }); });
      child.stdin.on('error', () => { /* hermes 提前退出时的 EPIPE：结果以 close 为准 */ });
      child.stdin.end(input);
    });
  }
  const spawnNotify = opts.notifySpawn || defaultSpawnNotify;

  /**
   * 开关结果转译：只认显式字段（decision/metric/zeroClick/blocked/serial/outcome/persistence/targetAction），
   * 不按文案猜动作。返回 { head, line }。
   */
  function translateSwitchResult(j, opts = {}) {
    const dec = j.decision || null;
    const st = j.currentAdState || null;
    const zc = j.zeroClick === true;
    const serial = j.serial || null;
    const outcome = j.outcome || null;
    const blocked = j.blocked || null;
    const persist = j.persistence && j.persistence.ok === false ? 'persistence_blocked' : (outcome === 'persistence_blocked' ? 'persistence_blocked' : null);
    const dry = j.dryRun === true || outcome === 'dry' || outcome === 'dry_failed';
    const mixed = st === 'mixed';
    let actionWord = null;
    if (j.targetAction === 'enable' || dec === 'should_enable') actionWord = '开启';
    else if (j.targetAction === 'pause' || dec === 'should_pause') actionWord = '暂停';
    const safeReason = j.reason ? scrub(String(j.reason)) : '';

    let head;
    let line;
    // 优先级：持久化/串行门/身份数据/回读未确认 > 已达状态 > 计划动作
    if (persist) {
      head = '持久化阻止';
      line = `持久化失败（persistence_blocked），未发出或不释放${actionWord ? `；目标动作=${actionWord}` : ''}${safeReason ? `；${safeReason}` : ''}`;
    } else if (blocked === 'serial_gate' || (blocked && /serial/.test(String(blocked)))) {
      head = '串行门阻止';
      line = `同店动作串行门拒绝（不补点）${actionWord ? `，目标动作=${actionWord}` : ''}${safeReason ? `；${safeReason}` : ''}`;
    } else if (dec === 'data_blocked') {
      head = '数据/身份阻止';
      line = `数据或身份校验未通过 → 零动作${safeReason ? `；${safeReason}` : ''}`;
    } else if (dec === 'unknown_blocked' || st === 'unknown') {
      head = '状态未知';
      line = `当前广告状态 unknown → 零动作（fail-closed）${safeReason ? `；${safeReason}` : ''}`;
    } else if (serial === 'unknown' || outcome === 'partial') {
      head = mixed ? '重新判定' : '回读未确认';
      line = `动作可能已发出但回读未确认 → 保持阻塞，禁止补点${mixed ? '；本轮回读 mixed（非完成态）：用新鲜费用/订单/阈值重判后仅对侧修复一次' : ''}${actionWord ? `；目标动作=${actionWord}` : ''}${safeReason ? `；${safeReason}` : ''}`;
    } else if (dec === 'spend_protected') {
      // 50 元保护优先于 mixed「待收敛」文案：保护区内明确不得暂停，避免日志暗示会统一暂停。
      head = '50元保护';
      const costText = Number.isSafeInteger(j.costCents) ? `${j.costCents} 分（${centsToYuan(j.costCents)} 元）` : '当天消耗';
      line = `${costText} ≤ 50.00 元 → 50元保护：本轮不自动暂停（零动作；不强制重开原关闭项）${mixed ? '；mixed 仅作过渡观测，保持待下一可信重判' : ''}${safeReason ? `；${safeReason}` : ''}`;
    } else if (mixed && (j.status === 'pending' || j.pending === true)) {
      // mixed 不是完成态，也不是成功：待收敛（等待下一次可信回读 + 重判/收敛动作）
      head = '待收敛';
      line = `当前 mixed 只是过渡观测（非完成态）→ 标待处理，零动作：须用本轮新鲜费用/订单/阈值重判后按对侧或统一暂停收敛，不把 mixed 报成本轮成功${safeReason ? `；${safeReason}` : ''}`;
    } else if (dec === 'equal_no_action') {
      head = '保持';
      const cmp = (Number.isSafeInteger(j.costCents) && Number.isSafeInteger(j.orders) && Number.isSafeInteger(j.thresholdCents))
        ? `${j.costCents} 分 = ${j.orders}×${j.thresholdCents} 分`
        : null;
      line = `${cmp ? `整数分判定 ${cmp}` : '等于阈值'} → 保持当前状态，零动作${safeReason ? `；${safeReason}` : ''}`;
    } else if (dec === 'already_on') {
      head = '已开启';
      line = `当前已开启 → 零点击（already_on）${safeReason ? `；${safeReason}` : ''}`;
    } else if (dec === 'already_off') {
      head = '已暂停';
      line = `当前已暂停 → 零点击（already_off）${safeReason ? `；${safeReason}` : ''}`;
    } else if (dec === 'should_enable') {
      head = dry ? '将开启（演练）' : '将开启';
      const cmp = (Number.isSafeInteger(j.costCents) && Number.isSafeInteger(j.orders) && Number.isSafeInteger(j.thresholdCents))
        ? `${j.costCents} 分 < ${j.orders}×${j.thresholdCents} 分`
        : null;
      line = `${cmp ? `整数分判定 ${cmp}；` : ''}${mixed ? 'mixed：只开启暂停项（对侧；mixed 非完成态，须全量回读确认才算收敛）' : '低于阈值'} → ${dry ? '演练枚举将开启' : '触发开启'}${safeReason ? `；${safeReason}` : ''}`;
    } else if (dec === 'should_pause') {
      head = dry ? '将暂停（演练）' : '将暂停';
      const cmp = (Number.isSafeInteger(j.costCents) && Number.isSafeInteger(j.orders) && Number.isSafeInteger(j.thresholdCents))
        ? `${j.costCents} 分 > ${j.orders}×${j.thresholdCents} 分`
        : null;
      const mixedNote = mixed
        ? (j.metric === 'equal'
          ? 'mixed：等于阈值按「统一暂停」收敛 off，仅点击仍开启的项（mixed 非完成态，须全量回读确认才算收敛）'
          : 'mixed：只暂停开启项（对侧；mixed 非完成态，须全量回读确认才算收敛）')
        : '高于阈值';
      line = `${cmp ? `整数分判定 ${cmp}；` : ''}${mixedNote} → ${dry ? '演练枚举将暂停' : '触发暂停'}${safeReason ? `；${safeReason}` : ''}`;
    } else if (j.status === 'blocked') {
      head = '本轮被拦下';
      line = `本轮被拦下；原因：${safeReason || '未知'}`;
    } else if (j.over === true && Number.isSafeInteger(j.costCents) && Number.isSafeInteger(j.orders) && Number.isSafeInteger(j.thresholdCents)) {
      head = dry ? '将暂停（演练）' : '将暂停';
      line = `整数分判定 ${j.costCents} 分 > ${j.orders}×${j.thresholdCents} 分${actionWord ? `，目标动作=${actionWord}` : ''}${safeReason ? `；${safeReason}` : ''}`;
    } else if (j.over !== true && Number.isSafeInteger(j.costCents) && Number.isSafeInteger(j.orders) && Number.isSafeInteger(j.thresholdCents)) {
      const exp = j.orders * j.thresholdCents;
      const op = j.costCents < exp ? '<' : (j.costCents === exp ? '=' : '>');
      head = op === '=' ? '保持' : (op === '<' ? '未超标' : '超标');
      line = `整数分判定 ${j.costCents} 分 ${op} ${j.orders}×${j.thresholdCents} 分${actionWord ? `，目标动作=${actionWord}` : '，零动作'}${zc ? '；zeroClick' : ''}${safeReason ? `；${safeReason}` : ''}`;
    } else {
      head = j.over === true ? '超标' : '未超标';
      line = `${actionWord ? `目标动作=${actionWord}` : '零动作'}${zc ? '；zeroClick' : ''}${safeReason ? `；${safeReason}` : ''}`;
    }
    // ROI 提示只进入本地日志/界面；既有多轮飞书通知不因本次规则外发新提示。
    const roiWarn = j.roiTooLow === true && opts.includeRoiWarn !== false
      ? '；ROI设置过低：消耗已超过50元且费比超标（仅提示，不自动修改 ROI）'
      : '';
    return { head, line: line + roiWarn };
  }

  /** 组装一轮判断数据的推送文案（纯文本；主题/正文均经 scrub，无敏感信息）。 */
  function judgementNotify(j) {
    const at = j.at ? shanghaiClockText(new Date(j.at).getTime()) : '—';
    const lines = [];
    const t = translateSwitchResult(j, { includeRoiWarn: false });
    if (j.status === 'blocked') {
      lines.push(`第 ${j.cycleNo} 轮巡查被拦下，未得出费用/订单结论`);
      lines.push(`原因：${scrub(String(j.reason || '未知'))}`);
    } else {
      const cost = j.costCents == null ? '—' : `${centsToYuan(j.costCents)} 元`;
      const orders = j.orders == null ? '—' : `${j.orders} 单`;
      const perOrder = j.perOrderText || '—';
      lines.push(`第 ${j.cycleNo} 轮巡查数据（业务日期 ${j.businessDate || '—'}）`);
      lines.push(`店铺：${(drill.shops || []).map((s) => (s.platform === 'pinduoduo' ? '拼多多/' : '抖店/') + s.name).join('，') || drill.shopName}`);
      lines.push(`当天费用：${cost} ｜ 全店订单：${orders} ｜ 每单成本：${perOrder}`);
      lines.push(`判定：${t.line}`);
    }
    lines.push(`巡查时间：${at}`);
    const head = j.status === 'blocked' ? '本轮被拦下' : t.head;
    return {
      subject: scrub(`[推广值守] 第${j.cycleNo}轮 ${head}`),
      body: scrub(lines.join('\n')),
    };
  }

  async function notifyJudgement(j) {
    const n = drill._notify;
    if (!n.enabled || !j) return;
    const cycleNo = typeof j.cycleNo === 'number' ? j.cycleNo : 0;
    if (cycleNo && cycleNo <= n.lastCycleNo) return; // 幂等：同一轮只推一次
    if (cycleNo) n.lastCycleNo = cycleNo;
    const { subject, body } = judgementNotify(j);
    const r = await spawnNotify(
      ['send', '--to', n.target, '--subject', subject, '--file', '-'],
      body + '\n'
    );
    n.lastAt = new Date(drill._now()).toISOString();
    if (r && r.code === 0) {
      n.lastStatus = 'ok';
      n.lastError = null;
    } else {
      n.lastStatus = 'failed';
      n.lastError = scrub(String((r && (r.stderr || r.error)) || `hermes send 退出码 ${r ? r.code : '未知'}`));
      pushLog('warn', `飞书通知发送失败（第 ${j.cycleNo} 轮）：${n.lastError.slice(0, 200)}`);
    }
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
    // 2026-10-09：首查时刻（firstCheckMinuteOfDay，默认 5=00:05），与核心 chengfang-gate 同源口径。
    const _fcm = (Number.isInteger(cf.firstCheckMinuteOfDay) && cf.firstCheckMinuteOfDay >= 0 && cf.firstCheckMinuteOfDay <= 1439) ? cf.firstCheckMinuteOfDay : 5;
    const _fct = String(Math.floor(_fcm / 60)).padStart(2, '0') + ':' + String(_fcm % 60).padStart(2, '0');

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

    // 落地确认/回读轮询的**实际生效值**（2026-09-16 统一）：
    // 直接复用执行器同一份解析（src/lib/bounded-poll.js），页面展示值 === 执行器生效值，
    // 杜绝"页面/报告说 30 秒/3 秒、生产实际 15 秒/2 秒"的漂移。
    let polling;
    try {
      const { resolvePollingConfig } = require(path.join(PROMO_GUARD_DIR, 'src/lib/bounded-poll.js'));
      polling = resolvePollingConfig(exec);
    } catch (_) {
      polling = { timeoutMs: null, intervalMs: null, timeoutSource: 'unavailable', intervalSource: 'unavailable' };
    }

    return {
      realMode,
      pauseEnabled,
      enableEnabled,
      dryRun,
      polling,
      // 配置里声明的模式（供"首次启动前"如实展示；未知不臆断）
      configuredRealMode: exec.realMode === true,
      modeKnown: typeof exec.realMode === 'boolean',
      // 未知模式 → 待核实（不得默认宣称演练安全）
      modeText: (typeof exec.realMode !== 'boolean')
        ? '待核实（配置缺少 execution.realMode，不得据此认为安全）'
        : (realMode ? '真实执行' : '演练模式（不操作广告）'),
      scope: Array.isArray(cf.scope) ? cf.scope.slice() : [],
      // 2026-10-09 取消 enableHour/07:00 固定开启；改 firstCheckMinuteOfDay（默认 5=00:05）。
      firstCheckMinuteOfDay: _fcm,
      firstCheckTime: _fct,
      enableHour: cf.enableHour, // [废弃] 仅供兼容展示；调度与门槛不再读取
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
      ? { ...ms.enableScheduler, firstCheckMinuteOfDay: ms.firstCheckMinuteOfDay, firstCheckTime: ms.firstCheckTime, dailyStartHour: ms.dailyStartHour }
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
      // 测试可注入广告状态 fixture；生产缺省走 Monitor 默认读取
      readAdState: opts.readAdState || undefined,
      // 值守补发（2026-10-26）：Monitor 只在完整周期收口后回调；桥内隐藏子进程触发
      // 独立发布器，失败只记日志，绝不进入巡查决策路径。opts.onPollComplete 可覆盖用于测试。
      onPollComplete: opts.onPollComplete || ((info) => { try { triggerPatrolPlanRefill(info); } catch (_) { /* 桥失败不影响值守 */ } }),
    });
    drill._monitor = monitor;
    // 多店铺：结构化列表 + 兼容拼接名（仅用于标题；数据行绝不拼串）
    const activeShops = (cfgResult.config.shops || []).filter((s) => s && s.deleted !== true);
    drill.shops = activeShops.map((s) => ({
      id: s.id,
      name: s.displayName || s.name || s.id,
      platform: s.platform || 'douyin',
    }));
    drill.shopName = drill.shops.map((s) => s.name).join('、') || '—';
    drill.realMode = monitor.realMode === true;

    // 门槛快照（fail-closed 依据；界面必须可见；此后每轮 refreshGates 重读）
    const g = refreshGates();
    collectRuntimeFingerprint();
    pushLog('info',
      `值守装配完成 · 店铺 ${drill.shopName} · 模式：${monitor.realMode ? '真实执行' : '演练模式（不操作广告）'}`);
    pushLog('info',
      `门槛：realMode=${g.realMode} / 暂停开关=${g.pauseEnabled} / 开启开关=${g.enableEnabled}`
      + `；真实暂停${g.pauseWillExecute ? '会执行' : '不会执行'}，真实开启${g.enableWillExecute ? '会执行' : '不会执行'}`
      + `；控制范围=${g.scope.join('+') || '（未配置）'}；删除广告=永不执行。`);
    return monitor;
  }

  // ── 后台自动发布排程装配（客户 2026-10-11）────────────────────────────────
  // 与"启动值守"完全独立：boot 幂等装配一次；默认未配置（enabled/autoConfirm=false）不发布。
  // 真实发布执行器**默认直接接 publisher 正式递归入口 runScheduledPlan**（不再需要注入或
  // POST）；publisher 不可用时如实 blocked，绝不 stub/throw 假冒发布。店铺名单动态读取当前
  // 未删除店。readDaySuccess 读同店 namespace 的真实今日成功数（含手动），不可知一律抛错。
  function configShopByIdOrName(shopId) {
    const shops = ((drill._config && drill._config.shops) || []);
    return shops.find((s) => s && (String(s.id) === String(shopId) || String(s.name) === String(shopId)
      || String(s.displayName) === String(shopId))) || null;
  }
  // R42 scope(S7)：正式 run 返回**未知但明确是"管理页读取失败"这一只读可回读错误**时的自动衔接。
  // 只在原 run promise 完全 settled、publisher 内部锁已释放后，做**至多一次**同店同日只读回读
  // （复用既有 defaultPlanRecover → publisher.recoverShopDayReadback），绝不重放发布、绝不再调
  // runScheduledPlan、绝不走 HTTP recover 端点（其持久排程锁此刻可能正被本次调度占用）。
  // 仅当回读证明 recovered 且店名/账户（business 运行时解析）/业务日/份数/确认号/manifest 逐字
  // 一致、planId 合法时才把该次返回映射为 success；其余（closed/alreadyReconciled/unknown/
  // 字段漂移或缺失）一律原样保留 unknown+noReplay 与原 reason，只把只读回读结果作为辅助事实，
  // 绝不伪装成功、绝不自动再次恢复。已成功/预发布阻断/非管理页只读错误一律不触发恢复。
  const RECOVERABLE_READBACK_REASONS = Object.freeze(['management-row-or-required-fields-timeout', 'management-row-read-failed']);
  // R42 scope(S11)：准备停滞的账本释放**不再**绑定某一条固定原因文字，改为逐字比对 publisher
  // 耐久 preparationClosureFacts 证明（见 strictPreparationFact）：店/业务日/份号/排程 runId 与
  // 原 reason 全部一致、且零消费证明结构完整才释放；任意 scheduled-run-exception 或仅凭状态
  // 文字一律不释放。
  function runUnknownIsRecoverableReadback(r, o) {
    if (!r || r.status !== 'unknown') return false;
    if (!RECOVERABLE_READBACK_REASONS.includes(String(r.reason || ''))) return false;
    // 原返回必须自带完整身份字段（缺一即拒绝），且份数与本次派发一致。
    if (r.planNumber == null || r.businessDate == null || r.confirmationId == null || r.manifestHash == null) return false;
    if (String(r.planNumber) !== String(o && o.planNumber)) return false;
    if (String(r.businessDate) !== String(o && o.businessDate)) return false;
    return true;
  }
  function mapRecoverProofToRunResult(r, proof, business) {
    const pid = String((proof && proof.planId) || '');
    const account = business && business.accountId != null ? String(business.accountId) : '';
    const same = !!proof && proof.ok === true && proof.status === 'recovered'
      && String(proof.shop || '') === String((business && business.shop) || '')
      && account !== '' && String(proof.accountId || '') === account
      && String(proof.businessDate || '') === String(r.businessDate)
      && String(proof.planNumber) === String(r.planNumber)
      && String(proof.confirmationId || '') === String(r.confirmationId || '')
      && String(proof.manifestHash || '') === String(r.manifestHash || '')
      && /^\d{12,20}$/.test(pid);
    if (!same) return null;
    return {
      ...r, status: 'success', reason: null, noReplay: false,
      planId: pid, planNumber: Number(r.planNumber), businessDate: r.businessDate,
      confirmationId: r.confirmationId, manifestHash: r.manifestHash,
      recoveredBy: 'scheduled-readback-recovery',
      // 开启结论只透传证明里的**真实**读数：already-enabled → 排程侧零开启请求；其余（含缺失）
      // 如实 unknown-current-state，交由既有开启钩子核实，绝不在此伪装已开启成功。
      postPublishEnable: {
        status: proof.enableStatus != null ? String(proof.enableStatus) : 'unknown-current-state',
        reason: null, actionTaken: false,
      },
    };
  }
  function defaultPlanRunPlan(business, o, extraDi) {
    const rp = publisherRequire('run-plans.cjs');
    if (!rp || typeof rp.runScheduledPlan !== 'function') {
      return Promise.resolve({ status: 'blocked', reason: 'publisher-scheduled-entry-unavailable', noAction: true, noReplay: true, authorizedBy: 'recurring-user-policy', humanApproved: false });
    }
    // 每次读取**当前**授权与**当前**店配置（不缓存快照、不从已冻结的 business 反推）：
    // publisher 在初始消费/点击前与最终消费/点击前各自再调一次，页面关闭或改参数后
    // 立即零未来点击。
    const currentPolicy = () => {
      const s = drill._planScheduler && typeof drill._planScheduler.state === 'function' ? drill._planScheduler.state() : null;
      return (s && s.config) || (drill._config && drill._config.planPublishing) || null;
    };
    const currentShop = () => configShopByIdOrName(business && business.shop);
    const planOpts = {
      planNumber: o && o.planNumber, businessDate: o && o.businessDate,
      plansPerShopPerDay: o && o.plansPerShopPerDay, autoConfirm: o && o.autoConfirm,
      authorizedBy: o && o.authorizedBy, dailyBudget: o && o.dailyBudget, roi: o && o.roi,
      // R42 scope(S8/A)：内部免审核后台发布一律走既有 opener 的 headless:true（实测无窗口
      // headless 只读恢复在同 Cookie/账户下可完整翻页选品，而原可视窗口会在准备阶段停滞）。
      // 手动人工预览/发布（publisher main / inspectRecoveryOnly）保留原可视行为，不经过本工厂。
      headless: true,
      // 正式传现有已验证核心目录作 adapter project root：部署机未配置 PROMO_PROJECT_ROOT
      // env 时 guard.resolveProjectRoot 会直接抛错（真实部署阻断），工厂必须自带该参数。
      projectRoot: PROMO_GUARD_DIR,
      policyProvider: currentPolicy, currentShopProvider: currentShop,
      nowMs: drill._now, onLog: (lvl, msg) => pushLog(lvl, msg),
    };
    // extraDi 只用于离线测试替换外部边界（openShop/readers/driversFactory/stateRoot/clock），
    // 不新增任何生产分支：生产调用从不传该参数。
    if (extraDi && typeof extraDi === 'object') Object.assign(planOpts, extraDi);
    return rp.runScheduledPlan(business, planOpts).then((r) => {
      // R42 scope(S11)：准备停滞且带耐久零消费证明 → 本次 tick 之后按证明收口账本该份，
      // 使本日剩余未发布份数可继续（只按证明、不伪造成功）。
      queuePreparationLedgerRelease(business, r);
      // 原 run 已完全 settled（publisher 锁已释放）。只有"明确的管理页读取失败"这一只读可回读
      // 未知才尝试恢复；已成功/预发布阻断/其他未知一律原样返回，零额外动作。
      if (!runUnknownIsRecoverableReadback(r, o)) return r;
      const shopRow = configShopByIdOrName(business && business.shop);
      if (!shopRow || shopRow.deleted === true) {
        return { ...r, recovery: { performed: false, reason: 'recover-shop-unavailable' } };
      }
      // 至多一次只读回读；绝不重放、绝不并发（在原 run promise 链内串行）。
      return Promise.resolve(defaultPlanRecover(shopRow, String(r.businessDate), extraDi)).then((proof) => {
        const mapped = mapRecoverProofToRunResult(r, proof, business);
        if (mapped) return mapped;
        // 未证明成功：保留原 unknown/noReplay/reason，只附加只读回读原结果作辅助事实。
        return { ...r, recovery: { performed: true, proof: scrubDeep(proof) || null } };
      });
    }, (e) => ({ status: 'unknown', reason: 'scheduled-entry-rejected:' + ((e && e.message) || e), noReplay: true }));
  }
  function defaultPlanReadDaySuccess(shopId, businessDate, extraDi) {
    const rp = publisherRequire('run-plans.cjs');
    if (!rp || typeof rp.readDaySuccessForShop !== 'function') throw new Error('publisher-day-success-reader-unavailable');
    const shop = configShopByIdOrName(shopId);
    if (!shop) throw new Error('day-success-shop-not-found:' + shopId);
    return rp.readDaySuccessForShop({ shop: shop.name, accountId: shop.accountId != null ? shop.accountId : null }, businessDate,
      { ...(extraDi && typeof extraDi === 'object' ? extraDi : {}) });
  }
  // 运行时身份发现：配置 accountId=null 的店用 publisher 既有生产 openShop + 严格同店
  // Cookie 身份验证取真实账户（只读、零广告动作、关闭前保存 Cookie）。不预先 blocked、
  // 不要求人工填号、绝不借其它店身份、绝不硬编码任何店名。
  function defaultPlanDiscoverAccount(shopConfig, business, extraDi) {
    const rp = publisherRequire('run-plans.cjs');
    if (!rp || typeof rp.discoverShopAccountByLiveSession !== 'function') return { error: 'discovery-capability-unavailable' };
    // headless 与 runPlan 始终一致（内部免审核后台发布一律无窗口）；extraDi 仅离线测试可覆盖外部边界。
    return rp.discoverShopAccountByLiveSession(shopConfig, business,
      { nowMs: drill._now, projectRoot: PROMO_GUARD_DIR, headless: true, ...(extraDi && typeof extraDi === 'object' ? extraDi : {}) });
  }
  // R41 scope(3)：显式受信任「排程只读回读恢复」入口（publisher.recoverShopDayReadback）。
  // 只读回读、单店精确、绝不重放发布；proven 事实由 publisher 侧耐久落盘，本侧只映射账本。
  function defaultPlanRecover(shop, businessDate, extraDi) {
    const rp = publisherRequire('run-plans.cjs');
    if (!rp || typeof rp.recoverShopDayReadback !== 'function') {
      return Promise.resolve({ ok: false, status: 'failed', reason: 'publisher-recovery-entry-unavailable' });
    }
    const planOpts = { nowMs: drill._now, projectRoot: PROMO_GUARD_DIR };
    // extraDi 仅离线测试注入外部边界（loadConfig/openShop/readers/stateRoot…）；生产从不传。
    if (extraDi && typeof extraDi === 'object') Object.assign(planOpts, extraDi);
    return Promise.resolve(rp.recoverShopDayReadback(
      { shop: shop.name, accountId: shop.accountId != null ? String(shop.accountId) : null },
      businessDate, planOpts,
    )).then((r) => r, (e) => ({ ok: false, status: 'failed', reason: 'recovery-entry-rejected:' + ((e && e.message) || e) }));
  }
  // ── F1：陈旧在途（崩溃遗留 in-progress）的本地准备恢复（无浏览器、无 Cookie）──────────
  // 真实故障：进程在 preparing 相位被杀 → 账本只留 entries[n].status=in-progress，tick 直接
  // 终态 unknown 后再也不派发；publisher 侧 active 仍是 preparing，而既有只读恢复先 openShop，
  // Cookie 失效时永远走不到它的 preparing 收口分支。本钩子只走 publisher 的纯文件严格证明
  // （recoverLocalPreparationClose：锁内新鲜回读 + 既有零消费正面证明 + 既有耐久收口），
  // 再经**唯一** applySchedulerReleaseToRecord 把该条在途映射为可重试 unsubmitted。
  // 绝不打开浏览器、绝不重放发布、绝不伪造成功；锁忙/证明不齐/身份或份号漂移/源字节漂移
  // 一律 applied:false 并带回具体原因，本店保持原 unknown 终态。
  function staleInProgressShape(rec) {
    if (!rec || typeof rec !== 'object') return null;
    if (rec.status !== 'unknown') return null;
    if (String(rec.error || '') !== 'unresolved-in-progress-no-replay') return null;
    const entries = rec.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null;
    const keys = Object.keys(entries).filter((k) => entries[k] && entries[k].status === 'in-progress');
    if (keys.length !== 1) return null;
    const e = entries[keys[0]];
    if (!e || Number(e.planNumber) !== Number(keys[0])) return null;
    if (typeof e.startedAt !== 'string' || e.startedAt === '') return null;
    return { planNumber: Number(e.planNumber), startedAt: e.startedAt };
  }
  async function defaultPlanRecoverStalePreparation(shop, meta) {
    const m = meta && typeof meta === 'object' ? meta : {};
    const shopId = String(m.shopId != null ? m.shopId : (shop && (shop.id != null ? shop.id : shop.name)) || '');
    const shopRow = configShopByIdOrName(shopId);
    if (!shopRow || shopRow.deleted === true) return { applied: false, reason: 'stale-recovery-shop-unavailable' };
    const shape = staleInProgressShape(m.rec);
    if (!shape) return { applied: false, reason: 'stale-recovery-not-stale-in-progress-shape' };
    const businessDate = String(m.businessDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return { applied: false, reason: 'stale-recovery-business-date-invalid' };
    const rp = publisherRequire('run-plans.cjs');
    if (!rp || typeof rp.recoverLocalPreparationClose !== 'function'
      || typeof rp.currentPreOpenSourceHash !== 'function' || typeof rp.sha256Hex !== 'function') {
      return { applied: false, reason: 'stale-recovery-publisher-capability-unavailable' };
    }
    const cfgAccount = shopRow.accountId != null && String(shopRow.accountId) !== '' ? String(shopRow.accountId) : null;
    const recordSnapshot = JSON.stringify(m.rec);
    // extraDi 仅离线测试注入外部边界（stateRoot/nowMs/故意抛错的 openShop 计数探针）；生产从不传。
    const di = { nowMs: drill._now };
    if (opts.planStaleRecoverDi && typeof opts.planStaleRecoverDi === 'object') Object.assign(di, opts.planStaleRecoverDi);
    let proof = null;
    try {
      proof = await Promise.resolve(rp.recoverLocalPreparationClose(
        { shop: shopRow.name, accountId: cfgAccount }, businessDate,
        { ...di, planNumber: shape.planNumber },
      ));
    } catch (e) {
      return { applied: false, reason: 'stale-recovery-threw:' + scrub(String((e && e.message) || e)) };
    }
    if (!proof || proof.ok !== true || proof.status !== 'preparationClosed') {
      return { applied: false, reason: 'stale-recovery-not-proven:' + scrub(String((proof && proof.reason) || 'unknown')) };
    }
    // A：cfgAccount=null（legacy 店配置没有 accountId）绝不能当成"身份已证明"。必须使用
    // publisher 从默认 profile/own identity 解析出的可信账号，并把它逐字绑定进释放证明。
    const boundAccount = cfgAccount !== null ? cfgAccount : String(proof.accountId || '');
    if (!/^\d{6,24}$/.test(boundAccount)) {
      return { applied: false, reason: 'stale-recovery-account-identity-unavailable' };
    }
    // 逐字绑定：店名/账户/业务日/份号必须与本次派发上下文完全一致，否则零改动。
    if (String(proof.shop || '') !== String(shopRow.name)) return { applied: false, reason: 'stale-recovery-shop-binding-drift' };
    if (String(proof.accountId || '') !== boundAccount) return { applied: false, reason: 'stale-recovery-account-binding-drift' };
    if (String(proof.businessDate || '') !== businessDate) return { applied: false, reason: 'stale-recovery-date-binding-drift' };
    if (Number(proof.planNumber) !== shape.planNumber) return { applied: false, reason: 'stale-recovery-plan-binding-drift' };
    const fact = proof.preparationClosure;
    const strictFact = fact && typeof fact === 'object' ? strictPreparationFact(fact) : null;
    if (!strictFact || strictFact.planNumber !== shape.planNumber || strictFact.businessDate !== businessDate
      || strictFact.shop !== String(shopRow.name) || strictFact.accountId !== boundAccount) {
      return { applied: false, reason: 'stale-recovery-fact-not-strict' };
    }
    // CAS：证明绑定的源字节（状态 + attempts + 独立发布事实面 + identity）必须仍是当前字节。
    let freshHash = null;
    try {
      const extraFiles = Array.isArray(proof.sourceExtraFiles) ? proof.sourceExtraFiles : [];
      freshHash = rp.currentPreOpenSourceHash(proof.sourceStateFile, proof.sourceAttemptsFile, extraFiles);
    } catch (_) { freshHash = null; }
    if (typeof freshHash !== 'string' || freshHash !== String(proof.sourceHash || '')) {
      return { applied: false, reason: 'stale-recovery-source-drift' };
    }
    // 账本记录在异步恢复期间不得漂移（tick 持排程进程锁；仍逐字复核）。
    if (JSON.stringify(m.rec) !== recordSnapshot) return { applied: false, reason: 'stale-recovery-record-drift' };
    const releaseProof = {
      method: 'scheduler-release-prepublication',
      status: 'scheduler-release-prepublication',
      businessDate, shop: shopId, planNumber: shape.planNumber,
      accountId: boundAccount,
      recStatus: 'unknown', entryStatus: 'in-progress',
      entryReasonHash: rp.sha256Hex(undefined),
      entryStartedAt: shape.startedAt,
      entryProvenanceMethod: 'local-preparation-closed',
      sourceHash: String(proof.sourceHash),
      sourceStateFile: proof.sourceStateFile,
      sourceAttemptsFile: proof.sourceAttemptsFile,
      preparationClosureProof: {
        method: 'local-preparation-closed', businessDate, shop: shopId,
        publisherShop: String(shopRow.name), accountId: boundAccount,
        planNumber: shape.planNumber, runId: String(strictFact.runId),
        reason: String(strictFact.reason), closedAt: strictFact.closedAt || null,
        entryStartedAt: shape.startedAt,
        zeroConsumptionProof: fact.zeroConsumptionProof,
        sourceHash: String(proof.sourceHash),
      },
    };
    if (!strictSchedulerReleaseProof(releaseProof)) return { applied: false, reason: 'stale-recovery-release-proof-not-strict' };
    // 唯一账本映射：与显式释放/策略撤销共用同一 applyRecoverProofToLedger →
    // applySchedulerReleaseToRecord 判据，绝不第二套宽松实现。
    const ledgerView = { days: { [businessDate]: { shops: { [shopId]: m.rec } } } };
    const cfgNow = m.cfg && typeof m.cfg === 'object' ? m.cfg : {};
    const mapped = applyRecoverProofToLedger(ledgerView, businessDate, shopId, releaseProof, cfgNow);
    if (!mapped.changed) return { applied: false, reason: 'stale-recovery-ledger-not-applicable' };
    const audited = appendRecoveryAudit({
      at: new Date(drill._now()).toISOString(), shopId, shopName: shopRow.name || null,
      businessDate, trigger: 'local-preparation-recovery',
      proof: scrubDeep(releaseProof), ledgerChanged: true,
      recAfter: mapped.rec ? scrubDeep(JSON.parse(JSON.stringify(mapped.rec))) : null,
    });
    pushLog('info', `陈旧在途已按本地准备恢复收口（店 ${shopId}，日 ${businessDate}，第 ${shape.planNumber} 份）：publisher 严格零消费证明 + 锁内新鲜回读 + 源字节 CAS 齐全 → 该份转 preparation-stopped，记录转 unsubmitted，本日缺额按既有调度补发；未打开浏览器${audited.ok ? '' : '（审计写入失败：' + audited.reason + '）'}`);
    return { applied: true, rec: mapped.rec, proof: releaseProof, fact, planNumber: shape.planNumber, runId: strictFact.runId };
  }
  // R42 scope(S11)：准备收口"真实证明"判据。只接受 publisher 耐久 preparationClosureFacts 事实
  // 本体（或携带同一事实的证明对象）：phase preparing、原 reason 非空、业务日合法且与排程
  // runId 内嵌日期一致、份号为正整数、店名/账户字段齐备、六个零消费字段逐字为 0/0/0/0/false/false。
  // 缺任一字段、任意值、伪造结构或非排程 runId 一律不算证明——绝不凭状态文字或任意
  // scheduled-run-exception 释放账本。
  function strictPreparationFact(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (raw.status !== 'preparationClosed' || raw.phase !== 'preparing') return null;
    const reason = typeof raw.reason === 'string' ? raw.reason.trim() : '';
    if (!reason || reason.length > PREPARATION_REASON_MAX_LEN) return null;
    const businessDate = String(raw.businessDate || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) return null;
    const runId = String(raw.runId || '');
    const origin = /^plan-scheduler-(\d{4}-\d{2}-\d{2})-[0-9a-f]{16}$/.exec(runId);
    if (!origin || origin[1] !== businessDate) return null;
    const planNumber = Number(raw.planNumber);
    if (!Number.isInteger(planNumber) || planNumber < 1 || planNumber > 10) return null;
    const shop = typeof raw.shop === 'string' ? raw.shop.trim() : '';
    const accountId = String(raw.accountId || '');
    if (!shop || !/^\d{12,20}$/.test(accountId)) return null;
    const p = raw.zeroConsumptionProof;
    if (!p || typeof p !== 'object' || Array.isArray(p) || Object.keys(p).length !== 6) return null;
    if (p.initialConsumptions !== 0 || p.finalConsumptions !== 0 || p.reopenConsumptions !== 0
      || p.manualUnresolved !== 0 || p.plansContainsNumber !== false || p.confirmationConsumptionsRecorded !== false) return null;
    return { reason, businessDate, runId, planNumber, shop, accountId, source: String(raw.source || ''), closedAt: raw.closedAt || null };
  }
  // 恢复结论 → 排程账本映射（唯一的账本写入路径；除下列两种证明外一律不动账本）：
  //  * proof.status='recovered'：该 planNumber 条目当前为 unknown/in-progress/blocked 时
  //    升为 success（携带证明的 planId），plans=账本 entry 真相重算；无剩余未决 → 店恢复
  //    partial/success（今日剩余份数可继续）；仍有其他未决条目 → 保持原状态（诚实）。
  //  * proof.status='closed'：旧 enable-stopped 已证明并发布成功——**仅当**本日零消费
  //    （plans=0、无 in-progress、全部条目 unknown/blocked 且原因都是恢复门"在任何消费之前
  //    停止"）才释放为 pending（未执行的 blocked 记录归还本日份数）。
  //  * 其他（unknown/blocked/failed/nothingToRecover/alreadyReconciled 以外）：零改动。
  function applyRecoverProofToLedger(ledger, businessDate, shopId, proof, cfg) {
    // 有效份数上限：优先该店已保存且合法的 plansPerShopPerDay（整数 1..10），否则回落全局
    // cfg.plansPerShopPerDay（1..3），再否则 3。与调度器 resolveShopPlansPerDay 同一优先级——
    // 回读/收口判据必须对齐**本店**实际上界，绝不能用全局 3 把第 4 份在 6 上界下误判为 success。
    const globalPlans = Number.isInteger(cfg && cfg.plansPerShopPerDay) ? cfg.plansPerShopPerDay : 3;
    const shopRowForLimit = configShopByIdOrName(shopId);
    const plansPerShopPerDay = (shopRowForLimit && Number.isInteger(shopRowForLimit.plansPerShopPerDay)
      && shopRowForLimit.plansPerShopPerDay >= 1 && shopRowForLimit.plansPerShopPerDay <= 10)
      ? shopRowForLimit.plansPerShopPerDay : globalPlans;
    const dayRec = ledger && ledger.days && ledger.days[businessDate] && ledger.days[businessDate].shops;
    const rec = dayRec ? dayRec[String(shopId)] : null;
    if (!rec || !proof) return { changed: false, rec: rec || null };
    const entries = rec.entries || {};
    if (proof.status === 'recovered' && proof.planNumber != null) {
      const key = String(proof.planNumber);
      const e = entries[key];
      if (!e || !['unknown', 'in-progress', 'blocked'].includes(e.status)) return { changed: false, rec };
      entries[key] = {
        planNumber: Number(key), status: 'success', planId: String(proof.planId || ''),
        manifestHash: proof.manifestHash || e.manifestHash || null,
        recovered: true, at: new Date(drill._now()).toISOString(),
      };
      rec.plans = Math.max(Number(rec.plans) || 0, countSuccessEntries(rec));
      const unresolvedLeft = Object.keys(entries).some((k) => ['unknown', 'in-progress', 'failed'].includes(entries[k].status));
      if (!unresolvedLeft) {
        rec.status = rec.plans >= plansPerShopPerDay ? 'success' : 'partial';
        rec.error = null;
      }
      rec.lastAt = new Date(drill._now()).toISOString();
      return { changed: true, rec };
    }
    if (proof.status === 'closed') {
      const keys = Object.keys(entries);
      const preConsumptionBlocked = (Number(rec.plans) || 0) === 0 && !hasInProgress(rec)
        && keys.length > 0
        && keys.every((k) => ['unknown', 'blocked'].includes(entries[k].status))
        && keys.every((k) => /^read-only-recovery-required/.test(String(entries[k].reason || ''))
          || /^scheduled-policy-drift-before-initial/.test(String(entries[k].reason || '')));
      if (!preConsumptionBlocked) return { changed: false, rec };
      rec.releasedFrom = {
        status: rec.status, plans: rec.plans, error: rec.error || null,
        entries: JSON.parse(JSON.stringify(entries)), closedBusinessDate: proof.closedBusinessDate || null,
        planId: proof.planId || null,
      };
      rec.status = 'pending'; rec.plans = 0; rec.entries = {}; rec.error = null;
      rec.releasedAt = new Date(drill._now()).toISOString();
      rec.lastAt = rec.releasedAt;
      return { changed: true, rec };
    }
    if (proof.status === 'preparationClosed') {
      // R42 scope(S11)：publisher 已耐久证明本店本日该份**从未进入任何消费**（无 frozen/CID/
      // 初始/最终/reopen/手动未决）。释放判据 = 严格同店 / 同业务日 / 同份号 / 同排程 runId /
      // 与原条目 reason 逐字一致的真实 preparationClosureFacts 证明；缺证明、证明字段漂移
      // （runId 非本店本日、份号不符、零消费结构不全）、店身份不符、条目非该 reason 的 unknown
      // （publish-unknown、blocked、成功条目、其它原因）一律零改动，绝不伪装成功、绝不清理账本。
      const f = strictPreparationFact(proof.preparationClosure && typeof proof.preparationClosure === 'object'
        ? proof.preparationClosure : proof);
      if (!f) return { changed: false, rec };
      // 证明外层字段必须齐备且与事实本体逐字一致（不允许"外层缺字段/外层新、内层旧"的拼接证明）。
      if (proof.businessDate == null || proof.runId == null || proof.planNumber == null || proof.reason == null) return { changed: false, rec };
      if (String(proof.businessDate) !== f.businessDate) return { changed: false, rec };
      if (String(proof.runId) !== f.runId) return { changed: false, rec };
      if (String(proof.planNumber) !== String(f.planNumber)) return { changed: false, rec };
      if (String(proof.reason) !== f.reason) return { changed: false, rec };
      const shopRow = configShopByIdOrName(shopId);
      if (shopRow && shopRow.deleted === true) return { changed: false, rec };
      if (shopRow) {
        if (String(shopRow.name || '') !== f.shop) return { changed: false, rec };
        if (shopRow.accountId != null && String(shopRow.accountId) !== f.accountId) return { changed: false, rec };
      }
      const key = String(f.planNumber);
      const e = entries[key];
      if (!e) return { changed: false, rec };
      // 幂等收敛：同一 runId + 同一原 reason 已收口 → 不再改写。
      if (e.status === 'preparation-stopped' && String(e.preparationRunId || '') === f.runId
        && String(e.reason || '') === f.reason) return { changed: false, rec };
      // 只把"该份从未消费"的那一条 unknown 换为 preparation-stopped；其余条目纹丝不动。
      if (e.status !== 'unknown' || String(e.reason || '') !== f.reason) return { changed: false, rec };
      entries[key] = {
        planNumber: Number(key), status: 'preparation-stopped',
        reason: String(e.reason), preparationRunId: f.runId,
        closedAt: new Date(drill._now()).toISOString(),
      };
      rec.plans = countSuccessEntries(rec);
      const unresolvedLeft = Object.keys(entries).some((k) => ['unknown', 'in-progress', 'failed'].includes(entries[k].status));
      if (!unresolvedLeft && (rec.status === 'unknown' || rec.status === 'blocked')) {
        rec.status = rec.plans >= plansPerShopPerDay ? 'success' : (rec.plans > 0 ? 'partial' : 'pending');
        rec.error = null;
      }
      rec.lastAt = new Date(drill._now()).toISOString();
      return { changed: true, rec };
    }
    if (proof.status === 'alreadyReconciled') {
      const beforePlans = Number(rec.plans) || 0;
      const beforeStatus = rec.status;
      // publisher 已耐久核对过同一确认（日状态+账本双成功才算 alreadyReconciled）。
      // 若账本对应 planNumber 条目仍停在 unknown/in-progress/blocked，用**严格验证过的**
      // 同一计划证明（合法 planId + 64 位 hash，且与条目已有 hash 不冲突）回填为 success；
      // 证明字段不完整或不合法 → 绝不虚构成功，只重算不写条目。
      const key = proof.planNumber != null ? String(proof.planNumber) : null;
      const e = key ? entries[key] : null;
      if (proof.ok === true && e && ['unknown', 'in-progress', 'blocked'].includes(e.status)
        && /^\d{12,20}$/.test(String(proof.planId || ''))
        && /^[a-f0-9]{64}$/i.test(String(proof.manifestHash || ''))
        && (!e.manifestHash || String(e.manifestHash) === String(proof.manifestHash))) {
        entries[key] = {
          planNumber: Number(key), status: 'success', planId: String(proof.planId),
          manifestHash: String(proof.manifestHash), recovered: true, at: new Date(drill._now()).toISOString(),
        };
      }
      rec.plans = Math.max(beforePlans, countSuccessEntries(rec));
      const unresolvedLeft = Object.keys(entries).some((k) => ['unknown', 'in-progress', 'failed'].includes(entries[k].status));
      if (!unresolvedLeft && (rec.status === 'unknown' || rec.status === 'blocked')) {
        rec.status = rec.plans >= plansPerShopPerDay ? 'success' : 'partial';
        rec.error = null;
      }
      return { changed: rec.plans !== beforePlans || rec.status !== beforeStatus, rec };
    }
    // S44：显式受信任「当前日预发布失败释放」映射。证明逐字绑定当前账本条目（记录状态/条目
    // 状态/条目原因 sha256）并携带严格零发布证明；只把该份未提交剩余释放为可重试 unsubmitted，
    // 成功份与其它条目纹丝不动、上限不变。复用**唯一** applySchedulerReleaseToRecord 判据
    // （与 scheduler.releaseProvenRemainder 同一实现），绝不第二套宽松实现。
    if (proof && proof.status === 'scheduler-release-prepublication') {
      if (!strictSchedulerReleaseProof(proof)) return { changed: false, rec };
      if (String(proof.businessDate) !== String(businessDate)) return { changed: false, rec };
      if (String(proof.shop) !== String(shopId)) return { changed: false, rec };
      return applySchedulerReleaseToRecord(rec, proof, drill._now(), plansPerShopPerDay);
    }
    return { changed: false, rec };
  }
  // R42 scope(S11)：正式 run 已带回 publisher 耐久零消费证明（status preparation-stopped +
  // preparationClosure 事实）时，只读排程仍会在本次 tick 内把该份记成 unknown 并卡住本店当日。
  // 这里在 tick 之后做一次**有界、串行、只按证明**的账本收口（最多 3 次重试 1s/15s/60s，等进程锁空出），与恢复端点共用同一把进程锁、
  // 同一判据（applyRecoverProofToLedger + strictPreparationFact）：拿不到锁即如实放弃（端点仍可
  // 手动恢复），零匹配/店名账户不符/无证明一律不动账本；绝不伪造 success、绝不重放发布、
  // 绝不清理原始账本。仅在排程已实际装配（生产派发路径）时触发，离线直调 runPlan 不产生任何账本写入。
  // 从正式 run 结果构造准备收口证明对象：仅当 run 以 preparation-stopped 带回耐久
  // preparationClosure 事实本体时才返回，其余（无证明/状态不符）返回 null。同锁映射与
  // timer 释放共用**同一**证明形状与**同一**严格判据，避免第二套宽松实现。
  function preparationProofFromRun(r) {
    if (!r || r.status !== 'preparation-stopped' || !r.preparationClosure) return null;
    return {
      ok: true, status: 'preparationClosed', reason: r.reason,
      planNumber: r.planNumber, runId: r.runId, businessDate: r.businessDate,
      preparationClosure: r.preparationClosure,
    };
  }
  // 同锁内的严格 proof 映射：排程 tick 已持进程锁，run 结果自带耐久零消费证明时，
  // 在**同一把锁内**直接按唯一严格判据（applyRecoverProofToLedger + strictPreparationFact）
  // 把该份收口，不再依赖 1/15/60s timer 事后拿锁（长 tick 会让 timer 拿不到锁而放弃）。
  // 证明不严/店身份漂移/日期份号 runId reason 不符/零消费结构不全 → applied:false，
  // 调用方保持原 unknown，绝不伪造成功、绝不重放。
  // expectedNumber = 排程本次 tick **正在派发**的份号（scheduler 的 planNumber）。当前派发上下文
  // （业务日 + 份号）必须与外层证明、内层耐久事实**三者逐字一致**：缺失或冲突（例如本轮执行第 1 份
  // 却被另一份的证明指向第 2 份，或证明属于别日）一律零写、保持原 unknown，绝不按另一份的证明
  // 释放本份/他份。
  function applyRunPreparationClosureToLedger(ledger, businessDate, shopId, r, cfg, expectedNumber) {
    const proof = preparationProofFromRun(r);
    if (!proof) return { applied: false };
    const fact = strictPreparationFact(r.preparationClosure && typeof r.preparationClosure === 'object' ? r.preparationClosure : r);
    if (!fact) return { applied: false };
    if (expectedNumber == null || String(expectedNumber) === '') return { applied: false };
    if (String(businessDate) !== String(proof.businessDate)) return { applied: false };
    if (String(expectedNumber) !== String(proof.planNumber)) return { applied: false };
    if (String(expectedNumber) !== String(fact.planNumber)) return { applied: false };
    const mapped = applyRecoverProofToLedger(ledger, String(businessDate), shopId, proof, cfg);
    return mapped.changed ? { applied: true, rec: mapped.rec } : { applied: false, rec: mapped.rec };
  }
  function releasePreparationLedgerFromRun(business, r) {
    const proof = preparationProofFromRun(r);
    if (!proof) return { released: false, reason: 'no-preparation-proof' };
    if (!drill._planScheduler) return { released: false, reason: 'scheduler-not-assembled' };
    if (!strictPreparationFact(r.preparationClosure)) return { released: false, reason: 'proof-not-strict' };
    const shopRow = configShopByIdOrName(business && business.shop);
    const shopId = String((shopRow && shopRow.id != null) ? shopRow.id : ((business && business.shop) || ''));
    const ledgerFile = schedulerLedgerFile();
    const lockFile = ledgerFile + '.lock';
    const lock = acquireProcessLock(lockFile, drill._now, 30 * 60 * 1000);
    if (!lock.held) return { released: false, reason: 'scheduler-lock-busy' };
    try {
      const ledger = loadLedger(ledgerFile);
      const cfgNow = (drill._planScheduler.state && drill._planScheduler.state().config) || (drill._config && drill._config.planPublishing) || {};
      const mapped = applyRecoverProofToLedger(ledger, String(r.businessDate), shopId, proof, cfgNow);
      if (!mapped.changed) return { released: false, reason: 'ledger-not-applicable', rec: mapped.rec };
      saveLedger(ledgerFile, ledger);
      const audited = appendRecoveryAudit({
        at: new Date(drill._now()).toISOString(), shopId, shopName: (shopRow && shopRow.name) || null,
        businessDate: String(r.businessDate), trigger: 'scheduled-run-preparation-closure',
        proof: scrubDeep(proof), ledgerChanged: true,
        recAfter: mapped.rec ? scrubDeep(JSON.parse(JSON.stringify(mapped.rec))) : null,
      });
      pushLog('info', `排程账本已按耐久准备证明收口（店 ${shopId} 第 ${r.planNumber} 份 ${String(r.businessDate)}）：该份不再占为 unknown，本日剩余未发布份数按既有调度继续${audited.ok ? '' : '（审计写入失败：' + audited.reason + '）'}`);
      return { released: true, rec: mapped.rec };
    } finally {
      releaseProcessLock(lockFile, lock.token);
    }
  }
  // S44 显式受信任「当前日预发布失败释放」端点（Root 可调用的既有 handleRequest 风格签名）。
  // 输入 = publisher.proveSchedulerReleaseProof 产出的严格证明（逐字绑定当前账本条目 + 独立零发布
  // 复证）。在**排程进程锁内**重读账本、经唯一 applySchedulerReleaseToRecord 判据释放该份未提交
  // 剩余（成功份/上限不变）。证明不严 / 绑定不符 / 拿不到锁一律零改动，绝不裸改账本、绝不重放。
  // 签名：releaseProvenPrepublication({ proof, shopId? }) -> { released, reason?, rec? }
  function releaseProvenPrepublication(request) {
    const req2 = request && typeof request === 'object' ? request : {};
    const proof = req2.proof || (req2.method ? req2 : null);
    if (!strictSchedulerReleaseProof(proof)) return { released: false, reason: 'proof-not-strict' };
    if (!drill._planScheduler) return { released: false, reason: 'scheduler-not-assembled' };
    const shopId = String(req2.shopId != null ? req2.shopId : proof.shop);
    const ledgerFile = schedulerLedgerFile();
    const lockFile = ledgerFile + '.lock';
    const lock = acquireProcessLock(lockFile, drill._now, 30 * 60 * 1000);
    if (!lock.held) return { released: false, reason: 'scheduler-lock-busy' };
    try {
      const ledger = loadLedger(ledgerFile);
      const cfgNow = (drill._planScheduler.state && drill._planScheduler.state().config) || (drill._config && drill._config.planPublishing) || {};
      const mapped = applyRecoverProofToLedger(ledger, String(proof.businessDate), shopId, proof, cfgNow);
      if (!mapped.changed) return { released: false, reason: 'ledger-not-applicable', rec: mapped.rec };
      saveLedger(ledgerFile, ledger);
      appendRecoveryAudit({
        at: new Date(drill._now()).toISOString(), shopId, shopName: null,
        businessDate: String(proof.businessDate), trigger: 'explicit-prepublication-release',
        proof: scrubDeep(proof), ledgerChanged: true,
        recAfter: mapped.rec ? scrubDeep(JSON.parse(JSON.stringify(mapped.rec))) : null,
      });
      pushLog('info', `排程账本已按严格预发布释放证明放开（店 ${shopId} 第 ${proof.planNumber} 份 ${String(proof.businessDate)}）：该份未提交剩余按既有调度补发，成功份与上限不变`);
      return { released: true, rec: mapped.rec };
    } finally {
      releaseProcessLock(lockFile, lock.token);
    }
  }
  function queuePreparationLedgerRelease(business, r) {
    if (!r || r.status !== 'preparation-stopped' || !r.preparationClosure || !drill._planScheduler) return;
    const DELAYS = [1000, 15000, 60000]; // 有界重试：只在排程进程锁空出来时才会真正写账本
    let attempt = 0;
    const run = () => {
      attempt += 1;
      let out = null;
      try { out = releasePreparationLedgerFromRun(business, r); }
      catch (e) { out = { released: false, reason: 'release-failed:' + ((e && e.message) || e) }; }
      if (out.released || out.reason === 'ledger-not-applicable') return;
      if (out.reason === 'scheduler-lock-busy' && attempt < DELAYS.length) {
        const t = setTimeout(run, DELAYS[attempt]);
        if (t && typeof t.unref === 'function') t.unref();
        return;
      }
      pushLog('warn', `准备收口账本自动释放未完成（${out.reason}）；本日该份仍为 unknown，可走只读恢复端点按同一严格证明释放`);
    };
    const t = setTimeout(run, DELAYS[0]);
    if (t && typeof t.unref === 'function') t.unref();
  }
  // ── R78：账户发现前置阻断的受信恢复（blocked + entries 严格空 + plans 为合法整数计数）──────
  // 故障形状：promo-plan-scheduler.tick 在账户发现失败时把记录置为 status='blocked' /
  // error='account-discovery:…' / plans=0 / entries={}；其终态拦截位于再次发现之前，
  // 导致新扫码登录成功后当日永远 0/3。既有 applyRecoverProofToLedger（含 closed 分支，
  // 要求 entries 存在）与 publisher.recoverShopDayReadback 都无法恢复这种"尚未建第一条
  // entry"的前置失败。恢复入口只有两个：登录成功事件（joinShopAfterLogin）与显式
  // POST /api/watch-drill/plan-publishing/recover；不加定时反复探测；调度侧 08:00 时刻门
  // 与每日上限原样生效（恢复只把记录转回可补剩余状态或按真实成功收敛展示）。
  // 严格判据（在排程跨进程持久锁内逐条满足，任一不满足即零改动）：
  //  * 记录形状：blocked + error 前缀 'account-discovery:' + entries 无任何键 + 无在途，
  //    plans 为合法非负整数计数。
  //  * 现网 promo-plan-scheduler.tick 每轮会把外部正式 publisher 的当日真实成功数同步进
  //    rec.plans（promo-plan-scheduler.js:511），所以"计数已被同步"的 blocked 空 entry 记录
  //    仍是同一条前置失败记录。两类出口严格分开，绝不混淆：
  //      - 零发布释放：要求 rec.plans 逐字为 0（非 0 一律不释放，绝不把已同步份数清零重发）；
  //      - 全量成功收敛：允许该已同步的合法整数计数，但必须 rec.plans ∈ {0, external}，并且
  //        真实同店同账户同日闭环事实恰好达本店配置上限：份号 1..上限齐备、每条都有真实
  //        planId 与同日 success consumption、无任何未决与活锁（不硬编码任何店名/账户/上限）。
  //  * 当前配置仍免审核启用（enabled + autoConfirm 均为 true）、店铺未删除。
  //  * fresh 同店账户发现成功（生产 openShop + 同店 Cookie 身份验证；不硬编码店名/账户），
  //    且与配置账户不冲突。
  //  * publisher 同店同日同账户 namespace 的真实事实：任何未决（active 在途/非预消费相位/
  //    不可闭环的 frozen·CID/日旗标/attempts initial·final·reopen 未决/手动未决）或该 namespace
  //    存在 publisher 活锁 → 只读拒绝，绝不提前清 block，绝不与真实 publisher 争抢（不抢锁/不删锁）。
  //    真实成功已达上限 → 按真实已成功份数收敛（不伪造成功条目、不重发已成计划）；零成功 →
  //    publisher 现成 proveNoPublicationPreOpen 整日零发布证明齐全，才释放为可补剩余 unsubmitted。
  //  * 两个出口写前都重验：原记录字节仍逐字一致、仍是当前业务日、免审核/启用/上限/预算/ROI
  //    配置未撤销未漂移、发现账户与配置不冲突、publisher 活锁仍不存在、
  //    currentPreOpenSourceHash 仍与读取证明时的源字节逐字一致。
  // 释放/收敛都把原失败审计（原 error、原 plans 实际值、原 entries、触发来源与证明摘要、
  // 真实成功 planId）完整保留在 releasedFrom，不清 nonce、不伪造确认、不裸改账本。
  function discoveryBlockedShape(rec) {
    if (!rec || typeof rec !== 'object') return null;
    if (rec.status !== 'blocked') return null;
    const err = typeof rec.error === 'string' ? rec.error : '';
    if (!err.startsWith('account-discovery:')) return null;
    const plans = Number(rec.plans);
    if (!Number.isInteger(plans) || plans < 0) return null;
    const entries = rec.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null;
    if (Object.keys(entries).length !== 0) return null;
    if (hasInProgress(rec)) return null;
    return { error: err, plans };
  }
  // publisher 同店同账户 namespace 的状态/尝试文件路径（与 readDaySuccessForShop /
  // runScheduledPlan 的 scheduledStatePaths 同一解析规则；stateRoot 仅供离线测试注入，
  // 生产缺省 = publisher 正式目录 PUBLISHER_DIR）。
  function discoveryStatePaths(shopName, accountId, stateRoot) {
    const sp = publisherRequire('shop-profile.cjs');
    const wfMod = publisherRequire('plan-workflow.cjs');
    if (!sp || typeof sp.shopStatePaths !== 'function' || typeof sp.buildShopProfile !== 'function') return null;
    let profile;
    try { profile = sp.buildShopProfile({ shop: shopName, accountId, roi: 15, dailyBudget: 300 }); }
    catch (_) { return null; }
    let legacy = false;
    try { legacy = sp.isLegacyDefaultProfile(profile, sp.profileFromBusiness(wfMod && wfMod.BUSINESS)) === true; } catch (_) { legacy = false; }
    try { return sp.shopStatePaths(profile, stateRoot || PUBLISHER_DIR, { legacy }); } catch (_) { return null; }
  }
  // 同 namespace 的 publisher 活锁**只读**判据（与 run-plans acquireLock 的锁记录语义一致：
  // 合法记录 = 正整数 pid + 可解析 startedAt；同目录 .recovery 标记 = 恢复在途）。绝不抢锁、
  // 绝不删锁、绝不调用 acquireLock；pid 已死（ESRCH）视为遗留死锁不阻断，记录损坏/字段缺失/
  // 探测不确定一律按活锁 fail-closed。
  function publisherLockLooksActive(lockFile) {
    if (!lockFile) return true;
    try {
      if (fs.existsSync(lockFile + '.recovery')) return true;
      if (!fs.existsSync(lockFile)) return false;
      let rec = null;
      try { rec = JSON.parse(fs.readFileSync(lockFile, 'utf8')); } catch (_) { return true; }
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)
        || !Number.isSafeInteger(rec.pid) || rec.pid <= 0
        || !Number.isFinite(Date.parse(String(rec.startedAt || '')))) return true;
      if (rec.pid === process.pid) return true;
      try { process.kill(rec.pid, 0); return true; } catch (e) { return !(e && e.code === 'ESRCH'); }
    } catch (_) { return true; }
  }
  // 该店 namespace 的活锁扫描（发现**之前**即执行，避免与真实 publisher 争抢同一 namespace）：
  // 配置已带账户 → 只查该账户 namespace；账户未配置 → 只查同店名前缀的已验证 namespace。
  function discoveryPublisherLockFacts(shopName, accountId, stateRoot) {
    const sp = publisherRequire('shop-profile.cjs');
    if (!sp || typeof sp.shopSlug !== 'function') return { active: true, reason: 'publisher-lock-probe-unavailable' };
    const base = path.join(stateRoot || PUBLISHER_DIR, 'shop-state');
    let dirs = [];
    try {
      if (accountId != null && String(accountId) !== '') {
        const one = discoveryStatePaths(shopName, String(accountId), stateRoot);
        if (!one) return { active: true, reason: 'publisher-lock-probe-unavailable' };
        dirs = [one.lockFile ? one.lockFile : path.join(one.dir, 'plan-publisher.lock')];
      } else {
        const prefix = sp.shopSlug({ shop: shopName }).replace(/__pending$/, '') + '__';
        const names = fs.existsSync(base) ? fs.readdirSync(base) : [];
        dirs = names.filter((n) => String(n).startsWith(prefix))
          .map((n) => path.join(base, n, 'plan-publisher.lock'));
      }
    } catch (_) { return { active: true, reason: 'publisher-lock-probe-unavailable' }; }
    for (const lockFile of dirs) if (publisherLockLooksActive(lockFile)) return { active: true, reason: 'publisher-lock-active' };
    return { active: false, reason: null };
  }
  // attempts 三表（initial consumed / final finalConsumed / reopen reopenConsumed）的只读事实：
  // 同日非 success/failed 记录一律未决（并复用 publisher 现成 listManualUnresolved 判据作二次
  // 把关）；同日 success 记录给出"按确认号 / 份号闭环"的真实消费索引——真实已成功终态可以
  // 携带旧 frozen + 已成功 consumption，必须按真正闭环判定，而不是见到 frozen 就永久卡死。
  function readDiscoveryAttemptFacts(attemptsFile, businessDate) {
    const out = { exists: false, pending: false, unreadable: false, pendingReason: null, closedCids: new Set(), successPlanNumbers: new Set(), consumptionByCid: new Map() };
    let store = null;
    try {
      if (!fs.existsSync(attemptsFile)) return out;
      out.exists = true;
      store = JSON.parse(fs.readFileSync(attemptsFile, 'utf8'));
    } catch (_) { return { ...out, pending: true, unreadable: true, pendingReason: 'attempts-unreadable' }; }
    if (!store || typeof store !== 'object' || Array.isArray(store)) {
      return { ...out, pending: true, unreadable: true, pendingReason: 'attempts-malformed' };
    }
    for (const mapName of ['consumed', 'finalConsumed', 'reopenConsumed']) {
      const m = store[mapName];
      if (m === undefined) continue;
      if (!m || typeof m !== 'object' || Array.isArray(m)) {
        return { ...out, pending: true, unreadable: true, pendingReason: 'attempts-' + mapName + '-malformed' };
      }
      for (const entry of Object.entries(m)) {
        const cid = String(entry[0]);
        const rec = entry[1];
        if (!rec || typeof rec !== 'object') continue;
        if (String(rec.businessDate || '') !== String(businessDate)) continue;
        const st = String(rec.status || '');
        if (st !== 'success' && st !== 'failed') { out.pending = true; out.pendingReason = 'attempts-' + mapName + '-unresolved'; continue; }
        if (st !== 'success') continue;
        out.closedCids.add(cid);
        const n = Number(rec.planNumber);
        if (Number.isInteger(n) && n >= 1) out.successPlanNumbers.add(n);
        if (!out.consumptionByCid.has(cid)) out.consumptionByCid.set(cid, rec);
        else {
          const prev = out.consumptionByCid.get(cid);
          if (prev.conflict === true
            || Number(prev.planNumber) !== n
            || String(prev.manifestHash || '') !== String(rec.manifestHash || '')
            || String(prev.runId || '') !== String(rec.runId || '')) {
            out.consumptionByCid.set(cid, { conflict: true });
          }
        }
      }
    }
    if (!out.pending) {
      const rpMod = publisherRequire('run-plans.cjs');
      if (rpMod && typeof rpMod.listManualUnresolved === 'function') {
        let unresolved = [];
        try { unresolved = rpMod.listManualUnresolved(store) || []; } catch (_) { unresolved = []; }
        const sameDay = unresolved.filter((u) => String((u && u.record && u.record.businessDate) || '') === String(businessDate));
        if (sameDay.length > 0) { out.pending = true; out.pendingReason = 'manual-unresolved-' + String(sameDay[0].kind); }
      }
    }
    return out;
  }
  // 同 namespace 日状态的只读事实（跨日文件不算当日；损坏一律按不可读拒绝，绝不当作零）。
  // 未决面 = 日旗标 + active 相位/消费痕迹（预消费无痕迹相位交由 publisher 整日零发布证明
  // 判定，与 publisher 现成 hasUnresolvedPlan 同一语义面） + attempts 未决（见上）。
  const PRE_CONSUMPTION_ACTIVE_PHASES = ['pending', 'preparing', 'preparation-stopped'];
  // 发布确实成功的终态面：published-success，或发布已成功、仅开启收口未落地的
  // post-publish-enable-stopped。其余相位（ready-awaiting-confirmation/awaiting-confirmation 等）
  // 即便 attempts 里见到旧成功 CID 也绝不据此认成闭环。
  const PUBLICATION_SUCCESS_TERMINAL_PHASES = ['published-success', 'post-publish-enable-stopped'];
  function activePublicationIsClosed(a, raw, attemptFacts, businessDate, scope) {
    try {
      if (!PUBLICATION_SUCCESS_TERMINAL_PHASES.includes(String(a.status || ''))) return false;
      const frozen = (a.frozen && typeof a.frozen === 'object') ? a.frozen : {};
      const cid = String(frozen.confirmationId || a.confirmationId || '');
      if (!cid) return false;
      const n = Number(a.planNumber != null ? a.planNumber : frozen.planNumber);
      if (!Number.isInteger(n) || n < 1) return false;
      if (!attemptFacts || !attemptFacts.closedCids.has(cid) || !attemptFacts.successPlanNumbers.has(n)) return false;
      if (String(frozen.businessDate || a.businessDate || businessDate) !== String(businessDate)) return false;
      // frozen 自洽且与当日真实消费逐项吻合：manifestHash/runId 必需，且与消费记录的
      // 日期/份号/hash/runId 逐字一致；缺失、篡改或外来（他店/他账户）身份一律不算闭环。
      const mh = String(frozen.manifestHash || '');
      const rid = String(frozen.runId || '');
      if (!/^[0-9a-f]{64}$/.test(mh) || !rid) return false;
      const consumption = (attemptFacts.consumptionByCid && attemptFacts.consumptionByCid.get(cid)) || null;
      if (!consumption || consumption.conflict === true) return false;
      if (String(consumption.businessDate || '') !== String(businessDate)) return false;
      if (Number(consumption.planNumber) !== n) return false;
      if (String(consumption.manifestHash || '') !== mh) return false;
      if (String(consumption.runId || '') !== rid) return false;
      if (a.runId != null && String(a.runId) !== rid) return false;
      if (scope) {
        if (frozen.shop != null && String(frozen.shop) !== '' && String(frozen.shop) !== String(scope.shop)) return false;
        if (frozen.accountId != null && String(frozen.accountId) !== '' && String(frozen.accountId) !== String(scope.accountId)) return false;
        if (consumption.shop != null && String(consumption.shop) !== '' && String(consumption.shop) !== String(scope.shop)) return false;
        if (consumption.accountId != null && String(consumption.accountId) !== '' && String(consumption.accountId) !== String(scope.accountId)) return false;
      }
      const plans = Array.isArray(raw.plans) ? raw.plans : [];
      const hit = plans.find((p) => p && Number(p.planNumber) === n && String(p.status) === 'success');
      if (!hit || hit.planId == null || String(hit.planId) === '') return false;
      if (a.planId != null && String(a.planId) !== String(hit.planId)) return false;
      if (String(hit.manifestHash || '') !== mh) return false;
      return true;
    } catch (_) { return false; }
  }
  function readDiscoveryDayFacts(stateFile, businessDate, attemptFacts, scope) {
    const af = attemptFacts || { pending: false, closedCids: new Set(), successPlanNumbers: new Set(), consumptionByCid: new Map() };
    const out = {
      stateExists: false, sameDay: false, pending: af.pending === true, pendingReason: af.pending ? String(af.pendingReason || 'attempts-unresolved') : null,
      successPlans: [], successPlanNumbers: [], closedPlanNumbers: [], manualUiFactsToday: 0,
    };
    let raw = null;
    try {
      if (!fs.existsSync(stateFile)) return out;
      out.stateExists = true;
      raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (_) { return { ...out, unreadable: true }; }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...out, malformed: true };
    out.sameDay = String(raw.businessDate || '') === String(businessDate);
    if (!out.sameDay) return out;
    if (raw.plans !== undefined && !Array.isArray(raw.plans)) return { ...out, malformed: true };
    if (raw.unknown === true || raw.pending === true) { out.pending = true; out.pendingReason = 'day-state-unresolved-flag'; }
    const a = raw.active;
    if (a !== undefined && a !== null) {
      if (typeof a !== 'object' || Array.isArray(a)) return { ...out, malformed: true };
      const st = String(a.status || '');
      const carriesArtifact = !!(a.frozen || a.confirmationId != null || a.manifestHash != null || a.planId != null || a.nonce != null);
      if (carriesArtifact) {
        if (!activePublicationIsClosed(a, raw, af, businessDate, scope)) { out.pending = true; out.pendingReason = 'active-artifact-unresolved:' + st; }
      } else if (st === 'preparing' || st === 'pending') {
        out.pending = true; out.pendingReason = 'active-in-flight:' + st;
      } else if (!PRE_CONSUMPTION_ACTIVE_PHASES.includes(st)) {
        const wf = publisherRequire('plan-workflow.cjs');
        const unresolvedByPublisher = (wf && typeof wf.hasUnresolvedPlan === 'function') ? wf.hasUnresolvedPlan(raw) : true;
        if (unresolvedByPublisher || !st) { out.pending = true; out.pendingReason = 'active-phase-unresolved:' + (st || 'no-status'); }
      }
    }
    for (const p of (Array.isArray(raw.plans) ? raw.plans : [])) {
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue;
      if (String(p.status) !== 'success') continue;
      const n = Number(p.planNumber);
      if (!Number.isInteger(n) || n < 1) continue;
      const planId = p.planId != null && String(p.planId) !== '' ? String(p.planId) : null;
      out.successPlans.push({ planNumber: n, planId, at: p.at || null, manifestHash: p.manifestHash || null });
      if (!planId) continue;
      if (!out.successPlanNumbers.includes(n)) out.successPlanNumbers.push(n);
      if (af.successPlanNumbers.has(n)) out.closedPlanNumbers.push(n);
    }
    const mu = Array.isArray(raw.manualUiPublicationFacts) ? raw.manualUiPublicationFacts : [];
    const muToday = mu.filter((f) => f && String(f.businessDate || '') === String(businessDate));
    out.manualUiFactsToday = muToday.length;
    // 手动 UI 发布事实：published-success 由 readDaySuccessForShop 对 published-products 逐字
    // 核验（不一致即抛不可知）；其余状态一律按未决拒绝，绝不当作"可安全收敛/释放"。
    if (muToday.some((f) => String(f.status || '') !== 'published-success')) {
      out.pending = true; out.pendingReason = 'manual-ui-fact-unresolved';
    }
    return out;
  }
  // 收敛判据：真实闭环事实必须**逐份**吻合本店上限——份号 1..上限齐备、每条都有真实 planId
  // 与同日 success consumption（真正闭环，而不是只见到 plans 字段）。缺任一条件一律不收敛，
  // 绝不与外部竞速派发、绝不伪造条目。上限来自本店配置（resolveShopPlansPerDay），不硬编码。
  function discoveryClosedSuccessFacts(facts, external, shopLimit) {
    if (!facts || !Array.isArray(facts.successPlanNumbers) || !Array.isArray(facts.closedPlanNumbers)) {
      return { ok: false, reason: 'external-facts-unreadable' };
    }
    const nums = [...new Set(facts.successPlanNumbers)];
    if (nums.length !== Number(external)) return { ok: false, reason: 'external-facts-count-mismatch' };
    if (nums.some((n) => n > shopLimit)) return { ok: false, reason: 'external-facts-over-limit' };
    const closed = new Set(facts.closedPlanNumbers);
    for (let n = 1; n <= shopLimit; n += 1) {
      if (!nums.includes(n)) return { ok: false, reason: 'external-facts-missing-plan:' + n };
      if (!closed.has(n)) return { ok: false, reason: 'external-facts-plan-not-closed:' + n };
    }
    return { ok: true, planNumbers: nums };
  }
  // 当前免审核发布配置的最新读数（写前重验用；与 recoverDiscoveryBlockedShopDay 取 cfgNow 同源）。
  // 双源对账：调度器缓存与当前静态授权源必须一致且启用；当前授权源停用或两来源矛盾一律
  // fail-closed——绝不允许旧的"启用"缓存压过刚发生的配置撤销。
  function currentPlanPublishingConfig() {
    const staticCfg = (drill._config && drill._config.planPublishing) || {};
    const sched = drill._planScheduler;
    let schedCfg = null;
    if (sched && typeof sched.state === 'function') {
      try { const c = sched.state().config; if (c && typeof c === 'object') schedCfg = c; } catch (_) { schedCfg = null; }
    }
    if (!schedCfg) return staticCfg; // 读数不可用回落静态配置
    const liveEnabled = staticCfg.enabled === true;
    const cachedEnabled = schedCfg.enabled === true;
    if (!liveEnabled || liveEnabled !== cachedEnabled) return { ...schedCfg, enabled: false };
    return schedCfg;
  }
  // 核心恢复（调用方必须已持有 ledgerFile+'.lock' 排程持久锁；锁内重读、写前再验）。
  // di 仅离线测试注入外部边界（stateRoot/openShop/readAccountInPage/closeBrowser/loginCfg/
  // discoverAccount/afterProof）；生产调用从不传该参数，不新增任何生产分支。
  async function recoverDiscoveryBlockedDayUnderLock(ledgerFile, businessDate, shopId, cfgNow, trigger, di) {
    const shopRowRaw = configShopByIdOrName(shopId);
    if (!shopRowRaw || shopRowRaw.deleted === true) return { applicable: false, reason: 'shop-missing-or-deleted' };
    // 写前参数比较一律用开始时的不可变快照，绝不与同一可变配置对象自比。
    const shopRow = { ...shopRowRaw };
    cfgNow = Object.freeze({ ...(cfgNow && typeof cfgNow === 'object' ? cfgNow : {}) });
    const rec0 = (() => {
      const ledger = loadLedger(ledgerFile);
      if (ledger.corrupt) return { __corrupt: true };
      const day = ledger.days && ledger.days[businessDate];
      return (day && day.shops && day.shops[String(shopId)]) || null;
    })();
    if (rec0 && rec0.__corrupt) return { applicable: false, reason: 'ledger-corrupt-fail-closed' };
    const shape = discoveryBlockedShape(rec0);
    if (!shape) return { applicable: false, reason: 'record-not-empty-discovery-blocked', rec: rec0 };
    if (!(cfgNow && cfgNow.enabled === true && cfgNow.autoConfirm === true)) {
      return { applicable: true, changed: false, reason: 'config-disabled', rec: rec0 };
    }
    // 0) 发现之前先只读判定该店 namespace 是否已有 publisher 活锁：有活锁说明真实发布入口
    //    正在本 namespace 上工作，本次一律零动作（不抢锁、不删锁、不启动发现去争抢）。
    const cfgAccount = shopRow.accountId != null && String(shopRow.accountId) !== '' ? String(shopRow.accountId) : null;
    const diRoot = (di && typeof di === 'object' && di.stateRoot) ? di.stateRoot : null;
    const earlyLock = discoveryPublisherLockFacts(shopRow.name, cfgAccount, diRoot);
    if (earlyLock.active) {
      return { applicable: true, changed: false, reason: earlyLock.reason || 'publisher-lock-active', rec: rec0 };
    }
    const originalRecordJson = JSON.stringify(rec0);
    const originalError = shape.error;
    const shopLimit = resolveShopPlansPerDay(shopRow, (cfgNow && cfgNow.plansPerShopPerDay) || 3);
    const rp = publisherRequire('run-plans.cjs');
    if (!rp || typeof rp.proveNoPublicationPreOpen !== 'function'
      || typeof rp.readDaySuccessForShop !== 'function' || typeof rp.currentPreOpenSourceHash !== 'function') {
      return { applicable: true, changed: false, reason: 'publisher-proof-capability-unavailable', rec: rec0 };
    }
    // 写前统一门禁：重读账本，原记录字节必须仍逐字一致（异步发现期间被改动即放弃）；返回
    // 可安全改写的新鲜账本，绝不回写基于旧快照的整本账本。
    const reloadStillBound = () => {
      try {
        const fresh = loadLedger(ledgerFile);
        if (fresh.corrupt) return null;
        const day = fresh.days && fresh.days[businessDate];
        const rec = (day && day.shops && day.shops[String(shopId)]) || null;
        if (!rec || JSON.stringify(rec) !== originalRecordJson) return null;
        return { ledger: fresh, rec };
      } catch (_) { return null; }
    };
    // 1) fresh 同店账户发现（生产 openShop + 同店 Cookie 身份验证；绝不硬编码店名/账户）。
    let business = null;
    try { business = buildTrustedBusiness(shopRow, { dailyBudget: cfgNow.dailyBudget, plansPerShopPerDay: shopLimit }); }
    catch (_) { business = null; }
    if (!business || business.accountId != null) business = { ...(business || {}), accountId: null };
    let discovered = null;
    try {
      const fn = (di && typeof di.discoverAccount === 'function') ? di.discoverAccount : defaultPlanDiscoverAccount;
      discovered = await fn(shopRow, business, di && typeof di === 'object' ? di : undefined);
    } catch (e) { discovered = { error: 'discovery-threw:' + ((e && e.message) || e) }; }
    const account = (discovered != null && typeof discovered !== 'object' && /^\d{6,24}$/.test(String(discovered)))
      ? String(discovered) : null;
    if (!account) {
      return { applicable: true, changed: false, reason: 'discovery-not-successful:' + scrub(String((discovered && discovered.error) || 'no-account')), rec: rec0 };
    }
    // 账户错配：配置已绑定账户但与 fresh 发现不一致 → 零改动（绝不跨账户收敛/释放）。
    if (cfgAccount !== null && cfgAccount !== account) {
      return { applicable: true, changed: false, reason: 'discovered-account-mismatch', rec: rec0, account };
    }
    // 2) publisher 同店同日同账户 namespace 的真实事实（外部正式入口已真实完成/未决/零发布）。
    const paths = discoveryStatePaths(shopRow.name, account, diRoot);
    if (!paths || !paths.stateFile || !paths.attemptsFile) {
      return { applicable: true, changed: false, reason: 'publisher-state-paths-unavailable', rec: rec0 };
    }
    const nsLockFile = paths.lockFile || (paths.dir ? path.join(paths.dir, 'plan-publisher.lock') : null);
    if (publisherLockLooksActive(nsLockFile)) {
      return { applicable: true, changed: false, reason: 'publisher-lock-active', rec: rec0, account };
    }
    let external = 0;
    try {
      external = Number(rp.readDaySuccessForShop({ shop: shopRow.name, accountId: account }, businessDate,
        { ...(di && typeof di === 'object' ? di : {}) })) || 0;
    } catch (e) {
      return { applicable: true, changed: false, reason: 'read-day-success-failed:' + scrub(String((e && e.message) || e)), rec: rec0 };
    }
    const attemptFacts = readDiscoveryAttemptFacts(paths.attemptsFile, businessDate);
    const facts = readDiscoveryDayFacts(paths.stateFile, businessDate, attemptFacts, { shop: shopRow.name, accountId: account });
    if (facts.unreadable || facts.malformed || attemptFacts.unreadable) {
      return { applicable: true, changed: false, reason: 'publisher-day-state-unreadable', rec: rec0 };
    }
    if (facts.pending) {
      // 仍有未决（外部正式入口在途/active 消费痕迹不可闭环/日旗标/attempts 未决）：只读拒绝，
      // 绝不提前清 block，绝不与真实 publisher 竞速。
      return { applicable: true, changed: false, reason: 'publisher-day-still-pending', pendingReason: facts.pendingReason || null, rec: rec0 };
    }
    // 写前统一重验（两个出口共用）：仍是当前业务日、配置未撤销/未漂移、账户不冲突、
    // publisher 活锁仍不存在、源字节 hash 仍与读取证明时一致、原记录字节仍逐字一致。
    const sourceHashNow = () => {
      try { return rp.currentPreOpenSourceHash(paths.stateFile, paths.attemptsFile); } catch (_) { return null; }
    };
    const preWriteRevalidation = (expectSourceHash) => {
      try {
        if (shanghaiDate(drill._now()) !== String(businessDate)) return { ok: false, reason: 'cross-day-before-write' };
        const shopFresh = configShopByIdOrName(shopId);
        if (!shopFresh || shopFresh.deleted === true) return { ok: false, reason: 'shop-missing-or-deleted' };
        if (String(shopFresh.name) !== String(shopRow.name)) return { ok: false, reason: 'shop-identity-drift-before-write' };
        // 实时店铺授权/账户必须仍是证明时的那一个：accountId=null 的自动发现形态保持允许
        // （用户无需预填账号 ID），但一旦实时配置显式绑定了**另一**账户，或本店广告控制
        // 已被撤销（adControl=false / 拼多多行），一律零改动——绝不借启动时的旧快照放行。
        const freshAccount = shopFresh.accountId != null && String(shopFresh.accountId) !== '' ? String(shopFresh.accountId) : null;
        if (freshAccount !== null && freshAccount !== account) return { ok: false, reason: 'config-account-drift-before-write' };
        if (shopFresh.adControl === false || String(shopFresh.platform || '') === 'pinduoduo') {
          return { ok: false, reason: 'shop-ad-control-revoked-before-write' };
        }
        const cfgFresh = currentPlanPublishingConfig();
        if (!(cfgFresh && cfgFresh.enabled === true && cfgFresh.autoConfirm === true)) return { ok: false, reason: 'config-disabled' };
        if (resolveShopPlansPerDay(shopFresh, (cfgFresh && cfgFresh.plansPerShopPerDay) || 3) !== shopLimit) return { ok: false, reason: 'config-limit-drift-before-write' };
        if ((Number(cfgFresh.dailyBudget) || 0) !== (Number(cfgNow.dailyBudget) || 0)) return { ok: false, reason: 'config-budget-drift-before-write' };
        if (String(cfgFresh.timezone || '') !== String(cfgNow.timezone || '')) return { ok: false, reason: 'config-timezone-drift-before-write' };
        if (String(shopFresh.targetRoi) !== String(shopRow.targetRoi)) return { ok: false, reason: 'config-roi-drift-before-write' };
        if (cfgAccount !== null && cfgAccount !== account) return { ok: false, reason: 'discovered-account-mismatch' };
        if (discoveryPublisherLockFacts(shopRow.name, account, diRoot).active) return { ok: false, reason: 'publisher-lock-active' };
        const h = sourceHashNow();
        if (typeof h !== 'string' || h !== expectSourceHash) return { ok: false, reason: 'source-hash-drift' };
        const bound = reloadStillBound();
        if (!bound) return { ok: false, reason: 'record-drift-before-write' };
        return { ok: true, bound, sourceHash: h };
      } catch (e) {
        return { ok: false, reason: 'revalidation-threw:' + scrub(String((e && e.message) || e)) };
      }
    };
    if (external > 0) {
      // 收敛分支（真实完成收敛）：同店同账户当日已有真实闭环成功。只在**已达本店上限**且
      // 计数与真实闭环事实逐字吻合时才收敛页面（外部 3 份真实完成 → blocked 空 entry 记录
      // 收敛为 success 3/3，绝不重发已成计划）；不足上限（外部仍在串行补齐或只完成部分）
      // 一律零改动，等待下一次触发再判，绝不与外部执行竞速派发。真实 planId 只进 releasedFrom
      // 审计，绝不生成不存在的成功条目；rec.plans 原实际值与 originalError 原样保留在审计里。
      if (external < shopLimit) {
        return { applicable: true, changed: false, reason: 'external-partial-not-converged', rec: rec0, account, external, limit: shopLimit };
      }
      if (shape.plans !== 0 && shape.plans !== external) {
        return { applicable: true, changed: false, reason: 'external-count-mismatch', rec: rec0, account, external, limit: shopLimit, ledgerPlans: shape.plans };
      }
      const closedFacts = discoveryClosedSuccessFacts(facts, external, shopLimit);
      if (!closedFacts.ok) {
        return { applicable: true, changed: false, reason: closedFacts.reason, rec: rec0, account, external, limit: shopLimit };
      }
      const convergeHash = sourceHashNow();
      if (typeof convergeHash !== 'string') {
        return { applicable: true, changed: false, reason: 'source-hash-drift', rec: rec0 };
      }
      if (di && typeof di.afterProof === 'function') { try { await di.afterProof(paths); } catch (_) { /* 测试注入边界异常不改变判定 */ } }
      const revalidated = preWriteRevalidation(convergeHash);
      if (!revalidated.ok) return { applicable: true, changed: false, reason: revalidated.reason, rec: rec0 };
      const bound = revalidated.bound;
      const iso = new Date(drill._now()).toISOString();
      const rec = bound.rec;
      rec.releasedFrom = {
        status: 'blocked', plans: shape.plans, error: originalError, entries: {},
        externalConverged: {
          account, businessDate: String(businessDate), externalSuccesses: external, limit: shopLimit,
          ledgerPlansBefore: shape.plans, sourceHash: revalidated.sourceHash,
          successPlans: scrubDeep(facts.successPlans),
        },
        trigger: trigger || null, recoveredAt: iso,
      };
      rec.plans = external;
      rec.status = 'success';
      rec.error = null;
      rec.retry = null;
      rec.lastAt = iso;
      saveLedger(ledgerFile, bound.ledger);
      const audited = appendRecoveryAudit({
        at: iso, shopId: String(shopId), shopName: shopRow.name || null,
        businessDate: String(businessDate), trigger: 'discovery-blocked-converge' + (trigger ? ':' + trigger : ''),
        proof: scrubDeep({ account, externalSuccesses: external, limit: shopLimit, ledgerPlansBefore: shape.plans, sourceHash: revalidated.sourceHash, successPlans: facts.successPlans }),
        ledgerChanged: true, recAfter: scrubDeep(JSON.parse(JSON.stringify(rec))),
      });
      pushLog('info', `账户发现前置阻断收敛（店 ${shopId}，日 ${businessDate}）：同店同账户当日已真实成功 ${external} 份（上限 ${shopLimit}）→ 页面收敛为 success，不重发已成计划${audited.ok ? '' : '（审计写入失败：' + audited.reason + '）'}`);
      return { applicable: true, changed: true, action: 'converged-external-success', rec, account, external, limit: shopLimit };
    }
    // 3) 释放分支（零发布释放）：外部零成功且 rec.plans 逐字为 0 → 严格整日零发布证明
    //    （同店同日同账户 scope）+ 写前源字节/锁/配置/记录再复核。rec.plans 已被同步成非 0
    //    而外部读数又为 0 是**计数与事实矛盾**的危险形状，绝不释放（释放即清零重发）。
    if (shape.plans !== 0) {
      return { applicable: true, changed: false, reason: 'release-requires-empty-synced-count', rec: rec0, account, external, limit: shopLimit };
    }
    const proof = rp.proveNoPublicationPreOpen(paths.stateFile, paths.attemptsFile, businessDate,
      { shop: shopRow.name, accountId: account });
    if (!proof || proof.ok !== true || !strictNoPublicationProof(proof.proof)
      || String(proof.proof.shop) !== String(shopRow.name) || String(proof.proof.accountId) !== account) {
      return { applicable: true, changed: false, reason: 'zero-publication-proof-failed:' + scrub(String((proof && proof.reason) || 'not-proven')), rec: rec0 };
    }
    if (di && typeof di.afterProof === 'function') { try { await di.afterProof(paths); } catch (_) { /* 测试注入边界异常不改变判定 */ } }
    const revalidated = preWriteRevalidation(proof.proof.sourceHash);
    if (!revalidated.ok) return { applicable: true, changed: false, reason: revalidated.reason, rec: rec0 };
    const bound = revalidated.bound;
    const iso = new Date(drill._now()).toISOString();
    const rec = bound.rec;
    rec.releasedFrom = {
      status: 'blocked', plans: shape.plans, error: originalError, entries: {},
      discoveryRecovered: { account, businessDate: String(businessDate), proof: scrubDeep(proof.proof) },
      trigger: trigger || null, releasedAt: iso,
    };
    rec.retry = { attempts: 0, lastAt: iso, nextAt: iso };
    rec.status = 'unsubmitted';
    rec.lastAt = iso;
    saveLedger(ledgerFile, bound.ledger);
    const audited = appendRecoveryAudit({
      at: iso, shopId: String(shopId), shopName: shopRow.name || null,
      businessDate: String(businessDate), trigger: 'discovery-blocked-release' + (trigger ? ':' + trigger : ''),
      proof: scrubDeep({ account, publicationProof: proof.proof }),
      ledgerChanged: true, recAfter: scrubDeep(JSON.parse(JSON.stringify(rec))),
    });
    pushLog('info', `账户发现前置阻断已释放（店 ${shopId}，日 ${businessDate}）：fresh 同店发现成功 + 整日零发布证明齐全 → 记录转回可补剩余（unsubmitted，本日缺额=上限 ${shopLimit}）；原失败审计保留在 releasedFrom；后续派发仍受既有时刻门与每日上限约束${audited.ok ? '' : '（审计写入失败：' + audited.reason + '）'}`);
    return { applicable: true, changed: true, action: 'released-empty-discovery-block', rec, account, limit: shopLimit };
  }
  // 独立触发壳：取同一把排程持久锁 + 单店在途去重后执行核心恢复（HTTP recover 端点与
  // 登录成功事件共用；锁忙/在途如实返回，绝不强抢活锁）。
  async function recoverDiscoveryBlockedShopDay(shopId, trigger, di) {
    const key = String(shopId || '');
    if (!key) return { ok: false, status: 'invalid', reason: 'shop-id-missing' };
    if (drill._recoverInflight.has(key)) return { ok: false, status: 'busy', reason: 'recovery-in-flight' };
    const ledgerFile = schedulerLedgerFile();
    const lockFile = ledgerFile + '.lock';
    const lock = acquireProcessLock(lockFile, drill._now, 30 * 60 * 1000);
    if (!lock.held) return { ok: false, status: 'busy', reason: 'scheduler-lock-busy', locked: true };
    drill._recoverInflight.add(key);
    try {
      const sched = drill._planScheduler;
      const cfgNow = (sched && typeof sched.state === 'function' && sched.state().config)
        || (drill._config && drill._config.planPublishing) || {};
      const businessDate = shanghaiDate(drill._now());
      return await recoverDiscoveryBlockedDayUnderLock(ledgerFile, businessDate, key, cfgNow, trigger, di || opts.planDiscoveryRecoverDi);
    } finally {
      drill._recoverInflight.delete(key);
      releaseProcessLock(lockFile, lock.token);
    }
  }
  // ── S108：当日第 1 份「预导航登录失败、零成功」的受信释放 ──────────────────
  // 故障形状（现网 Jin 实录）：08:00 排程派发第 1 份时在 openShop 预导航处因登录失效抛错，
  // publisher 因 store 仍是旧业务日而无法出 unsubmitted 证明，账本落终态 failed + 唯一
  // 第 1 份 entry failed。publisher 修复后该证明链已可凭"旧日完整闭环"独立成立；本侧只需在
  // 两个既有合法入口（登录成功事件 / 显式 recover 端点）把精确形状接回**唯一**既有释放协议
  // （proveSchedulerReleaseProof + applySchedulerReleaseToRecord），绝不新建第二套清状态、
  // 绝不主动另起发布流程（缺额由既有 scheduler tick 补发）。
  // 错误文字只用于**选择候选形状**，绝不是零发布证明：unknown/in-progress/成功/多 entry/
  // plans 非 0/其它前缀一律不匹配；真正的零发布证明必须由 publisher 对同店同账户 namespace
  // 新鲜回读独立给出，并逐字绑定当前账本条目；旧 published-success 的 nothingToRecover 读回
  // 绝不等同于"今日 0"，本路径完全不使用 recoverShopDayReadback。
  function preNavigationLoginFailedShape(rec) {
    if (!rec || typeof rec !== 'object') return null;
    if (rec.status !== 'failed') return null;
    if (Number(rec.plans) !== 0) return null;
    if (hasInProgress(rec)) return null;
    const entries = rec.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null;
    const keys = Object.keys(entries);
    if (keys.length !== 1 || keys[0] !== '1') return null;
    const e = entries['1'];
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    if (Number(e.planNumber) !== 1) return null;
    if (e.status !== 'failed') return null;
    const reason = typeof e.reason === 'string' ? e.reason : '';
    if (!reason.startsWith('scheduled-run-exception:')) return null;
    return { planNumber: 1, reason, error: typeof rec.error === 'string' ? rec.error : null };
  }
  // S126：当日第 1 份「初始化点击前策略漂移」被调度器记成 unknown 的精确 legacy 形状。
  // 2026-10-17 敏敏店：active 被写成无 runId 的 preparation-stopped，entry 1 却是 unknown，
  // 既有 release 只认 failed/blocked，于是账户恢复 enabled=true 后仍永久堵住。这里只做**候选
  // 选择**（状态/条目/原因/错误逐字相等 + 唯一第 1 条 + plans 0 + 无条目痕迹）；真正的零发布
  // 证明仍由 publisher.proveSchedulerReleaseProof 对同店同账户 namespace 独立给出。
  const PRE_INITIAL_POLICY_CANCEL_REASON = 'scheduled-policy-drift-before-initial:policy-disabled-or-not-autoconfirmed';
  function preInitialPolicyCancelledShape(rec) {
    if (!rec || typeof rec !== 'object') return null;
    if (rec.status !== 'unknown') return null;
    if (Number(rec.plans) !== 0) return null;
    if (hasInProgress(rec)) return null;
    if (rec.confirmationId != null || rec.frozen || rec.nonce != null) return null;
    const entries = rec.entries;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return null;
    const keys = Object.keys(entries);
    if (keys.length !== 1 || keys[0] !== '1') return null;
    const e = entries['1'];
    if (!e || typeof e !== 'object' || Array.isArray(e)) return null;
    if (Number(e.planNumber) !== 1) return null;
    if (e.status !== 'unknown') return null;
    if (String(e.reason || '') !== PRE_INITIAL_POLICY_CANCEL_REASON) return null;
    if (e.confirmationId != null || e.planId != null || e.manifestHash != null || e.nonce != null || e.frozen) return null;
    if (String(rec.error || '') !== 'unknown:' + PRE_INITIAL_POLICY_CANCEL_REASON) return null;
    return { planNumber: 1, reason: PRE_INITIAL_POLICY_CANCEL_REASON, error: String(rec.error) };
  }
  // 核心（调用方必须已持有排程持久锁）：fresh 同店身份 + 当前配置授权仍有效 + publisher 严格
  // release 证明（内部含同店同日零发布独立复证与账本条目逐字绑定）+ 当日真实成功读数为 0 +
  // 写前锁内再验（跨日/店身份/免审核/上限/预算/ROI/时区/账户/publisher 活锁/源字节 hash/
  // 原记录字节）全部逐字通过后，才经唯一 applySchedulerReleaseToRecord 映射为 unsubmitted，
  // 原失败完整保留在 releasedFrom 审计。任一步不满足即零改动；多次触发天然幂等
  // （释放后记录为 unsubmitted，形状不再匹配）。
  async function recoverPreNavigationLoginFailureUnderLock(ledgerFile, businessDate, shopId, cfgNow, trigger, di) {
    const shopRowRaw = configShopByIdOrName(shopId);
    if (!shopRowRaw || shopRowRaw.deleted === true) return { applicable: false, reason: 'shop-missing-or-deleted' };
    const shopRow = { ...shopRowRaw };
    cfgNow = Object.freeze({ ...(cfgNow && typeof cfgNow === 'object' ? cfgNow : {}) });
    const rec0 = (() => {
      const ledger = loadLedger(ledgerFile);
      if (ledger.corrupt) return { __corrupt: true };
      const day = ledger.days && ledger.days[businessDate];
      return (day && day.shops && day.shops[String(shopId)]) || null;
    })();
    if (rec0 && rec0.__corrupt) return { applicable: false, reason: 'ledger-corrupt-fail-closed' };
    const shape = preNavigationLoginFailedShape(rec0) || preInitialPolicyCancelledShape(rec0);
    if (!shape) return { applicable: false, reason: 'record-not-pre-navigation-login-failed', rec: rec0 };
    if (!(cfgNow && cfgNow.enabled === true && cfgNow.autoConfirm === true)) {
      return { applicable: true, changed: false, reason: 'config-disabled', rec: rec0 };
    }
    const cfgAccount = shopRow.accountId != null && String(shopRow.accountId) !== '' ? String(shopRow.accountId) : null;
    const diRoot = (di && typeof di === 'object' && di.stateRoot) ? di.stateRoot : null;
    const earlyLock = discoveryPublisherLockFacts(shopRow.name, cfgAccount, diRoot);
    if (earlyLock.active) {
      return { applicable: true, changed: false, reason: earlyLock.reason || 'publisher-lock-active', rec: rec0 };
    }
    const originalRecordJson = JSON.stringify(rec0);
    const shopLimit = resolveShopPlansPerDay(shopRow, (cfgNow && cfgNow.plansPerShopPerDay) || 3);
    const rp = publisherRequire('run-plans.cjs');
    if (!rp || typeof rp.proveSchedulerReleaseProof !== 'function'
      || typeof rp.readDaySuccessForShop !== 'function' || typeof rp.currentPreOpenSourceHash !== 'function') {
      return { applicable: true, changed: false, reason: 'publisher-release-proof-capability-unavailable', rec: rec0 };
    }
    const reloadStillBound = () => {
      try {
        const fresh = loadLedger(ledgerFile);
        if (fresh.corrupt) return null;
        const day = fresh.days && fresh.days[businessDate];
        const rec = (day && day.shops && day.shops[String(shopId)]) || null;
        if (!rec || JSON.stringify(rec) !== originalRecordJson) return null;
        return { ledger: fresh, rec };
      } catch (_) { return null; }
    };
    // 1) fresh 同店账户身份（与 R78 复用同一发现边界；绝不硬编码店名/账户、绝不借另一店）。
    let business = null;
    try { business = buildTrustedBusiness(shopRow, { dailyBudget: cfgNow.dailyBudget, plansPerShopPerDay: shopLimit }); }
    catch (_) { business = null; }
    if (!business || business.accountId != null) business = { ...(business || {}), accountId: null };
    let discovered = null;
    try {
      const fn = (di && typeof di.discoverAccount === 'function') ? di.discoverAccount : defaultPlanDiscoverAccount;
      discovered = await fn(shopRow, business, di && typeof di === 'object' ? di : undefined);
    } catch (e) { discovered = { error: 'discovery-threw:' + ((e && e.message) || e) }; }
    const account = (discovered != null && typeof discovered !== 'object' && /^\d{6,24}$/.test(String(discovered)))
      ? String(discovered) : null;
    if (!account) {
      return { applicable: true, changed: false, reason: 'discovery-not-successful:' + scrub(String((discovered && discovered.error) || 'no-account')), rec: rec0 };
    }
    if (cfgAccount !== null && cfgAccount !== account) {
      return { applicable: true, changed: false, reason: 'discovered-account-mismatch', rec: rec0, account };
    }
    // 2) 当日真实成功读数必须为 0（含手动发布）；读数不可知一律零动作。
    const paths = discoveryStatePaths(shopRow.name, account, diRoot);
    if (!paths || !paths.stateFile || !paths.attemptsFile) {
      return { applicable: true, changed: false, reason: 'publisher-state-paths-unavailable', rec: rec0 };
    }
    const nsLockFile = paths.lockFile || (paths.dir ? path.join(paths.dir, 'plan-publisher.lock') : null);
    if (publisherLockLooksActive(nsLockFile)) {
      return { applicable: true, changed: false, reason: 'publisher-lock-active', rec: rec0, account };
    }
    let external = 0;
    try {
      external = Number(rp.readDaySuccessForShop({ shop: shopRow.name, accountId: account }, businessDate,
        { ...(di && typeof di === 'object' ? di : {}) })) || 0;
    } catch (e) {
      return { applicable: true, changed: false, reason: 'read-day-success-failed:' + scrub(String((e && e.message) || e)), rec: rec0 };
    }
    if (external !== 0) {
      return { applicable: true, changed: false, reason: 'current-day-success-not-zero', rec: rec0, account, external };
    }
    // 3) publisher 唯一严格 release 证明：逐字绑定当前账本条目 + 同店同日零发布独立复证。
    const proofRes = rp.proveSchedulerReleaseProof(ledgerFile,
      { stateFile: paths.stateFile, attemptsFile: paths.attemptsFile },
      { businessDate: String(businessDate), shop: String(shopId), planNumber: shape.planNumber, accountId: account });
    if (!proofRes || proofRes.ok !== true || !proofRes.proof) {
      return { applicable: true, changed: false, reason: 'release-proof-not-established:' + scrub(String((proofRes && proofRes.reason) || 'not-proven')), rec: rec0 };
    }
    const proof = proofRes.proof;
    if (!strictSchedulerReleaseProof(proof)
      || String(proof.businessDate) !== String(businessDate)
      || String(proof.shop) !== String(shopId)
      || Number(proof.planNumber) !== shape.planNumber
      || (proof.accountId != null && account != null && String(proof.accountId) !== account)) {
      return { applicable: true, changed: false, reason: 'release-proof-binding-drift', rec: rec0 };
    }
    // 4) 锁内写前再验（与 R78 同一门禁形状）：源字节 hash、配置鲜活、记录逐字未漂移。
    const sourceHashNow = () => {
      try { return rp.currentPreOpenSourceHash(paths.stateFile, paths.attemptsFile); } catch (_) { return null; }
    };
    const preWriteRevalidation = (expectSourceHash) => {
      try {
        if (shanghaiDate(drill._now()) !== String(businessDate)) return { ok: false, reason: 'cross-day-before-write' };
        const shopFresh = configShopByIdOrName(shopId);
        if (!shopFresh || shopFresh.deleted === true) return { ok: false, reason: 'shop-missing-or-deleted' };
        if (String(shopFresh.name) !== String(shopRow.name)) return { ok: false, reason: 'shop-identity-drift-before-write' };
        // 实时店铺授权/账户必须仍是证明时的那一个：accountId=null 的自动发现形态保持允许
        // （用户无需预填账号 ID），但一旦实时配置显式绑定了**另一**账户，或本店广告控制
        // 已被撤销（adControl=false / 拼多多行），一律零改动——绝不借启动时的旧快照放行。
        const freshAccount = shopFresh.accountId != null && String(shopFresh.accountId) !== '' ? String(shopFresh.accountId) : null;
        if (freshAccount !== null && freshAccount !== account) return { ok: false, reason: 'config-account-drift-before-write' };
        if (shopFresh.adControl === false || String(shopFresh.platform || '') === 'pinduoduo') {
          return { ok: false, reason: 'shop-ad-control-revoked-before-write' };
        }
        const cfgFresh = currentPlanPublishingConfig();
        if (!(cfgFresh && cfgFresh.enabled === true && cfgFresh.autoConfirm === true)) return { ok: false, reason: 'config-disabled' };
        if (resolveShopPlansPerDay(shopFresh, (cfgFresh && cfgFresh.plansPerShopPerDay) || 3) !== shopLimit) return { ok: false, reason: 'config-limit-drift-before-write' };
        if ((Number(cfgFresh.dailyBudget) || 0) !== (Number(cfgNow.dailyBudget) || 0)) return { ok: false, reason: 'config-budget-drift-before-write' };
        if (String(cfgFresh.timezone || '') !== String(cfgNow.timezone || '')) return { ok: false, reason: 'config-timezone-drift-before-write' };
        if (String(shopFresh.targetRoi) !== String(shopRow.targetRoi)) return { ok: false, reason: 'config-roi-drift-before-write' };
        if (cfgAccount !== null && cfgAccount !== account) return { ok: false, reason: 'discovered-account-mismatch' };
        if (discoveryPublisherLockFacts(shopRow.name, account, diRoot).active) return { ok: false, reason: 'publisher-lock-active' };
        const h = sourceHashNow();
        if (typeof h !== 'string' || h !== expectSourceHash) return { ok: false, reason: 'source-hash-drift' };
        const bound = reloadStillBound();
        if (!bound) return { ok: false, reason: 'record-drift-before-write' };
        return { ok: true, bound, sourceHash: h };
      } catch (e) {
        return { ok: false, reason: 'revalidation-threw:' + scrub(String((e && e.message) || e)) };
      }
    };
    if (di && typeof di.afterProof === 'function') { try { await di.afterProof(paths); } catch (_) { /* 测试注入边界异常不改变判定 */ } }
    const revalidated = preWriteRevalidation(proof.sourceHash);
    if (!revalidated.ok) return { applicable: true, changed: false, reason: revalidated.reason, rec: rec0 };
    const bound = revalidated.bound;
    // 5) 唯一释放映射（applyRecoverProofToLedger 的 scheduler-release 分支 →
    // applySchedulerReleaseToRecord）：该份未提交剩余转 unsubmitted，缺额由既有 tick 补发。
    const mapped = applyRecoverProofToLedger(bound.ledger, String(businessDate), String(shopId), proof, cfgNow);
    if (!mapped.changed) return { applicable: true, changed: false, reason: 'ledger-release-not-applicable', rec: mapped.rec || rec0 };
    saveLedger(ledgerFile, bound.ledger);
    const iso = new Date(drill._now()).toISOString();
    const audited = appendRecoveryAudit({
      at: iso, shopId: String(shopId), shopName: shopRow.name || null,
      businessDate: String(businessDate), trigger: 'pre-navigation-login-failure-release' + (trigger ? ':' + trigger : ''),
      proof: scrubDeep(proof), ledgerChanged: true,
      recAfter: mapped.rec ? scrubDeep(JSON.parse(JSON.stringify(mapped.rec))) : null,
    });
    pushLog('info', `当日第 1 份预发布失败（预导航登录失败/初始点击前策略撤销）已按严格 release 证明释放（店 ${shopId}，日 ${businessDate}）：fresh 同店身份 + publisher 整日零发布复证 + 锁内再验齐全 → 记录转 unsubmitted，缺额按既有调度补发，成功份与上限不变；原失败审计保留在 releasedFrom${audited.ok ? '' : '（审计写入失败：' + audited.reason + '）'}`);
    return { applicable: true, changed: true, action: 'released-pre-navigation-login-failure', rec: mapped.rec, account, limit: shopLimit };
  }
  // 独立触发壳：与 R78 共用同一把排程持久锁 + 单店在途去重（HTTP recover 端点与登录成功
  // 事件共用；锁忙/在途如实返回，绝不强抢活锁）。
  async function recoverPreNavigationLoginFailureShopDay(shopId, trigger, di) {
    const key = String(shopId || '');
    if (!key) return { ok: false, status: 'invalid', reason: 'shop-id-missing' };
    if (drill._recoverInflight.has(key)) return { ok: false, status: 'busy', reason: 'recovery-in-flight' };
    const ledgerFile = schedulerLedgerFile();
    const lockFile = ledgerFile + '.lock';
    const lock = acquireProcessLock(lockFile, drill._now, 30 * 60 * 1000);
    if (!lock.held) return { ok: false, status: 'busy', reason: 'scheduler-lock-busy', locked: true };
    drill._recoverInflight.add(key);
    try {
      const sched = drill._planScheduler;
      const cfgNow = (sched && typeof sched.state === 'function' && sched.state().config)
        || (drill._config && drill._config.planPublishing) || {};
      const businessDate = shanghaiDate(drill._now());
      return await recoverPreNavigationLoginFailureUnderLock(ledgerFile, businessDate, key, cfgNow, trigger, di || opts.planDiscoveryRecoverDi);
    } finally {
      drill._recoverInflight.delete(key);
      releaseProcessLock(lockFile, lock.token);
    }
  }
  // 登录成功事件的触发入口：只在该事件（或显式 recover 端点）调用，绝不定时反复探测。
  // 无当日该形状记录时零动作；有则异步有界执行，绝不阻塞/影响接管流程本身；结果落
  // 日志与审计，最近一次 promise 归档在 drill._discoveryRecoveries（观察/测试可等待）。
  function scheduleDiscoveryBlockedRecovery(shopId, trigger) {
    const key = String(shopId || '');
    if (!key) return null;
    let shape = null;
    let preNav = null;
    let prePolicy = null;
    try {
      const led = loadLedger(schedulerLedgerFile());
      const date = shanghaiDate(drill._now());
      const day = led && led.days && led.days[date];
      const rec = (day && day.shops && day.shops[key]) || null;
      shape = discoveryBlockedShape(rec);
      // S108：无 R78 前置阻断形状时，再接"当日第 1 份预导航失败"精确形状；两者都不匹配即零动作。
      if (!shape) preNav = preNavigationLoginFailedShape(rec);
      // S126：再接精确 legacy「初始点击前策略撤销」unknown 形状（同一受信释放核心）。
      if (!shape && !preNav) prePolicy = preInitialPolicyCancelledShape(rec);
    } catch (_) { shape = null; preNav = null; prePolicy = null; }
    if (!shape && !preNav && !prePolicy) return null;
    const p = Promise.resolve()
      .then(() => (shape
        ? recoverDiscoveryBlockedShopDay(key, trigger || 'login-success', opts.planDiscoveryRecoverDi)
        : recoverPreNavigationLoginFailureShopDay(key, trigger || 'login-success', opts.planDiscoveryRecoverDi)))
      .catch((e) => {
        pushLog('error', `${shape ? '账户发现前置阻断' : '预导航失败释放'}异常（店 ${key}）：${scrub(String((e && e.message) || e))}；记录未改动，可显式 recover 重试`);
        return { ok: false, status: 'error', reason: 'recovery-threw' };
      });
    drill._discoveryRecoveries.set(key, p);
    return p;
  }
  function recoveryAuditFile() {
    return path.join(opts.dataDir || path.join(PROMO_GUARD_DIR, 'data'), 'promo-plan-recovery-audit.json');
  }
  // 持久恢复审计（tmp+rename；有界 200 条；内容先 scrubDeep，绝无 Cookie/令牌原文）。
  function appendRecoveryAudit(entry) {
    const file = recoveryAuditFile();
    let arr = [];
    try {
      if (fs.existsSync(file)) { const parsed = JSON.parse(fs.readFileSync(file, 'utf8')); if (Array.isArray(parsed)) arr = parsed; }
    } catch (_) { arr = []; }
    arr.push(entry);
    const trimmed = arr.slice(-200);
    const tmp = file + '.tmp-' + process.pid;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(trimmed, null, 2));
      fs.renameSync(tmp, file);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: scrub(String((e && e.message) || e)) };
    }
  }
  function schedulerLedgerFile() {
    return opts.schedulerLedgerFile
      || path.join(opts.dataDir || path.join(PROMO_GUARD_DIR, 'data'), 'promo-plan-scheduler-ledger.json');
  }
  // "普通开启"只复用 Monitor 既有正式能力（runManualEnableVerify → 同店开启预检链：
  // 新鲜核实、已开启零动作、409 在途锁与每日去重一律不绕过）。判定顺序：
  //  1) 发布入口带回的**只读**开启读数 already-enabled → 零开启请求（绝不重复发单）；
  //  2) 读数未知（读取失败）→ 同样零开启请求，诚实记"未核实"，不盲发开启；
  //  3) 读数确认已暂停（或没有读数可用）→ 才按**精确身份**发起既有核实，并**有界等待**
  //     异步终态（getManualEnableVerifyStatus）；"已启动"绝不当作成功。
  // 失败/被拒/超时一律诚实记录，且**绝不回滚已发布事实**。
  function defaultPlanEnableShop(business, meta) {
    const shop = configShopByIdOrName((business && business.shop) || '');
    const shopId = shop ? String(shop.id != null ? shop.id : shop.name) : null;
    if (!shopId) return Promise.resolve({ ok: false, reason: 'enable-shop-id-unknown' });
    const cfgAccount = shop.accountId != null ? String(shop.accountId) : '';
    const runAccount = business && business.accountId != null ? String(business.accountId) : '';
    if (cfgAccount !== '' && runAccount !== '' && cfgAccount !== runAccount) {
      return Promise.resolve({ ok: false, reason: 'enable-identity-mismatch' });
    }
    const observation = (meta && meta.enableObservation) || null;
    const obsStatus = observation && observation.status ? String(observation.status) : null;
    if (obsStatus === 'already-enabled') return Promise.resolve({ ok: true, alreadyEnabled: true, reason: 'already-enabled-no-enable-request' });
    if (obsStatus === 'unknown-current-state') return Promise.resolve({ ok: false, reason: 'enable-state-unverified-no-enable-request' });
    let m;
    try { m = ensureMonitor(); } catch (e) { return Promise.resolve({ ok: false, reason: 'enable-monitor-unavailable:' + ((e && e.message) || e) }); }
    if (!m || typeof m.runManualEnableVerify !== 'function') return Promise.resolve({ ok: false, reason: 'enable-capability-unavailable' });
    let r = null;
    try { r = m.runManualEnableVerify(String(shopId)); } catch (e) { return Promise.resolve({ ok: false, reason: 'enable-verify-threw:' + ((e && e.message) || e) }); }
    if (!r || r.ok !== true) return Promise.resolve({ ok: false, reason: 'enable-rejected:' + ((r && (r.code || r.error)) || 'unknown') });
    return waitForEnableVerify(m, String(shopId));
  }
  // 有界等待手动开启核实的异步终态：只认 getManualEnableVerifyStatus 的 done/failed，
  // 超时或状态不可读一律如实 pending（绝不把"已启动"报成成功）。等待参数可注入便于离线测试。
  function waitForEnableVerify(m, shopId) {
    const waitMs = Number.isFinite(opts.enableVerifyWaitMs) && opts.enableVerifyWaitMs > 0 ? opts.enableVerifyWaitMs : 120000;
    const pollMs = Number.isInteger(opts.enableVerifyPollMs) && opts.enableVerifyPollMs > 0 ? opts.enableVerifyPollMs : 500;
    return new Promise((resolve) => {
      const deadline = drill._now() + waitMs;
      const read = () => {
        let s = null;
        try { s = typeof m.getManualEnableVerifyStatus === 'function' ? m.getManualEnableVerifyStatus() : null; }
        catch (e) { resolve({ ok: false, reason: 'enable-status-unreadable:' + ((e && e.message) || e) }); return; }
        const mine = !!s && String(s.shopId) === String(shopId);
        if (mine && s.status === 'done') {
          const st = (s.result && s.result.status) || null;
          if (st === 'ok') resolve({ ok: true, alreadyEnabled: s.result.zeroClick === true, reason: null });
          else resolve({ ok: false, reason: 'enable-verify-' + (st || 'unknown') + ':' + ((s.result && s.result.reason) || 'not-confirmed') });
          return;
        }
        if (mine && s.status === 'failed') { resolve({ ok: false, reason: 'enable-verify-failed:' + ((s.result && s.result.error) || 'unknown') }); return; }
        if (drill._now() >= deadline) { resolve({ ok: false, started: true, reason: 'enable-verify-timeout-no-terminal-status' }); return; }
        setTimeout(read, pollMs);
      };
      read();
    });
  }
  // 页面保存的排程配置必须真正持久化（重启仍生效）：写正式 CONFIG_PATH 的 planPublishing，
  // tmp + 逐字段回读校验 + rename。测试注入 opts.config 时只更新内存（离线不新建生产配置）。
  const PLAN_PUBLISHING_FIELDS = Object.freeze(['enabled', 'autoConfirm', 'time', 'plansPerShopPerDay', 'dailyBudget', 'timezone']);
  function persistPlanPublishingConfig(value) {
    if (opts.config) {
      const src = value || {};
      const ok = PLAN_PUBLISHING_FIELDS.every((k) => Object.prototype.hasOwnProperty.call(src, k));
      return { ok, reason: ok ? null : 'config-fields-incomplete', memoryOnly: true };
    }
    let cfgMod;
    try { cfgMod = promo('src/config.js'); } catch (e) { return { ok: false, reason: 'config-module-unavailable' }; }
    const file = cfgMod && cfgMod.CONFIG_PATH;
    if (!file) return { ok: false, reason: 'config-path-unavailable' };
    if (!fs.existsSync(file)) return { ok: false, reason: 'config-file-missing' };
    const verify = (label) => {
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const pp = raw && raw.planPublishing;
        if (!pp) return { ok: false, reason: label + '-readback-missing' };
        if (!PLAN_PUBLISHING_FIELDS.every((k) => JSON.stringify(pp[k]) === JSON.stringify(value[k]))) return { ok: false, reason: label + '-readback-mismatch' };
        return { ok: true, reason: null };
      } catch (e) { return { ok: false, reason: label + '-readback-unreadable:' + ((e && e.message) || e) }; }
    };
    let base;
    try { base = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { ok: false, reason: 'config-file-unreadable:' + ((e && e.message) || e) }; }
    const next = { ...base, planPublishing: { ...(base.planPublishing || {}), ...value } };
    const tmp = file + '.tmp-' + process.pid;
    try {
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* 临时文件清理失败不改判定 */ }
      return { ok: false, reason: 'config-write-failed:' + ((e && e.message) || e) };
    }
    return verify('config');
  }
  // ── 每店每日计划数量（客户 2026-10-13：目标 ROI 后面按店可调 1..10，缺省回落全局 3）──────
  // 严格整数校验（与 config.validatePlansPerShop 同源）；非法一律拒绝、零写入。
  function validatePlansPerShopValue(v) {
    let cfgMod = null;
    try { cfgMod = promo('src/config.js'); } catch (_) { cfgMod = null; }
    if (cfgMod && typeof cfgMod.validatePlansPerShop === 'function') return cfgMod.validatePlansPerShop(v);
    const ok = typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= 10;
    return { ok, value: ok ? v : null, reason: ok ? null : '必须是 1~10 的整数' };
  }
  // 从磁盘配置回读本店已保存数量。返回 { value }（value=null 表示字段**缺失**——这是合法
  // 前态，缺省回落全局 3，回滚时必须恢复缺失而不是写任意数字）或 { error }（不可知）。
  // patrol-plan-refill 返修：测试注入内存配置（opts.config）时从 drill._config.shops 回读，
  // 不再返回笼统 null——回滚判据需要区分"字段缺失"与"前值不可知"。
  function readSavedShopPlanQuantity(shopId) {
    if (opts.config) {
      const row = ((drill._config && Array.isArray(drill._config.shops)) ? drill._config.shops : [])
        .find((s) => s && (String(s.id) === String(shopId) || String(s.name) === String(shopId)));
      if (!row) return { error: 'config-shop-missing' };
      return { value: Object.prototype.hasOwnProperty.call(row, 'plansPerShopPerDay') ? row.plansPerShopPerDay : null };
    }
    let cfgMod = null;
    try { cfgMod = promo('src/config.js'); } catch (_) { cfgMod = null; }
    const file = cfgMod && cfgMod.CONFIG_PATH;
    if (!file || !fs.existsSync(file)) return { error: 'config-unreadable' };
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return { error: 'config-unreadable' }; }
    const list = (raw && Array.isArray(raw.shops)) ? raw.shops : [];
    const row = list.find((s) => s && (String(s.id) === String(shopId) || String(s.name) === String(shopId)));
    if (!row) return { error: 'config-shop-missing' };
    return { value: Object.prototype.hasOwnProperty.call(row, 'plansPerShopPerDay') ? row.plansPerShopPerDay : null };
  }
  // 把合法数量写入 monitor 自有店对象并复用其**唯一**原子落盘（保留其余键/店）；失败精确回滚内存。
  // 同步更新 drill._config.shops（调度器与展示的数据源）与快照回读，做到"保存即生效 + 回读确认"。
  function persistShopPlanQuantity(m2, shopId, value) {
    const ms = (m2 && typeof m2._findShop === 'function') ? m2._findShop(shopId) : null;
    const ds = ((drill._config && Array.isArray(drill._config.shops)) ? drill._config.shops : [])
      .find((s) => s && (String(s.id) === String(shopId) || String(s.name) === String(shopId)));
    if (!ms && !ds) return { ok: false, reason: '店铺不存在，无法保存每日计划数量' };
    const hadMs = ms && Object.prototype.hasOwnProperty.call(ms, 'plansPerShopPerDay');
    const prevMs = ms ? ms.plansPerShopPerDay : undefined;
    const hadDs = ds && Object.prototype.hasOwnProperty.call(ds, 'plansPerShopPerDay');
    const prevDs = ds ? ds.plansPerShopPerDay : undefined;
    const rollback = () => {
      if (ms) { if (hadMs) ms.plansPerShopPerDay = prevMs; else delete ms.plansPerShopPerDay; }
      if (ds) { if (hadDs) ds.plansPerShopPerDay = prevDs; else delete ds.plansPerShopPerDay; }
    };
    if (ms) ms.plansPerShopPerDay = value;
    if (ds) ds.plansPerShopPerDay = value;
    // 测试注入配置（opts.config）：内存生效即可，绝不写生产磁盘（monitor 注入源 sourcePath='injected'
    // 本就不落盘）；回读按内存店对象确认。
    if (opts.config) return { ok: true, saved: value, memoryOnly: true };
    let persist = { ok: true, persisted: true };
    if (ms && typeof m2._persistShopsToConfig === 'function') persist = m2._persistShopsToConfig();
    if (!persist || persist.ok !== true) { rollback(); return { ok: false, reason: '每日计划数量落盘失败：' + ((persist && persist.reason) || 'unknown') }; }
    // 磁盘回读确认（测试注入 opts.config 时跳过磁盘校验，仅内存生效）。
    const rb = readSavedShopPlanQuantity(shopId);
    if (rb && rb.error) { rollback(); return { ok: false, reason: '每日计划数量回读失败：' + rb.error }; }
    if (rb && rb.value !== value) { rollback(); return { ok: false, reason: `每日计划数量回读不一致（磁盘 ${rb.value}，期望 ${value}）` }; }
    return { ok: true, saved: value };
  }
  // patrol-plan-refill 返修：恢复「字段缺失」这一合法前态（缺省回落全局 3）。结构与
  // persistShopPlanQuantity 相同（内存生效 + monitor 唯一原子落盘 + 回读确认），只是删除字段。
  function persistShopPlanQuantityAbsence(m2, shopId) {
    const ms = (m2 && typeof m2._findShop === 'function') ? m2._findShop(shopId) : null;
    const ds = ((drill._config && Array.isArray(drill._config.shops)) ? drill._config.shops : [])
      .find((s) => s && (String(s.id) === String(shopId) || String(s.name) === String(shopId)));
    if (!ms && !ds) return { ok: false, reason: '店铺不存在，无法恢复每日计划数量缺省' };
    const hadMs = ms && Object.prototype.hasOwnProperty.call(ms, 'plansPerShopPerDay');
    const prevMs = ms ? ms.plansPerShopPerDay : undefined;
    const hadDs = ds && Object.prototype.hasOwnProperty.call(ds, 'plansPerShopPerDay');
    const prevDs = ds ? ds.plansPerShopPerDay : undefined;
    const rollback = () => {
      if (ms && hadMs) ms.plansPerShopPerDay = prevMs;
      if (ds && hadDs) ds.plansPerShopPerDay = prevDs;
    };
    if (ms) delete ms.plansPerShopPerDay;
    if (ds) delete ds.plansPerShopPerDay;
    if (opts.config) return { ok: true, saved: null, memoryOnly: true };
    let persist = { ok: true, persisted: true };
    if (ms && typeof m2._persistShopsToConfig === 'function') persist = m2._persistShopsToConfig();
    if (!persist || persist.ok !== true) { rollback(); return { ok: false, reason: '每日计划数量缺省恢复落盘失败：' + ((persist && persist.reason) || 'unknown') }; }
    const rb = readSavedShopPlanQuantity(shopId);
    if (rb && rb.error) { rollback(); return { ok: false, reason: '每日计划数量缺省回读失败：' + rb.error }; }
    if (rb && rb.value !== null) { rollback(); return { ok: false, reason: `每日计划数量缺省回读不一致（磁盘 ${rb.value}，期望缺失）` }; }
    return { ok: true, saved: null };
  }
  // patrol-plan-refill 返修：每店数量的 guard 保存 + 独立发布器单字段同步 + 失败回滚一体化
  //（shop/update 路由与离线测试共用同一实现）。回滚语义：
  //  * 前值为显式数字 → 写回旧值；
  //  * 前态为字段缺失 → 恢复缺失（合法回落 3，不再是"无法回滚"）；
  //  * 前值不可读（配置不可读/店缺失）或回滚前发现当前值已非本次写入值（并发较新写入）
  //    → 绝不覆盖，仅如实失败并说明未回滚。
  function applyShopPlanQuantitySync(m2, shopId, planQuantity) {
    const prevRead = readSavedShopPlanQuantity(String(shopId));
    const prevKnown = !!(prevRead && !prevRead.error);
    const prevQty = prevKnown ? prevRead.value : null; // null = 字段缺失（合法前态）
    const qr = persistShopPlanQuantity(m2, String(shopId), planQuantity);
    if (!qr.ok) return { ok: false, reason: qr.reason, quantityRolledBack: false };
    const qSync = syncIndependentShopPlanQuantity(String(shopId), planQuantity);
    if (qSync.applied || qSync.notInstalled === true) {
      if (qSync.applied && !qSync.unchanged) {
        pushLog('info', `单店每日计划数量已同步独立发布器：${shopId} · plansPerShopPerDay=${planQuantity}`);
      }
      return { ok: true, reason: `每日计划数量已保存为 ${planQuantity} 条`, plansPerShopPerDay: planQuantity, independentSync: { applied: qSync.applied === true, unchanged: qSync.unchanged === true, reason: qSync.reason || null } };
    }
    // 同步失败：整体不视为已保存。回滚前先确认当前值仍是本次写入值——并发较新写入绝不覆盖。
    let rolledBack = false;
    let rollbackNote = 'guard 数量未回滚（前值不可读，绝不盲写）';
    const curRead = readSavedShopPlanQuantity(String(shopId));
    const curKnown = !!(curRead && !curRead.error);
    const curVal = curKnown ? curRead.value : undefined;
    if (curKnown && curVal === planQuantity) {
      try {
        if (!prevKnown) {
          rollbackNote = 'guard 数量未回滚（前值不可读，绝不盲写）';
        } else if (prevQty === null) {
          const rb = persistShopPlanQuantityAbsence(m2, String(shopId));
          rolledBack = rb.ok === true;
          rollbackNote = rolledBack ? 'guard 数量已恢复缺省（回落 3）' : 'guard 数量缺省恢复失败，实际值以配置为准';
        } else {
          const rb = persistShopPlanQuantity(m2, String(shopId), prevQty);
          rolledBack = rb.ok === true;
          rollbackNote = rolledBack ? 'guard 数量已回滚为原值 ' + prevQty : 'guard 数量回滚失败，实际值以配置为准';
        }
      } catch (e) { rolledBack = false; rollbackNote = 'guard 数量回滚异常，实际值以配置为准'; }
    } else if (curKnown) {
      rollbackNote = 'guard 数量未回滚（已有并发较新写入 ' + curVal + '，绝不覆盖）';
    }
    pushLog('warn', `单店每日计划数量独立发布器同步失败（不视为已保存）：${shopId} · ${qSync.reason || 'unknown'}；${rollbackNote}`);
    return { ok: false, reason: '独立发布器数量同步失败：' + (qSync.reason || 'unknown') + '（' + rollbackNote + '）', quantityRolledBack: rolledBack };
  }
  // ── 独立 plan-publisher 的 targetRoi 单字段同步（简尚 ROI14 修复，最小范围）────────
  // 背景：独立 plan-publisher/daily-plan-config.json 与 guard config 是两份配置，页面
  // /api/watch-drill/shop/update 只更新 guard 设置，导致独立 run-plans 仍按旧 ROI 发布。
  // 这里只在「显式合法 targetRoi 已被 monitor.updateShop 成功保存」时，把独立配置中
  // **同一精确店**（id 或 name 完全相等）的 targetRoi 一字段同步；不复制其他 guard 字段、
  // 不创建独立店、不启用旧内嵌发布器。独立文件不存在（未安装）→ 兼容原 API 照常成功；
  // 独立文件存在但读取/匹配失败 → 绝不显示两份配置都保存成功。
  // 2026-10-26 patrol-plan-refill：把「单字段严格 CAS 同步」泛化到每店每日计划数量
  // （plansPerShopPerDay，整数 1..10，页面保存值即权威）。约束不变：只改同一精确店的
  // 单字段、tmp+rename 原子写、写前 CAS 复核并发漂移、绝不整文件覆盖丢并发较新设置、
  // 未安装独立配置（文件不存在）→ 兼容原 API 照常成功。
  function syncIndependentShopField(shopId, field, value) {
    const FIELDS = ['targetRoi', 'plansPerShopPerDay'];
    if (!FIELDS.includes(field)) return { applied: false, reason: 'independent-field-not-allowed:' + field };
    // 测试注入内存配置（无 opts.publisherDir 显式覆盖）时绝不读写任何磁盘独立配置。
    if (opts.config && !opts.publisherDir) return { applied: false, notInstalled: true, reason: 'independent-config-test-injected' };
    const file = path.join(opts.publisherDir || PUBLISHER_DIR, 'daily-plan-config.json');
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return { applied: false, notInstalled: true, reason: 'independent-config-missing' };
      return { applied: false, reason: 'independent-config-unreadable:' + ((e && e.code) || (e && e.message) || e) };
    }
    const guardShop = configShopByIdOrName(String(shopId));
    if (!guardShop) return { applied: false, reason: 'guard-shop-not-found' };
    let cfg;
    try { cfg = JSON.parse(raw); } catch (_) { return { applied: false, reason: 'independent-config-invalid-json' }; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg) || !Array.isArray(cfg.shops)) {
      return { applied: false, reason: 'independent-config-invalid-shape' };
    }
    const gid = guardShop.id != null ? String(guardShop.id) : null;
    const gname = guardShop.name != null ? String(guardShop.name) : null;
    const matches = cfg.shops.filter((s) => s && typeof s === 'object'
      && ((gid != null && String(s.id) === gid) || (gname != null && String(s.name) === gname)));
    if (matches.length === 0) return { applied: false, reason: 'independent-shop-not-found', guardShop: gid || gname };
    if (matches.length > 1) return { applied: false, reason: 'independent-shop-ambiguous:' + matches.length, guardShop: gid || gname };
    const target = matches[0];
    // 严格同型比较：请求 value 已由 monitor.updateShop 校验为合法 number；独立配置若历史
    // 误存字符串（如 "14"）不得误判 unchanged（严格 runner 仍会失败），必须落写 number 原值。
    if (target[field] === value) return { applied: true, unchanged: true, value: target[field] };
    // 写前 CAS 复核：自读取以来文件字节被并发改动（另一保存/发布器写入）→ 重读一次仍漂移即放弃，
    // 绝不基于旧快照整文件覆盖、绝不丢并发落盘的较新设置。
    let current;
    try { current = fs.readFileSync(file, 'utf8'); } catch (e) { return { applied: false, reason: 'independent-config-reread-failed:' + ((e && e.code) || e) }; }
    if (current !== raw) return { applied: false, reason: 'independent-config-concurrent-drift' };
    const before = target[field];
    target[field] = value;
    const tmp = file + '.tmp-' + process.pid;
    try {
      fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n');
      fs.renameSync(tmp, file);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch (_) { /* 临时文件清理失败不改判定 */ }
      // 写失败时目标文件未被 rename 触碰；如极小概率 rename 后抛错，按读回复核为准。
      let after = null;
      try { after = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { after = null; }
      if (after && Array.isArray(after.shops)) {
        const m2 = after.shops.find((s) => s === target || (s && typeof s === 'object'
          && ((gid != null && String(s.id) === gid) || (gname != null && String(s.name) === gname))));
        if (m2 && String(m2[field]) === String(value)) return { applied: true, value: m2[field] };
      }
      return { applied: false, reason: 'independent-config-write-failed:' + ((e && e.code) || (e && e.message) || e) };
    }
    // 回读确认：本轮只修改该店 targetRoi；发现不一致时保留磁盘实际内容并报失败。
    let readBack;
    try { readBack = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { readBack = null; }
    const rbShop = readBack && Array.isArray(readBack.shops)
      ? readBack.shops.find((s) => s && typeof s === 'object'
        && ((gid != null && String(s.id) === gid) || (gname != null && String(s.name) === gname)))
      : null;
    if (!rbShop || rbShop[field] !== value || JSON.stringify(readBack) !== JSON.stringify(cfg)) {
      // 回读不一致：可能是 rename 后另一进程恰在此刻原子保存了较新内容（含新 ROI/预算/新字段）。
      // 绝不用本轮读取的旧 raw 快照整文件覆盖——那会丢并发写者的较新设置；保留磁盘实际内容，
      // 仅返回明确失败（guard 侧 ROI 的必要回滚在 route 层按原逻辑执行）。
      target[field] = before; // 内存快照同步还原，避免后续误用
      return { applied: false, reason: 'independent-config-readback-mismatch', keptCurrentFile: true };
    }
    return { applied: true, value: readBack.shops.find((s) => s && typeof s === 'object'
      && ((gid != null && String(s.id) === gid) || (gname != null && String(s.name) === gname)))[field] };
  }
  function syncIndependentShopTargetRoi(shopId, value) {
    return syncIndependentShopField(shopId, 'targetRoi', value);
  }
  function syncIndependentShopPlanQuantity(shopId, value) {
    return syncIndependentShopField(shopId, 'plansPerShopPerDay', value);
  }
  // ── 值守补发桥（2026-10-26 patrol-plan-refill，客户要求）────────────────────
  // 每个完整巡查周期结束后（Monitor onPollComplete，周期锁已清）按需触发一次独立
  // plan-publisher 的当日缺额检查：隐藏子进程 wscript //B //Nologo daily-plan-hidden.vbs
  // （即 node daily-plan-runner.cjs --run 既有入口，全天有效，无 08:00 门槛）。
  // 约束：非阻塞（spawn 后即返回，不等待发布）；在途去重（同一时刻至多一个补发子进程，
  // 进程锁/账本由 runner 侧既有 ledger lock 兜底，08:00 旧任务/手动触发与桥并发时同一把锁）；
  // 发布器失败/被锁只记日志，绝不影响 30 分钟值守与广告决策；不树杀、不碰镜像/进程树。
  // 路径/spawn 可经 opts.patrolRefillLauncher = { publisherDir, spawn } 注入用于隔离测试。
  function triggerPatrolPlanRefill(info = {}) {
    if (drill._patrolRefillChild) return { ok: false, reason: 'patrol-refill-in-flight', inFlight: true };
    // patrol-plan-refill 返修：桥只跟踪"活子进程"，子进程退出后同一 Monitor 周期的重复回调
    // 不得再次 spawn（补发检查一周期至多一次）。按周期号去重（Monitor 每完整周期 +1；
    // Monitor 实例重建 = 新 watchDrill 实例/新内存态，天然重置；不引入任何持久状态）。
    const cycleNo = info && typeof info.cycleNo === 'number' ? info.cycleNo : null;
    if (cycleNo != null && drill._patrolRefillLastCycleNo === cycleNo) {
      return { ok: false, reason: 'patrol-refill-cycle-dedup', duplicateCycle: true, cycleNo };
    }
    const launcher = opts.patrolRefillLauncher || {};
    const dir = launcher.publisherDir || PUBLISHER_DIR;
    const spawnFn = launcher.spawn || spawn;
    const vbs = path.join(dir, 'daily-plan-hidden.vbs');
    if (!fs.existsSync(vbs)) {
      if (!drill._patrolRefillMissingLogged) {
        drill._patrolRefillMissingLogged = true;
        pushLog('warn', `值守补发未装配：找不到 ${vbs}（独立发布器未安装？不影响值守巡查）`);
      }
      return { ok: false, reason: 'patrol-refill-launcher-missing' };
    }
    let child;
    try {
      child = spawnFn('wscript.exe', ['//B', '//Nologo', vbs], { windowsHide: true, shell: false, detached: false });
    } catch (e) {
      pushLog('warn', `值守补发触发失败（不影响值守）：${(e && e.message) || e}`);
      return { ok: false, reason: 'patrol-refill-spawn-failed:' + ((e && e.message) || e) };
    }
    drill._patrolRefillChild = child;
    if (cycleNo != null) drill._patrolRefillLastCycleNo = cycleNo;
    const clear = () => { if (drill._patrolRefillChild === child) drill._patrolRefillChild = null; };
    if (child && typeof child.on === 'function') {
      child.on('exit', clear);
      child.on('error', (e) => {
        clear();
        pushLog('warn', `值守补发子进程异常退出（不影响值守）：${(e && e.message) || e}`);
      });
    } else {
      clear(); // 注入的假子进程：无事件句柄时立即让位（测试/无等待语义）
    }
    pushLog('info',
      `巡查周期完成，已触发当日计划补发检查（cycle ${info.cycleNo != null ? info.cycleNo : '—'}；隐藏子进程异步执行，不阻塞值守）`);
    return { ok: true, spawned: true, cycleNo: info.cycleNo != null ? info.cycleNo : null };
  }
  function ensurePlanScheduler() {
    if (drill._planScheduler) return drill._planScheduler;
    let cfg;
    if (opts.config) cfg = opts.config;
    else {
      try { cfg = promo('src/config.js').loadConfig().config; }
      catch (e) { pushLog('warn', `自动发布排程未装配（配置读取失败）：${(e && e.message) || e}`); return null; }
    }
    drill._config = drill._config || cfg;
    try {
      const scheduler = createScheduler({
        planPublishing: cfg.planPublishing,
        ledgerFile: opts.schedulerLedgerFile
          || path.join(opts.dataDir || path.join(PROMO_GUARD_DIR, 'data'), 'promo-plan-scheduler-ledger.json'),
        nowMs: drill._now,
        intervalMs: opts.schedulerIntervalMs,
        onLog: (lvl, msg) => pushLog(lvl, msg),
        // 当前未删除店名单（不能用"广告暂停"排除店）；每 tick 动态读取。
        listShops: () => ((drill._config && Array.isArray(drill._config.shops)) ? drill._config.shops : (cfg.shops || [])),
        // trusted business 构造（含 accountId/roi/budget）：默认用已安装 shop-profile 从配置店
        // 生成（roi 取 targetRoi，预算取排程配置），可被 opts.schedulerBuildBusiness 覆盖。
        buildBusiness: opts.schedulerBuildBusiness || buildTrustedBusiness,
        runPlan: opts.schedulerRunPlan || defaultPlanRunPlan,
        readDaySuccess: opts.schedulerReadDaySuccess || defaultPlanReadDaySuccess,
        // 同锁内的严格准备收口：tick 持锁期间 run 带回耐久零消费证明即写账本，
        // 复用唯一 applyRecoverProofToLedger 严格判据（无第二套宽松实现）。
        applyRunResultToLedger: (ledger, date, shopId, r, cfg, planNumber) => applyRunPreparationClosureToLedger(ledger, date, shopId, r, cfg, planNumber),
        // F1：tick 持排程进程锁期间，对崩溃遗留的在途条目做**本地**准备恢复（无浏览器）：
        // 内部再取 publisher 真实互斥锁 + 既有严格零消费证明 + 既有耐久收口，最后经唯一
        // applySchedulerReleaseToRecord 映射为可重试 unsubmitted。默认接线，不依赖人工 POST。
        recoverStalePreparation: opts.schedulerRecoverStalePreparation || defaultPlanRecoverStalePreparation,
        discoverAccount: 'schedulerDiscoverAccount' in opts ? opts.schedulerDiscoverAccount : defaultPlanDiscoverAccount,
        enableShop: opts.schedulerEnableShop || defaultPlanEnableShop,
        // S47 fresh-release source re-verification (fail-closed): under the scheduler's process lock,
        // re-read the exact publication-source stores bound into the release proof and recompute the
        // content hash. Only a byte-for-byte match against proof.sourceHash permits a mutation; a
        // changed / deleted store or a proof lacking the bound paths refuses with zero change.
        verifyReleaseSourceProof: 'schedulerVerifyReleaseSourceProof' in opts
          ? opts.schedulerVerifyReleaseSourceProof
          : (proof) => {
            const rp = publisherRequire('run-plans.cjs');
            if (!rp || typeof rp.currentPreOpenSourceHash !== 'function') return false;
            if (!proof || typeof proof.sourceHash !== 'string'
              || typeof proof.sourceStateFile !== 'string' || typeof proof.sourceAttemptsFile !== 'string') return false;
            const fresh = rp.currentPreOpenSourceHash(proof.sourceStateFile, proof.sourceAttemptsFile);
            return typeof fresh === 'string' && fresh === proof.sourceHash;
          },
      });
      drill._planScheduler = scheduler;
      scheduler.start(); // start 幂等：重复 boot 不叠加周期
      return scheduler;
    } catch (e) {
      pushLog('error', `自动发布排程装配失败：${(e && e.message) || String(e)}`);
      return null;
    }
  }

  // 默认接线句柄：离线测试据此**直接调用生产默认工厂**（含真实 publisher 入口），
  // 证明默认 runPlan 不是 null/假冒执行器。只读暴露，不新增授权面、不改生产行为。
  drill._planDefaults = {
    runPlan: defaultPlanRunPlan,
    readDaySuccess: defaultPlanReadDaySuccess,
    discoverAccount: defaultPlanDiscoverAccount,
    recover: defaultPlanRecover,
    recoverStalePreparation: defaultPlanRecoverStalePreparation,
    staleInProgressShape,
    applyRecoverProofToLedger,
    applyRunPreparationClosureToLedger,
    releasePreparationLedgerFromRun,
    releaseProvenPrepublication,
    recoverDiscoveryBlocked: recoverDiscoveryBlockedShopDay,
    recoverPreNavigationLoginFailure: recoverPreNavigationLoginFailureShopDay,
    preNavigationLoginFailedShape,
    appendRecoveryAudit,
    enableShop: defaultPlanEnableShop,
    persistConfig: persistPlanPublishingConfig,
    ensureScheduler: ensurePlanScheduler,
    syncIndependentShopTargetRoi,
  };

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
    return `${label}批次结果：${scrub(String(a.outcome || 'unknown'))}（${bits.join('，') || '无明细'}）`
      + `；目标 ${targetIds.length} 条${ids.length ? `（ID ${ids.slice(0, 5).join(',')}${ids.length > 5 ? '…' : ''}）` : ''}`
      + (isPause || isEnable ? `；本次动作=${label}` : `；本次动作=未知（actionType 未提供，未按结果文本猜测）`)
      + (a.confirmReason ? `；回读核验：${scrub(String(a.confirmReason))}` : '')
      + (a.error ? `；失败原因：${scrub(String(a.error))}` : '')
      + (kind === 'unknown' ? '' : `；${verb}，系统绝不删除广告。`);
  }

  /** 判断事件（判定 + 应执行的判断；来自 Monitor.judgements，每个巡查周期一条）。 */
  function describeJudgement(j) {
    const cost = j.costCents;
    const orders = j.orders;
    const thr = j.thresholdCents;
    const head = `第 ${j.cycleNo} 轮判断数据（周期 ${j.cycleNo}${j.trigger ? ` / ${j.trigger}` : ''}）：`;
    if (j.status === 'blocked') {
      return head + `本轮判断被拦下，未得出费用/订单结论；原因：${scrub(String(j.reason || '未知'))}`;
    }
    const perOrder = j.perOrderText ? `，每单 ${j.perOrderText}` : '';
    const body = `费用 ${centsToYuan(cost)} 元（${cost} 分），订单 ${orders} 单${perOrder}`;
    const t = translateSwitchResult(j);
    const extra = j.reason && !t.line.includes(scrub(String(j.reason))) ? `；${scrub(String(j.reason))}` : '';
    return head + `${body}；${t.line}` + extra;
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
      return `命中处理失败：${scrub(String(t.reason || '未知原因'))}${t.dryOutcome ? `（${t.dryOutcome}）` : ''}`;
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
    return `失败原因：${scrub(String(e.error))}${e.code ? ` [${scrub(String(e.code))}]` : ''}${e.scope ? `（${scrub(String(e.scope))}）` : ''}`;
  }

  const PROCESS_LABEL = {
    retry: { label: '重试', level: 'warn' },
    paused: { label: '暂停', level: 'info' },
    view: { label: '回读核验', level: 'info' },
    readback: { label: '回读核验', level: 'info' },
    abort: { label: '已停止', level: 'warn' },
    done: { label: '批次结束', level: 'info' },
    enable: { label: '开启相位', level: 'info' },
    enable_phase: { label: '开启相位', level: 'info' },
    enable_done: { label: '开启相位结束', level: 'info' },
  };
  const ENABLE_SCHEDULER_LABEL = {
    registered: { label: '每日开启任务登记', level: 'info' },
    stopped: { label: '每日开启任务停止', level: 'warn' },
    window_missed: { label: '每日开启错过窗口', level: 'warn' },
  };
  function isInternalProcessKind(kind) {
    return ['cookie-writeback', 'session-cookie-writeback', 'checkpoint-propagate'].includes(kind);
  }
  function processFailed(p) {
    return p.failed === true || !!p.error || p.ok === false || p.success === false || !!p.blocked
      || ['error', 'warn', 'fatal'].includes(p.level)
      || (typeof p.reason === 'string' && /失败|错误|异常|超时|受阻|阻断|未确认|未通过|error|fail(?:ed|ure)?|timeout|blocked/i.test(p.reason))
      || [p.event, p.kind, p.step, p.status, p.result, p.outcome].some((v) => typeof v === 'string'
        && /(?:^|[-_])(fail(?:ed|ure)?|error|abort|blocked|unknown|timeout|unproven|partial|rejected)(?:$|[-_])/i.test(v));
  }
  function processLevel(p) {
    if (processFailed(p)) return p.error || p.failed === true || p.ok === false || p.success === false ? 'error' : 'warn';
    const meta = p.kind === 'enable-scheduler' ? ENABLE_SCHEDULER_LABEL[p.event] : PROCESS_LABEL[p.event];
    return meta ? meta.level : 'info';
  }
  function describeProcess(p) {
    if (isInternalProcessKind(p.kind)) return null;
    const failed = processFailed(p);
    const ev = p.event || p.kind;
    let meta = p.kind === 'enable-scheduler' ? ENABLE_SCHEDULER_LABEL[p.event] : PROCESS_LABEL[p.event];
    let name = meta ? meta.label : null;
    if (p.event === 'plan') {
      name = p.kind === 'chengfang-enable' ? '将开启目标'
        : (p.kind === 'chengfang' ? '将暂停目标' : '待处理目标');
    }
    if (p.step === 'batch-start' && p.kind === 'chengfang-batch') name = '开始暂停批次';
    if (failed) name = p.kind === 'chengfang-overlay' ? '浮窗处理受阻' : (name ? `${name}未通过` : '处理异常');
    const routineSuccess = p.ok === true || p.success === true || ['ok', 'success', 'ready', 'dismissed'].includes(p.result || p.status);
    if (!name && (!p.reason || routineSuccess)) return null;
    if (!name) name = '处理说明';
    const bits = [];
    if (p.view) bits.push(`视图 ${p.view}`);
    if (p.attempt !== undefined) bits.push(`第 ${p.attempt} 次`);
    if (p.confirmed !== undefined) bits.push(`已确认 ${Array.isArray(p.confirmed) ? p.confirmed.length : p.confirmed}`);
    if (p.event === 'plan' && p.targets !== undefined) bits.push(`${Array.isArray(p.targets) ? p.targets.length : p.targets} 个目标`);
    if (p.mode === 'dry-run' || p.dryRun === true) bits.push('演练，不点击');
    if (p.nextRunAt) bits.push(`下次 ${p.nextRunAt}`);
    if (p.note) bits.push(String(p.note));
    if (p.reason) bits.push(`说明：${p.reason}`);
    if (p.error) bits.push(`失败原因：${p.error.message || p.error.reason || String(p.error)}`);
    if (failed && !p.reason && !p.error) bits.push(`未通过：${p.status || p.result || p.outcome || ev || '原因未提供'}`);
    return `${name}${bits.length ? `（${bits.join('，')}）` : ''}`;
  }

  function eventShopPrefix(evt) {
    if (evt.shopId != null && String(evt.shopId) !== '') {
      const id = String(evt.shopId);
      const shops = ((drill._monitor && drill._monitor.config) || drill._config || {}).shops || [];
      const shop = shops.find((s) => s && String(s.id) === id);
      return `[店铺：${scrub(String((shop && (shop.displayName || shop.name)) || id))}] `;
    }
    if (evt.shopName) return `[店铺：${scrub(String(evt.shopName))}] `;
    return evt.kind === 'enable-scheduler' ? '[每日开启任务] ' : '[店铺未标明] ';
  }

  function processingShops() {
    const m = drill._monitor;
    if (!m || !m._shopProcessing) return [];
    return Array.from(m._shopProcessing, (id) => {
      const shop = (m.config.shops || []).find((s) => s && s.id === id);
      return { id, name: scrub(String((shop && (shop.displayName || shop.name)) || id)) };
    });
  }

  function userLogs() {
    return drill._logs.filter((e) => {
      const category = /^(?:\[[^\]\r\n]*\]\s*)?过程：过程事件（([^（）]+)）[\s\S]*；未识别事件名，按原样透出\s*$/.exec(e.msg);
      if (category && isInternalProcessKind(category[1])) return false;
      if (e.level !== 'info') return true;
      const legacy = /^过程：过程事件（([^）]+)）；未识别事件名，按原样透出$/.exec(e.msg);
      return !legacy || processFailed({ event: legacy[1] });
    }).map((e) => ({ ...e, msg: scrub(e.msg) }));
  }

  /**
   * 增量同步（2026-09-15 修复第 1/2/3/4 项）。
   *
   * 游标使用 Monitor 的**单调递增 `evtSeq`**，与有界数组长度完全无关：
   *   - 即使 triggers/actions/recentErrors/judgements 被裁剪，新事件仍能持续接收；
   *   - 若在两次轮询之间发生了超出缓存的裁剪（丢了事件），依据 `dropped`
   *     记录一条**明确的日志缺口**，并继续同步，而不是永久漏日志或静默错位。
   */
  function syncFromMonitor(discoverShops = true) {
    const m = drill._monitor;
    if (!m) return;
    const st = drill.state;

    try {
      // -1) 运行期店铺发现（2026-09-29 第 13 阶段）：每次状态拉取触发带节流的 Cookie 目录
      // 扫描——新增抖店 Cookie 在一个拉取周期内进入配置与下方 shops/shopRows 展示；来源文件
      // 删除不删除店铺（合并规则见 shop-discovery）。仅读目录+合并配置，无页面/广告动作。
      // 第 13 阶段补验证：发现结果（含落盘是否成功/是否待重试）如实进入 /state.shopDiscovery，
      // 集成层不得在落盘失败时声称"持久化成功"；节流命中不覆盖上次结果。
      if (discoverShops && typeof m.requestShopDiscovery === 'function') {
        try {
          const disc = m.requestShopDiscovery();
          if (disc && disc.throttled !== true) {
            st.shopDiscovery = {
              at: new Date(drill._now()).toISOString(),
              added: Array.isArray(disc.added) ? disc.added.map((x) => scrub(String(x))) : [],
              ok: disc.ok === true,
              persisted: disc.persisted === true,
              pending: disc.pending === true,
              reason: disc.reason ? scrub(String(disc.reason)) : null,
            };
          }
        } catch (_) { /* 发现失败不阻塞状态拉取 */ }
      }

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
      st.windowBlockReason = status.monitor.windowBlockReason ? scrub(String(status.monitor.windowBlockReason)) : null;
      st.lastCheckAt = status.monitor.lastCycleAt;
      st.enablePhaseToday = scrubDeep(status.monitor.enablePhaseToday || []);
      // 最近一次会话 Cookie 回写结果（仅元信息，绝不含 Cookie 值；仍递归脱敏）
      st.cookieWriteback = status.monitor.cookieWriteback ? scrubDeep(status.monitor.cookieWriteback) : null;
      st.polling = status.monitor.polling || (drill.state.gates && drill.state.gates.polling) || null;
      st.running = m.running === true;
      // 多店铺：每店独立广告状态与数据行（保持平台-店铺对应）
      st.shopRows = buildShopRows(status);
      // 每店每日计划数量展示（客户 2026-10-13）：以已保存的每店配置为准（合法整数 1..10），
      // 缺省回落全局排程 plansPerShopPerDay（默认 3）。monitor 状态投影不含该键，故从
      // watch-drill 自有 config.shops 解析回填，供页面 ROI 后展示与编辑基线使用。
      {
        const gp = (drill._config && drill._config.planPublishing && Number.isInteger(drill._config.planPublishing.plansPerShopPerDay))
          ? drill._config.planPublishing.plansPerShopPerDay : 3;
        st.shopRows.forEach((row) => {
          const cs = configShopByIdOrName(row.id) || configShopByIdOrName(row.name);
          row.plansPerShopPerDay = (cs && Number.isInteger(cs.plansPerShopPerDay) && cs.plansPerShopPerDay >= 1 && cs.plansPerShopPerDay <= 10)
            ? cs.plansPerShopPerDay : gp;
        });
      }
      // 第 13 阶段补验证：shops/shopName 与 shopRows 同源刷新（同一 status.shops、同一 deleted
      // 过滤），使运行期新增/来源删除后 /state 的 shops、shopRows、shopName 三处一致；旧行为仅在
      // 装配时赋值，运行期发现新店后 shops/shopName 会滞后于 shopRows。
      const activeStatusShops = (status.shops || []).filter((s) => s && s.deleted !== true);
      drill.shops = activeStatusShops.map((s) => ({
        id: s.id,
        name: s.displayName || s.name || s.id,
        platform: s.platform || 'douyin',
        targetRoi: s.targetRoi != null ? s.targetRoi : 15,
      }));
      drill.shopName = drill.shops.map((s) => s.name).join('、') || '—';
      st.adState = st.shopRows.length ? st.shopRows[0].adState : deriveAdState(status, (status.shops || [])[0]);
      const thrRule = (status.rules || []).find((r) => r.type === 'wholeShopCostPerOrder' && r.enabled !== false);
      st.thresholdCents = st.shopRows.length && st.shopRows[0].thresholdCents != null
        ? st.shopRows[0].thresholdCents
        : (thrRule ? thrRule.thresholdCents : null);
      // roundNo 取 Monitor 的真实周期号（每个完整 pollOnce 递增一次）
      const mCycleNo = (status.monitor && status.monitor.cycleNo) || m.cycleNo || 0;
      if (typeof mCycleNo === 'number' && mCycleNo >= 0) st.roundNo = mCycleNo;
      // engine 真实执行字段：本刻是否有周期在途（空闲等待下次巡查时 phase 仍 'running' 但为 false）
      st.cycleRunning = status.monitor && status.monitor.cycleRunning === true;
      if (st.running) {
        st.status = computeRunningStatus(status.monitor.phase, st.cycleRunning);
      } else if (st.status !== 'reading') {
        st.status = 'idle';
      }

      // 2) 最近一轮展示数据（多店铺：每店独立 lastRounds；兼容 lastRound=第一店）
      st.lastRounds = st.lastRounds || {};
      const activeShopList = (status.shops || []).filter((x) => x && x.deleted !== true);
      for (const shop of activeShopList) {
        if (shop && shop.today) {
          const d = shop.today;
          const sw = translateSwitchResult(d);
          st.lastRounds[shop.id] = {
            shopId: shop.id,
            shopName: shop.displayName || shop.name || shop.id,
            roundNo: st.roundNo,
            businessDate: d.businessDate,
            costCents: d.costCents,
            costRaw: d.rawCostText ? scrub(String(d.rawCostText)) : null,
            costText: d.costText ? scrub(String(d.costText)) : null,
            orders: d.orders,
            perOrderText: d.perOrderText ? scrub(String(d.perOrderText)) : null,
            over: d.over === true,
            conclusion: d.over === true ? 'over' : 'under',
            conclusionText: scrub(sw.head),
            switchText: scrub(sw.line),
            decision: d.decision || null,
            zeroClick: d.zeroClick === true,
            reason: scrub(String(d.blockedReason || d.reason || '')) || null,
            fetchedAt: d.fetchedAt,
            pageUpdatedAt: d.pageUpdatedAt,
          };
        } else {
          st.lastRounds[shop.id] = st.lastRounds[shop.id] || { shopId: shop.id, shopName: shop.displayName || shop.name || shop.id, reason: null };
        }
      }
      const firstActive = activeShopList[0];
      if (firstActive && firstActive.today) {
        st.lastRound = st.lastRounds[firstActive.id];
        st.lastError = scrub(String(firstActive.today.blockedReason || firstActive.lastError || '')) || null;
      } else {
        st.lastError = st.lastRound && st.lastRound.reason ? scrub(String(st.lastRound.reason)) : (st.lastError ? scrub(String(st.lastError)) : null);
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
            // 只有「>50 且严格超标」的 ROI 提示才升为 warn；50 元保护区内的费比超标不是数据故障
            pushLog(evt.roiTooLow === true ? 'warn' : 'info', eventShopPrefix(evt) + describeJudgement(evt));
            // 飞书通知：同一轮只推一次（cycleNo 幂等），失败只记日志不影响值守
            notifyJudgement(evt).catch(() => {});
          } else if (isBatch) {
            // 批次结果事件（重试/回读结论随 outcome/confirmReason/remaining 一并进入日志）
            const kind = actionKindOf(evt);
            const ok = evt.allClosedConfirmed === true || evt.allPausedConfirmed === true
              || evt.allEnabledConfirmed === true || evt.outcome === 'ok';
            pushLog(ok ? 'info' : 'warn', eventShopPrefix(evt) + describeBatch(evt, kind));
          } else if (isTrigger) {
            pushLog(evt.failed ? 'error' : (evt.mode === 'dry' ? 'info' : 'warn'), eventShopPrefix(evt) + describeTrigger(evt));
          } else if (isProcess) {
            const message = describeProcess(evt);
            if (message) pushLog(processLevel(evt), eventShopPrefix(evt) + message);
          } else if (isError) {
            pushLog('error', eventShopPrefix(evt) + describeError(evt));
          } else if (processFailed(evt)) {
            const message = describeProcess(evt);
            if (message) pushLog(processLevel(evt), eventShopPrefix(evt) + message);
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
        pushLog(lvl, eventShopPrefix(item) + `每日开启相位：${label}（日期 ${rec.date || '—'}${rec.phase ? `，阶段 ${rec.phase}` : ''}）`
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
      if (t) pushLog(t.failed ? 'error' : (t.mode === 'dry' ? 'info' : 'warn'), eventShopPrefix(t) + describeTrigger(t));
    }
    drill._lastTriggersSeenLegacy = trig.length;
    const acts = _harvest(status.actions);
    for (let i = drill._lastActionsSeenLegacy || 0; i < acts.length; i += 1) {
      const a = acts[i];
      if (!a) continue;
      const kind = actionKindOf(a);
      const ok = a.allClosedConfirmed === true || a.allPausedConfirmed === true || a.allEnabledConfirmed === true;
      pushLog(ok ? 'info' : 'warn', eventShopPrefix(a) + describeBatch(a, kind));
    }
    drill._lastActionsSeenLegacy = acts.length;
    const errs = _harvest(status.recentErrors);
    for (let i = drill._lastErrorSeenLegacy || 0; i < errs.length; i += 1) {
      const e = errs[i];
      if (e) pushLog('error', eventShopPrefix(e) + describeError(e));
    }
    drill._lastErrorSeenLegacy = errs.length;
    pushLog('warn', '当前 Monitor 未提供事件流（evtSeq）；已退化为按有界数组消费，可能漏事件。');
  }

  /**
   * 只读运行时版本指纹：require.resolve 实际解析路径 + 该路径字节 sha256。
   * 只写启动日志/只读状态；不写 Cookie、店铺 ID、令牌、密钥。
   * 不把工作区文件存在当作运行时已加载证据。
   */
  function collectRuntimeFingerprint() {
    if (drill._runtimeFingerprint) return drill._runtimeFingerprint;
    try {
      const fpMod = promo('src/lib/runtime-fingerprint.js');
      const fp = fpMod.computeRuntimeFingerprint([
        { id: 'watch-drill', path: __filename },
      ]);
      drill._runtimeFingerprint = fp;
      const line = fpMod.formatFingerprintLine(fp);
      pushLog('info', line);
      try { console.log(line); } catch (_) { /* 启动日志尽力而为 */ }
      return fp;
    } catch (err) {
      const fp = {
        buildMarker: null,
        at: new Date().toISOString(),
        pid: process.pid,
        ok: false,
        error: String((err && err.message) || err).slice(0, 160),
        files: [],
      };
      drill._runtimeFingerprint = fp;
      pushLog('warn', `运行时版本指纹不可用：${fp.error}`);
      return fp;
    }
  }

  // ── 对外操作 ─────────────────────────────────────────────────────────────
  /**
   * 服务启动装配（2026-09-15 上线；2026-10-09 客户要求改为自动启动值守）：
   * 3443 进程启动即调用，不依赖任何页面访问。
   * - 装配 Monitor（只读装配）；
   * - 按配置自动登记独立每日首次开启检查任务（重启自动恢复；用户独立停用除外）；
   * - **按客户要求自动启动推广值守（超额暂停巡查）一次**（幂等；本次运行中人工停止后
   *   页面重开不恢复；下一次服务启动再次自动启动）；
   * - 启动后台周期同步：无人打开页面也持续转译事件流并落盘值守日志。
   */
  function boot() {
    try { collectRuntimeFingerprint(); } catch (_) { /* 指纹失败不阻塞装配 */ }
    try {
      ensureMonitor();
    } catch (e) {
      pushLog('error', `值守装配失败（服务启动）：${(e && e.message) || String(e)}`);
      return snapshot();
    }
    const m = drill._monitor;
    // 后台自动发布排程：独立装配（失败不阻塞值守）。boot 幂等。
    try { ensurePlanScheduler(); } catch (_) { /* ensurePlanScheduler 内部已记日志 */ }
    if (m.enableSchedulerShouldRun()) {
      const r = m.startEnableScheduler({ reason: '服务启动自动恢复' });
      if (r && r.ok === false) {
        pushLog('warn', `每日首次开启检查任务登记失败：${r.reason}`);
      } else {
        const t = (drill.state.enableTask = syncEnableTask()) || {};
        pushLog('info', `独立每日首次开启检查任务已登记：每日 ${t.firstCheckTime || '00:05'}（上海）后检查当天是否暂停，暂停才作为当天首次开启；`
          + `下次 ${t.nextRunAt || '—'}；与"启动值守"相互独立（停止值守不取消本任务）。`);
      }
    } else {
      const cf = (m.config.monitor && m.config.monitor.chengfang) || {};
      pushLog('info', cf.enableSchedulerEnabled === true
        ? '每日首次开启检查任务保持"用户独立停用"状态（服务重启不自动恢复，可在页面手动恢复）'
        : '独立每日首次开启检查任务未启用（monitor.chengfang.enableSchedulerEnabled=false）');
    }
    // 客户目标（2026-10-09 AD-AUTOSTART）：推广值守随主服务启动自动启动一次。
    // - 幂等：start() 内部 alreadyRunning 守卫，重复 boot 不叠加调度循环；
    // - 失败收口：monitor.start() 被拒（如配置 pending）只记日志、不遗留运作中的值守实例；
    // - 本次运行中人工停止后：页面打开/关闭/刷新只读拉取状态，不隐式恢复；
    //   下一次服务启动再次自动启动（按客户要求）。
    // - 隔离逃逸：opts.autostartOnBoot === false 时不自动启动（仅供不希望 _intervalLoop
    //   干扰单店派发计数的隔离测试使用；生产服务启动不传该 opt，默认自动启动）。
    try { refreshGates(); } catch (_) { /* 门槛快照失败不阻塞自动启动 */ }
    if (opts.autostartOnBoot !== false) {
      pushLog('info', '服务启动自动启动推广值守（客户 2026-10-09 要求）；页面打开/关闭/刷新只读，不改变后台值守状态');
      start();
    }
    if (!drill._syncTimer) {
      drill._syncTimer = setInterval(() => { try { syncFromMonitor(); } catch (_) { /* 后台同步失败不影响运行 */ } }, 60 * 1000);
      if (typeof drill._syncTimer.unref === 'function') drill._syncTimer.unref();
    }
    if (drill._notify.enabled) {
      pushLog('info', `飞书通知已启用：每轮巡查数据经 Hermes（hermes send）推送至 ${drill._notify.target}；发送失败只记日志，不影响值守。`);
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

  /**
   * 登录成功后的立即接管（WD-NEW-1，2026-10-02；补修版：只处理登录店）。
   *
   * 客户口径：店铺商品分析中登录抖店成功、Cookie 保存成功后，立即按**当时**后台值守状态接管：
   *   - 值守运行中 → **只对登录店**立即执行一次单店处理（引擎 joinShopNow：复用既有单店规则、
   *     执行器与取消令牌；其他店铺执行次数为 0、全局下次检查不被重排），随后对本店做独立
   *     只读回读（refreshShopData）；
   *   - 值守停止 → 店铺立即进入列表并保持停止，零动作（不启动值守、不派发广告操作）。
   *
   * 补修边界（照抄主脑意见，逐条落实）：
   *   #1 不用 pollNowAndReschedule（全店+全局重排），不通过临时改 config.shops 筛选；
   *   #2 派发前复核 running；引擎侧等待全局周期收口后、实际派发前再次复核 running/令牌；
   *   #3 完成判据=目标店实际 status==='ok'（含 dry 演练口径）且必要回读成功；
   *      blocked/window_blocked/stopped/skipped 分别如实返回，绝不把“周期收口”当成功；
   *   #4 同店在途合并（不重复派发）；不同店并发按 shopId 归档，互不覆盖；
   *   #5 身份唯一绑定（id/name/cookieFile 精确匹配；displayName 可能重名不参与；软删除不复活；
   *      多候选=身份歧义整批拒绝；人工设置不重置）；
   *   #6 初始响应只表示已加入/处理中；completion 异常兜底收口为可读取失败状态，
   *      绝不遗留 processing；最终结果经 state.loginJoins/lastLoginJoin 与日志回读。
   *
   * 返回：{ ...快照事实, completion: Promise<finalOut> }。
   *   - 快照阶段（发现→身份→现读状态→加入列表事实）同步完成，供 /login-new-shop 立即返回；
   *   - 值守运行中的单店处理在后台执行，完成后更新 state 并落值守日志；completion 永不 reject。
   *   - 服务端应剥离 completion 后再 JSON 返回。
   */
  // ── F4（2026-10-24）：登录成功后的“停用/停止”只读刷新 ──────────────────────
  // 场景：普通停用店主动登录、删除后主动扫码恢复店（enabled=false）、值守停止时的登录。
  // 只对目标店做一次**现有只读**数据刷新（Monitor.refreshShopData）：不调用
  // joinShopNow/pollNowAndReschedule、不启动值守/每日任务/发布恢复、零广告动作；
  // enabled 保持 false。复用既有 loginJoins/lastLoginJoin 状态记录与 _loginJoins 同店
  // 在途合并；读取失败如实记 failed 与原因，绝不把登录成功冒称数据成功；GET state 不触发读取。
  function readonlyLoginRefresh(m, shopCfg, base) {
    const shopName = base.shopName;
    const inflight = drill._loginJoins.get(shopCfg.id);
    if (inflight && inflight.promise) {
      return { merged: true, completion: inflight.promise };
    }
    const joinState = {
      shopName, platform: base.platform, shopId: shopCfg.id, status: 'processing',
      joined: true, running: m.running === true, action: 'readonly-refresh',
      startedAt: new Date(drill._now()).toISOString(), result: null, readBack: null,
      reason: base.note || null,
    };
    drill.state.lastLoginJoin = joinState;
    drill.state.loginJoins = drill.state.loginJoins || {};
    drill.state.loginJoins[shopCfg.id] = joinState;
    const shopId = shopCfg.id;
    const identity = ['id', 'name', 'cookieFile', 'platform', 'accountId', 'compassShopName']
      .map((key) => [key, shopCfg[key]]);
    const targetUnavailableReason = () => {
      if (drill._monitor !== m) return '值守实例已变更，取消登录后只读刷新';
      const matches = (m.config.shops || []).filter((s) => s && (s.id === shopId
        || s.id === shopName || s.name === shopName
        || (s.cookieFile && String(s.cookieFile).replace(/\.json$/i, '').trim() === shopName)));
      if (matches.length !== 1) return '目标店铺不存在或身份不唯一，取消登录后只读刷新';
      if (matches[0].deleted === true) return '店铺已删除，取消登录后只读刷新';
      if (identity.some(([key, value]) => matches[0][key] !== value)) {
        return '目标店铺身份已变更，取消登录后只读刷新';
      }
      return null;
    };
    // 沿用 joinShopNow 的等待上限与节奏，不改变实际读取或鉴权超时。
    const waitMs = Math.max(2 * 60 * 1000, ((m.config.schedule || {}).intervalMinutes || 30) * 60 * 1000);
    const deadline = drill._now() + waitMs;
    const delay = opts.delayFn || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    const entry = { promise: null };
    drill._loginJoins.set(shopId, entry);
    const completion = (async () => {
      let readBack;
      try {
        let rb;
        let remainingWaitMs = waitMs;
        while (true) {
          const unavailable = targetUnavailableReason();
          if (unavailable) {
            rb = { ok: false, reason: unavailable };
            break;
          }
          if (rb && (remainingWaitMs <= 0 || drill._now() >= deadline)) {
            rb = { ...rb, ok: false, reason: `等待既有处理/资源收口超时，未执行登录后只读刷新（${rb.blocked}）` };
            break;
          }
          rb = await m.refreshShopData(shopId);
          const changed = targetUnavailableReason();
          if (changed) {
            rb = { ok: false, reason: changed };
            break;
          }
          if (!rb || !['shop_busy', 'cycle_busy', 'recovery_inflight'].includes(rb.blocked)) break;
          joinState.reason = `登录后只读刷新等待既有处理/资源收口（${rb.blocked}）；尚未读取新数据`;
          const pauseMs = Math.min(200, remainingWaitMs, Math.max(0, deadline - drill._now()));
          if (pauseMs > 0) await delay(pauseMs);
          // 同时扣减等待预算，时钟回拨也不能无限保留 processing。
          remainingWaitMs -= pauseMs;
        }
        readBack = {
          ok: rb && rb.ok === true && !rb.blocked,
          blocked: rb && rb.blocked ? scrub(String(rb.blocked)) : null,
          reason: rb && rb.reason ? scrub(String(rb.reason)) : null,
          adState: rb && rb.adState ? rb.adState : null,
          costCents: rb && rb.data && rb.data.costCents != null ? rb.data.costCents : null,
          orders: rb && rb.data && rb.data.orders != null ? rb.data.orders : null,
        };
      } catch (e) {
        readBack = { ok: false, reason: scrub(String((e && e.message) || e)) };
      }
      joinState.readBack = readBack;
      if (readBack.ok) {
        joinState.status = 'done';
        joinState.reason = `${base.note || '登录后只读刷新'}；只读刷新成功（费用/订单/余额/广告状态以值守状态与日志为准）`;
        pushLog('info', `[值守接管] 店铺「${shopName}」登录后只读刷新完成：仅读取数据、零广告动作（${base.note || ''}）`);
      } else {
        joinState.status = 'failed';
        joinState.reason = `登录后只读数据刷新未成功${readBack.reason ? '：' + readBack.reason : ''}（登录成功的事实不受影响；不虚报数据成功）`;
        pushLog('warn', `[值守接管] 店铺「${shopName}」${joinState.reason}`);
      }
      joinState.finishedAt = new Date(drill._now()).toISOString();
      if (drill._loginJoins.get(shopId) === entry) drill._loginJoins.delete(shopId);
      syncFromMonitor(false);
      return {
        shopId, shopName, action: 'readonly-refresh',
        readBack, reason: joinState.reason,
      };
    })();
    entry.promise = completion;
    completion.catch(() => { /* 永不向外抛；结果以 state.loginJoins/lastLoginJoin 与日志为准 */ });
    return { merged: false, completion };
  }

  function joinShopAfterLogin(opts = {}) {
    const shopName = String((opts && opts.shopName) || '').trim();
    const platform = String((opts && opts.platform) || 'douyin');
    const out = {
      shopName, platform,
      attempted: false, joined: false, addedNow: null, shopId: null,
      running: null, action: null, processed: null, cycleNo: null, nextRunAt: null,
      readBack: null, reason: null,
    };
    const done = (finalOut) => Object.assign({}, finalOut);

    if (platform === 'pinduoduo') {
      out.reason = '拼多多不接入抖店推广值守（仅进入商品分析列表，零动作）';
      pushLog('info', `[值守接管] 拼多多店铺「${shopName || '—'}」不接入推广值守：${out.reason}`);
      return done(out);
    }
    if (!shopName) {
      out.reason = '登录成功但缺少店铺名（身份不明），不接管、零动作';
      pushLog('warn', `[值守接管] ${out.reason}`);
      return done(out);
    }
    out.attempted = true;

    let m;
    try {
      m = ensureMonitor();
    } catch (e) {
      out.reason = `值守装配失败：${(e && e.message) || e}`;
      pushLog('error', `[值守接管] 店铺「${shopName}」${out.reason}`);
      drill.state.lastLoginJoin = { shopName, platform, status: 'failed', at: new Date(drill._now()).toISOString(), reason: out.reason };
      return done(out);
    }

    const norm = (v) => String(v == null ? '' : v).replace(/\.json$/i, '').trim();
    const matchIdentity = (s) => s && (s.id === shopName || s.name === shopName || (s.cookieFile && norm(s.cookieFile) === shopName));
    const initialMatches = (m.config.shops || []).filter(matchIdentity);
    if (initialMatches.length > 1) {
      return done({ ...out, action: 'none', reason: 'TARGET_AMBIGUOUS' });
    }
    // F3：真实删除输出为 deleted:true + enabled:false。仅“普通停用”（非删除）在此提前返回；
    // 已删除条目必须下沉到下方 restoreDeletedShop 主动登录恢复分支（恢复后仍保持 enabled:false）。
    if (initialMatches.length === 1 && initialMatches[0].enabled === false && initialMatches[0].deleted !== true) {
      // F4：普通停用店主动登录 → 仍不发现/不恢复/不接管，但对目标店做一次现有只读数据刷新
      // （enabled 保持 false；不启动值守/每日任务/发布恢复；零广告动作）。
      const rr = readonlyLoginRefresh(m, initialMatches[0], {
        shopName, platform,
        note: '店铺停用：不发现、不恢复、不接管；登录后仅做一次只读数据刷新（enabled 保持 false）',
      });
      return Object.assign(done({
        ...out, shopId: initialMatches[0].id, joined: true,
        action: 'readonly-refresh', processing: rr.merged ? 'merged' : 'started',
        merged: rr.merged || undefined,
        reason: '店铺停用：不发现、不恢复、不接管；登录后仅做一次只读数据刷新（enabled 保持 false）',
      }), { completion: rr.completion });
    }

    // 1) 立即发现（force 绕过 /state 拉取节流；幂等：既有条目原样保留，不重复添加、不重置人工设置）
    let disc = null;
    try {
      disc = m.requestShopDiscovery({ force: true });
    } catch (e) {
      disc = { ok: false, reason: (e && e.message) || String(e) };
    }
    out.discovery = {
      ok: disc && disc.ok === true,
      throttled: disc && disc.throttled === true,
      added: Array.isArray(disc && disc.added) ? disc.added.map((x) => scrub(String(x))) : [],
      persisted: disc && disc.persisted === true,
      pending: disc && disc.pending === true,
      reason: disc && disc.reason ? scrub(String(disc.reason)) : null,
    };

    // 2) 身份唯一绑定（补修 #5）：只按保存的 Cookie 对应店铺匹配（id/name/cookieFile 精确，
    //    与 Cookie 发现同源口径）；displayName 仅展示用、可能重名，绝不参与匹配、绝不“取第一条”。
    //    软删除店不作为接管目标（不复活）；候选多于一家 → 身份歧义，整批拒绝、零动作。
    const candidates = (m.config.shops || []).filter((s) => s && s.deleted !== true && matchIdentity(s));
    if (candidates.length > 1) {
      out.reason = `店铺身份歧义：${candidates.length} 家活动店铺同时匹配「${shopName}」（${candidates.map((s) => s.id).join('、')}），不取第一条、不接管、零动作`;
      pushLog('warn', `[值守接管] ${out.reason}`);
      drill.state.lastLoginJoin = { shopName, platform, status: 'failed', at: new Date(drill._now()).toISOString(), reason: out.reason };
      return done(out);
    }
    let shopCfg = candidates[0] || null;
    if (!shopCfg && !out.discovery.pending) {
      // SHOP-LIFE-1：用户主动登录（身份确认+Cookie 保存成功）= 明确重新加入——
      // 允许恢复**同身份**的软删除条目（保留人工设置、不新增重复项、不恢复错名条目）；
      // 普通 Cookie 自动发现的“绝不复活”语义不变（仅本主动登录路径调用 restoreDeletedShop）。
      const deletedMatches = (m.config.shops || []).filter((s) => s && s.deleted === true && matchIdentity(s));
      if (deletedMatches.length > 1) {
        out.reason = `店铺身份歧义：${deletedMatches.length} 条已删除条目同时匹配「${shopName}」（${deletedMatches.map((s) => s.id).join('、')}），不取第一条、不接管、零动作`;
        pushLog('warn', `[值守接管] ${out.reason}`);
        drill.state.lastLoginJoin = { shopName, platform, status: 'failed', at: new Date(drill._now()).toISOString(), reason: out.reason };
        return done(out);
      }
      if (deletedMatches.length === 1) {
        const rr = (typeof m.restoreDeletedShop === 'function')
          ? m.restoreDeletedShop(deletedMatches[0].id, { reason: 'login-rejoin' })
          : { ok: false, reason: '引擎不支持恢复已删除条目（版本过旧）' };
        if (!rr.ok) {
          out.reason = `重新加入失败：${rr.reason}`;
          pushLog('warn', `[值守接管] 店铺「${shopName}」${out.reason}`);
          drill.state.lastLoginJoin = { shopName, platform, status: 'failed', at: new Date(drill._now()).toISOString(), reason: out.reason };
          return done(out);
        }
        shopCfg = rr.entry;
        out.restored = true;
        out.shopId = shopCfg.id;
        pushLog('info', `[值守接管] 店铺「${shopName}」为已删除条目，用户主动登录 → 已重新加入值守（人工设置保留、无重复条目）；普通 Cookie 扫描仍绝不复活已删除店铺`);
      }
    }
    if (!shopCfg) {
      out.reason = `Cookie 目录发现未找到「${shopName}」的店铺 Cookie（身份不明），未接管、零动作`
        + (out.discovery.pending ? '；另：店铺配置落盘待重试（内存未生效）' : '');
      pushLog('warn', `[值守接管] ${out.reason}`);
      drill.state.lastLoginJoin = {
        shopName, platform, status: 'failed', at: new Date(drill._now()).toISOString(),
        reason: out.reason, discovery: out.discovery,
      };
      return done(out);
    }
    out.joined = true;
    out.shopId = shopCfg.id;
    out.addedNow = out.discovery.added.includes(shopName);
    if (shopCfg.enabled === false) {
      // F4：删除后主动扫码恢复（或已存在停用）→ 不接管、不安排发布恢复，但做一次只读数据刷新
      // （enabled 保持 false；不启动值守/每日任务/发布恢复；零广告动作）。
      const rr = readonlyLoginRefresh(m, shopCfg, {
        shopName, platform,
        note: '店铺停用：不接管、不安排发布恢复；登录后仅做一次只读数据刷新（enabled 保持 false）',
      });
      return Object.assign(done({
        ...out, action: 'readonly-refresh', processing: rr.merged ? 'merged' : 'started',
        merged: rr.merged || undefined,
        reason: '店铺停用：不接管、不安排发布恢复；登录后仅做一次只读数据刷新（enabled 保持 false）',
      }), { completion: rr.completion });
    }
    // 3) 现读值守状态（决策时点状态，而非登录开始时的旧状态）
    out.running = m.running === true;
    if (!out.running) {
      // F4：值守停止时的登录 → 店铺保持停止、零广告动作；仍对目标店做一次只读数据刷新
      //（不启动值守/每日任务/发布恢复）。
      out.action = 'readonly-refresh';
      out.reason = '值守未运行：店铺已加入列表并保持停止（零动作；不启动值守、不派发广告操作）；登录后仅做一次只读数据刷新';
      pushLog('info', `[值守接管] 店铺「${shopName}」已加入值守列表${out.addedNow ? '（新发现）' : '（已存在，未重复添加、未重置人工设置）'}；值守当前未运行 → 保持停止，零动作；登录后仅对本店做一次只读数据刷新`);
      const rr = readonlyLoginRefresh(m, shopCfg, {
        shopName, platform, running: false,
        note: out.reason,
      });
      out.processing = rr.merged ? 'merged' : 'started';
      if (rr.merged) out.merged = true;
      return Object.assign(done(out), { completion: rr.completion });
    }

    // R78：登录成功 = 账户发现前置阻断（blocked + entries 严格空 + plans=0）的合法恢复
    // 触发之一（另一入口是显式 recover 端点）。内部无该形状记录即零动作；绝不定时探测。
    // F5：仅运行中活动店触发；停用/停止登录只读更新不进入发布恢复。
    scheduleDiscoveryBlockedRecovery(out.shopId, 'login-success');

    // 4) 值守运行中：只对目标店立即处理（补修 #1：不用 pollNowAndReschedule——那会处理
    //    所有店铺并重排全局 nextRunAt）。复用引擎 joinShopNow（单店、既有规则/执行器/取消
    //    令牌、内部有 running 与周期收口等待后的复核门禁），随后对本店做独立只读回读。
    //    同店在途合并（补修 #4）：重复登录/重复事件不重复派发；不同店并发互不覆盖（按 shopId 归档）。
    out.action = 'targeted-join';
    const inflight = drill._loginJoins.get(shopCfg.id);
    if (inflight && inflight.promise) {
      out.merged = true;
      out.processing = 'merged';
      pushLog('info', `[值守接管] 店铺「${shopName}」已有立即处理在途：本次登录事件合并到在途任务，不重复派发（结果见同店在途任务）`);
      return Object.assign(out, { completion: inflight.promise });
    }
    out.processing = 'started';
    pushLog('info', `[值守接管] 店铺「${shopName}」已加入值守列表${out.addedNow ? '（新发现）' : '（已存在，未重复添加、未重置人工设置）'}；值守运行中 → 立即只处理本店（既有单店规则/执行器/取消机制；其他店铺调度与任务不受影响；dry/real 由既有配置决定；绝不删除广告）`);
    const joinState = {
      shopName, platform, shopId: out.shopId, status: 'processing',
      joined: true, running: true, action: 'targeted-join',
      startedAt: new Date(drill._now()).toISOString(), result: null, readBack: null, reason: null,
    };
    drill.state.lastLoginJoin = joinState; // 最近一次（兼容展示）
    drill.state.loginJoins = drill.state.loginJoins || {};
    drill.state.loginJoins[shopCfg.id] = joinState; // 每店独立归档（并发不互相覆盖）
    const joinEntry = { promise: null };
    drill._loginJoins.set(shopCfg.id, joinEntry);

    const completion = (async () => {
      const finalOut = done(out);
      try {
        // 4a) 派发前复核值守状态（并发开始/停止值守时不能凭陈旧开关派发动作）
        if (m.running !== true) {
          finalOut.running = false;
          finalOut.action = 'none';
          finalOut.processing = 'skipped';
          finalOut.reason = '派发前复核发现值守已停止：店铺保持已入列表、零动作（不派发处理）';
          pushLog('info', `[值守接管] 店铺「${shopName}」${finalOut.reason}`);
          joinState.status = 'done';
          joinState.running = false;
          joinState.action = 'none';
          joinState.finishedAt = new Date(drill._now()).toISOString();
          joinState.reason = finalOut.reason;
          syncFromMonitor();
          return finalOut;
        }
        // 4b) 只处理登录店（引擎侧还有 running/令牌/软删除/在途门禁与周期收口等待后的复核）
        let r = null;
        try {
          r = await m.joinShopNow(shopCfg.id, { trigger: 'new-shop-join' });
        } catch (e) {
          r = { ok: false, status: 'stopped', reason: `立即处理异常：${scrub(String((e && e.message) || e))}` };
        }
        finalOut.targetResult = {
          ok: r && r.ok === true,
          status: r && r.status ? String(r.status) : null,
          reason: r && r.reason ? scrub(String(r.reason)) : null,
          dryRun: r && r.dryRun === true,
        };
        // 补修 #3：完成判据 = 目标店实际 status==='ok'（含 dryRun 演练口径）；
        // blocked/window_blocked/stopped/skipped 一律不算接管完成，分别如实给原因。
        finalOut.processed = finalOut.targetResult.ok && finalOut.targetResult.status === 'ok';
        finalOut.cycleNo = null; // 单店路径无全局周期号（不重排全局调度）
        joinState.result = finalOut.targetResult;
        // 4c) 本店独立只读回读：仅在真实派发过处理时执行（status ∈ ok/blocked/window_blocked）。
        //     stopped/skipped = 未派发 → 没有“处理结果”可回读，不做读取（也绝不为未派发虚报回读）。
        const dispatched = finalOut.targetResult.status === 'ok'
          || finalOut.targetResult.status === 'blocked'
          || finalOut.targetResult.status === 'window_blocked';
        if (dispatched) {
          try {
            const rb = await m.refreshShopData(shopCfg.id);
            finalOut.readBack = {
              ok: rb && rb.ok === true,
              blocked: rb && rb.blocked ? scrub(String(rb.blocked)) : null,
              reason: rb && rb.reason ? scrub(String(rb.reason)) : null,
              adState: rb && rb.adState ? rb.adState : null,
              costCents: rb && rb.data && rb.data.costCents != null ? rb.data.costCents : null,
              orders: rb && rb.data && rb.data.orders != null ? rb.data.orders : null,
            };
          } catch (e) {
            finalOut.readBack = { ok: false, reason: scrub(String((e && e.message) || e)) };
          }
        } else {
          finalOut.readBack = { ok: false, skipped: true, reason: '未派发处理（值守已停止或被去重），无本店处理结果可回读' };
        }
        joinState.readBack = finalOut.readBack;
        // 4d) 如实陈述（补修 #3/#6）：接管完成 = 目标店处理 status ok 且 本店回读成功；
        //     任何异常在此收口为可读取失败状态，绝不遗留 processing。
        if (finalOut.processed && finalOut.readBack && finalOut.readBack.ok) {
          joinState.status = 'done';
          pushLog('info', `[值守接管] 店铺「${shopName}」接管完成：本店单店处理 status=ok${finalOut.targetResult.dryRun ? '（演练口径，未真实操作）' : ''}，本店只读回读成功（费用/订单/广告状态以值守状态与日志为准）；其他店铺调度与任务未受影响`);
        } else {
          joinState.status = 'failed';
          const why = [];
          if (!finalOut.processed) {
            why.push(`本店立即处理未成功（status=${finalOut.targetResult.status || '未知'}）${finalOut.targetResult.reason ? '：' + finalOut.targetResult.reason : ''}`);
          }
          if (dispatched && !(finalOut.readBack && finalOut.readBack.ok)) {
            why.push(`本店回读未成功${finalOut.readBack && finalOut.readBack.reason ? '：' + finalOut.readBack.reason : ''}`);
          }
          finalOut.reason = why.join('；') || '接管结果未确认（原因不明）';
          pushLog('warn', `[值守接管] 店铺「${shopName}」接管未完全成功：${finalOut.reason}（店铺已在值守列表，不影响其他店铺与既有任务；登录成功的事实不受影响）`);
        }
      } catch (e) {
        // 兜底收口：任何未预期异常都不能把状态留在 processing
        finalOut.processed = false;
        finalOut.reason = `接管流程异常：${scrub(String((e && e.message) || e))}`;
        joinState.status = 'failed';
        joinState.reason = finalOut.reason;
        pushLog('error', `[值守接管] 店铺「${shopName}」${finalOut.reason}`);
      }
      joinState.finishedAt = new Date(drill._now()).toISOString();
      joinState.reason = finalOut.reason;
      drill._loginJoins.delete(shopCfg.id);
      syncFromMonitor();
      return finalOut;
    })();
    joinEntry.promise = completion; // 在途登记（同店重复事件合并的依据）
    completion.catch(() => { /* 永不向外抛；结果以 state.loginJoins/lastLoginJoin 与日志为准 */ });

    syncFromMonitor();
    return Object.assign(out, { completion });
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
      st.lastError = scrub(String((e && e.message) || e));
      pushLog('error', `值守启动失败：${st.lastError}（不启动调度）`);
      return snapshot();
    }
    const r = monitor.start();
    if (r && r.ok === false) {
      st.lastError = scrub(String(r.reason));
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
        `值守启动 · 店铺 ${(drill.shops || []).map((s) => (s.platform === 'pinduoduo' ? '拼多多/' : '抖店/') + s.name).join('，') || drill.shopName} · 模式：${monitor.modeLabel}；`
        + `每日 ${g.firstCheckTime || '00:05'} 后首查（暂停才作为当天首次开启，已开启零点击记完成），${String(g.dailyStartHour).padStart(2, '0')}:00 后每 ${g.intervalMinutes} 分钟费比检查；`
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
          ? (drill._config.shops.filter((s) => s && s.deleted !== true).map((s) => s.displayName || s.name || s.id).join('、') || '—')
          : drill.shopName;
        drill.shops = (drill._config && Array.isArray(drill._config.shops))
          ? drill._config.shops.filter((s) => s && s.deleted !== true).map((s) => ({
              id: s.id, name: s.displayName || s.name || s.id, platform: s.platform || 'douyin',
              targetRoi: s.targetRoi != null ? s.targetRoi : 15,
            }))
          : drill.shops;
        // 未装配 Monitor（boot 前）：如实展示"调度器未运行"；配置开关与停用标记未知不臆断
        if (!st.enableTask) {
          const cf = (drill._config && drill._config.monitor && drill._config.monitor.chengfang) || {};
          st.enableTask = {
            running: false, configEnabled: cf.enableSchedulerEnabled === true,
            stoppedByUser: null, phase: null, nextRunAt: null, lastRunAt: null,
            lastMissedReason: null,
            firstCheckMinuteOfDay: gates.firstCheckMinuteOfDay, firstCheckTime: gates.firstCheckTime,
            dailyStartHour: gates.dailyStartHour,
          };
        }
      } catch (_) { /* 读配置失败：保留 null/未知，不臆断 */ }
    }
    // 终态统一递归脱敏：snapshot 整包（含 shopRows.today/lastRounds/lastError/嵌套对象）不得含原始凭据
    return scrubDeep({
      shopName: drill.shopName,
      shops: drill.shops || [],
      shopRows: st.shopRows || [],
      // 运行期店铺发现结果（第 13 阶段补验证）：如实透出落盘成功/待重试，集成层不假称成功
      shopDiscovery: st.shopDiscovery || null,
      lastLoginJoin: st.lastLoginJoin || null,
      loginJoins: st.loginJoins || {},
      lastRounds: st.lastRounds || {},
      // 手动验证每日开启（2026-09-29 第 10 阶段）：异步状态可回读（running/done/failed）
      manualVerify: (m && typeof m.getManualEnableVerifyStatus === 'function')
        ? m.getManualEnableVerifyStatus()
        : (st.manualVerify || null),
      realMode: m ? m.realMode === true : (gates ? gates.realMode === true : drill.realMode),
      // 首次启动前也如实告知：模式是否已知、配置声明的模式是什么
      realModeKnown: gates ? gates.modeKnown !== false : false,
      modeText: gates ? gates.modeText : '待核实（尚未读取配置）',
      running: st.running,
      status: st.status,
      // engine 真实执行标志（权威，非时间猜测）：界面据此区分「检查中」/「值守中」
      cycleRunning: st.cycleRunning === true,
      processingShops: processingShops(),
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
      // 后台自动发布排程状态（客户 2026-10-11）：开关/时刻/每店份数/下次执行/当日各店计数与失败。
      // W4（2026-10-25）：在旧内嵌排程状态（保持 disabled、原样透出）之上，叠加独立
      // plan-publisher 当日结果的只读投影；独立目录未就绪时兼容旧路径原样返回。
      planPublishing: mergeIndependentPlanPublishing(
        drill._planScheduler ? drill._planScheduler.state() : null,
        projectIndependentPlanResults({ businessDate: st.businessDate || shanghaiDate(drill._now()) }),
      ),
      polling: st.polling || (gates && gates.polling) || null,
      cookieWriteback: st.cookieWriteback || null,
      phase: st.phase,
      windowBlockReason: st.windowBlockReason,
      enablePhaseToday: st.enablePhaseToday,
      businessDate: st.businessDate || null,
      clock: st.clock || null,
      // 事件流游标（供界面/排障核对"日志是否真的连续"）
      evtSeq: m ? (m._evtSeq || 0) : 0,
      consumedEvtSeq: drill._lastEvtSeq,
      // 飞书通知（Hermes send）最近状态
      notify: {
        enabled: drill._notify.enabled,
        target: drill._notify.target,
        lastCycleNo: drill._notify.lastCycleNo,
        lastAt: drill._notify.lastAt,
        lastStatus: drill._notify.lastStatus,
        lastError: drill._notify.lastError,
      },
      // 广告开/关状态（今日执行记录推导）与当前生效阈值（页面主信息/控件回显）
      adState: st.adState || null,
      threshold: st.thresholdCents != null
        ? { cents: st.thresholdCents, yuan: st.thresholdCents / 100 }
        : null,
      // 只读运行时版本指纹（非敏感；require.resolve 路径 + 文件 sha256）
      runtimeFingerprint: drill._runtimeFingerprint || collectRuntimeFingerprint(),
    });
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
    const readBody = (r) => new Promise((resolve) => {
      let raw = '';
      r.on('data', (c) => { raw += c; if (raw.length > 10000) r.destroy(); });
      r.on('end', () => { try { resolve(raw ? JSON.parse(raw) : null); } catch (_) { resolve(null); } });
      r.on('error', () => resolve(null));
    });
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch (_) { return send(400, { error: 'URL 非法' }); }
    const p = url.pathname;
    try {
      if (p === '/api/watch-drill/start' && req.method === 'POST') return send(200, { ok: true, state: start() });
      if (p === '/api/watch-drill/stop' && req.method === 'POST') return send(200, { ok: true, state: stop() });
      // 独立每日开启任务控制（与"启动值守"完全分离；页面提供独立按钮）
      if (p === '/api/watch-drill/daily-enable/start' && req.method === 'POST') return send(200, { ok: true, state: startEnableScheduler() });
      if (p === '/api/watch-drill/daily-enable/stop' && req.method === 'POST') return send(200, { ok: true, state: stopEnableScheduler() });
      // 手动验证每日开启（2026-09-29 第 10 阶段）：body={shopId}；单店任意时刻触发同一开启预检链。
      // 异步执行（HTTP 不悬挂），进度经 GET /state 的 manualVerify 字段回读；不改变自动排程。
      if (p === '/api/watch-drill/daily-enable/verify' && req.method === 'POST') {
        const body = await readBody(req);
        const shopId = body && body.shopId;
        if (!shopId) return send(400, { ok: false, error: '缺少 shopId' });
        const m2 = ensureMonitor();
        const r = m2.runManualEnableVerify(String(shopId));
        pushLog(r.ok ? 'info' : 'warn', `手动验证每日开启${r.ok ? '已启动' : '被拒绝'}：${shopId}${r.error ? ' · ' + r.error : ''}`);
        return send(r.ok ? 200 : 409, { ...r, state: snapshot() });
      }
      // 阈值调整（2026-09-21）：body 为 { thresholdCents } 或 { yuan }；点「确定」后才生效并落盘
      if (p === '/api/watch-drill/threshold' && req.method === 'POST') {
        const body = await readBody(req);
        let cents = null;
        if (body && body.thresholdCents != null) cents = Number(body.thresholdCents);
        else if (body && body.yuan != null) cents = Math.round(Number(body.yuan) * 100);
        if (cents == null || !Number.isFinite(cents)) {
          return send(400, { ok: false, error: '缺少有效阈值（thresholdCents 或 yuan）' });
        }
        const m2 = ensureMonitor();
        const r = m2.setRuleThreshold(cents);
        // 2026-09-21 用户要求：阈值确认后**立即**做一次数据抓取+判定+操作，并按当前
        // 时间重排下次半小时检查（pollNowAndReschedule：完成+30 分钟，跨日规则不变）。
        // 仅在阈值确实变化时触发（unchanged/失败不空跑巡查）；触发结果如实记日志，
        // 巡查失败不影响阈值本身已生效。
        let poll = null;
        if (r.ok && !r.unchanged && m2.running) {
          try {
            poll = await m2.pollNowAndReschedule('threshold-change');
            pushLog('info', `阈值变更联动巡查：${poll.ok ? `已完成（周期 ${poll.cycleNo}），下次检查 ${poll.nextRunAt ? poll.nextRunAt.replace('T', ' ').slice(0, 19) : '—'}（以本次完成时间为基准重排）` : `未执行：${poll.reason}`}`);
          } catch (e) {
            poll = { ok: false, reason: String((e && e.message) || e) };
            pushLog('warn', `阈值变更联动巡查失败：${poll.reason}（定时巡查不受影响）`);
          }
        }
        syncFromMonitor();
        pushLog(r.ok ? 'info' : 'warn', `阈值调整${r.ok ? '成功' : '失败'}：${r.ok ? `${r.from}分 → ${r.thresholdCents}分（${r.persisted ? '已落盘，重启后保持' : '仅内存生效（未落盘）'}）` : r.reason}`);
        return send(200, r.ok
          ? { ok: true, result: r, poll: poll ? { ok: !!poll.ok, cycleNo: poll.cycleNo, nextRunAt: poll.nextRunAt, reason: poll.reason } : null, state: snapshot() }
          : { ok: false, error: r.reason, state: snapshot() });
      }
      // 逐店只读更新 / 修改 / 删除（2026-09-24 多店铺生产接入）
      // 推广广告控制仅抖店；删除后调度器与手动接口都会再次检查活动列表。
      if (p === '/api/watch-drill/shop/refresh' && req.method === 'POST') {
        const body = await readBody(req);
        const shopId = body && body.shopId;
        if (!shopId) return send(400, { ok: false, error: '缺少 shopId' });
        const m2 = ensureMonitor();
        const r = await m2.refreshShopData(String(shopId));
        syncFromMonitor();
        pushLog(r.ok ? 'info' : 'warn', `单店立即更新（只读）${r.ok ? '完成' : '失败'}：${shopId}${r.reason ? ' · ' + r.reason : ''}`);
        return send(r.ok ? 200 : 400, { ...r, state: snapshot() });
      }
      if (p === '/api/watch-drill/shop/update' && req.method === 'POST') {
        const body = await readBody(req);
        const shopId = body && body.shopId;
        if (!shopId) return send(400, { ok: false, error: '缺少 shopId' });
        // 每店每日计划数量（客户 2026-10-13）：在装配 monitor 与任何写入**之前**先严格校验
        // 整数 1..10。非法一律 400 且**零写入**（不触碰阈值/ROI/磁盘，绝不部分写入）。
        let planQuantity = undefined;
        if (Object.prototype.hasOwnProperty.call(body, 'plansPerShopPerDay')) {
          const q = validatePlansPerShopValue(body.plansPerShopPerDay);
          if (!q.ok) {
            pushLog('warn', `单店每日计划数量无效（未落盘）：${shopId} · ${q.reason || 'invalid'}`);
            return send(400, { ok: false, error: '每日计划数量无效：' + (q.reason || ''), reason: '每日计划数量无效：' + (q.reason || ''), state: snapshot() });
          }
          planQuantity = q.value;
        }
        const m2 = ensureMonitor();
        const hasOtherFields = ['displayName', 'name', 'thresholdCents', 'targetRoi']
          .some((k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined && body[k] !== null);
        // 显式合法 targetRoi（monitor.updateShop 校验通过并成功落盘）→ 同步独立发布器同店单字段。
        const hasExplicitRoi = hasOtherFields
          && Object.prototype.hasOwnProperty.call(body, 'targetRoi') && body.targetRoi !== undefined && body.targetRoi !== null;
        const prevGuardShop = hasExplicitRoi ? configShopByIdOrName(String(shopId)) : null;
        const prevRoi = (prevGuardShop && prevGuardShop.targetRoi !== undefined) ? prevGuardShop.targetRoi : undefined;
        let r = { ok: true, shopId };
        if (hasOtherFields) {
          r = m2.updateShop(String(shopId), {
            displayName: body.displayName,
            name: body.name,
            thresholdCents: body.thresholdCents,
            // 目标 ROI（客户 2026-10-11）：仅当请求显式携带 targetRoi 时透传；缺失→模块默认 15。
            // UI 已用严格 Number 解析，非法值由 monitor.updateShop 拒绝且零落盘。
            targetRoi: hasExplicitRoi ? body.targetRoi : undefined,
          });
        }
        // 独立 plan-publisher ROI 同步：只在显式 targetRoi 且 guard 保存成功后执行；未安装独立
        // 配置（文件不存在）→ 兼容原行为照常成功；已安装但同步失败/匹配歧义 → 绝不显示两份
        // 配置都保存成功，并对 guard ROI 做必要的精确回滚（仅当此前存在显式旧值）。
        if (hasExplicitRoi && r.ok) {
          const roiSync = syncIndependentShopTargetRoi(String(shopId), body.targetRoi);
          r = { ...r, roiSync: { applied: roiSync.applied === true, unchanged: roiSync.unchanged === true, reason: roiSync.reason || null } };
          if (!roiSync.applied && roiSync.notInstalled !== true) {
            let rolledBack = null;
            if (prevRoi !== undefined) {
              try { const rb = m2.updateShop(String(shopId), { targetRoi: prevRoi }); rolledBack = rb.ok === true; } catch (e) { rolledBack = false; }
            }
            r = {
              ...r, ok: false,
              reason: '独立发布器 ROI 同步失败：' + (roiSync.reason || 'unknown')
                + (rolledBack === true ? '（guard ROI 已精确回滚为原值 ' + prevRoi + '）'
                  : (prevRoi !== undefined ? '（guard ROI 回滚失败，guard 实际值以磁盘为准）' : '（guard 此前无显式 ROI，无法自动回滚）')),
              roiRolledBack: rolledBack,
            };
            pushLog('warn', `单店 ROI 独立发布器同步失败（不视为已保存）：${shopId} · ${roiSync.reason || 'unknown'}${rolledBack === true ? '；guard ROI 已回滚' : ''}`);
          } else if (roiSync.applied && !roiSync.unchanged) {
            pushLog('info', `单店 ROI 已同步独立发布器：${shopId} · targetRoi=${body.targetRoi}`);
          }
        }
        // 阈值/ROI 成功后再落每店数量；数量失败即整体失败。2026-10-26 patrol-plan-refill 返修：
        // guard 保存 + 独立发布器单字段 CAS 同步 + 失败回滚（显式旧值写回；前态字段缺失则
        // 恢复缺省回落 3；前值不可读/并发较新写入绝不覆盖）统一在 applyShopPlanQuantitySync。
        if (r.ok && planQuantity !== undefined) {
          const q = applyShopPlanQuantitySync(m2, String(shopId), planQuantity);
          r = { ...r, ok: q.ok, reason: q.reason, plansPerShopPerDay: q.ok ? planQuantity : undefined, quantityRolledBack: q.quantityRolledBack };
        }
        syncFromMonitor();
        pushLog(r.ok ? 'info' : 'warn', `单店修改${r.ok ? '已落盘' : '失败'}：${shopId}${r.reason ? ' · ' + r.reason : ''}${r.rolledBack ? '（内存已回滚）' : ''}`);
        return send(r.ok ? 200 : 400, { ...r, error: r.ok ? undefined : r.reason, state: snapshot() });
      }
      if (p === '/api/watch-drill/shop/delete' && req.method === 'POST') {
        const body = await readBody(req);
        const shopId = body && body.shopId;
        if (!shopId) return send(400, { ok: false, error: '缺少 shopId' });
        const m2 = ensureMonitor();
        const r = m2.deleteShop(String(shopId));
        syncFromMonitor();
        pushLog(r.ok ? 'warn' : 'error', `单店删除${r.ok ? '已落盘（历史与 Cookie 保留；不影响其他店在途任务）' : '失败'}：${shopId}${r.reason ? ' · ' + r.reason : ''}`);
        return send(r.ok ? 200 : 400, { ...r, error: r.ok ? undefined : r.reason, state: snapshot() });
      }
      // R41 scope(3)：显式「排程只读回读恢复」——body 必须携带精确 {shopId}（单店），
      // 同店在途 409 合并拒绝；publisher 证明（recovered/closed）才映射账本，其余零改动；
      // 每次调用耐久写审计（scrubbed）。绝不批量、绝不清状态、绝不改记录 ID。
      if (p === '/api/watch-drill/plan-publishing/recover' && req.method === 'POST') {
        const body = await readBody(req);
        const shopId = body && body.shopId;
        if (!shopId || typeof shopId !== 'string') return send(400, { ok: false, error: '恢复必须携带精确 shopId（单店）' });
        const shopRow = configShopByIdOrName(shopId);
        if (!shopRow || shopRow.deleted === true) return send(404, { ok: false, error: '店铺不存在或已删除：' + scrub(shopId) });
        if (drill._recoverInflight.has(String(shopId))) return send(409, { ok: false, error: '该店恢复正在执行中；不重复派发' });
        // R78：账户发现前置阻断（blocked + entries 严格空 + plans 为合法整数计数）走专门受信
        // 恢复分支（同锁内重读原记录、严格绑定原 error/原记录字节；既有 publisher 回读恢复对
        // 这种"尚未建第一条 entry"的形状本就无法映射）。其余形状仍走下方既有只读回读恢复。
        let preShape = null;
        let preNavShape = null;
        let prePolicyShape = null;
        let preBusinessDate = null;
        try {
          preBusinessDate = shanghaiDate(drill._now());
          const preLed = loadLedger(schedulerLedgerFile());
          const preDay = preLed && preLed.days && preLed.days[preBusinessDate];
          const preRec = (preDay && preDay.shops && preDay.shops[String(shopId)]) || null;
          preShape = discoveryBlockedShape(preRec);
          // S108：R78 形状不匹配时再判"当日第 1 份预导航失败、零成功"精确形状（错误文字只选
          // 候选）；释放证明仍由 publisher 独立零发布复证 + 账本逐字绑定给出，其余形状照旧。
          // S126：再判精确 legacy「初始点击前策略撤销」unknown 形状（同一受信释放核心）。
          if (!preShape) preNavShape = preNavigationLoginFailedShape(preRec);
          if (!preShape && !preNavShape) prePolicyShape = preInitialPolicyCancelledShape(preRec);
        } catch (_) { preShape = null; preNavShape = null; prePolicyShape = null; }
        if (preShape) {
          const r = await recoverDiscoveryBlockedShopDay(String(shopId), 'explicit-recover', opts.planDiscoveryRecoverDi);
          if (r && r.status === 'busy' && r.locked === true) {
            return send(423, { ok: false, error: '排程持久锁被占用（调度或恢复在途）；本次恢复未派发', locked: true, shopId: String(shopId) });
          }
          return send(200, {
            ok: r.changed === true, status: r.action || r.reason || null,
            recovery: scrubDeep({ ...r, rec: r.rec ? JSON.parse(JSON.stringify(r.rec)) : null }),
            ledgerChanged: r.changed === true,
            businessDate: preBusinessDate, shopId: String(shopId), state: snapshot(),
          });
        }
        if (preNavShape || prePolicyShape) {
          const r = await recoverPreNavigationLoginFailureShopDay(String(shopId), 'explicit-recover', opts.planDiscoveryRecoverDi);
          if (r && r.status === 'busy' && r.locked === true) {
            return send(423, { ok: false, error: '排程持久锁被占用（调度或恢复在途）；本次恢复未派发', locked: true, shopId: String(shopId) });
          }
          return send(200, {
            ok: r.changed === true, status: r.action || r.reason || null,
            recovery: scrubDeep({ ...r, rec: r.rec ? JSON.parse(JSON.stringify(r.rec)) : null }),
            ledgerChanged: r.changed === true,
            businessDate: preBusinessDate, shopId: String(shopId), state: snapshot(),
          });
        }
        // 与排程调度共用**同一把进程间持久锁**（ledgerFile+'.lock'）：锁覆盖从只读恢复
        // 证明到账本映射/审计全程。持不到锁=调度/其他恢复在途 → 明确 423，零页面读取、
        // 零账本与状态写入；绝不强抢活锁。锁内重新加载账本，跨店恢复不整本互相覆盖。
        const recoverLockFile = schedulerLedgerFile() + '.lock';
        const recoverLock = acquireProcessLock(recoverLockFile, drill._now, 30 * 60 * 1000);
        if (!recoverLock.held) return send(423, { ok: false, error: '排程持久锁被占用（调度或恢复在途）；本次恢复未派发', locked: true, shopId: String(shopId) });
        drill._recoverInflight.add(String(shopId));
        try {
          const sched = ensurePlanScheduler();
          if (!sched) return send(503, { ok: false, error: '自动发布排程未装配' });
          const businessDate = shanghaiDate(drill._now());
          const proof = await defaultPlanRecover(shopRow, businessDate, opts.planRecoverDi);
          const ledgerFile = schedulerLedgerFile();
          const ledger = loadLedger(ledgerFile);
          const cfgNow = sched.state().config;
          let mapped = applyRecoverProofToLedger(ledger, businessDate, shopId, proof, cfgNow);
          let appliedProof = proof;

          // S130：修复已加载后，旧版本可能已经把“准备阶段零消费失败”耗尽为
          // failed-permanent + preparation-stopped。普通 preparationClosed 回读对此是幂等的，
          // 但若继续保持 failed-permanent，新实现永远没有机会补发当天缺额。
          // 这里只在显式单店恢复、同一把 scheduler 持久锁内，追加现成的整日零发布证明；
          // 严格绑定当前记录/条目/reason hash/店铺/账户/日期并复核 publisher 源字节未漂移，
          // 然后复用唯一 applySchedulerReleaseToRecord 路径释放为 unsubmitted。任一门禁不满足
          // 都保持原终态，绝不清账本、伪造成功或直接点击发布。
          if (!mapped.changed && proof && proof.status === 'preparationClosed') {
            const rec = ledger && ledger.days && ledger.days[businessDate]
              && ledger.days[businessDate].shops && ledger.days[businessDate].shops[String(shopId)];
            const planNumber = Number(proof.planNumber);
            const entry = rec && rec.entries && rec.entries[String(planNumber)];
            const account = String(proof.accountId || '');
            const sameClosedPreparation = rec && rec.status === 'failed-permanent'
              && Number(rec.plans || 0) === 0
              && entry && entry.status === 'preparation-stopped'
              && String(entry.reason || '') === String(proof.reason || '')
              && String(entry.preparationRunId || '') === String(proof.runId || '')
              && Number(entry.planNumber) === planNumber
              && /^\d{6,24}$/.test(account);
            if (sameClosedPreparation) {
              const rp = publisherRequire('run-plans.cjs');
              const paths = discoveryStatePaths(shopRow.name, account);
              const nsLockFile = paths && (paths.lockFile || (paths.dir ? path.join(paths.dir, 'plan-publisher.lock') : null));
              if (rp && typeof rp.proveNoPublicationPreOpen === 'function'
                && typeof rp.currentPreOpenSourceHash === 'function'
                && typeof rp.sha256Hex === 'function'
                && paths && paths.stateFile && paths.attemptsFile
                && !publisherLockLooksActive(nsLockFile)) {
                const zero = rp.proveNoPublicationPreOpen(paths.stateFile, paths.attemptsFile, businessDate,
                  { shop: shopRow.name, accountId: account });
                const publicationProof = zero && zero.ok === true ? zero.proof : null;
                let sourceStillBound = false;
                try {
                  sourceStillBound = !!publicationProof
                    && rp.currentPreOpenSourceHash(paths.stateFile, paths.attemptsFile) === publicationProof.sourceHash;
                } catch (_) { sourceStillBound = false; }
                const releaseProof = {
                  method: 'scheduler-release-prepublication', status: 'scheduler-release-prepublication',
                  businessDate, shop: String(shopId), planNumber, accountId: account,
                  recStatus: String(rec.status), entryStatus: String(entry.status),
                  entryReasonHash: rp.sha256Hex(entry.reason), publicationProof,
                };
                if (sourceStillBound && strictSchedulerReleaseProof(releaseProof)) {
                  const released = applyRecoverProofToLedger(ledger, businessDate, shopId, releaseProof, cfgNow);
                  if (released.changed) { mapped = released; appliedProof = releaseProof; }
                }
              }
            }
          }
          if (mapped.changed) saveLedger(ledgerFile, ledger);
          const audited = appendRecoveryAudit({
            at: new Date(drill._now()).toISOString(), shopId: String(shopId), shopName: shopRow.name || null,
            businessDate, proof: scrubDeep(appliedProof), ledgerChanged: mapped.changed,
            recAfter: mapped.rec ? scrubDeep(JSON.parse(JSON.stringify(mapped.rec))) : null,
          });
          pushLog(proof.ok === true ? 'info' : 'warn',
            `计划发布只读回读恢复（店 ${shopId}，日 ${businessDate}）：${appliedProof.status}${proof.planNumber != null ? ' 第' + proof.planNumber + '份' : ''}${proof.planId ? ' planId=' + proof.planId : ''}；账本${mapped.changed ? '已按证明更新' : '未改动'}${audited.ok ? '' : '（审计写入失败：' + audited.reason + '）'}`);
          return send(200, {
            ok: proof.ok === true, status: proof.status, proof: scrubDeep(proof),
            ledgerChanged: mapped.changed, rec: mapped.rec ? scrubDeep(JSON.parse(JSON.stringify(mapped.rec))) : null,
            auditOk: audited.ok, businessDate, shopId: String(shopId), state: snapshot(),
          });
        } finally { drill._recoverInflight.delete(String(shopId)); releaseProcessLock(recoverLockFile, recoverLock.token); }
      }
      // 后台自动发布排程配置（客户 2026-10-11）：GET 只读状态；POST 严格校验后保存并重排。
      // 默认未配置（enabled/autoConfirm=false）不发布；保存不等于授权，必须显式 true。
      // 路径别名 /config 与 UI 冻结 schema 同步（既有页面仍用基础路径，两者行为一致）。
      const isPlanPublishingPath = p === '/api/watch-drill/plan-publishing' || p === '/api/watch-drill/plan-publishing/config';
      if (isPlanPublishingPath && req.method === 'GET') {
        return send(200, { ok: true, planPublishing: drill._planScheduler ? drill._planScheduler.state() : null });
      }
      if (isPlanPublishingPath && req.method === 'POST') {
        const body = await readBody(req);
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { ok: false, error: '请求体必须为JSON对象' });
        const sched = ensurePlanScheduler();
        if (!sched) return send(503, { ok: false, error: '自动发布排程未装配' });
        const previousConfig = sched.state().config;
        const r = sched.configure(body);
        pushLog(r.ok ? 'info' : 'warn',
          `自动发布配置${r.ok ? '已校验' : '被拒绝'}：启用=${r.config.enabled} 自动确认=${r.config.autoConfirm} 时刻=${r.config.time} 每店份数=${r.config.plansPerShopPerDay}`
          + (r.reasons.length ? ' · ' + r.reasons.join('；') : ''));
        if (!r.ok) return send(400, { ok: false, ...r, state: snapshot() });
        // 校验通过后**必须真正落盘**；持续失败 → 精确回滚保存前配置并如实 500，
        // 绝不出现"页面显示已保存、磁盘未写"的假成功。
        const persisted = persistPlanPublishingConfig(r.config);
        if (!persisted.ok) {
          sched.configure(previousConfig);
          drill._config = { ...(drill._config || {}), planPublishing: previousConfig };
          pushLog('error', `自动发布配置持久化失败，已回滚为保存前配置：${scrub(persisted.reason || 'unknown')}`);
          return send(500, { ok: false, error: '配置未能持久化，已回滚为保存前配置：' + scrub(persisted.reason || 'unknown'), config: sched.state().config, state: snapshot() });
        }
        drill._config = { ...(drill._config || {}), planPublishing: r.config };
        pushLog('info', `自动发布配置已持久化${persisted.memoryOnly ? '（测试注入配置，仅内存）' : ''}`);
        return send(r.ok ? 200 : 400, { ok: r.ok, ...r, state: snapshot() });
      }
      if (p === '/api/watch-drill/state' && req.method === 'GET') { syncFromMonitor(); return send(200, { ok: true, state: snapshot() }); }
      if (p === '/api/watch-drill/logs' && req.method === 'GET') {
        syncFromMonitor();
        const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
        const logs = userLogs().filter((l) => l.seq > since);
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
    /** WD-NEW-1：登录成功后按当前值守状态立即接管新店（快照事实同步返回；巡查后台执行）。 */
    joinShopAfterLogin,
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
    get logs() { return userLogs(); },
    confirmDialogs: CONFIRM_DIALOG_MEASURED,
    _internal: drill,
    translateSwitchResult,
    /** 多店铺行构建（测试/界面复用）。 */
    buildShopRows,
    /** 值守补发桥（2026-10-26）：完整巡查周期后触发独立发布器当日缺额检查（测试/排障直调）。 */
    triggerPatrolPlanRefill,
    /** 独立发布器单字段严格 CAS 同步（2026-10-26 泛化到每店数量；测试直调）。 */
    syncIndependentShopField,
    /** 每店数量 guard 保存 + 独立同步 + 失败回滚一体化（patrol-plan-refill 返修；测试直调）。 */
    applyShopPlanQuantitySync,
  };
}

module.exports = { createWatchDrill, STATUS_TEXT, scrub, scrubDeep, deriveAdState, computeRunningStatus, buildShopRows, shopRequiresLogin, classifyShopReadFailure, resolvePublisherDir, resolvePromoGuardDir, projectIndependentPlanResults, mergeIndependentPlanPublishing };
