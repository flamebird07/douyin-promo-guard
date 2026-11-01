'use strict';

/**
 * 2026-10-19 AD-WATCHDOG-BOOT-ENABLE 缺口 B 判别性测试：
 * - ad-state-read done=error 审计必须携带脱敏后的 status/kind/blocked/reason/lastStep；
 * - 每日开启相位的 readError 与页面 lastReadError 必须保留分类/原因/最后步骤；
 * - 本轮读取成功后清除旧错误（相位与页面均不得残留上一轮失败详情）；
 * - 瞬态/导航失败不得被误标为 auth；Cookie/token/sessionid 等值不落盘（state.json/audit.jsonl）。
 * 全程离线：乘方会话由假 opener 注入，零真实页面/网络访问。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor.js');
const { makeTempDir, makeCfgResult } = require('./helpers.js');

const TAB_MAIN = '全店托管';
const TAB_SUB = '商品自选';
const RAW_TOKEN = 'SECRETTOKEN123456';
const RAW_SESSION = 'SESSID987654';
const RAW_COOKIE = 'COOKIEVALUE123456';
const RAW_TOKEN2 = 'TOKENVALUE654321';

const OFF_VIEWS = { [TAB_MAIN]: [{ rows: [{ id: 'p1', switchChecked: false }] }], [TAB_SUB]: [{ rows: [] }] };

/** 假乘方会话：controller 可逐方法覆盖（例如让 refreshView 抛错并计数）。 */
function makeFake({ shopId = 'shop-a', views = OFF_VIEWS, overrides = {} } = {}) {
  const calls = { opener: 0, identity: 0, readView: 0, click: 0 };
  const opener = async () => {
    calls.opener += 1;
    const browser = { closed: false };
    const page = { browser: () => browser, evaluate: async () => null };
    const perTabPage = {};
    const controller = {
      async verifyIdentity() {
        calls.identity += 1;
        if (browser.closed) throw new Error('Target closed');
        return { ok: true, pageShopId: shopId, pageShopName: shopId };
      },
      async refreshView() { if (browser.closed) throw new Error('Target closed'); return { refreshed: true }; },
      async switchView() { if (browser.closed) throw new Error('Target closed'); },
      async readView({ tab }) {
        calls.readView += 1;
        if (browser.closed) throw new Error('Target closed');
        const list = views[tab] || [{ rows: [] }];
        const p = list[Math.min(perTabPage[tab] || 0, list.length - 1)];
        perTabPage[tab] = (perTabPage[tab] || 0) + 1;
        const total = views[tab].reduce((n, pg) => n + pg.rows.length, 0);
        return { rows: { rows: p.rows.map((x) => ({ ...x })) }, pagination: { total, hasNext: p.hasNext === true, activePage: '1' } };
      },
      async clickNextPage() { calls.click += 1; return { clicked: true }; },
      async clickBatchPause() { calls.click += 1; return {}; },
      async clickBatchEnable() { calls.click += 1; return {}; },
      async clickRowSwitch() { calls.click += 1; return {}; },
    };
    Object.assign(controller, overrides);
    browser.close = async () => { browser.closed = true; };
    return { browser, page, controller, account: null, context: null, cookieSession: null };
  };
  return { opener, calls };
}

function buildMonitor({ dataDir, openerFn = null, readAdState = null }) {
  const cfgResult = makeCfgResult({
    shops: [{ id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true }],
    monitor: {
      chengfang: {
        scope: [TAB_MAIN, TAB_SUB],
        adStateReadTimeoutMs: 800,
        adStateCloseWaitMs: 200,
        adStateSettleWaitMs: 300,
      },
    },
  });
  const opts = { dataDir };
  if (openerFn) opts.chengfangOpener = openerFn;
  if (readAdState) opts.readAdState = readAdState;
  return new Monitor(cfgResult, null, opts);
}

