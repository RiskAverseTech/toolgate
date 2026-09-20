import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Decision, DecisionBackend, HookInput, Policy } from './types.js';
import { decide, message } from './engine.js';
import { makeBackend } from './hook.js';
import { loadEnvFile, loadPolicy, toolMatcherToRegex } from './policy.js';
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
  /**
   * Trust every tool this downstream server advertises, as if each were in `trusted_tools`:
   * "I launched this server and accept its destinations." Bound to this child process, so it
   * never leaks to other servers. Only relaxes the exfiltration axis; everything else is gated as usual.
   */
  trusted?: boolean;
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

/**
 * The tool names the downstream server actually advertised in its `tools/list` responses.
 * Trust (`trusted_tools` or `--trusted`) is only ever applied to these: a `tools/call` that merely
 * claims a trusted name, without the server having declared it, gets no relaxation.
 */
export class AdvertisedTools {
  private readonly pending = new Set<string | number>();
  private readonly names = new Set<string>();
  private waiters: Array<() => void> = [];

  /** Client → server: remember a tools/list request id so its response can be recognized. */
  noteRequest(m: JsonRpcMessage | undefined): void {
    if (m && m.method === 'tools/list' && m.id !== undefined && m.id !== null) this.pending.add(m.id);
  }

  /** Server → client: harvest tool names from a tools/list response (an error reply just settles it). */
  noteResponse(m: JsonRpcMessage | undefined): void {
    if (!m || m.id === undefined || m.id === null || !this.pending.has(m.id)) return;
    this.pending.delete(m.id);
    const tools = (m.result as { tools?: unknown } | undefined)?.tools;
    if (Array.isArray(tools)) {
      for (const t of tools) {
        const name = (t as { name?: unknown } | null)?.name;
        if (typeof name === 'string') this.names.add(name);
      }
    }
    if (this.pending.size === 0) {
      const w = this.waiters;
      this.waiters = [];
      for (const f of w) f();
    }
  }

  /**
   * Resolves once no tools/list request is in flight, so a tools/call pipelined right behind the
   * list is judged against the answered list rather than an empty one. Bounded: a server that
   * never answers just gets no trust, which is the safe direction.
   */
  settled(timeoutMs = 2000): Promise<void> {
    if (this.pending.size === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(resolve, timeoutMs);
      this.waiters.push(() => {
        clearTimeout(t);
        resolve();
      });
    });
  }

  has(name: string): boolean {
    return this.names.has(name);
  }

  get size(): number {
    return this.names.size;
  }
}

/**
 * Whether to tell the model this tool is the user's own service. Requires BOTH a claim (the
 * policy's `trusted_tools` matcher or `--trusted`) AND the server having advertised the name.
 */
export function trustDecision(name: string, claimed: boolean, advertised: AdvertisedTools): { trusted: boolean; reason?: string } {
  if (!claimed) return { trusted: false };
  if (advertised.has(name)) return { trusted: true };
  return {
    trusted: false,
    reason: advertised.size === 0 ? 'the downstream server has not answered tools/list yet' : 'the downstream server did not advertise it in tools/list',
  };
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
  // Trust is a claim (policy matcher or --trusted) bound to what THIS server advertises.
  const trustMatcher = policy.trusted_tools ? toolMatcherToRegex(policy.trusted_tools) : undefined;
  const advertised = new AdvertisedTools();
  const serverLabel = command.join(' ');

  const [cmd, ...args] = command;
  const child = spawn(cmd!, args, { stdio: ['pipe', 'pipe', 'inherit'] });
  child.on('error', (err) => {
    process.stderr.write(`toolgate mcp: cannot start downstream server "${cmd}": ${message(err)}\n`);
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code ?? 0));

  const toClient = (m: JsonRpcMessage): void => void process.stdout.write(JSON.stringify(m) + '\n');
  const toServer = (line: string): void => void child.stdin!.write(line + '\n');

  // server → client: always forwarded untouched; tools/list answers are read on the way past.
  child.stdout!.on('data', createFramer((line) => {
    advertised.noteResponse(parseMessage(line));
    process.stdout.write(line + '\n');
  }));

  // Don't close the server's stdin while gated calls are still being decided: drain first.
  let inFlight = 0;
  let clientEnded = false;
  const maybeEndChild = (): void => {
    if (clientEnded && inFlight === 0) child.stdin!.end();
  };

  // client → server: forward everything except a tools/call, which is gated first.
  const onClientLine = (line: string): void => {
    const m = parseMessage(line);
    advertised.noteRequest(m);
    if (!isToolCall(m)) {
      toServer(line);
      return;
    }
    inFlight++;
    const input: HookInput = { tool_name: m.params.name, tool_input: m.params.arguments ?? {}, cwd: process.cwd() };
    if (transcriptPath) input.transcript_path = transcriptPath;
    const claimed = opts.trusted === true || (trustMatcher?.test(m.params.name) ?? false);
    // Gate asynchronously so other traffic is never blocked behind a model call. If a tools/list
    // is still in flight, wait for it (bounded) so trust is judged against what the server said.
    let trusted = false;
    void advertised
      .settled()
      .then(() => {
        const trust = trustDecision(m.params.name, claimed, advertised);
        trusted = trust.trusted;
        if (claimed && !trust.trusted) process.stderr.write(`toolgate mcp: trust not applied to ${m.params.name}: ${trust.reason}\n`);
        return decide(input, policy, backend, { trustedTool: trust.trusted });
      })
      .then((decision) => {
        if (decision.source !== 'no-opinion') {
          writeAudit(policy, input, decision, backend.name, { mcp_server: serverLabel, trusted_tool: trusted || undefined });
        }
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
      })
      .finally(() => {
        inFlight--;
        maybeEndChild();
      });
  };
  process.stdin.on('data', createFramer(onClientLine));
  process.stdin.on('end', () => {
    clientEnded = true;
    maybeEndChild();
  });
}
