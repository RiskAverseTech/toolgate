/** Question shapes mirror the AI SDK 7 evaluation modality (experimental_evaluate). */

export interface BooleanQuestion {
  type: 'boolean';
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  criteria: string[]; // ordered lowest -> highest
}

export type Question = BooleanQuestion | ChoiceQuestion | ScoreQuestion;
export type Questions = Record<string, Question>;

export interface BooleanAnswer {
  type: 'boolean';
  probability: number;
}

export interface ChoiceAnswer {
  type: 'choice';
  choice: string;
  probabilities: Record<string, number>;
}

export interface ScoreAnswer {
  type: 'score';
  score: number;
  probabilities: Record<string, number>;
}

export type Answer = BooleanAnswer | ChoiceAnswer | ScoreAnswer;
export type Answers = Record<string, Answer>;

/** A pluggable decision model. Jev via Vercel AI Gateway is the reference implementation. */
export interface DecisionBackend {
  readonly name: string;
  evaluate(
    state: unknown,
    questions: Questions,
    opts?: { timeoutMs?: number },
  ): Promise<Answers>;
}

/** Claude Code PreToolUse hook input (the fields toolgate uses). */
export interface HookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  permission_mode?: string;
  hook_event_name?: string;
  tool_name: string;
  tool_input: unknown;
  tool_use_id?: string;
}

export type DecisionAction = 'allow' | 'ask' | 'deny';
/** 'passthrough' = toolgate expresses no opinion; the agent's normal permission flow applies. */
export type Verdict = DecisionAction | 'passthrough';

export interface Decision {
  verdict: Verdict;
  reason: string;
  /** What produced the verdict. */
  source: 'static-rule' | 'model' | 'fail-mode' | 'no-opinion';
  /** Name/index of the static rule, when source === 'static-rule'. */
  rule?: string;
  /** Per-question probabilities, when source === 'model'. */
  probabilities?: Record<string, number>;
  latencyMs?: number;
}

export interface StaticRule {
  match: {
    /** Tool name matcher: exact, pipe-separated list, or regex when it contains other chars. */
    tool?: string;
    /** Regex tested against the serialized tool input. */
    input_regex?: string;
  };
  action: DecisionAction;
  reason?: string;
}

export interface Policy {
  version: 1;
  backend: {
    provider: 'gateway' | 'mock';
    model: string;
    timeout_ms: number;
  };
  /** What to do when the decision model errors or times out. */
  fail_mode: 'passthrough' | 'ask' | 'deny';
  thresholds: {
    deny: number;
    ask: number;
  };
  /** Static fast path — first match wins, zero model calls. */
  rules: StaticRule[];
  /** Tools evaluated by the model. Others pass through untouched. */
  gated_tools: string;
  /** Read recent task context from the transcript into the model's state. */
  include_task_context: boolean;
  audit: {
    enabled: boolean;
    path: string;
    log_input: boolean;
  };
  /** Risk questions asked of the decision model. */
  questions: Record<string, BooleanQuestion>;
}
