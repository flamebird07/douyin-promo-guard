'use strict';

/**
 * D5G GUARD CHECKPOINT PROCESS ISOLATION：检查点写前候选验证的独立浏览器进程语义。
 *
 * 背景（主脑核实）：session-cookie-checkpoint 的默认验证器旧实现经 p.browser /
 * p.context.browser() 借用**主业务浏览器**开新 context —— 候选验证仍与主业务同进程，
 * 违反用户"每份 Cookie 独立浏览器进程"要求。本文件锁定新合同：
 *  - 默认验证器**必须**拿到显式 candidateBrowserFactory（每次调用全新实例）；
 *    缺工厂 fail-closed 零启动/零 context/零写入，绝不自启真实浏览器；
 *  - 绝不调用主业务浏览器的 newContext / context.browser()（即使 context 提供）；
 *  - forbiddenBrowsers（主业务浏览器身份）或重复实例被工厂返回 → fail-closed 停链并
 *    闩锁（后续候选不再调用工厂），但**绝不关闭**非本轮新启的浏览器——外部健康主
 *    浏览器零 newContext/零 close/保持连接；只有本轮新启且全新独有的实例才在收尾关闭；
 *  - 每次验证（含错误路径）都关闭**自己**的 context 与浏览器进程并给出证明；
 *  - 消费方时序：openQianchuanHome 返回前零检查点（业务数据读取不被并行验证/
 *    令牌轮换干扰）；closeBrowser 先收尾检查点恰好一次，再关自己的主浏览器；
 *    重复 close 幂等。
 *
 * 全部离线合成：mock 浏览器/页面 + os.tmpdir() 临时文件 + 假 Cookie（无真实凭证、
 * 无网络、无真实浏览器、零广告动作）。运行由主脑统一执行（本 Worker 不运行命令）。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createCheckpointCandidateVerifier,
  checkpointQianchuanSessionCookies,
} = require('../src/login/session-cookie-checkpoint');
const { fingerprintFile } = require('../src/login/cookie-writeback');
const { openQianchuanHome, closeBrowser } = require('../src/adapters/qianchuan-reader');

const SHOP_NAME = '隔离测试店';
const QC_ACCOUNT = '1710242295996424';
const SHOP_CFG = { id: 'shop-d5g', name: SHOP_NAME, compassShopName: SHOP_NAME, cookieFile: SHOP_NAME, accountId: QC_ACCOUNT };
const FXG_HOME = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const QC_HOME = 'https://qianchuan.jinritemai.com/home';

let dir = null;
const workRoots = [];
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-process-iso-')); });
after(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  for (const w of workRoots) { try { fs.rmSync(w, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
});
function newWorkDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `checkpoint-process-iso-work-${tag}-`));
  workRoots.push(d);
  return d;
}
function cookieFilePath(name = SHOP_NAME) { return path.join(dir, `${name}.json`); }
function writeCookieFile(cookies, name = SHOP_NAME) {
  fs.writeFileSync(cookieFilePath(name), JSON.stringify(cookies, null, 2));
  return fingerprintFile(cookieFilePath(name));
}
/** 假 Cookie 数组（无真实凭证；满足写入器域完整性/数量守卫）。 */
function fakeCookies(n = 3, tag = 'D5G') {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      name: `ck_${i}`, value: `FAKE_NOT_REAL_${tag}_${i}`,
      domain: i === 0 ? '.fxg.jinritemai.com' : '.jinritemai.com',
      path: '/', expires: Math.floor(Date.now() / 1000) + 86400,
      httpOnly: true, secure: true, sameSite: 'Lax',
    });
  }
  return out;
}

// ── mock 浏览器 fixture ──────────────────────────────────────────

/** 主业务浏览器（会记录 newContext/close 调用；健康默认保持连接）。 */
function makeMainBrowser(context) {
  const rec = { newContextCalls: 0, closeCalls: 0 };
  const browser = {
    async newContext() {
      rec.newContextCalls += 1;
      return context;
    },
    async close() { rec.closeCalls += 1; },
    isConnected: () => rec.closeCalls === 0,
  };
  return { browser, rec };
}

/**
 * 候选专用独立浏览器工厂：每次调用返回**全新**实例（对象身份查重可通过），
 * 记录启动/关闭次数；每个实例自有 context/page，页面以唯一本店语义身份应答。
 */
