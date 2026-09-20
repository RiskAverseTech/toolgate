import { appendFileSync, chmodSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Decision, HookInput, Policy } from './types.js';
import { matchText, redactedInputText } from './state.js';

const MAX_LOGGED_INPUT = 500;
const MAX_LOGGED_TASK = 160;

/** toolgate's own version, stamped on every audit line so a "single-version log" is verifiable from the log itself. */
export const TOOLGATE_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();

function truncatedInput(d: Decision): boolean {
  const t = d.state?.tool_input;
  return typeof t === 'object' && t !== null && !Array.isArray(t) && t._truncated === true;
}

function taskSummary(d: Decision, logText: boolean): Record<string, unknown> | undefined {
  if (!d.state) return undefined;
  const task = d.state.current_task;
  if (typeof task !== 'string') return { present: false };
  const earlier = Array.isArray(d.state.earlier_prompts) ? d.state.earlier_prompts.length : 0;
  return {
    present: true,
    chars: task.length,
    truncated: d.state.current_task_truncated === true || undefined,
    earlier_prompts: earlier || undefined,
    head: logText ? task.slice(0, MAX_LOGGED_TASK) : undefined, // already redacted in state
  };
}
/** Append one JSONL line per decision. Owner-only file; secrets redacted; never throws. */
export function writeAudit(policy: Policy, input: HookInput, decision: Decision, backend: string, extra: Record<string, unknown> = {}): void {
  if (!policy.audit.enabled) return;
  try {
    const entry = {
      ...extra, // transport-specific fields (e.g. mcp_server, trusted_tool) — never override the core ones below
      ts: new Date().toISOString(),
      toolgate_version: TOOLGATE_VERSION,
      session_id: input.session_id,
      agent_type: input.agent_type,
      permission_mode: input.permission_mode,
      tool: input.tool_name,
      // Same redaction path as the model state (key-aware, then text patterns), then flattened and cut.
      input: policy.audit.log_input ? redactedInputText(input.tool_input).slice(0, MAX_LOGGED_INPUT) : undefined,
      input_chars: matchText(input.tool_input).length,
      input_truncated: truncatedInput(decision) || undefined,
      // What the model was told the task was — the key to diagnosing off_task and authorized.
      task: taskSummary(decision, policy.audit.log_input),
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
