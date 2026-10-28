import { describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../src/core/logger';
import type { RunResult } from '../../src/core/process';
import { PLATFORM_MARKER } from '../../src/core/server/platform';
import { MISSING_TEMPLATE_MESSAGE, provisionServer } from '../../src/core/server/provisioner';
import type { ServerExecutor } from '../../src/core/server/provisioner';
import { INSTALL_MARKER } from '../../src/core/server/script';

const build = {
  commit: 'abc123',
  quality: 'stable',
  version: '1.103.2',
  serverApplicationName: 'kiro-server',
  serverDataFolderName: '.kiro-server',
  downloadUrlTemplate: 'https://dl.example/${commit}/${os}-${arch}.tar.gz',
};

const ok = (stdout: string): RunResult => ({ code: 0, signal: null, stdout, stderr: '' });
const platformOut = ok(
  `${PLATFORM_MARKER}: start\nkernel==Linux\nmachine==aarch64\nlibc==gnu\nhome==/home/vscode\n${PLATFORM_MARKER}: end\n`,
);
const installOut = ok(
  `${INSTALL_MARKER}: start\nserverDir==/home/vscode/.kiro-server/bin/abc123\nport==41000\ntoken==tok\nnode==/n\nlog==/l\n${INSTALL_MARKER}: end\n`,
);

function fakeExecutor(
  results: RunResult[],
): ServerExecutor & { calls: Parameters<ServerExecutor['exec']>[0][] } {
  const calls: Parameters<ServerExecutor['exec']>[0][] = [];
  return {
    calls,
    exec: (options) => {
      calls.push(options);
      const next = results.shift();
      if (!next) throw new Error('unexpected exec');
      return Promise.resolve(next);
    },
  };
}

describe('provisionServer', () => {
  it('detects the platform, expands the URL and installs as the remote user', async () => {
    const executor = fakeExecutor([platformOut, installOut]);
    const result = await provisionServer(
      executor,
      { containerId: 'c1', user: 'vscode', build },
      new MemoryLogger(),
    );
    expect(result).toMatchObject({ port: 41000, token: 'tok' });
    expect(executor.calls).toHaveLength(2);
    for (const call of executor.calls) {
      expect(call).toMatchObject({
        containerId: 'c1',
        user: 'vscode',
        command: ['sh', '-s'],
        interactive: true,
      });
    }
    expect(executor.calls[1]?.stdin).toContain(
      "DOWNLOAD_URL='https://dl.example/abc123/linux-arm64.tar.gz'",
    );
  });

  it('lets the user template override the IDE-declared one', async () => {
    const executor = fakeExecutor([platformOut, installOut]);
    await provisionServer(
      executor,
      { containerId: 'c1', user: 'u', build, urlTemplate: 'https://mirror.example/${commit}.tgz' },
      new MemoryLogger(),
    );
    expect(executor.calls[1]?.stdin).toContain("DOWNLOAD_URL='https://mirror.example/abc123.tgz'");
  });

  it('keeps the credentials of a private mirror out of the log and the messages', async () => {
    const executor = fakeExecutor([platformOut, installOut]);
    const logger = new MemoryLogger();
    await provisionServer(
      executor,
      {
        containerId: 'c1',
        build,
        urlTemplate: 'https://me:s3cret@mirror.example/${commit}.tgz?sig=t0ken',
      },
      logger,
    );
    const script = executor.calls[1]?.stdin ?? '';
    expect(script).toContain(
      "DOWNLOAD_URL='https://me:s3cret@mirror.example/abc123.tgz?sig=t0ken'",
    );
    expect(script).toContain("DOWNLOAD_LABEL='https://mirror.example/abc123.tgz'");
    expect(script).not.toMatch(/fail "[^"\n]*\$DOWNLOAD_URL/);
    const logged = logger.entries.map((entry) => entry.message).join('\n');
    expect(logged).toContain('https://mirror.example/abc123.tgz');
    expect(logged).not.toMatch(/s3cret|t0ken/);
  });

  it('explains what to do when no download URL is known, before touching the container', async () => {
    const executor = fakeExecutor([]);
    const { downloadUrlTemplate: _template, ...withoutTemplate } = build;
    await expect(
      provisionServer(
        executor,
        { containerId: 'c1', user: 'u', build: withoutTemplate },
        new MemoryLogger(),
      ),
    ).rejects.toMatchObject({ code: 'SERVER_UNSUPPORTED', message: MISSING_TEMPLATE_MESSAGE });
    expect(executor.calls).toHaveLength(0);
  });

  it('surfaces the error reported by the install script', async () => {
    const failed: RunResult = {
      code: 1,
      signal: null,
      stdout: `${INSTALL_MARKER}: start\nerror==download failed: https://dl.example/x\n${INSTALL_MARKER}: end\n`,
      stderr: '',
    };
    await expect(
      provisionServer(
        fakeExecutor([platformOut, failed]),
        { containerId: 'c1', user: 'u', build },
        new MemoryLogger(),
      ),
    ).rejects.toMatchObject({
      code: 'SERVER_INSTALL_FAILED',
      message: expect.not.stringContaining('Kiro publishes'),
    });
  });

  describe('on a platform Kiro publishes no server for', () => {
    const platform = (machine: string, libc: string) =>
      ok(
        `${PLATFORM_MARKER}: start\nkernel==Linux\nmachine==${machine}\nlibc==${libc}\nhome==/home/vscode\n${PLATFORM_MARKER}: end\n`,
      );
    const failed = (error: string): RunResult => ({
      code: 1,
      signal: null,
      stdout: `${INSTALL_MARKER}: start\nerror==${error}\n${INSTALL_MARKER}: end\n`,
      stderr: '',
    });
    const kiro =
      'https://prod.download.desktop.kiro.dev/releases/remotes/${commit}/kiro-reh-${os}-${arch}.tar.gz';
    const install = (machine: string, libc: string, error: string, urlTemplate = kiro) =>
      provisionServer(
        fakeExecutor([platform(machine, libc), failed(error)]),
        {
          containerId: 'c1',
          user: 'u',
          build: { ...build, downloadUrlTemplate: kiro },
          urlTemplate,
        },
        new MemoryLogger(),
      );

    it.each([
      ['x86_64', 'musl', 'alpine-x64 (Alpine Linux, which uses musl)'],
      ['aarch64', 'musl', 'alpine-arm64 (Alpine Linux, which uses musl)'],
      ['armv7l', 'gnu', 'linux-armhf (32-bit ARM)'],
    ])('says why a download from Kiro failed (%s, %s)', async (machine, libc, platformText) => {
      await expect(
        install(machine, libc, 'download failed: https://dl.example/x'),
      ).rejects.toMatchObject({
        code: 'SERVER_INSTALL_FAILED',
        message:
          'download failed: https://dl.example/x. Kiro publishes its server for Linux with glibc ' +
          `on x64 and arm64 only; this container is ${platformText}.`,
      });
    });

    it('says nothing about Kiro for another address, platform or failure', async () => {
      const mirror = 'https://mirror.example/${commit}/${os}-${arch}.tar.gz';
      await expect(
        install('x86_64', 'musl', 'download failed: https://mirror.example/x', mirror),
      ).rejects.toMatchObject({ message: 'download failed: https://mirror.example/x' });
      await expect(install('x86_64', 'musl', 'extraction failed')).rejects.toMatchObject({
        message: 'extraction failed',
      });
      await expect(
        install('x86_64', 'gnu', 'download failed: https://prod.download.desktop.kiro.dev/x'),
      ).rejects.toMatchObject({
        message: 'download failed: https://prod.download.desktop.kiro.dev/x',
      });
    });
  });

  it('reports a failing container inspection with the tail of stderr', async () => {
    const broken: RunResult = {
      code: 126,
      signal: null,
      stdout: '',
      stderr: 'OCI runtime exec failed: sh: not found',
    };
    await expect(
      provisionServer(
        fakeExecutor([broken]),
        { containerId: 'c1', user: 'u', build },
        new MemoryLogger(),
      ),
    ).rejects.toMatchObject({
      code: 'SERVER_INSTALL_FAILED',
      message: expect.stringContaining('sh: not found'),
    });
  });
});

