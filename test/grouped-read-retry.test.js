'use strict';

/**
 * 分组有限恢复（2026-10-18 F4-R8）离线回归：真实 Monitor 方法链 + 假 page/controller + 可控 fake timer。
 *
 * 用户口径：首次读取失败后，连续失败最多重试 10 次（首次不算）；每 2 次一组，组内可立即，
 * 组结束后至少等待 300000ms 再下一组；成功即停。正常连续失败且关闭均成功时物理完整回读=11 次。
 *
 * 覆盖：
 *  G1 连续失败实际 11 次读取；每组 2 次；组间等待 >=300000ms；满 10 停止不再第 11 次；
 *  G2 第 1 次重试成功即停；G3 中间重试成功即停并清理旧错误/进度；
 *  G4 同店等待期重复触发不叠加；G5 另一店正常不受阻塞；
 *  G6 stop 取消等待与迟到结果；G7 删除/禁用取消；
 *  G8 关闭拒绝不新开、后续可推进恢复；G9 Auth/身份错误不盲试；
 *  G10 满 10 后普通巡查只读一次、不生成无限新链；成功可重置事件。
 *
 * 不访问浏览器/CDP/网络/真实 Cookie；不真实等待 20 分钟（timer 全部注入）。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { Monitor } = require('../src/engine/monitor.js');
const { AuthError } = require('../src/lib/errors.js');
const { makeTempDir, makeCfgResult } = require('./helpers.js');

const TAB_MAIN = '全店托管';
const TAB_SUB = '商品自选';
const SHOP_A = { id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true };
const SHOP_B = { id: 'shop-b', name: 'shop-b', cookieFile: 'shop-b', accountId: null, enabled: true };

function rows(prefix, count, checked = true) {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i + 1}`, switchChecked: checked }));
}

function inconsistentViews(prefix) {
  return {
    [TAB_MAIN]: [
      { rows: rows(prefix, 10), hasNext: true, total: 32 },
      { rows: rows(`${prefix}b`, 10), hasNext: true, total: 32 },
      { rows: rows(`${prefix}c`, 10), hasNext: true, total: 32 },
      { rows: rows(`${prefix}d`, 1), hasNext: false, total: 32 },
    ],
    [TAB_SUB]: [{ rows: [], hasNext: false, total: 0 }],
  };
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

/** 可控 fake clock/timer：不真实等待；advance 时按 at 顺序触发并排空微任务。 */
function makeClock(startMs = Date.parse('2026-10-18T04:00:00Z')) {
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
      return { id, unref() { /* fake timer 无需 unref */ } };
    },
    clearTimeoutFn(h) {
      if (h && h.id != null) timers.delete(h.id);
    },
    pending() {
      return Array.from(timers.values()).sort((a, b) => a.at - b.at || a.id - b.id);
    },
    async advance(ms) {
      now += Math.max(0, Number(ms) || 0);
      for (let guard = 0; guard < 200; guard += 1) {
        const due = Array.from(timers.values())
          .filter((t) => t.at <= now)
          .sort((a, b) => a.at - b.at || a.id - b.id)[0];
        if (!due) break;
        timers.delete(due.id);
        due.fn();
        await flush();
      }
      await flush();
    },
    async flush() { await flush(); },
  };
}

/**
 * 假 opener/controller：
 *  - failUntil：前 N 个 session 返回 32vs31 瞬态不一致，其后返回完整 32/32；
 *  - holdOpen：指定第 N 个 session 的首次 readView 挂起，测试手动 release（迟到结果）；
 *  - closeMode：'ok' | 'reject'（可翻转）。
 */
