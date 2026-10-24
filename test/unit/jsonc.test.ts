import { describe, expect, it } from 'vitest';
import { parseJsonc } from '../../src/core/config/jsonc';
import { DevContainerError } from '../../src/core/errors';

describe('parseJsonc', () => {
  it('accepts comments and trailing commas', () => {
    const text = `// leading comment
{
  /* block */ "name": "x",
  "forwardPorts": [3000, 4000,],
}`;
    expect(parseJsonc(text, 'f')).toEqual({ name: 'x', forwardPorts: [3000, 4000] });
  });

  it('treats an empty document as an empty object', () => {
    expect(parseJsonc('', 'f')).toEqual({});
    expect(parseJsonc('  // only a comment\n', 'f')).toEqual({});
  });

  it('rejects non-object documents', () => {
    expect(() => parseJsonc('[1]', 'f')).toThrow(DevContainerError);
    expect(() => parseJsonc('"x"', 'f')).toThrow(/top-level/);
  });

  it('reports the position of a syntax error', () => {
    try {
      parseJsonc('{\n  "a": ,\n}', 'devcontainer.json');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DevContainerError);
      expect((error as DevContainerError).code).toBe('CONFIG_INVALID');
      expect((error as Error).message).toMatch(/^devcontainer\.json:2:\d+:/);
    }
  });
});
