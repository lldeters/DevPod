import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DevContainerCli } from '../../src/core/cli/devcontainerCli';
import type { CliLogEvent } from '../../src/core/cli/output';
import { MemoryLogger } from '../../src/core/logger';

// A stand-in for the Dev Container CLI that does what the real one does with a ${localEnv:...}
// secret in a lifecycle command: it logs the command and quotes it in its error document.
const FAKE_CLI = `
const secret = process.env.DCK_TEST_TOKEN;
const log = (text) => console.error(JSON.stringify({ type: 'start', level: 3, text }));
log('Run in container: /bin/sh -c npm config set //registry/:_authToken=' + secret);
console.log(JSON.stringify({
  outcome: 'error',
  message: 'Command failed: npm config set //registry/:_authToken=' + secret,
  description: 'postCreateCommand failed',
}));
process.exit(1);
`;

describe('DevContainerCli', () => {
  const secret = 'npm_s3cr3t-value-1234';
  let work: string;
  let script: string;

  beforeEach(async () => {
    work = await mkdtemp(path.join(tmpdir(), 'dck-redact-'));
    script = path.join(work, 'fake-cli.js');
    await writeFile(script, FAKE_CLI);
  });

  afterEach(async () => {
    await rm(work, { recursive: true, force: true });
  });

  it('keeps secret values of its environment out of the log, the progress and the error', async () => {
    const logger = new MemoryLogger();
    const progress: CliLogEvent[] = [];
    const cli = new DevContainerCli(
      () => ({ command: process.execPath, args: [script], env: { DCK_TEST_TOKEN: secret } }),
      logger,
    );

    const failure = await cli
      .up({ workspaceFolder: work }, { onLog: (event) => progress.push(event) })
      .then(
        () => undefined,
        (error: unknown) => error as Error,
      );

    expect(failure?.message).toContain('_authToken=***');
    expect(failure?.message).not.toContain(secret);
    expect(logger.entries.map((e) => e.message)).toContain(
      'Run in container: /bin/sh -c npm config set //registry/:_authToken=***',
    );
    expect(progress.map((e) => e.text).join('\n')).not.toContain(secret);
    expect(JSON.stringify(logger.entries)).not.toContain(secret);
  });
});
