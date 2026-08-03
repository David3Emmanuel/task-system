/**
 * Section model shared by the formatter and validator so their placement logic
 * can never disagree.
 *
 * Top-level events partition the timeline. With event dates E0 < E1 < ... the
 * sections are:
 *   S0  = before E0
 *   Sk  = between E(k-1) and E(k)
 *   Sn  = after E(n-1)
 *
 * Placement of a dated task uses the anchor date (start ?? due):
 *   sectionIndex = count(events whose date <= anchor)
 * This resolves the both-inclusive boundary tie deterministically: a task whose
 * anchor equals an event date lands in the section AFTER that event.
 *
 * The upper bound (due <= next event date) is a *validity* constraint, not a
 * placement input — a task whose span straddles the next event is placed by its
 * anchor and flagged by the validator.
 */

import type { TaskNode, TimelineNode } from './model.js';

export interface Sectioning {
  /** Top-level events, in the order they will be emitted (sorted by date). */
  events: TaskNode[];
  /** Sorted event dates, parallel to `events`. */
  eventDates: string[];
}

export function anchorDate(node: TaskNode): string | undefined {
  return node.dates.start ?? node.dates.due;
}

export function endDate(node: TaskNode): string | undefined {
  return node.dates.due ?? node.dates.start;
}

/** Stable sort of top-level events by date. */
export function collectEvents(roots: TimelineNode[]): TaskNode[] {
  const events = roots.filter((n): n is TaskNode => n.kind === 'task' && n.isEvent);
  return stableSort(events, (a, b) => cmpStr(a.dates.due ?? '', b.dates.due ?? ''));
}

/**
 * Section index for a dated task: number of events whose date <= the task's
 * anchor date. Callers pass the sorted event date list.
 */
export function sectionIndexByDate(anchor: string, eventDates: string[]): number {
  let count = 0;
  for (const d of eventDates) {
    if (d <= anchor) count++;
    else break; // eventDates is sorted ascending
  }
  return count;
}

/**
 * Section index for an undated or completed task, decided by original file
 * position: the number of events that appeared before it in the source order.
 */
export function sectionIndexByPosition(node: TimelineNode, roots: TimelineNode[]): number {
  let count = 0;
  for (const r of roots) {
    if (r === node) break;
    if (r.kind === 'task' && r.isEvent) count++;
  }
  return count;
}

export function stableSort<T>(arr: readonly T[], cmp: (a: T, b: T) => number): T[] {
  return arr
    .map((v, i) => [v, i] as const)
    .sort((a, b) => cmp(a[0], b[0]) || a[1] - b[1])
    .map(([v]) => v);
}

export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Case-folded text compare with a codepoint tiebreak for a total order. */
export function cmpText(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return cmpStr(la, lb) || cmpStr(a, b);
}
