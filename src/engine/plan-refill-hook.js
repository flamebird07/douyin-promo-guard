'use strict';

/**
 * 巡查后计划补发联动（2026-11-20 自 bill-manager 收编）。
 *
 * 归属澄清（用户 2026-11-20 确认）：「每天 N 条新建计划」执行器**属于本项目**，
 * 代码一直在本仓 plan-publisher/（workflow/controller/runner/账本锁/28 个文件）。
 * bill-manager 只是借页面做前端显示与数量同步桥；此前 Windows 生产由其 start-server
 * 向 Monitor 注入 onPollComplete 触发补发——触发方住在 bill-manager 进程是划分不清的
 * 唯一来源，现收编为本仓 serve 自带。
 *
 * 语义（与 Windows 生产一致，fail-closed）：
 * - 仅在**完整完成**的巡查周期后由 Monitor 调用（引擎侧已保证：拒绝/跳过/中止/只读不触发）；
 * - daily-plan-config.json 缺失或 enabled!==true → 不触发（独立发布开关，与值守 realMode 分离）；
 * - 触发 = detached spawn `node daily-plan-runner.cjs --run --scheduler-path <本仓镜像>`
 *   （独立进程 + 自带 durable ledger 锁 + scheduler 镜像；autoConfirm 策略 = 排程自动发布，
 *   客户 2026-10-11 合同，Windows 生产已验证的同一入口，派发前/点击前新鲜复核 policy）；
 * - 数量同步桥（收编自 Windows bill-manager 桥）：派发前把值守 config.json 的每店
 *   plansPerShopPerDay/targetRoi/cookieFile 原子同步进 daily-plan-config.shops；
 * - 同一时刻最多一个补发子进程在途（进程内存标记；runner 账本锁兜底跨进程）；
 * - spawn 失败/子进程崩溃绝不影响值守（吞错记日志）。
 */

const fs = require('fs');
const path = require('path');
const log = require('../lib/log');

function createPlanRefillHook(opts = {}) {
  const projectRoot = opts.projectRoot;
  if (typeof projectRoot !== 'string' || !projectRoot) throw new Error('createPlanRefillHook: projectRoot 必填');
  const runnerPath = opts.runnerPath || path.join(projectRoot, 'plan-publisher', 'daily-plan-runner.cjs');
  const configPath = opts.configPath || path.join(projectRoot, 'plan-publisher', 'daily-plan-config.json');
  const guardConfigPath = opts.guardConfigPath || path.join(projectRoot, 'config', 'config.json');
  const schedulerPath = opts.schedulerPath || path.join(projectRoot, 'integrations', 'bill-manager', 'promo-plan-scheduler.js');
  const spawnFn = opts.spawnFn || require('child_process').spawn;
  const nodeBin = opts.nodeBin || process.execPath;
  const existsFn = opts.existsFn || ((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
  const readJsonFn = opts.readJsonFn || ((p) => JSON.parse(fs.readFileSync(p, 'utf-8')));
  const writeJsonFn = opts.writeJsonFn || ((p, obj) => {
    const tmp = `${p}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
    fs.renameSync(tmp, p);
  });

  let inFlight = false; // 本进程内补发子进程在途标记（跨进程由 runner 账本锁兜底）

  /** 配置是否允许触发（缺失/非法/未启用一律 false，fail-closed）。 */
  function refillEnabled() {
    try {
      if (!existsFn(configPath)) return false;
      const cfg = readJsonFn(configPath);
      return !!(cfg && cfg.enabled === true);
    } catch (_) {
      return false;
    }
  }

  /**
   * 数量同步桥（Mac 版，收编自 Windows bill-manager 桥）：每次派发前把值守 config.json
   * 的每店清单与 plansPerShopPerDay/targetRoi 原子同步进 daily-plan-config.json 的 shops，
   * 保证「页面改小/改大条数、改 ROI、删店」即时约束派发（runner 派发前还会新鲜复核）。
   * 值守配置不可读 → 返回 false（本次不派发，fail-closed）。
   */
  function syncQuantitiesFromGuardConfig() {
    let guard;
    try {
      guard = readJsonFn(guardConfigPath);
    } catch (_) {
      return false;
    }
    const shops = Array.isArray(guard && guard.shops) ? guard.shops : [];
    let daily;
    try {
      daily = readJsonFn(configPath);
    } catch (_) {
      return false;
    }
    const prevById = new Map((Array.isArray(daily.shops) ? daily.shops : []).map((s) => [String(s.id != null ? s.id : s.name), s]));
    daily.shops = shops
      .filter((s) => s && s.deleted !== true && s.enabled !== false)
      .map((s) => {
        const prev = prevById.get(String(s.id)) || {};
        const out = {
          id: s.id,
          name: s.name || s.id,
          cookieFile: s.cookieFile || s.id,
          platform: s.platform || 'douyin',
          ...(s.accountId != null && String(s.accountId) !== '' ? { accountId: String(s.accountId) } : {}),
        };
        if (s.plansPerShopPerDay != null) out.plansPerShopPerDay = s.plansPerShopPerDay;
        else if (prev.plansPerShopPerDay != null) out.plansPerShopPerDay = prev.plansPerShopPerDay;
        if (s.targetRoi != null) out.targetRoi = s.targetRoi;
        else if (prev.targetRoi != null) out.targetRoi = prev.targetRoi;
        return out;
      });
    try {
      writeJsonFn(configPath, daily);
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Monitor onPollComplete 回调：完整巡查周期后触发一次补发 tick。 */
  return function onPollComplete() {
    if (!refillEnabled()) return; // 未配置/未启用：静默不触发（与 Windows 同语义）
    if (inFlight) return;         // 上一子进程仍在途：本轮跳过（runner 账本锁另有跨进程兜底）
    try {
      if (!syncQuantitiesFromGuardConfig()) {
        try { log.warn('计划补发：值守配置不可读或同步失败，本次不派发（fail-closed）'); } catch (_) {}
        return;
      }
      const args = [runnerPath, '--run'];
      if (existsFn(schedulerPath)) args.push('--scheduler-path', schedulerPath);
      const child = spawnFn(nodeBin, args, {
        cwd: path.dirname(runnerPath),
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, PROMO_PROJECT_ROOT: projectRoot },
      });
      if (!child || typeof child.on !== 'function') return;
      inFlight = true;
      child.on('exit', () => { inFlight = false; });
      child.on('error', () => { inFlight = false; });
      try { log.info('巡查完成：已触发计划补发 tick（独立进程，账本锁兜底；autoConfirm 策略下自动发布）'); } catch (_) {}
    } catch (e) {
      try { log.warn(`计划补发触发失败（不影响值守）: ${e.message}`); } catch (_) {}
    }
  };
}

module.exports = { createPlanRefillHook };
