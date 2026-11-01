'use strict';

/**
 * DIAN-4 阶段一：操作会话关闭路径（第三类 L4 写回）的四层同步边界（2026-10-22 瑾漂亮 10:56:34Z）。
 *
 * 现场事实：10:56:34.579Z `cookie-writeback phase=done ok=true count=144 bytes=40154` 之后
 * **没有** recovery-update / raw-snapshot / checkpoint-propagate 任何一条记录，紧邻
 * `chengfang event=done`、`ad-switch settle`——即乘方动作会话关闭写回的 L4 从不进入恢复/归档层，
 * 而且全链路零审计（与 10:53–10:54 五次检查点写回各自的完整三元组形成对照）。
 *
 * 边界（刻意不做的事）：本路径只有 exact-bytes 提交、没有独立写前验证句柄，
 * 未独立验证的工作副本**不得**被宣称为恢复基准，也绝不手工复制到 L3/L1；
 * 因此这里要求的是"每次成功写回必须传播，或留下明确失败审计且可重试"，
 * 由下一次独立验证成功的检查点写回重新建立 L3==L4。
 *
 * 覆盖：
 *  A1 每次成功写回都进共享传播入口；本路径无已验证句柄 → 恢复/归档被同源闸门拒绝且留下
 *     checkpoint-propagate + propagate-deferred(retryable) 双审计，真实写盘只有 L4；
 *  A2 传给传播入口的参数逐一对齐（context/路径/本次冻结 sha/句柄），结果挂到批次字段；
 *  A3 传播成功时不产生 deferred 噪声；
 *  A4 传播异常绝不冒泡、绝不改写已确认的写回与广告结果；
 *  A5 写回未成功（身份/登录证据缺失、fail-closed 拒绝）绝不进传播，不留假信号；
 *  A6 顺序：传播发生在浏览器关闭之前；全程零广告点击、绝不回灌活 context；
 *  A7 返回值与全部审计不含任何 Cookie 值。
 *
 * 全部使用临时目录 + 合成 Cookie：不启动浏览器、不触网、不读写真实凭据、不触碰真实广告。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { ChengfangRunner } = require('../src/engine/chengfang-runner');
const checkpoint = require('../src/login/session-cookie-checkpoint');
const { fingerprintFile, writebackSessionCookies } = require('../src/login/cookie-writeback');

const ORIG_PROPAGATE = checkpoint.propagateCommittedCheckpoint;

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `dian4-${tag}-`));
}

function synthCookies() {
  const base = [];
  const add = (domain, n, prefix) => {
    for (let i = 0; i < n; i += 1) {
      base.push({ name: `${prefix}_${i}`, value: `secret-${prefix}-${i}-VALUE`, domain, path: '/', expires: 2000000000, httpOnly: false, secure: true, sameSite: 'Lax' });
    }
  };
  add('fxg.jinritemai.com', 4, 'fxg');
  add('.jinritemai.com', 6, 'root');
  add('compass.jinritemai.com', 2, 'compass');
  add('.doudian-sso.jinritemai.com', 3, 'sso');
  return base;
}

/** 会话夹具：controller 只暴露只读核验，动作点击另设探针（应为 0）。 */
function makeSession(dir, { stale = false } = {}) {
  const file = path.join(dir, '瑾漂亮潮流服饰.json');
  const prev = synthCookies();
  fs.writeFileSync(file, JSON.stringify(prev, null, 2));
  const start = fingerprintFile(file);
  const next = stale ? prev : prev.concat([{ name: 'rotated', value: 'secret-rotated-VALUE', domain: '.jinritemai.com', path: '/', expires: 2000000000, httpOnly: true, secure: true, sameSite: 'Lax' }]);
  const seq = [];
  const probes = { adClicks: 0, addCookies: 0 };
  const session = {
    file,
    seq,
    probes,
    context: {
      cookies: async () => next.map((c) => ({ ...c })),
      addCookies: async () => { probes.addCookies += 1; },
    },
    cookieSession: { filePath: file, startFingerprint: stale ? { exists: true, sha256: 'f'.repeat(64) } : start },
    controller: {
      verifyIdentity: async () => { seq.push('verifyIdentity'); return stale ? { ok: false, reason: '身份核验未通过' } : { ok: true }; },
      clickBatchPause: async () => { probes.adClicks += 1; return {}; },
      clickBatchEnable: async () => { probes.adClicks += 1; return {}; },
    },
    page: {},
    browser: { close: async () => { seq.push('browser-close'); } },
    close: async () => { seq.push('close'); },
  };
  return { session, prev, next };
}

