'use strict';

/**
 * 隔离测试：金额/订单解析 与 时间窗口计算（Asia/Shanghai）。
 * 运行：npm test（node --test）
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { parseMoneyCents, parseIntegerCount, centsToYuan } = require('../src/lib/money');
const {
  shanghaiDate, shanghaiMs, isAfterDailyStart, msUntilDailyStart, nextIntervalDelayMs,
} = require('../src/lib/time');

// ── 金额解析 ──────────────────────────────────────────────────────
test('金额：常规文本正确转整数分', () => {
  assert.deepStrictEqual(parseMoneyCents('150.00'), { ok: true, cents: 15000, source: '150.00' });
  assert.deepStrictEqual(parseMoneyCents('1,234.56'), { ok: true, cents: 123456, source: '1,234.56' });
  assert.deepStrictEqual(parseMoneyCents('¥88.8'), { ok: true, cents: 8880, source: '¥88.8' });
  assert.deepStrictEqual(parseMoneyCents('0'), { ok: true, cents: 0, source: '0' });
  assert.deepStrictEqual(parseMoneyCents(100.01), { ok: true, cents: 10001, source: 100.01 });
});

test('金额：解析失败必须返回失败而不是 0（异常金额）', () => {
  assert.strictEqual(parseMoneyCents('').ok, false, '空串');
  assert.strictEqual(parseMoneyCents('—').ok, false, '破折号占位');
  assert.strictEqual(parseMoneyCents('N/A').ok, false, 'N/A');
  assert.strictEqual(parseMoneyCents('abc').ok, false, '非数字');
  assert.strictEqual(parseMoneyCents('12.345').ok, false, '超过两位小数');
  assert.strictEqual(parseMoneyCents(null).ok, false, 'null 缺失');
  assert.strictEqual(parseMoneyCents(undefined).ok, false, 'undefined 缺失');
  assert.strictEqual(parseMoneyCents('1e5').ok, false, '科学计数法按格式非法处理');
});

test('订单数：整数解析，小数/占位符/缺失一律失败（不得当 0）', () => {
  assert.deepStrictEqual(parseIntegerCount('128'), { ok: true, count: 128, source: '128' });
  assert.deepStrictEqual(parseIntegerCount('1,280'), { ok: true, count: 1280, source: '1,280' });
  assert.deepStrictEqual(parseIntegerCount(0), { ok: true, count: 0, source: 0 }, '显式 0 是合法值');
  assert.strictEqual(parseIntegerCount('128.5').ok, false, '小数订单数非法');
  assert.strictEqual(parseIntegerCount('—').ok, false);
  assert.strictEqual(parseIntegerCount('').ok, false);
  assert.strictEqual(parseIntegerCount(null).ok, false);
  assert.strictEqual(parseIntegerCount(-3).ok, false, '负数非法');
});

test('展示：分转元', () => {
  assert.strictEqual(centsToYuan(123456), '1234.56');
});

// ── 时间窗口（Asia/Shanghai）─────────────────────────────────────
test('上海统计日期：UTC+8 换日正确', () => {
  // 2026-09-12T16:30:00Z = 上海 2026-09-13 00:30
  assert.strictEqual(shanghaiDate(Date.UTC(2026, 8, 12, 16, 30)), '2026-09-13');
  // 2026-09-12T15:59:00Z = 上海 2026-09-12 23:59
  assert.strictEqual(shanghaiDate(Date.UTC(2026, 8, 12, 15, 59)), '2026-09-12');
});

test('窗口判定：07:59 不允许，08:00 整允许', () => {
  const t0759 = shanghaiMs('2026-09-12', '07:59');
  const t0800 = shanghaiMs('2026-09-12', '08:00');
  assert.strictEqual(isAfterDailyStart(t0759, 8), false);
  assert.strictEqual(isAfterDailyStart(t0800, 8), true);
  assert.strictEqual(isAfterDailyStart(shanghaiMs('2026-09-12', '23:50'), 8), true);
  assert.strictEqual(isAfterDailyStart(shanghaiMs('2026-09-13', '00:20'), 8), false, '跨午夜后属于新一天，08:00 前不允许');
});

test('等待时长：07:00 距 08:00 为 1 小时；08:00 后为 0', () => {
  const t0700 = shanghaiMs('2026-09-12', '07:00');
  assert.strictEqual(msUntilDailyStart(t0700, 8), 60 * 60 * 1000);
  assert.strictEqual(msUntilDailyStart(shanghaiMs('2026-09-12', '08:00'), 8), 0);
});

test('间隔调度：23:50 + 30 分钟跨日 → 等待次日 08:00', () => {
  const lastRun = shanghaiMs('2026-09-12', '23:50');
  const now = shanghaiMs('2026-09-12', '23:51');
  const nd = nextIntervalDelayMs(now, lastRun, 30, 8);
  assert.strictEqual(nd.crossDay, true);
  assert.strictEqual(nd.nextRunAt, shanghaiMs('2026-09-13', '08:00'));
  assert.strictEqual(nd.delayMs, shanghaiMs('2026-09-13', '08:00') - now);
});

test('间隔调度：08:00 + 30 分钟 → 08:30 同日执行', () => {
  const lastRun = shanghaiMs('2026-09-12', '08:00');
  const now = shanghaiMs('2026-09-12', '08:01');
  const nd = nextIntervalDelayMs(now, lastRun, 30, 8);
  assert.strictEqual(nd.crossDay, false);
  assert.strictEqual(nd.nextRunAt, shanghaiMs('2026-09-12', '08:30'));
});
