import type { Entry, GroupView } from '../board';
import type { BoardState, FromWebview, ToWebview, WebviewMenuContext } from '../protocol';

interface VsCodeApi {
  postMessage(message: FromWebview): void;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();
const app = document.getElementById('app')!;

let state: BoardState | undefined;

type Drag =
  | { kind: 'task'; group: string; task: string; el: HTMLElement }
  | { kind: 'group'; group: string; el: HTMLElement };
let drag: Drag | undefined;

const FILE_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M4 1h5.5L13 4.5V14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1zm0 1v12h8V5H9V2H4zm6 .4V4h1.6L10 2.4z"/></svg>';
const FOLDER_ICON =
  '<svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M1.5 3h4.3l1.5 1.5h7.2a.5.5 0 0 1 .5.5v8a.5.5 0 0 1-.5.5h-13A.5.5 0 0 1 1 13V3.5a.5.5 0 0 1 .5-.5z"/></svg>';

const DRAG_MIME = 'application/x-folder-kanban';

const placeholder = el('div', 'card-placeholder');
const groupPlaceholder = el('div', 'group-placeholder');

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const msg = event.data;
  if (msg.type === 'state') {
    state = msg.state;
    vscode.setState({ root: state.root });
    if (!drag) {
      render();
    }
  }
});

vscode.postMessage({ type: 'ready' });

// -----------------------------------------------------------------------------------------------
// Rendering

function s(key: string): string {
  return state?.strings[key] ?? key;
}

function render(): void {
  if (!state) {
    return;
  }
  const scrollLeft = app.querySelector('.board')?.scrollLeft ?? 0;
  const listScroll = new Map<string, number>();
  app.querySelectorAll<HTMLElement>('.group').forEach((g) => {
    listScroll.set(g.dataset.group!, g.querySelector('.tasks')!.scrollTop);
  });

  app.replaceChildren();

  if (state.error) {
    const box = el('div', 'error');
    box.append(el('div', 'error-title', s('configError')), el('pre', 'error-message', state.error));
    const btn = button(s('openConfig'), 'secondary');
    btn.addEventListener('click', () => vscode.postMessage({ type: 'openConfig' }));
    box.append(btn);
    app.append(box);
    return;
  }

  const board = el('div', 'board');
  setContext(board, { webviewSection: 'board', root: state.root });
  for (const group of state.groups) {
    board.append(renderGroup(group));
  }

  const add = el('div', 'add-group');
  if (state.groups.length === 0) {
    add.append(el('p', 'hint', s('emptyBoard')));
  }
  const addBtn = button(`+ ${s('addGroup')}`, 'ghost');
  addBtn.addEventListener('click', () => vscode.postMessage({ type: 'addGroup' }));
  add.append(addBtn);
  board.append(add);

  board.addEventListener('dragover', onBoardDragOver);
  board.addEventListener('drop', onBoardDrop);

  app.append(board);
  board.scrollLeft = scrollLeft;
  board.querySelectorAll<HTMLElement>('.group').forEach((g) => {
    g.querySelector('.tasks')!.scrollTop = listScroll.get(g.dataset.group!) ?? 0;
  });
}

function renderGroup(group: GroupView): HTMLElement {
  const col = el('section', 'group');
  col.dataset.group = group.folder;
  setContext(col, { webviewSection: 'group', root: state!.root, group: group.folder });

  const header = el('header', 'group-header');
  header.draggable = true;
  header.title = group.folder;
  header.append(el('span', 'group-title', group.folder), el('span', 'group-count', String(group.tasks.length)));
  header.addEventListener('dragstart', (e) => {
    drag = { kind: 'group', group: group.folder, el: col };
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData(DRAG_MIME, JSON.stringify({ group: group.folder }));
    const rect = col.getBoundingClientRect();
    e.dataTransfer!.setDragImage(col, e.clientX - rect.left, e.clientY - rect.top);
    requestAnimationFrame(() => col.classList.add('dragging'));
  });
  header.addEventListener('dragend', endDrag);

  const list = el('div', 'tasks');
  for (const task of group.tasks) {
    list.append(renderTask(group.folder, task));
  }
  if (group.tasks.length === 0) {
    list.append(el('div', 'empty', s('emptyGroup')));
  }

  const footer = el('footer', 'group-footer');
  const addBtn = button(`+ ${s('addTask')}`, 'ghost');
  addBtn.addEventListener('click', () => vscode.postMessage({ type: 'addTask', group: group.folder }));
  footer.append(addBtn);

  col.append(header, list, footer);
  col.addEventListener('dragover', (e) => onGroupDragOver(e, col));
  col.addEventListener('drop', (e) => onGroupDrop(e, col));
  return col;
}

function renderTask(group: string, task: Entry): HTMLElement {
  const card = el('div', task.isDir ? 'card folder' : 'card');
  card.dataset.task = task.name;
  card.draggable = true;
  card.tabIndex = 0;
  card.title = `${group}/${task.name}`;
  setContext(card, { webviewSection: 'task', root: state!.root, group, task: task.name });

  const { stem, ext } = splitName(task);
  const icon = el('span', 'card-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.innerHTML = task.isDir ? FOLDER_ICON : FILE_ICON;
  card.append(icon, el('span', 'card-title', stem));
  if (ext) {
    card.append(el('span', 'card-ext', ext));
  }
  if (task.isDir) {
    card.setAttribute('aria-label', `${s('folder')}: ${task.name}`);
  }

  const open = () => vscode.postMessage({ type: 'openTask', group, task: task.name });
  card.addEventListener('click', open);
  card.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  });
  card.addEventListener('dragstart', (e) => {
    e.stopPropagation();
    drag = { kind: 'task', group, task: task.name, el: card };
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData(DRAG_MIME, JSON.stringify({ group, task: task.name }));
    requestAnimationFrame(() => card.classList.add('dragging'));
  });
  card.addEventListener('dragend', endDrag);
  return card;
}

