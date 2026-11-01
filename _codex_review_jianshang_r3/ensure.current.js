async function ensureQianchuanAccountView(target, shopCfg, opts = {}) {
  const timeoutMs = sanitizePositiveMs(opts.readinessTimeoutMs, DEFAULT_READINESS_TIMEOUT_MS);
  const intervalMs = sanitizePositiveMs(opts.readinessIntervalMs, DEFAULT_READINESS_INTERVAL_MS);
  const nowFn = opts.nowFn || (() => Date.now());
  const sleep = opts.sleep || (ms => target.waitForTimeout(ms));
  const deadline = nowFn() + timeoutMs;
  const maxAttempts = Math.min(MAX_READINESS_ATTEMPTS, Math.ceil(timeoutMs / intervalMs) + 1);
  const expectedName = String((shopCfg && (shopCfg.compassShopName || shopCfg.name)) || '').trim();
  let switched = false;
  let popupClosed = false;
  let blockedSwitchUrl = null;
  let reason = '千川视图内容未就绪或结构未识别：未取得账户数据';
  const fail = async message => {
    const evidence = await collectLoginExpiryEvidence(target);
    if (evidence.loginUrl || evidence.loginControlVisible || evidence.loginFormVisible || evidence.loginDialogVisible) {
      throw new AuthError('千川视图读取遇到登录页或登录控件：尚未取得账户数据');
    }
    throw new DataGuardError(message);
  };
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const before = target.url();
    if (!isQianchuanHomeUrl(before)) return fail('千川视图导航未停留在可信首页：未取得账户数据');
    if (blockedSwitchUrl !== null && before !== blockedSwitchUrl) {
      return fail('千川受阻切换再观察期间发生导航：停止后续点击');
    }
    let view;
    const closeTag = `qc-popup-${attempt}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      view = await target.evaluate(readQianchuanAccountViewInPage, { tag: closeTag });
    } catch (_) {
      return fail('千川视图 DOM 读取异常：未执行其他导航或按钮操作');
    }
    if (!view || view.href !== before || target.url() !== before) {
      return fail('千川视图探测期间发生导航：拒绝混用不同页面数据');
    }
    const shopView = view.shopView || view.switchPresent;
    const evidence = await collectLoginExpiryEvidence(target);
    if (evidence.loginUrl || evidence.loginControlVisible || evidence.loginFormVisible || evidence.loginDialogVisible) {
      throw new AuthError('千川视图读取遇到登录页或登录控件：尚未取得账户数据');
    }
    if (target.url() !== before) return fail('千川视图核验期间发生导航：未取得账户数据');
    const popup = view.popup || { present: false, safe: false, reason: 'none', closeTag: null };
    let closedThisRound = false;
    // 任何可见弹窗都必须先被证明是已证营销弹窗：未知/不唯一/结构不符/危险文本 → 立即零点击停止。
    // 已证弹窗的关闭不依赖店铺视图是否已渲染（实测浮窗可能先于店铺视图出现并遮挡切换按钮）。
    if (popup.present) {
      if (popupClosed) {
        return fail('千川营销弹窗关闭后仍存在：停止后续点击，未点击业务按钮');
      }
      // 只接受本次尝试生成的标记（页面不得自造标记，避免选择器注入/旧标记残留）。
      if (popup.safe !== true || popup.closeTag !== closeTag) {
        return fail(`千川营销弹窗未通过安全判定（${String(popup.reason || 'unknown')}）：停止后续点击，未点击业务按钮`);
      }
      // POPUP-ATOMIC-CLOSE-20261031：关闭不再用「按标记选择器二次定位 + click」——
      // 那一步会重新解析选择器，节点被 React 复用/标记被搬走时仍可能落到业务按钮。
      // 改为在同一次页面执行内重新校验完整契约并立即点击：校验不通过 → 零点击。
      let closed;
      try {
        closed = await target.evaluate(readQianchuanAccountViewInPage, { tag: closeTag, click: true });
      } catch (_) {
        return fail('千川营销弹窗关闭执行异常：未执行关闭，未尝试其他按钮');
      }
      if (target.url() !== before) return fail('千川弹窗关闭期间发生导航：未执行视图切换');
      // POPUP-CLOSE-RESULT-20261031：evaluate 空值/畸形必须 fail-closed，绝不当「自行消失」。
      if (!closed || typeof closed !== 'object' || !closed.popup || typeof closed.popup !== 'object') {
        return fail('千川营销弹窗关闭结果异常：未执行关闭，未尝试其他按钮');
      }
      if (closed.popup.clicked === true) {
        popupClosed = true;
        closedThisRound = true;
        reason = '千川营销弹窗已关闭但店铺视图未恢复：未取得账户数据';
      } else if (closed.popup.present === false) {
        // 仅在结果结构完整且未点击时，才允许「自行消失」软路径。
        closedThisRound = true;
        reason = '千川营销弹窗已自行消失：本轮未执行视图切换';
      } else {
        return fail(`千川营销弹窗关闭未执行（${String(closed.popup.reason || 'unknown')}）：未点击业务按钮`);
      }
    }
    // 遮挡再观察：唯一已证安全营销弹窗可在店铺视图/切换按钮被浮层遮住（不可见）时
    // 关闭；或浮层已消失且店铺视图+切换按钮恢复。二者皆无 → fail-closed。
    if (blockedSwitchUrl !== null && !switched) {
      const shopRestored = view.shopView && view.switchPresent;
      // 刚关闭已证弹窗的那一轮允许继续等页面重渲染（只读观察，零点击，受尝试次数约束）。
      if (!shopRestored && !closedThisRound && !popupClosed) {
        return fail('千川受阻切换未取得同页店铺视图及唯一已证营销弹窗的新鲜证据：停止后续点击');
      }
    }
    // POPUP-EXPECTED-NAME-20261031：账户内容早退前也必须有目标店名；空名一律 fail-closed。
    if (!closedThisRound && !shopView && view.accountContent === true) {
      if (!expectedName) {
        return fail('千川店铺视图缺少目标店铺名：停止读取，不选择其他账户');
      }
      return { switched };
    }
    if (!closedThisRound && shopView) {
      if (!expectedName) {
        return fail('千川店铺视图缺少目标店铺名：停止读取，不选择其他账户');
      }
      let identityOk;
      try {
        const title = target.getByText(`店铺视图：${expectedName}`, { exact: true });
        identityOk = await title.count() === 1 && await title.isVisible();
      } catch (_) {
        return fail('千川店铺视图身份读取异常：停止读取，不选择其他账户');
      }
      if (!identityOk) return fail('千川店铺视图身份与目标店铺不一致或不唯一：停止读取，不选择其他账户');
    }
    if (!closedThisRound && shopView && !switched) {
      reason = '千川店铺视图未找到唯一的“切至账户视图”按钮：未执行切换';
      const button = target.getByRole('button', { name: '切至账户视图', exact: true, includeHidden: true });
      let count;
      try { count = await button.count(); } catch (_) {
        return fail('千川“切至账户视图”按钮定位失败：未执行切换');
      }
      if (count > 1) return fail('千川“切至账户视图”按钮重名：无法唯一定位，未执行切换');
      if (count === 1) {
        if (target.url() !== before) return fail('千川切换前发生导航：未执行切换');
        if (view.popup.present) {
          return fail('千川营销弹窗关闭后仍存在：停止后续点击，未点击业务按钮');
        }
        try {
          // 不强制点击；Playwright 的可见、启用和命中测试保护被遮挡的按钮。
          await button.click({ timeout: Math.min(timeoutMs, 10000) });
          switched = true;
          reason = '千川切换后账户视图内容未就绪或结构未识别：未读取店铺汇总，未取得账户数据';
        } catch (error) {
          if (popupClosed || blockedSwitchUrl !== null || !error || error.name !== 'TimeoutError'
            || !/intercepts pointer events/i.test(String(error.message)) || target.url() !== before) {
            return fail('千川“切至账户视图”按钮不可操作或切换导航失败：未尝试其他按钮');
          }
          blockedSwitchUrl = before;
          reason = '千川视图切换被遮挡：未在有界再观察内确认并关闭唯一已证营销弹窗';
        }
      }
    }
    if (attempt + 1 >= maxAttempts || !(nowFn() + intervalMs <= deadline)) break;
    await sleep(intervalMs);
  }
  return fail(reason);
}

/**
 * Cookie → 抖店首页 → 登录检查 → 点"巨量千川" → 千川落地页。
 * 任意初始化失败都会关闭本次创建的浏览器后抛错；成功返回后由调用者负责释放。
 */