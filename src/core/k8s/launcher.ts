// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as path from 'node:path';
import { DevContainerError } from '../errors';
import type { ProcessSpec } from '../exec/target';

/** kubectl runs inside WSL, in `distro` or else in the default distribution. */
export interface WslSelection {
  readonly distro?: string;
}

/** How kubectl is started: directly on this machine, or inside WSL. */
export interface KubectlLauncher {
  /** The kubectl program: a path or name on this machine, or, with `wsl`, inside WSL. */
  readonly kubectl: string;
  readonly wsl?: WslSelection;
}

// The characters WSL allows in distribution names.
const WSL_DISTRO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidWslDistro(name: string): boolean {
  return WSL_DISTRO.test(name);
}

/**
 * The script `sh -c` runs inside WSL, as `sh -c <script> kubectl <kubectl> <args...>`:
 *
 * - It takes PATH and KUBECONFIG from the user's login shell, so kubectl and credential plugins
 *   set up in the login profile are found. The profile runs with stdin, stdout and stderr detached:
 *   it can neither read the data meant for kubectl nor write into kubectl's output. If that shell
 *   fails, the default PATH stays.
 * - It expands `~/` in the kubectl path and in a leading `--kubeconfig=` argument to the Linux home
 *   directory, and converts a Windows kubeconfig path with `wslpath`. kubectlBaseArgs puts
 *   `--kubeconfig=` first.
 * - It runs kubectl with every other argument unchanged.
 */
export const WSL_KUBECTL_SCRIPT = [
  `e=$("\${SHELL:-/bin/sh}" -lc 'printf "@dck@%s@dck@%s" "$PATH" "\${KUBECONFIG-}"' </dev/null 2>/dev/null)`,
  'case $e in *@dck@*@dck@*) v=${e##*@dck@}; e=${e%@dck@*}; p=${e##*@dck@}; ' +
    'if [ -n "$p" ]; then PATH=$p; export PATH; fi; ' +
    'if [ -n "$v" ]; then KUBECONFIG=$v; export KUBECONFIG; fi;; esac',
  'k=$1',
  'shift',
  'case $k in "~/"*) k=$HOME/${k#"~/"};; esac',
  'case ${1-} in "--kubeconfig=~/"*) c=${1#"--kubeconfig=~/"}; shift; set -- "--kubeconfig=$HOME/$c" "$@";; ' +
    '--kubeconfig=[A-Za-z]:*) c=$(wslpath -u "${1#--kubeconfig=}") || exit 1; shift; set -- "--kubeconfig=$c" "$@";; esac',
  'exec "$k" "$@"',
].join('; ');

/** `wsl.exe` from the Windows system folder, not whatever PATH finds first. */
export function wslExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'wsl.exe');
}

/**
 * The process that runs kubectl with `args`. In WSL it is started with `--exec`: without it,
 * wsl.exe hands the command line to the distribution's default shell, which would interpret the
 * arguments (pod connections pass a Node.js script as one).
 */
export function kubectlProcess(launcher: KubectlLauncher, args: readonly string[]): ProcessSpec {
  if (!launcher.wsl) {
    return { command: launcher.kubectl, args: [...args] };
  }
  const { distro } = launcher.wsl;
  if (distro !== undefined && !isValidWslDistro(distro)) {
    throw new DevContainerError(
      'CONFIG_INVALID',
      `"${distro}" is not a valid WSL distribution name.`,
    );
  }
  return {
    command: wslExecutable(),
    args: [
      ...(distro === undefined ? [] : ['--distribution', distro]),
      '--cd',
      '~',
      '--exec',
      '/bin/sh',
      '-c',
      WSL_KUBECTL_SCRIPT,
      'kubectl',
      launcher.kubectl,
      ...args,
    ],
  };
}

/** "in WSL" or "in WSL (Ubuntu)", for messages. */
export function describeWsl(wsl: WslSelection): string {
  return wsl.distro === undefined ? 'in WSL' : `in WSL (${wsl.distro})`;
}
