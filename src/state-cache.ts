// Disk-backed state cache for "what did we connect to last time?"
// Lives at ~/.pnp-mcp/state.json (override via PNP_MCP_STATE_FILE env).
//
// Purpose (B2): drive the smart-default behavior in B4 — when a user calls
// pnp_auth_connect_interactive with no `client_id` or `url`, fall back to whatever
// they used last time. Also remembers the set of clientIds that have ever produced
// a successful connection in this tenant (so B4 can pick a sensible default per URL).
//
// The file is plain JSON with a tiny schema and an atomic write (temp + rename).
// Worst-case corruption fallbacks to an empty store — never throws on read.
//
// Privacy: the state file contains UPN, tenant id, client id, and SPO URL — all
// user-private data that lives ONLY on the user's machine. Nothing here is sent
// anywhere. The home-dir + username redaction in logger.ts ensures that even if
// the user shares a log file, these values are masked.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { z } from "zod";
import { log } from "./logger.js";

const STATE_FILE_DEFAULT = join(homedir(), ".pnp-mcp", "state.json");
const STATE_FILE = process.env.PNP_MCP_STATE_FILE ?? STATE_FILE_DEFAULT;

// Cap on the number of remembered connections. 10 is enough for "I bounce between
// dev/test/prod tenants" without bloating the file or leaking long history into
// auto-suggestions.
const MAX_CONNECTIONS = 10;

// Auth methods used by typed pnp_auth_connect_* tools. Stored so the smart-default
// in B4 can pick the same method that succeeded last time.
const AuthMethod = z.enum([
  "interactive",
  "device_code",
  "sp_secret",
  "sp_cert",
  "managed_identity",
]);
export type AuthMethod = z.infer<typeof AuthMethod>;

const ConnectionRecord = z.object({
  url: z.string().url().describe("SPO site URL"),
  upn: z.string().optional().describe("User principal name (only available for delegated auth)"),
  clientId: z.string().optional().describe("Entra app client id used for the connect"),
  tenantId: z.string().optional().describe("Tenant GUID, populated when known"),
  authMethod: AuthMethod,
  lastUsed: z.string().datetime().describe("ISO 8601 timestamp of the most recent successful connect"),
  successCount: z.number().int().nonnegative().describe("Lifetime successful connect count for this {url, clientId, authMethod} triple"),
});
export type ConnectionRecord = z.infer<typeof ConnectionRecord>;

const StateFile = z.object({
  version: z.literal(1),
  lastConnections: z.array(ConnectionRecord).max(MAX_CONNECTIONS),
});
export type StateFile = z.infer<typeof StateFile>;

const EMPTY_STATE: StateFile = { version: 1, lastConnections: [] };

/**
 * Load the state file. Returns an empty state if the file is missing, unreadable,
 * or fails schema validation (corruption or older incompatible version). Never
 * throws — this is best-effort UX glue, not a source of truth.
 */
export function loadState(): StateFile {
  try {
    if (!existsSync(STATE_FILE)) return { ...EMPTY_STATE, lastConnections: [] };
    const raw = readFileSync(STATE_FILE, "utf8");
    const parsed = StateFile.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      log("warn", "state-cache: state.json failed schema validation; ignoring", {
        issues: parsed.error.issues.slice(0, 5).map(i => `${i.path.join(".")}: ${i.message}`),
      });
      return { ...EMPTY_STATE, lastConnections: [] };
    }
    return parsed.data;
  } catch (err) {
    log("warn", "state-cache: load failed; ignoring", { error: (err as Error).message });
    return { ...EMPTY_STATE, lastConnections: [] };
  }
}

/**
 * Atomic write: serialize to a sibling temp file and rename into place. On POSIX
 * rename is atomic; on Windows it is near-atomic (no torn writes once the rename
 * succeeds). Failure is logged but never thrown — losing an update to the cache
 * must not break a user's auth flow.
 */
function writeStateAtomically(state: StateFile): void {
  try {
    const dir = dirname(STATE_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = STATE_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, STATE_FILE);
  } catch (err) {
    log("warn", "state-cache: write failed; cache not persisted this round", { error: (err as Error).message });
  }
}

/**
 * Record a successful connect. Merges with any existing record that matches
 * (url, clientId, authMethod) — same connection used again increments successCount
 * and refreshes lastUsed. Brand-new combinations are prepended and the list is
 * capped at MAX_CONNECTIONS by trimming the oldest.
 *
 * RACE NOTE: this is read-modify-write with no lock. Two concurrent MCP server
 * instances (e.g. user opens two Claude Desktop chats against the same machine)
 * doing `recordSuccessfulConnect` near-simultaneously will last-write-wins —
 * the second write overwrites the first. The worst case is a lost successCount
 * increment or a lost record for a brand-new connection. Acceptable: this is a
 * UX hint cache, not a source of truth, and the next successful connect will
 * heal the state. No locking is added to keep the module dependency-free.
 */
