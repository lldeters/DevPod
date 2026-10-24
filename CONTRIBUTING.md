# Contributing

Thanks for helping. This project is licensed under the Apache License 2.0; by contributing you
agree that your contribution is licensed under the same terms.

## Ground rules

- **Clean room.** Do not copy, translate or decompile code from Microsoft's proprietary "Dev
  Containers" extension (or any other closed-source extension), and do not paste its strings or
  assets. Work from the public specification (<https://containers.dev>), the open-source Dev
  Container CLI and observable behavior described in public documentation. MIT/Apache-licensed
  code may be reused with attribution in `NOTICE`; AGPL/GPL code may not.
- Keep `src/core` free of `vscode` imports (ESLint enforces it) and cover new logic with tests.
- No telemetry.
- Every source file starts with the Apache-2.0 SPDX header used in `src/`.

## Workflow

```sh
npm ci
npm run format && npm run lint && npm run typecheck && npm test && npm run test:integration
```

Commit messages: short imperative subject, explanation of _why_ in the body if not obvious.

## Reporting results from Kiro

The Kiro connection can only be verified in Kiro. Follow [docs/TESTING.md](docs/TESTING.md) and
attach the _Kiro Dev Containers_ output (set `dev.containers.logLevel` to `debug`). Remove paths
or hostnames you do not want to share.
