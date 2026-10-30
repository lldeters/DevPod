// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { looksLikeSecretName } from '../cli/output';

/** A reference to a variable of the pod, which Kiro expands when it starts the server. */
export const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** What may stand next to references in a secret value: an authorization scheme. */
const SCHEME_ONLY = /^\s*(Bearer|Basic|Token)?\s*$/i;

/**
 * Names of command-line flags and URL query parameters that hold secrets. Narrower than the names
 * of variables (`looksLikeSecretName`), since flags such as `--auth-type` or `--session-timeout`
 * are common and take no secret.
 */
const SECRET_FLAG =
  /token|secret|passw(or)?d|passphrase|credential|api[-_]?key|access[-_]?key|private[-_]?key|client[-_]?secret|jwt|bearer|cookie|(^|[-_])pat$/i;

/** `scheme://user:password@`; the password is group 1. */
const URL_PASSWORD = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#@\s:]*:([^/?#@\s]*)@/g;

/** `?name=value` and `&name=value` of a URL. */
const QUERY_PARAMETER = /[?&]([^=&#\s]+)=([^&#\s]*)/g;

/** Whether `value` consists of references only (and an authorization scheme). */
function onlyReferences(value: string): boolean {
  return new RegExp(REFERENCE.source).test(value) && SCHEME_ONLY.test(value.replace(REFERENCE, ''));
}

/** Why `value` holds a secret in a URL (a password, or a query parameter such as `api_key`). */
function urlProblem(value: string, where: string): string | undefined {
  if (!value.includes('://')) return undefined;
  for (const match of value.matchAll(URL_PASSWORD)) {
    if (match[1] && !onlyReferences(match[1])) {
      return `${where} has a password in a URL; use a reference to a variable of the pod, such as "\${PROXY_PASSWORD}"`;
    }
  }
  for (const match of value.matchAll(QUERY_PARAMETER)) {
    const [, name = '', parameter = ''] = match;
    if (SECRET_FLAG.test(name) && parameter !== '' && !onlyReferences(parameter)) {
      return `${where} has the parameter "${name}" in a URL; use a reference to a variable of the pod`;
    }
  }
  return undefined;
}

/**
 * Why a variable or header `name` with `value` would put a secret into a file, or `undefined`. A
 * secret must be a reference to a variable of the pod (`${NAME}`, optionally after a scheme such
 * as `Bearer`); `example` shows one. An empty value holds no secret. Never names the value.
 */
export function valueProblem(
  name: string,
  value: string,
  where: string,
  example: string,
): string | undefined {
  if (value !== '' && looksLikeSecretName(name) && !onlyReferences(value)) {
    return `${where} looks like a secret; write it as a reference to a variable of the pod, such as "${example}"`;
  }
  return urlProblem(value, where);
}

/**
 * Why command-line arguments would put a secret into a file: the value of a flag such as
 * `--token VALUE` or `--api-key=VALUE`, or a URL with a password or a token parameter. Never
 * names the value.
 */
export function argsProblem(args: readonly string[]): string | undefined {
  for (const [index, arg] of args.entries()) {
    const flag = /^--?([A-Za-z][A-Za-z0-9_-]*)(?:=(.*))?$/s.exec(arg);
    if (flag && SECRET_FLAG.test(flag[1] ?? '')) {
      const value = flag[2] ?? args[index + 1];
      const inline = flag[2] !== undefined;
      if (value !== undefined && (inline || !value.startsWith('-')) && !onlyReferences(value)) {
        return `the value of the argument "--${flag[1] ?? ''}" looks like a secret; use a reference to a variable of the pod`;
      }
    }
    const problem = urlProblem(arg, `argument ${index + 1}`);
    if (problem) return problem;
  }
  return undefined;
}
