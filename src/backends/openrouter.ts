import type { Answers, DecisionBackend, JSONObject, Questions } from '../types.js';

/**
 * Jev via OpenRouter's Decisions API (openrouter.ai/api/alpha/decisions). Same question
 * language as TypeSafe's own API (boolean = "noul"), but criteria are sent structured
 * rather than folded into the instructions. Auth: OPENROUTER_API_KEY — the key never
 * reaches TypeSafe. One attempt, hard wall-clock budget: this sits on the agent's hot path.
 */
export class OpenRouterBackend implements DecisionBackend {
  readonly name: string;

  constructor(
    private readonly model = 'typesafe/jev-1.13',
    private readonly apiKey = process.env.OPENROUTER_API_KEY,
    private readonly endpoint = 'https://openrouter.ai/api/alpha/decisions',
  ) {
    this.name = `openrouter:${model}`;
  }

  async evaluate(state: JSONObject, questions: Questions, opts?: { timeoutMs?: number }): Promise<Answers> {
    if (!this.apiKey) throw new Error('OPENROUTER_API_KEY is not set');
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          // OpenRouter's optional app attribution headers; identify the tool, never the user.
          'http-referer': 'https://github.com/RiskAverseTech/toolgate',
          'x-title': 'toolgate',
        },
        body: JSON.stringify({ model: this.model, state, questions: toNoulStructured(questions) }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`OpenRouter API ${res.status}: ${(await res.text()).split('\n')[0]?.slice(0, 160)}`);
      const body = (await res.json()) as { answers?: Record<string, { type?: string; noul?: number }> };
      const answers: Answers = {};
      for (const key of Object.keys(questions)) {
        const a = body.answers?.[key];
        if (typeof a?.noul === 'number') answers[key] = { type: 'boolean', probability: a.noul };
      }
      return answers;
    } catch (err) {
      if (controller.signal.aborted) throw new Error(`timed out after ${timeoutMs}ms`);
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Boolean questions -> OpenRouter noul questions, criteria kept structured when present. */
export function toNoulStructured(
  questions: Questions,
): Record<string, { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }> {
  const out: Record<string, { type: 'noul'; instructions: string; criteria?: { true: string; false: string } }> = {};
  for (const [key, q] of Object.entries(questions)) {
    out[key] = q.criteria
      ? { type: 'noul', instructions: q.instructions, criteria: { true: q.criteria.true, false: q.criteria.false } }
      : { type: 'noul', instructions: q.instructions };
  }
  return out;
}
