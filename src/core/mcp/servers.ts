// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { applyEdits, modify, parse } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { DevContainerError } from '../errors';
import { argsProblem, REFERENCE, valueProblem } from './secrets';

/** Kiro's user-level MCP configuration, relative to the home directory. */
export const MCP_SETTINGS_RELATIVE_PATH = '.kiro/settings/mcp.json';

/** An entry of `mcpServers` in Kiro's `mcp.json`. */
export type McpServerConfig = Record<string, unknown>;

const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/** Whether `name` can be the name of an MCP server written by this extension. */
export function isServerName(name: string): boolean {
  return SERVER_NAME.test(name);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** `record[key]` if `record` has that key itself; names such as `constructor` are not inherited. */
function ownValue(record: unknown, key: string): unknown {
  const object = asRecord(record);
  return object && Object.hasOwn(object, key) ? object[key] : undefined;
}

/** JSON with the keys of every object sorted, so that the order of keys does not matter. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    const object = asRecord(v);
    return object
      ? Object.fromEntries(
          Object.keys(object)
            .sort()
            .map((k) => [k, object[k]]),
        )
      : v;
  });
}

export function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

/** Why `entry` cannot be written as the MCP server `name`, or `undefined`. Never names a value. */
function serverProblem(name: string, entry: unknown): string | undefined {
  if (!SERVER_NAME.test(name)) return 'its name may only contain letters, digits, ".", "_" and "-"';
  const record = asRecord(entry);
  if (!record) return 'it is not an object';
  const command = ownValue(record, 'command');
  const url = ownValue(record, 'url');
  if (typeof command !== 'string' && typeof url !== 'string') {
    return 'it has neither "command" nor "url"';
  }
  if (typeof url === 'string') {
    const problem = valueProblem('url', url, '"url"', 'https://host/mcp?token=${MCP_TOKEN}');
    if (problem) return problem;
  }
  const args = ownValue(record, 'args');
  if (args !== undefined) {
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
      return '"args" is not a list of strings';
    }
    const problem = argsProblem(args);
    if (problem) return problem;
  }
  for (const key of ['env', 'headers']) {
    const values = ownValue(record, key);
    if (values === undefined) continue;
    if (!asRecord(values)) return `"${key}" is not an object`;
    for (const [field, value] of Object.entries(values as Record<string, unknown>)) {
      if (typeof value !== 'string') return `"${key}.${field}" is not a string`;
      const example = key === 'env' ? `\${${field}}` : 'Bearer ${API_TOKEN}';
      const problem = valueProblem(field, value, `"${key}.${field}"`, example);
      if (problem) return problem;
    }
  }
  return undefined;
}

/**
 * The servers of `dev.containers.mcpServers` that can be written to a pod, and why the others
 * cannot. No secret may be written in plain text: a variable, header, flag or URL parameter whose
 * name looks like one, and a password in a URL, must refer to a variable of the pod.
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

/** Whether `current` already has every key of `entry` with the same value. */
export function hasEntry(current: unknown, entry: McpServerConfig): boolean {
  return (
    asRecord(current) !== undefined &&
    Object.entries(entry).every(([key, value]) => sameJson(ownValue(current, key), value))
  );
}

export interface MergeInput {
  /** Entries to set; keys an entry does not name (such as `disabled` set in Kiro) are kept. */
  readonly servers: Readonly<Record<string, McpServerConfig>>;
  /**
   * Whether an existing entry of that name was written by this extension. Others belong to the
   * user and are never changed.
   */
  readonly isOwn: (name: string, current: unknown) => boolean;
  /** Keys this extension set in an own entry before; the ones an entry no longer has are removed. */
  readonly previousKeys?: (name: string) => readonly string[];
  /** Own entries from earlier connections that are no longer wanted; they are removed. */
  readonly remove?: readonly string[];
}

export interface MergeResult {
  readonly text: string;
  readonly changed: boolean;
  /** Wanted entries that were left alone because the user has an entry of that name. */
  readonly foreign: string[];
  /** Wanted entries that were added or changed. */
  readonly updated: string[];
  /** Entries of `remove` that were in the file. */
  readonly removed: string[];
}

/** The indentation and line ends of `text`, so that what is inserted looks like the rest. */
function formattingOf(text: string): { insertSpaces: boolean; tabSize: number; eol: string } {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const indent = /\n([ \t]+)\S/.exec(text)?.[1] ?? '  ';
  return indent.startsWith('\t')
    ? { insertSpaces: false, tabSize: 1, eol }
    : { insertSpaces: true, tabSize: indent.length, eol };
}

/**
 * Sets entries of `mcpServers` in the text of Kiro's `mcp.json`. Comments, other servers and
 * other keys are kept; an entry of the user's own is never changed. A leading byte order mark is
 * dropped when the file is changed.
 */
export function mergeMcpSettings(existing: string, input: MergeInput): MergeResult {
  const source = existing.replace(/^\uFEFF/, '');
  const errors: ParseError[] = [];
  const parsed: unknown = parse(source, errors, {
    allowTrailingComma: true,
    allowEmptyContent: true,
  });
  const empty = source.trim() === '';
  const root = empty ? {} : asRecord(parsed);
  if (errors.length > 0 || root === undefined) {
    throw new DevContainerError(
      'CONFIG_INVALID',
      `~/${MCP_SETTINGS_RELATIVE_PATH} in the pod is not a valid JSON object, so it was left unchanged.`,
    );
  }
  const servers = ownValue(root, 'mcpServers');
  if (servers !== undefined && asRecord(servers) === undefined) {
    throw new DevContainerError(
      'CONFIG_INVALID',
      `"mcpServers" in ~/${MCP_SETTINGS_RELATIVE_PATH} in the pod is not an object, so it was left unchanged.`,
    );
  }
  const formattingOptions = formattingOf(source);
  const edit = (text: string, path: string[], value: unknown) =>
    applyEdits(text, modify(text, ['mcpServers', ...path], value, { formattingOptions }));

  const start = empty ? '{}\n' : source;
  let text = start;
  const foreign: string[] = [];
  const updated: string[] = [];
  for (const [name, entry] of Object.entries(input.servers)) {
    const current = ownValue(servers, name);
    if (current !== undefined && !input.isOwn(name, current)) {
      foreign.push(name);
      continue;
    }
    const before = text;
    if (current !== undefined && asRecord(current) === undefined) {
      text = edit(text, [name], entry); // not an object, so there are no keys to keep
    } else {
      for (const [key, value] of Object.entries(entry)) {
        if (!sameJson(ownValue(current, key), value)) text = edit(text, [name, key], value);
      }
      for (const key of input.previousKeys?.(name) ?? []) {
        if (!Object.hasOwn(entry, key) && ownValue(current, key) !== undefined) {
          text = edit(text, [name, key], undefined);
        }
      }
    }
    if (text !== before) updated.push(name);
  }
  const removed: string[] = [];
  for (const name of input.remove ?? []) {
    if (ownValue(servers, name) !== undefined && !Object.hasOwn(input.servers, name)) {
      text = edit(text, [name], undefined);
      removed.push(name);
    }
  }
  return text === start
    ? { text: existing, changed: false, foreign, updated, removed }
    : { text, changed: true, foreign, updated, removed };
}
