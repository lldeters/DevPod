// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import { errorMessage, notificationText } from '../core/errors';
import { checkContainerRunning } from '../core/k8s/attach';
import {
  KubectlExecutor,
  KubectlTarget,
  noContextError,
  noCurrentContextError,
} from '../core/k8s/kubectl';
import type { Kubectl } from '../core/k8s/kubectl';
import { describeWsl } from '../core/k8s/launcher';
import type { KubectlLauncher, WslSelection } from '../core/k8s/launcher';
import { decodePodAuthority } from '../core/k8s/podRef';
import type { PodRef } from '../core/k8s/podRef';
import type { Logger } from '../core/logger';
import { provisionMcpServers } from '../core/mcp/provision';
import type { McpSetup } from '../core/mcp/provision';
import type { ServerBuildInfo } from '../core/server/productInfo';
import { provisionServer } from '../core/server/provisioner';
import type { KiroLoginShare } from '../core/server/provisioner';
import { createBridge } from './bridge';
import { withKubectlProgress } from './kubectlFeedback';
import type { KubectlFeedback } from './kubectlFeedback';
import { confirmTarget } from './knownTargets';
import type { KnownTargets } from './knownTargets';
import { TunnelHub } from './tunnelHub';

export interface PodResolverDependencies {
  logger: Logger;
  /** Read-only queries (is the pod there and running?). */
  kubectl: Kubectl;
  /**
   * How kubectl is started for the window of `authority`, directly or in its WSL distribution; read
   * for every connection.
   */
  kubectlLauncher: (wsl: WslSelection | undefined, authority: string) => KubectlLauncher;
  /** Authorities opened by this extension; any other one is confirmed before it is used. */
  targets: Pick<KnownTargets, 'has' | 'add'>;
  serverBuild: () => Promise<ServerBuildInfo>;
  serverUrlTemplate: () => string | undefined;
  /** This machine's Kiro sign-in to offer to the named target, or `undefined` if it is not shared. */
  kiroLogin: (target: string) => Promise<KiroLoginShare | undefined>;
  /** The MCP servers to set up in the named target, or `undefined` if there are none. */
  mcp?: (target: string) => Promise<McpSetup | undefined>;
  /** After how long a kubectl query is reported as still running; replaceable in tests. */
  slowQueryMs?: number;
}

/**
 * Resolves `k8s-pod+…` authorities: makes sure a matching IDE server runs inside the pod
 * container (installed through `kubectl exec`) and hands the IDE a connection factory.
 *
 * There is no devcontainer.json for a pod, so nothing is built or configured; the pod is used as
 * it is. Resolution is idempotent: an installed, running server is reused on reconnect.
 */
export class PodResolver implements vscode.RemoteAuthorityResolver, vscode.Disposable {
  private readonly hub: TunnelHub;

  constructor(private readonly deps: PodResolverDependencies) {
    this.hub = new TunnelHub(deps.logger);
  }

