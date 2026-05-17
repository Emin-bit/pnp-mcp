// Tenant-level settings (Get-PnPTenant / Set-PnPTenant).
//
// Set-PnPTenant has 200+ named parameters covering sharing, conditional access, OneDrive
// quotas, anonymous links, B2B, etc. We expose:
//   • pnp_tenant_get      → returns ALL tenant settings as JSON (read-only, common case)
//   • pnp_tenant_set      → typed wrapper for the most-used settings, plus a passthrough
//                            via the generic `pnp_run` for niche params.
// We intentionally do NOT enumerate all 200 parameters — that would be a fragile,
// rapidly-stale schema. For settings not exposed here, use pnp_run with the appropriate
// Set-PnPTenant -ParamName ... arguments (still subject to safe-mode confirm gate via
// the safety detection of `Set-PnPTenant` as a destructive cmdlet).

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { psQuote } from "../util.js";

// A pragmatic projection of common Get-PnPTenant fields. We pipe to ConvertTo-Json -Depth 3
// to avoid over-fetching SharePoint internals.
const TENANT_PROJECTION =
  "SharingCapability, DefaultSharingLinkType, DefaultLinkPermission, " +
  "ExternalServicesEnabled, RequireAcceptingAccountMatchInvitedAccount, " +
  "PreventExternalUsersFromResharing, ShowEveryoneClaim, ShowAllUsersClaim, " +
  "ShowEveryoneExceptExternalUsersClaim, FileAnonymousLinkType, FolderAnonymousLinkType, " +
  "RequireAnonymousLinksExpireInDays, OneDriveStorageQuota, OneDriveSharingCapability, " +
  "OneDriveForGuestsEnabled, NotifyOwnersWhenItemsReshared, NotifyOwnersWhenInvitationsAccepted, " +
  "ConditionalAccessPolicy, IPAddressEnforcement, IPAddressAllowList, " +
  "LegacyAuthProtocolsEnabled, DisableAddToOneDrive, BccExternalSharingInvitations, " +
  "BccExternalSharingInvitationsList, RecycleBinRetentionPeriod, " +
  "MajorVersionLimit, ExpireVersionsAfterDays, EnableAutoExpirationVersionTrim";

const SharingCapability = z.enum([
  "Disabled",
  "ExternalUserSharingOnly",
  "ExternalUserAndGuestSharing",
  "ExistingExternalUserSharingOnly",
]);

const DefaultSharingLinkType = z.enum([
  "None",
  "Direct",
  "Internal",
  "AnonymousAccess",
]);

const DefaultLinkPermission = z.enum(["None", "View", "Edit"]);

const FileAnonymousLinkType = z.enum(["None", "View", "Edit"]);
const FolderAnonymousLinkType = z.enum(["None", "View", "Edit"]);

const ConditionalAccessPolicy = z.enum([
  "AllowFullAccess",
  "AllowLimitedAccess",
  "BlockAccess",
  "ProtectionLevel",
  "AuthenticationContext",
]);

