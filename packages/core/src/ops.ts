/**
 * Task operations: pure AST -> AST transforms.
 *
 * Every function takes a TaskDocument and returns a new one; inputs are never
 * mutated (structural sharing where safe, deep copies where a node moves). The
 * formatter owns ordering/placement, so these operations only concern
 * themselves with *structure*: where a node lives (timeline vs archive, and
 * under which parent), its fields, and the minimal id/parent/section
 * bookkeeping that makes `complete` and `unarchive` exact inverses.
 *
 * Determinism: no wall-clock. `complete` requires an explicit done date so
 * tests are reproducible; callers that want "today" pass it in.
 */

import type { IsoDate, TaskDocument, TaskNode, TimelineNode } from './model.js';
import { makeTask, walkAll } from './model.js';
import { mintId, seededRng, type Rng } from './ids.js';
import { anchorDate, sectionIndexByPosition } from './sections.js';
import { nextDate, parseRecurrence, type Recurrence } from './recurrence.js';

/* -------------------------------------------------------------------------- */
/* Locators                                                                    */
/* -------------------------------------------------------------------------- */

/** How a caller points at a task. `line` is a 0-based source line. */
export type Locator = { line: number } | { id: string } | { match: string };

/** Result of a locate: the node plus enough context to splice it out. */
interface Located {
  node: TaskNode;
  /** The actual array the node lives in (real reference, safe to splice). */
  siblings: TimelineNode[];
  /** Index within `siblings`. */
  index: number;
  /** Parent task, or null when the node is a timeline/archive root. */
  parent: TaskNode | null;
  /** Which region the node was found in. */
  region: 'timeline' | 'archive';
}

function matchesLocator(node: TaskNode, loc: Locator): boolean {
  if ('line' in loc) return node.sourceLine === loc.line;
  if ('id' in loc) return node.props.id === loc.id;
  return node.text.toLowerCase().includes(loc.match.toLowerCase());
}

/**
 * Find the first node matching `loc`, tracking the real container array so the
 * caller can splice it. Depth-first, top-level roots before their descendants.
 */
function locate(
  roots: TimelineNode[],
  loc: Locator,
  region: 'timeline' | 'archive',
): Located | null {
  const search = (siblings: TimelineNode[], parent: TaskNode | null): Located | null => {
    for (let i = 0; i < siblings.length; i++) {
      const node = siblings[i]!;
      if (node.kind !== 'task') continue;
      if (matchesLocator(node, loc)) {
        return { node, siblings, index: i, parent, region };
      }
      const inChild = search(node.children, node);
      if (inChild) return inChild;
    }
    return null;
  };
  return search(roots, null);
}

/* -------------------------------------------------------------------------- */
/* Deep copy helpers                                                           */
/* -------------------------------------------------------------------------- */

function cloneTask(node: TaskNode): TaskNode {
  return {
    ...node,
    dates: { ...node.dates },
    props: { ...node.props },
    comments: [...node.comments],
    children: node.children.map(cloneTask),
  };
}

function cloneTimeline(nodes: TimelineNode[]): TimelineNode[] {
  return nodes.map((n) => (n.kind === 'task' ? cloneTask(n) : { ...n }));
}

function cloneDoc(doc: TaskDocument): TaskDocument {
  return {
    frontmatter: doc.frontmatter,
    title: doc.title,
    timeline: cloneTimeline(doc.timeline),
    archive: doc.archive ? doc.archive.map(cloneTask) : null,
  };
}

/** Every id currently used anywhere in the document (for uniqueness). */
function takenIds(doc: TaskDocument): Set<string> {
  const taken = new Set<string>();
  for (const node of walkAll(doc.timeline)) {
    if (node.props.id) taken.add(node.props.id);
  }
  if (doc.archive) {
    for (const node of walkAll(doc.archive)) {
      if (node.props.id) taken.add(node.props.id);
    }
  }
  return taken;
}

/** Ensure a node has an id, minting one if needed. Mutates the passed node. */
function ensureId(node: TaskNode, taken: Set<string>, rng: Rng): string {
  if (!node.props.id) node.props.id = mintId(taken, rng);
  return node.props.id;
}

/* -------------------------------------------------------------------------- */
/* add                                                                         */
/* -------------------------------------------------------------------------- */

