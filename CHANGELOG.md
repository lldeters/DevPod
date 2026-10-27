# Changelog

## Unreleased

- The settings for programs and paths (`dockerPath`, `dockerComposePath`, `devcontainerCliPath`,
  `serverDownloadUrlTemplate`, `kubectlPath`, `kubeconfigPath`, `kubectlInWSL`,
  `kubectlWSLDistro`, `kubectlWSLBrowser`) now have scope `application`. With scope `machine`, a container or pod window
  ignored the values from the user settings (for example `podman`) and took them from the settings
  inside the container instead. They, and `shareKiroLogin`, are read from the user settings of this
  machine only; such settings in a `devcontainer.json` are reported in the log and not applied.
- Forwarded ports no longer cut off the end of a response when the client reads more slowly than
  the container sends.

## 0.2.3 (2026-10-28)

- **Sign-ins of kubectl in WSL open in the Windows browser**: web pages that credential plugins
  (`kubectl oidc-login`, `kubelogin`) open go to the Windows default browser, with the certificates
  and sign-ins of Windows, instead of a browser inside WSL. The new setting
  `dev.containers.kubectlWSLBrowser` (`windows` by default, or `wsl`) chooses. A custom `xdg-open`
  in the distribution no longer gets in the way.
- The log of every attach says where sign-in pages open.
- The setup in the README mentions that the extension offers **Enable Remote Support** by itself.

## 0.2.2 (2026-10-28)

- **Several kubeconfig files**: `dev.containers.kubeconfigPath` (and the Kubernetes extension's
  `vs-kubernetes.kubeconfig`) may list several files like `KUBECONFIG` (`;` on Windows and for
  kubectl in WSL, `:` elsewhere). They used to be passed as one `--kubeconfig`, which takes a single
  file, so kubectl found no context at all. Each file of a list is checked on its own.
- **kubectl in WSL** reads kubeconfig paths into its own distribution given as Windows paths
  (`\\wsl.localhost\<distro>\...` or `//wsl.localhost/<distro>/...`, also `wsl$`) as the Linux
  paths they are; a path into another distribution is refused with a message.

## 0.2.1 (2026-10-28)

- Attaching to a pod no longer fails with "current-context is not set" when the kubeconfig has no
  current context: the command palette offers the contexts (and takes the only one without
  asking). When kubectl finds no kubeconfig at all, the message says where it looked and, in WSL,
  names the usual causes (kubeconfig on Windows, `KUBECONFIG` only in `~/.bashrc`, a distribution
  that runs as root). _Attach to Kiro_ in the Kubernetes explorer explains when kubectl has no
  current context, and a window target without a context uses the current one, fixed for the
  connection, instead of kubectl's fallback to `localhost:8080`.
- WSL's own errors get a clear message: a distribution that does not exist names
  `dev.containers.kubectlWSLDistro` and `wsl.exe --list --verbose`; a missing default distribution
  says how to install one; other WSL failures (for example virtualization turned off) show WSL's
  first line and error code. WSL messages are read in UTF-8 (`WSL_UTF8=1`).
- Error messages name the kubectl command that failed (such as `get pods`) and leave out kubectl's
  internal log lines, so a missing credential plugin (such as `kubelogin`) is named. A failure to list namespaces is only answered with the namespace question
  when listing is forbidden; other errors are reported.
- The log names the kubectl, kubeconfig and WSL setting of every attach.

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
