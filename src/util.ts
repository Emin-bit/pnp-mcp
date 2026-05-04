/**
 * Safely embed a JS string as a PowerShell single-quoted literal.
 *
 * PowerShell single-quoted strings treat content literally, with one exception:
 * a doubled single quote `''` inside the literal is the escape for a single `'`.
 * So replacing every `'` in the input with `''` produces a safe literal we can
 * substitute into a command template like:
 *
 *     `Connect-PnPOnline -Url ${psQuote(url)} -ClientId ${psQuote(clientId)}`
 *
 * This avoids quote-escaping bugs in user-supplied URLs, secrets, paths, etc.
 */
export function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Build a PowerShell `-ParamName <value>` fragment, omitting if value is undefined. */
export function psParam(name: string, value: string | undefined): string {
  if (value === undefined || value === null || value === "") return "";
  return `-${name} ${psQuote(value)}`;
}

/** Build a PowerShell switch parameter (`-ParamName`) if the boolean is true. */
export function psSwitch(name: string, value: boolean | undefined): string {
  return value ? `-${name}` : "";
}

/**
 * Convert a JS object literal into a PowerShell hashtable expression `@{ key='val'; ... }`.
 * Used for cmdlets that take `-Values <Hashtable>` (Add-PnPListItem, Set-PnPListItem, etc.).
 *
 * Type handling:
 *   • string → single-quoted PS literal (with `'` escaped to `''`)
 *   • number (finite) → bare numeric literal; non-finite (NaN, ±Inf) → $null
 *   • boolean → $true / $false
 *   • null → $null  (semantic: "clear this field")
 *   • undefined → KEY OMITTED  (semantic: "don't touch this field")
 *   • array of primitives → @('a','b','c') / @(1,2,3) / @($true,$false)
 *   • Date object → ISO 8601 string in single quotes
 *
 * Nested objects/hashtables are NOT supported — calling code must flatten before passing,
 * or accept that we throw. We do throw (not silently produce `[object Object]`) so the
 * caller hears about the mistake rather than writing garbage into a SharePoint field.
 *
 * SharePoint people-picker / lookup fields take a UPN/login-name/Id string at this layer;
 * the underlying cmdlet handles the resolution server-side.
 */
export function psHashtable(obj: Record<string, unknown>): string {
  const formatValue = (v: unknown, keyPath: string): string => {
    if (v === null) return "$null";
    if (typeof v === "boolean") return v ? "$true" : "$false";
    if (typeof v === "number") return Number.isFinite(v) ? String(v) : "$null";
    if (v instanceof Date) return psQuote(v.toISOString());
    if (Array.isArray(v)) {
      const items = v.map((x, i) => {
        if (x === null || x === undefined) return "$null";
        if (typeof x === "boolean") return x ? "$true" : "$false";
        if (typeof x === "number") return Number.isFinite(x) ? String(x) : "$null";
        if (typeof x === "object" && !(x instanceof Date)) {
          throw new Error(
            `psHashtable: nested object inside array at key '${keyPath}[${i}]' is not supported. ` +
            `Flatten or pass strings only (e.g. UPN strings for people-picker arrays).`,
          );
        }
        return psQuote(x instanceof Date ? x.toISOString() : String(x));
      });
      return `@(${items.join(",")})`;
    }
    if (typeof v === "object") {
      throw new Error(
        `psHashtable: nested object at key '${keyPath}' is not supported. ` +
        `SharePoint field values are flat — pass primitives (string/number/boolean/Date), ` +
        `arrays of primitives, or null. For people-picker fields use a UPN/login-name string.`,
      );
    }
    return psQuote(String(v));
  };
  // CRITICAL: filter out undefined keys (don't-touch semantics) BEFORE producing entries.
  // Otherwise `{Title: undefined}` becomes `'Title'=$null` which CLEARS the field — not the
  // user's intent. Keep `null` → `$null` (intentional clear).
  const entries = Object.entries(obj)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${psQuote(k)}=${formatValue(v, k)}`);
  return `@{${entries.join(";")}}`;
}

