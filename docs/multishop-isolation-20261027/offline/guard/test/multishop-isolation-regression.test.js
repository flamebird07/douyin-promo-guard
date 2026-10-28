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

const sessionVault = require('../../app/cookie-vault');

function fullSessionCookies(session, variant, scope = {}) {
  return [
    ...['sessionid', 'sessionid_ss', 'sid_tt'].map((name) => ({
      name, value: `FAKE-${session}-${name}`, domain: '.jinritemai.com', path: '/', ...scope,
    })),
    { name: 'sid_guard', value: `FAKE-GUARD-${variant}`, domain: '.jinritemai.com', path: '/' },
    { name: 'tracking', value: `FAKE-TRACK-${variant}`, domain: '.jinritemai.com', path: '/' },
  ];
}

function sessionTree(root) {
  const out = [];
  for (const name of fs.readdirSync(root).sort()) {
    const p = path.join(root, name);
    const st = fs.lstatSync(p);
    if (st.isDirectory()) out.push(...sessionTree(p));
    else out.push([p, sha256Of(fs.readFileSync(p)), st.mtimeMs, st.mode]);
  }
  return out;
}

function guardSessionFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-session-breadth-'));
  const roots = sessionVault.defaultRoots({ appRoot: path.join(root, 'app'), guardRoot: path.join(root, 'guard') });
  for (const dir of [roots.archiveRoot, roots.recoveryDir, roots.analyzerWorkDir, roots.guardWorkDir]) fs.mkdirSync(dir, { recursive: true });
  const workPath = path.join(roots.guardWorkDir, 'shopA.json');
  const reads = [];
  const byteReads = [];
  const audit = [];
  const fsm = Object.create(fs);
  fsm.readFileSync = (p, ...args) => {
    if (String(p).startsWith(roots.archiveRoot + path.sep) && /^v.+\.json$/.test(path.basename(String(p)))) {
      byteReads.push(p);
      assert.strictEqual(path.dirname(p), path.join(roots.archiveRoot, 'shopA'));
    }
    return fs.readFileSync(p, ...args);
  };
  const readOnlyRoots = [roots.archiveRoot, roots.recoveryDir, roots.analyzerWorkDir];
  const readOnlyWrites = [];
  const assertWritable = (p) => {
    if (typeof p !== 'string') return;
    if (readOnlyRoots.some((dir) => p === dir || p.startsWith(dir + path.sep))) {
      readOnlyWrites.push(p);
      assert.fail('恢复不得写只读来源/其他角色');
    }
  };
  fsm.openSync = (p, flags, ...args) => {
    if (flags !== 'r') assertWritable(p);
    return fs.openSync(p, flags, ...args);
  };
  for (const method of ['writeFileSync', 'appendFileSync', 'mkdirSync', 'unlinkSync', 'chmodSync', 'renameSync']) {
    fsm[method] = (...args) => {
      assertWritable(args[0]);
      if (method === 'renameSync') assertWritable(args[1]);
      return fs[method](...args);
    };
  }
  let tick = Date.UTC(2026, 9, 28);
  const snapshot = (cookies, legacy = false) => {
    const args = { shopSafeName: 'shopA', roots, nowFn: () => ++tick };
    const r = legacy
      ? sessionVault.archiveLegacyBytes({ ...args, buf: Buffer.from(JSON.stringify(cookies)) })
      : sessionVault.createRawSnapshot({ ...args, cookies });
    assert.strictEqual(r.ok, true);
    return r;
  };
  const vaultModule = {
    ...sessionVault,
    readSnapshotVersion(p) {
      assert.strictEqual(path.dirname(p.versionPath), path.join(roots.archiveRoot, 'shopA'));
      const r = sessionVault.readSnapshotVersion(p);
      reads.push({ path: p.versionPath, ok: r.ok, expected: p.expectedSha256 });
      if (r.ok) assert.strictEqual(r.sha256, p.expectedSha256);
      return r;
    },
  };
  const sourceState = () => [readOnlyWrites.slice(), ...readOnlyRoots.map(sessionTree)];
  const restore = (verify, extra = {}) => restoreDutyWorkCopy(extra.loginCfg || { cookieSourceDir: roots.analyzerWorkDir }, 'shopA.json', {
    shopCfg: { name: 'shopA' }, workDir: roots.guardWorkDir, recoveryDir: roots.recoveryDir,
    vaultRoots: roots, vaultModule, fsModule: fsm, verify, audit: (e) => audit.push(e), ...extra,
  });
  return { root, roots, workPath, reads, byteReads, audit, snapshot, sourceState, restore, fsm };
}

function rankedSessionCandidate(source, cookies, at = 1) {
  const buf = Buffer.isBuffer(cookies) ? cookies : Buffer.from(JSON.stringify(cookies));
  return { source, buf, sha256: sha256Of(buf), createdAtMs: at, origin: 'verified-login' };
}

test('D10R guard 排名：跨角色同会话让位不同会话，余位仍按角色优先保留变体', () => {
  const cands = [
    rankedSessionCandidate('guard-duty-work', fullSessionCookies('A', 'work')),
    rankedSessionCandidate('analyzer-source', fullSessionCookies('A', 'analysis').reverse()),
    rankedSessionCandidate('guard-recovery', fullSessionCookies('A', 'recovery')),
    rankedSessionCandidate('raw-archive:new', fullSessionCookies('A', 'archive'), 20),
    rankedSessionCandidate('raw-archive:old', fullSessionCookies('B', 'old'), 10),
  ];
  const r = rankRestoreCandidatesGuard(cands);
  assert.deepStrictEqual(r.selected.map((c) => c.source), [
    'guard-duty-work', 'raw-archive:old', 'analyzer-source', 'guard-recovery', 'raw-archive:new',
  ]);
  assert.ok(!JSON.stringify(r.ranking).includes('FAKE-'));
  assert.ok(!JSON.stringify(r.ranking).includes('session:'));
});

test('D10R guard 排名：完整三键及域/路径/分区参与身份，不完整或不透明内容保留 SHA 规则', () => {
  const base = fullSessionCookies('A', 'base');
  const changedKey = fullSessionCookies('A', 'key');
  changedKey[1].value = 'FAKE-DIFFERENT-SECOND-KEY';
  for (const other of [
    changedKey,
    fullSessionCookies('A', 'domain', { domain: 'fxg.jinritemai.com' }),
    fullSessionCookies('A', 'path', { path: '/other' }),
    fullSessionCookies('A', 'partition', { partitionKey: 'https://partition.example' }),
  ]) {
    const cands = [base, fullSessionCookies('A', 'variant'), other].map((cookies, i) => rankedSessionCandidate(`upper-${i}`, cookies));
    assert.deepStrictEqual(rankRestoreCandidatesGuard(cands, 2).selected.map((c) => c.source), ['upper-0', 'upper-2']);
  }
  const partitioned = [
    fullSessionCookies('A', 'work', { partitionKey: { topLevelSite: 'https://partition.example', hasCrossSiteAncestor: false } }),
    fullSessionCookies('A', 'variant', { partitionKey: { hasCrossSiteAncestor: false, topLevelSite: 'https://partition.example' } }).reverse(),
    fullSessionCookies('B', 'other'),
  ].map((cookies, i) => rankedSessionCandidate(`upper-${i}`, cookies));
  assert.deepStrictEqual(rankRestoreCandidatesGuard(partitioned, 2).selected.map((c) => c.source), ['upper-0', 'upper-2']);
  for (const bytes of [
    Buffer.from('opaque'),
    Buffer.from(JSON.stringify(fakeCookiesWithoutSession())),
    Buffer.from(JSON.stringify(base.slice(1))),
    Buffer.from(JSON.stringify(base.map((c) => c.name === 'sid_tt' ? { ...c, value: '' } : c))),
  ]) {
    const cands = [bytes, Buffer.concat([bytes, Buffer.from(' ')]), Buffer.from('other')]
      .map((buf, i) => rankedSessionCandidate(`upper-${i}`, buf));
    assert.deepStrictEqual(rankRestoreCandidatesGuard(cands, 2).selected.map((c) => c.source), ['upper-0', 'upper-1']);
    assert.strictEqual(rankRestoreCandidatesGuard([cands[0], { ...cands[0], source: 'duplicate' }]).selected.length, 1);
  }
});

function fakeCookiesWithoutSession() {
  return [{ name: 'tracking', value: 'FAKE-ONLY-TRACKING', domain: '.jinritemai.com', path: '/' }];
}

