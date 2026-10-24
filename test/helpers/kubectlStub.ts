// A stand-in for `kubectl` that needs no cluster. `kubectl exec ... -- <command>` runs the command
// locally, as if it ran inside the pod, so provisioning, the connection bridge and port tunnels
// execute for real. Read-only queries are answered from files in a directory the test controls.
// POSIX only (the stub is an executable script), like the docker stubs used elsewhere.
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface PodSpec {
  phase?: string;
  containers?: { name: string; running: boolean }[];
  defaultContainer?: string;
  name?: string;
  namespace?: string;
}

/** The JSON `kubectl get pod -o json` would print for a pod. */
export function podJson(spec: PodSpec = {}): string {
  const containers = spec.containers ?? [{ name: 'app', running: true }];
  return JSON.stringify({
    metadata: {
      name: spec.name ?? 'mypod',
      namespace: spec.namespace ?? 'dev',
      ...(spec.defaultContainer
        ? { annotations: { 'kubectl.kubernetes.io/default-container': spec.defaultContainer } }
        : {}),
    },
    spec: { containers: containers.map(({ name }) => ({ name })) },
    status: {
      phase: spec.phase ?? 'Running',
      containerStatuses: containers.map(({ name, running }) => ({
        name,
        ready: running,
        state: running ? { running: { startedAt: '2026-01-01T00:00:00Z' } } : { waiting: {} },
      })),
    },
  });
}

export function listJson(names: string[]): string {
  return JSON.stringify({ items: names.map((name) => ({ metadata: { name } })) });
}

export interface KubectlStub {
  /** Path of the executable to use as `kubectl`. */
  readonly path: string;
  /** Directory holding the canned answers and the call log; export it as KUBECTL_STUB_DIR. */
  readonly dir: string;
  /** Every invocation so far, as argument lists. */
  calls(): Promise<string[][]>;
  /** Sets a canned answer: pod.json, pods.json, namespaces.json, contexts, current-context. */
  set(name: string, content: string): Promise<void>;
  /** Removes one canned answer, so that query fails like a kubectl error. */
  unset(name: string): Promise<void>;
  /** Clears the call log and all canned answers. */
  reset(): Promise<void>;
}

const SCRIPT = (node: string): string => `#!${node}
const { spawn } = require('child_process');
const fs = require('fs');
const args = process.argv.slice(2);
const dir = process.env.KUBECTL_STUB_DIR;
fs.appendFileSync(dir + '/calls.log', JSON.stringify(args) + '\\n');
const has = (word) => args.includes(word);
const read = (name) => { try { return fs.readFileSync(dir + '/' + name, 'utf8'); } catch { return undefined; } };
const fail = (message) => { process.stderr.write(message + '\\n'); process.exit(1); };

const separator = args.indexOf('--');
if (has('exec') && separator >= 0) {
  const command = args.slice(separator + 1);
  const child = spawn(command[0], command.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, HOME: process.env.KUBECTL_STUB_HOME || process.env.HOME },
  });
  child.on('error', (error) => fail(String(error)));
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
} else if (has('current-context')) {
  const value = read('current-context');
  value === undefined ? fail('error: current-context is not set') : process.stdout.write(value + '\\n');
} else if (has('get-contexts')) {
  process.stdout.write(read('contexts') ?? '');
} else if (has('namespaces')) {
  const value = read('namespaces.json');
  value === undefined ? fail('Error from server (Forbidden): namespaces is forbidden') : process.stdout.write(value);
} else if (has('pods')) {
  const value = read('pods.json');
  value === undefined ? fail('Error from server (Forbidden): pods is forbidden') : process.stdout.write(value);
} else if (has('pod')) {
  const value = read('pod.json');
  value === undefined ? fail('Error from server (NotFound): pods "x" not found') : process.stdout.write(value);
} else {
  fail('unsupported kubectl call: ' + args.join(' '));
}
`;

export async function createKubectlStub(root: string): Promise<KubectlStub> {
  const dir = path.join(root, 'kubectl-stub');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'kubectl');
  await writeFile(file, SCRIPT(process.execPath));
  await chmod(file, 0o755);

  const log = path.join(dir, 'calls.log');
  return {
    path: file,
    dir,
    async calls() {
      const text = await readFile(log, 'utf8').catch(() => '');
      return text
        .split('\n')
        .filter((line) => line !== '')
        .map((line) => JSON.parse(line) as string[]);
    },
    async set(name, content) {
      await writeFile(path.join(dir, name), content);
    },
    async unset(name) {
      await rm(path.join(dir, name), { force: true });
    },
    async reset() {
      for (const name of [
        'calls.log',
        'pod.json',
        'pods.json',
        'namespaces.json',
        'contexts',
        'current-context',
      ]) {
        await rm(path.join(dir, name), { force: true });
      }
    },
  };
}
