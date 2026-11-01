'use strict';

/**
 * 传输层瞬时读取失败（DIAN-4 阶段一，2026-10-22 敏敏店"读取受阻"长期悬挂）离线回归。
 *
 * 现场事实：ad-state-read done errorKind=read_failed blocked=inventory
 *   reason=page.goto: net::ERR_CONNECTION_CLOSED at https://fxg.jinritemai.com/...
 * 该原因既不匹配页面级瞬态白名单，也不属于 Auth/身份，因此同轮唯一一次重读与按店有限恢复链
 * 都不启动，本店一直挂到下一个 30 分钟周期（页面长期显示"未知（读取失败）"）。
 *
 * 覆盖：
 *  T1 传输失败判为瞬态：同轮恰好一次额外只读重读，成功即清受阻状态、不建恢复链；
 *  T2 持续传输失败：首次登记恢复链并发出 recovery-scheduled 审计（组 2 次、满 10 停）；
 *  T3 链中途成功：recovery-success 审计 + 清 lastReadError/进度/timer；
 *  T4 满 10 次停止，不再自行第 11 次；全程零广告点击；
 *  T5 分类不被改写：传输失败仍 read_failed，不冒充登录失效；
 *  T6 非传输、非页面白名单的未知错误仍不重试（不扩大重试面）；
 *  T7 登录失效/身份原因即使带 net::ERR_* 也绝不重试（G9 语义保持）；
 *  T8 常见传输码族识别一致。
 *  T9 精确边界：仅商品自选第 1 页 hasNext=null 可重读，其余分页形态与 Cookie 分类不可（含混入网络词）。
 *  T10 null 同轮重读成功即清受阻；T11 持续 null 满 10 停、当次仍 fail-closed、零点击；
 *  T12 链中途转 Auth 立即停止；T13 Cookie 类生产调用链不进链；T14 未纳入分页形态不回退旧契约。
 *  T15–T17 组合原因泄漏：建链判定只看最新一次物理读取的原始错误（首次白名单/传输 → 第二次非瞬态不建链、
 *  timer=0、零点击）；T18 两次精确白名单仍正常建有界链且第 3 次成功即收链。
 *
 * 不访问浏览器/CDP/网络/真实 Cookie；timer 全部注入。
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

const TRANSPORT_REASON = 'page.goto: net::ERR_CONNECTION_CLOSED at https://fxg.jinritemai.com/ffa/mshop/homepage/index';

function rows(prefix, count, checked = true) {
  return Array.from({ length: count }, (_, i) => ({ id: `${prefix}-${i + 1}`, switchChecked: checked }));
}

function okViews(prefix) {
  return {
    [TAB_MAIN]: [{ rows: rows(prefix, 3), hasNext: false, total: 3 }],
    [TAB_SUB]: [{ rows: [], hasNext: false, total: 0 }],
  };
}

function makeClock(startMs = Date.parse('2026-10-22T06:25:00Z')) {
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
    clearTimeoutFn(h) { if (h && h.id != null) timers.delete(h.id); },
    pending() { return Array.from(timers.values()).sort((a, b) => a.at - b.at || a.id - b.id); },
    async advance(ms) {
      now += Math.max(0, Number(ms) || 0);
      for (let guard = 0; guard < 200; guard += 1) {
        const due = Array.from(timers.values()).filter((t) => t.at <= now).sort((a, b) => a.at - b.at || a.id - b.id)[0];
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
 * 假 opener/controller：transportUntil = 前 N 个 session 在首个 readView 抛传输层错误；
 * 其后 session 正常返回完整清单。neverOk=true 时永远抛。throwReason 可替换（T6/T7 用）。
 * sessions=[{throwReason}|{views}] 可按 session 序号精确编排（T9+ 的分页结束标记用例）。
 */
