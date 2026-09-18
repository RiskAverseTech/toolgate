import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import type { HookInput, JSONObject, JSONValue } from './types.js';

const MAX_TASK_CHARS = 1200;
const MAX_INPUT_CHARS = 6000;
const TRANSCRIPT_TAIL_BYTES = 256 * 1024;

/** The state the decision model evaluates. Always JSON-clean (no undefined). */
export function buildState(input: HookInput, includeTaskContext: boolean): JSONObject {
  const state: JSONObject = {
    tool: input.tool_name,
    tool_input: truncateMiddle(toJSON(input.tool_input), MAX_INPUT_CHARS),
  };
  if (input.cwd) state.cwd = input.cwd;
  if (input.permission_mode) state.permission_mode = input.permission_mode;
  if (includeTaskContext && input.transcript_path) {
    const task = lastUserPrompt(input.transcript_path);
    if (task) state.current_task = task;
  }
  return state;
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
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
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
