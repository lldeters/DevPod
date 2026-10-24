/* eslint-disable @typescript-eslint/no-explicit-any */
// Exercises the editor-facing layers (activation, commands, resolver) against a stand-in for the
// `vscode` module (see test/helpers/vscodeMock.ts). Commands run the real, pinned Dev Container
// CLI with a docker stub, so the path computed for "Reopen in Container" is the CLI's own answer.
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as net from 'node:net';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { decodeAuthority, encodeAuthority } from '../../src/core/authority';
import { encodePodAuthority } from '../../src/core/k8s/podRef';
import type { DevContainerCli } from '../../src/core/cli/devcontainerCli';
import type { ContainerEngine } from '../../src/core/engine/containerEngine';
import { MemoryLogger } from '../../src/core/logger';
import type { RunResult } from '../../src/core/process';
import { PLATFORM_MARKER } from '../../src/core/server/platform';
import { INSTALL_MARKER } from '../../src/core/server/script';
import { activate } from '../../src/extension';
import { RebuildRequests } from '../../src/remote/rebuildRequests';
import { DevContainerResolver } from '../../src/remote/resolver';
import { Commands } from '../../src/ui/commands';
import * as mock from '../helpers/vscodeMock';

const { state } = mock;
const EXTENSION_ID = 'lldeters.devcontainers-kiro';

let root: string;
let sub: string;
let dockerStub: string;

async function writeConfig(folder: string, content: object): Promise<void> {
  await mkdir(path.dirname(folder), { recursive: true });
  await writeFile(folder, JSON.stringify(content));
}

function openWorkspace(...folders: mock.Uri[]): void {
  state.workspaceFolders = folders.map((uri, index) => ({ uri, name: `f${index}`, index }));
}

function activateExtension(): { globalState: mock.MockMemento } {
  const globalState = new mock.MockMemento();
  const context = {
    subscriptions: [] as { dispose(): unknown }[],
    globalState,
    workspaceState: new mock.MockMemento(),
    extension: { id: EXTENSION_ID },
  };
  activate(context as unknown as vscode.ExtensionContext);
  return { globalState };
}

function lastOpenFolder(): { uri: mock.Uri; options: unknown } {
  const call = state.executed.filter((entry) => entry.command === 'vscode.openFolder').at(-1);
  if (!call) throw new Error('vscode.openFolder was not called');
  return { uri: call.args[0] as mock.Uri, options: call.args[1] };
}

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'dck-ext-')));
  dockerStub = path.join(root, 'docker-stub');
  await writeFile(dockerStub, '#!/bin/sh\nexit 0\n');
  await chmod(dockerStub, 0o755);

  const repo = path.join(root, 'repo');
  sub = path.join(repo, 'sub');
  execFileSync('git', ['init', '-q', repo]);
  await writeConfig(path.join(sub, '.devcontainer', 'devcontainer.json'), {
    name: 'Main',
    image: 'ubuntu:24.04',
  });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

beforeEach(() => {
  mock.reset();
  state.settings['dev.containers.dockerPath'] = dockerStub;
});

describe('activation', () => {
  it('registers the resolvers and every command', () => {
    activateExtension();
    expect(state.resolvers.has('dev-container')).toBe(true);
    expect(state.resolvers.has('k8s-pod')).toBe(true);
    for (const id of Object.values(Commands)) {
      expect(state.registeredCommands.has(id), id).toBe(true);
    }
  });

  it('does not fail when the proposed API is not enabled, and guides the user on use', async () => {
    state.resolverApiEnabled = false;
    openWorkspace(mock.Uri.file(sub));
    expect(() => activateExtension()).not.toThrow();
    expect(state.resolvers.size).toBe(0);

    await mock.commands.executeCommand(Commands.reopenInContainer);
    expect(state.errorMessages.join('\n')).toMatch(/Remote support is not enabled/);
    expect(state.executed.some((entry) => entry.command === 'vscode.openFolder')).toBe(false);
  });

  it('shows no status bar entry in a local window', () => {
    openWorkspace(mock.Uri.file(sub));
    activateExtension();
    expect(state.statusBarItems).toEqual([]);
  });
});

