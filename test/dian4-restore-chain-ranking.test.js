'use strict';

/**
 * DIAN-4 阶段一恢复链最小修复专项测试（离线；真实 fs 限 os.tmpdir()；浏览器一律桩对象）。
 *
 * 覆盖本轮四项缺陷回归：
 *  1) L1 归档列表必须**先全量倒序再有界截断**（>50 版本仍选到真实最新，而不是 manifest
 *     追加顺序头部那批最旧版本；manifest 缺失回退分支同理）；
 *  2) 独立候选验证复用主链**同一份 45 秒零点击被动收敛**：约 30 秒才自动落首页的
 *     SSO 中转绝不再被误判成登录失效；到上界仍未落首页才如实分类，且有界收敛不空转；
 *  3) 恢复候选在硬上限内按**不同 sha / 不同分钟桶**排名：重复入档（同字节、同分钟的
 *     更早一条）不耗尽额度，上限内同时覆盖真实最新与更早的不同检查点；
 *  4) 上限与 fail-closed：候选数有界、无浏览器一律拒绝提升，排名审计留痕但不含值。
 *
 * 安全：断言里出现 SECRET 标记，只用于**证明它没有**出现在审计/结果序列化中。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const session = require('../src/login/session');
const settlePolicy = require('../src/lib/settle-policy');
const { createCheckpointCandidateVerifier } = require('../src/login/session-cookie-checkpoint');
const vault = require('../../bill-manager/cookie-vault');

const FXG_HOME = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const TRANSIT_URL = 'https://fxg.jinritemai.com/login/common';

function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function bytesOf(cookies) { return Buffer.from(JSON.stringify(cookies, null, 2), 'utf8'); }
function makeCookies(tag) {
  return [
    { name: 'sessionid', value: `sid-${tag}-SECRET-VALUE`, domain: '.jinritemai.com', path: '/', expires: 1893456000 },
    { name: 'ttwid', value: `ttw-${tag}-SECRET-VALUE`, domain: '.iesdouyin.com', path: '/', expires: 1893456000 },
  ];
}

// ── 1) L1 归档列表：先全量倒序，再有界截断 ──────────────────────────────

function mkArchiveShopDir(base, shopName) {
  const shopDir = path.join(base, 'cookie-archive', 'raw', shopName);
  fs.mkdirSync(shopDir, { recursive: true });
  return { shopDir, roots: { archiveRoot: path.join(base, 'cookie-archive', 'raw') } };
}

/** versionId 内嵌 UTC 时刻；createdAtMs 严格递增；追加顺序＝最旧→最新（真实 vault 行为）。 */
function writeVersions(shopDir, n, baseMs) {
  const manifest = { version: 1, shop: path.basename(shopDir), versions: [] };
  for (let i = 0; i < n; i += 1) {
    const createdAtMs = baseMs + i * 1000;
    const d = new Date(createdAtMs);
    const pad = (x, w = 2) => String(x).padStart(w, '0');
    const versionId = `v${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`
      + `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z-${pad(1000 + i, 5)}-${sha(Buffer.from(`k${i}`)).slice(0, 6)}`;
    const buf = bytesOf(makeCookies(`v${i}`));
    fs.writeFileSync(path.join(shopDir, `${versionId}.json`), buf);
    manifest.versions.push({
      versionId, sha256: sha(buf), bytes: buf.length, createdAtMs,
      origin: 'verified-writeback', structureValid: true,
    });
  }
  fs.writeFileSync(path.join(shopDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { manifest, newest: manifest.versions[n - 1], oldest: manifest.versions[0] };
}

test('L1 归档列表：>50 个入册版本必须先全量倒序再有界截断，选到真实最新（不是追加顺序头部）', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dian4-vault-order-')));
  const { shopDir, roots } = mkArchiveShopDir(base, '排序店');
  const N = 60;
  const { newest, oldest } = writeVersions(shopDir, N, Date.UTC(2026, 9, 1, 1, 0, 0));

  const res = vault.listSnapshotVersions({ shopSafeName: '排序店', roots });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.manifestMissing, false);
  assert.ok(res.versions.length > 0 && res.versions.length <= vault.MAX_VERSIONS_SCAN,
    `必须是有界截断，实际 ${res.versions.length}`);
  assert.strictEqual(res.versions[0].versionId, newest.versionId,
    '第一条必须是全量最新（旧实现先 slice(0,50) 再排序，只会返回最旧那批 → 伪缺口）');
  assert.strictEqual(res.versions[0].sha256, newest.sha256);
  assert.notStrictEqual(res.versions[0].versionId, oldest.versionId);
  // 严格新→旧
  for (let i = 1; i < res.versions.length; i += 1) {
    assert.ok(res.versions[i - 1].createdAtMs >= res.versions[i].createdAtMs,
      `第 ${i} 条比上一条更新：倒序被破坏`);
  }
});

