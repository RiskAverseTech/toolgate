import { afterEach, describe, expect, it, vi } from 'vitest';
import { TypeSafeBackend, toNoul } from '../src/backends/typesafe.js';
import { resolveProvider } from '../src/hook.js';

describe('TypeSafe direct backend', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('folds boolean criteria into noul instructions', () => {
    const q = toNoul({ x: { type: 'boolean', instructions: 'Is it bad.', criteria: { true: 'yes', false: 'no' } } });
    expect(q.x).toEqual({ type: 'noul', instructions: 'Is it bad. True when: yes. False when: no.' });
  });

  it('maps noul answers back to boolean probabilities and sends bearer auth', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('jev-latest');
      expect(body.questions.destructive.type).toBe('noul');
      return new Response(JSON.stringify({ model: 'jev-latest', answers: { destructive: { type: 'noul', noul: 0.91 } }, usage: {} }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const b = new TypeSafeBackend('jev-latest', 'k');
    const a = await b.evaluate({ tool: 'Bash' }, { destructive: { type: 'boolean', instructions: 'd' } });
    expect(a.destructive).toEqual({ type: 'boolean', probability: 0.91 });
  });

  it('surfaces HTTP errors and missing keys', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(new TypeSafeBackend('jev-latest', 'k').evaluate({}, { x: { type: 'boolean', instructions: 'x' } })).rejects.toThrow(/401/);
    // Empty string, not undefined: undefined would fall through to the constructor default,
    // which reads TYPESAFE_API_KEY from the developer's own shell.
    await expect(new TypeSafeBackend('jev-latest', '').evaluate({}, { x: { type: 'boolean', instructions: 'x' } })).rejects.toThrow(/TYPESAFE_API_KEY/);
  });

  it('auto resolves typesafe over gateway, and fails loudly with neither', () => {
    const env = { ...process.env };
    process.env.TYPESAFE_API_KEY = 't'; process.env.AI_GATEWAY_API_KEY = 'g';
    expect(resolveProvider('auto')).toBe('typesafe');
    delete process.env.TYPESAFE_API_KEY;
    expect(resolveProvider('auto')).toBe('gateway');
    delete process.env.AI_GATEWAY_API_KEY;
    expect(() => resolveProvider('auto')).toThrow(/no API key/);
    process.env = env;
  });
});
