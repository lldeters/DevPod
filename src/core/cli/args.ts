// Copyright 2026 The Dev Containers for Kiro authors
// SPDX-License-Identifier: Apache-2.0

// Argument builders for the Dev Container CLI (@devcontainers/cli). Only flags that exist in the
// pinned CLI version are emitted; test/integration verifies this against the real CLI's --help.

export type CliLogLevel = 'info' | 'debug' | 'trace';

export interface CommonOptions {
  /** Local folder that contains the dev container configuration. */
  workspaceFolder: string;
  /** Explicit devcontainer.json; the CLI's default lookup applies if omitted. */
  configFile?: string | undefined;
  dockerPath?: string | undefined;
  dockerComposePath?: string | undefined;
  logLevel?: CliLogLevel | undefined;
}

export interface DotfilesOptions {
  repository: string;
  installCommand?: string | undefined;
  targetPath?: string | undefined;
}

export interface UpOptions extends CommonOptions {
  removeExistingContainer?: boolean | undefined;
  buildNoCache?: boolean | undefined;
  expectExistingContainer?: boolean | undefined;
  skipPostCreate?: boolean | undefined;
  skipNonBlockingCommands?: boolean | undefined;
  includeConfiguration?: boolean | undefined;
  includeMergedConfiguration?: boolean | undefined;
  remoteEnv?: Readonly<Record<string, string>> | undefined;
  dotfiles?: DotfilesOptions | undefined;
}

export interface ReadConfigurationOptions extends CommonOptions {
  includeMergedConfiguration?: boolean | undefined;
}

function common(options: CommonOptions): string[] {
  const args = ['--workspace-folder', options.workspaceFolder];
  if (options.configFile) {
    args.push('--config', options.configFile);
  }
  if (options.dockerPath) {
    args.push('--docker-path', options.dockerPath);
  }
  if (options.dockerComposePath) {
    args.push('--docker-compose-path', options.dockerComposePath);
  }
  args.push('--log-level', options.logLevel ?? 'info', '--log-format', 'json');
  return args;
}

function flag(name: string, enabled: boolean | undefined): string[] {
  return enabled ? [name] : [];
}

export function upArgs(options: UpOptions): string[] {
  const args = ['up', ...common(options)];
  args.push(
    ...flag('--remove-existing-container', options.removeExistingContainer),
    ...flag('--build-no-cache', options.buildNoCache),
    ...flag('--expect-existing-container', options.expectExistingContainer),
    ...flag('--skip-post-create', options.skipPostCreate),
    ...flag('--skip-non-blocking-commands', options.skipNonBlockingCommands),
    ...flag('--include-configuration', options.includeConfiguration),
    ...flag('--include-merged-configuration', options.includeMergedConfiguration),
  );
  for (const [name, value] of Object.entries(options.remoteEnv ?? {})) {
    args.push('--remote-env', `${name}=${value}`);
  }
  if (options.dotfiles) {
    args.push('--dotfiles-repository', options.dotfiles.repository);
    if (options.dotfiles.installCommand) {
      args.push('--dotfiles-install-command', options.dotfiles.installCommand);
    }
    if (options.dotfiles.targetPath) {
      args.push('--dotfiles-target-path', options.dotfiles.targetPath);
    }
  }
  return args;
}

export function readConfigurationArgs(options: ReadConfigurationOptions): string[] {
  return [
    'read-configuration',
    ...common(options),
    ...flag('--include-merged-configuration', options.includeMergedConfiguration),
  ];
}
