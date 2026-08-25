import { expect, test, describe } from 'vitest';
import {
  parse,
  format,
  add,
  set,
  rm,
  complete,
  unarchive,
  addEvent,
  removeEvent,
  archiveInTimeline,
  OpError,
  seededRng,
} from '../src/index.js';
import type { TaskDocument, TaskNode } from '../src/index.js';

const rt = (doc: TaskDocument) => format(parse(format(doc)));
const rng = () => seededRng(42);

describe('add', () => {
  test('appends a task as a timeline root', () => {
    const doc = parse('- [ ] A\n');
    const out = add(doc, { text: 'B', due: '2026-08-10' });
    expect(out.timeline.length).toBe(2);
    expect(format(out)).toContain('- [ ] B 📅 2026-08-10');
  });

  test('nests a task under a matched parent', () => {
    const doc = parse('- [ ] Parent\n');
    const out = add(doc, { text: 'Child', parent: { match: 'Parent' } });
    const parent = out.timeline[0];
    expect(parent?.kind).toBe('task');
    if (parent?.kind === 'task') {
      expect(parent.children[0]?.text).toBe('Child');
    }
  });

  test('does not mutate the input document', () => {
    const doc = parse('- [ ] A\n');
    add(doc, { text: 'B' });
    expect(doc.timeline.length).toBe(1);
  });

  test('throws when the parent locator matches nothing', () => {
    const doc = parse('- [ ] A\n');
    expect(() => add(doc, { text: 'X', parent: { match: 'nope' } })).toThrow(OpError);
  });
});

describe('set', () => {
  test('updates text and dates', () => {
    const doc = parse('- [ ] A 📅 2026-08-10\n');
    const out = set(doc, { line: 0 }, { text: 'A2', due: '2026-08-11' });
    expect(format(out)).toBe('- [ ] A2 📅 2026-08-11\n');
  });

  test('clears a date when passed null', () => {
    const doc = parse('- [ ] A 📅 2026-08-10\n');
    const out = set(doc, { line: 0 }, { due: null });
    expect(format(out)).toBe('- [ ] A\n');
  });
});

describe('rm', () => {
  test('removes a leaf task', () => {
    const doc = parse('- [ ] A\n- [ ] B\n');
    const out = rm(doc, { match: 'A' });
    expect(out.timeline.length).toBe(1);
  });

  test('refuses a task with children unless recursive', () => {
    const doc = parse('- [ ] Parent\n  - [ ] Child\n');
    expect(() => rm(doc, { match: 'Parent' })).toThrow(OpError);
    const out = rm(doc, { match: 'Parent' }, { recursive: true });
    expect(out.timeline.length).toBe(0);
  });
});

describe('complete moves tasks to the archive', () => {
  test('a top-level dated task lands in the archive with a done date', () => {
    const doc = parse('- [ ] Ship 📅 2026-08-10\n');
    const out = complete(doc, { match: 'Ship' }, { done: '2026-08-09', rng: rng() });
    expect(out.timeline.length).toBe(0);
    expect(out.archive?.length).toBe(1);
    expect(out.archive?.[0]?.checked).toBe(true);
    expect(out.archive?.[0]?.dates.done).toBe('2026-08-09');
  });

  test('an undated root records a section marker naming its section', () => {
    const src = ['- [ ] 🏁 M 📅 2026-08-10', '- [ ] Chore'].join('\n');
    const doc = parse(src);
    const out = complete(doc, { match: 'Chore' }, { done: '2026-08-12', rng: rng() });
    expect(out.archive?.[0]?.props.section).toBe('2026-08-10');
  });

  test('an undated root in the first section records section:: start', () => {
    const src = ['- [ ] Chore', '- [ ] 🏁 M 📅 2026-08-10'].join('\n');
    const doc = parse(src);
    const out = complete(doc, { match: 'Chore' }, { done: '2026-08-12', rng: rng() });
    expect(out.archive?.[0]?.props.section).toBe('start');
  });

  test('a nested completion records parent id and mints one if absent', () => {
    const doc = parse('- [ ] Parent\n  - [ ] Child\n');
    const out = complete(doc, { match: 'Child' }, { done: '2026-08-12', rng: rng() });
    const parent = out.timeline[0];
    expect(parent?.kind).toBe('task');
    const pid = parent?.kind === 'task' ? parent.props.id : undefined;
    expect(pid).toBeTruthy();
    expect(out.archive?.[0]?.props.parent).toBe(pid);
  });

  test('completing a parent keeps its open children active in the timeline', () => {
    const doc = parse('- [ ] Parent\n  - [ ] OpenChild\n  - [ ] Other\n');
    const out = complete(doc, { match: 'Parent' }, { done: '2026-08-12', rng: rng() });
    expect(out.archive?.[0]?.text).toBe('Parent');
    expect(out.archive?.[0]?.children).toHaveLength(0);
    const open = out.timeline.filter((n): n is TaskNode => n.kind === 'task');
    expect(open.some((n) => n.text === 'OpenChild')).toBe(true);
    expect(open.some((n) => n.text === 'Other')).toBe(true);
  });
});

