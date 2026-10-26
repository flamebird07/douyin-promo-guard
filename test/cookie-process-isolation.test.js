'use strict';

/**
 * COOKIE-PROCESS-ISOLATION-20261026 专项测试：每份 Cookie（每个恢复候选）必须使用
 * 独立浏览器进程。全部离线（node:test + os.tmpdir() 合成假 Cookie + 脚本化浏览器桩，
 * 无真实浏览器/网络/生产路径/真实凭证）：
 *  1) 默认候选验证器：连续候选先后在两个**不同**浏览器进程验证，前一进程先被证明关闭
 *     才启动下一个；成功提升最终集合（内容隔离：每个进程只注入本候选的 Cookie）；
 *  2) 旧共享 opts.browser 不再被默认验证器接受（fail-closed，零 newContext，零自启）；
 *  3) addCookies / goto 异常路径同样关闭候选专属浏览器进程；
 *  4) 候选浏览器启动失败（工厂抛错=资源状态不确定）→ verify-error + stopChain：不提升、不再调用工厂；
 *  5) 候选浏览器关闭未获证明 → 停止恢复链（不提升、不启动下一候选）；
 *  6) 工厂返回重复实例 → fail-closed 拒绝（绝不跨候选复用同一进程）；
 *  7) 工厂返回主店铺浏览器（forbiddenBrowsers）→ fail-closed 拒绝；
 *  8) 千川入口：恢复成功后重载发生在全新店铺浏览器进程；每次启动都早登记 onResource；
 *  9) 罗盘入口：恢复成功后重载发生在全新店铺浏览器进程（非初始进程）。
 * 运行：node --test douyin-promo-guard/test/cookie-process-isolation.test.js（主脑执行）。
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const session = require('../src/login/session');
const { AuthError, DataGuardError } = require('../src/lib/errors');
const { openQianchuanHome, closeBrowser: closeQianchuanBrowser } = require('../src/adapters/qianchuan-reader');
const { createCompassOrderReader } = require('../src/adapters/compass-order-reader');

const FXG_HOME = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const LOGIN_URL = 'https://fxg.jinritemai.com/ffa/login/expired';
const SHOP_NAME = '隔离店';

function bytesOf(cookies) { return Buffer.from(JSON.stringify(cookies, null, 2), 'utf8'); }
function makeCookies(tag) {
  return [
    { name: 'sessionid', value: `fake-${tag}-synthetic`, domain: '.jinritemai.com', path: '/', expires: 1893456000 },
    { name: 'ttwid', value: `ttw-${tag}`, domain: '.iesdouyin.com', path: '/', expires: 1893456000 },
  ];
}

const temporaryRoots = new Set();
after(() => {
  const root = fs.realpathSync(os.tmpdir());
  for (const dir of temporaryRoots) {
    assert.strictEqual(fs.realpathSync(dir), dir);
    assert.ok(dir.toLowerCase().startsWith((root + path.sep).toLowerCase()));
    assert.ok(path.basename(dir).startsWith('cookie-proc-iso-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function mkDirs() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-proc-iso-')));
  temporaryRoots.add(base);
  const workDir = path.join(base, 'guard-cookies');
  const recoveryDir = path.join(base, 'cookie-recovery');
  fs.mkdirSync(workDir, { recursive: true });
  fs.mkdirSync(recoveryDir, { recursive: true });
  return { base, workDir, recoveryDir };
}

function emptyVaultModule() {
  return {
    defaultRoots: () => ({ archiveRoot: '', recoveryDir: '' }),
    listSnapshotVersions: () => ({ ok: true, versions: [], manifestMissing: false }),
    readSnapshotVersion: () => ({ ok: false, reason: '桩不应被调用' }),
  };
}

// ── 候选验证浏览器桩：记录生命周期轨迹（launch/ctx/addCookies/ctxClose/browserClose）──

/**
 * @param {object} spec { identityName, url?, addCookiesError?, gotoError?, closeReject?,
 *                        stayConnected?, emptyCookies? }
 * @param {string[]} trace 共享轨迹（按发生顺序 push）
 * @param {number} id 本浏览器标识（同一工厂内单调递增 = 必须彼此不同）
 */
