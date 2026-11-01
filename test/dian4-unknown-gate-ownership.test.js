'use strict';

/**
 * DIAN-4 长期 unknown 收口门最小修复（2026-10-23）离线回归。
 *
 * 锁死的边界（逐条对应实施口径）：
 *  - 资源创建后、任何 await 前**同步**登记 ownership（opener 的 onResource → meta.openerResource）；
 *  - 门携带 gateId/readEpoch/身份 CAS：迟到的旧门推进结果不得清掉新门；
 *  - 同一次推进由多个调用方共享（advancePromise），不叠加关闭/核验；
 *  - 有界探测节奏 1s→5s→30s，且**只做收口**：零 opener、零页面读取、零点击；
 *  - 只有"已证明未创建"（可信 resourceCreated=false）或"已证明已关闭"才清门；
 *    无证明 → terminal 并保持阻断，绝不按时间盲放行（后续拿到真实证明仍可清门）；
 *  - stop 取消探测 timer 但保留门（阻断事实跨 stop/start 不丢），start 恢复有界探测；
 *  - 删除店保留门（句柄仍须真实关闭），只留审计事实；
 *  - 跨店隔离：一店的门不阻塞另一店读取；
 *  - 所有 poll/审计原因统一走 sanitize/mask：完整 URL 查询串不得入审计。
 *
 * 不访问浏览器/CDP/网络/真实 Cookie；除读取总期限外不真实等待（探测 timer 全部注入）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor.js');
const { AuthError } = require('../src/lib/errors.js');
const log = require('../src/lib/log.js');
const { attestResourceNotCreated, resourceNotCreatedProof, beginLauncherScope, runInLauncherScope, attestFromLauncherScope, launcherScopeEntered } = require('../src/lib/resource-attestation');
const { openQianchuanHome } = require('../src/adapters/qianchuan-reader');
const { makeTempDir, makeCfgResult, writeTempCookie } = require('./helpers.js');

const TAB_MAIN = '全店托管';
const TAB_SUB = '商品自选';
const SHOP_A = { id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true };
const SHOP_B = { id: 'shop-b', name: 'shop-b', cookieFile: 'shop-b', accountId: null, enabled: true };
const TRANSIENT_REASON = '分页 total 不一致'; // 既有瞬态白名单：允许登记收口门

function rows(prefix, count, checked = true) {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i + 1}`, switchChecked: checked }));
}
function fullViews(prefix) {
  return {
    [TAB_MAIN]: [
      { rows: rows(prefix, 10), hasNext: true, total: 32 },
      { rows: rows(`${prefix}b`, 10), hasNext: true, total: 32 },
      { rows: rows(`${prefix}c`, 10), hasNext: true, total: 32 },
      { rows: rows(`${prefix}d`, 2), hasNext: false, total: 32 },
    ],
    [TAB_SUB]: [{ rows: [], hasNext: false, total: 0 }],
  };
}

/** fake clock：只有注入的 timer 参与推进；advance 触发到点任务并排空微任务。 */
function makeClock(startMs = Date.parse('2026-10-18T20:00:00Z')) {
  let now = startMs;
  let seq = 0;
  const timers = new Map();
  const flush = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };
  return {
    nowFn: () => now,
    setTimeoutFn(fn, ms) {
      const id = ++seq;
      const delay = Math.max(0, Number(ms) || 0);
      timers.set(id, { id, at: now + delay, ms: delay, fn });
      return { id, unref() { /* fake */ } };
    },
    clearTimeoutFn(h) { if (h && h.id != null) timers.delete(h.id); },
    pending() { return Array.from(timers.values()).sort((a, b) => a.at - b.at || a.id - b.id); },
    async advance(ms) {
      now += Math.max(0, Number(ms) || 0);
      for (let guard = 0; guard < 300; guard += 1) {
        const due = this.pending().filter((t) => t.at <= now)[0];
        if (!due) break;
        timers.delete(due.id);
        due.fn();
        // 收口推进内部用真实定时器做上界竞速（work settle / close 等待）：给它在真实时间上收敛，
        // 否则探测会停在竞速中途，测试看到的是"未完成"而不是"下一次探测已排队"。
        await new Promise((r) => setTimeout(r, 45));
        await flush();
      }
      await new Promise((r) => setTimeout(r, 45));
      await flush();
    },
    async flush() { await flush(); },
  };
}

/**
 * 把虚拟时间按"下一个已排队 timer"逐段推进（等价于真实世界依次到期）。
 * 探测在真实时间上做 settle/close 竞速后才排下一次，所以一次性大跳只会触发第一段。
 */
async function drainTimers(clock, maxSteps = 8) {
  for (let i = 0; i < maxSteps; i += 1) {
    const due = clock.pending();
    if (!due.length) return i;
    await clock.advance(Math.max(1, due[0].at - clock.nowFn()));
  }
  return maxSteps;
}

/**
 * 收口门专用假 opener。
 *  mode：
 *   hang                  创建浏览器→**同步登记句柄**→挂住不返回（截止先到），fake.reject(i)/resolve(i) 收口
 *   failNotCreated        不创建任何资源，抛瞬态错误并由**资源所有者**登记"未创建"证明（可信）
 *   failBareNotCreated    只裸写 chengfangResourceCreated=false（任何代码都能写）：一律不得采信
 *   failNotCreatedWithHandle 已登记句柄却带"未创建"证明（自相矛盾）：以句柄为准，必须真实关闭
 *   failUnknown           抛瞬态错误：既不登记句柄也不给"未创建"证明（无任何可核验事实）
 *   failWithHandle        登记句柄后抛瞬态错误（句柄连接状态由 closeMode 决定能否证明已关闭）
 *   ok                    正常成功会话
 *  closeMode：'ok'（close 后 connected=false）| 'reject'（close 被拒绝）| 'hang'（close 挂起）
 */
