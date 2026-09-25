'use strict';

/**
 * 敏感值脱敏隔离测试（2026-09-24）。
 * 覆盖：
 * - src/lib/log.js sanitize 字符串值级兜底（token=/secret=/password= 等，保留业务文案）；
 * - src/lib/log.js scrubDeep 递归脱敏（嵌套对象/数组/Error）；
 * - src/ui/server.js 控制台 HTTP 出站边界（/api/status 等）不泄漏 cookie/token/sessionid。
 * 全部假值；不加载生产配置、不访问外部服务。
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { sanitize, scrubDeep, scrubSensitiveText } = require('../src/lib/log');
const { createUiServer } = require('../src/ui/server');

const FAKE_COOKIE = 'FAKE_COOKIE_VALUE_NOT_REAL';
const FAKE_TOKEN = 'FAKE_TOKEN_XYZ';
const FAKE_SECRET = 'SuperSecret123456';

// ── 1. sanitize：字符串值级兜底 ────────────────────────────────────

test('sanitize：token=/secret=/password= 值级脱敏，保留业务文案', () => {
  const out = sanitize({ error: `登录失败 token=${FAKE_TOKEN}；请重新登录` });
  assert.ok(!out.error.includes(FAKE_TOKEN), 'token 原值不得保留');
  assert.ok(out.error.includes('token=***'), '值替换为 ***，key 保留');
  assert.ok(out.error.includes('登录失败') && out.error.includes('请重新登录'), '业务文案保留');
});

test('sanitize：sessionid= 成对 cookie 形态脱敏', () => {
  const out = sanitize({ error: `lastError sessionid=${FAKE_COOKIE} token=${FAKE_TOKEN}` });
  assert.ok(!out.error.includes(FAKE_COOKIE) && !out.error.includes(FAKE_TOKEN));
  assert.ok(/已脱敏|\*\*\*/.test(out.error), '须带脱敏标记');
});

test('sanitize：中文值/短值不误伤（正常说明文本原样保留）', () => {
  const keep = 'Cookie 过期，请重新登录';
  assert.strictEqual(sanitize({ error: keep }).error, keep, '键后中文说明不吞业务文本');
  // sessionid= 后跟中文（非 ASCII 值）→ 沿用原版整段遮蔽语义（fail-safe）
  const masked = sanitize({ error: '读取失败（sessionid=已失效）' }).error;
  assert.strictEqual(masked, '[疑似凭证，已脱敏]');
  const acct = '广告账户映射不匹配：配置 1710242295996424，页面实际 100761046755。零关闭';
  assert.strictEqual(sanitize({ reason: acct }).reason, acct, '账户 ID 对照文本原样保留');
});

test('sanitize：敏感字段名仍整字段遮蔽（[已脱敏]）', () => {
  const out = sanitize({ token: FAKE_TOKEN, cookie: 'x=1', nested: { sessionid: FAKE_COOKIE } });
  assert.strictEqual(out.token, '[已脱敏]');
  assert.strictEqual(out.cookie, '[已脱敏]');
  assert.strictEqual(out.nested.sessionid, '[已脱敏]');
});

// ── 2. scrubDeep：递归脱敏 ─────────────────────────────────────────

test('scrubDeep：嵌套对象/数组/Error 全量脱敏', () => {
  const out = scrubDeep({
    today: { blockedReason: `sessionid=${FAKE_COOKIE}; token=${FAKE_TOKEN}` },
    rows: [{ lastError: `secret=${FAKE_SECRET}` }],
    err: new Error(`password=${FAKE_SECRET}`),
  });
  const flat = JSON.stringify(out);
  assert.ok(!flat.includes(FAKE_COOKIE) && !flat.includes(FAKE_TOKEN) && !flat.includes(FAKE_SECRET), '原值不得出现');
  assert.ok(flat.includes('***'), '保留 *** 脱敏标记');
  assert.ok(flat.includes('blockedReason'), '字段结构保留');
});

test('scrubDeep：循环引用安全（[circular]），不抛错', () => {
  const a = { note: `token=${FAKE_TOKEN}` };
  a.self = a;
  const out = scrubDeep(a);
  assert.ok(!JSON.stringify(out).includes(FAKE_TOKEN));
  assert.strictEqual(out.self, '[circular]');
});

test('scrubSensitiveText：Bearer 令牌脱敏', () => {
  const out = scrubSensitiveText(`Authorization: Bearer ${FAKE_TOKEN}${FAKE_SECRET}`);
  assert.ok(!out.includes(FAKE_TOKEN), 'Bearer 原值不得保留');
  assert.ok(out.includes('Bearer ***'));
});

// ── 3. 控制台 HTTP 出站边界 ────────────────────────────────────────

test('控制台 /api/status：疑似凭证不出站，业务字段保留', async (t) => {
  const monitor = {
    getStatus: () => ({
      mode: '演练模式', realMode: false,
      shops: [{
        id: 'shop-a', name: '甲店',
        today: { blockedReason: `sessionid=${FAKE_COOKIE}; token=${FAKE_TOKEN}`, costCents: 111 },
        lastError: `token=${FAKE_TOKEN}`,
      }],
      shopRows: [{ id: 'shop-a', lastError: `secret=${FAKE_SECRET}` }],
      recentErrors: [{ scope: 'shop:shop-a', error: `password=${FAKE_SECRET}` }],
    }),
    start: () => ({ ok: true }),
    stop: () => ({ ok: true }),
  };
  const { server } = createUiServer(monitor, 0);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const body = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: '/api/status' }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(buf));
    }).on('error', reject);
  });
  assert.ok(!body.includes(FAKE_COOKIE) && !body.includes(FAKE_TOKEN) && !body.includes(FAKE_SECRET), `原始值不得出站：${body.slice(0, 300)}`);
  assert.ok(body.includes('***'), '须带 *** 脱敏标记');
  assert.ok(body.includes('shop-a') && body.includes('甲店') && body.includes('111'), '业务字段保留');
});

test('控制台 /api/shop/refresh：失败原因中的疑似凭证不出站', async (t) => {
  const monitor = {
    getStatus: () => ({}),
    start: () => ({ ok: true }),
    stop: () => ({ ok: true }),
    async refreshShopData() { return { ok: false, reason: `读取失败 sessionid=${FAKE_COOKIE}` }; },
    updateShop() { return { ok: true }; },
    deleteShop() { return { ok: true }; },
  };
  const { server } = createUiServer(monitor, 0);
  server.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const body = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/api/shop/refresh', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ shopId: 'shop-a' }));
  });
  assert.ok(!body.includes(FAKE_COOKIE), `原值不得出站：${body}`);
  assert.ok(body.includes('***'), '须带 *** 脱敏标记');
  assert.ok(body.includes('读取失败'), '业务文案保留');
});
