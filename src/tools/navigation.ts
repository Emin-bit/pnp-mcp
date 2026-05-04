// Navigation nodes — Get/Add/Remove-PnPNavigationNode.
//
// Two main locations: TopNavigationBar (top horizontal nav) and QuickLaunch (left vertical nav).
// Modern team sites also support `SearchNav` and `Footer` (verified in PnP 3.1).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { psQuote } from "../util.js";

const NAV_PROJECTION = "Id, Title, Url, IsExternal, IsVisible, ParentId, Children, AudienceIds";

// PnP 3.x NavigationType enum values.
// @verify-enum [PnP.Framework.Enums.NavigationType]
const NavigationLocation = z.enum([
  "TopNavigationBar", // top horizontal nav
  "QuickLaunch",      // left vertical nav (modern + classic)
  "SearchNav",        // modern site search nav
  "Footer",           // modern site footer
]);

export function registerNavigation(server: McpServer) {
  // ============================================================================
  // pnp_navigation_list — list navigation nodes
  // ============================================================================
  server.tool(
    "pnp_navigation_list",
    "List navigation nodes at the specified location. Use `tree: true` to include children inline.",
    {
      location: NavigationLocation.describe("Which navigation surface to list"),
      tree: z.boolean().default(false).describe("Include nested children in the response"),
    },
    async ({ location, tree }): Promise<ToolResult> => {
      const parts = [`Get-PnPNavigationNode -Location ${location}`];
      if (tree) parts.push("-Tree");
      const cmd = parts.join(" ") + ` | Select-Object ${NAV_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_navigation_list", command: cmd, timeoutMs: 30_000 });
    },
  );

  // ============================================================================
  // pnp_navigation_add — add a navigation node
  // ============================================================================
  server.tool(
    "pnp_navigation_add",
    "Add a node to the specified navigation surface. Use `parent_id` to nest under another node, `first: true` to insert at top, `external: true` for external links (with `open_in_new_tab: true` to open in a new browser tab).",
    {
      title: z.string(),
      url: z.string().optional().describe("Target URL (omit for a header-only node)"),
      location: NavigationLocation,
      parent_id: z.number().int().optional().describe("Parent node ID for nesting"),
      first: z.boolean().default(false).describe("Insert at the top instead of appending"),
      external: z.boolean().default(false).describe("Mark as external link"),
      open_in_new_tab: z.boolean().default(false).describe("(External) Open link in new tab"),
      audience_ids: z.array(z.string()).optional().describe(
        "Entra group GUIDs for audience targeting — only members of these groups will see the node.",
      ),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_navigation_add modifies site navigation. Re-call with confirm=true." }] };
      const parts = [`Add-PnPNavigationNode -Title ${psQuote(a.title)} -Location ${a.location}`];
      if (a.url) parts.push(`-Url ${psQuote(a.url)}`);
      if (a.parent_id !== undefined) parts.push(`-Parent ${a.parent_id}`);
      if (a.first) parts.push("-First");
      if (a.external) parts.push("-External");
      if (a.open_in_new_tab) parts.push("-OpenInNewTab");
      if (a.audience_ids && a.audience_ids.length) {
        const list = a.audience_ids.map(g => psQuote(g)).join(",");
        parts.push(`-AudienceIds @(${list})`);
      }
      const cmd = parts.join(" ") + ` | Select-Object ${NAV_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_navigation_add", command: cmd, timeoutMs: 60_000 });
    },
  );

  // ============================================================================
  // pnp_navigation_remove — remove a node, by ID or by location+title, or all
  // ============================================================================
  server.tool(
    "pnp_navigation_remove",
    "DESTRUCTIVE: remove navigation nodes. Three modes (mutually exclusive):\n" +
    "  • by `identity`: a single node ID\n" +
    "  • by `location` + `title`: removes the matching node at that location\n" +
    "  • by `all: true` + `location`: removes ALL nodes at the given location (uses the Get | Remove pipeline — REQUIRES `location` to scope the deletion).",
    {
      identity: z.number().int().optional().describe("Node ID — exclusive with location+title or all+location"),
      location: NavigationLocation.optional(),
      title: z.string().optional(),
      header: z.string().optional().describe("Optional header filter when removing by title"),
      all: z.boolean().default(false).describe("Remove ALL nodes at the given location. MUST be combined with `location` — bare `all` without `location` is rejected to prevent accidentally nuking every nav surface."),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_navigation_remove deletes navigation nodes. Re-call with confirm=true." }] };
      // Reject `all` without `location`. The PnP cmdlet's `-All` parameter set has no
      // -Location parameter, meaning bare `Remove-PnPNavigationNode -All` deletes nodes
      // from EVERY navigation surface (TopNav + QuickLaunch + SearchNav + Footer). That
      // is almost never the user's intent, so we force them to scope it.
      if (a.all && !a.location) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "REJECTED: `all: true` requires `location` to scope the deletion. Bare `-All` on Remove-PnPNavigationNode wipes nodes from EVERY nav surface (Top, QuickLaunch, SearchNav, Footer). If that is truly your intent, call this tool four times with `all: true, location: <each>`.",
          }],
        };
      }
      // `all + title` is incoherent — `all` removes every node at the location, so a title
      // filter is meaningless. Reject explicitly instead of silently ignoring the title.
      if (a.all && a.title) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "REJECTED: cannot combine `all: true` with `title`. `all` removes every node at the given location — a title filter is incoherent. Use either (a) `all: true` + `location` to bulk-delete a surface, or (b) `location` + `title` to delete one node.",
          }],
        };
      }
      const modes = [
        a.identity !== undefined,
        !!(a.location && a.title && !a.all),
        !!(a.all && a.location),
      ].filter(Boolean).length;
      if (modes !== 1) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "Pass EXACTLY ONE of: (a) identity, (b) location+title, or (c) all+location. The three remove modes are mutually exclusive.",
          }],
        };
      }
      let cmd: string;
      if (a.identity !== undefined) {
        cmd = `Remove-PnPNavigationNode -Identity ${a.identity} -Force`;
      } else if (a.all && a.location) {
        // Use the pipeline form (Example 5 in `Get-Help Remove-PnPNavigationNode`) so we
        // only delete nodes at the requested location, not the cmdlet's bare `-All` which
        // affects every nav surface.
        cmd = `Get-PnPNavigationNode -Location ${a.location} | Remove-PnPNavigationNode -Force`;
      } else if (a.location && a.title) {
        const parts = [`Remove-PnPNavigationNode -Location ${a.location} -Title ${psQuote(a.title)} -Force`];
        if (a.header) parts.push(`-Header ${psQuote(a.header)}`);
        cmd = parts.join(" ");
      } else {
        return { isError: true, content: [{ type: "text", text: "Internal error: no remove mode resolved." }] };
      }
      return runAsTool({ toolName: "pnp_navigation_remove", command: cmd, timeoutMs: 60_000 });
    },
  );
}
