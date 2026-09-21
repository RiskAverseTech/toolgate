import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hookCommand, hookSelfTest, installHook, installedHookCommands, installedPostEvents, postCommand, readSettings, settingsSnippet, writeSettings } from '../src/install.js';

const DIST_CLI = join(__dirname, '..', 'dist', 'cli.js');

describe('hook command', () => {
  it('names node and cli.js by absolute path, ends with "hook"', () => {
    const cmd = hookCommand();
    expect(cmd.startsWith(process.execPath)).toBe(true);
    expect(cmd).toMatch(/cli\.js hook$/);
    expect(cmd).not.toMatch(/(^|\s)toolgate hook/);
  });

  it('snippet is valid JSON with one PreToolUse group', () => {
    const snip = JSON.parse(settingsSnippet());
    expect(snip.hooks.PreToolUse).toHaveLength(1);
    expect(snip.hooks.PreToolUse[0].hooks[0].command).toBe(hookCommand());
  });
});

describe('installHook', () => {
  const stale = { type: 'command', command: 'toolgate hook', timeout: 10 };

  it('adds to empty settings', () => {
    const s: Record<string, unknown> = {};
    expect(installHook(s)).toBe('added');
    expect(installedHookCommands(s)).toEqual([hookCommand()]);
  });

  it('replaces a stale entry in place and leaves everything else alone', () => {
    const s: Record<string, unknown> = {
      env: { X: '1' },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo other' }, stale] }], Stop: [{ hooks: [] }] },
    };
    // The stale PreToolUse entry is refreshed in place; the ledger's post hooks are new, so the call reports 'added'.
    expect(installHook(s)).toBe('added');
    const group = (s.hooks as { PreToolUse: Array<{ matcher: string; hooks: Array<{ command: string }> }> }).PreToolUse[0]!;
    expect(group.matcher).toBe('Bash');
    expect(group.hooks[0]!.command).toBe('echo other');
    expect(group.hooks[1]!.command).toBe(hookCommand());
    expect(s.env).toEqual({ X: '1' });
    expect((s.hooks as { Stop: unknown[] }).Stop).toEqual([{ hooks: [] }]);
    expect(installedPostEvents(s)).toEqual(['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']);
    for (const ev of ['PostToolUse', 'PostToolUseFailure', 'PermissionDenied']) {
      const g = (s.hooks as Record<string, Array<{ matcher: string; hooks: Array<{ command: string; timeout: number }> }>>)[ev]![0]!;
      expect(g.matcher).toBe('*');
      expect(g.hooks[0]!.command).toBe(postCommand());
      expect(g.hooks[0]!.timeout).toBe(5);
    }
    expect(installHook(s)).toBe('unchanged');
  });

  it('a stale PreToolUse entry with post hooks already present reports updated', () => {
    const s: Record<string, unknown> = { hooks: { PreToolUse: [{ matcher: '*', hooks: [stale] }] } };
    installHook(s); // adds post hooks
    (s.hooks as { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }).PreToolUse[0]!.hooks[0]!.command = stale.command;
    expect(installHook(s)).toBe('updated');
  });

  it('ignores non-toolgate and malformed entries when scanning', () => {
    expect(installedHookCommands({ hooks: { PreToolUse: [{ hooks: [null, 5, { type: 'command', command: 'ls' }] }, 'junk'] } })).toEqual([]);
    expect(installedHookCommands(null)).toEqual([]);
  });
});

describe('settings file', () => {
  it('round-trips with a backup', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tg-settings-')), 'settings.json');
    expect(readSettings(path)).toEqual({});
    expect(writeSettings({ a: 1 }, path)).toBeUndefined();
    const backup = writeSettings({ a: 2 }, path);
    expect(backup && existsSync(backup)).toBe(true);
    expect(JSON.parse(readFileSync(backup!, 'utf8'))).toEqual({ a: 1 });
    expect(readSettings(path)).toEqual({ a: 2 });
    expect(readdirSync(join(path, '..'))).toHaveLength(2);
  });

  it('refuses a non-object settings file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'tg-settings-')), 'settings.json');
    writeFileSync(path, '[1]');
    expect(() => readSettings(path)).toThrow(/not a JSON object/);
  });
});

describe('hook self-test (built CLI)', () => {
  it('passes for an absolute-path command under a minimal environment', () => {
    const r = hookSelfTest(`${process.execPath} ${DIST_CLI} hook`);
    expect(r.ok, r.detail).toBe(true);
  });

  it('fails for a bare, PATH-dependent command', () => {
    const r = hookSelfTest('toolgate-definitely-not-on-path hook');
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('toolgate-definitely-not-on-path');
  });

  it('fails when the command runs but is not a hook', () => {
    expect(hookSelfTest('echo {}').ok).toBe(false);
  });
});
