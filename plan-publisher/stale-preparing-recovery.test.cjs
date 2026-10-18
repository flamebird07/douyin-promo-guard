'use strict';

/**
 * F1 离线回归（publisher 侧，不联网、不启动浏览器、不读 Cookie、不写生产目录）：
 * 排程进程在 preparing 相位被杀后，publisher 只留下 active=preparing 的旧状态。本测试只
 * 用 os.tmpdir 自建 stateRoot（匿名动态店 + legacy 默认店两种 namespace），验证
 * recoverLocalPreparationClose：
 *  1) 当前精确形状（preparing + 排程 runId + plans/confirmationConsumptions/manual 空 +
 *     三表零消费）→ 复用既有严格证明与耐久收口，active 翻成 preparation-stopped，
 *     attempts 字节零改动；再次调用幂等（alreadyClosed、不再追加事实）；
 *  2) 任何消费痕迹/冻结件/错 runId/错份号/跨日/缺文件/损坏/错型/身份冲突/身份歧义 → 零改写；
 *  3) publisher 真实互斥锁被活进程持有 → 不抢占、零改写；
 *  4) 全程 openShop / readers 计数必须为 0（本路径确实不依赖浏览器）。
 * 只用 fake Cookie 值 FAKE_VALUE_NOT_REAL（本文件根本不读任何 Cookie）。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const nodeTest = require('node:test');

const PUB = process.env.PUBLISHER_DIR
  ? path.resolve(process.env.PUBLISHER_DIR)
  : path.resolve(__dirname);
if (!fs.existsSync(path.join(PUB, 'run-plans.cjs'))) throw new Error('explicit publisher source unavailable: ' + PUB);
const rp = require(path.join(PUB, 'run-plans.cjs'));
const wf = require(path.join(PUB, 'plan-workflow.cjs'));
const shopProfile = require(path.join(PUB, 'shop-profile.cjs'));

const TODAY = '2026-10-18';
const YESTERDAY = '2026-10-17';
const NOW_MS = Date.UTC(2026, 9, 18, 2, 30, 0); // 上海 2026-10-18 10:30
const ACCOUNT = '1696626252631053';
const OTHER_ACCOUNT = '1710000000000777';
const SHOP = '匿名动态测试店';
const RUN_ID = 'plan-scheduler-' + TODAY + '-3120879ff739e107';
const FAKE_COOKIE = 'FAKE_VALUE_NOT_REAL';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function cleanup(dir) {
  try {
    const abs = path.resolve(dir);
    if (!(abs + path.sep).startsWith(path.resolve(os.tmpdir()) + path.sep)) return;
    fs.rmSync(abs, { recursive: true, force: true });
  } catch (_) { /* 清理失败不影响结论 */ }
}
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}
function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function emptyAttempts() { return { consumed: {}, finalConsumed: {}, reopenConsumed: {} }; }
// 独立发布事实面（生产同形状：publishedIds + plans）；本测试的“零”是显式空数组。
function emptyPublished() { return { publishedIds: [], plans: [] }; }
// A/E：真实 legacy 店的历史消费回执（18/17/1）必须原样保留，绝不因收口被清空。
function historicAttempts() {
  const a = emptyAttempts();
  for (const [key, count] of [['consumed', 18], ['finalConsumed', 17], ['reopenConsumed', 1]]) {
    for (let i = 0; i < count; i += 1) {
      a[key][`historic-${i}`] = {
        status: 'success', businessDate: YESTERDAY, planNumber: (i % 3) + 1,
        runId: `historic-${i}`, at: '2026-10-17T01:00:00Z',
      };
    }
  }
  return a;
}

// 现网精确形状（2026-10-18 瑾漂亮遗留）：active 只有 preparing/份号/排程 runId/业务日，
// plans / confirmationConsumptions / manualUiPublicationFacts 全空，attempts 三表全空。
function preparingState(over) {
  const s = wf.newDayState(TODAY);
  s.active = {
    status: 'preparing', planNumber: 1, runId: RUN_ID, businessDate: TODAY,
    authorizedBy: 'recurring-user-policy',
    reason: 'scheduled-run-exception:Target page, context or browser has been closed',
  };
  return Object.assign(s, over || {});
}

