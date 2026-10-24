// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseServerBuildInfo } from '../core/server/productInfo';
import type { ServerBuildInfo } from '../core/server/productInfo';

let cached: Promise<Record<string, unknown>> | undefined;

/** The running IDE's product.json (located via the stable `env.appRoot`). */
export function readProduct(): Promise<Record<string, unknown>> {
  cached ??= readFile(path.join(vscode.env.appRoot, 'product.json'), 'utf8').then(
    (text) => JSON.parse(text) as Record<string, unknown>,
  );
  return cached;
}

export async function readServerBuildInfo(): Promise<ServerBuildInfo> {
  return parseServerBuildInfo(await readProduct());
}
