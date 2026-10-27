import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
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

  it('downloads with curl over https only, also after redirects', () => {
    expect(buildInstallScript(base)).toContain("--proto '=https,file' --proto-redir '=https'");
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
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$(dirname "$0")/../args.txt"\necho started >> "$(dirname "$0")/../starts.txt"\necho "Extension host agent listening on 45678"\nexec sleep 120\n',
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
    // the server keeps its data next to itself, also when that is not below $HOME
    expect(args[args.indexOf('--server-data-dir') + 1]).toBe(path.join(home, '.test-server'));
  });

  const starts = async (info: { serverDir: string }): Promise<number> =>
    (await readFile(path.join(info.serverDir, 'starts.txt'), 'utf8')).trim().split('\n').length;

  it('starts one server when two windows set it up at the same time', async () => {
    const [first, second] = await Promise.all([
      run(buildInstallScript(options())),
      run(buildInstallScript(options())),
    ]);
    const a = parseInstallResult(first.stdout);
    const b = parseInstallResult(second.stdout);
    expect(b).toEqual(a);
    expect(await starts(a)).toBe(1);
    const token = await readFile(path.join(home, '.test-server', `server-${commit}.token`), 'utf8');
    expect(a.token).toBe(token);
  });

  it('starts a new server when the recorded PID now belongs to another process', async () => {
    const first = parseInstallResult((await run(buildInstallScript(options()))).stdout);
    const pidFile = path.join(home, '.test-server', `server-${commit}.pid`);
    process.kill(Number((await readFile(pidFile, 'utf8')).trim()), 'SIGKILL');
    // After a restart of the container the old PID can be reused by an unrelated process.
    const stranger = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      await writeFile(pidFile, `${stranger.pid}\n`);
      const second = parseInstallResult((await run(buildInstallScript(options()))).stdout);
      expect(second.token).not.toBe(first.token);
      expect(await starts(second)).toBe(2);
    } finally {
      stranger.kill('SIGKILL');
    }
  });

  it('takes over a setup lock whose owner is gone', async () => {
    const lock = path.join(home, '.test-server', 'setup.lock');
    await mkdir(lock, { recursive: true });
    const gone = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim();
    await writeFile(path.join(lock, 'owner'), `${gone} 1\n`);
    const result = await run(buildInstallScript(options()));
    expect(parseInstallResult(result.stdout).port).toBe(45678);
    await expect(readFile(path.join(lock, 'owner'), 'utf8')).rejects.toThrow(); // released
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

  const fallbackOf = (tmp: string): string =>
    path.join(tmp, `devcontainers-kiro-${process.getuid?.() ?? 0}`);

  it('installs in a private temporary folder when the home directory is unusable (common in pods)', async () => {
    const tmp = path.join(work, 'tmp');
    await mkdir(tmp);
    const root = path.join(fallbackOf(tmp), '.test-server');
    for (const unusableHome of [path.join(work, 'does-not-exist'), '']) {
      const env = { ...process.env, HOME: unusableHome, TMPDIR: tmp };
      const result = await runProcess('sh', ['-s'], { stdin: buildInstallScript(options()), env });
      const info = parseInstallResult(result.stdout);
      expect(info.serverDir).toBe(path.join(root, 'bin', commit));
      const args = (await readFile(path.join(info.serverDir, 'args.txt'), 'utf8')).split('\n');
      expect(args[args.indexOf('--server-data-dir') + 1]).toBe(root);
      expect(execFileSync('stat', ['-c', '%a', fallbackOf(tmp)], { encoding: 'utf8' }).trim()).toBe(
        '700',
      );
      process.kill(
        Number((await readFile(path.join(root, `server-${commit}.pid`), 'utf8')).trim()),
        'SIGKILL',
      );
      await rm(fallbackOf(tmp), { recursive: true, force: true });
    }
  });

  it('detects the private temporary folder as the base when HOME is unset or missing', async () => {
    const tmp = path.join(work, 'tmp');
    await mkdir(tmp);
    for (const unusable of [undefined, path.join(work, 'does-not-exist')]) {
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
      if (unusable === undefined) delete env['HOME'];
      else env['HOME'] = unusable;
      const result = await runProcess('sh', ['-s'], { stdin: detectPlatformScript, env });
      expect(parsePlatform(result.stdout).home).toBe(fallbackOf(tmp));
    }
    const usable = await runProcess('sh', ['-s'], {
      stdin: detectPlatformScript,
      env: { ...process.env, HOME: home },
    });
    expect(parsePlatform(usable.stdout).home).toBe(home); // a usable home is still preferred
  });

  it('refuses a fallback folder that someone else may have prepared', async () => {
    const tmp = path.join(work, 'tmp');
    await mkdir(path.join(work, 'elsewhere'), { recursive: true });
    await mkdir(tmp);
    await symlink(path.join(work, 'elsewhere'), fallbackOf(tmp));
    const env = { ...process.env, HOME: path.join(work, 'does-not-exist'), TMPDIR: tmp };
    const detected = await runProcess('sh', ['-s'], { stdin: detectPlatformScript, env });
    expect(() => parsePlatform(detected.stdout)).toThrowError(/fallback folder/);
    const installed = await runProcess('sh', ['-s'], { stdin: buildInstallScript(options()), env });
    expect(() => parseInstallResult(installed.stdout)).toThrowError(/no usable folder/);
  });

  it('reports a missing launcher', async () => {
    const result = await run(buildInstallScript({ ...options(), applicationName: 'other-name' }));
    expect(result.code).not.toBe(0);
    expect(() => parseInstallResult(result.stdout)).toThrowError(/launcher/);
  });

  // What the scripts need from PATH, so a test can leave a program out (curl, to use wget).
  const TOOLS = [
    'cat',
    'chmod',
    'cp',
    'dirname',
    'gzip',
    'head',
    'id',
    'mkdir',
    'mktemp',
    'mv',
    'nohup',
    'od',
    'rm',
    'sed',
    'setsid',
    'sleep',
    'stat',
    'tail',
    'tar',
    'touch',
    'tr',
  ];
  /** A folder for PATH with just `tools` (where installed) and the stand-ins in `stubs`. */
  const toolbox = async (
    tools: readonly string[],
    stubs: Record<string, string> = {},
  ): Promise<string> => {
    const dir = await mkdtemp(path.join(work, 'toolbox-'));
    for (const tool of tools) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' });
      if (found.status === 0) await symlink(found.stdout.trim(), path.join(dir, tool));
    }
    for (const [name, script] of Object.entries(stubs)) {
      await writeFile(path.join(dir, name), script);
      await chmod(path.join(dir, name), 0o755);
    }
    return dir;
  };

  describe('with wget instead of curl', () => {
    // Copies $WGET_SOURCE to the -O file and reports $WGET_HEADERS as the server's responses.
    const wget = `#!/bin/sh
out=''
while [ $# -gt 0 ]; do case "$1" in -O) out="$2"; shift 2 ;; *) shift ;; esac; done
printf '%s\\n' "$WGET_HEADERS" >&2
cp "$WGET_SOURCE" "$out"
`;
    const install = async (headers: string) =>
      runProcess('/bin/sh', ['-s'], {
        stdin: buildInstallScript({ ...options(), downloadUrl: 'https://example.invalid/s.tgz' }),
        env: {
          PATH: await toolbox(TOOLS, { wget }),
          HOME: home,
          WGET_SOURCE: archive,
          WGET_HEADERS: headers,
        },
      });

    it('installs when every redirect stays on https', async () => {
      const result = await install(
        [
          '  HTTP/1.1 302 Found',
          '  Location: https://cdn.example/s.tgz\r',
          '  HTTP/1.1 301 Moved Permanently',
          '  location: /elsewhere/s.tgz',
          '  HTTP/1.1 200 OK',
        ].join('\n'),
      );
      expect(parseInstallResult(result.stdout).port).toBe(45678);
    });

    it.each(['http://mirror.example/s.tgz', 'ftp://mirror.example/s.tgz'])(
      'refuses a download that was redirected to %s',
      async (target) => {
        const result = await install(
          `  HTTP/1.1 302 Found\n  Location: ${target}\r\n  HTTP/1.1 200 OK`,
        );
        expect(() => parseInstallResult(result.stdout)).toThrowError(
          /redirected to an address that is not https/,
        );
        await expect(stat(path.join(home, '.test-server', 'bin', commit))).rejects.toThrow();
      },
    );
  });

  it('leaves a setup lock alone that another run took over meanwhile', async () => {
    // A launcher that takes the lock over while this run still holds it, as a second run would.
    const launcher = path.join(work, 'src', 'fake-server-linux-x64', 'bin', 'fake-server');
    await writeFile(
      launcher,
      '#!/bin/sh\necho "1 1" > "$(dirname "$0")/../../../setup.lock/owner"\necho "Extension host agent listening on 45678"\nexec sleep 120\n',
    );
    execFileSync('tar', ['-czf', archive, '-C', path.join(work, 'src'), 'fake-server-linux-x64']);
    const result = await run(buildInstallScript(options()));
    expect(parseInstallResult(result.stdout).port).toBe(45678);
    const owner = path.join(home, '.test-server', 'setup.lock', 'owner');
    expect(await readFile(owner, 'utf8')).toBe('1 1\n');
  });

  it('uses the private temporary folder when everyone may write to the home directory', async () => {
    const tmp = path.join(work, 'tmp');
    const shared = path.join(work, 'shared-home');
    await mkdir(tmp);
    await mkdir(shared);
    await chmod(shared, 0o1777);
    const env = { ...process.env, HOME: shared, TMPDIR: tmp };
    const detected = await runProcess('sh', ['-s'], { stdin: detectPlatformScript, env });
    expect(parsePlatform(detected.stdout).home).toBe(fallbackOf(tmp));
    const result = await runProcess('sh', ['-s'], { stdin: buildInstallScript(options()), env });
    const root = path.join(fallbackOf(tmp), '.test-server');
    expect(parseInstallResult(result.stdout).serverDir).toBe(path.join(root, 'bin', commit));
    process.kill(
      Number((await readFile(path.join(root, `server-${commit}.pid`), 'utf8')).trim()),
      'SIGKILL',
    );
    await expect(stat(path.join(shared, '.test-server'))).rejects.toThrow();
  });

  it('starts no server without a connection token', async () => {
    const result = await runProcess('/bin/sh', ['-s'], {
      stdin: buildInstallScript(options()),
      env: {
        PATH: await toolbox([...TOOLS.filter((tool) => tool !== 'head'), 'curl']),
        HOME: home,
      },
    });
    expect(() => parseInstallResult(result.stdout)).toThrowError(/connection token/);
    await expect(stat(path.join(home, '.test-server', `server-${commit}.pid`))).rejects.toThrow();
  });
});
