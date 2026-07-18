// src/whatsapp/lead-qualify.ts
// Lead qualification validation helpers.
// Most are PURE (no DB) — `isValidStage`, `validateLeadQualifyFields` — and are
// importable without a Pool. The single DB-backed validator is
// `validateDisqualifyReason`, which queries the per-workspace reasons reference table.

import type { Pool } from 'pg';

export const VALID_STAGES = ['qualificado', 'desqualificado', 'cliente', 'perdido'] as const;
export type LeadStage = typeof VALID_STAGES[number];

/** Pure: returns true when stage is a valid non-null stage value. */
export function isValidStage(stage: string): stage is LeadStage {
  return (VALID_STAGES as readonly string[]).includes(stage);
}

/**
 * Validates lead qualification inputs before any DB write.
 * Returns an error string, or null if OK.
 * Pure for the stage/coherence checks; disqualify_reason check requires the pool.
 */
export function validateLeadQualifyFields(p: {
  status?: 'lead' | 'not_lead';
  stage?: string | null;
  disqualifyReason?: string | null;
}): string | null {
  if (p.stage != null && !isValidStage(p.stage)) {
    return `stage inválido: deve ser um de ${VALID_STAGES.join('|')} ou null`;
  }
  // DB CHECK constraint enforces this too, but surface it cleanly with a 400 first.
  if (p.stage === 'desqualificado' && p.status === 'lead') {
    return `stage 'desqualificado' é incompatível com status='lead' (is_lead deve ser FALSE)`;
  }
  return null;
}

/**
 * Resolve o `status` efetivo (is_lead). Item 6: `status` passa a ser OPCIONAL — quando
 * omitido, é DERIVADO do stage. Chamar SEMPRE após `validateLeadQualifyFields` (que já
 * valida o whitelist de stage e a incompatibilidade lead+desqualificado).
 *  - status explícito ('lead'|'not_lead') → vence.
 *  - status omitido + stage presente → 'desqualificado' vira 'not_lead'; os demais
 *    (qualificado|cliente|perdido) viram 'lead'.
 *  - status omitido + stage omitido → erro (nada a setar em is_lead).
 *  - status inválido → erro.
 */
export function resolveLeadStatus(
  status: unknown,
  stage: string | null | undefined,
): { status: 'lead' | 'not_lead' } | { error: string } {
  if (status === 'lead' || status === 'not_lead') return { status };
  if (status === undefined || status === null) {
    if (stage == null) return { error: "status é obrigatório quando stage é omitido (lead|not_lead)" };
    return { status: stage === 'desqualificado' ? 'not_lead' : 'lead' };
  }
  return { error: "status must be 'lead' or 'not_lead'" };
}

/**
 * Checks disqualify_reason against the whatsapp_disqualify_reasons table (active only),
 * scoped to the given workspace. A code active in workspace B does NOT validate for
 * workspace A — prevents cross-workspace authorization leaks.
 */
export async function validateDisqualifyReason(pool: Pool, workspaceId: string, code: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM whatsapp_disqualify_reasons WHERE workspace_id = $1 AND code = $2 AND active = TRUE`,
    [workspaceId, code],
  );
  return rows.length > 0;
}
