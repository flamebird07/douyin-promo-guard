'use strict';

/**
 * 只读运行时版本指纹（非敏感）。
 *
 * 证据语义：对 require.resolve 的**实际解析路径**上的字节做 sha256；
 * 不把「工作区文件存在」当作运行时已加载证据。
 * 覆盖面：guard 源码树（src/ 全部 .js，排除 .bak-* 回滚副本）+ 调用方额外目标。
 * 不写 Cookie / 店铺 ID / 令牌 / 密钥。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/** 静态构建标记（代码内常量，随指纹一同打出，便于对照发布版本）。
 * v2：覆盖面从「三个引擎文件」扩到整个 guard 源码树（含本轮 r12/r13 全部改动文件）。 */
const BUILD_MARKER = 'promo-guard-runtime-fp-v2';

const SRC_DIR = path.resolve(__dirname, '..');
const GUARD_ROOT = path.resolve(__dirname, '..', '..');

/** 核心目标：沿用既有短 id，便于与旧证据逐行对照（顺序稳定、永不重排）。 */
const CORE_TARGETS = [
  { id: 'monitor', rel: 'engine/monitor.js' },
  { id: 'ad-switch-orchestrator', rel: 'engine/ad-switch-orchestrator.js' },
  { id: 'switch-serial', rel: 'engine/switch-serial.js' },
  { id: 'close-coordinator', rel: 'engine/close-coordinator.js' },
  { id: 'log', rel: 'lib/log.js' },
  { id: 'resource-attestation', rel: 'lib/resource-attestation.js' },
  { id: 'runtime-fingerprint', rel: 'lib/runtime-fingerprint.js' },
];

function normalizeKey(p) {
  const abs = path.resolve(p);
  return process.platform === 'win32' ? abs.toLowerCase() : abs;
}

/**
 * 源码树全量清单：src/ 下所有 .js，排除 .bak-* 回滚副本，按相对路径稳定排序。
 * 目录遍历异常一律向上抛（调用方据此把指纹标记为不可用，绝不静默交付不完整指纹）。
 */
function listGuardSourceFiles(srcDir = SRC_DIR) {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) {
        if (name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!st.isFile() || !name.endsWith('.js') || name.includes('.bak-')) continue;
      out.push(path.relative(GUARD_ROOT, full).split(path.sep).join('/'));
    }
  };
  walk(srcDir);
  return out.sort();
}

/** 完整目标清单（核心短 id 在前，其余源码文件用相对路径作 id，去重不重复计数）。 */
function listFingerprintTargets(extra = [], srcDir = SRC_DIR) {
  const targets = [];
  const seen = new Set();
  const push = (id, absPath) => {
    const key = normalizeKey(absPath);
    if (seen.has(key)) return false;
    seen.add(key);
    targets.push({ id, path: absPath });
    return true;
  };
  for (const t of CORE_TARGETS) push(t.id, path.join(srcDir, t.rel));
  for (const rel of listGuardSourceFiles(srcDir)) push(rel, path.join(GUARD_ROOT, rel));
  for (const t of (extra || [])) {
    if (!t || !t.path) continue;
    push(t.id || `extra-${targets.length}`, t.path);
  }
  return targets;
}

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
function computeRuntimeFingerprint(extra = [], srcDir = SRC_DIR) {
  const files = listFingerprintTargets(extra, srcDir).map((t) => fingerprintOne(t.id, t.path));
  return {
    buildMarker: BUILD_MARKER,
    at: new Date().toISOString(),
    node: process.version,
    pid: process.pid,
    fileCount: files.length,
    allOk: files.length > 0 && files.every((f) => f.ok === true),
    files,
  };
}

/** 单行摘要，供启动日志使用（无密钥、无店铺 ID；只打 16 位哈希前缀）。 */
function formatFingerprintLine(fp) {
  const parts = (fp.files || []).map((f) => {
    if (!f.ok) return `${f.id}=ERR`;
    return `${f.id}=${String(f.sha256).slice(0, 16)}`;
  });
  return `运行时版本指纹 ${fp.buildMarker} pid=${fp.pid} files=${parts.length} ${parts.join(' ')}`;
}

module.exports = {
  BUILD_MARKER,
  CORE_TARGETS,
  GUARD_ROOT,
  computeRuntimeFingerprint,
  formatFingerprintLine,
  listGuardSourceFiles,
  listFingerprintTargets,
  fingerprintOne,
};
