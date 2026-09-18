export type {
  Answer,
  Answers,
  BooleanAnswer,
  BooleanQuestion,
  ChoiceAnswer,
  ChoiceQuestion,
  Decision,
  DecisionAction,
  DecisionBackend,
  HookInput,
  Policy,
  Question,
  Questions,
  ScoreAnswer,
  ScoreQuestion,
  StaticRule,
  Verdict,
} from './types.js';

export { decide } from './engine.js';
export { loadPolicy, defaultPolicy, DEFAULT_QUESTIONS, DEFAULT_RULES, toolMatcherToRegex } from './policy.js';
export { buildState, lastUserPrompt, serializeInput } from './state.js';
export { GatewayBackend } from './backends/gateway.js';
export { MockBackend } from './backends/mock.js';
export { runHook, makeBackend, toHookOutput } from './hook.js';
export { writeAudit } from './audit.js';
