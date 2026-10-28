'use strict';

/**
 * 隔离测试（第 3 阶段补验证）：每日开启预检回读有界结束 + 收口判定修正。
 * 修正点（针对原补丁三处缺口）：
 *   ① opener 尚未返回时超时（session=null）→ 旧 work 未 settle 不得放行新读取（原版误判 closed:true）；
 *   ② browser.close() 拒绝/未完成 → 不得标为已关闭（原版拒绝也置 done=true）；
 *   ③ close 完成但 work 仍不 settle → 仍保持阻断（原版只看 close 结果）。
 * 放行规则：下一次回读必须在「旧 work 已 settle 且本次涉及的浏览器会话全部严格关闭成功」之后
 * 才允许启动 opener；截止后返回的迟到会话由 onSession 立即严格关闭。
 * 不访问真实页面：乘方会话经 opts.chengfangOpener 注入假对象，每次 opener 新建会话；
 * browser.close 模拟 playwright（终止本会话全部在途页面调用）；页面调用在 browser.closed 后抛错。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor.js');
const { openQianchuanHome } = require('../src/adapters/qianchuan-reader');
const { createDefaultCandidateVerifier, restoreDutyWorkCopy } = require('../src/login/session');
const { DataGuardError } = require('../src/lib/errors');
const { makeTempDir, makeCfgResult } = require('./helpers.js');

const CFG_TIMEOUT = 300;      // 总截止时间（ms）
const CFG_CLOSE_WAIT = 200;   // 会话关闭限时（ms）
const CFG_SETTLE_WAIT = 300;  // work settle 证明限时（ms）
const TAB_MAIN = '全店托管';
const TAB_SUB = '商品自选';

/**
 * 假乘方会话工厂：每次 opener() 新建一个独立 browser/page/controller。
 * views[tab] = 分页列表（[{rows:[{id,switchChecked}], hasNext?}]，total 按 tab 自动累计）。
 * hangOn: 'readView'（第 1 次 readView 挂起，注册进 browser.hanging，可被 close 终止）
 *       | 'readView-detached'（第 1 次 readView 挂起且不注册——close 也杀不掉，需 fake.detachedReject）
 *       | 'identity'。
 * closeMode: 'ok'（close 成功并终止在途调用）| 'reject'（close 拒绝但终止在途调用）| 'never'（close 永不完成）。
 * sessionCloseFast: true 时会话额外带自有 close()（立即完成）——inner 的 finally 走 session.close
 * 而不被 browser.close 阻塞，用于构造「旧 work 先 settle、tracked 关闭仍在途」的确定性竞态。
 */
function makeFake({ shopId = 'shop-a', views, hangOn = null, closeMode = 'ok', sessionCloseFast = false } = {}) {
  const calls = { opener: 0, identity: 0, refresh: [], readView: [], switchView: [], clickNextPage: 0, click: 0 };
  const browsers = [];
  const out = { opener: null, calls, browsers, detachedReject: null };
  const opener = async () => {
    calls.opener += 1;
    const browser = { closed: false, hanging: [] };
    browsers.push(browser);
    const assertOpen = () => { if (browser.closed) throw new Error('Target page/context has been closed'); };
    const page = { browser: () => browser, evaluate: async () => null };
    const perTabPage = {};
    const controller = {
      async verifyIdentity() {
        calls.identity += 1;
        assertOpen();
        if (hangOn === 'identity') return new Promise((_, reject) => browser.hanging.push({ reject }));
        return { ok: true, pageShopId: shopId, pageShopName: shopId };
      },
      async refreshView({ tab }) { assertOpen(); calls.refresh.push(tab); return { refreshed: true }; },
      async switchView({ tab }) { assertOpen(); calls.switchView.push(tab); },
      async readView({ tab }) {
        assertOpen();
        calls.readView.push(tab);
        if (hangOn === 'readView' && calls.readView.length === 1) return new Promise((_, reject) => browser.hanging.push({ reject }));
        if (hangOn === 'readView-detached' && calls.readView.length === 1) {
          return new Promise((_, reject) => { out.detachedReject = reject; });
        }
        const list = views[tab] || [{ rows: [] }];
        const idx = Math.min(perTabPage[tab] || 0, list.length - 1);
        perTabPage[tab] = (perTabPage[tab] || 0) + 1;
        const p = list[idx];
        const total = views[tab].reduce((n, pg) => n + pg.rows.length, 0);
        return { rows: { rows: p.rows.map((r) => ({ ...r })) }, pagination: { total, hasNext: p.hasNext === true, activePage: String(idx + 1) } };
      },
      async clickNextPage() { assertOpen(); calls.clickNextPage += 1; return { clicked: true }; },
      async clickBatchPause() { assertOpen(); calls.click += 1; return {}; },
      async clickBatchEnable() { assertOpen(); calls.click += 1; return {}; },
      async clickRowSwitch() { assertOpen(); calls.click += 1; return {}; },
    };
    browser.close = async () => {
      if (closeMode === 'never') return new Promise(() => {});
      if (closeMode === 'reject') {
        for (const x of browser.hanging.splice(0)) x.reject(new Error('Target page/context has been closed'));
        throw new Error('模拟 close 拒绝');
      }
      browser.closed = true;
      for (const x of browser.hanging.splice(0)) x.reject(new Error('Target page/context has been closed'));
    };
    const session = { browser, page, controller, account: null, context: null, cookieSession: null };
    if (sessionCloseFast) session.close = async () => {}; // 自有 close 立即完成：inner 的 finally 不被 browser.close 阻塞
    return session;
  };
  out.opener = opener;
  return out;
}

