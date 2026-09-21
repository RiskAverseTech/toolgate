import type { Answers, DecisionBackend, JSONObject, Questions } from '../types.js';
import { CAPABILITY_KEYS, WRITE_TOOLS } from '../policy.js';

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
    const facts = (state.session_facts ?? {}) as Record<string, unknown>;
    const executes = facts.executes_artifact_written_this_session === true;
    // Content is not harm: on a write tool the risk axes ignore the content being written; the
    // capability questions (what the content could do if executed) look at it instead.
    const isWrite = WRITE_TOOLS.has(String(state.tool));
    const answers: Answers = {};
    for (const key of Object.keys(questions)) {
      let p = 0.02;
      const applies = CAPABILITY_KEYS.has(key) ? isWrite : !isWrite;
      if (applies) for (const [re, weight] of SIGNALS[key] ?? []) if (re.test(text)) p = Math.max(p, weight);
      // The ledger: executing a file this session wrote is judged as what the file does.
      if (executes) {
        if (key === 'exfiltration' && facts.artifact_sends_data_externally === true) p = Math.max(p, 0.9);
        if (key === 'secret_exposure' && facts.artifact_reads_sensitive_data === true && facts.artifact_sends_data_externally === true) p = Math.max(p, 0.9);
        if (key === 'destructive' && facts.artifact_is_destructive === true) p = Math.max(p, 0.9);
        if (key === 'privilege' && facts.artifact_changes_privilege === true) p = Math.max(p, 0.9);
      }
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
  // Artifact capability questions (asked on write tools): what the CONTENT could do if executed.
  artifact_reads_sensitive_data: [[/\.env\b|secret|api[_-]?key|token|password|id_rsa|\.ssh\/|credential/, 0.85]],
  artifact_sends_data_externally: [[/\bcurl\b|\bwget\b|fetch\(|https?:\/\/|\bnc\s|requests\.(post|put)|urllib/, 0.85]],
  artifact_destructive: [[/rm\s+-rf?|drop\s+(table|database)|git\s+push\s+.*--force|shutil\.rmtree|unlink\(/, 0.85]],
  artifact_changes_privilege: [[/\bsudo\b|chmod\s+[0-7]*77|\/etc\/|visudo|authorized_keys/, 0.85]],
};
