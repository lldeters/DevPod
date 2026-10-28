// End-to-end test of kubectl in WSL through a real wsl.exe. It runs only on Windows with
// DCK_E2E_WSL=1 (CI installs a distribution with setup-wsl); DCK_WSL_DISTRO names the
// distribution, else the default one is used. It adds lines to ~/.profile in the distribution and
// restores the file afterwards.
//
// The wrapper's logic is covered with a local sh in test/unit/wsl.test.ts. This checks what only
// Windows shows: that every argument survives the Windows command line and wsl.exe unchanged, that
// stdin and stdout pass through byte for byte and the end of stdin arrives, and that `wslpath`,
// `--cd ~` and the user's login shell behave as the wrapper expects.
import { spawn, spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Kubectl } from '../../src/core/k8s/kubectl';
import { kubectlProcess, wslExecutable } from '../../src/core/k8s/launcher';
import type { KubectlLauncher, WslSelection } from '../../src/core/k8s/launcher';
import { BRIDGE_SCRIPT } from '../../src/core/server/script';

const enabled = process.platform === 'win32' && process.env['DCK_E2E_WSL'] === '1';
const distro = process.env['DCK_WSL_DISTRO'] || undefined;
const wsl: WslSelection = distro === undefined ? {} : { distro };

/** Runs a setup command in the distribution, outside the code under test. */
function inWsl(script: string, input = ''): string {
  const result = spawnSync(
    wslExecutable(),
    [...(distro ? ['--distribution', distro] : []), '--exec', '/bin/sh', '-c', script],
    { input, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    throw new Error(`WSL setup failed (${result.status}): ${result.stderr.replace(/\0/g, '')}`);
  }
  return result.stdout;
}

/** Runs the launcher like the extension does, with binary input, and collects binary output. */
function launch(
  launcher: KubectlLauncher,
  args: string[],
  input: Buffer = Buffer.alloc(0),
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  const { command, args: processArgs } = kubectlProcess(launcher, args);
  return new Promise((resolve, reject) => {
    const child = spawn(command, processArgs, { stdio: 'pipe', windowsHide: true });
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out), stderr }));
    child.stdin.end(input);
  });
}

function nulSeparated(output: Buffer): string[] {
  return output.toString('utf8').split('\0').slice(0, -1);
}

