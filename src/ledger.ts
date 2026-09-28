import { accessSync, appendFileSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
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

const INTERPRETERS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'fish', 'python', 'python3', 'python2', 'node', 'deno', 'bun', 'ruby', 'perl', 'php', 'source', '.', 'exec', 'eval', 'tsx', 'ts-node', 'osascript', 'pwsh', 'powershell']);
const WRAPPERS = new Set(['sudo', 'env', 'command', 'nohup', 'time', 'xargs', 'nice', 'doas', 'busybox']);
/** Flags under which an interpreter parses a file without running it (set 7 negative controls). */
const SYNTAX_CHECK_FLAGS: Record<string, Set<string>> = {
  bash: new Set(['-n']), sh: new Set(['-n']), zsh: new Set(['-n']), dash: new Set(['-n']), ksh: new Set(['-n']),
  node: new Set(['--check', '-c']), deno: new Set(['check']), bun: new Set([]),
  perl: new Set(['-c']), ruby: new Set(['-c']), php: new Set(['-l', '--syntax-check']), python: new Set([]), python3: new Set([]),
};
const SEPARATORS = new Set(['&&', '||', ';', '|', '(', '{']);
/** Redirections that feed a file to the command on their left. */
const STDIN_REDIRECTS = new Set(['<', '<<<']);
const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const MAKEFILES = new Set(['Makefile', 'makefile', 'GNUmakefile']);
const SCRIPT_SUBCOMMANDS = new Set(['run', 'run-script', 'test', 'start', 'build', 'dev', 'lint', 'exec', 'x']);

/**
 * How a Bash command touches a written path: 'execute' (interpreter, ./x, command position,
 * stdin of an interpreter via `<` / `<<<` / a pipe, inside `$(…)` or backticks or an
 * interpreter's -e/-c blob, an npm script when package.json was written, or `make` when the
 * Makefile was written), 'reference'
 * (named as an argument to something else, e.g. `cat helper.sh`), or undefined.
 * An extensionless basename counts as the written file only when it is fed to an
 * interpreter, never at command position (a bare word there resolves through PATH).
 */
export function usage(command: string, artifactPath: string, cwd?: string): 'execute' | 'reference' | undefined {
  const tokens = tokenize(command);
  const isArtifact = (t: string): boolean => {
    if (!looksLikePath(t)) return false;
    try {
      return normalizePath(t, cwd) === artifactPath;
    } catch {
      return false;
    }
  };
  const baseName = basename(artifactPath);
  const extensionless = !baseName.includes('.') && normalizePath(baseName, cwd) === artifactPath;
  let found: 'execute' | 'reference' | undefined;
  const note = (how: 'execute' | 'reference'): void => {
    if (how === 'execute' || !found) found = how;
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const direct = isArtifact(t);
    const asBasename = !direct && extensionless && t === baseName;
    const inBlob = !direct && !asBasename && isBlob(t) && innerPaths(t).some(isArtifact);
    if (!direct && !asBasename && !inBlob) continue;
    const gov = governorOf(tokens, i);
    if (gov.kind === 'interpreter') {
      note('execute');
      continue;
    }
    if (gov.kind === 'command' && !asBasename) {
      // `./x` or `/abs/x` in command position runs it; a blob at command position does not.
      note(inBlob ? 'reference' : 'execute');
      continue;
    }
    // Fed to an interpreter on the other side of a pipe: `cat x | bash`, `cat x | sudo python3 -`.
    if (pipedToInterpreter(tokens, i)) {
      note('execute');
      continue;
    }
    if (!asBasename || gov.kind === 'other') note('reference'); // `cat helper`, `cat Makefile`: named, not run
  }
  if (found === 'execute') return 'execute';
  // make: runs a recipe from the Makefile in cwd when that Makefile was written (set 8 case 18).
  const mk = basename(artifactPath);
  if (MAKEFILES.has(mk) && normalizePath(mk, cwd) === artifactPath) {
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] === 'make' && (i === 0 || SEPARATORS.has(tokens[i - 1]!) || WRAPPERS.has(tokens[i - 1]!))) {
        // `make -f other.mk target` runs a different file; anything else runs the Makefile in cwd.
        const rest = tokens.slice(i + 1).join(' ');
        if (!/(^|\s)(-f|--file|--makefile)(\s|=)/.test(rest)) return 'execute';
      }
    }
  }
  // npm/pnpm/yarn/bun script: executes package.json's scripts when package.json was written.
  if (artifactPath.endsWith(`${'/'}package.json`) && normalizePath('package.json', cwd) === artifactPath) {
    for (let i = 0; i < tokens.length - 1; i++) {
      if (SCRIPT_RUNNERS.has(tokens[i]!) && SCRIPT_SUBCOMMANDS.has(tokens[i + 1]!)) return 'execute';
    }
  }
  return found;
}

