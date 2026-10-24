// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { DevContainerError } from '../errors';
import { runProcess } from '../process';

export interface ExecOptions {
  containerId: string;
  command: readonly string[];
  /** Keep stdin open (`-i`). */
  interactive?: boolean;
  user?: string | undefined;
  workdir?: string | undefined;
  env?: Readonly<Record<string, string>> | undefined;
}

/** Builds the argument vector of `<engine> exec`. Pure; no shell is involved. */
export function execArgs(options: ExecOptions): string[] {
  const args = ['exec'];
  if (options.interactive) {
    args.push('-i');
  }
  if (options.user) {
    args.push('-u', options.user);
  }
  if (options.workdir) {
    args.push('-w', options.workdir);
  }
  for (const [name, value] of Object.entries(options.env ?? {})) {
    args.push('-e', `${name}=${value}`);
  }
  args.push(options.containerId, ...options.command);
  return args;
}

/** Thin wrapper around the `docker` or `podman` CLI. */
export class ContainerEngine {
  constructor(private readonly enginePath: () => string) {}

  get path(): string {
    return this.enginePath();
  }

  /** Verifies that the engine answers; returns its server version. */
  async checkAvailable(): Promise<string> {
    const engine = this.path;
    try {
      const result = await runProcess(engine, ['version', '--format', '{{.Server.Version}}']);
      if (result.code === 0) {
        return result.stdout.trim();
      }
      throw new DevContainerError(
        'ENGINE_UNAVAILABLE',
        `"${engine}" is installed but its service is not reachable. Start Docker (or Podman) and try again.\n${result.stderr.trim()}`,
      );
    } catch (error) {
      if (error instanceof DevContainerError) {
        throw error;
      }
      throw new DevContainerError(
        'ENGINE_UNAVAILABLE',
        `Could not run "${engine}". Install Docker or Podman, or set "dev.containers.dockerPath".`,
        { cause: error },
      );
    }
  }

  /** Runs `<engine> exec` and collects the output. */
  exec(
    options: ExecOptions & { stdin?: string; signal?: AbortSignal },
  ): ReturnType<typeof runProcess> {
    return runProcess(this.path, execArgs(options), {
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  }
}
