import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listJobs, getJob, cancelJob, waitForJob, summarizeJob, type Job } from "../jobs.js";

function renderJob(j: Job | undefined): string {
  if (!j) return "(no job)";
  const summary = summarizeJob(j);
  const out = j.stdout.trim() ? `\n--- stdout ---\n${j.stdout.trimEnd()}${j.truncatedStdout ? "\n[stdout truncated at 200KB]" : ""}` : "";
  const err = j.stderr.trim() ? `\n--- stderr ---\n${j.stderr.trimEnd()}${j.truncatedStderr ? "\n[stderr truncated at 200KB]" : ""}` : "";
  return `${summary}${out}${err}`;
}

export function registerJobTools(server: McpServer) {
  server.tool(
    "job_list",
    "List background pwsh jobs tracked by this MCP session — running, succeeded, failed, cancelled. " +
    "Each entry: job id, tool name, state, duration. Jobs do NOT survive MCP server restart (Claude Desktop quit). " +
    "Background jobs run in SEPARATE pwsh processes from the interactive session and do not share auth — each job's command must include its own Connect-PnPOnline if it needs auth.",
    {
      state_filter: z.enum(["all", "running", "succeeded", "failed", "cancelled"]).default("all"),
    },
    async ({ state_filter }) => {
      const all = listJobs();
      const filtered = state_filter === "all" ? all : all.filter(j => j.state === state_filter);
      if (filtered.length === 0) {
        return { content: [{ type: "text", text: "(no jobs)" }] };
      }
      const lines = filtered.map(j => {
        const dur = (j.endedAt ?? Date.now()) - j.startedAt;
        return `[${j.id}] ${j.state.padEnd(9)} dur=${dur}ms tool=${j.toolName}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );

  server.tool(
    "job_status",
    "Get full status of one background pwsh job by id, including current stdout/stderr (cap 200KB per stream).",
    { id: z.string().describe("Job id from job_list") },
    async ({ id }) => {
      const j = getJob(id);
      if (!j) return { isError: true, content: [{ type: "text", text: `No job with id=${id}` }] };
      return { content: [{ type: "text", text: renderJob(j) }] };
    },
  );

  server.tool(
    "job_wait",
    "Block until a background pwsh job completes, or until the timeout expires. Useful when you started a long-running command in background mode and want to wait for the result before proceeding.",
    {
      id: z.string(),
      timeout_seconds: z.number().int().positive().max(3600).default(600).describe("Max wait (default 600s, max 3600s)"),
    },
    async ({ id, timeout_seconds }) => {
      const j = await waitForJob(id, timeout_seconds * 1000);
      if (!j) return { isError: true, content: [{ type: "text", text: `No job with id=${id}` }] };
      const note = j.state === "running" ? "\n[timeout reached, job still running — call job_status later]" : "";
      return {
        isError: j.state === "failed",
        content: [{ type: "text", text: renderJob(j) + note }],
      };
    },
  );

  server.tool(
    "job_cancel",
    "Kill a running background pwsh job (SIGTERM, then SIGKILL after 5s). " +
    "NOTE: this only kills the local pwsh process. If the underlying SharePoint operation is server-side (template apply, site copy), it MAY continue on the SharePoint backend — check the SharePoint admin center to verify state.",
    { id: z.string() },
    async ({ id }) => {
      const r = cancelJob(id);
      const j = getJob(id);
      if (!j) return { isError: true, content: [{ type: "text", text: `No job with id=${id}` }] };
      const text = r.ok
        ? `Cancelled job ${id}. Note: any server-side SharePoint operation may still be running; check the SharePoint admin center for actual state.`
        : `Cannot cancel job ${id}: ${r.reason}`;
      return { isError: !r.ok, content: [{ type: "text", text }] };
    },
  );
}
