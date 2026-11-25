'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { ensureQianchuanAccountView } = require('../src/adapters/qianchuan-reader');

test('shop-data guide requires a single known tip, matching shop and confirmed dismissal', async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const scenario of ['normal', 'second-dialog', 'foreign-shop', 'persistent']) {
    const page = await browser.newPage();
    await page.route('https://qianchuan.jinritemai.com/home', route => route.fulfill({
      contentType: 'text/html; charset=utf-8', body: `<span>店铺视图：测试店</span><button>切至账户视图</button>
      <div tabindex="0" role="dialog" class="shepherd-element shepherd-firefly-custom" data-shepherd-step-id="shop-prom-data"
        aria-describedby="shop-prom-data-description"><div class="shepherd-content"><div id="shop-prom-data-description"><firefly-react-content>引导</firefly-react-content></div></div></div>`,
    }));
    await page.goto('https://qianchuan.jinritemai.com/home');
    await page.evaluate(scenario => {
      window.escapes = window.switches = 0;
      const guide = document.querySelector('[role=dialog]');
      if (scenario === 'second-dialog') document.body.append(guide.cloneNode(true));
      guide.onkeydown = e => {
        if (e.key === 'Escape') {
          window.escapes++;
          if (scenario !== 'persistent') guide.remove();
        }
      };
      document.querySelector('button').onclick = () => {
        window.switches++;
        document.body.innerHTML = '<div class="summaryCard">账户整体消耗</div>';
      };
    }, scenario);
    const run = ensureQianchuanAccountView(page, { name: scenario === 'foreign-shop' ? '其他店' : '测试店' },
      { readinessTimeoutMs: 1500, readinessIntervalMs: 30 });
    if (scenario === 'normal') assert.equal((await run).switched, true);
    else await assert.rejects(run);
    assert.deepEqual(await page.evaluate(() => [window.escapes, window.switches]),
      [Number(['normal', 'persistent'].includes(scenario)), Number(scenario === 'normal')]);
    await page.close();
  }
});
