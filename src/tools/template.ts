// PnP Provisioning Engine — Get-PnPSiteTemplate (extract) and Invoke-PnPSiteTemplate
// (apply). These are PnP's killer feature for SharePoint-as-code: capture a site as
// a portable XML template, version-control it, then apply to other sites.
//
// Both operations can run for many minutes on real sites — pnp_template_apply defaults
// to background:true because applying a template SYNCHRONOUSLY would almost always
// exceed Claude Desktop's MCP transport timeout.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { backgroundResult } from "../jobs.js";
import { psQuote, psHashtable } from "../util.js";

// PnP Handlers enum, verified against `[System.Enum]::GetNames([PnP.Framework.Provisioning.Model.Handlers])`
// on PnP.PowerShell 3.1. Removed in 3.x: AzureActiveDirectory, PrivacyConfiguration.
// Added in 3.x: SiteSettings, SyntexModels, None.
// @verify-enum [PnP.Framework.Provisioning.Model.Handlers]
const HANDLERS = z.array(z.enum([
  "All",
  "None",
  "ApplicationLifecycleManagement",
  "AuditSettings",
  "ComposedLook",
  "ContentTypes",
  "CustomActions",
  "ExtensibilityProviders",
  "Features",
  "Fields",
  "Files",
  "ImageRenditions",
  "Lists",
  "Navigation",
  "PageContents",
  "Pages",
  "PropertyBagEntries",
  "Publishing",
  "RegionalSettings",
  "SearchSettings",
  "SiteFooter",
  "SiteHeader",
  "SitePolicy",
  "SiteSecurity",
  "SiteSettings",
  "SupportedUILanguages",
  "SyntexModels",
  "Tenant",
  "TermGroups",
  "Theme",
  "WebApiPermissions",
  "WebSettings",
  "Workflows",
]));

