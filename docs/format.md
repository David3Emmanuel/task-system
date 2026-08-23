# Task-System Markdown Format

Task-System is a deterministic, AI-friendly task format built on plain Markdown.
It is a superset of the [Obsidian Tasks](https://publish.obsidian.md/tasks/) line
syntax: the parser reads hand-edited files tolerantly, and the formatter emits a
canonical form that is **idempotent**, **confluent** (input order does not matter),
and **id-stable** (it never invents or strips tool properties).

This document is the single reference for the format. The parser, formatter,
validator, and section logic in `@task-system/core` are the implementation; see
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
  - free **text**, which may contain unmodeled tokens (`#tags`, `⏫`, `🔁`, prose)
    kept verbatim in their original relative order.

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

### Events (milestones)

A task bearing the `🏁` marker is an **event**. Events are always top-level,
carry a single `📅 due` date, and partition the timeline into sections (see
§5). They are conventionally left open (`[ ]`).

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
| `[section:: <event-date>\|start]` | Restore hint for an archived undated task. |

Example:

```
- [ ] Parent [id:: 3f9k2a]
- [x] Child ✅ 2026-03-01 [parent:: 3f9k2a] [section:: start]
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
- **Confluent**: the canonical form depends only on content, not on the input
  ordering of siblings or sections (a total-order tiebreak makes the sort unique).
- **Id-stable**: `[id::]`, `[parent::]`, `[section::]` are never created or removed.
- **No wall-clock**: output is a pure function of the AST.

A serialized line uses this order:

```
- [x] Text 🛫 start 📅 due ✅ done ➕ created [id:: x] [parent:: y] [section:: z]
```

---

## 5. Section model

Top-level events partition the timeline. With event dates `E0 < E1 < …`, the
sections are:

```
S0 (before E0)  |  E0  |  S1 (E0..E1)  |  E1  |  S2 (E1..E2)  |  …
```

Placement rules:

- **Dated tasks** (open) are placed by their **anchor date** — `start ?? due` —
  into the section whose index is `count(events with date <= anchor)`. A task
  whose anchor equals an event date lands in the section *after* that event.
- **Undated or completed** top-level tasks are placed by their **original file
  position** (count of events before them).
- Within a section, order is **open-dated → open-undated → completed**, each by a
  total-order sort (dates, then text, then the serialized line as a final tiebreak).

The `complete` / `unarchive` operations are designed as exact inverses: a nested
completion records `[parent::]`, and an undated root records `[section::]` so it
can be restored to the same spot.

---

## 6. Validation

`validate()` reports issues without mutating. Severities:

- **error** — violates a hard invariant.
- **warning** — preserved but suspicious.
- **info** — allowed but noteworthy.

| Code | Severity | Meaning |
| --- | --- | --- |
| `EVENT_NO_DATE` | error | Event has no `📅` date. |
| `EVENT_NOT_INCREASING` | error | Event dates do not strictly increase in file order. |
| `START_AFTER_DUE` | error | `start` is later than `due`. |
| `STRADDLES_EVENT` | warning | A task’s span (`endDate`) extends past the next event. |
| `UNSUPPORTED_LINE` | warning | An unrecognized line was preserved verbatim. |
| `ARCHIVE_NO_DONE` | warning | An archived root has no `✅` date. |
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
  add <file> "<text>" [--start D --due D --created D --parent TEXT --event] [--json]
  set <file> (--line N|--id X|--match T) [--text T --start D --due D --created D] [--json]
  complete <file> (--line N|--id X|--match T) --done DATE [--seed N] [--json]
  unarchive <file> (--line N|--id X|--match T) [--json]
  rm <file> (--line N|--id X|--match T) [--recursive] [--json]
  event add <file> "<text>" --due DATE [--json]
  event rm <file> (--line N|--id X|--match T) [--json]
  serve <file> [--port N]              serve the web app backed by <file> (Ctrl+C to stop)
```

Dates are ISO `YYYY-MM-DD`. `--line` is 1-based as shown by `list`.
