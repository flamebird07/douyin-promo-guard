'use strict';

// 独立同步配置操作：仅依赖 Node 内建模块，绝不装配 Monitor、发现 Cookie 或启动轮询。
const fs = require('fs');
const path = require('path');
const { createHash, randomBytes } = require('crypto');

/** 只接受原样、严格唯一的字符串 id；不做别名匹配、类型转换或去后缀。纯函数。 */
function resolveRestoreTarget(shops, shopId) {
  if (shopId == null || (typeof shopId === 'string' && !shopId.trim())) {
    return { ok: false, code: 'SHOP_ID_REQUIRED' };
  }
  if (typeof shopId !== 'string') return { ok: false, code: 'SHOP_ID_INVALID' };
  if (!Array.isArray(shops)) return { ok: false, code: 'CONFIG_INVALID' };
  const matches = shops.filter((s) => s && typeof s === 'object' && s.id === shopId);
  if (!matches.length) return { ok: false, code: 'SHOP_NOT_FOUND' };
  if (matches.length !== 1) return { ok: false, code: 'SHOP_ID_AMBIGUOUS' };
  const entry = matches[0];
  if (entry.deleted === false && entry.enabled === false) {
    return { ok: true, code: 'ALREADY_RESTORED', entry };
  }
  if (entry.deleted !== true) return { ok: false, code: 'SHOP_NOT_DELETED' };
  return { ok: true, code: 'RESTORED', entry };
}

function safeShopRef(shopId) {
  return 'sha256:' + createHash('sha256').update(shopId, 'utf8').digest('hex').slice(0, 24);
}

