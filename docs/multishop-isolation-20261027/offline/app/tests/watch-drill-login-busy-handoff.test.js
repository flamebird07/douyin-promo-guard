'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const workspace = path.resolve(__dirname, '..', '..');
const watchFile = path.resolve(process.env.WATCH_DRILL_MODULE || path.join(workspace, 'app/watch-drill.js'));
const monitorFile = path.join(workspace, 'guard/src/engine/monitor.js');
const watchSource = fs.readFileSync(watchFile, 'utf8');
const monitorSource = fs.readFileSync(monitorFile, 'utf8');

function loadIsolated(file, source, requireFn) {
  const isolated = new Module(file, module);
  isolated.filename = file;
  isolated.require = requireFn;
  isolated._compile(source, file);
  return isolated.exports;
}

async function flush() {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function fixture(t, { enabled = false, running = true, stateError = null, dataError = null } = {}) {
  const forbiddenCalls = [];
  const forbid = (name) => () => {
    forbiddenCalls.push(name);
    throw new Error(`forbidden boundary: ${name}`);
  };
  const unavailable = (name) => new Proxy({}, { get: (_, key) => forbid(`${name}.${String(key)}`) });
  const fakeFs = new Proxy({}, {
    get(_, key) {
      if (key === 'existsSync') return (file) => String(file).replace(/\\/g, '/').endsWith('/src/engine/monitor.js');
      return forbid(`fs.${String(key)}`);
    },
  });
  class AuthError extends Error {}
  class NotConnectedError extends Error {}
  const resolveDependency = (id) => {
    if (id === 'fs') return fakeFs;
    if (id === 'path') return path;
    const normalized = id.replace(/\\/g, '/').replace(/\.js$/, '');
    if (normalized.endsWith('/lib/errors')) return { AuthError, NotConnectedError };
    if (normalized.endsWith('/lib/log')) return { compactUrls: (value) => value };
    if (normalized.endsWith('/lib/money')) return { centsToYuan: (value) => String(value / 100) };
    if (normalized.endsWith('/lib/time')) return { shanghaiDate: () => '2026-10-29', shanghaiClockText: () => '12:30:00' };
    if (normalized === './rules' || normalized.endsWith('/engine/rules')) return { SPEND_FLOOR_CENTS: 5000 };
    if (normalized.endsWith('/lib/bounded-poll')) return { resolvePollingConfig: () => ({ timeoutMs: 30000, intervalMs: 2000 }) };
    return unavailable(id);
  };
  // Compile unchanged entrypoints; never import adapters, construct Monitor, or probe production files.
  const { createWatchDrill } = loadIsolated(watchFile, watchSource, resolveDependency);
  const { Monitor } = loadIsolated(monitorFile, monitorSource, resolveDependency);
  let now = Date.UTC(2026, 9, 29, 4, 30);
  const sleeps = [];
  const delayFn = (ms) => new Promise((resolve) => { sleeps.push({ ms, resolve }); });
  const clock = {
    sleeps,
    now: () => now,
    async step(advance) {
      assert.ok(sleeps.length > 0, 'a bounded handoff wait must be pending');
      const next = sleeps.shift();
      now += advance === undefined ? next.ms : advance;
      next.resolve();
      await flush();
    },
  };
  const shops = ['a', 'b', 'c'].map((id) => ({
    id, name: `shop-${id}`, cookieFile: `shop-${id}.json`, platform: 'douyin',
    accountId: `account-${id}`, compassShopName: `shop-${id}`, enabled, deleted: false,
    thresholdCents: 193, targetRoi: 13.5,
  }));
  const config = {
    shops, schedule: { intervalMinutes: 1 }, execution: { realMode: false, dryRun: true },
    planPublishing: { enabled: true, autoConfirm: true },
  };
  const initialConfig = JSON.stringify(config);
  const sessions = new Map(shops.map((shop) => [shop.id, { revision: 1, costCents: 101, orders: 1 }]));
  const runtimes = new Map(shops.map((shop) => [shop.id, { lastData: { costCents: 7, orders: 0 }, lastDataAt: 'old' }]));
  const reads = [];
  const readHolds = new Map();
  let activeReads = 0;
  let peakReads = 0;
  const monitor = Object.create(Monitor.prototype);
  Object.assign(monitor, {
    config, pending: [], running, nowFn: clock.now, _gen: 0,
    _shopProcessing: new Set(), _cycleRunning: false, _readRecoveries: new Map(),
    _pendingReadGates: new Map(), _pendingReadGate: null, _cleanupRegistry: new Map(),
    _readGateSeq: 0, _readPermits: new Map(), recentErrors: [],
    _runtime: (id) => runtimes.get(id),
    _readRecoveryView: () => ({ attempts: 1, maxRetries: 10 }),
    _getCoordinator: () => ({
      async readAndEvaluate(shop, options) {
        assert.deepEqual(options, { readOnlyRefresh: true });
        assert.equal(monitor._shopBusy(shop.id), true, 'the real Monitor must own the shop lock');
        assert.equal(activeReads, 0, 'no overlapping readonly sessions');
        const saved = { ...sessions.get(shop.id) };
        reads.push({ shopId: shop.id, ...saved });
        peakReads = Math.max(peakReads, ++activeReads);
        try {
          if (readHolds.has(shop.id)) await readHolds.get(shop.id).promise;
          return dataError || { ok: true, ...saved };
        } finally {
          activeReads -= 1;
        }
      },
    }),
    _summarizeData: (data) => ({ costCents: data.costCents, orders: data.orders }),
    _readCurrentAdState: t.mock.fn(async () => stateError ? { error: stateError } : {
      state: 'off', balance: { balanceCents: 900, balanceAt: new Date(now).toISOString() },
    }),
    _clearReadFailure: () => {},
    _applyReadFailure: (id, error) => { runtimes.get(id).lastReadError = error; },
    _applyObservedAdState: (id, state) => { runtimes.get(id).lastAdState = state; },
    _audit: t.mock.fn(),
    gatePreview: () => ({ pauseAllowed: false, enableAllowed: false }),
    getStatus: () => ({
      monitor: { phase: running ? 'running' : 'stopped', cycleNo: 0, enablePhaseToday: [] },
      shops: config.shops.map((shop) => ({ ...shop, today: runtimes.get(shop.id)?.lastData,
        lastDataAt: runtimes.get(shop.id)?.lastDataAt, lastAdState: runtimes.get(shop.id)?.lastAdState })),
      rules: [],
    }),
    getEventStream: () => ({ events: [], seq: 0, droppedCount: 0, dropped: [] }),
    requestShopDiscovery: t.mock.fn(() => ({ ok: true, added: [], persisted: true })),
  });
  for (const name of ['joinShopNow', 'restoreDeletedShop', 'pollOnce', 'pollNowAndReschedule',
    'start', 'startEnableScheduler', 'resumeEnableScheduler', '_persistShopsToConfig', '_saveState',
    '_discoverShopsFromCookies', '_runShopEnablePhase', '_pollShop']) monitor[name] = forbid(name);
  const realRefresh = Monitor.prototype.refreshShopData;
  monitor.refreshShopData = t.mock.fn((id, ...args) => {
    assert.equal(args.length, 0, 'no skipBusy or guard-bypass options');
    return realRefresh.call(monitor, id);
  });
  const wd = createWatchDrill({ config, nowFn: clock.now, delayFn, autostartOnBoot: false });
  wd._internal._monitor = monitor;
  const login = (id = 'a') => wd.joinShopAfterLogin({ shopName: `shop-${id}`, platform: 'douyin' });
  const assertSafe = ({ discovery = 0, configChanged = false } = {}) => {
    assert.deepEqual(forbiddenCalls, [], 'no login, browser, network, advertising, publishing, filesystem or config writes');
    if (!configChanged) assert.equal(JSON.stringify(config), initialConfig);
    assert.equal(monitor.requestShopDiscovery.mock.callCount(), discovery, 'no extra discovery during waiting or completion');
    assert.equal(wd._internal._planScheduler, null);
    assert.equal(wd._internal._discoveryRecoveries.size, 0);
    assert.equal(wd._internal._loginJoins.size, 0);
  };
  t.after(() => assert.deepEqual(forbiddenCalls, []));
  return { wd, monitor, config, shops, sessions, runtimes, reads, readHolds, clock, login, assertSafe,
    peakReads: () => peakReads };
}

test('D26 old same-shop inflight then unlock: one coalesced readonly read uses latest saved session and fresh data', async (t) => {
  const f = fixture(t);
  assert.equal(f.monitor._tryAcquireShop('a'), true);
  const first = f.login();
  await flush();
  assert.equal(f.wd.state.loginJoins.a.status, 'processing', 'baseline drops shop_busy as failed');
  assert.equal(f.wd._internal._loginJoins.size, 1);
  assert.equal(f.reads.length, 0);
  assert.equal(f.runtimes.get('a').lastData.costCents, 7);
  f.sessions.set('a', { revision: 2, costCents: 202, orders: 2 });
  const second = f.login();
  await f.clock.step();
  f.sessions.set('a', { revision: 3, costCents: 303, orders: 3 });
  const third = f.login();
  assert.equal(second.merged, true);
  assert.equal(third.merged, true);
  assert.strictEqual(first.completion, second.completion);
  assert.strictEqual(first.completion, third.completion);
  assert.equal(f.clock.sleeps.length, 1, 'one pending handoff, not one timer per login');
  f.monitor._releaseShop('a');
  await f.clock.step();
  const result = await first.completion;
  assert.equal(result.readBack.ok, true);
  assert.equal(result.readBack.costCents, 303);
  assert.equal(result.readBack.orders, 3);
  assert.deepEqual(f.reads, [{ shopId: 'a', revision: 3, costCents: 303, orders: 3 }]);
  assert.equal(f.monitor._readCurrentAdState.mock.callCount(), 1);
  assert.equal(f.wd.state.loginJoins.a.status, 'done');
  assert.equal(f.wd.state.shopRows.find((shop) => shop.id === 'a').costCents, 303);
  assert.equal(f.wd.state.shopRows.find((shop) => shop.id === 'a').lastDataAt, new Date(f.clock.now()).toISOString());
  assert.equal(f.wd.state.shopRows.find((shop) => shop.id === 'a').balanceCents, 900);
  assert.equal(f.monitor._shopProcessing.size, 0);
  assert.equal(f.clock.sleeps.length, 0);
  f.assertSafe();
});

test('D26 repeat login during actual readonly read merges without opening a second session', async (t) => {
  const f = fixture(t);
  const hold = deferred();
  f.readHolds.set('a', hold);
  const first = f.login();
  await flush();
  const second = f.login();
  assert.strictEqual(first.completion, second.completion);
  assert.equal(second.merged, true);
  assert.equal(f.reads.length, 1);
  hold.resolve();
  assert.equal((await first.completion).readBack.ok, true);
  assert.equal(f.reads.length, 1);
  assert.equal(f.clock.sleeps.length, 0);
  f.assertSafe();
});

for (const change of ['deleted', 'removed', 'monitor', 'id', 'name', 'cookieFile', 'platform', 'accountId', 'compassShopName', 'ambiguous']) {
  test(`D26 pending target ${change}: cancel without another refresh or stale success`, async (t) => {
    const f = fixture(t);
    f.monitor._tryAcquireShop('a');
    const joined = f.login();
    await flush();
    assert.equal(f.wd.state.loginJoins.a.status, 'processing');
    if (change === 'deleted') f.shops[0].deleted = true;
    else if (change === 'removed') f.config.shops = f.shops.slice(1);
    else if (change === 'monitor') f.wd._internal._monitor = null;
    else if (change === 'ambiguous') f.config.shops.push({ id: 'duplicate', name: 'shop-a', enabled: false });
    else f.shops[0][change] = 'changed-identity';
    f.monitor._releaseShop('a');
    await f.clock.step();
    const result = await joined.completion;
    assert.equal(result.readBack.ok, false);
    assert.match(result.readBack.reason, /取消/);
    assert.equal(f.monitor.refreshShopData.mock.callCount(), 1);
    assert.equal(f.reads.length, 0);
    assert.equal(f.wd.state.loginJoins.a.status, 'failed');
    assert.ok(f.wd.state.loginJoins.a.finishedAt);
    f.assertSafe({ configChanged: change !== 'monitor' });
  });
}

test('D26 busy wait expires at existing join bound; repeat login cannot extend deadline or release old lock', async (t) => {
  const f = fixture(t);
  f.monitor._tryAcquireShop('a');
  const joined = f.login();
  await flush();
  await f.clock.step(119800);
  assert.equal(f.wd.state.loginJoins.a.status, 'processing');
  assert.strictEqual(f.login().completion, joined.completion);
  await f.clock.step(200);
  const result = await joined.completion;
  assert.equal(result.readBack.ok, false);
  assert.equal(result.readBack.blocked, 'shop_busy');
  assert.match(result.readBack.reason, /超时/);
  assert.equal(f.wd.state.loginJoins.a.status, 'failed');
  assert.equal(f.monitor._shopBusy('a'), true, 'expiry must not clear another task lock');
  assert.equal(f.reads.length, 0);
  assert.equal(f.clock.sleeps.length, 0);
  f.assertSafe();
});

test('D26 frozen clock still exhausts finite busy budget without permanent processing', async (t) => {
  const f = fixture(t);
  f.monitor._tryAcquireShop('a');
  const joined = f.login();
  await flush();
  let waits = 0;
  while (f.clock.sleeps.length && waits < 601) {
    waits += 1;
    await f.clock.step(0);
  }
  assert.equal(waits, 600);
  assert.equal(f.clock.sleeps.length, 0);
  assert.match((await joined.completion).readBack.reason, /超时/);
  assert.equal(f.reads.length, 0);
  f.assertSafe();
});

for (const blocked of ['cycle_busy', 'recovery_inflight']) {
  test(`D26 enumerated ${blocked}: wait for existing work then refresh once`, async (t) => {
    const f = fixture(t);
    if (blocked === 'cycle_busy') f.monitor._cycleRunning = true;
    else f.monitor._readRecoveries.set('a', { phase: 'running', monitorGen: 0 });
    const joined = f.login();
    await flush();
    assert.equal(f.wd.state.loginJoins.a.status, 'processing');
    assert.match(f.wd.state.loginJoins.a.reason, new RegExp(blocked));
    assert.equal(f.reads.length, 0);
    f.monitor._cycleRunning = false;
    f.monitor._readRecoveries.clear();
    await f.clock.step();
    assert.equal((await joined.completion).readBack.ok, true);
    assert.equal(f.reads.length, 1);
    f.assertSafe();
  });
}

test('D26 different shops retain D24 cycle, unproven cleanup and process guards with no overlap', async (t) => {
  const f = fixture(t);
  f.monitor._cycleRunning = true;
  f.monitor._tryAcquireShop('c');
  const a = f.login('a');
  const b = f.login('b');
  await flush();
  assert.equal(f.wd._internal._loginJoins.size, 2);
  assert.equal(f.reads.length, 0);
  f.monitor._cycleRunning = false;
  f.monitor._releaseShop('c');
  const gate = { shopId: 'c', gateId: 1, phase: 'pending', closes: [] };
  f.monitor._pendingReadGates.set('c', gate);
  f.monitor._cleanupRegistry.set('c', [gate]);
  await f.clock.step();
  await f.clock.step();
  assert.equal(f.reads.length, 0, 'returned work is not proof of resource cleanup');
  f.monitor._pendingReadGates.clear();
  await f.clock.step();
  await f.clock.step();
  assert.equal(f.reads.length, 0, 'cleanup registry independently blocks new shops');
  f.monitor._cleanupRegistry.clear();
  const holdA = deferred();
  f.readHolds.set('a', holdA);
  await f.clock.step();
  assert.deepEqual(f.reads.map((read) => read.shopId), ['a']);
  await f.clock.step();
  assert.deepEqual(f.reads.map((read) => read.shopId), ['a'], 'B cannot overlap A outside a cycle');
  holdA.resolve();
  assert.equal((await a.completion).readBack.ok, true);
  await f.clock.step();
  assert.equal((await b.completion).readBack.ok, true);
  assert.deepEqual(f.reads.map((read) => read.shopId), ['a', 'b']);
  assert.equal(f.peakReads(), 1);
  assert.equal(f.monitor._shopProcessing.size, 0);
  f.assertSafe();
});

for (const blocked of ['auth', 'identity', 'cookie_blocked', 'data', 'serial_gate', 'unexpected_busy']) {
  test(`D26 nonbusy ${blocked} after unlock is terminal, not a browser retry loop`, async (t) => {
    const f = fixture(t, { stateError: { blocked, reason: blocked === 'auth' ? '未登录' : 'shop_busy is only text here' } });
    f.monitor._tryAcquireShop('a');
    const joined = f.login();
    await flush();
    assert.equal(f.wd.state.loginJoins.a.status, 'processing');
    f.monitor._releaseShop('a');
    await f.clock.step();
    const result = await joined.completion;
    assert.equal(result.readBack.ok, false);
    assert.equal(result.readBack.blocked, blocked);
    assert.equal(f.reads.length, 1);
    assert.equal(f.monitor._readCurrentAdState.mock.callCount(), 1);
    assert.equal(f.clock.sleeps.length, 0);
    assert.equal(f.wd.state.loginJoins.a.status, 'failed');
    f.assertSafe();
  });
}

test('D26 business data failure is terminal without a handoff retry', async (t) => {
  const f = fixture(t, { dataError: { ok: false, blocked: 'orders_unavailable', reason: 'orders unavailable' } });
  const result = await f.login().completion;
  assert.equal(result.readBack.ok, false);
  assert.equal(result.readBack.blocked, 'orders_unavailable');
  assert.equal(f.reads.length, 1);
  assert.equal(f.clock.sleeps.length, 0);
  f.assertSafe();
});

test('D26 thrown auth failure containing busy text is terminal and clears handoff', async (t) => {
  const f = fixture(t);
  f.monitor.refreshShopData = t.mock.fn(async () => { throw new Error('未登录; shop_busy'); });
  const result = await f.login().completion;
  assert.equal(result.readBack.ok, false);
  assert.match(result.readBack.reason, /未登录/);
  assert.equal(f.monitor.refreshShopData.mock.callCount(), 1);
  assert.equal(f.clock.sleeps.length, 0);
  assert.equal(f.wd.state.loginJoins.a.status, 'failed');
  f.assertSafe();
});

for (const scenario of [
  { name: 'disabled-running', enabled: false, running: true, discovery: 0 },
  { name: 'disabled-stopped', enabled: false, running: false, discovery: 0 },
  { name: 'enabled-stopped', enabled: true, running: false, discovery: 1 },
]) {
  test(`D26 existing ${scenario.name} login stays readonly with zero ad/config writes`, async (t) => {
    const f = fixture(t, scenario);
    const joined = f.login();
    assert.equal(joined.action, 'readonly-refresh');
    assert.equal((await joined.completion).readBack.ok, true);
    assert.equal(f.monitor.running, scenario.running);
    assert.equal(f.shops[0].enabled, scenario.enabled);
    assert.equal(f.reads.length, 1);
    assert.equal(f.clock.sleeps.length, 0);
    f.assertSafe({ discovery: scenario.discovery });
  });
}
