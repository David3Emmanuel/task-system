# Task-System

A deterministic, AI-friendly task format built on plain Markdown, with a
`tsk` command-line tool, a two-way-sync web UI, and a core library that keeps
them all consistent.

The idea: your task list **is** a Markdown file you can edit by hand. A strict,
predictable parser + formatter (`@task-system/core`) turns that file into a
structured model and back to canonical text, so a CLI, a GUI, and an AI agent
can all read and write the same source of truth without fighting over it.

```
- [ ] 🏁 Kickoff 📅 2026-03-02          <- event / milestone
- [ ] Research 🛫 2026-03-03 📅 2026-03-07
- [ ] Draft proposal
  - [ ] Outline                          <- nested subtask
- [x] Write spec 📅 2026-03-06 ✅ 2026-03-05

## Archive                               <- completed tasks live here

- [x] Set up repo ✅ 2026-03-01
```

## Features

- **Deterministic format** — `format()` is idempotent and confluent (input
  order never matters); no wall-clock, injectable seeded RNG, so output is
  reproducible.
- **Tolerant parsing** — hand-edited files (and Obsidian Tasks syntax) parse
  without errors; unrecognized lines are preserved position-stable.
- **Structured model** — frontmatter, title, a nested timeline partitioned by
  milestones, and an archive, with four date fields (`🛫` start, `📅` due,
  `✅` done, `➕` created).
- **Exact archive round-trip** — `complete` / `unarchive` are inverse
  operations that restore a task to its original parent and section.
- **Two surfaces** — a `tsk` CLI and a React SPA that both talk to the same
  core library.

## Project layout

This is an npm workspaces monorepo.

| Package | Description |
| --- | --- |
| [`@task-system/core`](packages/core) | Parser, formatter, validator, and operations. The single source of truth. |
| [`@task-system/cli`](packages/cli) | The `tsk` command-line tool. |
| [`@task-system/web`](apps/web) | React SPA demonstrating two-way sync between a task UI and raw Markdown. |

The format itself is documented in [`docs/format.md`](docs/format.md).

---

## Installation

### Run the CLI globally

Prerequisite: [Node.js](https://nodejs.org) 18+ and npm.

```bash
# from the repository root
npm install          # install workspace dependencies
npm run build        # compile core + cli (and web)
```

Then link the `tsk` binary into your global npm install so it works anywhere:

```bash
npm link @task-system/cli
# or, inside the cli package:
#   cd packages/cli && npm link
```

Verify it works:

```bash
tsk --help
```

> `npm link` points the global `tsk` at this checkout, so after you `git pull`
> you may want to re-run `npm run build` to refresh the compiled output.

### Use it locally without installing

From the repo root you can run the tool through the workspace without any global
install:

```bash
npm run cli -- list tasks.md
npm run cli -- complete tasks.md --match "write spec" --done 2026-03-05
```

---

## CLI usage (`tsk`)

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

Quick tour:

```bash
# start a new task file from the canonical skeleton
tsk init > tasks.md

# add a task and a milestone
tsk add tasks.md "Write spec" --due 2026-03-06
tsk event add tasks.md "Kickoff" --due 2026-03-02

# see what the tool reads back
tsk list tasks.md
tsk validate tasks.md

# mark done -> moves the task into the Archive section
tsk complete tasks.md --match "write spec" --done 2026-03-05

# normalize ordering/sections in place
tsk format tasks.md --write
```

Details:

- **Locators** — `--line N` (1-based, as `list` prints), `--id X`, or
  `--match TEXT` (case-insensitive substring). `--line` / `--id` take precedence.
- **Dates** — ISO `YYYY-MM-DD`. `complete` requires an explicit `--done DATE`;
  the tool never guesses "today".
- **Mutating commands write back atomically** and print the new canonical text.
  Add `--json` for a `{ text, issues }` envelope.
- **Exit codes** — `0` success, `1` validation/soft failure, `2` usage error.

---

## Web app

`@task-system/web` is a two-pane React demo: edit the Markdown on the right and
the task list updates live; click the list on the left and it writes back to the
Markdown. As a plain demo it persists to `localStorage`.

To run it **linked to a real file** (not localStorage), use `tsk serve`:

```bash
npm run build                        # build the web app (required first)
tsk serve tasks.md                   # serves the UI backed by tasks.md
tsk serve tasks.md --port 8080       # or a custom port (default 4173)
```

It creates the file with an empty document if it doesn't exist, then serves the
app at `http://127.0.0.1:4173`. Every change saves back to the file (atomically,
debounced). If the file is edited elsewhere (e.g. in Obsidian) while the app is
open, the app detects the conflict and reloads rather than overwriting your
external edit.

For the dev server with hot reload (demo/localStorage only):

```bash
npm run dev          # http://localhost:5173
```

---

## Development

```bash
npm install          # install all workspace deps
npm run build        # type-check + build every package
npm test             # run the vitest suite
npm run format       # prettier --write .
```

The test suite covers the parser, formatter, operations, validation, section
math, ids, and the CLI end-to-end.

---

## The format in one screen

A document has four regions: optional `---` frontmatter, an optional `# ` title,
a nested **timeline** (tasks and `🏁` events), and an optional trailing
`## Archive`. Four date fields are recognized in emoji or `[field:: DATE]` form.
Top-level events partition the timeline into date-based sections; the formatter
places dated tasks by their anchor date (`start ?? due`) and undated/completed
tasks by their original position.

See [`docs/format.md`](docs/format.md) for the full specification.

## License

See the `LICENSE` file (add one if you intend to publish this publicly).