export function recordSuccessfulConnect(input: {
  url: string;
  upn?: string;
  clientId?: string;
  tenantId?: string;
  authMethod: AuthMethod;
}): void {
  const now = new Date().toISOString();
  const state = loadState();
  const existingIdx = state.lastConnections.findIndex(c =>
    c.url.toLowerCase() === input.url.toLowerCase() &&
    (c.clientId ?? null) === (input.clientId ?? null) &&
    c.authMethod === input.authMethod,
  );
  if (existingIdx >= 0) {
    const prev = state.lastConnections[existingIdx];
    state.lastConnections[existingIdx] = {
      ...prev,
      // Update fields we may now know more about (UPN/tenantId can be empty initially
      // and populated later by B3 session_status enrichment).
      upn: input.upn ?? prev.upn,
      tenantId: input.tenantId ?? prev.tenantId,
      lastUsed: now,
      successCount: prev.successCount + 1,
    };
    // Move to head so most-recent is first.
    const [updated] = state.lastConnections.splice(existingIdx, 1);
    state.lastConnections.unshift(updated);
  } else {
    state.lastConnections.unshift({
      url: input.url,
      upn: input.upn,
      clientId: input.clientId,
      tenantId: input.tenantId,
      authMethod: input.authMethod,
      lastUsed: now,
      successCount: 1,
    });
    if (state.lastConnections.length > MAX_CONNECTIONS) {
      state.lastConnections.length = MAX_CONNECTIONS;
    }
  }
  writeStateAtomically(state);
  log("info", "state-cache: recorded connect", {
    url: input.url,
    authMethod: input.authMethod,
    hasClientId: !!input.clientId,
    hasUpn: !!input.upn,
  });
}

/**
 * Look up the best cached connection for a (possibly-partial) hint. Used by B4
 * smart-default fallback in pnp_auth_connect_*. Returns null if nothing matches.
 *
 * Match precedence (most specific first, falling through on miss):
 *   1. Exact match on {url, authMethod}
 *   2. Exact match on {url} alone (any auth method)
 *   3. Exact match on {clientId} alone
 *   4. Most-recent record for {authMethod} alone — this is the headline B4 case:
 *      "user typed `pnp_auth_connect_interactive` with no args, find the most
 *      recent successful interactive connect and reuse its url + clientId".
 *   5. Most-recent record overall (when called with no hint at all)
 *
 * Race note: this is read-modify-write inside `recordSuccessfulConnect` (see
 * comment there). For lookup, we just `loadState()` once — fully thread-safe
 * for reads.
 */
export function findCachedConnection(hint?: {
  url?: string;
  clientId?: string;
  authMethod?: AuthMethod;
}): ConnectionRecord | null {
  const state = loadState();
  if (!state.lastConnections.length) return null;
  const recent = state.lastConnections; // already ordered by lastUsed desc

  if (hint?.url && hint?.authMethod) {
    const hit = recent.find(c =>
      c.url.toLowerCase() === hint.url!.toLowerCase() &&
      c.authMethod === hint.authMethod,
    );
    if (hit) return hit;
  }
  if (hint?.url) {
    const hit = recent.find(c => c.url.toLowerCase() === hint.url!.toLowerCase());
    if (hit) return hit;
  }
  if (hint?.clientId) {
    const hit = recent.find(c => c.clientId === hint.clientId);
    if (hit) return hit;
  }
  // B4 fix (Phase B agent review): without this branch, calling
  // `pnp_auth_connect_interactive` with NO args returned needs_input even when an
  // interactive connect was cached — exactly the friction the UX report wanted
  // fixed. Match the most-recent record using the same auth method.
  if (hint?.authMethod) {
    const hit = recent.find(c => c.authMethod === hint.authMethod);
    if (hit) return hit;
  }
  if (!hint || (!hint.url && !hint.clientId && !hint.authMethod)) {
    return recent[0];
  }
  return null;
}

/**
 * Distinct list of remembered client ids, ordered by recency. B4 / future B5
 * smart-default uses this to suggest a clientId picker when the user has more
 * than one in play.
 */
export function getRememberedClientIds(): string[] {
  const state = loadState();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of state.lastConnections) {
    if (c.clientId && !seen.has(c.clientId)) {
      seen.add(c.clientId);
      out.push(c.clientId);
    }
  }
  return out;
}

/** Path to the on-disk state file. Used by tests and the session_status diagnostic. */
export function getStateFilePath(): string {
  return STATE_FILE;
}

/**
 * Wipe the entire cache. Intended for the diagnostic CLI / tests. Not exposed as
 * an MCP tool to keep the surface area honest — users who need to clear cache can
 * just delete the file.
 */
export function clearState(): void {
  writeStateAtomically({ ...EMPTY_STATE, lastConnections: [] });
}
