import * as vscode from 'vscode';
import { CONFIG_FILE_NAME } from './board';
import { BoardPanel, VIEW_TYPE } from './boardPanel';
import type { WebviewMenuContext } from './protocol';

const t = vscode.l10n.t;

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('folderKanban.openBoard', async (uri?: vscode.Uri) => {
      const root = await resolveRoot(uri);
      if (root) {
        BoardPanel.show(context, root);
      }
    }),

    // Commands below are invoked from the board's context menu (or from the webview).
    menuCommand('folderKanban.refresh', (p) => p.refresh()),
    menuCommand('folderKanban.addGroup', (p) => p.addGroup()),
    menuCommand('folderKanban.openConfig', (p) => p.openConfig()),
    menuCommand('folderKanban.addTask', (p, c) => c.group !== undefined && p.addTask(c.group)),
    menuCommand('folderKanban.removeGroup', (p, c) => c.group !== undefined && p.removeGroup(c.group)),
    menuCommand('folderKanban.renameGroup', (p, c) => c.group !== undefined && p.renameGroup(c.group)),
    menuCommand('folderKanban.openTask', (p, c) => c.group !== undefined && c.task !== undefined && p.openTask(c.group, c.task)),
    menuCommand('folderKanban.renameTask', (p, c) => c.group !== undefined && c.task !== undefined && p.renameTask(c.group, c.task)),
    menuCommand('folderKanban.setDue', (p, c) => c.group !== undefined && c.task !== undefined && p.setDue(c.group, c.task)),
    menuCommand('folderKanban.clearDue', (p, c) => c.group !== undefined && c.task !== undefined && p.clearDue(c.group, c.task)),
    menuCommand('folderKanban.deleteTask', (p, c) => c.group !== undefined && c.task !== undefined && p.deleteTask(c.group, c.task)),
    menuCommand('folderKanban.revealInExplorer', (p, c) => c.group !== undefined && p.revealInExplorer(c.group, c.task)),

    vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown) {
        const root = (state as { root?: unknown } | undefined)?.root;
        if (typeof root !== 'string') {
          panel.dispose();
          return;
        }
        BoardPanel.revive(context, panel, vscode.Uri.parse(root));
      },
    }),
  );
}

export function deactivate(): void {}

function menuCommand(id: string, fn: (panel: BoardPanel, ctx: WebviewMenuContext) => unknown): vscode.Disposable {
  return vscode.commands.registerCommand(id, (ctx?: WebviewMenuContext) => {
    const panel = ctx?.root ? BoardPanel.get(ctx.root) : BoardPanel.active;
    if (panel) {
      fn(panel, ctx ?? { webviewSection: 'board', root: panel.root.toString() });
    }
  });
}

/** Decides which folder is the board root. */
async function resolveRoot(uri: vscode.Uri | undefined): Promise<vscode.Uri | undefined> {
  if (uri) {
    if (uri.path.endsWith(`/${CONFIG_FILE_NAME}`)) {
      return vscode.Uri.joinPath(uri, '..');
    }
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type & vscode.FileType.Directory ? uri : vscode.Uri.joinPath(uri, '..');
  }

  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      openLabel: t('Open as board'),
    });
    return picked?.[0];
  }

  const candidates = folders.map((f) => {
    const rel = vscode.workspace.getConfiguration('folderKanban', f.uri).get<string>('boardRoot', '').trim();
    return { folder: f, root: rel ? vscode.Uri.joinPath(f.uri, rel) : f.uri, rel };
  });
  if (candidates.length === 1) {
    return candidates[0].root;
  }
  const picked = await vscode.window.showQuickPick(
    candidates.map((c) => ({ label: c.folder.name, description: c.rel, root: c.root })),
    { placeHolder: t('Select the folder to open as a board') },
  );
  return picked?.root;
}
