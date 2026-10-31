import { describe, expect, it } from 'vitest';
import { DockerTarget } from '../../src/core/exec/target';
import { checkContainerRunning } from '../../src/core/k8s/attach';
import {
  kubectlBaseArgs,
  kubectlExecArgs,
  KubectlTarget,
  parseNames,
  parsePodInfo,
} from '../../src/core/k8s/kubectl';
import {
  assertPodRef,
  decodePodAuthority,
  encodePodAuthority,
  isPodAuthority,
} from '../../src/core/k8s/podRef';
import type { PodRef } from '../../src/core/k8s/podRef';

const ref: PodRef = { context: 'kind-dev', namespace: 'team-a', pod: 'web-7d9f', container: 'app' };

const hex = (value: unknown): string =>
  `k8s-pod+${Buffer.from(JSON.stringify(value), 'utf8').toString('hex')}`;

describe('pod authority', () => {
  it('round-trips with and without context and kubeconfig', () => {
    expect(decodePodAuthority(encodePodAuthority(ref))).toEqual(ref);
    const minimal: PodRef = { namespace: 'default', pod: 'p', container: 'c' };
    expect(decodePodAuthority(encodePodAuthority(minimal))).toEqual(minimal);
    const withConfig: PodRef = { ...ref, kubeconfig: '/home/me/.kube/config' };
    expect(decodePodAuthority(encodePodAuthority(withConfig))).toEqual(withConfig);
    const inWsl: PodRef = { ...ref, wsl: {}, kubeconfig: 'C:\\Users\\me\\.kube\\config' };
    expect(decodePodAuthority(encodePodAuthority(inWsl))).toEqual(inWsl);
  });

  it('only contains characters that are safe in a URI authority', () => {
    expect(encodePodAuthority(ref)).toMatch(/^k8s-pod\+[0-9a-f]+$/);
  });

  it('rejects a kubeconfig path that could add lines to the confirmation dialog', () => {
    expect(() =>
      decodePodAuthority(
        hex({ v: 1, ...ref, kubeconfig: "/tmp/k\n\nkubeconfig: kubectl's default" }),
      ),
    ).toThrowError(/kubeconfig path/);
    expect(() => assertPodRef({ ...ref, kubeconfig: '/home/me/\u202Egifnoc' })).toThrow();
    // Also the Unicode line and paragraph separators, also in one file of a list.
    for (const separator of ['\u2028', '\u2029']) {
      expect(() =>
        assertPodRef({ ...ref, kubeconfig: `/a/config:/tmp/k${separator}Context-prod` }, ':'),
      ).toThrow(/kubeconfig path/);
    }
  });

  it('rejects a kubeconfig on a network share, but not one in WSL', () => {
    expect(() =>
      decodePodAuthority(hex({ v: 1, ...ref, kubeconfig: '\\\\attacker.example\\s\\config' })),
    ).toThrowError(/network shares/);
    expect(() => assertPodRef({ ...ref, kubeconfig: '//attacker.example/s/config' })).toThrow();
    const wsl: PodRef = { ...ref, kubeconfig: '\\\\wsl$\\Ubuntu\\home\\me\\.kube\\config' };
    expect(decodePodAuthority(encodePodAuthority(wsl))).toEqual(wsl);
  });

  it('accepts real-world context names such as EKS ARNs', () => {
    const eks = 'arn:aws:eks:eu-west-1:123456789012:cluster/prod';
    expect(decodePodAuthority(encodePodAuthority({ ...ref, context: eks })).context).toBe(eks);
    expect(() =>
      assertPodRef({ ...ref, context: 'gke_proj_europe-west1_cluster-1' }),
    ).not.toThrow();
  });

  it('recognizes its own authorities only', () => {
    expect(isPodAuthority(encodePodAuthority(ref))).toBe(true);
    expect(isPodAuthority('dev-container+ab')).toBe(false);
    expect(isPodAuthority(undefined)).toBe(false);
  });

  it.each([
    ['namespace starting with a dash', { ...ref, namespace: '--all-namespaces' }],
    ['pod name starting with a dash', { ...ref, pod: '-o=yaml' }],
    ['container starting with a dash', { ...ref, container: '--help' }],
    ['context starting with a dash', { ...ref, context: '--kubeconfig=/etc/passwd' }],
    ['uppercase namespace', { ...ref, namespace: 'Team' }],
    ['pod with a space', { ...ref, pod: 'a b' }],
    ['pod with a shell character', { ...ref, pod: 'a;rm' }],
    ['container with a slash', { ...ref, container: 'a/b' }],
    ['namespace longer than 63', { ...ref, namespace: 'a'.repeat(64) }],
    ['empty pod', { ...ref, pod: '' }],
    ['relative kubeconfig', { ...ref, kubeconfig: 'config' }],
    ['kubeconfig with NUL', { ...ref, kubeconfig: '/a\0b' }],
  ])('rejects %s', (_name, bad) => {
    expect(() => encodePodAuthority(bad as PodRef)).toThrowError(/invalid/);
  });

  it.each([
    ['wrong prefix', 'dev-container+abcd'],
    ['empty payload', 'k8s-pod+'],
    ['odd length', 'k8s-pod+abc'],
    ['non-hex', 'k8s-pod+zz'],
    ['not JSON', `k8s-pod+${Buffer.from('nope').toString('hex')}`],
    ['array payload', hex([])],
    ['wrong version', hex({ v: 2, ...ref })],
    ['missing pod', hex({ v: 1, namespace: 'a', container: 'c' })],
    ['non-string namespace', hex({ v: 1, namespace: 5, pod: 'p', container: 'c' })],
    ['hostile pod', hex({ v: 1, namespace: 'a', pod: '-o=yaml', container: 'c' })],
  ])('rejects a decoded authority with %s', (_name, authority) => {
    expect(() => decodePodAuthority(authority)).toThrow();
  });
});