test('L1 归档列表：manifest 缺失回退分支同样先全量倒序再有界截断（目录列举顺序不代表新旧）', () => {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dian4-vault-fallback-')));
  const { shopDir, roots } = mkArchiveShopDir(base, '无册店');
  const ids = [];
  const t0 = Date.UTC(2026, 9, 22, 8, 0, 0);
  for (let i = 0; i < 60; i += 1) {
    ids.push(`v20261022T08${String(i).padStart(2, '0')}00Z-0${String(i).padStart(4, '0')}-aaaaaa`);
  }
  // 故意乱序创建：目录列举顺序（以及旧实现的 slice(0,50)）都既不等于新旧顺序，
  // 也必须不再影响结果——只有"先全量倒序再截断"才能选到真实最新。
  const shuffled = ids.slice().sort((a, b) => (a.charCodeAt(15) * 31 + a.length) % 7 - (b.charCodeAt(15) * 31 + b.length) % 7);
  for (let k = 0; k < shuffled.length; k += 1) {
    const id = shuffled[k];
    const i = ids.indexOf(id);
    const file = path.join(shopDir, `${id}.json`);
    fs.writeFileSync(file, bytesOf(makeCookies(id)));
    const when = new Date(t0 + i * 60000);
    fs.utimesSync(file, when, when);
  }
  const newest = ids[ids.length - 1];
  assert.ok(!fs.existsSync(path.join(shopDir, 'manifest.json')), '本用例前提：manifest 缺失');

  const res = vault.listSnapshotVersions({ shopSafeName: '无册店', roots });
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.manifestMissing, true);
  assert.strictEqual(res.versions.length, vault.MAX_VERSIONS_SCAN, '有界截断仍保留上限条数');
  assert.strictEqual(res.versions[0].versionId, newest,
    '回退分支也必须先按 versionId 全量倒序再截断，否则 >上限时只看到最旧一批');
  assert.strictEqual(res.versions[0].sha256, null, '未入册版本不得伪造 sha');
  assert.strictEqual(res.versions[0].origin, 'unlisted');
});

// ── 2) 独立候选验证复用主链 45 秒被动收敛 ────────────────────────────────

/**
 * 桩页面：前 flipAfter 次 url() 返回中转地址，之后返回首页；sleep 推进注入时钟，
 * 因此"是否误判"完全由收敛上界决定，绝不产生真实等待。
 */
function mkSettleBrowser({ flipAfter, url = TRANSIT_URL, shopName = '本店', cookies, clock }) {
  let reads = 0;
  const vctx = {
    addCookies: async () => {},
    newPage: async () => ({
      goto: async () => {},
      url: () => {
        reads += 1;
        if (flipAfter != null && reads > flipAfter) return url === TRANSIT_URL ? FXG_HOME : url;
        return url;
      },
      isClosed: () => false,
      evaluate: async () => ({ name: shopName, distinct: [shopName], candidates: 1, unique: true, loginVisible: false }),
    }),
    cookies: async () => cookies,
    close: async () => {},
  };
  return { newContext: async () => vctx, urlReads: () => reads, clock };
}