function auditList(dataDir) {
  const p = path.join(dataDir, 'audit.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

function readStateFile(dataDir) {
  return fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8');
}

test('D1 done=error 审计：携带脱敏 status/kind/blocked/reason/lastStep，瞬态失败不误标 auth', async () => {
  const dataDir = makeTempDir('read-detail-done-');
  let refreshCalls = 0;
  const fake = makeFake({
    overrides: {
      async refreshView() {
        refreshCalls += 1;
        if (refreshCalls === 1) {
          // 可安全重读的瞬态错误 + 敏感值：必须重试，且不得标为 auth。
          throw new Error(`导航"乘方"未到达管理页 token=${RAW_TOKEN} sessionid=${RAW_SESSION}`);
        }
        throw new Error(`读取被拒绝 cookie=${RAW_COOKIE} token=${RAW_TOKEN2}`);
      },
    },
  });
  const monitor = buildMonitor({ dataDir, openerFn: fake.opener });
  const r = await monitor._readCurrentAdState({ id: 'shop-a', name: 'shop-a' });
  assert.equal(r.state, 'unknown');
  assert.ok(r.error, '应返回读取错误');
  assert.equal(r.error.retried, true, '首个瞬态错误应触发一次同一周期重读');

  const doneErrors = auditList(dataDir).filter((j) => j.kind === 'ad-state-read' && j.event === 'done' && j.outcome === 'error');
  assert.equal(doneErrors.length, 2, `两次尝试都应留下 done=error，实际 ${doneErrors.length}`);
  for (const d of doneErrors) {
    assert.equal(d.status, 'blocked');
    assert.equal(d.kind, 'ad-state-read');
    assert.equal(d.blocked, 'inventory');
    assert.equal(d.lastStep, `refresh:${TAB_MAIN}`, `lastStep=${d.lastStep}`);
    assert.ok(d.reason && d.reason.length > 0, '必须保留脱敏原因');
    // 分类写入 done 审计（与页面同源）：瞬态导航失败是 read_failed，不是 auth。
    assert.equal(d.errorKind, 'read_failed', `errorKind=${d.errorKind}`);
  }
  const raw = fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8');
  assert.equal(raw.includes(RAW_TOKEN), false, 'token 原值不得落盘');
  assert.equal(raw.includes(RAW_SESSION), false, 'sessionid 原值不得落盘');
  assert.equal(raw.includes(RAW_COOKIE), false, 'cookie 原值不得落盘');
  assert.equal(raw.includes(RAW_TOKEN2), false, '第二个 token 原值不得落盘');
  monitor.stop();
});

test('D2 相位/页面错误详情保留，成功后清除；敏感值不落盘', async () => {
  const dataDir = makeTempDir('read-detail-phase-');
  let mode = 'error';
  const monitor = buildMonitor({
    dataDir,
    readAdState: async () => {
      if (mode === 'on') {
        return { state: 'on', identity: { ok: true }, rows: [{ id: 'p1', switchChecked: true }] };
      }
      return {
        state: 'unknown',
        identity: { ok: true },
        error: {
          status: 'blocked',
          blocked: 'inventory',
          reason: `导航失败 cookie=${RAW_COOKIE} token=${RAW_TOKEN2}`,
          lastStep: `read:${TAB_MAIN}:p1`,
        },
      };
    },
  });
  monitor.enableRunning = true;
  monitor._enableGen = 1;

  await monitor._runEnablePhase(1, '2026-09-29');
  const rec = monitor.getEnablePhaseRecord('shop-a', '2026-09-29');
  assert.equal(rec.status, 'failed');
  assert.equal(rec.phase, 'precheck');
  assert.ok(rec.readError, '相位记录必须保留 readError');
  assert.equal(rec.readError.kind, 'read_failed', '导航失败不得冒充 auth');
  assert.equal(rec.readError.blocked, 'inventory');
  assert.equal(rec.readError.lastStep, `read:${TAB_MAIN}:p1`);
  assert.ok(/cookie=\*\*\*/.test(rec.readError.reason), `reason 应脱敏，实际 ${rec.readError.reason}`);
  assert.ok(/token=\*\*\*/.test(rec.readError.reason), `reason 应脱敏，实际 ${rec.readError.reason}`);

  const status1 = monitor.getStatus().shops.find((s) => s.id === 'shop-a');
  assert.ok(status1.lastReadError, '页面必须有 lastReadError');
  assert.equal(status1.lastReadError.kind, 'read_failed');
  assert.equal(status1.lastReadError.lastStep, `read:${TAB_MAIN}:p1`);
  assert.equal(status1.lastReadError.reason.includes(RAW_COOKIE), false);
  assert.equal(status1.lastReadError.reason.includes(RAW_TOKEN2), false);
  assert.ok(/cookie=\*\*\*/.test(status1.lastReadError.reason));
  assert.equal(String(status1.lastError || '').includes(RAW_TOKEN2), false, 'lastError 同样不得含原值');

  // 审计（daily-decide / skipped-zero-click）也必须脱敏，不得落盘原值。
  const audits = auditList(dataDir);
  const decide = audits.find((j) => j.event === 'daily-decide' && j.shopId === 'shop-a');
  assert.ok(decide && decide.readError, 'daily-decide 必须带 readError');
  assert.equal(decide.readError.kind, 'read_failed');
  assert.equal(decide.readError.lastStep, `read:${TAB_MAIN}:p1`);
  const skip = audits.find((j) => j.event === 'skipped-zero-click' && j.shopId === 'shop-a');
  assert.ok(skip && skip.readError, 'skipped-zero-click 必须带 readError');
  assert.equal(skip.readError.kind, 'read_failed');
  const rawAudit = fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8');
  assert.equal(rawAudit.includes(RAW_TOKEN2), false);
  assert.equal(rawAudit.includes(RAW_COOKIE), false);
  const rawState = readStateFile(dataDir);
  assert.equal(rawState.includes(RAW_TOKEN2), false, 'state.json 不得含 token 原值');
  assert.equal(rawState.includes(RAW_COOKIE), false, 'state.json 不得含 cookie 原值');

  // 下一轮读取成功：相位与页面错误详情都必须清除（不得残留旧失败原因）。
  mode = 'on';
  await monitor._runEnablePhase(1, '2026-09-29');
  const rec2 = monitor.getEnablePhaseRecord('shop-a', '2026-09-29');
  assert.equal(rec2.status, 'success');
  assert.equal(rec2.readError, null, `成功后相位 readError 应清空，实际 ${JSON.stringify(rec2.readError)}`);
  const status2 = monitor.getStatus().shops.find((s) => s.id === 'shop-a');
  assert.equal(status2.lastReadError, null, '成功后页面 lastReadError 应清空');
  assert.equal(status2.lastError, null, '成功后页面 lastError 应清空');
  monitor.stop();
});

test('D3 分类表：通用 auth/导航失败降为 read_failed，只有登录正证据才是 auth，且值级脱敏', () => {
  const dataDir = makeTempDir('read-detail-kind-');
  const monitor = buildMonitor({ dataDir, readAdState: async () => ({ state: 'unknown' }) });

  const genericAuth = monitor._maskReadError({
    status: 'blocked', blocked: 'auth', reason: '读取被拒绝（非登录页）', lastStep: 'refresh:全店托管',
  });
  assert.equal(genericAuth.kind, 'read_failed');
  assert.notEqual(genericAuth.kind, 'auth');
  assert.equal(genericAuth.lastStep, 'refresh:全店托管');

  const transient = monitor._maskReadError({
    status: 'blocked', blocked: 'inventory', reason: `导航"乘方"未到达管理页 token=${RAW_TOKEN}`, lastStep: 'refresh:商品自选',
  });
  assert.equal(transient.kind, 'read_failed');
  assert.equal(transient.reason.includes(RAW_TOKEN), false, `瞬态错误原因应脱敏，实际 ${transient.reason}`);

  const cookieInvalid = monitor._maskReadError({
    status: 'blocked', blocked: 'cookie_invalid', reason: 'Cookie 文件解析失败：结构非法', lastStep: null,
  });
  assert.equal(cookieInvalid.kind, 'cookie_invalid');
  assert.notEqual(cookieInvalid.kind, 'auth');

  const realAuth = monitor._maskReadError({
    status: 'blocked', blocked: 'auth', reason: `登录失效，请重新扫码登录 sessionid=${RAW_SESSION}`, lastStep: 'identity',
  });
  assert.equal(realAuth.kind, 'auth');
  assert.equal(realAuth.reason.includes(RAW_SESSION), false, '登录原因中的会话值必须脱敏');
  assert.ok(/sessionid=\*\*\*/.test(realAuth.reason), `实际 ${realAuth.reason}`);

  const timeout = monitor._maskReadError({
    status: 'blocked', blocked: 'ad_state_read', reason: `回读截止，最后步骤：read:${TAB_MAIN}:p1`, timeout: true, lastStep: `read:${TAB_MAIN}:p1`,
  });
  assert.equal(timeout.kind, 'timeout');
  assert.equal(timeout.timeout, true);
  assert.equal(timeout.lastStep, `read:${TAB_MAIN}:p1`);
  monitor.stop();
});
