// Modern SharePoint Pages — Get/Add/Set/Remove-PnPPage.
// Pages live in the connected web's SitePages library. Modern pages support sections,
// columns, web parts, headers, and news-promotion / scheduling.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { psQuote } from "../util.js";

const PAGE_PROJECTION =
  "Name, Title, PageId, LayoutType, PromoteAs, CommentsEnabled, " +
  "ContentTypeId, PageHeader, ScheduledPublishDate, ThumbnailUrl, ServerRelativeUrl";

// PnP enum values verified live against `[System.Enum]::GetNames([PnP.Core.Model.SharePoint.PageLayoutType])`.
// @verify-enum [PnP.Core.Model.SharePoint.PageLayoutType]
const PageLayoutType = z.enum([
  "Article",                // standard article layout
  "Home",                   // home page layout
  "SingleWebPartAppPage",   // app page (single full-bleed webpart)
  "RepostPage",             // news repost
  "HeaderlessSearchResults",
  "Spaces",                 // SharePoint Spaces (3D)
  "Topic",                  // SharePoint Topic page
  "Dashboard",              // Viva Connections dashboard layout
  "NewsDigest",             // news digest layout
]);

// @verify-enum [PnP.Core.Model.SharePoint.PageHeaderLayoutType]
const PageHeaderLayoutType = z.enum([
  "FullWidthImage",
  "NoImage",
  "ColorBlock",
  "CutInShape",
]);

// PromoteAs controls news/template/home behavior. PnP enum values:
// @verify-enum [PnP.PowerShell.Commands.Pages.PagePromoteType]
const PagePromoteType = z.enum([
  "None",
  "HomePage",
  "NewsArticle",            // PnP enum spelling — verified live (NOT "NewsPage")
  "Template",
]);

