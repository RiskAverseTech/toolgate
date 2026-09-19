import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES, defaultPolicy, loadEnvFile, loadPolicy, toolMatcherToRegex, validatePolicy } from '../src/policy.js';

function tmpPolicy(yaml: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'tg-')), 'toolgate.yaml');
  writeFileSync(path, yaml);
  return path;
}

describe('policy loading', () => {
  it('returns defaults when the file does not exist', () => {
    const p = loadPolicy('/nonexistent/toolgate.yaml');
    expect(p.backend.provider).toBe('auto');
    expect(p.fail_mode).toBe('passthrough');
  });

  it('merges user values over defaults and expands ~', () => {
    const p = loadPolicy(tmpPolicy('thresholds:\n  deny: 0.9\nfail_mode: ask\naudit:\n  path: ~/custom/audit.jsonl\n'));
    expect(p.thresholds).toEqual({ ...defaultPolicy().thresholds, deny: 0.9 });
    expect(p.fail_mode).toBe('ask');
    expect(p.audit.path).not.toMatch(/^~/);
    expect(p.audit.path).toMatch(/custom\/audit\.jsonl$/);
  });

  it('user rules are prepended; built-in rules survive', () => {
    const p = loadPolicy(tmpPolicy("rules:\n  - match: { tool: Bash, input_regex: 'terraform\\s+destroy' }\n    action: ask\n"));
    expect(p.rules).toHaveLength(DEFAULT_RULES.length + 1);
    expect(p.rules[0]?.match.input_regex).toContain('terraform');
  });

  it('user questions are merged over built-ins', () => {
    const p = loadPolicy(tmpPolicy('questions:\n  spends_money:\n    type: boolean\n    instructions: Spends money.\n'));
    expect(Object.keys(p.questions)).toEqual(expect.arrayContaining(['destructive', 'exfiltration', 'spends_money']));
  });

  it('ignores the project directory entirely (no cwd discovery)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-proj-'));
    writeFileSync(join(dir, 'toolgate.yaml'), 'gated_tools: "NothingAtAll"\n');
    const before = process.cwd();
    process.chdir(dir);
    try {
      expect(loadPolicy('/nonexistent/toolgate.yaml').gated_tools).toBe(defaultPolicy().gated_tools);
    } finally {
      process.chdir(before);
    }
  });

  it.each([
    ['bad yaml', 'thresholds:\n  deny: [oops'],
    ['non-string gated_tools', 'gated_tools: 5\n'],
    ['rule without match', 'rules:\n  - action: deny\n'],
    ['inverted thresholds', 'thresholds:\n  ask: 0.9\n  deny: 0.5\n'],
    ['bad provider', 'backend:\n  provider: gatway\n'],
    ['non-boolean show_allows', 'show_allows: yes please\n'],
    ['tiny input limit', 'limits:\n  input_chars: 10\n'],
    ['bad unattended.ask', 'unattended:\n  ask: allow\n'],
    ['bad unattended.modes', 'unattended:\n  modes: auto\n'],
  ])('rejects invalid policy: %s', (_name, yaml) => {
    expect(() => loadPolicy(tmpPolicy(yaml))).toThrow();
  });

  it('limits and unattended merge over defaults', () => {
    const p = loadPolicy(tmpPolicy('limits:\n  input_chars: 30000\nunattended:\n  ask: ask\n'));
    expect(p.limits).toEqual({ input_chars: 30000, task_chars: 6000, earlier_prompts: 2 });
    expect(p.unattended).toEqual({ modes: ['bypassPermissions', 'auto', 'dontAsk'], ask: 'ask' });
  });

  it('show_allows defaults off and can be turned on', () => {
    expect(defaultPolicy().show_allows).toBe(false);
    expect(loadPolicy(tmpPolicy('show_allows: true\n')).show_allows).toBe(true);
  });

  it('an empty key falls back to the default instead of crashing', () => {
    expect(loadPolicy(tmpPolicy('gated_tools:\n')).gated_tools).toBe(defaultPolicy().gated_tools);
  });

  it('allows ask: 0 (always confirm)', () => {
    const p = defaultPolicy();
    p.thresholds.ask = 0;
    expect(() => validatePolicy(p)).not.toThrow();
  });
});

describe('env file', () => {
  it('loads keys from ~/.toolgate/env without overriding the environment', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'tg-env-')), 'env');
    writeFileSync(f, 'TYPESAFE_API_KEY="from-file"\nexport OTHER_KEY=x\n# comment\n');
    const prev = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = 'from-env';
    loadEnvFile(f);
    expect(process.env.TYPESAFE_API_KEY).toBe('from-env');
    expect(process.env.OTHER_KEY).toBe('x');
    delete process.env.TYPESAFE_API_KEY;
    loadEnvFile(f);
    expect(process.env.TYPESAFE_API_KEY).toBe('from-file');
    if (prev === undefined) delete process.env.TYPESAFE_API_KEY; else process.env.TYPESAFE_API_KEY = prev;
    delete process.env.OTHER_KEY;
  });
});

describe('tool matchers are always whole-name', () => {
  it('exact and lists', () => {
    expect(toolMatcherToRegex('Bash').test('Bash')).toBe(true);
    expect(toolMatcherToRegex('Bash').test('BashOutput')).toBe(false);
    expect(toolMatcherToRegex('Edit|Write').test('Write')).toBe(true);
    expect(toolMatcherToRegex('Edit|Write').test('MultiEdit')).toBe(false);
  });

  it('regex form is anchored too', () => {
    const re = toolMatcherToRegex(defaultPolicy().gated_tools);
    expect(re.test('mcp__github__create_issue')).toBe(true);
    expect(re.test('BashOutput')).toBe(false);
    expect(re.test('TodoWrite')).toBe(false);
  });

  it('* matches everything', () => {
    expect(toolMatcherToRegex('*').test('Anything')).toBe(true);
  });
});
