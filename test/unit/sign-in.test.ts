import { describe, expect, it } from 'vitest';
import { SignInDetector, deviceCode, signInUrl } from '../../src/core/k8s/signIn';

function detect(lines: string[]): ReturnType<SignInDetector['push']>[] {
  const detector = new SignInDetector();
  return lines.map((line) => detector.push(line));
}

describe('sign-in requests in what kubectl writes to stderr', () => {
  it("recognizes Azure kubelogin's device code, page and code on one line", () => {
    expect(
      detect([
        'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and ' +
          'enter the code DXGT9CMZW to authenticate.',
      ]),
    ).toEqual([{ url: 'https://microsoft.com/devicelogin', code: 'DXGT9CMZW' }]);
  });

  it("recognizes kubectl oidc-login's device code, code before page on separate lines", () => {
    expect(
      detect([
        'Please enter the following code when asked in your browser: ABCD-EFGH',
        'Please visit the following URL to complete authentication: https://issuer.example.com/device',
      ]),
    ).toEqual([undefined, { url: 'https://issuer.example.com/device', code: 'ABCD-EFGH' }]);
  });

  it('recognizes a local callback page that a plugin could not open itself', () => {
    expect(
      detect([
        'error: could not open the browser: exec: "xdg-open": executable file not found in $PATH',
        '',
        'Please visit the following URL in your browser manually: http://localhost:8000',
      ]),
    ).toEqual([undefined, undefined, { url: 'http://localhost:8000' }]);
  });

  it('takes an address on its own line after the words that announce it (Pinniped)', () => {
    expect(
      detect([
        'Log in by visiting this link:',
        '',
        '    https://pinniped.example.com/oauth2/authorize?client_id=x&state=y',
      ]),
    ).toEqual([
      undefined,
      undefined,
      { url: 'https://pinniped.example.com/oauth2/authorize?client_id=x&state=y' },
    ]);
  });

  it("ignores the cluster's address in kubectl's own errors and other addresses", () => {
    expect(
      detect([
        "E1123 10:43:20.123456   12345 memcache.go:265] couldn't get current server API group " +
          'list: Get "https://10.0.0.1:6443/api?timeout=32s": dial tcp 10.0.0.1:6443: i/o timeout',
        'Unable to connect to the server: dial tcp 10.0.0.1:6443: i/o timeout',
        'See https://kubernetes.io/docs/reference/access-authn-authz/ for details',
        'error: You must be logged in to the server (Unauthorized)',
      ]),
    ).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('reports a request once, and again only when the page or the code changes', () => {
    const line = 'Open the page https://microsoft.com/devicelogin and enter the code AAAA1111.';
    expect(
      detect([
        line,
        line,
        'Open the page https://microsoft.com/devicelogin and enter the code BBBB2222.',
      ]),
    ).toEqual([
      { url: 'https://microsoft.com/devicelogin', code: 'AAAA1111' },
      undefined,
      { url: 'https://microsoft.com/devicelogin', code: 'BBBB2222' },
    ]);
  });

  it('offers only https, or http on this machine, and no address with credentials', () => {
    expect(signInUrl('visit https://login.example.com/x.')).toBe('https://login.example.com/x');
    expect(signInUrl('visit (https://login.example.com/x)')).toBe('https://login.example.com/x');
    expect(signInUrl('visit http://127.0.0.1:18000/')).toBe('http://127.0.0.1:18000/');
    expect(signInUrl('visit http://login.example.com/')).toBeUndefined();
    expect(signInUrl('visit https://user:secret@login.example.com/')).toBeUndefined();
    expect(signInUrl('visit file:///etc/passwd')).toBeUndefined();
    expect(signInUrl('visit javascript:alert(1)')).toBeUndefined();
  });

  it('takes upper-case device codes only where a line asks to enter one', () => {
    expect(deviceCode('enter the code DXGT9CMZW to authenticate')).toBe('DXGT9CMZW');
    expect(deviceCode('User code: WDJB-MJHT')).toBe('WDJB-MJHT');
    expect(deviceCode('enter the code in your browser')).toBeUndefined();
    expect(deviceCode('the plugin failed with exit code 1')).toBeUndefined();
    expect(deviceCode('error code ABCD1234')).toBeUndefined();
  });
});
