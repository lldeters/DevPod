// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { DevContainerError } from '../errors';

/** Facts about the running IDE that decide which server build the container needs. */
export interface ServerBuildInfo {
  readonly commit: string;
  readonly quality: string;
  readonly version: string;
  /** Name of the server launcher in `<serverDir>/bin/`. */
  readonly serverApplicationName: string;
  /** Folder below $HOME where the server is installed, e.g. `.kiro-server`. */
  readonly serverDataFolderName: string;
  /** Present only if the IDE's product.json declares where server builds can be downloaded. */
  readonly downloadUrlTemplate?: string;
}

function text(product: Record<string, unknown>, key: string): string | undefined {
  const value = product[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Extracts the server build description from the IDE's product.json.
 * `commit` is mandatory: without it (e.g. a development build) no matching server can exist.
 */
export function parseServerBuildInfo(product: unknown): ServerBuildInfo {
  if (typeof product !== 'object' || product === null) {
    throw new DevContainerError('SERVER_UNSUPPORTED', 'product.json is not an object.');
  }
  const record = product as Record<string, unknown>;
  const commit = text(record, 'commit');
  if (!commit) {
    throw new DevContainerError(
      'SERVER_UNSUPPORTED',
      'This IDE build has no commit id in its product.json, so no matching server can be installed.',
    );
  }
  const version = text(record, 'version');
  const serverApplicationName = text(record, 'serverApplicationName');
  const serverDataFolderName = text(record, 'serverDataFolderName');
  if (!version || !serverApplicationName || !serverDataFolderName) {
    throw new DevContainerError(
      'SERVER_UNSUPPORTED',
      'This IDE does not declare remote-server metadata (version, serverApplicationName, ' +
        'serverDataFolderName) in its product.json.',
    );
  }
  const downloadUrlTemplate = text(record, 'serverDownloadUrlTemplate');
  return {
    commit,
    quality: text(record, 'quality') ?? 'stable',
    version,
    serverApplicationName,
    serverDataFolderName,
    ...(downloadUrlTemplate ? { downloadUrlTemplate } : {}),
  };
}
