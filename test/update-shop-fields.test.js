'use strict';

/**
 * 店铺编辑字段（目标 ROI / 每店每日计划条数）隔离测试（2026-11-19）。
 * 合同来源：
 * - targetRoi：客户 2026-10-11"缺字段默认 15"，validateTargetRoi 严格校验；
 * - plansPerShopPerDay：客户 2026-10-13"每天几条加在目标 ROI 后面，可按店调整"，
 *   validatePlansPerShop 整数 1..10，缺字段回落全局默认 3。
 * 覆盖：
 * - updateShop 两字段合法保存（内存 + shopRows 投影 + config.json 落盘）；
 * - 非法值拒绝（0/'abc'/11/1.5）且不改原值；
 * - shopRows 缺省回落（targetRoi=15、plansPerShopPerDay=3）与显式值并存互不影响；
 * - /api/shop/update 透传两字段（假 monitor）。
 * 不访问真实页面；运行：node --test test/update-shop-fields.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Monitor } = require('../src/engine/monitor');
const { createUiServer } = require('../src/ui/server');
const { makeTempDir, writeTempCookie, makeCfgResult } = require('./helpers');

function setup(t, shops) {
  const cookieDir = makeTempDir('pg-cookies-');
  const dataDir = makeTempDir('pg-data-');
  t.after(() => {
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  writeTempCookie(cookieDir, '测试店铺一', {});
  const cfgResult = makeCfgResult({
    shops: shops || [{ id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', enabled: true }],
  });
  // updateShop 持久化要求 sourcePath 为**可写 .json**（原子写 tmp+rename）
  const cfgFile = path.join(dataDir, 'config.json');
  fs.writeFileSync(cfgFile, JSON.stringify({ shops: cfgResult.config.shops }, null, 2));
  cfgResult.sourcePath = cfgFile;
  const monitor = new Monitor(cfgResult, null, { dataDir, nowFn: () => Date.now(), delayFn: async () => {} });
  return { monitor, cfgFile };
}

function readCfgShops(cfgFile) {
  return JSON.parse(fs.readFileSync(cfgFile, 'utf-8')).shops;
}

test('targetRoi：合法小数保存 → 内存/shopRows/config 三处一致', (t) => {
  const { monitor, cfgFile } = setup(t);
  const r = monitor.updateShop('shop-001', { targetRoi: 13.5 });
  assert.strictEqual(r.ok, true, `应保存成功：${r.reason}`);
  assert.strictEqual(r.targetRoi, 13.5);
  assert.strictEqual(r.persisted, true);
  assert.strictEqual(monitor.getStatus().shops[0].targetRoi, 13.5);
  assert.strictEqual(monitor.getStatus().shopRows[0].targetRoi, 13.5);
  assert.strictEqual(readCfgShops(cfgFile)[0].targetRoi, 13.5, '须落盘 config.json');
});

test('targetRoi：非法值（0/' + "'abc'" + '）→ 拒绝且不改原值', (t) => {
  const { monitor } = setup(t, [{ id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', targetRoi: 15, enabled: true }]);
  for (const bad of [0, -1, 'abc']) {
    const r = monitor.updateShop('shop-001', { targetRoi: bad });
    assert.strictEqual(r.ok, false, `应拒绝 ${JSON.stringify(bad)}`);
    assert.ok(String(r.reason).includes('目标 ROI 无效'));
  }
  assert.strictEqual(monitor.getStatus().shops[0].targetRoi, 15, '原值不变');
});

test('plansPerShopPerDay：整数保存 5 → 生效；另一缺省店回落默认 3，互不影响', (t) => {
  const { monitor, cfgFile } = setup(t, [
    { id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', enabled: true },
    { id: 'shop-002', name: '测试店铺二', cookieFile: '测试店铺二', enabled: true },
  ]);
  const r = monitor.updateShop('shop-001', { plansPerShopPerDay: 5 });
  assert.strictEqual(r.ok, true, `应保存成功：${r.reason}`);
  assert.strictEqual(r.plansPerShopPerDay, 5);
  assert.strictEqual(r.persisted, true);
  const rows = monitor.getStatus().shopRows;
  const a = rows.find((x) => x.id === 'shop-001');
  const b = rows.find((x) => x.id === 'shop-002');
  assert.strictEqual(a.plansPerShopPerDay, 5, '已保存店生效值 5');
  assert.strictEqual(a.plansPerShopPerDaySaved, 5, 'saved 字段透出显式值');
  assert.strictEqual(b.plansPerShopPerDay, 3, '缺省店回落全局默认 3');
  assert.strictEqual(b.plansPerShopPerDaySaved, null, '缺省店 saved 为 null');
  assert.strictEqual(readCfgShops(cfgFile)[0].plansPerShopPerDay, 5, '须落盘 config.json');
  assert.strictEqual(readCfgShops(cfgFile)[1].plansPerShopPerDay, undefined, '未编辑店不得写回默认值');
});

test('plansPerShopPerDay：非法值（11 / 0 / 1.5 / ' + "'x'" + '）→ 拒绝且不改原值', (t) => {
  const { monitor } = setup(t, [{ id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', plansPerShopPerDay: 3, enabled: true }]);
  for (const bad of [11, 0, 1.5, 'x']) {
    const r = monitor.updateShop('shop-001', { plansPerShopPerDay: bad });
    assert.strictEqual(r.ok, false, `应拒绝 ${JSON.stringify(bad)}`);
    assert.ok(String(r.reason).includes('每日计划条数无效'), `拒绝原因须明确：${r.reason}`);
  }
  assert.strictEqual(monitor.getStatus().shopRows[0].plansPerShopPerDay, 3, '原值不变');
});

test('缺省投影：未配置两字段 → targetRoi=15 / plansPerShopPerDay=3（合同默认）', (t) => {
  const { monitor } = setup(t);
  const row = monitor.getStatus().shopRows[0];
  assert.strictEqual(row.targetRoi, 15);
  assert.strictEqual(row.plansPerShopPerDay, 3);
  assert.strictEqual(row.plansPerShopPerDaySaved, null);
});

test('/api/shop/update：透传 targetRoi 与 plansPerShopPerDay 到 monitor.updateShop', async (t) => {
  const calls = [];
  const monitor = {
    config: undefined,
    getStatus: () => ({ shops: [], shopRows: [], monitor: { running: false } }),
    start: () => ({ ok: true }),
    stop: () => ({ ok: true }),
    updateShop(shopId, fields) { calls.push({ shopId, fields }); return { ok: true, shopId, displayName: '店A', thresholdCents: 100, targetRoi: 12.5, plansPerShopPerDay: 4 }; },
    async refreshShopData() { return { ok: true }; },
    deleteShop() { return { ok: true }; },
  };
  const { server } = createUiServer(monitor, 0);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const res = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/shop/update', method: 'POST', headers: { 'content-type': 'application/json' } }, (r2) => {
      let buf = '';
      r2.on('data', (c) => { buf += c; });
      r2.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ shopId: 'shop-a', targetRoi: 12.5, plansPerShopPerDay: 4 }));
  });
  const parsed = JSON.parse(res);
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.targetRoi, 12.5);
  assert.strictEqual(parsed.plansPerShopPerDay, 4);
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].fields.targetRoi, 12.5);
  assert.strictEqual(calls[0].fields.plansPerShopPerDay, 4);
});
