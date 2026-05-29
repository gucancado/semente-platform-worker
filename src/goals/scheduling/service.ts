/**
 * Orchestrator do goal `scheduling`: decide entre freebusy real e fallback mock.
 *
 * Dependências são injetadas pra facilitar tests sem DATABASE_URL / Google.
 * O wrapper público `suggestSlots(req)` chama `suggestSlotsCore(req, defaultDeps)`.
 */

import { listAgendas as realListAgendas, type SchedulingAgenda } from '../../admin/db.js';
import { getConnectionByProjectId as realGetConn } from '../../integrations/google/db.js';
import { ensureFreshAccessToken as realEnsureFresh } from '../../integrations/google/client-factory.js';
import { freebusy as realFreebusy } from './google-calendar.js';
import type { GoogleOAuthConnection } from '../../integrations/google/types.js';
import { TokenRevokedError } from '../../integrations/google/types.js';
import {
  generateSlotsFromWorkingHours,
  type BusyRange,
  type DayFilter,
  type PeriodFilter,
  type SlotCandidate,
} from './slot-generator.js';
import { generateLegacyMockSlots } from './legacy-mock-slots.js';
import { createHold } from './calendar-write.js';
import { insertSlotHold } from './meetings-db.js';

export type SuggestSlotsRequest = {
  project_id: number;
  channel: string;
  identifier: string;
  dayFilter: DayFilter;
  periodFilter: PeriodFilter;
};

export type SuggestSlotsResult = {
  source: 'google' | 'mock';
  fallback_reason?: string;
  agenda?: { id: number; display_label: string };
  slots: SlotCandidate[];
};

export type SuggestSlotsDeps = {
  listAgendas: typeof realListAgendas;
  getConnectionByProjectId: (project_id: number) => Promise<GoogleOAuthConnection | null>;
  ensureFreshAccessToken: (conn: GoogleOAuthConnection) => Promise<string>;
  freebusy: (
    conn: GoogleOAuthConnection,
    calendarId: string,
    timeMin: Date,
    timeMax: Date
  ) => Promise<BusyRange[]>;
  createHold: typeof createHold;
  insertSlotHold: typeof insertSlotHold;
  now: () => Date;
};

export const HOLD_TTL_MIN = 30;

export const defaultDeps: SuggestSlotsDeps = {
  listAgendas: realListAgendas,
  getConnectionByProjectId: realGetConn,
  ensureFreshAccessToken: realEnsureFresh,
  freebusy: realFreebusy,
  createHold,
  insertSlotHold,
  now: () => new Date(),
};

function fallback(reason: string, req: SuggestSlotsRequest, now: Date): SuggestSlotsResult {
  return {
    source: 'mock',
    fallback_reason: reason,
    slots: generateLegacyMockSlots(req.dayFilter, req.periodFilter, now),
  };
}

export async function suggestSlotsCore(
  req: SuggestSlotsRequest,
  deps: SuggestSlotsDeps = defaultDeps
): Promise<SuggestSlotsResult> {
  const now = deps.now();

  const agendas: SchedulingAgenda[] = await deps.listAgendas(req.project_id, { activeOnly: true });
  const agenda = agendas[0];
  if (!agenda) return fallback('no_active_agenda', req, now);

  const conn = await deps.getConnectionByProjectId(req.project_id);
  if (!conn) return fallback('no_oauth', req, now);

  try {
    await deps.ensureFreshAccessToken(conn);
  } catch (e) {
    if (e instanceof TokenRevokedError) return fallback('token_revoked', req, now);
    return fallback(`token_error:${(e as Error).message.slice(0, 80)}`, req, now);
  }

  const timeMin = new Date(now.getTime() + agenda.min_advance_hours * 60 * 60 * 1000);
  const timeMax = new Date(now.getTime() + agenda.max_advance_business_days * 24 * 60 * 60 * 1000 * 2);

  let busyRanges: BusyRange[];
  try {
    busyRanges = await deps.freebusy(conn, agenda.person_email, timeMin, timeMax);
  } catch (e) {
    return fallback(`freebusy_error:${(e as Error).message.slice(0, 80)}`, req, now);
  }

  const slots = generateSlotsFromWorkingHours({
    workingHours: agenda.working_hours,
    busyRanges,
    meetingDurationMin: agenda.meeting_duration_min,
    minAdvanceHours: agenda.min_advance_hours,
    maxAdvanceBusinessDays: agenda.max_advance_business_days,
    dayFilter: req.dayFilter,
    periodFilter: req.periodFilter,
    now,
    maxResults: 3,
  });

  // Criar holds tentativos pra cada slot.
  const slotsWithHolds: typeof slots = [];
  for (const slot of slots) {
    try {
      const { eventId } = await deps.createHold(conn, {
        calendarId: agenda.person_email,
        slotIso: slot.iso,
        durationMin: agenda.meeting_duration_min,
        label: `[HOLD] ${req.channel}:${req.identifier}`.slice(0, 50),
      });
      const expiresAt = new Date(now.getTime() + HOLD_TTL_MIN * 60 * 1000);
      const { id: holdId } = await deps.insertSlotHold({
        project_id: req.project_id,
        agenda_id: agenda.id,
        channel: req.channel,
        identifier: req.identifier,
        slot_iso: slot.iso,
        google_event_id: eventId,
        expires_at: expiresAt,
      });
      slotsWithHolds.push({ ...slot, hold_id: holdId });
    } catch (e) {
      // TEMP debug: ver porque createHold falha em prod
      console.error('[suggestSlots] createHold falhou pra slot', slot.iso, ':', (e as Error).message);
      continue;
    }
  }

  // Fallback: se TODOS os createHolds falharam (Google quota, network), volta pro mock.
  if (slots.length > 0 && slotsWithHolds.length === 0) {
    return {
      source: 'mock',
      fallback_reason: 'all_holds_failed',
      slots: generateLegacyMockSlots(req.dayFilter, req.periodFilter, now),
    };
  }

  return {
    source: 'google',
    agenda: { id: agenda.id, display_label: agenda.display_label },
    slots: slotsWithHolds,
  };
}

export function suggestSlots(req: SuggestSlotsRequest): Promise<SuggestSlotsResult> {
  return suggestSlotsCore(req, defaultDeps);
}
