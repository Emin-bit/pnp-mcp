// SharePoint File operations — Get-PnPFile, Add-PnPFile, Remove-PnPFile,
// Copy-PnPFile, Move-PnPFile.
//
// Background-mode strategy: cross-site / cross-tenant Copy/Move operations are async
// on the SharePoint backend (-NoWait). We expose `background: true` on copy/move so
// the MCP-level pwsh process doesn't hold the connection open during a multi-minute
// server-side job.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { backgroundResult } from "../jobs.js";
import { psQuote, psSwitch, psHashtable } from "../util.js";

export function registerFile(server: McpServer) {
  // ============================================================================
  // pnp_file_get — get metadata or download a file
  // ============================================================================
  server.tool(
    "pnp_file_get",
    "Get a file from SharePoint. Three modes:\n" +
    "  • metadata (default): returns file properties as JSON (size, version, modified, author).\n" +
    "  • `as_string: true`: download file content as a UTF-8 string (small text files only — Claude context limits apply).\n" +
    "  • `as_file: true` + `local_path`: save to local disk on the MCP server's host machine. Use absolute path.\n" +
    "Mutually exclusive — pass exactly one mode.",
    {
      url: z.string().describe(
        "Server-relative URL or site-relative URL. Example: '/sites/marketing/Shared Documents/report.pdf'",
      ),
      as_string: z.boolean().default(false).describe(
        "Download content as a string (text files; UTF-8). Mutually exclusive with as_file.",
      ),
      as_file: z.boolean().default(false).describe(
        "Save to local disk. Requires `local_path` (directory) and optionally `filename`. Mutually exclusive with as_string.",
      ),
      local_path: z.string().optional().describe(
        "Local directory to save into when as_file=true. Absolute path recommended.",
      ),
      filename: z.string().optional().describe(
        "Override filename when saving (defaults to source filename).",
      ),
      force: z.boolean().default(false).describe("Overwrite existing local file (as_file mode only)."),
    },
    async ({ url, as_string, as_file, local_path, filename, force }): Promise<ToolResult> => {
      if (as_string && as_file) {
        return { isError: true, content: [{ type: "text", text: "as_string and as_file are mutually exclusive. Pick one mode." }] };
      }
      if (as_file && !local_path) {
        return { isError: true, content: [{ type: "text", text: "as_file=true requires `local_path` (target directory)." }] };
      }
      let cmd: string;
      if (as_string) {
        cmd = `Get-PnPFile -Url ${psQuote(url)} -AsString`;
      } else if (as_file) {
        const parts = [`Get-PnPFile -Url ${psQuote(url)} -AsFile -Path ${psQuote(local_path!)}`];
        if (filename) parts.push(`-Filename ${psQuote(filename)}`);
        if (force) parts.push(psSwitch("Force", true));
        cmd = parts.join(" ");
      } else {
        // Metadata mode — return file properties (note: -AsListItem gives more, but is heavier)
        cmd =
          `Get-PnPFile -Url ${psQuote(url)} ` +
          `| Select-Object Name, ServerRelativeUrl, Length, MajorVersion, MinorVersion, ` +
          `TimeCreated, TimeLastModified, Author, Title, ETag, UniqueId ` +
          `| ConvertTo-Json -Depth 5 -Compress`;
      }
      return runAsTool({
        toolName: "pnp_file_get",
        command: cmd,
        // Generous timeout for downloads of larger files; small metadata calls finish in <1s.
        timeoutMs: 10 * 60_000,
      });
    },
  );

  // ============================================================================
  // pnp_file_add — upload a file from local disk to SharePoint
  // ============================================================================
  server.tool(
    "pnp_file_add",
    "Upload a file from the LOCAL DISK (where this MCP server runs) into a SharePoint folder. Wraps Add-PnPFile -Path. " +
    "For large files (>250 MB) PnP recommends `use_webdav: true` (chunked WebDAV upload). " +
    "Modifies the connected site.",
    {
      local_path: z.string().describe(
        "Absolute path to a local file readable by the MCP server process.",
      ),
      folder: z.string().describe(
        "Target SharePoint folder server-relative URL. Example: '/sites/marketing/Shared Documents/2026-Q2'",
      ),
      new_filename: z.string().optional().describe("Rename on upload (default: keep source filename)."),
      content_type: z.string().optional().describe("Content type to set on the new file."),
      values: z.record(z.unknown()).optional().describe(
        "Field values to set on the uploaded file (e.g. { Title: 'Report Q2' }).",
      ),
      checkout: z.boolean().default(false),
      checkin_comment: z.string().optional(),
      checkin_type: z.enum(["MajorCheckIn", "MinorCheckIn", "OverwriteCheckIn"]).optional(),
      publish: z.boolean().default(false).describe("Publish a major version after upload."),
      publish_comment: z.string().optional(),
      approve: z.boolean().default(false).describe("Approve after upload (if list has approval enabled)."),
      approve_comment: z.string().optional(),
      use_webdav: z.boolean().default(false).describe(
        "Use chunked WebDAV upload — recommended for files >250 MB.",
      ),
      background: z.boolean().default(false).describe(
        "Spawn upload in a separate pwsh process. Useful for very large files.",
      ),
    },
    async (a): Promise<ToolResult> => {
      const parts = [
        `Add-PnPFile -Path ${psQuote(a.local_path)} -Folder ${psQuote(a.folder)}`,
      ];
      if (a.new_filename) parts.push(`-NewFileName ${psQuote(a.new_filename)}`);
      if (a.content_type) parts.push(`-ContentType ${psQuote(a.content_type)}`);
      if (a.values && Object.keys(a.values).length) {
        // Single source of truth for hashtable formatting — same helper as listitem.ts.
        // Previously had an inline simplified version that silently coerced arrays to
        // `'a,b'` strings. Using psHashtable means full type fidelity (arrays, dates,
        // null vs undefined semantics) and a clear error on nested objects.
        parts.push(`-Values ${psHashtable(a.values as Record<string, unknown>)}`);
      }
      if (a.checkout) parts.push(psSwitch("Checkout", true));
      if (a.checkin_comment) parts.push(`-CheckInComment ${psQuote(a.checkin_comment)}`);
      if (a.checkin_type) parts.push(`-CheckinType ${a.checkin_type}`);
      if (a.publish) parts.push(psSwitch("Publish", true));
      if (a.publish_comment) parts.push(`-PublishComment ${psQuote(a.publish_comment)}`);
      if (a.approve) parts.push(psSwitch("Approve", true));
      if (a.approve_comment) parts.push(`-ApproveComment ${psQuote(a.approve_comment)}`);
      if (a.use_webdav) parts.push(psSwitch("UseWebDav", true));

      const cmd =
        parts.join(" ") +
        " | Select-Object Name, ServerRelativeUrl, Length, MajorVersion, MinorVersion, " +
        "TimeCreated, TimeLastModified, ETag, UniqueId | ConvertTo-Json -Depth 5 -Compress";

      if (a.background) return backgroundResult("pnp_file_add", cmd);
      return runAsTool({
        toolName: "pnp_file_add",
        command: cmd,
        timeoutMs: 30 * 60_000, // generous for large uploads
      });
    },
  );

  // ============================================================================
  // pnp_file_remove — delete a file
  // ============================================================================
  server.tool(
    "pnp_file_remove",
    "DESTRUCTIVE: delete a file from SharePoint. By default sends to recycle bin (recovery within 93 days).",
    {
      server_relative_url: z.string().describe("Server-relative URL of the file"),
      recycle: z.boolean().default(true),
      confirm: z.boolean(),
    },
    async ({ server_relative_url, recycle, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return { isError: true, content: [{ type: "text", text: `BLOCKED: pnp_file_remove deletes ${server_relative_url}. Re-call with confirm=true.${recycle ? " (Recycle bin: 93-day recovery.)" : " (PERMANENT.)"}` }] };
      }
      const parts = [`Remove-PnPFile -ServerRelativeUrl ${psQuote(server_relative_url)} -Force`];
      if (recycle) parts.push("-Recycle");
      return runAsTool({
        toolName: "pnp_file_remove",
        command: parts.join(" "),
        timeoutMs: 60_000,
      });
    },
  );

  // ============================================================================
  // pnp_file_copy — copy a file (within site or cross-site)
  // ============================================================================
  server.tool(
    "pnp_file_copy",
    "Copy a file from one SharePoint location to another. Supports cross-site copy. Wraps Copy-PnPFile. " +
    "For large copies, set `no_wait: true` to return immediately (server-side async). Or use `background: true` for MCP-side async + job tracking.",
    {
      source_url: z.string().describe("Source server-relative URL"),
      target_url: z.string().describe("Target folder/file server-relative URL"),
      overwrite: z.boolean().default(false).describe("Overwrite if target exists."),
      ignore_version_history: z.boolean().default(false),
      no_wait: z.boolean().default(false).describe(
        "Return immediately; SharePoint backend completes asynchronously.",
      ),
      background: z.boolean().default(false),
    },
    async (a): Promise<ToolResult> => {
      const parts = [
        `Copy-PnPFile -SourceUrl ${psQuote(a.source_url)} -TargetUrl ${psQuote(a.target_url)}`,
      ];
      if (a.overwrite) parts.push(psSwitch("Overwrite", true));
      if (a.ignore_version_history) parts.push(psSwitch("IgnoreVersionHistory", true));
      if (a.no_wait) parts.push(psSwitch("NoWait", true));
      // Force flag — Copy-PnPFile uses -Force to skip confirm prompts (which we never see in -NonInteractive)
      parts.push(psSwitch("Force", true));
      const cmd = parts.join(" ");

      if (a.background) return backgroundResult("pnp_file_copy", cmd);
      return runAsTool({
        toolName: "pnp_file_copy",
        command: cmd,
        timeoutMs: 30 * 60_000,
      });
    },
  );

  // ============================================================================
  // pnp_file_move — move a file (within site or cross-site)
  // ============================================================================
  server.tool(
    "pnp_file_move",
    "Move a file from one SharePoint location to another. Supports cross-site move. DESTRUCTIVE for the source location. Requires confirm=true.",
    {
      source_url: z.string(),
      target_url: z.string(),
      overwrite: z.boolean().default(false),
      ignore_version_history: z.boolean().default(false),
      allow_schema_mismatch: z.boolean().default(false).describe(
        "Allow move when source and target schemas differ.",
      ),
      allow_smaller_version_limit_on_destination: z.boolean().default(false),
      no_wait: z.boolean().default(false),
      background: z.boolean().default(false),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) {
        return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_file_move removes the source after copy. Re-call with confirm=true." }] };
      }
      const parts = [
        `Move-PnPFile -SourceUrl ${psQuote(a.source_url)} -TargetUrl ${psQuote(a.target_url)} -Force`,
      ];
      if (a.overwrite) parts.push(psSwitch("Overwrite", true));
      if (a.ignore_version_history) parts.push(psSwitch("IgnoreVersionHistory", true));
      if (a.allow_schema_mismatch) parts.push(psSwitch("AllowSchemaMismatch", true));
      if (a.allow_smaller_version_limit_on_destination) parts.push(psSwitch("AllowSmallerVersionLimitOnDestination", true));
      if (a.no_wait) parts.push(psSwitch("NoWait", true));
      const cmd = parts.join(" ");

      if (a.background) return backgroundResult("pnp_file_move", cmd);
      return runAsTool({
        toolName: "pnp_file_move",
        command: cmd,
        timeoutMs: 30 * 60_000,
      });
    },
  );
}
