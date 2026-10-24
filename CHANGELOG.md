# Changelog

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
- The log starts with the version and build (commit hash); diagnostics contain it too.
- Port forwards requested by the IDE, their failures and the first refused connection per tunnel
  are written to the log.
- Fix: port forwarding failed on every request of the IDE, because the IDE calls `tunnelFactory`
  detached from the resolver and the function used `this`. It is now an arrow function property,
  and the tests call it like the IDE does. This was the cause of the refused sign-in callback.
- Fix: a tunnel the IDE requests without a local port now uses the remote port (as VS Code's own
  tunnels do) instead of a random one. Kiro's sign-in sends the browser to a fixed
  `http://localhost:3128` callback, which was refused before.
