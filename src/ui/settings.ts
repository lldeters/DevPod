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
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Up to 0.1.0 the setting was a boolean; those values keep their meaning. */
function shareKiroLogin(value: unknown): ShareKiroLogin {
  if (value === true) return 'always';
  if (value === false) return 'never';
  return value === 'always' || value === 'never' ? value : 'ask';
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
    kubectlWSLDistro: nonEmpty(config.get<string>('kubectlWSLDistro')),
    kubectlWSLBrowser: config.get<unknown>('kubectlWSLBrowser') === 'wsl' ? 'wsl' : 'windows',
    shareKiroLogin: shareKiroLogin(config.get<unknown>('shareKiroLogin')),
  };
}
