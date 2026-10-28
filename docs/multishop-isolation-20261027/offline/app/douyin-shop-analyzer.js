/**
 * 抖店电商罗盘数据采集脚本
 * 功能：登录抖店 -> 采集商品数据 -> 获取成交订单数 -> 进入详情页获取真实退货率 -> 写入飞书表格
 * 支持Cookie持久化，避免重复扫码
 */

const { chromium } = require('playwright');
const fs = require('fs');
const { buildWritebackFields, avgProfitPerOrder: computeAvgProfitPerOrder, suggestionGate } = require('./isolation-runtime/writebackFields');
const { applyStaleInvalidation, createLedgerRequest, ensureLedgerPath } = require('./isolation-runtime/staleInvalidation');
const path = require('path');
// AD-AUTO-PLAN-REPAIR-20261012-S75：分析器会话保存链（扫码/复用登录统一检查点 + 加载前指纹 CAS）
// AD-COOKIE-FOUR-TIER-20261019-F1：分析工作副本检查点写回（用户重新授权）+ 恢复链适配。
// 仅写分析工作副本；原始归档/推广目录保持只读（assertAnalyzerWorkTarget 程序层拒绝）。
const { fingerprintOf } = require('./login-session-persistence');
const cookieVault = require('./cookie-vault');
const {
  restoreAnalysisWorkCopy, assertAnalyzerWorkTarget,
} = require('./analyzer-cookie-workcopy');
const { saveAnalyzerSessionCheckpoint, saveAnalyzerCompassCheckpoint } = require('./analyzer-session-checkpoint');

const COOKIES_DIR = path.join(__dirname, 'cookies');

// 费用配置（从UI传入）
let SHIPPING_FEE = 2.4;
let INSURANCE = 4.01;

/**
 * 计算最低建议毛利率（百分比）
 * 
 * 模型假设：
 *   avgProfit = P × (1 - R_total) × 0.994 - cost - fixedCost - adCostPerOrder
 *   目标：avgProfit / cost ≥ target
 *   → P ≥ [cost×target + cost×0.006×(1-R_total) + fixedCost×(1-R_total+R_post) + adCostPerOrder] / [0.994×(1-R_total) - target]
 * 
 * @param {number} cost          - 商品成本（元），需 > 0
 * @param {number} totalRefundRate  - 总退款率（%），0~100
 * @param {number} postShipRefundRate - 发货后退款率（%），0~100
 * @param {number} adCostPerOrder  - 每单广告费（元），默认 0
 * @param {number} targetPercent   - 目标毛利率（%），默认 3
 * @returns {number} 建议毛利率（百分比）
 */
function calcMinGross(cost, totalRefundRate, postShipRefundRate, adCostPerOrder = 0, targetPercent = 3) {
    // ========== 1. 边界条件：cost <= 0 ==========
    if (cost <= 0) {
        return 0; // 成本无效时返回 0，避免除零和负数
    }

    // ========== 2. 退款率输入clamp到[0, 0.90] ==========
    //    原因：90%以上退款率在实际业务中不可能出现，
    //    且96.98%时分母为0，导致结果爆炸到Infinity
    const MAX_REFUND_RATE = 0.90;
    let R_total = totalRefundRate / 100;
    let R_post = postShipRefundRate / 100;
    
    R_total = Math.max(0, Math.min(R_total, MAX_REFUND_RATE));
    R_post = Math.max(0, Math.min(R_post, MAX_REFUND_RATE));
    
    // 额外安全：确保R_post不超过R_total
    R_post = Math.min(R_post, R_total);

    // ========== 3. 常量定义 ==========
    const fixedCost = SHIPPING_FEE + INSURANCE;  // 6.41
    const target = targetPercent / 100;

    // ========== 4. 分子计算（与模型注释一致） ==========
    //    修正点：广告费项改为 adCostPerOrder（每单都扣），
    //    而非 adCostPerOrder * (1 - R_total)
    const num = cost * target 
              + cost * 0.006 * (1 - R_total) 
              + fixedCost * (1 - R_total + R_post) 
              + adCostPerOrder;

    // ========== 5. 分母计算 ==========
    const den = 0.994 * (1 - R_total) - target;

    // ========== 6. 分母非正处理 ==========
    //    当 den <= 0 时，公式无解（即无论定价多高都无法达到目标）
    //    返回一个安全的极大值，而非 Infinity
    if (den <= 0) {
        return 999; // 合理上限：999% 意味着"无法盈利"
    }

    // ========== 7. 正常计算 ==========
    const result = num / den;

    // ========== 8. 输出封顶 ==========
    //    取 max(3*cost, 200) 作为封顶值
    //    防止极端输入产生不合理建议（如几千%的毛利率）
    const ceiling = Math.max(3 * cost, 200);
    return Math.min(result, ceiling);
}

const CONFIG = {
  feishu: {
    // 认证秘密由 feishu-env 注入（env / feishu.local.json），fail-closed
    app_id: '',
    app_secret: '',
    table_id: 'tbl7PuVUnnFJJeBM',
    app_token: 'CfAXbSrUFaBLv3stSRrcuUVon1b',
    tbl3_table: 'tblDCMOWzHqq2VtS'
  },
  douyin: {
    loginUrl: 'https://fxg.jinritemai.com/ffa/mshop/homepage/index',
    productListUrl: 'https://compass.jinritemai.com/shop/commodity/product-list',
    productManageUrl: 'https://fxg.jinritemai.com/ffa/g/list',
    orderListUrl: 'https://fxg.jinritemai.com/ffa/morder/order/list'
  },
  cookiePath: path.join(__dirname, 'douyin-cookies.json'),
  // Date range: 40 days ago to 10 days ago
  dateRange: {
    get startDate() {
      const d = new Date();
      d.setDate(d.getDate() - 40);
      return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    },
    get endDate() {
      const d = new Date();
      d.setDate(d.getDate() - 10);
      return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
    }
  }
};

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function fmtErr(e) {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split('\n')[0];
}

// 暂停标志文件路径（与 server.js 的 /pause-shop 接口约定，存在=暂停中）
const PAUSE_FLAG_FILE = path.join(__dirname, 'pause_flag.txt');
// 本次分析进程的启动时刻。用于判别 pause_flag 是否上一次运行残留：
// 旧规则"flag 写入超 60 秒即视为残留"会把用户正常的长时间暂停误杀成自动继续
// （点「暂停」后超过 60 秒才走到检查点，暂停就被忽略），2026-08-28 改为与进程启动时刻比较。
const PROCESS_STARTED_AT = Date.now();
function pauseFlagIsStale() {
  try {
    if (!fs.existsSync(PAUSE_FLAG_FILE)) return true;
    const ts = Number(fs.readFileSync(PAUSE_FLAG_FILE, 'utf8').trim());
    if (!Number.isFinite(ts)) return true;
    return ts < PROCESS_STARTED_AT; // flag 写入早于本次进程启动 = 跨次残留，忽略
  } catch (e) { return true; }
}
function clearPauseFlag() {
  try { fs.unlinkSync(PAUSE_FLAG_FILE); } catch (e) {}
}

// 检查暂停标志：暂停时循环等待（浏览器保持打开），直到前端点「继续」删除标志文件。
// 【操作逻辑备注】
//   「停止」按钮 = 服务端 taskkill 直接终止本进程树（走不到本函数，浏览器一并关闭）；
//   「暂停/继续」按钮 = 服务端写/删 pause_flag.txt。暂停一旦在本进程运行期间生效，
//   就无限期等待、没有超时；入口的 pauseFlagIsStale 只负责丢弃上一次运行残留的旧 flag。
// （2026-08-28 移除旧的 debug_stop_flag"调试停留"机制：旧「停止」按钮可视模式只写 flag 停在
//   下一个检查点导致"点了停止还在跑"，且 flag 无过期机制、跨次残留会卡死下一次运行。）
async function waitIfPaused() {
  if (pauseFlagIsStale()) { clearPauseFlag(); return; }
  console.log('已暂停：浏览器保持打开，等待「继续」...');
  while (fs.existsSync(PAUSE_FLAG_FILE)) {
    await sleep(2000);
  }
  console.log('收到「继续」，恢复执行。');
}

// 可打断睡眠：把长等待切成 1 秒片段，每段前先检查暂停标志。
// 【为什么要它】「暂停」是标记文件机制，只有跑到 waitIfPaused() 检查点才生效；
// 原先两个检查点之间隔着详情页 15 秒、tab 加载 15 秒等长等待，点暂停后日志还会刷一两分钟，
// 用户以为暂停失灵（2026-08-28 反馈）。所有 ≥3 秒的等待都必须用 pausableSleep，
// 这样点「暂停」后约 1 秒内冻结（阻塞在本函数里，浏览器保持打开），点「继续」后睡完剩余时长。
// ⚠️ 注意：本函数内部只能用 sleep，不能调 pausableSleep（会无限递归）；
//         waitIfPaused 里的 sleep(2000) 同理保持原样。
async function pausableSleep(ms) {
  const SEGMENT = 1000;
  let remaining = ms;
  while (remaining > 0) {
    await waitIfPaused();
    const seg = Math.min(SEGMENT, remaining);
    await sleep(seg);
    remaining -= seg;
  }
  await waitIfPaused();
}

async function getShopNameFromPage(page) {
  return await page.evaluate(() => {
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      const text = el.innerText?.trim();
      const rect = el.getBoundingClientRect();
      if (text && (text.includes('瑾') || text.includes('瑮')) && text.length > 2 && text.length < 15 &&
          rect.left > 1500 && rect.top > 150 && rect.top < 200 && rect.width > 0 && rect.height > 0) {
        let result = text.split('\n')[0].trim();
        result = result.replace(/瑮/g, '瑾');
        return result;
      }
    }
    return '';
  });
}

// 诊断 DOM dump：收集页面所有可见输入框（light + shadow DOM），不再用 y=500-700 范围过滤。
// 输出 JSON 字段：top/left/width/height/placeholder/name/id/class/aria-*/label/container。
async function collectInputCandidates(page) {
  const candidates = await page.evaluate(() => {
    // 深度遍历 light + shadow DOM
    function deepAll(root, out) {
      out = out || [];
      for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) deepAll(el.shadowRoot, out); }
      return out;
    }
    const all = deepAll(document);
    const inputs = all.filter(el => el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');
    const result = [];
    inputs.forEach((inp, i) => {
      const rect = inp.getBoundingClientRect();
      // 收集所有 aria-* 属性
      const aria = {};
      for (const attr of inp.getAttributeNames()) {
        if (attr.startsWith('aria-')) aria[attr] = inp.getAttribute(attr);
      }
      // 标签：先找 label[for]，再找最近祖先 label
      let label = '';
      if (inp.id) {
        try {
          const lab = document.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
          if (lab) label = (lab.innerText || '').trim();
        } catch (_) { /* CSS.escape 在极端 id 下可能抛错，忽略 */ }
      }
      if (!label) {
        const ancestorLabel = inp.closest('label');
        if (ancestorLabel) label = (ancestorLabel.innerText || '').trim();
      }
      // 容器：最近的带 class 的祖先
      let containerClass = '';
      let containerText = '';
      const container = inp.closest('[class]') || inp.parentElement;
      if (container) {
        containerClass = container.className && container.className.toString ? container.className.toString() : '';
        containerText = (container.innerText || '').trim().slice(0, 120);
      }
      result.push({
        index: i,
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        placeholder: inp.placeholder || '',
        name: inp.name || '',
        id: inp.id || '',
        class: inp.className && inp.className.toString ? inp.className.toString() : '',
        aria,
        label,
        container: { class: containerClass, text: containerText }
      });
    });
    return result;
  });
  const outPath = path.join(evidenceDir(), 'input-candidates.json');
  fs.writeFileSync(outPath, JSON.stringify(candidates, null, 2));
  return { count: candidates.length, path: outPath, candidates };
}

// 证据/诊断输出目录：默认仍是脚本所在目录（生产行为不变）；隔离验证时用环境变量把输出
// 重定向到桌面证据目录，避免离线或只读验证覆写仓库里的 input-candidates.json 与既有 evidence-*（OD1补修）。
function evidenceDir() {
  const d = String(process.env.DOUYIN_EVIDENCE_DIR || '').trim();
  if (!d) return __dirname;
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}

// 证据 dump：定位歧义时保存页面 HTML 快照 + 输入框候选 JSON，供事后排查。
// tag 会写入文件名以区分来源（如 order-product-id）。
async function dumpEvidence(page, tag) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(evidenceDir(), `evidence-${tag || 'unknown'}-${stamp}`);
    const html = await page.content();
    fs.writeFileSync(base + '.html', html);
    const cand = await collectInputCandidates(page);
    try { fs.copyFileSync(cand.path, base + '-candidates.json'); } catch (_) {}
    console.log(`  [dumpEvidence] 已保存证据: ${base}.html (+candidates)`);
    return base;
  } catch (e) {
    console.log('  [dumpEvidence] 保存证据失败:', fmtErr(e));
    return null;
  }
}

// 定位「商品名称/ID」输入框（容器唯一性校验 + 弹层展开）。
// 【操作逻辑备注（2026-08-28 修复「输入值校验失败 actual=''」后更新，改动前先读完本段）】
// 【操作逻辑备注（2026-08-29 修复「第二个商品 elementHandle.click 超时」后更新，改动前先读完本段）】
// ⚠️ 关键认知：订单页「商品名称/ID」是 Aurora 多选 Select，页面上可见的那个窄输入框只是
//   trigger（aurora-select-input，readonly 语义），对它打字不会生效（值恒为空）！
//   真正接收文字的是展开弹层后的 input.aurora-select-popup-search-input
//   （placeholder="请输入商品名称/ID/商家编码"），它经 portal 挂在 body 下、字段容器外；
//   弹层未展开时它宽高为 0（诊断证据 evidence-main-search-*-candidates.json 里可见 0x0 记录）。
// ⚠️ 跨商品复用 orderPage 时（自动化循环里）有两层超时风险，必须两层都修：
//   1. grabPopup() 返回的 ElementHandle 会被 React 重建为 detached → fillAndSearchOrderProductId
//      第 538 行 click 5s 超时报「商品ID键入异常」。修复：弹层搜索框改返回 Locator。
//   2. 即使改用 Locator，Aurora Select 弹层打开有 fade-in+位移动画，Locator 默认 actionability
//      检查（visible→stable→receives events）仍可能在第二个商品时偶发判为不稳定超时。
//      修复：调用方 click 传 force:true 跳过 stable 判定（selector 已唯一、视觉可见，force 安全）。
// 流程：collectInputCandidates 收集诊断快照 → 按「商品名称/ID」标签+aurora-label-wrapper 定位
//   字段根 → 字段根内可见 input 候选数必须恰为 1（即 trigger）→
//   ① 清掉上次商品遗留的已选标签（×按钮，订单页字段跨商品复用，不清会叠加过滤条件）→
//      等弹层动画/重建稳定后再进 ②（防 grabPopup 抓到「打开中」的瞬时节点）→
//   ② 点击 trigger 展开弹层前 isConnected 校验，防 detached trigger 点击 →
//   ③ 弹层搜索框改返回 Locator（Locator 可用于 click/evaluate，每次重解析）。
// 任一步失败都调用 dumpEvidence 保存证据并返回 ok:false（调用方应跳过该商品）。
// 成功时返回 { ok:true, input }（弹层搜索框）；失败时返回 { ok:false, reason, candidates }。
// 【下次再报「输入值校验失败 actual=''」的排查顺序】
//   1. 看最新 evidence-main-search-*-candidates.json：aurora-select-popup-search-input 那条
//      若 width/height=0 → 弹层没展开（本函数②步失效，检查 trigger 点击）；
//   2. 若宽高正常但仍打不进 → 组件又改版，对照 dump 出的 class/placeholder 更新下方选择器；
//   3. 报「已选标签未清空」→ × 按钮 class 改名（.aurora-select-selection-item-remove），更新选择器。
// 【OD1 改版记录（2026-10-01，现场取证后新增；改动前先读完本段）】
//   现网证据：bill-manager/evidence-main-search-3841132576081313957-2026-10-01T02-07-20-541Z.html
//            ＋ -candidates.json（49 项可见候选）＋ 本机独立浏览器只读探针
//            Desktop/OD1_order_product_search_fix/probe-order-filter-dom.json、
//            probe-option-structure.json、probe-selection-structure.json、probe-selection-structure2.json
//   1. 订单页「商品名称/ID」已改版为字段内 in-field combobox：
//      input.aurora-select-input[role="combobox"][aria-expanded]（readonly=false，宽 4→键入后 160），
//      占位文案改由 div.aurora-select-placeholder 承载，不再是任何 input 的 placeholder。
//   2. 旧 portal 搜索框 input.aurora-select-popup-search-input 在现网 DOM 中出现次数=0
//      （12 处命中全部位于 <style> 规则里；HTML 中 placeholder="请输入商品名称/ID/商家编码" 的 input=0）。
//      ⇒ 原「点 trigger → 等该搜索框可见」的判定在任何时刻都不可能成立，这就是本次故障直接根因。
//   3. 单独点击该 combobox 不再展开下拉（探针：连点 2 次后 aria-expanded 仍 false、listbox=0）；
//      真正展开的是「聚焦 + 键入」：键入 19 位商品 ID 后 aria-expanded=true、dropdown 出现、建议项=1（约 0.7s）。
//      ⇒ 本函数不再执行「点 trigger 等弹层」，改为返回可重解析的 combobox Locator，
//        展开由调用方「聚焦→清空→键入」自然完成；已展开时不得再点击（探针：已展开时再点会收起并清空键入值）。
//   4. 建议项根节点仍是 .aurora-select-item-option（无 role 属性）；隐藏的空 [role="option"] 只是无障碍代理节点，
//      不含文本 ⇒ 选中 ID 不能再用「[role=option][aria-selected=true] 且整串是数字」读取（改版后恒返回 []，
//      会把已选中的商品误判成「选中值校验失败」）。改读 .aurora-select-item-option-selected 文本里的 ID:<数字>，
//      并叠加字段内已选标签计数（.aurora-select-selection-item-remove 个数）做“只剩一个商品”的防串校验。
//   5. 兼容旧结构：若 portal 搜索框确实存在且唯一可见（店铺回滚/灰度），仍走旧路径，行为不变。
const ORDER_PRODUCT_LABEL_TEXT = '商品名称/ID';
const ORDER_PRODUCT_TARGET_PLACEHOLDER = '请输入商品名称/ID/商家编码';
const LEGACY_ORDER_PRODUCT_POPUP_SELECTOR =
  `input.aurora-select-popup-search-input[placeholder="${ORDER_PRODUCT_TARGET_PLACEHOLDER}"]`;

/** 商品名称/ID 字段容器（Locator 每次重解析，React 重建后仍可用；证据：现网该组合候选数=1）。 */
function orderProductFieldLocator(page) {
  return page.locator('.aurora-label-wrapper')
    .filter({ has: page.getByText(ORDER_PRODUCT_LABEL_TEXT, { exact: true }) });
}

async function findOrderProductIdInput(page) {
  // 1) 诊断快照（light + shadow DOM 所有可见输入框）
  await collectInputCandidates(page);
  // 2) 页面内定位唯一候选；返回 [inputElement|null, meta]
  const resultHandle = await page.evaluateHandle(() => {
    function deepAll(root, out) {
      out = out || [];
      for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) deepAll(el.shadowRoot, out); }
      return out;
    }
    const all = deepAll(document);
    // 找文本为「商品名称/ID」的标签（先精确叶子，再退化为任意）
    const label = all.find(el => (el.innerText || '').trim() === '商品名称/ID' && el.children.length === 0)
               || all.find(el => (el.innerText || '').trim() === '商品名称/ID');
    if (!label) return [null, { ok: false, reason: '未找到商品名称/ID标签', candidates: 0 }];
    // 断言祖先含 aurora-label-wrapper（最多向上 8 层）
    let wrapper = label;
    for (let i = 0; i < 8 && wrapper; i++) {
      if (String(wrapper.className || '').includes('aurora-label-wrapper')) break;
      wrapper = wrapper.parentElement;
    }
    if (!wrapper || !String(wrapper.className || '').includes('aurora-label-wrapper')) {
      return [null, { ok: false, reason: '标签祖先未找到 aurora-label-wrapper', candidates: 0 }];
    }
    // 字段根：aurora-label-wrapper 的父元素，即整个字段容器；输入框需在字段根内，
    // 且与标签存在 aria-labelledby / label[for] / 字段根兄弟 关系才算属于该字段。
    const fieldRoot = wrapper.parentElement || wrapper;
    const visibleInputs = Array.from(fieldRoot.querySelectorAll('input')).filter(inp => {
      const r = inp.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const related = visibleInputs.filter(inp => {
      // aria-labelledby 指向「商品名称/ID」标签
      const labelledby = inp.getAttribute('aria-labelledby');
      if (labelledby) {
        const ids = labelledby.trim().split(/\s+/);
        const hit = ids.some(id => {
          const t = document.getElementById(id);
          return t && (t.innerText || '').trim() === '商品名称/ID';
        });
        if (hit) return true;
      }
      // label[for] 指向该 input 且文本为「商品名称/ID」
      if (inp.id) {
        try {
          const lab = document.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
          if (lab && (lab.innerText || '').trim() === '商品名称/ID') return true;
        } catch (_) { /* CSS.escape 极端 id 可能抛错，忽略 */ }
      }
      // 字段根内兄弟关系兜底：与标签同处字段根即视为属于该字段
      return true;
    });
    if (related.length !== 1) {
      return [null, { ok: false, reason: `商品名称/ID字段内可见输入框候选数=${related.length}（应为1）`, candidates: related.length }];
    }
    return [related[0], { ok: true, candidates: 1 }];
  });
  // 解包 [inputElement, meta]
  const metaHandle = await resultHandle.getProperty('1');
  const meta = metaHandle ? await metaHandle.jsonValue() : null;
  const inputHandle = await resultHandle.getProperty('0');
  if (metaHandle) await metaHandle.dispose();
  if (!meta || !meta.ok) {
    if (inputHandle) await inputHandle.dispose();
    await resultHandle.dispose();
    await dumpEvidence(page, 'order-product-id');
    return { ok: false, reason: meta ? meta.reason : '未知', candidates: meta ? meta.candidates : 0 };
  }
  const element = inputHandle.asElement();
  await resultHandle.dispose();
  if (!element) {
    await dumpEvidence(page, 'order-product-id');
    return { ok: false, reason: '唯一候选输入框不是有效元素', candidates: 1 };
  }

  // ① 清掉上次商品遗留的已选标签（订单页字段跨商品复用）：逐个点 × 直到清空
  // ⚠️ 只清 trigger 上显示的 × 标签不够：弹层搜索框 input.value 也会残留上次键入的字符，
  //    这些字符不在 trigger 上以标签形式显示，selection-item-remove 抓不到。
  //    残留的字符不会自动清空，下一个商品键入时会拼接成「旧pid+新pid」（2026-08-29 修复）。
  try {
    await element.evaluate(async (inp) => {
      const wait = (ms) => new Promise(r => setTimeout(r, ms));
      let wrapper = inp;
      for (let k = 0; k < 8 && wrapper; k++) {
        if (String(wrapper.className || '').includes('aurora-label-wrapper')) break;
        wrapper = wrapper.parentElement;
      }
      const fieldRoot = (wrapper && wrapper.parentElement) || inp.parentElement;
      if (!fieldRoot) return 0;
      let removed = 0;
      for (let k = 0; k < 10; k++) {
        const removes = Array.from(fieldRoot.querySelectorAll('.aurora-select-selection-item-remove'))
          .filter(x => x.getBoundingClientRect().width > 0);
        if (removes.length === 0) break;
        removes[0].click();
        removed++;
        await wait(60);
      }
      // 清掉搜索框里残留的键入字符：旧结构是 portal 弹层搜索框，新结构（OD1 2026-10-01）是字段内 combobox。
      // 两处都试：存在哪个清哪个；都不存在就是纯 trigger（旧旧版本），跳过不影响。
      // ⚠️ 本函数体会被序列化到页面上下文执行，不能引用 Node 侧常量，占位文案在此内联为字面量。
      const searchBoxes = [
        ...Array.from(document.querySelectorAll('input.aurora-select-popup-search-input'))
          .filter(i => (i.placeholder || '') === '请输入商品名称/ID/商家编码'),
        ...Array.from(fieldRoot.querySelectorAll('input[role="combobox"]')),
      ];
      const seen = new Set();
      for (const box of searchBoxes) {
        if (seen.has(box) || !box.value) continue;
        seen.add(box);
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(box, '');
        box.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return removed;
    });
    await sleep(300);
  } catch (e) {
    console.log('[WARN] 清理商品字段已选标签失败（继续）:', fmtErr(e));
  }

  // ② OD1（2026-10-01）：确定「真正能接收键入的搜索框」，本函数不再点击展开。
  //    现网取证：单独点击字段不会展开下拉（连点 2 次 aria-expanded 仍 false、listbox=0），
  //    展开由调用方「聚焦→清空→键入」自然完成；在这里点击只会把已展开的下拉收起并清空键入值。
  //    旧结构（portal 弹层搜索框）如仍存在且唯一可见，则按原行为返回该搜索框。
  const legacyPopup = page.locator(LEGACY_ORDER_PRODUCT_POPUP_SELECTOR);
  const legacyTotal = await legacyPopup.count().catch(() => 0);
  const legacyVisible = await legacyPopup.filter({ visible: true }).count().catch(() => 0);
  const soleRole = await element.getAttribute('role').catch(() => null);
  const soleId = await element.evaluate(el => el.id || '').catch(() => '');
  if (legacyVisible > 1) {
    await element.dispose().catch(() => {});
    await dumpEvidence(page, 'order-product-popup-ambiguous');
    return { ok: false, reason: `旧弹层搜索框可见候选数=${legacyVisible}（应为 0 或 1）`, candidates: legacyVisible };
  }
  if (legacyVisible === 1) {
    await element.dispose().catch(() => {});
    return { ok: true, mode: 'legacy-popup', input: legacyPopup.filter({ visible: true }).first() };
  }

  // 新结构：字段容器内唯一「可见」的 input[role="combobox"]。用 Locator（非 ElementHandle）返回，
  // 跨商品复用/React 重建时每次重解析；用 filter({visible:true}) 排除隐藏同名节点，不靠下标定位。
  const field = orderProductFieldLocator(page);
  const fieldCount = await field.count().catch(() => -1);
  const combo = field.locator('input[role="combobox"]');
  const comboTotal = await combo.count().catch(() => 0);
  const visibleCombo = combo.filter({ visible: true });
  const comboVisible = await visibleCombo.count().catch(() => 0);
  if (fieldCount !== 1 || comboVisible !== 1) {
    await element.dispose().catch(() => {});
    await dumpEvidence(page, 'order-product-combobox');
    return {
      ok: false,
      reason: `商品名称/ID键入框不唯一：字段容器=${fieldCount}、可见 combobox=${comboTotal} 个中可见 ${comboVisible} 个（各应为 1；旧弹层搜索框 DOM 计数=${legacyTotal}）`,
      candidates: comboVisible,
    };
  }
  const editable = await visibleCombo.first().evaluate(el => el.readOnly === false && el.disabled === false).catch(() => false);
  const liveId = await visibleCombo.first().evaluate(el => el.id || '').catch(() => '');
  if (!editable) {
    // 旧结构兜底（2026-08 那版）：字段里唯一可见的是只读 trigger，弹层搜索框在 DOM 里但默认隐藏，
    // 必须点一次 trigger 才会展开。这里只保留这条兜底，并且「已经可见就不再点」——
    // 原实现的 for 循环会在搜索框已出现后继续点 trigger，把弹层点收起，是本次一并消除的重复点击风险。
    let legacyVisibleNow = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      legacyVisibleNow = await legacyPopup.filter({ visible: true }).count().catch(() => 0);
      if (legacyVisibleNow !== 0) break;
      const alive = await element.evaluate(el => el.isConnected).catch(() => false);
      if (!alive) {
        await element.dispose().catch(() => {});
        await dumpEvidence(page, 'order-product-trigger-detached');
        return { ok: false, reason: 'trigger 快照 detached（React 重建）', candidates: 1 };
      }
      try {
        await element.click({ timeout: 3000 });
      } catch (e) {
        await element.dispose().catch(() => {});
        await dumpEvidence(page, 'order-product-trigger');
        return { ok: false, reason: '点击商品字段trigger失败: ' + fmtErr(e), candidates: 1 };
      }
      await sleep(500);
    }
    await element.dispose().catch(() => {});
    if (legacyVisibleNow === 1) return { ok: true, mode: 'legacy-popup', input: legacyPopup.filter({ visible: true }).first() };
    await dumpEvidence(page, legacyVisibleNow > 1 ? 'order-product-popup-ambiguous' : 'order-product-combobox-readonly');
    return {
      ok: false,
      reason: legacyVisibleNow > 1
        ? `旧弹层搜索框可见候选数=${legacyVisibleNow}（应为1）`
        : '字段内 combobox 不可键入（readOnly/disabled）且点一次后仍无唯一可见弹层搜索框：结构再次变化，需重新取证',
      candidates: legacyVisibleNow,
    };
  }
  await element.dispose().catch(() => {});
  if (soleRole && soleRole !== 'combobox') {
    await dumpEvidence(page, 'order-product-combobox-role');
    return { ok: false, reason: `字段唯一可见输入框 role=${JSON.stringify(soleRole)}，不是可键入 combobox`, candidates: 1 };
  }
  return { ok: true, mode: 'in-field-combobox', sameNode: !!soleId && soleId === liveId, input: visibleCombo.first() };
}

// fillAndSearchOrderProductId: 在订单列表页填入商品ID并触发搜索，修正「搜索前行签名」采集时机。
// 流程：先采集 signatureBefore（搜索前表格首行文本）→ findOrderProductIdInput 定位输入框 →
// 清空并填入 pid → 按 Enter → waitForFunction 等待首行出现 pid 或「暂无数据」→
// 采集 signatureAfter，返回 {ok, matched, signatureBefore, signatureAfter}。
// matched 为 pid（命中）、'暂无数据'（空结果）或 null（超时未命中）。
// 关键：signatureBefore 必须在 Enter 之前采集，否则已被搜索结果改写，before/after 比对失效。
// 判断 tbody tr 是否为表头行（抖店将表头放在 tbody 内）
function isHeaderRow(text) {
  const headerSig = ['商品信息', '单价', '售后', '订单状态', '商家收入金额'];
  let hits = 0;
  for (const sig of headerSig) { if (text.includes(sig)) hits++; }
  return hits >= 2; // 至少命中 2 个表头关键词才视为表头，避免误判
}

// 获取第一条数据行（跳过表头），返回 { text, element } 或 null
async function getFirstDataRow(page) {
  return page.evaluate(() => {
    const headerSig = ['商品信息', '单价', '售后', '订单状态', '商家收入金额'];
    function isHeader(t) {
      let h = 0;
      for (const s of headerSig) { if (t.includes(s)) h++; }
      return h >= 2;
    }
    const rows = document.querySelectorAll('tbody tr');
    for (const row of rows) {
      const t = (row.innerText || '').trim();
      if (!t) continue;
      if (isHeader(t)) continue;
      return { text: t.substring(0, 200), found: true };
    }
    return { text: '', found: false };
  });
}

// getOrderResultSnapshot: 订单结果快照（首条明细行签名 + 总条数 + 是否暂无数据）。
// 明细行的特征：同时含「商家编码」和「¥」（每条订单由订单编号行+商品明细行组成，只取明细行）。
async function getOrderResultSnapshot(page) {
  return await page.evaluate(() => {
    const allRowTexts = Array.from(document.querySelectorAll('tbody tr'))
      .map(row => (row.innerText || '').trim());
    const orderRows = allRowTexts.filter(text => text.includes('商家编码') && text.includes('¥'));
    const sampleRows = orderRows.slice(0, 3);
    const totalCandidates = Array.from(document.querySelectorAll(
      'li.aurora-pagination-total-text, span.index_paginationTotal__x9seC'
    ));
    const totalText = totalCandidates
      .map(el => (el.innerText || '').trim())
      .find(text => /^共[\d,]+条订单$/.test(text)) || '';
    return {
      signature: sampleRows[0] ? sampleRows[0].substring(0, 200) : '__no_rows__',
      sampleRows,
      totalText,
      noData: allRowTexts.some(text => text.includes('暂无数据'))
    };
  }).catch(() => ({
    signature: '__error__',
    sampleRows: [],
    totalText: '',
    noData: false
  }));
}

