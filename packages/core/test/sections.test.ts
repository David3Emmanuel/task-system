import { expect, test, describe } from 'vitest';
import {
  anchorDate,
  endDate,
  collectEvents,
  sectionIndexByDate,
  sectionIndexByPosition,
  stableSort,
  cmpStr,
  cmpText,
} from '../src/sections.js';
import { parse, makeTask } from '../src/index.js';
import type { TaskNode, TimelineNode } from '../src/index.js';

/** Parse a timeline and return its roots. */
function timeline(src: string): TimelineNode[] {
  return parse(src).timeline;
}

function dates(node: TaskNode): { start?: string; due?: string } {
  return { start: node.dates.start, due: node.dates.due };
}

describe('anchorDate / endDate', () => {
  test('anchorDate prefers start over due', () => {
    const node = makeTask('A', { dates: { start: '2026-08-01', due: '2026-08-10' } });
    expect(anchorDate(node)).toBe('2026-08-01');
  });

  test('anchorDate falls back to due when start is absent', () => {
    const node = makeTask('A', { dates: { due: '2026-08-10' } });
    expect(anchorDate(node)).toBe('2026-08-10');
  });

  test('anchorDate is undefined for an undated task', () => {
    expect(anchorDate(makeTask('A'))).toBeUndefined();
  });

  test('endDate prefers due over start', () => {
    const node = makeTask('A', { dates: { start: '2026-08-01', due: '2026-08-10' } });
    expect(endDate(node)).toBe('2026-08-10');
  });

  test('endDate falls back to start when due is absent', () => {
    const node = makeTask('A', { dates: { start: '2026-08-01' } });
    expect(endDate(node)).toBe('2026-08-01');
  });
});

describe('collectEvents', () => {
  test('keeps only top-level events, sorted by due date', () => {
    const roots = timeline(
      [
        '- [ ] 🏁 Zeta 📅 2026-08-20',
        '- [ ] Not an event 📅 2026-08-01',
        '- [ ] 🏁 Alpha 📅 2026-08-01',
      ].join('\n'),
    );
    const events = collectEvents(roots);
    expect(events.map((e) => e.text)).toEqual(['Alpha', 'Zeta']);
  });

  test('is stable for equal event dates (file order preserved)', () => {
    const roots = timeline(
      ['- [ ] 🏁 First 📅 2026-08-01', '- [ ] 🏁 Second 📅 2026-08-01'].join('\n'),
    );
    const events = collectEvents(roots);
    expect(events.map((e) => e.text)).toEqual(['First', 'Second']);
  });

  test('returns an empty array when there are no events', () => {
    expect(collectEvents(timeline('- [ ] A\n'))).toEqual([]);
  });
});

describe('sectionIndexByDate', () => {
  const eventDates = ['2026-08-10', '2026-08-20'];

  test('counts events at or before the anchor', () => {
    expect(sectionIndexByDate('2026-08-01', eventDates)).toBe(0);
    expect(sectionIndexByDate('2026-08-10', eventDates)).toBe(1);
    expect(sectionIndexByDate('2026-08-15', eventDates)).toBe(1);
    expect(sectionIndexByDate('2026-08-20', eventDates)).toBe(2);
    expect(sectionIndexByDate('2026-08-21', eventDates)).toBe(2);
  });

  test('a boundary-equal anchor lands in the section AFTER the event', () => {
    expect(sectionIndexByDate('2026-08-10', ['2026-08-10'])).toBe(1);
  });

  test('an empty event list yields section 0', () => {
    expect(sectionIndexByDate('2026-08-10', [])).toBe(0);
  });
});

describe('sectionIndexByPosition', () => {
  test('counts events that appear before the node in file order', () => {
    const roots = timeline(
      ['- [ ] 🏁 E1 📅 2026-08-10', '- [ ] A', '- [ ] 🏁 E2 📅 2026-08-20', '- [ ] B'].join('\n'),
    );
    const a = roots[1] as TaskNode;
    const b = roots[3] as TaskNode;
    expect(sectionIndexByPosition(a, roots)).toBe(1);
    expect(sectionIndexByPosition(b, roots)).toBe(2);
  });

  test('a node before any event is in section 0', () => {
    const roots = timeline(['- [ ] A', '- [ ] 🏁 E1 📅 2026-08-10'].join('\n'));
    expect(sectionIndexByPosition(roots[0]!, roots)).toBe(0);
  });

  test('an unknown node still gets a positional section', () => {
    const roots = timeline(['- [ ] 🏁 E1 📅 2026-08-10', 'prose line'].join('\n'));
    expect(sectionIndexByPosition(roots[1]!, roots)).toBe(1);
  });
});

describe('stableSort', () => {
  test('is a stable sort (equal keys keep input order)', () => {
    const input = [
      { k: 2, tag: 'a' },
      { k: 1, tag: 'b' },
      { k: 2, tag: 'c' },
      { k: 1, tag: 'd' },
    ];
    const out = stableSort(input, (a, b) => a.k - b.k);
    expect(out.map((x) => x.tag)).toEqual(['b', 'd', 'a', 'c']);
  });

  test('does not mutate the input array', () => {
    const input = [{ k: 2 }, { k: 1 }];
    stableSort(input, (a, b) => a.k - b.k);
    expect(input.map((x) => x.k)).toEqual([2, 1]);
  });
});

describe('comparators', () => {
  test('cmpStr is a total order', () => {
    expect(cmpStr('a', 'b')).toBeLessThan(0);
    expect(cmpStr('b', 'a')).toBeGreaterThan(0);
    expect(cmpStr('a', 'a')).toBe(0);
  });

  test('cmpText is case-insensitive with a codepoint tiebreak', () => {
    expect(cmpText('Alpha', 'beta')).toBeLessThan(0);
    expect(cmpText('a', 'A')).toBeGreaterThan(0); // tie on fold, resolved by codepoint
  });
});

describe('helpers used by the formatter', () => {
  test('dates() round-trips the fields the section logic reads', () => {
    const node = makeTask('A', { dates: { start: '2026-08-01', due: '2026-08-10' } });
    expect(dates(node)).toEqual({ start: '2026-08-01', due: '2026-08-10' });
  });
});
