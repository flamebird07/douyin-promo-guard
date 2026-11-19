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
const { launchExecutableOption } = require('./browser-launch'); // MAC-1：edgePath 可选解析

// 项目根 cookies/（2026-11-19 修正：原先误指 src/cookies/，自动发现扫描的是根目录，
// 导致 CLI/网页扫码登录的 Cookie 永远不会被店铺发现机制看到）。
const PROJECT_COOKIES_DIR = path.join(__dirname, '..', '..', 'cookies');
const LOGIN_URL = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';
const LOGGED_IN_URL_PART = 'fxg.jinritemai.com/ffa/mshop/homepage';

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 从抖店首页提取店铺名（仅作为 Cookie 文件名/店铺标识建议）。
 * 2026-11-19 修正：旧启发式按"右上角矩形区域"抓文本，实测抓到「添加小二」按钮。
 * 新逻辑优先取右上角账户区稳定类名（css-modules 前缀，哈希后缀不固定）：
 *  - [class*="userName"]（实测 index_userName__16Isl，登录后头像旁即店铺名）；
 *  - [class*="shopName"]（首页店铺卡片，实测 shopName-NWhKZd）；
 *  两者都失败再回退旧启发式。取元素**直接文本**（不取 innerText，避免抓到子按钮文字）。
 */