function makeFactory(opts = {}) {
  const transportUntil = opts.neverOk ? Infinity : (opts.transportUntil == null ? 0 : opts.transportUntil);
  const reason = opts.throwReason || TRANSPORT_REASON;
  const calls = { opener: 0, readView: 0, close: 0, adClicks: 0 };
  const byShop = {};

  const opener = async (args) => {
    calls.opener += 1;
    const shopOpen = (byShop[args.shopCfg.id] = (byShop[args.shopCfg.id] || 0) + 1);
    if (opts.authThrow && opts.authThrow(shopOpen)) throw new AuthError('登录失效：持续命中登录页地址或可见登录控件，请重新扫码登录');
    const scripted = (opts.sessions || [])[shopOpen - 1];
    const failing = scripted ? !!scripted.throwReason : (shopOpen <= transportUntil);
    const perTab = {};
    const browser = { closed: false };
    const page = { browser: () => browser, evaluate: async () => null };
    const controller = {
      async verifyIdentity() {
        if (browser.closed) throw new Error('Target page/context has been closed');
        if (opts.identityMismatch) return { ok: false, reason: '页面店铺身份不匹配' };
        return { ok: true, pageShopId: args.shopCfg.id, pageShopName: args.shopCfg.id };
      },
      async refreshView() { if (browser.closed) throw new Error('closed'); return { refreshed: true }; },
      async switchView() { if (browser.closed) throw new Error('closed'); },
      async readView({ tab }) {
        if (browser.closed) throw new Error('Target page/context has been closed');
        calls.readView += 1;
        if (failing) {
          const e = new Error((scripted && scripted.throwReason) || reason);
          if (opts.dataGuardCode) e.code = 'DATA_GUARD';
          throw e;
        }
        const all = (scripted && scripted.views) || okViews(`s${shopOpen}`);
        const pages = all[tab] || [{ rows: [], hasNext: false, total: 0 }];
        const i = Math.min(perTab[tab] || 0, pages.length - 1);
        perTab[tab] = (perTab[tab] || 0) + 1;
        const p = pages[i];
        return {
          rows: { rows: p.rows.map((r) => ({ ...r })) },
          pagination: { total: p.total, hasNext: p.hasNext, activePage: String(i + 1) },
        };
      },
      async clickNextPage() { if (browser.closed) throw new Error('closed'); return { clicked: true }; },
      async clickBatchPause() { calls.adClicks += 1; return {}; },
      async clickBatchEnable() { calls.adClicks += 1; return {}; },
      async clickRowSwitch() { calls.adClicks += 1; return {}; },
    };
    browser.close = async () => { calls.close += 1; browser.closed = true; };
    return { browser, page, controller };
  };
  return { opener, calls };
}

