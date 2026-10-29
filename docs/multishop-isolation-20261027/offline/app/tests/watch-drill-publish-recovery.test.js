'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');

const filename = path.resolve(__dirname, '..', 'watch-drill.js');
const source = fs.readFileSync(filename, 'utf8');
const guardDir = path.resolve(__dirname, '..', '..', 'guard');
const publisherDir = path.resolve(__dirname, 'synthetic-publisher');
const date = '2026-10-29';
const fail = () => { throw new Error('unexpected side effect'); };

function harness(hour = '00:01') {
  let now = Date.parse(`${date}T${hour}:00+08:00`);
  const children = [];
  const spawnCalls = [];
  const module = { exports: {} };
  const fakeFs = {
    existsSync: (p) => /(?:monitor\.js|shop-profile\.cjs|daily-plan-hidden\.vbs)$/.test(String(p)),
    readFileSync: () => { throw Object.assign(new Error('synthetic file absent'), { code: 'ENOENT' }); },
    writeFileSync: fail, appendFileSync: fail, renameSync: fail, unlinkSync: fail, mkdirSync: fail,
  };
  const load = (id) => {
    if (id === 'fs') return fakeFs;
    if (id === 'path') return path;
    if (id === 'child_process') return { spawn: fail };
    if (id === './promo-plan-scheduler') return { createScheduler: fail };
    if (id.startsWith(guardDir + path.sep)
      && /(?:time|money|log|rules|chengfang-gate|bounded-poll)\.js$/.test(id)) return require(id);
    throw new Error('unexpected module: ' + id);
  };
  vm.runInThisContext('(function(require,module,exports,__filename,__dirname,process){' + source + '\n})', { filename })(
    load, module, module.exports, filename, path.dirname(filename),
    { env: { PROMO_GUARD_DIR: guardDir, PUBLISHER_DIR: publisherDir }, pid: 1 },
  );
  const target = { id: 'jin', name: 'Jin fixture', enabled: true, deleted: false, accountId: '100001', plansPerShopPerDay: 3, targetRoi: 13.5 };
  const config = {
    shops: [target, { id: 'min', name: 'Min fixture', enabled: true }, { id: 'jian', name: 'Jian fixture', enabled: true }],
    planPublishing: { enabled: false, autoConfirm: false },
  };
  const monitor = {
    config, running: true, cycleNo: 9,
    gatePreview: () => ({ pauseAllowed: false, enableAllowed: false }),
    getStatus: () => ({ monitor: { cycleNo: monitor.cycleNo, phase: 'running' }, shops: config.shops, rules: [] }),
    getEventStream: () => ({ droppedCount: 0, dropped: [], events: [], lastSeq: 0 }),
    refreshShopData: async () => ({ ok: true, readOnly: true, shopId: 'jin', data: { businessDate: date }, adState: 'on', zeroClick: true }),
    start: fail, stop: fail, joinShopNow: fail, pollOnce: fail,
  };
  const wd = module.exports.createWatchDrill({
    config, persistFile: null, nowFn: () => now, autostartOnBoot: false,
    patrolRefillLauncher: {
      publisherDir,
      spawn: (...args) => {
        spawnCalls.push(args);
        const child = new EventEmitter();
        children.push(child);
        return child;
      },
    },
  });
  wd._internal._monitor = monitor;
  return { wd, monitor, target, config, children, spawnCalls, setNow: (value) => { now = value; } };
}

async function request(h, method = 'POST', url = '/api/watch-drill/shop/refresh', body = { shopId: 'jin' }) {
  const req = new EventEmitter();
  Object.assign(req, { method, url, destroy: fail });
  let status, payload;
  const pending = h.wd.serveHttp(req, {
    writeHead: (code) => { status = code; },
    end: (text) => { payload = JSON.parse(text); },
  });
  req.emit('data', JSON.stringify(body));
  req.emit('end');
  await pending;
  return { status, payload };
}

