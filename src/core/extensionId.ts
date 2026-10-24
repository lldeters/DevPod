// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

/**
 * `publisher.name`, nothing else. Versions (`@1.2.3`), URLs and anything with whitespace or shell
 * characters are rejected, so a valid id is also safe to pass as a command-line argument.
 */
const EXTENSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*\.[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export function isValidExtensionId(value: string): boolean {
  return value.length <= 200 && EXTENSION_ID.test(value);
}
