// Checks the MCP setup in a real container or pod: shared by the Docker and the Kubernetes
// end-to-end tests, which differ only in how a command runs there.
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { expect } from 'vitest';
import { MemoryLogger } from '../../src/core/logger';
import { provisionMcpServers } from '../../src/core/mcp/provision';
import type { McpSetup, McpTarget } from '../../src/core/mcp/provision';
import type { ServerExecutor } from '../../src/core/server/provisioner';

export interface McpEndToEnd {
  readonly executor: ServerExecutor;
  readonly target: McpTarget;
  /** Runs `command` in the container or pod (as the target's user), with `input` on stdin. */
  readonly run: (command: readonly string[], input?: string) => string;
  /** The value of GITLAB_PERSONAL_ACCESS_TOKEN in the environment of the container or pod. */
  readonly token: string;
}

const dummy = readFileSync(
  path.join(__dirname, '..', '..', 'scripts', 'mcp-dummy-server.mjs'),
  'utf8',
);
// The real bundle is a few MB; this checks that a payload of that size gets through exec's stdin.
const bundle = `${dummy}\n// ${'x'.repeat(3 * 1024 * 1024)}\n`;

const confluence = {
  command: 'npx',
  args: ['--yes', '@ai-tools/mcp-confluence@latest'],
  env: { CONFLUENCE_TOKEN: '${CONFLUENCE_TOKEN}', CONFLUENCE_HOST: 'https://confluence.example' },
  autoApprove: ['confluence_search'],
};

const MESSAGES = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'e2e', version: '1' },
    },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'where_am_i', arguments: {} } },
]
  .map((message) => JSON.stringify(message))
  .join('\n');

export async function checkMcpEndToEnd(t: McpEndToEnd): Promise<void> {
  const logger = new MemoryLogger();
  const home = t.run(['sh', '-c', 'printf %s "$HOME"']);
  const settingsFile = `${home}/.kiro/settings/mcp.json`;
  const folder = `${home}/${t.target.dataFolderName}/mcp`;
  const missing: string[][] = [];
  const setup = (servers: Record<string, unknown>): McpSetup => ({
    gitlab: { bundle, config: { apiUrl: 'https://gitlab.example/api/v4', readOnly: true } },
    servers,
    onMissingVariables: (names) => missing.push([...names]),
  });

  try {
    expect(await provisionMcpServers(t.executor, t.target, setup({ confluence }), logger)).toBe(
      'updated',
    );
    expect(missing).toEqual([['CONFLUENCE_TOKEN']]);

    const settings = JSON.parse(t.run(['cat', settingsFile])) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(Object.keys(settings.mcpServers)).toEqual(['confluence', 'gitlab']);
    const gitlab = settings.mcpServers['gitlab'];
    expect(gitlab).toEqual({
      command: t.target.node,
      args: [`${folder}/mcp-gitlab.mjs`],
      env: {
        GITLAB_API_URL: 'https://gitlab.example/api/v4',
        GITLAB_READ_ONLY_MODE: 'true',
        GITLAB_PERSONAL_ACCESS_TOKEN: '${GITLAB_PERSONAL_ACCESS_TOKEN}',
      },
    });
    expect(t.run(['sh', '-c', `wc -c < "${folder}/mcp-gitlab.mjs"`]).trim()).toBe(
      String(Buffer.byteLength(bundle)),
    );
    expect(
      t.run(['stat', '-c', '%a', settingsFile, `${folder}/mcp-gitlab.mjs`]).split('\n'),
    ).toEqual(['600', '600', '']);

    // Started the way Kiro starts it: the token comes from the environment of the container or pod.
    const answer = t
      .run([gitlab?.command ?? '', ...(gitlab?.args ?? [])], `${MESSAGES}\n`)
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { id?: number; result?: { content: { text: string }[] } })
      .find((message) => message.id === 2);
    const hostname = t.run([t.target.node, '-p', 'require("os").hostname()']).trim();
    expect(answer?.result?.content[0]?.text).toContain(`host: ${hostname}`);
    expect(answer?.result?.content[0]?.text).toContain('GITLAB_PERSONAL_ACCESS_TOKEN: set');

    // No file the extension wrote contains the token, and nothing is left behind.
    expect(
      t.run(['sh', '-c', `grep -rl "$0" "$1" "$2" || true`, t.token, `${home}/.kiro`, folder]),
    ).toBe('');
    expect(t.run(['ls', '-A', folder]).trim().split('\n')).toEqual([
      'managed.json',
      'mcp-gitlab.mjs',
    ]);

    const again = new MemoryLogger();
    expect(await provisionMcpServers(t.executor, t.target, setup({ confluence }), again)).toBe(
      'unchanged',
    );
    await provisionMcpServers(t.executor, t.target, setup({}), new MemoryLogger());
    expect(
      Object.keys((JSON.parse(t.run(['cat', settingsFile])) as typeof settings).mcpServers),
    ).toEqual(['gitlab']);
  } finally {
    t.run(['rm', '-rf', `${home}/.kiro`, folder]);
  }
}
