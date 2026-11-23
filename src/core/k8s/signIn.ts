// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

// Recognizes, in what kubectl writes to stderr, that a credential plugin of the kubeconfig waits
// for a sign-in: a page to open (OIDC with `kubectl oidc-login`, Azure's `kubelogin` with a device
// code, Pinniped, ...) and possibly a code to enter there. kubectl itself prints nothing like this;
// the plugins' stderr passes through it. Only what kubectl runs locally is read this way, never
// the output of a command in a pod, which the pod could choose.

/** A request to sign in: the page to open and, for a device code flow, the code to enter. */
export interface SignInPrompt {
  readonly url: string;
  readonly code?: string;
}

// klog lines of kubectl itself ("E1123 10:43:20.123456 12345 memcache.go:265] ..."): their URLs
// are the cluster's API, not a sign-in page.
const KLOG = /^[IWEF]\d{4} \d\d:\d\d:\d\d/;
const SIGN_IN_WORDS =
  /\b(sign[ -]?in|log[ -]?in|authenticat\w*|authoriz\w*|browser|visit\w*|open the (page|url|link)|device)\b/i;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>]+/i;
// "enter the code ABCD1234", "the following code when asked in your browser: ABCD-EFGH",
// "user code: ABCD-EFGH". Device codes are upper-case letters and digits.
const CODE_WORDS =
  /\b(enter|type|use|input)\b.*\bcode\b|\buser[ _-]?code\b|\bcode\b.*\b(asked|browser)\b/i;
const CODE = /\b[Cc]ode\b(?:[^:\n]*:)?\s*([A-Z0-9]{4,12}(?:-[A-Z0-9]{4,12}){0,3})\b/;

/** An address a browser may be sent to: https, or http on this machine (a plugin's callback). */
export function signInUrl(text: string): string | undefined {
  const match = URL_IN_TEXT.exec(text);
  if (!match) return undefined;
  const candidate = match[0].replace(/[.,;:!?)\]}]+$/, '');
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (url.username !== '' || url.password !== '') return undefined;
  if (url.protocol === 'https:') return candidate;
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  return url.protocol === 'http:' && local ? candidate : undefined;
}

/** The device code a line asks to enter, if any. */
export function deviceCode(line: string): string | undefined {
  if (!CODE_WORDS.test(line)) return undefined;
  return CODE.exec(line)?.[1];
}

/**
 * Reads stderr line by line and reports a sign-in request whenever a line adds its page or its
 * code. A page may come on the line after the words that announce it ("Log in by visiting this
 * link:" and then the address alone), and the code on a line of its own.
 */
export class SignInDetector {
  private url: string | undefined;
  private code: string | undefined;
  /** Lines left in which an address on its own still counts as the announced page. */
  private announced = 0;

  push(line: string): SignInPrompt | undefined {
    const text = line.trim();
    if (text === '' || KLOG.test(text)) {
      return undefined;
    }
    let changed = false;
    const url = signInUrl(text);
    const words = SIGN_IN_WORDS.test(text);
    if (url !== undefined && (words || this.announced > 0) && url !== this.url) {
      this.url = url;
      changed = true;
    }
    this.announced = words && url === undefined ? 3 : Math.max(0, this.announced - 1);
    const code = deviceCode(text);
    if (code !== undefined && code !== this.code) {
      this.code = code;
      changed = true;
    }
    if (!changed || this.url === undefined) {
      return undefined;
    }
    return this.code === undefined ? { url: this.url } : { url: this.url, code: this.code };
  }
}
