'use strict';

/**
 * AD-AUTO-PLAN-REPAIR-20261012-S87：会话 Cookie 收尾最终化（罗盘/千川关闭前回写）离线测试。
 *
 * 背景：compass-order-reader.readOrderSummary 与 qianchuan-reader.closeBrowser 此前在读数/
 * 打开成功后直接关浏览器，会话期间浏览器内刷新的 Cookie 从不回写（下一次只能盲扫）。S87 新增
 * 「关闭前以当前时刻事实重新核验语义身份 → 才经既有授权写入器回写」的收尾检查点。
 *
 * 本文件全部离线：stub context/page + 操作系统临时文件 + 假 Cookie（无真实凭证、无网络、
 * 无真实浏览器、零广告动作）。覆盖：
 *  - 纯函数：isVerifiedCompassUrl（严格 origin/path）、safeShopFileName、decideCompassCheckpoint；
 *  - DOM fixture：probeCompassShopNameInPage（唯一可见 [class*=userName]、隐藏 fail-closed、
 *    多候选拒绝、可见登录控件负证据）；
 *  - checkpointCompassSessionCookies 直测：成功 + 起始指纹推进 + 同会话后续回写不自冲突；
 *    目标文件名不绑定/登录页/身份缺失/URL 漂移/并发外部新文件 → 全部零写或保留较新文件；
 *  - 真实关闭链集成（假 context 闭环）：readOrderSummary 成功读数 → 关浏览器前已回写刷新
 *    Cookie（S99：回写落在本项目**独立工作副本**上，配置来源目录作为只读上游零写入，
 *    断言取自真实返回/独立工作路径，来源字节与 mtime 保持不变）；
 *    读取失败仍原样抛错且浏览器照常关闭、文件字节不变；
 *  - 千川 closeBrowser：openQianchuanHome + closeBrowser 收尾保存；并发关闭只最终化一次；
 *    打开失败路径浏览器原样关闭、不做收尾保存。
 * 运行：由主脑统一执行（本 Worker 阶段未运行命令）。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isVerifiedCompassUrl,
  probeCompassShopNameInPage,
  decideCompassCheckpoint,
  checkpointCompassSessionCookies,
  safeShopFileName,
  checkpointQianchuanSessionCookies,
} = require('../src/login/session-cookie-checkpoint');
const { fingerprintFile, writebackSessionCookies } = require('../src/login/cookie-writeback');
const { createCompassOrderReader } = require('../src/adapters/compass-order-reader');
const { openQianchuanHome, closeBrowser } = require('../src/adapters/qianchuan-reader');

const SHOP_NAME = '测试店铺';
const SHOP_CFG = { id: 'shop-r87', name: SHOP_NAME, compassShopName: SHOP_NAME, cookieFile: SHOP_NAME };
const COMPASS_HOME = 'https://compass.jinritemai.com/shop';
const COMPASS_DASH = 'https://compass.jinritemai.com/shop/dashboard/index?page_name=经营概况';
const COMPASS_PRODUCT = 'https://compass.jinritemai.com/shop/commodity/product-list';
const COMPASS_LOGIN = 'https://compass.jinritemai.com/login/common';
const FXG_HOME = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const FXG_LOGIN = 'https://fxg.jinritemai.com/login/common';
const QC_HOME = 'https://qianchuan.jinritemai.com/home';
const QC_ACCOUNT = '1710242295996424';

let dir = null;
const workRoots = [];
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cookie-finalization-r87-')); });
after(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  for (const w of workRoots) { try { fs.rmSync(w, { recursive: true, force: true }); } catch (_) { /* ignore */ } }
});

/**
 * S99 迁移：真实链路（openQianchuanHome / readOrderSummary）经 resolveCookieFile 把
 * 「配置来源目录」当只读上游，回写只落在**本项目独立工作副本**上。为保证隔离，每个
 * 集成用例使用自己的临时工作根（login.cookieWorkDir），假 Cookie 绝不落到真实生产根，
 * 也不与其它测试进程共享同名文件；断言改为「工作副本被刷新 + 来源字节/mtime 不变」。
 */
function newWorkDir(tag) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `cookie-finalization-r87-work-${tag}-`));
  workRoots.push(d);
  return d;
}
function workFilePath(workDir, name = SHOP_NAME) { return path.join(workDir, `${name}.json`); }

/** 假 Cookie 数组（无真实凭证；满足写入器域完整性/数量守卫）。 */
function fakeCookies(n = 3) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      name: `ck_${i}`, value: `FAKE_NOT_REAL_${i}`,
      domain: i === 0 ? '.fxg.jinritemai.com' : '.jinritemai.com',
      path: '/', expires: Math.floor(Date.now() / 1000) + 86400,
      httpOnly: true, secure: true, sameSite: 'Lax',
    });
  }
  return out;
}

function cookieFilePath(name = SHOP_NAME) { return path.join(dir, `${name}.json`); }
function writeCookieFile(cookies, name = SHOP_NAME) {
  fs.writeFileSync(cookieFilePath(name), JSON.stringify(cookies, null, 2));
  return fingerprintFile(cookieFilePath(name));
}