// extractSelectedProductIds: 从「已选中建议项」文本里提取商品 ID（纯函数，可离线断言）。
// 新结构（OD1 2026-10-01 现场取证）：选中项是 div.aurora-select-item-option-selected，文本为「商品名\nID:<pid>」；
//   listbox 里那个 [role="option"][aria-selected="true"] 是无障碍代理节点，没有文本，不能当选中值读。
// 旧结构：listbox 内 [role="option"][aria-selected="true"] 的整串文本就是数字 ID。
function extractSelectedProductIds(selectedOptionTexts, legacyOptionTexts) {
  const norm = (arr) => Array.from(new Set((Array.isArray(arr) ? arr : [])
    .map(s => String(s === null || s === undefined ? '' : s).trim()).filter(Boolean)));
  const ids = [];
  for (const text of norm(selectedOptionTexts)) {
    for (const line of text.split(/\r?\n/)) {
      const m = line.trim().match(/^ID:(\d+)$/);
      if (m && !ids.includes(m[1])) ids.push(m[1]);
    }
  }
  if (ids.length) return ids;
  return norm(legacyOptionTexts).filter(t => /^\d+$/.test(t));
}

// shouldFocusOrderProductInput: 键入前是否需要点击聚焦（纯函数）。
// 探针证据：新结构下「已展开时再点一次」会把下拉收起并清空已键入值 ⇒ aria-expanded=true 时不得再点击。
function shouldFocusOrderProductInput(mode, state) {
  if (mode !== 'in-field-combobox') return true;
  if (!state) return true;
  return String(state.ariaExpanded) !== 'true';
}

// readOrderProductSelectionState: 读取商品筛选的已选状态（原始文本在页面里取，判定交给纯函数）。
// 归属优先用 combobox 的 aria-controls/aria-owns 锁定本字段的 listbox；锁不到再退回全页面 dropdown，
// 并在结果里记录实际用了哪种归属（scopedByAria/usedScope），避免把别的下拉的选中项当成本字段的。
async function readOrderProductSelectionState(page) {
  const raw = await page.evaluate((labelText) => {
    const visText = (el) => String((el && (el.innerText || el.textContent)) || '').trim();
    const field = Array.from(document.querySelectorAll('.aurora-label-wrapper'))
      .find(w => visText(w).startsWith(labelText));
    const combo = field ? field.querySelector('input[role="combobox"]') : null;
    const ctl = combo ? (combo.getAttribute('aria-controls') || combo.getAttribute('aria-owns') || '') : '';
    let scope = null;
    if (ctl) {
      const byId = document.getElementById(ctl);
      if (byId) scope = byId.matches('[role="listbox"]') ? byId : (byId.closest('[role="listbox"]') || byId);
    }
    const collect = (containers) => {
      const selectedOptionTexts = [];
      const legacySelectedOptionTexts = [];
      for (const c of containers) {
        for (const el of c.querySelectorAll('[class*="select-item-option-selected"]')) selectedOptionTexts.push(visText(el));
        for (const o of c.querySelectorAll('[role="option"][aria-selected="true"]')) legacySelectedOptionTexts.push((o.textContent || '').trim());
      }
      return { selectedOptionTexts, legacySelectedOptionTexts, containers: containers.length };
    };
    const all = () => Array.from(document.querySelectorAll('[role="listbox"], [class*="select-dropdown"]'));
    const scoped = scope ? [scope] : all();
    const a = collect(scoped);
    if (scope && a.selectedOptionTexts.length === 0 && a.legacySelectedOptionTexts.length === 0) {
      const b = collect(all());
      return Object.assign(b, { scopedByAria: false, usedScope: 'document-fallback' });
    }
    return Object.assign(a, { scopedByAria: !!scope, usedScope: scope ? 'aria-controls' : 'document' });
  }, ORDER_PRODUCT_LABEL_TEXT).catch(() => ({ selectedOptionTexts: [], legacySelectedOptionTexts: [], containers: 0, scopedByAria: false, usedScope: 'evaluate-failed' }));
  return Object.assign({}, raw, { ids: extractSelectedProductIds(raw.selectedOptionTexts, raw.legacySelectedOptionTexts) });
}

// readSelectedOrderProductIds: 已选中的商品 ID 数组（应为 [pid] 或 []）。
async function readSelectedOrderProductIds(page) {
  return (await readOrderProductSelectionState(page)).ids;
}

// countOrderProductSelectedTags: 字段里已选商品标签（带 × 移除入口）的条数。
// 用途：跨商品复用时确认「只剩当前这一个商品」，防止读到上一个商品的订单；读不到就返回 -1（调用方按失败处理）。
async function countOrderProductSelectedTags(page) {
  try {
    return await orderProductFieldLocator(page).locator('.aurora-select-selection-item-remove').count();
  } catch (_) {
    return -1;
  }
}

// fillAndSearchOrderProductId: 在订单列表页填入商品ID并触发搜索。
// 【操作逻辑备注（2026-08-28 恢复完整链路，改动前先读完本段）】
// ⚠️ 三个关键认知（未提交的重写版曾把它们删掉，导致「输入值校验失败/永远搜不到」）：
//   1. 真正接收文字的是展开弹层后的 portal 搜索框（findOrderProductIdInput 已负责展开）；
//   2. 键入 pid 后只完成了"过滤建议项"，Enter 不会选中建议——必须点击精确匹配
//      ID:${pid} 的建议项（.aurora-select-item-option），才算完成筛选条件；
//   3. 选完建议项也不会自动查询——必须点击唯一的「查询」按钮才刷新订单表。
// ⚠️ 结果匹配：订单行里的「商品单ID」不是搜索用的罗盘商品ID，绝不能用 row.includes(pid)
//   判断命中！要用建议项里解析出的商品名（productName）匹配结果明细行（含商家编码+¥ 的行）。
// 流程：快照before(明细行签名+总条数) → 键入pid并回读校验 → 等待并点击唯一精确建议项 →
//       校验弹层选中值==[pid] → 点击「查询」→ 等加载完成/结果变化 → 快照after做归属判定。
// matched 为 pid（命中）、'暂无数据'（空结果）或 null（未命中/未确认）。
// clickOrderProductStage: 带阶段归因的点击（OD1补修 2026-10-01）。
// 背景：正常自动化里订单列表页常常不是前台标签（同一浏览器上下文里还在用其它业务页），
//   对照测量支持后台标签状态可能放大 Playwright 点击前的 actionability 等待，
//   实测同一次「点建议项」从 88ms 涨到 5259ms（把该页置前后复测回到 82ms），
//   测量时使用 10000ms 预算，不能据此确定原故障卡点；旧代码这两处点击是裸 await，异常一路抛到 main 的
//   「查询失败: ${fmtErr(e)}」，而 fmtErr 只取报错首行 → 日志里只剩
//   「locator.click: Timeout 5000ms exceeded」，分不清是哪一次点击、什么状态。
// 本函数不延长超时、不放宽校验、不 force：只把“失败”变成带证据的结构化结果——
//   阶段、定位器、候选数量、目标矩形/可见/禁用、点击落点上层的类名链（遮挡判定）、
//   标签页可见性与焦点、以及 Playwright 完整调用日志（剥 ANSI 后原样落盘 diag-click-*.log，
//   shop.log 一行只放摘要＋可定位文件路径——OD1_ZCode 补修：旧版截 700 字符仍标「完整调用日志」是错的）。
// writeDiagnosticTextFile: 把完整诊断文本（如 Playwright 点击调用日志）原样落盘——
//   剥 ANSI、不截断、唯一文件名（时间戳＋自增序号，防同毫秒覆写），目录与 dumpEvidence 一致
//   （生产＝脚本目录；隔离验证＝DOUYIN_EVIDENCE_DIR 重定向）。
//   返回文件路径；写盘失败返回 null（调用方必须把完整文本原样放进 reason，不得弄丢）。
let __diagLogSeq = 0;
function writeDiagnosticTextFile(stage, text) {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(evidenceDir(), `diag-click-${stage}-${stamp}-${++__diagLogSeq}.log`);
    fs.writeFileSync(file, String(text || ''), 'utf8');
    return file;
  } catch (_) { return null; }
}
async function clickOrderProductStage(page, locator, stage, timeout) {
  const t0 = Date.now();
  try {
    await locator.click({ timeout });
    return { ok: true, ms: Date.now() - t0, stage };
  } catch (e) {
    const count = await locator.count().catch(() => -1);
    let probe = null;
    if (count > 0) {
      probe = await locator.first().evaluate((el) => {
        const r = el.getBoundingClientRect();
        const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        const chain = [];
        for (let p = top; p && chain.length < 5; p = p.parentElement) {
          chain.push(String((p && (p.className || p.tagName)) || '').split(/\s+/).slice(0, 3).join('.'));
        }
        return {
          rect: { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) },
          visible: r.width > 0 && r.height > 0,
          disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true',
          hitIsTarget: !!(top && (top === el || el.contains(top) || top.contains(el))),
          hitChain: chain,
          visibilityState: document.visibilityState,
          hasFocus: document.hasFocus(),
        };
      }).catch((err) => ({ evaluateError: fmtErr(err) }));
    }
    // Playwright 报错里带 ANSI 控制码，直接进 shop.log 会成为乱码噪声，这里剥掉颜色码但保留全部文字。
    // ⚠️ 完整调用日志不截断（旧版 slice(0,700) 却标注「完整调用日志」，是本次订正的缺陷）：
    //   原样落盘 diag-click-*.log，路径写进 reason 供 shop.log 定位；一行摘要由 describeClickStageFailure 负责。
    const callLog = String((e && e.message) || e).replace(/\x1b\[[0-9;]*m/g, '');
    const callLogFile = writeDiagnosticTextFile(stage, callLog);
    // 定位器打印优先用 API 形态（locator(...).filter(...)），describe() 会带 internal: 噪声，仅作兜底。
    let selector = '未知';
    try { selector = String(locator).replace(/\s+/g, ' ').slice(0, 200); } catch (_) {
      try { selector = String(locator.describe()).replace(/\s+/g, ' ').slice(0, 200); } catch (__) {}
    }
    return {
      ok: false, stage, ms: Date.now() - t0, count, selector, probe,
      callLog, callLogFile,
    };
  }
}

// describeClickStageFailure: 把上面的结构化结果压成一行可读原因（进 reason，最终会写进 shop.log）。
// 这一行只是摘要（首行＋状态证据）；完整调用日志已由 writeDiagnosticTextFile 原样落盘，
// 这里给出可定位文件路径。落盘失败时把完整文本原样放进这一行——宁可长，不可丢。
function describeClickStageFailure(r) {
  const full = String(r.callLog || '');
  const summary = full.split('\n')[0].replace(/\s+/g, ' ').slice(0, 240);
  return `阶段=${r.stage} 耗时=${r.ms}ms 候选数=${r.count} 定位器=${r.selector} ` +
    `目标状态=${JSON.stringify(r.probe || null)} ` +
    (r.callLogFile
      ? `调用日志摘要=${summary} 完整调用日志文件=${r.callLogFile}`
      : `完整调用日志=${full.replace(/\s+/g, ' ')}`);
}

async function fillAndSearchOrderProductId(page, productId) {
  const pid = String(productId);

  // 0) 把订单页置为前台标签再开始点击（对照测量中置前后的点击耗时从 5259ms 回到 82ms；
  //    原生产故障没有完整日志，后台状态是待验证的可能因素，不能认定为唯一原因）。
  //    失败只记录，不改变流程：真正的遮挡/不可点会由下面的阶段归因结果暴露出来。
  const frontResult = await page.bringToFront().then(() => ({ ok: true })).catch((e) => ({ ok: false, err: fmtErr(e) }));

  // 1) 搜索前快照（必须在点击查询之前采集，否则 before/after 比对失效）
  const resultBefore = await getOrderResultSnapshot(page);
  const signatureBefore = resultBefore.signature;

  // 2) 定位可键入的商品搜索框（含清残留标签；OD1 起不再“点 trigger 等弹层”），键入并回读校验
  const found = await findOrderProductIdInput(page);
  if (!found.ok) {
    return { ok: false, matched: null, signatureBefore, signatureAfter: signatureBefore, reason: found.reason };
  }
  const inputEl = found.input;
  let actualValue = '';
  let focusedByClick = false;
  try {
    // 新结构（in-field combobox）已展开时禁止再点击：探针证据是“已展开时再点一次会收起并清空键入值”，
    // 收起后建议列表消失、后面等建议项只会超时——这正是“重复点击收起”线索的落点。
    const state = await inputEl.evaluate(el => ({
      ariaExpanded: el.getAttribute('aria-expanded'), valueLen: String(el.value || '').length,
      focused: document.activeElement === el,
    })).catch(() => null);
    if (shouldFocusOrderProductInput(found.mode, state)) {
      // 跨商品复用时该控件有 fade-in + 位移动画，Locator 默认 actionability（visible→stable→receives events）
      // 可能等满 5s 仍判为不稳定；selector 已唯一且视觉可见，force 只跳过 stable 判定。
      // 安全性由下面的「输入值回读 == pid」兜底：真打错框就会走 input_value_mismatch 分支停住。
      await inputEl.click({ timeout: 5000, force: true });
      focusedByClick = true;
    } else {
      await inputEl.evaluate(el => el.focus());
    }
    // 防御性彻底清空搜索框：①步虽清过已选标签与残值，但 Aurora 受控组件在 React 重渲染时
    // 可能从内部 state 恢复；用 Ctrl+A 选中 + Delete 强制清空最稳。
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Delete');
    await page.keyboard.type(pid, { delay: 30 });         // 逐字符键入，触发 React onChange（新结构靠这一步展开下拉）
    await sleep(200);
    actualValue = await inputEl.evaluate(el => el.value).catch(() => '');
    await sleep(150);
    actualValue = await inputEl.evaluate(el => el.value).catch(() => '');
  } catch (e) {
    await dumpEvidence(page, 'order-product-fill');
    // 这里也是一次点击（聚焦用 inputEl.click）的失败路径：完整异常文本同样落盘，不只留首行。
    const focusLog = String((e && e.message) || e).replace(/\x1b\[[0-9;]*m/g, '');
    const focusLogFile = writeDiagnosticTextFile('input-focus-click', focusLog);
    return {
      ok: false, matched: null, signatureBefore, signatureAfter: signatureBefore,
      reason: '商品ID键入异常: ' + fmtErr(e) +
        (focusLogFile ? ` 完整调用日志文件=${focusLogFile}` : ' 完整调用日志=' + focusLog.replace(/\s+/g, ' ')),
    };
  }
  if (actualValue !== pid) {
    console.warn(`[fillAndSearch] 输入值校验失败 expected=${pid} actual=${actualValue}`);
    await dumpEvidence(page, 'order-product-fill-mismatch');
    return { ok: false, matched: null, signatureBefore, signatureAfter: signatureBefore, reason: `input_value_mismatch: expected "${pid}", got "${actualValue}"` };
  }

  // 3) 等待并点击唯一精确匹配 ID:${pid} 的建议项（候选数必须为1，防止误选相似ID）
  //    新结构键入后才异步出建议（探针：约 0.7s），等建议用 waitFor(visible) 而不是固定 sleep。
  const suggestion = page.locator('.aurora-select-item-option:visible').filter({ hasText: `ID:${pid}` });
  let productName = '';
  try {
    await suggestion.first().waitFor({ state: 'visible', timeout: 8000 });
    const suggestionCount = await suggestion.count();
    if (suggestionCount !== 1) throw new Error(`精确建议项候选数=${suggestionCount}（应为1）`);
    const optionText = await suggestion.innerText();
    const optionLines = optionText.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (!optionLines.includes(`ID:${pid}`)) throw new Error(`建议项未精确包含 ID:${pid}`);
    productName = optionLines.find(s => !s.startsWith('ID:')) || '';
  } catch (e) {
    await dumpEvidence(page, 'order-product-suggestion-missing');
    return { ok: false, matched: null, signatureBefore, signatureAfter: signatureBefore, reason: `商品ID已输入但未出现对应建议项 ID:${pid}: ${fmtErr(e)}` };
  }
  const suggestionClick = await clickOrderProductStage(page, suggestion, 'suggestion-click', 5000);
  if (!suggestionClick.ok) {
    await dumpEvidence(page, 'order-product-suggestion-click-failed');
    return {
      ok: false, matched: null, signatureBefore, signatureAfter: signatureBefore,
      reason: '点击商品建议项失败: ' + describeClickStageFailure(suggestionClick) + `（置前结果=${JSON.stringify(frontResult)}）`,
    };
  }

  // 4) 校验已选中的建议项 == [pid]，且字段里只剩这一个已选标签（防跨商品串数据）
  const selBefore = await readOrderProductSelectionState(page);
  const selectedIdsBeforeQuery = selBefore.ids;
  const selectedTagsBeforeQuery = await countOrderProductSelectedTags(page);
  if (selectedIdsBeforeQuery.length !== 1 || selectedIdsBeforeQuery[0] !== pid || selectedTagsBeforeQuery !== 1) {
    await dumpEvidence(page, 'order-product-selection-unverified');
    return {
      ok: false, matched: null, signatureBefore, signatureAfter: signatureBefore,
      reason: `商品筛选选中值校验失败: 已选ID=${JSON.stringify(selectedIdsBeforeQuery)} 已选标签数=${selectedTagsBeforeQuery}（应为 [${pid}] 与 1；归属=${selBefore.usedScope}）`,
    };
  }

  // 5) 点击唯一的「查询」按钮，才会真正刷新订单结果
  const queryButton = page.getByRole('button', { name: '查询', exact: true });
  const queryButtonCount = await queryButton.count();
  if (queryButtonCount !== 1) {
    await dumpEvidence(page, 'order-query-button');
    return { ok: false, matched: null, signatureBefore, signatureAfter: signatureBefore, reason: `订单查询按钮候选数=${queryButtonCount}（应为1）` };
  }
  const spinner = page.locator('div.aurora-spin.aurora-spin-spinning[aria-busy="true"]');
  const spinnerStarted = spinner.first().waitFor({ state: 'visible', timeout: 5000 }).then(() => true).catch(() => false);
  const queryClick = await clickOrderProductStage(page, queryButton, 'query-button-click', 5000);
  if (!queryClick.ok) {
    await dumpEvidence(page, 'order-query-button-click-failed');
    return {
      ok: false, matched: null, signatureBefore, signatureAfter: signatureBefore,
      reason: '点击订单查询按钮失败: ' + describeClickStageFailure(queryClick) + `（置前结果=${JSON.stringify(frontResult)}）`,
    };
  }
  const sawSpinner = await spinnerStarted;
  if (sawSpinner) {
    try {
      await spinner.first().waitFor({ state: 'hidden', timeout: 20000 });
    } catch (e) {
      await dumpEvidence(page, 'order-query-spinner-stuck');
      return { ok: false, matched: null, signatureBefore, signatureAfter: signatureBefore, reason: `订单查询加载未完成: ${fmtErr(e)}` };
    }
  }

  // 6) 等结果变化：总条数变 / 首行变 / 前三条明细行全部含建议项商品名
  try {
    await page.waitForFunction((state) => {
      const allRowTexts = Array.from(document.querySelectorAll('tbody tr'))
        .map(row => (row.innerText || '').trim());
      if (allRowTexts.some(text => text.includes('暂无数据'))) return true;
      const samples = allRowTexts
        .filter(text => text.includes('商家编码') && text.includes('¥'))
        .slice(0, 3);
      const totalText = Array.from(document.querySelectorAll(
        'li.aurora-pagination-total-text, span.index_paginationTotal__x9seC'
      )).map(el => (el.innerText || '').trim())
        .find(text => /^共[\d,]+条订单$/.test(text)) || '';
      const first = samples[0] ? samples[0].substring(0, 200) : '__no_rows__';
      const changed = (totalText && totalText !== state.totalBefore) || first !== state.signatureBefore;
      const allMatchProduct = Boolean(state.productName) && samples.length > 0 &&
        samples.every(text => text.includes(state.productName));
      return changed || allMatchProduct;
    }, {
      totalBefore: resultBefore.totalText,
      signatureBefore,
      productName
    }, { timeout: 20000 });
  } catch (_) { /* 下面用最终快照做严格判定 */ }

  // 7) 最终快照做归属判定：查询完成 + 选中值仍是 [pid]（且字段里仍只有这一个已选标签）+ 结果行都属于该商品（或暂无数据）
  const resultAfter = await getOrderResultSnapshot(page);
  const selAfter = await readOrderProductSelectionState(page);
  const selectedIdsAfterQuery = selAfter.ids;
  const selectedTagsAfterQuery = await countOrderProductSelectedTags(page);
  const signatureAfter = resultAfter.signature;
  const allRowsMatchProduct = Boolean(productName) && resultAfter.sampleRows.length > 0 &&
    resultAfter.sampleRows.every(text => text.includes(productName));
  const resultChanged = (resultAfter.totalText && resultAfter.totalText !== resultBefore.totalText) ||
    signatureAfter !== signatureBefore;
  const selectionVerified = selectedIdsAfterQuery.length === 1 && selectedIdsAfterQuery[0] === pid
    && selectedTagsAfterQuery === 1;
  const queryCompleted = sawSpinner || resultChanged;
  const matched = queryCompleted && selectionVerified
    ? (resultAfter.noData ? '暂无数据' : (allRowsMatchProduct ? pid : null))
    : null;

  // 成功核验行也必须带上 置前结果 与两次点击耗时：这是 18:07 类故障的直接证据，
  // 要让两个调用方（主查询 3907 / 成本检查 3742）经 stdout→shop.log 自然留痕，而不是只在返回对象里。
  console.log(`[fillAndSearch] pid=${pid} mode=${found.mode} inputValue=${JSON.stringify(actualValue)} selected=${JSON.stringify(selectedIdsAfterQuery)} 已选标签=${selectedTagsAfterQuery} 归属=${selAfter.usedScope} product=${JSON.stringify(productName)} total=${resultBefore.totalText}->${resultAfter.totalText} before=${String(signatureBefore).substring(0, 40)} after=${String(signatureAfter).substring(0, 40)} matched=${matched} front=${frontResult.ok} clickMs=suggestion:${suggestionClick.ms}/query:${queryClick.ms}`);
  if (!queryCompleted || !selectionVerified || (!resultAfter.noData && !allRowsMatchProduct)) {
    await dumpEvidence(page, 'order-query-result-unverified');
    return {
      ok: false, matched: null, signatureBefore, signatureAfter,
      reason: `订单查询结果未能确认属于商品 ${pid}（选中ID=${JSON.stringify(selectedIdsAfterQuery)} 已选标签=${selectedTagsAfterQuery} 查询完成=${queryCompleted} 行匹配=${allRowsMatchProduct}）`,
    };
  }

  return { ok: true, matched, signatureBefore, signatureAfter, productName, mode: found.mode, focusedByClick, broughtToFront: frontResult.ok, clickMs: { suggestion: suggestionClick.ms, query: queryClick.ms } };
}

// AD-AUTO-PLAN-REPAIR-20261012-S75：删除 saveCookiesToPath（裸 writeFileSync，无身份校验/指纹保护，
// 且原先在读取店铺语义身份之前就被扫码成功分支调用）。Cookie 保存统一走
// analyzer-session-checkpoint（见 main 登录稳定后的会话检查点）。

async function loadCookiesFromPath(context, cookiePath) {
  if (fs.existsSync(cookiePath)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(cookiePath, 'utf-8'));
      await context.addCookies(cookies);
      return true;
    } catch (e) {
      console.error('[ERROR] Cookie加载失败:', fmtErr(e));
      return false;
    }
  }
  return false;
}

// MULTISHOP-ISOLATION-20261027（D2）：店铺名 → Cookie 文件解析（纯函数，离线回归用）。
// 多店隔离缺陷：原逻辑在精确文件缺失时做 >0.3 相似度模糊匹配（含 U+FFFD 乱码名走
// 模糊修复/单文件回退），中文字符集高度重叠极易跨店命中，把 B 店 Cookie 当 A 店加载
// ——写入侧身份门无法为"读错店"兜底。D2 起对**显式指定的店铺名**（无论普通还是乱码）
// 一律只认自己的精确文件：存在 → exact；缺失 → missing-exact（保持本店精确路径，
// 绝不指向目录内任何其他店铺文件）。目录文件数仅用于日志提示，不做任何猜测。
// 未指定店铺名 → default.json，原行为不变。
function resolveAnalyzerCookiePath({ shopNameArg, cookiesDir, fsMod }) {
  const fsm = fsMod || fs;
  const out = (status, cookiePath, extra) => ({ status, cookiePath, ...(extra || {}) });
  if (!shopNameArg) return out('default', path.join(cookiesDir, 'default.json'));
  const safeName = shopNameArg.replace(/[\/:*?"<>|]/g, '_');
  const exactPath = path.join(cookiesDir, safeName + '.json');
  if (fsm.existsSync(exactPath)) return out('exact', exactPath);
  let cookieFiles = [];
  try {
    cookieFiles = fsm.readdirSync(cookiesDir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return out('list-failed', exactPath, { error: String((e && e.message) || e) });
  }
  return out('missing-exact', exactPath, { cookieFiles: cookieFiles.length });
}

// MULTISHOP-ISOLATION-20261027（D3）：店铺名比较（纯函数，离线回归用）。
// 观察店铺与请求店铺做保守归一后精确比较：沿用既有 瑮→瑾 修正与文件名安全替换
// （/ \ : * ? " < > | → _）+ 去首尾空白。不做任何别名映射/模糊相似度——
// 不一致就是不匹配（绝不把观察到的错误店铺当成自己的期望店铺）。
function shopNamesMatch(observed, requested) {
  if (!observed || !requested) return false;
  const norm = (s) => String(s).replace(/瑮/g, '瑾').replace(/[\/:*?"<>|]/g, '_').trim();
  return norm(observed) === norm(requested);
}

// MULTISHOP-ISOLATION-20261027（D3）：重建加载前基线（纯读取，离线回归用）。
// main 启动时与恢复链成功提升工作副本后共用同一路径，保证恢复后的
// startFingerprint/candidateCookies 基线推进到本店已提升文件，而不是停留在
// 旧失败文件——否则后续检查点 CAS 会误拒自己刚提升的工作副本。
function readAnalysisBaseline(cookiePath, fsMod) {
  const fsm = fsMod || fs;
  const out = { startFingerprint: null, candidateCookies: null };
  try {
    out.startFingerprint = fingerprintOf(cookiePath);
    const parsed = JSON.parse(fsm.readFileSync(cookiePath, 'utf-8'));
    if (Array.isArray(parsed)) out.candidateCookies = parsed;
  } catch (e) { /* 缺失/损坏：候选为空、指纹为 absent——检查点按既有规则拒绝或保守提交 */ }
  return out;
}

// MULTISHOP-ISOLATION-20261027（D3）：恢复成功后的会话置换。
// 每份 Cookie 必须在独立浏览器进程中使用：恢复链在候选探针进程里验证并提升
// 本店工作副本后，主流程必须先彻底关闭原（已登录失败的）分析浏览器——
// close 成功且 isConnected 为假才允许启动新会话；关闭失败必须停下（不启动
// 新进程、不 force kill）。新浏览器沿用主分析的启动参数与视口，全新
// context/page，不迁移 storageState/localStorage/旧 Cookie。
async function replaceAnalyzerSessionAfterRestore({ oldBrowser, launchOptions, contextOptions, chromiumMod }) {
  const cr = chromiumMod || chromium;
  if (oldBrowser) {
    try {
      await oldBrowser.close();
    } catch (e) {
      throw new Error('恢复后关闭旧分析浏览器失败，停止（不启动新会话）: ' + fmtErr(e));
    }
    if (oldBrowser.isConnected()) {
      throw new Error('恢复后旧分析浏览器 close 后 isConnected 仍为 true，停止（不启动新会话）');
    }
  }
  const newBrowser = await cr.launch(launchOptions);
  let newContext;
  try {
    newContext = await newBrowser.newContext(contextOptions);
    const newPage = await newContext.newPage();
    await newPage.bringToFront();
    try {
      await newPage.evaluate(() => {
        if (window.screen) {
          window.moveTo(0, 0);
          window.resizeTo(window.screen.availWidth, window.screen.availHeight);
        }
      });
    } catch (e) { /* 最大化失败不影响新会话 */ }
    return { browser: newBrowser, context: newContext, page: newPage };
  } catch (e) {
    try { await newBrowser.close(); } catch (e2) { /* 已尽力回收 owned 新进程 */ }
    throw new Error('恢复后新建分析上下文失败（已关闭新浏览器）: ' + fmtErr(e));
  }
}

// MULTISHOP-ISOLATION-20261027（D5A）：被动等待“受信抖店首页”落定。
// 背景：登录检测原先固定 sleep 5 秒后一次性读 URL，健康只读 Cookie 的首页跳转实测
// 需要约 15 秒、现场常见 30 秒；5 秒时仍停在登录/重定向中介页就会被误判失败并进入
// 扫码/COOKIE_EXPIRED。本函数复用既有守卫 45s 上限 / 3s 间隔的“被动落定”语义：
//   - 不导航、不点击、不碰表单/二维码，只读 page.url()（调用方已 goto）；
//   - 受信首页（https://fxg.jinritemai.com/ffa/mshop/homepage[/...]）立即 true；
//   - 登录页/重定向中介地址持续等待到 45 秒截止，绝不提前判坏；
//   - 只在截止时返回 false；
//   - 页面已关闭/不可读是真实资源错误：抛带 analyzerNonAuthError 标记的普通错误，
//     调用方必须按普通错误处理，绝不写成 COOKIE_EXPIRED。
// 测试可注入 nowFn/sleep 假时钟；默认 sleep 为普通等待，main 传入既有 pausableSleep。
function markAnalyzerNonAuthError(err) {
  const e = err instanceof Error ? err : new Error(String(err));
  e.analyzerNonAuthError = true;
  return e;
}

function isTrustedAnalyzerHomepageUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || '')); } catch (_) { return false; }
  if (u.protocol !== 'https:') return false;
  if (u.hostname !== 'fxg.jinritemai.com') return false;
  const p = u.pathname;
  return p === '/ffa/mshop/homepage' || p.startsWith('/ffa/mshop/homepage/');
}

function readAnalyzerPageUrl(page) {
  if (!page || typeof page.url !== 'function') {
    throw markAnalyzerNonAuthError(new Error('分析器页面不可用（无法读取地址）：按普通资源错误处理，不判定 Cookie 过期'));
  }
  try {
    if (typeof page.isClosed === 'function' && page.isClosed()) {
      throw markAnalyzerNonAuthError(new Error('分析器页面已关闭：按普通资源错误处理，不判定 Cookie 过期'));
    }
    return String(page.url());
  } catch (e) {
    if (e && e.analyzerNonAuthError) throw e;
    throw markAnalyzerNonAuthError(new Error('分析器页面不可读（页面/上下文已关闭或驱动异常）：按普通资源错误处理，不判定 Cookie 过期'));
  }
}

async function waitForAnalyzerHomepage(page, options) {
  const opts = options || {};
  const sleepFn = typeof opts.sleep === 'function' ? opts.sleep : sleep;
  const nowFn = typeof opts.nowFn === 'function' ? opts.nowFn : Date.now;
  const maxWaitMs = Number.isFinite(opts.maxWaitMs) && opts.maxWaitMs >= 0 ? opts.maxWaitMs : 45000;
  const intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : 3000;
  const deadline = nowFn() + maxWaitMs;
  // 有界检查：即使注入的时钟不前进也不会无限循环；正常时钟在截止点返回 false。
  const maxChecks = Math.ceil(maxWaitMs / intervalMs) + 1;
  for (let i = 0; i < maxChecks; i += 1) {
    if (isTrustedAnalyzerHomepageUrl(readAnalyzerPageUrl(page))) return true;
    const remaining = deadline - nowFn();
    if (remaining <= 0) return false;
    await sleepFn(Math.min(intervalMs, remaining));
  }
  return false;
}

// MULTISHOP-ISOLATION-20261027（D6E）：进入抖店登录/首页的统一导航入口（初始检测与
// 恢复交接共用）。goto 的网络/导航资源失败不是 Cookie 失效证据：统一转成带
// analyzerNonAuthError 标记的普通错误（固定脱敏原因，绝不复述可能含 token 的完整 URL），
// 由 main 的 catch/finally 抑制 COOKIE_EXPIRED。登录有效性与“需要扫码”仍只由
// waitForAnalyzerHomepage 的受信首页判定与既有扫码分支决定，本 helper 不吞真实 auth 失败。
async function gotoAnalyzerLoginPage(page, loginUrl, label) {
  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  } catch (_) {
    throw markAnalyzerNonAuthError(new Error(
      `${label || '进入抖店首页'}失败（普通资源错误，异常详情可能含完整URL/令牌，已脱敏不回显）`
    ));
  }
}

