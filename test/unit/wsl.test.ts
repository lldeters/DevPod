// kubectl in WSL: the arguments for wsl.exe, the wrapper script that runs inside WSL (here with the
// local sh), the error messages and the window target. test/e2e/wsl.test.ts runs the same through
// a real wsl.exe on Windows.
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DevContainerError } from '../../src/core/errors';
import {
  KubectlTarget,
  kubectlExecArgs,
  notStartedMessage,
  queryFailure,
} from '../../src/core/k8s/kubectl';
import { WSL_KUBECTL_SCRIPT, kubectlProcess, wslExecutable } from '../../src/core/k8s/launcher';
import { decodePodAuthority, encodePodAuthority } from '../../src/core/k8s/podRef';
import type { PodRef } from '../../src/core/k8s/podRef';
import { BRIDGE_SCRIPT } from '../../src/core/server/script';

const ref: PodRef = { namespace: 'team-a', pod: 'web-7d9f', container: 'app' };

describe('starting kubectl', () => {
  it('runs kubectl directly when WSL is not used', () => {
    expect(kubectlProcess({ kubectl: '/usr/bin/kubectl' }, ['get', 'pods'])).toEqual({
      command: '/usr/bin/kubectl',
      args: ['get', 'pods'],
    });
  });

  it('runs kubectl through wsl.exe --exec, never through the default shell', () => {
    const spec = kubectlProcess({ kubectl: 'kubectl', wsl: { distro: 'Ubuntu-24.04' } }, [
      'get',
      'pods',
    ]);
    expect(spec.command).toBe(wslExecutable());
    expect(spec.args).toEqual([
      '--distribution',
      'Ubuntu-24.04',
      '--cd',
      '~',
      '--exec',
      '/bin/sh',
      '-c',
      WSL_KUBECTL_SCRIPT,
      'kubectl',
      'kubectl',
      'get',
      'pods',
    ]);
    expect(spec.args).not.toContain('--');
  });

  it('uses the default distribution unless one is named', () => {
    const spec = kubectlProcess({ kubectl: 'kubectl', wsl: {} }, ['version']);
    expect(spec.args.slice(0, 3)).toEqual(['--cd', '~', '--exec']);
  });

  it('refuses a distribution name WSL would not accept', () => {
    for (const distro of ['', '-d', 'a b', 'x;rm', 'Ubuntu\n']) {
      expect(() => kubectlProcess({ kubectl: 'kubectl', wsl: { distro } }, [])).toThrow(
        DevContainerError,
      );
    }
  });

  it('takes wsl.exe from the Windows system folder', () => {
    expect(wslExecutable({ SystemRoot: 'D:\\Win' })).toBe('D:\\Win\\System32\\wsl.exe');
    expect(wslExecutable({})).toBe('C:\\Windows\\System32\\wsl.exe');
    for (const unusable of ['', 'Windows', 'System32\\..', '\\\\host\\share', 'C:']) {
      expect(wslExecutable({ SystemRoot: unusable }), unusable).toBe(
        'C:\\Windows\\System32\\wsl.exe',
      );
    }
  });

  it('runs pod commands in WSL too, with the command as separate arguments', () => {
    const target = new KubectlTarget({ kubectl: 'kubectl', wsl: {} }, ref);
    const spec = target.spec(['node', '-e', BRIDGE_SCRIPT, '4000']);
    expect(spec.command).toBe(wslExecutable());
    expect(spec.args.slice(spec.args.indexOf(WSL_KUBECTL_SCRIPT) + 3)).toEqual(
      kubectlExecArgs(ref, ['node', '-e', BRIDGE_SCRIPT, '4000']),
    );
  });
});

