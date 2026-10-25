import { describe, expect, it } from 'vitest';
import { redactHomeDeep, summarizeProduct } from '../../src/core/diagnostics';

describe('summarizeProduct', () => {
  const product = {
    nameShort: 'Kiro',
    version: '1.103.2',
    commit: 'abc123',
    quality: 'stable',
    dataFolderName: '.kiro',
    serverApplicationName: 'kiro-server',
    serverDataFolderName: '.kiro-server',
    updateUrl: 'https://update.example/api',
    serverGreeting: 'hello', // matches /server/
    extensionsGallery: { serviceUrl: 'https://open-vsx.org/vscode/gallery' },
    remoteExtensionTips: { a: 1 }, // matches /remote/, but structured
    extensionEnabledApiProposals: { 'some.ext': ['resolvers'] },
    // credential-looking names must never be copied, even when they match another pattern
    updateApiKey: 'SECRET-1',
    serverAuthToken: 'SECRET-2',
    downloadPassword: 'SECRET-3',
    unrelatedSetting: 'x',
  };

  it('keeps the facts that decide server support', () => {
    const { values } = summarizeProduct(product);
    expect(values).toMatchObject({
      nameShort: 'Kiro',
      version: '1.103.2',
      commit: 'abc123',
      dataFolderName: '.kiro',
      serverApplicationName: 'kiro-server',
      serverDataFolderName: '.kiro-server',
      updateUrl: 'https://update.example/api',
      serverGreeting: 'hello',
    });
  });

  it('never copies credential-like keys', () => {
    const text = JSON.stringify(summarizeProduct(product));
    expect(text).not.toContain('SECRET');
    expect(text).not.toContain('updateApiKey');
    expect(text).not.toContain('serverAuthToken');
  });

  it('lists structured keys by name only and ignores unrelated ones', () => {
    const summary = summarizeProduct(product);
    expect(summary.structuredKeys).toEqual(['remoteExtensionTips']);
    expect(JSON.stringify(summary)).not.toContain('unrelatedSetting');
    expect(JSON.stringify(summary)).not.toContain('serviceUrl');
  });

  it('reports whether proposed APIs are gated by the product', () => {
    expect(summarizeProduct(product).proposedApiKeys).toEqual({
      extensionEnabledApiProposals: true,
      extensionAllowedProposedApi: false,
    });
  });

  it('truncates very long values', () => {
    const { values } = summarizeProduct({ updateUrl: 'x'.repeat(1000) });
    expect(String(values['updateUrl']).length).toBeLessThanOrEqual(301);
  });

  it.each([null, undefined, 'text', 42, []])('tolerates a non-object product (%j)', (input) => {
    expect(summarizeProduct(input).values).toEqual({});
  });
});

describe('redactHomeDeep', () => {
  it('replaces the home directory in every string, also inside messages', () => {
    expect(
      redactHomeDeep(
        {
          path: '/home/alice/.kiro/argv.json',
          containerEngine: {
            command: '/home/alice/bin/podman',
            version: { error: 'Could not run "/home/alice/bin/podman". Install Docker.' },
          },
          list: ['/home/alice', 'x /home/alice/y'],
          count: 3,
          nothing: null,
        },
        '/home/alice',
        false,
      ),
    ).toEqual({
      path: '~/.kiro/argv.json',
      containerEngine: {
        command: '~/bin/podman',
        version: { error: 'Could not run "~/bin/podman". Install Docker.' },
      },
      list: ['~', 'x ~/y'],
      count: 3,
      nothing: null,
    });
  });

  it('does not touch a longer name that merely starts like the home directory', () => {
    expect(redactHomeDeep('/home/alice2/x and /home/alice', '/home/alice', false)).toBe(
      '/home/alice2/x and ~',
    );
  });

  it('on Windows, ignores case and accepts both kinds of slash', () => {
    expect(
      redactHomeDeep(
        'C:\\Users\\Alice\\docker.exe; c:\\users\\alice\\x; C:/Users/Alice/y',
        'C:\\Users\\Alice',
        true,
      ),
    ).toBe('~\\docker.exe; ~\\x; ~/y');
  });

  it('leaves everything alone for an empty or root home directory', () => {
    expect(redactHomeDeep('/anything', '', false)).toBe('/anything');
    expect(redactHomeDeep('/anything', '/', false)).toBe('/anything');
    expect(redactHomeDeep('C:\\x', 'C:\\', true)).toBe('C:\\x');
  });
});
