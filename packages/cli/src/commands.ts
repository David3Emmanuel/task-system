/**
 * Command implementations, kept free of process/file concerns so they can be
 * unit-tested directly. Each command takes the current document text (when it
 * needs one) plus parsed args and returns a CommandResult describing what to
 * print, whether to write the file back, and the process exit code.
 *
 * Exit codes: 0 success, 1 validation/soft failure, 2 usage/hard error.
 */

import {
  parse,
  format,
  validate,
  hasBlockingErrors,
  add,
  set,
  rm,
  complete,
  unarchive,
  addEvent,
  removeEvent,
  seededRng,
  walkAll,
  emptyDocument,
  OpError,
  type TaskDocument,
  type TaskNode,
  type Locator,
  type Issue,
} from '@task-system/core';
import { optFlag, optString, type ParsedArgs } from './args.js';

export interface CommandResult {
  /** Text to print to stdout. */
  stdout: string;
  /** Text to print to stderr. */
  stderr?: string;
  /** New file contents to persist, or null to leave the file untouched. */
  write?: string | null;
  /** Process exit code. */
  code: number;
}

const ok = (stdout: string, write: string | null = null): CommandResult => ({
  stdout,
  write,
  code: 0,
});
const fail = (stderr: string, code = 2): CommandResult => ({ stdout: '', stderr, code });

/* -------------------------------------------------------------------------- */
/* locators + shared helpers                                                   */
/* -------------------------------------------------------------------------- */

/** Build a Locator from --line / --id / --match, in that precedence. */
function locatorFrom(args: ParsedArgs): Locator | null {
  const line = optString(args, 'line');
  if (line !== undefined) {
    const n = Number(line);
    // --line is 1-based (as `list` prints it); ops use 0-based source lines.
    if (!Number.isInteger(n) || n < 1) return null;
    return { line: n - 1 };
  }
  const id = optString(args, 'id');
  if (id !== undefined) return { id };
  const match = optString(args, 'match');
  if (match !== undefined) return { match };
  return null;
}

function issuesReport(issues: Issue[], json: boolean): string {
  if (json) return JSON.stringify(issues, null, 2);
  if (issues.length === 0) return 'No issues.';
  return issues
    .map((i) => {
      const at = i.line !== undefined ? `:${i.line + 1}` : '';
      return `${i.severity.toUpperCase()} ${i.code}${at} ${i.message}`;
    })
    .join('\n');
}

/** Serialize an op result: canonical text, plus --json envelope when asked. */
function opResult(doc: TaskDocument, json: boolean): CommandResult {
  const text = format(doc);
  const issues = validate(parse(text));
  if (json) {
    return ok(JSON.stringify({ text, issues }, null, 2), text);
  }
  return ok(text, text);
}

/* -------------------------------------------------------------------------- */
/* commands that read a document                                               */
/* -------------------------------------------------------------------------- */

export function cmdInit(): CommandResult {
  return ok(format(emptyDocument()));
}

export function cmdParse(text: string, args: ParsedArgs): CommandResult {
  const doc = parse(text);
  if (optFlag(args, 'json')) return ok(JSON.stringify(doc, null, 2));
  // Non-JSON parse is just a re-emit; point users at `format` for that.
  return ok(format(doc));
}

export function cmdValidate(text: string, args: ParsedArgs): CommandResult {
  const issues = validate(parse(text));
  const report = issuesReport(issues, optFlag(args, 'json'));
  return { stdout: report, code: hasBlockingErrors(issues) ? 1 : 0 };
}

export function cmdFormat(text: string, args: ParsedArgs): CommandResult {
  const canonical = format(parse(text));
  if (optFlag(args, 'check')) {
    if (canonical === text) return ok('');
    return { stdout: '', stderr: 'Not canonical. Run `tsk format --write`.', code: 1 };
  }
  if (optFlag(args, 'write')) {
    return { stdout: '', write: canonical === text ? null : canonical, code: 0 };
  }
  return ok(canonical);
}

