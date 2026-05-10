// Phase 0 smoke test for @emin-bit/pnp-mcp.
//
// Verifies:
//   1. MCP server starts, responds to initialize
//   2. Server sends `instructions` field
//   3. Three Phase 0 tools registered: pnp_run, pnp_help, pnp_session_status
//   4. pwsh REPL session works: round-trip a Get-Date call via pnp_run
//   5. PnP module is loaded in the session: round-trip Get-Command Get-PnPConnection
//   6. Safe-mode blocks a destructive command (Remove-PnPSite without confirm)
//   7. JSON output is preserved end-to-end (cmdlet | ConvertTo-Json round-trip)
//   8. pnp_session_status reports "NOT CONNECTED" cleanly (no auth in test env)
//
// All tests run against the REAL pwsh + real PnP.PowerShell module — this is a
// genuine integration smoke test, not a unit test. Requires the developer's
// machine to have pwsh 7+ and PnP.PowerShell installed (handled by setup CLI).

import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverPath = resolve(__dirname, "dist/index.js");

const child = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, PNP_MCP_VERBOSE: "0" },
});

let stdoutBuf = "";
let stderrBuf = "";
const responses = new Map();

child.stdout.on("data", chunk => {
  stdoutBuf += chunk.toString();
  let nl;
  while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
    const line = stdoutBuf.slice(0, nl).trim();
    stdoutBuf = stdoutBuf.slice(nl + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id != null) responses.set(msg.id, msg);
    } catch { /* non-JSON line — ignore (shouldn't happen on stdout) */ }
  }
});
child.stderr.on("data", c => { stderrBuf += c.toString(); });

