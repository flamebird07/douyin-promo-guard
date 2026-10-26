'use strict';

/**
 * AD-COOKIE-FOUR-TIER-20261019-F1 专项测试 3/3：推广值守侧四层恢复 + 真实入口调用链。
 * node:test + 真实 fs（限定 os.tmpdir()），浏览器一律桩对象（无真实网页/CDP/网络）。
 * 覆盖：session.js 导出回归、restoreDutyWorkCopy 候选链/冻结基线/并发胜出/有界循环、
 * 默认验证器 fail-closed（拒绝自启真实浏览器）、错店拒绝、qianchuan/compass
 * 真实入口（openQianchuanHome / readOrderSummary）登录失效 → 恢复 → 有界重试调用链。
 * 运行：node --test douyin-promo-guard/test/cookie-four-tier.test.js（由主脑执行）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const session = require('../src/login/session');
const { AuthError, DataGuardError } = require('../src/lib/errors');
const { ensureWorkCopy } = require('../src/login/cookie-workcopy');
const {
  decideDoudianIdentity, checkpointQianchuanSessionCookies, checkpointCompassSessionCookies,
  createCheckpointCandidateVerifier,
} = require('../src/login/session-cookie-checkpoint');
const { fingerprintFile } = require('../src/login/cookie-writeback');
const { openQianchuanHome } = require('../src/adapters/qianchuan-reader');
const { createCompassOrderReader } = require('../src/adapters/compass-order-reader');

const FXG_HOME = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const LOGIN_URL = 'https://fxg.jinritemai.com/ffa/login/expired';

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function bytesOf(cookies) { return Buffer.from(JSON.stringify(cookies, null, 2), 'utf8'); }
function makeCookies(tag) {
  return [
    { name: 'sessionid', value: `sid-${tag}-SECRET-VALUE`, domain: '.jinritemai.com', path: '/', expires: 1893456000 },
    { name: 'ttwid', value: `ttw-${tag}`, domain: '.iesdouyin.com', path: '/', expires: 1893456000 },
  ];
}

function mkDirs() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-four-tier-')));
  const d = {
    base,
    workDir: path.join(base, 'guard-cookies'),
    recoveryDir: path.join(base, 'cookie-recovery'),
    archiveRoot: path.join(base, 'archive-raw'),
    analyzerWorkDir: path.join(base, 'app-cookies'),
  };
  for (const p of [d.workDir, d.recoveryDir, d.archiveRoot, d.analyzerWorkDir]) fs.mkdirSync(p, { recursive: true });
  return d;
}

function emptyVaultModule() {
  return {
    defaultRoots: () => ({ archiveRoot: '', recoveryDir: '' }),
    listSnapshotVersions: () => ({ ok: true, versions: [], manifestMissing: false }),
    readSnapshotVersion: () => ({ ok: false, reason: '桩不应被调用' }),
  };
}

/** 登录失效 → 值守工作副本从恢复副本提升（验证桩通过；恢复/归档字节只读不动）。 */
test('session.js 导出回归：restoreDutyWorkCopy/RESTORE_MAX_CANDIDATES 必须可达（旧基线重复 module.exports 缺陷守卫）', () => {
  assert.strictEqual(typeof session.restoreDutyWorkCopy, 'function');
  assert.strictEqual(typeof session.createDefaultCandidateVerifier, 'function');
  // AD-COOKIE-SOURCE-RECOVERY：新增「商品分析只读来源」一层（值守工作 1 + 分析来源 1
  // + 恢复副本 1 + 归档最近 2），上限随之 +1 到 5，不挤掉既有任一层。
  assert.strictEqual(session.RESTORE_MAX_CANDIDATES, 5);
});

test('值守恢复：恢复副本经验证提升为值守工作副本；恢复副本与归档字节不被改写；审计脱敏', async () => {
  const d = mkDirs();
  const fresh = makeCookies('fresh');
  fs.writeFileSync(path.join(d.workDir, '店A.json'), bytesOf(makeCookies('stale')));
  fs.writeFileSync(path.join(d.recoveryDir, '店A.json'), bytesOf(fresh));
  const audits = [];
  let seenShopNames = null;
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, '店A.json',
    {
      shopCfg: { name: '测试店A', compassShopName: '测试店A' },
      recoveryDir: d.recoveryDir,
      vaultModule: emptyVaultModule(),
      verify: async (p) => {
        seenShopNames = p.expectedShopNames;
        // 值守工作副本当前字节视为失效（登录刚在它上面失败）；只有恢复副本经验证可提升。
        // 成功必须显式返回本次候选的最终已验证集合（生产 F1 合同：无 finalCookies 不得提升）。
        return p.source === 'guard-recovery'
          ? { ok: true, finalCookies: p.cookies }
          : { ok: false, reason: '桩：当前字节登录失效' };
      },
      nowFn: () => 10000,
      audit: (e) => audits.push(e),
    },
  );
  assert.strictEqual(res.ok, true, JSON.stringify(res.attempts));
  assert.strictEqual(res.source, 'guard-recovery');
  assert.ok(fs.readFileSync(path.join(d.workDir, '店A.json')).equals(bytesOf(fresh)));
  assert.ok(fs.readFileSync(path.join(d.recoveryDir, '店A.json')).equals(bytesOf(fresh)), '恢复副本不得被提升过程改写');
  assert.deepEqual(seenShopNames, ['测试店A']);
  const auditText = JSON.stringify(audits);
  assert.ok(!auditText.includes('SECRET-VALUE'), '审计绝不记录 Cookie 值');
  assert.ok(audits.some((a) => a.kind === 'cookie-restore' && a.verification === 'verified-in-new-context-final'),
    '成功提升必须记录最终集合标签（verified-in-new-context-final）');
});

test('ok 但无最终集合 → fail-closed：final-missing、零提升、工作副本字节原样不变', async () => {
  const d = mkDirs();
  const stale = bytesOf(makeCookies('stale-x'));
  fs.writeFileSync(path.join(d.workDir, '店X.json'), stale);
  fs.writeFileSync(path.join(d.recoveryDir, '店X.json'), bytesOf(makeCookies('recovery-x')));
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, '店X.json',
    {
      shopCfg: { name: '店X', compassShopName: '店X' },
      recoveryDir: d.recoveryDir,
      vaultModule: emptyVaultModule(),
      // 旧验证器兼容桩：只回 {ok:true} 未返回最终集合——必须被拒绝（绝不回退提升原始候选）
      verify: async () => ({ ok: true }),
      nowFn: () => 10000,
    },
  );
  assert.strictEqual(res.ok, false, '无 finalCookies 的成功绝不允许提升');
  assert.ok(res.attempts.some((a) => a.result === 'final-missing'), JSON.stringify(res.attempts));
  assert.ok(fs.readFileSync(path.join(d.workDir, '店X.json')).equals(stale), 'fail-closed 时工作副本字节原样不变');
  assert.ok(!fs.readdirSync(d.workDir).some((f) => f.includes('.prev-')), '拒绝提升不得留下备份/新写入');

  // 空数组 finalCookies 同样视为缺失（不得让空集合冒充成功）
  const res2 = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, '店X.json',
    {
      shopCfg: { name: '店X', compassShopName: '店X' },
      recoveryDir: d.recoveryDir,
      vaultModule: emptyVaultModule(),
      verify: async () => ({ ok: true, finalCookies: [] }),
      nowFn: () => 10000,
    },
  );
  assert.strictEqual(res2.ok, false);
  assert.ok(res2.attempts.some((a) => a.result === 'final-missing'), JSON.stringify(res2.attempts));
  assert.ok(fs.readFileSync(path.join(d.workDir, '店X.json')).equals(stale));
});

