// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { DevContainerError } from '../errors';
import type { ExecTarget, ProcessSpec } from '../exec/target';
import { runProcess } from '../process';
import type { RunResult } from '../process';
import type { ExecOptions } from '../engine/containerEngine';
import type { ServerExecutor } from '../server/provisioner';
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
    private readonly kubectlPath: string,
    private readonly ref: PodRef,
  ) {
    assertPodRef(ref);
    this.label = `${ref.namespace}/${ref.pod}/${ref.container}`;
  }

  spec(command: readonly string[]): ProcessSpec {
    return { command: this.kubectlPath, args: kubectlExecArgs(this.ref, command) };
  }
}

/**
 * Runs scripts in a pod container for server provisioning. `kubectl exec` runs as the user the
 * container is configured with, so the `user` and `workdir` options do not apply.
 */
export class KubectlExecutor implements ServerExecutor {
  constructor(
    private readonly kubectlPath: () => string,
    private readonly ref: PodRef,
  ) {
    assertPodRef(ref);
  }

  exec(options: ExecOptions & { stdin?: string; signal?: AbortSignal }): Promise<RunResult> {
    return runProcess(this.kubectlPath(), kubectlExecArgs(this.ref, options.command), {
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
  return {
    name,
    namespace: typeof metadata['namespace'] === 'string' ? metadata['namespace'] : '',
    phase: typeof status['phase'] === 'string' ? status['phase'] : 'Unknown',
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

/** Read-only kubectl queries used to choose what to attach to. */
export class Kubectl {
  constructor(
    private readonly kubectlPath: () => string,
    private readonly kubeconfig: () => string | undefined,
  ) {}

  private run(args: string[]): Promise<string> {
    return this.runWith(this.kubeconfig(), args);
  }

  private async runWith(kubeconfig: string | undefined, args: string[]): Promise<string> {
    const kubectl = this.kubectlPath();
    let result: RunResult;
    try {
      result = await runProcess(kubectl, [...kubectlBaseArgs({ kubeconfig }), ...args]);
    } catch (error) {
      throw new DevContainerError(
        'ENGINE_UNAVAILABLE',
        `Could not run "${kubectl}". Install kubectl or set "dev.containers.kubectlPath".`,
        { cause: error },
      );
    }
    if (result.code !== 0) {
      const detail = result.stderr.trim().split('\n').slice(-3).join('\n');
      throw new DevContainerError(
        'CLI_FAILED',
        `kubectl ${args[0] ?? ''} failed${detail ? `: ${detail}` : '.'}`,
      );
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
   * Describes one pod. Unlike the listing methods, which use the configured kubeconfig, this uses
   * exactly the kubeconfig of `selection`: it must query the cluster the connection will use, even
   * if the setting has changed since the connection was made.
   */
  async pod(selection: {
    context?: string;
    namespace: string;
    pod: string;
    kubeconfig?: string;
  }): Promise<PodInfo> {
    // Validated like an attach target, since the values become arguments.
    assertPodRef({ ...selection, container: 'placeholder' });
    return parsePodInfo(
      await this.runWith(selection.kubeconfig, [
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
