#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { runHook, makeBackend } from './hook.js';
import { loadPolicy, policyPath } from './policy.js';
import { decide } from './engine.js';
import type { HookInput } from './types.js';

const HELP = `toolgate — a calibrated tool-call firewall for AI agents

Usage:
  toolgate hook [--policy <path>] [--backend gateway|mock]
      Run as a Claude Code PreToolUse hook (JSON in on stdin).

  toolgate check --tool <name> --input=<json|string> [--backend gateway|mock]
      Dry-run a tool call against the policy and print the decision.

  toolgate init
      Write ~/.toolgate/toolgate.yaml and print the Claude Code settings snippet.

  toolgate audit [-n <count>]
      Show recent audit log entries.

Environment:
  AI_GATEWAY_API_KEY   Vercel AI Gateway key (gateway backend)
  TOOLGATE_POLICY      Policy file path (default ~/.toolgate/toolgate.yaml)
`;

// Bare bin on purpose: `npx toolgate` would resolve to an UNRELATED package of that name on npm.
const SETTINGS_SNIPPET = `{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          { "type": "command", "command": "toolgate hook", "timeout": 10, "statusMessage": "toolgate: checking tool call" }
        ]
      }
    ]
  }
}`;

const EXAMPLE_POLICY = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'toolgate.yaml');

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false, // a typo'd flag in settings.json must never take the gate offline
    options: {
      policy: { type: 'string' },
      backend: { type: 'string' },
      tool: { type: 'string' },
      input: { type: 'string' },
      n: { type: 'string', short: 'n', default: '20' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  const args = { policy: str(values.policy), backend: str(values.backend), tool: str(values.tool), input: str(values.input), n: str(values.n), help: values.help === true };
  const cmd = positionals[0] ?? 'hook';
  if (args.help || cmd === 'help') return console.log(HELP);

  switch (cmd) {
    case 'hook':
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
      const decision = await decide(input, policy, backend);
      return console.log(JSON.stringify({ backend: backend.name, ...decision }, null, 2));
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
      return console.log(`\nAdd to ~/.claude/settings.json:\n\n${SETTINGS_SNIPPET}`);
    }

    case 'audit': {
      const policy = loadPolicy(args.policy);
      if (!existsSync(policy.audit.path)) return console.log(`No audit log at ${policy.audit.path}`);
      const n = Math.max(1, Number(args.n) || 20);
      const lines = readFileSync(policy.audit.path, 'utf8').trimEnd().split('\n').slice(-n);
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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
