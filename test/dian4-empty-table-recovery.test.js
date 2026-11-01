'use strict';

/**
 * DIAN-4 阶段一：空表（商品自选第 1 页 0 行但分页 total=1）机读码只读恢复（2026-10-22）。
 *
 * 独立审查边界（必须逐条锁死）：
 *  - 生产者输出**专用机读码**，只在「商品自选 / 第 1 页 / rows=0 / 整数 total=1 / 页码明确 /
 *    末页证据 hasNext=false 明确 / 身份已核验 / 刷新已明确 / 关闭已证明 / dispatched=0」全部成立时存在；
 *  - 动作仍以 partial 收口，码只**桥接**到既有只读有限恢复链，绝不再次调用 executor、绝不点击开关；
 *  - 消费端只认结构化码的严格相等：展示用组合文本里残留的码不得续链（最新原因判链）；
 *  - 任一负例形态不得入链；成功即清 timer/旧错误；转 Auth 立即停链且 timer=0。
 *
 * 不访问浏览器/CDP/网络/真实 Cookie；timer 全部注入 fake clock。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor.js');
const { AuthError } = require('../src/lib/errors.js');
const { makeTempDir, makeCfgResult } = require('./helpers.js');
const {
  EMPTY_TABLE_CODE, evidenceCode, isEmptyTableCode,
} = require('../src/lib/empty-inventory-evidence.js');
const { executeChengfangPause } = require('../src/engine/chengfang-executor.js');

const TAB_MAIN = '全店托管';
const TAB_SUB = '商品自选';
const SHOP_A = { id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true };

/** 完整合格证据（读侧与动作侧共用形态；closeProven/dispatched 由收口方补齐）。 */
function goodEvidence(over = {}) {
  return Object.assign({
    tab: TAB_SUB, pageNo: 1, activePage: '1', rows: [],
    pagination: { total: 1, hasNext: false },
    identityOk: true, refreshOk: true,
  }, over);
}
function withProof(ev, over = {}) {
  return evidenceCode(Object.assign({ closeProven: true, dispatched: 0 }, ev, over));
}

function makeClock(startMs = Date.parse('2026-10-22T16:00:00Z')) {
  let now = startMs;
  let seq = 0;
  const timers = new Map();
  const flush = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return {
    nowFn: () => now,
    setTimeoutFn(fn, ms) {
      const id = ++seq;
      timers.set(id, { id, at: now + Math.max(0, Number(ms) || 0), fn });
      return { id, unref() {} };
    },
    clearTimeoutFn(h) { if (h && h.id != null) timers.delete(h.id); },
    pending() { return Array.from(timers.values()); },
    async advance(ms) {
      now += Math.max(0, Number(ms) || 0);
      for (let guard = 0; guard < 300; guard += 1) {
        const due = Array.from(timers.values()).filter((t) => t.at <= now).sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers.delete(due.id);
        due.fn();
        await flush();
      }
      await flush();
    },
  };
}

/**
 * 假 opener/controller：按 session 序号编排每个 tab 的分页页组。
 * 页对象：{rows, total, hasNext, activePage?, pageSize?}；activePage 缺省=不返回该字段。
 * closeFails=true → 会话关闭抛错（关闭未证明）。authFrom=N → 第 N 个 session 起身份失败。
 */
