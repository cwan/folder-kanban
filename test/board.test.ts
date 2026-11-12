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
  setDue,
  parseDue,
  dueStatus,
  dueDeadline,
  validateName,
} from '../src/board';

const f = (name: string): Entry => ({ name, isDir: false });
const d = (name: string): Entry => ({ name, isDir: true });

const config: BoardConfig = {
  groups: [
    { folder: 'ToDo', tasks: [{ name: 'b.md' }, { name: 'gone.md' }, { name: 'a.md', due: '2026-11-20T18:00' }] },
    { folder: 'Missing', tasks: [{ name: 'x.md' }] },
    { folder: 'Done', tasks: [] },
  ],
};
const scan = new Map<string, Entry[]>([
  ['ToDo', [f('a.md'), f('b.md'), f('task10.md'), f('task2.md'), d('dir')]],
  ['Done', [f('z.md')]],
]);

const tasks = (c: BoardConfig, g: string) => c.groups.find((x) => x.folder === g)!.tasks;
const names = (c: BoardConfig, g: string) => tasks(c, g).map((t) => t.name);
const dueOf = (c: BoardConfig, g: string, name: string) => tasks(c, g).find((t) => t.name === name)?.due;

describe('parseConfig', () => {
  it('accepts an empty file', () => {
    assert.deepEqual(parseConfig(''), { groups: [] });
  });
  it('accepts string shorthand and removes duplicates', () => {
    assert.deepEqual(
      parseConfig('{"groups":["A",{"folder":"B","tasks":["x",{"name":"x"},{"name":"y","due":"2026/1/2 9:05"},{"name":"z","due":""}]}, "A"]}'),
      {
        groups: [
          { folder: 'A', tasks: [] },
          { folder: 'B', tasks: [{ name: 'x' }, { name: 'y', due: '2026-01-02T09:05' }, { name: 'z' }] },
        ],
      },
    );
  });
  it('rejects invalid input', () => {
    assert.throws(() => parseConfig('{'), ConfigError);
    assert.throws(() => parseConfig('[]'), ConfigError);
    assert.throws(() => parseConfig('{"groups":{}}'), ConfigError);
    assert.throws(() => parseConfig('{"groups":[{"folder":"../x"}]}'), ConfigError);
    assert.throws(() => parseConfig('{"groups":[{"folder":"A","tasks":[1]}]}'), ConfigError);
    assert.throws(() => parseConfig('{"groups":[{"folder":"A","tasks":[{"name":"a","due":"tomorrow"}]}]}'), ConfigError);
  });
  it('round-trips', () => {
    assert.deepEqual(parseConfig(serializeConfig(config)), config);
    assert.deepEqual(parseConfig(serializeConfig({ groups: [] })), { groups: [] });
  });
  it('writes one line per task', () => {
    assert.equal(
      serializeConfig({ groups: [{ folder: 'A', tasks: [{ name: 'a', due: '2026-01-02' }, { name: 'b' }] }, { folder: 'B', tasks: [] }] }),
      `{
  "groups": [
    {
      "folder": "A",
      "tasks": [
        {"name":"a","due":"2026-01-02"},
        {"name":"b"}
      ]
    },
    {
      "folder": "B",
      "tasks": []
    }
  ]
}
`,
    );
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
    assert.equal(view[0].tasks[1].due, '2026-11-20T18:00');
    assert.equal(view[0].tasks[0].due, undefined);
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
  it('moves to another group together with its due date', () => {
    const m = moveTask(n, 'ToDo', 'a.md', 'Done', 'z.md');
    assert.deepEqual(names(m, 'ToDo'), ['b.md', 'dir', 'task2.md', 'task10.md']);
    assert.deepEqual(names(m, 'Done'), ['a.md', 'z.md']);
    assert.equal(dueOf(m, 'Done', 'a.md'), '2026-11-20T18:00');
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
    assert.equal(dueOf(renameTask(config, 'ToDo', 'a.md', 'a2.md'), 'ToDo', 'a2.md'), '2026-11-20T18:00');
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

describe('due dates', () => {
  it('parses user input', () => {
    assert.equal(parseDue('2026-11-20'), '2026-11-20');
    assert.equal(parseDue(' 2026/1/5 '), '2026-01-05');
    assert.equal(parseDue('2026-11-20 9:05'), '2026-11-20T09:05');
    assert.equal(parseDue('2026-11-20T18:30'), '2026-11-20T18:30');
    for (const bad of ['', 'tomorrow', '2026-02-30', '2026-13-01', '2026-11-20 24:00', '2026-11-20 10:60', '20261120']) {
      assert.equal(parseDue(bad), undefined, bad);
    }
  });
  it('computes deadlines and status', () => {
    assert.deepEqual(dueDeadline('2026-11-20'), new Date(2026, 10, 21));
    assert.deepEqual(dueDeadline('2026-11-20T18:00'), new Date(2026, 10, 20, 18, 0));
    // Date only: "soon" on the day itself, overdue from the next day.
    assert.equal(dueStatus('2026-11-20', new Date(2026, 10, 19, 23, 59)), 'later');
    assert.equal(dueStatus('2026-11-20', new Date(2026, 10, 20, 0, 0)), 'soon');
    assert.equal(dueStatus('2026-11-20', new Date(2026, 10, 20, 23, 59)), 'soon');
    assert.equal(dueStatus('2026-11-20', new Date(2026, 10, 21, 0, 0)), 'overdue');
    // Date and time: "soon" within 24 hours.
    assert.equal(dueStatus('2026-11-20T18:00', new Date(2026, 10, 19, 17, 59)), 'later');
    assert.equal(dueStatus('2026-11-20T18:00', new Date(2026, 10, 19, 18, 0)), 'soon');
    assert.equal(dueStatus('2026-11-20T18:00', new Date(2026, 10, 20, 18, 0)), 'overdue');
  });
  it('sets and clears due dates', () => {
    const n = normalize(config, scan);
    const set = setDue(n, 'ToDo', 'b.md', '2026-12-01');
    assert.equal(dueOf(set, 'ToDo', 'b.md'), '2026-12-01');
    assert.equal(dueOf(n, 'ToDo', 'b.md'), undefined, 'input must not be mutated');
    assert.equal(dueOf(setDue(set, 'ToDo', 'b.md', undefined), 'ToDo', 'b.md'), undefined);
    assert.deepEqual(names(setDue(config, 'ToDo', 'new.md', '2026-12-01'), 'ToDo'), ['b.md', 'gone.md', 'a.md', 'new.md']);
  });
});
