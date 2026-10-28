'use strict';

/**
 * S99：推广侧 Cookie 工作副本（cookie-workcopy + session.resolveCookieFile）离线测试。
 *
 * 全部使用操作系统临时目录 + 假 Cookie（无真实凭证/网络/浏览器/广告动作）。
 * 经真实 ensureWorkCopy / resolveCookieFile / 真实 cookie-writeback helper 证明：
 *  - 首次导入返回本项目副本路径（≠来源路径），字节与来源完全一致；
 *  - 真实 writeback 只落在副本上：来源字节 sha256 与 mtime 全程不变，只读 fs spy
 *    记录来源目录写尝试恒为 0 次；
 *  - 来源未变时保留已被写回刷新的工作副本（不每轮用旧源覆盖）；
 *  - **S99 语义纠正**：来源内容变化（商品分析普通读取的收尾保存同样会改上游）**不再**
 *    被当作"用户重新扫码"——普通解析对结构健康的独立副本零覆盖，只如实报告
 *    source-diverged-kept；只有 app「本次已验证新登录」（authorizedFreshLogin +
 *    本次 commit.sha256）明确调用才按冻结快照更新副本，使两份再次相同；
 *  - 全指纹 CAS：tmp fsync 之后 / rename 之前的来源与目的新鲜复验，并发新文件永远保留；
 *    锁内目的 CAS（调用入口冻结基线）拒绝覆盖并发刷新的副本；
 *  - sidecar 更新失败后 meta 过期也不会让下一轮普通解析用旧来源覆盖已刷新副本；
 *  - 来源坏 JSON/空数组/缺业务域/缺失/竞态、锁忙、目录 junction 别名（helper 与实际
 *    resolver 双层拒绝）、路径穿越、同店多进程（spawn 真实本地 node）、多店隔离、
 *    无来源旧独立登录兼容。
 * 运行（由 Root 执行，本 Worker 无 Bash 未运行）：
 *   node --test guard/test/cookie-workcopy-r96.test.js
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const {
  safeCookieBaseName, validateCookieArray, ensureWorkCopy, sha256Of, META_SUFFIX,
} = require('../src/login/cookie-workcopy');
const { resolveCookieFile } = require('../src/login/session');
const { writebackSessionCookies, fingerprintFile } = require('../src/login/cookie-writeback');
const { AuthError } = require('../src/lib/errors');

const tempDirs = [];
function mkdtemp(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
after(() => {
  for (const d of tempDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
});

/** 假 Cookie（无真实凭证）：jinritemai 业务域 + 额外属性（partitionKey 等）验证原文保留。 */
function makeCookies(n = 3, tag = 'v1') {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      name: `ck_${tag}_${i}`, value: `FAKE_NOT_REAL_${tag}_${i}`,
      domain: i === 0 ? '.fxg.jinritemai.com' : '.jinritemai.com',
      path: '/', expires: Math.floor(Date.now() / 1000) + 86400,
      httpOnly: true, secure: true, sameSite: i === 0 ? 'None' : 'Lax',
      ...(i === 1 ? { partitionKey: 'https://fxg.jinritemai.com' } : {}),
    });
  }
  return out;
}

function writeSource(dir, name, cookies) {
  const p = path.join(dir, name);
  const buf = Buffer.from(JSON.stringify(cookies, null, 2), 'utf8');
  fs.writeFileSync(p, buf);
  return { path: p, buf, sha256: sha256Of(buf) };
}

/** 只读 fs spy：包装真实 fs，统计指向 sourceDir 的一切写类操作（应为 0）。 */
function makeSpyFs(sourceDir) {
  const spy = { sourceWrites: [] };
  const real = path.resolve(sourceDir);
  const underSource = (p) => {
    if (typeof p !== 'string') return false;
    const r = path.resolve(p);
    return r === real || r.startsWith(real + path.sep);
  };
  const guardWrite = (fnName, args) => {
    if (args.some(underSource)) spy.sourceWrites.push({ fn: fnName, args: args.filter((a) => typeof a === 'string') });
  };
  const wrap = (fnName) => (...args) => { guardWrite(fnName, args); return fs[fnName](...args); };
  for (const fn of ['writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'chmodSync',
    'mkdirSync', 'rmSync', 'truncateSync', 'utimesSync', 'linkSync', 'symlinkSync']) {
    spy[fn] = wrap(fn);
  }
  spy.openSync = (p, flags, ...rest) => {
    if (typeof flags === 'string' && /[wa]/.test(flags) && underSource(p)) guardWrite('openSync', [p]);
    return fs.openSync(p, flags, ...rest);
  };
  // 其余只读/fd 类方法直接透传
  for (const fn of ['existsSync', 'readFileSync', 'statSync', 'lstatSync', 'realpathSync', 'readdirSync',
    'writeSync', 'fsyncSync', 'closeSync']) {
    spy[fn] = (...args) => fs[fn](...args);
  }
  return spy;
}

/** 可编程 fs 包装：按 match(path) 改写特定方法行为（竞态/失败注入）。 */
function makeProgFs(overrides) {
  const p = { ...overrides };
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'string' && p[prop]) return p[prop];
      const v = fs[prop];
      return typeof v === 'function' ? (...args) => v(...args) : v;
    },
  });
}

// ── 1. 安全 basename / 结构校验 ──────────────────────────────────

test('safeCookieBaseName：补全 .json、拒绝路径穿越与非法名', () => {
  assert.strictEqual(safeCookieBaseName('店A'), '店A.json');
  assert.strictEqual(safeCookieBaseName('店A.json'), '店A.json');
  for (const bad of ['../evil', 'a/b', 'a\\b', 'x..y', '', null, 'TODO_店']) {
    assert.throws(() => safeCookieBaseName(bad), AuthError, `应拒绝: ${String(bad)}`);
  }
});

test('validateCookieArray：空/缺字段/缺业务域/全空值拒绝，合格通过', () => {
  assert.strictEqual(validateCookieArray([]).ok, false);
  assert.strictEqual(validateCookieArray(makeCookies(2)).ok, true);
  const noPath = makeCookies(1); delete noPath[0].path;
  assert.strictEqual(validateCookieArray(noPath).ok, false);
  const noDomain = makeCookies(1); delete noDomain[0].domain;
  assert.strictEqual(validateCookieArray(noDomain).ok, false);
  assert.strictEqual(validateCookieArray([{ name: 'a', value: 'x', domain: 'example.com', path: '/' }]).ok, false,
    '无 jinritemai 业务域拒绝');
  const emptyVals = makeCookies(2).map((c) => ({ ...c, value: '' }));
  assert.strictEqual(validateCookieArray(emptyVals).ok, false);
});

// ── 2. 首次导入：不同路径、字节一致、来源零写入 ──────────────────

