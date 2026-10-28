'use strict';
/**
 * staleInvalidation.js — 更新路径来源策略 v3（隔离）。
 *
 * 变更相对 v2：
 *  A) human/unknown **不回写**旧快照 → 从 PUT payload **省略**字段（服务器保留最新值）
 *  B) 台账拆成「决策 pending」与「HTTP 成功后 commit」；失败/重试耗尽不推进已确认台账
 *  C) 台账可持久化；身份含 table/platform/shop/product/field；只记**最后确认写入值**
 *  D) 精确值匹配仍非并发绝对证明 → 替换系统字段路径保持保守冲突
 *
 * 不用关键词启发式声称「不会误删人工」。
 */

const fs = require('fs');
const path = require('path');

const LEDGER_VERSION = 3;

/** 持久化结构：Map<identityKey, { value, updatedAt }> — 只保留最后确认值 */
let ledgerStore = new Map();
let ledgerPath = null;
/** 兼容单请求测试的默认请求；生产路径应使用 createLedgerRequest() */
let defaultLedgerRequest = null;

function identityKey({ tableId, platform, shopName, productId, fieldKey }) {
  return [
    tableId || 'default_table',
    platform || 'douyin',
    shopName || 'default_shop',
    String(productId),
    fieldKey,
  ].join('|');
}

function configureLedger(opts = {}) {
  if (opts.path) {
    ledgerPath = opts.path;
    loadLedgerFromDisk();
  }
  if (opts.reset) {
    ledgerStore = new Map();
    defaultLedgerRequest = null;
    if (ledgerPath) persistLedger();
  }
}

/** 仅在尚未配置路径时设置默认路径（避免覆盖测试注入的路径） */
function ensureLedgerPath(defaultPath) {
  // 子进程隔离验收：可通过 SOURCE_LEDGER_PATH 指定独立台账文件
  const envPath = process.env.SOURCE_LEDGER_PATH;
  if (!ledgerPath && (envPath || defaultPath)) {
    ledgerPath = envPath || defaultPath;
    loadLedgerFromDisk();
  }
  return ledgerPath;
}

function loadLedgerFromDisk() {
  if (!ledgerPath) return { ok: false, reason: 'no_path' };
  try {
    if (!fs.existsSync(ledgerPath)) {
      ledgerStore = new Map();
      return { ok: true, reason: 'empty_file' };
    }
    const raw = fs.readFileSync(ledgerPath, 'utf8');
    const data = JSON.parse(raw);
    if (!data || data.version !== LEDGER_VERSION || typeof data.entries !== 'object' || data.entries === null) {
      // 损坏/旧版：丢弃并当空台账（证据不足 → unknown）
      ledgerStore = new Map();
      persistLedger();
      return { ok: false, reason: 'corrupt_or_incompatible_reset_to_empty' };
    }
    ledgerStore = new Map(Object.entries(data.entries));
    return { ok: true, reason: 'loaded', size: ledgerStore.size };
  } catch (e) {
    ledgerStore = new Map();
    try { persistLedger(); } catch (e2) {}
    return { ok: false, reason: 'load_error_reset_to_empty', error: e.message };
  }
}

function persistLedger() {
  if (!ledgerPath) return;
  const obj = {
    version: LEDGER_VERSION,
    savedAt: new Date().toISOString(),
    entries: Object.fromEntries(ledgerStore),
  };
  fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
  fs.writeFileSync(ledgerPath, JSON.stringify(obj, null, 2), 'utf8');
}

/**
 * 请求级待提交操作。一个 HTTP 写请求一个 req，避免交错请求互相提交/清空。
 */
