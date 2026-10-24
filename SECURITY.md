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
  arguments to the Dev Container CLI, never through a shell.
- The extension edits the IDE's `argv.json` (to enable a proposed API) only after an explicit
  confirmation.