function makeCandidateBrowser(spec, trace, id) {
  const cookies = spec.cookies || makeCookies(`cand-${id}`);
  const browser = {
    __id: id,
    __closed: false,
    newContext: async () => {
      trace.push(`ctx:${id}`);
      return {
        addCookies: async (cks) => {
          if (spec.addCookiesError) { trace.push(`addCookies-error:${id}`); throw new Error('stub: addCookies failed'); }
          trace.push(`addCookies:${id}:${cks.map((c) => c.value).join('|')}`);
        },
        newPage: async () => page,
        cookies: async () => (spec.emptyCookies ? [] : cookies),
        close: async () => { trace.push(`ctxClose:${id}`); },
      };
    },
    close: async () => {
      if (spec.closeReject) { trace.push(`browserClose-reject:${id}`); throw new Error('stub: browser close refused'); }
      if (!spec.stayConnected) browser.__closed = true;
      trace.push(`browserClose:${id}`);
    },
    isConnected: () => !browser.__closed,
  };
  const page = {
    url: () => spec.url || FXG_HOME,
    goto: async () => {
      if (spec.gotoError) { trace.push(`goto-error:${id}`); throw new Error('stub: goto failed'); }
      trace.push(`goto:${id}`);
    },
    isClosed: () => false,
    // 与真实探针合同一致：settle 就绪探针（无 distinct 字段）→ true；
    // 语义身份探针（含 distinct）→ 唯一本店/错店名观测。
    evaluate: async (fn) => {
      const src = String(fn);
      if (/distinct/.test(src)) {
        trace.push(`identity:${id}`);
        return { name: spec.identityName, distinct: [spec.identityName], candidates: 1, unique: true, loginVisible: false };
      }
      return true;
    },
    waitForTimeout: async () => {},
  };
  return browser;
}

/** 按脚本逐候选返回全新浏览器的工厂（每次调用 push launch:<id>）；state.launches 计数。 */
function candidateFactoryOf(specs, trace, state) {
  return async () => {
    state.launches += 1;
    const spec = specs[state.launches - 1] || {};
    trace.push(`launch:${state.launches}`);
    return makeCandidateBrowser(spec, trace, state.launches);
  };
}

/**
 * 组装候选：值守工作副本（排除）→ 恢复副本固定路径 cand-a → 版本目录（新→旧）。
 * @param versions [{name:'v20261026T000000Z-2-b.json', tag:'cand-b'}, ...] 按验证顺序
 */
function seedCandidates(d, file, versions) {
  const shopSafeName = file.slice(0, -5);
  fs.writeFileSync(path.join(d.workDir, file), bytesOf(makeCookies('just-failed')));
  fs.writeFileSync(path.join(d.recoveryDir, file), bytesOf(makeCookies('cand-a')));
  const vdir = path.join(d.recoveryDir, shopSafeName);
  fs.mkdirSync(vdir, { recursive: true });
  for (const v of versions) fs.writeFileSync(path.join(vdir, v.name), bytesOf(makeCookies(v.tag)));
}

const restoreBaseOpts = (d, extra = {}) => Object.assign({
  shopCfg: { name: SHOP_NAME, compassShopName: SHOP_NAME },
  excludeWorkCopy: true,
  recoveryDir: d.recoveryDir,
  vaultModule: emptyVaultModule(),
  nowFn: () => 10000,
  verifySettleTimeoutMs: 30,
  verifySettleIntervalMs: 10,
  verifyMaxWaitMs: 10,
  verifySleep: async () => {},
}, extra);

// ── 用例 ──────────────────────────────────────────────────────────

test('1) 连续候选使用两个不同浏览器进程：前一进程先证明关闭再启动下一个；成功提升最终集合', async () => {
  const d = mkDirs();
  const file = '店甲.json';
  seedCandidates(d, file, [{ name: 'v20261026T000000Z-2-b.json', tag: 'cand-b' }]);
  const trace = [];
  const state = { launches: 0 };
  const factory = candidateFactoryOf([
    { identityName: '另一家店' },                            // 候选1（恢复副本固定路径）：错店 → 验证失败
    { identityName: SHOP_NAME, cookies: makeCookies('cand-b') }, // 候选2（版本 v2）：正确店 → 成功
  ], trace, state);
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, file,
    restoreBaseOpts(d, { candidateBrowserFactory: factory }),
  );
  assert.strictEqual(res.ok, true, JSON.stringify(res.attempts));
  assert.strictEqual(res.source, 'guard-recovery:v20261026T000000Z-2-b');
  assert.strictEqual(state.launches, 2, '恰好两个候选各启动一个浏览器进程');
  // 顺序：候选1 进程关闭（含上下文）必须先于候选2 进程启动
  const iCtx1 = trace.indexOf('ctx:1');
  const iClose1 = trace.indexOf('browserClose:1');
  const iLaunch2 = trace.indexOf('launch:2');
  assert.ok(iCtx1 >= 0 && iClose1 > iCtx1, `候选1 必须开过上下文并关闭浏览器: ${trace.join(',')}`);
  assert.ok(iClose1 < iLaunch2, `候选1 浏览器关闭必须先于候选2 启动: ${trace.join(',')}`);
  assert.ok(trace.indexOf('ctxClose:1') < iLaunch2, '候选1 上下文关闭必须先于候选2 启动');
  // 内容隔离：每个进程只注入本候选的 Cookie（值级对账，非源码镜像）
  assert.ok(trace.includes('addCookies:1:fake-cand-a-synthetic|ttw-cand-a'), trace.join(','));
  assert.ok(trace.includes('addCookies:2:fake-cand-b-synthetic|ttw-cand-b'), trace.join(','));
  // 提升的是候选2 验证上下文的最终集合
  assert.ok(fs.readFileSync(path.join(d.workDir, file)).equals(bytesOf(makeCookies('cand-b'))), '提升候选2 最终集合');
});

