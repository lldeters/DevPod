// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

// Reads the parts of a merged dev container configuration that the IDE (not the container tooling)
// acts on: extensions, settings and forwarded ports. The Dev Container CLI's merged configuration
// is the input, so values contributed by Features are already included.

import { isValidExtensionId } from '../extensionId';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * `customizations.<tool>` is an object in devcontainer.json, but the CLI's merged configuration
 * collects one entry per source (the config itself and each Feature) into an array. Both occur.
 */
function sourcesOf(customizations: unknown, tool: string): Record<string, unknown>[] {
  if (!isRecord(customizations)) {
    return [];
  }
  const value = customizations[tool];
  if (Array.isArray(value)) {
    return value.filter(isRecord);
  }
  return isRecord(value) ? [value] : [];
}

export interface IdeCustomizations {
  /** Extension ids to install in the container, de-duplicated (first spelling wins). */
  extensions: string[];
  /** Settings for the container's machine settings; later sources override earlier ones. */
  settings: Record<string, unknown>;
  /** Entries that are not plain extension ids (for example with a version); reported, not used. */
  rejectedExtensions: string[];
}

/**
 * Extensions and settings from `customizations.vscode`, then `customizations.kiro`. Kiro's own
 * section is read last so that it can override what is meant for VS Code.
 */
export function extractCustomizations(config: Record<string, unknown>): IdeCustomizations {
  const customizations = config['customizations'];
  const sources = [...sourcesOf(customizations, 'vscode'), ...sourcesOf(customizations, 'kiro')];

  const extensions: string[] = [];
  const rejectedExtensions: string[] = [];
  const seen = new Set<string>();
  const settings: Record<string, unknown> = {};

  for (const source of sources) {
    const listed = source['extensions'];
    for (const entry of Array.isArray(listed) ? listed : []) {
      if (typeof entry !== 'string') {
        continue;
      }
      if (!isValidExtensionId(entry)) {
        rejectedExtensions.push(entry);
      } else if (!seen.has(entry.toLowerCase())) {
        seen.add(entry.toLowerCase());
        extensions.push(entry);
      }
    }
    if (isRecord(source['settings'])) {
      Object.assign(settings, source['settings']);
    }
  }
  return { extensions, settings, rejectedExtensions };
}

/** A port to forward, as host and port inside the container's network. */
export interface ForwardedPort {
  readonly host: string;
  readonly port: number;
}

const HOST = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function parsePort(entry: unknown): ForwardedPort | undefined {
  if (typeof entry === 'number') {
    return Number.isInteger(entry) && entry >= 1 && entry <= 65535
      ? { host: 'localhost', port: entry }
      : undefined;
  }
  if (typeof entry !== 'string') {
    return undefined;
  }
  const match = /^(?:([^:]+):)?(\d{1,5})$/.exec(entry.trim());
  if (!match) {
    return undefined;
  }
  const host = match[1] ?? 'localhost';
  const port = Number(match[2]);
  return HOST.test(host) && port >= 1 && port <= 65535 ? { host, port } : undefined;
}

/**
 * `forwardPorts`: numbers, or `"host:port"` strings to reach another container of a Compose
 * project. Duplicates are dropped; entries that cannot be used are returned for logging.
 */
export function extractForwardPorts(config: Record<string, unknown>): {
  ports: ForwardedPort[];
  rejected: string[];
} {
  const listed = config['forwardPorts'];
  const ports: ForwardedPort[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(listed) ? listed : []) {
    const port = parsePort(entry);
    if (!port) {
      rejected.push(String(entry));
    } else if (!seen.has(`${port.host}:${port.port}`)) {
      seen.add(`${port.host}:${port.port}`);
      ports.push(port);
    }
  }
  return { ports, rejected };
}

/**
 * `remoteEnv`: variables for the processes the IDE starts in the container (extension host,
 * terminals). `null` removes a variable. The CLI has already substituted `${containerEnv:...}` and
 * `${localEnv:...}` in its merged configuration. Entries that are neither are returned for logging.
 */
export function extractRemoteEnv(config: Record<string, unknown>): {
  env: Record<string, string | null>;
  rejected: string[];
} {
  const env: Record<string, string | null> = {};
  const rejected: string[] = [];
  const listed = config['remoteEnv'];
  for (const [name, value] of Object.entries(isRecord(listed) ? listed : {})) {
    if (name === '' || /[=\0]/.test(name) || (typeof value !== 'string' && value !== null)) {
      rejected.push(name);
    } else {
      env[name] = value;
    }
  }
  return { env, rejected };
}

/**
 * `portsAttributes` and `otherPortsAttributes` use the same shape as the IDE's
 * `remote.portsAttributes` and `remote.otherPortsAttributes` settings, so they are applied by
 * writing them into the container's machine settings.
 */
export function portsAttributesSettings(config: Record<string, unknown>): Record<string, unknown> {
  const settings: Record<string, unknown> = {};
  if (isRecord(config['portsAttributes'])) {
    settings['remote.portsAttributes'] = config['portsAttributes'];
  }
  if (isRecord(config['otherPortsAttributes'])) {
    settings['remote.otherPortsAttributes'] = config['otherPortsAttributes'];
  }
  return settings;
}
