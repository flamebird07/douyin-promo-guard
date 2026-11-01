'use strict';

/**
 * Cookie 回写完整性回归（AD-GUARD-COOKIE-INTEGRITY-20261018）。
 *
 * 全部用例使用 OS 临时目录 + 合成 Cookie（值均为 FAKE_ 前缀，不是真实凭据），
 * 不启动浏览器、不触网、不读写任何真实店铺文件、不产生任何广告动作。
 *
 * 覆盖的已复现缺陷：
 *  1. 原集合中仍有效的认证 Cookie（sid_guard/sessionid 等）被删除 → 旧实现仍返回 ok；
 *  2. 同名条目 value 被置空 → 旧实现仍返回 ok；
 *  3. 同名条目被改写成已过期 → 旧实现仍返回 ok；
 *  4. 身份键不精确（同名不同 domain / 不同 partitionKey）不得冒充原条目；
 *  5. 非空 token 正常轮换 + 浮窗偏好新增 → 必须允许，且落盘字节与本次序列化完全一致；
 *  6. 旧集合中本就过期/空值的认证 Cookie 被移除 → 必须允许（不得永久阻断正常刷新）；
 *  7. 写后落盘被同形不同值的其他 writer 替换 → 不得假成功，也不得回滚覆盖他人内容；
 *  8. 既有域完整性/身份/冲突保护不放松；公共 sameCookieShape 保持兼容。
 *
 * 2026-10-18 第四轮补充（Root 独立反例 A–D 回归）：
 *  A. fsync 临时文件期间另一 writer 改写目标文件 → rename 前按冻结指纹复核，
 *     漂移则删本次临时文件、保留他人新文件、明确冲突（单元 + 完整回写链路）；
 *  B. expires=0 是 Unix epoch 已过期（-1 才是 Playwright 会话标记）：
 *     有效 sessionid 被改成 expires=0 必须拒绝；expires=-1 会话轮换仍允许；
 *  C. 同一身份键重复候选（有效+空 / 两个非空）保守拒绝；不同 partitionKey 可并存；
 *  D. context.cookies 任意异常与原 JSON 解析错误的内容（可能含 Cookie 值）不回显，
 *     仅保留无值的阶段原因/安全错误码；检查点自产标记 reasonSafeForAudit 的原因可回显。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  fingerprintFile,
  validateCookieSet,
  writebackSessionCookies,
  sameCookieShape,
  sha256Of,
  protectedAuthCookies,
  isExpiredCookie,
  atomicWriteSerialized,
  AUTH_COOKIE_NAMES,
} = require('../src/login/cookie-writeback');

const NOW = Math.floor(Date.now() / 1000);

function ck(name, value, over = {}) {
  const c = {
    name,
    value,
    domain: over.domain || '.jinritemai.com',
    path: over.path || '/',
    expires: over.expires === undefined ? NOW + 86400 : over.expires,
    httpOnly: over.httpOnly === undefined ? true : over.httpOnly,
    secure: true,
    sameSite: 'Lax',
  };
  if (over.partitionKey !== undefined) c.partitionKey = over.partitionKey;
  return c;
}

/** 与原店铺文件同构的合成集合：8 个认证 Cookie + 偏好 + 多域。 */
function baseSet() {
  return [
    ck('sessionid', 'FAKE_SESSIONID_A', { domain: '.fxg.jinritemai.com' }),
    ck('sessionid_ss', 'FAKE_SESSIONID_SS_A'),
    ck('sid_guard', 'FAKE_SID_GUARD_A'),
    ck('sid_tt', 'FAKE_SID_TT_A'),
    ck('uid_tt', 'FAKE_UID_TT_A'),
    ck('uid_tt_ss', 'FAKE_UID_TT_SS_A'),
    ck('sid_ucp_v1', 'FAKE_SID_UCP_A'),
    ck('ssid_ucp_v1', 'FAKE_SSID_UCP_A'),
    ck('fxg_shop_pref', 'pref-x', { domain: 'fxg.jinritemai.com' }),
    ck('compass_pref', 'pref-y', { domain: 'compass.jinritemai.com' }),
    ck('float_window_state', 'closed'),
  ];
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cookie-integrity-'));
}

