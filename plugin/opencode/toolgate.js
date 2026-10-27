// toolgate for OpenCode: gates tool calls through `toolgate check` from the
// `tool.execute.before` hook. Copy to ~/.config/opencode/plugins/ (global) or
// .opencode/plugins/ (project). Requires `toolgate` on PATH (npm i -g) and a backend key
// (e.g. OPENCODE_API_KEY, or the key file `toolgate init` writes).
//
// Contract: OpenCode 2.x (v2 plugin API) requires the module default export to be
// an object { id, setup } (or { id, effect }) — see https://opencode.ai/v2/docs/build/plugins/
// and the error "Plugin must export a default definition with an id and an effect or
// setup function." The v1 functional/hooks-returning form is not translated.
//
// Throwing from tool.execute.before blocks the call. OpenCode plugins have no
// confirmation dialog, so `ask` blocks by default; set TOOLGATE_OPENCODE_ASK=allow
// to let asks through. A toolgate failure (binary missing, model unreachable) ALWAYS
// blocks, whatever TOOLGATE_OPENCODE_ASK says: toolgate never allows on its own failure,
// in any host.
//
// This hook calls `toolgate check`, which carries no session id and no task context: no
// action ledger, no `authorized` softening, and the four context questions are skipped.
// It is therefore stricter and blinder than the Claude Code mod, like the MCP proxy.
// TOOLGATE_TASK=<text> supplies a task for the context questions if you want them.
import { execFile } from 'node:child_process';

const READ_ONLY = new Set(['read', 'glob', 'grep', 'list', 'todoread', 'todowrite', 'skill']);
const TOOL_NAMES = { bash: 'Bash', write: 'Write', edit: 'Edit', patch: 'Edit', multiedit: 'MultiEdit', webfetch: 'WebFetch', websearch: 'WebSearch' };

/** OpenCode args use camelCase (filePath); toolgate expects Claude Code's file_path. */
function toToolgateInput(tool, args) {
  if (tool === 'bash') return { command: args.command ?? '' };
  const { filePath, oldString, newString, ...rest } = args ?? {};
  return { ...rest, ...(filePath !== undefined && { file_path: filePath }), ...(oldString !== undefined && { old_string: oldString }), ...(newString !== undefined && { new_string: newString }) };
}

function check(tool, input, cwd) {
  const argv = ['check', '--tool', tool, `--input=${JSON.stringify(input)}`];
  if (process.env.TOOLGATE_BACKEND) argv.push('--backend', process.env.TOOLGATE_BACKEND);
  const task = process.env.TOOLGATE_TASK?.trim();
  if (task) argv.push('--task', task);
  return new Promise((resolve, reject) => {
    execFile(process.env.TOOLGATE_BIN || 'toolgate', argv, { cwd, timeout: 15000, maxBuffer: 1 << 20 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('unparseable toolgate output'));
      }
    });
  });
}

export default {
  id: 'toolgate',
  setup: async ({ directory }) => {
    const askAllowed = process.env.TOOLGATE_OPENCODE_ASK === 'allow';
    return {
      'tool.execute.before': async (input, output) => {
        if (READ_ONLY.has(input.tool)) return;
        const tool = TOOL_NAMES[input.tool] ?? input.tool;
        let decision;
        try {
          decision = await check(tool, toToolgateInput(input.tool, output.args), directory);
        } catch (err) {
          // Fail safe, no opt-out: a gate that allows when its checker is down is the state an attacker wants.
          throw new Error(`[toolgate] NOT gating, blocked fail-safe: ${err instanceof Error ? err.message : err}`);
        }
        if (decision.verdict === 'deny' || (decision.verdict === 'ask' && !askAllowed)) {
          throw new Error(`[toolgate] ${decision.verdict}: ${decision.reason}`);
        }
      },
    };
  },
};
