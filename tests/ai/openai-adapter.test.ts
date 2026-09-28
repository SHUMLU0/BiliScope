import { describe, expect, it, vi } from 'vitest';
import { OpenAICompatibleAdapter } from '@ai/openai-adapter';
import type { ProviderConfig } from '@ai/types';

const cfg: ProviderConfig = {
  name: 'openai-compatible',
  baseUrl: 'https://example.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-test',
};

describe('OpenAICompatibleAdapter', () => {
  it('analyze parses JSON-mode response', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    const a = new OpenAICompatibleAdapter(cfg);
    const r = await a.analyze({
      systemPrompt: 's',
      userPrompt: 'u',
      jsonMode: true,
    });
    expect(r.text).toBeTruthy();
    expect((r.parsed as { ok: boolean }).ok).toBe(true);
    expect(r.tokenUsage?.total).toBe(3);
  });

  it('analyze throws on HTTP error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('bad', { status: 401, headers: { 'Content-Type': 'text/plain' } }),
    ) as unknown as typeof fetch;
    const a = new OpenAICompatibleAdapter(cfg);
    await expect(
      a.analyze({ systemPrompt: 's', userPrompt: 'u' }),
    ).rejects.toThrow(/401/);
  });

  it('testConnection returns ok on success', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: 'pong' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    const a = new OpenAICompatibleAdapter(cfg);
    const r = await a.testConnection();
    expect(r.ok).toBe(true);
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
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