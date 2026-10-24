// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { applyEdits, modify, parse } from 'jsonc-parser';

const KEY = 'enable-proposed-api';

function listed(text: string): string[] {
  const value: unknown = parse(text, [], { allowTrailingComma: true, allowEmptyContent: true });
  const entries = (value as Record<string, unknown> | undefined)?.[KEY];
  return Array.isArray(entries)
    ? entries.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function isProposedApiEnabled(argvText: string, extensionId: string): boolean {
  const wanted = extensionId.toLowerCase();
  return listed(argvText).some((entry) => entry.toLowerCase() === wanted);
}

/**
 * Returns argv.json text with `extensionId` added to "enable-proposed-api". Comments and
 * formatting of the rest of the file are preserved. An empty file becomes a new document.
 */
export function enableProposedApi(argvText: string, extensionId: string): string {
  if (isProposedApiEnabled(argvText, extensionId)) {
    return argvText;
  }
  const next = [...listed(argvText), extensionId];
  const base = argvText.trim() === '' ? '{\n}\n' : argvText;
  return applyEdits(
    base,
    modify(base, [KEY], next, { formattingOptions: { insertSpaces: true, tabSize: 4 } }),
  );
}
