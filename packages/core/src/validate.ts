/**
 * Validation: reports constraint violations without mutating the document.
 * Events do not partition or place anything, so there are no section checks.
 *
 * Severities:
 *  - error: violates a hard invariant.
 *  - warning: preserved but suspicious (orphan comment, unsupported line).
 *  - info: allowed but noteworthy (a completed task still in the timeline).
 */

import type { TaskDocument, TaskNode } from './model.js';
import { assignPartitions, clampPartition, hasOwnDates } from './sections.js';

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
  const { eventDates, part } = assignPartitions(doc.timeline);
  const n = eventDates.length;

  // Events need a date to sort among tasks.
  for (const node of doc.timeline) {
    if (node.kind === 'task' && node.isEvent && !node.dates.due) {
      issues.push({
        code: 'EVENT_NO_DATE',
        severity: 'error',
        message: `Event "${node.text}" has no 📅 date.`,
        line: node.sourceLine,
      });
    }
  }

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
    checkTask(node, null);
  }

  // Archive checks: completed tasks should carry a done date for deterministic ordering.
  if (doc.archive) {
    for (const root of doc.archive) walkArchive(root);
  }

  return issues;

  function checkTask(task: TaskNode, datedAncestor: number | null): void {
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

    // A dated parent forces its subtree into its partition; a child whose own
    // dates rule that partition out is likely a mistake.
    const p = part.get(task);
    if (datedAncestor !== null && p !== undefined) {
      const natural = clampPartition(datedAncestor, task, eventDates, n);
      if (natural !== p) {
        issues.push({
          code: 'CHILD_OUTSIDE_PARENT',
          severity: 'warning',
          message: `Task "${task.text}" is nested under a dated parent, but its own dates place it outside that parent's event partition.`,
          line: task.sourceLine,
        });
      }
    }

    const childAncestor = hasOwnDates(task) ? (p ?? null) : datedAncestor;
    for (const child of task.children) checkTask(child, childAncestor);
  }

  function walkArchive(task: TaskNode): void {
    if (!task.dates.done && !task.props.parent) {
      // A completed root without a done date orders via text; allowed, notable.
      issues.push({
        code: 'ARCHIVE_NO_DONE',
        severity: 'info',
        message: `Archived task "${task.text}" has no ✅ date; ordering falls back to text.`,
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
