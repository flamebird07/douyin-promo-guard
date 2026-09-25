'use strict';

/**
 * Cookie 自动发现店铺隔离测试（2026-09-25 阶段 5）。
 * 用户已确认方案：Cookie 文件目录作为店铺发现入口；阈值和删除状态按店铺保存；
 * 新增 Cookie 自动出现；已删除店铺不因重复扫描自动恢复。
 * 全部临时目录 + 真实文件读写（原子写路径），不加载生产配置、不访问外部服务。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { discoverShopsFromCookies } = require('../src/engine/shop-discovery');
const { Monitor } = require('../src/engine/monitor');
const { makeTempDir, writeTempCookie, makeCfgResult, makeClock, makeLinkedReader, makeStatefulController } = require('./helpers');
const { shanghaiMs } = require('../src/lib/time');

const RULES = [{ type: 'wholeShopCostPerOrder', name: 'r', thresholdCents: 100, comparator: '>', period: 'today', timezone: 'Asia/Shanghai', enabled: true }];

/** 建临时目录组：cookie 目录 + config.json + data 目录，返回构造参数。 */
function setup(t, { shops, cookieFiles = [], extraFiles = {}, rules = RULES } = {}) {
  const cookieDir = makeTempDir('pg-disc-cookies-');
  const cfgDir = makeTempDir('pg-disc-cfg-');
  const dataDir = makeTempDir('pg-disc-data-');
  t.after(() => {
    for (const d of [cookieDir, cfgDir, dataDir]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    }
  });
  for (const name of cookieFiles) writeTempCookie(cookieDir, name);
  for (const [name, content] of Object.entries(extraFiles)) {
    fs.writeFileSync(path.join(cookieDir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  const cfgPath = path.join(cfgDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ shops: shops || [], rules }, null, 2));
  const cfgResult = makeCfgResult({ shops, cookieDir, rules });
  cfgResult.sourcePath = cfgPath;
  const clock = makeClock(shanghaiMs('2026-09-12', '09:00'));
  return { cookieDir, cfgDir, dataDir, cfgPath, cfgResult, clock };
}

/** 构造带 mock 读取器/控制器的 Monitor（避免 NotConnected 装配路径差异）。 */
function buildMonitor(cfgResult, dataDir, clock, shops) {
  const controllers = new Map();
  const readers = new Map();
  const list = shops || cfgResult.config.shops;
  for (const s of list) {
    const c = makeStatefulController({ identity: { id: s.id, name: s.name }, ads: [{ adId: `${s.id}-ad-1`, name: '广告1', status: '投放中', switchChecked: true }] });
    const r = makeLinkedReader(c, {
      costCents: 500, orders: 10, costShopId: s.id, orderShopId: s.id, adsShopId: s.id,
      costDate: '2026-09-12', orderDate: '2026-09-12', adsDate: '2026-09-12',
      costFetchedAt: new Date(clock.nowFn()).toISOString(),
      orderFetchedAt: new Date(clock.nowFn()).toISOString(),
      adsFetchedAt: new Date(clock.nowFn()).toISOString(),
      pageSource: 'mock',
    }, clock.nowFn);
    controllers.set(s.id, c);
    readers.set(s.id, r);
  }
  const routerReader = {
    connected: true, source: 'mock',
    async readCostSummary(p) { return readers.get((p && p.shopCfg && p.shopCfg.id) || list[0].id).readCostSummary(); },
    async readOrderSummary(p) { return readers.get((p && p.shopCfg && p.shopCfg.id) || list[0].id).readOrderSummary(); },
    async listAdPage(p) { return readers.get((p && p.shopCfg && p.shopCfg.id) || list[0].id).listAdPage(p || {}); },
  };
  const routerController = {
    connected: true, source: 'mock',
    async verifyIdentity(p) { return controllers.get((p && p.shopCfg && p.shopCfg.id) || list[0].id).verifyIdentity(); },
    async getAd(p) { return controllers.get((p && p.shopCfg && p.shopCfg.id) || list[0].id).getAd(p); },
    async closeAd(p) { return controllers.get((p && p.shopCfg && p.shopCfg.id) || list[0].id).closeAd(p); },
  };
  return new Monitor(cfgResult, { reader: routerReader, controller: routerController }, {
    dataDir, nowFn: clock.nowFn, delayFn: clock.delayFn,
  });
}

// ── 1. 新 Cookie 自动出现 ──────────────────────────────────────────

test('新增 Cookie 自动建店：追加末尾、autoDiscovered 标记、原子持久化到 config.json', (t) => {
  const { cfgResult, dataDir, clock, cfgPath, cookieDir } = setup(t, {
    shops: [{ id: '甲店', name: '甲店', cookieFile: '甲店', accountId: '1710242295996424', enabled: true }],
    cookieFiles: ['甲店', '乙店'],
  });
  const diskBefore = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  assert.strictEqual(diskBefore.shops.length, 1, '构造前磁盘只有手工配置的甲店');
  const m = buildMonitor(cfgResult, dataDir, clock);
  assert.strictEqual(m.config.shops.length, 2, '内存新增乙店');
  const yi = m.config.shops[1];
  assert.strictEqual(yi.id, '乙店');
  assert.strictEqual(yi.autoDiscovered, true, '带自动发现标记');
  assert.strictEqual(yi.enabled, true, '自动发现店默认启用');
  assert.strictEqual(yi.platform, 'douyin');
  assert.strictEqual(m.config.shops[0].id, '甲店', '既有条目在先，不重排');
  assert.strictEqual(m._activeShops().map((s) => s.id).join(','), '甲店,乙店', '新店进入值守活动范围');
  const diskAfter = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  assert.strictEqual(diskAfter.shops.length, 2, '磁盘已持久化新店');
  assert.strictEqual(diskAfter.shops[1].autoDiscovered, true, '磁盘条目带标记');
  assert.strictEqual(diskAfter.shops[0].accountId, '1710242295996424', '既有条目 accountId 原样');
  assert.ok(fs.readdirSync(cookieDir).includes('乙店.json'), 'Cookie 文件不动');
});

// ── 2. 已删除店铺不复活 ────────────────────────────────────────────

test('已删除店铺（deleted=true）不因 Cookie 仍在而复活：内存与磁盘均保持删除态', (t) => {
  const { cfgResult, dataDir, clock, cfgPath, cookieDir } = setup(t, {
    shops: [
      { id: '甲店', name: '甲店', cookieFile: '甲店', enabled: true },
      { id: '乙店', name: '乙店', cookieFile: '乙店', enabled: false, deleted: true, deletedAt: '2026-09-20T00:00:00.000Z' },
    ],
    cookieFiles: ['甲店', '乙店'],
  });
  const m = buildMonitor(cfgResult, dataDir, clock);
  assert.strictEqual(m.config.shops.length, 2, '不新增条目');
  const yi = m._findShop('乙店');
  assert.strictEqual(yi.deleted, true, '软删除态保持');
  assert.strictEqual(yi.autoDiscovered, undefined, '不被改写为自动发现');
  assert.strictEqual(m._activeShops().map((s) => s.id).join(','), '甲店', '已删除店不进活动范围');
  const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  assert.strictEqual(disk.shops.length, 2);
  assert.strictEqual(disk.shops[1].deleted, true, '磁盘删除态保持');
  // 重复扫描（再次构造）仍不复活
  const cfgResult2 = makeCfgResult({ shops: disk.shops, cookieDir });
  cfgResult2.sourcePath = cfgPath;
  const m2 = buildMonitor(cfgResult2, dataDir, clock, disk.shops);
  assert.strictEqual(m2._findShop('乙店').deleted, true, '重复扫描后仍不复活');
  assert.strictEqual(m2._activeShops().length, 1);
});

// ── 3. 阈值按店铺保存 ──────────────────────────────────────────────

test('自动发现店阈值回落全局规则；修改后按店保存并跨构造保留', (t) => {
  const { cfgResult, dataDir, clock, cfgPath, cookieDir } = setup(t, {
    shops: [{ id: '甲店', name: '甲店', cookieFile: '甲店', enabled: true }],
    cookieFiles: ['甲店', '乙店'],
  });
  const m = buildMonitor(cfgResult, dataDir, clock);
  assert.strictEqual(m._thresholdCents(m._findShop('甲店')), 100, '未设店级阈值 → 全局规则');
  assert.strictEqual(m._thresholdCents(m._findShop('乙店')), 100, '新发现店同样回落全局规则');
  const r = m.updateShop('乙店', { thresholdCents: 188 });
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  assert.strictEqual(m._thresholdCents(m._findShop('乙店')), 188, '按店阈值立即生效');
  // 模拟重启：从磁盘重读配置再构造
  const disk = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
  assert.strictEqual(disk.shops.find((s) => s.id === '乙店').thresholdCents, 188, '店级阈值落盘');
  const cfgResult2 = makeCfgResult({ shops: disk.shops, cookieDir });
  cfgResult2.sourcePath = cfgPath;
  const m2 = buildMonitor(cfgResult2, dataDir, clock, disk.shops);
  assert.strictEqual(m2._thresholdCents(m2._findShop('乙店')), 188, '重启后店级阈值保留');
  assert.strictEqual(m2.config.shops.length, 2, '重启不重复添加');
});

// ── 4. 非法文件与开关语义 ──────────────────────────────────────────

test('非 Cookie 数组形态的 .json 跳过并记录，不产生店铺', (t) => {
  const { cfgResult, dataDir, clock } = setup(t, {
    shops: [{ id: '甲店', name: '甲店', cookieFile: '甲店', enabled: true }],
    cookieFiles: ['甲店'],
    extraFiles: { 'garbage.json': { not: 'array' }, 'broken.json': '{not-json' },
  });
  const m = buildMonitor(cfgResult, dataDir, clock);
  assert.strictEqual(m.config.shops.length, 1, '非法文件不产生店铺');
  const audits = [];
  // 审计文件里应有 skipped 记录（只读回读 data/audit.jsonl）
  const auditFile = path.join(dataDir, 'audit.jsonl');
  if (fs.existsSync(auditFile)) {
    for (const line of fs.readFileSync(auditFile, 'utf-8').split('\n').filter(Boolean)) {
      try { audits.push(JSON.parse(line)); } catch (_) {}
    }
  }
  const disc = audits.filter((a) => a.kind === 'shop-discovery' && a.skipped);
  assert.ok(disc.length >= 1, '跳过原因须留痕审计');
  const reasons = disc.flatMap((a) => a.skipped.map((s) => s.file)).join(',');
  assert.ok(reasons.includes('garbage.json') && reasons.includes('broken.json'), `跳过文件须记录：${reasons}`);
});

test('未配置 cookieSourceDir 时不扫描（发现关闭，既有环境不受影响）', (t) => {
  const { cfgResult, dataDir, clock } = setup(t, {
    shops: [{ id: '甲店', name: '甲店', cookieFile: '甲店', enabled: true }],
    cookieFiles: ['甲店', '乙店'],
  });
  delete cfgResult.config.login.cookieSourceDir; // 关闭发现开关
  const m = buildMonitor(cfgResult, dataDir, clock);
  assert.strictEqual(m.config.shops.length, 1, '不扫描、不新增');
});

// ── 5. 纯函数层：不改入参、目录优先级 ──────────────────────────────

test('纯函数：不修改传入 shops 数组；项目目录与来源目录同名 Cookie 以项目目录优先（不重复建店）', (t) => {
  const projDir = makeTempDir('pg-disc-proj-');
  t.after(() => { try { fs.rmSync(projDir, { recursive: true, force: true }); } catch (_) {} });
  writeTempCookie(projDir, '乙店');
  const srcDir = makeTempDir('pg-disc-src-');
  t.after(() => { try { fs.rmSync(srcDir, { recursive: true, force: true }); } catch (_) {} });
  writeTempCookie(srcDir, '乙店');
  writeTempCookie(srcDir, '丙店');
  const existing = [{ id: '甲店', name: '甲店', cookieFile: '甲店' }];
  const snapshot = JSON.stringify(existing);
  const r = discoverShopsFromCookies({
    loginCfg: { cookieSourceDir: srcDir },
    shops: existing,
    projectCookiesDir: projDir,
  });
  assert.strictEqual(JSON.stringify(existing), snapshot, '入参不被修改');
  assert.deepStrictEqual(r.added, ['乙店', '丙店'], '同名去重、跨目录合并');
  const yi = r.shops.find((s) => s.id === '乙店');
  assert.strictEqual(yi.autoDiscovered, true);
  assert.strictEqual(r.shops.length, 3);
});