for (const hour of ['00:01', '07:59', '18:22', '23:59']) {
  test(`ordinary current-day read triggers the existing bridge at ${hour}, not the embedded publisher`, async () => {
    const h = harness(hour);
    const before = JSON.stringify(h.config);
    const response = await request(h);
    assert.equal(response.status, 200);
    assert.equal(response.payload.zeroClick, true);
    assert.equal(h.spawnCalls.length, 1);
    assert.deepEqual(h.spawnCalls[0], [
      'wscript.exe', ['//B', '//Nologo', path.join(publisherDir, 'daily-plan-hidden.vbs')],
      { windowsHide: true, shell: false, detached: false },
    ]);
    assert.equal(h.monitor.running, true);
    assert.equal(h.wd._internal._planScheduler, null);
    assert.equal(JSON.stringify(h.config), before);
    assert.ok(h.wd.logs.some((entry) => JSON.stringify(entry).includes('值守中只读刷新成功')));
  });
}

test('read recovery shares child dedup, but a prior poll cycle does not suppress a later recovered read', async () => {
  const h = harness();
  h.wd.triggerPatrolPlanRefill({ cycleNo: 9 });
  await request(h);
  assert.equal(h.spawnCalls.length, 1);
  h.children[0].emit('exit', 0);
  assert.equal(h.wd.triggerPatrolPlanRefill({ cycleNo: 9 }).duplicateCycle, true);
  await request(h);
  await request(h);
  assert.equal(h.spawnCalls.length, 2);
  h.children[1].emit('exit', 0);
  await request(h);
  assert.equal(h.spawnCalls.length, 3, 'a new completed read may recheck the existing retry/backoff ledger');
  assert.equal(h.wd.triggerPatrolPlanRefill({ cycleNo: 9 }).inFlight, true);
  h.children[2].emit('exit', 0);
  assert.equal(h.wd.triggerPatrolPlanRefill({ cycleNo: 9 }).duplicateCycle, true);
  assert.equal(h.wd.triggerPatrolPlanRefill({ cycleNo: 10 }).spawned, true);
});

for (const [name, change] of [
  ['stopped patrol', (h) => { h.monitor.running = false; }],
  ['disabled shop', (h) => { h.target.enabled = false; }],
  ['deleted shop', (h) => { h.target.deleted = true; }],
  ['missing shop', (h) => { h.config.shops.shift(); }],
  ['ambiguous shop', (h) => { h.config.shops.push({ ...h.target }); }],
]) {
  test(`${name}: readonly refresh never restores authorization`, async () => {
    const h = harness();
    change(h);
    const before = JSON.stringify(h.config);
    await request(h);
    assert.equal(h.spawnCalls.length, 0);
    assert.equal(JSON.stringify(h.config), before);
  });
}

for (const override of [
  { ok: false }, { blocked: 'recovery_inflight' }, { blocked: 'shop_busy' }, { blocked: 'cycle_busy' },
  { blocked: 'identity' }, { blocked: 'data' }, { readOnly: false }, { shopId: 'min' },
  { data: { businessDate: '2026-10-28' } }, { data: null },
]) {
  test(`unproven current read does not trigger: ${JSON.stringify(override)}`, async () => {
    const h = harness();
    const read = h.monitor.refreshShopData;
    h.monitor.refreshShopData = async () => ({ ...await read(), ...override });
    await request(h);
    assert.equal(h.spawnCalls.length, 0);
  });
}

for (const [name, drift] of [
  ['stop', (h) => { h.monitor.running = false; }],
  ['disable', (h) => { h.target.enabled = false; }],
  ['delete', (h) => { h.target.deleted = true; }],
  ['account', (h) => { h.target.accountId = '100002'; }],
  ['name', (h) => { h.target.name = 'Other fixture'; }],
  ['instance', (h) => { h.wd._internal._monitor = { ...h.monitor }; }],
  ['business day', (h) => { h.setNow(Date.parse('2026-10-30T00:00:00+08:00')); }],
]) {
  test(`read completion rechecks ${name} drift before refill`, async () => {
    const h = harness();
    const read = h.monitor.refreshShopData;
    h.monitor.refreshShopData = async () => { const result = await read(); drift(h); return result; };
    await request(h);
    assert.equal(h.spawnCalls.length, 0);
  });
}

test('bridge failure does not turn a successful read into failure; state GET never launches', async () => {
  const h = harness();
  await request(h, 'GET', '/api/watch-drill/state');
  assert.equal(h.spawnCalls.length, 0);
  await request(h);
  h.children[0].emit('error', new Error('fixture launch failure'));
  const response = await request(h);
  assert.equal(response.status, 200);
  assert.equal(response.payload.ok, true);
  assert.equal(h.spawnCalls.length, 2);
});
