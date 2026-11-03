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
 *   G/B2/E4（CODE_FAIL 加严 2026-11-02）：fix3-four 对外/AuthError/结案文案在**已结案
 *      与未结案**两种终态下都不含「扫码」类字样；Monitor 对外提示同样不含。
 *
 * 全部使用 os.tmpdir() 隔离目录；浏览器/验证器一律桩对象；不含任何真实 Cookie 值。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { runFix3Recovery, inspectCookieHealth, isWrittenBad } = require('../src/login/auth-recovery-fix3');
const { buildAuthFailureSuffix } = require('../src/login/auth-failure-text');
const { discoverShopAccountByLiveSession } = require('../plan-publisher/run-plans.cjs');
const session = require('../src/login/session');
const { Monitor } = require('../src/engine/monitor');
const { makeCfgResult, writeTempCookie } = require('./helpers');

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
  // CODE_FAIL 加严：结案文案一律不含扫码类字样
  assert.ok(!/扫码/.test(res.evidence.conclusion), `结案结论不得含扫码字样：${res.evidence.conclusion}`);
  assert.ok(!/扫码/.test(res.reason), `结案原因不得含扫码字样：${res.reason}`);
  assert.ok(closed && closed.authClosedOut === true, 'auth 结案必须触发回调');

  // 零覆盖、零备份
  assert.ok(fs.readFileSync(path.join(d.workDir, `${SHOP}.json`)).equals(workBytes));
  assert.ok(!fs.readdirSync(d.workDir).some((f) => f.includes('.bak-fix3-')));
  assert.ok(!JSON.stringify(res.evidence).includes('SECRET'));
});

test('B2 四份全不可用 + 对照店未提供 → 未结案：文案同样不得含扫码字样', async () => {
  const d = mkBase();
  const work = makeCookies('work', 1900000000);
  const workBytes = bytesOf(work);
  fs.writeFileSync(path.join(d.workDir, `${SHOP}.json`), workBytes);
  fs.writeFileSync(path.join(d.sourceDir, `${SHOP}.json`), workBytes);
  writeJson(path.join(d.recoveryDir, SHOP, 'v20261101T000000Z-1-aaaa.json'), work);
  writeJson(path.join(d.archiveRoot, SHOP, 'v20261020T000000Z-1-bbbb.json'), work);

  let closedCalled = false;
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
      // 未注入对照店 checkLogin → 未完成误判排除 → 不结案
      onAuthClosedOut: async () => { closedCalled = true; },
    },
  );

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.authClosedOut, false, JSON.stringify(res));
  assert.strictEqual(closedCalled, false, '未结案不得触发结案回调');
  assert.ok(!/扫码/.test(res.evidence.conclusion), `未结案结论不得含扫码字样：${res.evidence.conclusion}`);
  assert.ok(!/扫码/.test(res.reason), `未结案原因不得含扫码字样：${res.reason}`);
  assert.ok(!JSON.stringify(res.evidence).includes('扫码'), '未结案证据包整体不得含扫码字样');
  // fix3 文案拆分：未注入对照店检查 = 「未提供」，不得再与「未通过」合并误导
  assert.ok(res.reason.includes('对照店 checkLogin 未提供'), `未注入对照店时文案必须是「未提供」：${res.reason}`);
  assert.ok(!res.reason.includes('未通过'), `未注入对照店时不得出现「未通过」混淆：${res.reason}`);
  assert.ok(fs.readFileSync(path.join(d.workDir, `${SHOP}.json`)).equals(workBytes), '未结案不得覆盖工作副本');
});

