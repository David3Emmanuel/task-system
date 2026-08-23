/**
 * File IO for the CLI: UTF-8 read and atomic write.
 *
 * Atomic write = write to a temp file in the same directory, then rename over
 * the target. Rename is atomic on the same filesystem, so a reader never sees a
 * half-written file and a crash mid-write leaves the original intact.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

export function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}

/** Write `text` to `path` atomically, preserving LF and UTF-8. */
export function writeTextAtomic(path: string, text: string): void {
  const dir = dirname(path);
  // A fixed suffix keeps the temp name predictable; the same-dir placement keeps
  // the rename on one filesystem.
  const tmp = join(dir, `.${basename(path)}.tsk.tmp`);
  writeFileSync(tmp, text, 'utf8');
  renameSync(tmp, path);
}
