'use strict';

/**
 * 会话 Cookie 回写回归测试（2026-09-16 用户明确授权的定点能力）。
 *
 * 全部用例使用**临时目录 + 合成 Cookie**，不读取、不写入任何真实凭据文件，
 * 不启动浏览器、不触网、不操作真实广告。
 *
 * 覆盖：
 *  - 正常回写（原子写入）+ 下次加载确实读到保存结果；
 *  - 原子写入失败 → 旧文件保留、无临时文件残留；
 *  - 空/非法 Cookie、缺少 name/domain、缺少抖店/千川关键域、条数塌缩 → 一律拒绝覆盖；
 *  - 登录失效 / 身份不符 → 拒绝覆盖；
 *  - 会话期间源文件被改动（用户重新登录）→ 冲突保护：保留较新文件，不做无依据合并；
 *  - 返回值与审计**绝不含任何 Cookie 值**。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  fingerprintFile, validateCookieSet, atomicWriteJson, writebackSessionCookies, sameCookieShape,
} = require('../src/login/cookie-writeback');
const { inspectCookieFile } = require('../src/login/session');

/** 合成 Cookie 集合（与原店铺文件同构：多域、含抖店/千川/罗盘域）。 */
function synthCookies(overrides = {}) {
  const base = [];
  const add = (domain, n, prefix) => {
    for (let i = 0; i < n; i += 1) {
      base.push({ name: `${prefix}_${i}`, value: `v-${prefix}-${i}`, domain, path: '/', expires: 2000000000, httpOnly: false, secure: true, sameSite: 'Lax' });
    }
  };
  add('fxg.jinritemai.com', 4, 'fxg');
  add('.jinritemai.com', 6, 'root');
  add('compass.jinritemai.com', 2, 'compass');
  add('.doudian-sso.jinritemai.com', 3, 'sso');
  add('.hm.baidu.com', 1, 'baidu');
  return overrides.cookies || base;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cf-cookie-wb-'));
}

function writeCookieFile(dir, cookies, name = '店铺.json') {
  const p = path.join(dir, name);
  fs.writeFileSync(p, JSON.stringify(cookies, null, 2));
  return p;
}

function ctxOf(cookies) {
  return { cookies: async () => cookies };
}

// ── 正常路径 ──────────────────────────────────────────────────────

