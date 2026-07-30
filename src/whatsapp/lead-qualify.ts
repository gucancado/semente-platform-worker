// Lead triage validation helpers.
// Pure validation is DB-free; reason lookup is scoped to the workspace.

import type { Pool } from 'pg';

/** Triagem tri-state: lead=TRUE, not_lead=FALSE, indefinido=NULL (não-triado). */
export type LeadTriageStatus = 'lead' | 'not_lead' | 'indefinido';

/** Returns an error string when the remaining triage fields are incoherent. */
export function validateLeadQualifyFields(p: {
  status?: LeadTriageStatus;
  disqualifyReason?: string | null;
}): string | null {
  if (p.disqualifyReason != null && p.status !== 'not_lead') {
    return `disqualifyReason exige status='not_lead' (is_lead deve ser FALSE)`;
  }
  return null;
}

/** Resolve o status de triagem. Stage saiu do contrato de escrita, então status é obrigatório. */
export function resolveLeadStatus(
  status: unknown,
): { status: LeadTriageStatus } | { error: string } {
  if (status === 'lead' || status === 'not_lead' || status === 'indefinido') return { status };
  if (status === undefined || status === null) {
    return { error: 'status é obrigatório (lead|not_lead|indefinido)' };
  }
  return { error: "status must be 'lead', 'not_lead' or 'indefinido'" };
}

/** Mapeia o status de triagem pro valor tri-state gravado em is_lead. */
export function statusToIsLead(status: LeadTriageStatus): boolean | null {
  if (status === 'lead') return true;
  if (status === 'not_lead') return false;
  return null; // indefinido → não-triado
}

/** Validate an active disqualification reason within one workspace. */
export async function validateDisqualifyReason(pool: Pool, workspaceId: string, code: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT 1 FROM whatsapp_disqualify_reasons WHERE workspace_id = $1 AND code = $2 AND active = TRUE`,
    [workspaceId, code],
  );
  return rows.length > 0;
}
