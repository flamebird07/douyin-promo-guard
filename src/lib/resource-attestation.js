'use strict';

/**
 * 资源"本次未创建"的所有权证明（2026-10-23 r13 缺口 1）。
 *
 * 为什么要单独一层：布尔属性 `err.chengfangResourceCreated === false` 任何人都能写，
 * 而 Monitor 拿它当"没有浏览器需要关闭"的放行依据。证明必须只能由**真实资源所有者**
 * （实际负责 launch/新建 context 的那个函数）在自己的失败路径上产出，因此登记在模块
 * 私有的 WeakMap 里：调用方持有的只是错误对象，拿不到登记表，也无法伪造归属。
 *
 * 边界：
 *  - 只有 OWNERS 里的所有者标识可登记（适配器与之一一对应，新增路径必须显式登记）；
 *  - 登记项随错误对象生命周期自然释放（WeakMap），不进日志/序列化；
 *  - 已登记句柄（真实创建过资源）一律以句柄为准，本模块不覆写既有事实。
 */

const OWNERS = Object.freeze({
  'qianchuan-home': 'openQianchuanHome：浏览器/上下文创建者',
  'chengfang-manual-review': 'openChengfangShop 保留窗口复用分支：不新开浏览器、不新建 context',
});

const REGISTRY = new WeakMap();
const SCOPES = new WeakMap();

/**
 * 资源所有者在自己的失败路径上登记"本次未创建任何需收口资源"。
 * @param {string} ownerId OWNERS 中的所有者标识
 * @param {Error|object} err 即将抛出的原始错误（不改写 message）
 */
function attestResourceNotCreated(ownerId, err) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return err;
  if (!Object.prototype.hasOwnProperty.call(OWNERS, ownerId)) return err;
  try {
    if (!REGISTRY.has(err)) REGISTRY.set(err, { ownerId, at: Date.now() });
  } catch (_) { /* 不可作 WeakMap 键：保持无证明（Monitor 保守阻断） */ }
  // 兼容既有可读字段（消费者不再采信裸属性，只作为人工排查线索）
  try {
    if (err.chengfangResourceCreated === undefined) err.chengfangResourceCreated = false;
  } catch (_) { /* 冻结错误对象：登记已足够 */ }
  return err;
}

/**
 * launcher 范围收据（2026-10-23 验收边界 1）：`browser===null` 这类**外层局部观测**不能充当
 * "未创建"证明——factory/launch 内部完全可能先创建资源再 reject，外层对此一无所知。
 * 因此证明只能由真正包住 launcher 调用的这个范围出具，且只在**从未进入 launcher** 时成立。
 *
 * 收据本身是普通对象，登记表在模块私有 WeakMap 里：外部拿不到状态，也造不出"未进入"的事实。
 */
function beginLauncherScope(ownerId) {
  const receipt = { launcherScope: true };
  if (Object.prototype.hasOwnProperty.call(OWNERS, ownerId)) {
    SCOPES.set(receipt, { ownerId, entered: false, producedHandle: false });
  }
  return receipt;
}

/** 资源所有者用它包裹真实的 factory/launch 调用：await 之前先落"已进入"事实。 */
async function runInLauncherScope(receipt, launchFn) {
  const st = SCOPES.get(receipt);
  if (!st) return await launchFn();
  st.entered = true;
  const handle = await launchFn();
  if (handle && (typeof handle === 'object' || typeof handle === 'function')) st.producedHandle = true;
  return handle;
}

/**
 * 由 launcher 范围出具证明：只有失败严格发生在进入 launcher **之前**（Cookie 解析、指纹读取等
 * 尚未触碰任何进程/浏览器的路径）才登记；一旦进入过 launcher，即便没拿到句柄也不出证明，
 * 消费者按 unknown 保守阻断。
 */
function attestFromLauncherScope(receipt, err) {
  const st = SCOPES.get(receipt);
  if (!st || st.entered) return err;
  return attestResourceNotCreated(st.ownerId, err);
}

/** 仅供测试与取证：范围是否已进入过 launcher（不暴露登记表）。 */
function launcherScopeEntered(receipt) {
  const st = SCOPES.get(receipt);
  return st ? st.entered === true : true;
}

/** 消费者核验：返回证明记录，非所有者产出（或裸属性伪造）一律 null。 */
function resourceNotCreatedProof(err, ownerId = null) {
  if (!err || (typeof err !== 'object' && typeof err !== 'function')) return null;
  const rec = REGISTRY.get(err);
  if (!rec) return null;
  if (ownerId !== null && rec.ownerId !== ownerId) return null;
  return rec;
}

/** 仅供测试与取证：确认某错误是否带证明（不返回登记内容）。 */
function hasResourceNotCreatedAttestation(err) {
  return resourceNotCreatedProof(err) !== null;
}

module.exports = {
  OWNERS,
  attestResourceNotCreated,
  beginLauncherScope,
  runInLauncherScope,
  attestFromLauncherScope,
  launcherScopeEntered,
  resourceNotCreatedProof,
  hasResourceNotCreatedAttestation,
};
