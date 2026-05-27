/**
 * DTOs compartilhados do goal 'scheduling'. Importados por:
 * - src/admin/routes.ts (CRUD de config) — entrega 1A.
 * - src/goals/scheduling/service.ts (lógica) — entrega 2+.
 * - src/sdr/routes.ts (endpoints /meetings/*) — entrega 4+.
 *
 * NÃO importar googleapis daqui. Tipos puros.
 */

import type { SchedulingAgenda, ProjectGoal } from '../../admin/db.js';

export type SelectionStrategy = 'single' | 'round_robin' | 'by_specialty';

export type SchedulingGoalConfig = {
  selection_strategy: SelectionStrategy;
};

export type Slot = {
  iso: string;       // ISO 8601 com offset (ex: '2026-06-02T10:00:00-03:00')
  human: string;     // 'quarta (02/06) às 10h'
  hold_id?: number;  // setado apenas após createHolds
};

export type SuggestSlotsRequest = {
  project_id: number;
  agenda_id?: number;        // obrigatório se by_specialty
  channel: string;
  identifier: string;
  day?: 'qualquer' | 'seg' | 'ter' | 'qua' | 'qui' | 'sex';
  period?: 'qualquer' | 'manha' | 'tarde';
};

export type SuggestSlotsResponse = {
  agenda_id: number;
  display_label: string;
  slots: Slot[];
};

export type ScheduleMeetingRequest = {
  project_id: number;
  channel: string;
  identifier: string;
  slot_iso: string;
  slot_human: string;
  lead_email?: string;
  lead_name?: string;
  company?: string;
  contexto?: string;
};

// Re-export pra entrega 2+ não importar de admin/db
export type { SchedulingAgenda, ProjectGoal };
