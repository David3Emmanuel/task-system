import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  parse,
  format,
  validate,
  add,
  addEvent,
  rm,
  complete,
  unarchive,
  set,
  emptyDocument,
  seededRng,
  OpError,
  type TaskDocument,
  type TaskNode,
} from '@task-system/core';
import { Editor } from './Editor';
import { TaskList, type TaskCallbacks } from './TaskList';
import { Toolbar } from './Toolbar';
import { StatusBar } from './StatusBar';
import { TitleInput } from './TitleInput';
import { useDocument } from './useFileDoc';

const STORAGE_KEY = 'task-system:doc';

const SAMPLE = `# Launch plan

- [ ] 🏁 Kickoff 📅 2026-03-02
- [ ] Finalize scope 📅 2026-03-06
- [ ] Research competitors 🛫 2026-03-03 📅 2026-03-07
- [ ] Draft proposal
  - [ ] Outline
  - [ ] Budget estimate 📅 2026-03-10
- [ ] 🏁 Review 📅 2026-03-14
- [ ] Ship v1 📅 2026-03-20

## Archive

- [x] Set up repo ✅ 2026-03-01
`;

function loadInitial(): string {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved != null) return saved;
  } catch {
    /* localStorage unavailable; fall through to sample */
  }
  return SAMPLE;
}

const today = () => new Date().toISOString().slice(0, 10);

export function App() {
  // The raw markdown is the single source of truth. In "file" mode (served by
  // `tsk serve <file>`) it's read/written to a real file via the /doc endpoint;
  // in "demo" mode it's an in-memory sample + localStorage. Either way, every
  // UI edit produces a new document and commits it back as text.
  const { text, mode, notice, fileName, updateText } = useDocument(loadInitial());
  const doc = useMemo(() => parse(text), [text]);
  const issues = useMemo(() => validate(doc), [doc]);

  // Persist to localStorage only in demo mode.
  useEffect(() => {
    if (mode !== 'demo') return;
    try {
      localStorage.setItem(STORAGE_KEY, text);
    } catch {
      /* ignore */
    }
  }, [text, mode]);

  const commit = useCallback((next: TaskDocument) => updateText(format(next)), [updateText]);

  const run = useCallback(
    (fn: (d: TaskDocument) => TaskDocument) => {
      try {
        commit(fn(doc));
      } catch (err) {
        if (err instanceof OpError) window.alert(`${err.code}: ${err.message}`);
        else throw err;
      }
    },
    [doc, commit],
  );

  const callbacks: TaskCallbacks = {
    onToggle(node, region) {
      if (node.isEvent) return;
      if (region === 'timeline') {
        // Completed-in-timeline can't be reopened with the current ops; the
        // archive is the reopen path.
        if (node.checked) return;
        run((d) => complete(d, locatorFor(node), { done: today(), rng: seededRng(1) }));
      } else {
        run((d) => unarchive(d, locatorFor(node)));
      }
    },
    onDelete(node) {
      if (node.children.length > 0 && !window.confirm('Delete this task and all its subtasks?')) {
        return;
      }
      run((d) => rm(d, locatorFor(node), { recursive: true }));
    },
    onEdit(node, fields) {
      run((d) => set(d, locatorFor(node), fields));
    },
  };

  if (mode === 'loading') {
    return <div className="app loading">Connecting…</div>;
  }

  return (
    <div className="app">
      {notice && <div className="notice">{notice}</div>}

      <header className="topbar">
        <span className="brand">Task‑System</span>
        {fileName && (
          <span className="file-badge" title="Saving to this file">
            📄 {fileName}
          </span>
        )}
        <TitleInput
          value={doc.title ?? ''}
          onCommit={(t) => commit({ ...doc, title: t || null })}
        />
        <span className="spacer" />
        <button
          onClick={() =>
            window.confirm('Replace the document with the sample?') && updateText(SAMPLE)
          }
        >
          Sample
        </button>
        <button
          onClick={() => window.confirm('Start from an empty document?') && commit(emptyDocument())}
        >
          Clear
        </button>
      </header>

      <StatusBar issues={issues} />

      <Toolbar
        onAddTask={(o) => run((d) => add(d, o))}
        onAddEvent={(label, due) => run((d) => addEvent(d, label, due))}
      />

      <main className="panes">
        <section className="pane">
          <h2>Tasks</h2>
          <TaskList timeline={doc.timeline} archive={doc.archive} callbacks={callbacks} />
        </section>
        <section className="pane">
          <h2>Markdown</h2>
          <Editor text={text} onChange={updateText} />
        </section>
      </main>
    </div>
  );
}

/** Resolve a UI node back to a core Locator, preferring source line. */
function locatorFor(node: TaskNode): { line: number } | { id: string } | { match: string } {
  if (node.sourceLine !== undefined) return { line: node.sourceLine };
  if (node.props.id) return { id: node.props.id };
  return { match: node.text };
}
