#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runHook, makeBackend, resolveProvider } from './hook.js';
import { runMcp } from './mcp.js';
import { loadEnvFile, loadPolicy, policyPath } from './policy.js';
import { decide } from './engine.js';
import { SETTINGS_PATH, hookCommand, hookSelfTest, installHook, installedHookCommands, readSettings, settingsSnippet, writeSettings } from './install.js';
import type { HookInput } from './types.js';

const HELP = `toolgate — a calibrated tool-call firewall for AI agents

Usage:
  toolgate hook [--policy <path>] [--backend typesafe|gateway|mock]
      Run as a Claude Code PreToolUse hook (JSON in on stdin).

  toolgate check --tool <name> --input=<json|string> [--task <text>]... [--backend typesafe|gateway|mock]
      Dry-run a tool call against the policy and print the decision and the exact state sent.
      --task supplies user prompts (repeatable, oldest first; the last is the current task)
      so the context questions are asked.

  toolgate mcp [--gate <regex>] [--on-ask block|allow] [--backend ...] -- <server-cmd> [args...]
      Sit between an MCP client and one downstream MCP server, gating every tools/call.
      Allow forwards it; deny (and ask, by default) returns a tool error with the reason.
      Supply a task with TOOLGATE_TASK or ~/.toolgate/task so the context questions apply.

  toolgate init [--print]
      Write ~/.toolgate/toolgate.yaml, save the API key for hooks, make one real test decision,
      install the hook into ~/.claude/settings.json (backup kept), and verify it runs.
      --print shows the settings snippet instead of writing it.

  toolgate install
      (Re)install the hook into ~/.claude/settings.json — e.g. after upgrading node or toolgate.

  toolgate doctor
      Check policy, keys, key file, backend, one real decision, and that the installed hook answers.

  toolgate audit [-n <count>] [--stats]
      Show recent audit log entries, or summary statistics (ask/deny rate, latency).

Environment (one key is enough; TYPESAFE_API_KEY wins when both are set):
  TYPESAFE_API_KEY     TypeSafe direct API key (console.typesafe.ai → API Keys)
  AI_GATEWAY_API_KEY   Vercel AI Gateway key (vercel.com/<team>/~/ai)
  TOOLGATE_POLICY      Policy file path (default ~/.toolgate/toolgate.yaml)
`;

const ENV_FILE = join(homedir(), '.toolgate', 'env');

/** Persist the key so hooks work no matter how Claude Code was launched. */
function saveKeyFile(): string | undefined {
  const pairs = ['TYPESAFE_API_KEY', 'AI_GATEWAY_API_KEY'].filter((k) => process.env[k]).map((k) => `${k}=${process.env[k]}`);
  if (pairs.length === 0) return undefined;
  mkdirSync(dirname(ENV_FILE), { recursive: true, mode: 0o700 });
  writeFileSync(ENV_FILE, pairs.join('\n') + '\n', { mode: 0o600 });
  return ENV_FILE;
}

const EXAMPLE_POLICY = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'toolgate.yaml');

