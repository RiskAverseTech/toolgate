import type { Decision, DecisionBackend, HookInput, Policy } from './types.js';
import { loadPolicy } from './policy.js';
import { decide } from './engine.js';
import { writeAudit } from './audit.js';
import { GatewayBackend } from './backends/gateway.js';
import { MockBackend } from './backends/mock.js';

export function makeBackend(policy: Policy, override?: string): DecisionBackend {
  const provider = override ?? policy.backend.provider;
  if (provider === 'mock') return new MockBackend();
  return new GatewayBackend(policy.backend.model);
}

/** Claude Code PreToolUse JSON output. */
export function toHookOutput(decision: Decision): Record<string, unknown> | undefined {
  if (decision.verdict === 'passthrough') return undefined; // no opinion -> normal permission flow
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision.verdict,
      permissionDecisionReason: `[toolgate] ${decision.reason}`,
    },
  };
}

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Run as a Claude Code PreToolUse hook: JSON in on stdin, decision JSON on stdout.
 * Always exits 0 — the decision travels in the JSON, and any internal failure
 * degrades to the policy's fail_mode rather than breaking the agent.
 */
export async function runHook(opts: { policyPath?: string; backend?: string } = {}): Promise<void> {
  let policy: Policy | undefined;
  let input: HookInput | undefined;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw) as HookInput;
    policy = loadPolicy(opts.policyPath, input.cwd);
    const backend = makeBackend(policy, opts.backend);
    const decision = await decide(input, policy, backend);
    writeAudit(policy, input, decision, backend.name);
    const out = toHookOutput(decision);
    if (out) process.stdout.write(JSON.stringify(out));
    process.exit(0);
  } catch (err) {
    const failMode = policy?.fail_mode ?? 'passthrough';
    if (failMode !== 'passthrough') {
      process.stdout.write(
        JSON.stringify(
          toHookOutput({
            verdict: failMode,
            reason: `toolgate internal error (${err instanceof Error ? err.message : 'unknown'}); fail_mode=${failMode}`,
            source: 'fail-mode',
          }),
        ),
      );
    }
    process.exit(0); // never hard-fail the agent from inside the gate
  }
}
