'use strict';

/**
 * 已验证会话 Cookie 检查点（R58，最小落地）。
 *
 * 背景（2026-10-15 实录）：openQianchuanHome 只记录会话起始指纹，openChengfangShop 在
 * 导航/视图失败时直接关浏览器，发布器的 saveCookies 在更晚阶段——打开失败时永远到不了。
 * 结果：会话期间浏览器内已刷新的 Cookie 在打开失败路径上被整批丢弃，下一次只能盲扫。
 *
 * 本模块**不改** cookie-writeback.js 的写入器与任何安全守卫，只在其上封装一个
 * "当前新鲜身份正证据 → 才允许持久化"的检查点：
 *
 *  1. 严格可信来源与受支持路径：URL 用 new URL 解析（protocol/host/path 精确比对），
 *     只认 https://qianchuan.jinritemai.com 的 /home、/uni-prom*、/overall-prom*、
 *     /promotion-v2*、/brand_bid* 管理路径；登录/授权中转页一律不算。绝不做子串 URL 判断。
 *  2. 当前可见头部身份唯一且严格匹配：页面探针只认可见的 [class*="shop-name"] 头部元素，
 *     候选必须恰好 1 个且账户ID 与配置 accountId 全等；缺失/多个/不一致（foreign）→ 跳过。
 *     不做正文兜底检索（宽松兜底容易把别处数字当身份）。
 *  3. 配置未提供 accountId（如 Jin 之外的未知账户）→ 明确跳过，不要求新增配置项、
 *     不硬编码任何店铺/账户；运行期身份发现链路保持不变。
 *  4. 每次调用都用**调用时刻**的事实重新核验（URL + 头部身份）；更早时刻身份通过
 *     不构成保存依据——登录页/无身份/身份不一致时绝不保存。
 *  5. 指纹推进（同属本会话的自有写入之后）：先取本会话 owned Cookie 数组并计算
 *     期望序列化 sha256（与写入器相同的 JSON.stringify(data,null,2) 字节）；
 *     写入成功后仅当落盘文件 sha256 与期望逐字节一致，才把 cookieSession.startFingerprint
 *     推进为落盘指纹。任何不一致（并发新登录/漂移）都不采用新指纹——后续回写继续受
 *     原指纹冲突保护（保留较新文件方向）。
 *  6. 检查点失败/跳过绝不改写业务结果：本模块只返回 {saved/skipped/reason}，
 *     不抛错上抛语义、不掩盖原始错误、不触发任何广告动作。
 *
 * 安全：不输出任何 Cookie 值；审计回调透传写入器（内容仅数量/域名/字节数）。
 */

const crypto = require('crypto');
const { writebackSessionCookies, fingerprintFile } = require('./cookie-writeback');

const QC_HOST = 'qianchuan.jinritemai.com';
/** 受支持的千川首页/管理路径（严格前缀 + 边界，pathname 不含 query/hash）。 */
const QC_SUPPORTED_PATH_RE = /^\/(?:home|uni-prom|overall-prom|promotion-v2|brand_bid)(?:\/|$)/;
/** 登录/授权中转特征（与 qianchuan-reader 的登录负判据同口径）。 */
const QC_LOGIN_PATH_RE = /\/login|\/passport|\/signin|sso\.jinritemai/i;

/**
 * 严格可信来源 + 受支持路径判定（URL 解析，绝不子串匹配）。
 * origin 精确全等：默认 443（显式 :443 会被 URL 规范化掉）通过；任何其他端口（如 :444）拒绝。
 */
function isVerifiedQianchuanUrl(u) {
  if (typeof u !== 'string' || u.length === 0) return false;
  let p;
  try { p = new URL(u); } catch (_) { return false; }
  if (p.origin !== `https://${QC_HOST}`) return false;
  if (QC_LOGIN_PATH_RE.test(p.pathname)) return false;
  return QC_SUPPORTED_PATH_RE.test(p.pathname);
}

/**
 * 千川头部身份探针（自包含：会被序列化进真实页面 evaluate 执行，不能引用闭包；
 * 同时导出供本地 DOM fixture 测试直接调用）。
 * 只认可见 [class*="shop-name"] 元素；候选必须恰好 1 个，多候选/缺失 → unique=false。
 * 可见性判定 fail-closed：getBoundingClientRect 抛错 → 不可见（绝不允许 catch=>true）；
 * 存在 getComputedStyle 时进一步排除 display:none / visibility:hidden。
 * 同地址上出现可见登录表单/控件（input 手机号/账号/验证码/密码、或文本恰为"登录"的按钮）
 * → loginVisible=true 显式负证据：过期残留的头部身份不算当前登录证据。
 */
