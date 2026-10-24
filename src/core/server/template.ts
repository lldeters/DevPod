// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { DevContainerError } from '../errors';

export interface TemplateVariables {
  commit: string;
  quality: string;
  version: string;
  release: string;
  os: string;
  arch: string;
}

const KNOWN = new Set<string>(['commit', 'quality', 'version', 'release', 'os', 'arch']);

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
  if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
    throw new DevContainerError(
      'SERVER_UNSUPPORTED',
      'The server download URL must start with https:// (or http://, file://).',
    );
  }
  return url;
}
