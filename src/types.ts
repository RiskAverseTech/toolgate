/** Boolean question, mirroring the AI SDK 7 evaluation modality (experimental_evaluate). */
export interface BooleanQuestion {
  type: 'boolean';
  instructions: string;
  criteria?: { true: string; false: string };
}
export type Questions = Record<string, BooleanQuestion>;

export interface BooleanAnswer {
  type: 'boolean';
  /** Model-estimated P(true) in [0, 1]. */
  probability: number;
}
export type Answers = Record<string, BooleanAnswer>;

export type JSONValue = string | number | boolean | null | JSONValue[] | { [key: string]: JSONValue };
export type JSONObject = { [key: string]: JSONValue };

/** A pluggable decision model. TypeSafe's Jev (direct API, or via Vercel AI Gateway) is the reference implementation. */
export interface DecisionBackend {
  readonly name: string;
  evaluate(state: JSONObject, questions: Questions, opts?: { timeoutMs?: number }): Promise<Answers>;
  /** Optional one-time setup (e.g. loading an SDK) so latencyMs measures the request alone. */
  warm?(): Promise<void>;
}

/** Claude Code PreToolUse hook input (the fields toolgate uses). */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  agent_id?: string;
  agent_type?: string;
  tool_name: string;
  tool_input: unknown;
}

export type DecisionAction = 'allow' | 'ask' | 'deny';
/** 'passthrough' = toolgate expresses no opinion; the agent's normal permission flow applies. */
export type Verdict = DecisionAction | 'passthrough';

export interface Decision {
  verdict: Verdict;
  reason: string;
  source: 'static-rule' | 'model' | 'fail-mode' | 'no-opinion';
  /** Per-question probabilities, when source === 'model'. `authorized` is a mitigator, not a risk. */
  probabilities?: Record<string, number>;
  /** Model request time only. */
  latencyMs?: number;
  /** One-time backend setup (SDK import) paid before the request, when source === 'model'. */
  setupMs?: number;
  /** The exact (redacted, truncated) state sent to the model, when source === 'model'. Not written to the hook output. */
  state?: JSONObject;
}

export interface StaticRule {
  match: {
    /** Tool name matcher: exact, pipe-separated list, or regex. Always whole-name. */
    tool?: string;
    /** Regex tested (case-insensitively) against the tool input's values with quotes stripped. */
    input_regex?: string;
  };
  action: DecisionAction;
  reason?: string;
}

export interface Policy {
  /** auto = typesafe if TYPESAFE_API_KEY is set, else gateway if AI_GATEWAY_API_KEY is set. */
  backend: { provider: 'auto' | 'typesafe' | 'gateway' | 'mock'; model: string; timeout_ms: number };
  /** What to do when the decision model errors or times out. */
  fail_mode: 'passthrough' | 'ask' | 'deny';
  /** authorized: P(task calls for this action) at/above which risk is softened one step. */
  thresholds: { deny: number; ask: number; authorized: number };
  /** Built-in static rules (the floor). Evaluation order: built-in denies, then `user_rules`, then the remaining built-ins. */
  rules: StaticRule[];
  /** Rules from the policy file. They can override a built-in `ask`, never a built-in `deny`. */
  user_rules: StaticRule[];
  /** Tools the model evaluates (whole-name matcher). Others pass through untouched. */
  gated_tools: string;
  /**
   * Destinations you declare legitimate for this project (hostnames, e.g. `api.acme.com`).
   * Passed to the model as context: sending data to a trusted host (or a subdomain of it) is
   * not exfiltration, even on a first-ever call with a credential in it. Empty by default.
   */
  trusted_hosts: string[];
  /**
   * Tools you declare your own service (whole-name matcher like `gated_tools`: exact, `a|b` list,
   * or regex; in YAML a list of names is also accepted). Typically MCP servers you run, e.g.
   * `mcp__myapi__.*`. Passed to the model as context: sending data to a trusted tool is not
   * exfiltration. Every other risk of the call is judged as usual. Empty by default.
   */
  trusted_tools: string;
  /** Read the current task from the transcript so `off_task` has context. */
  include_task_context: boolean;
  /** Show a "[toolgate] all risks below …" line on allowed calls too. Off by default: asks and denies are always shown. */
  show_allows: boolean;
  /**
   * How much the model sees. Input beyond `input_chars` is cut (head + tail) and the verdict
   * can then be no better than `ask`; the latest user prompt beyond `task_chars` likewise.
   * `earlier_prompts`: how many user prompts before the latest to include as context, so a
   * "yes" or "continue" is read together with the instruction it continues.
   */
  limits: { input_chars: number; task_chars: number; earlier_prompts: number };
  /**
   * In these Claude Code permission modes nobody answers a prompt, so an `ask` would be
   * auto-resolved. `unattended.ask` says what an ask becomes there: `deny` (the model is told
   * why and stops) or `ask` (unchanged). `auto` mode is NOT unattended: verified on the desktop
   * app, a hook's ask still shows the user a permission dialog there.
   */
  unattended: { modes: string[]; ask: 'ask' | 'deny' };
  audit: { enabled: boolean; path: string; log_input: boolean };
  /** Risk questions; user questions are merged over the built-ins. */
  questions: Questions;
}
