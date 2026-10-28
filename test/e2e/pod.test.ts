// End-to-end test against a real Kubernetes cluster (CI creates one with kind). It runs only when
// DCK_E2E_K8S=1 and the current kubectl context points at a throw-away cluster: it creates and
// deletes a pod in the `default` namespace.
//
// It covers what the stand-in based tests cannot: real `kubectl exec` streaming, how a real pod
// reports its containers, installing a server in a pod and relaying a port out of it.
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkContainerRunning } from '../../src/core/k8s/attach';
import { Kubectl, KubectlExecutor, kubectlExecArgs } from '../../src/core/k8s/kubectl';
import type { PodRef } from '../../src/core/k8s/podRef';
import { MemoryLogger } from '../../src/core/logger';
import { provisionServer } from '../../src/core/server/provisioner';
import { BRIDGE_SCRIPT } from '../../src/core/server/script';
import { openTunnel } from '../../src/core/tunnel';

const enabled = process.env['DCK_E2E_K8S'] === '1';
const POD = 'dck-e2e';

function kubectl(...args: string[]): string {
  return execFileSync('kubectl', args, { encoding: 'utf8' });
}

describe.skipIf(!enabled)('Kubernetes pod end to end', () => {
  let root: string;
  let ref: PodRef;
  const logger = new MemoryLogger();
  const client = new Kubectl(
    () => ({ kubectl: 'kubectl' }),
    () => ({}),
  );

  beforeAll(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), 'dck-k8s-')));

    // A fake IDE server: records its arguments, then runs an echo server that announces its port.
    // The pod's own `node` runs it, as it will run the bridge.
    const top = path.join(root, 'src', 'fake-server-linux-x64');
    await mkdir(path.join(top, 'bin'), { recursive: true });
    await writeFile(
      path.join(top, 'server.js'),
      [
        "const net = require('net');",
        'const server = net.createServer((s) => s.pipe(s));',
        "server.listen(0, '127.0.0.1', () => {",
        "  console.log('Extension host agent listening on ' + server.address().port);",
        '});',
      ].join('\n'),
    );
    const launcher = path.join(top, 'bin', 'fake-server');
    await writeFile(
      launcher,
      '#!/bin/sh\nD="$(dirname "$0")/.."\nprintf \'%s\\n\' "$@" > "$D/args.txt"\nexec node "$D/server.js"\n',
    );
    await chmod(launcher, 0o755);
    execFileSync('tar', [
      '-czf',
      path.join(root, 'server.tar.gz'),
      '-C',
      path.join(root, 'src'),
      'fake-server-linux-x64',
    ]);

    const context = kubectl('config', 'current-context').trim();
    ref = { context, namespace: 'default', pod: POD, container: POD };

    kubectl(
      'run',
      POD,
      '--image=mcr.microsoft.com/devcontainers/javascript-node:22',
      '--restart=Never',
      '--command',
      '--',
      'sleep',
      '3600',
    );
    kubectl('wait', '--for=condition=Ready', `pod/${POD}`, '--timeout=300s');
    kubectl('cp', path.join(root, 'server.tar.gz'), `${POD}:/tmp/server.tar.gz`);
  }, 420_000);

  afterAll(async () => {
    if (enabled) {
      try {
        kubectl('delete', 'pod', POD, '--now', '--wait=false', '--ignore-not-found');
      } catch {
        // the cluster is thrown away anyway
      }
    }
    await rm(root, { recursive: true, force: true });
  });

  it('lists what the attach picker offers: contexts, namespaces, pods', async () => {
    expect(await client.currentContext()).toBe(ref.context);
    expect(await client.contexts()).toContain(ref.context);
    expect(await client.namespaces(ref.context)).toContain('default');
    expect(await client.pods(ref.context, 'default')).toContain(POD);
  });

  it('describes the running pod and accepts its container', async () => {
    const info = await client.pod(ref);
    expect(info.phase).toBe('Running');
    expect(info.containers).toEqual([{ name: POD, ready: true, running: true }]);
    expect(() => checkContainerRunning(info, POD)).not.toThrow();
    expect(() => checkContainerRunning(info, 'nope')).toThrowError(/no container "nope"/);
  });

  it('reports no current context and no contexts when kubectl finds no kubeconfig', async () => {
    const empty = new Kubectl(
      () => ({ kubectl: 'kubectl' }),
      () => ({ kubeconfig: path.join(root, 'no-such-kubeconfig') }),
    );
    expect(await empty.currentContext()).toBeUndefined();
    expect(await empty.contexts()).toEqual([]);
  });

  it('reports a pod that does not exist', async () => {
    await expect(client.pod({ ...ref, pod: 'does-not-exist' })).rejects.toThrow(
      /NotFound|not found/i,
    );
  });

  it('installs the server in the pod, reuses it, and relays a port out of it', async () => {
    const executor = new KubectlExecutor(() => ({ kubectl: 'kubectl' }), ref);
    const input = {
      containerId: `${ref.namespace}/${ref.pod}`,
      urlTemplate: 'file:///tmp/server.tar.gz',
      extensions: ['esbenp.prettier-vscode'],
      kiroLogin: '{"accessToken":"e2e-login"}',
      build: {
        commit: 'k8se2e',
        quality: 'stable',
        version: '0.0.0',
        serverApplicationName: 'fake-server',
        serverDataFolderName: '.k8s-e2e-server',
      },
    };

    const server = await provisionServer(executor, input, logger);
    expect(server.port).toBeGreaterThan(0);
    expect(server.token).toMatch(/^[0-9a-f]{48}$/);

    // the server was started with the extension, and its token is not on the command line
    const args = execFileSync(
      'kubectl',
      ['exec', POD, '--', 'cat', `${server.serverDir}/args.txt`],
      { encoding: 'utf8' },
    );
    expect(args.split('\n')).toEqual(
      expect.arrayContaining(['--start-server', '--install-extension', 'esbenp.prettier-vscode']),
    );
    expect(args).not.toContain(server.token);

    // the Kiro sign-in landed in the home directory of the pod user, private to that user
    const login = execFileSync(
      'kubectl',
      [
        'exec',
        POD,
        '--',
        'sh',
        '-c',
        'cat "$HOME/.aws/sso/cache/kiro-auth-token.json"; stat -c "%a" "$HOME/.aws/sso/cache/kiro-auth-token.json"',
      ],
      { encoding: 'utf8' },
    );
    expect(login.trim().split('\n')).toEqual(['{"accessToken":"e2e-login"}', '600']);

    // a second call reuses the running server
    expect(await provisionServer(executor, input, logger)).toEqual(server);

    // the port can be reached from this machine through kubectl exec
    const tunnel = await openTunnel(
      (host, port) =>
        spawn(
          'kubectl',
          kubectlExecArgs(ref, [server.node, '-e', BRIDGE_SCRIPT, String(port), host]),
          {
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        ),
      { host: '127.0.0.1', port: server.port },
      undefined,
      logger,
    );
    try {
      const echoed = await new Promise<string>((resolve, reject) => {
        const socket = net.connect(tunnel.local.port, '127.0.0.1');
        let received = '';
        socket.on('data', (chunk) => {
          received += chunk.toString();
          if (received.length >= 'hello pod'.length) socket.end();
        });
        socket.on('close', () => resolve(received));
        socket.on('error', reject);
        socket.on('connect', () => socket.write('hello pod'));
      });
      expect(echoed).toBe('hello pod');
    } finally {
      await tunnel.close();
    }
  }, 300_000);
});
