'use strict';

/** 深度探查：乘方行内开关的完整 DOM（属性/结构/aria/计算样式），判定 checked 语义。只读，不点击。 */
const { loadConfig } = require('../src/config');
const { openChengfangShop, closeBrowser } = require('../src/adapters/chengfang-reader');

const PROBE = `(() => {
  const out = [];
  const trs = [...document.querySelectorAll('tr.ovui-tr')].filter((tr) => {
    if (String(tr.className || '').includes('ovui-t-summary')) return false;
    return tr.querySelector('th') ? false : true;
  }).slice(0, 3);
  for (const tr of trs) {
    const rowText = (tr.textContent || '').replace(/\\s+/g, ' ').trim();
    const idM = rowText.match(/ID[:：]\\s*(\\d{12,20})/);
    const sw = tr.querySelector('.oc-switch, .ovui-switch[data-e2e="switch"], .ovui-switch');
    const info = {
      id: idM ? idM[1] : null,
      statusEl: (tr.querySelector('.ad-status, [class*="ad-status"]') || {}).textContent ? (tr.querySelector('.ad-status, [class*="ad-status"]').textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40) : null,
      switchFound: !!sw,
      switchTag: sw ? sw.tagName : null,
      switchCls: sw ? String(sw.className) : null,
      switchHtml: sw ? sw.outerHTML.replace(/\\s+/g, ' ').slice(0, 400) : null,
      ariaChecked: sw ? (sw.getAttribute('aria-checked') || (sw.querySelector && sw.querySelector('[aria-checked]') ? sw.querySelector('[aria-checked]').getAttribute('aria-checked') : null)) : null,
      innerCheckedCls: sw ? !!sw.querySelector('.ovui-switch--checked, .oc-switch--checked') : null,
      innerOnCls: sw ? [...sw.querySelectorAll('*')].map((e) => String(e.className || '')).filter((c) => /(on|checked|active)/i.test(c)).slice(0, 6) : [],
      role: sw ? sw.getAttribute('role') : null,
      disabled: sw ? (sw.getAttribute('aria-disabled') || (sw.className.includes('disabled') ? 'cls-disabled' : null)) : null,
    };
    out.push(info);
  }
  return out;
})()`;

async function main() {
  const cfg = loadConfig();
  const loginCfg = cfg.config.login;
  const shopCfg = (cfg.config.shops || []).find((s) => s.enabled !== false);
  const { browser, target } = await openChengfangShop({ loginCfg, shopCfg });
  try {
    await target.waitForTimeout(3000);
    const tuoguan = await target.evaluate(PROBE);
    console.log('全店托管视图开关:', JSON.stringify(tuoguan, null, 2));
    await target.evaluate(() => {
      const els = [...document.querySelectorAll('body *')].filter((el) => {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        return own === '商品自选' && el.getBoundingClientRect().width > 0;
      });
      for (const el of els) {
        let cur = el;
        for (let i = 0; i < 6 && cur; i++) {
          const cls = String(cur.className || '');
          if (/tab|Tab/.test(cls) || (cur.getAttribute && cur.getAttribute('role') === 'tab')) { cur.click(); break; }
          cur = cur.parentElement;
        }
      }
    });
    await target.waitForTimeout(6000);
    const zixuan = await target.evaluate(PROBE);
    console.log('商品自选视图开关:', JSON.stringify(zixuan, null, 2));
  } finally {
    await closeBrowser(browser);
  }
}

main().catch((e) => { console.error('探查失败:', e.reason || e.message); process.exit(1); });
