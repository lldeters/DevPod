// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import * as path from 'node:path';
import { DevContainerError, errorMessage } from '../errors';
import type { Logger } from '../logger';
import type { ServerExecutor } from '../server/provisioner';
import {
  buildServerEntry,
  bundleRelativePath,
  checkBundle,
  MCP_SERVER_NAME,
  sha256,
} from './gitlab';
import type { McpGitlabSetup, McpServerEntry } from './gitlab';
import {
  checkServers,
  hasEntry,
  isServerName,
  MCP_SETTINGS_RELATIVE_PATH,
  mergeMcpSettings,
  referencedVariables,
} from './servers';
import type { McpServerConfig } from './servers';

/** What is set up in the pod's `~/.kiro/settings/mcp.json`. */
export interface McpSetup {
  /** The GitLab MCP server, copied into the pod; absent when it is off or there is no bundle. */
  readonly gitlab?: McpGitlabSetup | undefined;
  /** Further servers (`dev.containers.mcpServers`), written as they are. */
  readonly servers: Readonly<Record<string, unknown>>;
  /** Called with the variables the entries refer to that are not set in the pod. */
  readonly onMissingVariables?: ((names: readonly string[]) => void) | undefined;
}

export interface McpTarget {
  readonly containerId: string;
  readonly user?: string | undefined;
  /** Node in the target, the one the IDE server ships; the GitLab MCP server runs with it too. */
  readonly node: string;
  /** The IDE server's data folder below the home directory (`.kiro-server`). */
  readonly dataFolderName: string;
}

export type McpOutcome = 'nohome' | 'unchanged' | 'updated';

/**
 * Which entries of `mcp.json` this extension wrote from `dev.containers.mcpServers`, and which keys
 * it set in each: `{ "<name>": ["<key>", ...] }`, next to the bundle.
 */
type Managed = Record<string, string[]>;

function managedRelativePath(dataFolderName: string): string {
  return bundleRelativePath(dataFolderName).replace(/[^/]+$/, 'managed.json');
}

/** Starts the one line of a script's answer, so output of anything else is ignored. */
export const MCP_MARKER = 'devcontainers-kiro-mcp';

/**
 * Shared by both scripts: `$HOME` (the user's real one, which the IDE's extension host reads too),
 * and folders below it that must be directories of this user, created private if missing. Anyone
 * could have created them first in a home directory others may write to. A link of the user's own
 * (from a dotfiles manager, say) to a directory or file of the user's own is followed. Error
 * messages name paths only; the request is never echoed.
 */