/** 罗盘页 stub：evaluate 按函数源分派（userName 探针 / 指标探测 / 概况可见性）。 */
function makeCompassStub({
  urlQueue = [FXG_HOME, COMPASS_DASH, COMPASS_DASH],
  cookies, pageShopName = SHOP_NAME, overviewOk = true, entryCount = 1,
} = {}) {
  const calls = { closes: 0, cookieReads: 0, userNameProbes: 0 };
  let urlIdx = 0;
  let closed = false;
  const cookiesFn = typeof cookies === 'function' ? cookies : async () => cookies;
  const page = {
    __calls: calls,
    goto: async () => null,
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    waitForFunction: async () => null,
    waitForURL: async () => null,
    url: () => urlQueue[Math.min(urlIdx++, urlQueue.length - 1)],
    isClosed: () => closed,
    title: async () => '首页',
    screenshot: async () => {},
    evaluate: async (fn, arg) => {
      if (arg === undefined && /userName/.test(String(fn))) {
        calls.userNameProbes += 1;
        return { name: pageShopName, distinct: [pageShopName], candidates: 1, unique: true, loginVisible: false };
      }
      if (arg && typeof arg === 'object' && typeof arg.uuid === 'string') {
        return {
          code: 'ok', valueText: '0', labelText: '成交订单数',
          cardText: '成交订单数0昨日145同行基准114',
          saleScope: { realtimeActive: true, saleAllActive: true, realtimeFound: true, saleAllFound: true, tabs: [] },
          overviewTimestamp: null,
        };
      }
      if (arg === '经营概况') return overviewOk;
      return null;
    },
    getByText: () => ({
      first() { return this; }, count: async () => entryCount, waitFor: async () => {}, click: async () => {},
    }),
    getByRole: () => ({ count: async () => 0 }),
    locator: () => ({
      first() { return this; }, count: async () => 0, click: async () => {},
      waitFor: async () => {}, isVisible: async () => false, textContent: async () => pageShopName,
    }),
  };
  const context = {
    addCookies: async () => {},
    newPage: async () => page,
    waitForEvent: async () => null,
    on() {}, off() {},
    cookies: async () => { calls.cookieReads += 1; return cookiesFn(); },
  };
  const browser = { newContext: async () => context, close: async () => { calls.closes += 1; closed = true; } };
  return { page, context, browser, calls };
}

/** 千川页 stub：url() 按队列出队；evaluate 分派 shop-name 头部探针。 */
function makeQcStub({
  urlQueue = [FXG_HOME, FXG_HOME, QC_HOME], cookies, accountId = QC_ACCOUNT, entryCount = 1,
} = {}) {
  const calls = { closes: 0, cookieReads: 0 };
  let urlIdx = 0;
  let closed = false;
  const cookiesFn = typeof cookies === 'function' ? cookies : async () => cookies;
  const page = {
    __calls: calls,
    goto: async () => null,
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    waitForFunction: async () => null,
    waitForURL: async () => null,
    url: () => urlQueue[Math.min(urlIdx++, urlQueue.length - 1)],
    isClosed: () => closed,
    screenshot: async () => {},
    evaluate: async (fn) => {
      if (/shop-name/.test(String(fn))) {
        return {
          accountId, accountName: accountId ? '伊人美' : null,
          candidates: accountId ? 1 : 0, unique: Boolean(accountId), loginVisible: false,
        };
      }
      return null;
    },
    getByText: () => ({
      first() { return this; }, count: async () => entryCount, waitFor: async () => {}, click: async () => {},
    }),
    locator: () => ({
      first() { return this; }, count: async () => 0, click: async () => {},
      waitFor: async () => {}, isVisible: async () => false, textContent: async () => '',
    }),
  };
  const context = {
    addCookies: async () => {},
    newPage: async () => page,
    waitForEvent: async () => null,
    on() {}, off() {},
    cookies: async () => { calls.cookieReads += 1; return cookiesFn(); },
  };
  const browser = { newContext: async () => context, close: async () => { calls.closes += 1; closed = true; } };
  return { page, context, browser, calls };
}

// ── 纯函数：严格罗盘来源判定 ─────────────────────────────────────

test('isVerifiedCompassUrl：受支持 /shop 路径通过；登录/未支持路径/非默认端口/伪造域/其它域一律拒绝', () => {
  assert.strictEqual(isVerifiedCompassUrl(COMPASS_HOME), true);
  assert.strictEqual(isVerifiedCompassUrl(COMPASS_DASH), true, 'query 不参与 path 判定');
  assert.strictEqual(isVerifiedCompassUrl(COMPASS_PRODUCT), true);
  assert.strictEqual(isVerifiedCompassUrl('https://compass.jinritemai.com:443/shop'), true, '显式默认端口 443 允许（origin 规范化）');
  assert.strictEqual(isVerifiedCompassUrl('https://compass.jinritemai.com:444/shop'), false, '非默认端口拒绝');
  assert.strictEqual(isVerifiedCompassUrl('https://compass.jinritemai.com.evil.test/shop'), false, '同后缀伪造域拒绝');
  assert.strictEqual(isVerifiedCompassUrl(COMPASS_LOGIN), false, '登录中转页拒绝');
  assert.strictEqual(isVerifiedCompassUrl('https://compass.jinritemai.com/other/path'), false, '未支持路径拒绝');
  assert.strictEqual(isVerifiedCompassUrl(FXG_HOME), false, '抖店域不是罗盘检查点');
  assert.strictEqual(isVerifiedCompassUrl(''), false);
  assert.strictEqual(isVerifiedCompassUrl(null), false);
});

