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
  const restore = (verify, extra = {}) => restoreDutyWorkCopy({ cookieSourceDir: roots.analyzerWorkDir }, 'shopA.json', {
    shopCfg: { name: 'shopA' }, workDir: roots.guardWorkDir, recoveryDir: roots.recoveryDir,
    vaultRoots: roots, vaultModule, fsModule: fsm, verify, audit: (e) => audit.push(e), ...extra,
  });
  return { root, roots, workPath, reads, byteReads, audit, snapshot, sourceState, restore };
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
