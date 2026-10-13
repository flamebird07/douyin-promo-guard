'use strict';
// Simple LOCAL human-confirmation UI. The process itself holds a 127.0.0.1 HTTP
// server (no external service, no server restart needed). It DISPLAYS the frozen
// plan and only authorizes publication on an explicit human POST "确认发布本计划"
// that accepts the shown disclosures. GET/refresh, a repeated POST, a wrong
// nonce, another plan, an old date, or a drifted manifest all render/return a
// refusal and click nothing. There is NO unattended auto-confirm switch. Closing
// the window or interrupting the process preserves state; nothing auto-replays.
//
// The authorization decision reuses the REAL plan-workflow validator (never a
// second, looser copy). Requiring this module has no side effects.

const http = require('http');
const { validateConfirmation, FINAL_EXCLUSION_TEXT, BUSINESS, bizOf } = require('./plan-workflow.cjs');

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Pure render of the confirmation page for ONE frozen plan. The shop name, the
// daily cap and the per-plan product count are DISPLAY values taken from the
// HOST-TRUSTED business profile (opts.business), never from the frozen artifact
// or the HTTP request. A generic shop therefore renders its own identity while
// the frozen plan values below stay exactly as frozen. When no trusted profile is
// supplied the frozen legacy BUSINESS default is used, so the legacy entry keeps
// its prior rendering. Display is independent of authorization: the confirm
// decision still re-validates against the separately held trusted profile.
function renderPlanPage(frozen, opts) {
  const o = opts || {};
  const biz = bizOf(o.business);
  const targets = Array.isArray(biz.boundAccounts) && biz.boundAccounts.length
    ? biz.boundAccounts.map(String)
    : (frozen.boundAccounts || []).map(String);
  const targetLabel = targets.length > 1 ? targets.length + '种获批候选' : '单一获批候选';
  const targetHint = targets.length > 1
    ? '每件商品至少成功手动绑定其中一个即合格，全部成功亦合格'
    : '每件商品成功手动绑定该账号即合格';
  const d = frozen.disclosures || { migration: [], precheck: [], reviewFailed: [] };
  const products = (frozen.productIds || []).map((id, i) => `<li>${esc(i + 1)}. ${esc(id)}</li>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>计划发布人工确认 · 第 ${esc(frozen.planNumber)} 份</title>
<style>body{font-family:system-ui,"Microsoft YaHei",sans-serif;margin:24px;line-height:1.6;color:#222}
.card{border:1px solid #ddd;border-radius:8px;padding:16px;max-width:860px}
details{margin:8px 0}h1{font-size:20px}.warn{color:#a15c00}.stop{color:#b00020}
button{font-size:16px;padding:10px 18px}label{display:block;margin:6px 0}</style></head>
<body><div class="card">
<h1>请人工核对后确认发布（第 ${esc(frozen.planNumber)} 份 / 当天最多 ${esc(biz.maxPlansPerDay)} 份）</h1>
<p>店铺：<strong>${esc(biz.shop)}</strong>　千川账户：<strong>${esc(frozen.accountId)}</strong></p>
<p>计划名称：<strong>${esc(frozen.planName || '(未命名)')}</strong></p>
<p>业务日期（Asia/Shanghai）：<strong>${esc(frozen.businessDate)}</strong></p>
<p>综合营销ROI目标：<strong>${esc(frozen.roi)}</strong>　日预算：<strong>${esc(frozen.dailyBudget)}</strong> 元　含达人佣金出价：<strong>${frozen.commissionIncluded ? '是' : '否'}</strong>　货款直投：<strong>${frozen.directPay ? '是' : '否'}</strong></p>
<p>绑定目标账号（尝试绑定，${targetLabel}）：<strong>${esc(targets.join('、'))}</strong>；${targetHint}</p>
<p>商品数量：<strong>${esc((frozen.productIds || []).length)}</strong> / ${esc(biz.productsPerPlan)}</p>
<details><summary>展开 30 个商品 ID</summary><ol>${products}</ol></details>
<p class="warn">迁移提示（全店托管将停止投放该商品）：${d.migration && d.migration.length ? esc(d.migration.join('、')) : '无'}</p>
<p class="warn">系统前置检测（可能审核不通过，非硬拒绝）：${d.precheck && d.precheck.length ? esc(d.precheck.join('、')) : '无'}</p>
<p class="stop">已知最终互斥效果：${esc(FINAL_EXCLUSION_TEXT)}</p>
<form method="POST" action="/confirm">
<input type="hidden" name="nonce" value="${esc(frozen.nonce)}">
<input type="hidden" name="planNumber" value="${esc(frozen.planNumber)}">
<input type="hidden" name="businessDate" value="${esc(frozen.businessDate)}">
<input type="hidden" name="manifestHash" value="${esc(frozen.manifestHash)}">
<label><input type="checkbox" name="acceptedDisclosures" value="true"> 我已阅读并接受以上全部迁移提示、前置检测提醒与最终互斥效果</label>
<button type="submit" name="action" value="确认发布本计划">确认发布本计划</button>
</form>
<p>说明：刷新本页或重复提交不会再次发布；每一份计划都需要单独确认一次。</p>
</div></body></html>`;
}

function parseFormBody(raw) {
  const out = {};
  for (const pair of String(raw || '').split('&')) {
    if (!pair) continue;
    const i = pair.indexOf('=');
    const k = decodeURIComponent(i < 0 ? pair : pair.slice(0, i));
    const v = decodeURIComponent(i < 0 ? '' : pair.slice(i + 1).replace(/\+/g, ' '));
    out[k] = v;
  }
  return out;
}

// Pure confirm decision. Reuses the real validator; returns { authorized, reason,
// authorization?, statusCode, body }. A refusal never triggers onConfirm. The
// business profile MUST be supplied by the trusted host (opts.business); it is
// never derived from the frozen artifact or the HTTP body, so a generic plan can
// never self-authorize. Omitting it falls back to the frozen legacy BUSINESS.
function handleConfirmRequest(frozen, body, opts) {
  const o = opts || {};
  const req = {
    method: 'POST',
    action: body.action,
    nonce: body.nonce,
    planNumber: body.planNumber != null && body.planNumber !== '' ? Number(body.planNumber) : body.planNumber,
    businessDate: body.businessDate,
    manifestHash: body.manifestHash,
    acceptedDisclosures: body.acceptedDisclosures === 'true' || body.acceptedDisclosures === true,
  };
  const verdict = validateConfirmation(frozen, req, { consumed: o.consumed, nowMs: o.nowMs, business: o.business });
  if (!verdict.authorized) {
    return { authorized: false, reason: verdict.reason, statusCode: 409, body: `已拒绝：${verdict.reason}（未发布，未点击任何按钮）` };
  }
  return { authorized: true, reason: null, authorization: verdict.authorization, statusCode: 200, body: '已授权：正在按本份计划执行一次发布……' };
}

// Create the process-held confirmation server. DI so it is testable offline:
// inject createServer to capture the request handler without binding a port.
function createConfirmationServer(cfg) {
  const c = cfg || {};
  const host = c.host || '127.0.0.1';
  let server = null;
  let consumed = c.consumed instanceof Set ? c.consumed : new Set(c.consumed || []);
  let current = c.frozen || null;
  // The TRUSTED business profile that authorizes/displays the current plan. It is
  // supplied by the host via the constructor or setPlan(...,{business}) and NEVER
  // reconstructed from the frozen artifact or the HTTP form.
  let currentBusiness = c.business && typeof c.business === 'object' ? c.business : null;
  let onConfirm = c.onConfirm || null;

  const handler = (req, res) => {
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && (url === '/' || url === '/confirm')) {
      if (!current) { res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }); res.end('当前没有待确认的计划。'); return; }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(renderPlanPage(current, { business: currentBusiness })); return;
    }
    if (req.method === 'POST' && url === '/confirm') {
      let raw = '';
      req.on('data', ch => { raw += ch; if (raw.length > 1e6) req.destroy(); });
      req.on('end', () => {
        const body = parseFormBody(raw);
        const planAtStart = current;
        // Snapshot the trusted profile together with the plan at POST start so a
        // later setPlan (next shop) can never authorize this POST under a different
        // shop's identity.
        const businessAtStart = currentBusiness;
        const result = handleConfirmRequest(planAtStart, body, { consumed, nowMs: Date.now(), business: businessAtStart });
        if (result.authorized) {
          // Reserve synchronously in memory before yielding so concurrent/repeat
          // POSTs are rejected. Persist the reservation before waking the
          // publisher; a failed write never authorizes a browser click.
          consumed.add(planAtStart.confirmationId);
          Promise.resolve()
            .then(() => c.reserveConfirmation ? c.reserveConfirmation(result.authorization, planAtStart) : undefined)
            .then(() => onConfirm && onConfirm(result.authorization, planAtStart, body))
            .then(() => { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end(result.body); })
            .catch(async e => {
              try { if (typeof c.onError === 'function') await c.onError(e, planAtStart, body); } catch (_) { /* caller also keeps an in-memory stop signal */ }
              res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }); res.end('发布执行异常：' + (e && e.message));
            });
          return;
        }
        res.writeHead(result.statusCode, { 'content-type': 'text/plain; charset=utf-8' }); res.end(result.body);
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not-found');
  };

  return {
    setPlan(frozen, callback, opts) {
      if (current && consumed.has(current.confirmationId) && current.confirmationId !== (frozen && frozen.confirmationId)) {
        // Preserve all earlier consumed ids; swapping to the next plan is safe
        // only after the caller has already observed the previous result.
      }
      current = frozen;
      if (callback !== undefined) onConfirm = callback;
      // Rebind the trusted profile with the plan. Always reassign (never carry the
      // previous shop's profile forward): omitting opts.business clears any prior
      // profile so a generic plan cannot be authorized under a stale/self profile.
      const o = opts || {};
      currentBusiness = o.business && typeof o.business === 'object' ? o.business : null;
    },
    handler,
    start() {
      if (server && server.listening) return Promise.resolve(server.address());
      server = (c.createServer || http.createServer)(handler);
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(c.port || 0, host, () => { server.removeListener('error', reject); resolve(server.address()); });
      });
    },
    stop() { return new Promise(resolve => { if (server) server.close(() => resolve()); else resolve(); }); },
    get consumed() { return consumed; },
  };
}

module.exports = { esc, renderPlanPage, parseFormBody, handleConfirmRequest, createConfirmationServer };
