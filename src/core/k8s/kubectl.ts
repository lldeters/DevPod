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

// kubectl's own log lines (klog), such as "E1028 09:05:27.691553  284 memcache.go:381] ...". An
// entry whose value spans lines ends its first line with "<" and closes with a line ">".
const KLOG_LINE = /^[IWEF]\d{4} \d\d:\d\d:\d\d\.\d+\s+\d+ [\w.-]+:\d+\]/;
// Where kubectl's own message starts; the lines after it explain it.
const ERROR_LINE = /^(error:|Error from server|Unable to connect|The connection to the server)/i;

/**
 * The lines that say what went wrong: without carriage returns, NULs (UTF-16) and klog entries,
 * from kubectl's last error line on (else the last lines), at most `lines` of them.
 */
function tail(output: string, lines = 3): string {
  const all: string[] = [];
  const messages: string[] = [];
  let inKlogValue = false;
  for (const raw of output.replaceAll('\0', '').split(/\r?\n/)) {
    const line = raw.trim();
    if (inKlogValue) {
      inKlogValue = line !== '>';
    } else if (KLOG_LINE.test(line)) {
      inKlogValue = line.endsWith('<');
    } else if (line !== '') {
      messages.push(line);
    }
    if (line !== '') all.push(line);
  }
  if (messages.length === 0) return all.slice(-lines).join('\n');
  let from = -1;
  messages.forEach((line, index) => {
    if (ERROR_LINE.test(line)) from = index;
  });
  return (from >= 0 ? messages.slice(from, from + lines) : messages.slice(-lines)).join('\n');
}

/**
 * wsl.exe's own failures. Their text is in the Windows display language and goes to stdout, so
 * only the error code (which is never translated) and the command names are matched.
 */
function wslFailure(wsl: WslSelection, output: string): DevContainerError | undefined {
  const text = output.replaceAll('\0', '');
  // "Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND", or ".../HCS/HCS_E_HYPERV_NOT_INSTALLED".
  const code =
    /\bWsl\/(?:[\w-]+\/)*([A-Za-z][\w-]*)/.exec(text)?.[1] ??
    /\bWSL_E_[A-Z0-9_]+\b/.exec(text)?.[0];
  if (code === 'WSL_E_DISTRO_NOT_FOUND' && wsl.distro !== undefined) {
    return new DevContainerError(
      'CONFIG_INVALID',
      `WSL has no distribution named "${wsl.distro}" (${code}). "wsl.exe --list --verbose" shows ` +
        'the installed ones (case does not matter, dots and dashes do); set ' +
        '"dev.containers.kubectlWSLDistro" to one of them, or leave it empty for the default ' +
        'distribution. A window keeps the distribution it was attached with: attach to the pod ' +
        'again after changing the setting.',
    );
  }
  if (
    code === 'WSL_E_DISTRO_NOT_FOUND' ||
    code === 'WSL_E_DEFAULT_DISTRO_NOT_FOUND' ||
    // Without any distribution, WSL prints no code, only how to list and install one.
    (code === undefined &&
      /wsl(\.exe)? --install\b/.test(text) &&
      !text.includes('--no-distribution'))
  ) {
    return new DevContainerError(
      'ENGINE_UNAVAILABLE',
      'WSL has no default distribution to run kubectl in. Install one ("wsl.exe --install ' +
        'Ubuntu-24.04"), name one in "dev.containers.kubectlWSLDistro", or run kubectl on Windows ' +
        '("dev.containers.kubectlInWSL": false).',
    );
  }
  if (code !== undefined) {
    const first = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line !== '' && !line.includes(code));
    return new DevContainerError(
      'ENGINE_UNAVAILABLE',
      `WSL could not run kubectl ${describeWsl(wsl)}: ${first ? `${first} ` : ''}(${code}).`,
    );
  }
  return undefined;
}

/** The error for a kubectl query (`label`, such as "get pods") that exited with a failure. */
export function queryFailure(
  launcher: KubectlLauncher,
  label: string,
  result: { code: number | null; stderr: string; stdout?: string },
): DevContainerError {
  const stdout = result.stdout ?? '';
  if (launcher.wsl) {
    // wsl.exe writes its own errors to stdout, and warnings to stderr.
    const failure = wslFailure(launcher.wsl, `${stdout}\n${result.stderr}`);
    if (failure) return failure;
  }
  const detail = tail(result.stderr.trim() === '' ? stdout : result.stderr);
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
    `kubectl ${label}${where} failed${detail ? `: ${detail}` : '.'}`,
  );
}

/** "kubectl" or "kubectl in WSL (Ubuntu)", for messages. */
function kubectlIn(wsl: WslSelection | undefined): string {
  return wsl ? `kubectl ${describeWsl(wsl)}` : 'kubectl';
}