test('错店拒绝：验证器按期望店名严格匹配失败 → 不提升、不覆盖（决策函数与入口双层）', async () => {
  const d = mkDirs();
  fs.writeFileSync(path.join(d.workDir, '店B.json'), bytesOf(makeCookies('stale')));
  fs.writeFileSync(path.join(d.recoveryDir, '店B.json'), bytesOf(makeCookies('other-shop')));
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, '店B.json',
    {
      shopCfg: { name: '本店名', compassShopName: '本店名' },
      recoveryDir: d.recoveryDir,
      vaultModule: emptyVaultModule(),
      verify: async (p) => {
        const rd = decideDoudianIdentity({
          url: FXG_HOME, expectedNames: p.expectedShopNames,
          observed: { unique: true, name: '另一家店', loginVisible: false },
        });
        return rd.ok ? { ok: true, finalCookies: p.cookies } : { ok: false, reason: rd.reason };
      },
      nowFn: () => 10000,
    },
  );
  assert.strictEqual(res.ok, false);
  assert.ok(res.attempts.some((a) => a.result === 'verify-failed' && /不严格匹配/.test(a.reason || '')),
    JSON.stringify(res.attempts));
  assert.ok(fs.readFileSync(path.join(d.workDir, '店B.json')).equals(bytesOf(makeCookies('stale'))), '错店绝不提升');
});

test('坏/空/缺auth候选拒绝：结构非法不进入验证；未配置店名直接拒绝恢复', async () => {
  const d = mkDirs();
  fs.writeFileSync(path.join(d.workDir, '店C.json'), bytesOf(makeCookies('stale-ok')));
  fs.writeFileSync(path.join(d.recoveryDir, '店C.json'), Buffer.from('[{"name":"a","value":"","domain":"example.com","path":"/"}]', 'utf8'));
  let verifyCalls = 0;
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, '店C.json',
    {
      shopCfg: { name: '店C' },
      recoveryDir: d.recoveryDir,
      vaultModule: emptyVaultModule(),
      verify: async () => { verifyCalls += 1; return { ok: false, reason: '桩：当前字节登录失效' }; },
      nowFn: () => 10000,
    },
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(verifyCalls, 1, '值守工作副本候选验证一次；损坏的恢复副本不得进入验证');
  assert.ok(res.attempts.some((a) => a.source === 'guard-recovery' && a.result === 'invalid-structure'));

  const noName = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, '店C.json',
    { shopCfg: {}, recoveryDir: d.recoveryDir, vaultModule: emptyVaultModule(), verify: async (p) => ({ ok: true, finalCookies: p.cookies }) },
  );
  assert.strictEqual(noName.ok, false);
  assert.match(noName.reason, /未配置店铺名/);
});

test('全部无效不覆盖/不无限循环：验证调用有界（≤候选数），工作副本字节原样', async () => {
  const d = mkDirs();
  fs.writeFileSync(path.join(d.workDir, '店D.json'), bytesOf(makeCookies('w')));
  fs.writeFileSync(path.join(d.recoveryDir, '店D.json'), bytesOf(makeCookies('r')));
  let verifyCalls = 0;
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, '店D.json',
    {
      shopCfg: { name: '店D' },
      recoveryDir: d.recoveryDir,
      vaultModule: emptyVaultModule(),
      verify: async () => { verifyCalls += 1; return { ok: false, reason: '桩：登录失效' }; },
      nowFn: () => 10000,
    },
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(verifyCalls, 2, '单次有界循环：每个候选至多验证一次');
  assert.match(res.reason, /不盲覆盖/);
  assert.ok(fs.readFileSync(path.join(d.workDir, '店D.json')).equals(bytesOf(makeCookies('w'))));
});

test('并发新登录胜出：验证期间值守工作副本被并发写入 → 冻结基线拒绝提升，保留并发字节', async () => {
  const d = mkDirs();
  const stale = bytesOf(makeCookies('stale'));
  const concurrent = bytesOf(makeCookies('new-scan-login'));
  fs.writeFileSync(path.join(d.workDir, '店E.json'), stale);
  fs.writeFileSync(path.join(d.recoveryDir, '店E.json'), bytesOf(makeCookies('recovery-cand')));
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, '店E.json',
    {
      shopCfg: { name: '店E' },
      recoveryDir: d.recoveryDir,
      vaultModule: emptyVaultModule(),
      verify: async (p) => {
        fs.writeFileSync(path.join(d.workDir, '店E.json'), concurrent); // 模拟并发扫码提交
        return { ok: true, finalCookies: p.cookies };
      },
      nowFn: () => 10000,
    },
  );
  assert.strictEqual(res.ok, false);
  assert.ok(res.attempts.some((a) => a.result === 'promote-failed' && a.conflict === true),
    JSON.stringify(res.attempts));
  assert.ok(fs.readFileSync(path.join(d.workDir, '店E.json')).equals(concurrent), '较新登录胜出，不覆盖');
});

test('excludeWorkCopy：登录失效入口排除当前工作字节；无其他候选时零验证调用（离线/hermetic 关键性质）', async () => {
  const d = mkDirs();
  fs.writeFileSync(path.join(d.workDir, '店F.json'), bytesOf(makeCookies('just-failed')));
  let verifyCalls = 0;
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, '店F.json',
    {
      shopCfg: { name: '店F' },
      excludeWorkCopy: true,
      recoveryDir: d.recoveryDir,
      vaultModule: emptyVaultModule(),
      verify: async (p) => { verifyCalls += 1; return { ok: true, finalCookies: p.cookies }; },
      nowFn: () => 10000,
    },
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(verifyCalls, 0);
  assert.ok(res.attempts.some((a) => a.source === 'guard-duty-work' && a.result === 'excluded'));
  assert.ok(res.attempts.some((a) => a.source === 'guard-recovery' && a.result === 'unreadable'));
});

