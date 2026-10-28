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
   it ourselves) → record the authority as known (`globalState`, `src/remote/knownTargets.ts`) →
   open `vscode-remote://dev-container+<hex>/<that path>`.
2. The IDE calls the resolver with the authority. An authority that is not known (for example from
   a link) is confirmed by the user in a modal dialog that spells out the folder, before anything
   reads it. The resolver then checks the engine, runs `devcontainer up` (idempotent; reuses the
   container, honors a pending rebuild request), then provisions the server.
3. **Provisioning** runs two POSIX `sh` scripts via `docker exec -i -u <remoteUser> … sh -s`
   (script on stdin, so nothing sensitive appears in a process list): platform detection, then
   download/unpack once per commit and start the server on `127.0.0.1:<random port>` with a
   token file (mode 600) and `--server-data-dir` next to it. A running server is reused; it is
   recognized by its PID **and** start time (`/proc/<pid>/stat`), so a PID that another process got
   after a restart is not taken for it. Runs for the same folder are serialized, since two windows
   may connect at once: with `flock` on `setup.flock` where it works on that file system (the kernel
   releases it when a run ends, however it ends; the download, unpacking and the server are started
   without its descriptor, so they cannot keep it), else with a lock directory (`setup.lock`, owner
   recorded, taken over when the owner is gone). The download must be `https` (or `file`), also after redirects: `curl`
   refuses others (`--proto-redir`); with `wget`, its response headers (`-S`) are checked and a
   `Location` that is neither `https://` nor a path fails the download, and a `wget` that shows no
   headers on stderr (Wget2) is refused.
4. **Connection**: each connection spawns `docker exec -i … <container node> -e <bridge> <port>`
   which relays stdio to the server's loopback port. No port is published on the host. The bridge
   exits only once stdout has taken everything, so the end of a stream is not cut off.
5. **Rebuild** persists a request in `globalState`, reloads the window, and the resolver consumes
   it once (`--remove-existing-container`, optionally `--build-no-cache`). A request older than 15
   minutes is dropped, so a failed attempt does not remove the container days later.

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
- **remoteEnv** is returned to the IDE as `extensionHostEnv` of the resolver result, which the IDE
  passes to the remote extension host and to terminals; it applies per connection, so a change
  takes effect on the next reload. The CLI has already substituted `${containerEnv:...}` in the
  merged configuration. Only the names are logged. `userEnvProbe` is not supported yet.
- **Kiro sign-in** (`src/core/server/kiroLogin.ts`, `src/ui/kiroLogin.ts`, setting
  `dev.containers.shareKiroLogin`: `ask` by default, `always` or `never`; scope `application` so a
  workspace cannot change it). The file `~/.aws/sso/cache/kiro-auth-token.json` of this machine is
  read unless the setting is `never` (a missing file is only logged at info level), checked to be a
  small JSON object, and, right after the platform check, offered to the container. With `ask`, a
  first script reports whether the exec user already has a sign-in; only if not, a modal dialog
  naming the container or pod asks, on every connection. The copy is written by a `sh -s` script
  (content on stdin through a quoted here-document, so never in an argument list) to `$HOME` of
  the exec user in the container or pod. The script uses the real `$HOME`, not the fallback folder
  the server may live in, and writes nothing without a writable one; it creates 700/600 files like
  Kiro does, and never replaces a non-empty file. A problem is logged and does not stop the
  connection. The content is never logged, and the error text of this step contains no command
  output.
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
   `kubectl config view --output=jsonpath={.current-context}` (empty, not an error, when there is
   none or no kubeconfig) and stored in the connection; without a current context the attach is
   refused with the likely cause (another kubeconfig, or on Windows another kubectl). Without a
   click (command palette) the pod is chosen step by step (context, namespace, pod): without a
   current context every context is offered (the only one is taken without asking), without any
   context the message says where kubectl looked; if listing namespaces is forbidden the namespace
   is typed instead, and any other failure to list them is reported.
3. **Authority.** `k8s-pod+<hex(json)>` holds context, namespace, pod, container and, if one is
   configured, the kubeconfig path. Every field is validated against Kubernetes naming rules; none
   may start with a dash, and kubectl is always given `--flag=value` forms. The new window is opened
   with `vscode.newWindow({ remoteAuthority })`, without a folder.
4. **Resolving.** An authority that "Attach to Kiro" did not open itself is confirmed first, with
   pod, container, context and kubeconfig spelled out, since the kubeconfig decides which server
   kubectl contacts and can run commands (exec credential plugins); a kubeconfig on a network share
   is refused. A target without a context (only possible from a link) is fixed to the current
   context of its kubeconfig for this connection, or refused when there is none, instead of
   kubectl's fallback to `localhost:8080`. `PodResolver` then asks `kubectl get pod` (with the
   kubeconfig _of the connection_, not of the current settings) and refuses with a clear message
   unless the pod and container are running. It then provisions the server through `kubectl exec ... -- sh -s`, as for containers,
   and returns the connection factory.
