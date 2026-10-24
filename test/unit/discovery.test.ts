import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverConfigs } from '../../src/core/config/discovery';

let root: string;

async function write(relative: string, content: string): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dck-discovery-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('discoverConfigs', () => {
  it('returns nothing for a folder without configuration', async () => {
    expect(await discoverConfigs(root)).toEqual([]);
  });

  it('finds the default location and reads its name', async () => {
    await write('.devcontainer/devcontainer.json', '{ // c\n "name": "Default", }');
    const [config, ...rest] = await discoverConfigs(root);
    expect(rest).toEqual([]);
    expect(config).toMatchObject({
      relativePath: '.devcontainer/devcontainer.json',
      kind: 'default',
      name: 'Default',
    });
    expect(config?.path).toBe(path.join(root, '.devcontainer', 'devcontainer.json'));
  });

  it('orders default, root, then named configurations alphabetically', async () => {
    await write('.devcontainer/zeta/devcontainer.json', '{"name":"Z"}');
    await write('.devcontainer/alpha/devcontainer.json', '{"name":"A"}');
    await write('.devcontainer.json', '{}');
    await write('.devcontainer/devcontainer.json', '{}');
    const found = await discoverConfigs(root);
    expect(found.map((c) => c.relativePath)).toEqual([
      '.devcontainer/devcontainer.json',
      '.devcontainer.json',
      '.devcontainer/alpha/devcontainer.json',
      '.devcontainer/zeta/devcontainer.json',
    ]);
    expect(found.map((c) => c.kind)).toEqual(['default', 'root', 'named', 'named']);
  });

  it('does not look deeper than one folder level', async () => {
    await write('.devcontainer/a/b/devcontainer.json', '{}');
    expect(await discoverConfigs(root)).toEqual([]);
  });

  it('ignores folders without a devcontainer.json', async () => {
    await write('.devcontainer/empty/readme.md', 'x');
    expect(await discoverConfigs(root)).toEqual([]);
  });

  it('still lists a file with invalid JSON, just without a name', async () => {
    await write('.devcontainer.json', '{ "name": ');
    const [config] = await discoverConfigs(root);
    expect(config?.kind).toBe('root');
    expect(config?.name).toBeUndefined();
  });
});
