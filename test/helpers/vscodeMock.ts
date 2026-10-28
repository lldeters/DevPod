// A small, stateful stand-in for the `vscode` module so the editor-facing layers (src/ui,
// src/remote) can run under Vitest. It implements only what this extension calls. Tests alias
// `vscode` to this file (see vitest.config.ts) and steer behavior through `state`.
/* eslint-disable @typescript-eslint/no-explicit-any */

type Handler = (...args: any[]) => unknown;

export const state = {
  workspaceFolders: undefined as { uri: Uri; name: string; index: number }[] | undefined,
  /** User settings. */
  settings: {} as Record<string, unknown>,
  /** User settings of the remote side in a remote window; they win over `settings`, as in the IDE. */
  remoteSettings: {} as Record<string, unknown>,
  /** Workspace settings; they win over user settings in `get`, as in the IDE. */
  workspaceSettings: {} as Record<string, unknown>,
  registeredCommands: new Map<string, Handler>(),
  executed: [] as { command: string; args: unknown[] }[],
  infoMessages: [] as string[],
  errorMessages: [] as string[],
  /** What `showInformationMessage`/`showErrorMessage` resolve to (the clicked button). */
  nextChoice: undefined as string | undefined,
  /** Index of the quick pick item to select (default: first). */
  quickPickIndex: 0,
  /** Indexes for consecutive quick picks (multi-step flows); falls back to `quickPickIndex`. */
  quickPickSequence: [] as number[],
  quickPickCalls: [] as unknown[][],
  /** The title of every quick pick shown. */
  quickPickTitles: [] as (string | undefined)[],
  /** How many input boxes were shown. */
  inputBoxCount: 0,
  resolverApiEnabled: true,
  resolvers: new Map<string, unknown>(),
  appRoot: '/nonexistent',
  remoteName: undefined as string | undefined,
  statusBarItems: [] as { text: string; command?: string; visible: boolean }[],
  clipboard: '',
  openedDocuments: [] as { language?: string; content?: string }[],
  remoteAuthority: undefined as string | undefined,
  inputBoxValue: undefined as string | undefined,
  /** Modal warnings shown (`showWarningMessage`), with their detail text. */
  warnings: [] as { message: string; detail: string | undefined }[],
  /** Which button a warning is answered with; `undefined` dismisses it. */
  answerWarning: (_message: string): string | undefined => undefined,
};

export function reset(): void {
  state.workspaceFolders = undefined;
  state.settings = {};
  state.remoteSettings = {};
  state.workspaceSettings = {};
  state.registeredCommands.clear();
  state.executed = [];
  state.infoMessages = [];
  state.errorMessages = [];
  state.nextChoice = undefined;
  state.quickPickIndex = 0;
  state.quickPickSequence = [];
  state.quickPickCalls = [];
  state.quickPickTitles = [];
  state.inputBoxCount = 0;
  state.resolverApiEnabled = true;
  state.resolvers.clear();
  state.appRoot = '/nonexistent';
  state.remoteName = undefined;
  state.statusBarItems = [];
  state.clipboard = '';
  state.openedDocuments = [];
  state.remoteAuthority = undefined;
  state.inputBoxValue = undefined;
  state.warnings = [];
  state.answerWarning = () => undefined;
}

export class Uri {
  constructor(
    readonly scheme: string,
    readonly authority: string,
    readonly path: string,
  ) {}
  get fsPath(): string {
    return this.path;
  }
  static file(path: string): Uri {
    return new Uri('file', '', path);
  }
  static from(parts: { scheme: string; authority?: string; path?: string }): Uri {
    return new Uri(parts.scheme, parts.authority ?? '', parts.path ?? '');
  }
  toString(): string {
    return `${this.scheme}://${this.authority}${this.path}`;
  }
}

export class Disposable {
  constructor(private readonly onDispose: () => void = () => undefined) {}
  dispose(): void {
    this.onDispose();
  }
}

export class EventEmitter<T> {
  private listeners: ((value: T) => void)[] = [];
  event = (listener: (value: T) => void): Disposable => {
    this.listeners.push(listener);
    return new Disposable();
  };
  fire(value: T): void {
    this.listeners.forEach((listener) => listener(value));
  }
  dispose(): void {
    this.listeners = [];
  }
}

export class ThemeColor {
  constructor(readonly id: string) {}
}

export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ProgressLocation = { Notification: 15 };
export const ConfigurationTarget = { Global: 1 };

export class ManagedResolvedAuthority {
  constructor(
    readonly makeConnection: () => Thenable<unknown>,
    readonly connectionToken?: string,
  ) {}
}

export class RemoteAuthorityResolverError extends Error {
  constructor(
    message: string,
    readonly kind = 'unknown',
    readonly handled = false,
  ) {
    super(message);
  }
  static NotAvailable(message?: string, handled?: boolean): RemoteAuthorityResolverError {
    return new RemoteAuthorityResolverError(message ?? '', 'NotAvailable', handled ?? false);
  }
  static TemporarilyNotAvailable(message?: string): RemoteAuthorityResolverError {
    return new RemoteAuthorityResolverError(message ?? '', 'TemporarilyNotAvailable');
  }
}

export const commands = {
  registerCommand(id: string, handler: Handler): Disposable {
    state.registeredCommands.set(id, handler);
    return new Disposable(() => state.registeredCommands.delete(id));
  },
  async executeCommand(command: string, ...args: unknown[]): Promise<unknown> {
    state.executed.push({ command, args });
    return state.registeredCommands.get(command)?.(...args);
  },
};

