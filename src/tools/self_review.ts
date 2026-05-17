// pnp_self_review — mine ~/.pnp-mcp/logs/ and produce a structured usage analysis.
// Phase G (1.2.0). Mirrors pp_self_review from @emin-bit/power-platform-mcp@1.2.0 but
// tuned for the PnP/PowerShell semantics:
//   - Tool calls go through `pnp_run` (passthrough) → we parse the underlying pwsh
//     command to classify by cmdlet family.
//   - Typed tools (pnp_site_*, pnp_list_*, etc.) are first-class — we report their
//     usage separately to surface "Claude bypassed the typed wrapper" patterns.
//   - Failure modes are different: PnP 3.x throws on connection lost, on missing
//     -Identity arg, on permission denied. The runner now logs stderr (Phase E in
//     the sibling repo; PnP MCP gained the same in 1.1.0).
//
// Privacy: log payloads already have homedir + OS username redacted (since 1.1.0
// privacy hardening). Output of this tool is safe to share.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ToolResult } from "../runner.js";
import { getLogDir } from "../logger.js";

interface LogEntry {
  file: string;
  ts: string;
  level?: string;
  msg?: string;
  [key: string]: unknown;
}

function loadLogs(daysBack: number): LogEntry[] {
  const dir = getLogDir();
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000;
  const out: LogEntry[] = [];
  for (const f of readdirSync(dir).filter(n => n.endsWith(".log")).sort()) {
    const dateMatch = f.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (dateMatch) {
      const fDate = new Date(`${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}T00:00:00Z`).getTime();
      if (fDate < cutoff) continue;
    }
    try {
      const lines = readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
      for (const l of lines) {
        try { out.push({ file: f, ...JSON.parse(l) } as LogEntry); } catch { /* skip non-json line */ }
      }
    } catch { /* file unreadable, skip */ }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts));
}

interface ToolCallPair {
  tool: string;
  startTs: string;
  doneTs?: string;
  exitCode?: number;
  durationMs?: number;
  timedOut?: boolean;
  cmd?: string;
  stderr?: string;
}

function pairToolCalls(entries: LogEntry[]): ToolCallPair[] {
  const pairs: ToolCallPair[] = [];
  const pending = new Map<string, LogEntry>();
  for (const e of entries) {
    if (!e.msg) continue;
    if (e.msg.endsWith(" done")) {
      const tool = e.msg.replace(/ done$/, "");
      const start = pending.get(tool);
      pairs.push({
        tool,
        startTs: start?.ts ?? e.ts,
        doneTs: e.ts,
        exitCode: e.exitCode as number | undefined,
        durationMs: e.durationMs as number | undefined,
        timedOut: e.timedOut as boolean | undefined,
        cmd: start?.cmd as string | undefined,
        stderr: (e.stderr ?? e.errorMessage) as string | undefined,
      });
      pending.delete(tool);
    } else {
      pending.set(e.msg, e);
    }
  }
  return pairs;
}

function inferSessions(entries: LogEntry[], gapMs = 3600_000): LogEntry[][] {
  const out: LogEntry[][] = [];
  let cur: LogEntry[] = [];
  let prev: LogEntry | null = null;
  for (const e of entries) {
    if (prev && new Date(e.ts).getTime() - new Date(prev.ts).getTime() > gapMs) {
      if (cur.length) out.push(cur);
      cur = [];
    }
    cur.push(e);
    prev = e;
  }
  if (cur.length) out.push(cur);
  return out;
}

function pct(part: number, total: number): string {
  if (!total) return "0%";
  return ((part / total) * 100).toFixed(1) + "%";
}

function durationSummary(durations: number[]): { p50: number; p95: number; max: number } {
  if (!durations.length) return { p50: 0, p95: 0, max: 0 };
  const ds = [...durations].sort((a, b) => a - b);
  return {
    p50: ds[Math.floor(ds.length / 2)] ?? 0,
    p95: ds[Math.floor(ds.length * 0.95)] ?? 0,
    max: ds[ds.length - 1] ?? 0,
  };
}

/**
 * Classify a pnp_run command string by the cmdlet it executes. The PnP cmdlet
 * naming convention (Verb-PnPNoun) makes this reliable. We strip leading `try
 * { ... } catch {...}` wrappers and pipelines so the FIRST significant cmdlet
 * wins.
 */
