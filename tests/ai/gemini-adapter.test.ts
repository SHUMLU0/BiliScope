import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiAdapter } from '@ai/gemini-adapter';
import type { ProviderConfig } from '@ai/types';

const cfg: ProviderConfig = {
  name: 'gemini',
  baseUrl: 'https://generativelanguage.googleapis.com',
  apiKey: 'gm-test',
  model: 'gemini-2.0-flash',
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function captureFetch(body: unknown, status = 200): { body: () => Record<string, unknown>; url: () => string } {
  let captured: Record<string, unknown> = {};
  let capturedUrl = '';
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    capturedUrl = String(url);
    captured = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return jsonResponse(body, status);
  }) as unknown as typeof fetch;
  return { body: () => captured, url: () => capturedUrl };
}

describe('GeminiAdapter · 基础链路', () => {
  it('parses a generateContent response', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '{"a":1}' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7, totalTokenCount: 12 },
      }),
    ) as unknown as typeof fetch;
    const a = new GeminiAdapter(cfg);
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', jsonMode: true });
    expect((r.parsed as { a: number }).a).toBe(1);
    expect(r.tokenUsage).toEqual({ prompt: 5, completion: 7, total: 12 });
  });

  it('throws on HTTP error', async () => {
    globalThis.fetch = vi.fn(async () => new Response('bad', { status: 403 })) as unknown as typeof fetch;
    const a = new GeminiAdapter(cfg);
    await expect(a.analyze({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow(/403/);
  });

  it('sends the api key in query and uses encoded model name', async () => {
    const cap = captureFetch({ candidates: [{ content: { parts: [{ text: '{}' }] } }] });
    const a = new GeminiAdapter({ ...cfg, model: 'gemini-2.0/flash' });
    await a.analyze({ systemPrompt: 's', userPrompt: 'u' });
    expect(cap.url()).toContain(':generateContent?key=gm-test');
    expect(cap.url()).toContain('gemini-2.0%2Fflash');
  });
});

describe('GeminiAdapter · V3.0 诊断字段', () => {
  it('captures finishReason / finishMessage / modelVersion / responseId', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        candidates: [
          {
            content: { parts: [{ text: '{"a":1}' }] },
            finishReason: 'STOP',
            finishMessage: 'ok',
          },
        ],
        modelVersion: 'gemini-2.0-flash-001',
        responseId: 'resp-123',
      }),
    ) as unknown as typeof fetch;
    const a = new GeminiAdapter(cfg);
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', jsonMode: true });
    expect(r.finishReason).toBe('STOP');
    expect(r.finishMessage).toBe('ok');
    expect(r.modelVersion).toBe('gemini-2.0-flash-001');
    expect(r.responseId).toBe('resp-123');
  });

  it('reports MAX_TOKENS honestly and does not backfill parsed', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        candidates: [{ content: { parts: [{ text: '{"summary":"截断' }] }, finishReason: 'MAX_TOKENS' }],
      }),
    ) as unknown as typeof fetch;
    const a = new GeminiAdapter(cfg);
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', jsonMode: true });
    expect(r.finishReason).toBe('MAX_TOKENS');
    expect(r.parsed).toBeUndefined();
    expect(r.parseError).toBeTruthy();
  });

  it('surfaces promptFeedback safety block as refusal', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        candidates: [],
        promptFeedback: { blockReason: 'SAFETY', blockReasonMessage: 'blocked by policy' },
      }),
    ) as unknown as typeof fetch;
    const a = new GeminiAdapter(cfg);
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u' });
    expect(r.finishReason).toBe('SAFETY');
    expect(r.refusal).toBe('blocked by policy');
    expect(r.text).toBe('');
  });
});

describe('GeminiAdapter · Structured Output', () => {
  it('sends responseMimeType + responseSchema (converted from JSON Schema)', async () => {
    const cap = captureFetch({ candidates: [{ content: { parts: [{ text: '{}' }] } }] });
    const a = new GeminiAdapter(cfg);
    const r = await a.analyze({
      systemPrompt: 's',
      userPrompt: 'u',
      jsonMode: true,
      jsonSchema: {
        name: 'x',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            summary: { type: 'string', maxLength: 100 },
            facts: { type: 'array', items: { type: 'string' } },
          },
          required: ['summary', 'facts'],
        },
      },
    });
    const gc = cap.body().generationConfig as {
      responseMimeType: string;
      responseSchema: Record<string, unknown>;
    };
    expect(gc.responseMimeType).toBe('application/json');
    expect(gc.responseSchema).toBeTruthy();
    // additionalProperties 必须被剔除（Gemini 不接受）
    expect(JSON.stringify(gc.responseSchema)).not.toContain('additionalProperties');
    expect((gc.responseSchema.properties as Record<string, unknown>).summary).toBeTruthy();
    expect(r.structuredOutput).toBe('json_schema');
  });

  it('degrades responseSchema → responseMimeType only when rejected', async () => {
    let call = 0;
    const gcs: Array<Record<string, unknown>> = [];
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? '{}')) as { generationConfig?: Record<string, unknown> };
      gcs.push(b.generationConfig ?? {});
      call++;
      if (call === 1) return new Response('responseSchema invalid', { status: 400 });
      return jsonResponse({ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] });
    }) as unknown as typeof fetch;
    const a = new GeminiAdapter(cfg);
    const r = await a.analyze({
      systemPrompt: 's',
      userPrompt: 'u',
      jsonMode: true,
      jsonSchema: { name: 'x', schema: { type: 'object', properties: {} } },
    });
    expect(call).toBe(2);
    expect(gcs[0]!.responseSchema).toBeTruthy();
    expect(gcs[1]!.responseSchema).toBeUndefined();
    expect(gcs[1]!.responseMimeType).toBe('application/json');
    expect(r.structuredOutput).toBe('json_object');
  });

  it('omits response config entirely when jsonMode is false', async () => {
    const cap = captureFetch({ candidates: [{ content: { parts: [{ text: 'plain' }] } }] });
    const a = new GeminiAdapter(cfg);
    await a.analyze({ systemPrompt: 's', userPrompt: 'u' });
    const gc = cap.body().generationConfig as Record<string, unknown>;
    expect(gc.responseMimeType).toBeUndefined();
    expect(gc.responseSchema).toBeUndefined();
  });
});