// 生产真实遗留形状：active 恰为 4 个字段（status/planNumber/runId/businessDate）。
function sparsePreparingState() {
  const s = wf.newDayState(TODAY);
  s.active = { status: 'preparing', planNumber: 1, runId: RUN_ID, businessDate: TODAY };
  return s;
}
// 一般店（隔离 namespace）：shop-state/<slug>__<account>/ + own shop-identity.json
function isolatedRoot(shopName, account) {
  const root = tmp('f1-pub-');
  const dir = path.join(root, 'shop-state', shopProfile.shopSlug({ shop: shopName, accountId: account }));
  writeJson(path.join(dir, 'shop-identity.json'), { shop: shopName, accountId: account });
  writeJson(path.join(dir, 'plan-publisher-state.json'), preparingState());
  writeJson(path.join(dir, 'plan-publication-attempts.json'), emptyAttempts());
  writeJson(path.join(dir, 'published-products.json'), emptyPublished());
  return { root, dir };
}
// legacy 默认店：扁平文件直接在 publisher 根
function legacyRoot(attempts, state) {
  const root = tmp('f1-pub-legacy-');
  writeJson(path.join(root, 'plan-publisher-state.json'), state || preparingState());
  writeJson(path.join(root, 'plan-publication-attempts.json'), attempts || emptyAttempts());
  writeJson(path.join(root, 'published-products.json'), emptyPublished());
  return { root, dir: root };
}

// openShop / readers 一律抛错并计数：本地恢复只要碰浏览器就会立刻暴露。
function browserProbe() {
  const probe = { open: 0, pageReads: 0 };
  probe.openShop = () => { probe.open += 1; throw new Error('openShop must not be called'); };
  probe.readers = { openChengfangShop: () => { probe.pageReads += 1; throw new Error('reader must not be called'); } };
  probe.readAccountInPage = () => { probe.pageReads += 1; throw new Error('reader must not be called'); };
  return probe;
}

nodeTest.test('F1 一般店：当前精确 preparing 形状 → 严格证明 + 耐久收口（无浏览器），重复调用幂等', async () => {
  const { root, dir } = isolatedRoot(SHOP, ACCOUNT);
  try {
    const stateFile = path.join(dir, 'plan-publisher-state.json');
    const attemptsFile = path.join(dir, 'plan-publication-attempts.json');
    const attemptsBefore = fs.readFileSync(attemptsFile, 'utf8');
    const probe = browserProbe();

    const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY,
      { nowMs: NOW_MS, stateRoot: root, openShop: probe.openShop, readers: probe.readers, readAccountInPage: probe.readAccountInPage });
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.status, 'preparationClosed');
    assert.equal(res.planNumber, 1);
    assert.equal(res.runId, RUN_ID);
    assert.equal(res.accountId, ACCOUNT);
    assert.equal(res.legacy, false);
    assert.match(res.sourceHash, /^[0-9a-f]{64}$/);
    assert.equal(probe.open, 0, '本地恢复绝不打开店铺');
    assert.equal(probe.pageReads, 0, '本地恢复绝不读页面/身份');

    const after = readJson(stateFile);
    assert.equal(after.active.status, 'preparation-stopped');
    assert.equal(after.active.originalPhase, 'preparing');
    assert.equal(after.active.runId, RUN_ID);
    assert.equal(after.active.planNumber, 1);
    assert.equal(after.active.businessDate, TODAY);
    assert.equal(after.active.source, 'local-preparation-recovery');
    assert.equal(after.preparationClosureFacts.length, 1);
    const fact = after.preparationClosureFacts[0];
    assert.equal(fact.status, 'preparationClosed');
    assert.equal(fact.phase, 'preparing');
    assert.equal(fact.runId, RUN_ID);
    assert.equal(fact.planNumber, 1);
    assert.equal(fact.shop, SHOP);
    assert.equal(fact.accountId, ACCOUNT);
    assert.deepEqual(fact.zeroConsumptionProof, {
      initialConsumptions: 0, finalConsumptions: 0, reopenConsumptions: 0,
      manualUnresolved: 0, plansContainsNumber: false, confirmationConsumptionsRecorded: false,
    });
    assert.deepEqual(after.plans, [], 'plans 原样保留（不伪造成功）');
    assert.equal(fs.readFileSync(attemptsFile, 'utf8'), attemptsBefore, 'attempts 三表零改写');

    // 幂等：再次恢复由耐久事实重新派生同一证明，零再改写。
    const stateBytesAfterFirst = fs.readFileSync(stateFile, 'utf8');
    const again = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY,
      { nowMs: NOW_MS + 60000, stateRoot: root });
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.equal(again.status, 'preparationClosed');
    assert.equal(again.alreadyClosed, true);
    assert.equal(again.runId, RUN_ID);
    assert.equal(again.planNumber, 1);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBytesAfterFirst, '重复恢复不新增条目/事实');
    assert.equal(readJson(stateFile).preparationClosureFacts.length, 1);
    assert.equal(probe.open, 0);
  } finally { cleanup(root); }
});

