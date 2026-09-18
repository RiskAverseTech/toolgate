import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPolicy, loadPolicy, toolMatcherToRegex, validatePolicy } from '../src/policy.js';

describe('policy loading', () => {
  it('returns defaults when no file exists', () => {
    const p = loadPolicy(undefined, '/nonexistent');
    expect(p.backend.model).toBe('typesafe-ai/jev');
    expect(p.fail_mode).toBe('passthrough');
  });

  it('merges a user yaml over defaults and expands ~', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-'));
    writeFileSync(
      join(dir, 'toolgate.yaml'),
      [
        'thresholds:',
        '  deny: 0.9',
        'fail_mode: ask',
        'audit:',
        '  path: ~/custom/audit.jsonl',
      ].join('\n'),
    );
    const p = loadPolicy(undefined, dir);
    expect(p.thresholds.deny).toBe(0.9);
    expect(p.thresholds.ask).toBe(defaultPolicy().thresholds.ask);
    expect(p.fail_mode).toBe('ask');
    expect(p.audit.path.startsWith('~')).toBe(false);
    expect(p.audit.path.endsWith('custom/audit.jsonl')).toBe(true);
  });

  it('rejects invalid thresholds', () => {
    const p = defaultPolicy();
    p.thresholds = { ask: 0.9, deny: 0.5 };
    expect(() => validatePolicy(p)).toThrow();
  });
});

describe('tool matchers', () => {
  it('matches exact names and pipe lists', () => {
    expect(toolMatcherToRegex('Bash').test('Bash')).toBe(true);
    expect(toolMatcherToRegex('Bash').test('BashOutput')).toBe(false);
    expect(toolMatcherToRegex('Edit|Write').test('Write')).toBe(true);
  });

  it('supports regex matchers for MCP tools', () => {
    expect(toolMatcherToRegex('mcp__.*').test('mcp__github__create_issue')).toBe(true);
    expect(toolMatcherToRegex('mcp__.*').test('Bash')).toBe(false);
  });

  it('* matches everything', () => {
    expect(toolMatcherToRegex('*').test('Anything')).toBe(true);
  });
});
