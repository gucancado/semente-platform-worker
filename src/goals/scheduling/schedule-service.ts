import { pool } from '../../db.js';
import { listAgendas as realListAgendas } from '../../admin/db.js';
import { getConnectionByProjectId as realGetConn } from '../../integrations/google/db.js';
import { ensureFreshAccessToken as realEnsureFresh } from '../../integrations/google/client-factory.js';
import {
  confirmHold as realConfirmHold,
  createEventDirect as realCreateEventDirect,
  patchEvent as realPatchEvent,
  deleteEvent as realDeleteEvent,
} from './calendar-write.js';
import {
  findActiveMeetingForLead as realFindActive,
  findMeetingById as realFindById,
  findHold as realFindHold,
  listOtherHoldsForLead as realListOther,
  markHoldConsumed as realMarkConsumed,
  deleteHoldRow as realDeleteHoldRow,
  insertMeeting as realInsertMeeting,
  updateMeetingStatus as realUpdateStatus,
  updateMeetingSlot as realUpdateSlot,
  type MeetingRow,
} from './meetings-db.js';
import { TokenRevokedError, type GoogleOAuthConnection } from '../../integrations/google/types.js';

export type ScheduleMeetingRequest = {
  project_id: number;
  agent: string;
  channel: string;
  identifier: string;
  slot_iso: string;
  slot_human: string;
  lead_email?: string;
  lead_name?: string;
  company?: string;
  contexto?: string;
};

export type ScheduleMeetingResult =
  | {
      source: 'google';
      meeting_id: number;
      google_event_id: string;
      google_meet_link: string | null;
      already_scheduled?: boolean;
    }
  | {
      source: 'mock';
      fallback_reason: string;
      meeting_id: number;
      simulated: true;
      already_scheduled?: boolean;
    };

export type ScheduleMeetingDeps = {
  listAgendas: typeof realListAgendas;
  getConnectionByProjectId: (id: number) => Promise<GoogleOAuthConnection | null>;
  ensureFreshAccessToken: (conn: GoogleOAuthConnection) => Promise<string>;
  findActiveMeetingForLead: typeof realFindActive;
  findMeetingById: typeof realFindById;
  findHold: typeof realFindHold;
  listOtherHoldsForLead: typeof realListOther;
  markHoldConsumed: typeof realMarkConsumed;
  deleteHoldRow: typeof realDeleteHoldRow;
  insertMeeting: typeof realInsertMeeting;
  updateMeetingStatus: typeof realUpdateStatus;
  updateMeetingSlot: typeof realUpdateSlot;
  confirmHold: typeof realConfirmHold;
  createEventDirect: typeof realCreateEventDirect;
  patchEvent: typeof realPatchEvent;
  deleteEvent: typeof realDeleteEvent;
  insertSimulatedMeeting: (args: { agent: string; channel: string; identifier: string; slot_iso: string; slot_human: string; lead_email?: string | null; lead_name?: string | null; company?: string | null; contexto?: string | null }) => Promise<{ id: number }>;
  findSimulatedActive: (args: { agent: string; channel: string; identifier: string }) => Promise<{ id: number; slot_human: string } | null>;
  now: () => Date;
};

