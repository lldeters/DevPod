// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import type * as vscode from 'vscode';

export interface RebuildRequest {
  readonly noCache: boolean;
}

interface StoredRequest extends RebuildRequest {
  readonly requestedAt: number;
}

/**
 * How long a request waits for the reload that carries it out. Long enough to start Docker after a
 * failed attempt and retry; a request older than this is dropped, so that opening the folder days
 * later does not remove its container unexpectedly.
 */
export const REBUILD_REQUEST_MAX_AGE_MS = 15 * 60 * 1000;

/**
 * A rebuild is requested in one extension-host run and carried out by the next one, because the
 * window is reloaded in between. The request is persisted and consumed exactly once.
 */
export class RebuildRequests {
  constructor(
    private readonly state: vscode.Memento,
    private readonly now: () => number = Date.now,
  ) {}

  private key(authority: string): string {
    return `rebuild:${authority}`;
  }

  request(authority: string, request: RebuildRequest): Thenable<void> {
    const stored: StoredRequest = { noCache: request.noCache, requestedAt: this.now() };
    return this.state.update(this.key(authority), stored);
  }

  async take(authority: string): Promise<RebuildRequest | undefined> {
    const stored = this.state.get<Partial<StoredRequest>>(this.key(authority));
    if (!stored) {
      return undefined;
    }
    await this.state.update(this.key(authority), undefined);
    const age = this.now() - (stored.requestedAt ?? Number.NEGATIVE_INFINITY);
    return age >= 0 && age <= REBUILD_REQUEST_MAX_AGE_MS
      ? { noCache: stored.noCache === true }
      : undefined;
  }
}