test('safeShopFileName：仅替换 Windows 非法文件名字符，中文店名原样保留', () => {
  assert.strictEqual(safeShopFileName('测试店铺'), '测试店铺');
  assert.strictEqual(safeShopFileName('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
  assert.strictEqual(safeShopFileName(''), '');
  assert.strictEqual(safeShopFileName(null), '');
});

test('decideCompassCheckpoint：配置缺名/非可信地址/身份缺失或冲突/可见登录控件/名称不匹配均跳过；唯一匹配通过', () => {
  const okObs = { name: SHOP_NAME, unique: true, loginVisible: false };
  assert.match(
    decideCompassCheckpoint({ url: COMPASS_HOME, expectedNames: [], observed: okObs }).reason,
    /未提供/,
    '配置缺 compassShopName/name → 跳过'
  );
  assert.strictEqual(decideCompassCheckpoint({ url: COMPASS_LOGIN, expectedNames: [SHOP_NAME], observed: okObs }).ok, false, '登录页跳过');
  assert.strictEqual(decideCompassCheckpoint({ url: COMPASS_HOME, expectedNames: [SHOP_NAME], observed: { name: null, unique: false } }).ok, false, '身份缺失跳过');
  assert.strictEqual(
    decideCompassCheckpoint({ url: COMPASS_HOME, expectedNames: [SHOP_NAME], observed: { name: SHOP_NAME, unique: true, loginVisible: true } }).ok,
    false, '可见登录控件即使名称匹配也跳过'
  );
  assert.strictEqual(decideCompassCheckpoint({ url: COMPASS_HOME, expectedNames: [SHOP_NAME], observed: { name: '别的店', unique: true } }).ok, false, '名称不匹配跳过');
  const d = decideCompassCheckpoint({ url: COMPASS_HOME, expectedNames: [SHOP_NAME], observed: okObs });
  assert.strictEqual(d.ok, true);
  assert.strictEqual(d.name, SHOP_NAME);
});

// ── DOM fixture：罗盘 userName 探针 ───────────────────────────────

function withFakeDom(queryAllOrEls, fn, cs) {
  const savedDoc = global.document;
  const savedGcs = global.getComputedStyle;
  const queryAll = Array.isArray(queryAllOrEls)
    ? (sel) => (sel === '[class*="userName"]' ? queryAllOrEls.slice() : [])
    : queryAllOrEls;
  global.document = { querySelectorAll: queryAll };
  global.getComputedStyle = cs ? () => cs : () => ({ display: 'block', visibility: 'visible' });
  try { fn(); } finally {
    global.document = savedDoc;
    global.getComputedStyle = savedGcs;
  }
}
function nameEl(text, rect = { width: 120, height: 20 }) {
  return { textContent: text, getBoundingClientRect: () => rect };
}

test('probeCompassShopNameInPage：唯一可见 [class*=userName] 命中；隐藏/多候选/无候选 fail-closed（无正文兜底）', () => {
  withFakeDom([nameEl(SHOP_NAME)], () => {
    const r = probeCompassShopNameInPage();
    assert.strictEqual(r.unique, true);
    assert.strictEqual(r.name, SHOP_NAME);
    assert.strictEqual(r.candidates, 1);
  });
  withFakeDom([nameEl(SHOP_NAME, { width: 0, height: 0 })], () => {
    assert.strictEqual(probeCompassShopNameInPage().unique, false, '不可见元素不算当前身份');
  });
  withFakeDom([nameEl('甲店'), nameEl('乙店')], () => {
    const r = probeCompassShopNameInPage();
    assert.strictEqual(r.unique, false, '多个不同候选拒绝');
    assert.strictEqual(r.name, null);
  });
  withFakeDom([], () => {
    assert.strictEqual(probeCompassShopNameInPage().unique, false, '无候选拒绝');
  });
  withFakeDom([nameEl(SHOP_NAME)], () => {
    assert.strictEqual(probeCompassShopNameInPage().unique, false, 'display:none 的 userName 不算');
  }, { display: 'none', visibility: 'visible' });
  const throwing = { textContent: SHOP_NAME, getBoundingClientRect: () => { throw new Error('detached'); } };
  withFakeDom([throwing], () => {
    assert.strictEqual(probeCompassShopNameInPage().unique, false, 'rect 抛错 → fail-closed 不可见');
  });
});

test('probeCompassShopNameInPage：可见登录输入框 → loginVisible=true 显式负证据', () => {
  const loginInput = { tagName: 'INPUT', getBoundingClientRect: () => ({ width: 200, height: 30 }), textContent: '' };
  withFakeDom((sel) => {
    if (sel === '[class*="userName"]') return [nameEl(SHOP_NAME)];
    if (sel.startsWith('input')) return [loginInput];
    return [];
  }, () => {
    const r = probeCompassShopNameInPage();
    assert.strictEqual(r.unique, true, '前置：店名唯一');
    assert.strictEqual(r.loginVisible, true, '同地址可见登录控件为显式负证据');
  });
});

// ── checkpointCompassSessionCookies 直测 ─────────────────────────

/** 罗盘检查点目标绑定：真实 Playwright page 恒有 context()，返回其所属会话 context。 */
function bindCompassTarget(stub) {
  stub.page.context = () => stub.context;
  return stub.page;
}

test('罗盘收尾保存：owned 刷新 Cookie 落盘、起始指纹推进；同会话后续回写不再被自身冲突保护误伤', async () => {
  writeCookieFile(fakeCookies(3));
  const stub = makeCompassStub({ cookies: fakeCookies(4), urlQueue: [COMPASS_DASH] });
  const target = bindCompassTarget(stub);
  const cookieSession = { filePath: cookieFilePath(), startFingerprint: fingerprintFile(cookieFilePath()) };
  const r = await checkpointCompassSessionCookies({ context: stub.context, cookieSession, target, shopCfg: SHOP_CFG });
  assert.strictEqual(r.saved, true);
  assert.strictEqual(r.fingerprintAdvanced, true);
  assert.strictEqual(r.shopName, SHOP_NAME);
  assert.strictEqual(JSON.parse(fs.readFileSync(cookieFilePath(), 'utf-8')).length, 4, '落盘为刷新后的 owned 集合');
  assert.deepStrictEqual(cookieSession.startFingerprint, fingerprintFile(cookieFilePath()), '起始指纹推进为落盘指纹');
  const later = await writebackSessionCookies({
    context: stub.context, cookieFilePath: cookieFilePath(),
    sessionStartFingerprint: cookieSession.startFingerprint, identityOk: true, loginOk: true,
  });
  assert.strictEqual(later.ok, true, '推进后同会话后续回写不冲突');
});

test('罗盘收尾保存：正例——全程 context() 与本次会话全等且未关闭，入口/探针后/取回后各 async 边界均复验 → 保存并推进', async () => {
  writeCookieFile(fakeCookies(3));
  const stub = makeCompassStub({ cookies: fakeCookies(4), urlQueue: [COMPASS_DASH] });
  let binds = 0;
  stub.page.context = () => { binds += 1; return stub.context; };
  const cookieSession = { filePath: cookieFilePath(), startFingerprint: fingerprintFile(cookieFilePath()) };
  const r = await checkpointCompassSessionCookies({ context: stub.context, cookieSession, target: stub.page, shopCfg: SHOP_CFG });
  assert.strictEqual(r.saved, true);
  assert.strictEqual(r.fingerprintAdvanced, true);
  assert.ok(binds >= 4, `入口、身份探针后、Cookie 取回后、取回复验探针后各复验一次（实际 ${binds} 次）`);
  assert.strictEqual(stub.calls.cookieReads, 1, '单一 Cookie 读取');
});

test('罗盘收尾保存：目标文件 basename 与语义店名安全文件名不符 → 跳过，零写', async () => {
  writeCookieFile(fakeCookies(3), '别的店');
  const before = fs.readFileSync(cookieFilePath('别的店'));
  const stub = makeCompassStub({ cookies: fakeCookies(4), urlQueue: [COMPASS_DASH] });
  const target = bindCompassTarget(stub);
  const r = await checkpointCompassSessionCookies({
    context: stub.context,
    cookieSession: { filePath: cookieFilePath('别的店'), startFingerprint: fingerprintFile(cookieFilePath('别的店')) },
    target, shopCfg: SHOP_CFG,
  });
  assert.strictEqual(r.saved, false);
  assert.strictEqual(r.skipped, true);
  assert.match(r.reason, /basename|不符/);
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath('别的店')), before, '文件字节不变');
});

