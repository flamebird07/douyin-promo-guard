'use strict';

/**
 * Monitor Cookie 回写审计接线隔离测试（AD-GUARD-COOKIE-INTEGRITY-20261018 E 项）。
 *
 * 复现的缺口：Monitor._makeReader 构造千川费用/清单读取器（qcOpts）与罗盘订单读取器时
 * 均未传 audit，导致这些链路上的会话 Cookie 检查点/回写事件（含写入器新增的脱敏
 * before/expected/after SHA 指纹）从不落到既有审计文件与事件流。
 *
 * 本测试**不启动真实浏览器、不启动计时轮询**：
 *  - 用 require 缓存替换三个工厂函数，捕获 Monitor 实际传入的 opts；
 *  - 断言三类读取器都收到 audit 回调，且接线之外语义不变（loginCfg/adTypes 原样）；
 *  - 用**真实写入器** writebackSessionCookies + 临时目录合成 Cookie（FAKE_ 前缀，
 *    非真实凭据）经捕获的 audit 回调端到端验证：成功(done)与拒绝(validate)事件
 *    都落进 monitor.auditFile 与 processEvents，含 beforeSha256/expectedSha256/
 *    afterSha256 脱敏指纹，且审计全文不含任何 Cookie 值。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const { Monitor } = require('../src/engine/monitor');
const { makeTempDir, writeTempCookie, makeCfgResult } = require('./helpers');
const { writebackSessionCookies, fingerprintFile } = require('../src/login/cookie-writeback');

const qcMod = require('../src/adapters/qianchuan-reader');
const compassMod = require('../src/adapters/compass-order-reader');
const promoMod = require('../src/adapters/promo-reader');

function readAuditLines(auditFile) {
  if (!fs.existsSync(auditFile)) return [];
  return fs.readFileSync(auditFile, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('_makeReader 为千川费用/千川清单/罗盘读取器传入 audit，写入器事件端到端落到既有审计（文件+事件流，脱敏 SHA）', async (t) => {
  const cookieDir = makeTempDir('pg-audit-cookies-');
  const dataDir = makeTempDir('pg-audit-data-');
  const wbDir = makeTempDir('pg-audit-wb-');
  writeTempCookie(cookieDir, '测试店铺一');

  const origQcCost = qcMod.createQianchuanCostReader;
  const origQcAd = qcMod.createQianchuanAdListReader;
  const origCompass = compassMod.createCompassOrderReader;
  const origComposite = promoMod.createCompositeReader;
  t.after(() => {
    qcMod.createQianchuanCostReader = origQcCost;
    qcMod.createQianchuanAdListReader = origQcAd;
    compassMod.createCompassOrderReader = origCompass;
    promoMod.createCompositeReader = origComposite;
    for (const d of [cookieDir, dataDir, wbDir]) {
      fs.rmSync(d, { recursive: true, force: true });
    }
  });

  const captured = {};
  qcMod.createQianchuanCostReader = (p) => { captured.cost = p; return { connected: true, kind: 'cost' }; };
  qcMod.createQianchuanAdListReader = (p) => { captured.ad = p; return { connected: true, kind: 'adList' }; };
  compassMod.createCompassOrderReader = (p) => { captured.compass = p; return { connected: true, kind: 'order' }; };
  promoMod.createCompositeReader = (p) => { captured.composite = p; return { connected: true, kind: 'composite' }; };

  const cfgResult = makeCfgResult({
    cookieDir,
    monitor: { costDataSource: 'qianchuan', adListDataSource: 'qianchuan', orderDataSource: 'compass' },
  });
  const monitor = new Monitor(cfgResult, null, { dataDir, nowFn: () => Date.now() });
  const reader = monitor._makeReader();

  // ── 接线断言：三类读取器都收到 audit 回调；其余语义不变 ──
  assert.strictEqual(typeof captured.cost.audit, 'function', '千川费用读取器必须收到 audit 回调（此前未传 → 回写事件不落审计）');
  assert.strictEqual(typeof captured.ad.audit, 'function', '千川清单读取器必须收到 audit 回调');
  assert.strictEqual(typeof captured.compass.audit, 'function', '罗盘订单读取器必须收到 audit 回调');
  assert.strictEqual(captured.cost.loginCfg, cfgResult.config.login, '仅接入 audit，不改既有 loginCfg 接线');
  assert.strictEqual(captured.cost.nowFn, monitor.nowFn);
  assert.strictEqual(captured.cost.maxAdPages, cfgResult.config.execution.maxAdPages);
  assert.deepStrictEqual(captured.ad.adTypes, ['uni_promotion', 'standard'], '清单读取器 adTypes 语义不变');
  assert.strictEqual(captured.compass.loginCfg, cfgResult.config.login);
  assert.deepStrictEqual(
    { costReader: captured.composite.costReader, orderReader: captured.composite.orderReader, adReader: captured.composite.adReader },
    { costReader: { connected: true, kind: 'cost' }, orderReader: { connected: true, kind: 'order' }, adReader: { connected: true, kind: 'adList' } },
    '组合读取器装配语义不变'
  );
  assert.deepStrictEqual(reader, { connected: true, kind: 'composite' });

  // ── 端到端：真实写入器成功事件经费用读取器的 audit 回调落进 monitor 审计 ──
  const nowSec = Math.floor(Date.now() / 1000);
  const cookies = [
    { name: 'sessionid', value: 'FAKE_SESSIONID_AUDIT', domain: '.fxg.jinritemai.com', path: '/', expires: nowSec + 86400, httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'sid_guard', value: 'FAKE_SID_GUARD_AUDIT', domain: '.jinritemai.com', path: '/', expires: nowSec + 86400, httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'compass_pref', value: 'FAKE_PREF_AUDIT', domain: 'compass.jinritemai.com', path: '/', expires: nowSec + 86400, httpOnly: false, secure: true, sameSite: 'Lax' },
  ];
  const cookieFile = path.join(wbDir, '店铺.json');
  fs.writeFileSync(cookieFile, JSON.stringify(cookies, null, 2));
  const rotated = cookies.map((c) => (c.name === 'sessionid' ? { ...c, value: 'FAKE_SESSIONID_ROT' } : c));

  const wb = await writebackSessionCookies({
    context: { cookies: async () => rotated },
    cookieFilePath: cookieFile,
    sessionStartFingerprint: fingerprintFile(cookieFile),
    identityOk: true,
    loginOk: true,
    shopId: 'shop-001',
    audit: captured.cost.audit,
  });
  assert.strictEqual(wb.ok, true, wb.reason || '');

  const lines = readAuditLines(monitor.auditFile);
  const done = lines.find((l) => l.kind === 'cookie-writeback' && l.phase === 'done' && l.shopId === 'shop-001');
  assert.ok(done, '写入器 done 事件必须经 audit 回调落进 monitor 审计文件');
  assert.strictEqual(done.count, rotated.length);
  assert.match(String(done.beforeSha256), /^[0-9a-f]{64}$/, '审计含脱敏 before 指纹');
  assert.match(String(done.expectedSha256), /^[0-9a-f]{64}$/, '审计含脱敏 expected（自有写入）指纹');
  assert.strictEqual(done.afterSha256, done.expectedSha256, '写后校验一致时 after=expected');
  assert.strictEqual(done.expectedSha256, wb.expectedSha256);
  assert.strictEqual(done.verification, 'exact-bytes');

  // ── 端到端：拒绝事件（缺 sid_guard）经罗盘读取器的 audit 回调同样落审计 ──
  const wb2 = await writebackSessionCookies({
    context: { cookies: async () => rotated.filter((c) => c.name !== 'sid_guard') },
    cookieFilePath: cookieFile,
    sessionStartFingerprint: fingerprintFile(cookieFile),
    identityOk: true,
    loginOk: true,
    shopId: 'shop-001',
    audit: captured.compass.audit,
  });
  assert.strictEqual(wb2.ok, false);
  assert.strictEqual(wb2.skipped, true);
  const rejected = readAuditLines(monitor.auditFile)
    .find((l) => l.kind === 'cookie-writeback' && l.phase === 'validate' && Array.isArray(l.authMissing) && l.authMissing.includes('sid_guard'));
  assert.ok(rejected, '写入器 validate 拒绝事件必须落进 monitor 审计文件');

  // ── 事件流同源（_audit 双出口）：processEvents 也能看到写入器事件 ──
  const evts = monitor.processEvents.filter((e) => e.evtType === 'process' && e.kind === 'cookie-writeback');
  assert.ok(evts.some((e) => e.phase === 'done' && e.expectedSha256 === wb.expectedSha256), '事件流含 done 事件与自有写入指纹');
  assert.ok(evts.some((e) => e.phase === 'validate'), '事件流含 validate 拒绝事件');

  // ── 脱敏底线：审计文件与事件流全文不含任何合成 Cookie 值 ──
  const auditDump = fs.readFileSync(monitor.auditFile, 'utf-8');
  const evtDump = JSON.stringify(monitor.processEvents);
  for (const secret of ['FAKE_SESSIONID_AUDIT', 'FAKE_SESSIONID_ROT', 'FAKE_SID_GUARD_AUDIT', 'FAKE_PREF_AUDIT']) {
    assert.ok(!auditDump.includes(secret), `审计文件不得含 Cookie 值（泄漏：${secret}）`);
    assert.ok(!evtDump.includes(secret), `事件流不得含 Cookie 值（泄漏：${secret}）`);
  }
});

test('mock 数据源路径不受影响：_makeReader 不接入千川/罗盘工厂（调度/读取语义零改动）', (t) => {
  const cookieDir = makeTempDir('pg-audit2-cookies-');
  const dataDir = makeTempDir('pg-audit2-data-');
  t.after(() => {
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const cfgResult = makeCfgResult({ cookieDir, monitor: { mockDataSource: true, mockData: { cost: { valueCents: 100 }, orders: 1 } } });
  const monitor = new Monitor(cfgResult, null, { dataDir, nowFn: () => Date.now() });
  const r = monitor._makeReader();
  assert.ok(r, 'mock 数据源仍返回 mock 读取器（本修复只动真实源接线）');
});
