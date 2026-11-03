'use strict';

/**
 * SWITCH-CLICK-RETRY-20261103：千川「切至账户视图」点击错误落盘 + 有界重试。
 *
 * 生产事实：11-03 13:08 简尚 audit 原文「千川"切至账户视图"按钮不可操作或切换导航失败：
 * 未尝试其他按钮」——真实 error.name/message 被吞，无法定位；且任何非遮挡类错误都直接 fail，
 * 不重试。本测试锁定：
 *   a) 首次 TimeoutError(not enabled)、第二次成功 → 成功且点击 2 次；
 *   b) 连续 3 次瞬时错误 → 第 3 次 fail（共重试 2 次），message 含真实错误文本；
 *   c) 点击抛错且 URL 已变 → 立即 fail、只点 1 次；
 *   d) 未知错误类型 → 立即 fail、message 含错误文本；
 *   e) 遮挡（intercepts pointer events）路径行为不变；
 *   f) 全程只点击名为「切至账户视图」的按钮，零业务点击；
 *   g) 重试期间出现登录控件 → AuthError。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { ensureQianchuanAccountView } = require('../src/adapters/qianchuan-reader');
const { AuthError, DataGuardError } = require('../src/lib/errors');

const QC_ACCOUNT_URL = 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424';
const QC_ACCOUNT_URL_2 = 'https://qianchuan.jinritemai.com/home?aavid=1710242295996425';
const SHOP = { name: '简尚衣橱优品店' };

const VIEW_OPTS = {
  readinessTimeoutMs: 500,
  readinessIntervalMs: 10,
  // 冻结时钟：收敛只靠 maxAttempts 限次。
  nowFn: () => 0,
  sleep: async () => {},
};

function makeStub({ views, onSwitchClick = null } = {}) {
  const calls = { switchClicks: 0, businessClicks: 0, roleNames: [] };
  const state = { url: QC_ACCOUNT_URL, login: { loginForm: false, loginControl: false, loginDialog: false } };
  let viewIdx = 0;
  const nextView = () => {
    const v = views[Math.min(viewIdx, views.length - 1)];
    viewIdx += 1;
    return v;
  };
  const page = {
    __calls: calls,
    __state: state,
    url: () => state.url,
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      const src = String(fn);
      if (/扫码登录|loginForm|loginControl/.test(src)) return { ...state.login };
      if (/切至账户视图/.test(src)) {
        if (arg && arg.click === true) {
          return { href: state.url, shopView: false, switchPresent: false, accountContent: false, popup: { present: false, safe: false, reason: 'none', clicked: false } };
        }
        const v = nextView();
        const popup = v.popup || { present: false, safe: false };
        return {
          href: state.url,
          shopView: v.shopView === true,
          switchPresent: v.switchPresent === true,
          accountContent: v.accountContent === true,
          popup: { ...popup, closeTag: null },
        };
      }
      return null;
    },
    getByText: () => ({
      first() { return this; },
      nth() { return this; },
      count: async () => 1,
      isVisible: async () => true,
      click: async () => { calls.businessClicks += 1; },
      evaluate: async () => '',
    }),
    getByRole: (role, opts = {}) => {
      calls.roleNames.push(opts && opts.name);
      if (opts && opts.name === '切至账户视图') {
        return {
          count: async () => 1,
          isVisible: async () => true,
          click: async () => {
            calls.switchClicks += 1;
            if (typeof onSwitchClick === 'function') return onSwitchClick(calls, state);
            return null;
          },
        };
      }
      // 登录控件探针：非「切至账户视图」的按钮一律零点击。
      return {
        count: async () => 0,
        isVisible: async () => false,
        click: async () => { calls.businessClicks += 1; },
      };
    },
    locator: () => ({
      first() { return this; },
      nth() { return this; },
      count: async () => 0,
      click: async () => { calls.businessClicks += 1; },
      textContent: async () => '',
    }),
  };
  return { page, calls, state };
}

function clickError(name, message) {
  const e = new Error(message);
  e.name = name;
  return e;
}

const SHOP_VIEW = { shopView: true, switchPresent: true, popup: { present: false, safe: false } };

// ── a) 首次 TimeoutError(not enabled)，第二次成功 ─────────────────────────
test('a) 首次点击 TimeoutError(not enabled)、第二次成功 → switched=true 且点击 2 次', async () => {
  const { page, calls } = makeStub({
    views: [SHOP_VIEW, SHOP_VIEW, SHOP_VIEW, { shopView: false, switchPresent: false, accountContent: true }],
    onSwitchClick: (c) => {
      if (c.switchClicks === 1) throw clickError('TimeoutError', 'locator.click: Timeout 10000ms exceeded: element is not enabled');
    },
  });
  const result = await ensureQianchuanAccountView(page, SHOP, VIEW_OPTS);
  assert.strictEqual(result.switched, true, '重试后成功切换');
  assert.strictEqual(calls.switchClicks, 2, '首次瞬时失败 + 第二次成功（共 2 次）');
});

// ── b) 连续 3 次瞬时错误 → 第 3 次 fail（重试 2 次用尽）──────────────────
test('b) 连续 3 次瞬时错误 → 第 3 次 fail，共点击 3 次且 message 含真实错误文本', async () => {
  const { page, calls } = makeStub({
    views: [SHOP_VIEW],
    onSwitchClick: () => {
      throw clickError('TimeoutError', 'locator.click: Timeout 10000ms exceeded: element is not visible');
    },
  });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, SHOP, VIEW_OPTS),
    (err) => {
      assert.ok(err instanceof DataGuardError, '应为 DataGuardError');
      assert.match(err.message, /未尝试其他按钮/, '保留原 fail 文案');
      assert.match(err.message, /click 错误：TimeoutError/, 'name 落盘');
      assert.match(err.message, /element is not visible/, '真实错误文本落盘');
      return true;
    }
  );
  assert.strictEqual(calls.switchClicks, 3, '首次 + 重试 2 次 = 3 次');
});

// ── c) 点击抛错且 URL 已变 → 立即 fail、只点 1 次 ────────────────────────
test('c) 点击抛错且 URL 已变化 → 立即 fail，只点击 1 次', async () => {
  const { page, calls, state } = makeStub({
    views: [SHOP_VIEW],
    onSwitchClick: (c, s) => {
      s.url = QC_ACCOUNT_URL_2;
      throw clickError('TimeoutError', 'locator.click: Timeout 10000ms exceeded: element is not enabled');
    },
  });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, SHOP, VIEW_OPTS),
    (err) => err instanceof DataGuardError && /未尝试其他按钮/.test(err.message) && /element is not enabled/.test(err.message)
  );
  assert.strictEqual(calls.switchClicks, 1, '导航已发生：绝不重试');
  assert.strictEqual(state.url, QC_ACCOUNT_URL_2);
});

// ── d) 未知错误类型 → 立即 fail、message 含错误文本 ──────────────────────
test('d) 未知类型错误 → 立即 fail（不重试），message 含错误文本', async () => {
  const { page, calls } = makeStub({
    views: [SHOP_VIEW],
    onSwitchClick: () => { throw clickError('Error', 'Protocol error (Runtime.callFunctionOn): boom'); },
  });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, SHOP, VIEW_OPTS),
    (err) => err instanceof DataGuardError
      && /click 错误：Error/.test(err.message)
      && /Protocol error \(Runtime\.callFunctionOn\): boom/.test(err.message)
  );
  assert.strictEqual(calls.switchClicks, 1, '未知类型不重试');
});

// ── e) 遮挡路径行为不变：intercepts pointer events 仍走再观察，不当瞬时重试 ──
test('e) 遮挡（intercepts pointer events）→ 走原再观察路径，成功切换且只点 2 次', async () => {
  const { page, calls } = makeStub({
    views: [SHOP_VIEW, SHOP_VIEW, SHOP_VIEW, { shopView: false, switchPresent: false, accountContent: true }],
    onSwitchClick: (c) => {
      if (c.switchClicks === 1) throw clickError('TimeoutError', 'locator.click: Timeout 10000ms exceeded: element intercepts pointer events');
    },
  });
  const result = await ensureQianchuanAccountView(page, SHOP, VIEW_OPTS);
  assert.strictEqual(result.switched, true);
  assert.strictEqual(calls.switchClicks, 2);
});

// ── f) 全程只点击「切至账户视图」，零业务点击 ────────────────────────────
test('f) 重试全程只请求并点击「切至账户视图」，零业务点击', async () => {
  const { page, calls } = makeStub({
    views: [SHOP_VIEW],
    onSwitchClick: () => { throw clickError('TimeoutError', 'locator.click: Timeout 10000ms exceeded: element is not stable'); },
  });
  await assert.rejects(() => ensureQianchuanAccountView(page, SHOP, VIEW_OPTS));
  // 登录证据探针会用 getByRole 只读定位「扫码登录」（零点击），需从"可点击定位"中排除。
  const clickTargets = calls.roleNames.filter(n => n !== '扫码登录');
  assert.ok(clickTargets.length > 0);
  assert.ok(clickTargets.every(n => n === '切至账户视图'), `只按名称定位切换按钮，实际：${JSON.stringify(calls.roleNames)}`);
  assert.strictEqual(calls.businessClicks, 0, '绝不点击业务按钮（乘方/开启货款直投）');
});

// ── g) 重试期间出现登录控件 → AuthError ─────────────────────────────────
test('g) 重试期间出现登录控件 → AuthError（不再继续点击）', async () => {
  const { page, calls, state } = makeStub({
    views: [SHOP_VIEW, SHOP_VIEW, SHOP_VIEW],
    onSwitchClick: (c, s) => {
      if (c.switchClicks === 1) {
        s.login = { loginForm: false, loginControl: true, loginDialog: false };
        throw clickError('TimeoutError', 'locator.click: Timeout 10000ms exceeded: element is not enabled');
      }
    },
  });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, SHOP, VIEW_OPTS),
    (err) => err instanceof AuthError && /登录/.test(err.message)
  );
  assert.strictEqual(calls.switchClicks, 1, '登录证据出现后不再点击');
  assert.strictEqual(state.login.loginControl, true);
});
