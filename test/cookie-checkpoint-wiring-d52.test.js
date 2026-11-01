'use strict';

/**
 * D52 Cookie 检查点接线回归（只针对"缺候选专用浏览器工厂"这一已实证断链）。
 *
 * 背景（observed-cookie-failures.json，2026-10-30 当天 11 次同形失败）：乘方链路
 * openChengfangShop 的 manager-ready / 错误收尾检查点只拿到 context/cookieSession/
 * target/shopCfg/audit，没有候选专用独立浏览器工厂（candidateBrowserFactory），
 * D5G 起写前独立验证 fail-closed 拒绝 → 会话 Cookie 刷新永远不能落盘（缺依赖，
 * 不是 Cookie 过期证明）。
 *
 * 本回归用 fakeCookie/临时根/fake 独立 browser/context + **真实**检查点实现
 * （session-cookie-checkpoint + cookie-writeback 真实落盘）证明：
 *  1. 接线后乘方 manager-ready 检查点经本次可信 open 的候选专用工厂真实保存并推进
 *     指纹；业务浏览器零关闭；候选浏览器全部自证关闭恰好一次；
 *  2. 错误路径检查点同样接到工厂；原始错误原样抛出不被 Cookie 保存掩盖；关闭收口
 *     只关自有候选，业务浏览器照常关闭；
 *  3. 缺工厂（D52 之前的生产接线状态）→ 检查点自身 fail-closed 拒绝（复现线上同形失败）；
 *  4. 工厂返回主业务浏览器 → 拒绝且绝不关闭业务浏览器（D5G 保护原样保留）；
 *  5. foreign 身份 / 可见登录控件 / 源 context 漂移 / 目标 CAS 漂移 → 一律不写；
 *  6. 临时能力为非枚举引用：不进 JSON 序列化，不跨店/跨 open 串用。
 *
 * 运行：node --test douyin-promo-guard/test/cookie-checkpoint-wiring-d52.test.js
 * 隔离：无真实 Cookie 值、无网络、无真实浏览器、无广告动作；全部落盘在 OS 临时目录。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  checkpointQianchuanSessionCookies,
} = require('../src/login/session-cookie-checkpoint');
const { fingerprintFile } = require('../src/login/cookie-writeback');
const { openChengfangShop } = require('../src/adapters/chengfang-reader');

const ACCOUNT = '1710242295996424';
const SHOP_NAME = '测试店铺';
const QC_HOME = `https://qianchuan.jinritemai.com/home?aavid=${ACCOUNT}`;
const QC_OVERALL = 'https://qianchuan.jinritemai.com/overall-prom';
const FXG_HOME = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const QC_LOGIN = 'https://qianchuan.jinritemai.com/login/common';

const tempRoots = [];
before(() => {});
after(() => {
  for (const d of tempRoots) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  }
});

function newTempRoot(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `d52-wiring-${tag}-`));
  tempRoots.push(d);
  return d;
}

/** 假 Cookie 数组（无真实凭证；满足写入器域完整性/认证完整性守卫；含关键认证 Cookie）。 */
function fakeCookies(n = 3) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      name: i === 0 ? 'sessionid' : `ck_${i}`, value: `FAKE_D52_VALUE_${i}`,
      domain: i === 0 ? '.fxg.jinritemai.com' : '.jinritemai.com',
      path: '/', expires: Math.floor(Date.now() / 1000) + 86400,
      httpOnly: true, secure: true, sameSite: 'Lax',
    });
  }
  return out;
}

