# 3443 推广值守演练接入

这里保存电商助手接入模块的发布快照，不包含电商助手其他业务代码。

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
<button class="tab-btn" onclick="switchTab('watchdrill', this)">推广值守演练</button>
```

6. 将 `watch-drill-tab.html` 放入现有页面标签内容区域，复用其样式和 `switchTab`。
7. 隔离验证后择机重新启动电商助手服务。服务启动默认不启动值守，由用户点击按钮启动。

本模块强制只读，任何配置组合下都不操作广告。仓库快照包含单一活跃读取守护修复；上传仓库不代表现有 3443 进程已重新加载补丁。

Cookie、真实配置、运行日志及页面证据需在本机单独保管，不随仓库发布。