  async resolve(authority: string): Promise<vscode.ResolverResult> {
    try {
      return await this.start(authority);
    } catch (error) {
      this.deps.logger.log('error', `Could not attach to the pod: ${errorMessage(error)}`);
      // The IDE shows the message in a notification.
      throw vscode.RemoteAuthorityResolverError.NotAvailable(
        notificationText(errorMessage(error)),
        false,
      );
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

  private async loginInput(
    target: string,
  ): Promise<{ kiroLogin?: string; confirmKiroLogin?: () => Promise<boolean> }> {
    const share = await this.deps.kiroLogin(target);
    return share
      ? { kiroLogin: share.text, ...(share.confirm ? { confirmKiroLogin: share.confirm } : {}) }
      : {};
  }

  /**
   * MCP servers are a convenience: a problem is logged and does not stop the connection
   * (unless it was cancelled). It runs before the IDE connects, so Kiro finds it on its first start.
   */
  private async setUpMcp(
    executor: KubectlExecutor,
    containerId: string,
    node: string,
    dataFolderName: string,
    name: string,
    report: (message: string) => void,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const setup = await this.deps.mcp?.(name);
      if (!setup) {
        return;
      }
      report('Setting up MCP servers in the pod…');
      await provisionMcpServers(
        executor,
        { containerId, node, dataFolderName },
        setup,
        this.deps.logger,
        signal,
      );
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      this.deps.logger.log('warn', `Could not set up the MCP servers: ${errorMessage(error)}`);
    }
  }

  private async withCurrentContext(
    ref: PodRef,
    launcher: KubectlLauncher,
    feedback: KubectlFeedback,
  ): Promise<PodRef> {
    const { kubectl } = this.deps;
    const context = await feedback.run('config view', (options) =>
      kubectl.currentContext(ref, launcher, options),
    );
    if (context === undefined) {
      const contexts = await feedback.run('config get-contexts', (options) =>
        kubectl.contexts(ref, launcher, options),
      );
      throw contexts.length === 0 ? noContextError(ref) : noCurrentContextError(ref, 'window');
    }
    this.deps.logger.log('info', `The target names no context; using the current one, ${context}`);
    return { ...ref, context };
  }

  private async start(authority: string): Promise<vscode.ResolverResult> {
    const { logger, kubectl } = this.deps;
    const ref = decodePodAuthority(authority);
    logger.log(
      'info',
      `Attaching to ${ref.namespace}/${ref.pod} (container ${ref.container}${
        ref.context ? `, context ${ref.context}` : ''
      }${ref.wsl ? `, kubectl ${describeWsl(ref.wsl)}` : ''})`,
    );
    // Before kubectl runs: the kubeconfig decides which cluster is contacted, and it can run commands.
    await confirmTarget(
      this.deps.targets,
      authority,
      `Attach to the pod ${ref.namespace}/${ref.pod}?`,
      `Pod: ${ref.namespace}/${ref.pod}\nContainer: ${ref.container}\n` +
        `Context: ${ref.context ?? 'the current one'}\n` +
        `kubeconfig: ${ref.kubeconfig ?? "kubectl's default"}\n` +
        (ref.wsl ? `WSL distribution: ${ref.wsl.distro ?? 'the default one'}\n` : '') +
        `\nThis runs kubectl${ref.wsl ? ` ${describeWsl(ref.wsl)}` : ''} with that kubeconfig ` +
        'and installs the IDE server in the container.',
    );

    const build = await this.deps.serverBuild();
    const launcher = () => this.deps.kubectlLauncher(ref.wsl, authority);

    // Everything that runs kubectl is under this notification, which can be cancelled and shows
    // what kubectl waits for: the pod query is the first to contact the cluster, so a credential
    // plugin may ask for a sign-in there.
    return withKubectlProgress(
      `Attaching to pod ${ref.pod}`,
      logger,
      async (feedback, report) => {
        const signal = feedback.signal;
        report('Reading the pod…');
        // A target without a context (from a link) is fixed to the current one for this
        // connection; without any, kubectl would fall back to localhost:8080.
        const pinned =
          ref.context === undefined
            ? await this.withCurrentContext(ref, launcher(), feedback)
            : ref;
        const pod = await feedback.run('get pod', (options) =>
          kubectl.pod(pinned, launcher(), options),
        );
        checkContainerRunning(pod, pinned.container);

        report('Setting up the IDE server in the pod…');
        const target = new KubectlTarget(launcher(), pinned);
        const server = await provisionServer(
          new KubectlExecutor(launcher, pinned),
          {
            containerId: target.label,
            build,
            urlTemplate: this.deps.serverUrlTemplate(),
            ...(await this.loginInput(`the pod ${ref.namespace}/${ref.pod}`)),
          },
          logger,
          signal,
        );

        await this.setUpMcp(
          new KubectlExecutor(launcher, pinned),
          target.label,
          server.node,
          build.serverDataFolderName,
          `the pod ${ref.namespace}/${ref.pod}`,
          report,
          signal,
        );

        this.hub.connect({ exec: target, nodePath: server.node });
        const resolved = new vscode.ManagedResolvedAuthority(
          () => Promise.resolve(createBridge(target, server, logger)),
          server.token,
        );
        return Object.assign(resolved, {
          environmentTunnels: [],
          tunnelFeatures: { elevation: false, privacyOptions: [] },
        });
      },
      this.deps.slowQueryMs,
    );
  }
}