const OK_VIEWS = { [TAB_MAIN]: [{ rows: [{ id: 'p1', switchChecked: true }] }], [TAB_SUB]: [{ rows: [] }] };

function buildMonitor({ dataDir, openerFn, timeoutMs = CFG_TIMEOUT, closeWaitMs = CFG_CLOSE_WAIT, settleWaitMs = CFG_SETTLE_WAIT }) {
  const cfgResult = makeCfgResult({
    shops: [
      { id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true },
      { id: 'shop-b', name: 'shop-b', cookieFile: 'shop-b', accountId: null, enabled: true },
    ],
    monitor: { legacyWholeShopCloseEnabled: true, chengfang: { scope: [TAB_MAIN, TAB_SUB], adStateReadTimeoutMs: timeoutMs, adStateCloseWaitMs: closeWaitMs, adStateSettleWaitMs: settleWaitMs } },
  });
  return new Monitor(cfgResult, null, { dataDir, chengfangOpener: openerFn });
}

function auditList(dataDir) {
  const p = path.join(dataDir, 'audit.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

test('T1 正常回读不退化：on / off / mixed / 多页清单 / 身份门禁（deadline 不改既有语义）', async () => {
  for (const [name, rows, expect] of [
    ['on', [{ id: 'p1', switchChecked: true }, { id: 'p2', switchChecked: true }], 'on'],
    ['off', [{ id: 'p1', switchChecked: false }], 'off'],
    ['mixed', [{ id: 'p1', switchChecked: true }, { id: 'p2', switchChecked: false }], 'mixed'],
  ]) {
    const dataDir = makeTempDir('stage3b-data-');
    const fake = makeFake({ shopId: 'shop-a', views: { [TAB_MAIN]: [{ rows }], [TAB_SUB]: [{ rows: [] }] } });
    const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
    const r = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
    assert.equal(r.state, expect, name);
    assert.equal(r.error, undefined, name);
    assert.equal(r.switchEvidence, null, name);
    assert.equal(fake.calls.click, 0, name);
  }
  {
    const dataDir = makeTempDir('stage3b-data-');
    const fake = makeFake({
      shopId: 'shop-a',
      views: {
        [TAB_MAIN]: [
          { rows: [{ id: 'p1', switchChecked: true }, { id: 'p2', switchChecked: true }], hasNext: true },
          { rows: [{ id: 'p3', switchChecked: true }, { id: 'p4', switchChecked: false }], hasNext: false },
        ],
        [TAB_SUB]: [{ rows: [] }],
      },
    });
    const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
    const r = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
    assert.equal(r.state, 'mixed');
    assert.equal(r.error, undefined);
    assert.equal(fake.calls.clickNextPage, 1);
  }
  {
    const dataDir = makeTempDir('stage3b-data-');
    const fake = makeFake({ shopId: 'shop-a', views: { [TAB_MAIN]: [{ rows: [] }], [TAB_SUB]: [{ rows: [] }] } });
    fake.controllerHack = null;
    const monitor = buildMonitor({
      dataDir,
      openerFn: async () => {
        const s = await fake.opener();
        s.controller.verifyIdentity = async () => ({ ok: false, reason: '模拟身份失败' });
        return s;
      },
    });
    const r = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
    assert.equal(r.state, 'unknown');
    assert.equal(r.error.blocked, 'identity');
    assert.equal(fake.calls.click, 0);
  }
});

test('N1 opener 永不返回：截止后有界返回 unknown；旧 work 未 settle 时新回读不再调用 opener；迟到会话被收口', async () => {
  const dataDir = makeTempDir('stage3b-data-');
  const fake = makeFake({ shopId: 'shop-a', views: OK_VIEWS });
  let releaseOpener = null;
  let openerCalls = 0;
  const gatePromise = new Promise((resolve) => { releaseOpener = resolve; });
  const monitor = buildMonitor({
    dataDir,
    openerFn: async (args) => {
      openerCalls += 1;
      if (openerCalls === 1) {
        const s = await gatePromise; // 模拟 opener 永不返回（直至测试释放）
        return s;
      }
      return fake.opener(args);
    },
  });
  const r1 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r1.state, 'unknown');
  assert.equal(r1.error.timeout, true);
  assert.equal(r1.error.cleanup, 'blocked', `cleanup=${r1.error.cleanup}`);
  assert.ok(/work 未 settle/.test(r1.error.reason), `reason=${r1.error.reason}`);
  assert.equal(openerCalls, 1, '截止时仅一次 opener 在途');
  // 旧 work 未 settle：新回读不得再调用 opener
  const r2 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r2.error.blockedBy, 'unread_session');
  assert.equal(openerCalls, 1, '旧 work 未 settle 时 opener 调用数不得增加');
  // 释放 opener：迟到会话必须被立即收口（不留无人管理的浏览器）
  releaseOpener(await fake.opener());
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fake.browsers[0].closed, true, '迟到会话必须被收口');
  assert.equal(fake.calls.opener, 1, '迟到会话经首次（已计数的）opener 调用建立');
  // work 已 settle 且会话已关闭 → 第三次回读放行并正常返回
  const r3 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r3.state, 'on');
  assert.equal(r3.error, undefined);
  assert.equal(openerCalls, 2, '放行后才允许第二次 opener');
  const evs = auditList(dataDir).filter((j) => j.kind === 'ad-state-read').map((j) => j.event);
  assert.ok(evs.includes('start') && evs.includes('deadline') && evs.includes('blocked'), JSON.stringify(evs));
});

