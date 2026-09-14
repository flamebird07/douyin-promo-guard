'use strict';

/**
 * 测试公共辅助 v2 —— 全部为隔离环境（mock + 临时目录 + 可注入时钟），不访问真实页面。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { CloseOutcomeUnknownError } = require('../src/lib/errors');
const { shanghaiDate } = require('../src/lib/time');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'promo-guard-test-'));
}

/** 写入一个最小合法的 Playwright cookies 数组文件（值均为假数据，无真实凭证）。 */
function writeTempCookie(dir, name, opts = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const exp = opts.expired ? nowSec - 3600 : nowSec + 86400;
  const cookies = [
    { name: 'sessionid', value: 'FAKE_VALUE_NOT_REAL', domain: '.fxg.jinritemai.com', path: '/', expires: exp, httpOnly: true, secure: true, sameSite: 'Lax' },
    { name: 'other', value: 'FAKE_VALUE_NOT_REAL', domain: '.jinritemai.com', path: '/', expires: exp, httpOnly: false, secure: true, sameSite: 'Lax' },
  ];
  const p = path.join(dir, `${name}.json`);
  fs.writeFileSync(p, JSON.stringify(cookies, null, 2));
  return p;
}

/** 构造 loadConfig() 形状的结果（绕过真实配置文件）。 */
function makeCfgResult(overrides = {}) {
  const config = {
    shops: overrides.shops || [{ id: 'shop-001', name: '测试店铺一', cookieFile: '测试店铺一', accountId: null, enabled: true }],
    promoPage: { url: 'https://example-promo-page.test' },
    rules: overrides.rules || [{
      type: 'wholeShopCostPerOrder', name: '当天每单成本超额关全店', metric: 'cost_per_order',
      thresholdCents: overrides.thresholdCents ?? 100, comparator: '>', period: 'today', timezone: 'Asia/Shanghai', enabled: true,
    }],
    execution: Object.assign({
      dryRun: true, realMode: false, maxRetries: 1, retryBackoffMs: 1,
      closeTimeoutMs: 200, readbackTimeoutMs: 200, readbackAttempts: 2, readbackIntervalMs: 1,
      zeroOrderRecheck: 1, maxAdPages: 50,
    }, overrides.execution),
    schedule: Object.assign({ dailyStartHour: 8, intervalMinutes: 30, timezone: 'Asia/Shanghai' }, overrides.schedule),
    monitor: Object.assign({
      snapshotMaxAgeMinutes: 30, mockDataSource: false,
    }, overrides.monitor),
    login: Object.assign({
      cookieSourceDir: overrides.cookieDir,
      edgePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      douyinHomeUrl: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
    }),
  };
  return { config, pending: overrides.pending || [], ready: (overrides.pending || []).length === 0, sourcePath: 'test-inline' };
}

/**
 * 构造与 mock 控制器共享广告状态的读取器：
 * 费用/订单/清单均来自同一份定义，关闭后的状态变化能被清单重新读取到。
 * def.pageSource 可覆盖来源标识（真实模式测试用 'promo-page'）。
 * def.ordersSequence 提供订单数读取序列（零订单重读测试）。
 * def.forceHasNext 使最后页仍 hasNext=true（清单不完整测试）。
 */
function makeLinkedReader(controller, def, nowFn) {
  const now = nowFn || Date.now;
  const today = () => shanghaiDate(now());
  const src = def.pageSource || 'mock';
  let orderSeqIdx = 0;
  const ordersValue = () => {
    if (def.ordersSequence && def.ordersSequence.length) {
      const v = def.ordersSequence[Math.min(orderSeqIdx, def.ordersSequence.length - 1)];
      orderSeqIdx += 1;
      return v;
    }
    return def.orders;
  };
  return {
    connected: false,
    source: src,
    readCostSummaryCalls: 0,
    readOrderSummaryCalls: 0,
    async readCostSummary() {
      this.readCostSummaryCalls += 1;
      return {
        source: src, kind: 'cost',
        shopId: def.costShopId !== undefined ? def.costShopId : 'shop-001',
        accountId: def.costAccountId,
        businessDate: def.costDate || today(),
        fetchedAt: def.costFetchedAt || new Date(now()).toISOString(),
        pageUpdatedAt: def.costPageUpdatedAt || null,
        rawText: def.costRawText || null,
        valueCents: def.costCents,
        parseError: def.costParseError,
      };
    },
    async readOrderSummary() {
      this.readOrderSummaryCalls += 1;
      return {
        source: src, kind: 'orders',
        shopId: def.orderShopId !== undefined ? def.orderShopId : 'shop-001',
        accountId: def.orderAccountId,
        businessDate: def.orderDate || today(),
        fetchedAt: def.orderFetchedAt || new Date(now()).toISOString(),
        pageUpdatedAt: def.orderPageUpdatedAt || null,
        rawText: def.ordersRawText || null,
        valueCount: ordersValue(),
        parseError: def.ordersParseError,
      };
    },
    async listAdPage({ pageNo = 1, scanId } = {}) {
      const size = def.pageSize || 2; // 默认每页 2 条，制造多页
      const all = controller.listAds();
      const slice = all.slice((pageNo - 1) * size, pageNo * size);
      const isLast = pageNo * size >= all.length;
      return {
        source: src,
        scanId: scanId || 'mock-scan',
        shopId: def.adsShopId !== undefined ? def.adsShopId : 'shop-001',
        accountId: def.adsAccountId,
        businessDate: def.adsDate || today(),
        fetchedAt: def.adsFetchedAt || new Date(now()).toISOString(),
        pageNo,
        hasNext: def.forceHasNext ? true : !isLast,
        ads: slice.map((a) => ({ ...a })),
        coverage: def.coverage || [{ type: 'uni_promotion', complete: true }],
        coverageGaps: def.coverageGaps || [],
        listComplete: def.listComplete !== undefined ? def.listComplete : true, // mock 显式声明完整性
        coverageNote: 'mock',
      };
    },
  };
}

