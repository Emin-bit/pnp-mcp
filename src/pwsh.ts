// pwsh REPL session manager.
//
// Why long-lived: PnP PowerShell auth (Connect-PnPOnline) lives in the current pwsh
// session's memory. Spawning a fresh pwsh per command would lose auth on every call,
// PLUS pay the ~2-5s cold start every time (pwsh launch + Import-Module PnP.PowerShell).
// So we keep ONE pwsh process alive and pipe commands through stdin/stdout.
//
// Protocol: each command is base64-encoded, then wrapped in a try/catch with two markers
// — END marker always fires (in `finally`), ERR marker fires only on exception. We match
// END markers in stdout to know the command completed.
//
// Why base64: pwsh `-Command -` (read from stdin) executes one statement per line. A user
// command that spans multiple lines would have its first newline interpreted as end-of-
// statement, breaking the wrapping. Base64 encoding flattens any command (including
// multi-line, special chars, quotes) into a single ASCII line that we decode and execute
// via `Invoke-Expression`. Also avoids quote-escaping fragility entirely.
//
// Cross-platform discovery: macOS via brew (intel and Apple Silicon), Windows via winget
// (per-user and per-machine install paths), Linux via Microsoft repo. PNP_PWSH_PATH env
// var overrides discovery. As a final fallback we trust PATH (i.e. just spawn "pwsh").

import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { log } from "./logger.js";

export interface PwshResult {
  /** Output captured between the previous and current END markers, with markers/error wrapping stripped. */
  stdout: string;
  /** Stderr captured during this command's execution window. */
  stderr: string;
  /**
   * Exit code semantics for a REPL session command:
   *  0 = command executed without throwing a terminating PS exception
   *  1 = a terminating exception was caught (ERR marker fired) — `errorMessage` populated
   *  -1 = timed out (we sent SIGTERM to the session; it will be respawned next call)
   *  -2 = session was not running and could not be started
   */
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  errorMessage?: string;
}

// Secret param matchers. Value can be unquoted token, single-quoted, or double-quoted.
// Previous version used `\S+` which broke on quoted values containing whitespace
// (only the first chunk got redacted).
const SECRET_PARAM_NAMES = ["ClientSecret", "CertificatePassword", "Password", "AccessToken"];
const SECRET_PARAM_PATTERNS = SECRET_PARAM_NAMES.map(
  name => new RegExp(`(-${name})\\s+(?:"[^"]*"|'[^']*'|\\S+)`, "gi"),
);

// ANSI escape sequence matcher. Uses explicit Unicode escape `` so the source file
// has NO invisible ESC bytes (which trip up text-based diff/edit tooling). Matches:
//   - CSI: ESC [ <params> <intermediates> <final>
//   - OSC: ESC ] ... BEL or ESC \  (string terminator)
//   - Two-char ESC sequences: ESC <single byte 0x40-0x5F or some others>
// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE_RE = /(?:\[[0-9;?]*[ -/]*[@-~]|\][^]*(?:|\\)?|[@-Z\\-_])/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, "");
}

/** Mask known secret-bearing parameters in a command line for logging. */
export function maskCommand(command: string): string {
  let out = command;
  for (const re of SECRET_PARAM_PATTERNS) {
    out = out.replace(re, "$1 ***REDACTED***");
  }
  return out;
}

/**
 * Mask both well-known secret-bearing parameters AND any explicit secret values supplied
 * by the caller. Use this when logging a command to ensure no secret literals end up in
 * the log file even if the regex above missed them (e.g., when the secret is interpolated
 * inside a `ConvertTo-SecureString` expression — the regex sees `(ConvertTo...` as the
 * value token and only redacts the parenthesis, leaving the actual literal exposed).
 *
 * Pass the same list you give to `runAsTool({ redact: [...] })`.
 */
export function maskCommandWithSecrets(command: string, secrets?: string[]): string {
  let out = maskCommand(command);
  if (secrets && secrets.length) {
    for (const s of secrets) {
      // Drop the length-floor entirely: a user explicitly told us this exact value is a secret;
      // mask it in full no matter how short. Empty string still skipped (would replace everything).
      if (s) out = out.split(s).join("***REDACTED***");
    }
  }
  return out;
}

