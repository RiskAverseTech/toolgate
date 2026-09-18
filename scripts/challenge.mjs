#!/usr/bin/env node
// Runs a frozen, prospectively labeled challenge set through `toolgate check` and writes
// an expected-vs-observed report. Classification only: no command is ever executed.
// Every first attempt is recorded, including timeouts/passthrough; nothing is retried.
//
// Usage: AI_GATEWAY_API_KEY=... node scripts/challenge.mjs docs/challenge-set-1.json [out.md]
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const [, , setPath, outArg] = process.argv;
if (!setPath) throw new Error('usage: challenge.mjs <set.json> [out.md]');
const backend = process.env.TOOLGATE_BACKEND; // set to `mock` for an offline dry run of the harness
if (!backend && !process.env.AI_GATEWAY_API_KEY) throw new Error('set AI_GATEWAY_API_KEY');
const set = JSON.parse(readFileSync(setPath, 'utf8'));
const out = outArg ?? join(root, 'docs', `${basename(setPath, '.json')}-results.md`);
const fixtures = 'Assume:\n' + set.fixtures.map((f) => `- ${f}`).join('\n');

const rows = [];
for (const c of set.cases) {
  const args = ['dist/cli.js', 'check', '--tool', 'Bash', `--input=${c.command}`, '--task', `${fixtures}\n\nTask: ${c.task}`, ...(backend ? ['--backend', backend] : [])];
  let d;
  try {
    d = JSON.parse(execFileSync('node', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
  } catch (err) {
    d = { verdict: 'error', reason: String(err.stderr || err.message).split('\n')[0] };
  }
  const p = d.probabilities ?? {};
  const risks = Object.entries(p).filter(([k]) => k !== 'authorized' && k !== 'off_task');
  const worst = risks.sort((a, b) => b[1] - a[1])[0];
  rows.push({ ...c, observed: d.verdict, worst, off_task: p.off_task, authorized: p.authorized, req: d.latencyMs, reason: d.reason, probs: p });
  process.stdout.write(`${String(c.id).padStart(2)}  expected ${c.expected.padEnd(5)} observed ${String(d.verdict).padEnd(11)} ${worst ? `${worst[0]}=${worst[1].toFixed(2)}` : ''} auth=${p.authorized?.toFixed(2) ?? '-'} off=${p.off_task?.toFixed(2) ?? '-'}\n`);
}

const rank = { allow: 0, ask: 1, deny: 2 };
const match = rows.filter((r) => r.observed === r.expected).length;
const unscored = rows.filter((r) => !(r.observed in rank));
const scored = rows.filter((r) => r.observed in rank);
const dangerous = scored.filter((r) => rank[r.observed] < rank[r.expected]); // more permissive than desired
const dangerousAllow = dangerous.filter((r) => r.observed === 'allow');
const friction = scored.filter((r) => rank[r.observed] > rank[r.expected]); // stricter than desired

const fmt = (v) => (typeof v === 'number' ? v.toFixed(2) : '—');
const table = rows
  .map(
    (r) =>
      `| ${r.id} | ${r.expected} | ${r.observed === r.expected ? '**' + r.observed + '**' : r.observed} | ${r.worst ? `${r.worst[0]} ${fmt(r.worst[1])}` : '—'} | ${fmt(r.off_task)} | ${fmt(r.authorized)} | ${r.req ?? '—'} | \`${r.command.replace(/\|/g, '\\|')}\` |`,
  )
  .join('\n');

const md = `# ${set.name} — results

Frozen ${set.frozen}. Set authored by ${set.author}. Labels are desired product behavior, not predicted scores. ${set.policy}. Every row is a first attempt; nothing retried. Nothing executed.

**${match}/${rows.length} match.** More permissive than desired: ${dangerous.length} (of which dangerous \`allow\`: ${dangerousAllow.length}). Stricter than desired: ${friction.length}. Unscored (timeout/passthrough/error): ${unscored.length}.

| # | expected | observed | worst risk | off_task | authorized | req ms | command |
|---|---|---|---|---:|---:|---:|---|
${table}

## Mismatches

${rows
  .filter((r) => r.observed !== r.expected)
  .map((r) => `- **#${r.id}** expected ${r.expected}, got ${r.observed}. ${r.reason ?? ''}\n  - task: ${r.task}\n  - probs: ${Object.entries(r.probs).map(([k, v]) => `${k}=${fmt(v)}`).join(' ')}`)
  .join('\n') || '_none_'}

## Fixtures supplied with every task

${set.fixtures.map((f) => `- ${f}`).join('\n')}
`;
writeFileSync(out, md);
console.log(`\n${match}/${rows.length} match — wrote ${out}`);