/** 页面 evaluate 统一分发（真实探针按函数名识别，匿名页内函数按源码特征识别）。 */
function dispatchPageEvaluate(fn, state) {
  const name = fn && fn.name ? String(fn.name) : '';
  const src = String(fn);
  if (name === 'probeDoudianHomepageReadyInPage') return true;
  if (name === 'probeQianchuanHeaderIdentityInPage') {
    return {
      accountId: state.headerAccountId,
      accountName: state.headerAccountId ? '测试账户名' : null,
      candidates: state.headerAccountId ? 1 : 0,
      unique: Boolean(state.headerAccountId),
      loginVisible: state.headerLoginVisible === true,
    };
  }
  if (name === 'probeDoudianShopIdentityInPage') {
    return { name: state.shopName, distinct: [state.shopName], candidates: 1, unique: true, loginVisible: false };
  }
  if (name === 'readChengfangAccountInPage') {
    return { url: state.chengfangUrl, hasSubTabs: state.hasSubTabs !== false };
  }
  if (name === 'handleChengfangOverlayInPage') return { trusted: true, state: 'none' };
  if (name === 'readChengfangFirstUseInPage') return false;
  if (name === 'navigateChengfangPlanViewInPage' || /navigatormenu_overall/.test(src)) return null;
  if (/切至账户视图/.test(src)) {
    return { href: state.url, shopView: false, switchPresent: false, accountContent: true, popup: { present: false, safe: false } };
  }
  if (/扫码登录/.test(src)) return { loginForm: false, loginControl: false, loginDialog: false };
  return null;
}

/**
 * fake 店铺浏览器（openQianchuanHome 第一次 launch 的业务浏览器）：
 * 抖店首页收敛 → 点"巨量千川"入口 → 千川 /home → 乘方导航/浮窗探针全部按状态应答；
 * ctx.cookies() 返回"会话内刷新"的 owned 集合（默认 4 条，与来源文件 3 条区分）。
 */
function makeFakeShopBrowser(opts = {}) {
  const state = {
    url: FXG_HOME,
    headerAccountId: opts.headerAccountId !== undefined ? opts.headerAccountId : ACCOUNT,
    headerLoginVisible: opts.headerLoginVisible === true,
    shopName: opts.shopName || SHOP_NAME,
    chengfangUrl: opts.chengfangUrl !== undefined ? opts.chengfangUrl : QC_OVERALL,
    hasSubTabs: opts.hasSubTabs !== false,
    cookies: typeof opts.cookies === 'function' ? opts.cookies : (() => fakeCookies(4)),
  };
  const counts = { closes: 0, entryClicks: 0 };
  const page = {
    goto: async () => {},
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    waitForFunction: async () => null,
    waitForEvent: async () => null,
    url: () => state.url,
    isClosed: () => false,
    context: () => ctx,
    locator: () => ({ count: async () => 0 }),
    getByText: () => ({
      count: async () => 1,
      nth: () => ({
        evaluate: async () => 'https://fxg.jinritemai.com/qianchuan-entry',
        click: async () => { counts.entryClicks += 1; state.url = QC_HOME; },
      }),
      click: async () => { counts.entryClicks += 1; state.url = QC_HOME; },
    }),
    evaluate: async (fn) => dispatchPageEvaluate(fn, state),
  };
  const ctx = {
    addCookies: async () => {},
    newPage: async () => page,
    cookies: async () => state.cookies(),
    close: async () => {},
  };
  const browser = {
    page, ctx, counts, state, closed: false,
    newContext: async () => ctx,
    isConnected: () => browser.closed !== true,
    close: async () => { counts.closes += 1; browser.closed = true; },
  };
  return browser;
}

/**
 * fake 候选专用独立浏览器（真实合同：全新实例 + 新上下文只注入候选字节 + 受信 FXG
 * 首页 + 唯一本店语义身份应答；close 后 isConnected()=false 供关闭证明）。
 */
