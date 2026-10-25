// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

// Helpers for the "Show Diagnostics" command: pick the facts about the IDE that decide whether a
// matching server can be installed, without copying anything that looks like a credential.

/** product.json keys that are always interesting for remote support. */
const WANTED_KEYS = [
  'nameShort',
  'nameLong',
  'applicationName',
  'version',
  'commit',
  'quality',
  'dataFolderName',
  'serverApplicationName',
  'serverDataFolderName',
  'serverDownloadUrlTemplate',
  'updateUrl',
  'downloadUrl',
];

/** Other keys are included when their name hints at server, remote or download handling. */
const RELATED = /server|remote|tunnel|update|download/i;

/** Never copied, whatever else matches. */
const SECRET_LIKE = /key|token|secret|password|credential/i;

/** Keys whose mere presence tells whether proposed APIs are gated by the product. */
const PRESENCE_ONLY = ['extensionEnabledApiProposals', 'extensionAllowedProposedApi'];

const MAX_VALUE_LENGTH = 300;

export interface ProductSummary {
  /** Scalar values of the selected keys. */
  values: Record<string, string | number | boolean>;
  /** Selected keys whose values are objects or arrays (names only). */
  structuredKeys: string[];
  /** Which proposed-API gating keys exist. */
  proposedApiKeys: Record<string, boolean>;
}

export function summarizeProduct(product: unknown): ProductSummary {
  const summary: ProductSummary = { values: {}, structuredKeys: [], proposedApiKeys: {} };
  const record =
    typeof product === 'object' && product !== null ? (product as Record<string, unknown>) : {};

  for (const name of PRESENCE_ONLY) {
    summary.proposedApiKeys[name] = name in record;
  }
  for (const [key, value] of Object.entries(record)) {
    if (SECRET_LIKE.test(key) || !(WANTED_KEYS.includes(key) || RELATED.test(key))) {
      continue;
    }
    if (typeof value === 'string') {
      summary.values[key] =
        value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      summary.values[key] = value;
    } else if (typeof value === 'object' && value !== null) {
      summary.structuredKeys.push(key);
    }
  }
  return summary;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces the home directory with `~` in every string of `value` (also inside error messages and
 * paths that only contain it), so pasted diagnostics do not reveal the user name. A match must end
 * at a path separator, a quote, whitespace or the end, so `/home/al` does not hit `/home/alice`.
 * On Windows paths are compared case-insensitively and with either kind of slash.
 */
export function redactHomeDeep(value: unknown, home: string, windows: boolean): unknown {
  const trimmed = home.replace(/[\\/]+$/, '');
  if (trimmed === '' || /^[A-Za-z]:$/.test(trimmed)) {
    return value; // a root "home" would replace every path
  }
  const forms = windows ? [...new Set([trimmed, trimmed.replace(/\\/g, '/')])] : [trimmed];
  const pattern = new RegExp(
    `(?:${forms.map(escapeRegExp).join('|')})(?=$|[\\\\/\\s"'\`:;,)\\]])`,
    windows ? 'gi' : 'g',
  );
  const visit = (entry: unknown): unknown => {
    if (typeof entry === 'string') return entry.replace(pattern, '~');
    if (Array.isArray(entry)) return entry.map(visit);
    if (typeof entry === 'object' && entry !== null) {
      return Object.fromEntries(Object.entries(entry).map(([key, inner]) => [key, visit(inner)]));
    }
    return entry;
  };
  return visit(value);
}
