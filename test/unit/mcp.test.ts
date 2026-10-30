import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryLogger } from '../../src/core/logger';
import { buildServerEntry, serverEnv } from '../../src/core/mcp/gitlab';
import { provisionMcpServers } from '../../src/core/mcp/provision';
import type { McpSetup } from '../../src/core/mcp/provision';
import { checkServers, mergeMcpSettings, referencedVariables } from '../../src/core/mcp/servers';
import { runProcess } from '../../src/core/process';
import type { ServerExecutor } from '../../src/core/server/provisioner';

const config = { apiUrl: 'https://gitlab.example/api/v4', readOnly: true };
const bundlePath = '/home/u/.kiro-server/mcp/mcp-gitlab.mjs';

const confluence = {
  command: 'npx',
  args: ['--yes', '--registry', 'https://npm.example', '@ai-tools/mcp-confluence@latest'],
  env: {
    CONFLUENCE_TOKEN: '${CONFLUENCE_TOKEN}',
    CONFLUENCE_HOST: 'https://confluence.example',
    MCP_CONFLUENCE_PII_FILTER: 'on',
    MCP_CONFLUENCE_WRITE_TOOLS: 'confluence_create_page,confluence_add_comment',
  },
  disabled: false,
  autoApprove: ['confluence_search', 'confluence_get_page'],
};

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

describe('checkServers', () => {
  it('accepts servers whose secrets refer to variables of the pod', () => {
    const remote = {
      url: 'https://mcp.example',
      headers: { Authorization: 'Bearer ${API_TOKEN}' },
    };
    expect(checkServers({ confluence, remote })).toEqual({
      valid: { confluence, remote },
      problems: [],
    });
  });

  it('refuses secrets in plain text and entries that cannot be servers', () => {
    const { valid, problems } = checkServers({
      plain: { ...confluence, env: { ...confluence.env, CONFLUENCE_TOKEN: 'abc123secret' } },
      header: { url: 'https://x', headers: { Authorization: 'Bearer abc' } },
      mixed: { command: 'x', env: { API_KEY: 'pre${A}' } },
      none: { args: [] },
      text: 'npx foo',
      'bad name': { command: 'x' },
    });
    expect(valid).toEqual({});
    expect(problems).toHaveLength(6);
    expect(problems[0]).toContain('"CONFLUENCE_TOKEN" looks like a secret');
    expect(problems.join('\n')).not.toContain('abc123secret');
  });

  it('lists the variables entries refer to', () => {
    expect(referencedVariables([confluence, buildServerEntry('n', 'b', config)])).toEqual([
      'CONFLUENCE_TOKEN',
      'GITLAB_PERSONAL_ACCESS_TOKEN',
    ]);
  });
});

