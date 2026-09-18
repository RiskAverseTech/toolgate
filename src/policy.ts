import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import YAML from 'yaml';
import type { Policy, Questions, StaticRule } from './types.js';

export const DEFAULT_QUESTIONS: Questions = {
  destructive: {
    type: 'boolean',
    instructions: 'This tool call irreversibly destroys or overwrites data, files, branches, or infrastructure.',
    criteria: {
      true: 'deletes or overwrites files or branches, drops data, force-pushes, kills processes, or changes state that cannot be trivially undone',
      false: 'read-only, or easy to revert (editing a tracked file, creating a new file)',
    },
  },
  exfiltration: {
    type: 'boolean',
    instructions: 'This tool call sends local file contents, credentials, or environment variables to a network destination.',
    criteria: {
      true: 'uploads, POSTs, pipes, or publishes local data to a network host or third-party service',
      false: 'stays on the local machine, or only downloads or reads public data',
    },
  },
  privilege: {
    type: 'boolean',
    instructions: 'This tool call escalates privileges or modifies system configuration, credentials, or security settings.',
    criteria: {
      true: 'sudo/root operations, editing shell profiles or system config, broad permission changes, writing to credential stores or agent safety settings',
      false: 'ordinary user-level operations inside the project',
    },
  },
  off_task: {
    type: 'boolean',
    instructions: 'This tool call is outside the scope of the stated current task.',
    criteria: {
      true: 'touches unrelated systems, directories, or services that the task gives no reason to touch',
      false: 'plausibly in service of the task',
    },
  },
};

/**
 * Built-in static rules. Matched against the tool input's VALUES with quotes and
 * backslashes stripped (see state.ts matchText), so patterns are written for the
 * raw command, not JSON. All patterns avoid nested quantifiers (no ReDoS).
 */
export const DEFAULT_RULES: StaticRule[] = [
  {
    match: {
      tool: 'Bash',
      input_regex: '\\brm\\s+(?:-\\S+\\s+)*(?:/|~|\\$\\{?HOME\\}?)(?:/\\*?|\\*)?(?:\\s|$)',
    },
    action: 'deny',
    reason: 'Recursive delete targeting root or home',
  },
  {
    match: {
      tool: 'Bash',
      input_regex: '\\b(?:curl|wget)\\b[^|]*\\|\\s*(?:sudo\\s+)?(?:/usr/bin/|/bin/)?(?:ba|z|da)?sh\\b|\\b(?:ba)?sh\\s+<\\(\\s*(?:curl|wget)\\b',
    },
    action: 'ask',
    reason: 'Piping a remote script into a shell',
  },
  {
    match: {
      tool: 'Bash|Write|Edit|MultiEdit|NotebookEdit',
      input_regex: '\\.claude/settings|\\.toolgate\\b|toolgate\\.ya?ml',
    },
    action: 'ask',
    reason: 'Modifies agent safety settings or the toolgate policy',
  },
];

export function defaultPolicy(): Policy {
  return {
    backend: { provider: 'gateway', model: 'typesafe-ai/jev', timeout_ms: 2500 },
    fail_mode: 'passthrough',
    thresholds: { deny: 0.85, ask: 0.55 },
    rules: [...DEFAULT_RULES],
    gated_tools: 'Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|mcp__.*',
    include_task_context: true,
    audit: { enabled: true, path: join(homedir(), '.toolgate', 'audit.jsonl'), log_input: true },
    questions: { ...DEFAULT_QUESTIONS },
  };
}

/**
 * Policy lives in ONE trusted place: an explicit path, $TOOLGATE_POLICY, or
 * ~/.toolgate/toolgate.yaml. Deliberately no per-project discovery — a cloned
 * repo must never be able to reconfigure the firewall.
 */
export function policyPath(explicit?: string): string {
  return expandTilde(explicit ?? process.env.TOOLGATE_POLICY ?? join(homedir(), '.toolgate', 'toolgate.yaml'));
}

