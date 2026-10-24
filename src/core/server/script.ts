// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { DevContainerError } from '../errors';
import { isValidExtensionId } from '../extensionId';

export const INSTALL_MARKER = 'devcontainers-kiro-server';

/** Quotes a value for use as a single POSIX shell word. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// Hidden folders such as `.kiro-server` are the norm for the data folder.
const SAFE_HIDDEN_NAME = /^\.?[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertSafeName(value: string, what: string, allowLeadingDot = false): void {
  const pattern = allowLeadingDot ? SAFE_HIDDEN_NAME : SAFE_NAME;
  if (!pattern.test(value) || value.includes('..')) {
    throw new DevContainerError('SERVER_UNSUPPORTED', `Unsafe ${what}: ${JSON.stringify(value)}`);
  }
}

export interface InstallScriptParams {
  /** Folder below $HOME, e.g. `.kiro-server`. */
  dataFolderName: string;
  commit: string;
  /** Launcher name in `<serverDir>/bin/`. */
  applicationName: string;
  downloadUrl: string;
  /** Leading path components to drop when unpacking the archive. */
  stripComponents?: number;
  /** Flags passed to the server launcher in addition to the ones this extension requires. */
  extraServerArgs?: readonly string[];
  /**
   * Extensions the server installs when it is started. They are not installed again while a
   * server is already running (a rebuilt container starts a fresh server).
   */
  extensions?: readonly string[];
}

// These flags follow the public VS Code remote extension host CLI and were confirmed against
// Kiro 1.4.26's server (see docs/ARCHITECTURE.md). `--install-extension` is part of the same CLI.
const REQUIRED_SERVER_ARGS = [
  '--start-server',
  '--host=127.0.0.1',
  '--port=0',
  '--accept-server-license-terms',
] as const;

/**
 * Builds a POSIX sh script that downloads and unpacks the IDE server (once per commit), starts it
 * bound to 127.0.0.1 on a random port, and prints `key==value` lines describing the result.
 * Running it again reuses a running server. The script is meant to be piped to `sh -s`, so no
 * value ever appears on a process command line.
 */
export function buildInstallScript(params: InstallScriptParams): string {
  assertSafeName(params.dataFolderName, 'server data folder name', true);
  assertSafeName(params.commit, 'commit id');
  assertSafeName(params.applicationName, 'server application name');
  const strip = params.stripComponents ?? 1;
  if (!Number.isInteger(strip) || strip < 0 || strip > 5) {
    throw new DevContainerError('SERVER_UNSUPPORTED', 'Invalid archive strip depth.');
  }
  const extensionArgs = (params.extensions ?? []).flatMap((id) => {
    if (!isValidExtensionId(id)) {
      throw new DevContainerError(
        'SERVER_UNSUPPORTED',
        `Not a valid extension id: ${JSON.stringify(id)}`,
      );
    }
    return ['--install-extension', id];
  });
  const serverArgs = [...REQUIRED_SERVER_ARGS, ...extensionArgs, ...(params.extraServerArgs ?? [])]
    .map(shQuote)
    .join(' ');

  return `
set -eu
umask 077
echo "${INSTALL_MARKER}: start"
fail() { echo "error==$1"; echo "${INSTALL_MARKER}: end"; exit 1; }

DATA_FOLDER=${shQuote(params.dataFolderName)}
COMMIT=${shQuote(params.commit)}
APP_NAME=${shQuote(params.applicationName)}
DOWNLOAD_URL=${shQuote(params.downloadUrl)}

BASE="\${HOME:-}"
if [ -z "$BASE" ] || [ ! -d "$BASE" ] || [ ! -w "$BASE" ]; then BASE=/tmp; fi
ROOT="$BASE/$DATA_FOLDER"
SERVER_DIR="$ROOT/bin/$COMMIT"
LOG_FILE="$ROOT/server-$COMMIT.log"
PID_FILE="$ROOT/server-$COMMIT.pid"
TOKEN_FILE="$ROOT/server-$COMMIT.token"
PORT_FILE="$ROOT/server-$COMMIT.port"

mkdir -p "$ROOT/bin" || fail "cannot create $ROOT"

if [ ! -f "$SERVER_DIR/.installed" ]; then
  TMP_DIR="$(mktemp -d "$ROOT/tmp.XXXXXX")" || fail "mktemp failed"
  trap 'rm -rf "$TMP_DIR"' EXIT
  ARCHIVE="$TMP_DIR/server.tar.gz"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --connect-timeout 20 -o "$ARCHIVE" "$DOWNLOAD_URL" \\
      || fail "download failed: $DOWNLOAD_URL"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$ARCHIVE" "$DOWNLOAD_URL" || fail "download failed: $DOWNLOAD_URL"
  else
    fail "neither curl nor wget is installed in the container"
  fi
  command -v tar >/dev/null 2>&1 || fail "tar is not installed in the container"
  mkdir -p "$TMP_DIR/extract"
  tar -xzf "$ARCHIVE" -C "$TMP_DIR/extract" --strip-components=${strip} || fail "extraction failed"
  rm -rf "$SERVER_DIR"
  mv "$TMP_DIR/extract" "$SERVER_DIR" || fail "could not move the server into place"
  touch "$SERVER_DIR/.installed"
fi

[ -x "$SERVER_DIR/bin/$APP_NAME" ] || fail "server launcher bin/$APP_NAME not found or not executable"

if [ -f "$PID_FILE" ] && [ -f "$PORT_FILE" ] && [ -f "$TOKEN_FILE" ] \\
   && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  PORT="$(cat "$PORT_FILE")"
else
  rm -f "$PID_FILE" "$PORT_FILE" "$TOKEN_FILE" "$LOG_FILE"
  TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \\n')"
  printf '%s' "$TOKEN" > "$TOKEN_FILE"
  if command -v setsid >/dev/null 2>&1; then LAUNCH="setsid nohup"; else LAUNCH="nohup"; fi
  $LAUNCH "$SERVER_DIR/bin/$APP_NAME" ${serverArgs} \\
    --connection-token-file "$TOKEN_FILE" > "$LOG_FILE" 2>&1 < /dev/null &
  echo $! > "$PID_FILE"
  PORT=""
  TRIES=0
  while [ "$TRIES" -lt 60 ]; do
    PORT="$(sed -n 's/.*listening on \\([0-9][0-9]*\\).*/\\1/p' "$LOG_FILE" 2>/dev/null | head -n 1)"
    [ -n "$PORT" ] && break
    kill -0 "$(cat "$PID_FILE")" 2>/dev/null \\
      || fail "the server exited during startup: $(tail -n 5 "$LOG_FILE" | tr '\\n' ' ')"
    TRIES=$((TRIES + 1))
    sleep 1
  done
  [ -n "$PORT" ] || fail "timed out waiting for the server to listen"
  printf '%s' "$PORT" > "$PORT_FILE"
fi

if [ -x "$SERVER_DIR/node" ]; then NODE_BIN="$SERVER_DIR/node"; else NODE_BIN="node"; fi
echo "serverDir==$SERVER_DIR"
echo "port==$PORT"
echo "token==$(cat "$TOKEN_FILE")"
echo "node==$NODE_BIN"
echo "log==$LOG_FILE"
echo "${INSTALL_MARKER}: end"
`;
}

