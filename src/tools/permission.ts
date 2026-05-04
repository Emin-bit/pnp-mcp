// Permissions: SharePoint groups + role assignments at web/list/item scope.
//
// Two layers:
//   1. GROUPS — containers for users (SharePoint Groups, not M365 Groups). Groups have
//      a Title, Owner, members, and properties like AllowMembersEditMembership.
//   2. ROLES — Set-PnP{Web,List,ListItem}Permission grants/revokes a role definition
//      (Read / Contribute / Edit / Full Control / custom) for a User or Group at the
//      relevant scope.
//
// We DON'T expose user add/remove cmdlets directly here (Add-PnPUserToGroup,
// Remove-PnPUserFromGroup); use pnp_run for those. The most common workflow we DO
// cover: list/get groups, create/modify/delete groups, and grant/revoke roles.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { psQuote } from "../util.js";

const GROUP_PROJECTION =
  "Id, Title, Description, OwnerTitle, AllowMembersEditMembership, " +
  "AllowRequestToJoinLeave, AutoAcceptRequestToJoinLeave, OnlyAllowMembersViewMembership, " +
  "RequestToJoinLeaveEmailSetting";

const ROLE_PROJECTION =
  "Id, Name, Description, BasePermissions, RoleTypeKind, Hidden, Order";

const AssociatedGroupType = z.enum(["Members", "Owners", "Visitors"]);