test('B3 四份全不可用 + 对照店已提供但 checkLogin 未通过 → 未结案且文案只说「未通过」', async () => {
  const d = mkBase();
  const work = makeCookies('work', 1900000000);
  const workBytes = bytesOf(work);
  fs.writeFileSync(path.join(d.workDir, `${SHOP}.json`), workBytes);
  fs.writeFileSync(path.join(d.sourceDir, `${SHOP}.json`), workBytes);
  writeJson(path.join(d.recoveryDir, SHOP, 'v20261101T000000Z-1-aaaa.json'), work);
  writeJson(path.join(d.archiveRoot, SHOP, 'v20261020T000000Z-1-bbbb.json'), work);

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
      // 对照店检查已注入但未通过 → 与「未提供」必须可区分
      controlCheck: async () => ({ ok: false, reason: '对照店 checkLogin 未通过（测试）' }),
    },
  );

  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.authClosedOut, false, JSON.stringify(res));
  assert.strictEqual(res.controlCheck.ok, false);
  assert.strictEqual(res.controlCheck.skipped, undefined, '已注入对照店检查时不得标记 skipped');
  assert.ok(res.reason.includes('对照店 checkLogin 未通过'), `已跑对照店时文案必须是「未通过」：${res.reason}`);
  assert.ok(!res.reason.includes('未提供'), `已跑对照店时不得出现「未提供」混淆：${res.reason}`);
  assert.ok(!/扫码/.test(res.reason), `未结案原因不得含扫码字样：${res.reason}`);
  assert.ok(fs.readFileSync(path.join(d.workDir, `${SHOP}.json`)).equals(workBytes), '未结案不得覆盖工作副本');
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

test('G 对外登录失效文案：fix3-four 与默认五层结案/未结案均不含扫码字样', () => {
  const closed = buildAuthFailureSuffix({ policy: 'fix3-four', authClosedOut: true, restoreReason: '桩' });
  const open = buildAuthFailureSuffix({ policy: 'fix3-four', authClosedOut: false, restoreReason: '固定四份候选均不可用（验证调用 0 次）：对照店 checkLogin 未通过/未提供，未完成误判排除，不结案（保持原读取失败语义，不要求重新登录旁路）' });
  for (const [name, s] of [['已结案', closed], ['未结案', open]]) {
    assert.ok(!/扫码/.test(s.tail), `${name} tail 不得含扫码字样：${s.tail}`);
    assert.ok(!/扫码/.test(s.restoreNote), `${name} restoreNote 不得含扫码字样：${s.restoreNote}`);
  }
  assert.match(open.tail, /未结案/, '未结案文案必须显式标注未结案');
  assert.match(open.tail, /不要求重新登录旁路/, '未结案文案必须给出非扫码旁路');
  // 全仓加严（2026-11-02）：默认五层恢复的对外文案同样不得出现扫码类结论。
  for (const policy of [undefined, 'five-layer']) {
    for (const authClosedOut of [true, false]) {
      const s = buildAuthFailureSuffix({ policy, authClosedOut, restoreReason: '桩' });
      assert.ok(!/扫码/.test(s.tail), `policy=${policy} closed=${authClosedOut} tail 含扫码：${s.tail}`);
      assert.ok(!/扫码/.test(s.restoreNote), `policy=${policy} closed=${authClosedOut} restoreNote 含扫码：${s.restoreNote}`);
      assert.match(s.tail, /不要求重新登录旁路/);
    }
  }
});

// ── H. discovery 打开链：policy 透传 + discovery-open-failed 文案锁死 ──────────
test('H discovery 打开链透传 authRecoveryPolicy=fix3-four，discovery-open-failed 文案无扫码', async () => {
  const seen = [];
  const res = await discoverShopAccountByLiveSession(
    { id: SHOP, name: SHOP, cookieFile: SHOP, authRecoveryPolicy: 'fix3-four' },
    { accountId: null },
    {
      projectRoot: path.join(__dirname, '..'),
      loginCfg: {},
      openShop: async (p) => {
        seen.push(p);
        const suffix = buildAuthFailureSuffix({
          policy: p.restoreCandidatePolicy || (p.shopCfg && p.shopCfg.authRecoveryPolicy),
          authClosedOut: false,
          restoreReason: '桩：discovery 打开链',
        });
        throw new Error(`登录失效：桩${suffix.tail}${suffix.restoreNote}`);
      },
    },
  );
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].shopCfg.authRecoveryPolicy, 'fix3-four', 'shopCfg 必须原样携带 policy');
  assert.strictEqual(seen[0].restoreCandidatePolicy, 'fix3-four', '打开参数必须显式透传 policy');
  assert.match(String(res.error), /^discovery-open-failed:/);
  assert.ok(!/扫码/.test(String(res.error)), `discovery-open-failed 不得含扫码：${res.error}`);
});