nodeTest.test('F1 legacy 默认店：accountId=null 只由 wf.BUSINESS 默认 profile 精确绑定，历史 18/17/1 原样保留', async () => {
  const { root } = legacyRoot(historicAttempts(), sparsePreparingState());
  try {
    const attemptsFile = path.join(root, 'plan-publication-attempts.json');
    const attemptsBefore = fs.readFileSync(attemptsFile, 'utf8');
    const probe = browserProbe();
    // 生产真实配置：legacy 店 accountId=null（用户不需要补账户）。
    const res = await rp.recoverLocalPreparationClose(
      { shop: wf.BUSINESS.shop, accountId: null }, TODAY,
      { nowMs: NOW_MS, stateRoot: root, openShop: probe.openShop, readers: probe.readers },
    );
    assert.equal(res.ok, true, JSON.stringify(res));
    assert.equal(res.status, 'preparationClosed');
    assert.equal(res.legacy, true);
    assert.equal(res.accountId, wf.BUSINESS.accountId, '绑定解析出的可信账号，绝不把 null 当身份');
    assert.equal(readJson(path.join(root, 'plan-publisher-state.json')).active.status, 'preparation-stopped');
    assert.equal(fs.readFileSync(attemptsFile, 'utf8'), attemptsBefore, '历史 18/17/1 回执必须逐字保留');
    const after = readJson(attemptsFile);
    assert.equal(Object.keys(after.consumed).length, 18);
    assert.equal(Object.keys(after.finalConsumed).length, 17);
    assert.equal(Object.keys(after.reopenConsumed).length, 1);
    assert.equal(probe.open, 0);

    // 显式默认账户同样走 legacy 根（同店同账户）。
    const again = await rp.recoverLocalPreparationClose(
      { shop: wf.BUSINESS.shop, accountId: wf.BUSINESS.accountId }, TODAY, { nowMs: NOW_MS, stateRoot: root },
    );
    assert.equal(again.status, 'preparationClosed', JSON.stringify(again));
    assert.equal(again.alreadyClosed, true);

    // 同名 + 另一个账户：不是 legacy 默认 profile，绝不借用 legacy 根（隔离目录不存在 → 不恢复）。
    const other = await rp.recoverLocalPreparationClose(
      { shop: wf.BUSINESS.shop, accountId: OTHER_ACCOUNT }, TODAY, { nowMs: NOW_MS, stateRoot: root },
    );
    assert.equal(other.ok, true, JSON.stringify(other));
    assert.equal(other.status, 'nothingToRecover');
    assert.equal(other.reason, 'local-recovery-state-dir-missing');
  } finally { cleanup(root); }
});

nodeTest.test('F1 legacy 默认店：同名隔离目录存在 → 歧义拒绝（绝不猜第一个目录）', async () => {
  const { root } = legacyRoot();
  try {
    const dir = path.join(root, 'shop-state', shopProfile.shopSlug({ shop: wf.BUSINESS.shop, accountId: OTHER_ACCOUNT }));
    writeJson(path.join(dir, 'shop-identity.json'), { shop: wf.BUSINESS.shop, accountId: OTHER_ACCOUNT });
    const stateFile = path.join(root, 'plan-publisher-state.json');
    const before = fs.readFileSync(stateFile, 'utf8');
    const res = await rp.recoverLocalPreparationClose(
      { shop: wf.BUSINESS.shop, accountId: null }, TODAY, { nowMs: NOW_MS, stateRoot: root },
    );
    assert.equal(res.ok, false, JSON.stringify(res));
    assert.match(res.reason, /^local-recovery-legacy-isolated-dir-present:/);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  } finally { cleanup(root); }
});

