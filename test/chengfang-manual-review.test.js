'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isMissingChengfangControl,
  hasChengfangManualReview,
  retainChengfangPageForManualReview,
  watchChengfangControlsForManualReview,
  openChengfangShop,
} = require('../src/adapters/chengfang-reader');
const { DataGuardError } = require('../src/lib/errors');

function fixture(shopId) {
  const events = {};
  let closed = false;
  let launches = 0;
  const page = {
    on(name, cb) { events[`page:${name}`] = cb; },
    isClosed() { return closed; },
    async goto(url) { assert.equal(url, 'https://qianchuan.jinritemai.com/overall-prom'); },
    async bringToFront() {},
  };
  const browser = {
    on(name, cb) { events[`browser:${name}`] = cb; },
    async newContext(opts) {
      assert.deepEqual(opts.storageState.cookies, []);
      return { async newPage() { return page; } };
    },
    async close() { closed = true; if (events['browser:disconnected']) events['browser:disconnected'](); },
  };
  return {
    shopCfg: { id: shopId },
    loginCfg: {},
    context: { async storageState() { return { cookies: [] }; } },
    target: { url() { return 'https://qianchuan.jinritemai.com/overall-prom'; } },
    reviewBrowserFactory: async () => { launches += 1; return browser; },
    get launches() { return launches; },
    async close() { await browser.close(); },
  };
}

test('找不到控件才进入人工检查；费用/身份异常不打开窗口', () => {
  assert.equal(isMissingChengfangControl(new DataGuardError('批量操作栏内未找到"暂停"按钮')), true);
  assert.equal(isMissingChengfangControl(new DataGuardError('乘方页未找到"商品自选/全店托管"子标签')), true);
  assert.equal(isMissingChengfangControl(new DataGuardError('账户身份不匹配')), false);
  assert.equal(isMissingChengfangControl(new DataGuardError('费用读取失败')), false);
});

test('同店最多保留一个可见检查窗口；关闭后才允许下一轮', async () => {
  const f = fixture('manual-review-shop-a');
  try {
    const first = await retainChengfangPageForManualReview({ ...f, browserFactory: f.reviewBrowserFactory });
    const second = await retainChengfangPageForManualReview({ ...f, browserFactory: f.reviewBrowserFactory });
    assert.equal(first.held, true);
    assert.equal(second.reused, true);
    assert.equal(f.launches, 1);
    assert.equal(hasChengfangManualReview(f.shopCfg), true);
    await assert.rejects(openChengfangShop({ shopCfg: f.shopCfg, loginCfg: {} }), /等待人工检查/);
  } finally { await f.close(); }
  assert.equal(hasChengfangManualReview(f.shopCfg), false);
});

test('控制器定位失败保留人工页面并继续抛错，零业务点击', async () => {
  const f = fixture('manual-review-shop-b');
  let clicks = 0;
  const controller = watchChengfangControlsForManualReview({
    async clickBatchPause() { throw new DataGuardError('批量操作栏内未找到"暂停"按钮'); },
    async clickBatchEnable() { clicks += 1; },
  }, f);
  try {
    await assert.rejects(controller.clickBatchPause(), /已保留可见千川页面供人工检查/);
    assert.equal(f.launches, 1);
    assert.equal(clicks, 0);
    assert.equal(hasChengfangManualReview(f.shopCfg), true);
  } finally { await f.close(); }
});