function buildMonitor({ dataDir, clock, opener }) {
  const cfgResult = makeCfgResult({
    shops: [{ ...SHOP_A }],
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

function auditEvents(dataDir, kind = 'ad-state-read') {
  const p = path.join(dataDir, 'audit.jsonl');
  return fs.existsSync(p)
    ? fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((j) => j.kind === kind)
    : [];
}

test('T1 传输失败判为瞬态：同轮恰好一次重读，成功后立即清受阻状态、不建链', async () => {
  const dataDir = makeTempDir('trr-t1-');
  const clock = makeClock();
  const fake = makeFactory({ transportUntil: 1 });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  assert.equal(mon._isTransientReadError({
    status: 'blocked', reason: TRANSPORT_REASON, blocked: 'inventory',
  }), true, 'net::ERR_CONNECTION_CLOSED 必须判为可安全重读');

  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'on', JSON.stringify(r.error || r));
  assert.equal(r.error, undefined);
  assert.equal(fake.calls.opener, 2, '首次 + 同轮唯一一次重读');
  assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, '重读成功不得建恢复链');
  assert.equal(clock.pending().length, 0);
  const rt = mon._runtime(SHOP_A.id);
  assert.equal(rt.lastReadError, null, '成功必须清除页面受阻错误');
  const row = mon.getStatus().shops.find((s) => s.id === SHOP_A.id);
  assert.equal(row.readRecovery, null);
  assert.equal(row.lastReadError, null, '页面状态不得继续携带读取受阻错误');
  assert.equal(row.lastError, null);
  assert.equal(fake.calls.adClicks, 0, '全程零广告点击');
  assert.ok(auditEvents(dataDir).some((j) => j.event === 'retry' && /net::ERR_CONNECTION_CLOSED/.test(String(j.reason))), '同轮重读必须有 retry 审计');
});

test('T2 持续传输失败：首次发出 recovery-scheduled 审计并按组有界再调度', async () => {
  const dataDir = makeTempDir('trr-t2-');
  const clock = makeClock();
  const fake = makeFactory({ neverOk: true });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown');
  assert.match(r.error.reason, /net::ERR_CONNECTION_CLOSED/);
  assert.match(r.error.reason, /已启动有限恢复/, '必须告知已进入有限恢复链');
  assert.equal(fake.calls.opener, 2, '同轮只多读一次');

  const sched = auditEvents(dataDir).filter((j) => j.event === 'recovery-scheduled');
  assert.equal(sched.length, 1, '传输失败此前从不登记恢复链，现必须首次登记');
  assert.equal(sched[0].maxRetries, 10);
  assert.equal(sched[0].groupSize, 2);
  assert.equal(sched[0].groupWaitMs, 300000);

  const rec = mon._readRecoveries.get(SHOP_A.id);
  assert.ok(rec, '按店登记恢复链');
  assert.equal(rec.attempts, 1, '同轮那次即时重读计入 10 次');
  const p = clock.pending();
  assert.equal(p.length, 1);
  assert.equal(p[0].ms, 0, '同组第 2 次立即，不等待');
  const row = mon.getStatus().shops.find((s) => s.id === SHOP_A.id);
  assert.equal(row.readRecovery.text, '恢复中（1/10），下次重试 14:25');
  assert.equal(mon._runtime(SHOP_A.id).lastReadError.kind, 'retrying', '页面不得停在长期未知');
  assert.equal(row.lastAdState, 'unknown');
});

test('T3 链中途成功：recovery-success 审计 + 清旧错误/进度/timer', async () => {
  const dataDir = makeTempDir('trr-t3-');
  const clock = makeClock();
  const fake = makeFactory({ transportUntil: 3 });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown');
  assert.ok(mon._readRecoveries.get(SHOP_A.id));
  await clock.advance(0); // 第 2 次重试（仍失败）→ 满一组
  assert.equal(mon._readRecoveries.get(SHOP_A.id).attempts, 2);
  const p = clock.pending();
  assert.equal(p.length, 1);
  assert.ok(p[0].ms >= 300000, '组间退避至少 300000ms（短时退避，非挂到下一周期）');

  await clock.advance(300000); // 第 3 次重试成功
  const rt = mon._runtime(SHOP_A.id);
  assert.equal(rt.lastAdState, 'on');
  assert.equal(rt.lastReadError, null);
  assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, '成功必须收链');
  assert.equal(clock.pending().length, 0, '成功必须清 timer');
  assert.ok(auditEvents(dataDir).some((j) => j.event === 'recovery-success'), '必须留 recovery-success 审计');
});

test('T4 满 10 次停止：不再自行第 11 次，零广告点击', async () => {
  const dataDir = makeTempDir('trr-t4-');
  const clock = makeClock();
  const fake = makeFactory({ neverOk: true });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  await mon._readCurrentAdState(SHOP_A);
  await clock.advance(0);
  for (let i = 0; i < 4; i += 1) await clock.advance(300000);
  assert.equal(fake.calls.opener, 11, '物理读取=首次1+重试10');
  const view = mon._readRecoveryView(SHOP_A.id);
  assert.equal(view.phase, 'exhausted');
  assert.equal(view.text, '已重试10次仍失败');
  assert.equal(clock.pending().length, 0, '耗尽后不留 timer，不自第 11 次');
  assert.ok(auditEvents(dataDir).some((j) => j.event === 'recovery-exhausted'));
  await clock.advance(300000 * 3);
  assert.equal(fake.calls.opener, 11, '耗尽后不得无限循环');
  assert.equal(fake.calls.adClicks, 0);
});

test('T5 分类不被改写：传输失败仍是 read_failed，不冒充登录失效', async () => {
  const dataDir = makeTempDir('trr-t5-');
  const clock = makeClock();
  const fake = makeFactory({ neverOk: true });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.error.blocked, 'inventory', '不得升级成 auth');
  assert.equal(mon._readErrorKind(r.error), 'read_failed');
  assert.equal(mon._maskReadError(r.error).kind, 'read_failed');
  assert.doesNotMatch(JSON.stringify(r.error), /扫码|登录失效/, '不得要求用户重新扫码');
  assert.doesNotMatch(JSON.stringify(mon.getStatus().shops[0]), /扫码|登录失效/, '页面状态不得改写为登录失效');
});

