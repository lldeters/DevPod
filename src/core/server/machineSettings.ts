// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';
import { applyEdits, modify, parse } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { DevContainerError } from '../errors';
import { shQuote } from './script';

const SAFE_FOLDER = /^\.?[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Where the IDE server in the container reads machine-wide settings:
 * `<home>/<serverDataFolderName>/data/Machine/settings.json`.
 */
export function machineSettingsPath(home: string, serverDataFolderName: string): string {
  if (!home.startsWith('/') || /[\0\n\r]/.test(home)) {
    throw new DevContainerError(
      'SERVER_UNSUPPORTED',
      'Unusable home directory of the container user.',
    );
  }
  if (!SAFE_FOLDER.test(serverDataFolderName) || serverDataFolderName.includes('..')) {
    throw new DevContainerError('SERVER_UNSUPPORTED', 'Unsafe server data folder name.');
  }
  return `${home.replace(/\/+$/, '')}/${serverDataFolderName}/data/Machine/settings.json`;
}

/**
 * Sets `settings` in a settings.json text. Comments, other keys and formatting are kept; a key
 * from `settings` replaces the same key in the file. An empty file becomes a new document.
 */
export function mergeSettingsText(existing: string, settings: Record<string, unknown>): string {
  const errors: ParseError[] = [];
  parse(existing, errors, { allowTrailingComma: true, allowEmptyContent: true });
  if (errors.length > 0) {
    throw new DevContainerError(
      'CONFIG_INVALID',
      "The container's machine settings.json is not valid JSON, so it was left unchanged.",
    );
  }
  let text = existing.trim() === '' ? '{\n}\n' : existing;
  for (const [key, value] of Object.entries(settings)) {
    text = applyEdits(
      text,
      modify(text, [key], value, { formattingOptions: { insertSpaces: true, tabSize: 4 } }),
    );
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** Prints the file, or nothing if it does not exist. */
export function buildReadSettingsScript(file: string): string {
  return `cat ${shQuote(file)} 2>/dev/null || true\n`;
}

/**
 * Writes `text` to `file` (creating its folder) through a quoted here-document, so the content is
 * never interpreted by the shell. The write is atomic: a temporary file is renamed into place.
 */
export function buildWriteSettingsScript(file: string, text: string): string {
  const delimiter = `DCK_${randomBytes(12).toString('hex')}`;
  if (text.includes(delimiter)) {
    throw new DevContainerError(
      'CONFIG_INVALID',
      'Settings text collides with the script delimiter.',
    );
  }
  const body = text.endsWith('\n') ? text : `${text}\n`;
  return [
    'set -eu',
    'umask 022',
    `FILE=${shQuote(file)}`,
    'mkdir -p "$(dirname "$FILE")"',
    `cat > "$FILE.tmp" <<'${delimiter}'`,
    `${body}${delimiter}`,
    'mv "$FILE.tmp" "$FILE"',
    '',
  ].join('\n');
}
