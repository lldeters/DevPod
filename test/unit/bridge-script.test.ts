import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BRIDGE_SCRIPT } from '../../src/core/server/script';

let server: net.Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

function listenEcho(): Promise<number> {
  return new Promise((resolve) => {
    server = net.createServer((socket) => socket.pipe(socket));
    server.listen(0, '127.0.0.1', () => resolve((server?.address() as net.AddressInfo).port));
  });
}

describe('BRIDGE_SCRIPT', () => {
  it('relays bytes between stdio and the server port', async () => {
    const port = await listenEcho();
    const child = spawn(process.execPath, ['-e', BRIDGE_SCRIPT, String(port)], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));

    const payload = Buffer.from([0, 1, 2, 255, 254, 10, 13, 65]); // binary-safe, incl. newlines
    child.stdin.write(payload);
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.stdin.end();

    expect(await closed).toBe(0);
    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
  });

  it('delivers everything to a slow reader when the server closes right after writing', async () => {
    const size = 256 * 1024;
    server = net.createServer((socket) => socket.end(Buffer.alloc(size, 97)));
    const port = await new Promise<number>((resolve) =>
      server?.listen(0, '127.0.0.1', () => resolve((server?.address() as net.AddressInfo).port)),
    );
    for (let attempt = 0; attempt < 10; attempt++) {
      const child = spawn(process.execPath, ['-e', BRIDGE_SCRIPT, String(port)], {
        stdio: ['pipe', 'pipe', 'inherit'],
      });
      let received = 0;
      child.stdout.on('data', (chunk: Buffer) => {
        received += chunk.length;
        child.stdout.pause();
        setTimeout(() => child.stdout.resume(), 2);
      });
      const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
      expect(code).toBe(0);
      expect(received).toBe(size);
    }
  });

  it('passes on the end of the input when the first address of the host fails', async () => {
    // As for localhost (::1, then 127.0.0.1) and a service that listens on IPv4 only. The lookup is
    // slow, so the input has ended before the bridge is connected; Node forgets an end() given
    // while it moves on to the next address.
    const dir = await mkdtemp(path.join(tmpdir(), 'dck-bridge-'));
    const preload = path.join(dir, 'two-addresses.cjs');
    await writeFile(
      preload,
      `const dns = require('dns');
const lookup = dns.lookup;
dns.lookup = function (host, options, callback) {
  if (host !== 'two-addresses.test') return lookup.apply(this, arguments);
  const done = typeof options === 'function' ? options : callback;
  const all = [{ address: '127.0.0.2', family: 4 }, { address: '127.0.0.1', family: 4 }];
  setTimeout(() => (options && options.all ? done(null, all) : done(null, all[0].address, 4)), 200);
};
`,
    );
    try {
      // Answers once the input has ended, like a service that reads its input to the end.
      server = net.createServer({ allowHalfOpen: true }, (socket) => {
        const chunks: Buffer[] = [];
        socket.on('data', (chunk: Buffer) => chunks.push(chunk));
        socket.on('end', () => socket.end(Buffer.concat(chunks)));
      });
      const port = await new Promise<number>((resolve) =>
        server?.listen(0, '127.0.0.1', () => resolve((server?.address() as net.AddressInfo).port)),
      );
      const child = spawn(
        process.execPath,
        ['-r', preload, '-e', BRIDGE_SCRIPT, String(port), 'two-addresses.test'],
        { stdio: ['pipe', 'pipe', 'inherit'] },
      );
      const chunks: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
      child.stdin.end('request');
      expect(await closed).toBe(0);
      expect(Buffer.concat(chunks).toString('utf8')).toBe('request');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('exits non-zero when nothing listens on the port', async () => {
    const port = await listenEcho();
    server?.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const child = spawn(process.execPath, ['-e', BRIDGE_SCRIPT, String(port)], { stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(1);
  });

  it('connects to the host given as second argument', async () => {
    const port = await listenEcho();
    const child = spawn(process.execPath, ['-e', BRIDGE_SCRIPT, String(port), 'localhost'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const chunks: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    const closed = new Promise<number | null>((resolve) => child.on('close', resolve));
    child.stdin.write('ping');
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.stdin.end();
    expect(await closed).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe('ping');
  });

  it.each([['0'], ['65536'], ['1.5'], ['abc']])('rejects the port %s', async (port) => {
    const child = spawn(process.execPath, ['-e', BRIDGE_SCRIPT, port], { stdio: 'ignore' });
    expect(await new Promise<number | null>((resolve) => child.on('close', resolve))).toBe(2);
  });

  it('rejects a host that is not a plain name or address', async () => {
    const child = spawn(process.execPath, ['-e', BRIDGE_SCRIPT, '80', 'a b; rm -rf /'], {
      stdio: 'ignore',
    });
    expect(await new Promise<number | null>((resolve) => child.on('close', resolve))).toBe(2);
  });

  it('rejects a non-numeric port argument instead of interpolating it', async () => {
    const child = spawn(process.execPath, ['-e', BRIDGE_SCRIPT, '1; process.exit(0)'], {
      stdio: 'ignore',
    });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(2);
  });
});