// ── AD-COOKIE-SOURCE-RECOVERY：商品分析只读来源候选层 ─────────────────────

test('分析来源层：登录失效排除 guard work 时，商品分析只读来源候选经验证只提升 guard work；来源/恢复字节不变', async () => {
  const d = mkDirs();
  const fileName = '瑾漂亮潮流服饰.json';
  const staleGuard = bytesOf(makeCookies('guard-just-failed'));
  fs.writeFileSync(path.join(d.workDir, fileName), staleGuard);
  const staleRecovery = bytesOf(makeCookies('stale-recovery'));
  fs.writeFileSync(path.join(d.recoveryDir, fileName), staleRecovery);
  const analyzerBytes = bytesOf(makeCookies('analyzer-fresh'));
  fs.writeFileSync(path.join(d.analyzerWorkDir, fileName), analyzerBytes);

  const verifySources = [];
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir, cookieSourceDir: d.analyzerWorkDir }, fileName,
    {
      shopCfg: { name: '瑾漂亮潮流服饰', compassShopName: '瑾漂亮潮流服饰' },
      excludeWorkCopy: true,
      recoveryDir: d.recoveryDir,
      vaultModule: emptyVaultModule(),
      verify: async (p) => {
        verifySources.push(p.source);
        return p.source === 'analyzer-source'
          ? { ok: true, finalCookies: p.cookies }
          : { ok: false, reason: '桩：stale 候选登录无效' };
      },
      nowFn: () => 10000,
    },
  );
  assert.strictEqual(res.ok, true, JSON.stringify(res.attempts));
  assert.strictEqual(res.source, 'analyzer-source');
  // 分析来源是首个被验证的候选；验证通过即提升并提前返回（stale 恢复副本不再重复验证）
  assert.deepStrictEqual(verifySources, ['analyzer-source']);
  // 只提升 guard work（提升字节＝验证 context 最终集合＝候选字节）
  assert.ok(fs.readFileSync(path.join(d.workDir, fileName)).equals(analyzerBytes), 'guard work 提升为分析来源验证后字节');
  // 商品分析来源只读：字节保持不变（绝不向上游写入）
  assert.ok(fs.readFileSync(path.join(d.analyzerWorkDir, fileName)).equals(analyzerBytes), '分析来源只读，字节不得被改写');
  // 恢复副本同样只读不变
  assert.ok(fs.readFileSync(path.join(d.recoveryDir, fileName)).equals(staleRecovery), '恢复副本只读');
});

test('分析来源层排序：分析来源验证失败时仍先于 stale 恢复副本被验证（较新来源优先，不据 mtime 放行）', async () => {
  const d = mkDirs();
  const fileName = '排序店.json';
  fs.writeFileSync(path.join(d.workDir, fileName), bytesOf(makeCookies('guard-failed')));
  fs.writeFileSync(path.join(d.recoveryDir, fileName), bytesOf(makeCookies('recovery-fresh')));
  fs.writeFileSync(path.join(d.analyzerWorkDir, fileName), bytesOf(makeCookies('analyzer-stale')));

  const verifySources = [];
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir, cookieSourceDir: d.analyzerWorkDir }, fileName,
    {
      shopCfg: { name: '排序店', compassShopName: '排序店' },
      excludeWorkCopy: true,
      recoveryDir: d.recoveryDir,
      vaultModule: emptyVaultModule(),
      verify: async (p) => {
        verifySources.push(p.source);
        return p.source === 'guard-recovery'
          ? { ok: true, finalCookies: p.cookies }
          : { ok: false, reason: '桩：分析来源登录无效' };
      },
      nowFn: () => 10000,
    },
  );
  assert.strictEqual(res.ok, true, JSON.stringify(res.attempts));
  assert.strictEqual(res.source, 'guard-recovery');
  // 分析来源排在 stale 恢复副本之前验证
  assert.deepStrictEqual(verifySources, ['analyzer-source', 'guard-recovery']);
});

test('分析来源层去重：分析来源与恢复副本 sha 相同时，恢复副本被去重不重复验证', async () => {
  const d = mkDirs();
  const fileName = '去重店.json';
  fs.writeFileSync(path.join(d.workDir, fileName), bytesOf(makeCookies('guard-failed')));
  const same = bytesOf(makeCookies('identical-bytes'));
  fs.writeFileSync(path.join(d.recoveryDir, fileName), same);
  fs.writeFileSync(path.join(d.analyzerWorkDir, fileName), same);

  const verifySources = [];
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir, cookieSourceDir: d.analyzerWorkDir }, fileName,
    {
      shopCfg: { name: '去重店', compassShopName: '去重店' },
      excludeWorkCopy: true,
      recoveryDir: d.recoveryDir,
      vaultModule: emptyVaultModule(),
      verify: async (p) => { verifySources.push(p.source); return { ok: false, reason: '桩：登录无效' }; },
      nowFn: () => 10000,
    },
  );
  assert.strictEqual(res.ok, false);
  // 相同 sha 只验证一次（分析来源在前），恢复副本被去重
  assert.deepStrictEqual(verifySources, ['analyzer-source']);
  assert.ok(res.attempts.some((a) => a.source === 'guard-recovery' && a.result === 'dedup'), JSON.stringify(res.attempts));
});

test('分析来源层 fail-closed：非普通文件（目录/符号链接）拒绝，不进验证、不提升', async () => {
  // 子场景 1：分析来源候选路径是目录（非普通文件）
  const d1 = mkDirs();
  const f1 = '目录来源店.json';
  fs.writeFileSync(path.join(d1.workDir, f1), bytesOf(makeCookies('guard-failed')));
  fs.writeFileSync(path.join(d1.recoveryDir, f1), bytesOf(makeCookies('recovery-valid')));
  fs.mkdirSync(path.join(d1.analyzerWorkDir, f1), { recursive: true }); // 目录占据候选路径
  const src1 = [];
  const r1 = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d1.workDir, cookieSourceDir: d1.analyzerWorkDir }, f1,
    {
      shopCfg: { name: '目录来源店' }, excludeWorkCopy: true, recoveryDir: d1.recoveryDir,
      vaultModule: emptyVaultModule(),
      verify: async (p) => { src1.push(p.source); return { ok: false, reason: '桩：登录无效' }; },
      nowFn: () => 10000,
    },
  );
  assert.strictEqual(r1.ok, false);
  assert.ok(!src1.includes('analyzer-source'), '非普通文件候选绝不进验证');
  assert.ok(r1.attempts.some((a) => a.source === 'analyzer-source' && a.result === 'unreadable' && /不是普通文件/.test(a.reason || '')), JSON.stringify(r1.attempts));

  // 子场景 2：分析来源候选是符号链接（环境不支持创建文件链接则跳过该子项）
  const d2 = mkDirs();
  const f2 = '链接来源店.json';
  fs.writeFileSync(path.join(d2.workDir, f2), bytesOf(makeCookies('guard-failed')));
  const outside = path.join(d2.base, 'outside-target.json');
  const outsideBytes = bytesOf(makeCookies('outside'));
  fs.writeFileSync(outside, outsideBytes);
  const linkPath = path.join(d2.analyzerWorkDir, f2);
  try {
    fs.symlinkSync(outside, linkPath, 'file');
  } catch (_) {
    return; // Windows 非开发者模式可能禁止文件符号链接：跳过该子项
  }
  const src2 = [];
  const r2 = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d2.workDir, cookieSourceDir: d2.analyzerWorkDir }, f2,
    {
      shopCfg: { name: '链接来源店' }, excludeWorkCopy: true, recoveryDir: d2.recoveryDir,
      vaultModule: emptyVaultModule(),
      verify: async (p) => { src2.push(p.source); return { ok: false, reason: '桩：登录无效' }; },
      nowFn: () => 10000,
    },
  );
  assert.strictEqual(r2.ok, false);
  assert.ok(!src2.includes('analyzer-source'), '符号链接候选绝不进验证');
  assert.ok(r2.attempts.some((a) => a.source === 'analyzer-source' && a.result === 'unreadable' && /不是普通文件/.test(a.reason || '')), JSON.stringify(r2.attempts));
  assert.ok(fs.readFileSync(outside).equals(outsideBytes), '链接目标不被写入');
});

