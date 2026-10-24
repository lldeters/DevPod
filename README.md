# Dev Containers for Kiro (Community)

Open-source [dev container](https://containers.dev) support for the [Kiro](https://kiro.dev) IDE:
reopen a folder inside a container, with the IDE server, terminal, extensions and language
tooling running in it.

> **Status: experimental (0.1.0).**
> The configuration and container handling is covered by automated tests, including the real
> Dev Container CLI. **Connecting Kiro to a container has not yet been verified inside Kiro.**
> It depends on a proposed API and on a Kiro server build that matches your IDE; see
> [docs/TESTING.md](docs/TESTING.md) for what to check and how to report results.

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
- Docker and Podman.
- No telemetry.

Planned: Templates and "Add Dev Container Configuration Files", Attach to Running Container,
Clone Repository in Container Volume, credential forwarding, port-forwarding UI, remote Docker
hosts and more. See [docs/PLAN.md](docs/PLAN.md).

## Requirements

- Kiro (a VS Code 1.103 based build) on Linux, macOS or Windows.
- Docker or Podman, running, usable without `sudo`.
- Linux containers on x64 or arm64, with `curl` or `wget`, and `tar`.

## Setup

1. Install the `.vsix` (Extensions view → `...` → _Install from VSIX_).
2. Run **Kiro Dev Containers: Enable Remote Support (proposed API)**. This adds this extension's
   ID to `enable-proposed-api` in the IDE's `argv.json` after you confirm. Quit and restart the
   IDE completely.
3. If the IDE does not declare where its server can be downloaded, set
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

| Setting                                    | Default  | Purpose                                                |
| ------------------------------------------ | -------- | ------------------------------------------------------ |
| `dev.containers.dockerPath`                | `docker` | Container engine CLI (`docker` or `podman`).           |
| `dev.containers.dockerComposePath`         | empty    | Compose CLI; empty lets the Dev Container CLI choose.  |
| `dev.containers.devcontainerCliPath`       | empty    | Use your own `devcontainer` instead of the bundled one |
| `dev.containers.logLevel`                  | `info`   | `info`, `debug` or `trace`.                            |
| `dev.containers.promptToReopen`            | `true`   | Offer to reopen folders that have a configuration.     |
| `dev.containers.serverDownloadUrlTemplate` | empty    | Where to download the IDE server (see above).          |

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
