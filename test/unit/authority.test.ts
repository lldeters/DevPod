import { describe, expect, it } from 'vitest';
import {
  decodeAuthority,
  encodeAuthority,
  isDevContainerAuthority,
  isNetworkPath,
} from '../../src/core/authority';

const hex = (value: unknown): string =>
  `dev-container+${Buffer.from(JSON.stringify(value), 'utf8').toString('hex')}`;

describe('authority', () => {
  it('round-trips a posix path', () => {
    const params = { hostPath: '/home/me/project' };
    expect(decodeAuthority(encodeAuthority(params))).toEqual(params);
  });

  it('round-trips a Windows path with a config file and non-ASCII characters', () => {
    const params = {
      hostPath: 'C:\\Users\\Jörg\\プロジェクト',
      configFile: 'C:\\Users\\Jörg\\プロジェクト\\.devcontainer\\devcontainer.json',
    };
    expect(decodeAuthority(encodeAuthority(params))).toEqual(params);
  });

  it('only produces characters that are safe in a URI authority', () => {
    expect(encodeAuthority({ hostPath: '/a b/ü' })).toMatch(/^dev-container\+[0-9a-f]+$/);
  });

  it('recognizes its own authorities only', () => {
    expect(isDevContainerAuthority(encodeAuthority({ hostPath: '/x' }))).toBe(true);
    expect(isDevContainerAuthority('ssh-remote+host')).toBe(false);
    expect(isDevContainerAuthority(undefined)).toBe(false);
  });

  it.each([
    ['wrong prefix', 'ssh-remote+abcd'],
    ['empty payload', 'dev-container+'],
    ['odd length', 'dev-container+abc'],
    ['non-hex', 'dev-container+zz'],
    ['not JSON', `dev-container+${Buffer.from('nope').toString('hex')}`],
    ['null payload', hex(null)],
    ['wrong version', hex({ v: 2, hostPath: '/x' })],
    ['relative path', hex({ v: 1, hostPath: 'relative/path' })],
    ['missing path', hex({ v: 1 })],
    ['NUL in path', hex({ v: 1, hostPath: '/x\0y' })],
    ['relative config', hex({ v: 1, hostPath: '/x', configFile: 'a.json' })],
    ['non-string config', hex({ v: 1, hostPath: '/x', configFile: 5 })],
  ])('rejects %s', (_name, authority) => {
    expect(() => decodeAuthority(authority)).toThrowError(
      /remote authority|dev container authority/,
    );
  });

  it('refuses to encode an invalid path', () => {
    expect(() => encodeAuthority({ hostPath: 'relative' })).toThrow();
  });

  // Reading a network path contacts that host (and can hand it Windows credentials).
  it.each([
    '\\\\attacker.example\\share\\repo',
    '//attacker.example/share/repo',
    '\\\\?\\UNC\\host\\share',
    '\\\\.\\pipe\\x',
  ])('rejects the network path %s', (hostPath) => {
    expect(() => decodeAuthority(hex({ v: 1, hostPath }))).toThrowError(/network share/);
    expect(() => decodeAuthority(hex({ v: 1, hostPath: '/x', configFile: hostPath }))).toThrowError(
      /network share/,
    );
    expect(() => encodeAuthority({ hostPath })).toThrowError(/network share/);
  });

  it('accepts the local shares of WSL distributions', () => {
    for (const hostPath of [
      '\\\\wsl$\\Ubuntu\\home\\me\\app',
      '\\\\wsl.localhost\\Ubuntu\\home\\me',
    ]) {
      expect(decodeAuthority(encodeAuthority({ hostPath }))).toEqual({ hostPath });
    }
  });

  it('knows which paths are network paths', () => {
    expect(isNetworkPath('C:\\Users\\me')).toBe(false);
    expect(isNetworkPath('/home/me')).toBe(false);
    expect(isNetworkPath('\\\\server\\share')).toBe(true);
  });
});