function makeFactory(opts = {}) {
  const modeOf = typeof opts.mode === 'function' ? opts.mode : () => opts.mode || 'ok';
  const closeMode = { value: opts.closeMode || 'ok' };
  const calls = { opener: 0, readView: 0, evaluate: 0, adClicks: 0, handleRegister: 0, handleClose: 0, isConnected: 0, maxActive: 0, active: 0, maxActiveByShop: {} };
  const gates = [];
  const waits = [];
  const activeByShop = {};

  const opener = async (args) => {
    calls.opener += 1;
    calls.active += 1;
    const shopKey = String(args.shopCfg.id);
    activeByShop[shopKey] = (activeByShop[shopKey] || 0) + 1;
    if (activeByShop[shopKey] > (calls.maxActiveByShop[shopKey] || 0)) calls.maxActiveByShop[shopKey] = activeByShop[shopKey];
    if (calls.active > calls.maxActive) calls.maxActive = calls.active; // 跨店并行指标（允许）
    try {
      return await openerInner(args);
    } finally {
      calls.active -= 1;
      activeByShop[shopKey] -= 1;
    }
  };

  const openerInner = async (args) => {
    const no = calls.opener;
    const mode = modeOf(no, args.shopCfg.id);
    const browser = { closed: false, connected: false };
    const rec = { no, shopId: args.shopCfg.id, mode, browser, handle: null };
    gates.push(rec);

    const makeHandle = () => {
      rec.handle = {
        close: () => {
          calls.handleClose += 1;
          if (closeMode.value === 'reject') return Promise.reject(new Error('mock close rejected'));
          if (closeMode.value === 'hang') return new Promise(() => {});
          browser.closed = true;
          browser.connected = false;
          return Promise.resolve();
        },
        isConnected: () => { calls.isConnected += 1; return browser.connected; },
      };
      browser.connected = true;
      calls.handleRegister += 1;
      if (typeof args.onResource === 'function') args.onResource(rec.handle);
      return rec.handle;
    };

    if (mode === 'failNotCreated') {
      // 真实资源所有者的失败路径：证明只能由 owner 本人产出（lib/resource-attestation 私有登记）
      throw attestResourceNotCreated('qianchuan-home', new Error(TRANSIENT_REASON));
    }
    if (mode === 'failBareNotCreated') {
      const e = new Error(TRANSIENT_REASON);
      e.chengfangResourceCreated = false; // 裸属性：任何代码都能写，消费者不得采信
      throw e;
    }
    if (mode === 'failNotCreatedWithHandle') {
      makeHandle(); // 确实创建过资源
      throw attestResourceNotCreated('qianchuan-home', new Error(TRANSIENT_REASON));
    }
    if (mode === 'failUnknown') throw new Error(TRANSIENT_REASON);
    if (mode === 'failWithHandle') {
      makeHandle();
      throw new Error(TRANSIENT_REASON);
    }

    const page = {
      browser: () => browser,
      evaluate: async () => { calls.evaluate += 1; return null; },
    };
    if (mode === 'hang') {
      makeHandle(); // 创建后立即**同步**登记，先于任何 await
      await new Promise((resolve, reject) => {
        waits.push({
          no,
          reject: () => reject(new Error(TRANSIENT_REASON)),
          resolve: () => resolve(),
        });
      });
    }
    if (mode === 'ok' || mode === 'hang') {
      const perTab = {};
      const controller = {
        async verifyIdentity() { return { ok: true, pageShopId: args.shopCfg.id, pageShopName: args.shopCfg.id }; },
        async refreshView() { return { refreshed: true }; },
        async switchView() {},
        async readView({ tab }) {
          calls.readView += 1;
          const pages = fullViews(`s${no}`)[tab] || [{ rows: [], hasNext: false, total: 0 }];
          const i = Math.min(perTab[tab] || 0, pages.length - 1);
          perTab[tab] = (perTab[tab] || 0) + 1;
          const p = pages[i];
          return {
            rows: { rows: p.rows.map((r) => ({ ...r })) },
            pagination: { total: p.total, hasNext: p.hasNext, activePage: String(i + 1) },
          };
        },
        async clickNextPage() { return { clicked: true }; },
        async clickBatchPause() { calls.adClicks += 1; return {}; },
        async clickBatchEnable() { calls.adClicks += 1; return {}; },
        async clickRowSwitch() { calls.adClicks += 1; return {}; },
      };
      browser.close = async () => {
        if (closeMode.value === 'reject') throw new Error('mock browser.close rejected');
        browser.closed = true;
        browser.connected = false;
      };
      rec.session = { browser, page, controller };
      return rec.session;
    }
    if (mode === 'authThrow') throw new AuthError('登录失效：抖店页面有界收敛后仍命中登录页（当前 https://fxg.jinritemai.com/login/common?enter_from=utm_x&sessionid=abcdef123456），请重新扫码登录');
    throw new Error(`未知夹具模式：${mode}`);
  };

  return {
    opener,
    calls,
    gates,
    recAt: (i) => gates[i],
    setCloseMode(m) { closeMode.value = m; },
    releaseHang(i, how) {
      const w = waits.find((x) => x.no === (i == null ? waits.length : i) + 0) || waits[waits.length - 1];
      if (!w) throw new Error('无挂起 opener');
      if (how === 'resolve') w.resolve(); else w.reject();
    },
    lastGate() { return gates[gates.length - 1]; },
  };
}

function buildMonitor({ dataDir, clock, opener, shops = [SHOP_A, SHOP_B], timeoutMs = 50 }) {
  const cfgResult = makeCfgResult({
    shops: shops.map((s) => ({ ...s })),
    monitor: {
      chengfang: {
        scope: [TAB_MAIN, TAB_SUB],
        adStateReadTimeoutMs: timeoutMs,
        adStateCloseWaitMs: 30,
        adStateSettleWaitMs: 30,
      },
    },
  });
  return new Monitor(cfgResult, null, {
    dataDir,
    chengfangOpener: opener,
    nowFn: clock.nowFn,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
  });
}

function auditEvents(dataDir) {
  const p = path.join(dataDir, 'audit.jsonl');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}
function gateEvents(dataDir) {
  return auditEvents(dataDir).filter((j) => String(j.event || '').indexOf('gate-') === 0);
}

// ────────────────────────────────────────────────────────────────────

