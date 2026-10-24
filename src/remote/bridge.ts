// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import * as vscode from 'vscode';
import { execArgs } from '../core/engine/containerEngine';
import type { Logger } from '../core/logger';
import { BRIDGE_SCRIPT } from '../core/server/script';
import type { InstallResult } from '../core/server/script';

/** How to run a process inside the container. */
export interface ContainerTarget {
  enginePath: string;
  containerId: string;
  user: string;
  /** The Node binary to run the bridge with: the server's bundled one, or `node` from PATH. */
  nodePath: string;
}

export interface BridgeTarget {
  enginePath: string;
  containerId: string;
  user: string;
  server: InstallResult;
}

/**
 * Starts `docker exec -i … node -e <bridge> <port> [host]`, which relays this process's stdio to a
 * TCP port inside the container. No port is published on the host and no shell is involved.
 */
export function spawnBridge(
  target: ContainerTarget,
  port: number,
  host?: string,
): ChildProcessByStdio<Writable, Readable, Readable> {
  return spawn(
    target.enginePath,
    execArgs({
      containerId: target.containerId,
      user: target.user,
      interactive: true,
      command: [target.nodePath, '-e', BRIDGE_SCRIPT, String(port), ...(host ? [host] : [])],
    }),
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
}

/**
 * Connects the IDE to the server inside the container. Each call creates one independent
 * connection.
 */
export function createBridge(target: BridgeTarget, logger: Logger): vscode.ManagedMessagePassing {
  const child = spawnBridge(
    {
      enginePath: target.enginePath,
      containerId: target.containerId,
      user: target.user,
      nodePath: target.server.node,
    },
    target.server.port,
  );

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
    closed.fire(code === 0 ? undefined : new Error(`Connection to the container ended (${code}).`));
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
