import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveAndValidateConfig } from '../../src/core/config/validate';

let root: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'dck-validate-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function write(relative: string, content: string): Promise<string> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
  return file;
}

describe('resolveAndValidateConfig', () => {
  it('returns the default config and accepts comments and trailing commas', async () => {
    const file = await write('.devcontainer/devcontainer.json', '// c\n{ "image": "x", }');
    expect(await resolveAndValidateConfig(root)).toBe(file);
  });

  it('mirrors the CLI lookup: .devcontainer/ first, then the root file, never named ones', async () => {
    const rootFile = await write('.devcontainer.json', '{}');
    await write('.devcontainer/named/devcontainer.json', '{}');
    expect(await resolveAndValidateConfig(root)).toBe(rootFile);
  });

  it('uses an explicit file as given', async () => {
    await write('.devcontainer/devcontainer.json', '{}');
    const named = await write('.devcontainer/named/devcontainer.json', '{}');
    expect(await resolveAndValidateConfig(root, named)).toBe(named);
  });

  it('reports the position of a syntax error', async () => {
    await write('.devcontainer/devcontainer.json', '{\n  "image": ,\n}');
    await expect(resolveAndValidateConfig(root)).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringMatching(/devcontainer\.json:2:\d+/),
    });
  });

  it('reports a missing configuration', async () => {
    await expect(resolveAndValidateConfig(root)).rejects.toMatchObject({
      code: 'CONFIG_NOT_FOUND',
    });
    await expect(
      resolveAndValidateConfig(root, path.join(root, 'nope.json')),
    ).rejects.toMatchObject({ code: 'CONFIG_NOT_FOUND' });
  });
});
