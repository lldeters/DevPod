// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { enableProposedApi, isProposedApiEnabled } from '../core/argv';
import { errorMessage } from '../core/errors';
import type { Logger } from '../core/logger';
import { readProduct } from '../remote/product';

/** Same rule the IDE uses: portable install, else ~/<dataFolderName>/argv.json. */
export async function argvJsonPath(): Promise<string | undefined> {
  const portable = process.env['VSCODE_PORTABLE'];
  if (portable) {
    return path.join(portable, 'argv.json');
  }
  const dataFolder = (await readProduct())['dataFolderName'];
  return typeof dataFolder === 'string' && dataFolder !== ''
    ? path.join(os.homedir(), dataFolder, 'argv.json')
    : undefined;
}

export async function readIfExists(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw error;
  }
}

/**
 * Lets the user allow this extension to use proposed APIs by editing the IDE's argv.json, which
 * is the documented way to enable them. Nothing is written without explicit confirmation.
 */
export async function setupRemoteSupport(extensionId: string, logger: Logger): Promise<void> {
  const file = await argvJsonPath().catch(() => undefined);
  if (!file) {
    await vscode.commands.executeCommand('workbench.action.configureRuntimeArguments');
    void vscode.window.showInformationMessage(
      `Add "${extensionId}" to the "enable-proposed-api" list in the file that just opened, then restart.`,
    );
    return;
  }

  let current: string;
  try {
    current = await readIfExists(file);
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not read ${file}: ${errorMessage(error)}`);
    return;
  }
  if (isProposedApiEnabled(current, extensionId)) {
    void vscode.window.showInformationMessage(
      'Remote support is already enabled. If it does not work yet, quit and restart the IDE completely.',
    );
    return;
  }

  const confirm = 'Update argv.json';
  const choice = await vscode.window.showInformationMessage(
    `This extension needs permission to use the IDE's proposed remote APIs. ` +
      `"${extensionId}" will be added to "enable-proposed-api" in ${file}.`,
    { modal: true },
    confirm,
  );
  if (choice !== confirm) {
    return;
  }

  try {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, enableProposedApi(current, extensionId), 'utf8');
  } catch (error) {
    logger.log('error', `Could not update ${file}: ${errorMessage(error)}`);
    void vscode.window.showErrorMessage(`Could not update ${file}: ${errorMessage(error)}`);
    return;
  }
  logger.log('info', `Added ${extensionId} to enable-proposed-api in ${file}`);

  const quit = 'Quit Now';
  const next = await vscode.window.showInformationMessage(
    'Remote support is enabled. Quit and restart the IDE completely for it to take effect.',
    quit,
  );
  if (next === quit) {
    await vscode.commands.executeCommand('workbench.action.quit');
  }
}
