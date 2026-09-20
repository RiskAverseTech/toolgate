# Changelog

## 0.9.1 — trusted_tools bound to the install, per-axis stats, the 41-decision regression check
Driven by Grok's second review, which attacked `trusted_tools` as "a string in `params.name`, not the server you installed." Three guards close the gap between the claim and the install:
- **Over-broad matchers are rejected at policy load.** `trusted_tools: "mcp__.*"` (or `.*`, `*`) would be an exfiltration allow-list for every MCP server you ever add; it now fails validation with a message to name the client-assigned server key (`mcp__myapi__.*`).
- **Proxy mode binds trust to what the server advertised.** toolgate reads the downstream `tools/list` responses on the way past and applies trust (from `trusted_tools` or `--trusted`) only to names the server actually declared. A `tools/call` that merely claims a trusted name gets none, with a notice on stderr. A call pipelined behind an unanswered `tools/list` waits for the answer (bounded at 2 s; a server that never answers just gets no trust). Hook mode never sees `tools/list`, so only the first guard applies there.
- **`toolgate mcp --trusted -- <server>`**: "I launched this server and accept its destinations." Trusts every tool *that one child process* advertises, bound to it and to nothing else. Still exfiltration-only; a destructive call through a trusted server is still blocked (tested).
- The proxy no longer closes the server's stdin while gated calls are still being decided: it drains in-flight calls first. (Found by the binding change; a real gap before it.)
- Audit lines from the proxy now carry `mcp_server` (the launched command) and `trusted_tool: true` when trust was applied, so the allow-side review can see which server a call went to.
- **`toolgate audit --stats` prints per-axis histograms** and which axis owns the allow band just under the ask line. The verdict is a max over seven axes, and the max of seven noisy scores sits closer to the ask line than any one of them (order-statistic bias), so a fat band is expected; what matters is whether one axis owns it (a wording or trusted_* problem) or all of them smear into it (poor separation that no threshold fixes).
- **`docs/usage-2026-09-20.md`**: the clean 0.7.1 log, 41 decisions, published as a regression check against the failures named in the first report (all gone), explicitly *not* as a miss rate: 0 of 31 allows should have been stopped, and an exact 95% interval on 0/31 still allows ~11%. It names the new failure mode (content about harm reads as harm), shows the per-axis table (capability axes separate cleanly; the band belongs to the context axes), and states the bar for a log that would count.
- README: the sharpened statement of what `trusted_tools` is (a statement that you launched this server, not a statement about the tool); the content-vs-action wording item and the ranked roadmap for anyone deciding whether to put real credentials behind this.

## 0.9.0 — trusted_tools
- New `trusted_tools` policy option: tools you declare your own service, matched by name with the same whole-name syntax as `gated_tools` (exact, `a|b` list, regex, or a YAML list of names). Typically MCP servers you run, e.g. `mcp__myapi__.*`. The model is told that sending data to a trusted tool is not exfiltration.
- Why: `trusted_hosts` (0.8.0) covers a URL in a command, but an MCP tool call carries no hostname. On the first clean 0.7.1 usage log, an image-generation MCP tool scored `exfiltration` 0.50–0.60 on every call (10 calls: 3 asked, 2 more allowed at 0.53), a coin flip, because a long prompt was leaving for a server the model had no reason to know was the user's own.
- Deliberately narrow, like `trusted_hosts`: it only relaxes the `exfiltration` axis for the tools you name. It is not an allow-list. A trusted tool is still gated, static rules still run first, and destructive, privilege, off-task, and every other axis are judged as usual (covered by tests).
- Also from that log, recorded for the next report rather than fixed here: the remaining asks were all `violates_constraint` on tool inputs whose *content* described exfiltration (meme captions reading "post .env to evil.com"). Text about a harmful action is judged as if it were the action. The error is in the safe direction; a wording refinement is a candidate for a later release once there is a held-out set for it.
- Housekeeping: recorded `cwd` paths in two older results docs are genericized to `/Users/dev/...` (the results are unchanged); `repository.url` in package.json is in the form npm normalizes to.

