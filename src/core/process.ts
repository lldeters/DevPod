// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Called for every complete stdout line (without the line terminator). */
  onStdoutLine?: (line: string) => void;
  /** Called for every complete stderr line (without the line terminator). */
  onStderrLine?: (line: string) => void;
  signal?: AbortSignal;
  /** Data written to stdin before it is closed. */
  stdin?: string;
}

export interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Splits a stream of chunks into lines and invokes `onLine` for each complete line. */
export function lineSplitter(onLine: (line: string) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = '';
  return {
    push(chunk) {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, index).replace(/\r$/, ''));
        buffer = buffer.slice(index + 1);
      }
    },
    flush() {
      if (buffer.length > 0) {
        onLine(buffer.replace(/\r$/, ''));
        buffer = '';
      }
    },
  };
}

/**
 * Runs a program without a shell and resolves when it exits.
 * Rejects only if the process cannot be started; a non-zero exit code is reported in the result.
 */
export function runProcess(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      signal: options.signal,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const outLines = lineSplitter((line) => options.onStdoutLine?.(line));
    const errLines = lineSplitter((line) => options.onStderrLine?.(line));

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      outLines.push(chunk);
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
      errLines.push(chunk);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      outLines.flush();
      errLines.flush();
      resolve({ code, signal, stdout, stderr });
    });

    child.stdin.on('error', () => undefined); // process may exit before reading stdin
    child.stdin.end(options.stdin ?? '');
  });
}
