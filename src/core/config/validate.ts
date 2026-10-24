// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import { DevContainerError } from '../errors';
import { discoverConfigs } from './discovery';
import { parseJsonc } from './jsonc';

/**
 * Returns the devcontainer.json that will be used for a folder and checks that it is valid JSONC.
 *
 * The Dev Container CLI silently treats a syntactically broken file as an empty configuration,
 * which later surfaces as a confusing error (or none). Checking here reports the exact position.
 * Without an explicit file the CLI's default lookup is mirrored: `.devcontainer/devcontainer.json`,
 * then `.devcontainer.json`.
 */
export async function resolveAndValidateConfig(
  hostPath: string,
  configFile?: string,
): Promise<string> {
  const file =
    configFile ?? (await discoverConfigs(hostPath)).find((config) => config.kind !== 'named')?.path;
  if (!file) {
    throw new DevContainerError(
      'CONFIG_NOT_FOUND',
      `No devcontainer.json found in ${hostPath} (looked for .devcontainer/devcontainer.json and .devcontainer.json).`,
    );
  }
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new DevContainerError('CONFIG_NOT_FOUND', `Cannot read ${file}.`, { cause: error });
  }
  parseJsonc(text, file);
  return file;
}
