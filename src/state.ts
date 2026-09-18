import { existsSync, readFileSync } from 'node:fs';
import type { HookInput } from './types.js';

const MAX_TASK_CONTEXT_CHARS = 1200;
const MAX_INPUT_CHARS = 4000;

/**
 * Build the state object the decision model evaluates.
 * Includes the tool call itself plus (optionally) recent task context pulled
 * from the Claude Code transcript, so scope questions have something to bite on.
 */
export function buildState(input: HookInput, includeTaskContext: boolean): Record<string, unknown> {
  const state: Record<string, unknown> = {
    tool: input.tool_name,
    tool_input: truncateDeep(input.tool_input, MAX_INPUT_CHARS),
    cwd: input.cwd,
    permission_mode: input.permission_mode,
  };
  if (includeTaskContext && input.transcript_path) {
    const task = lastUserPrompt(input.transcript_path);
    if (task) state.current_task = task;
  }
  return state;
}

/** Pull the most recent user prompt out of a Claude Code transcript (JSONL). Best-effort. */
export function lastUserPrompt(transcriptPath: string): string | undefined {
  try {
    if (!existsSync(transcriptPath)) return undefined;
    const lines = readFileSync(transcriptPath, 'utf8').trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const text = extractUserText(entry);
      if (text) return text.slice(0, MAX_TASK_CONTEXT_CHARS);
    }
  } catch {
    // Task context is a nice-to-have; never fail the gate over it.
  }
  return undefined;
}

function extractUserText(entry: unknown): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const e = entry as Record<string, unknown>;
  if (e.type !== 'user') return undefined;
  const message = e.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === 'string') return cleanUserText(content);
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is { type: string; text: string } =>
        Boolean(b && typeof b === 'object' && (b as { type?: string }).type === 'text'),
      )
      .map((b) => b.text);
    if (texts.length > 0) return cleanUserText(texts.join('\n'));
  }
  return undefined;
}

/** Skip tool results and system-injected content masquerading as user turns. */
function cleanUserText(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('<system-reminder>')) return undefined;
  if (trimmed.startsWith('[{')) return undefined;
  return trimmed;
}

function truncateDeep(value: unknown, maxChars: number): unknown {
  const s = JSON.stringify(value);
  if (s === undefined || s.length <= maxChars) return value;
  return { _truncated: true, preview: s.slice(0, maxChars) };
}

/** Serialized form of the tool input used for static rule matching. */
export function serializeInput(toolInput: unknown): string {
  if (typeof toolInput === 'string') return toolInput;
  try {
    return JSON.stringify(toolInput) ?? '';
  } catch {
    return String(toolInput);
  }
}
