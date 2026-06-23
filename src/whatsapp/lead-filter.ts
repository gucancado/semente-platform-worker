// src/whatsapp/lead-filter.ts
export type LeadStatus = 'lead' | 'not_lead' | 'all';

/** Fragmento SQL do filtro de lead, sobre o alias `tm` (whatsapp_thread_meta). */
export function leadFilterSql(leadStatus: LeadStatus): string {
  if (leadStatus === 'lead') return '(tm.is_lead IS NULL OR tm.is_lead = TRUE)';
  if (leadStatus === 'not_lead') return 'tm.is_lead = FALSE';
  return 'TRUE';
}
