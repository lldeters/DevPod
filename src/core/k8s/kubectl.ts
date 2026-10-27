// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { DevContainerError } from '../errors';
import type { ExecTarget, ProcessSpec } from '../exec/target';
import { runProcess } from '../process';
import type { RunResult } from '../process';
import type { ExecOptions } from '../engine/containerEngine';
import type { ServerExecutor } from '../server/provisioner';
import { describeWsl, kubectlProcess, wslExecutable } from './launcher';
import type { KubectlLauncher, WslSelection } from './launcher';
import { assertPodRef } from './podRef';
import type { PodRef } from './podRef';

/**
 * Global kubectl flags that select the cluster. The `--flag=value` form is used throughout, so a
 * value can never be taken for a separate option.
 */
export function kubectlBaseArgs(selection: {
  context?: string | undefined;
  namespace?: string | undefined;
  kubeconfig?: string | undefined;
}): string[] {
  const args: string[] = [];
  if (selection.kubeconfig) args.push(`--kubeconfig=${selection.kubeconfig}`);
  if (selection.context) args.push(`--context=${selection.context}`);
  if (selection.namespace) args.push(`--namespace=${selection.namespace}`);
  return args;
}

/** `kubectl exec -i` into one container; everything after `--` is the command to run. */
export function kubectlExecArgs(ref: PodRef, command: readonly string[]): string[] {
  assertPodRef(ref);
  return [
    ...kubectlBaseArgs(ref),
    'exec',
    '-i',
    `--container=${ref.container}`,
    ref.pod,
    '--',
    ...command,
  ];
}

/** A container of a pod, reached with `kubectl exec`. */
export class KubectlTarget implements ExecTarget {
  readonly label: string;

  constructor(
    private readonly launcher: KubectlLauncher,
    private readonly ref: PodRef,
  ) {
    assertPodRef(ref);
    this.label = `${ref.namespace}/${ref.pod}/${ref.container}`;
  }

  spec(command: readonly string[]): ProcessSpec {
    return kubectlProcess(this.launcher, kubectlExecArgs(this.ref, command));
  }
}

/**
 * Runs scripts in a pod container for server provisioning. `kubectl exec` runs as the user the
 * container is configured with, so the `user` and `workdir` options do not apply.
 */
export class KubectlExecutor implements ServerExecutor {
  constructor(
    private readonly launcher: () => KubectlLauncher,
    private readonly ref: PodRef,
  ) {
    assertPodRef(ref);
  }