describe('Reopen in Container', () => {
  it('opens the remote folder at the path the Dev Container CLI reports (Git root aware)', async () => {
    openWorkspace(mock.Uri.file(sub));
    activateExtension();

    await mock.commands.executeCommand(Commands.reopenInContainer);

    const { uri, options } = lastOpenFolder();
    expect(uri.scheme).toBe('vscode-remote');
    expect(uri.path).toBe('/workspaces/repo/sub');
    expect(decodeAuthority(uri.authority)).toEqual({ hostPath: sub }); // default location: no configFile
    expect(options).toEqual({ forceReuseWindow: true });
    expect(state.errorMessages).toEqual([]);
  });

  it('lets the user choose between several configurations and remembers the choice', async () => {
    const multi = path.join(root, 'multi');
    await writeConfig(path.join(multi, '.devcontainer', 'a', 'devcontainer.json'), {
      name: 'Alpha',
      image: 'ubuntu:24.04',
    });
    await writeConfig(path.join(multi, '.devcontainer', 'b', 'devcontainer.json'), {
      name: 'Beta',
      image: 'ubuntu:24.04',
    });
    openWorkspace(mock.Uri.file(multi));
    state.quickPickIndex = 1;
    activateExtension();

    await mock.commands.executeCommand(Commands.reopenInContainer);

    const labels = (state.quickPickCalls[0] as { label: string }[]).map((item) => item.label);
    expect(labels).toEqual(['Alpha', 'Beta']);
    const params = decodeAuthority(lastOpenFolder().uri.authority);
    expect(params.configFile).toBe(path.join(multi, '.devcontainer', 'b', 'devcontainer.json'));
  });

  it('says so when the folder has no configuration', async () => {
    const empty = path.join(root, 'empty');
    await mkdir(empty);
    openWorkspace(mock.Uri.file(empty));
    activateExtension();

    await mock.commands.executeCommand(Commands.reopenInContainer);

    expect(state.infoMessages.join('\n')).toMatch(/no dev container configuration/i);
    expect(state.executed.some((entry) => entry.command === 'vscode.openFolder')).toBe(false);
  });

  it('shows an actionable error when the configuration cannot be read', async () => {
    const broken = path.join(root, 'broken');
    await mkdir(path.join(broken, '.devcontainer'), { recursive: true });
    await writeFile(path.join(broken, '.devcontainer', 'devcontainer.json'), '{ "image": ');
    openWorkspace(mock.Uri.file(broken));
    activateExtension();

    await mock.commands.executeCommand(Commands.reopenInContainer);

    expect(state.errorMessages).toHaveLength(1);
    expect(state.errorMessages[0]).toMatch(/devcontainer\.json:1:\d+/);
    expect(state.executed.some((entry) => entry.command === 'vscode.openFolder')).toBe(false);
  });
});

describe('inside a Kubernetes pod window', () => {
  const podAuthority = encodePodAuthority({
    context: 'kind-test',
    namespace: 'dev',
    pod: 'mypod',
    container: 'app',
  });

  it('shows the pod in the status bar, also in a window without a folder', () => {
    state.remoteAuthority = podAuthority; // an attached window has no folder open yet
    activateExtension();
    expect(state.statusBarItems).toHaveLength(1);
    expect(state.statusBarItems[0]).toMatchObject({
      text: '$(remote) Pod: mypod',
      command: Commands.showPodMenu,
      visible: true,
    });
  });

  it('is not mistaken for a dev container window', () => {
    state.remoteAuthority = podAuthority;
    activateExtension();
    expect(state.statusBarItems.every((item) => !item.text.includes('Dev Container'))).toBe(true);
  });

  it('offers to close the connection from the pod menu', async () => {
    state.remoteAuthority = podAuthority;
    activateExtension();
    state.quickPickIndex = 1;
    await mock.commands.executeCommand(Commands.showPodMenu);
    expect(state.executed.at(-1)?.command).toBe('workbench.action.remote.close');
  });
});

