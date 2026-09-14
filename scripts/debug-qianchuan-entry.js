'use strict';

/** 调试：点击"千川推广"入口，确认是否到达 qianchuan.jinritemai.com。 */
const fs = require('fs');
const { loadConfig } = require('../src/config');
const { resolveCookieFile } = require('../src/login/session');

const HOME_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';

async function main() {
  const cfg = loadConfig();
  const loginCfg = cfg.config.login;
  const shopCfg = (cfg.config.shops || []).find((s) => s.enabled !== false);
  const resolved = resolveCookieFile(loginCfg, shopCfg.cookieFile);
  const cookies = JSON.parse(fs.readFileSync(resolved.path, 'utf-8'));
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: loginCfg.edgePath, args: ['--window-size=1920,1080'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    const qc1 = await page.getByText('巨量千川', { exact: false }).count().catch(() => -1);
    const qc2 = await page.getByText('千川推广', { exact: false }).count().catch(() => -1);
    console.log(`巨量千川=${qc1} 千川推广=${qc2}`);
    const popupPromise = context.waitForEvent('page', { timeout: 25000 }).catch(() => null);
    const entry = page.getByText('千川推广', { exact: false }).first();
    await entry.click({ timeout: 15000 });
    const popup = await popupPromise;
    await page.waitForTimeout(3000);
    const target = popup && !popup.isClosed() ? popup : page;
    await target.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await target.waitForTimeout(6000);
    console.log('落地 URL:', target.url().slice(0, 200));
    console.log('标题:', await target.title().catch(() => null));
    const st = await target.evaluate(() => ({
      bodyHead: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 400),
    }));
    console.log('正文:', st.bodyHead);
    await target.screenshot({ path: 'evidence/r9-debug-qianchuan-home.png', timeout: 10000 }).catch(() => {});
    console.log('screenshot: evidence/r9-debug-qianchuan-home.png');
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error('调试失败:', e.message); process.exit(1); });