  exec(options: ExecOptions & { stdin?: string; signal?: AbortSignal }): Promise<RunResult> {
    const { command, args } = kubectlProcess(
      this.launcher(),
      kubectlExecArgs(this.ref, options.command),
    );
    return runProcess(command, args, {
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
}

export interface ContainerInfo {
  readonly name: string;
  readonly ready: boolean;
  readonly running: boolean;
}

export interface PodInfo {
  readonly name: string;
  readonly namespace: string;
  readonly phase: string;
  /** Regular containers only; init and ephemeral containers cannot be attached to sensibly. */
  readonly containers: readonly ContainerInfo[];
  /** The container `kubectl` itself would pick (annotation `kubectl.kubernetes.io/default-container`). */
  readonly defaultContainer?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** The phases of a pod; anything else the cluster reports is taken as `Unknown`. */
const POD_PHASES = new Set(['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown']);

/** Reads the parts of `kubectl get pod -o json` that attaching needs. */
export function parsePodInfo(json: string): PodInfo {
  let document: unknown;
  try {
    document = JSON.parse(json);
  } catch (error) {
    throw new DevContainerError('CLI_BAD_OUTPUT', 'kubectl returned no valid pod description.', {
      cause: error,
    });
  }
  const pod = asRecord(document);
  const metadata = asRecord(pod['metadata']);
  const spec = asRecord(pod['spec']);
  const status = asRecord(pod['status']);

  const statuses = new Map<string, Record<string, unknown>>();
  for (const entry of Array.isArray(status['containerStatuses'])
    ? status['containerStatuses']
    : []) {
    const record = asRecord(entry);
    if (typeof record['name'] === 'string') statuses.set(record['name'], record);
  }

  const containers: ContainerInfo[] = [];
  for (const entry of Array.isArray(spec['containers']) ? spec['containers'] : []) {
    const name = asRecord(entry)['name'];
    if (typeof name !== 'string') continue;
    const current = statuses.get(name);
    containers.push({
      name,
      ready: current?.['ready'] === true,
      running: 'running' in asRecord(current?.['state']),
    });
  }

  const name = metadata['name'];
  if (typeof name !== 'string') {
    throw new DevContainerError('CLI_BAD_OUTPUT', 'kubectl returned no valid pod description.');
  }
  const preferred = asRecord(metadata['annotations'])['kubectl.kubernetes.io/default-container'];
  const phase = status['phase'];
  return {
    name,
    namespace: typeof metadata['namespace'] === 'string' ? metadata['namespace'] : '',
    phase: typeof phase === 'string' && POD_PHASES.has(phase) ? phase : 'Unknown',
    containers,
    ...(typeof preferred === 'string' ? { defaultContainer: preferred } : {}),
  };
}

/** Names from a `kubectl get <kind> -o json` list. */
export function parseNames(json: string): string[] {
  try {
    const items = asRecord(JSON.parse(json))['items'];
    return (Array.isArray(items) ? items : []).flatMap((item) => {
      const name = asRecord(asRecord(item)['metadata'])['name'];
      return typeof name === 'string' ? [name] : [];
    });
  } catch {
    return [];
  }
}

/** Which cluster access the listing queries use: kubeconfig, and whether kubectl runs in WSL. */
export interface KubectlScope {
  readonly kubeconfig?: string;
  readonly wsl?: WslSelection;
}

/** Why kubectl could not be started at all, and what to do about it. */
export function notStartedMessage(launcher: KubectlLauncher): string {
  if (launcher.wsl) {
    return `Could not start WSL (${wslExecutable()}). Install WSL, or turn off "dev.containers.kubectlInWSL".`;
  }
  if (/\.(cmd|bat)$/i.test(launcher.kubectl)) {
    return (
      `"${launcher.kubectl}" is a batch file, which cannot be started without a shell. Set ` +
      '"dev.containers.kubectlPath" to kubectl.exe, or run kubectl in WSL with "dev.containers.kubectlInWSL".'
    );
  }
  return `Could not run "${launcher.kubectl}". Install kubectl or set "dev.containers.kubectlPath".`;
}

/** The error for a kubectl query (`subcommand`, such as `get`) that exited with a failure. */
export function queryFailure(
  launcher: KubectlLauncher,
  subcommand: string,
  result: { code: number | null; stderr: string; stdout?: string },
): DevContainerError {
  // wsl.exe writes some of its own messages in UTF-16, and some to stdout.
  const text = (result.stderr.trim() === '' ? (result.stdout ?? '') : result.stderr).replaceAll(
    '\0',
    '',
  );
  const detail = text.trim().split('\n').slice(-3).join('\n');
  if (launcher.wsl && result.code === 127) {
    return new DevContainerError(
      'ENGINE_UNAVAILABLE',
      `kubectl was not found ${describeWsl(launcher.wsl)}${detail ? ` (${detail})` : ''}. ` +
        'Install it there, or set "dev.containers.kubectlPath" to its Linux path. PATH is read ' +
        'from the login profile (~/.profile, ~/.bash_profile or ~/.zprofile), not from ~/.bashrc.',
    );
  }
  const where = launcher.wsl ? ` (${describeWsl(launcher.wsl)})` : '';
  return new DevContainerError(
    'CLI_FAILED',
    `kubectl ${subcommand}${where} failed${detail ? `: ${detail}` : '.'}`,
  );
}

/** Read-only kubectl queries used to choose what to attach to. */
export class Kubectl {
  constructor(
    /** How kubectl is started, directly or in the given WSL distribution; read for every call. */
    private readonly launcher: (wsl: WslSelection | undefined) => KubectlLauncher,
    /** The kubeconfig and WSL mode of the listing queries; read for every call. */
    private readonly current: () => KubectlScope,
  ) {}

  /** What the listing queries use now; an attach records it in the window's target. */
  scope(): KubectlScope {
    return this.current();
  }

  private run(args: string[]): Promise<string> {
    return this.runWith(this.current(), args);
  }

  private async runWith(scope: KubectlScope, args: string[]): Promise<string> {
    const launcher = this.launcher(scope.wsl);
    const { command, args: processArgs } = kubectlProcess(launcher, [
      ...kubectlBaseArgs({ kubeconfig: scope.kubeconfig }),
      ...args,
    ]);
    let result: RunResult;
    try {
      result = await runProcess(command, processArgs);
    } catch (error) {
      throw new DevContainerError('ENGINE_UNAVAILABLE', notStartedMessage(launcher), {
        cause: error,
      });
    }
    if (result.code !== 0) {
      throw queryFailure(launcher, args[0] ?? '', result);
    }
    return result.stdout;
  }

  /** The kubeconfig's current context, which is what the Kubernetes explorer shows. */
  async currentContext(): Promise<string | undefined> {
    const name = (await this.run(['config', 'current-context'])).trim();
    return name === '' ? undefined : name;
  }

  async contexts(): Promise<string[]> {
    return (await this.run(['config', 'get-contexts', '--output=name']))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  async namespaces(context: string | undefined): Promise<string[]> {
    return parseNames(
      await this.run([...kubectlBaseArgs({ context }), 'get', 'namespaces', '-o', 'json']),
    );
  }

  async pods(context: string | undefined, namespace: string): Promise<string[]> {
    return parseNames(
      await this.run([...kubectlBaseArgs({ context, namespace }), 'get', 'pods', '-o', 'json']),
    );
  }

  /**
   * Describes one pod. Unlike the listing methods, which use the configured kubeconfig and WSL
   * mode, this uses exactly those of `selection`: it must query the cluster the connection will
   * use, even if the settings have changed since the connection was made.
   */
  async pod(selection: {
    context?: string;
    namespace: string;
    pod: string;
    kubeconfig?: string;
    wsl?: WslSelection;
  }): Promise<PodInfo> {
    // Validated like an attach target, since the values become arguments.
    assertPodRef({ ...selection, container: 'placeholder' });
    return parsePodInfo(
      await this.runWith(selection, [
        ...kubectlBaseArgs({ context: selection.context, namespace: selection.namespace }),
        'get',
        'pod',
        selection.pod,
        '-o',
        'json',
      ]),
    );
  }
}