nodeTest.test('F1 负例：任何消费痕迹/冻结件/错 runId/错份号/跨日 → 零改写（绝不把未知当零消费）', async () => {
  const cases = [
    {
      name: 'attempts 同日同份初始消费（unknown 也算消费痕迹）',
      mutate: ({ attempts }) => { attempts.consumed['conf-x'] = { businessDate: TODAY, planNumber: 1, status: 'unknown', runId: RUN_ID }; },
      expect: /local-recovery-not-proven:consumed-consumption-for-run/,
    },
    {
      name: 'attempts 手动未决',
      mutate: ({ attempts }) => { attempts.consumed['conf-manual'] = { businessDate: TODAY, planNumber: 2, status: 'pending' }; },
      expect: /local-recovery-not-proven:(manual-unresolved-present|consumed-consumption-for-same-day-plan)/,
    },
    {
      name: 'confirmationConsumptions 同日同份',
      mutate: ({ state }) => { state.confirmationConsumptions.push({ businessDate: TODAY, planNumber: 1, runId: 'other' }); },
      expect: /local-recovery-not-proven:confirmation-consumption-recorded/,
    },
    {
      name: 'plans 已含本份',
      mutate: ({ state }) => { state.plans.push({ planNumber: 1, status: 'success' }); },
      expect: /local-recovery-not-proven:plan-number-already-in-plans/,
    },
    {
      name: 'active 已带确认件（frozen/CID）',
      mutate: ({ state }) => { state.active.confirmationId = 'conf-frozen'; state.active.frozen = { confirmationId: 'conf-frozen' }; },
      expect: /local-recovery-not-proven:confirmation-artifacts-present/,
    },
    {
      name: 'manualUiPublicationFacts 同日同份',
      mutate: ({ state }) => { state.manualUiPublicationFacts.push({ businessDate: TODAY, planNumber: 1, status: 'published-success' }); },
      expect: /local-recovery-not-proven:manual-publication-recorded/,
    },
    {
      name: '日级 unknown 旗标',
      mutate: ({ state }) => { state.unknown = true; },
      expect: /local-recovery-not-proven:day-state-unresolved-flag-present/,
    },
    {
      name: 'runId 不是排程 origin（随机 16hex 不能由店名重算/伪造）',
      mutate: ({ state }) => { state.active.runId = 'manual-run-' + TODAY; },
      expect: /local-recovery-not-proven:run-origin-not-scheduled/,
    },
    {
      name: 'runId 内嵌另一业务日',
      mutate: ({ state }) => { state.active.runId = 'plan-scheduler-' + YESTERDAY + '-3120879ff739e107'; },
      expect: /local-recovery-not-proven:run-origin-not-scheduled/,
    },
    {
      name: '跨日状态（昨天 preparing）',
      mutate: ({ state }) => { state.businessDate = YESTERDAY; state.active.businessDate = YESTERDAY; },
      expect: /local-recovery-state-business-date-mismatch/,
    },
    {
      name: '错份号请求（第 2 份）',
      mutate: () => {},
      opts: { planNumber: 2 },
      expect: /local-recovery-plan-number-mismatch/,
    },
  ];
  for (const c of cases) {
    const { root, dir } = isolatedRoot(SHOP, ACCOUNT);
    try {
      const stateFile = path.join(dir, 'plan-publisher-state.json');
      const attemptsFile = path.join(dir, 'plan-publication-attempts.json');
      const state = readJson(stateFile);
      const attempts = readJson(attemptsFile);
      c.mutate({ state, attempts });
      writeJson(stateFile, state);
      writeJson(attemptsFile, attempts);
      const stateBefore = fs.readFileSync(stateFile, 'utf8');
      const attemptsBefore = fs.readFileSync(attemptsFile, 'utf8');
      const probe = browserProbe();
      const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY,
        Object.assign({ nowMs: NOW_MS, stateRoot: root, openShop: probe.openShop, readers: probe.readers }, c.opts || {}));
      assert.equal(res.status === 'preparationClosed', false, c.name + ' → ' + JSON.stringify(res));
      assert.match(String(res.reason || ''), c.expect, c.name + ' → ' + JSON.stringify(res));
      assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBefore, c.name + '：状态文件必须零改动');
      assert.equal(fs.readFileSync(attemptsFile, 'utf8'), attemptsBefore, c.name + '：attempts 必须零改动');
      assert.equal(probe.open, 0, c.name + '：绝不打开浏览器');
    } finally { cleanup(root); }
  }
});

