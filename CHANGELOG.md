# Changelog

## Unreleased

- The settings for programs and paths (`dockerPath`, `dockerComposePath`, `devcontainerCliPath`,
  `serverDownloadUrlTemplate`, `kubectlPath`, `kubeconfigPath`, `kubectlInWSL`,
  `kubectlWSLDistro`) now have scope `application`. With scope `machine`, a container or pod window
  ignored the values from the user settings (for example `podman`) and took them from the settings
  inside the container instead. They, and `shareKiroLogin`, are read from the user settings of this
  machine only; such settings in a `devcontainer.json` are reported in the log and not applied.
- Forwarded ports no longer cut off the end of a response when the client reads more slowly than
  the container sends.
- Error messages and progress notifications no longer turn `[text](link)` in the output of a
  container, a pod, kubectl or the Dev Container CLI into a clickable link.
- The log masks the values of more variables that usually hold secrets (names with `passphrase`,
  `cookie`, `session`, `jwt`, `bearer`, or ending in `key` or `pat`).
- Server installation in the container:
  - With `wget` instead of `curl`, a download that is redirected to anything but `https` fails
    before the archive is used, as with `curl`.
  - A home directory that everyone can write to (such as `HOME=/tmp`) is not used; the private
    folder in the temporary directory is, and the Kiro sign-in is not copied there.
  - The connection token is checked before the server starts.
  - Two connections at once no longer remove each other's setup lock.
  - The Kiro sign-in and the machine settings are written through a new file with an unpredictable
    name, and the settings are private to the user like the rest of the server's folder.
  - The log and error messages show the download address without user name, password and query,
    which can carry the credentials of a private mirror.
- `${release}` is no longer listed as a placeholder of `dev.containers.serverDownloadUrlTemplate`:
  no IDE build provides a value for it, so a template with it always failed. It is now reported as
  an unknown placeholder.
- On Windows, `wsl.exe` is always taken from an absolute system folder, also when `SystemRoot` is
  empty or not an absolute path.

## 0.2.0 (2026-10-27)

- **kubectl in WSL** (Windows): `dev.containers.kubectlInWSL` and `dev.containers.kubectlWSLDistro`
  run kubectl, its credential plugins and kubeconfig inside a WSL distribution, for listing,
  attaching, the connection and port forwarding. The Kubernetes extension's `vs-kubernetes.use-wsl`
  turns it on when the setting is not set. A pod window keeps the WSL distribution it was attached
  with. ([#7](https://github.com/lldeters/DevPod/issues/7))
- A `.cmd` or `.bat` file as `dev.containers.kubectlPath` gets a message that explains why it cannot
  be started, instead of "Install kubectl".
- Verified in Kiro 1.4.26 on Windows: attaching to a pod of a k3s cluster in WSL (Ubuntu 24.04)
  with kubectl in WSL.

## 0.1.0 (2026-10-25)

First public, experimental version.

- Discovery of dev container configurations (`.devcontainer/devcontainer.json`,
  `.devcontainer.json`, `.devcontainer/<name>/devcontainer.json`); **Reopen in Container**,
  **Rebuild Container** (with or without cache), **Reopen Folder Locally**, **Open Container
  Configuration File**, **Show Log** and a status bar menu in container windows.
- Image, Dockerfile and Docker Compose configurations, Features, lifecycle commands and user
  handling through the bundled Dev Container CLI 0.89.0; Docker and Podman.
- A remote authority resolver that installs an IDE server matching the running Kiro build in the
  container and connects to it through a `docker exec` stdio bridge; no port is published on the
  host.
- Extensions and settings from `customizations.vscode` and `customizations.kiro` (including what
  Features contribute); `portsAttributes` / `otherPortsAttributes`; `remoteEnv` for the extension
  host and terminals.
- Port forwarding: `forwardPorts` (also `"service:port"` for Compose) on start, and every port the
  IDE forwards or detects, tunneled to `localhost` only.
- **Attach to Kiro for Kubernetes pods** from the Kubernetes extension's explorer or the command
  palette. Without a writable home directory, the IDE server lives in a private folder
  `devcontainers-kiro-<uid>` in the temporary directory.
- `dev.containers.shareKiroLogin`: asks (by default) whether to copy this machine's Kiro sign-in into
  a container or pod that has none; `always` and `never` decide once.
- Safety: a container or pod window that the extension did not open itself (for example from a
  link) is only resolved after you confirm the folder or pod; paths on network shares are refused;
  the server is downloaded over `https` only; secret values are masked in the log; paths to programs
  and kubeconfig files never come from a workspace. The extension is disabled in untrusted
  workspaces.
- One-time setup of `enable-proposed-api` in `argv.json`, and **Show Diagnostics**, which copies
  the facts needed to analyze a problem (no credentials) to the clipboard.
- Verified in Kiro 1.4.26 on Windows with Docker 29.2.0 (see `docs/TESTING.md`); other hosts and
  configuration styles are covered by automated tests, including real Docker and a kind cluster in
  CI.