describe('GeminiAdapter · max_tokens 优先级', () => {
  it('request.maxTokens wins over provider and default', async () => {
    const cap = captureFetch({ candidates: [{ content: { parts: [{ text: '{}' }] } }] });
    const a = new GeminiAdapter({ ...cfg, maxTokens: 300 });
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', maxTokens: 4096 });
    expect((cap.body().generationConfig as { maxOutputTokens: number }).maxOutputTokens).toBe(4096);
    expect(r.usedMaxTokens).toBe(4096);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// V3.0.1 · P0-A：流式（streamGenerateContent?alt=sse）
// ─────────────────────────────────────────────────────────────────────────────

function geminiSseFetch(
  events: string[],
  opts: { status?: number } = {},
): { calls: () => number; urls: () => string[] } {
  const urls: string[] = [];
  let calls = 0;
  globalThis.fetch = vi.fn(async (url: string) => {
    calls++;
    urls.push(String(url));
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const e of events) controller.enqueue(encoder.encode(`data: ${e}\n\n`));
        controller.close();
      },
    });
    return new Response(stream, {
      status: opts.status ?? 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
  return { calls: () => calls, urls: () => urls };
}

function gChunk(text: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    candidates: [{ content: { parts: [{ text }] } }],
    ...extra,
  });
}

describe('GeminiAdapter · V3.0.1 P0-A 流式', () => {
  it('默认走 streamGenerateContent?alt=sse，并增量拼接 parts[].text', async () => {
    const cap = geminiSseFetch([
      gChunk('{"summary":"'),
      gChunk('增量'),
      gChunk('拼接"}'),
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 9, totalTokenCount: 12 },
        modelVersion: 'gemini-2.0-flash-001',
        responseId: 'resp-s',
      }),
    ]);
    const a = new GeminiAdapter({ ...cfg, supportsStreaming: true });
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', jsonMode: true });
    expect(cap.urls()[0]).toContain(':streamGenerateContent');
    expect(cap.urls()[0]).toContain('alt=sse');
    expect(r.streamed).toBe(true);
    expect(r.text).toBe('{"summary":"增量拼接"}');
    expect((r.parsed as { summary: string }).summary).toBe('增量拼接');
    expect(r.finishReason).toBe('STOP');
    expect(r.modelVersion).toBe('gemini-2.0-flash-001');
    expect(r.responseId).toBe('resp-s');
    expect(r.tokenUsage?.total).toBe(12);
    expect(r.chunkCount).toBeGreaterThanOrEqual(3);
    expect(r.receivedChars).toBe('{"summary":"增量拼接"}'.length);
  });

  it('request.stream=false 强制非流式（URL 回到 generateContent）', async () => {
    const cap = captureFetch({ candidates: [{ content: { parts: [{ text: '{}' }] } }] });
    const a = new GeminiAdapter({ ...cfg, supportsStreaming: true });
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', stream: false });
    expect(r.streamed).toBe(false);
    expect(cap.url()).toContain(':generateContent?key=');
    expect(cap.url()).not.toContain('alt=sse');
  });

  it('provider 未声明支持流式 → 保持非流式链路', async () => {
    const cap = captureFetch({ candidates: [{ content: { parts: [{ text: '{}' }] } }] });
    const a = new GeminiAdapter(cfg);
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u' });
    expect(r.streamed).toBe(false);
    expect(cap.url()).toContain(':generateContent?key=');
  });

  it('流式 MAX_TOKENS 仍如实上报（截断不得被流式掩盖）', async () => {
    geminiSseFetch([
      gChunk('{"summary":"截断'),
      JSON.stringify({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'MAX_TOKENS' }] }),
    ]);
    const a = new GeminiAdapter({ ...cfg, supportsStreaming: true });
    const r = await a.analyze({ systemPrompt: 's', userPrompt: 'u', jsonMode: true });
    expect(r.finishReason).toBe('MAX_TOKENS');
    expect(r.parsed).toBeUndefined();
    expect(r.parseError).toBeTruthy();
  });

  it('流式链路捕获 provider error 负载', async () => {
    geminiSseFetch([JSON.stringify({ error: { message: 'API key not valid' } })]);
    const a = new GeminiAdapter({ ...cfg, supportsStreaming: true });
    await expect(a.analyze({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow(/API key not valid/);
  });

  it('流式 HTTP 错误抛错并保留状态码', async () => {
    globalThis.fetch = vi.fn(async () => new Response('bad', { status: 403 })) as unknown as typeof fetch;
    const a = new GeminiAdapter({ ...cfg, supportsStreaming: true });
    await expect(a.analyze({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow(/403/);
  });

  it('testConnection 显式走非流式', async () => {
    const cap = captureFetch({ candidates: [{ content: { parts: [{ text: 'pong' }] } }] });
    const a = new GeminiAdapter({ ...cfg, supportsStreaming: true });
    const r = await a.testConnection();
    expect(r.ok).toBe(true);
    expect(cap.url()).toContain(':generateContent?key=');
  });
});