nodeTest.test('F1 负例：缺文件/损坏/错型/身份冲突/身份歧义/锁忙 → 拒绝且零改写', async () => {
  // 1) attempts 文件缺失：绝不把"文件不存在"当成零消费
  {
    const { root, dir } = isolatedRoot(SHOP, ACCOUNT);
    try {
      const attemptsFile = path.join(dir, 'plan-publication-attempts.json');
      fs.unlinkSync(attemptsFile);
      const stateFile = path.join(dir, 'plan-publisher-state.json');
      const before = fs.readFileSync(stateFile, 'utf8');
      const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY, { nowMs: NOW_MS, stateRoot: root });
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'local-recovery-attempts-file-missing');
      assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
    } finally { cleanup(root); }
  }
  // 2) 状态文件损坏
  {
    const { root, dir } = isolatedRoot(SHOP, ACCOUNT);
    try {
      const stateFile = path.join(dir, 'plan-publisher-state.json');
      fs.writeFileSync(stateFile, '{ not json');
      const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY, { nowMs: NOW_MS, stateRoot: root });
      assert.equal(res.ok, false);
      assert.match(res.reason, /^local-recovery-state-unreadable:/);
      assert.equal(fs.readFileSync(stateFile, 'utf8'), '{ not json');
    } finally { cleanup(root); }
  }
  // 3) manualUiPublicationFacts 错型（不是数组）
  {
    const { root, dir } = isolatedRoot(SHOP, ACCOUNT);
    try {
      const stateFile = path.join(dir, 'plan-publisher-state.json');
      const state = readJson(stateFile);
      state.manualUiPublicationFacts = { planNumber: 1 };
      writeJson(stateFile, state);
      const before = fs.readFileSync(stateFile, 'utf8');
      const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY, { nowMs: NOW_MS, stateRoot: root });
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'local-recovery-manual-facts-unreadable');
      assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
    } finally { cleanup(root); }
  }
  // 4) identity 账户与请求账户冲突
  {
    const { root, dir } = isolatedRoot(SHOP, ACCOUNT);
    try {
      writeJson(path.join(dir, 'shop-identity.json'), { shop: SHOP, accountId: OTHER_ACCOUNT });
      const stateFile = path.join(dir, 'plan-publisher-state.json');
      const before = fs.readFileSync(stateFile, 'utf8');
      const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY, { nowMs: NOW_MS, stateRoot: root });
      assert.equal(res.ok, false);
      assert.match(res.reason, /^local-recovery-identity-conflict:/);
      assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
    } finally { cleanup(root); }
  }
  // 5) 同名多账户目录 + 账户未知 → 歧义拒绝（绝不猜第一家）
  {
    const root = tmp('f1-pub-amb-');
    try {
      for (const account of [ACCOUNT, OTHER_ACCOUNT]) {
        const dir = path.join(root, 'shop-state', shopProfile.shopSlug({ shop: SHOP, accountId: account }));
        writeJson(path.join(dir, 'shop-identity.json'), { shop: SHOP, accountId: account });
        writeJson(path.join(dir, 'plan-publisher-state.json'), preparingState());
        writeJson(path.join(dir, 'plan-publication-attempts.json'), emptyAttempts());
      }
      const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: null }, TODAY, { nowMs: NOW_MS, stateRoot: root });
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'local-recovery-identity-ambiguous:2');
      assert.equal(readJson(path.join(root, 'shop-state', shopProfile.shopSlug({ shop: SHOP, accountId: ACCOUNT }), 'plan-publisher-state.json')).active.status, 'preparing');
    } finally { cleanup(root); }
  }
  // 6) publisher 真实互斥锁被活进程持有 → 不抢占、零改写
  {
    const { root, dir } = isolatedRoot(SHOP, ACCOUNT);
    try {
      const lockFile = path.join(dir, 'plan-publisher.lock');
      fs.writeFileSync(lockFile, JSON.stringify({
        pid: process.pid, startedAt: new Date(NOW_MS).toISOString(), token: 'a'.repeat(32),
      }));
      const stateFile = path.join(dir, 'plan-publisher-state.json');
      const before = fs.readFileSync(stateFile, 'utf8');
      const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY, { nowMs: NOW_MS, stateRoot: root });
      assert.equal(res.ok, false);
      assert.equal(res.status, 'locked');
      assert.match(res.reason, /^local-recovery-publisher-lock-busy:/);
      assert.equal(fs.readFileSync(stateFile, 'utf8'), before, '锁忙时零改写');
      assert.ok(fs.existsSync(lockFile), '不删除别人的活锁');
      fs.unlinkSync(lockFile);
    } finally { cleanup(root); }
  }
  // 7) 没有该店任何状态目录 → nothingToRecover（不是失败，也绝不跨店借用）
  {
    const root = tmp('f1-pub-none-');
    try {
      const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY, { nowMs: NOW_MS, stateRoot: root });
      assert.equal(res.ok, true);
      assert.equal(res.status, 'nothingToRecover');
      assert.equal(res.reason, 'local-recovery-state-dir-missing');
    } finally { cleanup(root); }
  }
});