test('H2 discovery 默认（未登记 policy）失败文案同样无扫码', async () => {
  const res = await discoverShopAccountByLiveSession(
    { id: '其他店', name: '其他店', cookieFile: '其他店' },
    { accountId: null },
    {
      projectRoot: path.join(__dirname, '..'),
      loginCfg: {},
      openShop: async (p) => {
        const suffix = buildAuthFailureSuffix({
          policy: p.restoreCandidatePolicy || (p.shopCfg && p.shopCfg.authRecoveryPolicy),
          authClosedOut: false,
          restoreReason: '桩：默认五层',
        });
        throw new Error(`登录失效：桩${suffix.tail}${suffix.restoreNote}`);
      },
    },
  );
  assert.match(String(res.error), /^discovery-open-failed:/);
  assert.ok(!/扫码/.test(String(res.error)), `默认路径 discovery-open-failed 不得含扫码：${res.error}`);
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
    reason: '登录失效：持续登录页；auth 结案（不要求重新登录旁路）',
    authClosure: { authClosedOut: true, evidence: { policy: 'fix3-four', conclusion: 'auth 结案：固定四份候选均不可用（不要求重新登录旁路）' } },
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
  // 对外提示：fix3 结案路径不得含扫码字样
  const hint = monitor._runtime('shop-a').lastReadError.hint;
  assert.ok(typeof hint === 'string' && hint.length > 0);
  assert.ok(!/扫码/.test(hint), `已结案对外提示不得含扫码字样：${hint}`);
  monitor.stop();
});

test('E4 未结案（authClosedOut=false）→ 不释放串行门，对外提示同样不得含扫码字样', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix3-mon-'));
  seedUnknownSlot(dataDir);
  const monitor = buildMonitor(dataDir);
  const orch = monitor._switchOrchestrator;

  monitor._applyReadFailure('shop-a', {
    kind: 'auth',
    blocked: 'auth',
    reason: '登录失效：持续登录页；auth 未结案：无可用会话候选或对照店检查未通过（不要求重新登录旁路）',
    authClosure: { authClosedOut: false, evidence: { policy: 'fix3-four', authClosedOut: false, conclusion: '未结案：全候选不可用，但对照片 checkLogin 未通过或未提供，保持原读取失败语义（不释放串行门，不要求重新登录旁路）' } },
  });

  assert.strictEqual(orch.hasUnknownBlock('shop-a'), true, '未结案不得释放未知槽');
  const hint = monitor._runtime('shop-a').lastReadError.hint;
  assert.ok(typeof hint === 'string' && hint.length > 0);
  assert.ok(!/扫码/.test(hint), `未结案对外提示不得含扫码字样：${hint}`);
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
      e.reason = '登录失效：持续登录页；auth 结案（不要求重新登录旁路）';
      e.code = 'AUTH';
      e.authClosure = { authClosedOut: true, evidence: { policy: 'fix3-four', conclusion: 'auth 结案：不要求重新登录旁路' } };
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

// ── G. 生产 opt-in 接线（2026-11-02）──────────────────────────────────
// 覆盖：配置只给简尚登记 fix3-four；对照店 checkLogin 注入；未提供/未通过 → 未结案；
// 对照店通过 → 可结案；onAuthClosedOut 显式落盘+释放门且不重复写盘；
// 未登记 policy 的店铺仍走默认五层恢复。

test('G1 配置 opt-in：仅简尚登记 authRecoveryPolicy=fix3-four，他店不动', () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'config.json'), 'utf8'));
  const js = (cfg.shops || []).find((s) => s && s.id === SHOP);
  assert.ok(js, '配置必须包含简尚衣橱优品店');
  assert.strictEqual(js.authRecoveryPolicy, 'fix3-four');
  for (const s of cfg.shops) {
    if (s.id === SHOP) continue;
    assert.strictEqual(s.authRecoveryPolicy, undefined, `店 ${s.id} 不得登记 fix3-four`);
  }
});

