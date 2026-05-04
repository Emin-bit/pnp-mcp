// SharePoint site management tools.
//
// Three categories:
//   • LIST/GET  → wrap Get-PnPTenantSite (admin-scoped) and Get-PnPSite (current connection).
//                 Output projected to a flat shape and serialized with ConvertTo-Json -Depth 5
//                 -Compress so Claude gets structured data instead of PowerShell formatted tables.
//   • CREATE    → wrap New-PnPSite. PnP has THREE parameter sets keyed by `-Type`:
//                   TeamSite                        → -Alias (lowercase, no spaces) + Title + IsPublic + Members + ...
//                   CommunicationSite               → -Url + Title + ...
//                   TeamSiteWithoutMicrosoft365Group → -Url + Title + Owner + ...
//                 We use a `type` discriminator and validate alias-vs-url correctness.
//   • REMOVE    → wrap Remove-PnPTenantSite. Long-running on the SharePoint backend, so we
//                 expose `background: true` for fire-and-forget.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { backgroundResult } from "../jobs.js";
import { psQuote, psParam, psSwitch } from "../util.js";

// Common projection: keep the fields most useful for follow-up tool calls, drop verbose nested objects.
const TENANT_SITE_PROJECTION =
  "Url, Title, Owner, Template, StorageQuota, StorageUsage, Status, " +
  "GroupId, IsHubSite, HubSiteId, SharingCapability, SiteId, Lcid, " +
  "TimeZoneId, SensitivityLabel, AllowSelfServiceUpgrade, LockState";

const SITE_PROJECTION =
  "Url, Id, GroupId, ServerRelativeUrl, SensitivityLabel, ShareByEmailEnabled, " +
  "TrimAuditLog, AllowDesigner, ResourceUsageAverage, MaxItemsPerThrottledOperation";