export interface AddOptions {
  text: string;
  start?: IsoDate;
  due?: IsoDate;
  created?: IsoDate;
  isEvent?: boolean;
  /** Attach as a child of the task matched by this locator. */
  parent?: Locator;
}

/**
 * Add a new task. Without `parent` it becomes a timeline root (placement is the
 * formatter's job, so we simply append). With `parent` it nests under the match.
 */
export function add(doc: TaskDocument, opts: AddOptions): TaskDocument {
  const next = cloneDoc(doc);
  const task = makeTask(opts.text, {
    isEvent: opts.isEvent ?? false,
    dates: {
      ...(opts.start ? { start: opts.start } : {}),
      ...(opts.due ? { due: opts.due } : {}),
      ...(opts.created ? { created: opts.created } : {}),
    },
  });

  if (opts.parent) {
    const found = locate(next.timeline, opts.parent, 'timeline');
    if (!found) throw new OpError('PARENT_NOT_FOUND', 'Parent task not found.');
    found.node.children.push(task);
  } else {
    next.timeline.push(task);
  }
  return next;
}

/* -------------------------------------------------------------------------- */
/* set                                                                         */
/* -------------------------------------------------------------------------- */

export interface SetOptions {
  text?: string;
  start?: IsoDate | null;
  due?: IsoDate | null;
  created?: IsoDate | null;
}

/** Update fields on a located task. A `null` field value clears it. */
export function set(doc: TaskDocument, loc: Locator, opts: SetOptions): TaskDocument {
  const next = cloneDoc(doc);
  const found =
    locate(next.timeline, loc, 'timeline') ??
    (next.archive ? locate(next.archive, loc, 'archive') : null);
  if (!found) throw new OpError('NOT_FOUND', 'Task not found.');

  const t = found.node;
  if (opts.text !== undefined) t.text = opts.text;
  applyDate(t.dates, 'start', opts.start);
  applyDate(t.dates, 'due', opts.due);
  applyDate(t.dates, 'created', opts.created);
  return next;
}

function applyDate(
  dates: TaskNode['dates'],
  key: 'start' | 'due' | 'created',
  value: IsoDate | null | undefined,
): void {
  if (value === undefined) return;
  if (value === null) delete dates[key];
  else dates[key] = value;
}

/* -------------------------------------------------------------------------- */
/* rm                                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Remove a task. By default a task with children is refused (to avoid silent
 * data loss); pass `recursive` to delete the whole subtree.
 */
export function rm(
  doc: TaskDocument,
  loc: Locator,
  { recursive = false }: { recursive?: boolean } = {},
): TaskDocument {
  const next = cloneDoc(doc);
  const found =
    locate(next.timeline, loc, 'timeline') ??
    (next.archive ? locate(next.archive, loc, 'archive') : null);
  if (!found) throw new OpError('NOT_FOUND', 'Task not found.');
  if (found.node.children.length > 0 && !recursive) {
    throw new OpError('HAS_CHILDREN', 'Task has children; pass recursive to remove the subtree.');
  }
  found.siblings.splice(found.index, 1);
  return next;
}

/* -------------------------------------------------------------------------- */
/* complete / unarchive                                                        */
/* -------------------------------------------------------------------------- */

export interface CompleteOptions {
  done: IsoDate;
  /** Injectable RNG for deterministic id minting. */
  rng?: Rng;
}

/**
 * Complete a task: mark it done and move its subtree to the archive.
 *
 * - The located node's `[x]` is set and `✅ done` stamped. Its still-open
 *   descendants travel with it (they stay `[ ]`).
 * - If the node was a *nested* task whose parent stays in the timeline, the
 *   archived root records `[parent:: <id>]` (parent gets an id if it lacked
 *   one) so `unarchive` can re-nest it.
 * - If the node was an *undated* timeline root, it records
 *   `[section:: <marker>]` capturing which section it occupied, so unarchive
 *   restores it to the same position.
 */
