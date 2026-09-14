'use strict';

/** 调试：到达乘方管理页后输出实际页面状态（URL/标题/正文片段/子标签检测）。 */
const { loadConfig } = require('../src/config');
const { openQianchuanHome, closeBrowser } = require('../src/adapters/qianchuan-reader');

async function main() {
  const cfg = loadConfig();
  const loginCfg = cfg.config.login;
  const shopCfg = (cfg.config.shops || []).find((s) => s.enabled !== false);
  const { browser, target } = await openQianchuanHome(loginCfg, shopCfg, {});
  try {
    await target.waitForTimeout(2000);
    try { await target.getByText('我知道了', { exact: true }).first().click({ timeout: 3000 }); } catch (_) {}
    for (let attempt = 0; attempt < 2; attempt++) {
      await target.evaluate(() => {
        const el = [...document.querySelectorAll('[data-e2e]')].find((e) => /navigatormenu_overall/.test(e.getAttribute('data-e2e') || ''));
        if (el) { el.click(); return el.getAttribute('data-e2e'); }
        return null;
      });
      await target.waitForTimeout(10000);
      const st = await target.evaluate(() => ({
        url: location.href.slice(0, 200),
        title: document.title,
        bodyHead: (document.body ? document.body.innerText : '').replace(/\s+/g, ' ').slice(0, 900),
        hasZixuan: (document.body ? document.body.innerText : '').includes('商品自选'),
        hasTuoguan: (document.body ? document.body.innerText : '').includes('全店托管'),
      }));
      console.log(`attempt=${attempt}`);
      console.log(JSON.stringify(st, null, 2));
      if (/uni-prom\/overall/.test(st.url)) break;
    }
    await target.screenshot({ path: 'evidence/r9-debug-landing.png', timeout: 10000 }).catch(() => {});
    console.log('screenshot saved: evidence/r9-debug-landing.png');
  } finally {
    await closeBrowser(browser);
  }
}

main().catch((e) => { console.error('调试失败:', e.message); process.exit(1); });