test('分析来源层 fail-closed：来源目录与 guard 工作根 realpath 重合（路径别名）→ 跳过，不当独立候选', async () => {
  const d = mkDirs();
  const fileName = '别名店.json';
  fs.writeFileSync(path.join(d.workDir, fileName), bytesOf(makeCookies('guard-failed')));
  fs.writeFileSync(path.join(d.recoveryDir, fileName), bytesOf(makeCookies('recovery-fresh')));

  const verifySources = [];
  // cookieSourceDir 字面指向 guard 工作根本身 → realpath 重合 → alias-skipped
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir, cookieSourceDir: d.workDir }, fileName,
    {
      shopCfg: { name: '别名店', compassShopName: '别名店' },
      excludeWorkCopy: true,
      recoveryDir: d.recoveryDir,
      vaultModule: emptyVaultModule(),
      verify: async (p) => {
        verifySources.push(p.source);
        return p.source === 'guard-recovery' ? { ok: true, finalCookies: p.cookies } : { ok: false, reason: '桩：登录无效' };
      },
      nowFn: () => 10000,
    },
  );
  assert.ok(res.attempts.some((a) => a.source === 'analyzer-source' && a.result === 'alias-skipped'), JSON.stringify(res.attempts));
  assert.ok(!verifySources.includes('analyzer-source'), '别名来源绝不进验证');
  // 别名层被跳过不影响其余层：恢复副本仍正常提升
  assert.strictEqual(res.ok, true, JSON.stringify(res.attempts));
  assert.strictEqual(res.source, 'guard-recovery');
});

test('分析来源层 fail-closed：错误店名（身份不严格匹配）→ 验证失败、不提升、guard work 原样', async () => {
  const d = mkDirs();
  const fileName = '错店来源店.json';
  const staleGuard = bytesOf(makeCookies('guard-failed'));
  fs.writeFileSync(path.join(d.workDir, fileName), staleGuard);
  fs.writeFileSync(path.join(d.analyzerWorkDir, fileName), bytesOf(makeCookies('analyzer-wrong-shop')));

  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir, cookieSourceDir: d.analyzerWorkDir }, fileName,
    {
      shopCfg: { name: '本店名', compassShopName: '本店名' },
      excludeWorkCopy: true,
      recoveryDir: d.recoveryDir,
      vaultModule: emptyVaultModule(),
      verify: async (p) => {
        const rd = decideDoudianIdentity({
          url: FXG_HOME, expectedNames: p.expectedShopNames,
          observed: { unique: true, name: '另一家店', loginVisible: false },
        });
        return rd.ok ? { ok: true, finalCookies: p.cookies } : { ok: false, reason: rd.reason };
      },
      nowFn: () => 10000,
    },
  );
  assert.strictEqual(res.ok, false);
  assert.ok(res.attempts.some((a) => a.source === 'analyzer-source' && a.result === 'verify-failed'), JSON.stringify(res.attempts));
  assert.ok(fs.readFileSync(path.join(d.workDir, fileName)).equals(staleGuard), '错店来源绝不提升，guard work 原样');
});

test('归档层：manifest sha 核验不一致 → integrity-failed，不进验证；缺 sha（未入册）同样拒绝', async () => {
  const d = mkDirs();
  fs.writeFileSync(path.join(d.workDir, '店G.json'), bytesOf(makeCookies('stale')));
  const shopDir = path.join(d.archiveRoot, '店G');
  fs.mkdirSync(shopDir, { recursive: true });
  const goodBytes = bytesOf(makeCookies('archived'));
  const versionPath = path.join(shopDir, 'v20261019T000000Z-1-abc.json');
  fs.writeFileSync(versionPath, goodBytes);
  const vaultStub = {
    defaultRoots: () => ({ archiveRoot: d.archiveRoot, recoveryDir: d.recoveryDir }),
    listSnapshotVersions: () => ({
      ok: true, manifestMissing: false,
      versions: [
        { versionId: 'v20261019T000000Z-1-abc', versionPath, sha256: sha(goodBytes) },
        { versionId: 'v-unlisted', versionPath, sha256: null },
      ],
    }),
    readSnapshotVersion: (p) => {
      const buf = fs.readFileSync(p.versionPath);
      if (typeof p.expectedSha256 !== 'string' || !p.expectedSha256.trim()) {
        return { ok: false, reason: '缺少 manifest 记录的 sha256（manifest 缺失/未入册版本）：拒绝无核验读取' };
      }
      if (sha(buf) !== p.expectedSha256) return { ok: false, reason: 'sha256 与 manifest 记录不一致' };
      return { ok: true, buf, sha256: sha(buf) };
    },
  };
  // 篡改归档字节，使 manifest 记录（第一条）与实测不一致 → 两条读取都失败
  fs.writeFileSync(versionPath, bytesOf(makeCookies('tampered')));
  let verifyCalls = 0;
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, '店G.json',
    {
      shopCfg: { name: '店G' },
      excludeWorkCopy: true,
      recoveryDir: d.recoveryDir,
      vaultModule: vaultStub,
      verify: async (p) => { verifyCalls += 1; return { ok: true, finalCookies: p.cookies }; },
      nowFn: () => 10000,
    },
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(verifyCalls, 0, '源完整性失败的候选绝不进验证/提升');
  const integrity = res.attempts.filter((a) => a.result === 'integrity-failed');
  assert.ok(integrity.length >= 2, JSON.stringify(res.attempts));
});

