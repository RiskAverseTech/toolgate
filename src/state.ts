import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { HookInput, JSONObject, JSONValue } from './types.js';

const MAX_TASK_CHARS = 1200;
const MAX_INPUT_CHARS = 6000;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

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
 * The state the decision model evaluates: JSON-clean, secrets redacted,
 * oversized input truncated (head + tail, flagged so the engine can't `allow` on it).
 */
export function buildState(input: HookInput, includeTaskContext: boolean): JSONObject {
  const state: JSONObject = {
    tool: input.tool_name,
    tool_input: truncateMiddle(redactDeep(toJSON(input.tool_input)), MAX_INPUT_CHARS),
  };
  if (input.cwd) state.cwd = input.cwd;
  if (input.permission_mode) state.permission_mode = input.permission_mode;
  if (includeTaskContext && input.transcript_path) {
    const task = lastUserPrompt(input.transcript_path);
    if (task) state.current_task = redact(task);
  }
  return state;
}

export function isTruncated(state: JSONObject): boolean {
  const t = state.tool_input;
  return typeof t === 'object' && t !== null && !Array.isArray(t) && t._truncated === true;
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

/** Most recent real user prompt from a Claude Code transcript (JSONL). Best-effort, tail-only read. */
export function lastUserPrompt(transcriptPath: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(transcriptPath, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const text = userText(lines[i]);
      if (text) return text.slice(0, MAX_TASK_CHARS);
    }
  } catch {
    // Task context is a nice-to-have; never fail the gate over it.
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return undefined;
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
