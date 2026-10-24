import { describe, expect, it } from 'vitest';
import { execArgs } from '../../src/core/engine/containerEngine';

describe('execArgs', () => {
  it('builds a minimal exec', () => {
    expect(execArgs({ containerId: 'c1', command: ['ls', '-la'] })).toEqual([
      'exec',
      'c1',
      'ls',
      '-la',
    ]);
  });

  it('adds interactive, user, workdir and environment before the container id', () => {
    expect(
      execArgs({
        containerId: 'c1',
        command: ['sh', '-s'],
        interactive: true,
        user: 'vscode',
        workdir: '/workspaces/app',
        env: { A: '1' },
      }),
    ).toEqual([
      'exec',
      '-i',
      '-u',
      'vscode',
      '-w',
      '/workspaces/app',
      '-e',
      'A=1',
      'c1',
      'sh',
      '-s',
    ]);
  });

  it('never splits values that contain spaces or shell characters', () => {
    const args = execArgs({ containerId: 'c1', command: ['echo', '$(id); x'], env: { B: 'a b' } });
    expect(args).toContain('$(id); x');
    expect(args).toContain('B=a b');
  });
});
