// Setup logic — used by `npx @emin-bit/pnp-mcp setup` CLI mode and by the
// preflight / setup_install_pnp_module MCP tools (added in Phase 1).
//
// Phase 1 (mandatory, NOT auto-installable):  Node.js + pwsh 7+
// Phase 2 (auto-installable):                  PnP.PowerShell PowerShell module

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { resolvePwsh, getEffectivePath } from "./pwsh.js";

export const PNP_PS_MODULE = "PnP.PowerShell";
export const MIN_PWSH_MAJOR = 7;

export type ProbeStatus = "ok" | "missing" | "error";

export interface Probe {
  name: string;
  status: ProbeStatus;
  version?: string;
  detail?: string;
  fix?: string;
}

interface RunRes {
  stdout: string;
  stderr: string;
  exitCode: number;
  errorCode?: string;
}

function runOnce(cmd: string, args: string[], timeoutMs = 30_000): Promise<RunRes> {
  return new Promise(resolve => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, {
        env: { ...process.env, PATH: getEffectivePath() },
        shell: false,
      });
    } catch (err) {
      resolve({
        stdout: "",
        stderr: (err as Error).message,
        exitCode: -1,
        errorCode: (err as NodeJS.ErrnoException).code,
      });
      return;
    }
    const t = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);
    child.stdout?.on("data", d => { stdout += d.toString(); });
    child.stderr?.on("data", d => { stderr += d.toString(); });
    child.on("error", err => {
      clearTimeout(t);
      resolve({
        stdout, stderr,
        exitCode: -1,
        errorCode: (err as NodeJS.ErrnoException).code,
      });
    });
    child.on("close", code => {
      clearTimeout(t);
      void timedOut;
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

// ---------- Probes ----------

export async function probeNode(): Promise<Probe> {
  const major = parseInt(process.versions.node.split(".")[0], 10);
  return {
    name: "node",
    status: "ok",
    version: process.versions.node,
    detail: major < 18 ? "WARNING: Node 18+ recommended" : undefined,
  };
}

export async function probePwsh(): Promise<Probe> {
  const bin = resolvePwsh();
  const r = await runOnce(bin, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], 15_000);
  if (r.errorCode === "ENOENT") {
    return {
      name: "pwsh",
      status: "missing",
      detail: "PowerShell 7+ not found on PATH",
      fix: pwshInstallHint(),
    };
  }
  if (r.exitCode !== 0) {
    return {
      name: "pwsh",
      status: "error",
      detail: r.stderr.trim() || `exit ${r.exitCode}`,
      fix: pwshInstallHint(),
    };
  }
  const versionStr = r.stdout.trim();
  const major = parseInt(versionStr.split(".")[0], 10);
  if (Number.isFinite(major) && major < MIN_PWSH_MAJOR) {
    return {
      name: "pwsh",
      status: "error",
      version: versionStr,
      detail: `pwsh ${versionStr} is too old. PnP.PowerShell requires PowerShell ${MIN_PWSH_MAJOR}+. Windows PowerShell 5.1 is NOT supported.`,
      fix: pwshInstallHint(),
    };
  }
  return { name: "pwsh", status: "ok", version: versionStr };
}

function pwshInstallHint(): string {
  if (process.platform === "darwin") {
    return "Install PowerShell 7+: brew install --cask powershell  (or download from https://github.com/PowerShell/PowerShell/releases)";
  }
  if (process.platform === "win32") {
    return "Install PowerShell 7+: winget install --id Microsoft.Powershell  (or https://aka.ms/PSWindows)";
  }
  return "Install PowerShell 7+: https://learn.microsoft.com/en-us/powershell/scripting/install/installing-powershell-on-linux";
}

export async function probePnpModule(): Promise<Probe> {
  // Match the runtime warmup logic in pwsh.ts: this server requires 3.x. Report any
  // 2.x-only install as `error`, not `ok`, so preflight stays consistent with the
  // version-aware Import-Module the warmup actually executes. Otherwise users see a
  // green preflight then a confusing WARMUP_NEEDS_3X failure when the server starts.
  const bin = resolvePwsh();
  const r = await runOnce(
    bin,
    [
      "-NoProfile",
      "-Command",
      // Emit `BEST3:<version>|<base>`, `LEGACY:<v1>;<v2>;...`, or `NONE`.
      "$all = Get-Module -ListAvailable PnP.PowerShell | Sort-Object Version -Descending; " +
      "if (-not $all) { 'NONE' } " +
      "else { " +
      "  $best3 = $all | Where-Object { $_.Version.Major -ge 3 } | Select-Object -First 1; " +
      "  if ($best3) { 'BEST3:' + $best3.Version.ToString() + '|' + $best3.ModuleBase } " +
      "  else { 'LEGACY:' + (($all | ForEach-Object { $_.Version.ToString() }) -join ';') } " +
      "}",
    ],
    30_000,
  );
  if (r.errorCode === "ENOENT") return { name: "PnP.PowerShell module", status: "missing", detail: "pwsh not installed" };
  if (r.exitCode !== 0) {
    return { name: "PnP.PowerShell module", status: "error", detail: r.stderr.trim() || `exit ${r.exitCode}` };
  }
  const out = r.stdout.trim();
  if (out === "NONE" || !out) {
    return {
      name: "PnP.PowerShell module",
      status: "missing",
      detail: "module not installed",
      fix: `Install-PSResource -Name ${PNP_PS_MODULE} -Scope CurrentUser  (or older pwsh: Install-Module -Name ${PNP_PS_MODULE} -Force -AllowClobber -Scope CurrentUser)`,
    };
  }
  if (out.startsWith("LEGACY:")) {
    const versions = out.slice("LEGACY:".length);
    return {
      name: "PnP.PowerShell module",
      status: "error",
      version: versions,
      detail: `Only legacy 2.x installed (${versions}). PnP MCP requires 3.x. The server will fail to start until 3.x is installed alongside or replaces 2.x.`,
      fix: `Install-PSResource -Name ${PNP_PS_MODULE} -Scope CurrentUser  (PSResourceGet 1.x — modern, fast). On older pwsh: Install-Module -Name ${PNP_PS_MODULE} -Force -AllowClobber -Scope CurrentUser`,
    };
  }
  if (out.startsWith("BEST3:")) {
    const rest = out.slice("BEST3:".length);
    const [version, base] = rest.split("|");
    return {
      name: "PnP.PowerShell module",
      status: "ok",
      version,
      // Surface the on-disk path so users on Windows with both 2.x and 3.x installed know
      // which install is being picked. Resolves UX gap from the 1.0.0 Windows test report.
      detail: base ? `loaded from ${base.trim()}` : undefined,
    };
  }
  // Unknown output (very old pwsh / quoting glitch) — best-effort: treat as the version
  // string itself and assume 3.x. Should never happen in practice with the new script.
  return { name: "PnP.PowerShell module", status: "ok", version: out };
}

export async function probePnpAuth(): Promise<Probe> {
  // Check whether there's an active connection in a fresh pwsh process.
  // Note: this tells us about CACHED tokens — if user authenticated via interactive,
  // PnP's MSAL cache may allow silent reconnection. If never authenticated, this is missing.
  const bin = resolvePwsh();
  const r = await runOnce(
    bin,
    [
      "-NoProfile",
      "-Command",
      "Import-Module PnP.PowerShell -ErrorAction Stop; try { $c = Get-PnPConnection -ErrorAction SilentlyContinue; if ($c) { 'OK:' + $c.Url } else { 'NONE' } } catch { 'NONE' }",
    ],
    30_000,
  );
  if (r.errorCode === "ENOENT") return { name: "PnP auth", status: "missing", detail: "pwsh not installed" };
  if (r.exitCode !== 0) return { name: "PnP auth", status: "missing", detail: "no active PnP connection in fresh shell" };
  const out = r.stdout.trim();
  if (out.startsWith("OK:")) {
    return { name: "PnP auth", status: "ok", detail: `connected to ${out.slice(3)}` };
  }
  return {
    name: "PnP auth",
    status: "missing",
    detail: "no active PnP connection (use pnp_auth_connect_* tools to authenticate)",
    fix: 'Connect-PnPOnline -Url https://yourtenant.sharepoint.com -Interactive  (or use pnp_auth_connect_* MCP tools)',
  };
}

export interface PreflightReport {
  probes: Probe[];
  allOk: boolean;
  summary: string;
}

export async function runPreflight(): Promise<PreflightReport> {
  const probes = await Promise.all([probeNode(), probePwsh(), probePnpModule(), probePnpAuth()]);
  const allOk = probes.every(p => p.status === "ok");
  const summary = probes
    .map(p => {
      const icon = p.status === "ok" ? "✅" : p.status === "missing" ? "❌" : "⚠️";
      const ver = p.version ? ` v${p.version}` : "";
      const det = p.detail ? ` — ${p.detail}` : "";
      const fix = p.fix ? `\n      fix: ${p.fix}` : "";
      return `${icon} ${p.name}${ver}${det}${fix}`;
    })
    .join("\n");
  return { probes, allOk, summary };
}

// ---------- Install action ----------

export interface InstallResult {
  package: string;
  command: string;
  exitCode: number;
  alreadyInstalled: boolean;
  stdout: string;
  stderr: string;
}

export interface PrereqGateResult {
  ok: boolean;
  node: Probe;
  pwsh: Probe;
  blockers: string[];
}

export async function checkMandatoryPrereqs(): Promise<PrereqGateResult> {
  const [node, pwsh] = await Promise.all([probeNode(), probePwsh()]);
  const blockers: string[] = [];
  if (node.detail?.includes("WARNING")) {
    blockers.push(`Node.js ${node.version} is older than recommended 18+. Upgrade Node from https://nodejs.org/`);
  }
  if (pwsh.status !== "ok") {
    blockers.push(`PowerShell 7+ is ${pwsh.status === "missing" ? "missing" : "not satisfactory"}: ${pwsh.detail ?? "(unknown)"}. ${pwshInstallHint()}`);
  }
  return { ok: blockers.length === 0, node, pwsh, blockers };
}

export async function installPnpModule(): Promise<{ prereqs: PrereqGateResult; install?: InstallResult }> {
  const prereqs = await checkMandatoryPrereqs();
  if (!prereqs.ok) return { prereqs };

  const probe = await probePnpModule();
  if (probe.status === "ok") {
    return {
      prereqs,
      install: {
        package: PNP_PS_MODULE,
        // Keep this consistent with the actual installer the server would run if needed.
        command: `Install-PSResource -Name ${PNP_PS_MODULE} -Scope CurrentUser  (with Install-Module fallback)`,
        exitCode: 0,
        alreadyInstalled: true,
        stdout: `${PNP_PS_MODULE} v${probe.version} already installed; skipping.`,
        stderr: "",
      },
    };
  }

  // A3 fix: prefer Install-PSResource (PSResourceGet 1.x, ships with pwsh ≥ 7.4) — it's
  // ~15× faster than Install-Module and is more resilient to the PowerShellGet 2.x edge
  // cases (NuGet provider re-bootstrap failures, Set-PSRepository load errors). Fall back
  // to Install-Module on older pwsh that lacks PSResourceGet, or if PSResourceGet itself
  // errors out for some reason.
  //
  // Both branches finish by emitting `INSTALLED:<version>` so callers can verify success.
  const bin = resolvePwsh();
  const installScript = [
    "$ErrorActionPreference='Stop';",
    "$installed=$false;",
    "$method='';",
    "$attemptErr='';",
    // Try modern installer first.
    "if (Get-Command Install-PSResource -ErrorAction SilentlyContinue) {",
    "  try {",
    `    Install-PSResource -Name ${PNP_PS_MODULE} -Scope CurrentUser -TrustRepository -Reinstall -ErrorAction Stop;`,
    "    $installed=$true; $method='Install-PSResource'",
    "  } catch {",
    "    $attemptErr = 'Install-PSResource failed: ' + $_.Exception.Message",
    "  }",
    "}",
    // Fallback to legacy installer.
    "if (-not $installed) {",
    "  try {",
    `    Install-Module -Name ${PNP_PS_MODULE} -Force -AllowClobber -Scope CurrentUser -ErrorAction Stop;`,
    "    $installed=$true; $method='Install-Module'",
    "  } catch {",
    "    $attemptErr = $attemptErr + ' | Install-Module failed: ' + $_.Exception.Message",
    "  }",
    "}",
    "if ($installed) {",
    `  $v = Get-Module -ListAvailable ${PNP_PS_MODULE} | Sort-Object Version -Descending | Select-Object -First 1 -ExpandProperty Version;`,
    "  Write-Output ('INSTALLED:' + $v.ToString() + '|via:' + $method)",
    "} else {",
    "  Write-Error $attemptErr; exit 1",
    "}",
  ].join(" ");
  const r = await runOnce(
    bin,
    ["-NoProfile", "-Command", installScript],
    10 * 60_000,
  );
  return {
    prereqs,
    install: {
      package: PNP_PS_MODULE,
      command: `Install-PSResource -Name ${PNP_PS_MODULE} -Scope CurrentUser  (with Install-Module fallback)`,
      exitCode: r.exitCode,
      alreadyInstalled: false,
      stdout: r.stdout,
      stderr: r.stderr,
    },
  };
}

// ---------- CLI mode ----------

export async function runSetupCli(): Promise<void> {
  const out = (s: string) => process.stdout.write(s + "\n");
  const probeIcon = (p: Probe) => p.status === "ok" ? "✅" : p.status === "missing" ? "❌" : "⚠️";

  out("══════════════════════════════════════════════════════════════");
  out("  PnP MCP — interactive setup");
  out("══════════════════════════════════════════════════════════════\n");

  out("Phase 1 — Mandatory prerequisites (Node.js + PowerShell 7+)");
  out("─────────────────────────────────────────────────────────");
  out("These cannot be auto-installed by this script — they require OS-level");
  out("installation, often with admin rights. We MUST verify them before doing");
  out("anything else.\n");

  const prereqs = await checkMandatoryPrereqs();
  out(`  ${probeIcon(prereqs.node)} Node.js${prereqs.node.version ? ` v${prereqs.node.version}` : ""}${prereqs.node.detail ? ` — ${prereqs.node.detail}` : ""}`);
  out(`  ${probeIcon(prereqs.pwsh)} PowerShell${prereqs.pwsh.version ? ` v${prereqs.pwsh.version}` : ""}${prereqs.pwsh.detail ? ` — ${prereqs.pwsh.detail}` : ""}`);
  out("");

  if (!prereqs.ok) {
    out("✗ Mandatory prerequisites are not satisfied. Cannot proceed.\n");
    for (const reason of prereqs.blockers) out("  • " + reason);
    out("\nFix the items above, then re-run: npx @emin-bit/pnp-mcp setup\n");
    process.exit(1);
  }
  out("✓ Mandatory prerequisites OK.\n");

  out("Phase 2 — Auto-install PnP.PowerShell module");
  out("─────────────────────────────────────────────────────────");
  out(`Installs into your CurrentUser scope (no admin required). Tries Install-PSResource`);
  out(`first (faster, more reliable on pwsh 7.4+), falls back to Install-Module if needed.\n`);

  const res = await installPnpModule();
  if (!res.prereqs.ok) {
    out("✗ Prerequisites disappeared between phases — abort.\n");
    process.exit(1);
  }
  if (res.install?.alreadyInstalled) {
    out(`  ✓ ${res.install.package}: already installed (skipped)`);
  } else if (res.install?.exitCode === 0) {
    out(`  ✓ ${res.install.package}: installed`);
  } else if (res.install) {
    out(`  ✗ ${res.install.package}: install failed (exit ${res.install.exitCode})`);
    if (res.install.stderr.trim()) out(`    last stderr line: ${res.install.stderr.trim().split("\n").pop()}`);
  }
  out("");

  out("Phase 3 — Verify final state");
  out("─────────────────────────────────────────────────────────");
  const post = await runPreflight();
  out(post.summary + "\n");

  out("Phase 4 — Manual steps (auth + Claude Desktop config)");
  out("─────────────────────────────────────────────────────────");
  out("  1. Authenticate to your tenant (one-time, interactive in browser):");
  out("       pwsh -Command \"Connect-PnPOnline -Url https://YOUR_TENANT.sharepoint.com -Interactive\"\n");
  out("  2. Add this block to your Claude Desktop config:");
  const home = homedir();
  const cfgPath = process.platform === "darwin"
    ? `${home}/Library/Application Support/Claude/claude_desktop_config.json`
    : process.platform === "win32"
      ? `%APPDATA%\\Claude\\claude_desktop_config.json`
      : `${home}/.config/Claude/claude_desktop_config.json`;
  out(`     (config file: ${cfgPath})\n`);
  const snippet = JSON.stringify({
    mcpServers: {
      pnp: {
        command: "npx",
        args: ["-y", "@emin-bit/pnp-mcp"],
        env: {
          PNP_MCP_SAFE_MODE: "on",
          MCP_TIMEOUT: "600000",
        },
      },
    },
  }, null, 2);
  for (const line of snippet.split("\n")) out("       " + line);
  out("\n  3. Restart Claude Desktop (Cmd+Q on macOS, then reopen).");
  out("  4. In a new chat, ask: \"run pnp preflight\" — it should show all green.\n");

  out("══════════════════════════════════════════════════════════════");
  out(post.allOk
    ? "  Setup complete. After Phase 4 (auth + config + restart), MCP is ready."
    : "  Setup partially complete. Address the items above (likely auth — that's expected if you haven't connected yet).");
  out("══════════════════════════════════════════════════════════════");
}
