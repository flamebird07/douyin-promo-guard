'use strict';
// DOM 验证：改版后推广值守 tab 的可见内容断言。
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'node_modules', 'playwright'));

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'chromium' });
  const page = await browser.newPage({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  await page.goto('https://localhost:3443/', { waitUntil: 'domcontentloaded' });
  await page.click('button.tab-btn:has-text("推广值守")');
  await page.waitForTimeout(1500);

  const r = await page.evaluate(() => {
    const tab = document.getElementById('tab-watchdrill');
    const vis = (el) => !!el && el.offsetParent !== null;
    const details = tab.querySelector('details');
    return {
      gridCells: tab.querySelectorAll('.wd-cell').length,
      hintGone: !document.getElementById('wdToggleHint'),
      phaseGone: !document.getElementById('wdPhase'),
      gatesInDetails: !!(details && details.querySelector('#wdGates')),
      detailsCollapsed: !!(details && !details.open),
      shop: document.getElementById('wdShopName').textContent,
      status: document.getElementById('wdStatusBadge').textContent,
      modeBadge: document.getElementById('wdModeBadge').textContent,
      enableLine: (document.querySelector('#tab-watchdrill .form-row + div + div') || {}).textContent || '',
      enableTaskText: document.getElementById('wdEnableTaskState').textContent,
      enableTodayText: document.getElementById('wdEnableToday').textContent,
      cost: document.getElementById('wdCost').textContent,
      conclusion: document.getElementById('wdConclusion').textContent,
      visibleText: tab.innerText.slice(0, 900),
    };
  });
  console.log(JSON.stringify(r, null, 2));

  const checks = [
    ['6 个指标格', r.gridCells === 6],
    ['提示语已删', r.hintGone],
    ['相位格已删', r.phaseGone],
    ['门槛明细在折叠区内', r.gatesInDetails],
    ['折叠区默认收起', r.detailsCollapsed],
  ];
  let bad = 0;
  for (const [name, ok] of checks) { console.log((ok ? 'PASS' : 'FAIL') + ' ' + name); if (!ok) bad++; }
  await browser.close();
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