function makeFactory(opts = {}) {
  let failUntil = opts.failUntil == null ? Infinity : opts.failUntil;
  const closeMode = { value: opts.closeMode || 'ok' };
  const calls = { opener: 0, readView: 0, close: 0, adClicks: 0 };
  const openByShop = {};
  const held = [];

  const opener = async (args) => {
    calls.opener += 1;
    const openNo = calls.opener;
    const shopOpen = (openByShop[args.shopCfg.id] = (openByShop[args.shopCfg.id] || 0) + 1);
    const failing = typeof failUntil === 'function'
      ? failUntil(args.shopCfg.id, shopOpen) === true
      : shopOpen <= failUntil;
    if (opts.authOn && opts.authOn(openNo)) {
      throw new AuthError('登录失效：持续命中登录页地址或可见登录控件，请重新扫码登录');
    }
    const browser = { closed: false };
    const page = { browser: () => browser, evaluate: async () => null };
    const perTab = {};
    const assertOpen = () => { if (browser.closed) throw new Error('Target page/context has been closed'); };
    const controller = {
      async verifyIdentity() {
        assertOpen();
        if (opts.identityFailOn && opts.identityFailOn(openNo)) {
          return { ok: false, reason: '页面店铺身份不匹配' };
        }
        return { ok: true, pageShopId: args.shopCfg.id, pageShopName: args.shopCfg.id };
      },
      async refreshView() { assertOpen(); return { refreshed: true }; },
      async switchView() { assertOpen(); },
      async readView({ tab }) {
        assertOpen();
        calls.readView += 1;
        const nextPage = () => {
          const pages = (failing ? inconsistentViews(`f${openNo}`) : fullViews(`s${openNo}`))[tab]
            || [{ rows: [], hasNext: false, total: 0 }];
          const i = Math.min(perTab[tab] || 0, pages.length - 1);
          perTab[tab] = (perTab[tab] || 0) + 1;
          const p = pages[i];
          return {
            rows: { rows: p.rows.map((r) => ({ ...r })) },
            pagination: { total: p.total, hasNext: p.hasNext, activePage: String(i + 1) },
          };
        };
        if (opts.holdOpen && opts.holdOpen(openNo) && !perTab.__heldOnce) {
          perTab.__heldOnce = true;
          return new Promise((resolve) => held.push({ openNo, resolve: () => resolve(nextPage()) }));
        }
        return nextPage();
      },
      async clickNextPage() { assertOpen(); return { clicked: true }; },
      async clickBatchPause() { calls.adClicks += 1; return {}; },
      async clickBatchEnable() { calls.adClicks += 1; return {}; },
      async clickRowSwitch() { calls.adClicks += 1; return {}; },
    };
    browser.close = async () => {
      calls.close += 1;
      if (closeMode.value === 'reject') throw new Error('mock browser.close rejected');
      browser.closed = true;
    };
    return { browser, page, controller };
  };

  return {
    opener,
    calls,
    held,
    setFailUntil(n) { failUntil = n; },
    setCloseMode(m) { closeMode.value = m; },
    releaseHeld() { for (const h of held.splice(0)) h.resolve(); },
  };
}

