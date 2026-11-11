import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  BoardConfig,
  ConfigError,
  Entry,
  addGroups,
  buildView,
  moveGroup,
  moveTask,
  newTaskName,
  normalize,
  parseConfig,
  removeGroup,
  renameGroup,
  renameTask,
  serializeConfig,
  validateName,
} from '../src/board';

const f = (name: string): Entry => ({ name, isDir: false });
const d = (name: string): Entry => ({ name, isDir: true });

const config: BoardConfig = {
  groups: [
    { folder: 'ToDo', tasks: ['b.md', 'gone.md', 'a.md'] },
    { folder: 'Missing', tasks: ['x.md'] },
    { folder: 'Done', tasks: [] },
  ],
};
const scan = new Map<string, Entry[]>([
  ['ToDo', [f('a.md'), f('b.md'), f('task10.md'), f('task2.md'), d('dir')]],
  ['Done', [f('z.md')]],
]);

const names = (c: BoardConfig, g: string) => c.groups.find((x) => x.folder === g)!.tasks;

describe('parseConfig', () => {
  it('accepts an empty file', () => {
    assert.deepEqual(parseConfig(''), { groups: [] });
  });
  it('accepts string shorthand and removes duplicates', () => {
    assert.deepEqual(parseConfig('{"groups":["A",{"folder":"B","tasks":["x","x",1]}, "A"]}'), {
      groups: [
        { folder: 'A', tasks: [] },
        { folder: 'B', tasks: ['x'] },
      ],
    });
  });
  it('rejects invalid input', () => {
    assert.throws(() => parseConfig('{'), ConfigError);
    assert.throws(() => parseConfig('[]'), ConfigError);
    assert.throws(() => parseConfig('{"groups":{}}'), ConfigError);
    assert.throws(() => parseConfig('{"groups":[{"folder":"../x"}]}'), ConfigError);
  });
  it('round-trips', () => {
    assert.deepEqual(parseConfig(serializeConfig(config)), config);
  });
});

describe('buildView', () => {
  it('orders listed tasks first, then the rest in natural order, and skips missing groups', () => {
    const view = buildView(config, scan);
    assert.deepEqual(
      view.map((g) => g.folder),
      ['ToDo', 'Done'],
    );
    assert.deepEqual(
      view[0].tasks.map((t) => t.name),
      ['b.md', 'a.md', 'dir', 'task2.md', 'task10.md'],
    );
    assert.equal(view[0].tasks[2].isDir, true);
  });
});

describe('normalize', () => {
  it('drops stale tasks and keeps missing groups untouched', () => {
    const n = normalize(config, scan);
    assert.deepEqual(names(n, 'ToDo'), ['b.md', 'a.md', 'dir', 'task2.md', 'task10.md']);
    assert.deepEqual(names(n, 'Missing'), ['x.md']);
    assert.deepEqual(names(n, 'Done'), ['z.md']);
  });
});

describe('moveTask', () => {
  const n = normalize(config, scan);
  it('reorders within a group', () => {
    assert.deepEqual(names(moveTask(n, 'ToDo', 'task10.md', 'ToDo', 'b.md'), 'ToDo'), [
      'task10.md',
      'b.md',
      'a.md',
      'dir',
      'task2.md',
    ]);
    assert.deepEqual(names(moveTask(n, 'ToDo', 'b.md', 'ToDo', null), 'ToDo'), ['a.md', 'dir', 'task2.md', 'task10.md', 'b.md']);
  });
  it('moves to another group', () => {
    const m = moveTask(n, 'ToDo', 'a.md', 'Done', 'z.md');
    assert.deepEqual(names(m, 'ToDo'), ['b.md', 'dir', 'task2.md', 'task10.md']);
    assert.deepEqual(names(m, 'Done'), ['a.md', 'z.md']);
    assert.deepEqual(names(moveTask(n, 'ToDo', 'a.md', 'Done', null), 'Done'), ['z.md', 'a.md']);
  });
  it('does not mutate the input', () => {
    const before = serializeConfig(n);
    moveTask(n, 'ToDo', 'a.md', 'Done', null);
    assert.equal(serializeConfig(n), before);
  });
  it('throws for unknown groups', () => {
    assert.throws(() => moveTask(n, 'ToDo', 'a.md', 'Nope', null));
  });
});

describe('group operations', () => {
  it('moves groups', () => {
    assert.deepEqual(
      moveGroup(config, 'Done', 'ToDo').groups.map((g) => g.folder),
      ['Done', 'ToDo', 'Missing'],
    );
    assert.deepEqual(
      moveGroup(config, 'ToDo', null).groups.map((g) => g.folder),
      ['Missing', 'Done', 'ToDo'],
    );
  });
  it('adds, removes and renames groups', () => {
    assert.deepEqual(
      addGroups(config, ['Doing', 'ToDo']).groups.map((g) => g.folder),
      ['ToDo', 'Missing', 'Done', 'Doing'],
    );
    assert.deepEqual(
      removeGroup(config, 'Missing').groups.map((g) => g.folder),
      ['ToDo', 'Done'],
    );
    assert.deepEqual(names(renameGroup(config, 'ToDo', 'Backlog'), 'Backlog'), ['b.md', 'gone.md', 'a.md']);
  });
  it('renames tasks keeping their position', () => {
    assert.deepEqual(names(renameTask(config, 'ToDo', 'gone.md', 'c.md'), 'ToDo'), ['b.md', 'c.md', 'a.md']);
  });
});

describe('names', () => {
  it('validates names', () => {
    assert.equal(validateName('task 1.md'), undefined);
    assert.equal(validateName('日本語のタスク'), undefined);
    for (const bad of ['', ' ', '.', '..', 'a/b', 'a\\b', 'a:b', 'a?', 'end.']) {
      assert.notEqual(validateName(bad), undefined, bad);
    }
  });
  it('derives new task names', () => {
    assert.deepEqual(newTaskName('Write docs', '.md'), { name: 'Write docs.md', isDir: false });
    assert.deepEqual(newTaskName('notes.txt', '.md'), { name: 'notes.txt', isDir: false });
    assert.deepEqual(newTaskName('Big task/', '.md'), { name: 'Big task', isDir: true });
    assert.deepEqual(newTaskName('plain', ''), { name: 'plain', isDir: false });
    assert.deepEqual(newTaskName('x', 'md'), { name: 'x.md', isDir: false });
  });
});
