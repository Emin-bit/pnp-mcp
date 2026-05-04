# Examples

Practical recipes for driving `@emin-bit/pnp-mcp` from Claude Desktop. Each "Ask Claude" line is a natural-language prompt — Claude will pick the right tools and parameters.

---

## 1. First-time setup

```
Run preflight to check my PnP setup.
```

Claude calls `preflight` and reports what's installed. If the PnP module is missing:

```
Install the PnP PowerShell module.
```

Claude calls `setup_install_pnp_module` (with `confirm: true`).

---

## 2. Connect to a SharePoint tenant

### Interactive (developer laptop with a browser)

```
Connect interactively to https://contoso.sharepoint.com/sites/marketing.
```

A browser pop-up appears, you sign in, Claude confirms the connection via `pnp_session_status`.

### Headless (SSH / remote shell)

```
Connect to https://contoso.sharepoint.com using the device-code flow.
ClientId 71ea27dd-aaaa-bbbb-cccc-1234567890ab.
```

Claude prints a URL + code, you paste them into your phone.

### CI/CD (service principal)

```
Connect to https://contoso.sharepoint.com as service principal
71ea27dd-… in tenant contoso.onmicrosoft.com using the secret in env $SP_SECRET.
```

---

## 3. Discover what's there

```
What's the active PnP connection?
```

→ `pnp_session_status`

```
List the top 20 sites in the tenant whose template is GROUP#0,
showing URL, Title, and StorageUsage.
```

→ `pnp_site_list` with template filter + OData projection.

```
What lists exist on this site?
```

→ `pnp_list_list` against the connected web.

```
Show me the schema for the "Documents" library — fields, content types, views.
```

→ `pnp_list_get` + `pnp_field_list` + `pnp_view_list`.

---

## 4. Create a project list with custom fields

```
Create a list called "Project Tracker" on the connected site, type GenericList,
with these fields:
  - DueDate (DateTime)
  - Owner (User)
  - Status (Choice: Not started / In progress / Done)
  - Budget (Currency)
Make a default view that shows Title, Owner, Status, DueDate.
```

Claude runs:

1. `pnp_list_new` (with `confirm: true`)
2. `pnp_field_add` four times — one per column
3. `pnp_view_add` for the default view

---

## 5. Bulk-update list items

```
For every item in "Project Tracker" with Status = "Not started",
set Status to "In progress" and add a comment "Started by automation".
```

Claude composes a `Get-PnPListItem | Set-PnPListItem` pipeline via `pnp_run`.
The pipeline is detected as a bulk-mutation by safe-mode and **blocks** until you confirm:

```
Yes, confirm.
```

Claude retries with `confirm: true`.

---

## 6. Apply a PnP provisioning template

```
Apply the template at /Users/me/templates/marketing-site.xml to
https://contoso.sharepoint.com/sites/new-marketing-site.
```

Claude calls `pnp_template_apply` — which **defaults to `background: true`** because templates can take 5+ minutes. The tool returns a `job_id`. Then:

```
What's the status of that template apply?
```

→ `job_status`. Or:

```
Wait for it to finish.
```

→ `job_wait` (blocks for up to ~10 minutes, then reports outcome).

---

## 7. Promote a site to a hub and associate child sites

```
Promote https://contoso.sharepoint.com/sites/marketing-hq to a hub site.
Allow only "marketing-admins@contoso.onmicrosoft.com" to associate child sites.
```

→ `pnp_hubsite_register` with `principals: ["marketing-admins@…"]` and `confirm: true`.

```
Now associate /sites/marketing-emea, /sites/marketing-na, and
/sites/marketing-apac with that hub.
```

→ `pnp_hubsite_associate` three times (Claude will batch them).

---

## 8. Create a modern news article and publish it

```
Create a news page called "Q1-Results" on the connected site, layout Article,
promoted as NewsArticle, comments disabled, publish immediately.
```

→ `pnp_page_add`:

```json
{
  "name": "Q1-Results",
  "layout_type": "Article",
  "promote_as": "NewsArticle",
  "comments_enabled": false,
  "publish": true,
  "confirm": true
}
```

To clear an existing scheduled publish on a different page:

```
Cancel the scheduled publish on the "Roadmap" page.
```

→ `pnp_page_set` with `remove_scheduled_publish: true` (it's a switch, not a date).

---

## 9. Modify navigation safely

```
Add a "Wiki" link to the QuickLaunch nav, pointing to /sites/wiki, at the top.
```

→ `pnp_navigation_add` with `location: "QuickLaunch"`, `first: true`, `external: true`.

```
Remove every node from the Footer nav.
```

→ `pnp_navigation_remove` with `all: true` and `location: "Footer"` and `confirm: true`.
The tool **rejects** bare `all: true` without `location` — that would have hit the
PnP cmdlet's `-All` parameter set, which deletes nodes from EVERY surface (Top +
QuickLaunch + SearchNav + Footer). The pipeline form `Get-PnPNavigationNode -Location Footer | Remove-PnPNavigationNode` is used instead to scope the deletion correctly.

---

## 10. Provisioning a new TeamSite (background)

```
Create a new TeamSite at https://contoso.sharepoint.com/sites/project-x with
alias "project-x", title "Project X", owner emin@contoso.onmicrosoft.com,
public (not private).
```

→ `pnp_site_new` with `type: "TeamSite"`, `alias: "project-x"`, `owners: [...]`, `is_public: true`, `confirm: true`. Defaults to `background: true` because TeamSite provisioning often takes 3–8 minutes (mailbox + SP site + optional Teams team).

```
Wait until that site is provisioned.
```

→ `job_wait`.

---

## 11. Escape hatch — anything we don't have a typed tool for

```
Give me the recycle-bin items modified in the last 7 days, top 50, as JSON.
```

→ `pnp_run` with command:

```powershell
Get-PnPRecycleBinItem -RowLimit 50
  | Where-Object { $_.DeletedDate -gt (Get-Date).AddDays(-7) }
  | Select-Object Title, ItemType, DeletedByName, DeletedDate, OriginalLocation
  | ConvertTo-Json -Depth 4 -Compress
```

If the cmdlet you want is not obvious, ask Claude:

```
What PnP cmdlets exist for managing site collection app catalogs?
```

→ `pnp_help` with `name: "*AppCatalog*"`.

---

## 12. Disconnect at end of session

```
Disconnect the PnP session.
```

→ `pnp_auth_disconnect`. (The pwsh REPL stays alive but the SharePoint context is cleared.)
