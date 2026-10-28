import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { PodKubectlPaths } from '../../src/remote/podKubectlPaths';
import { MockMemento } from '../helpers/vscodeMock';

const store = (memento = new MockMemento()) => ({
  memento,
  paths: new PodKubectlPaths(memento as unknown as vscode.Memento),
});

describe('PodKubectlPaths', () => {
  it('keeps one path per authority and forgets it when there is none', async () => {
    const { paths } = store();
    await paths.set('k8s-pod+aa', '/opt/kubectl');
    await paths.set('k8s-pod+bb', '/usr/local/bin/kubectl');
    await paths.set('k8s-pod+aa', '/opt/new/kubectl');
    expect(paths.get('k8s-pod+aa')).toBe('/opt/new/kubectl');
    expect(paths.get('k8s-pod+bb')).toBe('/usr/local/bin/kubectl');
    expect(paths.get('k8s-pod+cc')).toBeUndefined();
    await paths.set('k8s-pod+aa', undefined);
    await paths.set('k8s-pod+bb', '');
    expect(paths.get('k8s-pod+aa')).toBeUndefined();
    expect(paths.get('k8s-pod+bb')).toBeUndefined();
  });

  it('drops the oldest beyond 200 windows', async () => {
    const { paths } = store();
    for (let index = 0; index <= 200; index++) await paths.set(`k8s-pod+${index}`, `/k/${index}`);
    expect(paths.get('k8s-pod+0')).toBeUndefined();
    expect(paths.get('k8s-pod+1')).toBe('/k/1');
    expect(paths.get('k8s-pod+200')).toBe('/k/200');
  });

  it('ignores stored values of the wrong shape', async () => {
    const memento = new MockMemento();
    await memento.update('podKubectlPaths', [
      ['k8s-pod+aa', 42],
      ['k8s-pod+bb'],
      'k8s-pod+cc',
      ['k8s-pod+dd', ''],
      ['k8s-pod+ee', '/opt/kubectl'],
    ]);
    const { paths } = store(memento);
    for (const authority of ['k8s-pod+aa', 'k8s-pod+bb', 'k8s-pod+cc', 'k8s-pod+dd']) {
      expect(paths.get(authority)).toBeUndefined();
    }
    expect(paths.get('k8s-pod+ee')).toBe('/opt/kubectl');
    await memento.update('podKubectlPaths', { 'k8s-pod+ee': '/opt/kubectl' });
    expect(paths.get('k8s-pod+ee')).toBeUndefined();
  });
});
