'use strict';

/**
 * R58/R59 会话 Cookie 检查点测试（隔离环境：stub 页面/context + OS 临时文件；无真实
 * Cookie 值、无网络、无浏览器、无广告动作；不依赖 jsdom）。覆盖：
 *  1. 已验证千川入口保存：入口核验后、后续导航前，刷新的 owned Cookie 落盘，
 *     会话起始指纹推进；随后（发布器）用推进后指纹回写不再被自身冲突保护误伤。
 *  2. 失败时当前是登录页/foreign 账户 → 跳过保存，原始错误原样抛出，文件字节不变。
 *  3. 配置缺 accountId（未知账户）→ 跳过，不要求新增配置。
 *  4. await context.cookies() 异步空隙期间新登录改写文件 → 写入器冲突保护跳过，保留较新文件。
 *  5. 写入后落盘又被其他进程改写（真实在飞 audit 回调注入）→ 不采用新指纹，原指纹继续冲突保护。
 *  6. 检查点链路零广告动作（无广告开关/批量按钮点击）。
 *  7. R59 回归：严格 origin（:443 允许、:444 拒绝）；单一 cookies 读取 + 取回后
 *     URL/账户复验（TOCTOU）；探针期间导航；同地址可见登录表单负证据；隐藏/rect 抛错
 *     头部 fail-closed；行内 "店铺名 ID：" 账户名解析；恰好一次 cookies 调用。
 * S99：真实链路用例改为在独立工作根（login.cookieWorkDir）上断言刷新，来源只读不变；
 *     失败/拒绝路径仍要求「来源与工作副本均字节不变」。
 * 运行：npm test（本 Worker 阶段未执行命令，由主脑验收时统一运行）。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  isVerifiedQianchuanUrl,
  probeQianchuanHeaderIdentityInPage,
  decideQianchuanCheckpoint,
  checkpointQianchuanSessionCookies,
} = require('../src/login/session-cookie-checkpoint');
const { fingerprintFile, writebackSessionCookies } = require('../src/login/cookie-writeback');
const { openQianchuanHome } = require('../src/adapters/qianchuan-reader');

const ACCOUNT = '1710242295996424';
const QC_HOME = `https://qianchuan.jinritemai.com/home?aavid=${ACCOUNT}`;
const QC_OVERALL = `https://qianchuan.jinritemai.com/overall-prom?aavid=${ACCOUNT}`;
const QC_LOGIN = 'https://qianchuan.jinritemai.com/login/common';
const FXG_HOME = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const FXG_LOGIN = 'https://fxg.jinritemai.com/login/common';

let dir = null;
const workRoots = [];
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-checkpoint-test-'));
});
after(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  for (const w of workRoots) { try { fs.rmSync(w, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
});

/**
 * S99 迁移：真实入口（openQianchuanHome → resolveCookieFile）把 cookieSourceDir 当
 * **只读上游**，会话回写只落在本项目独立工作副本上。每个真实链路用例使用自己的临时
 * 工作根（login.cookieWorkDir），假 Cookie 绝不落到真实生产根，也不与其它测试进程共享
 * 同名文件；断言改为「工作副本被刷新 + 来源字节/mtime 不变」。helper 直测用例（显式
 * 传 cookieSession.filePath）语义不变，仍直接对目标文件断言。
 */
function newWorkDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `session-checkpoint-work-${tag}-`));
  workRoots.push(d);
  return d;
}
function workFilePath(workDir, name = '测试店铺') { return path.join(workDir, `${name}.json`); }

/** 假 Cookie 数组（无真实凭证；满足写入器域完整性/数量守卫）。 */
function fakeCookies(n = 3) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      name: `ck_${i}`, value: `FAKE_VALUE_NOT_REAL_${i}`,
      domain: i === 0 ? '.fxg.jinritemai.com' : '.jinritemai.com',
      path: '/', expires: Math.floor(Date.now() / 1000) + 86400,
      httpOnly: true, secure: true, sameSite: 'Lax',
    });
  }
  return out;
}

function cookieFilePath() { return path.join(dir, '测试店铺.json'); }

function writeCookieFile(cookies) {
  fs.writeFileSync(cookieFilePath(), JSON.stringify(cookies, null, 2));
  return fingerprintFile(cookieFilePath());
}