test('N2 opener 在截止后才返回会话：迟到会话被收口，work settle 后才允许新读取', async () => {
  const dataDir = makeTempDir('stage3b-data-');
  const fake = makeFake({ shopId: 'shop-a', views: OK_VIEWS });
  const monitor = buildMonitor({
    dataDir,
    openerFn: async (args) => {
      if (fake.calls.opener === 0) {
        await new Promise((r) => setTimeout(r, 400)); // 晚于 300ms 截止
        return fake.opener(args);
      }
      return fake.opener(args);
    },
  });
  const r1 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r1.error.timeout, true, `r1=${JSON.stringify(r1.error)}`);
  assert.equal(fake.browsers[0].closed, true, '迟到会话必须被收口');
  assert.equal(fake.browsers.length, 1);
  // 迟到会话被关闭 → inner 抛 Target closed → work settle → 第二次回读放行（新会话）
  const r2 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r2.state, 'on');
  assert.equal(r2.error, undefined);
  assert.equal(fake.calls.opener, 2);
});

test('N3 browser.close() 拒绝：不得标为已关闭，不得开启新读取', async () => {
  const dataDir = makeTempDir('stage3b-data-');
  const fake = makeFake({ shopId: 'shop-a', views: OK_VIEWS, hangOn: 'readView', closeMode: 'reject' });
  const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
  const r1 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r1.error.timeout, true);
  assert.equal(r1.error.cleanup, 'blocked');
  assert.ok(/关闭失败/.test(r1.error.reason), `reason=${r1.error.reason}`);
  assert.equal(fake.browsers[0].closed, false, 'close 拒绝不得标为已关闭');
  const openerAfterR1 = fake.calls.opener;
  // 再次回读：阻断推进重试 close 仍拒绝 → 继续阻断，opener 不增加
  const r2 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r2.error.blockedBy, 'unread_session');
  assert.ok(/关闭失败/.test(r2.error.reason));
  assert.equal(fake.calls.opener, openerAfterR1, 'close 未成功前不得启动新会话');
  const evs = auditList(dataDir).filter((j) => j.kind === 'ad-state-read').map((j) => j.event);
  assert.ok(evs.includes('blocked'), JSON.stringify(evs));
});

test('N4 close 完成但旧 work 仍不 settle：保持阻断；work settle 后才放行', async () => {
  const dataDir = makeTempDir('stage3b-data-');
  const fake = makeFake({ shopId: 'shop-a', views: OK_VIEWS, hangOn: 'readView-detached', closeMode: 'ok' });
  const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
  const r1 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r1.error.timeout, true);
  assert.equal(r1.error.cleanup, 'blocked');
  assert.ok(/work 未 settle/.test(r1.error.reason), `reason=${r1.error.reason}`);
  assert.equal(fake.browsers[0].closed, true, '会话本身已关闭');
  const openerAfterR1 = fake.calls.opener;
  // close 已完成但 work 仍未 settle → 新回读必须保持阻断（不得凭浏览器已关闭放行）
  const r2 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r2.error.blockedBy, 'unread_session');
  assert.equal(fake.calls.opener, openerAfterR1, 'work 未 settle 不得启动新读取');
  // 释放旧 work → 第三次回读放行
  assert.ok(typeof fake.detachedReject === 'function', 'detached 挂起应可释放');
  fake.detachedReject(new Error('Target page/context has been closed'));
  const r3 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r3.state, 'on');
  assert.equal(r3.error, undefined);
  assert.equal(fake.calls.opener, openerAfterR1 + 1, 'work settle 后才允许新 opener');
});

