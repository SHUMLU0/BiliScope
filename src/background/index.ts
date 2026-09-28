/**
 * Background service worker (Manifest V3).
 * 接收 content 消息，可选：调度低频任务。
 * 暂不持有任何长期采集状态（避免影响 SW 生命周期）。
 */

import { logger } from '@utils/logger';

chrome.runtime?.onMessage.addListener((msg: { type?: string; ctx?: unknown }, _sender, sendResponse) => {
  switch (msg.type) {
    case 'biliscope:page-context':
      // 持久化最近一次 ctx，popup 可读
      chrome.storage?.local.set({ lastPageCtx: msg.ctx });
      break;
    case 'biliscope:open-popup':
      chrome.action?.openPopup?.().catch((e) => logger.warn('openPopup failed:', e));
      break;
    default:
      break;
  }
  sendResponse({ ok: true });
  return false; // 同步响应，不保持 channel
});

chrome.runtime?.onInstalled.addListener((details) => {
  logger.info('BiliScope installed:', details.reason);
});

// 清理 alarms
chrome.alarms?.clear?.('biliscope:tick').catch(() => undefined);

export {};