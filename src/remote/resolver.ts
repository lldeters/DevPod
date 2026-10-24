// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import { decodeAuthority } from '../core/authority';
import {
  extractCustomizations,
  extractForwardPorts,
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
import { openTunnel } from '../core/tunnel';
import type { OpenTunnel } from '../core/tunnel';
import { createBridge, spawnBridge } from './bridge';
import type { ContainerTarget } from './bridge';
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
export class DevContainerResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {
  /** The container this window is connected to; used by `tunnelFactory`. */
  private target: ContainerTarget | undefined;
  /** Tunnels opened by the IDE (ports view, auto-forwarding). */
  private readonly tunnels = new Set<OpenTunnel>();
  /** Tunnels for `forwardPorts`, replaced on every resolution. */
  private forwards: OpenTunnel[] = [];

  constructor(private readonly deps: ResolverDependencies) {}

  async resolve(authority: string): Promise<vscode.ResolverResult> {
    try {
      return await this.start(authority);
    } catch (error) {
      this.deps.logger.log('error', `Could not open the dev container: ${errorMessage(error)}`);
      throw vscode.RemoteAuthorityResolverError.NotAvailable(errorMessage(error), false);
    }
  }

  /** Called by the IDE for every port it forwards, manually or automatically. */
  async tunnelFactory(options: vscode.TunnelOptions): Promise<vscode.Tunnel> {
    const target = this.target;
    if (!target) {
      throw new Error('The dev container is not connected yet.');
    }
    const tunnel = await this.open(target, options.remoteAddress, options.localAddressPort);
    this.tunnels.add(tunnel);

    const disposed = new vscode.EventEmitter<void>();
    return {
      remoteAddress: options.remoteAddress,
      localAddress: { host: tunnel.local.host, port: tunnel.local.port },
      onDidDispose: disposed.event,
      dispose: async () => {
        this.tunnels.delete(tunnel);
        await tunnel.close();
        disposed.fire();
        disposed.dispose();
      },
    };
  }

  dispose(): void {
    const all = [...this.tunnels, ...this.forwards];
    this.tunnels.clear();
    this.forwards = [];
    for (const tunnel of all) {
      void tunnel.close();
    }
  }

  private open(
    target: ContainerTarget,
    remote: { host: string; port: number },
    localPort: number | undefined,
  ): Promise<OpenTunnel> {
    return openTunnel(
      (host, port) => spawnBridge(target, port, host),
      remote,
      localPort,
      this.deps.logger,
    );
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
          },
          logger,
          abort.signal,
        );

        const target: ContainerTarget = {
          enginePath: engine.path,
          containerId: up.containerId,
          user: up.remoteUser,
          nodePath: server.node,
        };
        this.target = target;

        const environmentTunnels = await this.forwardConfiguredPorts(target, config);

        const connection = {
          enginePath: engine.path,
          containerId: up.containerId,
          user: up.remoteUser,
          server,
        };
        const resolved = new vscode.ManagedResolvedAuthority(
          () => Promise.resolve(createBridge(connection, logger)),
          server.token,
        );
        return Object.assign(resolved, {
          environmentTunnels,
          tunnelFeatures: { elevation: false, privacyOptions: [] },
        });
      },
    );
  }

  /** Opens tunnels for `forwardPorts`; they are reported as already forwarded. */
  private async forwardConfiguredPorts(
    target: ContainerTarget,
    config: Record<string, unknown>,
  ): Promise<vscode.TunnelDescription[]> {
    const { logger } = this.deps;
    for (const old of this.forwards) {
      await old.close();
    }
    this.forwards = [];

    const { ports, rejected } = extractForwardPorts(config);
    if (rejected.length > 0) {
      logger.log(
        'warn',
        `Ignoring forwardPorts entries that cannot be used: ${rejected.join(', ')}`,
      );
    }

    const described: vscode.TunnelDescription[] = [];
    for (const port of ports) {
      try {
        const tunnel = await this.open(target, port, port.port);
        this.forwards.push(tunnel);
        described.push({
          remoteAddress: { host: port.host, port: port.port },
          localAddress: { host: tunnel.local.host, port: tunnel.local.port },
        });
        logger.log(
          'info',
          `Forwarding ${port.host}:${port.port} in the container to localhost:${tunnel.local.port}`,
        );
      } catch (error) {
        logger.log('warn', `Could not forward port ${port.port}: ${errorMessage(error)}`);
      }
    }
    return described;
  }
}
