import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevContainerError } from '../../src/core/errors';
import { detectPlatformScript, parsePlatform } from '../../src/core/server/platform';
import { runProcess } from '../../src/core/process';
import {
  buildInstallScript,
  INSTALL_MARKER,
  parseInstallResult,
  parseKeyValueOutput,
  shQuote,
} from '../../src/core/server/script';

describe('shQuote', () => {
  it('wraps in single quotes and escapes embedded quotes', () => {
    expect(shQuote('plain')).toBe("'plain'");
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });

  it('neutralizes shell metacharacters when evaluated by sh', () => {
    const hostile = `"; touch /tmp/pwned; echo '$(id)' \`id\``;
    const out = execFileSync('sh', ['-c', `printf %s ${shQuote(hostile)}`], { encoding: 'utf8' });
    expect(out).toBe(hostile);
  });
});

describe('parseKeyValueOutput', () => {
  it('ignores noise outside the markers and splits at the first ==', () => {
    const out = ['banner', 'm: start', 'a==1', 'b==x==y', 'junk line', 'm: end', 'trailer'].join(
      '\r\n',
    );
    expect(parseKeyValueOutput(out, 'm')).toEqual({ a: '1', b: 'x==y' });
  });

  it('fails when the end marker is missing', () => {
    expect(() => parseKeyValueOutput('m: start\na==1', 'm')).toThrow(DevContainerError);
  });
});

describe('buildInstallScript validation', () => {
  const base = {
    dataFolderName: '.kiro-server',
    commit: 'abc123',
    applicationName: 'kiro-server',
    downloadUrl: 'https://example.com/s.tar.gz',
  };

  it('accepts ordinary values', () => {
    expect(buildInstallScript(base)).toContain(`${INSTALL_MARKER}: start`);
  });

  it.each([
    ['dataFolderName', '../etc'],
    ['dataFolderName', 'a b'],
    ['commit', 'x; reboot'],
    ['applicationName', '$(id)'],
    ['commit', ''],
  ])('rejects unsafe %s %j', (field, value) => {
    expect(() => buildInstallScript({ ...base, [field]: value })).toThrow(DevContainerError);
  });

  it('quotes the download URL so it cannot break out', () => {
    const script = buildInstallScript({ ...base, downloadUrl: "https://e.com/a'; reboot; '" });
    expect(script).toContain("DOWNLOAD_URL='https://e.com/a'\\''; reboot; '\\'''");
  });

  it('passes each extension as its own --install-extension argument', () => {
    const script = buildInstallScript({
      ...base,
      extensions: ['esbenp.prettier-vscode', 'redhat.vscode-yaml'],
    });
    expect(script).toContain("'--install-extension' 'esbenp.prettier-vscode'");
    expect(script).toContain("'--install-extension' 'redhat.vscode-yaml'");
  });

  it.each(['ms-python.python@2024.1.0', 'not an id', 'x; reboot', '$(id).y', 'noPublisher', ''])(
    'rejects the extension entry %j instead of passing it to the server',
    (id) => {
      expect(() => buildInstallScript({ ...base, extensions: [id] })).toThrow(DevContainerError);
    },
  );

  it('rejects an absurd strip depth', () => {
    expect(() => buildInstallScript({ ...base, stripComponents: 99 })).toThrow();
  });
});

describe('parseInstallResult', () => {
  const wrap = (lines: string[]): string =>
    [`${INSTALL_MARKER}: start`, ...lines, `${INSTALL_MARKER}: end`].join('\n');

  it('parses a successful run', () => {
    expect(
      parseInstallResult(
        wrap(['serverDir==/h/.s/bin/c', 'port==40123', 'token==t', 'node==/n', 'log==/l']),
      ),
    ).toEqual({ serverDir: '/h/.s/bin/c', port: 40123, token: 't', node: '/n', log: '/l' });
  });

  it('surfaces a reported error', () => {
    expect(() => parseInstallResult(wrap(['error==download failed']))).toThrowError(
      /download failed/,
    );
  });

  it('rejects incomplete or out-of-range results', () => {
    expect(() => parseInstallResult(wrap(['port==40123']))).toThrow();
    expect(() =>
      parseInstallResult(wrap(['serverDir==/s', 'port==70000', 'token==t', 'node==n', 'log==l'])),
    ).toThrow();
  });
});

