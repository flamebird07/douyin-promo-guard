'use strict';

/**
 * 时间与调度工具 —— 统计日期与执行窗口均按 Asia/Shanghai（UTC+8，无夏令时）。
 *
 * 业务约定（用户规则）：
 * - 统计日期 = 上海日历日，"当天"从 00:00 累计；
 * - 每天只在 startHour（默认 8 点）之后执行真实操作；
 * - 巡查间隔默认 30 分钟；上次巡查加间隔若跨到新的上海日历日，则等待次日 startHour。
 *
 * 所有函数都是纯计算，now 可注入以便测试。
 */

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 把时间戳平移为上海墙上时钟后按 UTC 字段读取。 */
function shanghaiWall(ms) {
  const d = new Date(ms + SHANGHAI_OFFSET_MS);
  return {
    date: d.toISOString().slice(0, 10), // YYYY-MM-DD
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
  };
}

/** 当前（或给定时刻）的上海统计日期 YYYY-MM-DD。 */
function shanghaiDate(ms) {
  return shanghaiWall(ms).date;
}

/** 由上海墙上时间构造 UTC 时间戳：dateStr 'YYYY-MM-DD', hm 'HH:mm'。 */
function shanghaiMs(dateStr, hm) {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, 0) - SHANGHAI_OFFSET_MS;
}

/** 是否已过当日 startHour 点（>= startHour:00，即 08:00 整允许，07:59 不允许）。 */
function isAfterDailyStart(ms, startHour) {
  const w = shanghaiWall(ms);
  return w.hour >= startHour;
}

/**
 * 距离下一次允许执行的毫秒数。
 * - 尚未到当日 startHour：等到当日 startHour；
 * - 已过 startHour：返回 0（由调用方按 interval 排下一次）。
 */
function msUntilDailyStart(ms, startHour) {
  const w = shanghaiWall(ms);
  if (w.hour >= startHour) return 0;
  return shanghaiMs(w.date, `${String(startHour).padStart(2, '0')}:00`) - ms;
}

/**
 * 给定上次巡查时刻与间隔，计算下一次巡查应等待的毫秒数及目标说明。
 * - next = lastRun + intervalMinutes；
 * - next 与 now 不在同一天（跨日/跨午夜）→ 等到 next 所在日的 startHour；
 * - next 在今天且尚未到 → 等 next - now；
 * - next 已过（理论少见）→ 立即执行。
 */
function nextIntervalDelayMs(nowMs, lastRunMs, intervalMinutes, startHour) {
  const nextMs = lastRunMs + intervalMinutes * 60 * 1000;
  const nextWall = shanghaiWall(nextMs);
  const nowWall = shanghaiWall(nowMs);
  if (nextWall.date !== nowWall.date) {
    const target = shanghaiMs(nextWall.date, `${String(startHour).padStart(2, '0')}:00`);
    return { delayMs: Math.max(0, target - nowMs), nextRunAt: target, crossDay: true };
  }
  return { delayMs: Math.max(0, nextMs - nowMs), nextRunAt: nextMs, crossDay: false };
}

/** 供展示的上海时钟文本。 */
function shanghaiClockText(ms) {
  const w = shanghaiWall(ms);
  return `${w.date} ${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')} (Asia/Shanghai)`;
}

module.exports = {
  SHANGHAI_OFFSET_MS,
  shanghaiWall,
  shanghaiDate,
  shanghaiMs,
  isAfterDailyStart,
  msUntilDailyStart,
  nextIntervalDelayMs,
  shanghaiClockText,
};
