/**
 * Pure board model. No dependency on the `vscode` module so that it can be unit-tested with Node.
 *
 * The board is stored in `<root>/.folder-kanban.json`:
 *
 * {
 *   "groups": [
 *     {
 *       "folder": "ToDo",
 *       "tasks": [
 *         { "name": "b.md", "due": "2026-11-20T18:00" },
 *         { "name": "a.md" }
 *       ]
 *     },
 *     { "folder": "Doing", "tasks": [] }
 *   ]
 * }
 *
 * - `groups` decides which direct sub folders of the root are task groups, and their order.
 * - `tasks` decides the order of the tasks (direct children of the group folder) and holds their
 *   meta data. `due` is a local date ("YYYY-MM-DD") or date and time ("YYYY-MM-DDTHH:mm").
 *   Entries that exist on disk but are not listed are appended at the end (natural sort order).
 *   Listed entries that no longer exist on disk are dropped when the board is normalized.
 */

export const CONFIG_FILE_NAME = '.folder-kanban.json';

export interface TaskMeta {
  /** Due date: "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" (local time). */
  due?: string;
}

export interface TaskConfig extends TaskMeta {
  name: string;
}

export interface GroupConfig {
  folder: string;
  tasks: TaskConfig[];
}

export interface BoardConfig {
  groups: GroupConfig[];
}

export interface Entry {
  name: string;
  isDir: boolean;
}

export interface TaskView extends Entry, TaskMeta {}

export interface GroupView {
  folder: string;
  tasks: TaskView[];
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
    groups.push({ folder, tasks: parseTasks(folder, tasksRaw) });
  }
  return { groups };
}

function parseTasks(folder: string, raw: unknown[]): TaskConfig[] {
  const tasks: TaskConfig[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    // A plain string is accepted as a shorthand for { name }.
    const name = typeof item === 'string' ? item : isObject(item) ? item.name : undefined;
    if (typeof name !== 'string') {
      throw new ConfigError(`Invalid task in group "${folder}": ${JSON.stringify(item)}`);
    }
    if (seen.has(name)) {
      continue;
    }
    seen.add(name);
    const task: TaskConfig = { name };
    const due = isObject(item) ? item.due : undefined;
    if (due !== undefined && due !== null && due !== '') {
      const parsed = typeof due === 'string' ? parseDue(due) : undefined;
      if (!parsed) {
        throw new ConfigError(`Invalid due of task "${name}" in group "${folder}": ${JSON.stringify(due)}`);
      }
      task.due = parsed;
    }
    tasks.push(task);
  }
  return tasks;
}

/** Serializes the config with one line per task, which keeps diffs small and the file readable. */
export function serializeConfig(config: BoardConfig): string {
  if (config.groups.length === 0) {
    return '{\n  "groups": []\n}\n';
  }
  const groups = config.groups.map((g) => {
    const tasks =
      g.tasks.length === 0
        ? '[]'
        : `[\n${g.tasks.map((t) => `        ${JSON.stringify(t.due ? { name: t.name, due: t.due } : { name: t.name })}`).join(',\n')}\n      ]`;
    return `    {\n      "folder": ${JSON.stringify(g.folder)},\n      "tasks": ${tasks}\n    }`;
  });
  return `{\n  "groups": [\n${groups.join(',\n')}\n  ]\n}\n`;
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
    const ordered: TaskView[] = [];
    for (const task of group.tasks) {
      const entry = byName.get(task.name);
      if (entry) {
        ordered.push(task.due ? { ...entry, due: task.due } : { ...entry });
        byName.delete(task.name);
      }
    }
    const rest = [...byName.values()].sort((a, b) => compareNames(a.name, b.name)).map((e) => ({ ...e }));
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
      return v ? { folder: g.folder, tasks: v.tasks.map((t) => (t.due ? { name: t.name, due: t.due } : { name: t.name })) } : cloneGroup(g);
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

function insertBefore(list: TaskConfig[], item: TaskConfig, before: string | null | undefined): void {
  const idx = before == null ? -1 : list.findIndex((t) => t.name === before);
  if (idx < 0) {
    list.push(item);
  } else {
    list.splice(idx, 0, item);
  }
}

/** Moves a task within a group or into another group, placing it before `before` (or at the end). Meta data moves with it. */
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
  const item = from.tasks.find((t) => t.name === task) ?? { name: task };
  from.tasks = from.tasks.filter((t) => t.name !== task);
  to.tasks = to.tasks.filter((t) => t.name !== task);
  insertBefore(to.tasks, item, before === task ? null : before);
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
  g.tasks = g.tasks.filter((t) => t.name !== task);
  insertBefore(g.tasks, { name: task }, before);
  return next;
}

