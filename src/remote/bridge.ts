// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import * as vscode from 'vscode';
import type { ExecTarget } from '../core/exec/target';
import type { Logger } from '../core/logger';
import { BRIDGE_SCRIPT } from '../core/server/script';
import type { InstallResult } from '../core/server/script';

/** Where bridge processes run, and which Node binary to run them with. */
export interface BridgeTarget {
  readonly exec: ExecTarget;
  /** The server's bundled Node binary, or `node` from PATH. */
  readonly nodePath: string;
}

/**
 * Starts `<exec> node -e <bridge> <port> [host]`, which relays this process's stdio to a TCP port
 * inside the target (a container or a pod). No port is opened on the host and no shell is involved.
 */
export function spawnBridge(
  target: BridgeTarget,
  port: number,
  host?: string,
): ChildProcessByStdio<Writable, Readable, Readable> {
  const { command, args } = target.exec.spec([
    target.nodePath,
    '-e',
    BRIDGE_SCRIPT,
    String(port),
    ...(host ? [host] : []),
  ]);
  return spawn(command, [...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
}

/**
 * Connects the IDE to the server inside the target. Each call creates one independent
 * connection.
 */
export function createBridge(
  exec: ExecTarget,
  server: InstallResult,
  logger: Logger,
): vscode.ManagedMessagePassing {
  const child = spawnBridge({ exec, nodePath: server.node }, server.port);

  const received = new vscode.EventEmitter<Uint8Array>();
  const closed = new vscode.EventEmitter<Error | undefined>();
  const ended = new vscode.EventEmitter<void>();
  let stderrTail = '';

  child.stdout.on('data', (chunk: Buffer) => received.fire(chunk));
  child.stdout.on('end', () => ended.fire());
  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-2000);
  });
  child.stdin.on('error', () => undefined); // a broken pipe is reported through 'close'
  child.on('error', (error) => closed.fire(error));
  child.on('close', (code) => {
    if (code !== 0) {
      logger.log('warn', `Connection bridge exited with code ${code}. ${stderrTail.trim()}`);
    }
    closed.fire(code === 0 ? undefined : new Error(`Connection to ${exec.label} ended (${code}).`));
    received.dispose();
    closed.dispose();
    ended.dispose();
  });

  return {
    onDidReceiveMessage: received.event,
    onDidClose: closed.event,
    onDidEnd: ended.event,
    send: (data) => {
      child.stdin.write(data);
    },
    end: () => {
      child.stdin.end();
    },
    drain: () =>
      new Promise<void>((resolve) => {
        if (child.stdin.writableNeedDrain) {
          child.stdin.once('drain', () => resolve());
        } else {
          resolve();
        }
      }),
  };
}
