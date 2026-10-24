import { spawn } from 'node:child_process';
import * as net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../src/core/logger';
import { BRIDGE_SCRIPT } from '../../src/core/server/script';
import { normalizeRemoteHost, openTunnel } from '../../src/core/tunnel';
import type { OpenTunnel } from '../../src/core/tunnel';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

/** A bridge spawner that runs the real bridge script locally instead of `docker exec`. */
function localBridge(seen: { host: string; port: number }[] = []) {
  return (host: string, port: number) => {
    seen.push({ host, port });
    return spawn(process.execPath, ['-e', BRIDGE_SCRIPT, String(port), host], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  };
}

function startEcho(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => socket.pipe(socket));
    cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
  });
}

async function roundTrip(port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length >= payload.length) {
        socket.end();
      }
    });
    socket.on('close', () => resolve(Buffer.concat(chunks)));
    socket.on('error', reject);
    socket.on('connect', () => socket.write(payload));
  });
}

async function open(
  remotePort: number,
  preferred?: number,
  seen?: { host: string; port: number }[],
) {
  const tunnel = await openTunnel(
    localBridge(seen),
    { host: 'localhost', port: remotePort },
    preferred,
    new MemoryLogger(),
  );
  cleanups.push(() => tunnel.close());
  return tunnel;
}

describe('normalizeRemoteHost', () => {
  it.each([
    ['localhost', 'localhost'],
    ['127.0.0.1', '127.0.0.1'],
    ['db', 'db'],
    ['my-service.internal', 'my-service.internal'],
    ['::1', '::1'],
    ['0.0.0.0', 'localhost'],
    ['::', 'localhost'],
    ['[::]', 'localhost'],
    ['*', 'localhost'],
    ['', 'localhost'],
    ['  ', 'localhost'],
    ['a b', 'localhost'],
    ['x;rm -rf /', 'localhost'],
    ['h'.repeat(300), 'localhost'],
  ])('%j -> %j', (input, expected) => {
    expect(normalizeRemoteHost(input)).toBe(expected);
  });
});

describe('openTunnel', () => {
  it('relays bytes both ways through the bridge, binary-safe', async () => {
    const remote = await startEcho();
    const tunnel = await open(remote);
    const payload = Buffer.from([0, 1, 2, 255, 254, 10, 13, 65, 66, 67]);
    expect((await roundTrip(tunnel.local.port, payload)).equals(payload)).toBe(true);
  });

  it.each([0, -1, 65536, 1.5, Number.NaN])(
    'refuses to forward the invalid port %s',
    async (port) => {
      await expect(
        openTunnel(localBridge(), { host: 'localhost', port }, undefined, new MemoryLogger()),
      ).rejects.toThrow(/Invalid port/);
    },
  );

  it('binds the loopback interface only', async () => {
    const tunnel = await open(await startEcho());
    expect(tunnel.local.host).toBe('127.0.0.1');
    expect(tunnel.local.port).toBeGreaterThan(0);
  });

  it('serves several connections at once', async () => {
    const tunnel = await open(await startEcho());
    const payloads = [Buffer.from('one'), Buffer.from('two-two'), Buffer.from('three-three-three')];
    const results = await Promise.all(
      payloads.map((payload) => roundTrip(tunnel.local.port, payload)),
    );
    results.forEach((result, index) => expect(result.equals(payloads[index] as Buffer)).toBe(true));
  });

  it('asks the bridge for the normalized host and the requested port', async () => {
    const remote = await startEcho();
    const seen: { host: string; port: number }[] = [];
    const tunnel = await openTunnel(
      localBridge(seen),
      { host: '0.0.0.0', port: remote },
      undefined,
      new MemoryLogger(),
    );
    cleanups.push(() => tunnel.close());
    await roundTrip(tunnel.local.port, Buffer.from('x'));
    expect(seen).toEqual([{ host: 'localhost', port: remote }]);
  });

  it('uses the preferred local port when it is free', async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const free = (probe.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const tunnel = await open(await startEcho(), free);
    expect(tunnel.local.port).toBe(free);
  });

  it('falls back to another local port when the preferred one is taken', async () => {
    const blocker = net.createServer();
    cleanups.push(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const taken = (blocker.address() as net.AddressInfo).port;

    const logger = new MemoryLogger();
    const tunnel = await openTunnel(
      localBridge(),
      { host: 'localhost', port: await startEcho() },
      taken,
      logger,
    );
    cleanups.push(() => tunnel.close());
    expect(tunnel.local.port).not.toBe(taken);
    expect(logger.entries.some((entry) => entry.message.includes('not available'))).toBe(true);
  });

  it('closes the client connection when nothing listens on the remote port', async () => {
    const dead = await new Promise<number>((resolve) => {
      const server = net.createServer();
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as net.AddressInfo;
        server.close(() => resolve(port));
      });
    });
    const tunnel = await open(dead);
    const result = await roundTrip(tunnel.local.port, Buffer.from('hello'));
    expect(result.length).toBe(0);
  });

  it('close() stops the listener and ends open connections', async () => {
    const tunnel: OpenTunnel = await open(await startEcho());
    const socket = net.connect(tunnel.local.port, '127.0.0.1');
    await new Promise<void>((resolve) => socket.on('connect', resolve));
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));

    await tunnel.close();
    await closed;
    await expect(roundTrip(tunnel.local.port, Buffer.from('x'))).rejects.toThrow();
  });
});