test('默认候选验证器 fail-closed：未提供浏览器实例绝不自启真实浏览器（离线零副作用）', async () => {
  const verifier = session.createDefaultCandidateVerifier({}, {});
  const r = await verifier({ cookies: makeCookies('x'), expectedShopNames: ['店H'], source: 'guard-recovery' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /fail-closed/);
});

test('值守工作副本写回隔离：普通解析永不覆盖健康工作副本；authorizedFreshLogin 必须绑定本次 sha（写回不污染来源）', () => {
  const d = mkDirs();
  const sourceDir = path.join(d.base, 'analyzer-source');
  fs.mkdirSync(sourceDir, { recursive: true });
  const fileName = '店I.json';
  const srcBytes = bytesOf(makeCookies('src-newer'));
  fs.writeFileSync(path.join(sourceDir, fileName), srcBytes);
  const workBytes = bytesOf(makeCookies('work-refreshed'));
  fs.writeFileSync(path.join(d.workDir, fileName), workBytes);

  const r1 = ensureWorkCopy({ sourceDir, fileName, workDir: d.workDir });
  assert.strictEqual(r1.sourceSync.status, 'meta-missing-retained', '无 provenance sidecar 且字节不同：保留本地副本，不被来源覆盖');
  assert.ok(fs.readFileSync(path.join(d.workDir, fileName)).equals(workBytes), '普通解析不得覆盖值守工作副本（写回不向上/横向污染）');
  assert.ok(fs.readFileSync(path.join(sourceDir, fileName)).equals(srcBytes), '来源同样不被改写');

  const mismatch = ensureWorkCopy({
    sourceDir, fileName, workDir: d.workDir,
    authorizedFreshLogin: true, expectedSourceSha256: '0'.repeat(64),
  });
  assert.strictEqual(mismatch.sourceSync.status, 'source-snapshot-mismatch',
    'authorizedFreshLogin 但来源 sha 与本次登录冻结不符 → 保留工作副本零写入（fail-closed，不谎报成功）');
  assert.ok(fs.readFileSync(path.join(d.workDir, fileName)).equals(workBytes), '不符授权不得改工作副本');

  const okAuth = ensureWorkCopy({
    sourceDir, fileName, workDir: d.workDir,
    authorizedFreshLogin: true, expectedSourceSha256: sha(srcBytes),
  });
  assert.ok(['recommitted-fresh-login', 'imported', 'replaced-legacy', 'unchanged'].includes(okAuth.sourceSync.status),
    JSON.stringify(okAuth.sourceSync));
  assert.ok(fs.readFileSync(path.join(d.workDir, fileName)).equals(srcBytes));
  assert.ok(fs.readFileSync(path.join(sourceDir, fileName)).equals(srcBytes), '授权复制只读来源，绝不反写');
});

// ── 写回前独立候选验证（AD-COOKIE-FOUR-TIER 补修）────────────────────────

test('检查点候选验证器：正确店通过；错店/登录页拒绝；无浏览器 fail-closed（不自启真实浏览器）', async () => {
  const cookies = makeCookies('cand');
  const buf = bytesOf(cookies);
  const sha256 = sha(buf);
  function mkBrowser(shopName, url = FXG_HOME) {
    const vctx = {
      addCookies: async () => {},
      newPage: async () => ({
        goto: async () => {},
        url: () => url,
        // 与 probeDoudianShopIdentityInPage 的真实返回合同一致（对象，不是候选数组）。
        evaluate: async (fn) => (/index_userName/.test(String(fn))
          ? { name: shopName, distinct: [shopName], candidates: 1, unique: true, loginVisible: false }
          : null),
      }),
      cookies: async () => cookies,
      close: async () => {},
    };
    return { newContext: async () => vctx };
  }
  const good = createCheckpointCandidateVerifier({
    expectedNames: ['本店'], browser: mkBrowser('本店'), sleep: async () => {},
  });
  const r1 = await good({ cookies, buf, sha256, serialized: buf.toString('utf8') });
  assert.strictEqual(r1.ok, true, r1.reason);

  const wrong = createCheckpointCandidateVerifier({
    expectedNames: ['本店'], browser: mkBrowser('另一家店'), sleep: async () => {}, maxWaitMs: 4000,
  });
  const r2 = await wrong({ cookies, buf, sha256, serialized: buf.toString('utf8') });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.reason, /登录无效|错店/);

  const loginPg = createCheckpointCandidateVerifier({
    expectedNames: ['本店'], browser: mkBrowser('本店', 'https://fxg.jinritemai.com/login/common'),
    sleep: async () => {}, maxWaitMs: 4000,
  });
  const r3 = await loginPg({ cookies, buf, sha256, serialized: buf.toString('utf8') });
  assert.strictEqual(r3.ok, false);

  const noBrowser = createCheckpointCandidateVerifier({ expectedNames: ['本店'], sleep: async () => {} });
  const r4 = await noBrowser({ cookies, buf, sha256, serialized: buf.toString('utf8') });
  assert.strictEqual(r4.ok, false);
  assert.match(r4.reason, /fail-closed/);

  const tampered = await good({ cookies, buf, sha256: '0'.repeat(64), serialized: buf.toString('utf8') });
  assert.strictEqual(tampered.ok, false);
  assert.match(tampered.reason, /冻结字节/);
});

