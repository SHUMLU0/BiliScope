import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter, DEFAULT_MAX_TOKENS } from '@ai/openai-adapter';
import type { ProviderConfig } from '@ai/types';

const cfg: ProviderConfig = {
  name: 'openai-compatible',
  baseUrl: 'https://example.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-test',
};

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** 捕获最后一次请求体 */
function captureFetch(body: unknown, status = 200): { body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    captured = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return jsonResponse(body, status);
  }) as unknown as typeof fetch;
  return { body: () => captured };
}

describe('OpenAICompatibleAdapter · 基础链路', () => {
  it('analyze parses JSON-mode response', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    ) as unknown as typeof fetch;
    const a = new OpenAICompatibleAdapter(cfg);
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', jsonMode: true });
    expect(r.text).toBeTruthy();
    expect((r.parsed as { ok: boolean }).ok).toBe(true);
    expect(r.tokenUsage?.total).toBe(3);
  });

  it('analyze throws on HTTP error', async () => {
    globalThis.fetch = vi.fn(async () => new Response('bad', { status: 401 })) as unknown as typeof fetch;
    const a = new OpenAICompatibleAdapter(cfg);
    await expect(a.analyze({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow(/401/);
  });

  it('testConnection returns ok on success', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ choices: [{ message: { content: 'pong' } }] }),
    ) as unknown as typeof fetch;
    const a = new OpenAICompatibleAdapter(cfg);
    const r = await a.testConnection();
    expect(r.ok).toBe(true);
  });

  it('testConnection returns failure on throw', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('boom');
    }) as unknown as typeof fetch;
    const a = new OpenAICompatibleAdapter(cfg);
    const r = await a.testConnection();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('boom');
  });
});

describe('OpenAICompatibleAdapter · V3.0 诊断字段', () => {
  it('captures finish_reason / responseId / modelVersion', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        id: 'chatcmpl-abc',
        model: 'gpt-test-0613',
        choices: [{ finish_reason: 'stop', message: { content: '{"a":1}' } }],
      }),
    ) as unknown as typeof fetch;
    const a = new OpenAICompatibleAdapter(cfg);
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', jsonMode: true });
    expect(r.finishReason).toBe('stop');
    expect(r.responseId).toBe('chatcmpl-abc');
    expect(r.modelVersion).toBe('gpt-test-0613');
    expect(r.rawText).toBe('{"a":1}');
    expect(r.parseError).toBeUndefined();
  });

  it('reports finishReason=length (截断) and still records parse failure honestly', async () => {
    // 真实场景：模型输出到一半被截断 → 残缺 JSON
    const truncated = '{"summary":"这是一段被截断的输出","facts":["a","b"';
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ choices: [{ finish_reason: 'length', message: { content: truncated } }] }),
    ) as unknown as typeof fetch;
    const a = new OpenAICompatibleAdapter(cfg);
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', jsonMode: true });
    expect(r.finishReason).toBe('length');
    expect(r.parsed).toBeUndefined();
    expect(r.parseError).toBeTruthy();
    // 关键：绝不把残缺 raw text 当作 parsed 回填
    expect(r.text).toBe(truncated);
  });

  it('captures refusal field', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '', refusal: 'I cannot help' } }] }),
    ) as unknown as typeof fetch;
    const a = new OpenAICompatibleAdapter(cfg);
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u' });
    expect(r.refusal).toBe('I cannot help');
  });
});

