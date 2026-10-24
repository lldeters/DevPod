# Testing

## Automated

| Command                    | Needs               | Covers                                                                                                                    |
| -------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                 | Node                | Unit tests: discovery, JSONC, authority, CLI args/output, server scripts (executed under `sh`), provisioner, bridge relay |
| `npm run test:integration` | Node, git           | The **real** pinned Dev Container CLI with a docker stub: flag existence, `read-configuration`, Git-root workspace path   |
| `npm run test:smoke`       | Node, git, a build  | Loads the **built** `dist/extension.js` with a stand-in `vscode`, runs _Reopen in Container_ with the bundled CLI         |
| `npm run test:e2e`         | Docker, `DCK_E2E=1` | Real container: `up`, lifecycle command, idempotence, server install and reuse, byte-exact bridge                         |

CI runs all of them (`.github/workflows/ci.yml`).

## What is not automated: the Kiro connection

No automated test starts Kiro. Please run this checklist once per Kiro version and report the
results (and the log) in an issue.

### 0. Collect facts

Find Kiro's `product.json` (it sits next to the app resources, in `resources/app/product.json`
of the installation) and share these fields (no secrets are in them):

```sh
# Linux/macOS example - adjust the path to your installation
node -e "const p=require('/path/to/Kiro/resources/app/product.json'); console.log(JSON.stringify({
  commit:p.commit, quality:p.quality, version:p.version, dataFolderName:p.dataFolderName,
  serverApplicationName:p.serverApplicationName, serverDataFolderName:p.serverDataFolderName,
  serverDownloadUrlTemplate:p.serverDownloadUrlTemplate, nameShort:p.nameShort }, null, 2))"
```

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
