import { afterEach, describe, expect, it, vi } from 'vitest';
import * as streamingModule from '@ai/streaming';
import { STREAM_FIRST_BYTE_TIMEOUT_MS, consumeSseStream, parseSseDataLines } from '@ai/streaming';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('streaming · 超时常量（V3.1.1：默认不限制，无隐藏 timer）', () => {
  it('首个响应等待 = 30s（仅提示，绝不当总时长上限用）', () => {
    expect(STREAM_FIRST_BYTE_TIMEOUT_MS).toBe(30_000);
  });

  it('TIMEOUT-001: 隐藏默认已废除 —— 模块不再导出 DEFAULT_IDLE_TIMEOUT_MS / FALLBACK_TIMEOUT_MS', () => {
    const mod = streamingModule as unknown as Record<string, unknown>;
    expect(mod.DEFAULT_IDLE_TIMEOUT_MS).toBeUndefined();
    expect(mod.FALLBACK_TIMEOUT_MS).toBeUndefined();
  });

  it('TIMEOUT-002: 除首字节提示外不存在任何超时常量（计时完全由 idleTimeoutMs 二态决定）', () => {
    // V3.1.1 红线：不设置 idleTimeoutMs 就是不限制，不存在任何隐藏的 30/60/120/300s timer。
    // 模块层只保留 STREAM_FIRST_BYTE_TIMEOUT_MS（首字节仅提示，不终止请求）。
    const mod = streamingModule as unknown as Record<string, unknown>;
    const timeoutKeys = Object.keys(mod).filter(
      (k) => /TIMEOUT/i.test(k) && k !== 'STREAM_FIRST_BYTE_TIMEOUT_MS',
    );
    expect(timeoutKeys).toEqual([]);
  });
});

describe('streaming · parseSseDataLines', () => {
  it('解析 data: 行并识别 [DONE]', () => {
    const r = parseSseDataLines('data: {"a":1}\ndata: [DONE]\n');
    expect(r.payloads).toEqual(['{"a":1}']);
    expect(r.done).toBe(true);
  });

  it('兼容 "data:" 与 "data: " 两种写法', () => {
    const r = parseSseDataLines('data:{"a":1}\ndata: {"b":2}\n');
    expect(r.payloads).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('忽略注释行 / 其他字段 / 空行', () => {
    const r = parseSseDataLines(': keepalive\nevent: message\nid: 3\n\ndata: {"ok":1}\n');
    expect(r.payloads).toEqual(['{"ok":1}']);
    expect(r.done).toBe(false);
  });

  it('无 data 行时返回空数组且不报错', () => {
    const r = parseSseDataLines('event: ping\n\n');
    expect(r.payloads).toEqual([]);
    expect(r.done).toBe(false);
  });
});

describe('streaming · consumeSseStream', () => {
  /** 把字符串数组包成 ReadableStream，模拟分段推送 */
  function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
    const enc = new TextEncoder();
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    });
  }

  it('按整行回调，跨 chunk 切断的行会被正确拼接', async () => {
    const lines: string[] = [];
    await consumeSseStream(streamOf(['data: {"a":', '1}\n', 'data: [DONE]\n']), (l) => lines.push(l));
    expect(lines).toEqual(['data: {"a":1}', 'data: [DONE]']);
  });

  it('多字节字符被 chunk 边界切断时不产生乱码', async () => {
    // "中文" 的 UTF-8 字节被切成两半
    const full = new TextEncoder().encode('data: 中文\n');
    const half = Math.floor(full.length / 2);
    const a = full.slice(0, half);
    const b = full.slice(half);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(a);
        controller.enqueue(b);
        controller.close();
      },
    });
    const lines: string[] = [];
    await consumeSseStream(stream, (l) => lines.push(l));
    expect(lines.join('')).toContain('中文');
  });

  it('shouldAbort=true 时抛出（供空闲看门狗终止流）', async () => {
    await expect(
      consumeSseStream(streamOf(['x']), () => undefined, () => true),
    ).rejects.toThrow(/abort/i);
  });

  it('收尾时把无换行的尾行也交出去', async () => {
    const lines: string[] = [];
    await consumeSseStream(streamOf(['data: tail-no-newline']), (l) => lines.push(l));
    expect(lines).toEqual(['data: tail-no-newline']);
  });
});
