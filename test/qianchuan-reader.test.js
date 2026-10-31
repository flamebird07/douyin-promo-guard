'use strict';

/**
 * 第五轮回归测试：千川生产适配器（stub 浏览器注入 + 纯函数）。
 * 覆盖：费用读取解析、getAd 参数链路（shopCfg.accountId → 详情页 URL）、
 *       计划 ID 精确核验（前缀/子串拒绝）、账户一致性、资源清理（初始化失败必关浏览器）、
 *       完整性覆盖表（总数对账/未解析/翻页失败/未接入类型）、开关语义。
 * 运行：npm test
 */

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
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
  ensureQianchuanAccountView,
  readQianchuanAccountViewInPage,
} = require('../src/adapters/qianchuan-reader');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { AuthError, DataGuardError } = require('../src/lib/errors');
const { shanghaiMs } = require('../src/lib/time');

const LOGIN_CFG = {
  cookieSourceDir: null, // before() 中指向临时目录
  cookieWorkDir: null, // 隔离工作副本，绝不回落默认 cookies/
  edgePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  douyinHomeUrl: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
};
const NOW = () => shanghaiMs('2026-09-13', '11:36');
let fixtureDir;

before(async () => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-reader-test-'));
  LOGIN_CFG.cookieSourceDir = fixtureDir;
  LOGIN_CFG.cookieWorkDir = path.join(fixtureDir, 'work');
  fs.writeFileSync(path.join(fixtureDir, '测试店铺.json'), JSON.stringify([
    { name: 'sessionid', value: 'FAKE_NOT_REAL', domain: '.fxg.jinritemai.com', path: '/', expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: true, sameSite: 'Lax' },
  ]));
});

