// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as vscode from 'vscode';
import { isDevContainerAuthority } from '../core/authority';
import { decodePodAuthority, isPodAuthority } from '../core/k8s/podRef';
import type { PodRef } from '../core/k8s/podRef';

/** Whether the proposed resolver API could be used; set once during activation. */
export class RemoteSupport {
  enabled = false;
  problem: string | undefined;
}

/**
 * The remote authority of this window. A window without a folder has no workspace folder to read
 * it from, so the (proposed) `env.remoteAuthority` is consulted first.
 */
function windowAuthority(): string | undefined {
  const declared = (vscode.env as { remoteAuthority?: string }).remoteAuthority;
  if (declared) {
    return declared;
  }
  const uri = vscode.workspace.workspaceFolders?.[0]?.uri;
  return uri?.scheme === 'vscode-remote' ? uri.authority : undefined;
}

/** The dev container authority of this window, if it is a dev container window. */
export function currentAuthority(): string | undefined {
  const authority = windowAuthority();
  return isDevContainerAuthority(authority) ? authority : undefined;
}

/** The pod container this window is attached to, if it is a pod window. */
export function currentPodRef(): PodRef | undefined {
  const authority = windowAuthority();
  if (!isPodAuthority(authority)) {
    return undefined;
  }
  try {
    return decodePodAuthority(authority);
  } catch {
    return undefined;
  }
}

/** The first local folder of this (non-remote) window. */
export function localWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.find((folder) => folder.uri.scheme === 'file');
}
