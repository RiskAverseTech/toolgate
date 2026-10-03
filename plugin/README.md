# toolgate — the Claude Code mod

The [toolgate](https://github.com/RiskAverseTech/toolgate) firewall as a Claude Code mod: in-process, installed from a marketplace, keys in Claude Code's secure settings, hot-reloadable, and tested with `claude plugin test`.

The engine stays in the `toolgate` CLI. This mod is the wiring:

| Event | CLI | What happens |
|---|---|---|
| `tool.check` | `toolgate decide` | **allow** runs the tool · **ask** goes to the mode's decider (the dialog, or the auto-mode classifier) · **deny** refuses it with the reason the model reads · no opinion leaves Claude Code's own verdict. A write is proposed to the ledger. |
| `tool.call` (after) | `toolgate post` | Settles the ledger entry (confirmed, failed, denied), so a later `bash helper.sh` is judged as what helper.sh does. No model call. |
| `/toolgate` | `toolgate audit --stats` | The audit summary and this session's verdict counts. |

Task context comes from the session's own transcript (`$.session.messages()`), so the context axes see the real prompts. The mod never sees tool output.

## Install

```bash
npm install -g @riskaverse/toolgate          # the engine
claude plugin marketplace add RiskAverseTech/toolgate
claude plugin install toolgate@riskaverse
```

Claude Code asks for the plugin's settings when it enables the mod:

| Setting | Default | |
|---|---|---|
| TypeSafe API key | none | Secure storage. Or an OpenRouter key. Or neither, and the key `toolgate init` saved in `~/.toolgate/env` is used. |
| toolgate command | `toolgate` | A full path if Claude Code's PATH lacks your npm bin (`which toolgate`). |
| Mode | `enforce` | `shadow` records every verdict in the audit log and changes nothing. |

Requires Claude Code v2.1.287 or later with mods enabled. If the CLI is missing the mod says so and steps aside: Claude Code's own rules, mode and classifier still apply, and nothing becomes more permissive than it was without the mod.

## Develop

```bash
claude --plugin-dir ./plugin          # load from a checkout; edits hot-reload
npm run test:mod                      # claude plugin validate + claude plugin test
```

Policy, thresholds, rules and the ledger are the CLI's: `~/.toolgate/toolgate.yaml`, as for the hook. The settings.json hook (`toolgate init`) and the mod gate the same calls the same way; run one, not both.