function getPlatformPwshPaths(): string[] {
  const home = homedir();
  if (platform() === "win32") {
    const programFiles = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const programFiles86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    return [
      // Per-machine winget / MSI installer
      join(programFiles, "PowerShell", "7", "pwsh.exe"),
      join(programFiles, "PowerShell", "7-preview", "pwsh.exe"),
      join(programFiles86, "PowerShell", "7", "pwsh.exe"),
      // Per-user winget install (current default for `winget install --id Microsoft.Powershell`)
      join(localAppData, "Microsoft", "PowerShell", "7", "pwsh.exe"),
      // Scoop
      join(home, "scoop", "apps", "powershell", "current", "pwsh.exe"),
      // Chocolatey
      join(programFiles, "PowerShell", "pwsh.exe"),
    ];
  }
  return [
    "/usr/local/bin/pwsh",          // Intel macOS Homebrew
    "/opt/homebrew/bin/pwsh",       // Apple Silicon Homebrew
    "/usr/bin/pwsh",                // Linux (Microsoft repo install)
    "/snap/bin/pwsh",               // Linux snap
    join(home, ".dotnet", "tools", "pwsh"),
  ];
}

/**
 * Build a PATH containing the directories that hold pwsh on this OS, so that subprocess
 * spawns find pwsh even when the parent environment (e.g. Claude Desktop) has a minimal PATH.
 */
export function getEffectivePath(): string {
  const sep = platform() === "win32" ? ";" : ":";
  const existing = (process.env.PATH ?? "").split(sep).filter(Boolean);
  const additions = getPlatformPwshPaths()
    .map(p => {
      const sepChar = platform() === "win32" ? "\\" : "/";
      const idx = p.lastIndexOf(sepChar);
      return idx >= 0 ? p.slice(0, idx) : p;
    })
    .filter(p => p && !existing.includes(p));
  return [...additions, ...existing].join(sep);
}

export function resolvePwsh(): string {
  const override = process.env.PNP_PWSH_PATH;
  if (override && existsSync(override)) return override;
  for (const candidate of getPlatformPwshPaths()) {
    if (existsSync(candidate)) return candidate;
  }
  return "pwsh"; // fall through to PATH lookup (or pwsh.exe via Node's auto-resolution on Windows)
}

interface QueuedCall {
  command: string;
  timeoutMs: number;
  resolve: (r: PwshResult) => void;
  reject: (err: Error) => void;
}

export class PwshSession {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private queue: QueuedCall[] = [];
  private busy = false;
  private currentMarkerEnd: string | null = null;
  private currentMarkerErr: string | null = null;
  private currentResolve: ((r: PwshResult) => void) | null = null;
  private currentStartTime = 0;
  private currentTimeoutMs = 0;
  private currentTimer: NodeJS.Timeout | null = null;
  private stdoutSinceMarker = "";
  private stderrSinceMarker = "";
  private sessionDeadCallback?: () => void;

  constructor(private readonly options: { onSessionDeath?: () => void } = {}) {
    this.sessionDeadCallback = options.onSessionDeath;
  }

  /** Start (or restart) the underlying pwsh process. Idempotent. */
  async start(): Promise<void> {
    if (this.child && !this.child.killed) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const bin = resolvePwsh();
      log("info", "pwsh session: spawning", { bin });
      const child = spawn(bin, [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command", "-",
      ], {
        env: {
          ...process.env,
          PATH: getEffectivePath(),
          POWERSHELL_TELEMETRY_OPTOUT: "1",
          // Force UTF-8 output. Important for non-ASCII data (Bosnian chars in tenant names, etc.).
          NO_COLOR: "1", // hint to PSReadLine and other helpers — though not always honored
        },
        shell: false,
      });
      this.child = child;

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => this.onStdout(chunk));
      child.stderr.on("data", chunk => this.onStderr(chunk));
      child.on("close", (code, signal) => this.onClose(code, signal));
      child.on("error", err => {
        log("error", "pwsh session: spawn error", { error: err.message });
        this.failPending(new Error(`pwsh spawn error: ${err.message}`));
      });

