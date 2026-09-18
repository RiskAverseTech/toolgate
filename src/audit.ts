import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Decision, HookInput, Policy } from './types.js';
import { serializeInput } from './state.js';

const MAX_LOGGED_INPUT = 500;

export interface AuditEntry {
  ts: string;
  session_id?: string;
  tool: string;
  input?: string;
  verdict: Decision['verdict'];
  source: Decision['source'];
  rule?: string;
  reason: string;
  probabilities?: Record<string, number>;
  latency_ms?: number;
  backend?: string;
}

export function writeAudit(policy: Policy, input: HookInput, decision: Decision, backendName?: string): void {
  if (!policy.audit.enabled) return;
  try {
    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      session_id: input.session_id,
      tool: input.tool_name,
      ...(policy.audit.log_input ? { input: serializeInput(input.tool_input).slice(0, MAX_LOGGED_INPUT) } : {}),
      verdict: decision.verdict,
      source: decision.source,
      ...(decision.rule ? { rule: decision.rule } : {}),
      reason: decision.reason,
      ...(decision.probabilities ? { probabilities: decision.probabilities } : {}),
      ...(decision.latencyMs !== undefined ? { latency_ms: decision.latencyMs } : {}),
      ...(backendName ? { backend: backendName } : {}),
    };
    mkdirSync(dirname(policy.audit.path), { recursive: true });
    appendFileSync(policy.audit.path, JSON.stringify(entry) + '\n', 'utf8');
  } catch {
    // Auditing must never break the gate.
  }
}
