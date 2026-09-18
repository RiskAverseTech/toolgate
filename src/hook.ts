import type { Answers, Decision, DecisionBackend, HookInput, JSONObject, Policy, Questions } from './types.js';
import { loadPolicy } from './policy.js';
import { decide, message } from './engine.js';
import { writeAudit } from './audit.js';
import { MockBackend } from './backends/mock.js';

/**
 * Loads the AI SDK only when the model is actually consulted. Importing `ai`
 * costs ~600 ms; static rules and passthroughs must not pay it on every call.
 */
class LazyGatewayBackend implements DecisionBackend {
  readonly name: string;
  private inner?: DecisionBackend;
  constructor(private readonly model: string) {
    this.name = `gateway:${model}`;
  }
  async warm(): Promise<void> {
    const { GatewayBackend } = await import('./backends/gateway.js');
    this.inner ??= new GatewayBackend(this.model);
  }
  async evaluate(state: JSONObject, questions: Questions, opts?: { timeoutMs?: number }): Promise<Answers> {
    await this.warm();
    return this.inner!.evaluate(state, questions, opts);
  }
}

export function makeBackend(policy: Policy, override?: string): DecisionBackend {
  const provider = override ?? policy.backend.provider;
  if (provider === 'mock') return new MockBackend();
  if (provider === 'gateway') return new LazyGatewayBackend(policy.backend.model);
  throw new Error(`unknown backend "${provider}" (expected gateway | mock)`);
}

/** Claude Code PreToolUse JSON. Silence (undefined) means "no opinion": the normal permission flow applies. */
export function toHookOutput(decision: Decision): Record<string, unknown> | undefined {
  if (decision.verdict === 'passthrough') return undefined;
  const reason = `[toolgate] ${decision.reason}`;
  return {
    systemMessage: reason, // shown to the user
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.verdict,
      permissionDecisionReason: reason, // shown to the model
    },
  };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Run as a Claude Code PreToolUse hook: JSON in on stdin, decision JSON on stdout.
 * Always exits 0; the decision travels in the JSON. An internal failure (bad
 * stdin, bad policy, bug) becomes a visible `ask`, never a silent allow.
 */
export async function runHook(opts: { policyPath?: string; backend?: string } = {}): Promise<void> {
  process.exitCode = 0;
  let out: Record<string, unknown> | undefined;
  try {
    const input = JSON.parse(await readStdin()) as HookInput;
    if (typeof input?.tool_name !== 'string') throw new Error('stdin is not a PreToolUse payload');
    const policy = loadPolicy(opts.policyPath);
    const backend = makeBackend(policy, opts.backend);
    const decision = await decide(input, policy, backend);
    if (decision.source !== 'no-opinion') writeAudit(policy, input, decision, backend.name);
    if (decision.source === 'fail-mode') process.stderr.write(`toolgate: ${decision.reason}\n`); // never silent
    out = toHookOutput(decision);
  } catch (err) {
    const why = message(err);
    process.stderr.write(`toolgate: ${why}\n`);
    out = toHookOutput({ verdict: 'ask', reason: `internal error (${why}) — confirm manually`, source: 'fail-mode' });
  }
  if (out) process.stdout.write(JSON.stringify(out));
}
