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

/** A pluggable decision model. Jev via Vercel AI Gateway is the reference implementation. */
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
  backend: { provider: 'gateway' | 'mock'; model: string; timeout_ms: number };
  /** What to do when the decision model errors or times out. */
  fail_mode: 'passthrough' | 'ask' | 'deny';
  /** authorized: P(task calls for this action) at/above which risk is softened one step. */
  thresholds: { deny: number; ask: number; authorized: number };
  /** Static rules run first, in order; first match wins. User rules precede the built-ins. */
  rules: StaticRule[];
  /** Tools the model evaluates (whole-name matcher). Others pass through untouched. */
  gated_tools: string;
  /** Read the current task from the transcript so `off_task` has context. */
  include_task_context: boolean;
  audit: { enabled: boolean; path: string; log_input: boolean };
  /** Risk questions; user questions are merged over the built-ins. */
  questions: Questions;
}
