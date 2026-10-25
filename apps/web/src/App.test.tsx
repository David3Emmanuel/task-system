// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { App } from './App';

const DOC = '# T\n\n- [ ] Buy milk 📅 2026-01-01\n';

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** Mock `/doc`: GET returns the file, PUT acknowledges the save. */
function mockFile(text: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? jsonResponse({ etag: 'etag-2' })
        : jsonResponse({ text, etag: 'etag-1', name: 'Tasks.md' }),
    ),
  );
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('file mode', () => {
  test('shows the file badge and the task', async () => {
    mockFile(DOC);
    render(<App />);
    expect(await screen.findByText(/Tasks\.md/)).toBeInTheDocument();
    expect(await screen.findByText('Buy milk')).toBeInTheDocument();
  });

  test('delete offers Undo, and Undo restores the task', async () => {
    mockFile(DOC);
    render(<App />);
    await screen.findByText(/Tasks\.md/);

    fireEvent.click(screen.getByLabelText('Delete task'));
    expect(await screen.findByText('Task deleted')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Undo'));
    expect(await screen.findByText('Buy milk')).toBeInTheDocument();
  });

  test('reports the save state after an edit', async () => {
    mockFile(DOC);
    render(<App />);
    await screen.findByText(/Tasks\.md/);
    fireEvent.click(screen.getByLabelText('Delete task'));
    expect(await screen.findByText('Saved', {}, { timeout: 3000 })).toBeInTheDocument();
  });
});

describe('demo mode', () => {
  test('labels the fallback instead of hiding it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    render(<App />);
    expect(await screen.findByText(/Demo — changes stay in this browser/)).toBeInTheDocument();
    expect(screen.getByText('Retry')).toBeInTheDocument();
  });
});

describe('empty state', () => {
  test('explains an empty document', async () => {
    mockFile('# Empty\n');
    render(<App />);
    expect(await screen.findByText(/No tasks yet/)).toBeInTheDocument();
  });
});

describe('pane layout', () => {
  test('split shows both panes and a 50% separator', async () => {
    mockFile(DOC);
    render(<App />);
    await screen.findByText(/Tasks\.md/);
    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Markdown' })).toBeInTheDocument();
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '50');
  });

  test('switches between UI and Markdown single-pane views', async () => {
    mockFile(DOC);
    render(<App />);
    await screen.findByText(/Tasks\.md/);

    fireEvent.click(screen.getByRole('button', { name: 'Markdown' }));
    expect(screen.getByRole('heading', { name: 'Markdown' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Tasks' })).not.toBeInTheDocument();
    expect(screen.queryByRole('separator')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'UI' }));
    expect(screen.getByRole('heading', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Markdown' })).not.toBeInTheDocument();
  });

  test('the divider is keyboard operable', async () => {
    mockFile(DOC);
    render(<App />);
    await screen.findByText(/Tasks\.md/);
    const sep = screen.getByRole('separator');

    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(sep).toHaveAttribute('aria-valuenow', '52');
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(sep).toHaveAttribute('aria-valuenow', '50');

    fireEvent.keyDown(sep, { key: 'End' });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBeGreaterThanOrEqual(70);
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(Number(sep.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(30);
  });

  test('remembers the chosen view', async () => {
    localStorage.setItem('task-system:view', 'markdown');
    mockFile(DOC);
    render(<App />);
    await screen.findByText(/Tasks\.md/);
    expect(screen.getByRole('heading', { name: 'Markdown' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Tasks' })).not.toBeInTheDocument();
  });

  test('restores the split ratio', async () => {
    localStorage.setItem('task-system:view', 'split');
    localStorage.setItem('task-system:split', '70');
    mockFile(DOC);
    render(<App />);
    await screen.findByText(/Tasks\.md/);
    expect(screen.getByRole('separator')).toHaveAttribute('aria-valuenow', '70');
  });
});
