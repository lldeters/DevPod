// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import { errorMessage } from '../core/errors';
import { checkContainerRunning } from '../core/k8s/attach';
import type { Kubectl, PodInfo } from '../core/k8s/kubectl';
import { encodePodAuthority } from '../core/k8s/podRef';
import type { Logger } from '../core/logger';
import type { KnownTargets } from '../remote/knownTargets';
import { readSettings } from './settings';

/** What a right-click in the Kubernetes explorer pointed at. */
export type ExplorerTarget =
  | { readonly kind: 'pod'; readonly namespace: string; readonly name: string }
  | { readonly kind: 'other' };

/**
 * Turns the object VS Code passes to a command invoked from the Kubernetes extension's explorer
 * into something well defined, through that extension's public API. `undefined` means the
 * target is not an explorer node (or the extension is not installed).
 */
export async function resolveExplorerTarget(target: unknown): Promise<ExplorerTarget | undefined> {
  const k8s = await import('vscode-kubernetes-tools-api');
  const explorer = await k8s.extension.clusterExplorer.v1;
  if (!explorer.available) {
    return undefined;
  }
  const node = explorer.api.resolveCommandTarget(target);
  if (!node) {
    return undefined;
  }
  // A pod always has a namespace; without one the node cannot be attached to.
  if (node.nodeType === 'resource' && node.resourceKind.manifestKind === 'Pod' && node.namespace) {
    return { kind: 'pod', namespace: node.namespace, name: node.name };
  }
  return { kind: 'other' };
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/**
 * The kubectl binary: this extension's setting, else the one the Kubernetes extension is
 * configured with (per OS, then general), else `kubectl` from PATH.
 */
export function effectiveKubectlPath(): string {
  const own = readSettings().kubectlPath;
  if (own) {
    return own;
  }
  const k8s = vscode.workspace.getConfiguration('vscode-kubernetes');
  const os =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  return nonEmpty(k8s.get(`kubectl-path-${os}`)) ?? nonEmpty(k8s.get('kubectl-path')) ?? 'kubectl';
}

/** The kubeconfig file: this extension's setting, else the Kubernetes extension's, else kubectl's own lookup. */
export function effectiveKubeconfig(): string | undefined {
  const own = readSettings().kubeconfigPath;
  if (own) {
    return own;
  }
  // The Kubernetes extension keeps its settings as an object with dotted keys.
  const settings = vscode.workspace
    .getConfiguration()
    .get<Record<string, unknown>>('vs-kubernetes');
  return nonEmpty(settings?.['vs-kubernetes.kubeconfig']);
}

export interface AttachDependencies {
  logger: Logger;
  kubectl: Kubectl;
  /** Records the window this opens, so the pod resolver opens it without asking. */
  targets: Pick<KnownTargets, 'add'>;
  /** False (after guiding the user) when the proposed API that remote windows need is not enabled. */
  ensureRemoteSupport: () => Promise<boolean>;
  resolveTarget: (target: unknown) => Promise<ExplorerTarget | undefined>;
}

interface Choice<T> extends vscode.QuickPickItem {
  value: T;
}

async function pick<T>(title: string, items: readonly Choice<T>[]): Promise<T | undefined> {
  const picked = await vscode.window.showQuickPick([...items], { title, placeHolder: title });
  return picked?.value;
}

/** Namespaces can be forbidden to list for ordinary users; fall back to typing one. */
async function chooseNamespace(
  deps: AttachDependencies,
  context: string | undefined,
): Promise<string | undefined> {
  try {
    const names = await deps.kubectl.namespaces(context);
    if (names.length > 0) {
      return await pick(
        'Namespace',
        names.map((name) => ({ label: name, value: name })),
      );
    }
  } catch (error) {
    deps.logger.log('info', `Could not list namespaces (${errorMessage(error)}); asking instead.`);
  }
  return nonEmpty(
    await vscode.window.showInputBox({
      title: 'Namespace of the pod',
      value: 'default',
      ignoreFocusOut: true,
    }),
  );
}

/** The palette flow: cluster context, namespace, pod. */
async function chooseInteractively(
  deps: AttachDependencies,
): Promise<{ context: string | undefined; namespace: string; pod: string } | undefined> {
  const current = await deps.kubectl.currentContext();
  const contexts = await deps.kubectl.contexts();
  let context = current;
  if (contexts.length > 1) {
    const ordered = [...contexts].sort((a, b) => Number(b === current) - Number(a === current));
    const chosen = await pick(
      'Kubernetes context',
      ordered.map((name) => ({
        label: name,
        ...(name === current ? { description: 'current' } : {}),
        value: name,
      })),
    );
    if (chosen === undefined) return undefined;
    context = chosen;
  }

  const namespace = await chooseNamespace(deps, context);
  if (!namespace) return undefined;

  const pods = await deps.kubectl.pods(context, namespace);
  if (pods.length === 0) {
    void vscode.window.showInformationMessage(`There are no pods in namespace "${namespace}".`);
    return undefined;
  }
  const pod = await pick(
    `Pod in ${namespace}`,
    pods.map((name) => ({ label: name, value: name })),
  );
  return pod === undefined ? undefined : { context, namespace, pod };
}

/** Which container to use: the only one, else the user's choice (the pod's default first). */
async function chooseContainer(pod: PodInfo): Promise<string | undefined> {
  const running = pod.containers.filter((container) => container.running);
  if (running.length === 1) {
    return running[0]?.name;
  }
  const ordered = [...pod.containers].sort(
    (a, b) => Number(b.name === pod.defaultContainer) - Number(a.name === pod.defaultContainer),
  );
  return pick(
    `Container of pod ${pod.name}`,
    ordered.map((container) => ({
      label: container.name,
      description: [
        container.running ? 'running' : 'not running',
        ...(container.name === pod.defaultContainer ? ['default'] : []),
      ].join(', '),
      value: container.name,
    })),
  );
}

/**
 * "Attach to Kiro": opens a new window whose files, terminal and extensions live in a container of
 * a pod. Called from the Kubernetes explorer's pod menu (with that node as `target`) or from the
 * command palette (without one, then the pod is chosen step by step).
 */
export async function attachToPod(deps: AttachDependencies, target?: unknown): Promise<void> {
  if (!(await deps.ensureRemoteSupport())) {
    return;
  }

  let context: string | undefined;
  let namespace: string;
  let podName: string;

  const explorer = target === undefined ? undefined : await deps.resolveTarget(target);
  if (explorer?.kind === 'other') {
    void vscode.window.showInformationMessage('Select a pod to attach to.');
    return;
  }
  if (explorer?.kind === 'pod') {
    // The explorer lists the pods of the current context, so that is the cluster to use. It is
    // fixed in the connection, so switching contexts later does not redirect an open window.
    context = await deps.kubectl.currentContext();
    namespace = explorer.namespace;
    podName = explorer.name;
  } else {
    const chosen = await chooseInteractively(deps);
    if (!chosen) return;
    ({ context, namespace, pod: podName } = chosen);
  }

  const kubeconfig = effectiveKubeconfig();
  const pod = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Reading pod ${podName}` },
    () =>
      deps.kubectl.pod({
        namespace,
        pod: podName,
        ...(context === undefined ? {} : { context }),
        ...(kubeconfig === undefined ? {} : { kubeconfig }),
      }),
  );
  const container = await chooseContainer(pod);
  if (!container) return;
  checkContainerRunning(pod, container);

  const authority = encodePodAuthority({
    namespace,
    pod: podName,
    container,
    ...(context === undefined ? {} : { context }),
    ...(kubeconfig === undefined ? {} : { kubeconfig }),
  });
  deps.logger.log('info', `Attaching to ${namespace}/${podName} (${container}) in a new window`);
  await deps.targets.add(authority);
  await vscode.commands.executeCommand('vscode.newWindow', {
    remoteAuthority: authority,
    reuseWindow: false,
  });
}
