import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../src/core/logger';
import { kiroLoginFor } from '../../src/ui/kiroLogin';
import { mcpSetupFor, VariableHint } from '../../src/ui/mcp';
import { readSettings } from '../../src/ui/settings';
import * as mock from '../helpers/vscodeMock';

describe('readSettings', () => {
  beforeEach(() => mock.reset());

  it('asks before sharing the Kiro sign-in unless the user decided otherwise', () => {
    expect(readSettings().shareKiroLogin).toBe('ask');
    for (const value of ['always', 'never', 'ask'] as const) {
      mock.state.settings['dev.containers.shareKiroLogin'] = value;
      expect(readSettings().shareKiroLogin).toBe(value);
    }
    mock.state.settings['dev.containers.shareKiroLogin'] = 'sometimes';
    expect(readSettings().shareKiroLogin).toBe('ask');
  });

  it('opens sign-in pages of kubectl in WSL in the Windows browser unless set to WSL', () => {
    expect(readSettings().kubectlWSLBrowser).toBe('windows');
    mock.state.settings['dev.containers.kubectlWSLBrowser'] = 'wsl';
    expect(readSettings().kubectlWSLBrowser).toBe('wsl');
    mock.state.settings['dev.containers.kubectlWSLBrowser'] = 'firefox';
    expect(readSettings().kubectlWSLBrowser).toBe('windows');
  });

  it('keeps the meaning of the former boolean values', () => {
    mock.state.settings['dev.containers.shareKiroLogin'] = true;
    expect(readSettings().shareKiroLogin).toBe('always');
    mock.state.settings['dev.containers.shareKiroLogin'] = false;
    expect(readSettings().shareKiroLogin).toBe('never');
  });

  it("takes programs, paths and the sign-in decision from the user's settings, not a workspace", () => {
    mock.state.workspaceSettings['dev.containers.dockerPath'] = '/workspace/docker';
    mock.state.workspaceSettings['dev.containers.devcontainerCliPath'] = '/workspace/cli.js';
    mock.state.workspaceSettings['dev.containers.shareKiroLogin'] = 'always';
    expect(readSettings()).toMatchObject({
      dockerPath: 'docker',
      devcontainerCliPath: undefined,
      shareKiroLogin: 'ask',
    });
    mock.state.settings['dev.containers.dockerPath'] = 'podman';
    expect(readSettings().dockerPath).toBe('podman');
  });

  it("keeps the user's own values in a container or pod window", () => {
    mock.state.remoteName = 'dev-container';
    mock.state.settings['dev.containers.dockerPath'] = 'podman';
    mock.state.settings['dev.containers.kubectlPath'] = '/opt/kubectl';
    expect(readSettings()).toMatchObject({ dockerPath: 'podman', kubectlPath: '/opt/kubectl' });
  });

  it('ignores values from the settings on the container side in a remote window', () => {
    mock.state.remoteName = 'dev-container';
    mock.state.settings['dev.containers.dockerPath'] = 'podman';
    mock.state.remoteSettings['dev.containers.dockerPath'] = '/elsewhere/docker';
    mock.state.remoteSettings['dev.containers.devcontainerCliPath'] = '/elsewhere/cli.js';
    mock.state.remoteSettings['dev.containers.kubectlPath'] = '/elsewhere/kubectl';
    mock.state.remoteSettings['dev.containers.shareKiroLogin'] = 'always';
    mock.state.remoteSettings['dev.containers.kubectlWSLBrowser'] = 'wsl';
    expect(readSettings()).toMatchObject({
      dockerPath: 'podman',
      devcontainerCliPath: undefined,
      kubectlPath: undefined,
      shareKiroLogin: 'ask',
      kubectlWSLBrowser: 'windows',
    });
  });

  it('ignores the settings written as an object on the container side', () => {
    mock.state.remoteName = 'dev-container';
    mock.state.remoteSettings['dev.containers'] = {
      dockerPath: '/elsewhere/docker',
      shareKiroLogin: 'always',
    };
    expect(readSettings()).toMatchObject({ dockerPath: 'docker', shareKiroLogin: 'ask' });
    mock.state.settings['dev.containers.dockerPath'] = 'podman';
    expect(readSettings().dockerPath).toBe('podman');
  });

  it('keeps the user values that the container side erases', () => {
    mock.state.remoteName = 'k8s-pod';
    mock.state.settings['dev.containers.dockerPath'] = 'podman';
    mock.state.settings['dev.containers.shareKiroLogin'] = 'never';
    for (const erase of [{ 'dev.containers': null }, { dev: 0 }]) {
      mock.state.remoteSettings = erase;
      expect(readSettings(), JSON.stringify(erase)).toMatchObject({
        dockerPath: 'podman',
        shareKiroLogin: 'never',
      });
    }
  });

  it('ignores a workspace that writes the settings as an object', () => {
    mock.state.workspaceSettings['dev.containers'] = { dockerPath: '/workspace/docker' };
    expect(readSettings().dockerPath).toBe('docker');
  });

  it('falls back to the defaults for values of the wrong type or an unknown log level', () => {
    mock.state.settings['dev.containers.dockerPath'] = 5;
    mock.state.settings['dev.containers.kubectlPath'] = { path: '/x' };
    mock.state.settings['dev.containers.logLevel'] = 'verbose';
    expect(readSettings()).toMatchObject({
      dockerPath: 'docker',
      kubectlPath: undefined,
      logLevel: 'info',
    });
    mock.state.settings['dev.containers.logLevel'] = 'trace';
    expect(readSettings().logLevel).toBe('trace');
  });
});

