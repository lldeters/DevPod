import { afterEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { MemoryLogger } from '../../src/core/logger';
import { TunnelHub } from '../../src/remote/tunnelHub';

// Opening a tunnel only starts a local listener; nothing is relayed (and nothing run in the target)
// until a client connects, which these tests never do.
const target = {
  exec: { label: 'test', spec: () => ({ command: 'false', args: [] }) },
  nodePath: 'node',
};

/** What the IDE asks for: any free local port. */
const request = (port: number): vscode.TunnelOptions =>
  ({ remoteAddress: { host: 'localhost', port }, localAddressPort: 0 }) as vscode.TunnelOptions;

const hubs: TunnelHub[] = [];
afterEach(() => {
  hubs.splice(0).forEach((hub) => hub.dispose());
});

function connectedHub(logger: MemoryLogger, limit: number): TunnelHub {
  const hub = new TunnelHub(logger, limit);
  hub.connect(target);
  hubs.push(hub);
  return hub;
}

describe('TunnelHub', () => {
  it('forwards at most the configured number of ports at once', async () => {
    const logger = new MemoryLogger();
    const hub = connectedHub(logger, 2);
    const first = await hub.factory(request(1001));
    await hub.factory(request(1002));
    await expect(hub.factory(request(1003))).rejects.toThrow(/At most 2 ports/);
    expect(logger.entries.some((entry) => entry.level === 'warn')).toBe(true);
    await first.dispose();
    await expect(hub.factory(request(1003))).resolves.toMatchObject({
      remoteAddress: { port: 1003 },
    });
  });

  it('opens configured ports only up to the limit, counting those the IDE asked for', async () => {
    const logger = new MemoryLogger();
    const hub = connectedHub(logger, 2);
    await hub.factory(request(1001));
    const described = await hub.forwardConfigured([
      { host: 'localhost', port: 39101 },
      { host: 'localhost', port: 39102 },
    ]);
    expect(described.map((tunnel) => tunnel.remoteAddress.port)).toEqual([39101]);
    expect(
      logger.entries.some((entry) => entry.message.includes('Forwarding 1 of 2 configured ports')),
    ).toBe(true);
  });
});
