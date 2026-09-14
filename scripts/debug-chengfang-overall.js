'use strict';

/** 深度调试：到达 qianchuan /uni-prom/overall 后检查子标签位置（主文档/Shadow DOM/iframe/弹窗）。 */
const { loadConfig } = require('../src/config');
const { openQianchuanHome, closeBrowser } = require('../src/adapters/qianchuan-reader');

const DEEP = `(() => {
  const out = { url: location.href.slice(0, 200), title: document.title };
  const text = document.body ? document.body.innerText : '';
  out.hasZixuan = text.includes('商品自选');
  out.hasTuoguan = text.includes('全店托管');
  out.bodyHead = text.replace(/\\s+/g, ' ').slice(0, 600);
  // Shadow DOM 穿透查找两个标签文本
  const hits = [];
  const walk = (root, depth) => {
    if (depth > 6) return;
    if (root.shadowRoot) walk(root.shadowRoot, depth + 1);
    for (const el of root.querySelectorAll ? root.querySelectorAll('*') : []) {
      const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
      if (own === '商品自选' || own === '全店托管') hits.push({ label: own, tag: el.tagName, cls: String(el.className || '').slice(0, 60), inShadow: depth > 1 });
      if (el.shadowRoot) walk(el.shadowRoot, depth + 1);
    }
  };
  walk(document, 0);
  out.labelHits = hits;
  out.iframeCount = document.querySelectorAll('iframe').length;
  const overlays = [...document.querySelectorAll('[role="dialog"], [class*="modal"], [class*="popup"], [class*="guide"]')].filter((el) => {
    const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
  });
  out.overlays = overlays.slice(0, 5).map((o) => ({ cls: String(o.className || '').slice(0, 60), text: (o.textContent || '').replace(/\\s+/g, ' ').slice(0, 80) }));
  return out;
})()`;

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
        if (el) el.click();
      }).catch(() => {});
      await target.waitForTimeout(12000);
      await target.waitForFunction(() => /uni-prom\/overall/.test(location.href), { timeout: 25000 }).catch(() => {});
      const st = await target.evaluate(DEEP);
      console.log(`attempt=${attempt}`);
      console.log(JSON.stringify(st, null, 2));
      if (/uni-prom\/overall/.test(st.url)) break;
    }
    await target.screenshot({ path: 'evidence/r9-debug-overall.png', timeout: 10000 }).catch(() => {});
    console.log('screenshot: evidence/r9-debug-overall.png');
  } finally {
    await closeBrowser(browser);
  }
}

main().catch((e) => { console.error('调试失败:', e.message); process.exit(1); });
