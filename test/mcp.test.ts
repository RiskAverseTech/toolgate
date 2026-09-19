import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { actOnDecision, blockedResult, createFramer, isToolCall, parseMessage } from '../src/mcp.js';
import type { Decision } from '../src/types.js';

const CLI = join(__dirname, '..', 'dist', 'cli.js');

describe('message parsing and classification', () => {
  it('parses objects, ignores blanks and junk', () => {
    expect(parseMessage('{"jsonrpc":"2.0","id":1}')).toEqual({ jsonrpc: '2.0', id: 1 });
    expect(parseMessage('   ')).toBeUndefined();
    expect(parseMessage('not json')).toBeUndefined();
    expect(parseMessage('[1,2]')).toBeUndefined();
  });

  it('recognizes a tools/call request and nothing else', () => {
    expect(isToolCall(parseMessage('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"x","arguments":{}}}'))).toBe(true);
    expect(isToolCall(parseMessage('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'))).toBe(false);
    expect(isToolCall(parseMessage('{"jsonrpc":"2.0","method":"tools/call","params":{"name":"x"}}'))).toBe(false); // notification, no id
    expect(isToolCall(parseMessage('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{}}'))).toBe(false); // no name
  });
});

describe('decision → action', () => {
  const d = (verdict: Decision['verdict']): Decision => ({ verdict, reason: `${verdict} reason`, source: 'model' });

  it('allow and passthrough forward', () => {
    expect(actOnDecision(1, d('allow'), 'block').forward).toBe(true);
    expect(actOnDecision(1, d('passthrough'), 'block').forward).toBe(true);
  });

  it('deny always blocks with an isError tool result carrying the reason', () => {
    const a = actOnDecision(7, d('deny'), 'allow');
    expect(a.forward).toBe(false);
    if (!a.forward) {
      expect(a.response.id).toBe(7);
      expect((a.response.result as { isError: boolean }).isError).toBe(true);
      expect(JSON.stringify(a.response)).toContain('deny reason');
    }
  });

  it('ask blocks by default, forwards when on-ask=allow', () => {
    expect(actOnDecision(1, d('ask'), 'block').forward).toBe(false);
    expect(actOnDecision(1, d('ask'), 'allow').forward).toBe(true);
  });

  it('a blocked result is a valid JSON-RPC result, not a protocol error', () => {
    const r = blockedResult(3, d('deny'));
    expect(r.jsonrpc).toBe('2.0');
    expect(r).not.toHaveProperty('error');
    expect(r.result).toBeTruthy();
  });
});

describe('stdio framing', () => {
  it('splits on newlines and holds a partial trailing line', () => {
    const got: string[] = [];
    const feed = createFramer((l) => got.push(l));
    feed(Buffer.from('{"a":1}\n{"b":2}\n{"c":'));
    expect(got).toEqual(['{"a":1}', '{"b":2}']);
    feed(Buffer.from('3}\n'));
    expect(got).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });
});

// A tiny downstream MCP server: echoes any tools/call as a successful result, so anything the
// proxy forwards comes back with ok:true and anything it blocks comes back isError from toolgate.
const FAKE_SERVER = `
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
let buf = '';
process.stdin.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    const m = JSON.parse(line);
    if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'ok:' + m.params.name }], isError: false } });
    else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
  }
});
`;

function runProxy(requests: object[], extraArgs: string[] = []): Array<Record<string, unknown>> {
  const dir = mkdtempSync(join(tmpdir(), 'tg-mcp-'));
  const server = join(dir, 'server.mjs');
  writeFileSync(server, FAKE_SERVER);
  const policy = join(dir, 'toolgate.yaml');
  writeFileSync(policy, 'backend:\n  provider: mock\naudit:\n  enabled: false\n');
  const input = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const out = execFileSync('node', [CLI, 'mcp', '--policy', policy, ...extraArgs, '--', 'node', server], {
    input,
    encoding: 'utf8',
    timeout: 15000,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  return out
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('mcp proxy end-to-end (built CLI + fake server)', () => {
  it('forwards a benign tool call and blocks a dangerous one', () => {
    const msgs = runProxy([
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'read_file', arguments: { path: 'README.md' } } },
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'run', arguments: { command: 'rm -rf ~/' } } },
    ]);
    const byId = new Map(msgs.map((m) => [m.id, m]));
    // tools/list passed through to the echo server
    expect(byId.get(1)).toBeTruthy();
    // benign call forwarded → server's ok result
    const ok = byId.get(2) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(ok.result.isError).toBe(false);
    expect(ok.result.content[0]!.text).toBe('ok:read_file');
    // dangerous call blocked by toolgate → isError result, never reached the server
    const blocked = byId.get(3) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(blocked.result.isError).toBe(true);
    expect(blocked.result.content[0]!.text).toContain('[toolgate]');
  });
});