function makeRunner(dir) {
  const audits = [];
  const runner = new ChengfangRunner({
    coordinator: {}, config: {}, now: () => Date.parse('2026-10-22T10:56:34Z'),
    audit: (e) => audits.push(e),
  });
  return { runner, audits };
}

const CTX = { mode: 'execute', writeback: true, identityOk: true, shopId: 'shop-jin', shopCfg: { id: 'shop-jin', name: '瑾漂亮潮流服饰' } };

test('A1 成功写回进入共享收尾入口：两只读角色固定不传播，审计明确', async () => {
  const dir = tmpDir('a1');
  const { session } = makeSession(dir);
  const { runner, audits } = makeRunner(dir);

  const wb = await runner._closeSession(session, CTX);
  assert.equal(wb.ok, true, JSON.stringify(wb));
  assert.equal(wb.phase, 'done');
  assert.ok(wb.propagate, '成功写回必须带回传播结果，绝不允许静默');
  assert.equal(wb.propagate.recovery.ok, false, '未独立验证的工作副本不得成为恢复基准');
  assert.equal(wb.propagate.recovery.skipped, true);
  assert.equal(wb.propagate.archive.ok, false);

  const prop = audits.filter((a) => a.kind === 'checkpoint-propagate');
  assert.equal(prop.length, 1, '每次成功写回必须有 checkpoint-propagate 审计（此前该路径一条都没有）');
  assert.equal(prop[0].recoveryOk, false);
  assert.equal(prop[0].absorbOk, false, '本路径不回灌活 context');
  assert.match(String(prop[0].sha256Prefix), /^[0-9a-f]{12}$/, '审计只允许 sha 前缀');

  const def = audits.filter((a) => a.phase === 'propagate-deferred');
  assert.equal(def.length, 1, '必须留下明确失败审计');
  assert.equal(def[0].kind, 'cookie-propagation', '传播缺口不得伪装成回写失败');
  assert.equal(def[0].retryable, true, '必须标注可重试');
  assert.equal(def[0].shopId, 'shop-jin');
  assert.ok(def[0].reason && def[0].reason.length > 4, '失败审计必须给出原因');
  assert.match(def[0].reason, /只读恢复副本\/原始归档不可由检查点反向刷新/, '原因必须明确说明只读角色不允许检查点写入');

  // 真实落盘只允许 L4 工作副本；临时目录外的恢复/归档根本次不得被写入。
  const onDisk = JSON.parse(fs.readFileSync(session.file, 'utf8'));
  assert.equal(onDisk.length, 16);
  assert.equal(session.probes.adClicks, 0, '零广告点击');
});

test('A2 传播入参与本次提交严格同源，结果并入批次字段', async () => {
  const dir = tmpDir('a2');
  const { session } = makeSession(dir);
  const { runner } = makeRunner(dir);
  const seen = [];
  checkpoint.propagateCommittedCheckpoint = async (p) => {
    seen.push(p);
    return { attempted: true, recovery: { ok: true, skipped: false, sha256Prefix: 'abc123abc123' }, archive: { ok: true, skipped: false }, absorb: { ok: false, skipped: true } };
  };
  try {
    const wb = await runner._closeSession(session, CTX);
    assert.equal(seen.length, 1);
    const p = seen[0];
    assert.equal(p.cookieFilePath, session.file, '目标必须是本次实际加载的精确路径');
    assert.equal(p.context, session.context, '回灌入口必须是本次会话 context');
    const direct = await writebackSessionCookies({
      context: session.context, cookieFilePath: session.file,
      sessionStartFingerprint: fingerprintFile(session.file),
      identityOk: true, loginOk: true, shopId: 'shop-jin', audit: () => {},
    });
    assert.equal(typeof p.expectedSha256, 'string');
    assert.match(p.expectedSha256, /^[0-9a-f]{64}$/);
    assert.equal(direct.ok, true, '夹具：同字节再写回必须成功，才能比对 sha');
    assert.equal(p.expectedSha256, direct.expectedSha256, '传播 sha 必须逐字节等于本次提交');
    assert.equal('finalCookies' in p, true, '必须显式移交已验证句柄字段（本路径为 undefined，由共享闸门拒绝）');
    assert.equal(p.finalCookies, undefined, '未经独立写前验证不得伪造已验证集合');
    assert.equal(wb.propagate.recovery.ok, true);
  } finally {
    checkpoint.propagateCommittedCheckpoint = ORIG_PROPAGATE;
  }
});

