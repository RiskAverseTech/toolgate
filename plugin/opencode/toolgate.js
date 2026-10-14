// toolgate for OpenCode: gates tool calls through `toolgate check` from the
// `tool.execute.before` hook. Copy to ~/.config/opencode/plugins/ (global) or
// .opencode/plugins/ (project). Requires `toolgate` on PATH (npm i -g) and a backend key
// (e.g. OPENCODE_API_KEY, or the key file `toolgate init` writes).
//
// Hook API per https://opencode.ai/docs/plugins/: throwing from tool.execute.before blocks
// the call. OpenCode plugins have no confirmation dialog, so `ask` blocks by default;
// set TOOLGATE_OPENCODE_ASK=allow to let asks through. A toolgate failure (binary missing,
// model unreachable) follows the same rule: fail safe unless you opt out.
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

export const Toolgate = async ({ directory }) => {
  const askAllowed = process.env.TOOLGATE_OPENCODE_ASK === 'allow';
  return {
    'tool.execute.before': async (input, output) => {
      if (READ_ONLY.has(input.tool)) return;
      const tool = TOOL_NAMES[input.tool] ?? input.tool;
      let decision;
      try {
        decision = await check(tool, toToolgateInput(input.tool, output.args), directory);
      } catch (err) {
        if (askAllowed) return;
        throw new Error(`[toolgate] NOT gating, blocked fail-safe: ${err instanceof Error ? err.message : err}`);
      }
      if (decision.verdict === 'deny' || (decision.verdict === 'ask' && !askAllowed)) {
        throw new Error(`[toolgate] ${decision.verdict}: ${decision.reason}`);
      }
    },
  };
};