test('U1 截止门携带同步登记的句柄：work 未 settle 时不放行，opener 事后失败后由探测证明关闭并清门', async () => {
  const dataDir = makeTempDir('ugo-u1-');
  const clock = makeClock();
  const fake = makeFactory({ mode: (no) => (no === 1 ? 'hang' : 'ok') });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r1 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r1.state, 'unknown');
  assert.equal(r1.error.blockedBy, 'unread_session');
  assert.equal(fake.calls.opener, 1, '截止后不得新开第二份读取');
  assert.equal(fake.lastGate().handle ? 1 : 0, 1, '句柄必须在创建后、任何 await 前同步登记');

  const gate = mon._pendingReadGateFor(SHOP_A.id);
  assert.ok(gate, '截止必须登记收口门');
  assert.equal(gate.resourceCreated, true, '已创建资源必须如实登记为 true');
  assert.ok(gate.gateId >= 1 && typeof gate.readEpoch === 'number', '门必须携带 gateId/readEpoch');
  assert.equal(typeof gate.handleRef, 'function', '门必须以活引用取句柄（晚到也可见）');
  const pend = clock.pending();
  assert.equal(pend.length, 1, '只允许门自身的有界收口探测 timer');
  assert.equal(pend[0].ms, 1000, '第一次探测 1s');

  const before = { readView: fake.calls.readView, evaluate: fake.calls.evaluate, adClicks: fake.calls.adClicks };
  await clock.advance(1000); // work 仍挂账 → 不放行
  assert.ok(mon._pendingReadGateFor(SHOP_A.id), 'work 未 settle 必须保持阻断');
  assert.equal(clock.pending()[0].ms, 5000, '下一次探测 5s');
  assert.equal(fake.calls.opener, 1, '探测绝不启动新 opener');

  fake.releaseHang(1, 'reject'); // opener 之后失败：work 才 settle
  await clock.flush();
  await clock.advance(5000);
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), null, '真实关闭+连接核验通过后才清门');
  assert.equal(fake.calls.handleClose, 1, '探测内只做一次真实关闭');
  const released = gateEvents(dataDir).filter((j) => j.event === 'gate-released');
  assert.equal(released.length, 1);
  assert.equal(released[0].proof, 'closed', '清门必须记录关闭证明');
  assert.equal(released[0].via, 'probe');

  assert.deepEqual({ readView: fake.calls.readView, evaluate: fake.calls.evaluate, adClicks: fake.calls.adClicks }, before,
    '收口探测期间零页面读取/零 evaluate/零点击');
  const r2 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r2.state, 'on', JSON.stringify(r2.error || r2));
  assert.equal(fake.calls.opener, 2, '清门后才允许下一次读取');
});

test('U2 可信 resourceCreated=false：只凭该证明清门（poll 与探测两条路），未到点绝不盲放行', async () => {
  const dataDir = makeTempDir('ugo-u2-');
  const clock = makeClock();
  const fake = makeFactory({ mode: 'failNotCreated' });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r1 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r1.state, 'unknown');
  assert.equal(r1.error.blockedBy, 'unread_session');
  const gate = mon._pendingReadGateFor(SHOP_A.id);
  assert.ok(gate);
  assert.equal(gate.resourceCreated, false, '生产者可信"未创建"必须进门');
  assert.equal(fake.calls.handleRegister, 0, '未创建路径不得伪造句柄');

  await clock.advance(500); // 未到 1s：门仍在（清门只由推进取证触发，不按时间盲清）
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), gate, '未到推进点不得自动清门');

  // poll 入口推进：拿到"已证明未创建"才清旧门，随后才允许下一次真实读取
  const r1b = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r1b.error.blockedBy, 'unread_session');
  const pollRel = gateEvents(dataDir).filter((j) => j.event === 'gate-released' && j.gateId === gate.gateId);
  assert.equal(pollRel.length, 1, '旧门必须恰好清一次');
  assert.equal(pollRel[0].via, 'poll');
  assert.equal(pollRel[0].proof, 'not-created');
  assert.equal(fake.calls.opener, 2, '凭证明清门后才允许下一次读取（且只有一次）');
  const gate2 = mon._pendingReadGateFor(SHOP_A.id);
  assert.ok(gate2 && gate2.gateId > gate.gateId, '新一轮未收口必须另登记新门');

  // 有界探测同样只凭证明清门，并在清门时取消自己的 timer
  const steps = await drainTimers(clock, 4);
  assert.ok(steps >= 1, '探测必须被推进');
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), null, '未创建证明即放行');
  const rel = gateEvents(dataDir).filter((j) => j.event === 'gate-released' && j.gateId === gate2.gateId);
  assert.equal(rel.length, 1);
  assert.equal(rel[0].via, 'probe');
  assert.equal(rel[0].proof, 'not-created');
  assert.equal(clock.pending().length, 0, '清门必须取消探测 timer');
  assert.equal(fake.calls.readView, 0, '收口路径零页面读取');
  assert.equal(fake.calls.adClicks, 0, '收口路径零点击');
});

test('U3 无任何证明：1s/5s/30s 三次有界探测后用尽转 terminal，门保持阻断（绝不盲放行）', async () => {
  const dataDir = makeTempDir('ugo-u3-');
  const clock = makeClock();
  const fake = makeFactory({ mode: 'failUnknown' });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r1 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r1.error.blockedBy, 'unread_session');
  const gate = mon._pendingReadGateFor(SHOP_A.id);
  assert.equal(gate.resourceCreated, null, '既无句柄也无未创建证明：必须记为未知');
  assert.equal(gate.phase, 'pending');

  await clock.advance(1000);
  assert.ok(mon._pendingReadGateFor(SHOP_A.id));
  assert.equal(clock.pending()[0].ms, 5000);
  await clock.advance(5000);
  assert.ok(mon._pendingReadGateFor(SHOP_A.id));
  assert.equal(clock.pending()[0].ms, 30000, '第三次探测 30s');
  await clock.advance(30000);

  const still = mon._pendingReadGateFor(SHOP_A.id);
  assert.ok(still, '无证明一律不清门');
  assert.equal(still.phase, 'terminal');
  assert.equal(clock.pending().length, 0, 'terminal 后不再保留 timer（有界）');

  const r2 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r2.state, 'unknown');
  assert.equal(r2.error.blockedBy, 'unread_session');
  assert.equal(r2.error.gatePhase, 'terminal', '受阻原因必须透出 terminal（需人工处置）');
  assert.match(String(r2.error.reason), /人工/);
  assert.equal(fake.calls.opener, 1, 'terminal 之后仍不得启动新读取');

  const term = gateEvents(dataDir).filter((j) => j.event === 'gate-terminal');
  assert.equal(term.length, 1);
  assert.equal(term[0].probes, 3);
  assert.equal(gateEvents(dataDir).filter((j) => j.event === 'gate-probe').length, 3);
  assert.equal(fake.calls.readView, 0);
  assert.equal(fake.calls.adClicks, 0);
});