function makeFactory(opts = {}) {
  const sessions = opts.sessions || [];
  const calls = { opener: 0, readView: 0, close: 0, adClicks: 0, refresh: 0 };
  const opener = async (args) => {
    calls.opener += 1;
    const idx = calls.opener - 1;
    const scripted = sessions[idx] || sessions[sessions.length - 1] || {};
    if (scripted.authThrow) throw new AuthError('登录失效：持续命中登录页地址或可见登录控件，请重新扫码登录');
    const byTab = scripted.views || {};
    const perTab = {};
    const browser = { closed: false };
    const page = { browser: () => browser, evaluate: async () => null, url: () => 'https://qianchuan.jinritemai.com/ad/manager' };
    const controller = {
      async verifyIdentity() {
        if (browser.closed) throw new Error('closed');
        return { ok: true, pageShopId: args.shopCfg.id, pageShopName: args.shopCfg.id };
      },
      async refreshView({ tab }) {
        calls.refresh += 1;
        if (browser.closed) throw new Error('closed');
        const t = byTab[tab];
        if (t && t.refreshed === false) return { refreshed: false, reason: '未刷新' };
        return { refreshed: true };
      },
      async switchView() { if (browser.closed) throw new Error('closed'); },
      async readView({ tab }) {
        if (browser.closed) throw new Error('Target page/context has been closed');
        calls.readView += 1;
        const t = byTab[tab];
        const pages = (t && t.pages) || [{ rows: [], total: 0, hasNext: false }];
        const i = Math.min(perTab[tab] || 0, pages.length - 1);
        perTab[tab] = (perTab[tab] || 0) + 1;
        const p = pages[i];
        const pagination = { total: p.total, hasNext: p.hasNext, pageSize: p.pageSize || '100条/页' };
        if ('activePage' in p) pagination.activePage = p.activePage;
        return { rows: { rows: p.rows.map((r) => ({ ...r })) }, pagination };
      },
      async clickNextPage() { return { clicked: true }; },
      async clickRowSwitch() { calls.adClicks += 1; return {}; },
      async clickBatchPause() { calls.adClicks += 1; return {}; },
      async clickBatchEnable() { calls.adClicks += 1; return {}; },
      async setBeforeDispatch() {},
    };
    browser.close = async () => {
      calls.close += 1;
      if (opts.closeFails) throw new Error('关闭失败：browser 无响应');
      browser.closed = true;
    };
    return { browser, page, controller };
  };
  return { opener, calls };
}

function emptyTotal1(pages) {
  return {
    [TAB_MAIN]: { pages: pages && pages.main ? pages.main : [{ rows: [], total: 0, hasNext: false, activePage: '1' }] },
    [TAB_SUB]: { pages: pages && pages.sub ? pages.sub : [{ rows: [], total: 1, hasNext: false, activePage: '1' }] },
  };
}
function healthyViews() {
  return {
    [TAB_MAIN]: { pages: [{ rows: [{ id: 'm-1', switchChecked: true }], total: 1, hasNext: false, activePage: '1' }] },
    [TAB_SUB]: { pages: [{ rows: [], total: 0, hasNext: false, activePage: '1' }] },
  };
}

