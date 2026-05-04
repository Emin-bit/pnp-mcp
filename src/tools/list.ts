// SharePoint List management — typed wrappers around Get-PnPList / New-PnPList /
// Set-PnPList / Remove-PnPList. "Lists" includes both classic Lists and Document Libraries.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { psQuote, psSwitch } from "../util.js";

const LIST_PROJECTION =
  "Id, Title, Description, Url, ItemCount, BaseTemplate, BaseType, Hidden, " +
  "EnableVersioning, EnableMinorVersions, EnableModeration, EnableContentTypes, " +
  "EnableAttachments, ForceCheckout, MajorVersionLimit, MinorVersionLimit, Created, LastItemModifiedDate";

// Most common ListTemplateType values. PnP accepts the string name; the full enum has
// 100+ values — we list the high-frequency ones in the description but accept any string.
const COMMON_TEMPLATES =
  "GenericList, DocumentLibrary, Survey, Links, Announcements, Contacts, Events, " +
  "Tasks, DiscussionBoard, PictureLibrary, XMLForm, IssueTracking, Posts, Comments, " +
  "WebPageLibrary, AdminTasks, HelpLibrary";

export function registerList(server: McpServer) {
  // ============================================================================
  // pnp_list_list — list all lists/libraries on the connected web
  // ============================================================================
  server.tool(
    "pnp_list_list",
    "List all SharePoint lists AND document libraries on the connected web. Returns JSON projection with id, title, url, item count, template, versioning settings. " +
    "If you only want libraries, filter the result by `BaseType -eq 1`. To inspect items inside a list, use pnp_listitem_list.",
    {
      include_hidden: z.boolean().default(false).describe("Include hidden system lists in the result."),
    },
    async ({ include_hidden }): Promise<ToolResult> => {
      const cmd =
        `Get-PnPList ` +
        (include_hidden ? "" : "| Where-Object { -not $_.Hidden } ") +
        `| Select-Object ${LIST_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({
        toolName: "pnp_list_list",
        command: cmd,
        timeoutMs: 60_000,
      });
    },
  );

  // ============================================================================
  // pnp_list_get — get a single list by id, title, or url
  // ============================================================================
  server.tool(
    "pnp_list_get",
    "Get one SharePoint list by identity (title, ID, or server-relative URL). Returns the same projection as pnp_list_list but for the single matched list.",
    {
      identity: z.string().describe(
        "List title (e.g. 'Documents'), GUID, or server-relative URL (e.g. '/sites/x/Lists/Tasks').",
      ),
    },
    async ({ identity }): Promise<ToolResult> => {
      const cmd =
        `Get-PnPList -Identity ${psQuote(identity)} -ThrowExceptionIfListNotFound ` +
        `| Select-Object ${LIST_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({
        toolName: "pnp_list_get",
        command: cmd,
        timeoutMs: 30_000,
      });
    },
  );

  // ============================================================================
  // pnp_list_new — create a new list/library
  // ============================================================================
  server.tool(
    "pnp_list_new",
    `Create a new SharePoint list or library. Common templates: ${COMMON_TEMPLATES}. ` +
    "Wraps New-PnPList. Modifies the connected web. Requires confirm=true.",
    {
      title: z.string().describe("List/library display title"),
      template: z.string().describe(
        `ListTemplateType name. Common: ${COMMON_TEMPLATES}. Use 'DocumentLibrary' for a doc library, 'GenericList' for a custom list.`,
      ),
      url: z.string().optional().describe("Optional URL slug (otherwise derived from title)."),
      enable_versioning: z.boolean().default(false),
      enable_content_types: z.boolean().default(false).describe(
        "Enable management of multiple content types on this list/library.",
      ),
      hidden: z.boolean().default(false).describe("Hide from the Site Contents page."),
      on_quick_launch: z.boolean().default(false).describe("Show in left navigation (Quick Launch)."),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) {
        return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_list_new modifies the connected web. Re-call with confirm=true." }] };
      }
      const parts = [
        `New-PnPList -Title ${psQuote(a.title)} -Template ${a.template}`,
      ];
      if (a.url) parts.push(`-Url ${psQuote(a.url)}`);
      if (a.enable_versioning) parts.push(psSwitch("EnableVersioning", true));
      if (a.enable_content_types) parts.push(psSwitch("EnableContentTypes", true));
      if (a.hidden) parts.push(psSwitch("Hidden", true));
      if (a.on_quick_launch) parts.push(psSwitch("OnQuickLaunch", true));
      const cmd = parts.join(" ") + ` | Select-Object ${LIST_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_list_new", command: cmd, timeoutMs: 60_000 });
    },
  );

  // ============================================================================
  // pnp_list_set — update list properties
  // ============================================================================
  server.tool(
    "pnp_list_set",
    "Update properties on an existing list/library (title, description, versioning, content-type management, attachments, etc.). " +
    "Set-PnPList has 30+ params; this tool exposes the most-used ones. For niche params, use pnp_run with Set-PnPList directly.",
    {
      identity: z.string().describe("List title, GUID, or URL"),
      title: z.string().optional(),
      description: z.string().optional(),
      enable_versioning: z.boolean().optional(),
      enable_minor_versions: z.boolean().optional(),
      enable_content_types: z.boolean().optional(),
      enable_attachments: z.boolean().optional(),
      enable_moderation: z.boolean().optional().describe("Require approval for items (Approval workflow)."),
      enable_folder_creation: z.boolean().optional(),
      force_checkout: z.boolean().optional(),
      hidden: z.boolean().optional(),
      major_versions: z.number().int().nonnegative().optional().describe("Max major versions to keep (0 = unlimited)."),
      minor_versions: z.number().int().nonnegative().optional(),
      no_crawl: z.boolean().optional().describe("Exclude this list from search index."),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) {
        return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_list_set modifies list configuration. Re-call with confirm=true." }] };
      }
      const parts = [`Set-PnPList -Identity ${psQuote(a.identity)}`];
      const pushBool = (n: string, v: boolean | undefined) => {
        if (v !== undefined) parts.push(`-${n}:$${v}`);
      };
      const pushNum = (n: string, v: number | undefined) => {
        if (v !== undefined) parts.push(`-${n} ${v}`);
      };
      if (a.title) parts.push(`-Title ${psQuote(a.title)}`);
      if (a.description) parts.push(`-Description ${psQuote(a.description)}`);
      pushBool("EnableVersioning", a.enable_versioning);
      pushBool("EnableMinorVersions", a.enable_minor_versions);
      pushBool("EnableContentTypes", a.enable_content_types);
      pushBool("EnableAttachments", a.enable_attachments);
      pushBool("EnableModeration", a.enable_moderation);
      pushBool("EnableFolderCreation", a.enable_folder_creation);
      pushBool("ForceCheckout", a.force_checkout);
      pushBool("Hidden", a.hidden);
      pushNum("MajorVersions", a.major_versions);
      pushNum("MinorVersions", a.minor_versions);
      if (a.no_crawl) parts.push(psSwitch("NoCrawl", true));

      if (parts.length === 1) {
        return { isError: true, content: [{ type: "text", text: "No properties provided to update. Pass at least one (title, description, enable_versioning, ...)." }] };
      }

      const cmd =
        `try { ${parts.join(" ")} -ErrorAction Stop; ` +
        `Get-PnPList -Identity ${psQuote(a.identity)} | Select-Object ${LIST_PROJECTION} | ConvertTo-Json -Depth 5 -Compress } ` +
        `catch { Write-Output ('ERROR: Set-PnPList failed: ' + $_.Exception.Message); throw }`;
      return runAsTool({ toolName: "pnp_list_set", command: cmd, timeoutMs: 60_000 });
    },
  );

  // ============================================================================
  // pnp_list_remove — delete a list
  // ============================================================================
  server.tool(
    "pnp_list_remove",
    "DESTRUCTIVE: delete a list/library AND ALL its items. Wraps Remove-PnPList. Requires confirm=true. " +
    "By default sends to recycle bin (use `recycle: true`); set `recycle: false` for permanent delete (no recovery).",
    {
      identity: z.string().describe("List title, GUID, or URL"),
      recycle: z.boolean().default(true).describe("Send to recycle bin (default true). Set false for PERMANENT delete."),
      large_list: z.boolean().default(false).describe(
        "Set true for lists with >5000 items to use the LargeList delete path (slower but avoids throttling).",
      ),
      confirm: z.boolean(),
    },
    async ({ identity, recycle, large_list, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: `BLOCKED: pnp_list_remove deletes a list AND all its items. Re-call with confirm=true.${recycle ? " (Recycle bin: items can be restored within 93 days.)" : " (PERMANENT delete: no recovery.)"}`,
          }],
        };
      }
      const parts = [`Remove-PnPList -Identity ${psQuote(identity)} -Force`];
      if (recycle) parts.push("-Recycle");
      if (large_list) parts.push("-LargeList");
      return runAsTool({
        toolName: "pnp_list_remove",
        command: parts.join(" "),
        timeoutMs: 5 * 60_000,
      });
    },
  );
}
