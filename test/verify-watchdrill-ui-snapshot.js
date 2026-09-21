'use strict';
// 视觉验证：打开 3443 控制台，切到「推广值守」tab，截图（改版前后各一张对比用）。
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto('https://localhost:3443/', { waitUntil: 'domcontentloaded' });

  // 切到推广值守 tab
  await page.click('button.tab-btn:has-text("推广值守")');
  await page.waitForTimeout(1500); // 等 /state /logs 接口渲染

  const tab = page.locator('#tab-watchdrill');
  await tab.screenshot({ path: path.join(__dirname, 'wd-after.png'), timeout: 15000 });

  // 展开折叠的门槛明细，确认内容仍在
  const summary = page.locator('#tab-watchdrill details summary');
  if (await summary.count()) {
    await summary.click();
    await page.waitForTimeout(300);
    await tab.screenshot({ path: path.join(__dirname, 'wd-after-details-open.png'), timeout: 15000 });
  }
  await browser.close();
  console.log('OK screenshots saved');
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