function makeVerifyFactory({ shopName = SHOP_NAME, gotoThrows = false } = {}) {
  const seen = { launched: 0, closed: 0, instances: [] };
  const factory = async () => {
    seen.launched += 1;
    let connected = true;
    let injected = [];
    const page = {
      async goto() { if (gotoThrows) throw new Error('goto failed (mock)'); },
      url: () => FXG_HOME,
      isClosed: () => false,
      async evaluate(fn) {
        const src = String(fn);
        if (/loginVisible/.test(src)) {
          return { name: shopName, distinct: [shopName], candidates: 1, unique: true, loginVisible: false };
        }
        return true; // settle 就绪探针
      },
    };
    const ctx = {
      async addCookies(c) { injected = Array.isArray(c) ? c.slice() : []; },
      async newPage() { return page; },
      async cookies() { return injected.slice(); },
      async close() {},
    };
    const browser = {
      __verifyInstance: seen.launched,
      async newContext() { return ctx; },
      async close() { seen.closed += 1; connected = false; },
      isConnected: () => connected,
    };
    seen.instances.push(browser);
    return browser;
  };
  factory.seen = seen;
  return factory;
}

/** 千川检查点直测 stub：context（可挂 browser() 指向主浏览器）+ 固定 QC 首页页。 */
function makeQcCheckpointStub({ cookies = fakeCookies(4), mainBrowser = null } = {}) {
  const rec = { cookieReads: 0 };
  const cookiesFn = typeof cookies === 'function' ? cookies : async () => cookies;
  const page = {
    url: () => QC_HOME,
    isClosed: () => false,
    async evaluate(fn) {
      if (/shop-name/.test(String(fn))) {
        return {
          accountId: QC_ACCOUNT, accountName: '伊人美',
          candidates: 1, unique: true, loginVisible: false,
        };
      }
      return null;
    },
  };
  page.context = () => context;
  const context = {
    cookies: async () => { rec.cookieReads += 1; return cookiesFn(); },
  };
  if (mainBrowser) context.browser = () => mainBrowser;
  return { page, context, rec };
}

const VERIFY_OPTS = { sleep: async () => {}, maxWaitMs: 4000 };

// ── 1) 默认验证器：绝不借用主业务浏览器 ────────────────────────────

test('默认检查点验证：context 提供 browser() 也不被调用——主浏览器 newContext 零次、保持连接', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const stub0 = makeQcCheckpointStub();
  const { browser: main, rec: mainRec } = makeMainBrowser(stub0.context);
  const stub = makeQcCheckpointStub({ mainBrowser: main });
  const cookieSession = { filePath: cookieFilePath(), startFingerprint: fingerprintFile(cookieFilePath()) };
  // 成功路径（显式候选工厂）：验证全程不得触碰主浏览器。
  const r = await checkpointQianchuanSessionCookies({
    context: stub.context, cookieSession, target: stub.page, shopCfg: SHOP_CFG,
    candidateBrowserFactory: makeVerifyFactory(),
    candidateVerifyOptions: VERIFY_OPTS,
  });
  assert.strictEqual(r.saved, true);
  assert.strictEqual(mainRec.newContextCalls, 0, '主业务浏览器 newContext 绝不被检查点验证调用');
  assert.strictEqual(main.closeCalls || mainRec.closeCalls, 0, '主业务浏览器绝不被检查点关闭');
  assert.strictEqual(main.isConnected(), true, '主业务浏览器保持连接');
  assert.notDeepStrictEqual(fs.readFileSync(cookieFilePath()), before, '独立验证通过后正常落盘');
});

test('缺 candidateBrowserFactory：默认验证器 fail-closed——零启动、零 context、零写入（不自启真实浏览器）', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const { browser: main, rec: mainRec } = makeMainBrowser();
  const stub = makeQcCheckpointStub({ mainBrowser: main });
  const cookieSession = { filePath: cookieFilePath(), startFingerprint: fingerprintFile(cookieFilePath()) };
  const r = await checkpointQianchuanSessionCookies({
    context: stub.context, cookieSession, target: stub.page, shopCfg: SHOP_CFG,
    candidateVerifyOptions: VERIFY_OPTS,
  });
  assert.strictEqual(r.saved, false, '缺工厂 → fail-closed 拒绝写入');
  assert.strictEqual(r.skipped, true);
  assert.match(r.reason, /候选未通过独立复用\/身份验证/, '拒绝原因来自写前独立验证门');
  assert.strictEqual(mainRec.newContextCalls, 0);
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before, '零写入：文件字节不变');
  // 直接合同：验证器在缺工厂时立即返回固定脱敏原因，不触碰任何对象。
  const v = createCheckpointCandidateVerifier({ expectedNames: [SHOP_NAME], sleep: async () => {} });
  const ck2 = fakeCookies(2);
  const ser2 = JSON.stringify(ck2, null, 2);
  const vr = await v({ cookies: ck2, serialized: ser2, buf: Buffer.from(ser2, 'utf8'), sha256: null });
  assert.strictEqual(vr.ok, false);
  assert.match(vr.reason, /candidateBrowserFactory/);
});