async function main(): Promise<void> {
  loadEnvFile();
  const rawArgs = process.argv.slice(2);
  const ddIndex = rawArgs.indexOf('--');
  const optionArgs = ddIndex >= 0 ? rawArgs.slice(0, ddIndex) : rawArgs;
  const afterDoubleDash = ddIndex >= 0 ? rawArgs.slice(ddIndex + 1) : [];
  const { values, positionals } = parseArgs({
    args: optionArgs,
    allowPositionals: true,
    strict: false, // a typo'd flag in settings.json must never take the gate offline
    options: {
      policy: { type: 'string' },
      backend: { type: 'string' },
      tool: { type: 'string' },
      input: { type: 'string' },
      task: { type: 'string', multiple: true },
      n: { type: 'string', short: 'n', default: '20' },
      stats: { type: 'boolean' },
      print: { type: 'boolean' },
      gate: { type: 'string' },
      'on-ask': { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const args = {
    policy: str(values.policy),
    backend: str(values.backend),
    tool: str(values.tool),
    input: str(values.input),
    tasks: Array.isArray(values.task) ? values.task.filter((v): v is string => typeof v === 'string') : [],
    n: str(values.n),
    stats: values.stats === true,
    print: values.print === true,
    gate: str(values.gate),
    onAsk: str(values['on-ask']),
    help: values.help === true,
  };
  const cmd = positionals[0] ?? 'hook';
  if (args.help || cmd === 'help') return console.log(HELP);

  switch (cmd) {
    case 'hook':
      if (process.stdin.isTTY) throw new Error(`hook expects PreToolUse JSON on stdin\n\n${HELP}`);
      return runHook({ policyPath: args.policy, backend: args.backend });

    case 'check': {
      if (!args.tool) throw new Error('check requires --tool');
      const policy = loadPolicy(args.policy);
      const backend = makeBackend(policy, args.backend);
      const raw = args.input ?? '';
      let toolInput: unknown;
      try {
        toolInput = JSON.parse(raw);
      } catch {
        toolInput = args.tool === 'Bash' ? { command: raw } : raw;
      }
      const input: HookInput = { tool_name: args.tool, tool_input: toolInput, cwd: process.cwd() };
      if (args.tasks.length > 0) {
        // A transcript of user prompts (in order given; the last is the current task) so the context questions are asked.
        const transcript = join(mkdtempSync(join(tmpdir(), 'toolgate-')), 'transcript.jsonl');
        writeFileSync(transcript, args.tasks.map((t) => JSON.stringify({ type: 'user', message: { role: 'user', content: t } })).join('\n') + '\n');
        input.transcript_path = transcript;
      }
      const decision = await decide(input, policy, backend);
      return console.log(JSON.stringify({ backend: backend.name, ...decision }, null, 2)); // includes `state`: what Jev saw
    }

    case 'mcp': {
      if (args.onAsk !== undefined && args.onAsk !== 'block' && args.onAsk !== 'allow') throw new Error('--on-ask must be block or allow');
      return runMcp({ policyPath: args.policy, backend: args.backend, gate: args.gate, onAsk: args.onAsk as 'block' | 'allow' | undefined }, afterDoubleDash);
    }

    case 'init': {
      const path = policyPath(args.policy);
      if (existsSync(path)) {
        console.log(`Policy already exists: ${path}`);
      } else {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        copyFileSync(EXAMPLE_POLICY, path);
        console.log(`Wrote ${path}`);
      }
      const saved = saveKeyFile();
      if (saved) console.log(`Saved key to ${saved} (0600) so hooks work even when Claude Code is launched from the Dock`);
      if (args.print) {
        console.log(`\nAdd to ${SETTINGS_PATH} (merge into an existing "hooks" block if you have one):\n\n${settingsSnippet()}`);
      } else {
        install();
      }
      console.log('');
      const ok = await doctor(args.policy, args.backend);
      console.log(ok ? '\nQuit and reopen Claude Code. After a few commands: toolgate audit -n 5' : '\nFix the ✗ lines above, then run: toolgate doctor');
      if (!ok) process.exitCode = 1;
      return;
    }

    case 'install': {
      install();
      return;
    }

    case 'doctor': {
      if (!(await doctor(args.policy, args.backend))) process.exitCode = 1;
      return;
    }

    case 'audit': {
      const policy = loadPolicy(args.policy);
      if (!existsSync(policy.audit.path)) return console.log(`No audit log at ${policy.audit.path}`);
      const all = readFileSync(policy.audit.path, 'utf8').trimEnd().split('\n');
      if (args.stats) return printStats(all);
      const n = Math.max(1, Number(args.n) || 20);
      const lines = all.slice(-n);
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          const probs = e.probabilities
            ? Object.entries(e.probabilities as Record<string, number>)
                .map(([k, v]) => `${k}=${v}`)
                .join(' ')
            : '';
          console.log(`${e.ts}  ${String(e.verdict).padEnd(5)}  ${String(e.tool).padEnd(10)} [${e.source}] ${probs}  ${e.reason}`);
        } catch {
          /* skip malformed lines */
        }
      }
      return;
    }

    default:
      throw new Error(`Unknown command "${cmd}"\n\n${HELP}`);
  }
}

/** Keys → backend → policy → one real decision. Prints what a new user needs to know; returns ok. */
async function doctor(policyPath?: string, backendOverride?: string): Promise<boolean> {
  const line = (ok: boolean, msg: string): void => console.log(`${ok ? '✓' : '✗'} ${msg}`);
  let policy;
  try {
    policy = loadPolicy(policyPath);
    line(true, `policy: ${existsSync(policyPath ?? '') || existsSync(policy.audit.path.replace(/audit\.jsonl$/, 'toolgate.yaml')) ? 'loaded' : 'built-in defaults'} (deny ${policy.thresholds.deny}, ask ${policy.thresholds.ask}, authorized ${policy.thresholds.authorized})`);
  } catch (err) {
    line(false, `policy: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  const hasTs = Boolean(process.env.TYPESAFE_API_KEY);
  const hasGw = Boolean(process.env.AI_GATEWAY_API_KEY);
  line(hasTs || hasGw || backendOverride === 'mock', `keys: TYPESAFE_API_KEY ${hasTs ? 'set' : 'not set'}, AI_GATEWAY_API_KEY ${hasGw ? 'set' : 'not set'}`);
  let backend;
  try {
    const provider = resolveProvider(backendOverride ?? policy.backend.provider); // throws with no key
    backend = makeBackend(policy, backendOverride);
    line(true, `backend: ${backend.name} (provider ${provider})`);
  } catch (err) {
    line(false, `backend: ${err instanceof Error ? err.message : err}`);
    console.log('  get a key at console.typesafe.ai (API Keys) or vercel.com/<team>/~/ai, export it, and run `toolgate doctor` again');
    return false;
  }
  const probe: HookInput = { tool_name: 'Bash', tool_input: { command: 'git push --force origin main' }, cwd: process.cwd() };
  const d = await decide(probe, { ...policy, audit: { ...policy.audit, enabled: false } }, backend);
  if (d.source !== 'model') {
    line(false, `test decision: ${d.reason}`);
    return false;
  }
  const top = Object.entries(d.probabilities ?? {}).sort((a, b) => b[1] - a[1])[0];
  line(true, `test decision: \`git push --force origin main\` → ${d.verdict} (${top?.[0]} ${top?.[1]}) in ${d.latencyMs} ms`);

  // The checks above prove toolgate works from this shell. The ones below prove it works
  // from Claude Code, which is launched without this shell's PATH or exports.
  let ok = true;
  const keyFile = existsSync(ENV_FILE) && /^(TYPESAFE_API_KEY|AI_GATEWAY_API_KEY)=./m.test(readFileSync(ENV_FILE, 'utf8'));
  if (backendOverride !== 'mock') {
    line(keyFile, keyFile ? `key file: ${ENV_FILE} (read by the hook when Claude Code has no shell exports)` : `key file: ${ENV_FILE} missing — run \`toolgate init\`; without it a Dock-launched Claude Code has no key`);
    ok &&= keyFile;
  }
  let commands: string[] = [];
  try {
    commands = installedHookCommands(readSettings());
  } catch (err) {
    line(false, `settings: ${err instanceof Error ? err.message : err}`);
    return false;
  }
  const installed = commands[0];
  if (installed === undefined) {
    line(false, `hook: not installed in ${SETTINGS_PATH} — run \`toolgate install\``);
    return false;
  }
  const current = installed === hookCommand();
  line(current, current ? `hook: installed in ${SETTINGS_PATH}` : `hook: installed but not the current command (\`${installed}\`) — run \`toolgate install\` to refresh`);
  const self = hookSelfTest(installed);
  line(self.ok, `hook self-test: ${self.detail}`);
  return ok && self.ok;
}

/** Merge the hook into ~/.claude/settings.json, keeping a backup of whatever was there. */
function install(): void {
  const settings = readSettings();
  const result = installHook(settings);
  if (result === 'unchanged') return console.log(`Hook already installed in ${SETTINGS_PATH}`);
  const backup = writeSettings(settings);
  console.log(`${result === 'added' ? 'Installed' : 'Updated'} hook in ${SETTINGS_PATH}${backup ? ` (backup: ${backup})` : ''}:\n  ${hookCommand()}`);
}

function printStats(lines: string[]): void {
  const rows = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) as Array<Record<string, unknown>>;
  if (rows.length === 0) return console.log('no decisions logged yet');
  const by = (k: string): Record<string, number> => {
    const m: Record<string, number> = {};
    for (const r of rows) m[String(r[k])] = (m[String(r[k])] ?? 0) + 1;
    return m;
  };
  const verdicts = by('verdict');
  const sources = by('source');
  const lat = rows.map((r) => r.latency_ms).filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  const pct = (n: number): string => `${Math.round((100 * n) / rows.length)}%`;
  const q = (p: number): number => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] ?? 0;
  const first = rows[0]?.ts, last = rows[rows.length - 1]?.ts;
  console.log(`${rows.length} decisions  ${first} → ${last}`);
  console.log(`verdicts: ${Object.entries(verdicts).map(([k, v]) => `${k} ${v} (${pct(v)})`).join(', ')}`);
  console.log(`sources:  ${Object.entries(sources).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  if (lat.length) console.log(`model latency (${lat.length} calls): p50 ${q(0.5)} ms, p90 ${q(0.9)} ms, max ${lat[lat.length - 1]} ms`);
  const tools = by('tool');
  console.log(`tools:    ${Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const modelRows = rows.filter((r) => r.source === 'model');
  const withTask = modelRows.filter((r) => (r.task as { present?: boolean } | undefined)?.present === true).length;
  const truncated = modelRows.filter((r) => r.input_truncated === true).length;
  if (modelRows.length) console.log(`context:  task present ${withTask}/${modelRows.length}, input truncated ${truncated}/${modelRows.length}`);
  const modes = by('permission_mode');
  if (Object.keys(modes).some((k) => k !== 'undefined')) console.log(`modes:    ${Object.entries(modes).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  const asked = rows.filter((r) => r.verdict === 'ask' || r.verdict === 'deny');
  if (asked.length) {
    console.log(`\nrecent ask/deny:`);
    for (const r of asked.slice(-8)) console.log(`  ${String(r.verdict).padEnd(5)} ${String(r.tool).padEnd(8)} ${String(r.input ?? '').slice(0, 70)}  — ${String(r.reason).slice(0, 60)}`);
  }
  // Allow-side review: the allowed calls that came closest to a threshold. A firewall is only
  // as trustworthy as its allows, so surface the near-misses to eyeball for anything that should
  // not have passed. The bar to publish: this list has no call that should have been stopped.
  const maxRisk = (r: Record<string, unknown>): number => {
    const p = r.probabilities as Record<string, number> | undefined;
    return p ? Math.max(0, ...Object.entries(p).filter(([k]) => k !== 'authorized').map(([, v]) => v)) : 0;
  };
  const allows = rows.filter((r) => r.verdict === 'allow' && r.probabilities).sort((a, b) => maxRisk(b) - maxRisk(a));
  if (allows.length) {
    console.log(`\nclosest allows (review — should contain nothing that ought to have been stopped):`);
    for (const r of allows.slice(0, 8)) console.log(`  ${(maxRisk(r) * 100).toFixed(0).padStart(3)}%  ${String(r.tool).padEnd(8)} ${String(r.input ?? '').slice(0, 74)}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
