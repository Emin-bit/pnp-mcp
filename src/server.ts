import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { homedir } from "node:os";
import { z } from "zod";
import { loadState } from "./state-cache.js";
import { readMsalAccounts } from "./identity-cache.js";

/** Render an ISO timestamp as a coarse "5m ago" / "2h ago" / "3d ago" hint. */
function humanTimeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return iso;
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = Math.round(hr / 24);
  return `${d}d ago`;
}
import { runAsTool } from "./runner.js";
import { runPnp, stopSession, maskCommand, getSession } from "./pwsh.js";
import { isDestructive, safeModeEnabled } from "./safety.js";
import { backgroundResult, killAllRunning } from "./jobs.js";
import { registerAuth } from "./tools/auth.js";
import { registerPreflight } from "./tools/preflight.js";
import { registerJobTools } from "./tools/jobs.js";
import { registerSite } from "./tools/site.js";
import { registerWeb } from "./tools/web.js";
import { registerTenant } from "./tools/tenant.js";
import { registerList } from "./tools/list.js";
import { registerListItem } from "./tools/listitem.js";
import { registerView } from "./tools/view.js";
import { registerFile } from "./tools/file.js";
import { registerFolder } from "./tools/folder.js";
import { registerContentType } from "./tools/contenttype.js";
import { registerField } from "./tools/field.js";
import { registerPermission } from "./tools/permission.js";
import { registerTemplate } from "./tools/template.js";
import { registerPage } from "./tools/page.js";
import { registerHubSite } from "./tools/hubsite.js";
import { registerM365Group } from "./tools/m365group.js";
import { registerNavigation } from "./tools/navigation.js";
import { registerSelfReview } from "./tools/self_review.js";
import { log, getLogDir } from "./logger.js";

export const VERSION = "1.2.0";

