// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { DevContainerError } from '../errors';
import type { Logger } from '../logger';
import { runProcess } from '../process';
import { readConfigurationArgs, upArgs } from './args';
import type { ReadConfigurationOptions, UpOptions } from './args';
import {
  parseCliLogLine,
  parseReadConfigurationResult,
  parseUpResult,
  redactEnvValues,
} from './output';
import type { CliLogEvent, ReadConfigurationResult, UpSuccess } from './output';

/** How to launch the Dev Container CLI. */
export interface CliLocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Chooses between a user-provided `devcontainer` and the CLI bundled with the extension. The CLI is
 * a Node script; inside an Electron-based extension host the Node binary is the IDE executable
 * itself, which needs ELECTRON_RUN_AS_NODE to behave like Node. A user-provided `.js` file runs the
 * same way.
 *
 * On Windows, npm installs the CLI as `devcontainer.cmd`. Node refuses to start batch files without
 * a shell (CVE-2024-27980), and a shell would have to parse paths that come from the workspace, so
 * the script that npm's wrapper starts (`node_modules/@devcontainers/cli/devcontainer.js` next to
 * it) is run directly instead.
 */
export function resolveCliLocation(options: {
  customPath?: string | undefined;
  bundledEntry: string;
  nodeExecutable: string;
  exists?: (file: string) => boolean;
}): CliLocation {
  const asNode = (entry: string): CliLocation => ({
    command: options.nodeExecutable,
    args: [entry],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  });
  const custom = options.customPath?.trim();
  if (!custom) {
    return asNode(options.bundledEntry);
  }
  if (/\.[cm]?js$/i.test(custom)) {
    return asNode(custom);
  }
  if (/\.(cmd|bat)$/i.test(custom)) {
    const entry = path.win32.join(
      path.win32.dirname(custom),
      'node_modules',
      '@devcontainers',
      'cli',
      'devcontainer.js',
    );
    if ((options.exists ?? existsSync)(entry)) {
      return asNode(entry);
    }
    throw new DevContainerError(
      'CLI_FAILED',
      `"${custom}" is a batch file, which cannot be started safely. Set ` +
        '"dev.containers.devcontainerCliPath" to the CLI\'s devcontainer.js (in ' +
        'node_modules/@devcontainers/cli of the installation) or to an executable.',
    );
  }
  return { command: custom, args: [] };
}

export interface CliRunHandlers {
  onLog?: (event: CliLogEvent) => void;
  signal?: AbortSignal;
}

type Defaults = Pick<ReadConfigurationOptions, 'dockerPath' | 'dockerComposePath' | 'logLevel'>;

export class DevContainerCli {
  constructor(
    private readonly location: () => CliLocation,
    private readonly logger: Logger,
    private readonly defaults: () => Defaults = () => ({}),
  ) {}

  /** The CLI's version string, e.g. "0.89.0". */
  async version(): Promise<string> {
    const location = this.location();
    const result = await runProcess(location.command, [...location.args, '--version'], {
      env: { ...process.env, ...location.env },
    });
    if (result.code !== 0) {
      throw new DevContainerError(
        'CLI_FAILED',
        `"${location.command} --version" exited with code ${result.code ?? 'unknown'}.`,
      );
    }
    return result.stdout.trim();
  }

  /** Creates (or reuses) the dev container and runs its lifecycle commands. */
  async up(options: UpOptions, handlers: CliRunHandlers = {}): Promise<UpSuccess> {
    const stdout = await this.run(upArgs({ ...this.defaults(), ...options }), handlers);
    return parseUpResult(stdout);
  }

  /** Reads the resolved configuration, including the workspace path inside the container. */
  async readConfiguration(
    options: ReadConfigurationOptions,
    handlers: CliRunHandlers = {},
  ): Promise<ReadConfigurationResult> {
    const stdout = await this.run(
      readConfigurationArgs({ ...this.defaults(), ...options }),
      handlers,
    );
    return parseReadConfigurationResult(stdout);
  }

  private async run(args: string[], handlers: CliRunHandlers): Promise<string> {
    this.logger.log('debug', redactEnvValues(`devcontainer ${args.join(' ')}`));
    const forwardLog = (line: string): void => {
      const event = parseCliLogLine(line);
      this.logger.log(event.level, event.text);
      handlers.onLog?.(event);
    };

    const location = this.location();
    let result;
    try {
      result = await runProcess(location.command, [...location.args, ...args], {
        env: { ...process.env, ...location.env },
        onStderrLine: forwardLog,
        ...(handlers.signal ? { signal: handlers.signal } : {}),
      });
    } catch (error) {
      throw new DevContainerError(
        'CLI_FAILED',
        `Could not start the Dev Container CLI (${location.command}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    // On failure the CLI still prints a JSON error document on stdout; let the parser report it.
    if (result.code !== 0 && result.stdout.trim() === '') {
      const tail = result.stderr.trim().split('\n').slice(-5).join('\n');
      throw new DevContainerError(
        'CLI_FAILED',
        `The Dev Container CLI exited with code ${result.code ?? result.signal ?? 'unknown'}.${
          tail ? `\n${tail}` : ''
        }`,
      );
    }
    return result.stdout;
  }
}