describe('inside a dev container window', () => {
  const containerFolder = (hostPath: string): mock.Uri =>
    mock.Uri.from({
      scheme: 'vscode-remote',
      authority: encodeAuthority({ hostPath }),
      path: '/workspaces/repo/sub',
    });

  it('shows a status bar entry that opens the actions menu', () => {
    openWorkspace(containerFolder(sub));
    activateExtension();
    expect(state.statusBarItems).toHaveLength(1);
    expect(state.statusBarItems[0]).toMatchObject({
      text: '$(remote) Dev Container: sub',
      command: Commands.showContainerMenu,
      visible: true,
    });
  });

  it('records a rebuild request and reloads the window', async () => {
    openWorkspace(containerFolder(sub));
    const { globalState } = activateExtension();

    await mock.commands.executeCommand(Commands.rebuildContainerNoCache);

    const authority = encodeAuthority({ hostPath: sub });
    expect(globalState.get(`rebuild:${authority}`)).toEqual({ noCache: true });
    expect(state.executed.at(-1)?.command).toBe('workbench.action.reloadWindow');
  });

  it('reopens the folder locally', async () => {
    openWorkspace(containerFolder(sub));
    activateExtension();

    await mock.commands.executeCommand(Commands.reopenLocally);

    const { uri } = lastOpenFolder();
    expect(uri.scheme).toBe('file');
    expect(uri.fsPath).toBe(sub);
  });
});

describe('DevContainerResolver', () => {
  const build = {
    commit: 'abc123',
    quality: 'stable',
    version: '1.103.2',
    serverApplicationName: 'kiro-server',
    serverDataFolderName: '.kiro-server',
    downloadUrlTemplate: 'https://dl.example/${commit}-${os}-${arch}.tar.gz',
  };
  const ok = (stdout: string): RunResult => ({ code: 0, signal: null, stdout, stderr: '' });
  const platform = ok(
    `${PLATFORM_MARKER}: start\nkernel==Linux\nmachine==x86_64\nlibc==gnu\nhome==/home/vscode\n${PLATFORM_MARKER}: end\n`,
  );
  const installed = ok(
    `${INSTALL_MARKER}: start\nserverDir==/home/vscode/.kiro-server/bin/abc123\nport==41000\ntoken==secret-token\nnode==/n\nlog==/l\n${INSTALL_MARKER}: end\n`,
  );

  function setup(options: { engineError?: Error } = {}) {
    const upCalls: Record<string, unknown>[] = [];
    const results = [platform, installed, platform, installed];
    const cli = {
      up: async (opts: Record<string, unknown>) => {
        upCalls.push(opts);
        return {
          outcome: 'success',
          containerId: 'c0ffee1234567890',
          remoteUser: 'vscode',
          remoteWorkspaceFolder: '/workspaces/repo/sub',
        };
      },
    } as unknown as DevContainerCli;
    const engine = {
      path: 'docker',
      checkAvailable: async () => {
        if (options.engineError) throw options.engineError;
        return '27.0.0';
      },
      exec: async () => results.shift() ?? ok(''),
    } as unknown as ContainerEngine;
    const rebuilds = new RebuildRequests(new mock.MockMemento() as unknown as vscode.Memento);
    const resolver = new DevContainerResolver({
      logger: new MemoryLogger(),
      cli,
      engine,
      rebuilds,
      serverBuild: async () => build,
      serverUrlTemplate: () => undefined,
    });
    return { resolver, rebuilds, upCalls };
  }

  it('starts the container, provisions the server and hands back the token', async () => {
    const { resolver, upCalls } = setup();
    const authority = encodeAuthority({ hostPath: sub });

    const resolved = (await resolver.resolve(
      authority,
    )) as unknown as mock.ManagedResolvedAuthority;

    expect(resolved).toBeInstanceOf(mock.ManagedResolvedAuthority);
    expect(resolved.connectionToken).toBe('secret-token');
    expect(upCalls).toHaveLength(1);
    expect(upCalls[0]).toMatchObject({ workspaceFolder: sub, removeExistingContainer: false });
  });

  it('consumes a pending rebuild request exactly once', async () => {
    const { resolver, rebuilds, upCalls } = setup();
    const authority = encodeAuthority({ hostPath: sub });
    await rebuilds.request(authority, { noCache: true });

    await resolver.resolve(authority);
    await resolver.resolve(authority);

    expect(upCalls[0]).toMatchObject({ removeExistingContainer: true, buildNoCache: true });
    expect(upCalls[1]).toMatchObject({ removeExistingContainer: false });
  });

  it('reports an invalid authority as "not available" with a message', async () => {
    const { resolver } = setup();
    await expect(resolver.resolve('dev-container+nothex')).rejects.toMatchObject({
      kind: 'NotAvailable',
      message: expect.stringContaining('remote authority'),
    });
  });

  it('passes the engine problem through to the user', async () => {
    const { resolver, upCalls } = setup({ engineError: new Error('Docker is not running') });
    await expect(resolver.resolve(encodeAuthority({ hostPath: sub }))).rejects.toMatchObject({
      kind: 'NotAvailable',
      message: 'Docker is not running',
    });
    expect(upCalls).toHaveLength(0);
  });
});

