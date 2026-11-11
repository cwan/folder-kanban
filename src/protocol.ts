/** Messages exchanged between the extension host and the board webview. */

import type { GroupView } from './board';

export interface BoardState {
  /** Board root folder URI (string form). Used to restore the panel after a reload. */
  root: string;
  rootName: string;
  groups: GroupView[];
  /** Set when the config file cannot be read. */
  error?: string;
  strings: Record<string, string>;
}

export type ToWebview = { type: 'state'; state: BoardState };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'moveTask'; fromGroup: string; task: string; toGroup: string; before: string | null }
  | { type: 'moveGroup'; group: string; before: string | null }
  | { type: 'openTask'; group: string; task: string }
  | { type: 'addTask'; group: string }
  | { type: 'addGroup' }
  | { type: 'openConfig' };

/** Value of the `data-vscode-context` attribute, passed to `webview/context` menu commands. */
export interface WebviewMenuContext {
  webviewSection: 'board' | 'group' | 'task';
  root: string;
  group?: string;
  task?: string;
}
