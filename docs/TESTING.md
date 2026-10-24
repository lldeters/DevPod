# Testing

## Automated

| Command                    | Needs                                                 | Covers                                                                                                                     |
| -------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                 | Node                                                  | Unit tests: discovery, JSONC, authority, CLI args/output, server scripts (executed under `sh`), provisioner, bridge relay  |
| `npm run test:integration` | Node, git                                             | The **real** pinned Dev Container CLI with a docker stub: flag existence, `read-configuration`, Git-root workspace path    |
| `npm run test:smoke`       | Node, git, a build                                    | Loads the **built** `dist/extension.js` with a stand-in `vscode`, runs _Reopen in Container_ with the bundled CLI          |
| `npm run test:e2e:k8s`     | kubectl, a throw-away cluster (kind), `DCK_E2E_K8S=1` | Real pod: attach picker queries, readiness checks, server install through `kubectl exec`, reuse, port relay out of the pod |
| `npm run test:e2e`         | Docker, `DCK_E2E=1`                                   | Real container: `up`, lifecycle command, idempotence, server install and reuse, byte-exact bridge                          |

CI runs all of them (`.github/workflows/ci.yml`).

## What is not automated: the Kiro connection

No automated test starts Kiro. Please run this checklist once per Kiro version and report the
results (and the log) in an issue.

### 0. Collect facts

Run **Kiro Dev Containers: Show Diagnostics (copy to clipboard)** and paste the result into your
report. It contains the IDE facts that decide whether a matching server can be installed
(`commit`, `version`, `serverApplicationName`, `serverDataFolderName`, `serverDownloadUrlTemplate`,
`updateUrl`, ...), whether remote support is active, and the versions of the container engine and
the Dev Container CLI. Credential-like keys are never copied and your home directory is shortened
to `~`. The command works even while remote support is still disabled.

### 1. Install and enable

- [ ] Install the VSIX. Run **Kiro Dev Containers: Enable Remote Support**, confirm, quit and
      restart Kiro completely.
- [ ] Output channel _Kiro Dev Containers_ shows no "Remote support is not enabled" warning.

### 2. Open a project

Use any project with `.devcontainer/devcontainer.json`, e.g. an `image` based one.

- [ ] **Reopen in Container** shows progress and the window reconnects.
- [ ] The explorer shows the project at the expected path inside the container.
- [ ] The integrated terminal runs inside the container as the remote user.
- [ ] Extensions can be installed into the container; language features work.
- [ ] A Kiro agent session (specs/steering/hooks) works in the container window.

### 3. Lifecycle

- [ ] **Rebuild Container** and **Rebuild Container Without Cache** recreate the container.
- [ ] **Reopen Folder Locally** returns to the local window.
- [ ] Reloading the window reconnects without recreating the container.
- [ ] `postCreateCommand` runs once; `postStartCommand` on each start.

### 4. Variants

- [ ] A Dockerfile based configuration; a Docker Compose based configuration.
- [ ] A folder that is a sub folder of a Git repository.
- [ ] Two configurations in `.devcontainer/<name>/` (picker appears).
- [ ] Podman (`dev.containers.dockerPath` = `podman`).

### 5. Failure messages

- [ ] Docker stopped: clear message.
- [ ] Missing `serverDownloadUrlTemplate`: message tells what to set.
- [ ] Wrong template (404): message contains the URL.

### 6. Extensions, settings and ports

Use `docs/ANLEITUNG-KIRO-TEST.md`, step 10, which has a ready-made project.

- [ ] Extensions from `customizations.vscode.extensions` appear installed in the container window.
- [ ] `customizations.vscode.settings` are active (Settings, _Remote_ tab, or the status bar).
- [ ] A port from `forwardPorts` is listed in the Ports view and reachable on `localhost`.
- [ ] A server started later in the container terminal is detected and forwarded automatically.
- [ ] `portsAttributes` labels show in the Ports view.
- [ ] Signing in to Kiro in the container window works (`docs/ANLEITUNG-KIRO-TEST.md`, step 10e).

### 7. Kubernetes pods

Use `docs/ANLEITUNG-KIRO-TEST.md`, step 11, which has a ready-made pod.

- [ ] A pod's context menu in the Kubernetes explorer has **Attach to Kiro**.
- [ ] The palette command **Attach to Running Kubernetes Container...** works without it.
- [ ] A new window opens, attached to the pod; the status bar says _Pod: <name>_.
- [ ] The terminal runs in the pod; **File > Open Folder** lists the pod's files.
- [ ] Installing an extension works; a port opened in the pod is forwarded to `localhost`.
- [ ] A pod without a writable home directory still works (server in `/tmp`).
- [ ] A pod that is not running, or a missing `kubectl`, gives a clear message.

## Verified results

| Date       | Kiro (VS Code base) | Host                       | Engine         | Result                                                                                                                                                                                                                                                                                       |
| ---------- | ------------------- | -------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-10-24 | 1.4.26 (1.131.0)    | Windows x64, Docker 29.2.0 | Docker Desktop | Image-based config: reopen, terminal, files, extension install, agent session, rebuild, reopen locally, reconnect to the running container. Server URL came from Kiro's `product.json`.                                                                                                      |
| 2026-10-24 | 1.4.26 (1.131.0)    | Windows x64, Docker 29.2.0 | Docker Desktop | Build 689f2ce, `docs/ANLEITUNG-KIRO-TEST.md` step 10c all items: extensions and settings from `customizations.vscode`, `forwardPorts`, automatic port detection, `portsAttributes`; Kiro sign-in in the container window (callback on port 3128). Kubernetes pods (step 11): not yet tested. |