// MULTISHOP-ISOLATION-20261027（D5A）：恢复链成功提升后的会话置换 + 被动登录落定。
// 与恢复查找严格分离：查找失败/异常由调用方按普通错误处理；本函数只处理“已提升”后的
// 置换/加载/被动等待，任何失败都以普通错误抛出（调用方不得转成 QR/COOKIE_EXPIRED）。
// 置换/新建上下文失败已由 replaceAnalyzerSessionAfterRestore 回收；本函数在后续
// 加载/goto/被动等待失败时回收自己启动的新浏览器，避免孤儿进程。成功返回后由
// main 的 finally 关闭“最新 owned”会话。
async function applyAnalyzerRestoreHandoff(opts) {
  const o = opts || {};
  const fsm = o.fsMod || fs;
  const loadCookies = typeof o.loadCookiesFn === 'function' ? o.loadCookiesFn : loadCookiesFromPath;
  let fresh;
  try {
    fresh = await replaceAnalyzerSessionAfterRestore({
      oldBrowser: o.oldBrowser,
      launchOptions: o.launchOptions,
      contextOptions: o.contextOptions,
      chromiumMod: o.chromiumMod,
    });
  } catch (e) {
    throw markAnalyzerNonAuthError(e);
  }
  let handedOff = false;
  try {
    const baseline = readAnalysisBaseline(o.cookiePath, fsm);
    await loadCookies(fresh.context, o.cookiePath);
    // 与 main 初始入口共用唯一导航 helper（domcontentloaded/120000 不变，零额外导航）。
    await gotoAnalyzerLoginPage(fresh.page, o.loginUrl || CONFIG.douyin.loginUrl, '恢复后进入抖店首页');
    const isLoggedIn = await waitForAnalyzerHomepage(fresh.page, {
      sleep: o.sleepFn,
      nowFn: o.nowFn,
      maxWaitMs: o.maxWaitMs,
      intervalMs: o.intervalMs,
    });
    handedOff = true;
    return {
      browser: fresh.browser,
      context: fresh.context,
      page: fresh.page,
      startFingerprint: baseline.startFingerprint,
      candidateCookies: baseline.candidateCookies,
      isLoggedIn: isLoggedIn === true,
      loginSuccess: isLoggedIn === true,
    };
  } catch (e) {
    throw markAnalyzerNonAuthError(e);
  } finally {
    if (!handedOff) {
      try { await fresh.browser.close(); } catch (_) { /* 已尽力回收 owned 新进程 */ }
    }
  }
}

async function getFeishuToken() {
  const { app_id, app_secret } = require('./feishu-env').requireFeishuCredentials();
  CONFIG.feishu.app_id = app_id;
  CONFIG.feishu.app_secret = app_secret;
  const response = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id, app_secret })
  });
  const data = await response.json();
  if (data.code !== 0) {
    throw new Error(`飞书Token获取失败: ${JSON.stringify(data)}`);
  }
  return data.tenant_access_token;
}

async function loadPremiumMap(accessToken) {
  const map = new Map();
  const tbl3Url = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.feishu.app_token}/tables/${CONFIG.feishu.tbl3_table}/records`;
  let pageToken = '';
  do {
    const url = pageToken
      ? `${tbl3Url}?page_size=500&page_token=${pageToken}`
      : `${tbl3Url}?page_size=500`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const data = await resp.json();
    if (data.data && data.data.items) {
      for (const item of data.data.items) {
        const abbr = item.fields['档口缩写'];
        const premium = item.fields['毛利溢价标准'];
        if (abbr && premium != null && Number.isFinite(Number(premium))) {
          map.set(String(abbr).trim().toUpperCase(), Number(premium));
        }
      }
      pageToken = data.data.page_token || '';
    } else {
      break;
    }
  } while (pageToken);
  console.log(`[loadPremiumMap] 加载 ${map.size} 个溢价档口`);
  return map;
}

// 上传图片到飞书并获取file_token
async function uploadImageToFeishu(accessToken, imageUrl) {
  try {
    // 下载图片
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      console.log(`下载图片失败: ${imageResponse.status}`);
      return null;
    }

    // 检测图片类型
    const buffer = await imageResponse.arrayBuffer();
    const uint8Array = new Uint8Array(buffer);
    let imageType = 'image/jpeg';

    // Check for PNG signature
    if (uint8Array[0] === 0x89 && uint8Array[1] === 0x50 && uint8Array[2] === 0x4E && uint8Array[3] === 0x47) {
      imageType = 'image/png';
    }

    const extension = imageType === 'image/png' ? '.png' : '.jpg';
    const fileName = `product_${Date.now()}${extension}`;

    // 使用drive API上传到飞书云盘
    // 关键：使用 parent_type=bitable_file 和 parent_node=app_token
    const uploadUrl = 'https://open.feishu.cn/open-apis/drive/v1/files/upload_all';
    const boundary = '----FormBoundary7MA4YWxkTrZu0gW';

    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="file_name"\r\n\r\n${fileName}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="parent_type"\r\n\r\nbitable_file`,
      `--${boundary}\r\nContent-Disposition: form-data; name="parent_node"\r\n\r\nCfAXbSrUFaBLv3stSRrcuUVon1b`,
      `--${boundary}\r\nContent-Disposition: form-data; name="size"\r\n\r\n${buffer.byteLength}`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${imageType}`
    ];

    const body = Buffer.concat([
      Buffer.from(parts.join('\r\n') + '\r\n\r\n'),
      Buffer.from(buffer),
      Buffer.from(`\r\n--${boundary}--`)
    ]);

    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`
      },
      body: body
    });

    const uploadResult = await uploadResponse.json();
    console.log(`上传结果: ${JSON.stringify(uploadResult)}`);

    if (uploadResult.code === 0) {
      // drive API返回的是file_token
      return uploadResult.data.file_token;
    } else {
      console.log(`上传图片失败: ${JSON.stringify(uploadResult)}`);
      return null;
    }
  } catch (e) {
    console.log(`上传图片异常: ${fmtErr(e)}`);
    return null;
}
}

// 从4号表格查询成本
async function getCostFrom4thTable(accessToken, merchantCode) {
  if (!merchantCode) {
    console.log('商家编码为空，跳过查询成本');
    return null;
  }

  console.log(`从4号表格查询款号 ${merchantCode} 的成本...`);

  // 4号表格: tblpEOUDXbdCMPPH
  const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.feishu.app_token}/tables/tblpEOUDXbdCMPPH/records`;

  try {
    // 精确搜索款号
    const searchUrl = `${baseUrl}?page_size=100&filter=AND(CurrentValue.[款号]="${merchantCode}")`;
    const response = await fetch(searchUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });

    const data = await response.json();

    if (data.data && data.data.items && data.data.items.length > 0) {
      const record = data.data.items[0];
      const cost = record.fields['成本'];
      if (cost !== undefined && cost !== null) {
        console.log(`找到成本: ${cost}`);
        return cost;
      }
    }

    // 如果精确搜索没找到，遍历所有记录查找
    console.log('精确搜索未找到，遍历所有记录...');
    let pageToken = '';
    do {
      const listUrl = pageToken ? `${baseUrl}?page_size=100&page_token=${pageToken}` : baseUrl;
      const listResponse = await fetch(listUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const listData = await listResponse.json();

      if (listData.data && listData.data.items) {
        for (const record of listData.data.items) {
          const code = record.fields['款号'];
          if (code && String(code).trim() === String(merchantCode).trim()) {
            const cost = record.fields['成本'];
            if (cost !== undefined && cost !== null) {
              console.log(`找到成本: ${cost}`);
              return cost;
            }
          }
        }
        pageToken = listData.data.page_token || '';
      } else {
        break;
      }
    } while (pageToken);

    // 精确匹配没找到，尝试模糊匹配：款号尾部有中文或数字后缀且备注为空
    console.log('精确匹配未找到，尝试模糊匹配...');
    pageToken = '';
    do {
      const listUrl = pageToken ? `${baseUrl}?page_size=100&page_token=${pageToken}` : baseUrl;
      const listResponse = await fetch(listUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const listData = await listResponse.json();

      if (listData.data && listData.data.items) {
        for (const record of listData.data.items) {
          const code = record.fields['款号'];
          const remark = record.fields['备注'];
          // 检查备注是否为空
          const isRemarkEmpty = !remark || String(remark).trim() === '';
          if (code && isRemarkEmpty && String(code).startsWith(merchantCode)) {
            const codeStr = String(code);
            const merchantLen = merchantCode.length;
            if (codeStr.length > merchantLen) {
              const suffix = codeStr.substring(merchantLen);
              // 情况1：尾部有中文（如 HBJJ218黑色）
              const hasChineseSuffix = /[一-龥]/.test(suffix);
              // 情况2：尾部是 -数字 格式（如 HBJJ218-1, HBJJ218-2）
              const hasDashNumberSuffix = /^-\d+$/.test(suffix);
              if (hasChineseSuffix || hasDashNumberSuffix) {
                const cost = record.fields['成本'];
                if (cost !== undefined && cost !== null) {
                  console.log(`模糊匹配成功: 款号=${code}, 成本=${cost}`);
                  return cost;
                }
              }
            }
          }
        }
        pageToken = listData.data.page_token || '';
      } else {
        break;
      }
    } while (pageToken);

    console.log(`未找到款号 ${merchantCode} 的成本`);
    return null;
  } catch (e) {
    console.log(`查询成本失败: ${fmtErr(e)}`);
    return null;
  }
}
// 检查飞书表格中是否有需要跳过的记录
// 规则：修正退货率为空则6小时内不更新；订单数>=10则24小时；5-9则48小时；<5则72小时
async function checkRecentRecord(accessToken, productId) {
  const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.feishu.app_token}/tables/${CONFIG.feishu.table_id}`;
  const now = Date.now();
  console.log(`[checkRecentRecord] 开始检查商品 ${productId}，当前时间: ${new Date(now).toISOString()}`);

  let pageToken = '';
  let pageNum = 0;
  do {
    pageNum++;
    const listUrl = pageToken
      ? `${baseUrl}/records?page_size=100&page_token=${pageToken}`
      : `${baseUrl}/records?page_size=100`;

    try {
      const response = await fetch(listUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const data = await response.json();

      if (data.data && data.data.items) {
        console.log(`[checkRecentRecord] 第${pageNum}页，共${data.data.items.length}条记录`);
        for (const record of data.data.items) {
          const recordTime = record.fields['记录时间'];
          const recordId = record.fields['商品id'];
          const correctedRate = record.fields['修正退款率'];
          const orderCount = record.fields['30天成交订单数'];
          const pureProfit5 = record.fields['纯利5%'];

          if (recordId && String(recordId) === String(productId)) {
            console.log(`[checkRecentRecord] 找到匹配的记录! 商品id=${recordId}, 记录时间=${recordTime}, 修正发后退货率=${correctedRate}, 订单数=${orderCount}, 纯利5%=${pureProfit5}`);
            // 检查记录时间
            let recordTimeMs = 0;
            if (typeof recordTime === 'number') {
              recordTimeMs = recordTime;
            } else if (typeof recordTime === 'string') {
              recordTimeMs = new Date(recordTime).getTime();
            }

            // 判断时间间隔（日期级）
            const recordDate = new Date(recordTimeMs);
            const today = new Date(now);
            const daysDiff = Math.floor(
              (Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()) -
               Date.UTC(recordDate.getFullYear(), recordDate.getMonth(), recordDate.getDate()))
              / (1000 * 60 * 60 * 24)
            );
            const hoursDiff = (now - recordTimeMs) / (1000 * 60 * 60);
            console.log(`  [记录时间检查] 记录时间=${recordDate.toISOString()}, 日期差=${daysDiff}天, 绝对差=${hoursDiff.toFixed(1)}小时`);

            // 规则按时间从短到长检查，条件满足则跳过，时间窗口已过则直接抓取

            // 1. 修正退货率为空
            if (correctedRate === null || correctedRate === undefined || correctedRate === '') {
              if (daysDiff < 1) {
                console.log(`  跳过：修正退货率为空，日期差${daysDiff}天<1天`);
                return true;
              }
              console.log(`  抓取：修正退货率为空，已超过1天(${daysDiff}天)`);
              return false;
            }

            // 2. 纯利5%为空
            if (pureProfit5 === null || pureProfit5 === undefined || pureProfit5 === '' || pureProfit5 === 0) {
              if (daysDiff < 1) {
                console.log(`  跳过：纯利5%为空，日期差${daysDiff}天<1天`);
                return true;
              }
              console.log(`  抓取：纯利5%为空，已超过1天(${daysDiff}天)`);
              return false;
            }

            // 3. 订单数>=10
            const orderNum = typeof orderCount === 'number' ? orderCount : parseInt(orderCount) || 0;
            // 销量=1：只要有记录就跳过（不需要退货率数据）
            if (orderNum === 1) {
              console.log(`  跳过：销量=1，无需更新退货率`);
              return true;
            }
            if (orderNum >= 10) {
              if (daysDiff < 1) {
                console.log(`  跳过：订单数${orderNum}>=10，日期差${daysDiff}天<1天`);
                return true;
              }
              console.log(`  抓取：订单数${orderNum}>=10，已超过1天(${daysDiff}天)`);
              return false;
            }

            // 4. 订单数5-9
            if (orderNum >= 5) {
              if (daysDiff < 2) {
                console.log(`  跳过：订单数${orderNum}>=5，日期差${daysDiff}天<2天`);
                return true;
              }
              console.log(`  抓取：订单数${orderNum}>=5，已超过2天(${daysDiff}天)`);
              return false;
            }

            // 5. 订单数<5
            if (daysDiff < 3) {
              console.log(`  跳过：订单数${orderNum}<5，日期差${daysDiff}天<3天`);
              return true;
            }

            // 6. 已下架
            const intervention = record.fields['已经干预'];
            const interventionStr = String(intervention || '');
            if (interventionStr.includes('已下架')) {
              if (daysDiff < 7) {
                console.log(`  跳过：已下架，日期差${daysDiff}天<7天`);
                return true;
              }
              console.log(`  抓取：已下架，已超过7天(${daysDiff}天)`);
              return false;
            }

            console.log(`  不跳过：所有规则均不满足`);
          }
        }
        if (!data.data.has_more) {
          console.log(`[checkRecentRecord] 第${pageNum}页没有更多记录`);
          break;
        }
        pageToken = data.data.page_token;
      } else {
        break;
      }
    } catch (e) {
      console.log(`  检查记录失败: ${fmtErr(e)}`);
      break;
    }
  } while (pageToken);

  console.log(`[checkRecentRecord] 商品 ${productId} 未找到匹配记录或不符合跳过条件，返回false`);
  return false;
}

// 从订单列表页面获取商品数据（商家编码、售价、图片）- F-P05: 要求行含 expectedProductId
async function getOrderData(page, orderListUrl, expectedProductId, expectedProductName = '') {
  try {
    await page.waitForTimeout(3000);
    const pid = expectedProductId ? String(expectedProductId) : '';
    // ⚠️ 订单行的「商品单ID」与搜索用的罗盘商品ID不是同一套 ID，行匹配必须用商品名
    //    （建议项解析出的完整商品名，由调用方从 fillAndSearchOrderProductId 的结果传入）。
    //    用 pid 过滤会一行都匹配不上（2026-08-28 修复 not_found）。
    const pname = String(expectedProductName || '').trim();
    const orderData = await page.evaluate(({ pid, pname }) => {
      // 限定到订单结果表格：优先找含“商家编码/订单”语义且确实有表体行的表格。
      // ⚠️ 2026-10-01 OD1_ZCode 补修：虚拟列表会把表头/表体拆成相邻两个 <table>，先碰到的是
      //   只有 thead 的表头表——真实站点实测：归属判定能看到 10 行结果，本函数却返回 no_rows
      //   （证据：Desktop\OD1_ZCode_click_timeout_verify\live-verify-3rounds-*.json 三轮 extract.reason=no_rows）。
      //   选表时要求 tbody 行数>0；找不到就回退 document 作用域（与主流程提取同一读取口径，行为只放宽不收紧）。
      const tables = document.querySelectorAll('table');
      let targetTable = null;
      for (const t of tables) {
        const txt = (t.innerText || '').slice(0, 500);
        if ((txt.includes('商家编码') || txt.includes('订单')) && t.querySelectorAll('tbody tr').length > 0) { targetTable = t; break; }
      }
      const scope = targetTable || document;
      const rows = scope.querySelectorAll('tbody tr');
      if (rows.length === 0) return { found: false, reason: 'no_rows' };

      for (const row of rows) {
        const rowText = row.innerText || '';
        if (rowText.includes('暂无数据')) return { found: false, reason: 'no_data' };
        if (pname && !rowText.includes(pname)) continue;

        let merchantCode = '';
        let merchantIncome = '';
        const img = row.querySelector('img');
        const codeMatch = rowText.match(/商家编码[：:]\s*(\S+)/);
        if (codeMatch) merchantCode = codeMatch[1];
        const incomeMatch = rowText.match(/¥\s*([\d,]+\.?\d*)/g);
        if (incomeMatch && incomeMatch.length >= 2) {
          merchantIncome = incomeMatch[1].replace(/[¥,\s]/g, '');
        } else if (incomeMatch && incomeMatch.length === 1) {
          merchantIncome = incomeMatch[0].replace(/[¥,\s]/g, '');
        }
        if (merchantCode || merchantIncome) {
          return {
            found: true,
            imageUrl: img ? img.src : '',
            merchantCode: merchantCode,
            merchantIncome: merchantIncome,
            rowSnippet: rowText.slice(0, 120),
            matchedPid: pid || null
          };
        }
      }
      return { found: false, reason: pname ? 'selected_product_not_in_rows' : 'not_found', rowSnippets: Array.from(scope.querySelectorAll('tbody tr')).slice(0,3).map(r=> (r.innerText||'').slice(0,80)) };
    }, { pid, pname });
    return orderData;
  } catch (e) {
    console.log(`  getOrderData error: ${fmtErr(e)}`);
    return { found: false, reason: fmtErr(e) };
  }
}

