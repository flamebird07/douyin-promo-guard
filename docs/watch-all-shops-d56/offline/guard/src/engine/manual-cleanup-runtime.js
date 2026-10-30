'use strict';
const path = require('path');
const { createManualCleanup } = require('./manual-cleanup');
const { createSinglePlanDelete } = require('./single-plan-delete');
const { createCleanupReader } = require('../adapters/cleanup-reader');

// Real deletion UI has no measured receipt yet. Do not expose an HTTP/config
// switch that can claim it is measured. Future connection requires code review.
const DELETE_UI_MEASURED = false;
function createManualCleanupRuntime({ getConfig, dataDir, now, read, deletionController, measuredUi = DELETE_UI_MEASURED }) {
  // 多店生产配置用 deleted 软删除标记：软删除店铺不算启用店，不阻塞唯一启用店判定。
  const config = getConfig(), shops = (config.shops || []).filter(s => s.deleted !== true && s.enabled !== false);
  if (shops.length !== 1 || !shops[0].name || !shops[0].accountId) throw new Error('手动清理首版要求唯一启用店铺和明确账号ID');
  const shop = shops[0];
  return createManualCleanup({ account: shop.name, accountId: String(shop.accountId), now,
    ledgerDir: path.join(dataDir, 'manual-cleanup'), read: read || createCleanupReader({ getConfig }),
    performDelete: createSinglePlanDelete({ controller: deletionController, measuredUi }),
    getConfig: () => {
      const c = getConfig(), active = (c.shops || []).filter(s => s.deleted !== true && s.enabled !== false), cleanup = c.cleanup || {};
      const identity = active.length === 1 && active[0].name === shop.name && String(active[0].accountId) === String(shop.accountId);
      const enabled = identity && cleanup.manualDeleteEnabled === true && c.execution?.realMode === true
        && c.execution?.dryRun === false && measuredUi === true && !!deletionController;
      return { enabled,
        blockedReason: !identity ? '店铺配置已变更，请重新装配' : !measuredUi || !deletionController ? '平台单条删除按钮/确认弹窗/删除后全量回读尚未实测接通，真实提交已阻断'
          : cleanup.manualDeleteEnabled !== true ? '手动删除独立开关未启用' : 'realMode/dryRun总闸阻断' };
    } });
}
module.exports = { createManualCleanupRuntime, DELETE_UI_MEASURED };
