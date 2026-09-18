import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Decision, HookInput, Policy } from './types.js';
import { matchText } from './state.js';

const MAX_LOGGED_INPUT = 500;
const SECRET = /\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTHORIZATION)[A-Z0-9_]*\s*[=:]\s*)\S+/gi;

/** Append one JSONL line per decision. Owner-only file; secrets redacted; never throws. */
export function writeAudit(policy: Policy, input: HookInput, decision: Decision, backend: string): void {
  if (!policy.audit.enabled) return;
  try {
    const entry = {
      ts: new Date().toISOString(),
      session_id: input.session_id,
      agent_type: input.agent_type,
      tool: input.tool_name,
      input: policy.audit.log_input
        ? matchText(input.tool_input).slice(0, MAX_LOGGED_INPUT).replace(SECRET, '$1[redacted]')
        : undefined,
      verdict: decision.verdict,
      source: decision.source,
      reason: decision.reason,
      probabilities: decision.probabilities,
      latency_ms: decision.latencyMs,
      backend,
    };
    mkdirSync(dirname(policy.audit.path), { recursive: true, mode: 0o700 });
    appendFileSync(policy.audit.path, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch {
    // Auditing must never break the gate.
  }
}