/** 内存广告控制器（状态可变，供协调器/清单共享；支持延迟完成与失败注入）。 */
function makeStatefulController(opts = {}) {
  const ads = (opts.ads || []).map((a) => ({ ...a }));
  const state = { identityCalls: 0, closeCalls: [], getAdCalls: 0 };
  const delayMsFor = (adId) => (opts.delayMsFor && opts.delayMsFor[adId]) || 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  return {
    connected: false,
    source: 'mock',
    state,
    listAds: () => ads.map((a) => ({ ...a })),
    async verifyIdentity() {
      state.identityCalls += 1;
      if (!opts.identity) return { ok: false, reason: 'mock 未配置页面身份' };
      return {
        ok: true,
        pageShopId: opts.identity.id,
        pageShopName: opts.identity.name,
        pageAccountId: opts.identity.accountId,
      };
    },
    async getAd({ adId }) {
      state.getAdCalls += 1;
      const ad = ads.find((a) => a.adId === adId);
      if (!ad) return { found: false };
      // 透传行级开关字段（千川语义），无该字段时由 close-flow 回退状态词表
      return {
        found: true,
        status: ad.status,
        rawName: ad.name,
        switchChecked: typeof ad.switchChecked === 'boolean' ? ad.switchChecked : undefined,
      };
    },
    async closeAd({ adId }) {
      state.closeCalls.push({ adId, at: new Date().toISOString() });
      const ad = ads.find((a) => a.adId === adId);
      if (!ad) throw new Error(`mock: 广告 ${adId} 不存在`);
      if (opts.failCloseFor && opts.failCloseFor.has(adId)) throw new Error(`mock: 关闭请求被拒绝（${adId}）`);
      if (opts.unknownFor && opts.unknownFor.has(adId)) {
        ad.status = '已关闭';
        ad.switchChecked = false;
        throw new CloseOutcomeUnknownError('mock: 关闭请求超时，结果未知');
      }
      if (opts.stuckFor && opts.stuckFor.has(adId)) {
        throw new CloseOutcomeUnknownError('mock: 关闭请求超时，结果未知（实际未生效）');
      }
      const delay = delayMsFor(adId);
      if (delay > 0) {
        // 延迟完成：请求发起后长时间不返回（模拟网络挂起），最终成功
        await sleep(delay);
        ad.status = '已关闭';
        ad.switchChecked = false;
        return;
      }
      ad.status = '已关闭';
      ad.switchChecked = false;
    },
    // 仅测试用：模拟人工在页面上恢复投放（引擎本身无恢复能力）
    _testSetStatus(adId, status, switchChecked) {
      const ad = ads.find((a) => a.adId === adId);
      if (ad) { ad.status = status; if (typeof switchChecked === 'boolean') ad.switchChecked = switchChecked; }
    },
    // 仅测试用：模拟批次执行期间页面上新增了广告
    _testAddAd(ad) {
      ads.push({ ...ad });
    },
  };
}

/**
 * 确定性时钟：延时以"门"的形式挂起调度循环，测试按需放行并推进虚拟时钟。
 */
function makeClock(startMs) {
  let now = startMs;
  const gates = [];
  return {
    nowFn: () => now,
    delayFn: (ms) => new Promise((res) => gates.push({ ms, res })),
    advance(ms) { now += ms; },
    releaseOne() {
      const g = gates.shift();
      if (g) { now += g.ms; g.res(); }
      return g;
    },
    releaseAll() {
      while (gates.length) {
        const g = gates.shift();
        now += g.ms;
        g.res();
      }
    },
    pending() { return gates.length; },
    now() { return now; },
  };
}

async function waitFor(cond, timeout = 2000, label = '条件') {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeout) throw new Error(`waitFor 超时: ${label}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

module.exports = { makeTempDir, writeTempCookie, makeCfgResult, makeLinkedReader, makeStatefulController, makeClock, waitFor, shanghaiDate };
