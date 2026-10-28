'use strict';

/**
 * MULTISHOP-ISOLATION-20261027（D2，guard 侧）：多店会话/副本隔离回归（全合成，离线）。
 *
 * 范围与边界：
 *  - 只操作真实 helper 模块（candidate-browser / cookie-workcopy / session.resolveCookieFile），
 *    浏览器一律注入合成 fake（无 Playwright、无真实进程、无网络）；
 *  - 断言核心隔离语义：并发 A/B/C 各自的候选浏览器工厂实例独立（关 A 绝不关 B/C）、
 *    context 存储互不串扰、三店工作副本交错解析各归各路径、删除来源后本地副本独立可用、
 *    锁竞争只影响本店、授权新登录写回只落本店副本且不触碰来源；
 *  - 全程不打印/不断言任何真实 Cookie 值（占位值仅存在于临时目录与本进程内存，测试内比对）。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCandidateBrowserFactory, closeBrowserProven } = require('../src/login/candidate-browser');
const { ensureWorkCopy, sha256Of } = require('../src/login/cookie-workcopy');
const { resolveCookieFile, rankRestoreCandidatesGuard, restoreDutyWorkCopy, RESTORE_MAX_CANDIDATES } = require('../src/login/session');

const SHOPS = ['shopA', 'shopB', 'shopC'];

// 合成 Cookie（占位值，非真实凭证；domain 满足 helper 的 jinritemai 结构校验）
function fakeCookieBuffer(tag) {
  return Buffer.from(JSON.stringify([
    { name: 'sessionid', value: `FAKE-${tag}-NOT-A-REAL-COOKIE`, domain: '.jinritemai.com', path: '/' },
    { name: 'sid_guard', value: `FAKE-${tag}-GUARD`, domain: '.jinritemai.com', path: '/' },
  ]), 'utf8');
}

// 合成浏览器：newContext/close/isConnected 足以驱动真实 helper 的全部判定分支
class FakeBrowser {
  constructor(tag) {
    this.tag = tag;
    this.contexts = [];
    this.closedCount = 0;
  }
  async newContext() {
    const ctx = {
      addedCookies: [],
      addCookies: async (cookies) => { ctx.addedCookies.push(...cookies); },
      cookies: async () => ctx.addedCookies.slice(),
      close: async () => {},
    };
    this.contexts.push(ctx);
    return ctx;
  }
  async close() { this.closedCount += 1; }
  isConnected() { return this.closedCount === 0; }
}

function makeShopDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-multishop-iso-'));
  const sourceDir = path.join(root, 'source');
  const workDirs = {};
  fs.mkdirSync(sourceDir);
  for (const s of SHOPS) {
    workDirs[s] = path.join(root, 'work-' + s);
    fs.mkdirSync(workDirs[s]);
    fs.writeFileSync(path.join(sourceDir, s + '.json'), fakeCookieBuffer(s));
  }
  return { root, sourceDir, workDirs };
}

test('候选浏览器工厂：A/B/C 实例独立，关 A 绝不关 B/C', async () => {
  const made = [];
  const factory = createCandidateBrowserFactory({
    injectedFactory: async () => { const b = new FakeBrowser('c' + made.length); made.push(b); return b; },
  });
  // 交错启动（模拟三店并发进入候选验证）
  const [a, b, c] = await Promise.all([factory(), factory(), factory()]);
  assert.strictEqual(a, made[0]); assert.strictEqual(b, made[1]); assert.strictEqual(c, made[2]);
  assert.notStrictEqual(a, b); assert.notStrictEqual(b, c); assert.notStrictEqual(a, c);

  const closeProven = await closeBrowserProven(a);
  assert.strictEqual(closeProven, true);
  assert.strictEqual(a.closedCount, 1);
  assert.strictEqual(b.closedCount, 0, '关 A 不得关闭 B');
  assert.strictEqual(c.closedCount, 0, '关 A 不得关闭 C');
  assert.strictEqual(b.isConnected(), true);
  assert.strictEqual(c.isConnected(), true);
});

test('候选浏览器工厂：返回重复实例 = 违反进程隔离，拒绝并只收口该实例', async () => {
  const shared = new FakeBrowser('shared');
  let calls = 0;
  const factory = createCandidateBrowserFactory({
    injectedFactory: async () => { calls += 1; return shared; },
  });
  const first = await factory();      // 第一次：全新实例，允许
  assert.strictEqual(first, shared);
  await assert.rejects(() => factory(), (e) => {
    assert.ok(String(e.message).includes('重复的浏览器实例'));
    return true;
  });
  assert.strictEqual(calls, 2);
  assert.strictEqual(shared.closedCount, 1, '被拒绝的重复实例必须被保守关闭');
});

test('context 存储分离：三店交错装载，各自 context 只收到本店 Cookie', async () => {
  const browsers = {}; const contexts = {};
  for (const s of SHOPS) browsers[s] = new FakeBrowser(s);
  // 交错：A.ctx ← A, B.ctx ← B, C.ctx ← C，再回环一次
  for (const s of ['shopA', 'shopB', 'shopC', 'shopA', 'shopC', 'shopB']) {
    if (!contexts[s]) contexts[s] = await browsers[s].newContext();
    await contexts[s].addCookies([{ name: 'sessionid', value: `FAKE-${s}-NOT-A-REAL-COOKIE`, domain: '.jinritemai.com', path: '/' }]);
  }
  for (const s of SHOPS) {
    assert.strictEqual(browsers[s].contexts.length, 1, `${s} 只开自己的一个 context`);
    const got = await contexts[s].cookies();
    assert.strictEqual(got.length, 2);
    assert.ok(got.every((ck) => ck.value.includes(`FAKE-${s}`)), `${s} 的 context 不得混入他店 Cookie`);
  }
});

test('三店工作副本交错解析：各归各路径，字节互不串扰', () => {
  const { root, sourceDir, workDirs } = makeShopDirs();
  try {
    // 交错解析两轮（每店独立工作根，模拟三店并发 duty 解析）
    for (const s of ['shopA', 'shopB', 'shopC', 'shopC', 'shopA', 'shopB']) {
      const r = resolveCookieFile({ cookieSourceDir: sourceDir }, s, { workDir: workDirs[s], fsMod: fs });
      assert.strictEqual(path.dirname(r.path), workDirs[s]);
      assert.strictEqual(path.basename(r.path), s + '.json');
    }
    for (const s of SHOPS) {
      const content = fs.readFileSync(path.join(workDirs[s], s + '.json'), 'utf8');
      assert.ok(content.includes(`FAKE-${s}`), `${s} 副本必须是本店字节`);
      for (const other of SHOPS) {
        if (other === s) continue;
        assert.ok(!content.includes(`FAKE-${other}`), `${s} 副本不得含 ${other} 的 Cookie`);
      }
      // 来源目录零写入
      const src = fs.readFileSync(path.join(sourceDir, s + '.json'), 'utf8');
      assert.ok(src.includes(`FAKE-${s}`));
    }
    assert.strictEqual(fs.readdirSync(sourceDir).length, SHOPS.length, '来源目录不得出现 tmp/sidecar/lock');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('删除A店来源文件后：A 用本地副本继续，B/C 不受影响', () => {
  const { root, sourceDir, workDirs } = makeShopDirs();
  try {
    for (const s of SHOPS) {
      resolveCookieFile({ cookieSourceDir: sourceDir }, s, { workDir: workDirs[s], fsMod: fs });
    }
    fs.rmSync(path.join(sourceDir, 'shopA.json'));
    const a = resolveCookieFile({ cookieSourceDir: sourceDir }, 'shopA', { workDir: workDirs.shopA, fsMod: fs });
    assert.strictEqual(a.sourceSync.status, 'source-file-missing-local-only');
    assert.ok(fs.readFileSync(a.path, 'utf8').includes('FAKE-shopA'));
    for (const other of ['shopB', 'shopC']) {
      const r = resolveCookieFile({ cookieSourceDir: sourceDir }, other, { workDir: workDirs[other], fsMod: fs });
      assert.strictEqual(path.basename(r.path), other + '.json');
      assert.ok(fs.readFileSync(r.path, 'utf8').includes(`FAKE-${other}`));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('锁竞争只影响本店：A 被锁阻断时 B/C 正常解析', () => {
  const { root, sourceDir, workDirs } = makeShopDirs();
  try {
    for (const s of SHOPS) {
      resolveCookieFile({ cookieSourceDir: sourceDir }, s, { workDir: workDirs[s], fsMod: fs });
    }
    // 制造 A 的导入竞争：删掉 A 的本地副本 + 预置他人持有的锁 → busy fail-closed
    fs.rmSync(path.join(workDirs.shopA, 'shopA.json'));
    fs.writeFileSync(path.join(workDirs.shopA, 'shopA.json.lock'), '12345', 'utf8');
    assert.throws(
      () => resolveCookieFile({ cookieSourceDir: sourceDir }, 'shopA', { workDir: workDirs.shopA, fsMod: fs }),
      (e) => String(e.message).includes('正在同步该店'),
    );
    for (const other of ['shopB', 'shopC']) {
      const r = resolveCookieFile({ cookieSourceDir: sourceDir }, other, { workDir: workDirs[other], fsMod: fs });
      assert.strictEqual(path.basename(r.path), other + '.json');
      assert.ok(fs.readFileSync(r.path, 'utf8').includes(`FAKE-${other}`));
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('授权新登录写回：只按冻结快照落本店副本，来源与其他店零影响', () => {
  const { root, sourceDir, workDirs } = makeShopDirs();
  try {
    const srcBuf = fs.readFileSync(path.join(sourceDir, 'shopA.json'));
    const r = ensureWorkCopy({
      sourceDir, fileName: 'shopA.json', workDir: workDirs.shopA, fsMod: fs,
      authorizedFreshLogin: true, expectedSourceSha256: sha256Of(srcBuf),
    });
    assert.strictEqual(r.path, path.join(workDirs.shopA, 'shopA.json'));
    assert.strictEqual(r.sourceSync.status, 'imported');
    assert.strictEqual(sha256Of(fs.readFileSync(r.path)), sha256Of(srcBuf), '副本必须等于冻结来源字节');
    // 写回期间不触碰来源与其他店
    assert.strictEqual(fs.readFileSync(path.join(sourceDir, 'shopA.json')).toString('utf8'), srcBuf.toString('utf8'));
    for (const other of ['shopB', 'shopC']) {
      assert.ok(!fs.existsSync(path.join(workDirs[other], 'shopA.json')), `不得把 A 的副本写进 ${other} 工作根`);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('全链路不打印 Cookie 值：helper 输出只含元信息', async () => {
  const { root, sourceDir, workDirs } = makeShopDirs();
  const origLog = console.log; const origErr = console.error;
  const captured = [];
  console.log = (...a) => { captured.push(a.map(String).join(' ')); };
  console.error = (...a) => { captured.push(a.map(String).join(' ')); };
  try {
    for (const s of SHOPS) {
      resolveCookieFile({ cookieSourceDir: sourceDir }, s, { workDir: workDirs[s], fsMod: fs });
    }
    const factory = createCandidateBrowserFactory({ injectedFactory: async () => new FakeBrowser('x') });
    const b = await factory();
    await closeBrowserProven(b);
    for (const line of captured) {
      assert.ok(!line.includes('FAKE-'), `日志不得出现 Cookie 值: ${line.slice(0, 80)}`);
    }
  } finally {
    console.log = origLog; console.error = origErr;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ============ D4：恢复链候选饥饿修复（legacy 回退不被首选窗口永久挤出） ============

// 合成归档（vault 模块替身）：versions = [{versionId, versionPath, sha256, createdAtMs, origin}]
function makeFakeVault(versions) {
  return {
    defaultRoots: () => ({ archiveRoot: path.join(os.tmpdir(), 'guard-multishop-iso-fake-archive') }),
    listSnapshotVersions: () => ({ ok: true, versions: versions.slice() }),
    readSnapshotVersion: ({ versionPath, expectedSha256 }) => {
      const v = versions.find((x) => x.versionPath === versionPath);
      if (!v) return { ok: false, reason: '版本不存在（合成）' };
      if (expectedSha256 && expectedSha256 !== v.sha256) return { ok: false, reason: 'sha 不一致（合成）' };
      return { ok: true, buf: v.buf, sha256: v.sha256 };
    },
  };
}

function makeArchiveVersion(id, origin, minuteOffset) {
  const buf = fakeCookieBuffer(id);
  return {
    versionId: id, versionPath: path.join(os.tmpdir(), `fake-${id}.json`),
    sha256: sha256Of(buf), buf, origin,
    createdAtMs: Date.UTC(2026, 9, 27, 0, minuteOffset, 0),
  };
}

test('D4 排名：首选窗口非 legacy 优先，legacy 落同宽回退窗口而非被挤为零', () => {
  const versions = [];
  for (let i = 1; i <= 6; i += 1) versions.push(makeArchiveVersion(`nP${i}`, 'verified-login', i));
  versions.push(makeArchiveVersion('gA', 'legacy-unverified', 12));
  versions.push(makeArchiveVersion('gB', 'legacy-unverified', 11));
  const cands = versions.map((v) => ({
    source: `raw-archive:${v.versionId}`, buf: v.buf, sha256: v.sha256,
    createdAtMs: v.createdAtMs, origin: v.origin,
  }));
  const r = rankRestoreCandidatesGuard(cands, RESTORE_MAX_CANDIDATES);
  // 首选窗口：最新 5 条非 legacy（nP6..nP2）；nP1 超额 beyond-limit
  assert.strictEqual(r.selected.length, RESTORE_MAX_CANDIDATES + 2);
  const preferredIds = r.selected.slice(0, RESTORE_MAX_CANDIDATES).map((c) => c.source.slice('raw-archive:'.length));
  assert.deepStrictEqual(preferredIds, ['nP6', 'nP5', 'nP4', 'nP3', 'nP2']);
  // 回退窗口：两条 legacy 都被选入（selected-fallback），排在首选之后
  const fallbackIds = r.selected.slice(RESTORE_MAX_CANDIDATES).map((c) => c.source.slice('raw-archive:'.length));
  assert.deepStrictEqual(fallbackIds, ['gA', 'gB']);
  const nP1 = r.ranking.find((e) => e.versionId === 'nP1');
  assert.strictEqual(nP1.decision, 'beyond-limit');
  for (const id of ['gA', 'gB']) {
    const e = r.ranking.find((x) => x.versionId === id);
    assert.strictEqual(e.decision, 'selected-fallback');
    assert.strictEqual(e.window, 'legacy-fallback');
  }
});

test('D4 排名：跨层同 sha 全局去重——回退窗口不重复验证首选已选字节', () => {
  // 同一份字节先后以非 legacy 与 legacy 身份入档（不同 versionId/不同分钟）
  const dupBytes = makeArchiveVersion('dupBytes', 'verified-login', 4);
  const sameAsLegacy = { ...dupBytes, versionId: 'dupSame', createdAtMs: dupBytes.createdAtMs + 60000, origin: 'legacy-unverified' };
  const cands = [
    { source: 'raw-archive:dupBytes', buf: dupBytes.buf, sha256: dupBytes.sha256, createdAtMs: dupBytes.createdAtMs, origin: 'verified-login' },
    { source: 'raw-archive:dupSame', buf: sameAsLegacy.buf, sha256: sameAsLegacy.sha256, createdAtMs: sameAsLegacy.createdAtMs, origin: 'legacy-unverified' },
  ];
  const r = rankRestoreCandidatesGuard(cands, RESTORE_MAX_CANDIDATES);
  assert.strictEqual(r.selected.length, 1);
  const legacyEntry = r.ranking.find((e) => e.versionId === 'dupSame');
  assert.strictEqual(legacyEntry.decision, 'skipped-dup-sha');
});

function guardRestoreOpts(tmpRoot, versions, verify) {
  return {
    shopCfg: { name: 'shopA' },
    workDir: path.join(tmpRoot, 'work'),
    recoveryDir: path.join(tmpRoot, 'recovery-absent'), // 隔离：不读生产恢复副本层
    vaultModule: makeFakeVault(versions),
    verify,
    nowFn: () => Date.UTC(2026, 9, 27, 1, 0, 0),
  };
}

test('D4 恢复：首选 5 条失效后 legacy 回退被试到并提升（顺序：先首选后回退）', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-multishop-iso-d4-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'work'));
    const versions = [];
    for (let i = 1; i <= 5; i += 1) versions.push(makeArchiveVersion(`nP${i}`, 'verified-login', i));
    versions.push(makeArchiveVersion('gOK', 'legacy-unverified', 9));
    const verifyCalls = [];
    const verify = async (p) => {
      verifyCalls.push(p.source);
      if (p.source !== 'raw-archive:gOK') return { ok: false, classification: 'login-invalid', reason: '合成失效' };
      const finalCookies = JSON.parse(fakeCookieBuffer('gOK').toString('utf8'));
      return { ok: true, finalCookies };
    };
    const r = await restoreDutyWorkCopy({}, 'shopA.json', guardRestoreOpts(tmpRoot, versions, verify));
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.source, 'raw-archive:gOK');
    // 验证顺序：5 条首选（新→旧）在前，legacy 回退最后
    assert.deepStrictEqual(verifyCalls, [
      'raw-archive:nP5', 'raw-archive:nP4', 'raw-archive:nP3', 'raw-archive:nP2', 'raw-archive:nP1', 'raw-archive:gOK',
    ]);
    // 提升的是验证 context 的最终集合序列化字节，落在自己的值守工作副本
    const workPath = path.join(tmpRoot, 'work', 'shopA.json');
    const promoted = JSON.parse(fs.readFileSync(workPath, 'utf8'));
    assert.deepStrictEqual(promoted, JSON.parse(fakeCookieBuffer('gOK').toString('utf8')));
    // 失败计数如实覆盖两个窗口（5 次失败 + 1 次成功）
    const failed = r.attempts.filter((a) => a.result === 'verify-failed');
    assert.strictEqual(failed.length, 5);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('D4 恢复：首选第一条即成功 → 不再验证任何 legacy 回退', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-multishop-iso-d4-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'work'));
    const versions = [
      makeArchiveVersion('good1', 'verified-login', 1),
      makeArchiveVersion('gNever', 'legacy-unverified', 8),
    ];
    const verifyCalls = [];
    const verify = async (p) => {
      verifyCalls.push(p.source);
      if (p.source === 'raw-archive:good1') {
        return { ok: true, finalCookies: JSON.parse(fakeCookieBuffer('good1').toString('utf8')) };
      }
      return { ok: false, reason: '不应被验证（合成）' };
    };
    const r = await restoreDutyWorkCopy({}, 'shopA.json', guardRestoreOpts(tmpRoot, versions, verify));
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(verifyCalls, ['raw-archive:good1'], '首选成功后不得再验证 legacy');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('D4 恢复：首选 stopChain 立即停止 → legacy 回退不再启动', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-multishop-iso-d4-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'work'));
    const versions = [
      makeArchiveVersion('s1', 'verified-login', 1),
      makeArchiveVersion('gStop', 'legacy-unverified', 8),
    ];
    const verifyCalls = [];
    const verify = async (p) => {
      verifyCalls.push(p.source);
      return { ok: false, classification: 'verify-error', stopChain: true, reason: '合成：候选进程关闭未获证明' };
    };
    const r = await restoreDutyWorkCopy({}, 'shopA.json', guardRestoreOpts(tmpRoot, versions, verify));
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(verifyCalls, ['raw-archive:s1'], 'stopChain 必须立即终止全部窗口');
    assert.ok(r.attempts.some((a) => a.source === 'raw-archive:s1' && a.stopChain === true));
    assert.ok(!fs.existsSync(path.join(tmpRoot, 'work', 'shopA.json')), '停止链绝不提升/写入');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('D4 恢复：含 legacy 在内全部失效 → 基线工作副本字节保持不变', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-multishop-iso-d4-'));
  try {
    const workDir = path.join(tmpRoot, 'work');
    fs.mkdirSync(workDir);
    const workPath = path.join(workDir, 'shopA.json');
    const originalBuf = fakeCookieBuffer('baseline');
    fs.writeFileSync(workPath, originalBuf);
    const versions = [];
    for (let i = 1; i <= 3; i += 1) versions.push(makeArchiveVersion(`nP${i}`, 'verified-login', i));
    versions.push(makeArchiveVersion('gBad', 'legacy-unverified', 8));
    const verify = async () => ({ ok: false, classification: 'login-invalid', reason: '合成失效' });
    const opts = guardRestoreOpts(tmpRoot, versions, verify);
    opts.excludeWorkCopy = true; // 登录失效入口：当前字节即刚失败内容，不重复验证
    const r = await restoreDutyWorkCopy({}, 'shopA.json', opts);
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(fs.readFileSync(workPath), originalBuf, '全部失败时工作副本保持现状');
    assert.ok(r.reason.includes('验证调用 4 次'), `失败汇总必须如实覆盖两个窗口的实际验证次数: ${r.reason}`);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