test('G2 策略路由：简尚 opt-in → fix3-four；无 policy 的店仍走默认五层', async () => {
  const d = mkBase();
  fs.writeFileSync(path.join(d.workDir, `${SHOP}.json`), bytesOf(makeCookies('work', 1900000000)));
  const loginCfg = { cookieWorkDir: d.workDir, douyinHomeUrl: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index' };
  const common = {
    workDir: d.workDir,
    excludeWorkCopy: true,
    recoveryDir: d.recoveryDir,
    archiveRoot: d.archiveRoot,
    nowFn: () => NOW,
    nowMs: NOW,
    verify: async () => ({ ok: false, classification: 'login-invalid', reason: '桩：失败' }),
  };

  const fix3 = await session.restoreDutyWorkCopy(loginCfg, SHOP, {
    ...common,
    shopCfg: { name: SHOP, compassShopName: SHOP, authRecoveryPolicy: 'fix3-four' },
    candidatePolicy: 'fix3-four',
  });
  assert.strictEqual(fix3.ok, false);
  assert.strictEqual(fix3.policy, 'fix3-four', '简尚 opt-in 必须走 fix3-four');
  assert.strictEqual(fix3.authClosedOut, false, '未注入对照店 checkLogin → 未结案');

  const legacy = await session.restoreDutyWorkCopy(loginCfg, SHOP, {
    ...common,
    shopCfg: { name: SHOP, compassShopName: SHOP },
    candidatePolicy: undefined,
  });
  assert.strictEqual(legacy.ok, false);
  assert.strictEqual(legacy.policy, undefined, '未登记 policy 的店不得被 fix3-four 接管');
  assert.ok(Array.isArray(legacy.attempts), '默认五层恢复必须给出候选尝试记录');
});

function buildControlMonitor(opts = {}) {
  const cookieDir = opts.cookieDir || fs.mkdtempSync(path.join(os.tmpdir(), 'fix3-ctl-cookies-'));
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'fix3-ctl-data-'));
  const shops = opts.shops || [
    { id: SHOP, name: SHOP, cookieFile: SHOP, enabled: true },
    { id: '瑾漂亮潮流服饰', name: '瑾漂亮潮流服饰', cookieFile: '瑾漂亮潮流服饰', enabled: true },
  ];
  const cfgResult = makeCfgResult({
    shops,
    cookieWorkDir: cookieDir,
    monitor: { legacyWholeShopCloseEnabled: true, chengfang: { scope: ['全店托管', '商品自选'] } },
  });
  const calls = [];
  const monitor = new Monitor(cfgResult, null, {
    dataDir,
    nowFn: () => NOW,
    readAdState: async () => ({ state: 'unknown' }),
    authControlLogin: opts.authControlLogin || (async (loginCfg, cookiePath) => {
      calls.push(cookiePath);
      return { loggedIn: opts.loggedIn !== false, url: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index' };
    }),
  });
  return { monitor, cookieDir, dataDir, calls, shops };
}