function writeCookieFile(dir, cookies, name = '店铺.json') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(cookies, null, 2));
  return p;
}

function ctxOf(cookies) {
  return { cookies: async () => cookies };
}

function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function runWrite(file, next) {
  const audits = [];
  const r = await writebackSessionCookies({
    context: ctxOf(next),
    cookieFilePath: file,
    sessionStartFingerprint: fingerprintFile(file),
    identityOk: true,
    loginOk: true,
    shopId: '合成店',
    audit: (e) => audits.push(e),
  });
  return { r, audits };
}

/** 返回值/审计绝不含任何合成 Cookie 值（只允许名称/数量/指纹）。 */
function assertNoCookieValues(r, audits, cookies) {
  const dump = JSON.stringify({ r, audits });
  for (const c of cookies) {
    if (typeof c.value !== 'string' || c.value.length === 0) continue; // 空值无泄漏可言（includes('') 恒真）
    assert.ok(!dump.includes(c.value), `返回值/审计不得包含 Cookie 值（泄漏：${c.name}）`);
  }
}

// ── 1. 缺失关键认证 Cookie ─────────────────────────────────────────

test('原集合中有效的 sid_guard 在新集合缺失 → 拒绝覆盖，旧文件逐字节不变', async () => {
  const dir = tmpDir();
  const prev = baseSet();
  const file = writeCookieFile(dir, prev);
  const before = fs.readFileSync(file);
  const next = prev.filter((c) => c.name !== 'sid_guard');

  const v = validateCookieSet(next, prev);
  assert.strictEqual(v.ok, false, '纯校验必须拒绝');
  assert.ok(v.authMissing.includes('sid_guard'));

  const { r, audits } = await runWrite(file, next);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.skipped, true);
  assert.match(r.reason, /sid_guard/);
  assert.match(r.reason, /拒绝覆盖/);
  assert.ok(fs.readFileSync(file).equals(before), '旧文件必须逐字节保留');
  assert.ok(AUTH_COOKIE_NAMES.has('sid_guard'));
  assertNoCookieValues(r, audits, prev);
  rm(dir);
});

test('同名认证 Cookie value 被置空 → 拒绝覆盖，旧文件逐字节不变', async () => {
  const dir = tmpDir();
  const prev = baseSet();
  const file = writeCookieFile(dir, prev);
  const before = fs.readFileSync(file);
  const next = prev.map((c) => (c.name === 'sid_guard' ? { ...c, value: '' } : c));

  const v = validateCookieSet(next, prev);
  assert.strictEqual(v.ok, false);
  assert.ok(v.authEmpty.includes('sid_guard'));

  const { r, audits } = await runWrite(file, next);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.skipped, true);
  assert.match(r.reason, /空值.*sid_guard|sid_guard.*空值/);
  assert.match(r.reason, /拒绝覆盖/);
  assert.ok(fs.readFileSync(file).equals(before), '旧文件必须逐字节保留');
  assertNoCookieValues(r, audits, prev);
  rm(dir);
});

test('同名认证 Cookie 被改写成已过期 → 拒绝覆盖，旧文件逐字节不变', async () => {
  const dir = tmpDir();
  const prev = baseSet();
  const file = writeCookieFile(dir, prev);
  const before = fs.readFileSync(file);
  const next = prev.map((c) => (
    c.name === 'sid_guard' ? { ...c, value: 'FAKE_ROTATED_BUT_EXPIRED', expires: NOW - 3600 } : c
  ));

  const v = validateCookieSet(next, prev);
  assert.strictEqual(v.ok, false);
  assert.ok(v.authExpired.includes('sid_guard'));

  const { r, audits } = await runWrite(file, next);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.skipped, true);
  assert.match(r.reason, /已过期.*sid_guard|sid_guard.*已过期/);
  assert.ok(fs.readFileSync(file).equals(before), '旧文件必须逐字节保留');
  assertNoCookieValues(r, audits, prev);
  rm(dir);
});

