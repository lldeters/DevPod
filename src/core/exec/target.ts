// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { execArgs } from '../engine/containerEngine';

/** A program and its arguments, to be started without a shell. */
export interface ProcessSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Variables to set on top of this process's environment. */
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * Somewhere a command can be run with stdin attached: a Docker container, a container of a
 * Kubernetes pod, ... Server installation, the connection bridge and port tunnels only need this,
 * so they work the same for every kind of target.
 */
export interface ExecTarget {
  /** Short name for log messages. */
  readonly label: string;
  /** The process that runs `command` in the target (interactive, so stdin is passed through). */
  spec(command: readonly string[]): ProcessSpec;
}

/** A running Docker (or Podman) container. */
export class DockerTarget implements ExecTarget {
  readonly label: string;

  constructor(
    private readonly enginePath: string,
    private readonly containerId: string,
    private readonly user?: string,
  ) {
    this.label = containerId.slice(0, 12);
  }

  spec(command: readonly string[]): ProcessSpec {
    return {
      command: this.enginePath,
      args: execArgs({
        containerId: this.containerId,
        user: this.user,
        interactive: true,
        command,
      }),
    };
  }
}