/** kubectl lists no context at all: its kubeconfig does not exist, or is empty. */
export function noContextError(scope: KubectlScope): DevContainerError {
  const file = scope.kubeconfig === undefined ? undefined : `"${scope.kubeconfig}"`;
  if (!scope.wsl) {
    return new DevContainerError(
      'CONFIG_NOT_FOUND',
      `kubectl found no Kubernetes context in ${file ?? 'its kubeconfig (KUBECONFIG, else ~/.kube/config)'}: ` +
        'the file does not exist or lists no contexts. Set "dev.containers.kubeconfigPath" to your ' +
        'kubeconfig.',
    );
  }
  return new DevContainerError(
    'CONFIG_NOT_FOUND',
    `${kubectlIn(scope.wsl)} found no Kubernetes context in ` +
      `${file ?? "~/.kube/config of the distribution's default user, or the file that KUBECONFIG names in the login profile (~/.profile, ~/.bash_profile or ~/.zprofile, not ~/.bashrc)"}: ` +
      'the file does not exist there or lists no contexts. If your kubeconfig is on Windows, copy ' +
      'it into the distribution or set "dev.containers.kubeconfigPath" to it (for example ' +
      'C:\\Users\\<you>\\.kube\\config); certificate files and credential plugins it names must ' +
      'then exist in WSL. A ' +
      'distribution created with "wsl --import" runs as root unless it has a default user. To run ' +
      'kubectl on Windows instead, set "dev.containers.kubectlInWSL" to false.',
  );
}

/** kubectl has contexts, but none is current, where only the current one can be meant. */
export function noCurrentContextError(
  scope: KubectlScope,
  situation: 'explorer' | 'window',
  platform: NodeJS.Platform = process.platform,
): DevContainerError {
  const file = scope.kubeconfig === undefined ? undefined : `"${scope.kubeconfig}"`;
  const set =
    `Set one with "kubectl config use-context <name>` +
    `${scope.kubeconfig === undefined ? '' : ` --kubeconfig=${scope.kubeconfig}`}"` +
    `${scope.wsl ? ' in that distribution' : ''}`;
  if (situation === 'explorer') {
    return new DevContainerError(
      'CONFIG_INVALID',
      `${kubectlIn(scope.wsl)} has no current Kubernetes context in ${file ?? 'its default kubeconfig'}, ` +
        'so it does not know the cluster of the Kubernetes explorer, which may read another ' +
        'kubeconfig ("dev.containers.kubeconfigPath" takes precedence over the Kubernetes ' +
        "extension's setting here). " +
        (platform === 'win32'
          ? 'The Kubernetes extension also runs kubectl on Windows, or with ' +
            '"vs-kubernetes.use-wsl" in the default WSL distribution. '
          : '') +
        `${set}, or attach from the command palette ("Attach to Running Kubernetes Container...").`,
    );
  }
  return new DevContainerError(
    'CONFIG_INVALID',
    `This window names no Kubernetes context, and ${kubectlIn(scope.wsl)} has no current one` +
      `${file === undefined ? '' : ` in ${file}`}. ${set}, or attach to the pod again.`,
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

  /** Which kubectl and kubeconfig `scope` means, for the log. */
  describe(scope: KubectlScope = this.current()): string {
    return (
      `kubectl "${this.launcher(scope.wsl).kubectl}"${scope.wsl ? ` ${describeWsl(scope.wsl)}` : ''}, ` +
      `kubeconfig ${scope.kubeconfig === undefined ? "kubectl's default" : `"${scope.kubeconfig}"`}`
    );
  }

  private run(label: string, args: string[]): Promise<string> {
    return this.runWith(this.current(), label, args);
  }

  private async runWith(scope: KubectlScope, label: string, args: string[]): Promise<string> {
    const launcher = this.launcher(scope.wsl);
    const { command, args: processArgs } = kubectlProcess(launcher, [
      ...kubectlBaseArgs({ kubeconfig: scope.kubeconfig }),
      ...args,
    ]);
    let result: RunResult;
    try {
      // WSL_UTF8 makes wsl.exe write its own messages in UTF-8 instead of UTF-16.
      result = await runProcess(
        command,
        processArgs,
        launcher.wsl ? { env: { ...process.env, WSL_UTF8: '1' } } : {},
      );
    } catch (error) {
      throw new DevContainerError('ENGINE_UNAVAILABLE', notStartedMessage(launcher), {
        cause: error,
      });
    }
    if (result.code !== 0) {
      throw queryFailure(launcher, label, result);
    }
    return result.stdout;
  }

  /**
   * The kubeconfig's current context, which is what the Kubernetes explorer shows; `undefined`
   * when there is none. `kubectl config current-context` would fail in that case, and also when
   * there is no kubeconfig at all, which `config view` reports as empty instead.
   */
  async currentContext(scope: KubectlScope = this.current()): Promise<string | undefined> {
    const name = (
      await this.runWith(scope, 'config view', [
        'config',
        'view',
        '--output=jsonpath={.current-context}',
      ])
    ).trim();
    return name === '' ? undefined : name;
  }

  async contexts(scope: KubectlScope = this.current()): Promise<string[]> {
    return (
      await this.runWith(scope, 'config get-contexts', ['config', 'get-contexts', '--output=name'])
    )
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }

  async namespaces(context: string | undefined): Promise<string[]> {
    return parseNames(
      await this.run('get namespaces', [
        ...kubectlBaseArgs({ context }),
        'get',
        'namespaces',
        '-o',
        'json',
      ]),
    );
  }

  async pods(context: string | undefined, namespace: string): Promise<string[]> {
    return parseNames(
      await this.run('get pods', [
        ...kubectlBaseArgs({ context, namespace }),
        'get',
        'pods',
        '-o',
        'json',
      ]),
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
      await this.runWith(selection, 'get pod', [
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