// The wrapper only needs a POSIX sh, so its logic is checked here without WSL.
describe.skipIf(process.platform === 'win32')('the wrapper script inside WSL', () => {
  let home: string;
  let bin: string;

  beforeAll(async () => {
    home = await realpath(await mkdtemp(path.join(tmpdir(), 'dck-wsl-')));
    bin = path.join(home, 'bin');
    await mkdir(bin);
    // Prints KUBECONFIG and every argument, NUL-terminated.
    await writeFile(
      path.join(bin, 'argv-dump'),
      '#!/bin/sh\nprintf \'%s\\0\' "${KUBECONFIG-unset}"\nfor a; do printf \'%s\\0\' "$a"; done\n',
    );
    // Stands in for WSL's wslpath.
    await writeFile(
      path.join(bin, 'wslpath'),
      '#!/bin/sh\n[ "$1" = -u ] && printf \'/mnt/c/converted%s\' "$(printf %s "$2" | cut -c3- | tr \'\\\\\\\\\' /)"\n',
    );
    await chmod(path.join(bin, 'argv-dump'), 0o755);
    await chmod(path.join(bin, 'wslpath'), 0o755);
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // A profile that prints, reads stdin, and sets PATH and KUBECONFIG.
    await writeFile(
      path.join(home, '.profile'),
      'echo noise-from-profile\nread line\nexport PATH="$HOME/bin:$PATH"\nexport KUBECONFIG=/from/profile\n',
    );
  });

  function run(
    kubectl: string,
    args: string[],
    input = '',
  ): { code: number | null; out: string[]; stdout: string; stderr: string } {
    const result = spawnSync('/bin/sh', ['-c', WSL_KUBECTL_SCRIPT, 'kubectl', kubectl, ...args], {
      input,
      encoding: 'utf8',
      env: { HOME: home, SHELL: '/bin/sh', PATH: `/usr/bin:/bin` },
    });
    return {
      code: result.status,
      out: result.stdout.split('\0').slice(0, -1),
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  it('passes every argument unchanged, including the connection script', () => {
    const args = [
      '--kubeconfig=/abs/config',
      'exec',
      '-i',
      '--',
      'node',
      '-e',
      BRIDGE_SCRIPT,
      'a b',
      'quote"inside',
      "it's",
      '',
      '$HOME `id` $(id)',
      'back\\slash\\',
      'ünïcödé',
      'two\nlines',
    ];
    const result = run('argv-dump', args);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(['/from/profile', ...args]);
  });

  it("finds kubectl on the login profile's PATH, without its output or reading kubectl's input", () => {
    const result = run('/bin/cat', [], 'data for kubectl\n');
    expect(result.stdout).toBe('data for kubectl\n');
    expect(run('argv-dump', ['get']).out).toEqual(['/from/profile', 'get']);
  });

  it('expands ~/ in the kubectl path and in the kubeconfig path to the Linux home directory', () => {
    expect(run('~/bin/argv-dump', ['--kubeconfig=~/.kube/config', 'get']).out).toEqual([
      '/from/profile',
      `--kubeconfig=${home}/.kube/config`,
      'get',
    ]);
  });

  it('converts a Windows kubeconfig path with wslpath', () => {
    expect(run('argv-dump', ['--kubeconfig=C:\\Users\\me\\config', 'get']).out).toEqual([
      '/from/profile',
      '--kubeconfig=/mnt/c/converted/Users/me/config',
      'get',
    ]);
  });

  it('leaves later arguments alone, even when they look like a kubeconfig flag', () => {
    expect(run('argv-dump', ['exec', '--', 'x', '--kubeconfig=~/y']).out).toEqual([
      '/from/profile',
      'exec',
      '--',
      'x',
      '--kubeconfig=~/y',
    ]);
  });

  it('still runs kubectl when the login profile is broken', async () => {
    await writeFile(path.join(home, '.profile'), 'this is ( not valid sh\n');
    const result = run(path.join(bin, 'argv-dump'), ['get']);
    expect(result.code).toBe(0);
    expect(result.out).toEqual(['unset', 'get']); // the default PATH and no KUBECONFIG
  });

  it('exits with 127 when kubectl does not exist', () => {
    const result = run('no-such-kubectl', ['get']);
    expect(result.code).toBe(127);
    expect(result.stderr).toMatch(/no-such-kubectl/);
  });
});

describe('error messages', () => {
  it('says when WSL itself cannot be started', () => {
    expect(notStartedMessage({ kubectl: 'kubectl', wsl: {} })).toMatch(
      /Could not start WSL .*wsl\.exe.*dev\.containers\.kubectlInWSL/,
    );
  });

  it('explains that batch files cannot be started', () => {
    expect(notStartedMessage({ kubectl: 'C:\\tools\\kubectl.CMD' })).toMatch(
      /is a batch file, which cannot be started without a shell.*kubectl\.exe.*kubectlInWSL/,
    );
    expect(notStartedMessage({ kubectl: 'kubectl' })).toMatch(/Install kubectl/);
  });

  it('explains where PATH comes from when kubectl is missing in WSL', () => {
    const error = queryFailure({ kubectl: 'kubectl', wsl: { distro: 'Ubuntu' } }, 'config', {
      code: 127,
      stderr: 'kubectl: 1: exec: kubectl: not found\n',
    });
    expect(error.message).toMatch(/^kubectl was not found in WSL \(Ubuntu\)/);
    expect(error.message).toMatch(/~\/\.profile.*not from ~\/\.bashrc/);
  });

  it('does not take exit code 127 for a missing kubectl outside WSL', () => {
    expect(queryFailure({ kubectl: 'kubectl' }, 'get', { code: 127, stderr: 'x' }).message).toBe(
      'kubectl get failed: x',
    );
  });

  it('shows what wsl.exe wrote to stdout when stderr is empty', () => {
    expect(
      queryFailure({ kubectl: 'kubectl', wsl: {} }, 'config', {
        code: 1,
        stderr: '\n',
        stdout: 'WSL is not installed.\n',
      }).message,
    ).toBe('kubectl config (in WSL) failed: WSL is not installed.');
  });

  it("drops the NUL characters of wsl.exe's UTF-16 messages", () => {
    const utf16 = Buffer.from('There is no distribution with the supplied name.', 'utf16le');
    const error = queryFailure({ kubectl: 'kubectl', wsl: { distro: 'Nope' } }, 'config', {
      code: 1,
      stderr: utf16.toString('latin1'),
    });
    expect(error.message).toBe(
      'kubectl config (in WSL (Nope)) failed: There is no distribution with the supplied name.',
    );
  });
});

describe('the window target in WSL', () => {
  it('records the WSL mode and distribution', () => {
    for (const wsl of [{}, { distro: 'Ubuntu-24.04' }]) {
      const target = { ...ref, wsl, kubeconfig: '~/.kube/config' };
      expect(decodePodAuthority(encodePodAuthority(target))).toEqual(target);
    }
    expect(decodePodAuthority(encodePodAuthority(ref)).wsl).toBeUndefined();
  });

  it('accepts the kubeconfig forms the wrapper understands, only in WSL', () => {
    for (const kubeconfig of ['/home/me/.kube/config', '~/.kube/config', 'C:\\Users\\me\\config']) {
      expect(() => encodePodAuthority({ ...ref, wsl: {}, kubeconfig })).not.toThrow();
    }
    expect(() => encodePodAuthority({ ...ref, kubeconfig: '~/.kube/config' })).toThrow(
      /kubeconfig path/,
    );
    for (const kubeconfig of ['relative/config', '\\\\server\\share\\config', '//server/config']) {
      expect(() => encodePodAuthority({ ...ref, wsl: {}, kubeconfig }), kubeconfig).toThrow(
        /kubeconfig path/,
      );
    }
  });

  it('refuses an invalid WSL selection from a link', () => {
    const forge = (payload: object): string =>
      `k8s-pod+${Buffer.from(JSON.stringify({ v: 1, ...ref, ...payload }), 'utf8').toString('hex')}`;
    expect(() => decodePodAuthority(forge({ wsl: { distro: '-x' } }))).toThrow(/WSL distribution/);
    expect(() => decodePodAuthority(forge({ wsl: ['Ubuntu'] }))).toThrow(/WSL selection/);
    expect(() => decodePodAuthority(forge({ wsl: 'Ubuntu' }))).toThrow(/WSL selection/);
    expect(() => decodePodAuthority(forge({ wsl: { distro: 7 } }))).toThrow(/distro/);
  });
});
