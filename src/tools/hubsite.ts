// Hub Sites — Get-PnPHubSite, Register-PnPHubSite (promote site to hub),
// Set-PnPHubSite, Add-PnPHubSiteAssociation, Remove-PnPHubSiteAssociation.
//
// Hub sites are tenant-level entities that organize related sites into navigation
// + search families. Registering a site as a hub gives it a hub site ID that other
// sites can join via Add-PnPHubSiteAssociation.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { psQuote } from "../util.js";

const HUB_PROJECTION =
  "ID, SiteId, Title, SiteUrl, LogoUrl, Description, Targets, " +
  "RequiresJoinApproval, ParentHubSiteId, HideNameInNavigation, EnablePermissionsSync, SiteDesignId";

export function registerHubSite(server: McpServer) {
  // ============================================================================
  // pnp_hubsite_list — list all hub sites in the tenant
  // ============================================================================
  server.tool(
    "pnp_hubsite_list",
    "List all hub sites in the tenant. Returns id, title, URL, logo, description, optional parent hub for hub-of-hubs hierarchy. Requires SharePoint admin permissions.",
    {
      identity: z.string().optional().describe("Optional: filter to a specific hub by ID, title, or URL"),
    },
    async ({ identity }): Promise<ToolResult> => {
      const parts = ["Get-PnPHubSite"];
      if (identity) parts.push(`-Identity ${psQuote(identity)}`);
      const cmd = parts.join(" ") + ` | Select-Object ${HUB_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_hubsite_list", command: cmd, timeoutMs: 60_000 });
    },
  );

  // ============================================================================
  // pnp_hubsite_register — promote an existing site to a hub site
  // ============================================================================
  server.tool(
    "pnp_hubsite_register",
    "Promote an existing site to a hub site. Optional `principals` array narrows who can associate child sites to this hub (defaults to anyone with site-creation permission). " +
    "Tenant-wide change, counts against the tenant hub-site quota (default 50). Requires SharePoint admin role.",
    {
      site: z.string().describe("Site URL to promote to a hub"),
      principals: z.array(z.string()).optional().describe(
        "Optional. Users/groups (UPN or login name) allowed to associate sites with this hub. Example: ['admin@contoso.onmicrosoft.com']. Omit to allow anyone with site-creation permission.",
      ),
      confirm: z.boolean(),
    },
    async ({ site, principals, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "BLOCKED: pnp_hubsite_register changes tenant-level hub-site routing. Re-call with confirm=true after pnp_session_status verifies the target tenant.",
          }],
        };
      }
      const parts = [`Register-PnPHubSite -Site ${psQuote(site)}`];
      if (principals && principals.length) {
        const principalList = principals.map(p => psQuote(p)).join(",");
        parts.push(`-Principals @(${principalList})`);
      }
      const cmd = parts.join(" ") + ` | Select-Object ${HUB_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_hubsite_register", command: cmd, timeoutMs: 2 * 60_000 });
    },
  );

  // ============================================================================
  // pnp_hubsite_set — update hub site properties
  // ============================================================================
  server.tool(
    "pnp_hubsite_set",
    "Update properties on a hub site (title, description, logo URL, parent hub for hierarchy, join approval requirement, permissions sync, site design).",
    {
      identity: z.string().describe("Hub site ID, title, or URL"),
      title: z.string().optional(),
      description: z.string().optional(),
      logo_url: z.string().optional(),
      parent_hub_site_id: z.string().optional().describe("GUID of a parent hub site (for nested hub hierarchies)"),
      site_design_id: z.string().optional().describe("Optional GUID of a site design to apply to associated sites"),
      requires_join_approval: z.boolean().optional().describe("Switch — pass true to require join approval, false to remove the requirement."),
      hide_name_in_navigation: z.boolean().optional().describe("Switch — pass true to hide hub name in nav, false to show it."),
      enable_permissions_sync: z.boolean().optional().describe(
        "Switch — pass true to sync hub-level permissions to associated sites, false to stop syncing.",
      ),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_hubsite_set modifies hub-site configuration. Re-call with confirm=true." }] };
      const parts = [`Set-PnPHubSite -Identity ${psQuote(a.identity)}`];
      if (a.title) parts.push(`-Title ${psQuote(a.title)}`);
      if (a.description) parts.push(`-Description ${psQuote(a.description)}`);
      if (a.logo_url) parts.push(`-LogoUrl ${psQuote(a.logo_url)}`);
      if (a.parent_hub_site_id) parts.push(`-ParentHubSiteId ${psQuote(a.parent_hub_site_id)}`);
      if (a.site_design_id) parts.push(`-SiteDesignId ${psQuote(a.site_design_id)}`);
      // Switch params — emit `:$true` / `:$false` so callers can both enable AND disable each toggle.
      if (a.requires_join_approval !== undefined) parts.push(`-RequiresJoinApproval:$${a.requires_join_approval}`);
      if (a.hide_name_in_navigation !== undefined) parts.push(`-HideNameInNavigation:$${a.hide_name_in_navigation}`);
      if (a.enable_permissions_sync !== undefined) parts.push(`-EnablePermissionsSync:$${a.enable_permissions_sync}`);
      if (parts.length === 1) {
        return { isError: true, content: [{ type: "text", text: "No properties provided to update." }] };
      }
      const cmd =
        `try { ${parts.join(" ")} -ErrorAction Stop; ` +
        `Get-PnPHubSite -Identity ${psQuote(a.identity)} | Select-Object ${HUB_PROJECTION} | ConvertTo-Json -Depth 5 -Compress } ` +
        `catch { Write-Output ('ERROR: Set-PnPHubSite failed: ' + $_.Exception.Message); throw }`;
      return runAsTool({ toolName: "pnp_hubsite_set", command: cmd, timeoutMs: 2 * 60_000 });
    },
  );

  // ============================================================================
  // pnp_hubsite_associate — join a site to a hub
  // ============================================================================
  server.tool(
    "pnp_hubsite_associate",
    "Associate (join) a site with a hub site — the site joins the hub's navigation, search scope, and inherits its theme. " +
    "Re-running with a different hub re-points the site (a site can only be associated with ONE hub at a time).",
    {
      site: z.string().describe("Site URL to associate"),
      hub_site: z.string().describe("Hub site URL to join"),
      confirm: z.boolean(),
    },
    async ({ site, hub_site, confirm }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_hubsite_associate changes site routing. Re-call with confirm=true." }] };
      const cmd = `Add-PnPHubSiteAssociation -Site ${psQuote(site)} -HubSite ${psQuote(hub_site)}`;
      return runAsTool({ toolName: "pnp_hubsite_associate", command: cmd, timeoutMs: 60_000 });
    },
  );

  // ============================================================================
  // pnp_hubsite_disassociate — remove a site from its hub
  // ============================================================================
  server.tool(
    "pnp_hubsite_disassociate",
    "Disassociate a site from its hub — site leaves hub navigation/search/theme. Idempotent (no-op if site has no hub).",
    {
      site: z.string(),
      confirm: z.boolean(),
    },
    async ({ site, confirm }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_hubsite_disassociate changes site routing. Re-call with confirm=true." }] };
      const cmd = `Remove-PnPHubSiteAssociation -Site ${psQuote(site)}`;
      return runAsTool({ toolName: "pnp_hubsite_disassociate", command: cmd, timeoutMs: 60_000 });
    },
  );
}
