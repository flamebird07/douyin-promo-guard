'use strict';
// S5(2026-10-26) — day-start browse reset regression: the user's explicit 2026-10-27
// rule 每天从第一页找未发布商品. A NEW business day must start a fresh browse (page 1,
// first category, empty seen/attempted/lastSelected) while a SAME-DAY load keeps
// every progress fact byte-for-byte, an unresolved previous day still blocks, and
// the global published store / financial plan facts are never touched by the reset.
// Real temp roots only; no production state, no network, no browser, no Cookies.
// Run: node --test day-start-reset.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const wf = require('./plan-workflow.cjs');
const repair = require('./repair-day-start.cjs');
const sched = require('../bill-manager/promo-plan-scheduler.js');

const UNRESOLVED_ACTIVE_STATUSES = [
  'preparing', 'ready-awaiting-confirmation', 'confirmation-consumed',
  'post-publish-enable-check-pending', 'post-publish-enable-stopped',
  'publish-pending', 'publish-finalizing', 'publish-unknown',
  'final-confirm-pending', 'final-confirm-unknown',
];

function tmpRoot(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name + '-'));
  return { dir, stateFile: path.join(dir, 'plan-publisher-state.json'), publishedFile: path.join(dir, 'published.json') };
}

test('cross-day 2026-10-27 rule: page 7 (stopped mid-catalog) resets to page 1 on the new day, same day keeps 7', () => {
  const { dir, stateFile } = tmpRoot('daystart-cross7');
  try {
    // a realistic stopped mid-catalog prior day: deep cursor + seen set + partial day facts
    wf.persistDayState(stateFile, {
      businessDate: '2026-10-26',
      page: 61,
      category: '全部',
      lastSelected: ['3840000000000000022'],
      attempted: ['3840000000000000001'],
      cursor: { category: '全部', page: 61, seenProductIds: ['3840000000000000001', '3840000000000000002'], nativeEof: false },
      hints: { '3840000000000000001': { migrationWarning: true, precheckRisk: false, reviewFailed: false, text: 'x' } },
      plans: [{ planId: '7100000000000011', planNumber: 1, productIds: ['3840000000000000009'] }],
      active: { status: 'preparation-stopped', planNumber: 2, reason: 'prepare-stopped:catalog-exhausted-or-safe-pagination-boundary', lastSelected: 22 },
      confirmationConsumptions: [{ confirmationId: 'conf-day1', manifestHash: 'a'.repeat(64) }],
    });

    // SAME day: exact continuation — nothing may drift
    const same = wf.loadDayState(stateFile, '2026-10-26');
    assert.equal(same.page, 61, '同日必须延续页码');
    assert.equal(same.category, '全部');
    assert.equal(same.cursor.page, 61);
    assert.deepEqual(same.cursor.seenProductIds, ['3840000000000000001', '3840000000000000002']);
    assert.deepEqual(same.lastSelected, ['3840000000000000022']);
    assert.deepEqual(same.attempted, ['3840000000000000001']);
    assert.equal(same.active.status, 'preparation-stopped');
    assert.deepEqual(same.plans.map(p => p.planId), ['7100000000000011'], '同日财务计划 id 事实必须原样保留');

    // NEXT day: fresh browse per the explicit user rule
    const next = wf.loadDayState(stateFile, '2026-10-27');
    assert.equal(next.businessDate, '2026-10-27');
    assert.equal(next.page, 1, '新业务日从第 1 页重新找未发布商品');
    assert.equal(next.category, wf.CATEGORY_TAB_ORDER[0]);
    assert.deepEqual(next.cursor, { category: wf.CATEGORY_TAB_ORDER[0], page: 1, seenProductIds: [] });
    assert.deepEqual(next.lastSelected, []);
    assert.deepEqual(next.attempted, []);
    assert.deepEqual(next.hints, {});
    assert.deepEqual(next.plans, [], '新业务日计划事实清空');
    assert.equal(next.active, null);
    assert.deepEqual(next.confirmationConsumptions, []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('no state file at all => fresh day state at page 1', () => {
  const { dir, stateFile } = tmpRoot('daystart-nofile');
  try {
    assert.equal(fs.existsSync(stateFile), false);
    const fresh = wf.loadDayState(stateFile, '2026-10-27');
    assert.equal(fresh.businessDate, '2026-10-27');
    assert.equal(fresh.page, 1);
    assert.equal(fresh.category, wf.CATEGORY_TAB_ORDER[0]);
    assert.deepEqual(fresh.cursor.seenProductIds, []);
    assert.deepEqual(fresh.attempted, []);
    assert.equal(fresh.active, null);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an old unresolved previous day still blocks the new day before any reset happens', () => {
  const { dir, stateFile } = tmpRoot('daystart-unknownblock');
  try {
    for (const status of UNRESOLVED_ACTIVE_STATUSES) {
      wf.persistDayState(stateFile, {
        businessDate: '2026-10-26',
        page: 9,
        active: { status, planNumber: 1, frozen: { manifestHash: 'f'.repeat(64) } },
      });
      assert.throws(() => wf.loadDayState(stateFile, '2026-10-27'), /pending\/unknown.*recovery/,
        '未决状态 ' + status + ' 不得被新业务日重置绕过');
    }
    // a day-level unknown flag blocks the same way
    wf.persistDayState(stateFile, { businessDate: '2026-10-26', page: 9, unknown: true });
    assert.throws(() => wf.loadDayState(stateFile, '2026-10-27'), /pending\/unknown.*recovery/);
    // pending === true blocks too
    wf.persistDayState(stateFile, { businessDate: '2026-10-26', page: 9, pending: true });
    assert.throws(() => wf.loadDayState(stateFile, '2026-10-27'), /pending\/unknown.*recovery/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('negative: resolved previous-day active statuses do NOT block and reset to a fresh browse', () => {
  const { dir, stateFile } = tmpRoot('daystart-resolved');
  try {
    // resolved (non-unresolved) terminal statuses: the new day may start fresh
    for (const status of ['preparation-stopped', 'published-success', 'publish-failed', 'stopped']) {
      wf.persistDayState(stateFile, {
        businessDate: '2026-10-26',
        page: 22,
        category: '全部',
        active: { status, planNumber: 2, reason: 'prepare-stopped:catalog-exhausted-or-safe-pagination-boundary' },
        plans: [{ planId: '7100000000000011', planNumber: 1, productIds: ['3840000000000000009'] }],
      });
      const next = wf.loadDayState(stateFile, '2026-10-27');
      assert.equal(next.page, 1, status + ' 已解决，新业务日正常从第 1 页开始');
      assert.deepEqual(next.cursor.seenProductIds, []);
      assert.deepEqual(next.plans, []);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('same-day reload preserves the original financial plan ids/manifest facts; the published store bytes never change on a reset', () => {
  const { dir, stateFile, publishedFile } = tmpRoot('daystart-financial');
  try {
    const plan = {
      planId: '7100000000000012', planNumber: 1, status: 'success',
      productIds: ['3840000000000000011', '3840000000000000012'],
      manifestHash: 'b'.repeat(64), runId: 'plan-publisher-2026-10-26-0123456789abcdef',
    };
    const manualFact = { status: 'published-success', source: 'user-authorized-native-ui', planId: '7100000000000013' };
    wf.persistDayState(stateFile, {
      businessDate: '2026-10-26',
      page: 3,
      category: '搜索趋势',
      cursor: { category: '搜索趋势', page: 3, seenProductIds: ['3840000000000000011'] },
      plans: [plan],
      firstPublishedPlan: plan,
      manualUiPublicationFacts: [manualFact],
      confirmationConsumptions: [{ confirmationId: 'conf-fin', manifestHash: plan.manifestHash }],
    });

    // same-day round trip: every financial fact survives a load/persist 往返 exactly
    const same = wf.loadDayState(stateFile, '2026-10-26');
    assert.deepEqual(same.plans, [plan], '同日原始计划 id/manifest 事实逐字保留');
    assert.deepEqual(same.firstPublishedPlan, plan);
    assert.deepEqual(same.manualUiPublicationFacts, [manualFact]);
    assert.deepEqual(same.confirmationConsumptions, [{ confirmationId: 'conf-fin', manifestHash: plan.manifestHash }]);
    wf.persistDayState(stateFile, same);
    const reread = wf.loadDayState(stateFile, '2026-10-26');
    assert.deepEqual(reread.plans, [plan]);

    // the global published book is a separate store: a day reset never touches its bytes
    const published = { publishedIds: ['3840000000000000011'], plans: [{ planId: '7100000000000012', date: '2026-10-26' }] };
    wf.persistPublished(publishedFile, published);
    const before = fs.readFileSync(publishedFile, 'utf8');
    wf.loadDayState(stateFile, '2026-10-27'); // day reset happens
    assert.equal(fs.readFileSync(publishedFile, 'utf8'), before, '跨日重置绝不改写全局 published book 字节');
    const next = wf.loadDayState(stateFile, '2026-10-27');
    assert.deepEqual(next.plans, []);
    // cross-day dedupe is carried ONLY by the published store
    const step = wf.selectFromPage({ selectedIds: [], publishedSet: published.publishedIds, attemptedSet: [], capacity: 30 },
      [{ productId: '3840000000000000011', selectable: true, text: '' }, { productId: '3840000000000000099', selectable: true, text: '' }]);
    assert.deepEqual(step.selectedIds, ['3840000000000000099'], '跨日去重只靠 published store，新日 seen 为空');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ═══════════════════════════════════════════════════════════════════════════
// S5R1 repair-day-start.cjs — controlled CURRENT-day browse-start repair against
// the REAL native surfaces: the REAL Jin ledger shape (entry1 SUCCESS with its
// consumed confirmationId RETAINED as history + entry2 status preparation-stopped),
// the NATIVE closure proof reproveDurablePreparationStoppedClose re-run before AND
// after the cursor reset, and the two NATIVE lock formats (scheduler JSON lock,
// publisher {pid,startedAt,token} lock). Real temp roots only.
// ═══════════════════════════════════════════════════════════════════════════
const shopProfile = require('./shop-profile.cjs');

const SHOP_NAME = 'S5R1修复测试店铺';
const ACCOUNT_ID = '1710242295996424';
const SCHED_RUN_ID = 'plan-scheduler-2026-10-26-0123456789abcdef';
const STOP_REASON = 'prepare-stopped:catalog-exhausted-or-safe-pagination-boundary';
const ZERO_PROOF = {
  initialConsumptions: 0, finalConsumptions: 0, reopenConsumptions: 0,
  manualUnresolved: 0, plansContainsNumber: false, confirmationConsumptionsRecorded: false,
};

function nativeStoppedDay(prefix, mutateState, mutateLedger) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  const paths = shopProfile.shopStatePaths({
    shop: SHOP_NAME, accountId: ACCOUNT_ID, boundAccounts: ['79863866', '9zmao_fushi'],
    productsPerPlan: 30, roi: 15, dailyBudget: 300, commissionIncluded: true, directPay: false, maxPlansPerDay: 3,
  }, dir, {});
  const state = {
    shop: SHOP_NAME, accountId: ACCOUNT_ID, businessDate: '2026-10-26',
    page: 61, category: '全部',
    lastSelected: ['3840000000000000022'], attempted: ['3840000000000000001'],
    cursor: { category: '全部', page: 61, seenProductIds: ['3840000000000000001'], nativeEof: false },
    hints: {},
    plans: [{ planId: '7100000000000011', planNumber: 1, status: 'success', productIds: ['3840000000000000009'], manifestHash: 'a'.repeat(64) }],
    firstPublishedPlan: null,
    confirmationConsumptions: [],
    manualUiPublicationFacts: [],
    preparationClosureFacts: [{
      status: 'preparationClosed', phase: 'preparing', reason: STOP_REASON,
      source: 'read-only-recovery', runId: SCHED_RUN_ID, planNumber: 2, businessDate: '2026-10-26',
      shop: SHOP_NAME, accountId: ACCOUNT_ID, zeroConsumptionProof: ZERO_PROOF, closedAt: '2026-10-26T13:16:00.000Z',
    }],
    active: { status: 'preparation-stopped', planNumber: 2, runId: SCHED_RUN_ID, businessDate: '2026-10-26', reason: STOP_REASON },
  };
  if (mutateState) mutateState(state);
  fs.mkdirSync(path.dirname(paths.stateFile), { recursive: true });
  fs.writeFileSync(path.join(path.dirname(paths.stateFile), 'shop-identity.json'),
    JSON.stringify({ shop: SHOP_NAME, accountId: ACCOUNT_ID }, null, 2));
  fs.writeFileSync(paths.stateFile, JSON.stringify(state, null, 2));
  fs.writeFileSync(paths.attemptsFile, JSON.stringify({ consumed: {}, finalConsumed: {}, reopenConsumed: {} }, null, 2));
  fs.writeFileSync(paths.publishedFile, JSON.stringify({
    publishedIds: ['3840000000000000009'], plans: [{ planId: '7100000000000011', date: '2026-10-26' }],
  }, null, 2));
  // REAL Jin shape: entry1 SUCCESS keeps its consumed confirmationId (retained
  // history, NOT open consumption); entry2 is the resolved preparation-stopped close
  // bound to the CURRENT day state (runId + reason + plan number, no consumption marks).
  const ledger = {
    version: 1,
    days: {
      '2026-10-26': {
        shops: {
          'shop-jin': {
            status: 'unsubmitted', plans: 1, lastAt: '2026-10-26T13:16:00.000Z', error: null,
            entries: {
              1: { planNumber: 1, status: 'success', planId: '7100000000000011', confirmationId: 'conf-1', at: '2026-10-26T13:16:00.000Z' },
              2: {
                planNumber: 2, status: 'preparation-stopped', reason: STOP_REASON,
                preparationRunId: SCHED_RUN_ID, startedAt: '2026-10-26T13:00:00.000Z',
                closedAt: '2026-10-26T13:16:00.000Z', recoveredBy: 'local-preparation-recovery',
              },
            },
          },
        },
      },
    },
  };
  if (mutateLedger) mutateLedger(ledger.days['2026-10-26'].shops['shop-jin']);
  const ledgerFile = path.join(dir, 'ledger.json');
  sched.saveLedger(ledgerFile, ledger);
  return {
    dir, stateFile: paths.stateFile, attemptsFile: paths.attemptsFile,
    publishedFile: paths.publishedFile, stateRoot: dir, ledgerFile,
    backupRoot: path.join(dir, 'backup'), pubLockFile: path.join(dir, 'publisher.lock'),
  };
}

function repairOpts(r, extra) {
  return {
    stateFile: r.stateFile, ledgerFile: r.ledgerFile, publishedFile: r.publishedFile,
    attemptsFile: r.attemptsFile, stateRoot: r.stateRoot, backupRoot: r.backupRoot,
    businessDate: '2026-10-26', shopId: 'shop-jin', shopName: SHOP_NAME, accountId: ACCOUNT_ID,
    expectedStateSha: repair.sha256Hex(fs.readFileSync(r.stateFile)),
    ...(extra || {}),
  };
}

test('repair accepts the REAL Jin shape (prior success with retained consumed CID + resolved next2 close) and re-proves the native closure AFTER the reset', () => {
  const r = nativeStoppedDay('s5r1-repair-real');
  try {
    const stateBefore = fs.readFileSync(r.stateFile);
    const ledgerBefore = fs.readFileSync(r.ledgerFile, 'utf8');
    const bookBefore = fs.readFileSync(r.publishedFile, 'utf8');
    const attemptsBefore = fs.readFileSync(r.attemptsFile, 'utf8');

    const out = repair.planDayStartRepair(repairOpts(r, { publisherLockFile: r.pubLockFile }));
    assert.equal(out.ok, true, out.reason || 'repair should succeed');
    assert.equal(out.stateWrites, 1);
    // the NATIVE proof ran both BEFORE and AFTER the cursor reset and returned fresh source hashes
    assert.match(out.proofSourceHashBefore, /^[0-9a-f]{64}$/);
    assert.match(out.proofSourceHashAfter, /^[0-9a-f]{64}$/);
    assert.notEqual(out.proofSourceHashBefore, out.proofSourceHashAfter, '重置后必须拿到新的 native source hash');

    const after = JSON.parse(fs.readFileSync(r.stateFile, 'utf8'));
    assert.equal(after.page, 1, '浏览起点回第 1 页');
    assert.equal(after.category, wf.CATEGORY_TAB_ORDER[0]);
    assert.deepEqual(after.cursor, { category: wf.CATEGORY_TAB_ORDER[0], page: 1, seenProductIds: [] });
    assert.deepEqual(after.plans, JSON.parse(stateBefore.toString('utf8')).plans, '已成功计划事实逐字保留');
    assert.deepEqual(after.preparationClosureFacts, JSON.parse(stateBefore.toString('utf8')).preparationClosureFacts, '耐久收口事实不得改动');
    assert.deepEqual(after.active, JSON.parse(stateBefore.toString('utf8')).active);
    // ledger (incl. prior consumed CID + closed next2), attempts and published bytes unchanged
    assert.equal(fs.readFileSync(r.ledgerFile, 'utf8'), ledgerBefore, '当日账本字节不得改写');
    assert.equal(fs.readFileSync(r.attemptsFile, 'utf8'), attemptsBefore, 'attempts 字节不得改写');
    assert.equal(fs.readFileSync(r.publishedFile, 'utf8'), bookBefore, 'published book 字节不得改写');
    assert.deepEqual(fs.readFileSync(out.backupFile), stateBefore, '备份必须是修复前的原始字节');
    // both native locks were acquired and cleaned up; no temp residue
    assert.equal(fs.existsSync(r.ledgerFile + '.lock'), false, 'scheduler 锁已释放');
    assert.equal(fs.existsSync(r.pubLockFile), false, 'publisher 锁已释放');
    assert.equal(fs.existsSync(r.stateFile + '.tmp'), false);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test('next2 entry is only allowed as the exact resolved close: in-progress / consumed / frozen / foreign-runId / prior-non-success all refuse with zero writes', () => {
  const cases = [
    ['in-progress', (rec) => { rec.entries[2] = { planNumber: 2, status: 'in-progress', startedAt: '2026-10-26T13:00:00.000Z' }; }, /ledger-next-entry-not-resolved-closed:in-progress/],
    ['consumed', (rec) => { rec.entries[2].confirmationId = 'conf-2'; }, /ledger-next-entry-open-consumption/],
    ['frozen', (rec) => { rec.entries[2].frozen = { manifestHash: 'f'.repeat(64) }; }, /ledger-next-entry-open-consumption/],
    ['unknown', (rec) => { rec.entries[2].status = 'unknown'; }, /ledger-next-entry-not-resolved-closed:unknown/],
    ['foreign-runId', (rec) => { rec.entries[2].preparationRunId = 'plan-scheduler-2026-10-26-deadbeefdeadbeef'; }, /ledger-next-entry-run-id-mismatch/],
    ['reason-drift', (rec) => { rec.entries[2].reason = 'some-other-reason'; }, /ledger-next-entry-reason-mismatch/],
    ['prior-not-success', (rec) => { rec.entries[1].status = 'unknown'; }, /ledger-prior-entry-not-success:1/],
  ];
  for (const [name, mutate, pattern] of cases) {
    const r = nativeStoppedDay('s5r1-next2-' + name, null, mutate);
    try {
      const before = fs.readFileSync(r.stateFile, 'utf8');
      const out = repair.planDayStartRepair(repairOpts(r));
      assert.equal(out.ok, false, name + ' 必须拒绝');
      assert.equal(out.stateWrites, 0, name + ' 零状态写入');
      assert.match(out.reason, pattern);
      assert.equal(fs.readFileSync(r.stateFile, 'utf8'), before, name + ' 状态字节零改动');
    } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
  }
  // prior SUCCESS with its already-consumed confirmationId is legitimate history: NOT rejected
  const ok = nativeStoppedDay('s5r1-prior-cid');
  try {
    const out = repair.planDayStartRepair(repairOpts(ok));
    assert.equal(out.ok, true, out.reason || 'prior consumed CID on a SUCCESS entry is not open consumption');
  } finally { fs.rmSync(ok.dir, { recursive: true, force: true }); }
});

test('any EXISTING native lock file (scheduler JSON or publisher pid/startedAt/token, live or malformed) refuses upfront with zero writes — never a takeover', () => {
  const mk = () => nativeStoppedDay('s5r1-locks');
  // scheduler-native LIVE lock (own pid is definitely alive)
  let r = mk();
  try {
    const before = fs.readFileSync(r.stateFile, 'utf8');
    fs.writeFileSync(r.ledgerFile + '.lock', JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const out = repair.planDayStartRepair(repairOpts(r));
    assert.equal(out.ok, false);
    assert.match(out.reason, /ledger-lock-file-exists-refuse/);
    assert.equal(out.stateWrites, 0);
    assert.equal(fs.readFileSync(r.stateFile, 'utf8'), before);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
  // publisher-native lock format (pid/startedAt/32hex token), live owner
  r = mk();
  try {
    fs.writeFileSync(r.pubLockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), token: 'a'.repeat(32) }));
    const out = repair.planDayStartRepair(repairOpts(r, { publisherLockFile: r.pubLockFile }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /publisher-lock-file-exists-refuse/);
    assert.equal(out.stateWrites, 0);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
  // a malformed/unparsable publisher lock is still an existing owner-shaped file: refuse, never steal
  r = mk();
  try {
    fs.writeFileSync(r.pubLockFile, 'not-json-garbage');
    const out = repair.planDayStartRepair(repairOpts(r, { publisherLockFile: r.pubLockFile }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /publisher-lock-file-exists-refuse/);
    assert.equal(out.stateWrites, 0);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test('CAS mismatch and under-lock state drift refuse with zero writes', () => {
  const r = nativeStoppedDay('s5r1-cas');
  try {
    const badHash = repair.planDayStartRepair(repairOpts(r, { expectedStateSha: '0'.repeat(64) }));
    assert.equal(badHash.ok, false);
    assert.match(badHash.reason, /state-hash-cas-mismatch/);
    assert.equal(badHash.stateWrites, 0);

    const before = fs.readFileSync(r.stateFile, 'utf8');
    const drifted = repair.planDayStartRepair(repairOpts(r, {
      deps: {
        onLocksAcquired() {
          fs.writeFileSync(r.stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(r.stateFile, 'utf8')), page: 99 }, null, 2));
        },
      },
    }));
    assert.equal(drifted.ok, false);
    assert.match(drifted.reason, /state-changed-under-lock-cas-fail/);
    assert.equal(drifted.stateWrites, 0);
    assert.notEqual(fs.readFileSync(r.stateFile, 'utf8'), before, '漂移由测试注入，锁内拒绝后不覆盖并发写');
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test('a failure AFTER the state write rolls the state back to the exact original bytes (no half repair left behind)', () => {
  const r = nativeStoppedDay('s5r1-rollback');
  try {
    const before = fs.readFileSync(r.stateFile);
    const out = repair.planDayStartRepair(repairOpts(r, {
      deps: {
        // simulate a concurrent ledger change landing between the state write and the
        // post-write byte verification: the repair must roll its OWN write back
        onStateWritten() {
          fs.writeFileSync(r.ledgerFile, JSON.stringify({ version: 1, days: {} }, null, 2));
        },
      },
    }));
    assert.equal(out.ok, false);
    assert.match(out.reason, /ledger-drifted-after-repair/);
    assert.equal(out.rolledBack, true);
    assert.deepEqual(fs.readFileSync(r.stateFile), before, '状态必须回滚到修复前字节');
    assert.equal(fs.existsSync(r.stateFile + '.tmp'), false);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test('plans counter counts ONLY actual successes: plans=2 with 1 success + closed next2 refuses with zero writes', () => {
  const r = nativeStoppedDay('s5r1-plans-drift', null, (rec) => { rec.plans = 2; });
  try {
    const before = fs.readFileSync(r.stateFile, 'utf8');
    const out = repair.planDayStartRepair(repairOpts(r));
    assert.equal(out.ok, false, 'closed next2 不是 success，不得计入 plans 计数');
    assert.equal(out.stateWrites, 0);
    assert.match(out.reason, /ledger-plans-count-drift/);
    assert.equal(fs.readFileSync(r.stateFile, 'utf8'), before, '状态字节零改动');
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});

test('verifyOnly performs zero writes anywhere and non-absolute paths are refused', () => {
  const r = nativeStoppedDay('s5r1-verify');
  try {
    const before = fs.readFileSync(r.stateFile, 'utf8');
    const out = repair.planDayStartRepair(repairOpts(r, { verifyOnly: true }));
    assert.equal(out.ok, true, out.reason || 'verifyOnly must run the full proof chain');
    assert.match(out.proofSourceHashBefore, /^[0-9a-f]{64}$/);
    assert.equal(out.stateWrites, 0);
    assert.equal(fs.readFileSync(r.stateFile, 'utf8'), before);
    assert.equal(fs.existsSync(r.backupRoot), false, 'verifyOnly 不得创建备份目录');

    const rel = repair.planDayStartRepair(repairOpts(r, { stateFile: 'relative/state.json' }));
    assert.equal(rel.ok, false);
    assert.match(rel.reason, /paths-must-be-absolute/);
  } finally { fs.rmSync(r.dir, { recursive: true, force: true }); }
});
