// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

import { DevContainerError } from '../errors';
import { isValidExtensionId } from '../extensionId';
import { urlForLog } from './template';

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

/**
 * POSIX sh that sets `BASE` to the folder below which the server lives: the user's `$HOME` if it is
 * a writable directory, else `devcontainers-kiro-<uid>` in `$TMPDIR` (or `/tmp`). The fallback is
 * private to the user and refused (BASE stays empty) unless it is a real directory the user owns,
 * because anyone could have created that predictable name first. The platform check and the
 * install script both use it, so they agree on the folder. (A home directory that others may write
 * to, such as an emptyDir volume, is used; the install script checks the server's own folder in it.)
 */
export const CHOOSE_BASE_SCRIPT = `
BASE="\${HOME:-}"
if [ -z "$BASE" ] || [ ! -d "$BASE" ] || [ ! -w "$BASE" ]; then
  case "\${TMPDIR:-}" in /*) BASE="$TMPDIR" ;; *) BASE=/tmp ;; esac
  USER_ID="$(id -u 2>/dev/null || true)"
  BASE="\${BASE%/}/devcontainers-kiro-$USER_ID"
  mkdir -p "$BASE" 2>/dev/null || true
  if [ -z "$USER_ID" ] || [ -L "$BASE" ] || [ ! -d "$BASE" ] \\
     || [ "$(stat -c %u "$BASE" 2>/dev/null || true)" != "$USER_ID" ] \\
     || ! chmod 700 "$BASE" 2>/dev/null; then
    BASE=""
  fi
fi
`;

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
 *
 * Runs for the same folder are serialized with flock where it works, and with a lock directory that
 * older versions of this extension use too, since two windows may connect at the same time. A
 * running server is recognized by its PID and its start time, so a PID that was handed to another
 * process after a restart is not mistaken for the server.
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
TMP_DIR=""
LOCK_DIR=""
OWNER=""
PROBE=""
cleanup() {
  if [ -n "$TMP_DIR" ]; then rm -rf "$TMP_DIR"; fi
  if [ -n "$PROBE" ]; then rm -f "$PROBE"; fi
  # Only a lock this run still holds: one that was taken over meanwhile belongs to another run.
  if [ -n "$LOCK_DIR" ] && [ "$(cat "$LOCK_DIR/owner" 2>/dev/null || true)" = "$OWNER" ]; then
    rm -rf "$LOCK_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
fail() { echo "error==$1"; echo "${INSTALL_MARKER}: end"; exit 1; }
# Start time of a process (field 22 of /proc/<pid>/stat), empty if unknown. The command name in
# field 2 may contain spaces and parentheses, so the fields are counted after its last ")".
proc_start() { sed -n 's/^.*) \\([^ ]* \\)\\{19\\}\\([0-9][0-9]*\\).*$/\\2/p' "/proc/$1/stat" 2>/dev/null || true; }
# Whether process $1 runs and, if its start time $2 is known, is still the same process.
is_running() {
  [ -n "\${1:-}" ] || return 1
  if [ -n "\${2:-}" ]; then [ "$(proc_start "$1")" = "$2" ]; else kill -0 "$1" 2>/dev/null; fi
}

DATA_FOLDER=${shQuote(params.dataFolderName)}
COMMIT=${shQuote(params.commit)}
APP_NAME=${shQuote(params.applicationName)}
DOWNLOAD_URL=${shQuote(params.downloadUrl)}
DOWNLOAD_LABEL=${shQuote(urlForLog(params.downloadUrl))}
${CHOOSE_BASE_SCRIPT}
[ -n "$BASE" ] || fail "no usable folder for the server: the home directory is not writable, and the fallback in the temporary directory is not a private folder of this user"
ROOT="$BASE/$DATA_FOLDER"
SERVER_DIR="$ROOT/bin/$COMMIT"
LOG_FILE="$ROOT/server-$COMMIT.log"
PID_FILE="$ROOT/server-$COMMIT.pid"
START_FILE="$ROOT/server-$COMMIT.started"
TOKEN_FILE="$ROOT/server-$COMMIT.token"
PORT_FILE="$ROOT/server-$COMMIT.port"

mkdir -p "$ROOT/bin" || fail "cannot create $ROOT"
# Where others may write to the home directory (an emptyDir volume is 0777), someone else could
# have created this folder first, with a server of their own: it must belong to this user.
ROOT_UID="$(stat -L -c %u "$ROOT" 2>/dev/null || true)"
USER_UID="$(id -u 2>/dev/null || true)"
if [ -n "$ROOT_UID" ] && [ -n "$USER_UID" ] && [ "$ROOT_UID" != "$USER_UID" ]; then
  fail "$ROOT belongs to another user (uid $ROOT_UID); remove it or use another home directory"
fi

# One run at a time per folder: two windows may connect at once. Runs wait for each other with
# flock where it works on this file system, which is tried on a file of this run first: the kernel
# releases its lock when a run ends, however it ends. (BusyBox's flock has no -w, hence the loop
# with -n; touch first, because dash exits when exec cannot open a file.) Descriptor 9 holds the
# lock until the script exits; programs that may outlive a killed run are started without it.
USE_FLOCK=""
if command -v flock >/dev/null 2>&1 && PROBE="$(mktemp "$ROOT/flock.XXXXXX" 2>/dev/null)"; then
  exec 8>> "$PROBE"
  if flock -n 8 2>/dev/null; then USE_FLOCK=1; fi
  exec 8>&-
  rm -f "$PROBE"
fi
PROBE=""
WAITED=0
if [ -n "$USE_FLOCK" ]; then
  touch "$ROOT/setup.flock" 2>/dev/null || fail "cannot create $ROOT/setup.flock"
  exec 9>> "$ROOT/setup.flock"
  until flock -n 9 2>/dev/null; do
    [ "$WAITED" -lt 600 ] || fail "another setup of the server is still running ($ROOT/setup.flock)"
    WAITED=$((WAITED + 1))
    sleep 1
  done
fi
# Every run also takes the lock directory, which is all that runs without flock know, and older
# versions of this extension in windows that were not reloaded. Its owner is recorded so that a
# lock left behind by a killed run can be taken over; it is written right after the lock is
# created, so a lock without one for a whole minute was left by a run killed in between, not by a
# slow one. (Two runs that find the same stale lock can both go on; runs that hold flock never
# get here at the same time.)
OWNER="$$ $(proc_start $$)"
UNOWNED=0
until mkdir "$ROOT/setup.lock" 2>/dev/null; do
  HOLDER="$(cat "$ROOT/setup.lock/owner" 2>/dev/null || true)"
  if [ -n "$HOLDER" ]; then UNOWNED=0; else UNOWNED=$((UNOWNED + 1)); fi
  # shellcheck disable=SC2086 # the owner file holds "<pid> <start time>"
  if { [ -n "$HOLDER" ] && ! is_running $HOLDER; } || [ "$UNOWNED" -ge 60 ]; then
    rm -rf "$ROOT/setup.lock"
    continue
  fi
  [ "$WAITED" -lt 600 ] || fail "another setup of the server is still running ($ROOT/setup.lock)"
  WAITED=$((WAITED + 1))
  sleep 1
done
LOCK_DIR="$ROOT/setup.lock"
echo "$OWNER" > "$LOCK_DIR/owner"

if [ ! -f "$SERVER_DIR/.installed" ]; then
  TMP_DIR="$(mktemp -d "$ROOT/tmp.XXXXXX")" || fail "mktemp failed"
  ARCHIVE="$TMP_DIR/server.tar.gz"
  if command -v curl >/dev/null 2>&1; then
    # The archive becomes code in the container: https only (or a local file), also after redirects.
    # 9>&-: a download left running by a killed run must not keep the setup lock.
    curl -fsSL --proto '=https,file' --proto-redir '=https' --retry 3 --connect-timeout 20 \\
      -o "$ARCHIVE" "$DOWNLOAD_URL" 9>&- || fail "download failed: $DOWNLOAD_LABEL"
  elif command -v wget >/dev/null 2>&1; then
    # wget cannot be told to stay on https after a redirect, so the response headers are kept and
    # a redirect to anything but an https address or a path on the same server fails the download
    # before the archive is used. (BusyBox reads any other form as an http:// address.) A wget
    # that does not show the headers on stderr (Wget2) cannot be checked, so it is refused.
    wget -S -O "$ARCHIVE" "$DOWNLOAD_URL" 2> "$TMP_DIR/wget.log" > /dev/null 9>&- \\
      || fail "download failed: $DOWNLOAD_LABEL"
    [ -n "$(sed -n '/^ *HTTP\\//p' "$TMP_DIR/wget.log")" ] \\
      || fail "this wget does not show where it was redirected; install curl in the container"
    sed -n 's/^ *[Ll][Oo][Cc][Aa][Tt][Ii][Oo][Nn]: *//p' "$TMP_DIR/wget.log" | tr -d '\\r' > "$TMP_DIR/redirects"
    while IFS= read -r LOCATION; do
      case "$LOCATION" in
        [Hh][Tt][Tt][Pp][Ss]://* | /*) ;;
        *) fail "the download was redirected to an address that is not https" ;;
      esac
    done < "$TMP_DIR/redirects"
  else
    fail "neither curl nor wget is installed in the container"
  fi
  command -v tar >/dev/null 2>&1 || fail "tar is not installed in the container"
  mkdir -p "$TMP_DIR/extract"
  tar -xzf "$ARCHIVE" -C "$TMP_DIR/extract" --strip-components=${strip} 9>&- || fail "extraction failed"
  rm -rf "$SERVER_DIR"
  mv "$TMP_DIR/extract" "$SERVER_DIR" || fail "could not move the server into place"
  touch "$SERVER_DIR/.installed"
