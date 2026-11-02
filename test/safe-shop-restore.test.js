'use strict';

// shop-restore 精简移植测（2026-11-02 单项：补回 live shop-restore.js）。
// 全部 IO 限定到每例临时目录；不启动值守/服务/浏览器，不加载 CLI 集成层，
// 不触碰生产 config/cookies。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { restoreShopConfig, resolveRestoreTarget, safeShopRef } = require('../src/engine/shop-restore');

const clone = (value) => JSON.parse(JSON.stringify(value));

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'safe-shop-restore-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(dataDir);
  const raw = {
    _说明: 'unknown root fields survive',
    shops: [
      { id: 'shop-exact', name: '软删店', deleted: true,
        enabled: true, displayName: 'kept', thresholdCents: 193, targetRoi: 13.5,
        nested: { arbitrary: [null, false, 'preserved'] } },
      { id: 'other-shop', name: 'Other', enabled: true, deleted: false, futureField: 17 },
    ],
    rules: [{ enabled: true, thresholdCents: 193 }],
  };
  const configPath = path.join(root, 'config.json');
  const auditPath = path.join(dataDir, 'audit.jsonl');
  const write = () => fs.writeFileSync(configPath, JSON.stringify(raw, null, '\t') + '\r\n');
  write();
  return { root, raw, configPath, auditPath, write, options: (extra = {}) => ({ configPath, auditPath, shopId: raw.shops[0].id, ...extra }) };
}

function auditRows(f) {
  if (!fs.existsSync(f.auditPath)) return [];
  return fs.readFileSync(f.auditPath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
function noTemps(f) { assert.deepEqual(fs.readdirSync(f.root).filter((file) => file.endsWith('.tmp')), []); }

// require 可解析性：与 monitor.js 同目录的 ./shop-restore 必须能被 Node 解析加载。
test('shop-resolve: monitor.js 同目录可 require ./shop-restore', (t) => {
  const monitorPath = require.resolve('../src/engine/monitor.js');
  assert.ok(fs.existsSync(monitorPath));
  const fromEngineDir = require('./shop-restore.js'.replace(/^/, path.dirname(monitorPath) + path.sep));
  assert.equal(typeof fromEngineDir.resolveRestoreTarget, 'function');
  assert.equal(typeof fromEngineDir.restoreShopConfig, 'function');
  assert.equal(typeof fromEngineDir.safeShopRef, 'function');
});

test('resolveRestoreTarget: 软删店命中成功路径；非软删/别名/重复/缺 id 拒绝', () => {
  const shops = [{ id: 'exact', deleted: true, enabled: true }];
  const target = resolveRestoreTarget(shops, 'exact');
  assert.equal(target.ok, true);
  assert.equal(target.code, 'RESTORED');
  assert.equal(target.entry, shops[0]);
  // 纯函数：不改变输入
  assert.deepEqual(shops, [{ id: 'exact', deleted: true, enabled: true }]);
  // 已恢复（deleted=false && enabled=false）→ 幂等成功
  assert.equal(resolveRestoreTarget([{ id: 'x', deleted: false, enabled: false }], 'x').code, 'ALREADY_RESTORED');
  // 拒绝码
  assert.equal(resolveRestoreTarget(shops, '').code, 'SHOP_ID_REQUIRED');
  assert.equal(resolveRestoreTarget(shops, 42).code, 'SHOP_ID_INVALID');
  assert.equal(resolveRestoreTarget(shops, 'miss').code, 'SHOP_NOT_FOUND');
  assert.equal(resolveRestoreTarget(shops, 'exact.json').code, 'SHOP_NOT_FOUND');
  assert.equal(resolveRestoreTarget([{ id: 'dup', deleted: true }, { id: 'dup', deleted: true }], 'dup').code, 'SHOP_ID_AMBIGUOUS');
  assert.equal(resolveRestoreTarget([{ id: 'a', deleted: false, enabled: true }], 'a').code, 'SHOP_NOT_DELETED');
  assert.equal(resolveRestoreTarget(null, 'a').code, 'CONFIG_INVALID');
});

test('restoreShopConfig 成功路径：软删店恢复落盘、审计追加、备份保留、未知字段保留', (t) => {
  const f = fixture(t);
  const original = fs.readFileSync(f.configPath);
  const result = restoreShopConfig(f.options());
  assert.equal(result.ok, true);
  assert.equal(result.code, 'RESTORED');
  assert.equal(result.restored, true);
  assert.equal(result.persisted, true);
  assert.equal(result.committed, true);
  assert.equal(result.backupCreated, true);
  assert.equal(result.auditWritten, true);
  assert.equal(result.enabled, false);
  assert.equal(result.shopRef, safeShopRef('shop-exact'));
  // 落盘内容：目标店 deleted=false、enabled=false；其余字段/店铺原样保留
  const expected = clone(f.raw);
  expected.shops[0].deleted = false;
  expected.shops[0].enabled = false;
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, 'utf8')), expected);
  // 备份是原始字节的精确副本
  assert.match(result.backupId, /^[a-f0-9]{24}$/);
  assert.ok(fs.readFileSync(`${f.configPath}.restore-${result.backupId}.bak`).equals(original));
  // 审计行
  const rows = auditRows(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'shop-restore');
  assert.equal(rows[0].enabled, false);
  assert.equal(rows[0].persisted, true);
  assert.equal(rows[0].shopRef, safeShopRef('shop-exact'));
  noTemps(f);
});

