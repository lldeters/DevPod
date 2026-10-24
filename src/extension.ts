// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import { AUTHORITY_PREFIX } from './core/authority';
import { DevContainerCli, resolveCliLocation } from './core/cli/devcontainerCli';
import { ContainerEngine } from './core/engine/containerEngine';
import { errorMessage } from './core/errors';
import { readServerBuildInfo } from './remote/product';
import { RebuildRequests } from './remote/rebuildRequests';
import { DevContainerResolver } from './remote/resolver';
import { registerCommands } from './ui/commands';
import { OutputLogger } from './ui/logging';
import { promptToReopen } from './ui/prompt';
import { RemoteSupport } from './ui/remoteState';
import { readSettings } from './ui/settings';
import { registerStatusBar } from './ui/statusBar';

export function activate(context: vscode.ExtensionContext): void {
  const output = new OutputLogger();
  context.subscriptions.push(output);
  const logger = output.filtered(() => readSettings().logLevel);

  const engine = new ContainerEngine(() => readSettings().dockerPath);
  const cli = new DevContainerCli(
    () =>
      resolveCliLocation({
        customPath: readSettings().devcontainerCliPath,
        bundledEntry: require.resolve('@devcontainers/cli/devcontainer.js'),
        nodeExecutable: process.execPath,
      }),
    logger,
    () => {
      const settings = readSettings();
      return {
        dockerPath: settings.dockerPath,
        dockerComposePath: settings.dockerComposePath,
        logLevel: settings.logLevel,
      };
    },
  );
  const rebuilds = new RebuildRequests(context.globalState);
  const remoteSupport = new RemoteSupport();

  // The resolver API is a proposed API: registering fails unless the IDE was told to allow it.
  try {
    context.subscriptions.push(
      vscode.workspace.registerRemoteAuthorityResolver(
        AUTHORITY_PREFIX,
        new DevContainerResolver({
          logger,
          cli,
          engine,
          rebuilds,
          serverBuild: readServerBuildInfo,
          serverUrlTemplate: () => readSettings().serverDownloadUrlTemplate,
        }),
      ),
    );
    remoteSupport.enabled = true;
  } catch (error) {
    remoteSupport.problem = errorMessage(error);
    logger.log('warn', `Remote support is not enabled: ${remoteSupport.problem}`);
  }

  context.subscriptions.push(
    ...registerCommands({
      extensionId: context.extension.id,
      logger: output,
      cli,
      rebuilds,
      remoteSupport,
    }),
    registerStatusBar(),
  );

  void promptToReopen(context).catch((error: unknown) => {
    logger.log('debug', `Reopen prompt failed: ${errorMessage(error)}`);
  });
}

export function deactivate(): void {
  // Disposables registered on the context are cleaned up by the host.
}
