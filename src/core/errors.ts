// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

export type ErrorCode =
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'AUTHORITY_INVALID'
  | 'TARGET_DECLINED'
  | 'CLI_FAILED'
  | 'CLI_BAD_OUTPUT'
  | 'ENGINE_UNAVAILABLE'
  | 'SERVER_UNSUPPORTED'
  | 'SERVER_INSTALL_FAILED';

/**
 * Error with a stable machine-readable code. The message is meant for users; it can quote output of
 * other programs, so a notification shows it through `notificationText`.
 */
export class DevContainerError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DevContainerError';
  }
}

export function isDevContainerError(error: unknown): error is DevContainerError {
  return error instanceof DevContainerError;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * `text` for a notification of the IDE, which turns `[label](target)` into a link, also for
 * `command:` targets. Messages can quote output of a container, a pod, kubectl or the Dev Container
 * CLI, so the link syntax is broken up; the rest of the text is unchanged.
 */
export function notificationText(text: string): string {
  return text.replace(/\]\(/g, '] (');
}
