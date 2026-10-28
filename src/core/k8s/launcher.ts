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
 * - It expands `~/` in the kubectl path to the Linux home directory.
 * - It turns a leading `--kubeconfig=` argument (kubectlBaseArgs puts it first), a list of files
 *   separated by `;`, into KUBECONFIG, which unlike `--kubeconfig` takes several files: `~/` is
 *   expanded and Windows paths are converted with `wslpath`.
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
  'case ${1-} in --kubeconfig=*) v=${1#--kubeconfig=}; shift; l=; while [ -n "$v" ]; do ' +
    'f=${v%%;*}; if [ "$f" = "$v" ]; then v=; else v=${v#*;}; fi; ' +
    'case $f in "~/"*) f=$HOME/${f#"~/"};; [A-Za-z]:*) f=$(wslpath -u "$f") || exit 1;; esac; ' +
    'if [ -n "$f" ]; then l=${l:+$l:}$f; fi; done; KUBECONFIG=$l; export KUBECONFIG;; esac',
  'exec "$k" "$@"',
].join('; ');

/** Separates the files of a kubeconfig list for kubectl in WSL; such settings come from Windows. */
export const WSL_KUBECONFIG_SEPARATOR = ';';

/** The files of a kubeconfig setting that lists several, like KUBECONFIG; empty entries dropped. */
export function kubeconfigFiles(value: string, separator: string): string[] {
  return value.split(separator).filter((file) => file !== '');
}

/**
 * A Windows path into a WSL distribution (`\\wsl.localhost\Ubuntu\home\me\x`, also `wsl$` or
 * with forward slashes) as the distribution's name and the path inside it.
 */
export function wslPathOf(file: string): { distro: string; path: string } | undefined {
  const match = /^[\\/]{2}(?:wsl\$|wsl\.localhost)[\\/]([^\\/]+)([\\/].*)?$/i.exec(file);
  if (!match?.[1]) return undefined;
  return { distro: match[1], path: (match[2] ?? '/').replace(/\\/g, '/') };
}

/**
 * The `--kubeconfig=` value for the WSL wrapper: paths into the distribution itself
 * (`\\wsl.localhost\<distro>\...`) become Linux paths; one into another distribution is refused,
 * since kubectl cannot read it.
 */
function wslKubeconfig(value: string, wsl: WslSelection): string {
  return kubeconfigFiles(value, WSL_KUBECONFIG_SEPARATOR)
    .map((file) => {
      const inside = wslPathOf(file);
      if (!inside) return file;
      if (wsl.distro !== undefined && inside.distro.toLowerCase() !== wsl.distro.toLowerCase()) {
        throw new DevContainerError(
          'CONFIG_INVALID',
          `The kubeconfig "${file}" is in the WSL distribution "${inside.distro}", but kubectl runs ` +
            `in "${wsl.distro}", which cannot read it. Use a path inside "${wsl.distro}", or set ` +
            '"dev.containers.kubectlWSLDistro" to the other distribution.',
        );
      }
      return inside.path;
    })
    .join(WSL_KUBECONFIG_SEPARATOR);
}

/** `wsl.exe` from the Windows system folder, not whatever PATH finds first. */
export function wslExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'wsl.exe');
}

/**
 * The process that runs kubectl with `args`. In WSL it is started with `--exec`: without it,
 * wsl.exe hands the command line to the distribution's default shell, which would interpret the
 * arguments (pod connections pass a Node.js script as one).
 */
export function kubectlProcess(
  launcher: KubectlLauncher,
  args: readonly string[],
  delimiter: string = path.delimiter,
): ProcessSpec {
  const [first = '', ...rest] = args;
  const kubeconfig = first.startsWith('--kubeconfig=')
    ? first.slice('--kubeconfig='.length)
    : undefined;
  if (!launcher.wsl) {
    // Several files (like KUBECONFIG) only work through KUBECONFIG; --kubeconfig takes one.
    if (kubeconfig === undefined) return { command: launcher.kubectl, args: [...args] };
    const files = kubeconfigFiles(kubeconfig, delimiter);
    return files.length > 1
      ? { command: launcher.kubectl, args: rest, env: { KUBECONFIG: files.join(delimiter) } }
      : {
          command: launcher.kubectl,
          args: [...files.map((file) => `--kubeconfig=${file}`), ...rest],
        };
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
      ...(kubeconfig === undefined
        ? args
        : [`--kubeconfig=${wslKubeconfig(kubeconfig, launcher.wsl)}`, ...rest]),
    ],
  };
}

/** "in WSL" or "in WSL (Ubuntu)", for messages. */
export function describeWsl(wsl: WslSelection): string {
  return wsl.distro === undefined ? 'in WSL' : `in WSL (${wsl.distro})`;
}