export function renameTask(config: BoardConfig, folder: string, oldName: string, newName: string): BoardConfig {
  const next = cloneConfig(config);
  const g = findGroup(next, folder);
  g.tasks = g.tasks.filter((t) => t.name !== newName).map((t) => (t.name === oldName ? { ...t, name: newName } : t));
  return next;
}

export function removeTask(config: BoardConfig, folder: string, task: string): BoardConfig {
  const next = cloneConfig(config);
  const g = findGroup(next, folder);
  g.tasks = g.tasks.filter((t) => t.name !== task);
  return next;
}

/** Sets (or with `undefined`, clears) the due date of a task. The task is appended if it is not listed yet. */
export function setDue(config: BoardConfig, folder: string, task: string, due: string | undefined): BoardConfig {
  const next = cloneConfig(config);
  const g = findGroup(next, folder);
  let item = g.tasks.find((t) => t.name === task);
  if (!item) {
    item = { name: task };
    g.tasks.push(item);
  }
  if (due === undefined) {
    delete item.due;
  } else {
    item.due = due;
  }
  return next;
}

// -------------------------------------------------------------------------------------------------
// Due dates

/**
 * Parses user input such as "2026-11-20", "2026/11/20 18:00" or "2026-11-20T9:05" into the canonical
 * form ("YYYY-MM-DD" or "YYYY-MM-DDTHH:mm"). Returns `undefined` for invalid input.
 */
export function parseDue(input: string): string | undefined {
  const m = /^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2}))?\s*$/.exec(input);
  if (!m) {
    return undefined;
  }
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
    return undefined;
  }
  const day = `${m[1]}-${pad(mo)}-${pad(d)}`;
  if (m[4] === undefined) {
    return day;
  }
  const [h, mi] = [Number(m[4]), Number(m[5])];
  if (h > 23 || mi > 59) {
    return undefined;
  }
  return `${day}T${pad(h)}:${pad(mi)}`;
}

/** Formats a local date as a canonical due value. */
export function formatDue(date: Date, withTime: boolean): string {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return withTime ? `${day}T${pad(date.getHours())}:${pad(date.getMinutes())}` : day;
}

export function dueHasTime(due: string): boolean {
  return due.includes('T');
}

/** The moment the task becomes overdue: the given time, or the end of the day for date-only values. */
export function dueDeadline(due: string): Date {
  const [day, time] = due.split('T');
  const [y, mo, d] = day.split('-').map(Number);
  if (time) {
    const [h, mi] = time.split(':').map(Number);
    return new Date(y, mo - 1, d, h, mi);
  }
  return new Date(y, mo - 1, d + 1);
}

export type DueStatus = 'overdue' | 'soon' | 'later';

/** "overdue" after the deadline, "soon" within 24 hours before it (or on the due day), otherwise "later". */
export function dueStatus(due: string, now: Date): DueStatus {
  const deadline = dueDeadline(due).getTime();
  if (now.getTime() >= deadline) {
    return 'overdue';
  }
  return deadline - now.getTime() <= 24 * 60 * 60 * 1000 ? 'soon' : 'later';
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
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
  return { folder: g.folder, tasks: g.tasks.map((t) => ({ ...t })) };
}

function cloneConfig(c: BoardConfig): BoardConfig {
  return { groups: c.groups.map(cloneGroup) };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