test('罗盘收尾保存：当前页为登录页 → 跳过，零写', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const stub = makeCompassStub({ cookies: fakeCookies(4), urlQueue: [COMPASS_LOGIN] });
  const target = bindCompassTarget(stub);
  const r = await checkpointCompassSessionCookies({
    context: stub.context,
    cookieSession: { filePath: cookieFilePath(), startFingerprint: fingerprintFile(cookieFilePath()) },
    target, shopCfg: SHOP_CFG,
  });
  assert.strictEqual(r.saved, false);
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before);
});

test('罗盘收尾保存：页面无可见 userName 语义身份 → 跳过，零写', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const stub = makeCompassStub({ cookies: fakeCookies(4), urlQueue: [COMPASS_DASH] });
  stub.page.evaluate = async (fn, arg) => {
    if (arg === undefined && /userName/.test(String(fn))) {
      return { name: null, distinct: [], candidates: 0, unique: false, loginVisible: false };
    }
    return null;
  };
  const target = bindCompassTarget(stub);
  const r = await checkpointCompassSessionCookies({
    context: stub.context,
    cookieSession: { filePath: cookieFilePath(), startFingerprint: fingerprintFile(cookieFilePath()) },
    target, shopCfg: SHOP_CFG,
  });
  assert.strictEqual(r.saved, false);
  assert.match(r.reason, /userName|唯一|语义店铺名/, '跳过原因须来自身份门，而非地址门');
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before);
});