fi

[ -x "$SERVER_DIR/bin/$APP_NAME" ] || fail "server launcher bin/$APP_NAME not found or not executable"

if [ -f "$PORT_FILE" ] && [ -f "$TOKEN_FILE" ] \\
   && is_running "$(cat "$PID_FILE" 2>/dev/null || true)" "$(cat "$START_FILE" 2>/dev/null || true)"; then
  PORT="$(cat "$PORT_FILE")"
else
  rm -f "$PID_FILE" "$START_FILE" "$PORT_FILE" "$TOKEN_FILE" "$LOG_FILE"
  TOKEN="$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \\n')"
  # A failure inside the pipeline does not stop the script (set -e only sees tr).
  [ "\${#TOKEN}" -eq 48 ] || fail "could not create a connection token from /dev/urandom"
  printf '%s' "$TOKEN" > "$TOKEN_FILE"
  if command -v setsid >/dev/null 2>&1; then LAUNCH="setsid nohup"; else LAUNCH="nohup"; fi
  # --server-data-dir keeps the server's data (extensions, settings, state) next to it, which
  # matters when it lives in the fallback folder rather than in $HOME.
  $LAUNCH "$SERVER_DIR/bin/$APP_NAME" ${serverArgs} --server-data-dir "$ROOT" \\
    --connection-token-file "$TOKEN_FILE" > "$LOG_FILE" 2>&1 < /dev/null 9>&- &
  SERVER_PID=$!
  echo "$SERVER_PID" > "$PID_FILE"
  proc_start "$SERVER_PID" > "$START_FILE"
  PORT=""
  TRIES=0
  while [ "$TRIES" -lt 60 ]; do
    PORT="$(sed -n 's/.*listening on \\([0-9][0-9]*\\).*/\\1/p' "$LOG_FILE" 2>/dev/null | head -n 1)"
    [ -n "$PORT" ] && break
    kill -0 "$SERVER_PID" 2>/dev/null \\
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
  // Input is passed on only once connected. When a host has several addresses (localhost: ::1 and
  // 127.0.0.1) and the first attempt fails, Node starts over on the next one and forgets an end()
  // given meanwhile, so the end of the input would never reach the service.
  "socket.on('connect', () => process.stdin.pipe(socket));",
  'socket.pipe(process.stdout);',
  // Exit only once stdout has taken everything: exiting right away drops what is still buffered,
  // which cuts off the end of a response when a slow reader is attached.
  "socket.on('close', () => process.stdout.write('', () => process.exit(0)));",
  "socket.on('error', () => process.exit(1));",
  "process.stdin.on('end', () => socket.end());",
].join('\n');
