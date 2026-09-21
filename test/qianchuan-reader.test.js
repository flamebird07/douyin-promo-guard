'use strict';

/**
 * 第五轮回归测试：千川生产适配器（stub 浏览器注入 + 纯函数）。
 * 覆盖：费用读取解析、getAd 参数链路（shopCfg.accountId → 详情页 URL）、
 *       计划 ID 精确核验（前缀/子串拒绝）、账户一致性、资源清理（初始化失败必关浏览器）、
 *       完整性覆盖表（总数对账/未解析/翻页失败/未接入类型）、开关语义。
 * 运行：npm test
 */

const { test, before } = require('node:test');
const assert = require('node:assert');
const {
  openQianchuanHome,
  createQianchuanCostReader,
  createQianchuanAdController,
  createQianchuanAdListReader,
  extractConsumeCentsFromCardText,
  verifyStatPeriod,
  extractPlanIdFromDetail,
  extractInlinePlanId,
  mapRowStatus,
  closableSideOf,
  buildCoverage,
  KNOWN_AD_TYPES,
} = require('../src/adapters/qianchuan-reader');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { AuthError } = require('../src/lib/errors');
const { shanghaiMs } = require('../src/lib/time');

const LOGIN_CFG = {
  cookieSourceDir: null, // before() 中指向临时目录
  edgePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  douyinHomeUrl: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
};
const NOW = () => shanghaiMs('2026-09-13', '11:36');

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-reader-test-'));
  fs.writeFileSync(path.join(dir, '测试店铺.json'), JSON.stringify([
    { name: 'sessionid', value: 'FAKE_NOT_REAL', domain: '.fxg.jinritemai.com', path: '/', expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: true, sameSite: 'Lax' },
  ]));
  LOGIN_CFG.cookieSourceDir = dir;
});

// ── 纯函数 ────────────────────────────────────────────────────────
test('费用卡片解析：账户整体消耗转整数分（实测文本）', () => {
  const r = extractConsumeCentsFromCardText('账户整体消耗(元)14.98相比上周期+70.03%');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.cents, 1498);
  assert.strictEqual(extractConsumeCentsFromCardText('账户余额(元)63.84').ok, false, '余额不能替代消耗');
});

test('统计周期：两个 input 均为当天才通过', () => {
  assert.strictEqual(verifyStatPeriod(['2026-09-13', '2026-09-13'], NOW()).ok, true);
  assert.strictEqual(verifyStatPeriod(['2026-09-12', '2026-09-13'], NOW()).ok, false);
  assert.strictEqual(verifyStatPeriod(null, NOW()).ok, false);
});

test('标准投放行内计划ID提取：唯一命中；达人ID（8位带空格）不干扰；多候选拒绝', () => {
  const ok = extractInlinePlanId('2024-10-23_托管_【上传YLB3】9833_R3 日常销售托管ID:1813702913164419编辑复制已终止学保0.00 芦淞区瑾漂亮服饰商行 ID: 79863866 - 3支付ROI');
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.planId, '1813702913164419', '12位以上计划ID命中；8位达人ID（带空格）不干扰');
  assert.strictEqual(extractInlinePlanId('没有ID的行').ok, false);
  assert.strictEqual(extractInlinePlanId('ID:1813702913164419 另一个 ID:1813702999999999').ok, false, '多候选无法唯一定位');
});

test('详情页计划ID提取带数字边界（无前缀/子串误匹配）', () => {
  assert.strictEqual(extractPlanIdFromDetail('计划ID：1794726122856516'), '1794726122856516');
  const longer = extractPlanIdFromDetail('计划ID：17947261228565163');
  assert.notStrictEqual(longer, '1794726122856516', '不得截取前缀（提取返回全串，精确性由提取后全等比对保证）');
});