describe('mergeMcpSettings', () => {
  const entry = buildServerEntry('/srv/node', bundlePath, config);
  const isGitlab = (_: string, current: unknown) =>
    (current as { args?: string[] }).args?.[0] === bundlePath;

  it('creates the file and the entry', () => {
    const { text, changed } = mergeMcpSettings('', { servers: { gitlab: entry }, isOwn: isGitlab });
    expect(changed).toBe(true);
    expect(JSON.parse(text)).toEqual({ mcpServers: { gitlab: entry } });
  });

  it('keeps other servers, other keys and comments, and is unchanged the second time', () => {
    const existing =
      '{\n  // mine\n  "mcpServers": {\n    "fetch": { "command": "uvx", "args": ["mcp-server-fetch"] }\n  },\n  "x": 1\n}\n';
    const input = { servers: { gitlab: entry, confluence }, isOwn: isGitlab };
    const first = mergeMcpSettings(existing, input);
    expect(first.text).toContain('// mine');
    expect(first.text).toContain('"mcp-server-fetch"');
    expect(first.text).toContain('"x": 1');
    expect(JSON.parse(first.text.replace('// mine', '')).mcpServers.confluence).toEqual(confluence);
    expect(mergeMcpSettings(first.text, { ...input, isOwn: () => true })).toEqual({
      text: first.text,
      changed: false,
      foreign: [],
    });
  });

  it('updates its own entry and keeps what the user added to it', () => {
    const own = JSON.stringify({
      mcpServers: { gitlab: { command: '/old/node', args: [bundlePath], env: {}, disabled: true } },
    });
    const { text } = mergeMcpSettings(own, { servers: { gitlab: entry }, isOwn: isGitlab });
    expect(JSON.parse(text)).toEqual({ mcpServers: { gitlab: { ...entry, disabled: true } } });
  });

  it("leaves an entry of the user's own alone", () => {
    const foreign = JSON.stringify({
      mcpServers: { gitlab: { command: 'node', args: ['/opt/mcp-gitlab/dist/index.js'] } },
    });
    expect(mergeMcpSettings(foreign, { servers: { gitlab: entry }, isOwn: isGitlab })).toEqual({
      text: foreign,
      changed: false,
      foreign: ['gitlab'],
    });
  });

  it('removes own entries that are no longer wanted', () => {
    const before = JSON.stringify({ mcpServers: { confluence, other: { command: 'x' } } });
    const { text } = mergeMcpSettings(before, {
      servers: {},
      isOwn: () => true,
      remove: ['confluence'],
    });
    expect(JSON.parse(text)).toEqual({ mcpServers: { other: { command: 'x' } } });
  });

  it('refuses a file that is not a JSON object', () => {
    const input = { servers: { gitlab: entry }, isOwn: isGitlab };
    expect(() => mergeMcpSettings('{ "mcpServers": ', input)).toThrow(/left unchanged/);
    expect(() => mergeMcpSettings('[]', input)).toThrow(/left unchanged/);
    expect(() => mergeMcpSettings('{"mcpServers": 3}', input)).toThrow(/left unchanged/);
  });
});

