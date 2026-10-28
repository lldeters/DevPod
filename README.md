# Dev Containers for Kiro (Community)

Open-source [dev container](https://containers.dev) support for the [Kiro](https://kiro.dev) IDE:
reopen a folder inside a container, with the IDE server, terminal, extensions and language
tooling running in it.

> **Status: experimental (0.2.3), real-world tested.**
> Verified in Kiro 1.4.26 (VS Code 1.131) on Windows with Docker Desktop (Docker 29.2.0):
> _Reopen in Container_, terminal and file editing in the container, installing extensions, a Kiro
> agent session, _Rebuild Container_, _Reopen Folder Locally_, reconnecting to a running container,
> extensions and settings from `customizations.vscode`, port forwarding (configured and
> automatically detected), the Kiro sign-in inside the container, copying the sign-in after the
> question, attaching to a pod of Docker Desktop's Kubernetes, attaching with kubectl in WSL (a
> k3s cluster in Ubuntu 24.04), and the confirmation of windows the extension did not open itself.
> **Not yet verified in Kiro:** macOS and Linux hosts, Podman, Docker Compose and Dockerfile based
> configurations, sub folders of Git repositories, several configurations in one folder, and other
> clusters than Docker Desktop's (these are covered by automated tests only, including a real kind
> cluster for pods in CI). See [docs/TESTING.md](docs/TESTING.md).