function probeQianchuanHeaderIdentityInPage() {
  const out = { accountId: null, accountName: null, candidates: 0, unique: false, loginVisible: false };
  const doc = (typeof document !== 'undefined' && document) ? document : null;
  if (!doc || typeof doc.querySelectorAll !== 'function') return out;
  const visible = (el) => {
    let r;
    try { r = el.getBoundingClientRect(); } catch (_) { return false; }
    if (!r || !(r.width > 0 && r.height > 0)) return false;
    if (typeof getComputedStyle === 'function') {
      let cs;
      try { cs = getComputedStyle(el); } catch (_) { cs = null; }
      if (cs) {
        if (String(cs.display || '').toLowerCase() === 'none') return false;
        if (String(cs.visibility || '').toLowerCase() === 'hidden') return false;
      }
    }
    return true;
  };
  // 显式登录负证据：同一地址上可见的已知登录控件/表单
  try {
    const loginEls = doc.querySelectorAll(
      'input[placeholder*="手机"], input[placeholder*="账号"], input[placeholder*="验证码"],'
      + ' input[type="password"], button, [class*="login"]'
    );
    for (let i = 0; i < loginEls.length; i += 1) {
      const el = loginEls[i];
      if (!visible(el)) continue;
      const tag = String((el.tagName || '')).toLowerCase();
      const t = String((el.textContent || '')).replace(/\s+/g, '').trim();
      if (tag === 'input' || /^登\s*录$/.test(t)) { out.loginVisible = true; break; }
    }
  } catch (_) { /* 登录负证据探测失败不构成放行依据，仅不置位 */ }
  const els = doc.querySelectorAll('[class*="shop-name"]');
  const ids = [];
  for (let i = 0; i < els.length; i += 1) {
    const el = els[i];
    if (!visible(el)) continue;
    const t = String((el.textContent || '')).replace(/\s+/g, ' ').trim();
    const m = /ID[:：]\s*(\d{8,20})/.exec(t);
    if (m) {
      ids.push(m[1]);
      out.candidates += 1;
      const nm = /^(.+?)\s*ID[:：]/.exec(t);
      if (nm && !out.accountName) out.accountName = nm[1].trim();
      continue;
    }
    if (t && !/^ID/.test(t) && !out.accountName) out.accountName = t;
  }
  if (ids.length === 1 && out.candidates === 1) {
    out.accountId = ids[0];
    out.unique = true;
  }
  return out;
}

/**
 * 纯判定：当前事实（地址 + 头部身份观测）是否构成"新鲜的、同预期账户的千川正证据"。
 * 返回 {ok:true} 或 {ok:false, skipped:true, reason}（reason 不含任何 Cookie 值）。
 */
function decideQianchuanCheckpoint({ url, expectedAccountId, observed }) {
  const expected = String((expectedAccountId == null ? '' : expectedAccountId)).trim();
  if (!expected) {
    return { ok: false, skipped: true, reason: '配置未提供千川账户ID：按约定跳过会话检查点（不要求新增配置，运行期身份发现链路不变）' };
  }
  if (!isVerifiedQianchuanUrl(url)) {
    return { ok: false, skipped: true, reason: `当前地址不是可信千川受支持首页/管理路径（严格 origin+path 解析）: ${String(url).slice(0, 120)}` };
  }
  if (!observed || typeof observed !== 'object' || observed.unique !== true || !observed.accountId) {
    return { ok: false, skipped: true, reason: '千川头部账户身份缺失或候选不唯一：跳过会话检查点（不做正文兜底）' };
  }
  if (observed.loginVisible === true) {
    return { ok: false, skipped: true, reason: '当前页面存在可见登录表单/控件（同地址下过期残留的头部不算当前登录证据）：跳过会话检查点' };
  }
  if (String(observed.accountId) !== expected) {
    return { ok: false, skipped: true, reason: '千川页面头部账户与配置账户不一致（可能为其他/foreign 账户）：跳过会话检查点' };
  }
  return { ok: true };
}

/**
 * 会话 Cookie 检查点：在"当前时刻"正证据成立时，把本会话（context 内）刷新后的
 * Cookie 经既有授权写入器持久化到本次实际加载的精确文件；成功且落盘与自有 owned
 * 序列化逐字节一致时推进会话起始指纹。任何跳过/失败都只如实返回，绝不抛出业务语义。
 *
 * @param {object} p
 * @param {object} p.context        本次会话的 BrowserContext（须支持 cookies()；不支持则跳过）
 * @param {object} p.cookieSession  openQianchuanHome 返回的会话元信息（filePath/startFingerprint）
 * @param {object} p.target         当前千川页面（用于读取地址与头部身份）
 * @param {object} p.shopCfg        店铺配置（accountId 已知才可能保存；shopId 仅日志归属）
 * @param {(e:object)=>void} [p.audit] 审计回调（透传写入器，内容不含 Cookie 值）
 * @returns {Promise<{saved:boolean, skipped?:boolean, fingerprintAdvanced?:boolean,
 *                    reason?:string|null, count?:number, bytes?:number}>}
 */
