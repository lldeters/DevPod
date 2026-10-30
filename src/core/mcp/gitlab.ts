// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { DevContainerError } from '../errors';

/** The key of the entry in `mcpServers` that this extension manages. */
export const MCP_SERVER_NAME = 'gitlab';

/** The variable the server reads its token from; only a reference to it is ever written. */
export const TOKEN_VARIABLE = 'GITLAB_PERSONAL_ACCESS_TOKEN';

/** The bundle is one JavaScript file of a few MB; anything much larger is not what we expect. */
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_FOLDER = /^\.?[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface McpGitlabConfig {
  /** `GITLAB_API_URL`; left out when empty, so the server's own default applies. */
  readonly apiUrl?: string | undefined;
  /** `GITLAB_READ_ONLY_MODE`. */
  readonly readOnly: boolean;
  /** `GITLAB_TOOLSETS`, a comma-separated list; left out when empty. */
  readonly toolsets?: string | undefined;
  /** Further variables for the server (proxy, certificates), never the token. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** The bundle of `mcp-gitlab` and how to configure it. */
export interface McpGitlabSetup {
  /** Content of `mcp-gitlab.mjs`, a single-file bundle that needs no `node_modules`. */
  readonly bundle: string;
  readonly config: McpGitlabConfig;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Why `bundle` cannot be the server bundle, or `undefined` if it may be one. */
export function checkBundle(bundle: string): string | undefined {
  if (bundle.length === 0) return 'it is empty';
  if (Buffer.byteLength(bundle, 'utf8') > MAX_BUNDLE_BYTES) return 'it is larger than expected';
  if (bundle.includes('\0')) return 'it is not a text file';
  return undefined;
}

/**
 * The variables of the entry. The token is a reference that the IDE expands from the environment
 * of the pod when it starts the server, so its value is never written to a file.
 */
export function serverEnv(config: McpGitlabConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(config.env ?? {})) {
    if (!VARIABLE_NAME.test(name) || typeof value !== 'string') {
      throw new DevContainerError(
        'CONFIG_INVALID',
        `"${name}" is not a valid variable name for the GitLab MCP server.`,
      );
    }
    if (name === TOKEN_VARIABLE) {
      throw new DevContainerError(
        'CONFIG_INVALID',
        `${TOKEN_VARIABLE} cannot be set for the GitLab MCP server; it is taken from the pod's environment.`,
      );
    }
    env[name] = value;
  }
  const apiUrl = config.apiUrl?.trim();
  if (apiUrl) env.GITLAB_API_URL = apiUrl;
  env.GITLAB_READ_ONLY_MODE = config.readOnly ? 'true' : 'false';
  const toolsets = config.toolsets?.trim();
  if (toolsets) env.GITLAB_TOOLSETS = toolsets;
  env[TOKEN_VARIABLE] = `\${${TOKEN_VARIABLE}}`;
  return env;
}

// A type, not an interface, so that it is an entry of `mcpServers` (`Record<string, unknown>`).
export type McpServerEntry = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export function buildServerEntry(
  node: string,
  bundlePath: string,
  config: McpGitlabConfig,
): McpServerEntry {
  return { command: node, args: [bundlePath], env: serverEnv(config) };
}

/** The bundle's place below the home directory: `<dataFolderName>/mcp/mcp-gitlab.mjs`. */
export function bundleRelativePath(dataFolderName: string): string {
  if (!SAFE_FOLDER.test(dataFolderName) || dataFolderName.includes('..')) {
    throw new DevContainerError('SERVER_UNSUPPORTED', 'Unsafe server data folder name.');
  }
  return `${dataFolderName}/mcp/mcp-gitlab.mjs`;
}
