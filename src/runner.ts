// Runner: thin wrapper around runPnp that returns standard MCP CallToolResult.
// Mirrors the runAsTool pattern from power-platform-mcp but uses the REPL session.

import { runPnp, maskCommandWithSecrets, type PwshResult } from "./pwsh.js";
import { log } from "./logger.js";

export interface ToolContent {
  type: "text";
  text: string;
  [x: string]: unknown;
}

export interface ToolResult {
  isError?: boolean;
  content: ToolContent[];
  [x: string]: unknown;
}

export interface RunAsToolOptions {
  toolName: string;
  /**
   * The PowerShell command to execute. Can be any valid pwsh expression including
   * cmdlets, pipelines, multiple statements separated by `;`. Will be wrapped in
   * try/catch by the session manager.
   */
  command: string;
  timeoutMs?: number;
  /** Optional follow-up text appended on success (e.g. "Run pnp_publish_all next"). */
  hint?: string;
  /** Secrets to redact from the textual output (in addition to masking in logs). */
  redact?: string[];
}

function maskInText(text: string, secrets?: string[]): string {
  if (!secrets || secrets.length === 0) return text;
  let out = text;
  for (const s of secrets) {
    // Drop the previous `length >= 4` floor: a caller listed this value as a secret,
    // we should redact it regardless of length. Skip only the empty string (which would
    // turn the entire text into `***REDACTED***`).
    if (s) out = out.split(s).join("***REDACTED***");
  }
  return out;
}

function formatResult(toolName: string, command: string, r: PwshResult, redact?: string[]): string {
  const masked = maskCommandWithSecrets(command, redact);
  const header =
    `$ pwsh ${toolName}\n` +
    `> ${masked}\n` +
    `exit=${r.exitCode} duration=${r.durationMs}ms${r.timedOut ? " [TIMED OUT]" : ""}`;
  const parts = [header];
  if (r.stdout) parts.push(r.stdout.trimEnd());
  if (r.stderr && r.stderr !== r.stdout) parts.push(`--- stderr ---\n${r.stderr.trimEnd()}`);
  if (r.errorMessage) parts.push(`--- error ---\n${r.errorMessage}`);
  if (!r.stdout && !r.stderr && !r.errorMessage) parts.push("(no output)");
  return parts.join("\n\n");
}

export async function runAsTool(opts: RunAsToolOptions): Promise<ToolResult> {
  const { toolName, command, timeoutMs, hint, redact } = opts;
  // Use the secrets-aware mask so that callers passing `redact: [secret]` get reliable
  // log redaction even when the secret is interpolated inside a complex PS expression
  // that the parameter-pattern regex can't match (e.g., (ConvertTo-SecureString …)).
  log("info", toolName, { cmd: maskCommandWithSecrets(command, redact) });

  try {
    const r = await runPnp(command, { timeoutMs });
    log("info", `${toolName} done`, {
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      timedOut: r.timedOut,
    });

    const body = formatResult(toolName, command, r, redact);
    const withHint = hint && r.exitCode === 0 ? `${body}\n\n--- hint ---\n${hint}` : body;
    return {
      isError: r.exitCode !== 0,
      content: [{ type: "text", text: maskInText(withHint, redact) }],
    };
  } catch (err) {
    const msg = (err as Error).message;
    log("error", `${toolName} failed`, { error: msg });
    return {
      isError: true,
      content: [{ type: "text", text: msg }],
    };
  }
}