function buildMonitor({ dataDir, clock, opener, shops = [SHOP_A, SHOP_B] }) {
  const cfgResult = makeCfgResult({
    // 每个 Monitor 使用独立店铺对象：删除/禁用测试不得污染模块级夹具（否则后续用例店被禁用）。
    shops: shops.map((s) => ({ ...s })),
    monitor: {
      chengfang: {
        scope: [TAB_MAIN, TAB_SUB],
        adStateReadTimeoutMs: 3000,
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

test('G1 连续失败：首次不计，重试满10次=物理11次；每2次一组、组间>=300000ms、组内立即', async () => {
  const dataDir = makeTempDir('grt-g1-');
  const clock = makeClock();
  const fake = makeFactory({ failUntil: Infinity });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown');
  assert.equal(fake.calls.opener, 2, '首次 + 同步1次即时重读（即时重读计入10次）');
  let rec = mon._readRecoveries.get(SHOP_A.id);
  assert.ok(rec, '必须登记本店恢复链');
  assert.equal(rec.attempts, 1, '首次读取不计入10次');
  let p = clock.pending();
  assert.equal(p.length, 1);
  assert.equal(p[0].ms, 0, '同组第2次可立即，不等待5分钟');

  await clock.advance(0);
  rec = mon._readRecoveries.get(SHOP_A.id);
  assert.equal(rec.attempts, 2);
  assert.equal(fake.calls.opener, 3);
  p = clock.pending();
  assert.equal(p.length, 1);
  assert.ok(p[0].ms >= 300000, `组间等待必须>=300000ms，实际=${p[0].ms}`);
  assert.equal(p[0].at, clock.nowFn() + 300000, '等待从组末次完成时算起');

  for (let g = 0; g < 4; g += 1) {
    await clock.advance(300000);
    rec = mon._readRecoveries.get(SHOP_A.id);
    assert.equal(rec.attempts, 4 + g * 2, `第${g + 2}组后应累计${4 + g * 2}次`);
    if (g < 3) {
      p = clock.pending();
      assert.equal(p.length, 1);
      assert.equal(p[0].ms, 300000, '组间严格 300000ms');
    }
  }

  assert.equal(fake.calls.opener, 11, '物理完整回读=首次1+重试10=11次');
  rec = mon._readRecoveries.get(SHOP_A.id);
  assert.equal(rec.attempts, 10);
  assert.equal(rec.phase, 'exhausted');
  assert.equal(clock.pending().length, 0, '满10后停止，不保留第11次 timer');
  await clock.advance(300000);
  assert.equal(fake.calls.opener, 11, '不得自行第11次重试');
  assert.equal(fake.calls.adClicks, 0, '全程零广告点击');

  const view = mon._readRecoveryView(SHOP_A.id);
  assert.equal(view.text, '已重试10次仍失败');
  assert.match(view.lastReason, /末页已读行数 31 与 total 32 不一致/, '必须保留具体失败原因');
  assert.equal(mon._runtime(SHOP_A.id).lastReadError.retryCount, 10, '机读保留已尝试次数');
  assert.match(mon._runtime(SHOP_A.id).lastReadError.reason, /31 与 total 32/);
  const evs = auditEvents(dataDir).filter((j) => j.kind === 'ad-state-read');
  assert.equal(evs.filter((j) => j.event === 'start').length, 11, '审计 start 与物理读取一致');
  assert.ok(evs.some((j) => j.event === 'recovery-exhausted'));
});

test('G2 第1次重试成功即停：不创建恢复链、无等待 timer', async () => {
  const dataDir = makeTempDir('grt-g2-');
  const clock = makeClock();
  const fake = makeFactory({ failUntil: 1 });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'on', JSON.stringify(r.error || r));
  assert.equal(r.error, undefined);
  assert.equal(fake.calls.opener, 2);
  assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined);
  assert.equal(clock.pending().length, 0);
});

test('G3 中间重试成功即停：第3次重试成功后清理进度/旧错误/旧timer', async () => {
  const dataDir = makeTempDir('grt-g3-');
  const clock = makeClock();
  const fake = makeFactory({ failUntil: 3 });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r1 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r1.state, 'unknown');
  assert.equal(fake.calls.opener, 2);
  await clock.advance(0); // 同组第2次重试（仍失败）
  assert.equal(fake.calls.opener, 3);
  assert.equal(mon._readRecoveries.get(SHOP_A.id).attempts, 2);
  await clock.advance(300000); // 第3次重试成功
  assert.equal(fake.calls.opener, 4);

  const rt = mon._runtime(SHOP_A.id);
  assert.equal(rt.lastAdState, 'on');
  assert.equal(rt.lastReadError, null, '成功必须清旧读取错误');
  assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, '成功必须清进度');
  assert.equal(clock.pending().length, 0, '成功必须清 timer');
  assert.equal(fake.calls.adClicks, 0);
  const status = mon.getStatus();
  const row = status.shops.find((s) => s.id === SHOP_A.id);
  assert.equal(row.readRecovery, null);
  assert.equal(row.lastAdState, 'on');
});

test('G4 同店等待期重复触发不叠加：合并返回真实进度，不新增读取/链/timer', async () => {
  const dataDir = makeTempDir('grt-g4-');
  const clock = makeClock();
  const fake = makeFactory({ failUntil: Infinity });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  await mon._readCurrentAdState(SHOP_A);
  assert.equal(fake.calls.opener, 2);
  const r2 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r2.state, 'unknown');
  assert.equal(r2.error.blockedBy, 'recovery_inflight');
  assert.equal(r2.error.recovery.attempts, 1);
  assert.equal(fake.calls.opener, 2, '等待期不得再叠加读取');
  assert.equal(clock.pending().length, 1, '不得叠加第二条链/timer');
  assert.equal(mon._readRecoveries.size, 1);

  await clock.advance(0);
  assert.equal(fake.calls.opener, 3);
  const r3 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r3.error.blockedBy, 'recovery_inflight');
  assert.equal(fake.calls.opener, 3);
});

