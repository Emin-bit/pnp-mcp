// tenant-safety.ts — pre-flight guards for destructive PnP operations.
//
// Why this exists: PnP MCP shares the same risk class as the Power Platform MCP
// (where a real user once imported a solution into the wrong tenant because the
// active auth profile had silently changed). For PnP, the analogous risk is
// running a destructive cmdlet against the WRONG SharePoint site or tenant —
// e.g. running `Remove-PnPTenantSite` against contoso-prod when you thought you
// were on contoso-dev, or applying a destructive provisioning template to the
// wrong tenant.
//
// Phase G (1.2.0). Mirrors the power-platform-mcp Phase F `solution_import`
// hardening, adapted to PnP's connection model:
//   - Power Platform: `pac env who` returns the active env URL.
//   - PnP: `Get-PnPConnection` returns the active connection's .Url property,
//     plus AccountName, ClientId, TenantId.
//
// The guard is OPT-IN — destructive tools that adopt it accept either
// `expected_url` (exact URL match, normalized) or `expected_tenant_substring`
// (case-insensitive substring on the rendered connection). When the caller
// supplies neither, the tool keeps its prior behavior so existing scripts
// don't break.

import { runPnp } from "./pwsh.js";
import { log } from "./logger.js";

export interface TenantSafetyArgs {
  expected_url?: string;
  expected_tenant_substring?: string;
}

export type TenantSafetyResult =
  | { ok: true; activeUrl?: string; activeTenantId?: string }
  | { ok: false; blockMessage: string };

/**
 * If either expected_* arg is set, run Get-PnPConnection and verify the active
 * connection matches. Returns a structured result the caller turns into a
 * BLOCKED ToolResult.
 *
 * URL matching policy: parse both sides as URLs, compare ORIGIN exactly
 * (scheme + host, lowercased). This blocks the contoso-vs-contoso-dev false
 * match that pure substring would let through.
 *
 * Tenant-substring matching policy: case-insensitive substring on the rendered
 * "Url | AccountName | ClientId | TenantId" string. Useful when the user knows
 * the tenant name but not the exact site URL ("dccs", "contoso.onmicrosoft").
 * Minimum 4 characters to prevent accidental short matches.
 */
export async function verifyPnpConnection(
  toolName: string,
  args: TenantSafetyArgs,
): Promise<TenantSafetyResult> {
  if (!args.expected_url && !args.expected_tenant_substring) {
    return { ok: true };
  }

  // Get-PnPConnection throws when no connection exists, so we wrap in try/catch
  // inside PowerShell rather than relying on PS's error-action preference.
  const inspectScript =
    "try { " +
      "$c = Get-PnPConnection -ErrorAction Stop; " +
      "[pscustomobject]@{ Url=$c.Url; AccountName=$c.AccountName; ClientId=$c.ClientId; TenantId=$c.TenantId } | ConvertTo-Json -Compress " +
    "} catch { " +
      "'NOT_CONNECTED:' + $_.Exception.Message " +
    "}";

  const result = await runPnp(inspectScript, { timeoutMs: 15_000 });

  if (result.exitCode !== 0) {
    return {
      ok: false,
      blockMessage:
        `🛑 TENANT-SAFETY pre-flight FAILED for ${toolName}: Get-PnPConnection returned exit ${result.exitCode}. ` +
        `Cannot verify the active connection before running this destructive operation.\n` +
        `stderr: ${(result.stderr ?? "").slice(0, 300)}\n` +
        `Fix: call pnp_session_status first to see what's wrong, then re-authenticate via pnp_auth_connect_* if needed.`,
    };
  }

  const stdout = result.stdout.trim();
  if (stdout.startsWith("NOT_CONNECTED:")) {
    return {
      ok: false,
      blockMessage:
        `🛑 TENANT-SAFETY BLOCK for ${toolName}: NO active PnP connection. Cannot run a destructive ` +
        `operation against an unknown site. Call pnp_auth_connect_* first.\n` +
        `Raw: ${stdout.slice(0, 300)}`,
    };
  }

  let connection: { Url?: string; AccountName?: string; ClientId?: string; TenantId?: string } = {};
  try {
    connection = JSON.parse(stdout) as typeof connection;
  } catch {
    return {
      ok: false,
      blockMessage:
        `🛑 TENANT-SAFETY pre-flight FAILED for ${toolName}: could not parse Get-PnPConnection output. ` +
        `Raw: ${stdout.slice(0, 300)}`,
    };
  }

  const activeUrl = (connection.Url ?? "").trim();
  const rendered = [connection.Url, connection.AccountName, connection.ClientId, connection.TenantId]
    .filter(Boolean)
    .join(" | ");

  if (args.expected_url) {
    let wantOrigin: string | null = null;
    let haveOrigin: string | null = null;
    try { wantOrigin = new URL(args.expected_url).origin.toLowerCase(); } catch { /* fall through */ }
    try { haveOrigin = new URL(activeUrl).origin.toLowerCase(); } catch { /* fall through */ }

    if (!wantOrigin) {
      return {
        ok: false,
        blockMessage:
          `🛑 TENANT-SAFETY: expected_url='${args.expected_url}' is not a parseable URL. ` +
          `Pass a full URL like 'https://contoso.sharepoint.com/sites/marketing'.`,
      };
    }
    if (!haveOrigin) {
      return {
        ok: false,
        blockMessage:
          `🛑 TENANT-SAFETY BLOCK for ${toolName}: active connection has no usable URL ` +
          `(Get-PnPConnection returned '${activeUrl}'). REFUSING to run.\nActive connection: ${rendered}`,
      };
    }
    // Compare origins. Optionally also verify the site path if the expected URL
    // includes one — `/sites/X` mismatch is also a tenant-class error.
    const wantPath = new URL(args.expected_url).pathname.replace(/\/+$/, "");
    const havePath = (() => { try { return new URL(activeUrl).pathname.replace(/\/+$/, ""); } catch { return ""; } })();
    if (wantOrigin !== haveOrigin || (wantPath && havePath && wantPath.toLowerCase() !== havePath.toLowerCase())) {
      return {
        ok: false,
        blockMessage:
          `🛑 TENANT-SAFETY BLOCK for ${toolName}: expected_url='${args.expected_url}' does NOT match active connection. REFUSING to run.\n\n` +
          `Want: ${wantOrigin}${wantPath}\n` +
          `Have: ${haveOrigin}${havePath}\n\n` +
          `Active connection: ${rendered}\n\n` +
          `Fix: either (a) call pnp_auth_connect_* to switch to the right site, OR (b) update the expected_url arg to match the active target.`,
      };
    }
  }

  if (args.expected_tenant_substring) {
    if (args.expected_tenant_substring.length < 4) {
      return {
        ok: false,
        blockMessage:
          `🛑 TENANT-SAFETY: expected_tenant_substring='${args.expected_tenant_substring}' must be at least 4 ` +
          `characters to avoid accidental matches on common short strings.`,
      };
    }
    if (!rendered.toLowerCase().includes(args.expected_tenant_substring.toLowerCase())) {
      return {
        ok: false,
        blockMessage:
          `🛑 TENANT-SAFETY BLOCK for ${toolName}: expected_tenant_substring='${args.expected_tenant_substring}' ` +
          `does NOT appear in the active connection (${rendered}). REFUSING to run.`,
      };
    }
  }

  log("info", "tenant-safety pre-flight OK", { toolName, activeUrl, activeTenantId: connection.TenantId ?? null });
  return { ok: true, activeUrl, activeTenantId: connection.TenantId };
}
