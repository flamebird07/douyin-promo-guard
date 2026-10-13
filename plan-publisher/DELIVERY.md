# 计划发布（plan-publisher）交付说明

本目录为「每日自动发布推广计划」的共享发布子系统源码交付。请以**源码方式**交付；
**绝不**随包上传 `plan-publisher-state.json` / 锁文件 / `published-products.json` / 发布尝试账本
等任何运行期状态文件。

## 两条独立的运行路径（勿混淆）
- **手动 CLI（人工确认路径）**：人工运行 `启动计划发布.cmd`（或 `node run-plans.cjs`）。
  发布前在确认界面逐条**人工确认**（初次确认与最终确认）后才创建/发布。此路径永远需要
  人工在场，任何计划类型都不例外。
- **后台自动排程（持续预授权路径）**：由推广值守（bill-manager）后台排程在每店北京时间
  `planPublishing.time`（默认 `08:00`，Asia/Shanghai）自动派发。仅当 `enabled:true` **且**
  `autoConfirm:true`（用户已给出持续授权，允许系统自动完成初次/最终确认点击）时才派发。
  这是**预先授权**，不是运行中免确认：授权缺失或页面/配置漂移时立即停止并如实 blocked。
  无模型、无外部定时任务、无需页面保持打开。两条路径互不削弱。

## 关键常量与默认值
- 预算：每份 `dailyBudget` 默认 `300`（仅走 trusted business，不在此覆盖）。
- 目标 ROI：按店持久化，缺省默认 `15`（仅接受正有限数字；非法一律拒绝且零落盘）。
- 每店每日份数：全局 `planPublishing.plansPerShopPerDay` 限 `1..3`（默认 `3`）；每店
  `shops[].plansPerShopPerDay` 允许 `1..10`（缺省回落全局）。**只有成功才计入份数**。
- 「绑定 ≥1」的真实含义：指每个推广计划所推**商品至少绑定一个手动选定的抖音号**
  （发布页内的商品-抖音号绑定），**不是**指 `cookieFile` 或广告主账号数量要求。
- 后台排程对账户的要求：Cookie 源可用即可（anyCookie），**不要求**事先在配置里填写
  `accountId`；配置为 `accountId:null` 的店由运行时身份发现（publisher 生产 openShop +
  严格同店 Cookie 身份验证）自动取真实账户；身份未知或不符一律 fail-closed，
  绝不借用其他店的身份或账号。

## 安全语义（必须保持）
- 一律 fail-closed，但**不是**"任何失败都永久终止"：
  - `unknown`（发布结果未知）当日**阻塞该店**，直到真实只读回读给出证明才收口——
    回读证明已发布成功才回填 success；证明该份**从未进入任何消费**（publisher 耐久
    preparationClosureFacts 零消费证明）时，既有代码允许按证明释放该份并继续本日
    剩余份数的有界重试；二者都拿不到证明时保持 unknown、**不自动重放发布**。
  - `failed` / 永久失败 / 阻塞当日均不为成功；不自动重放；次日按新业务日期重新生成，需人工核对。
- 「每日开启」钩子、进程锁与「同店当日去重」保持既有语义（幂等 boot、并发去重），不得移除或放宽。
- 不依赖任何运行时模型；账号身份由既有 publisher provider/profile 动态发现，
  本交付的**文档与配置**不含店铺或账号数据（注：源码中不可变的 `wf.BUSINESS` 默认对象
  自带历史店铺名/账号 ID，属代码常量而非运行期状态；部署时应按自身配置覆盖）。
- 运行期状态文件（state / lock / published-products / attempts）**永不**进入交付或公开仓库。

## 路径与环境变量（跨仓）
- `PROMO_GUARD_DIR`：推广控制仓库根（提供 `src/*`、`src/engine/monitor.js` 等）。
- `PUBLISHER_DIR`：本发布子系统根。在**公开仓库**中的路径为
  **`<douyin-promo-guard>/plan-publisher`**；`core/plan-publisher` 仅是本隔离工作区内的
  临时目录名，不是公开仓库路径。
- 集成层（bill-manager）按上述环境变量解析两处根目录；缺失时如实 blocked，绝不 stub/throw 假冒发布。

## 本目录内容
- 源码：`run-plans.cjs`、`plan-workflow.cjs`、`direct-draft-controller.cjs`、
  `confirmation-ui.cjs`、`shop-profile.cjs`、`启动计划发布.cmd`。
- 说明：`README.md`（历史/只读，**不随本次上传**）、本 `DELIVERY.md`。
- 本说明与随包配置不含任何真实运行期状态；上述 `wf.BUSINESS` 代码默认值除外。
