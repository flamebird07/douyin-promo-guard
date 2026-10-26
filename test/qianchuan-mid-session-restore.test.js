'use strict';

/**
 * S8 专项测试（2026-10-26）：openQianchuanHome 千川账户视图阶段缺失的恢复分支。
 * 已核读源码核实的缺口：初始 FXG 收敛失败已有四层恢复（有界一次），但
 * ensureQianchuanAccountView 在千川入口抛出的 AuthError 直接外抛，已保存的有效
 * 同店候选从未被尝试。本文件验证修复语义（全部离线：node:test + os.tmpdir() 合成
 * 假 Cookie + vm 模拟 DOM 执行真实页面回调，无真实浏览器/网络/生产路径/真实凭证）：
 *  1) QC 阶段真实 Auth → 既有恢复链恰好一次 → 干净重开上下文成功复验；
 *  2) 初始收敛已恢复 → QC 再 Auth 不二次恢复（整次 open 共享一次配额）；
 *  3) 恢复禁用（restoreOnAuthFailure=false）→ 0 次恢复；
 *  4) QC 非认证类失败（DataGuard）→ 0 次恢复；
 *  5) 恢复无可验证候选 → 如实保留认证失败 + 关闭资源；
 *  5b) 恢复链抛异常 → 同上；
 *  6) 恢复重开后仍 Auth → 合计仍只一次恢复；
 *  7) 原上下文关闭失败 → 0 次恢复、无第二上下文（绝不重叠会话）；
 *  8) 复核无新鲜登录正证据 → 不恢复，原 AuthError 原样上抛。
 * 只读入口/视图导航（伪造的既有只读 UI），零广告操作点击。不比对源码字符串。
 * 运行：node --test douyin-promo-guard/test/qianchuan-mid-session-restore.test.js（主脑执行）。
 */

const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const session = require('../src/login/session');
const { AuthError, DataGuardError } = require('../src/lib/errors');
const { openQianchuanHome } = require('../src/adapters/qianchuan-reader');

const HOME_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const LOGIN_URL = 'https://fxg.jinritemai.com/ffa/login/common';
const ACCOUNT_ID = '1710242295996424';
const QC_URL = `https://qianchuan.jinritemai.com/home?aavid=${ACCOUNT_ID}`;
const FILE = 'qc-shop.json';

// ── 合成 Cookie（仅临时目录假数据，无真实凭证）────────────────────────

function bytesOf(cookies) { return Buffer.from(JSON.stringify(cookies, null, 2), 'utf8'); }
const temporaryRoots = new Set();
after(() => {
  const root = fs.realpathSync(os.tmpdir());
  for (const dir of temporaryRoots) {
    assert.strictEqual(fs.realpathSync(dir), dir);
    assert.ok(dir.toLowerCase().startsWith((root + path.sep).toLowerCase()));
    assert.ok(path.basename(dir).startsWith('qc-mid-restore-'));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
function makeCookies(tag) {
  return [{ name: 'sessionid', value: `fake-${tag}-synthetic`, domain: '.jinritemai.com', path: '/', expires: 1893456000 }];
}
function mkDirs() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'qc-mid-restore-')));
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

// ── 最小 DOM fixture（真实元素语义；与 login-visible-evidence.test.js 同协议）──