after(() => {
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
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
      // openQianchuanHome 会在到达千川后做账户视图探针：本 stub 聚焦导航/资源清理，
      // 这里给出「账户视图已就绪、无弹窗」的稳定快照；弹窗安全由专门用例覆盖。
      if (/切至账户视图/.test(src)) {
        return {
          href: 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424',
          shopView: false, switchPresent: false, accountContent: true,
          popup: { present: false, safe: false, reason: 'none', closeTag: null },
        };
      }
      return null;
    },
    getByText: () => ({
      first() { return this; },
      nth() { return this; },
      count: async () => entryCount,
      click: async () => { calls.clicks += 1; },
      waitFor: async () => {},
      // locateQianchuanEntry/entryCandidateHref 需要候选自身最近 <a> 的 href（空=非教程链接）
      evaluate: async () => '',
      isVisible: async () => false,
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

// 费用读取的 evaluate 序列已含就绪探测（probeQianchuanConsumeReadiness 先于显式读取，
// 且每次探测消费 2 个 evaluate：周期+卡片），旧的按次序 evaluateResponses 会错位 ——
// 改为按序列化探针源码特征应答（shop-name/datepicker/out.push 分项/summaryCard 卡片/refreshTime）。
function costEvaluateByFn(over = {}) {
  return (src) => {
    if (/shop-name/.test(src)) return over.account !== undefined ? over.account : { accountId: '1710242295996424', accountName: '伊人美' };
    if (/report-shortcuts-datepicker/.test(src)) return ['2026-09-13', '2026-09-13'];
    if (/out\.push/.test(src)) return over.breakdown !== undefined ? over.breakdown : [
      { item: '乘方计划消耗', raw: '14.98' },
      { item: '标准投放消耗', raw: '0.00' },
      { item: '全域投放消耗', raw: '0.00' },
      { item: '品牌投放消耗', raw: '0.00' },
    ];
    if (/summaryCard/.test(src)) return over.card !== undefined ? over.card : '账户整体消耗(元)16.45相比上周期+70.03%';
    if (/refreshTime/.test(src)) return over.updatedAt !== undefined ? over.updatedAt : '更新于：09-13 11:17';
    return undefined;
  };
}

test('费用读取：evaluate 序列驱动下输出账户/口径/分项（stub 页面）', async () => {
  const stub = makeStubPage({
    urlQueue: ['https://fxg.jinritemai.com/ffa/mshop/homepage/index', 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424'],
    evaluateByFn: costEvaluateByFn(),
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

test('费用读取：页面账户 ID 缺失仍可完成（Cookie 归属，ID 仅可选观测）', async () => {
  const stub = makeStubPage({
    urlQueue: ['https://fxg.jinritemai.com/ffa/mshop/homepage/index', 'https://qianchuan.jinritemai.com/home'],
    evaluateByFn: costEvaluateByFn({ account: { accountId: null, accountName: '店名无ID' }, card: '账户整体消耗(元)3.21', updatedAt: '更新于：09-13 11:20', breakdown: [{ item: '乘方计划消耗', raw: '3.21' }] }),
  });
  const reader = createQianchuanCostReader({ loginCfg: LOGIN_CFG, nowFn: NOW, browserFactory: async () => stub.browser });
  const summary = await reader.readCostSummary({
    shopCfg: { id: '瑾漂亮潮流服饰', cookieFile: '测试店铺', accountId: '1710242295996424' },
  });
  assert.strictEqual(summary.accountId, null, '缺失不得伪造成配置 ID');
  assert.strictEqual(summary.valueCents, 321);
  assert.strictEqual(summary.shopId, '瑾漂亮潮流服饰');
  assert.match(summary.accountIdAttribution, /可选观测/);
  assert.strictEqual(stub.calls.closes, 1);
});

test('费用读取：页面账户 ID 与配置不同 → 仍返回数据，不因 ID 报 AUTH', async () => {
  const stub = makeStubPage({
    urlQueue: ['https://fxg.jinritemai.com/ffa/mshop/homepage/index', 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424'],
    evaluateByFn: costEvaluateByFn({ account: { accountId: '999000111222333', accountName: '另一账户' }, card: '账户整体消耗(元)8.00', updatedAt: '更新于：09-13 11:21', breakdown: [] }),
  });
  const reader = createQianchuanCostReader({ loginCfg: LOGIN_CFG, nowFn: NOW, browserFactory: async () => stub.browser });
  const summary = await reader.readCostSummary({
    shopCfg: { id: '瑾漂亮潮流服饰', cookieFile: '测试店铺', accountId: '1710242295996424' },
  });
  assert.strictEqual(summary.valueCents, 800);
  assert.strictEqual(summary.accountId, '999000111222333', '观测原样保留，不回填配置');
  assert.notStrictEqual(summary.accountId, '1710242295996424');
});

test('Cookie 归属：店A→FAKE_A 文件、店B→FAKE_B 文件，各一次且无混合', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-cookie-iso-'));
  // 唯一假文件名，避免与真实 Cookie 重名
  const nameA = `iso-ck-a-fake-${Date.now()}-A`;
  const nameB = `iso-ck-b-fake-${Date.now()}-B`;
  const valA = 'FAKE_ISO_A_ONLY';
  const valB = 'FAKE_ISO_B_ONLY';
  const cookieJson = (value) => JSON.stringify([
    { name: 'sessionid', value, domain: '.fxg.jinritemai.com', path: '/', expires: Math.floor(Date.now() / 1000) + 86400, httpOnly: true, secure: true, sameSite: 'Lax' },
  ]);
  const applied = []; // addCookies 记录
  const pathReads = []; // 解析到的 Cookie 文件路径（来自 cookieSession）

  function wrapBrowser(stub) {
    return async () => {
      const b = stub.browser;
      const origNewContext = b.newContext.bind(b);
      b.newContext = async () => {
        const ctx = await origNewContext();
        const origAdd = ctx.addCookies.bind(ctx);
        ctx.addCookies = async (cs) => {
          applied.push({
            values: (cs || []).map((c) => String(c.value)),
            names: (cs || []).map((c) => String(c.name)),
          });
          return origAdd(cs);
        };
        return ctx;
      };
      return b;
    };
  }

  try {
    fs.writeFileSync(path.join(dir, `${nameA}.json`), cookieJson(valA));
    fs.writeFileSync(path.join(dir, `${nameB}.json`), cookieJson(valB));
    const cfg = {
      cookieSourceDir: dir,
      cookieWorkDir: path.join(dir, 'work'),
      edgePath: 'x',
      douyinHomeUrl: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
    };

    // 不 catch：Cookie 加载前异常必须让用例失败
    const stubA = makeStubPage({ urlQueue: [FXG_HOME, QC_HOME] });
    const rA = await openQianchuanHome(
      cfg,
      { id: 'shop-a-iso', cookieFile: nameA, accountId: '1710242295996424' },
      { browserFactory: wrapBrowser(stubA) }
    );
    const stubB = makeStubPage({ urlQueue: [FXG_HOME, QC_HOME] });
    const rB = await openQianchuanHome(
      cfg,
      { id: 'shop-b-iso', cookieFile: nameB, accountId: '1710242295996424' },
      { browserFactory: wrapBrowser(stubB) }
    );

    // 1) 两次调用分别解析到各自临时文件
    assert.strictEqual(applied.length, 2, '必须恰好两次 addCookies（店A、店B 各一）');
    pathReads.push(String(rA.cookieSession && rA.cookieSession.filePath || ''));
    pathReads.push(String(rB.cookieSession && rB.cookieSession.filePath || ''));
    assert.ok(pathReads[0].endsWith(`${nameA}.json`), `店A 必须解析到 ${nameA}.json，实际 ${pathReads[0]}`);
    assert.ok(pathReads[1].endsWith(`${nameB}.json`), `店B 必须解析到 ${nameB}.json，实际 ${pathReads[1]}`);
    assert.notStrictEqual(pathReads[0], pathReads[1], '两店 Cookie 文件路径必须不同');

    // 2) addCookies 精确：A→FAKE_A、B→FAKE_B（顺序与归属）
    assert.deepStrictEqual(applied[0].values, [valA], `第 1 次必须且只能是店A假值，实际 ${JSON.stringify(applied[0].values)}`);
    assert.deepStrictEqual(applied[1].values, [valB], `第 2 次必须且只能是店B假值，实际 ${JSON.stringify(applied[1].values)}`);

    // 3) 总次数为 2；每次仅含对应店假值（无混合、无对调）
    assert.strictEqual(applied.filter((x) => x.values.includes(valA)).length, 1, 'FAKE_A 只允许出现一次');
    assert.strictEqual(applied.filter((x) => x.values.includes(valB)).length, 1, 'FAKE_B 只允许出现一次');
    assert.strictEqual(applied[0].values.includes(valB), false, '店A 不得混入店B Cookie');
    assert.strictEqual(applied[1].values.includes(valA), false, '店B 不得混入店A Cookie');
    // 对调必失败：店A 调用不得加载 B 文件路径
    assert.ok(!pathReads[0].endsWith(`${nameB}.json`), '店A 不得解析到店B 文件');
    assert.ok(!pathReads[1].endsWith(`${nameA}.json`), '店B 不得解析到店A 文件');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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

// ── ensureQianchuanAccountView：遮挡再观察时独立识别/关闭唯一已证营销弹窗 ─────
const QC_ACCOUNT_URL = 'https://qianchuan.jinritemai.com/home?aavid=1710242295996424';

function makeAccountViewStub({
  views,
  switchCount = 1,
  closeCount = 1,
  identityCount = 1,
  identityVisible = true,
  onSwitchClick = null,
} = {}) {
  const calls = { closeClicks: 0, switchClicks: 0, businessClicks: 0, evaluates: [] };
  let viewIdx = 0;
  let lastView = null;
  const nextView = () => {
    const v = views[Math.min(viewIdx, views.length - 1)];
    viewIdx += 1;
    lastView = v;
    return v;
  };
  const page = {
    __calls: calls,
    url: () => QC_ACCOUNT_URL,
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => {
      const src = String(fn);
      calls.evaluates.push(src.slice(0, 60));
      if (/扫码登录|loginForm|loginControl/.test(src)) {
        return { loginForm: false, loginControl: false, loginDialog: false };
      }
      if (/切至账户视图/.test(src)) {
        // 关闭快照（click:true）：生产函数在同一次页面执行内重新校验并点击。
        // 这里按同一契约返回 clicked，且不消耗 views 序列。
        if (arg && arg.click === true) {
          const v = lastView || { popup: { present: true, safe: true } };
          const popup = v.popup || { present: false, safe: false };
          if (popup.clickUndefined === true) {
            return undefined;
          }
          if (popup.clickMalformed === true) {
            return { href: QC_ACCOUNT_URL, shopView: false, switchPresent: false, accountContent: false };
          }
          if (popup.clickGone === true) {
            // 两次快照之间弹窗自行消失：生产函数本轮不点任何按钮。
            return {
              href: QC_ACCOUNT_URL,
              shopView: false,
              switchPresent: false,
              accountContent: false,
              popup: { present: false, safe: false, reason: 'none', closeTag: null, clicked: false },
            };
          }
          const ok = popup.present === true && popup.safe === true
            && popup.tagMissing !== true && popup.clickFail !== true && closeCount === 1;
          if (ok) calls.closeClicks += 1;
          return {
            href: QC_ACCOUNT_URL,
            shopView: v.shopView === true,
            switchPresent: v.switchPresent === true,
            accountContent: v.accountContent === true,
            popup: { ...popup, clicked: ok, safe: ok, reason: ok ? 'known-marketing-popup' : 'close-tag-mismatch' },
          };
        }
        const v = nextView();
        const popup = v.popup || { present: false, safe: false };
        // 真实探针在安全判定通过时给唯一关闭按钮打本次尝试标记；stub 同步该契约。
        const closeTag = popup.safe === true && popup.tagMissing !== true && arg && arg.tag ? arg.tag : null;
        return {
          href: QC_ACCOUNT_URL,
          shopView: v.shopView === true,
          switchPresent: v.switchPresent === true,
          accountContent: v.accountContent === true,
          popup: { ...popup, closeTag },
        };
      }
      return null;
    },
    getByText: () => ({
      first() { return this; },
      nth() { return this; },
      count: async () => identityCount,
      isVisible: async () => identityVisible,
      click: async () => { calls.businessClicks += 1; },
      evaluate: async () => '',
    }),
    getByRole: (role, opts = {}) => {
      if (opts && opts.name === '切至账户视图') {
        return {
          count: async () => switchCount,
          isVisible: async () => true,
          click: async () => {
            calls.switchClicks += 1;
            if (typeof onSwitchClick === 'function') return onSwitchClick(calls);
            return null;
          },
        };
      }
      // 登录控件探针：页面不存在扫码登录按钮
      return { count: async () => 0, isVisible: async () => false, click: async () => {} };
    },
    locator: (sel) => ({
      first() { return this; },
      nth() { return this; },
      count: async () => (String(sel).includes('data-qc-popup-close') ? closeCount : 0),
      click: async () => { calls.closeClicks += 1; },
      textContent: async () => '',
    }),
  };
  return { page, calls };
}

const VIEW_OPTS = {
  readinessTimeoutMs: 500,
  readinessIntervalMs: 10,
  // 冻结时钟：收敛只靠 maxAttempts 限次，避免测试机抖动导致提前 break。
  nowFn: () => 0,
  sleep: async () => {},
};

test('ensureQianchuanAccountView：指针遮挡后浮层下仍识别并关闭唯一已证营销弹窗，下一轮再核验身份与切换', async () => {
  const views = [
    { shopView: true, switchPresent: true, popup: { present: false, safe: false } },
    // 浮层遮挡：店铺视图/切换按钮不可见，但唯一结构匹配的安全营销弹窗可见
    { shopView: false, switchPresent: false, popup: { present: true, safe: true } },
    { shopView: true, switchPresent: true, popup: { present: false, safe: false } },
    { shopView: false, switchPresent: false, accountContent: true, popup: { present: false, safe: false } },
  ];
  const { page, calls } = makeAccountViewStub({
    views,
    onSwitchClick: (c) => {
      if (c.switchClicks === 1) {
        const e = new Error('button.click: Timeout 10000ms exceeded: element intercepts pointer events');
        e.name = 'TimeoutError';
        throw e;
      }
    },
  });
  const result = await ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS);
  assert.strictEqual(result.switched, true, '遮挡关闭后恢复店铺视图并成功切换');
  assert.strictEqual(calls.closeClicks, 1, '唯一安全弹窗只关闭一次');
  assert.strictEqual(calls.switchClicks, 2, '首次被遮挡 + 关闭后成功切换（共 2 次）');
  assert.strictEqual(calls.businessClicks, 0, '绝不点击业务按钮（投放乘方/开启货款直投）');
});

test('ensureQianchuanAccountView：遮挡后下一轮仍是不安全弹窗 → DataGuardError 且零业务点击', async () => {
  const views = [
    { shopView: true, switchPresent: true, popup: { present: false, safe: false } },
    // 不唯一/结构不符（例如多个关闭按钮）→ safe=false
    { shopView: false, switchPresent: false, popup: { present: true, safe: false } },
  ];
  const { page, calls } = makeAccountViewStub({
    views,
    onSwitchClick: (c) => {
      if (c.switchClicks === 1) {
        const e = new Error('element intercepts pointer events');
        e.name = 'TimeoutError';
        throw e;
      }
    },
  });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS),
    (err) => err instanceof DataGuardError && /安全判定/.test(err.message)
  );
  assert.strictEqual(calls.closeClicks, 0, '不安全弹窗不点击关闭');
  assert.strictEqual(calls.businessClicks, 0, '零业务点击');
});

// ── 弹窗安全判定：真实页面内探针（VM 执行真实源码，非重写副本）────────────

class PopupNode {
  constructor(tag, attrs = {}, text = '') {
    this.tagName = String(tag).toUpperCase();
    this.attrs = { ...attrs };
    this.className = attrs.class || '';
    this.children = [];
    this.parentElement = null;
    this.ownText = text;
    this.visible = attrs.visible !== false;
    this.clickCount = 0;
    this.classList = { contains: c => String(this.className).split(/\s+/).filter(Boolean).includes(c) };
  }
  get textContent() { return this.ownText + this.children.map(c => c.textContent).join(''); }
  get innerText() { return this.textContent; }
  getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? String(this.attrs[name]) : null; }
  hasAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attrs, name); }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  click() { this.clickCount += 1; }
  appendChild(child) { child.parentElement = this; this.children.push(child); return child; }
  getBoundingClientRect() { return this.visible ? { width: 100, height: 40 } : { width: 0, height: 0 }; }
  contains(node) { return node === this || this.children.some(c => c.contains(node)); }
  querySelectorAll(sel) { return popupQueryAll(this, sel); }
}

function popupMatches(node, compound) {
  const tag = /^([a-zA-Z][\w-]*)/.exec(compound);
  if (tag && node.tagName !== tag[1].toUpperCase()) return false;
  for (const c of compound.match(/\.([\w-]+)/g) || []) {
    if (!node.classList.contains(c.slice(1))) return false;
  }
  const attrRe = /\[([\w-]+)(?:([*^$]?)=)"([^"]*)"\]/g;
  let m;
  while ((m = attrRe.exec(compound))) {
    const actual = node.getAttribute(m[1]);
    if (actual == null) return false;
    if (m[2] === '=' && actual !== m[3]) return false;
    if (m[2] === '*=' && !actual.includes(m[3])) return false;
  }
  return true;
}

function popupQueryAll(root, sel) {
  const selectors = String(sel).split(',').map(s => s.trim()).filter(Boolean);
  const out = [];
  const walk = node => {
    for (const child of node.children) {
      if (selectors.some(s => popupMatches(child, s))) out.push(child);
      walk(child);
    }
  };
  walk(root);
  return out;
}

/** 构造千川营销弹窗/未知对话框的 mock DOM（结构与真实探针选择器一致）。 */
function buildPopupDom(opts = {}) {
  const body = new PopupNode('body');
  const host = opts.inForm ? body.appendChild(new PopupNode('form')) : body;
  // 默认已知根 overall-release-modal-v2-wrap；opts.rootClass === false 表示故意省略。
  let rootHost = host;
  if (opts.rootClass !== false) {
    const rootCls = opts.rootClass === undefined ? 'overall-release-modal-v2-wrap' : opts.rootClass;
    rootHost = host.appendChild(new PopupNode('div', { class: rootCls }));
  }
  const wrap = rootHost.appendChild(new PopupNode('div', opts.dialog ? { role: 'dialog' } : {}));
  const content = wrap.appendChild(new PopupNode('div', { class: 'content' },
    opts.text === undefined ? '智能投放 让好内容更有生命力 了解详情' : opts.text));
  const closes = [];
  const closeCount = opts.closes === undefined ? 1 : opts.closes;
  for (let i = 0; i < closeCount; i += 1) {
    const closeAttrs = {
      class: 'close-button',
      visible: opts.closeVisible !== false,
    };
    if (opts.closeLabel !== null) closeAttrs['aria-label'] = opts.closeLabel === undefined ? '关闭' : opts.closeLabel;
    if (opts.closeType !== null) closeAttrs.type = opts.closeType === undefined ? 'button' : opts.closeType;
    const close = content.appendChild(new PopupNode('button', closeAttrs,
      opts.closeText === undefined ? '×' : opts.closeText));
    if (opts.withIcon !== false) {
      close.appendChild(new PopupNode('iconpark-icon', { name: 'oc-icon-close' }));
    }
    closes.push(close);
  }
  for (const label of (opts.business || ['投放乘方', '开启货款直投'])) {
    content.appendChild(new PopupNode('button', {}, label));
  }
  for (let i = 0; i < (opts.links || 0); i += 1) {
    content.appendChild(new PopupNode('a', { href: '#' }, '了解详情'));
  }
  if (opts.extra) content.appendChild(new PopupNode(opts.extra.tag, opts.extra.attrs || {}, opts.extra.text || ''));
  return { body, wrap, content, closes };
}

function runViewProbe(dom, arg) {
  const ctx = vm.createContext({
    document: {
      body: dom.body,
      querySelectorAll: sel => popupQueryAll(dom.body, sel),
    },
    location: { href: QC_ACCOUNT_URL },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
  });
  return vm.runInContext(`(${readQianchuanAccountViewInPage.toString()})(${JSON.stringify(arg || {})})`, ctx);
}

test('弹窗安全判定：已证营销弹窗（唯一×+两个业务CTA+至多1个链接）→ safe 且打上本次标记', () => {
  const dom = buildPopupDom({ dialog: true, links: 1 });
  const r = runViewProbe(dom, { tag: 'qc-tag-1' });
  assert.strictEqual(r.popup.present, true);
  assert.strictEqual(r.popup.safe, true, r.popup.reason);
  assert.strictEqual(r.popup.closeTag, 'qc-tag-1');
  assert.strictEqual(dom.closes[0].getAttribute('data-qc-popup-close'), 'qc-tag-1', '唯一关闭按钮被打标');
});

test('弹窗安全判定：无链接/无 dialog 的已知结构仍安全（不误杀实测结构）', () => {
  const dom = buildPopupDom({ links: 0, dialog: false });
  const r = runViewProbe(dom, { tag: 'qc-tag-2' });
  assert.strictEqual(r.popup.safe, true, r.popup.reason);
});

test('弹窗安全判定：业务确认框（取消/确定）→ 拒绝且零打标', () => {
  const dom = buildPopupDom({ business: ['取消', '确定'] });
  const r = runViewProbe(dom, { tag: 'qc-tag-3' });
  assert.strictEqual(r.popup.present, true);
  assert.strictEqual(r.popup.safe, false);
  assert.strictEqual(r.popup.reason, 'business-label');
  assert.strictEqual(dom.closes[0].hasAttribute('data-qc-popup-close'), false);
});

test('弹窗安全判定：多关闭按钮/隐藏关闭按钮/关闭按钮无标识 → 一律拒绝', () => {
  const multi = buildPopupDom({ closes: 2 });
  assert.strictEqual(runViewProbe(multi, { tag: 't' }).popup.reason, 'close-not-unique');

  const hidden = buildPopupDom({ closeVisible: false, dialog: true });
  assert.strictEqual(runViewProbe(hidden, { tag: 't' }).popup.reason, 'close-not-visible-unique');

  const blank = buildPopupDom({ closeText: '', closeLabel: '' });
  assert.strictEqual(runViewProbe(blank, { tag: 't' }).popup.reason, 'close-aria');

  const emptyAriaWithX = buildPopupDom({ closeText: '×', closeLabel: '' });
  assert.strictEqual(runViewProbe(emptyAriaWithX, { tag: 't' }).popup.reason, 'close-aria',
    '空 aria-label 即使有 × 也不安全');

  const textOnlyWord = buildPopupDom({ closeText: '关闭', closeLabel: '' });
  assert.strictEqual(runViewProbe(textOnlyWord, { tag: 't' }).popup.reason, 'close-aria');
});

test('弹窗安全判定：危险文本/额外控件/表单内关闭/第三个业务按钮 → 一律拒绝', () => {
  const danger = buildPopupDom({ text: '确认删除这 30 条计划？删除后不可恢复' });
  assert.strictEqual(runViewProbe(danger, { tag: 't' }).popup.reason, 'danger-text');

  const input = buildPopupDom({ extra: { tag: 'input', attrs: { type: 'text' } } });
  assert.strictEqual(runViewProbe(input, { tag: 't' }).popup.reason, 'unexpected-controls');

  const inForm = buildPopupDom({ inForm: true });
  assert.strictEqual(runViewProbe(inForm, { tag: 't' }).popup.reason, 'close-inside-form');

  const three = buildPopupDom({ business: ['投放乘方', '开启货款直投', '立即投放'] });
  assert.strictEqual(runViewProbe(three, { tag: 't' }).popup.reason, 'business-count');
});

test('弹窗安全判定：外部对话框不含该关闭按钮 / 缺本次标记 → 拒绝', () => {
  const dom = buildPopupDom({ dialog: true });
  const stray = dom.body.appendChild(new PopupNode('div', { role: 'dialog' }, '另一个对话框'));
  assert.ok(stray);
  assert.strictEqual(runViewProbe(dom, { tag: 't' }).popup.reason, 'dialog-not-owning-close');

  const ok = buildPopupDom({ dialog: true });
  assert.strictEqual(runViewProbe(ok, {}).popup.reason, 'close-tag-missing', '没有本次标记不得判安全');
});

test('弹窗安全判定：缺已知根/缺 type=button/缺 oc-icon-close → 一律拒绝', () => {

  const noRoot = buildPopupDom({ rootClass: false, dialog: true });

  assert.strictEqual(runViewProbe(noRoot, { tag: 't' }).popup.reason, 'root-not-known');



  const wrongRoot = buildPopupDom({ rootClass: 'random-modal-wrap', dialog: true });

  assert.strictEqual(runViewProbe(wrongRoot, { tag: 't' }).popup.reason, 'root-not-known');



  const noType = buildPopupDom({ closeType: null, dialog: true });

  assert.strictEqual(runViewProbe(noType, { tag: 't' }).popup.reason, 'close-type');



  const noIcon = buildPopupDom({ withIcon: false, dialog: true });

  assert.strictEqual(runViewProbe(noIcon, { tag: 't' }).popup.reason, 'close-icon');

});

// ── 弹窗原子关闭：判定与点击必须在同一次页面执行内（复核阻断项）────────────

test('弹窗原子关闭：同一次执行内复核并点击唯一已证关闭按钮，点击后移除标记', () => {
  const dom = buildPopupDom({ dialog: true });
  const observed = runViewProbe(dom, { tag: 'qc-tag-click' });
  assert.strictEqual(observed.popup.safe, true, observed.popup.reason);
  assert.strictEqual(dom.closes[0].getAttribute('data-qc-popup-close'), 'qc-tag-click', '观察快照打标');

  const closed = runViewProbe(dom, { tag: 'qc-tag-click', click: true });
  assert.strictEqual(closed.popup.clicked, true, closed.popup.reason);
  assert.strictEqual(dom.closes[0].clickCount, 1, '只点击一次');
  assert.strictEqual(dom.closes[0].hasAttribute('data-qc-popup-close'), false, '点击后移除标记');
});

test('弹窗原子关闭：节点被复用改写为业务按钮（标记仍在）→ 零点击', () => {
  const dom = buildPopupDom({ dialog: true });
  runViewProbe(dom, { tag: 'qc-tag-reuse' });
  // 节点被改写成业务 CTA：去掉关闭 aria/图标，标记仍在 → 不得点击。
  dom.closes[0].ownText = '确认投放';
  dom.closes[0].removeAttribute('aria-label');
  dom.closes[0].children = [];
  const r = runViewProbe(dom, { tag: 'qc-tag-reuse', click: true });
  assert.strictEqual(r.popup.safe, false);
  assert.strictEqual(r.popup.reason, 'close-aria');
  assert.strictEqual(r.popup.clicked, false);
  assert.strictEqual(dom.closes[0].clickCount, 0, '零点击');
});

test('弹窗原子关闭：标记在两次快照之间丢失（重渲染）→ 零点击', () => {
  const dom = buildPopupDom({ dialog: true });
  runViewProbe(dom, { tag: 'qc-tag-gone' });
  dom.closes[0].removeAttribute('data-qc-popup-close');
  const r = runViewProbe(dom, { tag: 'qc-tag-gone', click: true });
  assert.strictEqual(r.popup.reason, 'close-tag-mismatch');
  assert.strictEqual(r.popup.clicked, false);
  assert.strictEqual(dom.closes[0].clickCount, 0);
});

test('弹窗原子关闭：点击快照内结构变危险（多出第三个业务按钮）→ 零点击', () => {
  const dom = buildPopupDom({ dialog: true });
  runViewProbe(dom, { tag: 'qc-tag-drift' });
  dom.content.appendChild(new PopupNode('button', {}, '立即投放'));
  const r = runViewProbe(dom, { tag: 'qc-tag-drift', click: true });
  assert.strictEqual(r.popup.reason, 'business-count');
  assert.strictEqual(r.popup.clicked, false);
  assert.strictEqual(dom.closes[0].clickCount, 0);
});

// ── 弹窗安全接线：判定/点击同节点、先于店铺视图、账户视图也必须处理 ──────────

test('简尚：浮窗先于店铺视图出现 → 先关闭已证弹窗再继续（不再空等到超时）', async () => {
  const views = [
    { shopView: false, switchPresent: false, popup: { present: true, safe: true } },
    { shopView: true, switchPresent: true, popup: { present: false, safe: false } },
    { shopView: false, switchPresent: false, accountContent: true, popup: { present: false, safe: false } },
  ];
  const { page, calls } = makeAccountViewStub({ views });
  const result = await ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS);
  assert.strictEqual(result.switched, true);
  assert.strictEqual(calls.closeClicks, 1, '浮窗在店铺视图渲染前即被关闭');
  assert.strictEqual(calls.switchClicks, 1);
  assert.strictEqual(calls.businessClicks, 0);
});

test('账户视图出现未知弹窗 → 失败，不得直接返回成功（零业务点击）', async () => {
  const views = [
    { shopView: false, switchPresent: false, accountContent: true, popup: { present: true, safe: false } },
  ];
  const { page, calls } = makeAccountViewStub({ views });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS),
    err => err instanceof DataGuardError && /安全判定/.test(err.message)
  );
  assert.strictEqual(calls.closeClicks, 0);
  assert.strictEqual(calls.businessClicks, 0);
});

test('原子关闭快照复核不通过（节点已不可证）→ 零点击失败，绝不退回结构选择器点击', async () => {
  const views = [{ shopView: true, switchPresent: true, popup: { present: true, safe: true } }];
  const { page, calls } = makeAccountViewStub({ views, closeCount: 0 });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS),
    err => err instanceof DataGuardError && /关闭未执行/.test(err.message)
  );
  assert.strictEqual(calls.closeClicks, 0, '零关闭点击');
  assert.strictEqual(calls.switchClicks, 0, '弹窗未关闭绝不切换');
  assert.strictEqual(calls.businessClicks, 0);
});