async function detectShopName(page) {
  const fromSelector = await page.evaluate(() => {
    const directText = (el) => {
      if (!el) return '';
      return Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => (n.textContent || '').trim())
        .join('')
        .trim();
    };
    for (const sel of ['[class*="userName"]', '[class*="shopName"]']) {
      for (const el of document.querySelectorAll(sel)) {
        const t = directText(el);
        if (t && t.length >= 2 && t.length <= 30) return t;
      }
    }
    return '';
  });
  if (fromSelector) return fromSelector;
  return page.evaluate(() => {
    const excludeKeywords = ['退出', '登录', '消息', '首页', '近7天', '近30天', '近90天',
      '筛选', '导出', '下载', '刷新', '搜索', '设置', '帮助', '反馈',
      '大促', '活动', '优惠', '促销', '折扣', '满减', '券',
      '待发货', '待付款', '已完成', '已取消', '退款', '添加小二', '小二', '子账号',
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
  log.info('启动浏览器，准备扫码登录（Cookie 将保存到本项目 cookies/）');
  const browser = await chromium.launch({
    headless: false,
    ...launchExecutableOption(loginCfg),
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

/**
 * 网页内嵌扫码会话（2026-11-17）：供控制台 UI 直接展示抖店登录二维码。
 *
 * 无头打开抖店登录页（不弹窗）→ 点击卡片右上角切换图标进入「扫码登录」视图 →
 * 每 1.5s 截取登录卡片内的二维码（页面二维码过期会自动换新，截屏保持网页显示最新码；
 * 排除页面底部 136px 的 App 下载码：卡片码 140–320px 且 y<600）→ 等待扫码登录成功
 * （URL 进入 /ffa/mshop/homepage，10 分钟超时）→ 检测店铺名 + 保存 Cookie
 * （与 runQrLogin 同目录同命名，随后由调用方触发 Cookie 自动发现建店）。
 * 用法：const s = new WebQrLoginSession(loginCfg); const r = await s.start(); await s.close();
 * 期间 s.qrDataUrl 持续更新为最新二维码 dataURL，供网页 <img> 展示。
 */
class WebQrLoginSession {
  constructor(loginCfg) {
    this.loginCfg = loginCfg || {};
    this.qrDataUrl = null;
    this.stopped = false;
    this.browser = null;
    this._qrLoopPromise = null;
  }

  /** 阻塞直到扫码登录成功并保存 Cookie；返回 { shopName, cookiePath }（失败抛错）。 */
  async start() {
    if (!fs.existsSync(PROJECT_COOKIES_DIR)) fs.mkdirSync(PROJECT_COOKIES_DIR, { recursive: true });
    log.info('启动无头浏览器获取抖店登录二维码（网页内嵌展示）');
    this.browser = await chromium.launch({
      headless: true,
      ...launchExecutableOption(this.loginCfg),
    });
    this.context = await this.browser.newContext({ viewport: { width: 1440, height: 900 } });
    this.page = await this.context.newPage();
    try {
      await this.page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 120000 });
      await sleep(5000);
      const loggedIn = this.page.url().includes(LOGGED_IN_URL_PART);
      if (!loggedIn) {
        await this._switchToQrView();
        this._qrLoopPromise = this._maintainQrLoop();
        log.info('等待抖店App扫码登录（10 分钟超时；二维码过期自动刷新）...');
        // 用 URL 轮询判登录（不用 waitForFunction：过期刷新会 reload 页面，轮询对其稳健）
        const deadline = Date.now() + 600000;
        while (Date.now() < deadline && !this.stopped) {
          if (this.page.url().includes(LOGGED_IN_URL_PART)) { log.info('登录成功'); break; }
          await sleep(2000);
        }
        if (!this.page.url().includes(LOGGED_IN_URL_PART)) {
          throw new Error('扫码超时（10 分钟未登录），请重新点击「扫码登录店铺」');
        }
      } else {
        log.info('已检测到登录状态');
      }
      await sleep(5000);
      const shopName = (await detectShopName(this.page)) || '未知店铺';
      const safeName = shopName.replace(/[\\/:*?"<>|]/g, '_');
      const cookiePath = path.join(PROJECT_COOKIES_DIR, `${safeName}.json`);
      const cookies = await this.context.cookies();
      // 只输出元信息，不输出 Cookie 内容
      log.info(`店铺名称: ${shopName}，Cookie 条数: ${cookies.length}`);
      fs.writeFileSync(cookiePath, JSON.stringify(cookies, null, 2));
      log.info(`SHOP_NAME:${safeName}`);
      log.info(`Cookie 已保存: ${cookiePath}`);
      return { shopName: safeName, cookiePath };
    } finally {
      await this.close();
    }
  }

  /** 切到「扫码登录」视图；若卡片内二维码已可见则不点（fresh 会话默认手机号视图）。 */
  async _switchToQrView() {
    let qr = await this._findCardQrLocator();
    if (qr) return;
    const toggle = this.page.locator('.login-switcher--cell').first();
    if ((await toggle.count()) > 0) {
      await toggle.click();
      await sleep(4000);
      qr = await this._findCardQrLocator();
    }
    if (!qr) throw new Error('未找到扫码登录二维码（登录页结构可能变化，可改用 npm run login 弹出浏览器扫码）');
  }

  /** 登录卡片内的二维码元素；排除页面底部 136px 的 App 下载码（卡片码 140–320px 且 y<600）。 */
  async _findCardQrLocator() {
    const cands = this.page.locator('[class*="qrcode"]');
    const n = await cands.count();
    for (let i = 0; i < n; i++) {
      const el = cands.nth(i);
      const box = await el.boundingBox();
      if (box && box.width >= 140 && box.width <= 320 && box.height >= 140 && box.y < 600) return el;
    }
    return null;
  }

  /**
   * 二维码维持循环：1.5s 截一张最新码给网页展示；检测到「二维码已过期」覆盖层时
   * 自动 reload 登录页并重新切到扫码视图（配合 URL 轮询判登录，重载不影响等待）。
   */
  async _maintainQrLoop() {
    while (!this.stopped) {
      try {
        const expired = await this.page.evaluate(() => {
          const el = document.querySelector('[class*="qrcode"]');
          return el ? /过期/.test(el.innerText || '') : false;
        }).catch(() => false);
        if (expired) {
          log.info('登录二维码已过期，自动刷新页面重取');
          await this.page.reload({ waitUntil: 'domcontentloaded' });
          await sleep(4000);
          await this._switchToQrView();
          continue;
        }
        const el = await this._findCardQrLocator();
        if (el) {
          const shot = await el.screenshot();
          this.qrDataUrl = `data:image/png;base64,${shot.toString('base64')}`;
        }
      } catch (e) { /* 二维码暂时不可截（切换动画/已登录）忽略 */ }
      await sleep(1500);
    }
  }

  async close() {
    this.stopped = true;
    if (this.browser) await this.browser.close().catch(() => {});
  }
}

module.exports = { runQrLogin, WebQrLoginSession, detectShopName };
