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
  noContextError,
  noCurrentContextError,
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

// wsl.exe's own messages: in the Windows display language, in UTF-16 unless WSL_UTF8=1, on stdout.
// runProcess decodes them as UTF-8, as here.
const utf16 = (text: string): string => Buffer.from(text, 'utf16le').toString('utf8');
const DISTRO_NOT_FOUND_DE =
  'Es ist keine Verteilung mit dem angegebenen Namen vorhanden.\r\n' +
  'Fehlercode: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n';
const NO_DISTRIBUTION_DE =
  'Für das Windows-Subsystem für Linux sind keine Distributionen installiert.\r\n' +
  'Sie können das Problem beheben, indem Sie eine Distribution mit den folgenden Anweisungen ' +
  'installieren:\r\n\r\n' +
  '"wsl.exe --list --online" zum Auflisten verfügbarer Distributionen verwenden\r\n' +
  'und "wsl.exe --install <Distro>" zum Installieren.\r\n';

describe("WSL's own failures", () => {
  const wsl = { kubectl: 'kubectl', wsl: { distro: 'Ubuntu-24.04' } };

  it('names the setting when the distribution does not exist, in any language and encoding', () => {
    for (const stdout of [DISTRO_NOT_FOUND_DE, utf16(DISTRO_NOT_FOUND_DE)]) {
      const error = queryFailure(wsl, 'config view', {
        code: 4294967295,
        stdout,
        stderr: utf16('wsl: Eine Warnung, die nichts zur Sache tut.\r\n'),
      });
      expect(error.code).toBe('CONFIG_INVALID');
      expect(error.message).toMatch(
        /^WSL has no distribution named "Ubuntu-24\.04" \(WSL_E_DISTRO_NOT_FOUND\)\. "wsl\.exe --list --verbose"/,
      );
      expect(error.message).toMatch(
        /"dev\.containers\.kubectlWSLDistro".*attach to the pod again/s,
      );
    }
  });

  it('says that there is no default distribution, also when none is installed at all', () => {
    for (const stdout of [DISTRO_NOT_FOUND_DE, NO_DISTRIBUTION_DE, utf16(NO_DISTRIBUTION_DE)]) {
      const error = queryFailure({ kubectl: 'kubectl', wsl: {} }, 'config view', {
        code: 4294967295,
        stdout,
        stderr: '',
      });
      expect(error.message).toMatch(/^WSL has no default distribution to run kubectl in\./);
      expect(error.message).toContain('"dev.containers.kubectlInWSL": false');
    }
  });

  it('reports other WSL errors with their first line and code', () => {
    const error = queryFailure(wsl, 'get pods', {
      code: 4294967295,
      stdout:
        'Der Dienst kann nicht gestartet werden.\r\nFehlercode: Wsl/Service/WSL_E_VM_MODE_INVALID_STATE\r\n',
      stderr: '',
    });
    expect(error.message).toBe(
      'WSL could not run kubectl in WSL (Ubuntu-24.04): Der Dienst kann nicht gestartet werden. ' +
        '(WSL_E_VM_MODE_INVALID_STATE).',
    );
  });

  it('does not take a WSL failure with another code for a missing distribution', () => {
    // Virtualization off: the hint mentions "wsl.exe --install --no-distribution".
    const hcs =
      'WSL2 kann nicht gestartet werden, da die Virtualisierung nicht aktiviert ist.\r\n' +
      'Aktivieren Sie "VM-Plattform" mit: wsl.exe --install --no-distribution\r\n' +
      'Fehlercode: Wsl/Service/CreateInstance/CreateVm/HCS/HCS_E_HYPERV_NOT_INSTALLED\r\n';
    expect(
      queryFailure(wsl, 'config view', { code: 4294967295, stdout: hcs, stderr: '' }).message,
    ).toBe(
      'WSL could not run kubectl in WSL (Ubuntu-24.04): WSL2 kann nicht gestartet werden, da die ' +
        'Virtualisierung nicht aktiviert ist. (HCS_E_HYPERV_NOT_INSTALLED).',
    );
    const component =
      'Für WSL ist die optionale Komponente erforderlich.\r\n' +
      'Führen Sie "wsl.exe --install --no-distribution" aus.\r\n' +
      'Fehlercode: Wsl/WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED\r\n';
    expect(
      queryFailure({ kubectl: 'kubectl', wsl: {} }, 'config view', {
        code: 4294967295,
        stdout: component,
        stderr: '',
      }).message,
    ).toMatch(/^WSL could not run kubectl in WSL: .*\(WSL_E_WSL_OPTIONAL_COMPONENT_REQUIRED\)\.$/);
  });

  it('finds the code on stderr too, and the default-distribution code on its own', () => {
    expect(
      queryFailure(wsl, 'config view', { code: 1, stdout: '', stderr: utf16(DISTRO_NOT_FOUND_DE) })
        .message,
    ).toMatch(/^WSL has no distribution named "Ubuntu-24\.04"/);
    expect(
      queryFailure({ kubectl: 'kubectl', wsl: {} }, 'config view', {
        code: 4294967295,
        stdout: 'Kein Standard.\r\nFehlercode: Wsl/Service/WSL_E_DEFAULT_DISTRO_NOT_FOUND\r\n',
        stderr: '',
      }).message,
    ).toMatch(/^WSL has no default distribution to run kubectl in\./);
  });

  it("leaves kubectl's own errors alone, also in WSL", () => {
    expect(
      queryFailure(wsl, 'get pods', {
        code: 1,
        stdout: '',
        stderr: 'error: You must be logged in\n',
      }).message,
    ).toBe('kubectl get pods (in WSL (Ubuntu-24.04)) failed: error: You must be logged in');
  });
});

