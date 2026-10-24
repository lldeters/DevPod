// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import type * as vscode from 'vscode';

export interface RebuildRequest {
  readonly noCache: boolean;
}

/**
 * A rebuild is requested in one extension-host run and carried out by the next one, because the
 * window is reloaded in between. The request is persisted and consumed exactly once.
 */
export class RebuildRequests {
  constructor(private readonly state: vscode.Memento) {}

  private key(authority: string): string {
    return `rebuild:${authority}`;
  }

  request(authority: string, request: RebuildRequest): Thenable<void> {
    return this.state.update(this.key(authority), request);
  }

  async take(authority: string): Promise<RebuildRequest | undefined> {
    const request = this.state.get<RebuildRequest>(this.key(authority));
    if (request) {
      await this.state.update(this.key(authority), undefined);
    }
    return request;
  }
}
