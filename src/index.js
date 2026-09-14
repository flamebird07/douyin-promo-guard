#!/usr/bin/env node
'use strict';

/**
 * CLI 入口。
 *
 *   node src/index.js check    检查配置、待配置项与各店铺 Cookie 状态（不启动浏览器）
 *   node src/index.js serve    启动中文控制界面（默认 http://127.0.0.1:18789）
 *   node src/index.js poll     立即执行一轮轮询（按当前模式：默认演练/未接入则明确报未接入）
 *   node src/index.js login    扫码登录并把 Cookie 保存到本项目 cookies/（需人工扫码）
 *   node src/index.js orders [--shop 店铺名]
 *                              只读读取电商罗盘"经营概况"当天实时全店成交订单数
 *   node src/index.js chengfang
 *                              乘方只读演练：身份核验 + 全店托管/商品自选只读枚举，
 *                              记录"将执行的全选→批量暂停"目标（不勾选、不点击任何开关/暂停）
 *   node src/index.js chengfang-read
 *                              乘方只读核实：身份核验 + 两区域清单读取（不枚举将暂停目标、
 *                              不点击任何开关/暂停/删除）
 *
 * 入口区分（读取 / 演练 / 真实执行）：
 *   - 读取：orders / ads / chengfang-read —— 只读，不打开任何可点击路径；
 *   - 演练：chengfang（dryRun 恒 true，无视 pauseEnabled）与 poll（按当前配置模式）；
 *   - 真实执行：无 CLI 命令。真实暂停只能由监控主链路发出，且必须同时满足
 *     execution.realMode=true 与 monitor.chengfang.pauseEnabled=true（以及每日 08:00 后
 *     Asia/Shanghai、未停止、业务日期一致等门槛）；单独改 pauseEnabled 不会生效。
 *
 * 注意：真实关闭（execution.realMode）默认关闭；乘方暂停动作真实执行
 * （monitor.chengfang.pauseEnabled）默认关闭；未配置业务规则时监控不可启动。
 */

const path = require('path');
const { loadConfig } = require('./config');
const { Monitor } = require('./engine/monitor');
const { createUiServer } = require('./ui/server');
const { loadShopCookieMeta } = require('./login/session');
const log = require('./lib/log');

const PORT = Number(process.env.PROMO_GUARD_PORT || 18789);

function cmdCheck() {
  const cfg = loadConfig();
  console.log(`配置文件: ${cfg.sourcePath}`);
  if (cfg.pending.length > 0) {
    console.log(`\n待配置/非法配置项（${cfg.pending.length} 项）—— 监控不可启动：`);
    cfg.pending.forEach((p) => console.log(`  - ${p}`));
  } else {
    console.log('\n配置齐全。');
  }
  console.log(`运行模式: ${cfg.config.execution.realMode ? '真实执行（危险）' : '演练模式（只记录不关闭）'}`);
  const sc = cfg.config.schedule;
  console.log(`调度: 每日 ${String(sc.dailyStartHour).padStart(2, '0')}:00 后（${sc.timezone}），每 ${sc.intervalMinutes} 分钟巡查`);
  console.log('\n规则（用户已确认）:');
  for (const r of cfg.config.rules || []) {
    console.log(
      `  [${r.enabled === false ? '停用' : '启用'}] ${r.name}：${r.type} ` +
      `阈值=${r.thresholdCents}分/单（${(r.thresholdCents / 100).toFixed(2)}元/单） 比较符=${r.comparator}（恰好相等不关闭） 周期=${r.period || 'today'}`
    );
  }
  console.log(`\n监控店铺（${(cfg.config.shops || []).length} 家）:`);
  for (const s of cfg.config.shops || []) {
    try {
      const meta = loadShopCookieMeta(cfg.config.login, s);
      console.log(
        `  [${s.enabled === false ? '停用' : '启用'}] ${s.id} cookie=${s.cookieFile}.json ` +
        `条数=${meta.count} 来源=${meta.readOnly ? '电商助手(只读)' : '本项目'} ` +
        `最近过期=${meta.maxExpires ? new Date(meta.maxExpires).toISOString() : '会话型'}`
      );
    } catch (e) {
      console.log(`  [${s.enabled === false ? '停用' : '启用'}] ${s.id} cookie=${s.cookieFile}.json → ${e.reason || e.message}`);
    }
  }
  const m = cfg.config.monitor;
  const src = (v) => (v === 'not-connected' ? '尚未接入' : v);
  console.log(`\n数据源配置: 费用=${src(m.costDataSource)} 订单=${src(m.orderDataSource)} 广告清单=${src(m.adListDataSource)}${m.mockDataSource ? '（mock 演示模式）' : ''}`);
}