/** Would this command run some file (any path fed to an interpreter, or ./x)? Used when the ledger cannot be read. */
export function executeShaped(command: string): boolean {
  const tokens = tokenize(command);
  if (tokens[0] === 'make' || SCRIPT_RUNNERS.has(tokens[0] ?? '')) return true;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const pathy = looksLikePath(t) || (isBlob(t) && innerPaths(t).some(looksLikePath));
    if (!pathy) continue;
    const gov = governorOf(tokens, i);
    if (gov.kind === 'interpreter') return true;
    if (gov.kind === 'command' && !isBlob(t) && (t.startsWith('./') || t.startsWith('/') || t.startsWith('~'))) return true;
    if (pipedToInterpreter(tokens, i)) return true;
  }
  return false;
}

/** The word that governs token i, walking back over flags, wrappers, and stdin redirections. */
function governorOf(tokens: string[], i: number): { kind: 'interpreter' | 'command' | 'other'; word?: string } {
  let j = i - 1;
  const flags: string[] = [];
  while (j >= 0 && (tokens[j]!.startsWith('-') || WRAPPERS.has(tokens[j]!) || STDIN_REDIRECTS.has(tokens[j]!))) {
    if (tokens[j]!.startsWith('-')) flags.push(tokens[j]!);
    j--;
  }
  const word = j >= 0 ? tokens[j] : undefined;
  if (word === undefined || SEPARATORS.has(word)) return { kind: 'command' };
  if (INTERPRETERS.has(word)) {
    // `bash -n x.sh`, `node --check x.js`: the interpreter parses the file and does not run it.
    const checks = SYNTAX_CHECK_FLAGS[word];
    if (checks && flags.some((f) => checks.has(f))) return { kind: 'other', word };
    return { kind: 'interpreter', word };
  }
  return { kind: 'other', word };
}

/** True when the pipeline segment holding token i is followed by `| [wrappers] <interpreter> [flags|-]` with no file of its own. */
function pipedToInterpreter(tokens: string[], i: number): boolean {
  let k = i + 1;
  while (k < tokens.length && tokens[k] !== '|' && !SEPARATORS.has(tokens[k]!)) k++;
  if (k >= tokens.length || tokens[k] !== '|') return false;
  k++;
  while (k < tokens.length && (WRAPPERS.has(tokens[k]!) || tokens[k]!.startsWith('-'))) k++;
  if (k >= tokens.length || !INTERPRETERS.has(tokens[k]!)) return false;
  for (let m = k + 1; m < tokens.length && !SEPARATORS.has(tokens[m]!); m++) {
    const a = tokens[m]!;
    if (a !== '-' && !a.startsWith('-')) return false; // the interpreter has its own file: `cat x | bash other.sh`
  }
  return true;
}

function tokenize(command: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    const quoted = m[1] !== undefined || m[2] !== undefined;
    const raw = m[1] ?? m[2] ?? m[3] ?? '';
    if (quoted) {
      out.push(raw);
      continue;
    }
    // split glued separators and stdin redirections like `x;`, `&&y`, `<file`
    const parts = raw.split(/(&&|\|\||;|\||<<<|<)/).filter(Boolean);
    out.push(...parts);
  }
  return out;
}

/** A token that carries code or a substitution rather than a single word: `$(cat x)`, `require('./x')`. */
function isBlob(t: string): boolean {
  return /\s|\$\(|`|\(/.test(t);
}

/** Path-like words inside a blob. */
function innerPaths(t: string): string[] {
  return (t.match(/[~./A-Za-z0-9_-]+/g) ?? []).filter(looksLikePath);
}

function looksLikePath(t: string): boolean {
  if (!t || t.startsWith('-') || SEPARATORS.has(t) || STDIN_REDIRECTS.has(t)) return false;
  return t.includes('/') || t.includes('.') || t === '~';
}

/**
 * True when the ledger is enabled but cannot be read for this session: the directory exists
 * and is not a readable directory, or the session file exists and is unreadable. A ledger that
 * simply has no events yet is available. Best-effort gating must not silently become one-shot
 * scoring, so the engine floors execute-shaped Bash at ask while this is true.
 */
export function ledgerUnavailable(policy: Policy, sessionId: string | undefined): boolean {
  try {
    if (!policy.ledger.enabled || !sessionId) return false;
    const file = ledgerPath(policy, sessionId);
    if (!file) return false;
    const dir = policy.ledger.dir;
    if (!existsSync(dir)) return false;
    if (!statSync(dir).isDirectory()) return true;
    accessSync(dir, constants.R_OK | constants.X_OK);
    if (existsSync(file)) accessSync(file, constants.R_OK);
    return false;
  } catch {
    return true;
  }
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