function makeFakeCandidateBrowser(shopName) {
  const counts = { closes: 0 };
  let injected = [];
  const page = {
    goto: async () => {},
    waitForTimeout: async () => {},
    url: () => FXG_HOME,
    isClosed: () => false,
    evaluate: async (fn) => dispatchPageEvaluate(fn, {
      url: FXG_HOME, shopName,
      headerAccountId: null, headerLoginVisible: false,
    }),
  };
  const ctx = {
    addCookies: async (cs) => { injected = Array.isArray(cs) ? cs.slice() : []; },
    newPage: async () => page,
    cookies: async () => injected.slice(),
    close: async () => {},
  };
  const browser = {
    counts, ctx, closed: false,
    newContext: async () => ctx,
    isConnected: () => browser.closed !== true,
    close: async () => { counts.closes += 1; browser.closed = true; },
  };
  return browser;
}

/** 每次打开独立的注入工厂：第 1 个实例=业务店铺浏览器，其后每个实例=全新候选浏览器。 */
function makePerOpenFactory() {
  const made = [];
  const factory = async () => {
    const b = made.length === 0
      ? makeFakeShopBrowser()
      : makeFakeCandidateBrowser(SHOP_NAME);
    made.push(b);
    return b;
  };
  return { factory, made };
}

/** sessionCheckpoint 透传 spy：记录检查点实收参数，并原样调用真实检查点（绝不 stub 结果）。 */
function makeCheckpointSpy() {
  const calls = [];
  const spy = async (args) => {
    calls.push(args);
    return checkpointQianchuanSessionCookies(args);
  };
  return { spy, calls };
}

/** 乘方打开入参（临时隔离根；readOnlyStatus 不开启，走常规打开链）。 */
function chengfangOpenArgs({ srcDir, workDir, factory, spy, shopId, cookieFile }) {
  return {
    loginCfg: { cookieSourceDir: srcDir, cookieWorkDir: workDir, edgePath: 'edge' },
    shopCfg: {
      id: shopId, cookieFile,
      name: SHOP_NAME, compassShopName: SHOP_NAME, accountId: ACCOUNT,
    },
    audit: () => {},
    browserFactory: factory,
    sessionCheckpoint: spy,
  };
}

/** 直测检查点用的最小会话桩（页面绑定本 context；ctx.cookies 可注入漂移行为）。 */
function makeDirectSessionStub(opts = {}) {
  const state = {
    url: opts.url || QC_HOME,
    headerAccountId: opts.headerAccountId !== undefined ? opts.headerAccountId : ACCOUNT,
    headerLoginVisible: opts.headerLoginVisible === true,
    bound: opts.bound !== false,
  };
  const foreignCtx = { cookies: async () => [] };
  const ctx = {
    cookies: typeof opts.cookies === 'function' ? opts.cookies : (async () => fakeCookies(4)),
  };
  const page = {
    url: () => state.url,
    isClosed: () => false,
    context: () => (state.bound ? ctx : foreignCtx),
    evaluate: async (fn) => dispatchPageEvaluate(fn, {
      url: state.url,
      headerAccountId: state.headerAccountId,
      headerLoginVisible: state.headerLoginVisible,
      shopName: SHOP_NAME,
    }),
  };
  return { page, ctx, state };
}

/** 直测检查点用的合格候选工厂（每次全新候选浏览器，绝不复用）。 */
function makeGoodCandidateFactory() {
  const made = [];
  const factory = async () => {
    const b = makeFakeCandidateBrowser(SHOP_NAME);
    made.push(b);
    return b;
  };
  return { factory, made };
}

// ── 集成：真实 openQianchuanHome → openChengfangShop → 真实检查点 ────────────

