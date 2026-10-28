'use strict';

/**
 * 配置加载与校验（v2 —— 已落实用户明确的具体规则）。
 *
 * 用户已确认的业务规则（直接写入默认配置）：
 * - 首版只监控一个店铺（结构保留多店扩展）；
 * - 当天累计推广费用 ÷ 当天累计全店订单数 > 1 元/单（=100 分/单，恰好相等不关），
 *   判定式：费用整数分 > 订单数 × 100，不得先四舍五入每单成本；
 * - 统计日期按 Asia/Shanghai，当天从 00:00 累计；
 * - 每天只在 08:00 后执行真实暂停操作，每 30 分钟巡查一次；
 * - 每天 00:05 后检查当天是否暂停、暂停才作为当天首次开启（firstCheckMinuteOfDay，默认关闭，须 realMode+enableEnabled 同时开启）。
 *
 * 仍待用户提供（保持 TODO 占位，缺任一项监控不可启动）：
 * - 推广页面网址、目标店铺（店铺唯一标识 + Cookie 文件名）、可选广告账户 ID。
 *
 * 校验失败（数值范围、格式、非法枚举）一律进入 pending，禁止启动。
 */

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const CONFIG_PATH = path.join(PROJECT_ROOT, 'config', 'config.json');
const EXAMPLE_PATH = path.join(PROJECT_ROOT, 'config', 'config.example.json');

const DEFAULTS = {
  execution: {
    dryRun: true,
    realMode: false,
    maxRetries: 2,
    retryBackoffMs: 3000,
    closeTimeoutMs: 20000,
    // 落地确认/回读的**唯一有效配置**（2026-09-16 统一）：
    // - readbackTimeoutMs = 总预算，按实际截止时间计算（不是 次数×间隔）；
    // - readbackIntervalMs = 两次回读之间的等待；读取串行，绝不与上一轮重叠；
    // - 执行器不再持有独立 fallback 数值（同源：src/lib/bounded-poll.js 的 POLLING_DEFAULTS
    //   与本处保持一致），避免"报告说 30 秒/3 秒、生产实际 15 秒/2 秒"的漂移。
    // - 平台异步落地实测可延迟 27 秒以上（2026-09-21 实录 >75 秒）→ 取 120 秒，
    //   避免把成功误判为未生效而触发冗余重试点击。
    readbackTimeoutMs: 120000,
    // readbackAttempts 为**次数语义**，仅关闭推广流程（close-flow.js）使用；
    // 乘方落地确认不使用本项（按截止时间有界，见 src/lib/bounded-poll.js）。
    readbackAttempts: 3,
    readbackIntervalMs: 3000,
    zeroOrderRecheck: 1,      // 订单为 0/无效时的重新读取次数
    maxAdPages: 50,           // 广告清单分页上限（防失控）
  },
  schedule: {
    dailyStartHour: 8,        // 用户规则：08:00 后执行
    intervalMinutes: 30,      // 用户规则：每半小时巡查
    timezone: 'Asia/Shanghai',
  },
  monitor: {
    snapshotMaxAgeMinutes: 30,
    mockDataSource: false,
    orderDataSource: 'not-connected', // 'not-connected' | 'compass'（电商罗盘经营概况，只读）
    costDataSource: 'not-connected',  // 'not-connected' | 'qianchuan'（千川"账户整体消耗"，只读）
    adListDataSource: 'not-connected', // 'not-connected' | 'qianchuan'（千川投放类型清单，只读）
    chengfang: {
      scope: ['全店托管', '商品自选'], // 本轮控制范围：乘方两视图
      pauseEnabled: false,            // 乘方暂停动作真实执行开关（默认关闭；realMode 为总闸）
      enableEnabled: false,           // 乘方开启动作真实执行开关（默认关闭；realMode 为总闸）
      // 2026-10-09 取消 07:00 固定开启，改每天 00:05 后检查当天是否暂停、暂停才作为当天
      // 首次开启。enableHour 字段保留兼容旧配置文件（仍校验），但调度与门槛均不再读取它。
      firstCheckMinuteOfDay: 5,       // 每日首次开启检查的当天最早时刻（分钟，0-1439；缺省 5=00:05，Asia/Shanghai）
      enableHour: 7,                  // [废弃] 不再参与调度（保留以兼容旧配置文件）
      // 独立每日开启调度器：true = 服务启动即登记每日 00:05 后的首查任务，不依赖"启动值守"
      // （超额暂停巡查独立启停）。执行仍受 enableEnabled+realMode+dryRun 门禁约束；页面提供
      // 独立停用控制（按用户+日期持久化）。
      enableSchedulerEnabled: false,
    },
    qianchuan: {
      adTypes: ['uni_promotion', 'standard'], // 仅只读清单透明性；本轮动作范围 = chengfang.scope
    },
  },
  login: {
    cookieSourceDir: 'C:/Users/Administrator/Documents/电商助手/bill-manager/cookies',
    edgePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    douyinHomeUrl: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
  },
};