nodeTest.test('F1-R2 B：三表缺表/错型一律不可知（绝不把 guard 默认补表当零消费）', async () => {
  for (const key of ['consumed', 'finalConsumed', 'reopenConsumed']) {
    for (const kind of ['missing', 'null', 'array', 'number']) {
      const { root, dir } = isolatedRoot(SHOP, ACCOUNT);
      try {
        const stateFile = path.join(dir, 'plan-publisher-state.json');
        const attemptsFile = path.join(dir, 'plan-publication-attempts.json');
        const attempts = readJson(attemptsFile);
        if (kind === 'missing') delete attempts[key];
        else attempts[key] = kind === 'null' ? null : kind === 'array' ? [] : 1;
        writeJson(attemptsFile, attempts);
        const stateBefore = fs.readFileSync(stateFile, 'utf8');
        const attemptsBefore = fs.readFileSync(attemptsFile, 'utf8');
        const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY,
          { nowMs: NOW_MS, stateRoot: root });
        assert.notEqual(res.status, 'preparationClosed', `${key}/${kind} → ${JSON.stringify(res)}`);
        assert.match(String(res.reason || ''), /local-recovery-attempts-table-(missing|malformed):/);
        assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBefore, `${key}/${kind}：状态零改写`);
        assert.equal(fs.readFileSync(attemptsFile, 'utf8'), attemptsBefore, `${key}/${kind}：attempts 零改写`);
      } finally { cleanup(root); }
    }
  }
});

nodeTest.test('F1-R2 C：published store 同日同份/同 run/缺失/坏 JSON/错型 → 拒绝且零改写', async () => {
  const cases = [
    { name: '同日同份', value: { publishedIds: [], plans: [{ businessDate: TODAY, planNumber: 1, runId: RUN_ID, planId: 'synthetic', status: 'success' }] }, expect: /local-recovery-published-plan-recorded/ },
    { name: '同 runId', value: { publishedIds: [], plans: [{ planId: 'synthetic', date: TODAY, runId: RUN_ID }] }, expect: /local-recovery-published-run-recorded/ },
    { name: '缺失', missing: true, expect: /local-recovery-published-store-missing/ },
    { name: '坏 JSON', raw: '{ not json', expect: /local-recovery-published-store-corrupt/ },
    { name: 'plans 错型', value: { publishedIds: [], plans: {} }, expect: /local-recovery-published-plans-unreadable/ },
  ];
  for (const c of cases) {
    const { root, dir } = isolatedRoot(SHOP, ACCOUNT);
    try {
      const stateFile = path.join(dir, 'plan-publisher-state.json');
      const pubFile = path.join(dir, 'published-products.json');
      if (c.missing) fs.unlinkSync(pubFile);
      else if (c.raw) fs.writeFileSync(pubFile, c.raw);
      else writeJson(pubFile, c.value);
      const stateBefore = fs.readFileSync(stateFile, 'utf8');
      const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY,
        { nowMs: NOW_MS, stateRoot: root });
      assert.notEqual(res.status, 'preparationClosed', c.name + ' → ' + JSON.stringify(res));
      assert.match(String(res.reason || ''), c.expect, c.name + ' → ' + JSON.stringify(res));
      assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBefore, c.name + '：状态零改写');
    } finally { cleanup(root); }
  }
});

nodeTest.test('F1-R2 D：收口后新增同 run 消费 → 重复恢复拒绝，不借旧 fact 直接复用', async () => {
  const { root, dir } = isolatedRoot(SHOP, ACCOUNT);
  try {
    const stateFile = path.join(dir, 'plan-publisher-state.json');
    const attemptsFile = path.join(dir, 'plan-publication-attempts.json');
    const first = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY,
      { nowMs: NOW_MS, stateRoot: root });
    assert.equal(first.status, 'preparationClosed', JSON.stringify(first));
    const stateBefore = fs.readFileSync(stateFile, 'utf8');
    const attempts = readJson(attemptsFile);
    attempts.consumed.newtrace = { status: 'unknown', businessDate: TODAY, planNumber: 1, runId: RUN_ID };
    writeJson(attemptsFile, attempts);
    const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY,
      { nowMs: NOW_MS + 60000, stateRoot: root });
    assert.notEqual(res.status, 'preparationClosed', JSON.stringify(res));
    assert.match(String(res.reason || ''), /local-recovery-not-proven:consumed-consumption-for-run/);
    assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBefore, '重复恢复拒绝时状态零改写');
  } finally { cleanup(root); }
});

