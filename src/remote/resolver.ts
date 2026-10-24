// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import { decodeAuthority } from '../core/authority';
import {
  extractCustomizations,
  extractForwardPorts,
  extractRemoteEnv,
  portsAttributesSettings,
} from '../core/config/customizations';
import { resolveAndValidateConfig } from '../core/config/validate';
import type { DevContainerCli } from '../core/cli/devcontainerCli';
import type { CliLogEvent } from '../core/cli/output';
import type { ContainerEngine } from '../core/engine/containerEngine';
import { errorMessage } from '../core/errors';
import type { Logger } from '../core/logger';
import type { ServerBuildInfo } from '../core/server/productInfo';
import { provisionServer } from '../core/server/provisioner';
import { DockerTarget } from '../core/exec/target';
import { createBridge } from './bridge';
import { confirmTarget } from './knownTargets';
import type { KnownTargets } from './knownTargets';
import type { RebuildRequests } from './rebuildRequests';
import { TunnelHub } from './tunnelHub';

export interface ResolverDependencies {
  logger: Logger;
  cli: DevContainerCli;
  engine: ContainerEngine;
  rebuilds: RebuildRequests;
  /** Authorities opened by this extension; any other one is confirmed before it is used. */
  targets: Pick<KnownTargets, 'has' | 'add'>;
  serverBuild: () => Promise<ServerBuildInfo>;
  serverUrlTemplate: () => string | undefined;
  /** This machine's Kiro sign-in to place in the container, or `undefined` if it is not shared. */
  kiroLogin: () => Promise<string | undefined>;
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
export class DevContainerResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {
  private readonly hub: TunnelHub;

  constructor(private readonly deps: ResolverDependencies) {
    this.hub = new TunnelHub(deps.logger);
  }

  async resolve(authority: string): Promise<vscode.ResolverResult> {
    try {
      return await this.start(authority);
    } catch (error) {
      this.deps.logger.log('error', `Could not open the dev container: ${errorMessage(error)}`);
      throw vscode.RemoteAuthorityResolverError.NotAvailable(errorMessage(error), false);
    }
  }

  /**
   * Called by the IDE for every port it forwards, manually or automatically. The IDE stores this
   * function and calls it detached from the resolver, so it must not rely on its own `this`.
   */
  readonly tunnelFactory = (options: vscode.TunnelOptions): Promise<vscode.Tunnel> =>
    this.hub.factory(options);

  dispose(): void {
    this.hub.dispose();
  }

  private async start(authority: string): Promise<vscode.ResolverResult> {
    const { logger, cli, engine, rebuilds } = this.deps;
    const params = decodeAuthority(authority);
    logger.log(
      'info',
      `Opening ${params.hostPath}${params.configFile ? ` (${params.configFile})` : ''}`,
    );
    // Before anything reads the folder: its configuration runs commands, some on this machine.
    await confirmTarget(
      this.deps.targets,
      authority,
      `Open the folder ${params.hostPath} in a dev container?`,
      `Folder: ${params.hostPath}\nConfiguration: ${params.configFile ?? 'the default one'}\n\n` +
        'This builds and starts the container its configuration describes and runs its commands, ' +
        'including initializeCommand on this computer.',
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
            includeMergedConfiguration: true,
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

        // What the IDE (rather than the container tooling) should apply: extensions, settings
        // and ports. The merged configuration already includes what Features contribute.
        const config = up.mergedConfiguration ?? {};
        const customizations = extractCustomizations(config);
        if (customizations.rejectedExtensions.length > 0) {
          logger.log(
            'warn',
            `Ignoring extension entries that are not plain ids: ${customizations.rejectedExtensions.join(', ')}`,
          );
        }
        if (customizations.extensions.length > 0) {
          logger.log(
            'info',
            `Extensions for the container: ${customizations.extensions.join(', ')}`,
          );
        }

        progress.report({ message: 'Setting up the IDE server in the container…' });
        const server = await provisionServer(
          engine,
          {
            containerId: up.containerId,
            user: up.remoteUser,
            build,
            urlTemplate: this.deps.serverUrlTemplate(),
            extensions: customizations.extensions,
            settings: { ...portsAttributesSettings(config), ...customizations.settings },
            kiroLogin: await this.deps.kiroLogin(),
          },
          logger,
          abort.signal,
        );

        const exec = new DockerTarget(engine.path, up.containerId, up.remoteUser);
        this.hub.connect({ exec, nodePath: server.node });

        const { ports, rejected } = extractForwardPorts(config);
        if (rejected.length > 0) {
          logger.log(
            'warn',
            `Ignoring forwardPorts entries that cannot be used: ${rejected.join(', ')}`,
          );
        }
        const environmentTunnels = await this.hub.forwardConfigured(ports);

        // remoteEnv applies to every connection (extension host and terminals), so a changed
        // value takes effect on the next window reload without restarting the server.
        const remoteEnv = extractRemoteEnv(config);
        if (remoteEnv.rejected.length > 0) {
          logger.log(
            'warn',
            `Ignoring remoteEnv entries that are not strings or null: ${remoteEnv.rejected.join(', ')}`,
          );
        }
        const names = Object.keys(remoteEnv.env);
        if (names.length > 0) {
          logger.log('info', `remoteEnv for the container: ${names.join(', ')}`); // values may be secret
        }

        const resolved = new vscode.ManagedResolvedAuthority(
          () => Promise.resolve(createBridge(exec, server, logger)),
          server.token,
        );
        return Object.assign(resolved, {
          extensionHostEnv: remoteEnv.env,
          environmentTunnels,
          tunnelFeatures: { elevation: false, privacyOptions: [] },
        });
      },
    );
  }
}
