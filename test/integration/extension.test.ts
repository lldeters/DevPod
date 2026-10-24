// Exercises the editor-facing layers (activation, commands, resolver) against a stand-in for the
// `vscode` module (see test/helpers/vscodeMock.ts). Commands run the real, pinned Dev Container
// CLI with a docker stub, so the path computed for "Reopen in Container" is the CLI's own answer.
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { decodeAuthority, encodeAuthority } from '../../src/core/authority';
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
  it('registers the resolver and every command', () => {
    activateExtension();
    expect(state.resolvers.has('dev-container')).toBe(true);
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