test('行状态词与开关语义分离：状态词不替代开关证据', () => {
  assert.strictEqual(mapRowStatus('xx 已暂停 xx'), '已暂停');
  assert.strictEqual(mapRowStatus('xx 已终止 xx'), '已终止');
  assert.strictEqual(mapRowStatus('神秘状态'), null, '词表外 fail-closed');
  assert.strictEqual(closableSideOf({ switchChecked: true, status: '已暂停' }), 'closable', '开关开启=投放侧（状态词仅记录）');
  assert.strictEqual(closableSideOf({ switchChecked: false, status: '投放中' }), 'closed_side', '开关未开启=关闭侧（矛盾态以开关为准）');
  assert.strictEqual(closableSideOf({ switchChecked: null, status: '神秘状态' }), 'unknown', '未知侧不得当作关闭');
  assert.strictEqual(closableSideOf({ status: '投放中' }), 'closable', '无开关字段时回退状态词（mock 兼容）');
});

test('覆盖表：总数对账/未解析/翻页失败/截断 任一不满足 → incomplete；未接入类型列入缺口', () => {
  const full = buildCoverage(
    [{ type: 'uni_promotion', total: 2, rowsRead: 2, withId: 2, unresolvedCount: 0, pagesVisited: 1, pageFailures: 0, truncated: false }],
    ['uni_promotion']
  );
  assert.strictEqual(full.complete, false, '乘方/品牌未接入 → 覆盖缺口');
  assert.ok(full.coverageGaps.some((g) => g.type === 'overall'));
  assert.ok(full.coverageGaps.some((g) => g.type === 'brand'));
  assert.ok(full.coverageGaps.some((g) => /不得视为无广告/.test(g.reason)), '零消耗也不能认定无广告');

  const bothOk = buildCoverage(
    [
      { type: 'uni_promotion', total: 2, rowsRead: 2, withId: 2, unresolvedCount: 0, pagesVisited: 1, pageFailures: 0, truncated: false },
      { type: 'standard', total: 157, rowsRead: 157, withId: 157, unresolvedCount: 0, pagesVisited: 16, pageFailures: 0, truncated: false },
    ],
    ['uni_promotion', 'standard']
  );
  assert.strictEqual(bothOk.complete, false, '乘方/品牌未接入 → 整体覆盖不完整');
  assert.strictEqual(bothOk.coverageGaps.filter((g) => g.type !== 'overall' && g.type !== 'brand').length, 0, '已接入两类型自身无缺口');

  const deficit = buildCoverage([{ type: 'standard', total: 157, rowsRead: 100, withId: 100, unresolvedCount: 0, pagesVisited: 10, pageFailures: 0, truncated: false }], ['standard']);
  assert.strictEqual(deficit.complete, false);
  assert.ok(deficit.coverageGaps.some((g) => /已读 100\/157 行/.test(g.reason)), '总数不符必须暴露');

  const unresolved = buildCoverage([{ type: 'uni_promotion', total: 2, rowsRead: 2, withId: 1, unresolvedCount: 1, pagesVisited: 1, pageFailures: 0, truncated: false }], ['uni_promotion']);
  assert.ok(unresolved.coverageGaps.some((g) => /1 行未取得稳定ID/.test(g.reason)), 'unresolved 非空必须暴露');

  const pageFail = buildCoverage([{ type: 'standard', total: 157, rowsRead: 10, withId: 10, unresolvedCount: 0, pagesVisited: 1, pageFailures: 1, truncated: false }], ['standard']);
  assert.strictEqual(pageFail.complete, false, '翻页失败不得当作完整');

  void KNOWN_AD_TYPES;
});

// ── stub 浏览器：参数链路与资源清理 ───────────────────────────────

