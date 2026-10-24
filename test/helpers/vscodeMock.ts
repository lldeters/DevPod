// A small, stateful stand-in for the `vscode` module so the editor-facing layers (src/ui,
// src/remote) can run under Vitest. It implements only what this extension calls. Tests alias
// `vscode` to this file (see vitest.config.ts) and steer behavior through `state`.
/* eslint-disable @typescript-eslint/no-explicit-any */

type Handler = (...args: any[]) => unknown;

export const state = {
  workspaceFolders: undefined as { uri: Uri; name: string; index: number }[] | undefined,
  settings: {} as Record<string, unknown>,
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
  resolverApiEnabled: true,
  resolvers: new Map<string, unknown>(),
  appRoot: '/nonexistent',
  remoteName: undefined as string | undefined,
  statusBarItems: [] as { text: string; command?: string; visible: boolean }[],
  clipboard: '',
  openedDocuments: [] as { language?: string; content?: string }[],
  remoteAuthority: undefined as string | undefined,
  inputBoxValue: undefined as string | undefined,
};

export function reset(): void {
  state.workspaceFolders = undefined;
  state.settings = {};
  state.registeredCommands.clear();
  state.executed = [];
  state.infoMessages = [];
  state.errorMessages = [];
  state.nextChoice = undefined;
  state.quickPickIndex = 0;
  state.quickPickSequence = [];
  state.quickPickCalls = [];
  state.resolverApiEnabled = true;
  state.resolvers.clear();
  state.appRoot = '/nonexistent';
  state.remoteName = undefined;
  state.statusBarItems = [];
  state.clipboard = '';
  state.openedDocuments = [];
  state.remoteAuthority = undefined;
  state.inputBoxValue = undefined;
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
  showErrorMessage: async (message: string): Promise<string | undefined> => {
    state.errorMessages.push(message);
    return state.nextChoice;
  },
  showQuickPick: async (items: unknown[]): Promise<unknown> => {
    state.quickPickCalls.push(items);
    return items[state.quickPickSequence.shift() ?? state.quickPickIndex];
  },
  showInputBox: async (): Promise<string | undefined> => state.inputBoxValue,
  showTextDocument: async () => undefined,
  withProgress: async <T>(
    _options: unknown,
    task: (progress: { report: Handler }, token: unknown) => Thenable<T>,
  ): Promise<T> =>
    task({ report: () => undefined }, { onCancellationRequested: () => new Disposable() }),
};

export const workspace = {
  get workspaceFolders() {
    return state.workspaceFolders;
  },
  getConfiguration: (section?: string) => {
    const full = (key: string): string => (section ? `${section}.${key}` : key);
    return {
      get: <T>(key: string): T | undefined => state.settings[full(key)] as T | undefined,
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