function buildMonitor({ dataDir, clock, opener }) {
  const cfgResult = makeCfgResult({
    shops: [{ ...SHOP_A }],
    monitor: {
      chengfang: {
        scope: [TAB_MAIN, TAB_SUB],
        adStateReadTimeoutMs: 3000,
        adStateCloseWaitMs: 30,
        adStateSettleWaitMs: 30,
      },
    },
  });
  return new Monitor(cfgResult, null, {
    dataDir,
    chengfangOpener: opener,
    nowFn: clock.nowFn,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
}

function auditEvents(dataDir, kind = 'ad-state-read') {
  const p = path.join(dataDir, 'audit.jsonl');
  return fs.existsSync(p)
    ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((j) => j.kind === kind)
    : [];
}

// ── E 组：机读码判定矩阵（正例 + 全部负例） ─────────────────────────

test('E1 机读码：完整正证据才成立，缺任一项或类型不符一律不成立', () => {
  assert.equal(withProof(goodEvidence()), EMPTY_TABLE_CODE);

  const negatives = {
    全店托管同形态: goodEvidence({ tab: TAB_MAIN }),
    第二页: goodEvidence({ pageNo: 2 }),
    第二页activePage: goodEvidence({ activePage: '2' }),
    页码缺失: (() => { const e = goodEvidence(); delete e.activePage; return e; })(),
    页码为0: goodEvidence({ activePage: 0 }),
    页码文本非数字: goodEvidence({ activePage: '第一页' }),
    已有行: goodEvidence({ rows: [{ id: 'x', switchChecked: true }] }),
    total缺失: (() => { const e = goodEvidence(); delete e.pagination.total; return e; })(),
    total为null: goodEvidence({ pagination: { total: null, hasNext: false } }),
    total字符串1: goodEvidence({ pagination: { total: '1', hasNext: false } }),
    total为0有效空态: goodEvidence({ pagination: { total: 0, hasNext: false } }),
    total为2: goodEvidence({ pagination: { total: 2, hasNext: false } }),
    total负数: goodEvidence({ pagination: { total: -1, hasNext: false } }),
    total小数: goodEvidence({ pagination: { total: 1.5, hasNext: false } }),
    hasNext缺失: (() => { const e = goodEvidence(); delete e.pagination.hasNext; return e; })(),
    hasNext为null: goodEvidence({ pagination: { total: 1, hasNext: null } }),
    hasNext为true: goodEvidence({ pagination: { total: 1, hasNext: true } }),
    hasNext为字符串false: goodEvidence({ pagination: { total: 1, hasNext: 'false' } }),
    身份未核验: goodEvidence({ identityOk: false }),
    身份缺失: (() => { const e = goodEvidence(); delete e.identityOk; return e; })(),
    刷新未成功: goodEvidence({ refreshOk: false }),
    刷新缺失: (() => { const e = goodEvidence(); delete e.refreshOk; return e; })(),
    关闭未证明: withProof(goodEvidence(), { closeProven: false }),
    关闭缺失: (() => { const e = withProof(goodEvidence()); return e; })(),
  };
  for (const [label, ev] of Object.entries(negatives)) {
    if (label === '关闭缺失') {
      assert.equal(evidenceCode(goodEvidence()), null, 'closeProven/dispatched 缺失不得默认成立');
      continue;
    }
    assert.equal(withProof(ev), null, `负例必须不成立：${label}`);
  }
  assert.equal(withProof(goodEvidence(), { dispatched: 1 }), null, '已派发一律不成立');
  assert.equal(withProof(goodEvidence(), { dispatched: null }), null, '派发数未知一律不成立');
  assert.equal(withProof(goodEvidence(), { dispatched: '0' }), null, '派发数字符串不成立');
  assert.equal(evidenceCode(null), null);
  assert.equal(evidenceCode({}), null);
});

test('E2 消费端只认严格相等：组合展示文本里残留的码不得点亮白名单', () => {
  assert.equal(isEmptyTableCode(EMPTY_TABLE_CODE), true);
  assert.equal(isEmptyTableCode(null), false);
  assert.equal(isEmptyTableCode(undefined), false);
  assert.equal(isEmptyTableCode(''), false);
  assert.equal(isEmptyTableCode(EMPTY_TABLE_CODE + ' 尾巴'), false);
  assert.equal(isEmptyTableCode(`首次回读失败（${EMPTY_TABLE_CODE}）；已重试1次仍未恢复：乘方「全店托管」刷新失败`), false);
});

// ── R 组：读侧生产者与有界只读恢复 ─────────────────────────────────

test('R1 读侧精确码：铸码 + 同轮恰好一次只读重读，重读成功即清受阻且不建链', async () => {
  const dataDir = makeTempDir('etr-r1-');
  const clock = makeClock();
  const fake = makeFactory({ sessions: [{ views: emptyTotal1() }, { views: healthyViews() }] });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'on', JSON.stringify(r.error || {}));
  assert.equal(fake.calls.opener, 2, '首次 + 同轮唯一一次只读重读');
  assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, '重读成功不得建恢复链');
  assert.equal(clock.pending().length, 0, '成功必须无悬挂 timer');
  assert.equal(mon._runtime(SHOP_A.id).lastReadError, null, '成功必须清除旧受阻错误');
  assert.equal(fake.calls.adClicks, 0, '全程零广告点击');

  const ev = auditEvents(dataDir).filter((j) => j.event === 'empty-table-evidence');
  assert.equal(ev.length, 1, '首次精确码必须留一条铸码审计');
  assert.equal(ev[0].code, EMPTY_TABLE_CODE);
  assert.equal(ev[0].tab, TAB_SUB);
  assert.equal(ev[0].total, 1);
  assert.equal(ev[0].hasNext, false);
  assert.equal(ev[0].identityOk, true);
  assert.equal(ev[0].refreshOk, true);
  assert.ok(auditEvents(dataDir).some((j) => j.event === 'retry'), '同轮重读必须有 retry 审计');
});