// 清理旧记录：删除销量=1且超过3天的记录，以及订单数不低于当前写入商品且超过10天的旧记录
async function cleanOldRecords(accessToken, shopName, currentOrderCount) {
  const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.feishu.app_token}/tables/${CONFIG.feishu.table_id}`;
  const now = Date.now();
  const orderThreshold =
    typeof currentOrderCount === 'number'
      ? currentOrderCount
      : parseInt(currentOrderCount, 10) || 0;
  if (!Number.isFinite(orderThreshold) || orderThreshold <= 0) {
    console.log(`  清理阈值无效(${currentOrderCount})，跳过清理`);
    return;
  }

  console.log(`\n========== [清理旧记录] ==========`);
  console.log(`店铺: ${shopName}`);
  console.log(`当前写入商品订单数: ${orderThreshold}`);
  console.log(`删除条件: 销量=1且>3天 或 销量>=${orderThreshold}且>10天`);

  let pageToken = '';
  let deletedCount = 0;
  let checkedCount = 0;
  let skippedCount = 0;
  const recordsToDelete = [];

  do {
    const listUrl = pageToken
      ? `${baseUrl}/records?page_size=100&page_token=${pageToken}`
      : `${baseUrl}/records?page_size=100`;

    try {
      const response = await fetch(listUrl, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      const data = await response.json();

      if (!response.ok || data.code !== 0) {
        console.log(`  查询记录失败: ${data.msg || response.statusText}`);
        return;
      }

      if (data.data && data.data.items) {
        for (const item of data.data.items) {
          const recordShop = item.fields['店铺'];
          const recordTime = item.fields['记录时间'];
          const orderCount = item.fields['30天成交订单数'];

          // 只处理当前店铺的记录
          if (!recordShop || String(recordShop).trim() !== shopName.trim()) continue;
          checkedCount++;

          // 解析记录时间
          let recordTimeMs = 0;
          if (typeof recordTime === 'number') {
            recordTimeMs = recordTime;
          } else if (typeof recordTime === 'string') {
            recordTimeMs = new Date(recordTime).getTime();
          }
          if (!Number.isFinite(recordTimeMs) || recordTimeMs <= 0) continue;

          // 解析订单数
          const orderNum = typeof orderCount === 'number' ? orderCount : parseInt(orderCount) || 0;

          // 规则1: 销量=1且超过3天 → 删除
          // 规则2: 订单数不低于当前写入商品且超过10天 → 删除
          const daysDiff = (now - recordTimeMs) / (1000 * 60 * 60 * 24);
          if ((orderNum === 1 && daysDiff > 3) || (orderNum >= orderThreshold && daysDiff > 10)) {
            const dateStr = new Date(recordTimeMs).toISOString().split('T')[0];
            console.log(`  [匹配删除] 商品ID: ${item.fields['商品id']}, 订单数: ${orderNum}, 动态阈值: >=${orderThreshold}, 记录日期: ${dateStr}, ${daysDiff.toFixed(1)}天前`);
            recordsToDelete.push({
              recordId: item.record_id,
              productId: item.fields['商品id'],
              orderNum,
              recordTimeMs,
              daysDiff
            });
          } else {
            skippedCount++;
          }
        }
        pageToken = data.data.page_token || '';
      } else {
        console.log(`  查询记录失败: 返回数据格式异常`);
        return;
      }
    } catch (e) {
      console.log(`  查询记录失败: ${fmtErr(e)}`);
      return;
    }
  } while (pageToken);

  console.log(`匹配删除记录数: ${recordsToDelete.length}`);

  // 查询完成后再批量删除，避免删除操作影响分页结果
  for (let i = 0; i < recordsToDelete.length; i += 500) {
    const batch = recordsToDelete.slice(i, i + 500);
    try {
      const deleteResponse = await fetch(`${baseUrl}/records/batch_delete`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ records: batch.map(record => record.recordId) })
      });
      const deleteResult = await deleteResponse.json();
      if (deleteResponse.ok && deleteResult.code === 0) {
        deletedCount += batch.length;
        console.log(`  ✓ 批量删除成功: ${batch.length}条`);
      } else {
        console.log(`  ✗ 批量删除失败: ${deleteResult.msg || deleteResponse.statusText}`);
      }
    } catch (e) {
      console.log(`  ✗ 批量删除异常: ${fmtErr(e)}`);
    }

    await sleep(500); // 限速
  }

  console.log(`\n========== [清理完成] ==========`);
  console.log(`检查记录数: ${checkedCount}`);
  console.log(`匹配删除记录数: ${recordsToDelete.length}`);
  console.log(`实际删除记录数: ${deletedCount}`);
  console.log(`跳过记录数: ${skippedCount}`);
  console.log(`================================`);
}

async function writeToFeishu(accessToken, products, shopName, premiumMap = new Map()) {
  ensureLedgerPath(process.env.SOURCE_LEDGER_PATH || require('path').join(__dirname, 'source-ledger.json'));
  const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.feishu.app_token}/tables/${CONFIG.feishu.table_id}`;

  // 先获取所有现有记录，构建商品id -> record_id 和 record_id -> 备注/已经干预/订单数/成本 映射
  console.log('获取现有记录...');
  const existingRecords = new Map();  // productId -> recordId
  const recordRemarks = new Map();    // recordId -> 备注值（用于append）
  const recordIntervention = new Map(); // recordId -> 已经干预值（更新时保留）
  const recordOrderCounts = new Map(); // recordId -> 原30天成交订单数（用于下滑检测）
  const recordCosts = new Map();       // recordId -> 成本（更新时保留）
  const recordFullFields = new Map();  // recordId -> 完整旧 fields（失效策略）
  let pageToken = '';

  do {
    const listUrl = pageToken
      ? `${baseUrl}/records?page_size=100&page_token=${pageToken}`
      : `${baseUrl}/records?page_size=100`;

    const response = await fetch(listUrl, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const data = await response.json();

    if (data.data && data.data.items) {
      for (const item of data.data.items) {
        const productId = item.fields['商品id'];
        if (productId) {
          existingRecords.set(String(productId), item.record_id);
          // 保存现有备注值（用于append）
          const existingRemark = item.fields['备注'];
          if (existingRemark) {
            recordRemarks.set(item.record_id, String(existingRemark));
          }
          // 保存现有已经干预值（更新时保留）
          const existingIntervention = item.fields['已经干预'];
          if (existingIntervention) {
            recordIntervention.set(item.record_id, existingIntervention);
          }
          // 保存原成交订单数（用于销量下滑检测）
          const existingOrderCount = item.fields['30天成交订单数'];
          if (existingOrderCount !== undefined && existingOrderCount !== null) {
            recordOrderCounts.set(item.record_id, Number(existingOrderCount));
          }
          // 保存现有成本（用于更新时保留）
          const existingCost = item.fields['成本'];
          if (existingCost !== undefined && existingCost !== null) {
            recordCosts.set(item.record_id, Number(existingCost));
          }
          recordFullFields.set(item.record_id, item.fields);
        }
      }
    }

    pageToken = data.data?.page_token || '';
  } while (pageToken);

  console.log(`找到 ${existingRecords.size} 条现有记录`);

  // 先上传所有图片，获取file_token
  console.log('开始上传商品图片...');
  for (const product of products) {
    if (product.imageUrl) {
      console.log(`上传图片: ${product.id}`);
      const fileToken = await uploadImageToFeishu(accessToken, product.imageUrl);
      if (fileToken) {
        product.imageFileToken = fileToken;
        console.log(`图片上传成功: ${fileToken}`);
      } else {
        console.log(`图片上传失败: ${product.imageUrl}`);
      }
      await sleep(1000); // 避免请求过快
    }
  }

  // 写入/更新每条商品记录
  let allSuccess = true;
  for (const product of products) {
    const productIdStr = String(product.id);

    // 构建字段数据
    console.log('[DEBUG-FEISHU] product.postShipRate=' + product.postShipRate + ', product.returnRate=' + product.returnRate + ', product.postShippingRate=' + product.postShippingRate);
    const fields = {
      '商品id': productIdStr,
      '平台': '抖店',
      '店铺': shopName || '瑾漂亮高定私服',
      '记录时间': Date.now(),
      '30天成交订单数': Number(product.orderCount),
    };
    {
      const __wb = buildWritebackFields(product, shopName, { shippingFee: SHIPPING_FEE, insurance: INSURANCE });
      Object.assign(fields, {
        '近30天退款率': __wb.fields['近30天退款率'],
        '修正退款率': __wb.fields['修正退款率'],
        '修正发后退货率': __wb.fields['修正发后退货率'],
        '退货占发货占比': __wb.fields['退货占发货占比'],
        '修正退货率参考销量': __wb.fields['修正退货率参考销量'],
        '商品编码': __wb.fields['商品编码'],
        '最新售价': __wb.fields['最新售价'],
        '发货后退款率': __wb.fields['发货后退款率'],
        '月广告消耗': __wb.fields['月广告消耗'],
        '平均每单广告费': __wb.fields['平均每单广告费'],
      });
      product.__rateQuality = __wb.quality;
      product.__suggestionGate = suggestionGate(__wb.quality, product, null);
      product.__profitStatus = 'pending';
      product.__profitWritten = false;
    }

    // 纯利3% = 最新售价 × 3%
    if (product.merchantIncome) {
      fields['纯利3%'] = Number((product.merchantIncome * 0.03).toFixed(2));
    }
    // 纯利5% = 最新售价 × 5%
    if (product.merchantIncome) {
      fields['纯利5%'] = Number((product.merchantIncome * 0.05).toFixed(2));
    }
    console.log(`  [writeToFeishu] merchantIncome=${product.merchantIncome}, 纯利3%=${fields['纯利3%']}, 纯利5%=${fields['纯利5%']}`);

    // 处理备注字段：只追加，不覆盖
    const remarkParts = [];
    const today = new Date().toISOString().split('T')[0];

    // 如果有成本，添加到字段中（成本字段是数字类型，不能为null）
    if (product.cost !== undefined && product.cost !== null) {
      fields['成本'] = Number(product.cost);
    }

    // 销量=1的简化处理：只看毛利>=40，不计算退货率
    if ((product.orderCount || 0) === 1 && product.merchantIncome && product.cost != null) {
      const gross = product.merchantIncome - product.cost;
      fields['毛利'] = Number(gross.toFixed(2));
      fields['平均每单利润'] = Number(gross.toFixed(2));
      console.log(`  销量=1简化: 售价${product.merchantIncome} - 成本${product.cost} = 毛利${gross.toFixed(2)}元${gross >= 40 ? ' ✓达标' : ' 未达标'}`);
      // 不计算退货率相关建议，直接写入
    } else {

    // 100%退货率：亏损 = 邮费+运费险（不需要成本）
    const orderNumForLoss = product.orderCount || 0;
    const listRateForLoss = product.postShipRate || 0;
    const correctedRateForLoss = product.postShippingRate || 0;
    const maxRateForLoss = Math.max(listRateForLoss, correctedRateForLoss);
    if (orderNumForLoss > 0 && maxRateForLoss >= 100) {
      const lossPerOrder = -(SHIPPING_FEE + INSURANCE);
      fields['平均每单利润'] = Number(lossPerOrder.toFixed(2));
      console.log(`  平均每单利润: ${fields['平均每单利润']}元 (退货率${maxRateForLoss}%, 每单亏邮费+运费险)`);
      // 【2026-08-29】100% 退货时显式追加负向备注，触发上面的清理守卫撤回旧"利润达标"结论
      remarkParts.push(`利润不达标(退货率${maxRateForLoss}%)${today}`);
      console.log(`  备注追加: 利润不达标(退货率${maxRateForLoss}%)`);
    }

    // 计算毛利 = 最新售价 - 成本（如果成本存在）
    if (product.merchantIncome !== undefined && product.merchantIncome !== null &&
        product.cost !== undefined && product.cost !== null) {
      const grossProfit = product.merchantIncome - product.cost;
      fields['毛利'] = Number(grossProfit.toFixed(2));
      console.log(`  毛利: ${product.merchantIncome} - ${product.cost} = ${fields['毛利']}`);

      // 计算平均每单利润（用连续值，不用Math.round）
      const orderNum = product.orderCount || 0;
      const __profit = computeAvgProfitPerOrder(product, { shippingFee: SHIPPING_FEE, insurance: INSURANCE });
      const totalRefundRate = (__profit.inputs && __profit.inputs.totalRefundRate != null) ? __profit.inputs.totalRefundRate : (product.totalRefundRate || product.listReturnRate || 0);
      const successRateDecimal = totalRefundRate / 100;
      const postShipRate = (__profit.inputs && __profit.inputs.postShipRate != null) ? __profit.inputs.postShipRate : (product.postShipRefundRate || product.postShipRate || 0);
      const refundRateDecimal = postShipRate / 100;
      product.__profitStatus = __profit.status;
      product.__suggestionGate = suggestionGate(product.__rateQuality || {}, product, __profit);
      // 保留旧变量供后续干预建议逻辑使用
      const listRate = product.postShipRate || 0;
      const correctedRate = product.postShippingRate || 0;
      const maxRate = Math.max(listRate, correctedRate);
      let avgProfitPerOrder = 0;
      // 减去平均每单广告费（在if块外定义，供后续干预建议使用）
      const adCostPerOrder = product.adSpend && orderNum > 0 ? Math.max(0, Number(String(product.adSpend).replace(/[¥,]/g, ''))) / orderNum : 0;
      if (orderNum > 0) {
        if (__profit.status === 'ok' && __profit.value !== null) {
          avgProfitPerOrder = __profit.value;
          fields['平均每单利润'] = __profit.value;
          product.__profitWritten = true;
        } else if (__profit.status === 'limited_estimate') {
          avgProfitPerOrder = __profit.value;
          product.__profitWritten = false;
          console.log(`  平均每单利润受限估算(${__profit.value}) 不写回: ${__profit.reason}`);
        } else {
          avgProfitPerOrder = null;
          product.__profitWritten = false;
          console.log(`  平均每单利润不可计算: ${__profit.reason || __profit.status}`);
        }
        console.log(`  利润状态=${__profit.status}`);
      } else {
        product.__profitWritten = false;
        if (!product.__profitStatus || product.__profitStatus === 'pending') product.__profitStatus = 'absent';
      }

      // 获取现有干预内容，用于跳过已有人工标记的建议
      const recordIdForInter = existingRecords.get(productIdStr);
      const existingIntervention = recordIdForInter ? recordIntervention.get(recordIdForInter) : null;
      const interventionStr = existingIntervention ? String(existingIntervention) : '';

      // 辅助函数：判断是否应跳过干预建议（已有相同建议则跳过）
      function shouldSkipIntervention(suggestionText) {
        if (!interventionStr) return false;
        // 已有建议毛利则跳过新的建议毛利（不管金额是否相同）
        if (suggestionText.startsWith('建议毛利') && interventionStr.includes('建议毛利')) return true;
        const numMatch = suggestionText.match(/\d+/);
        if (numMatch && suggestionText.includes('毛利')) {
          const num = numMatch[0];
          const patterns = [`毛利${num}`, `毛利达到${num}`, `毛利需要增长到${num}`];
          return patterns.some(p => interventionStr.includes(p)) || interventionStr.includes(suggestionText);
        }
        return interventionStr.includes(suggestionText);
      }

      // 高退货率强制毛利至少80元：订单>10 且 发后退款率>70% 且 修正发后退货率>75%
      // 但如果平均每单利润已高于纯利3%，说明当前毛利已足够，不需要建议
      const pureProfit3High = (product.merchantIncome || 0) * 0.03;
      const __gateF = product.__suggestionGate || { actions: {} };
      const __canForce = !(__gateF.actions && __gateF.actions.FORCE_MIN_GROSS) ? true : !!__gateF.actions.FORCE_MIN_GROSS.allowed;
      if (!__canForce && orderNum > 10 && listRate > 70 && correctedRate > 75) {
        console.log(`  [DQ] 抑制强制毛利: ${JSON.stringify((__gateF.actions.FORCE_MIN_GROSS && __gateF.actions.FORCE_MIN_GROSS.blockedBy) || [])}`);
      } else if (__canForce && orderNum > 10 && listRate > 70 && correctedRate > 75 && (avgProfitPerOrder === null || avgProfitPerOrder <= pureProfit3High)) {
        if (product.cost !== undefined && product.cost !== null && product.merchantIncome) {
          const currentGross = product.merchantIncome - product.cost;
          // 按正常公式计算建议毛利
          const rd = maxRate / 100;
          const minGross = calcMinGross(product.cost, totalRefundRate, postShipRate, adCostPerOrder);
          const sg = Math.max(Number(minGross.toFixed(2)), 80); // 至少80元
          if (sg > currentGross) {
            fields['等待人工操作'] = `建议毛利${sg}元`;
            console.log(`  高退货率建议毛利: 订单${orderNum}, 退货率${maxRate}%, 需毛利${sg}, 当前毛利${currentGross.toFixed(0)}元`);
          }
        }
        // 没有成本或计算不出时，兜底80元
        if (!fields['等待人工操作']) {
          fields['等待人工操作'] = '建议毛利80元';
          console.log(`  高退货率兜底毛利80元: 订单${orderNum}, 发后退款率${listRate}%, 修正发后退货率${correctedRate}%`);
        }
      } else if (orderNum > 10 && listRate > 70 && correctedRate > 75) {
        // 利润达标时写入备注
        if (product.cost !== undefined && product.cost !== null && product.merchantIncome) {
          const minGross = calcMinGross(product.cost, totalRefundRate, postShipRate, adCostPerOrder);
          const sg = Number(minGross.toFixed(2));
          const sg5 = Number(calcMinGross(product.cost, totalRefundRate, postShipRate, adCostPerOrder, 5).toFixed(2));
          remarkParts.push(`毛利标准${sg}元(利润达标)；不建议超过${sg5}元`);
          console.log(`  毛利标准${sg}元(利润达标)；不建议超过${sg5}元: 平均每单利润${avgProfitPerOrder.toFixed(2)} > 纯利3%${pureProfit3High.toFixed(2)}`);
        }
      }
      // 判断是否需要建议毛利增长或下架（按动作分门禁）
      let suggestionText = '';
      let suggestedGrossText = '';
      const __gateS = product.__suggestionGate || { actions: {} };
      const __act = __gateS.actions || {};
      const __canDelist = __act.DELIST ? !!__act.DELIST.allowed : true;
      const __canSuggestGross = __act.SUGGEST_GROSS_INCREASE ? !!__act.SUGGEST_GROSS_INCREASE.allowed : true;
      const __canRemark = __act.REMARK_GROSS_OK ? !!__act.REMARK_GROSS_OK.allowed : true;
      if (interventionStr.includes('已下架')) {
        console.log(`  不建议下架：已经干预包含已下架`);
      } else if (__canDelist && orderNum >= 5 && maxRate > 90) {
        // 销量>=5且退货率>90%，建议下架
        suggestionText = '建议下架';
        // 同时计算建议毛利
        if (product.cost !== undefined && product.cost !== null && product.merchantIncome) {
          const minGross = calcMinGross(product.cost, totalRefundRate, postShipRate, adCostPerOrder);
          const currentGross = product.merchantIncome - product.cost;
          if (minGross > currentGross) {
            const sg = Number(minGross.toFixed(2));
            suggestedGrossText = `建议毛利${sg}元`;
            console.log(`  动态涨价建议: 成本${product.cost}, 退货率${maxRate}%, 需毛利${sg}, 当前毛利${currentGross.toFixed(0)}`);
          }
        }
        if (!shouldSkipIntervention(suggestionText)) {
          fields['等待人工操作'] = suggestedGrossText ? (suggestionText + '；' + suggestedGrossText) : suggestionText;
          console.log(`  [DQ] 下架建议写入fields: ${fields['等待人工操作']}`);
        }
      } else if (__canDelist && orderNum >= 5 && maxRate >= 100) {
        // 销量>=5且退货率=100%，建议下架
        suggestionText = '建议下架';
        // 同时计算建议毛利
        if (product.cost !== undefined && product.cost !== null && product.merchantIncome) {
          const minGross = calcMinGross(product.cost, totalRefundRate, postShipRate, adCostPerOrder);
          const currentGross = product.merchantIncome - product.cost;
          if (minGross > currentGross) {
            const sg = Number(minGross.toFixed(2));
            suggestedGrossText = `建议毛利${sg}元`;
            console.log(`  动态涨价建议: 成本${product.cost}, 退货率${maxRate}%, 需毛利${sg}, 当前毛利${currentGross.toFixed(0)}`);
          }
        }
      } else if (__canSuggestGross && orderNum >= 5 && product.cost !== undefined && product.cost !== null && product.merchantIncome) {
        // 5单以上，动态计算建议售价
        // 但如果平均每单利润已高于纯利3%，说明当前毛利已足够，不需要建议
        const pureProfit3 = product.merchantIncome * 0.03;
        if (__canRemark && avgProfitPerOrder !== null && avgProfitPerOrder > pureProfit3) {
          // 利润达标时写入备注（仅订单数>=10才写入备注，避免订单不足时生成无效毛利建议）
          if (orderNum >= 10) {
            const minGross = calcMinGross(product.cost, totalRefundRate, postShipRate, adCostPerOrder);
            const sg = Number(minGross.toFixed(2));
            const sg5 = Number(calcMinGross(product.cost, totalRefundRate, postShipRate, adCostPerOrder, 5).toFixed(2));
            remarkParts.push(`毛利标准${sg}元(利润达标)；不建议超过${sg5}元`);
            console.log(`  毛利标准${sg}元(利润达标)；不建议超过${sg5}元: 平均每单利润${avgProfitPerOrder.toFixed(2)} > 纯利3%${pureProfit3.toFixed(2)}`);
          }
        } else {
          const minGross = calcMinGross(product.cost, totalRefundRate, postShipRate, adCostPerOrder);
          const currentGross = product.merchantIncome - product.cost;
          if (minGross > currentGross) {
            const sg = Number(minGross.toFixed(2));
            suggestionText = `建议毛利${sg}元`;
            console.log(`  动态涨价建议: 成本${product.cost}, 退货率${maxRate}%, 需毛利${sg}, 当前毛利${currentGross.toFixed(0)}`);
          }
          // 订单数>=10时才写入毛利标准到备注（避免订单不足时生成无效毛利建议）
          if (orderNum >= 10 && !remarkParts.some(r => r.includes('毛利标准'))) {
            const sg = Number(minGross.toFixed(2));
            const sg5 = Number(calcMinGross(product.cost, totalRefundRate, postShipRate, adCostPerOrder, 5).toFixed(2));
            remarkParts.push(`毛利标准${sg}元；不建议超过${sg5}元`);
            console.log(`  [新逻辑] 写入毛利标准: ${sg}元, 不建议超过${sg5}元`);
          }
        }

      if (suggestionText) {
        if (shouldSkipIntervention(suggestionText)) {
          console.log(`  不写入等待人工操作：已经干预包含(${existingIntervention})`);
        } else {
          // 如果有建议毛利，追加到建议下架后面
          if (suggestedGrossText) {
            fields['等待人工操作'] = suggestionText + '；' + suggestedGrossText;
          } else {
            fields['等待人工操作'] = suggestionText;
          }
          console.log(`  等待人工操作: ${fields['等待人工操作']} (订单数${orderNum}, 退货率${maxRate}%)`);
        }
      } else {
        // 没有新建议时，清除旧的等待人工操作（保留手动干预）
        const existingOp = existingIntervention ? String(existingIntervention) : '';
        if (existingOp && !existingOp.includes('已下架') && !existingOp.includes('手动')) {
          fields['等待人工操作'] = '';
          console.log(`  清除旧等待人工操作: "${existingOp}"`);
        }
      }

      // 原有毛利低于40的逻辑（只在没有更高优先级建议时生效）
      // 根据商品编码前缀查找档口调整有效阈值
      let effectiveThreshold = 40;
      if (premiumMap && premiumMap.size > 0) {
        const code = product.merchantCode || '';
        const match = code.match(/^([a-zA-Z]+)/);
        if (match) {
          const premium = premiumMap.get(match[1].toUpperCase());
          if (premium) effectiveThreshold = 40 + premium;
        }
      }
      if (!fields['等待人工操作'] && grossProfit < effectiveThreshold) {
        const lowProfitText = `毛利低于${effectiveThreshold}`;
        if (shouldSkipIntervention('毛利低于') || interventionStr.includes('已下架')) {
          console.log(`  不写入等待人工操作：已经干预包含排除项(${existingIntervention})`);
        } else {
          fields['等待人工操作'] = lowProfitText;
          console.log(`  等待人工操作: ${lowProfitText} (${grossProfit})`);
        }
      }

      // 广告费过高警告
      const avgAdCost = product.adSpend ? Math.max(0, Number(String(product.adSpend).replace(/[¥,]/g, ''))) / orderNum : 0;
      if (!fields['等待人工操作'] && orderNum > 10 && avgAdCost > 1) {
        fields['等待人工操作'] = '广告费过高';
        console.log();
      }

      /* [DISABLED] 判断是否写入"推荐复制到其它店铺"
      const skipRecommend = existingIntervention && (String(existingIntervention).includes('过季了') || String(existingIntervention).includes('已经复制到其它店铺'));
      if (skipRecommend) {
        console.log(`  不写入推荐复制：已经干预包含(${existingIntervention})`);
      }

      const bothNot100 = listRate !== 100 && correctedRate !== 100;
      let recommendText = '';
      if (!skipRecommend && orderNum >= 3 && orderNum <= 5 && bothNot100) {
        // 订单数3-5且两个退款率都不是100%
        recommendText = '推荐复制到其它店铺';
        console.log(`  等待人工操作追加: 推荐复制到其它店铺 (订单数${orderNum}, 发后退款率${listRate}%, 修正发后退货率${correctedRate}%)`);
      } else if (!skipRecommend && orderNum >= 6 && orderNum <= 10 && maxRate < 85) {
        // 订单数6-10且最大退款率低于85%
        recommendText = '推荐复制到其它店铺';
        console.log(`  等待人工操作追加: 推荐复制到其它店铺 (订单数${orderNum}, 最大退款率${maxRate}%)`);
      } else if (!skipRecommend && orderNum > 10 && maxRate < 70) {
        // 订单数>10且最大退款率低于70%
        recommendText = '推荐复制到其它店铺';
        console.log(`  等待人工操作追加: 推荐复制到其它店铺 (订单数${orderNum}, 最大退款率${maxRate}%)`);
      }

      // 将推荐内容追加到等待人工操作（不覆盖之前的内容）
      if (recommendText) {
        if (fields['等待人工操作']) {
          fields['等待人工操作'] = fields['等待人工操作'] + '；' + recommendText;
        } else {
          fields['等待人工操作'] = recommendText;
        }
        // 推荐复制时写入毛利标准
        if (product.cost !== undefined && product.cost !== null && product.merchantIncome && !remarkParts.some(r => r.includes('毛利标准'))) {
          const minGross = calcMinGross(product.cost, totalRefundRate, postShipRate, adCostPerOrder);
          const sg = Number(minGross.toFixed(2));
          const sg5 = Number(calcMinGross(product.cost, totalRefundRate, postShipRate, adCostPerOrder, 5).toFixed(2));
          remarkParts.push(`毛利标准${sg}元；不建议超过${sg5}元`);
        }
      } [END DISABLED] */

      // 【2026-09-10 下线"建议裂变此商品"】不再向5号表"等待人工操作"生成/追加该提示。
      // 保留：订单数>15且退货占发货<70%时计算毛利标准写入备注的规则（其余建议与人工内容不受影响）。
      if (orderNum > 15) {
        let shipRefundRatio = totalRefundRate > correctedRate ? (correctedRate / (100 - (totalRefundRate - correctedRate))) * 100 : correctedRate;
        // NaN 防护
        if (!Number.isFinite(shipRefundRatio)) {
          shipRefundRatio = 0;
        }
        if (shipRefundRatio < 70) {
          if (product.cost !== undefined && product.cost !== null && product.merchantIncome && !remarkParts.some(r => r.includes('毛利标准'))) {
            const minGross = calcMinGross(product.cost, totalRefundRate, postShipRate, adCostPerOrder);
            const sg = Number(minGross.toFixed(2));
            const sg5 = Number(calcMinGross(product.cost, totalRefundRate, postShipRate, adCostPerOrder, 5).toFixed(2));
            remarkParts.push(`毛利标准${sg}元；不建议超过${sg5}元`);
          }
        }
      }

      /*
      // 如果当前平均每单利润高于6元，在备注写入毛利标准
      // 平均每单利润 = (1-退货率) × (毛利 - 扣点5% - 邮费 - 运费险) - (邮费 + 运费险) × 退货率
      const commission = (product.merchantIncome || 0) * 0.05;
      const fixedCostPerRefund = SHIPPING_FEE + INSURANCE; // 6.11
      const r = maxRate / 100;
      // 平均每单利润 = (1-r) × (毛利 - commission - fixedCostPerRefund) - fixedCostPerRefund × r
      const avgProfitPerOrder = (1 - r) * (grossProfit - commission - fixedCostPerRefund) - fixedCostPerRefund * r;
      // 毛利标准 = 平均每单利润5元时需要的毛利
      // 5 = (1-r) × (GP - commission - 6.11) - 6.11 × r
      // GP = (5 + 6.11×r) / (1-r) + commission + 6.11
      const requiredGPFor5Profit = (5 + fixedCostPerRefund * r) / (1 - r) + commission + fixedCostPerRefund;
      console.log(`  [毛利标准计算] 售价=${product.merchantIncome}, 毛利=${grossProfit}, 退货率=${maxRate}%`);
      console.log(`  [毛利标准计算] 毛利标准(5元/单)=${requiredGPFor5Profit.toFixed(1)}, 实际平均每单利润=${avgProfitPerOrder.toFixed(2)}, 阈值=6`);
      if (avgProfitPerOrder > 6) {
        remarkParts.push(`当前退货率${maxRate.toFixed(1)}%，毛利标准${Math.ceil(requiredGPFor5Profit)}`);
        console.log(`  备注追加: 当前退货率${maxRate.toFixed(1)}%，毛利标准${Math.ceil(requiredGPFor5Profit)}`);
      }
      */
    }
    }

    // 如果成本未找到，添加备注
    if (product.cost === undefined || product.cost === null) {
      remarkParts.push('成本获取失败');
      console.log(`  备注追加: 成本获取失败`);
    }

    // 如果发后退款率 > 修正发后退货率 超过5%，添加备注
    if (product.postShipRate !== undefined && product.returnRate !== undefined &&
        product.postShipRate !== null && product.returnRate !== null) {
      const diff = product.postShipRate - product.returnRate;
      if (diff > 5) {
        remarkParts.push(`注意退货率正在增长${today}`);
        console.log(`  备注追加: 注意退货率正在增长${today} (差值: ${diff.toFixed(2)}%)`);
      }
    }

    // 检测销量下滑：新订单数比原订单数少5以上
    const recordId = existingRecords.get(productIdStr);
    if (recordId && product.orderCount !== undefined && product.orderCount !== null) {
      const oldOrderCount = recordOrderCounts.get(recordId);
      if (oldOrderCount !== undefined) {
        const change = Number(product.orderCount) - oldOrderCount;
        if (change >= 5) {
          remarkParts.push(`销量上涨中，${oldOrderCount}→${product.orderCount}`);
          console.log(`  备注追加: 销量上涨中，${oldOrderCount}→${product.orderCount} (增加${change})`);
        } else if (change <= -5) {
          remarkParts.push(`销量正在下滑，${oldOrderCount}→${product.orderCount}`);
          console.log(`  备注追加: 销量正在下滑，${oldOrderCount}→${product.orderCount} (减少${-change})`);
        }
      }
    }

    // 如果有备注内容，合并现有备注后写入
    if (remarkParts.length > 0) {
      const newRemark = remarkParts.join('；');
      let existingRemark = recordId ? recordRemarks.get(recordId) : null;

      // 如果获取了成本，清除现有备注中的"成本获取失败"
      if (existingRemark && product.cost !== undefined && product.cost !== null) {
        if (existingRemark.includes('成本获取失败')) {
          existingRemark = existingRemark.replace(/成本获取失败[；;]?/g, '').replace(/^[；;]+|[；;]+$/g, '').trim();
          console.log(`  备注清理: 删除"成本获取失败"`);
        }
      }

      // 如果新备注包含毛利标准，或本轮进入利润崩塌态（平均每单利润为负），
      // 都清除现有备注中的旧毛利标准（替换而非追加）。
      // 【2026-08-29】旧守卫只在"本次写了新毛利标准"时清理，导致利润崩塌时（退货100%/orderNum<10/走建议下架路径）
      // 本轮没生成新毛利标准 → 旧"毛利标准…(利润达标)；不建议超过…"残留（append-only 语义）。
      // 现扩展守卫：利润崩塌（平均每单利润<0）也强制清旧毛利标准，避免反向语义。
      // 注意：原方案还想用 100% 退货作为触发条件，但 orderNumForLoss/maxRateForLoss 在 1383 的 else 块内
      // 声明、1731 守卫在块外，引用会 ReferenceError 运行时崩溃；改用 fields['平均每单利润'] 单字段判定。
      // 100% 退货路径在 1389 行的 if 内已经把平均每单利润设为 -(邮费+运费险)，会 <0 自动命中守卫。
      const hasNewMarginRemark = remarkParts.some(r => r.includes('毛利标准') || r.includes('不建议超过'));
      const profitCollapsed = fields['平均每单利润'] != null && fields['平均每单利润'] < 0;
      if ((hasNewMarginRemark || profitCollapsed) && existingRemark) {
        existingRemark = existingRemark.replace(/毛利标准[\d.]+元[^；;]*(?:；不建议超过[\d.]+元)?/g, '').replace(/^[；;]+|[；;]+$/g, '').replace(/[；;]{2,}/g, '；').trim();
        console.log(`  备注清理: 删除旧毛利标准，准备写入新的${profitCollapsed ? '（利润崩塌触发）' : ''}`);
      }

      if (existingRemark) {
        // 过滤掉已存在的备注项，避免重复
        const existingParts = existingRemark.split(/[；;]/).map(s => s.trim()).filter(s => s);
        const newParts = remarkParts.filter(p => !existingParts.includes(p));
        if (newParts.length > 0) {
          fields['备注'] = existingRemark + '；' + newParts.join('；');
          console.log(`  备注追加到现有: "${existingRemark}" + "${newParts.join('；')}"`);
        } else {
          // 所有新备注已存在，不更新
          console.log(`  备注跳过: 所有内容已存在`);
        }
      } else {
        fields['备注'] = newRemark;
        console.log(`  备注写入: "${newRemark}"`);
      }
    } else if (recordId) {
      // 即使没有新备注，如果获取了成本也要清除"成本获取失败"
      const existingRemark = recordRemarks.get(recordId);
      if (existingRemark && product.cost !== undefined && product.cost !== null) {
        if (existingRemark.includes('成本获取失败')) {
          const cleanedRemark = existingRemark.replace(/成本获取失败[；;]?/g, '').replace(/^[；;]+|[；;]+$/g, '').trim();
          if (cleanedRemark) {
            fields['备注'] = cleanedRemark;
            console.log(`  备注清理: 删除"成本获取失败", 保留: "${cleanedRemark}"`);
          } else {
            fields['备注'] = '';
            console.log(`  备注清理: 删除"成本获取失败", 备注已清空`);
          }
        }
      }
    }
    } // 【2026-09-10 修复假写入循环】else 在此闭合，销量=1 分支与常规分支自此合流：
      // 下方"商品图片"赋值与飞书 create/update 执行块为公共路径，销量=1 商品同样真实写入。
      // 原先 else 一直延伸到写入块之后，导致销量=1 商品只算字段不发请求却返回成功。

    // 如果有图片token，添加图片字段
    if (product.imageFileToken) {
      fields['商品图片'] = [{ 'file_token': product.imageFileToken }];
    }

    // 不添加商品名称字段，因为表中可能没有该字段

    if (existingRecords.has(productIdStr)) {
      // 更新现有记录
      const recordId = existingRecords.get(productIdStr);
      console.log(`更新 [${product.id}] 成交订单数:${product.orderCount} 退货率:${product.returnRate}...`);

      // 获取现有记录的成本（如果新成本未获取到则使用旧成本）
      const existingCost = recordCosts.get(recordId);
      if ((product.cost === undefined || product.cost === null) && existingCost !== undefined && existingCost !== null) {
        product.cost = existingCost;
        fields['成本'] = Number(existingCost);
        console.log(`  使用现有成本: ${existingCost}`);
      }

      const existingIntervention = recordIntervention.get(recordId);

      const __ledgerReq = createLedgerRequest(productIdStr);
      const __ident = { tableId: process.env.SOURCE_TABLE_ID || CONFIG.feishu.table_id, platform: 'douyin', shopName, productId: productIdStr, fieldKey: '等待人工操作' };
      {
        const __trail = applyStaleInvalidation({
          fields,
          identity: __ident,
          existingFields: recordFullFields.get(recordId) || {},
          isUpdate: true,
          profitStatus: product.__profitStatus || 'absent',
          profitWritten: !!product.__profitWritten,
          alreadyIntervention: existingIntervention || undefined,
          omitAlreadyIntervention: true,
        });
        product.__staleTrail = __trail;
        if (__trail.actions && __trail.actions.length) {
          console.log(`  [STALE] ${productIdStr}: ${__trail.actions.join(',')} omitted=${JSON.stringify(__trail.omittedFields)} intent=${__trail.ledgerIntent}`);
        }
        if (__trail.conflicts && __trail.conflicts.length) {
          console.log(`  [STALE-CONFLICT] ${productIdStr}: ${JSON.stringify(__trail.conflicts)}`);
        }
        if (!__trail.omittedFields.includes('等待人工操作') && productIdStr) {
          const opV = fields['等待人工操作'];
          if (opV === '') __ledgerReq.queueClear(__ident);
          else if (opV != null) __ledgerReq.queueWrite(__ident, opV);
        }
      }

      let writeSuccess = false;
      for (let attempt = 1; attempt <= 3 && !writeSuccess; attempt++) {
        try {
          const updateUrl = `${baseUrl}/records/${recordId}`;
          const response = await fetch(updateUrl, {
            method: 'PUT',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify({ fields })
          });
          const result = await response.json();
          if (result.code === 0) {
            console.log(`更新成功 [${product.id}]`);
            writeSuccess = true;
            __ledgerReq.commit({ success: true, recordId, productId: productIdStr });
            // 【2026-09-10】allSuccess 为 AND 累计：不再置回 true，避免后续成功覆盖前面的失败
          } else {
            console.error(`更新失败 [${product.id}]: ${JSON.stringify(result)}`);
          }
        } catch (e) {
          console.error(`更新网络错误 [${product.id}]: ${fmtErr(e)}`);
          if (attempt < 3) await sleep(2000);
        }
      }
      if (!writeSuccess) {
        allSuccess = false;
        __ledgerReq.abort('put_failed');
        console.log(`  [LEDGER] PUT未确认成功 ${productIdStr}`);
      }
    } else {
      // 创建新记录
      console.log(`创建 [${product.id}] 成交订单数:${product.orderCount} 退货率:${product.returnRate}...`);

      const __ledgerReq = createLedgerRequest(productIdStr);
      const __ident = { tableId: process.env.SOURCE_TABLE_ID || CONFIG.feishu.table_id, platform: 'douyin', shopName, productId: productIdStr, fieldKey: '等待人工操作' };
      {
        const opV = fields['等待人工操作'];
        if (opV === '') __ledgerReq.queueClear(__ident);
        else if (opV != null) __ledgerReq.queueWrite(__ident, opV);
      }

      let writeSuccess = false;
      for (let attempt = 1; attempt <= 3 && !writeSuccess; attempt++) {
        try {
          const createUrl = `${baseUrl}/records`;
          const response = await fetch(createUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${accessToken}`
            },
            body: JSON.stringify({ fields })
          });
          const result = await response.json();
          if (result.code === 0) {
            console.log(`创建成功 [${product.id}]`);
            existingRecords.set(productIdStr, result.data.record.record_id);
            writeSuccess = true;
            __ledgerReq.commit({ success: true, recordId: result.data.record.record_id, productId: productIdStr });
            // 【2026-09-10】allSuccess 为 AND 累计：不再置回 true，避免后续成功覆盖前面的失败
          } else {
            console.error(`创建失败 [${product.id}]: ${JSON.stringify(result)}`);
          }
        } catch (e) {
          console.error(`创建网络错误 [${product.id}]: ${fmtErr(e)}`);
          if (attempt < 3) await sleep(2000);
        }
      }
      if (!writeSuccess) {
        allSuccess = false;
        __ledgerReq.abort('post_failed');
        console.log(`  [LEDGER] POST未确认成功 ${productIdStr}`);
      }
    }
  }

  return allSuccess;
}

async function waitForQRCodeLogin(page) {
  process.stdout.write('请使用抖音App扫码登录...\n');
  process.stdout.write('等待扫码完成（超时10分钟）...\n');

  try {
    // Playwright 签名为 waitForFunction(pageFunction, arg, options)：arg 必须显式 null，
    // 超时 options 才能落在第三参（原先 options 错占 arg 位，实际生效的是默认30秒超时）。
    await page.waitForFunction(() => {
      return window.location.href.includes('fxg.jinritemai.com/ffa/mshop/homepage');
    }, null, { timeout: 600000 });
    const currentUrl = page.url();
    process.stdout.write('登录成功！当前URL: ' + currentUrl + '\n');
    return true;
  } catch (e) {
    const currentUrl = page.url();
    process.stdout.write('等待超时或页面跳转，当前URL: ' + currentUrl + '\n');
    return false;
  }
}

// 打开详情页获取真实退货率
async function getDetailPageData(context, page, productId) {
  console.log(`\n获取商品 ${productId} 的详情页数据...`);

  // 点击"查看详情"按钮
  const clicked = await page.evaluate((pid) => {
    const rows = document.querySelectorAll('table tbody tr:not(.ecom-table-measure-row)');
    for (const row of rows) {
      const text = row.innerText;
      if (text.includes(pid)) {
        const buttons = row.querySelectorAll('button, a');
        for (const btn of buttons) {
          if (btn.innerText?.includes('查看详情')) {
            btn.click();
            return true;
          }
        }
      }
    }
    return false;
  }, productId);

  if (!clicked) {
    console.log('未找到查看详情按钮');
    return null;
  }

  // 等待新页面出现
  await pausableSleep(5000);

  // 找到详情页
  let detailPage = null;
  const currentPages = context.pages();
  for (const p of currentPages) {
    if (p.url().includes('product-detail') && p.url().includes(productId)) {
      detailPage = p;
      break;
    }
  }

  if (!detailPage) {
    for (const p of currentPages) {
      if (p.url().includes('product-detail')) {
        detailPage = p;
        break;
      }
    }
  }

  if (!detailPage) {
    console.log('未找到详情页');
    return null;
  }

  // 确保详情页在前台（不调用bringToFront，避免页面不稳定）
  console.log('找到详情页，等待15秒让页面稳定...');
  await pausableSleep(15000);

  // 点击"退款及体验" - 优先用文本匹配，回退到坐标
  console.log('点击退款及体验...');
  try {
    if (detailPage.isClosed()) {
      console.log('详情页已关闭');
      return null;
    }
    // 先尝试用文本匹配点击
    const clicked = await detailPage.evaluate(() => {
      // 更精确地查找"退款及体验"标签 - 必须是精确匹配，不是包含
      const tabs = document.querySelectorAll('div, span, a, button');
      const candidates = [];
      for (const tab of tabs) {
        const text = (tab.innerText || '').trim();
        // 必须精确匹配"退款及体验"，不能是其他包含这两个词的元素
        if (text === '退款及体验' && tab.offsetParent !== null) {
          candidates.push({ element: tab, text: text, tag: tab.tagName });
        }
      }
      // 优先点击精确匹配的元素
      if (candidates.length > 0) {
        candidates[0].element.click();
        console.log(`点击了精确匹配的"退款及体验"标签 (${candidates[0].tag})`);
        return true;
      }
      // 回退：查找包含这两个词的最小文本元素
      for (const tab of tabs) {
        const text = (tab.innerText || '').trim();
        if (text.includes('退款') && text.includes('体验') && text.length < 20 && tab.offsetParent !== null) {
          tab.click();
          console.log(`点击了包含"退款"和"体验"的元素: "${text}" (${tab.tagName})`);
          return true;
        }
      }
      return false;
    });
    if (clicked) {
      console.log('通过文本匹配点击退款及体验成功');
    } else {
      // 回退到坐标点击
      console.log('文本匹配失败，尝试坐标点击...');
      await detailPage.mouse.click(280, 260);
    }
    console.log('等待15秒让数据加载...');
    await pausableSleep(15000);
    // 截图保存退款及体验页面
    try {
      if (!detailPage.isClosed()) {
        await detailPage.screenshot({ path: 'detail-refund-tab.png', timeout: 10000 });
        console.log('已保存退款及体验页面截图: detail-refund-tab.png');
      }
    } catch (e) {
      console.log('截图失败:', fmtErr(e));
    }
  } catch (e) {
    console.log('点击退款及体验失败:', fmtErr(e));
  }

  // 点击「自定义」弹出日历面板
  // 注意：绝不按"日期格式文本"定位点击目标——商品头的「上架时间 2026/06/27」也是日期文本，
  // 正则扫全页会先命中它，导致点错位置。这里只点文本恰为「自定义」且位于标签行的元素。
  console.log('点击自定义日期...');
  try {
    if (detailPage.isClosed()) {
      console.log('详情页已关闭');
      return null;
    }
    const customRect = await detailPage.evaluate(() => {
      // 自定义按钮不一定是 <button>，span/div/a 都可能
      for (const el of document.querySelectorAll('button, div, span, a')) {
        const text = (el.innerText || '').trim();
        if (text !== '自定义') continue;
        const r = el.getBoundingClientRect();
        // 限定在日期标签行（top 250~400），避免误点页面其它「自定义」
        if (r.width > 0 && r.top > 250 && r.top < 400) {
          return { x: r.left + r.width / 2, y: r.top + r.height / 2, tag: el.tagName };
        }
      }
      return null;
    });
    if (customRect) {
      await detailPage.mouse.click(customRect.x, customRect.y);
      console.log(`已点击「自定义」(${customRect.tag})，等待日历面板...`);
    } else {
      console.log('[WARN] 未找到「自定义」按钮');
    }
    await pausableSleep(3000);
  } catch (e) {
    console.log('点击自定义失败:', fmtErr(e));
  }

  // 设置日期 - 页面改版后键盘输入不再触发查询，必须用鼠标点选日历格子（2026-08 修复）
  const startDateStr = CONFIG.dateRange.startDate;   // YYYY/MM/DD
  const endDateStr = CONFIG.dateRange.endDate;       // YYYY/MM/DD
  // 日历格子 title 属性为 YYYY-MM-DD 格式
  const startDateKey = startDateStr.replace(/\//g, '-');
  const endDateKey = endDateStr.replace(/\//g, '-');
  console.log(`设置日期范围: ${startDateStr} 到 ${endDateStr}`);

  try {
    // 穿透 shadow DOM 查找「开始日期/结束日期」输入框（用于面板弹出检测与最终校验）
    const findDateInputs = () => detailPage.evaluate(() => {
      function deepAll(root, out) {
        out = out || [];
        for (const el of root.querySelectorAll('*')) {
          out.push(el);
          if (el.shadowRoot) deepAll(el.shadowRoot, out);
        }
        return out;
      }
      const arr = [];
      for (const el of deepAll(document)) {
        if (el.tagName !== 'INPUT') continue;
        const ph = el.placeholder || '';
        if (ph !== '开始日期' && ph !== '结束日期') continue;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (s.display === 'none' || s.visibility === 'hidden' || r.width < 50) continue;
        arr.push({ ph, value: el.value || '', x: r.left + r.width / 2, y: r.top + r.height / 2 });
      }
      arr.sort((a, b) => a.x - b.x);
      return arr;
    });

    // 面板弹出可能需要时间，重试等待输入框出现
    let dateInputs = [];
    for (let i = 0; i < 5; i++) {
      dateInputs = await findDateInputs();
      if (dateInputs.length >= 2) break;
      await sleep(1500);
    }
    console.log('日期输入框:', JSON.stringify(dateInputs));

    if (dateInputs.length >= 2) {
      // ===== 鼠标点选日历格子（替代键盘输入）=====
      // 【操作逻辑备注（2026-08-28 修复「未找到开始日期格」后更新，改动前先读完本段）】
      // 日历面板 DOM 结构（Aurora 组件库，light DOM 与 shadow DOM 混合，必须 deepAll 穿透查找）：
      //   DIV.aurora-picker-panels          ← 双月面板容器，默认显示 [当月|次月]，如 8月|9月
      //   └ DIV.aurora-picker-panel         ← 单月面板
      //      ├ DIV.aurora-picker-header     ← 面板头，翻页按钮均为 <button> 且 text 为空：
      //      │     button.aurora-picker-header-super-prev-btn  上一年
      //      │     button.aurora-picker-header-prev-btn        上一月 ← 开始日期在上月时点它
      //      │     DIV.aurora-picker-header-view               月份标题（如"2026年8月"，用于验证翻月生效）
      //      │     button.aurora-picker-header-next-btn        下一月 ← 结束日期在次月时点它
      //      │     button.aurora-picker-header-super-next-btn  下一年
      //      └ TABLE.aurora-picker-content  ← 日历格子 TD.aurora-picker-cell，title="YYYY-MM-DD"。
      //            非本月日期也会渲染（补齐首尾周，如 8月面板头部带 7/27~7/31 的尾格），
      //            所以「目标日期是上月」≠「面板一定没有该格子」，7月上旬可能直接可见；
      //            禁用格 class 含 aurora-picker-cell-disabled（店铺数据只保留有限天数）。
      // 整体流程：点「自定义」→ 弹面板 → 开始日期不在面板则向左翻月 → 点开始格子 →
      //           结束日期不在面板则翻月（方向自动判断）→ 点结束格子 → 点空白处 + 「确定」→ 校验生效。
      // ⚠️ 修复记录（本次 bug 根因，勿再犯同类错误）：
      //   旧 findMonthNav 用绝对屏幕坐标过滤按钮（r.top>300 && r.top<700）。2026-08-28 页面布局上移，
      //   按钮实际 top=290，过滤条件全部失配 → findMonthNav 恒返回 null → 翻月循环空转 →
      //   日志报「未找到开始日期格 2026-07-19」（特征：该 WARN 与「日期输入框」日志同一秒输出 =
      //   一次翻月都没点成）。修复原则：定位面板内元素一律用「类名精确匹配 + 面板矩形几何包含」，
      //   禁止写死屏幕坐标范围——罗盘页面任何一次改版/上移都可能让绝对坐标失效。
      // 【下次再报「未找到 xx 日期格」的排查顺序（按下方 dumpPickerDiagnostics 的日志输出）】
      //   1. 看 cellsByMonth：目标月份是否已翻到面板里？
      //      在但仍报未找到 → 格子 title 格式变了（应为 YYYY-MM-DD）或 cell class 改名 → 更新 findCell；
      //   2. 看 panelButtons 为空或类名不对 → 翻月按钮 class 改名了 → 把新类名更新到 revealCell 里的两个 token；
      //   3. 看 headerViews 翻月前后没变化 → 按钮找到了但点击无效（被遮挡/禁用）→ 检查 disabled 字段和遮挡弹窗。
      const findCell = async (dateKey) => detailPage.evaluate((key) => {
        function deepAll(root, out) {
          out = out || [];
          for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) deepAll(el.shadowRoot, out); }
          return out;
        }
        for (const el of deepAll(document)) {
          if (el.tagName !== 'TD') continue;
          if (!/aurora-picker-cell/.test(String(el.className))) continue;
          if ((el.getAttribute('title') || '') !== key) continue;
          if (/aurora-picker-cell-disabled/.test(String(el.className))) continue; // 跳过禁用格
          const r = el.getBoundingClientRect();
          if (r.width <= 0) continue;
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        }
        return null;
      }, dateKey);

      // 读取双月面板当前显示的月份标题（DOM 顺序=左面板在前），如 ["2026年8月","2026年9月"]。
      // 用于：① 计算目标日期的翻月方向；② 翻月后校验标题真的变了（防止空点死循环）。
      const readPanelMonths = () => detailPage.evaluate(() => {
        function deepAll(root, out) {
          out = out || [];
          for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) deepAll(el.shadowRoot, out); }
          return out;
        }
        return deepAll(document)
          .filter(el => /aurora-picker-header-view/.test(String(el.className)))
          .map(el => (el.textContent || '').trim())
          .filter(Boolean);
      });

      // 面板结构诊断：找不到格子/按钮时把面板真实结构打进日志，下次出错可直接对着日志改定位逻辑
      const dumpPickerDiagnostics = () => detailPage.evaluate(() => {
        function deepAll(root, out) {
          out = out || [];
          for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) deepAll(el.shadowRoot, out); }
          return out;
        }
        const all = deepAll(document);
        const vis = el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
        const panels = all.filter(el => el.tagName === 'DIV' && /^aurora-picker-panels?$/.test(String(el.className)) && vis(el))
          .map(el => { const r = el.getBoundingClientRect(); return { left: Math.round(r.left), top: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; });
        const headerViews = all.filter(el => /aurora-picker-header-view/.test(String(el.className))).map(el => (el.textContent || '').trim());
        const panelButtons = all.filter(el => el.tagName === 'BUTTON' && /aurora-picker/.test(String(el.className)) && vis(el))
          .map(el => { const r = el.getBoundingClientRect(); return { cls: String(el.className), top: Math.round(r.top), left: Math.round(r.left), disabled: !!el.disabled }; });
        const cellsByMonth = {};
        for (const c of all) {
          if (c.tagName !== 'TD' || !/aurora-picker-cell/.test(String(c.className))) continue;
          const t = (c.getAttribute('title') || '').substring(0, 7);
          if (t) cellsByMonth[t] = (cellsByMonth[t] || 0) + 1;
        }
        return { panels, headerViews, panelButtons, cellsByMonth };
      });

      // 翻月按钮定位（2026-08-28 重写）：classList 精确匹配 token（避免 super-prev/next-btn 被
      // includes 误命中）+「按钮中心落在可见日历面板矩形内」做范围限定。
      // ⚠️ 不要改回绝对坐标过滤（如 r.top>300）：那是本次事故根因，见上方修复记录。
      const findMonthNav = async (cls) => detailPage.evaluate((c) => {
        function deepAll(root, out) {
          out = out || [];
          for (const el of root.querySelectorAll('*')) { out.push(el); if (el.shadowRoot) deepAll(el.shadowRoot, out); }
          return out;
        }
        const all = deepAll(document);
        // 面板容器：aurora-picker-panel（单月）/ aurora-picker-panels（双月容器）都算，
        // 用完整类名锚定正则，避免误匹配 aurora-picker-panel-layout 等外层布局元素
        const panelRects = all.filter(el => el.tagName === 'DIV' && /^aurora-picker-panels?$/.test(String(el.className)))
          .map(el => el.getBoundingClientRect()).filter(r => r.width > 0);
        const insidePanel = (r) => panelRects.some(p =>
          r.left + r.width / 2 >= p.left && r.left + r.width / 2 <= p.right &&
          r.top + r.height / 2 >= p.top && r.top + r.height / 2 <= p.bottom);
        const hits = all.filter(el => el.tagName === 'BUTTON' && el.classList && el.classList.contains(c))
          .map(el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: !!el.disabled, inside: insidePanel(r) }; })
          .filter(o => !o.disabled && o.inside);
        if (hits.length === 0) return null;
        hits.sort((a, b) => a.x - b.x); // 双月面板取最左按钮（左侧面板控制开始月份）
        return { x: hits[0].x, y: hits[0].y };
      }, cls);

      // 把日历翻到 dateKey 所在月份并返回该格子坐标（找不到则返回 null）。
      // 翻月方向由「最左面板标题月份 vs 目标月份」自动判断（字符串比较 YYYY-MM 跨年也正确），
      // 每次翻页后校验面板标题变化，翻不动（按钮消失/点击无效）立即停并 dump 面板结构。
      const revealCell = async (dateKey, maxFlips) => {
        let cell = await findCell(dateKey);
        if (cell) return cell; // 目标月已渲染（含首尾周补位格），直接用
        const targetYm = dateKey.substring(0, 7); // YYYY-MM
        for (let i = 0; !cell && i < (maxFlips || 12); i++) {
          const months = await readPanelMonths();
          const m = (months[0] || '').match(/(\d{4})年(\d{1,2})月/); // months[0]=左面板
          let dir = 0; // -1=上一月(prev) 1=下一月(next)
          if (m) {
            const curYm = `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`;
            dir = targetYm < curYm ? -1 : (targetYm > curYm ? 1 : 0);
          }
          if (dir === 0) {
            console.log(`[WARN] 无法判断 ${dateKey} 翻月方向（面板标题: ${months.join('|') || '空'}），面板结构: ${JSON.stringify(await dumpPickerDiagnostics())}`);
            break;
          }
          const btn = await findMonthNav(dir < 0 ? 'aurora-picker-header-prev-btn' : 'aurora-picker-header-next-btn');
          if (!btn) {
            console.log(`[WARN] 未找到${dir < 0 ? '上一月' : '下一月'}按钮，面板结构: ${JSON.stringify(await dumpPickerDiagnostics())}`);
            break;
          }
          await detailPage.mouse.click(btn.x, btn.y);
          await sleep(1200);
          const after = await readPanelMonths();
          if (JSON.stringify(months) === JSON.stringify(after)) {
            console.log(`[WARN] 翻月后面板标题未变化(${months.join('|')})，按钮点击可能失效，停止翻月`);
            break;
          }
          cell = await findCell(dateKey);
        }
        return cell;
      };

      // 点开始日期格：开始日期=今天-40，常在上个月，revealCell 会自动向前翻月
      const startCell = await revealCell(startDateKey);
      if (startCell) {
        await detailPage.mouse.click(startCell.x, startCell.y);
        console.log(`已点选开始日期格: ${startDateKey}`);
        await sleep(1200);
      } else {
        console.log(`[WARN] 未找到开始日期格 ${startDateKey}，面板结构: ${JSON.stringify(await dumpPickerDiagnostics())}`);
      }

      // 点结束日期格：结束日期=今天-10，多数在当月；若配置改大会自动向后翻月
      const endCell = await revealCell(endDateKey);
      if (endCell) {
        await detailPage.mouse.click(endCell.x, endCell.y);
        console.log(`已点选结束日期格: ${endDateKey}`);
        await sleep(1200);
      } else {
        console.log(`[WARN] 未找到结束日期格 ${endDateKey}，面板结构: ${JSON.stringify(await dumpPickerDiagnostics())}`);
      }

      console.log('日期已点选，等待面板应用...');
      await sleep(2500);

      // 补一次页面空白处点击：关闭日历面板并确保区间提交生效（偶发仅回车不确认）
      // 实测截图确认该坐标为退款趋势图空白区，点击无副作用
      try {
        await detailPage.mouse.click(700, 700);
        await sleep(2000);
      } catch (e) {
        console.log('空白确认点击失败（忽略）:', fmtErr(e));
      }

      // 点击「确定」按钮（若存在；该面板通常点空白处即生效，确定可能不存在）
      // 定位方式与 findMonthNav 同一原则：文本精确匹配 +「元素落在日历面板矩形内」限定，
      // ⚠️ 不用绝对 top 坐标过滤（旧版 r.top>300 与翻月按钮同款隐患，布局一移就失配）。
      // 面板外出现同名「确定」（如页面其它弹窗）不会误点。
      const confirmClicked = await detailPage.evaluate(() => {
        function deepAll(root, out) {
          out = out || [];
          for (const el of root.querySelectorAll('*')) {
            out.push(el);
            if (el.shadowRoot) deepAll(el.shadowRoot, out);
          }
          return out;
        }
        const all = deepAll(document);
        const panelRects = all.filter(el => el.tagName === 'DIV' && /^aurora-picker-panels?$/.test(String(el.className)))
          .map(el => el.getBoundingClientRect()).filter(r => r.width > 0);
        const insidePanel = (r) => panelRects.some(p =>
          r.left + r.width / 2 >= p.left && r.left + r.width / 2 <= p.right &&
          r.top + r.height / 2 >= p.top && r.top + r.height / 2 <= p.bottom);
        for (const el of all) {
          if (!/^(BUTTON|SPAN|A)$/.test(el.tagName)) continue;
          const t = (el.innerText || '').trim();
          if (t !== '确定' && t !== '确 定') continue;
          const r = el.getBoundingClientRect();
          if (r.width > 0 && insidePanel(r)) { el.click(); return true; }
        }
        return false;
      });
      if (confirmClicked) console.log('已点击「确定」');
      await pausableSleep(3000);

      // 校验：日期显示已更新为设置的区间（日期显示可能是 input 的 value，innerText 不含表单值，两者都查）
      const applied = await detailPage.evaluate((start) => {
        if (document.body.innerText.includes(start)) return true;
        function deepAll(root, out) {
          out = out || [];
          for (const el of root.querySelectorAll('*')) {
            out.push(el);
            if (el.shadowRoot) deepAll(el.shadowRoot, out);
          }
          return out;
        }
        return deepAll(document).some(el => el.tagName === 'INPUT' && (el.value || '').includes(start));
      }, startDateStr);
      console.log(applied ? `日期范围已生效: ${startDateStr} 到 ${endDateStr}` : `[WARN] 日期显示未确认更新，数据可能仍是默认区间`);
      await pausableSleep(5000);
    } else {
      console.log('[WARN] 未找到日期输入框，日历面板可能未弹出，数据将是默认区间');
    }
  } catch (e) {
    console.log('填充日期失败:', fmtErr(e));
  }

  // 提取所有数据：退货率、退款人数、退款订单数、发货后退款率（投放消耗已改为只从列表页获取）
  let refundRate = null;
  let preShipRefundRate = null;
  let postShipRefundRate = null;
  let refundCount = null;
  let refundOrderCount = null;
  let postShippingRate = null;
  let adSpend = null;
  try {
    if (detailPage.isClosed()) {
      console.log('详情页已关闭');
      return null;
    }
    // 【2026-08-29 修复】pageText 改为轮询等待后填充（见下方"等待数据卡片渲染完成"块）：
    // 日期真正生效后卡片走"清空→重请求→重渲染"，固定 sleep 5s 常早于渲染完成，抓到全 null。
    let pageText = '';

    // 修正发后退货率提取：从页面文本中定位各卡片的退款率
    // 页面可能有两种布局：
    // 1. 交错布局：卡片标题+数据依次出现（全部...发货前退款...未收货退款...已收货退款）
    // 2. 标签标题在前：所有卡片标题集中在顶部，数据在下方

    // 辅助函数：从文本中提取退款率（跳过同行基准值）
    function extractRefundRateFromText(text) {
      const rateIdx = text.indexOf('退款率');
      if (rateIdx === -1) return null;
      const afterRate = text.substring(rateIdx);
      const lines = afterRate.split('\n').filter(l => l.trim());

      // 1. 先看同一行是否有百分比
      const sameLine = lines[0] || '';
      const sameLineMatch = sameLine.match(/(\d+\.?\d*)%/);
      if (sameLineMatch) {
        const val = parseFloat(sameLineMatch[1]);
        if (val >= 0 && val <= 100) return val;
      }

      // 2. 看后续2-3行，跳过同行/好评/复购相关行
      for (const line of lines.slice(1, 4)) {
        if (/同行|好评|复购/.test(line)) continue;
        const match = line.match(/(\d+\.?\d*)%/);
        if (match) {
          const val = parseFloat(match[1]);
          if (val >= 0 && val <= 100) return val;
        }
      }
      return null;
    }

    // 辅助函数：查找字符串在文本中所有出现位置
    function findAllOccurrences(text, search) {
      const indices = [];
      let idx = text.indexOf(search);
      while (idx !== -1) {
        indices.push(idx);
        idx = text.indexOf(search, idx + 1);
      }
      return indices;
    }

    // ===== 等待数据卡片渲染完成（2026-08-29 修复「提取到退货率: null%」）=====
    // 【为什么以前没暴露】此前日期点选一直失败（翻月按钮定位 bug），详情页停留在默认近30天
    // 已渲染数据上，提取的永远是现成文本；日期修复后页面第一次真正切换日期区间，
    // 卡片走"清空→重请求→重渲染"，原固定 5s 等待早于渲染完成，抓到全 null。
    // 【等待条件】用 extractRefundRateFromText（与正式提取同源）判断：出现数值且连续两次
    // 轮询一致才算稳定；最多等 30s，超时退化为现状（null 由既有兜底吸收）。
    {
      const waitT0 = Date.now();
      let lastRate = null;
      let stableCount = 0;
      while (Date.now() - waitT0 < 30000) {
        pageText = await detailPage.evaluate(() => document.body.innerText);
        const curRate = extractRefundRateFromText(pageText);
        if (curRate !== null && curRate === lastRate) {
          stableCount++;
          if (stableCount >= 1) break; // 连续两次轮询数值一致 = 渲染稳定
        } else {
          lastRate = curRate;
          stableCount = 0;
        }
        // 终态无数据检测：卡片区存在但数值位置是「--/暂无」→ 该区间无退款数据，
        // 不必等满 30s（否则每个无数据商品都白等一轮，商品多时明显拖慢）
        if (curRate === null && /退款率[\s\S]{0,100}(--|暂无)/.test(pageText)) {
          console.log('>> [DETAIL] 该日期区间无退款数据（卡片显示 --/暂无），提前结束等待');
          break;
        }
        await pausableSleep(1000);
      }
      // 三态消歧日志：出现异常时一眼区分「渲染中」还是「改版」，不再盲猜
      const hasCardZone = /退款率/.test(pageText);
      const hasAnyValue = /\d+\.?\d*%/.test(pageText);
      if (!hasCardZone) {
        console.log('>> [DETAIL] 状态B：页面没有「退款率」卡片区（详情页可能改版/入口未加载），截图 detail-refund-timeout.png');
        await detailPage.screenshot({ path: 'detail-refund-timeout.png', timeout: 10000 }).catch(() => {});
      } else if (!hasAnyValue) {
        console.log('>> [DETAIL] 状态A：卡片区存在但 30s 内未出现数值（数据仍在渲染/后台tab节流），截图 detail-refund-timeout.png');
        await detailPage.screenshot({ path: 'detail-refund-timeout.png', timeout: 10000 }).catch(() => {});
      }
    }

    // 策略1：从全页面提取第一个退款率作为总退款率
    // 页面中第一个出现的 退款率 始终是"全部"卡片的数据
    refundRate = extractRefundRateFromText(pageText);
    if (refundRate !== null) {
      refundRate = String(refundRate);
    }

    // 策略2：提取发货前退款率
    // 查找所有"发货前"出现位置，对每个位置检查其所在区域（到下一个卡片标题为止）
    // 是否包含 退款率，找到第一个有数据的区域即可
    const preShipPositions = findAllOccurrences(pageText, '发货前');
    const otherBoundaries = ['未收货', '已收货'];
    for (const pos of preShipPositions) {
      // 找到该位置之后最近的其他卡片标题作为区域边界
      let nextBound = pageText.length;
      for (const boundary of otherBoundaries) {
        const bIdx = pageText.indexOf(boundary, pos + 1);
        if (bIdx !== -1 && bIdx < nextBound) nextBound = bIdx;
      }
      const sectionText = pageText.substring(pos, nextBound);
      // 只在该区域内查找退款率（避免误匹配其他卡片的数据）
      if (sectionText.indexOf('退款率') === -1) continue;
      preShipRefundRate = extractRefundRateFromText(sectionText);
      if (preShipRefundRate !== null) {
        break;
      }
    }

    // 计算修正发后退货率 = 总退款率 - 发货前退款率
    if (refundRate !== null && preShipRefundRate !== null) {
      const totalRate = parseFloat(refundRate);
      if (preShipRefundRate > totalRate) {
        console.log(`[WARN] 发货前退款率(${preShipRefundRate}%) > 退款率(${totalRate}%)，抓取异常，跳过修正发后退货率`);
        postShipRefundRate = null;
      } else {
        postShipRefundRate = (totalRate - preShipRefundRate).toFixed(2);
      }
    }

    // 提取退款人数（第一个"退款人数"后面的数字）
    const countIdx = pageText.indexOf('退款人数');
    if (countIdx !== -1) {
      const countChunk = pageText.substring(countIdx, countIdx + 50);
      const countMatch = countChunk.match(/退款人数\s*(\d+)/);
      if (countMatch) {
        refundCount = parseInt(countMatch[1]);
      }
    }

    // 提取退款订单数（"退款率"下方"退款订单数"后面的数字，作为修正退货率参考销量）
    const orderCountIdx = pageText.indexOf('退款订单数');
    if (orderCountIdx !== -1) {
      const orderCountChunk = pageText.substring(orderCountIdx, orderCountIdx + 50);
      const orderCountMatch = orderCountChunk.match(/退款订单数\s*([\d,]+)/);
      if (orderCountMatch) {
        refundOrderCount = parseInt(orderCountMatch[1].replace(/,/g, ''));
      }
    }

    console.log(`提取到退货率: ${refundRate}%, 发货前退款率: ${preShipRefundRate}%, 修正发后退货率: ${postShipRefundRate}%, 退款人数: ${refundCount}, 退款订单数: ${refundOrderCount}`);
    console.log(`详情页URL: ${detailPage.url()}`);

    // 退款人数少于3人时数据不准确，用修正发后退货率作为修正退货率（避免外层 rate===null 误判为详情页失败）
    if (refundCount !== null && refundCount < 3) {
      console.log(`退款人数(${refundCount})少于3人，数据不准确，用修正发后退货率替代修正退货率`);
      refundRate = postShipRefundRate;
    }

    // 提取发货后退款率（从同一页面文本）
    const postShipIdx = pageText.indexOf('发货后退款率');
    if (postShipIdx !== -1) {
      const chunk = pageText.substring(postShipIdx, postShipIdx + 200);
      const rateMatch = chunk.match(/(\d+\.?\d*)%/);
      if (rateMatch) {
        postShippingRate = rateMatch[1];
      }
    }

    // 如果没找到"发货后退款率"，尝试其他关键词
    if (!postShippingRate) {
      const altKeywords = ['发货后退款', '发货后退货率', '已发货退款率'];
      for (const keyword of altKeywords) {
        const idx = pageText.indexOf(keyword);
        if (idx !== -1) {
          const chunk = pageText.substring(idx, idx + 200);
          const rateMatch = chunk.match(/(\d+\.?\d*)%/);
          if (rateMatch) {
            postShippingRate = rateMatch[1];
            console.log(`通过关键词"${keyword}"找到发货后退款率`);
            break;
          }
        }
      }
    }

    // 如果还没找到，搜索所有百分比，找"发货"附近的
    if (!postShippingRate) {
      const allRates = pageText.match(/\d+\.?\d*%/g);
      if (allRates) {
        for (const rate of allRates) {
          const rateIdx = pageText.indexOf(rate);
          const beforeText = pageText.substring(Math.max(0, rateIdx - 50), rateIdx);
          if (beforeText.includes('发货后') || beforeText.includes('已发货')) {
            postShippingRate = rate.replace('%', '');
            console.log(`通过上下文匹配找到发货后退款率`);
            break;
          }
        }
      }
    }

    if (!postShippingRate) {
      // 状态C消歧：页面有数值但「发货后退款率」三种回退都未命中 → 文案变体，dump 附近文本
      const ctxDump = (pageText.match(/.{0,30}发货后.{0,30}/) || [''])[0];
      console.log(`>> 详情页发货后退款率提取失败：3 种回退路径（"发货后退款率" / 备选关键词 "发货后退款/发货后退货率/已发货退款率" / 上下文匹配）均未命中 [状态C：有数值但关键词不匹配，附近文本: ${JSON.stringify(ctxDump)}]`);
    }
    console.log(`发货后退款率: ${postShippingRate}%`);

    // 投放消耗不再从详情页抓取（2026-08-16 起改为只取列表页的「投放消耗」列），adSpend 保持 null
  } catch (e) {
    console.log('提取页面内容失败:', fmtErr(e));
  }

  // 关闭详情页
  try {
    if (!detailPage.isClosed()) {
      await detailPage.close();
    }
  } catch (e) {
    console.log('关闭详情页失败:', fmtErr(e));
  }

  // 兜底：修正退货率(refundRate)不可用时，用发货后退款率(postShippingRate)兜底，避免外层 rate===null 误判为详情页失败
  if (refundRate === null && postShippingRate !== null) {
    console.log(`修正退货率(refundRate)不可用，使用发货后退款率(${postShippingRate}%)作为兜底`);
    refundRate = postShippingRate;
  }

  if (refundCount !== null && refundRate === null && preShipRefundRate === null && postShipRefundRate === null && postShippingRate === null) {
    console.log(`>> 详情页率字段全为null（退款人数=${refundCount}已抓到），可能是详情页改版或图表未渲染完成，详情页数据仅作参考，不影响商品写入`);
  }

  return { rate: refundRate, preShipRefundRate, postShipRefundRate, refundOrderCount, postShippingRate, adSpend };
}

// 从商品管理页面获取商品图片URL
async function getProductImageUrl(page, productId) {
  console.log(`\n获取商品 ${productId} 的图片...`);

  // 先尝试直接导航到商品管理页面
  try {
    await page.goto(CONFIG.douyin.productManageUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(5000);
  } catch (e) {
    console.log('导航到商品管理页面失败:', fmtErr(e));
    return null;
  }

  // 关闭弹窗
  try {
    const popupBtn = page.locator('text=知道了');
    if (await popupBtn.count() > 0) {
      await popupBtn.click();
      console.log('关闭弹窗');
      await page.waitForTimeout(2000);
      // R87 / AD-COOKIE-SOURCE-READONLY-20261018：商品分析流程不得回写源 Cookie 文件。
      // 旧代码曾在此处裸写 CONFIG.cookiePath；后续的会话检查点回写也已移除。
      // 源 Cookie 文件只允许由扫码登录成功路径（login-shop.js）更新；分析流程只读取。
    }
  } catch (e) {
    // 弹窗可能不存在，继续
  }

  // 搜索商品ID - F-P06: 语义定位 + 唯一性校验 + 命中验证
  console.log(`搜索商品ID: ${productId}`);
  try {
    await collectInputCandidates(page);
    const found = await page.evaluate((pid) => {
      function deepAll(root, out) { out=out||[]; for(const el of root.querySelectorAll('*')){out.push(el); if(el.shadowRoot) deepAll(el.shadowRoot, out);} return out; }
      const all = deepAll(document);
      const label = all.find(el => (el.innerText||'').trim()==='商品名称' && el.children.length===0) || all.find(el => (el.innerText||'').trim().includes('商品名称'));
      if (!label) return { ok:false, reason:'未找到商品名称标签' };
      let wrapper = label; for(let i=0;i<8&&wrapper;i++){ if(String(wrapper.className||'').includes('search')||String(wrapper.className||'').includes('filter')) break; wrapper=wrapper.parentElement; }
      const container = wrapper ? wrapper.parentElement || wrapper : document;
      const inputs = Array.from(container.querySelectorAll('input')).filter(inp=>{ const r=inp.getBoundingClientRect(); return r.width>0&&r.height>0; });
      if (inputs.length!==1) return { ok:false, reason:`候选输入框数=${inputs.length}`, candidates: inputs.length };
      const inp = inputs[0];
      inp.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(inp, pid);
      inp.dispatchEvent(new Event('input', {bubbles:true}));
      inp.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true}));
      return { ok:true };
    }, String(productId));
    if (!found.ok) { console.log(`[getProductImageUrl] 定位失败: ${found.reason}`); await dumpEvidence(page, 'product-manage-search'); return null; }
    try { await page.waitForFunction((pid)=>{ const rows=document.querySelectorAll('tbody tr'); for(const r of rows) if((r.innerText||'').includes(pid)) return true; return false; }, String(productId), {timeout:15000}); } catch(e){ console.log('[getProductImageUrl] 等待命中超时'); return null; }
    await page.waitForTimeout(2000);

    // 从商品行提取图片URL
    const imageData = await page.evaluate((pid) => {
      const rows = document.querySelectorAll('tbody tr');
      for (const row of rows) {
        if (row.innerText.includes(pid)) {
          const img = row.querySelector('img');
          if (img) {
            return {
              found: true,
              imageUrl: img.src,
              productName: row.innerText.split('\n')[0]?.trim()
            };
          }
        }
      }
      return { found: false };
    }, productId);

    if (imageData.found) {
      console.log(`找到商品图片: ${imageData.imageUrl}`);
      return imageData.imageUrl;
    } else {
      console.log('未找到商品图片');
      return null;
    }
  } catch (e) {
    console.log('搜索或提取图片失败:', fmtErr(e));
    return null;
  }
}

async function extractProductsOnPage(page) {
  // 从已加载的页面快速提取商品数据（无额外等待）
  return await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    let productTable = null;

    // 找到商品列表表格（包含"商品信息"表头）
    for (const t of tables) {
      // 检查 thead
      const thead = t.querySelector('thead');
      if (thead && thead.rows.length > 0) {
        const firstRow = thead.rows[0];
        if (firstRow && firstRow.innerText.includes('商品信息')) {
          productTable = t;
          break;
        }
      }
      // 检查 tbody
      const tbody = t.querySelector('tbody');
      if (tbody && tbody.rows.length > 0) {
        const firstRow = tbody.rows[0];
        if (firstRow && firstRow.innerText.includes('商品信息')) {
          productTable = t;
          break;
        }
      }
    }

    // 如果没找到商品表格，尝试找到最大的数据表格
    if (!productTable) {
      console.log('未找到"商品信息"表格，尝试查找最大数据表格...');
      let maxRows = 0;
      for (const t of tables) {
        const tbody = t.querySelector('tbody');
        if (tbody) {
          const rows = tbody.querySelectorAll('tr:not(.ecom-table-measure-row)');
          if (rows.length > maxRows) {
            // 检查是否包含ID或商品相关信息
            // AUTO-CONT-2: querySelectorAll 返回 NodeList，标准 DOM 无 NodeList.some——
            // 直接调用会抛 TypeError。本入口只在未命中"商品信息"表头时启用；真实浏览器
            // 里一旦触发就会崩在回退分支。Array.from 归一为真数组后再判定，不改筛选语义。
            const hasProducts = Array.from(rows).some(row =>
              row.innerText.includes('ID') ||
              row.innerText.match(/\d{15,20}/) ||
              row.innerText.includes('订单')
            );
            if (hasProducts) {
              maxRows = rows.length;
              productTable = t;
            }
          }
        }
      }
    }

    if (!productTable) {
      console.log('未找到合适的商品表格');
      return { error: 'no_table', tablesFound: tables.length, products: [] };
    }

    const results = [];
    const seenIds = new Set();
    const tbody = productTable.querySelector('tbody');
    if (!tbody) {
      return { error: 'no_tbody', products: [] };
    }
    const rows = tbody.querySelectorAll('tr:not(.ecom-table-measure-row)');

    // 从 thead 获取表头信息（提前采集表头文本，供动态列检测与结构行判定共用）
    const thead = productTable.querySelector('thead');
    const headerCells = (thead && thead.rows.length > 0)
      ? thead.rows[0].querySelectorAll('th') : [];
    // AUTO-CONT-2: 只按明确 DOM 结构排除布局行。Aurora 的测量行带非空列头文字，
    // 不能用空文本或列头关键词猜测；有业务行标记、内容缺失或未知身份的行仍保留给 R1。
    const headerTexts = Array.from(headerCells, (c) => (c.innerText || '').trim());
    function isStructuralNonDataRow(row) {
      const classes = String(row.className || '').split(/\s+/);
      const framework = '(?:aurora|ecom|ant|auxo)';
      if (classes.some((c) => new RegExp('^' + framework + '-table-(?:measure-row|placeholder|summary)$').test(c))) return true;
      // 业务行不能因为文字为空、包含列头词或 colspan 大而被丢弃。
      if (classes.some((c) => new RegExp('^' + framework + '-table-row(?:-level-\\d+)?$').test(c))) return false;
      const tds = Array.from(row.querySelectorAll('td'));
      const ths = Array.from(row.querySelectorAll('th'));
      if (ths.length > 0 && tds.length === 0) return true;
      // 无业务行标记的 tbody 表头副本，逐格与已知表头完全一致才能排除。
      return headerTexts.length >= 3 && tds.length === headerTexts.length
        && tds.every((c, i) => (c.innerText || '').trim() === headerTexts[i]);
    }
    const dataRows = Array.from(rows).filter((row) => !isStructuralNonDataRow(row));

    // 动态检测列位置 - 从表头精确匹配
    let ID_COL = 1;
    let ORDER_COL = 3;
    let RATE_COL = 4;
    let POST_SHIP_COL = 5;
    let AD_SPEND_COL = 6;

    if (thead && thead.rows.length > 0) {
      console.log(`表头有 ${headerCells.length} 列`);

      for (let i = 0; i < headerCells.length; i++) {
        const headerText = (headerCells[i].innerText || '').trim();
        console.log(`  列${i}: "${headerText}"`);

        // 匹配商品ID列
        if (headerText.includes('商品ID') || headerText === 'ID') {
          ID_COL = i;
        }
        // 匹配成交件数列（优先匹配"成交件数"，而不是"成交订单数"）
        if (headerText === '成交件数' || headerText.includes('成交件数')) {
          ORDER_COL = i;
        }
        // 匹配退款率列（精确匹配"退款率(支付时间)"）
        if (headerText.includes('退款率') && headerText.includes('支付时间') && !headerText.includes('发货后')) {
          RATE_COL = i;
        }
        // 匹配发货后退款率列
        if (headerText.includes('发货后退款率') && headerText.includes('支付时间')) {
          POST_SHIP_COL = i;
        }
        // 匹配投放消耗列
        if (headerText.includes('投放消耗') || headerText.includes('投放')) {
          AD_SPEND_COL = i;
        }
      }
      console.log(`动态检测列位置: ID=${ID_COL}, 订单数=${ORDER_COL}, 退货率=${RATE_COL}, 发货后退款率=${POST_SHIP_COL}, 投放消耗=${AD_SPEND_COL}`);
    } else {
      console.log('未找到表头，使用默认列位置');
    }

    dataRows.forEach((row, idx) => {
      // 结构行已在 dataRows 过滤阶段排除；这里遍历候选数据行即可。
      const rowText = row.innerText;
      // 支持多种ID格式：ID:数字、ID 数字、纯数字ID等
      const idMatch = rowText.match(/ID[\s:：]*(\d{10,20})/) || rowText.match(/\b(\d{15,20})\b/);

      if (idMatch && !seenIds.has(idMatch[1])) {
        const id = idMatch[1];
        seenIds.add(id);

        const cells = row.querySelectorAll('td');

        // 商品名称不再从列表页识别（列位置不稳定会认错列，且流程不依赖名称）
        const productName = '';

        // 成交订单数：从检测到的订单列精确提取
        // AUTO-CONT-1补修(缺口一): 区分「解析为0」与「缺失/不可解析」——
        // 旧代码默认0，会把"整页订单数不可解析"误判成"全部零单"→假耗尽。
        let orderCount = 0;
        let orderCountParsed = false;
        if (cells[ORDER_COL]) {
          const cellText = (cells[ORDER_COL].innerText || '').replace(/,/g, '');
          const match = cellText.match(/(\d+)/);
          if (match) {
            orderCount = parseInt(match[1]);
            orderCountParsed = true;
          }
        }
        // 如果订单列没提取到，回退到搜索包含"单"的单元格
        if (!orderCountParsed) {
          for (let i = 0; i < cells.length; i++) {
            if (cells[i] && cells[i].innerText) {
              const cellText = (cells[i].innerText || '').replace(/,/g, '');
              const match = cellText.match(/(\d+)单/);
              if (match) {
                orderCount = parseInt(match[1]);
                orderCountParsed = true;
                break;
              }
            }
          }
        }

        // 退款率：从检测到的退货率列精确提取
        let returnRate = -1;
        if (cells[RATE_COL]) {
          const cellText = (cells[RATE_COL].innerText || '').trim();
          const match = cellText.match(/(\d+\.?\d*)%/);
          if (match) {
            returnRate = parseFloat(match[1]);
          }
        }
        // 发货后退款率：从检测到的发货后退款率列精确提取
        let postShipRate = -1;
        if (cells[POST_SHIP_COL]) {
          const cellText = (cells[POST_SHIP_COL].innerText || '').trim();
          const match = cellText.match(/(\d+\.?\d*)%/);
          if (match) {
            postShipRate = parseFloat(match[1]);
          }
        }

        // 投放消耗：从检测到的投放消耗列精确提取
        let adSpend = -1;
        if (cells[AD_SPEND_COL]) {
          const cellText = (cells[AD_SPEND_COL].innerText || '').trim();
          const match = cellText.match(/[¥￥]([\d,.]+)/);
          if (match) {
            adSpend = match[1].replace(/,/g, '');
          }
        }

        // 如果退货率列没提取到，回退到搜索百分数
        if (returnRate === -1) {
          for (let i = 0; i < cells.length; i++) {
            if (cells[i] && cells[i].innerText) {
              const cellText = (cells[i].innerText || '').trim();
              const match = cellText.match(/(\d+\.?\d*)%/);
              if (match) {
                returnRate = parseFloat(match[1]);
                break;
              }
            }
          }
        }

        // 调试：打印所有单元格内容
        if (idx === 0) {
          console.log(`[调试] 第一行所有单元格:`);
          for (let i = 0; i < cells.length; i++) {
            const cellText = (cells[i]?.innerText || '').trim().substring(0, 30);
            console.log(`  cells[${i}]: "${cellText}"`);
          }
          console.log(`[调试] RATE_COL=${RATE_COL}, POST_SHIP_COL=${POST_SHIP_COL}, AD_SPEND_COL=${AD_SPEND_COL}, 退款率=${returnRate}%, 发货后退款率=${postShipRate}%, 投放消耗=${adSpend}`);
        }

        results.push({
          id: id,
          name: productName || '商品',
          link: '',
          orderCount: orderCount,
          orderCountParsed: orderCountParsed,
          listReturnRate: returnRate,
          returnRate: postShipRate !== -1 ? postShipRate : null,
          adSpend: adSpend
        });

        console.log(`提取商品: ${id} - ${productName}, 订单数: ${orderCount}, 退款率(支付时间): ${returnRate}%, 发货后退款率: ${postShipRate}%, 投放消耗: ${adSpend}, 近30天退款率: ${returnRate}%, 修正退款率: ${postShipRate !== -1 ? postShipRate : null}%`);
      }
    });

    return { products: results, rowCount: dataRows.length, rawRowCount: rows.length, structuralRowCount: rows.length - dataRows.length };
  });
}

// 检查是否有下一页
async function hasNextPage(page) {
  const result = await page.evaluate(() => {
    // 查找"共xxx条"元素
    let totalElement = null;
    const allElements = document.querySelectorAll('*');
    for (const el of allElements) {
      const text = el.innerText || '';
      if (text.includes('共') && text.includes('条') && text.match(/共\d+条/)) {
        totalElement = el;
        break;
      }
    }

    if (!totalElement) return { hasNext: false, reason: 'no_total_element' };

    // 收集页面底部区域的按钮（top > 1100）
    const bottomBtns = [];
    const allBtns = document.querySelectorAll('button');
    allBtns.forEach(b => {
      const rect = b.getBoundingClientRect();
      if (rect.top > 1100) { // 在页面底部
        bottomBtns.push({
          text: (b.innerText || '').trim(),
          html: b.innerHTML,
          ariaLabel: b.getAttribute('aria-label') || '',
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          top: Math.round(rect.top),
          disabled: b.disabled
        });
      }
    });

    // 查找"右箭头"按钮（下一页） - 排除"左箭头"（上一页）
    for (const btn of bottomBtns) {
      // 检查aria-label是否为right
      if (btn.ariaLabel === 'right') {
        if (!btn.disabled) {
          return { hasNext: true, reason: 'found_right_aria', btn };
        }
      }
      // 检查SVG是否包含right（不是left）
      if (btn.html.includes('right') && !btn.html.includes('left') && btn.html.includes('<svg')) {
        if (!btn.disabled) {
          return { hasNext: true, reason: 'found_right_svg', btn };
        }
      }
      // 检查文字是"›"且不是disabled
      if (btn.text === '›' && !btn.disabled) {
        return { hasNext: true, reason: 'found_arrow', btn };
      }
    }

    return { hasNext: false, reason: 'no_right_arrow', bottomBtns };
  });
  console.log(`  [hasNextPage] result=${JSON.stringify(result)}`);
  return result.hasNext;
}

// AUTO-CONT-1续跑(缺口一收口): 分页末页判定的唯一权威规则。getPaginationEndState 与
// goToNextPage 共用同一个浏览器侧探针 __paginationProbe(mode)，"下一页候选"必须同时满足：
//   1) 形态像下一页（aria-label=right / 含 right 的 svg / 文本 ›）；
//   2) 可归属分页——按钮或其有限祖先带分页语义(class/aria-label 含 pagination/pager/分页，
//      或 role=navigation 带分页标签)。泛 right 形态、closest 无分页祖先 → 不能作为分页证据；
//   3) 可见——非 aria-hidden=true、getClientRects 非空且矩形 width/height>0；
//   4) 非加载中——按钮或分页祖先 aria-busy=true 视为未稳定，不可信；
//   5) 唯一/可靠同源——所有可信候选必须落在同一个分页容器；跨容器歧义 → unknown。
// 只有"能看到'共N条'总数(分页已渲染)"且存在明确禁用的可信可见候选才判 last_page；存在可用
// 可信候选判 has_next；其余（无归属/隐藏/加载中/歧义/无控件）一律 unknown，绝不猜末页。
// mode='classify' 返回 {state,reason}；mode='click' 只在单个同源容器里点击第一个可用(非禁用、
// 可见、已归属、非加载)下一页控件，否则 clicked:false——绝不点击无关/隐藏/加载中的按钮。
function __paginationProbe(mode) {
  var re = /pagination|pager|分页/i;
  function attr(el, name) {
    if (!el || typeof el.getAttribute !== 'function') return '';
    var v = el.getAttribute(name);
    return v == null ? '' : String(v);
  }
  function lookLikeNext(btn) {
    var ariaLabel = attr(btn, 'aria-label');
    var html = btn.innerHTML || '';
    var text = (btn.innerText || '').trim();
    return ariaLabel === 'right' ||
      (html.indexOf('right') >= 0 && html.indexOf('left') < 0 && html.indexOf('<svg') >= 0) ||
      text === '›';
  }
  // 返回最内层的分页祖先容器（用于归属+同源），无则 null
  function paginationAncestor(btn) {
    var el = btn && btn.parentElement ? btn.parentElement : null;
    var depth = 0;
    while (el && depth < 8) {
      var cls = el.className ? String(el.className) : '';
      var al = attr(el, 'aria-label');
      var role = attr(el, 'role');
      if (re.test(cls) || re.test(al) || (role === 'navigation' && re.test(al))) return el;
      el = el.parentElement;
      depth++;
    }
    return null;
  }
  function isVisible(el) {
    if (!el) return false;
    if (attr(el, 'aria-hidden') === 'true') return false;
    if (typeof getComputedStyle === 'function') {
      var style = getComputedStyle(el);
      if (!style || style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
    }
    if (typeof el.getClientRects === 'function') {
      var rs = el.getClientRects();
      if (!rs || rs.length === 0) return false;
    }
    if (typeof el.getBoundingClientRect === 'function') {
      var r = el.getBoundingClientRect();
      if (!r || !(r.width > 0 && r.height > 0)) return false;
    }
    return true;
  }
  function isLoading(btn, container) {
    if (attr(btn, 'aria-busy') === 'true') return true;
    if (container && attr(container, 'aria-busy') === 'true') return true;
    return false;
  }
  // 分页已渲染的证据：页面存在"共N条"
  var totalEl = null;
  var all = document.querySelectorAll('*');
  for (var i = 0; i < all.length; i++) {
    var t = all[i].innerText || '';
    if (t.indexOf('共') >= 0 && t.indexOf('条') >= 0 && /共\d+条/.test(t)) { totalEl = all[i]; break; }
  }
  var btns = document.querySelectorAll('button');
  var valid = []; // 归属+可见+非加载 的下一页候选
  for (var j = 0; j < btns.length; j++) {
    var b = btns[j];
    if (!lookLikeNext(b)) continue;
    var container = paginationAncestor(b);
    if (!container) continue;         // 无分页归属：泛 right 形态，不作分页证据
    if (!isVisible(b) || !isVisible(container)) continue; // 按钮或分页容器隐藏：不可信
    if (isLoading(b, container)) continue; // 加载中：不可信
    valid.push({ btn: b, container: container, disabled: !!b.disabled });
  }
  if (!totalEl) return { state: 'unknown', reason: 'no_total_element', clicked: false };
  if (valid.length === 0) return { state: 'unknown', reason: 'no_attributable_visible_next_control', clicked: false };
  // 唯一/可靠同源：所有可信候选必须同属一个分页容器
  var containers = [];
  for (var k = 0; k < valid.length; k++) {
    var cont = valid[k].container;
    var seen = false;
    for (var m = 0; m < containers.length; m++) { if (containers[m] === cont) { seen = true; break; } }
    if (!seen) containers.push(cont);
  }
  if (containers.length > 1) return { state: 'unknown', reason: 'ambiguous_pagination_containers', clicked: false };
  var target = null;
  for (var n = 0; n < valid.length; n++) { if (!valid[n].disabled) { target = valid[n].btn; break; } }
  if (mode === 'click') {
    if (!target) return { clicked: false, reason: 'no_enabled_next_control' };
    var r2 = typeof target.getBoundingClientRect === 'function' ? target.getBoundingClientRect() : null;
    target.click();
    return { clicked: true, top: r2 ? Math.round(r2.top) : null };
  }
  if (target) return { state: 'has_next', reason: 'enabled_next', clicked: false };
  return { state: 'last_page', reason: 'next_disabled', clicked: false };
}

async function getPaginationEndState(page) {
  try {
    const result = await page.evaluate(__paginationProbe, 'classify');
    console.log(`  [getPaginationEndState] ${JSON.stringify(result)}`);
    return result.state;
  } catch (e) {
    console.log('  [getPaginationEndState] 检测异常:', fmtErr(e));
    return 'unknown';
  }
}

// 点击下一页：与 getPaginationEndState 共用 __paginationProbe('click')——只点击已归属分页、
// 可见、非加载、单个同源容器内的可用下一页控件；无关/隐藏/加载中的按钮一律不点击。
async function goToNextPage(page) {
  const result = await page.evaluate(__paginationProbe, 'click');
  console.log(`  [goToNextPage] ${JSON.stringify(result)}`);
  return !!result.clicked;
}

async function extractProductData(page) {
  console.log('正在提取商品数据...');
  await page.waitForTimeout(3000);

  // 直接从表格提取商品数据
  const tableData = await page.evaluate(() => {
    const results = [];

    // 找到商品列表表格
    const tables = document.querySelectorAll('table');
    let productTable = null;

    for (const t of tables) {
      const tbody = t.querySelector('tbody');
      if (tbody && tbody.rows.length > 2) {
        const firstRow = tbody.rows[0];
        if (firstRow && firstRow.innerText.includes('商品信息')) {
          productTable = t;
          break;
        }
      }
    }

    if (!productTable) {
      for (const t of tables) {
        const tbody = t.querySelector('tbody');
        if (tbody && tbody.rows.length > 2) {
          productTable = t;
          break;
        }
      }
    }

    if (!productTable) {
      return { error: '未找到商品表格', tablesFound: tables.length };
    }

    const tbody = productTable.querySelector('tbody');
    const rows = tbody.querySelectorAll('tr:not(.ecom-table-measure-row)');

    rows.forEach((row) => {
      const cells = row.querySelectorAll('td');
      const rowText = row.innerText;

      const idMatch = rowText.match(/ID[\s:]*(\d{15,20})/);
      if (idMatch) {
        const productId = idMatch[1];

        let productName = '';
        if (cells.length > 1) {
          const firstCell = cells[1];
          if (firstCell) {
            const cellText = firstCell.innerText;
            productName = cellText.split('\n')[0].trim().substring(0, 50);
          }
        }

        // cells[2]=成交订单数, cells[3]=退款率(支付时间)
        let orderCount = 0;
        let returnRate = 0;

        if (cells.length > 4) {
          const cell2Text = (cells[2]?.innerText || '').replace(/,/g, '');
          const cell3Text = (cells[3]?.innerText || '').trim();

          const orderMatch = cell2Text.match(/(\d+)/);
          orderCount = orderMatch ? parseInt(orderMatch[1]) : 0;

          // 退款率必须是百分数格式（如 "82.53%"）
          const rateMatch = cell3Text.match(/(\d+\.?\d*)%/);
          returnRate = rateMatch ? parseFloat(rateMatch[1]) : -1;
        }

        results.push({
          id: productId,
          name: productName || '商品',
          link: '',
          orderCount: orderCount,
          listReturnRate: returnRate,  // 商品列表页的初步退款率
          returnRate: returnRate  // 详情页校验后的退款率（后续会被覆盖）
        });
      }
    });

    return {
      rowsFound: rows.length,
      productsFound: results.length,
      sampleRows: results.slice(0, 3)
    };
  });

  console.log('表格数据提取结果:', JSON.stringify(tableData, null, 2));

  if (tableData.error || tableData.productsFound === 0) {
    console.log('从未处理表格提取商品...');
  }

  // 返回从表格提取的结果
  const products = await page.evaluate(() => {
    const tables = document.querySelectorAll('table');
    let productTable = null;

    for (const t of tables) {
      const tbody = t.querySelector('tbody');
      if (tbody) {
        const firstRow = tbody.rows[0];
        if (firstRow && firstRow.innerText.includes('商品信息')) {
          productTable = t;
          break;
        }
      }
    }

    if (!productTable) {
      for (const t of tables) {
        const tbody = t.querySelector('tbody');
        if (tbody && tbody.rows.length > 2) {
          productTable = t;
          break;
        }
      }
    }

    if (!productTable) return [];

    const results = [];
    const seenIds = new Set();
    const tbody = productTable.querySelector('tbody');
    const rows = tbody.querySelectorAll('tr:not(.ecom-table-measure-row)');

    rows.forEach(row => {
      const rowText = row.innerText;
      const idMatch = rowText.match(/ID[\s:]*(\d{15,20})/);

      if (idMatch && !seenIds.has(idMatch[1])) {
        const id = idMatch[1];
        seenIds.add(id);

        const cells = row.querySelectorAll('td');
        let productName = '';
        let orderCount = 0;
        let returnRate = 0;

        if (cells.length > 1) {
          productName = cells[1].innerText.split('\n')[0].trim().substring(0, 50);
        }

        // cells[2]=成交订单数, cells[3]=退款率
        if (cells.length > 4) {
          const cell2Text = (cells[2]?.innerText || '').replace(/,/g, '');
          const cell3Text = (cells[3]?.innerText || '').trim();

          const orderMatch = cell2Text.match(/(\d+)/);
          orderCount = orderMatch ? parseInt(orderMatch[1]) : 0;

          // 退款率必须是百分数格式（如 "82.53%"）
          const rateMatch = cell3Text.match(/(\d+\.?\d*)%/);
          returnRate = rateMatch ? parseFloat(rateMatch[1]) : -1;
        }

        results.push({
          id: id,
          name: productName || '商品',
          link: '',
          orderCount: orderCount,
          listReturnRate: returnRate,  // 近30天退款率 - 来自列表页
          returnRate: returnRate  // 修正退款率 - 后续会被详情页覆盖
        });
      }
    });

    return results;
  });

  console.log('\n从列表提取到:', products.length, '个商品');
  return products;
}

// AUTO-CONT-1: 统一的商品处理结果登记。
// 有运行级状态(analyzerState)时走 markProcessed/markFailed（含逐商品持久化、失败身份登记与清除）；
// 无状态（单次界面运行）时退化为直接操作临时跳过集合，保证失败商品不进成功集合。
function markProductProcessed(analyzerState, skipProductIds, productId) {
  if (analyzerState) return analyzerState.markProcessed(productId);
  if (skipProductIds) skipProductIds.add(String(productId));
  return { ok: true };
}
function markProductFailed(analyzerState, skipProductIds, productId) {
  if (analyzerState) return analyzerState.markFailed(productId);
  if (skipProductIds) skipProductIds.delete(String(productId));
  return { ok: true };
}

async function processProductRound(page, context, targetCount, accessToken, shopName, premiumMap, intervalMinutes = 30, forceFull = false, skipProductIds = null, analyzerState = null) {
  let processedCount = 0;
  let hasWriteFailure = false;
  let writeCount = 0; // 实际写入数量
  let skippedCount = 0; // 因"近期已有记录"跳过的商品数
  let currentPage = 1;
  let hitZeroOrder = false;
  const processedProducts = []; // 收集本轮处理的商品数据
  // AUTO-CONT-1: 轮级结论字段——只有拿到可靠证据才允许上报"列表耗尽"。
  let endedByListEnd = false;   // 走完整份列表并确认末页（分页控件可见且无可用下一页）
  let extractionError = null;   // 商品列表提取失败（no_table/no_tbody 等）
  let paginationError = null;   // 翻页失败/分页控件不可见（不能当列表耗尽）
  let unprocessedLeft = 0;      // 本轮见到但未处理、也未登记失败的商品（数据异常排除等）

  // 每轮开始时刷新accessToken（避免过期）
  let freshToken = accessToken;
  try {
    freshToken = await getFeishuToken();
    console.log('AccessToken已刷新');
  } catch (e) {
    console.log('刷新AccessToken失败，使用旧token:', fmtErr(e));
  }

  if (forceFull) {
    console.log('[全量刷新模式] 跳过"近期已有记录"检查，强制更新所有商品');
  }

  // Step 3: 直接进入商品列表页面
  console.log('\nStep 3: 进入商品列表页面...');
  await page.goto('https://compass.jinritemai.com/shop/commodity/product-list', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await pausableSleep(15000);
  console.log('当前URL:', page.url());

  // Step 4: 点击"近30天"按钮
  console.log('\nStep 4: 点击"近30天"...');

  // 增加页面稳定时间
  console.log('等待页面完全稳定...');
  await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
  await pausableSleep(8000);

  // 尝试点击"近30天"按钮，使用多种策略
  let clicked = false;
  try {
    // 策略1: 尝试更长的超时时间
    console.log('尝试点击"近30天"按钮（策略1）...');
    const thirtyDayBtn = page.locator('text=近30天').first();
    await thirtyDayBtn.waitFor({ timeout: 20000 });
    await thirtyDayBtn.click({ timeout: 20000 });
    clicked = true;
    console.log('点击了"近30天"按钮');
  } catch (e1) {
    console.log('策略1失败:', fmtErr(e1));
    try {
      // 策略2: 尝试不同的选择器
      console.log('尝试点击"近30天"按钮（策略2）...');
      const thirtyDayBtn2 = page.locator('button:has-text("近30天")').first();
      await thirtyDayBtn2.waitFor({ timeout: 20000 });
      await thirtyDayBtn2.click({ timeout: 20000 });
      clicked = true;
      console.log('策略2成功点击了"近30天"按钮');
    } catch (e2) {
      console.log('策略2也失败:', fmtErr(e2));
      try {
        // 策略3: 尝试点击日期选择器下拉框
        console.log('尝试点击日期选择器（策略3）...');
        // 先尝试点击包含日期的下拉框
        const dateDropdown = page.locator('[class*="date"], [class*="picker"], [class*="select"]').filter({ hasText: /天|日/ }).first();
        await dateDropdown.waitFor({ timeout: 10000 });
        await dateDropdown.click();
        await sleep(2000);
        // 然后尝试点击"近30天"
        const thirtyDayInDropdown = page.locator('text=近30天').first();
        await thirtyDayInDropdown.waitFor({ timeout: 10000 });
        await thirtyDayInDropdown.click();
        clicked = true;
        console.log('策略3成功点击了"近30天"按钮');
      } catch (e3) {
        console.log('策略3也失败:', fmtErr(e3));
        try {
          // 策略4: 尝试点击包含"7天"的元素，看是否能展开选项
          console.log('尝试点击"7天"按钮展开选项（策略4）...');
          const sevenDayBtn = page.locator('text=7天').first();
          await sevenDayBtn.waitFor({ timeout: 10000 });
          await sevenDayBtn.click();
          await sleep(2000);
          // 然后尝试点击"近30天"
          const thirtyDayAfterClick = page.locator('text=近30天').first();
          await thirtyDayAfterClick.waitFor({ timeout: 10000 });
          await thirtyDayAfterClick.click();
          clicked = true;
          console.log('策略4成功点击了"近30天"按钮');
        } catch (e4) {
          console.log('策略4也失败:', fmtErr(e4));
          throw new Error('点击"近30天"按钮失败，停止执行以避免获取错误的7天数据');
        }
      }
    }
  }

  // 等待数据加载
  if (clicked) {
    console.log('等待数据加载...');
    await pausableSleep(30000); // 等待30秒
  } else {
    // 如果点击失败，抛出错误而不是继续执行
    throw new Error('点击"近30天"按钮失败，停止执行以避免获取错误的7天数据');
  }

  try {
    await page.screenshot({ path: 'step4-data.png', timeout: 10000 });
  } catch (e) {
    console.log('截图跳过:', fmtErr(e));
  }

  // 取消勾选"商品访客数"和"商品浏览量"（第一项和第二项）
  console.log('尝试取消勾选不需要的指标...');
  try {
    // 先截图看看当前页面状态
    await page.screenshot({ path: 'debug-before-uncheck.png', timeout: 10000 });

    const uncheckResult = await page.evaluate(() => {
      const results = [];

      // 方法1: 查找所有包含"商品访客数"或"商品浏览量"文字的元素
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const text = (el.innerText || '').trim();
        // 只处理精确匹配或开头匹配的元素，避免误匹配父容器
        if (text === '商品访客数' || text === '商品浏览量' ||
            text.startsWith('商品访客数') || text.startsWith('商品浏览量')) {
          // 查找该元素或其父元素中的checkbox/勾选状态
          const checkbox = el.querySelector('input[type="checkbox"], [role="checkbox"]') ||
                          el.closest('label, [class*="checkbox"]')?.querySelector('input[type="checkbox"]');
          if (checkbox) {
            if (checkbox.checked) {
              checkbox.click();
              results.push(`checkbox取消: ${text.substring(0, 15)}`);
            }
          } else if (el.classList && (el.classList.contains('active') || el.classList.contains('selected') || el.classList.contains('checked'))) {
            el.click();
            results.push(`class取消: ${text.substring(0, 15)}`);
          }
        }
      }

      // 方法2: 查找li元素（常见于下拉菜单）
      const liElements = document.querySelectorAll('li, [role="option"], [role="menuitem"]');
      for (const li of liElements) {
        const text = (li.innerText || '').trim();
        if (text === '商品访客数' || text === '商品浏览量') {
          // 检查是否被选中
          const checkbox = li.querySelector('input[type="checkbox"], [role="checkbox"]');
          const isChecked = checkbox ? checkbox.checked :
                           li.classList.contains('active') || li.classList.contains('selected') ||
                           li.getAttribute('aria-selected') === 'true';
          if (isChecked) {
            li.click();
            results.push(`li取消: ${text}`);
          }
        }
      }

      return results;
    });

    if (uncheckResult.length > 0) {
      console.log('取消勾选结果:', uncheckResult.join(', '));
      await pausableSleep(3000); // 等待页面更新
      await page.screenshot({ path: 'debug-after-uncheck.png', timeout: 10000 });
    } else {
      console.log('未找到需要取消的勾选项，可能需要手动查看截图调整选择器');
    }
  } catch (e) {
    console.log('取消勾选失败，继续执行:', fmtErr(e));
  }

  // Step 5: 提取商品数据并处理（支持翻页）
  console.log('\nStep 5: 提取并处理商品数据...');

  // 主循环：提取 -> 处理 -> 翻页，直到遇到订单数为0或无下一页
  while (true) {
    console.log(`\n--- 第 ${currentPage} 页 ---`);
    skippedCount = 0; // 每页重置跳过计数

    // 提取当前页商品
    let extractResult = await extractProductsOnPage(page);
    let products = extractResult.products || extractResult || [];
    if (extractResult.error) {
      console.log('提取失败:', extractResult.error, '表格数:', extractResult.tablesFound);
      // AUTO-CONT-1: 提取失败（空DOM/找不到表格）≠列表耗尽。旧逻辑落到下方
      // productsWithOrders.length===0 分支会把空提取误报成 hitZeroOrder（可靠耗尽）。
      // 这里直接按失败结束本轮，交由调度器重试。
      extractionError = String(extractResult.error || 'extract_failed');
      break;
    } else {
      console.log(`商品数据行数: ${extractResult.rowCount}, DOM原始行数: ${extractResult.rawRowCount ?? extractResult.rowCount}, 提取到商品: ${products.length}`);
    }
    console.log(`提取到 ${products.length} 个商品`);

    // AUTO-CONT-1补修(缺口一/R1): 「数据行数 > 成功解析行数」= 本页存在未解析/部分解析的数据行。
    // 真实提取器 rowCount 是表格数据行总数，某行 ID/内容匹配失败会体现在 rowCount 与 products.length
    // 的差值上。这类页绝不能当"空页"翻过而遗忘遗漏，也绝不能据此判末页耗尽；唯一例外是
    // rowCount===0（确实没有数据行）的空页，交由下方空页分页逻辑处理。
    const rawRowCount = Number(extractResult.rowCount);
    const unparsedRowCount = Number.isFinite(rawRowCount) && rawRowCount > 0
      ? Math.max(0, rawRowCount - products.length) : 0;
    if (unparsedRowCount > 0) {
      console.log(`AUTO-CONT-1补修(缺口一/R1): 表格有 ${rawRowCount} 行数据但仅解析 ${products.length} 行（未解析 ${unparsedRowCount} 行）→ 视为提取不完整，不按零单/耗尽处理，本轮按提取异常结束`);
      extractionError = 'unparsed_data_rows';
      break;
    }

    // 打印商品列表（列表页实际抓了6个字段：ID/名称/成交件数/退款率(支付时间)/发货后退款率/投放消耗，全部在日志展示）
    if (products.length > 0) {
      console.log('商品列表:');
      products.forEach((p, i) => {
        console.log(`  ${i + 1}. ID: ${p.id}, 成交: ${p.orderCount}, 列表退货率: ${p.listReturnRate}%, 发货后退款率: ${p.returnRate !== null && p.returnRate !== undefined ? p.returnRate + '%' : '-'}, 投放消耗: ${p.adSpend !== undefined && p.adSpend !== -1 ? p.adSpend : '-'}`);
      });
    }

    // 过滤出有订单的商品
    const productsWithOrders = products.filter(p => p.orderCount > 0);
    const zeroOrderCount = products.length - productsWithOrders.length;

    // AUTO-CONT-1补修(缺口一): 订单数缺失/不可解析 ≠ 真实零单。
    // 只要本页存在未解析出订单数的行，就不能按零单页/耗尽处理，按提取异常交由调度重试。
    if (products.some(p => p.orderCountParsed === false)) {
      console.log('AUTO-CONT-1补修: 存在订单数缺失或不可解析的行，不能视为零单页，本轮按提取异常结束');
      extractionError = 'order_count_unparseable';
      break;
    }

    // 有效零单数据：每行都解析出了商品且订单数全部为0 → 既有耗尽信号（hitZeroOrder）
    if (products.length > 0 && productsWithOrders.length === 0) {
      console.log(`所有 ${zeroOrderCount} 个商品订单数都是0，停止翻页`);
      hitZeroOrder = true;
      break;
    }

    // 如果有无订单的商品，记录一下但继续处理有订单的
    if (zeroOrderCount > 0) {
      console.log(`跳过 ${zeroOrderCount} 个0单商品`);
    }

    if (products.length === 0) {
      // AUTO-CONT-1补修(缺口一): 空提取（0行解析成功）≠真实零单，绝不产生 hitZeroOrder。
      // 只有"下一页控件明确禁用"（确认末页）才构成耗尽证据；有可用下一页则翻页继续；
      // 控件不可见/翻页失败按分页失败处理，交由调度重试。
      const paginationState = await getPaginationEndState(page);
      if (paginationState === 'last_page') {
        console.log('当前页解析出 0 个商品且下一页明确禁用（确认末页）→ 按明确末页证据收尾');
        endedByListEnd = true;
        break;
      }
      if (paginationState === 'has_next') {
        console.log('当前页解析出 0 个商品但存在可用下一页，尝试翻页...');
        const clickedEmpty = await goToNextPage(page);
        if (!clickedEmpty) {
          console.log('翻页失败，本轮按分页失败结束（不冒充列表耗尽）');
          paginationError = 'next_page_click_failed';
          break;
        }
        await pausableSleep(10000); // 等待新页面加载
        currentPage++;
        continue;
      }
      console.log('当前页解析出 0 个商品且分页控件不可见，本轮按分页失败结束（不冒充列表耗尽）');
      paginationError = 'pagination_ui_not_found';
      break;
    }

    // 处理商品 - 跳过已有记录的商品，尝试写入targetCount个商品
    console.log(`[循环开始] targetCount=${targetCount}, writeCount=${writeCount}, 当前页商品数=${productsWithOrders.length}`);

    // 创建一个共享的订单页面，所有商品复用（延迟加载，在第一个商品详情页处理完毕后才首次创建）
    let orderPage = null;

    for (const product of productsWithOrders) {
      // 暂停检查：暂停时阻塞等待（浏览器保持打开），继续后接着处理下一个商品
      await waitIfPaused();
      // 已达目标数量，停止处理
      if (writeCount >= targetCount) {
        console.log(`已写入 ${writeCount}/${targetCount}，停止处理`);
        break;
      }
      console.log(`\n\n########## [商品ID: ${product.id}] ########## (已写入${writeCount}/${targetCount})`);

      // 临时跳过集合检查：本轮或前几轮已判定无需抓取/已写入的商品，直接跳过，减少反爬风险
      if (skipProductIds && skipProductIds.has(String(product.id))) {
        console.log(`  跳过抓取：商品 ${product.id} 已在临时跳过列表中`);
        continue;
      }

      // ⚠️ orderPage 必须在 existingRecord 判断之前就绪（2026-08-29 修复）。
      // 否则「近期已有记录」分支走 3344 行 if (!orderPage) 时永远 null，会误报「订单页面不可用，跳过成本检查」。
      // 之前此初始化放在 3508 行（getOrderData 之前），导致 existingRecord 短路跳出用不上。
      if (!orderPage) {
        console.log('>> 首次初始化订单列表页面...');
        try {
          orderPage = await context.newPage();
          await orderPage.goto(CONFIG.douyin.orderListUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          await orderPage.waitForTimeout(5000);
          try {
            await orderPage.locator('input[placeholder="请输入"]').first().waitFor({ state: 'visible', timeout: 10000 });
            console.log('订单列表页面加载完成');
          } catch (e) {
            console.log('等待输入框超时:', fmtErr(e));
          }
        } catch (e) {
          console.log('创建订单页面失败:', fmtErr(e));
        }
      }

      // 检查前刷新token
      try {
        freshToken = await getFeishuToken();
      } catch (e) {}

      // 先检查飞书表格中是否有近期记录（forceFull模式下跳过）
      let existingRecord = false;
      if (!forceFull) {
        existingRecord = await checkRecentRecord(freshToken, product.id);
      }
      if (existingRecord) {
        // 即使跳过抓取，也要检查成本是否更新
        skippedCount++;
        if (skipProductIds) skipProductIds.add(String(product.id));
        let costCheckFailed = false; // AUTO-CONT-1: 成本核对未完成则不得确认"已处理"
        console.log(`  跳过抓取：近期已有记录（本轮已跳过${skippedCount}个），加入临时跳过列表，检查成本是否更新...`);
        // 使用共享的订单页面查询成本
        try {
          if (!orderPage || orderPage.isClosed()) {
            console.log('  订单页面不可用，跳过成本检查');
            // AUTO-CONT-1: 成本核对没完成就不能算已处理——登记失败身份并移出成功集合
            hasWriteFailure = true;
            markProductFailed(analyzerState, skipProductIds, product.id);
            continue;
          }
        } catch (e) {
          console.log('  检查订单页面状态失败:', fmtErr(e));
          hasWriteFailure = true;
          markProductFailed(analyzerState, skipProductIds, product.id);
          continue;
        }
        try {
          // F-P01/F-P02/F-P04: 统一用 fillAndSearchOrderProductId（先采 before 签名，再唯一定位，再命中等待）
          const costSearch = await fillAndSearchOrderProductId(orderPage, product.id);
          if (!costSearch.ok) {
            console.log('[跳过] 商品 ' + product.id + ' 成本搜索定位失败: ' + costSearch.reason);
            await dumpEvidence(orderPage, 'cost-search-' + product.id);
            await sleep(2000);
            hasWriteFailure = true;
            markProductFailed(analyzerState, skipProductIds, product.id);
            continue;
          }
          if (costSearch.matched !== String(product.id) && costSearch.matched !== '暂无数据') {
            console.log('[跳过] 商品 ' + product.id + ' 成本搜索未命中 (matched=' + costSearch.matched + ' before=' + String(costSearch.signatureBefore).slice(0,40) + ' after=' + String(costSearch.signatureAfter).slice(0,40) + ')');
            await sleep(2000);
            hasWriteFailure = true;
            markProductFailed(analyzerState, skipProductIds, product.id);
            continue;
          }
          // 获取商家编码（F-P05: 要求行含 pid）
          const costOrderData = await getOrderData(orderPage, CONFIG.douyin.orderListUrl, product.id, costSearch.productName);
          // AUTO-CONT-1补修(缺口二): 订单数据读不到（null/无商家编码）=成本核对未完成，
          // 不得确认已处理——登记失败身份（下一轮重试）。
          if (!costOrderData || !costOrderData.merchantCode) {
            console.log('[跳过] 商品 ' + product.id + ' 成本核对未完成：订单数据不可读（' + (costOrderData ? '无商家编码' : 'getOrderData=null') + '）');
            hasWriteFailure = true;
            costCheckFailed = true;
            markProductFailed(analyzerState, skipProductIds, product.id);
          }
          if (costOrderData && costOrderData.merchantCode) {
            let merchantCode = costOrderData.merchantCode;
            // 清理商家编码：去掉中文描述、颜色、尺码等
            merchantCode = merchantCode.replace(/[-_].*$/, '');  // 去掉 -灰色;L 等
            // 保留特定中文词汇(套装/上衣/裤子)——仅当出现在末尾时
            const endKeywords = /(套装|上衣|裤子)+$/;
            const endMatch = merchantCode.match(endKeywords);
            merchantCode = merchantCode.replace(/[一-龥]+/g, '');
            merchantCode = merchantCode.replace(/\s+$/, '');
            merchantCode = merchantCode.replace(/(?:\d?(?:XXXL|XXL|XL|XXS|XS)|XXXL|XXL|XL|XXS|XS)$/i, '');
            if (endMatch) {
              merchantCode += endMatch[0];
            }
            merchantCode = merchantCode.replace(/[^a-zA-Z0-9+\u4e00-\u9fff]/g, '').trim();  // 保留字母数字+中文
            console.log(`  商家编码: ${costOrderData.merchantCode} -> ${merchantCode}`);
            // 查询成本
            let newCost = null;
            if (merchantCode.includes('+')) {
              const parts = merchantCode.split('+');
              const firstPrefix = parts[0].match(/^([a-zA-Z]+)/)[1];
              let totalCost = 0;
              let allFound = true;
              for (const part of parts) {
                const fullCode = /^[a-zA-Z]/.test(part) ? part : firstPrefix + part;
                const partCost = await getCostFrom4thTable(freshToken, fullCode);
                if (partCost !== null) totalCost += Number(partCost);
                else allFound = false;
              }
              if (allFound) newCost = Number(totalCost.toFixed(2));
            } else {
              newCost = await getCostFrom4thTable(freshToken, merchantCode);
            }
            if (newCost !== null && newCost !== undefined) {
              // 检查现有记录的成本是否需要更新
              const baseUrl = `https://open.feishu.cn/open-apis/bitable/v1/apps/${CONFIG.feishu.app_token}/tables/${CONFIG.feishu.table_id}`;
              const recUrl = `${baseUrl}/records?page_size=100&filter=CurrentValue.[商品id]="${product.id}"`;
              const recRes = await fetch(recUrl, { headers: { 'Authorization': `Bearer ${freshToken}` } });
              const recData = await recRes.json();
              // AUTO-CONT-1补修(缺口二): 记录查询被拒绝（HTTP错误/平台code≠0）=结果未知，
              // 不能当作"无需更新"处理；成本查无记录（items为空且code=0）才是合法的"无需更新"。
              if (!recRes.ok || !recData || recData.code !== 0) {
                console.log('[跳过] 商品 ' + product.id + ' 成本核对未完成：记录查询被拒绝（HTTP ' + recRes.status + ' code=' + (recData && recData.code) + '）');
                hasWriteFailure = true;
                costCheckFailed = true;
                markProductFailed(analyzerState, skipProductIds, product.id);
              } else if (recData.data && recData.data.items && recData.data.items.length > 0) {
                const rec = recData.data.items[0];
                const oldCost = rec.fields['成本'];
                if (oldCost !== newCost) {
                  console.log(`  成本变化: ${oldCost} -> ${newCost}，更新记录`);
                  const updRes = await fetch(`${baseUrl}/records/${rec.id}`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bearer ${freshToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ fields: { '成本': Number(newCost) } })
                  });
                  let updData = null;
                  try { updData = await updRes.json(); } catch (e) {}
                  // AUTO-CONT-1补修(缺口二): 成本更新必须核对 HTTP 与平台业务结果，
                  // 拒绝或结果未知（JSON解析失败）不得记成功。
                  if (!updRes.ok || !updData || updData.code !== 0) {
                    console.log('[跳过] 商品 ' + product.id + ' 成本更新未完成：HTTP ' + updRes.status + ' code=' + (updData && updData.code) + '（结果未知，不记成功）');
                    hasWriteFailure = true;
                    costCheckFailed = true;
                    markProductFailed(analyzerState, skipProductIds, product.id);
                  } else {
                    console.log('  成本更新完成');
                  }
                } else {
                  console.log(`  成本无变化: ${newCost}`);
                }
              }
            }
          }
        } catch (e) {
          console.log('[跳过] 商品 ' + product.id + ' 成本检查失败: ' + fmtErr(e));
          // AUTO-CONT-1: 成本核对异常=工作未完成，登记失败身份（下一轮重试），不留在成功集合
          hasWriteFailure = true;
          costCheckFailed = true;
          markProductFailed(analyzerState, skipProductIds, product.id);
        }
        // AUTO-CONT-1: 成本核对正常完成（无论是否需要更新）时，这里才确认"已处理"并持久化
        if (!costCheckFailed) markProductProcessed(analyzerState, skipProductIds, product.id);
        await sleep(2000);
        continue;
      }

      console.log(`  开始处理...`);
      console.log(`  开始处理，当前writeCount=${writeCount}`);

      // 获取详情页数据（退货率、退款人数、发货后退货率等；投放消耗取列表页）
      // 销量=1时跳过退货率抓取（不需要判断退货率）
      let detailResult = null;
      if (product.orderCount === 1) {
        console.log('  销量=1，跳过退货率详情页抓取');
      } else {
        // 详情页获取，最多重试2次
        const maxRetries = 2;
        for (let retry = 0; retry <= maxRetries; retry++) {
          // 暂停检查：命中详情页 retry 时也能在 ≤2s 内停住（浏览器保持打开）
          await waitIfPaused();
          try {
            detailResult = await getDetailPageData(context, page, product.id);
            if (detailResult && detailResult.rate !== null) {
              console.log(`  详情页数据获取成功${retry > 0 ? '（第' + retry + '次重试）' : ''}`);
              break;
            }
            if (retry < maxRetries) {
              console.log(`  详情页数据为空，${retry + 1}/${maxRetries}次重试...`);
              for (let remain = 5000; remain > 0; remain -= 2000) { await sleep(Math.min(2000, remain)); await waitIfPaused(); }
            }
          } catch (e) {
            console.log(`  详情页获取异常: ${fmtErr(e)}${retry < maxRetries ? '，重试中...' : '，放弃'}`);
            if (retry < maxRetries) { for (let remain = 5000; remain > 0; remain -= 2000) { await sleep(Math.min(2000, remain)); await waitIfPaused(); } }
          }
        }
        // 详情页 rate 缺失不视为整条商品失败；继续走后续商家编码/成本/广告消耗写入路径（writeToFeishu 已有 listReturnRate/postShippingRate 兜底）
        if (!detailResult) {
          console.log(`>> 详情页数据获取异常（detailResult为null），商品 ${product.id} 仍继续处理，修正退货率相关字段留空`);
        } else if (detailResult.rate === null) {
          console.log(`>> 详情页修正退货率未获取到（已重试${maxRetries + 1}次），商品 ${product.id} 仍继续处理，列表页数据（listReturnRate/postShippingRate）可正常写入`);
        }
      }
      const realReturnRate = detailResult ? detailResult.rate : null;

      // 注意：不在这里用 returnRate 填充 postShipRate，因为两者含义不同
      // 列表页退货率和详情页发货后退货率是不同维度的数据

      if (realReturnRate !== null && realReturnRate !== undefined) {
        product.totalRefundRate = realReturnRate;
        product.returnRate = realReturnRate;
        console.log(`>> 修正退货率: ${realReturnRate}%`);
      } else {
        // 修正退货率获取失败或退款人数不足，留空
        product.returnRate = null;
        console.log('>> 修正退货率为空');
      }

      // 退款订单数作为修正退货率参考销量
      if (detailResult && detailResult.refundOrderCount !== null && detailResult.refundOrderCount !== undefined) {
        product.refundOrderCount = detailResult.refundOrderCount;
        console.log(`>> 修正退货率参考销量(退款订单数): ${detailResult.refundOrderCount}`);
      } else {
        product.refundOrderCount = null;
      }

      // 发货前退款率和修正发后退货率
      if (detailResult && detailResult.preShipRefundRate !== null) {
        product.preShipRefundRate = detailResult.preShipRefundRate;
        console.log(`>> 发货前退款率: ${detailResult.preShipRefundRate}%`);
      } else {
        product.preShipRefundRate = null;
      }
      if (detailResult && detailResult.postShipRefundRate !== null) {
        product.postShipRefundRate = detailResult.postShipRefundRate;
        console.log(`>> 修正发后退货率: ${detailResult.postShipRefundRate}%`);
      } else {
        product.postShipRefundRate = null;
      }

      // 发货后退款率来自详情页；投放消耗只取列表页（2026-08-16 起详情页不再抓取）
      if (detailResult && detailResult.postShippingRate !== null && detailResult.postShippingRate !== undefined) product.postShippingRate = detailResult.postShippingRate;
      console.log(`>> 发货后退款率: ${detailResult?.postShippingRate}%, 投放消耗(列表页): ${product.adSpend !== undefined && product.adSpend !== -1 ? product.adSpend : '-'}`);

      // 使用共享的订单页面获取商家编码、最新售价、商品图片
      console.log('>> 从订单列表获取数据...');
      try {
        if (!orderPage || orderPage.isClosed()) {
          console.log('  订单页面不可用，跳过');
          // AUTO-CONT-1补修(缺口二): 实际未完成，不得裸 continue——登记失败身份（下一轮重试）
          hasWriteFailure = true;
          markProductFailed(analyzerState, skipProductIds, product.id);
          continue;
        }
      } catch (e) {
        console.log('  检查订单页面状态失败:', fmtErr(e));
        hasWriteFailure = true;
        markProductFailed(analyzerState, skipProductIds, product.id);
        continue;
      }
      try {
        // F-P01/F-P02/F-P03/F-P04: 统一用 fillAndSearchOrderProductId（诊断已在 helper 内）
        const mainSearch = await fillAndSearchOrderProductId(orderPage, product.id);
        if (!mainSearch.ok) {
          console.log('[跳过] 商品 ' + product.id + ' 订单页定位失败: ' + mainSearch.reason);
          await dumpEvidence(orderPage, 'main-search-' + product.id);
          await sleep(2000);
          // AUTO-CONT-1补修(缺口二): 搜索定位失败=本轮未完成，登记失败身份
          hasWriteFailure = true;
          markProductFailed(analyzerState, skipProductIds, product.id);
          continue;
        }
        if (mainSearch.matched !== String(product.id) && mainSearch.matched !== '暂无数据') {
          console.log('[跳过] 商品 ' + product.id + ' 搜索未命中 (matched=' + mainSearch.matched + ' before=' + String(mainSearch.signatureBefore).slice(0,40) + ' after=' + String(mainSearch.signatureAfter).slice(0,40) + ')');
          await sleep(2000);
          // AUTO-CONT-1补修(缺口二): 搜索归属不符=本轮未完成，登记失败身份
          hasWriteFailure = true;
          markProductFailed(analyzerState, skipProductIds, product.id);
          continue;
        }
        console.log(`  搜索命中: ${mainSearch.matched} before=${String(mainSearch.signatureBefore).slice(0,30)} after=${String(mainSearch.signatureAfter).slice(0,30)}`);

        // 提取订单列表中的信息
        const orderData = await orderPage.evaluate((data) => {
          const { pid, pname, selectedProductName } = data;
          const rows = document.querySelectorAll('tbody tr');

          // 收集调试信息
          const debugInfo = {
            rowCount: rows.length,
            pid,
            pname: pname?.substring(0, 20),
            selectedProductName: selectedProductName?.substring(0, 30)
          };

          if (rows.length === 1 && rows[0].innerText.includes('暂无数据')) {
            return { found: false, reason: 'no_data', debug: debugInfo };
          }

          // 收集前3行的文本用于调试
          const sampleRows = [];
          for (let i = 0; i < Math.min(3, rows.length); i++) {
            sampleRows.push(rows[i].innerText.substring(0, 200));
          }
          debugInfo.sampleRows = sampleRows;

          // 遍历所有行，提取第一个有效订单的信息 - F-P05: 要求行含 pid
          for (const row of rows) {
            const rowText = row.innerText || '';

            // 跳过空行或"暂无数据"
            if (!rowText || rowText.includes('暂无数据')) continue;

            // ⚠️ 订单行的「商品单ID」与搜索用的罗盘商品ID不是同一套 ID，行文本里不含 pid，
            // 用 pid 过滤会把正确结果全部漏掉（2026-08-28 修复搜索命中后仍报 not_found）。
            // 搜索命中已由 fillAndSearchOrderProductId 严格校验（弹层选中值+结果行全含商品名），
            // 这里再用已选建议项的商品名过滤一次，防止取到旧结果串行。
            if (selectedProductName && !rowText.includes(selectedProductName)) continue;

            // 只要行里有¥符号就认为是有效订单行
            if (!rowText.includes('¥')) continue;

            const img = row.querySelector('img');

            let merchantCode = '';
            const codeMatch = rowText.match(/商家编码[：:]\s*(\S+)/);
            if (codeMatch) merchantCode = codeMatch[1];

            let merchantIncome = '';
            const incomeMatch = rowText.match(/¥\s*([\d,]+\.?\d*)/g);
            if (incomeMatch && incomeMatch.length >= 2) {
              merchantIncome = incomeMatch[1].replace(/[¥,\s]/g, '');
            } else if (incomeMatch && incomeMatch.length === 1) {
              merchantIncome = incomeMatch[0].replace(/[¥,\s]/g, '');
            }

            // 找到第一个有金额的行就返回
            if (merchantIncome || merchantCode) {
              return {
                found: true,
                imageUrl: img ? img.src : '',
                merchantCode: merchantCode,
                merchantIncome: merchantIncome,
                debug: debugInfo
              };
            }
          }
          return { found: false, reason: 'not_found', debug: debugInfo };
        }, { pid: product.id, pname: product.name, selectedProductName: mainSearch.productName });
        console.log(`  订单数据: ${JSON.stringify(orderData)}`);

        if (orderData.found) {
          product.imageUrl = orderData.imageUrl || product.imageUrl;
          // 处理商家编码：去掉中文描述，保留字母、数字、+
          let processedCode = orderData.merchantCode;
          // 去掉连字符或下划线及其后面的所有内容（如 -XL, _XL, -浅蓝26 等）
          processedCode = processedCode.replace(/[-_].*$/, '');
          // 保留末尾的特定中文词汇(套装/上衣/裤子)
          const endKeywords2 = /(套装|上衣|裤子)+$/;
          const endMatch2 = processedCode.match(endKeywords2);
          processedCode = processedCode.replace(/[一-龥]+/g, '');
          if (endMatch2) {
            processedCode += endMatch2[0];
          }
          // 去掉所有剩余符号（保留字母、数字、+和中文）
          processedCode = processedCode.replace(/[^a-zA-Z0-9+\u4e00-\u9fff]/g, '');
          // 处理省略前缀的情况：+732 → 前缀+732（使用第一个编码的前缀）
          const firstCodeMatch = processedCode.match(/^([a-zA-Z]+)\d+/);
          if (firstCodeMatch) {
            const prefix = firstCodeMatch[1];
            // 把+数字的格式补全为前缀+数字
            processedCode = processedCode.replace(/\+(\d+)/g, '+' + prefix + '$1');
          }
          // 拆分多个编码（如XLFE756XLFE758 → [XLFE756, XLFE758]，XLFE756+XLFE758 → [XLFE756, XLFE758]）
          const allCodes = processedCode.match(/[a-zA-Z]+\d+/g);
          if (allCodes && allCodes.length >= 2) {
            const first = allCodes[0];
            const firstPrefix = first.match(/^([a-zA-Z]+)/)[1];
            const restParts = [];
            for (let i = 1; i < allCodes.length; i++) {
              const code = allCodes[i];
              const codePrefix = code.match(/^([a-zA-Z]+)/)[1];
              const codeNumber = code.match(/[a-zA-Z]+(\d+)/)[1];
              if (firstPrefix === codePrefix) {
                // 同档口缩写，省略前缀：XLFE756+758
                restParts.push(codeNumber);
              } else {
                // 不同档口缩写，保留全称：XLFE756+BCYZ123
                restParts.push(code);
              }
            }
            processedCode = first + '+' + restParts.join('+');
          } else if (allCodes && allCodes.length === 1) {
            const trailingMatch = processedCode.match(/(套装|上衣|裤子)$/);
            processedCode = allCodes[0] + (trailingMatch ? trailingMatch[0] : '');
          }
          product.merchantCode = processedCode;
          product.merchantIncome = parseFloat(orderData.merchantIncome) || 0;
          console.log(`>> 图片:${orderData.imageUrl ? '有' : '无'} 商家编码:${product.merchantCode} 售价:${product.merchantIncome}`);

          // 查询成本（含+的编码拆分后分别查询再求和）
          console.log('>> 查询成本...');
          if (product.merchantCode.includes('+')) {
            const parts = product.merchantCode.split('+');
            const firstPrefix = parts[0].match(/^([a-zA-Z]+)/)[1];
            let totalCost = 0;
            let allFound = true;
            for (const part of parts) {
              // 还原省略前缀的编码（如758 → XLFE758）
              const fullCode = /^[a-zA-Z]/.test(part) ? part : firstPrefix + part;
              const partCost = await getCostFrom4thTable(freshToken, fullCode);
              if (partCost !== null) {
                totalCost += Number(partCost);
                console.log(`>> ${fullCode} 成本: ${partCost}`);
              } else {
                console.log(`>> ${fullCode} 成本: 未找到`);
                allFound = false;
              }
            }
            if (allFound) {
              product.cost = Number(totalCost.toFixed(2));
              console.log(`>> 合计成本: ${product.cost}`);
            } else {
              console.log('>> 部分编码成本未找到，跳过合计');
            }
          } else {
            const cost = await getCostFrom4thTable(freshToken, product.merchantCode);
            if (cost !== null) {
              product.cost = cost;
              console.log(`>> 成本: ${cost}`);
            } else {
              console.log('>> 成本: 未找到');
            }
          }

          // 数据校验：跳过明显异常的数据避免污染
          // postShipRefundRate = 修正发后退货率（从详情页提取）
          // postShippingRate = 发货后退款率（从详情页提取）
          // 注意：详情页抓取失败时这两个字段为 null/undefined，属于「未取到」而非「异常」，
          // 不应跳过写入（列表页 listReturnRate 仍有效，writeToFeishu 对空值也有兜底）
          const listRate = product.postShipRefundRate;
          const correctedRate = product.postShippingRate;
          const isInvalidRate = (r) => {
            if (r === null || r === undefined) return false; // 未取到 → 不视为异常
            const n = Number(r);
            return isNaN(n) || n < 0 || n > 100;
          };
          if (isInvalidRate(listRate) && isInvalidRate(correctedRate)) {
            console.log(`>> 跳过：数据异常 (修正发后退货率=${listRate}%, 发货后退款率=${correctedRate}%)，不写入飞书`);
            // AUTO-CONT-1: 数据异常是有意排除（避免污染表），不算失败，但必须计数：
            // 它让"列表走完且无未处理商品"的耗尽证据不成立，防止带着遗漏冒充完成。
            unprocessedLeft++;
            continue;
          }

          // 写入飞书前刷新token（避免过期）
          try {
            freshToken = await getFeishuToken();
          } catch (e) {
            console.log(`>> 刷新token失败: ${fmtErr(e)}`);
          }

          // 立即写入飞书
          console.log('>> 写入飞书...');
          let writeSuccess = false;
          try {
            writeSuccess = await writeToFeishu(freshToken, [product], shopName, premiumMap);
          } catch (e) {
            console.log(`>> 写入飞书出错: ${fmtErr(e)}`);
          }
          if (writeSuccess) {
            console.log('>> 写入完成');
            writeCount++;
            // AUTO-CONT-1: 写入成功=本次运行首次确认已处理，逐商品持久化到运行级状态文件
            //（修复旧代码只加内存集合、从不调用 markProcessed 导致状态文件始终为空的缺陷）
            markProductProcessed(analyzerState, skipProductIds, product.id);
            // 收集商品数据用于清理旧记录
            processedProducts.push({
              id: product.id,
              orderCount: product.orderCount
            });
            console.log(`>> 开始清理旧记录，动态阈值: >=${product.orderCount}单`);
            try {
              await cleanOldRecords(freshToken, shopName, product.orderCount);
            } catch (e) {
              console.log(`>> 清理旧记录失败: ${fmtErr(e)}`);
            }
          } else {
            console.log('>> 写入失败');
            // AUTO-CONT-1: writeToFeishu 返回 false 必须完整上报失败，不能让 allSuccess=true 掩盖遗漏
            hasWriteFailure = true;
            markProductFailed(analyzerState, skipProductIds, product.id);
          }
        } else {
          console.log(`  未找到订单记录`);
          // AUTO-CONT-1: 列表页显示有成交但订单列表查不到——按失败登记，下一轮重试；
          // 不再静默跳过（否则 allSuccess=true 掩盖遗漏，且无法与"已处理"区分）。
          hasWriteFailure = true;
          markProductFailed(analyzerState, skipProductIds, product.id);
        }
      } catch (e) {
        console.log(`  查询失败: ${fmtErr(e)}`);
        markProductFailed(analyzerState, skipProductIds, product.id);
        hasWriteFailure = true;
      }
      await sleep(2000);
    }

    // 关闭共享的订单页面
    try {
      if (orderPage && !orderPage.isClosed()) {
        try { await orderPage.close(); } catch {}
      }
    } catch (e) {
      console.log('关闭订单页面失败:', fmtErr(e));
    }

    // 当前页处理完毕，检查是否需要翻页
    // 如果没有找到有订单的商品，停止翻页
    if (productsWithOrders.length === 0) {
      console.log('当前页没有有订单的商品，停止翻页');
      break;
    }

    // 检查是否已写入够目标数量
    if (writeCount >= targetCount) {
      console.log(`已写入 ${writeCount}/${targetCount} 个商品，完成本轮`);
      break;
    }

    // 未够目标数量，尝试翻到下一页
    console.log(`未写入够 ${writeCount}/${targetCount}，尝试翻到下一页...`);
    const clicked = await goToNextPage(page);
    if (!clicked) {
      // AUTO-CONT-1: 区分「确认末页」与「分页失败/控件不可见」——只有确认末页才构成耗尽证据
      const paginationState = await getPaginationEndState(page);
      if (paginationState === 'last_page') {
        console.log('分页信息可见且无可用下一页，确认已到列表末页');
        endedByListEnd = true;
        break;
      }
      if (paginationState === 'has_next') {
        console.log('翻页失败但检测到有下一页，重试...');
        await sleep(2000);
        const retryClicked = await goToNextPage(page);
        if (!retryClicked) {
          console.log('重试翻页也失败，本轮按分页失败结束（不冒充列表耗尽）');
          paginationError = 'next_page_click_failed';
          break;
        }
      } else {
        console.log('分页控件不可见，无法确认是否有下一页，本轮按分页失败结束（不冒充列表耗尽）');
        paginationError = 'pagination_ui_not_found';
        break;
      }
    }

    await pausableSleep(10000); // 等待新页面加载
    currentPage++;
  }

  // AUTO-CONT-1: 轮末耗尽证据计算。可靠耗尽=走完整份列表并确认末页，且本轮无失败、
  // 无未登记身份的商品遗留。hitZeroOrder（0单页）由调用方按原口径处理。
  const failedCount = analyzerState ? analyzerState.failedKeys.size : (hasWriteFailure ? 1 : 0);
  const exhausted = !extractionError && !paginationError && endedByListEnd
    && !hasWriteFailure && failedCount === 0 && unprocessedLeft === 0;
  if (exhausted) {
    console.log('AUTO-CONT-1: 列表已走完且无未处理商品 → 上报可靠耗尽证据（exhausted=true）');
  } else if (endedByListEnd) {
    console.log(`AUTO-CONT-1: 走到列表末页但有未解决项（失败=${failedCount} 未处理遗留=${unprocessedLeft}）→ 不上报耗尽`);
  }

  console.log(`\n本轮处理完成：写入${writeCount}个商品`);

  return {
    processedCount, writeCount, hitZeroOrder, skippedCount, processedProducts,
    allSuccess: !hasWriteFailure && !extractionError && !paginationError,
    exhausted,
    unprocessedLeft,
    extractionError: extractionError || null,
    paginationError: paginationError || null,
  };
}

async function main() {
  console.log('===========================================');
  console.log('抖店商品数据采集脚本');
  console.log('===========================================\n');

  // 参数解析: argv[2]=targetCount, argv[3]=intervalMinutes, argv[4]='multi'
  // shopName通过临时文件传递
  const targetCount = parseInt(process.argv[2]) || 1;
  const intervalMinutes = parseInt(process.argv[3]) || 30;
  const isMultiMode = process.argv[4] === 'multi';
  const isFullRefresh = process.argv.includes('--full');
  const isHeadless = process.argv.includes('--headless');

  // 从临时文件读取店铺名
  let shopNameArg = '';
  const shopNameFile = path.join(__dirname, 'current_shop.txt');
  try {
    if (fs.existsSync(shopNameFile)) {
      shopNameArg = fs.readFileSync(shopNameFile, 'utf-8').trim();
    }
  } catch (e) {}

  // ========== MULTISHOP-ISOLATION-20261027（D2/D3）：店铺名只认精确文件 ==========
  // 旧的"乱码反向修复"会在店铺名含 U+FFFD 时按 mtime 取目录内最新 Cookie 文件顶替
  // 店铺名——多店环境下这就是把别的店当本店。已删除：乱码名同样只认自己的精确文件。
  // D3：不新增启动前阻断——即使普通精确文件缺失/损坏，既有的四层恢复链仍可从
  // 本店只读归档恢复工作副本（缺失的 A 绝不借用 B，但 A 仍可从 A 的归档自救）。

  process.stdout.write('shopName from file: ' + shopNameArg + '\n');

  // ISOLATION_DEPLOY_VERSION=2026-09-15-isolation-v1
  process.stdout.write('ANALYZER_VERSION=2026-10-16-r75-checkpoint-v1\n');
  let __skipProductIds = null;
  let __analyzerState = null;
  try {
    const { AnalyzerState } = require('./isolation-runtime/analyzerState');
    const runId = process.env.AUTO_RUN_ID || '';
    __analyzerState = new AnalyzerState({
      platform: 'douyin',
      shopName: shopNameArg || '',
      runId: runId || null,
      workspace: __dirname,
    });
    __analyzerState.load();
    __skipProductIds = __analyzerState.skipProductIds;
    console.log('[isolation] runId=' + runId + ' shop=' + (shopNameArg || '') + ' stateFile=' + (__analyzerState.stateFile || '(none)'));
  } catch (e) {
    console.log('[isolation] analyzerState init failed: ' + e.message);
  }
  // 从临时文件读取费用配置
  let shippingFee = 2.4;
  let insurance = 4.01;
  const feeConfigFile = path.join(__dirname, 'fee_config.json');
  try {
    if (fs.existsSync(feeConfigFile)) {
      const feeConfig = JSON.parse(fs.readFileSync(feeConfigFile, 'utf-8'));
      shippingFee = feeConfig.shippingFee || 2.4;
      insurance = feeConfig.insurance || 4.01;
    }
  } catch (e) {}
  process.stdout.write('Fee config: shipping=' + shippingFee + ', insurance=' + insurance + '\n');
  SHIPPING_FEE = shippingFee;
  INSURANCE = insurance;

  // 构建cookie路径（MULTISHOP-ISOLATION-20261027 D2/D3：解析统一走 resolveAnalyzerCookiePath，
  // 显式店铺名（含乱码名）只认自己的精确文件，缺失/不可用绝不跨店借用；
  // 不做启动前阻断——普通文件缺失/损坏时由既有恢复链处理（保留 A 从 A 自救的路径））
  const cookieResolve = resolveAnalyzerCookiePath({ shopNameArg, cookiesDir: COOKIES_DIR, fsMod: fs });
  let cookiePath = cookieResolve.cookiePath;
  if (shopNameArg) {
    process.stdout.write('Cookie路径: ' + cookiePath + '\n');
    if (cookieResolve.status === 'missing-exact') {
      process.stdout.write('[ERROR] Cookie文件未找到（多店隔离：不做跨店模糊匹配）: '
        + cookiePath + '（目录内共' + cookieResolve.cookieFiles + '个Cookie文件，请核对店铺名与文件名）\n');
    } else if (cookieResolve.status === 'list-failed') {
      process.stdout.write('[ERROR] Cookie文件查找失败: ' + cookieResolve.error + '\n');
    }
  }

  // AD-COOKIE-SOURCE-READONLY-20261018 / AD-COOKIE-FOUR-TIER-20261019-F1：
  // 分析器对 Cookie 的唯一可写目标是分析工作副本（cookiePath），且只经下方
  // analyzer-session-checkpoint（身份绑定 + 指纹 CAS）与恢复链写入；
  // 原始归档/推广目录仍只读（assertAnalyzerWorkTarget 拒绝）。
  // 此处重建检查点/恢复链所需的加载前基线：候选解析 + 指纹（absent 也记录）。
  const baseline0 = readAnalysisBaseline(cookiePath, fs);
  let startFingerprint = baseline0.startFingerprint;
  let candidateCookies = baseline0.candidateCookies;

  console.log(`目标处理商品数: ${targetCount}`);
  console.log(`浏览器运行模式: ${isHeadless ? '[静默]' : '[可视]'}`);
  if (isMultiMode) {
    console.log(`多次执行模式，间隔: ${intervalMinutes} 分钟`);
  }
  if (isFullRefresh) {
    console.log(`全量刷新模式: 跳过"近期已有记录"检查`);
  }

  // MULTISHOP-ISOLATION-20261027（D3）：browser/context/page 为 let——恢复链成功提升
  // 本店工作副本后会置换为新进程（每份 Cookie 独立进程），finally 与检查点必须
  // 作用于“最新 owned”会话，而不是停留在已关闭的旧失败浏览器上。
  const mainLaunchOptions = {
    headless: isHeadless,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: [
      '--start-maximized',
      '--window-size=1920,1080',
      '--disable-web-security'
    ]
  };
  const mainContextOptions = {
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1
  };
  let browser = await chromium.launch(mainLaunchOptions);

  // D6 候选进程隔离：候选验证专用工厂——每次调用启动全新浏览器进程（静默），
  // 复用既有 Edge 路径与窗口参数，不设永久 profile；主分析浏览器仍只归业务使用。
  // 工厂只负责启动浏览器，不做任何登录/扫码/SSO 流程。
  const candidateBrowserFactory = async () => chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    args: [
      '--window-size=1920,1080',
      '--disable-web-security'
    ]
  });

  let context = await browser.newContext(mainContextOptions);

  let page = await context.newPage();

  // 最大化窗口
  await page.bringToFront();
  await page.evaluate(() => {
    if (window.screen) {
      window.moveTo(0, 0);
      window.resizeTo(window.screen.availWidth, window.screen.availHeight);
    }
  });

  let loginSuccess = false;
  // AD-COOKIE-FOUR-TIER-20261019-F1：罗盘收尾检查点在 finally 需要 shopName，提前声明。
  let shopName = '';
  // MULTISHOP-ISOLATION-20261027（D3）：观察店铺与请求店铺不一致时置位——
  // finally 不得再用错误店铺的身份跑罗盘收尾检查点（绝不以 A 的目标写 B 的会话）。
  let shopMismatchStop = false;
  // MULTISHOP-ISOLATION-20261027（D5A）：恢复/置换/页面资源故障产生的普通错误不是
  // Cookie 过期证据——catch/finally 不得据此写 cookie_expired.txt 或发 COOKIE_EXPIRED。
  let suppressCookieExpiredMark = false;

  try {
    // 尝试加载保存的Cookie
    const cookieLoaded = await loadCookiesFromPath(context, cookiePath);
    if (!cookieLoaded) {
      console.log('未找到保存的Cookie或Cookie加载失败');
    }

    // Step 1: 访问抖店登录页/首页
    process.stdout.write('\nStep 1: 访问抖店首页...\n');
    process.stdout.write('正在加载页面，请稍候...\n');
    // D6E：初始导航的 goto 资源失败必须按普通错误处理（helper 打 analyzerNonAuthError
    // 标记并在 catch/finally 抑制 COOKIE_EXPIRED），绝不在登录成功前把健康工作副本写死。
    await gotoAnalyzerLoginPage(page, CONFIG.douyin.loginUrl);
    process.stdout.write('页面加载完成，等待5秒稳定...\n');
    await pausableSleep(5000);
    try {
      // 截图添加超时保护，防止永久挂起
      await Promise.race([
        page.screenshot({ path: 'step1-homepage.png', timeout: 10000 }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('screenshot timeout')), 15000))
      ]);
    } catch (e) {
      console.log('截图失败，继续执行:', fmtErr(e));
    }

    // D5A：登录状态改为被动等待受信首页落定（45s 上限 / 3s 间隔）。健康只读 Cookie
    // 的首页跳转实测约 15 秒、现场常见 30 秒，原先固定 5 秒后一次性读 URL 会在合法
    // 重定向完成前误判失败并进入扫码/COOKIE_EXPIRED。页面关闭等真实资源错误按普通
    // 错误抛出（不写成 Cookie 过期）。
    let isLoggedIn = await waitForAnalyzerHomepage(page, { sleep: pausableSleep });
    if (!isLoggedIn) {
      process.stdout.write('登录状态检测：45秒内仍未进入受信抖店首页（被动等待，未扫码/未导航）\n');
    }

    if (!isLoggedIn) {
      // AD-COOKIE-FOUR-TIER-20261019-F1：登录验证失败 → 恢复链
      //（分析工作副本 → 匹配店铺的最近原始快照）。候选先在隔离新上下文独立验证
      //（受信 FXG 非登录页 + 语义身份唯一且为本店），通过才 CAS 原子提升工作副本
      //（保留上一版；并发新内容胜出）；全部失败如实保留错误，不盲覆盖、不跨店。
      // 仅在明确登录/auth 失败路径触发；普通网络/DOM 故障不进入本恢复链。
      // D5A：恢复“查找”与“成功后的会话置换”分开。查找异常是普通错误，直接抛出，
      // 不再被宽泛 catch 吞成“不影响后续流程”后在旧关闭页上进入扫码/COOKIE_EXPIRED。
      let restored = null;
      try {
        restored = await restoreAnalysisWorkCopy({
          workPath: cookiePath,
          browser,
          candidateBrowserFactory,
          forbiddenBrowsers: [browser],
          verifyMaxWaitMs: 180000,
          roots: cookieVault.defaultRoots({ appRoot: __dirname }),
          audit: (e) => process.stdout.write('COOKIE_RESTORE_AUDIT:' + JSON.stringify(e) + '\n'),
        });
      } catch (e) {
        throw markAnalyzerNonAuthError(new Error('恢复链异常（普通错误，不按 Cookie 过期处理）: ' + fmtErr(e)));
      }
      if (restored && restored.ok) {
        process.stdout.write(`[FOUR-TIER] 已从 ${restored.source} 恢复分析工作副本（来源sha ${String(restored.sourceSha256).slice(0, 12)}…），置换为独立新进程后重试登录检测\n`);
        // MULTISHOP-ISOLATION-20261027（D3/D5A）：每份 Cookie 独立进程。旧失败浏览器/上下文
        // 必须先彻底关闭（close 成功且 isConnected 为假），再启动全新主分析浏览器；关闭失败
        // 立即停止，不做 force kill、不重叠两个 Cookie 进程。新会话不迁移旧 storageState/
        // localStorage/Cookie。置换/加载/被动等待失败都是普通错误（helper 回收 owned 新进程），
        // 直接抛出，不得落入扫码/COOKIE_EXPIRED 分支；只有恢复链未取得候选或被动等待到
        // 45 秒截止（isLoggedIn=false）才走既有 auth 失败分支。
        const handoff = await applyAnalyzerRestoreHandoff({
          oldBrowser: browser,
          launchOptions: mainLaunchOptions,
          contextOptions: mainContextOptions,
          cookiePath,
          fsMod: fs,
          loadCookiesFn: loadCookiesFromPath,
          loginUrl: CONFIG.douyin.loginUrl,
          sleepFn: pausableSleep,
        });
        browser = handoff.browser;
        context = handoff.context;
        page = handoff.page;
        // D3：基线推进到本店已提升工作副本（旧失败文件的指纹会让后续检查点
        // CAS 误拒自己刚提升的新文件并停止刷新）。
        startFingerprint = handoff.startFingerprint;
        candidateCookies = handoff.candidateCookies;
        isLoggedIn = handoff.isLoggedIn;
        // D3/D5A：仅当置换后新会话的被动等待真实通过才记成功；45 秒截止仍 false
        // 时不伪造成功，继续走下方未登录分支（QR/COOKIE_EXPIRED 如实处理）。
        if (handoff.loginSuccess) {
          process.stdout.write('已检测到登录状态（恢复链置换新进程后Cookie有效）\n');
          loginSuccess = true;
        }
      } else {
        process.stdout.write('[FOUR-TIER] 恢复链未取得可验证候选（不覆盖工作副本）\n');
      }
      if (!isLoggedIn) {
        if (isHeadless) {
          // 静默模式无法扫码，直接通知服务端 Cookie 已过期，避免等待扫码超时。
          const markerFile = path.join(__dirname, 'cookie_expired.txt');
          fs.writeFileSync(markerFile, shopNameArg);
          console.log(`COOKIE_EXPIRED:${shopNameArg}`);
          console.log(`RESULT:${JSON.stringify({ cookieExpired: true })}`);
          return;
        }
        process.stdout.write('需要扫码登录...\n');
        loginSuccess = await waitForQRCodeLogin(page);
        if (loginSuccess) {
          // AD-COOKIE-SOURCE-READONLY-20261018：商品分析流程不保存 Cookie。
          // 源 Cookie 文件只由扫码登录成功路径（login-shop.js，语义身份 + 复用校验 + CAS）更新；
          // 本分析器仅使用已加载的 Cookie，不再回写。
          process.stdout.write('登录成功！\n');
        } else {
          process.stdout.write('登录失败！\n');
          // 输出cookie过期信号，供server.js自动化流程检测并跳过重试
          console.log(`RESULT:${JSON.stringify({ cookieExpired: true })}`);
        }
      }
    } else {
      process.stdout.write('已检测到登录状态（Cookie有效）\n');
      loginSuccess = true;
    }

    if (!loginSuccess) {
      console.log('登录未成功，退出');
      if (shopNameArg) {
        console.log(`COOKIE_EXPIRED:${shopNameArg}`);
        // 写标记文件，让服务器检测
        try {
          const markerFile = path.join(__dirname, 'cookie_expired.txt');
          fs.writeFileSync(markerFile, shopNameArg);
          console.log('已写入cookie过期标记文件');
        } catch (e) {}
      }
      return;
    }

    // 等待页面稳定
    await pausableSleep(5000);
    try {
      await page.screenshot({ path: 'step1-after-login.png', timeout: 10000 });
    } catch (e) {
      console.log('截图失败，继续执行:', fmtErr(e));
    }

    // 获取店铺名称（页面右上角），在当前页面原地重试
    console.log('\n获取店铺名称...');
    shopName = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await sleep(2000);
        shopName = await getShopNameFromPage(page);
        if (shopName) break;
      } catch (e) {
        console.log(`获取店铺名称失败 (尝试 ${attempt + 1}/3): ${fmtErr(e)}`);
        if (attempt < 2) {
          console.log('等待页面稳定后重试...');
          await pausableSleep(5000);
        }
      }
    }
    if (!shopName && shopNameArg) {
      shopName = shopNameArg;
    }
    if (shopName) {
      shopName = shopName.replace(/瑮/g, '瑾');
    }
    console.log(`店铺名称: ${shopName}`);

    // MULTISHOP-ISOLATION-20261027（D3）：显式请求店铺与页面观察店铺不一致时必须停止——
    // 旧逻辑 expectedShopName 用 shopName||shopNameArg，会把观察到的错误店铺当成自己的
    // 期望店铺。归一比较沿用既有 瑮→瑾 与文件名安全替换（shopNamesMatch），无别名/模糊；
    // 不一致时不做检查点/罗盘/任何写（绝不以 A 的会话读写 B），如实报错并停止。
    if (shopNameArg && shopName && !shopNamesMatch(shopName, shopNameArg)) {
      // D4：错店观察 ≠ Cookie 过期。该分支不得写 cookie_expired.txt、不得发
      // COOKIE_EXPIRED（那会触发上游过期/换店重试流程，语义错误）；只发结构化
      // shopMismatch 结果。真正的登录失败/QR 行为仍由上方未登录分支处理。
      process.stdout.write(`[MULTISHOP-ISO] 页面店铺（${shopName}）与请求店铺（${shopNameArg}）不一致，停止分析（多店隔离：不跨店读写）\n`);
      shopMismatchStop = true;
      console.log(`RESULT:${JSON.stringify({ shopMismatch: true })}`);
      return;
    }

    // AD-COOKIE-FOUR-TIER-20261019-F1：接回已登录安全检查点（用户重新允许分析工作副本写回）。
    // 仅写分析工作副本：assertAnalyzerWorkTarget 拒绝归档/推广恢复目录/推广工作目录/另店文件；
    // 身份/上下文绑定 + 域完整性 + 指纹 CAS 由 analyzer-session-checkpoint 承担。
    // 不在登录页/错店/空候选写（检查点内部 fail-closed）；失败不影响分析流程。
    try {
      assertAnalyzerWorkTarget(cookiePath, { appRoot: __dirname });
      const cp = await saveAnalyzerSessionCheckpoint({
        context, page, cookiePath,
        expectedShopName: shopName || shopNameArg || '',
        candidateCookies, startFingerprint,
        roots: cookieVault.defaultRoots({ appRoot: __dirname }),
        browser,
        candidateBrowserFactory,
        forbiddenBrowsers: [browser],
        verifyMaxWaitMs: 180000,
        // 生产接线显式要求写前独立验证：缺候选独立进程能力时必须拒绝写回（不静默跳过）。
        requireCandidateVerification: true,
      });
      if (cp.ok) {
        process.stdout.write(`[FOUR-TIER] 分析工作副本检查点已保存（${cp.count} 条）\n`);
        if (cp.ownedFingerprint) startFingerprint = cp.ownedFingerprint;
        if (cp.ownedCookies) candidateCookies = cp.ownedCookies;
      } else {
        process.stdout.write(`[FOUR-TIER] 分析工作副本检查点跳过（${cp.code}）\n`);
      }
    } catch (e) {
      process.stdout.write('[FOUR-TIER] 检查点异常（不影响分析流程）: ' + fmtErr(e) + '\n');
    }

    // Step 2: 进入电商罗盘
    process.stdout.write('\nStep 2: 进入电商罗盘...\n');
    process.stdout.write('正在加载页面...\n');
    try {
      await page.goto('https://compass.jinritemai.com/shop', { waitUntil: 'domcontentloaded', timeout: 60000 });
      process.stdout.write('页面加载完成，等待15秒稳定...\n');
      await pausableSleep(15000);
      process.stdout.write('当前URL: ' + page.url() + '\n');
    } catch (e) {
      process.stdout.write('页面加载失败或超时: ' + fmtErr(e) + '\n');
      process.stdout.write('当前URL: ' + page.url() + '\n');
      // 继续执行，不退出
    }

    const accessToken = await getFeishuToken();
    const premiumMap = await loadPremiumMap(accessToken);
    // 每次脚本启动时创建临时跳过集合，用于在多次执行模式的多轮之间跳过已处理商品
    const skipProductIds = new Set();
    let lastResult = null;

    if (isMultiMode) {
      // 多次执行模式：循环直到遇到0单商品
      let roundCount = 1;
      while (true) {
        console.log(`\n========== 第 ${roundCount} 轮执行 ==========`);
        const result = await processProductRound(page, context, targetCount, accessToken, shopName, premiumMap, intervalMinutes, isFullRefresh, __skipProductIds || skipProductIds, __analyzerState);
        lastResult = result;

        if (result.hitZeroOrder) {
          console.log('\n遇到0单商品，多次执行停止');
          break;
        }

        if (result.writeCount === 0) {
          console.log('\n本轮未写入任何商品，停止多次执行');
          break;
        }

        console.log(`\n等待 ${intervalMinutes} 分钟后继续第 ${roundCount + 1} 轮...`);
        // 轮次间隔也用可打断睡眠：暂停/停止在漫长等待期间同样要能立即响应
        await pausableSleep(intervalMinutes * 60 * 1000);
        roundCount++;
      }
    } else {
      // 单次执行模式
      const result = await processProductRound(page, context, targetCount, accessToken, shopName, premiumMap, intervalMinutes, isFullRefresh, __skipProductIds || skipProductIds, __analyzerState);
      lastResult = result;

    }

    // 输出结构化结果供 server 解析（AUTO-CONT-1：RESULT 构建与状态持久化收口到
    // buildAnalyzerRunResult，生产入口与离线验证共用同一路径）
    if (lastResult) {
      const resultOut = buildAnalyzerRunResult({
        lastResult,
        skipProductIds: __skipProductIds,
        fallbackSkipProductIds: skipProductIds,
        analyzerState: __analyzerState,
        shopName: shopNameArg || '',
      });
      console.log(`RESULT:${JSON.stringify(resultOut)}`);
    }

    // Step 7: 截图保存商品列表（调试用，失败不影响流程）
    console.log('\nStep 7: 截图保存商品列表...');
    try {
      await page.screenshot({
        path: `product-list-final-${Date.now()}.png`,
        fullPage: false,
        timeout: 10000
      });
    } catch (e) {
      console.log('截图跳过:', fmtErr(e));
    }

  } catch (error) {
    // D5A：页面关闭/恢复置换失败等普通资源错误只按普通错误上报，绝不转成
    // COOKIE_EXPIRED（那会触发上游换店/过期重试流程，语义错误）。
    if (error && error.analyzerNonAuthError) suppressCookieExpiredMark = true;
    console.error('执行出错:', error.message);
    if (!loginSuccess && shopNameArg && !suppressCookieExpiredMark) {
      console.log(`COOKIE_EXPIRED:${shopNameArg}`);
      try {
        fs.writeFileSync(path.join(__dirname, 'cookie_expired.txt'), shopNameArg);
      } catch (e) {}
    }
  } finally {
    if (!loginSuccess && shopNameArg && !suppressCookieExpiredMark) {
      console.log(`COOKIE_EXPIRED:${shopNameArg}`);
      try {
        fs.writeFileSync(path.join(__dirname, 'cookie_expired.txt'), shopNameArg);
      } catch (e) {}
    }
    // AD-COOKIE-FOUR-TIER-20261019-F1：接回罗盘收尾检查点（R87 链路恢复，用户重新允许）。
    // 仅写分析工作副本（assertAnalyzerWorkTarget 门禁）；当前页非可信罗盘经营页/
    // 身份不符/页已关闭时由检查点自身安全跳过（零写入，不新增导航）。
    // MULTISHOP-ISOLATION-20261027（D3）：店铺不一致停止时，不得再用错误店铺身份写
    // 罗盘收尾检查点（上面 return 前只发结构化 shopMismatch 结果，不写 COOKIE_EXPIRED）。
    if (!shopMismatchStop) {
      try {
        assertAnalyzerWorkTarget(cookiePath, { appRoot: __dirname });
        const cp = await saveAnalyzerCompassCheckpoint({
          context, page, cookiePath,
          expectedShopName: shopName || shopNameArg || '',
          candidateCookies, startFingerprint,
          roots: cookieVault.defaultRoots({ appRoot: __dirname }),
          browser,
          candidateBrowserFactory,
          forbiddenBrowsers: [browser],
          verifyMaxWaitMs: 180000,
          // 生产接线显式要求写前独立验证：缺候选独立进程能力时必须拒绝写回（不静默跳过）。
          requireCandidateVerification: true,
        });
        if (cp.ok) {
          process.stdout.write(`[FOUR-TIER] 罗盘收尾检查点已保存（${cp.count} 条）\n`);
        } else {
          process.stdout.write(`[FOUR-TIER] 罗盘收尾检查点跳过（${cp.code}）\n`);
        }
      } catch (e) { /* 收尾保存失败不改变业务结果，也不阻止关闭 */ }
    }
    // 兜底清掉本进程可能写下的暂停标记（正常由「继续」删除；异常退出时防止跨次残留），然后关闭浏览器
    try { fs.unlinkSync(PAUSE_FLAG_FILE); } catch (e) {}
    // AD-COOKIE-SOURCE-READONLY-20261018：关闭浏览器前不再做罗盘阶段 Cookie 回写。
    // 普通商品分析全程只读源 Cookie 文件；源文件仅由扫码登录成功路径更新。
    // D3：关闭的是“最新 owned”浏览器（恢复置换后为恢复链提升副本启动的新进程）。
    await browser.close();
    console.log('\n脚本执行完毕');
  }
}