test('N5 正常关闭且旧 work 已 settle：本轮 cleanup=closed、下一次读取放行（原 T2 语义）', async () => {
  const dataDir = makeTempDir('stage3b-data-');
  const fake = makeFake({ shopId: 'shop-a', views: OK_VIEWS, hangOn: 'readView', closeMode: 'ok' });
  const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
  const t0 = Date.now();
  const r1 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  const elapsed = Date.now() - t0;
  assert.equal(r1.state, 'unknown');
  assert.equal(r1.error.timeout, true);
  assert.equal(r1.error.cleanup, 'closed');
  assert.ok(/回读截止/.test(r1.error.reason));
  assert.ok(/read:全店托管:p1/.test(r1.error.lastStep), `lastStep=${r1.error.lastStep}`);
  assert.equal(fake.browsers[0].closed, true);
  assert.ok(elapsed < 10000, `elapsed=${elapsed}`);
  const r2 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r2.state, 'on');
  assert.equal(r2.error, undefined);
  const evs = auditList(dataDir).filter((j) => j.kind === 'ad-state-read').map((j) => j.event);
  assert.ok(evs.includes('start') && evs.includes('deadline'), JSON.stringify(evs));
});

test('T3 close 永不完成：不得标为已关闭、不得开启新读取（原 T3，语义更新为 cleanup=blocked）', async () => {
  const dataDir = makeTempDir('stage3b-data-');
  const fake = makeFake({ shopId: 'shop-a', views: OK_VIEWS, hangOn: 'readView', closeMode: 'never' });
  const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
  const r1 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r1.error.timeout, true);
  assert.equal(r1.error.cleanup, 'blocked');
  assert.ok(/work 未 settle/.test(r1.error.reason), `close 永不完成 → 挂起读取无法结束 → reason=${r1.error.reason}`);
  assert.equal(fake.browsers[0].closed, false);
  const openerAfterR1 = fake.calls.opener;
  const r2 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r2.error.blockedBy, 'unread_session');
  assert.equal(fake.calls.opener, openerAfterR1, '不得启动新会话');
  const evs = auditList(dataDir).filter((j) => j.kind === 'ad-state-read').map((j) => j.event);
  assert.ok(evs.includes('blocked'), JSON.stringify(evs));
});

test('T4 挂起不再挡互斥：A 店截止 fail-closed，B 店被处理，巡查可用，零点击', async () => {
  const dataDir = makeTempDir('stage3b-data-');
  const fakeA = makeFake({ shopId: 'shop-a', views: OK_VIEWS, hangOn: 'readView', closeMode: 'ok' });
  const fakeB = makeFake({ shopId: 'shop-b', views: OK_VIEWS });
  const monitor = buildMonitor({
    dataDir,
    openerFn: async (args) => (args.shopCfg.id === 'shop-a' ? fakeA.opener(args) : fakeB.opener(args)),
  });
  monitor.enableRunning = true;
  monitor._enableGen = 1;
  await monitor._runEnablePhase(1, '2026-09-29');
  const audits = auditList(dataDir);
  const decideA = audits.find((j) => j.event === 'daily-decide' && j.shopId === 'shop-a');
  const skipA = audits.find((j) => j.event === 'skipped-zero-click' && j.shopId === 'shop-a');
  const decideB = audits.find((j) => j.event === 'daily-decide' && j.shopId === 'shop-b');
  assert.ok(decideA && decideA.currentAdState === 'unknown' && decideA.decision === 'unknown_blocked');
  assert.equal(decideA.readError && decideA.readError.timeout, true, `readError=${JSON.stringify(decideA.readError)}`);
  assert.ok(skipA, 'A 店应有 skipped-zero-click（零点击）');
  assert.ok(skipA.readError && skipA.readError.timeout === true);
  assert.ok(decideB && decideB.currentAdState === 'on' && decideB.decision === 'already_on', 'B 店必须被处理');
  assert.equal(monitor._cycleRunning, false, '互斥应已释放');
  assert.equal(fakeA.calls.click + fakeB.calls.click, 0, '零广告点击');
  const po = await monitor.pollOnce('manual-offline-check');
  assert.notEqual(po.reason, '已有轮询周期进行中，本次已跳过（防并发）');
  const rec = monitor.getEnablePhaseRecord('shop-a', '2026-09-29');
  assert.equal(rec.status, 'failed');
  assert.equal(rec.phase, 'precheck');
  monitor.stop();
});

