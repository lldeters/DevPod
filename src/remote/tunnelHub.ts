// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import type { ForwardedPort } from '../core/config/customizations';
import { errorMessage } from '../core/errors';
import type { Logger } from '../core/logger';
import { openTunnel } from '../core/tunnel';
import type { OpenTunnel } from '../core/tunnel';
import { spawnBridge } from './bridge';
import type { BridgeTarget } from './bridge';

/**
 * Port forwarding for one remote window, independent of what it is connected to. The IDE asks for
 * tunnels through `factory`; ports that are configured to be forwarded are opened up front.
 */
export class TunnelHub implements vscode.Disposable {
  private target: BridgeTarget | undefined;
  /** Tunnels opened because the IDE asked (Ports view, automatic forwarding). */
  private readonly tunnels = new Set<OpenTunnel>();
  /** Tunnels for configured ports, replaced whenever the window is resolved again. */
  private forwards: OpenTunnel[] = [];

  constructor(private readonly logger: Logger) {}

  /** Sets where tunnels are relayed to; called once the remote side is reachable. */
  connect(target: BridgeTarget): void {
    this.target = target;
  }

  private open(
    target: BridgeTarget,
    remote: { host: string; port: number },
    localPort: number | undefined,
  ): Promise<OpenTunnel> {
    return openTunnel(
      (host, port) => spawnBridge(target, port, host),
      remote,
      localPort,
      this.logger,
    );
  }

  /** The `tunnelFactory` of the resolver. */
  async factory(options: vscode.TunnelOptions): Promise<vscode.Tunnel> {
    const target = this.target;
    if (!target) {
      throw new Error('The remote window is not connected yet.');
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

  /** Opens tunnels for configured ports; the result is reported to the IDE as already forwarded. */
  async forwardConfigured(ports: readonly ForwardedPort[]): Promise<vscode.TunnelDescription[]> {
    const target = this.target;
    for (const old of this.forwards) {
      await old.close();
    }
    this.forwards = [];
    if (!target) {
      return [];
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
        this.logger.log(
          'info',
          `Forwarding ${port.host}:${port.port} to localhost:${tunnel.local.port}`,
        );
      } catch (error) {
        this.logger.log('warn', `Could not forward port ${port.port}: ${errorMessage(error)}`);
      }
    }
    return described;
  }

  dispose(): void {
    const all = [...this.tunnels, ...this.forwards];
    this.tunnels.clear();
    this.forwards = [];
    for (const tunnel of all) {
      void tunnel.close();
    }
  }
}