export function cmdList(text: string, args: ParsedArgs): CommandResult {
  const doc = parse(text);
  const json = optFlag(args, 'json');
  const wantOpen = optFlag(args, 'open');
  const wantDone = optFlag(args, 'done');

  const rows: { line?: number; checked: boolean; event: boolean; text: string }[] = [];
  const collect = (nodes: TaskNode[]) => {
    for (const n of nodes) {
      rows.push({ line: n.sourceLine, checked: n.checked, event: n.isEvent, text: n.text });
    }
  };
  collect([...walkAll(doc.timeline)]);
  if (doc.archive) collect([...walkAll(doc.archive)]);

  let filtered = rows;
  if (wantOpen) filtered = filtered.filter((r) => !r.checked);
  if (wantDone) filtered = filtered.filter((r) => r.checked);

  if (json) return ok(JSON.stringify(filtered, null, 2));
  if (filtered.length === 0) return ok('(no tasks)');
  const body = filtered
    .map((r) => {
      const box = r.checked ? '[x]' : '[ ]';
      const marker = r.event ? '🏁 ' : '';
      const at = r.line !== undefined ? `${r.line + 1}\t` : '\t';
      return `${at}${box} ${marker}${r.text}`;
    })
    .join('\n');
  return ok(body);
}

/* -------------------------------------------------------------------------- */
/* mutating commands                                                           */
/* -------------------------------------------------------------------------- */

export function cmdAdd(text: string, args: ParsedArgs): CommandResult {
  const body = args.positionals.join(' ').trim();
  if (!body) return fail('add: task text is required.');

  const parent = optString(args, 'parent');
  const parentLine = optString(args, 'parent-line');
  let parentLocator: Locator | undefined;
  if (parentLine !== undefined) {
    const n = Number(parentLine);
    if (!Number.isInteger(n) || n < 1) {
      return fail('add: --parent-line must be a valid 1-based line number (as shown by `list`).');
    }
    parentLocator = { line: n - 1 };
  } else if (parent !== undefined) {
    parentLocator = { match: parent };
  }

  const doc = add(parse(text), {
    text: body,
    start: optString(args, 'start'),
    due: optString(args, 'due'),
    created: optString(args, 'created'),
    isEvent: optFlag(args, 'event'),
    parent: parentLocator,
  });
  return opResult(doc, optFlag(args, 'json'));
}

export function cmdSet(text: string, args: ParsedArgs): CommandResult {
  const loc = locatorFrom(args);
  if (!loc) return fail('set: a --line, --id, or --match locator is required.');
  const doc = set(parse(text), loc, {
    text: optString(args, 'text'),
    start: nullable(args, 'start'),
    due: nullable(args, 'due'),
    created: nullable(args, 'created'),
  });
  return opResult(doc, optFlag(args, 'json'));
}

/** A `--field ""` (empty) clears the field; absent leaves it unchanged. */
function nullable(args: ParsedArgs, key: string): string | null | undefined {
  const v = optString(args, key);
  if (v === undefined) return undefined;
  return v === '' ? null : v;
}

export function cmdComplete(text: string, args: ParsedArgs): CommandResult {
  const loc = locatorFrom(args);
  if (!loc) return fail('complete: a --line, --id, or --match locator is required.');
  const done = optString(args, 'done');
  if (!done) return fail('complete: --done DATE is required (no wall-clock in the CLI core).');
  const seed = Number(optString(args, 'seed') ?? '1');
  const doc = complete(parse(text), loc, { done, rng: seededRng(seed) });
  return opResult(doc, optFlag(args, 'json'));
}

export function cmdUnarchive(text: string, args: ParsedArgs): CommandResult {
  const loc = locatorFrom(args);
  if (!loc) return fail('unarchive: a --line, --id, or --match locator is required.');
  const doc = unarchive(parse(text), loc);
  return opResult(doc, optFlag(args, 'json'));
}

export function cmdRm(text: string, args: ParsedArgs): CommandResult {
  const loc = locatorFrom(args);
  if (!loc) return fail('rm: a --line, --id, or --match locator is required.');
  const doc = rm(parse(text), loc, { recursive: optFlag(args, 'recursive') });
  return opResult(doc, optFlag(args, 'json'));
}

export function cmdEvent(text: string, args: ParsedArgs): CommandResult {
  const sub = args.positionals[0];
  if (sub === 'add') {
    const body = args.positionals.slice(1).join(' ').trim();
    if (!body) return fail('event add: text is required.');
    const due = optString(args, 'due');
    if (!due) return fail('event add: --due DATE is required.');
    return opResult(addEvent(parse(text), body, due), optFlag(args, 'json'));
  }
  if (sub === 'rm') {
    const loc = locatorFrom(args);
    if (!loc) return fail('event rm: a --line, --id, or --match locator is required.');
    return opResult(removeEvent(parse(text), loc), optFlag(args, 'json'));
  }
  return fail('event: expected subcommand `add` or `rm`.');
}

/** Map an OpError thrown by a command into a soft failure result. */
export function opErrorResult(err: unknown): CommandResult {
  if (err instanceof OpError) return { stdout: '', stderr: `${err.code}: ${err.message}`, code: 1 };
  throw err;
}