export const window = {
  createOutputChannel: () => ({
    appendLine: () => undefined,
    show: () => undefined,
    dispose: () => undefined,
  }),
  createStatusBarItem: () => {
    const record: { text: string; command?: string; visible: boolean } = {
      text: '',
      visible: false,
    };
    state.statusBarItems.push(record);
    return {
      set text(value: string) {
        record.text = value;
      },
      set command(value: string | undefined) {
        if (value !== undefined) record.command = value;
      },
      tooltip: '',
      backgroundColor: undefined,
      color: undefined,
      show: () => {
        record.visible = true;
      },
      dispose: () => undefined,
    };
  },
  showInformationMessage: async (message: string): Promise<string | undefined> => {
    state.infoMessages.push(message);
    return state.nextChoice;
  },
  showWarningMessage: async (
    message: string,
    options?: { detail?: string },
  ): Promise<string | undefined> => {
    state.warnings.push({ message, detail: options?.detail });
    return state.answerWarning(message);
  },
  showErrorMessage: async (message: string): Promise<string | undefined> => {
    state.errorMessages.push(message);
    return state.nextChoice;
  },
  showQuickPick: async (items: unknown[], options?: { title?: string }): Promise<unknown> => {
    state.quickPickCalls.push(items);
    state.quickPickTitles.push(options?.title);
    return items[state.quickPickSequence.shift() ?? state.quickPickIndex];
  },
  showInputBox: async (): Promise<string | undefined> => {
    state.inputBoxCount++;
    return state.inputBoxValue;
  },
  showTextDocument: async () => undefined,
  withProgress: async <T>(
    _options: unknown,
    task: (progress: { report: Handler }, token: unknown) => Thenable<T>,
  ): Promise<T> =>
    task({ report: () => undefined }, { onCancellationRequested: () => new Disposable() }),
};

type Tree = Record<string, unknown>;

function isTree(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A settings layer as the IDE reads it: dotted keys become a tree, so a section can also be written
 * as an object (`"dev.containers": { ... }`).
 */
function toTree(layer: Record<string, unknown>): Tree {
  const root: Tree = {};
  for (const [key, value] of Object.entries(layer)) {
    const segments = key.split('.');
    const last = segments.pop() as string;
    let node = root;
    for (const segment of segments) {
      if (!isTree(node[segment])) node[segment] = {};
      node = node[segment] as Tree;
    }
    node[last] = structuredClone(value);
  }
  return root;
}

/** Like the IDE: an object is merged into an object; any other value replaces what is there. */
function merge(base: Tree, overlay: Tree): Tree {
  const result: Tree = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const current = result[key];
    result[key] = isTree(value) && isTree(current) ? merge(current, value) : value;
  }
  return result;
}

function lookup(root: Tree, key: string): unknown {
  let node: unknown = root;
  for (const segment of key.split('.')) {
    if (!isTree(node)) return undefined;
    node = node[segment];
  }
  return node;
}

export const workspace = {
  get workspaceFolders() {
    return state.workspaceFolders;
  },
  getConfiguration: (section?: string) => {
    const full = (key: string): string => (section ? `${section}.${key}` : key);
    const local = toTree(state.settings);
    const remote = toTree(state.remoteSettings);
    const workspaceLayer = toTree(state.workspaceSettings);
    // Like the IDE: the user layer is this machine's settings with the remote side's merged in.
    const user = merge(local, remote);
    return {
      get: <T>(key: string): T | undefined =>
        (lookup(workspaceLayer, full(key)) ?? lookup(user, full(key))) as T | undefined,
      inspect: <T>(key: string) => ({
        key: full(key),
        globalValue: lookup(user, full(key)) as T | undefined,
        globalLocalValue: lookup(local, full(key)) as T | undefined,
        globalRemoteValue: lookup(remote, full(key)) as T | undefined,
        workspaceValue: lookup(workspaceLayer, full(key)) as T | undefined,
      }),
      update: async (key: string, value: unknown): Promise<void> => {
        state.settings[full(key)] = value;
      },
    };
  },
  openTextDocument: async (options: { language?: string; content?: string }) => {
    state.openedDocuments.push(options);
    return options;
  },
  registerRemoteAuthorityResolver(prefix: string, resolver: unknown): Disposable {
    if (!state.resolverApiEnabled) {
      throw new Error("Extension 'x' CANNOT use API proposal: resolvers.");
    }
    state.resolvers.set(prefix, resolver);
    return new Disposable(() => state.resolvers.delete(prefix));
  },
};

export const version = '1.103.2';

export const env = {
  appName: 'Kiro',
  clipboard: {
    writeText: async (text: string): Promise<void> => {
      state.clipboard = text;
    },
  },
  get appRoot() {
    return state.appRoot;
  },
  get remoteName() {
    return state.remoteName;
  },
  get remoteAuthority() {
    return state.remoteAuthority;
  },
};

export const extensions = {
  getExtension: (): undefined => undefined,
};

export class MockMemento {
  private values = new Map<string, unknown>();
  get<T>(key: string, fallback?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : fallback) as T | undefined;
  }
  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.values.delete(key);
    else this.values.set(key, value);
  }
  keys(): string[] {
    return [...this.values.keys()];
  }
}
