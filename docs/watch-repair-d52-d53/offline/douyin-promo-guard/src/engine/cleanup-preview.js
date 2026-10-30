'use strict';

// Shared by Node and the offline preview. No browser, monitor or advertising executor.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.CleanupPreview = api;
})(typeof globalThis === 'object' ? globalThis : this, function () {
  const DAY = 86400000;
  const PROTECTION_DAYS = 7;

  function dayNumber(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const stamp = Date.parse(value + 'T00:00:00Z');
    if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) return null;
    return stamp / DAY;
  }

  function shanghaiDate(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(now);
  }

  function titleDate(name) {
    // Match only the title's calendar date; ignore time and supplied nameDate metadata.
    const dates = [...String(name || '').matchAll(/(?:^|[^\d])(\d{4}-\d{2}-\d{2})(?!\d)/g)].map(m => m[1]);
    const unique = [...new Set(dates)];
    if (unique.length !== 1 || dayNumber(unique[0]) === null) return null;
    return unique[0];
  }

  function moneyCents(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const text = String(value);
    if (!/^\d+(?:\.\d{1,2})?$/.test(text)) return null;
    const [whole, fraction = ''] = text.split('.');
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    return Number.isSafeInteger(cents) ? cents : null;
  }

  function roiReference(source, rows, sourceProblems, ratio) {
    const input = Array.isArray(source.sortedRows) ? source.sortedRows : [];
    const problems = sourceProblems.slice();
    if (source.roiTargetLabelVerified !== true) problems.push('页面字段“综合营销ROI目标”尚未核实；不使用实际成交ROI替代');
    if (input.some(r => r && r.account && r.account !== source.account)) problems.push('存在其他账号行，禁止跨账号计算');
    if (rows.some(r => r.overallOrderCount === null)) problems.push('计划订单数不完整，不能确认前70%排序');
    const ranked = rows.slice().sort((a, b) => (b.overallOrderCount ?? -1) - (a.overallOrderCount ?? -1)
      || a.planId.localeCompare(b.planId) || a.sourceIndex - b.sourceIndex);
    const sampleCount = Math.ceil(rows.length * ratio / 100);
    let missingTargetCount = 0;
    const allTargets = ranked.map(row => {
      const raw = input[row.sourceIndex] || {};
      const value = raw.marketingRoiTarget;
      const numeric = (typeof value === 'number' || typeof value === 'string') && /^\d+(?:\.\d+)?$/.test(String(value)) ? Number(value) : NaN;
      const targetRoi = Number.isFinite(numeric) && numeric > 0 ? numeric : null;
      if (targetRoi === null) missingTargetCount++;
      return { planId: row.planId, planName: row.planName, targetRoi, overallOrderCount: row.overallOrderCount,
        targetStatus: targetRoi === null ? '目标ROI缺失/无效（不填0、不移除样本）' : '已提供目标值' };
    });
    const samples = allTargets.slice(0, sampleCount);
    const selectedMissingTargetCount = samples.filter(r => r.targetRoi === null).length;
    if (!sampleCount) problems.push('没有计划，无法计算参考均值');
    if (selectedMissingTargetCount) problems.push('选中样本有' + selectedMissingTargetCount + '条目标ROI缺失/无效，样本不完整');
    const boundaryOrderCount = sampleCount ? samples[sampleCount - 1].overallOrderCount : null;
    const boundaryTieTotal = boundaryOrderCount === null ? 0 : allTargets.filter(r => r.overallOrderCount === boundaryOrderCount).length;
    const boundaryTieSelected = boundaryOrderCount === null ? 0 : samples.filter(r => r.overallOrderCount === boundaryOrderCount).length;
    const referenceComplete = problems.length === 0;
    const arithmeticMean = referenceComplete ? samples.reduce((sum, r) => sum + r.targetRoi / sampleCount, 0) : null;
    return { account: source.account || '', fieldLabel: '综合营销ROI目标', fieldVerified: source.roiTargetLabelVerified === true,
      performanceWindow: { start: source.statisticsStart || '', end: source.statisticsEnd || '', status: '按每账号近30天整体成交订单数排名' },
      denominatorPlanCount: rows.length, topPercent: ratio, sampleCount,
      rounding: '预览默认向上取整：ceil(计划总数×比例)，例如28×70%=20条',
      ordering: '订单数降序；并列按计划ID升序稳定截取，不扩大样本，不代表平台权重',
      boundary: { orderCount: boundaryOrderCount, tiedPlans: boundaryTieTotal, selectedTiedPlans: boundaryTieSelected,
        splitTie: boundaryTieTotal > boundaryTieSelected },
      samples, missingTargetCount, selectedMissingTargetCount, arithmeticMean, referenceComplete, ready: false,
      algorithmStatus: '旧均值直接定目标方案已修订；上调禁用，下调绝对步长1.0（5→4），触发和最低值待定；不设ROI观察或冷却门槛',
      weighting: '选中样本目标ROI简单均值仅为可选基准参考，不是最终创建目标；三条新计划同值',
      adjustmentDraft: { status: 'pending', downStep: 1.0, stepType: 'absolute', upwardEnabled: false,
        primarySignal: 'new_plan_spend', secondarySignal: 'cross_store_mean_spend',
        orderSignalEnabled: false, diagnosisFactors: ['balance'],
        trigger: null, minimumTargetRoi: null, platformMinimumVerified: false },
      problems, creationDraft: { dailyPlanCount: 3, sameTargetForAllThree: true, effectiveTargetRoi: null,
        creationEnabled: false, pending: ['确认下调触发及最低值；上调禁用', '核实平台下限，未核实则阻止ready目标', '核实目标ROI字段并补齐值', '确认商品/预算/模板及创建流程'] } };
  }

  function previewCleanup(snapshot, options = {}) {
    const intervalDays = options.intervalDays === undefined ? 30 : options.intervalDays;
    if (![30, 15].includes(intervalDays)) throw new Error('删除筛选仅支持30天或15天，不自动缩为7天');
    const asOfDate = options.asOfDate === undefined ? shanghaiDate() : options.asOfDate;
    const asOfDay = dayNumber(asOfDate);
    if (asOfDay === null) throw new Error('评估日期必须是有效的 YYYY-MM-DD');
    // Missing threshold never means zero. The UI/CLI explicitly supply the confirmed 30 CNY.
    const threshold = moneyCents(options.zeroOrderSpendCny);
    if (options.zeroOrderSpendCny !== undefined && options.zeroOrderSpendCny !== null && (threshold === null || threshold <= 0)) {
      throw new Error('零单试跑花费上限必须是大于0、最多两位小数的人民币金额');
    }
    const has = value => value !== undefined && value !== null && value !== '';
    const oldAgeDays = has(options.lowSpendOldAgeDays) ? Number(options.lowSpendOldAgeDays) : null;
    const lowSpendMax = has(options.lowSpendMaxCny) ? moneyCents(options.lowSpendMaxCny) : null;
    if (oldAgeDays !== null && (!Number.isSafeInteger(oldAgeDays) || oldAgeDays < PROTECTION_DAYS)) throw new Error('A路老计划阈值须为至少7天的整数');
    if (has(options.lowSpendMaxCny) && lowSpendMax === null) throw new Error('A路低消耗上限须为非负人民币金额，最多两位小数');
    const ratio = options.roiTopPercent === undefined ? 70 : Number(options.roiTopPercent);
    if (!Number.isSafeInteger(ratio) || ratio < 1 || ratio > 100) throw new Error('ROI样本比例须为1至100的整数百分比');
    const source = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const inputRows = Array.isArray(source.sortedRows) ? source.sortedRows : [];
    const start = dayNumber(source.statisticsStart);
    const end = dayNumber(source.statisticsEnd);
    const sourceProblems = [];
    if (source.view !== '商品自选') sourceProblems.push('来源不是商品自选');
    if (source.timezone !== 'Asia/Shanghai' || start === null || end === null || end - start !== intervalDays - 1) sourceProblems.push('统计区间不是上海时区完整' + intervalDays + '个日历日');
    if (end !== null && end >= asOfDay) sourceProblems.push('统计截止日须早于评估日');
    if (source.complete !== true || source.total !== inputRows.length || source.collectedRows !== inputRows.length) sourceProblems.push('分页未确认完整或行数不一致');
    if (source.accountVerified !== true || source.refreshVerified !== true) sourceProblems.push('账户身份或日期刷新尚未核实');
    if (typeof source.account !== 'string' || !source.account.trim()) sourceProblems.push('账户名称缺失');
    if (typeof source.collectedAt !== 'string' || !Number.isFinite(Date.parse(source.collectedAt))) sourceProblems.push('采集时间缺失或无效');
    const ids = inputRows.map(r => r && r.planId);
    if (ids.some(id => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) sourceProblems.push('计划ID缺失或重复');

    const rows = inputRows.map((raw, index) => {
      const r = raw || {};
      const nameDate = titleDate(r.planName);
      const ageDays = nameDate === null ? null : asOfDay - dayNumber(nameDate);
      const costCents = moneyCents(r.overallCost);
      const orders = Number.isSafeInteger(r.overallOrderCount) && r.overallOrderCount >= 0 ? r.overallOrderCount : null;
      const validCost = costCents !== null && Number.isSafeInteger(r.costCents) && costCents === r.costCents;
      let state, reason;
      if (nameDate === null || ageDays < 0) {
        state = 'verify_date'; reason = '标题日期缺失、无效、歧义或在未来：保护，待核实';
      } else if (ageDays < PROTECTION_DAYS) {
        state = 'protected'; reason = '标题日期年龄' + ageDays + '天，未满7天保护';
      } else if (sourceProblems.length || orders === null || !validCost) {
        state = 'verify_data'; reason = sourceProblems.length ? '快照证据待核实：' + sourceProblems.join('；') : '整体订单数或整体消耗缺失/无效/金额不一致';
      } else if (orders > 0) {
        state = 'display_only'; reason = '非零订单仅展示，不判为清理候选';
      } else if (threshold === null) {
        state = 'configuration_pending'; reason = '零单花费阈值待配置，不自动选出候选';
      } else if (costCents < threshold) {
        state = 'observe'; reason = '零单，但整体消耗尚未达到' + (threshold / 100).toFixed(2) + '元，继续观察';
      } else {
        state = 'review_candidate'; reason = '年龄' + ageDays + '天（标题' + nameDate + '，已满7天）｜整体订单0｜整体消耗' + (costCents / 100).toFixed(2) + '元≥' + (threshold / 100).toFixed(2) + '元：同时命中零成交和高消耗，最高优先组，待人工审核';
      }
      let lowSpendState = 'excluded', lowSpendReason = '日期、保护期或数据尚未满足观察条件';
      if (nameDate !== null && ageDays >= PROTECTION_DAYS && !sourceProblems.length && orders !== null && validCost) {
        if (orders > 0) {
          lowSpendState = 'display_only'; lowSpendReason = '有成交仅观察，不因老龄/低消耗成为清理候选';
        } else if (oldAgeDays === null || lowSpendMax === null) {
          lowSpendState = 'thresholds_pending'; lowSpendReason = '老/低阈值待确认，仅作观察排行，不另选候选；低消耗不证明拿不到流量';
        } else if (ageDays >= oldAgeDays && costCents <= lowSpendMax) {
          lowSpendState = 'observe'; lowSpendReason = '命中老/低观察条件，仅观察，不另选候选；主表统一按零成交、高消耗和同组年龄排序';
        } else {
          lowSpendState = 'observe'; lowSpendReason = '未同时达到老计划和低消耗观察阈值，继续展示观察';
        }
      }
      return { planId: r.planId || '', planName: String(r.planName || ''), nameDate, ageDays,
        overallOrderCount: orders, costCents: validCost ? costCents : null,
        overallCost: validCost ? (costCents / 100).toFixed(2) : null, state, reason, lowSpendState, lowSpendReason, sourceIndex: index };
    });
    // Zero orders first. Within the same state/order group: older title date,
    // then spend, then stable ID. Age never promotes observations into candidates.
    rows.sort((a, b) => (a.overallOrderCount ?? Infinity) - (b.overallOrderCount ?? Infinity)
      || Number(b.state === 'review_candidate') - Number(a.state === 'review_candidate')
      || (a.state === b.state && a.ageDays !== null && b.ageDays !== null ? b.ageDays - a.ageDays : 0)
      || (b.costCents ?? -1) - (a.costCents ?? -1)
      || (a.nameDate || '9999').localeCompare(b.nameDate || '9999')
      || a.planId.localeCompare(b.planId) || a.sourceIndex - b.sourceIndex);
    return {
      version: 1, mode: 'readonly_preview', asOfDate, intervalDays, timezone: 'Asia/Shanghai', protectionDays: PROTECTION_DAYS,
      zeroOrderSpendCny: threshold === null ? null : (threshold / 100).toFixed(2),
      ordering: '零成交优先（整体订单数升序）；同为零单时，满7天且消耗达阈值的最高优先候选先展示；同订单数且同状态组标题日期早/年龄大优先，再消耗降序、ID升序。观察项年龄不跨越候选优先组，满7天不自动删除；仅展示排序，不是平台权重',
      evidence: { account: source.account || '', view: source.view || '', statisticsStart: source.statisticsStart || '',
        statisticsEnd: source.statisticsEnd || '', collectedAt: source.collectedAt || '', total: source.total,
        complete: source.complete === true, rawSha256: source.rawSha256 || null,
        freshness: '导入快照，非实时；人工审核前应重新采集核实' },
      sourceProblems, rows, candidates: rows.filter(r => r.state === 'review_candidate'),
      lowSpendOldAgeDays: oldAgeDays, lowSpendMaxCny: lowSpendMax === null ? null : (lowSpendMax / 100).toFixed(2),
      lowSpendOrdering: '标题年龄降序 → 整体消耗升序 → 整体订单数升序 → 计划ID；独立观察，不推断流量因果',
      lowSpendObservations: rows.filter(r => r.lowSpendState !== 'excluded').slice().sort((a, b) => b.ageDays - a.ageDays
        || a.costCents - b.costCents || a.overallOrderCount - b.overallOrderCount || a.planId.localeCompare(b.planId)),
      lowSpendCandidates: [], // Legacy field: observation panel never selects candidates.
      manualReviewLimit: 1,
      roiReference: options.includeRoiReference === false ? undefined : roiReference(source, rows, sourceProblems, ratio),
      realDeletionEnabled: false, automaticDeletionEnabled: false,
    };
  }
  return { previewCleanup, titleDate, dayNumber, moneyCents, shanghaiDate, PROTECTION_DAYS };
});
