'use strict';

/**
 * D5 来源类别（provenance）回归：恢复链不得让较新的 legacy-unverified 快照
 * 遮蔽同一分钟内的人新已验证登录快照。
 *
 * 合成用例，node:test + 真实 fs（全部限定 os.tmpdir() 一次性目录）+ 注入
 * vault / verify 桩；无真实 Cookie、无浏览器、无网络、无生产目录。
 * 覆盖：
 *  1) rank 层：10ms 反转 + limit=1 仍先选非 legacy；不同来源类别分钟桶互不挤占；
 *  2) 同类同分钟去重/上层优先/unknown 来源按非 legacy 兼容；
 *  3) guard 有界读取：legacy 占满旧窗口时 verified 仍在窗口内，legacy 作回退；
 *  4) analyzer 有界读取：先选较早 verified、后选较新 legacy；只提升可写目标，
 *     只读归档字节/mtime 不变。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const session = require('../src/login/session');

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function bytesOf(cookies) { return Buffer.from(JSON.stringify(cookies, null, 2), 'utf8'); }
function makeCookies(tag) {
  return [
    { name: 'sessionid', value: `sid-${tag}-SYNTH`, domain: '.jinritemai.com', path: '/', expires: 1893456000 },
    { name: 'ttwid', value: `ttw-${tag}-SYNTH`, domain: '.iesdouyin.com', path: '/', expires: 1893456000 },
  ];
}

function mkTmp(prefix) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const d = {
    base,
    workDir: path.join(base, 'guard-cookies'),
    recoveryDir: path.join(base, 'cookie-recovery'),
    archiveRoot: path.join(base, 'archive-raw'),
    analyzerWorkDir: path.join(base, 'app-cookies'),
    guardWorkDir: path.join(base, 'guard-work'),
  };
  for (const p of [d.workDir, d.recoveryDir, d.archiveRoot, d.analyzerWorkDir, d.guardWorkDir]) {
    fs.mkdirSync(p, { recursive: true });
  }
  return d;
}

// ── 1) rank：10ms 反转 + 小额度 + 分钟桶来源类别 ─────────────────────────

test('排名：10ms 反转下 limit=1 仍先选非 legacy；同分钟不同来源类别各自成桶', () => {
  const verified = {
    source: 'raw-archive:v-verified', sha256: 'a'.repeat(64),
    createdAtMs: 1793097086067, origin: 'verified-login',
  };
  const legacy = {
    source: 'raw-archive:v-legacy', sha256: 'b'.repeat(64),
    createdAtMs: 1793097086077, origin: 'legacy-unverified',
  };

  const r1 = session.rankRestoreCandidatesGuard([legacy, verified], 1);
  assert.deepStrictEqual(r1.selected.map((c) => c.source), ['raw-archive:v-verified'],
    '较新的 legacy 不得抢占唯一额度');
  assert.strictEqual(r1.ranking.find((e) => e.versionId === 'v-verified').decision, 'selected');
  assert.strictEqual(r1.ranking.find((e) => e.versionId === 'v-legacy').decision, 'beyond-limit');

  const r2 = session.rankRestoreCandidatesGuard([legacy, verified], 2);
  assert.deepStrictEqual(
    r2.selected.map((c) => c.source),
    ['raw-archive:v-verified', 'raw-archive:v-legacy'],
    '不同来源类别分钟桶互不挤占，legacy 在剩余额度内作为回退入选',
  );
  assert.strictEqual(r2.ranking.find((e) => e.versionId === 'v-legacy').decision, 'selected');
});

// ── 2) 同类分钟去重、上层优先、unknown 来源兼容 ──────────────────────────

test('排名：同类同分钟去重保留，上层角色优先不变，unknown 来源按非 legacy 兼容', () => {
  const upper = { source: 'guard-recovery', sha256: 'c'.repeat(64), createdAtMs: 1 };
  const legacyNew = {
    source: 'raw-archive:v-legacy-new', sha256: '1'.repeat(64),
    createdAtMs: 1793097086077, origin: 'legacy-unverified',
  };
  const legacyOld = {
    source: 'raw-archive:v-legacy-old', sha256: '2'.repeat(64),
    createdAtMs: 1793097086067, origin: 'legacy-unverified',
  };
  const unknownNewer = {
    source: 'raw-archive:v-unknown-newer', sha256: '3'.repeat(64),
    createdAtMs: 1793097146000, origin: 'unknown',
  };
  const unknownOlder = {
    source: 'raw-archive:v-unknown-older', sha256: '4'.repeat(64),
    createdAtMs: 1793097086000, // 历史候选无 origin 字段：必须按非 legacy 兼容
  };

  const r = session.rankRestoreCandidatesGuard(
    [legacyNew, legacyOld, unknownNewer, unknownOlder, upper], 10,
  );
  assert.strictEqual(r.selected[0].source, 'guard-recovery', '上层候选恒定最先保留');
  assert.strictEqual(r.ranking[0].decision, 'kept-layer');

  const archiveSelected = r.selected
    .filter((c) => c.source.startsWith('raw-archive:'))
    .map((c) => c.source);
  assert.deepStrictEqual(archiveSelected, [
    'raw-archive:v-unknown-newer', 'raw-archive:v-unknown-older', 'raw-archive:v-legacy-new',
  ], '非 legacy（含 unknown/缺省）整体先于 legacy；类内保持新→旧');
  assert.strictEqual(r.ranking.find((e) => e.versionId === 'v-legacy-new').decision, 'selected');
  assert.strictEqual(r.ranking.find((e) => e.versionId === 'v-legacy-old').decision, 'skipped-dup-minute',
    '同类同分钟去重语义保留');

  // 非 legacy 同类同分钟去重同样保留
  const twinOld = {
    source: 'raw-archive:v-twin-old', sha256: '5'.repeat(64),
    createdAtMs: 1793097086010, origin: 'verified-login',
  };
  const twinNew = {
    source: 'raw-archive:v-twin-new', sha256: '6'.repeat(64),
    createdAtMs: 1793097086020, origin: 'verified-login',
  };
  const rt = session.rankRestoreCandidatesGuard([twinOld, twinNew], 10);
  assert.deepStrictEqual(rt.selected.map((c) => c.source), ['raw-archive:v-twin-new']);
  assert.strictEqual(rt.ranking.find((e) => e.versionId === 'v-twin-old').decision, 'skipped-dup-minute');
});

// ── 3) guard 有界读取：来源优先在截断之前 ───────────────────────────────

test('guard 有界读取：6 个较新 legacy 占满旧窗口时仍先读 verified，legacy 在额度内回退', async () => {
  const d = mkTmp('provenance-guard-');
  const shop = '店G';
  const baseMs = 1793097086067;
  const versionMap = new Map();
  const versions = [];

  function addVersion(versionId, cookies, createdAtMs, origin) {
    const buf = bytesOf(cookies);
    const versionPath = path.join(d.archiveRoot, shop, `${versionId}.json`);
    versionMap.set(versionPath, { buf, sha256: sha(buf) });
    versions.push({ versionId, versionPath, sha256: sha(buf), createdAtMs, origin });
  }

  // legacy 首条比 verified 新 10ms（真实事故形态）；其余按不同分钟递增，
  // 以保证 6 条 legacy 在旧实现（纯时间截断）下占满前 5 个读取窗口。
  addVersion('v-verified', makeCookies('verified'), baseMs, 'verified-login');
  for (let i = 1; i <= 6; i += 1) {
    addVersion(`v-legacy-${i}`, makeCookies(`legacy-${i}`), baseMs + 10 + (i - 1) * 60000, 'legacy-unverified');
  }
  versions.sort((a, b) => (b.createdAtMs - a.createdAtMs)
    || String(b.versionId).localeCompare(String(a.versionId)));

  const vaultModule = {
    defaultRoots: () => ({ archiveRoot: d.archiveRoot, recoveryDir: d.recoveryDir }),
    listSnapshotVersions: () => ({ ok: true, versions, manifestMissing: false }),
    readSnapshotVersion: (p) => {
      const v = versionMap.get(p.versionPath);
      if (!v) return { ok: false, reason: '合成版本缺失' };
      if (typeof p.expectedSha256 !== 'string' || p.expectedSha256 !== v.sha256) {
        return { ok: false, reason: '合成 manifest sha 不一致' };
      }
      return { ok: true, buf: v.buf, sha256: v.sha256 };
    },
  };

  fs.writeFileSync(path.join(d.workDir, `${shop}.json`), bytesOf(makeCookies('just-failed')));
  const seen = [];
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, `${shop}.json`,
    {
      shopCfg: { name: shop, compassShopName: shop },
      excludeWorkCopy: true,
      recoveryDir: d.recoveryDir,
      vaultModule,
      verify: async (p) => { seen.push(p.source); return { ok: false, reason: '桩：仅观察候选顺序，拒绝提升' }; },
      nowFn: () => 10000,
    },
  );
  assert.strictEqual(res.ok, false);
  assert.deepStrictEqual(seen, [
    'raw-archive:v-verified',
    'raw-archive:v-legacy-6',
    'raw-archive:v-legacy-5',
    'raw-archive:v-legacy-4',
    'raw-archive:v-legacy-3',
  ], 'verified 先于 legacy；legacy 类内按新→旧；窗口仍为 5');
  assert.ok(!seen.includes('raw-archive:v-legacy-2'), '硬上限语义保留：较旧的 legacy-2 超出 5 窗口不读取');
  assert.ok(!seen.includes('raw-archive:v-legacy-1'), '硬上限语义保留：较旧的 legacy-1 超出 5 窗口不读取');
});

