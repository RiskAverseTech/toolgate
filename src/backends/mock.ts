import type { Answers, DecisionBackend, JSONObject, Questions } from '../types.js';

/**
 * Deterministic heuristic backend: no network, no key, no cost. For
 * `toolgate check --backend mock`, offline dev, and tests. Intentionally
 * crude — the whole point of toolgate is that a calibrated decision model
 * does this job better than regexes ever will.
 */
export class MockBackend implements DecisionBackend {
  readonly name = 'mock';

  async evaluate(state: JSONObject, questions: Questions): Promise<Answers> {
    const text = JSON.stringify(state.tool_input).toLowerCase();
    const answers: Answers = {};
    for (const key of Object.keys(questions)) {
      let p = 0.02;
      for (const [re, weight] of SIGNALS[key] ?? []) if (re.test(text)) p = Math.max(p, weight);
      answers[key] = { type: 'boolean', probability: p };
    }
    return answers;
  }
}

const SIGNALS: Record<string, Array<[RegExp, number]>> = {
  destructive: [
    [/\brm\b/, 0.6],
    [/git\s+push\s+.*--force|git\s+reset\s+--hard|drop\s+(table|database)|mkfs|dd\s+if=/, 0.9],
  ],
  exfiltration: [
    [/curl\s.*(-d|--data|-t|--upload-file|-x\s*post)/i, 0.85],
    [/\.env\b.*(curl|wget|nc\s)|(curl|wget|nc)\s.*\.env\b/, 0.95],
  ],
  privilege: [
    [/\bsudo\b|\/etc\/(passwd|shadow|sudoers)/, 0.85],
    [/chmod\s+(-r\s+)?[0-7]*77|(>>?)\s*~?\/?\.(bashrc|zshrc|profile|ssh\/)/, 0.7],
  ],
};
