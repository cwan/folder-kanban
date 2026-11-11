/**
 * Pure board model. No dependency on the `vscode` module so that it can be unit-tested with Node.
 *
 * The board is stored in `<root>/.folder-kanban.json`:
 *
 * {
 *   "groups": [
 *     { "folder": "ToDo",  "tasks": ["b.md", "a.md"] },
 *     { "folder": "Doing", "tasks": [] }
 *   ]
 * }
 *
 * - `groups` decides which direct sub folders of the root are task groups, and their order.
 * - `tasks` decides the order of the tasks (direct children of the group folder).
 *   Entries that exist on disk but are not listed are appended at the end (natural sort order).
 *   Listed entries that no longer exist on disk are dropped when the board is normalized.
 */

export const CONFIG_FILE_NAME = '.folder-kanban.json';

export interface GroupConfig {
  folder: string;
  tasks: string[];
}

export interface BoardConfig {
  groups: GroupConfig[];
}

export interface Entry {
  name: string;
  isDir: boolean;
}

export interface GroupView {
  folder: string;
  tasks: Entry[];
}

export class ConfigError extends Error {}

export function emptyConfig(): BoardConfig {
  return { groups: [] };
}

export function parseConfig(text: string): BoardConfig {
  if (text.trim() === '') {
    return emptyConfig();
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`Invalid JSON: ${(e as Error).message}`);
  }
  if (!isObject(raw)) {
    throw new ConfigError('The root of the config must be an object.');
  }
  const groupsRaw = raw.groups ?? [];
  if (!Array.isArray(groupsRaw)) {
    throw new ConfigError('"groups" must be an array.');
  }
  const groups: GroupConfig[] = [];
  const seen = new Set<string>();
  for (const g of groupsRaw) {
    // A plain string is accepted as a shorthand for { folder, tasks: [] }.
    const folder = typeof g === 'string' ? g : isObject(g) ? g.folder : undefined;
    if (typeof folder !== 'string' || validateName(folder) !== undefined) {
      throw new ConfigError(`Invalid group folder: ${JSON.stringify(folder)}`);
    }
    if (seen.has(folder)) {
      continue;
    }
    seen.add(folder);
    const tasksRaw = isObject(g) ? g.tasks ?? [] : [];
    if (!Array.isArray(tasksRaw)) {
      throw new ConfigError(`"tasks" of group "${folder}" must be an array.`);
    }
    groups.push({ folder, tasks: unique(tasksRaw.filter((t): t is string => typeof t === 'string')) });
  }
  return { groups };
}

export function serializeConfig(config: BoardConfig): string {
  return JSON.stringify({ groups: config.groups }, null, 2) + '\n';
}

export function compareNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * Builds the board as displayed. `scan` maps a group folder name to its entries,
 * or `undefined` if the folder does not exist (such groups are not displayed).
 */
export function buildView(config: BoardConfig, scan: ReadonlyMap<string, Entry[]>): GroupView[] {
  const view: GroupView[] = [];
  for (const group of config.groups) {
    const entries = scan.get(group.folder);
    if (!entries) {
      continue;
    }
    const byName = new Map(entries.map((e) => [e.name, e]));
    const ordered: Entry[] = [];
    for (const name of group.tasks) {
      const entry = byName.get(name);
      if (entry) {
        ordered.push(entry);
        byName.delete(name);
      }
    }
    const rest = [...byName.values()].sort((a, b) => compareNames(a.name, b.name));
    view.push({ folder: group.folder, tasks: [...ordered, ...rest] });
  }
  return view;
}

/**
 * Returns a config whose task lists reflect exactly what is displayed.
 * Groups whose folder is missing are kept untouched so that they come back when the folder reappears.
 */
export function normalize(config: BoardConfig, scan: ReadonlyMap<string, Entry[]>): BoardConfig {
  const view = new Map(buildView(config, scan).map((g) => [g.folder, g]));
  return {
    groups: config.groups.map((g) => {
      const v = view.get(g.folder);
      return v ? { folder: g.folder, tasks: v.tasks.map((t) => t.name) } : cloneGroup(g);
    }),
  };
}

function findGroup(config: BoardConfig, folder: string): GroupConfig {
  const g = config.groups.find((x) => x.folder === folder);
  if (!g) {
    throw new Error(`Unknown group: ${folder}`);
  }
  return g;
}

function insertBefore(list: string[], item: string, before: string | null | undefined): void {
  const idx = before == null ? -1 : list.indexOf(before);
  if (idx < 0) {
    list.push(item);
  } else {
    list.splice(idx, 0, item);
  }
}

