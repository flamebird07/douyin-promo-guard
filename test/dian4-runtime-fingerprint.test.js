'use strict';

/**
 * DIAN-4 r13：运行指纹覆盖面必须覆盖整个 guard 源码树（含本轮 r12/r13 改动文件），
 * 且证据只落哈希/大小/解析路径，不含 Cookie、店铺 ID、令牌。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const fp = require('../src/lib/runtime-fingerprint.js');

const SRC_DIR = path.resolve(__dirname, '..', 'src');

function sourceRels(dir = SRC_DIR, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (name === 'node_modules') continue;
      sourceRels(full, out);
      continue;
    }
    if (!st.isFile() || !name.endsWith('.js') || name.includes('.bak-')) continue;
    out.push(path.relative(path.resolve(__dirname, '..'), full).split(path.sep).join('/'));
  }
  return out.sort();
}

const R12_R13_CHANGED = [
  'src/engine/monitor.js',
  'src/engine/ad-switch-orchestrator.js',
  'src/engine/switch-serial.js',
  'src/engine/close-coordinator.js',
  'src/engine/chengfang-runner.js',
  'src/adapters/qianchuan-reader.js',
  'src/adapters/chengfang-reader.js',
  'src/lib/log.js',
  'src/lib/resource-attestation.js',
  'src/lib/runtime-fingerprint.js',
];

test('F1 全量覆盖：src 树每个 .js 都在指纹里，且全部 ok', () => {
  const r = fp.computeRuntimeFingerprint();
  const covered = new Set(r.files.map((f) => String(f.resolvedPath || '').toLowerCase()));
  const missing = sourceRels().filter((rel) => !covered.has(path.resolve(fp.GUARD_ROOT, rel).toLowerCase()));
  assert.deepEqual(missing, [], `未覆盖的源码文件：${missing.join(', ')}`);
  assert.equal(r.allOk, true, JSON.stringify(r.files.filter((f) => !f.ok)));
  assert.equal(r.fileCount, r.files.length);
});

test('F2 r12/r13 改动文件逐一在列（含新增 resource-attestation 与指纹自身）', () => {
  const r = fp.computeRuntimeFingerprint();
  const paths = new Set(r.files.map((f) => String(f.resolvedPath || '').toLowerCase()));
  const ids = new Set(r.files.map((f) => f.id));
  for (const rel of R12_R13_CHANGED) {
    const abs = path.resolve(fp.GUARD_ROOT, rel).toLowerCase();
    assert.ok(paths.has(abs), `缺少 ${rel}`);
  }
  // 核心文件仍保留稳定短 id，便于与既往证据逐行对照。
  assert.ok(ids.has('monitor') && ids.has('resource-attestation') && ids.has('runtime-fingerprint'));
  assert.ok(ids.has('close-coordinator') && ids.has('switch-serial') && ids.has('log'));
});

test('F3 回滚副本 .bak-* 绝不进入指纹（否则证据对应非运行代码）', () => {
  const r = fp.computeRuntimeFingerprint();
  assert.ok(r.files.some((f) => /\.bak-/.test(String(f.resolvedPath))) === false);
  assert.equal(fp.listGuardSourceFiles(SRC_DIR).filter((p) => p.includes('.bak-')).length, 0);
});

test('F4 去重与稳定顺序：核心短 id 在前，重复目标只计一次', () => {
  const a = fp.computeRuntimeFingerprint();
  const b = fp.computeRuntimeFingerprint([
    { id: 'monitor-again', path: path.join(SRC_DIR, 'engine', 'monitor.js') },
    { id: 'dup-watch', path: path.join(fp.GUARD_ROOT, 'src', 'lib', 'log.js') },
    null,
    { id: '', path: '' },
  ]);
  assert.deepEqual(a.files.map((f) => f.id), b.files.map((f) => f.id).slice(0, a.files.length), '顺序稳定');
  const keys = b.files.map((f) => String(f.resolvedPath).toLowerCase());
  assert.equal(new Set(keys).size, keys.length, '同一文件不得出现两次');
  assert.equal(b.files.filter((f) => f.id === 'monitor').length, 1);
});

test('F5 额外目标并入（部署侧调用方 watch-drill 也必须可证）', () => {
  const r = fp.computeRuntimeFingerprint([{ id: 'watch-drill', path: path.join(fp.GUARD_ROOT, '..', 'bill-manager', 'watch-drill.js') }]);
  const w = r.files.find((f) => f.id === 'watch-drill');
  if (!w) return; // bill-manager 不在本仓根时：跳过而非失败
  assert.equal(w.ok, true, JSON.stringify(w.error));
  assert.equal(typeof w.sha256, 'string');
});

test('F6 缺失文件如实标记为 ERR 而非静默丢弃', () => {
  const r = fp.computeRuntimeFingerprint([{ id: 'ghost', path: path.join(SRC_DIR, 'nope-missing.js') }]);
  const g = r.files.find((f) => f.id === 'ghost');
  assert.ok(g, '缺失目标仍要有条目');
  assert.equal(g.ok, false);
  assert.equal(g.sha256, null);
  assert.equal(r.allOk, false);
  assert.match(fp.formatFingerprintLine(r), /ghost=ERR/);
});

test('F7 证据脱敏：摘要行只含「相对路径 id + 16 位哈希前缀」，无绝对路径/完整哈希/站点串', () => {
  const r = fp.computeRuntimeFingerprint();
  const line = fp.formatFingerprintLine(r);
  assert.match(line, /^运行时版本指纹 promo-guard-runtime-fp-v\d+ pid=\d+ files=\d+ /);
  const body = line.slice(line.lastIndexOf('files=') + 6 + String(r.fileCount).length + 1);
  const entries = body.split(' ');
  assert.equal(entries.length, r.fileCount, '每条目标恰好一个摘要项');
  for (const e of entries) {
    assert.match(e, /^[A-Za-z0-9._/-]+=(ERR|[0-9a-f]{16})$/, `摘要项形态越界：${e}`);
  }
  assert.equal(line.includes('\\'), false, '不得出现反斜杠绝对路径');
  assert.equal(line.includes(':'), false, '不得出现盘符路径');
  assert.equal(r.files.filter((f) => f.ok && line.includes(f.sha256)).length, 0, '完整 sha256 不得进入日志行');
  assert.equal(line.includes('fxg.jinritemai'), false, '不得出现站点串');
});