describe('OpenAICompatibleAdapter · max_tokens 三级优先级', () => {
  it('uses request.maxTokens when provided', async () => {
    const cap = captureFetch({ choices: [{ message: { content: '{}' } }] });
    const a = new OpenAICompatibleAdapter({ ...cfg, maxTokens: 512 });
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', maxTokens: 4096 });
    expect(cap.body().max_tokens).toBe(4096);
    expect(r.usedMaxTokens).toBe(4096);
  });

  it('falls back to provider.maxTokens', async () => {
    const cap = captureFetch({ choices: [{ message: { content: '{}' } }] });
    const a = new OpenAICompatibleAdapter({ ...cfg, maxTokens: 512 });
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u' });
    expect(cap.body().max_tokens).toBe(512);
    expect(r.usedMaxTokens).toBe(512);
  });

  it('falls back to task default (NOT hardcoded 1024) when nothing configured', async () => {
    const cap = captureFetch({ choices: [{ message: { content: '{}' } }] });
    const a = new OpenAICompatibleAdapter(cfg);
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u' });
    expect(cap.body().max_tokens).toBe(DEFAULT_MAX_TOKENS);
    expect(r.usedMaxTokens).toBe(DEFAULT_MAX_TOKENS);
    expect(DEFAULT_MAX_TOKENS).not.toBe(1024);
  });
});

describe('OpenAICompatibleAdapter · 结构化输出降级链', () => {
  it('uses json_object by default when jsonMode=true', async () => {
    const cap = captureFetch({ choices: [{ message: { content: '{}' } }] });
    const a = new OpenAICompatibleAdapter(cfg); // 未声明 supportsJsonSchema
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', jsonMode: true });
    expect(cap.body().response_format).toEqual({ type: 'json_object' });
    expect(r.structuredOutput).toBe('json_object');
  });

  it('uses json_schema when provider declares support', async () => {
    const cap = captureFetch({ choices: [{ message: { content: '{}' } }] });
    const a = new OpenAICompatibleAdapter({ ...cfg, supportsJsonSchema: true });
    const r = await a.analyze({
      systemPrompt: 's',
      userPrompt: 'u',
      jsonMode: true,
      jsonSchema: { name: 'x', schema: { type: 'object', properties: {} } },
    });
    const rf = cap.body().response_format as { type: string; json_schema?: { name: string } };
    expect(rf.type).toBe('json_schema');
    expect(rf.json_schema?.name).toBe('x');
    expect(r.structuredOutput).toBe('json_schema');
  });

  it('falls back to prompt_only when provider disables both', async () => {
    const cap = captureFetch({ choices: [{ message: { content: '{}' } }] });
    const a = new OpenAICompatibleAdapter({ ...cfg, supportsJsonObject: false });
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', jsonMode: true });
    expect(cap.body().response_format).toBeUndefined();
    expect(r.structuredOutput).toBe('prompt_only');
  });

  it('degrades json_schema → json_object when provider rejects the param (400)', async () => {
    let call = 0;
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ error: { message: 'response_format json_schema not supported' } }), {
          status: 400,
        });
      }
      return jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '{}' } }] });
    }) as unknown as typeof fetch;
    const a = new OpenAICompatibleAdapter({ ...cfg, supportsJsonSchema: true });
    const r = await a.analyze({
      systemPrompt: 's',
      userPrompt: 'u',
      jsonMode: true,
      jsonSchema: { name: 'x', schema: { type: 'object', properties: {} } },
    });
    expect(call).toBe(2);
    expect((bodies[0]!.response_format as { type: string }).type).toBe('json_schema');
    expect((bodies[1]!.response_format as { type: string }).type).toBe('json_object');
    expect(r.structuredOutput).toBe('json_object');
  });

  it('does NOT degrade on unrelated errors (401 stays a hard failure)', async () => {
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call++;
      return new Response('unauthorized', { status: 401 });
    }) as unknown as typeof fetch;
    const a = new OpenAICompatibleAdapter({ ...cfg, supportsJsonSchema: true });
    await expect(
      a.analyze({
        systemPrompt: 's',
        userPrompt: 'u',
        jsonMode: true,
        jsonSchema: { name: 'x', schema: { type: 'object', properties: {} } },
      }),
    ).rejects.toThrow(/401/);
    expect(call).toBe(1);
  });
});

