# 3443 推广值守接入

这里保存电商助手接入模块的发布快照，不包含电商助手其他业务代码。

## 业务规则（2026-09-15 起）

1. 每天 **07:00** 开启全部乘方计划（全店托管 + 商品自选，含昨日暂停的计划）；
2. **08:00 后每 30 分钟**检查：当天「账户整体消耗」÷ 当天「全店订单数」**严格超过** 1 元/单
   （整数分判定：费用分 > 订单数×100，恰好相等不暂停）时**暂停乘方**；
3. **绝不删除广告**（本系统不存在删除广告的代码路径）；
4. 界面日志必须包含：开启、判断数据、暂停、重试、回读、失败原因。

值守在 3443 进程内运行（复用推广控制项目的 `Monitor` 调度与乘方链路），刷新/切换/关闭页面
既不重复启动也不停止后台值守。

## 接入步骤

1. 将 `watch-drill.js` 放入电商助手 `bill-manager/`，测试文件放入其 `tests/`。
2. 配置环境变量 `PROMO_GUARD_DIR` 为本仓库的绝对路径（模块默认路径对应原机器）。测试文件中的项目路径也应按安装位置调整。
3. 在服务器初始化处加入：

```js
const { createWatchDrill } = require('./watch-drill');
const watchDrill = createWatchDrill({
  persistFile: require('path').join(__dirname, 'watch-drill-logs.jsonl'),
});
```

4. 在现有请求处理器中、通用静态路由前加入：

```js
if (req.url.startsWith('/api/watch-drill/')) {
  await watchDrill.serveHttp(req, res);
  return;
}
```

5. 在现有标签按钮组加入：

```html
<button class="tab-btn" onclick="switchTab('watchdrill', this)">推广值守</button>
```

6. 将 `watch-drill-tab.html` 放入现有页面标签内容区域，复用其样式和 `switchTab`。
7. 隔离验证后择机重新启动电商助手服务。服务启动默认不启动值守，由用户点击按钮启动。

## 安全边界与模式（fail-closed）

- 是否真实操作广告由**推广控制 `config.json`** 决定，本模块**不提供任何绕过门槛的入口**：
  `execution.realMode` + `monitor.chengfang.pauseEnabled` / `enableEnabled`，
  且 `execution.dryRun === true` 时**即使前三者全开也零点击**（演练优先拒绝真实动作）。
- 页面「实际门槛」栏**复用与执行器完全相同的许可判断**（含 dryRun），如实显示
  「真实暂停/开启 会执行 / 不会执行」；未知模式显示「待核实」，**不默认宣称演练安全**。
- 页面在**首次启动前**也会读取配置展示真实模式（读取配置不启动调度、浏览器或广告动作）。
- **开启类确认弹窗尚未实测** → 出现任何未知确认弹窗一律**阻断**，绝不盲点「确定」。
  `/api/watch-drill/logs` 的 `confirmDialogs` 字段如实暴露该保守标记。
- 日志安全：绝不记录 Cookie/令牌/敏感请求参数，统一 scrubbing，单行上限 2000 字符。

上传仓库不代表现有 3443 进程已重新加载补丁；需重启服务后新代码方生效。

Cookie、真实配置、运行日志及页面证据需在本机单独保管，不随仓库发布。
