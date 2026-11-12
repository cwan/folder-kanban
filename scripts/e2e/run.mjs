// Local end-to-end check: runs BoardPanel against a mocked `vscode` module and drives the real
// webview in Chromium with Playwright. Not part of CI (needs a browser).
//   node scripts/e2e/run.mjs [screenshotDir]
import * as esbuild from 'esbuild';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const ext = resolve(import.meta.dirname, '../..');
const work = mkdtempSync(join(tmpdir(), 'fk-e2e-'));
const shots = process.argv[2] ?? work;

await esbuild.build({
  entryPoints: [join(ext, 'scripts/e2e/harness.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: join(work, 'harness.cjs'),
  alias: { vscode: join(ext, 'scripts/e2e/vscode-mock.ts') },
  logLevel: 'warning',
});
const { open, mock, BoardsViewProvider, activate } = require(join(work, 'harness.cjs'));

const root = join(work, 'project');
for (const [dir, files] of Object.entries({
  ToDo: ['a.md', 'b.md', 'c.md', 'Design spec'],
  Doing: [],
  Done: ['x.md', 'b.md'],
  Other: [],
})) {
  mkdirSync(join(root, dir), { recursive: true });
  for (const f of files) {
    if (f.includes('.')) writeFileSync(join(root, dir, f), '');
    else mkdirSync(join(root, dir, f));
  }
}
writeFileSync(join(root, '.folder-kanban.json'), JSON.stringify({ groups: ['ToDo', 'Doing', 'Done'] }));
const config = () => JSON.parse(readFileSync(join(root, '.folder-kanban.json'), 'utf8'));
const taskObjs = (g) => config().groups.find((x) => x.folder === g).tasks;
const tasksOf = (g) => taskObjs(g).map((t) => t.name);
const dueOf = (g, t) => taskObjs(g).find((x) => x.name === t)?.due;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const daysFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

const { chromium } = require('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 520 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.error('pageerror', e));
await page.exposeFunction('__toHost', (m) => mock.webviewToHost.fire(m));
await page.addInitScript(() => {
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__toHost(m), setState() {} });
});
mock.setHostToWebview((m) => page.evaluate((m) => window.postMessage(m, '*'), m).catch(() => {}));

// Dark-ish theme variables so the screenshot resembles VS Code.
const themeCss = `body{background:#1f1f1f;--vscode-foreground:#ccc;--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;
--vscode-sideBar-background:#181818;--vscode-panel-border:#2b2b2b;--vscode-editor-background:#262626;--vscode-widget-border:#313131;
--vscode-badge-background:#616161;--vscode-badge-foreground:#f8f8f8;--vscode-descriptionForeground:#9d9d9d;--vscode-focusBorder:#0078d4;
--vscode-list-hoverBackground:#2a2d2e;--vscode-symbolIcon-folderForeground:#c5a332;--vscode-toolbar-hoverBackground:#2a2d2e}`;
writeFileSync(join(work, 'theme.css'), themeCss);
const theme = `<link rel="stylesheet" href="file://${join(work, 'theme.css')}">`;
const panel = open(ext, root);
const html = panel.panel.webview.html.replace('</head>', `${theme}</head>`);
writeFileSync(join(work, 'index.html'), html);
await page.goto(`file://${join(work, 'index.html')}`);

const card = (g, t) => page.locator(`.group[data-group="${g}"] .card[data-task="${t}"]`);
const order = (g) => page.locator(`.group[data-group="${g}"] .card`).evaluateAll((els) => els.map((e) => e.dataset.task));
const settle = () => page.waitForTimeout(300);

await card('ToDo', 'a.md').waitFor();
assert.deepEqual(await order('ToDo'), ['a.md', 'b.md', 'c.md', 'Design spec']);
await page.screenshot({ path: join(shots, 'board-initial.png') });

// 1. Reorder within a group: c.md to the top.
await card('ToDo', 'c.md').dragTo(card('ToDo', 'a.md'), { targetPosition: { x: 20, y: 3 } });
await settle();
assert.deepEqual(tasksOf('ToDo'), ['c.md', 'a.md', 'b.md', 'Design spec']);
assert.deepEqual(await order('ToDo'), ['c.md', 'a.md', 'b.md', 'Design spec']);

// 2. Move to another group: the file moves on disk.
await card('ToDo', 'a.md').dragTo(page.locator('.group[data-group="Doing"] .tasks'));
await settle();
assert.ok(existsSync(join(root, 'Doing/a.md')) && !existsSync(join(root, 'ToDo/a.md')));
assert.deepEqual(tasksOf('Doing'), ['a.md']);
assert.deepEqual(await order('Doing'), ['a.md']);

// 3. Move a folder task between existing cards of another group.
await card('ToDo', 'Design spec').dragTo(card('Done', 'x.md'), { targetPosition: { x: 20, y: 30 } });
await settle();
assert.ok(existsSync(join(root, 'Done/Design spec')));
assert.deepEqual(tasksOf('Done'), ['b.md', 'x.md', 'Design spec']);
assert.deepEqual(await order('Done'), ['b.md', 'x.md', 'Design spec']);

// 4. Name conflict: Done already has b.md -> error, nothing moved, UI reverted.
await card('ToDo', 'b.md').dragTo(page.locator('.group[data-group="Done"] .tasks'));
await settle();
assert.ok(existsSync(join(root, 'ToDo/b.md')));
assert.ok(mock.log.some((l) => l.startsWith('error:') && l.includes('already exists')), mock.log.join('\n'));
assert.deepEqual(await order('ToDo'), ['c.md', 'b.md']);

// 5. Reorder groups: Done to the front.
await page.locator('.group[data-group="Done"] .group-header').dragTo(page.locator('.group[data-group="ToDo"]'), {
  targetPosition: { x: 10, y: 10 },
});
await settle();
assert.deepEqual(config().groups.map((g) => g.folder), ['Done', 'ToDo', 'Doing']);
assert.deepEqual(await page.locator('.group').evaluateAll((els) => els.map((e) => e.dataset.group)), ['Done', 'ToDo', 'Doing']);

// 6. Add a task with the "+ Add task" button.
mock.answers.input.push('Write README');
await page.locator('.group[data-group="Doing"] .group-footer button').click();
await settle();
assert.ok(existsSync(join(root, 'Doing/Write README.md')));
assert.equal(readFileSync(join(root, 'Doing/Write README.md'), 'utf8'), '# Write README\n');
assert.deepEqual(await order('Doing'), ['a.md', 'Write README.md']);

// 7. Add a group from an existing folder.
mock.answers.quickPick.push([{ label: 'Other' }]);
await page.locator('.add-group button').click();
await settle();
assert.deepEqual(config().groups.map((g) => g.folder), ['Done', 'ToDo', 'Doing', 'Other']);

// 8. Click opens the file.
await card('Doing', 'a.md').click();
await settle();
assert.ok(mock.log.some((l) => l === `vscode.open ${join(root, 'Doing/a.md')}`));

// 8b. Due dates: set via "Enter date and time...", shown as an overdue badge.
mock.answers.quickPick.push({ action: 'input' });
mock.answers.input.push('2020/1/2 9:05');
panel.setDue('Doing', 'a.md');
await settle();
assert.equal(dueOf('Doing', 'a.md'), '2020-01-02T09:05');
const badge = card('Doing', 'a.md').locator('.due');
assert.equal(await badge.getAttribute('class'), 'due due-overdue');

// Invalid input is rejected and nothing changes.
mock.answers.quickPick.push({ action: 'input' });
mock.answers.input.push('next friday');
panel.setDue('Doing', 'a.md');
await settle();
assert.equal(dueOf('Doing', 'a.md'), '2020-01-02T09:05');
assert.ok(mock.log.some((l) => l.startsWith('invalid: Enter a date')));

// Clicking the badge opens the picker (and does not open the file); "Today" makes it "soon".
const opened = mock.log.length;
mock.answers.quickPick.push({ due: daysFromNow(0) });
await badge.click();
await settle();
assert.equal(dueOf('Doing', 'a.md'), daysFromNow(0));
assert.ok(!mock.log.slice(opened).some((l) => l.startsWith('vscode.open')));
assert.equal(await card('Doing', 'a.md').locator('.due').getAttribute('class'), 'due due-soon');

// The due date follows the task when it is dragged to another group.
await card('Doing', 'a.md').dragTo(card('ToDo', 'c.md'), { targetPosition: { x: 20, y: 3 } });
await settle();
assert.ok(existsSync(join(root, 'ToDo/a.md')));
assert.equal(dueOf('ToDo', 'a.md'), daysFromNow(0));
assert.equal(await card('ToDo', 'a.md').locator('.due').getAttribute('class'), 'due due-soon');

// Clear.
panel.clearDue('ToDo', 'a.md');
await settle();
assert.equal(dueOf('ToDo', 'a.md'), undefined);
assert.equal(await card('ToDo', 'a.md').locator('.due').count(), 0);

// 9. Rename and delete via the (context menu) operations.
mock.answers.input.push('c-renamed.md');
panel.renameTask('ToDo', 'c.md');
await settle();
assert.deepEqual(tasksOf('ToDo'), ['a.md', 'c-renamed.md', 'b.md']);
mock.answers.warning.push('Move to Trash');
panel.deleteTask('ToDo', 'b.md');
await settle();
assert.ok(!existsSync(join(root, 'ToDo/b.md')));
assert.deepEqual(await order('ToDo'), ['a.md', 'c-renamed.md']);

// 10. Broken config shows an error instead of the board.
writeFileSync(join(root, '.folder-kanban.json'), '{ broken');
panel.refresh();
await page.locator('.error').waitFor();

writeFileSync(
  join(root, '.folder-kanban.json'),
  JSON.stringify({
    groups: [
      { folder: 'ToDo', tasks: [{ name: 'a.md', due: daysFromNow(10) }, { name: 'c-renamed.md', due: `${daysFromNow(0)}T18:00` }] },
      'Doing',
      { folder: 'Done', tasks: [{ name: 'b.md' }, { name: 'Design spec', due: daysFromNow(-3) }] },
    ],
  }),
);
panel.refresh();
await card('ToDo', 'c-renamed.md').waitFor();
await page.screenshot({ path: join(shots, 'board-after.png') });

// 11. Activity bar view lists the workspace root and nested boards.
mkdirSync(join(root, 'sub/team/Backlog'), { recursive: true });
writeFileSync(join(root, 'sub/team/.folder-kanban.json'), JSON.stringify({ groups: ['Backlog'] }));
mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
writeFileSync(join(root, 'node_modules/pkg/.folder-kanban.json'), '{}');
mock.workspace.workspaceFolders = [{ uri: mock.Uri.file(root), name: 'project' }];
const view = new BoardsViewProvider();
const items = (await view.getChildren()).map((i) => view.getTreeItem(i));
assert.deepEqual(
  items.map((i) => [i.label, i.description ?? '', i.command.command, i.command.arguments[0].fsPath]),
  [
    ['project', '', 'folderKanban.openBoard', root],
    ['team', join('sub', 'team'), 'folderKanban.openBoard', join(root, 'sub/team')],
  ],
);
mock.workspace.workspaceFolders = [{ uri: mock.Uri.file(join(root, 'Doing')), name: 'Doing' }];
assert.deepEqual(
  (await view.getChildren()).map((i) => [view.getTreeItem(i).label, view.getTreeItem(i).description]),
  [['Doing', 'not set up']],
);
view.dispose();

// 12. Clicking the activity bar icon runs "Open Board".
{
  const opens = () => mock.log.filter((l) => l === 'command folderKanban.openBoard').length;
  const ctx = { extensionUri: mock.Uri.file(ext), subscriptions: [] };
  // First click: the extension is activated with the view already visible.
  mock.workspace.workspaceFolders = [{ uri: mock.Uri.file(root), name: 'project' }];
  mock.treeView.visible = true;
  activate(ctx);
  await settle();
  assert.equal(opens(), 1);
  // The visibility event for the same click must not open it twice.
  mock.treeView.visibility.fire({ visible: true });
  assert.equal(opens(), 1);
  // Hiding does nothing; showing again later opens (reveals) the board again.
  await page.waitForTimeout(1100);
  mock.treeView.visibility.fire({ visible: false });
  assert.equal(opens(), 1);
  mock.treeView.visibility.fire({ visible: true });
  assert.equal(opens(), 2);
  // No workspace folder: nothing is opened (the welcome view offers a button instead).
  await page.waitForTimeout(1100);
  mock.workspace.workspaceFolders = [];
  mock.treeView.visibility.fire({ visible: true });
  assert.equal(opens(), 2);
}

console.log(readFileSync(join(root, '.folder-kanban.json'), 'utf8'));
console.log(mock.log.join('\n'));
console.log('E2E OK');
await browser.close();
process.exit(0);
