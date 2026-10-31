// The manifest and the code must agree: a command that is registered but not declared never shows
// up, and a menu entry for a command that does not exist is a dead entry.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LOCAL_ONLY_SETTINGS } from '../../src/core/config/customizations';
import { Commands } from '../../src/ui/commands';

interface Menu {
  command: string;
  when?: string;
  group?: string;
}

const manifest = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as {
  icon?: string;
  activationEvents: string[];
  contributes: {
    commands: { command: string; title: string }[];
    menus: Record<string, Menu[]>;
    configuration: { properties: Record<string, unknown> };
  };
};

const declared = new Set(manifest.contributes.commands.map((command) => command.command));

describe('manifest', () => {
  it('has a PNG icon that is packaged (registries do not accept SVG icons)', () => {
    expect(manifest.icon).toBe('media/icon.png');
    const png = readFileSync(path.join(__dirname, '..', '..', manifest.icon ?? ''));
    expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(128); // width
    const ignore = readFileSync(path.join(__dirname, '..', '..', '.vscodeignore'), 'utf8');
    expect(ignore.split('\n')).toContain(`!${manifest.icon}`);
  });

  it('declares every command the code registers', () => {
    for (const id of Object.values(Commands)) {
      expect(declared.has(id), id).toBe(true);
    }
  });

  it('has no declared command without an implementation', () => {
    const registered = new Set<string>(Object.values(Commands));
    for (const id of declared) {
      expect(registered.has(id), id).toBe(true);
    }
  });

  it('only references declared commands in menus', () => {
    for (const [menu, entries] of Object.entries(manifest.contributes.menus)) {
      for (const entry of entries) {
        expect(declared.has(entry.command), `${menu}: ${entry.command}`).toBe(true);
      }
    }
  });

  it('gives every command a title', () => {
    for (const command of manifest.contributes.commands) {
      expect(command.title.trim(), command.command).not.toBe('');
    }
  });

  it('activates when a remote window of either kind is opened', () => {
    expect(manifest.activationEvents).toEqual(
      expect.arrayContaining([
        'onResolveRemoteAuthority:dev-container',
        'onResolveRemoteAuthority:k8s-pod',
      ]),
    );
  });

  it('asks before sharing the Kiro sign-in by default, switchable only in the user settings', () => {
    const setting = manifest.contributes.configuration.properties['dev.containers.shareKiroLogin'];
    expect(setting).toMatchObject({
      type: 'string',
      enum: ['ask', 'always', 'never'],
      default: 'ask',
      scope: 'application',
    });
  });

  it('declares the settings the Kubernetes feature reads', () => {
    expect(Object.keys(manifest.contributes.configuration.properties)).toEqual(
      expect.arrayContaining([
        'dev.containers.kubectlPath',
        'dev.containers.kubeconfigPath',
        'dev.containers.kubectlInWSL',
        'dev.containers.kubectlWSLDistro',
      ]),
    );
  });

  it('lets only the user decide which programs and paths are used, never a workspace or container', () => {
    // Scope `application`: only the local user settings count. With `machine`, a container or pod
    // window would take the value from the settings on the container side.
    const properties = manifest.contributes.configuration.properties;
    for (const key of [
      'dev.containers.dockerPath',
      'dev.containers.dockerComposePath',
      'dev.containers.devcontainerCliPath',
      'dev.containers.serverDownloadUrlTemplate',
      'dev.containers.kubectlPath',
      'dev.containers.kubeconfigPath',
      'dev.containers.kubectlInWSL',
      'dev.containers.kubectlWSLDistro',
    ]) {
      // Paths of this machine: kept out of Settings Sync, as they were with scope `machine`.
      expect(properties[key], key).toMatchObject({ scope: 'application', ignoreSync: true });
    }
    expect(properties['dev.containers.kubectlInWSL']).toMatchObject({
      type: 'boolean',
      default: false,
    });
  });

  it('keeps from a devcontainer.json exactly the settings with scope application', () => {
    const application = Object.entries(manifest.contributes.configuration.properties)
      .filter(([, value]) => (value as { scope?: string }).scope === 'application')
      .map(([key]) => key);
    expect([...LOCAL_ONLY_SETTINGS].sort()).toEqual(application.sort());
  });

  it('has no setting with scope machine, which remote windows read from the remote side', () => {
    for (const [key, value] of Object.entries(manifest.contributes.configuration.properties)) {
      expect((value as { scope?: string }).scope, key).not.toBe('machine');
    }
  });
});

describe('"Attach to Kiro" in the Kubernetes explorer', () => {
  const entries = manifest.contributes.menus['view/item/context'] ?? [];
  const attach = entries.find((entry) => entry.command === Commands.attachToPod);

  it('is offered on the explorer view', () => {
    expect(attach).toBeDefined();
    expect(attach?.when).toContain('view == extension.vsKubernetesExplorer');
  });

  it('matches pod nodes and nothing else', () => {
    const pattern = /viewItem =~ \/(.+)\/i/.exec(attach?.when ?? '')?.[1];
    expect(pattern).toBeDefined();
    const matches = (value: string): boolean => new RegExp(pattern as string, 'i').test(value);
    expect(matches('vsKubernetes.resource.pod')).toBe(true);
    expect(matches('vsKubernetes.resource.service')).toBe(false);
    expect(matches('vsKubernetes.resource.deployment')).toBe(false);
    expect(matches('vsKubernetes.resource.namespace')).toBe(false);
    expect(matches('vsKubernetes.cluster')).toBe(false);
  });

  it('is titled like the original menu entry and hidden from the palette', () => {
    const command = manifest.contributes.commands.find((c) => c.command === Commands.attachToPod);
    expect(command?.title).toBe('Attach to Kiro');
    const hidden = manifest.contributes.menus['commandPalette']?.find(
      (entry) => entry.command === Commands.attachToPod,
    );
    expect(hidden?.when).toBe('false');
  });

  it('has a palette command that also works without the Kubernetes extension', () => {
    const palette = manifest.contributes.menus['commandPalette']?.find(
      (entry) => entry.command === Commands.attachToKubernetesContainer,
    );
    expect(palette?.when).toBe('!remoteName');
  });
});