test('关闭快照发现弹窗已自行消失 → 本轮零点击，下一轮重新观察后继续', async () => {
  const views = [
    { shopView: false, switchPresent: false, popup: { present: true, safe: true, clickGone: true } },
    { shopView: true, switchPresent: true, popup: { present: false, safe: false } },
    { shopView: false, switchPresent: false, accountContent: true, popup: { present: false, safe: false } },
  ];
  const { page, calls } = makeAccountViewStub({ views });
  const result = await ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS);
  assert.strictEqual(result.switched, true);
  assert.strictEqual(calls.closeClicks, 0, '自行消失时不得再点关闭');
  assert.strictEqual(calls.switchClicks, 1);
  assert.strictEqual(calls.businessClicks, 0);
});

test('判定通过但缺本次标记 → 零点击失败（不接受“结构像”就点）', async () => {
  const views = [{ shopView: true, switchPresent: true, popup: { present: true, safe: true, tagMissing: true } }];
  const { page, calls } = makeAccountViewStub({ views });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS),
    err => err instanceof DataGuardError && /安全判定/.test(err.message)
  );
  assert.strictEqual(calls.closeClicks, 0);
});

test('关闭后同一弹窗仍在 → 立即失败，不二次关闭', async () => {
  const views = [
    { shopView: true, switchPresent: true, popup: { present: true, safe: true } },
    { shopView: true, switchPresent: true, popup: { present: true, safe: true } },
  ];
  const { page, calls } = makeAccountViewStub({ views });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS),
    err => err instanceof DataGuardError && /关闭后仍存在/.test(err.message)
  );
  assert.strictEqual(calls.closeClicks, 1, '只关闭一次');
  assert.strictEqual(calls.switchClicks, 0, '弹窗未消失绝不切换');
});