// Node fs 没有条件 rename；末次字节比较与 rename 之间仍有并发窗口。
function restoreShopConfig({ configPath, shopId, auditPath, expectedShops, fsModule = fs } = {}) {
  const result = {
    ok: false, code: 'CONFIG_READ_FAILED', restored: false, persisted: false,
    committed: false, backupCreated: false, auditWritten: false,
  };
  // 缺 id 优先拒绝，甚至不读取文件。
  const idCheck = resolveRestoreTarget([], shopId);
  if (idCheck.code === 'SHOP_ID_REQUIRED' || idCheck.code === 'SHOP_ID_INVALID') {
    return { ...result, code: idCheck.code };
  }
  if (typeof configPath !== 'string' || !configPath.trim() || configPath.includes('\0')
    || typeof auditPath !== 'string' || !auditPath.trim() || auditPath.includes('\0')) {
    return { ...result, code: 'PATH_REQUIRED' };
  }
  if (path.resolve(configPath) === path.resolve(auditPath)) {
    return { ...result, code: 'AUDIT_PATH_INVALID' };
  }

  const owned = new Set();
  let stage = 'CONFIG_READ_FAILED';
  // 只清理本次成功独占创建的文件，open(wx) 失败的外来文件绝不能删。
  function writeExclusive(file, bytes) {
    const fd = fsModule.openSync(file, 'wx', 0o600);
    owned.add(file);
    try {
      fsModule.writeFileSync(fd, bytes);
      fsModule.fsyncSync(fd);
    } finally {
      fsModule.closeSync(fd);
    }
  }
  function sameBytes(file, expected) {
    return fsModule.readFileSync(file).equals(expected);
  }

  try {
    const configStat = fsModule.lstatSync(configPath);
    if (!configStat.isFile() || configStat.isSymbolicLink()) {
      result.code = 'CONFIG_INVALID';
      return result;
    }
    // 审计不得经同名、软链或硬链回写配置；不自动创建任何目录。
    stage = 'AUDIT_PATH_INVALID';
    let auditStat;
    try { auditStat = fsModule.lstatSync(auditPath); } catch (error) {
      if (!error || error.code !== 'ENOENT') throw error;
    }
    if (auditStat && (!auditStat.isFile() || auditStat.isSymbolicLink()
      || (auditStat.dev === configStat.dev && auditStat.ino === configStat.ino))) {
      result.code = 'AUDIT_PATH_INVALID';
      return result;
    }
    stage = 'CONFIG_READ_FAILED';
    const original = fsModule.readFileSync(configPath);
    stage = 'CONFIG_INVALID';
    const raw = JSON.parse(original.toString('utf8'));
    if (expectedShops !== undefined && JSON.stringify(raw && raw.shops) !== JSON.stringify(expectedShops)) {
      result.code = 'CONFIG_CONFLICT';
      return result;
    }
    const target = resolveRestoreTarget(raw && raw.shops, shopId);
    result.code = target.code;
    if (!target.ok) return result;
    result.shopRef = safeShopRef(shopId);
    if (target.code === 'ALREADY_RESTORED') {
      // 幂等也复查字节，不把并发变更报告为成功；无备份/临时/审计写入。
      stage = 'CONFIG_READ_FAILED';
      if (!sameBytes(configPath, original)) {
        result.code = 'CONFIG_CONFLICT';
        return result;
      }
      return Object.assign(result, { ok: true, persisted: true, enabled: false });
    }

    // 直接修改原始 JSON 中的两标记，保留未知字段、其他店铺与历史配置。
    target.entry.deleted = false;
    target.entry.enabled = false;
    const replacement = Buffer.from(JSON.stringify(raw, null, 2) + '\n', 'utf8');
    stage = 'CONFIG_READ_FAILED';
    if (!sameBytes(configPath, original)) {
      result.code = 'CONFIG_CONFLICT';
      return result;
    }

    stage = 'BACKUP_FAILED';
    const backupId = randomBytes(12).toString('hex');
    const backupPath = `${configPath}.restore-${backupId}.bak`;
    writeExclusive(backupPath, original);
    if (!sameBytes(backupPath, original)) return Object.assign(result, { code: stage });
    owned.delete(backupPath); // 完整、已 fsync 的备份保留供人工回滚，不作为失败临时文件清理。
    Object.assign(result, { backupCreated: true, backupId });

    stage = 'CONFIG_WRITE_FAILED';
    const tempPath = `${configPath}.restore-${backupId}.tmp`;
    writeExclusive(tempPath, replacement);
    if (!sameBytes(tempPath, replacement)) return Object.assign(result, { code: stage });
    // CAS：就在 rename 之前按原始字节比较，不仅比较解析后的标记。
    if (!sameBytes(configPath, original)) {
      result.code = 'CONFIG_CONFLICT';
      return result;
    }
    fsModule.renameSync(tempPath, configPath);
    owned.delete(tempPath);
    result.committed = true;
    result.persisted = null;
    stage = 'CONFIG_VERIFY_FAILED';
    if (!sameBytes(configPath, replacement)) {
      result.code = 'CONFIG_CONFLICT';
      result.persisted = false;
      return result; // 外来写入胜出，不盲目恢复备份。
    }
    Object.assign(result, { restored: true, persisted: true, enabled: false });

    stage = 'AUDIT_WRITE_FAILED';
    fsModule.appendFileSync(auditPath, JSON.stringify({
      ts: new Date().toISOString(), kind: 'shop-restore', shopRef: result.shopRef,
      enabled: false, persisted: true,
    }) + '\n', { encoding: 'utf8', mode: 0o600 });
    Object.assign(result, { ok: true, code: 'RESTORED', auditWritten: true });
    return result;
  } catch (_) {
    // 不传播自由异常（包括 JSON 解析片段、文件路径及 Cookie/令牌）。
    result.code = stage;
    return result;
  } finally {
    for (const file of owned) {
      try { fsModule.unlinkSync(file); } catch (error) {
        if (!error || error.code !== 'ENOENT') {
          result.cleanupFailed = true;
          result.ok = false;
        }
      }
    }
  }
}

module.exports = { restoreShopConfig, resolveRestoreTarget, safeShopRef };
