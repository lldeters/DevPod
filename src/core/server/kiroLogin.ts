// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { DevContainerError } from '../errors';

/** Where Kiro keeps its sign-in, relative to the home directory (on this machine and in a container). */
export const KIRO_LOGIN_RELATIVE_PATH = '.aws/sso/cache/kiro-auth-token.json';

/** A sign-in file is a few hundred bytes; anything much larger is not what we expect. */
const MAX_LOGIN_FILE_BYTES = 64 * 1024;

/** Why `text` cannot be Kiro's sign-in file, or `undefined` if it looks like one. */
export function checkLoginFile(text: string): string | undefined {
  if (Buffer.byteLength(text, 'utf8') > MAX_LOGIN_FILE_BYTES) {
    return 'it is larger than expected';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'it is not valid JSON';
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return 'it is not a JSON object';
  }
  return undefined;
}

/**
 * Reads the sign-in file of this machine. Returns `undefined` if there is none or it does not look
 * like one; the reason goes to `report` (a missing file is only worth an `info`, since the user may
 * simply not be signed in here). The content is never logged.
 */
export async function readLocalLoginFile(
  homeDir: string,
  report: (level: 'info' | 'warn', message: string) => void,
): Promise<string | undefined> {
  const file = path.join(homeDir, ...KIRO_LOGIN_RELATIVE_PATH.split('/'));
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      report('info', 'There is no Kiro sign-in on this machine to share.');
    } else {
      report(
        'warn',
        `The Kiro sign-in on this machine could not be read (${path.basename(file)}).`,
      );
    }
    return undefined;
  }
  const problem = checkLoginFile(text);
  if (problem) {
    report('warn', `The Kiro sign-in on this machine is not shared because ${problem}.`);
    return undefined;
  }
  return text;
}

/**
 * Writes `text` below the home directory of the container user unless a non-empty file is already
 * there, and prints `copied`, `exists` or `nohome`. The user's real `$HOME` is used (not the
 * fallback directory the server may live in), and without a writable one nothing is written. The
 * content goes through a quoted here-document on stdin, so the shell never interprets it and it
 * does not appear in a process list. Folders and file are private to the user (700/600), like the
 * ones Kiro creates itself.
 */
export function buildShareLoginScript(text: string): string {
  const delimiter = `DCK_${randomBytes(12).toString('hex')}`;
  if (text.includes(delimiter)) {
    throw new DevContainerError(
      'CONFIG_INVALID',
      'The sign-in text collides with the script delimiter.',
    );
  }
  const body = text.endsWith('\n') ? text : `${text}\n`;
  return [
    'set -eu',
    'umask 077',
    'if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ] || [ ! -w "$HOME" ]; then echo nohome; exit 0; fi',
    `FILE="$HOME/${KIRO_LOGIN_RELATIVE_PATH}"`,
    'if [ -s "$FILE" ]; then echo exists; exit 0; fi',
    'mkdir -p "$(dirname "$FILE")"',
    `cat > "$FILE.tmp" <<'${delimiter}'`,
    `${body}${delimiter}`,
    'chmod 600 "$FILE.tmp"',
    'mv "$FILE.tmp" "$FILE"',
    'echo copied',
    '',
  ].join('\n');
}

export function parseShareLoginResult(stdout: string): 'copied' | 'exists' | 'nohome' {
  const last = stdout.trim().split('\n').at(-1)?.trim();
  if (last === 'copied' || last === 'exists' || last === 'nohome') {
    return last;
  }
  throw new DevContainerError(
    'SERVER_INSTALL_FAILED',
    'Unexpected answer while copying the sign-in.',
  );
}

/**
 * Prints whether the container user already has a sign-in (`exists`), has none (`missing`) or has
 * no writable home directory (`nohome`), by the same rules as the copy script. Used to ask the user
 * only when a copy would actually be made.
 */
export function buildLoginStatusScript(): string {
  return [
    'if [ -z "${HOME:-}" ] || [ ! -d "$HOME" ] || [ ! -w "$HOME" ]; then echo nohome; exit 0; fi',
    `if [ -s "$HOME/${KIRO_LOGIN_RELATIVE_PATH}" ]; then echo exists; else echo missing; fi`,
    '',
  ].join('\n');
}

export function parseLoginStatus(stdout: string): 'exists' | 'missing' | 'nohome' {
  const last = stdout.trim().split('\n').at(-1)?.trim();
  if (last === 'exists' || last === 'missing' || last === 'nohome') {
    return last;
  }
  throw new DevContainerError(
    'SERVER_INSTALL_FAILED',
    'Unexpected answer while looking for a sign-in in the container.',
  );
}
