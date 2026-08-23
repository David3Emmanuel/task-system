/**
 * Validation: reports constraint violations without mutating the document.
 * Uses the same section math as the formatter so the two never disagree.
 *
 * Severities:
 *  - error: violates a hard invariant (would make the timeline inconsistent).
 *  - warning: preserved but suspicious (orphan comment, unsupported line).
 *  - info: allowed but noteworthy (a completed task still in the timeline).
 */

import type { TaskDocument, TaskNode, TimelineNode } from './model.js';
import { anchorDate, cmpStr, collectEvents, endDate, sectionIndexByDate } from './sections.js';

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  code: string;
  severity: Severity;
  message: string;
  /** 0-based source line when known. */
  line?: number;
}

export function validate(doc: TaskDocument): Issue[] {
  const issues: Issue[] = [];

  const events = collectEvents(doc.timeline);
  const eventDates = events.map((e) => e.dates.due ?? '');

  // Events must have a date and be strictly increasing IN FILE ORDER (position
  // must already agree with chronology). We check the source sequence, not the
  // sorted one, so an out-of-order event is reported rather than silently sorted.
  const eventsInFileOrder = doc.timeline.filter(
    (n): n is TaskNode => n.kind === 'task' && n.isEvent,
  );
  for (const e of eventsInFileOrder) {
    if (!e.dates.due) {
      issues.push({
        code: 'EVENT_NO_DATE',
        severity: 'error',
        message: `Event "${e.text}" has no 📅 date.`,
        line: e.sourceLine,
      });
    }
  }
  for (let i = 1; i < eventsInFileOrder.length; i++) {
    const prev = eventsInFileOrder[i - 1]!.dates.due ?? '';
    const cur = eventsInFileOrder[i]!.dates.due ?? '';
    if (cur <= prev) {
      issues.push({
        code: 'EVENT_NOT_INCREASING',
        severity: 'error',
        message: `Event dates must strictly increase in file order; ${cur} does not follow ${prev}.`,
        line: eventsInFileOrder[i]!.sourceLine,
      });
    }
  }

  // Section bounds for each dated top-level task.
  const bounds = (idx: number): { lower?: string; upper?: string } => ({
    lower: idx > 0 ? eventDates[idx - 1] : undefined,
    upper: idx < eventDates.length ? eventDates[idx] : undefined,
  });

  for (const node of doc.timeline) {
    if (node.kind === 'unknown') {
      issues.push({
        code: 'UNSUPPORTED_LINE',
        severity: 'warning',
        message: `Unrecognized line preserved verbatim: ${node.text.trim()}`,
        line: node.sourceLine,
      });
      continue;
    }
    if (node.isEvent) continue;
    checkTask(node, true);
  }

  // Archive checks: completed tasks should carry a done date for deterministic ordering.
  if (doc.archive) {
    for (const root of doc.archive) walkArchive(root);
  }

  return issues;

  function checkTask(task: TaskNode, topLevel: boolean): void {
    const { start, due } = task.dates;
    if (start && due && start > due) {
      issues.push({
        code: 'START_AFTER_DUE',
        severity: 'error',
        message: `Task "${task.text}" starts (${start}) after it is due (${due}).`,
        line: task.sourceLine,
      });
    }
    if (task.checked && !task.dates.done) {
      issues.push({
        code: 'DONE_NO_DATE',
        severity: 'info',
        message: `Completed task "${task.text}" has no ✅ date; ordering falls back to text.`,
        line: task.sourceLine,
      });
    }
    if (task.checked) {
      issues.push({
        code: 'COMPLETED_IN_TIMELINE',
        severity: 'info',
        message: `Completed task "${task.text}" is still in the timeline; run \`complete\`/archive to move it.`,
        line: task.sourceLine,
      });
    }

    if (topLevel && !task.checked) {
      const anchor = anchorDate(task);
      if (anchor) {
        const idx = sectionIndexByDate(anchor, eventDates);
        const b = bounds(idx);
        const finish = endDate(task);
        if (b.lower && anchor < b.lower) {
          issues.push({
            code: 'BEFORE_SECTION',
            severity: 'error',
            message: `Task "${task.text}" (${anchor}) starts before its section boundary ${b.lower}.`,
            line: task.sourceLine,
          });
        }
        if (b.upper && finish && finish > b.upper) {
          issues.push({
            code: 'STRADDLES_EVENT',
            severity: 'warning',
            message: `Task "${task.text}" ends ${finish}, past the next event ${b.upper}; it straddles an event.`,
            line: task.sourceLine,
          });
        }
      }
    }
    for (const child of task.children) checkTask(child, false);
  }

  function walkArchive(task: TaskNode): void {
    if (!task.dates.done && !task.props.parent) {
      // A completed root without a done date orders non-deterministically only via text.
      issues.push({
        code: 'ARCHIVE_NO_DONE',
        severity: 'warning',
        message: `Archived task "${task.text}" has no ✅ date.`,
        line: task.sourceLine,
      });
    }
    for (const child of task.children) walkArchive(child);
  }
}

/** Convenience: does the document have any error-level issue the formatter owns? */
export function hasBlockingErrors(issues: Issue[]): boolean {
  return issues.some((i) => i.severity === 'error');
}

export { cmpStr };
