import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenCodeGoBackend, parseAnswers, toPromptQuestions } from '../src/backends/opencode-go.js';
import { makeBackend, resolveProvider } from '../src/hook.js';
import { defaultPolicy } from '../src/policy.js';

const Q = { destructive: { type: 'boolean' as const, instructions: 'Is it destructive.', criteria: { true: 'deletes', false: 'reads' } }, privilege: { type: 'boolean' as const, instructions: 'Escalates.' } };

describe('OpenCode Go backend', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('folds criteria into the prompt text', () => {
    expect(toPromptQuestions(Q)).toEqual({
      destructive: 'Is it destructive. YES when: deletes. NO when: reads.',
      privilege: 'Escalates.',
    });
  });

  it('posts chat completions with bearer auth and maps the JSON reply to probabilities', async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe('https://opencode.ai/zen/go/v1/chat/completions');
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe('deepseek-v4-flash');
      expect(body.response_format).toEqual({ type: 'json_object' });
      expect(JSON.parse(body.messages[1].content).state.tool).toBe('Bash');
      return new Response(JSON.stringify({ choices: [{ message: { content: '```json\n{"destructive":0.92,"privilege":0.03}\n```' } }] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const b = new OpenCodeGoBackend('deepseek-v4-flash', 'k');
    expect(b.name).toBe('opencode-go:deepseek-v4-flash');
    expect(await b.evaluate({ tool: 'Bash' }, Q)).toEqual({
      destructive: { type: 'boolean', probability: 0.92 },
      privilege: { type: 'boolean', probability: 0.03 },
    });
  });

  it('drops out-of-range and non-numeric values, and rejects non-JSON', () => {
    expect(parseAnswers('{"destructive":1.5,"privilege":"high"}', Q)).toEqual({});
    expect(() => parseAnswers('nope', Q)).toThrow('not JSON');
    expect(() => parseAnswers(undefined, Q)).toThrow('empty');
  });

  it('surfaces HTTP errors and a missing key', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    await expect(new OpenCodeGoBackend('m', 'k').evaluate({}, Q)).rejects.toThrow('OpenCode Go API 401');
    await expect(new OpenCodeGoBackend('m', '').evaluate({}, Q)).rejects.toThrow('OPENCODE_API_KEY is not set');
  });

  it('auto resolves opencode-go last, and the explicit provider builds a backend', () => {
    const saved = { ...process.env };
    for (const k of ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY']) delete process.env[k];
    process.env.OPENCODE_API_KEY = 'k';
    expect(resolveProvider('auto')).toBe('opencode-zen');
    process.env.AI_GATEWAY_API_KEY = 'g';
    expect(resolveProvider('auto')).toBe('gateway');
    expect(makeBackend(defaultPolicy(), 'opencode-go').name).toBe('opencode-go:deepseek-v4-flash');
    process.env = saved;
  });
});
