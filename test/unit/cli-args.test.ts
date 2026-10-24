import { describe, expect, it } from 'vitest';
import { readConfigurationArgs, upArgs } from '../../src/core/cli/args';
import { resolveCliLocation } from '../../src/core/cli/devcontainerCli';

describe('upArgs', () => {
  it('emits the minimum for a plain folder', () => {
    expect(upArgs({ workspaceFolder: '/w' })).toEqual([
      'up',
      '--workspace-folder',
      '/w',
      '--log-level',
      'info',
      '--log-format',
      'json',
    ]);
  });

  it('adds explicit configuration, engine paths and rebuild flags', () => {
    const args = upArgs({
      workspaceFolder: '/w',
      configFile: '/w/.devcontainer/a/devcontainer.json',
      dockerPath: 'podman',
      dockerComposePath: '/usr/bin/docker-compose',
      logLevel: 'debug',
      removeExistingContainer: true,
      buildNoCache: true,
      includeConfiguration: true,
    });
    expect(args).toEqual(
      expect.arrayContaining([
        '--config',
        '/w/.devcontainer/a/devcontainer.json',
        '--docker-path',
        'podman',
        '--docker-compose-path',
        '/usr/bin/docker-compose',
        '--remove-existing-container',
        '--build-no-cache',
        '--include-configuration',
      ]),
    );
    expect(args[args.indexOf('--log-level') + 1]).toBe('debug');
    expect(args).not.toContain('--skip-post-create');
  });

  it('passes remote environment variables and dotfiles as separate arguments', () => {
    const args = upArgs({
      workspaceFolder: '/w',
      remoteEnv: { A: '1', B: 'x y' },
      dotfiles: { repository: 'https://example.com/d.git', installCommand: 'make' },
    });
    expect(args).toEqual(
      expect.arrayContaining([
        '--remote-env',
        'A=1',
        'B=x y',
        '--dotfiles-repository',
        'https://example.com/d.git',
        '--dotfiles-install-command',
        'make',
      ]),
    );
    expect(args).not.toContain('--dotfiles-target-path');
  });

  it('keeps hostile values as single arguments', () => {
    const hostile = '/w; rm -rf / $(id)';
    expect(upArgs({ workspaceFolder: hostile })[2]).toBe(hostile);
  });
});

describe('readConfigurationArgs', () => {
  it('requests merged configuration only when asked', () => {
    expect(readConfigurationArgs({ workspaceFolder: '/w' })).not.toContain(
      '--include-merged-configuration',
    );
    expect(
      readConfigurationArgs({ workspaceFolder: '/w', includeMergedConfiguration: true }),
    ).toContain('--include-merged-configuration');
  });
});

describe('resolveCliLocation', () => {
  it('prefers a user-provided executable', () => {
    expect(
      resolveCliLocation({
        customPath: ' /opt/devcontainer ',
        bundledEntry: '/e.js',
        nodeExecutable: 'n',
      }),
    ).toEqual({ command: '/opt/devcontainer', args: [] });
  });

  it('runs the bundled CLI through the IDE binary as Node', () => {
    expect(
      resolveCliLocation({ customPath: '', bundledEntry: '/e.js', nodeExecutable: '/ide' }),
    ).toEqual({
      command: '/ide',
      args: ['/e.js'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it('runs a user-provided .js file as Node, too', () => {
    expect(
      resolveCliLocation({
        customPath: '/opt/cli/devcontainer.js',
        bundledEntry: '/e.js',
        nodeExecutable: '/ide',
      }),
    ).toEqual({
      command: '/ide',
      args: ['/opt/cli/devcontainer.js'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
  });

  it("runs the script behind npm's Windows wrapper instead of the batch file", () => {
    const shim = 'C:\\Users\\me\\AppData\\Roaming\\npm\\devcontainer.cmd';
    const entry =
      'C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@devcontainers\\cli\\devcontainer.js';
    expect(
      resolveCliLocation({
        customPath: shim,
        bundledEntry: '/e.js',
        nodeExecutable: 'C:\\Kiro\\Kiro.exe',
        exists: (file) => file === entry,
      }),
    ).toEqual({ command: 'C:\\Kiro\\Kiro.exe', args: [entry], env: { ELECTRON_RUN_AS_NODE: '1' } });
  });

  it('explains what to set when a batch file cannot be mapped to the script', () => {
    expect(() =>
      resolveCliLocation({
        customPath: 'D:\\tools\\devcontainer.bat',
        bundledEntry: '/e.js',
        nodeExecutable: 'n',
        exists: () => false,
      }),
    ).toThrowError(/batch file.*devcontainer\.js/s);
  });
});
