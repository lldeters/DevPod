// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import { discoverConfigs } from '../core/config/discovery';
import { Commands } from './commands';
import { currentAuthority, localWorkspaceFolder } from './remoteState';
import { readSettings } from './settings';

/** In a local window, offers to reopen a folder that has a dev container configuration. */
export async function promptToReopen(context: vscode.ExtensionContext): Promise<void> {
  if (currentAuthority() || vscode.env.remoteName || !readSettings().promptToReopen) {
    return;
  }
  const folder = localWorkspaceFolder();
  if (!folder) {
    return;
  }
  const key = `prompted:${folder.uri.toString()}`;
  if (context.workspaceState.get<boolean>(key)) {
    return;
  }
  if ((await discoverConfigs(folder.uri.fsPath)).length === 0) {
    return;
  }

  const reopen = 'Reopen in Container';
  const never = "Don't Show Again";
  const choice = await vscode.window.showInformationMessage(
    'This folder contains a dev container configuration. Reopen it in a container?',
    reopen,
    never,
  );
  await context.workspaceState.update(key, true);
  if (choice === reopen) {
    await vscode.commands.executeCommand(Commands.reopenInContainer);
  } else if (choice === never) {
    await vscode.workspace
      .getConfiguration('dev.containers')
      .update('promptToReopen', false, vscode.ConfigurationTarget.Global);
  }
}
