'use strict';

/**
 * 登录告警分类（2026-10-18 F5-R9）Guard 侧离线回归：
 * 通用 AuthError / blocked=auth 不是「登录失效」的充分证据——Cookie 文件解析/结构坏、
 * 缺文件/不可读/同步锁、身份冲突/未配置都从 AuthError 抛出，但它们是本地故障，不要求扫码。
 *
 * 覆盖：
 *  C1 _readErrorKind 分类表（cookie_invalid / cookie_blocked / identity / auth / timeout /
 *     retrying / 无正证据通用 auth → read_failed）；
 *  C2 真实 _readChengfangAdState catch：Cookie 解析失败 → cookie_invalid，只 opener 一次；
 *  C3 真实 catch：工作副本同步锁 → cookie_blocked，只 opener 一次；
 *  C4 真实 catch：身份/账户未配置 → identity，不是 auth；
 *  C5 真实 catch：通用 AuthError（无登录正证据）→ read_failed，不冒充登录失效；
 *  C6 真实 catch：持续登录页正证据 → auth（真正登录失效仍明确告警），只 opener 一次。
 *
 * 不访问浏览器/CDP/网络/真实 Cookie；不启动服务/调度/广告动作；Cookie 值仅 FAKE_VALUE_NOT_REAL。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { Monitor } = require('../src/engine/monitor.js');
const { AuthError } = require('../src/lib/errors.js');
const { makeTempDir, makeCfgResult } = require('./helpers.js');

const TAB_MAIN = '全店托管';
const TAB_SUB = '商品自选';
const SHOP = { id: 'shop-a', name: 'shop-a', cookieFile: 'shop-a', accountId: null, enabled: true };

function buildMonitor({ dataDir, openerFn }) {
  const cfgResult = makeCfgResult({
    shops: [SHOP],
    monitor: {
      chengfang: {
        scope: [TAB_MAIN, TAB_SUB],
        adStateReadTimeoutMs: 400,
        adStateCloseWaitMs: 200,
        adStateSettleWaitMs: 200,
      },
    },
  });
  return new Monitor(cfgResult, null, { dataDir, chengfangOpener: openerFn });
}

function throwingOpener(err) {
  const calls = { opener: 0 };
  return {
    calls,
    opener: async () => {
      calls.opener += 1;
      throw err;
    },
  };
}

test('C1 _readErrorKind：Cookie/身份/登录/超时/重试各按证据分类，通用 auth 不升级', () => {
  const mon = buildMonitor({ dataDir: makeTempDir('awc-c1-'), openerFn: async () => { throw new Error('未使用'); } });
  const cases = [
    // Cookie 文件本身坏 → cookie_invalid（不是登录失效）
    [{ reason: 'Cookie 文件解析失败: Unexpected token' }, 'cookie_invalid'],
    [{ reason: 'Cookie 文件内容不是非空数组（预期 Playwright cookies 格式）' }, 'cookie_invalid'],
    [{ reason: 'Cookie 数组中存在缺少 name/value/domain 的条目' }, 'cookie_invalid'],
    // Cookie 读取受阻 → cookie_blocked（缺文件/路径/同步锁）
    [{ reason: '未找到店铺「shop-a」的 Cookie 文件（已查找: D:/work 与 D:/source）' }, 'cookie_blocked'],
    [{ reason: '另一进程正在同步该店 Cookie 副本（锁龄 3s）：本轮 fail-closed，不导入、不清锁' }, 'cookie_blocked'],
    [{ reason: '工作副本锁创建失败: EACCES' }, 'cookie_blocked'],
    // 身份冲突/未配置 → identity
    [{ reason: '页面店铺身份不匹配：配置「shop-a」，页面实际「shop-b」' }, 'identity'],
    [{ reason: '配置缺少千川账户ID（accountId），无法读取计划状态' }, 'identity'],
    // 正式登录正证据 → auth
    [{ reason: '登录失效：持续登录页，请重新扫码登录' }, 'auth'],
    [{ blocked: 'auth', auth: true, reason: '登录失效：持续命中登录页地址或可见登录控件，请重新扫码登录' }, 'auth'],
    // 通用 auth（无正证据）→ read_failed
    [{ blocked: 'auth', auth: true, reason: '访问被拒绝' }, 'read_failed'],
    [{ reason: '账号会话异常' }, 'read_failed'],
    // 但通用 auth + Cookie 具体原因 → 按 Cookie 分类，不要求扫码
    [{ blocked: 'auth', auth: true, reason: 'Cookie 文件解析失败: x' }, 'cookie_invalid'],
    [{ timeout: true, reason: '回读截止（300000ms）已到' }, 'timeout'],
    [{ retrying: true, reason: '末页已读行数 31 与 total 32 不一致' }, 'retrying'],
  ];
  for (const [err, want] of cases) {
    assert.equal(mon._readErrorKind(err), want, JSON.stringify(err));
  }
});

test('C2 真实 catch：Cookie 文件解析失败 → cookie_invalid，只 opener 一次，原 reason 保留', async () => {
  const reason = 'Cookie 文件解析失败: Unexpected token } in JSON at position 12';
  const fake = throwingOpener(new AuthError(reason));
  const mon = buildMonitor({ dataDir: makeTempDir('awc-c2-'), openerFn: fake.opener });
  const r = await mon._readCurrentAdState(SHOP);
  assert.equal(r.state, 'unknown');
  assert.equal(r.error.blocked, 'cookie_invalid');
  assert.equal(r.error.reason, reason, '原始原因必须原样保留');
  assert.equal(mon._readErrorKind(r.error), 'cookie_invalid');
  assert.equal(fake.calls.opener, 1, 'Cookie 本地故障不得盲试第二次');
});

test('C3 真实 catch：工作副本同步锁 → cookie_blocked，只 opener 一次', async () => {
  const reason = '另一进程正在同步该店 Cookie 副本（锁龄 5s）：本轮 fail-closed，不导入、不清锁';
  const fake = throwingOpener(new AuthError(reason));
  const mon = buildMonitor({ dataDir: makeTempDir('awc-c3-'), openerFn: fake.opener });
  const r = await mon._readCurrentAdState(SHOP);
  assert.equal(r.error.blocked, 'cookie_blocked');
  assert.equal(mon._readErrorKind(r.error), 'cookie_blocked');
  assert.equal(fake.calls.opener, 1);
});

test('C4 真实 catch：身份/账户未配置 → identity，不是 auth', async () => {
  const fake = throwingOpener(new AuthError('配置缺少千川账户ID（accountId），无法读取计划状态'));
  const mon = buildMonitor({ dataDir: makeTempDir('awc-c4-'), openerFn: fake.opener });
  const r = await mon._readCurrentAdState(SHOP);
  assert.equal(r.error.blocked, 'identity');
  assert.equal(mon._readErrorKind(r.error), 'identity');
  assert.notEqual(mon._readErrorKind(r.error), 'auth');
  assert.equal(fake.calls.opener, 1);
});

test('C5 真实 catch：通用 AuthError（无登录正证据）→ read_failed，不冒充登录失效', async () => {
  const fake = throwingOpener(new AuthError('访问被拒绝'));
  const mon = buildMonitor({ dataDir: makeTempDir('awc-c5-'), openerFn: fake.opener });
  const r = await mon._readCurrentAdState(SHOP);
  assert.equal(r.error.blocked, 'read_failed');
  assert.equal(mon._readErrorKind(r.error), 'read_failed');
  assert.equal(r.error.reason, '访问被拒绝');
  assert.equal(fake.calls.opener, 1);
});

test('C6 真实 catch：持续登录页正证据 → auth（真正登录失效仍明确告警），只 opener 一次', async () => {
  const reason = '登录失效：持续命中登录页地址或可见登录控件，请重新扫码登录';
  const fake = throwingOpener(new AuthError(reason));
  const mon = buildMonitor({ dataDir: makeTempDir('awc-c6-'), openerFn: fake.opener });
  const r = await mon._readCurrentAdState(SHOP);
  assert.equal(r.state, 'unknown');
  assert.equal(r.error.blocked, 'auth');
  assert.equal(mon._readErrorKind(r.error), 'auth');
  assert.equal(r.error.reason, reason);
  assert.equal(fake.calls.opener, 1, 'Auth 不得盲试');
});
