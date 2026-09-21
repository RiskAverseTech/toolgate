import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { ArtifactCapabilities, CompositionFacts, HookInput, LedgerEvent, Policy } from './types.js';
import { WRITE_TOOLS } from './policy.js';

/**
 * The action ledger: what this session wrote, and what each artifact could do if executed.
 *
 * One-shot scoring cannot see "write a helper, then run it". The ledger closes that for the
 * write → execute case: a write tool call is recorded as PROPOSED at PreToolUse (with the
 * capability answers the model gave for the content), becomes CONFIRMED when Claude Code's
 * PostToolUse fires for the same tool_use_id (FAILED / DENIED likewise), and a later Bash call
 * that executes that path gets a few derived facts in its state so the ordinary risk questions
 * judge it as what the file does.
 *
 * What is stored: identifiers and booleans. Never file content, tool output, or prompt text.
 * Storage: one append-only JSONL per Claude Code session under ~/.toolgate/ledger (0700/0600).
 * Sessions without a session_id (MCP proxy, `toolgate check`) have no ledger in V1.
 */

const SESSION_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

export function ledgerPath(policy: Policy, sessionId: string): string | undefined {
  if (!policy.ledger.enabled || !SESSION_ID_RE.test(sessionId)) return undefined;
  return join(policy.ledger.dir, `${sessionId}.jsonl`);
}

/** Absolute paths a write tool call targets, resolved against cwd. Empty for anything else. */
export function writtenPaths(input: HookInput): string[] {
  if (!WRITE_TOOLS.has(input.tool_name)) return [];
  const ti = (input.tool_input ?? {}) as Record<string, unknown>;
  const raw = [ti.file_path, ti.notebook_path, ti.path].find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  if (!raw) return [];
  return [normalizePath(raw, input.cwd)];
}

export function normalizePath(p: string, cwd?: string): string {
  let s = p.trim().replace(/^["']|["']$/g, '');
  if (s === '~' || s.startsWith('~/')) s = join(homedir(), s.slice(1));
  return isAbsolute(s) ? resolve(s) : resolve(cwd ?? process.cwd(), s);
}

/** Append the PROPOSED event for a write tool call. Best-effort; never throws into the gate. */
export function recordProposed(policy: Policy, input: HookInput, capabilities?: ArtifactCapabilities, probs?: Record<string, number>): void {
  try {
    if (!input.session_id || !input.tool_use_id) return;
    const paths = writtenPaths(input);
    if (paths.length === 0) return;
    const file = ledgerPath(policy, input.session_id);
    if (!file) return;
    const seq = readEvents(policy, input.session_id).length + 1;
    const event: LedgerEvent = {
      ts: new Date().toISOString(),
      seq,
      tool_use_id: input.tool_use_id,
      tool: input.tool_name,
      op: input.tool_name === 'Write' ? 'write' : 'edit',
      paths,
      status: 'proposed',
      capabilities,
      capability_probs: probs,
    };
    append(file, event);
  } catch {
    // The ledger is a nice-to-have on the write side; never fail the gate over it.
  }
}

/** Settle a proposed event by tool_use_id (from PostToolUse / PostToolUseFailure / PermissionDenied). */
export function settle(policy: Policy, sessionId: string, toolUseId: string, status: 'confirmed' | 'failed' | 'denied'): boolean {
  try {
    const file = ledgerPath(policy, sessionId);
    if (!file || !existsSync(file)) return false;
    const events = readEvents(policy, sessionId);
    const proposed = events.find((e) => e.tool_use_id === toolUseId && e.status === 'proposed');
    if (!proposed) return false;
    append(file, { ...proposed, ts: new Date().toISOString(), seq: events.length + 1, status });
    return true;
  } catch {
    return false;
  }
}

export function readEvents(policy: Policy, sessionId: string): LedgerEvent[] {
  const file = ledgerPath(policy, sessionId);
  if (!file || !existsSync(file)) return [];
  const out: LedgerEvent[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as LedgerEvent;
      if (e && typeof e.tool_use_id === 'string' && Array.isArray(e.paths)) out.push(e);
    } catch {
      // skip a torn line
    }
  }
  return out.slice(-policy.ledger.max_events);
}

/** Current state per written path: the latest status per tool_use_id, most recent write wins per path. */
export interface Artifact {
  path: string;
  status: LedgerEvent['status'];
  capabilities: ArtifactCapabilities;
  seq: number;
}

export function artifacts(events: LedgerEvent[]): Map<string, Artifact> {
  const latestByCall = new Map<string, LedgerEvent>();
  for (const e of events) {
    const prev = latestByCall.get(e.tool_use_id);
    // A status event carries the original seq; keep the original seq for age, latest status for state.
    latestByCall.set(e.tool_use_id, prev ? { ...e, seq: prev.seq } : e);
  }
  const out = new Map<string, Artifact>();
  for (const e of latestByCall.values()) {
    for (const p of e.paths) {
      const existing = out.get(p);
      if (!existing || e.seq > existing.seq) {
        out.set(p, { path: p, status: e.status, capabilities: e.capabilities ?? NONE, seq: e.seq });
      }
    }
  }
  return out;
}

const NONE: ArtifactCapabilities = { reads_sensitive_data: false, sends_data_externally: false, destructive: false, changes_privilege: false };

const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'python2', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'source', '.', 'exec', 'tsx', 'ts-node', 'osascript', 'pwsh', 'powershell']);
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'xargs', 'nice', 'doas', 'busybox']);
const SEPARATORS = new Set(['&&', '||', ';', '|', '(', '{']);
const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const SCRIPT_SUBCOMMANDS = new Set(['run', 'run-script', 'test', 'start', 'build', 'dev', 'lint', 'exec', 'x']);