test('首次导入：返回工作副本路径（≠来源），字节与来源完全一致，来源目录零写入', () => {
  const srcDir = mkdtemp('wc97-src-');
  const workDir = mkdtemp('wc97-work-');
  const src = writeSource(srcDir, '店A.json', makeCookies(3, 'v1'));
  const spy = makeSpyFs(srcDir);

  const before = fingerprintFile(src.path);
  const r = ensureWorkCopy({ sourceDir: srcDir, fileName: '店A.json', workDir, fsMod: spy });

  assert.strictEqual(r.path, path.join(workDir, '店A.json'));
  assert.notStrictEqual(r.path, src.path, '绝不返回来源路径给写回链');
  assert.strictEqual(r.readOnly, false);
  assert.strictEqual(r.sourceSync.status, 'imported');
  assert.deepStrictEqual(fs.readFileSync(r.path), src.buf, '副本字节与来源逐字节一致（保留 partitionKey 等全部属性）');
  const meta = JSON.parse(fs.readFileSync(r.path + META_SUFFIX, 'utf8'));
  assert.strictEqual(meta.sourceSha256, src.sha256, 'sidecar 记录来源 sha（不含 Cookie 值）');
  assert.ok(!('cookie' in meta) && !JSON.stringify(meta).includes('FAKE_NOT_REAL'), 'sidecar 不含 Cookie 值');

  const afterFp = fingerprintFile(src.path);
  assert.strictEqual(afterFp.sha256, before.sha256, '来源 sha256 不变');
  assert.strictEqual(afterFp.mtimeMs, before.mtimeMs, '来源 mtime 不变');
  assert.deepStrictEqual(spy.sourceWrites, [], '来源目录写尝试为 0 次');
  assert.deepStrictEqual(fs.readdirSync(srcDir), ['店A.json'], '来源目录无 sidecar/tmp 残留');
  assert.ok(!fs.readdirSync(workDir).some((f) => f.endsWith('.lock') || f.includes('.tmp-')), '工作根无锁/tmp 残留');
});

test('resolveCookieFile：独立来源配置 → 返回本项目副本（readOnly:false + sourceSync），来源零写入', () => {
  const srcDir = mkdtemp('wc97-src-');
  const workDir = mkdtemp('wc97-work-');
  const src = writeSource(srcDir, '店B.json', makeCookies(4, 'v1'));
  const spy = makeSpyFs(srcDir);
  const srcBefore = fingerprintFile(src.path);

  const r = resolveCookieFile({ cookieSourceDir: srcDir }, '店B', { workDir, fsMod: spy });
  assert.strictEqual(r.path, path.join(workDir, '店B.json'));
  assert.strictEqual(r.dir, workDir);
  assert.strictEqual(r.readOnly, false);
  assert.ok(r.sourceSync && r.sourceSync.status === 'imported');
  assert.deepStrictEqual(fs.readFileSync(r.path), src.buf);
  assert.deepStrictEqual(spy.sourceWrites, [], '来源目录写尝试为 0 次');

  // 再次解析：来源未变 → 保留副本，不重复导入
  const r2 = resolveCookieFile({ cookieSourceDir: srcDir }, '店B', { workDir, fsMod: spy });
  assert.strictEqual(r2.sourceSync.status, 'unchanged');
  const srcAfter = fingerprintFile(src.path);
  assert.strictEqual(srcAfter.sha256, srcBefore.sha256, '来源 sha256 不变');
  assert.strictEqual(srcAfter.mtimeMs, srcBefore.mtimeMs, '来源 mtime 不变');
  assert.deepStrictEqual(spy.sourceWrites, []);
});

// ── 3. 真实 writeback 只落副本；来源未变时保留刷新副本 ──────────

test('真实 writeback 刷新副本后：来源未变 → 下一次 resolve 保留刷新副本，来源 sha/mtime 不变', async () => {
  const srcDir = mkdtemp('wc97-src-');
  const workDir = mkdtemp('wc97-work-');
  const src = writeSource(srcDir, '店C.json', makeCookies(3, 'v1'));
  const spy = makeSpyFs(srcDir);
  const srcBefore = fingerprintFile(src.path);

  const r = resolveCookieFile({ cookieSourceDir: srcDir }, '店C', { workDir, fsMod: spy });
  const startFp = fingerprintFile(r.path);
  const refreshed = makeCookies(4, 'v1'); // 覆盖原全部域且条数增加（满足写入器守卫）
  const wb = await writebackSessionCookies({
    context: { cookies: async () => refreshed },
    cookieFilePath: r.path,
    sessionStartFingerprint: startFp,
    identityOk: true,
    loginOk: true,
  });
  assert.strictEqual(wb.ok, true, '真实写入器在副本上成功回写');
  const refreshedBuf = fs.readFileSync(r.path);
  assert.strictEqual(JSON.parse(refreshedBuf.toString('utf8')).length, 4);

  // 无效登录（loginOk 非 true）：写入器 fail-closed 跳过，副本与来源都不变
  const wbDenied = await writebackSessionCookies({
    context: { cookies: async () => makeCookies(9, 'evil') },
    cookieFilePath: r.path,
    sessionStartFingerprint: fingerprintFile(r.path),
    identityOk: true,
    loginOk: false,
  });
  assert.strictEqual(wbDenied.ok, false);
  assert.strictEqual(wbDenied.skipped, true);
  assert.deepStrictEqual(fs.readFileSync(r.path), refreshedBuf, '无效登录不覆盖副本');

  const r2 = resolveCookieFile({ cookieSourceDir: srcDir }, '店C', { workDir, fsMod: spy });
  assert.strictEqual(r2.sourceSync.status, 'unchanged-refreshed-kept', '来源未变：保留已刷新副本，不用旧源覆盖');
  assert.deepStrictEqual(fs.readFileSync(r2.path), refreshedBuf, '刷新后的副本字节原样保留');

  const srcAfter = fingerprintFile(src.path);
  assert.strictEqual(srcAfter.sha256, srcBefore.sha256, '来源 sha256 全程不变');
  assert.strictEqual(srcAfter.mtimeMs, srcBefore.mtimeMs, '来源 mtime 全程不变');
  assert.deepStrictEqual(spy.sourceWrites, [], 'writeback/resolve 全程对来源目录零写尝试');
});

