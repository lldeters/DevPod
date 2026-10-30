import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../src/core/logger';
import {
  buildServerEntry,
  mergeMcpSettings,
  provisionMcpGitlab,
  serverEnv,
} from '../../src/core/mcp/gitlab';
import type { McpGitlabSetup } from '../../src/core/mcp/gitlab';
import { runProcess } from '../../src/core/process';
import type { ServerExecutor } from '../../src/core/server/provisioner';

const config = { apiUrl: 'https://gitlab.example/api/v4', readOnly: true };
const bundlePath = '/home/u/.kiro-server/mcp/mcp-gitlab.mjs';

describe('serverEnv', () => {
  it('refers to the token instead of containing it', () => {
    expect(serverEnv(config)).toEqual({
      GITLAB_API_URL: 'https://gitlab.example/api/v4',
      GITLAB_READ_ONLY_MODE: 'true',
      GITLAB_PERSONAL_ACCESS_TOKEN: '${GITLAB_PERSONAL_ACCESS_TOKEN}',
    });
  });

  it('adds toolsets and further variables, but never lets them set the token', () => {
    expect(
      serverEnv({ readOnly: false, toolsets: 'issues,mrs', env: { HTTPS_PROXY: 'http://p:3128' } }),
    ).toEqual({
      HTTPS_PROXY: 'http://p:3128',
      GITLAB_READ_ONLY_MODE: 'false',
      GITLAB_TOOLSETS: 'issues,mrs',
      GITLAB_PERSONAL_ACCESS_TOKEN: '${GITLAB_PERSONAL_ACCESS_TOKEN}',
    });
    expect(() =>
      serverEnv({ readOnly: true, env: { GITLAB_PERSONAL_ACCESS_TOKEN: 'glpat-secret' } }),
    ).toThrow(/cannot be set/);
    expect(() => serverEnv({ readOnly: true, env: { 'A B': 'x' } })).toThrow(/not a valid/);
  });
});

describe('mergeMcpSettings', () => {
  const entry = buildServerEntry('/srv/node', bundlePath, config);

  it('creates the file and the entry', () => {
    const { text, outcome } = mergeMcpSettings('', bundlePath, entry);
    expect(outcome).toBe('updated');
    expect(JSON.parse(text)).toEqual({ mcpServers: { gitlab: entry } });
  });

  it('keeps other servers, other keys and comments, and is unchanged the second time', () => {
    const existing =
      '{\n  // mine\n  "mcpServers": {\n    "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] }\n  },\n  "x": 1\n}\n';
    const first = mergeMcpSettings(existing, bundlePath, entry);
    expect(first.text).toContain('// mine');
    expect(first.text).toContain('"mcp-server-fetch"');
    expect(first.text).toContain('"x": 1');
    expect(mergeMcpSettings(first.text, bundlePath, entry)).toEqual({
      text: first.text,
      outcome: 'unchanged',
    });
  });

  it('updates its own entry and keeps what the user added to it', () => {
    const own = JSON.stringify({
      mcpServers: {
        gitlab: { command: '/old/node', args: [bundlePath], env: {}, disabled: true },
      },
    });
    const { text, outcome } = mergeMcpSettings(own, bundlePath, entry);
    expect(outcome).toBe('updated');
    expect(JSON.parse(text)).toEqual({ mcpServers: { gitlab: { ...entry, disabled: true } } });
  });

  it("leaves a gitlab entry of the user's own alone", () => {
    const foreign = JSON.stringify({
      mcpServers: { gitlab: { command: 'node', args: ['/opt/mcp-gitlab/dist/index.js'] } },
    });
    expect(mergeMcpSettings(foreign, bundlePath, entry)).toEqual({
      text: foreign,
      outcome: 'foreign',
    });
  });

  it('refuses a file that is not a JSON object', () => {
    expect(() => mergeMcpSettings('{ "mcpServers": ', bundlePath, entry)).toThrow(/left unchanged/);
    expect(() => mergeMcpSettings('[]', bundlePath, entry)).toThrow(/left unchanged/);
    expect(() => mergeMcpSettings('{"mcpServers": 3}', bundlePath, entry)).toThrow(
      /left unchanged/,
    );
  });
});

