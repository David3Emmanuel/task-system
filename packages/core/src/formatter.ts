/**
 * Deterministic formatter: TaskDocument -> canonical Markdown text.
 *
 * Guarantees:
 *  - Idempotent: format(format(x)) === format(x).
 *  - Confluent: canonical form depends only on content, not on input ordering
 *    of siblings/sections (a total-order tiebreak makes the sort unique).
 *  - Id-stable: never invents or strips [id::]/[parent::]/[section::].
 *  - No wall-clock: output is a pure function of the AST.
 *
 * Pipeline (timeline):
 *  1. Collect + sort top-level events by date.
 *  2. Compute section membership: undated/completed roots by original position,
 *     open dated roots by anchor date (start ?? due).
 *  3. Within each section, order: open-dated, then open-undated, then completed.
 *  4. Recurse into children with the same ordering.
 *  5. Emit sections interleaved with events, then the archive.
 */

import type { IsoDate, TaskDocument, TaskNode, TimelineNode, UnknownNode } from './model.js';
import { ARCHIVE_HEADER, EMOJI } from './model.js';
import {
  anchorDate,
  cmpStr,
  cmpText,
  collectEvents,
  sectionIndexByDate,
  sectionIndexByPosition,
  stableSort,
} from './sections.js';
import { archiveInTimeline } from './ops.js';

const SENTINEL = '￿'; // sorts after any real date

/** Serialize a task node to its canonical line body (without indentation). */
export function serializeLine(node: TaskNode): string {
  const box = node.checked ? '[x]' : '[ ]';
  const parts: string[] = [`- ${box}`];
  if (node.isEvent) parts.push(EMOJI.event);
  if (node.text) parts.push(node.text);
  if (node.dates.start) parts.push(`${EMOJI.start} ${node.dates.start}`);
  if (node.dates.due) parts.push(`${EMOJI.due} ${node.dates.due}`);
  if (node.dates.done) parts.push(`${EMOJI.done} ${node.dates.done}`);
  if (node.dates.created) parts.push(`${EMOJI.created} ${node.dates.created}`);
  if (node.props.id) parts.push(`[id:: ${node.props.id}]`);
  if (node.props.parent) parts.push(`[parent:: ${node.props.parent}]`);
  if (node.props.section) parts.push(`[section:: ${node.props.section}]`);
  return parts.join(' ');
}

/** Total-order sort key builder for a task, using the canonical line as final tiebreak. */
type Kind = 'openDated' | 'openUndated' | 'completed';

function nodeKind(node: TaskNode): Kind {
  if (node.checked) return 'completed';
  return anchorDate(node) ? 'openDated' : 'openUndated';
}

function compareSiblings(a: TaskNode, b: TaskNode): number {
  // Events always sort before non-events on the same tier is handled by placement,
  // but within children (no events) this is a no-op.
  const ka = nodeKind(a);
  const kb = nodeKind(b);
  const tier: Record<Kind, number> = { openDated: 0, openUndated: 1, completed: 2 };
  if (tier[ka] !== tier[kb]) return tier[ka] - tier[kb];

  if (ka === 'openDated') {
    const as = anchorDate(a)!;
    const bs = anchorDate(b)!;
    const ad = a.dates.due ?? as;
    const bd = b.dates.due ?? bs;
    return (
      cmpStr(as, bs) ||
      cmpStr(ad, bd) ||
      cmpText(a.text, b.text) ||
      cmpStr(serializeLine(a), serializeLine(b))
    );
  }
  if (ka === 'openUndated') {
    return cmpText(a.text, b.text) || cmpStr(serializeLine(a), serializeLine(b));
  }
  // completed
  const ad = a.dates.done ?? SENTINEL;
  const bd = b.dates.done ?? SENTINEL;
  return cmpStr(ad, bd) || cmpText(a.text, b.text) || cmpStr(serializeLine(a), serializeLine(b));
}

function sortChildren(node: TaskNode): TaskNode {
  const kids = stableSort(node.children, compareSiblings).map(sortChildren);
  return { ...node, children: kids };
}

interface Placed {
  /** section index -> ordered nodes (tasks/unknowns) */
  sections: TimelineNode[][];
  events: TaskNode[];
}