test('罗盘收尾保存：cookies 取回期间 URL 漂移到登录页 → 复验拒绝，零写', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  let flipped = false;
  const stub = makeCompassStub({ cookies: async () => { flipped = true; return fakeCookies(4); } });
  const page = bindCompassTarget(stub);
  const urlQ = [COMPASS_DASH, COMPASS_DASH, COMPASS_DASH, COMPASS_LOGIN];
  let idx = 0;
  page.url = () => (flipped ? COMPASS_LOGIN : urlQ[Math.min(idx++, urlQ.length - 1)]);
  const r = await checkpointCompassSessionCookies({
    context: stub.context,
    cookieSession: { filePath: cookieFilePath(), startFingerprint: fingerprintFile(cookieFilePath()) },
    target: page, shopCfg: SHOP_CFG,
  });
  assert.strictEqual(r.saved, false);
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before, '漂移 → 零写');
});

test('罗盘收尾保存：cookies 取回期间外部写入更新文件 → 冲突保护保留较新文件', async () => {
  writeCookieFile(fakeCookies(3));
  const newLogin = fakeCookies(5);
  const stub = makeCompassStub({ cookies: async () => { writeCookieFile(newLogin); return fakeCookies(4); }, urlQueue: [COMPASS_DASH] });
  const target = bindCompassTarget(stub);
  const r = await checkpointCompassSessionCookies({
    context: stub.context,
    cookieSession: { filePath: cookieFilePath(), startFingerprint: fingerprintFile(cookieFilePath()) },
    target, shopCfg: SHOP_CFG,
  });
  assert.strictEqual(r.saved, false);
  assert.match(r.reason, /保留较新文件|已被改变/);
  assert.strictEqual(JSON.parse(fs.readFileSync(cookieFilePath(), 'utf-8')).length, 5, '保留并发新登录文件');
});

test('罗盘收尾保存：context 无 cookies 能力 / 未提供页面 / 地址不可读 → 安全跳过，零写', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const startFp = fingerprintFile(cookieFilePath());
  const stub = makeCompassStub({ cookies: fakeCookies(4) });
  const r1 = await checkpointCompassSessionCookies({
    context: { addCookies: async () => {} }, cookieSession: { filePath: cookieFilePath(), startFingerprint: startFp }, target: stub.page, shopCfg: SHOP_CFG,
  });
  assert.strictEqual(r1.saved, false);
  const r2 = await checkpointCompassSessionCookies({
    context: stub.context, cookieSession: { filePath: cookieFilePath(), startFingerprint: startFp }, target: null, shopCfg: SHOP_CFG,
  });
  assert.strictEqual(r2.saved, false);
  const badPage = { url: () => { throw new Error('page gone'); }, evaluate: async () => ({}) };
  const r3 = await checkpointCompassSessionCookies({
    context: stub.context, cookieSession: { filePath: cookieFilePath(), startFingerprint: startFp }, target: badPage, shopCfg: SHOP_CFG,
  });
  assert.strictEqual(r3.saved, false);
  assert.match(r3.reason, /context/, '缺 context() 能力属绑定不可证明 → 拒绝');
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before, '以上跳过一次都不写');
});

test('罗盘收尾保存：foreign context（page.context() 与本次会话不全等）→ 入口拒绝，零 Cookie 读取、零写', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const stub = makeCompassStub({ cookies: fakeCookies(4), urlQueue: [COMPASS_DASH] });
  stub.page.context = () => ({ foreign: '其它会话的 context' });
  const r = await checkpointCompassSessionCookies({
    context: stub.context,
    cookieSession: { filePath: cookieFilePath(), startFingerprint: fingerprintFile(cookieFilePath()) },
    target: stub.page, shopCfg: SHOP_CFG,
  });
  assert.strictEqual(r.saved, false);
  assert.strictEqual(r.skipped, true);
  assert.match(r.reason, /context/);
  assert.strictEqual(stub.calls.cookieReads, 0, '绑定失败在读取 Cookie 之前');
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before, '零回写：文件字节不变');
});

test('罗盘收尾保存：文件 basename 同名不能替代 context 绑定（foreign 页仍拒绝）', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const stub = makeCompassStub({ cookies: fakeCookies(4), urlQueue: [COMPASS_DASH] });
  stub.page.context = () => ({ sameFileNameButForeign: true });
  const r = await checkpointCompassSessionCookies({
    context: stub.context,
    // 目标文件与本次语义店名安全文件名精确一致（basename 规则本身成立），仅 context 绑定不成立
    cookieSession: { filePath: cookieFilePath(), startFingerprint: fingerprintFile(cookieFilePath()) },
    target: stub.page, shopCfg: SHOP_CFG,
  });
  assert.strictEqual(r.saved, false);
  assert.match(r.reason, /不全等|foreign/);
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before);
});