5. **Where the server lives.** `$HOME` if it is a writable directory, otherwise the private folder
   `devcontainers-kiro-<uid>` in `$TMPDIR` (or `/tmp`), which is used only if it is a real directory
   the user owns (then set to mode 700): anyone could have created that predictable name first,
   with a server launcher of their own. The detection script and the install script share this
   rule (`CHOOSE_BASE_SCRIPT`). Pods often run as a user without a home directory. A home directory
   that others may write to is used (an `emptyDir` volume is 0777), but the server's own folder in
   it must belong to the user, or the install script stops.

6. **kubectl in WSL** (Windows, `src/core/k8s/launcher.ts`). A `KubectlLauncher` says how kubectl
   is started: directly, or with `wsl.exe` from `%SystemRoot%\System32` as
   `wsl.exe [--distribution D] --cd ~ --exec /bin/sh -c <wrapper> kubectl <windows> <kubectl> <args...>`. `--exec` matters:
   without it wsl.exe hands the command line to the distribution's default shell, which would
   interpret the arguments, and the bridge passes a Node.js script as one. The fixed wrapper reads
   `PATH` and `KUBECONFIG` from `$SHELL -l` with that shell's stdin, stdout and stderr detached (a
   profile can neither print into the protocol nor read from it; markers separate the values from
   any output), expands `~/` in the kubectl path, turns a leading `--kubeconfig=` (a list separated
   by `;`) into `KUBECONFIG` with `~/` expanded and Windows drive paths converted by `wslpath`, and
   `exec`s kubectl. Unless `<windows>` is `-` (`dev.containers.kubectlWSLBrowser: wsl`), it is
   `%SystemRoot%`: the wrapper writes a fixed `xdg-open` shim to `~/.cache/devcontainers-kiro/bin`
   (only when it is missing or differs), puts that folder first in `PATH` and sets `BROWSER` to it.
   The shim hands web addresses to `rundll32.exe url.dll,FileProtocolHandler` after a `cd` into the
   Windows folder (a Windows program started from a Linux directory can fail with "Invalid
   argument"), and anything else to the `xdg-open` of the original `PATH`. Without `rundll32.exe`
   or a writable folder, WSL opens web pages as before. Before that, `kubectlProcess` turns Windows paths into the distribution itself
   (`\\wsl.localhost\<distro>\...`) into Linux paths and refuses ones into another distribution.
   Natively, a list is passed as `KUBECONFIG` too, since `--kubeconfig` takes a single file; every
   file of a list is validated on its own (absolute, no network share). The pod authority records the WSL selection
   like the kubeconfig, so a window keeps it when the settings change; every kubectl call of that
   window (query, provisioning, bridge, tunnels) goes through it.

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
  passed as arguments, never through a shell, network paths (`\\host\share`, `\\?\UNC\...`,
  `//host/...`) are refused because reading one already contacts that host, and an authority the
  extension did not open itself is used only after the user confirms the folder or pod.

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
  single-quoted; the download URL must be `https` or `file`.
- Unknown remote authorities are confirmed before use; network paths and paths with control or
  bidirectional characters (which could add text to the confirmation dialog) are refused.
- The Kiro sign-in is copied only after the user agrees (default) and only into a container
  without one.
- Values of `-e`, `--env`, `--build-arg` and `--remote-env` in logged command lines are masked, and
  so are the values of the CLI's environment variables whose names look like secrets (at least 8
  characters), in every log line, progress message and error message from the CLI.
- Settings that choose a program, a kubeconfig, whether kubectl runs in WSL or whether the Kiro
  sign-in is shared have scope `application` and are read from the user's layer of `inspect()`
  only (`userValue` in `src/ui/settings.ts`), so a workspace cannot set them. A remote window
  takes `machine` settings from the remote side, and the IDE applies scopes only to keys it knows
  (a section written as an object passes), so in a container or pod window a value that comes
  from the remote side is ignored, and this machine's value comes first (the remote side could
  also erase it, with `"dev.containers": null`). The same holds for the Kubernetes extension's
  settings used as a fallback (`kubectl-path`, `kubeconfig`, `use-wsl`); its `kubectl-path` has
  scope `machine`, though, so a pod window in which that extension runs too does not see the local
  value at all. The value an attach saw is kept per authority in this machine's `globalState`
  (`src/remote/podKubectlPaths.ts`) and used when the window sees none; it is never part of the
  authority, which can come from a link. The settings with scope `application`
  in a `devcontainer.json`, and the section written as an object, are reported and not written
  into the container.
- kubectl in WSL runs with `wsl.exe --exec`, never through the distribution's default shell; batch
  files (`.cmd`, `.bat`) are not supported as kubectl, since starting them needs `cmd.exe` and its
  quoting rules.
- The connection token is generated in the container, stored with mode 600 and passed to the
  server as a file, not as an argument.
- `argv.json` is only modified after an explicit modal confirmation.
