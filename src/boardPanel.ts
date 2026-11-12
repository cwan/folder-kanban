import * as vscode from 'vscode';
import {
  BoardConfig,
  CONFIG_FILE_NAME,
  ConfigError,
  Entry,
  addGroups,
  addTask,
  buildView,
  configsEqual,
  emptyConfig,
  isHidden,
  moveGroup,
  moveTask,
  newTaskName,
  normalize,
  parseConfig,
  removeGroup,
  removeTask,
  formatDue,
  parseDue,
  setDue,
  renameGroup,
  renameTask,
  serializeConfig,
  validateName,
} from './board';
import type { BoardState, FromWebview, ToWebview } from './protocol';

export const VIEW_TYPE = 'folderKanban.board';

const t = vscode.l10n.t;

function webviewStrings(): Record<string, string> {
  return {
    addTask: t('Add task'),
    addGroup: t('Add group'),
    emptyBoard: t('No task groups yet. Add folders of this board as task groups.'),
    emptyGroup: t('No tasks'),
    folder: t('Folder'),
    configError: t('Failed to read {0}', CONFIG_FILE_NAME),
    openConfig: t('Open config file'),
    due: t('Due'),
    overdue: t('Overdue'),
    setDue: t('Set due date'),
  };
}

interface Snapshot {
  config: BoardConfig;
  /** Entries of each existing group folder. */
  scan: Map<string, Entry[]>;
  /** Direct sub folders of the root that could become groups. */
  folders: string[];
}

export class BoardPanel {
  private static readonly panels = new Map<string, BoardPanel>();

  static get(root: string): BoardPanel | undefined {
    return BoardPanel.panels.get(root);
  }

  /** The panel that most recently had focus. */
  static active: BoardPanel | undefined;

  static show(context: vscode.ExtensionContext, root: vscode.Uri): BoardPanel {
    const existing = BoardPanel.panels.get(root.toString());
    if (existing) {
      existing.panel.reveal();
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, titleFor(root), vscode.ViewColumn.Active, {});
    return new BoardPanel(context, panel, root);
  }

  static revive(context: vscode.ExtensionContext, panel: vscode.WebviewPanel, root: vscode.Uri): BoardPanel {
    const existing = BoardPanel.panels.get(root.toString());
    if (existing) {
      existing.panel.dispose();
    }
    return new BoardPanel(context, panel, root);
  }

