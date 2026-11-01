'use strict';

// 全部 IO 限定到每例临时目录；不启动值守/服务/浏览器，不加载 CLI 集成层。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { restoreShopConfig, resolveRestoreTarget, safeShopRef } = require('../src/engine/shop-restore');

const FAKE_SECRET = 'FAKE_COOKIE_VALUE_NEVER_LOG';
const INJECTION = 'untrusted\n{"kind":"action","cookie":"' + FAKE_SECRET + '"}';
const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-shop-restore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dirs = {};
  for (const name of ['L1-work', 'L2-source', 'L3-recovery', 'L4-archive', 'data']) {
    dirs[name] = path.join(root, name);
    fs.mkdirSync(dirs[name]);
  }
  const protectedFiles = [];
  for (const [name, dir] of Object.entries(dirs)) {
    const file = path.join(dir, name === 'data' ? 'state.json' : 'cookie-alias.json');
    const bytes = name === 'data'
      ? '{ "version":2, "enablePhase":{}, "batches":{"historical":{"runs":[]}} }\r\n'
      : JSON.stringify([{ name: 'sessionid', value: FAKE_SECRET + name, domain: '.jinritemai.com' }]);
    fs.writeFileSync(file, bytes);
    protectedFiles.push(file);
  }
  const raw = {
    _说明: 'unknown root fields survive',
    shops: [
      { id: 'shop-exact', name: 'name-alias', cookieFile: 'cookie-alias.json', deleted: true,
        enabled: true, displayName: 'kept', thresholdCents: 193, targetRoi: 13.5,
        accountId: 'fake-account', nested: { arbitrary: [null, false, 'preserved'] } },
      { id: 'other-shop', name: 'Other', enabled: true, deleted: false, futureField: 17 },
    ],
    login: { cookieWorkDir: dirs['L1-work'], cookieSourceDir: dirs['L2-source'] },
    rules: [{ enabled: true, thresholdCents: 193 }],
    execution: { dryRun: true, realMode: false },
    schedule: { intervalMinutes: 30 },
    monitor: { chengfang: { enableSchedulerEnabled: false } },
    future: { cookie: FAKE_SECRET, token: FAKE_SECRET, unknown: ['not projected'] },
  };
  const configPath = path.join(root, 'config.json');
  const auditPath = path.join(dirs.data, 'audit.jsonl');
  const f = { root, dirs, raw, configPath, auditPath, protectedFiles };
  f.write = () => fs.writeFileSync(configPath, JSON.stringify(raw, null, '\t') + '\r\n');
  f.options = (extra = {}) => ({ configPath, auditPath, shopId: raw.shops[0].id, ...extra });
  f.write();
  return f;
}

