// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
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
import type { ServerBuildInfo } from '../core/server/productInfo';
import { provisionServer } from '../core/server/provisioner';
import type { KiroLoginShare } from '../core/server/provisioner';
import { createBridge } from './bridge';
import { confirmTarget } from './knownTargets';
import type { KnownTargets } from './knownTargets';
import { TunnelHub } from './tunnelHub';

export interface PodResolverDependencies {
  logger: Logger;
  /** Read-only queries (is the pod there and running?). */
  kubectl: Kubectl;
  /** How kubectl is started for `exec`, directly or in the window's WSL distribution; read for every connection. */
  kubectlLauncher: (wsl: WslSelection | undefined) => KubectlLauncher;
  /** Authorities opened by this extension; any other one is confirmed before it is used. */
  targets: Pick<KnownTargets, 'has' | 'add'>;
  serverBuild: () => Promise<ServerBuildInfo>;
  serverUrlTemplate: () => string | undefined;
  /** This machine's Kiro sign-in to offer to the named target, or `undefined` if it is not shared. */
  kiroLogin: (target: string) => Promise<KiroLoginShare | undefined>;
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

  private async loginInput(
    target: string,
  ): Promise<{ kiroLogin?: string; confirmKiroLogin?: () => Promise<boolean> }> {
    const share = await this.deps.kiroLogin(target);
    return share
      ? { kiroLogin: share.text, ...(share.confirm ? { confirmKiroLogin: share.confirm } : {}) }
      : {};
  }

  private async withCurrentContext(ref: PodRef): Promise<PodRef> {
    const context = await this.deps.kubectl.currentContext(ref);
    if (context === undefined) {
      throw (await this.deps.kubectl.contexts(ref)).length === 0
        ? noContextError(ref)
        : noCurrentContextError(ref, 'window');
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
    // A target without a context (from a link) is fixed to the current one for this connection;
    // without any, kubectl would fall back to localhost:8080.
    const pinned = ref.context === undefined ? await this.withCurrentContext(ref) : ref;
    const pod = await kubectl.pod(pinned);
    checkContainerRunning(pod, pinned.container);

    return vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Attaching to pod ${ref.pod}`,
        cancellable: true,
      },
      async (progress, token) => {
        const abort = new AbortController();
        token.onCancellationRequested(() => abort.abort());

        progress.report({ message: 'Setting up the IDE server in the pod…' });
        const target = new KubectlTarget(this.deps.kubectlLauncher(pinned.wsl), pinned);
        const server = await provisionServer(
          new KubectlExecutor(() => this.deps.kubectlLauncher(pinned.wsl), pinned),
          {
            containerId: target.label,
            build,
            urlTemplate: this.deps.serverUrlTemplate(),
            ...(await this.loginInput(`the pod ${ref.namespace}/${ref.pod}`)),
          },
          logger,
          abort.signal,
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
    );
  }
}