This is an independent community project. It is **not affiliated with Microsoft or Amazon**, and
it is a clean-room implementation: it contains no code from Microsoft's proprietary "Dev
Containers" extension. It builds on the public specification and the open-source
[Dev Container CLI](https://github.com/devcontainers/cli). See [NOTICE](NOTICE).

## Features (0.2.3)

- Detects dev container configurations (`.devcontainer/devcontainer.json`, `.devcontainer.json`,
  `.devcontainer/<name>/devcontainer.json`) and lets you pick one.
- **Reopen in Container**, **Rebuild Container**, **Rebuild Container Without Cache**,
  **Reopen Folder Locally**, **Open Container Configuration File**, **Show Log**.
- Image, Dockerfile and Docker Compose based configurations, Features, lifecycle commands and
  user handling come from the bundled Dev Container CLI, so they follow the specification.
- **Extensions and settings** from `customizations.vscode` and `customizations.kiro` (the latter
  overrides the former) are installed and applied in the container, including what Features
  contribute. `portsAttributes` and `otherPortsAttributes` are applied as `remote.portsAttributes`
  and `remote.otherPortsAttributes`. `remoteEnv` applies to the extension host and to terminals
  (`userEnvProbe` is not supported yet).
- **Port forwarding:** `forwardPorts` (numbers, or `"service:port"` for Compose) are forwarded on
  start, and ports the IDE detects or you forward in the Ports view are tunneled to `localhost`.
  Tunnels listen on the loopback interface only.
- **Attach to Kiro for Kubernetes pods:** right-click a pod in the Kubernetes extension's explorer
  and choose **Attach to Kiro**, or run **Attach to Running Kubernetes Container...** from the
  command palette (it works without the Kubernetes extension, too). A new window opens whose files,
  terminal, extensions and ports live in a container of that pod. On Windows, kubectl can run
  inside WSL, with sign-ins in the Windows browser. See [Kubernetes pods](#kubernetes-pods).
- Docker and Podman.
- No telemetry.

Planned: Templates and "Add Dev Container Configuration Files", Attach to Running Container,
Clone Repository in Container Volume, credential forwarding, remote Docker hosts and more. Ideas and
bug reports are welcome in the [issue tracker](https://github.com/lldeters/DevPod/issues).

## Requirements

- Kiro (a VS Code 1.103 based build) on Linux, macOS or Windows.
- Docker or Podman, running, usable without `sudo`.
- Linux containers on x64 or arm64, with `curl` or `wget`, and `tar`.

## Setup

1. Install **Dev Containers for Kiro (Community)** (`lldeters.devcontainers-kiro`) from the
   Extensions view, which searches [Open VSX](https://open-vsx.org). A `.vsix` from the
   [releases](https://github.com/lldeters/DevPod/releases) works too (Extensions view → `...` →
   _Install from VSIX_).
2. Run **Kiro Dev Containers: Enable Remote Support (proposed API)**, or click **Enable Remote
   Support** when the extension offers it the first time you open a container or attach to a pod.
   This adds this extension's ID to `enable-proposed-api` in the IDE's `argv.json` after you
   confirm. Quit and restart the IDE completely.
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
`${arch}` (`x64`, `arm64`, `armhf`). Unknown placeholders are rejected. The URL must use `https://`
(or `file://` for an archive inside the container), and redirects must stay on `https`. With `wget`
instead of `curl`, the redirects are checked in its output; a `wget` that does not show them (such
as Wget2) is refused, so install `curl` there.

## Usage

Open a folder that has a dev container configuration and run **Kiro Dev Containers: Reopen in
Container** (or accept the prompt). In a container window, the status bar entry _Dev Container_
opens a menu to rebuild, reopen locally, open the configuration or show the log.

## Settings

| Setting                                    | Default   | Purpose                                                                   |
| ------------------------------------------ | --------- | ------------------------------------------------------------------------- |
| `dev.containers.dockerPath`                | `docker`  | Container engine CLI (`docker` or `podman`).                              |
| `dev.containers.dockerComposePath`         | empty     | Compose CLI; empty lets the Dev Container CLI choose.                     |
| `dev.containers.devcontainerCliPath`       | empty     | Your own `devcontainer` (executable, `.js`, or npm's `devcontainer.cmd`). |
| `dev.containers.logLevel`                  | `info`    | `info`, `debug` or `trace`.                                               |
| `dev.containers.promptToReopen`            | `true`    | Offer to reopen folders that have a configuration.                        |
| `dev.containers.serverDownloadUrlTemplate` | empty     | Where to download the IDE server (see above).                             |
| `dev.containers.kubectlPath`               | empty     | `kubectl` for pods; else the Kubernetes extension's, else `PATH`.         |
| `dev.containers.kubeconfigPath`            | empty     | kubeconfig(s) for pods; else the Kubernetes extension's, else kubectl's.  |
| `dev.containers.kubectlInWSL`              | `false`   | Windows: run kubectl inside WSL (see [kubectl in WSL](#kubectl-in-wsl)).  |
| `dev.containers.kubectlWSLDistro`          | empty     | The WSL distribution for that; empty means the default one.               |
| `dev.containers.kubectlWSLBrowser`         | `windows` | Where sign-in pages of kubectl in WSL open: `windows` or `wsl`.           |
| `dev.containers.shareKiroLogin`            | `ask`     | Copy this machine's Kiro sign-in into containers and pods (see below).    |

Except for `logLevel` and `promptToReopen`, these settings can only be set in the user settings.
They apply to this machine, also in container and pod windows, and are never taken from a
workspace, from a `devcontainer.json` or from the settings inside a container.

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
arm64. The IDE server is installed in the user's home directory, or, if that is not writable, in
the private folder `devcontainers-kiro-<uid>` of `$TMPDIR` (or `/tmp`); that folder is refused unless
it is a directory the user owns, and the server's own folder in the home directory must belong to
the user too. It is not part of the pod's image, so it is installed again after
the pod is recreated.
Images without a shell (for example distroless images) cannot be used. `kubectl` must be installed
and able to reach the cluster; the path and kubeconfig set for the Kubernetes extension in your user
settings are honored (workspace values are not), or set `dev.containers.kubectlPath` /
`dev.containers.kubeconfigPath`.

A pod has no `devcontainer.json`, so nothing is built or configured: extensions and settings from a
dev container configuration do not apply to pods. Port forwarding works as for containers.

### kubectl in WSL

On Windows, kubectl, credential plugins (for example `kubectl oidc-login`) and kubeconfigs are
often set up only inside WSL. With `dev.containers.kubectlInWSL` (and optionally
`dev.containers.kubectlWSLDistro`), the extension runs kubectl in that distribution for listing,
attaching, the connection and port forwarding. If you leave the setting unset, the Kubernetes
extension's `vs-kubernetes.use-wsl` decides, so _Attach to Kiro_ uses the same kubectl as its
explorer. That extension always uses the **default** distribution: leave
`dev.containers.kubectlWSLDistro` empty, or set it to the default one, so both use the same
distribution. (It also does not read the login profile, so a `KUBECONFIG` set there is seen only
by this extension.)

- `kubectl` is found through the `PATH` of your login shell, which is read from the login profile
  (`~/.profile`, `~/.bash_profile` or `~/.zprofile`), **not** from `~/.bashrc`. The same goes for
  `KUBECONFIG`. Put the lines that add kubectl or krew (`~/.krew/bin`) to `PATH` there, or set
  `dev.containers.kubectlPath` to the Linux path of kubectl. A Windows path is refused in this mode.
- kubectl reads the kubeconfig **inside the distribution**, as its default user: `~/.kube/config`,
  or the file `KUBECONFIG` names in the login profile. If your kubeconfig is on Windows, set
  `dev.containers.kubeconfigPath` to it. A distribution created with `wsl --import` runs as `root`
  unless it has a default user.
- `dev.containers.kubeconfigPath` may be a Linux path, `~/...` (the Linux home directory), a
  Windows path such as `C:\Users\me\.kube\config` (converted with `wslpath`), or a Windows path
  into the distribution itself, such as `\\wsl.localhost\Ubuntu-24.04\home\me\.kube\config`.
  Several files are separated by `;`, as in `KUBECONFIG` on Windows.
- `dev.containers.kubectlWSLDistro` must be a name that `wsl.exe --list --verbose` shows (case does
  not matter, dots and dashes do), for example `Ubuntu-24.04` or `Ubuntu`.
- A window that was attached this way keeps running kubectl in that distribution, even if the
  settings change later.
- Sign-in pages that credential plugins open (OIDC, for example `kubectl oidc-login` or
  `kubelogin`) open in the **Windows default browser**, with the certificates and sign-ins of
  Windows. For this, kubectl finds a small `xdg-open` first (also set as `BROWSER`), which the
  extension writes to `~/.cache/devcontainers-kiro/bin` in the distribution and which hands web
  addresses to Windows (`rundll32.exe url.dll,FileProtocolHandler`, started from the Windows
  folder). The plugin's redirect back to `http://localhost:<port>` reaches WSL through its
  localhost forwarding, which is on by default. Set `dev.containers.kubectlWSLBrowser` to `wsl` to
  let WSL open them instead. kubectl's output is not shown while it waits for the sign-in.
- The Kubernetes extension's own kubectl does not get this. Credential plugins usually cache the
  token in the distribution, so after a sign-in through _Attach to Kiro_ its explorer uses it too.
  If the explorer itself has to sign in and opens a browser in WSL, sign in through _Attach to
  Kiro_ once, or make web addresses in the distribution open in Windows, for example with this
  `/usr/local/bin/xdg-open` (`sudo chmod +x` it):

  ```sh
  #!/bin/sh
  case "${1-}" in
    http://*|https://*) cd /mnt/c/Windows && exec ./System32/rundll32.exe url.dll,FileProtocolHandler "$1" ;;
  esac
  exec /usr/bin/xdg-open "$@"
  ```

Without this setting, `dev.containers.kubectlPath` must be a program Windows can start directly,
such as `kubectl.exe`: a `.cmd` or `.bat` wrapper cannot be used, because kubectl is started
without a shell.

## Signing in to Kiro inside a container

A new container has an empty home directory, so Kiro asks for a sign-in again. A sign-in through
Google or GitHub sends the browser to `http://localhost:3128`, where a service **inside the
container** waits for the answer. The extension forwards that port to the same port number on your
machine, so it must be free there. If the sign-in fails, the log (_Kiro Dev Containers_) shows
whether the port was requested (_The IDE asked to forward ..._) and on which local port it was
forwarded (_Forwarding ... to localhost:..._).

### Skipping the sign-in: `dev.containers.shareKiroLogin`

Kiro keeps its sign-in in `~/.aws/sso/cache/kiro-auth-token.json`. The extension can copy that
file from your machine into the home directory of the container user, or of the pod's container
user, when you connect. Kiro there then does not ask to sign in.
`dev.containers.shareKiroLogin` (user settings only) decides when:

- `ask` (default): when you connect to a container or pod that has no sign-in yet, a dialog names
  it and asks whether to copy the sign-in. You are asked again on every connection until the
  container has a sign-in.
- `always`: copy without asking. `never`: never copy. (`true` and `false` from version 0.1.0 still
  mean `always` and `never`.)

Be aware of what a copy means:

- The copy is a credential **inside the container or pod**. Everyone who can run commands there can
  read it, the same as after a sign-in made in the container.
- An existing sign-in in the container is never replaced, and nothing is copied back.
- The copy shares one session with this machine. If Kiro rotates the refresh token when it renews
  the sign-in (not confirmed), a renewal on one side can sign out the other.
- Do not copy it into containers or pods that other people can access.
- To remove a copy, run `rm ~/.aws/sso/cache/kiro-auth-token.json` in the container, or sign out in
  Kiro there.

Verified in Kiro 1.4.26 on Windows: the question, and Kiro in a container or pod accepting the
copied sign-in (see [docs/TESTING.md](docs/TESTING.md)). Whether a renewal on one side signs out the
other is not known yet.

## Security

A dev container runs build steps and lifecycle scripts from the workspace. The extension is
disabled in untrusted workspaces. A container or pod window that this extension did not open
itself (for example one opened through a link) is only resolved after you confirm the folder or
pod in a dialog. See [SECURITY.md](SECURITY.md).

## Development

```sh
npm ci
npm run typecheck && npm run lint && npm test && npm run test:integration
npm run build                 # bundles to dist/extension.js
npm run test:smoke            # loads the built bundle and runs the main flow
npx vsce package              # builds the .vsix
DCK_E2E=1 npm run test:e2e    # needs a running Docker daemon
```

Architecture and decisions: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Releasing:
[docs/RELEASING.md](docs/RELEASING.md). Contributions are welcome:
[CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache License 2.0](LICENSE). Third-party notices: [NOTICE](NOTICE),
[THIRD_PARTY_LICENSES.md](THIRD_PARTY_LICENSES.md).
