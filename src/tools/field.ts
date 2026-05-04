// Field (site column / list column) management — Get/Add/Set/Remove-PnPField.
//
// Fields can be at site scope (omit `list`) or list scope (set `list`). Site fields can
// be added to multiple content types and lists; list fields are scoped to one list.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { psQuote, psHashtable } from "../util.js";

const FIELD_PROJECTION =
  "Id, InternalName, Title, TypeAsString, Description, Group, Required, Hidden, " +
  "ReadOnlyField, EnforceUniqueValues, Indexed, DefaultValue, SchemaXml";

// FieldType enum values that are USER-CREATABLE via Add-PnPField. Verified against
// `[System.Enum]::GetNames([Microsoft.SharePoint.Client.FieldType])` on PnP 3.1.
//
// NOT in this enum (verified absent in live PnP 3.1 enum or not creatable via this cmdlet):
//   • UserMulti, LookupMulti, MultiChoice  — for multi-value, use base type (User/Lookup/Choice)
//                                            then `pnp_field_set values: { AllowMultipleValues: true }`
//   • Image                                — does not exist in the live FieldType enum
//   • TaxonomyFieldType, TaxonomyFieldTypeMulti — managed metadata fields require
//                                                  Add-PnPTaxonomyField (separate cmdlet)
// For other rare types not in this list, use pnp_run with Add-PnPField directly.
// @verify-enum [Microsoft.SharePoint.Client.FieldType]
const FIELD_TYPES = z.enum([
  "Text", "Note", "Number", "Currency", "DateTime", "Boolean",
  "Choice", "User", "Lookup", "URL", "Guid",
  "Calculated", "Computed", "Counter", "Integer",
  "Geolocation", "Recurrence", "ContentTypeId",
  // Less common but valid in the live enum:
  "WorkflowStatus", "AllDayEvent", "WorkflowEventType", "Attachments",
]);