test('2) 旧共享 opts.browser 不再被默认验证器接受：fail-closed、零 newContext、零自启', async () => {
  const d = mkDirs();
  const file = '店乙.json';
  seedCandidates(d, file, [{ name: 'v20261026T000000Z-2-b.json', tag: 'cand-b' }]);
  const stale = fs.readFileSync(path.join(d.workDir, file));
  let newContextCalls = 0;
  const shared = { newContext: async () => { newContextCalls += 1; throw new Error('不得被调用'); } };
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, file,
    restoreBaseOpts(d, { browser: shared }), // 旧参数：必须被无视，绝不当作候选浏览器
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(newContextCalls, 0, '共享浏览器绝不被默认验证器使用');
  const failed = res.attempts.filter((a) => a.result === 'verify-failed');
  assert.ok(failed.length >= 2, JSON.stringify(res.attempts));
  assert.ok(failed.every((a) => /未提供候选专用浏览器工厂/.test(a.reason || '')),
    '默认验证器必须对每个候选 fail-closed 拒绝（离线零副作用、零自启）');
  assert.ok(fs.readFileSync(path.join(d.workDir, file)).equals(stale), '零提升');
});

test('3) addCookies / goto 异常路径同样关闭候选专属浏览器进程；后续候选继续并成功', async () => {
  const d = mkDirs();
  const file = '店丙.json';
  seedCandidates(d, file, [
    { name: 'v20261026T000000Z-2-b.json', tag: 'cand-b' },
    { name: 'v20261026T000000Z-1-a.json', tag: 'cand-c' },
  ]);
  const trace = [];
  const state = { launches: 0 };
  const factory = candidateFactoryOf([
    { identityName: SHOP_NAME, addCookiesError: true },       // 候选1：注入失败
    { identityName: SHOP_NAME, gotoError: true },             // 候选2：导航失败
    { identityName: SHOP_NAME, cookies: makeCookies('cand-c') }, // 候选3：成功
  ], trace, state);
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, file,
    restoreBaseOpts(d, { candidateBrowserFactory: factory }),
  );
  assert.strictEqual(res.ok, true, JSON.stringify(res.attempts));
  assert.strictEqual(state.launches, 3);
  for (const id of [1, 2]) {
    const iClose = trace.indexOf(`browserClose:${id}`);
    const iNext = trace.indexOf(`launch:${id + 1}`);
    assert.ok(iClose >= 0 && iClose < iNext, `候选${id} 异常后浏览器必须先关闭再启动候选${id + 1}: ${trace.join(',')}`);
  }
  assert.strictEqual(res.attempts.filter((a) => a.result === 'verify-failed').length, 2);
  assert.ok(res.attempts.filter((a) => a.result === 'verify-failed').every((a) => a.classification === 'verify-error'),
    JSON.stringify(res.attempts));
  assert.ok(fs.readFileSync(path.join(d.workDir, file)).equals(bytesOf(makeCookies('cand-c'))));
});

test('4) 候选浏览器启动失败（工厂抛错=不确定启动）→ stopChain：不提升、不再调用工厂（闩锁）', async () => {
  const d = mkDirs();
  const file = '店丁.json';
  seedCandidates(d, file, [{ name: 'v20261026T000000Z-2-b.json', tag: 'cand-b' }]);
  const trace = [];
  let calls = 0;
  const factory = async () => {
    calls += 1;
    trace.push(`launch-error:${calls}`);
    throw new Error('stub: launch failed');
  };
  const before = fs.readFileSync(path.join(d.workDir, file));
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, file,
    restoreBaseOpts(d, { candidateBrowserFactory: factory }),
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(calls, 1, '工厂抛错后必须闩锁：绝不再次调用工厂（可能残留未返回的进程）');
  assert.ok(!trace.includes('launch-error:2'), trace.join(','));
  assert.ok(res.attempts.some((a) => a.result === 'verify-failed' && a.stopChain === true && /启动失败/.test(a.reason || '')),
    JSON.stringify(res.attempts));
  assert.ok(fs.readFileSync(path.join(d.workDir, file)).equals(before), '零提升');
});

