/**
 * Content script — 监听 SPA 路由变化，发送 page context 给 background。
 * 严格只读 URL，不注入到页面 DOM，不读 Cookie。
 */

import { detectFromUrl, type PageContext } from './detect';

let last: PageContext | null = null;
function emit(ctx: PageContext | null): void {
  if (!ctx && !last) return;
  if (ctx && last && ctx.type === last.type && ctx.id === last.id) return;
  last = ctx;
  try {
    chrome.runtime?.sendMessage({ type: 'biliscope:page-context', ctx });
  } catch {
    /* ignore */
  }
}

function tick(): void {
  emit(detectFromUrl(location.href));
}

// SPA-friendly: hijack history.pushState / replaceState
(function patchHistory(): void {
  const origPush = history.pushState.bind(history);
  const origReplace = history.replaceState.bind(history);
  history.pushState = function (...args: Parameters<typeof origPush>) {
    const r = origPush(...args);
    setTimeout(tick, 0);
    return r;
  };
  history.replaceState = function (...args: Parameters<typeof origReplace>) {
    const r = origReplace(...args);
    setTimeout(tick, 0);
    return r;
  };
  window.addEventListener('popstate', () => setTimeout(tick, 0));
})();

tick();

// UI 提示：右下角小气泡，可关闭
const FLOATING_ID = 'biliscope-floating-btn';
function ensureFloatingButton(ctx: PageContext | null): void {
  let el = document.getElementById(FLOATING_ID);
  if (!ctx) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = FLOATING_ID;
    el.style.cssText = [
      'position:fixed',
      'right:16px',
      'bottom:16px',
      'z-index:2147483647',
      'background:#1f2937',
      'color:#fff',
      'padding:8px 12px',
      'border-radius:6px',
      'box-shadow:0 4px 12px rgba(0,0,0,.25)',
      'font:12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif',
      'cursor:pointer',
      'user-select:none',
    ].join(';');
    el.title = 'BiliScope';
    el.addEventListener('click', () => {
      chrome.runtime?.sendMessage({ type: 'biliscope:open-popup' });
    });
    document.body.appendChild(el);
  }
  el.textContent = `BiliScope · ${ctx.type === 'creator' ? '账号' : ctx.type === 'video' ? '视频' : '搜索'}`;
}

const origEmit = emit;
(function bindEmit(): void {
// 通过 monkey-patch emit
// @ts-expect-error - reassigning module-scope binding inside IIFE
emit = (c: PageContext | null): void => {
  origEmit(c);
  ensureFloatingButton(c);
};
})();

// Re-emit on load complete
if (document.readyState === 'complete') {
  emit(detectFromUrl(location.href));
} else {
  window.addEventListener('load', () => emit(detectFromUrl(location.href)));
}