export function registerPermission(server: McpServer) {
  // ============================================================================
  // GROUPS
  // ============================================================================

  server.tool(
    "pnp_group_list",
    "List SharePoint groups on the current web. Returns id, title, description, owner, and self-service membership settings.",
    {},
    async (): Promise<ToolResult> => {
      const cmd = `Get-PnPGroup | Select-Object ${GROUP_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_group_list", command: cmd, timeoutMs: 30_000 });
    },
  );

  server.tool(
    "pnp_group_get",
    "Get one SharePoint group by name or ID. Or use one of the associated-group convenience flags to get the web's default Members/Owners/Visitors group.",
    {
      identity: z.string().optional().describe("Group title or ID. Mutually exclusive with associated_group."),
      associated_group: AssociatedGroupType.optional().describe(
        "Get the web's default associated group: Members (Edit), Owners (Full Control), or Visitors (Read).",
      ),
    },
    async ({ identity, associated_group }): Promise<ToolResult> => {
      if (identity && associated_group) {
        return { isError: true, content: [{ type: "text", text: "Pass identity OR associated_group, not both." }] };
      }
      let cmd: string;
      if (associated_group === "Members") cmd = "Get-PnPGroup -AssociatedMemberGroup";
      else if (associated_group === "Owners") cmd = "Get-PnPGroup -AssociatedOwnerGroup";
      else if (associated_group === "Visitors") cmd = "Get-PnPGroup -AssociatedVisitorGroup";
      else if (identity) cmd = `Get-PnPGroup -Identity ${psQuote(identity)}`;
      else return { isError: true, content: [{ type: "text", text: "Pass either identity or associated_group." }] };
      cmd += ` | Select-Object ${GROUP_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_group_get", command: cmd, timeoutMs: 30_000 });
    },
  );

  server.tool(
    "pnp_group_new",
    "Create a new SharePoint group on the current web. To promote the new group to the web's default Members/Owners/Visitors group AFTER creation, follow up with pnp_group_set passing `set_associated_group` — the New-PnPGroup cmdlet itself does NOT have a -SetAssociatedGroup parameter.",
    {
      title: z.string(),
      owner: z.string().optional().describe("Owner UPN or login name (default: current user)"),
      description: z.string().optional(),
      allow_members_edit_membership: z.boolean().default(false),
      allow_request_to_join_leave: z.boolean().default(false),
      auto_accept_request_to_join_leave: z.boolean().default(false),
      request_to_join_email: z.string().optional().describe("Email for join requests (if enabled)"),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_group_new modifies the web's group structure. Re-call with confirm=true." }] };
      const parts = [`New-PnPGroup -Title ${psQuote(a.title)}`];
      if (a.owner) parts.push(`-Owner ${psQuote(a.owner)}`);
      if (a.description) parts.push(`-Description ${psQuote(a.description)}`);
      if (a.allow_members_edit_membership) parts.push("-AllowMembersEditMembership");
      if (a.allow_request_to_join_leave) parts.push("-AllowRequestToJoinLeave");
      if (a.auto_accept_request_to_join_leave) parts.push("-AutoAcceptRequestToJoinLeave");
      if (a.request_to_join_email) parts.push(`-RequestToJoinEmail ${psQuote(a.request_to_join_email)}`);
      const cmd = parts.join(" ") + ` | Select-Object ${GROUP_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_group_new", command: cmd, timeoutMs: 60_000 });
    },
  );

  server.tool(
    "pnp_group_set",
    "Update PROPERTIES on a SharePoint group (title, description, owner, membership settings, default-associated-group flag). " +
    "Note: this tool intentionally does NOT expose AddRole/RemoveRole — to grant/revoke role definitions on a group, use the canonical pnp_role_set_web tool with `group: <name>` and `add_roles: [...]`. " +
    "Keeping the role-grant path single-source-of-truth avoids two tools competing to do the same thing.",
    {
      identity: z.string().describe("Group title or ID"),
      title: z.string().optional(),
      description: z.string().optional(),
      owner: z.string().optional().describe("New owner UPN or login name"),
      allow_members_edit_membership: z.boolean().optional(),
      allow_request_to_join_leave: z.boolean().optional(),
      auto_accept_request_to_join_leave: z.boolean().optional(),
      only_allow_members_view_membership: z.boolean().optional(),
      set_associated_group: AssociatedGroupType.optional().describe(
        "Promote this group to the web's default Members/Owners/Visitors group.",
      ),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_group_set modifies group configuration. Re-call with confirm=true." }] };
      const parts = [`Set-PnPGroup -Identity ${psQuote(a.identity)}`];
      if (a.title) parts.push(`-Title ${psQuote(a.title)}`);
      if (a.description) parts.push(`-Description ${psQuote(a.description)}`);
      if (a.owner) parts.push(`-Owner ${psQuote(a.owner)}`);
      if (a.allow_members_edit_membership !== undefined) parts.push(`-AllowMembersEditMembership:$${a.allow_members_edit_membership}`);
      if (a.allow_request_to_join_leave !== undefined) parts.push(`-AllowRequestToJoinLeave:$${a.allow_request_to_join_leave}`);
      if (a.auto_accept_request_to_join_leave !== undefined) parts.push(`-AutoAcceptRequestToJoinLeave:$${a.auto_accept_request_to_join_leave}`);
      if (a.only_allow_members_view_membership !== undefined) parts.push(`-OnlyAllowMembersViewMembership:$${a.only_allow_members_view_membership}`);
      if (a.set_associated_group) parts.push(`-SetAssociatedGroup ${a.set_associated_group}`);
      if (parts.length === 1) {
        return { isError: true, content: [{ type: "text", text: "No properties provided." }] };
      }
      const cmd =
        `try { ${parts.join(" ")} -ErrorAction Stop; ` +
        `Get-PnPGroup -Identity ${psQuote(a.identity)} | Select-Object ${GROUP_PROJECTION} | ConvertTo-Json -Depth 5 -Compress } ` +
        `catch { Write-Output ('ERROR: Set-PnPGroup failed: ' + $_.Exception.Message); throw }`;
      return runAsTool({ toolName: "pnp_group_set", command: cmd, timeoutMs: 60_000 });
    },
  );

  server.tool(
    "pnp_group_remove",
    "DESTRUCTIVE: delete a SharePoint group. Members are NOT deleted — they're just removed from this group's membership.",
    {
      identity: z.string(),
      confirm: z.boolean(),
    },
    async ({ identity, confirm }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_group_remove deletes a SharePoint group. Re-call with confirm=true." }] };
      const cmd = `Remove-PnPGroup -Identity ${psQuote(identity)} -Force`;
      return runAsTool({ toolName: "pnp_group_remove", command: cmd, timeoutMs: 60_000 });
    },
  );

  // ============================================================================
  // ROLE DEFINITIONS (read-only inspection)
  // ============================================================================

  server.tool(
    "pnp_role_definition_list",
    "List role definitions available on the current web (Read, Contribute, Edit, Full Control, plus any custom roles). Read-only. Use these names with pnp_role_set_* tools.",
    {},
    async (): Promise<ToolResult> => {
      const cmd = `Get-PnPRoleDefinition | Select-Object ${ROLE_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_role_definition_list", command: cmd, timeoutMs: 30_000 });
    },
  );

  // ============================================================================
  // ROLE ASSIGNMENT — grant/revoke roles at web/list/item scope
  // ============================================================================

  server.tool(
    "pnp_role_set_web",
    "Grant or revoke a role on the current (or sub-) web. Pass either `user` (UPN/login) OR `group` (title/ID), not both.",
    {
      identity: z.string().optional().describe("Sub-web URL/ID (omit for current web)"),
      user: z.string().optional().describe("User UPN or login name (mutually exclusive with `group`)"),
      group: z.string().optional().describe("Group title or ID (mutually exclusive with `user`)"),
      add_roles: z.array(z.string()).optional().describe("Role definition name(s) to grant"),
      remove_roles: z.array(z.string()).optional().describe("Role definition name(s) to revoke"),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_role_set_web modifies web permissions. Re-call with confirm=true." }] };
      if ((!a.user && !a.group) || (a.user && a.group)) {
        return { isError: true, content: [{ type: "text", text: "Pass exactly one of `user` or `group`." }] };
      }
      const parts = ["Set-PnPWebPermission"];
      if (a.identity) parts.push(`-Identity ${psQuote(a.identity)}`);
      if (a.user) parts.push(`-User ${psQuote(a.user)}`);
      if (a.group) parts.push(`-Group ${psQuote(a.group)}`);
      if (a.add_roles && a.add_roles.length) {
        const list = a.add_roles.map(r => psQuote(r)).join(",");
        parts.push(`-AddRole @(${list})`);
      }
      if (a.remove_roles && a.remove_roles.length) {
        const list = a.remove_roles.map(r => psQuote(r)).join(",");
        parts.push(`-RemoveRole @(${list})`);
      }
      return runAsTool({ toolName: "pnp_role_set_web", command: parts.join(" "), timeoutMs: 60_000 });
    },
  );

  server.tool(
    "pnp_role_set_list",
    "Grant or revoke a role on a list/library. Use `add_role` / `remove_role` (single name; PnP's Set-PnPListPermission accepts one role per call). Pass either `user` OR `group`.",
    {
      identity: z.string().describe("List title, ID, or URL"),
      user: z.string().optional(),
      group: z.string().optional(),
      add_role: z.string().optional(),
      remove_role: z.string().optional(),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_role_set_list modifies list permissions. Re-call with confirm=true." }] };
      if ((!a.user && !a.group) || (a.user && a.group)) {
        return { isError: true, content: [{ type: "text", text: "Pass exactly one of `user` or `group`." }] };
      }
      if (!a.add_role && !a.remove_role) {
        return { isError: true, content: [{ type: "text", text: "Pass at least one of `add_role` or `remove_role`." }] };
      }
      const parts = [`Set-PnPListPermission -Identity ${psQuote(a.identity)}`];
      if (a.user) parts.push(`-User ${psQuote(a.user)}`);
      if (a.group) parts.push(`-Group ${psQuote(a.group)}`);
      if (a.add_role) parts.push(`-AddRole ${psQuote(a.add_role)}`);
      if (a.remove_role) parts.push(`-RemoveRole ${psQuote(a.remove_role)}`);
      return runAsTool({ toolName: "pnp_role_set_list", command: parts.join(" "), timeoutMs: 60_000 });
    },
  );

  server.tool(
    "pnp_role_set_listitem",
    "Grant/revoke a role on a single list item. Or set `inherit_permissions: true` to remove unique permissions and re-inherit from the parent list.",
    {
      list: z.string(),
      identity: z.number().int().positive().describe("List item ID"),
      user: z.string().optional(),
      group: z.string().optional(),
      add_role: z.string().optional(),
      remove_role: z.string().optional(),
      clear_existing: z.boolean().default(false).describe(
        "Remove all existing permissions before applying the new role.",
      ),
      inherit_permissions: z.boolean().default(false).describe(
        "Re-inherit from parent list (mutually exclusive with user/group/add_role).",
      ),
      system_update: z.boolean().default(false).describe(
        "Don't update Modified/ModifiedBy on the item (matches Set-PnPListItem -SystemUpdate semantics).",
      ),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_role_set_listitem modifies item-level permissions. Re-call with confirm=true." }] };
      // PnP's `Inherit` parameter set has only Identity, List, InheritPermissions, SystemUpdate.
      // Any other role-grant param + InheritPermissions = parameter-set-cannot-be-resolved error.
      if (a.inherit_permissions && (a.user || a.group || a.add_role || a.remove_role || a.clear_existing)) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "inherit_permissions is mutually exclusive with user/group/add_role/remove_role/clear_existing. " +
              "Pass inherit_permissions:true on its own to drop unique perms, or omit it to grant a role.",
          }],
        };
      }
      const parts = [`Set-PnPListItemPermission -List ${psQuote(a.list)} -Identity ${a.identity}`];
      if (a.inherit_permissions) {
        parts.push("-InheritPermissions");
      } else {
        if ((!a.user && !a.group) || (a.user && a.group)) {
          return { isError: true, content: [{ type: "text", text: "Pass exactly one of `user` or `group` (or set `inherit_permissions: true`)." }] };
        }
        if (a.user) parts.push(`-User ${psQuote(a.user)}`);
        if (a.group) parts.push(`-Group ${psQuote(a.group)}`);
        if (a.add_role) parts.push(`-AddRole ${psQuote(a.add_role)}`);
        if (a.remove_role) parts.push(`-RemoveRole ${psQuote(a.remove_role)}`);
        if (a.clear_existing) parts.push("-ClearExisting");
      }
      if (a.system_update) parts.push("-SystemUpdate");
      return runAsTool({ toolName: "pnp_role_set_listitem", command: parts.join(" "), timeoutMs: 60_000 });
    },
  );
}