// ── 纯函数：严格 URL 与身份判定 ────────────────────────────────────

test('严格可信来源：子串伪造域/登录页/未支持路径/非默认端口一律不算；受支持管理路径与显式 443 通过', () => {
  assert.strictEqual(isVerifiedQianchuanUrl(QC_HOME), true);
  assert.strictEqual(isVerifiedQianchuanUrl(QC_OVERALL), true);
  assert.strictEqual(isVerifiedQianchuanUrl('https://qianchuan.jinritemai.com/uni-prom/detail?adId=1'), true);
  assert.strictEqual(isVerifiedQianchuanUrl('https://qianchuan.jinritemai.com:443/home'), true, '显式默认端口 443 允许（origin 规范化）');
  assert.strictEqual(isVerifiedQianchuanUrl('https://qianchuan.jinritemai.com:444/home'), false, '非默认端口拒绝（R59 实测漏洞）');
  assert.strictEqual(isVerifiedQianchuanUrl('https://qianchuan.jinritemai.com.evil.test/home'), false, '同后缀伪造域拒绝');
  assert.strictEqual(isVerifiedQianchuanUrl('https://qianchuan.jinritemai.com/login/common'), false, '登录中转页拒绝');
  assert.strictEqual(isVerifiedQianchuanUrl('https://qianchuan.jinritemai.com/unknown/path'), false, '未支持路径拒绝');
  assert.strictEqual(isVerifiedQianchuanUrl('https://fxg.jinritemai.com/ffa/mshop/homepage/index'), false, '抖店域不是千川检查点');
});

test('判定：未知账户跳过；身份缺失/不唯一/不一致跳过；当前登录页绝不放行（更早身份通过也不算）', () => {
  const obs = { accountId: ACCOUNT, unique: true };
  assert.match(
    decideQianchuanCheckpoint({ url: QC_HOME, expectedAccountId: null, observed: obs }).reason,
    /配置未提供千川账户ID/
  );
  assert.strictEqual(decideQianchuanCheckpoint({ url: QC_HOME, expectedAccountId: ACCOUNT, observed: { accountId: null, unique: false } }).ok, false);
  assert.strictEqual(decideQianchuanCheckpoint({ url: QC_HOME, expectedAccountId: ACCOUNT, observed: { accountId: '999999999999999999', unique: true } }).ok, false, 'foreign 账户拒绝');
  assert.strictEqual(decideQianchuanCheckpoint({ url: QC_LOGIN, expectedAccountId: ACCOUNT, observed: obs }).ok, false);
  assert.strictEqual(decideQianchuanCheckpoint({ url: QC_HOME, expectedAccountId: ACCOUNT, observed: obs }).ok, true);
  assert.match(
    decideQianchuanCheckpoint({
      url: QC_HOME, expectedAccountId: ACCOUNT,
      observed: { accountId: ACCOUNT, unique: true, loginVisible: true },
    }).reason,
    /可见登录表单/,
    '同地址可见登录控件：即使头部身份匹配也不放行'
  );
});

// ── 头部身份探针：DOM fixture（最小离线 DOM 桩，与真实 evaluate 同一函数对象）──

/**
 * 安装最小 DOM 桩。queryAll(sel) 返回该选择器的元素数组；cs 为 computed style 应答。
 * 仅 shop-name 头部元素可简化传入数组（兼容旧用例形状）。
 */
function withFakeDom(queryAllOrEls, fn, cs) {
  const savedDoc = global.document;
  const savedGcs = global.getComputedStyle;
  const queryAll = Array.isArray(queryAllOrEls)
    ? (sel) => (sel === '[class*="shop-name"]' ? queryAllOrEls.slice() : [])
    : queryAllOrEls;
  global.document = { querySelectorAll: queryAll };
  global.getComputedStyle = cs ? () => cs : () => ({ display: 'block', visibility: 'visible' });
  try { fn(); } finally {
    global.document = savedDoc;
    global.getComputedStyle = savedGcs;
  }
}

function headerEl(text) {
  return {
    textContent: text,
    getBoundingClientRect: () => ({ width: 120, height: 20 }),
  };
}