async function cmdServe() {
  const cfg = loadConfig();
  const monitor = new Monitor(cfg);
  const { server } = createUiServer(monitor, PORT);
  server.listen(PORT, '127.0.0.1', () => {
    log.info(`控制台已启动: http://127.0.0.1:${PORT}`);
    if (cfg.pending.length > 0) {
      log.warn(`存在 ${cfg.pending.length} 项待配置，监控不可启动；请在 config/config.json 中补齐。`);
    }
  });
  const shutdown = () => {
    monitor.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdPoll() {
  const cfg = loadConfig();
  const monitor = new Monitor(cfg);
  const r = await monitor.pollOnce('cli');
  console.log(JSON.stringify(r, null, 2));
}

async function cmdLogin() {
  const cfg = loadConfig();
  const { runQrLogin } = require('./login/qr-login');
  const result = await runQrLogin(cfg.config.login);
  console.log(`登录完成。请把店铺名 "${result.shopName}" 填入 config/config.json 的 shops[].cookieFile。`);
}

/**
 * 只读读取电商罗盘"经营概况"的当天实时全店成交订单数。
 * 店铺选择规则：必须由 --shop 明确指定；仅当配置中恰好有一个有效店铺时才允许省略；
 * 找不到时列出可用店铺名称供选择，绝不默认第一个、不做模糊匹配。
 */
async function cmdOrders() {
  const shopArgIdx = process.argv.indexOf('--shop');
  const shopArg = shopArgIdx > -1 ? process.argv[shopArgIdx + 1] : null;
  const cfg = loadConfig();
  const loginCfg = cfg.config.login;
  const { listAvailableShops } = require('./login/session');

  const candidates = (cfg.config.shops || []).filter(
    (s) => s.cookieFile && !String(s.cookieFile).startsWith('TODO') && s.enabled !== false
  );
  let shop = null;
  if (shopArg) {
    shop = candidates.find(
      (s) => s.name === shopArg || s.compassShopName === shopArg || s.cookieFile === shopArg || s.id === shopArg
    );
    if (!shop) {
      console.error(`配置中找不到与「${shopArg}」精确匹配的店铺（禁止模糊匹配）。`);
    }
  } else if (candidates.length === 1) {
    shop = candidates[0];
  } else if (candidates.length === 0) {
    console.error('config/config.json 尚未配置有效店铺（shops[].cookieFile 为 TODO 或缺失）。');
  } else {
    console.error(`配置中有 ${candidates.length} 家店铺，请用 --shop <店铺名或ID> 明确指定（不默认任何一个）。`);
  }

  if (!shop) {
    const available = listAvailableShops(loginCfg);
    console.log('\n可用店铺名称（来自 cookies 目录，仅供选择）：');
    available.forEach((a) => console.log(`  - ${a.name}${a.readOnly ? '（电商助手只读）' : '（本项目）'}`));
    console.log('\n请先在 config/config.json 的 shops[] 中明确配置目标店铺（id/name/cookieFile），或使用 --shop 参数。');
    process.exit(2);
  }

  console.log(`读取店铺: ${shop.compassShopName || shop.name || shop.id}（cookie=${shop.cookieFile}，只读）`);
  const { createCompassOrderReader } = require('./adapters/compass-order-reader');
  const reader = createCompassOrderReader({ loginCfg });
  try {
    const summary = await reader.readOrderSummary({ shopCfg: shop });
    console.log('订单读取结果（Summary）:');
    console.log(JSON.stringify(summary, null, 2));
  } catch (e) {
    console.error(`订单读取受阻: ${e.reason || e.message}`);
    process.exit(1);
  }
}

/** 只读读取千川全域投放完整广告清单（含逐计划详情实测稳定 ID）。 */
async function cmdAds() {
  const shopArgIdx = process.argv.indexOf('--shop');
  const shopArg = shopArgIdx > -1 ? process.argv[shopArgIdx + 1] : null;
  const cfg = loadConfig();
  const loginCfg = cfg.config.login;
  const candidates = (cfg.config.shops || []).filter(
    (s) => s.cookieFile && !String(s.cookieFile).startsWith('TODO') && s.enabled !== false
  );
  let shop = null;
  if (shopArg) {
    shop = candidates.find((s) => s.name === shopArg || s.cookieFile === shopArg || s.id === shopArg);
    if (!shop) console.error(`配置中找不到与「${shopArg}」精确匹配的店铺（禁止模糊匹配）。`);
  } else if (candidates.length === 1) {
    shop = candidates[0];
  } else {
    console.error(`配置中有 ${candidates.length} 家店铺，请用 --shop 明确指定。`);
  }
  if (!shop) {
    const { listAvailableShops } = require('./login/session');
    console.log('可用店铺名称（仅供选择）：');
    listAvailableShops(loginCfg).forEach((a) => console.log(`  - ${a.name}`));
    process.exit(2);
  }
  console.log(`读取店铺: ${shop.name}（cookie=${shop.cookieFile}，只读，不触碰投放开关）`);
  const { createQianchuanAdListReader } = require('./adapters/qianchuan-reader');
  const reader = createQianchuanAdListReader({
    loginCfg,
    adTypes: (cfg.config.monitor.qianchuan && cfg.config.monitor.qianchuan.adTypes) || ['uni_promotion', 'standard'],
    maxAdPages: cfg.config.execution.maxAdPages,
    snapshotMaxAgeMinutes: cfg.config.monitor.snapshotMaxAgeMinutes,
  });
  try {
    const page = await reader.listAdPage({ shopCfg: shop, pageNo: 1 });
    console.log('广告清单（AdPage）:');
    console.log(JSON.stringify(page, null, 2));
  } catch (e) {
    console.error(`清单读取受阻: ${e.reason || e.message}`);
    process.exit(1);
  }
}

/**
 * 乘方只读演练（本轮交付入口）：进入乘方管理页，核验身份，只读枚举
 * 全店托管/商品自选的目标（100条/页翻页），记录"将执行的全选→批量暂停"，
 * 不勾选全选框、不点击任何开关/暂停/删除（dryRun 恒为 true，无视 pauseEnabled）。
 */
async function cmdChengfang() {
  const cfg = loadConfig();
  const loginCfg = cfg.config.login;
  const shopCfg = (cfg.config.shops || []).find((s) => s.enabled !== false);
  if (!shopCfg) {
    console.error('config/config.json 未配置启用中的店铺');
    process.exit(2);
  }
  console.log(`乘方只读演练（店铺 ${shopCfg.name}，cookie=${shopCfg.cookieFile}，只读）`);
  console.log('本轮不勾选全选框、不点击任何开关/暂停/删除；结果=将执行动作清单。\n');
  const { openChengfangShop, createChengfangController, closeBrowser } = require('./adapters/chengfang-reader');
  const { executeChengfangPause } = require('./engine/chengfang-executor');
  const { browser, target, account } = await openChengfangShop({ loginCfg, shopCfg });
  try {
    const controller = createChengfangController({ loadWaitMs: 8000, tabWaitMs: 6000 });
    const result = await executeChengfangPause({
      controller,
      page: target,
      shopCfg,
      config: cfg.config,
      dryRun: true,
      audit: (e) => console.log(`[audit] ${JSON.stringify(e)}`),
    });
    console.log('\n=== 乘方只读演练结果 ===');
    console.log(JSON.stringify(
      {
        mode: result.mode,
        identity: result.identity && { accountName: result.identity.pageAccountName, accountId: result.identity.pageAccountId, pageUrl: result.identity.pageUrl },
        views: {
          tuoguan: result.views.tuoguan,
          zixuan: result.views.zixuan,
        },
        willPauseTargets: result.dryRunTargets,
        allPausedConfirmed: result.allPausedConfirmed,
        confirmReason: result.confirmReason,
      },
      null, 2
    ));
    console.log(`\n演练完成（未点击任何开关/暂停）。将暂停目标数：${result.dryRunTargets.length}`);
    if (result.allPausedConfirmed) {
      console.log('注意：演练模式不宣称已暂停（未实际点击）。');
    }
  } finally {
    await closeBrowser(browser);
  }
}

/**
 * 乘方只读核实：进入乘方管理页，核验身份，读取全店托管/商品自选两区域当前清单
 * （行数、分页、每行开关状态），不枚举"将暂停目标"、不勾选、不点击任何开关/暂停/删除。
 */
async function cmdChengfangRead() {
  const cfg = loadConfig();
  const loginCfg = cfg.config.login;
  const shopCfg = (cfg.config.shops || []).find((s) => s.enabled !== false);
  if (!shopCfg) {
    console.error('config/config.json 未配置启用中的店铺');
    process.exit(2);
  }
  console.log(`乘方只读核实（店铺 ${shopCfg.name}，cookie=${shopCfg.cookieFile}，只读）`);
  console.log('不点击任何开关/暂停/删除；仅读取身份与两区域当前清单。\n');
  const { openChengfangShop, createChengfangController, closeBrowser } = require('./adapters/chengfang-reader');
  const { browser, target, account } = await openChengfangShop({ loginCfg, shopCfg });
  try {
    const controller = createChengfangController({ loadWaitMs: 8000, tabWaitMs: 6000 });
    const identity = await controller.verifyIdentity({ page: target, shopCfg }).catch((e) => ({ ok: false, reason: e.reason || e.message }));
    console.log('身份核验:', JSON.stringify(identity, null, 2));
    if (!identity || identity.ok !== true) {
      console.error('\n身份核验失败，停止（零点击）。');
      process.exit(1);
    }
    const out = { identity: { accountName: identity.pageAccountName, accountId: identity.pageAccountId, pageUrl: identity.pageUrl }, views: {} };
    for (const tab of ['全店托管', '商品自选']) {
      await controller.switchView({ page: target, tab });
      const view = await controller.readView({ page: target, tab }).catch((e) => ({ error: String(e.reason || e.message) }));
      if (!view || view.error) {
        out.views[tab] = { status: 'read_failed', error: (view && view.error) || '未知' };
        continue;
      }
      const rows = (view.rows && view.rows.rows) || [];
      const pagination = view.pagination || {};
      out.views[tab] = {
        status: rows.length === 0 ? (pagination.total === 0 ? 'confirmed_empty' : 'read_failed') : 'ok',
        rows: rows.length,
        pagination,
        plans: rows.map((r) => ({
          id: r.id,
          idError: r.idError || null,
          name: r.name,
          switchChecked: r.switchChecked,
          status: r.status,
          ops: r.ops || [],
        })),
      };
    }
    console.log('\n=== 乘方只读核实结果 ===');
    console.log(JSON.stringify(out, null, 2));
    const bad = Object.values(out.views).filter((v) => v.status === 'read_failed').length;
    if (bad > 0) console.log(`\n有 ${bad} 个视图读取失败（≠ 已确认无计划），请人工核实。`);
    else console.log('\n两区域读取完成（未点击任何开关/暂停/删除）。');
  } finally {
    await closeBrowser(browser);
  }
}

async function main() {
  const cmd = process.argv[2] || 'serve';
  switch (cmd) {
    case 'check': return cmdCheck();
    case 'serve': return cmdServe();
    case 'poll': return cmdPoll();
    case 'login': return cmdLogin();
    case 'orders': return cmdOrders();
    case 'ads': return cmdAds();
    case 'chengfang': return cmdChengfang();
    case 'chengfang-read': return cmdChengfangRead();
    default:
      console.error(`未知命令: ${cmd}（可用: check / serve / poll / login / orders / ads / chengfang / chengfang-read）`);
      process.exit(1);
  }
}

main().catch((e) => {
  log.error(e.stack || e.message);
  process.exit(1);
});
