'use strict';

/**
 * 只读页面探查脚本（第三轮订单接入的页面证据收集，不属于运行时模块）。
 *
 * 流程（用户指明的真实路径）：
 *   抖店主页面 → 点击"成交订单数"文字 → 电商罗盘"经营概况" → 读取该指标下数字。
 *
 * 安全约定：
 * - Cookie 只读加载，绝不打印任何 Cookie/令牌内容；
 * - 只做导航与读取，不在罗盘页面点击任何其他控件、不产生任何写操作；
 * - 证据（JSON/截图）落 evidence/ 目录，供定位建立与人工复核。
 *
 * 用法：node scripts/explore-order.js [cookie文件路径]
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIE_PATH = process.argv[2] || 'C:/Users/Administrator/Documents/电商助手/bill-manager/cookies/瑾漂亮潮流服饰.json';
const OUT_DIR = path.join(__dirname, '..', 'evidence');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const HOME_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const LABEL = '成交订单数';

function ensureOut() { if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true }); }
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

/** 扫描页面上精确等于 label 的文本元素及其容器上下文。 */
async function scanLabel(page, label, max = 10) {
  return page.evaluate(({ label, max }) => {
    const results = [];
    const walker = document.querySelectorAll('body *');
    for (const el of walker) {
      // 只取"最内层"的精确匹配，避免父容器重复
      const own = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => n.textContent.trim())
        .join('');
      if (own !== label) continue;
      const link = el.closest('a');
      const container = el.closest('[class]');
      results.push({
        tag: el.tagName,
        cls: String(el.className || '').slice(0, 120),
        text: own,
        href: link ? link.href : null,
        clickable: !!(link || el.onclick || el.getAttribute('jsaction')),
        box: (() => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })(),
        containerText: container ? container.textContent.replace(/\s+/g, ' ').trim().slice(0, 200) : null,
      });
      if (results.length >= max) break;
    }
    return results;
  }, { label, max });
}

async function main() {
  ensureOut();
  const meta = { startedAt: new Date().toISOString(), cookieFile: path.basename(COOKIE_PATH), steps: [] };
  const browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1920,1080'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
    const cookies = JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf-8'));
    await context.addCookies(cookies);
    const popups = [];
    context.on('page', (p) => popups.push(p));

    const page = await context.newPage();
    meta.steps.push({ step: 'goto-homepage', url: HOME_URL });
    await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(8000);

    const homeUrl = page.url();
    const loggedIn = homeUrl.includes('fxg.jinritemai.com/ffa/mshop/homepage');
    meta.steps.push({ step: 'homepage-loaded', url: homeUrl, loggedIn });
    if (!loggedIn) {
      meta.blocker = '登录失效：抖店主页面未进入登录后地址（Cookie 可能过期），需要重新扫码登录';
      fs.writeFileSync(path.join(OUT_DIR, `explore-${stamp()}.json`), JSON.stringify(meta, null, 2));
      console.log(JSON.stringify(meta, null, 2));
      return;
    }

    // 1) 主页面上的"成交订单数"入口
    const homeCandidates = await scanLabel(page, LABEL);
    meta.homeCandidates = homeCandidates;
    await page.screenshot({ path: path.join(OUT_DIR, 'homepage.png'), fullPage: false });
    if (homeCandidates.length === 0) {
      meta.blocker = '抖店主页面未找到"成交订单数"文字入口（页面结构可能变化或权限不足）';
      fs.writeFileSync(path.join(OUT_DIR, `explore-${stamp()}.json`), JSON.stringify(meta, null, 2));
      console.log(JSON.stringify(meta, null, 2));
      return;
    }

    // 2) 点击入口（优先可点击的），处理新标签页或当前页跳转
    const popupPromise = context.waitForEvent('page', { timeout: 25000 }).catch(() => null);
    const navPromise = page.waitForURL(/compass\.jinritemai\.com/, { timeout: 25000 }).catch(() => null);
    let clickTarget = null;
    try {
      clickTarget = page.getByText(LABEL, { exact: true }).first();
      await clickTarget.click({ timeout: 10000 });
      meta.steps.push({ step: 'clicked', via: 'getByText(exact)' });
    } catch (e) {
      meta.steps.push({ step: 'click-failed', error: String(e.message).slice(0, 200) });
      // 兜底：尝试父级链接
      const linkCand = homeCandidates.find((c) => c.href);
      if (linkCand) {
        await page.goto(linkCand.href, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        meta.steps.push({ step: 'goto-href', href: linkCand.href });
      }
    }
    const popup = await popupPromise;
    await navPromise;
    await page.waitForTimeout(10000);

    let target = popup && !popup.isClosed() ? popup : page;
    for (const p of [popup, page].filter(Boolean)) {
      try { await p.waitForLoadState('domcontentloaded', { timeout: 15000 }); } catch (_) {}
    }
    await target.waitForTimeout(8000);

    // 3) 落点核验：电商罗盘 + 经营概况
    const landedUrl = target.url();
    const isCompass = /compass\.jinritemai\.com/.test(landedUrl);
    const pageTitle = await target.title().catch(() => '');
    const overviewVisible = await target.getByText('经营概况', { exact: false }).first().isVisible().catch(() => false);
    meta.steps.push({ step: 'landed', url: landedUrl, isCompass, pageTitle, overviewVisible, popups: popups.length });
    if (!isCompass) {
      meta.blocker = `点击"成交订单数"后未到达电商罗盘（当前: ${landedUrl}）`;
    }

    // 4) 罗盘页面证据：经营概况、成交订单数及其数值/日期/更新时间/店铺名
    const compass = { url: landedUrl, title: pageTitle };
    compass.overviewCandidates = await scanLabel(target, '经营概况').catch(() => []);
    compass.orderCandidates = await scanLabel(target, LABEL, 20).catch(() => []);
    compass.updateTimeCandidates = await target.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        if (/更新时间|数据更新/.test(own) && own.length <= 60) {
          const r = el.getBoundingClientRect();
          out.push({ tag: el.tagName, text: own, box: { x: Math.round(r.x), y: Math.round(r.y) } });
        }
      }
      return out.slice(0, 10);
    }).catch(() => []);
    // 页面可见的日期/周期指示
    compass.dateHints = await target.evaluate(() => {
      const out = [];
      const re = /(今日|实时|昨天|近7天|近30天|\d{4}-\d{2}-\d{2}|\d{2}\/\d{2})/;
      for (const el of document.querySelectorAll('body *')) {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        if (own && own.length <= 40 && re.test(own)) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.height > 0 && r.y < 400) out.push(own);
        }
      }
      return [...new Set(out)].slice(0, 20);
    }).catch(() => []);
    // 店铺名候选（页面头部）
    compass.shopHints = await target.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('[class*="shop"], [class*="Shop"], header *, [class*="header"] *')) {
        const own = (el.textContent || '').trim();
        if (own && own.length >= 2 && own.length <= 30 && !/^\d/.test(own)) out.push(own);
      }
      return [...new Set(out)].slice(0, 15);
    }).catch(() => []);

    meta.compass = compass;
    await target.screenshot({ path: path.join(OUT_DIR, 'compass.png') }).catch(() => {});
    fs.writeFileSync(path.join(OUT_DIR, `explore-${stamp()}.json`), JSON.stringify(meta, null, 2));
    console.log(JSON.stringify(meta, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error('探查失败:', e.message);
  process.exit(1);
});
