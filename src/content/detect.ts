/**
 * 当前页面上下文检测（popup + content 共用）。
 * 严格只读 URL，不读 DOM 内容。
 */

import { httpGet } from '@utils/http';
import { logger } from '@utils/logger';

export type PageContextType = 'creator' | 'video' | 'search' | 'unknown';

export interface PageContext {
  type: PageContextType;
  id: string;
  rawUrl: string;
}

const SPACE_RE = /^https?:\/\/space\.bilibili\.com\/(\d+)/;
const VIDEO_RE = /^https?:\/\/(?:www\.)?bilibili\.com\/video\/(BV[a-zA-Z0-9]+)/;
const SEARCH_RE = /^https?:\/\/search\.bilibili\.com\/all\?.*keyword=([^&]+)/;

export function detectFromUrl(url: string): PageContext | null {
  const m1 = url.match(SPACE_RE);
  if (m1 && m1[1]) return { type: 'creator', id: m1[1], rawUrl: url };
  const m2 = url.match(VIDEO_RE);
  if (m2 && m2[1]) return { type: 'video', id: m2[1], rawUrl: url };
  const m3 = url.match(SEARCH_RE);
  if (m3 && m3[1]) {
    return { type: 'search', id: decodeURIComponent(m3[1]), rawUrl: url };
  }
  return null;
}

/** 在 popup 内：通过 chrome.tabs.query 取当前 active tab URL */
export async function detectPageContext(): Promise<PageContext | null> {
  try {
    if (typeof chrome === 'undefined' || !chrome.tabs) return null;
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const t = tabs[0];
    if (!t?.url) return null;
    return detectFromUrl(t.url);
  } catch (e) {
    logger.warn('detectPageContext failed:', e);
    return null;
  }
}

/** 通过 B 站公开 API 把 BV 解析为 aid（用于评论接口需要 oid） */
export async function bvidToAid(bvid: string, signal?: AbortSignal): Promise<number | null> {
  try {
    const res = await httpGet<{ data?: { aid?: number } }>(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
      { signal },
    );
    return res.data?.aid ?? null;
  } catch {
    return null;
  }
}