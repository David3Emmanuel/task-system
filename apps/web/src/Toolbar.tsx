import { useState } from 'react';

export interface AddTask {
  text: string;
  start?: string;
  due?: string;
}

export function Toolbar({
  onAddTask,
  onAddEvent,
}: {
  onAddTask: (opts: AddTask) => void;
  onAddEvent: (text: string, due: string) => void;
}) {
  const [task, setTask] = useState({ text: '', start: '', due: '' });
  const [ev, setEv] = useState({ text: '', due: '' });
  const [showEvent, setShowEvent] = useState(false);

  const canAddTask = task.text.trim().length > 0;
  const canAddEvent = ev.text.trim().length > 0 && ev.due.length > 0;

  const submitTask = (e: React.FormEvent) => {
    e.preventDefault();
    const text = task.text.trim();
    if (!text) return;
    onAddTask({
      text,
      ...(task.start ? { start: task.start } : {}),
      ...(task.due ? { due: task.due } : {}),
    });
    setTask({ text: '', start: '', due: '' });
  };

  const submitEvent = (e: React.FormEvent) => {
    e.preventDefault();
    const text = ev.text.trim();
    if (!text || !ev.due) return;
    onAddEvent(text, ev.due);
    setEv({ text: '', due: '' });
  };

  return (
    <div className="toolbar">
      <form className="add-form" onSubmit={submitTask}>
        <input
          className="grow"
          value={task.text}
          placeholder="Add a task…"
          aria-label="Task text"
          onChange={(e) => setTask((t) => ({ ...t, text: e.target.value }))}
        />
        <label>
          Start
          <input
            type="date"
            value={task.start}
            onChange={(e) => setTask((t) => ({ ...t, start: e.target.value }))}
          />
        </label>
        <label>
          Due
          <input
            type="date"
            value={task.due}
            onChange={(e) => setTask((t) => ({ ...t, due: e.target.value }))}
          />
        </label>
        <button type="submit" disabled={!canAddTask}>
          Add task
        </button>
      </form>

      {showEvent ? (
        <form className="add-form event-form" onSubmit={submitEvent}>
          <span className="flag">🏁</span>
          <input
            className="grow"
            value={ev.text}
            placeholder="Add a milestone…"
            aria-label="Milestone text"
            onChange={(e) => setEv((x) => ({ ...x, text: e.target.value }))}
          />
          <label>
            Due
            <input
              type="date"
              value={ev.due}
              aria-label="Milestone date"
              onChange={(e) => setEv((x) => ({ ...x, due: e.target.value }))}
            />
          </label>
          <button type="submit" disabled={!canAddEvent}>
            Add milestone
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              setEv({ text: '', due: '' });
              setShowEvent(false);
            }}
          >
            Cancel
          </button>
        </form>
      ) : (
        <button type="button" className="ghost toolbar-toggle" onClick={() => setShowEvent(true)}>
          + Milestone
        </button>
      )}
    </div>
  );
}