describe('kubectl arguments', () => {
  it('selects the cluster with --flag=value so no value can become a separate option', () => {
    expect(kubectlBaseArgs({ kubeconfig: '/k', context: 'ctx', namespace: 'ns' })).toEqual([
      '--kubeconfig=/k',
      '--context=ctx',
      '--namespace=ns',
    ]);
    expect(kubectlBaseArgs({})).toEqual([]);
    expect(kubectlBaseArgs({ namespace: 'ns', context: undefined })).toEqual(['--namespace=ns']);
  });

  it('builds an interactive exec into the chosen container, command after --', () => {
    expect(kubectlExecArgs(ref, ['sh', '-s'])).toEqual([
      '--context=kind-dev',
      '--namespace=team-a',
      'exec',
      '-i',
      '--container=app',
      'web-7d9f',
      '--',
      'sh',
      '-s',
    ]);
  });

  it('keeps the command as separate arguments, whatever it contains', () => {
    const args = kubectlExecArgs(ref, ['node', '-e', 'a; rm -rf / $(id)', '4000', 'db']);
    expect(args.slice(args.indexOf('--') + 1)).toEqual([
      'node',
      '-e',
      'a; rm -rf / $(id)',
      '4000',
      'db',
    ]);
  });

  it('refuses to build arguments for an invalid target', () => {
    expect(() => kubectlExecArgs({ ...ref, pod: '--all' }, ['sh'])).toThrow();
    expect(() => new KubectlTarget({ kubectl: 'kubectl' }, { ...ref, container: '-x' })).toThrow();
  });
});

describe('exec targets', () => {
  it('describes a pod container for logs and runs kubectl', () => {
    const target = new KubectlTarget({ kubectl: '/usr/bin/kubectl' }, ref);
    expect(target.label).toBe('team-a/web-7d9f/app');
    expect(target.spec(['id'])).toEqual({
      command: '/usr/bin/kubectl',
      args: kubectlExecArgs(ref, ['id']),
    });
  });

  it('runs a docker container interactively as the given user', () => {
    const target = new DockerTarget('docker', 'abcdef0123456789', 'vscode');
    expect(target.label).toBe('abcdef012345');
    expect(target.spec(['node', '-v'])).toEqual({
      command: 'docker',
      args: ['exec', '-i', '-u', 'vscode', 'abcdef0123456789', 'node', '-v'],
    });
  });

  it('omits -u when no user is given', () => {
    expect(new DockerTarget('podman', 'c1').spec(['sh']).args).toEqual(['exec', '-i', 'c1', 'sh']);
  });
});

const podJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    metadata: {
      name: 'web-7d9f',
      namespace: 'team-a',
      annotations: { 'kubectl.kubernetes.io/default-container': 'app' },
    },
    spec: {
      containers: [{ name: 'sidecar' }, { name: 'app' }],
      initContainers: [{ name: 'init' }],
    },
    status: {
      phase: 'Running',
      containerStatuses: [
        { name: 'sidecar', ready: true, state: { running: { startedAt: 'x' } } },
        { name: 'app', ready: false, state: { waiting: { reason: 'CrashLoopBackOff' } } },
      ],
    },
    ...overrides,
  });

describe('parsePodInfo', () => {
  it('reads phase, regular containers (not init containers) and their state', () => {
    const info = parsePodInfo(podJson());
    expect(info).toMatchObject({ name: 'web-7d9f', namespace: 'team-a', phase: 'Running' });
    expect(info.containers).toEqual([
      { name: 'sidecar', ready: true, running: true },
      { name: 'app', ready: false, running: false },
    ]);
    expect(info.defaultContainer).toBe('app');
  });

  it('treats a container without status as not running', () => {
    const info = parsePodInfo(
      podJson({ status: { phase: 'Pending' }, spec: { containers: [{ name: 'a' }] } }),
    );
    expect(info.containers).toEqual([{ name: 'a', ready: false, running: false }]);
    expect(info.phase).toBe('Pending');
  });

  it.each([['Evicted [x](command:y)'], [42], [undefined]])(
    'takes a phase that is not one of the pod phases as Unknown (%j)',
    (phase) => {
      expect(parsePodInfo(podJson({ status: { phase } })).phase).toBe('Unknown');
    },
  );

  it.each(['', 'not json', '{}', '{"metadata":{}}'])('rejects %j', (input) => {
    expect(() => parsePodInfo(input)).toThrow();
  });
});

describe('parseNames', () => {
  it('lists the names of a kubectl list', () => {
    expect(
      parseNames('{"items":[{"metadata":{"name":"a"}},{"metadata":{"name":"b"}},{"x":1}]}'),
    ).toEqual(['a', 'b']);
    expect(parseNames('garbage')).toEqual([]);
    expect(parseNames('{}')).toEqual([]);
  });
});

describe('checkContainerRunning', () => {
  const info = parsePodInfo(podJson());

  it('accepts a running container', () => {
    expect(() => checkContainerRunning(info, 'sidecar')).not.toThrow();
  });

  it('says what is wrong with a container that is not running', () => {
    expect(() => checkContainerRunning(info, 'app')).toThrowError(
      /"app" of pod web-7d9f is not running/,
    );
  });

  it('lists the containers when the name is wrong', () => {
    expect(() => checkContainerRunning(info, 'nope')).toThrowError(/Containers: sidecar, app/);
  });

  it('tells to wait when the pod itself is not running', () => {
    const pending = parsePodInfo(podJson({ status: { phase: 'Pending' } }));
    expect(() => checkContainerRunning(pending, 'app')).toThrowError(
      /not running \(status: Pending\)/,
    );
  });
});