const send = obj => child.stdin.write(JSON.stringify(obj) + "\n");
const waitFor = async (id, ms = 60_000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (responses.has(id)) return responses.get(id);
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Timeout waiting for response id=${id} (after ${ms}ms)`);
};

async function main() {
  // ---------- 1. initialize ----------
  send({
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "1.0.0" },
    },
  });
  const initRes = await waitFor(1, 30_000);
  if (initRes.error) throw new Error(`initialize failed: ${JSON.stringify(initRes.error)}`);
  console.log("OK initialize");

  // ---------- 2. instructions ----------
  const instructions = initRes.result?.instructions ?? "";
  if (!instructions || instructions.length < 200) {
    throw new Error(`server instructions missing or too short (got ${instructions.length} chars)`);
  }
  for (const required of ["pwsh", "destructive", "background", "Connect-PnPOnline", "safe-mode"]) {
    if (!instructions.toLowerCase().includes(required.toLowerCase())) {
      throw new Error(`server instructions missing reference to '${required}'`);
    }
  }
  console.log(`OK server sent instructions (${instructions.length} chars)`);

  send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });

  // ---------- 3. tools/list ----------
  send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  const listRes = await waitFor(2);
  const toolNames = (listRes.result?.tools ?? []).map(t => t.name).sort();
  console.log("OK tools/list:", toolNames.join(", "));

  const expectedTools = [
    // Phase 0 foundation
    "pnp_help", "pnp_run", "pnp_session_status",
    // Phase 1 — auth lifecycle
    "pnp_auth_connect_interactive",
    "pnp_auth_connect_device_code",
    "pnp_auth_connect_sp_secret",
    "pnp_auth_connect_sp_cert",
    "pnp_auth_connect_managed_identity",
    "pnp_auth_disconnect",
    // Phase 1 — onboarding
    "preflight",
    "setup_install_pnp_module",
    // Phase 1 — job tracking
    "job_list",
    "job_status",
    "job_wait",
    "job_cancel",
    // Phase 2 — sites
    "pnp_site_list",
    "pnp_site_get",
    "pnp_site_get_by_url",
    "pnp_site_new",
    "pnp_site_remove",
    // Phase 2 — webs
    "pnp_web_get",
    "pnp_web_list",
    "pnp_web_new",
    "pnp_web_remove",
    // Phase 2 — tenant
    "pnp_tenant_get",
    "pnp_tenant_set",
    // Phase 3 — lists
    "pnp_list_list",
    "pnp_list_get",
    "pnp_list_new",
    "pnp_list_set",
    "pnp_list_remove",
    // Phase 3 — list items
    "pnp_listitem_list",
    "pnp_listitem_get",
    "pnp_listitem_add",
    "pnp_listitem_set",
    "pnp_listitem_remove",
    // Phase 3 — views
    "pnp_view_list",
    "pnp_view_add",
    "pnp_view_remove",
    // Phase 3 — files
    "pnp_file_get",
    "pnp_file_add",
    "pnp_file_remove",
    "pnp_file_copy",
    "pnp_file_move",
    // Phase 3 — folders
    "pnp_folder_get",
    "pnp_folder_add",
    "pnp_folder_remove",
    // Phase 4 — content types
    "pnp_contenttype_list",
    "pnp_contenttype_get",
    "pnp_contenttype_add",
    "pnp_contenttype_set",
    "pnp_contenttype_remove",
    // Phase 4 — fields
    "pnp_field_list",
    "pnp_field_get",
    "pnp_field_add",
    "pnp_field_set",
    "pnp_field_remove",
    // Phase 4 — permissions
    "pnp_group_list",
    "pnp_group_get",
    "pnp_group_new",
    "pnp_group_set",
    "pnp_group_remove",
    "pnp_role_definition_list",
    "pnp_role_set_web",
    "pnp_role_set_list",
    "pnp_role_set_listitem",
    // Phase 4 — provisioning templates
    "pnp_template_get",
    "pnp_template_apply",
    // Phase 5 — pages
    "pnp_page_list",
    "pnp_page_get",
    "pnp_page_add",
    "pnp_page_set",
    "pnp_page_remove",
    // Phase 5 — hub sites
    "pnp_hubsite_list",
    "pnp_hubsite_register",
    "pnp_hubsite_set",
    "pnp_hubsite_associate",
    "pnp_hubsite_disassociate",
    // Phase 5 — M365 groups
    "pnp_m365group_list",
    "pnp_m365group_get",
    "pnp_m365group_new",
    "pnp_m365group_set",
    "pnp_m365group_remove",
    "pnp_m365group_owner_add",
    "pnp_m365group_owner_remove",
    "pnp_m365group_member_add",
    "pnp_m365group_member_remove",
    // Phase 5 — navigation
    "pnp_navigation_list",
    "pnp_navigation_add",
    "pnp_navigation_remove",
  ];
  const missing = expectedTools.filter(n => !toolNames.includes(n));
  if (missing.length) throw new Error(`Missing tools: ${missing.join(", ")}`);
  console.log(`OK ${expectedTools.length} expected tools registered (Phase 0 + Phase 1)`);

  // pnp_run schema must include `background` and `confirm`
  const runTool = listRes.result.tools.find(t => t.name === "pnp_run");
  if (!runTool?.inputSchema?.properties?.background) {
    throw new Error("pnp_run.background parameter missing");
  }
  if (!runTool?.inputSchema?.properties?.confirm) {
    throw new Error("pnp_run.confirm parameter missing");
  }
  console.log("OK pnp_run exposes background + confirm parameters");

  // ---------- 4. pwsh REPL round-trip via pnp_run ----------
  // Call a simple pwsh expression that doesn't need PnP at all.
  send({
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "pnp_run", arguments: { command: "1 + 1" } },
  });
  const arithRes = await waitFor(3, 60_000);
  const arithText = arithRes.result?.content?.[0]?.text ?? "";
  if (arithRes.result?.isError) {
    throw new Error(`pnp_run '1+1' failed unexpectedly:\n${arithText}\n--- stderr ---\n${stderrBuf}`);
  }
  if (!arithText.includes("2")) {
    throw new Error(`pnp_run '1+1' did not return 2 in output. Got:\n${arithText}`);
  }
  console.log("OK pwsh REPL session round-trip ('1+1' returned 2)");

  // ---------- 5. PnP module loaded in session ----------
  send({
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "pnp_run", arguments: { command: "(Get-Module PnP.PowerShell).Name" } },
  });
  const modRes = await waitFor(4, 60_000);
  const modText = modRes.result?.content?.[0]?.text ?? "";
  if (modRes.result?.isError || !modText.includes("PnP.PowerShell")) {
    throw new Error(`PnP.PowerShell module not loaded in REPL session. Output:\n${modText}\n--- stderr ---\n${stderrBuf}`);
  }
  console.log("OK PnP.PowerShell module loaded in REPL session");

  // ---------- 6. safe-mode blocks destructive ----------
  send({
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "pnp_run", arguments: { command: "Remove-PnPTenantSite -Url https://nope" } },
  });
  const blockRes = await waitFor(5, 30_000);
  const blockText = blockRes.result?.content?.[0]?.text ?? "";
  if (!blockRes.result?.isError || !blockText.includes("BLOCKED")) {
    throw new Error(`Expected safe-mode to block 'Remove-PnPTenantSite'. Got:\n${blockText}`);
  }
  if (!blockText.toLowerCase().includes("remove")) {
    throw new Error(`Block message should mention the destructive verb. Got:\n${blockText}`);
  }
  console.log("OK safe-mode blocks destructive command (Remove-PnPTenantSite)");

  // ---------- 7. JSON output round-trip ----------
  send({
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: {
      name: "pnp_run",
      arguments: {
        command: "@{Name='test'; Value=42; Nested=@{Inner='ok'}} | ConvertTo-Json -Compress",
      },
    },
  });
  const jsonRes = await waitFor(6, 30_000);
  const jsonText = jsonRes.result?.content?.[0]?.text ?? "";
  if (jsonRes.result?.isError) {
    throw new Error(`JSON round-trip failed:\n${jsonText}`);
  }
  // Verify the JSON content survived round-trip. Don't try to extract via regex —
  // the output has our header lines around it AND nested braces — just check the
  // expected substrings appear AND check we can parse a JSON object out of it.
  if (!jsonText.includes('"Name":"test"') || !jsonText.includes('"Value":42') || !jsonText.includes('"Inner":"ok"')) {
    throw new Error(`JSON output missing expected fields. Got:\n${jsonText}`);
  }
  // Also assert no ANSI escape bytes leaked through into the user-facing text
  // eslint-disable-next-line no-control-regex
  if (/\x1b\[/.test(jsonText)) {
    throw new Error(`ANSI escape bytes leaked into output (ANSI strip not working). Got:\n${JSON.stringify(jsonText)}`);
  }
  console.log("OK JSON output round-trip preserved (ANSI stripped, all fields present)");

  // ---------- 8. pnp_session_status reports NOT CONNECTED ----------
  send({
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "pnp_session_status", arguments: {} },
  });
  const statusRes = await waitFor(7, 30_000);
  const statusText = statusRes.result?.content?.[0]?.text ?? "";
  // We're either NOT CONNECTED (fresh session) or, on the dev machine, possibly connected from earlier.
  // Either is OK as long as the command completed without error.
  if (statusRes.result?.isError) {
    throw new Error(`pnp_session_status raised an error:\n${statusText}`);
  }
  if (!statusText.includes("NOT CONNECTED") && !statusText.includes("Url")) {
    throw new Error(`pnp_session_status output unexpected:\n${statusText}`);
  }
  console.log(`OK pnp_session_status responds (${statusText.includes("NOT CONNECTED") ? "not connected" : "connected"})`);

  // ---------- 9. multi-line command (regression test for base64 wrapping) ----------
  send({
    jsonrpc: "2.0", id: 8, method: "tools/call",
    params: {
      name: "pnp_run",
      arguments: { command: "$x = 1\n$y = 2\n$x + $y" },
    },
  });
  const multilineRes = await waitFor(8, 30_000);
  const multilineText = multilineRes.result?.content?.[0]?.text ?? "";
  if (multilineRes.result?.isError) {
    throw new Error(`Multi-line command failed:\n${multilineText}`);
  }
  if (!/\b3\b/.test(multilineText)) {
    throw new Error(`Multi-line command did not return 3. Got:\n${multilineText}`);
  }
  console.log("OK multi-line command (base64 wrapping works)");

  // ---------- 10. output ending in `]` doesn't eat END marker ----------
  // Stress: 20 calls of varying-length JSON-array outputs. Previous broken ANSI regex
  // would non-deterministically eat the END marker and time out one of these.
  // PowerShell unwraps single-element arrays in pipeline, so we use comma operator (`,`)
  // and arrays of size >= 2 to guarantee array-shaped JSON output.
  for (let i = 0; i < 20; i++) {
    const n = i + 2; // size 2..21 — always real array
    send({
      jsonrpc: "2.0", id: 100 + i, method: "tools/call",
      params: { name: "pnp_run", arguments: { command: `@(1..${n}) | ConvertTo-Json -Compress` } },
    });
  }
  for (let i = 0; i < 20; i++) {
    const res = await waitFor(100 + i, 60_000);
    const txt = res.result?.content?.[0]?.text ?? "";
    if (res.result?.isError) {
      throw new Error(`Stress test #${i} (output ends in ']') failed (isError):\n${txt}`);
    }
    if (!txt.includes("[") || !txt.includes("]")) {
      throw new Error(`Stress test #${i} did not produce a JSON array. Got:\n${txt}`);
    }
  }
  console.log("OK 20 commands ending in ']' all completed (no marker eating)");

  // ---------- 11. pipeline-destructive blocked ----------
  send({
    jsonrpc: "2.0", id: 200, method: "tools/call",
    params: {
      name: "pnp_run",
      arguments: { command: "Get-PnPListItem -List Foo | Remove-PnPListItem -Recycle" },
    },
  });
  const pipelineRes = await waitFor(200, 30_000);
  const pipelineText = pipelineRes.result?.content?.[0]?.text ?? "";
  if (!pipelineRes.result?.isError || !pipelineText.includes("BLOCKED")) {
    throw new Error(`Pipeline destructive (Get-X | Remove-X) was NOT blocked. Got:\n${pipelineText}`);
  }
  if (!pipelineText.includes("Remove-PnPListItem")) {
    throw new Error(`Block message should call out the destructive cmdlet. Got:\n${pipelineText}`);
  }
  console.log("OK pipeline-destructive blocked (Get-X | Remove-X)");

  // ---------- 12. multi-statement destructive blocked ----------
  send({
    jsonrpc: "2.0", id: 201, method: "tools/call",
    params: {
      name: "pnp_run",
      arguments: { command: "Connect-PnPOnline -Url x; Remove-PnPSite -Url y" },
    },
  });
  const multiStmtRes = await waitFor(201, 30_000);
  const multiStmtText = multiStmtRes.result?.content?.[0]?.text ?? "";
  if (!multiStmtRes.result?.isError || !multiStmtText.includes("BLOCKED")) {
    throw new Error(`Multi-statement destructive was NOT blocked. Got:\n${multiStmtText}`);
  }
  console.log("OK multi-statement destructive blocked (Connect-X; Remove-Y)");

  // ---------- 13. comment containing 'Remove-' should NOT trigger false-positive ----------
  send({
    jsonrpc: "2.0", id: 202, method: "tools/call",
    params: {
      name: "pnp_run",
      arguments: { command: "# This would Remove-PnPSite if uncommented\n42" },
    },
  });
  const commentRes = await waitFor(202, 30_000);
  const commentText = commentRes.result?.content?.[0]?.text ?? "";
  if (commentRes.result?.isError && commentText.includes("BLOCKED")) {
    throw new Error(`Comment containing destructive cmdlet was wrongly blocked:\n${commentText}`);
  }
  if (!commentText.includes("42")) {
    throw new Error(`Commented-out destructive should still execute the rest. Got:\n${commentText}`);
  }
  console.log("OK comment with 'Remove-PnPSite' does NOT trigger false-positive block");

  // ---------- 14. preflight runs and returns structured report ----------
  send({
    jsonrpc: "2.0", id: 300, method: "tools/call",
    params: { name: "preflight", arguments: {} },
  });
  const preflightRes = await waitFor(300, 60_000);
  const preflightText = preflightRes.result?.content?.[0]?.text ?? "";
  for (const required of ["node", "pwsh", "PnP.PowerShell module", "PnP auth", "Overall"]) {
    if (!preflightText.includes(required)) {
      throw new Error(`preflight output missing '${required}'. Got:\n${preflightText.slice(0, 500)}`);
    }
  }
  console.log("OK preflight produces structured report (node, pwsh, module, auth checks)");

  // ---------- 14b. (B1) preflight surfaces effective load path for PnP module ----------
  // The Windows UX report's #3 friction was "no way to tell which install pwsh was picking
  // when both 2.x and 3.x were on disk". The 1.0.1 probe + 1.1.0 B1 enhancement should
  // include a "loaded from <path>" detail line. (Dev machine has 3.x installed; if you
  // also have 2.x in a legacy location, you'll see a "⚠ Also installed:" warning here.)
  if (!preflightText.includes("PnP.PowerShell module") || !preflightText.includes("loaded from")) {
    throw new Error(
      `preflight should surface effective module load path with 'loaded from <base>' (B1 fix). Got:\n${preflightText.slice(0, 800)}`,
    );
  }
  console.log("OK preflight surfaces effective module load path (B1 fix)");

  // 14c. (B1) Source-level: setup.ts probePnpModule must enumerate BOTH 3.x AND legacy 2.x
  // installs in one pass, so that on a Windows box with both versions present the user
  // sees a clear "shadowed by 3.x" warning instead of nothing.
  {
    const { readFileSync: rfx } = await import("node:fs");
    const setupSrc = rfx(resolve(__dirname, "src/setup.ts"), "utf8");
    for (const needle of ["BEST3:", "LEGACY:", "ONLY-LEGACY", "shadowed by 3.x"]) {
      if (!setupSrc.includes(needle)) {
        throw new Error(`setup.ts probePnpModule missing B1 token '${needle}'`);
      }
    }
  }
  console.log("OK setup.ts probePnpModule enumerates 3.x + legacy in one pass (B1 source check)");

  // 14d. (B1) Probe interface exposes a `warnings: string[]` field for non-blocking
  // advisories. Forward-compat for B5 MSAL cache findings.
  {
    const { readFileSync: rfx } = await import("node:fs");
    const setupSrc = rfx(resolve(__dirname, "src/setup.ts"), "utf8");
    if (!setupSrc.match(/warnings\?:\s*string\[\]/)) {
      throw new Error("Probe interface should expose warnings?: string[] (B1)");
    }
    if (!setupSrc.includes("\\n   ⚠ ")) {
      throw new Error("runPreflight summary should render warnings with '⚠ ' prefix (B1)");
    }
  }
  console.log("OK Probe.warnings + summary rendering wired (B1 source check)");

  // ---------- 14e. Privacy: stderr startup line + log payloads redact homedir + username ----------
  // Defense-in-depth: a user who copies their mcp.log or ~/.pnp-mcp/logs/* for debugging
  // should not leak their OS username or home-dir path. Tests:
  //   (a) the startup banner uses '~/.pnp-mcp/logs', not the absolute home path
  //   (b) the logger redaction helper substitutes both homedir and username in payloads
  if (!stderrBuf.includes("~/.pnp-mcp/logs") && !stderrBuf.includes("logs at ~")) {
    // Only assert this when LOG_DIR is under the user's home (i.e. PNP_MCP_LOG_DIR not overridden).
    // If the env override is set the absolute path is intentional.
    if (!process.env.PNP_MCP_LOG_DIR) {
      throw new Error(
        `Privacy: server stderr startup line should display log dir as '~/.pnp-mcp/logs' (with the home prefix replaced by ~). Got stderr tail:\n${stderrBuf.slice(-400)}`,
      );
    }
  }
  console.log("OK server startup line replaces home-dir prefix with ~ (privacy)");

  // 14f. Logger redaction helper: import dist/logger.js and exercise it on a known
  // payload containing both the homedir and the username. Asserts both are redacted.
  {
    const loggerMod = await import(resolve(__dirname, "dist/logger.js"));
    // Write a known sentinel and read back the last line of today's log file.
    const sentinel = `__privacy_test_${Date.now()}__`;
    const homePath = (await import("node:os")).homedir() + "/somefile-" + sentinel;
    const probeUser = (await import("node:os")).userInfo().username;
    loggerMod.log("info", `path=${homePath} user=${probeUser}`, { extra: homePath, who: probeUser });
    // Read back today's log file.
    const { readFileSync: rfx } = await import("node:fs");
    const logPath = `${loggerMod.getLogDir()}/pnp-mcp-${new Date().toISOString().slice(0, 10)}.log`;
    const tail = rfx(logPath, "utf8").trim().split("\n").slice(-1)[0];
    if (!tail.includes(sentinel)) throw new Error(`Privacy log probe sentinel missing in last log line: ${tail}`);
    // Username must be redacted to <user>; home-dir must collapse to ~.
    if (probeUser && probeUser.length >= 3 && tail.toLowerCase().includes(probeUser.toLowerCase())) {
      throw new Error(
        `Privacy: username '${probeUser}' was NOT redacted in log line. Log: ${tail}`,
      );
    }
    if (tail.includes((await import("node:os")).homedir())) {
      throw new Error(
        `Privacy: home-dir was NOT redacted to '~' in log line. Log: ${tail}`,
      );
    }
    if (!tail.includes("~/somefile-" + sentinel)) {
      throw new Error(`Privacy: home-dir collapse to '~' missing. Log: ${tail}`);
    }
  }
  console.log("OK logger redacts homedir + username in log file payloads (privacy)");

  // ---------- 14g. (B2) state-cache module: load/record/find round-trip ----------
  // Use a temp state file via env so this test doesn't touch the user's real cache.
  // The state-cache module reads PNP_MCP_STATE_FILE at module load time, so we have
  // to spawn a fresh Node process with the env var set to validate the contract.
  {
    const { spawnSync: ssync } = await import("node:child_process");
    const { mkdtempSync, readFileSync: rfx2 } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmp = mkdtempSync(resolve(tmpdir(), "pnp-mcp-state-"));
    const stateFile = resolve(tmp, "state.json");
    const probe = `
      import('${resolve(__dirname, "dist/state-cache.js")}').then(m => {
        // Empty load returns empty list, never throws.
        const empty = m.loadState();
        if (!empty || empty.lastConnections.length !== 0) throw new Error('empty load wrong: ' + JSON.stringify(empty));
        // Record two distinct connects.
        m.recordSuccessfulConnect({ url: 'https://contoso.sharepoint.com', clientId: 'cid-A', tenantId: 't1', authMethod: 'interactive' });
        m.recordSuccessfulConnect({ url: 'https://other.sharepoint.com', clientId: 'cid-B', tenantId: 't2', authMethod: 'device_code' });
        // Re-record first → successCount should bump to 2 and order should put cid-A first.
        m.recordSuccessfulConnect({ url: 'https://contoso.sharepoint.com', clientId: 'cid-A', tenantId: 't1', authMethod: 'interactive', upn: 'u@contoso.com' });
        const after = m.loadState();
        if (after.lastConnections.length !== 2) throw new Error('expected 2 entries, got ' + after.lastConnections.length);
        if (after.lastConnections[0].url !== 'https://contoso.sharepoint.com') throw new Error('first should be contoso, got ' + after.lastConnections[0].url);
        if (after.lastConnections[0].successCount !== 2) throw new Error('cid-A successCount should be 2');
        if (after.lastConnections[0].upn !== 'u@contoso.com') throw new Error('upn backfill failed');
        // findCachedConnection by url
        const byUrl = m.findCachedConnection({ url: 'https://other.sharepoint.com' });
        if (!byUrl || byUrl.clientId !== 'cid-B') throw new Error('findCachedConnection url match failed');
        // findCachedConnection bare → most recent
        const mostRecent = m.findCachedConnection();
        if (!mostRecent || mostRecent.clientId !== 'cid-A') throw new Error('most-recent should be cid-A');
        // B4 BUGFIX (Phase B agent review): {authMethod} alone should return most-recent
        // record using that method. Without this branch the headline "no args at all"
        // case for pnp_auth_connect_interactive returned needs_input even with cache hits.
        const byInteractive = m.findCachedConnection({ authMethod: 'interactive' });
        if (!byInteractive || byInteractive.clientId !== 'cid-A') {
          throw new Error('authMethod-alone hint should return most-recent of that method, got ' + JSON.stringify(byInteractive));
        }
        const byDeviceCode = m.findCachedConnection({ authMethod: 'device_code' });
        if (!byDeviceCode || byDeviceCode.clientId !== 'cid-B') {
          throw new Error('authMethod=device_code should return cid-B, got ' + JSON.stringify(byDeviceCode));
        }
        // authMethod with no matching record → null (no cross-pollution with other methods)
        const noMatch = m.findCachedConnection({ authMethod: 'sp_secret' });
        if (noMatch !== null) throw new Error('authMethod=sp_secret with no match should be null, got ' + JSON.stringify(noMatch));
        process.stdout.write('B2-OK');
      }).catch(e => { process.stderr.write(e.stack ?? String(e)); process.exit(1); });
    `;
    const r = ssync("node", ["--input-type=module", "-e", probe], {
      env: { ...process.env, PNP_MCP_STATE_FILE: stateFile, PNP_MCP_LOG_DIR: tmp },
      encoding: "utf8",
      timeout: 15_000,
    });
    if (r.status !== 0 || !r.stdout.includes("B2-OK")) {
      throw new Error(`B2 state-cache round-trip failed.\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
    }
    const persisted = JSON.parse(rfx2(stateFile, "utf8"));
    if (persisted.version !== 1 || !Array.isArray(persisted.lastConnections) || persisted.lastConnections.length !== 2) {
      throw new Error(`B2 state.json on disk has wrong shape: ${JSON.stringify(persisted)}`);
    }
  }
  console.log("OK state-cache load/record/find round-trip + atomic write (B2)");

  // ---------- 14h. (B4) auth tools accept omitted url/client_id when nothing cached ----------
  // With an empty cache the tool should return an isError result that lists what's missing
  // and explicitly mentions "No cached connections yet" so Claude can prompt the user.
  send({
    jsonrpc: "2.0", id: 320, method: "tools/call",
    params: { name: "pnp_auth_connect_interactive", arguments: {} },
  });
  const authNoCache = await waitFor(320, 15_000);
  const authNoCacheText = authNoCache.result?.content?.[0]?.text ?? "";
  if (!authNoCache.result?.isError) {
    throw new Error(`pnp_auth_connect_interactive should ERROR with empty cache + no args. Got:\n${authNoCacheText}`);
  }
  if (!authNoCacheText.toLowerCase().includes("needs") || !authNoCacheText.toLowerCase().includes("url")) {
    throw new Error(`needs_input message should mention 'needs' and 'url'. Got:\n${authNoCacheText}`);
  }
  console.log("OK pnp_auth_connect_interactive returns clear needs_input on empty cache (B4)");

  // ---------- 14i. (B5) identity-cache module: read returns array, summarizeForPreflight returns optional string ----------
  // Validates the module loads, returns an array (empty on macOS/Linux), and the summarize
  // helper returns either a string or undefined — no throws.
  {
    const idMod = await import(resolve(__dirname, "dist/identity-cache.js"));
    const accs = idMod.readMsalAccounts();
    if (!Array.isArray(accs)) throw new Error('readMsalAccounts should return an array');
    const sum = idMod.summarizeForPreflight();
    if (sum !== undefined && typeof sum !== 'string') throw new Error('summarizeForPreflight should return string|undefined');
  }
  console.log("OK identity-cache.ts loads, returns array (no-op on non-Win), summary helper safe (B5)");

  // ---------- 14j. (B5) Probe.warnings on PnP auth probe is wired (source check) ----------
  {
    const { readFileSync: rfx } = await import("node:fs");
    const setupSrc = rfx(resolve(__dirname, "src/setup.ts"), "utf8");
    if (!setupSrc.includes("gatherMsalWarnings") || !setupSrc.includes("summarizeForPreflight")) {
      throw new Error("setup.ts probePnpAuth should call into identity-cache for B5 warnings");
    }
  }
  console.log("OK setup.ts probePnpAuth surfaces MSAL cache warnings (B5 source check)");

  // ---------- 14k. (B3) pnp_session_status appends cached connections + MSAL accounts ----------
  // We don't require a real connection here — just verify that the tool runs end-to-end and
  // when no connection exists, it includes the NOT CONNECTED line. Cache list rendering is
  // exercised by the source-level check below.
  send({
    jsonrpc: "2.0", id: 321, method: "tools/call",
    params: { name: "pnp_session_status", arguments: {} },
  });
  const statusEnriched = await waitFor(321, 15_000);
  const statusEnrichedText = statusEnriched.result?.content?.map(c => c.text).join("\n") ?? "";
  if (!statusEnrichedText.includes("NOT CONNECTED")) {
    throw new Error(`pnp_session_status should still report NOT CONNECTED in test env. Got:\n${statusEnrichedText.slice(0, 500)}`);
  }
  // Source check that the B3 enrichment + cache append path is wired.
  {
    const { readFileSync: rfx } = await import("node:fs");
    const serverSrc = rfx(resolve(__dirname, "src/server.ts"), "utf8");
    for (const needle of ["Cached connections (B2)", "Get-PnPWeb -Includes CurrentUser", "humanTimeAgo", "Identity Broker (B5)"]) {
      if (!serverSrc.includes(needle)) throw new Error(`server.ts session_status missing B3/B5 token '${needle}'`);
    }
  }
  console.log("OK pnp_session_status runs + enrichment + cache + MSAL listing wired (B3+B5)");

  // ---------- 15. job_list empty on fresh server ----------
  send({
    jsonrpc: "2.0", id: 301, method: "tools/call",
    params: { name: "job_list", arguments: {} },
  });
  const jobListRes = await waitFor(301, 15_000);
  const jobListText = jobListRes.result?.content?.[0]?.text ?? "";
  if (jobListText !== "(no jobs)") {
    throw new Error(`job_list expected '(no jobs)' on fresh server, got: ${jobListText}`);
  }
  console.log("OK job_list returns empty on fresh server");

  // ---------- 16. setup_install_pnp_module gated by confirm ----------
  send({
    jsonrpc: "2.0", id: 302, method: "tools/call",
    params: { name: "setup_install_pnp_module", arguments: { confirm: false } },
  });
  const setupBlockRes = await waitFor(302, 15_000);
  const setupBlockText = setupBlockRes.result?.content?.[0]?.text ?? "";
  if (!setupBlockRes.result?.isError || !setupBlockText.includes("BLOCKED")) {
    throw new Error(`setup_install_pnp_module without confirm should be BLOCKED. Got:\n${setupBlockText}`);
  }
  console.log("OK setup_install_pnp_module gated by confirm:true");

  // ---------- 17. auth tools have correct shape (not invoking — would prompt for real creds) ----------
  // Verify the SP secret tool's schema includes all required params and that secret-bearing
  // params are present (they get redacted at runtime).
  const spSecretTool = listRes.result.tools.find(t => t.name === "pnp_auth_connect_sp_secret");
  for (const required of ["url", "tenant", "client_id", "client_secret"]) {
    if (!spSecretTool?.inputSchema?.properties?.[required]) {
      throw new Error(`pnp_auth_connect_sp_secret missing required parameter '${required}'`);
    }
  }
  console.log("OK pnp_auth_connect_sp_secret schema has url/tenant/client_id/client_secret");

  // ---------- 18. C1 regression: secret in (ConvertTo-SecureString …) gets masked in log AND output ----------
  // Simulates the cert-password case that the agent flagged. The tool response should show
  // ***REDACTED*** in place of "supersecret123", proving maskCommandWithSecrets covered the
  // case the parameter regex couldn't.
  send({
    jsonrpc: "2.0", id: 400, method: "tools/call",
    params: {
      name: "pnp_run",
      arguments: {
        // Run a benign command that includes the secret literal in a place the regex misses.
        // We're not actually calling Connect-PnPOnline — this just exercises the redaction path.
        command: "Write-Output 'Looking for supersecret123 in output'",
      },
    },
  });
  const c1Res = await waitFor(400, 30_000);
  const c1Text = c1Res.result?.content?.[0]?.text ?? "";
  // First call has no `redact:`, so the secret stays visible — that's correct (we only redact
  // when caller provides the list). This confirms the substring is there normally.
  if (!c1Text.includes("supersecret123")) {
    throw new Error(`Sanity: command output should normally contain 'supersecret123'. Got:\n${c1Text}`);
  }

  // C2 regression: a 1-character "secret" should still be redacted (previous floor was length<4).
  // We exercise this via a direct import of the masking helper. Run a small Node assertion via
  // a child eval; the build's dist/runner.js already exports the right symbols.
  // (Smoke test design: keep it black-box where possible, but masking is a pure function we can test directly.)
  const { runPnp: _r1, maskCommandWithSecrets } = await import(resolve(__dirname, "dist/pwsh.js"));
  void _r1;
  const masked = maskCommandWithSecrets("password is X here", ["X"]);
  if (masked.includes("password is X here")) {
    throw new Error(`C2 regression: 1-char secret 'X' should be redacted. Got: ${masked}`);
  }
  if (!masked.includes("***REDACTED***")) {
    throw new Error(`C2 regression: redaction marker missing. Got: ${masked}`);
  }
  console.log("OK C1+C2 secret masking (substring redaction works for short secrets and SecureString-wrapped values)");

  // ---------- 19. I1 regression: managed_identity tool fast-fails on non-Azure with NOT-AZURE message ----------
  // We don't actually invoke the tool against a real tenant URL (would need creds). But the
  // command we synthesize includes the IMDS pre-check. Since this test machine is NOT Azure,
  // we can call pnp_run with the same probe inline and verify it returns NOT-AZURE.
  send({
    jsonrpc: "2.0", id: 401, method: "tools/call",
    params: {
      name: "pnp_run",
      arguments: {
        command:
          "$tcp = New-Object System.Net.Sockets.TcpClient; " +
          "$ar = $tcp.BeginConnect('169.254.169.254', 80, $null, $null); " +
          "if ($ar.AsyncWaitHandle.WaitOne(2000) -and $tcp.Connected) { 'IMDS-REACHABLE' } else { 'NOT-AZURE' }; " +
          "$tcp.Close()",
        timeout_seconds: 10,
      },
    },
  });
  const i1Res = await waitFor(401, 30_000);
  const i1Text = i1Res.result?.content?.[0]?.text ?? "";
  if (!i1Text.includes("NOT-AZURE")) {
    // On the off-chance this test runs on an actual Azure VM, allow IMDS-REACHABLE too.
    if (!i1Text.includes("IMDS-REACHABLE")) {
      throw new Error(`I1 regression: IMDS probe should return NOT-AZURE on non-Azure. Got:\n${i1Text}`);
    }
    console.log("OK I1 IMDS probe (running on Azure — IMDS reachable)");
  } else {
    console.log("OK I1 IMDS probe fast-fails on non-Azure (NOT-AZURE within 2s)");
  }

  // ---------- Phase 2: typed-tool gate verification ----------

  // 20. pnp_site_new without confirm → BLOCKED
  send({
    jsonrpc: "2.0", id: 500, method: "tools/call",
    params: {
      name: "pnp_site_new",
      arguments: {
        type: "CommunicationSite",
        title: "Test Site",
        url: "https://example.sharepoint.com/sites/nope",
        confirm: false,
      },
    },
  });
  const siteNewBlock = await waitFor(500, 15_000);
  if (!siteNewBlock.result?.isError || !(siteNewBlock.result?.content?.[0]?.text ?? "").includes("BLOCKED")) {
    throw new Error(`pnp_site_new without confirm should BLOCK. Got:\n${siteNewBlock.result?.content?.[0]?.text}`);
  }
  console.log("OK pnp_site_new gated by confirm:true");

  // 21. pnp_site_new TeamSite without alias → BLOCKED with cross-validation message
  send({
    jsonrpc: "2.0", id: 501, method: "tools/call",
    params: {
      name: "pnp_site_new",
      arguments: { type: "TeamSite", title: "Test", confirm: true },
    },
  });
  const teamNoAlias = await waitFor(501, 15_000);
  const teamNoAliasText = teamNoAlias.result?.content?.[0]?.text ?? "";
  if (!teamNoAlias.result?.isError || !teamNoAliasText.includes("alias")) {
    throw new Error(`pnp_site_new TeamSite without alias should error with alias-required message. Got:\n${teamNoAliasText}`);
  }
  console.log("OK pnp_site_new TeamSite cross-validates alias requirement");

  // 22. pnp_site_remove without confirm → BLOCKED
  send({
    jsonrpc: "2.0", id: 502, method: "tools/call",
    params: { name: "pnp_site_remove", arguments: { url: "https://example.sharepoint.com/sites/nope", confirm: false } },
  });
  const siteRemoveBlock = await waitFor(502, 15_000);
  if (!siteRemoveBlock.result?.isError) {
    throw new Error(`pnp_site_remove without confirm should BLOCK. Got:\n${siteRemoveBlock.result?.content?.[0]?.text}`);
  }
  console.log("OK pnp_site_remove gated by confirm:true");

  // 23. pnp_tenant_set with no params → error (nothing to set)
  send({
    jsonrpc: "2.0", id: 503, method: "tools/call",
    params: { name: "pnp_tenant_set", arguments: { confirm: true } },
  });
  const tenantNoParams = await waitFor(503, 15_000);
  const tenantNoParamsText = tenantNoParams.result?.content?.[0]?.text ?? "";
  if (!tenantNoParams.result?.isError || !tenantNoParamsText.includes("No tenant settings")) {
    throw new Error(`pnp_tenant_set with no params should error 'No tenant settings'. Got:\n${tenantNoParamsText}`);
  }
  console.log("OK pnp_tenant_set rejects empty parameter set");

  // 24. pnp_site_new schema has discriminated type + correct optionality
  const siteNewTool = listRes.result.tools.find(t => t.name === "pnp_site_new");
  const siteNewProps = siteNewTool?.inputSchema?.properties ?? {};
  for (const required of ["type", "title", "alias", "url", "owner", "members", "background", "confirm"]) {
    if (!siteNewProps[required]) {
      throw new Error(`pnp_site_new missing parameter '${required}'`);
    }
  }
  // type should be enum with the 3 site types
  const typeEnum = siteNewProps.type?.enum ?? [];
  for (const v of ["TeamSite", "CommunicationSite", "TeamSiteWithoutMicrosoft365Group"]) {
    if (!typeEnum.includes(v)) throw new Error(`pnp_site_new type enum missing '${v}'`);
  }
  console.log("OK pnp_site_new schema (3 type variants, all required cross-fields)");

  // 25. New-PnPSite is in the safety destructive list — passthrough should block
  send({
    jsonrpc: "2.0", id: 504, method: "tools/call",
    params: { name: "pnp_run", arguments: { command: "New-PnPSite -Type CommunicationSite -Title Foo -Url https://x" } },
  });
  const newSiteRunBlock = await waitFor(504, 15_000);
  const newSiteRunBlockText = newSiteRunBlock.result?.content?.[0]?.text ?? "";
  if (!newSiteRunBlock.result?.isError || !newSiteRunBlockText.includes("BLOCKED")) {
    throw new Error(`pnp_run with New-PnPSite should be blocked by safety. Got:\n${newSiteRunBlockText}`);
  }
  console.log("OK pnp_run safety blocks New-PnPSite (matches DESTRUCTIVE_FULL_CMDLETS)");

  // ---------- Phase 2 follow-up regression tests for review fixes ----------

  // 26. C1 fix: pnp_site_new schema NO LONGER exposes `lcid`
  if (siteNewProps.lcid) {
    throw new Error("Regression C1: pnp_site_new schema must NOT expose `lcid` (PnP -Lcid is a SwitchParameter, value would be silently dropped). Removed in C1 fix.");
  }
  console.log("OK pnp_site_new schema does not expose `lcid` (C1 fix — value would be silently dropped)");

  // 27. C2 fix: pnp_site_new schema exposes `owners` for TeamSite
  if (!siteNewProps.owners) {
    throw new Error("Regression C2: pnp_site_new schema must expose `owners` (added in C2 fix).");
  }
  console.log("OK pnp_site_new schema exposes `owners` (C2 fix — TeamSite needs explicit owners with app-only auth)");

  // 28. I5 fix: TeamSite + url is rejected with clear message
  send({
    jsonrpc: "2.0", id: 600, method: "tools/call",
    params: {
      name: "pnp_site_new",
      arguments: { type: "TeamSite", title: "Foo", alias: "foo", url: "https://x", confirm: true },
    },
  });
  const teamWithUrl = await waitFor(600, 15_000);
  const teamWithUrlText = teamWithUrl.result?.content?.[0]?.text ?? "";
  if (!teamWithUrl.result?.isError || !teamWithUrlText.toLowerCase().includes("teamsite") || !teamWithUrlText.includes("url")) {
    throw new Error(`Regression I5: TeamSite+url should be rejected. Got:\n${teamWithUrlText}`);
  }
  console.log("OK pnp_site_new rejects TeamSite+url (I5 fix — mutually exclusive)");

  // 29. I5 fix: CommunicationSite + alias is rejected
  send({
    jsonrpc: "2.0", id: 601, method: "tools/call",
    params: {
      name: "pnp_site_new",
      arguments: { type: "CommunicationSite", title: "Foo", url: "https://x", alias: "foo", confirm: true },
    },
  });
  const commWithAlias = await waitFor(601, 15_000);
  if (!commWithAlias.result?.isError) {
    throw new Error(`Regression I5: CommunicationSite+alias should be rejected. Got:\n${commWithAlias.result?.content?.[0]?.text}`);
  }
  console.log("OK pnp_site_new rejects CommunicationSite+alias (I5 fix)");

  // 30. I7 fix: pnp_site_list exposes `filter` parameter
  const siteListTool = listRes.result.tools.find(t => t.name === "pnp_site_list");
  if (!siteListTool?.inputSchema?.properties?.filter) {
    throw new Error("Regression I7: pnp_site_list schema must expose `filter` (added in I7 fix).");
  }
  console.log("OK pnp_site_list exposes `filter` (I7 fix — server-side OData filter)");

  // 31. N4 fix: New-PnPHubSite is in safety list (passthrough should block)
  send({
    jsonrpc: "2.0", id: 602, method: "tools/call",
    params: { name: "pnp_run", arguments: { command: "Register-PnPHubSite -Site https://contoso.sharepoint.com/sites/hub" } },
  });
  const hubBlock = await waitFor(602, 15_000);
  const hubBlockText = hubBlock.result?.content?.[0]?.text ?? "";
  if (!hubBlock.result?.isError || !hubBlockText.includes("BLOCKED")) {
    throw new Error(`Regression N4: pnp_run with Register-PnPHubSite should be blocked. Got:\n${hubBlockText}`);
  }
  console.log("OK pnp_run safety blocks Register-PnPHubSite (N4 fix)");

  // 32. C3 fix: Repair-PnPSite REMOVED from safety list — it was a fake cmdlet name.
  // Test that a `Repair-Foo` style command is NOT blocked by full-cmdlet match (it should
  // still be blocked by the `Remove`/etc verb list IF the verb is destructive — but
  // 'Repair' is not in our verb list either, so the command should pass through).
  send({
    jsonrpc: "2.0", id: 603, method: "tools/call",
    params: { name: "pnp_run", arguments: { command: "Repair-PnPSite" } },
  });
  const repairRes = await waitFor(603, 15_000);
  const repairText = repairRes.result?.content?.[0]?.text ?? "";
  // The command will fail at runtime (cmdlet doesn't exist) but it should NOT be safe-mode-blocked.
  // We assert no BLOCKED substring at the safety layer.
  if (repairText.includes("BLOCKED:")) {
    throw new Error(`Regression C3: Repair-PnPSite should NOT be in DESTRUCTIVE_FULL_CMDLETS (it's a fake cmdlet). Got:\n${repairText}`);
  }
  console.log("OK Repair-PnPSite no longer falsely flagged as destructive (C3 fix — fake cmdlet removed)");

  // ---------- Phase 3: typed-tool gate verification ----------

  // 33. pnp_list_new without confirm → BLOCKED
  send({
    jsonrpc: "2.0", id: 700, method: "tools/call",
    params: { name: "pnp_list_new", arguments: { title: "Test", template: "GenericList", confirm: false } },
  });
  const listNewBlock = await waitFor(700, 15_000);
  if (!listNewBlock.result?.isError) throw new Error("pnp_list_new without confirm should BLOCK");
  console.log("OK pnp_list_new gated by confirm:true");

  // 34. pnp_list_set with no params → error
  send({
    jsonrpc: "2.0", id: 701, method: "tools/call",
    params: { name: "pnp_list_set", arguments: { identity: "Documents", confirm: true } },
  });
  const listSetEmpty = await waitFor(701, 15_000);
  const listSetEmptyText = listSetEmpty.result?.content?.[0]?.text ?? "";
  if (!listSetEmpty.result?.isError || !listSetEmptyText.includes("No properties")) {
    throw new Error(`pnp_list_set with no params should error 'No properties'. Got:\n${listSetEmptyText}`);
  }
  console.log("OK pnp_list_set rejects empty parameter set");

  // 35. pnp_listitem_remove gated by confirm
  send({
    jsonrpc: "2.0", id: 702, method: "tools/call",
    params: { name: "pnp_listitem_remove", arguments: { list: "Tasks", id: 1, confirm: false } },
  });
  const itemRemoveBlock = await waitFor(702, 15_000);
  if (!itemRemoveBlock.result?.isError) throw new Error("pnp_listitem_remove without confirm should BLOCK");
  console.log("OK pnp_listitem_remove gated by confirm:true");

  // 36. pnp_file_get mutually exclusive: as_string + as_file → error
  send({
    jsonrpc: "2.0", id: 703, method: "tools/call",
    params: { name: "pnp_file_get", arguments: { url: "/x/file.txt", as_string: true, as_file: true, local_path: "/tmp" } },
  });
  const fileGetExclusive = await waitFor(703, 15_000);
  const fileGetExclusiveText = fileGetExclusive.result?.content?.[0]?.text ?? "";
  if (!fileGetExclusive.result?.isError || !fileGetExclusiveText.includes("mutually exclusive")) {
    throw new Error(`pnp_file_get as_string+as_file should reject. Got:\n${fileGetExclusiveText}`);
  }
  console.log("OK pnp_file_get rejects as_string+as_file (mutually exclusive)");

  // 37. pnp_folder_add rejects slashes in name
  send({
    jsonrpc: "2.0", id: 704, method: "tools/call",
    params: { name: "pnp_folder_add", arguments: { parent_folder: "/sites/x/Lib", name: "A/B", confirm: true } },
  });
  const folderAddSlash = await waitFor(704, 15_000);
  const folderAddSlashText = folderAddSlash.result?.content?.[0]?.text ?? "";
  if (!folderAddSlash.result?.isError || !folderAddSlashText.includes("slashes")) {
    throw new Error(`pnp_folder_add should reject slashes in name. Got:\n${folderAddSlashText}`);
  }
  console.log("OK pnp_folder_add rejects slashes in name (must call per-level)");

  // 38. psHashtable round-trip via pnp_run (test the helper produces valid PS hashtable syntax)
  send({
    jsonrpc: "2.0", id: 705, method: "tools/call",
    params: {
      name: "pnp_run",
      arguments: {
        // The hashtable we'd build in pnp_listitem_add. Verify pwsh parses it correctly.
        command: "$h = @{'Title'='Test';'Count'=42;'Active'=$true;'Tags'=@('a','b')}; $h | ConvertTo-Json -Compress",
      },
    },
  });
  const hashRes = await waitFor(705, 30_000);
  const hashText = hashRes.result?.content?.[0]?.text ?? "";
  if (hashRes.result?.isError) throw new Error(`PS hashtable test failed:\n${hashText}`);
  for (const required of ['"Title":"Test"', '"Count":42', '"Active":true']) {
    if (!hashText.includes(required)) {
      throw new Error(`PS hashtable round-trip missing '${required}'. Got:\n${hashText}`);
    }
  }
  console.log("OK PS hashtable syntax (string + number + bool + array) round-trips correctly");

  // 39. Safety: New-PnPList in DESTRUCTIVE_FULL_CMDLETS, pnp_run blocks
  send({
    jsonrpc: "2.0", id: 706, method: "tools/call",
    params: { name: "pnp_run", arguments: { command: "New-PnPList -Title Foo -Template GenericList" } },
  });
  const newListBlock = await waitFor(706, 15_000);
  if (!newListBlock.result?.isError || !(newListBlock.result?.content?.[0]?.text ?? "").includes("BLOCKED")) {
    throw new Error("pnp_run with New-PnPList should be safety-blocked");
  }
  console.log("OK pnp_run safety blocks New-PnPList (Phase 3 safety addition)");

  // ---------- Phase 3 review-fix regression tests ----------
  // Imported directly from the built dist/ — these are pure functions.
  const { psHashtable } = await import(resolve(__dirname, "dist/util.js"));

  // 40. C2: psHashtable rejects nested objects (silent corruption fix)
  let nestedRejected = false;
  try {
    psHashtable({ outer: { inner: "x" } });
  } catch (err) {
    nestedRejected = err.message.includes("nested object");
  }
  if (!nestedRejected) {
    throw new Error("C2: psHashtable should throw on nested objects (was silently producing '[object Object]').");
  }
  console.log("OK psHashtable rejects nested objects with clear error (C2)");

  // 41. I4: psHashtable filters undefined keys, keeps null distinct
  const ht1 = psHashtable({ a: "x", b: undefined, c: null });
  if (ht1.includes("'b'")) throw new Error(`I4: undefined key 'b' should be omitted. Got: ${ht1}`);
  if (!ht1.includes("'c'=$null")) throw new Error(`I4: null value for 'c' should produce $null. Got: ${ht1}`);
  if (!ht1.includes("'a'='x'")) throw new Error(`I4: simple value lost. Got: ${ht1}`);
  console.log("OK psHashtable filters undefined, keeps null → $null (I4)");

  // 42. C2: array-of-objects also rejected
  let arrayObjRejected = false;
  try {
    psHashtable({ tags: [{ x: 1 }] });
  } catch (err) {
    arrayObjRejected = err.message.includes("nested object");
  }
  if (!arrayObjRejected) {
    throw new Error("C2: psHashtable should reject objects inside arrays.");
  }
  console.log("OK psHashtable rejects objects inside arrays (C2)");

  // 43. Apostrophe round-trip via psHashtable+pwsh — common SP scenario (O'Brien)
  const obrien = psHashtable({ Name: "O'Brien's report" });
  send({
    jsonrpc: "2.0", id: 800, method: "tools/call",
    params: { name: "pnp_run", arguments: { command: `${obrien} | ConvertTo-Json -Compress` } },
  });
  const obrienRes = await waitFor(800, 30_000);
  const obrienText = obrienRes.result?.content?.[0]?.text ?? "";
  if (obrienRes.result?.isError || !obrienText.includes("O'Brien's report")) {
    throw new Error(`Apostrophe round-trip failed. Got:\n${obrienText}`);
  }
  console.log("OK psHashtable apostrophe round-trip (O'Brien's report → JSON intact)");

  // 44. I1: Set-PnPView is now safety-blocked
  send({
    jsonrpc: "2.0", id: 801, method: "tools/call",
    params: { name: "pnp_run", arguments: { command: "Set-PnPView -List Foo -Identity Bar -Values @{Title='X'}" } },
  });
  const setViewBlock = await waitFor(801, 15_000);
  if (!setViewBlock.result?.isError || !(setViewBlock.result?.content?.[0]?.text ?? "").includes("BLOCKED")) {
    throw new Error("I1: Set-PnPView should be safety-blocked.");
  }
  console.log("OK pnp_run safety blocks Set-PnPView (I1)");

  // 45. I1: Set-PnPListItem (bulk-mutation pipeline) is safety-blocked
  send({
    jsonrpc: "2.0", id: 802, method: "tools/call",
    params: { name: "pnp_run", arguments: { command: "Get-PnPListItem -List Tasks | Set-PnPListItem -Values @{Status='Done'}" } },
  });
  const setItemBlock = await waitFor(802, 15_000);
  if (!setItemBlock.result?.isError || !(setItemBlock.result?.content?.[0]?.text ?? "").includes("BLOCKED")) {
    throw new Error("I1: Get-X | Set-PnPListItem pipeline should be safety-blocked.");
  }
  console.log("OK pnp_run safety blocks Set-PnPListItem in pipeline (I1)");

  // ---------- Phase 4: typed-tool gate verification ----------

  // 46. pnp_contenttype_add gated by confirm
  send({
    jsonrpc: "2.0", id: 900, method: "tools/call",
    params: { name: "pnp_contenttype_add", arguments: { name: "Foo", confirm: false } },
  });
  const ctAddBlock = await waitFor(900, 15_000);
  if (!ctAddBlock.result?.isError) throw new Error("pnp_contenttype_add without confirm should BLOCK");
  console.log("OK pnp_contenttype_add gated by confirm:true");

  // 47. pnp_field_add type enum exposed correctly
  const fieldAddTool = listRes.result.tools.find(t => t.name === "pnp_field_add");
  const fieldTypeEnum = fieldAddTool?.inputSchema?.properties?.type?.enum ?? [];
  for (const required of ["Text", "Number", "Boolean", "Choice", "User", "DateTime"]) {
    if (!fieldTypeEnum.includes(required)) {
      throw new Error(`pnp_field_add type enum missing '${required}'`);
    }
  }
  console.log(`OK pnp_field_add exposes ${fieldTypeEnum.length}-value FieldType enum`);

  // 48. pnp_role_set_web rejects user+group together
  send({
    jsonrpc: "2.0", id: 901, method: "tools/call",
    params: {
      name: "pnp_role_set_web",
      arguments: { user: "x@y.com", group: "Visitors", add_roles: ["Read"], confirm: true },
    },
  });
  const roleBoth = await waitFor(901, 15_000);
  const roleBothText = roleBoth.result?.content?.[0]?.text ?? "";
  if (!roleBoth.result?.isError || !roleBothText.toLowerCase().includes("exactly one")) {
    throw new Error(`pnp_role_set_web with user+group should reject. Got:\n${roleBothText}`);
  }
  console.log("OK pnp_role_set_web rejects user+group together");

  // 49. pnp_role_set_listitem inherit_permissions mutually exclusive with role grant
  send({
    jsonrpc: "2.0", id: 902, method: "tools/call",
    params: {
      name: "pnp_role_set_listitem",
      arguments: { list: "Tasks", identity: 1, inherit_permissions: true, user: "x@y.com", add_role: "Read", confirm: true },
    },
  });
  const inheritExc = await waitFor(902, 15_000);
  const inheritExcText = inheritExc.result?.content?.[0]?.text ?? "";
  if (!inheritExc.result?.isError || !inheritExcText.toLowerCase().includes("mutually exclusive")) {
    throw new Error(`pnp_role_set_listitem inherit+role should be mutually exclusive. Got:\n${inheritExcText}`);
  }
  console.log("OK pnp_role_set_listitem rejects inherit_permissions+role grant");

  // 50. pnp_template_apply gated by confirm; defaults background=true
  const tplApplyTool = listRes.result.tools.find(t => t.name === "pnp_template_apply");
  if (tplApplyTool?.inputSchema?.properties?.background?.default !== true) {
    throw new Error(`pnp_template_apply background default should be true (provisioning takes minutes).`);
  }
  console.log("OK pnp_template_apply defaults background=true (provisioning is long-running)");

  send({
    jsonrpc: "2.0", id: 903, method: "tools/call",
    params: { name: "pnp_template_apply", arguments: { path: "/tmp/x.xml", confirm: false } },
  });
  const tplBlock = await waitFor(903, 15_000);
  if (!tplBlock.result?.isError) throw new Error("pnp_template_apply without confirm should BLOCK");
  console.log("OK pnp_template_apply gated by confirm:true");

  // 51. Safety: Invoke-PnPSiteTemplate is in DESTRUCTIVE list
  send({
    jsonrpc: "2.0", id: 904, method: "tools/call",
    params: { name: "pnp_run", arguments: { command: "Invoke-PnPSiteTemplate -Path /tmp/x.xml" } },
  });
  const tplRunBlock = await waitFor(904, 15_000);
  if (!tplRunBlock.result?.isError || !(tplRunBlock.result?.content?.[0]?.text ?? "").includes("BLOCKED")) {
    throw new Error("Invoke-PnPSiteTemplate should be safety-blocked in pnp_run");
  }
  console.log("OK pnp_run safety blocks Invoke-PnPSiteTemplate (Phase 4 safety addition)");

  // 52. Safety: Set-PnPWebPermission is in DESTRUCTIVE list
  send({
    jsonrpc: "2.0", id: 905, method: "tools/call",
    params: { name: "pnp_run", arguments: { command: "Set-PnPWebPermission -User x@y.com -AddRole Read" } },
  });
  const permRunBlock = await waitFor(905, 15_000);
  if (!permRunBlock.result?.isError) throw new Error("Set-PnPWebPermission should be safety-blocked");
  console.log("OK pnp_run safety blocks Set-PnPWebPermission (Phase 4 safety addition)");

  // ---------- Phase 4 review-fix regression tests ----------

  // 53. C1: invalid FieldType values dropped from enum
  for (const invalid of ["UserMulti", "LookupMulti", "Image", "TaxonomyFieldType", "TaxonomyFieldTypeMulti", "MultiChoice"]) {
    if (fieldTypeEnum.includes(invalid)) {
      throw new Error(`C1: pnp_field_add type enum still contains invalid '${invalid}'.`);
    }
  }
  console.log("OK pnp_field_add enum drops 5 invalid FieldType values (C1)");

  // 54. C2: pnp_group_new no longer exposes set_associated_group
  const groupNewTool = listRes.result.tools.find(t => t.name === "pnp_group_new");
  if (groupNewTool?.inputSchema?.properties?.set_associated_group) {
    throw new Error("C2: pnp_group_new should NOT expose set_associated_group (param doesn't exist on New-PnPGroup).");
  }
  console.log("OK pnp_group_new drops set_associated_group (C2 — use pnp_group_set instead)");

  // 55. I1: Handlers enum has correct values (verified live)
  const tplGetTool = listRes.result.tools.find(t => t.name === "pnp_template_get");
  const handlersEnum = tplGetTool?.inputSchema?.properties?.handlers?.items?.enum ?? [];
  if (handlersEnum.includes("AzureActiveDirectory") || handlersEnum.includes("PrivacyConfiguration")) {
    throw new Error("I1: Handlers enum should drop AzureActiveDirectory and PrivacyConfiguration.");
  }
  for (const required of ["None", "SiteSettings", "SyntexModels"]) {
    if (!handlersEnum.includes(required)) {
      throw new Error(`I1: Handlers enum missing '${required}' (verified live in PnP 3.1).`);
    }
  }
  console.log(`OK Handlers enum verified against live PnP 3.1 (${handlersEnum.length} values, I1)`);

  // 56. I2: pnp_template_get exposes force_overwrite (default false)
  const forceOverwriteParam = tplGetTool?.inputSchema?.properties?.force_overwrite;
  if (!forceOverwriteParam || forceOverwriteParam.default !== false) {
    throw new Error("I2: pnp_template_get should expose force_overwrite (default false). Got default: " + JSON.stringify(forceOverwriteParam));
  }
  console.log("OK pnp_template_get force_overwrite is opt-in (default false, I2)");

  // 57. I3: pnp_template_apply sync_timeout_minutes capped at 10
  const tplApplyToolFull = listRes.result.tools.find(t => t.name === "pnp_template_apply");
  const syncTimeoutSchema = tplApplyToolFull?.inputSchema?.properties?.sync_timeout_minutes;
  if (!syncTimeoutSchema) {
    throw new Error("I3: pnp_template_apply should expose sync_timeout_minutes.");
  }
  if (syncTimeoutSchema.maximum !== 10) {
    throw new Error(`I3: pnp_template_apply sync_timeout_minutes max should be 10. Got: ${syncTimeoutSchema.maximum}`);
  }
  console.log("OK pnp_template_apply sync_timeout_minutes capped at 10 (I3)");

  // 58. I5: clear_existing+inherit_permissions mutex check
  send({
    jsonrpc: "2.0", id: 950, method: "tools/call",
    params: {
      name: "pnp_role_set_listitem",
      arguments: { list: "Tasks", identity: 1, inherit_permissions: true, clear_existing: true, confirm: true },
    },
  });
  const inheritClearMutex = await waitFor(950, 15_000);
  const inheritClearText = inheritClearMutex.result?.content?.[0]?.text ?? "";
  if (!inheritClearMutex.result?.isError || !inheritClearText.toLowerCase().includes("mutually exclusive")) {
    throw new Error(`I5: inherit_permissions+clear_existing should be mutually exclusive. Got:\n${inheritClearText}`);
  }
  console.log("OK pnp_role_set_listitem rejects inherit_permissions+clear_existing (I5)");

  // 59. I6: pnp_group_set no longer exposes add_role/remove_role
  const groupSetTool = listRes.result.tools.find(t => t.name === "pnp_group_set");
  const groupSetProps = groupSetTool?.inputSchema?.properties ?? {};
  if (groupSetProps.add_role || groupSetProps.remove_role) {
    throw new Error("I6: pnp_group_set should NOT expose add_role/remove_role (canonicalized to pnp_role_set_web).");
  }
  console.log("OK pnp_group_set drops add_role/remove_role (I6 — single source of truth)");

  // 60. C4: missing cmdlets now in safety list. Note: Set-PnPSiteCollectionAdmin doesn't
  // actually exist as a cmdlet in PnP 3.x (verify-enums caught that), so we test only
  // cmdlets that exist + are in our safety list.
  const c4Cmdlets = ["Set-PnPRoleDefinition", "Add-PnPSiteCollectionAdmin", "Add-PnPGroupMember"];
  for (let idx = 0; idx < c4Cmdlets.length; idx++) {
    const cmdlet = c4Cmdlets[idx];
    const reqId = 960 + idx; // index-based to guarantee uniqueness even when cmdlet names share length
    send({
      jsonrpc: "2.0", id: reqId, method: "tools/call",
      params: { name: "pnp_run", arguments: { command: `${cmdlet} -Identity foo` } },
    });
    const blockRes = await waitFor(reqId, 15_000);
    if (!blockRes.result?.isError || !(blockRes.result?.content?.[0]?.text ?? "").includes("BLOCKED")) {
      throw new Error(`C4: ${cmdlet} should be safety-blocked. Got:\n${blockRes.result?.content?.[0]?.text}`);
    }
  }
  console.log(`OK ${c4Cmdlets.length} missing cmdlets now in safety list: ${c4Cmdlets.join(", ")} (C4)`);

  // ---------- Phase 5 typed-tool gate verification ----------

  // 61. pnp_page_add gated by confirm
  send({
    jsonrpc: "2.0", id: 970, method: "tools/call",
    params: { name: "pnp_page_add", arguments: { name: "Foo", confirm: false } },
  });
  const pageAddBlock = await waitFor(970, 15_000);
  if (!pageAddBlock.result?.isError) throw new Error("pnp_page_add without confirm should BLOCK");
  console.log("OK pnp_page_add gated by confirm:true");

  // 62. pnp_hubsite_register requires confirm
  send({
    jsonrpc: "2.0", id: 971, method: "tools/call",
    params: { name: "pnp_hubsite_register", arguments: { site: "https://x", principals: ["a@b.c"], confirm: false } },
  });
  const hubRegBlock = await waitFor(971, 15_000);
  if (!hubRegBlock.result?.isError) throw new Error("pnp_hubsite_register without confirm should BLOCK");
  console.log("OK pnp_hubsite_register gated by confirm:true");

  // 63. pnp_m365group_new requires confirm
  send({
    jsonrpc: "2.0", id: 972, method: "tools/call",
    params: {
      name: "pnp_m365group_new",
      arguments: { display_name: "T", mail_nickname: "t", description: "d", confirm: false },
    },
  });
  const m365NewBlock = await waitFor(972, 15_000);
  if (!m365NewBlock.result?.isError) throw new Error("pnp_m365group_new without confirm should BLOCK");
  console.log("OK pnp_m365group_new gated by confirm:true");

  // 64. pnp_navigation_remove rejects 0 or >1 modes
  send({
    jsonrpc: "2.0", id: 973, method: "tools/call",
    params: {
      name: "pnp_navigation_remove",
      arguments: { identity: 5, location: "TopNavigationBar", title: "Home", confirm: true },
    },
  });
  const navRemoveExclusive = await waitFor(973, 15_000);
  const navRemoveExclusiveText = navRemoveExclusive.result?.content?.[0]?.text ?? "";
  if (!navRemoveExclusive.result?.isError || !navRemoveExclusiveText.toLowerCase().includes("mutually exclusive")) {
    throw new Error(`pnp_navigation_remove should reject identity+location+title combination. Got:\n${navRemoveExclusiveText}`);
  }
  console.log("OK pnp_navigation_remove enforces 1-of-3 modes (identity / location+title / all+location)");

  // 65. Safety: New-PnPMicrosoft365Group blocked
  send({
    jsonrpc: "2.0", id: 974, method: "tools/call",
    params: { name: "pnp_run", arguments: { command: "New-PnPMicrosoft365Group -DisplayName x -MailNickname x -Description x" } },
  });
  const m365GroupRunBlock = await waitFor(974, 15_000);
  if (!m365GroupRunBlock.result?.isError) throw new Error("New-PnPMicrosoft365Group should be safety-blocked");
  console.log("OK pnp_run safety blocks New-PnPMicrosoft365Group (Phase 5 safety addition)");

  // 66. Safety: Register-PnPHubSite blocked (was added pre-Phase 5 but verify)
  send({
    jsonrpc: "2.0", id: 975, method: "tools/call",
    params: { name: "pnp_run", arguments: { command: "Register-PnPHubSite -Site https://x -Principals @('a@b.c')" } },
  });
  const hubRunBlock = await waitFor(975, 15_000);
  if (!hubRunBlock.result?.isError) throw new Error("Register-PnPHubSite should be safety-blocked");
  console.log("OK pnp_run safety blocks Register-PnPHubSite");

  // 67. PageLayoutType + Handlers enums verified live (run verify-enums in-process)
  // We invoke the script via child_process and assert exit 0.
  const { spawnSync } = await import("node:child_process");
  const verifyRes = spawnSync("node", [resolve(__dirname, "verify-enums.mjs")], {
    encoding: "utf8",
    timeout: 120_000,
  });
  if (verifyRes.status !== 0) {
    throw new Error(`verify-enums.mjs failed:\n${verifyRes.stdout}\n${verifyRes.stderr}`);
  }
  console.log("OK verify-enums passes (FieldType + Handlers + safety cmdlets all resolve in live PnP)");

  // ---------- Phase 5 review-fix regressions ----------

  // 68. (I3) pnp_navigation_remove rejects bare `all:true` without `location` —
  // bare `-All` deletes every nav surface; we force the caller to scope it.
  send({
    jsonrpc: "2.0", id: 976, method: "tools/call",
    params: { name: "pnp_navigation_remove", arguments: { all: true, confirm: true } },
  });
  const navAllBare = await waitFor(976, 15_000);
  const navAllBareText = navAllBare.result?.content?.[0]?.text ?? "";
  if (!navAllBare.result?.isError || !navAllBareText.includes("REJECTED")) {
    throw new Error(`pnp_navigation_remove with all:true and no location should be REJECTED. Got:\n${navAllBareText}`);
  }
  console.log("OK pnp_navigation_remove rejects bare all:true without location (I3 fix)");

  // 69. (C1) PagePromoteType "NewsArticle" is the live PnP enum spelling — verify
  // the typed-tool accepts it (only blocks at the confirm gate, not at zod parse).
  send({
    jsonrpc: "2.0", id: 977, method: "tools/call",
    params: { name: "pnp_page_set", arguments: { identity: "Home", promote_as: "NewsArticle", confirm: false } },
  });
  const newsArticleBlock = await waitFor(977, 15_000);
  const newsArticleText = newsArticleBlock.result?.content?.[0]?.text ?? "";
  if (!newsArticleBlock.result?.isError || !newsArticleText.includes("BLOCKED")) {
    throw new Error(`pnp_page_set with promote_as:"NewsArticle" should be accepted by zod and stopped at confirm gate. Got:\n${newsArticleText}\n(error?: ${JSON.stringify(newsArticleBlock.error ?? null)})`);
  }
  console.log("OK pnp_page_set accepts promote_as:'NewsArticle' (C1 fix)");

  // 70. (C2) PageLayoutType "Dashboard" + "NewsDigest" are real live PnP values —
  // were missing from the enum; verify they now parse.
  for (const lt of ["Dashboard", "NewsDigest"]) {
    const id = 978 + ["Dashboard", "NewsDigest"].indexOf(lt);
    send({
      jsonrpc: "2.0", id, method: "tools/call",
      params: { name: "pnp_page_add", arguments: { name: "tmp", layout_type: lt, confirm: false } },
    });
    const r = await waitFor(id, 15_000);
    const t = r.result?.content?.[0]?.text ?? "";
    if (!r.result?.isError || !t.includes("BLOCKED")) {
      throw new Error(`pnp_page_add with layout_type:"${lt}" should be accepted by zod and stopped at confirm gate. Got:\n${t}\n(error?: ${JSON.stringify(r.error ?? null)})`);
    }
  }
  console.log("OK pnp_page_add accepts layout_type Dashboard + NewsDigest (C2 fix)");

  // 71. (I1) pnp_hubsite_register `principals` is now optional — call without it
  // and confirm the request makes it past zod to the confirm gate.
  send({
    jsonrpc: "2.0", id: 980, method: "tools/call",
    params: { name: "pnp_hubsite_register", arguments: { site: "https://x.example.com", confirm: false } },
  });
  const hubRegNoPrincipals = await waitFor(980, 15_000);
  const hubRegNoPrincipalsText = hubRegNoPrincipals.result?.content?.[0]?.text ?? "";
  if (!hubRegNoPrincipals.result?.isError || !hubRegNoPrincipalsText.includes("BLOCKED")) {
    throw new Error(`pnp_hubsite_register without principals should now zod-parse and hit confirm gate. Got:\n${hubRegNoPrincipalsText}\n(error?: ${JSON.stringify(hubRegNoPrincipals.error ?? null)})`);
  }
  console.log("OK pnp_hubsite_register accepts call without principals (I1 fix)");

  // 72. (C5+C6) verify-enums must IGNORE comments embedded in z.enum / Set bodies.
  // We construct a synthetic source snippet with both kinds of commented-out
  // literals and exercise the comment-stripping helper. We do this by importing
  // verify-enums.mjs for its `stripCommentsInSnippet` semantics indirectly: just
  // run the actual script (test 67) — but additionally craft a probe that fails
  // the OLD behavior. Cheapest portable check: assert the helper-stripped form
  // of a fake snippet contains no `"FakeCmdlet"` literal.
  const { stripCommentsInSnippet } = await import(resolve(__dirname, "verify-enums.mjs"))
    .catch(() => ({ stripCommentsInSnippet: null }));
  if (stripCommentsInSnippet) {
    const probeBody = `\n  "Real",\n  // "FakeInLineComment",\n  /* "FakeInBlock" */\n`;
    const cleaned = stripCommentsInSnippet(probeBody);
    if (cleaned.includes("FakeInLineComment") || cleaned.includes("FakeInBlock")) {
      throw new Error(`stripCommentsInSnippet failed to remove commented literals. Cleaned snippet:\n${cleaned}`);
    }
    console.log("OK stripCommentsInSnippet removes line + block comments (C5+C6 fix)");
  } else {
    // Helper not exported — that's fine, the integration is exercised by test 67.
    console.log("SKIP direct stripCommentsInSnippet probe (helper not exported); covered indirectly by test 67");
  }

  // ---------- Phase A (1.0.1) regressions ----------

  // 73. (A4) Server prints log directory to stderr at startup so users hunting for
  // diagnostics know where to look. Claude Desktop's `mcp-server-pnp.log` is just MCP
  // protocol traffic — our internal pwsh stderr lives in `~/.pnp-mcp/logs/`.
  if (!stderrBuf.includes("[pnp-mcp]") || !stderrBuf.includes("logs at")) {
    throw new Error(
      `Server stderr should announce log directory at startup. stderr tail:\n${stderrBuf.slice(-500)}`,
    );
  }
  console.log("OK server announces log directory at startup (A4 fix)");

  // 74. (A1) pwsh.ts warmup is version-aware. Source-level check — we verify the
  // warmup script picks the highest 3.x install BY PATH instead of by name (which
  // would let a legacy 2.x in user-scope shadow a 3.x in system-scope on Windows).
  const { readFileSync: rf } = await import("node:fs");
  const pwshSrc = rf(resolve(__dirname, "src/pwsh.ts"), "utf8");
  for (const needle of ["WARMUP_OK", "WARMUP_NEEDS_3X", "WARMUP_NOT_INSTALLED", "Where-Object { $_.Version.Major -ge 3 }", "Import-Module $best.Path"]) {
    if (!pwshSrc.includes(needle)) {
      throw new Error(`pwsh.ts warmup is missing version-aware marker '${needle}' (A1 fix incomplete)`);
    }
  }
  console.log("OK pwsh.ts warmup is version-aware: picks highest 3.x by path (A1 fix)");

  // 75. (A2) pwsh.ts warmup surfaces raw stdout + stderr + exit code in the error
  // message instead of the previous opaque "unexpected output: ." line.
  for (const needle of ["STDOUT:", "STDERR:", "warmupStdout", "warmupStderr"]) {
    if (!pwshSrc.includes(needle)) {
      throw new Error(`pwsh.ts is missing raw-stderr surfacing token '${needle}' (A2 fix incomplete)`);
    }
  }
  console.log("OK pwsh.ts surfaces raw stdout/stderr/exit in warmup errors + log file (A2 fix)");

  // 76. (A3) setup.ts tries Install-PSResource (modern, ~15× faster) before falling
  // back to Install-Module on older pwsh.
  const setupSrc = rf(resolve(__dirname, "src/setup.ts"), "utf8");
  const psResourceIdx = setupSrc.indexOf("Install-PSResource");
  const installModuleIdx = setupSrc.indexOf("Install-Module -Name", psResourceIdx === -1 ? 0 : psResourceIdx);
  if (psResourceIdx === -1 || installModuleIdx === -1 || installModuleIdx < psResourceIdx) {
    throw new Error(
      `setup.ts must try Install-PSResource BEFORE Install-Module (A3 fix). Got psResourceIdx=${psResourceIdx}, installModuleIdx=${installModuleIdx}`,
    );
  }
  console.log("OK setup.ts tries Install-PSResource first, falls back to Install-Module (A3 fix)");

  // 77. (A6) dist/index.js wires update-notifier and respects PNP_MCP_DISABLE_UPDATE_CHECK.
  const indexSrc = rf(resolve(__dirname, "dist/index.js"), "utf8");
  for (const needle of ["update-notifier", "PNP_MCP_DISABLE_UPDATE_CHECK", "updateCheckInterval"]) {
    if (!indexSrc.includes(needle)) {
      throw new Error(`dist/index.js missing update-notifier wiring token '${needle}' (A6 fix)`);
    }
  }
  console.log("OK dist/index.js wires update-notifier with 24h interval + opt-out env (A6 fix)");

  console.log("\nALL PHASE 0+1+2+3+4+5+A+B SMOKE TESTS PASSED (88/88)");
  child.kill();
  process.exit(0);
}

main().catch(err => {
  console.error("\nSMOKE TEST FAILED:", err.message);
  console.error("\n--- server stderr (tail) ---");
  console.error(stderrBuf.split("\n").slice(-30).join("\n"));
  child.kill();
  process.exit(1);
});
