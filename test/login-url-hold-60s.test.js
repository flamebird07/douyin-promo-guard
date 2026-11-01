'use strict';

/**
 * AUTH-60S（FINAL 2026-11-02）登录正向证据硬化离线回归：
 * **所有正向证据**（登录页 URL / 可见登录表单 / 可见登录控件 / 可见登录对话框）都必须
 * 对同一稳定 key（URL=origin+pathname，纯强 UI=ui:form/ui:control/ui:dialog）**连续**
 * 观测 ≥60s 才允许升级 AUTH / requiresLogin=true；短暂 /login（重定向延迟、SSO
 * /login/common）与瞬时强 UI 一律不得立即 AUTH（**强 UI 无旁路**）。
 * 正向证据仅结构性；body 文本「扫码登录」与 hidden 控件永不单独构成 AUTH。
 *
 * 覆盖（需求 5 条 + 组合表）：
 *  H1 URL-only 30s → 不 AUTH（read_failed，requiresLogin=false，文案「读取失败」；观测进度
 *     仅内部 loginUrlObserv 字段，reason 不再追加「登录页观测中 Xs/60s」）
 *  H2 跨轮次连续 ≥60s → AUTH（文案①，requiresLogin=true）
 *  H3 URL + 可见控件：<60s 不 AUTH；跨轮 ≥60s 才 AUTH（强 UI 无即时旁路）
 *  H4 无 URL 仅强 UI（可见表单/对话框）：<60s 不 AUTH；跨轮 ≥60s 才 AUTH（伪 key ui:*）
 *  H5 中途离开正向证据 → 清除计时（之后重新计，累计时长不接续）
 *  H6 仅 body「扫码」类文本/裸 AuthError（无结构性正证据）→ 永不 AUTH
 *  H7 四条固定文案映射（auth①/Cookie②/identity·read_failed③/timeout④）
 *  H8 reader：collectLoginExpiryEvidence 输出 loginUrlKey（strip query），且 loginUrl
 *     不再短路 DOM 探测（URL+可见表单可同时成立）；reader 只报瞬时证据，不自行升级
 *  H9 端到端：真实 _readCurrentAdState catch 透传 loginEvidence，正向证据 <60s → blocked=read_failed
 *
 * 不访问浏览器/CDP/网络/真实 Cookie；不启动服务/调度/广告动作。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { Monitor, AUTH_LOGIN_URL_HOLD_MS } = require('../src/engine/monitor.js');
const { AuthError, DataGuardError } = require('../src/lib/errors.js');
const { collectLoginExpiryEvidence } = require('../src/adapters/qianchuan-reader.js');
const { makeTempDir, makeCfgResult, makeClock } = require('./helpers.js');

const SHOP = { id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true };
const LOGIN_KEY = 'https://fxg.jinritemai.com/login/common';
const AUTH_TEXT = '登录失效：抖店页面在有界收敛后仍命中登录页地址，请重新扫码登录';
const NO_EVIDENCE = { loginUrl: false, loginUrlKey: null, loginFormVisible: false, loginControlVisible: false, loginDialogVisible: false };

function buildMonitor() {
  const clock = makeClock(1_700_000_000_000);
  const cfgResult = makeCfgResult({ shops: [SHOP] });
  const mon = new Monitor(cfgResult, null, { dataDir: makeTempDir('auth60-'), nowFn: clock.nowFn });
  return { mon, clock };
}

function urlOnlyEvidence(key = LOGIN_KEY) {
  return { loginUrl: true, loginUrlKey: key, loginFormVisible: false, loginControlVisible: false, loginDialogVisible: false };
}

function applyWith(mon, evidence, reason = AUTH_TEXT) {
  mon._applyReadFailure(SHOP.id, { status: 'blocked', reason, blocked: 'ad_state_read', loginEvidence: evidence });
  return mon._runtime(SHOP.id).lastReadError;
}

test('H0 常量：连续观测窗口为 60000ms', () => {
  assert.equal(AUTH_LOGIN_URL_HOLD_MS, 60000);
});

test('H1 URL-only 30s → 不 AUTH：read_failed + requiresLogin=false + 文案「读取失败」（无观测进度文案）', () => {
  const { mon, clock } = buildMonitor();
  const first = applyWith(mon, urlOnlyEvidence());
  assert.equal(first.kind, 'read_failed');
  assert.equal(first.requiresLogin, false);
  assert.equal(first.hint, '读取失败');
  // FINAL：用户可见文案固定「读取失败」，reason 不得追加「登录页观测中 Xs/60s」
  assert.doesNotMatch(first.reason, /观测中|登录页确认中|\/60s/);
  // 观测进度仅保留在内部调试字段
  assert.equal(first.loginUrlObserv.key, LOGIN_KEY);
  assert.equal(first.loginUrlObserv.holdMs, 60000);

  clock.advance(30_000);
  const second = applyWith(mon, urlOnlyEvidence());
  assert.equal(second.kind, 'read_failed', '仅 URL 30s 不得判登录失效');
  assert.equal(second.requiresLogin, false);
  assert.equal(second.hint, '读取失败');
  assert.doesNotMatch(second.reason, /观测中|\/60s/);
  assert.equal(second.loginUrlObserv.key, LOGIN_KEY);
  assert.equal(second.loginUrlObserv.heldMs, 30000);
  assert.equal(second.loginUrlObserv.holdMs, 60000);
});

test('H2 跨轮次连续 ≥60s（同一 loginUrlKey）→ AUTH，文案①', () => {
  const { mon, clock } = buildMonitor();
  applyWith(mon, urlOnlyEvidence());
  clock.advance(59_999);
  const just = applyWith(mon, urlOnlyEvidence());
  assert.equal(just.kind, 'read_failed', '59.999s 仍不得 AUTH');

  clock.advance(1);
  const hit = applyWith(mon, urlOnlyEvidence());
  assert.equal(hit.kind, 'auth', '连续满 60s 必须 AUTH');
  assert.equal(hit.requiresLogin, true);
  assert.equal(hit.hint, '登录已失效，请重新扫码');
  assert.equal(hit.loginUrlObserv, null, 'AUTH 后不再保留观测备注');

  // 同 key 继续命中：保持 auth，且窗口起点不变（连续窗口）
  clock.advance(30_000);
  const still = applyWith(mon, urlOnlyEvidence());
  assert.equal(still.kind, 'auth');
  const w = mon._authEvidenceWatchFor(SHOP.id);
  assert.ok(w && w.key === LOGIN_KEY && w.kind === 'url');
});

test('H2b loginUrlKey 变化（不同 pathname）→ 重新计时，不接续旧窗口', () => {
  const { mon, clock } = buildMonitor();
  applyWith(mon, urlOnlyEvidence('https://fxg.jinritemai.com/login/common'));
  clock.advance(50_000);
  applyWith(mon, urlOnlyEvidence('https://fxg.jinritemai.com/login/common'));
  clock.advance(20_000); // 旧 key 已累计 70s
  const switched = applyWith(mon, urlOnlyEvidence('https://fxg.jinritemai.com/passport/login'));
  assert.equal(switched.kind, 'read_failed', 'key 变化必须重新计时');
  assert.equal(switched.loginUrlObserv.heldMs, 0, '新起点归零');
});

test('H3 URL + 可见登录控件：<60s 不 AUTH；跨轮连续 ≥60s 才 AUTH（强 UI 无即时旁路）', () => {
  const { mon, clock } = buildMonitor();
  const ev = { ...urlOnlyEvidence(), loginControlVisible: true };
  // 本轮（0s）：即便带可见控件，也绝不能立即 AUTH
  const first = applyWith(mon, ev);
  assert.equal(first.kind, 'read_failed', '强 UI + URL 本轮不得即时 AUTH');
  assert.equal(first.requiresLogin, false);
  assert.equal(first.hint, '读取失败');

  clock.advance(30_000);
  const mid = applyWith(mon, ev);
  assert.equal(mid.kind, 'read_failed', '30s 仍不得 AUTH');

  clock.advance(30_000);
  const hit = applyWith(mon, ev);
  assert.equal(hit.kind, 'auth', '同一证据连续满 60s 才 AUTH');
  assert.equal(hit.requiresLogin, true);
  assert.equal(hit.hint, '登录已失效，请重新扫码');
});

test('H4 无 URL 仅强 UI（可见表单/对话框）：<60s 不 AUTH；跨轮 ≥60s 才 AUTH（伪 key ui:*）', () => {
  const { mon, clock } = buildMonitor();
  const form = { loginUrl: false, loginUrlKey: null, loginFormVisible: true, loginControlVisible: false, loginDialogVisible: false };
  const first = applyWith(mon, form);
  assert.equal(first.kind, 'read_failed', '仅强 UI 本轮不得即时 AUTH');
  assert.equal(first.requiresLogin, false);
  assert.equal(first.hint, '读取失败');
  assert.equal(mon._authEvidenceWatchFor(SHOP.id).key, 'ui:form', '纯强 UI 用稳定伪 key');

  clock.advance(59_999);
  assert.equal(applyWith(mon, form).kind, 'read_failed', '59.999s 仍不得 AUTH');
  clock.advance(1);
  const hit = applyWith(mon, form);
  assert.equal(hit.kind, 'auth', '连续满 60s 才 AUTH');
  assert.equal(hit.hint, '登录已失效，请重新扫码');

  // 对话框：另一伪 key ui:dialog，同样需跨轮 ≥60s（切换 kind 会重计）
  const { mon: m2, clock: c2 } = buildMonitor();
  const dlg = { loginUrl: false, loginUrlKey: null, loginFormVisible: false, loginControlVisible: false, loginDialogVisible: true };
  assert.equal(applyWith(m2, dlg).kind, 'read_failed', '仅对话框本轮不得 AUTH');
  assert.equal(m2._authEvidenceWatchFor(SHOP.id).key, 'ui:dialog');
  c2.advance(60_000);
  assert.equal(applyWith(m2, dlg).kind, 'auth', '对话框连续满 60s 才 AUTH');
});

test('H5 中途离开正向证据 → 清除计时；之后重新计（中断时段不累计）', () => {
  const { mon, clock } = buildMonitor();
  applyWith(mon, urlOnlyEvidence());
  clock.advance(40_000);
  applyWith(mon, urlOnlyEvidence()); // 已累计 40s

  // 离开正向证据（无证据轮次，如导航失败）→ 窗口清除
  const away = applyWith(mon, NO_EVIDENCE, '导航未到达管理页');
  assert.equal(away.kind, 'read_failed');
  assert.equal(mon._authEvidenceWatchFor(SHOP.id), null, '离开正向证据必须清除计时');

  // 再回登录页：重新从 0 计；即使距首次已 70s，也不得 AUTH
  clock.advance(30_000);
  const back1 = applyWith(mon, urlOnlyEvidence());
  assert.equal(back1.kind, 'read_failed');
  clock.advance(59_000);
  const back2 = applyWith(mon, urlOnlyEvidence());
  assert.equal(back2.kind, 'read_failed', '中断后重新计时，总时长 59s 不得 AUTH');
  clock.advance(1_000);
  const back3 = applyWith(mon, urlOnlyEvidence());
  assert.equal(back3.kind, 'auth', '重新连续满 60s 才 AUTH');
});

test('H5b 读取成功 → 清除观测窗口', () => {
  const { mon, clock } = buildMonitor();
  applyWith(mon, urlOnlyEvidence());
  clock.advance(50_000);
  mon._clearReadFailure(SHOP.id);
  assert.equal(mon._authEvidenceWatchFor(SHOP.id), null);
  const again = applyWith(mon, urlOnlyEvidence());
  assert.equal(again.kind, 'read_failed', '成功后重新命中登录页必须从 0 重新计');
});

test('H5c 无证据轮次（Cookie 故障等）→ 窗口中断清除', () => {
  const { mon, clock } = buildMonitor();
  applyWith(mon, urlOnlyEvidence());
  clock.advance(50_000);
  applyWith(mon, urlOnlyEvidence());
  // 一轮不带 loginEvidence 的失败（如 Cookie 同步锁）→ 连续观测中断
  mon._applyReadFailure(SHOP.id, { reason: '另一进程正在同步该店 Cookie 副本', blocked: 'cookie_blocked' });
  assert.equal(mon._authEvidenceWatchFor(SHOP.id), null);
  clock.advance(30_000);
  const after = applyWith(mon, urlOnlyEvidence());
  assert.equal(after.kind, 'read_failed', '中断后累计不接续');
});

test('H5d 强 UI 证据种类切换（form→control）→ 伪 key 变化，重新计时', () => {
  const { mon, clock } = buildMonitor();
  const form = { loginUrl: false, loginUrlKey: null, loginFormVisible: true, loginControlVisible: false, loginDialogVisible: false };
  const control = { loginUrl: false, loginUrlKey: null, loginFormVisible: false, loginControlVisible: true, loginDialogVisible: false };
  applyWith(mon, form);
  clock.advance(50_000);
  applyWith(mon, form); // ui:form 已累计 50s
  const switched = applyWith(mon, control);
  assert.equal(switched.kind, 'read_failed', '证据种类切换即 key 变化，必须重新计时');
  assert.equal(mon._authEvidenceWatchFor(SHOP.id).key, 'ui:control');
  clock.advance(30_000);
  assert.equal(applyWith(mon, control).kind, 'read_failed', '切换后仅 30s 不得 AUTH');
  clock.advance(30_000);
  assert.equal(applyWith(mon, control).kind, 'auth', '切换后连续满 60s 才 AUTH');
});

test('H6 仅 body「扫码登录」文本 / 裸 AuthError（无结构性正证据）→ 永不 AUTH', () => {
  const { mon, clock } = buildMonitor();
  // 证据全 false（body 文本不参与结构性证据），reason 甚至带登录字样
  for (let i = 0; i < 5; i += 1) {
    const r = applyWith(mon, NO_EVIDENCE, '页面正文出现「扫码登录」教程字样');
    assert.equal(r.kind, 'read_failed');
    assert.equal(r.requiresLogin, false);
    clock.advance(60_000);
  }
  const final = applyWith(mon, NO_EVIDENCE, '页面正文出现「扫码登录」教程字样');
  assert.equal(final.kind, 'read_failed', '累计 300s 也不得 AUTH');

  // 裸 AuthError（无 loginEvidence，消息无正证据词）→ read_failed（F5-R9 保持）
  mon._applyReadFailure(SHOP.id, { reason: '访问被拒绝', blocked: 'auth', auth: true });
  const bare = mon._runtime(SHOP.id).lastReadError;
  assert.equal(bare.kind, 'read_failed');
  assert.equal(bare.hint, '读取失败');
  assert.equal(bare.requiresLogin, false);
});

test('H7 四条固定文案映射：①登录 ②Cookie ③读取失败 ④超时', () => {
  const { mon } = buildMonitor();
  const cases = [
    [{ reason: 'Cookie 文件解析失败: Unexpected token', blocked: 'cookie_invalid' }, 'cookie_invalid', 'Cookie 缺失，请重新导入'],
    [{ reason: '未找到店铺「shop-a」的 Cookie 文件', blocked: 'cookie_blocked' }, 'cookie_blocked', 'Cookie 缺失，请重新导入'],
    [{ reason: '店铺名称不匹配：身份核验失败', blocked: 'identity' }, 'identity', '读取失败'],
    [{ reason: '导航未到达管理页' }, 'read_failed', '读取失败'],
    [{ reason: '回读截止（300000ms）已到', timeout: true }, 'timeout', '读取超时，将自动重试'],
  ];
  for (const [err, wantKind, wantHint] of cases) {
    mon._applyReadFailure(SHOP.id, err);
    const re = mon._runtime(SHOP.id).lastReadError;
    assert.equal(re.kind, wantKind, JSON.stringify(err));
    assert.equal(re.hint, wantHint, JSON.stringify(err));
    assert.equal(re.requiresLogin, false, '非 auth 一律 requiresLogin=false');
  }
});

// ── H8 reader 侧：collectLoginExpiryEvidence（只报瞬时证据，不自行升级）──────

function makeEl(spec) {
  const el = {
    tagName: String(spec.tag || 'div').toUpperCase(),
    attributes: Object.assign({}, spec.attrs || {}),
    __style: Object.assign({ display: 'block', visibility: 'visible' }, spec.style || {}),
    __rect: Object.assign({ width: 100, height: 30 }, spec.rect || {}),
    parentElement: null,
    childNodes: spec.children || [],
    innerText: spec.text || '',
    textContent: spec.text || '',
    value: spec.value || '',
    type: (spec.attrs && spec.attrs.type) || '',
    getAttribute(name) { const v = this.attributes[name]; return v === undefined ? null : String(v); },
    getBoundingClientRect() { return Object.assign({}, this.__rect); },
    closest() { return null; },
  };
  return el;
}

function makeDom(rootNodes) {
  const all = [];
  const walk = (n) => { all.push(n); (n.childNodes || []).forEach(walk); };
  rootNodes.forEach(walk);
  const match = (el, sel) => {
    // 极简：仅支持本测试用到的 input[type="password"] / [role="dialog"] / button
    if (sel.includes('input[type="password"]')) return el.tagName === 'INPUT' && el.attributes.type === 'password';
    if (sel.includes('[role="dialog"]') || sel.includes('dialog')) return el.attributes.role === 'dialog' || el.tagName === 'DIALOG';
    if (sel.includes('button')) return el.tagName === 'BUTTON' || el.attributes.role === 'button';
    return false;
  };
  const document = {
    querySelectorAll: (sel) => all.filter((el) => sel.split(',').some((part) => match(el, part.trim()))),
  };
  return { document };
}

function makePage(url, rootNodes) {
  const { document } = makeDom(rootNodes);
  const ctx = vm.createContext({
    document,
    getComputedStyle: (el) => ({ display: el.__style.display, visibility: el.__style.visibility }),
    location: { href: url },
  });
  const emptyLocator = { count: async () => 0, isVisible: async () => false };
  return {
    url: () => url,
    evaluate: async (fn) => vm.runInContext(`(${fn.toString()})()`, ctx),
    getByRole: () => emptyLocator,
    getByText: () => emptyLocator,
    locator: () => emptyLocator,
  };
}

test('H8 collectLoginExpiryEvidence：loginUrlKey=origin+pathname（strip query），URL 不短路可见 UI 探测', async () => {
  const withQuery = 'https://fxg.jinritemai.com/login/common?redirect_uri=https%3A%2F%2Fx&service=1';
  const ev1 = await collectLoginExpiryEvidence(makePage(withQuery, []));
  assert.equal(ev1.loginUrl, true);
  assert.equal(ev1.loginUrlKey, LOGIN_KEY, 'key 必须去掉 query');

  // 登录页 URL + 可见 password 表单：两项证据必须同时成立（跨轮 ≥60s 判定的输入）
  const pwd = makeEl({ tag: 'input', attrs: { type: 'password' }, rect: { width: 220, height: 32 } });
  const ev2 = await collectLoginExpiryEvidence(makePage(withQuery, [pwd]));
  assert.equal(ev2.loginUrl, true);
  assert.equal(ev2.loginFormVisible, true, 'loginUrl 命中时仍必须探测可见表单');

  // 非登录页：key 为 null
  const ev3 = await collectLoginExpiryEvidence(makePage('https://qianchuan.jinritemai.com/home?aavid=1', []));
  assert.equal(ev3.loginUrl, false);
  assert.equal(ev3.loginUrlKey, null);
});

// ── H9 端到端：真实 _readCurrentAdState catch 透传 loginEvidence ─────────────

test('H9 真实 catch：URL-only <60s → blocked=read_failed；≥60s → blocked=auth（证据透传）', async () => {
  const clock = makeClock(1_700_000_000_000);
  const cfgResult = makeCfgResult({
    shops: [SHOP],
    monitor: { chengfang: { scope: ['全店托管', '商品自选'], adStateReadTimeoutMs: 400, adStateCloseWaitMs: 200, adStateSettleWaitMs: 200 } },
  });
  const err = new AuthError(AUTH_TEXT);
  err.loginEvidence = urlOnlyEvidence();
  let calls = 0;
  const mon = new Monitor(cfgResult, null, {
    dataDir: makeTempDir('auth60-e2e-'),
    nowFn: clock.nowFn,
    chengfangOpener: async () => { calls += 1; throw err; },
  });

  const r1 = await mon._readCurrentAdState(SHOP);
  assert.equal(r1.state, 'unknown');
  assert.ok(r1.error.loginEvidence, '结构化证据必须透传到 error 对象');
  assert.equal(r1.error.blocked, 'read_failed', 'URL-only 未满 60s 不得冒充 auth');
  assert.equal(mon._readErrorKind(r1.error, SHOP.id), 'read_failed');
  mon._applyReadFailure(SHOP.id, r1.error);
  assert.equal(mon._runtime(SHOP.id).lastReadError.requiresLogin, false);

  clock.advance(61_000);
  const r2 = await mon._readCurrentAdState(SHOP);
  assert.equal(r2.error.blocked, 'auth', '同一 key 连续 ≥60s → AUTH');
  mon._applyReadFailure(SHOP.id, r2.error);
  const re = mon._runtime(SHOP.id).lastReadError;
  assert.equal(re.kind, 'auth');
  assert.equal(re.requiresLogin, true);
  assert.equal(re.hint, '登录已失效，请重新扫码');
  assert.ok(calls >= 1);
});

test('H9s 真实 catch：强 UI（可见控件）<60s → read_failed；≥60s → auth（无即时旁路）', async () => {
  const clock = makeClock(1_700_000_000_000);
  const cfgResult = makeCfgResult({
    shops: [SHOP],
    monitor: { chengfang: { scope: ['全店托管', '商品自选'], adStateReadTimeoutMs: 400, adStateCloseWaitMs: 200, adStateSettleWaitMs: 200 } },
  });
  const err = new AuthError('千川视图读取遇到登录控件：尚未取得账户数据');
  err.loginEvidence = { ...urlOnlyEvidence(), loginControlVisible: true };
  const mon = new Monitor(cfgResult, null, {
    dataDir: makeTempDir('auth60-e2e-ui-'),
    nowFn: clock.nowFn,
    chengfangOpener: async () => { throw err; },
  });

  const r1 = await mon._readCurrentAdState(SHOP);
  assert.equal(r1.error.blocked, 'read_failed', '强 UI + URL 本轮不得即时 auth');
  mon._applyReadFailure(SHOP.id, r1.error);
  assert.equal(mon._runtime(SHOP.id).lastReadError.requiresLogin, false);

  clock.advance(61_000);
  const r2 = await mon._readCurrentAdState(SHOP);
  assert.equal(r2.error.blocked, 'auth', '同一强 UI 证据连续 ≥60s → auth');
  mon._applyReadFailure(SHOP.id, r2.error);
  assert.equal(mon._runtime(SHOP.id).lastReadError.requiresLogin, true);
});

test('H9b 真实 catch：DataGuardError 携带非正向证据 → 窗口清除且不 AUTH', async () => {
  const clock = makeClock(1_700_000_000_000);
  const cfgResult = makeCfgResult({
    shops: [SHOP],
    monitor: { chengfang: { scope: ['全店托管', '商品自选'], adStateReadTimeoutMs: 400, adStateCloseWaitMs: 200, adStateSettleWaitMs: 200 } },
  });
  let evidence = urlOnlyEvidence();
  let reason = AUTH_TEXT;
  let Ctor = AuthError;
  const mon = new Monitor(cfgResult, null, {
    dataDir: makeTempDir('auth60-e2e2-'),
    nowFn: clock.nowFn,
    chengfangOpener: async () => { const e = new Ctor(reason); e.loginEvidence = evidence; throw e; },
  });

  const r1 = await mon._readCurrentAdState(SHOP);
  assert.equal(r1.error.blocked, 'read_failed');

  // 下一轮离开正向证据（导航失败，证据全 false）
  Ctor = DataGuardError;
  reason = '抖店主页面在有界自动登录收敛期内未到达首页；未见登录正证据，按导航事实处理';
  evidence = NO_EVIDENCE;
  clock.advance(70_000);
  const r2 = await mon._readCurrentAdState(SHOP);
  assert.notEqual(r2.error.blocked, 'auth');
  assert.equal(mon._authEvidenceWatchFor(SHOP.id), null, '非正向证据轮次必须清除观测窗口');
});
