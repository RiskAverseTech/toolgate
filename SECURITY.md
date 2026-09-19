# Security policy

toolgate is a tool-call firewall for AI coding agents. It is **defense in depth, not a sandbox**: it shrinks the blast radius of mistakes and prompt injection, and it does not replace containers, least-privilege credentials, or human review. A sufficiently adversarial input can fool any classifier — which is why static rules run first, every decision is logged with its probabilities, and the design fails safe.

## Reporting a vulnerability

Please report suspected vulnerabilities privately, not in a public issue.

- Preferred: open a private report via GitHub Security Advisories — <https://github.com/RiskAverseTech/toolgate/security/advisories/new>.
- Or email **security@riskaversetechcompany.com** with "toolgate" in the subject.

Include what you found, the version (`toolgate --help` shows it; or the npm/git version), a minimal way to reproduce, and the impact you expect. A classification transcript (`toolgate check --tool … --input=… --task …`, which never executes the command) is the most useful attachment.

We aim to acknowledge within a few business days. This is a small open-source project maintained by one person, so timelines are best-effort, not contractual. We will confirm the issue, agree on a disclosure timeline with you, fix it, and credit you in the changelog and advisory unless you prefer otherwise.

## What is in scope

- A verdict that is **more permissive than the policy intends** — the important class. Above all, any input that causes a genuinely dangerous action to be **allowed** (not merely asked), including via prompt injection in the tool input or task text, encoding/obfuscation, or gaming the `authorized` / `unresolved_choice` mitigators.
- Secrets leaking despite redaction — a credential value reaching the decision model, the audit log, or any output.
- The gate silently taking itself offline — any path where the hook fails **open** (a silent allow) instead of failing to a visible `ask`.
- Policy trust violations — a cloned repository or project directory reconfiguring the firewall, or the policy/key files being read or written outside their intended trusted locations.
- ReDoS or other denial of service in the static-rule matching or state building.

## What is not a vulnerability

- The model returning a **stricter** verdict than desired (a false positive / unnecessary `ask` or `deny`). These are quality issues — file a normal issue with the case.
- Classifier judgment calls on genuinely ambiguous commands. toolgate is probabilistic; it is expected to be imperfect, and the evaluation sets in `docs/` document known limits.
- Anything requiring the attacker to already control the trusted policy file (`~/.toolgate/toolgate.yaml`), the key file (`~/.toolgate/env`), or the agent's own configuration — that is game-over independent of toolgate.
- Weaknesses in TypeSafe's Jev or the Vercel AI Gateway themselves; report those to the respective vendors.

## Supported versions

Only the latest published version on npm (`@riskaverse/toolgate`) receives fixes. toolgate is pre-1.0 and moves fast; please reproduce on the current version before reporting.

## What leaves your machine

Only the model path sends anything out, and only to the decision backend you configured (TypeSafe's API, or the Vercel AI Gateway). It sends the tool name, the tool input (secrets redacted, truncated), the cwd, the permission mode, and the last few user prompts (redacted). Static rules and passthroughs send nothing. Redaction catches common secret shapes, not every secret — treat it as a courtesy, not a guarantee — so review `docs/` and your backend's data-retention policy before sending sensitive tool calls through a hosted model.
