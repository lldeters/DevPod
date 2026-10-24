// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import { decodeAuthority, encodeAuthority } from '../core/authority';
import type { DevContainerCli } from '../core/cli/devcontainerCli';
import type { ContainerEngine } from '../core/engine/containerEngine';
import { discoverConfigs } from '../core/config/discovery';
import { resolveAndValidateConfig } from '../core/config/validate';
import type { DiscoveredConfig } from '../core/config/discovery';
import { errorMessage } from '../core/errors';
import type { RebuildRequests } from '../remote/rebuildRequests';
import { showDiagnostics } from './diagnostics';
import type { OutputLogger } from './logging';
import { currentAuthority, localWorkspaceFolder } from './remoteState';
import type { RemoteSupport } from './remoteState';
import { setupRemoteSupport } from './setup';

export const Commands = {
  reopenInContainer: 'devcontainersKiro.reopenInContainer',
  rebuildAndReopenInContainer: 'devcontainersKiro.rebuildAndReopenInContainer',
  rebuildContainer: 'devcontainersKiro.rebuildContainer',
  rebuildContainerNoCache: 'devcontainersKiro.rebuildContainerNoCache',
  reopenLocally: 'devcontainersKiro.reopenLocally',
  openConfigFile: 'devcontainersKiro.openConfigFile',
  showLog: 'devcontainersKiro.showLog',
  showContainerMenu: 'devcontainersKiro.showContainerMenu',
  setupRemoteSupport: 'devcontainersKiro.setupRemoteSupport',
  showDiagnostics: 'devcontainersKiro.showDiagnostics',
} as const;

export interface CommandServices {
  extensionId: string;
  extensionVersion: string;
  engine: ContainerEngine;
  logger: OutputLogger;
  cli: DevContainerCli;
  rebuilds: RebuildRequests;
  remoteSupport: RemoteSupport;
}

async function pickConfig(
  configs: readonly DiscoveredConfig[],
): Promise<DiscoveredConfig | undefined> {
  if (configs.length === 1) {
    return configs[0];
  }
  const items = configs.map((config): vscode.QuickPickItem & { config: DiscoveredConfig } => ({
    label: config.name ?? config.relativePath,
    ...(config.name ? { description: config.relativePath } : {}),
    config,
  }));
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Select a dev container configuration',
    placeHolder: 'Configuration',
  });
  return picked?.config;
}

function remoteFolderUri(authority: string, containerPath: string): vscode.Uri {
  return vscode.Uri.from({ scheme: 'vscode-remote', authority, path: containerPath });
}