test('头部身份探针：唯一可见头部命中（行内 "店铺名 ID：" 正确解析账户名）；隐藏/多候选拒绝（strict，不做正文兜底）', () => {
  withFakeDom([headerEl('伊人美 ID：1710242295996424')], () => {
    const r = probeQianchuanHeaderIdentityInPage();
    assert.strictEqual(r.unique, true);
    assert.strictEqual(r.accountId, ACCOUNT);
    assert.strictEqual(r.accountName, '伊人美', '行内头部文本账户名正确解析（R58 缺陷：此前为 null）');
  });
  withFakeDom([
    headerEl('甲 ID：111111111111111111'),
    headerEl('乙 ID：222222222222222222'),
  ], () => {
    const r = probeQianchuanHeaderIdentityInPage();
    assert.strictEqual(r.unique, false, '多候选拒绝');
    assert.strictEqual(r.accountId, null);
  });
  const hidden = { textContent: '伊人美 ID：1710242295996424', getBoundingClientRect: () => ({ width: 0, height: 0 }) };
  withFakeDom([hidden], () => {
    const r = probeQianchuanHeaderIdentityInPage();
    assert.strictEqual(r.unique, false, '不可见头部不算当前身份');
  });
  withFakeDom([], () => {
    const r = probeQianchuanHeaderIdentityInPage();
    assert.strictEqual(r.unique, false, '无头部身份：跳过，绝不正文兜底');
  });
});

test('可见性 fail-closed：computed style 隐藏与 getBoundingClientRect 抛错都不算可见（绝无 catch=>true）', () => {
  withFakeDom([headerEl('伊人美 ID：1710242295996424')], () => {
    const r = probeQianchuanHeaderIdentityInPage();
    assert.strictEqual(r.unique, true, '前置：默认可见桩通过');
  });
  withFakeDom([headerEl('伊人美 ID：1710242295996424')], () => {
    const r = probeQianchuanHeaderIdentityInPage();
    assert.strictEqual(r.unique, false, 'display:none 的头部不算当前身份');
  }, { display: 'none', visibility: 'visible' });
  withFakeDom([headerEl('伊人美 ID：1710242295996424')], () => {
    const r = probeQianchuanHeaderIdentityInPage();
    assert.strictEqual(r.unique, false, 'visibility:hidden 的头部不算当前身份');
  }, { display: 'block', visibility: 'hidden' });
  const throwing = {
    textContent: '伊人美 ID：1710242295996424',
    getBoundingClientRect: () => { throw new Error('detached node'); },
  };
  withFakeDom([throwing], () => {
    const r = probeQianchuanHeaderIdentityInPage();
    assert.strictEqual(r.unique, false, 'rect 抛错 → fail-closed 视为不可见');
  });
});

test('登录负证据：同地址可见登录输入框 → loginVisible=true（头部身份即便匹配也构成显式负证据）', () => {
  const loginInput = {
    tagName: 'INPUT',
    getBoundingClientRect: () => ({ width: 200, height: 30 }),
  };
  withFakeDom((sel) => {
    if (sel === '[class*="shop-name"]') return [headerEl('伊人美 ID：1710242295996424')];
    if (sel.startsWith('input')) return [loginInput];
    return [];
  }, () => {
    const r = probeQianchuanHeaderIdentityInPage();
    assert.strictEqual(r.unique, true, '头部身份本身仍被解析');
    assert.strictEqual(r.loginVisible, true, '可见登录输入框 → 显式登录负证据');
  });
});

// ── stub 页面（沿用 qianchuan-reader.test.js 形状 + cookies 能力与身份应答）──

