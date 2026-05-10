// PnP authentication lifecycle tools.
//
// PnP.PowerShell 3.x requires an Entra app registration ClientId for all OAuth flows
// (interactive, device code, SP secret, SP cert). The "magic" built-in PnP Management
// Shell ClientId from PnP 2.x is no longer the default — the tenant must either:
//   (a) register its own Entra app and grant SharePoint API permissions, or
//   (b) consent PnP Management Shell as a multi-tenant first-party app
//       (one-time admin action, then ClientId is well-known)
// Each connect tool's description points to docs for setup.
//
// SECURITY: client secrets and certificate passwords are forwarded directly to
// pwsh via psQuote-escaped inline params and explicitly listed in `redact:` so
// they are masked in BOTH the log file AND the textual output we hand back to Claude.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAsTool, type ToolResult } from "../runner.js";
import { psQuote } from "../util.js";
import { recordSuccessfulConnect, findCachedConnection, loadState, type AuthMethod } from "../state-cache.js";

// B3: post-connect verification now ALSO eagerly populates AccountName + TenantId
// when the connection object leaves them blank (PnP 3.x sometimes does for delegated
// auth until the first real call). Fix surfaces in both pnp_auth_connect_* output
// and pnp_session_status.
//
// We additionally emit a single-line `__PNP_CONNECT__|<url>|<acc>|<cid>|<tid>` marker
// that the TS layer parses to write into the state cache (B2). The marker is stripped
// from the user-facing output before the result is returned to Claude.
const POST_CONNECT_VERIFY =
  "; try { " +
    "$c = Get-PnPConnection -ErrorAction Stop; " +
    "$acc = $c.AccountName; " +
    "$tid = $c.TenantId; " +
    // B3 enrichment: backfill AccountName from CurrentUser.Email when blank.
    "if ([string]::IsNullOrEmpty($acc)) { " +
      "try { $w = Get-PnPWeb -Includes CurrentUser -ErrorAction Stop; if ($w.CurrentUser) { $acc = $w.CurrentUser.Email } } catch {} " +
    "} " +
    "Write-Output ('__PNP_CONNECT__|' + $c.Url + '|' + $acc + '|' + $c.ClientId + '|' + $tid); " +
    "[pscustomobject]@{ Url = $c.Url; AccountName = $acc; ClientId = $c.ClientId; TenantId = $tid; ConnectionType = $c.ConnectionType } | Format-List | Out-String " +
  "} catch { 'CONNECTED but Get-PnPConnection unexpectedly failed: ' + $_.Exception.Message }";

const CONNECT_MARKER_RE = /__PNP_CONNECT__\|([^|\n]+)\|([^|\n]*)\|([^|\n]*)\|([^|\n]*)\r?\n?/;

/**
 * Wraps runAsTool for auth tools: after a successful connect, parses the
 * `__PNP_CONNECT__` marker out of the response, persists the connection to the
 * state cache (B2), and strips the marker from the user-facing output. The
 * actual Connect-PnPOnline error / success status flow is unchanged.
 */
async function runAuthConnect(
  toolName: string,
  command: string,
  authMethod: AuthMethod,
  opts: { timeoutMs?: number; redact?: string[] } = {},
): Promise<ToolResult> {
  const result = await runAsTool({ toolName, command, ...opts });
  // Only record on success (no error flag). Parse marker even on isError just to
  // strip it from the displayed output if it leaked through.
  const text = result.content[0]?.text ?? "";
  const m = text.match(CONNECT_MARKER_RE);
  if (m) {
    const [marker, url, acc, cid, tid] = m;
    if (!result.isError && url) {
      try {
        recordSuccessfulConnect({
          url,
          upn: acc || undefined,
          clientId: cid || undefined,
          tenantId: tid || undefined,
          authMethod,
        });
      } catch {
        // never fail the tool because cache write failed — logged separately by state-cache.
      }
    }
    // Strip the marker line from displayed output so the user sees clean Format-List only.
    result.content[0] = { ...result.content[0], type: "text", text: text.replace(marker, "") };
  }
  return result;
}

/**
 * B4 helper: resolve url + client_id when one or both are omitted, by looking up
 * the most recent matching record in the state cache. Returns either a fully
 * populated pair or a `needs_input` ToolResult listing what the caller must
 * supply (with cached candidates surfaced where possible).
 */
