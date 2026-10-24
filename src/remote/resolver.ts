// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import { decodeAuthority } from '../core/authority';
import { resolveAndValidateConfig } from '../core/config/validate';
import type { DevContainerCli } from '../core/cli/devcontainerCli';
import type { CliLogEvent } from '../core/cli/output';
import type { ContainerEngine } from '../core/engine/containerEngine';
import { errorMessage } from '../core/errors';
import type { Logger } from '../core/logger';
import type { ServerBuildInfo } from '../core/server/productInfo';
import { provisionServer } from '../core/server/provisioner';
import { createBridge } from './bridge';
import type { RebuildRequests } from './rebuildRequests';

export interface ResolverDependencies {
  logger: Logger;
  cli: DevContainerCli;
  engine: ContainerEngine;
  rebuilds: RebuildRequests;
  serverBuild: () => Promise<ServerBuildInfo>;
  serverUrlTemplate: () => string | undefined;
}

function progressText(event: CliLogEvent): string | undefined {
  if (event.kind === 'start' || event.kind === 'stop') {
    return undefined; // "Run: docker ..." lines are logged but too noisy for a notification
  }
  const text = event.text.trim();
  if (text === '') {
    return undefined;
  }
  return text.length > 90 ? `${text.slice(0, 87)}…` : text;
}

/**
 * Resolves `dev-container+…` authorities: starts the container through the Dev Container CLI,
 * makes sure a matching IDE server runs inside it, and hands the IDE a connection factory.
 *
 * Resolution is idempotent. After a window reload the same container and server are reused.
 */
export class DevContainerResolver implements vscode.RemoteAuthorityResolver {
  constructor(private readonly deps: ResolverDependencies) {}

  async resolve(authority: string): Promise<vscode.ResolverResult> {
    try {
      return await this.start(authority);
    } catch (error) {
      this.deps.logger.log('error', `Could not open the dev container: ${errorMessage(error)}`);
      throw vscode.RemoteAuthorityResolverError.NotAvailable(errorMessage(error), false);
    }
  }

  private async start(authority: string): Promise<vscode.ResolverResult> {
    const { logger, cli, engine, rebuilds } = this.deps;
    const params = decodeAuthority(authority);
    logger.log(
      'info',
      `Opening ${params.hostPath}${params.configFile ? ` (${params.configFile})` : ''}`,
    );

    await resolveAndValidateConfig(params.hostPath, params.configFile);
    await engine.checkAvailable();
    const build = await this.deps.serverBuild();
    const rebuild = await rebuilds.take(authority);

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: rebuild ? 'Rebuilding Dev Container' : 'Starting Dev Container',
        cancellable: true,
      },
      async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());

        progress.report({ message: 'Preparing the container…' });
        const up = await cli.up(
          {
            workspaceFolder: params.hostPath,
            configFile: params.configFile,
            removeExistingContainer: rebuild !== undefined,
            buildNoCache: rebuild?.noCache,
          },
          {
            signal: abort.signal,
            onLog: (event) => {
              const message = progressText(event);
              if (message) {
                progress.report({ message });
              }
            },
          },
        );
        logger.log(
          'info',
          `Container ${up.containerId.slice(0, 12)} is running as ${up.remoteUser}`,
        );

        progress.report({ message: 'Setting up the IDE server in the container…' });
        const server = await provisionServer(
          engine,
          {
            containerId: up.containerId,
            user: up.remoteUser,
            build,
            urlTemplate: this.deps.serverUrlTemplate(),
          },
          logger,
          abort.signal,
        );

        const target = {
          enginePath: engine.path,
          containerId: up.containerId,
          user: up.remoteUser,
          server,
        };
        return new vscode.ManagedResolvedAuthority(
          () => Promise.resolve(createBridge(target, logger)),
          server.token,
        );
      },
    );
  }
}