test('罗盘收尾保存：身份探针 evaluate 期间 context 被替换 → 探针后复验拒绝，零 Cookie 读取、零写', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const stub = makeCompassStub({ cookies: fakeCookies(4), urlQueue: [COMPASS_DASH] });
  let bound = stub.context;
  stub.page.context = () => bound;
  const realEvaluate = stub.page.evaluate;
  stub.page.evaluate = async (fn, arg) => {
    const out = await realEvaluate(fn, arg);
    if (arg === undefined && /userName/.test(String(fn))) bound = { foreign: '探针期间换掉的 context' };
    return out;
  };
  const r = await checkpointCompassSessionCookies({
    context: stub.context,
    cookieSession: { filePath: cookieFilePath(), startFingerprint: fingerprintFile(cookieFilePath()) },
    target: stub.page, shopCfg: SHOP_CFG,
  });
  assert.strictEqual(r.saved, false);
  assert.match(r.reason, /context/);
  assert.strictEqual(stub.calls.cookieReads, 0, '探针后绑定失败即止，不再读取 Cookie');
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before);
});

test('罗盘收尾保存：Cookie 取回（capture）期间 context 漂移 → 取回后复验抛错，落盘字节不变', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const stub = makeCompassStub({ cookies: fakeCookies(4), urlQueue: [COMPASS_DASH] });
  let bound = stub.context;
  stub.page.context = () => bound;
  stub.context.cookies = async () => {
    stub.calls.cookieReads += 1;
    bound = { foreign: 'capture 期间换掉的 context' };
    return fakeCookies(4);
  };
  const r = await checkpointCompassSessionCookies({
    context: stub.context,
    cookieSession: { filePath: cookieFilePath(), startFingerprint: fingerprintFile(cookieFilePath()) },
    target: stub.page, shopCfg: SHOP_CFG,
  });
  assert.strictEqual(r.saved, false);
  assert.strictEqual(stub.calls.cookieReads, 1, '仍只做单一 Cookie 读取');
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before, '取回后绑定漂移 → 零回写');
});

test('罗盘收尾保存：目标页已关闭 / context() 抛错 → 拒绝，零写', async () => {
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const startFp = fingerprintFile(cookieFilePath());
  const closedStub = makeCompassStub({ cookies: fakeCookies(4), urlQueue: [COMPASS_DASH] });
  closedStub.page.context = () => closedStub.context;
  closedStub.page.isClosed = () => true;
  const r1 = await checkpointCompassSessionCookies({
    context: closedStub.context, cookieSession: { filePath: cookieFilePath(), startFingerprint: startFp }, target: closedStub.page, shopCfg: SHOP_CFG,
  });
  assert.strictEqual(r1.saved, false);
  assert.match(r1.reason, /已关闭/);
  const throwStub = makeCompassStub({ cookies: fakeCookies(4), urlQueue: [COMPASS_DASH] });
  throwStub.page.context = () => { throw new Error('Target page, context or browser has been closed'); };
  const r2 = await checkpointCompassSessionCookies({
    context: throwStub.context, cookieSession: { filePath: cookieFilePath(), startFingerprint: startFp }, target: throwStub.page, shopCfg: SHOP_CFG,
  });
  assert.strictEqual(r2.saved, false);
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before, '两种反例都零写');
  assert.strictEqual(closedStub.calls.cookieReads + throwStub.calls.cookieReads, 0);
});

// ── 真实关闭链集成（compass-order-reader）──────────────────────

/**
 * 每个集成用例现取自己的登录配置：来源目录 = 本文件临时目录（只读上游），
 * 工作根 = 该用例独有的临时目录（login.cookieWorkDir）。旧写法在模块加载期求值
 * `cookieSourceDir: dir`（此时 dir 仍为 null），会退化成真实生产根 guard/cookies
 * 并与其他测试进程的同名假 Cookie 互相污染，已修正。
 */
function compassLoginCfg(workDir) {
  return { cookieSourceDir: dir, cookieWorkDir: workDir, edgePath: 'edge', douyinHomeUrl: FXG_HOME };
}
function makeCompassReader(stub, workDir) {
  return createCompassOrderReader({
    loginCfg: compassLoginCfg(workDir),
    nowFn: () => Date.parse('2026-10-16T10:00:00+08:00'),
    sleep: async () => {},
    settleSleep: async () => {},
    evidenceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'r87-evidence-')),
    browserFactory: async () => stub.browser,
  });
}

