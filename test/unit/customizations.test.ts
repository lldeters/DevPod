import { describe, expect, it } from 'vitest';
import {
  extractCustomizations,
  extractForwardPorts,
  extractRemoteEnv,
  portsAttributesSettings,
} from '../../src/core/config/customizations';
import { isValidExtensionId } from '../../src/core/extensionId';

describe('isValidExtensionId', () => {
  it.each(['esbenp.prettier-vscode', 'redhat.vscode-yaml', 'a.b', 'Foo_Bar.baz-1', 'x.y.z'])(
    'accepts %s',
    (id) => expect(isValidExtensionId(id)).toBe(true),
  );

  it.each([
    '',
    'nodot',
    '.leading',
    'trailing.',
    'a b.c',
    'a.b@1.2.3',
    'a.b;c',
    '$(id).x',
    'https://x.y/z.vsix',
    'a'.repeat(300) + '.b',
  ])('rejects %j', (id) => expect(isValidExtensionId(id)).toBe(false));
});

describe('extractCustomizations', () => {
  it('reads customizations.vscode from a plain devcontainer.json shape', () => {
    const result = extractCustomizations({
      customizations: {
        vscode: { extensions: ['esbenp.prettier-vscode'], settings: { 'editor.tabSize': 2 } },
      },
    });
    expect(result.extensions).toEqual(['esbenp.prettier-vscode']);
    expect(result.settings).toEqual({ 'editor.tabSize': 2 });
    expect(result.rejectedExtensions).toEqual([]);
  });

  it('reads the per-source arrays of a merged configuration (config plus Features)', () => {
    const result = extractCustomizations({
      customizations: {
        vscode: [
          { extensions: ['a.one'], settings: { x: 1, y: 1 } },
          { extensions: ['b.two', 'a.one'], settings: { y: 2 } },
        ],
      },
    });
    expect(result.extensions).toEqual(['a.one', 'b.two']);
    expect(result.settings).toEqual({ x: 1, y: 2 }); // later sources override earlier ones
  });

  it('lets customizations.kiro override customizations.vscode', () => {
    const result = extractCustomizations({
      customizations: {
        vscode: { extensions: ['a.one'], settings: { 'editor.fontSize': 12, keep: true } },
        kiro: { extensions: ['b.two'], settings: { 'editor.fontSize': 16 } },
      },
    });
    expect(result.extensions).toEqual(['a.one', 'b.two']);
    expect(result.settings).toEqual({ 'editor.fontSize': 16, keep: true });
  });

  it('de-duplicates ids case-insensitively, keeping the first spelling', () => {
    expect(
      extractCustomizations({
        customizations: { vscode: { extensions: ['Foo.Bar', 'foo.bar', 'FOO.BAR'] } },
      }).extensions,
    ).toEqual(['Foo.Bar']);
  });

  it('reports entries that are not plain ids instead of using them', () => {
    const result = extractCustomizations({
      customizations: { vscode: { extensions: ['ok.id', 'ms-python.python@2024.1', 'bad id', 7] } },
    });
    expect(result.extensions).toEqual(['ok.id']);
    expect(result.rejectedExtensions).toEqual(['ms-python.python@2024.1', 'bad id']);
  });

  it.each([
    {},
    { customizations: null },
    { customizations: [] },
    { customizations: { vscode: 5 } },
  ])('tolerates a configuration without usable customizations (%j)', (config) => {
    expect(extractCustomizations(config)).toEqual({
      extensions: [],
      settings: {},
      rejectedExtensions: [],
      ignoredSettings: [],
    });
  });

  it('ignores non-object settings', () => {
    expect(
      extractCustomizations({ customizations: { vscode: { settings: ['x'] } } }).settings,
    ).toEqual({});
  });

  it("reports this extension's settings instead of writing them into the container", () => {
    const result = extractCustomizations({
      customizations: {
        vscode: {
          settings: {
            'editor.tabSize': 2,
            'dev.containers.dockerPath': '/x/docker',
            'dev.containers': { kubectlPath: '/x/kubectl' },
            dev: { containers: { devcontainerCliPath: '/x/cli.js' } },
            'dev.containersExtra': true,
            'dev.containers.logLevel': 'debug',
          },
        },
        kiro: { settings: { 'dev.containers.dockerPath': '/y/docker' } },
      },
    });
    // logLevel is no program or path: it applies in the container window, as before.
    expect(result.settings).toEqual({
      'editor.tabSize': 2,
      'dev.containersExtra': true,
      'dev.containers.logLevel': 'debug',
    });
    expect(result.ignoredSettings).toEqual(['dev.containers.dockerPath', 'dev.containers', 'dev']);
  });
});

describe('extractForwardPorts', () => {
  it('accepts numbers and host:port strings', () => {
    expect(
      extractForwardPorts({ forwardPorts: [3000, '8080', 'db:5432', 'localhost:9000'] }),
    ).toEqual({
      ports: [
        { host: 'localhost', port: 3000 },
        { host: 'localhost', port: 8080 },
        { host: 'db', port: 5432 },
        { host: 'localhost', port: 9000 },
      ],
      rejected: [],
    });
  });

  it('drops duplicates', () => {
    expect(extractForwardPorts({ forwardPorts: [3000, '3000', 'localhost:3000'] }).ports).toEqual([
      { host: 'localhost', port: 3000 },
    ]);
  });

  it.each([0, 65536, -1, 1.5, 'abc', 'host:', ':80', 'a b:80', 'x;y:80', null, {}])(
    'rejects %j',
    (entry) => {
      const result = extractForwardPorts({ forwardPorts: [entry] });
      expect(result.ports).toEqual([]);
      expect(result.rejected).toHaveLength(1);
    },
  );

  it('returns nothing without forwardPorts', () => {
    expect(extractForwardPorts({})).toEqual({ ports: [], rejected: [] });
    expect(extractForwardPorts({ forwardPorts: 3000 })).toEqual({ ports: [], rejected: [] });
  });
});

describe('portsAttributesSettings', () => {
  it('maps both attribute blocks to the matching remote.* settings', () => {
    const portsAttributes = { '3000': { label: 'App', onAutoForward: 'notify' } };
    const otherPortsAttributes = { onAutoForward: 'silent' };
    expect(portsAttributesSettings({ portsAttributes, otherPortsAttributes })).toEqual({
      'remote.portsAttributes': portsAttributes,
      'remote.otherPortsAttributes': otherPortsAttributes,
    });
  });

  it('ignores missing or malformed blocks', () => {
    expect(portsAttributesSettings({})).toEqual({});
    expect(portsAttributesSettings({ portsAttributes: [1], otherPortsAttributes: 'x' })).toEqual(
      {},
    );
  });
});

describe('extractRemoteEnv', () => {
  it('passes strings and null (to remove a variable) through', () => {
    expect(
      extractRemoteEnv({ remoteEnv: { PATH: '/opt/bin:/usr/bin', EMPTY: '', GONE: null } }),
    ).toEqual({ env: { PATH: '/opt/bin:/usr/bin', EMPTY: '', GONE: null }, rejected: [] });
  });

  it('rejects values of other types and unusable names', () => {
    expect(extractRemoteEnv({ remoteEnv: { N: 1, O: {}, 'A=B': 'x', OK: 'y' } })).toEqual({
      env: { OK: 'y' },
      rejected: ['N', 'O', 'A=B'],
    });
  });

  it('returns nothing without remoteEnv', () => {
    expect(extractRemoteEnv({})).toEqual({ env: {}, rejected: [] });
    expect(extractRemoteEnv({ remoteEnv: ['A=1'] })).toEqual({ env: {}, rejected: [] });
  });
});