function createLedgerRequest(requestId) {
  return {
    requestId: requestId || `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    ops: [],
    queueWrite(identity, value) {
      const key = identityKey(identity);
      this.ops.push({ op: 'set', key, value: value == null ? '' : String(value) });
      return key;
    },
    queueClear(identity) {
      const key = identityKey(identity);
      this.ops.push({ op: 'clear', key });
      return key;
    },
    commit({ success, recordId, productId, reason } = {}) {
      if (!success) {
        const aborted = this.ops.length;
        this.ops = [];
        return { committed: 0, aborted, reason: reason || 'not_success', requestId: this.requestId };
      }
      let n = 0;
      for (const op of this.ops) {
        if (op.op === 'set') {
          ledgerStore.set(op.key, {
            value: op.value,
            updatedAt: new Date().toISOString(),
            recordId: recordId != null ? String(recordId) : undefined,
            productId: productId != null ? String(productId) : undefined,
            requestId: this.requestId,
          });
          n++;
        } else if (op.op === 'clear') {
          ledgerStore.delete(op.key);
          n++;
        }
      }
      this.ops = [];
      persistLedger();
      return { committed: n, reason: 'ok', requestId: this.requestId };
    },
    abort(reason = 'aborted') {
      const aborted = this.ops.length;
      this.ops = [];
      return { aborted, reason, requestId: this.requestId };
    },
    pendingCount() { return this.ops.length; },
  };
}

/** 兼容：写入默认请求（单请求测试） */
function queueSystemWrite(identity, value) {
  if (!defaultLedgerRequest) defaultLedgerRequest = createLedgerRequest('default');
  return defaultLedgerRequest.queueWrite(identity, value);
}

function queueSystemClear(identity) {
  if (!defaultLedgerRequest) defaultLedgerRequest = createLedgerRequest('default');
  return defaultLedgerRequest.queueClear(identity);
}

function commitPendingLedger(opts = {}) {
  if (!defaultLedgerRequest) return { committed: 0, reason: 'no_pending_request' };
  const r = defaultLedgerRequest.commit(opts);
  defaultLedgerRequest = null;
  return r;
}

function abortPendingLedger(reason = 'aborted') {
  if (!defaultLedgerRequest) return { aborted: 0, reason: 'no_pending_request' };
  const r = defaultLedgerRequest.abort(reason);
  defaultLedgerRequest = null;
  return r;
}

function isLedgerMatch(identity, value) {
  if (value == null || value === '') return false;
  const key = identityKey(identity);
  const rec = ledgerStore.get(key);
  return !!(rec && String(rec.value) === String(value));
}

function getLedgerValue(identity) {
  const rec = ledgerStore.get(identityKey(identity));
  return rec ? rec.value : undefined;
}

function _ledgerSnapshot() {
  return Object.fromEntries(ledgerStore);
}

function _ledgerReset() {
  ledgerStore = new Map();
  defaultLedgerRequest = null;
  // 不强制写盘：避免测试/重启模拟时把已确认文件清空
}

function _ledgerResetAndPersist() {
  _ledgerReset();
  persistLedger();
}

function _pendingSnapshot() {
  if (!defaultLedgerRequest) return [];
  return defaultLedgerRequest.ops.map(o => ({ ...o }));
}

/**
 * 来源分类。
 * opts.protectExact: 显式人工保护串列表
 */
function classifyOpinion(identity, fieldKey, value, opts = {}) {
  const id = { ...identity, fieldKey };
  if (value == null || value === '') {
    return { source: 'empty', reason: 'empty' };
  }
  const s = String(value);
  if (opts.alreadyIntervention != null && s === String(opts.alreadyIntervention)) {
    return { source: 'human', reason: 'already_intervention_field' };
  }
  if (Array.isArray(opts.protectExact) && opts.protectExact.includes(s)) {
    return { source: 'human', reason: 'protect_exact' };
  }
  if (isLedgerMatch(id, s)) {
    return { source: 'system_auto', reason: 'ledger_exact_match_last_confirmed' };
  }
  return { source: 'unknown', reason: 'not_last_confirmed_system_value' };
}

/**
 * @param {object} opts
 * @param {object} opts.fields              本轮 fields（就地修改；保护字段将 delete）
 * @param {object} opts.identity            { tableId, platform, shopName, productId }
 * @param {object} [opts.existingFields]
 * @param {object} [opts.freshExistingFields]
 * @param {boolean} opts.isUpdate
 * @param {string} opts.profitStatus
 * @param {boolean} [opts.profitWritten]
 * @param {string} [opts.alreadyIntervention]
 * @param {boolean} [opts.omitAlreadyIntervention] 本轮不改则省略「已经干预」
 * @returns {object} trail
 */
function applyStaleInvalidation(opts) {
  const fields = opts.fields;
  const identity = opts.identity || {
    tableId: opts.tableId,
    platform: opts.platform,
    shopName: opts.shopName,
    productId: opts.productId,
  };
  const fieldKey = '等待人工操作';
  const existing = opts.isUpdate
    ? (opts.freshExistingFields || opts.existingFields || null)
    : null;
  const status = opts.profitStatus || 'absent';
  const profitWritten = opts.profitWritten === true;
  const trail = {
    isUpdate: !!opts.isUpdate,
    profitStatus: status,
    identity: { ...identity, fieldKey },
    actions: [],
    classifications: {},
    conflicts: [],
    omittedFields: [],
  };

  if (!opts.isUpdate) {
    if (!profitWritten && status !== 'ok') {
      if (!('平均每单利润' in fields) || fields['平均每单利润'] === undefined) {
        fields['平均每单利润'] = null;
        trail.actions.push('create_no_profit_set_null');
      }
    }
    // create：不在此 queue；由调用方在最终 payload 后统一 queue
    trail.ledgerIntent = (fields[fieldKey] != null && fields[fieldKey] !== '') ? 'write' : 'none';
    return trail;
  }

  const hadOldProfit = existing && existing['平均每单利润'] !== undefined && existing['平均每单利润'] !== null;
  const oldOp = existing ? existing[fieldKey] : undefined;

  // 1) 利润失效
  if (!profitWritten || status !== 'ok') {
    if (hadOldProfit) {
      fields['平均每单利润'] = null;
      trail.actions.push('invalidate_stale_profit');
      trail.oldProfit = existing['平均每单利润'];
    } else if (!('平均每单利润' in fields)) {
      fields['平均每单利润'] = null;
      trail.actions.push('update_no_profit_set_null');
    }
  }

  // 2) 分类旧内容（必须在处理新建议之前）
  const oldClass = classifyOpinion(identity, fieldKey, oldOp, {
    alreadyIntervention: opts.alreadyIntervention,
  });
  trail.classifications.oldOpinion = oldClass;

  const newOp = fields[fieldKey];
  const hasNewContent = newOp != null && newOp !== '';
  trail.classifications.newOpinion = hasNewContent
    ? { source: 'system_auto', reason: 'written_this_round_by_isolation_writer' }
    : { source: 'empty', reason: 'no_new' };

  // 3) 决策：保护字段 **省略**，不回写旧快照
  if (hasNewContent) {
    if (oldClass.source === 'system_auto' || oldClass.source === 'empty') {
      trail.ledgerIntent = 'write';
      trail.actions.push(oldClass.source === 'empty' ? 'intend_write_new_auto' : 'intend_replace_confirmed_system_auto');
    } else {
      trail.conflicts.push({
        field: fieldKey,
        oldSource: oldClass.source,
        old: oldOp,
        attemptedNew: newOp,
        resolution: 'omit_field_keep_server_value',
      });
      delete fields[fieldKey];
      trail.omittedFields.push(fieldKey);
      trail.actions.push('conflict_omit_field');
      trail.ledgerIntent = 'none';
    }
  } else {
    if (oldClass.source === 'system_auto') {
      fields[fieldKey] = '';
      trail.actions.push('write_empty_to_clear_confirmed_system_auto');
      trail.ledgerIntent = 'clear';
    } else if (oldClass.source === 'human' || oldClass.source === 'unknown') {
      delete fields[fieldKey];
      trail.omittedFields.push(fieldKey);
      trail.actions.push(
        oldClass.source === 'human' ? 'omit_human_field' : 'omit_unknown_field'
      );
      trail.ledgerIntent = 'none';
    } else {
      if (fieldKey in fields) {
        delete fields[fieldKey];
        trail.omittedFields.push(fieldKey);
        trail.actions.push('omit_empty_op_field');
      }
      trail.ledgerIntent = 'none';
    }
  }

  // 4) 已经干预：本轮不改则省略，避免无意义回写快照
  if (opts.omitAlreadyIntervention !== false) {
    const wroteIntervention = '已经干预' in fields;
    if (!wroteIntervention) {
      // 若 fields 被外部拷贝进了旧值也删掉
      if (existing && existing['已经干预'] != null && String(fields['已经干预']) === String(existing['已经干预'])) {
        delete fields['已经干预'];
        trail.omittedFields.push('已经干预');
        trail.actions.push('omit_already_intervention_snapshot');
      }
    }
  } else if (existing && existing['已经干预'] != null && !('已经干预' in fields)) {
    // 显式要求保留写入时
    fields['已经干预'] = existing['已经干预'];
    trail.actions.push('preserve_already_intervention');
  }

  if (opts.freshExistingFields) {
    trail.actions.push('used_fresh_snapshot');
  }

  return trail;
}

module.exports = {
  applyStaleInvalidation,
  classifyOpinion,
  isLedgerMatch,
  getLedgerValue,
  createLedgerRequest,
  queueSystemWrite,
  queueSystemClear,
  commitPendingLedger,
  abortPendingLedger,
  configureLedger,
  ensureLedgerPath,
  loadLedgerFromDisk,
  identityKey,
  _ledgerSnapshot,
  _ledgerReset,
  _ledgerResetAndPersist,
  _pendingSnapshot,
  LEDGER_VERSION,
};
