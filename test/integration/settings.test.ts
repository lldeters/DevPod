import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../src/core/logger';
import { kiroLoginFor } from '../../src/ui/kiroLogin';
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
    expect(readSettings()).toMatchObject({
      dockerPath: 'podman',
      devcontainerCliPath: undefined,
      kubectlPath: undefined,
      shareKiroLogin: 'ask',
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
