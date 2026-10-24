// The manifest and the code must agree: a command that is registered but not declared never shows
// up, and a menu entry for a command that does not exist is a dead entry.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Commands } from '../../src/ui/commands';

interface Menu {
  command: string;
  when?: string;
  group?: string;
}

const manifest = JSON.parse(
  readFileSync(path.join(__dirname, '..', '..', 'package.json'), 'utf8'),
) as {
  activationEvents: string[];
  contributes: {
    commands: { command: string; title: string }[];
    menus: Record<string, Menu[]>;
    configuration: { properties: Record<string, unknown> };
  };
};

const declared = new Set(manifest.contributes.commands.map((command) => command.command));

describe('manifest', () => {
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

  it('declares the settings the Kubernetes feature reads', () => {
    expect(Object.keys(manifest.contributes.configuration.properties)).toEqual(
      expect.arrayContaining(['dev.containers.kubectlPath', 'dev.containers.kubeconfigPath']),
    );
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