function isPlaceholder(v) {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') {
    const s = v.trim();
    return s === '' || s.startsWith('TODO');
  }
  return false;
}

function deepMerge(base, patch) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// 目标 ROI 默认值（缺字段时采用）：客户 2026-10-11 明确"缺字段默认 15"。
const DEFAULT_TARGET_ROI = 15;

// 每店每天计划数量的合法范围与全局默认（客户 2026-10-13 明确"每天几条加在目标 ROI 后面，可按店调整"）：
// - 全局排程默认仍为 3（不配置就不自作主张多发）；
// - 每店可用 shops[].plansPerShopPerDay 覆盖，合法整数 1..10；缺字段/非法一律回落全局默认 3。
const DEFAULT_PLANS_PER_SHOP = 3;
const MIN_PLANS_PER_SHOP = 1;
const MAX_PLANS_PER_SHOP = 10;

/**
 * 每店每天计划数量严格整数校验（供配置校验与页面保存共用）。
 * 只接受**整数**且落在 [MIN,MAX]；拒绝空串 / null / 布尔 / NaN / Infinity / 小数 / 0 / 11 等。
 * 返回 { ok, value, reason }。UI 侧必须先做严格 Number 解析再调用本函数。
 */
function validatePlansPerShop(raw) {
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    return { ok: false, value: null, reason: `必须是整数（当前 ${JSON.stringify(raw)}）` };
  }
  if (raw < MIN_PLANS_PER_SHOP || raw > MAX_PLANS_PER_SHOP) {
    return { ok: false, value: null, reason: `必须在 ${MIN_PLANS_PER_SHOP}~${MAX_PLANS_PER_SHOP} 之间（当前 ${raw}）` };
  }
  return { ok: true, value: raw, reason: null };
}

/**
 * 解析某店本日**有效**每日计划数量：优先该店已保存且合法的 plansPerShopPerDay，
 * 否则回落全局默认（缺省 3）。两店相互独立，互不影响。
 */
function resolveEffectivePlansPerShop(shop, globalFallback) {
  const fb = Number.isInteger(globalFallback) ? globalFallback : DEFAULT_PLANS_PER_SHOP;
  if (shop && Object.prototype.hasOwnProperty.call(shop, 'plansPerShopPerDay')) {
    const c = validatePlansPerShop(shop.plansPerShopPerDay);
    if (c.ok) return c.value;
  }
  return fb;
}

/**
 * 目标 ROI 严格校验（客户 2026-10-11 合同）：
 * - 字段缺失（undefined）→ 采用默认 15（defaulted:true）；
 * - 明确值只接受**正有限 number**（支持 13.5 这类小数）；
 * - 拒绝：空串 / null / 布尔 / NaN / Infinity / 0 / 负数 / 形如 '15abc' 的字符串。
 * 返回 { ok, value, reason, defaulted }。UI 侧必须先做严格 Number 解析再调用本函数。
 */
function validateTargetRoi(raw) {
  if (raw === undefined) return { ok: true, value: DEFAULT_TARGET_ROI, reason: null, defaulted: true };
  if (typeof raw !== 'number') return { ok: false, value: null, reason: `必须是数字（当前 ${JSON.stringify(raw)}）`, defaulted: false };
  if (!Number.isFinite(raw)) return { ok: false, value: null, reason: `必须是有限数字（当前 ${String(raw)}）`, defaulted: false };
  if (!(raw > 0)) return { ok: false, value: null, reason: `必须为正数（当前 ${raw}）`, defaulted: false };
  return { ok: true, value: raw, reason: null, defaulted: false };
}

/** 严格整数校验：必须是整数且在 [min,max]。返回错误原因或 null。 */
function intInRange(v, min, max, label) {
  if (typeof v !== 'number' || !Number.isInteger(v)) return `${label} 必须是整数（当前 ${JSON.stringify(v)}）`;
  if (v < min || v > max) return `${label} 必须在 ${min}~${max} 之间（当前 ${v}）`;
  return null;
}