test('T6 未知非传输错误仍不重试（不扩大重试面）', async () => {
  const dataDir = makeTempDir('trr-t6-');
  const clock = makeClock();
  const fake = makeFactory({ neverOk: true, throwReason: '页面出现无法识别的危险弹窗，已停止本次操作' });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown');
  assert.equal(fake.calls.opener, 1, '非瞬态错误不得同轮重读');
  assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, '非瞬态错误不得建恢复链');
  assert.equal(clock.pending().length, 0);
  assert.equal(auditEvents(dataDir).filter((j) => j.event === 'recovery-scheduled').length, 0);
});

test('T7 登录失效/身份即使带 net::ERR_* 也绝不重试', async () => {
  {
    const dataDir = makeTempDir('trr-t7a-');
    const clock = makeClock();
    const fake = makeFactory({ neverOk: true, throwReason: `登录失效：请重新扫码登录（${TRANSPORT_REASON}）` });
    const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
    const r = await mon._readCurrentAdState(SHOP_A);
    assert.equal(r.error.blocked, 'auth');
    assert.equal(fake.calls.opener, 1, '登录正证据不做盲试重读');
    assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined);
    assert.equal(clock.pending().length, 0);
  }
  {
    const dataDir = makeTempDir('trr-t7b-');
    const clock = makeClock();
    const fake = makeFactory({ authThrow: () => true });
    const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
    const r = await mon._readCurrentAdState(SHOP_A);
    assert.equal(r.state, 'unknown');
    assert.equal(fake.calls.opener, 1);
    assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined);
  }
});

test('T8 传输错误码族识别一致；正常原因不误判', () => {
  const dataDir = makeTempDir('trr-t8-');
  const clock = makeClock();
  const mon = buildMonitor({ dataDir, clock, opener: makeFactory({}).opener });
  const t = (reason) => mon._isTransientReadError({ status: 'blocked', reason, blocked: 'inventory' });
  for (const reason of [
    'page.goto: net::ERR_CONNECTION_RESET at https://example.com/a',
    'page.goto: net::ERR_NAME_NOT_RESOLVED at https://example.com/a',
    'net::ERR_INTERNET_DISCONNECTED',
    'net::ERR_TIMED_OUT',
    'socket hang up',
    'read ECONNRESET',
    'connect ETIMEDOUT',
    'getaddrinfo EAI_AGAIN fxg.jinritemai.com',
  ]) {
    assert.equal(t(reason), true, `必须判为可重读：${reason}`);
  }
  // 既有页面级瞬态原因保持可重读；本地/清单/危险类原因仍不新增重试。
  assert.equal(t('末页已读行数 31 与 total 32 不一致：清单不完整'), true);
  assert.equal(t('乘方「全店托管」第 2 页读取失败'), false, '单页读取失败语义不变');
  assert.equal(t('Cookie 文件解析失败'), false, '本地故障不靠重读');
  assert.equal(t('乘方「全店托管」计划 ID 跨页重复：ad-1'), false, '重复 ID 不重试');
});

// ── 2026-10-22 独立验收最小边界：商品自选首屏 hasNext=null 精确纳入有界链 + Cookie 分类硬排除 ──

const SUB_P1_NULL_REASON = '乘方「商品自选」第 1 页 hasNext=null：分页结束标记不明确，清单不完整';

function subP1NullViews() {
  return {
    [TAB_MAIN]: [{ rows: rows('m', 2), hasNext: false, total: 2 }],
    [TAB_SUB]: [{ rows: rows('s', 1), hasNext: null, total: 1 }],
  };
}

function mainP1NullViews() {
  return {
    [TAB_MAIN]: [{ rows: rows('m', 1), hasNext: null, total: 1 }],
    [TAB_SUB]: [{ rows: [], hasNext: false, total: 0 }],
  };
}

function subP2NullViews() {
  return {
    [TAB_MAIN]: [{ rows: rows('m', 2), hasNext: false, total: 2 }],
    [TAB_SUB]: [
      { rows: rows('s1', 1), hasNext: true, total: 2 },
      { rows: rows('s2', 1), hasNext: null, total: 2 },
    ],
  };
}

