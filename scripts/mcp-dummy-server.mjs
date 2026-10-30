// A minimal MCP server over stdio, without dependencies. Its tool `where_am_i` names the host, user
// and Node it runs on, and says whether GITLAB_PERSONAL_ACCESS_TOKEN is set (never its value), and
// whether Kiro expanded the reference to it. Set `dev.containers.mcpGitlab.bundlePath` to this file
// to check in Kiro where the MCP servers of a pod window run (docs/TESTING.md, section 7c); the
// end-to-end tests use it as the bundle too.
import * as os from 'node:os';
import { createInterface } from 'node:readline';

const send = (message) =>
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);

function whereAmI() {
  const token = process.env.GITLAB_PERSONAL_ACCESS_TOKEN;
  return [
    `host: ${os.hostname()}`,
    `user: ${os.userInfo().username}`,
    `home: ${os.homedir()}`,
    `node: ${process.version} (${process.execPath})`,
    `GITLAB_PERSONAL_ACCESS_TOKEN: ${token ? (token.startsWith('${') ? 'not expanded' : 'set') : 'not set'}`,
  ].join('\n');
}

const handlers = {
  initialize: (params) => ({
    protocolVersion: params?.protocolVersion ?? '2025-06-18',
    capabilities: { tools: {} },
    serverInfo: { name: 'devcontainers-kiro-dummy', version: '1.0.0' },
  }),
  ping: () => ({}),
  'tools/list': () => ({
    tools: [
      {
        name: 'where_am_i',
        description: 'Says on which host, as which user and with which Node this MCP server runs.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }),
  'tools/call': (params) =>
    params?.name === 'where_am_i'
      ? { content: [{ type: 'text', text: whereAmI() }] }
      : { content: [{ type: 'text', text: `Unknown tool ${params?.name}` }], isError: true },
};

createInterface({ input: process.stdin }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined) return; // a notification, such as notifications/initialized
  const handler = handlers[message.method];
  if (handler) send({ id: message.id, result: handler(message.params) });
  else
    send({
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    });
});
process.stderr.write(`devcontainers-kiro dummy MCP server on ${os.hostname()}\n`);