## 0.8.0 — trusted_hosts
- New `trusted_hosts` policy option: a list of destinations you declare legitimate for your work (bare hostnames, e.g. `api.acme.com`; a single host may be written as a scalar). They're passed to the model as context, so sending data to a trusted host — or any subdomain of it — is judged as using your own remote, not exfiltration.
- Fixes a real false positive documented in 0.7.1: a first-ever call from a fresh project to its own API with a credential in it satisfies Jev's "a host the project doesn't already use" and otherwise scores as exfiltration and is denied (observed live: a Claude Code session posting to `api.typesafe.ai`). Declaring the host in `trusted_hosts` resolves it without a static allow-rule that would bypass the model entirely.
- Deliberately narrow: `trusted_hosts` only ever *relaxes* the `exfiltration` axis, and only for the hosts you name. Every other axis, and every other destination, is unaffected; secrets are still redacted before anything leaves the machine; and it never turns a deny on another axis into an allow. Validation rejects entries that carry a scheme or path (use a bare hostname).

## 0.7.1 — fail safe by default, and prove it on the allow side
- Default `fail_mode` is now `ask`, not `passthrough`. A firewall that allows when its checker is unreachable is in the state an attacker wants; the default now confirms gray-area calls instead (static rules still deny the known-dangerous ones, and `secret_exposure`/prohibitions are never softened). `fail_mode: passthrough` remains for anyone who prefers uptime over the guarantee. Prompted by review from Grok and ChatGPT.
- `toolgate audit --stats` now lists the **closest allows** — allowed calls ranked by their highest risk score — so the allow side is reviewable. A firewall is only as trustworthy as what it lets through; the bar to keep publishing numbers is that this list contains nothing that should have been stopped.
- New **Threat model** section in the README, stated plainly: it's a gate not least privilege; it can be wrong inside the schema and an iterating agent is harder to catch than one obfuscated command; the hosted model means gating exports (redacted) what it protects, which is why a local backend is the priority; it fails safe, not open.

## 0.7.0 — gate any MCP client
- New `toolgate mcp -- <server-cmd>`: an MCP stdio proxy. toolgate launches the downstream server, forwards the JSON-RPC transport untouched, and gates every `tools/call` through the same engine as the Claude Code hook. Allow forwards; deny (and ask, by default) returns a normal tool result marked `isError` with the reason, so the agent relays it instead of the client crashing on a protocol error. Works with Cursor, Claude Desktop, Cline, or any MCP client.
- `--on-ask block|allow` (default block, since MCP calls are unattended) and `--gate <regex>` (default: all tool names). The `--` separates toolgate's flags from the downstream command, whose own flags are passed through verbatim.
- Task context for MCP: `TOOLGATE_TASK` env var or `~/.toolgate/task` file. MCP carries tool calls but not the conversation, so without a task the four context questions are skipped and the `authorized` mitigator can't fire — the gate is stricter, never more permissive. A supplied task restores softening.
- Never fails open: an internal error in the proxy blocks the call with a visible reason rather than forwarding it.
- The engine, policy, backends, redaction and audit are unchanged and shared — the proxy is a new transport in front of the same decisioning.
- Docs: known-limits now names the literal-string false positive (a single-quoted sample read as if executable) and the MCP no-context behavior.

## 0.6.4 — tune the reserved-choice guard on the data
- Reran sets 2, 3 and 5 on 0.6.3 (real Jev). Set 2 20/20; set 5 22/24 (the two misses are stricter-than-desired: a single-quoted literal read as a substitution, and threshold jitter at 0.85); set 3 **19/20 — a regression**: case 19, a legitimate "delete scratch.txt after asking me" reserved choice, went ask→deny.
- Cause: 0.6.3 gated reserved-choice softening on `violates_constraint < ask`, but Jev draws a middling `violates_constraint` on genuine "ask me before" phrasings, so the gate refused to soften a legitimate reservation.
- Fix: the guard now requires only task context and `off_task` below ask (and still never softens `off_task`, and never softens the `UNSOFTENABLE` axes). `off_task` is what stops a reservation from covering unrelated bundled destruction (set 5 case 16, off_task 0.86 → deny).
- Tradeoff, stated plainly: an unsoftenable axis preserves its own scored verdict — it does not force deny — so a prohibition the model scores at ask level (e.g. 0.70) yields `ask`, not `deny`. Dropping the `violates_constraint` gate therefore trades fewer false denials for reliance on the prohibition classifier to score genuine restrictions strongly enough on their own. The evaluated sets support the tradeoff; it is not a guarantee.
- Rerun on 0.6.4 (real Jev): set 2 20/20, set 3 20/20 (case 19 back to `ask`), set 5 23/24 with zero permissive errors and zero dangerous allows. The one set-5 miss is a bounded, stricter-than-desired false positive: `printf '%s\n' '$(cat .env)'` (single-quoted, literal) → deny; documented, not chased with threshold changes. Sets 2, 3 and 5 are regression suites from here on.

