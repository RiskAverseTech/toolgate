// toolgate as a Claude Code mod.
//
// The engine stays in the toolgate CLI (`npm install -g @riskaverse/toolgate`); this module is the
// glue between Claude Code's events and that CLI:
//
//   tool.check  → `toolgate decide`  the verdict: allow runs the tool, ask goes to the mode's decider
//                                    (the dialog, or the auto-mode classifier), deny refuses it with
//                                    the reason the model reads. A write is proposed to the ledger.
//   tool.call   → `toolgate post`    after the tool ran: settles the ledger entry (confirmed, failed,
//                                    denied), so a later `bash helper.sh` is judged as what helper.sh
//                                    does. No model call.
//   /toolgate                         the audit log's summary and the session's counts.
//
// Task context comes from the session's own transcript ($.session.messages()), so the off_task,
// violates_constraint, unresolved_choice and authorized axes see the real prompts, not a file path.
// The module never sees tool output, so text the agent read cannot argue for its own approval.
//
// If the CLI is missing, the mod says so loudly and steps aside: Claude Code's own rules, mode and
// classifier still apply; nothing becomes more permissive than it was without the mod.
import type { Register } from 'claude-code'

type Verdict = 'allow' | 'ask' | 'deny' | 'passthrough'

type Decision = {
  verdict: Verdict
  reason?: string
  source?: string
  latencyMs?: number
  probabilities?: Record<string, number>
}

const EARLIER_PROMPTS = 2
const GOAL_MIN_CHARS = 40
const DECIDE_TIMEOUT_MS = 20_000
const POST_TIMEOUT_MS = 10_000

// Session counters: these reset on a hot reload, which is fine for a status line.
const counts = { allow: 0, ask: 0, deny: 0, passthrough: 0, errors: 0 }
let active = false
let inactiveReason = ''
let lastLatencyMs: number | undefined

function statusLine(): string {
  if (!active) return `toolgate: off (${inactiveReason})`
  const ms = lastLatencyMs === undefined ? '' : ` · ${lastLatencyMs} ms`
  return `toolgate · allow ${counts.allow} · ask ${counts.ask} · deny ${counts.deny}${ms}`
}

/** The user's prompts as toolgate wants them: current, the ones before (oldest first), the opening request. */
function taskContextFrom(messages: ReadonlyArray<{ role: string; text: string }>) {
  const prompts = messages.filter((m) => m.role === 'user' && m.text.trim().length > 0).map((m) => m.text)
  if (prompts.length === 0) return undefined
  const current_task = prompts[prompts.length - 1]
  const earlier_prompts = prompts.slice(Math.max(0, prompts.length - 1 - EARLIER_PROMPTS), prompts.length - 1)
  const session_goal = prompts.find((p) => p.length >= GOAL_MIN_CHARS)
  return { current_task, earlier_prompts, session_goal }
}

function parseDecision(stdout: string): Decision | undefined {
  try {
    const d = JSON.parse(stdout) as Decision
    return d && typeof d.verdict === 'string' ? d : undefined
  } catch {
    return undefined
  }
}

