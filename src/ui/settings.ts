// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';

/** Whether this machine's Kiro sign-in is copied into containers and pods. */
export type ShareKiroLogin = 'ask' | 'always' | 'never';

/** Where web pages that kubectl in WSL opens (sign-ins) are shown. */
export type KubectlWSLBrowser = 'windows' | 'wsl';

export interface Settings {
  dockerPath: string;
  dockerComposePath: string | undefined;
  devcontainerCliPath: string | undefined;
  logLevel: 'info' | 'debug' | 'trace';
  promptToReopen: boolean;
  serverDownloadUrlTemplate: string | undefined;
  kubectlPath: string | undefined;
  kubeconfigPath: string | undefined;
  kubectlWSLDistro: string | undefined;
  kubectlWSLBrowser: KubectlWSLBrowser;
  shareKiroLogin: ShareKiroLogin;
  mcpGitlab: McpGitlabSettings;
  /**
   * Further MCP servers for pods, as entries of `mcpServers` in Kiro's `mcp.json`; `undefined` when
   * the setting is not set at all (an empty object still removes the ones written before).
   */
  mcpServers: Record<string, unknown> | undefined;
}

/** The GitLab MCP server that is set up in pods (`dev.containers.mcpGitlab.*`). */
export interface McpGitlabSettings {
  enabled: boolean;
  bundlePath: string | undefined;
  apiUrl: string | undefined;
  readOnly: boolean;
  toolsets: string | undefined;
  env: Record<string, string>;
}

/** What `inspect` returns at runtime; the local and remote parts are not in the API typings. */
interface Inspection<T> {
  readonly globalValue?: T;
  readonly globalLocalValue?: T;
  readonly globalRemoteValue?: T;
}

/**
 * `section.key` as the user set it on this machine, or `undefined`. Settings that decide which
 * programs run here, which kubeconfig is used or whether the Kiro sign-in is shared must come from
 * neither a workspace nor the settings on the side of a container or pod. This extension declares
 * them with scope `application`, but the IDE applies scopes only to the keys it knows: a section
 * written as an object (`"dev.containers": { ... }`) passes that filter. So only the user's layer
 * counts. In a remote window that layer also holds the remote side's settings, which can set a
 * value and also erase one (`"dev.containers": null`), so this machine's value comes first there,
 * and a value only the remote side has is not used.
 */
export function userValue<T>(section: string | undefined, key: string): T | undefined {
  const inspected = vscode.workspace.getConfiguration(section).inspect<T>(key) as
    Inspection<T> | undefined;
  if (vscode.env.remoteName !== undefined) {
    if (inspected?.globalLocalValue !== undefined) return inspected.globalLocalValue;
    if (inspected?.globalRemoteValue !== undefined) return undefined;
  }
  // Also the user settings of the default profile, which hold the scope-`application` settings
  // when another profile is active.
  return inspected?.globalValue;
}

function nonEmpty(value: unknown): string | undefined {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  return trimmed ? trimmed : undefined;
}

/** Up to 0.1.0 the setting was a boolean; those values keep their meaning. */
function shareKiroLogin(value: unknown): ShareKiroLogin {
  if (value === true) return 'always';
  if (value === false) return 'never';
  return value === 'always' || value === 'never' ? value : 'ask';
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : undefined;
}

function stringRecord(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string',
    ),
  );
}

function logLevel(value: unknown): Settings['logLevel'] {
  return value === 'debug' || value === 'trace' ? value : 'info';
}

export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration('dev.containers');
  const own = (key: string): unknown => userValue<unknown>('dev.containers', key);
  return {
    dockerPath: nonEmpty(own('dockerPath')) ?? 'docker',
    dockerComposePath: nonEmpty(own('dockerComposePath')),
    devcontainerCliPath: nonEmpty(own('devcontainerCliPath')),
    logLevel: logLevel(config.get<unknown>('logLevel')),
    promptToReopen: config.get<boolean>('promptToReopen') ?? true,
    serverDownloadUrlTemplate: nonEmpty(own('serverDownloadUrlTemplate')),
    kubectlPath: nonEmpty(own('kubectlPath')),
    kubeconfigPath: nonEmpty(own('kubeconfigPath')),
    kubectlWSLDistro: nonEmpty(own('kubectlWSLDistro')),
    kubectlWSLBrowser: own('kubectlWSLBrowser') === 'wsl' ? 'wsl' : 'windows',
    shareKiroLogin: shareKiroLogin(own('shareKiroLogin')),
    mcpGitlab: {
      enabled: own('mcpGitlab.enabled') !== false,
      bundlePath: nonEmpty(own('mcpGitlab.bundlePath')),
      apiUrl: nonEmpty(own('mcpGitlab.apiUrl')),
      readOnly: own('mcpGitlab.readOnly') !== false,
      toolsets: nonEmpty(own('mcpGitlab.toolsets')),
      env: stringRecord(own('mcpGitlab.env')),
    },
    mcpServers: objectValue(own('mcpServers')),
  };
}
