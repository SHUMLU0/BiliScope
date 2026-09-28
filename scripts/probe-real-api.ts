/**
 * 开发级探针：抓取 B 站匿名接口的**真实原始响应**并落盘到 tests/fixtures/real/。
 *
 * 用途：字段映射必须以真实响应为准，不允许凭猜测或旧文档拍脑袋。
 * 运行：pnpm tsx scripts/probe-real-api.ts [uid] [keyword]
 *
 * 注意：这是真实网络请求（不打 mock、不重试伪造），若出口 IP 被风控，
 * 落盘内容会如实记录 code=-352 等，不允许人工改成 0 来"通过"。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { md5 } from '../src/utils/md5';

const UID = Number(process.argv[2] ?? 946974);
const KEYWORD = process.argv[3] ?? '影视飓风';
const OUT = fileURLToPath(new URL('../tests/fixtures/real/', import.meta.url));

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39,
  12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63,
  57, 62, 11, 36, 20, 34, 44, 52,
];

async function rawGet(url: string, referrer: string): Promise<{ status: number; body: string }> {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json, text/plain, */*', Referer: referrer },
    credentials: 'omit',
    referrer,
    referrerPolicy: 'unsafe-url',
  });
  return { status: res.status, body: await res.text() };
}

async function getMixinKey(): Promise<string> {
  const { body } = await rawGet('https://api.bilibili.com/x/web-interface/nav', 'https://www.bilibili.com/');
  const j = JSON.parse(body) as { data?: { wbi_img?: { img_url?: string; sub_url?: string } } };
  const keyOf = (u?: string) => (u ?? '').split('?')[0].split('/').pop()?.split('.')[0] ?? '';
  const raw = keyOf(j.data?.wbi_img?.img_url) + keyOf(j.data?.wbi_img?.sub_url);
  return MIXIN_KEY_ENC_TAB.map((i) => raw[i] ?? '').join('').slice(0, 32);
}

function sign(mixin: string, params: Record<string, string | number>): string {
  const filtered: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) {
    filtered[k] = String(v).replace(/[!'()*]/g, '');
  }
  filtered.wts = Math.floor(Date.now() / 1000);
  const query = Object.keys(filtered)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(filtered[k])}`)
    .join('&');
  return `${query}&w_rid=${md5(query + mixin)}`;
}

function dump(name: string, status: number, body: string, trim?: (j: unknown) => unknown): void {
  let out: unknown;
  try {
    const j = JSON.parse(body);
    out = trim ? trim(j) : j;
  } catch {
    out = body.slice(0, 2000);
  }
  const text = JSON.stringify(out, null, 2);
  writeFileSync(`${OUT}${name}.json`, text, 'utf8');
  let code: unknown = 'n/a';
  try {
    code = (JSON.parse(body) as { code?: unknown }).code;
  } catch {
    /* ignore */
  }
  console.log(`[probe] ${name}: http=${status} code=${String(code)} bytes=${text.length}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const spaceRef = `https://space.bilibili.com/${UID}/`;
  const mixin = await getMixinKey().catch((e) => {
    console.log(`[probe] nav failed: ${String(e)}`);
    return '';
  });
  console.log(`[probe] uid=${UID} keyword=${KEYWORD} mixin=${mixin ? mixin.slice(0, 8) + '…' : '(none)'}`);

  // 1. legacy acc/info（无签名对照）
  {
    const { status, body } = await rawGet(`https://api.bilibili.com/x/space/acc/info?mid=${UID}`, spaceRef);
    dump('acc-info-legacy', status, body);
  }
  // 2. wbi acc/info（签名）
  if (mixin) {
    const q = sign(mixin, { mid: UID, token: '' });
    const { status, body } = await rawGet(`https://api.bilibili.com/x/space/wbi/acc/info?${q}`, spaceRef);
    dump('acc-info-wbi', status, body);
  }
  // 2-bis. /x/web-interface/card（无 WBI，acc/info 被风控时的替代资料来源）
  {
    const { status, body } = await rawGet(
      `https://api.bilibili.com/x/web-interface/card?mid=${UID}&photo=false`,
      spaceRef,
    );
    dump('card', status, body, trimCard);
  }
  // 3. upstat
  {
    const { status, body } = await rawGet(`https://api.bilibili.com/x/space/upstat?mid=${UID}`, spaceRef);
    dump('upstat', status, body);
  }
  // 4. legacy arc/search（无签名对照）
  {
    const { status, body } = await rawGet(
      `https://api.bilibili.com/x/space/arc/search?mid=${UID}&pn=1&ps=3&order=pubdate&platform=web&web_location=40020`,
      spaceRef,
    );
    dump('arc-search-legacy', status, body, trimArc);
  }
  // 5. wbi arc/search（签名）—— 真实字段结构来源
  if (mixin) {
    const q = sign(mixin, {
      mid: UID,
      pn: 1,
      ps: 3,
      order: 'pubdate',
      platform: 'web',
      web_location: 40020,
      tid: 0,
      keyword: '',
    });
    const { status, body } = await rawGet(`https://api.bilibili.com/x/space/wbi/arc/search?${q}`, spaceRef);
    dump('arc-search-wbi', status, body, trimArc);
  }
  // 6. search/type 未签名
  {
    const u = `https://api.bilibili.com/x/web-interface/search/type?search_type=video&keyword=${encodeURIComponent(
      KEYWORD,
    )}&page=1&page_size=3&order=pubdate&platform=web&web_location=40020`;
    const { status, body } = await rawGet(u, 'https://search.bilibili.com/');
    dump('search-type-plain', status, body, trimSearch);
  }
  // 7. search/type WBI 签名
  if (mixin) {
    const q = sign(mixin, {
      search_type: 'video',
      keyword: KEYWORD,
      page: 1,
      page_size: 3,
      order: 'pubdate',
      platform: 'web',
      web_location: 40020,
    });
    const { status, body } = await rawGet(
      `https://api.bilibili.com/x/web-interface/search/type?${q}`,
      'https://search.bilibili.com/',
    );
    dump('search-type-wbi', status, body, trimSearch);
  }
  // 8. wbi/search/type（新版分类搜索入口，验证是否可用）
  if (mixin) {
    const q = sign(mixin, {
      search_type: 'video',
      keyword: KEYWORD,
      page: 1,
      page_size: 3,
      order: 'pubdate',
      platform: 'web',
      web_location: 40020,
    });
    const { status, body } = await rawGet(
      `https://api.bilibili.com/x/web-interface/wbi/search/type?${q}`,
      'https://search.bilibili.com/',
    );
    dump('search-type-wbi-endpoint', status, body, trimSearch);
  }
  // 8-bis. 关系数（粉丝/关注）：acc/info 被风控时的真实替代来源
  {
    const { status, body } = await rawGet(`https://api.bilibili.com/x/relation/stat?vmid=${UID}`, spaceRef);
    dump('relation-stat', status, body);
  }
  // 8-ter. navnum（投稿/收藏等计数）
  {
    const { status, body } = await rawGet(`https://api.bilibili.com/x/space/navnum?mid=${UID}`, spaceRef);
    dump('navnum', status, body);
  }
  // 8-quater. 合集/系列归档（无 WBI，验证 vlist 类字段是否可得）
  {
    const { status, body } = await rawGet(
      `https://api.bilibili.com/x/series/recArchivesByKeywords?mid=${UID}&keywords=`,
      spaceRef,
    );
    dump('series-recarchives', status, body, trimSeries);
  }
  // 8-quinquies. wbi/arc/search 极简参数重试（去掉 tid/keyword/web_location）
  if (mixin) {
    const q = sign(mixin, { mid: UID, pn: 1, ps: 3, order: 'pubdate', platform: 'web' });
    const { status, body } = await rawGet(
      `https://api.bilibili.com/x/space/wbi/arc/search?${q}`,
      spaceRef,
    );
    dump('arc-search-wbi-min', status, body, trimArc);
  }
  // 9. 单视频 view（用已知 BV 号，验证 stat 字段）
  {
    const { status, body } = await rawGet(
      'https://api.bilibili.com/x/web-interface/view?bvid=BV1GJ411x7h7',
      'https://www.bilibili.com/video/BV1GJ411x7h7',
    );
    dump('view', status, body, trimView);
  }
  console.log(`[probe] done -> ${OUT}`);
}