// ── 2) 工厂返回被禁止/重复实例：只关被拒实例，主浏览器不受影响 ────────

test('工厂返回主业务浏览器（forbiddenBrowsers）→ 工厂确被调用且由验证器实际拒绝，绝不关闭主浏览器', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const { browser: main, rec: mainRec } = makeMainBrowser();
  const stub = makeQcCheckpointStub({ mainBrowser: main });
  const cookieSession = { filePath: cookieFilePath(), startFingerprint: fingerprintFile(cookieFilePath()) };
  let factoryCalls = 0;
  const forbiddenFactory = async () => { factoryCalls += 1; return main; };
  const r = await checkpointQianchuanSessionCookies({
    context: stub.context, cookieSession, target: stub.page, shopCfg: SHOP_CFG,
    candidateBrowserFactory: forbiddenFactory,
    forbiddenBrowsers: [main],
    candidateVerifyOptions: VERIFY_OPTS,
  });
  assert.strictEqual(factoryCalls, 1, '拒绝必须发生在验证器实际调用工厂之后（不得在身份门早退时伪通过）');
  assert.strictEqual(r.saved, false, '被禁止实例 → 拒绝验证/写入');
  assert.match(r.reason, /重复\/共享|独立复用\/身份验证/, '拒绝原因来自写前独立验证门');
  assert.strictEqual(mainRec.closeCalls, 0, '绝不关闭外部健康主浏览器');
  assert.strictEqual(mainRec.newContextCalls, 0, '主业务浏览器绝不被开新 context');
  assert.strictEqual(main.isConnected(), true);
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before, '零写入');
});

test('验证器直测：工厂返回禁止的主业务浏览器 → 零 newContext/零 close/保持连接；闩锁后第二次调用不再调用工厂', async () => {
  const { browser: main, rec: mainRec } = makeMainBrowser();
  let factoryCalls = 0;
  const forbiddenFactory = async () => { factoryCalls += 1; return main; };
  const v = createCheckpointCandidateVerifier({
    expectedNames: [SHOP_NAME],
    candidateBrowserFactory: forbiddenFactory,
    forbiddenBrowsers: [main],
    sleep: async () => {},
  });
  const ck = fakeCookies(2);
  const ser = JSON.stringify(ck, null, 2);
  const cand = { cookies: ck, serialized: ser, buf: Buffer.from(ser, 'utf8'), sha256: null };
  const vr = await v(cand);
  assert.strictEqual(vr.ok, false);
  assert.strictEqual(vr.stopChain, true, '被禁止实例必须停链');
  assert.strictEqual(vr.classification, 'verify-error');
  assert.strictEqual(factoryCalls, 1);
  assert.strictEqual(mainRec.newContextCalls, 0, '绝不给主业务浏览器开新 context');
  assert.strictEqual(mainRec.closeCalls, 0, '绝不关闭主业务浏览器');
  assert.strictEqual(main.isConnected(), true, '主业务浏览器保持连接');
  const vr2 = await v(cand);
  assert.strictEqual(vr2.ok, false, '闩锁后后续候选一律拒绝');
  assert.strictEqual(factoryCalls, 1, '闩锁后第二次调用不再调用工厂');
});

test('验证器直测：同一工厂返回重复实例被拒；每次成功验证关闭自己的浏览器', async () => {
  const goodFactory = makeVerifyFactory();
  let inst = null;
  const reuseFactory = async () => {
    if (!inst) inst = await goodFactory();
    return inst;
  };
  const ck2 = fakeCookies(2);
  const ser2 = JSON.stringify(ck2, null, 2);
  const cand = { cookies: ck2, serialized: ser2, buf: Buffer.from(ser2, 'utf8'), sha256: null };
  const v = createCheckpointCandidateVerifier({
    expectedNames: [SHOP_NAME], candidateBrowserFactory: reuseFactory, sleep: async () => {},
  });
  const ok1 = await v(cand);
  assert.strictEqual(ok1.ok, true);
  assert.ok(Array.isArray(ok1.finalCookies) && ok1.finalCookies.length === 2, '返回最终已验证集合');
  assert.strictEqual(goodFactory.seen.launched, 1);
  assert.strictEqual(goodFactory.seen.closed, 1, '自己的浏览器进程用毕关闭');
  // 第二次验证工厂返回**同一个旧实例** → 重复身份拒绝（每个候选必须全新独立进程）。
  const r2 = await v(cand);
  assert.strictEqual(r2.ok, false);
  assert.match(r2.reason, /重复|全新独立进程/);
});

