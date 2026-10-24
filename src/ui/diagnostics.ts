// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as os from 'node:os';
import * as vscode from 'vscode';
import { isProposedApiEnabled } from '../core/argv';
import type { DevContainerCli } from '../core/cli/devcontainerCli';
import { redactHome, summarizeProduct } from '../core/diagnostics';
import type { ContainerEngine } from '../core/engine/containerEngine';
import { errorMessage } from '../core/errors';
import { readProduct } from '../remote/product';
import type { RemoteSupport } from './remoteState';
import { readSettings } from './settings';
import { argvJsonPath, readIfExists } from './setup';

export interface DiagnosticsDependencies {
  extensionId: string;
  extensionVersion: string;
  engine: ContainerEngine;
  cli: DevContainerCli;
  remoteSupport: RemoteSupport;
}

/** Runs `run`; a failure becomes data in the report instead of aborting it. */
async function attempt<T>(run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run();
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

/**
 * Facts needed to judge whether and how this extension can work in the running IDE. Contains no
 * credentials, no workspace content and no user name (the home directory is shortened to `~`).
 */
export async function collectDiagnostics(
  deps: DiagnosticsDependencies,
): Promise<Record<string, unknown>> {
  const settings = readSettings();
  const argvPath = await argvJsonPath().catch(() => undefined);

  return {
    generatedAt: new Date().toISOString(),
    extension: { id: deps.extensionId, version: deps.extensionVersion },
    ide: {
      appName: vscode.env.appName,
      vscodeVersion: vscode.version,
      platform: process.platform,
      arch: process.arch,
      remoteName: vscode.env.remoteName ?? null,
    },
    product: await attempt(async () => summarizeProduct(await readProduct())),
    remoteSupport: {
      enabled: deps.remoteSupport.enabled,
      problem: deps.remoteSupport.problem ?? null,
    },
    argvJson: argvPath
      ? {
          path: redactHome(argvPath, os.homedir()),
          listsThisExtension: await attempt(async () =>
            isProposedApiEnabled(await readIfExists(argvPath), deps.extensionId),
          ),
        }
      : { path: null },
    containerEngine: {
      command: settings.dockerPath,
      version: await attempt(() => deps.engine.checkAvailable()),
    },
    devcontainerCli: { version: await attempt(() => deps.cli.version()) },
    settings: {
      dockerPath: settings.dockerPath,
      serverDownloadUrlTemplate: settings.serverDownloadUrlTemplate ? 'set' : 'unset',
      logLevel: settings.logLevel,
    },
  };
}

/** Copies the report to the clipboard and shows it, so it can be pasted into a chat or issue. */
export async function showDiagnostics(deps: DiagnosticsDependencies): Promise<void> {
  const text = JSON.stringify(await collectDiagnostics(deps), null, 2);
  await vscode.env.clipboard.writeText(text);
  const document = await vscode.workspace.openTextDocument({ language: 'json', content: text });
  await vscode.window.showTextDocument(document);
  void vscode.window.showInformationMessage(
    'Diagnostics copied to the clipboard. Paste them into your reply.',
  );
}
