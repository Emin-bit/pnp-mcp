# Changelog

All notable changes to `@emin-bit/pnp-mcp` are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.1] — Phase A bug-fix patch

First-contact UX fixes driven by a real Windows user's test session. No breaking changes; same 90 tools, same API.

### Fixed

- **A1 — Version-aware `Import-Module` in pwsh warmup.** The previous `Import-Module PnP.PowerShell` by name could pick up a legacy 2.x install from `~/Documents/WindowsPowerShell/Modules/` because PSModulePath order puts user-scope first, even when 3.x was installed system-wide. PnP MCP requires 3.x, so the warmup now enumerates all available installs, filters `Major -ge 3`, and imports the highest 3.x **by path**. If only 2.x is found, the error message names the offending versions and their on-disk locations instead of the generic "module not installed" line.
- **A2 — Surface raw pwsh stdout/stderr/exit-code in warmup errors.** The previous opaque `pwsh warmup unexpected output: .` line gave users no clue what was wrong. The new error message includes the actual pwsh output, exit code, and any captured exception, and the full result is also written to the JSON log file at `~/.pnp-mcp/logs/pnp-mcp-YYYY-MM-DD.log` for post-mortem inspection.
- **A3 — `setup_install_pnp_module` and the `setup` CLI now try `Install-PSResource` first**, falling back to `Install-Module` only if PSResourceGet 1.x is unavailable (pwsh < 7.4) or errors out. PSResourceGet is roughly 15× faster than the legacy installer and is significantly more resilient to PowerShellGet 2.x edge cases (NuGet provider re-bootstrap failures, `Set-PSRepository` load errors).
- **A4 — Server announces log file location at startup.** Claude Desktop's `mcp-server-pnp.log` only contains MCP protocol traffic, not pwsh output or our internal logs. The server now writes `[pnp-mcp] v1.0.1 started — logs at <path>` to stderr at startup so users hunting for diagnostics know exactly where to look.

### Added

- **A6 — Update notifications via `update-notifier`.** The server checks the npm registry at most once per 24 hours (in a background process; cached state in `~/.config/configstore/`). When a newer version is published, the next server start prints a single plain-text banner to stderr — no auto-install, no boxen TTY decoration, just `Update available: 1.0.1 → 1.0.2 (patch). Run \`npm i -g @emin-bit/pnp-mcp\` then restart Claude Desktop.` Set `PNP_MCP_DISABLE_UPDATE_CHECK=1` in the MCP server env to silence.
- **Preflight tightening.** `probePnpModule` now distinguishes "no install" from "only legacy 2.x install" — the latter reports `error` instead of `ok`, with a clear "PnP MCP requires 3.x" detail. When 3.x is installed, the probe also reports the on-disk module base path, so Windows users with both 2.x and 3.x installed can confirm which one is being picked.

### Tests

5 new regression tests (77/77 total): A4 stderr announcement, A1 version-aware warmup markers, A2 raw-stdout/stderr surfacing, A3 Install-PSResource ordering, A6 update-notifier wiring.

[1.0.1]: https://github.com/Emin-bit/pnp-mcp/releases/tag/v1.0.1

## [1.0.0] — Initial release

The first stable release. 90 tools across 5 phases of SharePoint Online + M365 administration, plus the `pnp_run` passthrough escape hatch and `pnp_help` discovery tool. Built and shipped after a per-phase agent code-review cycle that caught and fixed 30+ live-PnP-enum and parameter-shape issues against `PnP.PowerShell` 3.1.

### Added

**Foundations**
- Long-lived `pwsh 7+` REPL session with marker-protocol command execution. Auth state and module imports are preserved across the entire MCP session, so `Connect-PnPOnline` runs once.
- Cross-platform pwsh discovery for macOS, Linux, and Windows (winget paths, brew, Microsoft repo).
- Safe-mode (`PNP_MCP_SAFE_MODE=on` by default) gating destructive operations behind explicit `confirm: true`. The check walks every cmdlet in pipelines and `;`-chained statements and is aware of comments + string literals to avoid false positives.
- Background-job runner (`background: true` on `pnp_run`, defaults `true` for `pnp_template_apply`) — separate pwsh process per job, tracked via `job_status` / `job_wait` / `job_cancel`.
- `verify-enums` CI script: every TypeScript enum literal marked with `// @verify-enum [DotNetType]` is asserted against the live PnP module on each release. Catches enum drift between PnP versions.
- `preflight` diagnostic tool covering Node, pwsh, PnP module install state, and current auth.
- Secret masking in logs (substring redaction tuned for short tokens; SecureString-wrapped values handled).

