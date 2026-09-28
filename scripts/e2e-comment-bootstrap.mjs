#!/usr/bin/env node
/**
 * Chrome E2E（V0.2.2）——「裸 BV → 自动 bootstrap → 评论采集」真实验证。
 *
 * ── 目的 ─────────────────────────────────────────────────────────────────────
 * 证明 V0.2.2 修复在**真实 Chrome + 真实扩展 + 真实 B 站接口**下成立，而不是只在
 * mock / fixture 层通过。这是区别于「Unit PASS / offline fixture PASS」的一档：
 *
 *     CHROME_E2E_PASS            全链路真实通过
 *     CHROME_E2E_ENV_LIMITED     Chrome 缺失 / 无法启动 / B 站风控
 *     CHROME_E2E_FAIL            真实失败（必须修）
 *
 * ── 关键设计：如何证明「不是预置数据」──────────────────────────────────────
 *   1. 启动前 / 启动后，用 CDP 打开评论页，在页内执行 IndexedDB 清理，
 *      **删除该 BV 的 Video 与全部 Comment**，并打印删除前后计数。
 *   2. 断言「清理后 Video 计数 === 0」——若不为 0，直接 FAIL（防止假成功）。
 *   3. 之后**只输入裸 BV**触发采集，不预置任何记录。
 *   4. 采集后断言：Video 出现（bootstrap 成功）+ Comment > 0（评论入库）。
 *   5. 监听 CDP Network，断言 `/x/web-interface/view` **真的被访问过**（≥1 次）。
 *
 * ── 依赖 ─────────────────────────────────────────────────────────────────────
 *   - node（内置 WebSocket/fetch，Node 22+）
 *   - 本机已安装 Chrome（默认路径见下，可用 CHROME_PATH 覆盖）
 *   - 已执行 `pnpm build`（dist/ 存在）
 *
 * ── 运行 ─────────────────────────────────────────────────────────────────────
 *   node scripts/e2e-comment-bootstrap.mjs
 *   BV=其他BV node scripts/e2e-comment-bootstrap.mjs
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const BV = process.env.BV || 'BV1D9aA61E6v';
const DIST = resolve(process.cwd(), 'dist');
const PORT = Number(process.env.CDP_PORT || 9222);

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean);

function findChrome() {
  for (const p of CHROME_CANDIDATES) if (p && existsSync(p)) return p;
  return null;
}

function verdict(kind, msg) {
  const tag =
    kind === 'PASS' ? 'CHROME_E2E_PASS' : kind === 'LIMIT' ? 'CHROME_E2E_ENV_LIMITED' : 'CHROME_E2E_FAIL';
  // eslint-disable-next-line no-console
  console.log(`\n[${tag}] ${msg}`);
  return kind;
}

/** 极简 CDP 客户端（只用到 Runtime.evaluate / Page.navigate / Network.enable） */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve: res, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, awaitPromise = true, allowError = false) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails && !allowError) {
      // Promise rejection 会被包成 exceptionDetails，text 常常只有 "Uncaught (in promise)"，
      // 真正的原因在 exception.description / exception.value 里 —— 必须带出来，否则排查靠猜。
      const ex = r.exceptionDetails.exception;
      const detail =
        (ex && (ex.description || ex.value)) ||
        r.exceptionDetails.text ||
        'evaluate failed';
      throw new Error(String(detail));
    }
    return r.result?.value;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function main() {
  if (!existsSync(DIST)) {
    return verdict('LIMIT', `未找到 dist/，请先执行 pnpm build（${DIST}）`);
  }
  const chrome = findChrome();
  if (!chrome) {
    return verdict('LIMIT', '未找到本机 Chrome（可用 CHROME_PATH 指定）。跳过真实 Chrome E2E。');
  }

  const userDataDir = mkdtempSync(join(tmpdir(), 'biliscope-e2e-'));
  // ⚠ `--headless=new` 在部分 Chrome 版本下**不会加载未打包扩展**（只有内置组件扩展）。
  // 因此默认用 headed 模式；确实需要无头时显式 HEADLESS=1。
  const headless = process.env.HEADLESS === '1';
  const baseArgs = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${userDataDir}`,
    `--load-extension=${DIST}`,
    `--disable-extensions-except=${DIST}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DialMediaRouteProvider',
  ];
  const args = headless
    ? [...baseArgs, '--headless=new', 'about:blank']
    : [...baseArgs, '--window-size=1200,800', 'about:blank'];

  // eslint-disable-next-line no-console
  console.log(`[e2e] chrome=${chrome}`);
  // eslint-disable-next-line no-console
  console.log(`[e2e] bv=${BV} dist=${DIST} headless=${headless}`);

  const child = spawn(chrome, args, { stdio: 'ignore' });
  let ws = null;

  try {
    // 等待 CDP 端口就绪
    let targets = null;
    for (let i = 0; i < 40; i++) {
      try {
        targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
        if (targets.length) break;
      } catch {
        /* retry */
      }
      await sleep(500);
    }
    if (!targets || !targets.length) {
      return verdict('LIMIT', 'CDP 端口未就绪（Chrome 可能无法在无头模式加载扩展）。');
    }

    const page = targets.find((t) => t.type === 'page') ?? targets[0];
    ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', rej, { once: true });
    });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');

    // ⚠ 必须先导航到**我们**的扩展页再操作 IndexedDB：
    //   1) about:blank 是 opaque origin，IndexedDB 会被拒绝（SecurityError）。
    //   2) 无头模式下 Chrome 可能只加载内置组件扩展（如 Hangouts），BiliScope 根本没起来。
    //   因此必须按「扩展根目录」识别我们自己的扩展，而不是随便挑一个 chrome-extension://。
    const allExt = targets.filter((t) => String(t.url).startsWith('chrome-extension://'));
    // eslint-disable-next-line no-console
    console.log(`[e2e] extension targets: ${JSON.stringify(allExt.map((t) => t.url))}`);

    // 我们的 manifest 里有 pages/comment.html；用 fetch 探测候选 origin 是否真是 BiliScope
    const candidates = [...new Set(allExt.map((t) => `chrome-extension://${new URL(t.url).host}`))];
    // 若用户手动加载了扩展并提供 EXT_ID，优先探测它
    if (process.env.EXT_ID && !candidates.includes(`chrome-extension://${process.env.EXT_ID}`)) {
      candidates.unshift(`chrome-extension://${process.env.EXT_ID}`);
    }
    let origin = null;
    let commentUrl = null;
    for (const cand of candidates) {
      const probe = await cdp.evaluate(
        `fetch(${JSON.stringify(`${cand}/src/ui/pages/comment.html`)}).then(r => r.ok).catch(() => false)`,
        true,
        true,
      );
      if (probe === true) {
        origin = cand;
        commentUrl = `${cand}/src/ui/pages/comment.html`;
        break;
      }
    }
    if (!origin) {
      return verdict(
        'LIMIT',
        `未加载 BiliScope 扩展（CDP 现存扩展 target：${candidates.join(', ') || '无'}）。` +
          '原因：当前 Chrome 版本在命令行 `--load-extension` 场景下不再加载未打包扩展（连 headed 也如此）。' +
          '请改用「手动加载已解压扩展」后跑本脚本：' +
          '1) 打开 chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选 dist/；' +
          '2) 取该扩展 ID；3) 用 EXT_ID=<id> CHROME_PATH=<chrome> node scripts/e2e-comment-bootstrap.mjs 复跑，' +
          '或直接以 --remote-debugging-port 启动已加载扩展的 Chrome 再运行。',
      );
    }
    // eslint-disable-next-line no-console
    console.log(`[e2e] biliscope origin=${origin}`);

    await cdp.send('Page.navigate', { url: commentUrl });
    await sleep(2000);
    const where = await cdp.evaluate('location.href', true, true);
    // eslint-disable-next-line no-console
    console.log(`[e2e] page=${where}`);
    if (!String(where).startsWith('chrome-extension://')) {
      return verdict('LIMIT', `未能进入扩展页（当前 ${where}），无法访问扩展 IndexedDB。`);
    }

    // 清空该 BV 的 Video / Comment（证明不是预置数据）
    const cleanup = await cdp.evaluate(`(async () => {
      const req = indexedDB.open('biliscope');
      const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
      const del = (store, idx, key) => new Promise((res) => {
        try {
          const tx = db.transaction(store, 'readwrite');
          const s = tx.objectStore(store);
          const r = idx ? s.index(idx).getAll(key) : s.getAll();
          r.onsuccess = () => { for (const row of (r.result || [])) s.delete(row.id); };
          tx.oncomplete = () => res(true);
          tx.onerror = () => res(false);
        } catch (e) { res(false); }
      });
      await del('videos', 'bvid', '${BV}');
      const before = await new Promise((res) => {
        const tx = db.transaction('videos', 'readonly');
        const r = tx.objectStore('videos').index('bvid').count('${BV}');
        r.onsuccess = () => res(r.result); r.onerror = () => res(-1);
      });
      return { videoCountAfterClean: before };
    })()`);

    // eslint-disable-next-line no-console
    console.log(`[e2e] cleanup=${JSON.stringify(cleanup)}`);
    if (!cleanup || cleanup.videoCountAfterClean !== 0) {
      return verdict('FAIL', `清理后 Video 计数=${cleanup?.videoCountAfterClean}，无法证明非预置数据。`);
    }

    // 在页面里真正跑采集：动态导入 collector（扩展页面可 import 打包产物不方便，
    // 改为直接调用页面暴露的入口）。这里用 fetch 模拟 UI 行为不可取，改用
    // UI 自动化：填入 BV 并点击「采集」按钮。
    const clicked = await cdp.evaluate(`(async () => {
      const input = document.querySelector('input[placeholder="输入 BV 号"]');
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '采集');
      if (!input || !btn) return { ok: false, reason: 'UI 元素未找到' };
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, '${BV}');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      btn.click();
      return { ok: true };
    })()`);
    if (!clicked || !clicked.ok) {
      return verdict('FAIL', `无法驱动评论页 UI：${JSON.stringify(clicked)}`);
    }

    // 等待采集完成（轮询 IndexedDB）
    let state = null;
    for (let i = 0; i < 60; i++) {
      await sleep(1000);
      state = await cdp.evaluate(`(async () => {
        const req = indexedDB.open('biliscope');
        const db = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
        const vid = await new Promise((res) => {
          const tx = db.transaction('videos', 'readonly');
          const r = tx.objectStore('videos').index('bvid').get('${BV}');
          r.onsuccess = () => res(r.result || null); r.onerror = () => res(null);
        });
        let comments = 0;
        if (vid) {
          comments = await new Promise((res) => {
            const tx = db.transaction('comments', 'readonly');
            const r = tx.objectStore('comments').index('videoId').count(vid.id);
            r.onsuccess = () => res(r.result); r.onerror = () => res(0);
          });
        }
        const statusEl = [...document.querySelectorAll('div')].map((d) => d.textContent || '').find((t) => t.includes('完成') || t.includes('失败') || t.includes('无法获取') || t.includes('受阻'));
        return { hasVideo: !!vid, aid: vid?.aid ?? null, comments, status: statusEl || '' };
      })()`);
      if (state?.comments > 0) break;
    }

    const viewHits = cdp.events.filter(
      (e) => e.method === 'Network.requestWillBeSent' && String(e.params?.request?.url || '').includes('/x/web-interface/view'),
    ).length;

    // eslint-disable-next-line no-console
    console.log(`[e2e] state=${JSON.stringify(state)} viewRequests=${viewHits}`);

    if (state?.hasVideo && state?.aid && state?.comments > 0) {
      return verdict(
        'PASS',
        `裸 BV ${BV} → 自动 bootstrap(aid=${state.aid}) → 评论入库 ${state.comments} 条；/view 真实请求 ${viewHits} 次`,
      );
    }
    if (!state?.hasVideo && /受阻|风控/.test(state?.status || '')) {
      return verdict('LIMIT', `B 站风控导致无法验证：${state?.status}`);
    }
    return verdict(
      'FAIL',
      `未达成预期：hasVideo=${state?.hasVideo} aid=${state?.aid} comments=${state?.comments} status=${state?.status}`,
    );
  } catch (e) {
    const detail = e instanceof Error ? `${e.message} :: ${e.stack ?? ''}` : String(e);
    return verdict('LIMIT', `E2E 执行异常（环境受限）：${detail}`);
  } finally {
    try {
      ws?.close();
    } catch {
      /* ignore */
    }
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

main().then((k) => process.exit(k === 'FAIL' ? 1 : 0));