function makeStubPage({
  url = QC_HOME,
  urlQueue = null,
  cookies,
  accountId = ACCOUNT,
  entryCount = 1,
  probe = null,
} = {}) {
  const calls = { gotos: [], closes: 0, clicks: 0, cookieReads: 0 };
  const state = { url, accountId, probe };
  let urlIdx = 0;
  const nextUrl = () => (urlQueue ? urlQueue[Math.min(urlIdx++, urlQueue.length - 1)] : state.url);
  const cookiesFn = typeof cookies === 'function' ? cookies : async () => cookies;
  const page = {
    __calls: calls,
    goto: async (u) => { calls.gotos.push(u); return null; },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    waitForFunction: async () => null,
    waitForURL: async () => null,
    url: () => nextUrl(),
    evaluate: async (fn) => {
      const src = String(fn);
      if (/shop-name/.test(src)) {
        if (state.probe) return state.probe();
        return {
          accountId: state.accountId,
          accountName: state.accountId ? '伊人美' : null,
          candidates: state.accountId ? 1 : 0,
          unique: Boolean(state.accountId),
          loginVisible: false,
        };
      }
      return null;
    },
    getByText: () => ({
      first() { return this; },
      nth() { return this; },
      count: async () => entryCount,
      click: async () => { calls.clicks += 1; },
      waitFor: async () => {},
      evaluate: async () => '',
      isVisible: async () => false,
    }),
    locator: () => ({
      nth() { return this; }, first() { return this; },
      waitFor: async () => {}, click: async () => { calls.clicks += 1; }, textContent: async () => '',
    }),
  };
  const context = {
    addCookies: async () => {},
    newPage: async () => page,
    waitForEvent: async () => null,
    on() {}, off() {},
    cookies: async () => { calls.cookieReads += 1; return cookiesFn(); },
  };
  const browser = {
    newContext: async () => context,
    close: async () => { calls.closes += 1; },
  };
  const api = {
    page, context, browser, calls,
    setUrl: (u) => { state.url = u; },
    setAccountId: (a) => { state.accountId = a; },
    setProbe: (fn) => { state.probe = fn; },
  };
  return api;
}

// ── 检查点主链路（真实 openQianchuanHome 生命周期 + helper 直测）────

test('已验证入口保存：owned 刷新 Cookie 在后续导航前落盘（独立工作副本），来源只读不变；起始指纹推进，发布器同指纹回写不再被自身冲突保护误伤', async () => {
  const workDir = newWorkDir('entry-save');
  writeCookieFile(fakeCookies(3));
  const srcBefore = fingerprintFile(cookieFilePath());
  const refreshed = fakeCookies(4); // 会话内刷新：多一条
  const stub = makeStubPage({ cookies: refreshed, urlQueue: [FXG_HOME, FXG_HOME, QC_HOME] });
  const r = await openQianchuanHome(
    { cookieSourceDir: dir, cookieWorkDir: workDir, edgePath: 'edge' },
    { cookieFile: '测试店铺', accountId: ACCOUNT },
    { browserFactory: async () => stub.browser }
  );
  assert.strictEqual(r.cookieSession.filePath, workFilePath(workDir), '本次实际加载路径=本项目独立工作副本（非共享上游）');
  assert.strictEqual(r.cookieCheckpoint.saved, true, '入口检查点保存成功');
  assert.strictEqual(r.cookieCheckpoint.fingerprintAdvanced, true, '指纹推进');
  const onDisk = JSON.parse(fs.readFileSync(r.cookieSession.filePath, 'utf-8'));
  assert.strictEqual(onDisk.length, 4, '工作副本落盘为刷新后的 owned 集合');
  assert.deepStrictEqual(r.cookieSession.startFingerprint, fingerprintFile(r.cookieSession.filePath), '会话起始指纹=工作副本落盘指纹');
  assert.deepStrictEqual(fingerprintFile(cookieFilePath()), srcBefore, '只读上游来源字节与 mtime 全程不变');
  const later = await writebackSessionCookies({
    context: stub.context, cookieFilePath: r.cookieSession.filePath,
    sessionStartFingerprint: r.cookieSession.startFingerprint,
    identityOk: true, loginOk: true,
  });
  assert.strictEqual(later.ok, true, '自有写入推进指纹后，同会话后续回写不再冲突');
  assert.deepStrictEqual(fingerprintFile(cookieFilePath()), srcBefore, '后续回写也只碰工作副本，来源仍未变');
});

test('失败且当前停在登录中转页：跳过保存，原始错误如实抛出，Cookie 文件字节不变', async () => {
  const workDir = newWorkDir('login-fail');
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const srcBefore = fingerprintFile(cookieFilePath());
  const stub = makeStubPage({ cookies: fakeCookies(4), urlQueue: [FXG_LOGIN] });
  await assert.rejects(
    () => openQianchuanHome(
      { cookieSourceDir: dir, cookieWorkDir: workDir, edgePath: 'edge' },
      { cookieFile: '测试店铺', accountId: ACCOUNT },
      { browserFactory: async () => stub.browser }
    ),
    /登录失效|未到达首页/
  );
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before, '登录页绝不保存（来源字节不变）');
  assert.deepStrictEqual(fingerprintFile(cookieFilePath()), srcBefore, '来源 mtime 也不变');
  if (fs.existsSync(workFilePath(workDir))) {
    assert.strictEqual(JSON.parse(fs.readFileSync(workFilePath(workDir), 'utf-8')).length, 3, '独立工作副本同样未被刷新');
  }
});