test('R2 持续精确码：建既有有限恢复链（组 2 次、上限 10），中途成功即清 timer 与错误', async () => {
  const dataDir = makeTempDir('etr-r2-');
  const clock = makeClock();
  const fake = makeFactory({ sessions: [
    { views: emptyTotal1() }, { views: emptyTotal1() }, { views: emptyTotal1() }, { views: emptyTotal1() },
    { views: healthyViews() },
  ] });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown', '清单必需继续 unknown，不得当作无计划');
  assert.match(r.error.reason, /无行但缺少空态证据/);
  assert.match(r.error.reason, /已启动有限恢复/);
  assert.equal(r.error.emptyTableCode, EMPTY_TABLE_CODE, '机读码只作为结构化字段随错误对象传递');
  assert.ok(!String(r.error.reason).includes(EMPTY_TABLE_CODE), '机读码不得进入展示文本');
  const sched = auditEvents(dataDir).filter((j) => j.event === 'recovery-scheduled');
  assert.equal(sched.length, 1);
  assert.equal(sched[0].maxRetries, 10);
  assert.equal(sched[0].groupSize, 2);
  const rec = mon._readRecoveries.get(SHOP_A.id);
  assert.ok(rec, '必须已登记按店恢复链');
  assert.equal(rec.attempts, 1, '与既有链一致：首次读取不计，同轮唯一重读计为 1');
  assert.equal(clock.pending().length, 1, '链上只保留一个 timer');
  assert.equal(clock.pending()[0].at, clock.nowFn(), '组内第 2 次立即，不白等 5 分钟');

  await clock.advance(0);
  assert.equal(mon._readRecoveries.get(SHOP_A.id).attempts, 2, '组内第二读计入');
  assert.equal(mon._readRecoveries.get(SHOP_A.id) !== undefined, true, '组内未成功前链仍在');
  await clock.advance(300000);
  await clock.advance(300000);
  assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, '恢复读取成功必须清链');
  assert.equal(clock.pending().length, 0, '成功必须清 timer');
  assert.equal(mon._runtime(SHOP_A.id).lastReadError, null);
  assert.equal(fake.calls.adClicks, 0, '只读恢复绝不点击开关');
  assert.ok(auditEvents(dataDir).some((j) => j.event === 'recovery-success'));
});

test('R3 读侧负例：total=0 有效空态 / 有行不构成空表 / 字符串 total / 缺 activePage → 不铸码不建链', async () => {
  const ok0 = { [TAB_MAIN]: { pages: [{ rows: [], total: 0, hasNext: false, activePage: '1' }] }, [TAB_SUB]: { pages: [{ rows: [], total: 0, hasNext: false, activePage: '1' }] } };
  const cases = [
    ['total=0 是有效空态', ok0, ok0, true],
    ['total=1 且有行：不进空表分支', { [TAB_MAIN]: { pages: [{ rows: [], total: 0, hasNext: false, activePage: '1' }] }, [TAB_SUB]: { pages: [{ rows: [{ id: 's1', switchChecked: true }], total: 1, hasNext: false, activePage: '1' }] } }, null, true],
    ['字符串 total=1', { [TAB_MAIN]: { pages: [{ rows: [], total: 0, hasNext: false, activePage: '1' }] }, [TAB_SUB]: { pages: [{ rows: [], total: '1', hasNext: false, activePage: '1' }] } }, null, false],
    ['缺 activePage', { [TAB_MAIN]: { pages: [{ rows: [], total: 0, hasNext: false, activePage: '1' }] }, [TAB_SUB]: { pages: [{ rows: [], total: 1, hasNext: false }] } }, null, false],
  ];
  for (const [label, views, session2, expectSuccess] of cases) {
    const dataDir = makeTempDir('etr-r3-');
    const clock = makeClock();
    const fake = makeFactory({ sessions: [{ views }, { views: session2 || views }] });
    const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
    const r = await mon._readCurrentAdState(SHOP_A);
    const codes = auditEvents(dataDir).filter((j) => j.event === 'empty-table-evidence');
    assert.equal(codes.length, 0, `${label}：不得铸码`);
    assert.equal(r.error && r.error.emptyTableCode, undefined, `${label}：不得带机读码`);
    if (expectSuccess) {
      assert.equal(r.error, undefined, `${label}：是确定读取结果，不应报错`);
      assert.equal(fake.calls.opener, 1, `${label}：不得重读`);
    } else {
      assert.match(String((r.error && r.error.reason) || ''), /无行但缺少空态证据/, `${label}：应如实 blocked`);
      assert.equal(r.state, 'unknown', `${label}：必须保持 unknown`);
    }
    assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, `${label}：不得建恢复链`);
    assert.equal(clock.pending().length, 0, `${label}：无悬挂 timer`);
    assert.equal(fake.calls.adClicks, 0, `${label}：零点击`);
  }
});