// ── 3) 错误路径：自有浏览器仍被关闭 ────────────────────────────────

test('验证页 goto 抛错（错误路径）→ verify-error，自有浏览器仍被关闭', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const failingFactory = makeVerifyFactory({ gotoThrows: true });
  const { browser: main, rec: mainRec } = makeMainBrowser();
  const stub = makeQcCheckpointStub({ mainBrowser: main });
  const cookieSession = { filePath: cookieFilePath(), startFingerprint: fingerprintFile(cookieFilePath()) };
  const r = await checkpointQianchuanSessionCookies({
    context: stub.context, cookieSession, target: stub.page, shopCfg: SHOP_CFG,
    candidateBrowserFactory: failingFactory,
    candidateVerifyOptions: VERIFY_OPTS,
  });
  assert.strictEqual(r.saved, false, '验证异常 → 拒绝写入');
  assert.strictEqual(failingFactory.seen.launched, 1);
  assert.strictEqual(failingFactory.seen.closed, 1, '错误路径也必须关闭自己的浏览器进程');
  assert.strictEqual(mainRec.closeCalls, 0, '主业务浏览器不受错误路径影响');
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before, '零写入');
});

// ── 4) 消费方时序（openQianchuanHome / closeBrowser）──────────────

/**
 * openQianchuanHome 离线 fixture：goto 记录**传入 URL**（初始 FXG 主页不会被伪造成
 * 千川页），入口点击才把地址推进到千川首页；evaluate 按当前路由分派——FXG 主页应答
 * settle 就绪/抖店语义店铺名探针，QC 页应答视图/账户头部探针。严格 45s 收敛因此首轮
 * 即命中（零真实等待，无需注入时钟）。
 */
function makeOpenStub({ cookies = fakeCookies(4) } = {}) {
  const calls = { closes: 0, cookieReads: 0 };
  const order = [];
  let lastUrl = FXG_HOME;
  let closed = false;
  const onFxgHome = () => /fxg\.jinritemai\.com\/ffa\/mshop\/homepage/.test(lastUrl);
  const cookiesFn = typeof cookies === 'function' ? cookies : async () => cookies;
  const page = {
    goto: async (u) => { lastUrl = String(u); },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    waitForFunction: async () => null,
    waitForURL: async () => null,
    waitForEvent: async () => null,
    url: () => lastUrl,
    isClosed: () => closed,
    screenshot: async () => {},
    title: async () => '巨量千川',
    reload: async () => {},
    goBack: async () => {},
    keyboard: { press: async () => {} },
    evaluate: async (fn, arg) => {
      const src = String(fn);
      // settle 就绪探针：只在抖店首页应答就绪（严格首页判定的路由感知假页）
      if (arg === undefined && /index_headerShopName/.test(src)) return onFxgHome();
      if (arg === undefined && /扫码登录|login-form/.test(src)) {
        return { loginForm: false, loginControl: false, loginDialog: false };
      }
      // 抖店语义店铺名探针（probeDoudianShopIdentityInPage）：仅 FXG 身份页应答唯一本店。
      // 千川头部探针（probeQianchuanHeaderIdentityInPage）源码同样含 loginVisible，但含
      // shop-name；必须先由下方千川分支应答，否则观测被伪造成抖店对象 → 收尾检查点误跳过。
      if (/loginVisible/.test(src) && !/shop-name/.test(src)) {
        return onFxgHome()
          ? { name: SHOP_NAME, distinct: [SHOP_NAME], candidates: 1, unique: true, loginVisible: false }
          : null;
      }
      if (arg === undefined && /summaryCard/.test(src)) {
        return { href: lastUrl, shopView: false, switchPresent: false, accountContent: true, popup: { present: false, safe: false } };
      }
      // 千川头部账户探针（probeQianchuanHeaderIdentityInPage）：仅 QC 页应答唯一账户
      if (/shop-name/.test(src)) {
        return { accountId: QC_ACCOUNT, accountName: '伊人美', candidates: 1, unique: true, loginVisible: false };
      }
      return null;
    },
    getByText: () => ({
      first() { return this; }, nth() { return this; },
      count: async () => 1,
      // 入口点击 = 唯一的地址推进点：抖店首页 → 千川首页
      click: async () => { lastUrl = QC_HOME; },
      waitFor: async () => {},
      evaluate: async () => '', isVisible: async () => false, textContent: async () => '',
    }),
    getByRole: () => ({ count: async () => 0 }),
    locator: () => ({
      nth: () => ({
        first() { return this; },
        locator: () => ({ first() { return this; }, waitFor: async () => {}, click: async () => {} }),
        evaluate: async () => '', click: async () => {}, waitFor: async () => {}, textContent: async () => '',
      }),
      first() { return this; }, waitFor: async () => {}, click: async () => {}, textContent: async () => '',
    }),
  };
  page.context = () => context;
  const context = {
    addCookies: async () => {},
    newPage: async () => page,
    waitForEvent: async () => null,
    on() {}, off() {},
    cookies: async () => { calls.cookieReads += 1; return cookiesFn(); },
  };
  const browser = {
    newContext: async () => context,
    async close() { calls.closes += 1; closed = true; order.push('main-closed'); },
    isConnected: () => calls.closes === 0,
  };
  return { page, context, browser, calls, order };
}