test('残留已知根（关闭钮与 dialog 皆无）→ present 仍为 true，不得判消失', () => {
  const dom = buildPopupDom({ dialog: false, closes: 0 });
  const r = runViewProbe(dom, { tag: 't' });
  assert.strictEqual(r.popup.present, true, 'known-root 残留必须算仍在');
  assert.strictEqual(r.popup.safe, false);
});

test('关闭 evaluate 返回 undefined → fail-closed，不得当自行消失', async () => {
  const views = [{ shopView: true, switchPresent: true, popup: { present: true, safe: true, clickUndefined: true } }];
  const { page, calls } = makeAccountViewStub({ views });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS),
    err => err instanceof DataGuardError && /关闭结果异常/.test(err.message)
  );
  assert.strictEqual(calls.closeClicks, 0);
  assert.strictEqual(calls.switchClicks, 0);
  assert.strictEqual(calls.businessClicks, 0);
});

test('关闭 evaluate 返回畸形（无 popup）→ fail-closed', async () => {
  const views = [{ shopView: true, switchPresent: true, popup: { present: true, safe: true, clickMalformed: true } }];
  const { page, calls } = makeAccountViewStub({ views });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, { name: '简尚衣橱优品店' }, VIEW_OPTS),
    err => err instanceof DataGuardError && /关闭结果异常/.test(err.message)
  );
  assert.strictEqual(calls.closeClicks, 0);
  assert.strictEqual(calls.switchClicks, 0);
});

test('空店名 + accountContent=true → 缺少目标店铺名，不得成功返回', async () => {
  const views = [
    { shopView: false, switchPresent: false, accountContent: true, popup: { present: false, safe: false } },
  ];
  const { page, calls } = makeAccountViewStub({ views });
  await assert.rejects(
    () => ensureQianchuanAccountView(page, { name: '' }, VIEW_OPTS),
    err => err instanceof DataGuardError && /缺少目标店铺名/.test(err.message)
  );
  assert.strictEqual(calls.switchClicks, 0);
  assert.strictEqual(calls.businessClicks, 0);
});
