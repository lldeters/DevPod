// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { applyEdits, modify, parse } from 'jsonc-parser';
import type { ParseError } from 'jsonc-parser';
import { DevContainerError } from '../errors';
import type { Logger } from '../logger';
import type { ServerExecutor } from '../server/provisioner';

/** The key of the entry in `mcpServers` that this extension manages. */
export const MCP_SERVER_NAME = 'gitlab';

/** The variable the server reads its token from; only a reference to it is ever written. */
export const TOKEN_VARIABLE = 'GITLAB_PERSONAL_ACCESS_TOKEN';

/** Kiro's user-level MCP configuration, relative to the home directory. */
export const MCP_SETTINGS_RELATIVE_PATH = '.kiro/settings/mcp.json';

/** The bundle is one JavaScript file of a few MB; anything much larger is not what we expect. */
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SAFE_FOLDER = /^\.?[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface McpGitlabConfig {
  /** `GITLAB_API_URL`; left out when empty, so the server's own default applies. */
  readonly apiUrl?: string | undefined;
  /** `GITLAB_READ_ONLY_MODE`. */
  readonly readOnly: boolean;
  /** `GITLAB_TOOLSETS`, a comma-separated list; left out when empty. */
  readonly toolsets?: string | undefined;
  /** Further variables for the server (proxy, certificates), never the token. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

/** What is set up in the pod: the bundle of `mcp-gitlab` and how to configure it. */
export interface McpGitlabSetup {
  /** Content of `mcp-gitlab.mjs`, a single-file bundle that needs no `node_modules`. */
  readonly bundle: string;
  readonly config: McpGitlabConfig;
  /** Called when the pod has no token in its environment, so the server will get a 401. */
  readonly onTokenMissing?: (() => void) | undefined;
}

export interface McpGitlabTarget {
  readonly containerId: string;
  readonly user?: string | undefined;
  /** Node in the target, the one the IDE server ships; the MCP server runs with it too. */
  readonly node: string;
  /** The IDE server's data folder below the home directory (`.kiro-server`). */
  readonly dataFolderName: string;
}

export type McpGitlabOutcome =
  | 'nohome'
  | 'unchanged'
  | 'updated'
  /** A `gitlab` entry that this extension did not write; it is left as it is. */
  | 'foreign';

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Why `bundle` cannot be the server bundle, or `undefined` if it may be one. */
export function checkBundle(bundle: string): string | undefined {
  if (bundle.length === 0) return 'it is empty';
  if (Buffer.byteLength(bundle, 'utf8') > MAX_BUNDLE_BYTES) return 'it is larger than expected';
  if (bundle.includes('\0')) return 'it is not a text file';
  return undefined;
}

/**
 * The variables of the entry. The token is a reference that the IDE expands from the environment
 * of the pod when it starts the server, so its value is never written to a file.
 */
export function serverEnv(config: McpGitlabConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(config.env ?? {})) {
    if (!VARIABLE_NAME.test(name) || typeof value !== 'string') {
      throw new DevContainerError(
        'CONFIG_INVALID',
        `"${name}" is not a valid variable name for the GitLab MCP server.`,
      );
    }
    if (name === TOKEN_VARIABLE) {
      throw new DevContainerError(
        'CONFIG_INVALID',
        `${TOKEN_VARIABLE} cannot be set for the GitLab MCP server; it is taken from the pod's environment.`,
      );
    }
    env[name] = value;
  }
  const apiUrl = config.apiUrl?.trim();
  if (apiUrl) env.GITLAB_API_URL = apiUrl;
  env.GITLAB_READ_ONLY_MODE = config.readOnly ? 'true' : 'false';
  const toolsets = config.toolsets?.trim();
  if (toolsets) env.GITLAB_TOOLSETS = toolsets;
  env[TOKEN_VARIABLE] = `\${${TOKEN_VARIABLE}}`;
  return env;
}

export interface McpServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export function buildServerEntry(
  node: string,
  bundlePath: string,
  config: McpGitlabConfig,
): McpServerEntry {
  return { command: node, args: [bundlePath], env: serverEnv(config) };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Sets `mcpServers.gitlab` in the text of Kiro's `mcp.json`. Comments, other servers and other keys
 * are kept. An entry whose first argument is not `bundlePath` was written by someone else and is
 * not touched (`foreign`). Keys of an own entry that are not ours (`disabled`, `autoApprove`) are
 * kept; `command`, `args` and `env` are replaced.
 */
export function mergeMcpSettings(
  existing: string,
  bundlePath: string,
  entry: McpServerEntry,
): { text: string; outcome: 'unchanged' | 'updated' | 'foreign' } {
  const errors: ParseError[] = [];
  const parsed: unknown = parse(existing, errors, {
    allowTrailingComma: true,
    allowEmptyContent: true,
  });
  const root = existing.trim() === '' ? {} : asRecord(parsed);
  if (errors.length > 0 || root === undefined) {
    throw new DevContainerError(
      'CONFIG_INVALID',
      `~/${MCP_SETTINGS_RELATIVE_PATH} in the pod is not a valid JSON object, so it was left unchanged.`,
    );
  }
  const servers = root.mcpServers;
  if (servers !== undefined && asRecord(servers) === undefined) {
    throw new DevContainerError(
      'CONFIG_INVALID',
      `"mcpServers" in ~/${MCP_SETTINGS_RELATIVE_PATH} in the pod is not an object, so it was left unchanged.`,
    );
  }
  const current = asRecord(servers)?.[MCP_SERVER_NAME];
  if (current !== undefined) {
    const args = asRecord(current)?.args;
    if (!Array.isArray(args) || args[0] !== bundlePath) {
      return { text: existing, outcome: 'foreign' };
    }
  }
  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: '\n' };
  let text = existing.trim() === '' ? '{}\n' : existing;
  for (const [key, value] of Object.entries(entry)) {
    if (JSON.stringify(asRecord(current)?.[key]) === JSON.stringify(value)) continue;
    text = applyEdits(
      text,
      modify(text, ['mcpServers', MCP_SERVER_NAME, key], value, { formattingOptions }),
    );
  }
  return text === existing ? { text, outcome: 'unchanged' } : { text, outcome: 'updated' };
}

/** Starts and ends the one line of a script's answer, so output of anything else is ignored. */
export const MCP_MARKER = 'devcontainers-kiro-mcp';

/**
 * Shared by both scripts: `$HOME` (the user's real one, which the IDE's extension host reads too),
 * and folders below it that must be real directories of this user, created private if missing.
 * Anyone could have created them first in a home directory others may write to.
 */
const SCRIPT_PRELUDE = String.raw`
const fs = require('fs'), path = require('path'), crypto = require('crypto');
process.on('uncaughtException', (e) => { process.stderr.write(String((e && e.message) || e) + '\n'); process.exit(1); });
const answer = (value) => process.stdout.write('\n${MCP_MARKER}==' + JSON.stringify(value) + '\n');
const home = process.env.HOME;
function writableHome() {
  try { return !!home && path.isAbsolute(home) && fs.statSync(home).isDirectory() && (fs.accessSync(home, fs.constants.W_OK), true); }
  catch { return false; }
}
function ownDir(dir) {
  try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || (typeof process.getuid === 'function' && st.uid !== process.getuid())) {
    throw new Error(dir + ' is not a directory of this user');
  }
}
function ownPath(rel) {
  let dir = home;
  for (const part of rel.split('/').slice(0, -1)) { dir = path.join(dir, part); ownDir(dir); }
  return path.join(home, rel);
}
const input = () => JSON.parse(fs.readFileSync(0, 'utf8'));
`;

/**
 * Reads the state in the target: whether the home directory is writable, the hash of the bundle
 * there, the text of `mcp.json` and whether the token variable is set. Prints nothing else, and
 * never the token.
 */
export const MCP_STATUS_SCRIPT = `${SCRIPT_PRELUDE}
const req = input();
if (!writableHome()) { answer({ home: null }); process.exit(0); }
const read = (file) => { try { return fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; } };
const bundle = read(path.join(home, req.bundle));
const settings = read(path.join(home, req.settings));
answer({
  home,
  bundleHash: bundle === undefined ? null : crypto.createHash('sha256').update(bundle).digest('hex'),
  settings: settings === undefined ? null : settings.toString('utf8'),
  token: !!process.env[req.token],
});
`;

/**
 * Writes the bundle and/or `mcp.json` below the home directory. Each file goes to a new file with
 * an unpredictable name first (nothing already there is written through) and is then renamed into
 * place. `mcp.json` keeps its mode; it is not written when it changed since it was read.
 */
export const MCP_WRITE_SCRIPT = `${SCRIPT_PRELUDE}
const req = input();
if (!writableHome()) { answer({ home: null }); process.exit(0); }
function put(rel, text, mode) {
  const file = ownPath(rel);
  const tmp = file + '.' + crypto.randomBytes(8).toString('hex');
  fs.writeFileSync(tmp, text, { flag: 'wx', mode });
  try { fs.renameSync(tmp, file); } catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}
if (req.bundle) put(req.bundle.path, req.bundle.text, 0o600);
if (req.settings) {
  const file = path.join(home, req.settings.path);
  let before = null, mode = 0o600;
  try { before = fs.readFileSync(file, 'utf8'); mode = fs.statSync(file).mode & 0o777; } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (before !== req.settings.expected) { answer({ home, settings: 'changed' }); process.exit(0); }
  put(req.settings.path, req.settings.text, mode);
}
answer({ home, settings: 'written' });
`;

/** The bundle's place below the home directory: `<dataFolderName>/mcp/mcp-gitlab.mjs`. */
export function bundleRelativePath(dataFolderName: string): string {
  if (!SAFE_FOLDER.test(dataFolderName) || dataFolderName.includes('..')) {
    throw new DevContainerError('SERVER_UNSUPPORTED', 'Unsafe server data folder name.');
  }
  return `${dataFolderName}/mcp/mcp-gitlab.mjs`;
}

export function parseScriptAnswer(stdout: string): Record<string, unknown> {
  const prefix = `${MCP_MARKER}==`;
  const line = stdout
    .split('\n')
    .reverse()
    .find((l) => l.startsWith(prefix));
  const value: unknown = line ? JSON.parse(line.slice(prefix.length)) : undefined;
  const record = asRecord(value);
  if (!record) {
    throw new DevContainerError(
      'SERVER_INSTALL_FAILED',
      'Unexpected answer while setting up the GitLab MCP server.',
    );
  }
  return record;
}

async function runNode(
  executor: ServerExecutor,
  target: McpGitlabTarget,
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
      `Could not set up the GitLab MCP server (exit code ${result.code ?? 'unknown'}).${
        detail ? `\n${detail}` : ''
      }`,
    );
  }
  return parseScriptAnswer(result.stdout);
}