function mkSleep(clock) {
  return async (ms) => { clock.t += ms; };
}

test('检查点独立验证：约 30 秒后自动落首页的候选不得被误判为登录失效（复用主链 45 秒收敛）', async () => {
  const cookies = makeCookies('settle-ok');
  const buf = bytesOf(cookies);
  const clock = { t: 0 };
  // 每次 url() 读都算一轮：中转 11 轮（≈30 秒）后落首页
  const browser = mkSettleBrowser({ flipAfter: 11, cookies, clock });
  const verify = createCheckpointCandidateVerifier({
    expectedNames: ['本店'], browser,
    sleep: mkSleep(clock), nowFn: () => clock.t,
  });
  const r = await verify({ cookies, buf, sha256: sha(buf), serialized: buf.toString('utf8') });
  assert.strictEqual(r.ok, true, `30 秒收敛点必须判为有效，实际被误判：${r.classification || ''} ${r.reason || ''}`);
  assert.ok(Array.isArray(r.finalCookies) && r.finalCookies.length > 0, '必须返回非空最终已验证集合');
  assert.ok(clock.t >= 30000, '确实经历了中转期（否则本用例没有检验到收敛等待）');
});

test('检查点独立验证：到 45 秒上界仍未落首页才如实分类，且轮询有界不空转', async () => {
  const cookies = makeCookies('settle-timeout');
  const buf = bytesOf(cookies);
  const clock = { t: 0 };
  const browser = mkSettleBrowser({ flipAfter: null, url: TRANSIT_URL, cookies, clock });
  const verify = createCheckpointCandidateVerifier({
    expectedNames: ['本店'], browser,
    sleep: mkSleep(clock), nowFn: () => clock.t,
  });
  const r = await verify({ cookies, buf, sha256: sha(buf), serialized: buf.toString('utf8') });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.classification, 'login-invalid', '登录中转地址到上界仍是登录页 → 如实判登录无效');
  assert.ok(clock.t <= settlePolicy.DEFAULT_SETTLE_TIMEOUT_MS + settlePolicy.DEFAULT_SETTLE_INTERVAL_MS,
    `等待必须有界（实际推进 ${clock.t}ms）`);
  assert.ok(browser.urlReads() <= settlePolicy.MAX_SETTLE_ATTEMPTS, '轮询次数必须受硬限次约束');
});

test('session 默认候选验证器同样复用主链 45 秒收敛：30 秒落首页不误判', async () => {
  const cookies = makeCookies('session-settle');
  const clock = { t: 0 };
  const browser = mkSettleBrowser({ flipAfter: 11, cookies, clock });
  const verify = session.createDefaultCandidateVerifier({}, {
    browser, verifySleep: mkSleep(clock), verifyNowFn: () => clock.t,
  });
  const r = await verify({ cookies, expectedShopNames: ['本店'], source: 'guard-recovery' });
  assert.strictEqual(r.ok, true, `30 秒收敛点必须判为有效，实际：${r.classification || ''} ${r.reason || ''}`);
  assert.ok(Array.isArray(r.finalCookies) && r.finalCookies.length === cookies.length);
  assert.ok(clock.t >= 30000);
});

