import { expect, test, describe } from 'vitest';
import { parse, format, validate } from '../src/index.js';

const rt = (s: string) => format(parse(s));

describe('canonical field order and spacing', () => {
  test('reorders fields to text, start, due, done, created, props', () => {
    const out = rt('- [ ] Ship [id:: abc] ➕ 2026-07-01 📅 2026-08-10 🛫 2026-08-01\n');
    expect(out).toBe('- [ ] Ship 🛫 2026-08-01 📅 2026-08-10 ➕ 2026-07-01 [id:: abc]\n');
  });

  test('normalizes indentation to two spaces', () => {
    const out = rt('- [ ] Parent\n\t- [ ] Child\n');
    expect(out).toBe('- [ ] Parent\n  - [ ] Child\n');
  });
});

describe('idempotence', () => {
  const samples = [
    '- [ ] A 📅 2026-08-10\n- [ ] B 🛫 2026-08-02\n',
    '# Title\n\n- [ ] 🏁 M1 📅 2026-08-10\n- [ ] After 🛫 2026-08-11 📅 2026-08-12\n',
    '- [ ] Parent\n  - [ ] Child 2\n  - [ ] Child 1\n',
    '---\ntags: [x]\n---\n# T\n\n- [ ] A\n\n## Archive\n\n- [x] Old ✅ 2026-07-01\n',
  ];
  for (const [i, s] of samples.entries()) {
    test(`format is idempotent (sample ${i})`, () => {
      const once = format(parse(s));
      const twice = format(parse(once));
      expect(twice).toBe(once);
    });
  }
});

describe('confluence: canonical form is independent of input order', () => {
  test('sibling order does not matter', () => {
    const a = rt('- [ ] Beta 📅 2026-08-05\n- [ ] Alpha 📅 2026-08-03\n');
    const b = rt('- [ ] Alpha 📅 2026-08-03\n- [ ] Beta 📅 2026-08-05\n');
    expect(a).toBe(b);
  });

  test('event order does not matter', () => {
    const a = rt('- [ ] 🏁 Later 📅 2026-09-01\n- [ ] 🏁 Earlier 📅 2026-08-01\n');
    const b = rt('- [ ] 🏁 Earlier 📅 2026-08-01\n- [ ] 🏁 Later 📅 2026-09-01\n');
    expect(a).toBe(b);
    expect(a.indexOf('Earlier')).toBeLessThan(a.indexOf('Later'));
  });
});

describe('section placement', () => {
  test('a task lands in the section its dates select', () => {
    const src = [
      '- [ ] 🏁 Sprint 1 📅 2026-08-10',
      '- [ ] 🏁 Sprint 2 📅 2026-08-20',
      '- [ ] Do later 🛫 2026-08-15 📅 2026-08-18',
      '- [ ] Do first 📅 2026-08-05',
    ].join('\n');
    const out = format(parse(src));
    const lines = out
      .trim()
      .split('\n')
      .filter((l) => l.trim() !== '');
    // Expect: Do first, Sprint 1, Do later, Sprint 2
    expect(lines[0]).toContain('Do first');
    expect(lines[1]).toContain('Sprint 1');
    expect(lines[2]).toContain('Do later');
    expect(lines[3]).toContain('Sprint 2');
  });

  test('boundary date binds a task to the section after the event', () => {
    const src = ['- [ ] 🏁 M 📅 2026-08-10', '- [ ] On the day 🛫 2026-08-10 📅 2026-08-10'].join(
      '\n',
    );
    const out = format(parse(src));
    const lines = out
      .trim()
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(lines[0]).toContain('M');
    expect(lines[1]).toContain('On the day');
  });
});

describe('validation', () => {
  test('flags non-increasing events', () => {
    const issues = validate(parse('- [ ] 🏁 A 📅 2026-08-10\n- [ ] 🏁 B 📅 2026-08-01\n'));
    expect(issues.some((i) => i.code === 'EVENT_NOT_INCREASING')).toBe(true);
  });

  test('flags a task that straddles an event', () => {
    const src = ['- [ ] 🏁 M 📅 2026-08-10', '- [ ] Straddler 🛫 2026-08-05 📅 2026-08-15'].join(
      '\n',
    );
    const issues = validate(parse(src));
    expect(issues.some((i) => i.code === 'STRADDLES_EVENT')).toBe(true);
  });

  test('flags start after due', () => {
    const issues = validate(parse('- [ ] Bad 🛫 2026-08-10 📅 2026-08-01\n'));
    expect(issues.some((i) => i.code === 'START_AFTER_DUE')).toBe(true);
  });

  test('clean document has no errors', () => {
    const src = ['- [ ] 🏁 M 📅 2026-08-10', '- [ ] Fine 📅 2026-08-05'].join('\n');
    const issues = validate(parse(src));
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  test('formatter output validates clean for a valid input', () => {
    const src = [
      '- [ ] 🏁 M 📅 2026-08-10',
      '- [ ] Fine 📅 2026-08-05',
      '- [ ] Later 🛫 2026-08-12',
    ].join('\n');
    const issues = validate(parse(format(parse(src))));
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });
});
