# Changelog

## Unreleased

Security and bug fixes from a review:

- **Unknown targets are confirmed.** A container or pod window that this extension did not open
  itself (for example from a link) is resolved only after you confirm the folder or pod in a
  dialog; before, a crafted link could run a folder's `initializeCommand` on this machine or
  kubectl with a foreign kubeconfig. Paths on network shares are refused (WSL's shares are fine).
  Windows that were already open ask once after the update.
- **The Kiro sign-in is copied only after you agree.** `dev.containers.shareKiroLogin` is now
  `"ask"` (default), `"always"` or `"never"`; the former `true` / `false` still mean always / never.
  With `ask` you are asked on every connection while the container or pod has no sign-in.
- Fix: forwarded ports and the connection lost the end of a stream (e.g. an HTTP response with
  `Connection: close`) when the reader was slower than the server.
- Fix: in the fallback folder for a home directory that is not writable, the IDE server kept its
  data below `$HOME`, so extensions and settings did not work there (`--server-data-dir`).
- The fallback folder is now `devcontainers-kiro-<uid>` in `$TMPDIR` or `/tmp`, private to the
  user, instead of `/tmp` itself.
- Fix: after a restart of the container or pod with a kept home directory, a PID taken over by
  another process could make the extension hand out a dead server's port and token for good.
- Fix: two windows connecting at the same time could delete each other's server files.
- `remoteEnv` from `devcontainer.json` is applied (extension host and terminals).
- The server is downloaded over `https` only (or `file://`); `http://` templates are refused.
- Values of `-e`, `--env`, `--build-arg` and `--remote-env` are masked in the log.
- A rebuild request expires after 15 minutes instead of removing the container at some later open.
- `dev.containers.devcontainerCliPath` works with npm's `devcontainer.cmd` on Windows and with a
  `.js` file.
- `~` in kubectl and kubeconfig paths is read as the home directory.
- Development: vitest 4 and esbuild 0.28; CI actions pinned to commits, kind download verified.

## 0.1.0 (unreleased)

First experimental version.

- Discovery of dev container configurations; Reopen in Container, Rebuild (with/without cache),
  Reopen Locally, Open Configuration File, Show Log.
- Container handling through the bundled Dev Container CLI 0.89.0; Docker and Podman.
- Remote authority resolver with an IDE server provisioned in the container and a stdio bridge.
- One-time setup of `enable-proposed-api` in `argv.json`.
- _Show Diagnostics_ command that copies IDE, server and engine facts (no credentials) to the clipboard.
- Verified in Kiro 1.4.26 on Windows with Docker 29.2.0 (see docs/TESTING.md), including
  extensions, settings, port forwarding and the Kiro sign-in in the container window; other hosts
  and configuration styles are covered by automated tests only. Attaching to a pod of Docker
  Desktop's Kubernetes was reported working.
- CLI log output: terminal color codes are removed and each command is logged once.
- Extensions and settings from `customizations.vscode` / `customizations.kiro` (merged
  configuration, so Features are included) are installed and applied in the container;
  `portsAttributes` / `otherPortsAttributes` become `remote.portsAttributes` /
  `remote.otherPortsAttributes`.
- **Attach to Kiro for Kubernetes pods**: pod context menu entry of the Kubernetes extension and a
  palette command; new window attached to a pod container through `kubectl exec`, including port
  forwarding. The IDE server falls back to `/tmp` when the home directory is not writable.
- Port forwarding: `forwardPorts` are forwarded on start and the IDE's own forwards (Ports view,
  automatic detection) are tunneled to localhost; supports `"service:port"` for Compose.
- `dev.containers.shareKiroLogin` (on by default, user settings only): copies this machine's Kiro
  sign-in (`~/.aws/sso/cache/kiro-auth-token.json`) into containers and pods, so Kiro there does not
  ask to sign in again. Never replaces an existing sign-in; turn it off for containers or pods that
  others can access.
- The log starts with the version and build (commit hash); diagnostics contain it too.
- Port forwards requested by the IDE, their failures and the first refused connection per tunnel
  are written to the log.
- Fix: port forwarding failed on every request of the IDE, because the IDE calls `tunnelFactory`
  detached from the resolver and the function used `this`. It is now an arrow function property,
  and the tests call it like the IDE does. This was the cause of the refused sign-in callback.
- Fix: a tunnel the IDE requests without a local port now uses the remote port (as VS Code's own
  tunnels do) instead of a random one. Kiro's sign-in sends the browser to a fixed
  `http://localhost:3128` callback, which was refused before.
