// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import { isDevContainerAuthority } from '../core/authority';

/** Whether the proposed resolver API could be used; set once during activation. */
export class RemoteSupport {
  enabled = false;
  problem: string | undefined;
}

/** The dev container authority of this window, if it is a dev container window. */
export function currentAuthority(): string | undefined {
  const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (uri?.scheme === 'vscode-remote' && isDevContainerAuthority(uri.authority)) {
    return uri.authority;
  }
  return undefined;
}

/** The first local folder of this (non-remote) window. */
export function localWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'file');
}