test('G3 对照店 checkLogin：可用 → ok；未提供对照店/他店在途 → fail-closed 未结案', async () => {
  const { monitor, cookieDir, shops } = buildControlMonitor();
  writeTempCookie(cookieDir, SHOP);
  writeTempCookie(cookieDir, '瑾漂亮潮流服饰');
  const self = shops[0];

  const ok = await monitor._authControlCheck(self, { shopSafeName: SHOP });
  assert.strictEqual(ok.ok, true, JSON.stringify(ok));
  assert.strictEqual(ok.shop, '瑾漂亮潮流服饰');
  assert.match(ok.reason, /排除全局误判/);

  // 他店处理在途 → 串行窗口不成立 → 不结案
  monitor._shopProcessing.add('瑾漂亮潮流服饰');
  const busy = await monitor._authControlCheck(self, { shopSafeName: SHOP });
  assert.strictEqual(busy.ok, false, JSON.stringify(busy));
  assert.strictEqual(busy.shop, null);
  assert.match(busy.reason, /窗口不成立/);
  monitor._shopProcessing.delete('瑾漂亮潮流服饰');

  // 对照店 checkLogin 未通过 → 未结案
  const { monitor: m2, cookieDir: dir2 } = buildControlMonitor({ loggedIn: false });
  writeTempCookie(dir2, SHOP);
  writeTempCookie(dir2, '瑾漂亮潮流服饰');
  const denied = await m2._authControlCheck(m2.config.shops[0], { shopSafeName: SHOP });
  assert.strictEqual(denied.ok, false, JSON.stringify(denied));
  assert.match(denied.reason, /未完成误判排除/);

  // 对照店 cookie 过期 → 不可用 → 未结案
  const { monitor: m3, cookieDir: dir3 } = buildControlMonitor();
  writeTempCookie(dir3, SHOP);
  writeTempCookie(dir3, '瑾漂亮潮流服饰', { expired: true });
  const expired = await m3._authControlCheck(m3.config.shops[0], { shopSafeName: SHOP });
  assert.strictEqual(expired.ok, false, JSON.stringify(expired));

  // 无其他已配置店铺 → 未结案
  const { monitor: m4, cookieDir: dir4 } = buildControlMonitor({
    shops: [{ id: SHOP, name: SHOP, cookieFile: SHOP, enabled: true }],
  });
  writeTempCookie(dir4, SHOP);
  const alone = await m4._authControlCheck(m4.config.shops[0], { shopSafeName: SHOP });
  assert.strictEqual(alone.ok, false, JSON.stringify(alone));
  assert.match(alone.reason, /无其他已配置店铺/);

  monitor.stop(); m2.stop(); m3.stop(); m4.stop();
});

test('G4 onAuthClosedOut 显式接线：结案证据落盘 + 释放串行门；错误路径不重复写盘', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix3-mon-'));
  seedUnknownSlot(dataDir);
  const monitor = buildMonitor(dataDir);
  const orch = monitor._switchOrchestrator;
  assert.strictEqual(orch.hasUnknownBlock('shop-a'), true);

  const wiring = monitor._authRecoveryWiring({ id: 'shop-a', name: '简尚' });
  assert.strictEqual(typeof wiring.restoreControlCheck, 'function');
  assert.strictEqual(typeof wiring.onAuthClosedOut, 'function');

  const evidence = {
    kind: 'fix3-auth-closure', policy: 'fix3-four', authClosedOut: true,
    conclusion: 'auth 结案：固定四份候选均不可用（不要求重新登录旁路）',
  };
  await wiring.onAuthClosedOut(evidence);
  assert.strictEqual(orch.hasUnknownBlock('shop-a'), false, '结案回调必须释放该店串行门');
  const evDir = path.join(dataDir, 'auth-evidence');
  const filesOf = () => fs.readdirSync(evDir).filter((f) => f.endsWith('.json'));
  assert.strictEqual(filesOf().length, 1, '结案证据必须落盘一次');

  // 同一份证据随后经错误路径到达：不重复写盘，门保持释放。
  monitor._applyReadFailure('shop-a', {
    kind: 'auth', blocked: 'auth', reason: '登录失效：持续登录页；auth 结案（不要求重新登录旁路）',
    authClosure: { authClosedOut: true, evidence },
  });
  assert.strictEqual(filesOf().length, 1, '错误路径不得重复写结案证据');
  assert.strictEqual(orch.hasUnknownBlock('shop-a'), false);

  // 无店铺 id 时不接线（不伪造对照店/结案能力）。
  assert.deepStrictEqual(monitor._authRecoveryWiring(null), {});
  monitor.stop();
});