export function registerSite(server: McpServer) {
  // ============================================================================
  // pnp_site_list — list sites in the tenant
  // ============================================================================
  server.tool(
    "pnp_site_list",
    "List SharePoint Online sites in the tenant via Get-PnPTenantSite. Requires SharePoint admin (or the connected SP needs admin app permissions). " +
    "Returns a JSON array of sites projected to common fields (Url, Title, Owner, Template, StorageQuota/Usage, GroupId, IsHubSite, ...). " +
    "Use `template` to filter by site template (e.g. 'GROUP#0' for M365 Group sites, 'SITEPAGEPUBLISHING#0' for Communication sites, 'STS#3' for modern team sites without group). " +
    "Set `include_onedrive_sites: true` to also include OneDrive personal sites (otherwise excluded). For very large tenants this can return MB of JSON; consider filtering.",
    {
      template: z.string().optional().describe(
        "Site template filter, e.g. 'GROUP#0', 'SITEPAGEPUBLISHING#0', 'STS#3', 'TEAMCHANNEL#1'.",
      ),
      filter: z.string().optional().describe(
        "Server-side OData filter on tenant site properties. Examples: " +
        "\"Url -like 'https://contoso.sharepoint.com/sites/marketing*'\" or \"Owner -eq 'admin@contoso.onmicrosoft.com'\". " +
        "Strongly recommended for tenants with many sites — pulling thousands of sites into a single response can overwhelm the LLM context.",
      ),
      include_onedrive_sites: z.boolean().default(false).describe(
        "Include OneDrive personal sites (default: excluded).",
      ),
      detailed: z.boolean().default(false).describe(
        "Request fully-loaded site details. Slower; only when needed.",
      ),
    },
    async ({ template, filter, include_onedrive_sites, detailed }): Promise<ToolResult> => {
      const cmd =
        `Get-PnPTenantSite ` +
        (template ? `-Template ${psQuote(template)} ` : "") +
        (filter ? `-Filter ${psQuote(filter)} ` : "") +
        (include_onedrive_sites ? "-IncludeOneDriveSites " : "") +
        (detailed ? "-Detailed " : "") +
        `| Select-Object ${TENANT_SITE_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({
        toolName: "pnp_site_list",
        command: cmd,
        timeoutMs: 5 * 60_000,
      });
    },
  );

  // ============================================================================
  // pnp_site_get_by_url — admin lookup of a single tenant site by URL
  // ============================================================================
  server.tool(
    "pnp_site_get_by_url",
    "Look up a single tenant site by URL via Get-PnPTenantSite -Identity. Requires SharePoint admin role. Returns full site properties (StorageQuota, SharingCapability, LockState, etc.) projected to JSON.",
    {
      url: z.string().describe("Full site URL, e.g. 'https://contoso.sharepoint.com/sites/marketing'"),
      detailed: z.boolean().default(true).describe("Include full property bag (default true)."),
    },
    async ({ url, detailed }): Promise<ToolResult> => {
      const cmd =
        `Get-PnPTenantSite -Identity ${psQuote(url)} ${detailed ? "-Detailed" : ""} ` +
        `| Select-Object ${TENANT_SITE_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({
        toolName: "pnp_site_get_by_url",
        command: cmd,
        timeoutMs: 60_000,
      });
    },
  );

  // ============================================================================
  // pnp_site_get — current connection's site
  // ============================================================================
  server.tool(
    "pnp_site_get",
    "Get details of the CURRENT connected site (the one you authenticated against). Wraps Get-PnPSite. Use pnp_site_get_by_url to look up a different site by URL.",
    {},
    async (): Promise<ToolResult> => {
      const cmd =
        `Get-PnPSite | Select-Object ${SITE_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({
        toolName: "pnp_site_get",
        command: cmd,
        timeoutMs: 30_000,
      });
    },
  );

  // ============================================================================
  // pnp_site_new — create a new site (3 site types)
  // ============================================================================
  server.tool(
    "pnp_site_new",
    "Create a new SharePoint Online site via New-PnPSite. THREE site types supported, each with different required parameters:\n" +
    "  • 'TeamSite' (Microsoft 365 Group-connected) → requires `alias` (lowercase, no spaces, used for both URL slug AND group mailNickname)\n" +
    "  • 'CommunicationSite' → requires explicit `url`\n" +
    "  • 'TeamSiteWithoutMicrosoft365Group' → requires explicit `url` AND `owner` (UPN)\n" +
    "DESTRUCTIVE: creates real resources in SharePoint Online (counts against tenant storage). Requires confirm=true. " +
    "Long-running (typically 1-5 min, sometimes longer for TeamSite due to group provisioning). Set background=true for fire-and-forget; track via job_*.",
    {
      type: z.enum(["TeamSite", "CommunicationSite", "TeamSiteWithoutMicrosoft365Group"]),
      title: z.string().describe("Display title for the site"),
      alias: z.string().optional().describe(
        "Required for type='TeamSite'. Lowercase, no spaces. Becomes the URL slug AND M365 Group mailNickname. " +
        "Example: 'marketing-team' → URL becomes /sites/marketing-team",
      ),
      url: z.string().optional().describe(
        "Required for type='CommunicationSite' or 'TeamSiteWithoutMicrosoft365Group'. Full URL including /sites/ or /teams/ prefix.",
      ),
      description: z.string().optional(),
      owner: z.string().optional().describe(
        "Site owner UPN. Required for type='TeamSiteWithoutMicrosoft365Group'. For TeamSite use `members` to add owners.",
      ),
      members: z.array(z.string()).optional().describe(
        "(TeamSite only) UPNs of additional members.",
      ),
      is_public: z.boolean().optional().describe("(TeamSite only) Public group (default: private)."),
      hub_site_id: z.string().optional().describe("Optional Hub Site GUID to associate with on creation."),
      sensitivity_label: z.string().optional().describe("Sensitivity label name or GUID."),
      time_zone: z.number().int().optional().describe(
        "TimeZone enum value (e.g. 4=PacificTime, 13=CentralEurope). See PnP docs.",
      ),
      // NOTE: -Lcid on PnP 3.x's New-PnPSite is typed as SwitchParameter, not [int],
      // so a locale value can't actually be passed via this cmdlet at create time.
      // To set a non-default locale, create the site first and then use Set-PnPWeb -Locale <int>.
      // We therefore deliberately do NOT expose a `lcid` parameter here — exposing it would
      // be misleading (the LLM would think it can set locale at create, but the value would
      // be silently dropped due to PnP's parameter typing).
      preferred_data_location: z.string().optional().describe("Multi-geo data location code (e.g. 'EUR', 'NAM')."),
      owners: z.array(z.string()).optional().describe(
        "(TeamSite only) UPNs of owners (full access on the site AND owner permissions on the M365 Group). Use this for app-only auth where you need to set owners explicitly.",
      ),
      wait: z.boolean().default(true).describe(
        "Wait for provisioning to complete before returning (default true). Set false for fast-return semantics.",
      ),
      background: z.boolean().default(false).describe(
        "Fire-and-forget: returns a job id immediately. Useful for sites that take many minutes to provision.",
      ),
      confirm: z.boolean().describe("Must be true (creates real SharePoint resources)."),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `BLOCKED: pnp_site_new creates a real SharePoint Online site (counts against tenant storage and licensing). Re-call with confirm=true after pnp_session_status confirms the target tenant.`,
          }],
        };
      }
      // Cross-validation per type
      // Required-fields check
      if (a.type === "TeamSite" && !a.alias) {
        return { isError: true, content: [{ type: "text", text: "type='TeamSite' requires `alias` (lowercase, no spaces). Use pnp_site_new with both type and alias set." }] };
      }
      if ((a.type === "CommunicationSite" || a.type === "TeamSiteWithoutMicrosoft365Group") && !a.url) {
        return { isError: true, content: [{ type: "text", text: `type='${a.type}' requires \`url\`. Provide a full SharePoint URL including /sites/ or /teams/ prefix.` }] };
      }
      if (a.type === "TeamSiteWithoutMicrosoft365Group" && !a.owner) {
        return { isError: true, content: [{ type: "text", text: "type='TeamSiteWithoutMicrosoft365Group' requires `owner` (a UPN)." }] };
      }
      // Reject MUTUALLY EXCLUSIVE field combinations to avoid silent surprise — agent
      // review I5: e.g. type='TeamSite' with `url` would silently ignore url and create
      // the site at an alias-derived URL, which is confusing.
      if (a.type === "TeamSite" && a.url) {
        return { isError: true, content: [{ type: "text", text: "type='TeamSite' uses `alias` (which determines URL); do NOT pass `url` — it would be silently ignored. If you need a specific URL, use type='TeamSiteWithoutMicrosoft365Group' or 'CommunicationSite' instead." }] };
      }
      if (a.type === "TeamSite" && a.owner) {
        return { isError: true, content: [{ type: "text", text: "type='TeamSite' uses `owners` (array, group-bound), not `owner` (single, site-bound). Pass owners=['upn1','upn2',...] instead." }] };
      }
      if ((a.type === "CommunicationSite" || a.type === "TeamSiteWithoutMicrosoft365Group") && a.alias) {
        return { isError: true, content: [{ type: "text", text: `type='${a.type}' uses \`url\`, not \`alias\`. \`alias\` is only valid for type='TeamSite'.` }] };
      }
      if ((a.type === "CommunicationSite" || a.type === "TeamSiteWithoutMicrosoft365Group") && (a.members || a.owners || a.is_public !== undefined)) {
        return { isError: true, content: [{ type: "text", text: `type='${a.type}' does NOT have a Microsoft 365 Group, so \`members\`, \`owners\`, and \`is_public\` are not applicable. Use \`owner\` (single UPN) instead.` }] };
      }

      const parts: string[] = [
        `New-PnPSite -Type ${a.type} -Title ${psQuote(a.title)}`,
      ];
      if (a.type === "TeamSite") {
        parts.push(`-Alias ${psQuote(a.alias!)}`);
        if (a.is_public !== undefined) parts.push(psSwitch("IsPublic", a.is_public));
        if (a.owners && a.owners.length) {
          const list = a.owners.map(o => psQuote(o)).join(",");
          parts.push(`-Owners @(${list})`);
        }
        if (a.members && a.members.length) {
          // -Members on New-PnPSite TeamSite is application-permission only per PnP docs.
          // We pass it through; if user is on delegated auth, PnP returns a clear error.
          const list = a.members.map(m => psQuote(m)).join(",");
          parts.push(`-Members @(${list})`);
        }
      } else {
        parts.push(`-Url ${psQuote(a.url!)}`);
        if (a.owner) parts.push(`-Owner ${psQuote(a.owner)}`);
      }
      if (a.description) parts.push(psParam("Description", a.description));
      if (a.hub_site_id) parts.push(`-HubSiteId ${psQuote(a.hub_site_id)}`);
      if (a.sensitivity_label) parts.push(psParam("SensitivityLabel", a.sensitivity_label));
      if (a.time_zone !== undefined) parts.push(`-TimeZone ${a.time_zone}`);
      // NOTE: -Lcid intentionally not emitted — see comment near `lcid` removal in schema.
      if (a.preferred_data_location) parts.push(psParam("PreferredDataLocation", a.preferred_data_location));
      if (a.wait) parts.push(psSwitch("Wait", true));

      // Output: pipe to JSON for follow-up. New-PnPSite returns the new URL string typically.
      const cmd = parts.join(" ") + " | ConvertTo-Json -Depth 5 -Compress";

      if (a.background) {
        return backgroundResult("pnp_site_new", cmd);
      }
      return runAsTool({
        toolName: "pnp_site_new",
        command: cmd,
        // Provisioning can take many minutes for TeamSite (M365 Group + SharePoint backend).
        // 15 min synchronous timeout; for longer use background:true.
        timeoutMs: 15 * 60_000,
        hint: a.wait
          ? "Site URL returned. New site may take a minute or two to be fully reachable in browser even after this returns."
          : "wait=false → site creation submitted, may not be ready immediately. Poll pnp_site_get_by_url to check.",
      });
    },
  );

  // ============================================================================
  // pnp_site_remove — remove a tenant site
  // ============================================================================
  server.tool(
    "pnp_site_remove",
    "Remove a SharePoint Online site via Remove-PnPTenantSite. DESTRUCTIVE: site goes to recycle bin (or is permanently deleted if `skip_recycle_bin=true`). Requires confirm=true. " +
    "Removing a Microsoft 365 Group-connected site (TeamSite) ALSO triggers group + Teams team deletion — verify carefully. " +
    "Long-running on backend; set background=true if you don't need to wait.",
    {
      url: z.string().describe("Full site URL"),
      skip_recycle_bin: z.boolean().default(false).describe("PERMANENT delete — bypasses 93-day recycle bin retention."),
      from_recycle_bin: z.boolean().default(false).describe(
        "Use this to remove an already-recycle-binned site (permanent purge). Mutually exclusive with skip_recycle_bin.",
      ),
      background: z.boolean().default(false),
      confirm: z.boolean(),
    },
    async ({ url, skip_recycle_bin, from_recycle_bin, background, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `BLOCKED: pnp_site_remove deletes a SharePoint site${skip_recycle_bin ? " PERMANENTLY (no recycle bin)" : " (to recycle bin, 93-day retention)"}. ` +
              `Re-call with confirm=true. Run pnp_session_status first to verify the active tenant.`,
          }],
        };
      }
      if (skip_recycle_bin && from_recycle_bin) {
        return {
          isError: true,
          content: [{ type: "text", text: "skip_recycle_bin and from_recycle_bin are mutually exclusive. Use one or the other." }],
        };
      }
      const parts: string[] = [
        `Remove-PnPTenantSite -Url ${psQuote(url)} -Force`,
      ];
      if (skip_recycle_bin) parts.push("-SkipRecycleBin");
      if (from_recycle_bin) parts.push("-FromRecycleBin");
      const cmd = parts.join(" ");

      if (background) return backgroundResult("pnp_site_remove", cmd);
      return runAsTool({
        toolName: "pnp_site_remove",
        command: cmd,
        timeoutMs: 10 * 60_000,
      });
    },
  );
}
