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
import { ThemeToggle } from './ThemeToggle';
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

interface Toast {
  message: string;
  undo?: () => void;
}

export function App() {
  // The raw markdown is the single source of truth. In "file" mode (served by
  // `tsk serve <file>`) it's read/written to a real file via the /doc endpoint;
  // in "demo" mode it's an in-memory sample + localStorage. Either way, every
  // UI edit produces a new document and commits it back as text.
  const { text, mode, notice, fileName, updateText, saveState, demoCause, retry, retrySave } =
    useDocument(loadInitial());
  const doc = useMemo(() => parse(text), [text]);
  const issues = useMemo(() => validate(doc), [doc]);

  const [showMarkdown, setShowMarkdown] = useState(() => {
    try {
      return window.matchMedia('(min-width: 901px)').matches;
    } catch {
      return true;
    }
  });
  const [toast, setToast] = useState<Toast | null>(null);

  // Persist to localStorage only in demo mode.
  useEffect(() => {
    if (mode !== 'demo') return;
    try {
      localStorage.setItem(STORAGE_KEY, text);
    } catch {
      /* ignore */
    }
  }, [text, mode]);

  useEffect(() => {
    document.title = fileName ? `${fileName} — Task-System` : 'Task-System';
  }, [fileName]);

  // Auto-dismiss the toast; a new toast restarts the timer.
  useEffect(() => {
    if (!toast) return;
    const id = window.setTimeout(() => setToast(null), 8000);
    return () => window.clearTimeout(id);
  }, [toast]);

  const commit = useCallback((next: TaskDocument) => updateText(format(next)), [updateText]);

  /** Apply a document operation, offering Undo for the previous text. */
  const act = useCallback(
    (fn: (d: TaskDocument) => TaskDocument, message: string) => {
      const prior = text;
      try {
        commit(fn(doc));
        setToast({ message, undo: () => updateText(prior) });
      } catch (err) {
        if (err instanceof OpError) setToast({ message: err.message });
        else throw err;
      }
    },
    [doc, text, commit, updateText],
  );

  /** Replace the whole document, offering Undo. */
  const replaceAll = useCallback(
    (next: string, message: string) => {
      const prior = text;
      updateText(next);
      setToast({ message, undo: () => updateText(prior) });
    },
    [text, updateText],
  );

  const callbacks: TaskCallbacks = {
    onToggle(node, region) {
      if (region === 'timeline') {
        // Completed-in-timeline can't be reopened with the current ops; the
        // archive is the reopen path. Events are completed the same way.
        if (node.checked) return;
        act(
          (d) => complete(d, locatorFor(node), { done: today(), rng: seededRng(1) }),
          'Task completed',
        );
      } else {
        act((d) => unarchive(d, locatorFor(node)), 'Task reopened');
      }
    },
    onDelete(node) {
      act((d) => rm(d, locatorFor(node), { recursive: true }), 'Task deleted');
    },
    onEdit(node, fields) {
      act((d) => set(d, locatorFor(node), fields), 'Task updated');
    },
    onAddChild(node, text) {
      act((d) => add(d, { text, parent: locatorFor(node) }), 'Subtask added');
    },
  };

  if (mode === 'loading') {
    return <div className="app loading">Connecting…</div>;
  }

  const closeMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.closest('details')?.removeAttribute('open');
  };

  return (
    <div className="app">
      {toast ? (
        <div className="toast" role="status">
          <span>{toast.message}</span>
          {toast.undo && (
            <button
              className="toast-action"
              onClick={() => {
                toast.undo?.();
                setToast(null);
              }}
            >
              Undo
            </button>
          )}
        </div>
      ) : notice ? (
        <div className="toast" role="status">
          {notice}
        </div>
      ) : null}

      <header className="topbar">
        <span className="brand">Task-System</span>

        {fileName ? (
          <span className="file-badge" title="Saving to this file">
            📄 {fileName}
          </span>
        ) : mode === 'demo' ? (
          <>
            <span className="demo-badge" title="Changes are stored in this browser only">
              Demo — changes stay in this browser
            </span>
            {demoCause === 'unreachable' && (
              <button onClick={retry} title="Try to reach the file server again">
                Retry
              </button>
            )}
          </>
        ) : null}

        <TitleInput
          value={doc.title ?? ''}
          onCommit={(t) => commit({ ...doc, title: t || null })}
        />

        <span className="spacer" />

        {saveState === 'saving' && <span className="save-state">Saving…</span>}
        {saveState === 'saved' && <span className="save-state">Saved</span>}
        {saveState === 'error' && (
          <button className="save-state error" onClick={retrySave}>
            Save failed — retry
          </button>
        )}

        <button
          onClick={() => replaceAll(format(doc), 'Reformatted')}
          title="Reformat to canonical order"
        >
          Format
        </button>

        <details className="menu">
          <summary aria-label="More actions" title="More actions">
            ⋯
          </summary>
          <div className="menu-items">
            <button
              onClick={(e) => {
                closeMenu(e);
                replaceAll(SAMPLE, 'Loaded the sample');
              }}
            >
              Load sample
            </button>
            <button
              onClick={(e) => {
                closeMenu(e);
                replaceAll(format(emptyDocument()), 'Cleared the document');
              }}
            >
              Clear document
            </button>
          </div>
        </details>

        <button
          onClick={() => setShowMarkdown((v) => !v)}
          aria-pressed={showMarkdown}
          title="Show or hide the Markdown pane"
        >
          Markdown
        </button>

        <ThemeToggle />
      </header>

      <StatusBar issues={issues} />

      <Toolbar
        onAddTask={(o) => act((d) => add(d, o), 'Task added')}
        onAddEvent={(label, due) => act((d) => addEvent(d, label, due), 'Milestone added')}
      />

      <main className={`panes ${showMarkdown ? '' : 'single'}`}>
        <section className="pane">
          <h2>Tasks</h2>
          <TaskList timeline={doc.timeline} archive={doc.archive} callbacks={callbacks} />
        </section>
        {showMarkdown && (
          <section className="pane">
            <h2>Markdown</h2>
            <Editor text={text} onChange={updateText} />
          </section>
        )}
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
