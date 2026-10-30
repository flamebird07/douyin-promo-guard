'use strict';

/**
 * 金额与数值的可靠精度处理。
 *
 * 原则：
 * - 金额一律转成"分"（整数）后参与比较，绝不使用浮点数直接比较。
 * - 解析失败（空串、占位符、非法字符、超过两位小数、负数等）必须返回失败，
 *   调用方据此停机；绝不能把解析失败的值当作 0。
 */

const MONEY_FAIL = { ok: false };

/** 清理货币符号、千分位逗号、空白。返回 null 表示包含无法清理的字符。 */
function cleanMoneyText(text) {
  if (typeof text === 'number') return String(text);
  if (typeof text !== 'string') return null;
  let s = text.trim();
  // 常见货币/单位前缀后缀（仅剥离一次，剩余字符必须全是数字结构）
  s = s.replace(/^[¥￥$€£]\s*/, '').replace(/\s*元$/, '');
  s = s.replace(/,/g, '').replace(/\s+/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return s;
}

/**
 * 解析金额文本/数字为整数分。
 * @returns {{ok:true, cents:number, source:*}|{ok:false, reason:string}}
 */
function parseMoneyCents(input) {
  if (input === null || input === undefined) {
    return { ok: false, reason: '金额缺失' };
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, reason: `金额不是有效数字: ${String(input)}` };
    return fromDecimalString(String(input), input);
  }
  if (typeof input !== 'string') {
    return { ok: false, reason: `金额类型非法: ${typeof input}` };
  }
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: '金额为空字符串' };
  if (/^—+$|^-$|^--$/.test(trimmed) || /^(n\/?a|null|undefined|-)$/i.test(trimmed)) {
    return { ok: false, reason: `金额为占位符: ${trimmed}` };
  }
  const cleaned = cleanMoneyText(trimmed);
  if (cleaned === null) {
    return { ok: false, reason: `金额格式无法解析: ${JSON.stringify(input)}` };
  }
  return fromDecimalString(cleaned, input);
}

function fromDecimalString(s, source) {
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [intPart, decPart = ''] = body.split('.');
  if (decPart.length > 2) {
    // 超过两位小数不静默舍入，视为解析失败（金额展示场景不应出现）。
    return { ok: false, reason: `金额小数超过两位: ${JSON.stringify(source)}` };
  }
  const cents = Number(intPart) * 100 + Number((decPart + '00').slice(0, 2) || '0');
  if (!Number.isSafeInteger(cents)) {
    return { ok: false, reason: `金额超出安全整数范围: ${JSON.stringify(source)}` };
  }
  return { ok: true, cents: neg ? -cents : cents, source };
}

/**
 * 解析普通数值（比率、次数等非金额指标）。失败必须返回 {ok:false}。
 */
function parseNumber(input) {
  if (input === null || input === undefined || input === '') {
    return { ok: false, reason: '数值缺失' };
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) return { ok: false, reason: '数值不是有限数字' };
    return { ok: true, value: input, source: input };
  }
  if (typeof input !== 'string') return { ok: false, reason: `数值类型非法: ${typeof input}` };
  const cleaned = input.trim().replace(/%\s*$/, '').replace(/,/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { ok: false, reason: `数值格式无法解析: ${JSON.stringify(input)}` };
  }
  return { ok: true, value: Number(cleaned), source: input };
}

/**
 * 解析"订单数"一类的整数计数。小数、占位符、非法字符一律失败，
 * 绝不能把解析失败的订单数当 0（0 会误触发零订单处理分支）。
 * @returns {{ok:true, count:number, source:*}|{ok:false, reason:string}}
 */
function parseIntegerCount(input) {
  if (input === null || input === undefined || input === '') {
    return { ok: false, reason: '订单数缺失' };
  }
  if (typeof input === 'number') {
    if (!Number.isInteger(input) || !Number.isSafeInteger(input)) {
      return { ok: false, reason: `订单数不是安全整数: ${String(input)}` };
    }
    if (input < 0) {
      return { ok: false, reason: `订单数不能为负数: ${String(input)}` };
    }
    return { ok: true, count: input, source: input };
  }
  if (typeof input !== 'string') {
    return { ok: false, reason: `订单数类型非法: ${typeof input}` };
  }
  const trimmed = input.trim();
  if (trimmed === '') return { ok: false, reason: '订单数为空字符串' };
  if (/^—+$|^-$|^--$/.test(trimmed) || /^(n\/?a|null|undefined|-)$/i.test(trimmed)) {
    return { ok: false, reason: `订单数为占位符: ${trimmed}` };
  }
  const cleaned = trimmed.replace(/,/g, '').replace(/\s+/g, '');
  if (!/^\d+$/.test(cleaned)) {
    return { ok: false, reason: `订单数必须是纯整数: ${JSON.stringify(input)}` };
  }
  const count = Number(cleaned);
  if (!Number.isSafeInteger(count)) {
    return { ok: false, reason: `订单数超出安全整数范围: ${JSON.stringify(input)}` };
  }
  return { ok: true, count, source: input };
}

/** 分 -> 元（仅用于展示）。 */
function centsToYuan(cents) {
  return (cents / 100).toFixed(2);
}

module.exports = { parseMoneyCents, parseNumber, parseIntegerCount, centsToYuan };
