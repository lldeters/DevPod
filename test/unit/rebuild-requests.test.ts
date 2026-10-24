import { describe, expect, it } from 'vitest';
import type * as vscode from 'vscode';
import { REBUILD_REQUEST_MAX_AGE_MS, RebuildRequests } from '../../src/remote/rebuildRequests';
import { MockMemento } from '../helpers/vscodeMock';

describe('RebuildRequests', () => {
  const authority = 'dev-container+abcd';
  const memento = (): vscode.Memento => new MockMemento() as unknown as vscode.Memento;

  it('hands a request out exactly once', async () => {
    const requests = new RebuildRequests(memento());
    await requests.request(authority, { noCache: true });
    expect(await requests.take(authority)).toEqual({ noCache: true });
    expect(await requests.take(authority)).toBeUndefined();
  });

  it('drops a request that waited too long, so a later open does not rebuild', async () => {
    let now = 1_000_000;
    const requests = new RebuildRequests(memento(), () => now);
    await requests.request(authority, { noCache: false });
    now += REBUILD_REQUEST_MAX_AGE_MS + 1;
    expect(await requests.take(authority)).toBeUndefined();
    expect(await requests.take(authority)).toBeUndefined(); // and it is gone
  });

  it('still carries out a request after a short delay (e.g. starting Docker first)', async () => {
    let now = 1_000_000;
    const requests = new RebuildRequests(memento(), () => now);
    await requests.request(authority, { noCache: false });
    now += 5 * 60 * 1000;
    expect(await requests.take(authority)).toEqual({ noCache: false });
  });

  it('ignores a request stored without a time (written by an older version)', async () => {
    const state = memento();
    await state.update(`rebuild:${authority}`, { noCache: true });
    expect(await new RebuildRequests(state).take(authority)).toBeUndefined();
  });
});