export function complete(doc: TaskDocument, loc: Locator, opts: CompleteOptions): TaskDocument {
  const next = cloneDoc(doc);
  const rng = opts.rng ?? seededRng(1);
  const taken = takenIds(next);

  const found = locate(next.timeline, loc, 'timeline');
  if (!found) throw new OpError('NOT_FOUND', 'Task not found in the timeline.');

  const node = found.node;
  const marker = undatedSectionMarker(node, found, next.timeline);

  // A recurring task rolls forward: archive this completed occurrence and
  // insert the next open occurrence where this one was in the timeline.
  const rule = parseRecurrence(node.text);
  if (rule) {
    found.siblings.splice(found.index, 1, makeRecurringNext(node, rule));
  } else {
    // Splice the subtree out of the timeline.
    found.siblings.splice(found.index, 1);
  }

  // Mark the root done.
  node.checked = true;
  node.dates.done = opts.done;

  // Record re-nesting / section restore hints.
  if (found.parent) {
    const parentId = ensureId(found.parent, taken, rng);
    node.props.parent = parentId;
  } else if (marker !== null) {
    node.props.section = marker;
  }

  if (next.archive === null) next.archive = [];
  next.archive.push(node);
  return next;
}

/** Build the next open occurrence of a recurring task (dates advanced by the rule). */
function makeRecurringNext(node: TaskNode, rule: Recurrence): TaskNode {
  const dates: TaskNode['dates'] = {};
  if (node.dates.start) dates.start = nextDate(node.dates.start, rule);
  if (node.dates.due) dates.due = nextDate(node.dates.due, rule);
  return makeTask(node.text, {
    isEvent: node.isEvent,
    dates,
    comments: [...node.comments],
  });
}

/**
 * For an undated timeline root, compute the section marker to store: the date
 * of the event immediately before it, or `start` when it sits in the first
 * section. Returns null for dated roots (their dates already place them) and
 * for nested nodes (their parent link places them).
 */
function undatedSectionMarker(
  node: TaskNode,
  found: Located,
  timeline: TimelineNode[],
): string | null {
  if (found.parent) return null;
  if (anchorDate(node)) return null;
  const idx = sectionIndexByPosition(node, timeline);
  if (idx === 0) return 'start';
  // idx counts events before the node; the (idx-1)-th event in file order is the
  // one immediately preceding it.
  const events = timeline.filter((n): n is TaskNode => n.kind === 'task' && n.isEvent);
  const before = events[idx - 1];
  return before?.dates.due ?? 'start';
}

/**
 * Unarchive a task: invert `complete`. Clears `[x]`/`✅` and moves the subtree
 * back to the timeline, restoring its parent (via `[parent::]`) or its section
 * (via `[section::]`). Both hints are consumed. Unarchiving a task whose
 * ancestor is still archived is an error — unarchive the ancestor first.
 */
export function unarchive(doc: TaskDocument, loc: Locator): TaskDocument {
  const next = cloneDoc(doc);
  if (!next.archive) throw new OpError('NO_ARCHIVE', 'Document has no archive.');

  const found = locate(next.archive, loc, 'archive');
  if (!found) throw new OpError('NOT_FOUND', 'Task not found in the archive.');
  if (found.parent) {
    throw new OpError(
      'ANCESTOR_ARCHIVED',
      'This task is nested under another archived task; unarchive the ancestor first.',
    );
  }

  const node = found.node;
  found.siblings.splice(found.index, 1);
  if (next.archive.length === 0) next.archive = null;

  // Undo done state.
  node.checked = false;
  delete node.dates.done;

  const parentId = node.props.parent;
  const sectionMarker = node.props.section;
  delete node.props.parent;
  delete node.props.section;

  if (parentId) {
    const parent = locate(next.timeline, { id: parentId }, 'timeline');
    if (!parent) {
      throw new OpError(
        'PARENT_MISSING',
        `Parent [${parentId}] is not in the timeline; cannot re-nest.`,
      );
    }
    parent.node.children.push(node);
  } else if (anchorDate(node)) {
    // Dated root: the formatter places it by its dates. Position is irrelevant.
    next.timeline.push(node);
  } else {
    // Undated root: the formatter places it by *position*, so we must reinsert
    // it into the section the marker names. 'start' -> before the first event;
    // an event date -> immediately after the matching event.
    reinsertUndated(next.timeline, node, sectionMarker);
  }
  return next;
}

/**
 * Reinsert an undated root into the timeline so its positional section matches
 * the stored marker. 'start' (or a missing marker) lands it before the first
 * event; an event-date marker lands it immediately after that event.
 */