test('集成：readOrderSummary 成功读数 → 关闭浏览器前已回写本会话刷新 Cookie（独立副本旧→关前新，来源零写入）', async () => {
  const workDir = newWorkDir('orders-ok');
  writeCookieFile(fakeCookies(3));
  const srcBefore = fingerprintFile(cookieFilePath());
  const stub = makeCompassStub({ cookies: fakeCookies(4) });
  bindCompassTarget(stub);
  const r = await makeCompassReader(stub, workDir).readOrderSummary({ shopCfg: SHOP_CFG });
  assert.strictEqual(r.identitySource.adapter, 'compass-order-reader');
  assert.strictEqual(stub.calls.closes, 1, '读取结束关闭浏览器');
  assert.ok(stub.calls.userNameProbes >= 1, '收尾检查点重新做了当前时刻身份核验');
  const workPath = workFilePath(workDir);
  assert.strictEqual(JSON.parse(fs.readFileSync(workPath, 'utf-8')).length, 4, '关前回写刷新后的 owned 集合（落在独立工作副本）');
  assert.deepStrictEqual(fingerprintFile(cookieFilePath()), srcBefore, '只读上游来源字节与 mtime 全程不变');
  assert.strictEqual(JSON.parse(fs.readFileSync(cookieFilePath(), 'utf-8')).length, 3, '来源仍是关前旧内容');
  assert.deepStrictEqual(
    fs.readdirSync(workDir).filter((f) => f.endsWith('.lock') || f.includes('.tmp-')), [],
    '工作根无锁/tmp 残留'
  );
});

test('集成：读取失败（登录页）→ 原始错误原样抛出、浏览器照常关闭、Cookie 文件字节不变', async () => {
  const workDir = newWorkDir('orders-login-fail');
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const stub = makeCompassStub({ cookies: fakeCookies(4), urlQueue: [FXG_LOGIN] });
  bindCompassTarget(stub);
  await assert.rejects(() => makeCompassReader(stub, workDir).readOrderSummary({ shopCfg: SHOP_CFG }), /登录失效|未到达首页/);
  assert.strictEqual(stub.calls.closes, 1, '失败路径仍关闭浏览器');
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before, '未登录/未读数不保存（来源不变）');
  if (fs.existsSync(workFilePath(workDir))) {
    assert.strictEqual(JSON.parse(fs.readFileSync(workFilePath(workDir), 'utf-8')).length, 3, '独立工作副本也未被刷新');
  }
});

// ── 千川 closeBrowser 收尾最终化 ────────────────────────────────

/**
 * 千川 close 用例补齐 openQianchuanHome 实际调用的入口定位 API（与旧
 * guard/test/qianchuan-reader.test.js fixture 同口径：getByText/locator 均支持
 * nth()/evaluate() 祖先 <a> href 读取）。只补被调用的能力，不改导航轮次、不削弱断言。
 */
function withQcEntryApi(stub) {
  const page = stub.page;
  page.title = async () => '巨量千川';
  page.reload = async () => {};
  page.goBack = async () => {};
  page.keyboard = { press: async () => {} };
  page.getByText = () => ({
    first() { return this; },
    nth() { return this; },
    count: async () => 1,
    click: async () => {},
    waitFor: async () => {},
    evaluate: async () => '',
    isVisible: async () => false,
    textContent: async () => '',
  });
  page.locator = () => ({
    nth: () => ({
      first() { return this; },
      locator: () => ({ first() { return this; }, waitFor: async () => {}, click: async () => {} }),
      evaluate: async () => '',
      click: async () => {},
      waitFor: async () => {},
      textContent: async () => '',
    }),
    first() { return this; },
    waitFor: async () => {},
    click: async () => {},
    textContent: async () => '',
  });
  return stub;
}

test('千川 closeBrowser：打开成功 + 关闭前以当前时刻事实收尾保存（打开时注入跳过，关闭时真实保存）', async () => {
  const workDir = newWorkDir('qc-close-save');
  writeCookieFile(fakeCookies(3));
  const srcBefore = fingerprintFile(cookieFilePath());
  const stub = withQcEntryApi(makeQcStub({ cookies: fakeCookies(4) }));
  let calls = 0;
  const injected = async (args) => {
    calls += 1;
    if (calls === 1) return { saved: false, skipped: true, reason: 'open-time skip (test)' };
    return checkpointQianchuanSessionCookies(args);
  };
  const opened = await openQianchuanHome(
    { cookieSourceDir: dir, cookieWorkDir: workDir, edgePath: 'edge' },
    { cookieFile: SHOP_NAME, accountId: QC_ACCOUNT },
    { browserFactory: async () => stub.browser, sessionCheckpoint: injected }
  );
  assert.strictEqual(calls, 1, '打开时注入检查点被调用一次');
  assert.strictEqual(opened.cookieCheckpoint.saved, false, '打开时跳过');
  assert.strictEqual(opened.cookieSession.filePath, workFilePath(workDir), '本次实际加载路径=本项目独立工作副本（非共享上游）');
  await closeBrowser(opened.browser);
  assert.strictEqual(calls, 2, '关闭时收尾检查点再次被调用');
  assert.strictEqual(stub.calls.closes, 1, '关闭浏览器一次');
  assert.strictEqual(JSON.parse(fs.readFileSync(opened.cookieSession.filePath, 'utf-8')).length, 4, '关闭前已回写刷新 Cookie（落在独立工作副本）');
  assert.deepStrictEqual(fingerprintFile(cookieFilePath()), srcBefore, '只读上游来源字节与 mtime 全程不变');
});