test('G5 另一店正常：A 店恢复等待不阻塞 B 店真实读取', async () => {
  const dataDir = makeTempDir('grt-g5-');
  const clock = makeClock();
  // 只让 A 店持续失败（B 店首读即成功），验证跨店独立。
  const fake = makeFactory({ failUntil: (shopId) => shopId === SHOP_A.id });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  await mon._readCurrentAdState(SHOP_A);
  assert.ok(mon._readRecoveries.get(SHOP_A.id));
  const before = fake.calls.opener;
  const rB = await mon._readCurrentAdState(SHOP_B);
  assert.equal(rB.state, 'on', JSON.stringify(rB.error || rB));
  assert.equal(fake.calls.opener, before + 1, 'B 店只读取一次（自身首读成功）');
  assert.ok(mon._readRecoveries.get(SHOP_A.id), 'A 店链仍保留');
  assert.equal(fake.calls.adClicks, 0);
});

test('G6 stop 取消等待与迟到结果：不再打开页面、不覆盖状态', async () => {
  const dataDir = makeTempDir('grt-g6-');
  const clock = makeClock();
  const fake = makeFactory({ failUntil: Infinity, holdOpen: (n) => n === 3 });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  await mon._readCurrentAdState(SHOP_A); // opens 1,2
  assert.equal(fake.calls.opener, 2);
  await clock.advance(0); // 第3个 session 的 readView 挂起
  assert.equal(fake.calls.opener, 3);
  assert.equal(fake.held.length, 1, '第3次读取应在途（迟到结果夹具）');
  mon.stop();
  assert.equal(clock.pending().length, 0, 'stop 必须清等待 timer');
  fake.releaseHeld();
  await clock.flush();
  assert.equal(mon._runtime(SHOP_A.id).lastAdState, 'unknown', '迟到结果不得覆盖状态');
  assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined);
  await clock.advance(300000);
  assert.equal(fake.calls.opener, 3, 'stop 后不得再开新页面');
  assert.equal(fake.calls.adClicks, 0);
});

test('G7 删除/禁用取消：删除清 timer；禁用店在下次检查时取消且不读取', async () => {
  {
    const dataDir = makeTempDir('grt-g7a-');
    const clock = makeClock();
    const fake = makeFactory({ failUntil: Infinity });
    const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
    const cfgPath = path.join(dataDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ shops: [SHOP_A, SHOP_B] }));
    mon.cfgResult.sourcePath = cfgPath;
    await mon._readCurrentAdState(SHOP_A);
    assert.ok(mon._readRecoveries.get(SHOP_A.id));
    const del = mon.deleteShop(SHOP_A.id);
    assert.equal(del.ok, true, JSON.stringify(del));
    assert.equal(clock.pending().length, 0, '删除必须清等待 timer');
    assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined);
    const opens = fake.calls.opener;
    await clock.advance(300000);
    assert.equal(fake.calls.opener, opens, '删除后不得再读取');
  }
  {
    const dataDir = makeTempDir('grt-g7b-');
    const clock = makeClock();
    const fake = makeFactory({ failUntil: Infinity });
    const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
    await mon._readCurrentAdState(SHOP_A);
    const opens = fake.calls.opener;
    mon.config.shops.find((s) => s.id === SHOP_A.id).enabled = false; // 禁用
    await clock.advance(0);
    assert.equal(fake.calls.opener, opens, '禁用店不得继续读取');
    assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, '禁用必须取消链');
    assert.equal(clock.pending().length, 0);
  }
});

