import * as vscode from 'vscode';
import { CONFIG_FILE_NAME } from './board';

const t = vscode.l10n.t;

export const BOARDS_VIEW_ID = 'folderKanban.boards';

interface BoardItem {
  root: vscode.Uri;
  /** Whether `.folder-kanban.json` exists in the root. */
  configured: boolean;
}

/**
 * Lists the boards of the workspace in the activity bar view: the default root of each workspace
 * folder (`folderKanban.boardRoot`) and every folder that contains a `.folder-kanban.json`.
 */
export class BoardsViewProvider implements vscode.TreeDataProvider<BoardItem>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher(`**/${CONFIG_FILE_NAME}`, false, true, false);
    this.disposables.push(
      this.changed,
      watcher,
      watcher.onDidCreate(() => this.refresh()),
      watcher.onDidDelete(() => this.refresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('folderKanban.boardRoot')) {
          this.refresh();
        }
      }),
    );
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
  }

  refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.changed.fire(), 200);
  }

  async getChildren(element?: BoardItem): Promise<BoardItem[]> {
    if (element) {
      return [];
    }
    const items = new Map<string, BoardItem>();

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const rel = vscode.workspace.getConfiguration('folderKanban', folder.uri).get<string>('boardRoot', '').trim();
      const root = rel ? vscode.Uri.joinPath(folder.uri, rel) : folder.uri;
      items.set(root.toString(), { root, configured: false });
    }

    const configs = await vscode.workspace.findFiles(`**/${CONFIG_FILE_NAME}`, '**/node_modules/**', 500);
    for (const uri of configs) {
      const root = vscode.Uri.joinPath(uri, '..');
      items.set(root.toString(), { root, configured: true });
    }

    // Default roots may have a config that findFiles skipped (e.g. excluded by files.exclude).
    await Promise.all(
      [...items.values()]
        .filter((i) => !i.configured)
        .map(async (i) => {
          try {
            await vscode.workspace.fs.stat(vscode.Uri.joinPath(i.root, CONFIG_FILE_NAME));
            i.configured = true;
          } catch {
            // Not configured yet.
          }
        }),
    );

    return [...items.values()].sort((a, b) => label(a.root).localeCompare(label(b.root), undefined, { numeric: true }));
  }

  getTreeItem(item: BoardItem): vscode.TreeItem {
    const tree = new vscode.TreeItem(name(item.root), vscode.TreeItemCollapsibleState.None);
    const isFolderRoot = vscode.workspace.getWorkspaceFolder(item.root)?.uri.toString() === item.root.toString();
    const path = isFolderRoot ? undefined : label(item.root);
    tree.description = item.configured ? path : [path, t('not set up')].filter(Boolean).join(' · ');
    tree.tooltip = new vscode.MarkdownString(
      `**${name(item.root)}**\n\n${item.root.fsPath}${item.configured ? '' : `\n\n${t('No {0} yet. It is created when you add task groups.', CONFIG_FILE_NAME)}`}`,
    );
    tree.iconPath = new vscode.ThemeIcon('project');
    tree.resourceUri = item.root;
    tree.contextValue = 'board';
    tree.command = { command: 'folderKanban.openBoard', title: t('Open Board'), arguments: [item.root] };
    return tree;
  }
}

function name(root: vscode.Uri): string {
  const folder = vscode.workspace.getWorkspaceFolder(root);
  if (folder && folder.uri.toString() === root.toString()) {
    return folder.name;
  }
  return root.path.split('/').filter(Boolean).pop() ?? root.toString();
}

/** Path shown next to the name: relative to the workspace (with the folder name in multi-root workspaces). */
function label(root: vscode.Uri): string {
  return vscode.workspace.asRelativePath(root, (vscode.workspace.workspaceFolders?.length ?? 0) > 1);
}