function snapshot(files) { return files.map((file) => [file, fs.readFileSync(file)]); }
function unchanged(before) {
  for (const [file, bytes] of before) assert.ok(fs.readFileSync(file).equals(bytes), 'protected bytes changed');
}
function noTemps(f) { assert.deepEqual(fs.readdirSync(f.root).filter((file) => file.endsWith('.tmp')), []); }
function auditRows(f) {
  if (!fs.existsSync(f.auditPath)) return [];
  return fs.readFileSync(f.auditPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
function safeResult(result) {
  const text = JSON.stringify(result);
  assert.ok(!text.includes(FAKE_SECRET));
  assert.ok(!text.includes('untrusted'));
  assert.ok(!text.includes('cookie-alias'));
  assert.ok(!text.includes('name-alias'));
  assert.ok(!text.includes('config.json'));
}
function noWritesFs() {
  const injected = Object.create(fs);
  for (const method of ['openSync', 'writeFileSync', 'fsyncSync', 'renameSync', 'appendFileSync', 'unlinkSync']) {
    injected[method] = () => assert.fail('unexpected write: ' + method);
  }
  return injected;
}

// 独立进程的 require 白名单证明 helper 不会间接加载 Monitor 或任一业务模块。
test('CLI helper loads only builtins, produces safe JSON, and leaves L1-L4/state bytes intact', (t) => {
  const f = fixture(t);
  f.raw.shops[0].id = INJECTION;
  f.write();
  const protectedBefore = snapshot(f.protectedFiles);
  const helperPath = require.resolve('../src/engine/shop-restore');
  const script = `
    const Module = require('module');
    const load = Module._load;
    const helper = process.argv[1];
    Module._load = function (id, ...args) {
      if (id !== helper && !['fs', 'path', 'crypto'].includes(id)) throw new Error('FORBIDDEN_MODULE');
      return load.call(this, id, ...args);
    };
    const { restoreShopConfig } = require(helper);
    process.stdout.write(JSON.stringify(restoreShopConfig({
      configPath: process.argv[2], auditPath: process.argv[3], shopId: process.argv[4]
    })));
  `;
  const child = spawnSync(process.execPath, ['-e', script, helperPath, f.configPath, f.auditPath, INJECTION], {
    cwd: f.root, encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  const result = JSON.parse(child.stdout);
  assert.equal(result.code, 'RESTORED');
  safeResult(result);
  assert.deepEqual(auditRows(f).map(({ kind, shopRef, enabled, persisted }) => ({ kind, shopRef, enabled, persisted })), [
    { kind: 'shop-restore', shopRef: safeShopRef(INJECTION), enabled: false, persisted: true },
  ]);
  assert.ok(!fs.readFileSync(f.auditPath, 'utf8').includes(FAKE_SECRET));
  unchanged(protectedBefore);
  noTemps(f);
});

test('raw JSON keeps every other field; backup is exact; exclusive temp and backup fsync precede rename', (t) => {
  const f = fixture(t);
  f.raw.shops[0].cookie = FAKE_SECRET;
  f.raw.shops[0].password = FAKE_SECRET;
  f.raw.shops[1].secret = FAKE_SECRET;
  f.write();
  const original = fs.readFileSync(f.configPath);
  const protectedBefore = snapshot(f.protectedFiles);
  const expected = clone(f.raw);
  expected.shops[0].deleted = false;
  expected.shops[0].enabled = false;
  const events = [];
  const names = new Map();
  const injected = Object.create(fs);
  injected.openSync = (file, flags, mode) => {
    assert.equal(path.dirname(file), f.root);
    assert.equal(flags, 'wx');
    assert.equal(mode, 0o600);
    const fd = fs.openSync(file, flags, mode);
    names.set(fd, file);
    events.push(file.endsWith('.bak') ? 'backup-open' : 'temp-open');
    return fd;
  };
  injected.fsyncSync = (fd) => {
    events.push(names.get(fd).endsWith('.bak') ? 'backup-fsync' : 'temp-fsync');
    return fs.fsyncSync(fd);
  };
  injected.renameSync = (from, to) => {
    events.push('rename');
    assert.ok(fs.readFileSync(to).equals(original));
    assert.deepEqual(events, ['backup-open', 'backup-fsync', 'temp-open', 'temp-fsync', 'rename']);
    fs.renameSync(from, to);
  };
  const result = restoreShopConfig(f.options({ fsModule: injected }));
  assert.equal(result.ok, true);
  assert.equal(result.committed, true);
  assert.equal(result.persisted, true);
  assert.equal(result.auditWritten, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, 'utf8')), expected);
  assert.match(result.backupId, /^[a-f0-9]{24}$/);
  assert.ok(fs.readFileSync(`${f.configPath}.restore-${result.backupId}.bak`).equals(original));
  assert.equal(auditRows(f).length, 1);
  assert.equal(auditRows(f).filter((row) => row.kind === 'action').length, 0);
  safeResult(result);
  unchanged(protectedBefore);
  noTemps(f);
});

test('strict id errors are stable and never write or match aliases', (t) => {
  const f = fixture(t);
  const before = snapshot([f.configPath, ...f.protectedFiles]);
  for (const [shopId, code] of [
    [undefined, 'SHOP_ID_REQUIRED'], [null, 'SHOP_ID_REQUIRED'], ['', 'SHOP_ID_REQUIRED'],
    [' \t', 'SHOP_ID_REQUIRED'], [42, 'SHOP_ID_INVALID'], [{ id: 'shop-exact' }, 'SHOP_ID_INVALID'],
    ['missing', 'SHOP_NOT_FOUND'], ['name-alias', 'SHOP_NOT_FOUND'], ['cookie-alias', 'SHOP_NOT_FOUND'],
    ['cookie-alias.json', 'SHOP_NOT_FOUND'], ['shop-exact.json', 'SHOP_NOT_FOUND'],
    [' shop-exact', 'SHOP_NOT_FOUND'], ['SHOP-EXACT', 'SHOP_NOT_FOUND'], [INJECTION, 'SHOP_NOT_FOUND'],
  ]) {
    const result = restoreShopConfig(f.options({ shopId, fsModule: noWritesFs() }));
    assert.equal(result.ok, false);
    assert.equal(result.code, code);
    safeResult(result);
  }
  unchanged(before);
  assert.deepEqual(auditRows(f), []);
});

test('duplicate id including a non-deleted match is ambiguous, never first-match wins', (t) => {
  const f = fixture(t);
  f.raw.shops.push({ id: 'shop-exact', deleted: false, enabled: true });
  f.write();
  const before = snapshot([f.configPath]);
  const result = restoreShopConfig(f.options({ fsModule: noWritesFs() }));
  assert.equal(result.code, 'SHOP_ID_AMBIGUOUS');
  unchanged(before);
  assert.deepEqual(auditRows(f), []);
});

test('missing or non-string id performs zero filesystem calls', () => {
  const forbiddenFs = new Proxy({}, { get: () => assert.fail('unexpected filesystem access') });
  for (const shopId of [undefined, null, '', ' ', 42]) {
    const result = restoreShopConfig({ shopId, fsModule: forbiddenFs });
    assert.equal(result.code, shopId === 42 ? 'SHOP_ID_INVALID' : 'SHOP_ID_REQUIRED');
  }
});

test('helper disables deleted entries regardless of prior enabled flag and appends without replacing audit history', (t) => {
  const f = fixture(t);
  const historical = '{"kind":"test-history","preserved":true}\n';
  fs.writeFileSync(f.auditPath, historical);
  for (const enabled of [undefined, true, false]) {
    f.raw.shops[0].deleted = true;
    if (enabled === undefined) delete f.raw.shops[0].enabled;
    else f.raw.shops[0].enabled = enabled;
    f.write();
    const result = restoreShopConfig(f.options());
    assert.equal(result.ok, true);
    const entry = JSON.parse(fs.readFileSync(f.configPath, 'utf8')).shops[0];
    assert.equal(entry.deleted, false);
    assert.equal(entry.enabled, false);
    assert.ok(fs.readFileSync(f.auditPath, 'utf8').startsWith(historical));
  }
  assert.equal(auditRows(f).filter((row) => row.kind === 'shop-restore').length, 3);
  assert.equal(auditRows(f).filter((row) => row.kind === 'action').length, 0);
});

test('already disabled/restored is an exact no-write no-audit no-backup operation', (t) => {
  const f = fixture(t);
  const first = restoreShopConfig(f.options());
  assert.equal(first.ok, true);
  const before = snapshot([f.configPath, f.auditPath, ...f.protectedFiles]);
  const files = fs.readdirSync(f.root);
  const result = restoreShopConfig(f.options({ fsModule: noWritesFs() }));
  assert.equal(result.code, 'ALREADY_RESTORED');
  assert.equal(result.ok, true);
  assert.equal(result.restored, false);
  assert.equal(result.committed, false);
  assert.equal(result.backupCreated, false);
  assert.equal(result.auditWritten, false);
  assert.deepEqual(fs.readdirSync(f.root), files);
  unchanged(before);
});

test('non-deleted enabled or unspecified entries are not silently disabled', (t) => {
  const f = fixture(t);
  for (const entry of [
    { deleted: false, enabled: true }, { enabled: true }, {},
    { enabled: false }, { deleted: 'true', enabled: false }, { deleted: false },
  ]) {
    f.raw.shops[0] = { id: 'shop-exact', ...entry };
    f.write();
    const before = snapshot([f.configPath]);
    assert.equal(restoreShopConfig(f.options({ fsModule: noWritesFs() })).code, 'SHOP_NOT_DELETED');
    unchanged(before);
  }
});

test('malformed or missing configuration returns safe codes; bad audit destinations fail closed', (t) => {
  const f = fixture(t);
  for (const raw of ['{"secret":"' + FAKE_SECRET + '"', 'null', '{}', '{"shops":{}}']) {
    fs.writeFileSync(f.configPath, raw);
    const result = restoreShopConfig(f.options());
    assert.equal(result.code, 'CONFIG_INVALID');
    safeResult(result);
    assert.equal(fs.readFileSync(f.configPath, 'utf8'), raw);
  }
  const missing = restoreShopConfig(f.options({ configPath: path.join(f.root, INJECTION, 'missing.json') }));
  assert.equal(missing.code, 'CONFIG_READ_FAILED');
  safeResult(missing);
  f.write();
  for (const auditPath of [f.configPath, f.dirs.data]) {
    assert.equal(restoreShopConfig(f.options({ auditPath })).code, 'AUDIT_PATH_INVALID');
  }
  assert.equal(restoreShopConfig(f.options({ auditPath: '' })).code, 'PATH_REQUIRED');
  const link = path.join(f.root, 'audit-hardlink');
  fs.linkSync(f.configPath, link);
  assert.equal(restoreShopConfig(f.options({ auditPath: link })).code, 'AUDIT_PATH_INVALID');
  noTemps(f);
});

for (const failure of ['backup-open', 'backup-write', 'backup-fsync', 'temp-open', 'temp-write', 'temp-fsync', 'rename']) {
  test('atomic failure keeps original bytes and cleans own partial files: ' + failure, (t) => {
    const f = fixture(t);
    const before = snapshot([f.configPath, ...f.protectedFiles]);
    const foreign = path.join(f.root, 'foreign.tmp');
    fs.writeFileSync(foreign, 'foreign-data');
    const injected = Object.create(fs);
    const names = new Map();
    const fail = () => { throw new Error(INJECTION); };
    injected.openSync = (file, flags, mode) => {
      if ((failure === 'backup-open' && file.endsWith('.bak')) || (failure === 'temp-open' && file.endsWith('.tmp'))) fail();
      const fd = fs.openSync(file, flags, mode);
      names.set(fd, file);
      return fd;
    };
    injected.writeFileSync = (fd, bytes) => {
      const backup = names.get(fd).endsWith('.bak');
      if ((failure === 'backup-write' && backup) || (failure === 'temp-write' && !backup)) {
        fs.writeFileSync(fd, bytes.subarray(0, 10));
        fail();
      }
      fs.writeFileSync(fd, bytes);
    };
    injected.fsyncSync = (fd) => {
      const backup = names.get(fd).endsWith('.bak');
      if ((failure === 'backup-fsync' && backup) || (failure === 'temp-fsync' && !backup)) fail();
      fs.fsyncSync(fd);
    };
    if (failure === 'rename') injected.renameSync = fail;
    const result = restoreShopConfig(f.options({ fsModule: injected }));
    assert.equal(result.ok, false);
    assert.equal(result.persisted, false);
    assert.equal(result.committed, false);
    assert.equal(result.code, failure.startsWith('backup') ? 'BACKUP_FAILED' : 'CONFIG_WRITE_FAILED');
    assert.equal(result.backupCreated, !failure.startsWith('backup'));
    assert.deepEqual(fs.readdirSync(f.root).filter((file) => file.endsWith('.tmp')), ['foreign.tmp']);
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign-data');
    assert.equal(fs.readdirSync(f.root).filter((file) => file.endsWith('.bak')).length, result.backupCreated ? 1 : 0);
    unchanged(before);
    assert.deepEqual(auditRows(f), []);
    safeResult(result);
  });
}

test('exclusive temp collision never deletes the file owned by another writer', (t) => {
  const f = fixture(t);
  const before = snapshot([f.configPath]);
  const injected = Object.create(fs);
  let foreign;
  injected.openSync = (file, flags, mode) => {
    if (file.endsWith('.tmp')) {
      foreign = file;
      fs.writeFileSync(file, 'foreign');
    }
    return fs.openSync(file, flags, mode);
  };
  const result = restoreShopConfig(f.options({ fsModule: injected }));
  assert.equal(result.code, 'CONFIG_WRITE_FAILED');
  assert.equal(fs.readFileSync(foreign, 'utf8'), 'foreign');
  unchanged(before);
});

test('cleanup failure is reported without masking persistence state or leaking the exception', (t) => {
  const f = fixture(t);
  const injected = Object.create(fs);
  injected.renameSync = () => { throw new Error(INJECTION); };
  injected.unlinkSync = () => { throw new Error(INJECTION); };
  const result = restoreShopConfig(f.options({ fsModule: injected }));
  assert.equal(result.ok, false);
  assert.equal(result.cleanupFailed, true);
  assert.equal(result.persisted, false);
  assert.equal(result.code, 'CONFIG_WRITE_FAILED');
  safeResult(result);
});

for (const extension of ['.bak', '.tmp']) {
  test('corrupt prepared bytes are rejected before rename: ' + extension, (t) => {
    const f = fixture(t);
    const before = snapshot([f.configPath, ...f.protectedFiles]);
    const injected = Object.create(fs);
    injected.readFileSync = (file, ...args) => {
      if (file.endsWith(extension)) return Buffer.from('corrupt');
      return fs.readFileSync(file, ...args);
    };
    const result = restoreShopConfig(f.options({ fsModule: injected }));
    assert.equal(result.code, extension === '.bak' ? 'BACKUP_FAILED' : 'CONFIG_WRITE_FAILED');
    assert.equal(result.persisted, false);
    assert.equal(result.committed, false);
    assert.equal(result.backupCreated, extension === '.tmp');
    unchanged(before);
    assert.deepEqual(auditRows(f), []);
    noTemps(f);
  });
}

for (const moment of ['before-backup', 'before-rename', 'after-rename']) {
  test('byte CAS preserves foreign data: ' + moment, (t) => {
    const f = fixture(t);
    const original = fs.readFileSync(f.configPath);
    // 仅空白变化也必须拒绝，不能只比对 JSON 语义。
    const foreign = Buffer.concat([original, Buffer.from(' \r\n')]);
    const injected = Object.create(fs);
    let reads = 0;
    injected.readFileSync = (file, ...args) => {
      const bytes = fs.readFileSync(file, ...args);
      if (file === f.configPath && ++reads === 1 && moment === 'before-backup') fs.writeFileSync(file, foreign);
      return bytes;
    };
    injected.fsyncSync = (fd) => {
      fs.fsyncSync(fd);
      if (moment === 'before-rename') fs.writeFileSync(f.configPath, foreign);
    };
    injected.renameSync = (from, to) => {
      fs.renameSync(from, to);
      if (moment === 'after-rename') fs.writeFileSync(to, foreign);
    };
    const result = restoreShopConfig(f.options({ fsModule: injected }));
    assert.equal(result.code, 'CONFIG_CONFLICT');
    assert.equal(result.ok, false);
    assert.equal(result.persisted, false);
    assert.equal(result.committed, moment === 'after-rename');
    assert.ok(fs.readFileSync(f.configPath).equals(foreign));
    if (result.backupCreated) assert.ok(fs.readFileSync(`${f.configPath}.restore-${result.backupId}.bak`).equals(original));
    assert.deepEqual(auditRows(f), []);
    noTemps(f);
  });
}

test('overlapping helper calls keep the winning write and exactly one restore audit', (t) => {
  const f = fixture(t);
  const injected = Object.create(fs);
  let syncs = 0;
  let winner;
  injected.fsyncSync = (fd) => {
    fs.fsyncSync(fd);
    if (++syncs === 2) winner = restoreShopConfig(f.options());
  };
  const loser = restoreShopConfig(f.options({ fsModule: injected }));
  assert.equal(winner.ok, true);
  assert.equal(loser.code, 'CONFIG_CONFLICT');
  assert.equal(loser.persisted, false);
  assert.equal(JSON.parse(fs.readFileSync(f.configPath, 'utf8')).shops[0].enabled, false);
  assert.equal(auditRows(f).length, 1);
  noTemps(f);
});

test('idempotent read also rejects a concurrent byte change without writes', (t) => {
  const f = fixture(t);
  f.raw.shops[0].deleted = false;
  f.raw.shops[0].enabled = false;
  f.write();
  const injected = noWritesFs();
  let reads = 0;
  injected.readFileSync = (file, ...args) => {
    const bytes = fs.readFileSync(file, ...args);
    if (file === f.configPath && ++reads === 1) fs.appendFileSync(file, ' ');
    return bytes;
  };
  assert.equal(restoreShopConfig(f.options({ fsModule: injected })).code, 'CONFIG_CONFLICT');
  assert.deepEqual(auditRows(f), []);
});

test('post-rename verification failure reports unknown persistence, keeps backup and never overwrites blindly', (t) => {
  const f = fixture(t);
  const injected = Object.create(fs);
  let renamed = false;
  injected.renameSync = (from, to) => { fs.renameSync(from, to); renamed = true; };
  injected.readFileSync = (file, ...args) => {
    if (renamed && file === f.configPath) throw new Error(INJECTION);
    return fs.readFileSync(file, ...args);
  };
  const result = restoreShopConfig(f.options({ fsModule: injected }));
  assert.equal(result.code, 'CONFIG_VERIFY_FAILED');
  assert.equal(result.persisted, null);
  assert.equal(result.committed, true);
  assert.equal(result.backupCreated, true);
  assert.deepEqual(auditRows(f), []);
  safeResult(result);
  noTemps(f);
});

test('audit failure after commit truthfully reports persisted=true without claiming rollback', (t) => {
  const f = fixture(t);
  const before = snapshot(f.protectedFiles);
  const injected = Object.create(fs);
  injected.appendFileSync = () => { throw new Error(INJECTION); };
  const result = restoreShopConfig(f.options({ fsModule: injected }));
  assert.equal(result.ok, false);
  assert.equal(result.code, 'AUDIT_WRITE_FAILED');
  assert.equal(result.restored, true);
  assert.equal(result.persisted, true);
  assert.equal(result.committed, true);
  assert.equal(result.auditWritten, false);
  assert.equal(JSON.parse(fs.readFileSync(f.configPath, 'utf8')).shops[0].enabled, false);
  safeResult(result);
  unchanged(before);
  noTemps(f);
});

function buildMonitor(f) {
  const { Monitor } = require('../src/engine/monitor');
  const config = clone(f.raw);
  // 构造也只触及隔离 Cookie 根和 dataDir；无 start/boot，无任何服务/浏览器启动。
  const forbidden = () => assert.fail('unexpected browser or poll');
  const monitor = new Monitor({ config, pending: [], sourcePath: f.configPath },
    { reader: {}, controller: {} }, {
      dataDir: f.dirs.data, chengfangOpener: forbidden, readAdState: forbidden,
      setTimeoutFn: forbidden, delayFn: forbidden,
    });
  const calls = [];
  for (const method of ['_pollShop', '_poll', 'pollOnce', 'requestShopDiscovery', '_discoverShopsFromCookies', '_saveState']) {
    monitor[method] = () => { calls.push(method); assert.fail('unexpected restore side effect'); };
  }
  return { monitor, calls };
}

test('恢复后非删除店纳入统一活动范围、全局停止仍零派发', async (t) => {
  const f = fixture(t);
  const { monitor, calls } = buildMonitor(f);
  monitor.running = true; // 只模拟已有值守状态；绝不启动循环。
  t.after(() => { monitor.running = false; });
  const before = snapshot(f.protectedFiles); // 构造的既有 state 写入不属于恢复操作。
  const expected = clone(monitor.config);
  expected.shops[0].deleted = false;
  expected.shops[0].enabled = false;
  const result = monitor.restoreDeletedShop('shop-exact', { reason: INJECTION });
  assert.equal(result.ok, true);
  assert.equal(result.persisted, true);
  assert.equal(result.enabled, false);
  assert.deepEqual(monitor.config, expected);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, 'utf8')), expected);
  assert.deepEqual(monitor._activeShops().map((s) => s.id), ['shop-exact', 'other-shop']);
  monitor.running = false; // 仅本地 fake 状态：全局停止，非生产。
  const join = await monitor.joinShopNow('shop-exact');
  assert.equal(join.status, 'stopped');
  assert.equal(join.ok, false);
  assert.equal(monitor.running, false);
  assert.equal(monitor.enableRunning, false);
  assert.equal(monitor._activeTokens.size, 0);
  assert.equal(monitor._shopProcessing.size, 0);
  assert.deepEqual(calls, []);
  const rows = auditRows(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'shop-restore');
  assert.equal(rows[0].enabled, false);
  assert.equal(rows[0].persisted, true);
  assert.equal(rows[0].shopRef, safeShopRef('shop-exact'));
  assert.ok(!JSON.stringify(rows).includes('untrusted'));
  assert.ok(!JSON.stringify(rows).includes(FAKE_SECRET));
  assert.deepEqual(monitor.actions, []);
  unchanged(before);
});

