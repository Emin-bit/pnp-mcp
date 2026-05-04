// Minimal POSIX-style shell argument splitter — used to parse a "command string"
// from a tool input into an argv array when needed. PnP is mostly cmdlet-style
// (single command per call), so this is less central than in power-platform-mcp.
export function parseShellArgs(input: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inToken = false;
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const c of input) {
    if (escaped) {
      cur += c;
      escaped = false;
      inToken = true;
      continue;
    }
    if (c === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (c === quote) {
        quote = null;
      } else {
        cur += c;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inToken = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (inToken) {
        out.push(cur);
        cur = "";
        inToken = false;
      }
      continue;
    }
    cur += c;
    inToken = true;
  }
  if (quote) throw new Error(`Unterminated ${quote === '"' ? "double" : "single"} quote in: ${input}`);
  if (inToken) out.push(cur);
  return out;
}
