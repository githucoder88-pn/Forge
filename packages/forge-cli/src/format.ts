/** Output formatting: plain tables + JSON mode. No colors by default. */

let useColor = process.stdout.isTTY === true;

export function setColor(enabled: boolean): void {
  useColor = enabled;
}

const C = {
  dim: (s: string): string => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string): string => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  red: (s: string): string => (useColor ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s: string): string => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string): string => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
};

export { C };

export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]): string => cells.map((c, i) => (c ?? '').padEnd(widths[i] as number)).join('  ').trimEnd();
  const out = [line(headers)];
  if (rows.length > 0) out.push(widths.map((w) => '-'.repeat(Math.min(w, 60))).join('  '));
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}

export function shortId(id: string): string {
  const parts = id.split('_');
  if (parts.length < 2) return id;
  return `${parts[0]}_${(parts[1] ?? '').slice(-6)}`;
}

export function stateColored(state: string): string {
  if (['completed', 'approved', 'available', 'active'].includes(state)) return C.green(state);
  if (['failed', 'blocked', 'offline', 'denied', 'expired'].includes(state)) return C.red(state);
  if (['running', 'executing', 'degraded', 'rate_limited', 'pending', 'waiting_for_tool'].includes(state)) return C.yellow(state);
  return state;
}

export function fmtTime(ts?: string): string {
  if (!ts) return '-';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleTimeString('en-GB', { hour12: false });
}

export function printJson(v: unknown): void {
  console.log(JSON.stringify(v, null, 2));
}