function forbidFixtureWrites(t, f) {
  const writes = [];
  for (const method of ['openSync', 'writeFileSync', 'renameSync', 'appendFileSync', 'unlinkSync', 'mkdirSync']) {
    const original = fs[method];
    t.mock.method(fs, method, function (file, ...args) {
      const local = typeof file === 'string' && (file === f.root || file.startsWith(f.root + path.sep));
      const readOnly = method === 'openSync' && ['r', 'rs'].includes(args[0]);
      if (local && !readOnly) {
        writes.push(method);
        throw new Error(INJECTION);
      }
      return original.call(this, file, ...args);
    });
  }
  return writes;
}

test('Monitor rejects cached aliases/duplicates/active entries without writes', (t) => {
  const f = fixture(t);
  const { monitor, calls } = buildMonitor(f);
  const before = snapshot([f.configPath, ...f.protectedFiles]);
  const original = clone(monitor.config);
  const files = fs.readdirSync(f.root);
  const writes = forbidFixtureWrites(t, f);
  for (const id of [undefined, '', 'name-alias', 'cookie-alias', 'cookie-alias.json', INJECTION]) {
    assert.equal(monitor.restoreDeletedShop(id).ok, false);
  }
  assert.equal(monitor.restoreDeletedShop('other-shop').code, 'SHOP_NOT_DELETED');
  monitor.config.shops.push({ id: 'shop-exact', deleted: false, enabled: false });
  assert.equal(monitor.restoreDeletedShop('shop-exact').code, 'SHOP_ID_AMBIGUOUS');
  monitor.config.shops.pop();
  assert.deepEqual(monitor.config, original);
  assert.deepEqual(writes, []);
  assert.deepEqual(calls, []);
  assert.deepEqual(fs.readdirSync(f.root), files);
  assert.deepEqual(auditRows(f), []);
  unchanged(before);
});