test('千川检查点生产接通独立验证：坏候选/错店零写入并保留旧副本；通过后写前备份 + 精确落盘', async () => {
  const d = mkDirs();
  const fileName = '验证店.json';
  const filePath = path.join(d.workDir, fileName);
  const oldBytes = bytesOf(makeCookies('old-valid'));
  fs.writeFileSync(filePath, oldBytes);
  const captured = makeCookies('candidate-new');
  const qcUrl = 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424';
  function mkStub(shopName) {
    const verifyPage = {
      goto: async () => {},
      url: () => FXG_HOME,
      // 与 probeDoudianShopIdentityInPage 的真实返回合同一致（对象，不是候选数组）。
      evaluate: async (fn) => (/index_userName/.test(String(fn))
        ? { name: shopName, distinct: [shopName], candidates: 1, unique: true, loginVisible: false }
        : null),
    };
    const verifyCtx = {
      addCookies: async () => {}, newPage: async () => verifyPage,
      cookies: async () => captured, close: async () => {},
    };
    const browser = { newContext: async () => verifyCtx };
    const qcPage = {
      url: () => qcUrl,
      evaluate: async (fn) => (/shop-name/.test(String(fn))
        ? { accountId: '1710242295996424', accountName: '店', candidates: 1, unique: true, loginVisible: false }
        : null),
      isClosed: () => false,
    };
    const ctx = {
      cookies: async () => captured,
      browser: () => browser,
      addCookies: async () => {},
      newPage: async () => qcPage,
    };
    qcPage.context = () => ctx;
    return { ctx, qcPage };
  }

  // 错店：独立新上下文身份不符 → 零写入
  const wrong = mkStub('另一家店');
  const bad = await checkpointQianchuanSessionCookies({
    context: wrong.ctx,
    cookieSession: { filePath, startFingerprint: fingerprintFile(filePath) },
    target: wrong.qcPage,
    shopCfg: { id: 's1', accountId: '1710242295996424', name: '验证店', compassShopName: '验证店' },
    // 仅注入测试等待参数（不缩短生产默认 20s 上限语义，也不跳过验证）。
    candidateVerifyOptions: { sleep: async () => {}, maxWaitMs: 4000 },
  });
  assert.strictEqual(bad.saved, false, JSON.stringify(bad));
  assert.match(bad.reason, /独立复用\/身份验证|候选/);
  assert.ok(fs.readFileSync(filePath).equals(oldBytes), '坏候选不得污染上一级工作副本');
  assert.ok(!fs.readdirSync(d.workDir).some((f) => f.includes('.prev-')), '验证失败不得留下备份/新写入');

  // 正确店：验证通过 → 写前备份 + 精确落盘
  const good = mkStub('验证店');
  const ok = await checkpointQianchuanSessionCookies({
    context: good.ctx,
    cookieSession: { filePath, startFingerprint: fingerprintFile(filePath) },
    target: good.qcPage,
    shopCfg: { id: 's1', accountId: '1710242295996424', name: '验证店', compassShopName: '验证店' },
    candidateVerifyOptions: { sleep: async () => {}, maxWaitMs: 4000 },
  });
  assert.strictEqual(ok.saved, true, JSON.stringify(ok));
  assert.ok(fs.readFileSync(filePath).equals(bytesOf(captured)), '验证通过后落盘为候选冻结字节');
  const prev = fs.readdirSync(d.workDir).filter((f) => f.includes('.prev-'));
  assert.strictEqual(prev.length, 1, '写前必须保留上一版');
  assert.ok(fs.readFileSync(path.join(d.workDir, prev[0])).equals(oldBytes));
});

test('关键认证 Cookie 缺失：写回前校验拒绝覆盖，旧工作副本保持不变', async () => {
  const d = mkDirs();
  const filePath = path.join(d.workDir, '缺auth店.json');
  const oldBytes = bytesOf(makeCookies('old-with-auth'));
  fs.writeFileSync(filePath, oldBytes);
  const captured = [{ name: 'ttwid', value: 'only-non-auth', domain: '.iesdouyin.com', path: '/', expires: 1893456000 }];
  const qcUrl = 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424';
  const qcPage = {
    url: () => qcUrl,
    evaluate: async (fn) => (/shop-name/.test(String(fn))
      ? { accountId: '1710242295996424', accountName: '店', candidates: 1, unique: true, loginVisible: false }
      : null),
    isClosed: () => false,
  };
  const ctx = { cookies: async () => captured };
  qcPage.context = () => ctx;
  const r = await checkpointQianchuanSessionCookies({
    context: ctx,
    cookieSession: { filePath, startFingerprint: fingerprintFile(filePath) },
    target: qcPage,
    shopCfg: { id: 's2', accountId: '1710242295996424', name: '缺auth店', compassShopName: '缺auth店' },
  });
  assert.strictEqual(r.saved, false);
  assert.match(r.reason, /登录认证 Cookie|拒绝覆盖/);
  assert.ok(fs.readFileSync(filePath).equals(oldBytes));
});

test('检查点无 browser/validator：千川与罗盘默认验证器均 fail-closed，零写入且旧副本原样', async () => {
  const d = mkDirs();
  const captured = makeCookies('candidate-no-browser');

  // 千川：context 无 browser()，未注入 precommitVerify → 默认验证器拒绝，绝不静默跳过。
  const qcFile = path.join(d.workDir, '无浏览器店.json');
  const qcOld = bytesOf(makeCookies('old-keep'));
  fs.writeFileSync(qcFile, qcOld);
  const qcUrl = 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424';
  const qcPage = {
    url: () => qcUrl,
    evaluate: async (fn) => (/shop-name/.test(String(fn))
      ? { accountId: '1710242295996424', accountName: '店', candidates: 1, unique: true, loginVisible: false }
      : null),
    isClosed: () => false,
  };
  const qcCtx = { cookies: async () => captured, addCookies: async () => {}, newPage: async () => qcPage };
  qcPage.context = () => qcCtx;
  const qcAudits = [];
  const qc = await checkpointQianchuanSessionCookies({
    context: qcCtx,
    cookieSession: { filePath: qcFile, startFingerprint: fingerprintFile(qcFile) },
    target: qcPage,
    shopCfg: { id: 's9', accountId: '1710242295996424', name: '无浏览器店', compassShopName: '无浏览器店' },
    audit: (e) => qcAudits.push(e),
  });
  assert.strictEqual(qc.saved, false, JSON.stringify(qc));
  assert.match(qc.reason, /fail-closed|无可用浏览器/);
  assert.ok(fs.readFileSync(qcFile).equals(qcOld), '无浏览器不得写入候选');
  assert.ok(!fs.readdirSync(d.workDir).some((f) => f.includes('.prev-')), '拒绝路径不得留下备份/新写入');
  assert.ok(!JSON.stringify(qcAudits).includes('SECRET-VALUE'), '审计不得记录 Cookie 值');

  // 罗盘：同口径，默认恒构造验证器 → 无 browser 时 fail-closed，零写入。
  const cpFile = path.join(d.workDir, '无浏览器罗盘店.json');
  const cpOld = bytesOf(makeCookies('old-keep-compass'));
  fs.writeFileSync(cpFile, cpOld);
  const cpUrl = 'https://compass.jinritemai.com/shop/dashboard/index';
  const cpPage = {
    url: () => cpUrl,
    evaluate: async (fn) => (/userName/.test(String(fn))
      ? { name: '无浏览器罗盘店', distinct: ['无浏览器罗盘店'], candidates: 1, unique: true, loginVisible: false }
      : null),
    isClosed: () => false,
  };
  const cpCtx = { cookies: async () => captured, addCookies: async () => {}, newPage: async () => cpPage };
  cpPage.context = () => cpCtx;
  const cp = await checkpointCompassSessionCookies({
    context: cpCtx,
    cookieSession: { filePath: cpFile, startFingerprint: fingerprintFile(cpFile) },
    target: cpPage,
    shopCfg: { id: 's10', name: '无浏览器罗盘店', compassShopName: '无浏览器罗盘店' },
  });
  assert.strictEqual(cp.saved, false, JSON.stringify(cp));
  assert.match(cp.reason, /fail-closed|无可用浏览器/);
  assert.ok(fs.readFileSync(cpFile).equals(cpOld), '无浏览器不得写入候选（罗盘）');
});

