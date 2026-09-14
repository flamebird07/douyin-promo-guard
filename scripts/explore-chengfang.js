'use strict';

/**
 * 乘方消耗对象定位调查（第六轮，只读）。
 * 手段：
 *  A. 点击"乘方计划消耗(元)"分项卡片（若可点击→明细/报表入口）；
 *  B. 全量 XHR/响应监听：找含消耗数值、计划对象标识的响应；
 *  C. 顶部导航"乘方/全域投放"子菜单项 dump；
 *  D. 全页搜索"托管/商品推广/全店托管/智能投放"等独立管理入口文本；
 *  E. 落地页 URL 与标题变化留痕。
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIE_PATH = process.argv[2] || 'C:/Users/Administrator/Documents/电商助手/bill-manager/cookies/瑾漂亮潮流服饰.json';
const OUT_DIR = path.join(__dirname, '..', 'evidence');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

async function main() {
  const meta = { startedAt: new Date().toISOString(), steps: [], xhrHits: [], xhrTotal: 0 };
  const browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1920,1080'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
    await context.addCookies(JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf-8')));
    const page = await context.newPage();

    // B. 全量响应监听（千川域）
    const interesting = [];
    page.on('response', async (res) => {
      try {
        const u = res.url();
        if (!/qianchuan|oceanengine|jinritemai/.test(u)) return;
        const ct = res.headers()['content-type'] || '';
        if (!/json/i.test(ct)) return;
        meta.xhrTotal += 1;
        const body = await res.text().catch(() => '');
        if (!body || body.length > 500000) return;
        if (/(乘方|托管|overall|chengfang|"cost"|"stat_time"|plan_id|promotion_id|ad_id)/i.test(u + body.slice(0, 3000))) {
          interesting.push({ url: u.slice(0, 140), status: res.status(), bodyHead: body.replace(/\s+/g, ' ').slice(0, 400) });
        }
      } catch (_) {}
    });

    await page.goto('https://fxg.jinritemai.com/ffa/mshop/homepage/index', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
    const popupPromise = context.waitForEvent('page', { timeout: 25000 }).catch(() => null);
    await page.getByText('巨量千川', { exact: false }).first().click({ timeout: 15000 });
    const popup = await popupPromise;
    await page.waitForTimeout(2000);
    const t = popup && !popup.isClosed() ? popup : page;
    await t.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await t.waitForTimeout(10000);
    meta.steps.push({ step: 'qianchuan-home', url: t.url().slice(0, 130) });

    // 关闭可能的浮层
    try { await t.getByText('我知道了', { exact: true }).first().click({ timeout: 3000 }); } catch (_) {}

    // A. 点击"乘方计划消耗"分项卡片
    const clickedCard = await t.evaluate(() => {
      for (const c of document.querySelectorAll('[class*="summaryCard"]')) {
        const tx = (c.textContent || '').replace(/\s+/g, ' ').trim();
        if (tx.includes('乘方计划消耗')) {
          const cs = getComputedStyle(c);
          const info = { text: tx.slice(0, 60), cursor: cs.cursor, cls: String(c.className || '').slice(0, 60) };
          c.click();
          return { ...info, clicked: true };
        }
      }
      return null;
    }).catch(() => null);
    meta.steps.push({ step: 'click-乘方计划消耗-card', result: clickedCard });
    await t.waitForTimeout(8000);
    meta.steps.push({ step: 'after-card-click', url: t.url().slice(0, 140), title: await t.title().catch(() => '') });
    await t.screenshot({ path: path.join(OUT_DIR, `r6-card-click-${Date.now()}.png`) }).catch(() => {});

    // C. 导航子菜单（hover 乘方/全域投放/品牌投放）
    for (const nav of ['navigatormenu_overall', 'navigatormenu_uni_promotion', 'brand_promotion']) {
      try {
        await t.evaluate((key) => {
          const el = [...document.querySelectorAll('[data-e2e]')].find((e) => (e.getAttribute('data-e2e') || '').includes(key));
          if (el) {
            el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
            el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          }
        }, nav);
        await t.waitForTimeout(1500);
        const sub = await t.evaluate(() => {
          const menus = document.querySelectorAll('[class*="submenu"], [class*="dropdown"], [class*="second-menu"], [class*="navigator"] ul');
          const out = [];
          for (const m of menus) {
            const r = m.getBoundingClientRect();
            if (r.width > 0 && r.height > 0 && r.y < 300) {
              const items = [...m.querySelectorAll('li, a, div')].map((x) => (x.textContent || '').trim()).filter((x) => x && x.length <= 16);
              if (items.length) out.push({ cls: String(m.className || '').slice(0, 60), items: [...new Set(items)].slice(0, 12) });
            }
          }
          return out.slice(0, 5);
        }).catch(() => []);
        if (sub.length) meta.steps.push({ step: `submenu-${nav}`, sub });
      } catch (_) {}
    }

    // D. 全页搜独立管理入口关键词（当前页）
    const keywords = await t.evaluate(() => {
      const body = document.body ? document.body.innerText : '';
      const hits = {};
      for (const kw of ['托管', '商品推广', '全店托管', '智能投放', '自动投放', '投放管理', '计划列表', '乘方直播', '乘方商品', '乘方计划']) {
        const i = body.indexOf(kw);
        if (i >= 0) hits[kw] = body.replace(/\s+/g, ' ').slice(Math.max(0, i - 30), i + 50);
      }
      return hits;
    }).catch(() => ({}));
    meta.keywordHits = keywords;

    meta.xhrHits = interesting.slice(0, 15);
    fs.writeFileSync(path.join(OUT_DIR, `r6-chengfang-${Date.now()}.json`), JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta, null, 2).slice(0, 6000));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error('探查失败:', e.message); process.exit(1); });
