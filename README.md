# Dev Containers for Kiro (Community)

Open-source [dev container](https://containers.dev) support for the [Kiro](https://kiro.dev) IDE:
reopen a folder inside a container, with the IDE server, terminal, extensions and language
tooling running in it.

> **Status: experimental (0.1.0), first real-world test passed.**
> Verified in Kiro 1.4.26 (VS Code 1.131) on Windows with Docker 29.2.0: _Reopen in Container_,
> terminal and file editing in the container, installing extensions, a Kiro agent session,
> _Rebuild Container_, _Reopen Folder Locally_ and reconnecting to a running container.
> **Not yet verified in Kiro:** attaching to Kubernetes pods (covered by automated tests,
> including a real kind cluster in CI), macOS and Linux hosts, Podman, Docker Compose and Dockerfile based
> configurations, sub folders of Git repositories and several configurations in one folder (these
> are covered by automated tests only). See [docs/TESTING.md](docs/TESTING.md).

This is an independent community project. It is **not affiliated with Microsoft or Amazon**, and
it is a clean-room implementation: it contains no code from Microsoft's proprietary "Dev
Containers" extension. It builds on the public specification and the open-source
[Dev Container CLI](https://github.com/devcontainers/cli). See [NOTICE](NOTICE).

## Features (0.1.0)

- Detects dev container configurations (`.devcontainer/devcontainer.json`, `.devcontainer.json`,
  `.devcontainer/<name>/devcontainer.json`) and lets you pick one.
- **Reopen in Container**, **Rebuild Container**, **Rebuild Container Without Cache**,
  **Reopen Folder Locally**, **Open Container Configuration File**, **Show Log**.
- Image, Dockerfile and Docker Compose based configurations, Features, lifecycle commands and
  user handling come from the bundled Dev Container CLI, so they follow the specification.
- **Extensions and settings** from `customizations.vscode` and `customizations.kiro` (the latter
  overrides the former) are installed and applied in the container, including what Features
  contribute. `portsAttributes` and `otherPortsAttributes` are applied as `remote.portsAttributes`
  and `remote.otherPortsAttributes`.
- **Port forwarding:** `forwardPorts` (numbers, or `"service:port"` for Compose) are forwarded on
  start, and ports the IDE detects or you forward in the Ports view are tunneled to `localhost`.
  Tunnels listen on the loopback interface only.
- **Attach to Kiro for Kubernetes pods:** right-click a pod in the Kubernetes extension's explorer
  and choose **Attach to Kiro**, or run **Attach to Running Kubernetes Container...** from the
  command palette (it works without the Kubernetes extension, too). A new window opens whose files,
  terminal, extensions and ports live in a container of that pod. See
  [Kubernetes pods](#kubernetes-pods).
- Docker and Podman.
- No telemetry.

Planned: Templates and "Add Dev Container Configuration Files", Attach to Running Container,
Clone Repository in Container Volume, credential forwarding, remote Docker hosts and more. See
[docs/PLAN.md](docs/PLAN.md).

## Requirements

- Kiro (a VS Code 1.103 based build) on Linux, macOS or Windows.
- Docker or Podman, running, usable without `sudo`.
- Linux containers on x64 or arm64, with `curl` or `wget`, and `tar`.

## Setup

1. Install the `.vsix` (Extensions view → `...` → _Install from VSIX_).
2. Run **Kiro Dev Containers: Enable Remote Support (proposed API)**. This adds this extension's
   ID to `enable-proposed-api` in the IDE's `argv.json` after you confirm. Quit and restart the
   IDE completely.
3. Run **Kiro Dev Containers: Show Diagnostics** if something does not work; it copies the facts
   needed to analyze the problem (no credentials) to the clipboard.
4. If the IDE does not declare where its server can be downloaded, set
   `dev.containers.serverDownloadUrlTemplate` (see below). The extension tells you when this is
   needed.

### The IDE server

A remote window needs an IDE server inside the container that matches your IDE build exactly.
This extension reads the build information (`commit`, `quality`, `version`,
`serverApplicationName`, `serverDataFolderName`) from the IDE's `product.json` and downloads the
server from `serverDownloadUrlTemplate` of `product.json`, or from the setting of the same name.
Supported placeholders: `${commit}`, `${quality}`, `${version}`, `${os}` (`linux` or `alpine`),
`${arch}` (`x64`, `arm64`, `armhf`). Unknown placeholders are rejected.

## Usage

Open a folder that has a dev container configuration and run **Kiro Dev Containers: Reopen in
Container** (or accept the prompt). In a container window, the status bar entry _Dev Container_
opens a menu to rebuild, reopen locally, open the configuration or show the log.

## Settings

| Setting                                    | Default  | Purpose                                                                   |
| ------------------------------------------ | -------- | ------------------------------------------------------------------------- |
| `dev.containers.dockerPath`                | `docker` | Container engine CLI (`docker` or `podman`).                              |
| `dev.containers.dockerComposePath`         | empty    | Compose CLI; empty lets the Dev Container CLI choose.                     |
| `dev.containers.devcontainerCliPath`       | empty    | Use your own `devcontainer` instead of the bundled one                    |
| `dev.containers.logLevel`                  | `info`   | `info`, `debug` or `trace`.                                               |
| `dev.containers.promptToReopen`            | `true`   | Offer to reopen folders that have a configuration.                        |
| `dev.containers.serverDownloadUrlTemplate` | empty    | Where to download the IDE server (see above).                             |
| `dev.containers.kubectlPath`               | empty    | `kubectl` for pods; else the Kubernetes extension's, else `PATH`.         |
| `dev.containers.kubeconfigPath`            | empty    | kubeconfig for pods; else the Kubernetes extension's, else kubectl's own. |

## Kubernetes pods

**Attach to Kiro** opens a window in a container of a running pod, like _Attach Visual Studio Code_
in the original extension.

- In the Kubernetes extension's **Clusters** view, right-click a pod and choose **Attach to Kiro**.
  The pods shown there belong to the current kubectl context; that context is stored in the new
  window, so switching contexts later does not redirect it.
- Without the Kubernetes extension, run **Kiro Dev Containers: Attach to Running Kubernetes
  Container...** and pick context, namespace and pod.
- A pod with several containers asks which one to use (the pod's default container first).
- Use **File > Open Folder** in the new window to open a folder of the pod.

What the pod needs: a running container with `sh`, `curl` or `wget`, and `tar`, on Linux x64 or
arm64. The IDE server is installed in the user's home directory, or in `/tmp` if that is not
writable. It is not part of the pod's image, so it is installed again after the pod is recreated.
Images without a shell (for example distroless images) cannot be used. `kubectl` must be installed
and able to reach the cluster; the path and kubeconfig of the Kubernetes extension are honored, or
set `dev.containers.kubectlPath` / `dev.containers.kubeconfigPath`.

A pod has no `devcontainer.json`, so nothing is built or configured: extensions and settings from a
dev container configuration do not apply to pods. Port forwarding works as for containers.

## Known issue: signing in to Kiro inside a container

A new container has an empty home directory, so Kiro asks for a sign-in again. A sign-in through
Google or GitHub receives the browser's answer on a local port **inside the container** (for
example `http://localhost:12345/oauth/callback`), which therefore has to be forwarded to your
machine. If the browser shows _Connection refused_, open the Ports view, check that the port from
the browser's address bar is listed (or forward it with _Forward a Port_) and reload the tab. See
`docs/ANLEITUNG-KIRO-TEST.md`, step 10e. This is under investigation; the cause is not yet
confirmed.

## Security

A dev container runs build steps and lifecycle scripts from the workspace. The extension is
disabled in untrusted workspaces. See [SECURITY.md](SECURITY.md).

## Development

```sh
npm ci
npm run typecheck && npm run lint && npm test && npm run test:integration
npm run build                 # bundles to dist/extension.js
npm run test:smoke            # loads the built bundle and runs the main flow
npx vsce package              # builds the .vsix
DCK_E2E=1 npm run test:e2e    # needs a running Docker daemon
```

Architecture and decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Contributions are
welcome: [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE). Third-party notices: [NOTICE](NOTICE),
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
