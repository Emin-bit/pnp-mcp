#!/usr/bin/env node
import updateNotifier from "update-notifier";
import semver from "semver";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";
import { runSetupCli } from "./setup.js";
import { log } from "./logger.js";

// ---------- update notifier ----------
// Checks the npm registry at most once per 24h (cached in ~/.config/configstore). On the NEXT
// invocation after a new version is found, prints a banner to stderr (which Claude Desktop
// surfaces in mcp.log). Notify-only — never auto-installs. Set PNP_MCP_DISABLE_UPDATE_CHECK=1
// to opt out.
//
// We read package.json relative to dist/index.js: dist/ → ../package.json.
try {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = join(here, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { name: string; version: string };
  if (process.env.PNP_MCP_DISABLE_UPDATE_CHECK !== "1") {
    const notifier = updateNotifier({
      pkg,
      updateCheckInterval: 24 * 60 * 60 * 1000, // once per 24h
      shouldNotifyInNpmScript: true,
    });
    // `notifier.update` is non-null whenever a registry check has cached a result — even when the
    // cached `latest` is now <= the running `current` (stale across a publish). Explicit semver.gt
    // avoids a reversed-arrow banner like "Update available: 1.1.0 → 1.0.1".
    if (notifier.update && semver.gt(notifier.update.latest, notifier.update.current)) {
      const u = notifier.update;
      // Write directly to stderr (Claude Desktop captures this in mcp.log) — update-notifier's
      // default boxen banner is ANSI-decorated and assumes a TTY, so we render plain text instead.
      process.stderr.write(
        `[pnp-mcp] Update available: ${u.current} → ${u.latest} (${u.type}). ` +
        `Run \`npm i -g ${pkg.name}\` then restart Claude Desktop. ` +
        `(Set PNP_MCP_DISABLE_UPDATE_CHECK=1 in env to silence.)\n`,
      );
    }
  }
} catch {
  // Non-fatal — never block startup on the update check.
}

const argv = process.argv.slice(2);
const wantsSetup = argv[0] === "setup" || argv.includes("--setup");

if (wantsSetup) {
  runSetupCli().catch(err => {
    process.stderr.write(`setup failed: ${(err as Error).message}\n`);
    process.exit(1);
  });
} else {
  startServer().catch(err => {
    log("error", "server crashed", { error: String(err), stack: (err as Error)?.stack });
    process.stderr.write(`pnp-mcp fatal error: ${err}\n`);
    process.exit(1);
  });
}
