// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { Logger } from '../core/logger';
import { checkBundle, MAX_BUNDLE_BYTES, TOKEN_VARIABLE } from '../core/mcp/gitlab';
import type { McpGitlabSetup } from '../core/mcp/gitlab';
import { readSettings } from './settings';

/** Where a build of this extension can ship the bundle, relative to the extension's folder. */
export const BUNDLED_MCP_GITLAB = 'mcp/mcp-gitlab.mjs';

const MUTED_KEY = 'devcontainersKiro.mcpGitlab.tokenHintMuted';

async function readBundle(
  file: string,
  configured: boolean,
  logger: Logger,
): Promise<string | undefined> {
  try {
    if ((await stat(file)).size > MAX_BUNDLE_BYTES) {
      logger.log('warn', `The GitLab MCP server bundle ${file} is larger than expected; not used.`);
      return undefined;
    }
    const text = await readFile(file, 'utf8');
    const problem = checkBundle(text);
    if (problem) {
      logger.log('warn', `The GitLab MCP server bundle ${file} is not used because ${problem}.`);
      return undefined;
    }
    return text;
  } catch (error) {
    if (!configured && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      logger.log('debug', 'This build ships no GitLab MCP server; it is not set up in pods.');
    } else {
      logger.log(
        'warn',
        `The GitLab MCP server bundle ${file} could not be read: ${(error as Error).message}`,
      );
    }
    return undefined;
  }
}

/**
 * Tells the user once per window and pod that the pod has no token, unless they muted the hint.
 * The hint names the variable only.
 */
export class TokenHint {
  private readonly shown = new Set<string>();

  constructor(private readonly state: vscode.Memento) {}

  show(target: string): void {
    if (this.shown.has(target) || this.state.get<boolean>(MUTED_KEY) === true) return;
    this.shown.add(target);
    const mute = "Don't Show Again";
    void vscode.window
      .showWarningMessage(
        `The GitLab MCP server in ${target} cannot sign in to GitLab: set the environment ` +
          `variable ${TOKEN_VARIABLE} in the pod (for example from a Kubernetes secret).`,
        mute,
      )
      .then((choice) => (choice === mute ? this.state.update(MUTED_KEY, true) : undefined));
  }
}

/**
 * The GitLab MCP server to set up in `target`, from the settings of this machine, or `undefined`
 * when it is switched off or there is no bundle: `dev.containers.mcpGitlab.bundlePath`, else the
 * one a build of this extension ships in `mcp/mcp-gitlab.mjs`.
 */
export async function mcpGitlabFor(
  target: string,
  extensionPath: string,
  hint: TokenHint,
  logger: Logger,
): Promise<McpGitlabSetup | undefined> {
  const settings = readSettings().mcpGitlab;
  if (!settings.enabled) {
    return undefined;
  }
  const configured = settings.bundlePath;
  if (configured !== undefined && !path.isAbsolute(configured)) {
    logger.log('warn', '"dev.containers.mcpGitlab.bundlePath" must be an absolute path; ignored.');
    return undefined;
  }
  const bundle = await readBundle(
    configured ?? path.join(extensionPath, ...BUNDLED_MCP_GITLAB.split('/')),
    configured !== undefined,
    logger,
  );
  if (bundle === undefined) {
    return undefined;
  }
  return {
    bundle,
    config: {
      apiUrl: settings.apiUrl,
      readOnly: settings.readOnly,
      toolsets: settings.toolsets,
      env: settings.env,
    },
    onTokenMissing: () => hint.show(target),
  };
}
