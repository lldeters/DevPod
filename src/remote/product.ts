// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { parseServerBuildInfo } from '../core/server/productInfo';
import type { ServerBuildInfo } from '../core/server/productInfo';

let cached: { file: string; promise: Promise<Record<string, unknown>> } | undefined;

/** The running IDE's product.json (located via the stable `env.appRoot`). */
export function readProduct(): Promise<Record<string, unknown>> {
  const file = path.join(vscode.env.appRoot, 'product.json');
  if (cached?.file !== file) {
    const promise = readFile(file, 'utf8').then(
      (text) => JSON.parse(text) as Record<string, unknown>,
      (error: unknown) => {
        cached = undefined; // a failed read must not be remembered
        throw error;
      },
    );
    cached = { file, promise };
  }
  return cached.promise;
}

export async function readServerBuildInfo(): Promise<ServerBuildInfo> {
  return parseServerBuildInfo(await readProduct());
}
