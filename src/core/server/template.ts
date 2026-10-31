// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { DevContainerError } from '../errors';

export interface TemplateVariables {
  commit: string;
  quality: string;
  version: string;
  os: string;
  arch: string;
}

const KNOWN = new Set<string>(['commit', 'quality', 'version', 'os', 'arch']);

/**
 * Expands `${name}` placeholders. Unknown or empty placeholders are an error rather than being
 * passed through, so a typo can never produce a request to an unintended URL.
 */
export function expandUrlTemplate(template: string, variables: TemplateVariables): string {
  const url = template.replace(/\$\{([^}]*)\}/g, (_match, name: string) => {
    if (!KNOWN.has(name)) {
      throw new DevContainerError(
        'SERVER_UNSUPPORTED',
        `Unknown placeholder \${${name}} in the server download URL template.`,
      );
    }
    const value = variables[name as keyof TemplateVariables];
    if (value === '') {
      throw new DevContainerError(
        'SERVER_UNSUPPORTED',
        `The placeholder \${${name}} has no value for this IDE build.`,
      );
    }
    return encodeURIComponent(value);
  });
  // The archive becomes code in the container, so plain http (open to tampering) is refused.
  if (!/^https:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
    throw new DevContainerError(
      'SERVER_UNSUPPORTED',
      'The server download URL must start with https:// (or file:// for a file in the container).',
    );
  }
  return url;
}

/**
 * `url` for a log or a message: without user name, password, query and fragment, which in the URL of
 * a private mirror often carry its credentials.
 */
export function urlForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return 'the configured address';
  }
}