test('D10R guard 恢复：七个同会话归档之前的不同历史会话可达，分析/恢复重复不耗尽首选', async () => {
  const f = guardSessionFixture();
  try {
    const healthy = f.snapshot(fullSessionCookies('B', 'healthy'));
    for (let i = 0; i < 7; i += 1) f.snapshot(fullSessionCookies('A', `archive-${i}`));
    f.snapshot(fullSessionCookies('A', 'legacy'), true);
    fs.writeFileSync(f.workPath, JSON.stringify(fullSessionCookies('A', 'work')));
    fs.writeFileSync(path.join(f.roots.analyzerWorkDir, 'shopA.json'), JSON.stringify(fullSessionCookies('A', 'analysis')));
    fs.writeFileSync(path.join(f.roots.recoveryDir, 'shopA.json'), JSON.stringify(fullSessionCookies('A', 'recovery')));
    const vdir = path.join(f.roots.recoveryDir, 'shopA');
    fs.mkdirSync(vdir);
    for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(vdir, `v${i}.json`), JSON.stringify(fullSessionCookies('A', `recovery-${i}`)));
    sessionVault.createRawSnapshot({ shopSafeName: 'shopB', cookies: fullSessionCookies('OTHER', 'other'), roots: f.roots });
    const before = f.sourceState();
    const calls = [];
    const r = await f.restore(async (p) => {
      calls.push(p.source);
      return p.source === `raw-archive:${healthy.versionId}` ? { ok: true, finalCookies: p.cookies } : { ok: false };
    });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(calls, ['guard-duty-work', `raw-archive:${healthy.versionId}`]);
    assert.ok(calls.length <= RESTORE_MAX_CANDIDATES);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.workPath)), fullSessionCookies('B', 'healthy'));
    assert.deepStrictEqual(f.sourceState(), before);
    assert.ok(f.reads.length > RESTORE_MAX_CANDIDATES && f.reads.length <= sessionVault.MAX_VERSIONS_SCAN);
    assert.ok(!JSON.stringify(f.audit).includes('FAKE-'));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const mode of ['preferred', 'legacy', 'variant', 'failure', 'stopChain', 'cas', 'final-missing']) {
  test(`D10R guard 同会话变体：${mode}，首选5/回退5及只读源/CAS边界`, async () => {
    const f = guardSessionFixture();
    try {
      for (let i = 0; i < 7; i += 1) f.snapshot(fullSessionCookies('A', `preferred-${i}`));
      const legacyIds = [];
      for (let i = 0; i < 7; i += 1) legacyIds.push(f.snapshot(fullSessionCookies('A', `legacy-${i}`), true).versionId);
      const baseline = Buffer.from(JSON.stringify(fullSessionCookies('A', 'work')));
      const concurrent = Buffer.from(JSON.stringify(fullSessionCookies('C', 'concurrent')));
      fs.writeFileSync(f.workPath, baseline);
      const before = f.sourceState();
      const calls = [];
      const r = await f.restore(async (p) => {
        calls.push(p.source);
        const legacy = legacyIds.some((id) => p.source === `raw-archive:${id}`);
        if (mode === 'stopChain') return { ok: false, stopChain: true };
        if (mode === 'cas' && calls.length === 1) fs.writeFileSync(f.workPath, concurrent);
        if (mode === 'final-missing') return { ok: true };
        const ok = mode === 'preferred' || mode === 'cas' || (mode === 'legacy' && legacy) || (mode === 'variant' && calls.length === 2);
        return ok ? { ok: true, finalCookies: p.cookies } : { ok: false };
      });
      const expectedCalls = { preferred: 1, legacy: 6, variant: 2, failure: 10, stopChain: 1, cas: 10, 'final-missing': 10 }[mode];
      assert.strictEqual(calls.length, expectedCalls);
      assert.strictEqual(r.ok, ['preferred', 'legacy', 'variant'].includes(mode));
      assert.ok(calls.slice(0, 5).every((s) => !legacyIds.some((id) => s === `raw-archive:${id}`)));
      assert.ok(calls.slice(5).every((s) => legacyIds.some((id) => s === `raw-archive:${id}`)));
      if (!r.ok) assert.deepStrictEqual(fs.readFileSync(f.workPath), mode === 'cas' ? concurrent : baseline);
      if (mode === 'cas') assert.ok(r.attempts.some((a) => a.conflict === true));
      assert.deepStrictEqual(f.sourceState(), before);
      assert.ok(f.reads.length <= sessionVault.MAX_VERSIONS_SCAN);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

test('D10R guard 收集：真实 vault 拒绝缺失/错误 manifest SHA，不把未核验字节交验证器', async () => {
  const f = guardSessionFixture();
  try {
    const good = f.snapshot(fullSessionCookies('B', 'valid'));
    const bad = f.snapshot(fullSessionCookies('A', 'bad-hash'));
    const missing = f.snapshot(fullSessionCookies('A', 'missing-hash'));
    const manifestPath = path.join(f.roots.archiveRoot, 'shopA', sessionVault.MANIFEST_NAME);
    const manifest = JSON.parse(fs.readFileSync(manifestPath));
    manifest.versions.find((v) => v.versionId === bad.versionId).sha256 = '0'.repeat(64);
    manifest.versions.find((v) => v.versionId === missing.versionId).sha256 = null;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    const before = f.sourceState();
    const calls = [];
    const r = await f.restore(async (p) => { calls.push(p.source); return { ok: false }; });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(calls, [`raw-archive:${good.versionId}`]);
    assert.strictEqual(r.attempts.filter((a) => a.result === 'integrity-failed').length, 2);
    assert.strictEqual(f.reads.filter((x) => x.ok).length, 1);
    assert.deepStrictEqual(f.sourceState(), before);
    assert.ok(!fs.existsSync(f.workPath));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('D10R guard 收集：1000 条同会话记录只读 vault 上限，SHA 重复不重复验证', async () => {
  const f = guardSessionFixture();
  try {
    const versions = Array.from({ length: 1000 }, (_, i) => {
      const buf = Buffer.from(JSON.stringify(fullSessionCookies('A', `variant-${Math.floor(i / 2)}`)));
      return { versionId: `v${i}`, versionPath: path.join(f.roots.archiveRoot, 'shopA', `v${i}.json`),
        buf, sha256: sha256Of(buf), origin: 'verified-login', createdAtMs: 1000000 - i };
    });
    const fake = makeFakeVault(versions);
    let reads = 0;
    const calls = [];
    const before = f.sourceState();
    const r = await f.restore(async (p) => { calls.push(sha256Of(Buffer.from(JSON.stringify(p.cookies)))); return { ok: false }; }, {
      vaultModule: { ...fake, MAX_VERSIONS_SCAN: sessionVault.MAX_VERSIONS_SCAN,
        readSnapshotVersion(p) { reads += 1; return fake.readSnapshotVersion(p); } },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(reads, sessionVault.MAX_VERSIONS_SCAN);
    assert.strictEqual(calls.length, RESTORE_MAX_CANDIDATES);
    assert.strictEqual(new Set(calls).size, calls.length);
    assert.deepStrictEqual(f.sourceState(), before);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

for (const mode of ['healthy', 'legacy', 'same-sid-legacy', 'failure', 'invalid-sha']) {
  test(`D11R guard 真实 manifest：B第61条/legacy第62条，${mode}`, async () => {
    const f = guardSessionFixture();
    try {
      const legacy = f.snapshot(fullSessionCookies(mode === 'same-sid-legacy' ? 'A' : 'C', 'legacy'), true);
      const healthy = f.snapshot(fullSessionCookies('B', 'healthy'));
      const newer = [];
      for (let i = 0; i < 60; i += 1) newer.push(f.snapshot(fullSessionCookies('A', `archive-${i}`)).versionId);
      if (mode === 'invalid-sha') {
        const manifestPath = path.join(f.roots.archiveRoot, 'shopA', sessionVault.MANIFEST_NAME);
        const manifest = JSON.parse(fs.readFileSync(manifestPath));
        manifest.versions.find((v) => v.versionId === healthy.versionId).sha256 = '0'.repeat(64);
        fs.writeFileSync(manifestPath, JSON.stringify(manifest));
      }
      const baseline = Buffer.from(JSON.stringify(fullSessionCookies('A', 'work')));
      fs.writeFileSync(f.workPath, baseline);
      fs.writeFileSync(path.join(f.roots.analyzerWorkDir, 'shopA.json'), JSON.stringify(fullSessionCookies('A', 'analysis')));
      fs.writeFileSync(path.join(f.roots.recoveryDir, 'shopA.json'), JSON.stringify(fullSessionCookies('A', 'recovery')));
      const before = f.sourceState();
      const args = { shopSafeName: 'shopA', roots: f.roots };
      const normal = sessionVault.listSnapshotVersions(args);
      assert.deepStrictEqual(normal.versions.map((v) => v.versionId), newer.slice().reverse().slice(0, 50));
      const recovery = sessionVault.listSnapshotVersions({ ...args, internalRecoveryScan: true });
      assert.strictEqual(recovery.versions.length, 62);
      assert.strictEqual(recovery.versions[60].versionId, healthy.versionId);
      assert.strictEqual(recovery.versions[61].versionId, legacy.versionId);
      const calls = [];
      const r = await f.restore(async (p) => {
        assert.deepStrictEqual(p.expectedShopNames, ['shopA']);
        calls.push(p.source);
        const ok = (mode === 'healthy' && p.source === `raw-archive:${healthy.versionId}`)
          || (['legacy', 'same-sid-legacy'].includes(mode) && p.source === `raw-archive:${legacy.versionId}`);
        return ok ? { ok: true, finalCookies: p.cookies } : { ok: false };
      });
      assert.strictEqual(r.ok, ['healthy', 'legacy', 'same-sid-legacy'].includes(mode));
      if (mode === 'healthy') {
        assert.deepStrictEqual(calls, ['guard-duty-work', `raw-archive:${healthy.versionId}`]);
        assert.strictEqual(r.source, `raw-archive:${healthy.versionId}`);
        assert.ok(calls.length <= 5);
      } else {
        assert.strictEqual(calls.length, 6);
        assert.strictEqual(calls[5], `raw-archive:${legacy.versionId}`);
        if (r.ok) assert.strictEqual(r.source, `raw-archive:${legacy.versionId}`);
        if (mode === 'invalid-sha') {
          assert.ok(!calls.includes(`raw-archive:${healthy.versionId}`));
          assert.ok(r.attempts.some((a) => a.source === `raw-archive:${healthy.versionId}` && a.result === 'integrity-failed'));
        } else assert.strictEqual(calls[1], `raw-archive:${healthy.versionId}`);
      }
      if (r.ok) {
        const expected = mode === 'healthy' ? fullSessionCookies('B', 'healthy')
          : fullSessionCookies(mode === 'same-sid-legacy' ? 'A' : 'C', 'legacy');
        assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.workPath)), expected);
      } else assert.deepStrictEqual(fs.readFileSync(f.workPath), baseline);
      assert.strictEqual(f.byteReads.length, 62);
      assert.ok(f.byteReads.includes(healthy.versionPath));
      assert.ok(f.byteReads.includes(legacy.versionPath));
      assert.ok(f.byteReads.length <= 200 && calls.length <= 10);
      assert.deepStrictEqual(f.sourceState(), before);
      assert.ok(!JSON.stringify(f.audit).includes('FAKE-'));
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

for (const mode of ['manifest', 'missing-manifest']) {
  test(`D11R guard 1001个真实归档文件：${mode}，最多200次字节读取/10次验证`, async () => {
    const f = guardSessionFixture();
    try {
      const shopDir = path.join(f.roots.archiveRoot, 'shopA');
      fs.mkdirSync(shopDir);
      const versions = [];
      for (let i = 0; i < 1001; i += 1) {
        const versionId = `v${String(1001 - i).padStart(4, '0')}`;
        const buf = Buffer.from(JSON.stringify(fullSessionCookies('A', `archive-${i}`)));
        const versionPath = path.join(shopDir, `${versionId}.json`);
        fs.writeFileSync(versionPath, buf, { flag: 'wx' });
        fs.chmodSync(versionPath, 0o444);
        versions.push({ versionId, sha256: sha256Of(buf), createdAtMs: Date.UTC(2026, 9, 28) - i,
          origin: i >= 60 && i < 65 ? 'legacy-unverified' : 'verified-login', structureValid: true });
      }
      if (mode === 'manifest') fs.writeFileSync(path.join(shopDir, sessionVault.MANIFEST_NAME), JSON.stringify({ version: 1, shop: 'shopA', versions: versions.slice().reverse() }));
      const baseline = Buffer.from(JSON.stringify(fullSessionCookies('A', 'work')));
      fs.writeFileSync(f.workPath, baseline);
      const before = f.sourceState();
      const args = { shopSafeName: 'shopA', roots: f.roots };
      const normal = sessionVault.listSnapshotVersions(args);
      const recovery = sessionVault.listSnapshotVersions({ ...args, internalRecoveryScan: true });
      assert.strictEqual(normal.versions.length, 50);
      assert.strictEqual(recovery.versions.length, 200);
      if (mode === 'manifest') {
        assert.deepStrictEqual(normal.versions.map((v) => v.versionId), versions.slice(0, 50).map((v) => v.versionId));
        assert.deepStrictEqual(recovery.versions.map((v) => v.versionId), versions.slice(0, 200).map((v) => v.versionId));
      } else assert.ok(recovery.versions.every((v) => v.sha256 === null));
      const calls = [];
      const r = await f.restore(async (p) => { calls.push(p.source); return { ok: false }; });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(f.reads.length, 200);
      assert.strictEqual(f.byteReads.length, mode === 'manifest' ? 200 : 0);
      assert.strictEqual(calls.length, mode === 'manifest' ? 10 : 1);
      if (mode === 'manifest') {
        const legacySources = versions.slice(60, 65).map((v) => `raw-archive:${v.versionId}`);
        assert.ok(calls.slice(0, 5).every((s) => !legacySources.includes(s)));
        assert.deepStrictEqual(calls.slice(5), legacySources);
      } else assert.strictEqual(r.attempts.filter((a) => a.result === 'integrity-failed').length, 200);
      assert.deepStrictEqual(fs.readFileSync(f.workPath), baseline);
      assert.deepStrictEqual(f.sourceState(), before);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  });
}

// ============ D12F：跨调用失败候选进程内存史（login-invalid 才缓存，有界，可重置） ============

function loginInvalidFor(...healthySources) {
  const calls = [];
  return {
    calls,
    verify: async (p) => {
      calls.push(p.source);
      if (healthySources.includes(p.source)) return { ok: true, finalCookies: p.cookies };
      return { ok: false, classification: 'login-invalid', reason: '合成登录失效（证明性）' };
    },
  };
}

test('D12F 跨调用进展：首轮 5 组 login-invalid，次轮可达第 6/7 组并提升；只读源全程零改动', async () => {
  const f = guardSessionFixture();
  try {
    const healthy = f.snapshot(fullSessionCookies('HEALTHY', 'old'));   // 最旧 = 第 7 组
    const newer = [];
    for (let i = 6; i >= 1; i -= 1) newer.push(f.snapshot(fullSessionCookies(`S${i}`, `v${i}`)).versionId); // 新→旧 S1..S6
    const loginCfg = { cookieSourceDir: f.roots.analyzerWorkDir };
    const before = f.sourceState();
    const r1v = loginInvalidFor();
    const r1 = await f.restore(r1v.verify, { loginCfg, excludeWorkCopy: true });
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1v.calls.length, 5, '首轮仍只验证首选 5 组（网络/进程边界不变）');
    assert.ok(r1v.calls.every((s) => newer.includes(s.slice('raw-archive:'.length))));
    const r2v = loginInvalidFor(`raw-archive:${healthy.versionId}`);
    const r2 = await f.restore(r2v.verify, { loginCfg, excludeWorkCopy: true });
    assert.strictEqual(r2.ok, true, '次轮必须跨过已失败 5 组、触达此前不可达的第 6/7 组');
    assert.strictEqual(r2.source, `raw-archive:${healthy.versionId}`);
    assert.ok(r2v.calls.length <= 5, '次轮同样不超过首选 5 条验证');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.workPath)), fullSessionCookies('HEALTHY', 'old'));
    assert.deepStrictEqual(f.sourceState(), before, '归档/恢复/分析只读源 sha 与 mtime 全程不变');
    assert.ok(!JSON.stringify(f.audit).includes('FAKE-'));
    assert.ok(!JSON.stringify(f.audit).includes('session:'));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('D12F 同 SID 变体保留：失败会话的新字节变体仍是备用，从未试过会话优先于备用', async () => {
  const f = guardSessionFixture();
  try {
    // D12F2 夹具修正：同 SID 的两个 legacy 变体必须建在**最旧**位置。若 healthy 建成最新
    // 代表，它会进入首轮 legacy 窗口被验证并记为 login-invalid，次轮再期待它成功就与
    // 精确 SHA 负缓存（不缓存错分/瞬态，但确实缓存证明性 login-invalid）矛盾。
    const legacyHealthy = f.snapshot(fullSessionCookies('P0', 'legacy-ok'), true);   // 同 SID 备用变体（最旧，次轮可达）
    const legacyFail = f.snapshot(fullSessionCookies('P0', 'legacy-fail'), true);    // 同 SID（P0）不同字节
    const failedPrefers = [];
    for (let i = 0; i < 5; i += 1) failedPrefers.push(f.snapshot(fullSessionCookies(`P${i}`, `p${i}`)));
    for (let i = 0; i < 5; i += 1) f.snapshot(fullSessionCookies(`L${i}`, `l${i}`), true);  // 占满首轮 legacy 窗口的独立会话（更新）
    const loginCfg = {};
    const r1v = loginInvalidFor();
    const r1 = await f.restore(r1v.verify, { loginCfg, excludeWorkCopy: true });
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r1v.calls.length, 10, '首轮：5 首选 + 5 legacy 独立会话（同 SID 备用变体排在其后）');
    assert.ok(!r1v.calls.includes(`raw-archive:${legacyHealthy.versionId}`), '首轮不得提前验证最旧的同 SID 备用变体');
    assert.ok(!r1v.calls.includes(`raw-archive:${legacyFail.versionId}`), '首轮 legacy 窗口被 5 个独立会话占满');
    const r2v = loginInvalidFor(`raw-archive:${legacyHealthy.versionId}`);
    const r2 = await f.restore(r2v.verify, { loginCfg, excludeWorkCopy: true });
    assert.strictEqual(r2.ok, true, '同 SID 备用变体必须仍可达且可提升（绝不因 SID 一次失败拉黑全会话）');
    assert.strictEqual(r2.source, `raw-archive:${legacyHealthy.versionId}`);
    assert.deepStrictEqual(r2v.calls, [`raw-archive:${legacyFail.versionId}`, `raw-archive:${legacyHealthy.versionId}`],
      '同 SID 已失败字节跳过，未试字节保留；且在无更新候选时作为备用被试到');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.workPath)), fullSessionCookies('P0', 'legacy-ok'));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('D12F 单 SID 多 SHA：逐轮换批字节变体，最终健康变体可达（无无限期拉黑）', async () => {
  const f = guardSessionFixture();
  try {
    const ids = [];
    for (let i = 0; i < 12; i += 1) ids.push(f.snapshot(fullSessionCookies('A', `sv-${i}`)).versionId);
    const healthyId = ids[0]; // 最早一条（ids 按新→旧为 ids[11]…ids[0]）才健康
    const loginCfg = {};
    for (let round = 1; round <= 3; round += 1) {
      const v = loginInvalidFor(`raw-archive:${healthyId}`);
      const r = await f.restore(v.verify, { loginCfg, excludeWorkCopy: true });
      if (round < 3) {
        assert.strictEqual(r.ok, false);
        assert.strictEqual(v.calls.length, 5, `第 ${round} 轮：跨调用换批后仍各只验证 5 条新 SHA`);
      } else {
        assert.strictEqual(r.ok, true, '第 3 轮必须触达最旧的健康变体并提升');
        assert.strictEqual(r.source, `raw-archive:${healthyId}`);
        assert.ok(v.calls.length <= 5);
      }
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('D12F 可用候选试尽即重置：0 新验证的一轮之后，下一轮从头重试（有界历史）', async () => {
  const f = guardSessionFixture();
  try {
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push(f.snapshot(fullSessionCookies(`R${i}`, `r${i}`)).versionId);
    const loginCfg = {};
    for (const expected of [3, 0, 3]) {
      const v = loginInvalidFor();
      const r = await f.restore(v.verify, { loginCfg, excludeWorkCopy: true });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(v.calls.length, expected, `该轮应验证 ${expected} 条（试尽后自动重置，不永久拉黑）`);
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('D12F 隔离：不同 loginCfg 对象 / 不同工作副本互不泄漏失败史', async () => {
  const f = guardSessionFixture();
  try {
    for (let i = 0; i < 3; i += 1) f.snapshot(fullSessionCookies(`X${i}`, `x${i}`));
    const sharedVerify = loginInvalidFor();
    const r1 = await f.restore(sharedVerify.verify, { loginCfg: { tag: 'cfg1' }, excludeWorkCopy: true });
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(sharedVerify.calls.length, 3);
    const freshVerify = loginInvalidFor();
    const r2 = await f.restore(freshVerify.verify, { loginCfg: { tag: 'cfg2' }, excludeWorkCopy: true });
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(freshVerify.calls.length, 3, '更换配置对象（配置所有者变化）不得继承他人失败史');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('D12F 瞬态失败不缓存：verify-error/identity-unverified/stopChain 不写入失败史', async () => {
  const f = guardSessionFixture();
  try {
    const ids = [];
    for (let i = 0; i < 3; i += 1) ids.push(f.snapshot(fullSessionCookies(`T${i}`, `t${i}`)).versionId);
    const loginCfg = {};
    const transient = [
      { ok: false, classification: 'verify-error', reason: '合成瞬态：网络/收口不确定' },
      { ok: false, classification: 'identity-unverified', reason: '合成瞬态：身份未核实' },
    ];
    let i = 0;
    const r1 = await f.restore(async (p) => transient[i++ % transient.length], { loginCfg, excludeWorkCopy: true });
    assert.strictEqual(r1.ok, false);
    const v2 = loginInvalidFor();
    const r2 = await f.restore(v2.verify, { loginCfg, excludeWorkCopy: true });
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(v2.calls.length, 3, '瞬态失败不得按 login-invalid 缓存：下一轮必须原样重试全部候选');
    // D12F2 夹具修正：r2 已把 3 条全部记为 login-invalid，同一 loginCfg 的下一轮按设计
    // 零个新候选（正确的"试尽重置"），无法观测 stopChain；故换一个全新配置对象再测。
    const stopCfg = {};
    const stopCalls = [];
    const r3 = await f.restore(async (p) => { stopCalls.push(p.source); return { ok: false, classification: 'login-invalid', stopChain: true, reason: '合成：收口未证明' }; }, { loginCfg: stopCfg, excludeWorkCopy: true });
    assert.strictEqual(r3.ok, false);
    assert.strictEqual(stopCalls.length, 1, 'stopChain 立即停链，绝不开启下一候选浏览器');
    // 收口未证明的 stopChain 也**不**入失败史（不缓存错误停机原因）：同一 cfg 下一轮
    // 必须原样重试全部候选，且不会在 stopChain 之后自行启动新候选。
    const v4 = loginInvalidFor();
    const r4 = await f.restore(v4.verify, { loginCfg: stopCfg, excludeWorkCopy: true });
    assert.strictEqual(r4.ok, false);
    assert.strictEqual(v4.calls.length, 3, 'stopChain 失败不得被缓存：下一轮从头重试全部 3 条');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('D12F 并发 CAS 冲突保留新文件：指纹变化重置历史，新候选随后照常提升', async () => {
  const f = guardSessionFixture();
  try {
    const concurrent = Buffer.from(JSON.stringify(fullSessionCookies('C', 'concurrent')));
    f.snapshot(fullSessionCookies('H1', 'h1'));
    f.snapshot(fullSessionCookies('H2', 'h2'));
    const loginCfg = {};
    const baseline = Buffer.from(JSON.stringify(fullSessionCookies('A', 'work')));
    fs.writeFileSync(f.workPath, baseline);
    const before = f.sourceState();
    let injected = false;
    const r1 = await f.restore(async (p) => {
      if (!injected) { injected = true; fs.writeFileSync(f.workPath, concurrent); } // 首候选验证成功瞬间并发新扫码
      return { ok: true, finalCookies: p.cookies };
    }, { loginCfg });
    assert.strictEqual(r1.ok, false, '首轮验证成功但 CAS 冲突：绝不覆盖并发新扫码文件');
    assert.ok(r1.attempts.some((a) => a.conflict === true));
    assert.deepStrictEqual(fs.readFileSync(f.workPath), concurrent, '并发新文件必须原样保留');
    const v2calls = [];
    const r2 = await f.restore(async (p) => { v2calls.push(p.source); return { ok: true, finalCookies: p.cookies }; }, { loginCfg });
    assert.strictEqual(r2.ok, true, '指纹已变化 → 历史重置，新候选照常可验证提升');
    assert.ok(v2calls.length >= 1);
    assert.deepStrictEqual(f.sourceState(), before);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// ============ D12F2：失败史上限必须覆盖一次完整有界候选遍历 ============
// 单轮候选 SHA 上界 = 上游 6（工作 1 + 分析 1 + 恢复固定 1 + 恢复版本 3）+ 有界归档 200 = 206。
// 上限 64 会在第 65 个失败处整史清空，使更旧候选永不可达；下列两条用真实 vault/真实模块证明
// 完整遍历内历史不提前重置（每轮仍只验证 ≤5 条，网络/进程边界不变，无新增无界状态）。

test('D12F2 真实 87 版本同 SID：24 次有界调用内触达并提升最旧健康变体，只读源零改动', async () => {
  const f = guardSessionFixture();
  try {
    const ids = [];
    for (let i = 0; i < 87; i += 1) ids.push(f.snapshot(fullSessionCookies('A', `scale-${i}`)).versionId);
    const healthyId = ids[0];  // 最旧一条才健康；其余 86 条更新的同 SID 变体全部失效
    const workBuf = Buffer.from(JSON.stringify(fullSessionCookies('A', 'work')));
    fs.writeFileSync(f.workPath, workBuf);  // 工作副本全程不变 → 指纹稳定，失败史跨调用延续
    const loginCfg = { cookieSourceDir: f.roots.analyzerWorkDir };  // 同一稳定配置对象贯穿全部调用
    const before = f.sourceState();
    const seen = new Set();
    let promoted = null;
    let rounds = 0;
    for (let round = 1; round <= 24 && promoted === null; round += 1) {
      rounds = round;
      const v = loginInvalidFor(`raw-archive:${healthyId}`);
      const r = await f.restore(v.verify, { loginCfg });
      assert.ok(v.calls.length <= RESTORE_MAX_CANDIDATES, `第 ${round} 轮首选窗口须 <= 5: ${v.calls.length}`);
      for (const s of v.calls) {
        assert.ok(!seen.has(s), `第 ${round} 轮重复验证已失败字节（历史被提前重置）: ${s}`);
        seen.add(s);
      }
      if (r.ok) promoted = r;
      else assert.deepStrictEqual(fs.readFileSync(f.workPath), workBuf, '未提升前工作副本字节不得变化');
    }
    assert.ok(promoted, `24 次有界调用内必须触达最旧健康变体（实际 ${rounds} 轮）`);
    assert.strictEqual(promoted.source, `raw-archive:${healthyId}`);
    assert.ok(rounds <= 24, `调用轮数必须有界: ${rounds}`);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.workPath)), fullSessionCookies('A', 'scale-0'));
    assert.deepStrictEqual(f.sourceState(), before, '归档/恢复/分析只读源 sha 与 mtime 全程不变');
    assert.ok(!JSON.stringify(f.audit).includes('FAKE-'));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('D12F2 有界上界 206（200 归档 + 6 上游角色）：完整遍历不被提前重置，最终提升最旧健康变体', async () => {
  const f = guardSessionFixture();
  try {
    const ids = [];
    for (let i = 0; i < 200; i += 1) ids.push(f.snapshot(fullSessionCookies('A', `bulk-${i}`)).versionId);
    const healthyId = ids[0];  // 第 206 个候选（最旧），只有它能通过验证
    fs.writeFileSync(f.workPath, JSON.stringify(fullSessionCookies('A', 'work')));
    fs.writeFileSync(path.join(f.roots.analyzerWorkDir, 'shopA.json'), JSON.stringify(fullSessionCookies('A', 'analysis')));
    fs.writeFileSync(path.join(f.roots.recoveryDir, 'shopA.json'), JSON.stringify(fullSessionCookies('A', 'recovery')));
    const vdir = path.join(f.roots.recoveryDir, 'shopA');
    fs.mkdirSync(vdir);
    for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(vdir, `v${i}.json`), JSON.stringify(fullSessionCookies('A', `recovery-${i}`)));
    const loginCfg = { cookieSourceDir: f.roots.analyzerWorkDir };
    const before = f.sourceState();
    const seen = new Set();
    let promoted = null;
    let rounds = 0;
    for (let round = 1; round <= 45 && promoted === null; round += 1) {
      rounds = round;
      const v = loginInvalidFor(`raw-archive:${healthyId}`);
      const r = await f.restore(v.verify, { loginCfg });
      assert.ok(v.calls.length <= RESTORE_MAX_CANDIDATES, `每轮 <= 5 首选（本夹具无 legacy 窗口）: ${v.calls.length}`);
      for (const s of v.calls) {
        assert.ok(!seen.has(s), `第 ${round} 轮重复验证已失败字节（历史被提前重置）: ${s}`);
        seen.add(s);
      }
      if (r.ok) promoted = r;
    }
    assert.ok(promoted, `206 个候选的有界遍历必须能走完（实际 ${rounds} 轮）`);
    assert.strictEqual(promoted.source, `raw-archive:${healthyId}`);
    assert.strictEqual(seen.size, 206, '失败史须覆盖全部 206 个候选 SHA，一次遍历内不提前重置');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.workPath)), fullSessionCookies('A', 'bulk-0'));
    assert.deepStrictEqual(f.sourceState(), before, '归档/恢复/分析只读源 sha 与 mtime 全程不变');
    assert.ok(f.reads.length <= 200 * rounds, '归档字节读取次数不超过每轮 200 次的有界扫描');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

// ============ D13R：同店同工作副本在飞恢复去重（生产真实证据：同一 8 候选被验证两次） ============
// 2026-10-28 生产只读证据：普通只读刷新 09:25:34 起、日常广告读取 09:25:41 起、cookie-restore-ranking
// 于 09:26:23.859 与 09:26:41.264 选出**完全相同**的 8 个候选来源与 SHA，其间没有任何已完成恢复：
// 同一店铺/同一工作副本/同一 login 配置的并发恢复把同一份已保存候选验证了两遍（重复 SSO、重复耗时）。
// 下列测试只用合成 verify/工厂（无真实浏览器、无网络），验证去重只作用于**同一目标**。

function overlapWorkDir(tmpRoot) {
  const workDir = path.join(tmpRoot, 'work');
  fs.mkdirSync(workDir, { recursive: true });
  return workDir;
}

function overlapOpts(tmpRoot, verify, extra = {}) {
  return {
    shopCfg: { name: 'shopA' },
    workDir: path.join(tmpRoot, 'work'),
    recoveryDir: path.join(tmpRoot, 'recovery-absent'),
    vaultModule: makeFakeVault([]),
    verify,
    nowFn: () => Date.UTC(2026, 9, 28, 2, 0, 0),
    ...extra,
  };
}

test('D13R 在飞去重：同 cfg+同工作副本+同店名并发 → 只一条验证链，第二个调用复用同一结果', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-overlap-'));
  try {
    const workPath = path.join(overlapWorkDir(tmpRoot), 'shopA.json');
    const baseline = Buffer.from(JSON.stringify(fullSessionCookies('A', 'work')));
    fs.writeFileSync(workPath, baseline);
    const loginCfg = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    const calls = [];
    const verify = async (p) => { calls.push(p.source); await gate; return { ok: true, finalCookies: p.cookies }; };
    const p1 = restoreDutyWorkCopy(loginCfg, 'shopA.json', overlapOpts(tmpRoot, verify));
    const p2 = restoreDutyWorkCopy(loginCfg, 'shopA.json', overlapOpts(tmpRoot, verify));
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(calls.length, 1, '同一目标的并发恢复只允许一次验证（绝不重复 SSO）');
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.joinedInflight, true, '第二个调用必须复用首个结果，而不是另起验证链');
    assert.strictEqual(r1.sourceSha256, r2.sourceSha256);
    assert.strictEqual(r1.targetSha256, r2.targetSha256);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(workPath)), fullSessionCookies('A', 'work'));
    // 结算后条目必须按身份 CAS 删除：后续调用重新走自己的验证链（无永久锁、无无界 Map）
    const later = [];
    const r3 = await restoreDutyWorkCopy(loginCfg, 'shopA.json', overlapOpts(tmpRoot, async (p) => {
      later.push(p.source); return { ok: true, finalCookies: p.cookies };
    }));
    assert.strictEqual(r3.ok, true);
    assert.strictEqual(later.length, 1, '已结算的在飞条目不得残留成永久锁');
    assert.strictEqual(r3.joinedInflight, undefined);
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('D13R 在飞去重：首个 stopChain → 第二个调用不自行验证、不启动下一候选', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-overlap-'));
  try {
    overlapWorkDir(tmpRoot);
    const loginCfg = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    const calls = [];
    const verify = async (p) => {
      calls.push(p.source); await gate;
      return { ok: false, classification: 'verify-error', stopChain: true, reason: '合成：候选进程收口未获证明' };
    };
    const versions = [makeArchiveVersion('a1', 'verified-login', 1), makeArchiveVersion('a2', 'verified-login', 2)];
    const p1 = restoreDutyWorkCopy(loginCfg, 'shopA.json', overlapOpts(tmpRoot, verify, { vaultModule: makeFakeVault(versions) }));
    const p2 = restoreDutyWorkCopy(loginCfg, 'shopA.json', overlapOpts(tmpRoot, verify, { vaultModule: makeFakeVault(versions) }));
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(calls.length, 1, 'stopChain 之后第二个调用绝不得自行验证或启动下一候选');
    assert.strictEqual(r1.ok, false);
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.joinedInflight, true);
    assert.ok(r1.attempts.some((a) => a.stopChain === true));
    assert.ok(r2.attempts.some((a) => a.stopChain === true));
    assert.ok(!fs.existsSync(path.join(tmpRoot, 'work', 'shopA.json')), '停止链绝不提升');
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('D13R 在飞去重不改变异常语义：验证器抛错仍 verify-error，结算后条目释放可重试', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-overlap-'));
  try {
    const workPath = path.join(overlapWorkDir(tmpRoot), 'shopA.json');
    fs.writeFileSync(workPath, JSON.stringify(fullSessionCookies('A', 'work')));
    const loginCfg = {};
    const r1 = await restoreDutyWorkCopy(loginCfg, 'shopA.json', overlapOpts(tmpRoot, async () => {
      throw new Error('合成验证器异常');
    }));
    assert.strictEqual(r1.ok, false);
    const att = r1.attempts.find((a) => a.result === 'verify-failed');
    assert.ok(att, '验证器异常必须如实记为 verify-failed');
    assert.strictEqual(att.classification, undefined);
    assert.strictEqual(att.stopChain, undefined, '普通验证器异常不擅自停链（既有语义不变）');
    assert.ok(att.reason.includes('验证器异常'));
    // 外层失败结算后条目必须释放：后续调用仍能正常验证并提升（不是永久锁）
    const r2 = await restoreDutyWorkCopy(loginCfg, 'shopA.json', overlapOpts(tmpRoot, async (p) => ({ ok: true, finalCookies: p.cookies })));
    assert.strictEqual(r2.ok, true, '失败结算后同一目标必须可重新恢复');
    assert.strictEqual(r2.joinedInflight, undefined);
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('D13R 在飞去重不覆盖并发新扫码：在飞期间工作副本被更新 → 两调用均得冲突结果，新文件保留', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-overlap-'));
  try {
    const workPath = path.join(overlapWorkDir(tmpRoot), 'shopA.json');
    const baseline = Buffer.from(JSON.stringify(fullSessionCookies('A', 'work')));
    const concurrent = Buffer.from(JSON.stringify(fullSessionCookies('C', 'concurrent')));
    fs.writeFileSync(workPath, baseline);
    const loginCfg = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    const calls = [];
    const verify = async (p) => {
      calls.push(p.source);
      fs.writeFileSync(workPath, concurrent); // 首个候选验证期间并发新扫码写入
      await gate;
      return { ok: true, finalCookies: p.cookies };
    };
    const p1 = restoreDutyWorkCopy(loginCfg, 'shopA.json', overlapOpts(tmpRoot, verify));
    const p2 = restoreDutyWorkCopy(loginCfg, 'shopA.json', overlapOpts(tmpRoot, verify));
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(r1.ok, false, 'CAS 冲突绝不覆盖并发新文件');
    assert.ok(r1.attempts.some((a) => a.conflict === true));
    assert.strictEqual(r2.ok, false, 'join 者拿到的是首个调用者的真实 CAS 判定，绝不提升过期字节');
    assert.strictEqual(r2.joinedInflight, true);
    assert.deepStrictEqual(fs.readFileSync(workPath), concurrent, '并发新扫码文件必须原样保留');
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('D13R 在飞去重按店铺/路径隔离：同 cfg 两店并发各自验证提升，绝不串结果', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-overlap-'));
  try {
    const workA = path.join(tmpRoot, 'workA');
    const workB = path.join(tmpRoot, 'workB');
    fs.mkdirSync(workA); fs.mkdirSync(workB);
    fs.writeFileSync(path.join(workA, 'shopA.json'), JSON.stringify(fullSessionCookies('A', 'work')));
    fs.writeFileSync(path.join(workB, 'shopB.json'), JSON.stringify(fullSessionCookies('B', 'work')));
    const loginCfg = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    const calls = [];
    const verify = async (p) => { calls.push(p.source); await gate; return { ok: true, finalCookies: p.cookies }; };
    const pA = restoreDutyWorkCopy(loginCfg, 'shopA.json', {
      shopCfg: { name: 'shopA' }, workDir: workA, recoveryDir: path.join(tmpRoot, 'recovery-absent'),
      vaultModule: makeFakeVault([]), verify, nowFn: () => Date.UTC(2026, 9, 28, 2, 0, 0),
    });
    const pB = restoreDutyWorkCopy(loginCfg, 'shopB.json', {
      shopCfg: { name: 'shopB' }, workDir: workB, recoveryDir: path.join(tmpRoot, 'recovery-absent'),
      vaultModule: makeFakeVault([]), verify, nowFn: () => Date.UTC(2026, 9, 28, 2, 0, 0),
    });
    release();
    const [rA, rB] = await Promise.all([pA, pB]);
    assert.strictEqual(calls.length, 2, '不同店铺必须各自验证，绝不全局串行/共享结论');
    assert.strictEqual(rA.ok, true);
    assert.strictEqual(rB.ok, true);
    assert.strictEqual(rA.joinedInflight, undefined);
    assert.strictEqual(rB.joinedInflight, undefined);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(workA, 'shopA.json'))), fullSessionCookies('A', 'work'));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(workB, 'shopB.json'))), fullSessionCookies('B', 'work'));
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('D13R 在飞去重按预期店名契约隔离：同路径不同店名 → 错误契约绝不继承成功结果', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-overlap-'));
  try {
    const workPath = path.join(overlapWorkDir(tmpRoot), 'shopA.json');
    fs.writeFileSync(workPath, JSON.stringify(fullSessionCookies('A', 'work')));
    const loginCfg = {};
    let release;
    const gate = new Promise((r) => { release = r; });
    const calls = [];
    const verify = async (p) => {
      calls.push(p.expectedShopNames.join(','));
      await gate;
      return p.expectedShopNames.includes('shopA')
        ? { ok: true, finalCookies: p.cookies }
        : { ok: false, reason: '合成：店名契约不匹配' };
    };
    const p1 = restoreDutyWorkCopy(loginCfg, 'shopA.json', overlapOpts(tmpRoot, verify));
    const p2 = restoreDutyWorkCopy(loginCfg, 'shopA.json', overlapOpts(tmpRoot, verify, { shopCfg: { name: 'shopB' } }));
    release();
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(calls.length, 2, '店名契约不同必须各自验证，绝不共享同一条链');
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r2.ok, false, '显式错误店名契约即便同路径也绝不继承他人成功结果');
    assert.strictEqual(r2.joinedInflight, undefined);
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

// ============ D13R：默认验证器把"自有候选被取消"从"平台登录无效"里分离 ============
// 合成 page/context/browser：只驱动真实 createDefaultCandidateVerifier 分支，无 Playwright、无网络。

const FXG_HOME_URL_FOR_TEST = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const FXG_LOGIN_URL_FOR_TEST = 'https://fxg.jinritemai.com/login/common';

function makeVerifierPage({ currentUrl, loginUrl = FXG_LOGIN_URL_FOR_TEST, probe = null }) {
  const page = {
    closed: false,
    async goto() {},
    url() { return page.closed ? loginUrl : currentUrl; },
    isClosed() { return page.closed === true; },
    async evaluate() { return probe; },
    async waitForLoadState() {},
    async waitForTimeout() {},
    async title() { return ''; },
    on() {}, off() {}, once() {},
  };
  // D13T 夹具修正（仅测试夹具，不动生产源码）：绝不返回 Proxy 或为未知键编造方法。
  // 旧夹具的 Proxy 对任意字符串键都返回 no-op 函数，**包括 `then`**；于是 page 变成
  // thenable：ctx.newPage() 是 async 函数，其返回值被 Promise 同化时会调用 page.then(
  // resolve, reject)，而伪造的 no-op 永不调用 resolve → `await ctx.newPage()` 永久挂起，
  // 业务逻辑一行都没执行（挂起发生在 goto/收敛/身份分类之前）。真实 Playwright Page
  // 不是 thenable。故只暴露验证分支实际使用的方法（goto/url/isClosed/evaluate 及等待类），
  // 并显式断言 page 不是 thenable。
  assert.strictEqual(
    typeof page.then, 'undefined',
    '合成 page 必须是普通对象（非 thenable）：否则 await ctx.newPage() 被 Promise 同化后永久挂起',
  );
  return page;
}

function makeVerifierBrowser(page, cookieList) {
  const ctx = {
    closedCount: 0,
    added: null,
    async addCookies(c) { ctx.added = c; },
    async newPage() { return page; },
    async cookies() { return cookieList.slice(); },
    async close() { ctx.closedCount += 1; },
  };
  const browser = {
    ctx, closedCount: 0, connected: true,
    async newContext() { return ctx; },
    async close() { browser.closedCount += 1; browser.connected = false; },
    isConnected() { return browser.connected === true; },
  };
  return { browser, ctx };
}

test('D13R 默认验证器：候选页在等待期被关闭（URL 仍为登录页）→ verify-error+stopChain，不判登录失效、不提升、不写负缓存', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-overlap-'));
  try {
    const workPath = path.join(overlapWorkDir(tmpRoot), 'shopA.json');
    const baseline = Buffer.from(JSON.stringify(fullSessionCookies('A', 'work')));
    fs.writeFileSync(workPath, baseline);
    const loginCfg = {};
    const page = makeVerifierPage({ currentUrl: FXG_HOME_URL_FOR_TEST });
    const { browser, ctx } = makeVerifierBrowser(page, JSON.parse(baseline.toString('utf8')));
    let sleeps = 0;
    const r = await restoreDutyWorkCopy(loginCfg, 'shopA.json', overlapOpts(tmpRoot, undefined, {
      candidateBrowserFactory: async () => browser,
      verifySettleTimeoutMs: 200, verifySettleIntervalMs: 5, verifyMaxWaitMs: 600000,
      verifySleep: async () => { sleeps += 1; if (sleeps >= 3) page.closed = true; },
    }));
    assert.strictEqual(r.ok, false);
    const att = r.attempts.find((a) => a.result === 'verify-failed');
    assert.ok(att, '必须以 verify-failed 记录');
    assert.strictEqual(att.classification, 'verify-error', '自有候选被取消绝不归类 login-invalid');
    assert.strictEqual(att.stopChain, true, '自有候选取消必须停链（不再启动下一候选）');
    assert.strictEqual(browser.closedCount, 1, '自有浏览器必须且只能关闭一次');
    assert.strictEqual(ctx.closedCount, 1, '自有 context 必须关闭');
    assert.deepStrictEqual(fs.readFileSync(workPath), baseline, '取消绝不提升');
    // 不写负缓存：同一 cfg 的下一轮仍重新验证同一候选（而不是 skipped-history-sha）
    const later = [];
    const r2 = await restoreDutyWorkCopy(loginCfg, 'shopA.json', overlapOpts(tmpRoot, async (p) => {
      later.push(p.source); return { ok: true, finalCookies: p.cookies };
    }));
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(later.length, 1, '取消原因不得进入 login-invalid 负缓存');
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('D13R 默认验证器：自有浏览器断开 → verify-error+stopChain，不判登录失效', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-overlap-'));
  try {
    const workPath = path.join(overlapWorkDir(tmpRoot), 'shopA.json');
    const baseline = Buffer.from(JSON.stringify(fullSessionCookies('A', 'work')));
    fs.writeFileSync(workPath, baseline);
    const page = makeVerifierPage({ currentUrl: FXG_HOME_URL_FOR_TEST });
    const { browser } = makeVerifierBrowser(page, JSON.parse(baseline.toString('utf8')));
    let sleeps = 0;
    const r = await restoreDutyWorkCopy({}, 'shopA.json', overlapOpts(tmpRoot, undefined, {
      candidateBrowserFactory: async () => browser,
      verifySettleTimeoutMs: 200, verifySettleIntervalMs: 5, verifyMaxWaitMs: 600000,
      verifySleep: async () => { sleeps += 1; if (sleeps >= 3) browser.connected = false; },
    }));
    assert.strictEqual(r.ok, false);
    const att = r.attempts.find((a) => a.result === 'verify-failed');
    assert.strictEqual(att.classification, 'verify-error');
    assert.strictEqual(att.stopChain, true);
    assert.strictEqual(browser.closedCount, 1);
    assert.deepStrictEqual(fs.readFileSync(workPath), baseline);
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

test('D13R 默认验证器：登录页在完整等待后仍打开 → 仍如实判 login-invalid（不误当取消）', async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-overlap-'));
  try {
    const workPath = path.join(overlapWorkDir(tmpRoot), 'shopA.json');
    const baseline = Buffer.from(JSON.stringify(fullSessionCookies('A', 'work')));
    fs.writeFileSync(workPath, baseline);
    const page = makeVerifierPage({ currentUrl: FXG_LOGIN_URL_FOR_TEST });
    const { browser } = makeVerifierBrowser(page, JSON.parse(baseline.toString('utf8')));
    const r = await restoreDutyWorkCopy({}, 'shopA.json', overlapOpts(tmpRoot, undefined, {
      candidateBrowserFactory: async () => browser,
      verifySettleTimeoutMs: 30, verifySettleIntervalMs: 5, verifyMaxWaitMs: 20,
      verifySleep: async () => {},
    }));
    assert.strictEqual(r.ok, false);
    const att = r.attempts.find((a) => a.result === 'verify-failed');
    assert.strictEqual(att.classification, 'login-invalid', '登录页始终打开仍是真实登录失效证据');
    assert.strictEqual(att.stopChain, undefined, '真实登录失效不擅自停链');
    assert.strictEqual(browser.closedCount, 1);
    assert.deepStrictEqual(fs.readFileSync(workPath), baseline);
  } finally { fs.rmSync(tmpRoot, { recursive: true, force: true }); }
});

// ============ D14：既有值守工作备份（.prev-*）只读恢复层（真实 restore + 真实临时文件） ============
// 只测既有受管后缀：数字时间戳（backupGuardWorkFile 现行格式）与紧凑 UTC（历史保留文件）。
// 全部使用合成 Cookie/注入 verify：无真实浏览器、无网络、无生产文件。

function backupSuffixFor(index, format) {
  const hex = (0xa1b2c3 + index).toString(16);
  if (format === 'compact') {
    const d = new Date(Date.UTC(2026, 9, 26, 16, 9, 7) - index * 60000);
    const p = (n) => String(n).padStart(2, '0');
    return `.prev-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z-${hex}`;
  }
  return `.prev-${Date.UTC(2026, 9, 26, 16, 9, 7) - index * 60000}-${hex}`;
}

function writeWorkBackup(f, fileName, cookies, mtimeSec) {
  const p = path.join(f.roots.guardWorkDir, fileName);
  fs.writeFileSync(p, JSON.stringify(cookies));
  if (mtimeSec !== undefined) fs.utimesSync(p, mtimeSec, mtimeSec);
  return p;
}

function backupFilesState(f, onlyNames = null) {
  const names = onlyNames || fs.readdirSync(f.roots.guardWorkDir).filter((n) => n !== 'shopA.json').sort();
  return names.map((name) => {
    const p = path.join(f.roots.guardWorkDir, name);
    const st = fs.lstatSync(p);
    return [name, st.isFile() ? sha256Of(fs.readFileSync(p)) : 'non-file', st.mtimeMs];
  });
}

test('D14 恢复：分析/恢复层失效后，既有工作备份在首选 5 条内可达且只提升 finalCookies', async () => {
  const f = guardSessionFixture();
  try {
    const healthySrc = fullSessionCookies('H', 'healthy');
    const healthyFinal = fullSessionCookies('H', 'healthy-final');
    const workBaseline = Buffer.from(JSON.stringify(fullSessionCookies('A', 'work')));
    fs.writeFileSync(f.workPath, workBaseline);
    // 新鲜的“分析来源/恢复副本”为不同 SID 的失效字节：它们先试且失败，但不得挤掉备份层
    fs.writeFileSync(path.join(f.roots.analyzerWorkDir, 'shopA.json'), JSON.stringify(fullSessionCookies('P', 'analysis')));
    fs.writeFileSync(path.join(f.roots.recoveryDir, 'shopA.json'), JSON.stringify(fullSessionCookies('Q', 'recovery')));
    const baseSec = Math.floor(Date.UTC(2026, 9, 27, 12, 0, 0) / 1000);
    const badNames = [];
    for (let i = 0; i < 12; i += 1) {
      const fileName = `shopA.json${backupSuffixFor(i, i % 2 === 0 ? 'numeric' : 'compact')}`;
      badNames.push(fileName);
      writeWorkBackup(f, fileName, fullSessionCookies('A', `bad-${i}`), baseSec - i * 60);
    }
    const healthyName = `shopA.json${backupSuffixFor(12, 'compact')}`; // 第 13 新（最旧）
    writeWorkBackup(f, healthyName, healthySrc, baseSec - 12 * 60);
    const names = [...badNames, healthyName];
    const beforeBackups = backupFilesState(f, names);
    const beforeSources = f.sourceState();
    const audit = [];
    const calls = [];
    const r = await f.restore(async (p) => {
      calls.push(p.source);
      if (JSON.stringify(p.cookies) !== JSON.stringify(healthySrc)) {
        return { ok: false, classification: 'login-invalid', reason: '合成失效' };
      }
      return { ok: true, finalCookies: healthyFinal };
    }, { excludeWorkCopy: true, audit: (e) => audit.push(e) });
    assert.strictEqual(r.ok, true);
    assert.ok(calls.length <= RESTORE_MAX_CANDIDATES, `健康备份必须在首选 5 条内可达：${calls.length}`);
    assert.ok(String(r.source).startsWith('guard-work-backup:shopA.json.prev-'), `来源须为工作备份层: ${r.source}`);
    assert.ok(String(r.source).endsWith(healthyName.slice('shopA.json'.length)));
    // 提升的是验证 context 的 finalCookies，而非备份原始字节
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.workPath)), healthyFinal);
    assert.notDeepStrictEqual(JSON.parse(fs.readFileSync(f.workPath)), healthySrc);
    // 2RO 源与全部既有备份字节/mtime 不变
    assert.deepStrictEqual(f.sourceState(), beforeSources);
    assert.deepStrictEqual(backupFilesState(f, names), beforeBackups);
    // 两种受管后缀均被枚举（数字 + 紧凑），审计只含文件名/短 SHA
    const rankingAudit = JSON.stringify(audit.filter((e) => e.kind === 'cookie-restore-ranking'));
    assert.ok(/shopA\.json\.prev-\d{13}-[0-9a-f]{6}/.test(rankingAudit), '数字时间戳受管后缀必须被枚举');
    assert.ok(/shopA\.json\.prev-\d{8}T\d{6}Z-[0-9a-f]{6}/.test(rankingAudit), '紧凑 UTC 受管后缀必须被枚举');
    assert.ok(!JSON.stringify(audit).includes('FAKE-'));
    assert.ok(!JSON.stringify(audit).includes('session:'));
    assert.ok(!JSON.stringify(r.attempts).includes('COOKIE_EXPIRED'));
    assert.ok(!JSON.stringify(audit).includes('COOKIE_EXPIRED'));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('D14 收集：符号链接/目录/异店/畸形名一律忽略且绝不验证', async () => {
  const f = guardSessionFixture();
  try {
    const healthySrc = fullSessionCookies('H', 'healthy');
    const outside = path.join(f.root, 'outside-healthy.json');
    fs.writeFileSync(outside, JSON.stringify(healthySrc));
    fs.writeFileSync(f.workPath, JSON.stringify(fullSessionCookies('A', 'work')));

    const linkName = `shopA.json${backupSuffixFor(0, 'numeric')}`;
    let symlinkMade = false;
    try { fs.symlinkSync(outside, path.join(f.roots.guardWorkDir, linkName), 'file'); symlinkMade = true; } catch (_) { symlinkMade = false; }
    const dirName = `shopA.json${backupSuffixFor(1, 'compact')}`;
    fs.mkdirSync(path.join(f.roots.guardWorkDir, dirName));
    const malformed = [
      'shopA.json.prev-123-abcdef',
      'shopA.json.prev-20261026T160907Z-ABCDEF',
      'shopA.json.prev-20261026T160907Z-a1b2c',
      'shopA.json.prev-20261026T160907Z-a1b2c3.bak',
      'shopA.json.bak',
      'shopA-old.json.prev-1793030947000-a1b2c3',
    ];
    writeWorkBackup(f, `shopB.json${backupSuffixFor(2, 'numeric')}`, healthySrc, 2000000000);
    for (const name of malformed) writeWorkBackup(f, name, healthySrc, 2000000000);

    const names = fs.readdirSync(f.roots.guardWorkDir).filter((n) => n !== 'shopA.json');
    const before = backupFilesState(f, names);
    const outsideBefore = sha256Of(fs.readFileSync(outside));
    const calls = [];
    const r = await f.restore(async (p) => { calls.push(p.source); return { ok: true, finalCookies: p.cookies }; }, { excludeWorkCopy: true, loginCfg: {} });
    assert.strictEqual(r.ok, false, '非法名字不得成为候选，也不得被提升');
    assert.strictEqual(calls.length, 0, '符号链接/目录/异店/畸形名绝不进入验证器');
    assert.deepStrictEqual(backupFilesState(f, names), before);
    assert.strictEqual(sha256Of(fs.readFileSync(outside)), outsideBefore);
    if (symlinkMade) assert.strictEqual(fs.lstatSync(path.join(f.roots.guardWorkDir, linkName)).isSymbolicLink(), true);
    assert.ok(!fs.existsSync(path.join(f.roots.guardWorkDir, 'shopA.json.prev-1793030947000-a1b2c3')), '不得写出新文件');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('D14 有界：1000 个备份仅 40 次字节捕获，SHA 重复不占首选名额', async () => {
  const f = guardSessionFixture();
  try {
    const baseSec = Math.floor(Date.UTC(2026, 9, 27, 12, 0, 0) / 1000);
    const names = [];
    for (let i = 0; i < 1000; i += 1) {
      const fileName = `shopA.json${backupSuffixFor(i, i % 2 === 0 ? 'numeric' : 'compact')}`;
      names.push(fileName);
      // 最新 10 个字节完全相同（同一 SHA）：不得因此多占首选名额
      const cookies = i < 10 ? fullSessionCookies('A', 'duplicate') : fullSessionCookies('A', `bulk-${i}`);
      writeWorkBackup(f, fileName, cookies, baseSec - i);
    }
    let backupByteReads = 0;
    const origRead = f.fsm.readFileSync;
    f.fsm.readFileSync = (p, ...args) => {
      if (String(p).startsWith(f.workPath + '.prev-')) backupByteReads += 1;
      return origRead.call(f.fsm, p, ...args);
    };
    const calls = [];
    const r = await f.restore(async (p) => {
      calls.push(JSON.stringify(p.cookies));
      return { ok: false, classification: 'login-invalid', reason: '合成失效' };
    }, { excludeWorkCopy: true, loginCfg: {} });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(backupByteReads, 40, '1000 个备份元数据只允许 40 次字节捕获');
    assert.strictEqual(calls.length, RESTORE_MAX_CANDIDATES, '每轮仍只验证首选 5 条');
    assert.strictEqual(new Set(calls).size, calls.length, 'SHA 重复不得重复验证/占名额');
    assert.ok(!JSON.stringify(r.attempts).includes('COOKIE_EXPIRED'));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('D14 上限不变：40 工作备份与归档 200 读取/首选5+回退5 并存时各守边界', async () => {
  const f = guardSessionFixture();
  try {
    const baseSec = Math.floor(Date.UTC(2026, 9, 27, 12, 0, 0) / 1000);
    for (let i = 0; i < 40; i += 1) {
      writeWorkBackup(f, `shopA.json${backupSuffixFor(i, i % 2 === 0 ? 'numeric' : 'compact')}`, fullSessionCookies('A', `bk-${i}`), baseSec - i);
    }
    const versions = [];
    for (let i = 0; i < 195; i += 1) {
      const buf = Buffer.from(JSON.stringify(fullSessionCookies(`NL${i}`, `nl-${i}`)));
      versions.push({ versionId: `nl${i}`, versionPath: path.join(f.roots.archiveRoot, 'shopA', `nl${i}.json`), buf, sha256: sha256Of(buf), origin: 'verified-login', createdAtMs: 5000 - i });
    }
    for (let i = 0; i < 5; i += 1) {
      const buf = Buffer.from(JSON.stringify(fullSessionCookies(`LG${i}`, `lg-${i}`)));
      versions.push({ versionId: `lg${i}`, versionPath: path.join(f.roots.archiveRoot, 'shopA', `lg${i}.json`), buf, sha256: sha256Of(buf), origin: 'legacy-unverified', createdAtMs: 100 - i });
    }
    const fake = makeFakeVault(versions);
    let archiveReads = 0;
    const calls = [];
    const r = await f.restore(async (p) => { calls.push(p.source); return { ok: false, classification: 'login-invalid', reason: '合成失效' }; }, {
      excludeWorkCopy: true, loginCfg: {},
      vaultModule: {
        ...fake, MAX_RECOVERY_VERSIONS_SCAN: 200,
        readSnapshotVersion(p) { archiveReads += 1; return fake.readSnapshotVersion(p); },
      },
    });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(archiveReads, 200, '归档层读取上界仍为 200（不因新增备份层抬高）');
    assert.strictEqual(calls.length, 10, '首选 5 + 回退 5 的网络/进程边界不变');
    const legacyCalls = calls.slice(5);
    assert.ok(calls.slice(0, 5).every((s) => !s.startsWith('raw-archive:lg')));
    assert.ok(legacyCalls.every((s) => s.startsWith('raw-archive:lg')));
    assert.ok(calls.some((s) => s.startsWith('guard-work-backup:')));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('D14 全部失效与并发 CAS：2RO 与全部备份字节不变，工作副本只保留并发新文件', async () => {
  const f = guardSessionFixture();
  try {
    const baseline = Buffer.from(JSON.stringify(fullSessionCookies('A', 'work')));
    const concurrent = Buffer.from(JSON.stringify(fullSessionCookies('C', 'concurrent')));
    fs.writeFileSync(f.workPath, baseline);
    fs.writeFileSync(path.join(f.roots.analyzerWorkDir, 'shopA.json'), JSON.stringify(fullSessionCookies('A', 'analysis')));
    fs.writeFileSync(path.join(f.roots.recoveryDir, 'shopA.json'), JSON.stringify(fullSessionCookies('A', 'recovery')));
    const names = [];
    for (let i = 0; i < 3; i += 1) {
      names.push(`shopA.json${backupSuffixFor(i, i % 2 === 0 ? 'numeric' : 'compact')}`);
      writeWorkBackup(f, names[i], fullSessionCookies('A', `fail-${i}`), 1999999000 + i);
    }
    const beforeBackups = backupFilesState(f, names);
    const beforeSources = f.sourceState();

    const r1 = await f.restore(async () => ({ ok: false, classification: 'login-invalid', reason: '合成失效' }), { excludeWorkCopy: true, loginCfg: {} });
    assert.strictEqual(r1.ok, false);
    assert.deepStrictEqual(fs.readFileSync(f.workPath), baseline);
    assert.deepStrictEqual(f.sourceState(), beforeSources);
    assert.deepStrictEqual(backupFilesState(f, names), beforeBackups);

    let injected = false;
    const r2 = await f.restore(async (p) => {
      if (!injected) { injected = true; fs.writeFileSync(f.workPath, concurrent); }
      return { ok: true, finalCookies: p.cookies };
    }, { excludeWorkCopy: true, loginCfg: {} });
    assert.strictEqual(r2.ok, false, 'CAS 冲突绝不覆盖并发新文件');
    assert.ok(r2.attempts.some((a) => a.conflict === true));
    assert.deepStrictEqual(fs.readFileSync(f.workPath), concurrent, '并发新工作文件必须原样保留');
    assert.deepStrictEqual(f.sourceState(), beforeSources, '2RO 源零改动');
    assert.deepStrictEqual(backupFilesState(f, names), beforeBackups, '全部既有备份字节/mtime 零改动');
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('D14 同 SID 备份变体：跨调用历史换批，最终可达较旧健康变体（每轮 ≤5）', async () => {
  const f = guardSessionFixture();
  try {
    const baseline = Buffer.from(JSON.stringify(fullSessionCookies('A', 'work')));
    fs.writeFileSync(f.workPath, baseline); // 指纹稳定 → 失败史跨调用延续
    const healthySrc = fullSessionCookies('A', 'healthy');
    const healthyFinal = fullSessionCookies('A', 'healthy-final');
    const names = [];
    for (let i = 0; i < 12; i += 1) {
      names.push(`shopA.json${backupSuffixFor(i, i % 2 === 0 ? 'numeric' : 'compact')}`);
      writeWorkBackup(f, names[i], fullSessionCookies('A', `same-sid-${i}`), 1999998000 - i);
    }
    const healthyName = `shopA.json${backupSuffixFor(12, 'compact')}`;
    names.push(healthyName);
    writeWorkBackup(f, healthyName, healthySrc, 1999998000 - 12);
    const beforeBackups = backupFilesState(f, names);
    const beforeSources = f.sourceState();
    const loginCfg = {};
    const seen = new Set();
    let promoted = null;
    let rounds = 0;
    for (let round = 1; round <= 5 && promoted === null; round += 1) {
      rounds = round;
      const r = await f.restore(async (p) => {
        assert.ok(!seen.has(p.source), `第 ${round} 轮重复验证已失败来源: ${p.source}`);
        seen.add(p.source);
        if (JSON.stringify(p.cookies) !== JSON.stringify(healthySrc)) {
          return { ok: false, classification: 'login-invalid', reason: '合成失效' };
        }
        return { ok: true, finalCookies: healthyFinal };
      }, { excludeWorkCopy: true, loginCfg });
      if (round === 1) assert.ok(seen.size <= RESTORE_MAX_CANDIDATES, '每轮仍只验证首选 5 条');
      if (r.ok) promoted = r;
      else assert.deepStrictEqual(fs.readFileSync(f.workPath), baseline, '未提升前工作副本不变');
    }
    assert.ok(promoted, '较旧健康同 SID 变体必须在有界轮次内可达');
    assert.ok(rounds >= 2 && rounds <= 5, `必须依赖跨调用历史换批（实际 ${rounds} 轮）`);
    assert.ok(String(promoted.source).startsWith('guard-work-backup:'));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(f.workPath)), healthyFinal);
    assert.deepStrictEqual(f.sourceState(), beforeSources);
    assert.deepStrictEqual(backupFilesState(f, names), beforeBackups);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
