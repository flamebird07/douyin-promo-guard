'use strict';
/**
 * prodAutoScheduler.js — 生产自动化接入（已验收状态机）。
 * 一次启动共享一个 runId；所有轮次同一状态文件；父进程算 newCount。
 * 不依赖隔离 server.auto.js 的 defaultSpawn；由生产注入 startPlatformAnalyzer。
 *
 * SD1 修复（2026-10-02，历史）：自动关机判定曾与业务成功分离，NO_PROGRESS 可关机。
 *
 * AUTO-CONT-1 纠正（2026-10-04）：客户实测 runId=prodmusgfw9o896b 暴露——分析器状态
 * 从未持久化（save() 不存在被吞），父调度器轮轮 newCount=0，第2轮 NO_PROGRESS 提前停止
 * （20个商品），证明“无进展停止”可以是假无进展。本次修复：
 *   1) 轮后一致性门：RESULT.processedKeys 必须与状态文件中该店身份一致；
 *      分析器上报 statePersistOk/stateLoadOk=false 时本轮按失败处理，明确报错，
 *      不硬把 writeCount 或其他来源当新进展兜底。
 *   2) 耗尽证据扩展：exhausted（分析器走完整份列表确认末页且无遗留）与 hitZeroOrder 并列，
 *      unprocessedLeft>0 时耗尽降级 INCOMPLETE（见 completion.js）。
 *   3) 关机资格收紧：只有全部店铺 NORMAL_COMPLETE（可靠耗尽）+ 无待重试 + 状态文件可信
 *      才允许关机；NO_PROGRESS 不再关机（不证明耗尽）。取消/失败/INCOMPLETE/仍在跑/状态
 *      不可信一律不关机。保留“运行中读取最新关机设置”（getAutoShutdownRequested）。
 *
 * AUTO-CONT-1 补修（2026-10-04 第二轮，主脑反例 7/8）：
 *   4) 先验证状态，再接收进展：抖店 RESULT 契约完整校验（字段齐全、类型正确、身份键
 *      归属当前店铺且无重复、状态标志为真、与状态文件集合双向一致、failedKeys 不在成功
 *      集合中）；校验全部通过才 importAndCount 导入父去重集合并计进展。校验失败 → 本轮
 *      按失败重试（不导入、不清待重试、不写回未验证状态），持续失败 → FAILED 不关机。
 *   5) 轮前状态写入失败显式处理：本轮不启动分析器，按失败重试，不用后续成功读取掩盖。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ShopTracker, STATE, DEFAULTS } = require('./completion');
const { RunDedup } = require('./runDedup');

/**
 * @param {object} opts
 * @param {Array<{shopName:string, platform?:string}>} opts.shops
 * @param {number} [opts.targetCount]
 * @param {number} [opts.intervalMinutes]
 * @param {boolean} [opts.autoShutdown]
 * @param {function} opts.startAnalyzer ({shop, runId, stateFile, targetCount, silent}) => Promise<{success, finished, hitZeroOrder, cookieExpired, result, message}>
 * @param {string} opts.workspace
 * @param {function} [opts.logFn]
 * @param {function} [opts.shutdownFn]
 * @param {object} [opts.abortSignal]
 * @param {number} [opts.maxRounds] 轮数上限（非时间）
 * @param {number} [opts.maxNoProgressRounds]
 * @param {number} [opts.maxRetries]
 * @param {string} [opts.runId] 复用已有 runId（一般由本次启动生成）
 */
/**
 * AUTO-CONT-1补修(缺口三): 抖店 RESULT 契约完整校验（仅 douyin 平台调用）。
 * 校验项：必需字段齐全且类型正确（processedKeys/failedKeys 数组、allSuccess/exhausted/
 * statePersistOk/stateLoadOk 布尔、writeCount/unprocessedLeft 非负数值）、身份键全部属于
 * 当前店铺且非空、无重复、状态持久化/加载标志为 true、与状态文件身份集合双向一致、
 * failedKeys 不得出现在状态文件成功集合中。
 * 任何一项不满足都返回 {ok:false,reasons}，调用方必须：不导入父去重集合、不计进展、
 * 不用 successKeys 清除待重试、不把未验证状态写回下一轮。
 */