// ── 2. 精确身份键 ──────────────────────────────────────────────────

test('身份键精确：同名但 domain/path/partitionKey 不同不得冒充原认证条目', () => {
  const prev = [
    ck('sessionid', 'FAKE_SESSIONID_A', { domain: '.fxg.jinritemai.com' }),
    ck('sid_guard', 'FAKE_SID_GUARD_A'),
  ];
  // 同名但换了 domain（.fxg → 根域）
  const movedDomain = [
    ck('sessionid', 'FAKE_SESSIONID_A2', { domain: '.jinritemai.com' }),
    ck('sid_guard', 'FAKE_SID_GUARD_A'),
  ];
  const v1 = validateCookieSet(movedDomain, prev);
  assert.strictEqual(v1.ok, false);
  assert.deepStrictEqual(v1.authMissing, ['sessionid']);

  // 同名但换了 path
  const movedPath = [
    ck('sessionid', 'FAKE_SESSIONID_A3', { domain: '.fxg.jinritemai.com', path: '/ffa' }),
    ck('sid_guard', 'FAKE_SID_GUARD_A'),
  ];
  const v2 = validateCookieSet(movedPath, prev);
  assert.strictEqual(v2.ok, false);
  assert.deepStrictEqual(v2.authMissing, ['sessionid']);

  // 同名同域但 partitionKey 不同
  const prevP = [
    ck('sessionid', 'FAKE_SESSIONID_P', { partitionKey: 'https://a.example' }),
    ck('sid_guard', 'FAKE_SID_GUARD_P'),
  ];
  const movedPartition = [
    ck('sessionid', 'FAKE_SESSIONID_P2', { partitionKey: 'https://b.example' }),
    ck('sid_guard', 'FAKE_SID_GUARD_P'),
  ];
  const v3 = validateCookieSet(movedPartition, prevP);
  assert.strictEqual(v3.ok, false);
  assert.deepStrictEqual(v3.authMissing, ['sessionid']);
});

// ── 3. 正常轮换 + 偏好新增 ──────────────────────────────────────────

test('非空 token 正常轮换 + 浮窗偏好新增 → 允许；落盘字节=本次序列化，写后指纹一致', async () => {
  const dir = tmpDir();
  const prev = baseSet();
  const file = writeCookieFile(dir, prev);
  const next = prev.map((c) => {
    if (c.name === 'sessionid') return { ...c, value: 'FAKE_SESSIONID_ROTATED_B' };
    if (c.name === 'sid_guard') return { ...c, value: 'FAKE_SID_GUARD_ROTATED_B' };
    if (c.name === 'ssid_ucp_v1') return { ...c, value: 'FAKE_SSID_UCP_ROTATED_B' };
    return c;
  });
  // 新增浮窗偏好（非认证，必须允许写入）
  next.push(ck('float_window_pref', 'open', { domain: '.jinritemai.com', httpOnly: false }));

  const { r, audits } = await runWrite(file, next);
  assert.strictEqual(r.ok, true, r.reason || '');
  assert.strictEqual(r.count, next.length);
  assert.strictEqual(r.verification, 'exact-bytes');

  // 序列化后准确回读：落盘字节与本次序列化逐字节一致
  const expected = JSON.stringify(next, null, 2);
  const onDiskText = fs.readFileSync(file, 'utf-8');
  assert.strictEqual(onDiskText, expected, '落盘内容必须与本次序列化完全一致');
  const onDisk = JSON.parse(onDiskText);
  assert.deepStrictEqual(onDisk, next);
  assert.strictEqual(sameCookieShape(onDisk, next), true);

  // 自有写入指纹：写入前拟写字节的 sha 必须等于写后落盘 sha
  const expectedSha = sha256Of(Buffer.from(expected, 'utf8'));
  assert.strictEqual(r.expectedSha256, expectedSha);
  assert.strictEqual(r.afterSha256, expectedSha);
  assert.deepStrictEqual(r.domains.sort(), [...new Set(next.map((c) => c.domain))].sort());
  assert.ok(r.protectedAuth.includes('sessionid'));
  assert.ok(r.protectedAuth.includes('sid_guard'));

  // 审计可含阶段/数量/指纹，但绝不含值
  assert.ok(audits.some((e) => e.phase === 'done' && e.expectedSha256 === expectedSha));
  assertNoCookieValues(r, audits, next);
  rm(dir);
});