const SCRIPT_PRELUDE = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
process.on('uncaughtException', (e) => { process.stderr.write(String((e && e.message) || e) + '\n'); process.exit(1); });
const answer = (value) => process.stdout.write('\n${MCP_MARKER}==' + JSON.stringify(value) + '\n');
const home = process.env.HOME;
const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
const mine = (st) => uid === undefined || st.uid === uid;
function writableHome() {
  try { return !!home && path.isAbsolute(home) && fs.statSync(home).isDirectory() && (fs.accessSync(home, fs.constants.W_OK), true); }
  catch { return false; }
}
function ownDir(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const link = fs.lstatSync(dir);
  const st = link.isSymbolicLink() ? fs.statSync(dir) : link;
  if (!st.isDirectory() || !mine(link) || !mine(st)) throw new Error(dir + ' is not a directory of this user');
}
function ownPath(rel) {
  let dir = home;
  for (const part of rel.split('/').slice(0, -1)) { dir = path.join(dir, part); ownDir(dir); }
  const file = path.join(home, rel);
  let link;
  try { link = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return file; throw e; }
  if (!link.isSymbolicLink()) return file;
  const real = fs.realpathSync(file);
  const st = fs.statSync(real);
  if (!mine(link) || !st.isFile() || !mine(st) || !mine(fs.statSync(path.dirname(real)))) {
    throw new Error(file + ' links to something that is not a file of this user');
  }
  return real;
}
function input() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8')); } catch { throw new Error('the request could not be read'); }
}
`;

/**
 * Reads the state in the target: whether the home directory is writable, the hash of the bundle
 * there, the text of `mcp.json` and of `managed.json`, and which of the requested variables are not
 * set. Prints nothing else, and never the value of a variable.
 */
export const MCP_STATUS_SCRIPT = `${SCRIPT_PRELUDE}
const req = input();
if (!writableHome()) { answer({ home: null }); process.exit(0); }
const read = (rel) => { try { return fs.readFileSync(path.join(home, rel)); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } };
const bundle = req.bundle ? read(req.bundle) : undefined;
const text = (rel) => { const b = read(rel); return b === undefined ? null : b.toString('utf8'); };
answer({
  home,
  bundleHash: bundle === undefined ? null : crypto.createHash('sha256').update(bundle).digest('hex'),
  settings: text(req.settings),
  managed: text(req.managed),
  missing: req.variables.filter((name) => !process.env[name]),
});
`;

/**
 * Writes \`managed.json\` (first with the entries before and after, so that an entry written by
 * this run is known as its own even if the run stops halfway), the bundle, \`mcp.json\` and the
 * final \`managed.json\`. Each file goes to a new file with an unpredictable name in the same
 * folder (nothing already there is written through), which is removed again on any failure, and is
 * then renamed into place. \`mcp.json\` keeps its mode; nothing is written when it changed since it
 * was read.
 */
export const MCP_WRITE_SCRIPT = `${SCRIPT_PRELUDE}
const req = input();
if (!writableHome()) { answer({ home: null }); process.exit(0); }
function put(rel, text, mode) {
  const file = ownPath(rel);
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + crypto.randomBytes(8).toString('hex'));
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    try { fs.fchmodSync(fd, mode); fs.writeFileSync(fd, text); } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
  } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