test('来源内容变化 ≠ 新扫码：普通解析保留健康副本；仅已验证新登录（authorizedFreshLogin）才替换', () => {
  const srcDir = mkdtemp('wc97-src-');
  const workDir = mkdtemp('wc97-work-');
  const name = '店D.json';
  const src1 = writeSource(srcDir, name, makeCookies(3, 'v1'));
  const spy = makeSpyFs(srcDir);
  const r1 = ensureWorkCopy({ sourceDir: srcDir, fileName: name, workDir, fsMod: spy });
  assert.strictEqual(r1.sourceSync.status, 'imported');
  assert.deepStrictEqual(fs.readFileSync(r1.path), src1.buf, '初始两份字节完全相同');

  // 上游文件被改写（可能只是商品分析普通读取的收尾保存，不代表用户重新扫码）
  const src2 = writeSource(srcDir, name, makeCookies(5, 'v2'));
  assert.notStrictEqual(src2.sha256, src1.sha256);
  const r2 = ensureWorkCopy({ sourceDir: srcDir, fileName: name, workDir, fsMod: spy });
  assert.strictEqual(r2.sourceSync.status, 'source-diverged-kept', '普通解析不因来源 hash 变化覆盖健康副本');
  assert.deepStrictEqual(fs.readFileSync(r2.path), src1.buf, '本项目副本保持自己的内容');
  assert.match(String(r2.sourceSync.reason), /已验证新登录/, '如实说明只有已验证新登录才更新');
  assert.strictEqual(r2.sourceSync.sourceSha256, src2.sha256, '如实报告当前来源 sha（不含 Cookie 值）');

  // 真实 resolver 链同样不覆盖（不只 helper 层）
  const r2b = resolveCookieFile({ cookieSourceDir: srcDir }, '店D', { workDir, fsMod: spy });
  assert.strictEqual(r2b.sourceSync.status, 'source-diverged-kept');
  assert.deepStrictEqual(fs.readFileSync(r2b.path), src1.buf);

  // 显式「本次已验证新登录」+ 本次 commit.sha256 → 按冻结快照更新，两份再次相同
  const r3 = ensureWorkCopy({
    sourceDir: srcDir, fileName: name, workDir, fsMod: spy,
    authorizedFreshLogin: true, expectedSourceSha256: src2.sha256,
  });
  assert.strictEqual(r3.sourceSync.status, 'refreshed-from-source');
  assert.deepStrictEqual(fs.readFileSync(r3.path), src2.buf, '副本安全更新为本次已验证登录快照');
  const meta = JSON.parse(fs.readFileSync(r3.path + META_SUFFIX, 'utf8'));
  assert.strictEqual(meta.sourceSha256, src2.sha256);

  // 授权路径幂等：同一快照再来一次不重复写、不谎报
  const r4 = ensureWorkCopy({
    sourceDir: srcDir, fileName: name, workDir, fsMod: spy,
    authorizedFreshLogin: true, expectedSourceSha256: src2.sha256,
  });
  assert.strictEqual(r4.sourceSync.status, 'unchanged');
  const r5 = ensureWorkCopy({ sourceDir: srcDir, fileName: name, workDir, fsMod: spy });
  assert.strictEqual(r5.sourceSync.status, 'unchanged', '新来源稳定后普通解析不再导入');
  assert.deepStrictEqual(spy.sourceWrites, [], '全程来源目录零写尝试');
});

// ── 4. 坏来源 / 缺失来源：绝不破坏已有工作副本 ──────────────────

test('来源坏 JSON / 空数组 / 缺业务域 / 缺失：保留健康副本并如实报告；无副本则抛 AuthError', () => {
  const srcDir = mkdtemp('wc97-src-');
  const workDir = mkdtemp('wc97-work-');
  const good = writeSource(srcDir, '店E.json', makeCookies(3, 'v1'));
  const r1 = ensureWorkCopy({ sourceDir: srcDir, fileName: '店E.json', workDir });
  const copyBuf = fs.readFileSync(r1.path);

  // 坏 JSON
  fs.writeFileSync(good.path, '{broken json');
  const r2 = ensureWorkCopy({ sourceDir: srcDir, fileName: '店E.json', workDir });
  assert.strictEqual(r2.sourceSync.status, 'source-invalid-retained');
  assert.deepStrictEqual(fs.readFileSync(r2.path), copyBuf, '坏来源不破坏已有工作副本');

  // 空数组
  fs.writeFileSync(good.path, '[]');
  const r3 = ensureWorkCopy({ sourceDir: srcDir, fileName: '店E.json', workDir });
  assert.strictEqual(r3.sourceSync.status, 'source-invalid-retained');
  assert.deepStrictEqual(fs.readFileSync(r3.path), copyBuf);

  // 缺业务域
  writeSource(srcDir, '店E.json', [{ name: 'a', value: 'x', domain: 'example.com', path: '/' }]);
  const r4 = ensureWorkCopy({ sourceDir: srcDir, fileName: '店E.json', workDir });
  assert.strictEqual(r4.sourceSync.status, 'source-invalid-retained');
  assert.deepStrictEqual(fs.readFileSync(r4.path), copyBuf);

  // 来源缺失
  fs.unlinkSync(good.path);
  const r5 = ensureWorkCopy({ sourceDir: srcDir, fileName: '店E.json', workDir });
  assert.strictEqual(r5.sourceSync.status, 'source-missing-retained');
  assert.deepStrictEqual(fs.readFileSync(r5.path), copyBuf);

  // 无副本 + 坏来源 → 抛 AuthError（绝不返回来源路径兜底）
  const workDir2 = mkdtemp('wc97-work-');
  fs.writeFileSync(good.path, '{broken');
  assert.throws(
    () => ensureWorkCopy({ sourceDir: srcDir, fileName: '店E.json', workDir: workDir2 }),
    (e) => e instanceof AuthError && /结构无效/.test(e.message)
  );
  assert.throws(
    () => resolveCookieFile({ cookieSourceDir: srcDir }, '店E', { workDir: workDir2 }),
    AuthError, '无可用副本时如实失败，不返回坏来源路径'
  );
  assert.strictEqual(fs.existsSync(path.join(workDir2, '店E.json')), false, '失败时不留下半写副本');
});

test('损坏的工作副本 + 有效来源 → 安全重导入（坏副本不阻挡新来源）', () => {
  const srcDir = mkdtemp('wc97-src-');
  const workDir = mkdtemp('wc97-work-');
  const src = writeSource(srcDir, '店F.json', makeCookies(3, 'v1'));
  fs.writeFileSync(path.join(workDir, '店F.json'), '{corrupted');
  const r = ensureWorkCopy({ sourceDir: srcDir, fileName: '店F.json', workDir });
  assert.strictEqual(r.sourceSync.status, 'imported');
  assert.deepStrictEqual(fs.readFileSync(r.path), src.buf);
});

// ── 5. 竞态 fail-closed（冻结字节复验）──────────────────────────

