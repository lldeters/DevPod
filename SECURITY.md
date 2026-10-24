# Security

## Reporting a vulnerability

Please report suspected vulnerabilities privately through GitHub's _Report a vulnerability_
(Security → Advisories) on this repository rather than in a public issue. Include the version,
steps to reproduce and the impact you see.

## Trust model

- A dev container executes content from the workspace: image builds, Features, lifecycle commands
  and extensions. **Only open folders you trust.** The extension is therefore disabled in
  untrusted workspaces.
- The IDE server inside the container is reachable only through a `docker exec` stdio bridge to
  `127.0.0.1` of the container; no host port is published by this extension.
- The server connection token is created in the container, stored with owner-only permissions,
  and handed to the server as a file.
- Remote authorities can originate from links. They are strictly validated and only used as
  arguments to the Dev Container CLI or kubectl, never through a shell. Folder, configuration and
  kubeconfig paths on network shares are refused. An authority that the extension did not open
  itself ("Reopen in Container", "Attach to Kiro") is only used after the user confirms the folder
  or pod in a modal dialog: resolving it runs the folder's configuration, including
  `initializeCommand` on this machine, or kubectl with the kubeconfig it names.
- This machine's Kiro sign-in is copied into a container or pod only after the user agrees in a
  dialog (default, `dev.containers.shareKiroLogin: "ask"`), and only if the container has none.
- The IDE server is downloaded over `https` only (or from a file inside the container). In the
  fallback folder used when the home directory is not writable, the server is installed only if
  that folder belongs to the user.
- Values of environment and build arguments are masked in logged command lines, so a log can be
  shared.
- The extension edits the IDE's `argv.json` (to enable a proposed API) only after an explicit
  confirmation.