function trimArc(j: unknown): unknown {
  const root = j as { data?: { list?: { vlist?: unknown[]; page?: unknown } } };
  const vlist = root.data?.list?.vlist ?? [];
  return {
    code: (j as { code?: number }).code,
    message: (j as { message?: string }).message,
    page: root.data?.list?.page,
    vlistSample: vlist.slice(0, 3),
    vlistKeys: vlist[0] && typeof vlist[0] === 'object' ? Object.keys(vlist[0] as object) : [],
  };
}

function trimSearch(j: unknown): unknown {
  const root = j as {
    code?: number;
    message?: string;
    data?: { result?: unknown; numResults?: number; numPages?: number };
  };
  const r = root.data?.result;
  // 真实响应里 data.result 可能是数组，也可能是 { video: [] }
  const arr = Array.isArray(r) ? r : Array.isArray((r as { video?: unknown[] } | undefined)?.video) ? ((r as { video: unknown[] }).video) : [];
  const first = arr[0];
  return {
    code: root.code,
    message: root.message,
    resultIsArray: Array.isArray(r),
    numResults: root.data?.numResults,
    numPages: root.data?.numPages,
    videoSample: arr.slice(0, 2),
    videoKeys: first && typeof first === 'object' ? Object.keys(first as object) : [],
  };
}

function trimCard(j: unknown): unknown {
  const d = (j as { code?: number; data?: { card?: Record<string, unknown> } }).data;
  const card = d?.card;
  return {
    code: (j as { code?: number }).code,
    message: (j as { message?: string }).message,
    cardKeys: card ? Object.keys(card) : [],
    cardSample: card
      ? {
          mid: card.mid,
          name: card.name,
          fans: card.fans,
          attention: card.attention,
          following: card.following,
          archive_count: card.archive_count,
          level_info: card.level_info,
          sign: card.sign,
        }
      : null,
    archive_count: (j as { data?: { archive_count?: unknown } }).data?.archive_count,
  };
}

function trimSeries(j: unknown): unknown {
  const d = (j as { code?: number; data?: { archives?: unknown[] } }).data;
  const arr = d?.archives ?? [];
  const first = arr[0];
  return {
    code: (j as { code?: number }).code,
    archivesSample: arr.slice(0, 2),
    archivesKeys: first && typeof first === 'object' ? Object.keys(first as object) : [],
  };
}

function trimView(j: unknown): unknown {
  const d = (j as { data?: Record<string, unknown> }).data;
  if (!d) return j;
  return {
    code: (j as { code?: number }).code,
    bvid: d.bvid,
    aid: d.aid,
    pubdate: d.pubdate,
    duration: d.duration,
    keys: Object.keys(d),
    stat: d.stat,
    owner: d.owner ? { mid: (d.owner as { mid?: number }).mid, name: (d.owner as { name?: string }).name } : undefined,
  };
}

main().catch((e) => {
  console.error('[probe] fatal', e);
  process.exit(1);
});
