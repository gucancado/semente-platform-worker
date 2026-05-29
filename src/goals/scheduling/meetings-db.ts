import { pool } from '../../db.js';

export type MeetingRow = {
  id: number;
  project_id: number;
  agenda_id: number;
  channel: string;
  identifier: string;
  slot_iso: Date;
  slot_human: string;
  lead_email: string | null;
  lead_name: string | null;
  company: string | null;
  contexto: string | null;
  google_event_id: string | null;
  google_meet_link: string | null;
  status: 'scheduled' | 'rescheduled' | 'cancelled' | 'completed' | 'no_show' | 'cancelled_by_organizer';
  cancelled_by: 'lead' | 'agent' | 'organizer' | 'reset' | null;
  rescheduled_to: number | null;
  last_reconciled_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

export type SlotHoldRow = {
  id: number;
  project_id: number;
  agenda_id: number;
  channel: string;
  identifier: string;
  slot_iso: Date;
  google_event_id: string;
  expires_at: Date;
  consumed: boolean;
  created_at: Date;
};

export async function findActiveMeetingForLead(args: {
  project_id: number;
  channel: string;
  identifier: string;
}): Promise<MeetingRow | null> {
  const { rows } = await pool.query<MeetingRow>(
    `SELECT * FROM meetings
      WHERE project_id = $1 AND channel = $2 AND identifier = $3 AND status = 'scheduled'
      ORDER BY created_at DESC LIMIT 1`,
    [args.project_id, args.channel, args.identifier]
  );
  return rows[0] ?? null;
}

export async function findMeetingById(id: number): Promise<MeetingRow | null> {
  const { rows } = await pool.query<MeetingRow>(
    `SELECT * FROM meetings WHERE id = $1 LIMIT 1`,
    [id]
  );
  return rows[0] ?? null;
}

export async function findHold(args: {
  project_id: number;
  channel: string;
  identifier: string;
  slot_iso: string;
}): Promise<SlotHoldRow | null> {
  const { rows } = await pool.query<SlotHoldRow>(
    `SELECT * FROM slot_holds
      WHERE project_id = $1 AND channel = $2 AND identifier = $3 AND slot_iso = $4::timestamptz AND consumed = FALSE
      ORDER BY created_at DESC LIMIT 1`,
    [args.project_id, args.channel, args.identifier, args.slot_iso]
  );
  return rows[0] ?? null;
}

export async function listOtherHoldsForLead(args: {
  project_id: number;
  channel: string;
  identifier: string;
  except_hold_id?: number;
}): Promise<SlotHoldRow[]> {
  const { rows } = await pool.query<SlotHoldRow>(
    `SELECT * FROM slot_holds
      WHERE project_id = $1 AND channel = $2 AND identifier = $3 AND consumed = FALSE
        AND ($4::bigint IS NULL OR id != $4::bigint)`,
    [args.project_id, args.channel, args.identifier, args.except_hold_id ?? null]
  );
  return rows;
}

export async function insertSlotHold(args: {
  project_id: number;
  agenda_id: number;
  channel: string;
  identifier: string;
  slot_iso: string;
  google_event_id: string;
  expires_at: Date;
}): Promise<{ id: number }> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO slot_holds (project_id, agenda_id, channel, identifier, slot_iso, google_event_id, expires_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7::timestamptz)
     RETURNING id`,
    [args.project_id, args.agenda_id, args.channel, args.identifier, args.slot_iso, args.google_event_id, args.expires_at]
  );
  return rows[0]!;
}

export async function markHoldConsumed(hold_id: number): Promise<void> {
  await pool.query(`UPDATE slot_holds SET consumed = TRUE WHERE id = $1`, [hold_id]);
}

export async function deleteHoldRow(hold_id: number): Promise<void> {
  await pool.query(`DELETE FROM slot_holds WHERE id = $1`, [hold_id]);
}

export async function insertMeeting(args: {
  project_id: number;
  agenda_id: number;
  channel: string;
  identifier: string;
  slot_iso: string;
  slot_human: string;
  lead_email?: string | null;
  lead_name?: string | null;
  company?: string | null;
  contexto?: string | null;
  google_event_id: string;
  google_meet_link?: string | null;
}): Promise<{ id: number }> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO meetings (project_id, agenda_id, channel, identifier, slot_iso, slot_human,
       lead_email, lead_name, company, contexto, google_event_id, google_meet_link)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      args.project_id, args.agenda_id, args.channel, args.identifier, args.slot_iso, args.slot_human,
      args.lead_email ?? null, args.lead_name ?? null, args.company ?? null, args.contexto ?? null,
      args.google_event_id, args.google_meet_link ?? null,
    ]
  );
  return rows[0]!;
}

export async function updateMeetingStatus(
  id: number,
  status: MeetingRow['status'],
  cancelled_by?: MeetingRow['cancelled_by']
): Promise<void> {
  await pool.query(
    `UPDATE meetings SET status = $2, cancelled_by = $3, updated_at = NOW() WHERE id = $1`,
    [id, status, cancelled_by ?? null]
  );
}

export async function updateMeetingSlot(
  id: number,
  slot_iso: string,
  slot_human: string
): Promise<void> {
  await pool.query(
    `UPDATE meetings SET slot_iso = $2::timestamptz, slot_human = $3, status = 'rescheduled', updated_at = NOW() WHERE id = $1`,
    [id, slot_iso, slot_human]
  );
}