test('D52 接线：乘方 manager-ready 检查点经本次可信 open 的候选专用工厂真实保存并推进指纹；业务浏览器零关闭、候选恰好一个且自证关闭；能力不进 JSON', async () => {
  const srcDir = newTempRoot('ok-src');
  const workDir = newTempRoot('ok-work');
  fs.writeFileSync(path.join(srcDir, '简尚店.json'), JSON.stringify(fakeCookies(3), null, 2));
  const workPath = path.join(workDir, '简尚店.json');
  const { factory, made } = makePerOpenFactory();
  const { spy, calls } = makeCheckpointSpy();

  const r = await openChengfangShop(chengfangOpenArgs({
    srcDir, workDir, factory, spy, shopId: 'shop-d52-ok', cookieFile: '简尚店',
  }));

  // 业务结果不被 Cookie 保存掩盖：乘方打开成功返回
  assert.ok(r && r.target && r.context && r.cookieSession, '乘方打开成功返回完整会话');
  // manager-ready 检查点实收参数：候选专用工厂 + 禁止列表（含主业务浏览器）
  assert.strictEqual(calls.length, 1, 'manager-ready 恰好一次检查点调用');
  const managerCall = calls[0];
  assert.strictEqual(typeof managerCall.candidateBrowserFactory, 'function', '收到候选专用浏览器工厂');
  assert.ok(Array.isArray(managerCall.forbiddenBrowsers), '收到禁止列表');
  assert.ok(managerCall.forbiddenBrowsers.includes(r.browser), '主业务浏览器在禁止返回实例内');

  // 真实保存（真实检查点 + 真实写入器，非 saved:true stub）
  assert.strictEqual(r.cookieCheckpoint.saved, true, '检查点真实保存');
  assert.strictEqual(r.cookieCheckpoint.fingerprintAdvanced, true, '会话起始指纹推进');
  const onDisk = JSON.parse(fs.readFileSync(workPath, 'utf-8'));
  assert.strictEqual(onDisk.length, 4, '工作副本落盘为刷新后的 owned 集合');
  assert.deepStrictEqual(r.cookieSession.startFingerprint, fingerprintFile(workPath), '指纹=工作副本落盘指纹');

  // 能力为非枚举临时引用：不进 JSON 序列化、不在枚举键中
  assert.strictEqual(
    Object.prototype.propertyIsEnumerable.call(r.cookieSession, 'candidateVerifyCapability'),
    false, 'candidateVerifyCapability 非枚举',
  );
  const flat = JSON.stringify(r.cookieSession);
  assert.ok(!flat.includes('candidateVerifyCapability'), 'JSON 序列化不含能力键名');
  assert.ok(!flat.includes('candidateBrowserFactory'), 'JSON 序列化不含工厂键名');

  // 资源收口：业务浏览器零关闭；候选验证恰好经一个全新候选浏览器且自证关闭一次
  assert.strictEqual(made.length, 2, '业务浏览器 1 个 + 候选验证浏览器 1 个');
  assert.strictEqual(made[0].counts.closes, 0, '成功路径不关业务浏览器');
  assert.strictEqual(made[1].counts.closes, 1, '候选浏览器用毕自证关闭恰好一次');
  assert.strictEqual(made[1].closed, true);
  assert.strictEqual(made[1].isConnected(), false);
});

