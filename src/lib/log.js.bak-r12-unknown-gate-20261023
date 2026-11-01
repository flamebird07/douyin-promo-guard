'use strict';

/**
 * 日志模块。
 *
 * 安全约定：任何 Cookie、令牌、密码、签名等凭证不得出现在日志里。
 * sanitize() 会把对象中的敏感字段值替换为 "[已脱敏]"；对字符串做值级兜底扫描
 * （key=value 形态只遮蔽值，保留业务说明文本；与 bill-manager watch-drill 的
 * scrub 同一族模式，2026-09-24 起 token/secret/password/api_key 等同样覆盖）。
 * 日志写入 logs/app.log；审计记录（触发/执行）由 engine 写入 data/audit.jsonl。
 */

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');

const SENSITIVE_KEYS = /^(value|cookie|cookies|token|access[_-]?token|refresh[_-]?token|session|sessionid|password|secret|authorization|sign|signature|ticket)$/i;

/**
 * 值级脱敏（2026-09-24）：字符串里出现 key=value/`key: value` 形态的疑似凭证时，
 * 只把"值"替换为 ***，保留 key 与其余业务文本（不吞掉「Cookie 过期」这类说明）。
 * 值要求 ≥6 个 ASCII 非分隔字符且不是中文开头：ASCII 限定保证遇到中文业务文案
 * 即停止，不把「token=XXX；请重新登录」整段吞掉。
 * 与 bill-manager watch-drill.js 的 scrub() 保持同一族模式，两边同步维护。
 */
const SENSITIVE_VALUE_RE = /((?:cookie|cookies|token|access_token|refresh_token|secret|password|passwd|pwd|app_secret|api_key|apikey|sessionid|session_id|sessionid_ss|ttwid|csrf|authorization)[=:\s"']+)(?!Bearer\b)(?![\u4e00-\u9fff])([^\s"',}{\u0080-\uffff]{6,})/gi;

// 非全局提示正则（避免 g 标志在 .test 上的 lastIndex 状态问题）：
// 仅会话 Cookie 名 + "="（与原版整段遮蔽语义一致；键后带空格的中文说明不触发）
const SENSITIVE_HINT_RE = /\b(sessionid|sessionid_ss|ttwid|csrf)=/i;

function scrubSensitiveText(v) {
  return String(v)
    .replace(SENSITIVE_VALUE_RE, '$1***')
    .replace(/(Bearer\s+)(?![\u4e00-\u9fff])[^\s]{20,}/gi, '$1***');
}

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
    // 兜底：值级脱敏（key=值 → key=***）；无法值级遮蔽的成对 cookie 形态整段脱敏
    const scrubbed = scrubSensitiveText(v);
    if (scrubbed !== v) return scrubbed;
    if (SENSITIVE_HINT_RE.test(v)) return '[疑似凭证，已脱敏]';
    return v;
  }
  return v;
}

function sanitize(data) {
  return sanitizeValue(data);
}

/**
 * 递归脱敏（2026-09-24）：对象/数组/Error/嵌套结构中的所有字符串均经值级脱敏，
 * 供 HTTP 展示边界（src/ui/server.js）整包使用；保留 *** 标记，原值不得出站。
 * 与 bill-manager watch-drill.js 的 scrubDeep() 语义一致，两边同步维护。
 */
function scrubDeep(value, seen) {
  if (value == null) return value;
  if (typeof value === 'string') return scrubSensitiveText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: scrubSensitiveText(value.name), message: scrubSensitiveText(value.message), stack: scrubSensitiveText(value.stack || '') };
  }
  const guard = seen || new WeakSet();
  if (typeof value === 'object') {
    if (guard.has(value)) return '[circular]';
    guard.add(value);
    try {
      // 路径式循环检测：处理完即移出 guard——共享引用（同一子对象被多处引用，
      // 如 snapshot 的 adState 与 shopRows[0].adState）各自得到一份脱敏副本，
      // 只有真正的环（祖先路径上再次遇到）才标 [circular]。
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
  return scrubSensitiveText(String(value));
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
  if (typeof arg === 'string') return scrubSensitiveText(arg);
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
  scrubSensitiveText,
  scrubDeep,
  compactUrls,
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
};
