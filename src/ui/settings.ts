// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';

export interface Settings {
  dockerPath: string;
  dockerComposePath: string | undefined;
  devcontainerCliPath: string | undefined;
  logLevel: 'info' | 'debug' | 'trace';
  promptToReopen: boolean;
  serverDownloadUrlTemplate: string | undefined;
  kubectlPath: string | undefined;
  kubeconfigPath: string | undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function readSettings(): Settings {
  const config = vscode.workspace.getConfiguration('dev.containers');
  return {
    dockerPath: nonEmpty(config.get<string>('dockerPath')) ?? 'docker',
    dockerComposePath: nonEmpty(config.get<string>('dockerComposePath')),
    devcontainerCliPath: nonEmpty(config.get<string>('devcontainerCliPath')),
    logLevel: config.get<Settings['logLevel']>('logLevel') ?? 'info',
    promptToReopen: config.get<boolean>('promptToReopen') ?? true,
    serverDownloadUrlTemplate: nonEmpty(config.get<string>('serverDownloadUrlTemplate')),
    kubectlPath: nonEmpty(config.get<string>('kubectlPath')),
    kubeconfigPath: nonEmpty(config.get<string>('kubeconfigPath')),
  };
}