describe('the detail of a kubectl failure', () => {
  it('drops klog lines and carriage returns, keeping what kubectl says', () => {
    const stderr =
      'E1028 09:05:27.691553     284 memcache.go:381] "Couldn\'t get current server API group list" err="..."\r\n' +
      'E1028 09:05:27.692468     284 memcache.go:381] "Couldn\'t get current server API group list" err="..."\r\n' +
      'The connection to the server localhost:8080 was refused - did you specify the right host or port?\r\n';
    expect(queryFailure({ kubectl: 'kubectl' }, 'get pod', { code: 1, stderr }).message).toBe(
      'kubectl get pod failed: The connection to the server localhost:8080 was refused - did you ' +
        'specify the right host or port?',
    );
  });

  it('keeps the line that names a missing credential plugin, without the klog entries', () => {
    const entry =
      'E1028 10:02:01.325550    2246 memcache.go:381] "Couldn\'t get current server API group list" err=<\n' +
      '\tGet "https://127.0.0.1:1/api?timeout=32s": getting credentials: exec: executable kubelogin not found\n' +
      '\t\n' +
      '\tIt looks like you are trying to use a client-go credential plugin that is not installed.\n' +
      '\t\n' +
      '\tTo learn more about this feature, consult the documentation available at:\n' +
      '\t      https://kubernetes.io/docs/reference/access-authn-authz/authentication/#client-go-credential-plugins\n' +
      ' >\n';
    // As kubectl v1.37 prints it: several klog entries, then the message and its explanation.
    const stderr =
      entry +
      entry +
      'Unable to connect to the server: getting credentials: exec: executable kubelogin not found\n' +
      '\n' +
      'It looks like you are trying to use a client-go credential plugin that is not installed.\n' +
      '\n' +
      'To learn more about this feature, consult the documentation available at:\n' +
      '      https://kubernetes.io/docs/reference/access-authn-authz/authentication/#client-go-credential-plugins\n';
    expect(
      queryFailure({ kubectl: 'kubectl', wsl: {} }, 'get namespaces', { code: 1, stderr }).message,
    ).toBe(
      'kubectl get namespaces (in WSL) failed: Unable to connect to the server: getting credentials: ' +
        'exec: executable kubelogin not found\n' +
        'It looks like you are trying to use a client-go credential plugin that is not installed.\n' +
        'To learn more about this feature, consult the documentation available at:',
    );
  });

  it('keeps klog lines when there is nothing else', () => {
    const stderr = 'E1028 09:05:27.691553     284 memcache.go:381] "Something" err="x"\n';
    expect(queryFailure({ kubectl: 'kubectl' }, 'get pod', { code: 1, stderr }).message).toBe(
      `kubectl get pod failed: ${stderr.trim()}`,
    );
  });
});

describe('missing contexts', () => {
  it('names where kubectl looked for a kubeconfig', () => {
    expect(noContextError({}).message).toBe(
      'kubectl found no Kubernetes context in its kubeconfig (KUBECONFIG, else ~/.kube/config): ' +
        'the file does not exist or lists no contexts. Set "dev.containers.kubeconfigPath" to your ' +
        'kubeconfig.',
    );
    expect(noContextError({ kubeconfig: 'C:\\k\\config' }).message).toContain(
      'in "C:\\k\\config": the file does not exist',
    );
  });

  it('explains the usual causes in WSL', () => {
    const message = noContextError({ wsl: { distro: 'ubuntu-2404' } }).message;
    expect(message).toMatch(
      /^kubectl in WSL \(ubuntu-2404\) found no Kubernetes context in ~\/\.kube\/config/,
    );
    expect(message).toContain(
      'KUBECONFIG names in the login profile (~/.profile, ~/.bash_profile or ~/.zprofile, not ~/.bashrc)',
    );
    expect(message).toContain(
      'If your kubeconfig is on Windows, copy it into the distribution or set "dev.containers.kubeconfigPath"',
    );
    expect(message).toContain('credential plugins it names must then exist in WSL');
    expect(message).toContain('"wsl --import" runs as root');
    expect(message).toContain('"dev.containers.kubectlInWSL" to false');
    expect(noContextError({ wsl: {}, kubeconfig: '~/.kube/work' }).message).toMatch(
      /^kubectl in WSL found no Kubernetes context in "~\/\.kube\/work": the file does not exist there/,
    );
  });

  it('explains a missing current context for the explorer, with the Windows causes only there', () => {
    const windows = noCurrentContextError({ wsl: { distro: 'u' } }, 'explorer', 'win32').message;
    expect(windows).toMatch(
      /^kubectl in WSL \(u\) has no current Kubernetes context in its default kubeconfig, so it does not know the cluster of the Kubernetes explorer, which may read another kubeconfig/,
    );
    expect(windows).toContain('"vs-kubernetes.use-wsl" in the default WSL distribution');
    expect(windows).toContain('use-context <name>" in that distribution');
    const linux = noCurrentContextError({ kubeconfig: '/home/me/.kube/team' }, 'explorer', 'linux');
    expect(linux.message).toMatch(
      /^kubectl has no current Kubernetes context in "\/home\/me\/\.kube\/team"/,
    );
    expect(linux.message).not.toContain('Windows');
    expect(linux.message).toContain(
      'Set one with "kubectl config use-context <name> --kubeconfig=/home/me/.kube/team", or attach',
    );
  });

  it('explains a missing current context for a window', () => {
    expect(noCurrentContextError({}, 'window').message).toBe(
      'This window names no Kubernetes context, and kubectl has no current one. Set one with ' +
        '"kubectl config use-context <name>", or attach to the pod again.',
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
