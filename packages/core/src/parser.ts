/**
 * Tolerant parser: reads arbitrary hand-edited Markdown (and Obsidian-flavored
 * task lines) into the TaskDocument AST. It never throws on odd input — lines it
 * cannot interpret are preserved as UnknownNode and pass through formatting
 * untouched and position-stable.
 *
 * Line model (see docs/format.md). After the `- [ ]` checkbox, the remainder is:
 *   - an optional 🏁 event marker,
 *   - recognized date fields (🛫 start, 📅 due, ✅ done, ➕ created) — emoji form
 *     canonical, ASCII/dataview form ([start:: DATE] etc.) also accepted,
 *   - tool props ([id::], [parent::], [section::]),
 *   - free description text, which may include unmodeled tokens (#tags, ⏫, 🔁)
 *     kept verbatim in their original relative order.
 * Recognized fields/props are extracted from anywhere on the line; a date field
 * requires the marker immediately followed by a valid ISO date, matching how the
 * Obsidian Tasks plugin itself reads a line. First occurrence of a repeated
 * field wins; later duplicates are dropped.
 *
 * Nesting: leading whitespace (tab = 2 columns) determines depth via a stack;
 * a node attaches to the nearest strictly-shallower open task. The formatter
 * renormalizes indentation to 2 spaces per level.
 *
 * Comments: a contiguous run of `%% … %%` lines (no blank line between them and
 * the task) binds to the task immediately below. An orphan comment run is kept
 * as unknown lines.
 */

import type { TaskDocument, TaskNode, TimelineNode, UnknownNode } from './model.js';
import { ARCHIVE_HEADER, EMOJI } from './model.js';

const TASK_PREFIX = /^[\t ]*[-*+]\s+\[([ xX])\]\s?/;
const INDENT_RE = /^[\t ]*/;
const DATE_RE = /\d{4}-\d{2}-\d{2}/;

interface FieldPattern {
  field: 'start' | 'due' | 'done' | 'created';
  re: RegExp;
}

/** Global regexes so we can find + remove fields anywhere on the line. */
const FIELD_PATTERNS: FieldPattern[] = [
  { field: 'start', re: /🛫\s*(\d{4}-\d{2}-\d{2})/g },
  { field: 'due', re: /📅\s*(\d{4}-\d{2}-\d{2})/g },
  { field: 'done', re: /✅\s*(\d{4}-\d{2}-\d{2})/g },
  { field: 'created', re: /➕\s*(\d{4}-\d{2}-\d{2})/g },
  { field: 'start', re: /\[start::\s*(\d{4}-\d{2}-\d{2})\]/g },
  { field: 'due', re: /\[due::\s*(\d{4}-\d{2}-\d{2})\]/g },
  { field: 'done', re: /\[done::\s*(\d{4}-\d{2}-\d{2})\]/g },
  { field: 'created', re: /\[created::\s*(\d{4}-\d{2}-\d{2})\]/g },
];

const PROP_PATTERNS: { key: 'id' | 'parent' | 'section'; re: RegExp }[] = [
  { key: 'id', re: /\[id::\s*([^\]]+)\]/g },
  { key: 'parent', re: /\[parent::\s*([^\]]+)\]/g },
  { key: 'section', re: /\[section::\s*([^\]]+)\]/g },
];

/** Extract date fields (first wins), returning the dates and the residual text. */
function extractFields(content: string): { dates: TaskNode['dates']; rest: string } {
  const dates: TaskNode['dates'] = {};
  let rest = content;
  for (const { field, re } of FIELD_PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(rest);
    if (m && DATE_RE.test(m[1]!)) {
      if (!(field in dates)) dates[field] = m[1]!;
      rest = rest.slice(0, m.index) + rest.slice(m.index + m[0].length);
    }
  }
  return { dates, rest };
}

