'use strict';

const fs = require('node:fs');
const log = require('../lib/log');

const AUDIT_TAIL_BYTES = 2 * 1024 * 1024;

function rememberShopRead(history, event) {
  const { shopId, at, ok, reason, requiresLogin } = event;
  if (typeof shopId !== 'string' || !shopId || !Number.isFinite(Date.parse(at))) return;
  const stamp = new Date(at).toISOString();
  const prior = history.get(shopId) || {};
  const latestAt = prior.lastOutcome === 'success' ? prior.lastSuccessAt : prior.lastFailure?.at;
  const next = { ...prior };
  if (!latestAt || stamp >= latestAt) next.lastOutcome = ok ? 'success' : 'failure';
  if (ok && (!prior.lastSuccessAt || stamp >= prior.lastSuccessAt)) {
    next.lastSuccessAt = stamp;
  } else if (!ok && (!prior.lastFailure || stamp >= prior.lastFailure.at)) {
    const message = log.sanitize(String(reason || '读取失败')).split(/\r?\n/, 1)[0];
    next.lastFailure = { at: stamp, reason: message.slice(0, 240), requiresLogin: requiresLogin === true };
  }
  history.set(shopId, next);
}

function loadShopReadHistory(file) {
  const history = new Map();
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const offset = Math.max(0, size - AUDIT_TAIL_BYTES);
    const buffer = Buffer.alloc(size - offset);
    const length = fs.readSync(fd, buffer, 0, buffer.length, offset);
    const lines = buffer.toString('utf8', 0, length).split('\n');
    if (offset > 0) lines.shift();
    const structuredShops = new Set();
    for (const line of lines) {
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch (_) { continue; }
      if (!entry || typeof entry !== 'object') continue;
      const { kind, status, shopId, ts, reason } = entry;
      if (kind === 'shop-read') {
        rememberShopRead(history, entry);
        structuredShops.add(shopId);
      } else if (structuredShops.has(shopId)) {
        continue;
      } else if ((kind === 'poll' && status === 'ok') || (kind === 'shop-refresh' && entry.ok !== false)) {
        rememberShopRead(history, { shopId, at: ts, ok: true });
      } else if ((kind === 'poll' && status === 'stopped') || (kind === 'shop-refresh' && entry.ok === false)) {
        // 旧审计未保存登录结论，历史错误只作展示。
        rememberShopRead(history, { shopId, at: ts, ok: false, reason });
      }
    }
  } catch (_) {
    // 首次启动没有审计文件。历史不可读时，继续显示新取数结果。
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return history;
}

module.exports = { loadShopReadHistory, rememberShopRead };