test('5) 候选浏览器关闭未获证明 → 停止恢复链：不提升、不启动下一候选', async () => {
  const d = mkDirs();
  const file = '店戊.json';
  seedCandidates(d, file, [{ name: 'v20261026T000000Z-2-b.json', tag: 'cand-b' }]);
  const trace = [];
  const state = { launches: 0 };
  const factory = candidateFactoryOf([
    { identityName: SHOP_NAME, closeReject: true }, // 候选1 验证可过，但进程关闭被拒
  ], trace, state);
  const before = fs.readFileSync(path.join(d.workDir, file));
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, file,
    restoreBaseOpts(d, { candidateBrowserFactory: factory }),
  );
  assert.strictEqual(res.ok, false);
  assert.strictEqual(state.launches, 1, '关闭未获证明必须立即停止：绝不启动候选2 进程');
  assert.ok(!trace.includes('launch:2'), trace.join(','));
  assert.ok(res.attempts.some((a) => a.stopChain === true && /关闭未获证明/.test(a.reason || '')), JSON.stringify(res.attempts));
  assert.ok(fs.readFileSync(path.join(d.workDir, file)).equals(before), '绝不提升');

  // 变体：close 正常返回但进程仍连接（isConnected 恒 true）→ 同样停止
  const d2 = mkDirs();
  const file2 = '店戊2.json';
  seedCandidates(d2, file2, [{ name: 'v20261026T000000Z-2-b.json', tag: 'cand-b' }]);
  const trace2 = [];
  const state2 = { launches: 0 };
  const factory2 = candidateFactoryOf([{ identityName: SHOP_NAME, stayConnected: true }], trace2, state2);
  const before2 = fs.readFileSync(path.join(d2.workDir, file2));
  const res2 = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d2.workDir }, file2,
    restoreBaseOpts(d2, { candidateBrowserFactory: factory2 }),
  );
  assert.strictEqual(res2.ok, false);
  assert.strictEqual(state2.launches, 1, '仍连接同样视为未关闭：停止恢复链');
  assert.ok(fs.readFileSync(path.join(d2.workDir, file2)).equals(before2));
});

test('6) 工厂返回重复实例 → fail-closed 拒绝该候选（绝不跨候选复用同一进程）', async () => {
  const d = mkDirs();
  const file = '店己.json';
  seedCandidates(d, file, [{ name: 'v20261026T000000Z-2-b.json', tag: 'cand-b' }]);
  const trace = [];
  const shared = makeCandidateBrowser({ identityName: '另一家店' }, trace, 1);
  let calls = 0;
  const factory = async () => {
    calls += 1;
    trace.push(`launch:${calls}`);
    return shared; // 每次都返回同一对象：必须被拒
  };
  const before = fs.readFileSync(path.join(d.workDir, file));
  const res = await session.restoreDutyWorkCopy(
    { cookieWorkDir: d.workDir }, file,
    restoreBaseOpts(d, { candidateBrowserFactory: factory }),
  );
  assert.strictEqual(res.ok, false);
  assert.ok(res.attempts.some((a) => a.result === 'verify-failed' && /重复\/共享的浏览器实例/.test(a.reason || '')),
    JSON.stringify(res.attempts));
  assert.ok(fs.readFileSync(path.join(d.workDir, file)).equals(before), '零提升');
});

test('7) 工厂返回主店铺浏览器（forbiddenBrowsers）→ fail-closed 拒绝验证', async () => {
  const mainShopBrowser = makeCandidateBrowser({ identityName: SHOP_NAME }, [], 99);
  const verifier = session.createDefaultCandidateVerifier(
    { },
    { candidateBrowserFactory: async () => mainShopBrowser, forbiddenBrowsers: [mainShopBrowser] },
  );
  const r = await verifier({ cookies: makeCookies('x'), expectedShopNames: [SHOP_NAME], source: 'guard-recovery' });
  assert.strictEqual(r.ok, false);
  assert.match(r.reason, /重复\/共享的浏览器实例/);
  assert.strictEqual(mainShopBrowser.__closed, true, '被拒绝的实例也要保守关闭');
});