test('T5 审计区分两类 unknown：readError（带 error）与 readNote（开关不可识别、无 error）', async () => {
  {
    const dataDir = makeTempDir('stage3b-data-');
    const fake = makeFake({ shopId: 'shop-a', views: OK_VIEWS });
    fake.controllerHack = true;
    const monitor = buildMonitor({
      dataDir,
      openerFn: async () => {
        const s = await fake.opener();
        s.controller.refreshView = async () => { throw new Error('模拟刷新失败'); };
        return s;
      },
    });
    monitor.enableRunning = true;
    monitor._enableGen = 1;
    await monitor._runEnablePhase(1, '2026-09-29');
    const d = auditList(dataDir).find((j) => j.event === 'daily-decide');
    assert.equal(d.currentAdState, 'unknown');
    assert.equal(d.readError.blocked, 'inventory');
    assert.equal(d.readNote, null);
    monitor.stop();
  }
  {
    const dataDir = makeTempDir('stage3b-data-');
    const fake = makeFake({ shopId: 'shop-a', views: { [TAB_MAIN]: [{ rows: [{ id: 'p1', switchChecked: true }, { id: 'p2', switchChecked: null }] }], [TAB_SUB]: [{ rows: [] }] } });
    const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
    monitor.enableRunning = true;
    monitor._enableGen = 1;
    await monitor._runEnablePhase(1, '2026-09-29');
    const d = auditList(dataDir).find((j) => j.event === 'daily-decide');
    assert.equal(d.currentAdState, 'unknown');
    assert.equal(d.readError, null);
    assert.ok(d.readNote && d.readNote.kind === 'unrecognized_switches' && d.readNote.rowsTotal === 2 && d.readNote.unrecognizedRows === 1, `readNote=${JSON.stringify(d.readNote)}`);
    const s = auditList(dataDir).find((j) => j.event === 'skipped-zero-click');
    assert.ok(s.readNote && s.readNote.unrecognizedRows === 1);
    monitor.stop();
  }
  {
    const dataDir = makeTempDir('stage3b-data-');
    const fake = makeFake({ shopId: 'shop-a', views: OK_VIEWS });
    const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
    monitor.enableRunning = true;
    monitor._enableGen = 1;
    await monitor._runEnablePhase(1, '2026-09-29');
    const d = auditList(dataDir).find((j) => j.event === 'daily-decide' && j.shopId === 'shop-a');
    assert.equal(d.currentAdState, 'on');
    assert.equal(d.readError, null);
    assert.equal(d.readNote, null);
    monitor.stop();
  }
});

test('N6 竞态复现：迟到会话 + 关闭永不完成 + 旧 work 先 settle → 不得凭空/未完成列表放行（v2 缺陷回归）', async () => {
  // v2 缺陷：onSession 迟到分支只在关闭 promise 完成后才向 closes 加条目——旧 work 先 settle 时
  // 超时收口路径看到空列表 → allClosed=true → 放行 → 第二次回读调用 opener（主脑复现场景）。
  // v3：关闭一发起就同步登记为 pending（closed:null），空/未完成列表一律不放行。
  const dataDir = makeTempDir('stage3b-data-');
  // 迟到会话：browser.close 永不完成（tracked 关闭永远在途），但会话自有 close() 立即完成——
  // inner 的 finally 走 session.close 不被阻塞 → 旧 work 在 tracked 关闭完成前先 settle。
  // v2 只在关闭完成后才登记 → 判定时列表为空 → 误判全部已关闭并放行（主脑复现的确定性等价构造）；
  // v3 发起即登记 pending（closed:null）→ 必须保持阻断。
  const fake = makeFake({ shopId: 'shop-a', views: OK_VIEWS, closeMode: 'never', sessionCloseFast: true });
  let releaseOpener = null;
  let openerCalls = 0;
  const gatePromise = new Promise((resolve) => { releaseOpener = resolve; });
  const monitor = buildMonitor({
    dataDir,
    openerFn: async (args) => {
      openerCalls += 1;
      if (openerCalls === 1) {
        const s = await gatePromise; // opener 挂起，跨过 300ms 截止后才释放
        return s;
      }
      return fake.opener(args);
    },
    closeWaitMs: 2000,
  });
  // r1：截止时 session 未建立 → work 未 settle → blocked + 阻断门（此刻 closes 为空）
  const r1 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r1.error.timeout, true);
  assert.equal(r1.error.cleanup, 'blocked');
  assert.ok(/work 未 settle/.test(r1.error.reason), `reason=${r1.error.reason}`);
  assert.equal(openerCalls, 1);
  // 释放 opener：迟到会话返回，其 close 永不完成；inner 因会话仍可用而正常走完 → work 先 settle
  releaseOpener(await fake.opener());
  await new Promise((r) => setTimeout(r, 120));
  // 第二次回读：门禁必须看到「在途的迟到关闭」（v3 同步登记），不得凭空列表放行
  const r2 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r2.error && r2.error.blockedBy, 'unread_session', `v2 缺陷表现：r2 未被阻断（state=${r2.state}）；v3 reason=${r2.error && r2.error.reason}`);
  assert.equal(openerCalls, 1, '旧关闭未完成时 opener 调用数不得增加');
  // 多次推进阻断门仍不得绕过/丢失在途关闭
  const r3 = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r3.error && r3.error.blockedBy, 'unread_session');
  assert.equal(openerCalls, 1, '多次推进后仍不得启动新 opener');
  const evs = auditList(dataDir).filter((j) => j.kind === 'ad-state-read').map((j) => j.event);
  assert.ok(evs.includes('blocked'), JSON.stringify(evs));
});