type ResolvedAuthDefaults = {
  resolved: { url: string; client_id: string; tenant?: string; usedCache: boolean };
  needsInput?: undefined;
} | {
  resolved?: undefined;
  needsInput: ToolResult;
};

function resolveAuthDefaults(
  toolName: string,
  authMethod: AuthMethod,
  given: { url?: string; client_id?: string; tenant?: string },
): ResolvedAuthDefaults {
  // Both provided → no fallback needed.
  if (given.url && given.client_id) {
    return { resolved: { url: given.url, client_id: given.client_id, tenant: given.tenant, usedCache: false } };
  }

  const cached = findCachedConnection({
    url: given.url,
    clientId: given.client_id,
    authMethod,
  });

  const resolvedUrl = given.url ?? cached?.url;
  const resolvedClientId = given.client_id ?? cached?.clientId;
  const resolvedTenant = given.tenant ?? cached?.tenantId;

  if (resolvedUrl && resolvedClientId) {
    return {
      resolved: {
        url: resolvedUrl,
        client_id: resolvedClientId,
        tenant: resolvedTenant,
        usedCache: !given.url || !given.client_id,
      },
    };
  }

  // Couldn't fill both. Tell the caller exactly what's missing AND show the cached
  // candidates so they can pass `url:` and re-call.
  const missing: string[] = [];
  if (!resolvedUrl) missing.push("url");
  if (!resolvedClientId) missing.push("client_id");
  const cachedSummary = loadStateSummary();
  const lines = [
    `${toolName} needs ${missing.join(" and ")}.`,
  ];
  if (cachedSummary.length) {
    lines.push("");
    lines.push("Cached connections you can pick from (most recent first):");
    cachedSummary.slice(0, 5).forEach((line, i) => lines.push(`  ${i + 1}. ${line}`));
    lines.push("");
    lines.push("Re-call this tool passing `url` (and optionally `client_id`) from one of the rows above.");
  } else {
    lines.push("");
    lines.push("No cached connections yet — pass both `url` and `client_id` for the first connect.");
  }
  return {
    needsInput: {
      isError: true,
      content: [{ type: "text", text: lines.join("\n") }],
    },
  };
}

/** Compact one-liner per cached connection for the "needs_input" hint output. */
function loadStateSummary(): string[] {
  const s = loadState();
  return s.lastConnections.map(c => {
    const upnHint = c.upn ? ` as ${c.upn}` : "";
    const cidHint = c.clientId ? ` (clientId ${c.clientId.slice(0, 8)}…)` : "";
    return `${c.url}${upnHint}${cidHint} via ${c.authMethod}`;
  });
}

