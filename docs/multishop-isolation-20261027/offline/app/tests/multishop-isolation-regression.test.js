'use strict';

/**
 * MULTISHOP-ISOLATION-20261027 回归：分析器店铺名 → Cookie 文件不得跨店借用，
 * 以及 D3 恢复链进程置换/成功标记/基线推进/店铺绑定修复。
 *
 * D2 语义（保留）：显式指定的店铺名（普通或乱码）只认自己的精确文件——存在 → exact；
 * 缺失 → missing-exact（cookiePath 保持本店精确路径，绝不指向其他店铺文件）。
 * 未指定店铺名 → default.json（行为不变）。
 * D3 移除 ensureExplicitShopCookieFile 启动前阻断：它挡住了"普通精确文件缺失/损坏
 * 时从本店只读归档恢复工作副本"的既有四层恢复路径（A 缺失绝不借用 B，但 A 仍可
 * 从 A 自救）；缺失的 A 现在如实 missing-exact 并进入既有恢复链。
 * D3 修复 main 恢复成功后的三处缺陷：
 *  1. 恢复提升后仍在旧失败浏览器/上下文重试登录（违反每 Cookie 独立进程）——
 *     replaceAnalyzerSessionAfterRestore 先证明旧进程 close 成功且 isConnected 为假，
 *     再启动全新主分析浏览器（同启动参数/视口，无 storageState/localStorage 迁移）；
 *     关闭失败零新启动；新上下文失败时关闭 owned 新浏览器。
 *  2. 恢复成功但 loginSuccess 未置位 → 误报 COOKIE_EXPIRED。现在仅当置换后
 *     新会话的既有登录检测真实通过才置 loginSuccess=true。
 *  3. startFingerprint/candidateCookies 停留在旧失败文件 → 检查点 CAS 误拒
 *     自己刚提升的工作副本。readAnalysisBaseline 在提升后从本店已提升文件重建基线。
 *  4. 观察店铺与请求店铺不一致时（shopNamesMatch）必须停止：不得把观察到的
 *     错误店铺当成期望店铺做检查点/罗盘读写。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  resolveAnalyzerCookiePath,
  shopNamesMatch,
  readAnalysisBaseline,
  replaceAnalyzerSessionAfterRestore,
  waitForAnalyzerHomepage,
  gotoAnalyzerLoginPage,
  applyAnalyzerRestoreHandoff,
} = require('../douyin-shop-analyzer');
const vault = require('../cookie-vault');
const {
  restoreAnalysisWorkCopy,
  MAX_RESTORE_CANDIDATES,
} = require('../analyzer-cookie-workcopy');

const SHOPS = ['甲店旗舰店', '甲店专卖店', '乙店企业店'];

function makeCookieDir(shops, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multishop-iso-'));
  for (const name of shops) {
    // 只写非敏感占位结构（无任何真实 Cookie 值），仅用于文件名解析测试
    fs.writeFileSync(path.join(dir, name + '.json'), content || '[]', 'utf8');
  }
  return dir;
}

// 模拟 chromium：记录事件顺序（close/launch/new-context/new-page），
// 可注入 close 失败、"close 后仍 connected"、newContext/newPage 失败。
function makeMockChromium(log) {
  return {
    launch: async () => {
      log.push('launch');
      const b = {
        connected: true,
        closeError: null,
        closeStaysConnected: false,
        contextError: null,
        pageError: null,
        isConnected: () => b.connected,
        close: async () => {
          if (b.closeError) { log.push('close-error'); throw b.closeError; }
          log.push('close');
          if (!b.closeStaysConnected) b.connected = false;
        },
        newContext: async (co) => {
          if (b.contextError) throw b.contextError;
          log.push('new-context');
          return {
            ownerBrowser: b,
            contextOptions: co,
            newPage: async () => {
              if (b.pageError) throw b.pageError;
              log.push('new-page');
              return { bringToFront: async () => {}, evaluate: async () => {} };
            },
          };
        },
      };
      return b;
    },
  };
}

const LAUNCH_OPTS = { headless: true, args: ['--window-size=1920,1080'] };
const CTX_OPTS = { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 };

test('精确命中：返回本店文件，路径不变（三店交错解析互不串扰）', () => {
  const dir = makeCookieDir(SHOPS);
  // 交错解析：A→B→C→A→C→B，每次结果都只由本店名决定，无任何共享/顺序状态
  const seen = {};
  for (const name of ['甲店旗舰店', '甲店专卖店', '乙店企业店', '甲店旗舰店', '乙店企业店', '甲店专卖店']) {
    const r = resolveAnalyzerCookiePath({ shopNameArg: name, cookiesDir: dir, fsMod: fs });
    assert.strictEqual(r.status, 'exact');
    assert.strictEqual(r.cookiePath, path.join(dir, name + '.json'));
    if (seen[name]) assert.strictEqual(seen[name], r.cookiePath);
    seen[name] = r.cookiePath;
  }
  assert.strictEqual(Object.keys(seen).length, 3);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('多店隔离核心：非乱码的精确缺失 fail-closed，绝不跨店模糊借用', () => {
  const dir = makeCookieDir(SHOPS);
  // 旧逻辑下该名与"甲店旗舰店"字符相似度 >0.3，会被跨店借用；修复后必须拒绝。
  const r = resolveAnalyzerCookiePath({ shopNameArg: '甲店新店', cookiesDir: dir, fsMod: fs });
  assert.strictEqual(r.status, 'missing-exact');
  assert.strictEqual(r.cookiePath, path.join(dir, '甲店新店.json'));
  for (const name of SHOPS) {
    assert.notStrictEqual(r.cookiePath, path.join(dir, name + '.json'),
      `不得把 ${name} 的 Cookie 文件当目标店铺使用`);
  }
  assert.strictEqual(typeof r.cookieFiles, 'number');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('删除A店文件后：A 必须缺失，绝不能顺势选中 B/C', () => {
  const dir = makeCookieDir(SHOPS);
  fs.rmSync(path.join(dir, '甲店旗舰店.json'));
  const r = resolveAnalyzerCookiePath({ shopNameArg: '甲店旗舰店', cookiesDir: dir, fsMod: fs });
  assert.strictEqual(r.status, 'missing-exact');
  assert.strictEqual(r.cookiePath, path.join(dir, '甲店旗舰店.json'));
  for (const other of ['甲店专卖店', '乙店企业店']) {
    assert.notStrictEqual(r.cookiePath, path.join(dir, other + '.json'));
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('乱码名（U+FFFD）同样禁止借用：多文件与单文件目录都不猜', () => {
  // 多文件目录：旧逻辑会相似度命中"甲店旗舰店"（fuzzy-garbled），D2 起必须缺失。
  const dir = makeCookieDir(SHOPS);
  const garbled = resolveAnalyzerCookiePath({
    shopNameArg: '甲\uFFFD旗\uFFFD店', cookiesDir: dir, fsMod: fs,
  });
  assert.strictEqual(garbled.status, 'missing-exact');
  assert.strictEqual(garbled.cookiePath, path.join(dir, '甲\uFFFD旗\uFFFD店.json'));
  for (const name of SHOPS) {
    assert.notStrictEqual(garbled.cookiePath, path.join(dir, name + '.json'),
      `乱码名不得借用 ${name} 的 Cookie 文件`);
  }
  fs.rmSync(dir, { recursive: true, force: true });

  // 单文件目录：旧逻辑会直接使用唯一文件（single-file-garbled），D2 起同样必须缺失。
  const single = makeCookieDir(['唯一店铺']);
  const one = resolveAnalyzerCookiePath({
    shopNameArg: '唯\uFFFD一店\uFFFD铺', cookiesDir: single, fsMod: fs,
  });
  assert.strictEqual(one.status, 'missing-exact');
  assert.strictEqual(one.cookiePath, path.join(single, '唯\uFFFD一店\uFFFD铺.json'));
  assert.notStrictEqual(one.cookiePath, path.join(single, '唯一店铺.json'));
  fs.rmSync(single, { recursive: true, force: true });
});

test('目录不可读：如实 list-failed，不猜任何文件', () => {
  const r = resolveAnalyzerCookiePath({
    shopNameArg: '甲店旗舰店',
    cookiesDir: path.join(os.tmpdir(), 'multishop-iso-not-exist-' + Date.now()),
    fsMod: fs,
  });
  assert.strictEqual(r.status, 'list-failed');
  fs.rmSync(path.dirname(r.cookiePath), { recursive: true, force: true });
});

test('未指定店铺名：default.json 兼容不变', () => {
  const dir = makeCookieDir(SHOPS);
  const r = resolveAnalyzerCookiePath({ shopNameArg: '', cookiesDir: dir, fsMod: fs });
  assert.strictEqual(r.status, 'default');
  assert.strictEqual(r.cookiePath, path.join(dir, 'default.json'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ============ D3：启动前阻断已移除（不得挡住同店只读恢复自救） ============

test('D3：ensureExplicitShopCookieFile 已整体移除（函数/导出/调用点）', () => {
  const analyzer = require('../douyin-shop-analyzer');
  assert.strictEqual(analyzer.ensureExplicitShopCookieFile, undefined,
    'D2 的启动前阻断会阻止“普通精确文件缺失/损坏 → 从本店只读归档恢复”的既有路径');
  const src = fs.readFileSync(path.join(__dirname, '..', 'douyin-shop-analyzer.js'), 'utf8');
  assert.ok(!src.includes('ensureExplicitShopCookieFile'),
    '不得残留函数定义或调用点');
});

test('D3：普通文件缺失/损坏不启动前抛错——A 缺/坏仍指向 A 自己的路径，恢复链可自救', () => {
  const dir = makeCookieDir(SHOPS);
  // 缺失：只报状态，不抛、不借 B/C
  const missing = resolveAnalyzerCookiePath({ shopNameArg: '甲店旗舰店', cookiesDir: dir, fsMod: fs });
  fs.rmSync(path.join(dir, '甲店旗舰店.json'));
  const r = resolveAnalyzerCookiePath({ shopNameArg: '甲店旗舰店', cookiesDir: dir, fsMod: fs });
  assert.strictEqual(r.status, 'missing-exact');
  assert.strictEqual(r.cookiePath, path.join(dir, '甲店旗舰店.json'));
  assert.strictEqual(r.cookiePath, missing.cookiePath, '删除前后目标路径保持本店精确路径');
  for (const other of ['甲店专卖店', '乙店企业店']) {
    assert.notStrictEqual(r.cookiePath, path.join(dir, other + '.json'));
  }
  // 损坏（非 JSON）：同样不做启动前阻断，由既有恢复链处理
  fs.writeFileSync(path.join(dir, '甲店旗舰店.json'), '{坏掉的内容', 'utf8');
  const bad = resolveAnalyzerCookiePath({ shopNameArg: '甲店旗舰店', cookiesDir: dir, fsMod: fs });
  assert.strictEqual(bad.status, 'exact');
  assert.strictEqual(bad.cookiePath, path.join(dir, '甲店旗舰店.json'));
  fs.rmSync(dir, { recursive: true, force: true });
});

// ============ D3：恢复链成功后的会话置换（独立进程契约） ============

test('D3 置换：旧浏览器先证明关闭（close 且 isConnected=false）再启动新进程', async () => {
  const log = [];
  const chromiumMod = makeMockChromium(log);
  const oldBrowser = await chromiumMod.launch(LAUNCH_OPTS);
  log.length = 0;
  const fresh = await replaceAnalyzerSessionAfterRestore({
    oldBrowser, launchOptions: LAUNCH_OPTS, contextOptions: CTX_OPTS, chromiumMod,
  });
  // 顺序契约：close → launch → new-context → new-page；不存在任何"先启动后关闭"的重叠
  assert.deepStrictEqual(log, ['close', 'launch', 'new-context', 'new-page']);
  assert.strictEqual(oldBrowser.isConnected(), false, '旧进程必须已关闭');
  assert.ok(fresh.browser !== oldBrowser, '新会话必须是全新进程');
  assert.strictEqual(fresh.context.ownerBrowser, fresh.browser, 'context 只属于新浏览器');
  // 不迁移任何旧 storageState/localStorage：新 context 只带视口配置
  assert.deepStrictEqual(fresh.context.contextOptions, CTX_OPTS);
  assert.strictEqual('storageState' in fresh.context.contextOptions, false);
});

test('D3 置换：旧进程 close 抛错 → 拒绝并零新启动（不 force kill、不重叠进程）', async () => {
  const log = [];
  const chromiumMod = makeMockChromium(log);
  const oldBrowser = await chromiumMod.launch(LAUNCH_OPTS);
  oldBrowser.closeError = new Error('close failed');
  log.length = 0;
  await assert.rejects(
    () => replaceAnalyzerSessionAfterRestore({
      oldBrowser, launchOptions: LAUNCH_OPTS, contextOptions: CTX_OPTS, chromiumMod,
    }),
    (e) => e.message.includes('关闭旧分析浏览器失败'),
  );
  assert.ok(!log.includes('launch'), '关闭失败时绝不能启动新进程');
});

test('D3 置换：close 后 isConnected 仍 true → 拒绝并零新启动', async () => {
  const log = [];
  const chromiumMod = makeMockChromium(log);
  const oldBrowser = await chromiumMod.launch(LAUNCH_OPTS);
  oldBrowser.closeStaysConnected = true;
  log.length = 0;
  await assert.rejects(
    () => replaceAnalyzerSessionAfterRestore({
      oldBrowser, launchOptions: LAUNCH_OPTS, contextOptions: CTX_OPTS, chromiumMod,
    }),
    (e) => e.message.includes('isConnected 仍为 true'),
  );
  assert.ok(!log.includes('launch'));
});

test('D3 置换：新 context 建立失败 → 关闭 owned 新浏览器并抛错', async () => {
  const log = [];
  const chromiumMod = makeMockChromium(log);
  const oldBrowser = await chromiumMod.launch(LAUNCH_OPTS);
  log.length = 0;
  const realLaunch = chromiumMod.launch;
  chromiumMod.launch = async (opts) => {
    const b = await realLaunch(opts);
    b.contextError = new Error('newContext failed');
    return b;
  };
  await assert.rejects(
    () => replaceAnalyzerSessionAfterRestore({
      oldBrowser, launchOptions: LAUNCH_OPTS, contextOptions: CTX_OPTS, chromiumMod,
    }),
    (e) => e.message.includes('新建分析上下文失败'),
  );
  assert.deepStrictEqual(log, ['close', 'launch', 'close'], '失败后必须回收 owned 新浏览器');
});

test('D3 置换：新 page 建立失败 → 同样关闭 owned 新浏览器并抛错', async () => {
  const log = [];
  const chromiumMod = makeMockChromium(log);
  const oldBrowser = await chromiumMod.launch(LAUNCH_OPTS);
  log.length = 0;
  const realLaunch = chromiumMod.launch;
  chromiumMod.launch = async (opts) => {
    const b = await realLaunch(opts);
    b.pageError = new Error('newPage failed');
    return b;
  };
  await assert.rejects(
    () => replaceAnalyzerSessionAfterRestore({
      oldBrowser, launchOptions: LAUNCH_OPTS, contextOptions: CTX_OPTS, chromiumMod,
    }),
    (e) => e.message.includes('新建分析上下文失败'),
  );
  assert.deepStrictEqual(log, ['close', 'launch', 'new-context', 'close']);
});

test('D3 置换：latest 所有权——再次置换时关闭的是“当前最新 owned”浏览器', async () => {
  const log = [];
  const chromiumMod = makeMockChromium(log);
  const first = await replaceAnalyzerSessionAfterRestore({
    oldBrowser: await chromiumMod.launch(LAUNCH_OPTS),
    launchOptions: LAUNCH_OPTS, contextOptions: CTX_OPTS, chromiumMod,
  });
  log.length = 0;
  const second = await replaceAnalyzerSessionAfterRestore({
    oldBrowser: first.browser,
    launchOptions: LAUNCH_OPTS, contextOptions: CTX_OPTS, chromiumMod,
  });
  assert.strictEqual(first.browser.isConnected(), false);
  assert.deepStrictEqual(log, ['close', 'launch', 'new-context', 'new-page']);
  assert.strictEqual(second.context.ownerBrowser, second.browser);
  // main 的 let browser/context/page 语义：finally 关闭的是最新 owned 进程
  let browser = first.browser;
  browser = second.browser;
  assert.strictEqual(browser, second.browser);
});

// ============ D3：恢复后基线推进（指纹/候选不再停留在旧失败文件） ============

test('D3 基线：提升后的基线取自本店已提升工作副本，而非旧失败文件', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multishop-iso-baseline-'));
  const workPath = path.join(dir, '甲店旗舰店.json');
  const oldJson = '[{"name":"old","value":"v","domain":".jinritemai.com","path":"/"}]';
  const promotedJson = '[{"name":"new","value":"v2","domain":".jinritemai.com","path":"/"}]';
  fs.writeFileSync(workPath, oldJson, 'utf8');
  const before = readAnalysisBaseline(workPath, fs);
  // 模拟恢复链 CAS 提升：同一路径内容被替换为本店只读归档恢复出的新副本
  fs.writeFileSync(workPath, promotedJson, 'utf8');
  const after = readAnalysisBaseline(workPath, fs);
  assert.notDeepStrictEqual(after, before, '基线必须随提升推进');
  assert.ok(after.startFingerprint && after.startFingerprint !== before.startFingerprint);
  assert.deepStrictEqual(after.candidateCookies, JSON.parse(promotedJson));
  // 缺失/损坏：候选为空、指纹为 absent，不抛（既有保守语义不变）
  fs.rmSync(workPath);
  const absent = readAnalysisBaseline(workPath, fs);
  assert.strictEqual(absent.candidateCookies, null);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ============ D3：店铺绑定（观察店铺 ≠ 请求店铺必须停止） ============

test('D3 店铺绑定：错误观察店铺判不匹配，同店与既有拼写兼容判匹配', () => {
  // 请求甲店旗舰，页面观察到乙店 → 不匹配（绝不把 B 当 A 的期望店铺）
  assert.strictEqual(shopNamesMatch('乙店企业店', '甲店旗舰店'), false);
  // 同名匹配；含文件名不安全字符时按既有安全替换归一后匹配
  assert.strictEqual(shopNamesMatch('甲店旗舰店', '甲店旗舰店'), true);
  assert.strictEqual(shopNamesMatch('甲店/旗舰*店', '甲店_旗舰_店'), true);
  // 既有 瑮→瑾 修正保持兼容（页面常见错字）
  assert.strictEqual(shopNamesMatch('甲瑮旗舰店', '甲瑾旗舰店'), true);
  // 去首尾空白后匹配；任一侧为空 → 不匹配（不得用空观察顶替校验）
  assert.strictEqual(shopNamesMatch(' 甲店旗舰店 ', '甲店旗舰店'), true);
  assert.strictEqual(shopNamesMatch('', '甲店旗舰店'), false);
  assert.strictEqual(shopNamesMatch('甲店旗舰店', ''), false);
});

test('D3 店铺绑定：main 源码在不一致分支停止（不跑检查点/罗盘/写入；D4 起也不再报 Cookie 过期）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'douyin-shop-analyzer.js'), 'utf8');
  assert.ok(src.includes('shopNamesMatch(shopName, shopNameArg)'),
    '登录后必须用观察店铺与请求店铺做绑定校验');
  assert.ok(src.includes('shopMismatchStop'),
    '不一致时必须置停止标记，finally 不再用错误店铺身份写罗盘收尾检查点');
  // D4：错店观察 ≠ Cookie 过期——不一致分支不得写 cookie_expired.txt、不得发 COOKIE_EXPIRED。
  // D5A：只检查可执行语句（先去掉注释），否则解释性注释里出现的“cookie_expired.txt /
  // COOKIE_EXPIRED”会被误当成真实副作用（D4 曾据此假失败）。
  const branch = src.slice(src.indexOf('shopNamesMatch(shopName, shopNameArg)'), src.indexOf('{ shopMismatch: true }'));
  assert.ok(branch.length > 0, '必须存在结构化 shopMismatch 结果分支');
  const branchCode = branch
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(!/writeFileSync\s*\([^)]*cookie_expired\.txt/.test(branchCode),
    '错店分支不得写过期标记文件');
  assert.ok(!/console\.(log|error)\s*\(\s*[`'"]COOKIE_EXPIRED/.test(branchCode),
    '错店分支不得发 COOKIE_EXPIRED 信号（会误触上游过期重试流程）');
  assert.ok(branchCode.includes('RESULT:${JSON.stringify('),
    '错店分支仍必须发结构化 RESULT（实际代码语句，不是注释）');
  assert.ok(!branchCode.includes('waitForQRCodeLogin'), '错店分支不得启动扫码登录');
  assert.ok(src.includes("{ shopMismatch: true }"), '错店分支仍必须发结构化 shopMismatch 结果');
  assert.ok(src.includes('if (!shopMismatchStop)'), 'finally 必须跳过错误店铺身份的收尾检查点');
  // 恢复成功路径的三个 D3 修复点在 main 实际接线（D5A 起收口到交接 helper，main 调用它）
  assert.ok(src.includes('replaceAnalyzerSessionAfterRestore({'), '恢复成功后必须置换独立新进程');
  assert.ok(src.includes('applyAnalyzerRestoreHandoff({'), 'main 必须调用交接 helper');
  assert.ok(src.includes('readAnalysisBaseline(o.cookiePath, fsm)'), '提升后必须重建加载前基线');
  assert.ok(src.includes('startFingerprint = handoff.startFingerprint;')
    && src.includes('candidateCookies = handoff.candidateCookies;'),
    '基线必须推进到已提升工作副本（而非停留在旧失败文件）');
  assert.ok(src.includes('恢复链置换新进程后Cookie有效'), '仅新会话登录检测真实通过才置 loginSuccess');
});

// ============ D4：恢复链候选饥饿修复（app 侧 legacy 回退窗口） ============

// 合成 Cookie 数组（占位值，非真实凭证；满足 vault.validateCookieStructure 的域校验）
function fakeCookies(tag) {
  return [
    { name: 'sessionid', value: `FAKE-${tag}-NOT-A-REAL-COOKIE`, domain: '.jinritemai.com', path: '/' },
    { name: 'sid_guard', value: `FAKE-${tag}-GUARD`, domain: '.jinritemai.com', path: '/' },
  ];
}

function snapshotDirTree(rootDir) {
  const out = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d)) {
      const p = path.join(d, f);
      const st = fs.lstatSync(p);
      if (st.isDirectory()) walk(p);
      else out.push(`${p}|${vault.sha256Of(fs.readFileSync(p))}`);
    }
  };
  walk(rootDir);
  return out.sort();
}

async function makeD4Root() {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'multishop-iso-d4-'));
  const roots = vault.defaultRoots({ appRoot });
  fs.mkdirSync(roots.analyzerWorkDir, { recursive: true });
  return { appRoot, roots };
}

test('D4 恢复（app）：首选归档 3 条失效后 legacy 回退被试到并提升，归档零写入', async () => {
  const { appRoot, roots } = await makeD4Root();
  try {
    // 归档：3 条 verified-login（首选窗口，MAX_RESTORE_CANDIDATES-1=3）+ 1 条 legacy（回退窗口）
    const nowBase = Date.UTC(2026, 9, 27, 2, 0, 0);
    for (let i = 0; i < 3; i += 1) {
      const r = vault.createRawSnapshot({
        shopSafeName: 'shopA', cookies: fakeCookies('n' + i), roots, fsModule: fs,
        nowFn: () => nowBase + i * 60000,
      });
      assert.strictEqual(r.ok, true);
    }
    const legacy = vault.archiveLegacyBytes({
      shopSafeName: 'shopA', buf: Buffer.from(JSON.stringify(fakeCookies('legacyOK'))),
      roots, fsModule: fs, nowFn: () => nowBase + 10 * 60000,
    });
    assert.strictEqual(legacy.ok, true);
    const archiveBefore = snapshotDirTree(roots.archiveRoot);

    const workPath = path.join(roots.analyzerWorkDir, 'shopA.json');
    const verifyCalls = [];
    const verify = async (p) => {
      verifyCalls.push(p.source);
      if (p.source !== `raw-archive:${legacy.versionId}`) {
        return { ok: false, reason: '合成失效' };
      }
      return { ok: true, finalCookies: fakeCookies('legacyOK') };
    };
    const r = await restoreAnalysisWorkCopy({ workPath, roots, verify, fsModule: fs, nowFn: () => nowBase });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.source, `raw-archive:${legacy.versionId}`);
    // 工作副本缺失 → 候选即 3 条首选 + 1 条 legacy；顺序：首选（新→旧）在前，legacy 最后
    assert.strictEqual(verifyCalls.length, 4);
    assert.strictEqual(verifyCalls[verifyCalls.length - 1], `raw-archive:${legacy.versionId}`);
    for (let i = 0; i < 3; i += 1) assert.ok(verifyCalls[i] !== `raw-archive:${legacy.versionId}`);
    // 提升的是验证 context 最终集合的序列化字节，落在自己的分析工作副本
    const promoted = JSON.parse(fs.readFileSync(workPath, 'utf8'));
    assert.deepStrictEqual(promoted, fakeCookies('legacyOK'));
    // 只读归档零写入（sha + 文件集合不变）
    assert.deepStrictEqual(snapshotDirTree(roots.archiveRoot), archiveBefore);
    const failed = r.attempts.filter((a) => a.result === 'verify-failed');
    assert.strictEqual(failed.length, 3, '失败计数必须如实覆盖两个窗口');
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test('D4 恢复（app）：首选第一条即成功 → 不再验证 legacy 回退', async () => {
  const { appRoot, roots } = await makeD4Root();
  try {
    const nowBase = Date.UTC(2026, 9, 27, 3, 0, 0);
    const good = vault.createRawSnapshot({
      shopSafeName: 'shopA', cookies: fakeCookies('goodFirst'), roots, fsModule: fs, nowFn: () => nowBase,
    });
    assert.strictEqual(good.ok, true);
    const legacy = vault.archiveLegacyBytes({
      shopSafeName: 'shopA', buf: Buffer.from(JSON.stringify(fakeCookies('neverTried'))),
      roots, fsModule: fs, nowFn: () => nowBase + 600000,
    });
    assert.strictEqual(legacy.ok, true);
    const verifyCalls = [];
    const verify = async (p) => {
      verifyCalls.push(p.source);
      if (p.source === `raw-archive:${good.versionId}`) return { ok: true, finalCookies: fakeCookies('goodFirst') };
      return { ok: false, reason: '不应被验证（合成）' };
    };
    const r = await restoreAnalysisWorkCopy({
      workPath: path.join(roots.analyzerWorkDir, 'shopA.json'),
      roots, verify, fsModule: fs, nowFn: () => nowBase,
    });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(verifyCalls, [`raw-archive:${good.versionId}`], '首选成功后不得再验证 legacy');
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test('D4 恢复（app）：首选 stopChain 立即停止 → legacy 回退不再启动、零写入', async () => {
  const { appRoot, roots } = await makeD4Root();
  try {
    const nowBase = Date.UTC(2026, 9, 27, 4, 0, 0);
    const first = vault.createRawSnapshot({
      shopSafeName: 'shopA', cookies: fakeCookies('s1'), roots, fsModule: fs, nowFn: () => nowBase,
    });
    assert.strictEqual(first.ok, true);
    const legacy = vault.archiveLegacyBytes({
      shopSafeName: 'shopA', buf: Buffer.from(JSON.stringify(fakeCookies('gStop'))),
      roots, fsModule: fs, nowFn: () => nowBase + 600000,
    });
    assert.strictEqual(legacy.ok, true);
    const verifyCalls = [];
    const verify = async (p) => {
      verifyCalls.push(p.source);
      return { ok: false, stopChain: true, reason: '合成：候选进程关闭未获证明' };
    };
    const workPath = path.join(roots.analyzerWorkDir, 'shopA.json');
    const r = await restoreAnalysisWorkCopy({ workPath, roots, verify, fsModule: fs, nowFn: () => nowBase });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(verifyCalls.length, 1, 'stopChain 必须立即终止全部窗口');
    assert.ok(r.attempts.some((a) => a.result === 'verify-aborted'));
    assert.ok(!fs.existsSync(workPath), '停止链绝不提升/写入');
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test('D4 恢复（app）：含 legacy 在内全部失效 → 工作副本基线字节保持不变', async () => {
  const { appRoot, roots } = await makeD4Root();
  try {
    const nowBase = Date.UTC(2026, 9, 27, 5, 0, 0);
    for (let i = 0; i < 3; i += 1) {
      vault.createRawSnapshot({
        shopSafeName: 'shopA', cookies: fakeCookies('allBad' + i), roots, fsModule: fs,
        nowFn: () => nowBase + i * 60000,
      });
    }
    vault.archiveLegacyBytes({
      shopSafeName: 'shopA', buf: Buffer.from(JSON.stringify(fakeCookies('legacyBad'))),
      roots, fsModule: fs, nowFn: () => nowBase + 600000,
    });
    const workPath = path.join(roots.analyzerWorkDir, 'shopA.json');
    const original = Buffer.from(JSON.stringify(fakeCookies('baseline'), null, 2), 'utf8');
    fs.writeFileSync(workPath, original);
    const verify = async () => ({ ok: false, reason: '合成失效' });
    const r = await restoreAnalysisWorkCopy({ workPath, roots, verify, fsModule: fs, nowFn: () => nowBase });
    assert.strictEqual(r.ok, false);
    assert.deepStrictEqual(fs.readFileSync(workPath), original, '全部失败时工作副本保持现状');
    // 汇总如实覆盖两个窗口（工作副本候选 + 3 首选 + 1 legacy = 5 次验证）
    assert.ok(r.reason.includes('验证调用 5 次'), `失败汇总必须如实覆盖两个窗口: ${r.reason}`);
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

test('D4 恢复（app）：超过窗口宽度的 legacy 不再被首选窗口挤为零，也不会无限读档', async () => {
  const { appRoot, roots } = await makeD4Root();
  try {
    const nowBase = Date.UTC(2026, 9, 27, 6, 0, 0);
    // 5 条非 legacy（> 首选窗口 3）+ 5 条 legacy（= 全部入档量，验证有界）
    for (let i = 0; i < 5; i += 1) {
      vault.createRawSnapshot({
        shopSafeName: 'shopA', cookies: fakeCookies('many' + i), roots, fsModule: fs,
        nowFn: () => nowBase + i * 60000,
      });
    }
    const legacyIds = [];
    for (let i = 0; i < 5; i += 1) {
      const r = vault.archiveLegacyBytes({
        shopSafeName: 'shopA', buf: Buffer.from(JSON.stringify(fakeCookies('legacyMany' + i))),
        roots, fsModule: fs, nowFn: () => nowBase + 10 * 60000 + i * 60000,
      });
      legacyIds.push(r.versionId);
    }
    const verifyCalls = [];
    const verify = async (p) => { verifyCalls.push(p.source); return { ok: false, reason: '合成失效' }; };
    await restoreAnalysisWorkCopy({
      workPath: path.join(roots.analyzerWorkDir, 'shopA.json'),
      roots, verify, fsModule: fs, nowFn: () => nowBase,
    });
    // 有界两窗口：工作副本缺失 → 3 首选 + 3 legacy 回退 = 6 次，绝不全量读档
    assert.strictEqual(verifyCalls.length, 2 * (MAX_RESTORE_CANDIDATES - 1));
    const legacyTried = verifyCalls.filter((s) => legacyIds.includes(s.slice('raw-archive:'.length)));
    assert.strictEqual(legacyTried.length, MAX_RESTORE_CANDIDATES - 1, 'legacy 回退必须真的被试到');
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true });
  }
});

// ============ D5A：被动等待“受信抖店首页”落定（45s 上限 / 3s 间隔） ============

const TRUSTED_HOME = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const LOGIN_REDIRECT_URL = 'https://passport.jinritemai.com/login?redirect=%2Fffa%2Fmshop';

function makeFakeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    advance(ms) { t += ms; },
    sleep: async (ms) => { t += ms; },
  };
}

// 只读 page 形态：url() 由假时钟决定返回地址（不导航、不点击）。
function makeUrlPage(clock, urlFn, opts = {}) {
  return {
    closed: !!opts.closed,
    isClosed() { return this.closed; },
    url() {
      if (this.closed) throw new Error('Target page, context or browser has been closed');
      return urlFn(clock.now());
    },
  };
}

test('D5A 被动等待：重定向中介 15/30 秒后进入受信首页 → 应判定成功', async () => {
  for (const homeAt of [15000, 30000]) {
    const clock = makeFakeClock();
    const page = makeUrlPage(clock, (t) => (t < homeAt ? LOGIN_REDIRECT_URL : TRUSTED_HOME));
    const ok = await waitForAnalyzerHomepage(page, { nowFn: clock.now, sleep: clock.sleep });
    assert.strictEqual(ok, true, `homeAt=${homeAt} 的合法重定向必须等到首页再判成功`);
    assert.ok(clock.now() >= homeAt, '不得在重定向完成前提前判定');
    assert.ok(clock.now() <= 45000, '不得超过 45 秒上限');
  }
});

test('D5A 被动等待：已在受信首页 → 立即 true（零等待）', async () => {
  const clock = makeFakeClock();
  let sleeps = 0;
  const page = makeUrlPage(clock, () => TRUSTED_HOME);
  const ok = await waitForAnalyzerHomepage(page, {
    nowFn: clock.now,
    sleep: async (ms) => { sleeps++; clock.advance(ms); },
  });
  assert.strictEqual(ok, true);
  assert.strictEqual(sleeps, 0, '已在首页时必须立即返回');
});

test('D5A 被动等待：45 秒仍在登录/中介地址 → 只在截止时 false（不提前判坏）', async () => {
  const clock = makeFakeClock();
  let sleeps = 0;
  const page = makeUrlPage(clock, () => LOGIN_REDIRECT_URL);
  const ok = await waitForAnalyzerHomepage(page, {
    nowFn: clock.now,
    sleep: async (ms) => { sleeps++; clock.advance(ms); },
  });
  assert.strictEqual(ok, false);
  assert.strictEqual(clock.now(), 45000, '必须用满 45 秒上限才判否');
  assert.strictEqual(sleeps, 15, '3 秒间隔 → 15 次被动等待');
});

test('D5A 被动等待：页面已关闭/不可用 → 抛普通错误，绝不伪装成 Cookie 过期', async () => {
  let sleeps = 0;
  const closed = makeUrlPage(makeFakeClock(), () => TRUSTED_HOME, { closed: true });
  await assert.rejects(
    () => waitForAnalyzerHomepage(closed, { sleep: async () => { sleeps++; } }),
    (e) => e instanceof Error
      && e.analyzerNonAuthError === true
      && !/COOKIE_EXPIRED/.test(e.message)
      && !/cookie_expired/.test(e.message),
  );
  assert.strictEqual(sleeps, 0, '页面已关闭时不得继续等待');

  await assert.rejects(
    () => waitForAnalyzerHomepage(null, { sleep: async () => {} }),
    (e) => e instanceof Error && e.analyzerNonAuthError === true,
  );
});

test('D5A 被动等待：含 homepage 字样的敌意/非受信 URL 永不 true', async () => {
  const hostile = [
    'https://evil.example/redirect?next=https%3A%2F%2Ffxg.jinritemai.com%2Fffa%2Fmshop%2Fhomepage%2Findex',
    'https://evil.example/?u=https://fxg.jinritemai.com/ffa/mshop/homepage',
    'https://fxg.jinritemai.com.evil.example/ffa/mshop/homepage/index',
    'https://fxg.jinritemai.com/ffa/mshop/homepageevil',
    'http://fxg.jinritemai.com/ffa/mshop/homepage/index',
    'javascript:https://fxg.jinritemai.com/ffa/mshop/homepage',
  ];
  for (const u of hostile) {
    const clock = makeFakeClock();
    const page = makeUrlPage(clock, () => u);
    const ok = await waitForAnalyzerHomepage(page, { nowFn: clock.now, sleep: clock.sleep });
    assert.strictEqual(ok, false, `敌意 URL 不得占用信首页: ${u}`);
    assert.strictEqual(clock.now(), 45000);
  }
});

// ============ D5A：恢复提升后的交接（真实 helper，不镜像实现） ============

function makeHandoffChromium(log, page, opts = {}) {
  return {
    launch: async () => {
      log.push('launch');
      const b = {
        connected: true,
        isConnected: () => b.connected,
        close: async () => { log.push('close'); b.connected = false; },
        newContext: async () => {
          log.push('new-context');
          if (opts.contextError) throw opts.contextError;
          return {
            newPage: async () => {
              log.push('new-page');
              if (opts.pageError) throw opts.pageError;
              return page;
            },
          };
        },
      };
      return b;
    },
  };
}

function makeOldBrowser(log) {
  return {
    isConnected: () => false,
    close: async () => { log.push('old-close'); },
  };
}

function makeHandoffPage(clock, homeAtMs) {
  return {
    closed: false,
    gotos: [],
    isClosed() { return this.closed; },
    url() { return clock.now() < homeAtMs ? LOGIN_REDIRECT_URL : TRUSTED_HOME; },
    async goto(u) { this.gotos.push(u); },
    async bringToFront() {},
    async evaluate() {},
  };
}

test('D5A 交接：恢复后被动等待约 15 秒进入受信首页 → loginSuccess=true，无过期/扫码', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multishop-iso-d5a-'));
  const cookiePath = path.join(dir, 'shopA.json');
  fs.writeFileSync(cookiePath, JSON.stringify(fakeCookies('handoff'), null, 2), 'utf8');
  const clock = makeFakeClock();
  const page = makeHandoffPage(clock, 15000);
  const log = [];
  const output = [];
  try {
    const res = await applyAnalyzerRestoreHandoff({
      oldBrowser: makeOldBrowser(log),
      launchOptions: LAUNCH_OPTS,
      contextOptions: CTX_OPTS,
      chromiumMod: makeHandoffChromium(log, page),
      cookiePath,
      fsMod: fs,
      loadCookiesFn: async () => { log.push('load-cookies'); },
      loginUrl: TRUSTED_HOME,
      nowFn: clock.now,
      sleepFn: clock.sleep,
      stdout: (s) => output.push(String(s)),
    });
    assert.strictEqual(res.isLoggedIn, true);
    assert.strictEqual(res.loginSuccess, true, '被动等待真实通过后才允许记登录成功');
    assert.ok(clock.now() >= 15000 && clock.now() <= 18000, '应在合法的 ~15 秒重定向后判定成功');
    assert.ok(res.startFingerprint, '基线必须推进到已提升工作副本');
    assert.deepStrictEqual(res.candidateCookies, fakeCookies('handoff'));
    assert.strictEqual(page.gotos.length, 1, '交接只复用既有入口 goto 一次');
    assert.deepStrictEqual(log, ['old-close', 'launch', 'new-context', 'new-page', 'load-cookies']);
    const out = output.join('\n');
    assert.ok(!out.includes('COOKIE_EXPIRED'));
    assert.ok(!out.includes('扫码'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D5A 交接：旧进程 close 失败 → 普通错误、零新启动、无过期/扫码', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multishop-iso-d5a-close-'));
  const cookiePath = path.join(dir, 'shopA.json');
  fs.writeFileSync(cookiePath, '[]', 'utf8');
  const log = [];
  const output = [];
  try {
    await assert.rejects(
      () => applyAnalyzerRestoreHandoff({
        oldBrowser: {
          isConnected: () => true,
          close: async () => { log.push('old-close-error'); throw new Error('close failed'); },
        },
        launchOptions: LAUNCH_OPTS,
        contextOptions: CTX_OPTS,
        chromiumMod: makeHandoffChromium(log, makeHandoffPage(makeFakeClock(), 0)),
        cookiePath,
        fsMod: fs,
        loadCookiesFn: async () => {},
        loginUrl: TRUSTED_HOME,
        nowFn: makeFakeClock().now,
        sleepFn: async () => {},
        stdout: (s) => output.push(String(s)),
      }),
      (e) => e instanceof Error
        && /关闭旧分析浏览器失败/.test(e.message)
        && e.analyzerNonAuthError === true
        && !/COOKIE_EXPIRED/.test(e.message),
    );
    assert.ok(!log.includes('launch'), '旧进程关闭失败时绝不能启动新进程');
    assert.ok(!output.join('').includes('COOKIE_EXPIRED'));
    assert.ok(!output.join('').includes('扫码'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D5A 交接：新 context 建立失败 → 普通错误、回收新进程、无过期', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multishop-iso-d5a-ctx-'));
  const cookiePath = path.join(dir, 'shopA.json');
  fs.writeFileSync(cookiePath, '[]', 'utf8');
  const log = [];
  const clock = makeFakeClock();
  try {
    await assert.rejects(
      () => applyAnalyzerRestoreHandoff({
        oldBrowser: makeOldBrowser(log),
        launchOptions: LAUNCH_OPTS,
        contextOptions: CTX_OPTS,
        chromiumMod: makeHandoffChromium(log, makeHandoffPage(clock, 0), { contextError: new Error('newContext failed') }),
        cookiePath,
        fsMod: fs,
        loadCookiesFn: async () => {},
        loginUrl: TRUSTED_HOME,
        nowFn: clock.now,
        sleepFn: clock.sleep,
      }),
      (e) => e instanceof Error
        && /新建分析上下文失败/.test(e.message)
        && e.analyzerNonAuthError === true
        && !/COOKIE_EXPIRED/.test(e.message),
    );
    assert.deepStrictEqual(log, ['old-close', 'launch', 'new-context', 'close'],
      '新上下文失败必须回收 owned 新浏览器');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D5A 交接：新会话 goto 资源失败 → 回收 owned 新进程并抛普通错误（无孤儿/无过期）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'multishop-iso-d5a-goto-'));
  const cookiePath = path.join(dir, 'shopA.json');
  fs.writeFileSync(cookiePath, '[]', 'utf8');
  const log = [];
  const clock = makeFakeClock();
  const page = makeHandoffPage(clock, 0);
  page.goto = async () => { throw new Error('net::ERR_CONNECTION_RESET'); };
  try {
    await assert.rejects(
      () => applyAnalyzerRestoreHandoff({
        oldBrowser: makeOldBrowser(log),
        launchOptions: LAUNCH_OPTS,
        contextOptions: CTX_OPTS,
        chromiumMod: makeHandoffChromium(log, page),
        cookiePath,
        fsMod: fs,
        loadCookiesFn: async () => {},
        loginUrl: TRUSTED_HOME,
        nowFn: clock.now,
        sleepFn: clock.sleep,
      }),
      (e) => e instanceof Error
        && e.analyzerNonAuthError === true
        && !/COOKIE_EXPIRED/.test(e.message)
        && !/扫码/.test(e.message),
    );
    assert.deepStrictEqual(log, ['old-close', 'launch', 'new-context', 'new-page', 'close'],
      'goto 失败必须回收 owned 新进程（不留孤儿浏览器）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('D5A 接线：初始与恢复交接都走被动等待，恢复异常不再被“不影响后续流程”吞掉', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'douyin-shop-analyzer.js'), 'utf8');
  assert.ok((src.match(/waitForAnalyzerHomepage\s*\(/g) || []).length >= 3,
    '定义 + 初始检测 + 恢复交接都应使用同一被动等待 helper');
  assert.ok(src.includes('waitForAnalyzerHomepage(page, { sleep: pausableSleep })'),
    '初始登录检测必须使用被动等待（pausableSleep 默认等待）');
  assert.ok(src.includes('applyAnalyzerRestoreHandoff({'),
    '恢复成功后必须走交接 helper（内部使用被动等待）');
  assert.ok(!src.includes('恢复链异常（不影响后续流程）'),
    '恢复/置换异常不得再被吞掉后落入扫码/过期分支');
  assert.ok(src.includes('suppressCookieExpiredMark'),
    '普通资源错误必须抑制 COOKIE_EXPIRED 标记');
});

// ============ D6E：初始 goto 资源失败不得判 Cookie 过期（main 与交接共用 helper） ============

test('D6E 初始导航：goto 资源失败 → 普通错误标记、消息脱敏、无 COOKIE_EXPIRED/扫码', async () => {
  const calls = [];
  const page = {
    async goto(url, options) {
      calls.push([url, options]);
      throw new Error('net::ERR_CONNECTION_RESET at https://fxg.jinritemai.com/ffa/mshop/homepage/index?token=SECRET-TOKEN-123');
    },
  };
  await assert.rejects(
    () => gotoAnalyzerLoginPage(page, TRUSTED_HOME),
    (e) => e instanceof Error
      && e.analyzerNonAuthError === true
      && /进入抖店首页失败/.test(e.message)
      && /普通资源错误/.test(e.message)
      && !/COOKIE_EXPIRED/.test(e.message)
      && !/cookie_expired/.test(e.message)
      && !/扫码/.test(e.message)
      && !/SECRET-TOKEN/.test(e.message)
      && !/https?:\/\//.test(e.message)
      && !/net::ERR_/.test(e.message),
  );
  // 既有导航契约不变：domcontentloaded / 120000，且只有一次 goto（无额外导航）
  assert.deepStrictEqual(calls, [[TRUSTED_HOME, { waitUntil: 'domcontentloaded', timeout: 120000 }]]);
});

test('D6E 接线：main 初始 goto 走统一 helper（不再裸 goto 落入 COOKIE_EXPIRED）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'douyin-shop-analyzer.js'), 'utf8');
  const mainStart = src.indexOf('async function main()');
  const mainEnd = src.indexOf('function buildAnalyzerRunResult');
  assert.ok(mainStart > 0 && mainEnd > mainStart, '必须能定位 main 与结果收口函数');
  const mainSrc = src.slice(mainStart, mainEnd);
  assert.ok(mainSrc.includes('await gotoAnalyzerLoginPage(page, CONFIG.douyin.loginUrl);'),
    'main 初始导航必须调用统一 helper');
  assert.ok(!/page\.goto\(\s*CONFIG\.douyin\.loginUrl/.test(mainSrc),
    '初始导航不得裸 goto（资源失败会未标记地落入 COOKIE_EXPIRED）');
  assert.ok(src.includes("gotoAnalyzerLoginPage(fresh.page, o.loginUrl || CONFIG.douyin.loginUrl, '恢复后进入抖店首页')"),
    '恢复交接必须复用同一导航 helper');
  assert.ok(src.includes("page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 })"),
    'helper 必须保持既有 domcontentloaded/120000 导航契约');
  // 标记 → main 的 catch/finally 抑制过期标记（既有 suppressCookieExpiredMark 路径）
  assert.ok(mainSrc.includes('if (error && error.analyzerNonAuthError) suppressCookieExpiredMark = true;'),
    '初始 goto 的普通错误必须进入既有抑制过期标记路径');
});
