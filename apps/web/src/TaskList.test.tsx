// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { parse } from '@task-system/core';
import { TaskList, type TaskCallbacks } from './TaskList';

afterEach(cleanup);

function renderList(src: string, overrides: Partial<TaskCallbacks> = {}): TaskCallbacks {
  const doc = parse(src);
  const callbacks: TaskCallbacks = {
    onToggle: vi.fn(),
    onDelete: vi.fn(),
    onEdit: vi.fn(),
    onAddChild: vi.fn(),
    ...overrides,
  };
  render(<TaskList timeline={doc.timeline} archive={doc.archive} callbacks={callbacks} />);
  return callbacks;
}

describe('task rows', () => {
  test('the checkbox carries the task text as its accessible name', () => {
    renderList('- [ ] Buy milk\n');
    expect(screen.getByRole('checkbox', { name: 'Buy milk — complete' })).toBeInTheDocument();
  });

  test('an archived row offers reopen instead of complete', () => {
    renderList('# T\n\n## Archive\n\n- [x] Old ✅ 2026-01-01\n');
    expect(screen.getByRole('checkbox', { name: 'Old — reopen' })).toBeInTheDocument();
  });
});

describe('inline edit', () => {
  test('Enter saves the edit', () => {
    const callbacks = renderList('- [ ] Buy milk\n');
    fireEvent.click(screen.getByLabelText('Edit task'));
    const input = screen.getByDisplayValue('Buy milk');
    fireEvent.change(input, { target: { value: 'Buy oat milk' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(callbacks.onEdit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ text: 'Buy oat milk' }),
    );
  });

  test('Escape cancels without saving', () => {
    const callbacks = renderList('- [ ] Buy milk\n');
    fireEvent.click(screen.getByLabelText('Edit task'));
    const input = screen.getByDisplayValue('Buy milk');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(callbacks.onEdit).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });
});

describe('empty state', () => {
  test('an empty document shows guidance', () => {
    renderList('# T\n');
    expect(screen.getByText(/No tasks yet/)).toBeInTheDocument();
  });
});