export function registerTenant(server: McpServer) {
  // ============================================================================
  // pnp_tenant_get — read-only tenant settings
  // ============================================================================
  server.tool(
    "pnp_tenant_get",
    "Get tenant-level SharePoint Online settings via Get-PnPTenant. Returns a curated JSON projection of the most commonly inspected fields (sharing caps, default link permissions, anonymous links, OneDrive defaults, conditional access, IP enforcement, version retention). " +
    "Requires SharePoint admin role. Use `full=true` to get the COMPLETE settings object — much larger payload but useful when looking for a niche setting.",
    {
      full: z.boolean().default(false).describe(
        "Return ALL fields from Get-PnPTenant instead of the curated projection. Larger output.",
      ),
    },
    async ({ full }): Promise<ToolResult> => {
      const cmd = full
        ? `Get-PnPTenant | ConvertTo-Json -Depth 5 -Compress`
        : `Get-PnPTenant | Select-Object ${TENANT_PROJECTION} | ConvertTo-Json -Depth 3 -Compress`;
      return runAsTool({
        toolName: "pnp_tenant_get",
        command: cmd,
        timeoutMs: 60_000,
      });
    },
  );

  // ============================================================================
  // pnp_tenant_set — typed wrapper for common settings
  // ============================================================================
  server.tool(
    "pnp_tenant_set",
    "Update tenant-level SharePoint Online settings via Set-PnPTenant. Exposes the most-changed settings as typed parameters. For niche settings not listed here (Set-PnPTenant has 200+ parameters), use pnp_run with the explicit Set-PnPTenant cmdlet — safety still applies. " +
    "DESTRUCTIVE for tenant policy: a wrong sharing-cap change can lock out external collaborators tenant-wide. Requires confirm=true.",
    {
      sharing_capability: SharingCapability.optional().describe(
        "Tenant-wide external sharing setting. Disabled = no external sharing at all.",
      ),
      default_sharing_link_type: DefaultSharingLinkType.optional().describe(
        "Default option presented in the Share dialog ('Anyone', 'People in your org', 'Specific people').",
      ),
      default_link_permission: DefaultLinkPermission.optional().describe(
        "Default permission level for newly created share links.",
      ),
      file_anonymous_link_type: FileAnonymousLinkType.optional().describe(
        "Default permission for anonymous (Anyone) file links.",
      ),
      folder_anonymous_link_type: FolderAnonymousLinkType.optional().describe(
        "Default permission for anonymous (Anyone) folder links.",
      ),
      require_anonymous_links_expire_in_days: z.number().int().optional().describe(
        "Force anonymous links to expire after N days. 0 = no expiration. Common: 30, 90.",
      ),
      conditional_access_policy: ConditionalAccessPolicy.optional(),
      legacy_auth_protocols_enabled: z.boolean().optional().describe(
        "Allow non-modern auth protocols. Microsoft recommends false for security.",
      ),
      one_drive_for_guests_enabled: z.boolean().optional(),
      bcc_external_sharing_invitations: z.boolean().optional(),
      bcc_external_sharing_invitations_list: z.string().optional().describe(
        "Comma-separated email list to BCC on external sharing invitations.",
      ),
      ip_address_enforcement: z.boolean().optional(),
      ip_address_allow_list: z.string().optional().describe(
        "Comma-separated CIDR list for IP enforcement.",
      ),
      recycle_bin_retention_period: z.number().int().optional().describe(
        "Recycle bin retention in days (default 93). Lower = faster permanent loss.",
      ),
      // Version retention (recent SP feature)
      major_version_limit: z.number().int().optional().describe(
        "Max major versions to keep per file (versioning hard cap).",
      ),
      expire_versions_after_days: z.number().int().optional().describe(
        "Days after which old versions are eligible for trim.",
      ),
      enable_auto_expiration_version_trim: z.boolean().optional(),
      confirm: z.boolean(),
      expected_tenant_substring: z.string().optional().describe(
        "Phase G tenant-safety: substring of the active connection (tenant id, account UPN, or admin URL) " +
        "that MUST be present, otherwise the change is refused. STRONGLY RECOMMENDED for production " +
        "tenant-policy changes — these are TENANT-WIDE and irreversible at the policy level. Min 4 chars.",
      ),
      expected_url: z.string().optional().describe(
        "Phase G tenant-safety: alternative to expected_tenant_substring — full admin URL match.",
      ),
    },
    async (a): Promise<ToolResult> => {
      if (!a.confirm) {
        return {
          isError: true,
          content: [{
            type: "text",
            text:
              "BLOCKED: pnp_tenant_set changes TENANT-WIDE SharePoint policy. A wrong sharing-cap or " +
              "anonymous-link change can lock out external collaborators across the whole tenant. " +
              "Re-call with confirm=true after pnp_tenant_get confirms current state. " +
              "STRONGLY RECOMMENDED: pass `expected_tenant_substring` (e.g. tenant id fragment) so the tool " +
              "verifies the active connection BEFORE applying the change.",
          }],
        };
      }

      // Phase G tenant-safety pre-flight (tenant-wide policy changes are the highest blast radius).
      if (a.expected_url || a.expected_tenant_substring) {
        const { verifyPnpConnection } = await import("../tenant-safety.js");
        const check = await verifyPnpConnection("pnp_tenant_set", {
          expected_url: a.expected_url,
          expected_tenant_substring: a.expected_tenant_substring,
        });
        if (!check.ok) {
          return { isError: true, content: [{ type: "text", text: check.blockMessage }] };
        }
      }

      // Build the Set-PnPTenant command from provided params
      const parts: string[] = ["Set-PnPTenant"];
      const pushParam = (name: string, value: unknown) => {
        if (value === undefined) return;
        if (typeof value === "boolean") {
          parts.push(`-${name}:$${value}`);
        } else if (typeof value === "number") {
          parts.push(`-${name} ${value}`);
        } else {
          parts.push(`-${name} ${psQuote(String(value))}`);
        }
      };

      pushParam("SharingCapability", a.sharing_capability);
      pushParam("DefaultSharingLinkType", a.default_sharing_link_type);
      pushParam("DefaultLinkPermission", a.default_link_permission);
      pushParam("FileAnonymousLinkType", a.file_anonymous_link_type);
      pushParam("FolderAnonymousLinkType", a.folder_anonymous_link_type);
      pushParam("RequireAnonymousLinksExpireInDays", a.require_anonymous_links_expire_in_days);
      pushParam("ConditionalAccessPolicy", a.conditional_access_policy);
      pushParam("LegacyAuthProtocolsEnabled", a.legacy_auth_protocols_enabled);
      pushParam("OneDriveForGuestsEnabled", a.one_drive_for_guests_enabled);
      pushParam("BccExternalSharingInvitations", a.bcc_external_sharing_invitations);
      pushParam("BccExternalSharingInvitationsList", a.bcc_external_sharing_invitations_list);
      pushParam("IPAddressEnforcement", a.ip_address_enforcement);
      pushParam("IPAddressAllowList", a.ip_address_allow_list);
      pushParam("RecycleBinRetentionPeriod", a.recycle_bin_retention_period);
      pushParam("MajorVersionLimit", a.major_version_limit);
      pushParam("ExpireVersionsAfterDays", a.expire_versions_after_days);
      pushParam("EnableAutoExpirationVersionTrim", a.enable_auto_expiration_version_trim);

      if (parts.length === 1) {
        return {
          isError: true,
          content: [{ type: "text", text: "No tenant settings provided to update. Pass at least one parameter (sharing_capability, default_link_permission, ...)." }],
        };
      }

      // Verify by fetching the new state after the change. CRUCIAL: use try/catch with
      // -ErrorAction Stop so a failed Set-PnPTenant short-circuits and we don't mislead
      // the caller with the OLD state from a follow-up Get-PnPTenant.
      const setCmd = parts.join(" ") + " -ErrorAction Stop";
      const cmd =
        `try { ` +
          `${setCmd}; ` +
          `Get-PnPTenant | Select-Object ${TENANT_PROJECTION} | ConvertTo-Json -Depth 3 -Compress ` +
        `} catch { ` +
          `Write-Output ('ERROR: Set-PnPTenant failed: ' + $_.Exception.Message); ` +
          `Write-Output 'Tenant state was NOT changed (Set-PnPTenant threw before applying).'; ` +
          `throw ` + // re-throw so MCP-level error reporting fires
        `}`;

      return runAsTool({
        toolName: "pnp_tenant_set",
        command: cmd,
        timeoutMs: 5 * 60_000,
        hint: "Tenant changes can take several minutes to propagate across the SharePoint backend. The returned state reflects what the API now reports — UI changes may lag.",
      });
    },
  );
}