describe('Show Diagnostics', () => {
  let productDir: string;
  let portableDir: string;

  beforeAll(async () => {
    productDir = path.join(root, 'app');
    portableDir = path.join(root, 'portable');
    await mkdir(productDir, { recursive: true });
    await mkdir(portableDir, { recursive: true });
    await writeFile(
      path.join(productDir, 'product.json'),
      JSON.stringify({
        nameShort: 'Kiro',
        version: '1.103.2',
        commit: 'abc123',
        quality: 'stable',
        dataFolderName: '.kiro',
        serverApplicationName: 'kiro-server',
        serverDataFolderName: '.kiro-server',
        updateUrl: 'https://update.example/api',
        updateApiKey: 'SECRET-VALUE',
        unrelated: 'nope',
      }),
    );
    await writeFile(
      path.join(portableDir, 'argv.json'),
      '{ // comment\n "enable-proposed-api": ["lldeters.devcontainers-kiro"] }',
    );
  });

  afterEach(() => {
    delete process.env['VSCODE_PORTABLE'];
  });

  it('copies a credential-free report with the facts needed for server support', async () => {
    process.env['VSCODE_PORTABLE'] = portableDir; // keeps the test away from the real argv.json
    state.appRoot = productDir;
    activateExtension();

    await mock.commands.executeCommand(Commands.showDiagnostics);

    const report = JSON.parse(state.clipboard) as Record<string, any>;
    expect(report['extension']).toMatchObject({ id: EXTENSION_ID });
    expect(report['ide']).toMatchObject({ appName: 'Kiro', vscodeVersion: '1.103.2' });
    expect(report['product'].values).toMatchObject({
      commit: 'abc123',
      serverApplicationName: 'kiro-server',
      serverDataFolderName: '.kiro-server',
      updateUrl: 'https://update.example/api',
    });
    expect(report['remoteSupport']).toEqual({ enabled: true, problem: null });
    expect(report['argvJson'].listsThisExtension).toBe(true);
    expect(report['devcontainerCli'].version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report['settings'].serverDownloadUrlTemplate).toBe('unset');
    expect(state.clipboard).not.toContain('SECRET-VALUE');
    expect(state.clipboard).not.toContain('unrelated');
    expect(state.openedDocuments).toHaveLength(1);
    expect(state.infoMessages.join('\n')).toMatch(/copied to the clipboard/);
  });

  it('still produces a report when the IDE facts cannot be read', async () => {
    process.env['VSCODE_PORTABLE'] = path.join(root, 'nowhere');
    state.appRoot = path.join(root, 'does-not-exist');
    state.settings['dev.containers.dockerPath'] = path.join(root, 'no-such-docker');
    activateExtension();

    await mock.commands.executeCommand(Commands.showDiagnostics);

    const report = JSON.parse(state.clipboard) as Record<string, any>;
    expect(report['product'].error).toMatch(/ENOENT|no such file/i);
    expect(report['containerEngine'].version.error).toMatch(/Could not run|not reachable/);
    expect(report['argvJson'].listsThisExtension).toBe(false);
    expect(state.errorMessages).toEqual([]);
  });
});

