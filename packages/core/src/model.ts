/**
 * Task-System AST model.
 *
 * A document has four regions in order:
 *   1. frontmatter  - optional YAML block, preserved verbatim, unmodeled.
 *   2. title        - optional single H1 line.
 *   3. timeline     - nested list of tasks and events (no headers).
 *   4. archive      - optional trailing `## Archive` H2 + completed tasks.
 *
 * The model is the single source of truth shared by the CLI and the SPA.
 * Parser produces it; formatter renders it back to canonical text.
 */

/** ISO calendar date, `YYYY-MM-DD`. Validated on parse; stored as the raw string. */
export type IsoDate = string;

/** The four Obsidian Tasks date fields we model. */
export interface TaskDates {
  /** 🛫 start */
  start?: IsoDate;
  /** 📅 due */
  due?: IsoDate;
  /** ✅ done */
  done?: IsoDate;
  /** ➕ created */
  created?: IsoDate;
}

/**
 * Tool-assigned bracket properties. Humans never type these; operations add
 * them only when a cross-reference is structurally required, and `format`
 * never invents or strips them.
 */
export interface TaskProps {
  /** `[id:: <base36>]` stable identifier, assigned on structural need. */
  id?: string;
  /** `[parent:: <id>]` link to a parent that lives in a different region. */
  parent?: string;
  /** `[section:: <event-date>|start]` restore hint for archived undated tasks. */
  section?: string;
}

/**
 * A single node in the timeline or archive: either a task or an event.
 * Events are tasks bearing the 🏁 marker, so they share the shape; `isEvent`
 * discriminates and constrains which fields are meaningful.
 */
export interface TaskNode {
  kind: 'task';
  /** True when the line carries 🏁. Events are always depth 0 with one date (due). */
  isEvent: boolean;
  /** Checkbox state. Events are conventionally open. */
  checked: boolean;
  /** Display text with all recognized fields and props removed. */
  text: string;
  dates: TaskDates;
  props: TaskProps;
  /**
   * Everything after the first non-field token on the line (tags, priority,
   * recurrence, prose). Frozen verbatim: never re-scanned for fields, so a
   * 📅 inside prose can never be promoted to a real date field.
   */
  suffix: string;
  /** Contiguous `%% … %%` comment lines bound to this task, in order. */
  comments: string[];
  /** Nested children (subtasks). Events never have children. */
  children: TaskNode[];
  /**
   * Original 0-based source line of the `- [ ]` marker, when parsed from text.
   * Used to freeze undated-task section membership before dated relocation,
   * and to anchor issue reports. Undefined for programmatically created nodes.
   */
  sourceLine?: number;
}

/** A raw line the parser could not interpret; preserved position-stable. */
export interface UnknownNode {
  kind: 'unknown';
  text: string;
  sourceLine?: number;
}

export type TimelineNode = TaskNode | UnknownNode;

export interface TaskDocument {
  /** Raw frontmatter body between the `---` fences, without the fences. Null if absent. */
  frontmatter: string | null;
  /** H1 title text (without the leading `# `). Null if absent. */
  title: string | null;
  /** Timeline roots, in canonical order after formatting. */
  timeline: TimelineNode[];
  /** Archive roots. Null when the document has no `## Archive` section. */
  archive: TaskNode[] | null;
}

/** The exact string label used for the archive header. */
export const ARCHIVE_HEADER = '## Archive';

/** Canonical emoji markers. */
export const EMOJI = {
  start: '🛫',
  due: '📅',
  done: '✅',
  created: '➕',
  event: '🏁',
} as const;

export function isTask(node: TimelineNode): node is TaskNode {
  return node.kind === 'task';
}

/** Create an empty document. */
export function emptyDocument(): TaskDocument {
  return { frontmatter: null, title: null, timeline: [], archive: null };
}

/** Create a task node with sensible defaults. */
export function makeTask(text: string, init: Partial<TaskNode> = {}): TaskNode {
  return {
    kind: 'task',
    isEvent: false,
    checked: false,
    text,
    dates: {},
    props: {},
    suffix: '',
    comments: [],
    children: [],
    ...init,
  };
}

/** Depth-first walk over a node and its descendants. */
export function* walk(node: TaskNode): Generator<TaskNode> {
  yield node;
  for (const child of node.children) {
    yield* walk(child);
  }
}

/** Depth-first walk over every task node in a region. */
export function* walkAll(nodes: TimelineNode[]): Generator<TaskNode> {
  for (const node of nodes) {
    if (isTask(node)) yield* walk(node);
  }
}
