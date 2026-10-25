import type { Issue } from '@task-system/core';

export function StatusBar({ issues }: { issues: Issue[] }) {
  const errs = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.filter((i) => i.severity === 'warning').length;
  const notes = issues.filter((i) => i.severity === 'info').length;
  const cls = errs > 0 ? 'bad' : warns > 0 ? 'warn' : 'good';
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  return (
    <div className={`status ${cls}`}>
      <span className="status-line">
        <span className="dot" />{' '}
        {issues.length === 0 ? (
          'No issues'
        ) : (
          <>
            {plural(errs, 'error')} · {plural(warns, 'warning')} · {plural(notes, 'note')}
          </>
        )}
      </span>
      {issues.length > 0 && (
        <ul className="issue-list">
          {issues.slice(0, 8).map((it, i) => (
            <li key={i}>
              <b>{it.severity === 'info' ? 'note' : it.severity}</b> {it.message}
              {it.line !== undefined ? ` (line ${it.line + 1})` : ''}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