nodeTest.test('F1-R3 A：原生 published 形状（date/planId）——历史日保留、当日无法归因拒绝、可归因其它已成功份保留', async () => {
  // 1) 历史日记录（生产真实形状 {planId,date}）不阻断本日第 1 份恢复，且发布文件逐字保留。
  {
    const { root, dir } = isolatedRoot(SHOP, ACCOUNT);
    try {
      const pubFile = path.join(dir, 'published-products.json');
      const stateFile = path.join(dir, 'plan-publisher-state.json');
      const historical = {
        seeded: false, seededFrom: null, publishedIds: ['hist-product-1', 'hist-product-2'],
        plans: [
          { planId: 'pub-2026-10-08-1', date: '2026-10-08' },
          { planId: 'pub-2026-10-16-2', date: '2026-10-16' },
          { planId: 'pub-2026-10-17-3', date: '2026-10-17' },
        ],
      };
      writeJson(pubFile, historical);
      const pubBefore = fs.readFileSync(pubFile, 'utf8');
      const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY,
        { nowMs: NOW_MS, stateRoot: root });
      assert.equal(res.status, 'preparationClosed', JSON.stringify(res));
      assert.equal(readJson(stateFile).active.status, 'preparation-stopped');
      assert.equal(fs.readFileSync(pubFile, 'utf8'), pubBefore, '历史发布记录逐字保留');
    } finally { cleanup(root); }
  }
  // 2) 当日原生记录无法用同店 day-state success planId 归因 → 拒绝零发布。
  {
    const { root, dir } = isolatedRoot(SHOP, ACCOUNT);
    try {
      const pubFile = path.join(dir, 'published-products.json');
      const stateFile = path.join(dir, 'plan-publisher-state.json');
      writeJson(pubFile, { seeded: false, seededFrom: null, publishedIds: [], plans: [{ planId: '1234567890123456', date: TODAY }] });
      const stateBefore = fs.readFileSync(stateFile, 'utf8');
      const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY,
        { nowMs: NOW_MS, stateRoot: root });
      assert.notEqual(res.status, 'preparationClosed', JSON.stringify(res));
      assert.match(String(res.reason || ''), /local-recovery-published-plan-unattributed/);
      assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBefore, '状态零改写');
    } finally { cleanup(root); }
  }
  // 3) 当日记录可归因到同店已成功第 1 份 → 第 2 份仍可恢复（不因“今日有历史”一刀切）。
  {
    const { root, dir } = isolatedRoot(SHOP, ACCOUNT);
    try {
      const stateFile = path.join(dir, 'plan-publisher-state.json');
      const pubFile = path.join(dir, 'published-products.json');
      const state = preparingState();
      state.plans = [{ planNumber: 1, status: 'success', planId: 'pub-plan-1' }];
      state.active = { status: 'preparing', planNumber: 2, runId: 'plan-scheduler-' + TODAY + '-aaaaaaaaaaaaaaaa', businessDate: TODAY };
      writeJson(stateFile, state);
      writeJson(pubFile, { seeded: false, seededFrom: null, publishedIds: ['hist-product-1'], plans: [{ planId: 'pub-plan-1', date: TODAY }] });
      const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY,
        { nowMs: NOW_MS, stateRoot: root });
      assert.equal(res.status, 'preparationClosed', JSON.stringify(res));
      assert.equal(res.planNumber, 2);
      assert.equal(readJson(stateFile).active.status, 'preparation-stopped');
      assert.equal(readJson(stateFile).plans.length, 1, '既有成功份原样保留');
    } finally { cleanup(root); }
  }
  // 4) date 与 businessDate 冲突 → 拒绝（不猜哪个日期为准）。
  {
    const { root, dir } = isolatedRoot(SHOP, ACCOUNT);
    try {
      const pubFile = path.join(dir, 'published-products.json');
      const stateFile = path.join(dir, 'plan-publisher-state.json');
      writeJson(pubFile, { publishedIds: [], plans: [{ planId: 'conflict', date: TODAY, businessDate: YESTERDAY }] });
      const stateBefore = fs.readFileSync(stateFile, 'utf8');
      const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY,
        { nowMs: NOW_MS, stateRoot: root });
      assert.notEqual(res.status, 'preparationClosed', JSON.stringify(res));
      assert.match(String(res.reason || ''), /local-recovery-published-date-conflict/);
      assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBefore);
    } finally { cleanup(root); }
  }
});

