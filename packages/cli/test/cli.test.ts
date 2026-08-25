import { expect, test, describe, beforeEach } from 'vitest';
import { run, type Io } from '../src/run.js';

/** In-memory filesystem so the CLI runs without touching disk. */
class MemoryIo implements Io {
  files = new Map<string, string>();
  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.files.set(k, v);
  }
  readText(path: string): string {
    const v = this.files.get(path);
    if (v === undefined) throw new Error(`no such file: ${path}`);
    return v;
  }
  writeTextAtomic(path: string, text: string): void {
    this.files.set(path, text);
  }
  fileExists(path: string): boolean {
    return this.files.has(path);
  }
}

const FILE = 'tasks.md';
let io: MemoryIo;
beforeEach(() => {
  io = new MemoryIo({ [FILE]: '# T\n\n- [ ] Alpha 📅 2026-08-10\n- [ ] Beta\n' });
});

describe('read commands', () => {
  test('init prints an empty document without touching disk', () => {
    const r = run(['init'], io);
    expect(r.code).toBe(0);
    expect(r.write ?? null).toBeNull();
  });

  test('parse --json dumps the AST', () => {
    const r = run(['parse', FILE, '--json'], io);
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.title).toBe('T');
    expect(doc.timeline.length).toBe(2);
  });

  test('validate exits 0 on a clean file', () => {
    expect(run(['validate', FILE], io).code).toBe(0);
  });

  test('validate exits 1 on a blocking error', () => {
    io.files.set(FILE, '- [ ] 🏁 A 📅 2026-08-10\n- [ ] 🏁 B 📅 2026-08-01\n');
    const r = run(['validate', FILE], io);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('EVENT_NOT_INCREASING');
  });

  test('format --check flags a non-canonical file', () => {
    io.files.set(FILE, '- [ ]   Messy    📅 2026-08-10\n');
    const r = run(['format', FILE, '--check'], io);
    expect(r.code).toBe(1);
  });

  test('format --write rewrites the file atomically', () => {
    io.files.set(FILE, '- [ ] X 📅 2026-08-10 🛫 2026-08-01\n');
    const r = run(['format', FILE, '--write'], io);
    expect(r.code).toBe(0);
    expect(io.files.get(FILE)).toBe('- [ ] X 🛫 2026-08-01 📅 2026-08-10\n');
  });

  test('list --open filters to open tasks', () => {
    const r = run(['list', FILE, '--open', '--json'], io);
    const rows = JSON.parse(r.stdout);
    expect(rows.every((x: { checked: boolean }) => !x.checked)).toBe(true);
  });

  test('--line uses the 1-based number that list prints', () => {
    // `list` prints Alpha at line 3 (1-based: title=1, blank=2, Alpha=3).
    const listed = run(['list', FILE, '--json'], io);
    const alpha = JSON.parse(listed.stdout).find((r: { text: string }) => r.text === 'Alpha');
    const oneBased = alpha.line + 1;
    run(['set', FILE, '--line', String(oneBased), '--text', 'Renamed'], io);
    expect(io.files.get(FILE)).toContain('- [ ] Renamed');
    expect(io.files.get(FILE)).not.toContain('Alpha');
  });
});

describe('mutating commands persist canonical text', () => {
  test('add appends a task and writes back', () => {
    const r = run(['add', FILE, 'Gamma', '--due', '2026-08-20'], io);
    expect(r.code).toBe(0);
    expect(io.files.get(FILE)).toContain('- [ ] Gamma 📅 2026-08-20');
  });

  test('add --parent nests a task under a matched parent', () => {
    const r = run(['add', FILE, 'Subtask', '--parent', 'Alpha'], io);
    expect(r.code).toBe(0);
    expect(io.files.get(FILE)).toContain('  - [ ] Subtask'); // indented => nested
  });

  test('add --parent-line nests a task under the task at that line', () => {
    // list prints Alpha at line 3 (1-based) for the seeded file.
    const r = run(['add', FILE, 'Subtask', '--parent-line', '3'], io);
    expect(r.code).toBe(0);
    expect(io.files.get(FILE)).toContain('  - [ ] Subtask');
  });

  test('add --parent-line rejects a non-numeric line', () => {
    const r = run(['add', FILE, 'Subtask', '--parent-line', 'abc'], io);
    expect(r.code).toBe(2);
    expect(io.files.get(FILE)).not.toContain('Subtask');
  });

  test('set clears a date with an empty value', () => {
    run(['set', FILE, '--match', 'Alpha', '--due', ''], io);
    expect(io.files.get(FILE)).toContain('- [ ] Alpha\n');
  });

  test('complete requires --done and moves the task to the archive', () => {
    const missing = run(['complete', FILE, '--match', 'Alpha'], io);
    expect(missing.code).toBe(2);

    const r = run(['complete', FILE, '--match', 'Alpha', '--done', '2026-08-09'], io);
    expect(r.code).toBe(0);
    const out = io.files.get(FILE)!;
    expect(out).toContain('## Archive');
    expect(out).toContain('- [x] Alpha');
    expect(out).toContain('✅ 2026-08-09');
  });

  test('complete then unarchive restores the original file', () => {
    const original = io.files.get(FILE)!;
    run(['complete', FILE, '--match', 'Alpha', '--done', '2026-08-09'], io);
    run(['unarchive', FILE, '--match', 'Alpha'], io);
    expect(io.files.get(FILE)).toBe(original);
  });

  test('rm refuses a parent with children unless --recursive', () => {
    io.files.set(FILE, '- [ ] Parent\n  - [ ] Child\n');
    const refused = run(['rm', FILE, '--match', 'Parent'], io);
    expect(refused.code).toBe(1);
    const forced = run(['rm', FILE, '--match', 'Parent', '--recursive'], io);
    expect(forced.code).toBe(0);
    expect(io.files.get(FILE)).toBe('');
  });

  test('event add inserts a milestone', () => {
    const r = run(['event', 'add', FILE, 'Launch', '--due', '2026-09-01'], io);
    expect(r.code).toBe(0);
    expect(io.files.get(FILE)).toContain('- [ ] 🏁 Launch 📅 2026-09-01');
  });

  test('event rm removes a milestone', () => {
    io.files.set(FILE, '- [ ] 🏁 Launch 📅 2026-09-01\n- [ ] Alpha\n');
    const r = run(['event', 'rm', FILE, '--match', 'Launch'], io);
    expect(r.code).toBe(0);
    expect(io.files.get(FILE)).not.toContain('Launch');
  });

  test('--json envelopes new text and issues', () => {
    const r = run(['add', FILE, 'Gamma', '--json'], io);
    const env = JSON.parse(r.stdout);
    expect(typeof env.text).toBe('string');
    expect(Array.isArray(env.issues)).toBe(true);
  });
});

describe('errors', () => {
  test('unknown command is a usage error', () => {
    expect(run(['frobnicate'], io).code).toBe(2);
  });

  test('missing file is a hard error', () => {
    expect(run(['validate', 'nope.md'], io).code).toBe(2);
  });

  test('unarchiving a missing task is a soft error', () => {
    const r = run(['unarchive', FILE, '--match', 'ghost'], io);
    expect(r.code).toBe(1);
  });
});