// AUTO-CONT-1（2026-10-04）：分析器运行结果收口函数——状态持久化 + RESULT 构建。
// 修复的缺陷：旧代码在此处调用不存在的 __analyzerState.save()（TypeError 被 try/catch 吞掉），
// 且正常写入路径只把商品加进内存 skipProductIds、从不调用 markProcessed()，
// 导致运行级状态文件从未落盘（实证 runId=prodmusgfw9o896b：RESULT 列出 processedKeys，
// 但状态文件 0 键）→ 父调度器每轮 newCount=0 → 两轮后假 NO_PROGRESS 提前停止（20个商品即停）。
// 本函数由 main()（真实生产入口）与离线验证共同调用，保证同一持久化/RESULT路径。
//   - finished 口径纠正：hitZeroOrder 或 exhausted（可靠耗尽证据）才算结束；
//     旧口径 writeCount===0 也算 finished，把零写入与耗尽混为一谈。
//   - 状态保存/加载失败通过 statePersistOk/stateLoadOk 上报，不再吞错；
//     任一失败时 allSuccess=false，父调度器不得把本轮计为新进展。
function buildAnalyzerRunResult(opts) {
  const lastResult = opts.lastResult || {};
  const analyzerState = opts.analyzerState || null;
  const skipSet = opts.skipProductIds || opts.fallbackSkipProductIds || null;
  const shopName = opts.shopName || '';

  let statePersistOk = true;
  let stateLoadOk = true;
  let stateError = null;
  if (analyzerState) {
    if (analyzerState.loadError) {
      stateLoadOk = false;
      stateError = 'state_load_failed: ' + analyzerState.loadError;
    }
    const p = analyzerState.persist();
    if (!p || p.ok !== true) {
      statePersistOk = false;
      stateError = 'state_persist_failed: ' + ((p && p.error) || stateError || 'unknown');
    }
  }

  return {
    finished: lastResult.hitZeroOrder === true || lastResult.exhausted === true,
    writeCount: lastResult.writeCount || 0,
    hitZeroOrder: lastResult.hitZeroOrder === true,
    allSuccess: lastResult.allSuccess === true && statePersistOk && stateLoadOk,
    exhausted: lastResult.exhausted === true,
    unprocessedLeft: lastResult.unprocessedLeft || 0,
    extractionError: lastResult.extractionError || null,
    paginationError: lastResult.paginationError || null,
    statePersistOk,
    stateLoadOk,
    stateError,
    processedKeys: Array.from(skipSet || []).map(pid => 'douyin|' + shopName + '|' + pid),
    failedKeys: Array.from((analyzerState && analyzerState.failedKeys) || []).map(pid => 'douyin|' + shopName + '|' + pid),
    analyzerVersion: '2026-10-05-auto-cont2-v1',
  };
}

