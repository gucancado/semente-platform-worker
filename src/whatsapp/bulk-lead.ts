/**
 * src/whatsapp/bulk-lead.ts
 *
 * Transactional bulk set-lead-status helper.
 * Applies ALL updates in ONE transaction (all-or-nothing) — strict mode (default).
 * In partial mode, unknown identifiers are partitioned into `skipped` instead of
 * throwing; known identifiers are applied normally.
 * Reuses `applyLeadUpdate` from thread-meta.ts to keep single and bulk
 * write logic in one place (no copy-paste, no drift).
 *
 * Spec §4.1: each identifier must exist (in `messages` OR `whatsapp_thread_meta`)
 * for the given (numberId, workspaceId) before any upsert. If ANY identifier is
 * unknown in strict mode → abort with an error that surfaces the offending identifiers.
 */

import type { Pool } from 'pg';
import { applyLeadUpdate } from './thread-meta.js';

export const BULK_LEAD_MAX = 500;

export interface BulkLeadUpdate {
  identifier: string;
  status: 'lead' | 'not_lead';
  stage?: string | null;
  temperature?: string | null;
  source?: string | null;
  disqualifyReason?: string | null;
  tags?: string[] | null;
  notes?: string | null;
}

export interface BulkLeadResult {
  updated: number;
  identifiers: string[];
  skipped: { identifier: string; reason: string }[];
}

/** Thrown when one or more identifiers don't exist in this (numberId, workspaceId) scope. */
export class BulkLeadIdentifierError extends Error {
  readonly unknownIdentifiers: string[];
  constructor(unknownIdentifiers: string[]) {
    super(`identifiers not found: ${unknownIdentifiers.join(', ')}`);
    this.name = 'BulkLeadIdentifierError';
    this.unknownIdentifiers = unknownIdentifiers;
  }
}

/**
 * Set lead status + qualification for multiple threads in a SINGLE transaction.
 *
 * strict mode (default — all-or-nothing):
 *   1. Validates identifier existence for ALL updates before writing anything.
 *   2. If ANY identifier is unknown → throws BulkLeadIdentifierError.
 *   3. Applies each update via the shared `applyLeadUpdate`.
 *   4. `skipped` is always `[]`.
 *
 * partial mode:
 *   1. Reads existence for all identifiers (outside transaction — read-only).
 *   2. Unknown identifiers are collected into `skipped` with reason `'unknown_identifier'`.
 *   3. Only known identifiers are applied (transaction only opened when there are updates).
 *   4. If all identifiers are unknown → returns immediately without opening a transaction.
 */
export async function bulkSetLeadStatus(
  pool: Pool,
  p: {
    numberId: number;
    workspaceId: string;
    updatedBy: string;
    updates: BulkLeadUpdate[];
    mode?: 'strict' | 'partial';
  },
): Promise<BulkLeadResult> {
  const mode = p.mode ?? 'strict';
  const inputIdentifiers = p.updates.map((u) => u.identifier);

  // Existence read (não precisa de transação — é leitura).
  const existenceResult = await pool.query<{ identifier: string }>(
    `SELECT identifier FROM messages
       WHERE whatsapp_number_id = $1 AND workspace_id = $2 AND identifier = ANY($3::text[])
     UNION
     SELECT identifier FROM whatsapp_thread_meta
       WHERE whatsapp_number_id = $1 AND identifier = ANY($3::text[])`,
    [p.numberId, p.workspaceId, inputIdentifiers],
  );
  const existingSet = new Set(existenceResult.rows.map((r) => r.identifier));
  const unknownIdentifiers = inputIdentifiers.filter((id) => !existingSet.has(id));

  const skipped: { identifier: string; reason: string }[] = [];
  let applyList = p.updates;
  if (unknownIdentifiers.length > 0) {
    if (mode === 'strict') throw new BulkLeadIdentifierError(unknownIdentifiers); // all-or-nothing (inalterado)
    for (const id of unknownIdentifiers) skipped.push({ identifier: id, reason: 'unknown_identifier' });
    applyList = p.updates.filter((u) => existingSet.has(u.identifier));
  }

  // Guard: nada a aplicar → sem abrir transação.
  if (applyList.length === 0) return { updated: 0, identifiers: [], skipped };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const upd of applyList) {
      await applyLeadUpdate(client, {
        numberId: p.numberId,
        identifier: upd.identifier,
        isLead: upd.status === 'lead',
        updatedBy: p.updatedBy,
        stage: upd.stage,
        temperature: upd.temperature,
        source: upd.source,
        disqualifyReason: upd.disqualifyReason,
        tags: upd.tags,
        notes: upd.notes,
      });
    }
    await client.query('COMMIT');
    return { updated: applyList.length, identifiers: applyList.map((u) => u.identifier), skipped };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}
