// Smoke test for the BUILT extension (dist/extension.js), as opposed to the TypeScript sources the
// unit tests cover. It catches bundling mistakes (unresolvable requires, a CLI that is not found
// next to the bundle) that only show up when the real file is loaded.
//
// It loads the bundle with a stand-in for the `vscode` module, runs "Reopen in Container" against
// a throwaway Git repository using the bundled Dev Container CLI and a docker stub, and checks
// that the IDE would be asked to open the folder at the path the CLI computed.
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const work = mkdtempSync(path.join(tmpdir(), 'dck-smoke-'));
const require = createRequire(import.meta.url);

function fail(message) {
  console.error(`smoke test FAILED: ${message}`);
  rmSync(work, { recursive: true, force: true });
  process.exit(1);
}

try {
  const mockFile = path.join(work, 'vscode-mock.cjs');
  await esbuild.build({
    entryPoints: [path.join(projectRoot, 'test/helpers/vscodeMock.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: mockFile,
    logLevel: 'error',
  });
  const mock = require(mockFile);

  const originalLoad = Module._load;
  Module._load = function (request, ...rest) {
    return request === 'vscode' ? mock : originalLoad.call(this, request, ...rest);
  };

  const repo = path.join(work, 'repo');
  const folder = path.join(repo, 'sub');
  mkdirSync(path.join(folder, '.devcontainer'), { recursive: true });
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(
    path.join(folder, '.devcontainer', 'devcontainer.json'),
    '// comment\n{ "image": "ubuntu:24.04", }\n',
  );
  const dockerStub = path.join(work, 'docker-stub');
  writeFileSync(dockerStub, '#!/bin/sh\nexit 0\n');
  chmodSync(dockerStub, 0o755);

  mock.state.settings['dev.containers.dockerPath'] = dockerStub;
  mock.state.workspaceFolders = [{ uri: mock.Uri.file(folder), name: 'sub', index: 0 }];

  const extension = require(path.join(projectRoot, 'dist/extension.js'));
  extension.activate({
    subscriptions: [],
    globalState: new mock.MockMemento(),
    workspaceState: new mock.MockMemento(),
    extension: { id: 'lldeters.devcontainers-kiro' },
  });

  if (!mock.state.resolvers.has('dev-container')) fail('resolver was not registered');
  if (mock.state.registeredCommands.size < 13) fail('commands were not registered');

  await mock.commands.executeCommand('devcontainersKiro.reopenInContainer');
  if (mock.state.errorMessages.length > 0) fail(mock.state.errorMessages.join('; '));
  const open = mock.state.executed.find((entry) => entry.command === 'vscode.openFolder');
  if (!open) fail('vscode.openFolder was not called');
  const uri = open.args[0];
  if (uri.scheme !== 'vscode-remote' || uri.path !== '/workspaces/repo/sub') {
    fail(`unexpected folder: ${uri.scheme}://…${uri.path}`);
  }
  // The Kubernetes explorer's API is imported lazily; make sure the bundle can reach it. With no
  // Kubernetes extension in the stand-in, the command falls back to its own pod picker, which needs
  // kubectl: a missing kubectl must produce the helpful message, not a module error.
  mock.state.errorMessages.length = 0;
  mock.state.settings['dev.containers.kubectlPath'] = path.join(work, 'no-such-kubectl');
  await mock.commands.executeCommand('devcontainersKiro.attachToPod', { fake: 'tree node' });
  const attachError = mock.state.errorMessages.join('; ');
  if (!attachError.includes('dev.containers.kubectlPath')) {
    fail(`attach to pod did not reach kubectl: ${attachError || 'no message'}`);
  }
  if (!mock.state.resolvers.has('k8s-pod')) fail('pod resolver was not registered');

  console.log(
    `smoke test passed: ${mock.state.registeredCommands.size} commands, opens ${uri.path}`,
  );
} catch (error) {
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error));
} finally {
  rmSync(work, { recursive: true, force: true });
}
