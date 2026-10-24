import { describe, expect, it } from 'vitest';
import { redactHome, summarizeProduct } from '../../src/core/diagnostics';

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

describe('redactHome', () => {
  it('replaces only a leading home directory', () => {
    expect(redactHome('/home/alice/.kiro/argv.json', '/home/alice')).toBe('~/.kiro/argv.json');
    expect(redactHome('/opt/home/alice/x', '/home/alice')).toBe('/opt/home/alice/x');
    expect(redactHome('/anything', '')).toBe('/anything');
  });
});
