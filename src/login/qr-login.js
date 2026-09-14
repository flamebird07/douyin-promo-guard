'use strict';

/**
 * 扫码登录（人工参与，交互式脚本）。
 *
 * 复用电商助手 bill-manager/login-shop.js 的已验证逻辑：
 * Edge + Playwright 打开抖店首页 -> 等待抖音 App 扫码（URL 变为 /ffa/mshop/homepage）->
 * 保存 context.cookies()。区别：Cookie 保存到【本项目】cookies/ 目录，
 * 不写入电商助手；登录成功后打印 SHOP_NAME 供界面录入配置。
 *
 * 运行：node src/index.js login
 * 注意：需要人工扫码；已登录的浏览器会直接复用其登录态导出 Cookie。
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const log = require('../lib/log');

const PROJECT_COOKIES_DIR = path.join(__dirname, '..', 'cookies');
const LOGIN_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const LOGGED_IN_URL_PART = 'fxg.jinritemai.com/ffa/mshop/homepage';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** 从抖店首页右上角提取店铺名（与 login-shop.js 相同的启发式，仅作为文件名建议）。 */
async function detectShopName(page) {
  return page.evaluate(() => {
    const excludeKeywords = ['退出', '登录', '消息', '首页', '近7天', '近30天', '近90天',
      '筛选', '导出', '下载', '刷新', '搜索', '设置', '帮助', '反馈',
      '大促', '活动', '优惠', '促销', '折扣', '满减', '券',
      '待发货', '待付款', '已完成', '已取消', '退款',
      '订单', '商品', '客服', '财务', '营销', '直播', '短视频', '达人', '联盟', '数据中心'];
    for (const el of document.querySelectorAll('*')) {
      const text = el.innerText && el.innerText.trim();
      const rect = el.getBoundingClientRect();
      if (text && text.length >= 2 && text.length <= 20 &&
          rect.left > 1200 && rect.top > 100 && rect.top < 250 &&
          rect.width > 50 && rect.height > 20 && rect.height < 60) {
        if (!excludeKeywords.some((kw) => text.includes(kw))) {
          return text.split('\n')[0].trim();
        }
      }
    }
    return '';
  });
}

async function runQrLogin(loginCfg) {
  if (!fs.existsSync(PROJECT_COOKIES_DIR)) fs.mkdirSync(PROJECT_COOKIES_DIR, { recursive: true });
  log.info('启动 Edge 浏览器，准备扫码登录（Cookie 将保存到本项目 cookies/）');
  const browser = await chromium.launch({
    headless: false,
    executablePath: loginCfg.edgePath,
    args: ['--start-maximized', '--window-size=1920,1080'],
  });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  try {
    log.info('访问抖店登录页...');
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await sleep(5000);

    let loggedIn = await page.evaluate((part) => window.location.href.includes(part), LOGGED_IN_URL_PART);
    if (!loggedIn) {
      log.info('请使用抖音 App 扫码登录（10 分钟超时）...');
      await page.waitForFunction(
        (part) => window.location.href.includes(part),
        LOGGED_IN_URL_PART,
        { timeout: 600000 }
      );
      log.info('登录成功');
    } else {
      log.info('已检测到登录状态');
    }
    await sleep(5000);

    const shopName = (await detectShopName(page)) || '未知店铺';
    const safeName = shopName.replace(/[\\/:*?"<>|]/g, '_');
    const cookiePath = path.join(PROJECT_COOKIES_DIR, `${safeName}.json`);
    const cookies = await context.cookies();
    // 只输出元信息，不输出 Cookie 内容
    log.info(`店铺名称: ${shopName}，Cookie 条数: ${cookies.length}`);
    fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
    log.info(`SHOP_NAME:${safeName}`);
    log.info(`Cookie 已保存: ${cookiePath}`);
    return { shopName: safeName, cookiePath };
  } finally {
    await browser.close().catch(() => {});
  }
}

module.exports = { runQrLogin };
