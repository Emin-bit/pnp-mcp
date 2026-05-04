// SharePoint Folder management — Get-PnPFolder, Add-PnPFolder, Remove-PnPFolder.
//
// Add-PnPFolder is awkward in PnP: it takes `-Folder <FolderPipeBind>` (the PARENT folder)
// and `-Name <String>` (the new sub-folder name), so creating "/sites/x/Lib/A/B" means
// passing folder='/sites/x/Lib/A' and name='B'. We document this clearly.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { psQuote } from "../util.js";

const FOLDER_PROJECTION =
  "Name, ServerRelativeUrl, ItemCount, TimeCreated, TimeLastModified, " +
  "WelcomePage, ContentTypeOrder, UniqueId";

export function registerFolder(server: McpServer) {
  // ============================================================================
  // pnp_folder_get — get folder by URL
  // ============================================================================
  server.tool(
    "pnp_folder_get",
    "Get a folder by its server-relative URL. Returns folder metadata as JSON. To list folder CONTENTS, see pnp_folder_list.",
    {
      url: z.string().describe(
        "Server-relative URL of the folder. Example: '/sites/marketing/Shared Documents/Reports'",
      ),
    },
    async ({ url }): Promise<ToolResult> => {
      const cmd =
        `Get-PnPFolder -Url ${psQuote(url)} ` +
        `| Select-Object ${FOLDER_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({
        toolName: "pnp_folder_get",
        command: cmd,
        timeoutMs: 30_000,
      });
    },
  );

  // ============================================================================
  // pnp_folder_add — create a sub-folder
  // ============================================================================
  server.tool(
    "pnp_folder_add",
    "Create a new sub-folder under an existing parent folder. Important: pass the PARENT folder URL and the NEW folder NAME. " +
    "Example: to create '/sites/x/Lib/2026/Q2', pass parent_folder='/sites/x/Lib/2026' and name='Q2'.",
    {
      parent_folder: z.string().describe("Server-relative URL of the parent folder"),
      name: z.string().describe("Name of the new sub-folder (no slashes)"),
      confirm: z.boolean(),
    },
    async ({ parent_folder, name, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_folder_add modifies the connected site. Re-call with confirm=true." }] };
      }
      if (name.includes("/") || name.includes("\\")) {
        return { isError: true, content: [{ type: "text", text: "name must not contain slashes — pass only the leaf folder name. To create nested folders, call pnp_folder_add for each level." }] };
      }
      const cmd =
        `Add-PnPFolder -Folder ${psQuote(parent_folder)} -Name ${psQuote(name)} ` +
        `| Select-Object ${FOLDER_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({
        toolName: "pnp_folder_add",
        command: cmd,
        timeoutMs: 60_000,
      });
    },
  );

  // ============================================================================
  // pnp_folder_remove — delete a sub-folder
  // ============================================================================
  server.tool(
    "pnp_folder_remove",
    "DESTRUCTIVE: delete a folder AND ALL its contents (files + sub-folders). By default sends to recycle bin. Same parameter shape as pnp_folder_add (parent + name).",
    {
      parent_folder: z.string().describe("Server-relative URL of the parent folder"),
      name: z.string().describe("Name of the sub-folder to remove (no slashes)"),
      recycle: z.boolean().default(true),
      confirm: z.boolean(),
    },
    async ({ parent_folder, name, recycle, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return { isError: true, content: [{ type: "text", text: `BLOCKED: pnp_folder_remove deletes folder '${name}' AND all its contents under ${parent_folder}. Re-call with confirm=true.${recycle ? " (Recycle bin: 93-day recovery.)" : " (PERMANENT.)"}` }] };
      }
      if (name.includes("/") || name.includes("\\")) {
        return { isError: true, content: [{ type: "text", text: "name must not contain slashes — pass only the leaf folder name." }] };
      }
      const parts = [
        `Remove-PnPFolder -Folder ${psQuote(parent_folder)} -Name ${psQuote(name)} -Force`,
      ];
      if (recycle) parts.push("-Recycle");
      return runAsTool({
        toolName: "pnp_folder_remove",
        command: parts.join(" "),
        timeoutMs: 5 * 60_000,
      });
    },
  );
}