test('U4 并发推进共享同一次 advancePromise：不叠加关闭/核验，结束后不残留', async () => {
  const dataDir = makeTempDir('ugo-u4-');
  const clock = makeClock();
  const fake = makeFactory({ mode: 'failWithHandle', closeMode: 'hang' });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r1 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r1.error.blockedBy, 'unread_session');
  const gate = mon._pendingReadGateFor(SHOP_A.id);
  assert.ok(gate);
  assert.equal(fake.calls.handleRegister, 1);

  const a = mon._advanceReadGate(gate, 20, 20);
  assert.ok(gate.advancePromise, '推进在途必须挂共享 promise');
  const b = mon._advanceReadGate(gate, 20, 20);
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.done, false, 'close 挂起：无证明不放行');
  assert.equal(rb.done, false);
  assert.equal(gate.advancePromise, null, '推进结束必须释放共享 promise');
  assert.equal(fake.calls.handleClose, 1, '并发调用只推进一次真实关闭（不叠加）');
  assert.ok(mon._pendingReadGateFor(SHOP_A.id), '未证明仍阻断');
});

test('U5 gateId/readEpoch/CAS：迟到的旧门不得清掉新门；审计只记标量与"有无句柄"', async () => {
  const dataDir = makeTempDir('ugo-u5-');
  const clock = makeClock();
  const fake = makeFactory({ mode: 'failUnknown' });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  await mon._readCurrentAdState(SHOP_A);
  const g1 = mon._pendingReadGateFor(SHOP_A.id);
  assert.ok(g1);
  const readEpoch1 = g1.readEpoch;
  const handle = { close: async () => {}, isConnected: () => false };

  // 模拟"新门已登记"（同店更晚一次未收口读取）：旧门的推进/清理一律不得生效
  const g2 = mon._newReadGate(SHOP_A.id, {
    workRec: { settledP: Promise.resolve(), isSettled: () => true },
    sessionRef: () => null,
    handleRef: () => handle,
    resourceCreated: true,
    closes: [],
  });
  assert.ok(g2.gateId > g1.gateId, 'gateId 必须单调递增');
  assert.equal(g2.readEpoch, readEpoch1, 'readEpoch 取登记时的物理读取计数');

  assert.equal(mon._clearReadGateIf(SHOP_A.id, g1, 'late'), false, '旧门 CAS 必须失败');
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), g2, '新门不得被迟到结果清掉');
  const late = await mon._advanceReadGate(g1, 20, 20);
  assert.equal(late.done, false, '无证明的旧门不得判为已收口');
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), g2);

  // 新门自己拿到证明 → 清门成功
  await clock.advance(1000);
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), null, '新门凭真实证明清门');

  const reg = gateEvents(dataDir).filter((j) => j.event === 'gate-registered');
  assert.equal(reg.length, 2);
  for (const j of reg) {
    assert.ok(Object.values(j).every((v) => v === null || ['number', 'string', 'boolean'].includes(typeof v) || Array.isArray(v)),
      '审计只允许标量/字符串数组：句柄对象与函数绝不落盘');
    assert.equal(typeof j.gateId, 'number');
    assert.equal(typeof j.readEpoch, 'number');
    assert.ok('resourceCreated' in j && 'hasHandle' in j && 'hasSession' in j);
  }
  const raw = fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /isConnected/, '审计绝不包含句柄字段/函数');
  assert.doesNotMatch(raw, /close.*function/, '审计绝不序列化收口句柄');
});

test('U6 stop 取消探测 timer 并保留门；start 恢复有界探测（只收口，不读取）', async () => {
  const dataDir = makeTempDir('ugo-u6-');
  const clock = makeClock();
  const fake = makeFactory({ mode: 'failWithHandle', closeMode: 'reject' });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener, shops: [SHOP_A] });

  const r1 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r1.error.blockedBy, 'unread_session');
  const gate = mon._pendingReadGateFor(SHOP_A.id);
  assert.ok(gate);
  assert.equal(clock.pending().length, 1);

  mon.stop();
  assert.equal(clock.pending().length, 0, 'stop 必须取消探测 timer');
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), gate, 'stop 不得丢掉阻断事实（门保留）');
  await clock.advance(60000);
  assert.equal(fake.calls.opener, 1, 'stop 期间不得有任何再读取');

  const started = mon.start();
  assert.equal(started.ok, true, JSON.stringify(started));
  const pend = clock.pending();
  assert.ok(pend.length >= 1, 'start 后恢复有界收口探测');
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), gate, '恢复的仍是同一扇门');

  const closesBefore = fake.calls.handleClose;
  const nextDelay = clock.pending().map((t) => t.ms).sort((a, b) => a - b)[0];
  assert.ok([1000, 5000, 30000].includes(nextDelay), `恢复后的探测必须落在有界节奏上：${nextDelay}`);
  await clock.advance(nextDelay);
  assert.ok(mon._pendingReadGateFor(SHOP_A.id), 'close 仍被拒绝：继续阻断');
  assert.equal(fake.calls.readView, 0, '探测期间零页面读取');
  assert.equal(fake.calls.opener, 1, '探测期间零新 opener');
  assert.ok(fake.calls.handleClose > closesBefore, '探测确实推进了真实关闭尝试');

  fake.setCloseMode('ok');
  const r2 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r2.error.blockedBy, 'unread_session', '本轮仍按既有门推进：证明后才放行');
  const after = mon._pendingReadGateFor(SHOP_A.id);
  assert.ok(!after || after.gateId > gate.gateId, '旧门必须凭真实关闭证明清除（新失败另登记新门）');
  const rel = gateEvents(dataDir).filter((j) => j.event === 'gate-released' && j.gateId === gate.gateId);
  assert.equal(rel.length, 1, '旧门清除必须留一次清门审计');
  assert.equal(rel[0].via, 'poll');
  assert.equal(rel[0].proof, 'closed');
  mon.stop();
});

test('U7 删除店：门保留（句柄仍须真实关闭），探测只做收口且留审计事实', async () => {
  const dataDir = makeTempDir('ugo-u7-');
  const clock = makeClock();
  const cfgPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ shops: [{ ...SHOP_A }, { ...SHOP_B }] }));
  const fake = makeFactory({ mode: 'failWithHandle', closeMode: 'reject' });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
  mon.cfgResult.sourcePath = cfgPath;

  await mon._readCurrentAdState(SHOP_A);
  const gate = mon._pendingReadGateFor(SHOP_A.id);
  assert.ok(gate);

  const del = mon.deleteShop(SHOP_A.id);
  assert.equal(del.ok, true, JSON.stringify(del));
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), gate, '删除不得丢掉未收口的门（浏览器仍须关闭）');
  const note = gateEvents(dataDir).filter((j) => j.event === 'gate-shop-deleted');
  assert.equal(note.length, 1);
  assert.equal(note[0].gateId, gate.gateId);

  const opens = fake.calls.opener;
  await drainTimers(clock); // 依次到期 1s/5s/30s 三次探测
  assert.equal(fake.calls.opener, opens, '删除店后探测绝不再读取');
  assert.equal(fake.calls.readView, 0);
  assert.equal(fake.calls.adClicks, 0);
  assert.equal(mon._pendingReadGateFor(SHOP_A.id).phase, 'terminal');
});

