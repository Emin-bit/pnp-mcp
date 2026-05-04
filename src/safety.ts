// Safety wrapper for PnP PowerShell passthrough.
// PnP uses Verb-Noun cmdlet naming. Destructive verbs follow standard PowerShell
// conventions: Remove, Clear, Reset, Disable, Stop, Disconnect, Revoke, etc.
//
// IMPORTANT: a command can contain MULTIPLE cmdlets in pipelines or `;` chains.
// We must check ALL cmdlets in the command, not just the first. Examples that
// MUST be blocked:
//   Get-PnPListItem | Remove-PnPListItem -Recycle
//   Connect-PnPOnline -Url x; Remove-PnPSite -Url y
// The previous implementation that checked only the first cmdlet would pass these
// silently — a real safety hole.

const DESTRUCTIVE_VERBS = new Set([
  "Remove",
  "Clear",
  "Reset",
  "Disable",
  "Stop",
  "Disconnect",
  "Revoke",
  "Deny",
  "Block",
  "Uninstall",
  "Unpublish",
]);

const DESTRUCTIVE_FULL_CMDLETS = new Set([
  "Submit-PnPSearchQuery",
  "Invoke-PnPSiteTemplate",
  "Set-PnPTenantSite",
  "Set-PnPTenant",
  "Restore-PnPRecycleBinItem",
  "Move-PnPFile",
  "Move-PnPFolder",
  "Move-PnPRecycleBinItem",
  "Copy-PnPFile",
  "Copy-PnPFolder",
  "Add-PnPFile",
  "Publish-PnPApp",
  "Install-PnPApp",
  // Phase 2 additions: site/web/hub creation alters tenant-level state and creates real
  // billed resources or routing changes.
  "New-PnPSite",
  "New-PnPTenantSite",
  "New-PnPWeb",
  "New-PnPPersonalSite",
  "Rename-PnPTenantSite",
  // Hub-site routing changes — affect cross-site search, navigation, and brand:
  "Register-PnPHubSite",
  "Unregister-PnPHubSite",
  "Set-PnPHubSite",
  "Add-PnPHubToHubAssociation",
  "Remove-PnPHubToHubAssociation",
  "Add-PnPHubSiteAssociation",
  "Remove-PnPHubSiteAssociation",
  // Home / org news / app catalog / knowledge — all tenant-wide singletons:
  "Set-PnPHomeSite",
  "Add-PnPOrgNewsSite",
  "Set-PnPKnowledgeHubSite",
  "Register-PnPAppCatalogSite",
  // Phase 3 additions: list/library structural ops + bulk file ops can have wide blast radius.
  "New-PnPList",
  "Set-PnPList",
  "Add-PnPView",
  "Set-PnPView",          // mutates view definition (fields, query, default flag)
  "Add-PnPField",
  "Set-PnPField",
  "Add-PnPContentType",
  "Set-PnPContentType",
  // Bulk-mutation pipelines: `Get-PnPListItem ... | Set-PnPListItem -Values @{...}` can
  // hit thousands of rows. Catching these via the destructive-verb rule is impossible
  // (Add/Set aren't destructive verbs), so we list them explicitly. Typed tools are not
  // affected — they bypass safety, this only matters for `pnp_run` passthrough.
  "Add-PnPListItem",
  "Set-PnPListItem",
  "Add-PnPFile",
  // Phase 4 additions: schema mutations, group/role mutations, provisioning template apply.
  // (Note: Add-/Set-PnPContentType already listed above in Phase 3 block; not re-listed here.)
  "New-PnPGroup",
  "Set-PnPGroup",
  "Add-PnPGroupMember",       // changes who has SP access via SharePoint group
  "Add-PnPRoleDefinition",
  "Set-PnPRoleDefinition",    // mutating a role definition affects every assignment using it
  "Set-PnPListPermission",
  "Set-PnPListItemPermission",
  "Set-PnPWebPermission",
  "Add-PnPSiteCollectionAdmin", // grants full control on a site collection
  // Provisioning engine — single biggest blast radius in the entire PnP module.
  // Note: legacy aliases (Invoke-PnPProvisioningTemplate, Apply-PnP*, Set-PnPSiteCollectionAdmin)
  // do NOT exist in PnP.PowerShell 3.x — verified by verify-enums script.
  "Invoke-PnPTenantTemplate",
  // Phase 5 additions: pages / hub sites / M365 groups / navigation mutations.
  "New-PnPMicrosoft365Group",        // creates mailbox + SP site + optional Teams team
  "Set-PnPMicrosoft365Group",
  "Add-PnPMicrosoft365GroupOwner",
  "Add-PnPMicrosoft365GroupMember",
  "Register-PnPHubSite",             // promotes site to tenant-wide hub
  "Set-PnPHubSite",
  "Add-PnPHubSiteAssociation",       // changes site-to-hub routing
  "Add-PnPNavigationNode",
  // Pages: Add/Set are creation/edit, but include them so pnp_run won't bypass safety.
  "Add-PnPPage",
  "Set-PnPPage",
]);