export function registerCommands(services: CommandServices): vscode.Disposable[] {
  const { logger, cli, rebuilds, remoteSupport } = services;

  const guard = (run: () => Promise<void>) => async (): Promise<void> => {
    try {
      await run();
    } catch (error) {
      logger.log('error', errorMessage(error));
      const open = 'Show Log';
      const choice = await vscode.window.showErrorMessage(errorMessage(error), open);
      if (choice === open) {
        logger.show();
      }
    }
  };

  /** Remote support depends on a proposed API; guide the user if it is not enabled yet. */
  const ensureRemoteSupport = async (): Promise<boolean> => {
    if (remoteSupport.enabled) {
      return true;
    }
    logger.log('warn', `Remote support unavailable: ${remoteSupport.problem ?? 'unknown reason'}`);
    const enable = 'Enable Remote Support';
    const choice = await vscode.window.showErrorMessage(
      'Remote support is not enabled. The IDE must allow this extension to use its proposed ' +
        'remote APIs, which needs a one-time change to argv.json and a restart.',
      enable,
    );
    if (choice === enable) {
      await setupRemoteSupport(services.extensionId, logger);
    }
    return false;
  };

  const openInContainer = async (rebuild: boolean): Promise<void> => {
    if (!(await ensureRemoteSupport())) {
      return;
    }
    const folder = localWorkspaceFolder();
    if (!folder) {
      void vscode.window.showErrorMessage('Open a local folder first.');
      return;
    }
    const hostPath = folder.uri.fsPath;
    const configs = await discoverConfigs(hostPath);
    if (configs.length === 0) {
      void vscode.window.showInformationMessage(
        'This folder has no dev container configuration. Create .devcontainer/devcontainer.json first.',
      );
      return;
    }
    const chosen = await pickConfig(configs);
    if (!chosen) {
      return;
    }
    // The default location is left to the CLI so that containers it already created are reused.
    const configFile = chosen.kind === 'default' ? undefined : chosen.path;
    await resolveAndValidateConfig(hostPath, chosen.path);

    const read = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Reading dev container configuration',
      },
      () => cli.readConfiguration({ workspaceFolder: hostPath, configFile }),
    );

    const authority = encodeAuthority({ hostPath, ...(configFile ? { configFile } : {}) });
    if (rebuild) {
      await rebuilds.request(authority, { noCache: false });
    }
    logger.log('info', `Reopening ${hostPath} in container at ${read.workspace.workspaceFolder}`);
    await vscode.commands.executeCommand(
      'vscode.openFolder',
      remoteFolderUri(authority, read.workspace.workspaceFolder),
      { forceReuseWindow: true },
    );
  };

  const rebuildHere = async (noCache: boolean): Promise<void> => {
    const authority = currentAuthority();
    if (!authority) {
      void vscode.window.showInformationMessage('This window is not a dev container.');
      return;
    }
    await rebuilds.request(authority, { noCache });
    await vscode.commands.executeCommand('workbench.action.reloadWindow');
  };

  const reopenLocally = async (): Promise<void> => {
    const authority = currentAuthority();
    if (!authority) {
      void vscode.window.showInformationMessage('This window is not a dev container.');
      return;
    }
    const { hostPath } = decodeAuthority(authority);
    await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(hostPath), {
      forceReuseWindow: true,
    });
  };

  const openConfigFile = async (): Promise<void> => {
    const authority = currentAuthority();
    const hostPath = authority
      ? decodeAuthority(authority).hostPath
      : localWorkspaceFolder()?.uri.fsPath;
    if (!hostPath) {
      void vscode.window.showErrorMessage('Open a folder first.');
      return;
    }
    const explicit = authority ? decodeAuthority(authority).configFile : undefined;
    let file = explicit;
    if (!file) {
      const chosen = await pickConfig(await discoverConfigs(hostPath));
      file = chosen?.path;
    }
    if (file) {
      await vscode.window.showTextDocument(vscode.Uri.file(file));
    } else {
      void vscode.window.showInformationMessage('No dev container configuration found.');
    }
  };

  const showContainerMenu = async (): Promise<void> => {
    const items: (vscode.QuickPickItem & { command: string })[] = [
      { label: '$(debug-disconnect) Reopen Folder Locally', command: Commands.reopenLocally },
      { label: '$(tools) Rebuild Container', command: Commands.rebuildContainer },
      {
        label: '$(trash) Rebuild Container Without Cache',
        command: Commands.rebuildContainerNoCache,
      },
      {
        label: '$(settings-gear) Open Container Configuration File',
        command: Commands.openConfigFile,
      },
      { label: '$(output) Show Log', command: Commands.showLog },
    ];
    const picked = await vscode.window.showQuickPick(items, { title: 'Dev Container' });
    if (picked) {
      await vscode.commands.executeCommand(picked.command);
    }
  };

  const register = (id: string, run: () => Promise<void> | void): vscode.Disposable =>
    vscode.commands.registerCommand(
      id,
      guard(async () => run()),
    );

  return [
    register(Commands.reopenInContainer, () => openInContainer(false)),
    register(Commands.rebuildAndReopenInContainer, () => openInContainer(true)),
    register(Commands.rebuildContainer, () => rebuildHere(false)),
    register(Commands.rebuildContainerNoCache, () => rebuildHere(true)),
    register(Commands.reopenLocally, reopenLocally),
    register(Commands.openConfigFile, openConfigFile),
    register(Commands.showLog, () => logger.show()),
    register(Commands.showContainerMenu, showContainerMenu),
    register(Commands.setupRemoteSupport, () => setupRemoteSupport(services.extensionId, logger)),
    register(Commands.showDiagnostics, () =>
      showDiagnostics({
        extensionId: services.extensionId,
        extensionVersion: services.extensionVersion,
        engine: services.engine,
        cli,
        remoteSupport,
      }),
    ),
  ];
}
