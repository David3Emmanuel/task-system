/**
 * Minimal argv parser: positional args plus `--flag` / `--key value` options.
 * No dependency, no cleverness — just enough for the `tsk` surface.
 *
 * `--key value` and `--key=value` both set a string option. A `--flag` with no
 * following value (or followed by another `--option`) is a boolean true.
 */

export interface ParsedArgs {
  positionals: string[];
  options: Record<string, string | true>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const options: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const body = arg.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        options[body.slice(0, eq)] = body.slice(eq + 1);
        continue;
      }
      const nextArg = argv[i + 1];
      if (nextArg !== undefined && !nextArg.startsWith('--')) {
        options[body] = nextArg;
        i++;
      } else {
        options[body] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, options };
}

/** Read an option as a string, or undefined when absent/boolean. */
export function optString(args: ParsedArgs, key: string): string | undefined {
  const v = args.options[key];
  return typeof v === 'string' ? v : undefined;
}

/** Read an option as a boolean flag. */
export function optFlag(args: ParsedArgs, key: string): boolean {
  return args.options[key] === true || args.options[key] === 'true';
}
