// "Attach to Kiro" for pods: what the command does after the click, against a kubectl stub.
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { Kubectl } from '../../src/core/k8s/kubectl';
import { decodePodAuthority } from '../../src/core/k8s/podRef';
import { MemoryLogger } from '../../src/core/logger';
import { KnownTargets } from '../../src/remote/knownTargets';
import { attachToPod, effectiveKubeconfig, effectiveKubectlPath } from '../../src/ui/kubernetes';
import type { AttachDependencies, ExplorerTarget } from '../../src/ui/kubernetes';
import * as mock from '../helpers/vscodeMock';
import { createKubectlStub, listJson, podJson } from '../helpers/kubectlStub';
import type { KubectlStub } from '../helpers/kubectlStub';

const { state } = mock;

let root: string;
let stub: KubectlStub;
let targets: KnownTargets;

beforeAll(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), 'dck-attach-')));
  stub = await createKubectlStub(root);
  process.env['KUBECTL_STUB_DIR'] = stub.dir;
});

afterAll(async () => {
  delete process.env['KUBECTL_STUB_DIR'];
  await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  mock.reset();
  targets = new KnownTargets(new mock.MockMemento() as unknown as vscode.Memento);
  await stub.reset();
  await stub.set('current-context', 'kind-test');
  await stub.set('pod.json', podJson());
});

function dependencies(
  options: { target?: ExplorerTarget | undefined; supported?: boolean } = {},
): AttachDependencies {
  return {
    logger: new MemoryLogger(),
    kubectl: new Kubectl(
      () => stub.path,
      () => effectiveKubeconfig(),
    ),
    targets,
    ensureRemoteSupport: async () => options.supported ?? true,
    resolveTarget: async () => options.target,
  };
}

function openedWindow(): { remoteAuthority: string; reuseWindow: boolean } | undefined {
  const call = state.executed.find((entry) => entry.command === 'vscode.newWindow');
  return call?.args[0] as { remoteAuthority: string; reuseWindow: boolean } | undefined;
}

const clickedPod: ExplorerTarget = { kind: 'pod', namespace: 'dev', name: 'mypod' };

describe('attach from the Kubernetes explorer', () => {
  it('opens a new window attached to the clicked pod, in the current context', async () => {
    await attachToPod(dependencies({ target: clickedPod }), { some: 'tree node' });

    const window = openedWindow();
    expect(window?.reuseWindow).toBe(false);
    expect(decodePodAuthority(window?.remoteAuthority ?? '')).toEqual({
      context: 'kind-test',
      namespace: 'dev',
      pod: 'mypod',
      container: 'app',
    });
    expect(state.errorMessages).toEqual([]);
    expect(state.quickPickCalls).toHaveLength(0); // a single running container needs no question
    // the new window resolves this authority without asking, since it was opened from here
    expect(targets.has(window?.remoteAuthority ?? '')).toBe(true);
  });

  it('asks which container when there are several, offering the pod default first', async () => {
    await stub.set(
      'pod.json',
      podJson({
        containers: [
          { name: 'sidecar', running: true },
          { name: 'app', running: true },
        ],
        defaultContainer: 'app',
      }),
    );
    state.quickPickIndex = 0;

    await attachToPod(dependencies({ target: clickedPod }), {});

    const labels = (state.quickPickCalls[0] as { label: string }[]).map((item) => item.label);
    expect(labels).toEqual(['app', 'sidecar']);
    expect(decodePodAuthority(openedWindow()?.remoteAuthority ?? '').container).toBe('app');
  });

  it('lets the user pick another container', async () => {
    await stub.set(
      'pod.json',
      podJson({
        containers: [
          { name: 'sidecar', running: true },
          { name: 'app', running: true },
        ],
      }),
    );
    state.quickPickIndex = 1;
    await attachToPod(dependencies({ target: clickedPod }), {});
    expect(decodePodAuthority(openedWindow()?.remoteAuthority ?? '').container).toBe('app');
  });

  it('records the context at click time, so a later switch cannot redirect the window', async () => {
    await stub.set('current-context', 'prod-cluster');
    await attachToPod(dependencies({ target: clickedPod }), {});
    expect(decodePodAuthority(openedWindow()?.remoteAuthority ?? '').context).toBe('prod-cluster');
  });

  it('says to select a pod when something else was clicked', async () => {
    await attachToPod(dependencies({ target: { kind: 'other' } }), {});
    expect(openedWindow()).toBeUndefined();
    expect(state.infoMessages.join('\n')).toMatch(/Select a pod/);
  });

  it('does nothing while remote support is not enabled (the user is guided instead)', async () => {
    await attachToPod(dependencies({ target: clickedPod, supported: false }), {});
    expect(openedWindow()).toBeUndefined();
    expect(await stub.calls()).toEqual([]);
  });

  it('refuses a pod that is not running, with the reason', async () => {
    await stub.set(
      'pod.json',
      podJson({ phase: 'Pending', containers: [{ name: 'app', running: false }] }),
    );
    state.quickPickIndex = 0;
    await expect(attachToPod(dependencies({ target: clickedPod }), {})).rejects.toThrow(
      /not running \(status: Pending\)/,
    );
    expect(openedWindow()).toBeUndefined();
  });

  it('reports a pod that does not exist', async () => {
    await stub.unset('pod.json');
    await expect(attachToPod(dependencies({ target: clickedPod }), {})).rejects.toThrow(/NotFound/);
  });

  it('uses the configured kubeconfig for both the query and the connection', async () => {
    state.settings['dev.containers.kubeconfigPath'] = '/home/me/.kube/other-config';
    await attachToPod(dependencies({ target: clickedPod }), {});

    const queries = (await stub.calls()).filter((args) => args.includes('pod'));
    expect(queries.every((args) => args.includes('--kubeconfig=/home/me/.kube/other-config'))).toBe(
      true,
    );
    expect(decodePodAuthority(openedWindow()?.remoteAuthority ?? '').kubeconfig).toBe(
      '/home/me/.kube/other-config',
    );
  });
});