export function registerField(server: McpServer) {
  server.tool(
    "pnp_field_list",
    "List fields (columns) at the site or list level. Without `list`, returns site columns. " +
    "With `list`, returns columns scoped to that list. Set `in_site_hierarchy: true` to include parent web fields.",
    {
      list: z.string().optional(),
      group: z.string().optional().describe("Filter by field group (e.g. 'Custom Columns')"),
      in_site_hierarchy: z.boolean().default(false),
    },
    async ({ list, group, in_site_hierarchy }): Promise<ToolResult> => {
      const parts = ["Get-PnPField"];
      if (list) parts.push(`-List ${psQuote(list)}`);
      if (group) parts.push(`-Group ${psQuote(group)}`);
      if (in_site_hierarchy) parts.push("-InSiteHierarchy");
      const cmd = parts.join(" ") + ` | Select-Object ${FIELD_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_field_list", command: cmd, timeoutMs: 60_000 });
    },
  );

  server.tool(
    "pnp_field_get",
    "Get one field by internal name, display name, or ID.",
    {
      identity: z.string().describe("Field internal name, display name, or GUID"),
      list: z.string().optional(),
    },
    async ({ identity, list }): Promise<ToolResult> => {
      const parts = [`Get-PnPField -Identity ${psQuote(identity)}`];
      if (list) parts.push(`-List ${psQuote(list)}`);
      const cmd = parts.join(" ") + ` | Select-Object ${FIELD_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_field_get", command: cmd, timeoutMs: 30_000 });
    },
  );

  server.tool(
    "pnp_field_add",
    "Create a new field. Specify `display_name`, `internal_name`, and `type`. For Choice/MultiChoice fields, use pnp_run for full schema XML — this typed tool covers basic types only.",
    {
      display_name: z.string().describe("User-visible name"),
      internal_name: z.string().describe("Programmatic name (no spaces, no special chars). Becomes the column's logical identifier."),
      type: FIELD_TYPES,
      list: z.string().optional().describe("List scope; omit for site column"),
      group: z.string().optional().describe("Field group (e.g. 'Custom Columns')"),
      id: z.string().optional().describe("Optional explicit GUID for the field"),
      required: z.boolean().default(false),
      add_to_default_view: z.boolean().default(false).describe(
        "(list-scoped only) Also add the field to the list's default view.",
      ),
      add_to_all_content_types: z.boolean().default(false).describe(
        "(list-scoped only) Add to every CT on the list.",
      ),
      confirm: z.boolean(),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_field_add modifies site/list schema. Re-call with confirm=true." }] };
      const parts = [
        `Add-PnPField -DisplayName ${psQuote(a.display_name)} -InternalName ${psQuote(a.internal_name)} -Type ${a.type}`,
      ];
      if (a.list) parts.push(`-List ${psQuote(a.list)}`);
      // PnP parameter-set quirk: `-Group` exists ONLY in the LIST-scoped parameter set of
      // Add-PnPField. For SITE columns (no -List), passing -Group fails with
      // "parameter set cannot be resolved". When the user wants to set Group on a site
      // column we chain a Set-PnPField -Values @{Group='...'} after creation.
      const needsPostGroupSet = !a.list && !!a.group;
      if (a.list && a.group) parts.push(`-Group ${psQuote(a.group)}`);
      if (a.id) parts.push(`-Id ${psQuote(a.id)}`);
      if (a.required) parts.push("-Required");
      if (a.add_to_default_view) parts.push("-AddToDefaultView");
      if (a.add_to_all_content_types) parts.push("-AddToAllContentTypes");
      const baseCmd = parts.join(" ");
      // For site-scoped fields with `group`, follow up with Set-PnPField to apply Group.
      const fullCmd = needsPostGroupSet
        ? `${baseCmd} | Out-Null; ` +
          `Set-PnPField -Identity ${psQuote(a.internal_name)} -Values @{'Group'=${psQuote(a.group!)}} | Out-Null; ` +
          `Get-PnPField -Identity ${psQuote(a.internal_name)} | Select-Object ${FIELD_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`
        : `${baseCmd} | Select-Object ${FIELD_PROJECTION} | ConvertTo-Json -Depth 5 -Compress`;
      return runAsTool({ toolName: "pnp_field_add", command: fullCmd, timeoutMs: 60_000 });
    },
  );

  server.tool(
    "pnp_field_set",
    "Update an existing field's properties via -Values hashtable. Common keys: Title, Description, Group, Required, Hidden, ShowInListSettings, Indexed, EnforceUniqueValues. " +
    "For complex schema changes (formula, lookup target), use pnp_run with the field's SchemaXml.",
    {
      identity: z.string(),
      list: z.string().optional(),
      values: z.record(z.unknown()).describe(
        "Field properties to update. Example: { Title: 'New Display Name', Required: true, Description: 'Updated' }",
      ),
      update_existing_lists: z.boolean().default(false).describe(
        "(site-scope only) Push changes to all lists currently using this field.",
      ),
      confirm: z.boolean(),
    },
    async ({ identity, list, values, update_existing_lists, confirm }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_field_set modifies field configuration. Re-call with confirm=true." }] };
      if (!values || Object.keys(values).length === 0) {
        return { isError: true, content: [{ type: "text", text: "No values provided to update." }] };
      }
      const parts = [
        `Set-PnPField -Identity ${psQuote(identity)} -Values ${psHashtable(values as Record<string, unknown>)}`,
      ];
      if (list) parts.push(`-List ${psQuote(list)}`);
      if (update_existing_lists) parts.push("-UpdateExistingLists");
      const cmd =
        `try { ${parts.join(" ")} -ErrorAction Stop; ` +
        `Get-PnPField -Identity ${psQuote(identity)}${list ? ` -List ${psQuote(list)}` : ""} | Select-Object ${FIELD_PROJECTION} | ConvertTo-Json -Depth 5 -Compress } ` +
        `catch { Write-Output ('ERROR: Set-PnPField failed: ' + $_.Exception.Message); throw }`;
      return runAsTool({ toolName: "pnp_field_set", command: cmd, timeoutMs: 2 * 60_000 });
    },
  );

  server.tool(
    "pnp_field_remove",
    "DESTRUCTIVE: delete a field. Will fail if the field is referenced by content types unless those references are removed first.",
    {
      identity: z.string(),
      list: z.string().optional(),
      confirm: z.boolean(),
    },
    async ({ identity, list, confirm }): Promise<ToolResult> => {
      if (!confirm) return { isError: true, content: [{ type: "text", text: "BLOCKED: pnp_field_remove deletes a column. Existing data in this column will be lost. Re-call with confirm=true." }] };
      const parts = [`Remove-PnPField -Identity ${psQuote(identity)} -Force`];
      if (list) parts.push(`-List ${psQuote(list)}`);
      return runAsTool({ toolName: "pnp_field_remove", command: parts.join(" "), timeoutMs: 60_000 });
    },
  );
}