export function registerAuth(server: McpServer) {
  // ============================================================================
  // INTERACTIVE (browser pop-up)
  // ============================================================================
  server.tool(
    "pnp_auth_connect_interactive",
    "Connect to a SharePoint Online site/tenant via interactive browser sign-in. " +
    "Opens the system browser so the END USER can authenticate. Use this on developer workstations only — NOT on headless servers (use device code or SP secret/cert). " +
    "PnP.PowerShell 3.x REQUIRES an Entra app registration ClientId. If your tenant has not registered one, see https://pnp.github.io/powershell/articles/registerapplication.html. " +
    "B4 — `url` and `client_id` are OPTIONAL when you've already connected before: the most recent cached entry is used. To see what's cached, call pnp_session_status. " +
    "Long timeout (10 min) to allow for browser interaction.",
    {
      url: z.string().optional().describe("Target site URL, e.g. 'https://contoso.sharepoint.com' or 'https://contoso.sharepoint.com/sites/team'. Optional if a previous successful interactive connect is cached."),
      client_id: z.string().optional().describe("Entra app registration ClientId. Optional if cached for this URL — pass to override the cached value."),
      tenant: z.string().optional().describe("Optional tenant id or domain (e.g. 'contoso.onmicrosoft.com'). Auto-discovered from URL when omitted."),
    },
    async ({ url, client_id, tenant }): Promise<ToolResult> => {
      const r = resolveAuthDefaults("pnp_auth_connect_interactive", "interactive", { url, client_id, tenant });
      if (r.needsInput) return r.needsInput;
      const { url: u, client_id: cid, tenant: tn, usedCache } = r.resolved;
      let cmd = `Connect-PnPOnline -Url ${psQuote(u)} -Interactive -ClientId ${psQuote(cid)}`;
      if (tn) cmd += ` -Tenant ${psQuote(tn)}`;
      cmd += POST_CONNECT_VERIFY;
      const result = await runAuthConnect("pnp_auth_connect_interactive", cmd, "interactive", { timeoutMs: 600_000 });
      if (usedCache && !result.isError) {
        result.content.push({ type: "text", text: `(filled from cache: url=${u}${client_id ? "" : `, client_id=${cid}`})` });
      }
      return result;
    },
  );

  // ============================================================================
  // DEVICE CODE
  // ============================================================================
  server.tool(
    "pnp_auth_connect_device_code",
    "Connect via device-code flow. PnP prints a verification URL and a short code; the END USER goes to the URL on any device, enters the code, and signs in. " +
    "Useful for headless environments, terminals without browser, or when the running machine cannot open a browser. " +
    "B4 — `url` and `client_id` are OPTIONAL when cached. Long timeout (10 min) so the user has time to complete the browser step.",
    {
      url: z.string().optional().describe("Target site URL. Optional if a previous device-code connect is cached."),
      client_id: z.string().optional().describe("Entra app registration ClientId — optional if cached."),
      tenant: z.string().optional(),
    },
    async ({ url, client_id, tenant }): Promise<ToolResult> => {
      const r = resolveAuthDefaults("pnp_auth_connect_device_code", "device_code", { url, client_id, tenant });
      if (r.needsInput) return r.needsInput;
      const { url: u, client_id: cid, tenant: tn, usedCache } = r.resolved;
      let cmd = `Connect-PnPOnline -Url ${psQuote(u)} -DeviceLogin -ClientId ${psQuote(cid)}`;
      if (tn) cmd += ` -Tenant ${psQuote(tn)}`;
      cmd += POST_CONNECT_VERIFY;
      const result = await runAuthConnect("pnp_auth_connect_device_code", cmd, "device_code", { timeoutMs: 600_000 });
      if (usedCache && !result.isError) {
        result.content.push({ type: "text", text: `(filled from cache: url=${u}${client_id ? "" : `, client_id=${cid}`})` });
      }
      return result;
    },
  );

  // ============================================================================
  // SERVICE PRINCIPAL — CLIENT SECRET
  // ============================================================================
  server.tool(
    "pnp_auth_connect_sp_secret",
    "Connect via Service Principal (Entra app registration) using a CLIENT SECRET. The secret is forwarded directly to pwsh and never logged or returned in plain text — it is `***REDACTED***` in MCP logs and in the tool response. " +
    "Use this for CI/CD, scheduled tasks, or any non-interactive scenario. The Entra app must have appropriate SharePoint API permissions (Sites.* application permissions, admin-consented).",
    {
      url: z.string().describe("Target site URL"),
      tenant: z.string().describe("Tenant ID (GUID) or domain (e.g. 'contoso.onmicrosoft.com')"),
      client_id: z.string().describe("Entra app (Service Principal) ClientId"),
      client_secret: z.string().describe("Client secret value. Will be redacted in logs and output."),
    },
    async ({ url, tenant, client_id, client_secret }): Promise<ToolResult> => {
      const cmd =
        `Connect-PnPOnline -Url ${psQuote(url)} ` +
        `-Tenant ${psQuote(tenant)} ` +
        `-ClientId ${psQuote(client_id)} ` +
        `-ClientSecret ${psQuote(client_secret)}` +
        POST_CONNECT_VERIFY;
      return runAuthConnect("pnp_auth_connect_sp_secret", cmd, "sp_secret", {
        timeoutMs: 60_000,
        redact: [client_secret],
      });
    },
  );

  // ============================================================================
  // SERVICE PRINCIPAL — CERTIFICATE
  // ============================================================================
  server.tool(
    "pnp_auth_connect_sp_cert",
    "Connect via Service Principal using a CERTIFICATE (.pfx file). More secure than client-secret auth: certificates are bound to a key file rather than a transferable string. " +
    "The certificate file path is passed to PnP; the optional password is redacted in logs and output.",
    {
      url: z.string().describe("Target site URL"),
      tenant: z.string().describe("Tenant ID or domain"),
      client_id: z.string().describe("Entra app ClientId"),
      certificate_path: z.string().describe("Absolute path to the .pfx certificate file"),
      certificate_password: z.string().optional().describe("Certificate password (if the .pfx is protected). Will be redacted."),
    },
    async ({ url, tenant, client_id, certificate_path, certificate_password }): Promise<ToolResult> => {
      let cmd =
        `Connect-PnPOnline -Url ${psQuote(url)} ` +
        `-Tenant ${psQuote(tenant)} ` +
        `-ClientId ${psQuote(client_id)} ` +
        `-CertificatePath ${psQuote(certificate_path)}`;
      if (certificate_password) {
        cmd += ` -CertificatePassword (ConvertTo-SecureString -String ${psQuote(certificate_password)} -AsPlainText -Force)`;
      }
      cmd += POST_CONNECT_VERIFY;
      return runAuthConnect("pnp_auth_connect_sp_cert", cmd, "sp_cert", {
        timeoutMs: 60_000,
        redact: certificate_password ? [certificate_password] : [],
      });
    },
  );

  // ============================================================================
  // MANAGED IDENTITY (Azure-hosted only)
  // ============================================================================
  server.tool(
    "pnp_auth_connect_managed_identity",
    "Connect using the Azure Managed Identity of the host (Azure VM, App Service, Function App, Automation Account). " +
    "ONLY works when running on an Azure resource that has a system-assigned or user-assigned managed identity AND that identity has been granted SharePoint API permissions. " +
    "On a developer laptop or any non-Azure host this will fail — the IMDS endpoint (169.254.169.254) is not reachable, and we time out fast (~20s) rather than hanging on TCP retries. Use a different auth method on dev machines.",
    {
      url: z.string().describe("Target site URL"),
      user_assigned_identity_object_id: z.string().optional().describe("Object ID of a user-assigned managed identity (omit for system-assigned)"),
    },
    async ({ url, user_assigned_identity_object_id }): Promise<ToolResult> => {
      // Pre-check IMDS reachability with a short connect timeout so non-Azure hosts get an
      // immediate, actionable error instead of hanging on TCP retry until our outer timeout.
      const cmd =
        // 1) IMDS reachability probe — 2s connect attempt.
        `$imds = $false; ` +
        `try { ` +
          `$tcp = New-Object System.Net.Sockets.TcpClient; ` +
          `$ar = $tcp.BeginConnect('169.254.169.254', 80, $null, $null); ` +
          `if ($ar.AsyncWaitHandle.WaitOne(2000) -and $tcp.Connected) { $imds = $true } ` +
          `$tcp.Close() ` +
        `} catch {} ` +
        `if (-not $imds) { ` +
          `Write-Output 'NOT-AZURE: IMDS endpoint at 169.254.169.254 is not reachable. Managed Identity is only available on Azure-hosted resources (VM / App Service / Function / Automation). Use pnp_auth_connect_interactive or pnp_auth_connect_sp_secret on developer machines.'; ` +
          `return ` +
        `} ` +
        // 2) IMDS is reachable — proceed with the actual connect.
        `Connect-PnPOnline -Url ${psQuote(url)} -ManagedIdentity` +
        (user_assigned_identity_object_id
          ? ` -UserAssignedManagedIdentityObjectId ${psQuote(user_assigned_identity_object_id)}`
          : "") +
        POST_CONNECT_VERIFY;
      return runAuthConnect("pnp_auth_connect_managed_identity", cmd, "managed_identity", {
        timeoutMs: 30_000,
      });
    },
  );

  // ============================================================================
  // DISCONNECT
  // ============================================================================
  server.tool(
    "pnp_auth_disconnect",
    "Disconnect the current PnP connection. After this, all subsequent PnP cmdlets will fail until you re-authenticate. Idempotent — safe to call when there is no active connection.",
    {},
    async (): Promise<ToolResult> => {
      const cmd =
        "try { Disconnect-PnPOnline -ErrorAction Stop; 'Disconnected.' } " +
        "catch { if ($_.Exception.Message -match 'No PnP context') { 'No active connection (already disconnected).' } else { throw } }";
      return runAsTool({
        toolName: "pnp_auth_disconnect",
        command: cmd,
        timeoutMs: 15_000,
      });
    },
  );
}