function subStringHasNextViews() {
  return {
    [TAB_MAIN]: [{ rows: rows('m', 2), hasNext: false, total: 2 }],
    [TAB_SUB]: [{ rows: rows('s', 1), hasNext: 'null', total: 1 }],
  };
}

test('T9 精确边界：仅商品自选第 1 页 hasNext=null 可重读；其余分页异常一律不可', () => {
  const dataDir = makeTempDir('trr-t9-');
  const clock = makeClock();
  const mon = buildMonitor({ dataDir, clock, opener: makeFactory({}).opener });
  const t = (reason, blocked) => mon._isTransientReadError({ status: 'blocked', reason, blocked: blocked || 'inventory' });

  assert.equal(t(SUB_P1_NULL_REASON), true, '精确原因（原始单次读取）必须纳入既有有界链');

  // 组合展示文本不得再次点亮白名单：判定只看最新一次物理读取的原始原因（T16/T17 覆盖调用点）。
  for (const reason of [
    `首次回读失败（${SUB_P1_NULL_REASON}）；已重试1次仍未恢复：${SUB_P1_NULL_REASON}`,
    `首次回读失败（${SUB_P1_NULL_REASON}）；已重试1次仍未恢复：乘方「商品自选」第 2 页 hasNext=null：分页结束标记不明确，清单不完整`,
    `首次回读失败（${SUB_P1_NULL_REASON}）；已重试1次仍未恢复：乘方「商品自选」第 2 页读取失败`,
    `${SUB_P1_NULL_REASON}；已启动有限恢复（1/10）`,
    `前置说明：${SUB_P1_NULL_REASON}`,
  ]) {
    assert.equal(t(reason), false, `组合/带前后缀文本不得按"包含"命中白名单：${reason}`);
  }

  // 禁止泛化：另一 tab、第 2 页起、字符串 hasNext、页码乱序/重复页、超上限、翻页失败、total 非法均不可。
  for (const reason of [
    '乘方「全店托管」第 1 页 hasNext=null：分页结束标记不明确，清单不完整',
    '乘方「商品自选」第 2 页 hasNext=null：分页结束标记不明确，清单不完整',
    '乘方「商品自选」第 1 页 hasNext="null"：分页结束标记不明确，清单不完整',
    '乘方「商品自选」第 1 页 hasNext=true：分页结束标记不明确，清单不完整',
    '乘方「商品自选」页码不递增：activePage=1（期望 2）',
    '乘方「商品自选」重复页：activePage=1',
    '乘方「商品自选」分页超过上限，清单不完整',
    '乘方「商品自选」翻页失败，清单不完整',
    '乘方「商品自选」total 非法：-1',
    '乘方「商品自选」第 1 页存在无稳定 ID 行，清单不可信',
    '乘方「商品自选」无行但缺少空态证据（分页 total=缺失）',
  ]) {
    assert.equal(t(reason), false, `不得泛化纳入重试：${reason}`);
  }

  // Cookie 分类硬排除：即使 reason 混入网络词或清单短语也绝不重试（本地故障重读无解）。
  for (const [reason, blocked] of [
    ['Cookie 文件解析失败：Unexpected token < in JSON', 'cookie_invalid'],
    ['未找到店铺 敏敏高定私服 的 Cookie 文件', 'cookie_blocked'],
    ['正在同步该店 Cookie 副本，稍后重试', 'cookie_blocked'],
    [`Cookie 文件不可读（EACCES）伴随 net::ERR_CONNECTION_CLOSED`, 'cookie_blocked'],
    [`读取乘方页失败：socket hang up；Cookie 文件格式异常`, 'cookie_invalid'],
    [`未找到店铺 shop-x 的 Cookie 文件（net::ERR_TIMED_OUT）`, 'inventory'],
    ['Cookie 数组中存在缺少 name 的条目', 'ad_state_read'],
  ]) {
    assert.equal(t(reason, blocked), false, `Cookie 本地故障不得进恢复链：${reason}`);
    assert.notEqual(mon._readFailureClass(reason), null, '夹具必须确实属于 Cookie 类');
  }
  assert.equal(t(`net::ERR_CONNECTION_CLOSED ${SUB_P1_NULL_REASON}`, 'inventory'), true, '传输原因仍优先可重读');
});