const OUTCOME_MESSAGES: Record<McpGitlabOutcome, string> = {
  nohome:
    'The user in the pod has no writable home directory, so the GitLab MCP server was not set up.',
  unchanged: 'The GitLab MCP server in the pod is up to date.',
  updated: `Set up the GitLab MCP server in the pod (~/${MCP_SETTINGS_RELATIVE_PATH}).`,
  foreign:
    `~/${MCP_SETTINGS_RELATIVE_PATH} in the pod already has an MCP server "${MCP_SERVER_NAME}" ` +
    'that this extension did not write; it was left unchanged. Remove it to let the extension ' +
    'set up its own.',
};

/**
 * Places the bundle of the GitLab MCP server below the home directory of the target and registers
 * it as `gitlab` in Kiro's user-level `~/.kiro/settings/mcp.json` there, with the IDE server's Node.
 * Idempotent: the bundle is copied only when its hash differs, and `mcp.json` is written only when
 * the entry changes. Other entries are kept, and a `gitlab` entry of the user is never replaced.
 * The token is never read or written; the entry refers to the variable of the pod's environment.
 */
export async function provisionMcpGitlab(
  executor: ServerExecutor,
  target: McpGitlabTarget,
  setup: McpGitlabSetup,
  logger: Logger,
  signal?: AbortSignal,
): Promise<McpGitlabOutcome> {
  const problem = checkBundle(setup.bundle);
  if (problem) {
    throw new DevContainerError(
      'CONFIG_INVALID',
      `The bundle of the GitLab MCP server is not used because ${problem}.`,
    );
  }
  const bundleRel = bundleRelativePath(target.dataFolderName);
  const status = await runNode(
    executor,
    target,
    MCP_STATUS_SCRIPT,
    { bundle: bundleRel, settings: MCP_SETTINGS_RELATIVE_PATH, token: TOKEN_VARIABLE },
    signal,
  );
  if (typeof status.home !== 'string' || !status.home.startsWith('/')) {
    logger.log('warn', OUTCOME_MESSAGES.nohome);
    return 'nohome';
  }
  const bundlePath = `${status.home.replace(/\/+$/, '')}/${bundleRel}`;
  const existing = typeof status.settings === 'string' ? status.settings : '';
  const merged = mergeMcpSettings(
    existing,
    bundlePath,
    buildServerEntry(target.node, bundlePath, setup.config),
  );
  const copyBundle = merged.outcome !== 'foreign' && status.bundleHash !== sha256(setup.bundle);
  const writeSettings = merged.outcome === 'updated';

  let outcome: McpGitlabOutcome = merged.outcome;
  if (copyBundle || writeSettings) {
    const written = await runNode(
      executor,
      target,
      MCP_WRITE_SCRIPT,
      {
        ...(copyBundle ? { bundle: { path: bundleRel, text: setup.bundle } } : {}),
        ...(writeSettings
          ? {
              settings: {
                path: MCP_SETTINGS_RELATIVE_PATH,
                text: merged.text,
                expected: typeof status.settings === 'string' ? status.settings : null,
              },
            }
          : {}),
      },
      signal,
    );
    if (written.home === null) {
      logger.log('warn', OUTCOME_MESSAGES.nohome);
      return 'nohome';
    }
    if (written.settings === 'changed') {
      throw new DevContainerError(
        'SERVER_INSTALL_FAILED',
        `~/${MCP_SETTINGS_RELATIVE_PATH} in the pod changed while it was being updated; it was left unchanged.`,
      );
    }
    if (copyBundle) {
      logger.log('info', `Copied the GitLab MCP server to ${bundlePath} in the pod`);
      if (outcome === 'unchanged') outcome = 'updated';
    }
  }
  logger.log(outcome === 'foreign' ? 'warn' : 'info', OUTCOME_MESSAGES[outcome]);
  if (outcome !== 'foreign' && status.token !== true) {
    logger.log(
      'warn',
      `${TOKEN_VARIABLE} is not set in the pod, so the GitLab MCP server cannot sign in to GitLab.`,
    );
    setup.onTokenMissing?.();
  }
  return outcome;
}