test('R4 托管侧同形态不铸码；hasNext=null 保持既有分页语义（不回退旧契约）', async () => {
  const dataDir = makeTempDir('etr-r4-');
  const clock = makeClock();
  const views = {
    [TAB_MAIN]: { pages: [{ rows: [], total: 1, hasNext: false, activePage: '1' }] },
    [TAB_SUB]: { pages: [{ rows: [], total: 0, hasNext: false, activePage: '1' }] },
  };
  const fake = makeFactory({ sessions: [{ views }, { views }] });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.match(r.error.reason, /全店托管/);
  assert.equal(auditEvents(dataDir).filter((j) => j.event === 'empty-table-evidence').length, 0, '托管视图不得铸商品自选码');
  assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, '托管同形态不入本链');

  const d2 = makeTempDir('etr-r4b-');
  const c2 = makeClock();
  const hasNextNull = {
    [TAB_MAIN]: { pages: [{ rows: [], total: 0, hasNext: false, activePage: '1' }] },
    [TAB_SUB]: { pages: [{ rows: [], total: 1, hasNext: null, activePage: '1' }] },
  };
  const f2 = makeFactory({ sessions: [{ views: hasNextNull }, { views: hasNextNull }] });
  const mon2 = buildMonitor({ dataDir: d2, clock: c2, opener: f2.opener });
  const r2 = await mon2._readCurrentAdState(SHOP_A);
  assert.match(r2.error.reason, /无行但缺少空态证据/, '空行仍先按空态证据不足收口（既有语义不变）');
  assert.equal(r2.error.emptyTableCode, undefined, 'hasNext 不明确不得带机读码');
  assert.equal(auditEvents(d2).filter((j) => j.event === 'empty-table-evidence').length, 0, 'hasNext 不明确必须不铸码');
  assert.equal(c2.pending().length, 0, 'hasNext 不明确的空行不得建链');

  // 有行 + hasNext=null：必须仍是既有精确分页契约原因（严格相等白名单未被本次改动回退）
  const d3 = makeTempDir('etr-r4c-');
  const c3 = makeClock();
  const rowsNull = {
    [TAB_MAIN]: { pages: [{ rows: [], total: 0, hasNext: false, activePage: '1' }] },
    [TAB_SUB]: { pages: [{ rows: [{ id: 's1', switchChecked: true }], total: 1, hasNext: null, activePage: '1' }] },
  };
  const f3 = makeFactory({ sessions: [{ views: rowsNull }, { views: rowsNull }] });
  const mon3 = buildMonitor({ dataDir: d3, clock: c3, opener: f3.opener });
  const r3 = await mon3._readCurrentAdState(SHOP_A);
  assert.ok(String(r3.error.reason).includes('第 1 页 hasNext=null：分页结束标记不明确，清单不完整'),
    'hasNext=null 的既有原因文本一字不改');
  assert.equal(r3.error.emptyTableCode, undefined, '有行不构成空表码');
});

test('R5 关闭未证明：保持阻断、不铸码、不建链（且不改写为可重读）', async () => {
  const dataDir = makeTempDir('etr-r5-');
  const clock = makeClock();
  const fake = makeFactory({ closeFails: true, sessions: [{ views: emptyTotal1() }] });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown');
  assert.match(r.error.reason, /严格关闭证明|保持阻断/);
  assert.equal(auditEvents(dataDir).filter((j) => j.event === 'empty-table-evidence').length, 0, '关闭未证明不得铸码');
  assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, '关闭未证明不得建链');
  // 收口门（2026-10-23）：唯一的 timer 必须是 1s 的有界**收口探测**（仅关闭/核验，不读取）。
  assert.equal(clock.pending().length, 1, '只允许门自身的有界收口探测 timer');
  assert.equal(clock.pending()[0].at, clock.nowFn() + 1000, '收口探测第一次为 1s');
  assert.equal(fake.calls.opener, 1, '收口探测不得新开 opener');
  assert.equal(fake.calls.adClicks, 0);
});