test('到达千川但头部为 foreign 账户：打开成功、检查点跳过，文件保持原样', async () => {
  const workDir = newWorkDir('foreign');
  writeCookieFile(fakeCookies(3));
  const srcBefore = fingerprintFile(cookieFilePath());
  const stub = makeStubPage({
    cookies: fakeCookies(4),
    accountId: '999999999999999999',
    urlQueue: [FXG_HOME, FXG_HOME, QC_HOME],
  });
  const r = await openQianchuanHome(
    { cookieSourceDir: dir, cookieWorkDir: workDir, edgePath: 'edge' },
    { cookieFile: '测试店铺', accountId: ACCOUNT },
    { browserFactory: async () => stub.browser }
  );
  assert.strictEqual(r.cookieCheckpoint.saved, false, 'foreign：不保存');
  assert.match(r.cookieCheckpoint.reason, /不一致|foreign/);
  assert.strictEqual(JSON.parse(fs.readFileSync(r.cookieSession.filePath, 'utf-8')).length, 3, '工作副本保持导入时的原样');
  assert.deepStrictEqual(fingerprintFile(cookieFilePath()), srcBefore, '只读上游来源不变');
});

test('配置缺 accountId（未知账户）：跳过检查点，不要求新增配置', async () => {
  const workDir = newWorkDir('no-account');
  writeCookieFile(fakeCookies(3));
  const srcBefore = fingerprintFile(cookieFilePath());
  const stub = makeStubPage({ cookies: fakeCookies(4), urlQueue: [FXG_HOME, FXG_HOME, QC_HOME] });
  const r = await openQianchuanHome(
    { cookieSourceDir: dir, cookieWorkDir: workDir, edgePath: 'edge' },
    { cookieFile: '测试店铺', accountId: null },
    { browserFactory: async () => stub.browser }
  );
  assert.strictEqual(r.cookieCheckpoint.saved, false);
  assert.match(r.cookieCheckpoint.reason, /配置未提供千川账户ID/);
  assert.strictEqual(JSON.parse(fs.readFileSync(r.cookieSession.filePath, 'utf-8')).length, 3, '工作副本保持原样');
  assert.deepStrictEqual(fingerprintFile(cookieFilePath()), srcBefore, '只读上游来源不变');
});

test('await context.cookies() 异步空隙期间新登录改写文件：冲突保护跳过，保留较新文件（保护新文件不被旧会话覆盖）', async () => {
  writeCookieFile(fakeCookies(3));
  const startFp = fingerprintFile(cookieFilePath());
  const newLogin = fakeCookies(5);
  const stub = makeStubPage({
    cookies: async () => { writeCookieFile(newLogin); return fakeCookies(4); },
  });
  const r = await checkpointQianchuanSessionCookies({
    context: stub.context,
    cookieSession: { filePath: cookieFilePath(), startFingerprint: startFp },
    target: stub.page,
    shopCfg: { id: 'shop-001', accountId: ACCOUNT },
  });
  assert.strictEqual(r.saved, false, '冲突 → 不保存');
  assert.match(r.reason, /已被改变|保留较新文件/);
  assert.strictEqual(JSON.parse(fs.readFileSync(cookieFilePath(), 'utf-8')).length, 5, '保留新登录文件');
});

