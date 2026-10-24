// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import { levelFilter } from '../core/logger';
import type { LogLevel, Logger } from '../core/logger';

/** Output channel sink; wrap with `filtered()` to honor the logLevel setting. */
export class OutputLogger implements Logger, vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('Kiro Dev Containers');

  log(level: LogLevel, message: string): void {
    const stamp = new Date().toISOString().slice(11, 23);
    this.channel.appendLine(`${stamp} [${level}] ${message}`);
  }

  show(): void {
    this.channel.show(true);
  }

  filtered(max: () => LogLevel): Logger {
    return levelFilter(this, max);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
