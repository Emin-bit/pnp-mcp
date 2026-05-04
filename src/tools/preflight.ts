import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runPreflight, installPnpModule, PNP_PS_MODULE } from "../setup.js";
import { stopSession } from "../pwsh.js";
import type { ToolResult } from "../runner.js";
import { log } from "../logger.js";

export function registerPreflight(server: McpServer) {
  server.tool(
    "preflight",
    "Diagnostic health check of the local PnP MCP setup. Returns a structured report covering: Node version, PowerShell 7+ (pwsh), PnP.PowerShell module, current PnP auth state. " +
    "Read-only — does not modify the system. Each missing/error item includes an actionable 'fix' command. " +
    "ALWAYS call this first when troubleshooting why a tool is failing, or when onboarding a new machine.",
    {},
    async (): Promise<ToolResult> => {
      log("info", "preflight");
      const r = await runPreflight();
      const text =
        `PnP MCP — preflight check\n\n${r.summary}\n\n` +
        `Overall: ${r.allOk ? "✅ all systems go" : "⚠️ items need attention"}\n\n` +
        `Next steps:\n` +
        `  • If pwsh missing → install PowerShell 7+ manually (cannot be auto-installed by this MCP).\n` +
        `  • If PnP.PowerShell module missing → call setup_install_pnp_module (with confirm:true) or run \`npx @emin-bit/pnp-mcp setup\` in terminal.\n` +
        `  • If PnP auth missing → call a pnp_auth_connect_* tool to authenticate.`;
      return {
        isError: !r.allOk,
        content: [{ type: "text", text }],
      };
    },
  );

  server.tool(
    "setup_install_pnp_module",
    `Install or update the ${PNP_PS_MODULE} PowerShell module via 'Install-Module -Force -AllowClobber -Scope CurrentUser'. ` +
    `Requires PowerShell 7+ to be already installed (this MCP cannot install pwsh itself — that's OS-specific and may require admin). ` +
    `Skips installation if the module is already present. After install, you may need to restart Claude Desktop so MCP picks up the freshly installed module. ` +
    `Requires confirm=true since this modifies the user's PowerShell module state (writes to ~/.local/share/powershell/Modules on Linux/macOS, %USERPROFILE%\\Documents\\PowerShell\\Modules on Windows).`,
    {
      confirm: z.boolean().describe("Must be true to actually run the install."),
    },
    async ({ confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `BLOCKED: setup_install_pnp_module modifies your system (installs ${PNP_PS_MODULE} into your CurrentUser PowerShell modules). Re-call with confirm=true to proceed.`,
          }],
        };
      }
      log("info", "setup_install_pnp_module");
      const res = await installPnpModule();

      if (!res.prereqs.ok) {
        const lines = [
          "❌ Mandatory prerequisites not satisfied. Cannot install the module.\n",
          `  Node.js: ${res.prereqs.node.status === "ok" ? "✅ v" + res.prereqs.node.version : "❌ " + (res.prereqs.node.detail ?? "not found")}`,
          `  PowerShell 7+: ${res.prereqs.pwsh.status === "ok" ? "✅ v" + res.prereqs.pwsh.version : "❌ " + (res.prereqs.pwsh.detail ?? "not found")}`,
          "",
          "Blockers:",
          ...res.prereqs.blockers.map(b => "  • " + b),
          "",
          "These cannot be auto-installed by this MCP — they need OS-level installs.",
          "Once installed, re-call this tool with confirm=true.",
        ];
        return { isError: true, content: [{ type: "text", text: lines.join("\n") }] };
      }

      const lines = [
        "PnP.PowerShell module — install result",
        "",
        "Phase 1 (prereqs): ✅ Node.js + PowerShell 7+ verified",
        "Phase 2 (install):",
      ];
      const r = res.install;
      if (!r) {
        lines.push("  (no install action recorded)");
      } else if (r.alreadyInstalled) {
        lines.push(`  ✓ ${r.package}: already installed (skipped)`);
      } else if (r.exitCode === 0) {
        lines.push(`  ✓ ${r.package}: newly installed`);
      } else {
        lines.push(`  ✗ ${r.package}: install failed (exit ${r.exitCode})`);
        if (r.stderr.trim()) lines.push(`    stderr: ${r.stderr.trim().split("\n").pop()}`);
      }

      // If we just freshly installed (or attempted to), stop the live REPL session so the
      // next tool call respawns pwsh and `Import-Module PnP.PowerShell` against the freshly
      // installed module. Without this, the long-lived session may have warmed up against
      // an OLD module (or none at all) and subsequent tool calls would behave inconsistently
      // until the user manually restarts Claude Desktop.
      const freshlyInstalled = !!(r && !r.alreadyInstalled && r.exitCode === 0);
      if (freshlyInstalled) {
        try {
          await stopSession();
          lines.push("  • REPL session reset — next pnp_* tool call will respawn pwsh and load the new module.");
        } catch (err) {
          lines.push(`  • REPL session reset attempted but failed: ${(err as Error).message}`);
        }
      }

      lines.push("");
      lines.push("Next: call preflight to verify, then authenticate via a pnp_auth_connect_* tool.");
      lines.push("(If anything looks off, a Claude Desktop restart is the safe fallback — it forces a clean MCP server start.)");

      const failed = !!(r && !r.alreadyInstalled && r.exitCode !== 0);
      return {
        isError: failed,
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  );
}