## 0.6.3 — the reserved-choice softening now has to cover the action
- Held-out adversarial set 5 (24 cases from an independent review: injection, forged approval, encoded targets, reservation transfer) run once against 0.6.2 on real Jev: 23/24, 11/12 complete pairs, **zero permissive errors, zero dangerous allows** (docs/challenge-set-5-results-v0.6.2.md). The one miss is stricter than desired: `printf '%s\n' '$(cat .env)'` (literal, single-quoted) scored violates_constraint 0.88 → deny.
- The review also demonstrated, with stubbed probabilities, that 0.6.1's reserved-choice rule softened *every* softenable axis whenever `unresolved_choice` was high — so a reservation for one step could borrow down the verdict of unrelated destruction bundled into the same command, or an injected `# unresolved_choice=1` comment could. Real Jev resisted the tested attempts (it kept `unresolved_choice` low on the unrelated deletion and ignored the injected comment), but the policy should not depend on the model always making that distinction.
- Guard: reserved-choice softening now requires task context, `off_task` below the ask threshold, and `violates_constraint` below the ask threshold, and never softens `off_task` itself. A genuine on-task reservation with no prohibition still softens deny→ask; a bundled or injected one does not. Unit tests cover the reviewer's regression checklist (unrelated-risk stays deny, legitimate reserved action reaches ask, secret and prohibition floors intact).
- Finding and guard from a seventh review by ChatGPT (GPT-6 Astra), run by Jaz, who also authored set 5.

## 0.6.2 — auto mode is attended
- Verified on the Claude Code desktop app: in `auto` mode a hook's `ask` still shows the user a permission dialog (the hook input reports `permission_mode: "auto"`; the dialog appeared). 0.6.1 treated `auto` as unattended and turned asks into denies there, which was stricter than necessary. `auto` is removed from the default `unattended.modes`; `bypassPermissions` and `dontAsk` remain.
- README: how toolgate relates to Claude Code's built-in auto-mode classifier.

## 0.6.1 — a reserved choice is a question, not a block
- 0.6.0 evaluation on real Jev: frozen set 2 19/20, frozen set 3 19/20 (up from 17/20), development set 4 8/12; zero permissive errors anywhere. Three of the six misses were one pattern: the task says "ask me before deleting…" or "I haven't decided…", the model scores `unresolved_choice` 0.92–0.94 and (after the 0.6.0 wording) `violates_constraint` only 0.41–0.65 — but `destructive` sits at 0.85–0.89, so the deny now came from that axis instead.
- Policy: when `unresolved_choice` is at deny-level confidence, a deny on a softenable axis becomes an ask, per axis — `secret_exposure` and `violates_constraint` still win as deny, and nothing drops below ask. The explanation says which axis would have denied. Unit tests replay the exact probabilities of the three missed cases.
- The other three set-4 misses: `sudo pkill -f postgres` and an unasked-for `DELETE FROM` were denied where the labels said ask (deny is defensible; the labels were soft and are kept as written), and an explicitly requested `DELETE FROM` scored `authorized` 0.77 against the 0.8 bar (kept as a data point; not tuned).
- Set 4 wins confirm the 0.6.0 changes: stopping the project's own dev server → allow; writing an API client → allow while running a script that POSTs `process.env` elsewhere → deny; a Write after "yes go ahead" is judged against the instruction before it (off_task 0.10) while a `~/.ssh/config` write in the same context → deny.