nodeTest.test('F1-R3 B：publishedIds 缺失/null/非数组（错型）→ 拒绝且状态与 attempts 零改写', async () => {
  const cases = [
    { name: '缺失', build: () => ({ plans: [] }) },
    { name: 'null', build: () => ({ publishedIds: null, plans: [] }) },
    { name: '对象', build: () => ({ publishedIds: {}, plans: [] }) },
    { name: '字符串', build: () => ({ publishedIds: '[]', plans: [] }) },
    { name: '数字', build: () => ({ publishedIds: 1, plans: [] }) },
  ];
  for (const c of cases) {
    const { root, dir } = isolatedRoot(SHOP, ACCOUNT);
    try {
      const pubFile = path.join(dir, 'published-products.json');
      const stateFile = path.join(dir, 'plan-publisher-state.json');
      const attemptsFile = path.join(dir, 'plan-publication-attempts.json');
      writeJson(pubFile, c.build());
      const stateBefore = fs.readFileSync(stateFile, 'utf8');
      const attemptsBefore = fs.readFileSync(attemptsFile, 'utf8');
      const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY,
        { nowMs: NOW_MS, stateRoot: root });
      assert.notEqual(res.status, 'preparationClosed', c.name + ' → ' + JSON.stringify(res));
      assert.match(String(res.reason || ''), /local-recovery-published-ids-unreadable/, c.name + ' → ' + JSON.stringify(res));
      assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBefore, c.name + '：状态零改写');
      assert.equal(fs.readFileSync(attemptsFile, 'utf8'), attemptsBefore, c.name + '：attempts 零改写');
    } finally { cleanup(root); }
  }
});

nodeTest.test('F1-R3 C：close 前 published 漂移 → 写前 CAS 拒绝，state 零改写（不是先写再回读）', async () => {
  const { root, dir } = isolatedRoot(SHOP, ACCOUNT);
  try {
    const stateFile = path.join(dir, 'plan-publisher-state.json');
    const attemptsFile = path.join(dir, 'plan-publication-attempts.json');
    const pubFile = path.join(dir, 'published-products.json');
    const stateBefore = fs.readFileSync(stateFile, 'utf8');
    const attemptsBefore = fs.readFileSync(attemptsFile, 'utf8');
    let mutated = false;
    const res = await rp.recoverLocalPreparationClose({ shop: SHOP, accountId: ACCOUNT }, TODAY, {
      stateRoot: root,
      nowMs: () => {
        if (!mutated) {
          mutated = true;
          // close helper 第一次取时间时把发布事实面换成“同日同份已发布”——必须在落盘前被 CAS 拦住。
          writeJson(pubFile, { publishedIds: [], plans: [{ businessDate: TODAY, planNumber: 1, runId: RUN_ID, planId: '1234567890123456' }] });
        }
        return NOW_MS;
      },
    });
    assert.notEqual(res.status, 'preparationClosed', JSON.stringify(res));
    assert.match(String(res.reason || ''), /local-recovery-source-drift-before-close/, JSON.stringify(res));
    assert.equal(fs.readFileSync(stateFile, 'utf8'), stateBefore, '漂移时 state 必须零改写');
    assert.equal(fs.readFileSync(attemptsFile, 'utf8'), attemptsBefore, '漂移时 attempts 必须零改写');
    assert.equal(readJson(stateFile).active.status, 'preparing', '绝不先写后改回');
    assert.notEqual(readJson(pubFile).plans.length, 0, '不删除/不改回漂移后的发布事实');
  } finally { cleanup(root); }
});

nodeTest.test('F1 静态边界：本测试只用 fake Cookie 常量，不读任何真实凭据', () => {
  assert.equal(FAKE_COOKIE, 'FAKE_VALUE_NOT_REAL');
  const src = fs.readFileSync(__filename, 'utf8');
  assert.equal(/cookieFile\s*:|\.cookies\(/.test(src), false, '测试不得触碰 Cookie 读取面');
});
