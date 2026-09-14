'use strict';

/** 调试：抖店首页状态（URL/正文片段/是否含巨量千川入口/登录态提示）。 */
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
  console.log(`cookie 文件: ${resolved.path}（条数 ${cookies.length}）`);
  console.log(`cookie 域名: ${[...new Set(cookies.map((c) => c.domain))].join(', ')}`);
  const exp = cookies.map((c) => c.expires).filter((e) => e && e > 0);
  if (exp.length) {
    const max = Math.max(...exp);
    console.log(`最近过期: ${new Date(max * 1000).toISOString()}（距今 ${((max * 1000 - Date.now()) / 60000).toFixed(0)} 分钟）`);
  } else {
    console.log('全部为会话型 cookie（expires<=0）');
  }

  const { chromium } = require('playwright');
  const browser = await chromium.launch({ headless: true, executablePath: loginCfg.edgePath, args: ['--window-size=1920,1080'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
    await context.addCookies(cookies);
    const page = await context.newPage();
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);
    const st = await page.evaluate(() => ({
      url: location.href.slice(0, 200),
      title: document.title,
      bodyHead: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 700),
    }));
    console.log(JSON.stringify(st, null, 2));
    const count = await page.getByText('巨量千川', { exact: false }).count().catch(() => -1);
    console.log(`"巨量千川" 命中元素数: ${count}`);
    await page.screenshot({ path: 'evidence/r9-debug-home.png', timeout: 10000 }).catch(() => {});
    console.log('screenshot: evidence/r9-debug-home.png');
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error('调试失败:', e.message); process.exit(1); });
