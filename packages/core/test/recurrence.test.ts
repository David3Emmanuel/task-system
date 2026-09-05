import { expect, test, describe } from 'vitest';
import {
  parseRecurrence,
  nextDate,
  hasRecurrence,
  complete,
  parse,
  seededRng,
} from '../src/index.js';

describe('parseRecurrence', () => {
  const cases: [string, { count: number; unit: string }][] = [
    ['standup 🔁 daily', { count: 1, unit: 'day' }],
    ['x 🔁 every day', { count: 1, unit: 'day' }],
    ['x 🔁 every 2 days', { count: 2, unit: 'day' }],
    ['x 🔁 weekly', { count: 1, unit: 'week' }],
    ['x 🔁 every week', { count: 1, unit: 'week' }],
    ['x 🔁 biweekly', { count: 2, unit: 'week' }],
    ['x 🔁 every 3 weeks', { count: 3, unit: 'week' }],
    ['x 🔁 monthly', { count: 1, unit: 'month' }],
    ['x 🔁 every month', { count: 1, unit: 'month' }],
    ['x 🔁 every 2 months', { count: 2, unit: 'month' }],
    ['x 🔁 yearly', { count: 1, unit: 'year' }],
    ['x 🔁 every year', { count: 1, unit: 'year' }],
    ['x 🔁 EVERY WEEK', { count: 1, unit: 'week' }],
  ];
  for (const [text, expected] of cases) {
    test(`parses: ${text}`, () => {
      expect(parseRecurrence(text)).toEqual(expected);
    });
  }

  test('returns null when there is no recurrence', () => {
    expect(parseRecurrence('just a task')).toBeNull();
    expect(hasRecurrence('just a task')).toBe(false);
  });
});

describe('nextDate', () => {
  test('daily adds a day', () => {
    expect(nextDate('2026-09-01', { count: 1, unit: 'day' })).toBe('2026-09-02');
    expect(nextDate('2026-12-31', { count: 1, unit: 'day' })).toBe('2027-01-01');
  });

  test('weekly adds 7 days', () => {
    expect(nextDate('2026-09-01', { count: 1, unit: 'week' })).toBe('2026-09-08');
    expect(nextDate('2026-09-01', { count: 2, unit: 'week' })).toBe('2026-09-15');
  });

  test('monthly clamps to the month length', () => {
    expect(nextDate('2026-01-31', { count: 1, unit: 'month' })).toBe('2026-02-28');
    expect(nextDate('2024-01-31', { count: 1, unit: 'month' })).toBe('2024-02-29'); // leap year
    expect(nextDate('2026-01-31', { count: 2, unit: 'month' })).toBe('2026-03-31');
  });

  test('yearly rolls the year', () => {
    expect(nextDate('2026-09-01', { count: 1, unit: 'year' })).toBe('2027-09-01');
    expect(nextDate('2024-02-29', { count: 1, unit: 'year' })).toBe('2025-02-28');
  });
});

describe('completing a recurring task rolls it forward', () => {
  test('archives the done occurrence and creates the next open one', () => {
    const doc = parse('- [ ] Mow lawn 🔁 every week 📅 2026-09-01\n');
    const out = complete(doc, { match: 'Mow' }, { done: '2026-09-01', rng: seededRng(1) });

    // Next open occurrence stays in the timeline, date advanced.
    const next = out.timeline[0];
    expect(next && next.kind === 'task' ? next.text : '').toBe('Mow lawn 🔁 every week');
    expect(next && next.kind === 'task' ? next.dates.due : '').toBe('2026-09-08');
    expect(next && next.kind === 'task' ? next.checked : null).toBe(false);

    // The completed occurrence is archived with the done stamp.
    const done = out.archive?.[0];
    expect(done?.checked).toBe(true);
    expect(done?.dates.done).toBe('2026-09-01');
  });

  test('advances a start date too', () => {
    const doc = parse('- [ ] Review 🔁 every 2 weeks 🛫 2026-09-01 📅 2026-09-04\n');
    const out = complete(doc, { match: 'Review' }, { done: '2026-09-04', rng: seededRng(1) });
    const next = out.timeline[0];
    expect(next && next.kind === 'task' ? next.dates.start : '').toBe('2026-09-15');
    expect(next && next.kind === 'task' ? next.dates.due : '').toBe('2026-09-18');
  });

  test('recurring task round-trips and stays recurring', () => {
    const doc = parse('- [ ] Water plant 🔁 daily\n');
    const out = complete(doc, { match: 'Water' }, { done: '2026-09-01', rng: seededRng(1) });
    const next = out.timeline[0];
    expect(next && next.kind === 'task' ? next.text : '').toBe('Water plant 🔁 daily');
    expect(parseRecurrence((next && next.kind === 'task' ? next.text : '') ?? '')).toEqual({
      count: 1,
      unit: 'day',
    });
  });

  test('a non-recurring task still archives as before', () => {
    const doc = parse('- [ ] One-off 📅 2026-09-01\n');
    const out = complete(doc, { match: 'One-off' }, { done: '2026-09-01', rng: seededRng(1) });
    expect(out.timeline).toHaveLength(0);
    expect(out.archive?.[0]?.text).toBe('One-off');
  });
});
