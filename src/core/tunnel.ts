// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcessByStdio } from 'node:child_process';
import * as net from 'node:net';
import type { Readable, Writable } from 'node:stream';
import type { Logger } from './logger';

export interface TunnelEndpoint {
  readonly host: string;
  readonly port: number;
}

export interface OpenTunnel {
  /** Where the tunnel listens on this machine (always loopback). */
  readonly local: TunnelEndpoint;
  /** How many connections are open right now; for diagnostics and tests. */
  connections(): number;
  close(): Promise<void>;
}

/** How long a connection may stay open after its relay ended, if the client does not close it. */
const LINGER_MS = 60_000;

/** Starts a process that relays its stdio to `host:port` as seen from inside the container. */
export type BridgeSpawner = (
  host: string,
  port: number,
) => ChildProcessByStdio<Writable, Readable, Readable>;

/**
 * The IDE may ask for the wildcard address or an odd host string. Anything that is not a plain
 * host name or address means "the container itself".
 */
export function normalizeRemoteHost(host: string): string {
  const trimmed = host.trim();
  if (trimmed === '' || ['0.0.0.0', '::', '[::]', '*'].includes(trimmed)) {
    return 'localhost';
  }
  return /^[A-Za-z0-9._:-]{1,253}$/.test(trimmed) ? trimmed : 'localhost';
}

function listen(server: net.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/**
 * Forwards a port of the container to this machine. A local TCP server accepts connections; each
 * one is relayed through its own bridge process (`docker exec` into the container). Only the
 * loopback interface is bound, so forwarded ports are not reachable from the network.
 *
 * The preferred local port is used when free; otherwise a free one is chosen.
 */
export async function openTunnel(
  spawnBridge: BridgeSpawner,
  remote: TunnelEndpoint,
  preferredLocalPort: number | undefined,
  logger: Logger,
): Promise<OpenTunnel> {
  if (!Number.isInteger(remote.port) || remote.port < 1 || remote.port > 65535) {
    throw new RangeError(`Invalid port to forward: ${remote.port}`);
  }
  const sockets = new Set<net.Socket>();
  const children = new Set<ChildProcessByStdio<Writable, Readable, Readable>>();
  const host = normalizeRemoteHost(remote.host);
  let refusalReported = false;

  // allowHalfOpen: a client may end its side once it has sent a request and still read the answer.
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    const child = spawnBridge(host, remote.port);
    children.add(child);
    let stderrTail = '';

    const finish = (): void => {
      sockets.delete(socket);
      socket.destroy();
      children.delete(child);
      child.kill();
    };

    child.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-500);
    });
    child.stdin.on('error', () => undefined);
    socket.on('error', finish);
    socket.on('close', finish);
    child.on('error', finish);
    child.on('close', (code) => {
      if (code !== 0 && code !== null) {
        // The first failure per tunnel is worth showing; a client that keeps retrying is not.
        logger.log(
          refusalReported ? 'debug' : 'info',
          `Port ${host}:${remote.port} refused the connection (exit ${code}). ${stderrTail.trim()}`,
        );
        refusalReported = true;
      }
      // The relay has ended. The socket still sends what it has buffered and is cleaned up by its
      // own 'close'; destroying it now would cut off the end of a response to a slow reader. What
      // the client still sends goes nowhere: it is read away, so that the client's end is noticed
      // (the stdin pipe would pause the socket instead). A client that never closes is let go of
      // after a while.
      children.delete(child);
      socket.unpipe(child.stdin);
      socket.resume();
      socket.end();
      const linger = setTimeout(() => socket.destroy(), LINGER_MS);
      linger.unref();
      socket.once('close', () => clearTimeout(linger));
    });
    socket.pipe(child.stdin);
    child.stdout.pipe(socket);
  });

  try {
    await listen(server, preferredLocalPort ?? 0);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (preferredLocalPort === undefined || (code !== 'EADDRINUSE' && code !== 'EACCES')) {
      throw error;
    }
    logger.log('info', `Local port ${preferredLocalPort} is not available; choosing another one.`);
    await listen(server, 0);
  }

  // A later server error (for example running out of file descriptors) must not become an uncaught
  // exception in the extension host.
  server.on('error', (error) => {
    logger.log('warn', `Forwarding of ${host}:${remote.port} failed: ${error.message}`);
  });

  const { port } = server.address() as net.AddressInfo;
  return {
    local: { host: '127.0.0.1', port },
    connections: () => sockets.size,
    close: async () => {
      for (const child of children) {
        child.kill();
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
