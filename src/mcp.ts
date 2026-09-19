import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Decision, DecisionBackend, HookInput, Policy } from './types.js';
import { decide, message } from './engine.js';
import { makeBackend } from './hook.js';
import { loadEnvFile, loadPolicy } from './policy.js';
import { writeAudit } from './audit.js';

/**
 * MCP proxy mode. toolgate sits between an MCP client (the agent) and one downstream
 * MCP server, launched as:  toolgate mcp [opts] -- <server-cmd> [args...]
 *
 * It speaks the stdio transport: newline-delimited JSON-RPC 2.0 messages. Every message is
 * forwarded untouched EXCEPT a `tools/call` request, which is gated through the same engine the
 * Claude Code hook uses. Allow → forwarded. Deny (and, by default, ask) → not forwarded; the
 * client gets a normal tool result marked `isError` with the reason, so the agent can relay it
 * to the user instead of the client crashing on a protocol error.
 *
 * MCP carries tool calls, not the conversation, so there is usually no task context. The four
 * context questions are then skipped and the `authorized` mitigator can't fire — the gate is
 * stricter, never more permissive. Supply a task with TOOLGATE_TASK or ~/.toolgate/task to get
 * it back.
 */

export interface McpOptions {
  policyPath?: string;
  backend?: string;
  /** Tool-name matcher for which tools/call go to the model. Default: all of them. */
  gate?: string;
  /** What an `ask` verdict does when no human is at the call: 'block' (default) or 'allow'. */
  onAsk?: 'block' | 'allow';
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: { name?: string; arguments?: unknown; [k: string]: unknown };
  [k: string]: unknown;
}

/** Parse one stdio line. Returns undefined for blanks and unparseable lines (forwarded as-is). */
export function parseMessage(line: string): JsonRpcMessage | undefined {
  const t = line.trim();
  if (!t) return undefined;
  try {
    const m = JSON.parse(t) as unknown;
    return m && typeof m === 'object' && !Array.isArray(m) ? (m as JsonRpcMessage) : undefined;
  } catch {
    return undefined;
  }
}

/** A client→server message we must gate: a JSON-RPC request (has id) calling method "tools/call". */
export function isToolCall(m: JsonRpcMessage | undefined): m is JsonRpcMessage & { id: string | number; params: { name: string; arguments?: unknown } } {
  return (
    m !== undefined &&
    m.method === 'tools/call' &&
    m.id !== undefined &&
    m.id !== null &&
    typeof m.params === 'object' &&
    m.params !== null &&
    typeof m.params.name === 'string'
  );
}

/** The JSON-RPC result sent back to the client when a tool call is blocked (a normal tool error). */
export function blockedResult(id: string | number, decision: Decision): JsonRpcMessage {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      content: [{ type: 'text', text: `[toolgate] ${decision.verdict === 'ask' ? 'needs your confirmation' : 'blocked'}: ${decision.reason}` }],
      isError: true,
    },
  };
}

/** Given a gate decision, say whether to forward the call or block it with a response. */
export function actOnDecision(id: string | number, decision: Decision, onAsk: 'block' | 'allow'): { forward: true } | { forward: false; response: JsonRpcMessage } {
  if (decision.verdict === 'deny') return { forward: false, response: blockedResult(id, decision) };
  if (decision.verdict === 'ask' && onAsk === 'block') return { forward: false, response: blockedResult(id, decision) };
  return { forward: true }; // allow, passthrough, or ask when onAsk === 'allow'
}

/** Read a static task for this session from TOOLGATE_TASK or ~/.toolgate/task, if present. */
function readTask(): string | undefined {
  const env = process.env.TOOLGATE_TASK?.trim();
  if (env) return env;
  const file = join(homedir(), '.toolgate', 'task');
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t) return t;
  }
  return undefined;
}

/**
 * A one-line transcript so the engine's task-context path works without a real Claude Code
 * transcript. Written once per session; reused for every call.
 */
function taskTranscript(task: string | undefined): string | undefined {
  if (!task) return undefined;
  const path = join(mkdtempSync(join(tmpdir(), 'toolgate-mcp-')), 'transcript.jsonl');
  writeFileSync(path, JSON.stringify({ type: 'user', message: { role: 'user', content: task } }) + '\n');
  return path;
}

/** Split newline-delimited messages, keeping any partial trailing line in a buffer. */
export function createFramer(onMessage: (line: string) => void): (chunk: Buffer) => void {
  let buffer = '';
  return (chunk: Buffer): void => {
    buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      onMessage(line);
    }
  };
}

export async function runMcp(opts: McpOptions, command: string[]): Promise<void> {
  loadEnvFile();
  if (command.length === 0) throw new Error('mcp requires a downstream server command after `--`, e.g. `toolgate mcp -- npx -y @scope/server`');

  const basePolicy = loadPolicy(opts.policyPath);
  // In MCP mode every tool is an action worth checking, so gate all tool names unless narrowed.
  const policy: Policy = { ...basePolicy, gated_tools: opts.gate ?? '.*' };
  const backend = makeBackend(policy, opts.backend);
  const onAsk = opts.onAsk ?? 'block';
  const transcriptPath = taskTranscript(readTask());

  const [cmd, ...args] = command;
  const child = spawn(cmd!, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('error', (err) => {
    process.stderr.write(`toolgate mcp: cannot start downstream server "${cmd}": ${message(err)}\n`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 0));

  const toClient = (m: JsonRpcMessage): void => void process.stdout.write(JSON.stringify(m) + '\n');
  const toServer = (line: string): void => void child.stdin!.write(line + '\n');

  // server → client: always forwarded untouched.
  child.stdout!.on('data', createFramer((line) => process.stdout.write(line + '\n')));

  // client → server: forward everything except a tools/call, which is gated first.
  const onClientLine = (line: string): void => {
    const m = parseMessage(line);
    if (!isToolCall(m)) {
      toServer(line);
      return;
    }
    const input: HookInput = { tool_name: m.params.name, tool_input: m.params.arguments ?? {}, cwd: process.cwd() };
    if (transcriptPath) input.transcript_path = transcriptPath;
    // Gate asynchronously so other traffic is never blocked behind a model call.
    void decide(input, policy, backend)
      .then((decision) => {
        if (decision.source !== 'no-opinion') writeAudit(policy, input, decision, backend.name);
        const action = actOnDecision(m.id, decision, onAsk);
        if (action.forward) toServer(line);
        else {
          toClient(action.response);
          process.stderr.write(`toolgate mcp: ${decision.verdict} ${m.params.name} — ${decision.reason}\n`);
        }
      })
      .catch((err) => {
        // Never fail open: on an internal error, block the call with a visible reason.
        const decision: Decision = { verdict: 'ask', reason: `internal error (${message(err)}) — not forwarded`, source: 'fail-mode' };
        toClient(blockedResult(m.id, decision));
        process.stderr.write(`toolgate mcp: ${decision.reason}\n`);
      });
  };
  process.stdin.on('data', createFramer(onClientLine));
  process.stdin.on('end', () => child.stdin!.end());
}
