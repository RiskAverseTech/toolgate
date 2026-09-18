export type {
  Answers,
  BooleanAnswer,
  BooleanQuestion,
  Decision,
  DecisionAction,
  DecisionBackend,
  HookInput,
  JSONObject,
  Policy,
  Questions,
  StaticRule,
  Verdict,
} from './types.js';

export { decide } from './engine.js';
export { loadPolicy, defaultPolicy } from './policy.js';
export { makeBackend } from './hook.js';
export { MockBackend } from './backends/mock.js';
// GatewayBackend is deliberately not re-exported here: importing it loads the AI SDK (~600 ms).
// Use makeBackend(policy), which loads it lazily, or import '@riskaverse/toolgate/dist/backends/gateway.js'.