describe('kiroLoginFor', () => {
  const login = '{"accessToken":"x"}';
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    mock.reset();
    previousHome = process.env['HOME'];
    home = await mkdtemp(path.join(tmpdir(), 'dck-login-'));
    await mkdir(path.join(home, '.aws', 'sso', 'cache'), { recursive: true });
    await writeFile(path.join(home, '.aws', 'sso', 'cache', 'kiro-auth-token.json'), login);
    process.env['HOME'] = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')(
    'offers the sign-in with a question by default, naming the target',
    async () => {
      const share = await kiroLoginFor('the pod dev/web', new MemoryLogger());
      expect(share?.text).toBe(login);
      mock.state.answerWarning = () => 'Copy Sign-In';
      expect(await share?.confirm?.()).toBe(true);
      expect(mock.state.warnings[0]?.message).toBe('Copy your Kiro sign-in into the pod dev/web?');
      mock.state.answerWarning = () => undefined;
      expect(await share?.confirm?.()).toBe(false);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'shares without a question for "always" and not at all for "never"',
    async () => {
      mock.state.settings['dev.containers.shareKiroLogin'] = 'always';
      const share = await kiroLoginFor('x', new MemoryLogger());
      expect(share).toEqual({ text: login });
      mock.state.settings['dev.containers.shareKiroLogin'] = 'never';
      expect(await kiroLoginFor('x', new MemoryLogger())).toBeUndefined();
    },
  );
});

describe('mcpSetupFor', () => {
  let dir: string;
  beforeEach(async () => {
    mock.reset();
    dir = await mkdtemp(path.join(tmpdir(), 'dck-mcp-settings-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const hint = () => new VariableHint(new mock.MockMemento());

  it('uses the bundle the extension ships, read-only by default', async () => {
    await mkdir(path.join(dir, 'mcp'));
    await writeFile(path.join(dir, 'mcp', 'mcp-gitlab.mjs'), 'console.log(1);\n');
    mock.state.settings['dev.containers.mcpGitlab.apiUrl'] = 'https://gitlab.example/api/v4';
    const setup = await mcpSetupFor('the pod a/b', dir, hint(), new MemoryLogger());
    expect(setup).toMatchObject({
      gitlab: {
        bundle: 'console.log(1);\n',
        config: { apiUrl: 'https://gitlab.example/api/v4', readOnly: true },
      },
      servers: {},
    });
  });

  it('prefers the configured bundle, and does nothing without one or when switched off', async () => {
    const own = path.join(dir, 'own.mjs');
    await writeFile(own, 'console.log(2);\n');
    const logger = new MemoryLogger();
    expect(await mcpSetupFor('the pod a/b', dir, hint(), logger)).toBeUndefined();
    mock.state.settings['dev.containers.mcpGitlab.bundlePath'] = own;
    expect((await mcpSetupFor('the pod a/b', dir, hint(), logger))?.gitlab?.bundle).toBe(
      'console.log(2);\n',
    );
    mock.state.settings['dev.containers.mcpGitlab.enabled'] = false;
    expect(await mcpSetupFor('the pod a/b', dir, hint(), logger)).toBeUndefined();
  });

  it('ignores a bundle path from a workspace', async () => {
    const own = path.join(dir, 'own.mjs');
    await writeFile(own, 'console.log(2);\n');
    mock.state.workspaceSettings['dev.containers.mcpGitlab.bundlePath'] = own;
    expect(await mcpSetupFor('the pod a/b', dir, hint(), new MemoryLogger())).toBeUndefined();
  });

  it('passes further servers from the user settings only, also without a bundle', async () => {
    const confluence = { command: 'npx', args: ['@ai-tools/mcp-confluence@latest'] };
    mock.state.workspaceSettings['dev.containers.mcpServers'] = { evil: { command: 'x' } };
    expect(await mcpSetupFor('the pod a/b', dir, hint(), new MemoryLogger())).toBeUndefined();
    mock.state.settings['dev.containers.mcpServers'] = { confluence };
    const setup = await mcpSetupFor('the pod a/b', dir, hint(), new MemoryLogger());
    expect(setup?.gitlab).toBeUndefined();
    expect(setup?.servers).toEqual({ confluence });
  });

  it('still sets up when the setting is an empty object, so that servers written before are removed', async () => {
    mock.state.settings['dev.containers.mcpServers'] = {};
    expect((await mcpSetupFor('the pod a/b', dir, hint(), new MemoryLogger()))?.servers).toEqual(
      {},
    );
  });

  it('ignores values that only the settings in the pod have', async () => {
    mock.state.remoteName = 'k8s-pod';
    mock.state.remoteSettings['dev.containers.mcpServers'] = { evil: { command: 'x' } };
    mock.state.remoteSettings['dev.containers.mcpGitlab.bundlePath'] = path.join(dir, 'x.mjs');
    expect(await mcpSetupFor('the pod a/b', dir, hint(), new MemoryLogger())).toBeUndefined();
  });

  it('shows the hint about missing variables once per pod and window', async () => {
    const variableHint = hint();
    variableHint.show('the pod a/b', ['GITLAB_PERSONAL_ACCESS_TOKEN']);
    variableHint.show('the pod a/b', ['GITLAB_PERSONAL_ACCESS_TOKEN']);
    expect(mock.state.warnings).toHaveLength(1);
    expect(mock.state.warnings[0]?.message).toContain('GITLAB_PERSONAL_ACCESS_TOKEN');
    expect(mock.state.warnings[0]?.message).toContain('do not work until it is set');
    variableHint.show('the pod a/b', ['A_TOKEN', 'B_TOKEN']);
    expect(mock.state.warnings[1]?.message).toContain('A_TOKEN, B_TOKEN');
  });
});
