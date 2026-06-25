/**
 * src/whatsapp/access-log.ts
 *
 * Fire-and-forget audit log helper for /whatsapp/* routes.
 * Records every successful access to PII (reads) and lead writes
 * into `whatsapp_access_log` (LGPD art. 37).
 *
 * Contract:
 *   - NEVER throws; any INSERT error is routed to an injectable error handler
 *     (defaults to stderr via console.error) and swallowed.
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

/** Error sink for the fire-and-forget INSERT. Injectable so tests can assert the
 *  `.catch()` actually ran (proving the regression guard) without polluting stderr. */
export type LogAccessErrorHandler = (err: unknown) => void;

const defaultOnError: LogAccessErrorHandler = (err) => {
  console.error('[access-log] INSERT failed:', err instanceof Error ? err.message : err);
};

export type LogAccessFn = (pool: Pool, p: LogAccessParams, onError?: LogAccessErrorHandler) => void;

export function logAccess(pool: Pool, p: LogAccessParams, onError: LogAccessErrorHandler = defaultOnError): void {
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
      // Fire-and-forget: route the error to the handler so audit failures never affect the request.
      onError(err);
    });
}