test('写入后落盘又被其他进程改写：不采用新指纹；原（过时）指纹的后续回写继续受冲突保护', async () => {
  writeCookieFile(fakeCookies(3));
  const startFp = fingerprintFile(cookieFilePath());
  const refreshed = fakeCookies(4);
  const stub = makeStubPage({ cookies: refreshed });
  const cookieSession = { filePath: cookieFilePath(), startFingerprint: startFp };
  const r = await checkpointQianchuanSessionCookies({
    context: stub.context, cookieSession, target: stub.page,
    shopCfg: { id: 'shop-001', accountId: ACCOUNT },
  });
  assert.strictEqual(r.saved, true, '检查点自身写入成功');
  assert.strictEqual(r.fingerprintAdvanced, true, '无并发时正常推进');
  // 写入完成后另一进程改写文件：推进条件（落盘==owned 序列化）已不成立
  writeCookieFile(fakeCookies(6));
  const expectedSha = crypto.createHash('sha256').update(JSON.stringify(refreshed, null, 2)).digest('hex');
  assert.notStrictEqual(fingerprintFile(cookieFilePath()).sha256, expectedSha, '前置：改写后落盘不再等于 owned 序列化');
  // 模拟同一条件下的推进分支语义：指纹保持检查点当时采用的值，不追踪任意"刚变化的文件"
  const adopted = cookieSession.startFingerprint.sha256;
  writeCookieFile(fakeCookies(7));
  assert.strictEqual(cookieSession.startFingerprint.sha256, adopted, '会话指纹不随后续外部改写漂移');
  // 且原指纹已过时 → 后续回写按冲突保护跳过（保留较新文件）
  const later = await writebackSessionCookies({
    context: stub.context, cookieFilePath: cookieFilePath(),
    sessionStartFingerprint: startFp, identityOk: true, loginOk: true,
  });
  assert.strictEqual(later.ok, false, '指纹不匹配 → 后续回写仍被冲突保护拦截');
});

test('检查点链路零广告动作：全程无广告开关/批量按钮点击，成功路径不关浏览器', async () => {
  const workDir = newWorkDir('zero-ad');
  writeCookieFile(fakeCookies(3));
  const stub = makeStubPage({ cookies: fakeCookies(4), urlQueue: [FXG_HOME, FXG_HOME, QC_HOME] });
  const r = await openQianchuanHome(
    { cookieSourceDir: dir, cookieWorkDir: workDir, edgePath: 'edge' },
    { cookieFile: '测试店铺', accountId: ACCOUNT },
    { browserFactory: async () => stub.browser }
  );
  assert.strictEqual(r.cookieCheckpoint.saved, true);
  assert.ok(stub.calls.clicks <= 2, '只有入口导航点击（含重试），无广告控件点击');
  assert.strictEqual(stub.calls.closes, 0, '成功路径不关浏览器');
});

// ── R59 回归：单一 cookies 读取 + 取回后新鲜复验（消除 TOCTOU）──────────────

test('非空有效 owned 刷新：helper 全程恰好一次 cookies 调用即成功；推进后同会话后续回写不自冲突', async () => {
  writeCookieFile(fakeCookies(3));
  const startFp = fingerprintFile(cookieFilePath());
  const refreshed = fakeCookies(4);
  const stub = makeStubPage({ cookies: refreshed });
  const cookieSession = { filePath: cookieFilePath(), startFingerprint: startFp };
  const r = await checkpointQianchuanSessionCookies({
    context: stub.context, cookieSession, target: stub.page,
    shopCfg: { id: 'shop-001', accountId: ACCOUNT },
  });
  assert.strictEqual(r.saved, true);
  assert.strictEqual(r.fingerprintAdvanced, true);
  assert.strictEqual(stub.calls.cookieReads, 1, '检查点内恰好一次真实 context.cookies 读取（无双重快照）');
  const later = await writebackSessionCookies({
    context: stub.context, cookieFilePath: cookieFilePath(),
    sessionStartFingerprint: cookieSession.startFingerprint,
    identityOk: true, loginOk: true,
  });
  assert.strictEqual(later.ok, true, '推进后同会话后续回写不再被自身冲突保护误伤');
  assert.strictEqual(stub.calls.cookieReads, 2, '后续回写是独立的再一次读取');
});

test('cookies 取回期间 URL 漂移到登录页：复验拒绝，saved=false，文件字节不变', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const startFp = fingerprintFile(cookieFilePath());
  const stub = makeStubPage({
    cookies: async () => { stub.setUrl(QC_LOGIN); return fakeCookies(4); },
  });
  const r = await checkpointQianchuanSessionCookies({
    context: stub.context,
    cookieSession: { filePath: cookieFilePath(), startFingerprint: startFp },
    target: stub.page,
    shopCfg: { id: 'shop-001', accountId: ACCOUNT },
  });
  assert.strictEqual(r.saved, false, 'URL 漂移 → 不保存');
  assert.match(r.reason, /复验失败|登录|取消/, '拒绝原因指向复验/登录漂移');
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before, '文件字节不变');
});

