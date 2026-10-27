// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { DevContainerError } from '../errors';
import type { ExecOptions } from '../engine/containerEngine';
import type { Logger } from '../logger';
import type { RunResult } from '../process';
import { detectPlatformScript, parsePlatform } from './platform';
import type { ServerBuildInfo } from './productInfo';
import {
  buildLoginStatusScript,
  buildShareLoginScript,
  parseLoginStatus,
  parseShareLoginResult,
} from './kiroLogin';
import {
  buildReadSettingsScript,
  buildWriteSettingsScript,
  machineSettingsPath,
  mergeSettingsText,
} from './machineSettings';
import { buildInstallScript, parseInstallResult } from './script';
import type { InstallResult } from './script';
import { expandUrlTemplate, urlForLog } from './template';

/** The part of ContainerEngine that provisioning needs; lets tests inject a fake. */
export interface ServerExecutor {
  exec(options: ExecOptions & { stdin?: string; signal?: AbortSignal }): Promise<RunResult>;
}

export interface ProvisionInput {
  containerId: string;
  /** The container's remote user; the server runs as this user. Absent for pods. */
  user?: string | undefined;
  build: ServerBuildInfo;
  /** User-configured template; takes precedence over the one declared by the IDE. */
  urlTemplate?: string | undefined;
  /** Extensions to install in the container (valid `publisher.name` ids). */
  extensions?: readonly string[] | undefined;
  /** Settings for the container's machine settings; merged into what is already there. */
  settings?: Readonly<Record<string, unknown>> | undefined;
  /**
   * Content of this machine's Kiro sign-in file, to be placed in the container's home directory
   * unless it already has one. Absent when the user does not share the sign-in.
   */
  kiroLogin?: string | undefined;
  /**
   * Asked before the sign-in is copied, and only if the container has none yet; `false` copies
   * nothing. Absent when the user shares the sign-in without being asked.
   */
  confirmKiroLogin?: (() => Promise<boolean>) | undefined;
}

/** This machine's Kiro sign-in, and the question to ask before it is copied (if any). */
export interface KiroLoginShare {
  readonly text: string;
  readonly confirm?: (() => Promise<boolean>) | undefined;
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
    // Never echo output while copying the sign-in: it must not end up in a message or a log.
    const detail =
      what === 'login'
        ? ''
        : (result.stderr || result.stdout).trim().split('\n').slice(-5).join('\n');
    const action = {
      install: 'set up the server',
      settings: 'write settings',
      login: 'copy the Kiro sign-in',
    }[what];
    throw new DevContainerError(
      'SERVER_INSTALL_FAILED',
      `Could not ${action ?? 'inspect the container'} (exit code ${result.code ?? 'unknown'}).${
        detail ? `\n${detail}` : ''
      }`,
    );
  }
  return result.stdout;
}

/**
 * Merges `settings` into the container's machine settings. Settings are a convenience, so a
 * problem here is logged and does not stop the connection (unless the operation was cancelled).
 */
async function syncMachineSettings(
  executor: ServerExecutor,
  input: ProvisionInput,
  home: string,
  settings: Readonly<Record<string, unknown>>,
  logger: Logger,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    const file = machineSettingsPath(home, input.build.serverDataFolderName);
    const current = await runShell(
      executor,
      input,
      buildReadSettingsScript(file),
      'inspect',
      signal,
    );
    const merged = mergeSettingsText(current, { ...settings });
    if (merged === current) {
      return;
    }
    await runShell(executor, input, buildWriteSettingsScript(file, merged), 'settings', signal);
    logger.log(
      'info',
      `Applied ${Object.keys(settings).length} setting(s) from the dev container configuration`,
    );
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    logger.log(
      'warn',
      `Could not apply the dev container settings: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

const LOGIN_MESSAGES = {
  copied: 'Copied the Kiro sign-in of this machine into the container.',
  exists: 'The container already has a Kiro sign-in; it was left unchanged.',
  nohome:
    'The container user has no private, writable home directory, so the Kiro sign-in was not copied.',
  declined: 'The Kiro sign-in was not copied into the container (not confirmed).',
};

/**
 * Places this machine's Kiro sign-in in the container, so Kiro there does not ask to sign in again.
 * With `confirm`, the user is asked first, and only if the container has no sign-in yet. An
 * existing file is never replaced, and nothing is copied back. The content is never logged. A
 * problem is logged and does not stop the connection (unless the operation was cancelled).
 */
async function shareKiroLogin(
  executor: ServerExecutor,
  input: ProvisionInput,
  text: string,
  confirm: (() => Promise<boolean>) | undefined,
  logger: Logger,
  signal: AbortSignal | undefined,
): Promise<void> {
  try {
    if (confirm) {
      const status = parseLoginStatus(
        await runShell(executor, input, buildLoginStatusScript(), 'login', signal),
      );
      if (status !== 'missing') {
        logger.log(status === 'nohome' ? 'warn' : 'info', LOGIN_MESSAGES[status]);
        return;
      }
      if (!(await confirm())) {
        logger.log('info', LOGIN_MESSAGES.declined);
        return;
      }
    }
    const output = await runShell(executor, input, buildShareLoginScript(text), 'login', signal);
    const result = parseShareLoginResult(output);
    logger.log(result === 'nohome' ? 'warn' : 'info', LOGIN_MESSAGES[result]);
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    logger.log(
      'warn',
      `Could not copy the Kiro sign-in: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

  if (input.settings && Object.keys(input.settings).length > 0) {
    await syncMachineSettings(executor, input, platform.home, input.settings, logger, signal);
  }

  if (input.kiroLogin) {
    await shareKiroLogin(executor, input, input.kiroLogin, input.confirmKiroLogin, logger, signal);
  }

  const downloadUrl = expandUrlTemplate(template, {
    commit: input.build.commit,
    quality: input.build.quality,
    version: input.build.version,
    release: '',
    os: platform.os,
    arch: platform.arch,
  });
  logger.log('info', `Installing the IDE server from ${urlForLog(downloadUrl)}`);

  const output = await runShell(
    executor,
    input,
    buildInstallScript({
      dataFolderName: input.build.serverDataFolderName,
      commit: input.build.commit,
      applicationName: input.build.serverApplicationName,
      downloadUrl,
      ...(input.extensions && input.extensions.length > 0 ? { extensions: input.extensions } : {}),
    }),
    'install',
    signal,
  );
  const installed = parseInstallResult(output);
  logger.log('info', `IDE server listening on 127.0.0.1:${installed.port} in the container`);
  return installed;
}