test('验证器异常脱敏：外部异常含敏感标记时，结果与审计均不得回显异常内容', async () => {
  const MARKER = 'SENSITIVE-LEAK-MARKER-9f3a';
  const d = mkDirs();
  const filePath = path.join(d.workDir, '泄漏店.json');
  const oldBytes = bytesOf(makeCookies('old-keep'));
  fs.writeFileSync(filePath, oldBytes);
  const captured = makeCookies('candidate-leak');
  const qcUrl = 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424';
  const qcPage = {
    url: () => qcUrl,
    evaluate: async (fn) => (/shop-name/.test(String(fn))
      ? { accountId: '1710242295996424', accountName: '店', candidates: 1, unique: true, loginVisible: false }
      : null),
    isClosed: () => false,
  };
  const throwingBrowser = {
    newContext: async () => { throw new Error(`driver error Cookie=sessionid=${MARKER}&token=${MARKER}`); },
  };
  const ctx = { cookies: async () => captured, browser: () => throwingBrowser, addCookies: async () => {}, newPage: async () => qcPage };
  qcPage.context = () => ctx;
  const audits = [];
  const r = await checkpointQianchuanSessionCookies({
    context: ctx,
    cookieSession: { filePath, startFingerprint: fingerprintFile(filePath) },
    target: qcPage,
    shopCfg: { id: 's11', accountId: '1710242295996424', name: '泄漏店', compassShopName: '泄漏店' },
    audit: (e) => audits.push(e),
    candidateVerifyOptions: { sleep: async () => {} },
  });
  assert.strictEqual(r.saved, false);
  assert.ok(!String(r.reason || '').includes(MARKER), `结果不得回显敏感标记: ${r.reason}`);
  assert.ok(!JSON.stringify(audits).includes(MARKER), '审计不得回显敏感标记');
  assert.ok(fs.readFileSync(filePath).equals(oldBytes), '验证异常必须零写入');

  const direct = createCheckpointCandidateVerifier({
    expectedNames: ['泄漏店'],
    browser: throwingBrowser,
    sleep: async () => {},
  });
  const dv = await direct({ cookies: captured, buf: bytesOf(captured), sha256: sha(bytesOf(captured)), serialized: bytesOf(captured).toString('utf8') });
  assert.strictEqual(dv.ok, false);
  assert.ok(!String(dv.reason || '').includes(MARKER), `验证器结果不得回显敏感标记: ${dv.reason}`);

  // 值守恢复链的注入验证器异常同样不得回显异常内容
  const restFile = '会话泄漏店.json';
  const restOld = bytesOf(makeCookies('old-restore'));
  fs.writeFileSync(path.join(d.workDir, restFile), restOld);
  const restAudits = [];
  const rr = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, restFile,
    {
      shopCfg: { name: '会话泄漏店' },
      recoveryDir: d.recoveryDir,
      vaultModule: emptyVaultModule(),
      verify: async () => { throw new Error(`injected verifier Cookie=${MARKER}`); },
      nowFn: () => 10000,
      audit: (e) => restAudits.push(e),
    },
  );
  assert.strictEqual(rr.ok, false);
  const restText = JSON.stringify({ reason: rr.reason, attempts: rr.attempts, restAudits });
  assert.ok(!restText.includes(MARKER), '恢复链结果/审计不得回显敏感标记');
  assert.ok(fs.readFileSync(path.join(d.workDir, restFile)).equals(restOld), '验证异常零写入');
});

// ── 真实入口调用链（qianchuan / compass）：桩浏览器，无真实网页 ────────────

function stubPage(urlForIndex, counters) {
  const page = {
    __nav: 0,
    url() {
      const u = typeof urlForIndex === 'function' ? urlForIndex(page.__nav) : urlForIndex;
      return u;
    },
    goto: async (u) => { page.__gotoUrl = u; if (counters) counters.gotos += 1; },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    isClosed: () => false,
    evaluate: async () => null,
    close: async () => {},
    getByText: () => ({
      count: async () => 0,
      first: () => ({ waitFor: async () => { throw new Error('stub: not attached'); } }),
      nth: () => ({ evaluate: async () => '' }),
    }),
    locator: () => ({
      first: () => ({ textContent: async () => '', isVisible: async () => false, count: async () => 0, waitFor: async () => {} }),
    }),
    waitForURL: () => Promise.reject(new Error('stub: no nav')).catch(() => null),
    waitForFunction: async () => {},
    screenshot: async () => {},
    context: () => page.__ctx,
  };
  return page;
}

function stubBrowser(pagesSpec, counters) {
  const browser = {
    newContext: async () => {
      counters.contexts += 1;
      const idx = counters.contexts;
      const page = stubPage((nav) => pagesSpec(idx, nav), counters);
      const ctx = {
        addCookies: async (cks) => { counters.addedCookieSets += 1; ctx.__lastCookies = cks; },
        newPage: async () => {
          counters.pages += 1;
          return page;
        },
        close: async () => { counters.ctxCloses += 1; },
        cookies: async () => [],
        waitForEvent: () => Promise.reject(new Error('stub: no popup')).catch(() => null),
      };
      page.__ctx = ctx;
      return ctx;
    },
    close: async () => { counters.browserCloses += 1; },
  };
  return browser;
}

test('千川真实入口：登录失效正证据 → 四层恢复（排除当前工作字节，恢复副本经验证提升）→ 新字节重开有界一次', async () => {
  const d = mkDirs();
  const fileName = '千川店.json';
  fs.writeFileSync(path.join(d.workDir, fileName), bytesOf(makeCookies('expired')));
  const fresh = makeCookies('recovery-fresh');
  fs.writeFileSync(path.join(d.recoveryDir, fileName), bytesOf(fresh));
  const counters = { contexts: 0, pages: 0, gotos: 0, ctxCloses: 0, browserCloses: 0, addedCookieSets: 0 };
  const loginCfg = { cookieWorkDir: d.workDir, edgePath: null };
  const shopCfg = { id: 's1', name: '千川店', compassShopName: '千川店', cookieFile: fileName };
  let restoreVerifySources = [];
  await assert.rejects(
    () => openQianchuanHome(loginCfg, shopCfg, {
      browserFactory: async () => stubBrowser((ctxIdx) => (ctxIdx === 1 ? LOGIN_URL : FXG_HOME), counters),
      settleTimeoutMs: 30, settleIntervalMs: 10,
      restoreRecoveryDir: d.recoveryDir,
      restoreVaultModule: emptyVaultModule(),
      restoreVerify: async (p) => { restoreVerifySources.push(p.source); return { ok: true, finalCookies: p.cookies }; },
      nowFn: () => 20000,
    }),
    (e) => {
      assert.ok(e instanceof DataGuardError || e instanceof AuthError, `入口应给出护栏/登录错误：${e && e.message}`);
      return true;
    },
  );
  // 恢复链真实发生：候选=恢复副本（当前工作字节被排除），提升后工作文件为恢复副本字节
  assert.deepEqual(restoreVerifySources, ['guard-recovery']);
  assert.ok(fs.readFileSync(path.join(d.workDir, fileName)).equals(bytesOf(fresh)), '恢复成功必须提升值守工作副本');
  assert.ok(fs.readFileSync(path.join(d.recoveryDir, fileName)).equals(bytesOf(fresh)), '入口链路全程不改写恢复副本');
  assert.strictEqual(counters.contexts, 2, '初次失效会话 + 恢复后有界重试各一次（绝不循环）');
  // COOKIE-PROCESS-ISOLATION-20261026：恢复切换候选前关闭旧店铺浏览器进程（1）+
  // 重开用全新进程、异常出口关闭新进程（2）。
  assert.strictEqual(counters.browserCloses, 2, '恢复前关闭旧进程 + 异常出口关闭重开的新进程');
});

