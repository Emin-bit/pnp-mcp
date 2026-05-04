#!/usr/bin/env node
import { startServer } from "./server.js";
import { runSetupCli } from "./setup.js";
import { log } from "./logger.js";

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
