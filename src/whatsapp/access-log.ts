/**
 * src/whatsapp/access-log.ts
 *
 * Fire-and-forget audit log helper for /whatsapp/* routes.
 * Records every successful access to PII (reads) and lead writes
 * into `whatsapp_access_log` (LGPD art. 37).
 *
 * Contract:
 *   - NEVER throws; any INSERT error is swallowed and logged to stderr.
 *   - Safe to call with `void logAccess(...)` — does not block the response.
 *   - Uses parameterized SQL only.
 */

import type { Pool } from 'pg';

export interface LogAccessParams {
  actor: string;
  action: string;
  workspaceId?: string | null;
  numberId?: number | null;
  identifier?: string | null;
  meta?: Record<string, unknown> | null;
}

export type LogAccessFn = (pool: Pool, p: LogAccessParams) => void;

export function logAccess(pool: Pool, p: LogAccessParams): void {
  pool
    .query(
      `INSERT INTO whatsapp_access_log (actor, action, workspace_id, number_id, identifier, meta)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        p.actor,
        p.action,
        p.workspaceId ?? null,
        p.numberId ?? null,
        p.identifier ?? null,
        p.meta ? JSON.stringify(p.meta) : null,
      ],
    )
    .catch((err: unknown) => {
      // Fire-and-forget: swallow errors so audit failures never affect the request.
      console.error('[access-log] INSERT failed:', err instanceof Error ? err.message : err);
    });
}