export function loadPolicy(explicit?: string): Policy {
  const base = defaultPolicy();
  const path = policyPath(explicit);
  if (!existsSync(path)) return base;
  const raw = YAML.parse(readFileSync(path, 'utf8'));
  if (raw === null || raw === undefined) return base;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`toolgate: ${path} must be a YAML mapping`);
  return mergePolicy(base, raw as Record<string, unknown>);
}

function mergePolicy(base: Policy, user: Record<string, unknown>): Policy {
  const merged: Policy = {
    backend: { ...base.backend, ...obj(user.backend) },
    fail_mode: (user.fail_mode as Policy['fail_mode']) ?? base.fail_mode,
    thresholds: { ...base.thresholds, ...obj(user.thresholds) },
    // User rules run first (higher priority); built-ins stay as the floor.
    rules: [...(Array.isArray(user.rules) ? (user.rules as StaticRule[]) : []), ...base.rules],
    gated_tools: (user.gated_tools as string) ?? base.gated_tools,
    include_task_context: (user.include_task_context as boolean) ?? base.include_task_context,
    audit: { ...base.audit, ...obj(user.audit) },
    questions: { ...base.questions, ...(obj(user.questions) as Questions) },
  };
  merged.audit.path = expandTilde(String(merged.audit.path));
  validatePolicy(merged);
  return merged;
}

export function validatePolicy(p: Policy): void {
  const fail = (msg: string): never => {
    throw new Error(`toolgate policy: ${msg}`);
  };
  if (!['gateway', 'mock'].includes(p.backend.provider)) fail(`unknown backend.provider "${p.backend.provider}"`);
  if (!(Number.isFinite(p.backend.timeout_ms) && p.backend.timeout_ms > 0)) fail('backend.timeout_ms must be > 0');
  if (!['passthrough', 'ask', 'deny'].includes(p.fail_mode)) fail(`invalid fail_mode "${p.fail_mode}"`);
  const { deny, ask } = p.thresholds;
  if (!(ask >= 0 && ask <= deny && deny <= 1)) fail('thresholds must satisfy 0 <= ask <= deny <= 1');
  if (typeof p.gated_tools !== 'string' || !p.gated_tools) fail('gated_tools must be a non-empty string');
  toolMatcherToRegex(p.gated_tools);
  for (const [i, rule] of p.rules.entries()) {
    if (!rule || typeof rule.match !== 'object' || rule.match === null) fail(`rule #${i + 1} needs a match block`);
    if (!['allow', 'ask', 'deny'].includes(rule.action)) fail(`rule #${i + 1} has invalid action "${String(rule.action)}"`);
    if (rule.match.input_regex !== undefined) new RegExp(rule.match.input_regex);
    if (rule.match.tool !== undefined) toolMatcherToRegex(rule.match.tool);
  }
  for (const [key, q] of Object.entries(p.questions)) {
    if (!q || q.type !== 'boolean' || typeof q.instructions !== 'string') {
      fail(`question "${key}" must be { type: boolean, instructions: string }`);
    }
  }
}

/** Claude Code-style tool matcher: exact name, pipe/comma list, or regex. Always anchored to the whole name. */
export function toolMatcherToRegex(matcher: string): RegExp {
  if (typeof matcher !== 'string') throw new Error('toolgate: tool matcher must be a string');
  if (matcher === '*' || matcher === '') return /^.*$/;
  if (/^[\w\s|,-]+$/.test(matcher)) {
    const names = matcher
      .split(/[|,]/)
      .map((s) => s.trim())
      .filter(Boolean);
    return new RegExp(`^(?:${names.join('|')})$`);
  }
  return new RegExp(`^(?:${matcher})$`);
}

export function expandTilde(p: string): string {
  return p === '~' || p.startsWith('~/') ? join(homedir(), p.slice(1)) : p;
}

function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