// ── 4. 旧集合本就过期/空值的令牌被移除 → 允许 ─────────────────────

test('旧集合中早已过期的认证 Cookie（及空值条目）被浏览器清理 → 允许刷新，不永久阻断', async () => {
  const dir = tmpDir();
  const prev = baseSet().map((c) => {
    if (c.name === 'sid_guard') return { ...c, expires: NOW - 7200, value: 'FAKE_OLD_EXPIRED' };
    if (c.name === 'uid_tt_ss') return { ...c, value: '' };
    return c;
  });
  const file = writeCookieFile(dir, prev);
  const next = prev.filter((c) => c.name !== 'sid_guard' && c.name !== 'uid_tt_ss');

  const protectedNames = protectedAuthCookies(prev).map((c) => c.name);
  assert.ok(!protectedNames.includes('sid_guard'), '过期旧令牌不在保护范围');
  assert.ok(!protectedNames.includes('uid_tt_ss'), '空值旧条目不在保护范围');
  assert.ok(protectedNames.includes('sessionid'), '仍有效的认证条目仍在保护范围');

  const v = validateCookieSet(next, prev);
  assert.strictEqual(v.ok, true, v.reason || '');

  const { r, audits } = await runWrite(file, next);
  assert.strictEqual(r.ok, true, r.reason || '');
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.ok(!onDisk.some((c) => c.name === 'sid_guard'));
  assert.ok(!onDisk.some((c) => c.name === 'uid_tt_ss'));
  assertNoCookieValues(r, audits, next);
  rm(dir);
});

test('旧集合没有认证 Cookie 时不臆造必需项：普通偏好集合仍可正常写回', async () => {
  const dir = tmpDir();
  const prev = [ck('pref_a', 'a'), ck('pref_b', 'b', { domain: 'fxg.jinritemai.com' })];
  const file = writeCookieFile(dir, prev);
  assert.deepStrictEqual(protectedAuthCookies(prev), []);
  const next = prev.concat([ck('pref_c', 'c', { domain: 'compass.jinritemai.com' })]);
  const { r } = await runWrite(file, next);
  assert.strictEqual(r.ok, true, r.reason || '');
  assert.deepStrictEqual(r.protectedAuth, []);
  rm(dir);
});

// ── 5. 写后同形不同值替换：不得假成功 / 不得回滚覆盖 ────────────────

