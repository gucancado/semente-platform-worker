// src/whatsapp/query-coerce.ts
// Tiny, dependency-free query-string coercion helpers. Kept in its own module so
// they are importable in DB-free / config-free unit tests (importing read-routes.ts
// transitively loads ../config.js + the Evolution client and requires full env).

/**
 * Coerce a query-string filter to `undefined` when it is absent or
 * empty/whitespace-only. Prevents `?lead_stage=` from reaching SQL as
 * `tm.lead_stage = ''` (which matches nothing). Returns the trimmed value
 * otherwise.
 */
export function emptyToUndefined(v: unknown): string | undefined {
  if (typeof v !== 'string') return v == null ? undefined : (v as any);
  const t = v.trim();
  return t === '' ? undefined : t;
}