/** 逐条收集待配置/非法项。返回空数组即配置齐备。 */
function collectPending(cfg) {
  const pending = [];
  const push = (p) => pending.push(p);

  // ── 店铺（首版一个；结构允许多个）────────────────────────────────
  if (!Array.isArray(cfg.shops) || cfg.shops.length === 0) {
    push('shops: 未配置监控店铺清单');
  } else {
    cfg.shops.forEach((s, i) => {
      if (isPlaceholder(s.id)) push(`shops[${i}].id: 店铺唯一标识待配置（首版用店铺名，页面身份按名称精确映射核验）`);
      if (isPlaceholder(s.cookieFile)) push(`shops[${i}].cookieFile: Cookie 文件名待配置`);
      if (s.accountId !== undefined && s.accountId !== null && isPlaceholder(String(s.accountId))) {
        push(`shops[${i}].accountId: 广告账户 ID 待配置或删除该字段`);
      }
      if (s.accountId !== undefined && s.accountId !== null && !isPlaceholder(String(s.accountId)) && !/^\d{8,20}$/.test(String(s.accountId).trim())) {
        push(`shops[${i}].accountId: 必须是 8~20 位数字的千川账户ID（页面实测值）`);
      }
      // 可选 targetRoi：仅在字段存在时严格校验（缺失采用默认 15，不报错）。
      if (Object.prototype.hasOwnProperty.call(s, 'targetRoi')) {
        const roiCheck = validateTargetRoi(s.targetRoi);
        if (!roiCheck.ok) push(`shops[${i}].targetRoi: ${roiCheck.reason}`);
      }
      // 可选 plansPerShopPerDay：仅在字段存在时严格校验整数 1..10（缺字段回落全局默认 3，不报错）。
      if (Object.prototype.hasOwnProperty.call(s, 'plansPerShopPerDay')) {
        const ppCheck = validatePlansPerShop(s.plansPerShopPerDay);
        if (!ppCheck.ok) push(`shops[${i}].plansPerShopPerDay: ${ppCheck.reason}`);
      }
    });
  }

  // ── 推广页面 ─────────────────────────────────────────────────────
  // 用户已确认入口：费用=抖店首页"巨量千川"；订单=首页"成交订单数"→罗盘经营概况。
  // 无需（也不应）配置深层网址；promoPage.url 已废弃，不再作为待配置项。

  // ── 规则（用户规则已落实：全店费用÷全店订单 > 阈值分/单）─────────
  if (!Array.isArray(cfg.rules) || cfg.rules.length === 0) {
    push('rules: 未配置超额规则');
  } else {
    cfg.rules.forEach((r, i) => {
      if (isPlaceholder(r.name)) push(`rules[${i}].name: 规则名待配置`);
      if (r.type !== 'wholeShopCostPerOrder') {
        push(`rules[${i}].type: 首版仅支持 wholeShopCostPerOrder（全店费用÷全店订单）`);
      }
      if (r.comparator !== '>') {
        push(`rules[${i}].comparator: 用户规则为严格大于（恰好 1 元/单不关闭），当前 ${JSON.stringify(r.comparator)}`);
      }
      const thrErr = intInRange(r.thresholdCents, 1, 100000000, `rules[${i}].thresholdCents`);
      if (thrErr) push(`${thrErr}（用户规则为 100 分 = 1 元/单）`);
      if (isPlaceholder(r.period) || (r.period !== 'today' && r.period !== undefined)) {
        push(`rules[${i}].period: 首版仅支持 today（当天 00:00 起累计）`);
      }
      if (r.timezone && r.timezone !== 'Asia/Shanghai') {
        push(`rules[${i}].timezone: 首版仅支持 Asia/Shanghai`);
      }
    });
  }

  // ── 调度 ─────────────────────────────────────────────────────────
  const hourErr = intInRange(cfg.schedule.dailyStartHour, 0, 23, 'schedule.dailyStartHour');
  if (hourErr) push(hourErr);
  const intervalErr = intInRange(cfg.schedule.intervalMinutes, 1, 1440, 'schedule.intervalMinutes');
  if (intervalErr) push(intervalErr);
  if (cfg.schedule.timezone !== 'Asia/Shanghai') push('schedule.timezone: 首版仅支持 Asia/Shanghai');

  // ── 执行参数数值范围 ─────────────────────────────────────────────
  const e = cfg.execution;
  const execChecks = [
    intInRange(e.maxRetries, 0, 10, 'execution.maxRetries'),
    intInRange(e.retryBackoffMs, 0, 600000, 'execution.retryBackoffMs'),
    intInRange(e.closeTimeoutMs, 1000, 600000, 'execution.closeTimeoutMs'),
    intInRange(e.readbackTimeoutMs, 1000, 600000, 'execution.readbackTimeoutMs'),
    intInRange(e.readbackAttempts, 1, 10, 'execution.readbackAttempts'),
    intInRange(e.readbackIntervalMs, 0, 600000, 'execution.readbackIntervalMs'),
    intInRange(e.zeroOrderRecheck, 0, 5, 'execution.zeroOrderRecheck'),
    intInRange(e.maxAdPages, 1, 500, 'execution.maxAdPages'),
  ];
  execChecks.filter(Boolean).forEach(push);

  // ── 监控 ─────────────────────────────────────────────────────────
  const ageErr = intInRange(cfg.monitor.snapshotMaxAgeMinutes, 1, 1440, 'monitor.snapshotMaxAgeMinutes');
  if (ageErr) push(ageErr);
  if (!['not-connected', 'compass'].includes(cfg.monitor.orderDataSource)) {
    push('monitor.orderDataSource: 必须是 not-connected 或 compass（电商罗盘经营概况，只读）');
  }
  if (!['not-connected', 'qianchuan'].includes(cfg.monitor.costDataSource)) {
    push('monitor.costDataSource: 必须是 not-connected 或 qianchuan（千川账户整体消耗，只读）');
  }
  if (!['not-connected', 'qianchuan'].includes(cfg.monitor.adListDataSource)) {
    push('monitor.adListDataSource: 必须是 not-connected 或 qianchuan（千川全域投放清单，只读）');
  }
  // ── 乘方控制范围（本轮用户明确：全店托管 + 商品自选）──────────────
  const cf = cfg.monitor.chengfang || {};
  if (cf.pauseEnabled !== undefined && typeof cf.pauseEnabled !== 'boolean') {
    push('monitor.chengfang.pauseEnabled: 必须是布尔值（乘方暂停动作真实执行开关，默认 false）');
  }
  if (cf.enableEnabled !== undefined && typeof cf.enableEnabled !== 'boolean') {
    push('monitor.chengfang.enableEnabled: 必须是布尔值（乘方开启动作真实执行开关，默认 false）');
  }
  if (cf.enableSchedulerEnabled !== undefined && typeof cf.enableSchedulerEnabled !== 'boolean') {
    push('monitor.chengfang.enableSchedulerEnabled: 必须是布尔值（独立每日开启调度器，默认 false）');
  }
  if (cf.enableHour !== undefined) {
    // [废弃] enableHour 不再参与调度；保留校验以兼容旧配置文件，不报错不阻塞。
    const enableHourErr = intInRange(cf.enableHour, 0, 23, 'monitor.chengfang.enableHour');
    if (enableHourErr) push(enableHourErr);
  }
  if (cf.firstCheckMinuteOfDay !== undefined) {
    const fcmErr = intInRange(cf.firstCheckMinuteOfDay, 0, 1439, 'monitor.chengfang.firstCheckMinuteOfDay');
    if (fcmErr) push(fcmErr);
  }
  if (!Array.isArray(cf.scope) || cf.scope.length === 0) {
    push('monitor.chengfang.scope: 必须声明本轮控制视图（默认 ["全店托管","商品自选"]）');
  } else {
    const known = ['全店托管', '商品自选'];
    const unknown = cf.scope.filter((s) => !known.includes(s));
    if (unknown.length > 0) push(`monitor.chengfang.scope: 含未知视图 ${unknown.join(',')}（仅支持 ${known.join('/')}）`);
  }
  if (cfg.monitor.mockDataSource === true && cfg.execution.realMode === true) {
    push('真实模式下禁止使用 mockDataSource，请先接入真实页面');
  }
  return pending;
}

