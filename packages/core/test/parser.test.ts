import { expect, test, describe } from 'vitest';
import { parse } from '../src/index.js';
import type { TaskNode } from '../src/index.js';

function root(doc: ReturnType<typeof parse>, idx = 0): TaskNode {
  const n = doc.timeline[idx];
  if (!n || n.kind !== 'task') throw new Error(`timeline[${idx}] is not a task`);
  return n;
}

describe('regions', () => {
  test('parses frontmatter + title + timeline', () => {
    const doc = parse('---\ntags: [work]\n---\n# Project\n\n- [ ] Task A\n');
    expect(doc.frontmatter).toBe('tags: [work]');
    expect(doc.title).toBe('Project');
    expect(root(doc).text).toBe('Task A');
  });

  test('parses the archive header into the archive region', () => {
    const doc = parse('# T\n\n- [ ] Active\n\n## Archive\n\n- [x] Done ✅ 2026-08-01\n');
    expect(doc.timeline.length).toBe(1);
    expect(doc.archive?.length).toBe(1);
    expect(doc.archive![0]!.checked).toBe(true);
    expect(doc.archive![0]!.dates.done).toBe('2026-08-01');
  });

  test('tolerates CRLF and BOM', () => {
    const doc = parse('﻿# T\r\n\r\n- [ ] A\r\n');
    expect(doc.title).toBe('T');
    expect(root(doc).text).toBe('A');
  });
});

describe('fields', () => {
  test('parses emoji fields', () => {
    const t = root(
      parse('- [ ] Ship it 🛫 2026-08-01 📅 2026-08-10 ✅ 2026-08-09 ➕ 2026-07-30\n'),
    );
    expect(t.dates).toEqual({
      start: '2026-08-01',
      due: '2026-08-10',
      done: '2026-08-09',
      created: '2026-07-30',
    });
    expect(t.text).toBe('Ship it');
  });

  test('parses ASCII/dataview fields', () => {
    const t = root(parse('- [ ] Ship it [start:: 2026-08-01] [due:: 2026-08-10]\n'));
    expect(t.dates).toEqual({ start: '2026-08-01', due: '2026-08-10' });
    expect(t.text).toBe('Ship it');
  });

  test('first duplicate wins, rest dropped', () => {
    const t = root(parse('- [ ] A 📅 2026-08-01 📅 2026-08-02\n'));
    expect(t.dates.due).toBe('2026-08-01');
  });

  test('keeps unmodeled tokens (tags, priority) in text', () => {
    const t = root(parse('- [ ] A 📅 2026-08-01 #work ⏫ 🔁 every week\n'));
    expect(t.dates.due).toBe('2026-08-01');
    expect(t.text).toBe('A #work ⏫ 🔁 every week');
  });

  test('a date-like emoji inside prose is not promoted when malformed', () => {
    const t = root(parse('- [ ] Read 📅 (book)\n'));
    expect(t.dates.due).toBeUndefined();
    expect(t.text).toBe('Read 📅 (book)');
  });
});

describe('props', () => {
  test('parses id, parent, section', () => {
    const t = root(parse('- [ ] A [id:: abc123] [parent:: def456] [section:: start]\n'));
    expect(t.props).toEqual({ id: 'abc123', parent: 'def456', section: 'start' });
    expect(t.text).toBe('A');
  });
});

describe('nesting and comments', () => {
  test('nests children by indentation', () => {
    const doc = parse(
      '- [ ] Parent\n  - [ ] Child 1\n  - [ ] Child 2\n    - [ ] Grandchild\n- [ ] Sibling\n',
    );
    const parent = root(doc);
    expect(parent.children.length).toBe(2);
    expect(parent.children[0]!.text).toBe('Child 1');
    expect(parent.children[1]!.children[0]!.text).toBe('Grandchild');
    expect(root(doc, 1).text).toBe('Sibling');
  });

  test('binds contiguous comment block to the task below', () => {
    const doc = parse('%% note about A\n%% second line\n- [ ] A\n');
    const t = root(doc);
    expect(t.comments).toEqual(['%% note about A', '%% second line']);
  });

  test('a blank line breaks comment binding (orphan comment becomes unknown)', () => {
    const doc = parse('%% orphan\n\n- [ ] A\n');
    const first = doc.timeline[0];
    expect(first?.kind).toBe('unknown');
    expect(root(doc, 1).comments).toEqual([]);
  });

  test('detects events from the 🏁 marker', () => {
    const t = root(parse('- [ ] 🏁 Sprint 1 📅 2026-08-10\n'));
    expect(t.isEvent).toBe(true);
    expect(t.text).toBe('Sprint 1');
    expect(t.dates.due).toBe('2026-08-10');
  });

  test('preserves unknown lines position-stable', () => {
    const doc = parse('- [ ] A\nSome prose line\n- [ ] B\n');
    expect(doc.timeline[1]?.kind).toBe('unknown');
    expect((doc.timeline[1] as { text: string }).text).toBe('Some prose line');
    expect(root(doc, 2).text).toBe('B');
  });

  test('unterminated frontmatter does not eat the file', () => {
    const doc = parse('---\ntags: [x]\n- [ ] A\n');
    expect(doc.frontmatter).toBeNull();
    expect(doc.timeline.some((n) => n.kind === 'task')).toBe(true);
  });
});