test('正常回写：原子写入成功；下次加载确实读到保存结果；返回值不含任何 Cookie 值', async () => {
  const dir = tmpDir();
  const prev = synthCookies();
  const file = writeCookieFile(dir, prev);
  const start = fingerprintFile(file);
  // 本次会话更新后的集合：原域全部保留 + 新增 1 条（模拟平台轮换）
  const next = prev.concat([{ name: 'new_token', value: 'rotated-abc', domain: '.jinritemai.com', path: '/', expires: 2000000000, httpOnly: true, secure: true, sameSite: 'Lax' }]);
  const audits = [];
  const r = await writebackSessionCookies({
    context: ctxOf(next), cookieFilePath: file, sessionStartFingerprint: start,
    identityOk: true, shopId: '瑾漂亮潮流服饰', audit: (e) => audits.push(e),
  });
  assert.strictEqual(r.ok, true, r.reason || '');
  assert.strictEqual(r.count, next.length);
  assert.ok(r.domains.includes('.jinritemai.com'));
  assert.ok(r.bytes > 0);

  // 下次加载：文件内容 = 本次保存结果（条数/域名/值一致）
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf-8'));
  assert.strictEqual(onDisk.length, next.length);
  assert.ok(sameCookieShape(onDisk, next));
  const meta = inspectCookieFile(file, false);
  assert.strictEqual(meta.count, next.length, '下次会话按该文件加载，读到的就是本次保存结果');
  assert.ok(meta.domains.includes('fxg.jinritemai.com'));
  assert.ok(meta.domains.includes('compass.jinritemai.com'));

  // 绝不输出 Cookie 值
  const dump = JSON.stringify(r) + JSON.stringify(audits);
  for (const c of next) {
    assert.ok(!dump.includes(c.value), `返回值/审计不得包含 Cookie 值（泄漏：${c.name}）`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('原子写入失败（序列化异常）：旧文件保留、无临时文件残留', async () => {
  const dir = tmpDir();
  const prev = synthCookies();
  const file = writeCookieFile(dir, prev);
  const before = fs.readFileSync(file, 'utf-8');

  const circ = { name: 'loop', value: 'v', domain: '.jinritemai.com' };
  circ.self = circ; // 不可序列化
  const bad = prev.concat([circ]);
  const r = await writebackSessionCookies({
    context: ctxOf(bad), cookieFilePath: file, sessionStartFingerprint: fingerprintFile(file),
    identityOk: true, audit: () => {},
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.skipped, false, '这是"保存失败"，不是"按规则跳过"');
  assert.match(r.reason, /回写失败|旧文件保留/);
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), before, '旧文件必须保持原样');
  assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp-')), [], '不得残留临时文件');

  // 直接验证原子写入原语
  const w = atomicWriteJson(file, circ);
  assert.strictEqual(w.ok, false);
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ── 拒绝覆盖 ──────────────────────────────────────────────────────

test('空 Cookie 集合：拒绝覆盖（登录态可疑）', async () => {
  const dir = tmpDir();
  const prev = synthCookies();
  const file = writeCookieFile(dir, prev);
  const before = fs.readFileSync(file, 'utf-8');
  const r = await writebackSessionCookies({
    context: ctxOf([]), cookieFilePath: file, sessionStartFingerprint: fingerprintFile(file),
    identityOk: true, audit: () => {},
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.skipped, true);
  assert.match(r.reason, /空|拒绝覆盖/);
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('非法条目（缺 name/domain、value 非字符串）：拒绝覆盖', async () => {
  const dir = tmpDir();
  const file = writeCookieFile(dir, synthCookies());
  const bad = [
    { value: 'v', domain: '.jinritemai.com' },
    { name: 'a', value: 'v', domain: '.jinritemai.com' },
  ];
  const r1 = await writebackSessionCookies({ context: ctxOf(bad), cookieFilePath: file, sessionStartFingerprint: fingerprintFile(file), identityOk: true, audit: () => {} });
  assert.strictEqual(r1.ok, false);
  assert.match(r1.reason, /name|domain/);
  const r2 = await writebackSessionCookies({ context: ctxOf([{ name: 'a', value: 1, domain: '.jinritemai.com' }]), cookieFilePath: file, sessionStartFingerprint: fingerprintFile(file), identityOk: true, audit: () => {} });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.reason, /value/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('只保存千川域、丢掉抖店/罗盘域：拒绝覆盖（防止覆盖掉其他有效域）', async () => {
  const dir = tmpDir();
  const prev = synthCookies();
  const file = writeCookieFile(dir, prev);
  const before = fs.readFileSync(file, 'utf-8');
  // 典型危险场景：只从千川页面拿到部分域
  const partial = synthCookies().filter((c) => c.domain === 'fxg.jinritemai.com' || c.domain === '.jinritemai.com');
  const r = await writebackSessionCookies({
    context: ctxOf(partial), cookieFilePath: file, sessionStartFingerprint: fingerprintFile(file),
    identityOk: true, audit: () => {},
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.skipped, true);
  assert.match(r.reason, /关键域|拒绝覆盖/);
  assert.ok(r.reason.includes('compass.jinritemai.com') || r.reason.includes('doudian-sso.jinritemai.com'));
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), before, '拒绝覆盖 → 旧文件保持原样');

  // 纯逻辑断言：validateCookieSet 可直接给出缺失域
  const v = validateCookieSet(partial, prev);
  assert.strictEqual(v.ok, false);
  assert.ok(v.droppedCritical.length >= 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('条数塌缩（域齐全但只剩极少条目）：拒绝覆盖', async () => {
  const dir = tmpDir();
  const prev = synthCookies(); // 16 条 / 5 个域
  const file = writeCookieFile(dir, prev);
  // 每个域各保留 1 条 → 域齐全（不会命中"缺关键域"），但整体条数塌缩
  const seen = new Set();
  const collapsed = prev.filter((c) => { if (seen.has(c.domain)) return false; seen.add(c.domain); return true; });
  assert.ok(collapsed.length < prev.length * 0.6, '构造的塌缩集合应低于保护线');
  const r = await writebackSessionCookies({
    context: ctxOf(collapsed), cookieFilePath: file, sessionStartFingerprint: fingerprintFile(file),
    identityOk: true, audit: () => {},
  });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /塌缩|拒绝覆盖/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('登录失效 / 身份不符：拒绝覆盖', async () => {
  const dir = tmpDir();
  const file = writeCookieFile(dir, synthCookies());
  const before = fs.readFileSync(file, 'utf-8');
  const r1 = await writebackSessionCookies({ context: ctxOf(synthCookies()), cookieFilePath: file, sessionStartFingerprint: fingerprintFile(file), identityOk: true, loginOk: false, audit: () => {} });
  assert.strictEqual(r1.ok, false);
  assert.match(r1.reason, /登录态无效/);
  const r2 = await writebackSessionCookies({ context: ctxOf(synthCookies()), cookieFilePath: file, sessionStartFingerprint: fingerprintFile(file), identityOk: false, audit: () => {} });
  assert.strictEqual(r2.ok, false);
  assert.match(r2.reason, /身份核验未通过/);
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), before);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('未提供路径 / 路径非法：拒绝写入任意路径', async () => {
  const r = await writebackSessionCookies({ context: ctxOf(synthCookies()), cookieFilePath: null, identityOk: true, audit: () => {} });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /路径/);
});

// ── 冲突保护（用户重新登录）───────────────────────────────────────

test('冲突保护：会话期间源文件被改变（用户重新登录）→ 保留较新文件，不做无依据合并', async () => {
  const dir = tmpDir();
  const prev = synthCookies();
  const file = writeCookieFile(dir, prev);
  const sessionStart = fingerprintFile(file); // 会话开始指纹
  // 会话进行中：用户重新登录 → 文件被新会话覆盖（更"新"）
  const relogin = synthCookies().concat([{ name: 'fresh_login', value: 'brand-new-session', domain: 'fxg.jinritemai.com', path: '/', expires: 2000000000, httpOnly: true, secure: true, sameSite: 'Lax' }]);
  fs.writeFileSync(file, JSON.stringify(relogin, null, 2));
  const newer = fs.readFileSync(file, 'utf-8');

  const audits = [];
  const r = await writebackSessionCookies({
    context: ctxOf(prev.concat([{ name: 'stale', value: 'stale-session', domain: '.jinritemai.com' }])),
    cookieFilePath: file, sessionStartFingerprint: sessionStart,
    identityOk: true, audit: (e) => audits.push(e),
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.conflict, true, '必须明确标记为冲突');
  assert.match(r.reason, /会话期间已被改变|保留较新文件/);
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), newer, '较新文件必须原样保留（不得用旧会话覆盖）');
  assert.ok(!JSON.stringify(audits).includes('brand-new-session'), '审计不得泄漏 Cookie 值');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('指纹：内容相同则指纹一致；内容变化（即使大小相同）指纹不同', () => {
  const dir = tmpDir();
  const file = writeCookieFile(dir, synthCookies());
  const a = fingerprintFile(file);
  assert.strictEqual(fingerprintFile(file).sha256, a.sha256);
  const raw = fs.readFileSync(file, 'utf-8');
  fs.writeFileSync(file, raw.replace('v-fxg-0', 'v-fxg-X'));
  const b = fingerprintFile(file);
  assert.notStrictEqual(b.sha256, a.sha256, '内容变化必须被 sha256 捕获（不能只看 mtime/大小）');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('域完整性：非关键第三方域缺失允许写回，但如实记录（不静默）', async () => {
  const dir = tmpDir();
  const prev = synthCookies();
  const file = writeCookieFile(dir, prev);
  const next = prev.filter((c) => c.domain !== '.hm.baidu.com');
  const r = await writebackSessionCookies({
    context: ctxOf(next), cookieFilePath: file, sessionStartFingerprint: fingerprintFile(file),
    identityOk: true, audit: () => {},
  });
  assert.strictEqual(r.ok, true, r.reason || '');
  assert.deepStrictEqual(r.droppedOther, ['hm.baidu.com'], '缺失的非关键域必须如实记录（规范化域名）');
  fs.rmSync(dir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════
// 接线层：ChengfangRunner._closeSession（真实执行器/真实路径的装配点）
// 用真实 ChengfangRunner + 合成 context + 临时 Cookie 文件，
// 断言：真实执行 → 关闭浏览器**之前**回写；演练/无 context → 不回写；
//       回写结果挂在批次上但绝不改写广告动作结果。
// ══════════════════════════════════════════════════════════════

const { ChengfangRunner } = require('../src/engine/chengfang-runner');

function makeRunner(audits = []) {
  return new ChengfangRunner({
    coordinator: null,
    config: { execution: { realMode: true, dryRun: false }, monitor: { chengfang: {} } },
    now: () => 1758000000000,
    audit: (e) => audits.push(e),
  });
}

test('接线：真实执行批次在浏览器关闭前回写，且只写本次实际加载的精确路径', async () => {
  const dir = tmpDir();
  const prev = synthCookies();
  const file = writeCookieFile(dir, prev);
  const next = prev.concat([{ name: 'rotated', value: 'rotated-value', domain: '.jinritemai.com', path: '/' }]);
  const order = [];
  const runner = makeRunner();
  const session = {
    cookieSession: { filePath: file, dir, readOnly: true, startFingerprint: fingerprintFile(file) },
    context: ctxOf(next),
    close: async () => { order.push('close'); },
  };
  const wb = await runner._closeSession(session, { writeback: true, mode: 'execute', identityOk: true, shopId: '瑾漂亮潮流服饰' });
  assert.strictEqual(wb.ok, true, wb.reason || '');
  assert.strictEqual(wb.count, next.length);
  assert.strictEqual(order.length, 1, '必须关闭会话');
  assert.strictEqual(runner.lastCookieWriteback, wb, '结果必须挂在 runner 上供状态透出');
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf-8')).length, next.length, '文件确实被本次会话结果覆盖');
  assert.ok(!JSON.stringify(wb).includes('rotated-value'), '返回结果不得含任何 Cookie 值');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('接线：演练（writeback=false）绝不改动店铺凭据文件', async () => {
  const dir = tmpDir();
  const file = writeCookieFile(dir, synthCookies());
  const before = fs.readFileSync(file, 'utf-8');
  const runner = makeRunner();
  const session = {
    cookieSession: { filePath: file, dir, startFingerprint: fingerprintFile(file) },
    context: ctxOf(synthCookies()),
    close: async () => {},
  };
  const wb = await runner._closeSession(session, { writeback: false });
  assert.strictEqual(wb, null);
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), before, '演练不得改动凭据文件');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('接线：身份核验未通过 / 无本次 context → 拒绝回写（旧文件原样）', async () => {
  const dir = tmpDir();
  const file = writeCookieFile(dir, synthCookies());
  const before = fs.readFileSync(file, 'utf-8');
  const runner = makeRunner();
  const mk = () => ({
    cookieSession: { filePath: file, dir, startFingerprint: fingerprintFile(file) },
    context: ctxOf(synthCookies()),
    close: async () => {},
  });
  const a = await runner._closeSession(mk(), { writeback: true, mode: 'execute', identityOk: false });
  assert.strictEqual(a.ok, false);
  assert.match(a.reason, /身份核验未通过/);
  const noCtx = mk();
  delete noCtx.context;
  const b = await runner._closeSession(noCtx, { writeback: true, mode: 'execute', identityOk: true });
  assert.strictEqual(b, null, '没有本次 context 时不应尝试回写');
  assert.strictEqual(fs.readFileSync(file, 'utf-8'), before, '旧文件必须原样保留');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('接线：回写异常绝不冒泡，广告动作结果不被改写', async () => {
  const dir = tmpDir();
  const file = writeCookieFile(dir, synthCookies());
  const runner = makeRunner();
  const session = {
    cookieSession: { filePath: file, dir, startFingerprint: fingerprintFile(file) },
    // context.cookies 抛错 → 回写应被单独记录为失败，而不是让批次失败
    context: { cookies: async () => { throw new Error('context 已关闭'); } },
    close: async () => {},
  };
  const batchResult = { outcome: 'paused', counts: { confirmed: 2, failed: 0, unknown: 0 }, allPausedConfirmed: true };
  const wb = await runner._closeSession(session, { writeback: true, mode: 'execute', identityOk: true, shopId: 's' });
  if (wb) batchResult.cookieWriteback = wb;
  assert.strictEqual(wb.ok, false);
  assert.strictEqual(batchResult.outcome, 'paused', '回写失败不得把已确认的广告动作改写成失败');
  assert.strictEqual(batchResult.allPausedConfirmed, true);
  assert.deepStrictEqual(batchResult.counts, { confirmed: 2, failed: 0, unknown: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('接线：Monitor 记录批次回写元信息（条数/域名/时间），且不含任何 Cookie 值', () => {
  const { Monitor } = require('../src/engine/monitor');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-monitor-'));
  const monitor = new Monitor(
    { config: { execution: { realMode: true, dryRun: false }, schedule: {}, monitor: { chengfang: {} }, rules: [], shops: [] }, pending: [], ready: true },
    {},
    { dataDir, nowFn: () => 1758000000000 },
  );
  assert.strictEqual(monitor.lastCookieWriteback, null, '未回写时必须为 null（状态透出 null，不编造）');
  monitor._recordBatch('瑾漂亮潮流服饰', {
    batchDate: '2026-09-16', outcome: 'paused', counts: { confirmed: 1 },
    cookieWriteback: { ok: true, skipped: false, count: 65, bytes: 20480, domains: ['fxg.jinritemai.com'], droppedOther: [] },
  });
  const cw = monitor.lastCookieWriteback;
  assert.ok(cw, '批次带 cookieWriteback 时必须记录');
  assert.strictEqual(cw.shopId, '瑾漂亮潮流服饰');
  assert.strictEqual(cw.count, 65);
  assert.strictEqual(cw.bytes, 20480);
  assert.ok(cw.at, '必须带时间戳');
  assert.ok(!/"value"/.test(JSON.stringify(cw)), '状态不得含 Cookie 值');
  fs.rmSync(dataDir, { recursive: true, force: true });
});
