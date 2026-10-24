// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { DevContainerError } from '../errors';
import type { LogLevel } from '../logger';

/** One line of the CLI's `--log-format json` stream on stderr. */
export interface CliLogEvent {
  readonly kind: 'text' | 'start' | 'stop' | 'progress' | 'raw';
  readonly level: LogLevel;
  readonly text: string;
}

// The CLI's numeric levels: 1 trace, 2 debug, 3 info, 4 warning, 5 error, 6 critical.
function mapLevel(level: unknown): LogLevel {
  switch (level) {
    case 1:
      return 'trace';
    case 2:
      return 'debug';
    case 4:
      return 'warn';
    case 5:
    case 6:
      return 'error';
    default:
      return 'info';
  }
}

// The CLI forwards output of the tools it runs, including terminal color codes.
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

function clean(text: string): string {
  return text.replace(ANSI_ESCAPE, '');
}

export function parseCliLogLine(line: string): CliLogEvent {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const type = record['type'];
      const text = record['text'] ?? record['name'];
      if (
        (type === 'text' || type === 'start' || type === 'stop' || type === 'progress') &&
        typeof text === 'string'
      ) {
        // Every command is reported twice, when it starts and when it ends; only the start
        // line is useful at debug level.
        const level = type === 'stop' ? 'trace' : mapLevel(record['level']);
        return { kind: type, level, text: clean(text) };
      }
    }
  } catch {
    // not JSON: fall through and report as raw text
  }
  return { kind: 'raw', level: 'info', text: clean(line) };
}

export interface UpSuccess {
  readonly outcome: 'success';
  readonly containerId: string;
  readonly remoteUser: string;
  readonly remoteWorkspaceFolder: string;
  readonly composeProjectName?: string;
}

export interface WorkspaceInfo {
  readonly workspaceFolder: string;
  readonly workspaceMount?: string;
}

export interface ReadConfigurationResult {
  readonly configuration: Record<string, unknown>;
  readonly mergedConfiguration?: Record<string, unknown>;
  readonly workspace: WorkspaceInfo;
}

/** The result is a single JSON document; some versions print it after other lines. */
function parseResultDocument(stdout: string): Record<string, unknown> {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const parsed: unknown = JSON.parse(lines[index] as string);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // keep looking
    }
  }
  throw new DevContainerError('CLI_BAD_OUTPUT', 'The Dev Container CLI returned no result.');
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new DevContainerError(
      'CLI_BAD_OUTPUT',
      `The Dev Container CLI result is missing "${key}".`,
    );
  }
  return value;
}

export function parseUpResult(stdout: string): UpSuccess {
  const result = parseResultDocument(stdout);
  if (result['outcome'] === 'error') {
    const message = typeof result['message'] === 'string' ? result['message'] : 'Unknown error';
    const description = typeof result['description'] === 'string' ? result['description'] : '';
    throw new DevContainerError('CLI_FAILED', description ? `${message}: ${description}` : message);
  }
  if (result['outcome'] !== 'success') {
    throw new DevContainerError('CLI_BAD_OUTPUT', 'The Dev Container CLI result has no outcome.');
  }
  const composeProjectName = result['composeProjectName'];
  return {
    outcome: 'success',
    containerId: requireString(result, 'containerId'),
    remoteUser: requireString(result, 'remoteUser'),
    remoteWorkspaceFolder: requireString(result, 'remoteWorkspaceFolder'),
    ...(typeof composeProjectName === 'string' ? { composeProjectName } : {}),
  };
}

export function parseReadConfigurationResult(stdout: string): ReadConfigurationResult {
  const result = parseResultDocument(stdout);
  const configuration = result['configuration'];
  const workspace = result['workspace'];
  if (typeof configuration !== 'object' || configuration === null) {
    throw new DevContainerError('CLI_BAD_OUTPUT', 'The CLI result has no "configuration".');
  }
  if (typeof workspace !== 'object' || workspace === null) {
    throw new DevContainerError('CLI_BAD_OUTPUT', 'The CLI result has no "workspace".');
  }
  const workspaceRecord = workspace as Record<string, unknown>;
  const workspaceMount = workspaceRecord['workspaceMount'];
  const merged = result['mergedConfiguration'];
  return {
    configuration: configuration as Record<string, unknown>,
    ...(typeof merged === 'object' && merged !== null
      ? { mergedConfiguration: merged as Record<string, unknown> }
      : {}),
    workspace: {
      workspaceFolder: requireString(workspaceRecord, 'workspaceFolder'),
      ...(typeof workspaceMount === 'string' ? { workspaceMount } : {}),
    },
  };
}
