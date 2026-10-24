import { spawn } from 'node:child_process';
import * as net from 'node:net';
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

  it('exits non-zero when nothing listens on the port', async () => {
    const port = await listenEcho();
    server?.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const child = spawn(process.execPath, ['-e', BRIDGE_SCRIPT, String(port)], { stdio: 'ignore' });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(1);
  });

  it('rejects a non-numeric port argument instead of interpolating it', async () => {
    const child = spawn(process.execPath, ['-e', BRIDGE_SCRIPT, '1; process.exit(0)'], {
      stdio: 'ignore',
    });
    const code = await new Promise<number | null>((resolve) => child.on('close', resolve));
    expect(code).toBe(2);
  });
});
