'use strict';

/**
 * 千川入口只读探查（第四轮费用接入的页面证据收集）。
 * 路径：抖店首页顶部"巨量千川"入口 → 点击 → 落地页（处理新标签页/跳转/登录）→
 *       查找"账户整体消耗"及其日期筛选、账户信息。
 * 只读：仅导航与点击入口，不修改任何投放设置。
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIE_PATH = process.argv[2] || 'C:/Users/Administrator/Documents/电商助手/bill-manager/cookies/瑾漂亮潮流服饰.json';
const OUT_DIR = path.join(__dirname, '..', 'evidence');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

async function main() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const meta = { startedAt: new Date().toISOString(), steps: [] };
  const browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1920,1080'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
    await context.addCookies(JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf-8')));
    const page = await context.newPage();
    await page.goto('https://fxg.jinritemai.com/ffa/mshop/homepage/index', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    meta.steps.push({ step: 'homepage', url: page.url(), loggedIn: page.url().includes('/ffa/mshop/homepage') });

    // 1) 首页"巨量千川"入口候选
    const candidates = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        if (own.includes('巨量千川') && own.length <= 30) {
          const link = el.closest('a');
          const r = el.getBoundingClientRect();
          out.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 80), text: own, href: link ? link.href : null, x: Math.round(r.x), y: Math.round(r.y) });
        }
      }
      return out.slice(0, 10);
    });
    meta.homeCandidates = candidates;
    if (!candidates.length) {
      meta.blocker = '抖店首页未找到"巨量千川"入口文本';
      fs.writeFileSync(path.join(OUT_DIR, `qianchuan-${Date.now()}.json`), JSON.stringify(meta, null, 2));
      console.log(JSON.stringify(meta, null, 2));
      return;
    }

    // 2) 点击入口（优先有 href 的），处理新标签页/跳转
    const popupPromise = context.waitForEvent('page', { timeout: 25000 }).catch(() => null);
    let clicked = false;
    try {
      await page.getByText('巨量千川', { exact: false }).first().click({ timeout: 10000 });
      clicked = true;
    } catch (e) {
      meta.steps.push({ step: 'click-failed', error: String(e.message).slice(0, 150) });
      const withHref = candidates.find((c) => c.href);
      if (withHref) {
        await page.goto(withHref.href, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        clicked = true;
      }
    }
    meta.steps.push({ step: 'clicked', clicked });
    const popup = await popupPromise;
    await page.waitForTimeout(3000);
    let target = popup && !popup.isClosed() ? popup : page;
    await target.waitForLoadState('domcontentloaded', { timeout: 30000 }).catch(() => {});
    await target.waitForTimeout(10000);

    // 3) 落地核验
    const landedUrl = target.url();
    const title = await target.title().catch(() => '');
    const bodyHead = await target.evaluate(() => (document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 300) : '')).catch(() => '');
    meta.landing = { url: landedUrl, title, bodyHead, popups: popup ? 1 : 0, sameTab: target === page };
    await target.screenshot({ path: path.join(OUT_DIR, 'qianchuan-landing.png') }).catch(() => {});

    // 4) 查找"账户整体消耗"
    const consume = await target.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        if (own.includes('账户整体消耗') && own.length <= 40) {
          const r = el.getBoundingClientRect();
          // 容器文本（含数值）
          let a = el;
          for (let k = 0; k < 8 && a; k++) {
            const tx = (a.textContent || '').replace(/\s+/g, ' ').trim();
            if (/[\d]/.test(tx) && tx.length > own.length) {
              out.push({ label: own, containerCls: String(a.className || '').slice(0, 80), containerText: tx.slice(0, 160) });
              break;
            }
            a = a.parentElement;
          }
          if (!out.length || out[out.length - 1].label !== own) {
            out.push({ label: own, containerCls: null, containerText: null });
          }
        }
      }
      return out.slice(0, 10);
    }).catch(() => []);
    meta.consumeCandidates = consume;

    // 5) 日期筛选与账户信息线索
    const hints = await target.evaluate(() => {
      const out = { dateTabs: [], accountHints: [], tsCandidates: [] };
      for (const el of document.querySelectorAll('body *')) {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        if (!own) continue;
        const r = el.getBoundingClientRect();
        if (['今日', '昨天', '近7天', '近30天'].includes(own)) {
          let a = el, active = false, isTab = false;
          for (let k = 0; k < 6 && a; k++) {
            const cls = String(a.className || '');
            if (cls.includes('active') || cls.includes('selected') || cls.includes('checked')) active = true;
            if (cls.includes('tab') || cls.includes('item') || cls.includes('radio')) isTab = true;
            a = a.parentElement;
          }
          if (r.width > 0 && r.y < 400) out.dateTabs.push({ text: own, active, isTab, x: Math.round(r.x), y: Math.round(r.y) });
        }
        if (/账户|账号/.test(own) && own.length <= 40 && r.width > 0) out.accountHints.push(own);
        if (/^\d{4}-\d{2}-\d{2}/.test(own) || /^\d{4}\/\d{2}\/\d{2}/.test(own)) out.tsCandidates.push({ text: own.slice(0, 40), y: Math.round(r.y) });
      }
      out.dateTabs = out.dateTabs.slice(0, 12);
      out.accountHints = [...new Set(out.accountHints)].slice(0, 15);
      out.tsCandidates = out.tsCandidates.slice(0, 8);
      return out;
    }).catch(() => ({}));
    meta.hints = hints;
    await target.screenshot({ path: path.join(OUT_DIR, `qianchuan-page-${Date.now()}.png`) }).catch(() => {});

    fs.writeFileSync(path.join(OUT_DIR, `qianchuan-${Date.now()}.json`), JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error('探查失败:', e.message); process.exit(1); });
