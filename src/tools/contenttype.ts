// Content Type management — Get/Add/Set/Remove-PnPContentType.
//
// Content types in SharePoint can live at the SITE level (site columns + CT inheritance)
// or at the LIST level (a list-scoped CT, optionally based on a site CT). Most tools
// support BOTH scopes via the `list` parameter — pass it for list-scoped operations,
// omit for site-scoped.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { psQuote } from "../util.js";

const CT_PROJECTION =
  "Id, Name, Group, Description, ReadOnly, Sealed, Hidden, NewFormUrl, EditFormUrl, " +
  "DisplayFormUrl, DocumentTemplate, DocumentTemplateUrl, JSLink, MobileNewFormUrl, " +
  "MobileEditFormUrl, MobileDisplayFormUrl, SchemaXml";

export function registerContentType(server: McpServer) {
  server.tool(
    "pnp_contenttype_list",
    "List content types at the site or list level. Without `list`, returns site content types. " +
    "With `list`, returns content types scoped to that list. Use `in_site_hierarchy: true` to include CTs from parent webs.",
    {
      list: z.string().optional().describe("List title/GUID/URL — scope to this list's CTs"),
      group: z.string().optional().describe("Filter to CTs in a specific group (e.g. 'Document Content Types')"),
      in_site_hierarchy: z.boolean().default(false).describe("Include CTs from parent webs in the result"),
    },
    async ({ list, group, in_site_hierarchy }): Promise<ToolResult> => {
      const parts = ["Get-PnPContentType"];
      if (list) parts.push(`-List ${psQuote(list)}`);
      if (group) parts.push(`-Group ${psQuote(group)}`);
      if (in_site_hierarchy) parts.push("-InSiteHierarchy");
      const cmd = parts.join(" ") + ` | Select-Object ${CT_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_contenttype_list", command: cmd, timeoutMs: 60_000 });
    },
  );

  server.tool(
    "pnp_contenttype_get",
    "Get one content type by name or ID, optionally scoped to a list.",
    {
      identity: z.string().describe("Content type name or ID"),
      list: z.string().optional(),
    },
    async ({ identity, list }): Promise<ToolResult> => {
      const parts = [`Get-PnPContentType -Identity ${psQuote(identity)}`];
      if (list) parts.push(`-List ${psQuote(list)}`);
      const cmd = parts.join(" ") + ` | Select-Object ${CT_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_contenttype_get", command: cmd, timeoutMs: 30_000 });
    },
  );

  server.tool(
    "pnp_contenttype_add",
    "Create a new SITE-level content type. Add-PnPContentType works at site scope only — to attach a CT to a list, use pnp_run with Add-PnPContentTypeToList. Requires confirm=true.",
    {
      name: z.string(),
      content_type_id: z.string().optional().describe(
        "Optional explicit CT ID (e.g. '0x0101009...'). If omitted, derived from ParentContentType.",
      ),
      parent_content_type: z.string().optional().describe(
        "Parent CT name or ID (e.g. 'Document', 'Item'). Establishes inheritance.",
      ),
      group: z.string().optional().describe("CT group for grouping in the UI."),
      description: z.string().optional(),
      document_template: z.string().optional().describe(
        "Path to a document template file (only for document CTs).",
      ),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_contenttype_add modifies the site schema. Re-call with confirm=true." }] };
      const parts = [`Add-PnPContentType -Name ${psQuote(a.name)}`];
      if (a.content_type_id) parts.push(`-ContentTypeId ${psQuote(a.content_type_id)}`);
      if (a.parent_content_type) parts.push(`-ParentContentType (Get-PnPContentType -Identity ${psQuote(a.parent_content_type)})`);
      if (a.group) parts.push(`-Group ${psQuote(a.group)}`);
      if (a.description) parts.push(`-Description ${psQuote(a.description)}`);
      if (a.document_template) parts.push(`-DocumentTemplate ${psQuote(a.document_template)}`);
      const cmd = parts.join(" ") + ` | Select-Object ${CT_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_contenttype_add", command: cmd, timeoutMs: 60_000 });
    },
  );

  server.tool(
    "pnp_contenttype_set",
    "Update properties on an existing content type. Use `update_children: true` to push changes down to inheriting CTs (slower but propagates).",
    {
      identity: z.string().describe("CT name or ID"),
      list: z.string().optional().describe("Scope to a list (omit for site-level CT)"),
      name: z.string().optional(),
      description: z.string().optional(),
      group: z.string().optional(),
      hidden: z.boolean().optional(),
      read_only: z.boolean().optional(),
      sealed: z.boolean().optional().describe("Sealed CTs cannot be modified by users."),
      update_children: z.boolean().default(false).describe("Push changes to inheriting child CTs."),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_contenttype_set modifies site schema. Re-call with confirm=true." }] };
      const parts = [`Set-PnPContentType -Identity ${psQuote(a.identity)}`];
      if (a.list) parts.push(`-List ${psQuote(a.list)}`);
      if (a.name) parts.push(`-Name ${psQuote(a.name)}`);
      if (a.description) parts.push(`-Description ${psQuote(a.description)}`);
      if (a.group) parts.push(`-Group ${psQuote(a.group)}`);
      if (a.hidden !== undefined) parts.push(`-Hidden:$${a.hidden}`);
      if (a.read_only !== undefined) parts.push(`-ReadOnly:$${a.read_only}`);
      if (a.sealed !== undefined) parts.push(`-Sealed:$${a.sealed}`);
      if (a.update_children) parts.push("-UpdateChildren");
      if (parts.length === 1) {
        return { isError: true, content: [{ type: "text", text: "No properties provided. Pass at least one (name, description, group, hidden, read_only, sealed)." }] };
      }
      const cmd =
        `try { ${parts.join(" ")} -ErrorAction Stop; ` +
        `Get-PnPContentType -Identity ${psQuote(a.identity)} | Select-Object ${CT_PROJECTION} | ConvertTo-Json -Depth 5 -Compress } ` +
        `catch { Write-Output ('ERROR: Set-PnPContentType failed: ' + $_.Exception.Message); throw }`;
      return runAsTool({ toolName: "pnp_contenttype_set", command: cmd, timeoutMs: 5 * 60_000 });
    },
  );

  server.tool(
    "pnp_contenttype_remove",
    "DESTRUCTIVE: delete a content type. May fail if items are still using it; resolve usages first.",
    {
      identity: z.string().describe("CT name or ID"),
      confirm: z.boolean(),
    },
    async ({ identity, confirm }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_contenttype_remove deletes a content type. Re-call with confirm=true." }] };
      const cmd = `Remove-PnPContentType -Identity ${psQuote(identity)} -Force`;
      return runAsTool({ toolName: "pnp_contenttype_remove", command: cmd, timeoutMs: 60_000 });
    },
  );
}