/**
 * A fake container: answers each script by its content and keeps the settings file in memory, so
 * the read-merge-write cycle can be observed end to end.
 */
function fakeContainer(initialSettings = '') {
  let settingsFile = initialSettings;
  const scripts: string[] = [];
  const executor: ServerExecutor = {
    exec: (options) => {
      const script = options.stdin ?? '';
      scripts.push(script);
      if (script.includes(`${PLATFORM_MARKER}: start`)) return Promise.resolve(platformOut);
      if (script.includes(`${INSTALL_MARKER}: start`)) return Promise.resolve(installOut);
      if (script.startsWith('cat ')) return Promise.resolve(ok(settingsFile));
      const heredoc = /<<'(DCK_[0-9a-f]+)'\n([\s\S]*?)\n\1\n/.exec(script);
      if (heredoc) settingsFile = `${heredoc[2]}\n`;
      return Promise.resolve(ok(''));
    },
  };
  return { executor, scripts, settings: () => settingsFile };
}

describe('provisionServer with extensions and settings', () => {
  const input = { containerId: 'c1', user: 'vscode', build };

  it('does nothing extra when the configuration asks for neither', async () => {
    const container = fakeContainer();
    await provisionServer(container.executor, input, new MemoryLogger());
    expect(container.scripts).toHaveLength(2); // platform + install
    expect(container.scripts[1]).not.toContain('--install-extension');
  });

  it('starts the server with the requested extensions', async () => {
    const container = fakeContainer();
    await provisionServer(
      container.executor,
      { ...input, extensions: ['esbenp.prettier-vscode', 'redhat.vscode-yaml'] },
      new MemoryLogger(),
    );
    const install = container.scripts.at(-1) ?? '';
    expect(install).toContain("'--install-extension' 'esbenp.prettier-vscode'");
    expect(install).toContain("'--install-extension' 'redhat.vscode-yaml'");
  });

  it('writes the settings below the server data folder before starting the server', async () => {
    const container = fakeContainer();
    await provisionServer(
      container.executor,
      { ...input, settings: { 'editor.tabSize': 2 } },
      new MemoryLogger(),
    );
    expect(container.scripts).toHaveLength(4); // platform, read, write, install
    expect(container.scripts[1]).toContain(
      "'/home/vscode/.kiro-server/data/Machine/settings.json'",
    );
    expect(JSON.parse(container.settings())).toEqual({ 'editor.tabSize': 2 });
    expect(container.scripts[3]).toContain(`${INSTALL_MARKER}: start`);
  });

  it('keeps what is already in the container settings and overrides only the given keys', async () => {
    const container = fakeContainer(
      '{\n  // mine\n  "files.autoSave": "off",\n  "editor.tabSize": 8\n}\n',
    );
    await provisionServer(
      container.executor,
      { ...input, settings: { 'editor.tabSize': 2 } },
      new MemoryLogger(),
    );
    expect(container.settings()).toContain('// mine');
    expect(container.settings()).toContain('"files.autoSave": "off"');
    expect(container.settings()).toContain('"editor.tabSize": 2');
  });

  it('skips the write when the settings are already up to date', async () => {
    const container = fakeContainer();
    await provisionServer(container.executor, { ...input, settings: { a: 1 } }, new MemoryLogger());
    container.scripts.length = 0;
    await provisionServer(container.executor, { ...input, settings: { a: 1 } }, new MemoryLogger());
    expect(container.scripts).toHaveLength(3); // platform, read, install (no write)
  });

  it('keeps going and warns when the container settings file is not valid JSON', async () => {
    const container = fakeContainer('{ "broken": ');
    const logger = new MemoryLogger();
    const result = await provisionServer(
      container.executor,
      { ...input, settings: { a: 1 } },
      logger,
    );
    expect(result.port).toBe(41000);
    expect(
      logger.entries.some(
        (entry) => entry.level === 'warn' && /left unchanged/.test(entry.message),
      ),
    ).toBe(true);
    expect(container.settings()).toBe('{ "broken": '); // untouched
  });

  it('rejects an extension id that is not a plain id', async () => {
    const container = fakeContainer();
    await expect(
      provisionServer(
        container.executor,
        { ...input, extensions: ['x; reboot'] },
        new MemoryLogger(),
      ),
    ).rejects.toMatchObject({ code: 'SERVER_UNSUPPORTED' });
  });
});

