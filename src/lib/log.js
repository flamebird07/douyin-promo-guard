'use strict';

/**
 * 日志模块。
 *
 * 安全约定：任何 Cookie、令牌、密码、签名等凭证不得出现在日志里。
 * sanitize() 会把对象中的敏感字段值替换为 "[已脱敏]"；对字符串也做兜底扫描。
 * 日志写入 logs/app.log；审计记录（触发/执行）由 engine 写入 data/audit.jsonl。
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');

const SENSITIVE_KEYS = /^(value|cookie|cookies|token|access[_-]?token|refresh[_-]?token|session|sessionid|password|secret|authorization|sign|signature|ticket)$/i;

function sanitizeValue(v, depth = 0) {
  if (depth > 6) return '[深度截断]';
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((x) => sanitizeValue(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = SENSITIVE_KEYS.test(k) ? '[已脱敏]' : sanitizeValue(val, depth + 1);
    }
    return out;
  }
  if (typeof v === 'string') {
    // 兜底：字符串里疑似出现成对的 "name":"value" cookie 片段时整体脱敏
    if (/\b(sessionid|sessionid_ss|ttwid|csrf)=/i.test(v)) return '[疑似凭证，已脱敏]';
    return v;
  }
  return v;
}

function sanitize(data) {
  return sanitizeValue(data);
}

function fmtArg(arg) {
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(sanitize(arg));
  } catch (_) {
    return String(arg);
  }
}

function ts() {
  return new Date().toISOString();
}

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function write(level, args) {
  const line = `${ts()} [${level}] ${args.map(fmtArg).join(' ')}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  try {
    ensureDir();
    fs.appendFileSync(path.join(LOG_DIR, 'app.log'), line + '\n');
  } catch (_) { /* 日志落盘失败不阻塞业务 */ }
}

module.exports = {
  sanitize,
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
};