async function defaultInsertSimulated(args: { agent: string; channel: string; identifier: string; slot_iso: string; slot_human: string; lead_email?: string | null; lead_name?: string | null; company?: string | null; contexto?: string | null }): Promise<{ id: number }> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO simulated_meetings (agent, channel, identifier, slot_iso, slot_human, lead_email, lead_name, company, contexto)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7, $8, $9) RETURNING id`,
    [args.agent, args.channel, args.identifier, args.slot_iso, args.slot_human,
     args.lead_email ?? null, args.lead_name ?? null, args.company ?? null, args.contexto ?? null]
  );
  return rows[0]!;
}

async function defaultFindSimulated(args: { agent: string; channel: string; identifier: string }): Promise<{ id: number; slot_human: string } | null> {
  const { rows } = await pool.query<{ id: number; slot_human: string }>(
    `SELECT id, slot_human FROM simulated_meetings
      WHERE agent = $1 AND channel = $2 AND identifier = $3 AND status = 'scheduled'
      ORDER BY created_at DESC LIMIT 1`,
    [args.agent, args.channel, args.identifier]
  );
  return rows[0] ?? null;
}

export const defaultScheduleDeps: ScheduleMeetingDeps = {
  listAgendas: realListAgendas,
  getConnectionByProjectId: realGetConn,
  ensureFreshAccessToken: realEnsureFresh,
  findActiveMeetingForLead: realFindActive,
  findMeetingById: realFindById,
  findHold: realFindHold,
  listOtherHoldsForLead: realListOther,
  markHoldConsumed: realMarkConsumed,
  deleteHoldRow: realDeleteHoldRow,
  insertMeeting: realInsertMeeting,
  updateMeetingStatus: realUpdateStatus,
  updateMeetingSlot: realUpdateSlot,
  confirmHold: realConfirmHold,
  createEventDirect: realCreateEventDirect,
  patchEvent: realPatchEvent,
  deleteEvent: realDeleteEvent,
  insertSimulatedMeeting: defaultInsertSimulated,
  findSimulatedActive: defaultFindSimulated,
  now: () => new Date(),
};

async function fallbackToSimulated(
  req: ScheduleMeetingRequest,
  reason: string,
  deps: ScheduleMeetingDeps
): Promise<ScheduleMeetingResult> {
  const existing = await deps.findSimulatedActive({ agent: req.agent, channel: req.channel, identifier: req.identifier });
  if (existing) {
    return { source: 'mock', fallback_reason: reason, meeting_id: existing.id, simulated: true, already_scheduled: true };
  }
  const { id } = await deps.insertSimulatedMeeting({
    agent: req.agent,
    channel: req.channel,
    identifier: req.identifier,
    slot_iso: req.slot_iso,
    slot_human: req.slot_human,
    lead_email: req.lead_email ?? null,
    lead_name: req.lead_name ?? null,
    company: req.company ?? null,
    contexto: req.contexto ?? null,
  });
  return { source: 'mock', fallback_reason: reason, meeting_id: id, simulated: true };
}

export async function scheduleMeeting(
  req: ScheduleMeetingRequest,
  deps: ScheduleMeetingDeps = defaultScheduleDeps
): Promise<ScheduleMeetingResult> {
  const existing = await deps.findActiveMeetingForLead({ project_id: req.project_id, channel: req.channel, identifier: req.identifier });
  if (existing && (existing.status === 'scheduled' || existing.status === 'rescheduled')) {
    return {
      source: 'google',
      meeting_id: existing.id,
      google_event_id: existing.google_event_id ?? '',
      google_meet_link: existing.google_meet_link,
      already_scheduled: true,
    };
  }

  const agendas = await deps.listAgendas(req.project_id, { activeOnly: true });
  const agenda = agendas[0];
  if (!agenda) return fallbackToSimulated(req, 'no_active_agenda', deps);

  const conn = await deps.getConnectionByProjectId(req.project_id);
  if (!conn) return fallbackToSimulated(req, 'no_oauth', deps);

  try {
    await deps.ensureFreshAccessToken(conn);
  } catch (e) {
    if (e instanceof TokenRevokedError) return fallbackToSimulated(req, 'token_revoked', deps);
    return fallbackToSimulated(req, `token_error:${(e as Error).message.slice(0, 80)}`, deps);
  }

  const hold = await deps.findHold({
    project_id: req.project_id,
    channel: req.channel,
    identifier: req.identifier,
    slot_iso: req.slot_iso,
  });
  console.log(JSON.stringify({
    op: 'scheduleMeeting.findHold',
    slot_iso: req.slot_iso,
    found: !!hold,
    hold_id: hold?.id ?? null,
    google_event_id: hold?.google_event_id ?? null,
  }));

  // person_email do agenda pode ser um Google calendar group id (termina em
  // @group.calendar.google.com) — nesse caso NÃO é um endereço de pessoa e
  // não pode ser usado como attendee no convite. Mantém só endereços reais.
  const isCalendarGroupId = (s: string) => /@group\.calendar\.google\.com$/i.test(s);
  const attendees = [req.lead_email, agenda.person_email]
    .filter((x): x is string => !!x)
    .filter((x) => !isCalendarGroupId(x));

  const confirmFields = {
    attendees,
    summary: `Conversa com ${agenda.display_label}${req.lead_name ? ' - ' + req.lead_name : ''}`,
    description: req.contexto ?? '',
    conferenceRequestId: `meet-${req.project_id}-${req.channel}-${req.identifier}-${deps.now().getTime()}`,
  };

  let google_event_id: string;
  let google_meet_link: string | null;

  if (hold) {
    try {
      const { meetLink } = await deps.confirmHold(conn, agenda.person_email, hold.google_event_id, confirmFields);
      google_event_id = hold.google_event_id;
      google_meet_link = meetLink;
    } catch (e) {
      console.error(JSON.stringify({
        op: 'scheduleMeeting.confirmHold.error',
        hold_id: hold.id,
        google_event_id: hold.google_event_id,
        calendar_id: agenda.person_email,
        attendees,
        error: (e as Error).message,
      }));
      return fallbackToSimulated(req, `confirm_error:${(e as Error).message.slice(0, 80)}`, deps);
    }
    await deps.markHoldConsumed(hold.id);
  } else {
    try {
      const { eventId, meetLink } = await deps.createEventDirect(conn, {
        calendarId: agenda.person_email,
        slotIso: req.slot_iso,
        durationMin: agenda.meeting_duration_min,
        label: confirmFields.summary,
        ...confirmFields,
      });
      google_event_id = eventId;
      google_meet_link = meetLink;
    } catch (e) {
      console.error(JSON.stringify({
        op: 'scheduleMeeting.createEventDirect.error',
        calendar_id: agenda.person_email,
        slot_iso: req.slot_iso,
        attendees,
        error: (e as Error).message,
      }));
      return fallbackToSimulated(req, `create_error:${(e as Error).message.slice(0, 80)}`, deps);
    }
  }

  const otherHolds = await deps.listOtherHoldsForLead({
    project_id: req.project_id, channel: req.channel, identifier: req.identifier,
    except_hold_id: hold?.id,
  });
  for (const o of otherHolds) {
    try {
      await deps.deleteEvent(conn, agenda.person_email, o.google_event_id, { sendUpdates: 'none' });
    } catch {
      // swallow
    }
    await deps.deleteHoldRow(o.id);
  }

  const { id } = await deps.insertMeeting({
    project_id: req.project_id,
    agenda_id: agenda.id,
    channel: req.channel,
    identifier: req.identifier,
    slot_iso: req.slot_iso,
    slot_human: req.slot_human,
    lead_email: req.lead_email ?? null,
    lead_name: req.lead_name ?? null,
    company: req.company ?? null,
    contexto: req.contexto ?? null,
    google_event_id,
    google_meet_link,
  });

  return {
    source: 'google',
    meeting_id: id,
    google_event_id,
    google_meet_link,
  };
}

export type CancelMeetingResult = {
  cancelled: boolean;
  already?: MeetingRow['status'];
};

export async function cancelMeeting(
  meetingId: number,
  by: 'lead' | 'agent' | 'organizer',
  deps: ScheduleMeetingDeps = defaultScheduleDeps
): Promise<CancelMeetingResult> {
  const m = await deps.findMeetingById(meetingId);
  if (!m) return { cancelled: false };
  if (m.status !== 'scheduled') return { cancelled: false, already: m.status };

  if (m.google_event_id) {
    const conn = await deps.getConnectionByProjectId(m.project_id);
    const agendas = await deps.listAgendas(m.project_id, { activeOnly: true });
    const agenda = agendas[0];
    if (conn && agenda) {
      try {
        await deps.deleteEvent(conn, agenda.person_email, m.google_event_id, { sendUpdates: 'all' });
      } catch {
        // swallow
      }
    }
  }
  await deps.updateMeetingStatus(meetingId, 'cancelled', by);
  return { cancelled: true };
}

export type RescheduleMeetingResult = {
  ok: boolean;
  new_meeting_id?: number;
};

export async function rescheduleMeeting(
  meetingId: number,
  newSlotIso: string,
  newSlotHuman: string,
  deps: ScheduleMeetingDeps = defaultScheduleDeps
): Promise<RescheduleMeetingResult> {
  const m = await deps.findMeetingById(meetingId);
  if (!m) return { ok: false };
  if (m.status !== 'scheduled') return { ok: false };
  if (!m.google_event_id) return { ok: false };

  const agendas = await deps.listAgendas(m.project_id, { activeOnly: true });
  const agenda = agendas[0];
  if (!agenda) return { ok: false };

  const conn = await deps.getConnectionByProjectId(m.project_id);
  if (!conn) return { ok: false };

  const endIso = new Date(new Date(newSlotIso).getTime() + agenda.meeting_duration_min * 60 * 1000).toISOString();

  try {
    await deps.patchEvent(conn, agenda.person_email, m.google_event_id, {
      startIso: newSlotIso,
      endIso,
    });
  } catch {
    return { ok: false };
  }

  await deps.updateMeetingSlot(meetingId, newSlotIso, newSlotHuman);
  return { ok: true, new_meeting_id: meetingId };
}
