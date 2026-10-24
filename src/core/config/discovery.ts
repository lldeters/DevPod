// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { parseJsonc } from './jsonc';

export type ConfigKind = 'default' | 'root' | 'named';

export interface DiscoveredConfig {
  /** Absolute path of the devcontainer.json file. */
  readonly path: string;
  /** Path relative to the workspace folder, always with forward slashes. */
  readonly relativePath: string;
  readonly kind: ConfigKind;
  /** The `name` property of the file, if it could be read. */
  readonly name?: string;
}

async function isFile(candidate: string): Promise<boolean> {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
}

async function readName(file: string): Promise<string | undefined> {
  try {
    const name = parseJsonc(await readFile(file, 'utf8'), file)['name'];
    return typeof name === 'string' && name.trim() !== '' ? name : undefined;
  } catch {
    return undefined; // an unreadable or invalid file is still listed; it is reported on use
  }
}

/**
 * Finds dev container configurations in a workspace folder, in the order defined by the
 * Development Containers specification:
 *   1. .devcontainer/devcontainer.json
 *   2. .devcontainer.json
 *   3. .devcontainer/<folder>/devcontainer.json (one level deep, alphabetical)
 * All matches are returned so that the caller can ask the user which one to use.
 */
export async function discoverConfigs(workspaceFolder: string): Promise<DiscoveredConfig[]> {
  const found: { file: string; relative: string; kind: ConfigKind }[] = [];

  const defaultFile = path.join(workspaceFolder, '.devcontainer', 'devcontainer.json');
  if (await isFile(defaultFile)) {
    found.push({ file: defaultFile, relative: '.devcontainer/devcontainer.json', kind: 'default' });
  }

  const rootFile = path.join(workspaceFolder, '.devcontainer.json');
  if (await isFile(rootFile)) {
    found.push({ file: rootFile, relative: '.devcontainer.json', kind: 'root' });
  }

  let folders: string[] = [];
  try {
    const entries = await readdir(path.join(workspaceFolder, '.devcontainer'), {
      withFileTypes: true,
    });
    folders = entries
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    // no .devcontainer folder
  }
  for (const folder of folders) {
    const file = path.join(workspaceFolder, '.devcontainer', folder, 'devcontainer.json');
    if (await isFile(file)) {
      found.push({
        file,
        relative: `.devcontainer/${folder}/devcontainer.json`,
        kind: 'named',
      });
    }
  }

  return Promise.all(
    found.map(async ({ file, relative, kind }): Promise<DiscoveredConfig> => {
      const name = await readName(file);
      return {
        path: file,
        relativePath: relative,
        kind,
        ...(name === undefined ? {} : { name }),
      };
    }),
  );
}
