// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as path from 'node:path';
import { DevContainerError } from './errors';

/** Remote authority prefix: `dev-container+<hex>`, resolved by this extension. */
export const AUTHORITY_PREFIX = 'dev-container';

/** What the authority identifies: a local folder and, optionally, one of its configs. */
export interface AuthorityParams {
  /** Absolute path of the folder on the local machine. */
  readonly hostPath: string;
  /** Absolute path of the devcontainer.json to use; the default lookup is used if absent. */
  readonly configFile?: string;
}

interface Payload {
  v: 1;
  hostPath: string;
  configFile?: string;
}

function isAbsolute(candidate: string): boolean {
  return path.posix.isAbsolute(candidate) || path.win32.isAbsolute(candidate);
}

/**
 * Windows network (UNC) and device paths such as `\\host\share` or `\\?\UNC\host\share`. Merely
 * reading one contacts that host and can hand it the user's Windows credentials, so they are never
 * accepted from an authority. The shares WSL provides for its distributions are local and allowed.
 */
export function isNetworkPath(candidate: string): boolean {
  return /^[\\/]{2}/.test(candidate) && !/^[\\/]{2}(wsl\$|wsl\.localhost)[\\/]/i.test(candidate);
}

function assertPath(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value === '' || value.includes('\0') || !isAbsolute(value)) {
    throw new DevContainerError(
      'AUTHORITY_INVALID',
      `The remote authority has an invalid ${field}.`,
    );
  }
  if (isNetworkPath(value)) {
    throw new DevContainerError(
      'AUTHORITY_INVALID',
      `The ${field} is on a network share (${value}), which is not supported.`,
    );
  }
}

export function isDevContainerAuthority(authority: string | undefined): authority is string {
  return authority?.startsWith(`${AUTHORITY_PREFIX}+`) ?? false;
}

export function encodeAuthority(params: AuthorityParams): string {
  assertPath(params.hostPath, 'folder path');
  const payload: Payload = { v: 1, hostPath: params.hostPath };
  if (params.configFile !== undefined) {
    assertPath(params.configFile, 'configuration path');
    payload.configFile = params.configFile;
  }
  return `${AUTHORITY_PREFIX}+${Buffer.from(JSON.stringify(payload), 'utf8').toString('hex')}`;
}

/**
 * Decodes and validates an authority. Authorities can originate from links, so every field is
 * checked; the paths are only ever passed to the Dev Container CLI as arguments, never to a shell.
 */
export function decodeAuthority(authority: string): AuthorityParams {
  if (!isDevContainerAuthority(authority)) {
    throw new DevContainerError('AUTHORITY_INVALID', 'Not a dev container authority.');
  }
  const hex = authority.slice(AUTHORITY_PREFIX.length + 1);
  if (hex === '' || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new DevContainerError('AUTHORITY_INVALID', 'The remote authority is not valid hex.');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
  } catch (error) {
    throw new DevContainerError('AUTHORITY_INVALID', 'The remote authority is not valid JSON.', {
      cause: error,
    });
  }
  if (typeof payload !== 'object' || payload === null) {
    throw new DevContainerError('AUTHORITY_INVALID', 'The remote authority payload is invalid.');
  }
  const record = payload as Record<string, unknown>;
  if (record['v'] !== 1) {
    throw new DevContainerError('AUTHORITY_INVALID', 'Unsupported remote authority version.');
  }
  const hostPath = record['hostPath'];
  assertPath(hostPath, 'folder path');
  const configFile = record['configFile'];
  if (configFile === undefined) {
    return { hostPath };
  }
  assertPath(configFile, 'configuration path');
  return { hostPath, configFile };
}
