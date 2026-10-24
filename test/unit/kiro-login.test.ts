import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevContainerError } from '../../src/core/errors';
import {
  KIRO_LOGIN_RELATIVE_PATH,
  buildShareLoginScript,
  checkLoginFile,
  parseShareLoginResult,
  readLocalLoginFile,
} from '../../src/core/server/kiroLogin';

const SECRET = '{"accessToken":"SECRET-ACCESS","refreshToken":"SECRET-REFRESH","expiresAt":"x"}';

describe('checkLoginFile', () => {
  it('accepts a JSON object', () => {
    expect(checkLoginFile(SECRET)).toBeUndefined();
    expect(checkLoginFile('{}')).toBeUndefined();
  });

  it.each([
    ['not JSON', 'accessToken=abc'],
    ['empty', ''],
    ['an array', '[1,2]'],
    ['a string', '"abc"'],
    ['null', 'null'],
    ['too large', `{"a":"${'x'.repeat(70 * 1024)}"}`],
  ])('rejects %s', (_name, text) => {
    expect(checkLoginFile(text)).toEqual(expect.any(String));
  });
});

describe('readLocalLoginFile', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'kiro-login-home-'));
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  async function writeLogin(text: string): Promise<void> {
    const file = path.join(home, ...KIRO_LOGIN_RELATIVE_PATH.split('/'));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, text);
  }

  it('returns the content of the sign-in file', async () => {
    await writeLogin(SECRET);
    const reports: { level: string; message: string }[] = [];
    expect(
      await readLocalLoginFile(home, (level, message) => reports.push({ level, message })),
    ).toBe(SECRET);
    expect(reports).toEqual([]);
  });

  it('says so when there is no sign-in on this machine', async () => {
    const reports: { level: string; message: string }[] = [];
    expect(
      await readLocalLoginFile(home, (level, message) => reports.push({ level, message })),
    ).toBeUndefined();
    expect(reports).toEqual([
      { level: 'info', message: 'There is no Kiro sign-in on this machine to share.' },
    ]);
  });

  it('does not share a file that does not look like a sign-in, and never reports its content', async () => {
    await writeLogin('SECRET-NOT-JSON');
    const reports: { level: string; message: string }[] = [];
    expect(
      await readLocalLoginFile(home, (level, message) => reports.push({ level, message })),
    ).toBeUndefined();
    expect(reports).toHaveLength(1);
    expect(reports[0]?.level).toBe('warn');
    expect(JSON.stringify(reports)).not.toContain('SECRET');
  });
});

describe('parseShareLoginResult', () => {
  it.each(['copied', 'exists', 'nohome'] as const)('reads %s', (word) => {
    expect(parseShareLoginResult(`${word}\n`)).toBe(word);
  });

  it('takes the last line and rejects anything else', () => {
    expect(parseShareLoginResult('noise\ncopied\n')).toBe('copied');
    expect(() => parseShareLoginResult('')).toThrow(DevContainerError);
    expect(() => parseShareLoginResult('SECRET\n')).toThrow(DevContainerError);
  });
});

describe('buildShareLoginScript (run with sh)', () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'kiro-login-script-'));
  });
  afterEach(() => rm(home, { recursive: true, force: true }));

  const target = () => path.join(home, ...KIRO_LOGIN_RELATIVE_PATH.split('/'));

  function run(script: string, env: Record<string, string | undefined> = { HOME: home }) {
    const result = spawnSync('sh', ['-s'], {
      input: script,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'], ...env },
      cwd: home,
    });
    return { code: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('copies the file with private permissions when the container has none', async () => {
    const result = run(buildShareLoginScript(SECRET));
    expect(result.code).toBe(0);
    expect(parseShareLoginResult(result.stdout)).toBe('copied');
    expect((await readFile(target(), 'utf8')).trim()).toBe(SECRET);
    expect((await stat(target())).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(target()))).mode & 0o777).toBe(0o700);
    expect((await stat(path.join(home, '.aws'))).mode & 0o777).toBe(0o700);
  });

  it('never prints the content', () => {
    const result = run(buildShareLoginScript(SECRET));
    expect(result.stdout).not.toContain('SECRET');
    expect(result.stderr).not.toContain('SECRET');
  });

  it('keeps an existing sign-in untouched', async () => {
    await mkdir(path.dirname(target()), { recursive: true });
    await writeFile(target(), '{"already":"here"}');
    const result = run(buildShareLoginScript(SECRET));
    expect(parseShareLoginResult(result.stdout)).toBe('exists');
    expect(await readFile(target(), 'utf8')).toBe('{"already":"here"}');
  });

  it('replaces an empty file', async () => {
    await mkdir(path.dirname(target()), { recursive: true });
    await writeFile(target(), '');
    expect(parseShareLoginResult(run(buildShareLoginScript(SECRET)).stdout)).toBe('copied');
    expect((await readFile(target(), 'utf8')).trim()).toBe(SECRET);
  });

  it('writes nothing without a usable home directory', async () => {
    const script = buildShareLoginScript(SECRET);
    expect(parseShareLoginResult(run(script, { HOME: undefined }).stdout)).toBe('nohome');
    expect(parseShareLoginResult(run(script, { HOME: path.join(home, 'missing') }).stdout)).toBe(
      'nohome',
    );
    const readOnly = path.join(home, 'readonly');
    await mkdir(readOnly);
    await chmod(readOnly, 0o500);
    if (process.getuid?.() !== 0) {
      expect(parseShareLoginResult(run(script, { HOME: readOnly }).stdout)).toBe('nohome');
    }
    await chmod(readOnly, 0o700);
    await expect(stat(target())).rejects.toThrow();
  });

  it('copies content that looks like shell code byte for byte, without running it', async () => {
    const nasty = JSON.stringify({
      a: '$(touch pwned)',
      b: '`touch pwned`',
      c: 'it\'s "quoted" \\ and has ${HOME}',
      d: 'EOF\nDCK_\n',
    });
    expect(parseShareLoginResult(run(buildShareLoginScript(nasty)).stdout)).toBe('copied');
    expect((await readFile(target(), 'utf8')).trim()).toBe(nasty);
    await expect(stat(path.join(home, 'pwned'))).rejects.toThrow();
  });

  it('uses a different here-document delimiter every time', () => {
    const delimiters = new Set(
      [1, 2, 3].map(
        (): string => /<<'(DCK_[0-9a-f]+)'/.exec(buildShareLoginScript('{}'))?.[1] ?? '',
      ),
    );
    expect(delimiters.size).toBe(3);
  });
});
