'use strict';
// The only deletion coordinator. No scheduler, batch operation or ROI/create path.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { previewCleanup, shanghaiDate, dayNumber } = require('./cleanup-preview');

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function candidateFingerprint(candidate) {
  return digest([candidate.accountId, candidate.account, candidate.businessDate, candidate.intervalDays,
    candidate.statisticsStart, candidate.statisticsEnd, candidate.planId, candidate.planName,
    candidate.nameDate, candidate.ageDays, candidate.costCents, candidate.overallOrderCount, candidate.thresholdCny]);
}

function createManualCleanup(options) {
  const { account, accountId, ledgerDir, read, performDelete } = options;
  if (!account || !accountId || !ledgerDir || typeof read !== 'function' || typeof performDelete !== 'function') throw new Error('人工清理装配参数不完整');
  const now = options.now || Date.now;
  const getConfig = options.getConfig || (() => ({}));
  const previewTtlMs = options.previewTtlMs || 300000;
  const operationTimeoutMs = options.operationTimeoutMs || 180000;
  const readTimeoutMs = options.readTimeoutMs || 180000;
  const maxSnapshotAgeMs = options.maxSnapshotAgeMs || 60000;
  const tokens = new Map();
  let latest = null, busy = false, activeController = null;
  const accountKey = digest(String(accountId)).slice(0, 24);
  const today = () => shanghaiDate(new Date(now()));
  const dayFile = day => path.join(ledgerDir, accountKey + '-' + day + '.json');

  function daily(day = today()) {
    try {
      const record = JSON.parse(fs.readFileSync(dayFile(day), 'utf8'));
      if (record.accountId !== String(accountId) || record.businessDate !== day || !record.attemptId) throw new Error('日记录身份不一致');
      return { available: false, scope: '单店单日', limit: 1, day, record };
    } catch (error) {
      if (error.code === 'ENOENT') return { available: true, scope: '单店单日', limit: 1, day, record: null };
      return { available: false, scope: '单店单日', limit: 1, day, record: null, error: '日记录损坏/不可读取，阻止重复提交，需人工核实' };
    }
  }
  function enabled() { return getConfig().enabled === true; }
  function view() {
    const quota = daily();
    const fresh = latest && latest.businessDate === today() && now() < Date.parse(latest.expiresAt);
    return { account, accountId: String(accountId), businessDate: today(), busy, enabled: enabled(),
      automaticDeletionEnabled: false, recovery: { known: false, text: '平台删除是否可恢复尚未核实，可能永久失去计划/数据；必须逐条确认风险' },
      daily: quota, preview: fresh ? latest : null,
      canConfirm: !!(fresh && latest.candidate && latest.token && enabled() && quota.available && !busy),
      reason: !enabled() ? (getConfig().blockedReason || '人工删除开关未启用；当前仅代码/预览交付') : !quota.available ? '本店今日已占用一次提交机会或记录待核实' : !fresh ? '请只读刷新今日候选' : null };
  }
  function checkSnapshot(response, days) {
    if (!response || String(response.identity?.accountId || '') !== String(accountId)) throw new Error('账号身份回读不匹配');
    const snapshot = response.snapshot;
    if (!snapshot || snapshot.account !== account) throw new Error('快照店铺不匹配');
    const capture = Date.parse(snapshot.collectedAt);
    if (!Number.isFinite(capture) || capture > now() + 5000 || now() - capture > maxSnapshotAgeMs) throw new Error('快照过期或采集时间无效');
    // 用户统一规则：30/15 两窗口均以整体消耗达到 30.00 元（>=3000 整数分）且整体成交订单数=0 为合格候选，无独立 15 天阈值。
    const threshold = '30.00';
    const report = previewCleanup(snapshot, { asOfDate: today(), intervalDays: days,
      zeroOrderSpendCny: threshold, includeRoiReference: false });
    if (report.sourceProblems.length) throw new Error(report.sourceProblems.join('；'));
    if (dayNumber(snapshot.statisticsEnd) !== dayNumber(today()) - 1) throw new Error('统计截止日不是上海昨天，请重新采集实际最近区间');
    return report;
  }
  async function collect(days, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) throw new Error('提交前复核已取消');
    signal?.addEventListener('abort', abort, { once: true });
    let timer;
    const response = await Promise.race([
      Promise.resolve().then(() => read({ account, accountId: String(accountId), days, signal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('只读采集超时，请重新刷新')); }, readTimeoutMs); controller.signal.addEventListener('abort', () => reject(new Error('只读采集已取消或超时')), { once: true }); }),
    ]).finally(() => { clearTimeout(timer); signal?.removeEventListener('abort', abort); controller.abort(); });
    return { response, report: checkSnapshot(response, days) };
  }
  async function evaluate(signal) {
    const initialDay = today();
    const thirty = await collect(30, signal);
    let chosen = thirty, fallback = null;
    if (!thirty.report.candidates.length) { fallback = await collect(15, signal); chosen = fallback; }
    if (today() !== initialDay) throw new Error('读取过程中已跨上海日期，请重新获取候选');
    if (fallback && fallback.report.evidence.statisticsEnd !== thirty.report.evidence.statisticsEnd) throw new Error('30/15天统计截止日不同，不能作为当前递进筛选');
    const row = chosen.report.candidates[0] || null;
    const candidate = row && { ...row, account, accountId: String(accountId), businessDate: initialDay,
      intervalDays: chosen.report.intervalDays, statisticsStart: chosen.report.evidence.statisticsStart,
      statisticsEnd: chosen.report.evidence.statisticsEnd, collectedAt: chosen.report.evidence.collectedAt,
      thresholdCny: chosen.report.zeroOrderSpendCny };
    if (candidate) candidate.fingerprint = candidateFingerprint(candidate);
    return { businessDate: initialDay, candidate, intervalDays: chosen.report.intervalDays,
      thirtyDay: { rows: thirty.report.rows, evidence: thirty.report.evidence, candidateCount: thirty.report.candidates.length },
      fifteenDay: fallback ? { rows: fallback.report.rows, evidence: fallback.report.evidence,
        candidateCount: fallback.report.candidates.length } : null,
      status: candidate ? 'awaiting_manual_confirmation' : 'no_candidate_stop',
      reason: candidate ? '30天优先；只有30天无合格候选才查真实最近15天。两窗口统一：仅零成交、满7天、整体消耗≥30元；同组标题早优先，再消耗降序，再稳定ID，最多1条' : '不按1单/2单继续删，不缩为7天；两窗口统一30元门槛，均无合格候选即停止'};
  }
  async function preview() {
    if (busy) return { ok: false, reason: '正在处理本店请求，请等待' };
    busy = true;
    try {
      const result = await evaluate();
      for (const entry of tokens.values()) if (entry.status === 'pending') entry.status = 'replaced';
      const token = result.candidate ? crypto.randomBytes(32).toString('hex') : null;
      latest = { ...result, token, issuedAt: new Date(now()).toISOString(), expiresAt: new Date(now() + previewTtlMs).toISOString() };
      if (token) tokens.set(token, { status: 'pending', preview: latest, result: null });
      // Finished responses are bounded; pending tokens are replaced on every refresh.
      while (tokens.size > 100) tokens.delete(tokens.keys().next().value);
      return { ok: true, ...latest };
    } catch (error) { latest = null; return { ok: false, reason: error.message }; }
    finally { busy = false; }
  }
  function cancel(token) {
    const entry = tokens.get(token);
    if (!entry || !['pending', 'revalidating'].includes(entry.status)) return { ok: false, reason: '预览已取消/过期或已提交；不能撤销已发出的请求' };
    if (entry.status === 'revalidating') activeController?.abort();
    entry.status = 'cancelled'; if (latest?.token === token) latest = null;
    return { ok: true, status: 'cancelled', submitted: false };
  }
  function reserve(candidate, token) {
    fs.mkdirSync(ledgerDir, { recursive: true });
    const record = { account, accountId: String(accountId), businessDate: candidate.businessDate, planId: candidate.planId,
      planName: candidate.planName, attemptId: digest(token), status: 'reserved', createdAt: new Date(now()).toISOString(),
      scope: '单店单日，最多1次外部删除提交；失败/未知不自动重试', evidence: candidate };
    const fd = fs.openSync(dayFile(candidate.businessDate), 'wx');
    try { fs.writeFileSync(fd, JSON.stringify(record, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    return record;
  }
  function saveRecord(record) {
    const fd = fs.openSync(dayFile(record.businessDate), 'r+');
    try { fs.ftruncateSync(fd); fs.writeFileSync(fd, JSON.stringify(record, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  async function confirm(body) {
    const entry = body && tokens.get(body.token);
    if (!entry) return { ok: false, reason: '未知或已过期的预览，请只读刷新' };
    if (entry.result) return { ...entry.result, idempotent: true };
    if (entry.status !== 'pending' || busy) return { ok: false, reason: '请求已取消/替换/提交中，不重复提交' };
    const expected = entry.preview.candidate;
    if (body.planId !== expected.planId || body.typedPlanId !== expected.planId || body.confirmDelete !== true || body.riskAcknowledged !== true) {
      return { ok: false, reason: '必须确认这一账号的精确单计划ID，并明确承认删除恢复性未知风险' };
    }
    if (!enabled()) return { ok: false, reason: '人工删除开关未启用' };
    if (today() !== entry.preview.businessDate || now() >= Date.parse(entry.preview.expiresAt)) { entry.status = 'expired'; return { ok: false, reason: '已跨日或预览过期，请重新获取' }; }
    if (!daily().available) return { ok: false, reason: '本店今日已占用1次提交机会，禁止另一条或重试' };
    busy = true; entry.status = 'revalidating';
    let record = null, timer = null;
    const controller = new AbortController();
    activeController = controller;
    try {
      const fresh = await evaluate(controller.signal);
      if (!fresh.candidate || fresh.candidate.fingerprint !== expected.fingerprint) throw new Error('提交前刷新结果已变化：身份/候选/指标/标题/区间任一不同，请重新预览确认');
      const guard = () => {
        if (controller.signal.aborted || entry.status === 'cancelled' || today() !== expected.businessDate || now() >= Date.parse(entry.preview.expiresAt) || !enabled()) throw new Error('取消、超时、跨日、预览过期或开关关闭，停止派发');
      };
      guard();
      record = reserve(fresh.candidate, body.token); // Exclusive on disk, before any external call.
      entry.status = 'submitting';
      const external = Promise.resolve().then(() => performDelete({ candidate: fresh.candidate, signal: controller.signal, guard }));
      const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('删除请求超过有界等待，结果未知，不自动重试')); }, operationTimeoutMs); });
      const result = await Promise.race([external, timeout]);
      record.status = result?.confirmedDeleted === true ? 'confirmed_deleted' : 'unknown';
      record.finishedAt = new Date(now()).toISOString(); record.result = result || { reason: '执行器未返回可信结果' };
      saveRecord(record);
      entry.result = { ok: record.status === 'confirmed_deleted', status: record.status,
        submitted: true, planId: expected.planId, reason: record.status === 'unknown' ? '请求结果未确认；保留今日占用，禁止自动重试' : '单计划删除已回读确认', daily: daily() };
    } catch (error) {
      if (record) {
        record.status = 'unknown'; record.finishedAt = new Date(now()).toISOString(); record.error = error.message;
        try { saveRecord(record); } catch (_) { /* Reserved file remains or fails closed if corrupted. */ }
      }
      entry.result = { ok: false, status: record ? 'unknown' : 'not_submitted', submitted: !!record,
        reason: error.code === 'EEXIST' ? '另一个请求/进程已占用本店今日名额' : error.message, daily: daily() };
    } finally { if (timer) clearTimeout(timer); controller.abort(); activeController = null; entry.status = 'finished'; busy = false; }
    return entry.result;
  }
  return { state: view, preview, cancel, confirm };
}
module.exports = { createManualCleanup, candidateFingerprint };
