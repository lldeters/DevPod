// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as path from 'node:path';
import * as vscode from 'vscode';
import { decodeAuthority } from '../core/authority';
import { Commands } from './commands';
import { currentAuthority, currentPodRef } from './remoteState';

/** Shows an entry in dev container and pod windows that opens the matching actions menu. */
export function registerStatusBar(): vscode.Disposable {
  const pod = currentPodRef();
  if (pod) {
    const podItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10_000);
    podItem.text = `$(remote) Pod: ${pod.pod}`;
    podItem.tooltip = `${pod.namespace}/${pod.pod}, container ${pod.container}${
      pod.context ? `, context ${pod.context}` : ''
    }`;
    podItem.command = Commands.showPodMenu;
    podItem.backgroundColor = new vscode.ThemeColor('statusBarItem.remoteBackground');
    podItem.color = new vscode.ThemeColor('statusBarItem.remoteForeground');
    podItem.show();
    return podItem;
  }
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
