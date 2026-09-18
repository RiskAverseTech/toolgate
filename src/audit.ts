import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Decision, HookInput, Policy } from './types.js';
import { matchText, redact } from './state.js';

const MAX_LOGGED_INPUT = 500;
/** Append one JSONL line per decision. Owner-only file; secrets redacted; never throws. */
export function writeAudit(policy: Policy, input: HookInput, decision: Decision, backend: string): void {
  if (!policy.audit.enabled) return;
  try {
    const entry = {
      ts: new Date().toISOString(),
      session_id: input.session_id,
      agent_type: input.agent_type,
      tool: input.tool_name,
      input: policy.audit.log_input ? redact(matchText(input.tool_input).slice(0, MAX_LOGGED_INPUT)) : undefined,
      verdict: decision.verdict,
      source: decision.source,
      reason: decision.reason,
      probabilities: decision.probabilities,
      latency_ms: decision.latencyMs,
      setup_ms: decision.setupMs,
      backend,
    };
    const dir = dirname(policy.audit.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700); // mkdir's mode is ignored for a pre-existing directory
    appendFileSync(policy.audit.path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {
    // Auditing must never break the gate.
  }
}
