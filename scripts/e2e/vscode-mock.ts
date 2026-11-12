// Minimal stand-in for the `vscode` module, backed by the real file system.
// Used only by the local end-to-end harness (scripts/e2e/run.mjs).
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

type Listener<T> = (e: T) => unknown;
class Emitter<T> {
  private listeners: Listener<T>[] = [];
  event = (l: Listener<T>) => {
    this.listeners.push(l);
    return { dispose: () => (this.listeners = this.listeners.filter((x) => x !== l)) };
  };
  fire(e: T) {
    this.listeners.forEach((l) => l(e));
  }
  dispose() {
    this.listeners = [];
  }
}

export class Uri {
  private constructor(readonly fsPath: string) {}
  get path() {
    return this.fsPath;
  }
  static file(p: string) {
    return new Uri(path.resolve(p));
  }
  static parse(s: string) {
    return new Uri(s.replace(/^file:\/\//, ''));
  }
  static joinPath(u: Uri, ...parts: string[]) {
    return new Uri(path.join(u.fsPath, ...parts));
  }
  toString() {
    return `file://${this.fsPath}`;
  }
}

export enum FileType {
  File = 1,
  Directory = 2,
}
export enum ViewColumn {
  Active = -1,
  Beside = -2,
}
export enum QuickPickItemKind {
  Separator = -1,
  Default = 0,
}
export class ThemeIcon {
  static Folder = new ThemeIcon('folder');
  constructor(readonly id: string) {}
}
export { Emitter as EventEmitter };
export enum TreeItemCollapsibleState {
  None = 0,
}
export class TreeItem {
  description?: string;
  tooltip?: unknown;
  iconPath?: unknown;
  resourceUri?: Uri;
  contextValue?: string;
  command?: { command: string; arguments?: unknown[] };
  constructor(readonly label: string, readonly collapsibleState: TreeItemCollapsibleState) {}
}
export class MarkdownString {
  constructor(readonly value: string) {}
}
export class RelativePattern {
  constructor(readonly base: Uri, readonly pattern: string) {}
}

export const log: string[] = [];
export const answers = { input: [] as (string | undefined)[], warning: [] as (string | undefined)[], quickPick: [] as unknown[] };

const fsApi = {
  async stat(u: Uri) {
    const s = await fs.stat(u.fsPath);
    return { type: s.isDirectory() ? FileType.Directory : FileType.File };
  },
  async readDirectory(u: Uri) {
    const entries = await fs.readdir(u.fsPath, { withFileTypes: true });
    return entries.map((e) => [e.name, e.isDirectory() ? FileType.Directory : FileType.File] as [string, FileType]);
  },
  async readFile(u: Uri) {
    return new Uint8Array(await fs.readFile(u.fsPath));
  },
  async writeFile(u: Uri, data: Uint8Array) {
    await fs.writeFile(u.fsPath, data);
  },
  async createDirectory(u: Uri) {
    await fs.mkdir(u.fsPath, { recursive: true });
  },
  async delete(u: Uri, opts: { useTrash?: boolean }) {
    if (opts.useTrash) {
      throw new Error('no trash');
    }
    await fs.rm(u.fsPath, { recursive: true });
  },
};

export class WorkspaceEdit {
  renames: [Uri, Uri][] = [];
  renameFile(from: Uri, to: Uri) {
    this.renames.push([from, to]);
  }
}

export const workspace = {
  fs: fsApi,
  workspaceFolders: [] as { uri: Uri; name: string }[],
  getWorkspaceFolder(u: Uri) {
    return this.workspaceFolders.find((f) => u.fsPath === f.uri.fsPath || u.fsPath.startsWith(f.uri.fsPath + path.sep));
  },
  asRelativePath(u: Uri) {
    const f = this.getWorkspaceFolder(u);
    return f ? path.relative(f.uri.fsPath, u.fsPath) || u.fsPath : u.fsPath;
  },
  onDidChangeWorkspaceFolders: new Emitter<unknown>().event,
  async findFiles(glob: string) {
    const fileName = glob.split('/').pop()!;
    const found: Uri[] = [];
    for (const f of this.workspaceFolders) {
      for (const rel of await fs.readdir(f.uri.fsPath, { recursive: true })) {
        if (path.basename(rel) === fileName && !rel.split(path.sep).includes('node_modules')) {
          found.push(Uri.joinPath(f.uri, rel));
        }
      }
    }
    return found;
  },
  getConfiguration: () => ({ get: <T>(_k: string, d: T) => d }),
  onDidChangeConfiguration: new Emitter<unknown>().event,
  createFileSystemWatcher: () => ({
    onDidCreate: new Emitter<Uri>().event,
    onDidDelete: new Emitter<Uri>().event,
    onDidChange: new Emitter<Uri>().event,
    dispose() {},
  }),
  async applyEdit(edit: WorkspaceEdit) {
    for (const [from, to] of edit.renames) {
      log.push(`rename ${from.fsPath} -> ${to.fsPath}`);
      await fs.rename(from.fsPath, to.fsPath);
    }
    return true;
  },
};

export let hostToWebview: (m: unknown) => void = () => undefined;
export const webviewToHost = new Emitter<unknown>();

export const treeView = { visible: false, visibility: new Emitter<{ visible: boolean }>() };

export const window = {
  createTreeView: () => ({
    get visible() {
      return treeView.visible;
    },
    onDidChangeVisibility: treeView.visibility.event,
    dispose() {},
  }),
  registerWebviewPanelSerializer: () => ({ dispose() {} }),
  createWebviewPanel: () => {
    const dispose = new Emitter<void>();
    return {
      title: '',
      iconPath: undefined,
      reveal() {},
      dispose: () => dispose.fire(),
      onDidDispose: dispose.event,
      onDidChangeViewState: new Emitter<unknown>().event,
      webview: {
        options: {},
        html: '',
        cspSource: 'file:',
        asWebviewUri: (u: Uri) => pathToFileURL(u.fsPath).toString(),
        postMessage: async (m: unknown) => hostToWebview(m),
        onDidReceiveMessage: webviewToHost.event,
      },
    };
  },
  showErrorMessage: async (m: string) => log.push(`error: ${m}`),
  showWarningMessage: async () => answers.warning.shift(),
  showInputBox: async (o: { validateInput?: (v: string) => string | undefined }) => {
    const v = answers.input.shift();
    const err = v === undefined ? undefined : o.validateInput?.(v);
    if (err) {
      log.push(`invalid: ${err}`);
      return undefined;
    }
    return v;
  },
  showQuickPick: async () => answers.quickPick.shift(),
  showTextDocument: async (u: Uri) => log.push(`show ${u.fsPath}`),
};

const registered = new Map<string, (...args: unknown[]) => unknown>();
export const commands = {
  registerCommand(id: string, fn: (...args: unknown[]) => unknown) {
    registered.set(id, fn);
    return { dispose: () => registered.delete(id) };
  },
  async executeCommand(id: string, ...args: unknown[]) {
    const fn = registered.get(id);
    if (fn) {
      log.push(`command ${id}`);
      return fn(...args);
    }
    log.push(`${id} ${(args[0] as Uri | undefined)?.fsPath ?? ''}`.trim());
  },
};

export const env = { language: 'en' };
export const l10n = {
  t: (s: string, ...args: unknown[]) => s.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)])),
};

export function setHostToWebview(fn: (m: unknown) => void) {
  hostToWebview = fn;
}