test('D52 接线：乘方错误路径检查点同样接上工厂；原始错误原样抛出；关闭收口只关自有候选、业务浏览器照常关闭', async () => {
  const srcDir = newTempRoot('err-src');
  const workDir = newTempRoot('err-work');
  fs.writeFileSync(path.join(srcDir, '简尚店.json'), JSON.stringify(fakeCookies(3), null, 2));
  const { factory, made } = makePerOpenFactory();
  // 乘方导航始终不落乘方管理页 → 导航事实错误（非缺失控件，不触发人工保留窗口）
  const rawFactory = factory;
  const failingFactory = async () => {
    const b = await rawFactory();
    if (b.state && b.state.chengfangUrl !== undefined) b.state.chengfangUrl = `${QC_HOME}&stuck=1`;
    return b;
  };
  const { spy, calls } = makeCheckpointSpy();

  await assert.rejects(
    () => openChengfangShop(chengfangOpenArgs({
      srcDir, workDir, factory: failingFactory, spy, shopId: 'shop-d52-err', cookieFile: '简尚店',
    })),
    /导航"乘方"未到达管理页/, '原始导航错误原样抛出，不被 Cookie 保存掩盖/改写',
  );

  // calls[0]=错误收尾检查点（closeBrowser 前），calls[1]=closeBrowser 登记的关闭前收尾
  assert.ok(calls.length >= 1, '错误路径至少一次检查点调用');
  for (const c of calls) {
    assert.strictEqual(typeof c.candidateBrowserFactory, 'function', '错误路径检查点同样收到候选专用工厂');
    assert.ok(Array.isArray(c.forbiddenBrowsers) && c.forbiddenBrowsers.length >= 1, '错误路径检查点收到禁止列表');
  }
  // 资源收口：业务浏览器恰好关闭一次；全部候选浏览器自证关闭恰好一次
  assert.strictEqual(made[0].counts.closes, 1, '业务浏览器经 closeBrowser 照常关闭恰好一次');
  const candidates = made.slice(1);
  assert.ok(candidates.length >= 1, '错误路径检查点确经候选专用工厂验证');
  for (const b of candidates) {
    assert.strictEqual(b.counts.closes, 1, '候选浏览器恰好关闭一次');
    assert.strictEqual(b.closed, true);
  }
});

test('D52 隔离：能力不跨店/跨 open 串用——两次独立打开各得各自工厂与禁止列表，互不相同', async () => {
  const mkShop = async (tag, shopId, cookieFile) => {
    const srcDir = newTempRoot(`${tag}-src`);
    const workDir = newTempRoot(`${tag}-work`);
    fs.writeFileSync(path.join(srcDir, `${cookieFile}.json`), JSON.stringify(fakeCookies(3), null, 2));
    const { factory, made } = makePerOpenFactory();
    const { spy, calls } = makeCheckpointSpy();
    const r = await openChengfangShop(chengfangOpenArgs({
      srcDir, workDir, factory, spy, shopId, cookieFile,
    }));
    assert.strictEqual(r.cookieCheckpoint.saved, true, `${shopId} 检查点真实保存`);
    return { r, calls, made };
  };
  const a = await mkShop('iso-a', 'shop-d52-a', '店铺甲');
  const b = await mkShop('iso-b', 'shop-d52-b', '店铺乙');

  const capA = a.r.cookieSession.candidateVerifyCapability;
  const capB = b.r.cookieSession.candidateVerifyCapability;
  assert.ok(capA && capB, '两次打开各自附着能力');
  assert.notStrictEqual(capA, capB, '能力对象互不相同');
  assert.notStrictEqual(capA.candidateBrowserFactory, capB.candidateBrowserFactory, '工厂不跨 open 串用');
  assert.strictEqual(typeof a.calls[0].candidateBrowserFactory, 'function');
  assert.strictEqual(a.calls[0].candidateBrowserFactory, capA.candidateBrowserFactory, '检查点收到的就是本次 open 的工厂');
  assert.ok(b.calls[0].forbiddenBrowsers.includes(b.r.browser), '禁止列表是本店业务浏览器');
  assert.ok(!b.calls[0].forbiddenBrowsers.includes(a.r.browser), '不把别家 open 的浏览器混入禁止列表以外的新会话');
  const flatB = JSON.stringify(b.r.cookieSession);
  assert.ok(!flatB.includes('candidateVerifyCapability') && !flatB.includes('candidateBrowserFactory'), 'JSON 序列化零能力泄漏');
});

// ── 直测真实检查点：保护语义在"按 D52 方式传入工厂"时原样保留 ────────────────

function directFixture(tag) {
  const dir = newTempRoot(tag);
  const filePath = path.join(dir, '直测店.json');
  fs.writeFileSync(filePath, JSON.stringify(fakeCookies(3), null, 2));
  const cookieSession = { filePath, startFingerprint: fingerprintFile(filePath) };
  const shopCfg = { id: 'shop-direct', name: SHOP_NAME, compassShopName: SHOP_NAME, accountId: ACCOUNT };
  return { cookieSession, shopCfg, bytesBefore: fs.readFileSync(filePath) };
}

