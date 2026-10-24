// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as path from 'node:path';
import * as vscode from 'vscode';
import { decodeAuthority } from '../core/authority';
import { Commands } from './commands';
import { currentAuthority } from './remoteState';

/** Shows an entry in dev container windows that opens the container actions menu. */
export function registerStatusBar(): vscode.Disposable {
  const authority = currentAuthority();
  if (!authority) {
    return new vscode.Disposable(() => undefined);
  }
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10_000);
  let folder = 'container';
  try {
    folder = path.basename(decodeAuthority(authority).hostPath);
  } catch {
    // keep the generic label
  }
  item.text = `$(remote) Dev Container: ${folder}`;
  item.tooltip = 'Dev container actions';
  item.command = Commands.showContainerMenu;
  item.backgroundColor = new vscode.ThemeColor('statusBarItem.remoteBackground');
  item.color = new vscode.ThemeColor('statusBarItem.remoteForeground');
  item.show();
  return item;
}
