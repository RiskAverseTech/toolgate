import { experimental_evaluate as evaluate } from 'ai';
import type { Answers, DecisionBackend, Questions } from '../types.js';

/**
 * Jev (or any evaluation-capable model) via Vercel AI Gateway, using the
 * AI SDK 7 evaluation modality. Auth: AI_GATEWAY_API_KEY (or OIDC on Vercel).
 */
export class GatewayBackend implements DecisionBackend {
  readonly name: string;
  private readonly model: string;

  constructor(model = 'typesafe-ai/jev') {
    this.model = model;
    this.name = `gateway:${model}`;
  }

  async evaluate(state: unknown, questions: Questions, opts?: { timeoutMs?: number }): Promise<Answers> {
    const controller = new AbortController();
    const timeout = opts?.timeoutMs ?? 2500;
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const result = await evaluate({
        model: this.model,
        state: state as never,
        questions: questions as never,
        abortSignal: controller.signal,
      } as never);
      return (result as { answers: Answers }).answers;
    } finally {
      clearTimeout(timer);
    }
  }
}