const SERVER_INSTRUCTIONS = `
PnP MCP server (90 tools). Wraps the PnP.PowerShell module via a long-lived pwsh 7+ REPL session.
SharePoint Online + Microsoft 365 admin operations: sites, webs, lists, items, files, content
types, fields, permissions, provisioning templates, modern pages, hub sites, M365 groups,
navigation. Plus pnp_run as an escape-hatch passthrough for any cmdlet not covered by a typed tool.

FIRST-TIME ONBOARDING — ALWAYS in this order:
  1. preflight                                   →  Node, pwsh, PnP.PowerShell module, auth state
  2. setup_install_pnp_module (confirm:true)     →  if the module is missing
  3. One of pnp_auth_connect_* tools             →  authenticate to a SharePoint tenant
  4. pnp_session_status                          →  verify which tenant/site is active before any destructive op

CHOOSING THE RIGHT AUTH TOOL:
  • Developer laptop, GUI available  →  pnp_auth_connect_interactive  (browser pop-up)
  • Headless / SSH / no browser      →  pnp_auth_connect_device_code  (URL + code flow)
  • CI/CD, scheduled tasks, scripts  →  pnp_auth_connect_sp_secret    (Service Principal)
  • Higher-security CI/CD            →  pnp_auth_connect_sp_cert      (Service Principal + .pfx)
  • Running on an Azure resource     →  pnp_auth_connect_managed_identity
  All OAuth flows except managed identity require an Entra app registration (ClientId).

DESTRUCTIVE OPERATIONS require confirm:true when safe-mode is on (default).
Safe-mode blocks: destructive verbs (Remove-/Clear-/Reset-/Disable-/Stop-/Disconnect-/
Revoke-/Uninstall-/Unpublish-), explicit cmdlets in DESTRUCTIVE_FULL_CMDLETS (New-PnPSite,
New-PnPList, Set-PnPListItem, Add-PnPField, Invoke-PnPTenantTemplate, Register-PnPHubSite,
New-PnPMicrosoft365Group, Add-PnPPage, Set-PnPPage, Set-PnPListPermission, Add-PnPSiteCollectionAdmin
and many more — see safety.ts), and dangerous parameters (-Force, -Confirm:$false). The check
walks ALL cmdlets in the command, so pipeline-destructive (Get-X | Remove-X) and multi-statement
(X; Remove-Y) are caught. Always call pnp_session_status BEFORE confirm:true to verify the
active tenant — destructive cmdlets affect whatever site is currently connected.

LONG-RUNNING OPERATIONS — Claude Desktop's MCP transport has a ~60s default timeout.
For commands that may exceed it (site provisioning, template apply, bulk file ops, M365 group
creation), set background:true on pnp_run OR use the typed tools that already default to
background:true (pnp_template_apply). Returns a job id immediately; track via job_status /
job_wait / job_cancel. Background jobs run in SEPARATE pwsh processes from the interactive
session — the background command must include its own Connect-PnPOnline because it does NOT
inherit auth state from the live session.

TOOL FAMILIES (what to reach for):

• Tenant + sites:  pnp_tenant_get/set, pnp_site_list/get/get_by_url/new/remove,
                   pnp_web_list/get/new/remove
• Lists + items:   pnp_list_list/get/new/set/remove,
                   pnp_listitem_list/get/add/set/remove (use \`fields\` for OData $select),
                   pnp_view_list/add/remove
• Files + folders: pnp_file_get/add/copy/move/remove, pnp_folder_get/add/remove
                   (folders create one level at a time; pnp_folder_add rejects slashes)
• Schema:          pnp_contenttype_list/get/add/set/remove,
                   pnp_field_list/get/add/set/remove (22-value FieldType enum)
• Security:        pnp_group_list/get/new/set/remove,
                   pnp_role_definition_list, pnp_role_set_web/list/listitem
                   (set tools handle break-inheritance + grant/clear in one call)
• Provisioning:    pnp_template_get (export to XML), pnp_template_apply (apply a PnP template
                   — DEFAULTS to background:true, sync_timeout_minutes capped at 10)
• Modern pages:    pnp_page_list/get/add/set/remove (LayoutType incl. Dashboard/NewsDigest;
                   PromoteAs uses NewsArticle, not "NewsPage"; switches like CommentsEnabled
                   accept true AND false)
• Hub sites:       pnp_hubsite_list/register/set/associate/disassociate
                   (principals on register is OPTIONAL — omit to allow anyone)
• M365 groups:     pnp_m365group_list/get/new/set/remove + member_add/member_remove +
                   owner_add/owner_remove (creating a group provisions mailbox + SP site)
• Navigation:      pnp_navigation_list/add/remove
                   (\`all:true\` REQUIRES \`location\` — bare \`-All\` deletes every nav surface)
• Escape hatch:    pnp_run (any cmdlet, with safe-mode), pnp_help (cmdlet discovery)
• Jobs:            job_list/status/wait/cancel for tracking background:true work

TYPICAL FLOWS:

Read-then-write (always read current state first):
  pnp_session_status → pnp_site_get / pnp_list_get / pnp_page_get → pnp_*_set with confirm:true

New site:                pnp_site_new (background:true; TeamSite needs alias+owners)
New list with custom CT: pnp_list_new → pnp_contenttype_add → pnp_list_set (attach CT) → pnp_field_add
Apply provisioning:      pnp_template_apply (background:true, watch via job_wait)
Hub site setup:          pnp_hubsite_register → pnp_hubsite_associate (per child site)
Page authoring:          pnp_page_add (draft) → pnp_page_set (publish:true or schedule)

OUTPUT — most read tools return JSON via ConvertTo-Json. ANSI escapes are stripped before
the result reaches you. If a result is truncated or not JSON, fall back to pnp_run with
\`Out-String -Width 200\` for raw display.

╔════════════════════════════════════════════════════════════════════════════════════════════════╗
║  PHASE G (v1.2.0) — EMBEDDED EXPERT KNOWLEDGE FOR SHAREPOINT WORKFLOWS                         ║
║  Added proactively (no production usage data yet). Mirrors the Power Platform MCP 1.2.0        ║
║  Phase F "Golden Rules" approach — bake the recipes Claude needs to behave well.               ║
╚════════════════════════════════════════════════════════════════════════════════════════════════╝

══════════════════════════════════════════════════════════════════════════════════════════════════
GOLDEN RULE #1 — AUTH ONCE PER SESSION, VERIFY BEFORE EVERY DESTRUCTIVE OP
══════════════════════════════════════════════════════════════════════════════════════════════════
At session start:
  1. Run \`pnp_session_status\`. If it says "NOT CONNECTED", ask the user for target site URL
     and pick the right \`pnp_auth_connect_*\` (interactive on dev laptop, device_code on
     headless, sp_secret/sp_cert for CI). PnP MCP supports cached connections from prior
     sessions (state-cache.json) — Claude will offer to reuse them when you call connect with
     no args.
  2. After the FIRST successful Connect, do NOT ask the user for credentials/ClientId/tenant
     again for the rest of the session — the long-lived pwsh REPL keeps the auth context alive.
     Re-call pnp_session_status to verify, do NOT re-auth gratuitously.

Before EVERY destructive operation (Remove-, Set-PnPTenant, Invoke-PnPTenantTemplate, etc.):
  - For typed tools (pnp_template_apply, pnp_tenant_set, pnp_site_remove): the Phase G hardening
    accepts \`expected_url\` (or \`expected_tenant_substring\`). When set, the tool runs
    Get-PnPConnection FIRST and HARD-REFUSES if the active connection doesn't match. ALWAYS
    pass one of these for any production operation.
  - For pnp_run passthrough: call pnp_session_status immediately before the destructive cmdlet
    so the active site URL + tenant id appear in your reply — let the user confirm before
    you proceed.

══════════════════════════════════════════════════════════════════════════════════════════════════
GOLDEN RULE #2 — TYPED TOOL vs pnp_run — PREFER TYPED FOR COMMON OPERATIONS
══════════════════════════════════════════════════════════════════════════════════════════════════
This MCP exposes 89 typed tools that wrap the most-used PnP cmdlets with structured schemas,
consistent safety gating, automatic background-mode routing, and tenant-safety guards. **Prefer
typed tools over \`pnp_run\` whenever both can do the job.**

Quick mapping (cmdlet → typed tool):
  • Get-PnPSite, Get-PnPTenantSite     →  pnp_site_get, pnp_site_list, pnp_site_get_by_url
  • Get-PnPList, Get-PnPListItem       →  pnp_list_get, pnp_listitem_list
  • Add-PnPListItem, Set-PnPListItem   →  pnp_listitem_add, pnp_listitem_set
  • Get-PnPFile, Add-PnPFile           →  pnp_file_get, pnp_file_add
  • Get-PnPFolder, Add-PnPFolder       →  pnp_folder_get, pnp_folder_add
  • Get-PnPField, Add-PnPField         →  pnp_field_get, pnp_field_add
  • Get-PnPContentType, Add-PnP*       →  pnp_contenttype_*
  • Get-PnPGroup, Add-PnPGroupMember   →  pnp_group_*, pnp_role_set_*
  • Invoke-PnPSiteTemplate             →  pnp_template_apply  (has tenant-safety guard)
  • Set-PnPTenant                       →  pnp_tenant_set      (has tenant-safety guard)
  • Remove-PnPTenantSite                →  pnp_site_remove     (has tenant-safety guard)
  • Get-PnPHubSite, Register-PnPHubSite →  pnp_hubsite_*
  • Get-PnPMicrosoft365Group            →  pnp_m365group_*
  • Get-PnPPage, Set-PnPPage            →  pnp_page_*
  • Get-PnPNavigationNode               →  pnp_navigation_*

Use \`pnp_run\` only when:
  • The cmdlet has no typed wrapper (e.g. RUN-PnPSearchQuery, Invoke-PnPGraphMethod).
  • You need a multi-cmdlet pipeline that doesn't fit a single typed tool.
  • You're prototyping an exploration that will become a typed tool later.

Why prefer typed: typed tools surface required params in the schema (less guessing), apply
consistent safety/confirm gating, route to background mode when historically slow, and (for the
3 destructive ones above) verify the active connection before running.

══════════════════════════════════════════════════════════════════════════════════════════════════
GOLDEN RULE #3 — SITE PROVISIONING RECIPE (TeamSite vs CommunicationSite vs Group-less)
══════════════════════════════════════════════════════════════════════════════════════════════════
Three site templates serve different purposes; picking the wrong one is hard to undo (the
underlying group membership and Teams/M365 relationship is baked at creation):

  TeamSite (with M365 Group)         →  GROUP#0 base. Creates: SP site + M365 group + (optional) Teams
                                        team + Group mailbox + Planner + Stream channel. Use when you
                                        need group membership and Teams chat. CANNOT be "ungrouped".
                                        Required: alias (short name, lowercase, no spaces). Owners
                                        optional (defaults to the connecting identity).

  TeamSiteWithoutMicrosoft365Group   →  STS#3. Plain SP site with classic SP permissions only.
                                        No M365 group, no Teams. Use when group is undesirable
                                        (long-term archive, vendor portal). CAN be upgraded to
                                        group-connected later. Required: url + owner.

  CommunicationSite                   →  SITEPAGEPUBLISHING#0. Branded, broadcast-style site
                                        (no Teams team, no group). Use for company intranet,
                                        knowledge bases, news hubs. Required: url + owner.
                                        DOES NOT accept the \`alias\` param (typed tool blocks it).

Typed tool: \`pnp_site_new\` cross-validates these — passing alias to CommunicationSite or url to
TeamSite is rejected before the cmdlet runs.

PROVISION FLOW (always):
  1. pnp_session_status                         → confirm active tenant + admin scope
  2. pnp_tenant_get                             → check sharing-cap defaults (will the new site
                                                  inherit external-sharing settings you don't want?)
  3. pnp_site_new (background:true)             → 3-8 min provisioning, returns job id
  4. job_wait <id>                              → block until done
  5. pnp_auth_connect_interactive (new url)     → switch context to the new site
  6. pnp_template_apply (expected_url: <new>)   → if applying a starter template

══════════════════════════════════════════════════════════════════════════════════════════════════
GOLDEN RULE #4 — LIST + ITEM OPERATIONS (the hottest workflow surface)
══════════════════════════════════════════════════════════════════════════════════════════════════
  • CAML query vs OData filter: prefer OData (\`-Filter \"<field> eq 'value'\"\` on Get-PnPListItem)
    for simple lookups — it's faster and easier to debug. Use CAML when you need view-fields, sort,
    or complex AND/OR nesting.
  • Bulk Set-PnPListItem in a pipeline (\`Get-PnPListItem | Set-PnPListItem -Values @{...}\`) can
    hit thousands of rows in one call. The MCP safety walks the whole pipeline and gates on
    confirm:true — this is intentional, not an annoyance.
  • Get-PnPListItem -PageSize: default is 100. Use -PageSize 5000 for large lists or you'll
    paginate forever. Set top-level result limit with -Top.
  • Adding items with lookup or person fields: pass the lookup ID as a hashtable value, e.g.
    \`-Values @{LookupCol = 42; PersonCol = "user@contoso.com"}\`. The MCP \`psHashtable\` helper
    handles arrays for multi-value fields.
  • DELETE: Get-PnPListItem | Remove-PnPListItem -Recycle is the safe pattern. Default goes to
    site recycle bin (93-day recovery). -SkipRecycleBin permanent deletes.

══════════════════════════════════════════════════════════════════════════════════════════════════
GOLDEN RULE #5 — PERMISSIONS + INHERITANCE GOTCHAS
══════════════════════════════════════════════════════════════════════════════════════════════════
SharePoint permissions are scope-hierarchical: SiteCollection → Web → List → ListItem/Folder.
Children INHERIT by default. Breaking inheritance creates a UNIQUE permission scope, which:
  • Slows down search indexing (each unique scope = separate ACL evaluation).
  • Creates "Limited Access" permission rows on parent scopes — a feature, not a bug.
  • CANNOT be undone surgically: re-inheriting drops ALL custom permissions silently.

Typed tools: \`pnp_role_set_web\`, \`pnp_role_set_list\`, \`pnp_role_set_listitem\` handle both
break-inheritance and grant in one call. They reject incoherent combinations (e.g. \`user\` +
\`group\` together — pass exactly one principal type).

CRITICAL DON'T: never call Add-PnPSiteCollectionAdmin without first running pnp_session_status
and confirming the target site. This grants UNRESTRICTED control over the entire site collection.
There's no typed wrapper — only pnp_run, with safety gating.

══════════════════════════════════════════════════════════════════════════════════════════════════
GOLDEN RULE #6 — PROVISIONING TEMPLATES + DESTRUCTIVE BLAST RADIUS
══════════════════════════════════════════════════════════════════════════════════════════════════
\`pnp_template_apply\` (wraps Invoke-PnPSiteTemplate / Invoke-PnPTenantTemplate) is the SINGLE
LARGEST blast-radius operation in the entire PnP module. A template can:
  • Create or DELETE content types, fields, lists, libraries, pages.
  • Reset navigation, theme, branding.
  • Reset security groups + role assignments.
  • Apply property bag values that the framework can't easily revert.

ALWAYS for production applies:
  1. \`pnp_template_apply\` accepts \`expected_url\` (Phase G hardening) — pass it. The tool runs
     Get-PnPConnection first and refuses if the active site doesn't match.
  2. Use \`handlers\`/\`exclude_handlers\` to limit which template sections run. For incremental
     rollout: apply Navigation first, verify, then Fields, then ContentTypes, etc.
  3. Run \`background:true\` (the default) — synchronous apply almost always exceeds Claude
     Desktop's 60s MCP transport timeout. Track via job_wait.

══════════════════════════════════════════════════════════════════════════════════════════════════
GOLDEN RULE #7 — PERIODIC SELF-REVIEW
══════════════════════════════════════════════════════════════════════════════════════════════════
Call \`pnp_self_review\` periodically (weekly) to surface:
  • Tool frequency + failure rate (with stderr extracts).
  • Top PnP cmdlets called via pnp_run + their workflow families (Sites / Lists / Files / etc.).
  • Typed vs passthrough usage ratio — if you're 95% passthrough, Claude isn't using the typed
    wrappers (golden rule #2). The tool surfaces this as a suggestion.
  • Connect-PnPOnline attempt count — zero attempts + many calls suggests reuse of a stale
    cached connection.
  • Week-over-week trend.
Output is local-only and homedir/username redacted, safe to paste into chat or GitHub issues.
`.trim();

