'use strict';

/**
 * 只读运行时版本指纹（非敏感）。
 *
 * 证据语义：对 require.resolve 的**实际解析路径**上的字节做 sha256；
 * 不把「工作区文件存在」当作运行时已加载证据。
 * 不写 Cookie / 店铺 ID / 令牌 / 密钥。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 静态构建标记（代码内常量，随指纹一同打出，便于对照发布版本）。 */
const BUILD_MARKER = 'promo-guard-runtime-fp-v1';

function fingerprintOne(id, absPath) {
  try {
    const resolvedPath = require.resolve(absPath);
    const buf = fs.readFileSync(resolvedPath);
    return {
      id,
      resolvedPath,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      size: buf.length,
      ok: true,
    };
  } catch (err) {
    return {
      id,
      resolvedPath: null,
      sha256: null,
      size: null,
      ok: false,
      error: String((err && err.message) || err).slice(0, 160),
    };
  }
}

/**
 * @param {{id: string, path: string}[]} [extra] 额外目标（如 bill-manager/watch-drill.js）
 */
function computeRuntimeFingerprint(extra = []) {
  const guardRoot = path.resolve(__dirname, '..', '..');
  const targets = [
    { id: 'monitor', path: path.join(guardRoot, 'src', 'engine', 'monitor.js') },
    { id: 'ad-switch-orchestrator', path: path.join(guardRoot, 'src', 'engine', 'ad-switch-orchestrator.js') },
    { id: 'switch-serial', path: path.join(guardRoot, 'src', 'engine', 'switch-serial.js') },
    ...extra,
  ];
  const files = targets.map((t) => fingerprintOne(t.id, t.path));
  return {
    buildMarker: BUILD_MARKER,
    at: new Date().toISOString(),
    node: process.version,
    pid: process.pid,
    files,
  };
}

/** 单行摘要，供启动日志使用（无密钥、无店铺 ID）。 */
function formatFingerprintLine(fp) {
  const parts = (fp.files || []).map((f) => {
    if (!f.ok) return `${f.id}=ERR`;
    return `${f.id}=${String(f.sha256).slice(0, 16)}`;
  });
  return `运行时版本指纹 ${fp.buildMarker} pid=${fp.pid} ${parts.join(' ')}`;
}

module.exports = {
  BUILD_MARKER,
  computeRuntimeFingerprint,
  formatFingerprintLine,
};