export function registerPage(server: McpServer) {
  // ============================================================================
  // pnp_page_list — list all pages on the connected web
  // ============================================================================
  server.tool(
    "pnp_page_list",
    "List modern SharePoint pages on the connected web (the SitePages library). Returns name, title, layout type, news/promote status, comments, schedule.",
    {},
    async (): Promise<ToolResult> => {
      const cmd = `Get-PnPPage | Select-Object ${PAGE_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_page_list", command: cmd, timeoutMs: 60_000 });
    },
  );

  // ============================================================================
  // pnp_page_get — get one page by name/identity
  // ============================================================================
  server.tool(
    "pnp_page_get",
    "Get one page by name (without .aspx) or relative path.",
    {
      identity: z.string().describe("Page name like 'Home' (no .aspx) or 'SitePages/MyPage.aspx'"),
    },
    async ({ identity }): Promise<ToolResult> => {
      const cmd =
        `Get-PnPPage -Identity ${psQuote(identity)} ` +
        `| Select-Object ${PAGE_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_page_get", command: cmd, timeoutMs: 30_000 });
    },
  );

  // ============================================================================
  // pnp_page_add — create a new modern page
  // ============================================================================
  server.tool(
    "pnp_page_add",
    "Create a new modern SharePoint page in the connected web's SitePages library. " +
    "By default the page is created as a draft; set `publish: true` to publish immediately. " +
    "Use `promote_as` to mark as home page, news, or template. `scheduled_publish_date` schedules a future publish.",
    {
      name: z.string().describe("Page name (without .aspx)"),
      layout_type: PageLayoutType.optional().describe("Page layout (default: Article)"),
      header_layout_type: PageHeaderLayoutType.optional(),
      content_type: z.string().optional().describe("Optional content type name or ID"),
      promote_as: PagePromoteType.optional().describe("Promote as HomePage / NewsArticle / Template"),
      publish: z.boolean().default(false).describe("Publish immediately (otherwise draft)"),
      scheduled_publish_date: z.string().optional().describe(
        "ISO 8601 datetime to schedule publication (e.g. '2026-06-15T09:00:00Z')",
      ),
      comments_enabled: z.boolean().optional(),
      translate: z.boolean().default(false).describe("Generate translation copies for the language codes"),
      translation_language_codes: z.array(z.number().int()).optional().describe(
        "Locale IDs to create translations for (e.g. [1031, 1036] for German + French)",
      ),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_page_add creates a new page in the connected site. Re-call with confirm=true." }] };
      const parts = [`Add-PnPPage -Name ${psQuote(a.name)}`];
      if (a.layout_type) parts.push(`-LayoutType ${a.layout_type}`);
      if (a.header_layout_type) parts.push(`-HeaderLayoutType ${a.header_layout_type}`);
      if (a.content_type) parts.push(`-ContentType ${psQuote(a.content_type)}`);
      if (a.promote_as) parts.push(`-PromoteAs ${a.promote_as}`);
      if (a.publish) parts.push("-Publish");
      if (a.scheduled_publish_date) parts.push(`-ScheduledPublishDate ${psQuote(a.scheduled_publish_date)}`);
      if (a.comments_enabled !== undefined) {
        // -CommentsEnabled is a switch — emit `:$true` / `:$false` so we can both enable AND disable.
        parts.push(`-CommentsEnabled:$${a.comments_enabled}`);
      }
      if (a.translate) parts.push("-Translate");
      if (a.translation_language_codes && a.translation_language_codes.length) {
        parts.push(`-TranslationLanguageCodes @(${a.translation_language_codes.join(",")})`);
      }
      const cmd = parts.join(" ") + ` | Select-Object ${PAGE_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_page_add", command: cmd, timeoutMs: 2 * 60_000 });
    },
  );

  // ============================================================================
  // pnp_page_set — update an existing page
  // ============================================================================
  server.tool(
    "pnp_page_set",
    "Update properties on an existing modern page: title, layout, header, comments, news/template promotion, schedule. " +
    "Use `publish: true` to publish the current draft, `demote_news_article: true` to remove news status.",
    {
      identity: z.string(),
      name: z.string().optional().describe("Rename the page (filename without .aspx)"),
      title: z.string().optional(),
      layout_type: PageLayoutType.optional(),
      header_layout_type: PageHeaderLayoutType.optional(),
      thumbnail_url: z.string().optional(),
      content_type: z.string().optional(),
      promote_as: PagePromoteType.optional(),
      demote_news_article: z.boolean().default(false),
      comments_enabled: z.boolean().optional(),
      like: z.boolean().default(false).describe("Like the page as the current user"),
      publish: z.boolean().default(false),
      scheduled_publish_date: z.string().optional(),
      remove_scheduled_publish: z.boolean().optional().describe(
        "Set true to clear an existing scheduled-publish on the page. (-RemoveScheduledPublish is a switch parameter on Set-PnPPage.)",
      ),
      show_publish_date: z.boolean().optional(),
      translate: z.boolean().default(false),
      translation_language_codes: z.array(z.number().int()).optional(),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_page_set modifies the page. Re-call with confirm=true." }] };
      const parts = [`Set-PnPPage -Identity ${psQuote(a.identity)}`];
      if (a.name) parts.push(`-Name ${psQuote(a.name)}`);
      if (a.title) parts.push(`-Title ${psQuote(a.title)}`);
      if (a.layout_type) parts.push(`-LayoutType ${a.layout_type}`);
      if (a.header_layout_type) parts.push(`-HeaderLayoutType ${a.header_layout_type}`);
      if (a.thumbnail_url) parts.push(`-ThumbnailUrl ${psQuote(a.thumbnail_url)}`);
      if (a.content_type) parts.push(`-ContentType ${psQuote(a.content_type)}`);
      if (a.promote_as) parts.push(`-PromoteAs ${a.promote_as}`);
      if (a.demote_news_article) parts.push("-DemoteNewsArticle");
      // -CommentsEnabled is a switch — emit `:$true` / `:$false` so we can both enable AND disable.
      if (a.comments_enabled !== undefined) parts.push(`-CommentsEnabled:$${a.comments_enabled}`);
      if (a.like) parts.push("-Like");
      if (a.publish) parts.push("-Publish");
      if (a.scheduled_publish_date) parts.push(`-ScheduledPublishDate ${psQuote(a.scheduled_publish_date)}`);
      // -RemoveScheduledPublish is a switch parameter (verified live). Only emit when true.
      if (a.remove_scheduled_publish) parts.push("-RemoveScheduledPublish");
      if (a.show_publish_date !== undefined) parts.push(`-ShowPublishDate:$${a.show_publish_date}`);
      if (a.translate) parts.push("-Translate");
      if (a.translation_language_codes && a.translation_language_codes.length) {
        parts.push(`-TranslationLanguageCodes @(${a.translation_language_codes.join(",")})`);
      }
      if (parts.length === 1) {
        return { isError: true, content: [{ type: "text", text: "No properties provided to update." }] };
      }
      const cmd =
        `try { ${parts.join(" ")} -ErrorAction Stop; ` +
        `Get-PnPPage -Identity ${psQuote(a.identity)} | Select-Object ${PAGE_PROJECTION} | ConvertTo-Json -Depth 5 -Compress } ` +
        `catch { Write-Output ('ERROR: Set-PnPPage failed: ' + $_.Exception.Message); throw }`;
      return runAsTool({ toolName: "pnp_page_set", command: cmd, timeoutMs: 2 * 60_000 });
    },
  );

  // ============================================================================
  // pnp_page_remove — delete a page
  // ============================================================================
  server.tool(
    "pnp_page_remove",
    "DESTRUCTIVE: delete a modern page. By default sends to recycle bin (93-day recovery).",
    {
      identity: z.string(),
      recycle: z.boolean().default(true),
      confirm: z.boolean(),
    },
    async ({ identity, recycle, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `BLOCKED: pnp_page_remove deletes a page. Re-call with confirm=true.${recycle ? " (Recycle bin: 93-day recovery.)" : " (PERMANENT delete.)"}`,
          }],
        };
      }
      const parts = [`Remove-PnPPage -Identity ${psQuote(identity)} -Force`];
      if (recycle) parts.push("-Recycle");
      return runAsTool({ toolName: "pnp_page_remove", command: parts.join(" "), timeoutMs: 60_000 });
    },
  );
}
