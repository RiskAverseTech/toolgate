import type { Answers, DecisionBackend, Questions } from '../types.js';

/**
 * Deterministic heuristic backend. No network, no key, no cost.
 * Used for tests, offline development, and `toolgate check --backend mock`.
 * It is intentionally crude — the point of toolgate is that a calibrated
 * decision model does this job better than regexes ever will.
 */
export class MockBackend implements DecisionBackend {
  readonly name = 'mock';

  async evaluate(state: unknown, questions: Questions): Promise<Answers> {
    const text = JSON.stringify(state).toLowerCase();
    const answers: Answers = {};
    for (const [key, q] of Object.entries(questions)) {
      if (q.type !== 'boolean') {
        throw new Error(`MockBackend only supports boolean questions (got "${q.type}" for "${key}")`);
      }
      answers[key] = { type: 'boolean', probability: score(key, text) };
    }
    return answers;
  }
}

const SIGNALS: Record<string, Array<[RegExp, number]>> = {
  destructive: [
    [/rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r/, 0.95],
    [/\brm\s+/, 0.6],
    [/drop\s+(table|database)/, 0.95],
    [/git\s+push\s+.*--force|git\s+reset\s+--hard/, 0.8],
    [/mkfs|dd\s+if=/, 0.97],
    [/truncate|shred/, 0.7],
    [/kill\s+-9|pkill/, 0.55],
  ],
  exfiltration: [
    [/curl\s+[^"]*-(d|-data|f|-form|t|-upload-file)/i, 0.85],
    [/curl\s+[^"]*-x\s*post/i, 0.8],
    [/\.env\b.*(curl|wget|nc\s)/, 0.95],
    [/(curl|wget|nc)\s.*\.env\b/, 0.95],
    [/scp\s|rsync\s.*@/, 0.7],
    [/pastebin|transfer\.sh|ngrok/, 0.85],
  ],
  privilege: [
    [/\bsudo\b/, 0.85],
    [/chmod\s+(-r\s+)?[0-7]*7[0-7]*7/, 0.7],
    [/\/etc\/(passwd|shadow|sudoers)/, 0.95],
    [/(>>|>)\s*~?\/?\.(bashrc|zshrc|profile|ssh\/)/, 0.8],
    [/launchctl|systemctl\s+(enable|disable)/, 0.65],
  ],
  off_task: [],
};

function score(questionKey: string, text: string): number {
  const signals = SIGNALS[questionKey] ?? [];
  let max = 0.02;
  for (const [re, p] of signals) {
    if (re.test(text)) max = Math.max(max, p);
  }
  return max;
}
