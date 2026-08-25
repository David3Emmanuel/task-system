import { expect, test, describe } from 'vitest';
import { validate, hasBlockingErrors } from '../src/validate.js';
import { parse } from '../src/index.js';
import type { Issue, Severity } from '../src/validate.js';

const codes = (issues: Issue[]) => issues.map((i) => i.code);
const bySeverity = (issues: Issue[], s: Severity) => issues.filter((i) => i.severity === s);

describe('clean documents', () => {
  test('a valid timeline with events has no errors', () => {
    const src = [
      '- [ ] 🏁 M 📅 2026-08-10',
      '- [ ] Fine 📅 2026-08-05',
      '- [ ] Later 🛫 2026-08-12 📅 2026-08-15',
    ].join('\n');
    expect(bySeverity(validate(parse(src)), 'error')).toEqual([]);
  });

  test('an empty document validates clean', () => {
    expect(validate(parse(''))).toEqual([]);
  });

  test('hasBlockingErrors is false with only warnings/info', () => {
    const issues = validate(parse('%% orphan\n\n- [ ] A\n'));
    expect(hasBlockingErrors(issues)).toBe(false);
  });
});

describe('events', () => {
  test('EVENT_NO_DATE: an event without a date', () => {
    const issues = validate(parse('- [ ] 🏁 Undated event\n'));
    expect(codes(issues)).toContain('EVENT_NO_DATE');
    expect(bySeverity(issues, 'error')).toHaveLength(1);
  });

  test('EVENT_NOT_INCREASING: dates not strictly increasing in file order', () => {
    const issues = validate(parse('- [ ] 🏁 A 📅 2026-08-10\n- [ ] 🏁 B 📅 2026-08-01\n'));
    expect(codes(issues)).toContain('EVENT_NOT_INCREASING');
  });

  test('equal event dates are not increasing either', () => {
    const issues = validate(parse('- [ ] 🏁 A 📅 2026-08-10\n- [ ] 🏁 B 📅 2026-08-10\n'));
    expect(codes(issues)).toContain('EVENT_NOT_INCREASING');
  });
});

describe('unknown lines', () => {
  test('UNSUPPORTED_LINE: an unrecognized line is a warning', () => {
    const issues = validate(parse('Some prose\n- [ ] A\n'));
    expect(codes(issues)).toContain('UNSUPPORTED_LINE');
    expect(bySeverity(issues, 'warning')).toHaveLength(1);
  });
});

describe('task field constraints', () => {
  test('START_AFTER_DUE: start is later than due', () => {
    const issues = validate(parse('- [ ] Bad 🛫 2026-08-10 📅 2026-08-01\n'));
    expect(codes(issues)).toContain('START_AFTER_DUE');
    expect(bySeverity(issues, 'error')).toHaveLength(1);
  });

  test('a valid start<=due produces no error', () => {
    const issues = validate(parse('- [ ] Ok 🛫 2026-08-01 📅 2026-08-10\n'));
    expect(codes(issues)).not.toContain('START_AFTER_DUE');
  });

  test('DONE_NO_DATE: a checked task without a done date is info', () => {
    const issues = validate(parse('- [x] Checked, no date\n'));
    expect(codes(issues)).toContain('DONE_NO_DATE');
    expect(bySeverity(issues, 'info').some((i) => i.code === 'DONE_NO_DATE')).toBe(true);
  });

  test('COMPLETED_IN_TIMELINE: a checked task still in the timeline is info', () => {
    const issues = validate(parse('- [x] Done but not archived ✅ 2026-08-01\n'));
    expect(codes(issues)).toContain('COMPLETED_IN_TIMELINE');
  });
});

describe('section bounds', () => {
  test('STRADDLES_EVENT: a task spanning past the next event is a warning, not an error', () => {
    const src = ['- [ ] 🏁 M 📅 2026-08-10', '- [ ] Straddler 🛫 2026-08-05 📅 2026-08-15'].join(
      '\n',
    );
    const issues = validate(parse(src));
    expect(codes(issues)).toContain('STRADDLES_EVENT');
    expect(bySeverity(issues, 'error').some((i) => i.code === 'STRADDLES_EVENT')).toBe(false);
    expect(bySeverity(issues, 'warning').some((i) => i.code === 'STRADDLES_EVENT')).toBe(true);
  });

  test('a straddling task no longer blocks validation', () => {
    const src = ['- [ ] 🏁 M 📅 2026-08-10', '- [ ] Straddler 🛫 2026-08-05 📅 2026-08-15'].join(
      '\n',
    );
    expect(hasBlockingErrors(validate(parse(src)))).toBe(false);
  });

  test('a task whose span ends exactly at the next event does not straddle', () => {
    const src = ['- [ ] 🏁 M 📅 2026-08-10', '- [ ] Boundary 🛫 2026-08-05 📅 2026-08-10'].join(
      '\n',
    );
    const issues = validate(parse(src));
    expect(codes(issues)).not.toContain('STRADDLES_EVENT');
  });

  test('a task anchored on an event date does not trigger a boundary error', () => {
    const src = ['- [ ] 🏁 M 📅 2026-08-10', '- [ ] On the day 📅 2026-08-10'].join('\n');
    const issues = validate(parse(src));
    expect(bySeverity(issues, 'error')).toEqual([]);
  });
});

describe('archive', () => {
  test('ARCHIVE_NO_DONE: an archived root without a done date is info, not a warning', () => {
    const src = ['# T', '', '- [ ] A', '', '## Archive', '', '- [x] Old'].join('\n');
    const issues = validate(parse(src));
    expect(codes(issues)).toContain('ARCHIVE_NO_DONE');
    expect(bySeverity(issues, 'info').some((i) => i.code === 'ARCHIVE_NO_DONE')).toBe(true);
    expect(bySeverity(issues, 'warning').some((i) => i.code === 'ARCHIVE_NO_DONE')).toBe(false);
  });

  test('an archived task with a done date does not report ARCHIVE_NO_DONE', () => {
    const src = ['# T', '', '- [ ] A', '', '## Archive', '', '- [x] Old ✅ 2026-07-01'].join('\n');
    const issues = validate(parse(src));
    expect(codes(issues)).not.toContain('ARCHIVE_NO_DONE');
  });
});

describe('issue metadata', () => {
  test('issues carry a 0-based source line', () => {
    const issues = validate(parse('Some prose\n- [ ] A\n'));
    const line = issues.find((i) => i.code === 'UNSUPPORTED_LINE')?.line;
    expect(line).toBe(0);
  });

  test('hasBlockingErrors is true when any error exists', () => {
    const issues = validate(parse('- [ ] 🏁 No date\n'));
    expect(hasBlockingErrors(issues)).toBe(true);
  });
});
