import { describe, expect, it } from 'vitest';
import {
  parseCliLogLine,
  parseReadConfigurationResult,
  parseUpResult,
  redactEnvValues,
} from '../../src/core/cli/output';
import type { DevContainerError } from '../../src/core/errors';

describe('parseCliLogLine', () => {
  it('maps the CLI log levels', () => {
    expect(parseCliLogLine('{"type":"text","level":3,"text":"hello"}')).toEqual({
      kind: 'text',
      level: 'info',
      text: 'hello',
    });
    expect(parseCliLogLine('{"type":"start","level":2,"text":"Run: docker ps"}')).toMatchObject({
      kind: 'start',
      level: 'debug',
    });
    expect(parseCliLogLine('{"type":"text","level":5,"text":"bad"}').level).toBe('error');
    expect(parseCliLogLine('{"type":"text","level":1,"text":"t"}').level).toBe('trace');
  });

  it('uses the name of progress events as text', () => {
    expect(
      parseCliLogLine('{"type":"progress","level":3,"name":"Building","status":"running"}'),
    ).toMatchObject({ kind: 'progress', text: 'Building' });
  });

  it('passes non-JSON lines through as raw text', () => {
    expect(parseCliLogLine('Step 1/5 : FROM ubuntu')).toEqual({
      kind: 'raw',
      level: 'info',
      text: 'Step 1/5 : FROM ubuntu',
    });
    expect(parseCliLogLine('{"unrelated":true}').kind).toBe('raw');
  });
});

describe('redactEnvValues', () => {
  it('masks the values of env and build arguments but keeps the names', () => {
    expect(
      redactEnvValues(
        'Run: docker run --sig-proxy=false -e NPM_TOKEN=npm_abc123 -e EMPTY= --env=A=b --env B=c ubuntu',
      ),
    ).toBe(
      'Run: docker run --sig-proxy=false -e NPM_TOKEN=*** -e EMPTY=*** --env=A=*** --env B=*** ubuntu',
    );
    expect(redactEnvValues('docker build --build-arg TOKEN=s3cr3t .')).toBe(
      'docker build --build-arg TOKEN=*** .',
    );
    expect(redactEnvValues('devcontainer up --remote-env KEY=value')).toBe(
      'devcontainer up --remote-env KEY=***',
    );
  });

  it('leaves other arguments alone', () => {
    const line = 'Run: docker run -e HOME --label devcontainer.local_folder=/x --name=y -u vscode';
    expect(redactEnvValues(line)).toBe(line);
  });

  it('applies to the log lines of the CLI', () => {
    expect(
      parseCliLogLine('{"type":"start","level":2,"text":"Run: docker run -e API_KEY=k1 img"}').text,
    ).toBe('Run: docker run -e API_KEY=*** img');
  });
});

describe('parseCliLogLine cleanup', () => {
  it('removes terminal color codes from text and raw lines', () => {
    const esc = String.fromCharCode(27);
    expect(
      parseCliLogLine(
        JSON.stringify({
          type: 'text',
          level: 2,
          text: `${esc}[1m${esc}[31mhi${esc}[39m${esc}[22m`,
        }),
      ).text,
    ).toBe('hi');
    expect(parseCliLogLine(`${esc}[32mgreen${esc}[0m`).text).toBe('green');
  });

  it('logs the end of a command at trace level so each command appears once at debug', () => {
    expect(parseCliLogLine('{"type":"start","level":2,"text":"Run: docker ps"}').level).toBe(
      'debug',
    );
    expect(parseCliLogLine('{"type":"stop","level":2,"text":"Run: docker ps"}').level).toBe(
      'trace',
    );
  });
});

describe('parseUpResult', () => {
  const ok = {
    outcome: 'success',
    containerId: 'abc123',
    remoteUser: 'vscode',
    remoteWorkspaceFolder: '/workspaces/app',
    composeProjectName: 'app_devcontainer',
  };

  it('parses a success document', () => {
    expect(parseUpResult(JSON.stringify(ok))).toEqual(ok);
  });

  it('includes the merged configuration when present', () => {
    const merged = { customizations: { vscode: [{ extensions: ['a.b'] }] } };
    expect(
      parseUpResult(JSON.stringify({ ...ok, mergedConfiguration: merged })).mergedConfiguration,
    ).toEqual(merged);
    expect(parseUpResult(JSON.stringify(ok)).mergedConfiguration).toBeUndefined();
    expect(
      parseUpResult(JSON.stringify({ ...ok, mergedConfiguration: [1] })).mergedConfiguration,
    ).toBeUndefined();
  });

  it('finds the document after other output lines', () => {
    expect(parseUpResult(`some noise\n${JSON.stringify(ok)}\n`).containerId).toBe('abc123');
  });

  it('turns an error outcome into a CLI_FAILED error with its description', () => {
    const text = JSON.stringify({
      outcome: 'error',
      message: 'Build failed',
      description: 'exit 1',
    });
    expect(() => parseUpResult(text)).toThrowError(/Build failed: exit 1/);
    try {
      parseUpResult(text);
    } catch (error) {
      expect((error as DevContainerError).code).toBe('CLI_FAILED');
    }
  });

  it('rejects empty and incomplete output', () => {
    expect(() => parseUpResult('')).toThrowError(/no result/);
    expect(() => parseUpResult('{"outcome":"success"}')).toThrowError(/containerId/);
    expect(() => parseUpResult('{"foo":1}')).toThrowError(/outcome/);
  });
});

describe('parseReadConfigurationResult', () => {
  it('extracts configuration and workspace folder', () => {
    const result = parseReadConfigurationResult(
      JSON.stringify({
        configuration: { name: 'x' },
        workspace: { workspaceFolder: '/workspaces/repo/sub', workspaceMount: 'type=bind' },
      }),
    );
    expect(result.configuration).toEqual({ name: 'x' });
    expect(result.workspace).toEqual({
      workspaceFolder: '/workspaces/repo/sub',
      workspaceMount: 'type=bind',
    });
    expect(result.mergedConfiguration).toBeUndefined();
  });

  it('requires a workspace folder', () => {
    expect(() => parseReadConfigurationResult('{"configuration":{},"workspace":{}}')).toThrowError(
      /workspaceFolder/,
    );
  });
});
