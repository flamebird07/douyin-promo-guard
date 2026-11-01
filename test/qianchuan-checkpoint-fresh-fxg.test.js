'use strict';

/**
 * AD-MINMIN-LOGIN-HANDOFF-20261021-F1-R2 离线测试（任务 C）：
 * 千川会话检查点不得把「千川页面有效」单独当作覆盖 guard work 的充分条件。
 *
 * 提交前必须对**同一候选 Cookie**在独立新上下文取得新鲜的抖店 FXG 登录 + 店铺身份正证据；
 * 该证据缺失/失败时，即使千川页 URL、头部账户 ID、无登录控件全部成立，也必须零写入
 * （文件字节不变），且原因如实指向独立复用/身份验证。
 *
 * 无网络、无真实浏览器、无真实 Cookie（全部 FAKE_* 占位）。
 * 运行：node --test douyin-promo-guard/test/qianchuan-checkpoint-fresh-fxg.test.js
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  decideQianchuanCheckpoint,
  checkpointQianchuanSessionCookies,
} = require('../src/login/session-cookie-checkpoint');
const { fingerprintFile } = require('../src/login/cookie-writeback');

const ACCOUNT = '1710242295996424';
const QC_HOME = `https://qianchuan.jinritemai.com/home?aavid=${ACCOUNT}`;
const FXG_HOME = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const FXG_LOGIN = 'https://fxg.jinritemai.com/login/common';
const SHOP = '测试店铺';

let dir = null;
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-fresh-fxg-test-')); });
after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } });

function fakeCookies(n = 3) {
  const out = [];
  for (let i = 0; i < n; i += 1) {
    out.push({
      name: i === 0 ? 'sessionid' : `ck_${i}`,
      value: `FAKE_VALUE_NOT_REAL_${i}`,
      domain: i === 0 ? '.fxg.jinritemai.com' : '.jinritemai.com',
      path: '/',
      expires: Math.floor(Date.now() / 1000) + 86400,
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    });
  }
  return out;
}

function cookiePath() { return path.join(dir, `${SHOP}.json`); }

function writeCookieFile(cookies) {
  fs.writeFileSync(cookiePath(), JSON.stringify(cookies, null, 2));
  return fingerprintFile(cookiePath());
}

/**
 * 独立验证浏览器：模拟「候选 Cookie 注入新上下文后进入抖店」的结果。
 *  - landAt=FxgLogin：仍停在登录页（无 FXG 登录正证据）；
 *  - landAt=FxgHome + shopName：到达受信首页，但语义店名可为错店。
 * 记录注入的 Cookie 与新建上下文次数，用于证明验证确实在**独立新上下文**里发生。
 */
function makeVerifyBrowser({ landAt, shopName = SHOP }) {
  const calls = { contexts: 0, injected: [] };
  return {
    calls,
    async newContext() {
      calls.contexts += 1;
      let injected = [];
      let url = landAt;
      const page = {
        async goto() {},
        url: () => url,
        async evaluate(fn) {
          if (!/index_userName/.test(String(fn))) return null;
          if (landAt === FXG_LOGIN) return null;
          return { name: shopName, distinct: [shopName], candidates: 1, unique: true, loginVisible: false };
        },
      };
      return {
        async addCookies(arr) { injected = Array.isArray(arr) ? arr.slice() : []; calls.injected.push(injected); },
        async newPage() { return page; },
        async cookies() { return injected.slice(); },
        async close() {},
      };
    },
  };
}

/** 千川页本身完全有效（URL + 唯一头部账户 + 无登录控件）。 */
function makeQianchuanPage(refreshed) {
  const calls = { cookieReads: 0 };
  const page = {
    url: () => QC_HOME,
    async evaluate(fn) {
      return /shop-name/.test(String(fn))
        ? { accountId: ACCOUNT, accountName: '伊人美', candidates: 1, unique: true, loginVisible: false }
        : null;
    },
  };
  const context = {
    async cookies() { calls.cookieReads += 1; return refreshed; },
    browser: () => { throw new Error('should not be used: 本测试显式注入 p.browser'); },
  };
  return { page, context, calls };
}

test('千川页有效但独立新上下文仍停在抖店登录页：零写入，且候选确实被注入独立上下文', async () => {
  writeCookieFile(fakeCookies(3));
  const beforeBuf = fs.readFileSync(cookiePath());
  const startFp = fingerprintFile(cookiePath());
  const refreshed = fakeCookies(4);
  const qc = makeQianchuanPage(refreshed);
  const verifyBrowser = makeVerifyBrowser({ landAt: FXG_LOGIN });

  // 前置事实：千川页自身证据成立（有效 URL + 唯一账户 + 无登录控件）。
  assert.strictEqual(decideQianchuanCheckpoint({
    url: QC_HOME,
    expectedAccountId: ACCOUNT,
    observed: { accountId: ACCOUNT, unique: true, loginVisible: false },
  }).ok, true, '前置：千川页证据有效');

  const r = await checkpointQianchuanSessionCookies({
    context: qc.context,
    cookieSession: { filePath: cookiePath(), startFingerprint: startFp },
    target: qc.page,
    shopCfg: { id: 'shop-001', name: SHOP, accountId: ACCOUNT },
    browser: verifyBrowser,
    candidateVerifyOptions: { maxWaitMs: 4000, sleep: async () => {} },
  });

  assert.strictEqual(r.saved, false, '千川页有效 + FXG 登录无效 → 必须零写入');
  assert.match(r.reason, /独立复用|登录无效|候选未通过/, `原因须指向独立验证：${r.reason}`);
  assert.deepStrictEqual(fs.readFileSync(cookiePath()), beforeBuf, '目标文件字节不变');
  assert.strictEqual(verifyBrowser.calls.contexts, 1, '必须实际创建独立新上下文做新鲜 FXG 验证');
  assert.strictEqual(verifyBrowser.calls.injected.length, 1, '候选必须被注入独立上下文');
  assert.deepStrictEqual(verifyBrowser.calls.injected[0], refreshed, '注入的必须是同一候选集合');
});

test('独立上下文到达受信抖店首页但店铺身份不符：零写入（登录正证据 + 身份正证据缺一不可）', async () => {
  writeCookieFile(fakeCookies(3));
  const beforeBuf = fs.readFileSync(cookiePath());
  const startFp = fingerprintFile(cookiePath());
  const refreshed = fakeCookies(4);
  const qc = makeQianchuanPage(refreshed);
  const verifyBrowser = makeVerifyBrowser({ landAt: FXG_HOME, shopName: '另一家店' });

  const r = await checkpointQianchuanSessionCookies({
    context: qc.context,
    cookieSession: { filePath: cookiePath(), startFingerprint: startFp },
    target: qc.page,
    shopCfg: { id: 'shop-001', name: SHOP, accountId: ACCOUNT },
    browser: verifyBrowser,
    candidateVerifyOptions: { maxWaitMs: 4000, sleep: async () => {} },
  });

  assert.strictEqual(r.saved, false, '身份不符 → 必须零写入');
  assert.match(r.reason, /身份|独立复用|候选未通过/, `原因须指向身份/独立验证：${r.reason}`);
  assert.deepStrictEqual(fs.readFileSync(cookiePath()), beforeBuf, '目标文件字节不变');
  assert.strictEqual(verifyBrowser.calls.contexts, 1);
});
