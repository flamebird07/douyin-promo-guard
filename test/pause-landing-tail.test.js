'use strict';

/**
 * 落地回读"尾段"与同会话单次重试的衔接（2026-10-18 定点修复）。
 *
 * 现场（reference/diagnosis.json，瑾漂亮潮流服饰 2026-10-18 08:11–08:13）：
 *  - 商品自选 49 条首批批量暂停后仍全部开启（平台首次提交未落地）；
 *  - 落地回读 5 次，单次含页面刷新约 20–23s，120s 预算在第 6 次读取中途到期；
 *  - 旧尾段固定 min(max(3000*4,5000),15000)=12s，远小于这次读取剩余耗时 →
 *    判"在途读取未落定" → 最新状态未知 → 禁用同会话重试 → 批次 1 confirmed / 49 unknown。
 *
 * 修复后的契约（本文件逐条断言）：
 *  1) 尾段预算按**本次已观测到的单次读取耗时**延长，旧 12s 保留为下限，30s 为严格上限；
 *  2) 只有这一次**已发出**的读取落定且快照完整，才用最新快照继续既有"一次"同会话重试；
 *  3) 仍在途 / 读取失败 / 记录不全 / 停止 / 跨日 / 身份变化 / 权限取消 → 仍未知、零重发；
 *  4) 任何时刻读取并发峰值 ≤1（绝不为了赶时间另开并发读），且总耗时有界。
 *
 * 全部为纯 Node 离线测试：mock 控制器 + 内存状态 + 真实短定时器（缩放后的时间尺度），
 * 不 require Playwright、不启动任何浏览器、不触网、不读写 Cookie/生产配置、不操作真实广告。
 * 生产默认仍是真实时间与真实配置（见 computeLandingTailMs 的默认参数）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { executeChengfangPause, computeLandingTailMs } = require('../src/engine/chengfang-executor');
const { shanghaiMs } = require('../src/lib/time');

// 现场尺度 120s / 20–23s 按约 1:10 缩放：预算 1200ms、单次读取 400ms、间隔 50ms。
// 缩放只影响等待时长，不改变"单次读取跨过截止时间"这一结构性条件。
const POLL = { readbackTimeoutMs: 1200, readbackIntervalMs: 50 };
// 尾段注入（仅测试）：base 100 < 本次在途读取剩余 ≈150ms < 观测读取 400+40=440ms，
// 用于证明"落定靠的是按观测耗时延长，而不是固定 base"。
const TAIL = { tailBaseMs: 100, tailMarginMs: 40, tailCapMs: 600 };
const READ_COST_MS = 400;
const NOW_MS = shanghaiMs('2026-10-18', '12:00');
const BUSINESS_DATE = '2026-10-18';
const SHOP = { id: 'shop-offline', name: 'shop-offline', accountId: 'acct-offline' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const zxId = (i) => `zx-${String(i).padStart(3, '0')}`;

// ── 生产默认尾段预算（纯函数，不等待） ──────────────────────────────

test('尾段预算：生产默认 120s/3s 配置下，22s 单次读取 → 24s（旧固定 12s 必然抢跑），严格封顶 30s', () => {
  // 旧公式：min(max(3000*4,5000),15000) = 12000 —— 正是 10-18 现场使用的 12s
  assert.strictEqual(computeLandingTailMs({ intervalMs: 3000, observedMaxReadMs: 0 }), 12000);
  // 观测到单次读取 22s → 12s 不够，按 22s + 2s margin = 24s
  assert.strictEqual(computeLandingTailMs({ intervalMs: 3000, observedMaxReadMs: 22000 }), 24000);
  assert.ok(computeLandingTailMs({ intervalMs: 3000, observedMaxReadMs: 22000 }) > 22000, '必须覆盖一次完整读取');
  // 严格上限：读取再慢也不会无限放大（120s 全局预算不变，尾段最多 30s）
  assert.strictEqual(computeLandingTailMs({ intervalMs: 3000, observedMaxReadMs: 60000 }), 30000);
  assert.strictEqual(computeLandingTailMs({ intervalMs: 3000, observedMaxReadMs: 900000 }), 30000);
  // 读取很快 → 维持旧下限，不改变原有节奏
  assert.strictEqual(computeLandingTailMs({ intervalMs: 2000, observedMaxReadMs: 100 }), 8000);
  assert.strictEqual(computeLandingTailMs({}), 12000);
  // 非法输入不产生 NaN/负值
  assert.strictEqual(computeLandingTailMs({ intervalMs: -5, observedMaxReadMs: -1 }), 12000);
});

// ── mock 控制器：内存状态 + 可控读取耗时/结果 ───────────────────────

function buildHarness(opts = {}) {
  const count = opts.zixuanCount === undefined ? 49 : opts.zixuanCount;
  const st = {
    tab: '全店托管',
    tuoguan: [{ id: 'tg-1', switchChecked: true }],
    zixuan: Array.from({ length: count }, (_, i) => ({ id: zxId(i), switchChecked: true })),
    hidden: new Set(),          // 回读里"行消失"的目标（状态未知）
    selected: [],
    batchClicks: [],            // { ids, expectedCount }
    rowClicks: 0,
    phase: 'idle',              // idle → landing（首批已点、未落地）→ precheck → retry
    identityOk: true,
    beforeDispatch: null,
    precheckApplied: false,
    reads: { total: 0, zixuan: 0, afterClick: 0, live: 0, peak: 0 },
  };
  let nowMs = NOW_MS;
  let stopped = false;

  const setChecked = (id, checked) => {
    const row = st.zixuan.find((r) => r.id === id) || st.tuoguan.find((r) => r.id === id);
    if (row) row.switchChecked = checked;
  };
  const rowsOf = (tab) => (tab === '全店托管' ? st.tuoguan : st.zixuan);
  const snapshot = (tab) => {
    const rows = rowsOf(tab)
      .filter((r) => !st.hidden.has(r.id))
      .map((r) => ({ id: r.id, switchChecked: r.switchChecked }));
    return {
      rows: { rows },
      pagination: { total: rows.length, pageSize: '100条/页', hasNext: false, activePage: 1 },
    };
  };

  const readView = async ({ tab }) => {
    st.reads.total += 1;
    st.reads.live += 1;
    if (st.reads.live > st.reads.peak) st.reads.peak = st.reads.live;
    try {
      if (tab !== '商品自选') {
        await sleep(2);
        return snapshot(tab);
      }
      st.reads.zixuan += 1;
      if (st.phase === 'landing') {
        // 首批点击后的落地回读：每次都是"含页面刷新的慢读取"
        st.reads.afterClick += 1;
        const plan = (opts.landingRead && opts.landingRead(st.reads.afterClick, st)) || { kind: 'slow' };
        if (plan.kind === 'never') return await new Promise(() => {});   // 不可取消、永不落定
        if (plan.kind === 'delay') {
          await sleep(plan.ms);
          if (plan.reject) throw new Error(plan.reject);
        } else {
          await sleep(READ_COST_MS);
        }
        if (plan.mutate) plan.mutate(st);
        return snapshot(tab);
      }
      await sleep(2);
      if (st.phase === 'precheck' && !st.precheckApplied && opts.onPrecheckRead) {
        st.precheckApplied = true;
        opts.onPrecheckRead(st);
      }
      return snapshot(tab);
    } finally {
      st.reads.live -= 1;
    }
  };

  const controller = {
    verifyIdentity: async () => (st.identityOk ? { ok: true, pageAccountId: 'acct-offline' } : { ok: false, reason: '页面账户不一致' }),
    switchView: async ({ tab }) => { st.tab = tab; return { ok: true }; },
    refreshView: async () => {},
    readView,
    detectDanger: async () => [],
    ensureFirstPage: async () => {},
    switchPageSize: async () => {},
    clickNextPage: async () => ({ clicked: false, atEnd: true }),
    selectAllInPage: async () => { st.selected = rowsOf(st.tab).map((r) => r.id); },
    readSelection: async () => ({ selectedIds: st.selected.slice() }),
    readBatchBar: async () => ({ selectedCount: st.selected.length }),
    setRowCheckbox: async ({ planId, checked }) => {
      st.selected = checked
        ? [...new Set([...st.selected, planId])]
        : st.selected.filter((id) => id !== planId);
      return { ok: true };
    },
    setBeforeDispatch: (fn) => { st.beforeDispatch = fn; },
    clickRowSwitch: async ({ planId, page: pg }) => {
      if (st.beforeDispatch) await st.beforeDispatch({ page: pg });
      st.rowClicks += 1;
      setChecked(planId, false);
      return { ok: true };
    },
    clickBatchPause: async ({ expectedCount, page: pg }) => {
      // 与真实控制器一致：派发前执行最终门槛/身份复核（失败则零点击）
      if (st.beforeDispatch) await st.beforeDispatch({ page: pg });
      st.batchClicks.push({ ids: st.selected.slice(), expectedCount });
      if (st.phase === 'idle') {
        // 千川实机限制：首次批量暂停"确认成功但不落地"（noop）
        st.phase = 'landing';
        if (opts.afterFirstClick) opts.afterFirstClick(st);
      } else if (st.phase === 'precheck') {
        st.phase = 'retry';
        for (const id of st.selected) setChecked(id, false);   // 同会话重试这一次真正落地
      }
      return { ok: true };
    },
  };

  const config = {
    execution: { realMode: true, dryRun: false, ...POLL },
    monitor: { chengfang: { pauseEnabled: true } },
  };

  const audits = [];
  const audit = (e) => {
    audits.push(e);
    // 尾段已用最新完整快照落定 → 进入"重试前复核"相位（下一次商品自选读取即 prepareRetry 的读取）
    if (e.event === 'landing-final-read' && e.view === '商品自选' && e.ok) {
      st.phase = 'precheck';
      if (opts.onTailSettled) opts.onTailSettled(st, e);
    }
  };

  st.setNow = (ms) => { nowMs = ms; };
  st.setStop = () => { stopped = true; };
  st.setPauseEnabled = (v) => { config.monitor.chengfang.pauseEnabled = v; };

  return {
    st,
    audits,
    controller,
    config,
    page: { url: () => 'https://qianchuan.jinritemai.com/uni-prom/overall' },
    audit,
    now: () => nowMs,
    stopRequested: () => stopped,
  };
}

async function runPause(opts = {}) {
  const h = buildHarness(opts);
  const t0 = Date.now();
  const result = await executeChengfangPause({
    controller: h.controller,
    page: h.page,
    shopCfg: SHOP,
    config: h.config,
    businessDate: opts.businessDate === undefined ? BUSINESS_DATE : opts.businessDate,
    now: h.now,
    audit: h.audit,
    stopRequested: h.stopRequested,
    landingTiming: TAIL,
  });
  return { ...h, result, elapsedMs: Date.now() - t0 };
}

// ── 1. 主场景：首批 noop + 单次读取跨 deadline 但在尾段内落定 ─────────

test('主场景：首批 noop、在途读取跨过 120s 截止但在尾段内落定 → 只对仍开启目标同会话重发一次 → 完整清单全部 off', { timeout: 20000 }, async () => {
  const h = await runPause();

  // 尾段：用"观测到的单次读取耗时 + margin"落定，而不是固定 base（100ms 不够）
  const tailAudit = h.audits.find((e) => e.event === 'landing-final-read' && e.view === '商品自选');
  assert.ok(tailAudit, '必须记录尾段等待事件');
  assert.strictEqual(tailAudit.ok, true, `尾段应落定：${tailAudit.reason}`);
  assert.strictEqual(tailAudit.mode, 'awaited-inflight');
  assert.ok(tailAudit.observedMaxReadMs >= READ_COST_MS - 20, `观测单次读取耗时应接近 ${READ_COST_MS}ms，实际 ${tailAudit.observedMaxReadMs}`);
  assert.ok(tailAudit.settleWaitMs >= tailAudit.observedMaxReadMs + TAIL.tailMarginMs, `尾段应 ≥ 观测耗时+margin，实际 ${tailAudit.settleWaitMs}`);
  assert.ok(tailAudit.settleWaitMs > TAIL.tailBaseMs, '固定 base 不足以覆盖这次在途读取（证明延长来自观测耗时）');
  assert.ok(tailAudit.settleWaitMs <= TAIL.tailCapMs, '尾段严格封顶');

  // 只重发一次，且只对仍开启的目标
  assert.strictEqual(h.st.batchClicks.length, 2, '首批 + 同会话重试一次（不得更多）');
  assert.strictEqual(h.st.batchClicks[0].ids.length, 49);
  assert.strictEqual(h.st.batchClicks[1].ids.length, 49, '尾段快照显示 49 条仍开启 → 只对这 49 条重发');
  const retryAudit = h.audits.find((e) => e.event === 'retry' && e.view === '商品自选');
  assert.strictEqual(retryAudit.attempt, 2);
  assert.strictEqual(retryAudit.targets.length, 49);

  // 完整当前清单全部关闭
  assert.strictEqual(h.result.allPausedConfirmed, true, h.result.confirmReason);
  assert.strictEqual(h.result.views.zixuan.confirmedCount, 49);
  assert.strictEqual(h.result.views.tuoguan.confirmedCount, 1);
  assert.deepStrictEqual(h.result.finalVerify.stillOpen, []);
  assert.deepStrictEqual(h.result.finalVerify.missing, []);
  assert.ok(h.st.zixuan.every((r) => r.switchChecked === false));
  assert.strictEqual(h.st.rowClicks, 1, '全店托管只点一次（切换动作不得重复）');

  // 并发与总时长
  assert.strictEqual(h.st.reads.peak, 1, '读取并发峰值必须 ≤1');
  assert.ok(h.elapsedMs < 6000, `总耗时必须严格有界，实际 ${h.elapsedMs}ms`);
});

// ── 2. 中途已落地：只对仍开启的目标重发，已 off 的排除 ───────────────

test('中途已落地：尾段快照显示 20 条已 off → 重试只针对仍开启的 29 条（已 off 的不重复点击）', { timeout: 20000 }, async () => {
  const h = await runPause({
    landingRead: (n) => (n === 2
      ? { kind: 'slow', mutate: (s) => { for (let i = 0; i < 20; i += 1) s.zixuan[i].switchChecked = false; } }
      : { kind: 'slow' }),
  });

  assert.strictEqual(h.st.batchClicks.length, 2);
  const retryIds = h.st.batchClicks[1].ids;
  assert.strictEqual(retryIds.length, 29, `只对仍开启的 29 条重发，实际 ${retryIds.length}`);
  for (let i = 0; i < 20; i += 1) {
    assert.ok(!retryIds.includes(zxId(i)), `已 off 的 ${zxId(i)} 不得出现在重试目标里`);
  }
  assert.strictEqual(h.result.views.zixuan.confirmedCount, 49);
  assert.strictEqual(h.result.allPausedConfirmed, true, h.result.confirmReason);
  assert.strictEqual(h.st.reads.peak, 1);
});

// ── 3. 重试前复核发现已落地：跳过，不重复点击 ───────────────────────

test('重试前重新核验：10 条已落地 → 记入已确认并跳过，只重发剩余 39 条', { timeout: 20000 }, async () => {
  const h = await runPause({
    onPrecheckRead: (s) => { for (let i = 0; i < 10; i += 1) s.zixuan[i].switchChecked = false; },
  });

  const pre = h.audits.find((e) => e.event === 'retry-precheck');
  assert.ok(pre, '必须有重试前复核事件');
  assert.strictEqual(pre.landed.length, 10, '已落地的 10 条必须被识别');
  assert.strictEqual(pre.stillPending.length, 39);

  assert.strictEqual(h.st.batchClicks.length, 2);
  assert.strictEqual(h.st.batchClicks[1].ids.length, 39);
  for (let i = 0; i < 10; i += 1) {
    assert.ok(!h.st.batchClicks[1].ids.includes(zxId(i)), '已落地目标不得重发');
  }
  assert.strictEqual(h.result.allPausedConfirmed, true, h.result.confirmReason);
  assert.strictEqual(h.st.reads.peak, 1);
});

// ── 4. 真正卡死且不可取消：尾段到期仍未知，零重发 ───────────────────

test('读取卡死且不可取消：尾段到期 → 仍判未知、零重发、不再新起读取（并发峰值 1）', { timeout: 20000 }, async () => {
  const h = await runPause({
    landingRead: (n) => (n >= 2 ? { kind: 'never' } : { kind: 'slow' }),
  });

  const tailAudit = h.audits.find((e) => e.event === 'landing-final-read' && e.view === '商品自选');
  assert.ok(tailAudit, '必须记录尾段事件');
  assert.strictEqual(tailAudit.ok, false);
  assert.match(tailAudit.reason, /未在 \d+ms 内落定/);
  assert.ok(tailAudit.settleWaitMs <= TAIL.tailCapMs, '尾段必须严格封顶');

  assert.strictEqual(h.st.batchClicks.length, 1, '未知状态下绝不重发');
  assert.strictEqual(h.st.reads.afterClick, 2, '尾段期间/之后不得另起并发读取（只等那一次在途读取）');
  assert.strictEqual(h.st.reads.peak, 1);
  assert.strictEqual(h.result.allPausedConfirmed, false);
  assert.match(h.result.confirmReason, /在途读取|最新状态未知/);
  assert.ok(h.elapsedMs < 6000, `总耗时有界，实际 ${h.elapsedMs}ms`);
});

// ── 5. 尾段读取失败：不得据旧快照重发 ───────────────────────────────

test('尾段读取失败：最后一次读取失败 → 最新状态未知，零重发', { timeout: 20000 }, async () => {
  const h = await runPause({
    landingRead: (n) => (n >= 3 ? { kind: 'delay', ms: 150, reject: '强制新扫描回读失败' } : { kind: 'slow' }),
  });

  const summary = h.result.polling['商品自选'];
  assert.strictEqual(h.st.batchClicks.length, 1, '读取失败不得重发');
  assert.strictEqual(h.result.allPausedConfirmed, false);
  assert.strictEqual(summary.lastReadFailed, true, '必须如实登记最后一次读取失败');
  assert.strictEqual(summary.valueStale, true, '旧快照必须标记为不可信');
  assert.strictEqual(h.st.reads.peak, 1);
});

// ── 6. 目标行消失（记录不全）：未知，零重发 ─────────────────────────

test('尾段快照缺目标行（记录不全）：notFound → 状态未知，零重发', { timeout: 20000 }, async () => {
  const h = await runPause({
    landingRead: (n) => (n >= 3
      ? { kind: 'delay', ms: 150, mutate: (s) => { s.hidden.add(zxId(0)); s.hidden.add(zxId(1)); } }
      : { kind: 'slow' }),
  });

  assert.strictEqual(h.st.batchClicks.length, 1, '行消失（状态未知）不得重发');
  assert.strictEqual(h.result.notFoundIds.length, 2, `应记录 2 个失踪目标，实际 ${h.result.notFoundIds.length}`);
  assert.match(h.result.confirmReason, /行消失|状态未知|不盲目重发/);
  assert.strictEqual(h.result.allPausedConfirmed, false);
});

// ── 7. 身份变化：重试前复核不通过，零重发 ───────────────────────────

test('尾段落定后身份变化：重试前身份复核不通过 → 零重发', { timeout: 20000 }, async () => {
  const h = await runPause({ onTailSettled: (s) => { s.identityOk = false; } });

  assert.strictEqual(h.st.batchClicks.length, 1);
  assert.match(h.result.confirmReason, /身份复核不通过/);
  assert.strictEqual(h.result.allPausedConfirmed, false);
});

// ── 8. 停止信号：仅完成已发请求的只读确认，零重发 ───────────────────

test('落地确认期间收到停止：不再重试、不再发新请求，如实记录已派发请求', { timeout: 20000 }, async () => {
  const h = await runPause({
    afterFirstClick: (s) => { setTimeout(() => s.setStop(), 200); },
  });

  assert.strictEqual(h.st.batchClicks.length, 1, '停止后绝不重发');
  assert.ok(h.st.reads.afterClick >= 2, '停止后仍对已派发请求做有限只读确认');
  assert.ok(h.result.stoppedAfterDispatch, '必须如实记录停止后已派发请求的只读确认');
  assert.strictEqual(h.result.stoppedAfterDispatch.view, '商品自选');
  assert.strictEqual(h.result.allPausedConfirmed, false);
  assert.strictEqual(h.st.reads.peak, 1);
});

// ── 9. 跨日：重试前门槛复核不通过，零重发 ───────────────────────────

test('尾段落定后跨日：重试前门槛复核不通过 → 零重发', { timeout: 20000 }, async () => {
  const h = await runPause({
    onTailSettled: (s) => { s.setNow(NOW_MS + 24 * 3600 * 1000); },
  });

  assert.strictEqual(h.st.batchClicks.length, 1, '跨日不得重发');
  assert.match(h.result.confirmReason, /跨日/);
  assert.strictEqual(h.result.allPausedConfirmed, false);
});

// ── 10. 权限取消：重试前门槛复核不通过，零重发 ──────────────────────

test('尾段落定后关闭暂停许可：重试前门槛复核不通过 → 零重发', { timeout: 20000 }, async () => {
  const h = await runPause({
    onTailSettled: (s) => { s.setPauseEnabled(false); },
  });

  assert.strictEqual(h.st.batchClicks.length, 1, '权限取消不得重发');
  assert.match(h.result.confirmReason, /pauseEnabled/);
  assert.strictEqual(h.result.allPausedConfirmed, false);
});