let mode = 0o600;
if (req.settings) {
  const file = path.join(home, req.settings.path);
  let before = null;
  try { before = fs.readFileSync(file, 'utf8'); mode = fs.statSync(file).mode & 0o777; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (before !== req.settings.expected) { answer({ home, settings: 'changed' }); process.exit(0); }
}
if (req.managedFirst) put(req.managedFirst.path, req.managedFirst.text, 0o600);
if (req.bundle) put(req.bundle.path, req.bundle.text, 0o600);
if (req.settings) put(req.settings.path, req.settings.text, mode);
if (req.managed) put(req.managed.path, req.managed.text, 0o600);
answer({ home, settings: 'written' });
`;

export function parseScriptAnswer(stdout: string): Record<string, unknown> {
  const prefix = `${MCP_MARKER}==`;
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(prefix));
  let value: unknown;
  try {
    value = line ? JSON.parse(line.slice(prefix.length)) : undefined;
  } catch {
    value = undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DevContainerError(
      'SERVER_INSTALL_FAILED',
      'Unexpected answer while setting up the MCP servers.',
    );
  }
  return value as Record<string, unknown>;
}

async function runNode(
  executor: ServerExecutor,
  target: McpTarget,
  script: string,
  request: unknown,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  const result = await executor.exec({
    containerId: target.containerId,
    user: target.user,
    interactive: true,
    command: [target.node, '-e', script],
    stdin: JSON.stringify(request),
    ...(signal ? { signal } : {}),
  });
  if (result.code !== 0) {
    const detail = result.stderr.trim().split('\n').slice(-3).join('\n');
    throw new DevContainerError(
      'SERVER_INSTALL_FAILED',
      `Could not set up the MCP servers (exit code ${result.code ?? 'unknown'}).${
        detail ? `\n${detail}` : ''
      }`,
    );
  }
  return parseScriptAnswer(result.stdout);
}

function parseManaged(text: unknown): Managed {
  if (typeof text !== 'string') return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const managed: Managed = {};
  for (const [name, keys] of Object.entries(value)) {
    if (isServerName(name) && Array.isArray(keys)) {
      managed[name] = keys.filter((k): k is string => typeof k === 'string');
    }
  }
  return managed;
}

function managedText(managed: Managed): string {
  const sorted = Object.fromEntries(
    Object.keys(managed)
      .sort()
      .map((name) => [name, [...new Set(managed[name])].sort()]),
  );
  return `${JSON.stringify(sorted)}\n`;
}

const NOHOME = 'The user in the pod has no writable home directory, so no MCP servers were set up.';

/** `managed[name]`, also for names such as `constructor` that every object inherits. */
function keysOf(managed: Managed, name: string): string[] {
  return Object.hasOwn(managed, name) ? (managed[name] ?? []) : [];
}

/** The GitLab entry for `bundlePath`, or `undefined` (logged) when the GitLab settings are unusable. */
function gitlabEntryFor(
  setup: McpSetup,
  node: string,
  logger: Logger,
): ((bundlePath: string) => McpServerEntry) | undefined {
  const gitlab = setup.gitlab;
  if (!gitlab) return undefined;
  const problem = checkBundle(gitlab.bundle);
  if (problem) {
    logger.log('warn', `The bundle of the GitLab MCP server is not used because ${problem}.`);
    return undefined;
  }
  try {
    buildServerEntry(node, '/', gitlab.config);
  } catch (error) {
    logger.log('warn', errorMessage(error));
    return undefined;
  }
  return (bundlePath) => buildServerEntry(node, bundlePath, gitlab.config);
}

/**
 * Registers MCP servers in Kiro's user-level `~/.kiro/settings/mcp.json` in the target: the GitLab
 * MCP server, whose bundle is copied below the IDE server's data folder and run with the IDE
 * server's Node, and the servers of `dev.containers.mcpServers`. Idempotent: the bundle is copied
 * only when its hash differs, and `mcp.json` is written only when an entry changes. Other entries
 * are kept, an entry of the user's own is never replaced, and what this extension wrote earlier but
 * is no longer configured (servers, keys of a server) is removed. Secrets are never written;
 * entries refer to variables of the pod, and the ones that are not set are reported. A problem with
 * one server is logged and does not keep the others from being set up.
 */
export async function provisionMcpServers(
  executor: ServerExecutor,
  target: McpTarget,
  setup: McpSetup,
  logger: Logger,
  signal?: AbortSignal,
): Promise<McpOutcome> {
  const gitlabEntry = gitlabEntryFor(setup, target.node, logger);
  const { valid, problems } = checkServers(setup.servers);
  const custom: Record<string, McpServerConfig> = {};
  for (const [name, entry] of Object.entries(valid)) {
    if (gitlabEntry && name === MCP_SERVER_NAME) {
      problems.push(
        `The MCP server "${name}" of "dev.containers.mcpServers" is not set up; the GitLab MCP ` +
          'server of this extension has that name. Turn off "dev.containers.mcpGitlab.enabled" to use your own.',
      );
    } else {
      custom[name] = entry;
    }
  }
  for (const problem of problems) logger.log('warn', problem);

  const bundleRel = bundleRelativePath(target.dataFolderName);
  const managedRel = managedRelativePath(target.dataFolderName);
  const status = await runNode(
    executor,
    target,
    MCP_STATUS_SCRIPT,
    {
      ...(gitlabEntry ? { bundle: bundleRel } : {}),
      settings: MCP_SETTINGS_RELATIVE_PATH,
      managed: managedRel,
      // The bundle's path does not matter for the variables; it is only known once $HOME is.
      variables: referencedVariables([gitlabEntry?.('/'), ...Object.values(custom)]),
    },
    signal,
  );
  if (typeof status.home !== 'string' || !status.home.startsWith('/')) {
    logger.log('warn', NOHOME);
    return 'nohome';
  }
  const bundlePath = path.posix.join(status.home, bundleRel);
  const before = parseManaged(status.managed);
  const gitlab = gitlabEntry?.(bundlePath);
  const wanted: Record<string, McpServerConfig> = {
    ...custom,
    ...(gitlab ? { [MCP_SERVER_NAME]: gitlab } : {}),
  };
  const merged = mergeMcpSettings(typeof status.settings === 'string' ? status.settings : '', {
    servers: wanted,
    isOwn: (name, current) => {
      if (Object.hasOwn(before, name)) return true;
      if (gitlab && name === MCP_SERVER_NAME) {
        const args = (current as { args?: unknown } | null)?.args;
        return Array.isArray(args) && args[0] === bundlePath;
      }
      // Also when managed.json was lost: an entry that is already what would be written.
      const entry = Object.hasOwn(custom, name) ? custom[name] : undefined;
      return entry !== undefined && hasEntry(current, entry);
    },
    previousKeys: (name) => keysOf(before, name),
    remove: Object.keys(before),
  });
  for (const name of merged.foreign) {
    logger.log(
      'warn',
      `~/${MCP_SETTINGS_RELATIVE_PATH} in the pod already has an MCP server "${name}" that this ` +
        'extension did not write; it was left unchanged. Remove it to let the extension set up its own.',
    );
  }
  const after: Managed = Object.fromEntries(
    Object.entries(custom)
      .filter(([name]) => !merged.foreign.includes(name))
      .map(([name, entry]) => [name, Object.keys(entry)]),
  );
  const first: Managed = { ...before };
  for (const [name, keys] of Object.entries(after)) first[name] = [...keysOf(first, name), ...keys];
  const writeFirst = managedText(first) !== managedText(before);
  const writeFinal = managedText(after) !== managedText(first);
  const copyBundle =
    gitlab !== undefined &&
    !merged.foreign.includes(MCP_SERVER_NAME) &&
    status.bundleHash !== sha256(setup.gitlab?.bundle ?? '');

  let outcome: McpOutcome = 'unchanged';
  if (copyBundle || merged.changed || writeFirst || writeFinal) {
    const written = await runNode(
      executor,
      target,
      MCP_WRITE_SCRIPT,
      {
        ...(writeFirst ? { managedFirst: { path: managedRel, text: managedText(first) } } : {}),
        ...(copyBundle && setup.gitlab
          ? { bundle: { path: bundleRel, text: setup.gitlab.bundle } }
          : {}),
        ...(merged.changed
          ? {
              settings: {
                path: MCP_SETTINGS_RELATIVE_PATH,
                text: merged.text,
                expected: typeof status.settings === 'string' ? status.settings : null,
              },
            }
          : {}),
        ...(writeFinal ? { managed: { path: managedRel, text: managedText(after) } } : {}),
      },
      signal,
    );
    if (written.home === null) {
      logger.log('warn', NOHOME);
      return 'nohome';
    }
    if (written.settings === 'changed') {
      throw new DevContainerError(
        'SERVER_INSTALL_FAILED',
        `~/${MCP_SETTINGS_RELATIVE_PATH} in the pod changed while it was being updated; it was left unchanged.`,
      );
    }
    if (copyBundle) logger.log('info', `Copied the GitLab MCP server to ${bundlePath} in the pod`);
    outcome = 'updated';
  }
  const names = Object.keys(wanted).filter((name) => !merged.foreign.includes(name));
  const where = `in the pod (~/${MCP_SETTINGS_RELATIVE_PATH})`;
  const updated = names.filter(
    (name) => merged.updated.includes(name) || (copyBundle && name === MCP_SERVER_NAME),
  );
  if (updated.length > 0) {
    logger.log('info', `Set up the MCP servers ${updated.join(', ')} ${where}.`);
  }
  if (merged.removed.length > 0) {
    logger.log('info', `Removed the MCP servers ${merged.removed.join(', ')} ${where}.`);
  }
  if (updated.length === 0 && merged.removed.length === 0) {
    logger.log('info', `The MCP servers ${where} are up to date.`);
  }
  const used = new Set(referencedVariables(names.map((name) => wanted[name])));
  const missing = Array.isArray(status.missing)
    ? status.missing.filter((v): v is string => typeof v === 'string' && used.has(v))
    : [];
  if (missing.length > 0) {
    const one = missing.length === 1;
    logger.log(
      'warn',
      `Not set in the pod: ${missing.join(', ')}. The MCP servers that need ${one ? 'it' : 'them'} ` +
        `do not work until ${one ? 'it is' : 'they are'} set.`,
    );
    setup.onMissingVariables?.(missing);
  }
  return outcome;
}