test('U8 跨店隔离：一店的门/terminal 不阻塞另一店正常读取', async () => {
  const dataDir = makeTempDir('ugo-u8-');
  const clock = makeClock();
  let n = 0;
  const fake = makeFactory({
    mode: () => { n += 1; return n === 1 ? 'failUnknown' : 'ok'; },
  });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const ra = await mon._readCurrentAdState(SHOP_A);
  assert.equal(ra.error.blockedBy, 'unread_session');
  await drainTimers(clock);
  assert.equal(mon._pendingReadGateFor(SHOP_A.id).phase, 'terminal');

  const rb = await mon._readCurrentAdState(SHOP_B);
  assert.equal(rb.state, 'on', JSON.stringify(rb.error || rb));
  assert.equal(mon._pendingReadGateFor(SHOP_B.id), null, '另一店不得有门');
  assert.equal(mon._pendingReadGateFor(SHOP_A.id).phase, 'terminal', 'A 店阻断不得因 B 店成功而解除');
  assert.equal(fake.calls.adClicks, 0);
});

test('U9 close 曾拒绝转 terminal：真实证明出现后由下一次 poll 推进清门并成功读取', async () => {
  const dataDir = makeTempDir('ugo-u9-');
  const clock = makeClock();
  const fake = makeFactory({ mode: (no) => (no === 1 ? 'failWithHandle' : 'ok'), closeMode: 'reject' });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  await mon._readCurrentAdState(SHOP_A);
  await drainTimers(clock);
  const gate = mon._pendingReadGateFor(SHOP_A.id);
  assert.equal(gate.phase, 'terminal');
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.error.blockedBy, 'unread_session');

  fake.setCloseMode('ok'); // 真实可关闭（外部状态变化）
  const r2 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r2.state, 'on', JSON.stringify(r2.error || r2));
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), null);
  const rel = gateEvents(dataDir).filter((j) => j.event === 'gate-released');
  assert.equal(rel[rel.length - 1].via, 'poll', '由 poll 推进以真实证明清门');
  assert.equal(rel[rel.length - 1].proof, 'closed');
  assert.equal(fake.calls.adClicks, 0);
});

test('U10 poll 原因统一遮蔽：完整 URL 查询串不得进入审计/掩码摘要/展示边界', async () => {
  const dataDir = makeTempDir('ugo-u10-');
  const clock = makeClock();
  const fake = makeFactory({ mode: 'authThrow' });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown');
  assert.equal(r.error.blocked, 'auth');

  const raw = fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /\?enter_from=/, '审计不得出现完整查询串');
  assert.doesNotMatch(raw, /sessionid=abcdef123456/, '审计不得出现会话票据');
  assert.match(raw, /查询参数已遮蔽/, '审计必须出现统一遮蔽标记');

  const masked = mon._maskReadError({
    status: 'blocked',
    reason: '登录失效（当前 https://fxg.jinritemai.com/login/common?a=1&b=2）请重新扫码登录',
  });
  assert.match(String(masked.reason), /login\/common\?…（查询参数已遮蔽，原 URL 共 \d+ 字符）/);
  assert.doesNotMatch(String(masked.reason), /a=1&b=2/);

  assert.equal(/http:\/\/x\/y\?q=1/.test(log.scrubDeep('页 http://x/y?q=1 尾')), false);
  assert.match(log.scrubDeep('页 http://x/y?q=1 尾'), /查询参数已遮蔽/);
  assert.equal(log.scrubDeep('页 https://a.com/path 尾'), '页 https://a.com/path 尾', '无查询段的地址原样保留（回读定位需要）');
  assert.equal(log.sanitize({ r: 'sessionid=ab 裸票据' }).r, '[疑似凭证，已脱敏]', '整段脱敏优先级不变');
  // 幂等：源侧遮过一次，落盘/展示边界再遮不得叠出第二个标记（生产曾出现 "共 40 字符…共 83 字符" 叠字）
  const once = log.maskUrlQueries('登录失效（当前 https://fxg.jinritemai.com/login/common?a=1&b=2）请重新扫码登录');
  assert.equal((once.match(/查询参数已遮蔽/g) || []).length, 1, JSON.stringify(once));
  assert.equal(log.maskUrlQueries(once), once, 'maskUrlQueries 必须幂等');
  assert.equal((log.sanitize({ reason: once }).reason.match(/查询参数已遮蔽/g) || []).length, 1,
    '落盘边界二次处理必须保持单标记');
  for (const l of raw.trim().split('\n')) {
    assert.ok((l.match(/查询参数已遮蔽/g) || []).length <= 1, '同一审计行不得叠标记：' + l.slice(0, 200));
  }
  assert.equal(fake.calls.adClicks, 0);
});

// ────────────────────────────────────────────────────────────────────
// r13 三缺口（2026-10-23 派单）：
//  缺口 1 not-created 必须先有界确认 work settle，且证明只能由真实资源所有者产出；
//  缺口 2 每店 read permit 串行覆盖「推进 → CAS → opener」，CAS=false 必须阻断并重读当前门；
//  缺口 3 收口登记簿与当前许可门分离，旧 epoch 的句柄/会话必须关闭并核验 disconnected，
//        其业务结果一律丢弃。
// ────────────────────────────────────────────────────────────────────

