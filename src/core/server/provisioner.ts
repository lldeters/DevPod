// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { DevContainerError } from '../errors';
import type { ExecOptions } from '../engine/containerEngine';
import type { Logger } from '../logger';
import type { RunResult } from '../process';
import { detectPlatformScript, parsePlatform } from './platform';
import type { ServerBuildInfo } from './productInfo';
import { buildInstallScript, parseInstallResult } from './script';
import type { InstallResult } from './script';
import { expandUrlTemplate } from './template';

/** The part of ContainerEngine that provisioning needs; lets tests inject a fake. */
export interface ServerExecutor {
  exec(options: ExecOptions & { stdin?: string; signal?: AbortSignal }): Promise<RunResult>;
}

export interface ProvisionInput {
  containerId: string;
  /** The container's remote user; the server runs as this user. */
  user: string;
  build: ServerBuildInfo;
  /** User-configured template; takes precedence over the one declared by the IDE. */
  urlTemplate?: string | undefined;
}

export const MISSING_TEMPLATE_MESSAGE =
  'This IDE does not say where its remote server can be downloaded. Set ' +
  '"dev.containers.serverDownloadUrlTemplate" to a URL for a server build that matches this ' +
  'IDE exactly (placeholders: ${commit}, ${quality}, ${version}, ${os}, ${arch}).';

async function runShell(
  executor: ServerExecutor,
  input: ProvisionInput,
  script: string,
  what: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const result = await executor.exec({
    containerId: input.containerId,
    user: input.user,
    interactive: true,
    command: ['sh', '-s'],
    stdin: script,
    ...(signal ? { signal } : {}),
  });
  if (result.code !== 0) {
    // The install script reports its own errors on stdout; let its parser surface them.
    if (what === 'install' && result.stdout.includes('error==')) {
      return result.stdout;
    }
    const detail = (result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n');
    throw new DevContainerError(
      'SERVER_INSTALL_FAILED',
      `Could not ${what === 'install' ? 'set up the server' : 'inspect the container'} (exit code ${
        result.code ?? 'unknown'
      }).${detail ? `\n${detail}` : ''}`,
    );
  }
  return result.stdout;
}

/**
 * Makes sure a server matching the IDE is installed and running inside the container, and returns
 * how to reach it. Safe to call repeatedly: an installed, running server is reused.
 */
export async function provisionServer(
  executor: ServerExecutor,
  input: ProvisionInput,
  logger: Logger,
  signal?: AbortSignal,
): Promise<InstallResult> {
  const template = input.urlTemplate?.trim() || input.build.downloadUrlTemplate;
  if (!template) {
    throw new DevContainerError('SERVER_UNSUPPORTED', MISSING_TEMPLATE_MESSAGE);
  }

  const platform = parsePlatform(
    await runShell(executor, input, detectPlatformScript, 'inspect', signal),
  );
  logger.log('info', `Container platform: ${platform.os}-${platform.arch}, home ${platform.home}`);

  const downloadUrl = expandUrlTemplate(template, {
    commit: input.build.commit,
    quality: input.build.quality,
    version: input.build.version,
    release: '',
    os: platform.os,
    arch: platform.arch,
  });
  logger.log('info', `Installing the IDE server from ${downloadUrl}`);

  const output = await runShell(
    executor,
    input,
    buildInstallScript({
      dataFolderName: input.build.serverDataFolderName,
      commit: input.build.commit,
      applicationName: input.build.serverApplicationName,
      downloadUrl,
    }),
    'install',
    signal,
  );
  const installed = parseInstallResult(output);
  logger.log('info', `IDE server listening on 127.0.0.1:${installed.port} in the container`);
  return installed;
}