test('缺候选专用浏览器工厂（D52 之前的乘方接线状态）：检查点 fail-closed 拒绝写入（复现线上 11 次同形失败），文件字节不变', async () => {
  const fx = directFixture('nofactory');
  const stub = makeDirectSessionStub();
  const r = await checkpointQianchuanSessionCookies({
    context: stub.ctx, cookieSession: fx.cookieSession, target: stub.page, shopCfg: fx.shopCfg,
  });
  assert.strictEqual(r.saved, false, '缺工厂 → 拒绝（缺依赖，不是 Cookie 过期证明）');
  assert.match(r.reason, /未提供候选专用浏览器工厂/);
  assert.deepStrictEqual(fs.readFileSync(fx.cookieSession.filePath), fx.bytesBefore, '零写入，文件字节不变');
});

test('候选工厂返回主业务浏览器：拒绝且绝不关闭业务浏览器（D5G 保护经 D52 接线原样保留）', async () => {
  const fx = directFixture('forbidden');
  const stub = makeDirectSessionStub();
  const business = {
    closeCount: 0, closed: false,
    newContext: async () => ({ addCookies: async () => {}, newPage: async () => ({}), cookies: async () => [] }),
    isConnected: () => business.closed !== true,
    close: async () => { business.closeCount += 1; business.closed = true; },
  };
  const r = await checkpointQianchuanSessionCookies({
    context: stub.ctx, cookieSession: fx.cookieSession, target: stub.page, shopCfg: fx.shopCfg,
    candidateBrowserFactory: async () => business,
    forbiddenBrowsers: [business],
  });
  assert.strictEqual(r.saved, false, '借用主业务浏览器 → fail-closed 拒绝');
  assert.match(r.reason, /重复|共享|外部|主业务/);
  assert.strictEqual(business.closeCount, 0, '绝不关闭非本轮新启的业务浏览器');
  assert.deepStrictEqual(fs.readFileSync(fx.cookieSession.filePath), fx.bytesBefore, '零写入，文件字节不变');
});

test('正确同店 + 显式候选工厂：真实检查点保存并推进指纹；候选浏览器自证关闭恰好一次', async () => {
  const fx = directFixture('goodsave');
  const stub = makeDirectSessionStub();
  const { factory, made } = makeGoodCandidateFactory();
  const r = await checkpointQianchuanSessionCookies({
    context: stub.ctx, cookieSession: fx.cookieSession, target: stub.page, shopCfg: fx.shopCfg,
    candidateBrowserFactory: factory,
    forbiddenBrowsers: [],
  });
  assert.strictEqual(r.saved, true, '同店正证据 + 独立候选验证通过 → 保存');
  assert.strictEqual(r.fingerprintAdvanced, true, '指纹推进');
  assert.strictEqual(JSON.parse(fs.readFileSync(fx.cookieSession.filePath, 'utf-8')).length, 4, '落盘为刷新集合');
  assert.strictEqual(made.length, 1, '恰好一个候选浏览器');
  assert.strictEqual(made[0].counts.closes, 1, '候选自证关闭恰好一次');
});

test('foreign 身份：候选工厂在场仍拒绝写入（身份守卫原样保留），文件字节不变', async () => {
  const fx = directFixture('foreign');
  const stub = makeDirectSessionStub({ headerAccountId: '999999999999999999' });
  const { factory } = makeGoodCandidateFactory();
  const r = await checkpointQianchuanSessionCookies({
    context: stub.ctx, cookieSession: fx.cookieSession, target: stub.page, shopCfg: fx.shopCfg,
    candidateBrowserFactory: factory,
    forbiddenBrowsers: [],
  });
  assert.strictEqual(r.saved, false, 'foreign 账户 → 拒绝');
  assert.match(r.reason, /不一致|foreign/);
  assert.deepStrictEqual(fs.readFileSync(fx.cookieSession.filePath), fx.bytesBefore, '零写入');
});