test('R6 最新原因判链：首次精确码、第二次转 Auth 立即停链且 timer=0，组合文本不得续链', async () => {
  const dataDir = makeTempDir('etr-r6-');
  const clock = makeClock();
  const fake = makeFactory({ sessions: [{ views: emptyTotal1() }, { authThrow: true }] });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown');
  const rec = mon._readRecoveries.get(SHOP_A.id);
  if (rec) await clock.advance(0);
  await clock.advance(300000);
  await clock.advance(300000);
  const stopped = auditEvents(dataDir).filter((j) => j.event === 'recovery-stopped');
  const sched = auditEvents(dataDir).filter((j) => j.event === 'recovery-scheduled');
  assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, '转 Auth 后链必须已停止/清除');
  assert.equal(clock.pending().length, 0, '停链必须清 timer');
  assert.equal(fake.calls.adClicks, 0);
  assert.ok(sched.length <= 1, '同店不得叠加多条链');
  if (stopped.length) assert.match(String(stopped[stopped.length - 1].reason), /登录失效|身份|Auth/i);
  assert.equal(mon._isTransientReadError({
    status: 'blocked', blocked: 'inventory',
    reason: `首次回读失败（乘方「商品自选」无行但缺少空态证据（分页 total=1））；已重试1次仍未恢复：登录失效：${EMPTY_TABLE_CODE}`,
  }), false, '组合文本里的残留码绝不重新点亮白名单');
  assert.equal(mon._isTransientReadError({
    status: 'blocked', blocked: 'inventory', reason: `乘方「商品自选」无行但缺少空态证据（分页 total=1） ${EMPTY_TABLE_CODE}`,
  }), false, '无结构化码字段时，仅在 reason 里出现码文本也不放行');
});

// ── B 组：动作侧证据与只读桥接 ─────────────────────────────────────

function executorController(script) {
  const state = { clickLog: [], reads: 0 };
  const controller = {
    async verifyIdentity({ shopCfg }) { return { ok: true, pageShopId: shopCfg.id, pageShopName: shopCfg.name }; },
    async switchView() {},
    async switchPageSize() {},
    async readView({ tab }) {
      readsInc();
      const p = (script[tab] || []);
      const i = (state['i:' + tab] || 0);
      state['i:' + tab] = i + 1;
      const page = p[Math.min(i, p.length - 1)] || { rows: [], total: 0, hasNext: false, activePage: '1' };
      return { rows: { rows: page.rows.map((r) => ({ ...r })) }, pagination: Object.assign({ pageSize: '100条/页' }, page) };
    },
    async clickNextPage() { return { clicked: true }; },
    async clickRowSwitch() { state.clickLog.push('row'); return {}; },
    async clickBatchPause() { state.clickLog.push('batch-pause'); return {}; },
    async clickBatchEnable() { state.clickLog.push('batch-enable'); return {}; },
    setBeforeDispatch() {},
  };
  function readsInc() { state.reads += 1; }
  return { controller, state };
}

const EXEC_CFG = { execution: { realMode: true, dryRun: false }, monitor: { chengfang: { pauseEnabled: true, enableEnabled: true } } };
const PAGE = { url: () => 'https://qianchuan.jinritemai.com/ad/manager', evaluate: async () => null, browser: () => ({ isConnected: () => true }) };

async function runPauseZixuanEmpty(script) {
  const { controller, state } = executorController(script);
  const result = await executeChengfangPause({
    controller, page: PAGE,
    shopCfg: { id: 'shop-a', name: 'shop-a', accountId: '1710' },
    config: EXEC_CFG, dryRun: false,
    now: () => Date.parse('2026-10-22T16:00:00Z'),
    businessDate: '2026-10-22',
    audit: () => {},
  });
  return { result, state };
}

test('B1 动作侧：空表仍以 read_failed/partial 收口，只附结构化证据，零点击', async () => {
  const { result, state } = await runPauseZixuanEmpty({
    [TAB_MAIN]: [{ rows: [], total: 0, hasNext: false, activePage: '1' }],
    [TAB_SUB]: [{ rows: [], total: 1, hasNext: false, activePage: '1' }],
  });
  assert.equal(result.views.zixuan.status, 'read_failed', '空表不得当作无计划');
  assert.equal(result.allPausedConfirmed, false);
  assert.equal(state.clickLog.length, 0, '零开关点击');
  const ev = result.views.zixuan.emptyTableEvidence;
  assert.deepEqual(ev, {
    tab: TAB_SUB, pageNo: 1, activePage: '1', rows: [],
    pagination: { total: 1, hasNext: false },
    identityOk: true, refreshOk: true,
  });
  assert.equal(withProof(ev), EMPTY_TABLE_CODE, '收口方补齐关闭/零派发后应成立');
  assert.equal(withProof(ev, { dispatched: 1 }), null, '一旦本批次有派发即不成立');
  assert.match(result.views.zixuan.reason, /不当作无计划/, '人类原因保持原样');
});

