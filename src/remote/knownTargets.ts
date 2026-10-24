// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import { DevContainerError } from '../core/errors';

const KEY = 'knownTargets';
/** Enough for every folder and pod one uses; the oldest entries are dropped beyond that. */
const LIMIT = 200;

/**
 * Remote authorities that this extension created itself ("Reopen in Container", "Attach to Kiro")
 * or that the user confirmed once. An authority can also come from a link, and resolving it runs
 * the folder's configuration (`initializeCommand` even on this machine) or kubectl with the
 * kubeconfig it names, so an authority that is not known here is confirmed first.
 */
export class KnownTargets {
  constructor(private readonly state: vscode.Memento) {}

  private list(): string[] {
    const value = this.state.get<unknown>(KEY);
    return Array.isArray(value)
      ? value.filter((entry): entry is string => typeof entry === 'string')
      : [];
  }

  has(authority: string): boolean {
    return this.list().includes(authority);
  }

  add(authority: string): Thenable<void> {
    const others = this.list().filter((entry) => entry !== authority);
    return this.state.update(KEY, [authority, ...others].slice(0, LIMIT));
  }
}

/**
 * Resolves only when `authority` is known or the user agrees to open it now; `details` describes
 * the target in words, since the authority itself is unreadable hex. Throws otherwise.
 */
export async function confirmTarget(
  targets: Pick<KnownTargets, 'has' | 'add'>,
  authority: string,
  question: string,
  details: string,
): Promise<void> {
  if (targets.has(authority)) {
    return;
  }
  const open = 'Open';
  const choice = await vscode.window.showWarningMessage(
    question,
    {
      modal: true,
      detail:
        `${details}\n\nThis window was not opened by this extension on this machine, for example ` +
        'because it comes from a link. Only continue if you started this yourself.',
    },
    open,
  );
  if (choice !== open) {
    throw new DevContainerError('TARGET_DECLINED', 'Not opened: the target was not confirmed.');
  }
  await targets.add(authority);
}