describe('OpenAICompatibleAdapter · 业务错误体', () => {
  it('throws when HTTP 200 but body has error.message', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ error: { message: 'quota exceeded', type: 'insufficient_quota' } }),
    ) as unknown as typeof fetch;
    const a = new OpenAICompatibleAdapter(cfg);
    await expect(a.analyze({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow(/quota exceeded/);
  });

  it('testConnection fails when connected but content is empty', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ choices: [{ finish_reason: 'stop', message: { content: '   ' } }] }),
    ) as unknown as typeof fetch;
    const a = new OpenAICompatibleAdapter(cfg);
    const r = await a.testConnection();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/empty/);
  });
});

describe('OpenAICompatibleAdapter · fetch 恢复', () => {
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  it('globalThis.fetch is restorable', () => {
    expect(typeof globalThis.fetch).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V3.0.1 · P0-A：流式（SSE）链路
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 构造一个返回 SSE 流的 fetch mock。
 *
 * `events` = 每个 `data:` 负载（会被逐条写成一个 SSE event 块）。
 * 通过 `ReadableStream` 逐块推送，真实模拟「服务端分段吐字」。
 */
function sseFetch(
  events: string[],
  opts: { status?: number; delayMs?: number } = {},
): { calls: () => number; bodies: () => Record<string, unknown>[] } {
  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
    calls++;
    bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (i: number): void => {
          if (i >= events.length) {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            return;
          }
          controller.enqueue(encoder.encode(`data: ${events[i]}\n\n`));
          if (opts.delayMs) setTimeout(() => write(i + 1), opts.delayMs);
          else write(i + 1);
        };
        write(0);
      },
    });
    return new Response(stream, {
      status: opts.status ?? 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
  return { calls: () => calls, bodies: () => bodies };
}

/** 把若干正文片段包成 OpenAI 兼容的流式 chunk 负载 */
function oaDelta(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: 'chatcmpl-stream',
    model: 'gpt-test-0613',
    choices: [{ delta: { content }, finish_reason: null }],
    ...extra,
  });
}

describe('OpenAICompatibleAdapter · V3.0.1 P0-A 流式', () => {
  it('默认按 supportsStreaming 走 SSE，并增量拼接正文', async () => {
    const cap = sseFetch([
      oaDelta('{"summary":"'),
      oaDelta('长输出'),
      oaDelta('不会被截断"}'),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    ]);
    const a = new OpenAICompatibleAdapter({ ...cfg, supportsStreaming: true });
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', jsonMode: true });
    expect(r.streamed).toBe(true);
    expect(cap.bodies()[0]!.stream).toBe(true);
    expect(r.text).toBe('{"summary":"长输出不会被截断"}');
    expect((r.parsed as { summary: string }).summary).toBe('长输出不会被截断');
    expect(r.finishReason).toBe('stop');
    expect(r.chunkCount).toBeGreaterThanOrEqual(3);
    expect(r.receivedChars).toBe('{"summary":"长输出不会被截断"}'.length);
    expect(r.firstByteAt).toBeGreaterThan(0);
  });

  it('request.stream=false 优先于 provider.supportsStreaming → 走非流式', async () => {
    const cap = captureFetch({ choices: [{ message: { content: '{}' } }] });
    const a = new OpenAICompatibleAdapter({ ...cfg, supportsStreaming: true });
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', stream: false });
    expect(r.streamed).toBe(false);
    expect(cap.body().stream).toBeUndefined();
  });

  it('provider 不支持流式时不强制流式（保持既有非流式链路可用）', async () => {
    const cap = captureFetch({ choices: [{ message: { content: '{}' } }] });
    const a = new OpenAICompatibleAdapter(cfg); // supportsStreaming 未声明
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u' });
    expect(r.streamed).toBe(false);
    expect(cap.body().stream).toBeUndefined();
  });

  it('流式聚合 usage（stream_options.include_usage）', async () => {
    sseFetch([
      oaDelta('hello'),
      JSON.stringify({
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }),
    ]);
    const a = new OpenAICompatibleAdapter({ ...cfg, supportsStreaming: true });
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u' });
    expect(r.tokenUsage?.total).toBe(30);
  });

  it('流式增量拼接后 parse 失败 → 如实报 parseError，绝不回填 raw', async () => {
    sseFetch([oaDelta('{"broken":'), oaDelta('not closed')]);
    const a = new OpenAICompatibleAdapter({ ...cfg, supportsStreaming: true });
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', jsonMode: true });
    expect(r.parsed).toBeUndefined();
    expect(r.parseError).toBeTruthy();
    expect(r.text).toBe('{"broken":not closed');
  });

  it('onProgress 上报 waiting_first_byte → streaming 的真实进度', async () => {
    sseFetch([oaDelta('abc'), oaDelta('def')], { delayMs: 30 });
    const seen: Array<{ phase: string; chars: number }> = [];
    const a = new OpenAICompatibleAdapter({ ...cfg, supportsStreaming: true });
    await a.analyze({
      systemPrompt: 's',
      userPrompt: 'u',
      onProgress: (p) => seen.push({ phase: p.phase, chars: p.receivedChars }),
    });
    expect(seen.length).toBeGreaterThan(0);
    // 至少出现过一次 streaming 阶段（有真实 chunk 到达）
    expect(seen.some((s) => s.phase === 'streaming')).toBe(true);
    expect(seen[seen.length - 1]!.chars).toBe(6);
  });

  it('SSE 响应中夹带非 JSON / [DONE] 行不破坏主链路', async () => {
    sseFetch([oaDelta('ok'), 'this-is-not-json']);
    const a = new OpenAICompatibleAdapter({ ...cfg, supportsStreaming: true });
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u' });
    expect(r.text).toBe('ok');
  });

  it('流式 HTTP 错误同样抛错（不因流式而吞掉状态码）', async () => {
    globalThis.fetch = vi.fn(async () => new Response('bad', { status: 401 })) as unknown as typeof fetch;
    const a = new OpenAICompatibleAdapter({ ...cfg, supportsStreaming: true });
    await expect(a.analyze({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow(/401/);
  });

  it('流式链路捕获 provider error 负载', async () => {
    sseFetch([JSON.stringify({ error: { message: 'quota exceeded' } })]);
    const a = new OpenAICompatibleAdapter({ ...cfg, supportsStreaming: true });
    await expect(a.analyze({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow(/quota exceeded/);
  });

  it('流式 + json_schema 被拒（400）→ 降级为 json_object 后重试', async () => {
    let call = 0;
    const bodies: Record<string, unknown>[] = [];
    const encoder = new TextEncoder();
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      call++;
      bodies.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      if (call === 1) {
        return new Response(JSON.stringify({ error: { message: 'response_format json_schema not supported' } }), {
          status: 400,
        });
      }
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: ${oaDelta('{}')}\n\n`));
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as unknown as typeof fetch;
    const a = new OpenAICompatibleAdapter({ ...cfg, supportsStreaming: true, supportsJsonSchema: true });
    const r = await a.analyze({
      systemPrompt: 's',
      userPrompt: 'u',
      jsonMode: true,
      jsonSchema: { name: 'x', schema: { type: 'object', properties: {} } },
    });
    expect(call).toBe(2);
    expect((bodies[1]!.response_format as { type: string }).type).toBe('json_object');
    expect(r.streamed).toBe(true);
  });

  it('testConnection 显式走非流式（不启动 SSE 连接）', async () => {
    const cap = captureFetch({ choices: [{ message: { content: 'pong' } }] });
    const a = new OpenAICompatibleAdapter({ ...cfg, supportsStreaming: true });
    const r = await a.testConnection();
    expect(r.ok).toBe(true);
    expect(cap.body().stream).toBeUndefined();
  });
});
