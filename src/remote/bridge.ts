// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { execArgs } from '../core/engine/containerEngine';
import type { Logger } from '../core/logger';
import { BRIDGE_SCRIPT } from '../core/server/script';
import type { InstallResult } from '../core/server/script';

export interface BridgeTarget {
  enginePath: string;
  containerId: string;
  user: string;
  server: InstallResult;
}

/**
 * Connects the IDE to the server inside the container without publishing any port: a
 * `docker exec -i` process runs the container's own Node binary, which relays stdio to the
 * server's loopback port. Each call creates one independent connection.
 */
export function createBridge(target: BridgeTarget, logger: Logger): vscode.ManagedMessagePassing {
  const child = spawn(
    target.enginePath,
    execArgs({
      containerId: target.containerId,
      user: target.user,
      interactive: true,
      command: [target.server.node, '-e', BRIDGE_SCRIPT, String(target.server.port)],
    }),
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
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