test('11) 上次浏览器关闭失败后，即使调用方再次调用验证器，也不得启动下一进程', async () => {
  let launches = 0;
  const verifier = session.createDefaultCandidateVerifier({}, {
    candidateBrowserFactory: async () => {
      launches += 1;
      return makeCandidateBrowser({ identityName: SHOP_NAME, closeReject: launches === 1 }, [], launches);
    },
    verifySettleTimeoutMs: 30, verifySettleIntervalMs: 10, verifyMaxWaitMs: 10,
  });
  const candidate = { cookies: makeCookies('latch'), expectedShopNames: [SHOP_NAME], source: 'synthetic' };
  assert.strictEqual((await verifier(candidate)).stopChain, true);
  const next = await verifier(candidate);
  assert.strictEqual(launches, 1, '未关闭的旧进程存在时不得调用下一次工厂');
  assert.strictEqual(next.stopChain, true);
  assert.strictEqual(next.ok, false);
});

// ── 真实入口：恢复成功后的重载必须发生在全新店铺浏览器进程 ───────────────

test('8) 千川入口：恢复成功后重载在全新浏览器进程；每次启动都早登记 onResource 收口句柄', async () => {
  const d = mkDirs();
  const file = '千川隔离店.json';
  fs.writeFileSync(path.join(d.workDir, file), bytesOf(makeCookies('expired')));
  const fresh = bytesOf(makeCookies('fresh'));
  fs.writeFileSync(path.join(d.recoveryDir, file), fresh);
  const counters = { contexts: 0, pages: 0, ctxCloses: 0, browserCloses: 0, addedCookieSets: 0 };
  const resources = [];
  let nextId = 0;
  const browserFactory = async () => {
    nextId += 1;
    const id = nextId;
    const browser = {
      __id: id,
      __closed: false,
      newContext: async () => {
        counters.contexts += 1;
        const spec = id === 1
          ? { pages: [vmFxgPage(), vmQcAuthPage()] }
          : { pages: [vmFxgPage(), vmQcOkPage()] };
        const opened = [];
        return {
          addCookies: async () => { counters.addedCookieSets += 1; },
          newPage: async () => {
            counters.pages += 1;
            const pg = spec.pages.shift();
            if (!pg) throw new Error('stub: 会话数超出脚本');
            opened.push(pg);
            return pg;
          },
          close: async () => {
            counters.ctxCloses += 1;
            for (const p of opened) p.__closed = true;
          },
          cookies: async () => [],
          waitForEvent: () => Promise.resolve(null),
          on() {}, off() {},
        };
      },
      close: async () => {
        if (browser.__closed) return;
        browser.__closed = true;
        counters.browserCloses += 1;
      },
      isConnected: () => !browser.__closed,
    };
    return browser;
  };
  const calls = { n: 0 };
  const res = await openQianchuanHome(
    { cookieWorkDir: d.workDir, edgePath: null },
    { id: 's1', name: SHOP_NAME, compassShopName: SHOP_NAME, cookieFile: file, accountId: '1710242295996424' },
    {
      browserFactory,
      settleTimeoutMs: 30, settleIntervalMs: 10,
      readinessTimeoutMs: 30, readinessIntervalMs: 10,
      restoreRecoveryDir: d.recoveryDir,
      restoreVaultModule: emptyVaultModule(),
      restoreRunner: async (...a) => { calls.n += 1; return session.restoreDutyWorkCopy(...a); },
      restoreVerify: async (p) => ({ ok: true, finalCookies: p.cookies }),
      nowFn: () => 20000,
      onResource: (h) => resources.push(h),
    },
  );
  assert.strictEqual(calls.n, 1);
  assert.strictEqual(res.browser.__id, 2, '重载必须发生在第二个（全新）浏览器进程');
  assert.strictEqual(counters.browserCloses, 1, '恢复前旧店铺浏览器进程必须关闭');
  assert.strictEqual(resources.length, 2, '每次启动的浏览器都必须早登记 onResource 收口句柄');
  assert.strictEqual(resources[0].isConnected(), false, '旧进程句柄必须报告已断开');
  assert.strictEqual(resources[1].isConnected(), true, '新进程句柄必须报告在线');
  assert.ok(fs.readFileSync(path.join(d.workDir, file)).equals(fresh), '恢复提升成功');
  assert.strictEqual(counters.contexts, 2, '旧/新店铺浏览器各开一个干净上下文（无合并）');
  assert.strictEqual(counters.addedCookieSets, 2, '重载必须在新进程读新工作副本字节（第二次 addCookies 在新进程）');
  // onResource 最新句柄关闭的是**最新**浏览器；closeBrowser 幂等收口（重复调用不二次关闭）
  await resources[1].close();
  assert.strictEqual(counters.browserCloses, 2);
  assert.strictEqual(resources[1].isConnected(), false);
  await closeQianchuanBrowser(res.browser);
  assert.strictEqual(counters.browserCloses, 2, '同一浏览器重复 closeBrowser 至多关闭一次');
});

