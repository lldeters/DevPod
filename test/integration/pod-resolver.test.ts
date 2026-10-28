// The whole path into a pod, with a local stand-in for it: `kubectl exec` (see
// test/helpers/kubectlStub.ts) runs the command locally. Provisioning installs a fake IDE server
// (an echo server) from a tarball, starts it, and the connection and port tunnels talk to it
// through the very same bridge processes that run inside a real pod.
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import * as net from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { Kubectl } from '../../src/core/k8s/kubectl';
import { encodePodAuthority } from '../../src/core/k8s/podRef';
import type { PodRef } from '../../src/core/k8s/podRef';
import { MemoryLogger } from '../../src/core/logger';
import { KnownTargets } from '../../src/remote/knownTargets';
import { PodResolver } from '../../src/remote/podResolver';
import { askToShareKiroLogin } from '../../src/ui/kiroLogin';
import { callLikeTheIde } from '../helpers/ide';
import * as mock from '../helpers/vscodeMock';
import { createKubectlStub, podJson } from '../helpers/kubectlStub';
import type { KubectlStub } from '../helpers/kubectlStub';

const { state } = mock;
/** For tests about what happens after a target is confirmed. */
const allKnown = { has: () => true, add: async () => undefined };

const hasTools = ['sh', 'curl', 'tar'].every(
  (tool) => spawnSync('sh', ['-c', `command -v ${tool}`]).status === 0,
);

const ref: PodRef = { context: 'kind-test', namespace: 'dev', pod: 'mypod', container: 'app' };
const build = {
  commit: 'abc123',
  quality: 'stable',
  version: '1.0.0',
  serverApplicationName: 'fake-server',
  serverDataFolderName: '.pod-test-server',
};

type Resolved = mock.ManagedResolvedAuthority & { environmentTunnels: unknown[] };