test('G5 _makeReader 给千川 cost/ad 与罗盘 order 注入 restoreControlCheck + onAuthClosedOut', () => {
  const qc = require('../src/adapters/qianchuan-reader');
  const cp = require('../src/adapters/compass-order-reader');
  const captured = { cost: null, ad: null, order: null };
  const oCost = qc.createQianchuanCostReader;
  const oAd = qc.createQianchuanAdListReader;
  const oOrder = cp.createCompassOrderReader;
  const stub = { connected: true, readCostSummary: async () => ({}), readOrderSummary: async () => ({}), listAdPage: async () => ({}) };
  qc.createQianchuanCostReader = (o) => { captured.cost = o; return stub; };
  qc.createQianchuanAdListReader = (o) => { captured.ad = o; return stub; };
  cp.createCompassOrderReader = (o) => { captured.order = o; return stub; };
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix3-wire-'));
  const cfgResult = makeCfgResult({
    shops: [
      { id: SHOP, name: SHOP, cookieFile: SHOP, enabled: true, authRecoveryPolicy: 'fix3-four' },
      { id: '他店', name: '他店', cookieFile: '他店', enabled: true },
    ],
    cookieWorkDir: fs.mkdtempSync(path.join(os.tmpdir(), 'fix3-wire-cookies-')),
    monitor: { costDataSource: 'qianchuan', adListDataSource: 'qianchuan', orderDataSource: 'compass' },
  });
  const monitor = new Monitor(cfgResult, null, { dataDir, nowFn: () => NOW });
  try {
    monitor._makeReader(cfgResult.config.shops[0]);
    for (const k of ['cost', 'ad', 'order']) {
      assert.ok(captured[k], `${k} 创建选项必须被捕获`);
      assert.strictEqual(typeof captured[k].restoreControlCheck, 'function', `${k} 必须注入 restoreControlCheck`);
      assert.strictEqual(typeof captured[k].onAuthClosedOut, 'function', `${k} 必须注入 onAuthClosedOut`);
    }
    assert.strictEqual(captured.cost.restoreControlCheck, captured.order.restoreControlCheck, '同一店铺共享同一对照店接线');
  } finally {
    qc.createQianchuanCostReader = oCost;
    qc.createQianchuanAdListReader = oAd;
    cp.createCompassOrderReader = oOrder;
    monitor.stop();
  }
});

test('G6 乘方读取路径接线：_readChengfangAdState 把 restoreControlCheck + onAuthClosedOut 传入 opener（与 poll 同款）', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix3-cfwire-'));
  seedUnknownSlot(dataDir);
  const monitor = buildMonitor(dataDir);
  let captured = null;
  monitor._chengfangOpener = async (o) => { captured = o; throw new Error('会话开启失败（测试桩）'); };
  try {
    const r = await monitor._readChengfangAdState({ id: 'shop-a', name: '简尚', cookieFile: '简尚' });
    assert.strictEqual(r.state, 'unknown');
    assert.ok(captured, '乘方读取路径 opener 选项必须被捕获');
    assert.strictEqual(typeof captured.restoreControlCheck, 'function', '乘方读取路径必须注入 restoreControlCheck');
    assert.strictEqual(typeof captured.onAuthClosedOut, 'function', '乘方读取路径必须注入 onAuthClosedOut');

    // 接线必须是活的（与 poll 同款语义）：结案回调落盘证据 + 释放该店串行门。
    const evidence = {
      kind: 'fix3-auth-closure', policy: 'fix3-four', authClosedOut: true,
      conclusion: 'auth 结案：固定四份候选均不可用（不要求重新登录旁路）',
    };
    await captured.onAuthClosedOut(evidence);
    assert.strictEqual(monitor._switchOrchestrator.hasUnknownBlock('shop-a'), false, '读取路径的结案回调必须能释放串行门');
    const evDir = path.join(dataDir, 'auth-evidence');
    assert.strictEqual(fs.readdirSync(evDir).filter((f) => f.endsWith('.json')).length, 1, '读取路径结案证据必须落盘');
  } finally {
    monitor.stop();
  }
});