test('9) 罗盘入口：恢复成功后重载在全新浏览器进程（非初始进程），旧进程先关闭', async () => {
  const d = mkDirs();
  const file = '罗盘隔离店.json';
  fs.writeFileSync(path.join(d.workDir, file), bytesOf(makeCookies('expired')));
  const fresh = bytesOf(makeCookies('fresh'));
  fs.writeFileSync(path.join(d.recoveryDir, file), fresh);
  const counters = { contexts: 0, pages: 0, gotos: 0, ctxCloses: 0, browserCloses: 0, addedCookieSets: 0 };
  const trace = [];
  let nextId = 0;
  const browserFactory = async () => {
    nextId += 1;
    const id = nextId;
    trace.push(`launch:${id}`);
    const browser = {
      __id: id,
      __closed: false,
      newContext: async () => {
        counters.contexts += 1;
        const idx = counters.contexts;
        const page = {
          __nav: 0,
          url: () => (idx === 1 ? LOGIN_URL : FXG_HOME),
          goto: async () => { counters.gotos += 1; },
          waitForTimeout: async () => {},
          waitForLoadState: async () => {},
          isClosed: () => false,
          evaluate: async () => null,
          close: async () => {},
          getByText: () => ({
            count: async () => 0,
            first: () => ({ waitFor: async () => { throw new Error('stub: not attached'); } }),
          }),
          locator: () => ({ first: () => ({ textContent: async () => '', isVisible: async () => false, count: async () => 0 }) }),
          waitForURL: () => Promise.resolve(null),
          waitForFunction: async () => {},
          screenshot: async () => {},
          context: () => null,
        };
        const ctx = {
          addCookies: async () => { counters.addedCookieSets += 1; },
          newPage: async () => { counters.pages += 1; return page; },
          close: async () => { counters.ctxCloses += 1; },
          cookies: async () => [],
          waitForEvent: () => Promise.resolve(null),
        };
        return ctx;
      },
      close: async () => {
        if (browser.__closed) return;
        browser.__closed = true;
        counters.browserCloses += 1;
        trace.push(`browserClose:${id}`);
      },
      isConnected: () => !browser.__closed,
    };
    return browser;
  };
  const reader = createCompassOrderReader({
    loginCfg: { cookieWorkDir: d.workDir, edgePath: null },
    evidenceDir: path.join(d.base, 'evidence'),
    browserFactory,
    settleTimeoutMs: 30, settleIntervalMs: 10,
    restoreRecoveryDir: d.recoveryDir,
    restoreVaultModule: emptyVaultModule(),
    restoreVerify: async (p) => ({ ok: true, finalCookies: p.cookies }),
    nowFn: () => 20000,
  });
  await assert.rejects(
    () => reader.readOrderSummary({ shopCfg: { id: 's2', name: SHOP_NAME, compassShopName: SHOP_NAME, cookieFile: file } }),
    (e) => {
      assert.ok(e instanceof DataGuardError || e instanceof AuthError, `桩导航失败应如实上抛：${e && e.message}`);
      return true;
    },
  );
  assert.strictEqual(nextId, 2, '恢复成功后必须启动第二个（全新）店铺浏览器进程重载');
  assert.ok(trace.indexOf('browserClose:1') < trace.indexOf('launch:2'), `旧进程必须先证明关闭再启动新进程: ${trace.join(',')}`);
  assert.strictEqual(counters.browserCloses, 2, '旧进程关闭 + finally 关闭新进程');
  assert.strictEqual(counters.contexts, 2, '旧/新店铺浏览器各开一个干净上下文（无合并）');
  assert.strictEqual(counters.addedCookieSets, 2, '重载必须在新进程读新工作副本字节（第二次 addCookies 在新进程）');
  assert.ok(fs.readFileSync(path.join(d.workDir, file)).equals(fresh), '恢复提升成功');
});

