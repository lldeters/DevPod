// End-to-end test with a real container engine. It runs only when DCK_E2E=1 (CI sets it) because
// it pulls an image and needs a running Docker daemon.
//
// It covers what cannot be unit-tested: `devcontainer up` through our wrapper, lifecycle hooks,
// server provisioning inside a real container, and the stdio bridge to a server in it.
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevContainerCli, resolveCliLocation } from '../../src/core/cli/devcontainerCli';
import type { UpSuccess } from '../../src/core/cli/output';
import {
  extractCustomizations,
  extractForwardPorts,
  portsAttributesSettings,
} from '../../src/core/config/customizations';
import { ContainerEngine, execArgs } from '../../src/core/engine/containerEngine';
import { MemoryLogger } from '../../src/core/logger';
import { provisionServer } from '../../src/core/server/provisioner';
import { BRIDGE_SCRIPT } from '../../src/core/server/script';
import { openTunnel } from '../../src/core/tunnel';

const enabled = process.env['DCK_E2E'] === '1';
const cliEntry = require.resolve('@devcontainers/cli/devcontainer.js');

describe.skipIf(!enabled)('dev container end to end', () => {
  let root: string;
  let workspace: string;
  let archive: string;
  let containerId: string | undefined;
  let upResult: UpSuccess | undefined;
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
        forwardPorts: [3000, 'db:5432'],
        portsAttributes: { '3000': { label: 'App', onAutoForward: 'notify' } },
        customizations: {
          vscode: {
            extensions: ['esbenp.prettier-vscode'],
            settings: { 'editor.tabSize': 3 },
          },
        },
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
    await writeFile(
      launcher,
      '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$(dirname "$0")/../args.txt"\nexec node "$(dirname "$0")/../server.js"\n',
    );
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
    const up = await cli.up({ workspaceFolder: workspace, includeMergedConfiguration: true });
    containerId = up.containerId;
    upResult = up;

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
  it("exposes extensions, settings and ports in the real CLI's merged configuration", () => {
    const config = upResult?.mergedConfiguration;
    if (!config) throw new Error('the CLI did not return a merged configuration');

    // The merged configuration also contains what the image itself declares in its metadata
    // (this Node image adds an ESLint extension and a Copilot setting), so only what this
    // configuration asks for is asserted.
    const custom = extractCustomizations(config);
    expect(custom.extensions).toContain('esbenp.prettier-vscode');
    expect(custom.settings).toMatchObject({ 'editor.tabSize': 3 });
    expect(extractForwardPorts(config).ports).toEqual([
      { host: 'localhost', port: 3000 },
      { host: 'db', port: 5432 },
    ]);
    expect(portsAttributesSettings(config)).toEqual({
      'remote.portsAttributes': { '3000': { label: 'App', onAutoForward: 'notify' } },
    });
  });

  it('starts a fresh server with the extensions, writes the settings and tunnels a port', async () => {
    if (!containerId || !upResult?.mergedConfiguration)
      throw new Error('container was not started');
    const config = upResult.mergedConfiguration;
    const custom = extractCustomizations(config);

    const server = await provisionServer(
      engine,
      {
        containerId,
        user: 'node',
        urlTemplate: 'file:///tmp/server.tar.gz',
        extensions: custom.extensions,
        settings: { ...portsAttributesSettings(config), ...custom.settings },
        build: {
          commit: 'e2ecommit2',
          quality: 'stable',
          version: '0.0.0',
          serverApplicationName: 'fake-server',
          serverDataFolderName: '.e2e-server',
        },
      },
      logger,
    );

    // the server received the extension as a start argument
    const args = await engine.exec({
      containerId,
      user: 'node',
      command: ['cat', `${server.serverDir}/args.txt`],
    });
    expect(args.stdout.split('\n')).toEqual(
      expect.arrayContaining(['--install-extension', 'esbenp.prettier-vscode', '--start-server']),
    );
    expect(args.stdout).not.toContain(server.token); // the token is passed as a file, not as text

    // the settings landed in the machine settings of the server data folder
    const settings = await engine.exec({
      containerId,
      user: 'node',
      command: ['cat', '/home/node/.e2e-server/data/Machine/settings.json'],
    });
    expect(JSON.parse(settings.stdout)).toMatchObject({
      'remote.portsAttributes': { '3000': { label: 'App', onAutoForward: 'notify' } },
      'editor.tabSize': 3,
    });

    // a port of the container can be reached from this machine through a tunnel
    const tunnel = await openTunnel(
      (host, port) =>
        spawn(
          engine.path,
          execArgs({
            containerId: containerId as string,
            user: 'node',
            interactive: true,
            command: [server.node, '-e', BRIDGE_SCRIPT, String(port), host],
          }),
          { stdio: ['pipe', 'pipe', 'pipe'] },
        ),
      { host: '127.0.0.1', port: server.port },
      undefined,
      logger,
    );
    try {
      const echoed = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(tunnel.local.port, '127.0.0.1');
        let received = '';
        socket.on('data', (chunk) => {
          received += chunk.toString();
          if (received.length >= 'hello tunnel'.length) socket.end();
        });
        socket.on('close', () => resolve(received));
        socket.on('error', reject);
        socket.on('connect', () => socket.write('hello tunnel'));
      });
      expect(echoed).toBe('hello tunnel');
    } finally {
      await tunnel.close();
    }
  }, 300_000);
});