// 运行主程序；被定向测试脚本 require 时只暴露订单输入 helper，不启动完整抓取。
if (require.main === module) {
  main();
} else {
  module.exports = {
    ORDER_LIST_URL: CONFIG.douyin.orderListUrl,
    // MULTISHOP-ISOLATION-20261027：多店 Cookie 文件解析与恢复链配套纯函数（离线回归只读入口）
    resolveAnalyzerCookiePath,
    shopNamesMatch,
    readAnalysisBaseline,
    replaceAnalyzerSessionAfterRestore,
    // D5A：被动首页落定 + 恢复后交接（离线回归直接调用真实 helper）
    markAnalyzerNonAuthError,
    isTrustedAnalyzerHomepageUrl,
    waitForAnalyzerHomepage,
    // D6E：初始入口与恢复交接共用的导航 helper（离线回归直接调用真实实现）
    gotoAnalyzerLoginPage,
    applyAnalyzerRestoreHandoff,
    loadCookiesFromPath,
    findOrderProductIdInput,
    fillAndSearchOrderProductId,
    // OD1补修 只读验证用：正常入口在查询之后就是这两个调用（成本检查分支 3755 行），
    // 这里只做导出暴露，不改任何行为，避免验证脚本复制生产提取逻辑。
    getOrderData,
    // OD1 离线回归用：字段/搜索框归属与选中态判定的可复用入口（只读，不触发抓取）
    orderProductFieldLocator,
    readSelectedOrderProductIds,
    readOrderProductSelectionState,
    countOrderProductSelectedTags,
    extractSelectedProductIds,
    shouldFocusOrderProductInput,
    ORDER_PRODUCT_LABEL_TEXT,
    LEGACY_ORDER_PRODUCT_POPUP_SELECTOR,
    // AUTO-CONT-1 离线验证用：分析器真实的状态持久化 + RESULT 构建路径（main 同款）
    buildAnalyzerRunResult
  };
}
