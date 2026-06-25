/**
 * src/whatsapp/bulk-lead.ts
 *
 * Transactional bulk set-lead-status helper.
 * Applies ALL updates in ONE transaction (all-or-nothing).
 * Reuses `applyLeadUpdate` from thread-meta.ts to keep single and bulk
 * write logic in one place (no copy-paste, no drift).
 *
 * Spec §4.1: each identifier must exist (in `messages` OR `whatsapp_thread_meta`)
 * for the given (numberId, workspaceId) before any upsert. If ANY identifier is
 * unknown → abort with an error that surfaces the offending identifiers.
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
 * 1. Validates identifier existence for ALL updates before writing anything.
 * 2. If ANY identifier is unknown → throws BulkLeadIdentifierError (all-or-nothing).
 * 3. Applies each update via the shared `applyLeadUpdate` (same logic as single lead route).
 */
export async function bulkSetLeadStatus(
  pool: Pool,
  p: {
    numberId: number;
    workspaceId: string;
    updatedBy: string;
    updates: BulkLeadUpdate[];
  },
): Promise<BulkLeadResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // ── Step 1: validate that every identifier exists in this (numberId, workspaceId) ──
    // An identifier "exists" if there is at least one messages row OR an existing
    // thread_meta row for this number+workspace.
    const inputIdentifiers = p.updates.map((u) => u.identifier);

    // Use a single query with unnest to check all at once (one round-trip).
    const existenceResult = await client.query<{ identifier: string }>(
      `SELECT DISTINCT identifier FROM (
         SELECT identifier FROM messages
         WHERE whatsapp_number_id = $1
           AND workspace_id = $2
           AND identifier = ANY($3::text[])
         UNION
         SELECT identifier FROM whatsapp_thread_meta
         WHERE whatsapp_number_id = $1
           AND identifier = ANY($3::text[])
       ) existing`,
      [p.numberId, p.workspaceId, inputIdentifiers],
    );

    const existingSet = new Set(existenceResult.rows.map((r) => r.identifier));
    const unknownIdentifiers = inputIdentifiers.filter((id) => !existingSet.has(id));

    if (unknownIdentifiers.length > 0) {
      // Abort before any write — throw outside the catch so ROLLBACK runs in finally.
      await client.query('ROLLBACK');
      throw new BulkLeadIdentifierError(unknownIdentifiers);
    }

    // ── Step 2: apply all updates within the same transaction ────────────────────
    for (const upd of p.updates) {
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

    return {
      updated: p.updates.length,
      identifiers: inputIdentifiers,
    };
  } catch (err) {
    if (!(err instanceof BulkLeadIdentifierError)) {
      // BulkLeadIdentifierError already issued ROLLBACK above; don't double-rollback.
      try { await client.query('ROLLBACK'); } catch { /* ignore rollback failure */ }
    }
    throw err;
  } finally {
    client.release();
  }
}