function reinsertUndated(
  timeline: TimelineNode[],
  node: TaskNode,
  marker: string | undefined,
): void {
  if (!marker || marker === 'start') {
    const firstEvent = timeline.findIndex((n) => n.kind === 'task' && n.isEvent);
    if (firstEvent === -1) timeline.push(node);
    else timeline.splice(firstEvent, 0, node);
    return;
  }
  // Insert right after the event whose due date equals the marker.
  const at = timeline.findIndex((n) => n.kind === 'task' && n.isEvent && n.dates.due === marker);
  if (at === -1) timeline.push(node);
  else timeline.splice(at + 1, 0, node);
}

/* -------------------------------------------------------------------------- */
/* events                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Move every completed (checked) task still in the timeline to the archive.
 *
 * This is what `format` runs first so a checked task that was never explicitly
 * archived is canonicalized into the archive. It uses the same reversible
 * bookkeeping as `complete` (`[parent::]` for a nested task whose parent stays
 * in the timeline, `[section::]` for an undated root) so `unarchive` still
 * restores it, and it never invents a `✅ done` date (no wall-clock).
 *
 * A checked task's whole subtree travels with it (nested tasks are not split).
 * Completed events are auto-archived too.
 */
export function archiveInTimeline(doc: TaskDocument): TaskDocument {
  const next = cloneDoc(doc);
  if (next.timeline.length === 0) return next;

  // Collect checked tasks and events before mutating. We do not recurse into a
  // checked node — its subtree travels with it. Events can be completed too.
  const checked: { node: TaskNode; parent: TaskNode | null }[] = [];
  const walk = (roots: TimelineNode[], parent: TaskNode | null): void => {
    for (const n of roots) {
      if (n.kind !== 'task') continue;
      if (n.checked) {
        checked.push({ node: n, parent });
      } else {
        walk(n.children, n);
      }
    }
  };
  walk(next.timeline, null);
  if (checked.length === 0) return next;

  // Precompute section markers against the original event positions before any
  // splicing, so positional markers are stable.
  const events = next.timeline.filter((n): n is TaskNode => n.kind === 'task' && n.isEvent);
  const prepared = checked.map(({ node, parent }) => ({
    node,
    parent,
    marker: parent ? null : undatedRootMarker(node, next.timeline, events),
  }));

  const rng = seededRng(1);
  const taken = takenIds(next);
  for (const { node, parent, marker } of prepared) {
    removeNode(next.timeline, node);
    if (parent) {
      const pid = ensureId(parent, taken, rng);
      node.props.parent = pid;
    } else if (marker !== null) {
      node.props.section = marker;
    }
    (next.archive ??= []).push(node);
  }
  return next;
}

/** Same marker rule as `complete`'s undatedSectionMarker, against saved events. */
function undatedRootMarker(
  node: TaskNode,
  timeline: TimelineNode[],
  events: TaskNode[],
): string | null {
  if (anchorDate(node)) return null;
  const idx = sectionIndexByPosition(node, timeline);
  if (idx === 0) return 'start';
  return events[idx - 1]?.dates.due ?? 'start';
}

/** Remove a task node (by identity) from its tree, wherever it nests. */
function removeNode(roots: TimelineNode[], target: TaskNode): boolean {
  for (let i = 0; i < roots.length; i++) {
    const n = roots[i];
    if (!n || n.kind !== 'task') continue;
    if (n === target) {
      roots.splice(i, 1);
      return true;
    }
    if (removeNode(n.children, target)) return true;
  }
  return false;
}

/* -------------------------------------------------------------------------- */
/* events                                                                      */
/* -------------------------------------------------------------------------- */

/** Add an event (milestone). Events are always timeline roots. */
export function addEvent(doc: TaskDocument, text: string, due: IsoDate): TaskDocument {
  return add(doc, { text, due, isEvent: true });
}

/** Remove an event by locator. Events never have children, so no recursion. */
export function removeEvent(doc: TaskDocument, loc: Locator): TaskDocument {
  const next = cloneDoc(doc);
  const found = locate(next.timeline, loc, 'timeline');
  if (!found || !found.node.isEvent) {
    throw new OpError('EVENT_NOT_FOUND', 'Event not found.');
  }
  found.siblings.splice(found.index, 1);
  return next;
}

/* -------------------------------------------------------------------------- */
/* errors                                                                      */
/* -------------------------------------------------------------------------- */

export class OpError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OpError';
  }
}