describe('attach from the command palette', () => {
  it('walks through context, namespace and pod', async () => {
    await stub.set('contexts', 'kind-test\nother\n');
    await stub.set('namespaces.json', listJson(['dev', 'prod']));
    await stub.set('pods.json', listJson(['web-1', 'db-1']));
    state.quickPickSequence = [1, 1, 0]; // context "other", namespace "prod", pod "web-1"

    await attachToPod(dependencies());

    const titles = state.quickPickCalls.map((items) =>
      (items as { label: string }[]).map((i) => i.label),
    );
    expect(titles[0]).toEqual(['kind-test', 'other']); // the current context comes first
    expect(titles[1]).toEqual(['dev', 'prod']);
    expect(titles[2]).toEqual(['web-1', 'db-1']);
    expect(decodePodAuthority(openedWindow()?.remoteAuthority ?? '')).toEqual({
      context: 'other',
      namespace: 'prod',
      pod: 'web-1',
      container: 'app',
    });
  });

  it('does not ask for a context when there is only one', async () => {
    await stub.set('contexts', 'kind-test\n');
    await stub.set('namespaces.json', listJson(['dev']));
    await stub.set('pods.json', listJson(['mypod']));
    state.quickPickSequence = [0, 0];
    await attachToPod(dependencies());
    expect(state.quickPickCalls).toHaveLength(2); // namespace and pod only
  });

  it('asks for the namespace when listing namespaces is forbidden', async () => {
    await stub.set('contexts', 'kind-test\n');
    await stub.unset('namespaces.json'); // kubectl: Forbidden
    await stub.set('pods.json', listJson(['mypod']));
    state.inputBoxValue = 'dev';
    state.quickPickSequence = [0];

    await attachToPod(dependencies());

    expect(decodePodAuthority(openedWindow()?.remoteAuthority ?? '').namespace).toBe('dev');
  });

  it('stops quietly when the user cancels a question', async () => {
    await stub.set('contexts', 'kind-test\nother\n');
    state.quickPickSequence = [Number.NaN]; // items[NaN] is undefined: the user pressed Escape
    await attachToPod(dependencies());
    expect(openedWindow()).toBeUndefined();
  });

  it('tells when the namespace has no pods', async () => {
    await stub.set('contexts', 'kind-test\n');
    await stub.set('namespaces.json', listJson(['empty']));
    await stub.set('pods.json', listJson([]));
    state.quickPickSequence = [0];
    await attachToPod(dependencies());
    expect(openedWindow()).toBeUndefined();
    expect(state.infoMessages.join('\n')).toMatch(/no pods in namespace "empty"/);
  });
});

describe('which kubectl and kubeconfig are used', () => {
  it("prefers this extension's settings", () => {
    state.settings['dev.containers.kubectlPath'] = '/opt/kubectl';
    state.settings['vscode-kubernetes.kubectl-path'] = '/other/kubectl';
    state.settings['dev.containers.kubeconfigPath'] = '/own/config';
    state.settings['vs-kubernetes'] = { 'vs-kubernetes.kubeconfig': '/ext/config' };
    expect(effectiveKubectlPath()).toBe('/opt/kubectl');
    expect(effectiveKubeconfig()).toBe('/own/config');
  });

  it('falls back to what the Kubernetes extension is configured with', () => {
    const osKey =
      process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'mac' : 'linux';
    state.settings['vscode-kubernetes.kubectl-path'] = '/general/kubectl';
    expect(effectiveKubectlPath()).toBe('/general/kubectl');
    state.settings[`vscode-kubernetes.kubectl-path-${osKey}`] = '/os/kubectl';
    expect(effectiveKubectlPath()).toBe('/os/kubectl'); // the per-OS path wins
    state.settings['vs-kubernetes'] = { 'vs-kubernetes.kubeconfig': '/ext/config' };
    expect(effectiveKubeconfig()).toBe('/ext/config');
  });

  it('uses kubectl from PATH and its own kubeconfig lookup by default', () => {
    expect(effectiveKubectlPath()).toBe('kubectl');
    expect(effectiveKubeconfig()).toBeUndefined();
  });

  it('ignores blank settings', () => {
    state.settings['dev.containers.kubectlPath'] = '   ';
    state.settings['vs-kubernetes'] = { 'vs-kubernetes.kubeconfig': '' };
    expect(effectiveKubectlPath()).toBe('kubectl');
    expect(effectiveKubeconfig()).toBeUndefined();
  });

  it('reads ~ as the home directory, since kubectl is started without a shell', () => {
    state.settings['vs-kubernetes'] = { 'vs-kubernetes.kubeconfig': '~/.kube/other' };
    state.settings['vscode-kubernetes.kubectl-path'] = '~/bin/kubectl';
    expect(effectiveKubeconfig()).toBe(path.join(homedir(), '.kube', 'other'));
    expect(effectiveKubectlPath()).toBe(path.join(homedir(), 'bin', 'kubectl'));
    state.settings['dev.containers.kubeconfigPath'] = '~';
    expect(effectiveKubeconfig()).toBe(homedir());
    state.settings['dev.containers.kubeconfigPath'] = '/a/~b';
    expect(effectiveKubeconfig()).toBe('/a/~b');
  });
});