describe('provisionServer with the Kiro sign-in', () => {
  const login = '{"accessToken":"SECRET-ACCESS"}';
  const copied = ok('copied\n');

  it('copies the sign-in as the remote user after the platform check and before the install', async () => {
    const executor = fakeExecutor([platformOut, copied, installOut]);
    const logger = new MemoryLogger();
    await provisionServer(
      executor,
      { containerId: 'c1', user: 'vscode', build, kiroLogin: login },
      logger,
    );
    expect(executor.calls).toHaveLength(3);
    expect(executor.calls[1]).toMatchObject({ user: 'vscode', command: ['sh', '-s'] });
    expect(executor.calls[1]?.stdin).toContain(login);
    expect(executor.calls[1]?.stdin).toContain('kiro-auth-token.json');
    expect(executor.calls[2]?.stdin).toContain('DOWNLOAD_URL=');
    expect(logger.entries).toContainEqual({
      level: 'info',
      message: 'Copied the Kiro sign-in of this machine into the container.',
    });
  });

  it('asks first when asked to, only if the container has no sign-in, and copies on "yes"', async () => {
    const questions: string[] = [];
    const confirm = async (): Promise<boolean> => {
      questions.push('asked');
      return true;
    };
    const executor = fakeExecutor([platformOut, ok('missing\n'), copied, installOut]);
    await provisionServer(
      executor,
      { containerId: 'c1', user: 'u', build, kiroLogin: login, confirmKiroLogin: confirm },
      new MemoryLogger(),
    );
    expect(questions).toHaveLength(1);
    expect(executor.calls[1]?.stdin).not.toContain(login); // the check carries no secret
    expect(executor.calls[2]?.stdin).toContain(login);
  });

  it('copies nothing when the user says no', async () => {
    const executor = fakeExecutor([platformOut, ok('missing\n'), installOut]);
    const logger = new MemoryLogger();
    await provisionServer(
      executor,
      {
        containerId: 'c1',
        user: 'u',
        build,
        kiroLogin: login,
        confirmKiroLogin: async () => false,
      },
      logger,
    );
    expect(executor.calls.map((call) => call.stdin).join('\n')).not.toContain(login);
    expect(logger.entries.map((e) => e.message)).toContain(
      'The Kiro sign-in was not copied into the container (not confirmed).',
    );
  });

  it.each(['exists', 'nohome'])('does not ask when the container answers %s', async (answer) => {
    let asked = false;
    const executor = fakeExecutor([platformOut, ok(`${answer}\n`), installOut]);
    await provisionServer(
      executor,
      {
        containerId: 'c1',
        user: 'u',
        build,
        kiroLogin: login,
        confirmKiroLogin: async () => (asked = true),
      },
      new MemoryLogger(),
    );
    expect(asked).toBe(false);
    expect(executor.calls).toHaveLength(3);
  });

  it('does nothing when the sign-in is not shared', async () => {
    const executor = fakeExecutor([platformOut, installOut]);
    await provisionServer(executor, { containerId: 'c1', user: 'u', build }, new MemoryLogger());
    expect(executor.calls.map((call) => call.stdin).join('\n')).not.toContain('kiro-auth-token');
  });

  it.each([
    ['exists', 'info', 'already has a Kiro sign-in'],
    ['nohome', 'warn', 'no writable home directory'],
  ])('reports %s', async (answer, level, text) => {
    const executor = fakeExecutor([platformOut, ok(`${answer}\n`), installOut]);
    const logger = new MemoryLogger();
    await provisionServer(
      executor,
      { containerId: 'c1', user: 'u', build, kiroLogin: login },
      logger,
    );
    const entry = logger.entries.find((e) => e.message.includes(text));
    expect(entry?.level).toBe(level);
  });

  it('keeps going and warns when copying fails, without leaking the content', async () => {
    const failed: RunResult = {
      code: 1,
      signal: null,
      stdout: `SECRET-ACCESS ${login}`,
      stderr: `sh: SECRET-ACCESS ${login}`,
    };
    const executor = fakeExecutor([platformOut, failed, installOut]);
    const logger = new MemoryLogger();
    const result = await provisionServer(
      executor,
      { containerId: 'c1', user: 'u', build, kiroLogin: login },
      logger,
    );
    expect(result.port).toBe(41000);
    const warning = logger.entries.find((e) => e.level === 'warn');
    expect(warning?.message).toContain('Could not copy the Kiro sign-in');
    expect(JSON.stringify(logger.entries)).not.toContain('SECRET-ACCESS');
  });

  it('stops when the operation was cancelled while copying', async () => {
    const controller = new AbortController();
    const executor: ServerExecutor = {
      exec: (options) => {
        if (options.stdin?.includes('kiro-auth-token')) {
          controller.abort();
          return Promise.reject(new Error('aborted'));
        }
        return Promise.resolve(platformOut);
      },
    };
    await expect(
      provisionServer(
        executor,
        { containerId: 'c1', user: 'u', build, kiroLogin: login },
        new MemoryLogger(),
        controller.signal,
      ),
    ).rejects.toThrow('aborted');
  });
});
