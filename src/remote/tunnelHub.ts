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
 * At most this many ports are forwarded at once per window: far more than projects use, and a bound
 * on the listeners and processes a container that keeps announcing new ports can make this machine
 * open.
 */
export const MAX_TUNNELS = 200;

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
  /** Tunnels being opened: they count toward the limit before they exist. */
  private opening = 0;

  constructor(
    private readonly logger: Logger,
    private readonly limit = MAX_TUNNELS,
  ) {}

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
    const { host, port } = options.remoteAddress;
    const remote = `${host}:${port}`;
    // Like the IDE's own tunnels: without a requested local port, use the remote one. Sign-in flows
    // hand the browser a fixed `http://localhost:<port>` callback address and only work this way.
    const wanted = options.localAddressPort ?? port;
    const target = this.target;
    if (!target) {
      this.logger.log(
        'warn',
        `The IDE asked to forward ${remote}, but the window is not connected.`,
      );
      throw new Error('The remote window is not connected yet.');
    }
    if (this.count() >= this.limit) {
      this.logger.log(
        'warn',
        `Not forwarding ${remote}: ${this.limit} ports are forwarded already.`,
      );
      throw new Error(`At most ${this.limit} ports can be forwarded at once.`);
    }
    this.logger.log('info', `The IDE asked to forward ${remote}; trying local port ${wanted}.`);

    let tunnel: OpenTunnel;
    this.opening++;
    try {
      tunnel = await this.open(target, options.remoteAddress, wanted);
      this.tunnels.add(tunnel);
    } catch (error) {
      this.logger.log('warn', `Could not forward ${remote}: ${errorMessage(error)}`);
      throw error;
    } finally {
      this.opening--;
    }
    this.logger.log('info', `Forwarding ${remote} to localhost:${tunnel.local.port}`);
    if (tunnel.local.port !== wanted) {
      this.logger.log(
        'warn',
        `Local port ${wanted} is not available, so ${remote} is reachable at localhost:${tunnel.local.port} only. ` +
          `Anything that expects localhost:${wanted} on this machine will be refused.`,
      );
    }

    const disposed = new vscode.EventEmitter<void>();
    return {
      remoteAddress: options.remoteAddress,
      localAddress: { host: tunnel.local.host, port: tunnel.local.port },
      onDidDispose: disposed.event,
      dispose: async () => {
        this.tunnels.delete(tunnel);
        await tunnel.close();
        this.logger.log('info', `Stopped forwarding ${remote}.`);
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
    let skipped = 0;
    for (const port of ports) {
      // Checked for every port: the IDE may ask for tunnels while these are being opened.
      if (this.count() >= this.limit) {
        skipped++;
        continue;
      }
      this.opening++;
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
      } finally {
        this.opening--;
      }
    }
    if (skipped > 0) {
      this.logger.log(
        'warn',
        `Forwarding ${ports.length - skipped} of ${ports.length} configured ports: at most ${this.limit} ports are forwarded at once.`,
      );
    }
    return described;
  }

  private count(): number {
    return this.tunnels.size + this.forwards.length + this.opening;
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
