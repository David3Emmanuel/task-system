# Task-System Markdown Format

Task-System is a deterministic, AI-friendly task format built on plain Markdown.
It is a superset of the [Obsidian Tasks](https://publish.obsidian.md/tasks/) line
syntax: the parser reads hand-edited files tolerantly, and the formatter emits a
canonical form that is **idempotent**, **confluent** (input order does not matter),
and **id-stable** (it never invents or strips tool properties).

This document is the single reference for the format. The parser, formatter,
validator, and ordering logic in `@task-system/core` are the implementation; see
`src/model.ts`, `src/parser.ts`, `src/formatter.ts`, `src/validate.ts`, and
`src/sections.ts`.

---

## 1. Document structure

A document has up to four regions, in this order:

```
---                      <- 1. frontmatter (optional, verbatim YAML)
tags: [work]
---
# Project               <- 2. title (optional, single H1)

- [ ] 🏁 Kickoff 📅 2026-03-02   <- 3. timeline (nested tasks + events)
- [ ] Write spec 📅 2026-03-06
  - [ ] Draft
  - [ ] Review

## Archive              <- 4. archive (optional trailing H2 + completed tasks)

- [x] Set up repo ✅ 2026-03-01
```

| Region | Heading | Contents |
| --- | --- | --- |
| 1. Frontmatter | `---` fences | Raw YAML, preserved verbatim and unmodeled. |
| 2. Title | `# ` H1 | Optional single line; anything after it is the timeline. |
| 3. Timeline | — | Nested list of tasks and events. No headers here. |
| 4. Archive | `## Archive` | Completed tasks, moved here by the `complete` operation. |

The archive header is the exact string `## Archive` and must be the last region.

---

## 2. Task lines

A task is a checkbox bullet:

```
- [ ] Read the docs 📅 2026-03-05
- [x] Shipped ✅ 2026-03-01
```

- Bullet markers `-`, `*`, `+` are all accepted; the formatter emits `-`.
- The checkbox is `[ ]` (open) or `[x]` / `[X]` (done).
- After the checkbox, the remainder is split into:
  - an optional **event marker** `🏁`,
  - recognized **date fields** (emoji and ASCII forms),
  - tool **props** (`[id::]`, `[parent::]`, `[section::]`),
  - free **text**, which may contain unmodeled tokens (`#tags`, `⏫`, prose) kept
    verbatim in their original relative order — except `🔁`, which is read as a
    recurrence rule (below).

### Date fields

Four date fields are modeled. Each requires the marker immediately followed by a
valid `YYYY-MM-DD` date (matching how the Obsidian Tasks plugin reads a line).

| Field | Emoji | ASCII / dataview |
| --- | --- | --- |
| start | `🛫 2026-03-01` | `[start:: 2026-03-01]` |
| due | `📅 2026-03-05` | `[due:: 2026-03-05]` |
| done | `✅ 2026-03-06` | `[done:: 2026-03-06]` |
| created | `➕ 2026-02-20` | `[created:: 2026-02-20]` |

The emoji form is canonical. Fields are extracted from anywhere on the line;
the **first occurrence of a repeated field wins** and later duplicates are
dropped. A date-like token that is not a valid `YYYY-MM-DD` is left in the text
and never promoted to a real field.

### Recurrence

A task can carry a `🔁` recurrence rule in its text (Obsidian-style). When a
recurring task is completed, it **rolls forward**: the completed occurrence is
archived and a new open occurrence is placed in the timeline with its
`🛫`/`📅` dates advanced by the rule. The rule is anchored to the task's own
dates — there is **no wall-clock**.

```
- [ ] Mow lawn 🔁 every week 📅 2026-09-01
- [ ] Standup notes 🔁 daily
- [ ] Backup 🔁 every 2 weeks
```

Accepted forms (after `🔁`, case-insensitive): `daily` / `every day` /
`every <n> days`, `weekly` / `every week` / `biweekly` / `every <n> weeks`,
`monthly` / `every month` / `every <n> months`, `yearly` / `every year` /
`every <n> years`. Removing the `🔁` makes it a normal one-off task again.

### Events (milestones)

A task bearing the `🏁` marker is an **event**. Events are always top-level and
carry a single `📅 due` date. They are sorted among the tasks by that date; they
do not partition the timeline. They are conventionally left open (`[ ]`).

```
- [ ] 🏁 Kickoff 📅 2026-03-02
```

### Tool properties

Properties in brackets are **tool-assigned**. Humans never type them; operations
add them only when a cross-reference is structurally required, and the formatter
never invents or strips them.

| Property | Meaning |
| --- | --- |
| `[id:: <base36>]` | Stable identifier, minted when a task needs a cross-region reference. |
| `[parent:: <id>]` | Link to a parent living in a different region (used by archiving). |
| `[section:: <event-date>\|start]` | Legacy; no longer written. Preserved if present. |

Example:

```
- [ ] Parent [id:: 3f9k2a]
- [x] Child ✅ 2026-03-01 [parent:: 3f9k2a]
```

---

## 3. Nesting, comments, and unknown lines

### Indentation

Leading whitespace (a tab counts as 2 columns) sets depth via a stack; a node
attaches to the nearest strictly-shallower open task. The formatter renormalizes
indentation to **2 spaces per level**.

```
- [ ] Parent
  - [ ] Child 1
  - [ ] Child 2
    - [ ] Grandchild
```

### Comments

A contiguous run of `%% … %%` comment lines with no blank line between them and
the following task binds to that task:

```
%% owner: dave
- [ ] Write the thing
```

A blank line breaks the binding; an orphan comment run is preserved as an
unknown line rather than dropped.

### Unknown lines

The parser is tolerant: any line it cannot interpret (stray headers, prose,
malformed bullets) is preserved **position-stable** as an unknown node and passes
through formatting untouched. This guarantees round-tripping hand-edited files.

---

## 4. Canonical formatting

`format()` maps a parsed document back to canonical text. Guarantees:

- **Idempotent**: `format(format(x)) === format(x)`.
- **Deterministic**: same content in the same order gives the same output; there
  is no wall-clock. (Equal dates keep authored order, so input order can matter
  for ties.)
- **No wall-clock**: output is a pure function of the AST; a `✅ done` date is
  never invented.
- **Prop-stable**: the formatter never invents or strips `[id::]`, `[parent::]` —
  *except* when it canonicalizes a completed task into the archive (below), where
  it adds the minimal reversible bookkeeping that `complete` uses. Otherwise props
  are untouched.

### Auto-archiving

A completed task (`[x]` with a `✅` date) that was never explicitly archived is
moved into the archive by `format` (this is the canonical state). It uses the
same `[parent::]` bookkeeping as `complete`, so `unarchive` still restores it
under its parent. A checked task's subtree travels with it (including completed
events). `format` never adds a `✅` date, so a checked task without one is
archived as-is.