test('G8 关闭拒绝不新开；关闭恢复后下一次调用可推进收口并成功读取', async () => {
  const dataDir = makeTempDir('grt-g8-');
  const clock = makeClock();
  const fake = makeFactory({ failUntil: 1, closeMode: 'reject' });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r1 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r1.state, 'unknown');
  assert.equal(r1.error.blockedBy, 'unread_session');
  assert.equal(fake.calls.opener, 1, '关闭未证明不得第二次读取');
  assert.equal(clock.pending().length, 0, '关闭未证明不生成恢复链（保守阻断）');
  assert.ok(mon._pendingReadGateFor(SHOP_A.id));

  const r2 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r2.error.blockedBy, 'unread_session');
  assert.equal(fake.calls.opener, 1, '关闭仍拒绝时不得新开');

  fake.setCloseMode('ok');
  const r3 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r3.state, 'on', JSON.stringify(r3.error || r3));
  assert.equal(fake.calls.opener, 2, '关闭被真实证明后才允许下一次读取');
  assert.equal(mon._pendingReadGateFor(SHOP_A.id), null);
  assert.equal(fake.calls.adClicks, 0);
});

test('G9 Auth/身份错误不盲试：不创建恢复链、只 opener 一次', async () => {
  {
    const dataDir = makeTempDir('grt-g9a-');
    const clock = makeClock();
    const fake = makeFactory({ authOn: () => true });
    const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
    const r = await mon._readCurrentAdState(SHOP_A);
    assert.equal(r.state, 'unknown');
    assert.equal(r.error.blocked, 'auth');
    assert.equal(fake.calls.opener, 1);
    assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined);
    assert.equal(clock.pending().length, 0);
  }
  {
    const dataDir = makeTempDir('grt-g9b-');
    const clock = makeClock();
    const fake = makeFactory({ failUntil: Infinity, identityFailOn: () => true });
    const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
    const r = await mon._readCurrentAdState(SHOP_A);
    assert.equal(r.error.blocked, 'identity');
    assert.equal(fake.calls.opener, 1);
    assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined);
    assert.equal(clock.pending().length, 0);
  }
});

test('G10 满10后普通巡查只读一次、不生成无限新链；新成功可重置事件', async () => {
  const dataDir = makeTempDir('grt-g10-');
  const clock = makeClock();
  const fake = makeFactory({ failUntil: Infinity });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r0 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r0.state, 'unknown');
  assert.ok(mon._readRecoveries.get(SHOP_A.id));
  await clock.advance(0);
  assert.equal(fake.calls.opener, 3);
  for (let i = 0; i < 4; i += 1) await clock.advance(300000);
  assert.equal(fake.calls.opener, 11);
  assert.equal(mon._readRecoveryView(SHOP_A.id).phase, 'exhausted');

  const r2 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r2.state, 'unknown');
  assert.equal(fake.calls.opener, 12, '满10后的普通巡查仍按既有调度只读一次');
  assert.equal(mon._readRecoveryView(SHOP_A.id).phase, 'exhausted', '不得自动生成新10次链');
  assert.equal(clock.pending().length, 0);

  fake.setFailUntil(0); // 下一次真实读取成功
  const r3 = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r3.state, 'on', JSON.stringify(r3.error || r3));
  assert.equal(fake.calls.opener, 13);
  assert.equal(mon._readRecoveryView(SHOP_A.id), null, '正常新成功重置恢复事件');
  assert.equal(mon._runtime(SHOP_A.id).lastReadError, null);
  assert.equal(fake.calls.adClicks, 0);
});
