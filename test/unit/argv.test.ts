import { describe, expect, it } from 'vitest';
import { enableProposedApi, isProposedApiEnabled } from '../../src/core/argv';

const ID = 'lldeters.devcontainers-kiro';

describe('enableProposedApi', () => {
  it('creates the file content when argv.json is empty', () => {
    const text = enableProposedApi('', ID);
    expect(JSON.parse(text)).toEqual({ 'enable-proposed-api': [ID] });
  });

  it('keeps comments and other settings and appends to an existing list', () => {
    const before = `{
    // Disable hardware acceleration
    "disable-hardware-acceleration": true,
    "enable-proposed-api": ["other.ext"],
}`;
    const after = enableProposedApi(before, ID);
    expect(after).toContain('// Disable hardware acceleration');
    expect(after).toContain('"disable-hardware-acceleration": true');
    expect(isProposedApiEnabled(after, ID)).toBe(true);
    expect(isProposedApiEnabled(after, 'other.ext')).toBe(true);
  });

  it('adds the key when it is missing', () => {
    const after = enableProposedApi('{\n  "locale": "de"\n}', ID);
    expect(after).toContain('"locale": "de"');
    expect(isProposedApiEnabled(after, ID)).toBe(true);
  });

  it('is idempotent and case-insensitive', () => {
    const once = enableProposedApi('{}', ID);
    expect(enableProposedApi(once, ID)).toBe(once);
    expect(isProposedApiEnabled(once, ID.toUpperCase())).toBe(true);
  });

  it('replaces a malformed value of the key instead of throwing', () => {
    const after = enableProposedApi('{ "enable-proposed-api": "oops" }', ID);
    expect(isProposedApiEnabled(after, ID)).toBe(true);
  });
});
