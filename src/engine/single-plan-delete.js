'use strict';
const { candidateFingerprint } = require('./manual-cleanup');

// Transport contract for one measured platform deletion flow. It is deliberately
// separate from the monitor's never-delete controller and has no retry/batch API.
function createSinglePlanDelete({ controller, measuredUi }) {
  return async function performDelete({ candidate, signal, guard }) {
    if (!controller || measuredUi !== true) throw new Error('平台单条删除按钮及确认弹窗尚未实测，禁止真实提交');
    const check = () => { if (signal?.aborted) throw new Error('已取消'); guard(); };
    let session;
    try {
      check(); session = await controller.open({ accountId: candidate.accountId, signal });
      check();
      const actual = await controller.readCandidate(session, candidate);
      if (!actual || candidateFingerprint(actual) !== candidate.fingerprint) throw new Error('执行页面的账号/计划/日期/整体指标与人工确认不一致');
      check(); await controller.selectOnly(session, candidate.planId);
      const selected = await controller.readSelection(session);
      if (!selected || selected.count !== 1 || selected.ids?.length !== 1 || selected.ids[0] !== candidate.planId) throw new Error('平台未精确选中唯一目标，禁止删除');
      check();
      const dialog = await controller.openDeleteConfirmation(session, candidate.planId);
      if (!dialog || dialog.measured !== true || dialog.action !== 'delete' || dialog.count !== 1
        || dialog.accountId !== candidate.accountId || dialog.planId !== candidate.planId) throw new Error('未知/错账号/错计划/多条删除确认，禁止点击确定');
      check(); await controller.confirmOne(session, dialog);
      check(); const result = await controller.verifyDeleted(session, candidate.planId);
      return result?.identityVerified === true && result?.complete === true && result?.deletedPlanId === candidate.planId
        ? { confirmedDeleted: true, planId: candidate.planId, evidence: result }
        : { confirmedDeleted: false, planId: candidate.planId, reason: '未获得账号身份核验后的全量删除回读证据' };
    } finally { if (session) await controller.close(session); }
  };
}
module.exports = { createSinglePlanDelete };
