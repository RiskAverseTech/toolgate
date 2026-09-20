import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdvertisedTools, actOnDecision, blockedResult, createFramer, isToolCall, parseMessage, trustDecision } from '../src/mcp.js';
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

describe('trust is bound to what the server advertised', () => {
  const list = (id: number, names: string[]): ReturnType<typeof parseMessage> =>
    parseMessage(JSON.stringify({ jsonrpc: '2.0', id, result: { tools: names.map((name) => ({ name })) } }));

  it('harvests names only from responses to tools/list requests it saw', () => {
    const adv = new AdvertisedTools();
    adv.noteResponse(list(1, ['stray'])); // no matching request → ignored
    expect(adv.has('stray')).toBe(false);
    adv.noteRequest(parseMessage('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'));
    adv.noteResponse(list(1, ['read_file', 'upload']));
    expect(adv.has('read_file')).toBe(true);
    expect(adv.has('upload')).toBe(true);
    expect(adv.size).toBe(2);
  });

  it('settled() waits for an in-flight tools/list, and gives up (no trust) after the timeout', async () => {
    const adv = new AdvertisedTools();
    await adv.settled(); // nothing in flight → immediate
    adv.noteRequest(parseMessage('{"jsonrpc":"2.0","id":9,"method":"tools/list"}'));
    let done = false;
    const p = adv.settled(5000).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(done).toBe(false); // still waiting for the answer
    adv.noteResponse(list(9, ['upload']));
    await p;
    expect(done).toBe(true);
    // a server that never answers: bounded wait, then proceed with nothing advertised
    const slow = new AdvertisedTools();
    slow.noteRequest(parseMessage('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'));
    const t0 = Date.now();
    await slow.settled(30);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
    expect(trustDecision('upload', true, slow).trusted).toBe(false);
  });

  it('trust needs BOTH a claim and an advertised name', () => {
    const adv = new AdvertisedTools();
    expect(trustDecision('upload', false, adv).trusted).toBe(false);
    // claimed, but the server never answered tools/list
    const early = trustDecision('upload', true, adv);
    expect(early.trusted).toBe(false);
    expect(early.reason).toMatch(/not answered tools\/list/);
    adv.noteRequest(parseMessage('{"jsonrpc":"2.0","id":1,"method":"tools/list"}'));
    adv.noteResponse(list(1, ['upload']));
    expect(trustDecision('upload', true, adv).trusted).toBe(true);
    // claimed, advertised list exists, but this name is forged
    const forged = trustDecision('upload_exfil', true, adv);
    expect(forged.trusted).toBe(false);
    expect(forged.reason).toMatch(/did not advertise/);
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
    else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'read_file' }, { name: 'run' }, { name: 'generate' }] } });
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

/** Like runProxy but returns stderr too, for the trust notices. */
function runProxyFull(requests: object[], extraArgs: string[] = [], policyYaml = 'backend:\n  provider: mock\naudit:\n  enabled: false\n'): { stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'tg-mcp-'));
  const server = join(dir, 'server.mjs');
  writeFileSync(server, FAKE_SERVER);
  const policy = join(dir, 'toolgate.yaml');
  writeFileSync(policy, policyYaml);
  const input = requests.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const r = spawnSync('node', [CLI, 'mcp', '--policy', policy, ...extraArgs, '--', 'node', server], { input, encoding: 'utf8', timeout: 15000 });
  return { stdout: r.stdout, stderr: r.stderr };
}

describe('mcp proxy trust binding end-to-end', () => {
  it('a forged trusted name gets no trust (notice on stderr); an advertised one does; the call is still gated either way', () => {
    const calls = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'generate', arguments: { prompt: 'x' } } }, // advertised
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'generate_exfil', arguments: { prompt: 'x' } } }, // forged
    ];
    const { stdout, stderr } = runProxyFull(calls, ['--trusted']);
    expect(stderr).not.toMatch(/trust not applied to generate:/);
    expect(stderr).toMatch(/trust not applied to generate_exfil: the downstream server did not advertise it/);
    // both were still gated and answered (the mock backend allows benign prompts)
    const ids = stdout.split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { id?: number }).id);
    expect(ids).toEqual(expect.arrayContaining([1, 2, 3]));
  });

  it('a policy trusted_tools claim before tools/list is answered gets no trust', () => {
    const calls = [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'generate', arguments: { prompt: 'x' } } }];
    const { stderr } = runProxyFull(calls, [], 'backend:\n  provider: mock\naudit:\n  enabled: false\ntrusted_tools: generate\n');
    expect(stderr).toMatch(/trust not applied to generate: the downstream server has not answered tools\/list yet/);
  });

  it('--trusted relaxes only exfiltration: a destructive call through a trusted server is still blocked', () => {
    const calls = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run', arguments: { command: 'rm -rf ~/' } } },
    ];
    const { stdout } = runProxyFull(calls, ['--trusted']);
    const blocked = stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { id: number; result?: { isError?: boolean } }).find((m) => m.id === 2);
    expect(blocked?.result?.isError).toBe(true);
  });
});

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