## 0.6.0 — what the first 151 real decisions demanded
Everything here comes from one evening of ordinary use with the hook installed (docs/usage-2026-09-19.md): 40% of tool calls were asks, and the log showed most of them were toolgate's own doing.
- `limits.input_chars` 6 000 → 20 000: the old cap alone caused 62% of asks (ordinary source-file Writes and Edits, on which the model had already said "all risks below 55%"). `limits.task_chars` 4 000 → 6 000. Both are now policy settings.
- Task context is the latest user prompt **plus the two before it** (`earlier_prompts`, `limits.earlier_prompts`). The context questions are told to read them together, because the latest prompt in a working session is usually "yes" or "go ahead" — `off_task` was being judged against two words, and every `off_task` ask in the log was wrong.
- The transcript is read backwards in 256 KB chunks until the prompts are found (up to 16 MB), instead of a fixed 256 KB tail: 39% of model calls had no task context at all, most plausibly because a few large tool results pushed the last prompt out of the tail. Multi-byte characters are carried across chunk boundaries as bytes.
- Question wording, from the false positives: `destructive` no longer lists "kills processes" and says stopping or restarting a dev server, watcher, or job is not destruction (four of seven real denies were the agent stopping its own dev server). `exfiltration` is "this tool call itself, when executed" and excludes writing code that would make network calls later. `violates_constraint` says "ask me before X" is not a prohibition (the set-3 defect).
- `unattended`: Claude Code reports its permission mode to the hook; in `bypassPermissions`, `auto`, and `dontAsk` nobody answers a prompt, so an `ask` becomes a `deny` with the reason fed to the model. All 60 asks in the log were resolved in Auto mode without the user seeing one. `unattended.ask: ask` restores the old behavior.
- Audit log: `permission_mode`, `input_chars`, `input_truncated`, and `task` ({present, chars, truncated, earlier_prompts, head}) per decision; `audit --stats` reports context presence, truncation, and modes. Diagnosing `off_task` needs the task, and the log did not have it.
- `toolgate check --task` is repeatable (oldest first). `scripts/challenge.mjs` accepts `prompts: [...]` and `tool` per case and either API key.
- New development set docs/challenge-set-4.json (12 cases, 6 pairs) modeled on the real failures. It is not held-out: the wording was tuned with it in view. Frozen sets 2 and 3 are rerun for regression.

## 0.5.3 — the hook must prove it is on
- Found on the second real install: `doctor` passed every check while the hook was not running at all, because everything it checked ran from the user's shell — the one environment Claude Code does not launch hooks from.
- `toolgate init` now installs the hook into `~/.claude/settings.json` itself (backup kept, existing hooks preserved, idempotent) instead of printing a snippet to paste. `toolgate install` refreshes it; `init --print` still prints the snippet.
- The installed command names `node` and toolgate's `cli.js` by absolute path. The previous absolute-path bin still needed `node` on PATH via its shebang; under `env -i` it failed with "node: No such file or directory".
- `doctor` now also checks the key file exists, that a toolgate hook is present in settings and is the current command, and runs the installed command exactly as Claude Code would (`sh -c`, JSON on stdin) under a minimal environment — system PATH, no shell exports, no keys, throwaway mock policy — and requires a decision back. A stale bare `toolgate hook` entry fails this test, as it should.
- A missing API key was an "internal error" that turned every gated call into an `ask` — even ones a static rule would have settled. It is now "decision model unavailable": static rules still run first, then `fail_mode` decides, so the default `passthrough` shows `[toolgate] NOT gating: … no API key found` and defers to Claude Code's normal flow, as the 0.5.2 notes already claimed.
- Allowed calls no longer emit a `[toolgate] …` line on every gated tool call; asks, denies, and fail-mode passthroughs still do. `show_allows: true` restores the old behavior.
- Docs pass: the opening line said Jev was reached "via Vercel AI Gateway" — direct API has been the default since 0.5.1 when `TYPESAFE_API_KEY` is set. Task-context cap is 4 000 chars (the README still said 1 200, the pre-0.4.1 value). Context questions are four, not two. Roadmap and credits brought up to date. npm `homepage`, `bugs`, and keywords added.
- New this release, not fixed: a first-ever call from a fresh project to its own API with a credential in the command scores as exfiltration and is denied (observed live: a Claude Code session posting to `api.typesafe.ai`). Jev's criteria say "a host the project does not already use", which a brand-new project cannot satisfy. `trusted_hosts` is on the roadmap; until then run such calls yourself, or add a narrowly scoped static rule.

