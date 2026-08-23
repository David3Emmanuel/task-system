import { useEffect, useState } from 'react';
import { EMOJI, type TaskNode, type TimelineNode } from '@task-system/core';

export interface TaskCallbacks {
  onToggle: (node: TaskNode, region: 'timeline' | 'archive') => void;
  onDelete: (node: TaskNode) => void;
  onEdit: (
    node: TaskNode,
    fields: { text?: string; start?: string | null; due?: string | null },
  ) => void;
}

interface Props {
  timeline: TimelineNode[];
  archive: TaskNode[] | null;
  callbacks: TaskCallbacks;
}

export function TaskList({ timeline, archive, callbacks }: Props) {
  return (
    <div className="task-list">
      <ul className="roots">
        {timeline.map((n, i) => (
          <NodeView key={keyFor(n, i)} node={n} depth={0} region="timeline" callbacks={callbacks} />
        ))}
      </ul>

      {archive && archive.length > 0 && (
        <>
          <h3 className="archive-title">Archive</h3>
          <ul className="roots">
            {archive.map((n, i) => (
              <NodeView
                key={keyFor(n, i)}
                node={n}
                depth={0}
                region="archive"
                callbacks={callbacks}
              />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function keyFor(n: TimelineNode, fallback: number): string {
  if (n.kind === 'unknown') return `u${n.sourceLine ?? fallback}`;
  return n.props.id ?? (n.sourceLine !== undefined ? `L${n.sourceLine}` : `n${fallback}`);
}

function NodeView({
  node,
  depth,
  region,
  callbacks,
}: {
  node: TimelineNode;
  depth: number;
  region: 'timeline' | 'archive';
  callbacks: TaskCallbacks;
}) {
  if (node.kind === 'unknown') {
    return (
      <li className="node unknown" style={{ paddingLeft: depth * 18 }}>
        <code>{node.text}</code>
      </li>
    );
  }
  return (
    <li className="node" style={{ paddingLeft: depth * 18 }}>
      <TaskRow node={node} region={region} callbacks={callbacks} />
      {node.children.length > 0 && (
        <ul>
          {node.children.map((c, i) => (
            <NodeView
              key={keyFor(c, i)}
              node={c}
              depth={depth + 1}
              region={region}
              callbacks={callbacks}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function TaskRow({
  node,
  region,
  callbacks,
}: {
  node: TaskNode;
  region: 'timeline' | 'archive';
  callbacks: TaskCallbacks;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    text: node.text,
    start: node.dates.start ?? '',
    due: node.dates.due ?? '',
  });

  // Keep the draft fresh when the task changes from outside (unless mid-edit).
  useEffect(() => {
    if (!editing) {
      setDraft({ text: node.text, start: node.dates.start ?? '', due: node.dates.due ?? '' });
    }
  }, [node.text, node.dates.start, node.dates.due, editing]);

  const done = node.dates.done;

  if (editing) {
    return (
      <div className="row edit">
        <input
          className="edit-text"
          value={draft.text}
          autoFocus
          onChange={(e) => setDraft((d) => ({ ...d, text: e.target.value }))}
        />
        <div className="edit-fields">
          <label>
            Start
            <input
              type="date"
              value={draft.start}
              onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))}
            />
          </label>
          <label>
            Due
            <input
              type="date"
              value={draft.due}
              onChange={(e) => setDraft((d) => ({ ...d, due: e.target.value }))}
            />
          </label>
        </div>
        <div className="row-actions">
          <button
            onClick={() => {
              callbacks.onEdit(node, {
                text: draft.text.trim() || node.text,
                start: draft.start || null,
                due: draft.due || null,
              });
              setEditing(false);
            }}
          >
            Save
          </button>
          <button className="ghost" onClick={() => setEditing(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`row ${node.isEvent ? 'event' : ''} ${done ? 'done' : ''}`}>
      <input
        type="checkbox"
        checked={node.checked}
        disabled={node.isEvent || (region === 'timeline' && node.checked)}
        title={node.isEvent ? 'Milestone' : undefined}
        onChange={() => callbacks.onToggle(node, region)}
      />
      {node.isEvent && <span className="flag">🏁</span>}
      <span className="text">{node.text}</span>
      {node.dates.start && <Chip emoji={EMOJI.start} value={node.dates.start} kind="start" />}
      {node.dates.due && <Chip emoji={EMOJI.due} value={node.dates.due} kind="due" />}
      {done && <Chip emoji={EMOJI.done} value={done} kind="done" />}
      {node.props.id && <span className="id">{node.props.id}</span>}
      <span className="spacer" />
      <div className="row-actions">
        <button
          className="ghost"
          title="Edit"
          onClick={() => {
            setDraft({ text: node.text, start: node.dates.start ?? '', due: node.dates.due ?? '' });
            setEditing(true);
          }}
        >
          ✎
        </button>
        <button className="ghost danger" title="Delete" onClick={() => callbacks.onDelete(node)}>
          ✕
        </button>
      </div>
    </div>
  );
}

function Chip({ emoji, value, kind }: { emoji: string; value: string; kind: string }) {
  return (
    <span className={`chip ${kind}`} title={`${kind} ${value}`}>
      {emoji} {value}
    </span>
  );
}
