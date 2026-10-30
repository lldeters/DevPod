// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { applyEdits, modify, parse } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { looksLikeSecretName } from '../cli/output';
import { DevContainerError } from '../errors';

/** Kiro's user-level MCP configuration, relative to the home directory. */
export const MCP_SETTINGS_RELATIVE_PATH = '.kiro/settings/mcp.json';

/** An entry of `mcpServers` in Kiro's `mcp.json`. */
export type McpServerConfig = Record<string, unknown>;

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
/** What may stand next to references in a secret value: an authorization scheme. */
const SCHEME_ONLY = /^\s*(Bearer|Basic|Token)?\s*$/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Why `value` of a variable or header called `name` would put a secret into a file, or
 * `undefined`. A secret must be a reference to a variable of the pod (`${NAME}`, optionally after
 * a scheme such as `Bearer`), which Kiro expands when it starts the server.
 */
function secretProblem(name: string, value: string): string | undefined {
  if (!looksLikeSecretName(name)) return undefined;
  const hasReference = new RegExp(REFERENCE.source).test(value);
  if (hasReference && SCHEME_ONLY.test(value.replace(REFERENCE, ''))) return undefined;
  return `"${name}" looks like a secret; use a reference to a variable of the pod, such as "\${${name}}"`;
}

/** Why `entry` cannot be written as the MCP server `name`, or `undefined`. */
function serverProblem(name: string, entry: unknown): string | undefined {
  if (!SERVER_NAME.test(name)) return 'its name may only contain letters, digits, ".", "_" and "-"';
  const record = asRecord(entry);
  if (!record) return 'it is not an object';
  if (typeof record.command !== 'string' && typeof record.url !== 'string') {
    return 'it has neither "command" nor "url"';
  }
  for (const key of ['env', 'headers']) {
    if (record[key] === undefined) continue;
    const values = asRecord(record[key]);
    if (!values) return `"${key}" is not an object`;
    for (const [field, value] of Object.entries(values)) {
      if (typeof value !== 'string') return `"${key}.${field}" is not a string`;
      const problem = secretProblem(field, value);
      if (problem) return problem;
    }
  }
  return undefined;
}

/**
 * The servers of `dev.containers.mcpServers` that can be written to a pod, and why the others
 * cannot. No secret may be written in plain text, so a variable or header whose name looks like
 * one must refer to a variable of the pod.
 */
export function checkServers(servers: Readonly<Record<string, unknown>>): {
  valid: Record<string, McpServerConfig>;
  problems: string[];
} {
  const valid: Record<string, McpServerConfig> = {};
  const problems: string[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    const problem = serverProblem(name, entry);
    if (problem) {
      problems.push(`The MCP server "${name}" is not set up because ${problem}.`);
    } else {
      valid[name] = entry as McpServerConfig;
    }
  }
  return { valid, problems };
}

/** The variables that `entries` refer to as `${NAME}`, sorted. */
export function referencedVariables(entries: readonly unknown[]): string[] {
  const names = new Set<string>();
  for (const match of JSON.stringify(entries).matchAll(REFERENCE)) {
    if (match[1]) names.add(match[1]);
  }
  return [...names].sort();
}

export interface MergeInput {
  /** Entries to set; keys an entry does not name (such as `disabled` set in Kiro) are kept. */
  readonly servers: Readonly<Record<string, McpServerConfig>>;
  /**
   * Whether an existing entry of that name was written by this extension. Others belong to the
   * user and are never changed.
   */
  readonly isOwn: (name: string, current: unknown) => boolean;
  /** Own entries from earlier connections that are no longer wanted; they are removed. */
  readonly remove?: readonly string[];
}

export interface MergeResult {
  readonly text: string;
  readonly changed: boolean;
  /** Wanted entries that were left alone because the user has an entry of that name. */
  readonly foreign: string[];
}

/**
 * Sets entries of `mcpServers` in the text of Kiro's `mcp.json`. Comments, other servers and
 * other keys are kept; an entry of the user's own is never changed.
 */
export function mergeMcpSettings(existing: string, input: MergeInput): MergeResult {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(existing, errors, {
    allowTrailingComma: true,
    allowEmptyContent: true,
  });
  const root = existing.trim() === '' ? {} : asRecord(parsed);
  if (errors.length > 0 || root === undefined) {
    throw new DevContainerError(
      'CONFIG_INVALID',
      `~/${MCP_SETTINGS_RELATIVE_PATH} in the pod is not a valid JSON object, so it was left unchanged.`,
    );
  }
  if (root.mcpServers !== undefined && asRecord(root.mcpServers) === undefined) {
    throw new DevContainerError(
      'CONFIG_INVALID',
      `"mcpServers" in ~/${MCP_SETTINGS_RELATIVE_PATH} in the pod is not an object, so it was left unchanged.`,
    );
  }
  const servers = asRecord(root.mcpServers) ?? {};
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };
  const edit = (text: string, path: string[], value: unknown) =>
    applyEdits(text, modify(text, ['mcpServers', ...path], value, { formattingOptions }));

  const empty = existing.trim() === '';
  let text = empty ? '{}\n' : existing;
  const start = text;
  const foreign: string[] = [];
  for (const [name, entry] of Object.entries(input.servers)) {
    const current = servers[name];
    if (current !== undefined && !input.isOwn(name, current)) {
      foreign.push(name);
      continue;
    }
    for (const [key, value] of Object.entries(entry)) {
      if (JSON.stringify(asRecord(current)?.[key]) === JSON.stringify(value)) continue;
      text = edit(text, [name, key], value);
    }
  }
  for (const name of input.remove ?? []) {
    if (servers[name] !== undefined && !(name in input.servers)) {
      text = edit(text, [name], undefined);
    }
  }
  return text === start
    ? { text: existing, changed: false, foreign }
    : { text, changed: true, foreign };
}