function makeStubPage({ url = 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424', entryCount = 1, evaluateResponses = [], onGoto = null, bodyText = '', urlQueue = null, evaluateByFn = null } = {}) {
  const calls = { gotos: [], closes: 0, clicks: 0, evaluates: [] };
  let urlIdx = 0;
  const nextUrl = () => (urlQueue ? (urlQueue[Math.min(urlIdx++, urlQueue.length - 1)]) : url);
  const page = {
    __calls: calls,
    goto: async (u) => { calls.gotos.push(u); if (onGoto) return onGoto(u); return null; },
    waitForTimeout: async () => {},
    waitForLoadState: async () => {},
    waitForFunction: async () => null,
    waitForURL: async () => null,
    url: () => nextUrl(),
    title: async () => '巨量千川',
    screenshot: async () => {},
    reload: async () => {},
    goBack: async () => {},
    keyboard: { press: async () => {} },
    evaluate: async (fn, arg) => {
      const src = String(fn);
      calls.evaluates.push(src.slice(0, 60));
      if (evaluateByFn) {
        const r = evaluateByFn(src, arg);
        if (r !== undefined) return r;
      }
      if (evaluateResponses.length) return evaluateResponses.shift();
      return null;
    },
    getByText: () => ({
      first() { return this; },
      count: async () => entryCount,
      click: async () => { calls.clicks += 1; },
      waitFor: async () => {},
    }),
    locator: () => ({
      nth: () => ({
        locator: () => ({
          first() { return this; },
          waitFor: async () => {},
          click: async () => { calls.clicks += 1; },
        }),
      }),
      first() { return this; },
      waitFor: async () => {},
      click: async () => { calls.clicks += 1; },
      textContent: async () => bodyText,
    }),
  };
  const context = {
    addCookies: async () => {},
    newPage: async () => page,
    waitForEvent: async () => null,
    on() {},
    off() {},
  };
  const browser = {
    newContext: async () => context,
    close: async () => { calls.closes += 1; browser.closed = true; },
  };
  return { page, context, browser, calls };
}

test('资源清理：导航失败 → 本次创建的浏览器必须被关闭', async () => {
  const stub = makeStubPage({ onGoto: () => { throw new Error('net::ERR_TIMED_OUT'); } });
  await assert.rejects(
    () => openQianchuanHome(LOGIN_CFG, { cookieFile: '测试店铺' }, { browserFactory: async () => stub.browser }),
    /net::ERR_TIMED_OUT/
  );
  assert.strictEqual(stub.calls.closes, 1, '初始化失败必须关闭浏览器');
});

test('资源清理：入口缺失 → 浏览器必须被关闭', async () => {
  const stub = makeStubPage({ entryCount: 0, urlQueue: ['https://fxg.jinritemai.com/ffa/mshop/homepage/index'] });
  await assert.rejects(
    () => openQianchuanHome(LOGIN_CFG, { cookieFile: '测试店铺' }, { browserFactory: async () => stub.browser }),
    /巨量千川/
  );
  assert.strictEqual(stub.calls.closes, 1);
});

test('资源清理：Cookie 缺失 → 浏览器尚未创建也不得误关其他资源', async () => {
  await assert.rejects(() => openQianchuanHome(LOGIN_CFG, { cookieFile: '不存在的cookie' }, { browserFactory: async () => { throw new Error('不应创建'); } }), /未找到/);
});

// 2026-09-21 生产实录：抖店首页"巨量千川"入口点击偶发"点击成功但不弹新标签、URL 未变化"，
// 导致整轮"操作前重新读取"作废（零请求）。该步只读 → 有界重试 + 账户ID已知时直连兜底。
const QC_HOME = 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424';
const FXG_HOME = 'https://fxg.jinritemai.com/ffa/mshop/homepage/index';

test('入口点击首次不弹新标签：同会话回首页重试一次后到达千川（entry-click，attempts=2）', async () => {
  const stub = makeStubPage({ urlQueue: [FXG_HOME, FXG_HOME, QC_HOME] });
  const r = await openQianchuanHome(LOGIN_CFG, { cookieFile: '测试店铺', accountId: '1710242295996424' }, { browserFactory: async () => stub.browser });
  assert.strictEqual(r.navMode, 'entry-click', '走入口点击路径');
  assert.ok(String(r.target.url()).includes('qianchuan.jinritemai.com'), '确实落在千川首页');
  assert.strictEqual(stub.calls.clicks, 2, '首次点击未到达 → 回首页再点一次（共 2 次），不无限点');
  assert.strictEqual(stub.calls.gotos.filter((u) => u === FXG_HOME).length, 2, '重试前重新打开抖店首页（初始 + 重试）');
  assert.strictEqual(stub.calls.closes, 0, '成功路径不关浏览器（由调用者释放）');
});

test('入口连续 3 次不弹标签：账户ID已知 → 直连千川首页兜底成功（direct-home-url）', async () => {
  const stub = makeStubPage({ entryCount: 0, urlQueue: [FXG_HOME, FXG_HOME, FXG_HOME, QC_HOME] });
  const r = await openQianchuanHome(LOGIN_CFG, { cookieFile: '测试店铺', accountId: '1710242295996424' }, { browserFactory: async () => stub.browser });
  assert.strictEqual(r.navMode, 'direct-home-url', '入口不可用 → 用文档证据地址直连');
  assert.ok(stub.calls.gotos.some((u) => u.includes('qianchuan.jinritemai.com/home?aavid=1710242295996424')), '直连 URL 必须带配置账户ID');
  assert.strictEqual(stub.calls.clicks, 0, '入口不存在时零点击');
});

test('入口 3 次 + 直连兜底均未到达千川：如实失败并关闭浏览器（绝不把首页/登录页当千川）', async () => {
  const stub = makeStubPage({ entryCount: 0, urlQueue: [FXG_HOME] });
  await assert.rejects(
    () => openQianchuanHome(LOGIN_CFG, { cookieFile: '测试店铺', accountId: '1710242295996424' }, { browserFactory: async () => stub.browser }),
    /巨量千川/
  );
  assert.strictEqual(stub.calls.closes, 1, '失败必须关闭本次创建的浏览器');
});

test('入口点击后落到登录/授权中转页：不算到达千川，仍走重试与兜底', async () => {
  const stub = makeStubPage({ urlQueue: [FXG_HOME, 'https://qianchuan.jinritemai.com/login?aavid=1710242295996424', QC_HOME] });
  const r = await openQianchuanHome(LOGIN_CFG, { cookieFile: '测试店铺', accountId: '1710242295996424' }, { browserFactory: async () => stub.browser });
  assert.strictEqual(r.navMode, 'entry-click');
  assert.ok(!/\/login/.test(String(r.target.url())), '最终落点不得是登录页');
  assert.strictEqual(stub.calls.clicks, 2, '登录中转页不算成功 → 重试一次');
});

test('费用读取：evaluate 序列驱动下输出账户/口径/分项（stub 页面）', async () => {
  const stub = makeStubPage({
    urlQueue: ['https://fxg.jinritemai.com/ffa/mshop/homepage/index', 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424'],
    evaluateResponses: [
      { accountId: '1710242295996424', accountName: '伊人美' },
      ['2026-09-13', '2026-09-13'],
      '账户整体消耗(元)16.45相比上周期+70.03%',
      '更新于：09-13 11:17',
      [
        { item: '乘方计划消耗', raw: '14.98' },
        { item: '标准投放消耗', raw: '0.00' },
        { item: '全域投放消耗', raw: '0.00' },
        { item: '品牌投放消耗', raw: '0.00' },
      ],
    ],
  });
  const reader = createQianchuanCostReader({ loginCfg: LOGIN_CFG, nowFn: NOW, browserFactory: async () => stub.browser });
  const summary = await reader.readCostSummary({ shopCfg: { id: '瑾漂亮潮流服饰', cookieFile: '测试店铺', accountId: '1710242295996424' } });
  assert.strictEqual(summary.accountId, '1710242295996424');
  assert.strictEqual(summary.valueCents, 1645);
  assert.strictEqual(summary.businessDate, '2026-09-13');
  assert.strictEqual(summary.breakdown.length, 4);
  assert.strictEqual(summary.pageUpdatedAt.includes('2026-09-13 11:17'), true);
  assert.strictEqual(stub.calls.closes, 1, '读取完成后由读取器释放浏览器');
});

test('控制器 getAd 参数链路：shopCfg.accountId 进入详情页 URL；计划ID 精确核验（前缀拒绝）', async () => {
  const fullId = '1794726122856516';
  const prefixId = '179472612285651'; // 前缀（少一位）
  const stub = makeStubPage({
    urlQueue: ['https://fxg.jinritemai.com/ffa/mshop/homepage/index', 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424'],
    evaluateResponses: [
      { pagePlanIds: [fullId], accountOnPage: '1710242295996424', status: '已暂停' },
    ],
  });
  const controller = createQianchuanAdController({ loginCfg: LOGIN_CFG, nowFn: NOW, browserFactory: async () => stub.browser });
  const shopCfg = { id: '瑾漂亮潮流服饰', cookieFile: '测试店铺', accountId: '1710242295996424' };
  const r = await controller.getAd({ page: null, shopCfg, adId: fullId, adType: 'uni_promotion' });
  assert.strictEqual(r.found, true);
  assert.strictEqual(r.status, '已暂停');
  assert.strictEqual(r.alreadyClosedSide, true, '已暂停 → 关闭侧');
  assert.match(stub.calls.gotos.some((u) => /aavid=1710242295996424&adId=1794726122856516/.test(u)) ? stub.calls.gotos.find((u) => /aavid=1710242295996424&adId=1794726122856516/.test(u)) : '', /aavid=1710242295996424&adId=1794726122856516/, 'shopCfg.accountId 必须进入详情页 URL');
  void prefixId;

  // 前缀 ID：页面只有完整 ID → 不匹配 → found=false（精确核验）
  const stub2 = makeStubPage({
    urlQueue: ['https://fxg.jinritemai.com/ffa/mshop/homepage/index', 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424'],
    evaluateResponses: [
      { pagePlanIds: [fullId], accountOnPage: '1710242295996424', status: '已暂停' },
    ],
  });
  const controller2 = createQianchuanAdController({ loginCfg: LOGIN_CFG, nowFn: NOW, browserFactory: async () => stub2.browser });
  const r2 = await controller2.getAd({ page: null, shopCfg, adId: prefixId, adType: 'uni_promotion' });
  assert.strictEqual(r2.found, false, '前缀/子串 ID 不得匹配');
  assert.match(r2.reason, /计划ID与目标不一致/);
});

test('控制器 getAd：详情页账户与配置不一致 → 拒绝', async () => {
  const stub = makeStubPage({
    urlQueue: ['https://fxg.jinritemai.com/ffa/mshop/homepage/index', 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424'],
    evaluateResponses: [
      { pagePlanIds: ['1794726122856516'], accountOnPage: '9999999999', status: '已暂停' },
    ],
  });
  const controller = createQianchuanAdController({ loginCfg: LOGIN_CFG, nowFn: NOW, browserFactory: async () => stub.browser });
  const r = await controller.getAd({ page: null, shopCfg: { id: 'x', cookieFile: '测试店铺', accountId: '1710242295996424' }, adId: '1794726122856516', adType: 'uni_promotion' });
  assert.strictEqual(r.found, false);
  assert.match(r.reason, /账户.*不一致/);
});

test('控制器 getAd：配置缺少 accountId → AuthError（参数契约）', async () => {
  const stub = makeStubPage({});
  const controller = createQianchuanAdController({ loginCfg: LOGIN_CFG, nowFn: NOW, browserFactory: async () => stub.browser });
  await assert.rejects(
    () => controller.getAd({ page: null, shopCfg: { id: 'x', cookieFile: '测试店铺' }, adId: '1794726122856516', adType: 'uni_promotion' }),
    AuthError
  );
});

test('closeAd：硬保险拒绝执行（本轮不真实关闭）', async () => {
  const stub = makeStubPage({});
  const controller = createQianchuanAdController({ loginCfg: LOGIN_CFG, nowFn: NOW, browserFactory: async () => stub.browser });
  await assert.rejects(() => controller.closeAd({ adId: '1794726122856516' }), /真实关闭未启用/);
  assert.strictEqual(stub.calls.clicks, 0, '绝不点击投放开关');
});

// ── 第六轮：adType 贯穿与类型分派 ─────────────────────────────────
test('getAd：缺失/未知 adType → 明确拒绝（不猜测路径）', async () => {
  const stub = makeStubPage({});
  const controller = createQianchuanAdController({ loginCfg: LOGIN_CFG, nowFn: NOW, browserFactory: async () => stub.browser });
  for (const bad of [undefined, null, 'chengfang', 'unknown_type']) {
    await assert.rejects(
      () => controller.getAd({ page: null, shopCfg: { id: 'x', cookieFile: '测试店铺', accountId: '1710242295996424' }, adId: '1794726122856516', adType: bad }),
      /未知投放类型|adType/
    );
  }
  assert.strictEqual(stub.calls.gotos.length, 0, '拒绝前不得发起任何导航');
});

test('getAd 分派：同一稳定ID、不同类型 → 走不同读取路径', async () => {
  // uni_promotion：详情页 URL 路径（stub evaluate 返回详情页数据）
  const stubU = makeStubPage({
    urlQueue: ['https://fxg.jinritemai.com/ffa/mshop/homepage/index', 'https://qianchuan.jinritemai.com/uni-prom/detail?aavid=1710242295996424&adId=1794726122856516'],
    evaluateResponses: [
      { pagePlanIds: ['1794726122856516'], accountOnPage: '1710242295996424', status: '已暂停' },
    ],
  });
  const cU = createQianchuanAdController({ loginCfg: LOGIN_CFG, nowFn: NOW, browserFactory: async () => stubU.browser });
  const rU = await cU.getAd({ page: null, shopCfg: { id: 'x', cookieFile: '测试店铺', accountId: '1710242295996424' }, adId: '1794726122856516', adType: 'uni_promotion' });
  assert.strictEqual(rU.found, true);
  assert.strictEqual(rU.adType, 'uni_promotion');
  assert.match(stubU.calls.gotos[1] || stubU.calls.gotos[0], /uni-prom\/detail/);

  // standard：列表行定位路径（stub evaluate 返回列表行含该托管ID；导航 evaluate 返回 undefined）
  const stdRows = {
    rows: [
      { rowIndex: 0, name: '托管计划甲', switchChecked: true, rowText: '2024_托管_测试A ID:1794726122856516 已终止' },
    ],
    total: 1,
  };
  const stdUrlQueue = ['https://fxg.jinritemai.com/ffa/mshop/homepage/index', 'https://qianchuan.jinritemai.com/promotion-v2/standard?aavid=1710242295996424'];
  const stubS = makeStubPage({
    urlQueue: stdUrlQueue,
    evaluateByFn: (src) => {
      if (src.includes('oc-switch')) return stdRows;                 // 行收集（生产函数）
      if (src.includes('标准投放') && src.includes('getBoundingClientRect')) return true; // 二级 tab 点击
      return undefined;                                              // 其他导航 evaluate
    },
  });
  const cS = createQianchuanAdController({ loginCfg: LOGIN_CFG, nowFn: NOW, browserFactory: async () => stubS.browser });
  const rS = await cS.getAd({ page: null, shopCfg: { id: 'x', cookieFile: '测试店铺', accountId: '1710242295996424' }, adId: '1794726122856516', adType: 'standard' });
  assert.strictEqual(rS.found, true);
  assert.strictEqual(rS.adType, 'standard');
  assert.strictEqual(rS.switchChecked, true, '标准路径读列表行开关（详情页无开关）');
  assert.strictEqual(rS.status, '已终止');
  assert.strictEqual(stubS.calls.gotos.some((u) => /uni-prom\/detail/.test(u)), false, '标准路径不得走全域详情页（SPA 内路由切 tab）；stub 队列终值=' + stdUrlQueue[stdUrlQueue.length - 1]);
});

test('getAd 分派：standard 列表中无该ID → found=false（不把其他ID当目标）', async () => {
  const stub = makeStubPage({
    urlQueue: ['https://fxg.jinritemai.com/ffa/mshop/homepage/index', 'https://qianchuan.jinritemai.com/promotion-v2/standard?aavid=1710242295996424'],
    evaluateByFn: (src) => {
      if (src.includes('oc-switch')) return { rows: [{ rowIndex: 0, name: '托管计划甲', switchChecked: false, rowText: '2024_托管_测试B ID:1813702913164419 已终止' }], total: 1 };
      if (src.includes('标准投放') && src.includes('getBoundingClientRect')) return true;
      return undefined;
    },
  });
  const c = createQianchuanAdController({ loginCfg: LOGIN_CFG, nowFn: NOW, browserFactory: async () => stub.browser });
  const r = await c.getAd({ page: null, shopCfg: { id: 'x', cookieFile: '测试店铺', accountId: '1710242295996424' }, adId: '1794726122856516', adType: 'standard' });
  assert.strictEqual(r.found, false);
});

// ── 第六轮：scanId 快照语义（不靠 TTL）────────────────────────────
test('scanId 快照：同 scanId 复用旧快照；scanId 变化强制新扫描（TTL 内可见页面变化）', async () => {
  // 可变"页面状态"：首次扫描后改变（关闭A、新增B），TTL 远未过期
  const state = {
    ads: [{ name: '计划A', switchChecked: true, rowText: '计划A ID:1813702900000001 投放中 0.00' }],
  };
  let scans = 0;
  const browserFactory = async () => {
    scans += 1;
    const stub = makeStubPage({
      urlQueue: [
        'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
        'https://qianchuan.jinritemai.com/promotion-v2/standard?aavid=1710242295996424',
      ],
      evaluateByFn: (src) => {
        if (src.includes('oc-switch')) {
          return {
            rows: state.ads.map((a, i) => ({ rowIndex: i, name: a.name, switchChecked: a.switchChecked, rowText: a.rowText })),
            total: state.ads.length,
          };
        }
        if (src.includes('标准投放') && src.includes('getBoundingClientRect')) return true;
        return undefined;
      },
    });
    return stub.browser;
  };
  const reader = createQianchuanAdListReader({
    loginCfg: LOGIN_CFG, nowFn: NOW, browserFactory,
    adTypes: ['standard'], snapshotMaxAgeMinutes: 60, // TTL 很长，排除 TTL 过期的可能
  });
  const shopCfg = { id: 'x', cookieFile: '测试店铺', accountId: '1710242295996424' };

  const p1 = await reader.listAdPage({ shopCfg, pageNo: 1, scanId: 'scan-1' });
  assert.strictEqual(scans, 1);
  assert.strictEqual(p1.ads.length, 1);
  assert.strictEqual(p1.ads[0].status, '投放中');
  assert.strictEqual(p1.ads[0].switchChecked, true);
  assert.strictEqual(p1.listComplete, false, '乘方/品牌未接入 → 覆盖缺口（预期）；本测试只关注快照语义');
  assert.ok(p1.coverageGaps.some((g) => g.type === 'overall'));

  // 改变模拟页面状态：A 关闭（开关关+已暂停），新增 B（开启+投放中）
  state.ads = [
    { name: '计划A', switchChecked: false, rowText: '计划A ID:1813702900000001 已暂停 0.00' },
    { name: '计划B', switchChecked: true, rowText: '计划B ID:1813702900000002 投放中 12.00' },
  ];

  // 同 scanId：仍返回旧快照（一次分页扫描语义）
  const p2 = await reader.listAdPage({ shopCfg, pageNo: 1, scanId: 'scan-1' });
  assert.strictEqual(scans, 1, '同 scanId 不得重新爬取');
  assert.strictEqual(p2.ads[0].status, '投放中', '旧快照不变');
  assert.strictEqual(p2.ads.length, 1);

  // 新 scanId：强制新扫描 —— 必须看到关闭、新增对象
  const p3 = await reader.listAdPage({ shopCfg, pageNo: 1, scanId: 'scan-2' });
  assert.strictEqual(scans, 2, 'scanId 变化必须重新扫描（不靠 TTL）');
  assert.strictEqual(p3.ads.length, 2);
  const a1 = p3.ads.find((a) => a.adId === '1813702900000001');
  const b1 = p3.ads.find((a) => a.adId === '1813702900000002');
  assert.strictEqual(a1.status, '已暂停');
  assert.strictEqual(a1.switchChecked, false);
  assert.strictEqual(b1.status, '投放中');
  assert.strictEqual(b1.switchChecked, true);
  assert.strictEqual(p3.hasNext, false);
  // 扫描标识与抓取时间
  assert.strictEqual(p3.scanId, 'scan-2');
  assert.ok(p3.fetchedAt);
});
