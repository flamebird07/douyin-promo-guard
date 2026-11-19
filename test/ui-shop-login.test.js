'use strict';

/**
 * 店铺扫码登录链路隔离测试（2026-11-17，网页内嵌二维码版）。
 * 覆盖（会话工厂全部经 opts.qrSessionFactory 注入假会话，绝不起真实浏览器）：
 * - /api/shop/qr-login/status：空闲 → { phase:'idle', active:false, qrDataUrl:null }；
 * - /api/shop/qr-login：串行单会话（进行中再点 → ok:false）；成功路径透出 shopName；
 *   成功后自动触发 monitor.requestShopDiscovery({force:true}) 并透传 addedShops；
 *   discovery 关闭（scannedDirs 为空）→ discoveryHint 提示；会话抛错 → failed + reason；
 * - 二维码透传：session.qrDataUrl 原样出站（base64 数据不被脱敏破坏）；
 * - /api/shops/rediscover：monitor 缺方法 → ok:false；有方法 → 结果透传；
 * - 控制台页含扫码登录按钮 / Cookie 列 / 二维码弹窗。
 * 全部假值；不加载生产配置、不访问外部服务。
 * 运行：node --test test/ui-shop-login.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('http');
const { createUiServer } = require('../src/ui/server');

const FAKE_QR = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

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

function jobOf(res) { return JSON.parse(res.body).job; }

/** 轮询直到 job.phase 离开 running（最多 ~2s）。 */
async function waitForPhaseDone(port) {
  let job;
  for (let i = 0; i < 100; i++) {
    const r = await httpReq(port, 'GET', '/api/shop/qr-login/status');
    job = jobOf(r);
    if (job.phase !== 'running') return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return job;
}

function fakeSession({ result, error, gate, qrDataUrl } = {}) {
  return {
    qrDataUrl: qrDataUrl || null,
    async start() {
      if (gate) await gate;
      if (error) throw error;
      return result;
    },
    async close() {},
  };
}

test('空闲状态：status → idle；控制台页含扫码按钮/Cookie 列/二维码弹窗', async () => {
  await withServer(makeMonitor(), async (port) => {
    const status = await httpReq(port, 'GET', '/api/shop/qr-login/status');
    const job = jobOf(status);
    assert.strictEqual(job.phase, 'idle');
    assert.strictEqual(job.active, false);
    assert.strictEqual(job.qrDataUrl, null);

    const page = await httpReq(port, 'GET', '/');
    assert.strictEqual(page.status, 200, '无门禁：首页直接 200');
    assert.ok(page.body.includes('btn-qrlogin'), '含扫码登录店铺按钮');
    assert.ok(page.body.includes('btn-rediscover'), '含扫描已有 Cookie 按钮');
    assert.ok(page.body.includes('qr-img'), '含二维码 <img>');
    assert.ok(page.body.includes('>Cookie<'), '含 Cookie 状态列');
    assert.ok(!page.body.includes('admin123'), '不再有界面账号门禁');
  });
});

test('扫码登录成功路径：会话挂起 → 串行拒绝 → 放行 → success + qrDataUrl 透传 + addedShops + force 发现', async () => {
  const discoveryCalls = [];
  let releaseA;
  const gateA = new Promise((resolve) => { releaseA = resolve; });
  const monitor = makeMonitor({
    requestShopDiscovery(opts) {
      discoveryCalls.push(opts);
      return { ok: true, added: ['测试店A'], persisted: true, scannedDirs: ['/fake/cookies'], pending: false, reason: null };
    },
  });
  let created = 0;
  await withServer(monitor, async (port) => {
    // 1) 启动（会话挂起中 → running，二维码字段透传）
    const start = await httpReq(port, 'POST', '/api/shop/qr-login', { body: {} });
    const startBody = JSON.parse(start.body);
    assert.strictEqual(startBody.ok, true);
    assert.strictEqual(startBody.job.phase, 'running');
    assert.strictEqual(startBody.job.active, true);
    assert.strictEqual(startBody.job.qrDataUrl, FAKE_QR, 'session.qrDataUrl 原样出站');

    // 2) 进行中再点 → 串行拒绝
    const second = await httpReq(port, 'POST', '/api/shop/qr-login', { body: {} });
    const secondBody = JSON.parse(second.body);
    assert.strictEqual(secondBody.ok, false);
    assert.ok(secondBody.reason.includes('进行中'), '拒绝原因须说明已有会话');

    // 3) 放行会话 → success + shopName + addedShops
    releaseA();
    const job = await waitForPhaseDone(port);
    assert.strictEqual(job.phase, 'success');
    assert.strictEqual(job.shopName, '测试店A');
    assert.deepStrictEqual(job.addedShops, ['测试店A']);
    assert.strictEqual(job.active, false);
    assert.strictEqual(created, 1, '串行会话只创建一个 session');
    assert.strictEqual(discoveryCalls.length, 1);
    assert.strictEqual(discoveryCalls[0] && discoveryCalls[0].force, true, '发现必须 force（绕过 2s 节流）');
  }, {
    qrSessionFactory: (loginCfg) => {
      created += 1;
      assert.strictEqual(typeof loginCfg, 'object', '工厂收到 login 配置段');
      return fakeSession({ gate: gateA, result: { shopName: '测试店A', cookiePath: '/fake/测试店A.json' }, qrDataUrl: FAKE_QR });
    },
  });
});

test('扫码登录失败路径：会话抛错 → phase=failed + reason 透出', async () => {
  const monitor = makeMonitor({
    requestShopDiscovery() { return { ok: true, added: [], persisted: true, scannedDirs: ['/x'] }; },
  });
  await withServer(monitor, async (port) => {
    const start = await httpReq(port, 'POST', '/api/shop/qr-login', { body: {} });
    assert.strictEqual(JSON.parse(start.body).ok, true);
    const job = await waitForPhaseDone(port);
    assert.strictEqual(job.phase, 'failed');
    assert.ok(job.reason.includes('未找到扫码登录二维码'), `失败原因须透出：${job.reason}`);
    assert.strictEqual(job.active, false);
  }, {
    qrSessionFactory: () => fakeSession({ error: new Error('未找到扫码登录二维码（假错误）') }),
  });
});

test('发现关闭提示：scannedDirs 为空 → success 但带 discoveryHint', async () => {
  const monitor = makeMonitor({
    requestShopDiscovery() { return { ok: true, added: [], persisted: true, scannedDirs: [], pending: false, reason: null }; },
  });
  await withServer(monitor, async (port) => {
    await httpReq(port, 'POST', '/api/shop/qr-login', { body: {} });
    const job = await waitForPhaseDone(port);
    assert.strictEqual(job.phase, 'success');
    assert.ok(job.discoveryHint.includes('未扫描任何 Cookie 目录'), `须提示发现关闭：${job.discoveryHint}`);
    assert.deepStrictEqual(job.addedShops, []);
  }, { qrSessionFactory: () => fakeSession({ result: { shopName: '测试店C' } }) });
});

test('/api/shops/rediscover：monitor 缺方法 → ok:false；有方法 → 透传 force 发现结果', async () => {
  await withServer(makeMonitor(), async (port) => {
    const r1 = await httpReq(port, 'POST', '/api/shops/rediscover', { body: {} });
    const b1 = JSON.parse(r1.body);
    assert.strictEqual(b1.ok, false);
    assert.ok(b1.reason.includes('不支持'), '缺方法须如实报不支持');
  });

  const calls = [];
  const monitor = makeMonitor({
    requestShopDiscovery(opts) {
      calls.push(opts);
      return { ok: true, added: ['店D1', '店D2'], persisted: true, scannedDirs: ['/fake'], pending: false, reason: null };
    },
  });
  await withServer(monitor, async (port) => {
    const r = await httpReq(port, 'POST', '/api/shops/rediscover', { body: {} });
    const b = JSON.parse(r.body);
    assert.strictEqual(b.ok, true);
    assert.deepStrictEqual(b.added, ['店D1', '店D2']);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0] && calls[0].force, true);
  });
});