// ── D22R 回读截止协作取消令牌（全离线：脚本化浏览器桩，零真实浏览器/网络/凭证）──────
// 修复前缺陷（源码核实）：读取截止只是 Promise.race，真实生产开启链
// （monitor → defaultChengfangOpener → openChengfangShop → openQianchuanHome → 恢复链
// 逐候选全新浏览器进程）看不到任何取消信号：截止后仍继续启动新的店铺/候选进程
// （5+5 候选可远超父窗口），work 长期不 settle → 收口门拿不到真实关闭证明 →
// 店铺无限期 unknown（生产观测：回读截止（300000ms）已到：work 未 settle；最后步骤：session-open）。

const CT_FXG_HOME = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const CT_LOGIN_URL = 'https://fxg.jinritemai.com/ffa/login/expired';
const CT_SHOP = '取消店';

function ctCookieBytes(tag) {
  return Buffer.from(JSON.stringify([
    { name: 'sessionid', value: `fake-${tag}-synthetic`, domain: '.jinritemai.com', path: '/', expires: 1893456000 },
  ], null, 2), 'utf8');
}

function ctStubBrowserFactory({ url, counters, onWaitForTimeout }) {
  return async () => {
    counters.launches += 1;
    const id = counters.launches;
    const browser = { __id: id, __closed: false };
    browser.newContext = async () => ({
      addCookies: async () => { counters.addCookies += 1; },
      newPage: async () => ({
        url: () => url,
        goto: async () => {},
        // 可选测试钩子：未注入（undefined）时保持既有 async noop 行为不变；
        // 注入时先同步回调再返回，供确定性编排「deadline 落在某次等待期间」。
        waitForTimeout: async (ms) => { if (typeof onWaitForTimeout === 'function') onWaitForTimeout(ms); },
        isClosed: () => false,
        evaluate: async () => null,
        close: async () => {},
        getByText: () => ({ count: async () => 0, first: () => ({ waitFor: async () => { throw new Error('stub: not attached'); } }) }),
        locator: () => ({ first: () => ({ textContent: async () => '', isVisible: async () => false, count: async () => 0 }) }),
        waitForURL: () => Promise.resolve(null),
        waitForFunction: async () => {},
        screenshot: async () => {},
        context: () => null,
        on() {}, off() {},
      }),
      close: async () => {},
      cookies: async () => [],
      waitForEvent: () => Promise.resolve(null),
      on() {}, off() {},
    });
    browser.close = async () => {
      if (!browser.__closed) { browser.__closed = true; counters.browserCloses += 1; }
    };
    browser.isConnected = () => !browser.__closed;
    return browser;
  };
}

test('C1 monitor 透传：真实 opener 调用参数携带 cancelToken，截止触发时 cancelled=true', async () => {
  const dataDir = makeTempDir('stage3b-cancel-token-');
  let captured = null;
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const opener = async (args) => {
    captured = args;
    await gate; // 模拟 session-open 长期不返回（生产观测场景）
    return { close: async () => {}, browser: null, page: {}, controller: {} };
  };
  const monitor = buildMonitor({ dataDir, openerFn: opener, timeoutMs: 150, closeWaitMs: 100, settleWaitMs: 100 });
  const r = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r.state, 'unknown');
  assert.equal(r.error.timeout, true);
  assert.ok(captured && captured.cancelToken && typeof captured.cancelToken === 'object',
    '真实 opener 调用参数必须携带 cancelToken 对象');
  assert.equal(captured.cancelToken.cancelled, true, '截止触发后令牌必须翻转 cancelled=true');
  assert.ok(/read-deadline/.test(String(captured.cancelToken.reason)));
  release(); // 释放挂起的 opener：迟到会话（close 立即完成）由外壳收口
  await new Promise((r2) => setTimeout(r2, 60));
});

test('C2 已取消令牌：openQianchuanHome 零浏览器启动、零 addCookies，如实抛 DataGuardError', async () => {
  const dir = makeTempDir('stage3b-cancel-qc-');
  fs.writeFileSync(path.join(dir, `${CT_SHOP}.json`), ctCookieBytes('workcopy'));
  const counters = { launches: 0, addCookies: 0, browserCloses: 0 };
  await assert.rejects(
    () => openQianchuanHome(
      { cookieWorkDir: dir, edgePath: null },
      { id: 's1', name: CT_SHOP, compassShopName: CT_SHOP, cookieFile: CT_SHOP, accountId: 'a1' },
      {
        browserFactory: ctStubBrowserFactory({ url: CT_FXG_HOME, counters }),
        settleTimeoutMs: 50, settleIntervalMs: 10,
        readinessTimeoutMs: 50, readinessIntervalMs: 10,
        nowFn: () => 20000,
        cancelToken: { cancelled: true, reason: 'read-deadline' },
      },
    ),
    (e) => {
      assert.ok(e instanceof DataGuardError, `应为 DataGuardError：${e && e.message}`);
      assert.ok(/协作取消/.test(String(e && e.message)), `错误须如实说明协作取消：${e && e.message}`);
      return true;
    },
  );
  assert.equal(counters.launches, 0, '取消后绝不允许再启动任何浏览器进程');
  assert.equal(counters.addCookies, 0, '取消后零 Cookie 注入');
});