test('来源在捕获与原子替换之间变化 → fail-closed：保留副本、不写入、不谎报', () => {
  const srcDir = mkdtemp('wc97-src-');
  const workDir = mkdtemp('wc97-work-');
  const v1 = writeSource(srcDir, '店G.json', makeCookies(3, 'v1'));
  ensureWorkCopy({ sourceDir: srcDir, fileName: '店G.json', workDir });
  const copyV1 = fs.readFileSync(path.join(workDir, '店G.json'));

  const v2 = Buffer.from(JSON.stringify(makeCookies(4, 'v2'), null, 2), 'utf8');
  const v3 = Buffer.from(JSON.stringify(makeCookies(5, 'v3'), null, 2), 'utf8');
  fs.writeFileSync(v1.path, v2); // 上游变化（授权新登录路径才会进入导入窗口）
  let reads = 0;
  const raceFs = makeProgFs({
    readFileSync: (p, ...rest) => {
      if (path.resolve(String(p)) === path.resolve(v1.path)) {
        reads += 1;
        return reads === 1 ? v2 : v3; // 锁内复验时来源又变（同一冻结字节要求被打破）
      }
      return fs.readFileSync(p, ...rest);
    },
  });
  const r = ensureWorkCopy({
    sourceDir: srcDir, fileName: '店G.json', workDir, fsMod: raceFs,
    authorizedFreshLogin: true, expectedSourceSha256: sha256Of(v2),
  });
  assert.strictEqual(r.sourceSync.status, 'source-race-retained');
  assert.deepStrictEqual(fs.readFileSync(r.path), copyV1, '竞态时保留现有副本，不写半新来源');

  // 无副本时竞态 → 抛 AuthError
  const workDir2 = mkdtemp('wc97-work-');
  let reads2 = 0;
  const raceFs2 = makeProgFs({
    readFileSync: (p, ...rest) => {
      if (path.resolve(String(p)) === path.resolve(v1.path)) { reads2 += 1; return reads2 === 1 ? v2 : v3; }
      return fs.readFileSync(p, ...rest);
    },
  });
  assert.throws(
    () => ensureWorkCopy({ sourceDir: srcDir, fileName: '店G.json', workDir: workDir2, fsMod: raceFs2 }),
    (e) => e instanceof AuthError && /竞态/.test(e.message)
  );
  assert.strictEqual(fs.existsSync(path.join(workDir2, '店G.json')), false);
});

test('锁忙（另一进程持锁）：不清 unknown 锁；有副本保留，无副本抛 AuthError', () => {
  const srcDir = mkdtemp('wc97-src-');
  const workDir = mkdtemp('wc97-work-');
  writeSource(srcDir, '店H.json', makeCookies(3, 'v1'));
  const lockPath = path.join(workDir, '店H.json.lock');
  fs.writeFileSync(lockPath, 'other-pid-999');

  assert.throws(
    () => ensureWorkCopy({ sourceDir: srcDir, fileName: '店H.json', workDir }),
    (e) => e instanceof AuthError && /另一进程/.test(e.message),
    '无副本 + 锁忙 → fail-closed 抛错'
  );
  assert.ok(fs.existsSync(lockPath), 'unknown 锁未被静默清除');
  assert.deepStrictEqual(fs.readFileSync(lockPath, 'utf8'), 'other-pid-999');
  assert.strictEqual(fs.existsSync(path.join(workDir, '店H.json')), false);

  // 已有健康副本 + 已验证新登录需要替换 → busy-retained（不是成功）
  const workDir2 = mkdtemp('wc97-work-');
  const r1 = ensureWorkCopy({ sourceDir: srcDir, fileName: '店H.json', workDir: workDir2 });
  const copyBuf = fs.readFileSync(r1.path);
  fs.writeFileSync(path.join(workDir2, '店H.json.lock'), 'other-pid-888');
  const src2 = writeSource(srcDir, '店H.json', makeCookies(4, 'v2')); // 本次已验证新登录快照
  const r2 = ensureWorkCopy({
    sourceDir: srcDir, fileName: '店H.json', workDir: workDir2,
    authorizedFreshLogin: true, expectedSourceSha256: src2.sha256,
  });
  assert.strictEqual(r2.sourceSync.status, 'busy-retained');
  assert.match(String(r2.sourceSync.reason), /不是本次同步成功/, '锁忙如实报告为非成功');
  assert.deepStrictEqual(fs.readFileSync(r2.path), copyBuf, '锁忙时保留现有副本');
  assert.ok(fs.existsSync(path.join(workDir2, '店H.json.lock')), 'unknown 锁保留');

  // 普通解析（未授权）根本不进入导入窗口：来源变化也不覆盖健康副本
  const r3 = ensureWorkCopy({ sourceDir: srcDir, fileName: '店H.json', workDir: workDir2 });
  assert.strictEqual(r3.sourceSync.status, 'source-diverged-kept');
  assert.deepStrictEqual(fs.readFileSync(r3.path), copyBuf);
});

// ── 6. sidecar 提交失败：不谎报原子/成功，下一轮不覆盖 ──────────

test('sidecar 写失败：如实标记 sidecarFailed；下一轮保守保留副本，不被旧源/新源覆盖', () => {
  const srcDir = mkdtemp('wc97-src-');
  const workDir = mkdtemp('wc97-work-');
  const src1 = writeSource(srcDir, '店I.json', makeCookies(3, 'v1'));
  const noMetaFs = makeProgFs({
    openSync: (p, flags, ...rest) => {
      if (String(p).includes('.meta')) { const e = new Error('EACCES: meta denied'); e.code = 'EACCES'; throw e; }
      return fs.openSync(p, flags, ...rest);
    },
  });
  const r1 = ensureWorkCopy({ sourceDir: srcDir, fileName: '店I.json', workDir, fsMod: noMetaFs });
  assert.strictEqual(r1.sourceSync.status, 'imported-sidecar-failed');
  assert.strictEqual(r1.sourceSync.sidecarFailed, true, '双文件提交未完成 → 不宣称原子/成功');
  assert.deepStrictEqual(fs.readFileSync(r1.path), src1.buf, '副本字节本身已安全写入');

  // 下一轮（正常 fs）：meta 缺失 + 副本健康 + 字节与来源一致 → 安全重建 sidecar
  const r2 = ensureWorkCopy({ sourceDir: srcDir, fileName: '店I.json', workDir });
  assert.strictEqual(r2.sourceSync.status, 'rematerialized');
  assert.ok(fs.existsSync(r1.path + META_SUFFIX), 'sidecar 已重建（恢复边界之一）');

  // meta 再次缺失 + 副本已被写回刷新（字节≠来源）+ 上游新扫码 → 保守保留，不覆盖已刷新副本
  fs.unlinkSync(r1.path + META_SUFFIX);
  fs.writeFileSync(r1.path, JSON.stringify(makeCookies(4, 'refreshed'), null, 2));
  const refreshedBuf = fs.readFileSync(r1.path);
  writeSource(srcDir, '店I.json', makeCookies(5, 'v2'));
  const r3 = ensureWorkCopy({ sourceDir: srcDir, fileName: '店I.json', workDir });
  assert.strictEqual(r3.sourceSync.status, 'meta-missing-retained', 'legacy 冲突诚实保留');
  assert.deepStrictEqual(fs.readFileSync(r3.path), refreshedBuf, '已刷新工作副本未被覆盖');
  assert.match(String(r3.sourceSync.reason), /恢复边界/, '明确恢复边界');

  // app 侧「本次已验证新登录」授权路径才允许替换 legacy 副本
  const r4 = ensureWorkCopy({ sourceDir: srcDir, fileName: '店I.json', workDir, authorizedFreshLogin: true });
  assert.strictEqual(r4.sourceSync.status, 'replaced-legacy');
  const srcNow = fs.readFileSync(path.join(srcDir, '店I.json'));
  assert.deepStrictEqual(fs.readFileSync(r4.path), srcNow);
});

