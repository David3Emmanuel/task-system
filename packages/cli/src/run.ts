/**
 * Dispatch layer: turn an argv array into a CommandResult. IO is injected so
 * tests drive the CLI with an in-memory filesystem and never spawn a process.
 */

import { parseArgs } from './args.js';
import {
  cmdAdd,
  cmdComplete,
  cmdEvent,
  cmdFormat,
  cmdInit,
  cmdList,
  cmdParse,
  cmdRm,
  cmdSet,
  cmdUnarchive,
  cmdValidate,
  opErrorResult,
  type CommandResult,
} from './commands.js';

/** Injectable IO surface. */
export interface Io {
  readText(path: string): string;
  writeTextAtomic(path: string, text: string): void;
  fileExists(path: string): boolean;
}

/** Commands that operate on a file argument (everything except `init`). */
const FILE_COMMANDS = new Set([
  'parse',
  'validate',
  'format',
  'list',
  'add',
  'set',
  'complete',
  'unarchive',
  'rm',
  'event',
]);

const USAGE = `tsk <command> [file] [options]

Commands:
  init                                 print an empty canonical document
  parse <file> [--json]                parse and re-emit (or dump the AST)
  validate <file> [--json]             report constraint issues (exit 1 on error)
  format <file> [--write|--check]      canonicalize (stdout, in place, or verify)
  list <file> [--open|--done] [--json] list tasks
  add <file> "<text>" [--start D --due D --created D --parent TEXT --event] [--json]
  set <file> (--line N|--id X|--match T) [--text T --start D --due D --created D] [--json]
  complete <file> (--line N|--id X|--match T) --done DATE [--seed N] [--json]
  unarchive <file> (--line N|--id X|--match T) [--json]
  rm <file> (--line N|--id X|--match T) [--recursive] [--json]
  event add <file> "<text>" --due DATE [--json]
  event rm <file> (--line N|--id X|--match T) [--json]
  serve <file> [--port N]              serve the web app backed by <file> (Ctrl+C to stop)

Dates are ISO YYYY-MM-DD. Locators: --line is 1-based as shown by \`list\`.`;

export function run(argv: string[], io: Io): CommandResult {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    return { stdout: USAGE, code: command ? 0 : 2 };
  }

  if (command === 'init') {
    return cmdInit();
  }

  if (!FILE_COMMANDS.has(command)) {
    return { stdout: '', stderr: `Unknown command: ${command}\n\n${USAGE}`, code: 2 };
  }

  // `event` takes its subcommand before the file; every other command takes the
  // file as the first positional.
  let filePath: string | undefined;
  let commandArgv: string[];
  if (command === 'event') {
    // event add <file> ... | event rm <file> ...
    const sub = rest[0];
    filePath = rest[1];
    commandArgv = [sub!, ...rest.slice(2)].filter((x): x is string => x !== undefined);
  } else {
    filePath = rest[0];
    commandArgv = rest.slice(1);
  }

  if (!filePath) return { stdout: '', stderr: `${command}: a file path is required.`, code: 2 };
  if (!io.fileExists(filePath)) {
    return { stdout: '', stderr: `${command}: file not found: ${filePath}`, code: 2 };
  }

  const args = parseArgs(commandArgv);
  const text = io.readText(filePath);

  let result: CommandResult;
  try {
    result = dispatch(command, text, args);
  } catch (err) {
    result = opErrorResult(err);
  }

  if (result.write != null) {
    io.writeTextAtomic(filePath, result.write);
  }
  return result;
}

function dispatch(
  command: string,
  text: string,
  args: ReturnType<typeof parseArgs>,
): CommandResult {
  switch (command) {
    case 'parse':
      return cmdParse(text, args);
    case 'validate':
      return cmdValidate(text, args);
    case 'format':
      return cmdFormat(text, args);
    case 'list':
      return cmdList(text, args);
    case 'add':
      return cmdAdd(text, args);
    case 'set':
      return cmdSet(text, args);
    case 'complete':
      return cmdComplete(text, args);
    case 'unarchive':
      return cmdUnarchive(text, args);
    case 'rm':
      return cmdRm(text, args);
    case 'event':
      return cmdEvent(text, args);
    default:
      return { stdout: '', stderr: `Unknown command: ${command}`, code: 2 };
  }
}
