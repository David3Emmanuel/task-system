import { expect, test, describe } from 'vitest';
import { format, parse } from '../src/index.js';

const rt = (s: string) => format(parse(s));

describe('splitting a parent whose span crosses an event', () => {
  test('splits around one event and distributes subtasks by anchor', () => {
    const src = [
      '- [ ] 🏁 Event 📅 2026-08-29',
      '- [ ] Project 🛫 2026-08-24 📅 2026-08-31',
      '  - [ ] Subtask before 📅 2026-08-25',
      '  - [ ] Subtask after 🛫 2026-08-30 📅 2026-08-31',
    ].join('\n');
    const out = rt(src);
    expect(out).toContain('- [ ] Project (part 1)');
    expect(out).toContain('- [ ] Project (part 2)');
    // part 1 is before the event, part 2 after it
    const p1 = out.indexOf('Project (part 1)');
    const ev = out.indexOf('🏁 Event');
    const p2 = out.indexOf('Project (part 2)');
    expect(p1).toBeLessThan(ev);
    expect(ev).toBeLessThan(p2);
    // subtasks distributed
    expect(out.slice(p1, ev)).toContain('Subtask before');
    expect(out.slice(p2)).toContain('Subtask after');
  });

  test('clamps part dates to their gaps (no straddle remains)', () => {
    const src = [
      '- [ ] 🏁 Event 📅 2026-08-29',
      '- [ ] Project 🛫 2026-08-24 📅 2026-08-31',
      '  - [ ] A 📅 2026-08-25',
      '  - [ ] B 📅 2026-08-30',
    ].join('\n');
    const out = rt(src);
    // part 1 due = day before event; part 2 start = day after
    expect(out).toContain('Project (part 1) 🛫 2026-08-24 📅 2026-08-28');
    expect(out).toContain('Project (part 2) 🛫 2026-08-30');
  });

  test('no split when every subtask lands on one side', () => {
    const src = [
      '- [ ] 🏁 Event 📅 2026-08-29',
      '- [ ] Project 🛫 2026-08-24 📅 2026-08-31',
      '  - [ ] A 📅 2026-08-25',
      '  - [ ] B 📅 2026-08-26',
    ].join('\n');
    const out = rt(src);
    expect(out).not.toContain('(part');
    expect(out).toContain('- [ ] Project 🛫 2026-08-24 📅 2026-08-31');
  });

  test('no split when there is no event in the span', () => {
    const src = ['- [ ] Project 🛫 2026-08-24 📅 2026-08-31', '  - [ ] A 📅 2026-08-25'].join('\n');
    expect(rt(src)).not.toContain('(part');
  });

  test('is idempotent', () => {
    const src = [
      '- [ ] 🏁 Event 📅 2026-08-29',
      '- [ ] Project 🛫 2026-08-24 📅 2026-08-31',
      '  - [ ] A 📅 2026-08-25',
      '  - [ ] B 📅 2026-08-30',
    ].join('\n');
    const once = rt(src);
    expect(rt(once)).toBe(once);
  });

  test('handles multiple events within the span', () => {
    const src = [
      '- [ ] 🏁 E1 📅 2026-08-20',
      '- [ ] 🏁 E2 📅 2026-08-30',
      '- [ ] Project 🛫 2026-08-15 📅 2026-09-05',
      '  - [ ] A 📅 2026-08-18',
      '  - [ ] B 📅 2026-08-25',
      '  - [ ] C 📅 2026-09-02',
    ].join('\n');
    const out = rt(src);
    expect(out).toContain('Project (part 1)');
    expect(out).toContain('Project (part 2)');
    expect(out).toContain('Project (part 3)');
    expect(out.slice(out.indexOf('Project (part 1)'), out.indexOf('🏁 E1'))).toContain('A');
    expect(out.slice(out.indexOf('🏁 E1'), out.indexOf('🏁 E2'))).toContain('B');
    expect(out.slice(out.indexOf('Project (part 3)'))).toContain('C');
  });
});