**Phase 1 — auth lifecycle, preflight, jobs (12 tools)**
- `pnp_auth_connect_interactive` (browser pop-up)
- `pnp_auth_connect_device_code` (URL + code flow for headless)
- `pnp_auth_connect_sp_secret` / `pnp_auth_connect_sp_cert` (service principal)
- `pnp_auth_connect_managed_identity` (with IMDS fast-fail probe so non-Azure hosts don't hang)
- `pnp_auth_disconnect`, `pnp_session_status`
- `setup_install_pnp_module`
- `job_list`, `job_status`, `job_wait`, `job_cancel`
- `preflight`

**Phase 2 — sites, webs, tenant (10 tools)**
- `pnp_site_list/get/get_by_url/new/remove` — site_new supports TeamSite / CommunicationSite / TeamSiteWithoutMicrosoft365Group with cross-field validation (TeamSite requires alias+owners; CommunicationSite requires url and rejects alias).
- `pnp_web_list/get/new/remove`
- `pnp_tenant_get/set` — tenant_set rejects empty parameter sets and chains parameters with `&&` (short-circuits on error, no `;` separator).

**Phase 3 — lists, items, views, files, folders (18 tools)**
- `pnp_list_list/get/new/set/remove`
- `pnp_listitem_list/get/add/set/remove` — `fields` projects via OData `$select`; bulk `Get | Set` pipelines are explicitly safety-gated.
- `pnp_view_list/add/remove`
- `pnp_file_get/add/copy/move/remove` — `as_string`/`as_file` are mutually exclusive on `pnp_file_get`; `pnp_file_add` accepts hashtable values including arrays.
- `pnp_folder_get/add/remove` — `pnp_folder_add` rejects slashes (must call per level).

**Phase 4 — schema, permissions, provisioning (19 tools)**
- `pnp_contenttype_list/get/add/set/remove`
- `pnp_field_list/get/add/set/remove` — 22-value `FieldType` enum verified against live `[Microsoft.SharePoint.Client.FieldType]` (5 invalid values that earlier drafts had — `UserMulti`, `LookupMulti`, `Image`, `TaxonomyFieldType`, `TaxonomyFieldTypeMulti` — were dropped after live verification).
- `pnp_group_list/get/new/set/remove` — `pnp_group_set` is the single source of truth for role assignments (no parallel `add_role`/`remove_role` on `_new`).
- `pnp_role_definition_list`
- `pnp_role_set_web/list/listitem` — handle break-inheritance + grant/clear in one call; reject incoherent combinations (`inherit_permissions` + role grant, `user` + `group` together).
- `pnp_template_get` (export PnP XML) and `pnp_template_apply` — defaults `background: true`, `sync_timeout_minutes` capped at 10, 33-value `Handlers` enum verified live.

**Phase 5 — pages, hubs, M365 groups, navigation (24 tools)**
- `pnp_page_list/get/add/set/remove` — `PageLayoutType` (incl. `Dashboard` + `NewsDigest`), `PageHeaderLayoutType`, `PagePromoteType` (uses `NewsArticle`, the live PnP spelling — earlier drafts had `NewsPage` which was wrong). Switch parameters like `CommentsEnabled` and `RemoveScheduledPublish` correctly emit `:$true`/`:$false` so callers can both enable and disable.
- `pnp_hubsite_list/register/set/associate/disassociate` — `principals` on `register` is optional (matches live `Mandatory=False`); switch params on `set` (requires_join_approval, hide_name_in_navigation, enable_permissions_sync) emit `:$true`/`:$false`.
- `pnp_m365group_list/get/new/set/remove` + `member_add` / `member_remove` / `owner_add` / `owner_remove`. New-PnPMicrosoft365Group is destructive (creates mailbox + SP site + optional Teams team) and requires `confirm: true`.
- `pnp_navigation_list/add/remove` — `remove` enforces 1-of-3 modes (identity / location+title / all+location). Bare `all: true` without `location` is rejected because the live cmdlet's `-All` parameter set has no `-Location` and silently nukes every nav surface (Top + QuickLaunch + SearchNav + Footer); `all + location` is translated to the `Get-PnPNavigationNode -Location X | Remove-PnPNavigationNode` pipeline form which scopes correctly.

**Escape hatches (2 tools)**
- `pnp_run` — execute any PowerShell expression in the live session (gated by safe-mode; supports `background: true`).
- `pnp_help` — list/describe PnP cmdlets via `Get-Help` and `Get-Command -Module PnP.PowerShell`.

### Notable bug-fix highlights from per-phase reviews

- ANSI escape regex anchored on `` (was eating literal `]` characters and the END marker).
- Multi-line user commands are base64-encoded before being sent to the REPL (single-quote escape didn't survive embedded newlines).
- The destructive-cmdlet check walks **every** Verb-Noun token, not just the first — `Get-X | Remove-X` and `Connect-X; Remove-Y` are both gated.
- Cert password leaks plugged: `maskCommandWithSecrets` was added separately from the user-facing `maskCommand` so logs never contain plaintext credentials.
- `psHashtable` rejects nested objects with a clear error instead of silently coercing to `[object Object]`.
- `verify-enums` strips line and block comments inside `z.enum([…])` and `Set` literals before extracting strings, so commented-out documentation values don't trigger false positives or false negatives.
- `Restore-PnPRecycleBinItem` (was `Restore-PnPDeletedSite` in early drafts), `Invoke-PnPTenantTemplate` (not `Invoke-PnPProvisioningTemplate` or `Apply-PnPSiteTemplate` — those don't exist in PnP 3.x), and 7 other fake/legacy cmdlet names were corrected after live verification.

### Tests

72 smoke-test assertions covering: REPL round-trip, ANSI stripping, JSON output integrity, multi-line / pipeline / multi-statement command handling, safety gating across all phases, schema correctness, enum coverage, and regression tests for every fix landed during reviews.

[1.0.0]: https://github.com/Emin-bit/pnp-mcp/releases/tag/v1.0.0