test('写后被同形不同值的其他 writer 替换 → 不得假成功，且不得回滚覆盖他人内容', async () => {
  const dir = tmpDir();
  const prev = baseSet();
  const file = writeCookieFile(dir, prev);
  const next = baseSet().map((c) => (
    c.name === 'sid_guard' ? { ...c, value: 'FAKE_SID_GUARD_ROTATED' } : c
  ));
  const concurrent = baseSet().map((c) => (
    c.name === 'sid_guard' ? { ...c, value: 'FAKE_CONCURRENT_WRITER' } : c
  ));
  // 前置：同条数、同域名分布（同形），仅值不同
  assert.strictEqual(next.length, concurrent.length);
  assert.strictEqual(sameCookieShape(next, concurrent), true);

  const origRename = fs.renameSync;
  let injected = false;
  fs.renameSync = function patchedRename(src, dest) {
    const ret = origRename.call(fs, src, dest);
    // 模拟：本次 rename 落盘后、写后校验读回前，另一个 writer 用同形不同值覆盖
    if (!injected && path.resolve(String(dest)) === path.resolve(file)) {
      injected = true;
      fs.writeFileSync(file, JSON.stringify(concurrent, null, 2));
    }
    return ret;
  };

  try {
    const { r, audits } = await runWrite(file, next);
    assert.strictEqual(injected, true, '前置：并发替换确实发生在本次 rename 之后');
    assert.strictEqual(r.ok, false, '同形不同值绝不得假成功');
    assert.strictEqual(r.skipped, false);
    assert.strictEqual(r.conflict, true);
    assert.match(r.reason, /不一致|替换/);
    assert.strictEqual(r.rollback, 'skipped-conflict', '不得回滚');
    assert.strictEqual(r.expectedSha256, sha256Of(Buffer.from(JSON.stringify(next, null, 2))));
    assert.strictEqual(r.afterSha256, sha256Of(Buffer.from(JSON.stringify(concurrent, null, 2))));
    assert.notStrictEqual(r.afterSha256, r.expectedSha256);

    const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
    assert.deepStrictEqual(onDisk, concurrent, '其他 writer 的并发新内容不得被回滚覆盖');
    assert.ok(!JSON.stringify({ r, audits }).includes('FAKE_CONCURRENT_WRITER'));
    assert.ok(!JSON.stringify({ r, audits }).includes('FAKE_SID_GUARD_ROTATED'));
  } finally {
    fs.renameSync = origRename;
  }
  rm(dir);
});

// ── 6. 既有保护不放松 ──────────────────────────────────────────────

test('既有域完整性/身份核验/会话冲突保护不放松', async () => {
  const dir = tmpDir();
  const prev = baseSet();
  const file = writeCookieFile(dir, prev);
  const start = fingerprintFile(file);

  // 域完整性：缺少罗盘域（认证 Cookie 全部保留）仍拒绝
  const noCompass = prev.filter((c) => c.domain !== 'compass.jinritemai.com');
  const a = await writebackSessionCookies({
    context: ctxOf(noCompass), cookieFilePath: file, sessionStartFingerprint: start,
    identityOk: true, loginOk: true,
  });
  assert.strictEqual(a.ok, false);
  assert.match(a.reason, /关键域/);

  // 身份核验未通过
  const b = await writebackSessionCookies({
    context: ctxOf(prev), cookieFilePath: file, sessionStartFingerprint: start,
    identityOk: false, loginOk: true,
  });
  assert.strictEqual(b.ok, false);
  assert.match(b.reason, /身份核验未通过/);

  // 会话期间文件被改动 → 冲突保护仍是"保留较新文件"
  const fresh = prev.concat([ck('fresh_login', 'FAKE_FRESH_LOGIN')]);
  fs.writeFileSync(file, JSON.stringify(fresh, null, 2));
  const c = await writebackSessionCookies({
    context: ctxOf(prev), cookieFilePath: file, sessionStartFingerprint: start,
    identityOk: true, loginOk: true,
  });
  assert.strictEqual(c.ok, false);
  assert.strictEqual(c.conflict, true);
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), fresh);
  rm(dir);
});

// ── 7. 公共 sameCookieShape 兼容性 ─────────────────────────────────

test('公共 sameCookieShape 保持兼容（只描述形状，不参与最终写入判定）', () => {
  const a = baseSet();
  const sameShapeDifferentValues = baseSet().map((c) => ({ ...c, value: 'FAKE_DIFFERENT' }));
  assert.strictEqual(sameCookieShape(a, sameShapeDifferentValues), true);
  assert.strictEqual(sameCookieShape(a, a.slice(1)), false);
  assert.strictEqual(sameCookieShape(a, null), false);
});

// ── A. fsync 后、rename 前按冻结指纹复核（Root 反例 A）─────────────

