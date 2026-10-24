# Architecture

## Layers

```
src/core/     Pure TypeScript. No `vscode` import (enforced by ESLint). Fully unit-testable.
  config/       devcontainer.json discovery (spec locations), JSONC parsing
  cli/          argument builders, output parsing and runner for the Dev Container CLI
  engine/       docker/podman helpers (`exec` argument builder, availability check)
  server/       IDE server provisioning: product info, URL template, platform detection,
                install/start script, provisioner, stdio bridge script
  exec/         ExecTarget: where a command runs (Docker container, pod container)
  k8s/          pod references and `k8s-pod+<hex>` authorities, kubectl arguments, pod parsing
  tunnel.ts     loopback port forwarding through bridge processes
  authority.ts  encode/decode of the `dev-container+<hex>` remote authority
  argv.ts       edit argv.json (enable-proposed-api) while preserving comments
src/remote/   Editor integration for the connection (uses `vscode`)
  resolver.ts   RemoteAuthorityResolver for dev containers: up → provision server → connection
  podResolver.ts RemoteAuthorityResolver for pods: check pod → provision server → connection
  tunnelHub.ts  port forwarding for one window, shared by both resolvers
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

## Extensions, settings and ports

`devcontainer up` is asked for `--include-merged-configuration`, so the result includes what
Features contribute. From it the resolver reads:

- **Extensions and settings** (`src/core/config/customizations.ts`). `customizations.<tool>` is an
  object in `devcontainer.json` but an array with one entry per source (config, each Feature) in the
  merged configuration; both shapes are handled. `vscode` is read first and `kiro` last, so Kiro
  specific entries win. Only plain `publisher.name` ids are accepted (no versions, no URLs), which
  makes them safe as command-line arguments. Extensions are passed to the server as
  `--install-extension <id>` **when it starts**; a server that is already running is reused as is,
  so a changed extension list takes effect after _Rebuild Container_.
- **Settings** are merged into `~/<serverDataFolderName>/data/Machine/settings.json` in the
  container before the server starts (`src/core/server/machineSettings.ts`). Comments and other keys
  are kept, a key from the configuration replaces the same key, and an unchanged file is not
  rewritten. The text is written through a quoted here-document with a random delimiter. A problem
  here is logged and does not stop the connection. `portsAttributes` and `otherPortsAttributes` use
  the same shape as `remote.portsAttributes` / `remote.otherPortsAttributes` and travel the same way.
- **Ports.** `resolver.tunnelFactory` is called by the IDE for every forward. It is an arrow
  function property: the IDE stores the function and calls it detached from the resolver
  (`this._forwardPortProvider(...)` in `extHostTunnelService.ts`), so a prototype method would find
  no `this`. The tests call it the same way (`test/helpers/ide.ts`). It opens a local TCP
  server on `127.0.0.1` (the requested local port if free) and relays each connection through its
  own `docker exec -i … node -e <bridge> <port> [host]` (`src/core/tunnel.ts`). The optional host
  lets `"db:5432"` reach another container of a Compose project. `forwardPorts` entries are opened
  during resolution and returned as `environmentTunnels`, so the Ports view shows them as already
  forwarded. They are replaced on every resolution and closed when the resolver is disposed.
  When the IDE names no local port, the remote port is used, as the IDE's own tunnels do
  (`suggestedLocalPort ?? tunnelRemotePort`). This is required for sign-in flows: for a link that
  carries `http://localhost:<port>` in its query string (`redirect_uri=http://localhost:3128`) the
  workbench opens a tunnel without a local port and leaves the link unchanged
  (`window.ts`, `resolveExternalUri`), so the browser reaches the service only on that very port.
  Every request of the IDE and its outcome is logged at info level, a local port that could not be
  used at warn level; the first refused connection per tunnel is logged too. The resolver brings its own factory on purpose: in VS Code 1.131.0 the IDE enables
  the full Ports features, including automatic detection of new listening ports, only when the
  resolver provides a `tunnelFactory` (`mainThreadTunnelService.ts`, `$setTunnelProvider`;
  `remoteExplorer.ts`, `startCandidateListener`). The built-in factory for managed authorities does
  not switch them on. Programs that must be reached from a local browser, such as the OAuth callback
  of a sign-in, depend on this automatic detection, which scans every two seconds or slower.

## Kubernetes pods

"Attach to Kiro" reuses everything that does not depend on _what_ is attached to. Server
provisioning, the connection bridge and port tunnels only need an `ExecTarget` (`src/core/exec`),
which turns "run this command there" into a process: `docker exec -i` for a container, `kubectl
exec -i --container=... pod -- ...` for a pod.

1. **Menu entry.** `package.json` contributes `devcontainersKiro.attachToPod` ("Attach to Kiro") to
   `view/item/context` of the Kubernetes extension's view `extension.vsKubernetesExplorer` for items
   whose context value matches `vsKubernetes\.resource\.pod`, the same expression that extension
   uses for its own pod commands. The entry only appears if that extension is installed.
2. **Which pod.** VS Code passes the clicked tree node to the command. It is resolved through the
   Kubernetes extension's public API (`vscode-kubernetes-tools-api`, MIT, bundled) to namespace and
   pod name. The explorer shows pods of the _current_ context, so that context is read with
   `kubectl config current-context` and stored in the connection. Without a click (command palette)
   the pod is chosen step by step (context, namespace, pod); if listing namespaces is forbidden the
   namespace is typed instead.
3. **Authority.** `k8s-pod+<hex(json)>` holds context, namespace, pod, container and, if one is
   configured, the kubeconfig path. Every field is validated against Kubernetes naming rules; none
   may start with a dash, and kubectl is always given `--flag=value` forms. The new window is opened
   with `vscode.newWindow({ remoteAuthority })`, without a folder.
4. **Resolving.** `PodResolver` asks `kubectl get pod` (with the kubeconfig _of the connection_, not
   of the current settings) and refuses with a clear message unless the pod and container are
   running. It then provisions the server through `kubectl exec ... -- sh -s`, as for containers,
   and returns the connection factory.
5. **Where the server lives.** `$HOME` if it is a writable directory, otherwise `/tmp`; the
   detection script and the install script apply the same rule. Pods often run as a user without a
   home directory.

Limits: the pod needs `sh`, `curl` or `wget` and `tar`; `kubectl exec` streams can be cut by proxies
or API server timeouts on long idle periods (the window then reconnects); the server and what it
installed disappear with the pod.

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
