'use strict';

/**
 * D51 离线回归（publisher 侧，不联网、不启动浏览器、不读 Cookie、不写生产目录）：
 * 「前日可信准备收口后，当日首份零发布槽位的窄恢复」——ledger 当日恰 1 条
 * unknown/read-only-recovery-required entry、publisher state 停在前一日 P 的
 * preparation-stopped + 唯一六零耐久收口事实。只用合成日期/商品/planId/店名测试，
 * 绝不复制真实数据、绝不重放发布、绝不触碰生产账本。
 * 覆盖：
 *  1) own 隔离 namespace：成功恢复 → 记录回 pending、条目带明确未发布恢复来源 +
 *     前日事实/源 hash 证据；publisher 三面（state/attempts/published）+ identity/seed
 *     字节与 mtime 零改动；随后原 scheduler 只补当日 1..N、不重放前日成功、
 *     保留其它店/日；同来源再次调用只读幂等（含 mtime）；
 *  2) 历史终态（含 failed/reopen）存在且当前零消费 → 成功释放；可选
 *     final/reopen 表缺失按原生 writer schema 理解；
 *  3) 当前/未来消费或发布、缺日期、publisher 日期为当前/更早日、closure 字段冲突/
 *     缺失/非六零、非指定 unknown 原因、entry 带工件/多条、身份冲突、源漂移、
 *     排程锁忙、publisher 锁忙 → 全部零未来发布拒绝；
 *  4) 真实新 tick 进入当日成功后本旧支路不再适用（F1 诚实拒绝、零改写）；
 *  5) legacy 默认根有效 case（accountId=null 绑定冻结 profile 账户）+ 同名另一账户
 *     不借用 legacy 根。
 * 本文件不读取任何 Cookie；所有假 Cookie 值一律 FAKE_VALUE_NOT_REAL 语义（根本不出现）。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const wf = require('./plan-workflow.cjs');
const rp = require('./run-plans.cjs');
const profile = require('./shop-profile.cjs');
const scheduler = require('../bill-manager/promo-plan-scheduler.js');
const { createDailyRunner } = require('./daily-plan-runner.cjs');

// 合成日期：D = 当前请求日；P = 上海日历前一天；OLDER = 更早历史日。
const DATE = '2040-01-02';
const PRIOR = '2040-01-01';
const OLDER = '2039-12-30';
const NOW = Date.parse(DATE + 'T04:00:00Z'); // 上海 2040-01-02 12:00
const CLOSED_AT = '2040-01-02T01:15:00.000Z'; // 前日准备收口的“当前日实际收口时间”
const ENTRY_AT = '2040-01-02T00:30:00.000Z'; // 上海 2040-01-02 08:30（属请求日）
const OLDER_AT = '2039-12-30T01:00:00.000Z';
const PRIOR_AT = '2040-01-01T01:00:00.000Z';
const ACCOUNT = '9000000000000001';
const OTHER_ACCOUNT = '9000000000000099';
const SHOP = 'D51 synthetic shop';
const PRIOR_RUN = 'plan-scheduler-' + PRIOR + '-3120879ff739e107';
const REASON = 'read-only-recovery-required';
const MARKER = 'prior-day-zero-release-recovery';
const ZERO_PROOF = { initialConsumptions: 0, finalConsumptions: 0, reopenConsumptions: 0,
  manualUnresolved: 0, plansContainsNumber: false, confirmationConsumptionsRecorded: false };

const planId = (n) => String(9000000000000000n + BigInt(n));
const hashOf = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
};
const snapshot = (files) => files.map((file) => ({ file,
  bytes: fs.readFileSync(file).toString('hex'), mtime: fs.statSync(file, { bigint: true }).mtimeNs }));
const unchanged = (before) => assert.deepEqual(snapshot(before.map((x) => x.file)), before);

function forbidNetwork(t) {
  const forbidden = () => { throw new Error('browser, network and real publishing are forbidden'); };
  t.mock.method(globalThis, 'fetch', forbidden);
  for (const name of ['node:http', 'node:https']) {
    for (const method of ['request', 'get']) t.mock.method(require(name), method, forbidden);
  }
  for (const method of ['connect', 'createConnection']) t.mock.method(require('node:net'), method, forbidden);
  t.mock.method(require('node:net').Socket.prototype, 'connect', forbidden);
  t.mock.method(require('node:tls'), 'connect', forbidden);
  t.mock.method(rp, 'runScheduledPlan', forbidden);
}

// ── 合成原生同形数据（只用合成值）────────────────────────────────────────────
// ledger 当日记录：与主脑 2026-10-30 实录形状逐字段同构（合成值）。
function zeroReleaseRec(over) {
  return Object.assign({
    status: 'unknown', plans: 0, error: 'unknown:' + REASON,
    lastAt: ENTRY_AT,
    entries: { 1: { planNumber: 1, status: 'unknown', reason: REASON, at: ENTRY_AT } },
  }, over || {});
}

// 前日 publisher state：两条前日 success（份 1/2）+ 旧 active 份 3 preparation-stopped +
// 唯一六零耐久收口事实（原 recoverLocalPreparationClose 生成形状：source=local-preparation-recovery）。
function priorDayState() {
  const s = wf.newDayState(PRIOR);
  s.runId = PRIOR_RUN;
  s.plans = [
    { planNumber: 1, status: 'success', planId: planId(1), manifestHash: hashOf('prior-plan-1') },
    { planNumber: 2, status: 'success', planId: planId(2), manifestHash: hashOf('prior-plan-2') },
  ];
  s.active = { status: 'preparation-stopped', planNumber: 3, runId: PRIOR_RUN, businessDate: PRIOR,
    originalPhase: 'preparing', reason: 'preparing-stall-observed-by-local-recovery',
    source: 'local-preparation-recovery', closedAt: CLOSED_AT };
  s.preparationClosureFacts = [{
    status: 'preparationClosed', phase: 'preparing',
    reason: 'preparing-stall-observed-by-local-recovery', source: 'local-preparation-recovery',
    runId: PRIOR_RUN, planNumber: 3, businessDate: PRIOR, shop: SHOP, accountId: ACCOUNT,
    zeroConsumptionProof: { ...ZERO_PROOF }, closedAt: CLOSED_AT,
  }];
  return s;
}

// attempts：全部行都是严格早于 D 的历史终态（success/failed 混合 + 1 条 reopen success）。
function historicAttempts() {
  const a = { consumed: {}, finalConsumed: {}, reopenConsumed: {} };
  for (let i = 0; i < 3; i += 1) {
    const cid = 'hist-initial-' + i;
    const row = { status: 'success', businessDate: OLDER, planNumber: (i % 2) + 1,
      runId: 'plan-scheduler-' + OLDER + '-' + String(i).padStart(16, '0'),
      manifestHash: hashOf('hist-' + i), at: OLDER_AT };
    a.consumed[cid] = { ...row };
    a.finalConsumed[cid] = { ...row };
  }
  a.consumed['hist-failed-0'] = { status: 'failed', businessDate: PRIOR, planNumber: 1,
    runId: 'hist-failed-run-0', at: PRIOR_AT };
  a.finalConsumed['hist-failed-0'] = { status: 'failed', businessDate: PRIOR, planNumber: 1,
    runId: 'hist-failed-run-0', at: PRIOR_AT };
  a.consumed['hist-failed-1'] = { status: 'failed', businessDate: OLDER, planNumber: 2,
    runId: 'hist-failed-run-1', at: OLDER_AT };
  a.reopenConsumed['hist-reopen-0'] = { status: 'success', businessDate: OLDER, planNumber: 1,
    runId: 'hist-reopen-run-0', at: OLDER_AT };
  return a;
}

// 独立发布面：全部 plan 合法日期且严格早于 D；publishedIds 为账户历史商品（合成 15-20 位数字）。
function historicPublished() {
  let store = { seeded: false, seededFrom: null, publishedIds: [], plans: [] };
  store = wf.appendPublished(store, { productIds: ['9000000000010001', '9000000000010002'], planId: planId(1), date: PRIOR });
  store = wf.appendPublished(store, { productIds: ['9000000000010003'], planId: planId(2), date: PRIOR });
  return store;
}

function historicSeed() {
  return { accountId: ACCOUNT, shop: SHOP, productIds: ['9000000000010001'],
    plans: [{ planId: planId(9), date: OLDER }],
    capturedAt: OLDER_AT, scope: 'account-history', sourceEvidence: 'synthetic',
    sourceSha256: 'a'.repeat(64) };
}

// ── own 隔离 namespace fixture ──────────────────────────────────────────────
function fixture(t, options = {}) {
  forbidNetwork(t);
  const root = fs.mkdtempSync(path.join(__dirname, '.d51-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const shop = { id: 'synthetic', name: SHOP, accountId: ACCOUNT, productsPerPlan: 3 };
  const dir = path.join(root, 'shop-state', profile.shopSlug({ shop: SHOP, accountId: ACCOUNT }));
  const files = {
    state: path.join(dir, 'plan-publisher-state.json'),
    attempts: path.join(dir, 'plan-publication-attempts.json'),
    published: path.join(dir, 'published-products.json'),
    identity: path.join(dir, 'shop-identity.json'),
    seed: path.join(dir, 'fixtures', 'published-plan-seed.json'),
    ledger: path.join(root, 'data', 'ledger.json'),
    config: path.join(root, 'config.json'),
    lock: path.join(dir, 'plan-publisher.lock'),
  };
  write(files.identity, { shop: SHOP, accountId: ACCOUNT, verifiedAt: OLDER_AT });
  if (!options.omitSeed) write(files.seed, historicSeed());
  const attempts = historicAttempts();
  if (options.omitFinalAndReopen) { delete attempts.finalConsumed; delete attempts.reopenConsumed; }
  write(files.attempts, attempts);
  write(files.published, historicPublished());
  write(files.state, priorDayState());
  const priorDayLedger = { status: 'success', plans: 2, entries: {
    1: { planNumber: 1, status: 'success', planId: planId(1), at: PRIOR_AT },
    2: { planNumber: 2, status: 'success', planId: planId(2), at: PRIOR_AT } } };
  const rec = zeroReleaseRec();
  const ledger = { version: 1, days: {
    [DATE]: { shops: { synthetic: rec,
      untouched: { status: 'success', plans: 1, entries: { 1: { planNumber: 1, status: 'success', planId: planId(8) } } } } },
    [PRIOR]: { shops: { synthetic: priorDayLedger } } } };
  write(files.ledger, ledger);
  write(files.config, { enabled: true, autoConfirm: true, adapterRoot: root, stateRoot: root,
    login: { cookieWorkDir: root, cookieSourceDir: root }, shops: [shop] });
  const calls = { run: [], discovery: 0, open: 0, local: 0, ledgerWrites: 0, allowRun: false };
  const deps = {
    runPlan: async (_business, o) => {
      calls.run.push(o.planNumber);
      if (!calls.allowRun) throw new Error('runPlan forbidden during recovery');
      return { status: 'success', planId: planId(o.planNumber) };
    },
    readDaySuccess: (...args) => rp.readDaySuccessForShop(...args),
    discoverAccount: () => { calls.discovery += 1; throw new Error('forbidden discovery'); },
    resolvePublisherPaths: rp.resolvePublisherStatePaths,
    currentSourceHash: rp.currentPreOpenSourceHash,
    reproveDurablePreparationStopped: rp.reproveDurablePreparationStoppedClose,
    // canonical F1 兜底路径：形状不符落到 F1 时诚实 refused（生产对前日 state 亦如此），零改写。
    recoverLocalPreparation: () => { calls.local += 1; return { ok: false, status: 'refused', reason: 'state-business-date-mismatch' }; },
  };
  if (options.hashSequence) {
    const real = rp.currentPreOpenSourceHash;
    let n = 0;
    deps.currentSourceHash = (...args) => {
      n += 1;
      return options.hashSequence(n) ? real(...args) : 'f'.repeat(64);
    };
  }
  const schedulerModule = { ...scheduler, saveLedger: (...args) => { calls.ledgerWrites += 1; return scheduler.saveLedger(...args); } };
  const f = { root, dir, files, rec, ledger, deps, calls, schedulerModule,
    publisherFiles: [files.state, files.attempts, files.published, files.identity, files.seed],
    modify(name, fn) { const value = read(files[name]); fn(value); write(files[name], value); },
    makeRunner() {
      return createDailyRunner({ configFile: files.config, dataDir: path.dirname(files.ledger),
        stateRoot: root, schedulerModule, deps, nowMs: () => NOW,
        openShop: () => { calls.open += 1; throw new Error('forbidden browser'); } });
    },
    recover() { return f.makeRunner().recoverShopDay('synthetic', DATE); },
  };
  return f;
}

function noActions(f) {
  // calls.local 不在此断言：形状不符落到 canonical F1 时，诚实 refused 的 stub 会被计数。
  assert.deepEqual(f.calls.run, []);
  assert.equal(f.calls.discovery, 0);
  assert.equal(f.calls.open, 0);
}

async function rejected(f, expected) {
  const before = snapshot(Object.values(f.files).filter((file) => fs.existsSync(file)));
  const result = await f.recover();
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.released, false);
  if (expected) assert.match(result.reason, expected);
  unchanged(before);
  assert.equal(f.calls.ledgerWrites, 0);
  noActions(f);
  return result;
}

// ── 1) 成功恢复 + 原 scheduler 只补当日 1..N ─────────────────────────────────
test('D51 own shop: zero-release slot recovers to pending, publisher bytes+mtime unchanged, scheduler refills only current-day 1..N', async (t) => {
  const f = fixture(t);
  const durable = snapshot(f.publisherFiles);
  const result = await f.recover();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.released, true);
  assert.equal(result.planNumber, 1);
  assert.equal(result.priorDay, PRIOR);
  assert.equal(result.priorRunId, PRIOR_RUN);
  assert.equal(result.method, MARKER);
  assert.equal(f.calls.ledgerWrites, 1);

  const after = read(f.files.ledger);
  const rec = after.days[DATE].shops.synthetic;
  // rec.plans 按真实 success 计数 = 0；状态回 pending、旧 error/partial 清空。
  assert.equal(rec.status, 'pending');
  assert.equal(rec.plans, 0);
  assert.equal(rec.error, null);
  assert.equal('partial' in rec, false);
  // 条目：明确未发布恢复来源 + 前日事实/源 hash 证据；原 reason/status 原样保留。
  const entry = rec.entries[1];
  assert.equal(entry.status, 'unknown');
  assert.equal(entry.reason, REASON);
  assert.equal(entry.at, ENTRY_AT);
  assert.equal(entry.recoveredBy, MARKER);
  assert.equal(typeof entry.recoveredAt, 'string');
  assert.deepEqual(entry.priorDayClosure, { businessDate: PRIOR, runId: PRIOR_RUN, closedAt: CLOSED_AT, sourceHash: entry.priorDayClosure.sourceHash });
  assert.match(entry.priorDayClosure.sourceHash, /^[0-9a-f]{64}$/);
  // retryHistory 简单事件：普通 tick 覆盖条目后证明仍可追溯。
  assert.equal(rec.retryHistory.length, 1);
  const event = rec.retryHistory[0];
  assert.equal(event.planNumber, 1);
  assert.equal(event.reason, REASON);
  assert.equal(event.proof.method, MARKER);
  assert.equal(event.proof.priorBusinessDate, PRIOR);
  assert.equal(event.proof.priorRunId, PRIOR_RUN);
  assert.equal(event.proof.priorClosedAt, CLOSED_AT);
  assert.match(event.proof.sourceHash, /^[0-9a-f]{64}$/);
  // 其它店/日原样保留。
  assert.deepEqual(after.days[DATE].shops.untouched, f.ledger.days[DATE].shops.untouched);
  assert.deepEqual(after.days[PRIOR].shops.synthetic, f.ledger.days[PRIOR].shops.synthetic);
  // publisher 三面 + identity/seed 字节与 mtime 零改动；零浏览器/发现/重放。
  unchanged(durable);
  noActions(f);

  // 原 scheduler：fake 发布只补当日 1..上限（一次 tick 补齐全部缺额），不重放前日成功，
  // 保留其它店/日；随后零缺额 tick 零派发。
  f.calls.allowRun = true;
  const runner = f.makeRunner();
  const tick1 = await runner.tick();
  assert.equal(tick1.ran, true);
  assert.deepEqual(f.calls.run, [1, 2, 3]);
  await runner.tick();
  assert.deepEqual(f.calls.run, [1, 2, 3]);
  const ticked = read(f.files.ledger);
  const rec2 = ticked.days[DATE].shops.synthetic;
  assert.equal(rec2.plans, 3);
  assert.equal(rec2.status, 'success');
  assert.equal(rec2.entries[1].status, 'success');
  assert.equal(rec2.entries[2].status, 'success');
  assert.equal(rec2.entries[3].status, 'success');
  // 条目被普通 tick 覆盖后，恢复证明仍可由 retryHistory 追溯。
  assert.equal(rec2.retryHistory.length, 1);
  assert.equal(rec2.retryHistory[0].proof.method, MARKER);
  assert.deepEqual(ticked.days[PRIOR].shops.synthetic, f.ledger.days[PRIOR].shops.synthetic);
  assert.deepEqual(ticked.days[DATE].shops.untouched, f.ledger.days[DATE].shops.untouched);
  assert.equal(f.calls.open, 0);
  assert.equal(f.calls.discovery, 0);
});

// ── 2) 严格幂等：同来源再次调用只读 no-op（含 mtime）─────────────────────────
test('D51 idempotent: same-source re-call is read-only no-op including mtime', async (t) => {
  const f = fixture(t);
  assert.equal((await f.recover()).ok, true);
  const before = snapshot(Object.values(f.files).filter((file) => fs.existsSync(file)));
  const writes = f.calls.ledgerWrites;
  const again = await f.recover();
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.released, false);
  assert.equal(again.idempotent, true);
  assert.equal(again.planNumber, 1);
  assert.equal(f.calls.ledgerWrites, writes, '幂等 no-op 绝不再次写账本');
  unchanged(before);
  noActions(f);
});

// ── 3) 真实新 tick 进入当日成功后，本旧支路不得再抢占 ─────────────────────────
test('D51 after a real current-day success the branch no longer applies (honest F1 refusal, zero writes)', async (t) => {
  const f = fixture(t);
  assert.equal((await f.recover()).ok, true);
  f.calls.allowRun = true;
  await f.makeRunner().tick();
  assert.deepEqual(f.calls.run, [1, 2, 3]);
  const writes = f.calls.ledgerWrites;
  const before = snapshot(Object.values(f.files).filter((file) => fs.existsSync(file)));
  const result = await f.recover();
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.released, false);
  assert.match(result.reason, /^recovery-local-not-closed/);
  const after = read(f.files.ledger);
  const rec = after.days[DATE].shops.synthetic;
  assert.equal(rec.entries[1].status, 'success', '当日成功条目绝不被旧支路改写');
  assert.equal(rec.status, 'success');
  assert.equal(rec.plans, 3);
  assert.equal(f.calls.ledgerWrites, writes);
  unchanged(before);
});

// ── 4) 可选 final/reopen 表缺失按原生 writer schema 理解（从未使用 ≠ 伪造零）──
test('D51 absent optional final/reopen tables are understood per native writer schema', async (t) => {
  const f = fixture(t, { omitFinalAndReopen: true });
  const durable = snapshot(f.publisherFiles);
  const result = await f.recover();
  assert.equal(result.ok, true, JSON.stringify(result));
  unchanged(durable);
});

// ── 5) legacy 默认根有效 case + 同名另一账户不借用 legacy 根 ─────────────────
function legacyFixture(t, options = {}) {
  forbidNetwork(t);
  const root = fs.mkdtempSync(path.join(__dirname, '.d51-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const account = options.configAccount === undefined ? null : options.configAccount;
  const shop = { id: 'legacy', name: wf.BUSINESS.shop, accountId: account, productsPerPlan: 3 };
  const files = {
    state: path.join(root, 'plan-publisher-state.json'),
    attempts: path.join(root, 'plan-publication-attempts.json'),
    published: path.join(root, 'published-products.json'),
    ledger: path.join(root, 'data', 'ledger.json'),
    config: path.join(root, 'config.json'),
    lock: path.join(root, 'plan-publisher.lock'),
  };
  const state = priorDayState();
  state.preparationClosureFacts[0].shop = wf.BUSINESS.shop;
  state.preparationClosureFacts[0].accountId = wf.BUSINESS.accountId;
  write(files.state, state);
  write(files.attempts, historicAttempts());
  write(files.published, historicPublished());
  const rec = zeroReleaseRec();
  const ledger = { version: 1, days: { [DATE]: { shops: { legacy: rec } } } };
  write(files.ledger, ledger);
  write(files.config, { enabled: true, autoConfirm: true, adapterRoot: root, stateRoot: root,
    login: { cookieWorkDir: root, cookieSourceDir: root }, shops: [shop] });
  const calls = { run: [], discovery: 0, open: 0, local: 0, ledgerWrites: 0 };
  const deps = {
    runPlan: async () => { throw new Error('runPlan forbidden during recovery'); },
    readDaySuccess: (...args) => rp.readDaySuccessForShop(...args),
    discoverAccount: () => { calls.discovery += 1; throw new Error('forbidden discovery'); },
    resolvePublisherPaths: rp.resolvePublisherStatePaths,
    currentSourceHash: rp.currentPreOpenSourceHash,
    reproveDurablePreparationStopped: rp.reproveDurablePreparationStoppedClose,
    recoverLocalPreparation: () => { calls.local += 1; return { ok: false, status: 'refused', reason: 'state-business-date-mismatch' }; },
  };
  const schedulerModule = { ...scheduler, saveLedger: (...args) => { calls.ledgerWrites += 1; return scheduler.saveLedger(...args); } };
  const f = { root, files, rec, ledger, deps, calls, schedulerModule,
    publisherFiles: [files.state, files.attempts, files.published],
    makeRunner() {
      return createDailyRunner({ configFile: files.config, dataDir: path.dirname(files.ledger),
        stateRoot: root, schedulerModule, deps, nowMs: () => NOW,
        openShop: () => { calls.open += 1; throw new Error('forbidden browser'); } });
    },
    recover() { return f.makeRunner().recoverShopDay('legacy', DATE); },
  };
  return f;
}

test('D51 legacy default root: accountId=null binds the frozen profile account and recovers without touching publisher files', async (t) => {
  const f = legacyFixture(t);
  const durable = snapshot(f.publisherFiles);
  const result = await f.recover();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.released, true);
  assert.equal(result.planNumber, 1);
  assert.equal(result.priorDay, PRIOR);
  assert.equal(result.priorRunId, PRIOR_RUN);
  const after = read(f.files.ledger);
  const rec = after.days[DATE].shops.legacy;
  assert.equal(rec.status, 'pending');
  assert.equal(rec.plans, 0);
  assert.equal(rec.error, null);
  assert.equal(rec.entries[1].recoveredBy, MARKER);
  assert.equal(rec.entries[1].priorDayClosure.businessDate, PRIOR);
  assert.equal(f.calls.ledgerWrites, 1);
  unchanged(durable);
  assert.deepEqual(f.calls.run, []);
  assert.equal(f.calls.open, 0);
  assert.equal(f.calls.local, 0);
});

test('D51 legacy root with a different configured account never borrows the legacy root (zero writes)', async (t) => {
  const f = legacyFixture(t, { configAccount: OTHER_ACCOUNT });
  await rejected(f, /^recovery-zero-release-(state-unreadable|state-paths-unavailable)/);
});

// ── 6) 拒绝矩阵：零未来发布、零改写（每个 case 独立 fixture/独立 mock 上下文）──
test('D51 rejection matrix: every unsupported shape refuses with zero future publication and zero writes', async (t) => {
  await t.test('attempts table violations', async (st) => {
    for (const [name, mutate, expect] of [
      ['current-day consumed', (a) => { a.consumed.cur = { status: 'success', businessDate: DATE, planNumber: 1, runId: 'cur-run', at: ENTRY_AT }; }, /consumption-scope-current-future-or-missing:consumed/],
      ['future-dated consumed', (a) => { a.consumed.fut = { status: 'success', businessDate: '2040-01-03', planNumber: 1, runId: 'fut-run', at: ENTRY_AT }; }, /consumption-scope-current-future-or-missing:consumed/],
      ['missing businessDate', (a) => { const row = { ...a.consumed['hist-failed-0'] }; delete row.businessDate; a.consumed['no-date'] = row; }, /consumption-scope-current-future-or-missing:consumed/],
      ['non-terminal dispatched row', (a) => { a.consumed.disp = { status: 'dispatched', businessDate: OLDER, planNumber: 1, runId: 'disp-run', at: OLDER_AT }; }, /consumption-non-terminal:consumed/],
      ['current-day reopen row', (a) => { a.reopenConsumed.cur = { status: 'success', businessDate: DATE, planNumber: 1, runId: 'cur-run', at: ENTRY_AT }; }, /consumption-scope-current-future-or-missing:reopenConsumed/],
      ['malformed reopen table', (a) => { a.reopenConsumed = null; }, /attempts-reopenConsumed-malformed/],
      ['missing consumed table', (a) => { delete a.consumed; }, /attempts-consumed-malformed/],
      ['consumption identity conflict', (a) => { a.consumed['hist-failed-0'].accountId = OTHER_ACCOUNT; }, /consumption-identity-conflict:consumed/],
    ]) {
      await st.test(name, async (s2) => {
        const f = fixture(s2);
        f.modify('attempts', mutate);
        await rejected(f, expect);
      });
    }
  });

  await t.test('published store violations', async (st) => {
    for (const [name, mutate] of [
      ['current-day published plan', (p) => { p.plans.push({ planId: planId(5), date: DATE }); }],
      ['published plan without date', (p) => { p.plans.push({ planId: planId(6) }); }],
      ['published ids duplicate', (p) => { p.publishedIds.push(p.publishedIds[0]); }],
    ]) {
      await st.test(name, async (s2) => {
        const f = fixture(s2);
        f.modify('published', mutate);
        await rejected(f, /published-/);
      });
    }
  });

  await t.test('publisher state date must be exactly the Shanghai calendar prior day', async (st) => {
    for (const [name, date] of [['current day', DATE], ['older than prior day', OLDER]]) {
      await st.test(name, async (s2) => {
        const f = fixture(s2);
        f.modify('state', (s) => { s.businessDate = date; s.active.businessDate = date;
          for (const fact of s.preparationClosureFacts) fact.businessDate = date; });
        await rejected(f, /state-date-not-prior-day|prior-day-closure-reprove-refused/);
      });
    }
  });

  await t.test('closure fact missing / non-six-zero / field conflicts', async (st) => {
    for (const [name, mutate, expect] of [
      ['fact missing', (s) => { s.preparationClosureFacts = []; }, /prior-day-closure-reprove-refused/],
      ['fact non-six-zero', (s) => { s.preparationClosureFacts[0].zeroConsumptionProof.initialConsumptions = 1; }, /prior-day-closure-reprove-refused/],
      ['fact plan conflict', (s) => { s.preparationClosureFacts[0].planNumber = 2; }, /prior-day-closure-reprove-refused/],
      ['fact run conflict', (s) => { s.preparationClosureFacts[0].runId = 'plan-scheduler-' + PRIOR + '-00000000000000ff'; }, /prior-day-closure-reprove-refused/],
      ['fact closedAt conflict', (s) => { s.preparationClosureFacts[0].closedAt = '2040-01-02T02:15:00.000Z'; }, /prior-day-fact-closed-at-mismatch/],
      ['fact reason conflict', (s) => { s.preparationClosureFacts[0].reason = 'other-reason'; }, /prior-day-fact-reason-mismatch/],
      ['fact source conflict', (s) => { s.preparationClosureFacts[0].source = 'explicit-no-publication-proof-close'; }, /prior-day-fact-source-mismatch/],
    ]) {
      await st.test(name, async (s2) => {
        const f = fixture(s2);
        f.modify('state', mutate);
        await rejected(f, expect);
      });
    }
  });

  await t.test('old active shape violations', async (st) => {
    for (const [name, mutate, expect] of [
      ['active still preparing', (s) => { s.active.status = 'preparing'; }, /state-active-not-preparation-stopped/],
      ['active source not trusted close', (s) => { s.active.source = 'scheduled-prepare-stopped'; }, /state-active-source-not-trusted-close/],
      ['active carries artifacts', (s) => { s.active.planId = planId(3); }, /state-active-artifacts-present/],
      ['active run origin not prior-day scheduled', (s) => { s.active.runId = 'plan-scheduler-' + DATE + '-3120879ff739e107'; s.runId = s.active.runId; }, /state-active-run-origin-invalid/],
      ['state run conflict', (s) => { s.runId = 'plan-scheduler-' + PRIOR + '-00000000000000ff'; }, /state-run-conflict/],
      ['plans not active prefix', (s) => { s.plans.push({ planNumber: 3, status: 'success', planId: planId(3), manifestHash: hashOf('p3') }); }, /state-plans-not-active-prefix/],
      ['prior plan not success', (s) => { s.plans[0].status = 'failed'; }, /state-plan-not-success:1/],
      ['unresolved flag present', (s) => { s.pending = true; }, /state-unresolved-flag-present/],
      ['confirmation consumptions present', (s) => { s.confirmationConsumptions.push({ businessDate: OLDER, planNumber: 1, runId: 'x' }); }, /state-confirmation-consumptions-present/],
      ['manual facts present', (s) => { s.manualUiPublicationFacts.push({ businessDate: OLDER, planNumber: 1 }); }, /state-manual-facts-present/],
    ]) {
      await st.test(name, async (s2) => {
        const f = fixture(s2);
        f.modify('state', mutate);
        await rejected(f, expect);
      });
    }
  });

  await t.test('ledger record / entry shape violations', async (st) => {
    for (const [name, mutate, expect] of [
      // rec.status='failed' 由既有形状 1（D49 路由）先接管并诚实拒绝；本支路保持在其后。
      ['record not unknown (shape 1 owns failed records)', (r) => { r.status = 'failed'; }, /record-status-not-unknown|release-capability-unavailable/],
      ['record error not exact', (r) => { r.error = 'unknown:other-reason'; }, /record-error-not-exact/],
      ['record plans count mismatch', (r) => { r.plans = 2; }, /record-plans-count-mismatch/],
      ['record artifacts', (r) => { r.confirmationId = 'cid'; }, /record-artifacts-present/],
      ['entry not first slot', (r) => { r.entries[2] = { ...r.entries[1], planNumber: 2 }; delete r.entries[1]; }, /entry-not-first-slot:2/],
      ['entry key/plan mismatch', (r) => { r.entries[1].planNumber = 3; }, /entry-key-plan-mismatch|entry-not-first-slot:3/],
      ['entry at not request day', (r) => { r.entries[1].at = PRIOR_AT; }, /entry-at-not-request-day/],
      ['entry invalid at', (r) => { r.entries[1].at = 'not-a-time'; }, /entry-at-not-request-day/],
      ['entry carries startedAt (not native blocked schema)', (r) => { r.entries[1].startedAt = ENTRY_AT; }, /entry-artifacts-present:startedAt/],
      ['entry carries planId artifact', (r) => { r.entries[1].planId = planId(1); }, /entry-artifacts-present:planId/],
      ['entry carries runId artifact', (r) => { r.entries[1].runId = PRIOR_RUN; }, /entry-artifacts-present:runId/],
    ]) {
      await st.test(name, async (s2) => {
        const f = fixture(s2);
        f.modify('ledger', (l) => mutate(l.days[DATE].shops.synthetic));
        await rejected(f, expect);
      });
    }
  });

  await t.test('non-designated unknown reason keeps the existing no-replay refusal (falls through, zero writes)', async (st) => {
    await st.test('R16 reason (readback branch honestly refuses on prior-day state)', async (s2) => {
      const f = fixture(s2);
      f.modify('ledger', (l) => {
        const rec = l.days[DATE].shops.synthetic;
        rec.entries[1].reason = 'management-identity-hydrate-timeout';
        rec.error = 'unknown:management-identity-hydrate-timeout';
      });
      await rejected(f, /^recovery-(local-not-closed|readback-state-date-mismatch)/);
    });
    await st.test('generic other reason', async (s2) => {
      const f = fixture(s2);
      f.modify('ledger', (l) => {
        const rec = l.days[DATE].shops.synthetic;
        rec.entries[1].reason = 'some-other-unknown';
        rec.error = 'unknown:some-other-unknown';
      });
      await rejected(f, /^recovery-local-not-closed/);
    });
  });

  await t.test('multiple entries never enter the narrow branch (F1 honest refusal, zero writes)', async (st) => {
    await st.test('second success entry', async (s2) => {
      const f = fixture(s2);
      f.modify('ledger', (l) => {
        l.days[DATE].shops.synthetic.entries[2] = { planNumber: 2, status: 'success', planId: planId(9), at: ENTRY_AT };
      });
      await rejected(f, /^recovery-local-not-closed/);
    });
    await st.test('second unknown entry', async (s2) => {
      const f = fixture(s2);
      f.modify('ledger', (l) => {
        l.days[DATE].shops.synthetic.entries[2] = { planNumber: 2, status: 'unknown', reason: REASON, at: ENTRY_AT };
      });
      await rejected(f, /^recovery-local-not-closed/);
    });
  });

  await t.test('identity conflicts', async (st) => {
    await st.test('state account conflict', async (s2) => {
      const f = fixture(s2);
      f.modify('state', (s) => { s.accountId = OTHER_ACCOUNT; });
      await rejected(f, /identity-conflict/);
    });
    await st.test('identity file account conflict', async (s2) => {
      const f = fixture(s2);
      f.modify('identity', (d) => { d.accountId = OTHER_ACCOUNT; });
      await rejected(f, /state-paths-unavailable|identity/);
    });
    await st.test('seed account conflict', async (s2) => {
      const f = fixture(s2);
      f.modify('seed', (d) => { d.accountId = OTHER_ACCOUNT; });
      await rejected(f, /seed-identity-conflict/);
    });
  });

  await t.test('source drift refuses before and under the scheduler lock', async (st) => {
    await st.test('drift before lock', async (s2) => {
      const f = fixture(s2, { hashSequence: (n) => n < 2 });
      await rejected(f, /recovery-zero-release-source-drift$/);
    });
    await st.test('drift under lock', async (s2) => {
      const f = fixture(s2, { hashSequence: (n) => n < 3 });
      await rejected(f, /source-drift-under-lock/);
    });
  });

  await t.test('busy scheduler lock: never grabbed, killed, or fake-released', async (st) => {
    await st.test('held lock', async (s2) => {
      const f = fixture(s2);
      const lock = scheduler.acquireProcessLock(f.files.ledger + '.lock', () => NOW, 30 * 60 * 1000);
      try {
        assert.equal(lock.held, true);
        await rejected(f, /scheduler-lock-busy/);
      } finally { scheduler.releaseProcessLock(f.files.ledger + '.lock', lock.token); }
    });
  });

  await t.test('busy publisher lock: read-only refusal, zero writes', async (st) => {
    await st.test('lock file present', async (s2) => {
      const f = fixture(s2);
      fs.writeFileSync(f.files.lock, 'busy');
      await rejected(f, /publisher-lock-busy/);
      fs.rmSync(f.files.lock, { force: true });
    });
  });
});

// ── R6 追加：CAS 基线时点（真实读写交错）与严格幂等篡改反例 ──────────────────
// 交错原语：拦截 fs.readFileSync(target,'utf8')，第 fireOn 次命中时先真实读出旧快照，
// 立即把 mutate 后的**新字节真实写入磁盘**，再把旧快照返回给调用方 —— 验证的是真实
// 文件交错，不是 hashSequence 式假返回（该选项仍只用于既有锁漂移回归）。
function interleaveRead(target, mutate, fireOn = 1) {
  const original = fs.readFileSync;
  let hits = 0;
  fs.readFileSync = function patched(...args) {
    const isUtf8 = typeof args[1] === 'string' ? args[1] === 'utf8'
      : !!(args[1] && args[1].encoding === 'utf8');
    if (String(args[0]) === String(target) && isUtf8) {
      hits += 1;
      const text = original.apply(fs, args);
      if (hits === fireOn) {
        const updated = JSON.parse(text.toString('utf8'));
        mutate(updated);
        fs.writeFileSync(String(target), JSON.stringify(updated, null, 2));
      }
      return text;
    }
    return original.apply(fs, args);
  };
  return () => { fs.readFileSync = original; };
}

// 原生 writer schema 的当日消费行（合成值）：planNumber 1、businessDate D、
// runId plan-scheduler-D-16hex、manifestHash 64hex、合法 CID/at。
const addCurrentConsumption = (a) => {
  a.consumed['interposed-cur'] = { status: 'success', businessDate: DATE, planNumber: 1,
    runId: 'plan-scheduler-' + DATE + '-0000000000000001',
    manifestHash: hashOf('interposed-current'), at: ENTRY_AT };
};
// 语义无害的历史行：解析验证仍会通过，只可能由 CAS/重证基线绑定抓住（证明防线不是校验巧合）。
const addHarmlessOlderConsumption = (a) => {
  a.consumed['interposed-older'] = { status: 'success', businessDate: OLDER, planNumber: 2,
    runId: 'plan-scheduler-' + OLDER + '-0000000000000002',
    manifestHash: hashOf('interposed-older'), at: OLDER_AT };
};

async function interleaveReject(f, restore, target, expected, injected) {
  const ledgerSnap = snapshot([f.files.ledger]);
  const durableSnap = snapshot(f.publisherFiles.filter((x) => String(x) !== String(target)));
  const result = await f.recover();
  restore();
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.released, false);
  assert.notEqual(result.idempotent, true);
  assert.match(result.reason, expected);
  assert.equal(f.calls.ledgerWrites, 0, '交错拒绝必须零账本写入');
  assert.equal(f.calls.local, 0, '交错拒绝绝不落到 canonical F1');
  unchanged(ledgerSnap);
  unchanged(durableSnap);
  noActions(f);
  const disk = JSON.parse(fs.readFileSync(String(target), 'utf8'));
  injected(disk); // 反例真的把新字节落了盘（不是 mock 假象）
  return result;
}

test('D51 R6 CAS baseline: attempts interleaved with a current-day consumption row on first read → zero-write refusal', async (t) => {
  const f = fixture(t);
  const restore = interleaveRead(f.files.attempts, addCurrentConsumption, 1);
  await interleaveReject(f, restore, f.files.attempts,
    /^recovery-zero-release-(consumption-scope-current-future-or-missing|source-drift|prior-day-reproof-source-hash-mismatch)/,
    (disk) => assert.ok(disk.consumed['interposed-cur'] && disk.consumed['interposed-cur'].businessDate === DATE));
});

test('D51 R6 CAS baseline: validation-neutral older-day attempts drift injected on first read → refused only by baseline binding', async (t) => {
  const f = fixture(t);
  const restore = interleaveRead(f.files.attempts, addHarmlessOlderConsumption, 1);
  await interleaveReject(f, restore, f.files.attempts,
    /^recovery-zero-release-(prior-day-reproof-source-hash-mismatch|source-drift)$/,
    (disk) => assert.ok(disk.consumed['interposed-older']));
});

test('D51 R6 CAS baseline: published surface interleaved with a current-day plan → zero-write refusal', async (t) => {
  const f = fixture(t);
  const restore = interleaveRead(f.files.published, (p) => { p.plans.push({ planId: planId(5), date: DATE }); }, 1);
  await interleaveReject(f, restore, f.files.published,
    /^recovery-zero-release-(published-plan-date-current-future-or-missing|source-drift|prior-day-reproof-source-hash-mismatch)/,
    (disk) => assert.ok(disk.plans.some((p) => String(p.date) === DATE)));
});

test('D51 R6 CAS baseline: seed surface interleaved with validation-neutral bytes → refused by same-baseline binding', async (t) => {
  const f = fixture(t);
  const restore = interleaveRead(f.files.seed, (s) => { s.sourceEvidence = 'interposed-real-write'; }, 1);
  await interleaveReject(f, restore, f.files.seed,
    /^recovery-zero-release-(prior-day-reproof-source-hash-mismatch|source-drift)$/,
    (disk) => assert.equal(disk.sourceEvidence, 'interposed-real-write'));
});

test('D51 R6 reproof must bind the same CAS baseline: foreign sourceHash or extra-surface set refuses (zero writes)', async (t) => {
  await t.test('reproof sourceHash differs from baseline', async (st) => {
    const f = fixture(st);
    const real = f.deps.reproveDurablePreparationStopped;
    f.deps.reproveDurablePreparationStopped = async (...args) => {
      const r = await real(...args);
      return r && r.ok === true ? { ...r, sourceHash: 'e'.repeat(64) } : r;
    };
    await rejected(f, /recovery-zero-release-prior-day-reproof-source-hash-mismatch/);
  });
  await t.test('reproof extra-surface set differs', async (st) => {
    const f = fixture(st);
    const real = f.deps.reproveDurablePreparationStopped;
    f.deps.reproveDurablePreparationStopped = async (...args) => {
      const r = await real(...args);
      return r && r.ok === true ? { ...r, sourceExtraFiles: [] } : r;
    };
    await rejected(f, /recovery-zero-release-prior-day-reproof-extra-surfaces-mismatch/);
  });
});

// ── R6 严格幂等篡改反例：先真实恢复，再篡改记录/证明/源面，重调绝不得盲报 already recovered ──
async function recoveredFixture(t) {
  const f = fixture(t);
  const first = await f.recover();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.released, true);
  return f;
}

async function refusalAfterRecovery(f, expected) {
  const before = snapshot(Object.values(f.files).filter((file) => fs.existsSync(file)));
  const writes = f.calls.ledgerWrites;
  const result = await f.recover();
  assert.equal(result.ok, false, JSON.stringify(result));
  assert.equal(result.released, false);
  assert.notEqual(result.idempotent, true, '篡改记录绝不返回 already-recovered-pending');
  assert.match(result.reason, expected);
  assert.equal(f.calls.ledgerWrites, writes, '幂等反例绝不再写账本');
  unchanged(before);
  noActions(f);
  return result;
}

test('D51 R6 strict idempotency: tampered recovered records refuse instead of blind already-recovered no-op', async (t) => {
  for (const [name, mutate, expect] of [
    ['record error tampered', (r) => { r.error = 'unknown:tampered'; }, /idempotent-record-error-present/],
    ['record status tampered', (r) => { r.status = 'unknown'; }, /idempotent-record-status:unknown/],
    ['record plans count tampered', (r) => { r.plans = 2; }, /idempotent-record-plans-not-zero/],
    ['marker without prior proof', (r) => { delete r.entries[1].priorDayClosure; }, /idempotent-prior-proof-missing/],
    ['prior proof run origin forged to current day', (r) => { r.entries[1].priorDayClosure.runId = 'plan-scheduler-' + DATE + '-000000000000000a'; }, /idempotent-prior-run-origin-invalid/],
    ['retryHistory proof removed', (r) => { r.retryHistory = []; }, /idempotent-retry-history-inconsistent/],
    ['prior proof sourceHash forged', (r) => { r.entries[1].priorDayClosure.sourceHash = 'a'.repeat(64); }, /idempotent-source-drift/],
    ['entry gains runId artifact under marker', (r) => { r.entries[1].runId = PRIOR_RUN; }, /idempotent-entry-artifacts-present:runId/],
  ]) {
    await t.test(name, async (s2) => {
      const f = await recoveredFixture(s2);
      f.modify('ledger', (l) => mutate(l.days[DATE].shops.synthetic));
      await refusalAfterRecovery(f, /^recovery-zero-release-/);
    });
  }
});

test('D51 R6 strict idempotency: real current-day consumption written to attempts after recovery → re-call refuses with zero writes', async (t) => {
  const f = await recoveredFixture(t);
  f.modify('attempts', addCurrentConsumption);
  await refusalAfterRecovery(f, /^recovery-zero-release-idempotent-source-drift$/);
  assert.ok(read(f.files.attempts).consumed['interposed-cur']);
});

test('D51 R6 strict idempotency: real current-day publication added to published after recovery → re-call refuses with zero writes', async (t) => {
  const f = await recoveredFixture(t);
  f.modify('published', (p) => { p.plans.push({ planId: planId(7), date: DATE }); });
  await refusalAfterRecovery(f, /^recovery-zero-release-idempotent-source-drift$/);
});

test('D51 R6 strict idempotency: intact self-consistent recovered record still gets read-only no-op (positive control)', async (t) => {
  const f = await recoveredFixture(t);
  const before = snapshot(Object.values(f.files).filter((file) => fs.existsSync(file)));
  const writes = f.calls.ledgerWrites;
  const again = await f.recover();
  assert.equal(again.ok, true, JSON.stringify(again));
  assert.equal(again.idempotent, true);
  assert.equal(again.reason, 'already-recovered-pending');
  assert.equal(f.calls.ledgerWrites, writes);
  unchanged(before);
  noActions(f);
});