function classifyPnpRunCmd(cmd: string): string {
  const m = cmd.match(/\b((?:Get|Set|Add|Remove|New|Connect|Disconnect|Invoke|Register|Unregister|Move|Copy|Submit|Restore|Install|Publish|Save|Clear|Reset|Disable|Enable)-PnP\w+)\b/);
  if (m) return m[1];
  // Non-PnP cmdlets fall here (Get-Module, Write-Output, ConvertTo-Json, etc.) —
  // these are usually utility/test commands.
  const generic = cmd.match(/\b([A-Z][a-zA-Z]+-[A-Z][a-zA-Z0-9]+)\b/);
  return generic ? `(util) ${generic[1]}` : "(no-cmdlet)";
}

/** SharePoint workflow family classifier — used to surface what the user is REALLY doing. */
function classifyFamily(cmdlet: string): string {
  const c = cmdlet.replace(/^\(util\) /, "");
  if (/^(Connect|Disconnect|Get-PnPConnection)/.test(c)) return "Auth + Connection";
  if (/PnPTenantSite|PnPTenant|PnPSite\b|PnPHomeSite|PnPOrgNewsSite/.test(c)) return "Sites + Tenant admin";
  if (/PnPWeb\b/.test(c)) return "Webs";
  if (/PnPList\b|PnPListItem/.test(c)) return "Lists + Items";
  if (/PnPField|PnPContentType/.test(c)) return "Schema (fields, CTs)";
  if (/PnPFile|PnPFolder/.test(c)) return "Files + Folders";
  if (/PnPGroup|PnPRoleDefinition|PnPListPermission|PnPListItemPermission|PnPWebPermission|PnPSiteCollectionAdmin/.test(c)) return "Permissions";
  if (/PnPHubSite|PnPHubToHub/.test(c)) return "Hub sites";
  if (/PnPMicrosoft365Group/.test(c)) return "M365 Groups";
  if (/PnPPage\b/.test(c)) return "Pages";
  if (/PnPNavigation/.test(c)) return "Navigation";
  if (/PnPTenantTemplate|PnPSiteTemplate|PnPProvisioning/.test(c)) return "Provisioning templates";
  if (/PnPApp|PnPAppCatalog/.test(c)) return "App catalog";
  if (/PnPSearchQuery|PnPSearch/.test(c)) return "Search";
  if (/PnPView/.test(c)) return "Views";
  return "Other / utility";
}