function validateDouyinResultState(r, fileKeys, shopName, parentOtherKeys) {
  const prefix = `douyin|${shopName || ''}|`;
  const validKey = (k) => typeof k === 'string' && k.startsWith(prefix) && k.length > prefix.length;
  const reasons = [];
  if (!r || typeof r !== 'object') return { ok: false, reasons: ['RESULT缺失或非对象'] };

  if (!Array.isArray(r.processedKeys)) reasons.push('processedKeys缺失或非数组');
  if (!Array.isArray(r.failedKeys)) reasons.push('failedKeys缺失或非数组');
  if (typeof r.allSuccess !== 'boolean') reasons.push('allSuccess缺失或非布尔');
  if (typeof r.exhausted !== 'boolean') reasons.push('exhausted缺失或非布尔');
  if (typeof r.statePersistOk !== 'boolean') reasons.push('statePersistOk缺失或非布尔');
  if (typeof r.stateLoadOk !== 'boolean') reasons.push('stateLoadOk缺失或非布尔');
  if (typeof r.writeCount !== 'number' || !(r.writeCount >= 0)) reasons.push('writeCount缺失或非法');
  if (typeof r.unprocessedLeft !== 'number' || !(r.unprocessedLeft >= 0)) reasons.push('unprocessedLeft缺失或非法');
  if (r.statePersistOk === false) reasons.push('分析器状态持久化失败(statePersistOk=false)');
  if (r.stateLoadOk === false) reasons.push('分析器状态加载失败(stateLoadOk=false)');

  let shopResultKeys = [];
  if (Array.isArray(r.processedKeys)) {
    shopResultKeys = r.processedKeys.filter(validKey);
    if (shopResultKeys.length !== r.processedKeys.length) reasons.push('processedKeys含缺失/外店/空身份键');
    if (new Set(shopResultKeys).size !== shopResultKeys.length) reasons.push('processedKeys存在重复身份');
  }
  if (Array.isArray(r.failedKeys)) {
    if (r.failedKeys.some((k) => !validKey(k))) reasons.push('failedKeys含缺失/外店/空身份键');
    if (Array.isArray(fileKeys) && r.failedKeys.some((k) => fileKeys.includes(k))) {
      reasons.push('failedKeys与状态文件成功集合冲突（失败身份不得入成功集合）');
    }
  }
  if (Array.isArray(fileKeys)) {
    if (fileKeys.some((k) => typeof k !== 'string')) reasons.push('状态文件含非字符串键');
    const shopFileKeys = fileKeys.filter(validKey);
    if (new Set(shopFileKeys).size !== shopFileKeys.length) reasons.push('状态文件存在重复身份');
    if (Array.isArray(r.processedKeys)) {
      const shopFileOnly = shopFileKeys.length === shopResultKeys.length
        && shopResultKeys.every((k) => shopFileKeys.includes(k));
      if (!shopFileOnly) reasons.push(`RESULT身份(${shopResultKeys.length})与状态文件身份(${shopFileKeys.length})集合不一致`);
    }
  } else {
    reasons.push('状态文件不可读');
  }
  // AUTO-CONT-1补修(缺口二/R2): 以轮前可信父快照逐字核对"其他店铺分区"。
  // 文件中不属于本店的所有字符串键，必须与父快照中的他店键集合完全一致——他店键被
  // 新增/删除/替换/重复都属未授权改动，一律拒绝接收，防止污染父去重集合或让下一店据此
  // 跳过未处理商品。parentOtherKeys 由调用方在校验前从 dedup.exportKeys() 取（可信父集合）。
  if (Array.isArray(parentOtherKeys) && Array.isArray(fileKeys)) {
    const fileOther = fileKeys.filter((k) => typeof k === 'string' && !k.startsWith(prefix));
    const parentSet = new Set(parentOtherKeys);
    const fileSet = new Set(fileOther);
    const added = fileOther.filter((k) => !parentSet.has(k));
    const removed = Array.from(parentSet).filter((k) => !fileSet.has(k));
    if (added.length) reasons.push(`其他店铺键被新增/替换(未授权): ${added.join('，')}`);
    if (removed.length) reasons.push(`其他店铺键被删除/替换: ${removed.join('，')}`);
    if (fileOther.length !== fileSet.size) reasons.push('其他店铺键存在重复');
  }
  return { ok: reasons.length === 0, reasons };
}

