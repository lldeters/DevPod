import { describe, expect, it } from 'vitest';
import {
  detectPlatformScript,
  parsePlatform,
  PLATFORM_MARKER,
} from '../../src/core/server/platform';
import { parseServerBuildInfo } from '../../src/core/server/productInfo';
import { expandUrlTemplate, urlForLog } from '../../src/core/server/template';

const product = {
  commit: 'abc123',
  quality: 'stable',
  version: '1.103.2',
  serverApplicationName: 'kiro-server',
  serverDataFolderName: '.kiro-server',
};

describe('parseServerBuildInfo', () => {
  it('extracts the fields the server needs', () => {
    expect(parseServerBuildInfo(product)).toEqual(product);
  });

  it('includes a declared download template', () => {
    expect(
      parseServerBuildInfo({ ...product, serverDownloadUrlTemplate: 'https://h/${commit}' })
        .downloadUrlTemplate,
    ).toBe('https://h/${commit}');
  });

  it('defaults the quality', () => {
    const { quality: _quality, ...rest } = product;
    expect(parseServerBuildInfo(rest).quality).toBe('stable');
  });

  it('rejects builds without a commit', () => {
    const { commit: _commit, ...rest } = product;
    expect(() => parseServerBuildInfo(rest)).toThrowError(/commit/);
  });

  it('rejects builds without remote metadata', () => {
    const { serverApplicationName: _name, ...rest } = product;
    expect(() => parseServerBuildInfo(rest)).toThrowError(/remote-server metadata/);
    expect(() => parseServerBuildInfo(null)).toThrow();
  });
});

describe('expandUrlTemplate', () => {
  const vars = {
    commit: 'c1',
    quality: 'stable',
    version: '1.2.3',
    os: 'linux',
    arch: 'x64',
  };

  it('substitutes known placeholders', () => {
    expect(
      expandUrlTemplate('https://h/${quality}/${commit}/server-${os}-${arch}.tar.gz', vars),
    ).toBe('https://h/stable/c1/server-linux-x64.tar.gz');
  });

  it('rejects unknown placeholders instead of passing them through', () => {
    expect(() => expandUrlTemplate('https://h/${nope}', vars)).toThrowError(/nope/);
  });

  it('rejects placeholders without a value', () => {
    expect(() => expandUrlTemplate('https://h/${quality}', { ...vars, quality: '' })).toThrowError(
      /no value/,
    );
  });

  it('knows no ${release}, which no IDE build provides', () => {
    expect(() => expandUrlTemplate('https://h/${release}', vars)).toThrowError(
      /Unknown placeholder \$\{release\}/,
    );
  });

  it('percent-encodes substituted values', () => {
    expect(expandUrlTemplate('https://h/${commit}', { ...vars, commit: 'a/b c' })).toBe(
      'https://h/a%2Fb%20c',
    );
  });

  it('only allows https and file URLs', () => {
    expect(() => expandUrlTemplate('ftp://h/x', vars)).toThrowError(/https/);
    expect(() => expandUrlTemplate('http://h/${commit}', vars)).toThrowError(/https/);
    expect(() => expandUrlTemplate('${commit}', vars)).toThrowError(/https/);
    expect(expandUrlTemplate('file:///tmp/${commit}.tar.gz', vars)).toBe('file:///tmp/c1.tar.gz');
  });
});

describe('parsePlatform', () => {
  const output = (kv: string[]): string =>
    ['Welcome banner', `${PLATFORM_MARKER}: start`, ...kv, `${PLATFORM_MARKER}: end`].join('\n');

  it('maps machine names and libc', () => {
    expect(
      parsePlatform(output(['kernel==Linux', 'machine==x86_64', 'libc==gnu', 'home==/home/u'])),
    ).toEqual({ os: 'linux', arch: 'x64', home: '/home/u' });
    expect(
      parsePlatform(output(['kernel==Linux', 'machine==aarch64', 'libc==musl', 'home==/root'])),
    ).toEqual({ os: 'alpine', arch: 'arm64', home: '/root' });
  });

  it('rejects unsupported systems', () => {
    expect(() =>
      parsePlatform(output(['kernel==Darwin', 'machine==arm64', 'home==/Users/u'])),
    ).toThrowError(/Linux/);
    expect(() =>
      parsePlatform(output(['kernel==Linux', 'machine==riscv64', 'home==/root'])),
    ).toThrowError(/riscv64/);
    expect(() =>
      parsePlatform(output(['kernel==Linux', 'machine==x86_64', 'home=='])),
    ).toThrowError(/home directory/);
  });

  it('ships a detection script that is plain POSIX sh', () => {
    expect(detectPlatformScript).toContain(`${PLATFORM_MARKER}: start`);
    expect(detectPlatformScript).not.toMatch(/\[\[|\bbash\b/);
  });
});

describe('urlForLog', () => {
  it.each([
    [
      'https://user:secret@mirror.example:8443/a/b.tar.gz?token=x#f',
      'https://mirror.example:8443/a/b.tar.gz',
    ],
    ['https://h/releases/c1/server.tar.gz', 'https://h/releases/c1/server.tar.gz'],
    ['file:///tmp/server.tar.gz', 'file:///tmp/server.tar.gz'],
    ['not a url', 'the configured address'],
  ])('%s -> %s', (url, expected) => {
    expect(urlForLog(url)).toBe(expected);
  });
});
