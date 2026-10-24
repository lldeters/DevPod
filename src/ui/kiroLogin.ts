// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as os from 'node:os';
import * as vscode from 'vscode';
import type { Logger } from '../core/logger';
import { readLocalLoginFile } from '../core/server/kiroLogin';
import type { KiroLoginShare } from '../core/server/provisioner';
import { readSettings } from './settings';

/** Asks whether this machine's Kiro sign-in may be copied into `target` (e.g. "the pod dev/web"). */
export async function askToShareKiroLogin(target: string): Promise<boolean> {
  const copy = 'Copy Sign-In';
  const choice = await vscode.window.showWarningMessage(
    `Copy your Kiro sign-in into ${target}?`,
    {
      modal: true,
      detail:
        'Kiro there will then not ask you to sign in. The copy is a credential in the container: ' +
        'everyone who can run commands there can read it, and it shares one session with this ' +
        'machine. Nothing is copied back, and a sign-in that is already there is never replaced.' +
        '\n\nYou are asked on every connection while the container has no sign-in. Set ' +
        '"dev.containers.shareKiroLogin" to "always" or "never" to decide once.',
    },
    copy,
  );
  return choice === copy;
}

/**
 * The sign-in to offer to `target`, read fresh for every connection, with a question unless the
 * user shares it always. `undefined` if it is never shared or there is none on this machine.
 */
export async function kiroLoginFor(
  target: string,
  logger: Logger,
): Promise<KiroLoginShare | undefined> {
  const mode = readSettings().shareKiroLogin;
  if (mode === 'never') {
    return undefined;
  }
  const text = await readLocalLoginFile(os.homedir(), (level, message) =>
    logger.log(level, message),
  );
  if (text === undefined) {
    return undefined;
  }
  return mode === 'ask' ? { text, confirm: () => askToShareKiroLogin(target) } : { text };
}