test('千川真实入口：恢复无可验证候选 → AuthError 原语义保留 + 如实恢复说明，工作副本未被盲覆盖', async () => {
  const d = mkDirs();
  const fileName = '千川店2.json';
  const stale = bytesOf(makeCookies('expired'));
  fs.writeFileSync(path.join(d.workDir, fileName), stale);
  fs.writeFileSync(path.join(d.recoveryDir, fileName), bytesOf(makeCookies('also-expired')));
  const counters = { contexts: 0, pages: 0, gotos: 0, ctxCloses: 0, browserCloses: 0, addedCookieSets: 0 };
  await assert.rejects(
    () => openQianchuanHome(
      { cookieWorkDir: d.workDir, edgePath: null },
      { id: 's2', name: '千川店2', compassShopName: '千川店2', cookieFile: fileName },
      {
        browserFactory: async () => stubBrowser(() => LOGIN_URL, counters),
        settleTimeoutMs: 30, settleIntervalMs: 10,
        restoreRecoveryDir: d.recoveryDir,
        restoreVaultModule: emptyVaultModule(),
        restoreVerify: async () => ({ ok: false, reason: '桩：候选登录无效' }),
        nowFn: () => 20000,
      },
    ),
    (e) => {
      assert.ok(e instanceof AuthError);
      assert.match(e.message, /登录失效：抖店页面在 .* 次有界收敛（上限 \d+s）后仍命中登录页地址或可见登录控件\/表单（当前 .+），请重新扫码登录/);
      assert.match(e.message, /四层恢复未取得可验证候选（全部候选未通过验证或提升失败/);
      assert.match(e.message, /工作副本现状未被盲覆盖/);
      return true;
    },
  );
  assert.ok(fs.readFileSync(path.join(d.workDir, fileName)).equals(stale));
  assert.strictEqual(counters.contexts, 1, '恢复失败不得重试打开');
  assert.strictEqual(counters.browserCloses, 1);
});

test('罗盘真实入口：登录失效 → 排除当前工作字节 → 恢复副本验证提升后重开；收尾检查点零写不伪装过期', async () => {
  const d = mkDirs();
  const fileName = '罗盘店.json';
  fs.writeFileSync(path.join(d.workDir, fileName), bytesOf(makeCookies('expired')));
  const fresh = makeCookies('recovery-fresh');
  fs.writeFileSync(path.join(d.recoveryDir, fileName), bytesOf(fresh));
  const counters = { contexts: 0, pages: 0, gotos: 0, ctxCloses: 0, browserCloses: 0, addedCookieSets: 0 };
  const reader = createCompassOrderReader({
    loginCfg: { cookieWorkDir: d.workDir, edgePath: null },
    evidenceDir: path.join(d.base, 'evidence'),
    browserFactory: async () => stubBrowser((ctxIdx) => (ctxIdx === 1 ? LOGIN_URL : FXG_HOME), counters),
    settleTimeoutMs: 30, settleIntervalMs: 10,
    restoreRecoveryDir: d.recoveryDir,
    restoreVaultModule: emptyVaultModule(),
    restoreVerify: async (p) => ({ ok: true, finalCookies: p.cookies }),
    nowFn: () => 20000,
  });
  await assert.rejects(
    () => reader.readOrderSummary({
      shopCfg: { id: 's3', name: '罗盘店', compassShopName: '罗盘店', cookieFile: fileName },
    }),
    (e) => {
      assert.ok(e instanceof DataGuardError, `恢复后已非登录失效，罗盘导航桩应如实报导航事实：${e && e.message}`);
      assert.match(e.message, /成交订单数|导航/);
      return true;
    },
  );
  assert.ok(fs.readFileSync(path.join(d.workDir, fileName)).equals(bytesOf(fresh)), '入口恢复链提升成功');
  assert.ok(fs.readFileSync(path.join(d.recoveryDir, fileName)).equals(bytesOf(fresh)), '恢复副本只读');
  // COOKIE-PROCESS-ISOLATION-20261026：恢复切换候选前关闭旧店铺浏览器进程（1）+
  // 重开用全新进程、finally 关闭新进程（2）。
  assert.strictEqual(counters.browserCloses, 2, '恢复前关闭旧进程 + finally 关闭重开的新进程');
});

test('罗盘真实入口：restoreOnAuthFailure=false 关闭恢复 → 原 AuthError 无恢复说明', async () => {
  const d = mkDirs();
  const fileName = '罗盘店2.json';
  const stale = bytesOf(makeCookies('expired'));
  fs.writeFileSync(path.join(d.workDir, fileName), stale);
  const counters = { contexts: 0, pages: 0, gotos: 0, ctxCloses: 0, browserCloses: 0, addedCookieSets: 0 };
  const reader = createCompassOrderReader({
    loginCfg: { cookieWorkDir: d.workDir, edgePath: null },
    evidenceDir: path.join(d.base, 'evidence'),
    browserFactory: async () => stubBrowser(() => LOGIN_URL, counters),
    settleTimeoutMs: 30, settleIntervalMs: 10,
    restoreOnAuthFailure: false,
    nowFn: () => 20000,
  });
  await assert.rejects(
    () => reader.readOrderSummary({
      shopCfg: { id: 's4', name: '罗盘店2', compassShopName: '罗盘店2', cookieFile: fileName },
    }),
    (e) => {
      assert.ok(e instanceof AuthError);
      assert.ok(!/四层恢复/.test(e.message), '关闭开关后不得声称执行过恢复');
      return true;
    },
  );
  assert.ok(fs.readFileSync(path.join(d.workDir, fileName)).equals(stale));
});
