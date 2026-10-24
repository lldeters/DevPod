// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { DevContainerError } from '../errors';
import { parseKeyValueOutput } from './script';

export type ServerOs = 'linux' | 'alpine';
export type ServerArch = 'x64' | 'arm64' | 'armhf';

export interface ContainerPlatform {
  readonly os: ServerOs;
  readonly arch: ServerArch;
  readonly home: string;
}

export const PLATFORM_MARKER = 'devcontainers-kiro-platform';

/** POSIX sh script that reports kernel, machine, libc flavour and $HOME of the container user. */
export const detectPlatformScript = `
echo "${PLATFORM_MARKER}: start"
echo "kernel==$(uname -s)"
echo "machine==$(uname -m)"
if [ -f /etc/alpine-release ]; then echo "libc==musl"; else echo "libc==gnu"; fi
echo "home==$HOME"
echo "${PLATFORM_MARKER}: end"
`;

const archByMachine: Record<string, ServerArch> = {
  x86_64: 'x64',
  amd64: 'x64',
  aarch64: 'arm64',
  arm64: 'arm64',
  armv7l: 'armhf',
  armv8l: 'armhf',
};

export function parsePlatform(output: string): ContainerPlatform {
  const values = parseKeyValueOutput(output, PLATFORM_MARKER);
  const kernel = values['kernel'];
  const machine = values['machine'] ?? '';
  const home = values['home'];
  if (kernel !== 'Linux') {
    throw new DevContainerError(
      'SERVER_UNSUPPORTED',
      `Only Linux containers are supported (the container reports "${kernel ?? 'unknown'}").`,
    );
  }
  const arch = archByMachine[machine];
  if (!arch) {
    throw new DevContainerError(
      'SERVER_UNSUPPORTED',
      `The container architecture "${machine}" is not supported.`,
    );
  }
  if (!home || !home.startsWith('/')) {
    throw new DevContainerError(
      'SERVER_UNSUPPORTED',
      'Could not determine the home directory of the container user.',
    );
  }
  return { os: values['libc'] === 'musl' ? 'alpine' : 'linux', arch, home };
}