// ── 7. 路径别名 / 穿越拒绝 ─────────────────────────────────────

test('目录 junction/symlink 别名（realpath 重合）→ 拒绝，不把别名当隔离成功', () => {
  const realSrc = mkdtemp('wc97-src-');
  const parent = mkdtemp('wc97-alias-');
  writeSource(realSrc, '店J.json', makeCookies(3, 'v1'));
  const link = path.join(parent, 'alias-link');
  try {
    fs.symlinkSync(realSrc, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (_) {
    return; // 环境不允许创建链接时跳过该项（其余断言不受影响）
  }
  assert.throws(
    () => ensureWorkCopy({ sourceDir: link, fileName: '店J.json', workDir: realSrc }),
    (e) => e instanceof AuthError && /别名|重合/.test(e.message),
    '链接指向工作目录本身 → 拒绝'
  );
  assert.throws(
    () => ensureWorkCopy({ sourceDir: realSrc, fileName: '店J.json', workDir: link }),
    (e) => e instanceof AuthError && /别名|重合/.test(e.message),
    '工作目录是指向上游的链接 → 拒绝'
  );
  assert.deepStrictEqual(fs.readdirSync(realSrc), ['店J.json'], '来源目录零写入/零残留');
});

test('工作副本路径已被符号链接占据 → 拒绝写入（不把别名当副本）', () => {
  const srcDir = mkdtemp('wc97-src-');
  const workDir = mkdtemp('wc97-work-');
  const elsewhere = mkdtemp('wc97-other-');
  const src = writeSource(srcDir, '店K.json', makeCookies(3, 'v1'));
  const outside = path.join(elsewhere, 'outside.json');
  fs.writeFileSync(outside, '[]');
  const linkPath = path.join(workDir, '店K.json');
  try {
    fs.symlinkSync(outside, linkPath, 'file');
  } catch (_) {
    // Windows 非开发者模式可能禁止文件符号链接：环境不支持时跳过该项
    return;
  }
  const outsideBefore = fs.readFileSync(outside);
  assert.throws(
    () => ensureWorkCopy({ sourceDir: srcDir, fileName: '店K.json', workDir }),
    (e) => e instanceof AuthError && /符号链接|别名/.test(e.message)
  );
  assert.deepStrictEqual(fs.readFileSync(outside), outsideBefore, '链接目标未被写入');
  assert.deepStrictEqual(fs.readFileSync(src.path), src.buf, '来源未被写入');
});

test('resolveCookieFile：路径穿越一律 AuthError；来源=工作根（realpath 重合）按本地兼容', () => {
  const srcDir = mkdtemp('wc97-src-');
  const workDir = mkdtemp('wc97-work-');
  for (const bad of ['../evil', 'a/b', 'a\\b', 'x..y']) {
    assert.throws(() => resolveCookieFile({ cookieSourceDir: srcDir }, bad, { workDir }), AuthError);
  }
  // 来源目录与工作根为同一 realpath：不做复制、不建 sidecar，直接本地文件（readOnly:false）
  writeSource(workDir, '店L.json', makeCookies(2, 'v1'));
  const r = resolveCookieFile({ cookieSourceDir: workDir }, '店L', { workDir });
  assert.strictEqual(r.path, path.join(workDir, '店L.json'));
  assert.strictEqual(r.readOnly, false);
  assert.deepStrictEqual(fs.readdirSync(workDir), ['店L.json'], '未产生 sidecar/lock/tmp');
});

// ── 8. 并发：同店多进程（真实 spawn 本地 node）与多店隔离 ────────

test('同店多进程并发导入：副本完好且等于来源、来源 sha/mtime 不变、无锁/tmp 残留', async () => {
  const srcDir = mkdtemp('wc97-src-');
  const workDir = mkdtemp('wc97-work-');
  const src = writeSource(srcDir, '店M.json', makeCookies(6, 'v1'));
  const srcBefore = fingerprintFile(src.path);

  const scriptDir = mkdtemp('wc97-script-');
  const scriptPath = path.join(scriptDir, 'concurrent-import.js');
  fs.writeFileSync(scriptPath, `'use strict';
const { ensureWorkCopy } = require(${JSON.stringify(path.join(__dirname, '..', 'src', 'login', 'cookie-workcopy.js'))});
const [srcDir, workDir, fileName] = process.argv.slice(2);
for (let i = 0; i < 10; i += 1) {
  try {
    ensureWorkCopy({ sourceDir: srcDir, fileName, workDir });
  } catch (e) {
    if (!/另一进程|竞态/.test(String(e && e.message))) { console.error('UNEXPECTED:' + e.message); process.exit(1); }
  }
}
process.exit(0);
`);
  const runChild = () => new Promise((resolve) => {
    const c = spawn(process.execPath, [scriptPath, srcDir, workDir, '店M.json'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    c.stderr.on('data', (d) => { err += d.toString(); });
    c.on('close', (code) => resolve({ code, err }));
  });
  const results = await Promise.all([runChild(), runChild(), runChild()]);
  for (const r of results) assert.strictEqual(r.code, 0, `子进程应正常退出（busy/竞态被 fail-closed 吞掉）: ${r.err}`);

  const copyBuf = fs.readFileSync(path.join(workDir, '店M.json'));
  assert.deepStrictEqual(copyBuf, src.buf, '并发后副本仍逐字节等于来源');
  assert.strictEqual(JSON.parse(copyBuf.toString('utf8')).length, 6, '副本可解析且完整');
  const srcAfter = fingerprintFile(src.path);
  assert.strictEqual(srcAfter.sha256, srcBefore.sha256, '来源 sha256 不变');
  assert.strictEqual(srcAfter.mtimeMs, srcBefore.mtimeMs, '来源 mtime 不变');
  const leftovers = fs.readdirSync(workDir).filter((f) => f.endsWith('.lock') || f.includes('.tmp-'));
  assert.deepStrictEqual(leftovers, [], '无锁/tmp 残留');
});

test('多店并发隔离：各店副本各自等于自己的来源，互不干扰', () => {
  const srcDir = mkdtemp('wc97-src-');
  const workDir = mkdtemp('wc97-work-');
  const a = writeSource(srcDir, '店N.json', makeCookies(3, 'A'));
  const b = writeSource(srcDir, '店O.json', makeCookies(5, 'B'));
  const spy = makeSpyFs(srcDir);
  const ra = ensureWorkCopy({ sourceDir: srcDir, fileName: '店N.json', workDir, fsMod: spy });
  const rb = ensureWorkCopy({ sourceDir: srcDir, fileName: '店O.json', workDir, fsMod: spy });
  assert.deepStrictEqual(fs.readFileSync(ra.path), a.buf);
  assert.deepStrictEqual(fs.readFileSync(rb.path), b.buf);
  assert.strictEqual(ra.path !== rb.path, true);
  assert.deepStrictEqual(spy.sourceWrites, []);
});

// ── 9. 无来源配置：旧独立登录兼容（不反向写）───────────────────

test('无来源配置：本项目文件直接可用（readOnly:false），不产生 sidecar、不反向写', () => {
  const workDir = mkdtemp('wc97-work-');
  writeSource(workDir, '店P.json', makeCookies(2, 'v1'));
  const r = resolveCookieFile({ cookieSourceDir: null }, '店P', { workDir });
  assert.strictEqual(r.path, path.join(workDir, '店P.json'));
  assert.strictEqual(r.readOnly, false);
  assert.deepStrictEqual(fs.readdirSync(workDir), ['店P.json']);

  assert.throws(() => resolveCookieFile({ cookieSourceDir: null }, '不存在店', { workDir }), AuthError);
});

test('来源目录配置存在但该店文件缺失：本地已有副本继续可用（不反向写来源）', () => {
  const srcDir = mkdtemp('wc97-src-');
  const workDir = mkdtemp('wc97-work-');
  const local = writeSource(workDir, '店Q.json', makeCookies(2, 'v1'));
  const spy = makeSpyFs(srcDir);
  const r = resolveCookieFile({ cookieSourceDir: srcDir }, '店Q', { workDir, fsMod: spy });
  assert.strictEqual(r.path, local.path);
  assert.strictEqual(r.sourceSync.status, 'source-file-missing-local-only');
  assert.deepStrictEqual(spy.sourceWrites, []);

  // 两边都没有 → 原有 AuthError 行为（消息列出两个目录）
  assert.throws(
    () => resolveCookieFile({ cookieSourceDir: srcDir }, '店R', { workDir, fsMod: spy }),
    (e) => e instanceof AuthError && /未找到店铺/.test(e.message) && e.message.includes(srcDir)
  );
});

// ── 10. S99：两份 Cookie 各自刷新、互不影响（真实 resolver 链）──────

test('真实 resolver 链：商品分析刷新来源 B + guard 刷新副本 C → 下次普通 resolve 仍 C、源 B 未被写；显式新登录才更新副本', async () => {
  const srcDir = mkdtemp('wc99-src-');
  const workDir = mkdtemp('wc99-work-');
  const spy = makeSpyFs(srcDir);
  const name = '店X.json';
  const s1 = writeSource(srcDir, name, makeCookies(3, 'v1'));

  // 首次普通解析：导入独立副本，初始两份字节完全相同
  const r1 = resolveCookieFile({ cookieSourceDir: srcDir }, '店X', { workDir, fsMod: spy });
  assert.strictEqual(r1.sourceSync.status, 'imported');
  assert.strictEqual(r1.path, path.join(workDir, name));
  assert.notStrictEqual(r1.path, s1.path, '写回链拿到的是独立副本，不是共享上游');
  assert.deepStrictEqual(fs.readFileSync(r1.path), s1.buf, '初始两份字节完全相同');

  // 商品分析侧：普通读取的收尾保存刷新上游为 B（这不是"用户重新扫码"）
  const sB = writeSource(srcDir, name, makeCookies(4, 'B'));
  const srcBFp = fingerprintFile(sB.path);

  // guard 侧：真实写入器把独立副本刷新为 C
  const refreshedC = makeCookies(5, 'C');
  const wb = await writebackSessionCookies({
    context: { cookies: async () => refreshedC },
    cookieFilePath: r1.path,
    sessionStartFingerprint: fingerprintFile(r1.path),
    identityOk: true,
    loginOk: true,
  });
  assert.strictEqual(wb.ok, true, '真实写入器在独立副本上成功回写');
  const copyC = fs.readFileSync(r1.path);
  assert.notStrictEqual(sha256Of(copyC), sB.sha256, '前置：两侧内容此刻确实不同');

  // 下一次普通 resolve：副本仍是 C（不被上游 B 覆盖），来源 B 未被写
  const r2 = resolveCookieFile({ cookieSourceDir: srcDir }, '店X', { workDir, fsMod: spy });
  assert.strictEqual(r2.sourceSync.status, 'source-diverged-kept');
  assert.strictEqual(r2.path, path.join(workDir, name));
  assert.deepStrictEqual(fs.readFileSync(r2.path), copyC, 'guard 副本保持自己的刷新结果');
  assert.deepStrictEqual(fingerprintFile(sB.path), srcBFp, '商品分析来源字节/mtime 未被 guard 改动');
  assert.deepStrictEqual(spy.sourceWrites, [], '全程对来源目录零写尝试');

  // 只有 app「本次已验证新登录」（authorizedFreshLogin + 本次 commit.sha256）才更新副本
  const sD = writeSource(srcDir, name, makeCookies(6, 'D'));
  const r3 = ensureWorkCopy({
    sourceDir: srcDir, fileName: name, workDir, fsMod: spy,
    authorizedFreshLogin: true, expectedSourceSha256: sD.sha256,
  });
  assert.strictEqual(r3.sourceSync.status, 'refreshed-from-source');
  assert.deepStrictEqual(fs.readFileSync(r3.path), sD.buf, '新登录后两份字节再次完全相同');
  assert.deepStrictEqual(spy.sourceWrites, [], '新登录路径同样对来源零写入');
  assert.ok(!fs.readdirSync(workDir).some((f) => f.endsWith('.lock') || f.includes('.tmp-')), '无锁/tmp 残留');
});

test('普通分析刷新不覆盖 guard 工作副本（第 8 反例）：guard 刷新后上游多次改写，副本始终保留', () => {
  const srcDir = mkdtemp('wc99-src-');
  const workDir = mkdtemp('wc99-work-');
  const name = '店Y.json';
  writeSource(srcDir, name, makeCookies(3, 'v1'));
  ensureWorkCopy({ sourceDir: srcDir, fileName: name, workDir });

  // guard 侧刷新（写回链语义：直接落在副本上）
  const guardRefreshed = Buffer.from(JSON.stringify(makeCookies(5, 'guard'), null, 2), 'utf8');
  fs.writeFileSync(path.join(workDir, name), guardRefreshed);

  // 商品分析侧连续普通刷新上游
  writeSource(srcDir, name, makeCookies(4, 'app1'));
  writeSource(srcDir, name, makeCookies(6, 'app2'));
  for (let i = 0; i < 3; i += 1) {
    const r = ensureWorkCopy({ sourceDir: srcDir, fileName: name, workDir });
    assert.strictEqual(r.sourceSync.status, 'source-diverged-kept');
    assert.deepStrictEqual(fs.readFileSync(r.path), guardRefreshed, `第 ${i + 1} 轮普通解析都不覆盖 guard 副本`);
  }
});

// ── 11. S99：全指纹 CAS（fsync 窗口 / 锁内目的漂移）──────────────

test('tmp fsync 之后、rename 之前目的被并发刷新 → 放弃提交，保留并发新文件（授权新登录也不覆盖）', () => {
  const srcDir = mkdtemp('wc99-src-');
  const workDir = mkdtemp('wc99-work-');
  const name = '店Z.json';
  const workPath = path.join(workDir, name);
  writeSource(srcDir, name, makeCookies(3, 'v1'));
  ensureWorkCopy({ sourceDir: srcDir, fileName: name, workDir });
  const srcB = writeSource(srcDir, name, makeCookies(4, 'B'));
  const concurrent = Buffer.from(JSON.stringify(makeCookies(5, 'concurrent'), null, 2), 'utf8');

  let fired = false;
  const raceFs = makeProgFs({
    fsyncSync: (fd) => {
      fs.fsyncSync(fd);
      if (!fired) { fired = true; fs.writeFileSync(workPath, concurrent); } // 写回链在 fsync 窗口内刷新副本
    },
  });
  const r = ensureWorkCopy({
    sourceDir: srcDir, fileName: name, workDir, fsMod: raceFs,
    authorizedFreshLogin: true, expectedSourceSha256: srcB.sha256,
  });
  assert.strictEqual(r.sourceSync.status, 'dest-race-retained');
  assert.deepStrictEqual(fs.readFileSync(workPath), concurrent, '并发刷新的工作副本必须存活（不被旧捕获字节覆盖）');
  assert.ok(fired, '并发窗口确实被触发（不是空跑）');
  assert.ok(!fs.readdirSync(workDir).some((f) => f.includes('.tmp-') || f.endsWith('.lock')), '自有 tmp/锁已清理');

  // 下一轮普通解析同样不覆盖（sidecar 仍是旧记录也不会触发重导入）
  const r2 = ensureWorkCopy({ sourceDir: srcDir, fileName: name, workDir });
  assert.strictEqual(r2.sourceSync.status, 'source-diverged-kept');
  assert.deepStrictEqual(fs.readFileSync(workPath), concurrent);
});

test('tmp fsync 之后、rename 之前来源变化 → 拒绝提交，保留原健康副本（绝不把旧捕获字节写进副本）', () => {
  const srcDir = mkdtemp('wc99-src-');
  const workDir = mkdtemp('wc99-work-');
  const name = '店AA.json';
  const workPath = path.join(workDir, name);
  const srcA = writeSource(srcDir, name, makeCookies(3, 'v1'));
  ensureWorkCopy({ sourceDir: srcDir, fileName: name, workDir });
  const previous = fs.readFileSync(workPath);
  const srcB = writeSource(srcDir, name, makeCookies(4, 'B'));

  let fired = false;
  const raceFs = makeProgFs({
    fsyncSync: (fd) => {
      fs.fsyncSync(fd);
      if (!fired) { fired = true; writeSource(srcDir, name, makeCookies(6, 'C-late')); } // 来源在窗口内又变
    },
  });
  const r = ensureWorkCopy({
    sourceDir: srcDir, fileName: name, workDir, fsMod: raceFs,
    authorizedFreshLogin: true, expectedSourceSha256: srcB.sha256,
  });
  assert.strictEqual(r.sourceSync.status, 'source-race-retained');
  assert.deepStrictEqual(fs.readFileSync(workPath), previous, '原健康副本逐字节保留');
  assert.deepStrictEqual(fs.readFileSync(workPath), srcA.buf);
  assert.ok(!fs.readdirSync(workDir).some((f) => f.includes('.tmp-') || f.endsWith('.lock')));
});

test('锁内目的 CAS：调用入口冻结基线之后副本被并发刷新 → dest-drift-retained，保留并发新文件', () => {
  const srcDir = mkdtemp('wc99-src-');
  const workDir = mkdtemp('wc99-work-');
  const name = '店AB.json';
  const workPath = path.join(workDir, name);
  writeSource(srcDir, name, makeCookies(3, 'v1'));
  ensureWorkCopy({ sourceDir: srcDir, fileName: name, workDir });
  const srcB = writeSource(srcDir, name, makeCookies(4, 'B'));
  const concurrent = Buffer.from(JSON.stringify(makeCookies(5, 'concurrent'), null, 2), 'utf8');

  let fired = false;
  const lockFs = makeProgFs({
    openSync: (p, flags, ...rest) => {
      const fd = fs.openSync(p, flags, ...rest);
      // 拿到工作根短锁的瞬间：另一写入者（写回链）刚刚刷新了副本
      if (!fired && String(p).endsWith('.lock')) { fired = true; fs.writeFileSync(workPath, concurrent); }
      return fd;
    },
  });
  const r = ensureWorkCopy({
    sourceDir: srcDir, fileName: name, workDir, fsMod: lockFs,
    authorizedFreshLogin: true, expectedSourceSha256: srcB.sha256,
  });
  assert.strictEqual(r.sourceSync.status, 'dest-drift-retained');
  assert.match(String(r.sourceSync.reason), /CAS/, '如实说明与写回链之间的 CAS 失败');
  assert.deepStrictEqual(fs.readFileSync(workPath), concurrent, '并发新文件保留，未被本次导入覆盖');
  assert.ok(fired);
});

// ── 12. S99：sidecar 更新失败恢复（旧 meta 不得导致覆盖已刷新副本）──

test('更新已有 sidecar 失败后：副本被写回刷新 → 下一轮普通解析不用旧来源覆盖；显式新登录才更新', () => {
  const srcDir = mkdtemp('wc99-src-');
  const workDir = mkdtemp('wc99-work-');
  const name = '店AC.json';
  const workPath = path.join(workDir, name);
  const srcA = writeSource(srcDir, name, makeCookies(3, 'v1'));
  ensureWorkCopy({ sourceDir: srcDir, fileName: name, workDir });

  // 已验证新登录：来源变 B，但 sidecar 提交（rename）失败
  const srcB = writeSource(srcDir, name, makeCookies(4, 'B'));
  const failMetaFs = makeProgFs({
    renameSync: (a, b) => {
      if (String(b).endsWith(META_SUFFIX)) throw new Error('synthetic metadata failure');
      return fs.renameSync(a, b);
    },
  });
  const r1 = ensureWorkCopy({
    sourceDir: srcDir, fileName: name, workDir, fsMod: failMetaFs,
    authorizedFreshLogin: true, expectedSourceSha256: srcB.sha256,
  });
  assert.strictEqual(r1.sourceSync.status, 'imported-sidecar-failed');
  assert.strictEqual(r1.sourceSync.sidecarFailed, true, '双文件提交未完成 → 不宣称原子/成功');
  assert.deepStrictEqual(fs.readFileSync(workPath), srcB.buf, '副本字节已提交');
  const staleMeta = JSON.parse(fs.readFileSync(workPath + META_SUFFIX, 'utf8'));
  assert.strictEqual(staleMeta.sourceSha256, srcA.sha256, 'sidecar 仍是过期记录（如实，不谎报）');

  // guard 写回把副本刷新为 C
  const copyC = Buffer.from(JSON.stringify(makeCookies(5, 'C'), null, 2), 'utf8');
  fs.writeFileSync(workPath, copyC);

  // 关键反例：下一轮普通解析看到 source B ≠ meta A，也绝不用 B 覆盖 C
  const r2 = ensureWorkCopy({ sourceDir: srcDir, fileName: name, workDir });
  assert.strictEqual(r2.sourceSync.status, 'source-diverged-kept');
  assert.deepStrictEqual(fs.readFileSync(workPath), copyC, '已刷新副本未被旧来源覆盖');

  // 只有下一次已验证新登录（携带本次 commit.sha256）才更新
  const srcD = writeSource(srcDir, name, makeCookies(6, 'D'));
  const r3 = ensureWorkCopy({
    sourceDir: srcDir, fileName: name, workDir,
    authorizedFreshLogin: true, expectedSourceSha256: srcD.sha256,
  });
  assert.strictEqual(r3.sourceSync.status, 'refreshed-from-source');
  assert.deepStrictEqual(fs.readFileSync(workPath), srcD.buf);
  const metaNow = JSON.parse(fs.readFileSync(workPath + META_SUFFIX, 'utf8'));
  assert.strictEqual(metaNow.sourceSha256, srcD.sha256, 'sidecar 由下一次已验证登录恢复');
});

// ── 13. S99：本次登录快照绑定（expectedSourceSha256 贯穿 helper 读取）──

test('expectedSourceSha256 绑定：helper 读到更晚来源快照 → source-snapshot-mismatch，副本零写入', () => {
  const srcDir = mkdtemp('wc99-src-');
  const workDir = mkdtemp('wc99-work-');
  const name = '店AD.json';
  const srcPath = path.join(srcDir, name);
  writeSource(srcDir, name, makeCookies(3, 'v1'));
  ensureWorkCopy({ sourceDir: srcDir, fileName: name, workDir });
  const copyBefore = fs.readFileSync(path.join(workDir, name));

  const verified = Buffer.from(JSON.stringify(makeCookies(4, 'verified'), null, 2), 'utf8');
  const later = Buffer.from(JSON.stringify(makeCookies(7, 'later'), null, 2), 'utf8');
  const lateFs = makeProgFs({
    readFileSync: (p, ...rest) => {
      if (path.resolve(String(p)) === path.resolve(srcPath)) return later; // helper 读到的是更晚快照
      return fs.readFileSync(p, ...rest);
    },
  });
  const r = ensureWorkCopy({
    sourceDir: srcDir, fileName: name, workDir, fsMod: lateFs,
    authorizedFreshLogin: true, expectedSourceSha256: sha256Of(verified),
  });
  assert.strictEqual(r.sourceSync.status, 'source-snapshot-mismatch');
  assert.match(String(r.sourceSync.reason), /本次已验证登录快照/, '如实说明拒绝理由');
  assert.deepStrictEqual(fs.readFileSync(r.path), copyBefore, '现有副本零写入');

  // 无副本时同样 fail-closed（抛错），不导入未经本次验证的快照
  const workDir2 = mkdtemp('wc99-work-');
  assert.throws(
    () => ensureWorkCopy({
      sourceDir: srcDir, fileName: name, workDir: workDir2, fsMod: lateFs,
      authorizedFreshLogin: true, expectedSourceSha256: sha256Of(verified),
    }),
    (e) => e instanceof AuthError && /快照不一致/.test(e.message)
  );
  assert.strictEqual(fs.existsSync(path.join(workDir2, name)), false, '失败时不留下半写副本');

  // 快照一致时才提交（正向对照）
  fs.writeFileSync(srcPath, verified);
  const r2 = ensureWorkCopy({
    sourceDir: srcDir, fileName: name, workDir,
    authorizedFreshLogin: true, expectedSourceSha256: sha256Of(verified),
  });
  assert.strictEqual(r2.sourceSync.status, 'refreshed-from-source');
  assert.deepStrictEqual(fs.readFileSync(r2.path), verified);
});

// ── 14. S99：实际 resolver 层的伪隔离拒绝 ──────────────────────

test('resolveCookieFile：不同字面路径 junction 别名到上游 → 拒绝（不把共享上游交给写回链）', () => {
  const srcDir = mkdtemp('wc99-src-');
  const parent = mkdtemp('wc99-alias-');
  writeSource(srcDir, '店AE.json', makeCookies(3, 'v1'));
  const alias = path.join(parent, 'work-alias');
  try {
    fs.symlinkSync(srcDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (_) {
    return; // 环境不允许创建目录链接时跳过该项
  }
  assert.throws(
    () => resolveCookieFile({ cookieSourceDir: srcDir }, '店AE', { workDir: alias }),
    (e) => e instanceof AuthError && /别名|重合/.test(e.message),
    '别名工作根指向上游 → 拒绝，不返回上游可写路径'
  );
  assert.deepStrictEqual(fs.readdirSync(srcDir), ['店AE.json'], '上游目录零写入/零残留');
});

test('resolveCookieFile：本地文件是符号链接 → 拒绝（来源缺失分支与无来源分支都不因 existsSync 放行）', () => {
  const srcDir = mkdtemp('wc99-src-');
  const workDir = mkdtemp('wc99-work-');
  const elsewhere = mkdtemp('wc99-other-');
  const outside = path.join(elsewhere, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify(makeCookies(2, 'outside'), null, 2));
  const linkPath = path.join(workDir, '店AF.json');
  try {
    fs.symlinkSync(outside, linkPath, 'file');
  } catch (_) {
    return; // Windows 非开发者模式可能禁止文件符号链接：环境不支持时跳过该项
  }
  const outsideBefore = fs.readFileSync(outside);
  assert.throws(
    () => resolveCookieFile({ cookieSourceDir: srcDir }, '店AF', { workDir }),
    (e) => e instanceof AuthError && /普通文件|别名/.test(e.message),
    '来源缺失分支：本地"副本"其实是外部文件的链接 → 拒绝'
  );
  assert.throws(
    () => resolveCookieFile({ cookieSourceDir: null }, '店AF', { workDir }),
    (e) => e instanceof AuthError && /普通文件|别名/.test(e.message),
    '无来源配置分支同样拒绝链接别名'
  );
  assert.deepStrictEqual(fs.readFileSync(outside), outsideBefore, '链接目标未被写入');
});

test('login.cookieWorkDir：配置绝对路径生效（隔离工作根）；相对路径如实拒绝，不静默写生产根', () => {
  const srcDir = mkdtemp('wc99-src-');
  const workDir = mkdtemp('wc99-work-');
  const src = writeSource(srcDir, '店AG.json', makeCookies(3, 'v1'));
  const r = resolveCookieFile({ cookieSourceDir: srcDir, cookieWorkDir: workDir }, '店AG');
  assert.strictEqual(r.path, path.join(workDir, '店AG.json'), '配置的工作根生效（无需 opts 注入）');
  assert.deepStrictEqual(fs.readFileSync(r.path), src.buf);
  assert.throws(
    () => resolveCookieFile({ cookieSourceDir: srcDir, cookieWorkDir: 'cookies-relative' }, '店AG'),
    (e) => e instanceof AuthError && /绝对路径/.test(e.message)
  );
});
