import { randomUUID } from 'node:crypto';
import type { Answers, Decision, DecisionBackend, HookInput, JSONObject, Policy, Questions } from './types.js';
import { loadEnvFile, loadPolicy } from './policy.js';
import { decide, message } from './engine.js';
import { writeAudit } from './audit.js';
import { MockBackend } from './backends/mock.js';
import { recordProposed, settle } from './ledger.js';
import { confirmAsked, recordAsked, wasConfirmed } from './confirm.js';

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
export type Provider = 'typesafe' | 'openrouter' | 'gateway' | 'opencode-zen' | 'opencode-go' | 'mock';

/** Key precedence for `auto`: TypeSafe direct, then OpenRouter, then Vercel AI Gateway, then OpenCode Go. */
export const KEY_ENV_VARS = ['TYPESAFE_API_KEY', 'OPENROUTER_API_KEY', 'AI_GATEWAY_API_KEY', 'OPENCODE_API_KEY'] as const;

export function resolveProvider(provider: string): Provider {
  if (provider !== 'auto') return provider as Provider;
  if (process.env.TYPESAFE_API_KEY) return 'typesafe';
  if (process.env.OPENROUTER_API_KEY) return 'openrouter';
  if (process.env.AI_GATEWAY_API_KEY) return 'gateway';
  if (process.env.OPENCODE_API_KEY) return 'opencode-zen';
  throw new Error('no API key found: set TYPESAFE_API_KEY (console.typesafe.ai), OPENROUTER_API_KEY (openrouter.ai/keys) or AI_GATEWAY_API_KEY (vercel.com/<team>/~/ai) or OPENCODE_API_KEY (opencode.ai)');
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
  if (provider === 'openrouter') return new LazyOpenRouterBackend(model ?? 'typesafe/jev-1.13');
  if (provider === 'opencode-zen') return new LazyOpenCodeZenBackend(model ?? 'jev-1.13-free');
  if (provider === 'opencode-go') return new LazyOpenCodeGoBackend(model ?? 'deepseek-v4-flash');
  throw new Error(`unknown backend "${provider}" (expected auto | typesafe | openrouter | gateway | opencode-zen | opencode-go | mock)`);
}

class LazyOpenRouterBackend implements DecisionBackend {
  readonly name: string;
  private inner?: DecisionBackend;
  constructor(private readonly model: string) {
    this.name = `openrouter:${model}`;
  }
  async warm(): Promise<void> {
    const { OpenRouterBackend } = await import('./backends/openrouter.js');
    this.inner ??= new OpenRouterBackend(this.model);
  }
  async evaluate(state: JSONObject, questions: Questions, opts?: { timeoutMs?: number }): Promise<Answers> {
    await this.warm();
    return this.inner!.evaluate(state, questions, opts);
  }
}

/** Jev through OpenCode Zen's TypeSafe-compatible /systemone route: same API as TypeSafe direct, billed to the OpenCode account. */
class LazyOpenCodeZenBackend implements DecisionBackend {
  readonly name: string;
  private inner?: DecisionBackend;
  constructor(private readonly model: string) {
    this.name = `opencode-zen:${model}`;
  }
  async warm(): Promise<void> {
    const { TypeSafeBackend } = await import('./backends/typesafe.js');
    this.inner ??= new TypeSafeBackend(this.model, process.env.OPENCODE_API_KEY, 'https://opencode.ai/zen/v1/systemone', { 'x-opencode-session': randomUUID() }, 'opencode-zen');
  }
  async evaluate(state: JSONObject, questions: Questions, opts?: { timeoutMs?: number }): Promise<Answers> {
    await this.warm();
    return this.inner!.evaluate(state, questions, opts);
  }
}

class LazyOpenCodeGoBackend implements DecisionBackend {
  readonly name: string;
  private inner?: DecisionBackend;
  constructor(private readonly model: string) {
    this.name = `opencode-go:${model}`;
  }
  async warm(): Promise<void> {
    const { OpenCodeGoBackend } = await import('./backends/opencode-go.js');
    this.inner ??= new OpenCodeGoBackend(this.model);
  }
  async evaluate(state: JSONObject, questions: Questions, opts?: { timeoutMs?: number }): Promise<Answers> {
    await this.warm();
    return this.inner!.evaluate(state, questions, opts);
  }
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
    const { decision, policy } = await decideStdin(opts, 'hook');
    out = toHookOutput(decision, { showAllows: policy.show_allows });
  } catch (err) {
    const why = message(err);
    process.stderr.write(`toolgate: ${why}\n`);
    out = toHookOutput({ verdict: 'ask', reason: `internal error (${why}) — confirm manually`, source: 'fail-mode' });
  }
  if (out) process.stdout.write(JSON.stringify(out));
}

/**
 * `toolgate decide`: the same input and side effects as `hook` (audit line, ledger proposal), but
 * the whole Decision as JSON on stdout, always — allow included. For hosts that act on the
 * verdict themselves (the Claude Code mod, other harnesses) rather than reading PreToolUse output.
 * An internal failure is a visible `ask` with `source: fail-mode`, never a silent allow.
 */
export async function runDecide(opts: { policyPath?: string; backend?: string } = {}): Promise<void> {
  process.exitCode = 0;
  loadEnvFile();
  let decision: Decision;
  try {
    decision = (await decideStdin(opts, 'decide')).decision;
  } catch (err) {
    const why = message(err);
    process.stderr.write(`toolgate: ${why}\n`);
    decision = { verdict: 'ask', reason: `internal error (${why}) — confirm manually`, source: 'fail-mode' };
  }
  process.stdout.write(JSON.stringify(decision));
}

/** Read a PreToolUse payload from stdin, decide it, audit it, and propose any write to the ledger. */
async function decideStdin(opts: { policyPath?: string; backend?: string }, defaultHost: string): Promise<{ decision: Decision; policy: Policy }> {
  const input = JSON.parse(await readStdin()) as HookInput;
  if (typeof input?.tool_name !== 'string') throw new Error('stdin is not a PreToolUse payload');
  if (typeof input.host !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(input.host)) input.host = defaultHost;
  const policy = loadPolicy(opts.policyPath);
  const backend = makeBackend(policy, opts.backend);
  const decision = await decide(input, policy, backend, { confirmedEarlier: wasConfirmed(policy, input) });
  if (decision.source !== 'no-opinion') writeAudit(policy, input, decision, backend.name);
  if (decision.source === 'fail-mode') process.stderr.write(`toolgate: ${decision.reason}\n`); // never silent
  // Ledger: a write tool call is PROPOSED here (with what the content could do if executed) and
  // becomes CONFIRMED when PostToolUse arrives for the same tool_use_id (`toolgate post`).
  if (decision.verdict !== 'deny') recordProposed(policy, input, decision.capabilities, decision.capability_probs);
  // Confirmation memory: the model's own ask is remembered; PostToolUse for this tool_use_id confirms it.
  if (decision.verdict === 'ask' && decision.source === 'model') recordAsked(policy, input);
  return { decision, policy };
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
    const policy = loadPolicy(opts.policyPath);
    settle(policy, input.session_id, input.tool_use_id, status);
    if (status === 'confirmed') confirmAsked(policy, input.session_id, input.tool_use_id);
  } catch {
    // silent by design
  }
}

const POST_STATUS: Record<string, 'confirmed' | 'failed' | 'denied'> = {
  PostToolUse: 'confirmed',
  PostToolUseFailure: 'failed',
  PermissionDenied: 'denied',
};