test('T10 商品自选第1页 null：同轮一次重读成功即清受阻，不建链且当次不采信不完整清单', async () => {
  const dataDir = makeTempDir('trr-t10-');
  const clock = makeClock();
  const fake = makeFactory({ sessions: [{ views: subP1NullViews() }] });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'on', JSON.stringify(r.error || r));
  assert.equal(r.error, undefined, '重读成功即清页面受阻');
  assert.equal(fake.calls.opener, 2, '首次 + 同轮唯一一次重读');
  assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined);
  assert.equal(clock.pending().length, 0);
  assert.equal(mon._runtime(SHOP_A.id).lastReadError, null);
  assert.equal(fake.calls.adClicks, 0, '受阻当次零广告点击');
  assert.ok(auditEvents(dataDir).some((j) => j.event === 'retry' && /hasNext=null/.test(String(j.reason))), '必须留同轮重读审计');
});

test('T11 持续商品自选第1页 null：进入有界链、满 10 停、当次读数始终 blocked/unknown、零点击', async () => {
  const dataDir = makeTempDir('trr-t11-');
  const clock = makeClock();
  const fake = makeFactory({ sessions: Array.from({ length: 30 }, () => ({ views: subP1NullViews() })) });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown', '清单不可信时当次读数必须 fail-closed');
  assert.equal(r.error.blocked, 'inventory', '不得改写成 auth/identity');
  assert.match(r.error.reason, /分页结束标记不明确/);
  assert.equal(fake.calls.opener, 2);
  const sched = auditEvents(dataDir).filter((j) => j.event === 'recovery-scheduled');
  assert.equal(sched.length, 1, '该原因此前不进链，现必须进链');
  assert.equal(sched[0].groupSize, 2);
  assert.equal(sched[0].maxRetries, 10);
  assert.equal(mon.getStatus().shops[0].readRecovery.text, '恢复中（1/10），下次重试 14:25', '页面不得停在裸未知');

  await clock.advance(0);
  assert.equal(mon._readRecoveries.get(SHOP_A.id).attempts, 2);
  assert.ok(clock.pending()[0].ms >= 300000, '组间短时退避');
  for (let i = 0; i < 4; i += 1) await clock.advance(300000);
  assert.equal(fake.calls.opener, 11, '物理读取上限=首次1+重试10');
  assert.equal(mon._readRecoveryView(SHOP_A.id).phase, 'exhausted');
  assert.equal(clock.pending().length, 0, '耗尽后不留 timer');
  await clock.advance(300000 * 4);
  assert.equal(fake.calls.opener, 11, '不得无限循环');
  assert.equal(fake.calls.adClicks, 0, '全程零投放点击');
  assert.equal(mon._runtime(SHOP_A.id).lastAdState, 'unknown', '不完整清单不得被当作完成态');
  assert.ok(auditEvents(dataDir).some((j) => j.event === 'recovery-exhausted'));
});

test('T12 链中途转 Auth：立即停止恢复、清 timer、不再新开页面、状态如实保留', async () => {
  const dataDir = makeTempDir('trr-t12-');
  const clock = makeClock();
  const fake = makeFactory({
    sessions: [{ views: subP1NullViews() }, { views: subP1NullViews() }],
    authThrow: (shopOpen) => shopOpen >= 3,
  });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  await mon._readCurrentAdState(SHOP_A);
  assert.ok(mon._readRecoveries.get(SHOP_A.id), '首次进链');
  await clock.advance(0); // 组内第 2 次重试 → 命中登录正证据
  assert.equal(fake.calls.opener, 3);
  const rec = mon._readRecoveries.get(SHOP_A.id);
  assert.equal(rec.phase, 'stopped', '转 Auth 必须立即停止快速恢复');
  assert.equal(clock.pending().length, 0, '停止必须清 timer');
  assert.equal(mon._runtime(SHOP_A.id).lastReadError.kind, 'auth', '分类必须如实转 auth');
  assert.ok(auditEvents(dataDir).some((j) => j.event === 'recovery-stopped'));
  await clock.advance(300000 * 2);
  assert.equal(fake.calls.opener, 3, '停止后不得继续盲试');
  assert.equal(fake.calls.adClicks, 0);
});