async function checkpointQianchuanSessionCookies(p) {
  const { context, cookieSession, target, shopCfg } = p || {};
  const audit = (p && typeof p.audit === 'function') ? p.audit : () => {};
  const skip = (reason) => ({ saved: false, skipped: true, reason });

  if (!cookieSession || typeof cookieSession.filePath !== 'string' || !cookieSession.startFingerprint) {
    return skip('缺少会话 Cookie 元信息（路径/起始指纹）：跳过会话检查点');
  }
  if (!context || typeof context.cookies !== 'function') {
    return skip('context 不具备 cookies 能力（离线/注入会话）：跳过会话检查点');
  }

  let url = '';
  try { url = String(target.url()); } catch (_) { return skip('当前页面地址不可读：跳过会话检查点'); }
  let observed = null;
  try { observed = await target.evaluate(probeQianchuanHeaderIdentityInPage); } catch (_) { observed = null; }
  const decision = decideQianchuanCheckpoint({ url, expectedAccountId: shopCfg && shopCfg.accountId, observed });
  if (!decision.ok) return { saved: false, skipped: true, reason: decision.reason };

  // ── 单一 Cookie 读取 + 取回后新鲜复验（消除 TOCTOU 与双重快照）────────────
  // 写入器拿到的是只代理 cookies 的 ownedContext：其中一次真实 context.cookies() 取回后，
  // 立即用"当前 URL + 可见头部身份"复验（探针之后再次采样 URL 以捕捉 evaluate 期间的导航），
  // 任何漂移 → 抛错，由写入器的 catch 捕获为跳过（saved=false，文件字节不变）。
  // 期望序列化哈希从**写入器实际拿到的同一个数组**计算，绝不做另一次更早的读取。
  let ownedArray = null;
  const ownedContext = new Proxy(context, {
    get(target, prop) {
      if (prop === 'cookies') {
        return async function ownedCookiesOnce() {
          const arr = await target.cookies();
          if (!Array.isArray(arr) || arr.length === 0) {
            throw new Error('本次会话 Cookie 为空（登录态可疑）：取消会话检查点');
          }
          let urlNow = '';
          try { urlNow = String((p && p.target) ? p.target.url() : ''); } catch (e) {
            throw new Error(`Cookie 取回后复验页面地址不可读：${e.message}`);
          }
          let obsNow = null;
          try { obsNow = await p.target.evaluate(probeQianchuanHeaderIdentityInPage); } catch (_) { obsNow = null; }
          let urlAfterProbe = '';
          try { urlAfterProbe = String(p.target.url()); } catch (_) { urlAfterProbe = ''; }
          const re = decideQianchuanCheckpoint({
            url: urlNow,
            expectedAccountId: shopCfg && shopCfg.accountId,
            observed: obsNow,
          });
          if (!re.ok) throw new Error(`Cookie 取回后当前事实复验失败（${re.reason}）`);
          if (urlAfterProbe !== urlNow || !isVerifiedQianchuanUrl(urlAfterProbe)) {
            throw new Error('复验期间页面发生导航：取消会话检查点');
          }
          ownedArray = arr;
          return arr;
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });

  const res = await writebackSessionCookies({
    context: ownedContext,
    cookieFilePath: cookieSession.filePath,
    sessionStartFingerprint: cookieSession.startFingerprint,
    identityOk: true, // decideQianchuanCheckpoint 已给出当前新鲜的同账户正证据（含复验）
    loginOk: true,    // 严格可信千川管理页 + 唯一匹配账户 + 无可见登录表单 = 当前登录有效的正证据
    shopId: (shopCfg && shopCfg.id) || null,
    audit,
  });
  if (!res || res.ok !== true) {
    return { saved: false, skipped: true, reason: (res && res.reason) || '会话 Cookie 回写未执行' };
  }

  // 指纹推进：仅当落盘文件与写入器实际写入的那份 owned 序列化逐字节一致才采用；
  // 否则保留原指纹（并发新登录/内容漂移方向上继续冲突保护，不采用任意"刚变化的文件"）。
  let expectedSha = null;
  if (ownedArray) {
    expectedSha = crypto.createHash('sha256')
      .update(JSON.stringify(ownedArray, null, 2)).digest('hex');
  }
  const fp = fingerprintFile(cookieSession.filePath);
  if (fp.exists === true && expectedSha !== null && fp.sha256 === expectedSha) {
    cookieSession.startFingerprint = fp;
    return { saved: true, skipped: false, fingerprintAdvanced: true, reason: null, count: res.count, bytes: res.bytes };
  }
  return {
    saved: true, skipped: false, fingerprintAdvanced: false,
    reason: '落盘内容与会话 owned Cookie 序列化不一致：不推进会话起始指纹（保留原指纹，后续回写继续受冲突保护）',
    count: res.count,
  };
}

module.exports = {
  isVerifiedQianchuanUrl,
  probeQianchuanHeaderIdentityInPage,
  decideQianchuanCheckpoint,
  checkpointQianchuanSessionCookies,
  QC_HOST,
};
