import { mkdirSync, appendFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
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

export function log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  try {
    if (level === "debug" && !isVerbose()) return;
    ensureLogDir();
    const entry = {
      ts: new Date().toISOString(),
      level,
      msg: message,
      ...fields,
    };
    appendFileSync(todayFile(), JSON.stringify(entry) + "\n");
    if (isVerbose()) {
      process.stderr.write(`[pnp-mcp] ${entry.ts} ${level} ${message} ${fields ? JSON.stringify(fields) : ""}\n`);
    }
  } catch {
    // never throw from logger
  }
}

export function getLogDir(): string {
  return LOG_DIR;
}
