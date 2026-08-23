#!/usr/bin/env node
/**
 * `tsk` entry point: wires the pure dispatcher to the real filesystem and
 * process. All logic lives in run.ts / commands.ts so it stays testable.
 */

import { fileExists, readText, writeTextAtomic } from './io.js';
import { run } from './run.js';

const result = run(process.argv.slice(2), { readText, writeTextAtomic, fileExists });

if (result.stdout)
  process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n');
if (result.stderr)
  process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n');
process.exit(result.code);
