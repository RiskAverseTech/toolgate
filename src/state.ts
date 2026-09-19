import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { HookInput, JSONObject, JSONValue, Policy } from './types.js';

export type Limits = Policy['limits'];
export const DEFAULT_LIMITS: Limits = { input_chars: 20000, task_chars: 6000, earlier_prompts: 2 };
/** Read the transcript backwards in chunks: a few large tool results can push the last real prompt megabytes from the end. */
const TRANSCRIPT_CHUNK_BYTES = 256 * 1024;
const TRANSCRIPT_MAX_BYTES = 16 * 1024 * 1024;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Z0-9_]*\s*[=:]\s*)\S+/gi, '$1[redacted]'],
  [/(\bauthorization\s*:\s*)\S+(?:\s+\S+)?/gi, '$1[redacted]'],
  [/(--?(?:password|passwd|token|api-?key|secret)[=\s]+)\S+/gi, '$1[redacted]'],
  [/\b(?:gh[pousr]_|sk-|xox[baprs]-|AKIA)[A-Za-z0-9_-]{12,}/g, '[redacted]'],
];

/** Scrub obvious secrets. Applied to everything that leaves the machine and to the audit log. */
export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((t, [re, sub]) => t.replace(re, sub), text);
}

function redactDeep(v: JSONValue): JSONValue {
  if (typeof v === 'string') return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

/**
 * The state the decision model evaluates: JSON-clean, secrets redacted, oversized input
 * truncated (head + tail, flagged so the engine can't `allow` on it). `current_task` is the
 * latest user prompt; `earlier_prompts` (oldest first) are the ones before it, because in a
 * working session the latest prompt is often "yes" or "continue".
 */
export function buildState(input: HookInput, includeTaskContext: boolean, limits: Limits = DEFAULT_LIMITS): JSONObject {
  const state: JSONObject = {
    tool: input.tool_name,
    tool_input: truncateMiddle(redactDeep(toJSON(input.tool_input)), limits.input_chars),
  };
  if (input.cwd) state.cwd = input.cwd;
  if (input.permission_mode) state.permission_mode = input.permission_mode;
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
    }
  }
  return state;
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
