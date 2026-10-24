// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import { checkContainerRunning } from '../core/k8s/attach';
import { KubectlExecutor, KubectlTarget } from '../core/k8s/kubectl';
import type { Kubectl } from '../core/k8s/kubectl';
import { decodePodAuthority } from '../core/k8s/podRef';
import type { Logger } from '../core/logger';
import type { ServerBuildInfo } from '../core/server/productInfo';
import { provisionServer } from '../core/server/provisioner';
import { createBridge } from './bridge';
import { confirmTarget } from './knownTargets';
import type { KnownTargets } from './knownTargets';
import { TunnelHub } from './tunnelHub';

export interface PodResolverDependencies {
  logger: Logger;
  /** Read-only queries (is the pod there and running?). */
  kubectl: Kubectl;
  /** Path of the kubectl binary used for `exec`; read for every connection. */
  kubectlPath: () => string;
  /** Authorities opened by this extension; any other one is confirmed before it is used. */
  targets: Pick<KnownTargets, 'has' | 'add'>;
  serverBuild: () => Promise<ServerBuildInfo>;
  serverUrlTemplate: () => string | undefined;
  /** This machine's Kiro sign-in to place in the pod, or `undefined` if it is not shared. */
  kiroLogin: () => Promise<string | undefined>;
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

  private async start(authority: string): Promise<vscode.ResolverResult> {
    const { logger, kubectl } = this.deps;
    const ref = decodePodAuthority(authority);
    logger.log(
      'info',
      `Attaching to ${ref.namespace}/${ref.pod} (container ${ref.container}${
        ref.context ? `, context ${ref.context}` : ''
      })`,
    );
    // Before kubectl runs: the kubeconfig decides which cluster is contacted, and it can run commands.
    await confirmTarget(
      this.deps.targets,
      authority,
      `Attach to the pod ${ref.namespace}/${ref.pod}?`,
      `Pod: ${ref.namespace}/${ref.pod}\nContainer: ${ref.container}\n` +
        `Context: ${ref.context ?? 'the current one'}\n` +
        `kubeconfig: ${ref.kubeconfig ?? "kubectl's default"}\n\n` +
        'This runs kubectl with that kubeconfig and installs the IDE server in the container.',
    );

    const build = await this.deps.serverBuild();
    const pod = await kubectl.pod({
      namespace: ref.namespace,
      pod: ref.pod,
      ...(ref.context === undefined ? {} : { context: ref.context }),
      ...(ref.kubeconfig === undefined ? {} : { kubeconfig: ref.kubeconfig }),
    });
    checkContainerRunning(pod, ref.container);

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
        const target = new KubectlTarget(this.deps.kubectlPath(), ref);
        const server = await provisionServer(
          new KubectlExecutor(this.deps.kubectlPath, ref),
          {
            containerId: target.label,
            build,
            urlTemplate: this.deps.serverUrlTemplate(),
            kiroLogin: await this.deps.kiroLogin(),
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