/** Moves a task within a group or into another group, placing it before `before` (or at the end). */
export function moveTask(
  config: BoardConfig,
  fromGroup: string,
  task: string,
  toGroup: string,
  before: string | null,
): BoardConfig {
  const next = cloneConfig(config);
  const from = findGroup(next, fromGroup);
  const to = findGroup(next, toGroup);
  from.tasks = from.tasks.filter((t) => t !== task);
  to.tasks = to.tasks.filter((t) => t !== task);
  insertBefore(to.tasks, task, before === task ? null : before);
  return next;
}

/** Moves a group before `before` (or to the end). */
export function moveGroup(config: BoardConfig, folder: string, before: string | null): BoardConfig {
  const next = cloneConfig(config);
  const group = findGroup(next, folder);
  const rest = next.groups.filter((g) => g !== group);
  const idx = before == null || before === folder ? -1 : rest.findIndex((g) => g.folder === before);
  if (idx < 0) {
    rest.push(group);
  } else {
    rest.splice(idx, 0, group);
  }
  next.groups = rest;
  return next;
}

export function addGroups(config: BoardConfig, folders: string[]): BoardConfig {
  const next = cloneConfig(config);
  for (const folder of folders) {
    if (!next.groups.some((g) => g.folder === folder)) {
      next.groups.push({ folder, tasks: [] });
    }
  }
  return next;
}

export function removeGroup(config: BoardConfig, folder: string): BoardConfig {
  return { groups: config.groups.filter((g) => g.folder !== folder).map(cloneGroup) };
}

export function renameGroup(config: BoardConfig, oldName: string, newName: string): BoardConfig {
  const next = cloneConfig(config);
  findGroup(next, oldName).folder = newName;
  return next;
}

export function addTask(config: BoardConfig, folder: string, task: string, before: string | null = null): BoardConfig {
  const next = cloneConfig(config);
  const g = findGroup(next, folder);
  g.tasks = g.tasks.filter((t) => t !== task);
  insertBefore(g.tasks, task, before);
  return next;
}

export function renameTask(config: BoardConfig, folder: string, oldName: string, newName: string): BoardConfig {
  const next = cloneConfig(config);
  const g = findGroup(next, folder);
  g.tasks = g.tasks.filter((t) => t !== newName).map((t) => (t === oldName ? newName : t));
  return next;
}

export function removeTask(config: BoardConfig, folder: string, task: string): BoardConfig {
  const next = cloneConfig(config);
  const g = findGroup(next, folder);
  g.tasks = g.tasks.filter((t) => t !== task);
  return next;
}

export function configsEqual(a: BoardConfig, b: BoardConfig): boolean {
  return serializeConfig(a) === serializeConfig(b);
}

const INVALID_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

/** Returns an error message if `name` is not usable as a single file/folder name, otherwise `undefined`. */
export function validateName(name: string): string | undefined {
  if (name.trim() === '') {
    return 'Name must not be empty.';
  }
  if (name === '.' || name === '..') {
    return 'Name must not be "." or "..".';
  }
  if (INVALID_CHARS.test(name)) {
    return 'Name must not contain any of < > : " / \\ | ? *';
  }
  if (/[. ]$/.test(name)) {
    return 'Name must not end with a dot or a space.';
  }
  return undefined;
}

/**
 * Turns user input for a new task into a file or folder name.
 * A trailing "/" creates a folder; a name without extension gets `defaultExtension`.
 */
export function newTaskName(input: string, defaultExtension: string): { name: string; isDir: boolean } {
  const trimmed = input.trim();
  if (/[/\\]$/.test(trimmed)) {
    return { name: trimmed.replace(/[/\\]+$/, '').trim(), isDir: true };
  }
  const hasExtension = /\.[^.\s]+$/.test(trimmed) && !trimmed.startsWith('.');
  if (hasExtension || defaultExtension === '') {
    return { name: trimmed, isDir: false };
  }
  const ext = defaultExtension.startsWith('.') ? defaultExtension : `.${defaultExtension}`;
  return { name: trimmed + ext, isDir: false };
}

export function isHidden(name: string, exclude: readonly string[]): boolean {
  return name.startsWith('.') || exclude.includes(name);
}

function cloneGroup(g: GroupConfig): GroupConfig {
  return { folder: g.folder, tasks: [...g.tasks] };
}

function cloneConfig(c: BoardConfig): BoardConfig {
  return { groups: c.groups.map(cloneGroup) };
}

function unique<T>(list: T[]): T[] {
  return [...new Set(list)];
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