test('10) 恢复后注入工厂返回同一个旧浏览器对象 → 重载在 addCookies 之前被拒（千川与罗盘）', async () => {
  // 千川入口：恢复成功后重载时工厂复用旧店铺浏览器对象 → 必须在 addCookies 前拒绝并收口
  {
    const d = mkDirs();
    const file = '千川复用店.json';
    fs.writeFileSync(path.join(d.workDir, file), bytesOf(makeCookies('expired')));
    fs.writeFileSync(path.join(d.recoveryDir, file), bytesOf(makeCookies('fresh')));
    const counters = { contexts: 0, addedCookieSets: 0, browserCloses: 0 };
    const shared = {
      __closed: false,
      newContext: async () => {
        counters.contexts += 1;
        const opened = [];
        return {
          addCookies: async () => { counters.addedCookieSets += 1; },
          newPage: async () => {
            const pg = opened.length === 0 ? vmFxgPage() : vmQcAuthPage();
            opened.push(pg);
            return pg;
          },
          close: async () => { for (const p of opened) p.__closed = true; },
          cookies: async () => [],
          waitForEvent: () => Promise.resolve(null),
          on() {}, off() {},
        };
      },
      close: async () => { shared.__closed = true; counters.browserCloses += 1; },
      isConnected: () => !shared.__closed,
    };
    await assert.rejects(
      () => openQianchuanHome(
        { cookieWorkDir: d.workDir, edgePath: null },
        { id: 's1r', name: SHOP_NAME, compassShopName: SHOP_NAME, cookieFile: file, accountId: 'a1' },
        {
          browserFactory: async () => shared,
          settleTimeoutMs: 30, settleIntervalMs: 10,
          readinessTimeoutMs: 30, readinessIntervalMs: 10,
          restoreRecoveryDir: d.recoveryDir,
          restoreVaultModule: emptyVaultModule(),
          restoreRunner: async (...a) => session.restoreDutyWorkCopy(...a),
          restoreVerify: async (p) => ({ ok: true, finalCookies: p.cookies }),
          nowFn: () => 20000,
        },
      ),
      (e) => /重复的浏览器实例/.test(String(e && e.message)),
    );
    assert.strictEqual(counters.contexts, 1, '复用被拒：除旧进程上下文外零新上下文');
    assert.strictEqual(counters.addedCookieSets, 1, '第二次 addCookies 绝不发生（复用旧进程必须先被拒）');
    assert.strictEqual(shared.__closed, true, '被拒的复用实例必须被关闭');
  }
  // 罗盘入口：同语义
  {
    const d = mkDirs();
    const file = '罗盘复用店.json';
    fs.writeFileSync(path.join(d.workDir, file), bytesOf(makeCookies('expired')));
    fs.writeFileSync(path.join(d.recoveryDir, file), bytesOf(makeCookies('fresh')));
    const counters = { contexts: 0, addedCookieSets: 0, browserCloses: 0 };
    const shared = {
      __closed: false,
      newContext: async () => {
        counters.contexts += 1;
        const page = {
          url: () => LOGIN_URL,
          goto: async () => {},
          waitForTimeout: async () => {},
          waitForLoadState: async () => {},
          isClosed: () => false,
          evaluate: async () => null,
          close: async () => {},
          getByText: () => ({ count: async () => 0, first: () => ({ waitFor: async () => { throw new Error('stub: not attached'); } }) }),
          locator: () => ({ first: () => ({ textContent: async () => '', isVisible: async () => false, count: async () => 0 }) }),
          waitForURL: () => Promise.resolve(null),
          waitForFunction: async () => {},
          screenshot: async () => {},
          context: () => null,
        };
        return {
          addCookies: async () => { counters.addedCookieSets += 1; },
          newPage: async () => page,
          close: async () => {},
          cookies: async () => [],
          waitForEvent: () => Promise.resolve(null),
        };
      },
      close: async () => { shared.__closed = true; counters.browserCloses += 1; },
      isConnected: () => !shared.__closed,
    };
    const reader = createCompassOrderReader({
      loginCfg: { cookieWorkDir: d.workDir, edgePath: null },
      evidenceDir: path.join(d.base, 'evidence'),
      browserFactory: async () => shared,
      settleTimeoutMs: 30, settleIntervalMs: 10,
      restoreRecoveryDir: d.recoveryDir,
      restoreVaultModule: emptyVaultModule(),
      restoreVerify: async (p) => ({ ok: true, finalCookies: p.cookies }),
      nowFn: () => 20000,
    });
    await assert.rejects(
      () => reader.readOrderSummary({ shopCfg: { id: 's2r', name: SHOP_NAME, compassShopName: SHOP_NAME, cookieFile: file } }),
      (e) => /重复的浏览器实例/.test(String(e && e.message)),
    );
    assert.strictEqual(counters.contexts, 1, '复用被拒：除旧进程上下文外零新上下文');
    assert.strictEqual(counters.addedCookieSets, 1, '第二次 addCookies 绝不发生（复用旧进程必须先被拒）');
    assert.strictEqual(shared.__closed, true, '被拒的复用实例必须被关闭');
  }
});

// ── 千川用最小 vm DOM 页面（与 qianchuan-mid-session-restore.test.js 同协议的精简版）──