test('B2 动作侧负例：total=0 有效空态 / hasNext 不明确 / 托管侧同形态 → 不附证据', async () => {
  const ok0 = await runPauseZixuanEmpty({
    [TAB_MAIN]: [{ rows: [], total: 0, hasNext: false, activePage: '1' }],
    [TAB_SUB]: [{ rows: [], total: 0, hasNext: false, activePage: '1' }],
  });
  assert.equal(ok0.result.views.zixuan.emptyTableEvidence, undefined, 'total=0 是有效空态，不得附空表证据');
  assert.equal(ok0.state.clickLog.length, 0);

  const nullNext = await runPauseZixuanEmpty({
    [TAB_MAIN]: [{ rows: [], total: 0, hasNext: false, activePage: '1' }],
    [TAB_SUB]: [{ rows: [], total: 1, hasNext: null, activePage: '1' }],
  });
  const nev = nullNext.result.views.zixuan.emptyTableEvidence;
  assert.ok(nev, '证据照常记录');
  assert.equal(withProof(nev), null, 'hasNext 不明确必须不铸码');

  const mainTab = await runPauseZixuanEmpty({
    [TAB_MAIN]: [{ rows: [], total: 1, hasNext: false, activePage: '1' }],
    [TAB_SUB]: [{ rows: [], total: 0, hasNext: false, activePage: '1' }],
  });
  assert.equal(mainTab.result.views.tuoguan.status, 'read_failed');
  assert.equal(mainTab.result.views.tuoguan.emptyTableEvidence, undefined, '托管侧不产出商品自选码证据');
});

function batchWith(over = {}) {
  return Object.assign({
    outcome: 'partial',
    reason: '商品自选无行但缺少数量的空态证据（分页 total=1），不当作无计划',
    counts: { confirmed: 0, failed: 0, unknown: 0, skipped: 0, cancelled: 0 },
    executor: {
      confirmReason: '商品自选无行但缺少数量的空态证据（分页 total=1），不当作无计划',
      views: { zixuan: { status: 'read_failed', reason: '商品自选无行但缺少数量的空态证据（分页 total=1），不当作无计划', emptyTableEvidence: goodEvidence() } },
    },
  }, over);
}

test('B3 桥接正例：partial+零派发精确码 → 只启动既有只读恢复链，outcome/counts 不改写，绝不重跑 executor', async () => {
  const dataDir = makeTempDir('etr-b3-');
  const clock = makeClock();
  const fake = makeFactory({ sessions: [{ views: healthyViews() }] });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
  const before = batchWith();
  const snapshot = JSON.stringify({ outcome: before.outcome, counts: before.counts });

  const view = mon._maybeBridgeEmptyTableReadRecovery(SHOP_A.id, before);
  assert.ok(view && view.active, '桥接必须返回活动恢复视图');
  assert.equal(JSON.stringify({ outcome: before.outcome, counts: before.counts }), snapshot, 'batch 的 outcome/counts 一字不改');
  const rec = mon._readRecoveries.get(SHOP_A.id);
  assert.ok(rec, '必须登记按店有限恢复链');
  assert.equal(rec.attempts, 0);
  assert.equal(fake.calls.opener, 0, '桥接本身不做任何读取，更不重跑 executor');

  await clock.advance(0);
  assert.equal(fake.calls.opener, 1, '链的首个物理读取是只读回读');
  assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, '只读回读成功即清链');
  assert.equal(fake.calls.adClicks, 0, '恢复链零广告点击');
  assert.equal(clock.pending().length, 0, '成功即清 timer');
  const bridge = auditEvents(dataDir).filter((j) => j.event === 'empty-table-bridge');
  assert.equal(bridge.length, 1);
  assert.equal(bridge[0].code, EMPTY_TABLE_CODE);
  assert.equal(bridge[0].dispatched, 0);
  assert.equal(bridge[0].outcome, 'partial');
});