test('G7 defaultChengfangOpener 透传 fix3 选项到 openChengfangShop（不丢接线）', async () => {
  const cf = require('../src/adapters/chengfang-reader');
  const oOpen = cf.openChengfangShop;
  const oCtrl = cf.createChengfangController;
  const oWatch = cf.watchChengfangControlsForManualReview;
  const captured = [];
  const sentinelCheck = () => {};
  const sentinelClosed = () => {};
  cf.openChengfangShop = async (p) => { captured.push(p); return { browser: null, target: {}, account: {}, context: {}, cookieSession: null }; };
  cf.createChengfangController = () => ({});
  cf.watchChengfangControlsForManualReview = (c) => c;
  const { defaultChengfangOpener } = require('../src/engine/chengfang-runner');
  try {
    await defaultChengfangOpener({
      loginCfg: {}, shopCfg: { id: 'shop-a' },
      restoreControlCheck: sentinelCheck, onAuthClosedOut: sentinelClosed,
    });
    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].restoreControlCheck, sentinelCheck, 'restoreControlCheck 必须透传到 openChengfangShop');
    assert.strictEqual(captured[0].onAuthClosedOut, sentinelClosed, 'onAuthClosedOut 必须透传到 openChengfangShop');
    // 批次等未注入场景：透传 undefined，不伪造对照店/结案能力。
    await defaultChengfangOpener({ loginCfg: {}, shopCfg: { id: 'shop-a' } });
    assert.strictEqual(captured[1].restoreControlCheck, undefined);
    assert.strictEqual(captured[1].onAuthClosedOut, undefined);
  } finally {
    cf.openChengfangShop = oOpen;
    cf.createChengfangController = oCtrl;
    cf.watchChengfangControlsForManualReview = oWatch;
  }
});

test('G8 fix3 未结案文案拆分：「未提供」（未注入）vs「未通过」（跑但失败）两态分明', () => {
  const notProvided = buildAuthFailureSuffix({
    policy: 'fix3-four', authClosedOut: false, controlCheckSkipped: true,
    restoreReason: '固定四份候选均不可用（验证调用 0 次）：对照店 checkLogin 未提供，未完成误判排除，不结案（保持原读取失败语义，不要求重新登录旁路）',
  });
  assert.ok(notProvided.tail.includes('对照店检查未提供'), `必须写「未提供」：${notProvided.tail}`);
  assert.ok(!notProvided.tail.includes('未通过'), `未注入时不得出现「未通过」：${notProvided.tail}`);

  const denied = buildAuthFailureSuffix({
    policy: 'fix3-four', authClosedOut: false, controlCheckSkipped: false,
    restoreReason: '固定四份候选均不可用（验证调用 2 次）：对照店 checkLogin 未通过，未完成误判排除，不结案（保持原读取失败语义，不要求重新登录旁路）',
  });
  assert.ok(denied.tail.includes('对照店检查未通过'), `跑过但失败必须写「未通过」：${denied.tail}`);
  assert.ok(!denied.tail.includes('未提供'), `跑过但失败时不得出现「未提供」：${denied.tail}`);

  // 结案与默认五层口径保持不变
  assert.ok(buildAuthFailureSuffix({ policy: 'fix3-four', authClosedOut: true }).tail.includes('auth 结案'));
  assert.ok(buildAuthFailureSuffix({ authClosedOut: false }).tail.includes('对照店检查未通过'));
  for (const s of [notProvided, denied]) {
    assert.ok(!/扫码/.test(s.tail + s.restoreNote), `未结案文案不得含扫码字样：${s.tail}${s.restoreNote}`);
  }
});