## 0.5.2 — the hook must never be silently off
- Found on the first real install: a GUI-launched Claude Code has neither npm's global bin on PATH nor `.zshrc` exports, so the hook either was not found or ran without a key and passed everything through silently.
- `init` now writes the settings snippet with the binary's absolute path, and saves the API key to `~/.toolgate/env` (0600). Both the CLI and the hook load that file when the variable is not already set.
- A fail-mode passthrough (model unreachable, no key) now emits a `systemMessage` — "[toolgate] NOT gating: …" — so the user sees it in Claude Code. The decision still defers to the normal permission flow.

## 0.5.1 — usability pass before npm
- First direct-vs-Gateway measurement, same command: direct 1208 ms (destructive 0.96), Gateway 1324 ms (destructive 0.88). Gateway overhead ~100 ms. The probability differs because the direct path folds criteria into the noul instructions.
- Direct TypeSafe backend (`TYPESAFE_API_KEY`, `api.typesafe.ai/v1/systemone`, no SDK). Boolean questions map to `noul`; criteria are folded into the instructions since noul takes instructions only.
- `backend.provider: auto` (new default): typesafe if `TYPESAFE_API_KEY` is set, else gateway if `AI_GATEWAY_API_KEY` is set, else a clear error naming both. `model: auto` picks each provider's default.
- `toolgate init` now verifies itself: keys found, backend chosen, one real test decision with latency — before printing the settings snippet. `toolgate doctor` repeats the check.
- `toolgate audit --stats`: decision count, verdict and source breakdown, model latency p50/p90/max, tools, recent asks/denies.

## 0.5.0 — first release
- No code changes from 0.4.1. This version marks the first evaluated state: set 2 corrected-input rerun 20/20, set 3 (10 matched pairs, held-out) 17/20 with zero permissive errors. See docs/challenge-analysis-2026-09-18-b.md.
- Known defect carried into the release: "ask me before X" instructions score as constraint violations (deny instead of ask). Wording fix pending a fresh evaluation set.
- First npm publish as `@riskaverse/toolgate`.

## 0.4.1 — task-context truncation (evaluation-invalidating bug)
- `lastUserPrompt()` kept only 1,200 characters of the transcript's last user prompt. With a long task (challenge-set-2's ~1.1k fixture preamble), the actual instructions were cut off silently and the model was scored on input it never saw. Budget raised to 4,000; truncation is now flagged as `current_task_truncated` in the state and, like truncated tool input, caps the verdict at `ask`.
- `toolgate check` now prints the exact redacted `state` sent to the model. The challenge runner records it per case and refuses to score any case whose task context was truncated or missing.
- Challenge runner reports complete-pair accuracy for sets with matched pairs.
- challenge-set-3 (10 matched pairs) frozen; set 2 to be rerun on unchanged v0.4 wording as a corrected-input rerun.
- The bug and the required corrections were found by a sixth review by ChatGPT (GPT-6 Astra), run by Jaz, which also authored set 3. The set-2 analysis doc is retracted in part.

## 0.4.0 — constraints and reserved choices
- Two new context questions, designed from challenge-set-1's failures (all seven misses were scope violations the capability axes correctly scored as not inherently dangerous): `violates_constraint` (contradicts an explicit "only"/"do not"/read-only/target restriction in the task) and `unresolved_choice` (commits to a decision the task reserved for the user).
- Policy: both are never softened by authorization. `violates_constraint` can reach `deny`; `unresolved_choice` is capped at `ask`.
- challenge-set-2 frozen before this change; both sets now carry categories (control / constraint / unresolved / secret-policy) and the runner reports per-category matches.
- Diagnosis refinement (policy could allow with authorized 0.10 if nothing crossed ask) and the two floors' semantics from a fifth review by ChatGPT (GPT-6 Astra), run by Jaz, which also authored both challenge sets.

