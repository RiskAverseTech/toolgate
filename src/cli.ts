#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { runHook, makeBackend } from './hook.js';
import { loadPolicy, defaultPolicy, POLICY_FILENAME } from './policy.js';
import { decide } from './engine.js';
import type { HookInput } from './types.js';

const HELP = `toolgate — a calibrated tool-call firewall for AI agents

Usage:
  toolgate hook [--policy <path>] [--backend gateway|mock]
      Run as a Claude Code PreToolUse hook (JSON in on stdin).

  toolgate check --tool <name> --input <json|string> [--backend gateway|mock] [--task <text>]
      Dry-run a tool call against the current policy and print the decision.

  toolgate init [--global]
      Write a starter toolgate.yaml (./ or ~/.toolgate/) and print the
      settings.json snippet to register the hook with Claude Code.

  toolgate audit [-n <count>]
      Show recent audit log entries.

Environment:
  AI_GATEWAY_API_KEY   Vercel AI Gateway key (gateway backend)
  TOOLGATE_POLICY      Path to a policy file (overrides discovery)
`;

const SETTINGS_SNIPPET = `{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "npx toolgate hook",
            "timeout": 10,
            "statusMessage": "toolgate: checking tool call"
          }
        ]
      }
    ]
  }
}`;

async function main(): Promise<void> {
  const [, , cmd = 'hook', ...rest] = process.argv;
  const args = parseArgs(rest);

  switch (cmd) {
    case 'hook':
      await runHook({ policyPath: args.policy, backend: args.backend });
      return;

    case 'check': {
      if (!args.tool) fail('check requires --tool');
      const policy = loadPolicy(args.policy);
      const backend = makeBackend(policy, args.backend);
      let toolInput: unknown = args.input ?? '';
      try {
        toolInput = JSON.parse(args.input ?? '""');
      } catch {
        toolInput = args.tool === 'Bash' ? { command: args.input } : args.input;
      }
      const input: HookInput = { tool_name: args.tool!, tool_input: toolInput, cwd: process.cwd() };
      const decision = await decide(input, policy, backend);
      console.log(JSON.stringify({ backend: backend.name, ...decision }, null, 2));
      return;
    }

    case 'init': {
      const dir = args.global !== undefined ? join(homedir(), '.toolgate') : process.cwd();
      const path = join(dir, POLICY_FILENAME);
      if (existsSync(path)) {
        console.log(`Policy already exists: ${path}`);
      } else {
        const { mkdirSync } = await import('node:fs');
        mkdirSync(dir, { recursive: true });
        writeFileSync(path, starterYaml(), 'utf8');
        console.log(`Wrote ${path}`);
      }
      console.log('\nAdd to your Claude Code settings (~/.claude/settings.json or .claude/settings.json):\n');
      console.log(SETTINGS_SNIPPET);
      return;
    }

    case 'audit': {
      const policy = loadPolicy(args.policy);
      const n = Number(args.n ?? 20);
      if (!existsSync(policy.audit.path)) {
        console.log(`No audit log at ${policy.audit.path}`);
        return;
      }
      const lines = readFileSync(policy.audit.path, 'utf8').trimEnd().split('\n');
      for (const line of lines.slice(-n)) {
        try {
          const e = JSON.parse(line);
          const probs = e.probabilities
            ? ' ' +
              Object.entries(e.probabilities as Record<string, number>)
                .map(([k, v]) => `${k}=${v}`)
                .join(' ')
            : '';
          console.log(`${e.ts}  ${pad(e.verdict, 5)}  ${pad(e.tool, 10)} [${e.source}]${probs}  ${e.reason}`);
        } catch {
          /* skip malformed lines */
        }
      }
      return;
    }

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return;

    default:
      fail(`Unknown command "${cmd}"\n\n${HELP}`);
  }
}

function starterYaml(): string {
  const d = defaultPolicy();
  return `# toolgate policy — https://github.com/RiskAverseTech/toolgate
version: 1

backend:
  provider: gateway        # gateway | mock
  model: typesafe-ai/jev
  timeout_ms: 2500

# What to do when the decision model is unreachable:
#   passthrough = fall back to the agent's normal permission flow (default)
#   ask         = force a confirmation prompt
#   deny        = block until the model is back
fail_mode: passthrough

thresholds:
  deny: ${d.thresholds.deny}   # block at/above this probability
  ask: ${d.thresholds.ask}    # prompt at/above this probability

# Which tools the model evaluates (Claude Code matcher syntax).
gated_tools: "${d.gated_tools}"

# Pull the current task from the transcript so 'off_task' has context.
include_task_context: true

audit:
  enabled: true
  path: ~/.toolgate/audit.jsonl
  log_input: true

# Static rules run before the model — first match wins, costs nothing.
# Uncomment to customize; these defaults are built in:
# rules:
#   - match: { tool: Bash, input_regex: 'rm\\s+-rf\\s+[/~]' }
#     action: deny
#     reason: Recursive delete targeting root or home
#   - match: { tool: "Read|Glob|Grep" }
#     action: allow
`;
}

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a?.startsWith('--') && a !== '-n' && a !== '-h') continue;
    const key = a.replace(/^--?/, '');
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('-')) {
      out[key] = next;
      i++;
    } else {
      out[key] = '';
    }
  }
  return out;
}

function pad(s: unknown, n: number): string {
  return String(s ?? '').padEnd(n);
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
