import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

const LOG_DIR = process.env.PNP_MCP_LOG_DIR ?? join(homedir(), ".pnp-mcp", "logs");

let dirEnsured = false;
function ensureLogDir() {
  if (dirEnsured) return;
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  dirEnsured = true;
}

function todayFile(): string {
  const date = new Date().toISOString().slice(0, 10);
  return join(LOG_DIR, `pnp-mcp-${date}.log`);
}

export type LogLevel = "info" | "warn" | "error" | "debug";

function isVerbose(): boolean {
  const v = (process.env.PNP_MCP_VERBOSE ?? "").toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

// Privacy redaction: replace any occurrence of the user's home directory and OS username
// in log payloads with placeholders so users can safely share their log file for debugging
// without leaking their machine identity. Computed once at module load — both `homedir()`
// and `userInfo().username` are stable for the process lifetime.
const HOME = homedir();
let USERNAME: string | undefined;
try { USERNAME = userInfo().username; } catch { USERNAME = undefined; }

// Compile the username regex ONCE at module load (Phase B review nit) instead of on every
// log call. For short usernames (< 3 chars) we skip redaction to avoid mangling unrelated
// text — common admin-y short names like "ed" or "ad" would otherwise produce false hits.
const USERNAME_RE: RegExp | null =
  USERNAME && USERNAME.length >= 3
    ? new RegExp(USERNAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi")
    : null;

function redactPersonal(value: unknown): unknown {
  if (typeof value === "string") {
    let out = value;
    if (HOME && out.includes(HOME)) {
      // Replace longest match first; covers paths like /Users/<name>/.pnp-mcp/logs.
      out = out.split(HOME).join("~");
    }
    if (USERNAME_RE) {
      out = out.replace(USERNAME_RE, "<user>");
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(redactPersonal);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = redactPersonal(v);
    return out;
  }
  return value;
}

export function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  try {
    if (level === "debug" && !isVerbose()) return;
    ensureLogDir();
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: redactPersonal(message),
      ...(fields ? (redactPersonal(fields) as Record<string, unknown>) : {}),
    };
    appendFileSync(todayFile(), JSON.stringify(entry) + "\n");
    if (isVerbose()) {
      process.stderr.write(`[pnp-mcp] ${entry.ts} ${level} ${entry.msg} ${fields ? JSON.stringify(redactPersonal(fields)) : ""}\n`);
    }
  } catch {
    // never throw from logger
  }
}

export function getLogDir(): string {
  return LOG_DIR;
}
