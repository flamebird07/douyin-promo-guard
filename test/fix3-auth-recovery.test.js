'use strict';

/**
 * fix3：简尚收紧口径（固定四份候选 + 可切换多账号 + 有界核验）专项测试。
 *
 * 覆盖（本单最低验收）：
 *   A. 某健康候选（不同会话、更晚过期）成功切换：.bak-fix3-* 备份 + 原子提升 + 只核验一次；
 *   B. 四份全不可用（同会话/写坏）→ 证据包 + 对照店 checkLogin 通过 → auth 结案，
 *      回调触发；工作副本零覆盖；
 *   C. 写坏窄定义：缺 auth 三键 / 不可解析才算写坏；文件健康但源端不认 ≠ 写坏；
 *   D. 已登记多账号副本可切换（有才用，不硬补第二账号）；
 *   E. auth 结案后 Monitor 释放该店 serial_gate（不堵后续店铺），无结案证据时不释放。
 *
 * 全部使用 os.tmpdir() 隔离目录；浏览器/验证器一律桩对象；不含任何真实 Cookie 值。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runFix3Recovery, inspectCookieHealth, isWrittenBad } = require('../src/login/auth-recovery-fix3');
const session = require('../src/login/session');
const { Monitor } = require('../src/engine/monitor');
const { makeCfgResult } = require('./helpers');

const SHOP = '简尚衣橱优品店';
const NOW = Date.UTC(2026, 10, 2, 4, 0, 0); // 2026-11-02T04:00:00Z

function makeCookies(tag, expires) {
  return [
    { name: 'sessionid', value: `sid-${tag}-SECRET`, domain: '.jinritemai.com', path: '/', expires },
    { name: 'sessionid_ss', value: `ss-${tag}-SECRET`, domain: '.jinritemai.com', path: '/', expires },
    { name: 'sid_tt', value: `tt-${tag}-SECRET`, domain: '.jinritemai.com', path: '/', expires },
    { name: 'ttwid', value: `ttw-${tag}`, domain: '.iesdouyin.com', path: '/', expires },
  ];
}

function bytesOf(cookies) {
  return Buffer.from(JSON.stringify(cookies, null, 2), 'utf8');
}

function mkBase() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fix3-')));
  const d = {
    base,
    workDir: path.join(base, 'guard-cookies'),
    sourceDir: path.join(base, 'source-cookies'),
    recoveryDir: path.join(base, 'cookie-recovery'),
    archiveRoot: path.join(base, 'cookie-archive', 'raw'),
  };
  for (const p of [d.workDir, d.sourceDir, d.recoveryDir, d.archiveRoot]) fs.mkdirSync(p, { recursive: true });
  fs.mkdirSync(path.join(d.recoveryDir, SHOP), { recursive: true });
  fs.mkdirSync(path.join(d.archiveRoot, SHOP), { recursive: true });
  return d;
}

function writeJson(p, cookies) {
  fs.writeFileSync(p, bytesOf(cookies));
}

function attemptsOf(res) {
  return res.attempts.reduce((m, a) => { m[a.slot] = a; return m; }, {});
}

test('A 某健康候选成功切换：.bak-fix3-* 备份 + 原子提升 + 只核验不同会话候选', async () => {
  const d = mkBase();
  const work = makeCookies('work', 1900000000);
  const workBytes = bytesOf(work);
  fs.writeFileSync(path.join(d.workDir, `${SHOP}.json`), workBytes);
  // 来源层：与工作副本同字节（同一 auth 指纹）→ 必须判 same-session，不重复送验
  fs.writeFileSync(path.join(d.sourceDir, `${SHOP}.json`), workBytes);
  // 恢复层：不同会话、更晚过期 → 唯一合法候选
  const fresh = makeCookies('fresh', 1900500000);
  writeJson(path.join(d.recoveryDir, SHOP, 'v20261101T000000Z-1-aaaa.json'), fresh);
  // 归档层：不同会话但更早过期 → older-session，不覆盖
  writeJson(path.join(d.archiveRoot, SHOP, 'v20261020T000000Z-1-bbbb.json'), makeCookies('old', 1890000000));

  const verified = [];
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir, cookieSourceDir: d.sourceDir },
    SHOP,
    {
      candidatePolicy: 'fix3-four',
      shopCfg: { name: SHOP, compassShopName: SHOP },
      excludeWorkCopy: true,
      recoveryDir: d.recoveryDir,
      nowFn: () => NOW,
      nowMs: NOW,
      verify: async (p) => {
        verified.push(p.source);
        return p.source === 'guard-recovery'
          ? { ok: true, finalCookies: p.cookies }
          : { ok: false, classification: 'login-invalid', reason: '桩：非目标候选' };
      },
      controlCheck: async () => ({ ok: true, shop: '对照店' }),
    },
  );

  assert.strictEqual(res.ok, true, JSON.stringify(res.attempts));
  assert.strictEqual(res.source, 'guard-recovery');
  assert.strictEqual(res.verificationCalls, 1, '同会话/更旧候选不得进入核验');
  assert.deepStrictEqual(verified, ['guard-recovery']);

  const at = attemptsOf(res);
  assert.strictEqual(at.source.decision, 'same-session');
  assert.strictEqual(at.archive.decision, 'older-session');
  assert.strictEqual(at.recovery.decision, 'eligible');

  // 备份必须是 .bak-fix3-*，且与旧工作副本逐字节相同
  const backups = fs.readdirSync(d.workDir).filter((f) => f.includes('.bak-fix3-'));
  assert.strictEqual(backups.length, 1, JSON.stringify(fs.readdirSync(d.workDir)));
  assert.ok(fs.readFileSync(path.join(d.workDir, backups[0])).equals(workBytes));
  assert.ok(res.backupPath && res.backupPath.includes('.bak-fix3-'));

  // 提升后工作副本 = 最终已验证集合；来源/恢复/归档只读不动
  const after = JSON.parse(fs.readFileSync(path.join(d.workDir, `${SHOP}.json`), 'utf8'));
  assert.deepStrictEqual(after, fresh);
  assert.ok(fs.readFileSync(path.join(d.sourceDir, `${SHOP}.json`)).equals(workBytes), '来源层不得被改写');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d.recoveryDir, SHOP, 'v20261101T000000Z-1-aaaa.json'), 'utf8')), fresh);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d.archiveRoot, SHOP, 'v20261020T000000Z-1-bbbb.json'), 'utf8'))[0].value, 'sid-old-SECRET');

  // 证据/审计不得出现 Cookie value
  assert.ok(!JSON.stringify(res.evidence).includes('SECRET'), '证据包不得含 Cookie value');
});

test('B 四份全不可用 + 对照店通过 → auth 结案、证据包完整、零覆盖', async () => {
  const d = mkBase();
  const work = makeCookies('work', 1900000000);
  const workBytes = bytesOf(work);
  fs.writeFileSync(path.join(d.workDir, `${SHOP}.json`), workBytes);
  fs.writeFileSync(path.join(d.sourceDir, `${SHOP}.json`), workBytes);
  writeJson(path.join(d.recoveryDir, SHOP, 'v20261101T000000Z-1-aaaa.json'), work);
  writeJson(path.join(d.archiveRoot, SHOP, 'v20261020T000000Z-1-bbbb.json'), work);

  let closed = null;
  const res = await runFix3Recovery(
    { cookieWorkDir: d.workDir, cookieSourceDir: d.sourceDir },
    SHOP,
    {
      workDir: d.workDir,
      shopCfg: { name: SHOP, compassShopName: SHOP },
      excludeWorkCopy: true,
      recoveryDir: d.recoveryDir,
      archiveRoot: d.archiveRoot,
      nowFn: () => NOW,
      nowMs: NOW,
      verify: async () => { throw new Error('同会话候选不得被送验'); },
      controlCheck: async () => ({ ok: true, shop: '瑾漂亮潮流服饰', reason: '对照店读数正常' }),
      onAuthClosedOut: async (ev) => { closed = ev; },
    },
  );

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.authClosedOut, true, JSON.stringify(res));
  assert.strictEqual(res.verificationCalls, 0, '同会话候选不得重复送验');
  assert.ok(res.evidence, '必须交付证据包');
  assert.strictEqual(res.evidence.candidates.length, 4, '固定四份候选必须齐全');
  assert.strictEqual(res.evidence.falsePositiveExclusion.controlShopNotFalselyKilled, true);
  assert.strictEqual(res.evidence.falsePositiveExclusion.healthyFileNotOverwritten, true);
  assert.ok(!/扫码/.test(res.evidence.conclusion) || /不要求扫码/.test(res.evidence.conclusion));
  assert.ok(closed && closed.authClosedOut === true, 'auth 结案必须触发回调');

  // 零覆盖、零备份
  assert.ok(fs.readFileSync(path.join(d.workDir, `${SHOP}.json`)).equals(workBytes));
  assert.ok(!fs.readdirSync(d.workDir).some((f) => f.includes('.bak-fix3-')));
  assert.ok(!JSON.stringify(res.evidence).includes('SECRET'));
});

test('C 写坏窄定义：缺 auth 三键/不可解析才算写坏；文件健康但源端不认 ≠ 写坏', async () => {
  const d = mkBase();
  const work = makeCookies('work', 1900000000);
  fs.writeFileSync(path.join(d.workDir, `${SHOP}.json`), bytesOf(work));
  // 来源：结构健康、不同会话，但独立核验判登录无效（源端不认）
  const source = makeCookies('source', 1900000000);
  fs.writeFileSync(path.join(d.sourceDir, `${SHOP}.json`), bytesOf(source));
  // 恢复层：缺 auth 三键（窄写坏）
  fs.writeFileSync(path.join(d.recoveryDir, SHOP, 'v20261101T000000Z-1-aaaa.json'),
    JSON.stringify([{ name: 'ttwid', value: 'x', domain: '.iesdouyin.com', path: '/', expires: 1900000000 }]));
  // 归档层：不可解析
  fs.writeFileSync(path.join(d.archiveRoot, SHOP, 'v20261020T000000Z-1-bbbb.json'), '{not-json');

  const res = await runFix3Recovery(
    { cookieWorkDir: d.workDir, cookieSourceDir: d.sourceDir },
    SHOP,
    {
      workDir: d.workDir,
      shopCfg: { name: SHOP, compassShopName: SHOP },
      excludeWorkCopy: true,
      recoveryDir: d.recoveryDir,
      archiveRoot: d.archiveRoot,
      nowFn: () => NOW,
      nowMs: NOW,
      verify: async () => ({ ok: false, classification: 'login-invalid', reason: '独立浏览器落登录页' }),
      controlCheck: async () => ({ ok: true }),
    },
  );

  const at = attemptsOf(res);
  assert.strictEqual(at.recovery.decision, 'written-bad');
  assert.strictEqual(at.archive.decision, 'written-bad');
  assert.strictEqual(at.source.decision, 'eligible');
  assert.strictEqual(at.source.verification.result, 'verify-failed');
  assert.strictEqual(at.source.verification.classification, 'login-invalid');
  assert.strictEqual(res.authClosedOut, true);

  // 直接校验健康判定
  const missing = inspectCookieHealth(Buffer.from(JSON.stringify([{ name: 'ttwid', value: 'x', domain: '.iesdouyin.com', path: '/', expires: 1900000000 }])));
  assert.strictEqual(missing.verdict, 'bad-auth-missing');
  assert.strictEqual(isWrittenBad(missing), true);
  const healthy = inspectCookieHealth(Buffer.from(JSON.stringify(source)), { nowMs: NOW });
  assert.strictEqual(healthy.verdict, 'healthy');
  assert.strictEqual(isWrittenBad(healthy), false, '健康文件不得被判写坏');
});

test('D 已登记多账号副本可切换：只切有配置的账号，不硬补第二账号', async () => {
  const d = mkBase();
  const work = makeCookies('primary', 1900000000);
  fs.writeFileSync(path.join(d.workDir, `${SHOP}.json`), bytesOf(work));
  fs.writeFileSync(path.join(d.sourceDir, `${SHOP}.json`), bytesOf(work));
  // 已登记第二账号工作副本
  const account2 = makeCookies('account2', 1900300000);
  writeJson(path.join(d.workDir, `${SHOP}-2.json`), account2);

  const verified = [];
  const res = await runFix3Recovery(
    { cookieWorkDir: d.workDir, cookieSourceDir: d.sourceDir },
    SHOP,
    {
      workDir: d.workDir,
      shopCfg: { name: SHOP, compassShopName: SHOP, cookieFiles: [SHOP, `${SHOP}-2`, `${SHOP}-missing`] },
      excludeWorkCopy: true,
      recoveryDir: d.recoveryDir,
      archiveRoot: d.archiveRoot,
      nowFn: () => NOW,
      nowMs: NOW,
      verify: async (p) => {
        verified.push(p.source);
        return { ok: true, finalCookies: p.cookies };
      },
      controlCheck: async () => ({ ok: true }),
    },
  );

  assert.strictEqual(res.ok, true, JSON.stringify(res));
  assert.strictEqual(res.source, `account-work:${SHOP}-2.json`);
  assert.deepStrictEqual(verified, [`account-work:${SHOP}-2.json`]);
  assert.ok(!res.attempts.some((a) => a.slot.includes('missing')), '未登记/不存在的账号不得凭空补位');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(d.workDir, `${SHOP}.json`), 'utf8'))[0].value, 'sid-account2-SECRET');
  // 多账号文件本身不得被改写
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(d.workDir, `${SHOP}-2.json`), 'utf8')), account2);
});

// ── E. Monitor：auth 结案释放 serial_gate ──────────────────────────────
const DAY = '2026-11-02';

function seedUnknownSlot(dataDir) {
  fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify({
    version: 1,
    batches: {},
    enablePhase: {},
    adBelief: {},
    enableScheduler: {},
    switchSlots: {
      slots: [{
        shopId: 'shop-a', action: 'enable', actionId: 'act_auth_1',
        startedAt: NOW, confirmed: false, settled: false, unknown: true, blockedReason: 'auth 失效前遗留',
      }],
    },
    savedAt: new Date().toISOString(),
  }));
}

function buildMonitor(dataDir, opts = {}) {
  const cfgResult = makeCfgResult({
    shops: [
      { id: 'shop-a', name: '简尚', cookieFile: '简尚', accountId: null, enabled: true },
      { id: 'shop-b', name: '瑾漂亮', cookieFile: '瑾漂亮', accountId: null, enabled: true },
    ],
    monitor: { legacyWholeShopCloseEnabled: true, chengfang: { scope: ['全店托管', '商品自选'] } },
  });
  return new Monitor(cfgResult, null, {
    dataDir,
    nowFn: () => NOW,
    readAdState: opts.readAdState || (async () => ({ state: 'unknown' })),
  });
}

test('E1 auth 结案证据 → 释放该店 unknown serial_gate；他店不受影响', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix3-mon-'));
  seedUnknownSlot(dataDir);
  const monitor = buildMonitor(dataDir);
  const orch = monitor._switchOrchestrator;
  assert.strictEqual(orch.hasUnknownBlock('shop-a'), true);

  monitor._applyReadFailure('shop-a', {
    kind: 'auth',
    blocked: 'auth',
    reason: '登录失效：持续登录页',
    authClosure: { authClosedOut: true, evidence: { conclusion: 'auth 结案：固定四份候选均不可用（不要求扫码）' } },
  });

  assert.strictEqual(orch.hasUnknownBlock('shop-a'), false, 'auth 结案后该店串行门必须释放');
  assert.strictEqual(orch.isBusy('shop-a'), false);
  const begin = monitor._switchGate.tryBegin('shop-a', 'enable');
  assert.strictEqual(begin.ok, true, JSON.stringify(begin));
  // 他店不被牵连
  assert.strictEqual(orch.hasUnknownBlock('shop-b'), false);
  assert.strictEqual(monitor._otherBusyOrUnprovenShop('shop-b'), null);
  // 结案前必须已落盘证据包（脱敏）
  const evDir = path.join(dataDir, 'auth-evidence');
  assert.ok(fs.existsSync(evDir), '证据包目录必须存在');
  const evFiles = fs.readdirSync(evDir).filter((f) => f.endsWith('.json'));
  assert.strictEqual(evFiles.length, 1, JSON.stringify(evFiles));
  assert.ok(!fs.readFileSync(path.join(evDir, evFiles[0]), 'utf8').includes('SECRET'));
  monitor.stop();
});

test('E2 无 auth 结案证据 → 不释放串行门（保持既有 fail-closed）', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix3-mon-'));
  seedUnknownSlot(dataDir);
  const monitor = buildMonitor(dataDir);
  const orch = monitor._switchOrchestrator;

  monitor._applyReadFailure('shop-a', { kind: 'auth', blocked: 'auth', reason: '登录失效：持续登录页' });

  assert.strictEqual(orch.hasUnknownBlock('shop-a'), true, '无结案证据不得释放未知槽');
  monitor.stop();
});

test('E3 读取器抛出的 authClosure 证据必须原样进入 _readCurrentAdState.error（不丢结案依据）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix3-mon-'));
  const monitor = buildMonitor(dataDir, {
    readAdState: async () => {
      const e = new Error('登录失效：持续登录页');
      e.reason = '登录失效：持续登录页';
      e.code = 'AUTH';
      e.authClosure = { authClosedOut: true, evidence: { conclusion: 'auth 结案：不要求扫码' } };
      throw e;
    },
  });
  const r = await monitor._readCurrentAdState({ id: 'shop-a', name: '简尚' });
  assert.strictEqual(r.state, 'unknown');
  assert.ok(r.error && r.error.authClosure, '错误对象必须保留 authClosure');
  assert.strictEqual(r.error.authClosure.authClosedOut, true);
  monitor.stop();
});

test('F 有界核验：多账号+候选最多 4 次；.prev-* 不入候选', async () => {
  const d = mkBase();
  const work = makeCookies('work', 1900000000);
  fs.writeFileSync(path.join(d.workDir, `${SHOP}.json`), bytesOf(work));
  // 来源不同会话（可核验）
  fs.writeFileSync(path.join(d.sourceDir, `${SHOP}.json`), bytesOf(makeCookies('src', 1900000000)));
  // 恢复/归档同会话（跳过）
  writeJson(path.join(d.recoveryDir, SHOP, 'v20261101T000000Z-1-aaaa.json'), work);
  writeJson(path.join(d.archiveRoot, SHOP, 'v20261020T000000Z-1-bbbb.json'), work);
  // 已登记 4 个账号（模块上限 3）
  const accountFiles = [];
  for (let i = 2; i <= 5; i += 1) {
    const f = `${SHOP}-${i}.json`;
    accountFiles.push(f);
    writeJson(path.join(d.workDir, f), makeCookies(`acct${i}`, 1900000000));
  }
  // .prev-* 即使更新也不得成为候选
  writeJson(path.join(d.workDir, `${SHOP}.json.prev-9999999999999-abcdef`), makeCookies('prev', 1900900000));

  let calls = 0;
  const res = await runFix3Recovery(
    { cookieWorkDir: d.workDir, cookieSourceDir: d.sourceDir },
    SHOP,
    {
      workDir: d.workDir,
      shopCfg: { name: SHOP, compassShopName: SHOP, cookieFiles: [SHOP, ...accountFiles] },
      excludeWorkCopy: true,
      recoveryDir: d.recoveryDir,
      archiveRoot: d.archiveRoot,
      nowFn: () => NOW,
      nowMs: NOW,
      verify: async () => { calls += 1; return { ok: false, classification: 'login-invalid', reason: '桩：失败' }; },
      controlCheck: async () => ({ ok: true }),
    },
  );

  assert.strictEqual(res.ok, false);
  assert.strictEqual(calls, 4, `核验次数必须有界为 4，实际 ${calls}`);
  assert.strictEqual(res.verificationCalls, 4);
  assert.ok(!res.attempts.some((a) => a.fileName && a.fileName.includes('.prev-')), '.prev-* 不得入候选');
  const accountSlots = res.attempts.filter((a) => String(a.slot).startsWith('account:'));
  assert.strictEqual(accountSlots.length, 3, '已登记账号候选上限 3');
});
