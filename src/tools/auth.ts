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

const POST_CONNECT_VERIFY =
  "; try { $c = Get-PnPConnection -ErrorAction Stop; $c | Select-Object Url, AccountName, ClientId, TenantId, ConnectionType | Format-List | Out-String } catch { 'CONNECTED but Get-PnPConnection unexpectedly failed: ' + $_.Exception.Message }";

export function registerAuth(server: McpServer) {
  // ============================================================================
  // INTERACTIVE (browser pop-up)
  // ============================================================================
  server.tool(
    "pnp_auth_connect_interactive",
    "Connect to a SharePoint Online site/tenant via interactive browser sign-in. " +
    "Opens the system browser so the END USER can authenticate. Use this on developer workstations only — NOT on headless servers (use device code or SP secret/cert). " +
    "PnP.PowerShell 3.x REQUIRES an Entra app registration ClientId. If your tenant has not registered one, see https://pnp.github.io/powershell/articles/registerapplication.html. " +
    "Long timeout (10 min) to allow for browser interaction. After connection, returns the active connection details (Url, AccountName, ClientId, TenantId).",
    {
      url: z.string().describe("Target site URL, e.g. 'https://contoso.sharepoint.com' or 'https://contoso.sharepoint.com/sites/team'"),
      client_id: z.string().describe("Entra app registration ClientId. Required in PnP.PowerShell 3.x — register your own app or consent PnP Management Shell once."),
      tenant: z.string().optional().describe("Optional tenant id or domain (e.g. 'contoso.onmicrosoft.com'). Auto-discovered from URL when omitted."),
    },
    async ({ url, client_id, tenant }): Promise<ToolResult> => {
      let cmd = `Connect-PnPOnline -Url ${psQuote(url)} -Interactive -ClientId ${psQuote(client_id)}`;
      if (tenant) cmd += ` -Tenant ${psQuote(tenant)}`;
      cmd += POST_CONNECT_VERIFY;
      return runAsTool({
        toolName: "pnp_auth_connect_interactive",
        command: cmd,
        timeoutMs: 600_000,
      });
    },
  );

  // ============================================================================
  // DEVICE CODE
  // ============================================================================
  server.tool(
    "pnp_auth_connect_device_code",
    "Connect via device-code flow. PnP prints a verification URL and a short code; the END USER goes to the URL on any device, enters the code, and signs in. " +
    "Useful for headless environments, terminals without browser, or when the running machine cannot open a browser. " +
    "Long timeout (10 min) so the user has time to complete the browser step.",
    {
      url: z.string().describe("Target site URL"),
      client_id: z.string().describe("Entra app registration ClientId — required in PnP.PowerShell 3.x"),
      tenant: z.string().optional(),
    },
    async ({ url, client_id, tenant }): Promise<ToolResult> => {
      let cmd = `Connect-PnPOnline -Url ${psQuote(url)} -DeviceLogin -ClientId ${psQuote(client_id)}`;
      if (tenant) cmd += ` -Tenant ${psQuote(tenant)}`;
      cmd += POST_CONNECT_VERIFY;
      return runAsTool({
        toolName: "pnp_auth_connect_device_code",
        command: cmd,
        timeoutMs: 600_000,
      });
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
      return runAsTool({
        toolName: "pnp_auth_connect_sp_secret",
        command: cmd,
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
      return runAsTool({
        toolName: "pnp_auth_connect_sp_cert",
        command: cmd,
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
      return runAsTool({
        toolName: "pnp_auth_connect_managed_identity",
        command: cmd,
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