test('Monitor idempotence checks disk and returns the same entry without writes or audit', (t) => {
  const f = fixture(t);
  const { monitor, calls } = buildMonitor(f);
  const first = monitor.restoreDeletedShop('shop-exact');
  assert.equal(first.ok, true);
  const before = snapshot([f.configPath, f.auditPath, ...f.protectedFiles]);
  const files = fs.readdirSync(f.root);
  const original = clone(monitor.config);
  const writes = forbidFixtureWrites(t, f);
  const result = monitor.restoreDeletedShop('shop-exact');
  assert.equal(result.ok, true);
  assert.equal(result.restored, false);
  assert.equal(result.persisted, true);
  assert.equal(result.code, 'ALREADY_RESTORED');
  assert.equal(result.entry, first.entry);
  assert.equal(result.backupCreated, false);
  assert.equal(result.auditWritten, false);
  assert.deepEqual(monitor.config, original);
  assert.deepEqual(writes, []);
  assert.deepEqual(calls, []);
  assert.deepEqual(fs.readdirSync(f.root), files);
  unchanged(before);
});

for (const restored of [false, true]) {
  for (const change of ['removed-target', 'duplicate-target', 'other-threshold']) {
    test(`Monitor rejects stale shops before writes or idempotence: restored=${restored}, ${change}`, (t) => {
      const f = fixture(t);
      if (restored) Object.assign(f.raw.shops[0], { deleted: false, enabled: false });
      f.write();
      const { monitor, calls } = buildMonitor(f);
      const original = clone(monitor.config);
      if (change === 'removed-target') f.raw.shops.shift();
      if (change === 'duplicate-target') f.raw.shops.push({ id: 'shop-exact', deleted: false, enabled: true });
      if (change === 'other-threshold') f.raw.shops[1].thresholdCents = 9876;
      f.write();
      const before = snapshot([f.configPath, ...f.protectedFiles]);
      const files = fs.readdirSync(f.root);
      const writes = forbidFixtureWrites(t, f);
      const result = monitor.restoreDeletedShop('shop-exact');
      assert.equal(result.ok, false);
      assert.equal(result.code, 'CONFIG_CONFLICT');
      assert.equal(result.reason, result.code);
      assert.equal(result.restored, false);
      assert.equal(result.persisted, false);
      assert.equal(result.backupCreated, false);
      assert.equal(result.auditWritten, false);
      assert.equal(Object.hasOwn(result, 'entry'), false);
      assert.deepEqual(monitor.config, original);
      assert.deepEqual(writes, []);
      assert.deepEqual(calls, []);
      assert.deepEqual(fs.readdirSync(f.root), files);
      assert.deepEqual(auditRows(f), []);
      unchanged(before);
      safeResult(result);
    });
  }
}

