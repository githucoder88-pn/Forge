/** Minimal dependency-free CLI argument parser. */

export interface ParsedArgs {
  command?: string;
  sub?: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

const SHORT: Record<string, string> = { h: 'help', v: 'version', p: 'port' };

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, string | boolean | string[]> = {};
  const positionals: string[] = [];
  let i = 0;
  const pushFlag = (key: string, value: string | boolean): void => {
    const prev = flags[key];
    if (prev === undefined) flags[key] = value;
    else if (Array.isArray(prev)) prev.push(String(value));
    else flags[key] = [String(prev), String(value)];
  };
  while (i < argv.length) {
    const tok = argv[i] as string;
    if (tok === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok.startsWith('--')) {
      const eq = tok.indexOf('=');
      if (eq >= 0) {
        pushFlag(tok.slice(2, eq), tok.slice(eq + 1));
      } else {
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('-')) {
          pushFlag(key, next);
          i++;
        } else {
          pushFlag(key, true);
        }
      }
    } else if (tok.startsWith('-') && tok.length > 1) {
      const letters = tok.slice(1);
      if (letters.length === 1 && SHORT[letters]) {
        const key = SHORT[letters] as string;
        const next = argv[i + 1];
        if (key === 'port' && next !== undefined && !next.startsWith('-')) {
          pushFlag(key, next);
          i++;
        } else {
          pushFlag(key, true);
        }
      } else {
        for (const ch of letters) pushFlag(SHORT[ch] ?? ch, true);
      }
    } else {
      positionals.push(tok);
    }
    i++;
  }
  const [command, sub, ...rest] = positionals;
  return { command, sub, positional: rest, flags };
}

export function flag(args: ParsedArgs, ...names: string[]): string | undefined {
  for (const n of names) {
    const v = args.flags[n];
    if (v === undefined) continue;
    if (Array.isArray(v)) return v[v.length - 1];
    if (typeof v === 'string') return v;
  }
  return undefined;
}

export function flagBool(args: ParsedArgs, ...names: string[]): boolean {
  for (const n of names) {
    const v = args.flags[n];
    if (v === true) return true;
    if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true';
  }
  return false;
}

export function flagList(args: ParsedArgs, ...names: string[]): string[] | undefined {
  const raw = flag(args, ...names);
  if (raw === undefined) return undefined;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export function requirePositional(args: ParsedArgs, index: number, what: string): string {
  const v = args.positional[index];
  if (!v) throw new CliError(`Missing ${what}. See 'forge ${args.command ?? ''} --help'.`);
  return v;
}

export class CliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliError';
  }
}