export function registerTemplate(server: McpServer) {
  // ============================================================================
  // pnp_template_get — extract the connected site as a portable template
  // ============================================================================
  server.tool(
    "pnp_template_get",
    "Extract the CURRENT connected site as a PnP provisioning template (XML/PNP file). " +
    "Long-running for sites with lots of content (10+ minutes for complex sites). The output file can be applied to other sites via pnp_template_apply, version-controlled, etc. " +
    "Read-only — does not modify the site. Set background=true for big sites.",
    {
      out_path: z.string().describe(
        "Local file path to write the template (.xml or .pnp). Absolute path recommended.",
      ),
      handlers: HANDLERS.optional().describe(
        "Restrict which handlers run during extraction (default: All). Common subset: ['Lists','ContentTypes','Fields','SiteSecurity'].",
      ),
      exclude_handlers: HANDLERS.optional().describe(
        "Inverse of `handlers` — extract everything EXCEPT these handlers.",
      ),
      include_all_pages: z.boolean().default(false),
      include_hidden_lists: z.boolean().default(false),
      include_search_configuration: z.boolean().default(false),
      include_native_publishing_files: z.boolean().default(false),
      include_site_groups: z.boolean().default(false),
      include_term_groups_security: z.boolean().default(false),
      include_all_term_groups: z.boolean().default(false),
      include_site_collection_term_group: z.boolean().default(false),
      persist_branding_files: z.boolean().default(false).describe(
        "Embed branding (theme, logo) files inside the template.",
      ),
      persist_publishing_files: z.boolean().default(false),
      persist_multi_language_resources: z.boolean().default(false),
      no_base_template: z.boolean().default(false).describe(
        "Don't include OOTB base template artifacts in the export (smaller output).",
      ),
      lists_to_extract: z.array(z.string()).optional().describe(
        "Limit list extraction to these list titles/URLs. (Otherwise extracts all matching the handler scope.)",
      ),
      template_display_name: z.string().optional(),
      template_image_preview_url: z.string().optional(),
      template_properties: z.record(z.string()).optional().describe(
        "Custom string properties to embed in the template (e.g. {Author: 'Team', Version: '2.0'}).",
      ),
      schema: z.string().optional().describe("PnP schema version (e.g. 'V202209'). Default: latest."),
      skip_version_check: z.boolean().default(false),
      force_overwrite: z.boolean().default(false).describe(
        "If `out_path` already exists, overwrite without prompting. Default false — extraction will fail rather than clobber an existing file.",
      ),
      background: z.boolean().default(false),
    },
    async (a): Promise<ToolResult> => {
      const parts = [`Get-PnPSiteTemplate -Out ${psQuote(a.out_path)}`];
      if (a.force_overwrite) parts.push("-Force");
      if (a.handlers && a.handlers.length) {
        parts.push(`-Handlers ${a.handlers.join(",")}`);
      }
      if (a.exclude_handlers && a.exclude_handlers.length) {
        parts.push(`-ExcludeHandlers ${a.exclude_handlers.join(",")}`);
      }
      const switches: Array<[string, boolean | undefined]> = [
        ["IncludeAllPages", a.include_all_pages],
        ["IncludeHiddenLists", a.include_hidden_lists],
        ["IncludeSearchConfiguration", a.include_search_configuration],
        ["IncludeNativePublishingFiles", a.include_native_publishing_files],
        ["IncludeSiteGroups", a.include_site_groups],
        ["IncludeTermGroupsSecurity", a.include_term_groups_security],
        ["IncludeAllTermGroups", a.include_all_term_groups],
        ["IncludeSiteCollectionTermGroup", a.include_site_collection_term_group],
        ["PersistBrandingFiles", a.persist_branding_files],
        ["PersistPublishingFiles", a.persist_publishing_files],
        ["PersistMultiLanguageResources", a.persist_multi_language_resources],
        ["NoBaseTemplate", a.no_base_template],
        ["SkipVersionCheck", a.skip_version_check],
      ];
      for (const [name, value] of switches) {
        if (value) parts.push(`-${name}`);
      }
      if (a.lists_to_extract && a.lists_to_extract.length) {
        const list = a.lists_to_extract.map(l => psQuote(l)).join(",");
        parts.push(`-ListsToExtract @(${list})`);
      }
      if (a.template_display_name) parts.push(`-TemplateDisplayName ${psQuote(a.template_display_name)}`);
      if (a.template_image_preview_url) parts.push(`-TemplateImagePreviewUrl ${psQuote(a.template_image_preview_url)}`);
      if (a.template_properties && Object.keys(a.template_properties).length) {
        parts.push(`-TemplateProperties ${psHashtable(a.template_properties as Record<string, unknown>)}`);
      }
      if (a.schema) parts.push(`-Schema ${a.schema}`);

      const cmd = parts.join(" ");
      if (a.background) return backgroundResult("pnp_template_get", cmd);
      return runAsTool({
        toolName: "pnp_template_get",
        command: cmd,
        timeoutMs: 30 * 60_000, // 30 min — extraction can be slow
        hint: `Template extracted to ${a.out_path}. Verify the file exists, then version-control it or apply via pnp_template_apply.`,
      });
    },
  );

  // ============================================================================
  // pnp_template_apply — apply a template to the current site (DESTRUCTIVE)
  // ============================================================================
  server.tool(
    "pnp_template_apply",
    "Apply a PnP provisioning template (XML/PNP file) to the CURRENT connected site. " +
    "DESTRUCTIVE: creates/modifies content types, fields, lists, pages, security, etc. — read the template carefully first. " +
    "Long-running (typically 5-30 min for non-trivial templates). Defaults to background=true since synchronous apply almost always exceeds the MCP transport timeout. " +
    "Requires confirm=true.",
    {
      path: z.string().describe("Local path to the template (.xml or .pnp file)"),
      parameters: z.record(z.string()).optional().describe(
        "Template parameters as a JS object (corresponds to PnP `<pnp:Parameters>` placeholders). " +
        "Example: { SiteName: 'Marketing', Region: 'EUR' }",
      ),
      handlers: HANDLERS.optional().describe(
        "Restrict which handlers run (default: All). Useful for incremental rollout.",
      ),
      exclude_handlers: HANDLERS.optional(),
      clear_navigation: z.boolean().default(false).describe(
        "Wipe existing site navigation before applying (otherwise template merges with existing).",
      ),
      ignore_duplicate_data_row_errors: z.boolean().default(false),
      overwrite_system_property_bag_values: z.boolean().default(false),
      provision_content_types_to_subwebs: z.boolean().default(false),
      provision_fields_to_subwebs: z.boolean().default(false),
      resource_folder: z.string().optional().describe(
        "Path to a folder containing referenced resource files (.png, .css, etc.) for the template.",
      ),
      template_id: z.string().optional().describe(
        "If the .xml file contains multiple ProvisioningTemplate definitions, pick one by ID.",
      ),
      background: z.boolean().default(true).describe(
        "Default true — synchronous apply almost always exceeds Claude Desktop's ~60s transport timeout. Set false only for tiny templates (<5 min).",
      ),
      sync_timeout_minutes: z.number().int().positive().max(10).default(5).describe(
        "When background=false, max minutes to block synchronously. Capped at 10 — anything longer MUST run in background mode. Default 5.",
      ),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) {
        return {
          isError: true,
          content: [{
            type: "text",
            text:
              "BLOCKED: pnp_template_apply MODIFIES the connected site (creates/changes content types, fields, lists, pages, security). " +
              "Re-call with confirm=true after pnp_session_status verifies the target site. " +
              "Strongly recommend testing on a sandbox site first.",
          }],
        };
      }
      const parts = [`Invoke-PnPSiteTemplate -Path ${psQuote(a.path)}`];
      if (a.parameters && Object.keys(a.parameters).length) {
        parts.push(`-Parameters ${psHashtable(a.parameters as Record<string, unknown>)}`);
      }
      if (a.handlers && a.handlers.length) parts.push(`-Handlers ${a.handlers.join(",")}`);
      if (a.exclude_handlers && a.exclude_handlers.length) parts.push(`-ExcludeHandlers ${a.exclude_handlers.join(",")}`);
      if (a.clear_navigation) parts.push("-ClearNavigation");
      if (a.ignore_duplicate_data_row_errors) parts.push("-IgnoreDuplicateDataRowErrors");
      if (a.overwrite_system_property_bag_values) parts.push("-OverwriteSystemPropertyBagValues");
      if (a.provision_content_types_to_subwebs) parts.push("-ProvisionContentTypesToSubWebs");
      if (a.provision_fields_to_subwebs) parts.push("-ProvisionFieldsToSubWebs");
      if (a.resource_folder) parts.push(`-ResourceFolder ${psQuote(a.resource_folder)}`);
      if (a.template_id) parts.push(`-TemplateId ${psQuote(a.template_id)}`);

      const cmd = parts.join(" ");
      if (a.background) return backgroundResult("pnp_template_apply", cmd);
      // Synchronous mode: cap at sync_timeout_minutes (max 10). Anything beyond is required
      // to use background:true to avoid silently blocking the MCP transport for an hour.
      return runAsTool({
        toolName: "pnp_template_apply",
        command: cmd,
        timeoutMs: a.sync_timeout_minutes * 60_000,
        hint: "Template applied. Run pnp_site_get and pnp_list_list to verify. Some changes (search schema, branding) may take a few minutes to propagate. If this timed out, re-run with background=true.",
      });
    },
  );
}
