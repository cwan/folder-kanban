import * as vscode from 'vscode';
import { BoardPanel } from '../../src/boardPanel';
export { BoardsViewProvider } from '../../src/boardsView';
export * as mock from 'vscode';

export function open(extensionPath: string, root: string) {
  const ctx = { extensionUri: vscode.Uri.file(extensionPath), subscriptions: [] } as unknown as vscode.ExtensionContext;
  return BoardPanel.show(ctx, vscode.Uri.file(root));
}