for (const enabled of [undefined, true, false]) {
  test('Monitor persists disabled with original enabled=' + enabled, (t) => {
    const f = fixture(t);
    if (enabled === undefined) delete f.raw.shops[0].enabled;
    else f.raw.shops[0].enabled = enabled;
    f.write();
    const { monitor, calls } = buildMonitor(f);
    const before = snapshot(f.protectedFiles);
    const entry = monitor.config.shops[0];
    const result = monitor.restoreDeletedShop('shop-exact');
    assert.equal(result.ok, true);
    assert.equal(result.entry, entry);
    assert.equal(entry.deleted, false);
    assert.equal(entry.enabled, false);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, 'utf8')), monitor.config);
    assert.equal(auditRows(f).length, 1);
    assert.deepEqual(calls, []);
    unchanged(before);
    noTemps(f);
  });

  for (const failure of ['backup-open', 'temp-open', 'rename']) {
    test(`Monitor filesystem ${failure} leaves exact memory shape intact, enabled=${enabled}`, (t) => {
      const f = fixture(t);
      if (enabled === undefined) delete f.raw.shops[0].enabled;
      else f.raw.shops[0].enabled = enabled;
      f.write();
      const { monitor, calls } = buildMonitor(f);
      const before = snapshot([f.configPath, ...f.protectedFiles]);
      const original = clone(monitor.config);
      const entry = monitor.config.shops[0];
      const descriptors = Object.getOwnPropertyDescriptors(entry);
      const method = failure === 'rename' ? 'renameSync' : 'openSync';
      const originalFs = fs[method];
      let failures = 0;
      t.mock.method(fs, method, function (file, ...args) {
        const owned = typeof file === 'string' && file.startsWith(f.configPath + '.restore-');
        const matches = failure === 'rename' ? args[0] === f.configPath
          : file.endsWith(failure === 'backup-open' ? '.bak' : '.tmp') && args[0] === 'wx';
        if (owned && matches) {
          failures += 1;
          throw new Error(INJECTION);
        }
        return originalFs.call(this, file, ...args);
      });
      const result = monitor.restoreDeletedShop('shop-exact', { reason: INJECTION });
      assert.equal(failures, 1);
      assert.equal(result.ok, false);
      assert.equal(result.code, failure === 'backup-open' ? 'BACKUP_FAILED' : 'CONFIG_WRITE_FAILED');
      assert.equal(result.reason, result.code);
      assert.equal(result.persisted, false);
      assert.equal(result.restored, false);
      assert.equal(result.backupCreated, failure !== 'backup-open');
      assert.deepEqual(Object.getOwnPropertyDescriptors(entry), descriptors);
      assert.deepEqual(monitor.config, original);
      assert.deepEqual(monitor.recentErrors, []);
      assert.deepEqual(calls, []);
      assert.deepEqual(auditRows(f), []);
      safeResult(result);
      unchanged(before);
      noTemps(f);
    });
  }
}