test('千川 closeBrowser：同一浏览器并发关闭 → 收尾最终化至多一次，浏览器关闭一次', async () => {
  const workDir = newWorkDir('qc-close-concurrent');
  writeCookieFile(fakeCookies(3));
  const stub = withQcEntryApi(makeQcStub({ cookies: fakeCookies(4) }));
  let calls = 0;
  const injected = async (args) => {
    calls += 1;
    if (calls === 1) return { saved: false, skipped: true, reason: 'open-time skip (test)' };
    return checkpointQianchuanSessionCookies(args);
  };
  const opened = await openQianchuanHome(
    { cookieSourceDir: dir, cookieWorkDir: workDir, edgePath: 'edge' },
    { cookieFile: SHOP_NAME, accountId: QC_ACCOUNT },
    { browserFactory: async () => stub.browser, sessionCheckpoint: injected }
  );
  await Promise.all([closeBrowser(opened.browser), closeBrowser(opened.browser)]);
  assert.strictEqual(calls, 2, '并发关闭只额外最终化一次（打开1 + 关闭1）');
  assert.strictEqual(stub.calls.closes, 1, '浏览器只关闭一次');
});

test('千川 closeBrowser：最终化完成后再调用 closeBrowser → 不二次最终化、不二次关闭', async () => {
  const workDir = newWorkDir('qc-close-twice');
  writeCookieFile(fakeCookies(3));
  const srcBefore = fingerprintFile(cookieFilePath());
  const stub = withQcEntryApi(makeQcStub({ cookies: fakeCookies(4) }));
  let calls = 0;
  const injected = async (args) => {
    calls += 1;
    if (calls === 1) return { saved: false, skipped: true, reason: 'open-time skip (test)' };
    return checkpointQianchuanSessionCookies(args);
  };
  const opened = await openQianchuanHome(
    { cookieSourceDir: dir, cookieWorkDir: workDir, edgePath: 'edge' },
    { cookieFile: SHOP_NAME, accountId: QC_ACCOUNT },
    { browserFactory: async () => stub.browser, sessionCheckpoint: injected }
  );
  await closeBrowser(opened.browser);
  const after = JSON.parse(fs.readFileSync(opened.cookieSession.filePath, 'utf-8'));
  const srcAfterFirstClose = fingerprintFile(cookieFilePath());
  await closeBrowser(opened.browser);
  assert.strictEqual(calls, 2, '已收尾的登记不触发第二次最终化（打开1 + 关闭1）');
  assert.strictEqual(stub.calls.closes, 1, '浏览器只关闭一次');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(opened.cookieSession.filePath, 'utf-8')), after, '第二次调用不再改工作副本');
  assert.deepStrictEqual(fingerprintFile(cookieFilePath()), srcAfterFirstClose, '第二次调用也不改来源');
  assert.deepStrictEqual(srcAfterFirstClose, srcBefore, '只读上游来源全程字节/mtime 不变');
});

test('千川 closeBrowser：收尾最终化抛错 → 不阻止关闭、不改变业务结果', async () => {
  const workDir = newWorkDir('qc-close-throw');
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const stub = withQcEntryApi(makeQcStub({ cookies: fakeCookies(4) }));
  const injected = async (args) => {
    if (args && args.__final) throw new Error('收尾注入异常（测试）');
    return { saved: false, skipped: true, reason: 'open-time skip (test)' };
  };
  const opened = await openQianchuanHome(
    { cookieSourceDir: dir, cookieWorkDir: workDir, edgePath: 'edge' },
    { cookieFile: SHOP_NAME, accountId: QC_ACCOUNT },
    {
      browserFactory: async () => stub.browser,
      sessionCheckpoint: async (args) => injected({ ...args, __final: true }),
    }
  );
  await closeBrowser(opened.browser);
  assert.strictEqual(stub.calls.closes, 1, '最终化异常仍关闭浏览器一次');
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before, '最终化异常不落盘（来源不变）');
  assert.deepStrictEqual(
    fs.readFileSync(opened.cookieSession.filePath), before,
    '最终化异常也不改独立工作副本（仍等于导入时的来源快照）'
  );
});

test('千川 closeBrowser：打开失败路径浏览器原样关闭、不做收尾最终化', async () => {
  const workDir = newWorkDir('qc-open-fail');
  writeCookieFile(fakeCookies(3));
  const before = fs.readFileSync(cookieFilePath());
  const stub = withQcEntryApi(makeQcStub({ cookies: fakeCookies(4), urlQueue: [FXG_LOGIN] }));
  let calls = 0;
  const injected = async (args) => { calls += 1; return checkpointQianchuanSessionCookies(args); };
  await assert.rejects(
    () => openQianchuanHome(
      { cookieSourceDir: dir, cookieWorkDir: workDir, edgePath: 'edge' },
      { cookieFile: SHOP_NAME, accountId: QC_ACCOUNT },
      { browserFactory: async () => stub.browser, sessionCheckpoint: injected }
    ),
    /登录失效|未到达首页/
  );
  assert.strictEqual(stub.calls.closes, 1, '失败路径关闭本次创建浏览器');
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), before, '未到达千川不保存（来源不变）');
  if (fs.existsSync(workFilePath(workDir))) {
    assert.deepStrictEqual(fs.readFileSync(workFilePath(workDir)), before, '失败路径也不刷新独立工作副本');
  }
});
