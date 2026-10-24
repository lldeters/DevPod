# Architecture

## Layers

```
src/core/     Pure TypeScript. No `vscode` import (enforced by ESLint). Fully unit-testable.
  config/       devcontainer.json discovery (spec locations), JSONC parsing
  cli/          argument builders, output parsing and runner for the Dev Container CLI
  engine/       docker/podman helpers (`exec` argument builder, availability check)
  server/       IDE server provisioning: product info, URL template, platform detection,
                install/start script, provisioner, stdio bridge script
  authority.ts  encode/decode of the `dev-container+<hex>` remote authority
  argv.ts       edit argv.json (enable-proposed-api) while preserving comments
src/remote/   Editor integration for the connection (uses `vscode`)
  resolver.ts   RemoteAuthorityResolver: up → provision server → connection factory
  bridge.ts     ManagedMessagePassing over `docker exec -i … node -e <bridge>`
  product.ts    reads the IDE's product.json via `env.appRoot`
  proposed.d.ts local declarations for the `resolvers` proposed API
src/ui/       Commands, status bar item, reopen prompt, setup of argv.json, logging, settings
```

## Connection flow

1. **Reopen in Container**: discover configs → ask the user if several →
   `devcontainer read-configuration` to learn the workspace folder _inside_ the container (the CLI
   mounts the Git root, so for a sub folder this is `/workspaces/<repo>/<sub>`; we do not compute
   it ourselves) → open `vscode-remote://dev-container+<hex>/<that path>`.
2. The IDE calls the resolver with the authority. The resolver checks the engine, runs
   `devcontainer up` (idempotent; reuses the container, honors a pending rebuild request), then
   provisions the server.
3. **Provisioning** runs two POSIX `sh` scripts via `docker exec -i -u <remoteUser> … sh -s`
   (script on stdin, so nothing sensitive appears in a process list): platform detection, then
   download/unpack once per commit and start the server on `127.0.0.1:<random port>` with a
   token file (mode 600). A running server is reused.
4. **Connection**: each connection spawns `docker exec -i … <container node> -e <bridge> <port>`
   which relays stdio to the server's loopback port. No port is published on the host.
5. **Rebuild** persists a request in `globalState`, reloads the window, and the resolver consumes
   it once (`--remove-existing-container`, optionally `--build-no-cache`).

## Decisions

- **The Dev Container CLI is the engine.** Merge logic, Features, Compose, lifecycle ordering and
  user handling are not reimplemented. It is pinned and shipped inside the VSIX, or replaced via
  `dev.containers.devcontainerCliPath`. Inside the IDE's Node it is launched with
  `ELECTRON_RUN_AS_NODE=1`.
- **Container identity** comes from the CLI's own labels (`devcontainer.local_folder`,
  `devcontainer.config_file`), so containers started from a terminal with the CLI are reused.
- **Authorities are untrusted input** (they can come from links): decoded strictly, paths are only
  passed as arguments, never through a shell.

## Assumptions and how they held up

The design rested on five assumptions about Kiro that could only be checked in Kiro. They were
checked on **2026-10-24 with Kiro 1.4.26 (VS Code base 1.131.0), Windows x64, Docker 29.2.0**:

1. **Proposed API.** Kiro honors `enable-proposed-api` in `argv.json`, and the `resolvers` API
   has the shape declared in `src/remote/proposed.d.ts` (written against VS Code 1.103).
   Confirmed: `remoteSupport.enabled` was `true` and a remote window opened.
2. **Server metadata.** Kiro's `product.json` provides `commit`, `version`, `quality`,
   `serverApplicationName` (`kiro-server`), `serverDataFolderName` (`.kiro-server`) **and** a
   `serverDownloadUrlTemplate`
   (`https://prod.download.desktop.kiro.dev/releases/remotes/${commit}/kiro-reh-${os}-${arch}.tar.gz`),
   so no user setting is needed. Confirmed.
3. **Server launcher.** `--start-server --host --port --accept-server-license-terms
--connection-token-file` are accepted and the server prints `… listening on <port>`.
   Confirmed (log: `IDE server listening on 127.0.0.1:42689`).
4. **Archive layout.** One top-level folder (`--strip-components=1`) with
   `bin/<serverApplicationName>`. Confirmed.
5. **Agent extensions.** Kiro's built-in agent works in the remote extension host. Confirmed by the
   tester (agent session in the container window).

Still unverified in Kiro: macOS/Linux hosts, Podman, Compose/Dockerfile configurations and
which `node` the bridge uses (the server's bundled one if present, else the container's).

## Security notes

- The extension declares `untrustedWorkspaces: { supported: false }`.
- Values interpolated into generated shell scripts are validated against a strict pattern and
  single-quoted; the download URL must be `http(s)` or `file`.
- The connection token is generated in the container, stored with mode 600 and passed to the
  server as a file, not as an argument.
- `argv.json` is only modified after an explicit modal confirmation.
