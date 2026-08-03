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
  OpError,
  seededRng,
} from '../src/index.js';
import type { TaskDocument } from '../src/index.js';

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