test('cookies 取回期间账户漂移为 foreign：复验拒绝，saved=false，文件字节不变', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const startFp = fingerprintFile(cookieFilePath());
  const stub = makeStubPage({
    cookies: async () => { stub.setAccountId('999999999999999999'); return fakeCookies(4); },
  });
  const r = await checkpointQianchuanSessionCookies({
    context: stub.context,
    cookieSession: { filePath: cookieFilePath(), startFingerprint: startFp },
    target: stub.page,
    shopCfg: { id: 'shop-001', accountId: ACCOUNT },
  });
  assert.strictEqual(r.saved, false, '账户漂移 → 不保存');
  assert.match(r.reason, /复验失败|不一致/);
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before, '文件字节不变');
});

test('探针 evaluate 期间页面发生导航（探针前后 URL 不一致）：复验拒绝，saved=false，文件字节不变', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const startFp = fingerprintFile(cookieFilePath());
  const stub = makeStubPage({ cookies: fakeCookies(4) });
  let navCount = 0;
  stub.setProbe(() => {
    // 每次探针都把地址再推进一步：探针前采样的 URL 与探针后不一致 → 导航漂移
    navCount += 1;
    stub.setUrl(`${QC_HOME}&nav=${navCount}`);
    return { accountId: ACCOUNT, accountName: '伊人美', candidates: 1, unique: true, loginVisible: false };
  });
  const r = await checkpointQianchuanSessionCookies({
    context: stub.context,
    cookieSession: { filePath: cookieFilePath(), startFingerprint: startFp },
    target: stub.page,
    shopCfg: { id: 'shop-001', accountId: ACCOUNT },
  });
  assert.strictEqual(r.saved, false, '探针期间导航 → 不保存');
  assert.match(r.reason, /导航/);
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before, '文件字节不变');
});

test('同一 home 地址上出现可见登录表单（过期头部仍匹配）：显式负证据拒绝，saved=false，文件字节不变', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const startFp = fingerprintFile(cookieFilePath());
  const stub = makeStubPage({
    cookies: fakeCookies(4),
    probe: () => ({ accountId: ACCOUNT, accountName: '伊人美', candidates: 1, unique: true, loginVisible: true }),
  });
  const r = await checkpointQianchuanSessionCookies({
    context: stub.context,
    cookieSession: { filePath: cookieFilePath(), startFingerprint: startFp },
    target: stub.page,
    shopCfg: { id: 'shop-001', accountId: ACCOUNT },
  });
  assert.strictEqual(r.saved, false, '可见登录表单 → 不保存（不做任意正文匹配）');
  assert.match(r.reason, /可见登录表单/);
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before, '文件字节不变');
});

test('写入器报告 ok 之后、指纹推进之前，真实在飞 audit 回调内并发改写文件：指纹不推进、原起始指纹保留、新文件不被触碰', async () => {
  writeCookieFile(fakeCookies(3));
  const startFp = fingerprintFile(cookieFilePath());
  const refreshed = fakeCookies(4);
  const stub = makeStubPage({ cookies: refreshed });
  const cookieSession = { filePath: cookieFilePath(), startFingerprint: startFp };
  const racedNewFile = fakeCookies(6);
  let sawWriterOk = false;
  const r = await checkpointQianchuanSessionCookies({
    context: stub.context, cookieSession, target: stub.page,
    shopCfg: { id: 'shop-001', accountId: ACCOUNT },
    audit: (e) => {
      // 真实在飞回调：写入器刚报告 ok、helper 尚未推进指纹的窗口内并发写新登录文件
      if (e && e.ok === true && !sawWriterOk) {
        sawWriterOk = true;
        writeCookieFile(racedNewFile);
      }
    },
  });
  assert.ok(sawWriterOk, '前置：并发注入确实发生在写入器 ok 之后');
  assert.strictEqual(r.saved, true, '写入器本身已成功（历史事实如实返回）');
  assert.strictEqual(r.fingerprintAdvanced, false, '指纹不推进');
  assert.strictEqual(cookieSession.startFingerprint.sha256, startFp.sha256, '原起始指纹保留（不采用任意新文件指纹）');
  assert.strictEqual(JSON.parse(fs.readFileSync(cookieFilePath(), 'utf-8')).length, 6, '并发写入的新文件不被触碰（不回滚覆盖）');
});
