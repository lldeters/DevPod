// Runs the real, pinned @devcontainers/cli. A tiny docker stub (answers "no containers") lets
// `read-configuration` run without a container engine, so these tests work anywhere with Node.
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfigurationArgs, upArgs } from '../../src/core/cli/args';
import { DevContainerCli, resolveCliLocation } from '../../src/core/cli/devcontainerCli';
import { MemoryLogger } from '../../src/core/logger';
import { runProcess } from '../../src/core/process';

const cliEntry = require.resolve('@devcontainers/cli/devcontainer.js');
const node = process.execPath;

let root: string;
let dockerStub: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'dck-cli-')));
  dockerStub = path.join(root, 'docker-stub');
  await writeFile(dockerStub, '#!/bin/sh\nexit 0\n');
  await chmod(dockerStub, 0o755);

  const repo = path.join(root, 'repo');
  const sub = path.join(repo, 'sub');
  await mkdir(path.join(sub, '.devcontainer'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  await writeFile(
    path.join(sub, '.devcontainer', 'devcontainer.json'),
    '// comment\n{ "name": "probe", "image": "ubuntu:24.04", "remoteEnv": { "B": "${localWorkspaceFolderBasename}" }, }\n',
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function help(command: string): Promise<string> {
  const result = await runProcess(node, [cliEntry, command, '--help']);
  return result.stdout;
}

describe('flags emitted by the argument builders exist in the pinned CLI', () => {
  const flagsOf = (args: string[]): string[] => args.filter((arg) => arg.startsWith('--'));

  it('up', async () => {
    const text = await help('up');
    const args = upArgs({
      workspaceFolder: '/w',
      configFile: '/c',
      dockerPath: 'docker',
      dockerComposePath: 'dc',
      removeExistingContainer: true,
      buildNoCache: true,
      expectExistingContainer: true,
      skipPostCreate: true,
      skipNonBlockingCommands: true,
      includeConfiguration: true,
      includeMergedConfiguration: true,
      remoteEnv: { A: '1' },
      dotfiles: { repository: 'r', installCommand: 'i', targetPath: 't' },
    });
    for (const flag of flagsOf(args)) {
      expect(text, flag).toContain(flag);
    }
  });

  it('read-configuration', async () => {
    const text = await help('read-configuration');
    const args = readConfigurationArgs({
      workspaceFolder: '/w',
      configFile: '/c',
      dockerPath: 'd',
      dockerComposePath: 'dc',
      includeMergedConfiguration: true,
    });
    for (const flag of flagsOf(args)) {
      expect(text, flag).toContain(flag);
    }
  });
});

describe('DevContainerCli.readConfiguration (real CLI)', () => {
  it('returns the container workspace folder, honoring the Git root', async () => {
    const logger = new MemoryLogger();
    const cli = new DevContainerCli(
      () => resolveCliLocation({ bundledEntry: cliEntry, nodeExecutable: node }),
      logger,
      () => ({ dockerPath: dockerStub }),
    );
    const result = await cli.readConfiguration({ workspaceFolder: path.join(root, 'repo', 'sub') });

    // The CLI mounts the Git root, so a sub folder maps below /workspaces/<repo>.
    expect(result.workspace.workspaceFolder).toBe('/workspaces/repo/sub');
    expect(result.configuration['name']).toBe('probe');
    expect(result.configuration['remoteEnv']).toEqual({ B: 'sub' });
    expect(logger.entries.some((entry) => entry.message.includes('@devcontainers/cli'))).toBe(true);
  });

  it('reports a missing configuration as an error', async () => {
    const empty = path.join(root, 'empty');
    await mkdir(empty);
    const cli = new DevContainerCli(
      () => resolveCliLocation({ bundledEntry: cliEntry, nodeExecutable: node }),
      new MemoryLogger(),
      () => ({ dockerPath: dockerStub }),
    );
    await expect(cli.readConfiguration({ workspaceFolder: empty })).rejects.toMatchObject({
      code: 'CLI_FAILED',
    });
  });

  it('fails with a CLI error when the container engine cannot be started', async () => {
    const cli = new DevContainerCli(
      () => resolveCliLocation({ bundledEntry: cliEntry, nodeExecutable: node }),
      new MemoryLogger(),
      () => ({ dockerPath: path.join(root, 'no-such-docker') }),
    );
    await expect(
      cli.readConfiguration({ workspaceFolder: path.join(root, 'repo', 'sub') }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/CLI_/) });
  });
});