describe('DevContainerResolver: customizations and port forwarding', () => {
  const build = {
    commit: 'abc123',
    quality: 'stable',
    version: '1.103.2',
    serverApplicationName: 'kiro-server',
    serverDataFolderName: '.kiro-server',
    downloadUrlTemplate: 'https://dl.example/${commit}.tar.gz',
  };
  const ok = (stdout: string): RunResult => ({ code: 0, signal: null, stdout, stderr: '' });
  const platform = ok(
    `${PLATFORM_MARKER}: start\nkernel==Linux\nmachine==x86_64\nlibc==gnu\nhome==/home/vscode\n${PLATFORM_MARKER}: end\n`,
  );
  const installed = ok(
    `${INSTALL_MARKER}: start\nserverDir==/home/vscode/.kiro-server/bin/abc123\nport==41000\ntoken==tok\nnode==/n\nlog==/l\n${INSTALL_MARKER}: end\n`,
  );
  const cleanups: (() => Promise<void> | void)[] = [];
  let bridgeStub: string;

  beforeAll(async () => {
    // Stands in for `docker exec -i … <node> -e <bridge> <port> [host]`: runs the bridge locally.
    bridgeStub = path.join(root, 'docker-bridge-stub');
    await writeFile(
      bridgeStub,
      `#!${process.execPath}
const { spawn } = require('child_process');
const args = process.argv.slice(2);
const child = spawn(process.execPath, args.slice(args.indexOf('-e')), { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
`,
    );
    await chmod(bridgeStub, 0o755);
  });

  afterEach(async () => {
    while (cleanups.length > 0) await cleanups.pop()?.();
  });

  function startEcho(host = '127.0.0.1'): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer((socket) => socket.pipe(socket));
      cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
      server.listen(0, host, () => resolve((server.address() as net.AddressInfo).port));
    });
  }

  async function echoThrough(port: number, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1');
      let received = '';
      socket.on('data', (chunk) => {
        received += chunk.toString();
        if (received.length >= text.length) socket.end();
      });
      socket.on('close', () => resolve(received));
      socket.on('error', reject);
      socket.on('connect', () => socket.write(text));
    });
  }

  function setup(mergedConfiguration: Record<string, unknown>) {
    const scripts: string[] = [];
    let settingsFile = '';
    const logger = new MemoryLogger();
    const cli = {
      up: async () => ({
        outcome: 'success',
        containerId: 'c0ffee1234567890',
        remoteUser: 'vscode',
        remoteWorkspaceFolder: '/workspaces/app',
        mergedConfiguration,
      }),
    } as unknown as DevContainerCli;
    const engine = {
      path: bridgeStub,
      checkAvailable: async () => '27.0.0',
      exec: async (options: { stdin?: string }) => {
        const script = options.stdin ?? '';
        scripts.push(script);
        if (script.includes(`${PLATFORM_MARKER}: start`)) return platform;
        if (script.includes(`${INSTALL_MARKER}: start`)) return installed;
        if (script.startsWith('cat ')) return ok(settingsFile);
        const heredoc = /<<'(DCK_[0-9a-f]+)'\n([\s\S]*?)\n\1\n/.exec(script);
        if (heredoc) settingsFile = `${heredoc[2]}\n`;
        return ok('');
      },
    } as unknown as ContainerEngine;
    const resolver = new DevContainerResolver({
      logger,
      cli,
      engine,
      rebuilds: new RebuildRequests(new mock.MockMemento() as unknown as vscode.Memento),
      serverBuild: async () => build,
      serverUrlTemplate: () => undefined,
    });
    cleanups.push(() => resolver.dispose());
    return { resolver, scripts, logger, settings: () => JSON.parse(settingsFile || '{}') };
  }

  const authority = () => encodeAuthority({ hostPath: sub });

  it('installs the extensions and applies the settings from the merged configuration', async () => {
    const { resolver, scripts, settings, logger } = setup({
      // the CLI's merged configuration collects one entry per source (config and Features)
      customizations: {
        vscode: [
          { extensions: ['esbenp.prettier-vscode'], settings: { 'editor.tabSize': 2 } },
          { extensions: ['redhat.vscode-yaml', 'esbenp.prettier-vscode', 'bad id@1.0'] },
        ],
        kiro: [{ settings: { 'editor.tabSize': 4 } }],
      },
      portsAttributes: { '3000': { label: 'App' } },
      otherPortsAttributes: { onAutoForward: 'silent' },
    });

    await resolver.resolve(authority());

    const install = scripts.find((script) => script.includes(`${INSTALL_MARKER}: start`)) ?? '';
    expect(install).toContain("'--install-extension' 'esbenp.prettier-vscode'");
    expect(install).toContain("'--install-extension' 'redhat.vscode-yaml'");
    expect(install.match(/--install-extension/g)).toHaveLength(2); // duplicates and bad ids dropped
    expect(settings()).toEqual({
      'editor.tabSize': 4, // customizations.kiro overrides customizations.vscode
      'remote.portsAttributes': { '3000': { label: 'App' } },
      'remote.otherPortsAttributes': { onAutoForward: 'silent' },
    });
    expect(logger.entries.some((e) => e.level === 'warn' && e.message.includes('bad id@1.0'))).toBe(
      true,
    );
  });

  it('leaves the container alone when the configuration asks for nothing', async () => {
    const { resolver, scripts } = setup({});
    await resolver.resolve(authority());
    expect(scripts).toHaveLength(2); // platform + install; no settings, no extensions
    expect(scripts[1]).not.toContain('--install-extension');
  });

  it('forwards the configured ports and reports them as already forwarded', async () => {
    const remote = await startEcho();
    const { resolver } = setup({ forwardPorts: [remote, 'bad host:1', 70000] });

    const resolved = (await resolver.resolve(authority())) as unknown as {
      environmentTunnels: {
        remoteAddress: { host: string; port: number };
        localAddress: { host: string; port: number };
      }[];
      tunnelFeatures: { elevation: boolean };
    };

    expect(resolved.environmentTunnels).toHaveLength(1);
    const [tunnel] = resolved.environmentTunnels;
    expect(tunnel?.remoteAddress).toEqual({ host: 'localhost', port: remote });
    expect(tunnel?.localAddress.host).toBe('127.0.0.1');
    expect(await echoThrough(tunnel?.localAddress.port ?? 0, 'through the tunnel')).toBe(
      'through the tunnel',
    );
    expect(resolved.tunnelFeatures.elevation).toBe(false);
  });

  it('opens tunnels the IDE asks for, and closes them again on dispose', async () => {
    const remote = await startEcho();
    const { resolver, logger } = setup({});
    await resolver.resolve(authority());

    const tunnel = await resolver.tunnelFactory({
      remoteAddress: { host: 'localhost', port: remote },
    });
    const local = (tunnel.localAddress as { port: number }).port;
    expect(await echoThrough(local, 'ping')).toBe('ping');

    let disposed = false;
    tunnel.onDidDispose(() => {
      disposed = true;
    });
    await tunnel.dispose();
    expect(disposed).toBe(true);
    await expect(echoThrough(local, 'again')).rejects.toThrow();

    // Each request of the IDE leaves a trace; this is what tells a failed login callback apart.
    const info = logger.entries.filter((e) => e.level === 'info').map((e) => e.message);
    expect(info).toContain(
      `The IDE asked to forward localhost:${remote}; trying local port ${remote}.`,
    );
    expect(info).toContain(`Forwarding localhost:${remote} to localhost:${local}`);
    expect(info).toContain(`Stopped forwarding localhost:${remote}.`);
    // Here the "container" is this machine, so the remote port is taken locally and another is used.
    expect(
      logger.entries.some((e) => e.level === 'warn' && e.message.includes('is not available')),
    ).toBe(true);
  });

  // Sign-in flows give the browser a fixed `http://localhost:<port>` callback address, and the IDE
  // asks for that tunnel without naming a local port. The local port must then equal the remote one.
  // The "container" is this machine, so its service sits on 127.0.0.2 to leave the port free here.
  it.skipIf(process.platform !== 'linux')(
    'uses the remote port as the local port when the IDE names none',
    async () => {
      const remote = await startEcho('127.0.0.2');
      const { resolver } = setup({});
      await resolver.resolve(authority());

      const tunnel = await resolver.tunnelFactory({
        remoteAddress: { host: '127.0.0.2', port: remote },
      });
      expect((tunnel.localAddress as { port: number }).port).toBe(remote);
      expect(await echoThrough(remote, 'callback')).toBe('callback');
      await tunnel.dispose();
    },
  );

  it('uses the local port the IDE asks for', async () => {
    const remote = await startEcho();
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const free = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const { resolver } = setup({});
    await resolver.resolve(authority());

    const tunnel = await resolver.tunnelFactory({
      remoteAddress: { host: 'localhost', port: remote },
      localAddressPort: free,
    });
    expect((tunnel.localAddress as { port: number }).port).toBe(free);
    expect(await echoThrough(free, 'hi')).toBe('hi');
    await tunnel.dispose();
  });

  it('refuses tunnels before a container is connected', async () => {
    const { resolver } = setup({});
    await expect(
      resolver.tunnelFactory({ remoteAddress: { host: 'localhost', port: 3000 } }),
    ).rejects.toThrow(/not connected/);
  });

  it('closes forwarded ports when the resolver is disposed', async () => {
    const remote = await startEcho();
    const { resolver } = setup({ forwardPorts: [remote] });
    const resolved = (await resolver.resolve(authority())) as unknown as {
      environmentTunnels: { localAddress: { port: number } }[];
    };
    const local = resolved.environmentTunnels[0]?.localAddress.port ?? 0;
    expect(await echoThrough(local, 'x')).toBe('x');

    resolver.dispose();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(echoThrough(local, 'y')).rejects.toThrow();
  });

  it('replaces the forwarded ports when it resolves again (window reconnect)', async () => {
    const remote = await startEcho();
    const { resolver } = setup({ forwardPorts: [remote] });

    const first = (await resolver.resolve(authority())) as unknown as {
      environmentTunnels: { localAddress: { port: number } }[];
    };
    const firstPort = first.environmentTunnels[0]?.localAddress.port ?? 0;
    const second = (await resolver.resolve(authority())) as unknown as {
      environmentTunnels: { localAddress: { port: number } }[];
    };
    const secondPort = second.environmentTunnels[0]?.localAddress.port ?? 0;

    expect(secondPort).toBeGreaterThan(0);
    expect(await echoThrough(secondPort, 'ok')).toBe('ok');
    if (firstPort !== secondPort) {
      await expect(echoThrough(firstPort, 'old')).rejects.toThrow(); // no leaked listener
    }
  });
});