test('U11 裸属性"未创建"不被采信：只有资源所有者登记的证明才能进门', async () => {
  const dataDir = makeTempDir('ugo-u11-');
  const clock = makeClock();
  const bare = makeFactory({ mode: 'failBareNotCreated' });
  const mon = buildMonitor({ dataDir, clock, opener: bare.opener });

  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.error.blockedBy, 'unread_session');
  const gate = mon._pendingReadGateFor(SHOP_A.id);
  assert.equal(gate.resourceCreated, null, '裸写属性必须按"未知"处理（不得记为未创建）');
  assert.equal(gate.notCreatedOwner, null, '无所有者即无证明');

  const adv = await mon._advanceReadGate(gate, 20, 20);
  assert.equal(adv.done, false, '无所有者证明：绝不放行');
  assert.notEqual(adv.proof, 'not-created');
  assert.ok(mon._pendingReadGateFor(SHOP_A.id), '保持阻断');
  assert.equal(bare.calls.opener, 1, '未证明不得再开物理读取');

  // 同一夹具换成所有者登记：证明进门并可清门
  const dataDir2 = makeTempDir('ugo-u11b-');
  const clock2 = makeClock();
  const ok = makeFactory({ mode: 'failNotCreated' });
  const mon2 = buildMonitor({ dataDir: dataDir2, clock: clock2, opener: ok.opener });
  await mon2._readCurrentAdState(SHOP_A);
  const g2 = mon2._pendingReadGateFor(SHOP_A.id);
  assert.equal(g2.resourceCreated, false, '所有者证明才允许记为未创建');
  assert.equal(g2.notCreatedOwner, 'qianchuan-home', '必须记住证明来自谁');
  const adv2 = await mon2._advanceReadGate(g2, 20, 20);
  assert.equal(adv2.done, true);
  assert.equal(adv2.proof, 'not-created');
});

test('U12 缺口1：work 未 settle 时"未创建"证明绝不换取放行；settle 后才可', async () => {
  const dataDir = makeTempDir('ugo-u12-');
  const clock = makeClock();
  const fake = makeFactory({ mode: 'ok' });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const unsettled = mon._newReadGate(SHOP_A.id, {
    workRec: { settledP: new Promise(() => {}) },
    sessionRef: () => null,
    resourceCreated: false,
    notCreatedOwner: 'qianchuan-home',
    closes: [],
  });
  const r = await mon._advanceReadGate(unsettled, 20, 20);
  assert.equal(r.done, false, '未 settle 的 work 里可能正在创建资源：任何证明都不得提前放行');
  assert.equal(r.why, 'work 未 settle');
  assert.notEqual(r.proof, 'not-created');

  const settled = mon._newReadGate(SHOP_B.id, {
    workRec: { settledP: Promise.resolve(), isSettled: () => true },
    sessionRef: () => null,
    resourceCreated: false,
    notCreatedOwner: 'qianchuan-home',
    closes: [],
  });
  const r2 = await mon._advanceReadGate(settled, 20, 20);
  assert.equal(r2.done, true, 'work 已 settle + 所有者证明：可以收口');
  assert.equal(r2.proof, 'not-created');
  assert.equal(r2.proofOwner, 'qianchuan-home');

  // 只有布尔没有所有者（如旧数据/伪造）→ 一律不放行
  const noOwner = mon._newReadGate(SHOP_A.id, {
    workRec: { settledP: Promise.resolve(), isSettled: () => true },
    sessionRef: () => null,
    resourceCreated: false,
    closes: [],
  });
  const r3 = await mon._advanceReadGate(noOwner, 20, 20);
  assert.equal(r3.done, false, 'resourceCreated=false 但没有所有者：不构成证明');

  mon.stop();
  assert.equal(clock.pending().length, 0, 'stop 取消全部探测 timer');
});

test('U13 缺口1：已登记句柄 + "未创建"证明自相矛盾 → 一律以句柄为准，必须真实关闭并核验', async () => {
  const dataDir = makeTempDir('ugo-u13-');
  const clock = makeClock();
  const fake = makeFactory({ mode: 'failNotCreatedWithHandle', closeMode: 'ok' });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  await mon._readCurrentAdState(SHOP_A);
  const gate = mon._pendingReadGateFor(SHOP_A.id);
  assert.ok(gate);
  assert.equal(gate.resourceCreated, true, '句柄代表真实创建：登记的 true 优先于证明');
  const adv = await mon._advanceReadGate(gate, 20, 20);
  assert.equal(adv.done, true);
  assert.equal(adv.proof, 'closed', '只能凭真实关闭 + 连接核验收口，绝不走 not-created');
  assert.equal(fake.calls.handleClose, 1);
  assert.ok(fake.lastGate().handle.isConnected() === false, '必须核验 disconnected');
  assert.equal(mon._clearReadGateIf(SHOP_A.id, gate, adv.proof), true, '证明到手后按身份清门');
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), null);
  assert.equal(mon._cleanupRegistryIndexOf(gate), -1, '清门同时注销登记簿：不留"已证明仍被探测"的幽灵条目');
});

test('U14 缺口2：每店读取许可串行——两路并发回读绝不重叠 opener，各自都拿到真实结果', async () => {
  const dataDir = makeTempDir('ugo-u14-');
  const clock = makeClock();
  const fake = makeFactory({ mode: 'hang' });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const p1 = mon._readCurrentAdState(SHOP_A);
  await clock.flush();
  const p2 = mon._readCurrentAdState(SHOP_A);
  await clock.flush();
  assert.equal(fake.calls.opener, 1, '第二路必须排在许可后面，不得并发开第二个浏览器');
  assert.equal(fake.calls.active, 1);

  fake.releaseHang(0, 'resolve');
  const [r1] = await Promise.all([p1, p2]);
  assert.equal(fake.calls.maxActive, 1, '物理读取窗口绝不重叠');
  assert.equal(r1.state, 'on', JSON.stringify(r1.error || r1));
  assert.equal(fake.calls.opener, 2, '第二路在自己的许可内确实做了一次真实回读');
  mon.stop();
});

test('U15 缺口2：CAS=false 一律阻断并重读当前门，禁止第二次物理读取', async () => {
  const dataDir = makeTempDir('ugo-u15-');
  const clock = makeClock();
  const fake = makeFactory({ mode: 'failWithHandle', closeMode: 'reject' });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  await mon._readCurrentAdState(SHOP_A);
  const g1 = mon._pendingReadGateFor(SHOP_A.id);
  assert.ok(g1);
  fake.setCloseMode('ok'); // 旧门现在可被证明关闭

  // 同店更晚一次不可证明的失败替换当前门（许可外的登记：直接走 _newReadGate）
  const g2 = mon._newReadGate(SHOP_A.id, {
    workRec: { settledP: Promise.resolve(), isSettled: () => true },
    sessionRef: () => null,
    handleRef: () => null,
    resourceCreated: null,
    closes: [{ label: 'opener-cleanup', closed: false, error: null, promise: null }],
  });
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), g2);
  assert.deepEqual(mon._pendingCleanupsFor(SHOP_A.id).map((g) => g.gateId), [g1.gateId, g2.gateId],
    '登记簿必须同时留着旧门与新门');

  const opens = fake.calls.opener;
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.error.blockedBy, 'unread_session');
  assert.equal(r.error.gateId, g2.gateId, '受阻必须透出真正拦住本次读取的当前门');
  assert.equal(fake.calls.opener, opens, 'CAS=false：绝不因此再开第二次物理读取');

  const rel = gateEvents(dataDir).filter((j) => j.event === 'gate-released' && j.gateId === g1.gateId);
  assert.equal(rel.length, 1, '旧门凭真实关闭证明注销收口义务');
  assert.equal(rel[0].proof, 'closed');
  assert.equal(rel[0].cleared, false, '旧门推进结果不得清掉新门');
  assert.equal(rel[0].unregistered, true);
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), g2, '新门仍在');
  assert.deepEqual(mon._pendingCleanupsFor(SHOP_A.id).map((g) => g.gateId), [g2.gateId], '旧门已从登记簿注销');
  mon.stop();
});