      // Pre-warm: import the PnP module so first auth call doesn't pay the cost.
      //
      // Version-aware load (A1 fix): on Windows, `Import-Module PnP.PowerShell` by name can
      // pick up a legacy 2.x install from the user-scope WindowsPowerShell modules dir even
      // when 3.x is installed in the system-wide pwsh 7 dir, because PSModulePath order puts
      // user-scope first. This server requires PnP 3.x, so we explicitly find the highest
      // version with Major >= 3 and import it BY PATH. If only 2.x is present we fail with a
      // structured error that names the offending versions and their on-disk locations,
      // instead of the generic "module not installed" the prior code emitted.
      const warmupCmd = [
        "$ErrorActionPreference='Stop';",
        "$all = Get-Module -ListAvailable PnP.PowerShell | Sort-Object Version -Descending;",
        "if (-not $all) {",
        "  Write-Output 'WARMUP_NOT_INSTALLED';",
        "  return",
        "}",
        "$best = $all | Where-Object { $_.Version.Major -ge 3 } | Select-Object -First 1;",
        "if (-not $best) {",
        "  $vs = ($all | ForEach-Object { '{0} @ {1}' -f $_.Version, $_.ModuleBase }) -join '; ';",
        "  Write-Output ('WARMUP_NEEDS_3X|' + $vs);",
        "  return",
        "}",
        "Import-Module $best.Path -ErrorAction Stop;",
        "Write-Output ('WARMUP_OK|' + $best.Version + '|' + $best.ModuleBase);",
      ].join(" ");
      let warmup: PwshResult | null = null;
      try {
        warmup = await this.execInternal(warmupCmd, 30_000);
        const out = warmup.stdout;
        if (out.includes("WARMUP_OK")) {
          // Parse the marker line for log output.
          const line = out.split("\n").find(l => l.includes("WARMUP_OK")) ?? "";
          const [, version, base] = line.split("|");
          log("info", "pwsh session: ready", {
            pnpVersion: (version ?? "").trim(),
            pnpModuleBase: (base ?? "").trim(),
          });
        } else if (out.includes("WARMUP_NOT_INSTALLED")) {
          throw new Error(
            "PnP.PowerShell module is not installed in any PSModulePath. " +
            "Install with: pwsh -Command \"Install-PSResource -Name PnP.PowerShell -Scope CurrentUser\" " +
            "(or, on older pwsh: \"Install-Module -Name PnP.PowerShell -Force -AllowClobber -Scope CurrentUser\")",
          );
        } else if (out.includes("WARMUP_NEEDS_3X")) {
          const detail = out.split("WARMUP_NEEDS_3X|")[1]?.split("\n")[0]?.trim() ?? "(none)";
          throw new Error(
            "PnP.PowerShell 3.x is required but only older versions are installed. " +
            `Found: ${detail}. ` +
            "Install 3.x with: pwsh -Command \"Install-PSResource -Name PnP.PowerShell -Scope CurrentUser\"",
          );
        } else {
          // A2 fix: include the actual stdout AND stderr in the error so the user can see what
          // pwsh said, instead of the previous opaque "unexpected output: ." line. Also include
          // exit code and errorMessage if present.
          const stdoutHint = (out || "(empty)").slice(0, 400);
          const stderrHint = (warmup.stderr || "(empty)").slice(0, 400);
          throw new Error(
            "pwsh warmup did not produce expected marker. " +
            `Exit code: ${warmup.exitCode}. ` +
            (warmup.errorMessage ? `Error: ${warmup.errorMessage}. ` : "") +
            `STDOUT: ${stdoutHint}. STDERR: ${stderrHint}`,
          );
        }
      } catch (err) {
        // CRITICAL: tear down the half-initialized child so the next start() actually retries
        // instead of silently reusing a doomed process.
        try { this.child?.kill("SIGTERM"); } catch { /* noop */ }
        this.child = null;
        // A2 + A4: log the FULL warmup result to disk so users can inspect it post-mortem.
        log("error", "pwsh session: warmup failed", {
          message: (err as Error).message,
          warmupStdout: (warmup?.stdout ?? "").slice(0, 1000),
          warmupStderr: (warmup?.stderr ?? "").slice(0, 1000),
          warmupExitCode: warmup?.exitCode ?? null,
          warmupErrorMessage: warmup?.errorMessage ?? null,
        });
        throw new Error(`pwsh started but PnP.PowerShell warmup failed: ${(err as Error).message}`);
      }
    })();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  /** Public API: queue and execute a PnP command. Concurrent calls are serialized. */
  async exec(command: string, timeoutMs = 120_000): Promise<PwshResult> {
    if (!this.child || this.child.killed) {
      try {
        await this.start();
      } catch (err) {
        return {
          stdout: "",
          stderr: (err as Error).message,
          exitCode: -2,
          durationMs: 0,
          timedOut: false,
          errorMessage: (err as Error).message,
        };
      }
    }
    return new Promise<PwshResult>((resolve, reject) => {
      this.queue.push({ command, timeoutMs, resolve, reject });
      this.pump();
    });
  }

  /** Internal exec used during start() before public queue is exposed. */
  private execInternal(command: string, timeoutMs: number): Promise<PwshResult> {
    return new Promise<PwshResult>((resolve, reject) => {
      this.runOne({ command, timeoutMs, resolve, reject });
    });
  }

  private pump() {
    if (this.busy) return;
    const next = this.queue.shift();
    if (!next) return;
    this.runOne(next);
  }

  private runOne(call: QueuedCall) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      call.reject(new Error("pwsh session has no stdin (child not running)"));
      return;
    }
    this.busy = true;
    const id = randomBytes(6).toString("hex");
    const endMarker = `__PNP_END_${id}__`;
    const errMarker = `__PNP_ERR_${id}__`;
    this.currentMarkerEnd = endMarker;
    this.currentMarkerErr = errMarker;
    this.currentResolve = call.resolve;
    this.currentStartTime = Date.now();
    this.currentTimeoutMs = call.timeoutMs;
    this.stdoutSinceMarker = "";
    this.stderrSinceMarker = "";

    // Base64-encode the user command so multi-line commands and any quoting work.
    // We then build a SINGLE-LINE wrapper that:
    //   1) decodes the user command from base64
    //   2) runs it via Invoke-Expression inside a try/catch
    //   3) prints END marker in finally (always) and ERR marker on exception
    const b64 = Buffer.from(call.command, "utf8").toString("base64");
    const wrapped =
      `try { ` +
        `$_pnp_cmd = [System.Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')); ` +
        `Invoke-Expression -Command $_pnp_cmd ` +
      `} catch { ` +
        `Write-Output '${errMarker}'; ` +
        `$_.Exception | Format-List -Force | Out-String | Write-Output ` +
      `} finally { Write-Output '${endMarker}' }\n`;

    this.currentTimer = setTimeout(() => this.onTimeout(), call.timeoutMs);

    try {
      this.child!.stdin!.write(wrapped, "utf8");
    } catch (err) {
      this.finishCurrent({
        stdout: "",
        stderr: (err as Error).message,
        exitCode: -2,
        durationMs: 0,
        timedOut: false,
        errorMessage: (err as Error).message,
      });
    }
  }

  private onStdout(chunk: string) {
    if (!this.currentMarkerEnd) return;
    const cleaned = stripAnsi(chunk);
    this.stdoutSinceMarker += cleaned;
    const idx = this.stdoutSinceMarker.indexOf(this.currentMarkerEnd);
    if (idx === -1) return;
    const captured = this.stdoutSinceMarker.slice(0, idx);
    const remainder = this.stdoutSinceMarker.slice(idx + this.currentMarkerEnd.length);
    this.stdoutSinceMarker = remainder;

    let stdout = captured;
    let errorMessage: string | undefined;
    let exitCode = 0;

    if (this.currentMarkerErr && captured.includes(this.currentMarkerErr)) {
      const errIdx = captured.indexOf(this.currentMarkerErr);
      const before = captured.slice(0, errIdx);
      const errText = captured.slice(errIdx + this.currentMarkerErr.length).trim();
      stdout = before;
      errorMessage = errText.split("\n").map(l => l.trim()).filter(Boolean).join(" | ").slice(0, 500);
      exitCode = 1;
    }

    this.finishCurrent({
      stdout: stdout.replace(/^\s+|\s+$/g, ""),
      stderr: this.stderrSinceMarker.replace(/^\s+|\s+$/g, ""),
      exitCode,
      durationMs: Date.now() - this.currentStartTime,
      timedOut: false,
      errorMessage,
    });
  }

  private onStderr(chunk: string) {
    // Strip ANSI from stderr too — pwsh emits red-text error formatting that pollutes our output.
    if (this.currentMarkerEnd) this.stderrSinceMarker += stripAnsi(chunk);
  }

  private onTimeout() {
    if (!this.currentResolve) return;
    log("warn", "pwsh exec: timeout, killing session", { timeoutMs: this.currentTimeoutMs });
    // Kill the entire pwsh process — there's no reliable way to interrupt one command in pwsh
    // -Command - mode. Session will be respawned on next exec.
    try { this.child?.kill("SIGTERM"); } catch { /* noop */ }
    this.finishCurrent({
      stdout: this.stdoutSinceMarker.replace(/^\s+|\s+$/g, ""),
      stderr: this.stderrSinceMarker.replace(/^\s+|\s+$/g, ""),
      exitCode: -1,
      durationMs: Date.now() - this.currentStartTime,
      timedOut: true,
      errorMessage: `command exceeded ${this.currentTimeoutMs}ms timeout`,
    });
  }

  private finishCurrent(result: PwshResult) {
    if (this.currentTimer) {
      clearTimeout(this.currentTimer);
      this.currentTimer = null;
    }
    const resolve = this.currentResolve;
    this.currentMarkerEnd = null;
    this.currentMarkerErr = null;
    this.currentResolve = null;
    this.busy = false;
    if (resolve) resolve(result);
    setImmediate(() => this.pump());
  }

  private failPending(err: Error) {
    const resolve = this.currentResolve;
    this.currentMarkerEnd = null;
    this.currentMarkerErr = null;
    this.currentResolve = null;
    if (this.currentTimer) {
      clearTimeout(this.currentTimer);
      this.currentTimer = null;
    }
    this.busy = false;
    // Resolve the in-flight call with a session-died error result rather than rejecting,
    // so callers using `runAsTool` see a normal isError result instead of an unhandled
    // rejection.
    if (resolve) {
      resolve({
        stdout: "",
        stderr: err.message,
        exitCode: -2,
        durationMs: 0,
        timedOut: false,
        errorMessage: err.message,
      });
    }
    while (this.queue.length) {
      const next = this.queue.shift()!;
      next.reject(err);
    }
  }

  private onClose(code: number | null, signal: NodeJS.Signals | null) {
    log("warn", "pwsh session closed", { code, signal });
    this.child = null;
    if (this.currentResolve || this.queue.length) {
      this.failPending(new Error(`pwsh session terminated (code=${code} signal=${signal})`));
    }
    if (this.sessionDeadCallback) this.sessionDeadCallback();
  }

  /** Cleanly stop the session. Best-effort Disconnect-PnPOnline before kill. */
  async stop(): Promise<void> {
    if (!this.child || this.child.killed) return;
    try {
      await this.exec(
        "try { Disconnect-PnPOnline -ErrorAction SilentlyContinue } catch {}",
        5_000,
      );
    } catch { /* noop */ }
    try { this.child.stdin?.end(); } catch { /* noop */ }
    try { this.child.kill("SIGTERM"); } catch { /* noop */ }
    this.child = null;
  }
}

// ----- Module-level singleton (one session per MCP server lifetime) -----

let _session: PwshSession | null = null;

export function getSession(): PwshSession {
  if (!_session) {
    _session = new PwshSession();
  }
  return _session;
}

export async function runPnp(command: string, opts?: { timeoutMs?: number }): Promise<PwshResult> {
  const session = getSession();
  return session.exec(command, opts?.timeoutMs ?? 120_000);
}

export async function stopSession(): Promise<void> {
  if (_session) {
    await _session.stop();
    _session = null;
  }
}
