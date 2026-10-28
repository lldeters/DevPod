// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import type * as vscode from 'vscode';

const KEY = 'podKubectlPaths';
/** As many as there are known targets; the oldest entries are dropped beyond that. */
const LIMIT = 200;

type Entry = readonly [authority: string, kubectl: string];

/**
 * The Kubernetes extension's kubectl path at the time a pod window was attached, per authority.
 * That setting has scope `machine`, so the IDE hides it in a pod window in which the Kubernetes
 * extension runs too, and reconnecting would fall back to `kubectl` from PATH. The path is kept on
 * this machine only, never in the authority: an authority can come from a link, and which program
 * runs here must not.
 */
export class PodKubectlPaths {
  constructor(private readonly state: vscode.Memento) {}

  private entries(): Entry[] {
    const value = this.state.get<unknown>(KEY);
    return Array.isArray(value)
      ? value.filter(
          (entry: unknown): entry is Entry =>
            Array.isArray(entry) &&
            entry.length === 2 &&
            typeof entry[0] === 'string' &&
            typeof entry[1] === 'string' &&
            entry[1] !== '',
        )
      : [];
  }

  get(authority: string): string | undefined {
    return this.entries().find(([key]) => key === authority)?.[1];
  }

  /** Records `kubectl` for `authority`, or forgets what was recorded when there is none. */
  set(authority: string, kubectl: string | undefined): Thenable<void> {
    const others = this.entries().filter(([key]) => key !== authority);
    const entries = kubectl ? [[authority, kubectl] as const, ...others] : others;
    return this.state.update(KEY, entries.slice(0, LIMIT));
  }
}
