// Lead triage validation helpers.
// Pure validation is DB-free; reason lookup is scoped to the workspace.

import type { Pool } from 'pg';

/** Returns an error string when the remaining triage fields are incoherent. */
export function validateLeadQualifyFields(p: {
  status?: 'lead' | 'not_lead';
  disqualifyReason?: string | null;
}): string | null {
  if (p.disqualifyReason != null && p.status !== 'not_lead') {
    return `disqualifyReason exige status='not_lead' (is_lead deve ser FALSE)`;
  }
  return null;
}

/** Resolve is_lead. Stage no longer exists in the write contract, so status is required. */
export function resolveLeadStatus(
  status: unknown,
): { status: 'lead' | 'not_lead' } | { error: string } {
  if (status === 'lead' || status === 'not_lead') return { status };
  if (status === undefined || status === null) {
    return { error: 'status é obrigatório (lead|not_lead)' };
  }
  return { error: "status must be 'lead' or 'not_lead'" };
}

/** Validate an active disqualification reason within one workspace. */
export async function validateDisqualifyReason(pool: Pool, workspaceId: string, code: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM whatsapp_disqualify_reasons WHERE workspace_id = $1 AND code = $2 AND active = TRUE`,
    [workspaceId, code],
  );
  return rows.length > 0;
}