test('Monitor parser error leaves memory intact and raw exception is not exposed', (t) => {
  const f = fixture(t);
  const { monitor, calls } = buildMonitor(f);
  fs.writeFileSync(f.configPath, '{"cookie":"' + FAKE_SECRET + '"');
  const before = snapshot([f.configPath, ...f.protectedFiles]);
  const original = clone(monitor.config);
  const result = monitor.restoreDeletedShop('shop-exact');
  assert.equal(result.code, 'CONFIG_INVALID');
  assert.equal(result.reason, result.code);
  assert.deepEqual(monitor.config, original);
  safeResult(result);
  assert.deepEqual(monitor.recentErrors, []);
  assert.deepEqual(calls, []);
  assert.deepEqual(auditRows(f), []);
  unchanged(before);
  noTemps(f);
});

test('Monitor audit disk failure reports persisted=true and ok=false, with memory committed disabled', (t) => {
  const f = fixture(t);
  const { monitor, calls } = buildMonitor(f);
  const before = snapshot(f.protectedFiles);
  const expected = clone(monitor.config);
  Object.assign(expected.shops[0], { deleted: false, enabled: false });
  const append = fs.appendFileSync;
  let attempts = 0;
  t.mock.method(fs, 'appendFileSync', function (file, ...args) {
    if (file === f.auditPath) {
      attempts += 1;
      throw new Error(INJECTION);
    }
    return append.call(this, file, ...args);
  });
  const result = monitor.restoreDeletedShop('shop-exact');
  assert.equal(attempts, 1);
  assert.equal(result.code, 'AUDIT_WRITE_FAILED');
  assert.equal(result.reason, result.code);
  assert.equal(result.ok, false);
  assert.equal(result.persisted, true);
  assert.equal(result.restored, true);
  assert.equal(result.committed, true);
  assert.equal(result.auditWritten, false);
  assert.equal(Object.hasOwn(result, 'entry'), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, 'utf8')), expected);
  assert.deepEqual(monitor.config, expected);
  assert.deepEqual(monitor.recentErrors, []);
  assert.deepEqual(monitor.actions, []);
  assert.deepEqual(calls, []);
  assert.deepEqual(auditRows(f), []);
  safeResult(result);
  unchanged(before);
  noTemps(f);
});

test('pure target resolution never mutates the input', () => {
  const shops = [{ id: 'exact.json', deleted: true, enabled: true }];
  const before = clone(shops);
  assert.equal(resolveRestoreTarget(shops, 'exact').code, 'SHOP_NOT_FOUND');
  assert.equal(resolveRestoreTarget(shops, 'exact.json').entry, shops[0]);
  assert.deepEqual(shops, before);
});
