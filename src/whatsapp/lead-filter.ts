// src/whatsapp/lead-filter.ts
//
// Tri-state de triagem (spec v3 §2, §10): is_lead NULL = "indefinido" (não triado),
// TRUE = lead, FALSE = não-lead. MUDANÇA v3: NULL DEIXOU de contar como lead — passou
// a ser um bucket próprio. Mantido em sync com `byLeadStatus` de stats.ts (uma mudança
// aqui EXIGE a mesma mudança lá, e vice-versa).
export type LeadStatus = 'lead' | 'not_lead' | 'indefinido' | 'all';

/** Fragmento SQL do filtro de lead, sobre o alias `tm` (whatsapp_thread_meta). */
export function leadFilterSql(leadStatus: LeadStatus): string {
  if (leadStatus === 'lead') return 'tm.is_lead = TRUE';
  if (leadStatus === 'not_lead') return 'tm.is_lead = FALSE';
  // indefinido = não triado: sem row de thread_meta (LEFT JOIN → NULL) OU is_lead IS NULL.
  if (leadStatus === 'indefinido') return 'tm.is_lead IS NULL';
  return 'TRUE';
}