  private readonly disposables: vscode.Disposable[] = [];
  private queue: Promise<unknown> = Promise.resolve();
  private refreshTimer: NodeJS.Timeout | undefined;
  private readonly configUri: vscode.Uri;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly panel: vscode.WebviewPanel,
    readonly root: vscode.Uri,
  ) {
    this.configUri = vscode.Uri.joinPath(root, CONFIG_FILE_NAME);
    BoardPanel.panels.set(root.toString(), this);
    BoardPanel.active = this;

    panel.title = titleFor(root);
    panel.iconPath = {
      light: vscode.Uri.joinPath(context.extensionUri, 'media', 'board-light.svg'),
      dark: vscode.Uri.joinPath(context.extensionUri, 'media', 'board-dark.svg'),
    };
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    };
    panel.webview.html = this.html();

    this.disposables.push(
      panel.onDidDispose(() => this.dispose()),
      panel.onDidChangeViewState((e) => {
        if (e.webviewPanel.active) {
          BoardPanel.active = this;
        }
      }),
      panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m)),
    );

    // Only direct children of the root (groups) and grandchildren (tasks) matter.
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '{*,*/*}'));
    const onChange = (uri: vscode.Uri) => {
      if (uri.toString() === this.configUri.toString()) {
        this.scheduleRefresh();
      }
    };
    this.disposables.push(
      watcher,
      watcher.onDidCreate(() => this.scheduleRefresh()),
      watcher.onDidDelete(() => this.scheduleRefresh()),
      watcher.onDidChange(onChange),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('folderKanban', root)) {
          this.scheduleRefresh();
        }
      }),
    );
  }

  dispose(): void {
    if (BoardPanel.panels.get(this.root.toString()) === this) {
      BoardPanel.panels.delete(this.root.toString());
    }
    if (BoardPanel.active === this) {
      BoardPanel.active = undefined;
    }
    clearTimeout(this.refreshTimer);
    this.disposables.forEach((d) => d.dispose());
    this.panel.dispose();
  }

  // ---------------------------------------------------------------------------------------------
  // Messages

  private onMessage(m: FromWebview): void {
    switch (m.type) {
      case 'ready':
        this.refresh();
        break;
      case 'moveTask':
        this.run(() => this.doMoveTask(m.fromGroup, m.task, m.toGroup, m.before));
        break;
      case 'moveGroup':
        this.run(() => this.doMoveGroup(m.group, m.before));
        break;
      case 'openTask':
        this.openTask(m.group, m.task);
        break;
      case 'addTask':
        this.addTask(m.group);
        break;
      case 'addGroup':
        this.addGroup();
        break;
      case 'openConfig':
        this.openConfig();
        break;
      case 'setDue':
        this.setDue(m.group, m.task);
        break;
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Public operations (also used by context menu commands)

  refresh(): void {
    this.run(async () => undefined);
  }

  openTask(group: string, task: string): void {
    this.run(async () => {
      const uri = this.taskUri(group, task);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type & vscode.FileType.Directory) {
        await vscode.commands.executeCommand('revealInExplorer', uri);
      } else {
        await vscode.commands.executeCommand('vscode.open', uri, { preview: true });
      }
    }, false);
  }

  revealInExplorer(group: string, task?: string): void {
    const uri = task === undefined ? vscode.Uri.joinPath(this.root, group) : this.taskUri(group, task);
    void vscode.commands.executeCommand('revealInExplorer', uri);
  }

  openConfig(): void {
    this.run(async () => {
      try {
        await vscode.workspace.fs.stat(this.configUri);
      } catch {
        await this.writeConfig((await this.snapshot()).config);
      }
      await vscode.window.showTextDocument(this.configUri);
    }, false);
  }

  addGroup(): void {
    this.run(async () => {
      const snap = await this.snapshot();
      const current = new Set(snap.config.groups.map((g) => g.folder));
      const candidates = snap.folders.filter((f) => !current.has(f));
      const createItem: vscode.QuickPickItem = { label: `$(new-folder) ${t('Create new folder...')}`, alwaysShow: true };
      const items: vscode.QuickPickItem[] = [
        ...candidates.map((f) => ({ label: f, iconPath: vscode.ThemeIcon.Folder })),
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        createItem,
      ];
      const picked = await vscode.window.showQuickPick(items, {
        canPickMany: true,
        title: t('Add task groups'),
        placeHolder: t('Select folders to use as task groups'),
      });
      if (!picked || picked.length === 0) {
        return;
      }
      const folders = picked.filter((p) => p !== createItem && p.kind !== vscode.QuickPickItemKind.Separator).map((p) => p.label);
      if (picked.includes(createItem)) {
        const name = await vscode.window.showInputBox({
          title: t('New task group'),
          prompt: t('Folder name'),
          validateInput: (v) => this.validateNewName(v, snap.folders.concat(snap.config.groups.map((g) => g.folder))),
        });
        if (name) {
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(this.root, name.trim()));
          folders.push(name.trim());
        }
      }
      if (folders.length > 0) {
        await this.writeConfig(addGroups(normalize(snap.config, snap.scan), folders));
      }
    });
  }

  removeGroup(group: string): void {
    this.run(async () => {
      const ok = t('Remove');
      const answer = await vscode.window.showWarningMessage(
        t('Remove "{0}" from the board? The folder and its files are not deleted.', group),
        { modal: true },
        ok,
      );
      if (answer !== ok) {
        return;
      }
      const snap = await this.snapshot();
      await this.writeConfig(removeGroup(normalize(snap.config, snap.scan), group));
    });
  }

  renameGroup(group: string): void {
    this.run(async () => {
      const snap = await this.snapshot();
      const name = await vscode.window.showInputBox({
        title: t('Rename task group'),
        value: group,
        validateInput: (v) => (v.trim() === group ? undefined : this.validateNewName(v, snap.folders)),
      });
      if (!name || name.trim() === group) {
        return;
      }
      const newName = name.trim();
      await this.rename(vscode.Uri.joinPath(this.root, group), vscode.Uri.joinPath(this.root, newName));
      await this.writeConfig(renameGroup(normalize(snap.config, snap.scan), group, newName));
    });
  }

  addTask(group: string): void {
    this.run(async () => {
      const snap = await this.snapshot();
      const existing = (snap.scan.get(group) ?? []).map((e) => e.name);
      const ext = this.setting<string>('newTaskExtension', '.md');
      const input = await vscode.window.showInputBox({
        title: t('New task in "{0}"', group),
        prompt: t('Task name. End with "/" to create a folder.'),
        validateInput: (v) => this.validateNewName(newTaskName(v, ext).name, existing),
      });
      if (!input) {
        return;
      }
      const { name, isDir } = newTaskName(input, ext);
      const uri = this.taskUri(group, name);
      if (isDir) {
        await vscode.workspace.fs.createDirectory(uri);
      } else {
        const content = /\.(md|markdown)$/i.test(name) ? `# ${name.replace(/\.[^.]+$/, '')}\n` : '';
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
      }
      await this.writeConfig(addTask(normalize(snap.config, snap.scan), group, name));
      if (!isDir) {
        await vscode.window.showTextDocument(uri, { preview: false, viewColumn: vscode.ViewColumn.Beside });
      }
    });
  }

  renameTask(group: string, task: string): void {
    this.run(async () => {
      const snap = await this.snapshot();
      const existing = (snap.scan.get(group) ?? []).map((e) => e.name);
      const dot = task.lastIndexOf('.');
      const name = await vscode.window.showInputBox({
        title: t('Rename task'),
        value: task,
        valueSelection: [0, dot > 0 ? dot : task.length],
        validateInput: (v) => (v.trim() === task ? undefined : this.validateNewName(v, existing)),
      });
      if (!name || name.trim() === task) {
        return;
      }
      const newName = name.trim();
      await this.rename(this.taskUri(group, task), this.taskUri(group, newName));
      await this.writeConfig(renameTask(normalize(snap.config, snap.scan), group, task, newName));
    });
  }

  deleteTask(group: string, task: string): void {
    this.run(async () => {
      const ok = t('Move to Trash');
      const answer = await vscode.window.showWarningMessage(t('Delete task "{0}"?', task), { modal: true }, ok);
      if (answer !== ok) {
        return;
      }
      const uri = this.taskUri(group, task);
      try {
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: true });
      } catch {
        // Some file systems (e.g. remote) have no trash.
        await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
      }
      const snap = await this.snapshot();
      await this.writeConfig(removeTask(normalize(snap.config, snap.scan), group, task));
    });
  }

  setDue(group: string, task: string): void {
    this.run(async () => {
      const snap = await this.snapshot();
      const config = normalize(snap.config, snap.scan);
      const current = config.groups.find((g) => g.folder === group)?.tasks.find((x) => x.name === task)?.due;
      const today = new Date();
      const days = (n: number) => formatDue(new Date(today.getFullYear(), today.getMonth(), today.getDate() + n), false);
      type Item = vscode.QuickPickItem & { due?: string; action?: 'input' | 'clear' };
      const items: Item[] = [
        { label: `$(calendar) ${t('Today')}`, description: days(0), due: days(0) },
        { label: `$(calendar) ${t('Tomorrow')}`, description: days(1), due: days(1) },
        { label: `$(calendar) ${t('In a week')}`, description: days(7), due: days(7) },
        { label: `$(edit) ${t('Enter date and time...')}`, action: 'input' },
      ];
      if (current) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator }, { label: `$(close) ${t('Clear due date')}`, action: 'clear' });
      }
      const picked = await vscode.window.showQuickPick(items, {
        title: t('Due date of "{0}"', task),
        placeHolder: current ? t('Current: {0}', current.replace('T', ' ')) : t('No due date'),
      });
      if (!picked) {
        return;
      }
      let due: string | undefined = picked.due;
      if (picked.action === 'input') {
        const input = await vscode.window.showInputBox({
          title: t('Due date of "{0}"', task),
          prompt: t('YYYY-MM-DD or YYYY-MM-DD HH:mm. Leave empty to clear.'),
          value: (current ?? days(0)).replace('T', ' '),
          validateInput: (v) => (v.trim() === '' || parseDue(v) ? undefined : t('Enter a date as YYYY-MM-DD or YYYY-MM-DD HH:mm.')),
        });
        if (input === undefined) {
          return;
        }
        due = input.trim() === '' ? undefined : parseDue(input);
      }
      await this.writeConfig(setDue(config, group, task, due));
    });
  }

  clearDue(group: string, task: string): void {
    this.run(async () => {
      const snap = await this.snapshot();
      await this.writeConfig(setDue(normalize(snap.config, snap.scan), group, task, undefined));
    });
  }

  // ---------------------------------------------------------------------------------------------
  // Drag & drop

  private async doMoveTask(fromGroup: string, task: string, toGroup: string, before: string | null): Promise<void> {
    const snap = await this.snapshot();
    const config = normalize(snap.config, snap.scan);
    if (!snap.scan.get(fromGroup)?.some((e) => e.name === task)) {
      throw new Error(t('Task "{0}" no longer exists.', task));
    }
    if (!snap.scan.has(toGroup)) {
      throw new Error(t('Task group "{0}" no longer exists.', toGroup));
    }
    if (fromGroup !== toGroup) {
      if (snap.scan.get(toGroup)!.some((e) => e.name === task)) {
        throw new Error(t('"{0}" already exists in "{1}".', task, toGroup));
      }
      // Write the new order first, so that the watcher refresh shows the task at the right place.
      await this.writeConfig(moveTask(config, fromGroup, task, toGroup, before));
      try {
        await this.rename(this.taskUri(fromGroup, task), this.taskUri(toGroup, task));
      } catch (e) {
        await this.writeConfig(config);
        throw e;
      }
    } else {
      await this.writeConfig(moveTask(config, fromGroup, task, toGroup, before));
    }
  }

  private async doMoveGroup(group: string, before: string | null): Promise<void> {
    const snap = await this.snapshot();
    await this.writeConfig(moveGroup(normalize(snap.config, snap.scan), group, before));
  }

  // ---------------------------------------------------------------------------------------------
  // Helpers

  /** Serializes operations, shows errors, and refreshes the board afterwards. */
  private run(op: () => Promise<unknown>, refreshAfter = true): void {
    this.queue = this.queue
      .then(op)
      .catch((e: unknown) => {
        void vscode.window.showErrorMessage(e instanceof Error ? e.message : String(e));
      })
      .then(() => (refreshAfter ? this.postState() : undefined))
      .catch(() => undefined);
  }

  private scheduleRefresh(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => this.refresh(), 150);
  }

  private async postState(): Promise<void> {
    const state: BoardState = {
      root: this.root.toString(),
      rootName: titleFor(this.root),
      groups: [],
      locale: vscode.env.language,
      strings: webviewStrings(),
    };
    try {
      const snap = await this.snapshot();
      state.groups = buildView(snap.config, snap.scan);
    } catch (e) {
      state.error = e instanceof Error ? e.message : String(e);
    }
    const message: ToWebview = { type: 'state', state };
    await this.panel.webview.postMessage(message);
  }

  private async readConfig(): Promise<BoardConfig> {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(this.configUri);
    } catch {
      return emptyConfig();
    }
    try {
      return parseConfig(new TextDecoder().decode(bytes));
    } catch (e) {
      throw new ConfigError(`${CONFIG_FILE_NAME}: ${(e as Error).message}`);
    }
  }

  private async writeConfig(config: BoardConfig): Promise<void> {
    try {
      const current = await this.readConfig();
      if (configsEqual(current, config) && (await exists(this.configUri))) {
        return;
      }
    } catch {
      // Overwrite a broken config only via explicit user edits, never silently.
      throw new Error(t('Fix {0} before changing the board.', CONFIG_FILE_NAME));
    }
    await vscode.workspace.fs.writeFile(this.configUri, new TextEncoder().encode(serializeConfig(config)));
  }

  private async snapshot(): Promise<Snapshot> {
    const config = await this.readConfig();
    const exclude = this.setting<string[]>('exclude', []);
    const rootEntries = await readDir(this.root);
    const folders = rootEntries.filter((e) => e.isDir && !isHidden(e.name, exclude)).map((e) => e.name);
    const folderSet = new Set(rootEntries.filter((e) => e.isDir).map((e) => e.name));
    const scan = new Map<string, Entry[]>();
    await Promise.all(
      config.groups
        .filter((g) => folderSet.has(g.folder))
        .map(async (g) => {
          const entries = await readDir(vscode.Uri.joinPath(this.root, g.folder));
          scan.set(
            g.folder,
            entries.filter((e) => !isHidden(e.name, exclude)),
          );
        }),
    );
    return { config, scan, folders };
  }

  private async rename(from: vscode.Uri, to: vscode.Uri): Promise<void> {
    if (await exists(to)) {
      throw new Error(t('"{0}" already exists.', vscode.workspace.asRelativePath(to)));
    }
    // A WorkspaceEdit keeps open editors in sync with the moved file.
    const edit = new vscode.WorkspaceEdit();
    edit.renameFile(from, to, { overwrite: false });
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error(t('Failed to move "{0}".', vscode.workspace.asRelativePath(from)));
    }
  }

  private validateNewName(value: string, existing: string[]): string | undefined {
    const name = value.trim();
    const error = validateName(name);
    if (error) {
      return t(error);
    }
    if (existing.some((e) => e.toLowerCase() === name.toLowerCase())) {
      return t('"{0}" already exists.', name);
    }
    return undefined;
  }

  private taskUri(group: string, task: string): vscode.Uri {
    return vscode.Uri.joinPath(this.root, group, task);
  }

  private setting<T>(key: string, fallback: T): T {
    return vscode.workspace.getConfiguration('folderKanban', this.root).get<T>(key, fallback);
  }

  private html(): string {
    const webview = this.panel.webview;
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'board.css'));
    return `<!DOCTYPE html>
<html lang="${vscode.env.language}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>Folder Kanban</title>
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function titleFor(root: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(root);
  if (folder && folder.uri.toString() === root.toString()) {
    return folder.name;
  }
  return root.path.split('/').filter(Boolean).pop() ?? root.toString();
}

async function readDir(uri: vscode.Uri): Promise<Entry[]> {
  const entries = await vscode.workspace.fs.readDirectory(uri);
  return entries.map(([name, type]) => ({ name, isDir: (type & vscode.FileType.Directory) !== 0 }));
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