test('restoreShopConfig 幂等：ALREADY_RESTORED 零写入零审计', (t) => {
  const f = fixture(t);
  assert.equal(restoreShopConfig(f.options()).ok, true);
  const beforeConfig = fs.readFileSync(f.configPath);
  const beforeAudit = fs.readFileSync(f.auditPath);
  const files = fs.readdirSync(f.root);
  const result = restoreShopConfig(f.options());
  assert.equal(result.ok, true);
  assert.equal(result.code, 'ALREADY_RESTORED');
  assert.equal(result.restored, false);
  assert.equal(result.persisted, true);
  assert.equal(result.backupCreated, false);
  assert.equal(result.auditWritten, false);
  assert.ok(fs.readFileSync(f.configPath).equals(beforeConfig));
  assert.ok(fs.readFileSync(f.auditPath).equals(beforeAudit));
  assert.deepEqual(fs.readdirSync(f.root), files);
});

test('restoreShopConfig 拒绝路径：非软删/未知店/缺路径，零写入', (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.configPath);
  assert.equal(restoreShopConfig(f.options({ shopId: 'other-shop' })).code, 'SHOP_NOT_DELETED');
  assert.equal(restoreShopConfig(f.options({ shopId: 'missing' })).code, 'SHOP_NOT_FOUND');
  assert.equal(restoreShopConfig(f.options({ shopId: '' })).code, 'SHOP_ID_REQUIRED');
  assert.equal(restoreShopConfig(f.options({ configPath: '', auditPath: f.auditPath })).code, 'PATH_REQUIRED');
  assert.equal(restoreShopConfig(f.options({ auditPath: '' })).code, 'PATH_REQUIRED');
  assert.equal(restoreShopConfig(f.options({ auditPath: f.configPath })).code, 'AUDIT_PATH_INVALID');
  // 落盘后 expectedShops 不一致 → CONFIG_CONFLICT
  const stale = clone(f.raw);
  stale.shops[1].futureField = 999;
  assert.equal(restoreShopConfig(f.options({ expectedShops: stale.shops })).code, 'CONFIG_CONFLICT');
  assert.ok(fs.readFileSync(f.configPath).equals(before));
  assert.deepEqual(auditRows(f), []);
  noTemps(f);
});

test('monitor.restoreDeletedShop 集成：软删店恢复成功，entry.deleted=false/enabled=false', (t) => {
  const f = fixture(t);
  const { Monitor } = require('../src/engine/monitor');
  const monitor = new Monitor(
    { config: clone(f.raw), pending: [], sourcePath: f.configPath },
    { reader: {}, controller: {} },
    { dataDir: path.dirname(f.auditPath) },
  );
  const result = monitor.restoreDeletedShop('shop-exact');
  assert.equal(result.ok, true);
  assert.equal(result.code, 'RESTORED');
  assert.equal(result.persisted, true);
  assert.equal(result.enabled, false);
  const entry = monitor.config.shops[0];
  assert.equal(result.entry, entry);
  assert.equal(entry.deleted, false);
  assert.equal(entry.enabled, false);
  const expected = clone(f.raw);
  expected.shops[0].deleted = false;
  expected.shops[0].enabled = false;
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath, 'utf8')), expected);
  const rows = auditRows(f);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'shop-restore');
  // 幂等：二次恢复 ALREADY_RESTORED
  const again = monitor.restoreDeletedShop('shop-exact');
  assert.equal(again.ok, true);
  assert.equal(again.code, 'ALREADY_RESTORED');
  assert.equal(again.entry, entry);
  noTemps(f);
});
