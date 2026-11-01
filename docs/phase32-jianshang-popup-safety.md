# 阶段报告：简尚（简尚衣橱优品店）千川营销弹窗安全收紧

- 范围：`src/adapters/qianchuan-reader.js` 的 `ensureQianchuanAccountView` 及其弹窗判定
- 本轮**未提交、未推送**；未打开真实广告页；未执行任何 enable/pause/switch/delete；未改生产配置
- 基线问题：Codex 复核 FAIL —— 弹窗「安全」判定在测试里被直接 stub 成 `safe:true`，
  真实页面内谓词未被验证；判定与点击之间存在可被替换节点的时序空隙；账户视图/店铺视图
  尚未渲染时弹窗被忽略（简尚实测浮窗先于店铺视图出现，导致空等超时）。

## 1. 判定与点击绑定同一次 DOM 快照

- 新增具名页面内函数 `readQianchuanAccountViewInPage(arg)`（`page.evaluate` 序列化执行，
  仅依赖 `document/location/getComputedStyle`），在**同一次快照**内完成视图读取与弹窗判定。
- 判定通过时给**唯一关闭按钮**打本次尝试专用标记 `data-qc-popup-close=<nonce>`
  （nonce 由 Node 侧生成，形如 `qc-popup-<attempt>-<rand>`）。
- **关闭动作（复核收尾后）**：`arg.click === true` 再走一次同一函数，在**同一次同步页面执行内**
  重新校验完整契约 + 标记仍严格等于本次 nonce，然后立刻 `close.click()`，点击后移除标记。
  - 判定与点击之间不存在可插入的页面脚本（浏览器单线程），React 复用节点/搬移标记都不能让
    点击落到业务按钮；
  - 标记丢失（重渲染）→ `close-tag-mismatch` → 零点击；
  - 任一结构/文本条件在点击快照内变化 → 对应固定 token → 零点击；
  - 绝不退回 `.content > button.close-button` 这类「结构像就点」的选择器。

## 2. 已证安全弹窗契约（收紧项）

任一不满足 → `safe=false`，调用方零点击停止（`reason` 为固定 token，不含页面文本）：

| 条件 | 收紧点 |
| --- | --- |
| 全文档 `button.close-button` 恰好 1 个且可见 | 隐藏副本/多副本一律拒绝 |
| 直接父元素是可见 `.content` | 不变 |
| 关闭按钮不在 `form` 内、`type` 非 submit/reset | 新增 |
| 关闭按钮可识别：文本 `x/X/×` 或 `aria-label=关闭/close`，且不能两者皆空 | 修复旧版「空文本 + 空 aria 也算关闭」 |
| `.content` 内除关闭按钮外仅 2 个可见业务按钮（精确文本 `投放乘方` / `开启货款直投`）+ 至多 1 个 `a[href]` | 显式拒绝 `input/select/textarea/[role=button]/额外按钮` |
| 所有可见对话框都包含该关闭按钮 | 不变 |
| 弹窗文本（剔除控件自身文本）不得含 `删除/暂停/终止/确认/确定/提交/不可恢复/永久` | 新增内容判定（CSS 结构不能代替内容） |

## 3. 处理时机收紧

- 任何可见弹窗**先于**店铺视图/账户视图判断处理：
  - 未通过安全判定 → 立即 `DataGuardError`（零点击）；
  - 已证弹窗 → 关闭后本轮不再切换，下一轮重新只读观察；
  - 已关闭过但同轮仍出现 → 立即失败，不二次关闭。
- 账户视图（`accountContent`）不再在弹窗未处理时直接返回成功。
- 受阻切换后的再观察：刚关闭弹窗的那一轮允许继续等页面重渲染（只读、零点击、受尝试次数约束），
  不再因「关闭后下一帧店铺视图尚未出现」立即失败。

## 4. 测试

`test/qianchuan-reader.test.js` 新增 16 项（原有弹窗用例的失败断言同步改为「安全判定」口径）：

- **真实谓词（VM 执行生产源码，非重写副本）** 6 项：已证结构（有/无链接）、业务确认框、
  多/隐藏/无标识关闭按钮、危险文本、额外控件、表单内关闭、第三个业务按钮、
  外部对话框不含关闭按钮、缺本次标记。
- **原子关闭（VM 同一源码，`click:true`）** 4 项：正常关闭一次并移除标记；
  节点被复用改写为业务按钮（标记仍在）→ 零点击；标记在两次快照间丢失 → 零点击；
  点击快照内多出第三个业务按钮 → 零点击。
- **接线** 6 项：简尚浮窗先于店铺视图出现→关闭后继续；账户视图未知弹窗→失败；
  关闭快照复核不通过→零点击且不退回结构选择器；缺标记→零点击；关闭后仍存在→不二次关闭；
  关闭快照发现弹窗自行消失→本轮零点击、下一轮重新观察后继续。

## 5. 未验证 / 环境限制

- 本环境 `Bash` / `PowerShell` 执行权限被拒（非交互模式无审批），**本轮未实际运行 `npm test`**；
  上述测试为静态新增，需在有执行权限的环境复跑 `node --test test/qianchuan-reader.test.js`。
- 未在真实千川页面上验证标记属性是否会被 React 重渲染移除；若被移除，行为为 fail-closed
  （`close-tag-mismatch` → 零点击停止），不会误点。
- 原子关闭使用页面内 `element.click()`（与 `handleChengfangOverlayInPage` 同口径），
  不做 Playwright 命中测试；若真实关闭控件依赖 `pointerdown` 而非 `click`，表现为
  「点击后弹窗仍在」→ 下一轮 `关闭后仍存在` 失败，仍不误点业务按钮。

## 6. 复核收尾（Codex 阻断项，2026-10-31）

**阻断项**：上一版的 nonce 只绑定「同一节点」，未绑定「同一语义」；点击仍走
`locator('button[data-qc-popup-close=…]').count()` + `.click()`，选择器在点击时**重新解析**。
React 复用同一 DOM 节点（保留未知属性）时，标记会留在被改写为「开启货款直投/投放乘方」的
节点上 → `count()===1` 通过 → 点击业务按钮。

**收尾**：

1. 关闭改为 `page.evaluate(readQianchuanAccountViewInPage, { tag, click: true })`，
   在同一同步执行内：完整契约复核 → 标记严格等于本次 nonce → `close.click()` → 移除标记。
   浏览器单线程保证判定与点击之间无脚本可插入，与已复核的
   `handleChengfangOverlayInPage` 同口径。
2. Node 侧删除 `locator(...).count()/click()`，改判页面回传的 `popup.clicked === true`；
   其余返回（`close-tag-mismatch` / `business-count` / `danger-text` …）一律零点击失败。
3. 两次快照之间弹窗自行消失（`popup.present === false`）→ 本轮不点任何按钮、不做视图切换，
   下一轮重新只读观察（避免把「自己消失」误判成「关闭失败」而中止）。
4. 本收尾**未提交、未推送**；未打开真实广告页；未执行 enable/pause/switch。
