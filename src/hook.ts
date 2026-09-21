import type { Answers, Decision, DecisionBackend, HookInput, JSONObject, Policy, Questions } from './types.js';
import { loadEnvFile, loadPolicy } from './policy.js';
import { decide, message } from './engine.js';
import { writeAudit } from './audit.js';
import { MockBackend } from './backends/mock.js';
import { recordProposed, settle } from './ledger.js';

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

/** Which real backend `auto` resolves to, from the environment. */
export function resolveProvider(provider: string): 'typesafe' | 'gateway' | 'mock' {
  if (provider !== 'auto') return provider as 'typesafe' | 'gateway' | 'mock';
  if (process.env.TYPESAFE_API_KEY) return 'typesafe';
  if (process.env.AI_GATEWAY_API_KEY) return 'gateway';
  throw new Error('no API key found: set TYPESAFE_API_KEY (console.typesafe.ai) or AI_GATEWAY_API_KEY (vercel.com/<team>/~/ai)');
}

/**
 * A missing key is "decision model unavailable", not an internal error: static rules still
 * run, and the policy's fail_mode decides the rest (passthrough shows "[toolgate] NOT gating").
 */
class UnavailableBackend implements DecisionBackend {
  readonly name = 'unavailable';
  constructor(private readonly why: string) {}
  async warm(): Promise<void> {
    throw new Error(this.why);
  }
  async evaluate(): Promise<Answers> {
    throw new Error(this.why);
  }
}

export function makeBackend(policy: Policy, override?: string): DecisionBackend {
  let provider: string;
  try {
    provider = resolveProvider(override ?? policy.backend.provider);
  } catch (err) {
    return new UnavailableBackend(message(err));
  }
  const model = policy.backend.model === 'auto' ? undefined : policy.backend.model;
  if (provider === 'mock') return new MockBackend();
  if (provider === 'gateway') return new LazyGatewayBackend(model ?? 'typesafe-ai/jev');
  if (provider === 'typesafe') return new LazyTypeSafeBackend(model ?? 'jev-latest');
  throw new Error(`unknown backend "${provider}" (expected auto | typesafe | gateway | mock)`);
}

class LazyTypeSafeBackend implements DecisionBackend {
  readonly name: string;
  private inner?: DecisionBackend;
  constructor(private readonly model: string) {
    this.name = `typesafe:${model}`;
  }
  async warm(): Promise<void> {
    const { TypeSafeBackend } = await import('./backends/typesafe.js');
    this.inner ??= new TypeSafeBackend(this.model);
  }
  async evaluate(state: JSONObject, questions: Questions, opts?: { timeoutMs?: number }): Promise<Answers> {
    await this.warm();
    return this.inner!.evaluate(state, questions, opts);
  }
}

/**
 * Claude Code PreToolUse JSON. Silence (undefined) means "no opinion": the normal
 * permission flow applies. Asks and denies always carry a user-visible systemMessage;
 * allows are quiet unless `show_allows` is on — the hook runs on every gated call, and
 * a line per allowed `ls` is noise.
 */
export function toHookOutput(decision: Decision, opts: { showAllows?: boolean } = {}): Record<string, unknown> | undefined {
  if (decision.verdict === 'passthrough') {
    // No opinion is silent — except when the model was unreachable: a firewall that
    // switches itself off must say so. No permissionDecision, so the normal flow applies.
    return decision.source === 'fail-mode' ? { systemMessage: `[toolgate] NOT gating: ${decision.reason}` } : undefined;
  }
  const reason = `[toolgate] ${decision.reason}`;
  const out: Record<string, unknown> = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.verdict,
      permissionDecisionReason: reason, // fed back to the model on deny; shown in the prompt on ask
    },
  };
  if (decision.verdict !== 'allow' || opts.showAllows) out.systemMessage = reason; // shown to the user
  return out;
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
  loadEnvFile();
  let out: Record<string, unknown> | undefined;
  try {
    const input = JSON.parse(await readStdin()) as HookInput;
    if (typeof input?.tool_name !== 'string') throw new Error('stdin is not a PreToolUse payload');
    const policy = loadPolicy(opts.policyPath);
    const backend = makeBackend(policy, opts.backend);
    const decision = await decide(input, policy, backend);
    if (decision.source !== 'no-opinion') writeAudit(policy, input, decision, backend.name);
    if (decision.source === 'fail-mode') process.stderr.write(`toolgate: ${decision.reason}\n`); // never silent
    // Ledger: a write tool call is PROPOSED here (with what the content could do if executed) and
    // becomes CONFIRMED when PostToolUse arrives for the same tool_use_id (`toolgate post`).
    if (decision.verdict !== 'deny') recordProposed(policy, input, decision.capabilities, decision.capability_probs);
    out = toHookOutput(decision, { showAllows: policy.show_allows });
  } catch (err) {
    const why = message(err);
    process.stderr.write(`toolgate: ${why}\n`);
    out = toHookOutput({ verdict: 'ask', reason: `internal error (${why}) — confirm manually`, source: 'fail-mode' });
  }
  if (out) process.stdout.write(JSON.stringify(out));
}

/**
 * Run as a Claude Code PostToolUse / PostToolUseFailure / PermissionDenied hook: settle the
 * ledger event for this tool_use_id. No model call, no output, always exit 0, never throws —
 * a failure here must not affect the agent, and the ledger is best-effort by design (an
 * unsettled write only ever makes a later execution stricter, never looser).
 */
export async function runPost(opts: { policyPath?: string } = {}): Promise<void> {
  process.exitCode = 0;
  try {
    const input = JSON.parse(await readStdin()) as HookInput & { hook_event_name?: string };
    if (!input?.session_id || !input.tool_use_id) return;
    const status = POST_STATUS[input.hook_event_name ?? ''];
    if (!status) return;
    settle(loadPolicy(opts.policyPath), input.session_id, input.tool_use_id, status);
  } catch {
    // silent by design
  }
}

const POST_STATUS: Record<string, 'confirmed' | 'failed' | 'denied'> = {
  PostToolUse: 'confirmed',
  PostToolUseFailure: 'failed',
  PermissionDenied: 'denied',
};
