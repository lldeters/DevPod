// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

const order: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

export interface Logger {
  log(level: LogLevel, message: string): void;
}

/** Logger that drops everything. */
export const nullLogger: Logger = { log: () => undefined };

/** Wraps a sink and drops messages that are more verbose than `max`. */
export function levelFilter(sink: Logger, max: () => LogLevel): Logger {
  return {
    log(level, message) {
      if (order[level] <= order[max()]) {
        sink.log(level, message);
      }
    },
  };
}

/** Collects messages in memory; used by tests. */
export class MemoryLogger implements Logger {
  readonly entries: { level: LogLevel; message: string }[] = [];
  log(level: LogLevel, message: string): void {
    this.entries.push({ level, message });
  }
}
