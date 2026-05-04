// SharePoint List Item management — Get-PnPListItem, Add-PnPListItem,
// Set-PnPListItem, Remove-PnPListItem.
//
// PowerShell hashtable mapping: tools accept a JS object for `values` and convert via
// psHashtable() into a `-Values @{ Title='X'; Field='Y' }` hashtable expression.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { psQuote, psHashtable } from "../util.js";

// CSOM caveat: `FieldValuesAsText` is a `FieldStringValues` proxy — without an explicit
// Get-PnPProperty load it serializes to a near-empty `_ObjectIdentity_/_ObjectType_` blob,
// not the field map you expect. `FieldValues` is a regular Hashtable populated eagerly
// and serializes cleanly — same projection used by pnp_listitem_list/_get.
const ITEM_PROJECTION_HINT =
  " | Select-Object Id, @{N='Fields'; E={ $_.FieldValues }}";

export function registerListItem(server: McpServer) {
  // ============================================================================
  // pnp_listitem_list — list items in a list, with paging + CAML
  // ============================================================================
  server.tool(
    "pnp_listitem_list",
    "List items in a SharePoint list. Supports server-side CAML query, page-size control, folder scoping, and field projection. " +
    "For lists with thousands of items, ALWAYS pass `page_size` (max 5000) and ideally a `caml_query` filter — bringing every row into the LLM context will be wasteful. " +
    "`fields` optionally limits which columns are returned.",
    {
      list: z.string().describe("List title, GUID, or URL"),
      caml_query: z.string().optional().describe(
        "Optional CAML query XML. Example: '<View><Query><Where><Eq><FieldRef Name=\"Status\"/><Value Type=\"Text\">Active</Value></Eq></Where></Query></View>'",
      ),
      page_size: z.number().int().positive().max(5000).optional().describe(
        "Items per page. Required for lists with >5000 items to avoid list view threshold. Recommended: 100-500.",
      ),
      folder_server_relative_url: z.string().optional().describe(
        "Limit to items under this folder (server-relative URL).",
      ),
      fields: z.array(z.string()).optional().describe(
        "Field internal names to return. Defaults to all visible fields.",
      ),
    },
    async ({ list, caml_query, page_size, folder_server_relative_url, fields }): Promise<ToolResult> => {
      const parts = [`Get-PnPListItem -List ${psQuote(list)}`];
      if (caml_query) parts.push(`-Query ${psQuote(caml_query)}`);
      if (page_size !== undefined) parts.push(`-PageSize ${page_size}`);
      if (folder_server_relative_url) parts.push(`-FolderServerRelativeUrl ${psQuote(folder_server_relative_url)}`);
      if (fields && fields.length) {
        const fieldList = fields.map(f => psQuote(f)).join(",");
        parts.push(`-Fields @(${fieldList})`);
      }
      // Project to Id + FieldValues hashtable. FieldValues is a Dictionary; ConvertTo-Json
      // serializes it as a flat object. Items returned this way are MCP-friendly.
      const cmd =
        parts.join(" ") +
        " | Select-Object Id, @{N='Fields'; E={ $_.FieldValues }} " +
        "| ConvertTo-Json -Depth 5 -Compress";
      return runAsTool({
        toolName: "pnp_listitem_list",
        command: cmd,
        timeoutMs: 5 * 60_000,
      });
    },
  );

  // ============================================================================
  // pnp_listitem_get — get a single item by id
  // ============================================================================
  server.tool(
    "pnp_listitem_get",
    "Get a single list item by its integer ID. Returns Id + FieldValues as JSON.",
    {
      list: z.string().describe("List title, GUID, or URL"),
      id: z.number().int().positive(),
      fields: z.array(z.string()).optional().describe("Optional field internal names to return."),
    },
    async ({ list, id, fields }): Promise<ToolResult> => {
      const parts = [`Get-PnPListItem -List ${psQuote(list)} -Id ${id}`];
      if (fields && fields.length) {
        const fieldList = fields.map(f => psQuote(f)).join(",");
        parts.push(`-Fields @(${fieldList})`);
      }
      const cmd =
        parts.join(" ") +
        " | Select-Object Id, @{N='Fields'; E={ $_.FieldValues }} " +
        "| ConvertTo-Json -Depth 5 -Compress";
      return runAsTool({
        toolName: "pnp_listitem_get",
        command: cmd,
        timeoutMs: 30_000,
      });
    },
  );

  // ============================================================================
  // pnp_listitem_add — add a new item with field values
  // ============================================================================
  server.tool(
    "pnp_listitem_add",
    "Add a new item to a list. `values` is a JS object whose keys are field INTERNAL names (not display names). " +
    "Common gotcha: 'Title' is the display name AND internal name for the title field, but for custom fields the internal name is often the SchemaXml name (no spaces). " +
    "Modifies the connected list.",
    {
      list: z.string().describe("List title, GUID, or URL"),
      values: z.record(z.unknown()).describe(
        "Field values as a JS object. Example: { Title: 'My Item', Status: 'Active', AssignedTo: 'user@contoso.com' }. " +
        "User/Group lookup fields take a UPN or claims string. Date fields take an ISO 8601 string. Multi-value fields take an array.",
      ),
      content_type: z.string().optional().describe("Content type name or ID (e.g. 'Document', 'Item', or a custom CT)."),
      folder: z.string().optional().describe("Folder server-relative URL to add the item under."),
      label: z.string().optional().describe("Sensitivity label name."),
    },
    async ({ list, values, content_type, folder, label }): Promise<ToolResult> => {
      const parts = [`Add-PnPListItem -List ${psQuote(list)}`];
      if (Object.keys(values).length) parts.push(`-Values ${psHashtable(values)}`);
      if (content_type) parts.push(`-ContentType ${psQuote(content_type)}`);
      if (folder) parts.push(`-Folder ${psQuote(folder)}`);
      if (label) parts.push(`-Label ${psQuote(label)}`);
      const cmd = parts.join(" ") + ITEM_PROJECTION_HINT + " | ConvertTo-Json -Depth 5 -Compress";
      return runAsTool({
        toolName: "pnp_listitem_add",
        command: cmd,
        timeoutMs: 60_000,
      });
    },
  );

  // ============================================================================
  // pnp_listitem_set — update an existing item
  // ============================================================================
  server.tool(
    "pnp_listitem_set",
    "Update fields on an existing list item by ID. `values` overlays the existing fields.",
    {
      list: z.string().describe("List title, GUID, or URL"),
      id: z.number().int().positive(),
      values: z.record(z.unknown()),
      content_type: z.string().optional(),
      label: z.string().optional(),
      update_type: z.enum(["Update", "SystemUpdate", "UpdateOverwriteVersion"]).optional().describe(
        "Update mode: 'Update' (default, increments version + modifies Author/Modified), 'SystemUpdate' (preserves Author/Modified, increments version), 'UpdateOverwriteVersion' (preserves everything, no new version).",
      ),
    },
    async ({ list, id, values, content_type, label, update_type }): Promise<ToolResult> => {
      const parts = [`Set-PnPListItem -List ${psQuote(list)} -Identity ${id}`];
      if (Object.keys(values).length) parts.push(`-Values ${psHashtable(values)}`);
      if (content_type) parts.push(`-ContentType ${psQuote(content_type)}`);
      if (label) parts.push(`-Label ${psQuote(label)}`);
      if (update_type === "SystemUpdate" || update_type === "UpdateOverwriteVersion") {
        // -UpdateType takes a ListItemUpdateType enum value (Update | SystemUpdate |
        // UpdateOverwriteVersion). Default 'Update' is implicit when the parameter is omitted.
        parts.push(`-UpdateType ${update_type}`);
      }
      const cmd = parts.join(" ") + ITEM_PROJECTION_HINT + " | ConvertTo-Json -Depth 5 -Compress";
      return runAsTool({
        toolName: "pnp_listitem_set",
        command: cmd,
        timeoutMs: 60_000,
      });
    },
  );

  // ============================================================================
  // pnp_listitem_remove — delete an item
  // ============================================================================
  server.tool(
    "pnp_listitem_remove",
    "DESTRUCTIVE: delete a list item by ID. By default sends to recycle bin (recovery within 93 days). Set `recycle: false` for permanent delete.",
    {
      list: z.string().describe("List title, GUID, or URL"),
      id: z.number().int().positive(),
      recycle: z.boolean().default(true),
      confirm: z.boolean(),
    },
    async ({ list, id, recycle, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `BLOCKED: pnp_listitem_remove deletes item id=${id} from list ${list}. Re-call with confirm=true.${recycle ? " (Recycle bin: 93-day recovery.)" : " (PERMANENT delete.)"}`,
          }],
        };
      }
      const parts = [`Remove-PnPListItem -List ${psQuote(list)} -Identity ${id} -Force`];
      if (recycle) parts.push("-Recycle");
      return runAsTool({
        toolName: "pnp_listitem_remove",
        command: parts.join(" "),
        timeoutMs: 60_000,
      });
    },
  );
}
