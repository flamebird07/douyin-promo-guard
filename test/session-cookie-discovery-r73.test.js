'use strict';

/**
 * R73 未知账户自动发现测试（隔离环境：fake context/双页面桩 + 真实 OS 临时文件；
 * 无真实 Cookie 值、无网络、无浏览器、无广告动作）。覆盖：
 *  1. 显式配置 accountId 的旧链行为完全不变（成功保存/foreign 拒绝）。
 *  2. 无配置 accountId + FXG 语义店名严格匹配 + QC 别名账户（瑾店反例：QC 名"伊人美"
 *     ≠ 店名"瑾漂亮潮流服饰"）→ 真实写盘并推进指纹，discoveredAccountId 冻结返回。
 *  3. 零写拒绝矩阵：任一方身份证据缺失/店名不符/多候选/QC 无 ID/错误 URL 端口路径/
 *     登录控件（FXG 或 QC）/登录页地址/跨 context/身份页关闭/缺身份页/缺店名配置。
 *  4. Cookie 取回后漂移拒绝：FXG 店名漂移、FXG 页关闭、同名不同 QC ID 漂移、QC URL
 *     导航漂移、捕获期间用户新登录换文件（冲突保护）——全部零写。
 *  5. Cookie 数组恰好只读一次；qianchuan-reader 实际接线（真实 openQianchuanHome +
 *     browserFactory 桩）能把同 context 原抖店页经 cookieSession 非枚举引用交给检查点。
 *  6. R74 Root 反例回归：FXG 异步复验 evaluate 返回后对 QC 的最终新鲜核对拒绝复验期间
 *     的 URL/账户ID/关闭状态漂移（零写、单次读取）；直连兜底在同 context 新建 owned QC
 *     页而**不覆盖原 FXG 身份页**（native popup 缺失 / school 教程链接两种兜底均保持
 *     FXG header 并真正调用检查点保存；未知不带ID、已知带 aavid 的 URL 语义不变）。
 * 运行：npm test（本 Worker 阶段无执行授权，由 Root 独立运行取退出码）。
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  isVerifiedDoudianIdentityUrl,
  probeDoudianShopIdentityInPage,
  decideDoudianIdentity,
  decideQianchuanCheckpoint,
  checkpointQianchuanSessionCookies,
} = require('../src/login/session-cookie-checkpoint');
const { fingerprintFile, writebackSessionCookies } = require('../src/login/cookie-writeback');
const { openQianchuanHome } = require('../src/adapters/qianchuan-reader');

const SHOP_NAME = '瑾漂亮潮流服饰';
const QC_ALIAS = '伊人美'; // 关键反例：QC 账户名 ≠ 店铺名，绝不参与店名判定
const ACCOUNT = '1710242295996424';
const OTHER_ACCOUNT = '999999999999999999';
const FXG_HOME = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const FXG_ACCT_CENTER = 'https://fxg.jinritemai.com/ffa/mshop/fund-control/account-center';
const FXG_LOGIN = 'https://fxg.jinritemai.com/login/common';
const QC_HOME = 'https://qianchuan.jinritemai.com/home';

let dir = null;
before(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-discovery-r73-'));
});
after(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

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

function cookieFilePath() { return path.join(dir, '测试店铺R73.json'); }

function writeCookieFile(cookies) {
  fs.writeFileSync(cookieFilePath(), JSON.stringify(cookies, null, 2));
  return fingerprintFile(cookieFilePath());
}

// ── 纯函数：FXG 严格 URL 与语义身份判定 ─────────────────────────────

test('FXG 严格可信地址：首页/账户中心通过；伪造域/非默认端口/登录页/未知路径/千川域拒绝', () => {
  assert.strictEqual(isVerifiedDoudianIdentityUrl(FXG_HOME), true);
  assert.strictEqual(isVerifiedDoudianIdentityUrl(FXG_ACCT_CENTER), true);
  assert.strictEqual(isVerifiedDoudianIdentityUrl('https://fxg.jinritemai.com:443/ffa/mshop/homepage/index'), true, '显式默认端口通过（origin 规范化）');
  assert.strictEqual(isVerifiedDoudianIdentityUrl('https://fxg.jinritemai.com:444/ffa/mshop/homepage/index'), false, '非默认端口拒绝');
  assert.strictEqual(isVerifiedDoudianIdentityUrl('https://fxg.jinritemai.com.evil.test/ffa/mshop/homepage/index'), false, '同后缀伪造域拒绝');
  assert.strictEqual(isVerifiedDoudianIdentityUrl(FXG_LOGIN), false, '登录中转页拒绝');
  assert.strictEqual(isVerifiedDoudianIdentityUrl('https://fxg.jinritemai.com/ffa/mshop/unknown/page'), false, '未知路径拒绝');
  assert.strictEqual(isVerifiedDoudianIdentityUrl(QC_HOME), false, '千川域不是抖店身份页');
  assert.strictEqual(isVerifiedDoudianIdentityUrl('not-a-url'), false);
});

test('decideDoudianIdentity：唯一严格匹配（仅 trim）通过；不符/不唯一/登录控件/不可信地址拒绝', () => {
  const ok = { name: ` ${SHOP_NAME} `, distinct: [SHOP_NAME], candidates: 1, unique: true, loginVisible: false };
  assert.strictEqual(decideDoudianIdentity({ url: FXG_HOME, expectedNames: [SHOP_NAME], observed: ok }).ok, true, 'trim 后全等即匹配');
  assert.strictEqual(decideDoudianIdentity({ url: FXG_ACCT_CENTER, expectedNames: [SHOP_NAME], observed: ok }).ok, true, '账户中心路径同样可信');
  assert.strictEqual(decideDoudianIdentity({ url: FXG_HOME, expectedNames: ['别的店铺'], observed: ok }).ok, false, '名字不符拒绝');
  assert.strictEqual(decideDoudianIdentity({ url: FXG_HOME, expectedNames: [SHOP_NAME], observed: { ...ok, unique: false, name: null } }).ok, false, '候选不唯一拒绝');
  assert.strictEqual(decideDoudianIdentity({ url: FXG_HOME, expectedNames: [SHOP_NAME], observed: { ...ok, loginVisible: true } }).ok, false, '可见登录控件拒绝');
  assert.strictEqual(decideDoudianIdentity({ url: FXG_LOGIN, expectedNames: [SHOP_NAME], observed: ok }).ok, false, '登录页地址拒绝');
  assert.strictEqual(decideDoudianIdentity({ url: FXG_HOME, expectedNames: [SHOP_NAME], observed: null }).ok, false);
  // 反例守卫：QC 账户名绝不可当店名候选
  assert.strictEqual(decideDoudianIdentity({ url: FXG_HOME, expectedNames: [QC_ALIAS], observed: ok }).ok, false);
});

test('decideQianchuanCheckpoint 旧语义不变：未知 expected 仍按原文案跳过（纯函数直调）', () => {
  const obs = { accountId: ACCOUNT, unique: true, loginVisible: false };
  assert.match(
    decideQianchuanCheckpoint({ url: QC_HOME, expectedAccountId: null, observed: obs }).reason,
    /配置未提供千川账户ID/
  );
  assert.strictEqual(decideQianchuanCheckpoint({ url: QC_HOME, expectedAccountId: ACCOUNT, observed: obs }).ok, true);
});

// ── FXG 语义探针：最小 DOM 桩直接驱动真实导出函数 ───────────────────

function withFakeDom({ leaves = [], containers = [], loginEls = [] }, fn, cs) {
  const savedDoc = global.document;
  const savedGcs = global.getComputedStyle;
  global.document = {
    querySelectorAll: (sel) => {
      if (sel.includes('index_userName')) return leaves.slice();
      if (sel.includes('index_headerShopName')) return containers.slice();
      return loginEls.slice();
    },
  };
  global.getComputedStyle = cs ? () => cs : () => ({ display: 'block', visibility: 'visible' });
  try { fn(); } finally {
    global.document = savedDoc;
    global.getComputedStyle = savedGcs;
  }
}

function leafEl(text) {
  return {
    childNodes: [{ nodeType: 3, textContent: ` ${text} ` }],
    getBoundingClientRect: () => ({ width: 120, height: 20 }),
  };
}
function containerEl(firstLine) {
  return {
    innerText: `${firstLine}\n营业中`,
    textContent: `${firstLine} 营业中`,
    getBoundingClientRect: () => ({ width: 160, height: 40 }),
  };
}

test('FXG 探针：userName 叶子优先（仅 trim）；叶子缺失回退 headerShopName 容器首行；多候选/隐藏 fail-closed', () => {
  withFakeDom({ leaves: [leafEl(SHOP_NAME)], containers: [containerEl('别的店铺')] }, () => {
    const r = probeDoudianShopIdentityInPage();
    assert.strictEqual(r.unique, true);
    assert.strictEqual(r.name, SHOP_NAME, '叶子优先且仅 trim，容器不同名不干扰');
  });
  withFakeDom({ containers: [containerEl(SHOP_NAME)] }, () => {
    const r = probeDoudianShopIdentityInPage();
    assert.strictEqual(r.unique, true);
    assert.strictEqual(r.name, SHOP_NAME, '容器首行 fallback');
  });
  withFakeDom({ leaves: [leafEl(SHOP_NAME), leafEl('别的店铺')] }, () => {
    const r = probeDoudianShopIdentityInPage();
    assert.strictEqual(r.unique, false, '多个不同候选 → 冲突拒绝');
    assert.strictEqual(r.name, null);
  });
  const hidden = { childNodes: [{ nodeType: 3, textContent: SHOP_NAME }], getBoundingClientRect: () => ({ width: 0, height: 0 }) };
  withFakeDom({ leaves: [hidden], containers: [containerEl(SHOP_NAME)] }, () => {
    const r = probeDoudianShopIdentityInPage();
    assert.strictEqual(r.unique, true, '不可见叶子被排除后回退容器');
    assert.strictEqual(r.name, SHOP_NAME);
  });
  withFakeDom({ leaves: [], containers: [] }, () => {
    const r = probeDoudianShopIdentityInPage();
    assert.strictEqual(r.unique, false, '无语义候选：绝不坐标扫描/正文兜底');
  });
  const loginInput = { tagName: 'INPUT', getBoundingClientRect: () => ({ width: 200, height: 30 }) };
  withFakeDom({ leaves: [leafEl(SHOP_NAME)], loginEls: [loginInput] }, () => {
    const r = probeDoudianShopIdentityInPage();
    assert.strictEqual(r.loginVisible, true, '可见登录输入框 → 显式负证据');
  });
  withFakeDom({ leaves: [leafEl(SHOP_NAME)] }, () => {
    const r = probeDoudianShopIdentityInPage();
    assert.strictEqual(r.unique, false, 'display:none → fail-closed 不可见');
  }, { display: 'none', visibility: 'visible' });
});

// ── 双页面 fake 会话（FXG 身份页 + QC 目标页，同属一个 fake context）──

function makeDiscoverySession(opts = {}) {
  const calls = { cookieReads: 0 };
  const state = {
    fxgUrl: opts.fxgUrl !== undefined ? opts.fxgUrl : FXG_HOME,
    qcUrl: opts.qcUrl !== undefined ? opts.qcUrl : QC_HOME,
    fxgNames: opts.fxgNames !== undefined ? opts.fxgNames.slice() : [SHOP_NAME],
    fxgLoginVisible: opts.fxgLoginVisible === true,
    qcObs: opts.qcObs !== undefined ? opts.qcObs : {
      accountId: ACCOUNT, accountName: QC_ALIAS, candidates: 1, unique: true, loginVisible: false,
    },
    fxgClosed: false,
    qcClosed: false,
    fxgProbes: 0,
    qcProbes: 0,
  };
  const fxgFromState = () => {
    const texts = state.fxgNames.slice();
    const distinct = [...new Set(texts)];
    return {
      name: (texts.length >= 1 && distinct.length === 1) ? distinct[0] : null,
      distinct,
      candidates: texts.length,
      unique: texts.length >= 1 && distinct.length === 1,
      loginVisible: state.fxgLoginVisible === true,
    };
  };
  const context = {
    cookies: async () => {
      calls.cookieReads += 1;
      if (typeof opts.onCookiesRead === 'function') await opts.onCookiesRead(api);
      return typeof opts.cookies === 'function' ? opts.cookies() : (opts.cookies || fakeCookies(4));
    },
  };
  const fxgPage = {
    url: () => state.fxgUrl,
    isClosed: () => state.fxgClosed,
    context: () => (opts.fxgForeignContext ? { foreign: true } : context),
    evaluate: async (fn) => {
      const src = String(fn);
      if (/index_userName|index_headerShopName/.test(src)) {
        if (state.fxgClosed) throw new Error('page closed');
        state.fxgProbes += 1;
        // 钩子在返回前 awaited：模拟"FXG 复验 evaluate 悬置期间外部世界变化"（Root 反例）
        if (typeof opts.onFxgProbe === 'function') await opts.onFxgProbe(api, state.fxgProbes);
        return fxgFromState();
      }
      return null;
    },
  };
  const qcPage = {
    url: () => state.qcUrl,
    isClosed: () => state.qcClosed,
    context: () => (opts.qcForeignContext ? { foreign: true } : context),
    evaluate: async (fn) => {
      if (/shop-name/.test(String(fn))) {
        state.qcProbes += 1;
        if (typeof opts.onQcProbe === 'function') await opts.onQcProbe(api, state.qcProbes);
        return state.qcObs;
      }
      return null;
    },
  };
  const api = { context, fxgPage, qcPage, calls, state };
  return api;
}

function discoveryShopCfg(over = {}) {
  return { id: 'shop-r73', accountId: null, compassShopName: SHOP_NAME, name: SHOP_NAME, ...over };
}

async function runCheckpoint(api, over = {}) {
  const cookieSession = over.cookieSession
    || { filePath: cookieFilePath(), startFingerprint: fingerprintFile(cookieFilePath()) };
  return checkpointQianchuanSessionCookies({
    context: api.context,
    cookieSession,
    target: over.target !== undefined ? over.target : api.qcPage,
    identityPage: over.identityPage !== undefined ? over.identityPage : api.fxgPage,
    shopCfg: over.shopCfg !== undefined ? over.shopCfg : discoveryShopCfg(),
    audit: over.audit,
  });
}

function assertZeroWrite(beforeBytes, r, pattern) {
  assert.strictEqual(r.saved, false, '必须零写入');
  if (pattern) assert.match(String(r.reason || ''), pattern);
  assert.deepStrictEqual(fs.readFileSync(cookieFilePath()), beforeBytes, 'Cookie 文件字节不变');
}

// ── 显式 accountId：旧链行为完全不变 ────────────────────────────────

test('显式 accountId 旧链：严格匹配成功真实写盘并推进指纹；Cookie 数组恰好只读一次', async () => {
  writeCookieFile(fakeCookies(3));
  const api = makeDiscoverySession();
  const r = await runCheckpoint(api, {
    identityPage: null, // 显式账户链不依赖身份页（旧行为）
    shopCfg: { id: 'shop-r73', accountId: ACCOUNT },
  });
  assert.strictEqual(r.saved, true);
  assert.strictEqual(r.fingerprintAdvanced, true);
  assert.strictEqual(r.discoveredAccountId, undefined, '显式账户不产生"发现"字段');
  assert.strictEqual(api.calls.cookieReads, 1, '恰好一次 context.cookies 读取');
  assert.strictEqual(JSON.parse(fs.readFileSync(cookieFilePath(), 'utf-8')).length, 4);
  const later = await writebackSessionCookies({
    context: api.context, cookieFilePath: cookieFilePath(),
    sessionStartFingerprint: fingerprintFile(cookieFilePath()),
    identityOk: true, loginOk: true,
  });
  assert.strictEqual(later.ok, true, '推进后同会话后续回写不自冲突');
});

test('显式 accountId 旧链：foreign 账户仍拒绝，零写入', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({ qcObs: { accountId: OTHER_ACCOUNT, accountName: '别的账户', candidates: 1, unique: true, loginVisible: false } });
  const r = await runCheckpoint(api, {
    identityPage: null,
    shopCfg: { id: 'shop-r73', accountId: ACCOUNT },
  });
  assertZeroWrite(before, r, /不一致|foreign/);
});

// ── 未知 accountId：自动发现成功（QC 别名 ≠ 店名的瑾店反例）─────────

test('未知账户发现成功：FXG 店名严格匹配 + QC 别名账户 → 真实写盘、指纹推进、冻结 ID 返回、单次读取', async () => {
  writeCookieFile(fakeCookies(3));
  const api = makeDiscoverySession(); // FXG=瑾漂亮潮流服饰；QC 账户名=伊人美（别名，不参与店名判定）
  const cookieSession = { filePath: cookieFilePath(), startFingerprint: fingerprintFile(cookieFilePath()) };
  const r = await runCheckpoint(api, { cookieSession, shopCfg: discoveryShopCfg({ compassShopName: ` ${SHOP_NAME} `, name: null }) });
  assert.strictEqual(r.saved, true, '自动发现店铺允许检查点保存（无需手填账户ID）');
  assert.strictEqual(r.fingerprintAdvanced, true);
  assert.strictEqual(r.discoveredAccountId, ACCOUNT, '冻结的发现 ID 如实返回');
  assert.strictEqual(api.calls.cookieReads, 1, 'Cookie 数组恰好只读一次');
  assert.strictEqual(JSON.parse(fs.readFileSync(cookieFilePath(), 'utf-8')).length, 4, '落盘为刷新后的 owned 集合');
  assert.deepStrictEqual(cookieSession.startFingerprint, fingerprintFile(cookieFilePath()), '会话起始指纹=落盘指纹');
  // 不写配置：shopCfg 未被塞入 accountId
  const cfg = discoveryShopCfg();
  assert.strictEqual(cfg.accountId, null);
});

test('未知账户发现成功（账户中心路径身份页同样可信）', async () => {
  writeCookieFile(fakeCookies(3));
  const api = makeDiscoverySession({ fxgUrl: FXG_ACCT_CENTER });
  const r = await runCheckpoint(api);
  assert.strictEqual(r.saved, true);
  assert.strictEqual(r.discoveredAccountId, ACCOUNT);
});

// ── 未知 accountId：零写拒绝矩阵 ────────────────────────────────────

test('FXG 身份证据缺失（无语义候选）：零写入', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({ fxgNames: [] });
  assertZeroWrite(before, await runCheckpoint(api), /自动发现未通过/);
});

test('FXG 店名与配置不符：零写入（绝不同名放行）', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({ fxgNames: ['别的店铺'] });
  assertZeroWrite(before, await runCheckpoint(api), /不严格匹配|自动发现未通过/);
});

test('FXG 多个不同候选店名：零写入（冲突拒绝）', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({ fxgNames: [SHOP_NAME, '别的店铺'] });
  assertZeroWrite(before, await runCheckpoint(api), /不唯一|自动发现未通过/);
});

test('FXG 登录页地址：零写入', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({ fxgUrl: FXG_LOGIN });
  assertZeroWrite(before, await runCheckpoint(api), /自动发现未通过/);
});

test('FXG 可见登录控件：零写入（同地址残留身份不算当前登录证据）', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({ fxgLoginVisible: true });
  assertZeroWrite(before, await runCheckpoint(api), /登录/);
});

test('QC 无头部数字账户ID：零写入（不做正文兜底）', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({ qcObs: { accountId: null, accountName: QC_ALIAS, candidates: 0, unique: false, loginVisible: false } });
  assertZeroWrite(before, await runCheckpoint(api), /自动发现未通过/);
});

test('QC 多候选头部：零写入', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({ qcObs: { accountId: null, accountName: null, candidates: 2, unique: false, loginVisible: false } });
  assertZeroWrite(before, await runCheckpoint(api), /自动发现未通过/);
});

test('QC 非默认端口 :444：零写入', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({ qcUrl: 'https://qianchuan.jinritemai.com:444/home' });
  assertZeroWrite(before, await runCheckpoint(api), /自动发现未通过/);
});

test('QC 未支持路径：零写入', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({ qcUrl: 'https://qianchuan.jinritemai.com/unknown/path' });
  assertZeroWrite(before, await runCheckpoint(api), /自动发现未通过/);
});

test('QC 登录页地址：零写入', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({ qcUrl: 'https://qianchuan.jinritemai.com/login/common' });
  assertZeroWrite(before, await runCheckpoint(api), /自动发现未通过/);
});

test('QC 可见登录控件：零写入', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({ qcObs: { accountId: ACCOUNT, accountName: QC_ALIAS, candidates: 1, unique: true, loginVisible: true } });
  assertZeroWrite(before, await runCheckpoint(api), /登录/);
});

test('FXG 身份页属于其他 context：零写入（跨 context 拒绝）', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({ fxgForeignContext: true });
  assertZeroWrite(before, await runCheckpoint(api), /context/);
});

test('QC 页属于其他 context：零写入（跨 context 拒绝）', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({ qcForeignContext: true });
  assertZeroWrite(before, await runCheckpoint(api), /context/);
});

test('身份页缺失（未知账户无从取证）：零写入，沿用"配置未提供千川账户ID"语义', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession();
  assertZeroWrite(before, await runCheckpoint(api, { identityPage: null }), /配置未提供千川账户ID/);
});

test('身份页已关闭：零写入', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession();
  api.state.fxgClosed = true;
  assertZeroWrite(before, await runCheckpoint(api), /已关闭/);
});

test('店铺配置无 name/compassShopName：零写入（不猜测身份，不要求新增账户配置）', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession();
  assertZeroWrite(before, await runCheckpoint(api, { shopCfg: { id: 'shop-r73', accountId: null } }), /配置未提供千川账户ID/);
});

// ── Cookie 取回后（捕获期间）漂移：全部零写 ─────────────────────────

test('捕获期间 FXG 店名漂移为别店：复验拒绝，零写入', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({
    onCookiesRead: (a) => { a.state.fxgNames = ['别的店铺']; },
  });
  assertZeroWrite(before, await runCheckpoint(api), /复验/);
});

test('捕获期间同名不同 QC ID 漂移：冻结 ID 复验拒绝，零写入', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({
    onCookiesRead: (a) => {
      a.state.qcObs = { accountId: OTHER_ACCOUNT, accountName: QC_ALIAS, candidates: 1, unique: true, loginVisible: false };
    },
  });
  assertZeroWrite(before, await runCheckpoint(api), /复验失败|不一致/);
});

test('捕获期间 QC URL 导航漂移到登录页：复验拒绝，零写入', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({
    onCookiesRead: (a) => { a.state.qcUrl = 'https://qianchuan.jinritemai.com/login/common'; },
  });
  assertZeroWrite(before, await runCheckpoint(api), /复验失败|取消/);
});

test('捕获期间 FXG 身份页被关闭：复验拒绝，零写入', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({
    onCookiesRead: (a) => { a.state.fxgClosed = true; },
  });
  assertZeroWrite(before, await runCheckpoint(api), /已关闭|复验|失败/);
});

test('捕获期间 FXG 身份页导航离开可信路径：复验拒绝，零写入', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({
    onCookiesRead: (a) => { a.state.fxgUrl = FXG_LOGIN; },
  });
  assertZeroWrite(before, await runCheckpoint(api), /复验/);
});

test('捕获期间用户重新登录换文件：冲突保护跳过，保留较新文件，字节不被旧会话触碰', async () => {
  writeCookieFile(fakeCookies(3));
  const startFp = fingerprintFile(cookieFilePath());
  const api = makeDiscoverySession({
    onCookiesRead: () => { writeCookieFile(fakeCookies(5)); },
  });
  const r = await runCheckpoint(api, {
    cookieSession: { filePath: cookieFilePath(), startFingerprint: startFp },
  });
  assert.strictEqual(r.saved, false, '并发新登录 → 不保存');
  assert.match(String(r.reason || ''), /已被改变|保留较新文件/);
  assert.strictEqual(JSON.parse(fs.readFileSync(cookieFilePath(), 'utf-8')).length, 5, '新登录文件原样保留');
  assert.strictEqual(api.calls.cookieReads, 1, '即便冲突也只读了一次 Cookie 数组');
});

// ── R74 Root 反例：FXG 异步复验期间的 QC 漂移必须由收尾最终核对拒绝 ──

test('Root反例：FXG 第二次 evaluate 返回前 QC URL 与账户 ID 同时被改 → 收尾最终核对拒绝，saved=false，文件逐字节不变', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({
    onFxgProbe: async (a, n) => {
      if (n >= 2) {
        a.state.qcUrl = `${QC_HOME}?aavid=${OTHER_ACCOUNT}`;
        a.state.qcObs = { accountId: OTHER_ACCOUNT, accountName: QC_ALIAS, candidates: 1, unique: true, loginVisible: false };
      }
    },
  });
  assertZeroWrite(before, await runCheckpoint(api), /最终新鲜核对失败|导航漂移|复验/);
  assert.strictEqual(api.calls.cookieReads, 1, '收尾只复验：绝不第二次读取 Cookie 数组');
});

test('收尾反例变体：FXG 复验期间仅 QC 可见账户 ID 漂移（URL 未变）→ 冻结 ID 最终核对拒绝，零写入', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({
    onFxgProbe: async (a, n) => {
      if (n >= 2) {
        a.state.qcObs = { accountId: OTHER_ACCOUNT, accountName: QC_ALIAS, candidates: 1, unique: true, loginVisible: false };
      }
    },
  });
  assertZeroWrite(before, await runCheckpoint(api), /最终新鲜核对失败|复验/);
  assert.strictEqual(api.calls.cookieReads, 1);
});

test('收尾反例变体：最终 QC 核对 evaluate 悬置期间 FXG 身份页被关闭 → 关闭状态漂移拒绝，零写入', async () => {
  const before = writeCookieFile(fakeCookies(3)) && fs.readFileSync(cookieFilePath());
  const api = makeDiscoverySession({
    onQcProbe: async (a, n) => {
      if (n >= 3) a.state.fxgClosed = true;
    },
  });
  assertZeroWrite(before, await runCheckpoint(api), /已关闭|复验|核对/);
  assert.strictEqual(api.calls.cookieReads, 1);
});

// ── qianchuan-reader 实际接线（真实 openQianchuanHome + browserFactory 桩）──

function makeWiringBrowser(opts = {}) {
  const calls = { cookieReads: 0, newPages: 0 };
  const state = { fxgUrl: FXG_HOME, qcUrl: QC_HOME, schoolClosed: false };
  let context = null;
  let fallbackPage = null;
  const fxgLocator = {
    count: async () => 1,
    nth() { return this; },
    first() { return this; },
    click: async () => {},
    evaluate: async () => '',
    isVisible: async () => false,
  };
  const fxgPage = {
    // R74：goto 真实更新 fake 页 URL（旧 fixture 空 goto 会掩盖"兜底覆盖 FXG 页"缺陷）
    goto: async (u) => { state.fxgUrl = String(u); },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    waitForFunction: async () => null,
    waitForURL: async () => null,
    url: () => state.fxgUrl,
    isClosed: () => false,
    context: () => context,
    getByText: () => fxgLocator,
    locator: () => ({ ...fxgLocator, count: async () => 0 }),
    evaluate: async (fn) => {
      if (/index_userName|index_headerShopName/.test(String(fn))) {
        return { name: SHOP_NAME, distinct: [SHOP_NAME], candidates: 1, unique: true, loginVisible: false };
      }
      return null;
    },
  };
  const qcPage = {
    isClosed: () => false,
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => state.qcUrl,
    context: () => context,
    evaluate: async (fn) => {
      if (/shop-name/.test(String(fn))) {
        return { accountId: ACCOUNT, accountName: QC_ALIAS, candidates: 1, unique: true, loginVisible: false };
      }
      return null;
    },
  };
  // R74 直连兜底新建的 owned QC 页：goto 真实更新自身 URL，头部身份与入口点击页同口径
  function makeFallbackPage() {
    let u = '';
    return {
      goto: async (url) => { u = String(url); },
      waitForLoadState: async () => {},
      waitForTimeout: async () => {},
      url: () => u,
      isClosed: () => false,
      context: () => context,
      evaluate: async (fn) => {
        if (/shop-name/.test(String(fn))) {
          return { accountId: ACCOUNT, accountName: QC_ALIAS, candidates: 1, unique: true, loginVisible: false };
        }
        return null;
      },
    };
  }
  const schoolPage = {
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    url: () => 'https://school.jinritemai.com/doudian/web/article/6688',
    isClosed: () => state.schoolClosed,
    close: async () => { state.schoolClosed = true; },
    context: () => context,
    evaluate: async () => null,
  };
  context = {
    // 首个 newPage = 原 FXG 主页；其后 = 兜底新建的 QC 页
    newPage: async () => {
      calls.newPages += 1;
      if (calls.newPages === 1) return fxgPage;
      fallbackPage = makeFallbackPage();
      return fallbackPage;
    },
    waitForEvent: async () => {
      if (opts.fallbackMode === 'absent') return null; // 点击已派发但无弹新标签
      if (opts.fallbackMode === 'school') return schoolPage; // 被带到 school 教程页
      return qcPage;
    },
    addCookies: async () => {},
    on() {}, off() {},
    cookies: async () => { calls.cookieReads += 1; return fakeCookies(4); },
  };
  const browser = { newContext: async () => context, close: async () => {} };
  return { browser, fxgPage, qcPage, calls, state, getContext: () => context, getFallbackPage: () => fallbackPage };
}

test('实际接线：openQianchuanHome 把同 context 原抖店页经 cookieSession 非枚举引用交给真实检查点，未知账户端到端发现并保存', async () => {
  writeCookieFile(fakeCookies(3));
  const wiring = makeWiringBrowser();
  let captured = null;
  const r = await openQianchuanHome(
    { cookieSourceDir: dir, edgePath: 'edge' },
    { cookieFile: '测试店铺R73', accountId: null, compassShopName: SHOP_NAME, name: SHOP_NAME },
    {
      browserFactory: async () => wiring.browser,
      // 捕获真实接线参数后**委托真实检查点**（不是直接函数假传参）
      sessionCheckpoint: async (args) => {
        captured = args;
        return checkpointQianchuanSessionCookies(args);
      },
    }
  );
  assert.ok(captured, '检查点确实被调用');
  assert.strictEqual(captured.cookieSession.identityPage, wiring.fxgPage, '原抖店页经 cookieSession 引用到达检查点');
  assert.strictEqual(captured.cookieSession.identityPage.context(), captured.context, '身份页属于本次会话同一 context');
  assert.strictEqual(captured.target, wiring.qcPage, '目标千川页为入口点击后的 QC 页');
  assert.strictEqual(r.cookieSession.identityPage, wiring.fxgPage);
  assert.ok(!Object.keys(r.cookieSession).includes('identityPage'), 'identityPage 非枚举：不出现在可枚举键');
  assert.ok(!JSON.stringify(r.cookieSession).includes('identityPage'), 'identityPage 非枚举：不进入 JSON 序列化');
  assert.strictEqual(r.cookieCheckpoint.saved, true, '未知账户经真实接线自动发现并保存');
  assert.strictEqual(r.cookieCheckpoint.discoveredAccountId, ACCOUNT);
  assert.strictEqual(r.cookieCheckpoint.fingerprintAdvanced, true);
  assert.strictEqual(wiring.calls.cookieReads, 1, '接线链路 Cookie 数组恰好只读一次');
  assert.strictEqual(JSON.parse(fs.readFileSync(cookieFilePath(), 'utf-8')).length, 4, '真实写盘为刷新后的 owned 集合');
});

test('实际接线：显式 accountId 店铺旧链端到端不变（保存成功、无发现字段）', async () => {
  writeCookieFile(fakeCookies(3));
  const wiring = makeWiringBrowser();
  const r = await openQianchuanHome(
    { cookieSourceDir: dir, edgePath: 'edge' },
    { cookieFile: '测试店铺R73', accountId: ACCOUNT },
    { browserFactory: async () => wiring.browser }
  );
  assert.strictEqual(r.cookieCheckpoint.saved, true);
  assert.strictEqual(r.cookieCheckpoint.fingerprintAdvanced, true);
  assert.strictEqual(r.cookieCheckpoint.discoveredAccountId, undefined);
  assert.strictEqual(JSON.parse(fs.readFileSync(cookieFilePath(), 'utf-8')).length, 4);
});

// ── R74 Root 反例接线：直连兜底不得覆盖原 FXG 身份页 ────────────────

async function runFallbackWiring(fallbackMode, shopOver = {}) {
  writeCookieFile(fakeCookies(3));
  const wiring = makeWiringBrowser({ fallbackMode });
  let captured = null;
  const r = await openQianchuanHome(
    { cookieSourceDir: dir, edgePath: 'edge' },
    { cookieFile: '测试店铺R73', accountId: null, compassShopName: SHOP_NAME, name: SHOP_NAME, ...shopOver },
    {
      browserFactory: async () => wiring.browser,
      sessionCheckpoint: async (args) => {
        captured = args;
        return checkpointQianchuanSessionCookies(args);
      },
    }
  );
  return { wiring, captured, r };
}

function assertFallbackPreservesFxgIdentity(wiring, captured, r) {
  assert.strictEqual(r.navMode, 'direct-home-url');
  assert.ok(captured, '兜底路径真实调用了新检查点');
  assert.strictEqual(captured.cookieSession.identityPage, wiring.fxgPage, '原 FXG 身份页未被兜底导航覆盖');
  assert.strictEqual(captured.target, wiring.getFallbackPage(), '目标是兜底新建的 owned QC 页');
  assert.notStrictEqual(captured.target, wiring.fxgPage);
  assert.strictEqual(isVerifiedDoudianIdentityUrl(wiring.fxgPage.url()), true, 'FXG 页仍停在可信身份地址（FXG header 保持）');
  assert.strictEqual(r.cookieCheckpoint.saved, true, '未知账户经兜底路径也能自动发现并保存');
  assert.strictEqual(r.cookieCheckpoint.discoveredAccountId, ACCOUNT);
  assert.strictEqual(r.cookieCheckpoint.fingerprintAdvanced, true);
  assert.strictEqual(wiring.calls.cookieReads, 1, '兜底链路 Cookie 数组恰好只读一次');
  assert.strictEqual(JSON.parse(fs.readFileSync(cookieFilePath(), 'utf-8')).length, 4, '真实写盘为刷新后的 owned 集合');
}

test('Root反例接线（native popup 不存在）：兜底新建 QC 页、FXG header 保持，未知账户端到端保存', async () => {
  const { wiring, captured, r } = await runFallbackWiring('absent');
  assertFallbackPreservesFxgIdentity(wiring, captured, r);
  assert.strictEqual(captured.target.url(), QC_HOME, '未知账户兜底 URL 不带账户ID（通用 /home）');
});

test('Root反例接线（点击被带到 school 教程链接）：兜底新建 QC 页、FXG header 保持，未知账户端到端保存', async () => {
  const { wiring, captured, r } = await runFallbackWiring('school');
  assertFallbackPreservesFxgIdentity(wiring, captured, r);
  assert.strictEqual(captured.target.url(), QC_HOME, '未知账户兜底 URL 不带账户ID（通用 /home）');
  assert.strictEqual(wiring.state.schoolClosed, true, '非千川残留标签按原错误分类保守关闭');
});

test('兜底 URL 语义保持：已知 accountId 店铺直连兜底带 ?aavid 精确直连，旧链保存不变', async () => {
  const { wiring, captured, r } = await runFallbackWiring('school', { accountId: ACCOUNT });
  assert.strictEqual(r.navMode, 'direct-home-url');
  assert.strictEqual(captured.target, wiring.getFallbackPage());
  assert.strictEqual(captured.target.url(), `${QC_HOME}?aavid=${ACCOUNT}`, '已知账户兜底 URL 带 aavid（语义不变）');
  assert.strictEqual(captured.cookieSession.identityPage, wiring.fxgPage);
  assert.strictEqual(r.cookieCheckpoint.saved, true);
  assert.strictEqual(r.cookieCheckpoint.discoveredAccountId, undefined, '显式账户不产生发现字段');
  assert.strictEqual(JSON.parse(fs.readFileSync(cookieFilePath(), 'utf-8')).length, 4);
});