function splitCompound(sel) {
  const out = [];
  const re = /([a-zA-Z][a-zA-Z0-9-]*)|(\.[a-zA-Z0-9_-]+)|(\[[^\]]+\])/g;
  let m;
  while ((m = re.exec(sel))) out.push(m[0]);
  return out;
}
function matchesSimple(el, sel) {
  const parts = splitCompound(sel);
  for (const p of parts) {
    if (p.startsWith('.')) {
      const cls = String(el.attrs['class'] || '');
      if (!cls.split(/\s+/).includes(p.slice(1))) return false;
    } else if (p.startsWith('[')) {
      const am = /^\[\s*([a-zA-Z0-9_-]+)\s*(?:([*^$]?=)\s*"([^"]*)")?\s*\]$/.exec(p);
      if (!am) return false;
      const [, attr, op, want] = am;
      const have = el.attrs[attr];
      if (have === undefined) return false;
      if (op === '=') { if (String(have) !== want) return false; }
      if (op === '*=') { if (!String(have).includes(want)) return false; }
      if (op === '^=') { if (!String(have).startsWith(want)) return false; }
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
    value: spec.value || '',
    type: (spec.attrs && spec.attrs.type) || '',
    clicks: 0,
    getAttribute(name) { return name in this.attrs ? String(this.attrs[name]) : null; },
    hasAttribute(name) { return name in this.attrs; },
    getBoundingClientRect() { return Object.assign({}, this.__rect); },
    closest(sel) {
      let n = this.parentElement;
      while (n) {
        if (String(sel).split(',').some((p) => matchesSelector(n, p.trim()))) return n;
        n = n.parentElement;
      }
      return null;
    },
    click() { this.clicks += 1; },
  };
  node.childNodes = node.children;
  for (const c of node.children) if (!c.parentElement) c.parentElement = node;
  return node;
}

/**
 * fake page：page.evaluate 把源码传入的实际回调放进 vm 模拟 DOM 上下文执行
 * （回调抛错按页面不可得处理，返回 undefined —— 保守不产生任何正证据）。
 */
function makePage(url, roots, extra = {}) {
  const body = el({ tag: 'body', children: roots });
  const pick = (selector) => {
    const out = [];
    const walk = (n) => { out.push(n); n.children.forEach(walk); };
    walk(body);
    return out.filter((e) => String(selector).split(',').some((p) => matchesSelector(e, p.trim())));
  };
  const document = {
    body,
    querySelector: (sel) => pick(sel)[0] || null,
    querySelectorAll: (sel) => pick(sel),
  };
  const sandbox = {
    document,
    getComputedStyle: (n) => ({ display: n.__style.display, visibility: n.__style.visibility }),
    location: { href: url },
  };
  const vctx = vm.createContext(sandbox);
  sandbox.window = sandbox;
  const emptyLoc = {
    count: async () => 0, isVisible: async () => false,
    nth() { return this; }, first() { return this; },
    click: async () => {}, waitFor: async () => {}, evaluate: async () => false,
  };
  const page = {
    __url: url, __closed: false, __evals: 0,
    __forceUrl: extra.forceUrl || null,
    __mutateAt: extra.mutateAt || 0,
    __mutate: extra.mutate || null,
    url: () => page.__url,
    goto: async (u) => { page.__url = page.__forceUrl || u; },
    evaluate: async (fn, ...args) => {
      page.__evals += 1;
      if (page.__mutateAt === page.__evals && page.__mutate) page.__mutate();
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

// 语义页面：抖店已登录首页 / 千川登录失效（可见 password 表单）/ 千川账户视图就绪 / 空白千川页。
const fxgPage = (extra = {}) => makePage(
  extra.url || HOME_URL,
  [el({ attrs: { class: 'index_userName_main' }, text: '千川店' })],
  extra,
);
const qcAuthPage = () => makePage(QC_URL, [el({ tag: 'input', attrs: { type: 'password' }, rect: { width: 220, height: 32 } })]);
const qcOkPage = () => makePage(QC_URL, [el({ attrs: { class: 'summaryCard-main' }, text: '账户整体消耗(元) 12.34 相比上周期 +0.00%' })]);
const qcBlankPage = () => makePage(QC_URL, []);

// ── fake browser/context（脚本化逐上下文页面队列）─────────────────────

function makeBrowser(contextSpecs, counters) {
  return {
    newContext: async () => {
      counters.contexts += 1;
      const spec = contextSpecs[counters.contexts - 1] || {};
      const opened = [];
      return {
        addCookies: async () => { counters.addedCookieSets += 1; },
        newPage: async () => {
          counters.pages += 1;
          const pg = spec.pages.shift();
          if (!pg) throw new Error('stub: 该上下文没有预置页面（会话数超出脚本）');
          opened.push(pg);
          return pg;
        },
        close: async () => {
          if (spec.failClose === true) throw new Error('stub: context close refused');
          counters.ctxCloses += 1;
          for (const p of opened) p.__closed = true;
        },
        cookies: async () => [],
        waitForEvent: () => Promise.resolve(null),
        on() {}, off() {},
      };
    },
    close: async () => { counters.browserCloses += 1; },
    isConnected: () => true,
  };
}

function mkCounters() {
  return { contexts: 0, pages: 0, ctxCloses: 0, browserCloses: 0, addedCookieSets: 0 };
}
function countingRestore(ref) {
  return async (...a) => { ref.n += 1; return session.restoreDutyWorkCopy(...a); };
}
function baseOpts(d, browser, restoreRunner, extra = {}) {
  return Object.assign({
    browserFactory: async () => browser,
    settleTimeoutMs: 30, settleIntervalMs: 10,
    readinessTimeoutMs: 30, readinessIntervalMs: 10,
    restoreRecoveryDir: d.recoveryDir,
    restoreVaultModule: emptyVaultModule(),
    restoreRunner,
    nowFn: () => 20000,
  }, extra);
}
const loginCfgOf = (d) => ({ cookieWorkDir: d.workDir, edgePath: null });
const shopCfg = { id: 's1', name: '千川店', compassShopName: '千川店', cookieFile: FILE, accountId: ACCOUNT_ID };
const verifyOk = async (p) => ({ ok: true, finalCookies: p.cookies });

// ── 用例 ──────────────────────────────────────────────────────────

test('1) QC 阶段真实 Auth → 既有四层恢复恰好一次 → 干净重开上下文成功复验', async () => {
  const d = mkDirs();
  const workFile = path.join(d.workDir, FILE);
  const stale = bytesOf(makeCookies('stale'));
  const fresh = bytesOf(makeCookies('fresh'));
  fs.writeFileSync(workFile, stale);
  fs.writeFileSync(path.join(d.recoveryDir, FILE), fresh);
  const counters = mkCounters();
  const calls = { n: 0 };
  const browser = makeBrowser([
    { pages: [fxgPage(), qcAuthPage()] },
    { pages: [fxgPage(), qcOkPage()] },
  ], counters);
  const res = await openQianchuanHome(loginCfgOf(d), shopCfg, baseOpts(d, browser, countingRestore(calls), {
    restoreVerify: verifyOk,
  }));
  assert.strictEqual(calls.n, 1, '整次 open 调用恰好一次恢复（初始收敛未用配额）');
  assert.strictEqual(counters.contexts, 2, '失效会话 + 恢复后干净重开各一次');
  assert.strictEqual(counters.ctxCloses, 1, '恢复前旧上下文必须先关闭');
  assert.strictEqual(counters.browserCloses, 0, '成功路径浏览器交还调用方，不在此关闭');
  assert.strictEqual(res.navMode, 'direct-home-url');
  assert.strictEqual(String(res.target.url()), QC_URL, '复验成功的 target 必须是重开会话里的千川首页');
  assert.ok(fs.readFileSync(workFile).equals(fresh), '恢复成功必须提升值守工作副本');
});

test('2) 初始收敛已恢复一次 → QC 阶段再 Auth 不二次恢复（共享配额）', async () => {
  const d = mkDirs();
  fs.writeFileSync(path.join(d.workDir, FILE), bytesOf(makeCookies('expired')));
  fs.writeFileSync(path.join(d.recoveryDir, FILE), bytesOf(makeCookies('fresh')));
  const counters = mkCounters();
  const calls = { n: 0 };
  const browser = makeBrowser([
    { pages: [fxgPage({ forceUrl: LOGIN_URL, url: LOGIN_URL }), qcAuthPage()] },
    { pages: [fxgPage(), qcAuthPage()] },
  ], counters);
  await assert.rejects(
    () => openQianchuanHome(loginCfgOf(d), shopCfg, baseOpts(d, browser, countingRestore(calls), {
      restoreVerify: verifyOk,
    })),
    (e) => {
      assert.ok(e instanceof AuthError, `应为认证错误：${e && e.message}`);
      assert.match(e.message, /千川视图读取遇到登录页或登录控件/);
      assert.ok(!e.message.includes('四层恢复'), '配额共享：第二次 Auth 不得再走恢复语义');
      return true;
    },
  );
  assert.strictEqual(calls.n, 1, '合计恰好一次恢复（初始收敛那次）');
  assert.strictEqual(counters.contexts, 2, '不得开出第三个上下文');
  assert.strictEqual(counters.browserCloses, 1);
});

test('3) 恢复禁用（restoreOnAuthFailure=false）→ QC Auth 不恢复、不关上下文', async () => {
  const d = mkDirs();
  fs.writeFileSync(path.join(d.workDir, FILE), bytesOf(makeCookies('stale')));
  fs.writeFileSync(path.join(d.recoveryDir, FILE), bytesOf(makeCookies('fresh')));
  const counters = mkCounters();
  const calls = { n: 0 };
  const browser = makeBrowser([{ pages: [fxgPage(), qcAuthPage()] }], counters);
  await assert.rejects(
    () => openQianchuanHome(loginCfgOf(d), shopCfg, baseOpts(d, browser, countingRestore(calls), {
      restoreOnAuthFailure: false,
    })),
    (e) => {
      assert.ok(e instanceof AuthError);
      assert.match(e.message, /千川视图读取遇到登录页或登录控件/);
      return true;
    },
  );
  assert.strictEqual(calls.n, 0, '禁用时零恢复');
  assert.strictEqual(counters.contexts, 1);
  assert.strictEqual(counters.ctxCloses, 0, '未进入恢复分支就不应关闭原上下文');
  assert.strictEqual(counters.browserCloses, 1);
});

test('4) QC 非认证类失败（DataGuard）→ 零恢复', async () => {
  const d = mkDirs();
  fs.writeFileSync(path.join(d.workDir, FILE), bytesOf(makeCookies('stale')));
  fs.writeFileSync(path.join(d.recoveryDir, FILE), bytesOf(makeCookies('fresh')));
  const counters = mkCounters();
  const calls = { n: 0 };
  const browser = makeBrowser([{ pages: [fxgPage(), qcBlankPage()] }], counters);
  await assert.rejects(
    () => openQianchuanHome(loginCfgOf(d), shopCfg, baseOpts(d, browser, countingRestore(calls))),
    (e) => {
      assert.ok(e instanceof DataGuardError, `非认证失败必须按数据护栏处理：${e && e.message}`);
      assert.ok(!(e instanceof AuthError));
      return true;
    },
  );
  assert.strictEqual(calls.n, 0, '导航/就绪类失败绝不触发恢复');
  assert.strictEqual(counters.contexts, 1);
});

test('5) 恢复无可验证候选 → 如实保留认证失败 + 恢复说明，资源收口，工作副本不盲覆盖', async () => {
  const d = mkDirs();
  const workFile = path.join(d.workDir, FILE);
  const stale = bytesOf(makeCookies('stale'));
  fs.writeFileSync(workFile, stale);
  fs.writeFileSync(path.join(d.recoveryDir, FILE), bytesOf(makeCookies('also-stale')));
  const counters = mkCounters();
  const calls = { n: 0 };
  const browser = makeBrowser([{ pages: [fxgPage(), qcAuthPage()] }], counters);
  await assert.rejects(
    () => openQianchuanHome(loginCfgOf(d), shopCfg, baseOpts(d, browser, countingRestore(calls), {
      restoreVerify: async () => ({ ok: false, reason: '桩：候选登录无效' }),
    })),
    (e) => {
      assert.ok(e instanceof AuthError);
      assert.match(e.message, /千川视图读取遇到登录页或登录控件/);
      assert.match(e.message, /四层恢复未取得可验证候选/);
      assert.match(e.message, /工作副本现状未被盲覆盖/);
      return true;
    },
  );
  assert.strictEqual(calls.n, 1, '恢复被尝试且仅一次');
  assert.strictEqual(counters.contexts, 1, '恢复失败不得重开上下文');
  assert.strictEqual(counters.ctxCloses, 1, '恢复前旧上下文已关闭');
  assert.strictEqual(counters.browserCloses, 1, '失败出口关闭浏览器');
  assert.ok(fs.readFileSync(workFile).equals(stale), '工作副本未被盲覆盖');
});

test('5b) 恢复链抛异常 → 认证失败如实保留（异常不吞不伪装成功）', async () => {
  const d = mkDirs();
  fs.writeFileSync(path.join(d.workDir, FILE), bytesOf(makeCookies('stale')));
  const counters = mkCounters();
  const calls = { n: 0 };
  const browser = makeBrowser([{ pages: [fxgPage(), qcAuthPage()] }], counters);
  const throwingRunner = async () => { calls.n += 1; throw new Error('fake-secret-must-not-appear'); };
  await assert.rejects(
    () => openQianchuanHome(loginCfgOf(d), shopCfg, baseOpts(d, browser, throwingRunner)),
    (e) => {
      assert.ok(e instanceof AuthError);
      assert.match(e.message, /千川视图读取遇到登录页或登录控件/);
      assert.match(e.message, /恢复链异常/);
      assert.ok(!e.message.includes('fake-secret-must-not-appear'));
      return true;
    },
  );
  assert.strictEqual(calls.n, 1);
  assert.strictEqual(counters.contexts, 1);
  assert.strictEqual(counters.browserCloses, 1);
});

test('6) 恢复重开后 QC 仍 Auth → 合计仍只一次恢复、两个上下文封顶', async () => {
  const d = mkDirs();
  fs.writeFileSync(path.join(d.workDir, FILE), bytesOf(makeCookies('expired')));
  fs.writeFileSync(path.join(d.recoveryDir, FILE), bytesOf(makeCookies('fresh-but-qc-rejects')));
  const counters = mkCounters();
  const calls = { n: 0 };
  const browser = makeBrowser([
    { pages: [fxgPage(), qcAuthPage()] },
    { pages: [fxgPage(), qcAuthPage()] },
  ], counters);
  await assert.rejects(
    () => openQianchuanHome(loginCfgOf(d), shopCfg, baseOpts(d, browser, countingRestore(calls), {
      restoreVerify: verifyOk,
    })),
    (e) => {
      assert.ok(e instanceof AuthError, `重试仍失效必须如实认证失败：${e && e.message}`);
      assert.match(e.message, /千川视图读取遇到登录页或登录控件/);
      return true;
    },
  );
  assert.strictEqual(calls.n, 1, '重试仍失效不得第二轮恢复');
  assert.strictEqual(counters.contexts, 2, '至多两个上下文');
  assert.strictEqual(counters.browserCloses, 1);
});

test('7) 原上下文关闭失败 → 0 次恢复、无第二上下文（绝不重叠会话）', async () => {
  const d = mkDirs();
  fs.writeFileSync(path.join(d.workDir, FILE), bytesOf(makeCookies('stale')));
  fs.writeFileSync(path.join(d.recoveryDir, FILE), bytesOf(makeCookies('fresh')));
  const counters = mkCounters();
  const calls = { n: 0 };
  const browser = makeBrowser([{ pages: [fxgPage(), qcAuthPage()], failClose: true }], counters);
  await assert.rejects(
    () => openQianchuanHome(loginCfgOf(d), shopCfg, baseOpts(d, browser, countingRestore(calls), {
      restoreVerify: verifyOk,
    })),
    (e) => {
      assert.ok(e instanceof AuthError);
      assert.match(e.message, /千川视图读取遇到登录页或登录控件/);
      assert.match(e.message, /关闭未获证明/);
      return true;
    },
  );
  assert.strictEqual(calls.n, 0, '关闭失败必须阻断恢复');
  assert.strictEqual(counters.contexts, 1, '不得开出第二个上下文');
  assert.strictEqual(counters.ctxCloses, 0);
  assert.strictEqual(counters.browserCloses, 1);
});

test('8) 复核无新鲜登录正证据 → 不恢复，原 AuthError 原样上抛', async () => {
  const d = mkDirs();
  fs.writeFileSync(path.join(d.workDir, FILE), bytesOf(makeCookies('stale')));
  fs.writeFileSync(path.join(d.recoveryDir, FILE), bytesOf(makeCookies('fresh')));
  const counters = mkCounters();
  const calls = { n: 0 };
  // 第 1 次 evaluate = 视图探针；第 2 次 = ensureView 内登录取证（见真实 password 表单 → Auth）；
  // 第 3 次 = open 层复核取证前 DOM 已变化（登录控件消失）→ 无新鲜正证据 → 不恢复。
  const roots = [el({ tag: 'input', attrs: { type: 'password' }, rect: { width: 220, height: 32 } })];
  const qc = makePage(QC_URL, roots, { mutateAt: 3, mutate: () => { roots.splice(0, roots.length); } });
  const browser = makeBrowser([{ pages: [fxgPage(), qc] }], counters);
  await assert.rejects(
    () => openQianchuanHome(loginCfgOf(d), shopCfg, baseOpts(d, browser, countingRestore(calls), {
      restoreVerify: verifyOk,
    })),
    (e) => {
      assert.ok(e instanceof AuthError);
      assert.match(e.message, /千川视图读取遇到登录页或登录控件/);
      assert.ok(!e.message.includes('四层恢复'), '无新鲜正证据不得进入恢复链');
      return true;
    },
  );
  assert.strictEqual(calls.n, 0);
  assert.strictEqual(counters.contexts, 1);
  assert.strictEqual(counters.ctxCloses, 0);
  assert.strictEqual(counters.browserCloses, 1);
});
