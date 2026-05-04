// Microsoft 365 Groups (formerly Office 365 Groups) — backing layer for Teams, Yammer,
// Outlook groups, Planner, etc. Different from SharePoint groups (covered in permission.ts).
//
// Group lifecycle: list / get / new / set / remove + owner add/remove + member add/remove.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { psQuote } from "../util.js";

const M365_GROUP_PROJECTION =
  "Id, DisplayName, MailNickname, Description, Mail, MailEnabled, SecurityEnabled, " +
  "Visibility, GroupTypes, ResourceProvisioningOptions, CreatedDateTime, " +
  "RenewedDateTime, ExpirationDateTime, IsAssignableToRole";

export function registerM365Group(server: McpServer) {
  // ============================================================================
  // pnp_m365group_list — list all M365 Groups in the tenant
  // ============================================================================
  server.tool(
    "pnp_m365group_list",
    "List all Microsoft 365 Groups in the tenant. Use `detailed: true` to also load owners + site URL (slower). Returns id, display name, mail nickname, visibility, types.",
    {
      detailed: z.boolean().default(false),
      include_owners: z.boolean().default(false),
      include_site_url: z.boolean().default(false),
      include_sensitivity_labels: z.boolean().default(false),
    },
    async ({ detailed, include_owners, include_site_url, include_sensitivity_labels }): Promise<ToolResult> => {
      const parts = ["Get-PnPMicrosoft365Group"];
      if (detailed) parts.push("-Detailed");
      if (include_owners) parts.push("-IncludeOwners");
      if (include_site_url) parts.push("-IncludeSiteUrl");
      if (include_sensitivity_labels) parts.push("-IncludeSensitivityLabels");
      const cmd = parts.join(" ") + ` | Select-Object ${M365_GROUP_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_m365group_list", command: cmd, timeoutMs: 2 * 60_000 });
    },
  );

  // ============================================================================
  // pnp_m365group_get — get one M365 Group
  // ============================================================================
  server.tool(
    "pnp_m365group_get",
    "Get details of one Microsoft 365 Group by ID, display name, or mail nickname.",
    {
      identity: z.string().describe("Group ID (GUID), display name, or mail nickname"),
      include_owners: z.boolean().default(false),
      include_site_url: z.boolean().default(false),
    },
    async ({ identity, include_owners, include_site_url }): Promise<ToolResult> => {
      const parts = [`Get-PnPMicrosoft365Group -Identity ${psQuote(identity)}`];
      if (include_owners) parts.push("-IncludeOwners");
      if (include_site_url) parts.push("-IncludeSiteUrl");
      const cmd = parts.join(" ") + ` | Select-Object ${M365_GROUP_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_m365group_get", command: cmd, timeoutMs: 60_000 });
    },
  );

  // ============================================================================
  // pnp_m365group_new — create a new M365 Group
  // ============================================================================
  server.tool(
    "pnp_m365group_new",
    "Create a new Microsoft 365 Group. The group also creates a SharePoint site, an Outlook mailbox, and (optionally with `create_team: true`) a Microsoft Teams team. " +
    "DESTRUCTIVE: creates real M365 resources, counts against tenant quotas. Requires confirm=true.",
    {
      display_name: z.string().describe("User-visible group name"),
      mail_nickname: z.string().describe("Email alias (no spaces, no special chars). Becomes the mailbox prefix."),
      description: z.string().describe("Required by PnP — can be a one-liner"),
      owners: z.array(z.string()).optional().describe("UPN list of group owners"),
      is_private: z.boolean().default(false).describe("Private group (default: public)"),
      hide_from_address_lists: z.boolean().optional(),
      hide_from_outlook_clients: z.boolean().optional(),
      create_team: z.boolean().default(false).describe(
        "Also create a Microsoft Teams team backed by this group",
      ),
      logo_path: z.string().optional().describe("Local path to a logo image file"),
      sensitivity_labels: z.array(z.string()).optional().describe("Sensitivity label GUID(s) to apply"),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "BLOCKED: pnp_m365group_new creates a real Microsoft 365 Group (mailbox + SharePoint site + optional Teams team), counts against tenant resources. Re-call with confirm=true.",
          }],
        };
      }
      const parts = [
        `New-PnPMicrosoft365Group -DisplayName ${psQuote(a.display_name)} -MailNickname ${psQuote(a.mail_nickname)} -Description ${psQuote(a.description)} -Force`,
      ];
      if (a.owners && a.owners.length) {
        const list = a.owners.map(o => psQuote(o)).join(",");
        parts.push(`-Owners @(${list})`);
      }
      if (a.is_private) parts.push("-IsPrivate");
      if (a.hide_from_address_lists !== undefined) parts.push(`-HideFromAddressLists:$${a.hide_from_address_lists}`);
      if (a.hide_from_outlook_clients !== undefined) parts.push(`-HideFromOutlookClients:$${a.hide_from_outlook_clients}`);
      if (a.create_team) parts.push("-CreateTeam");
      if (a.logo_path) parts.push(`-LogoPath ${psQuote(a.logo_path)}`);
      if (a.sensitivity_labels && a.sensitivity_labels.length) {
        const list = a.sensitivity_labels.map(s => psQuote(s)).join(",");
        parts.push(`-SensitivityLabels @(${list})`);
      }
      const cmd = parts.join(" ") + ` | Select-Object ${M365_GROUP_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({
        toolName: "pnp_m365group_new",
        command: cmd,
        timeoutMs: 5 * 60_000,
        hint: "Group created. Note: SharePoint site and (if requested) Teams team may take a few minutes to fully provision.",
      });
    },
  );

  // ============================================================================
  // pnp_m365group_set — update properties
  // ============================================================================
  server.tool(
    "pnp_m365group_set",
    "Update properties on a Microsoft 365 Group (display name, description, visibility, owners, members, sensitivity labels). " +
    "`create_team` retroactively backs the group with a Teams team.",
    {
      identity: z.string().describe("Group ID, display name, or mail nickname"),
      display_name: z.string().optional(),
      description: z.string().optional(),
      mail_nickname: z.string().optional(),
      is_private: z.boolean().optional(),
      hide_from_address_lists: z.boolean().optional(),
      hide_from_outlook_clients: z.boolean().optional(),
      allow_external_senders: z.boolean().optional(),
      auto_subscribe_new_members: z.boolean().default(false),
      create_team: z.boolean().default(false),
      owners: z.array(z.string()).optional().describe("REPLACE the owner set with this list"),
      members: z.array(z.string()).optional().describe("REPLACE the member set with this list"),
      logo_path: z.string().optional(),
      sensitivity_labels: z.array(z.string()).optional(),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_m365group_set modifies group configuration. Re-call with confirm=true." }] };
      const parts = [`Set-PnPMicrosoft365Group -Identity ${psQuote(a.identity)}`];
      if (a.display_name) parts.push(`-DisplayName ${psQuote(a.display_name)}`);
      if (a.description) parts.push(`-Description ${psQuote(a.description)}`);
      if (a.mail_nickname) parts.push(`-MailNickname ${psQuote(a.mail_nickname)}`);
      if (a.is_private) parts.push("-IsPrivate");
      if (a.hide_from_address_lists !== undefined) parts.push(`-HideFromAddressLists:$${a.hide_from_address_lists}`);
      if (a.hide_from_outlook_clients !== undefined) parts.push(`-HideFromOutlookClients:$${a.hide_from_outlook_clients}`);
      if (a.allow_external_senders !== undefined) parts.push(`-AllowExternalSenders:$${a.allow_external_senders}`);
      if (a.auto_subscribe_new_members) parts.push("-AutoSubscribeNewMembers");
      if (a.create_team) parts.push("-CreateTeam");
      if (a.owners && a.owners.length) parts.push(`-Owners @(${a.owners.map(o => psQuote(o)).join(",")})`);
      if (a.members && a.members.length) parts.push(`-Members @(${a.members.map(m => psQuote(m)).join(",")})`);
      if (a.logo_path) parts.push(`-LogoPath ${psQuote(a.logo_path)}`);
      if (a.sensitivity_labels && a.sensitivity_labels.length) {
        parts.push(`-SensitivityLabels @(${a.sensitivity_labels.map(s => psQuote(s)).join(",")})`);
      }
      if (parts.length === 1) {
        return { isError: true, content: [{ type: "text", text: "No properties provided to update." }] };
      }
      const cmd =
        `try { ${parts.join(" ")} -ErrorAction Stop; ` +
        `Get-PnPMicrosoft365Group -Identity ${psQuote(a.identity)} | Select-Object ${M365_GROUP_PROJECTION} | ConvertTo-Json -Depth 5 -Compress } ` +
        `catch { Write-Output ('ERROR: Set-PnPMicrosoft365Group failed: ' + $_.Exception.Message); throw }`;
      return runAsTool({ toolName: "pnp_m365group_set", command: cmd, timeoutMs: 2 * 60_000 });
    },
  );

  // ============================================================================
  // pnp_m365group_remove — delete a M365 Group
  // ============================================================================
  server.tool(
    "pnp_m365group_remove",
    "DESTRUCTIVE: delete a Microsoft 365 Group. ALSO deletes the backing mailbox, SharePoint site, Teams team (if any), Planner board. " +
    "Group is soft-deleted for 30 days (Entra ID retention) — recoverable via Restore-PnPDeletedMicrosoft365Group within that window.",
    {
      identity: z.string(),
      confirm: z.boolean(),
    },
    async ({ identity, confirm }): Promise<ToolResult> => {
      if (!confirm) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "BLOCKED: pnp_m365group_remove deletes the group AND its mailbox, SharePoint site, Teams team, and Planner board. Re-call with confirm=true. (30-day soft-delete recovery window.)",
          }],
        };
      }
      const cmd = `Remove-PnPMicrosoft365Group -Identity ${psQuote(identity)}`;
      return runAsTool({ toolName: "pnp_m365group_remove", command: cmd, timeoutMs: 5 * 60_000 });
    },
  );

  // ============================================================================
  // pnp_m365group_owner_add — add owners to a group
  // ============================================================================
  server.tool(
    "pnp_m365group_owner_add",
    "Add one or more owners to a Microsoft 365 Group. Owners can manage the group, members, and content. " +
    "Use `replace: true` to REPLACE the existing owner set with this list (otherwise additive).",
    {
      identity: z.string(),
      users: z.array(z.string()).describe("UPN list (e.g. ['user1@contoso.com','user2@contoso.com'])"),
      replace: z.boolean().default(false).describe("Replace existing owners instead of adding"),
      confirm: z.boolean(),
    },
    async ({ identity, users, replace, confirm }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_m365group_owner_add modifies group ownership. Re-call with confirm=true." }] };
      const list = users.map(u => psQuote(u)).join(",");
      const parts = [`Add-PnPMicrosoft365GroupOwner -Identity ${psQuote(identity)} -Users @(${list})`];
      if (replace) parts.push("-RemoveExisting");
      return runAsTool({ toolName: "pnp_m365group_owner_add", command: parts.join(" "), timeoutMs: 60_000 });
    },
  );

  // ============================================================================
  // pnp_m365group_owner_remove — remove owners
  // ============================================================================
  server.tool(
    "pnp_m365group_owner_remove",
    "Remove one or more owners from a Microsoft 365 Group. The group must retain at least one owner — Entra ID rejects removing the last owner.",
    {
      identity: z.string(),
      users: z.array(z.string()),
      confirm: z.boolean(),
    },
    async ({ identity, users, confirm }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_m365group_owner_remove modifies group ownership. Re-call with confirm=true." }] };
      const list = users.map(u => psQuote(u)).join(",");
      const cmd = `Remove-PnPMicrosoft365GroupOwner -Identity ${psQuote(identity)} -Users @(${list})`;
      return runAsTool({ toolName: "pnp_m365group_owner_remove", command: cmd, timeoutMs: 60_000 });
    },
  );

  // ============================================================================
  // pnp_m365group_member_add — add members
  // ============================================================================
  server.tool(
    "pnp_m365group_member_add",
    "Add one or more members to a Microsoft 365 Group. Members can read group content; non-owners cannot manage the group itself.",
    {
      identity: z.string(),
      users: z.array(z.string()),
      replace: z.boolean().default(false),
      confirm: z.boolean(),
    },
    async ({ identity, users, replace, confirm }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_m365group_member_add modifies group membership. Re-call with confirm=true." }] };
      const list = users.map(u => psQuote(u)).join(",");
      const parts = [`Add-PnPMicrosoft365GroupMember -Identity ${psQuote(identity)} -Users @(${list})`];
      if (replace) parts.push("-RemoveExisting");
      return runAsTool({ toolName: "pnp_m365group_member_add", command: parts.join(" "), timeoutMs: 60_000 });
    },
  );

  // ============================================================================
  // pnp_m365group_member_remove — remove members
  // ============================================================================
  server.tool(
    "pnp_m365group_member_remove",
    "Remove one or more members from a Microsoft 365 Group.",
    {
      identity: z.string(),
      users: z.array(z.string()),
      confirm: z.boolean(),
    },
    async ({ identity, users, confirm }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_m365group_member_remove modifies group membership. Re-call with confirm=true." }] };
      const list = users.map(u => psQuote(u)).join(",");
      const cmd = `Remove-PnPMicrosoft365GroupMember -Identity ${psQuote(identity)} -Users @(${list})`;
      return runAsTool({ toolName: "pnp_m365group_member_remove", command: cmd, timeoutMs: 60_000 });
    },
  );
}