test('U16 缺口3：旧 epoch 被新门替换后仍被关闭并核验 disconnected，迟到的业务结果不得进入状态', async () => {
  const dataDir = makeTempDir('ugo-u16-');
  const clock = makeClock();
  const fake = makeFactory({ mode: (no) => (no === 1 ? 'hang' : 'ok') });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r1 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r1.error.blockedBy, 'unread_session', '截止：旧 opener 仍挂账');
  const g1 = mon._pendingReadGateFor(SHOP_A.id);
  assert.ok(g1);

  // 迟到的旧 epoch opener 最终**成功**返回会话：其业务结果必须丢弃，会话必须被关闭
  fake.releaseHang(0, 'resolve');
  await clock.flush();
  await clock.flush();
  assert.notEqual(mon._runtime(SHOP_A.id).lastAdState, 'on', '迟到结果不得改写本店状态');
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), g1, '旧门仍在登记簿（收口未证明）');
  assert.ok(g1.closes.some((c) => c.label === 'late-session'), '迟到会话必须被同步登记为待收口');

  const readsBefore = fake.calls.readView;
  const r2 = await mon._readCurrentAdState(SHOP_A); // poll 推进旧 epoch 收口后才允许新读取
  assert.equal(mon._cleanupRegistryIndexOf(g1), -1, '收口证明后从登记簿注销');
  assert.equal(r2.state, 'on', JSON.stringify(r2.error || r2));
  assert.equal(fake.calls.opener, 2, '证明到手后才允许下一次真实读取');
  const rel = gateEvents(dataDir).filter((j) => j.event === 'gate-released' && j.gateId === g1.gateId);
  assert.equal(rel.length, 1, '旧 epoch 收口只留一次清门事实');
  assert.equal(rel[0].proof, 'closed', '旧 epoch 只能凭真实关闭 + 连接核验收口');
  assert.equal(rel[0].via, 'poll');
  assert.equal(rel[0].unregistered, true);
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), null, '旧门已清且无新失败：许可恢复');
  assert.ok(fake.calls.readView > readsBefore, '下一次读取是新 opener 的真实读取');
  assert.equal(mon._pendingCleanupsFor(SHOP_A.id).length, 0, '本店无残留收口义务');
  assert.equal(fake.calls.adClicks, 0);
  mon.stop();
});

test('U17 缺口3：探测覆盖登记簿（含被替换的旧门）；stop 清零 timer、start 恢复、删店保留', async () => {
  const dataDir = makeTempDir('ugo-u17-');
  const clock = makeClock();
  const cfgPath = path.join(dataDir, 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify({ shops: [{ ...SHOP_A }] }));
  const fake = makeFactory({ mode: 'failUnknown' });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener, shops: [SHOP_A] });
  mon.cfgResult.sourcePath = cfgPath;

  await mon._readCurrentAdState(SHOP_A);
  const g1 = mon._pendingReadGateFor(SHOP_A.id);
  // 同店再来一次未收口失败：g1 被替换但仍在登记簿
  await clock.advance(0);
  const g2 = mon._newReadGate(SHOP_A.id, {
    workRec: { settledP: Promise.resolve(), isSettled: () => true },
    sessionRef: () => null,
    resourceCreated: null,
    closes: [],
  });
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), g2);
  const timersBefore = clock.pending().length;
  assert.equal(timersBefore, 2, '旧门与新门各自保留有界探测 timer');

  mon.stop();
  assert.equal(clock.pending().length, 0, 'stop 必须取消登记簿内全部门（含旧 epoch）的 timer');
  assert.deepEqual(mon._pendingCleanupsFor(SHOP_A.id).map((g) => g.gateId), [g1.gateId, g2.gateId],
    'stop 不得丢掉任何未收口事实');

  mon.start();
  assert.equal(clock.pending().length, 2, 'start 恢复全部门（含旧 epoch）的有界探测');

  const opens = fake.calls.opener;
  await drainTimers(clock, 10); // 1s/5s/30s 各两轮
  assert.equal(fake.calls.opener, opens, '探测期间零新 opener');
  assert.equal(fake.calls.readView, 0, '探测期间零页面读取');
  assert.equal(fake.calls.adClicks, 0, '探测期间零点击');
  assert.equal(clock.pending().length, 0, '探测用尽后不留 timer');
  assert.equal(mon._pendingCleanupsFor(SHOP_A.id).length, 2, '无证明一律不注销');
  assert.equal(mon._pendingCleanupsFor(SHOP_A.id).every((g) => g.phase === 'terminal'), true);

  const del = mon.deleteShop(SHOP_A.id);
  assert.equal(del.ok, true, JSON.stringify(del));
  assert.deepEqual(mon._pendingCleanupsFor(SHOP_A.id).map((g) => g.gateId), [g1.gateId, g2.gateId],
    '删除店不得抹掉未收口的旧 epoch');
  mon.stop();
});