test('A: fsync 临时文件期间另一 writer 改写目标文件 → rename 前复核拒绝覆盖，删临时文件、保留他人新文件', () => {
  const dir = tmpDir();
  const prev = baseSet();
  const file = writeCookieFile(dir, prev);
  const frozenSha = sha256Of(fs.readFileSync(file));
  const other = baseSet().map((c) => (c.name === 'sid_guard' ? { ...c, value: 'FAKE_OTHER_WRITER' } : c));
  const next = baseSet().map((c) => (c.name === 'sid_guard' ? { ...c, value: 'FAKE_MINE_ROTATED' } : c));

  const origFsync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = function patchedFsync(fd) {
    const ret = origFsync.call(fs, fd);
    if (!injected) { injected = true; fs.writeFileSync(file, JSON.stringify(other, null, 2)); }
    return ret;
  };
  try {
    const w = atomicWriteSerialized(file, JSON.stringify(next, null, 2), frozenSha);
    assert.strictEqual(injected, true, '前置：并发改写确实发生在 fsync 之后、rename 之前');
    assert.strictEqual(w.ok, false, '目标漂移时 rename 仍覆盖并返回成功即为本反例，必须拒绝');
    assert.strictEqual(w.conflict, true);
    assert.strictEqual(w.beforeSha256, frozenSha);
    assert.notStrictEqual(w.afterSha256, frozenSha);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), other, '他人新文件必须保留');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), [], '本次临时文件必须删除');
  } finally {
    fs.fsyncSync = origFsync;
  }
  rm(dir);
});

test('A: 完整回写链路 fsync 期间目标被改写 → write 阶段冲突记录，不假成功、不覆盖他人内容', async () => {
  const dir = tmpDir();
  const prev = baseSet();
  const file = writeCookieFile(dir, prev);
  const next = baseSet().map((c) => (c.name === 'sid_guard' ? { ...c, value: 'FAKE_MINE_ROTATED' } : c));
  const other = baseSet().map((c) => (c.name === 'sid_guard' ? { ...c, value: 'FAKE_OTHER_WRITER' } : c));

  const origFsync = fs.fsyncSync;
  let injected = false;
  fs.fsyncSync = function patchedFsync(fd) {
    const ret = origFsync.call(fs, fd);
    if (!injected) { injected = true; fs.writeFileSync(file, JSON.stringify(other, null, 2)); }
    return ret;
  };
  try {
    const { r, audits } = await runWrite(file, next);
    assert.strictEqual(injected, true);
    assert.strictEqual(r.ok, false, '不得假成功');
    assert.strictEqual(r.phase, 'write');
    assert.strictEqual(r.conflict, true);
    assert.strictEqual(r.rollback, 'skipped-conflict');
    assert.strictEqual(r.beforeSha256, sha256Of(Buffer.from(JSON.stringify(prev, null, 2), 'utf8')));
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), other, '他人新文件保留，不被本次内容覆盖');
    assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), []);
    const dump = JSON.stringify({ r, audits });
    assert.ok(!dump.includes('FAKE_OTHER_WRITER') && !dump.includes('FAKE_MINE_ROTATED'));
  } finally {
    fs.fsyncSync = origFsync;
  }
  rm(dir);
});

test('A: 无漂移时冻结指纹复核不影响正常写入（公共 API 兼容：第三参可选）', () => {
  const dir = tmpDir();
  const file = writeCookieFile(dir, baseSet());
  const frozenSha = sha256Of(fs.readFileSync(file));
  const next = baseSet().map((c) => (c.name === 'sid_guard' ? { ...c, value: 'FAKE_MINE_ROTATED' } : c));
  const w1 = atomicWriteSerialized(file, JSON.stringify(next, null, 2), frozenSha);
  assert.strictEqual(w1.ok, true, '目标未漂移 → 正常写入');
  assert.strictEqual(w1.sha256, sha256Of(Buffer.from(JSON.stringify(next, null, 2), 'utf8')));
  const w2 = atomicWriteSerialized(file, JSON.stringify(next, null, 2));
  assert.strictEqual(w2.ok, true, '不传冻结指纹（旧调用形态）仍兼容');
  rm(dir);
});