describe.skipIf(process.platform === 'win32' || !hasTools)(
  'PodResolver (local stand-in for a pod)',
  () => {
    let root: string;
    let home: string;
    let archive: string;
    let stub: KubectlStub;
    const cleanups: (() => Promise<void> | void)[] = [];

    beforeAll(async () => {
      root = await realpath(await mkdtemp(path.join(tmpdir(), 'dck-pod-')));
      home = path.join(root, 'podhome');
      await mkdir(home);
      stub = await createKubectlStub(root);

      // A fake IDE server: records its arguments, then runs an echo server that announces its port.
      const top = path.join(root, 'src', 'fake-server-linux-x64');
      await mkdir(path.join(top, 'bin'), { recursive: true });
      await symlink(process.execPath, path.join(top, 'node'));
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
        [
          '#!/bin/sh',
          'D="$(dirname "$0")/.."',
          'printf \'%s\\n\' "$@" > "$D/args.txt"',
          'exec "$D/node" "$D/server.js"',
          '',
        ].join('\n'),
      );
      await chmod(launcher, 0o755);
      archive = path.join(root, 'server.tar.gz');
      execFileSync('tar', ['-czf', archive, '-C', path.join(root, 'src'), 'fake-server-linux-x64']);

      process.env['KUBECTL_STUB_DIR'] = stub.dir;
      process.env['KUBECTL_STUB_HOME'] = home;
    });

    afterAll(async () => {
      delete process.env['KUBECTL_STUB_DIR'];
      delete process.env['KUBECTL_STUB_HOME'];
      await rm(root, { recursive: true, force: true });
    });

    beforeEach(async () => {
      mock.reset();
      await stub.reset();
      await stub.set('pod.json', podJson());
    });

    afterEach(async () => {
      while (cleanups.length > 0) await cleanups.pop()?.();
      try {
        const pid = (
          await readFile(path.join(home, '.pod-test-server', 'server-abc123.pid'), 'utf8')
        ).trim();
        process.kill(Number(pid), 'SIGKILL');
      } catch {
        // no server was started
      }
      await rm(path.join(home, '.pod-test-server'), { recursive: true, force: true });
      await rm(path.join(home, '.aws'), { recursive: true, force: true });
    });

    function createResolver(options: { kiroLogin?: string; ask?: boolean } = {}): {
      resolver: PodResolver;
      logger: MemoryLogger;
    } {
      const logger = new MemoryLogger();
      const resolver = new PodResolver({
        logger,
        kubectl: new Kubectl(
          () => ({ kubectl: stub.path }),
          () => ({}),
        ),
        kubectlLauncher: () => ({ kubectl: stub.path }),
        targets: allKnown,
        serverBuild: async () => build,
        serverUrlTemplate: () => `file://${archive}`,
        kiroLogin: async (target) =>
          options.kiroLogin === undefined
            ? undefined
            : {
                text: options.kiroLogin,
                ...(options.ask ? { confirm: () => askToShareKiroLogin(target) } : {}),
              },
      });
      cleanups.push(() => resolver.dispose());
      return { resolver, logger };
    }

    function startEcho(): Promise<number> {
      return new Promise((resolve) => {
        const server = net.createServer((socket) => socket.pipe(socket));
        cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
        server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
      });
    }

    async function echoThrough(port: number, text: string): Promise<string> {
      return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        let received = '';
        socket.on('data', (chunk) => {
          received += chunk.toString();
          if (received.length >= text.length) socket.end();
        });
        socket.on('close', () => resolve(received));
        socket.on('error', reject);
        socket.on('connect', () => socket.write(text));
      });
    }

    it('installs and starts the server in the pod through kubectl exec and returns its token', async () => {
      const { resolver } = createResolver();
      const resolved = (await resolver.resolve(encodePodAuthority(ref))) as unknown as Resolved;

      expect(resolved).toBeInstanceOf(mock.ManagedResolvedAuthority);
      expect(resolved.connectionToken).toMatch(/^[0-9a-f]{48}$/);
      expect(resolved.environmentTunnels).toEqual([]);

      // everything went through kubectl exec into the chosen container, as the chosen context
      const execs = (await stub.calls()).filter((args) => args.includes('exec'));
      expect(execs.length).toBeGreaterThanOrEqual(2); // platform detection and installation
      for (const args of execs) {
        expect(args).toEqual(
          expect.arrayContaining([
            '--context=kind-test',
            '--namespace=dev',
            '--container=app',
            'mypod',
            '--',
          ]),
        );
        expect(args.slice(args.indexOf('--') + 1)).toEqual(['sh', '-s']);
      }

      const args = await readFile(
        path.join(home, '.pod-test-server', 'bin', 'abc123', 'args.txt'),
        'utf8',
      );
      expect(args.split('\n')).toEqual(
        expect.arrayContaining(['--start-server', '--host=127.0.0.1']),
      );
      expect(args).not.toContain(resolved.connectionToken as string); // token travels as a file
    });

    it('connects to the server inside the pod through a bridge', async () => {
      const { resolver } = createResolver();
      const resolved = (await resolver.resolve(encodePodAuthority(ref))) as unknown as Resolved;

      const connection = (await resolved.makeConnection()) as {
        onDidReceiveMessage: (listener: (data: Uint8Array) => void) => unknown;
        send: (data: Uint8Array) => void;
        end: () => void;
      };
      const echoed = new Promise<string>((resolve) => {
        connection.onDidReceiveMessage((data) => resolve(Buffer.from(data).toString()));
      });
      connection.send(Buffer.from('hello pod'));
      expect(await echoed).toBe('hello pod');
      connection.end();
    });

    it('reuses the running server when the window reconnects', async () => {
      const { resolver } = createResolver();
      const first = (await resolver.resolve(encodePodAuthority(ref))) as unknown as Resolved;
      await rm(archive, { force: true }); // a second download would fail
      const second = (await resolver.resolve(encodePodAuthority(ref))) as unknown as Resolved;
      expect(second.connectionToken).toBe(first.connectionToken);
      execFileSync('tar', ['-czf', archive, '-C', path.join(root, 'src'), 'fake-server-linux-x64']); // restore
    });

    it('forwards ports of the pod to localhost through kubectl exec', async () => {
      const remote = await startEcho();
      const { resolver } = createResolver();
      await resolver.resolve(encodePodAuthority(ref));

      const tunnel = await callLikeTheIde(resolver.tunnelFactory, {
        remoteAddress: { host: 'localhost', port: remote },
      });
      const local = (tunnel.localAddress as { port: number }).port;
      expect(await echoThrough(local, 'through kubectl')).toBe('through kubectl');

      // the bridge ran in the pod, with the pod's Node and the requested port and host
      const bridges = (await stub.calls()).filter((args) => args.includes('-e'));
      const last = bridges.at(-1) ?? [];
      expect(last.slice(-2)).toEqual([String(remote), 'localhost']);
      expect(last).toEqual(expect.arrayContaining(['--container=app', 'mypod']));
      await tunnel.dispose();
    });

    describe('sharing the Kiro sign-in', () => {
      const loginFile = () => path.join(home, '.aws', 'sso', 'cache', 'kiro-auth-token.json');
      const login = '{"accessToken":"SECRET-ACCESS"}';

      it('copies it into the pod through kubectl exec, privately and only once', async () => {
        const { resolver, logger } = createResolver({ kiroLogin: login });
        await resolver.resolve(encodePodAuthority(ref));

        expect((await readFile(loginFile(), 'utf8')).trim()).toBe(login);
        expect((await stat(loginFile())).mode & 0o777).toBe(0o600);
        expect(logger.entries.map((e) => e.message)).toContain(
          'Copied the Kiro sign-in of this machine into the container.',
        );

        // a later connection never replaces what the pod has
        await writeFile(loginFile(), '{"fresher":"login made in the pod"}');
        const again = createResolver({ kiroLogin: login });
        await again.resolver.resolve(encodePodAuthority(ref));
        expect(await readFile(loginFile(), 'utf8')).toBe('{"fresher":"login made in the pod"}');
        expect(again.logger.entries.map((e) => e.message)).toContain(
          'The container already has a Kiro sign-in; it was left unchanged.',
        );
        expect(JSON.stringify([...logger.entries, ...again.logger.entries])).not.toContain(
          'SECRET-ACCESS',
        );
      });

      it('asks first by default, and copies only when the user agrees', async () => {
        const declined = createResolver({ kiroLogin: login, ask: true });
        await declined.resolver.resolve(encodePodAuthority(ref));
        expect(state.warnings.map((w) => w.message)).toEqual([
          'Copy your Kiro sign-in into the pod dev/mypod?',
        ]);
        await expect(stat(loginFile())).rejects.toThrow();
        expect(declined.logger.entries.map((e) => e.message)).toContain(
          'The Kiro sign-in was not copied into the container (not confirmed).',
        );

        // asked again on the next connection, since the pod still has no sign-in
        state.answerWarning = (message) =>
          message.startsWith('Copy your Kiro') ? 'Copy Sign-In' : undefined;
        const agreed = createResolver({ kiroLogin: login, ask: true });
        await agreed.resolver.resolve(encodePodAuthority(ref));
        expect(state.warnings).toHaveLength(2);
        expect((await readFile(loginFile(), 'utf8')).trim()).toBe(login);

        // no question once the pod has a sign-in
        const later = createResolver({ kiroLogin: login, ask: true });
        await later.resolver.resolve(encodePodAuthority(ref));
        expect(state.warnings).toHaveLength(2);
      });

      it('leaves the pod alone unless the sign-in is shared', async () => {
        const { resolver } = createResolver();
        await resolver.resolve(encodePodAuthority(ref));
        await expect(stat(loginFile())).rejects.toThrow();
      });
    });

    it('refuses tunnels before the pod is attached', async () => {
      const { resolver } = createResolver();
      await expect(
        callLikeTheIde(resolver.tunnelFactory, {
          remoteAddress: { host: 'localhost', port: 3000 },
        }),
      ).rejects.toThrow(/not connected/);
    });

    it('uses the kubeconfig stored in the connection for every kubectl call', async () => {
      const { resolver } = createResolver();
      await resolver.resolve(encodePodAuthority({ ...ref, kubeconfig: '/home/me/.kube/other' }));
      const calls = await stub.calls();
      expect(calls.length).toBeGreaterThan(2);
      expect(calls.every((args) => args.includes('--kubeconfig=/home/me/.kube/other'))).toBe(true);
    });

    it('refuses a pod that is not running before running anything in it', async () => {
      await stub.set(
        'pod.json',
        podJson({ phase: 'Pending', containers: [{ name: 'app', running: false }] }),
      );
      const { resolver } = createResolver();
      await expect(resolver.resolve(encodePodAuthority(ref))).rejects.toMatchObject({
        kind: 'NotAvailable',
        message: expect.stringMatching(/not running \(status: Pending\)/),
      });
      expect((await stub.calls()).some((args) => args.includes('exec'))).toBe(false);
    });

    it('names the containers when the chosen one does not exist', async () => {
      await stub.set('pod.json', podJson({ containers: [{ name: 'web', running: true }] }));
      const { resolver } = createResolver();
      await expect(resolver.resolve(encodePodAuthority(ref))).rejects.toMatchObject({
        message: expect.stringMatching(/no container "app"\. Containers: web/),
      });
    });

    it('reports a pod that is gone, with what kubectl said', async () => {
      await stub.unset('pod.json');
      const { resolver } = createResolver();
      await expect(resolver.resolve(encodePodAuthority(ref))).rejects.toMatchObject({
        kind: 'NotAvailable',
        message: expect.stringContaining('NotFound'),
      });
    });

    it('asks before attaching to a pod it did not open itself, without calling kubectl', async () => {
      const logger = new MemoryLogger();
      const resolver = new PodResolver({
        logger,
        kubectl: new Kubectl(
          () => ({ kubectl: stub.path }),
          () => ({}),
        ),
        kubectlLauncher: () => ({ kubectl: stub.path }),
        targets: new KnownTargets(new mock.MockMemento() as unknown as vscode.Memento),
        serverBuild: async () => build,
        serverUrlTemplate: () => `file://${archive}`,
        kiroLogin: async () => undefined,
      });
      cleanups.push(() => resolver.dispose());
      const linked = encodePodAuthority({ ...ref, kubeconfig: '/home/someone/Downloads/config' });

      await expect(resolver.resolve(linked)).rejects.toMatchObject({ kind: 'NotAvailable' });
      expect(state.warnings[0]?.message).toBe('Attach to the pod dev/mypod?');
      expect(state.warnings[0]?.detail).toContain('kubeconfig: /home/someone/Downloads/config');
      expect(await stub.calls()).toEqual([]);
    });

    it('names the WSL distribution when asking, and runs every kubectl call there', async () => {
      const logger = new MemoryLogger();
      const launched: unknown[] = [];
      const launcher = (wsl: unknown) => {
        launched.push(wsl);
        return { kubectl: stub.path }; // the stub stands in for kubectl in WSL
      };
      const resolver = new PodResolver({
        logger,
        kubectl: new Kubectl(launcher, () => ({})),
        kubectlLauncher: launcher,
        targets: new KnownTargets(new mock.MockMemento() as unknown as vscode.Memento),
        serverBuild: async () => build,
        serverUrlTemplate: () => `file://${archive}`,
        kiroLogin: async () => undefined,
      });
      cleanups.push(() => resolver.dispose());
      const wsl = { distro: 'Ubuntu-24.04' };
      const linked = encodePodAuthority({ ...ref, wsl });

      await expect(resolver.resolve(linked)).rejects.toMatchObject({ kind: 'NotAvailable' });
      expect(state.warnings[0]?.detail).toContain('WSL distribution: Ubuntu-24.04');
      expect(state.warnings[0]?.detail).toContain('This runs kubectl in WSL (Ubuntu-24.04)');
      expect(launched).toEqual([]);

      state.answerWarning = () => 'Open';
      await resolver.resolve(linked);
      expect(launched.length).toBeGreaterThanOrEqual(3); // pod query, exec target, provisioning
      expect(launched.every((mode) => JSON.stringify(mode) === JSON.stringify(wsl))).toBe(true);
    });

    it('fixes a target without a context to the current one, also for the connection and tunnels', async () => {
      await stub.set('current-context', 'other');
      const { resolver, logger } = createResolver();
      const { context: _context, ...withoutContext } = ref;
      const resolved = (await resolver.resolve(
        encodePodAuthority(withoutContext),
      )) as unknown as Resolved;
      // switching contexts later must not redirect this connection
      await stub.set('current-context', 'changed');

      const connection = (await resolved.makeConnection()) as {
        onDidReceiveMessage: (listener: (data: Uint8Array) => void) => unknown;
        send: (data: Uint8Array) => void;
        end: () => void;
      };
      const echoed = new Promise<string>((resolve) => {
        connection.onDidReceiveMessage((data) => resolve(Buffer.from(data).toString()));
      });
      connection.send(Buffer.from('pinned'));
      expect(await echoed).toBe('pinned');
      connection.end();
      const remote = await startEcho();
      const tunnel = await callLikeTheIde(resolver.tunnelFactory, {
        remoteAddress: { host: 'localhost', port: remote },
      });
      const local = (tunnel.localAddress as { port: number }).port;
      expect(await echoThrough(local, 'tunnel')).toBe('tunnel');
      await tunnel.dispose();

      const execs = (await stub.calls()).filter((args) => args.includes('exec'));
      const bridges = execs.filter((args) => args.includes('-e'));
      expect(bridges.length).toBeGreaterThanOrEqual(2); // the connection and the tunnel
      expect(execs.every((args) => args.includes('--context=other'))).toBe(true);
      expect(logger.entries.map((e) => e.message)).toContain(
        'The target names no context; using the current one, other',
      );
    });

    it('reads the current context with the kubeconfig and WSL selection of the window', async () => {
      await stub.set('current-context', 'window-context');
      const launched: unknown[] = [];
      const launcher = (wsl: unknown) => {
        launched.push(wsl);
        return { kubectl: stub.path }; // the stub stands in for kubectl in WSL
      };
      const resolver = new PodResolver({
        logger: new MemoryLogger(),
        kubectl: new Kubectl(launcher, () => ({ kubeconfig: '/k/settings' })),
        kubectlLauncher: launcher,
        targets: allKnown,
        serverBuild: async () => build,
        serverUrlTemplate: () => `file://${archive}`,
        kiroLogin: async () => undefined,
      });
      cleanups.push(() => resolver.dispose());
      const { context: _context, ...withoutContext } = ref;
      const wsl = { distro: 'Ubuntu-24.04' };
      await resolver.resolve(
        encodePodAuthority({ ...withoutContext, kubeconfig: '/k/window', wsl }),
      );

      const calls = await stub.calls();
      const lookup = calls.find((args) => args.some((arg) => arg.includes('{.current-context}')));
      expect(lookup?.[0]).toBe('--kubeconfig=/k/window');
      expect(calls.every((args) => !args.includes('--kubeconfig=/k/settings'))).toBe(true);
      expect(launched.every((mode) => JSON.stringify(mode) === JSON.stringify(wsl))).toBe(true);
    });

    it('refuses a target without a context when there is no current one', async () => {
      await stub.set('contexts', 'ctx-a\nctx-b\n');
      const { resolver } = createResolver();
      const { context: _context, ...withoutContext } = ref;
      await expect(resolver.resolve(encodePodAuthority(withoutContext))).rejects.toMatchObject({
        kind: 'NotAvailable',
        message: expect.stringMatching(/^This window names no Kubernetes context/),
      });
      expect((await stub.calls()).some((args) => args.includes('pod'))).toBe(false);
    });

    it('says that no kubeconfig was found for a target without a context and no contexts', async () => {
      const { resolver } = createResolver();
      const { context: _context, ...withoutContext } = ref;
      await expect(resolver.resolve(encodePodAuthority(withoutContext))).rejects.toMatchObject({
        kind: 'NotAvailable',
        message: expect.stringMatching(/^kubectl found no Kubernetes context/),
      });
    });

    it('rejects an invalid authority without calling kubectl', async () => {
      const { resolver } = createResolver();
      await expect(resolver.resolve('k8s-pod+nothex')).rejects.toMatchObject({
        kind: 'NotAvailable',
      });
      expect(await stub.calls()).toEqual([]);
    });

    it('explains how to fix a missing kubectl', async () => {
      const logger = new MemoryLogger();
      const resolver = new PodResolver({
        logger,
        kubectl: new Kubectl(
          () => ({ kubectl: path.join(root, 'no-such-kubectl') }),
          () => ({}),
        ),
        kubectlLauncher: () => ({ kubectl: path.join(root, 'no-such-kubectl') }),
        targets: allKnown,
        serverBuild: async () => build,
        serverUrlTemplate: () => undefined,
        kiroLogin: async () => undefined,
      });
      await expect(resolver.resolve(encodePodAuthority(ref))).rejects.toMatchObject({
        message: expect.stringMatching(/Install kubectl or set "dev\.containers\.kubectlPath"/),
      });
      expect(state.errorMessages).toEqual([]);
    });
  },
);