test('U18 缺口2/3：许可按店隔离——A 店挂住的读取不阻塞 B 店，B 店门也不拦 A 店证明后的读取', async () => {
  const dataDir = makeTempDir('ugo-u18-');
  const clock = makeClock();
  let n = 0;
  const fake = makeFactory({ mode: () => { n += 1; return n === 1 ? 'hang' : 'ok'; } });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const pA = mon._readCurrentAdState(SHOP_A); // A 店截止 → 门 + 许可持有中
  await clock.flush();
  const rB = await mon._readCurrentAdState(SHOP_B); // 不被 A 店许可/门阻塞
  assert.equal(rB.state, 'on', JSON.stringify(rB.error || rB));
  assert.equal(mon._pendingReadGateFor(SHOP_B.id), null, 'B 店无门');

  const blockedA = await mon._readCurrentAdState(SHOP_A); // A 店第二路：等 A 店许可后再推进收口
  assert.equal(blockedA.error.blockedBy, 'unread_session', 'A 店收口未证明：继续阻断，且没有第三个 opener');
  assert.equal(fake.calls.opener, 2, '挂账的 A 店读取未 settle：第二路绝不开第三个浏览器');
  assert.equal(fake.calls.maxActiveByShop['shop-a'], 1, '同店物理读取绝不重叠（许可串行）');
  assert.equal(fake.calls.maxActiveByShop['shop-b'], 1, 'B 店同样一次只开一个');
  assert.equal(fake.calls.maxActive, 2, 'A 店持锁期间 B 店必须能并行读取（许可按店隔离）');

  fake.releaseHang(0, 'reject');
  await pA;
  await clock.flush();
  const after = await mon._readCurrentAdState(SHOP_A);
  assert.equal(after.state, 'on', JSON.stringify(after.error || after));
  assert.equal(mon._pendingCleanupsFor(SHOP_A.id).length, 0, 'A 店收口义务全部注销');
  assert.equal(fake.calls.adClicks, 0);
  mon.stop();
});

test('U19 审计与脱敏边界：登记簿事件只记标量，证明只记所有者标识，句柄/查询串绝不落盘', async () => {
  const dataDir = makeTempDir('ugo-u19-');
  const clock = makeClock();
  const fake = makeFactory({ mode: 'failNotCreated' });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  await mon._readCurrentAdState(SHOP_A);
  await drainTimers(clock, 4);

  const raw = fs.readFileSync(path.join(dataDir, 'audit.jsonl'), 'utf8');
  assert.doesNotMatch(raw, /isConnected|onResource|openerResource/, '审计绝不出现句柄字段/回调名');
  const reg = gateEvents(dataDir).filter((j) => j.event === 'gate-registered');
  assert.ok(reg.length >= 1);
  for (const j of reg) {
    assert.ok(typeof j.cleanups === 'number' && j.cleanups >= 1, '登记必须留未收口条数（机读）');
    assert.ok(j.notCreatedOwner === null || typeof j.notCreatedOwner === 'string');
    assert.ok(Object.values(j).every((v) => v === null || ['number', 'string', 'boolean'].includes(typeof v) || Array.isArray(v)),
      '审计只允许标量/字符串数组');
  }
  const rel = gateEvents(dataDir).filter((j) => j.event === 'gate-released');
  assert.ok(rel.length >= 1);
  for (const j of rel) {
    assert.ok('unregistered' in j, '注销登记簿必须留机读事实');
    if (j.proof === 'not-created') assert.equal(j.proofOwner, 'qianchuan-home', '证明必须可追溯到所有者');
  }
  assert.equal(fake.calls.adClicks, 0);
  assert.equal(fake.calls.readView, 0, '收口路径零页面读取');
  assert.equal(clock.pending().length, 0, '收口完成后不留 timer');
});

// ---------- 验收边界 1（2026-10-23 r14）：未创建证明只能由 launcher 范围出具 ----------

test('U20 边界1：factory 先创建资源再 reject —— wrapper 不得出具"未创建"证明，消费者只能按 unknown 阻断', async () => {
  const d = makeTempDir('dian4-u20-');
  writeTempCookie(d, 'shop-a');
  let created = false;
  const err = await openQianchuanHome(
    { cookieWorkDir: d, edgePath: null },
    { id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a.json' },
    { browserFactory: async () => { created = true; throw new Error('stub: launcher 内部已创建进程，随后 reject'); } },
  ).catch((e) => e);
  assert.ok(err instanceof Error, '入口必须抛出原始错误');
  assert.equal(created, true, '负例前提：确实走过"已创建再 reject"');
  assert.equal(resourceNotCreatedProof(err), null, '进入过 launcher 就不得有可信未创建证明');
  assert.equal(err.chengfangResourceCreated, undefined, '也不得顺手写裸属性（避免旧消费者被误导）');
});

test('U21 边界1：失败严格早于 launcher（Cookie 解析）时由所有者本人出具证明', async () => {
  const d = makeTempDir('dian4-u21-');
  let factoryCalled = false;
  const err = await openQianchuanHome(
    { cookieWorkDir: d, edgePath: null },
    { id: 'shop-x', name: 'shop-x', cookieFile: '不存在的店.json' },
    { browserFactory: async () => { factoryCalled = true; return {}; } },
  ).catch((e) => e);
  assert.ok(err instanceof Error, '缺 Cookie 文件必须抛错');
  assert.equal(factoryCalled, false, '前提：launcher 从未被进入');
  const proof = resourceNotCreatedProof(err);
  assert.ok(proof, '未进入 launcher 的失败应带所有者证明（否则本店会无谓长期 unknown）');
  assert.equal(proof.ownerId, 'qianchuan-home', '证明必须可追溯到所有者');
});

test('U22 边界1：launcher 范围收据不可伪造、进入事实不可撤销；未登记所有者产不出证明', async () => {
  assert.equal(launcherScopeEntered({}), true, '随手对象不是收据：按已进入保守处理');
  assert.equal(resourceNotCreatedProof(attestFromLauncherScope({}, new Error('x'))), null, '伪造收据产不出证明');

  const scope = beginLauncherScope('qianchuan-home');
  assert.equal(launcherScopeEntered(scope), false, '新范围尚未进入 launcher');
  const pre = new Error('pre-launch');
  assert.ok(resourceNotCreatedProof(attestFromLauncherScope(scope, pre)), '进入前失败：出具证明');

  await assert.rejects(() => runInLauncherScope(scope, async () => { throw new Error('in-launch'); }), /in-launch/);
  assert.equal(launcherScopeEntered(scope), true, '一旦进入，事实不可撤销');
  const post = new Error('post-launch');
  assert.equal(resourceNotCreatedProof(attestFromLauncherScope(scope, post)), null, '进入后一律不再出具证明');

  const foreign = beginLauncherScope('not-a-registered-owner');
  assert.equal(resourceNotCreatedProof(attestFromLauncherScope(foreign, new Error('f'))), null, '未登记所有者不产证明');
  assert.equal(resourceNotCreatedProof(attestResourceNotCreated('not-a-registered-owner', new Error('g'))), null, '未登记所有者直接登记也无效');
});
