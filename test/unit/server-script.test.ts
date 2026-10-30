import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
const hasFlock = spawnSync('sh', ['-c', 'command -v flock']).status === 0;

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
    // A stand-in replaces the tool of that name; writing it over a link would replace the real one.
    for (const tool of tools.filter((name) => !Object.hasOwn(stubs, name))) {
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

    it.each([
      'http://mirror.example/s.tgz',
      'ftp://mirror.example/s.tgz',
      // BusyBox wget reads an address without a scheme as http://
      'mirror.example/s.tgz',
      's.tgz',
    ])('refuses a download that was redirected to %s', async (target) => {
      const result = await install(
        `  HTTP/1.1 302 Found\n  Location: ${target}\r\n  HTTP/1.1 200 OK`,
      );
      expect(() => parseInstallResult(result.stdout)).toThrowError(
        /redirected to an address that is not https/,
      );
      await expect(stat(path.join(home, '.test-server', 'bin', commit))).rejects.toThrow();
    });
  });

  it('refuses a wget that does not show the responses on stderr (like Wget2)', async () => {
    const result = await runProcess('/bin/sh', ['-s'], {
      stdin: buildInstallScript({ ...options(), downloadUrl: 'https://example.invalid/s.tgz' }),
      env: {
        PATH: await toolbox(TOOLS, {
          wget: '#!/bin/sh\nwhile [ $# -gt 0 ]; do case "$1" in -O) cp "$WGET_SOURCE" "$2"; shift 2 ;; *) shift ;; esac; done\n',
        }),
        HOME: home,
        WGET_SOURCE: archive,
      },
    });
    expect(() => parseInstallResult(result.stdout)).toThrowError(/install curl/);
  });

  describe('setup lock', () => {
    const root = (): string => path.join(home, '.test-server');
    const exists = async (file: string): Promise<boolean> =>
      stat(file).then(
        () => true,
        () => false,
      );
    /** Runs the install script with just `tools` (and `stubs`) on PATH. */
    const install = async (tools: readonly string[], stubs: Record<string, string> = {}) =>
      runProcess('/bin/sh', ['-s'], {
        stdin: buildInstallScript(options()),
        env: { PATH: await toolbox(tools, stubs), HOME: home },
      });
    const WITH_FLOCK = [...TOOLS, 'curl', 'flock'];
    const WITHOUT_FLOCK = [...TOOLS, 'curl'];

    it.each([
      ...(hasFlock ? [['with flock', WITH_FLOCK, true] as const] : []),
      ['with a lock directory where flock is missing', WITHOUT_FLOCK, false] as const,
    ])(
      'starts one server when three windows set it up at the same time (%s)',
      async (_, tools, flock) => {
        const setUp = async () => parseInstallResult((await install(tools)).stdout);
        const [a, b, c] = await Promise.all([setUp(), setUp(), setUp()]);
        expect(b).toEqual(a);
        expect(c).toEqual(a);
        expect(await starts(a)).toBe(1);
        const token = await readFile(path.join(root(), `server-${commit}.token`), 'utf8');
        expect(a.token).toBe(token);
        // flock leaves its file behind, unlocked; a lock directory is removed again
        expect(await exists(path.join(root(), 'setup.flock'))).toBe(flock);
        expect(await exists(path.join(root(), 'setup.lock'))).toBe(false);
      },
    );

    it('uses a lock directory where flock does not work on the file system', async () => {
      const result = await install(WITHOUT_FLOCK, { flock: '#!/bin/sh\nexit 1\n' });
      expect(parseInstallResult(result.stdout).port).toBe(45678);
      expect(await exists(path.join(root(), 'setup.flock'))).toBe(false);
      expect(await exists(path.join(root(), 'setup.lock'))).toBe(false);
      const probes = execFileSync('sh', ['-c', `ls -A "${root()}" | grep -c '^flock\\.' || true`], {
        encoding: 'utf8',
      });
      expect(probes.trim()).toBe('0'); // the file flock was tried on is gone
    });

    it.skipIf(!hasFlock)(
      'is not held up by a download that a killed run left running',
      async () => {
        // A curl that hangs; it records its PID so that it can be stopped afterwards.
        const stuck = path.join(work, 'stuck.pid');
        const curl = '#!/bin/sh\necho $$ > "$STUCK_PID"\nexec sleep 60\n';
        const first = spawn('/bin/sh', ['-s'], {
          env: { PATH: await toolbox([...TOOLS, 'flock'], { curl }), HOME: home, STUCK_PID: stuck },
          stdio: ['pipe', 'ignore', 'ignore'],
        });
        first.stdin.on('error', () => undefined);
        first.stdin.end(buildInstallScript(options()));
        try {
          await vi.waitFor(() => readFile(stuck, 'utf8'), { timeout: 10_000, interval: 50 });
          first.kill('SIGKILL'); // while it holds the lock
          const started = Date.now();
          const result = await install(WITH_FLOCK);
          expect(parseInstallResult(result.stdout).port).toBe(45678);
          expect(Date.now() - started).toBeLessThan(10_000);
        } finally {
          first.kill('SIGKILL');
          const pid = Number((await readFile(stuck, 'utf8').catch(() => '')).trim());
          try {
            if (pid > 0) process.kill(pid, 'SIGKILL');
          } catch {
            // already gone
          }
        }
      },
    );

    const MODES = [
      ...(hasFlock ? [['with flock', WITH_FLOCK] as const] : []),
      ['without flock', WITHOUT_FLOCK] as const,
    ];

    it.each(MODES)(
      'waits for a run that holds only the lock directory, as older versions do (%s)',
      async (_, tools) => {
        // The holder stands in for a run of a version that knows only the lock directory, in a
        // window that was not reloaded after an update.
        const holder = spawn('sleep', ['30'], { stdio: 'ignore' });
        try {
          const lock = path.join(root(), 'setup.lock');
          await mkdir(lock, { recursive: true });
          await writeFile(path.join(lock, 'owner'), `${holder.pid}\n`);
          const running = install(tools);
          await new Promise((resolve) => setTimeout(resolve, 3000));
          await expect(stat(path.join(root(), 'bin', commit))).rejects.toThrow(); // still waiting
          holder.kill('SIGKILL');
          expect(parseInstallResult((await running).stdout).port).toBe(45678);
        } finally {
          holder.kill('SIGKILL');
        }
      },
    );

    it.each(MODES)('takes over a lock directory whose owner is gone (%s)', async (_, tools) => {
      const lock = path.join(root(), 'setup.lock');
      await mkdir(lock, { recursive: true });
      const gone = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim();
      await writeFile(path.join(lock, 'owner'), `${gone} 1\n`);
      const result = await install(tools);
      expect(parseInstallResult(result.stdout).port).toBe(45678);
      await expect(readFile(path.join(lock, 'owner'), 'utf8')).rejects.toThrow(); // released
    });

    it.each(MODES)(
      'leaves a lock directory alone that another run took over meanwhile (%s)',
      async (_, tools) => {
        // A launcher that takes the lock over while this run still holds it, as a second run would.
        const launcher = path.join(work, 'src', 'fake-server-linux-x64', 'bin', 'fake-server');
        await writeFile(
          launcher,
          '#!/bin/sh\necho "1 1" > "$(dirname "$0")/../../../setup.lock/owner"\necho "Extension host agent listening on 45678"\nexec sleep 120\n',
        );
        execFileSync('tar', [
          '-czf',
          archive,
          '-C',
          path.join(work, 'src'),
          'fake-server-linux-x64',
        ]);
        const result = await install(tools);
        expect(parseInstallResult(result.stdout).port).toBe(45678);
        expect(await readFile(path.join(root(), 'setup.lock', 'owner'), 'utf8')).toBe('1 1\n');
      },
    );

    // The real program behind a name on PATH, for stand-ins that call it.
    const which = (tool: string): string =>
      spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();

    it('starts one server when three windows set it up at the same time where mkdir is not atomic', async () => {
      // Like uutils' mkdir 0.0.24, which also reports success when another run creates the
      // directory at the same moment; here always, as the worst case.
      const nonAtomicMkdir = `#!/bin/sh\nfor last in "$@"; do :; done\n"${which('mkdir')}" "$@" 2>/dev/null || [ -d "$last" ]\n`;
      const setUp = async () =>
        parseInstallResult((await install(WITHOUT_FLOCK, { mkdir: nonAtomicMkdir })).stdout);
      const [a, b, c] = await Promise.all([setUp(), setUp(), setUp()]);
      expect(b).toEqual(a);
      expect(c).toEqual(a);
      expect(await starts(a)).toBe(1);
      expect(await exists(path.join(root(), 'setup.lock'))).toBe(false);
    });

    it.each(MODES)(
      'removes a stale lock only while it still names the holder that was found gone (%s)',
      async (_, tools) => {
        const lock = path.join(root(), 'setup.lock');
        await mkdir(lock, { recursive: true });
        const gone = spawnSync('sh', ['-c', 'echo $$']).stdout.toString().trim();
        await writeFile(path.join(lock, 'owner'), `${gone} 1\n`);
        // The holder that is found gone ended normally right after its owner was read, and the next
        // run (this test process) took a new lock: a cat that makes it so on that first read.
        const fields = (await readFile('/proc/self/stat', 'utf8')).replace(/^.*\) /, '').split(' ');
        const next = `${process.pid} ${fields[19]}`;
        const cat = [
          '#!/bin/sh',
          'case "$1" in */setup.lock/owner)',
          `  if [ ! -e "$1.read" ]; then "${which('cat')}" "$1"; : > "$1.read"; echo '${next}' > "$1"; exit 0; fi ;;`,
          'esac',
          `exec "${which('cat')}" "$@"`,
          '',
        ].join('\n');
        const running = install(tools, { cat });
        await new Promise((resolve) => setTimeout(resolve, 1500));
        // The run waits for the new holder instead of removing its lock.
        expect(await readFile(path.join(lock, 'owner'), 'utf8')).toBe(`${next}\n`);
        await rm(lock, { recursive: true }); // the new holder is done
        expect(parseInstallResult((await running).stdout).port).toBe(45678);
      },
    );
  });

  it('installs in a home directory everyone may write to, such as an emptyDir volume', async () => {
    await chmod(home, 0o777);
    const info = parseInstallResult((await run(buildInstallScript(options()))).stdout);
    expect(info.serverDir).toBe(path.join(home, '.test-server', 'bin', commit));
  });

  it('refuses a server folder that belongs to another user', async () => {
    // A stand-in for stat that reports another owner, as for a folder someone else created first.
    const stat = '#!/bin/sh\necho 4242\n';
    const result = await runProcess('/bin/sh', ['-s'], {
      stdin: buildInstallScript(options()),
      env: {
        PATH: await toolbox([...TOOLS.filter((tool) => tool !== 'stat'), 'curl'], { stat }),
        HOME: home,
      },
    });
    expect(() => parseInstallResult(result.stdout)).toThrowError(
      /belongs to another user \(uid 4242\)/,
    );
    await expect(
      readFile(path.join(home, '.test-server', `server-${commit}.pid`)),
    ).rejects.toThrow();
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
