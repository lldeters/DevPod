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
import { TunnelHub } from './tunnelHub';

export interface PodResolverDependencies {
  logger: Logger;
  /** Read-only queries (is the pod there and running?). */
  kubectl: Kubectl;
  /** Path of the kubectl binary used for `exec`; read for every connection. */
  kubectlPath: () => string;
  serverBuild: () => Promise<ServerBuildInfo>;
  serverUrlTemplate: () => string | undefined;
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

  /** Called by the IDE for every port it forwards, manually or automatically. */
  tunnelFactory(options: vscode.TunnelOptions): Promise<vscode.Tunnel> {
    return this.hub.factory(options);
  }

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
