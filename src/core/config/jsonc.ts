// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { parse, printParseErrorCode } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { DevContainerError } from '../errors';

function position(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const line = before.split('\n').length;
  return { line, column: offset - (before.lastIndexOf('\n') + 1) + 1 };
}

/**
 * Parses JSON with comments and trailing commas, as used by devcontainer.json.
 * An empty document is treated as an empty object.
 */
export function parseJsonc(text: string, source: string): Record<string, unknown> {
  const errors: ParseError[] = [];
  const value: unknown = parse(text, errors, { allowTrailingComma: true, allowEmptyContent: true });
  const first = errors[0];
  if (first) {
    const { line, column } = position(text, first.offset);
    throw new DevContainerError(
      'CONFIG_INVALID',
      `${source}:${line}:${column}: ${printParseErrorCode(first.error)}`,
    );
  }
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DevContainerError(
      'CONFIG_INVALID',
      `${source}: the top-level value must be an object`,
    );
  }
  return value as Record<string, unknown>;
}