A serialized line uses this order:

```
- [x] Text 🛫 start 📅 due ✅ done ➕ created [id:: x] [parent:: y]
```

---

## 5. Ordering

Events partition the timeline. With events `E1 < E2 < …`, the partitions are
`P0` (before `E1`), `P1` (`E1..E2`), and so on.

A task's **current** partition is the number of events above it in the file. Its
**legal range** comes from its own dates:

- `start` → cannot sit before the last event at or before it (`lower`)
- `due` → cannot sit after the first event after it (`upper`)

The task is **clamped** into `[lower, upper]`: it moves only when its current
position violates its own dates, and then only to the nearest legal partition. A
task with no dates rides with the dated task above it; leading undated tasks stay
on top. Within a partition, tasks sort by anchor date (`start ?? due`); equal
dates keep authored order.

Nesting:

- A parent with `start` and/or `due` forces its whole subtree into the parent's
  partition. A child whose dates disagree is a mistake to fix, not a reason to
  split.
- A fully undated parent follows its children; if they land in different
  partitions it splits into `(part N)` fragments, each carrying one-sided clamped
  dates (`📅 E−1` before the boundary, `🛫 E+1` after it — never an inverted pair).
- Unknown (prose) lines stay position-stable.

`complete` / `unarchive` restore a nested task under its parent via `[parent::]`.
Top-level position is not stored, so an undated root unarchives to the end of the
timeline. (The old `[section::]` hint is no longer written; any that remain are
preserved but ignored.)

---

## 6. Validation

`validate()` reports issues without mutating. Severities:

- **error** — violates a hard invariant.
- **warning** — preserved but suspicious.
- **info** — allowed but noteworthy.

| Code | Severity | Meaning |
| --- | --- | --- |
| `EVENT_NO_DATE` | error | Event has no `📅` date. |
| `START_AFTER_DUE` | error | `start` is later than `due`. |
| `UNSUPPORTED_LINE` | warning | An unrecognized line was preserved verbatim. |
| `ARCHIVE_NO_DONE` | info | An archived root has no `✅` date; ordering falls back to text. |
| `DONE_NO_DATE` | info | A checked task has no `✅` date. |
| `COMPLETED_IN_TIMELINE` | info | A completed task is still in the timeline. |

`hasBlockingErrors(issues)` reports whether any error-level issue exists.

---

## 7. Determinism

Operations never use the wall-clock and take an explicit `done` date, so tests
are reproducible. Identifier minting uses an injectable seeded PRNG
(mulberry32), so a fixed seed produces byte-identical output.

---

## 8. CLI reference (`tsk`)

The `@task-system/cli` package exposes the `tsk` binary over this format:

```
tsk <command> [file] [options]

  init                                 print an empty canonical document
  parse <file> [--json]                parse and re-emit (or dump the AST)
  validate <file> [--json]             report constraint issues (exit 1 on error)
  format <file> [--write|--check]      canonicalize (stdout, in place, or verify)
  list <file> [--open|--done] [--json] list tasks
  add <file> "<text>" [--start D --due D --created D --parent TEXT|--parent-line N --event] [--json]
  set <file> (--line N|--id X|--match T) [--text T --start D --due D --created D] [--json]
  complete <file> (--line N|--id X|--match T) --done DATE [--seed N] [--json]
  unarchive <file> (--line N|--id X|--match T) [--json]
  rm <file> (--line N|--id X|--match T) [--recursive] [--json]
  event add <file> "<text>" --due DATE [--json]
  event rm <file> (--line N|--id X|--match T) [--json]
  serve <file> [--port N]              serve the web app backed by <file> (Ctrl+C to stop)
```

Dates are ISO `YYYY-MM-DD`. `--line` is 1-based as shown by `list`.