test('session 默认候选验证器：无浏览器一律 fail-closed，绝不自启真实浏览器', async () => {
  const verify = session.createDefaultCandidateVerifier({}, {});
  const r = await verify({ cookies: makeCookies('nb'), expectedShopNames: ['本店'], source: 'guard-recovery' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /fail-closed/);
});

// ── 3) 候选排名：不同 sha / 不同分钟桶，重复不耗尽额度 ───────────────────

function arcCand(versionId, tag, createdAtMs) {
  const buf = bytesOf(makeCookies(tag));
  return { source: `raw-archive:${versionId}`, buf, sha256: sha(buf), createdAtMs };
}

test('候选排名：同 sha 重复入档不占额度，上限内同时拿到真实最新与更早的不同检查点', () => {
  const MIN = 60000;
  const t0 = Date.UTC(2026, 9, 22, 12, 0, 0);
  const upper = [
    { source: 'guard-duty-work', buf: bytesOf(makeCookies('work')), sha256: sha(bytesOf(makeCookies('work'))), createdAtMs: t0 },
    { source: 'guard-recovery', buf: bytesOf(makeCookies('rec')), sha256: sha(bytesOf(makeCookies('rec'))), createdAtMs: t0 - MIN },
  ];
  const archives = [
    arcCand('vA', 'arch-a', t0 + 5 * MIN),                       // 最新
    arcCand('vA-dup', 'arch-a', t0 + 5 * MIN - 1000),            // 与最新同字节（同 sha）
    arcCand('vB', 'arch-b', t0 + 4 * MIN + 30000),               // 与 vC 同分钟桶
    arcCand('vC', 'arch-c', t0 + 4 * MIN + 5000),                // 同分钟更早一条
    arcCand('vD', 'arch-d', t0 + 3 * MIN),
    arcCand('vE', 'arch-e', t0 + 2 * MIN),
    arcCand('vF', 'arch-f', t0 + 1 * MIN),
    arcCand('vG', 'arch-g', t0),                                 // 更旧，应落在上限外
    arcCand('vW', 'work', t0),                                   // 与值守工作副本同字节 → 不占额度
  ];
  const cands = [...upper, ...archives];
  const ranked = session.rankRestoreCandidatesGuard(cands, session.RESTORE_MAX_CANDIDATES);

  assert.ok(ranked.selected.length <= session.RESTORE_MAX_CANDIDATES, '硬上限必须成立');
  // 最新一条必须在（旧实现因先截断而拿不到）
  assert.ok(ranked.selected.some((c) => c.source === 'raw-archive:vA'), '必须选中真实最新归档版本');
  // 同 sha / 同分钟的重复不得挤掉更早的**不同**检查点
  const takenSources = ranked.selected.map((c) => c.source);
  assert.ok(takenSources.some((s) => s === 'raw-archive:vD' || s === 'raw-archive:vE' || s === 'raw-archive:vF'),
    `重复入档不得耗尽额度：更早的不同检查点必须入选，实际 ${takenSources.join(',')}`);
  const decisions = new Map(ranked.ranking.map((e) => [e.versionId || e.layer, e.decision]));
  assert.strictEqual(decisions.get('vA-dup'), 'skipped-dup-sha', '同字节归档必须标为同 sha 跳过');
  assert.strictEqual(decisions.get('vW'), 'skipped-dup-sha', '与工作副本同字节的归档必须标为同 sha 跳过');
  const dupMinute = ['vB', 'vC'].filter((id) => decisions.get(id) === 'skipped-dup-minute');
  assert.strictEqual(dupMinute.length, 1, `同一分钟桶只占一个额度，实际 ${[...decisions]}`);
  assert.ok(ranked.ranking.some((e) => e.decision === 'beyond-limit'), '超出上限者必须如实标注（不是静默丢弃）');
  for (const e of ranked.ranking.filter((x) => x.decision === 'selected')) {
    assert.ok(typeof e.sha256Prefix === 'string' && e.sha256Prefix.length === 12, '审计只留 sha 前缀');
  }
});

test('候选排名：createdAtMs 缺失时按 versionId 内嵌 UTC 时刻排名，绝不回落 manifest 追加顺序', () => {
  const a = arcCand('v20261022T120000Z-00001-aaaaaa', 'older', 0);
  const b = arcCand('v20261022T130000Z-00002-bbbbbb', 'newer', 0);
  const ranked = session.rankRestoreCandidatesGuard([a, b], 5);
  assert.strictEqual(ranked.selected[0].source, b.source, '较新 versionId 必须排在前');
  assert.strictEqual(session.archiveEpochMs(b) > session.archiveEpochMs(a), true);
});

test('候选排名审计：kind=cookie-restore-ranking 留痕且零 Cookie 值泄漏', async () => {
  const d = mkDirsLikeFourTier();
  const fileName = '排名店.json';
  const audits = [];
  const arch = [
    arcCand('v20261022T124700Z-00001-aaaaaa', 'a1', Date.UTC(2026, 9, 22, 12, 47, 0)),
    arcCand('v20261022T124730Z-00002-bbbbbb', 'a1', Date.UTC(2026, 9, 22, 12, 47, 30)), // 同 sha 同分钟
    arcCand('v20261022T124600Z-00003-cccccc', 'a2', Date.UTC(2026, 9, 22, 12, 46, 0)),
  ];
  const vaultStub = {
    defaultRoots: () => ({ archiveRoot: d.archiveRoot, recoveryDir: d.recoveryDir }),
    listSnapshotVersions: () => ({
      ok: true, manifestMissing: false,
      versions: arch.map((c) => ({
        versionId: c.source.slice('raw-archive:'.length),
        versionPath: path.join(d.archiveRoot, `${c.source.slice('raw-archive:'.length)}.json`),
        sha256: c.sha256, createdAtMs: c.createdAtMs, origin: 'verified-writeback', structureValid: true,
      })),
    }),
    readSnapshotVersion: ({ versionPath, expectedSha256 }) => {
      const hit = arch.find((c) => c.source.slice('raw-archive:'.length) === path.basename(versionPath, '.json'));
      if (!hit) return { ok: false, reason: '桩：未命中' };
      if (expectedSha256 !== hit.sha256) return { ok: false, reason: '桩：sha 不符' };
      return { ok: true, buf: hit.buf, sha256: hit.sha256 };
    },
  };
  fs.writeFileSync(path.join(d.workDir, fileName), bytesOf(makeCookies('work-stale')));

  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, fileName,
    {
      shopCfg: { name: '排名店' }, workDir: d.workDir, recoveryDir: d.recoveryDir,
      vaultModule: vaultStub, excludeWorkCopy: true,
      verify: async (p) => {
        if (String(p.source).endsWith('00003-cccccc')) return { ok: true, finalCookies: makeCookies('promoted') };
        return { ok: false, classification: 'identity-unverified', reason: '桩：仅较早检查点通过' };
      },
      audit: (e) => audits.push(e),
    },
  );
  assert.strictEqual(res.ok, true, JSON.stringify(res.attempts));

  const rankAudit = audits.find((a) => a.kind === 'cookie-restore-ranking');
  assert.ok(rankAudit, '每次恢复必须留排名审计');
  assert.strictEqual(rankAudit.shop, '排名店');
  assert.strictEqual(rankAudit.limit, session.RESTORE_MAX_CANDIDATES);
  assert.ok(Array.isArray(rankAudit.ranking) && rankAudit.ranking.length > 0);
  const dump = JSON.stringify({ ranking: rankAudit.ranking, res });
  assert.ok(!/SECRET/.test(dump), `排名审计/结果不得含 Cookie 值：${dump}`);
  assert.ok(!/"value"/.test(dump), '不得出现 Cookie 值字段');
  // 同 sha 重复不占额度 → 更早的**不同**检查点仍在窗口内被选中并胜出
  const byDecision = rankAudit.ranking;
  const dupEntry = byDecision.find((e) => e.versionId === 'v20261022T124700Z-00001-aaaaaa');
  const olderEntry = byDecision.find((e) => e.versionId === 'v20261022T124600Z-00003-cccccc');
  assert.ok(dupEntry && olderEntry, `两条归档都必须进排名审计：${JSON.stringify(byDecision)}`);
  assert.strictEqual(dupEntry.decision, 'skipped-dup-sha', '同分钟同字节的重复入档必须标为同 sha 跳过');
  assert.strictEqual(olderEntry.decision, 'selected', '重复入档不得耗尽额度：更早的不同检查点必须入选');
  assert.strictEqual(String(res.source), 'raw-archive:v20261022T124600Z-00003-cccccc',
    '更早但唯一通过验证的检查点必须被提升');
});

