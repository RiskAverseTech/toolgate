# Changelog

## 0.2.2
- `toolgate check --task <text>` supplies task context so `off_task` and `authorized` are exercised.
- `scripts/live-check.sh`: one-line-per-command live smoke test against real Jev.

## 0.2.1
- Softening now requires task context, a real (unrounded) `authorized` answer at/above the threshold, and `off_task` below the ask threshold — conflicting judgments stay at `ask`.
- Missing authorization no longer passes a threshold of 0 (and no longer prints `NaN`).
- Default `thresholds.authorized` raised 0.5 → 0.9 until tuned on labeled data.
- Edge cases, fix, and threshold recommendation contributed by REVIEWER_CREDIT.

## 0.2.0 — capability is not harm
- New `authorized` mitigator question; deny → ask and ask → allow when the stated task explicitly calls for the action. Nothing softens without task context.
- `exfiltration` no longer counts pushes to the project's own remote or deploys with its own tooling.
- Truncated input can never be allowed outright.
- Secrets redacted from state before it leaves the machine, not only in the audit log.
- The risk-vs-authorization critique that drove this release came from REVIEWER_CREDIT.

## 0.1.2
- Lazy-load the AI SDK: static-rule and passthrough paths ~600 ms → ~90 ms.
- Linear-time `rm` rule on multi-megabyte input; stderr signal on fail-mode; TTY guard.

## 0.1.1
- Hardening after three independent audits: ReDoS fix, no per-project policy discovery, raw-value rule matching, `undefined`-free state, anchored matchers, merged (not replaced) user rules/questions, audit file permissions and redaction, bare-bin settings snippet (`npx toolgate` resolves to an unrelated package).

## 0.1.0
- Initial release: Claude Code PreToolUse hook backed by TypeSafe Jev via Vercel AI Gateway.