test('B4 桥接负例：已派发/结果未知/非 partial/无证据/未收口读取门/停用店铺一律不入链', async () => {
  const mk = () => {
    const dataDir = makeTempDir('etr-b4-');
    const clock = makeClock();
    const mon = buildMonitor({ dataDir, clock, opener: makeFactory({}).opener });
    return { dataDir, clock, mon };
  };

  const a = mk();
  assert.equal(a.mon._maybeBridgeEmptyTableReadRecovery(SHOP_A.id, batchWith({ counts: { confirmed: 1, failed: 0, unknown: 0 } })), null);
  assert.equal(a.mon._readRecoveries.get(SHOP_A.id), undefined, '已派发不得入链');

  const b = mk();
  assert.equal(b.mon._maybeBridgeEmptyTableReadRecovery(SHOP_A.id, batchWith({ counts: { confirmed: 0, failed: 0, unknown: 1 } })), null);
  assert.equal(b.mon._readRecoveries.get(SHOP_A.id), undefined, '派发结果未知不得入链');

  const c = mk();
  assert.equal(c.mon._maybeBridgeEmptyTableReadRecovery(SHOP_A.id, batchWith({ outcome: 'all_paused_confirmed' })), null);
  assert.equal(c.mon._maybeBridgeEmptyTableReadRecovery(SHOP_A.id, batchWith({ outcome: 'blocked' })), null);
  assert.equal(c.mon._maybeBridgeEmptyTableReadRecovery(SHOP_A.id, batchWith({ outcome: 'ok' })), null);
  assert.equal(c.mon._readRecoveries.get(SHOP_A.id), undefined, '非 partial 不得入链');

  const d = mk();
  const noCounts = batchWith();
  delete noCounts.counts;
  assert.equal(d.mon._maybeBridgeEmptyTableReadRecovery(SHOP_A.id, noCounts), null, '派发计数不可判定不得入链');
  assert.equal(d.mon._readRecoveries.get(SHOP_A.id), undefined);

  const e = mk();
  const missing = batchWith();
  delete missing.executor.views.zixuan.emptyTableEvidence;
  assert.equal(e.mon._maybeBridgeEmptyTableReadRecovery(SHOP_A.id, missing), null, '无结构化证据不得入链');
  assert.equal(e.mon._readRecoveries.get(SHOP_A.id), undefined);

  const f = mk();
  const badShape = batchWith({ counts: { confirmed: 0, failed: 0, unknown: 0 } });
  badShape.executor.views.zixuan.emptyTableEvidence = goodEvidence({ pagination: { total: '1', hasNext: false } });
  assert.equal(f.mon._maybeBridgeEmptyTableReadRecovery(SHOP_A.id, badShape), null, '字符串 total 不得入链');

  const g = mk();
  g.mon._setPendingReadGate(SHOP_A.id, { workRec: { settledP: Promise.resolve() }, sessionRef: () => null, closes: [] });
  assert.equal(g.mon._maybeBridgeEmptyTableReadRecovery(SHOP_A.id, batchWith()), null, '存在未收口读取门不得入链');
  g.mon._clearPendingReadGate(SHOP_A.id);

  const h = mk();
  assert.equal(h.mon._maybeBridgeEmptyTableReadRecovery('shop-missing', batchWith()), null, '未知/停用店铺不得入链');
  assert.equal(auditEvents(h.dataDir).filter((j) => j.event === 'empty-table-bridge').length, 0);
});

test('B5 桥接不改写广告状态投影：建链前后 lastReadError/adState 保持', async () => {
  const dataDir = makeTempDir('etr-b5-');
  const clock = makeClock();
  const mon = buildMonitor({ dataDir, clock, opener: makeFactory({}).opener });
  mon._applyObservedAdState(SHOP_A.id, 'on', '测试基线');
  const rt = mon._runtime(SHOP_A.id);
  const before = { kind: 'final', reason: '既有受阻错误' };
  rt.lastReadError = before;
  mon._maybeBridgeEmptyTableReadRecovery(SHOP_A.id, batchWith());
  assert.equal(rt.lastReadError, before, '桥接本身不写 lastReadError');
  assert.equal(rt.lastAdState, 'on', '桥接本身不覆盖本轮已确认状态');
  assert.equal(rt.adStateObserveEvidence, '测试基线', '桥接本身不改写状态证据');
  assert.equal(clock.pending().length, 1, '只登记一个可取消 timer');
  mon._cancelReadRecovery(SHOP_A.id, 'test-cleanup');
  assert.equal(clock.pending().length, 0, '取消必须清 timer');
});