// ── 4) 上限与 fail-closed ───────────────────────────────────────────────

test('上限与 fail-closed：候选数有界；无浏览器一律不提升、工作副本逐字节不变', async () => {
  const d = mkDirsLikeFourTier();
  const fileName = '有界店.json';
  const before = bytesOf(makeCookies('work-before'));
  fs.writeFileSync(path.join(d.workDir, fileName), before);
  const arch = [];
  for (let i = 0; i < 12; i += 1) {
    arch.push(arcCand(`v20261022T12${String(10 + i).padStart(2, '0')}00Z-000${i}-zzzzzz`, `ab-${i}`, Date.UTC(2026, 9, 22, 12, 10 + i, 0)));
  }
  const vaultStub = {
    defaultRoots: () => ({ archiveRoot: d.archiveRoot, recoveryDir: d.recoveryDir }),
    listSnapshotVersions: () => ({
      ok: true, manifestMissing: false,
      versions: arch.map((c) => ({
        versionId: c.source.slice('raw-archive:'.length),
        versionPath: path.join(d.archiveRoot, `${c.source.slice('raw-archive:'.length)}.json`),
        sha256: c.sha256, createdAtMs: c.createdAtMs, origin: 'verified-writeback', structureValid: true,
      })),
    }),
    readSnapshotVersion: ({ versionPath }) => {
      const hit = arch.find((c) => c.source.slice('raw-archive:'.length) === path.basename(versionPath, '.json'));
      return hit ? { ok: true, buf: hit.buf, sha256: hit.sha256 } : { ok: false, reason: '桩：未命中' };
    },
  };
  let calls = 0;
  const audits = [];
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, fileName,
    {
      shopCfg: { name: '有界店' }, workDir: d.workDir, recoveryDir: d.recoveryDir,
      vaultModule: vaultStub, excludeWorkCopy: true,
      verify: async () => { calls += 1; return { ok: false, classification: 'identity-unverified', reason: '桩：一律待核实' }; },
      audit: (e) => audits.push(e),
    },
  );
  assert.strictEqual(res.ok, false, '全部候选未通过必须如实失败（不谎报恢复）');
  assert.ok(calls <= session.RESTORE_MAX_CANDIDATES, `验证调用必须有界：${calls}`);
  assert.ok(calls >= 3, `重复入档不得将验证次数压到 1（应覆盖多个不同检查点）：${calls}`);
  assert.ok(fs.readFileSync(path.join(d.workDir, fileName)).equals(before), '失败路径必须逐字节保留原工作副本');
  assert.match(res.reason, /全部候选未通过|不盲覆盖/);

  // 无浏览器（生产默认验证器）：不得提升，也不得自启真实浏览器
  const res2 = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, fileName,
    {
      shopCfg: { name: '有界店' }, workDir: d.workDir, recoveryDir: d.recoveryDir,
      vaultModule: vaultStub, excludeWorkCopy: true,
      audit: (e) => audits.push(e),
    },
  );
  assert.strictEqual(res2.ok, false);
  assert.ok(fs.readFileSync(path.join(d.workDir, fileName)).equals(before), '无浏览器时零写入');
  assert.ok(audits.some((a) => a.kind === 'cookie-restore-ranking'), 'fail-closed 路径同样留排名审计');
});

// ── 辅助：与 cookie-four-tier 同构的最小目录集 ──────────────────────────

function mkDirsLikeFourTier() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dian4-restore-chain-')));
  const d = {
    base,
    workDir: path.join(base, 'guard-cookies'),
    recoveryDir: path.join(base, 'cookie-recovery'),
    archiveRoot: path.join(base, 'archive-raw'),
  };
  for (const p of [d.workDir, d.recoveryDir, d.archiveRoot]) fs.mkdirSync(p, { recursive: true });
  return d;
}
