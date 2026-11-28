'use strict';

/**
 * 登录失效可见提示回归测试（2026-11-27）。
 *
 * 覆盖：
 * - 读取链（费用/订单）AuthError → lastReadError/auth + requiresLogin，行上不再只显示「有效」；
 * - 该提示只补记录，不改 adBelief / 串行门；
 * - 重新登录后成功读取 → 清除 requiresLogin 与提示，当前动作回到「空闲」；
 * - 广告状态回读 DataGuardError → read_failed，清除旧登录提示且不要求扫码；
 * - Cookie 文件解析失败 → 不落登录提示、不要求扫码，Cookie 列按「缺失」显示；
 * - fix3 authClosure 结案/未结案固定文案（不含扫码旁路）；
 * - 发布/恢复租约在途优先，本轮 skipped 且不落登录提示；
 * - _readErrorHint 四类固定文案单一来源；
 * - 主控制页「会话失效」徽标 / 红色当前动作 / requiresLogin 渲染分支；
 * - 过期 Cookie 文件（2026-11-28）：shops / shopRows 两处投影均 found:true + expired:true
 *   并保留文件内最晚到期时间（不再误报缺失）；默认 loadShopCookieMeta 仍拒过期；
 * - 正常文件兼容（expired:false）与 requiresLogin 最高优先级不受文件到期状态影响；
 * - Cookie 列三态文案（文件已过期/文件未到期/无固定到期时间）与「文件内最晚到期时间」标注；
 *   无日期独立分支用中性徽标，不称「文件未到期」、不断言会话型、不重复小字。
 *
 * 全部使用临时目录与 mock 适配器，不访问真实页面，不写生产目录。
 * 运行：/opt/homebrew/opt/node@24/bin/node --test test/monitor-login-hint.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { Monitor } = require('../src/engine/monitor');
const { AuthError, DataGuardError } = require('../src/lib/errors');
const { createUiServer } = require('../src/ui/server');
const { makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController } = require('./helpers');

function setup(t) {
  const cookieDir = makeTempDir('pg-login-hint-cookie-');
  const dataDir = makeTempDir('pg-login-hint-data-');
  t.after(() => {
    fs.rmSync(cookieDir, { recursive: true, force: true });
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  writeTempCookie(cookieDir, '测试店铺一', {});
  const shop = { id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', enabled: true };
  const cfgResult = makeCfgResult({ shops: [shop], cookieDir });
  const behavior = { costCents: 15001, orders: 100 };
  const controller = makeStatefulController({ identity: { id: 'shop-001', name: '测试店铺一' }, ads: [] });
  const reader = makeLinkedReader(controller, behavior);
  const monitor = new Monitor(cfgResult, { reader, controller }, { dataDir });
  return { monitor, behavior, controller, reader, cookieDir, dataDir };
}

function rowOf(monitor, id = 'shop-001') {
  return monitor.getStatus().shopRows.find((r) => r.id === id);
}

function makeMonitor(extra = {}) {
  return {
    config: undefined,
    getStatus: () => ({ mode: '演练模式', realMode: false, shops: [], shopRows: [], monitor: { running: false } }),
    start: () => ({ ok: true }),
    stop: () => ({ ok: true }),
    async refreshShopData() { return { ok: true }; },
    updateShop() { return { ok: true }; },
    deleteShop() { return { ok: true }; },
    ...extra,
  };
}

function httpReq(port, method, path, { body, headers } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path, method,
      headers: {
        'content-type': 'application/json',
        ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
        ...(headers || {}),
      },
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function withServer(monitor, fn, opts) {
  const { server } = createUiServer(monitor, 0, opts);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await fn(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('读取链 AuthError：落 lastReadError/auth，行上 requiresLogin 且 Cookie 不再只显示有效', async (t) => {
  const { monitor } = setup(t);
  monitor._injectedReader.readCostSummary = async () => { throw new AuthError('登录失效，请重新登录'); };

  const r = await monitor.pollOnce('test');
  assert.equal(r.ok, true);
  const res = r.results[0];
  assert.equal(res.status, 'stopped');
  assert.equal(res.code, 'AUTH');

  const row = rowOf(monitor);
  assert.equal(row.requiresLogin, true);
  assert.equal(row.readHint, '登录已失效，请重新登录');
  assert.equal(row.adState, 'unknown');
  assert.equal(row.cookieInfo.found, true);
  assert.equal(row.cookieInfo.expired, false);
  assert.equal(row.activity, '登录已失效，等待重新扫码登录');

  const detail = monitor.getStatus().shops[0].lastReadError;
  assert.equal(detail.kind, 'auth');
  assert.equal(detail.requiresLogin, true);
  assert.equal(detail.retrying, false);
  assert.equal(detail.retryCount, 0);
  assert.equal(detail.loginUrlObserv, null);
});

test('读取链 AuthError 只补提示：不改 adBelief / 串行门', async (t) => {
  const { monitor } = setup(t);
  const belief = { on: false, at: '2026-01-01T00:00:00.000Z', evidence: '既有确认' };
  monitor.adBelief['shop-001'] = belief;
  monitor._injectedReader.readCostSummary = async () => { throw new AuthError('登录已失效，请重新登录'); };

  await monitor.pollOnce('test');

  assert.deepEqual(monitor.adBelief['shop-001'], belief);
  const slot = monitor._switchOrchestrator && typeof monitor._switchOrchestrator.peek === 'function'
    ? monitor._switchOrchestrator.peek('shop-001') : null;
  assert.equal(slot, null);
  assert.equal(rowOf(monitor).requiresLogin, true);
});

test('重新登录后成功读取：清除 requiresLogin 与提示，当前动作回到空闲', async (t) => {
  const { monitor } = setup(t);
  const orig = monitor._injectedReader.readCostSummary.bind(monitor._injectedReader);
  let calls = 0;
  monitor._injectedReader.readCostSummary = async (args) => {
    calls += 1;
    if (calls === 1) throw new AuthError('登录失效，请重新登录');
    return orig(args);
  };

  await monitor.pollOnce('test');
  assert.equal(rowOf(monitor).requiresLogin, true);

  // 第二次放行读取链；开启历史全店路径以通过控制范围门禁（mock 路径，不启动浏览器）。
  monitor.config.monitor.legacyWholeShopCloseEnabled = true;
  const r2 = await monitor.pollOnce('test');
  assert.equal(r2.results[0].status, 'ok');

  const row = rowOf(monitor);
  assert.equal(row.requiresLogin, false);
  assert.equal(row.readHint, null);
  assert.equal(row.activity, '空闲');
  assert.equal(monitor.getStatus().shops[0].lastReadError, null);
});

test('广告状态回读 DataGuardError：分类 read_failed，清除旧登录提示且不要求扫码', async (t) => {
  const { monitor } = setup(t);
  monitor.config.monitor.legacyWholeShopCloseEnabled = true;
  monitor._runtime('shop-001').lastReadError = {
    kind: 'auth', hint: '登录已失效，请重新登录', requiresLogin: true, reason: '旧登录失效',
  };
  monitor._readAdState = async () => { throw new DataGuardError('广告清单第 1 页 hasNext 缺失：清单不完整'); };

  const r = await monitor.pollOnce('test');
  assert.equal(r.results[0].status, 'blocked');
  assert.equal(r.results[0].blocked, 'inventory');

  const row = rowOf(monitor);
  assert.equal(row.requiresLogin, false);
  assert.equal(row.readHint, '读取失败');
  assert.equal(row.adState, 'unknown');

  const detail = monitor.getStatus().shops[0].lastReadError;
  assert.equal(detail.kind, 'read_failed');
  assert.equal(detail.requiresLogin, false);
});

test('Cookie 文件解析失败：不要求扫码、不落登录提示，Cookie 列按「缺失」显示', async (t) => {
  const { monitor, cookieDir } = setup(t);
  fs.writeFileSync(path.join(cookieDir, '测试店铺一.json'), 'not-a-json');

  const r = await monitor.pollOnce('test');
  assert.equal(r.results[0].status, 'stopped');
  assert.equal(r.results[0].code, 'AUTH');
  assert.match(r.results[0].reason, /Cookie 结构无效/);

  const row = rowOf(monitor);
  assert.equal(row.requiresLogin, false);
  // 读取链上的非登录类失败不补提示记录（本修复只覆盖登录失效）；
  // 这类情况的提示由 Cookie 列自身的「缺失」徽标给出。
  assert.equal(row.readHint, null);
  assert.equal(row.activity, '空闲');
  assert.equal(row.cookieInfo.found, false);
  assert.equal(monitor.getStatus().shops[0].lastReadError, null);
});

test('过期 Cookie 文件：shops/shopRows 均投影 found:true expired:true 并给最晚到期时间；默认加载仍拒过期', (t) => {
  const { monitor, cookieDir } = setup(t);
  const nowSec = Math.floor(Date.now() / 1000);
  const pastOld = nowSec - 7200;
  const pastLate = nowSec - 3600; // 文件内最晚到期时间（两条 fxg cookie 均已过期）
  fs.writeFileSync(path.join(cookieDir, '测试店铺一.json'), JSON.stringify([
    { name: 'sessionid', value: 'synthetic-expired-a', domain: '.jinritemai.com', path: '/', expires: pastOld },
    { name: 'csrftoken', value: 'synthetic-expired-b', domain: 'fxg.jinritemai.com', path: '/', expires: pastLate },
  ]));

  const st = monitor.getStatus();
  const shopInfo = st.shops[0].cookieInfo;
  assert.equal(shopInfo.found, true);
  assert.equal(shopInfo.expired, true);
  assert.equal(shopInfo.cookieCount, 2);
  assert.equal(shopInfo.maxExpires, pastLate * 1000, 'shops 投影保留文件内最晚到期时间');

  const row = st.shopRows.find((r) => r.id === 'shop-001');
  assert.equal(row.cookieInfo.found, true);
  assert.equal(row.cookieInfo.expired, true);
  assert.equal(row.cookieInfo.cookieCount, 2);
  assert.equal(row.cookieInfo.maxExpires, pastLate * 1000, 'shopRows 投影与 shops 同一规则');

  // 默认加载（执行端）拒过期行为不变：不提供 allowExpired 时抛 AuthError
  const { loadShopCookieMeta } = require('../src/login/session');
  assert.throws(
    () => loadShopCookieMeta({ cookieWorkDir: cookieDir }, { cookieFile: '测试店铺一' }),
    (e) => e instanceof AuthError
  );
});

test('正常 Cookie 文件兼容：投影 expired:false；requiresLogin 最高优先级不受文件到期状态影响', (t) => {
  const { monitor, cookieDir } = setup(t);
  const nowSec = Math.floor(Date.now() / 1000);
  const futureSec = nowSec + 86400;
  fs.writeFileSync(path.join(cookieDir, '测试店铺一.json'), JSON.stringify([
    { name: 'sessionid', value: 'synthetic-live', domain: '.jinritemai.com', path: '/', expires: futureSec },
  ]));
  // 平台登录态失效（读取链证据）：即使文件未到期，行上仍以 requiresLogin 为准
  monitor._runtime('shop-001').lastReadError = {
    kind: 'auth', hint: '登录已失效，请重新登录', requiresLogin: true, reason: '平台登录态失效',
  };

  const row = rowOf(monitor);
  assert.equal(row.requiresLogin, true, '会话失效提示保持最高优先级');
  assert.equal(row.readHint, '登录已失效，请重新登录');
  const ci = row.cookieInfo;
  assert.equal(ci.found, true);
  assert.equal(ci.expired, false, '未到期文件投影不误报过期');
  assert.equal(ci.maxExpires, futureSec * 1000, '正常文件保留最晚到期时间');
  const shopInfo = monitor.getStatus().shops[0].cookieInfo;
  assert.equal(shopInfo.found, true);
  assert.equal(shopInfo.expired, false);
});

test('主控制页渲染：文件到期三态文案（已过期/未到期/无固定到期时间）与最晚到期时间标注', async () => {
  await withServer(makeMonitor(), async (port) => {
    const page = await httpReq(port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.ok(page.body.includes("ci.expired ? '文件已过期' : '文件未到期'"), '过期/未到期分别给明确文案，不再称整个会话「有效」');
    assert.ok(page.body.includes('文件内最晚到期时间'), '日期明确标注为文件内最晚到期时间');
    assert.ok(page.body.includes('无固定到期时间'), '无可显示日期时给出中性文案');
    assert.ok(page.body.includes('不代表平台登录态'), '文案不推断登录是否有效');
    assert.ok(page.body.includes('fmtCookieExpire(ci.maxExpires)'), '到期时间渲染入口不变');
    assert.ok(page.body.includes("if (s.requiresLogin) {"), 'requiresLogin 徽标仍是最高优先级分支');
    assert.ok(page.body.includes('只读来源'), '只读来源提示保留');
    assert.ok(page.body.includes("timeZone: 'Asia/Shanghai'"), '到期时间保持北京时间');
  });
});

test('主控制页渲染：无固定日期独立分支用中性徽标，不称未到期、不断言会话型、不重复小字', async () => {
  await withServer(makeMonitor(), async (port) => {
    const page = await httpReq(port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('var expText = fmtCookieExpire(ci.maxExpires)'), '先取有效日期，无日期走独立分支');
    assert.ok(page.body.includes(": '无固定到期时间'"), '无日期徽标文案为无固定到期时间');
    assert.ok(
      page.body.includes("(expText ? (ci.expired ? 'unknown' : 'on') : 'off')"),
      '无日期使用中性徽标颜色'
    );
    assert.ok(page.body.includes("if (expText) {"), '有日期才追加时间小字，无日期不重复');
    assert.equal(page.body.includes('会话型（无固定到期）'), false, '不再断言一定是会话型');
  });
});

test('fix3 authClosure：结案/未结案固定文案且都不含扫码旁路', (t) => {
  const { monitor } = setup(t);
  const closed = monitor._readErrorHint({ authClosure: { authClosedOut: true } }, 'auth');
  const open = monitor._readErrorHint({ authClosure: { authClosedOut: false } }, 'auth');

  assert.equal(closed, '登录已失效（auth 已结案，不要求重新登录旁路）');
  assert.equal(open, '登录已失效（auth 未结案，不要求重新登录旁路）');
  assert.equal(closed.includes('扫码'), false);
  assert.equal(open.includes('扫码'), false);
  assert.equal(monitor._idleActivityText({ lastReadError: { requiresLogin: true, hint: closed } }), closed);
  assert.equal(monitor._idleActivityText({ lastReadError: { requiresLogin: true, hint: open } }), open);
});

test('发布/恢复租约在途优先：本轮 skipped，不读取也不落登录提示', async (t) => {
  const { monitor } = setup(t);
  monitor._publishLeaseExists = () => true;

  const r = await monitor.pollOnce('test');
  assert.equal(r.results[0].status, 'skipped');
  assert.ok(r.results[0].reason.includes('发布/恢复租约在途'));

  assert.equal(monitor.getStatus().shops[0].lastReadError, null);
  assert.equal(rowOf(monitor).requiresLogin, false);
  assert.equal(rowOf(monitor).activity, '空闲');
});

test('_readErrorHint 单一来源：四类固定文案与未知分类', (t) => {
  const { monitor } = setup(t);
  assert.equal(monitor._readErrorHint({}, 'auth'), '登录已失效，请重新登录');
  assert.equal(monitor._readErrorHint({}, 'cookie_invalid'), 'Cookie 缺失，请重新导入');
  assert.equal(monitor._readErrorHint({}, 'cookie_blocked'), 'Cookie 缺失，请重新导入');
  assert.equal(monitor._readErrorHint({}, 'identity'), '读取失败');
  assert.equal(monitor._readErrorHint({}, 'read_failed'), '读取失败');
  assert.equal(monitor._readErrorHint({}, 'timeout'), '读取超时，将自动重试');
  assert.equal(monitor._readErrorHint({}, 'retrying'), null);
  assert.equal(monitor._readErrorHint({}, 'unknown_kind'), null);
});

test('主控制页渲染：会话失效徽标 / 红色当前动作 / requiresLogin 分支', async () => {
  await withServer(makeMonitor(), async (port) => {
    const page = await httpReq(port, 'GET', '/');
    assert.equal(page.status, 200);
    assert.ok(page.body.includes('s.requiresLogin'), '行渲染按 requiresLogin 分支');
    assert.ok(page.body.includes('会话失效'), 'Cookie 列给出会话失效徽标');
    assert.ok(page.body.includes('#b42318'), '当前动作列使用红色');
    assert.ok(
      page.body.includes("actBusy = s.activity && s.activity !== '空闲' && !s.requiresLogin"),
      '忙碌判定排除登录失效'
    );
    // Cookie 列同时给出到期时间；无日期时由徽标给出「无固定到期时间」，不再只显示「有效/已过期」。
    assert.ok(page.body.includes('fmtCookieExpire(ci.maxExpires)'), 'Cookie 列渲染到期时间');
    assert.ok(page.body.includes('无固定到期时间'), '无固定到期时间由徽标给出，不附加重复小字');
  });
});

test('巡查遇到登录页但尚未确认失效：保留失败原因，后续成功后带着历史恢复记录跨重启', async (t) => {
  const { monitor, behavior, dataDir } = setup(t);
  const original = monitor._injectedReader.readCostSummary;
  const now = Date.parse('2026-11-28T00:16:16Z');
  let observedAt = now;
  monitor.nowFn = () => observedAt;
  const failure = new AuthError('千川视图读取遇到登录页或登录控件：尚未取得账户数据');
  monitor._injectedReader.readCostSummary = async () => { throw failure; };

  await monitor.pollOnce('test');
  let row = rowOf(monitor);
  assert.equal(row.requiresLogin, false);
  assert.deepEqual(row.readHistory, {
    lastOutcome: 'failure',
    lastFailure: { at: new Date(now).toISOString(), reason: failure.message, requiresLogin: false },
  });

  observedAt = now + 60_000;
  behavior.costFetchedAt = behavior.orderFetchedAt = behavior.adsFetchedAt = new Date(observedAt).toISOString();
  monitor._injectedReader.readCostSummary = original;
  monitor.config.monitor.legacyWholeShopCloseEnabled = true;
  const polled = await monitor.pollOnce('test');
  assert.equal(polled.results[0].status, 'ok', polled.results[0].reason);
  row = rowOf(monitor);
  assert.equal(row.readHistory.lastOutcome, 'success');
  assert.equal(row.readHistory.lastSuccessAt, new Date(now + 60_000).toISOString());
  assert.equal(row.readHistory.lastFailure.reason, failure.message);
  const restarted = new Monitor(monitor.cfgResult, null, { dataDir });
  const restartedRow = rowOf(restarted);
  assert.equal(restartedRow.lastDataAt, null);
  assert.deepEqual(restartedRow.readHistory, row.readHistory);
  assert.equal(restartedRow.requiresLogin, false);
});

test('启动时兼容原有巡查审计，忽略损坏记录并按店铺恢复成功和失败时间', (t) => {
  const { monitor, dataDir } = setup(t);
  const at = '2026-11-28T00:16:16.000Z';
  const success = '2026-11-28T01:04:06.000Z';
  fs.writeFileSync(monitor.auditFile, [
    JSON.stringify({ ts: at, kind: 'poll', shopId: 'shop-001', status: 'stopped', reason: '千川页面未取得数据' }),
    'invalid audit line',
    JSON.stringify({ ts: success, kind: 'poll', shopId: 'shop-001', status: 'ok' }),
    JSON.stringify({ ts: success, kind: 'poll', shopId: 'shop-002', status: 'stopped', reason: '其他店铺' }),
  ].join('\n'));
  const restarted = new Monitor(monitor.cfgResult, null, { dataDir });
  assert.deepEqual(rowOf(restarted).readHistory, {
    lastSuccessAt: success,
    lastOutcome: 'success',
    lastFailure: { at, reason: '千川页面未取得数据', requiresLogin: false },
  });
});