async function runProductionAutoSchedule(opts) {
  const {
    shops = [],
    targetCount = 10,
    intervalMinutes = 0,
    autoShutdown = false,
    getAutoShutdownRequested,
    startAnalyzer,
    workspace,
    logFn = () => {},
    shutdownFn = () => {},
    abortSignal = { aborted: false },
    maxRounds = DEFAULTS.maxRounds,
    maxNoProgressRounds = DEFAULTS.maxNoProgressRounds,
    maxRetries = DEFAULTS.maxRetries,
  } = opts;

  if (!startAnalyzer) throw new Error('startAnalyzer required');
  if (!shops.length) return { success: false, message: '没有店铺配置' };

  const runId = opts.runId || `prod${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
  const dedup = new RunDedup();
  const trackers = shops.map(() => new ShopTracker({
    targetCount, maxRounds, maxNoProgressRounds, maxRetries,
  }));
  const stateFile = path.join(workspace, `run_dedup_${runId}.json`);
  let stateFileOk = true;

  const status = {
    version: opts.version || 'prod-auto',
    runId,
    stateFile,
    startedAt: new Date().toISOString(),
    round: 0,
    lastReason: null,
    shopStates: [],
  };

  const writeState = () => {
    try {
      fs.writeFileSync(stateFile, JSON.stringify(dedup.exportKeys()), 'utf8');
      stateFileOk = true;
    } catch (e) {
      stateFileOk = false;
      logFn(`[生产接入] 写状态文件失败: ${e.message}`);
    }
  };

  const readNewCount = (loadedBefore) => {
    try {
      if (!fs.existsSync(stateFile)) {
        stateFileOk = false;
        return null;
      }
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!Array.isArray(saved)) {
        stateFileOk = false;
        return null;
      }
      const n = dedup.importAndCount(saved);
      stateFileOk = true;
      return n;
    } catch (e) {
      stateFileOk = false;
      logFn(`[生产接入] 读状态文件失败: ${e.message}`);
      return null;
    }
  };

  // AUTO-CONT-1: 只读原始键列表（供 RESULT 身份一致性核对；不改变 dedup）。
  // AUTO-CONT-1补修(缺口二/R2): 不再预过滤非字符串——预清洗会让 validateDouyinResultState
  // 的"状态文件含非字符串键"判据不可达，从而掩盖无效输入。原样返回，交由校验可见地拒绝。
  const readStateKeysRaw = () => {
    try {
      const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (!Array.isArray(saved)) return null;
      return saved;
    } catch (e) {
      return null;
    }
  };

  logFn(`[生产接入] 启动 runId=${runId} shops=${shops.length} target=${targetCount} maxRounds=${maxRounds}`);

  let round = 1;
  while (!abortSignal.aborted) {
    const active = shops.map((_, i) => i).filter((i) => !trackers[i].isDone());
    if (!active.length) {
      logFn('[生产接入] 所有店铺已结束');
      status.lastReason = status.lastReason || 'all_shops_finished';
      break;
    }
    status.round = round;
    logFn(`[生产接入] === 第${round}轮 ${active.length}店 ===`);

    for (const idx of active) {
      if (abortSignal.aborted) break;
      const shop = shops[idx];
      const tracker = trackers[idx];
      const platform = shop.platform || 'douyin';

      writeState();
      if (!stateFileOk) {
        // AUTO-CONT-1补修(缺口三): 轮前状态写入失败必须显式处理——不能带着未知状态启动
        // 分析器，也不能继续运行后用一次成功读取掩盖失败。本轮按失败处理（不启动），
        // 下一轮重试；持续失败 → FAILED，不关机。
        const decision = tracker.applyFailure({ message: '轮前状态写入失败' });
        logFn(`[生产接入] ${shop.shopName}: [状态拒绝] 轮前状态写入失败 → 本轮不启动分析器（${decision.reason}）`);
        status.shopStates.push({ shop: shop.shopName, platform, at: new Date().toISOString(), phase: 'state_write_failed', trackerState: tracker.state, reason: decision.reason });
        if (tracker.isDone() && tracker.state !== STATE.NORMAL_COMPLETE && !status.lastReason) {
          status.lastReason = tracker.state.toLowerCase();
        }
        continue;
      }
      let spawnOut;
      try {
        spawnOut = await startAnalyzer({
          shop,
          runId,
          stateFile,
          targetCount,
          platform,
          silent: opts.silent !== false,
        });
      } catch (e) {
        const decision = tracker.applyFailure({ message: e.message });
        logFn(`[生产接入] ${shop.shopName}: ${decision.reason}`);
        status.shopStates.push({ shop: shop.shopName, at: new Date().toISOString(), phase: 'spawn_error', reason: decision.reason });
        continue;
      }

      if (!spawnOut || spawnOut.success === false) {
        if (spawnOut && spawnOut.cookieExpired) {
          tracker.cancel();
          logFn(`[生产接入] ${shop.shopName}: Cookie过期`);
          status.lastReason = 'cookie_expired';
        } else {
          const decision = tracker.applyFailure({ message: (spawnOut && spawnOut.message) || 'start_failed' });
          logFn(`[生产接入] ${shop.shopName}: ${decision.reason}`);
        }
        status.shopStates.push({ shop: shop.shopName, at: new Date().toISOString(), phase: 'start_fail', out: spawnOut && { success: spawnOut.success, message: spawnOut.message } });
        continue;
      }

      const r = (spawnOut && spawnOut.result) || {};

      // === AUTO-CONT-1补修(缺口三): 先验证状态，再接收进展 ===
      // 1) 读取状态文件原始内容（不导入父去重集合）；
      // 2) 抖店 RESULT 契约完整校验 + 与状态文件身份集合一致性校验；
      // 3) 全部通过才 importAndCount 导入父去重集合并计进展，才允许 successKeys 清待重试；
      // 4) 任一校验失败 → 本轮按失败处理（不导入、不计进展、不清待重试、不把未验证状态
      //    写回下一轮），下一轮重试；持续失败 → FAILED，不关机。
      // PDD 既有兼容路径不变（其 RESULT 无 processedKeys 契约，沿用读文件计新增）。
      let newCountRaw;
      if (platform === 'douyin') {
        const rawStateKeys = readStateKeysRaw();
        if (rawStateKeys === null) {
          stateFileOk = false;
          tracker.cancel();
          logFn(`[生产接入] ${shop.shopName}: 状态文件不可信，取消`);
          status.lastReason = 'state_file_untrusted';
          status.shopStates.push({ shop: shop.shopName, platform, at: new Date().toISOString(), phase: 'state_unreadable' });
          continue;
        }
        // AUTO-CONT-1补修(缺口二/R2): 轮前可信父快照 = 此刻 dedup 里不属于本店的所有键
        // （他店键只能来自之前已验证通过的接收）。据此逐字核对文件中的他店分区。
        const selfPrefix = `douyin|${shop.shopName}|`;
        const parentOtherKeys = dedup.exportKeys().filter((k) => !k.startsWith(selfPrefix));
        const validation = validateDouyinResultState(r, rawStateKeys, shop.shopName, parentOtherKeys);
        if (!validation.ok) {
          const decision = tracker.applyFailure({ message: 'RESULT状态校验失败: ' + validation.reasons.join('；') });
          logFn(`[生产接入] ${shop.shopName}: [状态拒绝] ${validation.reasons.join('；')} → 本轮不采信进展（${decision.reason}）`);
          status.shopStates.push({ shop: shop.shopName, platform, at: new Date().toISOString(), phase: 'result_state_invalid', reasons: validation.reasons, newCount: 0, trackerState: tracker.state, reason: decision.reason });
          if (tracker.isDone() && tracker.state !== STATE.NORMAL_COMPLETE && !status.lastReason) {
            status.lastReason = tracker.state.toLowerCase();
          }
          continue;
        }
        // AUTO-CONT-1补修(缺口二/R2): 验证通过——父快照已覆盖的他店键不重复计入，
        // 只有本店通过校验的成功键才是新增。importAndCount 对已在父集合的他店键返回 0，
        // 因此 newCount 只反映本店新增。
        newCountRaw = dedup.importAndCount(rawStateKeys);
        stateFileOk = true;
      } else {
        newCountRaw = readNewCount();
        if (newCountRaw === null) {
          tracker.cancel();
          logFn(`[生产接入] ${shop.shopName}: 状态文件不可信，取消`);
          status.lastReason = 'state_file_untrusted';
          status.shopStates.push({ shop: shop.shopName, platform, at: new Date().toISOString(), phase: 'state_unreadable' });
          continue;
        }
      }

      const decision = tracker.applyRound({
        writeCount: r.writeCount || 0,
        newCount: newCountRaw,
        hitZeroOrder: !!(spawnOut.hitZeroOrder || r.hitZeroOrder),
        exhausted: r.exhausted === true,
        unprocessedLeft: r.unprocessedLeft || 0,
        allSuccess: r.allSuccess === true,
        successKeys: Array.isArray(r.processedKeys) ? r.processedKeys : [],
        failedKeys: Array.isArray(r.failedKeys) ? r.failedKeys : [],
        cancelled: abortSignal.aborted,
      });

      const shopState = {
        shop: shop.shopName,
        platform,
        at: new Date().toISOString(),
        writeCount: r.writeCount || 0,
        newCount: newCountRaw,
        hitZeroOrder: !!(spawnOut.hitZeroOrder || r.hitZeroOrder),
        exhausted: r.exhausted === true,
        unprocessedLeft: r.unprocessedLeft || 0,
        stateConsistent: true, // 已通过契约+一致性校验才会走到这里
        allSuccess: r.allSuccess === true,
        trackerState: tracker.state,
        reason: decision.reason,
      };
      status.shopStates.push(shopState);
      logFn(`[生产接入] ${shop.shopName}: 写${r.writeCount || 0} 新增${newCountRaw}${r.exhausted ? ' [耗尽证据]' : ''} → ${decision.reason}`);

      if (tracker.isDone() && tracker.state !== STATE.NORMAL_COMPLETE && !status.lastReason) {
        status.lastReason = tracker.state.toLowerCase();
      }
      if (tracker.state === STATE.NORMAL_COMPLETE && !status.lastReason) {
        status.lastReason = 'normal_complete';
      }
    }

    if (abortSignal.aborted) {
      for (const t of trackers) if (!t.isDone()) t.cancel();
      status.lastReason = 'cancelled';
      break;
    }

    const still = trackers.some((t) => !t.isDone());
    if (!still) break;

    if (intervalMinutes > 0) {
      logFn(`[生产接入] 等待${intervalMinutes}分钟`);
      const end = Date.now() + intervalMinutes * 60000;
      while (!abortSignal.aborted && Date.now() < end) {
        await new Promise((r) => setTimeout(r, Math.min(200, end - Date.now())));
      }
    }
    round += 1;
  }

  if (abortSignal.aborted || status.lastReason === 'cancelled') {
    for (const t of trackers) if (!t.isDone()) t.cancel();
    status.lastReason = 'cancelled';
  }

  const allSuccess = trackers.every((t) => t.isSuccess());
  // AUTO-CONT-1 关机口径（纠正 SD1）：关机资格唯一来源 = 全部店铺 NORMAL_COMPLETE
  // （可靠列表耗尽：hitZeroOrder 0单页 或 exhausted 走完整份列表且无遗留）。
  // NO_PROGRESS 不再具备关机资格——无进展不证明耗尽（runId=prodmusgfw9o896b 实证：
  // 分析器状态未持久化导致的假无进展在第2轮就停机，20个商品即止）。
  // 取消(CANCELLED)、失败(FAILED)、安全上限未完成(INCOMPLETE)、仍在跑、状态不可信 → 不关机。
  // 保留：运行结束时读取最新关机设置（getAutoShutdownRequested），运行中取消立即生效。
  const normalEndCount = trackers.filter((t) => t.isSuccess()).length;
  const allNormalEnd = normalEndCount === trackers.length;
  const allDone = trackers.every((t) => t.isDone());
  const pendingRetriesTotal = trackers.reduce((a, t) => a + t.pendingRetries.size, 0);
  const shutdownAllowed = allDone && allNormalEnd && pendingRetriesTotal === 0 && stateFileOk;
  let currentAutoShutdown = autoShutdown === true;
  if (typeof getAutoShutdownRequested === 'function') {
    try { currentAutoShutdown = getAutoShutdownRequested() === true; }
    catch (e) {
      currentAutoShutdown = false;
      logFn('[生产接入] 关机阻止: 无法读取当前自动关机设置');
    }
  }
  const shouldAutoShutdown = currentAutoShutdown && shutdownAllowed;

  logFn(`[生产接入] 关机判定: 勾选自动关机=${currentAutoShutdown} 店铺结束=${trackers.filter((t) => t.isDone()).length}/${shops.length} 可靠耗尽完成(NORMAL_COMPLETE)=${normalEndCount}/${shops.length} 待重试商品=${pendingRetriesTotal} 状态文件可信=${stateFileOk} → ${shouldAutoShutdown ? '允许关机' : '不关机'}`);
  if (currentAutoShutdown && !shouldAutoShutdown) {
    if (!allDone) {
      logFn('[生产接入] 关机阻止: 仍有店铺未结束（用户取消或流程被中断）');
    }
    for (let i = 0; i < trackers.length; i++) {
      const t = trackers[i];
      if (!t.isSuccess() || t.pendingRetries.size > 0) {
        const why = t.state === STATE.NO_PROGRESS
          ? '无进展停止不证明耗尽，不具备关机资格（AUTO-CONT-1）'
          : (t.stopReason || '无停止原因记录');
        logFn(`[生产接入] 关机阻止: ${shops[i].shopName} 终态=${t.state} 待重试=${t.pendingRetries.size}（${why}）`);
      }
    }
    if (!stateFileOk) logFn('[生产接入] 关机阻止: 状态文件不可信，禁止关机');
  }
  try { if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile); } catch (e) {}

  status.finishedAt = new Date().toISOString();
  status.allSuccess = allSuccess;
  status.shouldAutoShutdown = shouldAutoShutdown;
  if (shouldAutoShutdown) {
    try { shutdownFn(); } catch (e) { logFn(`[生产接入] shutdownFn错误: ${e.message}`); }
  }

  return {
    success: true,
    runId,
    stateFileOk,
    allSuccess,
    allNormalEnd,
    shutdownAllowed,
    shouldAutoShutdown,
    lastReason: status.lastReason,
    trackers: trackers.map((t) => ({
      state: t.state, round: t.round, reason: t.stopReason, pendingRetries: t.pendingRetries.size,
    })),
    status,
  };
}

/** 单次分析：独立 runId，不跨轮共享（界面「店铺商品分析」） */
function newSingleRunId() {
  return `single${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
}

module.exports = {
  runProductionAutoSchedule,
  newSingleRunId,
  STATE,
};
