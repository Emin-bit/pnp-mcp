// CI / pre-commit verification: every hardcoded enum string in the TS source must be
// reachable in the live PnP module. Catches enum drift between PnP releases.
//
// Two enum classes covered:
//   1. Zod-enum-literal arrays in tool schemas (e.g. FieldType in field.ts, Handlers
//      in template.ts). We grep the source for `z.enum([…]).` patterns adjacent to
//      a comment marker `// @verify-enum <DotNetTypeName>` and check each value via
//      `[System.Enum]::GetNames($type)` in pwsh.
//   2. Cmdlet names in `safety.ts` `DESTRUCTIVE_FULL_CMDLETS` — every entry must
//      resolve via `Get-Command <name>` in pwsh.
//
// Run via `npm run verify-enums`.

import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "src");

// True when this file is the entrypoint (`node verify-enums.mjs`); false when it
// is `import`-ed by another module (e.g. smoke-test.mjs probing the helper).
// Guards the script body so importing for the helper doesn't trigger pwsh.
const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

function pwshCommand(cmd) {
  const r = spawnSync("pwsh", [
    "-NoLogo", "-NoProfile", "-NonInteractive",
    "-Command", `Import-Module PnP.PowerShell -ErrorAction Stop; ${cmd}`,
  ], { encoding: "utf8", timeout: 60_000 });
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", exitCode: r.status ?? -1 };
}

function readAllTsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...readAllTsFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Strip `// line comments` AND `/* block comments */` from a snippet so that
// commented-out string literals (e.g. `// "Fake-Cmdlet"`) inside a z.enum or
// Set body are not extracted as live values. The bodies we feed in here are
// only the captured contents — so we don't need to handle string boundaries
// containing `//`.
export function stripCommentsInSnippet(snippet) {
  let out = "";
  let i = 0;
  while (i < snippet.length) {
    const c = snippet[i];
    const next = snippet[i + 1];
    // Line comment — skip to newline (keep the newline so line-position-sensitive
    // regex behavior elsewhere is preserved).
    if (c === "/" && next === "/") {
      const nl = snippet.indexOf("\n", i);
      if (nl === -1) break;
      i = nl;
      continue;
    }
    // Block comment — skip to closing `*/`.
    if (c === "/" && next === "*") {
      const end = snippet.indexOf("*/", i + 2);
      if (end === -1) break;
      i = end + 2;
      continue;
    }
    // String literals — copy verbatim so we don't strip a `//` that's inside one.
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      out += c;
      i++;
      while (i < snippet.length) {
        const cc = snippet[i];
        out += cc;
        if (cc === "\\") {
          if (i + 1 < snippet.length) { out += snippet[i + 1]; i += 2; continue; }
          i++;
          continue;
        }
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

// ----- Step 1: marker-based zod enum verification -----
//
// Author convention: precede a `z.enum([…])` with a comment like
//   // @verify-enum [Microsoft.SharePoint.Client.FieldType]
// The script extracts all string literals from the next z.enum and ensures each
// resolves in the named .NET enum.

function findMarkedEnums(file) {
  const src = readFileSync(file, "utf8");
  const re = /\/\/\s*@verify-enum\s+(\[[\w.]+\])\s*\n[\s\S]*?z\.enum\(\[([\s\S]*?)\]\)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const dotnetType = m[1].trim();
    // Strip `// "X"` comments inside the enum body so commented-out values aren't
    // mistaken for live literals (verify-enums bug C5).
    const body = stripCommentsInSnippet(m[2]);
    const literals = [...body.matchAll(/"([^"]+)"/g)].map(x => x[1]);
    out.push({ dotnetType, literals, file });
  }
  return out;
}

if (IS_MAIN) {
  let failures = [];

  const markedEnums = readAllTsFiles(SRC).flatMap(findMarkedEnums);
  for (const { dotnetType, literals, file } of markedEnums) {
    const r = pwshCommand(`[System.Enum]::GetNames(${dotnetType}) -join ','`);
    if (r.exitCode !== 0) {
      failures.push(`${file}: cannot resolve ${dotnetType} via pwsh: ${r.stderr.trim()}`);
      continue;
    }
    const live = new Set(r.stdout.trim().split(",").map(s => s.trim()));
    const invalid = literals.filter(l => !live.has(l));
    if (invalid.length) {
      failures.push(
        `${file}: ${dotnetType} — TS literals NOT in live enum: ${invalid.join(", ")}\n` +
        `  Live enum has: ${[...live].sort().join(", ")}`
      );
    }
  }

  console.log(`Checked ${markedEnums.length} marked z.enum block(s) against live PnP enums.`);

  // ----- Step 2: safety.ts cmdlet existence -----
  // Only inspect string literals INSIDE the DESTRUCTIVE_FULL_CMDLETS Set literal — not
  // cmdlet names that appear in adjacent JSDoc / // comments as documentation examples.
  const safetySrc = readFileSync(join(SRC, "safety.ts"), "utf8");
  const setMatch = safetySrc.match(/DESTRUCTIVE_FULL_CMDLETS\s*=\s*new Set\(\[([\s\S]*?)\]\s*\)/);
  if (!setMatch) {
    console.error("verify-enums: could not locate DESTRUCTIVE_FULL_CMDLETS = new Set([...]) literal in safety.ts");
    process.exit(1);
  }
  // Strip comments inside the Set body so commented-out cmdlet names (e.g.
  // `// "Fake-PnPCmdlet"` left in as documentation) aren't extracted as live entries
  // (verify-enums bug C6).
  const safetyBlock = stripCommentsInSnippet(setMatch[1]);
  const cmdletMatches = [...safetyBlock.matchAll(/"([A-Z]\w+-PnP\w+)"/g)].map(m => m[1]);
  const uniqueCmdlets = [...new Set(cmdletMatches)];
  console.log(`safety.ts references ${uniqueCmdlets.length} unique PnP cmdlet name(s); verifying each…`);

  const checkScript = uniqueCmdlets
    .map(c => `if (-not (Get-Command '${c}' -Module PnP.PowerShell -ErrorAction SilentlyContinue)) { 'MISSING:${c}' }`)
    .join("; ");
  const r2 = pwshCommand(checkScript);
  const missing = r2.stdout.split("\n").map(s => s.trim()).filter(s => s.startsWith("MISSING:"));
  if (missing.length) {
    for (const line of missing) {
      failures.push(`safety.ts: cmdlet does not exist in PnP.PowerShell — ${line.replace("MISSING:", "")}`);
    }
  }

  // ----- Report -----
  if (failures.length) {
    console.error("\n❌ ENUM VERIFICATION FAILED:\n");
    for (const f of failures) console.error("  • " + f + "\n");
    process.exit(1);
  }
  console.log("\n✅ All hardcoded TS enums and cmdlet names resolve in the live PnP module.");
}