test('T13 Cookie 类失败在生产调用链上仍单次读取、不进链（含混入网络词的夹具）', async () => {
  {
    const dataDir = makeTempDir('trr-t13a-');
    const clock = makeClock();
    const fake = makeFactory({ neverOk: true, throwReason: 'Cookie 文件解析失败：JSON 中位置 0 出现非法字符（net::ERR_CONNECTION_CLOSED）' });
    const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
    const r = await mon._readCurrentAdState(SHOP_A);
    assert.equal(r.error.blocked, 'cookie_invalid', '分类保持 Cookie 本地故障');
    assert.equal(fake.calls.opener, 1, 'Cookie 故障不得同轮重读');
    assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, 'Cookie 故障不得建恢复链');
    assert.equal(clock.pending().length, 0);
    assert.equal(auditEvents(dataDir).filter((j) => j.event === 'recovery-scheduled').length, 0);
  }
  {
    const dataDir = makeTempDir('trr-t13b-');
    const clock = makeClock();
    const fake = makeFactory({ neverOk: true, throwReason: '正在同步该店 Cookie 副本，暂不可读' });
    const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
    const r = await mon._readCurrentAdState(SHOP_A);
    assert.equal(r.error.blocked, 'cookie_blocked');
    assert.equal(fake.calls.opener, 1);
    assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined);
  }
});

test('T14 未纳入的分页形态保持旧契约：仅一次读取、不建链（不回退 T9c 保护）', async () => {
  const cases = [
    ['全店托管第1页 null', mainP1NullViews()],
    ['商品自选第2页 null', subP2NullViews()],
    ['hasNext 为字符串', subStringHasNextViews()],
  ];
  for (const [label, views] of cases) {
    const dataDir = makeTempDir('trr-t14-');
    const clock = makeClock();
    const fake = makeFactory({ sessions: [{ views }] });
    const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
    const r = await mon._readCurrentAdState(SHOP_A);
    assert.equal(r.state, 'unknown', `${label}：清单不可信必须 fail-closed`);
    assert.equal(r.error.blocked, 'inventory', label);
    assert.equal(fake.calls.opener, 1, `${label}：不得泛化进重试/恢复链`);
    assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, label);
    assert.equal(clock.pending().length, 0, label);
    assert.equal(fake.calls.adClicks, 0, label);
  }
});

// ── 2026-10-22 组合原因泄漏修复（独立验收最终边界）：建链判定只看最新一次物理读取 ──

test('T15 首次白名单、第二次转非白名单分页异常：不建链、timer=0、当次仍 fail-closed 零点击', async () => {
  const dataDir = makeTempDir('trr-t15-');
  const clock = makeClock();
  const fake = makeFactory({ sessions: [{ views: subP1NullViews() }, { views: subP2NullViews() }] });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown', '最新一次清单不可信 → 当次读数 fail-closed');
  assert.equal(r.error.blocked, 'inventory');
  assert.equal(fake.calls.opener, 2, '只允许同轮那一次重读');
  assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, '最新原因不满足白名单，绝不得凭组合文本续链');
  assert.equal(clock.pending().length, 0, '不建链即不留 timer');
  assert.equal(auditEvents(dataDir).filter((j) => j.event === 'recovery-scheduled').length, 0);
  assert.equal(mon.getStatus().shops[0].readRecovery, null, '页面不得显示恢复中');
  assert.equal(fake.calls.adClicks, 0, '全程零投放点击');
  assert.match(r.error.reason, /首次回读失败/, '展示/审计仍保留组合原因');
});