describe.skipIf(!enabled)('kubectl in WSL end to end', () => {
  let home: string;

  beforeAll(() => {
    home = inWsl('printf %s "$HOME"');
    // File contents travel through stdin, so the setup does not depend on what is tested here.
    inWsl(
      'mkdir -p "$HOME/dck-e2e/bin" && cat > "$HOME/dck-e2e/bin/argv-dump" && ' +
        'chmod +x "$HOME/dck-e2e/bin/argv-dump"',
      // Prints KUBECONFIG and every argument, NUL-terminated.
      '#!/bin/sh\nprintf \'%s\\0\' "${KUBECONFIG-unset}"\nfor a; do printf \'%s\\0\' "$a"; done\n',
    );
    inWsl(
      '{ cp "$HOME/.profile" "$HOME/dck-e2e/profile.orig" 2>/dev/null || :; } && cat >> "$HOME/.profile"',
      // A profile that prints, reads stdin, and sets PATH and KUBECONFIG.
      '\necho noise-from-profile\nread -r dck_line\n' +
        'export PATH="$HOME/dck-e2e/bin:$PATH"\nexport KUBECONFIG=/from/profile\n',
    );
  });

  afterAll(() => {
    if (!enabled) return;
    inWsl(
      'if [ -f "$HOME/dck-e2e/profile.orig" ]; then cp "$HOME/dck-e2e/profile.orig" "$HOME/.profile"; ' +
        'else rm -f "$HOME/.profile"; fi; rm -rf "$HOME/dck-e2e"',
    );
  });

  it('passes every argument through the Windows command line unchanged', async () => {
    const args = [
      '--kubeconfig=/abs/config',
      'exec',
      '-i',
      '--',
      'node',
      '-e',
      BRIDGE_SCRIPT,
      'a b',
      'a b\\',
      'quote"inside',
      '"quoted"',
      "it's",
      '',
      '$HOME `id` $(id) %PATH% ^& |',
      'back\\slash\\',
      'ünïcödé ✓',
      'two\nlines',
    ];
    const result = await launch({ kubectl: 'argv-dump', wsl }, args);
    expect(result.code, result.stderr).toBe(0);
    // the kubeconfig arrives as KUBECONFIG; the login profile's output does not appear
    expect(nulSeparated(result.stdout)).toEqual(['/abs/config', ...args.slice(1)]);
  });

  it('passes stdin and stdout through byte for byte, and ends when stdin ends', async () => {
    const input = Buffer.alloc(256 * 1024);
    for (let i = 0; i < input.length; i++) input[i] = (i * 7 + (i >> 8)) & 0xff;
    const result = await launch({ kubectl: '/bin/cat', wsl }, [], input);
    expect(result.code).toBe(0);
    expect(result.stdout.equals(input)).toBe(true); // nor did the profile read any of it
  });

  it('expands ~/ to the Linux home and converts a Windows kubeconfig path', async () => {
    const tilde = await launch({ kubectl: '~/dck-e2e/bin/argv-dump', wsl }, [
      '--kubeconfig=~/.kube/config',
      'get',
    ]);
    expect(nulSeparated(tilde.stdout)).toEqual([`${home}/.kube/config`, 'get']);
    const windows = await launch({ kubectl: 'argv-dump', wsl }, [
      '--kubeconfig=C:\\Windows\\System32\\drivers\\etc\\hosts',
      'get',
    ]);
    expect(nulSeparated(windows.stdout)[0]).toMatch(
      /^\/.+\/c\/Windows\/System32\/drivers\/etc\/hosts$/i,
    );
  });

  it('passes a list of kubeconfig files, also Windows paths into the distribution, as KUBECONFIG', async () => {
    const name = distro ?? 'default';
    const inside = `\\\\wsl.localhost\\${name}${home.replace(/\//g, '\\')}\\.kube\\iat.yaml`;
    const result = await launch({ kubectl: 'argv-dump', wsl }, [
      `--kubeconfig=${inside};//wsl$/${name.toLowerCase()}${home}/.kube/prd.yaml;~/.kube/dev.yaml`,
      'get',
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(nulSeparated(result.stdout)).toEqual([
      `${home}/.kube/iat.yaml:${home}/.kube/prd.yaml:${home}/.kube/dev.yaml`,
      'get',
    ]);
  });

  it('starts in the Linux home directory', async () => {
    const result = await launch({ kubectl: '/bin/pwd', wsl }, []);
    expect(result.stdout.toString('utf8').trim()).toBe(home);
  });

  it('explains a kubectl that is missing in WSL', async () => {
    const kubectl = new Kubectl(
      (mode) => ({ kubectl: 'no-such-kubectl', ...(mode ? { wsl: mode } : {}) }),
      () => ({ wsl }),
    );
    await expect(kubectl.currentContext()).rejects.toThrow(
      /kubectl was not found in WSL.*~\/\.profile/s,
    );
  });

  it('reports a distribution that does not exist in readable text', async () => {
    const kubectl = new Kubectl(
      (mode) => ({ kubectl: 'kubectl', ...(mode ? { wsl: mode } : {}) }),
      () => ({ wsl: { distro: 'NoSuchDistro' } }),
    );
    const error = await kubectl.currentContext().then(
      () => undefined,
      (failure: unknown) => failure as Error,
    );
    // Shown in the job log: the exact text depends on the WSL version on the runner.
    console.log(`Message for a missing distribution: ${error?.message}`);
    expect(error?.message).toMatch(/NoSuchDistro/);
    // Current WSL prints the code WSL_E_DISTRO_NOT_FOUND, which gets this extension's own message;
    // older versions print only a sentence, which is passed on.
    expect(error?.message).toMatch(
      /WSL has no distribution named "NoSuchDistro" \(WSL_E_DISTRO_NOT_FOUND\)|failed: .*distribution/i,
    );
    expect(error?.message).not.toContain('\0');
  });
});
