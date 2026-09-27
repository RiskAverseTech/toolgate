import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { HookInput, JSONObject, JSONValue, Policy } from './types.js';

export type Limits = Policy['limits'];
export const DEFAULT_LIMITS: Limits = { input_chars: 40000, task_chars: 6000, earlier_prompts: 2, session_goal_chars: 1200 };
/** A prompt shorter than this is a reaction ("ugh", "yes", "try again"), not a goal. */
const GOAL_MIN_CHARS = 40;
/** How much of the transcript's head to scan for the first substantive prompt. */
const GOAL_SCAN_BYTES = 512 * 1024;
/** Read the transcript backwards in chunks: a few large tool results can push the last real prompt megabytes from the end. */
const TRANSCRIPT_CHUNK_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*[=:]\s*)\S+/gi, '$1[redacted]'],
  [/(\bauthorization\s*:\s*)\S+(?:\s+\S+)?/gi, '$1[redacted]'],
  [/(--?(?:password|passwd|token|api-?key|secret)[=\s]+)\S+/gi, '$1[redacted]'],
  [/\b(?:gh[pousr]_|sk-|xox[baprs]-|AKIA)[A-Za-z0-9_-]{12,}/g, '[redacted]'],
];

/**
 * JSON keys whose values are secrets regardless of what the value looks like. Structured input
 * (MCP arguments above all) separates the key from the value, so the text patterns above, which
 * need `KEY=value` in one string, never see `{ "password": "hunter2" }`. Matched on the key's
 * normalized form (lowercase, separators removed), so `api_key`, `apiKey`, `x-api-key`,
 * `X_API_KEY` all match.
 */
const SENSITIVE_KEY =
  /^(?:password|passwd|pwd|pass|secret|secretkey|clientsecret|token|accesstoken|refreshtoken|idtoken|bearertoken|authtoken|sessiontoken|apikey|xapikey|apisecret|authorization|auth|cookie|setcookie|credential|credentials|privatekey|passphrase|signingkey|encryptionkey|masterkey|dbpassword|connectionstring|dsn)$/;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''));
}

/** Scrub obvious secrets in free text. Applied to everything that leaves the machine and to the audit log. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((t, [re, sub]) => t.replace(re, sub), text);
}

/**
 * Scrub a JSON value: any scalar under a sensitive key is replaced outright; every string is
 * additionally run through the text patterns. ONE redaction path: the model state and the audit
 * log both use this, so there is a single transformation to reason about.
 */
export function redactInput(v: JSONValue, key?: string): JSONValue {
  if (key !== undefined && isSensitiveKey(key) && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) return '[redacted]';
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map((x) => redactInput(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactInput(x, k)]));
  return v;
}

const redactDeep = redactInput;

/** The tool input as redacted text, for the audit log: the same redaction the model state gets, then flattened. */
export function redactedInputText(toolInput: unknown): string {
  return matchText(redactInput(toJSON(toolInput)));
}

/**
 * The state the decision model evaluates: JSON-clean, secrets redacted, oversized input
 * truncated (head + tail, flagged so the engine can't `allow` on it). `current_task` is the
 * latest user prompt; `earlier_prompts` (oldest first) are the ones before it, because in a
 * working session the latest prompt is often "yes" or "continue".
 */
export function buildState(
  input: HookInput,
  includeTaskContext: boolean,
  limits: Limits = DEFAULT_LIMITS,
  trustedHosts: string[] = [],
  trustedTool = false,
): JSONObject {
  const state: JSONObject = {
    tool: input.tool_name,
    tool_input: truncateMiddle(redactDeep(toJSON(input.tool_input)), limits.input_chars),
  };
  if (input.cwd) state.cwd = input.cwd;
  if (input.permission_mode) state.permission_mode = input.permission_mode;
  if (trustedHosts.length > 0) state.trusted_hosts = [...trustedHosts];
  if (trustedTool) state.trusted_tool = true; // this tool is one the user declared their own service
  if (includeTaskContext && input.transcript_path) {
    const [latest, ...earlier] = recentUserPrompts(input.transcript_path, 1 + limits.earlier_prompts);
    if (latest !== undefined) {
      state.current_task = redact(latest.slice(0, limits.task_chars));
      if (latest.length > limits.task_chars) state.current_task_truncated = true;
      if (earlier.length > 0) {
        // Older prompts are context, not the instruction under judgment: cut them without flagging.
        const each = Math.max(200, Math.floor(limits.task_chars / 2));
        state.earlier_prompts = earlier.reverse().map((t) => redact(t.length > each ? t.slice(0, each) + ' …' : t));
      }
      // The session's opening request. In a long session the latest prompts are "ugh" and "yes pull
      // it"; the thing the agent is actually doing was stated hours ago. Skipped when it would just
      // duplicate a prompt the model already sees.
      if (limits.session_goal_chars > 0) {
        const goal = sessionGoal(input.transcript_path);
        if (goal !== undefined && goal !== latest && !earlier.includes(goal)) {
          state.session_goal = redact(goal.length > limits.session_goal_chars ? goal.slice(0, limits.session_goal_chars) + ' …' : goal);
        }
      }
    }
  }
  return state;
}