const DANGEROUS_PARAMETERS = new Set([
  "-Force",
  "-Confirm:$false",
  "-IgnoreOnPremError",
]);

export interface SafetyVerdict {
  destructive: boolean;
  reason?: string;
}

/**
 * Strip line comments (`# ...`), single-quoted strings, double-quoted strings, and
 * here-strings before scanning for cmdlet names. This avoids false positives like
 *    `# this command would Remove-PnPSite`
 *    `Get-PnPSite -Url 'https://example.com/Remove-PnPSite-NotReally'`
 * Cmdlets inside variables (`$cmd = "Remove-PnPSite"; & $cmd`) are still checkable
 * via the bare-token scan but are inherently ambiguous; we accept that limitation.
 */
function stripStringsAndComments(command: string): string {
  let out = "";
  let i = 0;
  while (i < command.length) {
    const c = command[i];
    // Line comment
    if (c === "#") {
      const nl = command.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    // Here-string @"..."@ or @'...'@
    if (c === "@" && (command[i + 1] === '"' || command[i + 1] === "'")) {
      const closer = command[i + 1] + "@";
      const end = command.indexOf(closer, i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    // Quoted strings
    if (c === '"' || c === "'") {
      const q = c;
      i++;
      while (i < command.length) {
        const cc = command[i];
        if (cc === "`" && q === '"') { i += 2; continue; } // backtick escape inside double-quote
        if (cc === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * Inspect a raw PnP PowerShell command string and decide whether it should be gated
 * behind a `confirm: true` parameter.
 *
 * We extract ALL cmdlet tokens (Verb-Noun) from the (string-stripped) command and
 * check each against the destructive verb list and full-cmdlet block-list. We also
 * scan for known dangerous parameters anywhere in the original command.
 */
export function isDestructive(command: string): SafetyVerdict {
  const cleaned = stripStringsAndComments(command);
  const cmdlets = extractAllCmdlets(cleaned);

  for (const cmdlet of cmdlets) {
    const dashIdx = cmdlet.indexOf("-");
    if (dashIdx > 0) {
      const verb = cmdlet.slice(0, dashIdx);
      if (DESTRUCTIVE_VERBS.has(verb)) {
        return { destructive: true, reason: `'${cmdlet}' uses destructive verb '${verb}'` };
      }
    }
    if (DESTRUCTIVE_FULL_CMDLETS.has(cmdlet)) {
      return { destructive: true, reason: `'${cmdlet}' is a destructive operation` };
    }
  }

  for (const flag of DANGEROUS_PARAMETERS) {
    if (commandHasFlag(command, flag)) {
      return { destructive: true, reason: `command uses dangerous parameter '${flag}'` };
    }
  }

  return { destructive: false };
}

/**
 * Find every Verb-Noun token in the (string-and-comment-stripped) command. Used to
 * detect pipeline destructive (`Get-X | Remove-X`) and multi-statement destructive
 * (`Connect-X; Remove-Y`) which the previous "first cmdlet only" check missed.
 */
function extractAllCmdlets(command: string): string[] {
  const out: string[] = [];
  // Verb-Noun: capital-prefix word + dash + capital-prefix word. Allow numbers in noun.
  const re = /\b([A-Z][a-zA-Z]*)-([A-Z][a-zA-Z0-9]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) {
    out.push(m[0]);
  }
  return out;
}

function commandHasFlag(command: string, flag: string): boolean {
  // Whole-word match, case-insensitive (PowerShell parameter names are case-insensitive).
  // Use word-boundary handling so "-Force" doesn't match "-ForceUpdate".
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(^|\\s)${escaped}(?=\\s|$|:)`, "i");
  return re.test(command);
}

export function safeModeEnabled(): boolean {
  const v = (process.env.PNP_MCP_SAFE_MODE ?? "on").toLowerCase();
  return v !== "off" && v !== "0" && v !== "false" && v !== "no";
}
