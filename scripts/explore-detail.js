'use strict';

/**
 * 第二轮聚焦探查：采集罗盘页 DOM 结构证据（只读）。
 * 目标：数值元素结构、实时选中态类名、数据时间戳、店铺名元素、全页"成交订单数"分布。
 * 用法：node scripts/explore-detail.js
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const COOKIE_PATH = process.argv[2] || 'C:/Users/Administrator/Documents/电商助手/bill-manager/cookies/瑾漂亮潮流服饰.json';
const OUT_DIR = path.join(__dirname, '..', 'evidence');
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

async function main() {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE, args: ['--window-size=1920,1080'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'Asia/Shanghai' });
    await context.addCookies(JSON.parse(fs.readFileSync(COOKIE_PATH, 'utf-8')));
    const page = await context.newPage();
    await page.goto('https://fxg.jinritemai.com/ffa/mshop/homepage/index', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    // 走用户指明路径：点击主页"成交订单数"
    const popupPromise = context.waitForEvent('page', { timeout: 25000 }).catch(() => null);
    await page.getByText('成交订单数', { exact: true }).first().click({ timeout: 15000 });
    const popup = await popupPromise;
    await page.waitForTimeout(2000);
    const target = popup && !popup.isClosed() ? popup : page;
    await target.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
    await target.waitForTimeout(9000);

    const evidence = { url: target.url(), title: await target.title() };

    // 1) 全页精确"成交订单数"分布（含滚动后懒加载区域）
    await target.mouse.wheel(0, 1200).catch(() => {});
    await target.waitForTimeout(4000);
    await target.mouse.wheel(0, -1200).catch(() => {});
    await target.waitForTimeout(1500);
    evidence.allLabelOccurrences = await target.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        if (own === '成交订单数') {
          const r = el.getBoundingClientRect();
          out.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 80), y: Math.round(r.y), x: Math.round(r.x) });
        }
      }
      return out;
    });

    // 2) 经营概况卡片内"成交订单数"的数值结构：向上找包含"经营概况"的卡片，输出指标行结构
    evidence.orderCard = await target.evaluate(() => {
      // 找精确文本节点
      let labelEl = null;
      for (const el of document.querySelectorAll('body *')) {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        if (own === '成交订单数') { labelEl = el; break; }
      }
      if (!labelEl) return null;
      // 向上找包含"经营概况"文本的祖先容器
      let card = labelEl;
      for (let i = 0; i < 10 && card && card !== document.body; i++) {
        if ((card.textContent || '').includes('经营概况')) break;
        card = card.parentElement;
      }
      // 数值：label 的下一个兄弟（或父级的下一个子元素）中的数字
      const pickValue = (from) => {
        let sib = from.nextElementSibling;
        for (let i = 0; i < 4 && sib; i++) {
          const t = (sib.textContent || '').trim();
          if (/^[\d,.,万]+$/.test(t)) return { via: `nextSibling+${i}`, text: t, tag: sib.tagName, cls: String(sib.className || '').slice(0, 80) };
          sib = sib.nextElementSibling;
        }
        return null;
      };
      const value = pickValue(labelEl) || pickValue(labelEl.parentElement);
      return {
        labelCls: String(labelEl.className || '').slice(0, 80),
        labelParentCls: String(labelEl.parentElement.className || '').slice(0, 80),
        value,
        cardTextHead: card ? (card.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) : null,
        // 指标行兄弟结构（label 父级与其兄弟们）
        siblings: Array.from((labelEl.parentElement.parentElement || document.body).children).slice(0, 8).map((c) => ({
          tag: c.tagName, cls: String(c.className || '').slice(0, 60), text: (c.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        })),
      };
    });

    // 3) "实时"选中态 vs 未选中态 的类名对比
    evidence.scopeTabs = await target.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        if (['实时', '近1天', '近7天'].includes(own)) {
          const r = el.getBoundingClientRect();
          out.push({ text: own, tag: el.tagName, cls: String(el.className || '').slice(0, 100), parentCls: String(el.parentElement.className || '').slice(0, 100), x: Math.round(r.x), y: Math.round(r.y) });
        }
      }
      return out.slice(0, 12);
    });

    // 4) 数据时间戳上下文（如 2026/09/13 09:22:07）
    evidence.timestampHints = await target.evaluate(() => {
      const out = [];
      const re = /\d{4}\/\d{2}\/\d{2}[ ]?\d{0,2}:?\d{0,2}:?\d{0,2}/;
      for (const el of document.querySelectorAll('body *')) {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        if (own && re.test(own) && own.length <= 40) {
          const r = el.getBoundingClientRect();
          out.push({ text: own, tag: el.tagName, cls: String(el.className || '').slice(0, 80), x: Math.round(r.x), y: Math.round(r.y) });
        }
      }
      return out.slice(0, 10);
    });

    // 5) 店铺名出现位置（用于身份核验定位）
    const shopName = '瑾漂亮潮流服饰';
    evidence.shopNameOccurrences = await target.evaluate((name) => {
      const out = [];
      for (const el of document.querySelectorAll('body *')) {
        const own = Array.from(el.childNodes).filter((n) => n.nodeType === Node.TEXT_NODE).map((n) => n.textContent.trim()).join('');
        if (own === name) {
          const r = el.getBoundingClientRect();
          out.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 80), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) });
        }
      }
      return out.slice(0, 10);
    }, shopName);

    const file = path.join(OUT_DIR, `detail-${Date.now()}.json`);
    fs.writeFileSync(file, JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((e) => { console.error('探查失败:', e.message); process.exit(1); });
