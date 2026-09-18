import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { toHookOutput } from '../src/hook.js';

describe('hook output shape', () => {
  it('emits Claude Code PreToolUse JSON for deny', () => {
    const out = toHookOutput({ verdict: 'deny', reason: 'nope', source: 'model' });
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: '[toolgate] nope',
      },
    });
  });

  it('emits nothing for passthrough', () => {
    expect(toHookOutput({ verdict: 'passthrough', reason: '-', source: 'no-opinion' })).toBeUndefined();
  });
});

describe('hook end-to-end (mock backend, built CLI)', () => {
  it('denies rm -rf via stdin -> stdout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tg-e2e-'));
    // Disable audit + force mock backend via a policy file in cwd.
    writeFileSync(
      join(dir, 'toolgate.yaml'),
      ['backend:', '  provider: mock', 'audit:', '  enabled: false'].join('\n'),
    );
    const input = JSON.stringify({
      session_id: 'test',
      cwd: dir,
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf ~/' },
    });
    const stdout = execFileSync('node', [join(__dirname, '..', 'dist', 'cli.js'), 'hook'], {
      input,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(stdout);
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});