test('C3 交错：截止落在初始登录收敛期间 → 恢复链不启动（零候选进程/零恢复调用）', async () => {
  const dir = makeTempDir('stage3b-cancel-interleave-');
  fs.writeFileSync(path.join(dir, `${CT_SHOP}.json`), ctCookieBytes('expired'));
  const counters = { launches: 0, addCookies: 0, browserCloses: 0 };
  let restoreCalls = 0;
  const cancelToken = { cancelled: false, reason: null };
  let settleWaitTriggers = 0;
  // deadline 确定性落在初始 SSO 收敛等待期间（settle 100ms/间隔 10ms）：
  // waitForDoudianHomepageSettled 的每轮等待即 page.waitForTimeout(10)，
  // 首次 ms===10 时一次性翻转令牌；初始打开的固定 5000ms 等待不得提前触发取消。
  const onWaitForTimeout = (ms) => {
    if (ms === 10 && cancelToken.cancelled !== true) {
      settleWaitTriggers += 1;
      cancelToken.cancelled = true;
      cancelToken.reason = 'read-deadline';
    }
  };
  await assert.rejects(
    () => openQianchuanHome(
      { cookieWorkDir: dir, edgePath: null },
      { id: 's2', name: CT_SHOP, compassShopName: CT_SHOP, cookieFile: CT_SHOP, accountId: 'a2' },
      {
        browserFactory: ctStubBrowserFactory({ url: CT_LOGIN_URL, counters, onWaitForTimeout }),
        settleTimeoutMs: 100, settleIntervalMs: 10,
        readinessTimeoutMs: 50, readinessIntervalMs: 10,
        restoreRunner: async () => { restoreCalls += 1; return { ok: false, reason: '桩不应被调用' }; },
        nowFn: () => 20000,
        cancelToken,
      },
    ),
    (e) => {
      assert.ok(/协作取消/.test(String(e && e.message)), `登录失效恢复前必须被协作取消截停：${e && e.message}`);
      return true;
    },
  );
  assert.equal(settleWaitTriggers, 1, '令牌应恰好在首次 SSO settle 间隔等待（ms===10）被翻转一次，且不被 5000ms 初始等待触发');
  assert.equal(restoreCalls, 0, '截止后恢复链绝不允许启动');
  assert.equal(counters.launches, 1, '只有截止前的初始店铺浏览器；零候选/重载进程');
  assert.equal(counters.browserCloses, 1, '已创建的初始进程必须照常收口关闭');
});

test('C4 内层候选工厂通用取消门：令牌翻转后再次调用工厂必须拒绝启动（注入恢复器拿到的即被门卫包装的工厂）', async () => {
  const dir = makeTempDir('stage3b-cancel-inner-factory-');
  fs.writeFileSync(path.join(dir, `${CT_SHOP}.json`), ctCookieBytes('expired'));
  const counters = { launches: 0, addCookies: 0, browserCloses: 0 };
  const cancelToken = { cancelled: false, reason: null };
  let guardedFactory = null;
  let secondThrew = null;
  const restoreRunner = async (_loginCfg, _cookieFile, ropts) => {
    guardedFactory = ropts.candidateBrowserFactory;
    const a = await guardedFactory(); await a.close();
    cancelToken.cancelled = true; cancelToken.reason = 'read-deadline';
    try { const b = await guardedFactory(); await b.close(); secondThrew = false; }
    catch (e) { secondThrew = e; }
    return { ok: false, reason: 'synthetic' };
  };
  await assert.rejects(
    () => openQianchuanHome(
      { cookieWorkDir: dir, edgePath: null },
      { id: 's4', name: CT_SHOP, compassShopName: CT_SHOP, cookieFile: CT_SHOP, accountId: 'a4' },
      {
        browserFactory: ctStubBrowserFactory({ url: CT_LOGIN_URL, counters }),
        settleTimeoutMs: 100, settleIntervalMs: 10,
        readinessTimeoutMs: 50, readinessIntervalMs: 10,
        restoreRunner,
        nowFn: () => 20000,
        cancelToken,
      },
    ),
    () => true, // 恢复失败后既有语义抛 AuthError（登录失效）；本用例只关心内层工厂门
  );
  assert.ok(typeof guardedFactory === 'function', '注入恢复器必须收到候选浏览器工厂（被取消门卫包装）');
  assert.ok(secondThrew instanceof DataGuardError, `取消后再次调用工厂必须抛 DataGuardError 而不是启动新进程：${secondThrew && secondThrew.message}`);
  assert.equal(counters.launches, 2, '只有截止前的初始店铺浏览器 + 1 次候选进程；取消后零新进程');
  assert.equal(counters.browserCloses, 2, '已创建进程照常收口（初始店铺进程 + 候选进程）');
});

