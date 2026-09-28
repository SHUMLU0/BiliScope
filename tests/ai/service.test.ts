import { describe, expect, it, vi } from 'vitest';
import { aiAnalyze, aiTestConnection } from '@ai/service';
import { setProviderConfig } from '@ai/settings';

// 直接设置 localStorage 以绕过 chrome.storage mock
function saveCfg(): void {
  localStorage.setItem(
    'biliscope.ai.providers.v1',
    JSON.stringify({
      activeProvider: 'openai-compatible',
      providers: {
        'openai-compatible': {
          name: 'openai-compatible',
          baseUrl: 'https://example.com/v1',
          apiKey: 'sk-test',
          model: 'm-test',
        },
      },
    }),
  );
}

describe('ai service', () => {
  it('throws when no provider', async () => {
    localStorage.clear();
    await expect(
      aiAnalyze({ type: 'creator', targetId: 'x', request: { systemPrompt: 's', userPrompt: 'u' } }),
    ).rejects.toThrow(/No active/);
  });

  it('testConnection calls adapter', async () => {
    saveCfg();
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const r = await aiTestConnection();
    expect(r.ok).toBe(true);
  });

  it('aiAnalyze writes AIAnalysis row', async () => {
    saveCfg();
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify({ ok: 1 }) } }],
          usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    const r = await aiAnalyze({
      type: 'creator',
      targetId: 'cr_test',
      request: { systemPrompt: 's', userPrompt: 'u', jsonMode: true },
    });
    expect(r.analysis.tokenUsage?.total).toBe(3);
    expect(r.analysis.provider).toBe('openai-compatible');
    expect(r.analysis.targetId).toBe('cr_test');
  });

  it('setProviderConfig persists', async () => {
    await setProviderConfig('deepseek', {
      name: 'deepseek',
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'sk-ds',
      model: 'deepseek-chat',
    });
    const raw = localStorage.getItem('biliscope.ai.providers.v1');
    expect(raw).toContain('deepseek');
  });
});