describe.skipIf(process.platform === 'win32')('provisionMcpGitlab (scripts run by Node)', () => {
  const token = 'glpat-do-not-write-me';
  let home: string;
  let env: NodeJS.ProcessEnv;
  let calls: string[][];
  const executor: ServerExecutor = {
    exec: (options) => {
      calls.push([...options.command]);
      const [command, ...args] = options.command;
      return runProcess(command ?? '', args, {
        env,
        ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      });
    },
  };
  const target = () => ({
    containerId: 'pod',
    node: process.execPath,
    dataFolderName: '.kiro-server',
  });
  const setup = (extra: Partial<McpGitlabSetup> = {}): McpGitlabSetup => ({
    bundle: 'console.log("mcp-gitlab");\n',
    config,
    ...extra,
  });
  const settingsFile = () => path.join(home, '.kiro', 'settings', 'mcp.json');
  const bundleFile = () => path.join(home, '.kiro-server', 'mcp', 'mcp-gitlab.mjs');

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'dck-mcp-'));
    env = { PATH: process.env.PATH, HOME: home, GITLAB_PERSONAL_ACCESS_TOKEN: token };
    calls = [];
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('copies the bundle and registers it with the Node that runs it, privately', async () => {
    const outcome = await provisionMcpGitlab(executor, target(), setup(), new MemoryLogger());
    expect(outcome).toBe('updated');
    expect(await readFile(bundleFile(), 'utf8')).toBe('console.log("mcp-gitlab");\n');
    expect((await stat(bundleFile())).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(bundleFile()))).mode & 0o777).toBe(0o700);
    const settings = JSON.parse(await readFile(settingsFile(), 'utf8')) as unknown;
    expect(settings).toEqual({
      mcpServers: { gitlab: buildServerEntry(process.execPath, bundleFile(), config) },
    });
    expect(calls.every((call) => call[0] === process.execPath && call[1] === '-e')).toBe(true);
  });

  it('changes nothing on the second connection', async () => {
    await provisionMcpGitlab(executor, target(), setup(), new MemoryLogger());
    const before = await stat(settingsFile());
    calls = [];
    const outcome = await provisionMcpGitlab(executor, target(), setup(), new MemoryLogger());
    expect(outcome).toBe('unchanged');
    expect(calls).toHaveLength(1); // only the status script
    expect((await stat(settingsFile())).mtimeMs).toBe(before.mtimeMs);
    expect((await readdir(path.dirname(settingsFile()))).sort()).toEqual(['mcp.json']);
  });

  it('copies a changed bundle again', async () => {
    await provisionMcpGitlab(executor, target(), setup(), new MemoryLogger());
    const outcome = await provisionMcpGitlab(
      executor,
      target(),
      setup({ bundle: 'console.log(2);\n' }),
      new MemoryLogger(),
    );
    expect(outcome).toBe('updated');
    expect(await readFile(bundleFile(), 'utf8')).toBe('console.log(2);\n');
  });

  it('keeps other entries and the mode of an existing mcp.json', async () => {
    await mkdir(path.dirname(settingsFile()), { recursive: true });
    await writeFile(settingsFile(), '{ "mcpServers": { "other": { "command": "x" } } }\n');
    await chmod(settingsFile(), 0o644);
    await provisionMcpGitlab(executor, target(), setup(), new MemoryLogger());
    const settings = JSON.parse(await readFile(settingsFile(), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(settings.mcpServers)).toEqual(['other', 'gitlab']);
    expect((await stat(settingsFile())).mode & 0o777).toBe(0o644);
  });

  it("does not copy anything when the user's own gitlab entry is there", async () => {
    await mkdir(path.dirname(settingsFile()), { recursive: true });
    const own = '{ "mcpServers": { "gitlab": { "command": "node", "args": ["/x.js"] } } }\n';
    await writeFile(settingsFile(), own);
    const logger = new MemoryLogger();
    expect(await provisionMcpGitlab(executor, target(), setup(), logger)).toBe('foreign');
    expect(await readFile(settingsFile(), 'utf8')).toBe(own);
    await expect(stat(bundleFile())).rejects.toThrow();
    expect(logger.entries.some((e) => e.message.includes('did not write'))).toBe(true);
  });

  it('never writes the token into a file', async () => {
    await provisionMcpGitlab(executor, target(), setup(), new MemoryLogger());
    for (const file of [settingsFile(), bundleFile()]) {
      expect(await readFile(file, 'utf8')).not.toContain(token);
    }
  });

  it('tells when the pod has no token, and only then', async () => {
    let missing = 0;
    const onTokenMissing = () => void missing++;
    await provisionMcpGitlab(executor, target(), setup({ onTokenMissing }), new MemoryLogger());
    expect(missing).toBe(0);
    delete env.GITLAB_PERSONAL_ACCESS_TOKEN;
    await provisionMcpGitlab(executor, target(), setup({ onTokenMissing }), new MemoryLogger());
    expect(missing).toBe(1);
  });

  it('writes nothing without a writable home directory', async () => {
    env.HOME = path.join(home, 'missing');
    expect(await provisionMcpGitlab(executor, target(), setup(), new MemoryLogger())).toBe(
      'nohome',
    );
    expect(await readdir(home)).toEqual([]);
  });

  it('refuses a folder that is a link, without writing through it', async () => {
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'dck-mcp-other-'));
    try {
      await mkdir(path.join(home, '.kiro-server'));
      const { symlink } = await import('node:fs/promises');
      await symlink(elsewhere, path.join(home, '.kiro-server', 'mcp'));
      await expect(
        provisionMcpGitlab(executor, target(), setup(), new MemoryLogger()),
      ).rejects.toThrow(/not a directory of this user/);
      expect(await readdir(elsewhere)).toEqual([]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
