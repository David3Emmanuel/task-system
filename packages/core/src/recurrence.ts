/**
 * Recurrence rules for tasks, written Obsidian-style in the task text:
 *
 *   - [ ] Mow lawn 🔁 every week 📅 2026-09-01
 *   - [ ] Standup notes 🔁 daily
 *   - [ ] Backup 🔁 every 2 weeks
 *
 * A rule is anchored to the task's dates (no wall-clock): when a recurring task
 * is completed, its next occurrence is derived by advancing the current due/start
 * date by the rule's interval. `parseRecurrence` reads the rule from the task
 * text; `nextDate` advances an ISO date by that rule deterministically.
 *
 * Accepted forms (case-insensitive), after the `🔁`:
 *   daily | every day                  -> +1 day
 *   every <n> days                     -> +n days
 *   weekly | every week                -> +7 days
 *   biweekly | every <n> weeks         -> +7*n days
 *   monthly | every month              -> +1 calendar month
 *   every <n> months                   -> +n calendar months
 *   yearly | every year                -> +1 year
 *   every <n> years                    -> +n years
 */

export type RecurUnit = 'day' | 'week' | 'month' | 'year';

export interface Recurrence {
  count: number;
  unit: RecurUnit;
}

/** True when the text carries a `🔁` recurrence rule. */
export function hasRecurrence(text: string): boolean {
  return parseRecurrence(text) !== null;
}

/** Parse the `🔁 <rule>` recurrence from a task's text, or null if none. */
export function parseRecurrence(text: string): Recurrence | null {
  const i = text.indexOf('🔁');
  if (i === -1) return null;
  // 🔁 is a surrogate pair (2 UTF-16 code units); slice past the whole emoji.
  const rest = text.slice(i + '🔁'.length).trim();

  // Optional "every" prefix, then either a shorthand word or "N <unit>".
  const s = rest.replace(/^every\s+/i, '');

  const shorthands: Record<string, Recurrence> = {
    daily: { count: 1, unit: 'day' },
    weekly: { count: 1, unit: 'week' },
    biweekly: { count: 2, unit: 'week' },
    monthly: { count: 1, unit: 'month' },
    yearly: { count: 1, unit: 'year' },
  };
  const lower = s.toLowerCase().split(/\s+/)[0] ?? '';
  const shorthand = shorthands[lower];
  if (shorthand) return shorthand;

  const m = s.match(/^(\d+)\s*((?:day|week|month|year)s?)/i);
  if (m) {
    return { count: Number(m[1]), unit: normalizeUnit(m[2]!) };
  }
  const w = s.match(/^((?:day|week|month|year)s?)/i);
  if (w) return { count: 1, unit: normalizeUnit(w[1]!) };
  return null;
}

function normalizeUnit(raw: string): RecurUnit {
  return raw.toLowerCase().replace(/s$/, '') as RecurUnit;
}

/** Advance an ISO `YYYY-MM-DD` date by a recurrence interval. */
export function nextDate(iso: string, rule: Recurrence): string {
  const [y, mo, d] = iso.split('-').map(Number);
  if (!y || !mo || !d) return iso;
  if (rule.unit === 'day') return addDays(y, mo, d, rule.count);
  if (rule.unit === 'week') return addDays(y, mo, d, rule.count * 7);
  if (rule.unit === 'month') return addMonths(y, mo, d, rule.count);
  return addMonths(y, mo, d, rule.count * 12); // year
}

function addDays(y: number, mo: number, d: number, n: number): string {
  const ms = Date.UTC(y, mo - 1, d) + n * 86_400_000;
  const dt = new Date(ms);
  return fmt(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function addMonths(y: number, mo: number, d: number, n: number): string {
  const total = mo - 1 + n;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12;
  const nd = Math.min(d, daysInMonth(ny, nm + 1));
  return fmt(ny, nm + 1, nd);
}

function daysInMonth(y: number, mo: number): number {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}

function fmt(y: number, mo: number, d: number): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${y}-${p(mo)}-${p(d)}`;
}