// ── B. expires=0 是 epoch 已过期，不是会话 Cookie（Root 反例 B）────

test('B: isExpiredCookie 判定：0→已过期；-1/缺失/null→会话 Cookie；负数不判过期；过去/未来按秒级时间戳', () => {
  assert.strictEqual(isExpiredCookie({ name: 'x', expires: 0 }), true, 'expires=0 是 Unix epoch 已过期，绝不是会话标记');
  assert.strictEqual(isExpiredCookie({ name: 'x', expires: -1 }), false, '-1 是 Playwright 会话 Cookie 标记');
  assert.strictEqual(isExpiredCookie({ name: 'x' }), false, '缺失 expires 视为会话 Cookie');
  assert.strictEqual(isExpiredCookie({ name: 'x', expires: null }), false, 'null 视为会话 Cookie（不得按 0 判过期）');
  assert.strictEqual(isExpiredCookie({ name: 'x', expires: NOW - 1 }), true);
  assert.strictEqual(isExpiredCookie({ name: 'x', expires: NOW + 3600 }), false);
});

test('B: 有效 sessionid 被改写成 expires=0 → 拒绝覆盖，旧文件逐字节不变', async () => {
  const dir = tmpDir();
  const prev = baseSet();
  const file = writeCookieFile(dir, prev);
  const before = fs.readFileSync(file);
  const next = prev.map((c) => (c.name === 'sessionid' ? { ...c, value: 'FAKE_SESSIONID_E0', expires: 0 } : c));

  const v = validateCookieSet(next, prev);
  assert.strictEqual(v.ok, false, 'expires=0 的认证条目不得放行');
  assert.ok(v.authExpired.includes('sessionid'));

  const { r, audits } = await runWrite(file, next);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.skipped, true);
  assert.match(r.reason, /已过期.*sessionid|sessionid.*已过期/);
  assert.ok(fs.readFileSync(file).equals(before), '旧文件必须逐字节保留');
  assertNoCookieValues(r, audits, next);
  rm(dir);
});

test('B: 非空 token 轮换为会话 Cookie（expires=-1）仍允许，不阻断正常刷新', async () => {
  const dir = tmpDir();
  const prev = baseSet();
  const file = writeCookieFile(dir, prev);
  const next = prev.map((c) => (c.name === 'sessionid' ? { ...c, value: 'FAKE_SESSIONID_SESS', expires: -1 } : c));
  const v = validateCookieSet(next, prev);
  assert.strictEqual(v.ok, true, v.reason || '');
  const { r } = await runWrite(file, next);
  assert.strictEqual(r.ok, true, r.reason || '');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')), next);
  rm(dir);
});

// ── C. 同一身份键重复候选保守拒绝（Root 反例 C）─────────────────────

test('C: 同一身份键一个有效 sessionid + 一个空 sessionid → 保守拒绝，旧文件逐字节不变', async () => {
  const dir = tmpDir();
  const prev = baseSet();
  const file = writeCookieFile(dir, prev);
  const before = fs.readFileSync(file);
  const rotated = prev.map((c) => (c.name === 'sessionid' ? { ...c, value: 'FAKE_SESSIONID_OK' } : c));
  const next = rotated.concat([{ ...rotated.find((c) => c.name === 'sessionid'), value: '' }]);

  const v = validateCookieSet(next, prev);
  assert.strictEqual(v.ok, false, '重复候选不得按"任一有效"放行（重新注入可能后者覆盖前者）');
  assert.ok(v.authDuplicate.includes('sessionid'));

  const { r, audits } = await runWrite(file, next);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.skipped, true);
  assert.match(r.reason, /重复候选/);
  assert.ok(r.authDuplicate.includes('sessionid'));
  assert.ok(fs.readFileSync(file).equals(before), '旧文件必须逐字节保留');
  assertNoCookieValues(r, audits, next);
  rm(dir);
});