describe('unarchive inverts complete', () => {
  test('dated top-level round-trips to the original canonical form', () => {
    const doc = parse('# T\n\n- [ ] Ship 🛫 2026-08-01 📅 2026-08-10\n');
    const done = complete(doc, { match: 'Ship' }, { done: '2026-08-09', rng: rng() });
    const back = unarchive(done, { match: 'Ship' });
    expect(rt(back)).toBe(format(doc));
  });

  test('undated root restores to its original section', () => {
    const src = [
      '# T',
      '',
      '- [ ] 🏁 M 📅 2026-08-10',
      '- [ ] Chore',
      '- [ ] Later 📅 2026-08-15',
    ].join('\n');
    const doc = parse(src);
    const done = complete(doc, { match: 'Chore' }, { done: '2026-08-12', rng: rng() });
    const back = unarchive(done, { match: 'Chore' });
    expect(rt(back)).toBe(format(doc));
  });

  test('nested task restores under its parent (parent keeps its id)', () => {
    const doc = parse('- [ ] Parent [id:: par001]\n  - [ ] Child\n');
    const done = complete(doc, { match: 'Child' }, { done: '2026-08-12', rng: rng() });
    const back = unarchive(done, { match: 'Child' });
    expect(rt(back)).toBe(format(doc));
    expect(back.archive).toBeNull();
  });

  test('refuses to unarchive a task whose ancestor is still archived', () => {
    const doc = parse('- [ ] Parent\n  - [ ] Child\n');
    // Completing the parent moves the whole subtree; Child now lives under an
    // archived Parent.
    const done = complete(doc, { match: 'Parent' }, { done: '2026-08-12', rng: rng() });
    expect(() => unarchive(done, { match: 'Child' })).toThrow(OpError);
  });
});

describe('events', () => {
  test('addEvent adds a top-level milestone', () => {
    const doc = parse('- [ ] A\n');
    const out = addEvent(doc, 'Launch', '2026-08-10');
    expect(format(out)).toContain('- [ ] 🏁 Launch 📅 2026-08-10');
  });

  test('removeEvent deletes a milestone', () => {
    const doc = parse('- [ ] 🏁 Launch 📅 2026-08-10\n- [ ] A\n');
    const out = removeEvent(doc, { match: 'Launch' });
    expect(out.timeline.some((n) => n.kind === 'task' && n.isEvent)).toBe(false);
  });

  test('removeEvent refuses a non-event', () => {
    const doc = parse('- [ ] A\n');
    expect(() => removeEvent(doc, { match: 'A' })).toThrow(OpError);
  });
});