export const register: Register = (on, options) => {
  const binary = typeof options.binary === 'string' && options.binary.length > 0 ? options.binary : 'toolgate'
  const shadow = options.mode === 'shadow'
  const keyEnv: Record<string, string> = {}
  if (typeof options.typesafe_api_key === 'string' && options.typesafe_api_key.length > 0) keyEnv.TYPESAFE_API_KEY = options.typesafe_api_key
  if (typeof options.openrouter_api_key === 'string' && options.openrouter_api_key.length > 0) keyEnv.OPENROUTER_API_KEY = options.openrouter_api_key

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'toolgate', description: 'toolgate: audit summary and this session’s verdict counts' })
    try {
      const probe = await $.process.run([binary, 'version'], { timeoutMs: 10_000 })
      if (probe.exitCode === 0) {
        active = true
      } else {
        inactiveReason = `${binary} exited ${probe.exitCode}`
      }
    } catch {
      inactiveReason = `${binary} not found; npm install -g @riskaverse/toolgate, or set the command in /config`
    }
    if (!active) $.ui.toast(`toolgate is not gating: ${inactiveReason}`)
    // The settings.json hook (toolgate init) and this mod gate the same calls: both installed means
    // every call is decided twice. Say so once; the person picks one.
    try {
      const settings = (await $.settings.read()) as { hooks?: { PreToolUse?: Array<{ hooks?: Array<{ command?: string }> }> } }
      const hooked = (settings.hooks?.PreToolUse ?? []).some((m) => (m.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes('toolgate')))
      if (hooked && active) $.ui.toast('toolgate: the settings.json hook is installed too; calls will be decided twice. Keep the mod or the hook, not both.')
    } catch {
      // settings unreadable: nothing to warn about
    }
    $.ui.status(statusLine())
    return next(e)
  })

  // The verdict. Runs for every tool, before the permission mode settles an ask.
  on('tool.check', async ($, e, next) => {
    if (!active) return next(e)
    let decision: Decision | undefined
    try {
      const [session_id, cwd, messages] = await Promise.all([$.session.id(), $.session.cwd(), $.session.messages()])
      const payload = {
        session_id,
        cwd,
        tool_use_id: e.tool_use_id,
        tool_name: e.tool,
        tool_input: e.input,
        task_context: taskContextFrom(messages),
      }
      const ran = await $.process.run([binary, 'decide'], { stdin: JSON.stringify(payload), env: keyEnv, timeoutMs: DECIDE_TIMEOUT_MS })
      decision = parseDecision(ran.stdout)
      if (!decision) throw new Error(ran.stderr.trim() || `no decision on stdout (exit ${ran.exitCode})`)
    } catch (err) {
      // The CLI itself answers `ask` on its own failures; this branch is the CLI not answering at all
      // (killed, timed out, missing). Same rule: never a silent allow.
      counts.errors += 1
      const why = err instanceof Error ? err.message : String(err)
      decision = { verdict: 'ask', reason: `toolgate could not decide (${why}); confirm manually`, source: 'fail-mode' }
    }
    if (decision.latencyMs !== undefined) lastLatencyMs = decision.latencyMs
    counts[decision.verdict] += 1
    $.ui.status(statusLine())
    if (shadow || decision.verdict === 'passthrough') return next(e)
    const reason = `[toolgate] ${decision.reason ?? decision.verdict}`
    return { decision: decision.verdict, reason }
  })

  // After the tool ran: settle the ledger entry. Best effort, never changes the result.
  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!active || e.tool_use_id === undefined) return ran
    const hook_event_name = ran.deny !== undefined ? 'PermissionDenied' : ran.isError === true ? 'PostToolUseFailure' : 'PostToolUse'
    try {
      const session_id = await $.session.id()
      const payload = { session_id, tool_use_id: e.tool_use_id, tool_name: e.tool, hook_event_name }
      await $.process.run([binary, 'post'], { stdin: JSON.stringify(payload), timeoutMs: POST_TIMEOUT_MS })
    } catch {
      // silent by design: an unsettled write only ever makes a later execution stricter
    }
    return ran
  })

  on('command.run', { command: 'toolgate' }, async ($) => {
    const header = `${statusLine()}${shadow ? ' · shadow mode (recording, not enforcing)' : ''}${counts.errors ? ` · ${counts.errors} not decided` : ''}`
    if (!active) return { text: header }
    try {
      const ran = await $.process.run([binary, 'audit', '--stats'], { timeoutMs: 10_000 })
      const body = (ran.stdout || ran.stderr).trim()
      return { text: body ? `${header}\n\n${body}` : header }
    } catch (err) {
      return { text: `${header}\n\naudit unavailable: ${err instanceof Error ? err.message : String(err)}` }
    }
  })
}
