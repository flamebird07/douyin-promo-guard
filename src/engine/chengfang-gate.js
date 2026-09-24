'use strict';

/**
 * 乘方真实执行门槛（集中校验，fail-closed）。
 *
 * 真实暂停必须同时满足：
 * - execution.realMode === true
 * - monitor.chengfang.pauseEnabled === true
 * - execution.dryRun !== true（非演练）
 * - 当前账户匹配（由执行器身份核验负责）
 * - 上海时间 08:00 后（isAfterDailyStart）
 * - 未收到停止信号
 * - 触发业务日期与当前上海日历日一致（未跨日）
 *
 * 真实开启（每日 07:00 自动开启相位）独立于暂停门槛，必须同时满足：
 * - execution.realMode === true
 * - monitor.chengfang.enableEnabled === true
 * - execution.dryRun !== true（非演练）
 * - 上海时间 enableHour 起、dailyStartHour 前（每日一次，由监控相位调度）
 * - 未收到停止信号；触发业务日期与当前上海日历日一致（未跨日）
 * - 开启不依赖费用/订单阈值（不读费用与订单）
 *
 * 显式传入 dryRun:false 不能越过上述配置门槛（执行器据此决定是否演练）。
 */

const { shanghaiDate, shanghaiWall, isAfterDailyStart } = require('../lib/time');

/** 配置门槛：真实暂停是否被允许（不涉及时段/停止/日期，那些在请求级 gate 里）。 */
function resolveChengfangRealAllowed(config) {
  const exec = (config && config.execution) || {};
  const cf = (config && config.monitor && config.monitor.chengfang) || {};
  if (exec.realMode !== true) {
    return { ok: false, reason: 'execution.realMode 未开启（演练模式不执行真实暂停）' };
  }
  if (cf.pauseEnabled !== true) {
    return { ok: false, reason: 'monitor.chengfang.pauseEnabled 未开启（乘方暂停动作处于演练门禁）' };
  }
  if (exec.dryRun === true) {
    return { ok: false, reason: 'execution.dryRun=true（演练模式，禁止真实暂停）' };
  }
  return { ok: true };
}

/** 配置门槛：真实开启是否被允许（不涉及时段/停止/日期，那些在请求级 gate 里）。 */
function resolveChengfangEnableAllowed(config) {
  const exec = (config && config.execution) || {};
  const cf = (config && config.monitor && config.monitor.chengfang) || {};
  if (exec.realMode !== true) {
    return { ok: false, reason: 'execution.realMode 未开启（演练模式不执行真实开启）' };
  }
  if (cf.enableEnabled !== true) {
    return { ok: false, reason: 'monitor.chengfang.enableEnabled 未开启（乘方开启动作处于关闭门禁）' };
  }
  if (exec.dryRun === true) {
    return { ok: false, reason: 'execution.dryRun=true（演练模式，禁止真实开启）' };
  }
  return { ok: true };
}

/**
 * 构造"每次真实请求发出前"的门槛检查器。
 *
 * 每次 check() 都重新计算当前配置许可（resolveChengfangRealAllowed(config)），
 * 而非复用构造时缓存的静态结果——这样即使流程运行中 monitor.chengfang.pauseEnabled、
 * execution.realMode 或 execution.dryRun 被改变（例如批次中关闭暂停许可），
 * 已构造的 gate 也会立即反映，杜绝"构造后改配置仍放行"。
 *
 * 注意（配置热更新边界）：本 gate 读取的是运行时传入的 config 对象引用。
 * 若调用方直接修改该对象的属性（如 config.monitor.chengfang.pauseEnabled=false），
 * 会被下次 check() 读取到；但磁盘 config.json 的修改不会被自动同步进内存对象，
 * 需重新 loadConfig() 替换引用后新 gate 才生效——进程不宣称支持未经实现的"热更新配置文件"。
 *
 * @param {object} p
 * @param {object} p.config
 * @param {()=>number} p.nowFn
 * @param {()=>boolean} [p.stopRequested]
 * @param {string} [p.businessDate] 触发批次业务日期（上海日历日），用于跨日检查
 * @param {'pause'|'enable'} [p.action] 动作类型：pause 走 08:00 后暂停窗口与 pauseEnabled；
 *                                      enable 走 enableHour 起窗口与 enableEnabled（默认 'pause'）
 * @returns {()=>{ok:boolean,reason?:string}}
 */
/**
 * @param {'pause'|'enable'} [p.action]
 * @param {'daily_schedule'|'threshold_recovery'} [p.enableSource]
 *   daily_schedule：[enableHour, dailyStartHour)；
 *   threshold_recovery：值守窗口 dailyStartHour 起（周期低阈值恢复）。
 *   缺省/未识别按 daily_schedule（旧定时开启语义）；显式非法值拒绝。
 */
function buildChengfangRequestGate({ config, nowFn, stopRequested, businessDate, action = 'pause', enableSource = 'daily_schedule' }) {
  const sch = (config && config.schedule) || { dailyStartHour: 8 };
  const cf = (config && config.monitor && config.monitor.chengfang) || {};
  const enableHour = cf.enableHour !== undefined && cf.enableHour !== null ? cf.enableHour : 7;
  const label = action === 'enable' ? '开启' : '暂停';
  const src = enableSource === undefined || enableSource === null ? 'daily_schedule' : enableSource;
  return function check() {
    if (stopRequested && stopRequested()) {
      return { ok: false, reason: `停止信号：不再发出新的${label}请求` };
    }
    if (action === 'enable') {
      if (src !== 'daily_schedule' && src !== 'threshold_recovery') {
        return { ok: false, reason: `未知开启来源 ${JSON.stringify(src)}：拒绝放行` };
      }
      const w = shanghaiWall(nowFn());
      if (src === 'daily_schedule') {
        if (w.hour < enableHour || w.hour >= sch.dailyStartHour) {
          const hh = String(enableHour).padStart(2, '0');
          const dh = String(sch.dailyStartHour).padStart(2, '0');
          return { ok: false, reason: `未到允许开启时段（每日 ${hh}:00–${dh}:00，Asia/Shanghai）：不再发出新的开启请求` };
        }
      } else if (!isAfterDailyStart(nowFn(), sch.dailyStartHour)) {
        // threshold_recovery：仅值守窗口（dailyStartHour 起）
        const hh = String(sch.dailyStartHour).padStart(2, '0');
        return { ok: false, reason: `未到值守窗口（每日 ${hh}:00 后，Asia/Shanghai）：周期恢复开启被拒绝` };
      }
    } else if (!isAfterDailyStart(nowFn(), sch.dailyStartHour)) {
      const hh = String(sch.dailyStartHour).padStart(2, '0');
      return { ok: false, reason: `未到允许执行时段（每日 ${hh}:00 后，Asia/Shanghai）：不再发出新的暂停请求` };
    }
    if (businessDate !== undefined && businessDate !== null && shanghaiDate(nowFn()) !== businessDate) {
      return { ok: false, reason: `跨日（触发业务日期 ${businessDate} → 当前 ${shanghaiDate(nowFn())}）：不再发出新的${label}请求` };
    }
    // 实时重算当前配置许可：不依赖批次最初计算的静态 realAllowed
    const realAllowed = action === 'enable' ? resolveChengfangEnableAllowed(config) : resolveChengfangRealAllowed(config);
    if (!realAllowed.ok) {
      return { ok: false, reason: realAllowed.reason };
    }
    return { ok: true };
  };
}

module.exports = { resolveChengfangRealAllowed, resolveChengfangEnableAllowed, buildChengfangRequestGate };