function splitName(task: Entry): { stem: string; ext: string } {
  if (task.isDir) {
    return { stem: task.name, ext: '' };
  }
  const dot = task.name.lastIndexOf('.');
  return dot > 0 ? { stem: task.name.slice(0, dot), ext: task.name.slice(dot + 1) } : { stem: task.name, ext: '' };
}

// -----------------------------------------------------------------------------------------------
// Drag & drop

function onGroupDragOver(e: DragEvent, col: HTMLElement): void {
  if (drag?.kind !== 'task') {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  e.dataTransfer!.dropEffect = 'move';
  const list = col.querySelector<HTMLElement>('.tasks')!;
  const cards = [...list.querySelectorAll<HTMLElement>('.card')].filter((c) => c !== drag!.el);
  const next = cards.find((c) => {
    const r = c.getBoundingClientRect();
    return e.clientY < r.top + r.height / 2;
  });
  placeholder.style.height = `${drag.el.getBoundingClientRect().height}px`;
  if (next) {
    if (placeholder.nextElementSibling !== next) {
      list.insertBefore(placeholder, next);
    }
  } else {
    // Keep the "No tasks" label in the DOM: removing the element under the pointer cancels the drop.
    const end = list.querySelector('.empty');
    if (placeholder.nextElementSibling !== end || placeholder.parentElement !== list) {
      list.insertBefore(placeholder, end);
    }
  }
  list.scrollTop += edgeScroll(e.clientY, list.getBoundingClientRect().top, list.getBoundingClientRect().bottom);
}

function onGroupDrop(e: DragEvent, col: HTMLElement): void {
  if (drag?.kind !== 'task' || !placeholder.isConnected) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const toGroup = col.dataset.group!;
  const before = nextCard(placeholder)?.dataset.task ?? null;
  const { group: fromGroup, task, el: card } = drag;

  // Was it dropped where it already was?
  const unchanged = fromGroup === toGroup && (placeholder.previousElementSibling === card || nextCard(placeholder) === card);
  placeholder.replaceWith(card);
  if (!unchanged) {
    vscode.postMessage({ type: 'moveTask', fromGroup, task, toGroup, before });
  }
  endDrag();
}

function onBoardDragOver(e: DragEvent): void {
  if (drag?.kind !== 'group') {
    return;
  }
  e.preventDefault();
  e.dataTransfer!.dropEffect = 'move';
  const board = e.currentTarget as HTMLElement;
  const cols = [...board.querySelectorAll<HTMLElement>('.group')].filter((c) => c !== drag!.el);
  const next =
    cols.find((c) => {
      const r = c.getBoundingClientRect();
      return e.clientX < r.left + r.width / 2;
    }) ?? board.querySelector<HTMLElement>('.add-group')!;
  if (groupPlaceholder.nextElementSibling !== next) {
    board.insertBefore(groupPlaceholder, next);
  }
  groupPlaceholder.style.height = `${drag.el.getBoundingClientRect().height}px`;
  board.scrollLeft += edgeScroll(e.clientX, board.getBoundingClientRect().left, board.getBoundingClientRect().right);
}

function onBoardDrop(e: DragEvent): void {
  if (drag?.kind !== 'group' || !groupPlaceholder.isConnected) {
    return;
  }
  e.preventDefault();
  const { group, el: col } = drag;
  let next = groupPlaceholder.nextElementSibling as HTMLElement | null;
  if (next === col) {
    next = next.nextElementSibling as HTMLElement | null;
  }
  const before = next?.classList.contains('group') ? next.dataset.group! : null;
  const unchanged = groupPlaceholder.previousElementSibling === col || groupPlaceholder.nextElementSibling === col;
  groupPlaceholder.replaceWith(col);
  if (!unchanged) {
    vscode.postMessage({ type: 'moveGroup', group, before });
  }
  endDrag();
}

function endDrag(): void {
  if (!drag) {
    return;
  }
  drag.el.classList.remove('dragging');
  placeholder.remove();
  groupPlaceholder.remove();
  drag = undefined;
  // Re-render with the latest state (it may have arrived during the drag).
  render();
}

function nextCard(node: Element): HTMLElement | undefined {
  let n = node.nextElementSibling;
  while (n && !(n as HTMLElement).classList.contains('card')) {
    n = n.nextElementSibling;
  }
  return (n as HTMLElement | null) ?? undefined;
}

/** Scroll speed when dragging close to the edge of a scroll container. */
function edgeScroll(pos: number, start: number, end: number): number {
  const zone = 40;
  if (pos < start + zone) {
    return -Math.ceil((start + zone - pos) / 4);
  }
  if (pos > end - zone) {
    return Math.ceil((pos - (end - zone)) / 4);
  }
  return 0;
}

// -----------------------------------------------------------------------------------------------
// DOM helpers

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) {
    e.className = className;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

function button(label: string, variant: string): HTMLButtonElement {
  const b = el('button', `btn ${variant}`, label);
  b.type = 'button';
  return b;
}

function setContext(e: HTMLElement, ctx: WebviewMenuContext): void {
  e.dataset.vscodeContext = JSON.stringify({ ...ctx, preventDefaultContextMenuItems: true });
}