describe.skipIf(process.platform === 'win32')('provisionMcpServers (scripts run by Node)', () => {
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
  const setup = (extra: Partial<McpSetup> = {}): McpSetup => ({
    gitlab: { bundle: 'console.log("mcp-gitlab");\n', config },
    servers: {},
    ...extra,
  });
  const settingsFile = () => path.join(home, '.kiro', 'settings', 'mcp.json');
  const bundleFile = () => path.join(home, '.kiro-server', 'mcp', 'mcp-gitlab.mjs');
  const readSettings = async () =>
    JSON.parse(await readFile(settingsFile(), 'utf8')) as { mcpServers: Record<string, unknown> };

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'dck-mcp-'));
    env = {
      PATH: process.env.PATH,
      HOME: home,
      GITLAB_PERSONAL_ACCESS_TOKEN: token,
      CONFLUENCE_TOKEN: 'confluence-secret',
    };
    calls = [];
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('copies the bundle and registers it with the Node that runs it, privately', async () => {
    const outcome = await provisionMcpServers(executor, target(), setup(), new MemoryLogger());
    expect(outcome).toBe('updated');
    expect(await readFile(bundleFile(), 'utf8')).toBe('console.log("mcp-gitlab");\n');
    expect((await stat(bundleFile())).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(bundleFile()))).mode & 0o777).toBe(0o700);
    expect(await readSettings()).toEqual({
      mcpServers: { gitlab: buildServerEntry(process.execPath, bundleFile(), config) },
    });
    expect(calls.every((call) => call[0] === process.execPath && call[1] === '-e')).toBe(true);
  });

  it('registers further servers such as Confluence next to it', async () => {
    await provisionMcpServers(
      executor,
      target(),
      setup({ servers: { confluence } }),
      new MemoryLogger(),
    );
    const settings = await readSettings();
    expect(Object.keys(settings.mcpServers)).toEqual(['confluence', 'gitlab']);
    expect(settings.mcpServers.confluence).toEqual(confluence);
  });

  it('changes nothing on the second connection', async () => {
    const both = setup({ servers: { confluence } });
    await provisionMcpServers(executor, target(), both, new MemoryLogger());
    const before = await stat(settingsFile());
    calls = [];
    const outcome = await provisionMcpServers(executor, target(), both, new MemoryLogger());
    expect(outcome).toBe('unchanged');
    expect(calls).toHaveLength(1); // only the status script
    expect((await stat(settingsFile())).mtimeMs).toBe(before.mtimeMs);
    expect((await readdir(path.dirname(settingsFile()))).sort()).toEqual(['mcp.json']);
  });

  it('removes a server it wrote once it is no longer configured', async () => {
    await provisionMcpServers(
      executor,
      target(),
      setup({ servers: { confluence } }),
      new MemoryLogger(),
    );
    await provisionMcpServers(executor, target(), setup(), new MemoryLogger());
    expect(Object.keys((await readSettings()).mcpServers)).toEqual(['gitlab']);
  });

  it('copies a changed bundle again', async () => {
    await provisionMcpServers(executor, target(), setup(), new MemoryLogger());
    const outcome = await provisionMcpServers(
      executor,
      target(),
      setup({ gitlab: { bundle: 'console.log(2);\n', config } }),
      new MemoryLogger(),
    );
    expect(outcome).toBe('updated');
    expect(await readFile(bundleFile(), 'utf8')).toBe('console.log(2);\n');
  });

  it('keeps other entries and the mode of an existing mcp.json', async () => {
    await mkdir(path.dirname(settingsFile()), { recursive: true });
    await writeFile(settingsFile(), '{ "mcpServers": { "other": { "command": "x" } } }\n');
    await chmod(settingsFile(), 0o644);
    await provisionMcpServers(executor, target(), setup(), new MemoryLogger());
    expect(Object.keys((await readSettings()).mcpServers)).toEqual(['other', 'gitlab']);
    expect((await stat(settingsFile())).mode & 0o777).toBe(0o644);
  });

  it("does not touch entries of the user's own with the same names", async () => {
    await mkdir(path.dirname(settingsFile()), { recursive: true });
    const own =
      '{ "mcpServers": { "gitlab": { "command": "node", "args": ["/x.js"] }, "confluence": { "command": "y" } } }\n';
    await writeFile(settingsFile(), own);
    const logger = new MemoryLogger();
    await provisionMcpServers(executor, target(), setup({ servers: { confluence } }), logger);
    expect(await readFile(settingsFile(), 'utf8')).toBe(own);
    await expect(stat(bundleFile())).rejects.toThrow();
    expect(logger.entries.filter((e) => e.message.includes('did not write'))).toHaveLength(2);
  });

  it('never writes the tokens into a file', async () => {
    await provisionMcpServers(
      executor,
      target(),
      setup({ servers: { confluence } }),
      new MemoryLogger(),
    );
    for (const file of [settingsFile(), bundleFile()]) {
      const text = await readFile(file, 'utf8');
      expect(text).not.toContain(token);
      expect(text).not.toContain('confluence-secret');
    }
  });

  it('reports the variables that are not set in the pod, and only then', async () => {
    const missing: string[][] = [];
    const onMissingVariables = (names: readonly string[]) => void missing.push([...names]);
    const both = setup({ servers: { confluence }, onMissingVariables });
    await provisionMcpServers(executor, target(), both, new MemoryLogger());
    expect(missing).toEqual([]);
    delete env.GITLAB_PERSONAL_ACCESS_TOKEN;
    delete env.CONFLUENCE_TOKEN;
    await provisionMcpServers(executor, target(), both, new MemoryLogger());
    expect(missing).toEqual([['CONFLUENCE_TOKEN', 'GITLAB_PERSONAL_ACCESS_TOKEN']]);
  });

  it('writes nothing without a writable home directory', async () => {
    env.HOME = path.join(home, 'missing');
    expect(await provisionMcpServers(executor, target(), setup(), new MemoryLogger())).toBe(
      'nohome',
    );
    expect(await readdir(home)).toEqual([]);
  });

  it('refuses a folder that is a link, without writing through it', async () => {
    const elsewhere = await mkdtemp(path.join(tmpdir(), 'dck-mcp-other-'));
    try {
      await mkdir(path.join(home, '.kiro-server'));
      await symlink(elsewhere, path.join(home, '.kiro-server', 'mcp'));
      await expect(
        provisionMcpServers(executor, target(), setup(), new MemoryLogger()),
      ).rejects.toThrow(/not a directory of this user/);
      expect(await readdir(elsewhere)).toEqual([]);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });
});
