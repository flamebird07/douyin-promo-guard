function readQianchuanAccountViewInPage(arg) {
  const tag = arg && typeof arg.tag === 'string' ? arg.tag : '';
  const wantClick = !!(arg && arg.click === true);
  const visible = el => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
  };
  const textOf = el => String((el && el.textContent) || '').trim();
  const classHas = (el, name) => !!(el && el.classList && typeof el.classList.contains === 'function' && el.classList.contains(name));
  const insideForm = el => {
    let cur = el && el.parentElement;
    while (cur) {
      if (String(cur.tagName || '').toUpperCase() === 'FORM') return true;
      cur = cur.parentElement;
    }
    return false;
  };
  const shopView = /店铺视图[：:]/.test(document.body ? document.body.innerText : '');
  const switchPresent = [...document.querySelectorAll('button')]
    .some(el => textOf(el) === '切至账户视图');
  const accountContent = [...document.querySelectorAll('[class*="summaryCard"]')]
    .some(el => visible(el) && (el.textContent || '').includes('账户整体消耗'));
  const popup = { present: false, safe: false, reason: 'none', closeTag: null, clicked: false };
  // 只在完整契约校验通过后赋值；点击阶段只认这个已校验节点。
  let verifiedClose = null;
  // 弹窗识别必须独立于 shopView / switchPresent：遮挡再观察时，浮层下的店铺视图
  // 文案与切换按钮可能不可见，唯一结构匹配的安全营销弹窗仍须能被识别与关闭。
  {
    const closes = [...document.querySelectorAll('button.close-button')];
    const visibleCloses = closes.filter(visible);
    const dialogs = [...document.querySelectorAll('[role="dialog"], dialog, [aria-modal="true"]')].filter(visible);
    // POPUP-PRESENT-ROOT-20261031：关闭钮/dialog 消失但已知根或遮罩仍在时不得判 present=false。
    let knownRootOrMaskVisible = false;
    {
      const walk = (el) => {
        if (!el || knownRootOrMaskVisible) return;
        if (visible(el) && classHas(el, 'overall-release-modal-v2-wrap')) {
          knownRootOrMaskVisible = true;
          return;
        }
        if (visible(el) && classHas(el, 'mask')) {
          let cur = el.parentElement;
          while (cur) {
            if (classHas(cur, 'overall-release-modal-v2-wrap')) {
              knownRootOrMaskVisible = true;
              return;
            }
            cur = cur.parentElement;
          }
        }
        const kids = el.children ? [...el.children] : [];
        for (const c of kids) walk(c);
      };
      if (document.body) walk(document.body);
    }
    popup.present = visibleCloses.length > 0 || dialogs.length > 0 || knownRootOrMaskVisible;
    const block = reason => { popup.safe = false; popup.reason = reason; };
    if (popup.present) {
      if (closes.length !== 1) {
        block('close-not-unique');
      } else if (visibleCloses.length !== 1) {
        block('close-not-visible-unique');
      } else {
        const close = closes[0];
        const content = close.parentElement;
        if (!content || !classHas(content, 'content') || !visible(content)) {
          block('content-not-verified');
        } else if (String(close.getAttribute('type') || '') !== 'button') {
          // Must require explicit type=button (align chengfang v2).
          block('close-type');
        } else if (insideForm(close)) {
          block('close-inside-form');
        } else {
          // Known root: ancestor must include overall-release-modal-v2-wrap.
          let knownRoot = false;
          {
            let cur = close;
            while (cur) {
              if (classHas(cur, 'overall-release-modal-v2-wrap')) { knownRoot = true; break; }
              cur = cur.parentElement;
            }
          }
          const closeLabel = String(close.getAttribute('aria-label') || '').trim();
          // aria-label must be exactly CLOSE; empty never safe.
          const ariaOk = closeLabel === '关闭';
          let iconOk = false;
          try {
            const icons = close.querySelectorAll
              ? Array.prototype.slice.call(close.querySelectorAll('iconpark-icon'))
              : [];
            iconOk = icons.some(el => String(el.getAttribute('name') || '') === 'oc-icon-close');
          } catch (_) { iconOk = false; }
          if (!knownRoot) {
            block('root-not-known');
          } else if (!ariaOk) {
            block('close-aria');
          } else if (!iconOk) {
            block('close-icon');
          } else {
            const controls = [...content.querySelectorAll('button, [role="button"], a[href], input, select, textarea')];
            const business = controls.filter(el => el !== close && el.tagName === 'BUTTON');
            const links = controls.filter(el => el.tagName === 'A' && el.hasAttribute('href'));
            const others = controls.filter(el => el !== close && el.tagName !== 'BUTTON' && !(el.tagName === 'A' && el.hasAttribute('href')));
            if (others.length > 0) {
              block('unexpected-controls');
            } else if (business.length !== 2) {
              block('business-count');
            } else if (!business.every(visible)) {
              block('business-hidden');
            } else if (links.length > 1) {
              block('too-many-links');
            } else if (business.filter(el => textOf(el) === '投放乘方').length !== 1) {
              block('business-label');
            } else if (business.filter(el => textOf(el) === '开启货款直投').length !== 1) {
              block('business-label');
            } else if (dialogs.length > 0 && dialogs.some(dialog => !dialog.contains(close))) {
              block('dialog-not-owning-close');
            } else {
              let text = String(content.textContent || '');
              for (const c of controls) {
                const tt = String((c && c.textContent) || '');
                if (tt) text = text.split(tt).join('');
              }
              if (/删除|暂停|终止|确认|确定|提交|不可恢复|永久/.test(text)) {
                block('danger-text');
              } else if (!tag) {
                block('close-tag-missing');
              } else if (wantClick && close.getAttribute('data-qc-popup-close') !== tag) {
                block('close-tag-mismatch');
              } else {
                try {
                  close.setAttribute('data-qc-popup-close', tag);
                  popup.safe = true;
                  popup.reason = 'known-marketing-popup';
                  popup.closeTag = tag;
                  verifiedClose = close;
                } catch (_) {
                  block('close-tag-failed');

                }
              }
            }
          }
        }
      }
    }
  }
  // POPUP-ATOMIC-CLOSE-20261031：判定与点击在同一次同步页面执行内完成。
  // 上面所有结构/文本/标记校验都在本函数内先行返回；到这里页面脚本不可能再插入，
  // 因此不存在「判定时是营销弹窗、点击时已被替换」的窗口。点击后立即移除标记。
  if (wantClick && popup.safe === true && verifiedClose) {
    try {
      verifiedClose.click();
      popup.clicked = true;
    } catch (_) {
      popup.clicked = false;
      popup.safe = false;
      popup.reason = 'close-click-threw';
    }
    try { verifiedClose.removeAttribute('data-qc-popup-close'); } catch (_) { /* 清理失败不影响结论 */ }
  }
  return { href: location.href, shopView, switchPresent, accountContent, popup };
}