test('C5 默认验证器：取消发生在工厂 await 期间 → verify-error + stopChain、零 addCookies、自有新进程收口一次', async () => {
  const counters = { launches: 0, addCookies: 0, browserCloses: 0 };
  const token = { cancelled: false, reason: null };
  const base = ctStubBrowserFactory({ url: CT_FXG_HOME, counters });
  const verifier = createDefaultCandidateVerifier({}, {
    cancelToken: token,
    candidateBrowserFactory: async () => { token.cancelled = true; token.reason = 'read-deadline'; return base(); },
    verifySettleTimeoutMs: 3, verifySettleIntervalMs: 1,
  });
  const r = await verifier({
    cookies: JSON.parse(ctCookieBytes('cand').toString('utf8')),
    expectedShopNames: [CT_SHOP],
    source: 'guard-recovery',
  });
  assert.equal(r.ok, false);
  assert.equal(r.classification, 'verify-error', `取消不得被判成 login-invalid：${r.reason}`);
  assert.equal(r.stopChain, true, '取消必须停止恢复链');
  assert.equal(counters.launches, 1);
  assert.equal(counters.addCookies, 0, '取消后零 Cookie 注入');
  assert.equal(counters.browserCloses, 1, '自有新进程必须收口恰好一次');
});

test('C6 已取消令牌 + 工厂返回外来（禁止）实例：先按外来所有权拒绝，绝不因取消关闭外来进程', async () => {
  const counters = { launches: 0, addCookies: 0, browserCloses: 0 };
  const token = { cancelled: false, reason: null };
  const base = ctStubBrowserFactory({ url: CT_FXG_HOME, counters });
  const foreign = await base(); // 外来所有者实例（如主店铺浏览器），模拟仍在业务使用
  const closesBefore = counters.browserCloses;
  const verifier = createDefaultCandidateVerifier({}, {
    cancelToken: token,
    candidateBrowserFactory: async () => { token.cancelled = true; token.reason = 'read-deadline'; return foreign; },
    forbiddenBrowsers: [foreign],
    verifySettleTimeoutMs: 3, verifySettleIntervalMs: 1,
  });
  const r = await verifier({
    cookies: JSON.parse(ctCookieBytes('foreign').toString('utf8')),
    expectedShopNames: [CT_SHOP],
    source: 'guard-recovery',
  });
  assert.equal(r.classification, 'verify-error');
  assert.equal(r.stopChain, true);
  assert.equal(counters.addCookies, 0);
  assert.equal(counters.browserCloses, closesBefore, '绝不因取消关闭外来/禁止实例（所有权在原所有者）');
  const r2 = await verifier({ cookies: [], expectedShopNames: [CT_SHOP] });
  assert.equal(r2.stopChain, true, '外来实例拒绝后闩锁：后续候选不再启动');
  await foreign.close(); // 测试自有桩资源收口
});

test('C7 恢复链注入验证器翻转取消令牌后返回 login-invalid：不写失败史、不提升；同一候选随后仍可被验证', async () => {
  const dir = makeTempDir('stage3b-cancel-restore-history-');
  fs.writeFileSync(path.join(dir, `${CT_SHOP}.json`), ctCookieBytes('hist'));
  const loginCfg = {};
  const shopCfg = { id: 'h1', name: CT_SHOP, compassShopName: CT_SHOP, cookieFile: CT_SHOP };
  const token1 = { cancelled: false, reason: null };
  const r1 = await restoreDutyWorkCopy(loginCfg, `${CT_SHOP}.json`, {
    shopCfg,
    workDir: dir,
    cancelToken: token1,
    verify: async () => {
      token1.cancelled = true; token1.reason = 'read-deadline';
      return { ok: false, classification: 'login-invalid', reason: 'stub-flip-after-cancel' };
    },
    nowFn: () => 20000,
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.cancelled, true, '恢复链必须如实标记被协作取消');
  assert.ok((r1.attempts || []).some((a) => a.result === 'cancelled'), 'attempts 应记录 cancelled，而不是把取消伪装成登录失效');
  // 第二次调用（新令牌、同一 loginCfg 对象、工作副本字节未变）：若取消路径的
  // login-invalid 被写入失败史，同一候选会被历史跳过、验证器零调用。
  let verifyCalls = 0;
  const r2 = await restoreDutyWorkCopy(loginCfg, `${CT_SHOP}.json`, {
    shopCfg,
    workDir: dir,
    cancelToken: { cancelled: false, reason: null },
    verify: async () => { verifyCalls += 1; return { ok: false, classification: 'login-invalid', reason: 'stub-plain' }; },
    nowFn: () => 20001,
  });
  assert.equal(r2.ok, false);
  assert.ok(verifyCalls >= 1, `取消路径的 login-invalid 不得投毒失败史：同一候选随后仍必须被验证（calls=${verifyCalls}）`);
});
