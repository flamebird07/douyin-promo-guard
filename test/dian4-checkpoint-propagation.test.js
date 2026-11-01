'use strict';

/**
 * DIAN-4 检查点传播测试 —— COOKIE-FOUR-REPAIR-20261024 重写。
 * 全部使用 os.tmpdir() 临时目录 + 合成 Cookie：绝不触及生产 cookies/、
 * cookie-recovery/、cookie-archive/、真实浏览器或网络。
 *
 * 新契约（本修复的验收点）：
 *  - 推广恢复副本（L3）与原始快照归档（L1）是只读角色：工作会话检查点
 *    永不反向刷新它们——propagateCommittedCheckpoint 的 recovery/archive
 *    固定 skipped、零写入（无论注入与否、并发与否、集合是否同源）；
 *  - 唯一保留的副作用是活 context 回灌（absorb，恰一次）；
 *  - 返回值与审计绝不含 Cookie 值。
 * 运行：node --test test/dian4-checkpoint-propagation.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { propagateCommittedCheckpoint } = require('../src/login/session-cookie-checkpoint');
const { writebackSessionCookies, fingerprintFile } = require('../src/login/cookie-writeback');
const vault = require('../../bill-manager/cookie-vault');

function sha(bufOrStr) {
  return crypto.createHash('sha256').update(bufOrStr).digest('hex');
}

function synthCookies(n = 4, tag = 'A') {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      name: `ck_${tag}_${i}`, value: `FAKE_NOT_REAL-${tag}-${i}`,
      domain: i === 0 ? '.fxg.jinritemai.com' : '.jinritemai.com',
      path: '/', expires: 2000000000, httpOnly: true, secure: true, sameSite: 'Lax',
    });
  }
  return out;
}

function mkRoots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dian4-prop-'));
  const r = {
    appRoot: base,
    guardRoot: base,
    archiveRoot: path.join(base, 'archive-raw'),
    recoveryDir: path.join(base, 'guard', 'cookie-recovery'),
    analyzerWorkDir: path.join(base, 'app', 'cookies'),
    guardWorkDir: path.join(base, 'guard', 'cookies'),
  };
  fs.mkdirSync(r.recoveryDir, { recursive: true });
  fs.mkdirSync(r.guardWorkDir, { recursive: true });
  fs.mkdirSync(r.analyzerWorkDir, { recursive: true });
  return r;
}

function committedFile(roots, name, cookies) {
  const p = path.join(roots.guardWorkDir, `${name}.json`);
  const serialized = JSON.stringify(cookies, null, 2);
  fs.writeFileSync(p, serialized);
  return { file: p, sha256: sha(serialized), cookies };
}

function recordingContext() {
  const calls = [];
  return {
    calls,
    addCookies: async (c) => { calls.push(Array.isArray(c) ? c.slice() : c); },
  };
}

function assertReadOnlyUntouched(roots, name) {
  assert.ok(!fs.existsSync(path.join(roots.recoveryDir, `${name}.json`)),
    'L3 固定路径零写入');
  assert.ok(!fs.existsSync(path.join(roots.recoveryDir, name)),
    'L3 版本目录零写入');
  assert.ok(!fs.existsSync(path.join(roots.archiveRoot, name)),
    'L1 归档零写入');
}

test('检查点零写只读层：恢复/归档固定 skipped，回灌恰一次，无 Cookie 泄漏', async () => {
  const roots = mkRoots();
  const c = committedFile(roots, '店甲', synthCookies(4, 'A'));
  const ctx = recordingContext();
  const audits = [];
  const r = await propagateCommittedCheckpoint({
    context: ctx, cookieFilePath: c.file, expectedSha256: c.sha256, finalCookies: c.cookies,
    vaultModule: vault, vaultRoots: roots, audit: (e) => audits.push(e),
  });
  assert.strictEqual(r.attempted, false, '不得进入任何只读层写路径');
  assert.strictEqual(r.recovery.ok, false);
  assert.strictEqual(r.recovery.skipped, true);
  assert.match(r.recovery.reason, /只读|反向刷新/);
  assert.strictEqual(r.archive.ok, false);
  assert.strictEqual(r.archive.skipped, true);
  assertReadOnlyUntouched(roots, '店甲');
  assert.strictEqual(ctx.calls.length, 1, 'addCookies 恰一次');
  assert.deepStrictEqual(ctx.calls[0], c.cookies, '回灌集合 = 本次最终已验证集合');
  assert.strictEqual(r.absorb.ok, true);
  const dump = JSON.stringify(r) + JSON.stringify(audits);
  for (const ck of c.cookies) assert.ok(!dump.includes(ck.value), `不得泄漏 Cookie 值（${ck.name}）`);
});

test('重复检查点仍零写只读层：第二次调用同样 skipped、无版本产生', async () => {
  const roots = mkRoots();
  const c1 = committedFile(roots, '店乙', synthCookies(4, 'A'));
  const c2 = committedFile(roots, '店乙', synthCookies(5, 'B'));
  for (const c of [c1, c2]) {
    const r = await propagateCommittedCheckpoint({
      cookieFilePath: c.file, expectedSha256: c.sha256, finalCookies: c.cookies,
      vaultModule: vault, vaultRoots: roots,
    });
    assert.strictEqual(r.recovery.ok, false);
    assert.strictEqual(r.recovery.skipped, true);
    assert.strictEqual(r.archive.skipped, true);
  }
  assertReadOnlyUntouched(roots, '店乙');
});

test('提交后工作副本被并发改写 → 同样零写入（本就无只读层写路径）', async () => {
  const roots = mkRoots();
  const c = committedFile(roots, '店丁', synthCookies(4, 'A'));
  fs.writeFileSync(c.file, JSON.stringify(synthCookies(6, 'Z'), null, 2));
  const r = await propagateCommittedCheckpoint({
    cookieFilePath: c.file, expectedSha256: c.sha256, finalCookies: c.cookies,
    vaultModule: vault, vaultRoots: roots,
  });
  assert.strictEqual(r.recovery.ok, false);
  assert.strictEqual(r.recovery.skipped, true);
  assertReadOnlyUntouched(roots, '店丁');
});

test('只注入 vaultModule 不注入 vaultRoots → 仍然零写入（无回落风险）', async () => {
  const roots = mkRoots();
  const c = committedFile(roots, '店己', synthCookies(4, 'A'));
  const r = await propagateCommittedCheckpoint({
    cookieFilePath: c.file, expectedSha256: c.sha256, finalCookies: c.cookies,
    vaultModule: vault,
  });
  assert.strictEqual(r.recovery.ok, false);
  assert.strictEqual(r.attempted, false);
  assert.strictEqual(r.recovery.skipped, true);
  assertReadOnlyUntouched(roots, '店己');
});

test('真实 vault 默认根下执行 → 真实恢复/归档目录全程不变', async () => {
  const roots = mkRoots();
  const c = committedFile(roots, '店辛', synthCookies(4, 'A'));
  const r = await propagateCommittedCheckpoint({
    cookieFilePath: c.file, expectedSha256: c.sha256, finalCookies: c.cookies,
    vaultModule: vault, vaultRoots: vault.defaultRoots({ appRoot: roots.appRoot, guardRoot: roots.guardRoot }),
  });
  assert.strictEqual(r.recovery.skipped, true);
  const realRecovery = path.join(__dirname, '..', 'cookie-recovery');
  const realArchive = path.join(__dirname, '..', '..', 'bill-manager', 'cookie-archive', 'raw');
  const recNow = fs.existsSync(realRecovery) ? fs.readdirSync(realRecovery).filter((f) => f === '店辛.json' || f === '店辛') : [];
  const arcNow = fs.existsSync(realArchive) ? fs.readdirSync(realArchive).filter((f) => f === '店辛') : [];
  assert.deepStrictEqual(recNow, [], '真实恢复目录不得出现测试店铺');
  assert.deepStrictEqual(arcNow, [], '真实归档目录不得出现测试店铺');
});

test('无注入默认路径调用 → 回灌仍按能力执行', async () => {
  const roots = mkRoots();
  const c = committedFile(roots, '店壬', synthCookies(4, 'A'));
  const ctx = recordingContext();
  const r = await propagateCommittedCheckpoint({
    context: ctx, cookieFilePath: c.file, expectedSha256: c.sha256, finalCookies: c.cookies,
  });
  assert.strictEqual(r.attempted, false);
  assert.strictEqual(r.recovery.skipped, true);
  assert.strictEqual(ctx.calls.length, 1, '回灌不依赖任何闸门（活 context 内存操作）');
});

test('addCookies 异常（消息含 Cookie 值）→ 固定脱敏文本，结果与审计零泄漏', async () => {
  const roots = mkRoots();
  const c = committedFile(roots, '店癸', synthCookies(4, 'A'));
  const leaky = new Error(`bad cookie value ${c.cookies[0].value}`);
  const audits = [];
  const r = await propagateCommittedCheckpoint({
    context: { addCookies: async () => { throw leaky; } },
    cookieFilePath: c.file, expectedSha256: c.sha256, finalCookies: c.cookies,
    vaultModule: vault, vaultRoots: roots, audit: (e) => audits.push(e),
  });
  assert.strictEqual(r.absorb.ok, false);
  assert.strictEqual(r.absorb.skipped, true);
  assert.ok(!JSON.stringify(r.absorb).includes(c.cookies[0].value), '异常消息绝不回显');
  assert.strictEqual(r.recovery.skipped, true, '回灌失败也不产生任何只读层写入');
  assert.ok(!JSON.stringify(audits).includes(c.cookies[0].value));
});

// ── 写入器移交句柄：不可枚举（audit JSON 不泄漏值）────────────────

test('writeback 成功结果：finalCookies 移交句柄不可枚举；JSON 序列化零泄漏；无验证器时不提供句柄', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dian4-wb-'));
  const prev = synthCookies(4, 'P');
  const file = path.join(dir, '店铺.json');
  fs.writeFileSync(file, JSON.stringify(prev, null, 2));
  const rotated = prev.map((c0) => ({ ...c0, value: `${c0.value}-rotated` }));
  const ctx = { cookies: async () => prev, addCookies: async () => {} };
  const audits = [];
  const r = await writebackSessionCookies({
    context: ctx, cookieFilePath: file, sessionStartFingerprint: fingerprintFile(file),
    identityOk: true, loginOk: true,
    precommitVerify: async () => ({ ok: true, finalCookies: rotated }),
    audit: (e) => audits.push(e),
    workRoot: dir,
  });
  assert.strictEqual(r.ok, true, r.reason || '');
  assert.strictEqual(r.wroteFinalSet, true);
  const d = Object.getOwnPropertyDescriptor(r, 'finalCookies');
  assert.ok(d && d.enumerable === false, '移交句柄必须存在且不可枚举');
  assert.deepStrictEqual(r.finalCookies, rotated);
  const dump = JSON.stringify(r) + JSON.stringify(audits);
  for (const ck of rotated) assert.ok(!dump.includes(ck.value), `audit JSON 不得含 Cookie 值（${ck.name}）`);

  // 无独立验证器（兼容路径）：不写 finalCookies 句柄，调用方按缺失降级
  const file2 = path.join(dir, '店铺2.json');
  fs.writeFileSync(file2, JSON.stringify(prev, null, 2));
  const r2 = await writebackSessionCookies({
    context: { cookies: async () => rotated }, cookieFilePath: file2,
    sessionStartFingerprint: fingerprintFile(file2), identityOk: true, loginOk: true,
    audit: () => {}, workRoot: dir,
  });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(Object.prototype.hasOwnProperty.call(r2, 'finalCookies'), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
