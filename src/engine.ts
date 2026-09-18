import type { Answers, Decision, DecisionBackend, HookInput, Policy } from './types.js';
import { toolMatcherToRegex } from './policy.js';
import { buildState, serializeInput } from './state.js';

/**
 * Decide what to do with a tool call.
 * Order: gated-tools filter -> static rules (first match wins, free) ->
 * decision model -> thresholds. Backend failure falls back to policy.fail_mode.
 */
export async function decide(input: HookInput, policy: Policy, backend: DecisionBackend): Promise<Decision> {
  // 1. Only gate the tools the policy says to gate.
  if (!toolMatcherToRegex(policy.gated_tools).test(input.tool_name)) {
    return {
      verdict: 'passthrough',
      reason: `Tool "${input.tool_name}" is not gated`,
      source: 'no-opinion',
    };
  }

  // 2. Static fast path — zero model calls.
  const serialized = serializeInput(input.tool_input);
  for (let i = 0; i < policy.rules.length; i++) {
    const rule = policy.rules[i];
    if (!rule) continue;
    const toolOk = rule.match.tool ? toolMatcherToRegex(rule.match.tool).test(input.tool_name) : true;
    const inputOk = rule.match.input_regex ? new RegExp(rule.match.input_regex, 'i').test(serialized) : true;
    if (toolOk && inputOk) {
      return {
        verdict: rule.action,
        reason: rule.reason ?? `Matched static rule #${i + 1}`,
        source: 'static-rule',
        rule: rule.reason ?? `rule-${i + 1}`,
      };
    }
  }

  // 3. Ask the decision model.
  const state = buildState(input, policy.include_task_context);
  const started = Date.now();
  let answers: Answers;
  try {
    answers = await backend.evaluate(state, policy.questions, { timeoutMs: policy.backend.timeout_ms });
  } catch (err) {
    return {
      verdict: policy.fail_mode,
      reason: `Decision model unavailable (${err instanceof Error ? err.message : 'unknown error'}); fail_mode=${policy.fail_mode}`,
      source: 'fail-mode',
    };
  }
  const latencyMs = Date.now() - started;

  // 4. Thresholds over per-question probabilities.
  const probabilities: Record<string, number> = {};
  let worst: { key: string; p: number } = { key: 'none', p: 0 };
  for (const [key, answer] of Object.entries(answers)) {
    if (answer.type !== 'boolean') continue;
    probabilities[key] = round(answer.probability);
    if (answer.probability > worst.p) worst = { key, p: answer.probability };
  }

  if (worst.p >= policy.thresholds.deny) {
    return {
      verdict: 'deny',
      reason: `${describe(worst.key)} risk at ${pct(worst.p)} (>= deny threshold ${pct(policy.thresholds.deny)})`,
      source: 'model',
      probabilities,
      latencyMs,
    };
  }
  if (worst.p >= policy.thresholds.ask) {
    return {
      verdict: 'ask',
      reason: `${describe(worst.key)} risk at ${pct(worst.p)} — confirm before running`,
      source: 'model',
      probabilities,
      latencyMs,
    };
  }
  return {
    verdict: 'allow',
    reason: `All risk probabilities below ${pct(policy.thresholds.ask)} (max: ${describe(worst.key)} at ${pct(worst.p)})`,
    source: 'model',
    probabilities,
    latencyMs,
  };
}

const LABELS: Record<string, string> = {
  destructive: 'Destructive-action',
  exfiltration: 'Data-exfiltration',
  privilege: 'Privilege-escalation',
  off_task: 'Off-task',
};

function describe(key: string): string {
  return LABELS[key] ?? key;
}

function pct(p: number): string {
  return `${Math.round(p * 100)}%`;
}

function round(p: number): number {
  return Math.round(p * 1000) / 1000;
}
