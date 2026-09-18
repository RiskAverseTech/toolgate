import { appendFileSync, chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Decision, HookInput, Policy } from './types.js';
import { matchText } from './state.js';

const MAX_LOGGED_INPUT = 500;
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*[=:]\s*)\S+/gi, '$1[redacted]'],
  [/(\bauthorization\s*:\s*)\S+(?:\s+\S+)?/gi, '$1[redacted]'],
  [/(--?(?:password|passwd|token|api-?key|secret)[=\s]+)\S+/gi, '$1[redacted]'],
  [/\b(?:gh[pousr]_|sk-|xox[baprs]-|AKIA)[A-Za-z0-9_-]{12,}/g, '[redacted]'],
];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((t, [re, sub]) => t.replace(re, sub), text);
}

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