test('A3 传播成功：只留 propagate 审计，不制造 deferred 噪声', async () => {
  const dir = tmpDir('a3');
  const { session } = makeSession(dir);
  const { runner, audits } = makeRunner(dir);
  checkpoint.propagateCommittedCheckpoint = async () => ({
    attempted: true, recovery: { ok: true, skipped: false }, archive: { ok: true, skipped: false }, absorb: { ok: true, skipped: false, count: 12 },
  });
  try {
    const wb = await runner._closeSession(session, CTX);
    assert.equal(wb.ok, true);
    assert.equal(wb.propagate.recovery.ok, true);
    assert.equal(audits.filter((a) => a.phase === 'propagate-deferred').length, 0);
    assert.equal(audits.filter((a) => a.phase === 'propagate-error').length, 0);
  } finally {
    checkpoint.propagateCommittedCheckpoint = ORIG_PROPAGATE;
  }
});

test('A4 传播异常绝不冒泡：写回与广告结果保持原样', async () => {
  const dir = tmpDir('a4');
  const { session } = makeSession(dir);
  const { runner, audits } = makeRunner(dir);
  checkpoint.propagateCommittedCheckpoint = async () => { throw new Error('vault 根不可用'); };
  try {
    const wb = await runner._closeSession(session, CTX);
    assert.equal(wb.ok, true, '传播失败不得改写已确认的写回成功');
    assert.equal(wb.count, 16);
    assert.equal(wb.propagate, null);
    const err = audits.filter((a) => a.phase === 'propagate-error');
    assert.equal(err.length, 1, '传播异常必须留明确失败审计');
    assert.equal(err[0].retryable, true);
    assert.equal(err[0].ok, false);
    assert.equal(session.seq.includes('close'), true, '异常后浏览器仍须关闭');
    assert.equal(session.probes.adClicks, 0);
  } finally {
    checkpoint.propagateCommittedCheckpoint = ORIG_PROPAGATE;
  }
});

test('A5 写回未成功绝不进传播：身份/登录证据缺失时不留假信号', async () => {
  for (const [label, ctxPatch, stale] of [
    ['identityOk=false', { identityOk: false }, false],
    ['回写前登录证据失效', {}, true],
  ]) {
    const dir = tmpDir('a5');
    const { session } = makeSession(dir, { stale });
    const { runner, audits } = makeRunner(dir);
    let entered = 0;
    checkpoint.propagateCommittedCheckpoint = async () => { entered += 1; return { attempted: false, recovery: { ok: false, skipped: true }, archive: { ok: false, skipped: true }, absorb: { ok: false, skipped: true } }; };
    try {
      const wb = await runner._closeSession(session, Object.assign({}, CTX, ctxPatch));
      assert.equal(wb.ok, false, label);
      assert.equal(entered, 0, `${label}：未写盘就不许进传播`);
      assert.equal(audits.filter((a) => a.kind === 'checkpoint-propagate').length, 0, label);
      assert.equal(audits.filter((a) => a.phase === 'propagate-deferred').length, 0, label);
      assert.equal(session.probes.addCookies, 0, label);
    } finally {
      checkpoint.propagateCommittedCheckpoint = ORIG_PROPAGATE;
    }
  }
});

test('A6 顺序与边界：传播早于浏览器关闭，且不回灌、不刷新会话', async () => {
  const dir = tmpDir('a6');
  const { session } = makeSession(dir);
  const { runner } = makeRunner(dir);
  checkpoint.propagateCommittedCheckpoint = async () => { session.seq.push('propagate'); return { attempted: true, recovery: { ok: false, skipped: true, reason: '同源闸门拒绝' }, archive: { ok: false, skipped: true }, absorb: { ok: false, skipped: true } }; };
  try {
    const wb = await runner._closeSession(session, CTX);
    assert.equal(wb.ok, true);
    const iProp = session.seq.indexOf('propagate');
    const iClose = session.seq.indexOf('close');
    assert.ok(iProp >= 0 && iClose >= 0 && iProp < iClose, '必须在 context 仍存活时传播：' + session.seq.join('>'));
    assert.equal(session.probes.addCookies, 0, '未验证集合绝不回灌活 context');
    assert.equal(session.probes.adClicks, 0);
  } finally {
    checkpoint.propagateCommittedCheckpoint = ORIG_PROPAGATE;
  }
});

test('A7 返回值与全部审计不含任何 Cookie 值（含传播失败原因文本）', async () => {
  const dir = tmpDir('a7');
  const { session, next } = makeSession(dir);
  const { runner, audits } = makeRunner(dir);
  const wb = await runner._closeSession(session, CTX);
  const dump = JSON.stringify(wb) + JSON.stringify(audits);
  for (const c of next) {
    assert.ok(!dump.includes(c.value), `不得出站 Cookie 值：${c.name}`);
  }
  assert.ok(!/"value"/.test(dump), '展示/审计结构不得携带 value 字段');
});