/**
 * The first substantive user prompt of a transcript (≥ GOAL_MIN_CHARS), read forward from the
 * file's head. Best-effort: any failure means no goal, never a failed gate.
 */
export function sessionGoal(transcriptPath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, 'r');
    const size = Math.min(fstatSync(fd).size, GOAL_SCAN_BYTES);
    const buf = Buffer.alloc(size);
    readSync(fd, buf, 0, size, 0);
    const lines = buf.toString('utf8').split('\n');
    if (size === GOAL_SCAN_BYTES) lines.pop(); // the last line may be cut
    for (const line of lines) {
      const text = userText(line);
      if (text && text.length >= GOAL_MIN_CHARS) return text;
    }
  } catch {
    // no goal
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
}

/** True when either the tool input or the task context was cut — the model did not see everything. */
export function isTruncated(state: JSONObject): boolean {
  const t = state.tool_input;
  const inputCut = typeof t === 'object' && t !== null && !Array.isArray(t) && t._truncated === true;
  return inputCut || state.current_task_truncated === true;
}

/**
 * Text the static rules match against: the tool input's values, with quotes
 * and backslashes stripped so rules are written for raw commands, not JSON.
 */
export function matchText(toolInput: unknown): string {
  const parts: string[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') parts.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.entries(v).forEach(([k, val]) => (parts.push(k), walk(val)));
    else if (v !== undefined && v !== null) parts.push(String(v));
  };
  walk(toolInput);
  return parts.join('\n').replace(/["'\\]/g, '');
}

/** Most recent real user prompt from a Claude Code transcript (JSONL). */
export function lastUserPrompt(transcriptPath: string): string | undefined {
  return recentUserPrompts(transcriptPath, 1)[0];
}

/**
 * The last `count` real user prompts, newest first. Reads the file backwards in chunks
 * and stops as soon as it has enough, so a transcript full of large tool results still
 * yields the prompts. Best-effort: any failure means no task context, never a failed gate.
 */
export function recentUserPrompts(transcriptPath: string, count: number): string[] {
  const found: string[] = [];
  if (count <= 0) return found;
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, 'r');
    let end = fstatSync(fd).size;
    const floor = Math.max(0, end - TRANSCRIPT_MAX_BYTES);
    let carry = Buffer.alloc(0); // the (possibly partial) first line of the previous chunk, as bytes so UTF-8 never splits
    while (end > floor && found.length < count) {
      const start = Math.max(floor, end - TRANSCRIPT_CHUNK_BYTES);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, end - start, start);
      const chunk = Buffer.concat([buf, carry]);
      let complete = chunk;
      carry = Buffer.alloc(0);
      if (start > floor) {
        // Not at the file start: the first line may be cut, so hold it back for the next chunk.
        const nl = chunk.indexOf(0x0a);
        complete = nl >= 0 ? chunk.subarray(nl + 1) : Buffer.alloc(0);
        carry = nl >= 0 ? chunk.subarray(0, nl) : chunk;
      }
      const lines = complete.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0 && found.length < count; i--) {
        const text = userText(lines[i]);
        if (text) found.push(text);
      }
      end = start;
    }
  } catch {
    // Task context is a nice-to-have; never fail the gate over it.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return found;
}

function userText(line: string | undefined): string | undefined {
  if (!line) return undefined;
  let e: Record<string, unknown>;
  try {
    e = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (e.type !== 'user' || e.isSidechain === true || e.isMeta === true) return undefined;
  const content = (e.message as { content?: unknown } | undefined)?.content;
  const raw =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .filter((b): b is { type: 'text'; text: string } => (b as { type?: string })?.type === 'text')
            .map((b) => b.text)
            .join('\n')
        : '';
  const cleaned = raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-name>[\s\S]*?<\/command-name>/g, '')
    .trim();
  return cleaned || undefined;
}

function toJSON(v: unknown): JSONValue {
  try {
    return JSON.parse(JSON.stringify(v ?? null)) as JSONValue;
  } catch {
    return String(v);
  }
}

/** Keep head and tail so an attacker can't hide a payload behind filler. */
function truncateMiddle(v: JSONValue, max: number): JSONValue {
  const s = JSON.stringify(v);
  if (s.length <= max) return v;
  const half = Math.floor(max / 2);
  return { _truncated: true, head: s.slice(0, half), tail: s.slice(-half) };
}
