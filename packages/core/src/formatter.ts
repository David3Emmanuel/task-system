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
  assignPartitions,
  cmpStr,
  cmpText,
  sectionIndexByPosition,
  sortWithAttached,
  stableSort,
} from './sections.js';
import { nextDate } from './recurrence.js';
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

/** A node that carries its own date (start or due) — a sortable anchor. */
function isDated(node: TaskNode): boolean {
  return node.dates.start !== undefined || node.dates.due !== undefined;
}

/** Sort key for a dated node: its anchor date. */
function anchorKey(node: TaskNode): string {
  return anchorDate(node) ?? '';
}

interface Placement {
  /** partition index -> ordered nodes */
  partitions: TimelineNode[][];
  events: TaskNode[];
}

/**
 * Place the timeline by events:
 *   - a dated task is clamped toward its current partition (minimal movement);
 *   - a dated parent forces its subtree into the parent's partition;
 *   - an undated task follows its children (or the dated sibling above it);
 *   - a fully undated parent whose children land in different partitions splits.
 */
function placeTimeline(roots: TimelineNode[]): Placement {
  const { events, eventDates, part } = assignPartitions(roots);
  const n = eventDates.length;

  function partitionsOf(node: TaskNode): Set<number> {
    const set = new Set<number>([part.get(node)!]);
    for (const child of node.children) {
      for (const x of partitionsOf(child)) set.add(x);
    }
    return set;
  }

  function fragment(node: TaskNode, q: number): TaskNode {
    const kids = node.children
      .filter((child) => partitionsOf(child).has(q))
      .map((child) => fragment(child, q));
    return { ...node, children: sortWithAttached(kids, isDated, anchorKey) };
  }

  type Entry = { kind: 'task'; node: TaskNode } | { kind: 'unknown'; node: UnknownNode };
  const entries: Entry[][] = Array.from({ length: n + 1 }, () => []);

  for (const node of roots) {
    if (node.kind === 'unknown') {
      entries[sectionIndexByPosition(node, roots)]!.push({ kind: 'unknown', node });
      continue;
    }
    if (node.isEvent) continue;
    const ps = [...partitionsOf(node)].sort((a, b) => a - b);
    ps.forEach((q, idx) => {
      const frag = fragment(node, q);
      if (ps.length > 1) {
        frag.text = `${node.text} (part ${idx + 1})`;
        if (!node.dates.start && !node.dates.due) {
          frag.dates = {
            start: q > 0 ? nextDate(eventDates[q - 1]!, { count: 1, unit: 'day' }) : undefined,
            due: q < n ? nextDate(eventDates[q]!, { count: -1, unit: 'day' }) : undefined,
          };
        }
      }
      entries[q]!.push({ kind: 'task', node: frag });
    });
  }

  // Sort tasks within each partition; unknown lines keep their relative spot.
  const partitions: TimelineNode[][] = entries.map((items) => {
    const unknowns: { at: number; node: UnknownNode }[] = [];
    const tasks: TaskNode[] = [];
    items.forEach((e, j) => {
      if (e.kind === 'unknown') unknowns.push({ at: j, node: e.node });
      else tasks.push(e.node);
    });
    const sorted = sortWithAttached(tasks, isDated, anchorKey);
    const out: TimelineNode[] = [];
    let t = 0;
    for (let j = 0; j < items.length; j++) {
      const u = unknowns.find((x) => x.at === j);
      out.push(u ? u.node : sorted[t++]!);
    }
    return out;
  });

  return { partitions, events };
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

  const { partitions, events } = placeTimeline(d.timeline);
  const hasContent = partitions.some((p) => p.length > 0) || events.length > 0;
  if (hasContent && out.length > 0) out.push('');

  const blockStart = () => {
    if (out.length > 0 && out[out.length - 1] !== '') out.push('');
  };

  for (let p = 0; p < partitions.length; p++) {
    const nodes = partitions[p]!;
    for (const node of nodes) renderNode(node, 0, out);
    if (p < events.length) {
      if (nodes.length > 0) out.push('');
      renderNode(events[p]!, 0, out);
      if (p + 1 < partitions.length) out.push('');
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