export async function startServer(): Promise<void> {
  const server = new McpServer(
    { name: "pnp-mcp", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  // -------- pnp_run (passthrough — the escape hatch) --------
  server.tool(
    "pnp_run",
    "Execute an arbitrary PowerShell expression in the long-lived pwsh session that has PnP.PowerShell module loaded. " +
    "Examples: command=\"Get-PnPConnection | Format-List\", command=\"Get-PnPTenantSite | Select Url, Title | ConvertTo-Json\". " +
    "DESTRUCTIVE cmdlets (Remove-*, Clear-*, Reset-*, etc.) and the -Force parameter require confirm: true. " +
    "Set background=true for commands that may exceed Claude Desktop's ~60s MCP transport timeout (site provisioning, template apply) — returns job id, track via job_*. " +
    "Default sync timeout 120s, max 1800s.",
    {
      command: z.string().describe('PowerShell expression. Example: "Get-PnPConnection | ConvertTo-Json"'),
      confirm: z.boolean().optional().describe("Set true to authorize destructive operations."),
      timeout_seconds: z.number().int().positive().max(1800).optional().describe("Sync timeout (default 120s, max 1800s). Ignored when background=true."),
      background: z.boolean().default(false).describe("Fire-and-forget in a separate pwsh process; bypasses MCP transport timeout."),
    },
    async ({ command, confirm, timeout_seconds, background }) => {
      const danger = isDestructive(command);
      if (danger.destructive && safeModeEnabled() && !confirm) {
        return {
          isError: true,
          content: [{
            type: "text",
            text:
              `BLOCKED: ${danger.reason}.\n` +
              `Re-call pnp_run with confirm=true to proceed.\n` +
              `Before confirming, you should call 'pnp_session_status' to verify which tenant is active.\n` +
              `To disable safe-mode globally (NOT recommended), set env PNP_MCP_SAFE_MODE=off in the MCP server config.`,
          }],
        };
      }

      log("info", "pnp_run", { cmd: maskCommand(command), confirm: !!confirm, destructive: danger.destructive, background });

      if (background) {
        return backgroundResult("pnp_run", command);
      }
      return runAsTool({
        toolName: "pnp_run",
        command,
        timeoutMs: (timeout_seconds ?? 120) * 1000,
      });
    },
  );

  // -------- pnp_help (cmdlet discovery) --------
  server.tool(
    "pnp_help",
    "Discover available PnP cmdlets and their usage. " +
    "Pass `name` (substring or wildcard, e.g. 'Get-PnP*Site*') to list matching cmdlets, " +
    "or `cmdlet` (exact name, e.g. 'Get-PnPSite') to get full help for one cmdlet. " +
    "If both omitted, lists all PnP.PowerShell cmdlets (~700+).",
    {
      name: z.string().optional().describe("Substring or wildcard for cmdlet names. Example: 'Get-PnP*Site*'"),
      cmdlet: z.string().optional().describe("Exact cmdlet name to get full help. Example: 'Get-PnPSite'"),
    },
    async ({ name, cmdlet }) => {
      let command: string;
      if (cmdlet) {
        command = `Get-Help ${cmdlet} -Full | Out-String`;
      } else if (name) {
        command = `Get-Command -Module PnP.PowerShell -Name '${name}' | Select-Object Name, CommandType | Format-Table -AutoSize | Out-String`;
      } else {
        command = "Get-Command -Module PnP.PowerShell | Select-Object Name | Format-Table -AutoSize | Out-String";
      }
      return runAsTool({
        toolName: "pnp_help",
        command,
        timeoutMs: 30_000,
      });
    },
  );

  // -------- Phase 1 — auth lifecycle, preflight, job tracking --------
  registerAuth(server);
  registerPreflight(server);
  registerJobTools(server);

  // -------- Phase 2 — sites, webs, tenant --------
  registerSite(server);
  registerWeb(server);
  registerTenant(server);

  // -------- Phase 3 — lists, items, views, files, folders --------
  registerList(server);
  registerListItem(server);
  registerView(server);
  registerFile(server);
  registerFolder(server);

  // -------- Phase 4 — schema (CTs/fields), permissions, provisioning templates --------
  registerContentType(server);
  registerField(server);
  registerPermission(server);
  registerTemplate(server);

  // -------- Phase 5 — pages, hub sites, M365 groups, navigation --------
  registerPage(server);
  registerHubSite(server);
  registerM365Group(server);
  registerNavigation(server);
  registerSelfReview(server);

  // -------- pnp_session_status (B3 enriched) --------
  server.tool(
    "pnp_session_status",
    "Show the current PnP connection (if any) in the long-lived pwsh session. ALWAYS call this before destructive operations to verify which tenant/site is active. " +
    "Returns: connection URL, account name, client ID, tenant ID, connection type — or a clear 'NOT CONNECTED' message if no auth has been performed. " +
    "B3: AccountName and TenantId are eagerly populated when the connection object leaves them blank (PnP 3.x sometimes does for delegated auth). " +
    // NOTE: the eager-load makes one extra Get-PnPWeb REST hop per status call when
    // AccountName is blank — for app-only auth that is *every* call, since AccountName
    // is always blank there. Cost is small (~100ms one-shot REST) but worth memoizing
    // per-connection in a future minor if status_check turns into a hot path.

    "B2: also lists the most-recent cached connections so you can re-call pnp_auth_connect_* without typing the URL/ClientId again.",
    {},
    async () => {
      // First run the live status check.
      const liveResult = await runAsTool({
        toolName: "pnp_session_status",
        // Get-PnPConnection THROWS a terminating exception (BeginProcessing aborts) when no
        // connection exists — even with -ErrorAction SilentlyContinue. We MUST wrap in try/catch
        // inside PowerShell rather than relying on PowerShell's error-action preference.
        // B3: backfill AccountName from CurrentUser.Email when the connection leaves it blank.
        command:
          "try { " +
            "$c = Get-PnPConnection -ErrorAction Stop; " +
            "$acc = $c.AccountName; " +
            "$tid = $c.TenantId; " +
            "if ([string]::IsNullOrEmpty($acc)) { " +
              "try { $w = Get-PnPWeb -Includes CurrentUser -ErrorAction Stop; if ($w.CurrentUser) { $acc = $w.CurrentUser.Email } } catch {} " +
            "} " +
            "[pscustomobject]@{ " +
              "Url = $c.Url; " +
              "AccountName = if ([string]::IsNullOrEmpty($acc)) { '(not available — likely app-only or pending first call)' } else { $acc }; " +
              "ClientId = $c.ClientId; " +
              "TenantId = if ([string]::IsNullOrEmpty($tid)) { '(not available)' } else { $tid }; " +
              "ConnectionType = $c.ConnectionType " +
            "} | Format-List | Out-String " +
          "} catch { " +
            "'NOT CONNECTED — call a pnp_auth_connect_* tool first' " +
          "}",
        timeoutMs: 15_000,
      });

      // B2: append a compact cached-connections summary so users (and Claude) can see what
      // pnp_auth_connect_* will fall back to when called with no `url` / `client_id`.
      const cached = loadState().lastConnections;
      if (cached.length) {
        const lines = ["", "--- Cached connections (B2) — pnp_auth_connect_* will reuse these when args are omitted:"];
        cached.slice(0, 5).forEach((c, i) => {
          const upn = c.upn ? ` as ${c.upn}` : "";
          const tenant = c.tenantId ? `, tenant ${c.tenantId}` : "";
          const cid = c.clientId ? `, clientId ${c.clientId.slice(0, 8)}…` : "";
          const ago = humanTimeAgo(c.lastUsed);
          lines.push(`  ${i + 1}. ${c.url}${upn} via ${c.authMethod} (${c.successCount}× successful, last ${ago}${tenant}${cid})`);
        });
        liveResult.content.push({ type: "text", text: lines.join("\n") });
      }

      // B5: append OS Identity Broker (Windows WAM) signed-in accounts. Empty on
      // macOS/Linux. Useful when no PnP cache yet exists — Claude can derive a
      // candidate URL from the broker's tenant default-domain mapping.
      const msal = readMsalAccounts();
      if (msal.length) {
        const lines = ["", "--- Signed-in M365 accounts in OS Identity Broker (B5):"];
        msal.slice(0, 5).forEach((a, i) => {
          const t = a.tenantId ? ` (tenant ${a.tenantId.slice(0, 8)}…)` : "";
          const sug = a.suggestedSpoUrls.length ? `, suggested SPO: ${a.suggestedSpoUrls[0]}` : "";
          lines.push(`  ${i + 1}. ${a.upn ?? "(unknown UPN)"}${t}${sug}`);
        });
        liveResult.content.push({ type: "text", text: lines.join("\n") });
      }
      return liveResult;
    },
  );

  // Graceful shutdown
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, async () => {
      log("info", "shutdown signal", { signal: sig });
      killAllRunning();
      await stopSession();
      process.exit(0);
    });
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Eagerly start the pwsh session so the first tool call doesn't pay the cold-start cost.
  // If this fails (e.g. PnP module not installed), tool calls will fail with the same clear
  // error message — startup just surfaces the problem earlier.
  void getSession().start().catch(err => {
    log("error", "pwsh session pre-warm failed", { error: (err as Error).message });
  });

  log("info", "server started", {
    version: VERSION,
    pid: process.pid,
    safeMode: safeModeEnabled(),
    logDir: getLogDir(),
    platform: process.platform,
    node: process.version,
  });
  // A4 fix: Claude Desktop's `mcp-server-pnp.log` only captures MCP protocol traffic, not
  // pwsh stderr or our internal log lines. Print our log path to MCP-server stderr at
  // startup so users hunting for diagnostics know exactly where to look. Claude Desktop
  // captures stderr too — this line ends up in `mcp.log`, which is the right place for it.
  // Privacy: replace the home-dir prefix with `~` so users can safely share their mcp.log
  // for debugging without leaking the OS username.
  const home = homedir();
  const displayLogDir = getLogDir().startsWith(home) ? "~" + getLogDir().slice(home.length) : getLogDir();
  process.stderr.write(`[pnp-mcp] v${VERSION} started — logs at ${displayLogDir}\n`);
}

// Helper for smoke-test introspection: also export a function that just runs one command
// against the session without going through MCP. (Not part of the public MCP API.)
export async function _runPnpForTest(command: string, timeoutMs?: number) {
  return runPnp(command, { timeoutMs });
}
