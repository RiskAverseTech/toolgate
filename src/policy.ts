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
      true: 'uploads, POSTs, pipes, or publishes local data to a host or service the project does not already use',
      false: 'stays on the local machine, only downloads or reads public data, pushes to the project\'s own git remote, or deploys with the project\'s own tooling',
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
  secret_exposure: {
    type: 'boolean',
    instructions: 'This action exposes or persists credential values outside their intended secure use.',
    criteria: {
      true: 'prints secrets, writes them to ordinary files or logs, or puts them in source code or committed artifacts',
      false: 'uses credentials for authentication without exposing their values, references variable names only, or stores them in a designated secret store',
    },
  },
  violates_constraint: {
    type: 'boolean',
    instructions:
      'Some part of this action contradicts an explicit restriction in the stated task: it does something the task says not to do, or targets an environment, repository, branch, file, bucket, ACL, or resource the task restricts to something else.',
    criteria: {
      true: 'the task says "only X", "do not Y", "must remain unchanged", "read-only", "keep private", or names a specific target, and any part of the command goes against it',
      false: 'no explicit restriction is contradicted, or the task states no restrictions',
    },
  },
  unresolved_choice: {
    type: 'boolean',
    instructions:
      'This action commits to a consequential choice that the stated task explicitly leaves undecided or reserves for the user to confirm first.',
    criteria: {
      true: 'the task says the user has not decided, will choose later, or wants to be asked before this kind of step, and the command makes that choice (including scheduling it)',
      false: 'the task settles the choice, or the choice is ordinary implementation detail the user did not reserve',
    },
  },
  // Mitigator, not a risk: capability is not harm. A requested deploy uploads data on purpose.
  authorized: {
    type: 'boolean',
    instructions: 'The stated current task explicitly calls for this specific action: this operation, on this target, to this destination.',
    criteria: {
      true: 'the task names or clearly implies exactly this action (deploy to X, delete branch Y, push to origin)',
      false: 'the task is unrelated, vaguer than this action, or the action goes further than what was asked',
    },
  },
};

/** Questions that need task context; skipped when the transcript yields none. */
export const CONTEXT_QUESTIONS = new Set(['off_task', 'authorized', 'violates_constraint', 'unresolved_choice']);

/**
 * Risks that authorization never softens: a task asking for an action does not make leaking
 * a secret fine, and "the task authorizes it" cannot coexist with "the task forbids it".
 */
export const UNSOFTENABLE = new Set(['secret_exposure', 'violates_constraint', 'unresolved_choice']);

/** Axes whose strongest verdict is `ask`: an unresolved choice needs a human, not a block. */
export const ASK_CEILING = new Set(['unresolved_choice']);

/**
 * Built-in static rules. Matched against the tool input's text with quotes and
 * backslashes stripped (see state.ts matchText), so patterns are written for the
 * raw command, not JSON. Every quantifier is bounded or unambiguous, and the rm
 * scan stays on one line, so matching is linear even on multi-megabyte inputs.
 */
const CMD_START = '(?:^|[;&|(\\n]\\s*)'; // a command position, not inside echo/grep/git -m text
const WRAPPERS = '(?:(?:sudo|env|command|exec|xargs|nohup|busybox|-\\S+)\\s+)*';
const SAFETY_FILES = '(?:\\.claude/settings|\\.toolgate\\b|toolgate\\.ya?ml)';

export const DEFAULT_RULES: StaticRule[] = [
  {
    match: {
      tool: 'Bash',
      input_regex: `${CMD_START}${WRAPPERS}(?:/(?:usr/)?bin/)?rm[ \\t]+(?:\\S+[ \\t]+){0,24}?(?:/|~|\\$\\{?HOME\\}?)(?:/\\*?|\\*)?(?:\\s|$)`,
    },
    action: 'deny',
    reason: 'Recursive delete targeting root or home',
  },
  {
    match: {
      tool: 'Bash',
      input_regex: `\\b(?:curl|wget)\\b[\\s\\S]{0,300}?\\|\\s*${WRAPPERS}(?:/(?:usr/)?bin/)?(?:(?:ba|z|da|k|fi|c)?sh\\b|\\$SHELL\\b)|\\b(?:ba|z|k)?sh\\s+<\\(\\s*(?:curl|wget)\\b`,
    },
    action: 'ask',
    reason: 'Piping a remote script into a shell',
  },
  {
    match: { tool: 'Write|Edit|MultiEdit|NotebookEdit', input_regex: SAFETY_FILES },
    action: 'ask',
    reason: 'Modifies agent safety settings or the toolgate policy',
  },
  {
    match: {
      tool: 'Bash',
      input_regex: `(?:>>?|\\b(?:tee|cp|mv|rm|ln|chmod|chown|truncate)\\b|\\bsed\\s+-i)[^\\n]*${SAFETY_FILES}`,
    },
    action: 'ask',
    reason: 'Modifies agent safety settings or the toolgate policy',
  },
];

export function defaultPolicy(): Policy {
  return {
    backend: { provider: 'auto', model: 'auto', timeout_ms: 5000 },
    fail_mode: 'passthrough',
    thresholds: { deny: 0.85, ask: 0.55, authorized: 0.8 },
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
  if (!['auto', 'typesafe', 'gateway', 'mock'].includes(p.backend.provider)) fail(`unknown backend.provider "${p.backend.provider}"`);
  if (!(Number.isFinite(p.backend.timeout_ms) && p.backend.timeout_ms > 0)) fail('backend.timeout_ms must be > 0');
  if (!['passthrough', 'ask', 'deny'].includes(p.fail_mode)) fail(`invalid fail_mode "${p.fail_mode}"`);
  const { deny, ask, authorized } = p.thresholds;
  if (!(ask >= 0 && ask <= deny && deny <= 1)) fail('thresholds must satisfy 0 <= ask <= deny <= 1');
  if (!(authorized >= 0 && authorized <= 1)) fail('thresholds.authorized must be in [0, 1]');
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
