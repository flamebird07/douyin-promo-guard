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

/**
 * 压缩文本中的超长 URL（2026-09-21）：千川管理页等地址携带大量 utm/埋点查询参数，
 * 原样进入日志后单条可达数千字符，严重干扰阅读。短 URL（≤100 字符）原样保留；
 * 长 URL 压缩为「scheme://host/path?…（参数已省略，原 URL 共 N 字符）」，
 * 保留可定位的路径信息。仅影响日志/展示文本，不改动任何业务请求。
 */
const LONG_URL_RE = /https?:\/\/[^\s"'<>\u0080-\uffff]+/g;

function compactUrls(text) {
  return String(text).replace(LONG_URL_RE, (raw) => {
    if (raw.length <= 100) return raw;
    // 尾部标点不属于 URL 本身，剥离后回接
    const trail = /[.,。；;）)]+$/.exec(raw);
    const u = trail ? raw.slice(0, raw.length - trail[0].length) : raw;
    const cut = /^(https?:\/\/[^/?#]+\/[^?#]*)/.exec(u);
    const base = cut ? cut[1] : u.slice(0, 48);
    return `${base}?…（参数已省略，原 URL 共 ${u.length} 字符）${trail ? trail[0] : ''}`;
  });
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
  compactUrls,
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
};