describe('archiveInTimeline (format auto-archive)', () => {
  test('moves a checked top-level task to the archive', () => {
    const doc = parse('- [x] Done 📅 2026-08-01 ✅ 2026-08-01\n- [ ] Open\n');
    const out = archiveInTimeline(doc);
    expect(out.timeline.some((n) => n.kind === 'task' && n.text === 'Done')).toBe(false);
    expect(out.archive?.[0]?.text).toBe('Done');
  });

  test('does not invent a done date when the checked task has none', () => {
    const doc = parse('- [x] Done, no date\n- [ ] Open\n');
    const out = archiveInTimeline(doc);
    expect(out.archive?.[0]?.dates.done).toBeUndefined();
  });

  test('records [parent::] for a nested checked task (parent keeps an id)', () => {
    const doc = parse('- [ ] Parent\n  - [ ] Child\n  - [x] DoneChild ✅ 2026-08-01\n');
    const out = archiveInTimeline(doc);
    const parent = out.timeline[0] as TaskNode;
    expect(parent.props.id).toBeTruthy();
    expect(out.archive?.[0]?.props.parent).toBe(parent.props.id);
  });

  test('records [section::] for an undated root', () => {
    const doc = parse('- [ ] 🏁 M 📅 2026-08-10\n- [x] Chore\n');
    const out = archiveInTimeline(doc);
    expect(out.archive?.[0]?.props.section).toBe('2026-08-10');
  });

  test('open children of a checked parent stay active in the timeline (not archived)', () => {
    const doc = parse('- [x] Parent ✅ 2026-08-01\n  - [ ] Child\n');
    const out = archiveInTimeline(doc);
    // Parent is archived; its open Child is promoted back into the timeline.
    expect(out.timeline.some((n) => n.kind === 'task' && n.text === 'Child')).toBe(true);
    expect(out.archive?.[0]?.checked).toBe(true);
    expect(out.archive?.[0]?.children).toHaveLength(0);
  });

  test('checked descendants still travel with a checked parent', () => {
    const doc = parse(
      '- [x] Parent ✅ 2026-08-01\n  - [x] DoneChild ✅ 2026-08-01\n  - [ ] OpenChild\n',
    );
    const out = archiveInTimeline(doc);
    // DoneChild archives under Parent; OpenChild stays in the timeline.
    expect(out.archive?.[0]?.children[0]?.text).toBe('DoneChild');
    expect(out.timeline.some((n) => n.kind === 'task' && n.text === 'OpenChild')).toBe(true);
  });

  test('a parent whose children are all done archives the whole subtree', () => {
    const doc = parse('- [x] Parent ✅ 2026-08-01\n  - [x] Child ✅ 2026-08-01\n');
    const out = archiveInTimeline(doc);
    expect(out.timeline).toHaveLength(0);
    expect(out.archive?.[0]?.children[0]?.text).toBe('Child');
  });

  test('events are never auto-archived', () => {
    const doc = parse('- [x] 🏁 Bad event 📅 2026-08-10\n- [ ] A\n');
    const out = archiveInTimeline(doc);
    expect(out.timeline.some((n) => n.kind === 'task' && n.isEvent && n.text === 'Bad event')).toBe(
      true,
    );
    expect(out.archive ?? []).toHaveLength(0);
  });
});

describe('format auto-archives completed tasks', () => {
  test('a checked task moves to the archive on format', () => {
    const out = format(parse('- [x] Done ✅ 2026-08-01\n- [ ] Open 📅 2026-08-10\n'));
    expect(out).toContain('## Archive');
    expect(out).toContain('- [x] Done ✅ 2026-08-01');
    const timeline = out.slice(0, out.indexOf('## Archive'));
    expect(timeline).toContain('Open');
  });

  test('auto-archive is idempotent', () => {
    const once = format(parse('- [x] Done ✅ 2026-08-01\n- [ ] Open\n'));
    const twice = format(parse(once));
    expect(twice).toBe(once);
  });

  test('unarchive restores an auto-archived nested task under its parent', () => {
    const src = '- [ ] Parent\n  - [x] Child ✅ 2026-08-01\n';
    const archived = archiveInTimeline(parse(src));
    const back = unarchive(archived, { match: 'Child' });
    // Child is re-opened and re-nested under Parent; Parent keeps its id (ids
    // are stable and never stripped by the formatter).
    const parent = back.timeline[0] as TaskNode;
    expect(parent.props.id).toBeTruthy();
    expect(parent.children[0]?.text).toBe('Child');
    expect(parent.children[0]?.checked).toBe(false);
    expect(parent.children[0]?.props.parent).toBeUndefined();
    expect(back.archive ?? []).toHaveLength(0);
  });
});