/**
 * How a Bash command touches a written path: 'execute' (interpreter, ./x, command position,
 * or an npm script when package.json was written), 'reference' (named as an argument to
 * something else, e.g. `cat helper.sh`), or undefined.
 */
export function usage(command: string, artifactPath: string, cwd?: string): 'execute' | 'reference' | undefined {
  const tokens = tokenize(command);
  let found: 'execute' | 'reference' | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const bare = t.replace(/^(?:sudo\s+)?/, '');
    if (!looksLikePath(bare)) continue;
    let resolved: string;
    try {
      resolved = normalizePath(bare, cwd);
    } catch {
      continue;
    }
    if (resolved !== artifactPath) continue;
    // Walk back over wrappers/flags to the word that governs this token.
    let j = i - 1;
    while (j >= 0 && (tokens[j]!.startsWith('-') || WRAPPERS.has(tokens[j]!))) j--;
    const governor = j >= 0 ? tokens[j]! : undefined;
    const atCommandPosition = governor === undefined || SEPARATORS.has(governor);
    if (atCommandPosition || (governor !== undefined && INTERPRETERS.has(governor))) return 'execute';
    found = 'reference';
  }
  // npm/pnpm/yarn/bun script: executes package.json's scripts when package.json was written.
  if (artifactPath.endsWith(`${'/'}package.json`) && normalizePath('package.json', cwd) === artifactPath) {
    for (let i = 0; i < tokens.length - 1; i++) {
      if (SCRIPT_RUNNERS.has(tokens[i]!) && SCRIPT_SUBCOMMANDS.has(tokens[i + 1]!)) return 'execute';
    }
  }
  return found;
}

function tokenize(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    // split glued separators like `x;` or `&&y`
    const parts = raw.split(/(&&|\|\||;|\|)/).filter(Boolean);
    out.push(...parts);
  }
  return out;
}

function looksLikePath(t: string): boolean {
  if (!t || t.startsWith('-') || SEPARATORS.has(t)) return false;
  return t.includes('/') || t.includes('.') || t === '~';
}

/** The facts for a Bash call, from this session's ledger. Undefined when nothing applies. */
export function compositionFacts(policy: Policy, input: HookInput): CompositionFacts | undefined {
  try {
    if (input.tool_name !== 'Bash' || !input.session_id || !policy.ledger.enabled) return undefined;
    const command = (input.tool_input as { command?: unknown } | undefined)?.command;
    if (typeof command !== 'string' || !command.trim()) return undefined;
    const events = readEvents(policy, input.session_id);
    if (events.length === 0) return undefined;
    const arts = artifacts(events);
    const lastSeq = events[events.length - 1]!.seq;
    let best: { a: Artifact; how: 'execute' | 'reference' } | undefined;
    for (const a of arts.values()) {
      if (a.status === 'failed' || a.status === 'denied') continue;
      const how = usage(command, a.path, input.cwd);
      if (!how) continue;
      // Prefer an execution over a reference; among equals, the riskier artifact.
      if (!best || (how === 'execute' && best.how !== 'execute') || (how === best.how && riskCount(a) > riskCount(best.a))) best = { a, how };
    }
    if (!best) return undefined;
    const { a, how } = best;
    return {
      executes_artifact_written_this_session: how === 'execute',
      references_artifact_written_this_session: how === 'reference',
      executed_artifact_write_confirmed: a.status === 'confirmed',
      artifact_path: a.path,
      artifact_reads_sensitive_data: a.capabilities.reads_sensitive_data,
      artifact_sends_data_externally: a.capabilities.sends_data_externally,
      artifact_is_destructive: a.capabilities.destructive,
      artifact_changes_privilege: a.capabilities.changes_privilege,
      prior_effect_age_events: Math.max(0, lastSeq - a.seq),
    };
  } catch {
    return undefined; // never fail the gate over the ledger
  }
}

function riskCount(a: Artifact): number {
  const c = a.capabilities;
  return Number(c.reads_sensitive_data) + Number(c.sends_data_externally) + Number(c.destructive) + Number(c.changes_privilege);
}

function append(file: string, event: LedgerEvent): void {
  const dir = join(file, '..');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  appendFileSync(file, JSON.stringify(event) + '\n', { mode: 0o600 });
}
