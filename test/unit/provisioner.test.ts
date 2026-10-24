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
      message: expect.stringContaining('download failed'),
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
