// SharePoint Web (sub-site) management tools.
//
// In SharePoint terminology, a "Web" is what most people call a sub-site — a child
// container under a Site Collection. The site collection itself is also a Web (the root
// web). These tools manage Webs within the currently connected site collection — they
// do NOT operate at the tenant level (that's pnp_site_*).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { psQuote, psParam, psSwitch } from "../util.js";

const WEB_PROJECTION =
  "Url, Id, ServerRelativeUrl, Title, Description, WebTemplate, " +
  "Configuration, Created, LastItemModifiedDate, Language, Locale, " +
  "MasterUrl, NavAudienceTargetingEnabled, RequestAccessEmail";

export function registerWeb(server: McpServer) {
  // ============================================================================
  // pnp_web_get — get the current (or a specific sub-) web
  // ============================================================================
  server.tool(
    "pnp_web_get",
    "Get details of a Web (root web of the connected site collection, or a specific sub-web by URL). Wraps Get-PnPWeb. Returns JSON projection.",
    {
      identity: z.string().optional().describe(
        "Sub-web URL or ID (omit for the root web of the current connection)",
      ),
    },
    async ({ identity }): Promise<ToolResult> => {
      const cmd =
        `Get-PnPWeb ${identity ? `-Identity ${psQuote(identity)}` : ""} ` +
        `| Select-Object ${WEB_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({
        toolName: "pnp_web_get",
        command: cmd,
        timeoutMs: 30_000,
      });
    },
  );

  // ============================================================================
  // pnp_web_list — list sub-webs (sub-sites)
  // ============================================================================
  server.tool(
    "pnp_web_list",
    "List sub-webs (sub-sites) under the connected site collection's root web. Wraps Get-PnPSubWeb. Set `recurse=true` to include all descendants (not just direct children).",
    {
      recurse: z.boolean().default(false).describe("Include all descendant webs, not just direct children."),
      include_root: z.boolean().default(false).describe("Include the root web in the result."),
    },
    async ({ recurse, include_root }): Promise<ToolResult> => {
      const cmd =
        `Get-PnPSubWeb ${recurse ? "-Recurse" : ""} ${include_root ? "-IncludeRootWeb" : ""} ` +
        `| Select-Object ${WEB_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({
        toolName: "pnp_web_list",
        command: cmd,
        timeoutMs: 60_000,
      });
    },
  );

  // ============================================================================
  // pnp_web_new — create a new sub-web
  // ============================================================================
  server.tool(
    "pnp_web_new",
    "Create a new sub-web under the connected site collection. Wraps New-PnPWeb. Sub-web is a sub-SITE (e.g. /sites/marketing/projects). " +
    "Common templates: 'STS#3' (modern team), 'STS#0' (classic team), 'BLANKINTERNETCONTAINER#0' (publishing). " +
    "Requires confirm=true. Modifies the connected site.",
    {
      url: z.string().describe("Sub-web URL slug RELATIVE to the site collection root (e.g. 'projects' creates /sites/parent/projects)"),
      title: z.string().describe("Display title"),
      template: z.string().describe("Web template (e.g. 'STS#3' for modern team site)"),
      description: z.string().optional(),
      locale: z.number().int().optional().describe("Locale ID (1033=en-US, 1031=de-DE, ...)"),
      break_inheritance: z.boolean().default(false).describe(
        "Break permission inheritance from parent web. Default false (inherit).",
      ),
      inherit_navigation: z.boolean().default(true).describe(
        "Use parent web's navigation (default true).",
      ),
      confirm: z.boolean(),
    },
    async ({ url, title, template, description, locale, break_inheritance, inherit_navigation, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "BLOCKED: pnp_web_new creates a sub-web in the live site. Re-call with confirm=true.",
          }],
        };
      }
      const parts: string[] = [
        `New-PnPWeb -Url ${psQuote(url)} -Title ${psQuote(title)} -Template ${psQuote(template)}`,
      ];
      if (description) parts.push(psParam("Description", description));
      if (locale !== undefined) parts.push(`-Locale ${locale}`);
      if (break_inheritance) parts.push(psSwitch("BreakInheritance", true));
      if (!inherit_navigation) parts.push("-InheritNavigation:$false");
      const cmd = parts.join(" ") + ` | Select-Object ${WEB_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({
        toolName: "pnp_web_new",
        command: cmd,
        timeoutMs: 5 * 60_000,
      });
    },
  );

  // ============================================================================
  // pnp_web_remove — delete a sub-web
  // ============================================================================
  server.tool(
    "pnp_web_remove",
    "DESTRUCTIVE: delete a sub-web (sub-site) and all its content. Wraps Remove-PnPWeb. Requires confirm=true. " +
    "⚠️ This tool will REFUSE to delete the root web of the connected site collection — that would partially destroy the site collection in unpredictable ways. To delete the entire site collection, use pnp_site_remove instead.",
    {
      identity: z.string().describe("Sub-web URL or ID (must NOT be the root web of the connected site collection)"),
      confirm: z.boolean(),
    },
    async ({ identity, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "BLOCKED: pnp_web_remove deletes a sub-web AND its lists/libraries/items. Re-call with confirm=true. Use pnp_session_status to verify the active site collection first.",
          }],
        };
      }
      // Pre-check: refuse if the requested identity is the connected site collection's root web URL.
      // We compute the root URL inside pwsh and bail early before running Remove-PnPWeb.
      // Case-insensitive comparison; trailing slashes normalized.
      const cmd =
        `$target = ${psQuote(identity)}; ` +
        `$rootUrl = (Get-PnPWeb).Url; ` +
        `$normalize = { param($u) ($u -replace '/+$', '').ToLowerInvariant() }; ` +
        `if ((& $normalize $target) -eq (& $normalize $rootUrl)) { ` +
          `Write-Output 'BLOCKED: refusing to delete the ROOT web of this site collection (would corrupt the site collection). To delete the entire site collection, use pnp_site_remove with the same URL and confirm=true.'; ` +
          `return ` +
        `} ` +
        `Remove-PnPWeb -Identity $target -Force`;
      return runAsTool({
        toolName: "pnp_web_remove",
        command: cmd,
        timeoutMs: 5 * 60_000,
      });
    },
  );
}
