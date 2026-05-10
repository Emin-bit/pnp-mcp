// Read-only inspection of the OS Identity Broker cache (Windows only) to surface
// already-signed-in M365 accounts in preflight. Resolves friction #6 from the
// Windows UX report: the user had ONE signed-in account that PnP could silently
// reuse, but the MCP server had no visibility into it and asked them to type
// the URL + clientId by hand.
//
// Windows:
//   ~/AppData/Local/.IdentityService/V3AccountStore.json
// is plain JSON written by the Microsoft Identity Broker (WAM). Each "Account"
// entry includes username, displayName, tenantId, and a default-domain mapping.
// We read it best-effort — failure is silent and surfaces as "no cached
// accounts" rather than an error.
//
// macOS:
//   The OneAuth broker stores tokens in a keychain group at
//   ~/Library/Group Containers/UBF8T346G9.com.microsoft.oneauth/...
//   Items are encrypted and require a `security` CLI call that prompts for the
//   user password. NOT worth automating in an MCP server (would lock up Claude
//   Desktop on a permission prompt). We return an empty list on macOS.
//
// Linux:
//   No identity broker. Empty list.

import { readFileSync, existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { log } from "./logger.js";

export interface CachedMsalAccount {
  /** UPN — `user@example.com`. */
  upn?: string;
  /** Friendly display name from the account record (rare; usually undefined). */
  displayName?: string;
  /** Tenant GUID. */
  tenantId?: string;
  /** Stable account key the broker uses internally. Only useful as a uniqueness key. */
  homeAccountId?: string;
  /** Best-guess SPO domain ("contoso") derived from UPN domain or tenant default. */
  homeDomainHint?: string;
  /**
   * SPO URL candidates derived from the account's domain, ordered most-likely-first.
   * Used by future B-phase smart auth to pre-populate a picker. Today they're shown
   * informationally in preflight.
   */
  suggestedSpoUrls: string[];
}

/**
 * Probe the OS-specific identity broker store. Always returns an array — empty on
 * non-Windows hosts, on file-missing, or on parse failure. Never throws.
 */
export function readMsalAccounts(): CachedMsalAccount[] {
  if (platform() !== "win32") return [];
  const localAppData = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
  const path = join(localAppData, ".IdentityService", "V3AccountStore.json");
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const accountsObj = (parsed.Accounts ?? parsed.accounts) as Record<string, unknown> | undefined;
    if (!accountsObj || typeof accountsObj !== "object") return [];
    // Optional top-level mapping that the broker keeps for tenant default domains.
    // We use it to suggest SPO URLs when the UPN domain doesn't match the SPO host.
    const tenantDomainMap =
      (parsed.TenantIdToDefaultDomainMapping ?? parsed.tenantIdToDefaultDomainMapping ?? {}) as Record<string, string>;

    const out: CachedMsalAccount[] = [];
    const seen = new Set<string>();
    for (const entry of Object.values(accountsObj)) {
      if (!entry || typeof entry !== "object") continue;
      const a = entry as Record<string, unknown>;
      const upn = pickString(a, ["username", "Username", "preferredUsername", "upn"]);
      const displayName = pickString(a, ["displayName", "DisplayName", "name"]);
      const tenantId = pickString(a, ["tenantId", "TenantId", "homeTenantId"]);
      const homeAccountId = pickString(a, ["homeAccountId", "HomeAccountId", "accountIdentifier"]);

      // De-dupe — broker stores per-(authority+realm) entries, but several can map
      // back to the same UPN.
      const dedupeKey = (upn ?? homeAccountId ?? JSON.stringify(a)).toLowerCase();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const homeDomainHint = inferHomeDomain(upn, tenantId, tenantDomainMap);
      out.push({
        upn,
        displayName,
        tenantId,
        homeAccountId,
        homeDomainHint,
        suggestedSpoUrls: deriveSpoUrlCandidates(homeDomainHint, upn),
      });
    }
    return out;
  } catch (err) {
    log("warn", "identity-cache: V3AccountStore.json read failed", { error: (err as Error).message });
    return [];
  }
}

/** Pick the first non-empty string value from a list of likely keys on `obj`. */
function pickString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Best-effort derivation of an SPO short-name from the available account info.
 *   1. tenantId → default domain via the broker's mapping (most authoritative)
 *   2. UPN domain stripped of `.onmicrosoft.com` or top-level domain
 */
function inferHomeDomain(
  upn: string | undefined,
  tenantId: string | undefined,
  tenantDomainMap: Record<string, string>,
): string | undefined {
  if (tenantId && tenantDomainMap[tenantId]) {
    const dd = tenantDomainMap[tenantId].toLowerCase();
    return dd.replace(/\.onmicrosoft\.com$/, "");
  }
  if (upn && upn.includes("@")) {
    const dom = upn.split("@")[1].toLowerCase();
    if (dom.endsWith(".onmicrosoft.com")) return dom.replace(/\.onmicrosoft\.com$/, "");
    // For custom domains (e.g. `user@contoso.com`) the SPO short name is usually the
    // first label. This is a heuristic — if it fails the user can override.
    return dom.split(".")[0];
  }
  return undefined;
}

/**
 * Build SPO URL candidates that B4 can try silently. Order: tenant root, admin,
 * then likely path-based fallbacks. We keep it short — a long list confuses
 * picker UI and false-positives are common with custom-domain tenants.
 */
function deriveSpoUrlCandidates(domainHint: string | undefined, _upn: string | undefined): string[] {
  if (!domainHint) return [];
  const cleaned = domainHint.replace(/[^a-z0-9-]/g, "");
  if (!cleaned) return [];
  return [
    `https://${cleaned}.sharepoint.com`,
    `https://${cleaned}-admin.sharepoint.com`,
  ];
}

/**
 * Build a one-line summary suitable for surfacing in preflight as a Probe warning.
 * "1 cached M365 account: user@contoso.com (tenant 482ce93f-…)".
 */
export function summarizeForPreflight(): string | undefined {
  const accounts = readMsalAccounts();
  if (!accounts.length) return undefined;
  if (accounts.length === 1) {
    const a = accounts[0];
    const tenant = a.tenantId ? ` (tenant ${a.tenantId.slice(0, 8)}…)` : "";
    const sug = a.suggestedSpoUrls[0] ? `; suggested SPO: ${a.suggestedSpoUrls[0]}` : "";
    return `1 cached M365 account in Windows Identity Broker: ${a.upn ?? "(unknown UPN)"}${tenant}${sug}`;
  }
  return `${accounts.length} cached M365 accounts in Windows Identity Broker (call pnp_session_status for details)`;
}