test('C: 同一身份键两个非空候选也保守拒绝；不同 partitionKey 是不同身份键，可并存', () => {
  const prev = [
    ck('sessionid', 'FAKE_A', { partitionKey: 'https://a.example' }),
    ck('sid_guard', 'FAKE_G'),
  ];
  const dupBothNonEmpty = [
    ck('sessionid', 'FAKE_A1', { partitionKey: 'https://a.example' }),
    ck('sessionid', 'FAKE_A2', { partitionKey: 'https://a.example' }),
    ck('sid_guard', 'FAKE_G'),
  ];
  const v1 = validateCookieSet(dupBothNonEmpty, prev);
  assert.strictEqual(v1.ok, false);
  assert.ok(v1.authDuplicate.includes('sessionid'));

  const coexist = [
    ck('sessionid', 'FAKE_A1', { partitionKey: 'https://a.example' }),
    ck('sessionid', 'FAKE_B1', { partitionKey: 'https://b.example' }),
    ck('sid_guard', 'FAKE_G'),
  ];
  const v2 = validateCookieSet(coexist, prev);
  assert.strictEqual(v2.ok, true, v2.reason || '');
});

// ── D. 异常内容脱敏：不回显可能含 Cookie 值的原始异常（Root 反例 D）──

test('D: context.cookies 任意异常 message 含 Cookie 值 → 不回显，降级为安全错误码，旧文件不变', async () => {
  const dir = tmpDir();
  const prev = baseSet();
  const file = writeCookieFile(dir, prev);
  const before = fs.readFileSync(file);
  const audits = [];
  const r = await writebackSessionCookies({
    context: {
      cookies: async () => {
        throw new Error('invalid cookie state: sessionid=FAKE_SECRET_LEAK; sid_guard=FAKE_GUARD_LEAK');
      },
    },
    cookieFilePath: file,
    sessionStartFingerprint: fingerprintFile(file),
    identityOk: true,
    loginOk: true,
    audit: (e) => audits.push(e),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.skipped, true);
  assert.match(r.reason, /context-cookies-read-failed/, '保留无值的安全错误码');
  const dump = JSON.stringify({ r, audits });
  assert.ok(!dump.includes('FAKE_SECRET_LEAK'), '不得回显任意异常内容（Cookie 值）');
  assert.ok(!dump.includes('FAKE_GUARD_LEAK'));
  assert.ok(!dump.includes('invalid cookie state'), '原始异常片段不得进入审计');
  assert.ok(fs.readFileSync(file).equals(before));
  rm(dir);
});

test('D: 检查点自产原因（reasonSafeForAudit=true）可回显；原 JSON 解析失败不回显文件片段', async () => {
  const dir = tmpDir();
  const prev = baseSet();
  const file = writeCookieFile(dir, prev);
  const safeErr = new Error('Cookie 取回后当前事实复验失败（测试阶段原因）');
  safeErr.reasonSafeForAudit = true;
  const r1 = await writebackSessionCookies({
    context: { cookies: async () => { throw safeErr; } },
    cookieFilePath: file,
    sessionStartFingerprint: fingerprintFile(file),
    identityOk: true,
    loginOk: true,
  });
  assert.strictEqual(r1.ok, false);
  assert.match(r1.reason, /复验失败（测试阶段原因）/, '检查点自产的无值阶段原因保留可追查性');

  const badFile = path.join(dir, '损坏.json');
  fs.writeFileSync(badFile, 'not-json FAKE_FRAGMENT_XYZ');
  const r2 = await writebackSessionCookies({
    context: ctxOf(prev),
    cookieFilePath: badFile,
    sessionStartFingerprint: fingerprintFile(badFile),
    identityOk: true,
    loginOk: true,
  });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.reason, /解析失败/);
  assert.ok(!JSON.stringify(r2).includes('FAKE_FRAGMENT_XYZ'), 'JSON 解析错误的原始片段不得回显');
  rm(dir);
});
