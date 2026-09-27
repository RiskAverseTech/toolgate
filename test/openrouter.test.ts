import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenRouterBackend, toNoulStructured } from '../src/backends/openrouter.js';
import { makeBackend, resolveProvider } from '../src/hook.js';
import { defaultPolicy, loadPolicy } from '../src/policy.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('OpenRouter Decisions backend', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps boolean criteria structured (OpenRouter accepts them natively)', () => {
    const q = toNoulStructured({
      a: { type: 'boolean', instructions: 'Is it bad.', criteria: { true: 'yes', false: 'no' } },
      b: { type: 'boolean', instructions: 'No criteria.' },
    });
    expect(q.a).toEqual({ type: 'noul', instructions: 'Is it bad.', criteria: { true: 'yes', false: 'no' } });
    expect(q.b).toEqual({ type: 'noul', instructions: 'No criteria.' });
  });

  it('posts to the decisions endpoint with bearer auth and maps noul answers back', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://openrouter.ai/api/alpha/decisions');
      const h = init.headers as Record<string, string>;
      expect(h.authorization).toBe('Bearer k');
      expect(h['x-title']).toBe('toolgate');
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('typesafe/jev-1.13');
      expect(body.state.tool).toBe('Bash');
      expect(body.questions.destructive.type).toBe('noul');
      return new Response(
        JSON.stringify({ id: 'gen-dec-1', model: 'typesafe/jev-1.13-20260917', provider: 'TypeSafe', answers: { destructive: { type: 'noul', noul: 0.88 } }, usage: { cost: 0.00002 } }),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    const b = new OpenRouterBackend('typesafe/jev-1.13', 'k');
    expect(b.name).toBe('openrouter:typesafe/jev-1.13');
    const a = await b.evaluate({ tool: 'Bash' }, { destructive: { type: 'boolean', instructions: 'd' } });
    expect(a.destructive).toEqual({ type: 'boolean', probability: 0.88 });
  });

  it('ignores answers for questions it did not ask and skips non-numeric ones', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ answers: { x: { type: 'noul', noul: 0.2 }, extra: { type: 'noul', noul: 0.9 }, y: { type: 'noul' } } }), { status: 200 })));
    const a = await new OpenRouterBackend('typesafe/jev-1.13', 'k').evaluate({}, { x: { type: 'boolean', instructions: 'x' }, y: { type: 'boolean', instructions: 'y' } });
    expect(a).toEqual({ x: { type: 'boolean', probability: 0.2 } });
  });

  it('surfaces HTTP errors, missing keys, and the wall-clock budget', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"bad key"}', { status: 401 })));
    await expect(new OpenRouterBackend('typesafe/jev-1.13', 'k').evaluate({}, { x: { type: 'boolean', instructions: 'x' } })).rejects.toThrow(/OpenRouter API 401/);
    // Empty string, not undefined: undefined would read OPENROUTER_API_KEY from the developer's shell.
    await expect(new OpenRouterBackend('typesafe/jev-1.13', '').evaluate({}, { x: { type: 'boolean', instructions: 'x' } })).rejects.toThrow(/OPENROUTER_API_KEY/);
    vi.stubGlobal('fetch', vi.fn((_u: string, init: RequestInit) => new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(new Error('aborted')))) as Promise<Response>));
    await expect(new OpenRouterBackend('typesafe/jev-1.13', 'k').evaluate({}, { x: { type: 'boolean', instructions: 'x' } }, { timeoutMs: 20 })).rejects.toThrow(/timed out after 20ms/);
  });

  it('auto resolves typesafe > openrouter > gateway', () => {
    const env = { ...process.env };
    process.env.TYPESAFE_API_KEY = 't'; process.env.OPENROUTER_API_KEY = 'o'; process.env.AI_GATEWAY_API_KEY = 'g';
    expect(resolveProvider('auto')).toBe('typesafe');
    delete process.env.TYPESAFE_API_KEY;
    expect(resolveProvider('auto')).toBe('openrouter');
    delete process.env.OPENROUTER_API_KEY;
    expect(resolveProvider('auto')).toBe('gateway');
    delete process.env.AI_GATEWAY_API_KEY;
    expect(() => resolveProvider('auto')).toThrow(/OPENROUTER_API_KEY/);
    process.env = env;
  });

  it('is a valid policy provider and makeBackend picks the default model lazily', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tg-or-')), 'toolgate.yaml');
    writeFileSync(path, 'backend:\n  provider: openrouter\n');
    const p = loadPolicy(path);
    expect(p.backend.provider).toBe('openrouter');
    expect(makeBackend(p).name).toBe('openrouter:typesafe/jev-1.13');
    const custom = defaultPolicy();
    custom.backend = { provider: 'openrouter', model: '~typesafe/jev-latest', timeout_ms: 5000 };
    expect(makeBackend(custom).name).toBe('openrouter:~typesafe/jev-latest');
  });
});