/**
 * Reads `key==value` lines between `<marker>: start` and `<marker>: end`. Anything outside the
 * markers (login banners, shell noise) is ignored.
 */
export function parseKeyValueOutput(output: string, marker: string): Record<string, string> {
  const values: Record<string, string> = {};
  let inside = false;
  for (const raw of output.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === `${marker}: start`) {
      inside = true;
    } else if (line === `${marker}: end`) {
      return values;
    } else if (inside) {
      const index = line.indexOf('==');
      if (index > 0) {
        values[line.slice(0, index)] = line.slice(index + 2);
      }
    }
  }
  throw new DevContainerError(
    'SERVER_INSTALL_FAILED',
    'The server setup script produced no result (it may have been interrupted).',
  );
}

export interface InstallResult {
  serverDir: string;
  port: number;
  token: string;
  node: string;
  log: string;
}

export function parseInstallResult(output: string): InstallResult {
  const values = parseKeyValueOutput(output, INSTALL_MARKER);
  const error = values['error'];
  if (error !== undefined) {
    throw new DevContainerError('SERVER_INSTALL_FAILED', error);
  }
  const port = Number(values['port']);
  const { serverDir, token, node, log } = values;
  if (
    !Number.isInteger(port) ||
    port <= 0 ||
    port > 65535 ||
    !serverDir ||
    !token ||
    !node ||
    !log
  ) {
    throw new DevContainerError(
      'SERVER_INSTALL_FAILED',
      'The server setup script returned incomplete information.',
    );
  }
  return { serverDir, port, token, node, log };
}

/**
 * JavaScript run with the container's Node binary: it relays stdin/stdout to a TCP port. The port
 * is the first argument and the optional host (default 127.0.0.1) the second; both are validated
 * here, never interpolated into the script. The host lets port forwarding reach another container
 * of a Compose project from the one that is executed in.
 */
export const BRIDGE_SCRIPT = [
  "const net = require('net');",
  'const port = Number(process.argv[1]);',
  "const host = process.argv[2] || '127.0.0.1';",
  'if (!Number.isInteger(port) || port < 1 || port > 65535) process.exit(2);',
  'if (!/^[A-Za-z0-9._:-]{1,253}$/.test(host)) process.exit(2);',
  'const socket = net.connect(port, host);',
  'process.stdin.pipe(socket);',
  'socket.pipe(process.stdout);',
  "socket.on('close', () => process.exit(0));",
  "socket.on('error', () => process.exit(1));",
  "process.stdin.on('end', () => socket.end());",
].join('\n');