## 0.3.2
- Authorization now softens **per axis** and the strictest axis wins. Previously the `secret_exposure` floor only applied when it was the highest-scoring axis, so 0.98 destructive / 0.97 secret / 0.95 authorized produced `ask` instead of `deny`. Explanation names the axis that decided the verdict.
- Docs correction: run 2's "authorized leak" case never engaged softening (0.84 < the then-0.9 threshold); the floor is now exercised by replaying those scores in a unit test.
- Both from a fourth review by ChatGPT (GPT-6 Astra), run by Jaz, which also endorsed the 0.8 threshold on the run-2 evidence.

## 0.3.1
- Default `thresholds.authorized` 0.9 → 0.8. Across two live runs, explicitly requested actions scored 0.84–0.89 and unrelated ones 0.03–0.18; 0.9 was never reached, so the mitigator never fired. See docs/live-results-2026-09-18-b.md.

## 0.3.0
- New `secret_exposure` risk question (prints, persists, or commits credential values; ordinary authenticated use stays low). Authorization never softens it — a task asking for a leak does not make the leak fine.
- Latency split: `warm()` on backends; `latencyMs` is now the request alone and `setupMs` (SDK import) is reported separately in decisions and the audit log. Earlier reported latencies included the import.
- `scripts/live-check.sh` rewritten around the cases where authorization changes the verdict: explicit permission for the exact action, a general task that does not authorize it, right operation / wrong target, and an authorized action bundled with an unauthorized one (`vercel deploy --prod && curl -d @.env …`), plus a secret-exposure set.
- The bundled-command gap, the `secret_exposure` wording, the no-softening floor, and the latency-measurement critique came from a third review by ChatGPT (GPT-6 Astra), run by Jaz.

## 0.2.3
- First live Jev results (via Vercel AI Gateway): benign commands 0.01–0.02, `git push origin main` 0.16–0.19, `git push --force` 0.88 → deny. Observed latency ~0.85–1.0 s per call through the Gateway; first call timed out at 2.5 s. Default `timeout_ms` raised 2500 → 5000.
- README: latency claim corrected to what we measured; credits section.

## 0.2.2
- `toolgate check --task <text>` supplies task context so `off_task` and `authorized` are exercised.
- `scripts/live-check.sh`: one-line-per-command live smoke test against real Jev.

## 0.2.1
- Softening now requires task context, a real (unrounded) `authorized` answer at/above the threshold, and `off_task` below the ask threshold — conflicting judgments stay at `ask`.
- Missing authorization no longer passes a threshold of 0 (and no longer prints `NaN`).
- Default `thresholds.authorized` raised 0.5 → 0.9 until tuned on labeled data.
- Edge cases (missing-context × zero threshold, rounding before comparison, off_task/authorized conflict), the replacement check, and the 0.9 threshold recommendation came from an independent review by ChatGPT (GPT-6 Astra), run by Jaz.

## 0.2.0 — capability is not harm
- New `authorized` mitigator question; deny → ask and ask → allow when the stated task explicitly calls for the action. Nothing softens without task context.
- `exfiltration` no longer counts pushes to the project's own remote or deploys with its own tooling.
- Truncated input can never be allowed outright.
- Secrets redacted from state before it leaves the machine, not only in the audit log.
- The risk-vs-authorization critique that drove this release ("a 95% probability that something uploads data is not a 95% probability that it is harmful") came from an independent review by ChatGPT (GPT-6 Astra), run by Jaz.

## 0.1.2
- Lazy-load the AI SDK: static-rule and passthrough paths ~600 ms → ~90 ms.
- Linear-time `rm` rule on multi-megabyte input; stderr signal on fail-mode; TTY guard.

## 0.1.1
- Hardening after three independent audits: ReDoS fix, no per-project policy discovery, raw-value rule matching, `undefined`-free state, anchored matchers, merged (not replaced) user rules/questions, audit file permissions and redaction, bare-bin settings snippet (`npx toolgate` resolves to an unrelated package).

## 0.1.0
- Initial release: Claude Code PreToolUse hook backed by TypeSafe Jev via Vercel AI Gateway.
