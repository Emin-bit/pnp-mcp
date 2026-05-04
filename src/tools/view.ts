// SharePoint List View management — Get-PnPView, Add-PnPView, Remove-PnPView.
// Views define which fields/columns are shown when displaying a list, plus filter,
// sort, and aggregation.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { psQuote, psSwitch } from "../util.js";

const VIEW_PROJECTION =
  "Id, Title, ServerRelativeUrl, DefaultView, Hidden, ListViewXml, RowLimit, " +
  "Paged, ViewType, ViewFields, ViewQuery";

export function registerView(server: McpServer) {
  // ============================================================================
  // pnp_view_list — list views on a list
  // ============================================================================
  server.tool(
    "pnp_view_list",
    "List all views defined on a list/library. Returns id, title, default flag, view type, row limit, fields, query.",
    {
      list: z.string().describe("List title, GUID, or URL"),
    },
    async ({ list }): Promise<ToolResult> => {
      const cmd =
        `Get-PnPView -List ${psQuote(list)} ` +
        `| Select-Object ${VIEW_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({
        toolName: "pnp_view_list",
        command: cmd,
        timeoutMs: 30_000,
      });
    },
  );

  // ============================================================================
  // pnp_view_add — create a new view
  // ============================================================================
  server.tool(
    "pnp_view_add",
    "Create a new view on a list/library. Specify the columns (`fields`) shown, optional CAML query for filter/sort/group, and row limit.",
    {
      list: z.string().describe("List title, GUID, or URL"),
      title: z.string(),
      fields: z.array(z.string()).describe("Field internal names to show as columns."),
      query: z.string().optional().describe(
        "CAML <Where>/<OrderBy>/<GroupBy> XML fragment. Example: '<OrderBy><FieldRef Name=\"Modified\" Ascending=\"FALSE\"/></OrderBy>'.",
      ),
      row_limit: z.number().int().positive().optional().describe("Items per page (default 30)."),
      paged: z.boolean().default(true).describe("Use paged display (recommended)."),
      personal: z.boolean().default(false).describe("Personal view (only visible to creator)."),
      set_as_default: z.boolean().default(false),
      view_type: z.enum(["None", "Html", "Grid", "Calendar", "Recurrence", "Chart", "Gantt"]).optional(),
      aggregations: z.string().optional().describe(
        "CAML <Aggregations> XML fragment for sum/average/count totals.",
      ),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) {
        return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_view_add modifies the list configuration. Re-call with confirm=true." }] };
      }
      const fieldList = a.fields.map(f => psQuote(f)).join(",");
      const parts = [
        `Add-PnPView -List ${psQuote(a.list)} -Title ${psQuote(a.title)} -Fields @(${fieldList})`,
      ];
      if (a.query) parts.push(`-Query ${psQuote(a.query)}`);
      if (a.row_limit !== undefined) parts.push(`-RowLimit ${a.row_limit}`);
      if (a.paged) parts.push(psSwitch("Paged", true));
      if (a.personal) parts.push(psSwitch("Personal", true));
      if (a.set_as_default) parts.push(psSwitch("SetAsDefault", true));
      if (a.view_type) parts.push(`-ViewType ${a.view_type}`);
      if (a.aggregations) parts.push(`-Aggregations ${psQuote(a.aggregations)}`);
      const cmd = parts.join(" ") + ` | Select-Object ${VIEW_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_view_add", command: cmd, timeoutMs: 60_000 });
    },
  );

  // ============================================================================
  // pnp_view_remove — delete a view
  // ============================================================================
  server.tool(
    "pnp_view_remove",
    "DESTRUCTIVE: delete a view from a list. Cannot delete the default view (PnP refuses).",
    {
      list: z.string().describe("List title, GUID, or URL"),
      identity: z.string().describe("View title or ID"),
      confirm: z.boolean(),
    },
    async ({ list, identity, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_view_remove deletes a view. Re-call with confirm=true." }] };
      }
      const cmd = `Remove-PnPView -List ${psQuote(list)} -Identity ${psQuote(identity)} -Force`;
      return runAsTool({ toolName: "pnp_view_remove", command: cmd, timeoutMs: 30_000 });
    },
  );
}
