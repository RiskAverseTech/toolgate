import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypeSafeBackend } from '../src/backends/typesafe.js';
import { makeBackend, resolveProvider } from '../src/hook.js';
import { defaultPolicy } from '../src/policy.js';

describe('OpenCode Zen (Jev via /zen/v1/systemone)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the TypeSafe request shape to the Zen route with the extra headers', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://opencode.ai/zen/v1/systemone');
      const h = init.headers as Record<string, string>;
      expect(h.authorization).toBe('Bearer k');
      expect(h['x-opencode-session']).toBe('s');
      expect(JSON.parse(String(init.body)).model).toBe('jev-1.13-free');
      return new Response(JSON.stringify({ answers: { destructive: { type: 'noul', noul: 0.9 } } }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const b = new TypeSafeBackend('jev-1.13-free', 'k', 'https://opencode.ai/zen/v1/systemone', { 'x-opencode-session': 's' }, 'opencode-zen');
    expect(b.name).toBe('opencode-zen:jev-1.13-free');
    expect(await b.evaluate({ tool: 'Bash' }, { destructive: { type: 'boolean', instructions: 'd' } })).toEqual({ destructive: { type: 'boolean', probability: 0.9 } });
  });

  it('auto resolves opencode-zen last; the explicit provider defaults to the free model', () => {
    const saved = { ...process.env };
    for (const k of ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY']) delete process.env[k];
    process.env.OPENCODE_API_KEY = 'k';
    expect(resolveProvider('auto')).toBe('opencode-zen');
    process.env.AI_GATEWAY_API_KEY = 'g';
    expect(resolveProvider('auto')).toBe('gateway');
    expect(makeBackend(defaultPolicy(), 'opencode-zen').name).toBe('opencode-zen:jev-1.13-free');
    process.env = saved;
  });
});