/** Extract tool props, returning the props and the residual text. */
function extractProps(content: string): { props: TaskNode['props']; rest: string } {
  const props: TaskNode['props'] = {};
  let rest = content;
  for (const { key, re } of PROP_PATTERNS) {
    re.lastIndex = 0;
    const m = re.exec(rest);
    if (m) {
      props[key] = m[1]!.trim();
      rest = rest.slice(0, m.index) + rest.slice(m.index + m[0].length);
    }
  }
  return { props, rest };
}

function indentWidth(line: string): number {
  const ws = INDENT_RE.exec(line)?.[0] ?? '';
  let w = 0;
  for (const ch of ws) w += ch === '\t' ? 2 : 1;
  return w;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isCommentLine(line: string): boolean {
  return line.trim().startsWith('%%');
}

export function parse(text: string): TaskDocument {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const doc: TaskDocument = { frontmatter: null, title: null, timeline: [], archive: null };
  let i = 0;

  // --- frontmatter ---
  if (lines[i]?.trim() === '---') {
    const body: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j]!.trim() !== '---') {
      body.push(lines[j]!);
      j++;
    }
    if (j < lines.length) {
      doc.frontmatter = body.join('\n');
      i = j + 1;
    }
    // Unterminated frontmatter: fall through and let the lines parse as unknowns.
  }

  // --- title (first non-blank line, if it is an H1) ---
  while (i < lines.length && lines[i]!.trim() === '') i++;
  if (lines[i]?.startsWith('# ')) {
    doc.title = lines[i]!.slice(2).trim();
    i++;
  }

  // --- timeline / archive ---
  const stack: { node: TaskNode; indent: number }[] = [];
  let pending: string[] = [];
  let inArchive = false;

  const rootPush = (n: TimelineNode): void => {
    if (inArchive) (doc.archive ??= []).push(n as TaskNode);
    else doc.timeline.push(n);
  };
  const attach = (n: TimelineNode, indent: number): void => {
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(n as TaskNode);
    else rootPush(n);
  };

  for (; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.trim() === '') {
      // A blank line ends a comment run. Pending comments are now orphaned
      // (no task directly below); preserve them as unknown lines, never drop.
      for (const c of pending) rootPushUnknown(c);
      pending = [];
      continue;
    }

    if (line.trim() === ARCHIVE_HEADER) {
      for (const c of pending) rootPushUnknown(c);
      pending = [];
      inArchive = true;
      stack.length = 0;
      continue;
    }

    if (isCommentLine(line)) {
      pending.push(line.trim());
      continue;
    }

    const m = TASK_PREFIX.exec(line);
    if (!m) {
      // Unknown line (stray header, prose, malformed bullet): preserve in place.
      const unknown: UnknownNode = { kind: 'unknown', text: line, sourceLine: i };
      // Flush any pending comments ahead of it as their own unknown lines.
      for (const c of pending) rootPushUnknown(c);
      pending = [];
      attach(unknown, indentWidth(line));
      continue;
    }

    const checked = m[1] !== ' ';
    const indent = indentWidth(line);
    let content = line.slice(m[0].length);

    let isEvent = false;
    if (content.includes(EMOJI.event)) {
      isEvent = true;
      content = content.split(EMOJI.event).join(' ');
    }

    const { props, rest: afterProps } = extractProps(content);
    const { dates, rest } = extractFields(afterProps);

    const node: TaskNode = {
      kind: 'task',
      isEvent,
      checked,
      text: collapse(rest),
      dates,
      props,
      suffix: '',
      comments: pending,
      children: [],
      sourceLine: i,
    };
    pending = [];
    attach(node, indent);
    stack.push({ node, indent });
  }

  return doc;

  function rootPushUnknown(commentText: string): void {
    const un: UnknownNode = { kind: 'unknown', text: commentText };
    const parent = stack[stack.length - 1];
    if (parent) parent.node.children.push(un as unknown as TaskNode);
    else rootPush(un);
  }
}
