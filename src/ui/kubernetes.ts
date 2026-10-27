// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { homedir } from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DevContainerError, errorMessage } from '../core/errors';
import { checkContainerRunning } from '../core/k8s/attach';
import type { Kubectl, KubectlScope, PodInfo } from '../core/k8s/kubectl';
import { isValidWslDistro } from '../core/k8s/launcher';
import type { KubectlLauncher, WslSelection } from '../core/k8s/launcher';
import { encodePodAuthority } from '../core/k8s/podRef';
import type { Logger } from '../core/logger';
import type { KnownTargets } from '../remote/knownTargets';
import { readSettings, userValue } from './settings';

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

/** `~/...` as a shell would read it; kubectl is started without a shell, so nothing else does. */
export function expandHome(file: string): string {
  return file === '~' || /^~[\\/]/.test(file) ? path.join(homedir(), file.slice(1)) : file;
}

/**
 * The kubectl binary: this extension's setting, else the one the Kubernetes extension is
 * configured with in the user settings (per OS, then general), else `kubectl` from PATH.
 */
export function effectiveKubectlPath(): string {
  const own = readSettings().kubectlPath;
  if (own) {
    return expandHome(own);
  }
  const os =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
  const configured =
    nonEmpty(userValue('vscode-kubernetes', `kubectl-path-${os}`)) ??
    nonEmpty(userValue('vscode-kubernetes', 'kubectl-path'));
  return configured ? expandHome(configured) : 'kubectl';
}

/**
 * The kubeconfig file: this extension's setting, else the Kubernetes extension's from the user
 * settings, else kubectl's own lookup. In WSL, `~` is the Linux home directory, which kubectl's
 * wrapper expands there.
 */
export function effectiveKubeconfig(wsl?: WslSelection): string | undefined {
  // The Kubernetes extension keeps its settings as an object with dotted keys.
  const configured =
    readSettings().kubeconfigPath ??
    nonEmpty(
      userValue<Record<string, unknown>>(undefined, 'vs-kubernetes')?.['vs-kubernetes.kubeconfig'],
    );
  if (configured === undefined) return undefined;
  return wsl ? configured : expandHome(configured);
}

/**
 * Whether kubectl runs in WSL: Windows only, by this extension's user setting, else by the
 * Kubernetes extension's `use-wsl`, so that "Attach to Kiro" uses the kubectl of its explorer.
 */
export function effectiveWsl(
  platform: NodeJS.Platform = process.platform,
): WslSelection | undefined {
  if (platform !== 'win32') return undefined;
  const own = userValue<boolean>('dev.containers', 'kubectlInWSL');
  const enabled = own ?? userValue<unknown>(undefined, 'vs-kubernetes.use-wsl') === true;
  if (!enabled) return undefined;
  const distro = readSettings().kubectlWSLDistro;
  if (distro !== undefined && !isValidWslDistro(distro)) {
    throw new DevContainerError(
      'CONFIG_INVALID',
      `"dev.containers.kubectlWSLDistro" is not a valid WSL distribution name: "${distro}".`,
    );
  }
  return distro === undefined ? {} : { distro };
}

/** What the listing queries and a new attach use: the configured kubeconfig and WSL mode. */
export function effectiveKubectlScope(): KubectlScope {
  const wsl = effectiveWsl();
  const kubeconfig = effectiveKubeconfig(wsl);
  return {
    ...(wsl === undefined ? {} : { wsl }),
    ...(kubeconfig === undefined ? {} : { kubeconfig }),
  };
}

/** A path only Windows can run, which makes no sense as kubectl inside WSL. */
function isWindowsProgram(file: string): boolean {
  return /^[A-Za-z]:/.test(file) || file.includes('\\') || /\.(exe|cmd|bat)$/i.test(file);
}

/**
 * How kubectl is started for `wsl` (a window's recorded mode, or the configured one). In WSL,
 * `dev.containers.kubectlPath` is a Linux path, and the Kubernetes extension's (Windows) paths do
 * not apply; without one, the login shell's PATH finds kubectl.
 */
export function kubectlLauncher(
  wsl: WslSelection | undefined,
  platform: NodeJS.Platform = process.platform,
): KubectlLauncher {
  if (!wsl) return { kubectl: effectiveKubectlPath() };
  if (platform !== 'win32') {
    throw new DevContainerError(
      'ENGINE_UNAVAILABLE',
      'This target runs kubectl in WSL, which exists only on Windows.',
    );
  }
  const own = readSettings().kubectlPath;
  if (own !== undefined && isWindowsProgram(own)) {
    throw new DevContainerError(
      'CONFIG_INVALID',
      `kubectl runs in WSL, so "dev.containers.kubectlPath" must be empty or a Linux path, not "${own}".`,
    );
  }
  return { kubectl: own ?? 'kubectl', wsl };
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

  // The kubeconfig and WSL mode the pod was listed with; the window keeps them.
  const scope = deps.kubectl.scope();
  const pod = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Reading pod ${podName}` },
    () =>
      deps.kubectl.pod({
        namespace,
        pod: podName,
        ...(context === undefined ? {} : { context }),
        ...scope,
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
    ...scope,
  });
  deps.logger.log('info', `Attaching to ${namespace}/${podName} (${container}) in a new window`);
  await deps.targets.add(authority);
  await vscode.commands.executeCommand('vscode.newWindow', {
    remoteAuthority: authority,
    reuseWindow: false,
  });
}