test('T16 首次白名单、第二次转第2页 null / 重复 ID / 字符串 hasNext：一律不建链', async () => {
  const second = [
    ['第2页 null', subP2NullViews()],
    ['字符串 hasNext', subStringHasNextViews()],
  ];
  for (const [label, views] of second) {
    const dataDir = makeTempDir('trr-t16-');
    const clock = makeClock();
    const fake = makeFactory({ sessions: [{ views: subP1NullViews() }, { views }] });
    const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
    const r = await mon._readCurrentAdState(SHOP_A);
    assert.equal(r.state, 'unknown', label);
    assert.equal(fake.calls.opener, 2, `${label}：不得凭组合文本继续建链`);
    assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, label);
    assert.equal(clock.pending().length, 0, `${label}：timer=0`);
    assert.equal(fake.calls.adClicks, 0, label);
  }
  {
    // 第二次为计划 ID 跨页重复：同样不可续链（重复 ID 属不可重试保护）。
    const dataDir = makeTempDir('trr-t16c-');
    const clock = makeClock();
    const dupSub = {
      [TAB_MAIN]: [{ rows: rows('m', 2), hasNext: false, total: 2 }],
      [TAB_SUB]: [
        { rows: [{ id: 'same', switchChecked: true }], hasNext: true, total: 2 },
        { rows: [{ id: 'same', switchChecked: true }], hasNext: false, total: 2 },
      ],
    };
    const fake = makeFactory({ sessions: [{ views: subP1NullViews() }, { views: dupSub }] });
    const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
    const r = await mon._readCurrentAdState(SHOP_A);
    assert.equal(r.state, 'unknown');
    assert.equal(r.error.blocked, 'inventory');
    assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, '重复 ID 不得续链');
    assert.equal(clock.pending().length, 0);
    assert.equal(fake.calls.adClicks, 0);
  }
});

test('T17 首次传输错、第二次非瞬态：组合文本含网络词也不建链（同类泄漏一并堵住）', async () => {
  const dataDir = makeTempDir('trr-t17-');
  const clock = makeClock();
  const fake = makeFactory({
    sessions: [{ throwReason: TRANSPORT_REASON }, { throwReason: '乘方「商品自选」第 2 页读取失败' }],
  });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });
  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown');
  assert.equal(fake.calls.opener, 2, '同轮一次重读后必须停');
  assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined, '最新一次已非瞬态，不得建链');
  assert.equal(clock.pending().length, 0);
  assert.equal(auditEvents(dataDir).filter((j) => j.event === 'recovery-scheduled').length, 0);
  assert.match(r.error.reason, /net::ERR_CONNECTION_CLOSED/, '展示仍保留首次传输原因');
  assert.equal(fake.calls.adClicks, 0);
});

test('T18 两次精确白名单：仍进入既有有界链，第 3 次重试成功即收链清状态', async () => {
  const dataDir = makeTempDir('trr-t18-');
  const clock = makeClock();
  const fake = makeFactory({
    sessions: [
      { views: subP1NullViews() },
      { views: subP1NullViews() },
      { views: subP1NullViews() },
      { views: okViews('third') },
    ],
  });
  const mon = buildMonitor({ dataDir, clock, opener: fake.opener });

  const r = await mon._readCurrentAdState(SHOP_A);
  assert.equal(r.state, 'unknown');
  assert.equal(fake.calls.opener, 2);
  const rec = mon._readRecoveries.get(SHOP_A.id);
  assert.ok(rec, '两次都精确命中白名单 → 正常建有界链');
  assert.equal(rec.attempts, 1);
  assert.equal(mon._readRecoveryView(SHOP_A.id).text, '恢复中（1/10），下次重试 14:25');
  const sched = auditEvents(dataDir).filter((j) => j.event === 'recovery-scheduled');
  assert.equal(sched.length, 1);
  assert.match(String(sched[0].reason), /商品自选」第 1 页 hasNext=null/);

  await clock.advance(0); // 组内第 2 次重试：仍精确白名单 → 满一组后退避
  assert.equal(mon._readRecoveries.get(SHOP_A.id).attempts, 2);
  assert.ok(clock.pending()[0].ms >= 300000, '组间仍按 300000ms 短时退避');
  await clock.advance(300000); // 第 3 次重试成功
  const rt = mon._runtime(SHOP_A.id);
  assert.equal(rt.lastAdState, 'on');
  assert.equal(rt.lastReadError, null, '成功即清受阻状态');
  assert.equal(mon._readRecoveries.get(SHOP_A.id), undefined);
  assert.equal(clock.pending().length, 0);
  assert.ok(auditEvents(dataDir).some((j) => j.event === 'recovery-success'));
  assert.equal(fake.calls.adClicks, 0);
});