test('同地址可见登录控件：候选工厂在场仍拒绝写入（登录负证据原样保留），文件字节不变', async () => {
  const fx = directFixture('loginvis');
  const stub = makeDirectSessionStub({ headerLoginVisible: true });
  const { factory } = makeGoodCandidateFactory();
  const r = await checkpointQianchuanSessionCookies({
    context: stub.ctx, cookieSession: fx.cookieSession, target: stub.page, shopCfg: fx.shopCfg,
    candidateBrowserFactory: factory,
    forbiddenBrowsers: [],
  });
  assert.strictEqual(r.saved, false, '可见登录表单 → 拒绝');
  assert.match(r.reason, /可见登录表单/);
  assert.deepStrictEqual(fs.readFileSync(fx.cookieSession.filePath), fx.bytesBefore, '零写入');
});

test('Cookie 取回期间源 context 漂移到登录页：取回后复验拒绝，零写入', async () => {
  const fx = directFixture('ctxdrift');
  const stub = makeDirectSessionStub({
    cookies: async () => { stub.state.url = QC_LOGIN; return fakeCookies(4); },
  });
  const { factory } = makeGoodCandidateFactory();
  const r = await checkpointQianchuanSessionCookies({
    context: stub.ctx, cookieSession: fx.cookieSession, target: stub.page, shopCfg: fx.shopCfg,
    candidateBrowserFactory: factory,
    forbiddenBrowsers: [],
  });
  assert.strictEqual(r.saved, false, '源页面漂移 → 复验拒绝');
  assert.match(r.reason, /复验拒绝|复验失败|登录/);
  assert.deepStrictEqual(fs.readFileSync(fx.cookieSession.filePath), fx.bytesBefore, '零写入');
});

test('目标文件 CAS 漂移（会话期间被并发写入）：冲突保护保留较新文件，零写入', async () => {
  const fx = directFixture('casdrift');
  const stub = makeDirectSessionStub();
  const { factory } = makeGoodCandidateFactory();
  // 会话开始后、检查点前，另一写入者更新文件（较新登录）
  const newer = fakeCookies(6);
  fs.writeFileSync(fx.cookieSession.filePath, JSON.stringify(newer, null, 2));
  const r = await checkpointQianchuanSessionCookies({
    context: stub.ctx, cookieSession: fx.cookieSession, target: stub.page, shopCfg: fx.shopCfg,
    candidateBrowserFactory: factory,
    forbiddenBrowsers: [],
  });
  assert.strictEqual(r.saved, false, '指纹冲突 → 不回写');
  assert.match(r.reason, /已被改变|保留较新文件/);
  assert.strictEqual(JSON.parse(fs.readFileSync(fx.cookieSession.filePath, 'utf-8')).length, 6, '较新文件原样保留');
});

test('会话绑定漂移（页面 context() 与本次会话不全等）：入口即拒绝，零 Cookie 读取、零写入', async () => {
  const fx = directFixture('binding');
  const stub = makeDirectSessionStub({ bound: false });
  const { factory, made } = makeGoodCandidateFactory();
  const r = await checkpointQianchuanSessionCookies({
    context: stub.ctx, cookieSession: fx.cookieSession, target: stub.page, shopCfg: fx.shopCfg,
    candidateBrowserFactory: factory,
    forbiddenBrowsers: [],
  });
  assert.strictEqual(r.saved, false, 'foreign 页 → 拒绝');
  assert.match(r.reason, /不属于本次上下文|已关闭/);
  assert.strictEqual(made.length, 0, '未进入写前验证：零候选浏览器启动');
  assert.deepStrictEqual(fs.readFileSync(fx.cookieSession.filePath), fx.bytesBefore, '零写入');
});