function splitCompound(sel) {
  const out = [];
  const re = /([a-zA-Z][a-zA-Z0-9-]*)|(\.[a-zA-Z0-9_-]+)|(\[[^\]]+\])/g;
  let m;
  while ((m = re.exec(sel))) out.push(m[0]);
  return out;
}
function matchesSimple(el, sel) {
  for (const p of splitCompound(sel)) {
    if (p.startsWith('.')) {
      if (!String(el.attrs['class'] || '').split(/\s+/).includes(p.slice(1))) return false;
    } else if (p.startsWith('[')) {
      const am = /^\[\s*([a-zA-Z0-9_-]+)\s*(?:([*^$]?=)\s*"([^"]*)")?\s*\]$/.exec(p);
      if (!am) return false;
      const [, attr, op, want] = am;
      const have = el.attrs[attr];
      if (have === undefined) return false;
      if (op === '=' && String(have) !== want) return false;
      if (op === '*=' && !String(have).includes(want)) return false;
      if (op === '^=' && !String(have).startsWith(want)) return false;
    } else if (String(el.tagName).toLowerCase() !== p.toLowerCase()) return false;
  }
  return true;
}
function matchesSelector(el, selector) {
  const segments = String(selector).trim().split(/\s+/);
  if (!matchesSimple(el, segments[segments.length - 1])) return false;
  let need = segments.slice(0, -1);
  let node = el.parentElement;
  while (need.length && node) {
    if (matchesSimple(node, need[need.length - 1])) need = need.slice(1);
    node = node.parentElement;
  }
  return need.length === 0;
}
function el(spec = {}) {
  const node = {
    tagName: String(spec.tag || 'div').toUpperCase(),
    attrs: Object.assign({}, spec.attrs || {}),
    __style: Object.assign({ display: 'block', visibility: 'visible' }, spec.style || {}),
    __rect: Object.assign({ width: 120, height: 30 }, spec.rect || {}),
    children: spec.children || [],
    parentElement: null,
    innerText: spec.text || '',
    textContent: spec.text || '',
    getAttribute(name) { return name in this.attrs ? String(this.attrs[name]) : null; },
    getBoundingClientRect() { return Object.assign({}, this.__rect); },
    click() {},
  };
  node.childNodes = node.children;
  for (const c of node.children) if (!c.parentElement) c.parentElement = node;
  return node;
}
function makeVmPage(url, roots) {
  const body = el({ tag: 'body', children: roots });
  const pick = (selector) => {
    const out = [];
    const walk = (n) => { out.push(n); n.children.forEach(walk); };
    walk(body);
    return out.filter((e) => String(selector).split(',').some((p) => matchesSelector(e, p.trim())));
  };
  const document = { body, querySelector: (s) => pick(s)[0] || null, querySelectorAll: (s) => pick(s) };
  const sandbox = {
    document,
    getComputedStyle: (n) => ({ display: n.__style.display, visibility: n.__style.visibility }),
    location: { href: url },
  };
  sandbox.window = sandbox;
  const vctx = vm.createContext(sandbox);
  const emptyLoc = {
    count: async () => 0, isVisible: async () => false,
    nth() { return this; }, first() { return this; },
    click: async () => {}, waitFor: async () => {}, evaluate: async () => false,
  };
  const page = {
    __url: url, __closed: false,
    url: () => page.__url,
    goto: async (u) => { page.__url = u; },
    evaluate: async (fn, ...args) => {
      try {
        const src = '(' + fn.toString() + ')(' + args.map((a) => JSON.stringify(a)).join(',') + ')';
        return vm.runInContext(src, vctx);
      } catch (_) { return undefined; }
    },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    waitForFunction: async () => {},
    isClosed: () => page.__closed === true,
    close: async () => { page.__closed = true; },
    getByText: () => emptyLoc,
    getByRole: () => emptyLoc,
    locator: () => emptyLoc,
    waitForEvent: () => Promise.resolve(null),
    waitForURL: () => Promise.resolve(null),
    screenshot: async () => {},
  };
  return page;
}
const vmFxgPage = () => makeVmPage(FXG_HOME, [el({ attrs: { class: 'index_userName_main' }, text: SHOP_NAME })]);
const vmQcAuthPage = () => makeVmPage(
  'https://qianchuan.jinritemai.com/home?aavid=1710242295996424',
  [el({ tag: 'input', attrs: { type: 'password' }, rect: { width: 220, height: 32 } })],
);
const vmQcOkPage = () => makeVmPage(
  'https://qianchuan.jinritemai.com/home?aavid=1710242295996424',
  [el({ attrs: { class: 'summaryCard-main' }, text: '账户整体消耗(元) 12.34 相比上周期 +0.00%' })],
);