export function registerSelfReview(server: McpServer) {
  server.tool(
    "pnp_self_review",
    "Mine the local pnp-mcp log directory (~/.pnp-mcp/logs/) and produce a structured usage report: " +
    "tool frequency, failure rate (with stderr extracts), slow operations, top PnP cmdlets called via " +
    "pnp_run, SharePoint workflow categories (sites / lists / files / permissions / pages / hubs / " +
    "M365 groups / etc.), auth/connection events, and week-over-week trend. Use this periodically " +
    "(weekly) to see which MCP fix-es land and which patterns suggest the next improvement. " +
    "Phase G (1.2.0). Local-only — no telemetry, no network.",
    {
      days: z.number().int().positive().max(60).default(7).describe(
        "How many days back to analyze (default 7, max 60).",
      ),
      compare_with_prior_window: z.boolean().default(true).describe(
        "Include a week-over-week trend section.",
      ),
      include_raw_failures: z.boolean().default(true).describe(
        "Include stderr extracts from each failure (truncated). Set false for compact summary.",
      ),
    },
    async ({ days, compare_with_prior_window, include_raw_failures }): Promise<ToolResult> => {
      const current = loadLogs(days);
      if (!current.length) {
        return {
          content: [{
            type: "text",
            text:
              `No log entries found in ${getLogDir()} for the past ${days} day(s).\n` +
              `If you've been using the MCP, check PNP_MCP_LOG_DIR env var override.`,
          }],
        };
      }

      const pairs = pairToolCalls(current);
      const sessions = inferSessions(current);
      const totalCalls = pairs.length;
      const failures = pairs.filter(p => p.exitCode !== undefined && p.exitCode !== 0);
      const timeouts = pairs.filter(p => p.timedOut);
      const failureRate = pct(failures.length, totalCalls);

      // ---- per-tool stats ----
      const byTool: Record<string, { calls: number; fails: number; tos: number; durations: number[] }> = {};
      for (const p of pairs) {
        byTool[p.tool] = byTool[p.tool] ?? { calls: 0, fails: 0, tos: 0, durations: [] };
        byTool[p.tool].calls++;
        if (p.exitCode !== undefined && p.exitCode !== 0) byTool[p.tool].fails++;
        if (p.timedOut) byTool[p.tool].tos++;
        if (p.durationMs != null) byTool[p.tool].durations.push(p.durationMs);
      }
      const toolRows = Object.entries(byTool).sort((a, b) => b[1].calls - a[1].calls);

      // ---- PnP cmdlet classification (only for pnp_run calls) ----
      const cmdletCounts: Record<string, number> = {};
      const familyCounts: Record<string, number> = {};
      let runCallsWithCmd = 0;
      for (const p of pairs) {
        if (p.tool !== "pnp_run" || !p.cmd) continue;
        runCallsWithCmd++;
        const cmdlet = classifyPnpRunCmd(p.cmd);
        cmdletCounts[cmdlet] = (cmdletCounts[cmdlet] ?? 0) + 1;
        familyCounts[classifyFamily(cmdlet)] = (familyCounts[classifyFamily(cmdlet)] ?? 0) + 1;
      }
      const topCmdlets = Object.entries(cmdletCounts).sort((a, b) => b[1] - a[1]).slice(0, 20);
      const topFamilies = Object.entries(familyCounts).sort((a, b) => b[1] - a[1]);

      // ---- typed-vs-passthrough usage ratio ----
      const typedCalls = pairs.filter(p => p.tool.startsWith("pnp_") && p.tool !== "pnp_run" && p.tool !== "pnp_help" && p.tool !== "pnp_session_status").length;
      const passthroughCalls = pairs.filter(p => p.tool === "pnp_run").length;
      const passthroughRatio = passthroughCalls + typedCalls > 0
        ? `${pct(passthroughCalls, passthroughCalls + typedCalls)} of substantive calls`
        : "n/a";

      // ---- auth / connection events ----
      const authPairs = pairs.filter(p => p.tool.startsWith("pnp_auth_") || (p.cmd && /Connect-PnPOnline|Disconnect-PnPOnline/i.test(p.cmd)));
      const realAuthAttempts = authPairs.filter(p => p.tool !== "pnp_auth_disconnect").length;

      // ---- failure stderr extracts ----
      const failureExtracts: string[] = [];
      if (include_raw_failures && failures.length) {
        const grouped: Record<string, { count: number; samples: string[] }> = {};
        for (const f of failures) {
          const key = f.tool === "pnp_run" && f.cmd ? `pnp_run [${classifyPnpRunCmd(f.cmd)}]` : f.tool;
          grouped[key] = grouped[key] ?? { count: 0, samples: [] };
          grouped[key].count++;
          if (grouped[key].samples.length < 3) {
            const sample = `(${f.startTs.slice(0, 19)} exit=${f.exitCode}, ${f.durationMs}ms) ` +
              (f.cmd ? `cmd: ${f.cmd.slice(0, 100)}` : "") +
              (f.stderr ? ` | err: ${f.stderr.slice(0, 200)}` : "");
            grouped[key].samples.push(sample);
          }
        }
        for (const [key, info] of Object.entries(grouped).sort((a, b) => b[1].count - a[1].count)) {
          failureExtracts.push(`\n  ▸ ${key} (${info.count} failure${info.count > 1 ? "s" : ""})`);
          for (const s of info.samples) failureExtracts.push("      " + s);
        }
      }

      // ---- week-over-week ----
      let weekOverWeek = "";
      if (compare_with_prior_window) {
        const prior = loadLogs(days * 2).filter(e => {
          const ts = new Date(e.ts).getTime();
          const cutoffStart = Date.now() - days * 2 * 24 * 60 * 60 * 1000;
          const cutoffEnd = Date.now() - days * 24 * 60 * 60 * 1000;
          return ts >= cutoffStart && ts < cutoffEnd;
        });
        const priorPairs = pairToolCalls(prior);
        if (priorPairs.length) {
          const priorFails = priorPairs.filter(p => p.exitCode !== undefined && p.exitCode !== 0).length;
          const priorRate = (priorFails / priorPairs.length) * 100;
          const currRate = totalCalls ? (failures.length / totalCalls) * 100 : 0;
          const delta = currRate - priorRate;
          const arrow = Math.abs(delta) < 1 ? "→" : delta < 0 ? "↓" : "↑";
          weekOverWeek =
            `\n=== TREND (prior ${days}d → current ${days}d) ===\n` +
            `  Total calls:   ${priorPairs.length} → ${totalCalls} (${arrow})\n` +
            `  Failure rate:  ${priorRate.toFixed(1)}% → ${currRate.toFixed(1)}%  (Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(1)}pp)\n`;
        }
      }

      // ---- suggestions ----
      const suggestions: string[] = [];
      if (realAuthAttempts === 0 && totalCalls > 50) {
        suggestions.push(
          "▸ ZERO auth attempts (no pnp_auth_connect_*, no Connect-PnPOnline) over " +
          totalCalls + " calls. Either you're running smoke tests only, OR your session " +
          "is reusing a stale connection. Run pnp_session_status to verify the active connection.",
        );
      }
      if (passthroughCalls > typedCalls * 5 && typedCalls < 5) {
        suggestions.push(
          "▸ Heavy pnp_run usage (" + passthroughCalls + " passthrough vs " + typedCalls + " typed). " +
          "Many cmdlets you call via pnp_run have typed wrappers (pnp_site_*, pnp_list_*, etc.). " +
          "Typed tools surface common parameters in the schema and apply consistent safety gates. " +
          "Consider asking Claude to prefer typed tools — they have the same capabilities with better UX.",
        );
      }
      for (const [tool, s] of toolRows) {
        if (s.calls >= 5 && s.fails / s.calls > 0.20) {
          suggestions.push(`▸ ${tool} has ${pct(s.fails, s.calls)} failure rate over ${s.calls} calls — investigate stderr extracts above.`);
        }
        const ds = durationSummary(s.durations);
        if (s.calls >= 3 && ds.p95 > 60_000 && !tool.startsWith("job_")) {
          suggestions.push(`▸ ${tool} p95 = ${(ds.p95 / 1000).toFixed(1)}s, past Claude Desktop's 60s MCP transport timeout. If it doesn't expose background:true, add it.`);
        }
      }

      // ---- build report ----
      const lines: string[] = [];
      lines.push(`# pnp_self_review — last ${days} day(s)`);
      lines.push(`Generated ${new Date().toISOString()} from ${current.length} log entries across ${sessions.length} session(s).`);
      lines.push("");
      lines.push(`=== HEADLINE ===`);
      lines.push(`  Tool calls completed:        ${totalCalls}`);
      lines.push(`  Failures (exit ≠ 0):         ${failures.length} (${failureRate})`);
      lines.push(`  Timeouts:                    ${timeouts.length}`);
      lines.push(`  Sessions inferred:           ${sessions.length}`);
      lines.push(`  Typed tool usage:            ${typedCalls} calls`);
      lines.push(`  pnp_run passthrough usage:   ${passthroughCalls} calls (${passthroughRatio})`);
      lines.push(`  Connect-PnPOnline attempts:  ${realAuthAttempts}`);

      lines.push(weekOverWeek);

      lines.push("=== TOP 15 MCP TOOLS BY FREQUENCY ===");
      lines.push("  calls  fails  to    p50      p95     tool");
      for (const [tool, s] of toolRows.slice(0, 15)) {
        const ds = durationSummary(s.durations);
        lines.push(
          "  " + String(s.calls).padStart(5) +
          "  " + String(s.fails).padStart(5) +
          "  " + String(s.tos).padStart(2) +
          "  " + (ds.p50 / 1000).toFixed(2).padStart(6) + "s" +
          "  " + (ds.p95 / 1000).toFixed(2).padStart(6) + "s" +
          "  " + tool,
        );
      }
      lines.push("");

      if (runCallsWithCmd > 0) {
        lines.push(`=== TOP 15 PnP CMDLETS CALLED VIA pnp_run (${runCallsWithCmd} classified calls) ===`);
        for (const [c, n] of topCmdlets.slice(0, 15)) lines.push("  " + String(n).padStart(4) + "  " + c);
        lines.push("");
        lines.push("=== WORKFLOW FAMILY DISTRIBUTION (pnp_run only) ===");
        for (const [fam, n] of topFamilies) lines.push("  " + String(n).padStart(4) + "  " + fam);
        lines.push("");
      }

      if (failureExtracts.length) {
        lines.push("=== FAILURE STDERR EXTRACTS ===");
        lines.push(...failureExtracts);
        lines.push("");
      }

      lines.push("=== SUGGESTIONS ===");
      if (suggestions.length === 0) {
        lines.push("  Nothing pops out from this window. 🟢");
      } else {
        for (const s of suggestions) lines.push("  " + s);
      }
      lines.push("");

      lines.push("---");
      lines.push("Privacy: log files already have homedir + OS username auto-redacted (since 1.1.0).");
      lines.push("This report is safe to copy into chat or a GitHub issue.");

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}
