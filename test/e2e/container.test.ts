// End-to-end test with a real container engine. It runs only when DCK_E2E=1 (CI sets it) because
// it pulls an image and needs a running Docker daemon.
//
// It covers what cannot be unit-tested: `devcontainer up` through our wrapper, lifecycle hooks,
// server provisioning inside a real container, and the stdio bridge to a server in it.
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevContainerCli, resolveCliLocation } from '../../src/core/cli/devcontainerCli';
import { ContainerEngine, execArgs } from '../../src/core/engine/containerEngine';
import { MemoryLogger } from '../../src/core/logger';
import { provisionServer } from '../../src/core/server/provisioner';
import { BRIDGE_SCRIPT } from '../../src/core/server/script';

const enabled = process.env['DCK_E2E'] === '1';
const cliEntry = require.resolve('@devcontainers/cli/devcontainer.js');

describe.skipIf(!enabled)('dev container end to end', () => {
  let root: string;
  let workspace: string;
  let archive: string;
  let containerId: string | undefined;
  const logger = new MemoryLogger();
  const engine = new ContainerEngine(() => 'docker');
  const cli = new DevContainerCli(
    () => resolveCliLocation({ bundledEntry: cliEntry, nodeExecutable: process.execPath }),
    logger,
  );

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'dck-e2e-')));
    workspace = path.join(root, 'app');
    await mkdir(path.join(workspace, '.devcontainer'), { recursive: true });
    await writeFile(
      path.join(workspace, '.devcontainer', 'devcontainer.json'),
      JSON.stringify({
        name: 'e2e',
        image: 'mcr.microsoft.com/devcontainers/javascript-node:22',
        postCreateCommand: 'echo created > /tmp/dck-marker',
        remoteEnv: { DCK_E2E_VAR: 'yes' },
      }),
    );

    // A fake IDE server: a launcher plus a Node echo server that announces its port like the real
    // one does. The container's own Node binary runs it, as it will run the bridge.
    const top = path.join(root, 'src', 'fake-server-linux-x64');
    await mkdir(path.join(top, 'bin'), { recursive: true });
    await writeFile(
      path.join(top, 'server.js'),
      [
        "const net = require('net');",
        'const server = net.createServer((s) => s.pipe(s));',
        "server.listen(0, '127.0.0.1', () => {",
        "  console.log('Extension host agent listening on ' + server.address().port);",
        '});',
      ].join('\n'),
    );
    const launcher = path.join(top, 'bin', 'fake-server');
    await writeFile(launcher, '#!/bin/sh\nexec node "$(dirname "$0")/../server.js"\n');
    await chmod(launcher, 0o755);
    archive = path.join(root, 'server.tar.gz');
    execFileSync('tar', ['-czf', archive, '-C', path.join(root, 'src'), 'fake-server-linux-x64']);
  }, 60_000);

  afterAll(async () => {
    if (containerId) {
      execFileSync('docker', ['rm', '-f', containerId], { stdio: 'ignore' });
    }
    await rm(root, { recursive: true, force: true });
  });

  it('starts the container, runs lifecycle commands and reports user and workspace', async () => {
    await engine.checkAvailable();
    const up = await cli.up({ workspaceFolder: workspace });
    containerId = up.containerId;

    expect(up.remoteUser).toBe('node');
    expect(up.remoteWorkspaceFolder).toBe('/workspaces/app');
    const marker = await engine.exec({
      containerId: up.containerId,
      user: up.remoteUser,
      command: ['cat', '/tmp/dck-marker'],
    });
    expect(marker.stdout.trim()).toBe('created');
  }, 600_000);

  it('is idempotent: a second up reuses the running container', async () => {
    const again = await cli.up({ workspaceFolder: workspace });
    expect(again.containerId).toBe(containerId);
  }, 300_000);

  it('installs the server in the container and relays bytes through the bridge', async () => {
    if (!containerId) throw new Error('container was not started');
    execFileSync('docker', ['cp', archive, `${containerId}:/tmp/server.tar.gz`]);

    const server = await provisionServer(
      engine,
      {
        containerId,
        user: 'node',
        urlTemplate: 'file:///tmp/server.tar.gz',
        build: {
          commit: 'e2ecommit',
          quality: 'stable',
          version: '0.0.0',
          serverApplicationName: 'fake-server',
          serverDataFolderName: '.e2e-server',
        },
      },
      logger,
    );
    expect(server.port).toBeGreaterThan(0);
    expect(server.serverDir).toBe('/home/node/.e2e-server/bin/e2ecommit');

    // Same call again: must reuse the running server (same port and token).
    const second = await provisionServer(
      engine,
      {
        containerId,
        user: 'node',
        urlTemplate: 'file:///tmp/server.tar.gz',
        build: {
          commit: 'e2ecommit',
          quality: 'stable',
          version: '0.0.0',
          serverApplicationName: 'fake-server',
          serverDataFolderName: '.e2e-server',
        },
      },
      logger,
    );
    expect(second).toEqual(server);

    const bridge = spawn(
      engine.path,
      execArgs({
        containerId,
        user: 'node',
        interactive: true,
        command: [server.node, '-e', BRIDGE_SCRIPT, String(server.port)],
      }),
      { stdio: ['pipe', 'pipe', 'inherit'] },
    );
    const chunks: Buffer[] = [];
    bridge.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    const closed = new Promise<number | null>((resolve) => bridge.on('close', resolve));
    const payload = Buffer.from([0, 1, 2, 255, 10, 13, 65, 66]);
    bridge.stdin.write(payload);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    bridge.stdin.end();

    expect(await closed).toBe(0);
    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
  }, 300_000);
});