/** Assign every top-level node to a section and order within each section. */
function placeTimeline(roots: TimelineNode[]): Placed {
  const events = collectEvents(roots);
  const eventDates = events.map((e) => e.dates.due ?? '');
  const sectionCount = events.length + 1;
  const sections: TimelineNode[][] = Array.from({ length: sectionCount }, () => []);

  for (const node of roots) {
    if (node.kind === 'unknown') {
      // Unknown lines keep their positional section (stable, never relocated).
      sections[sectionIndexByPosition(node, roots)]!.push(node);
      continue;
    }
    if (node.isEvent) continue; // events are the separators, emitted between sections

    const task = sortChildren(node);
    let idx: number;
    if (!task.checked && anchorDate(task)) {
      idx = sectionIndexByDate(anchorDate(task)!, eventDates);
    } else {
      // undated or completed-in-place: positional
      idx = sectionIndexByPosition(node, roots);
    }
    sections[idx]!.push(task);
  }

  // Order each section: dated, undated, completed; unknowns keep their spot.
  for (const section of sections) {
    orderSection(section);
  }
  return { sections, events };
}

function orderSection(section: TimelineNode[]): void {
  // Separate unknowns (position-stable) from tasks (sortable), then reinterleave
  // by keeping unknowns at their original relative indices.
  const unknownAt = new Map<number, UnknownNode>();
  const tasks: TaskNode[] = [];
  section.forEach((n, i) => {
    if (n.kind === 'unknown') unknownAt.set(i, n);
    else tasks.push(n);
  });
  const sortedTasks = stableSort(tasks, compareSiblings);
  const result: TimelineNode[] = [];
  let t = 0;
  for (let i = 0; i < section.length; i++) {
    if (unknownAt.has(i)) result.push(unknownAt.get(i)!);
    else result.push(sortedTasks[t++]!);
  }
  section.length = 0;
  section.push(...result);
}

function renderNode(node: TimelineNode, depth: number, out: string[]): void {
  const indent = '  '.repeat(depth);
  if (node.kind === 'unknown') {
    out.push(node.text);
    return;
  }
  for (const c of node.comments) out.push(`${indent}${c}`);
  out.push(`${indent}${serializeLine(node)}`);
  for (const child of node.children) renderNode(child, depth + 1, out);
}

/** Order archive roots and re-nest [parent::] children under matching parents. */
function orderArchive(roots: TaskNode[]): TaskNode[] {
  const byId = new Map<string, TaskNode>();
  for (const r of roots) if (r.props.id) byId.set(r.props.id, r);

  // Re-nest: a root with [parent:: id] pointing at another archived root moves
  // under it (drop the now-redundant parent prop).
  const topLevel: TaskNode[] = [];
  const consumed = new Set<TaskNode>();
  for (const r of roots) {
    const pid = r.props.parent;
    if (pid && byId.has(pid) && byId.get(pid) !== r) {
      const parent = byId.get(pid)!;
      const child: TaskNode = { ...r, props: { ...r.props } };
      delete child.props.parent;
      parent.children = [...parent.children, child];
      consumed.add(r);
    }
  }
  for (const r of roots) if (!consumed.has(r)) topLevel.push(r);

  const sortRec = (n: TaskNode): TaskNode => ({
    ...n,
    children: stableSort(n.children, compareSiblings).map(sortRec),
  });
  return stableSort(topLevel, compareSiblings).map(sortRec);
}

export function format(doc: TaskDocument): string {
  // Completed tasks still in the timeline are canonicalized into the archive
  // (with reversible parent/section bookkeeping), then placed as usual.
  const d = archiveInTimeline(doc);
  const out: string[] = [];

  if (d.frontmatter !== null) {
    out.push('---');
    if (d.frontmatter !== '') out.push(...d.frontmatter.split('\n'));
    out.push('---');
  }
  if (d.title !== null) {
    if (out.length > 0) out.push('');
    out.push(`# ${d.title}`);
  }

  const { sections, events } = placeTimeline(d.timeline);
  const timelineHasContent = sections.some((s) => s.length > 0) || events.length > 0;
  if (timelineHasContent && out.length > 0) out.push('');

  const blockStart = () => {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
  };

  for (let s = 0; s < sections.length; s++) {
    const section = sections[s]!;
    for (const node of section) renderNode(node, 0, out);
    const event = events[s];
    if (event) {
      // Blank line before each event separates sections visually.
      if (section.length > 0) out.push('');
      renderNode(event, 0, out);
      if (s + 1 < sections.length && sections[s + 1]!.length > 0) out.push('');
    }
  }

  if (d.archive !== null) {
    blockStart();
    out.push(ARCHIVE_HEADER);
    out.push('');
    const ordered = orderArchive(d.archive);
    for (const node of ordered) renderNode(node, 0, out);
  }

  // Trim trailing blanks, ensure single final newline.
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.length === 0 ? '' : out.join('\n') + '\n';
}

export function formatText(text: string, parseFn: (t: string) => TaskDocument): string {
  return format(parseFn(text));
}

export type { IsoDate };