test('消费方时序：打开后业务数据读取前零检查点/零候选浏览器启动；closeBrowser 先检查点后关主浏览器；重复 close 幂等', async () => {
  const workDir = newWorkDir('order');
  writeCookieFile(fakeCookies(3));
  const srcBefore = fingerprintFile(cookieFilePath());
  const stub = makeOpenStub({ cookies: fakeCookies(4) });
  const order = stub.order;
  const verifyFactory = makeVerifyFactory();
  let checkpointCalls = 0;
  const opened = await openQianchuanHome(
    { cookieSourceDir: dir, cookieWorkDir: workDir, edgePath: 'edge' },
    { cookieFile: SHOP_NAME, name: SHOP_NAME, accountId: QC_ACCOUNT },
    {
      browserFactory: async () => stub.browser,
      restoreCandidateBrowserFactory: verifyFactory,
      sessionCheckpoint: async (args) => {
        checkpointCalls += 1;
        order.push('checkpoint');
        const { checkpointQianchuanSessionCookies: real } = require('../src/login/session-cookie-checkpoint');
        return real(args);
      },
    }
  );
  assert.strictEqual(checkpointCalls, 0, 'openQianchuanHome 返回前零检查点（无入口保存）');
  assert.strictEqual(verifyFactory.seen.launched, 0, '业务数据读取前零候选验证浏览器启动（无并行验证会话）');
  // 调用方业务数据读取（模拟 readCostSummary 首个页面读取）：此时尚无任何验证/轮换。
  order.push('business-read');
  await opened.target.evaluate(() => 'cost-data');
  assert.strictEqual(checkpointCalls, 0, '业务数据读取期间仍零检查点');
  assert.strictEqual(verifyFactory.seen.launched, 0, '业务读取期间零候选验证浏览器');
  await closeBrowser(opened.browser);
  assert.strictEqual(checkpointCalls, 1, 'closeBrowser 收尾检查点恰好一次');
  assert.strictEqual(stub.calls.closes, 1, '主浏览器只关闭一次');
  assert.strictEqual(verifyFactory.seen.launched, 1, '收尾验证经候选专用独立浏览器（全新进程）');
  assert.strictEqual(verifyFactory.seen.closed, 1, '候选验证浏览器用毕关闭');
  assert.deepStrictEqual(order, ['business-read', 'checkpoint', 'main-closed'],
    '顺序证明：业务读取 → 收尾检查点 → 关主浏览器（读取先于最终化，不受验证期令牌轮换影响；这是代码顺序证明，不宣称平台轮换导致过事故）');
  assert.strictEqual(JSON.parse(fs.readFileSync(opened.cookieSession.filePath, 'utf-8')).length, 4, '关闭前回写刷新 Cookie');
  assert.deepStrictEqual(fingerprintFile(cookieFilePath()), srcBefore, '只读上游来源字节/mtime 不变');
  // 重复 close：不再二次最终化/二次关闭。
  await closeBrowser(opened.browser);
  assert.strictEqual(checkpointCalls, 1);
  assert.strictEqual(stub.calls.closes, 1);
});
