import type { Answers, DecisionBackend, JSONObject, Questions } from '../types.js';

/**
 * TypeSafe's direct API (api.typesafe.ai/v1/systemone). No SDK, plain fetch.
 * Boolean questions are "noul" there and take instructions only, so the
 * true/false criteria are folded into the instructions text.
 * Auth: TYPESAFE_API_KEY. One attempt, hard wall-clock budget.
 */
export class TypeSafeBackend implements DecisionBackend {
  readonly name: string;

  constructor(
    private readonly model = 'jev-latest',
    private readonly apiKey = process.env.TYPESAFE_API_KEY,
    private readonly endpoint = 'https://api.typesafe.ai/v1/systemone',
  ) {
    this.name = `typesafe:${model}`;
  }

  async evaluate(state: JSONObject, questions: Questions, opts?: { timeoutMs?: number }): Promise<Answers> {
    if (!this.apiKey) throw new Error('TYPESAFE_API_KEY is not set');
    const timeoutMs = opts?.timeoutMs ?? 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(this.endpoint, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, state, questions: toNoul(questions) }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`TypeSafe API ${res.status}: ${(await res.text()).split('\n')[0]?.slice(0, 160)}`);
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

/** AI-SDK-style boolean questions -> TypeSafe noul questions (criteria folded into instructions). */
export function toNoul(questions: Questions): Record<string, { type: 'noul'; instructions: string }> {
  const out: Record<string, { type: 'noul'; instructions: string }> = {};
  for (const [key, q] of Object.entries(questions)) {
    const c = q.criteria;
    const instructions = c ? `${q.instructions} True when: ${c.true}. False when: ${c.false}.` : q.instructions;
    out[key] = { type: 'noul', instructions };
  }
  return out;
}
