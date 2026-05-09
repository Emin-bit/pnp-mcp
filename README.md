# @emin-bit/pnp-mcp

[![npm](https://img.shields.io/npm/v/@emin-bit/pnp-mcp.svg)](https://www.npmjs.com/package/@emin-bit/pnp-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)](https://nodejs.org/)

**Model Context Protocol server bridging Claude with the [PnP PowerShell](https://pnp.github.io/powershell/) module for SharePoint Online and Microsoft 365 administration.**

Wraps a long-lived `pwsh` 7+ REPL session that has the `PnP.PowerShell` module loaded, then exposes auth lifecycle, sites, webs, lists, items, files, content types, fields, permissions, provisioning templates, modern pages, hub sites, M365 groups, and navigation as **90 typed MCP tools** — plus a generic `pnp_run` passthrough for anything else.

Works on macOS, Linux, and Windows. Cross-platform pwsh discovery, auth state preserved across calls, safe-mode gating for destructive operations, background jobs for long-running provisioning.

---

## Why this exists

PnP PowerShell is the most complete tooling for SharePoint Online + M365 admin work, but it has ~700 cmdlets. Asking an LLM to drive raw PowerShell over a generic shell tool means: cold-start cost on every call, no auth state preservation, no safety net for `Remove-PnPSite`, no schema for the LLM to reason about parameters.

This server fixes all of that:

- **One pwsh REPL, kept alive for the session.** Auth lives in the process — `Connect-PnPOnline` once, run dozens of cmdlets without re-authenticating.
- **Typed Zod schemas** for the 89 most-used operations, so Claude picks parameters correctly without consulting cmdlet help.
- **Safe-mode gating.** Destructive operations (`Remove-*`, `Clear-*`, `New-PnPSite`, `Invoke-PnPTenantTemplate`, etc.) require an explicit `confirm: true`. The check walks every cmdlet in pipelines and multi-statement commands.
- **Background jobs.** Provisioning a TeamSite or applying a PnP template can take minutes — Claude Desktop's MCP transport has a ~60s timeout. Background jobs run in separate pwsh processes; track via `job_status` / `job_wait`.
- **Live-enum verification in CI.** Every hardcoded enum string in TypeScript is checked against the live PnP module on each release via `npm run verify-enums`.

---

## Requirements

- **Node.js ≥ 18** (the MCP server)
- **PowerShell 7+** (`pwsh` on PATH) — _Windows PowerShell 5.1 is **not** supported_
- **PnP.PowerShell module** — install via the bundled `setup_install_pnp_module` tool, or manually:
  ```powershell
  Install-Module PnP.PowerShell -Scope CurrentUser
  ```

The `preflight` MCP tool diagnoses all of the above and reports what's missing.

---

## Installation

### Global (recommended for Claude Desktop)

```bash
npm install -g @emin-bit/pnp-mcp
```

This installs a `pnp-mcp` binary on PATH.

### Per-project

```bash
npm install @emin-bit/pnp-mcp
```

---

## Claude Desktop configuration

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows) and add:

```json
{
  "mcpServers": {
    "pnp": {
      "command": "pnp-mcp"
    }
  }
}
```

Or with `npx` (no global install needed):

```json
{
  "mcpServers": {
    "pnp": {
      "command": "npx",
      "args": ["-y", "@emin-bit/pnp-mcp"]
    }
  }
}
```

Restart Claude Desktop, and the 90 PnP tools become available.

### Auto-update notifications

The server checks the npm registry at most once per 24 hours (background, cached). When a newer version is found, the next launch prints a plain-text banner to stderr with the upgrade command. Set `"env": { "PNP_MCP_DISABLE_UPDATE_CHECK": "1" }` in the MCP entry to silence.

For users who'd rather have updates pulled automatically (with a 1–3 second cold-start cost), use the `npx ... @latest` form:

```json
{
  "mcpServers": {
    "pnp": {
      "command": "npx",
      "args": ["-y", "@emin-bit/pnp-mcp@latest"]
    }
  }
}
```

`npx` will check for and install a newer version on every Claude Desktop launch. Note: a server restart is still required to load the new code, but Claude Desktop already restarts MCP servers on each app start.

### Disabling safe-mode (NOT recommended)

Destructive cmdlets are gated behind `confirm: true` by default. If you really want to skip the gate (e.g. for fully automated pipelines), set:

```json
{
  "mcpServers": {
    "pnp": {
      "command": "pnp-mcp",
      "env": { "PNP_MCP_SAFE_MODE": "off" }
    }
  }
}
```

Treat this like `rm -rf /` — there is no undo for `Remove-PnPSite -Force`.

---

## Quickstart

After Claude Desktop reconnects, ask Claude something like:

> _Run preflight to check my PnP setup._

Claude calls `preflight` → reports Node, pwsh, module, auth status. If the module is missing:

> _Install the PnP module._

Claude calls `setup_install_pnp_module` (with `confirm: true`). Then connect:

> _Connect interactively to https://contoso.sharepoint.com/sites/marketing._

Claude picks `pnp_auth_connect_interactive` (browser pop-up). Then:

> _What lists are on this site?_

Claude calls `pnp_list_list`.

> _Create a list called "Project Tracker" with a Title and a DueDate field._

Claude calls `pnp_list_new` (with `confirm: true`), then `pnp_field_add` for the date column.

For more end-to-end flows, see [`examples/`](./examples).

---

## Tool catalog

90 tools across 5 phases. The server's MCP `instructions` text (sent at handshake) is the canonical guide for the LLM; this list is for humans browsing the README.

<details>
<summary><strong>Phase 1 — auth, preflight, jobs</strong> (12 tools)</summary>

- `preflight` — diagnose Node, pwsh, PnP module, auth state
- `setup_install_pnp_module` — install PnP.PowerShell via `Install-Module`
- `pnp_auth_connect_interactive` — browser pop-up
- `pnp_auth_connect_device_code` — URL + code flow (headless)
- `pnp_auth_connect_sp_secret` — service principal + secret
- `pnp_auth_connect_sp_cert` — service principal + .pfx certificate
- `pnp_auth_connect_managed_identity` — Azure resource MI (with IMDS pre-check)
- `pnp_auth_disconnect` — clear the session's PnP connection
- `pnp_session_status` — show current connection (URL, account, scopes)
- `job_list`, `job_status`, `job_wait`, `job_cancel` — manage background jobs

</details>

<details>
<summary><strong>Phase 2 — sites, webs, tenant</strong> (10 tools)</summary>

- `pnp_site_list`, `pnp_site_get`, `pnp_site_get_by_url`
- `pnp_site_new` (TeamSite / CommunicationSite / TeamSiteWithoutMicrosoft365Group; defaults `background: true`)
- `pnp_site_remove` (defaults `background: true`)
- `pnp_web_list`, `pnp_web_get`, `pnp_web_new`, `pnp_web_remove`
- `pnp_tenant_get`, `pnp_tenant_set`

</details>

<details>
<summary><strong>Phase 3 — lists, items, views, files, folders</strong> (18 tools)</summary>

- `pnp_list_list`, `pnp_list_get`, `pnp_list_new`, `pnp_list_set`, `pnp_list_remove`
- `pnp_listitem_list`, `pnp_listitem_get`, `pnp_listitem_add`, `pnp_listitem_set`, `pnp_listitem_remove`
- `pnp_view_list`, `pnp_view_add`, `pnp_view_remove`
- `pnp_file_get`, `pnp_file_add`, `pnp_file_copy`, `pnp_file_move`, `pnp_file_remove`
- `pnp_folder_get`, `pnp_folder_add`, `pnp_folder_remove`

</details>

<details>
<summary><strong>Phase 4 — schema, permissions, provisioning</strong> (19 tools)</summary>

- `pnp_contenttype_list`, `pnp_contenttype_get`, `pnp_contenttype_add`, `pnp_contenttype_set`, `pnp_contenttype_remove`
- `pnp_field_list`, `pnp_field_get`, `pnp_field_add`, `pnp_field_set`, `pnp_field_remove` (22-value `FieldType` enum)
- `pnp_group_list`, `pnp_group_get`, `pnp_group_new`, `pnp_group_set`, `pnp_group_remove`
- `pnp_role_definition_list`, `pnp_role_set_web`, `pnp_role_set_list`, `pnp_role_set_listitem`
- `pnp_template_get` (export PnP XML), `pnp_template_apply` (defaults `background: true`)

</details>

<details>
<summary><strong>Phase 5 — pages, hubs, M365 groups, navigation</strong> (24 tools)</summary>

- `pnp_page_list`, `pnp_page_get`, `pnp_page_add`, `pnp_page_set`, `pnp_page_remove` (LayoutType incl. `Dashboard`/`NewsDigest`; `PromoteAs` uses `NewsArticle`)
- `pnp_hubsite_list`, `pnp_hubsite_register`, `pnp_hubsite_set`, `pnp_hubsite_associate`, `pnp_hubsite_disassociate`
- `pnp_m365group_list`, `pnp_m365group_get`, `pnp_m365group_new`, `pnp_m365group_set`, `pnp_m365group_remove`
- `pnp_m365group_member_add`, `pnp_m365group_member_remove`, `pnp_m365group_owner_add`, `pnp_m365group_owner_remove`
- `pnp_navigation_list`, `pnp_navigation_add`, `pnp_navigation_remove` (`all: true` requires `location`)

</details>

<details>
<summary><strong>Escape hatches</strong> (2 tools)</summary>

- `pnp_run` — execute any PowerShell expression in the live session (gated by safe-mode)
- `pnp_help` — list/describe PnP cmdlets (`Get-Help` / `Get-Command -Module PnP.PowerShell`)

</details>

---

## Safety model

The `isDestructive()` check (see [`src/safety.ts`](./src/safety.ts)) inspects each command for:

1. **Destructive verbs** — `Remove`, `Clear`, `Reset`, `Disable`, `Stop`, `Disconnect`, `Revoke`, `Deny`, `Block`, `Uninstall`, `Unpublish`.
2. **Explicit destructive cmdlets** — list of ~56 cmdlets that aren't covered by the verb rule but mutate tenant/site state (`New-PnPSite`, `Invoke-PnPTenantTemplate`, `Set-PnPListItem`, `Add-PnPField`, `Register-PnPHubSite`, `Add-PnPSiteCollectionAdmin`, …).
3. **Dangerous parameters** — `-Force`, `-Confirm:$false`, `-IgnoreOnPremError`.

The check walks **every** Verb-Noun token after stripping comments and string literals — so `Get-PnPListItem | Remove-PnPListItem` and `Connect-PnPOnline ...; Remove-PnPSite ...` are both gated, not just the first cmdlet.

When safe-mode blocks a command, the tool returns `isError: true` with a `BLOCKED:` message explaining why, so Claude can decide to retry with `confirm: true` after reading `pnp_session_status`.

---

## Development

```bash
git clone https://github.com/Emin-bit/pnp-mcp.git
cd pnp-mcp
npm install
npm run build         # tsc → dist/
npm test              # 72 smoke tests against a live pwsh session
npm run verify-enums  # check every TS enum against live PnP enums
```

The smoke test is a real MCP-protocol round-trip: it spawns the built server, sends `initialize` + `tools/list` + 70+ `tools/call` requests, and asserts safety gating, error handling, JSON round-trip integrity, and live-enum coverage. It requires `pwsh` and `PnP.PowerShell` to be installed (`preflight` will tell you what's missing).

### Architecture notes

- **`src/pwsh.ts`** — long-lived REPL session manager. Each tool call sends a base64-encoded user command wrapped in a marker-protocol try/catch, then reads stdout until the END marker. ANSI sequences are stripped before parsing.
- **`src/safety.ts`** — destructive-command detection (string-aware, comment-aware, pipeline-aware).
- **`src/runner.ts`** — the common `runAsTool({ toolName, command, timeoutMs })` wrapper used by every typed tool.
- **`src/jobs.ts`** — background job tracking (separate pwsh per job, no auth inheritance).
- **`src/tools/*.ts`** — one file per tool family (auth, site, web, list, listitem, view, file, folder, contenttype, field, permission, template, page, hubsite, m365group, navigation, preflight, jobs).
- **`verify-enums.mjs`** — CI script. Author convention: prefix every `z.enum([…])` with `// @verify-enum [DotNetTypeName]` and the script will assert each TS literal exists in the live .NET enum.

---

## Companion project

This is a sibling to [`@emin-bit/power-platform-mcp`](https://www.npmjs.com/package/@emin-bit/power-platform-mcp), a separately-installable MCP server for the Power Platform CLI (`pac` / `pacx`). They're independent — install whichever (or both) you need.

---

## License

MIT — see [LICENSE](./LICENSE).

## Contributing

Issues and PRs welcome at [github.com/Emin-bit/pnp-mcp](https://github.com/Emin-bit/pnp-mcp). For new tools, please:

1. Add a Zod schema with descriptive `.describe()` text on every parameter.
2. Add a `// @verify-enum [DotNetType]` marker if you're adding a new enum.
3. Add a smoke test in `smoke-test.mjs` (at minimum: confirm gating works for destructive operations).
4. Run `npm run verify-enums` and `npm test` — both must pass.