// Runs the generated script for real against a fake server archive (no container needed).
const hasTools = ['sh', 'curl', 'tar'].every(
  (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0,
);

describe.skipIf(process.platform === 'win32' || !hasTools)('install script execution', () => {
  let work: string;
  let home: string;
  let archive: string;
  const commit = 'deadbeef';
  const options = (): Parameters<typeof buildInstallScript>[0] => ({
    dataFolderName: '.test-server',
    commit,
    applicationName: 'fake-server',
    downloadUrl: `file://${archive}`,
  });
  const run = async (script: string) =>
    runProcess('sh', ['-s'], { stdin: script, env: { ...process.env, HOME: home } });

  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'dck-script-'));
    home = path.join(work, 'home');
    await mkdir(home);
    const top = path.join(work, 'src', 'fake-server-linux-x64');
    await mkdir(path.join(top, 'bin'), { recursive: true });
    await writeFile(
      path.join(top, 'bin', 'fake-server'),
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$(dirname "$0")/../args.txt"\necho "Extension host agent listening on 45678"\nexec sleep 120\n',
    );
    await chmod(path.join(top, 'bin', 'fake-server'), 0o755);
    await symlink(process.execPath, path.join(top, 'node'));
    archive = path.join(work, 'server.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', path.join(work, 'src'), 'fake-server-linux-x64']);
  });

  afterEach(async () => {
    try {
      const pid = (
        await readFile(path.join(home, '.test-server', `server-${commit}.pid`), 'utf8')
      ).trim();
      process.kill(Number(pid), 'SIGKILL');
    } catch {
      // not started
    }
    await rm(work, { recursive: true, force: true });
  });

  it('installs, starts the server and reports where it listens', async () => {
    const result = await run(buildInstallScript(options()));
    expect(result.code).toBe(0);
    const info = parseInstallResult(result.stdout);
    expect(info.port).toBe(45678);
    expect(info.token).toMatch(/^[0-9a-f]{48}$/);
    expect(info.serverDir).toBe(path.join(home, '.test-server', 'bin', commit));
    expect(info.node).toBe(path.join(info.serverDir, 'node'));
    // the token must be on disk with owner-only permissions, never on a command line
    const mode = execFileSync(
      'stat',
      ['-c', '%a', path.join(home, '.test-server', `server-${commit}.token`)],
      {
        encoding: 'utf8',
      },
    ).trim();
    expect(mode).toBe('600');
  });

  it('reuses the running server and skips the download on the second run', async () => {
    const first = parseInstallResult((await run(buildInstallScript(options()))).stdout);
    await rm(archive); // a second download would now fail
    const second = parseInstallResult((await run(buildInstallScript(options()))).stdout);
    expect(second).toEqual(first);
  });

  it('starts the server with the requested extensions and without them by default', async () => {
    const withExtensions = parseInstallResult(
      (
        await run(
          buildInstallScript({
            ...options(),
            extensions: ['esbenp.prettier-vscode', 'redhat.vscode-yaml'],
          }),
        )
      ).stdout,
    );
    const argsFile = path.join(withExtensions.serverDir, 'args.txt');
    const args = (await readFile(argsFile, 'utf8')).trim().split('\n');
    expect(args).toEqual(
      expect.arrayContaining(['--start-server', '--host=127.0.0.1', '--port=0']),
    );
    const flagIndexes = args.flatMap((arg, index) =>
      arg === '--install-extension' ? [index] : [],
    );
    expect(flagIndexes.map((index) => args[index + 1])).toEqual([
      'esbenp.prettier-vscode',
      'redhat.vscode-yaml',
    ]);
    // the token goes in a file, never on the command line
    expect(args.some((arg) => arg.startsWith('--connection-token-file'))).toBe(true);
    expect(args.join(' ')).not.toContain(withExtensions.token);
  });

  it('passes no --install-extension when none are requested', async () => {
    const info = parseInstallResult((await run(buildInstallScript(options()))).stdout);
    const args = (await readFile(path.join(info.serverDir, 'args.txt'), 'utf8')).trim().split('\n');
    expect(args).not.toContain('--install-extension');
  });

  it('reports a failed download without leaving temporary files behind', async () => {
    const bad = { ...options(), downloadUrl: `file://${path.join(work, 'missing.tar.gz')}` };
    const result = await run(buildInstallScript(bad));
    expect(result.code).not.toBe(0);
    expect(() => parseInstallResult(result.stdout)).toThrowError(/download failed/);
    const leftovers = execFileSync(
      'sh',
      ['-c', `ls -A "${home}/.test-server" | grep -c '^tmp\\.' || true`],
      {
        encoding: 'utf8',
      },
    ).trim();
    expect(leftovers).toBe('0');
  });

  it('installs below /tmp when the home directory is unusable (common in pods)', async () => {
    const folder = `.dck-fallback-${process.pid}`;
    const fallbackCommit = 'cafe1234';
    const script = buildInstallScript({
      ...options(),
      dataFolderName: folder,
      commit: fallbackCommit,
    });
    try {
      for (const unusableHome of [path.join(work, 'does-not-exist'), '']) {
        const env = { ...process.env, HOME: unusableHome };
        const result = await runProcess('sh', ['-s'], { stdin: script, env });
        const info = parseInstallResult(result.stdout);
        expect(info.serverDir).toBe(`/tmp/${folder}/bin/${fallbackCommit}`);
        process.kill(
          Number((await readFile(`/tmp/${folder}/server-${fallbackCommit}.pid`, 'utf8')).trim()),
          'SIGKILL',
        );
        await rm(`/tmp/${folder}`, { recursive: true, force: true });
      }
    } finally {
      await rm(`/tmp/${folder}`, { recursive: true, force: true });
    }
  });

  it('detects /tmp as the base for a platform whose HOME is unset or missing', async () => {
    for (const home of [undefined, path.join(work, 'does-not-exist')]) {
      const env = { ...process.env };
      if (home === undefined) delete env['HOME'];
      else env['HOME'] = home;
      const result = await runProcess('sh', ['-s'], { stdin: detectPlatformScript, env });
      expect(parsePlatform(result.stdout).home).toBe('/tmp');
    }
    const usable = await runProcess('sh', ['-s'], {
      stdin: detectPlatformScript,
      env: { ...process.env, HOME: home },
    });
    expect(parsePlatform(usable.stdout).home).toBe(home); // a usable home is still preferred
  });

  it('reports a missing launcher', async () => {
    const result = await run(buildInstallScript({ ...options(), applicationName: 'other-name' }));
    expect(result.code).not.toBe(0);
    expect(() => parseInstallResult(result.stdout)).toThrowError(/launcher/);
  });
});