function loadRaw() {
  if (fs.existsSync(CONFIG_PATH)) {
    return { cfg: JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')), source: CONFIG_PATH };
  }
  if (fs.existsSync(EXAMPLE_PATH)) {
    return { cfg: JSON.parse(fs.readFileSync(EXAMPLE_PATH, 'utf-8')), source: EXAMPLE_PATH };
  }
  throw new Error('未找到 config/config.json 或 config/config.example.json');
}

/**
 * 按指定路径加载配置（merge 默认值 + 收集待配置项），与 loadConfig 同一逻辑。
 * 供测试锁定特定文件（如示例文件），不受 config/config.json 是否存在影响。
 */
function loadConfigFrom(cfgPath) {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  const merged = deepMerge(DEFAULTS, cfg);
  if (merged.execution.realMode !== true) {
    merged.execution.dryRun = true;
    merged.execution.realMode = false;
  } else {
    merged.execution.dryRun = false;
  }
  const pending = collectPending(merged);
  return { config: merged, pending, sourcePath: cfgPath, ready: pending.length === 0 };
}

/**
 * @returns {{config: object, pending: string[], sourcePath: string, ready: boolean}}
 */
function loadConfig() {
  const { cfg, source } = loadRaw();
  return loadConfigFrom(source);
}

module.exports = { loadConfig, loadConfigFrom, isPlaceholder, intInRange, collectPending, validateTargetRoi, validatePlansPerShop, resolveEffectivePlansPerShop, DEFAULT_TARGET_ROI, DEFAULT_PLANS_PER_SHOP, MIN_PLANS_PER_SHOP, MAX_PLANS_PER_SHOP, DEFAULTS, PROJECT_ROOT, CONFIG_PATH };
