#!/usr/bin/env node
/**
 * `tsk` entry point: wires the pure dispatcher to the real filesystem and
 * process. All logic lives in run.ts / commands.ts so it stays testable.
 *
 * `tsk serve <file>` is handled here (not in the one-shot dispatcher) because
 * it starts a long-running HTTP server instead of returning a CommandResult.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileExists, readText, writeTextAtomic } from './io.js';
import { run } from './run.js';
import { parseArgs, optString, optFlag } from './args.js';
import { startServe, resolveWebRoot, ensureWebBuilt, prepareServeFile } from './serve.js';

const SERVE_USAGE = `tsk serve <file> [--port N] [--format]
  Serve the Task-System web app backed by <file>.
  Creates an empty document if <file> does not exist.
  --format  canonicalize <file> (sort into sections) before serving.
  Default port: 4173. Binds to 127.0.0.1 only.`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === 'serve') {
    const file = argv[1];
    if (!file) {
      process.stderr.write(`serve: a file path is required.\n\n${SERVE_USAGE}\n`);
      process.exit(2);
    }
    const parsed = parseArgs(argv.slice(2));
    const portRaw = optString(parsed, 'port');
    const formatFlag = optFlag(parsed, 'format');
    const port = portRaw !== undefined ? Number(portRaw) : 4173;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      process.stderr.write(`serve: invalid port: ${portRaw}\n`);
      process.exit(2);
    }
    if (existsSync(file) && statSync(file).isDirectory()) {
      process.stderr.write(`serve: not a file: ${file}\n`);
      process.exit(2);
    }
    const webRoot = resolveWebRoot();
    try {
      await ensureWebBuilt(webRoot);
    } catch (err) {
      process.stderr.write(`serve: ${(err as Error).message}\n`);
      process.exit(2);
    }
    const abs = resolve(file);
    const prep = prepareServeFile(abs, formatFlag);
    if (prep === 'created') console.log(`Created empty document: ${abs}`);
    else if (prep === 'formatted') console.log(`Formatted ${abs} to canonical order.`);
    else if (formatFlag) console.log(`${abs} is already canonical.`);
    try {
      const started = await startServe({ filePath: abs, webRoot, port });
      console.log(`Task-System running at ${started.url}`);
      console.log(`Linked to: ${abs}`);
      console.log('Press Ctrl+C to stop.');
      process.on('SIGINT', () => started.server.close(() => process.exit(0)));
      return; // the listening server keeps the process alive
    } catch (err) {
      process.stderr.write(`serve: ${(err as Error).message}\n`);
      process.exit(1);
    }
  }

  const result = run(argv, { readText, writeTextAtomic, fileExists });

  if (result.stdout)
    process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n');
  if (result.stderr)
    process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n');
  process.exit(result.code);
}

void main();
