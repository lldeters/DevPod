import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevContainerError } from '../../src/core/errors';
import {
  buildReadSettingsScript,
  buildWriteSettingsScript,
  machineSettingsPath,
  mergeSettingsText,
} from '../../src/core/server/machineSettings';

describe('machineSettingsPath', () => {
  it('points at the Machine settings of the server data folder', () => {
    expect(machineSettingsPath('/home/vscode', '.kiro-server')).toBe(
      '/home/vscode/.kiro-server/data/Machine/settings.json',
    );
    expect(machineSettingsPath('/root/', '.kiro-server')).toBe(
      '/root/.kiro-server/data/Machine/settings.json',
    );
  });

  it.each([
    ['relative', '.x'],
    ['/home/a\nb', '.x'],
    ['/home/a', '../x'],
    ['/home/a', 'a b'],
    ['/home/a', 'x/y'],
  ])('rejects home %j with folder %j', (home, folder) => {
    expect(() => machineSettingsPath(home, folder)).toThrow(DevContainerError);
  });
});

describe('mergeSettingsText', () => {
  it('creates a document from an empty file', () => {
    expect(JSON.parse(mergeSettingsText('', { 'editor.tabSize': 2 }))).toEqual({
      'editor.tabSize': 2,
    });
  });

  it('keeps comments and unrelated keys, replacing only the given ones', () => {
    const before = `{
    // my own tweak
    "files.autoSave": "afterDelay",
    "editor.tabSize": 8,
}
`;
    const after = mergeSettingsText(before, { 'editor.tabSize': 2, 'editor.rulers': [80] });
    expect(after).toContain('// my own tweak');
    expect(after).toContain('"files.autoSave": "afterDelay"');
    expect(after).toContain('"editor.tabSize": 2');
    expect(after).not.toContain('"editor.tabSize": 8');
    expect(after).toContain('"editor.rulers"');
  });

  it('replaces nested values as a whole', () => {
    const after = mergeSettingsText('{"remote.portsAttributes": {"1": {"label": "old"}}}', {
      'remote.portsAttributes': { '3000': { label: 'App' } },
    });
    expect(JSON.parse(after)).toEqual({ 'remote.portsAttributes': { '3000': { label: 'App' } } });
  });

  it('is idempotent', () => {
    const settings = { 'editor.tabSize': 2, 'remote.portsAttributes': { '3000': { label: 'A' } } };
    const once = mergeSettingsText('', settings);
    expect(mergeSettingsText(once, settings)).toBe(once);
  });

  it('refuses to touch a file that is not valid JSON', () => {
    expect(() => mergeSettingsText('{ "a": ', { b: 1 })).toThrowError(/left unchanged/);
  });

  it('always ends with a newline', () => {
    expect(mergeSettingsText('{"a":1}', { b: 2 }).endsWith('\n')).toBe(true);
  });
});

// The generated scripts are run for real (plain sh), against a throw-away directory.
describe.skipIf(process.platform === 'win32' || spawnSync('sh', ['-c', 'true']).status !== 0)(
  'settings scripts',
  () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(tmpdir(), 'dck-settings-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const sh = (script: string): string =>
      execFileSync('sh', ['-s'], { input: script, encoding: 'utf8' });

    it('reads nothing for a missing file and the content for an existing one', async () => {
      const file = path.join(dir, 'Machine', 'settings.json');
      expect(sh(buildReadSettingsScript(file))).toBe('');
      await execFileSync('mkdir', ['-p', path.dirname(file)]);
      await writeFile(file, '{"a":1}\n');
      expect(sh(buildReadSettingsScript(file))).toBe('{"a":1}\n');
    });

    it('writes the exact text, creates the folder and leaves no temporary file', async () => {
      const file = path.join(dir, 'deep', 'Machine', 'settings.json');
      const text = mergeSettingsText('', { 'editor.fontFamily': 'it\'s "quoted" $(id) `x`' });
      sh(buildWriteSettingsScript(file, text));
      expect(await readFile(file, 'utf8')).toBe(text);
      expect(await readdir(path.dirname(file))).toEqual(['settings.json']);
      // private like the rest of the server's folder
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
    });

    it('does not write through a file or link that is already at a temporary name', async () => {
      const file = path.join(dir, 'Machine', 'settings.json');
      await mkdir(path.dirname(file), { recursive: true });
      await symlink(path.join(dir, 'elsewhere'), `${file}.tmp`);
      sh(buildWriteSettingsScript(file, '{}\n'));
      expect(await readFile(file, 'utf8')).toBe('{}\n');
      await expect(stat(path.join(dir, 'elsewhere'))).rejects.toThrow();
    });

    it('does not let content that looks like shell or a delimiter escape the here-document', async () => {
      const file = path.join(dir, 'settings.json');
      const hostile = `{"k": "EOF\\n$(touch ${dir}/pwned)\\n\`touch ${dir}/pwned2\`"}\n`;
      sh(buildWriteSettingsScript(file, hostile));
      expect(await readFile(file, 'utf8')).toBe(hostile);
      expect(() => execFileSync('test', ['-e', path.join(dir, 'pwned')])).toThrow();
      expect(() => execFileSync('test', ['-e', path.join(dir, 'pwned2')])).toThrow();
    });
  },
);
