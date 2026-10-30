import {
  chmod,
  chown,
  lstat,
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
import {
  MCP_STATUS_SCRIPT,
  MCP_WRITE_SCRIPT,
  parseScriptAnswer,
  provisionMcpServers,
} from '../../src/core/mcp/provision';
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

  it('refuses further variables that would write a secret, without naming it', () => {
    for (const env of [
      { GITLAB_TOKEN: 'glpat-plain' },
      { HTTPS_PROXY: 'http://me:glpat-plain@proxy:3128' },
    ]) {
      expect(() => serverEnv({ readOnly: true, env })).toThrow(/reference to a variable/);
      try {
        serverEnv({ readOnly: true, env });
      } catch (error) {
        expect((error as Error).message).not.toContain('glpat-plain');
      }
    }
    expect(
      serverEnv({ readOnly: true, env: { HTTPS_PROXY: 'http://me:${PROXY_PASSWORD}@proxy:3128' } })
        .HTTPS_PROXY,
    ).toBe('http://me:${PROXY_PASSWORD}@proxy:3128');
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
      header: { url: 'https://x', headers: { Authorization: 'Bearer abc123secret' } },
      mixed: { command: 'x', env: { API_KEY: 'pre${A}' } },
      flag: { command: 'x', args: ['--token', 'abc123secret'] },
      inline: { command: 'x', args: ['--api-key=abc123secret'] },
      registry: { command: 'npx', args: ['--registry', 'https://me:abc123secret@npm.example'] },
      query: { url: 'https://mcp.example/sse?api_key=abc123secret' },
      proxy: { command: 'x', env: { HTTPS_PROXY: 'http://me:abc123secret@proxy:3128' } },
      badArgs: { command: 'x', args: 'one two' },
      none: { args: [] },
      text: 'npx foo',
      'bad name': { command: 'x' },
    });
    expect(valid).toEqual({});
    expect(problems).toHaveLength(12);
    expect(problems[0]).toContain('"env.CONFLUENCE_TOKEN" looks like a secret');
    expect(problems.join('\n')).not.toContain('abc123secret');
  });

  it('accepts references in flags and URLs, and harmless flags and empty values', () => {
    const servers = {
      flag: { command: 'x', args: ['--token', '${MY_TOKEN}', '--auth-type', 'basic'] },
      boolean: { command: 'x', args: ['--token', '--verbose'] },
      registry: {
        command: 'npx',
        args: ['--registry', 'https://${NPM_USER}:${NPM_PASS}@npm.example'],
      },
      query: { url: 'https://mcp.example/sse?api_key=${MCP_KEY}&region=eu' },
      empty: { command: 'x', env: { SOME_TOKEN: '' } },
    };
    expect(checkServers(servers)).toEqual({ valid: servers, problems: [] });
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
      updated: [],
      removed: [],
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
      updated: [],
      removed: [],
    });
  });

  it('removes own entries that are no longer wanted', () => {
    const before = JSON.stringify({ mcpServers: { confluence, other: { command: 'x' } } });
    const { text, removed } = mergeMcpSettings(before, {
      servers: {},
      isOwn: () => true,
      remove: ['confluence', 'gone'],
    });
    expect(JSON.parse(text)).toEqual({ mcpServers: { other: { command: 'x' } } });
    expect(removed).toEqual(['confluence']);
  });

  it('removes keys it set before that the entry no longer has, and keeps the others', () => {
    const before = JSON.stringify({
      mcpServers: { c: { command: 'x', disabled: true, autoApprove: ['a'], note: 'mine' } },
    });
    const { text } = mergeMcpSettings(before, {
      servers: { c: { command: 'x' } },
      isOwn: () => true,
      previousKeys: () => ['command', 'disabled', 'autoApprove'],
    });
    expect(JSON.parse(text)).toEqual({ mcpServers: { c: { command: 'x', note: 'mine' } } });
  });

  it('handles names that every object inherits, such as constructor', () => {
    const { text, foreign } = mergeMcpSettings('{}', {
      servers: { constructor: { command: 'x' }, toString: { command: 'y' } },
      isOwn: () => false,
    });
    expect(foreign).toEqual([]);
    expect(JSON.parse(text)).toEqual({
      mcpServers: { constructor: { command: 'x' }, toString: { command: 'y' } },
    });
  });

  it('replaces an own entry that is not an object', () => {
    const { text } = mergeMcpSettings(JSON.stringify({ mcpServers: { c: 'oops' } }), {
      servers: { c: { command: 'x' } },
      isOwn: () => true,
    });
    expect(JSON.parse(text)).toEqual({ mcpServers: { c: { command: 'x' } } });
  });

  it('reads a file with a byte order mark, and does not rewrite it for the order of keys', () => {
    const withBom = '\uFEFF{"mcpServers": {"c": {"env": {"B": "2", "A": "1"}, "command": "x"}}}';
    const input = { servers: { c: { command: 'x', env: { A: '1', B: '2' } } }, isOwn: () => true };
    expect(mergeMcpSettings(withBom, input)).toMatchObject({ changed: false, text: withBom });
    const changed = mergeMcpSettings(withBom, { ...input, servers: { c: { command: 'y' } } });
    expect(changed.text.startsWith('{')).toBe(true);
    expect(JSON.parse(changed.text).mcpServers.c.command).toBe('y');
  });

  it('indents and ends lines like the file it changes', () => {
    const tabs = '{\r\n\t"mcpServers": {\r\n\t\t"a": { "command": "x" }\r\n\t}\r\n}\r\n';
    const { text } = mergeMcpSettings(tabs, {
      servers: { b: { command: 'y' } },
      isOwn: () => true,
    });
    expect(text).toContain('\r\n\t\t"b": {\r\n\t\t\t"command": "y"');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
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

  it('removes a server it wrote once it is no longer configured, and says only that', async () => {
    await provisionMcpServers(
      executor,
      target(),
      setup({ servers: { confluence } }),
      new MemoryLogger(),
    );
    const logger = new MemoryLogger();
    await provisionMcpServers(executor, target(), setup(), logger);
    expect(Object.keys((await readSettings()).mcpServers)).toEqual(['gitlab']);
    expect(logger.entries.map((e) => e.message)).toEqual([
      'Removed the MCP servers confluence in the pod (~/.kiro/settings/mcp.json).',
    ]);
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

  it('follows links of its own user, and writes a linked mcp.json through to its target', async () => {
    const dotfiles = await mkdtemp(path.join(tmpdir(), 'dck-mcp-dotfiles-'));
    try {
      await mkdir(path.join(dotfiles, 'kiro'));
      await writeFile(path.join(dotfiles, 'kiro', 'mcp.json'), '{ "mcpServers": {} }\n');
      await symlink(path.join(dotfiles, 'kiro'), path.join(home, '.kiro'));
      await mkdir(path.join(dotfiles, 'kiro', 'settings'));
      await symlink(
        path.join(dotfiles, 'kiro', 'mcp.json'),
        path.join(dotfiles, 'kiro', 'settings', 'mcp.json'),
      );
      await provisionMcpServers(executor, target(), setup(), new MemoryLogger());
      expect((await lstat(settingsFile())).isSymbolicLink()).toBe(true);
      const linked = JSON.parse(await readFile(path.join(dotfiles, 'kiro', 'mcp.json'), 'utf8'));
      expect(Object.keys(linked.mcpServers)).toEqual(['gitlab']);
    } finally {
      await rm(dotfiles, { recursive: true, force: true });
    }
  });

  it.skipIf(process.getuid?.() !== 0)(
    'refuses a link to a folder of another user, without writing through it',
    async () => {
      const elsewhere = await mkdtemp(path.join(tmpdir(), 'dck-mcp-other-'));
      try {
        await chown(elsewhere, 12345, 12345);
        await mkdir(path.join(home, '.kiro-server'));
        await symlink(elsewhere, path.join(home, '.kiro-server', 'mcp'));
        await expect(
          provisionMcpServers(executor, target(), setup(), new MemoryLogger()),
        ).rejects.toThrow(/not a directory of this user/);
        expect(await readdir(elsewhere)).toEqual([]);
      } finally {
        await rm(elsewhere, { recursive: true, force: true });
      }
    },
  );

  it('still knows its own servers when managed.json is lost', async () => {
    await provisionMcpServers(
      executor,
      target(),
      setup({ servers: { confluence } }),
      new MemoryLogger(),
    );
    await rm(path.join(home, '.kiro-server'), { recursive: true, force: true });
    const logger = new MemoryLogger();
    await provisionMcpServers(executor, target(), setup({ servers: { confluence } }), logger);
    expect(logger.entries.filter((e) => e.message.includes('did not write'))).toEqual([]);
    const managed = path.join(home, '.kiro-server', 'mcp', 'managed.json');
    expect(Object.keys(JSON.parse(await readFile(managed, 'utf8')))).toEqual(['confluence']);
    // and can therefore remove it later
    await provisionMcpServers(executor, target(), setup(), new MemoryLogger());
    expect(Object.keys((await readSettings()).mcpServers)).toEqual(['gitlab']);
  });

  it('removes a key that was dropped from the setting, and keeps one added in the pod', async () => {
    await provisionMcpServers(
      executor,
      target(),
      setup({ servers: { confluence } }),
      new MemoryLogger(),
    );
    const settings = await readSettings();
    (settings.mcpServers.confluence as Record<string, unknown>).timeout = 60000;
    await writeFile(settingsFile(), JSON.stringify(settings));
    const { disabled: _dropped, ...withoutDisabled } = confluence;
    await provisionMcpServers(
      executor,
      target(),
      setup({ servers: { confluence: withoutDisabled } }),
      new MemoryLogger(),
    );
    expect((await readSettings()).mcpServers.confluence).toEqual({
      ...withoutDisabled,
      timeout: 60000,
    });
  });

  it('removes the last server it wrote when the setting is empty', async () => {
    const only = (servers: Record<string, unknown>): McpSetup => ({ servers });
    await provisionMcpServers(executor, target(), only({ confluence }), new MemoryLogger());
    const logger = new MemoryLogger();
    expect(await provisionMcpServers(executor, target(), only({}), logger)).toBe('updated');
    expect((await readSettings()).mcpServers).toEqual({});
    expect(logger.entries.map((e) => e.message)).toContain(
      'Removed the MCP servers confluence in the pod (~/.kiro/settings/mcp.json).',
    );
    await expect(stat(bundleFile())).rejects.toThrow();
  });

  it('sets up the other servers when the GitLab settings would write a secret', async () => {
    const logger = new MemoryLogger();
    const bad = setup({
      gitlab: { bundle: 'x', config: { readOnly: true, env: { GITLAB_TOKEN: 'glpat-plain' } } },
      servers: { confluence },
    });
    expect(await provisionMcpServers(executor, target(), bad, logger)).toBe('updated');
    expect(Object.keys((await readSettings()).mcpServers)).toEqual(['confluence']);
    await expect(stat(bundleFile())).rejects.toThrow();
    expect(logger.entries.some((e) => e.message.includes('GITLAB_TOKEN'))).toBe(true);
    expect(JSON.stringify(logger.entries)).not.toContain('glpat-plain');
  });

  describe('the scripts on their own', () => {
    const run = (script: string, stdin: string) =>
      runProcess(process.execPath, ['-e', script], { env, stdin });

    it('never echo the request in an error message', async () => {
      const result = await run(MCP_STATUS_SCRIPT, '{"settings": "supersecret-value" garbage');
      expect(result.code).toBe(1);
      expect(result.stderr.trim()).toBe('the request could not be read');
    });

    it('write nothing when mcp.json changed since it was read', async () => {
      await mkdir(path.dirname(settingsFile()), { recursive: true });
      await writeFile(settingsFile(), '{"changed": "by someone else"}');
      const result = await run(
        MCP_WRITE_SCRIPT,
        JSON.stringify({
          managedFirst: { path: '.kiro-server/mcp/managed.json', text: '{}' },
          bundle: { path: '.kiro-server/mcp/mcp-gitlab.mjs', text: 'x' },
          settings: { path: '.kiro/settings/mcp.json', text: '{}', expected: '{}' },
        }),
      );
      expect(parseScriptAnswer(result.stdout)).toEqual({ home, settings: 'changed' });
      expect(await readFile(settingsFile(), 'utf8')).toBe('{"changed": "by someone else"}');
      await expect(stat(path.join(home, '.kiro-server'))).rejects.toThrow();
    });

    it('leave no temporary file behind when a write fails', async () => {
      const folder = path.join(home, '.kiro-server', 'mcp');
      await mkdir(path.join(folder, 'managed.json'), { recursive: true });
      const result = await run(
        MCP_WRITE_SCRIPT,
        JSON.stringify({ managed: { path: '.kiro-server/mcp/managed.json', text: '{}' } }),
      );
      expect(result.code).toBe(1);
      expect(await readdir(folder)).toEqual(['managed.json']);
    });
  });
});
